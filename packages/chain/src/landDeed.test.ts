/**
 * Land Deed royalty/freeze unit tests (security review 2026-07-29 F7 — this
 * package had no tests at all, which is how F2/F3/F6 shipped).
 *
 * These cover the DRIFT class specifically, not umi plumbing: every bug found
 * was "two places that must agree quietly stopped agreeing" — the asset royalty
 * vs the collection's, the mint's frozen flag vs MARKETPLACE.tradingEnabled, the
 * creator vs whoever signed. So each test asserts a COUPLING, and would fail if
 * a future change re-derives any of those locally instead of reading the source
 * of truth. All network calls are mocked; nothing here touches an RPC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE } from '@shardkeep/shared';

const COLLECTION = '56RemMwZRxL7xMMV8TbiErZX2YfrnuY65x3t7sTQxKrT';
const ASSET = 'So11111111111111111111111111111111111111112';
const OWNER = 'SysvarC1ock11111111111111111111111111111111';
const BASE = 'https://pub-abc.r2.dev';
/** The key that SIGNS. Deliberately NOT a royalty creator below: F3 was the
 *  royalty silently following `umi.identity` instead of the collection. */
const SIGNER = 'FQQUhH6tCNFxjpt78GCDhjy4HKMSR4KADJMxUDsLwyd1';
const CREATOR_A = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const CREATOR_B = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ALLOWED_PROGRAM = 'BPFLoaderUpgradeab1e11111111111111111111111';

const h = vi.hoisted(() => ({
  calls: {
    create: [] as any[], addPlugin: [] as any[], updatePlugin: [] as any[],
    addCollectionPlugin: [] as any[], updateCollectionPlugin: [] as any[],
    /** update() instructions BUILT (may exceed what confirms). */
    update: [] as any[],
    /** Asset ids per CONFIRMED transaction, in send order. */
    confirmed: [] as string[][],
  },
  state: {
    collection: null as any, rawAsset: null as any,
    seedAssets: new Map<string, string>(),
    seedAssetPool: [
      'So11111111111111111111111111111111111111112',
      'SysvarC1ock11111111111111111111111111111111',
      '56RemMwZRxL7xMMV8TbiErZX2YfrnuY65x3t7sTQxKrT',
    ],
    recoveredMint: null as any,
    createLandsThenThrows: false,
    /** What the chain currently stores: assetId → uri. Absent = burned/missing. */
    chainUris: new Map<string, string>(),
    /** Assets whose account exists but does not deserialize — the real
     *  safeFetchAllAssetV1 throws for the WHOLE chunk containing one. */
    badChunkAssets: new Set<string>(),
    /** Any tx whose items include one of these assets fails to confirm. */
    failTxAssets: new Set<string>(),
    /** update() items per fake transaction — the batching seam. */
    txCapacity: 6,
  },
}));

vi.mock('@metaplex-foundation/umi-bundle-defaults', () => {
  const umi: any = {
    eddsa: {
      createKeypairFromSecretKey: () => ({ publicKey: SIGNER, secretKey: new Uint8Array(64) }),
      createKeypairFromSeed: (seed: Uint8Array) => {
        const key = Buffer.from(seed).toString('hex');
        let publicKey = h.state.seedAssets.get(key);
        if (!publicKey) {
          publicKey = h.state.seedAssetPool[h.state.seedAssets.size] ?? h.state.seedAssetPool.at(-1)!;
          h.state.seedAssets.set(key, publicKey);
        }
        return { publicKey, secretKey: new Uint8Array(64) };
      },
    },
    identity: { publicKey: SIGNER },
  };
  umi.use = (): unknown => umi;
  return { createUmi: () => umi };
});

vi.mock('@metaplex-foundation/umi', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createSignerFromKeypair: (_umi: unknown, kp: { publicKey: string }) => ({ publicKey: kp.publicKey }),
  keypairIdentity: () => ({ install: (): void => {} }),
  // The asset signer is generated LOCALLY before the tx is sent — that is what
  // makes the asset-keyed URI (F2) possible, so the identity callback must see it.
  generateSigner: () => ({ publicKey: ASSET }),
  // Fake builder for updateLandDeedUris: records items, splits by a test-set
  // capacity (the real split is by serialized bytes, which needs a full umi),
  // and confirms/fails per h.state so a failing tx is expressible.
  transactionBuilder: () => {
    const make = (items: any[]): any => ({
      items,
      add: (x: any) => make([...items, x]),
      unsafeSplitByTransactionSize: () => {
        const txs = [];
        for (let i = 0; i < items.length; i += h.state.txCapacity) {
          const chunk = items.slice(i, i + h.state.txCapacity);
          txs.push({
            items: chunk,
            sendAndConfirm: async (): Promise<unknown> => {
              if (chunk.some((it: any) => h.state.failTxAssets.has(it.asset))) {
                throw new Error('tx failed to confirm');
              }
              h.calls.confirmed.push(chunk.map((it: any) => it.asset));
              return {};
            },
          });
        }
        return txs;
      },
    });
    return make([]);
  },
}));

vi.mock('@metaplex-foundation/mpl-core', async (importOriginal) => {
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    mplCore: () => ({ install: (): void => {} }),
    fetchCollection: async () => {
      if (!h.state.collection) throw new Error('no collection fixture');
      return h.state.collection;
    },
    fetchAssetV1: async () => h.state.rawAsset,
    create: (_umi: unknown, args: any) => {
      h.calls.create.push(args);
      return {
        sendAndConfirm: async (): Promise<unknown> => {
          if (h.state.createLandsThenThrows) {
            const plugins = args.plugins as any[];
            h.state.recoveredMint = {
              publicKey: String(args.asset.publicKey),
              owner: args.owner,
              updateAuthority: {
                type: 'Collection',
                address: args.collection.publicKey ?? args.collection,
              },
              name: args.name,
              uri: args.uri,
              permanentFreezeDelegate: plugins.find((p) => p.type === 'PermanentFreezeDelegate'),
              royalties: plugins.find((p) => p.type === 'Royalties'),
            };
            throw new Error('RPC timeout after landed create');
          }
          return {};
        },
      };
    },
    addPlugin: (_umi: unknown, args: unknown) => { h.calls.addPlugin.push(args); return { sendAndConfirm: async () => ({}) }; },
    updatePlugin: (_umi: unknown, args: unknown) => { h.calls.updatePlugin.push(args); return { sendAndConfirm: async () => ({}) }; },
    addCollectionPlugin: (_umi: unknown, args: unknown) => { h.calls.addCollectionPlugin.push(args); return { sendAndConfirm: async () => ({}) }; },
    updateCollectionPlugin: (_umi: unknown, args: unknown) => { h.calls.updateCollectionPlugin.push(args); return { sendAndConfirm: async () => ({}) }; },
    // Chain reads for updateLandDeedUris. Real semantics preserved: the `safe`
    // multi-fetch OMITS missing accounts but THROWS for a whole chunk when any
    // account in it fails to deserialize — that throw is what the per-asset
    // fallback exists for.
    safeFetchAllAssetV1: async (_umi: unknown, pks: unknown[]) => {
      const keys = pks.map(String);
      if (keys.some((k) => h.state.badChunkAssets.has(k))) throw new Error('chunk failed to deserialize');
      return keys.filter((k) => h.state.chainUris.has(k))
        .map((k) => ({ publicKey: k, uri: h.state.chainUris.get(k) }));
    },
    safeFetchAssetV1: async (_umi: unknown, pk: unknown) => {
      const k = String(pk);
      if (h.state.badChunkAssets.has(k)) throw new Error('failed to deserialize');
      if (h.state.recoveredMint?.publicKey === k) return h.state.recoveredMint;
      return h.state.chainUris.has(k) ? { publicKey: k, uri: h.state.chainUris.get(k) } : null;
    },
    update: (_umi: unknown, args: any) => {
      h.calls.update.push(args);
      // The item the fake builder carries — enough to name the asset later.
      return { asset: String(args.asset.publicKey), uri: args.uri };
    },
  };
});

const {
  addDeedUpdateDelegate, fetchDeedUpdateDelegates,
  deriveLandDeedAsset, mintLandDeed, setDeedRoyalties,
  deedJsonUri, deedJsonUriVersioned, deedUriVersion,
  updateLandDeedUris,
} = await import('./landDeed');
// The REAL publicKey (the umi mock spreads the original): mints valid base58
// addresses for batch tests, because updateLandDeedUris feeds ids through it.
const { publicKey: realPk } = await import('@metaplex-foundation/umi');

/** A collection whose royalty policy is deliberately NOT the shape a hardcoded
 *  helper would produce: two creators at 70/30 (not one at 100) and a
 *  ProgramAllowList rule set (not `None`). Anything the code re-derives locally
 *  instead of copying shows up as a diff. */
function collectionFixture(basisPoints: number = MARKETPLACE.deedRoyaltyBps): unknown {
  return {
    publicKey: COLLECTION,
    royalties: {
      basisPoints,
      creators: [
        { address: CREATOR_A, percentage: 70 },
        { address: CREATOR_B, percentage: 30 },
      ],
      ruleSet: { __kind: 'ProgramAllowList', fields: [[ALLOWED_PROGRAM]] },
    },
  };
}

const EXPECTED_ROYALTY_PLUGIN = {
  type: 'Royalties',
  basisPoints: MARKETPLACE.deedRoyaltyBps,
  creators: [
    { address: CREATOR_A, percentage: 70 },
    { address: CREATOR_B, percentage: 30 },
  ],
  ruleSet: { __kind: 'ProgramAllowList', fields: [[ALLOWED_PROGRAM]] },
};

const OPTS = { rpcUrl: 'http://mock', adminSecret: new Uint8Array(64) };

beforeEach(() => {
  h.calls.create.length = 0;
  h.calls.addPlugin.length = 0;
  h.calls.updatePlugin.length = 0;
  h.calls.addCollectionPlugin.length = 0;
  h.calls.updateCollectionPlugin.length = 0;
  h.calls.update.length = 0;
  h.calls.confirmed.length = 0;
  h.state.collection = collectionFixture();
  h.state.rawAsset = { publicKey: ASSET };
  h.state.seedAssets.clear();
  h.state.recoveredMint = null;
  h.state.createLandsThenThrows = false;
  h.state.chainUris.clear();
  h.state.badChunkAssets.clear();
  h.state.failTxAssets.clear();
  h.state.txCapacity = 6;
});

async function mint(): Promise<{ frozen: unknown; royalties: unknown; plugins: any[] }> {
  await mintLandDeed({
    ...OPTS,
    collection: COLLECTION,
    owner: OWNER,
    operationId: 'base-operation-1',
    expectedAsset: ASSET,
    identity: (asset) => ({ name: `Deed ${asset}`, uri: `https://x/${asset}.json` }),
    royaltyBps: MARKETPLACE.deedRoyaltyBps,
  });
  const plugins = h.calls.create[0].plugins as any[];
  return {
    frozen: plugins.find((p) => p.type === 'PermanentFreezeDelegate'),
    royalties: plugins.find((p) => p.type === 'Royalties'),
    plugins,
  };
}

describe('mintLandDeed — fixed-address exactly-once recovery', () => {
  const mintOpts = () => ({
    ...OPTS,
    collection: COLLECTION,
    owner: OWNER,
    operationId: 'stable-base-uuid',
    expectedAsset: deriveLandDeedAsset({ ...OPTS, operationId: 'stable-base-uuid' }),
    identity: (asset: string) => ({ name: `Deed ${asset}`, uri: `https://x/${asset}.json` }),
    royaltyBps: MARKETPLACE.deedRoyaltyBps,
  });

  it('derives a stable address and changes it on operation or admin-key rotation', () => {
    const a = deriveLandDeedAsset({ ...OPTS, operationId: 'base-a' });
    expect(deriveLandDeedAsset({ ...OPTS, operationId: 'base-a' })).toBe(a);
    expect(deriveLandDeedAsset({ ...OPTS, operationId: 'base-b' })).not.toBe(a);
    expect(deriveLandDeedAsset({
      ...OPTS, adminSecret: new Uint8Array(64).fill(7), operationId: 'base-a',
    })).not.toBe(a);
  });

  it('recovers the exact landed account when confirmation throws, with one create total', async () => {
    h.state.createLandsThenThrows = true;
    const first = await mintLandDeed(mintOpts());
    expect(first).toEqual({ asset: ASSET, recovered: true });
    expect(h.calls.create).toHaveLength(1);

    // A later process repeats the same operation. It validates the account at
    // the reserved address and returns it without constructing another create.
    h.state.createLandsThenThrows = false;
    const retry = await mintLandDeed(mintOpts());
    expect(retry).toEqual({ asset: ASSET, recovered: true });
    expect(h.calls.create).toHaveLength(1);
  });

  it('fails before chain I/O when the persisted address and current key disagree', async () => {
    await expect(mintLandDeed({
      ...mintOpts(),
      expectedAsset: OWNER,
    })).rejects.toThrow(/signer mismatch.*refusing to mint/i);
    expect(h.calls.create).toHaveLength(0);
  });

  it('refuses to attach an existing fixed-address account with foreign identity', async () => {
    h.state.recoveredMint = {
      publicKey: ASSET,
      owner: OWNER,
      updateAuthority: { type: 'Address', address: SIGNER },
      name: `Deed ${ASSET}`,
      uri: `https://x/${ASSET}.json`,
      permanentFreezeDelegate: {
        frozen: !MARKETPLACE.tradingEnabled,
        authority: { type: 'UpdateAuthority' },
      },
      royalties: EXPECTED_ROYALTY_PLUGIN,
    };
    await expect(mintLandDeed(mintOpts())).rejects.toThrow(/unexpected update authority/);
    expect(h.calls.create).toHaveLength(0);
  });
});

describe('mintLandDeed — royalty is the COLLECTION\'s, verbatim', () => {
  it('mirrors the collection plugin exactly, including creators and ruleSet', async () => {
    // WHY it matters: in mpl-core an asset-level plugin REPLACES the collection's
    // for that asset. The moment these differ, the collection becomes decorative
    // and a future royalty change there is a no-op on every deed ever minted.
    const { royalties } = await mint();
    expect(royalties).toEqual(EXPECTED_ROYALTY_PLUGIN);
  });

  it('does NOT derive the creator from whoever signed the mint', async () => {
    // F3: the old code fell back to `umi.identity`, so minting from a second
    // admin key would have quietly redirected the royalty to that key.
    const { royalties } = await mint();
    const addresses = (royalties as { creators: Array<{ address: string }> }).creators.map((c) => c.address);
    expect(addresses).not.toContain(SIGNER);
  });

  it('refuses to mint when the collection and the constant disagree on bps', async () => {
    // A mismatch means the fleet is about to split into two royalty rates —
    // unfixable for any deed already sold to a stranger. Fail before writing.
    h.state.collection = collectionFixture(MARKETPLACE.deedRoyaltyBps + 100);
    await expect(mint()).rejects.toThrow(/drift/i);
    expect(h.calls.create).toHaveLength(0);
  });

  it('refuses to invent a royalty the collection does not carry', async () => {
    h.state.collection = { publicKey: COLLECTION };
    await expect(mint()).rejects.toThrow(/NO Royalties plugin/);
    expect(h.calls.create).toHaveLength(0);
  });
});

describe('mintLandDeed — freeze follows MARKETPLACE.tradingEnabled', () => {
  it('mints frozen iff trading is OFF, and always keeps the admin kill switch', async () => {
    // F6 was a LIVE user-facing bug: `frozen: true` was hardcoded, so new players
    // minted soulbound deeds while the market screen advertised "TRADING LIVE".
    // Binding the two here is the whole point — the constants test can see the
    // flag but not the mint path, so only this test can catch them diverging.
    const { frozen } = await mint();
    expect(frozen).toEqual({
      type: 'PermanentFreezeDelegate',
      frozen: !MARKETPLACE.tradingEnabled,
      // The plugin is retained even when thawed: it is the fleet-wide kill
      // switch, and it cannot be added back after the fact.
      authority: { type: 'UpdateAuthority' },
    });
  });

  it('trading is currently ON, so new deeds must arrive transferable', async () => {
    // Pinned to today's decision (owner 2026-07-29 thaw). If someone flips
    // tradingEnabled back to false, this fails loudly — which is correct: the 4
    // already-thawed devnet deeds would need a re-freeze sweep too, and a silent
    // half-frozen fleet is exactly the state the review flagged.
    expect(MARKETPLACE.tradingEnabled).toBe(true);
    const { frozen } = await mint();
    expect((frozen as { frozen: boolean }).frozen).toBe(false);
  });
});

describe('royalty DESTINATION is asserted against the collection, never substituted', () => {
  // Owner 2026-07-29: the 5% destination must be settable from .env before
  // mainnet. The danger in making an address configurable is that the env
  // becomes a SECOND source of truth — mint deeds paying the new address while
  // the collection still names the old one, and the fleet splits across two
  // payees with no way to tell which deed pays whom. So the config is an
  // ASSERTION: the mint aborts unless the collection has actually been
  // repointed (deed:royalty:creator), and the plugin stamped is still the
  // collection's own.
  async function mintExpecting(expectedCreator: string): Promise<void> {
    await mintLandDeed({
      ...OPTS,
      collection: COLLECTION,
      owner: OWNER,
      operationId: 'base-operation-1',
      expectedAsset: ASSET,
      identity: (asset) => ({ name: `Deed ${asset}`, uri: `https://x/${asset}.json` }),
      royaltyBps: MARKETPLACE.deedRoyaltyBps,
      expectedCreator,
    });
  }

  it('refuses to mint when the collection has not been repointed yet', async () => {
    // The fixture pays CREATOR_A/CREATOR_B; config names a different treasury.
    await expect(mintExpecting(SIGNER)).rejects.toThrow(/DESTINATION drift/);
    expect(h.calls.create).toHaveLength(0);
  });

  it('refuses a PARTIAL match — the configured payee plus a leftover creator', async () => {
    // A 70/30 split that happens to include the treasury is still 30% going
    // somewhere the config does not name. "Mostly right" is not right.
    await expect(mintExpecting(CREATOR_A)).rejects.toThrow(/DESTINATION drift/);
    expect(h.calls.create).toHaveLength(0);
  });

  it('mints once the collection pays exactly the configured address', async () => {
    h.state.collection = {
      publicKey: COLLECTION,
      royalties: {
        basisPoints: MARKETPLACE.deedRoyaltyBps,
        creators: [{ address: CREATOR_B, percentage: 100 }],
        ruleSet: { __kind: 'None' },
      },
    };
    await mintExpecting(CREATOR_B);
    const plugins = h.calls.create[0].plugins as any[];
    // Still COPIED from the collection, not rebuilt from the env value.
    expect(plugins.find((p) => p.type === 'Royalties')).toEqual({
      type: 'Royalties',
      basisPoints: MARKETPLACE.deedRoyaltyBps,
      creators: [{ address: CREATOR_B, percentage: 100 }],
      ruleSet: { __kind: 'None' },
    });
  });

  it('no expectedCreator ⇒ no destination check (devnet default is unchanged)', async () => {
    // Leaving DEED_ROYALTY_CREATOR empty must keep working exactly as before,
    // or every existing devnet deployment breaks on upgrade.
    const { royalties } = await mint();
    expect(royalties).toEqual(EXPECTED_ROYALTY_PLUGIN);
  });

  it('the backfill applies the same assertion, so a sweep cannot half-move the payee', async () => {
    await expect(setDeedRoyalties({
      ...OPTS, collection: COLLECTION, asset: ASSET,
      royaltyBps: MARKETPLACE.deedRoyaltyBps, expectedCreator: SIGNER,
    })).rejects.toThrow(/DESTINATION drift/);
    expect(h.calls.addPlugin).toHaveLength(0);
    expect(h.calls.updatePlugin).toHaveLength(0);
  });
});

describe('setDeedRoyalties — add vs update is decided by the RAW asset', () => {
  it('updates when the asset already carries its own Royalties plugin', async () => {
    h.state.rawAsset = { publicKey: ASSET, royalties: { basisPoints: 500, creators: [], ruleSet: { __kind: 'None' } } };
    await expect(setDeedRoyalties({
      ...OPTS, collection: COLLECTION, asset: ASSET, royaltyBps: MARKETPLACE.deedRoyaltyBps,
    })).resolves.toBe('updated');
    expect(h.calls.addPlugin).toHaveLength(0);
    expect(h.calls.updatePlugin[0].plugin).toEqual(EXPECTED_ROYALTY_PLUGIN);
  });

  it('adds when the asset only INHERITED the collection royalty', async () => {
    // The raw (unmerged) asset view is what distinguishes the two. Reading the
    // merged view instead makes an inherited royalty look asset-level, and
    // updatePlugin then fails on chain with "plugin not found" (0x4).
    h.state.rawAsset = { publicKey: ASSET };
    await expect(setDeedRoyalties({
      ...OPTS, collection: COLLECTION, asset: ASSET, royaltyBps: MARKETPLACE.deedRoyaltyBps,
    })).resolves.toBe('added');
    expect(h.calls.updatePlugin).toHaveLength(0);
    expect(h.calls.addPlugin[0].plugin).toEqual(EXPECTED_ROYALTY_PLUGIN);
  });

  it('refuses to backfill a rate the collection disagrees with', async () => {
    h.state.collection = collectionFixture(250);
    await expect(setDeedRoyalties({
      ...OPTS, collection: COLLECTION, asset: ASSET, royaltyBps: MARKETPLACE.deedRoyaltyBps,
    })).rejects.toThrow(/drift/i);
    expect(h.calls.addPlugin).toHaveLength(0);
    expect(h.calls.updatePlugin).toHaveLength(0);
  });
});

/**
 * Dynamic-deed URI versioning (owner 2026-08-03).
 *
 * Context, because the reason is not obvious from the code: the deed's traits
 * and picture are rebuilt from live server state continuously, but wallets read
 * a DAS indexer, and DAS re-fetches only when something ON CHAIN changes. With
 * a fixed URI it shows the traits it cached at mint, forever — observed on
 * devnet as R2 serving Keep 17 / 111 buildings while every wallet showed
 * Keep 15 / 85. The version in the stored URI is the entire mechanism, so these
 * pin the two properties the on-chain updater depends on.
 */
describe('deed URI versioning', () => {
  it('is stable for the same content — this is what makes the updater idempotent', () => {
    // The updater skips assets whose chain URI already equals the desired one.
    // If the same content produced a different URI twice, EVERY deed would look
    // dirty on every sweep and we would pay a transaction per deed per minute.
    const a = deedJsonUriVersioned(BASE, ASSET, 'a1b2c3d4');
    const b = deedJsonUriVersioned(BASE, ASSET, 'a1b2c3d4');
    expect(a).toBe(b);
  });

  it('changes when the content changes, and only then', () => {
    const before = deedJsonUriVersioned(BASE, ASSET, 'a1b2c3d4');
    const after = deedJsonUriVersioned(BASE, ASSET, '99887766');
    expect(after).not.toBe(before);
    expect(deedUriVersion(after)).toBe('99887766');
  });

  it('is FIXED WIDTH, so the on-chain account grows exactly once', () => {
    // A Core asset stores its URI on chain, so a longer URI costs rent. Equal
    // lengths mean the 11-byte growth is paid on the first versioned write and
    // never again; a variable-width version would charge rent on the way up and
    // strand it on the way down.
    const lengths = new Set(
      ['0', 'ff', 'deadbeef', '00000000', 'a1b2c3d4e5f6'].map(
        (v) => deedJsonUriVersioned(BASE, ASSET, v).length,
      ),
    );
    expect(lengths.size, `expected one length, got ${[...lengths].join('/')}`).toBe(1);
  });

  it('keeps the document address intact — the version is only a cache-buster', () => {
    // The server route matches on the path; a version that changed the path
    // would 404 and every wallet would show a broken deed.
    const versioned = deedJsonUriVersioned(BASE, ASSET, 'a1b2c3d4');
    expect(versioned.split('?')[0]).toBe(deedJsonUri(BASE, ASSET));
  });

  it('reads back nothing from a pre-migration unversioned URI', () => {
    // Deeds minted before this carry a bare URI. Returning null (not a fake
    // version) is what makes them compare unequal and get updated once.
    expect(deedUriVersion(deedJsonUri(BASE, ASSET))).toBeNull();
    expect(deedUriVersion('https://x/deed/asset/y.json?other=1')).toBeNull();
  });
});

/**
 * updateLandDeedUris against a mocked chain (security review 2026-08-03
 * follow-up #8). These pin the SPENDING behaviour of the unattended sweep:
 * an already-current deed must cost nothing, one undeserializable account must
 * not stop the rest, and one failed transaction must neither abort the pass
 * nor go unreported. All chain reads/writes are mocked; nothing here can sign.
 */

// Valid, distinct base58 addresses — the batch path feeds ids through umi's
// real publicKey(), so string fixtures like 'asset-1' would throw before the
// code under test ran.
const A = Array.from({ length: 10 }, (_, i) => String(realPk(new Uint8Array(32).fill(i + 1))));
const BATCH_OPTS = { rpcUrl: 'http://mock', adminSecret: new Uint8Array(64), collection: COLLECTION };
const vUri = (asset: string, v: string): string => deedJsonUriVersioned(BASE, asset, v);

describe('updateLandDeedUris — mocked chain (review follow-up #8)', () => {
  it('already-current deeds build ZERO instructions — the steady state is free', async () => {
    // Every sweep visits every deed; if "no change" cost even one instruction,
    // the fleet would pay per deed per lap forever.
    h.state.chainUris.set(A[0]!, vUri(A[0]!, 'aaaaaaaa'));
    const r = await updateLandDeedUris({
      ...BATCH_OPTS, updates: [{ asset: A[0]!, uri: vUri(A[0]!, 'aaaaaaaa') }],
    });
    expect(r).toEqual({ updated: 0, txs: 0, alreadyCurrent: 1, missing: [], failed: [] });
    expect(h.calls.update, 'no instruction may be built').toHaveLength(0);
    expect(h.calls.confirmed, 'nothing may be sent').toHaveLength(0);
  });

  it('one undeserializable account falls back per-asset; the good ones still update', async () => {
    // The multi-fetch throws for the WHOLE chunk when one account in it is not
    // a Core asset (a corrupt DB row). If that aborted the pass, one bad row
    // would permanently freeze every deed behind it — the silent-freeze failure
    // this feature exists to fix.
    h.state.badChunkAssets.add(A[1]!);
    h.state.chainUris.set(A[2]!, vUri(A[2]!, 'old00002'));
    h.state.chainUris.set(A[3]!, vUri(A[3]!, 'old00003'));
    const r = await updateLandDeedUris({
      ...BATCH_OPTS,
      updates: [
        { asset: A[1]!, uri: vUri(A[1]!, 'new00001') },
        { asset: A[2]!, uri: vUri(A[2]!, 'new00002') },
        { asset: A[3]!, uri: vUri(A[3]!, 'new00003') },
      ],
    });
    expect(r.updated).toBe(2);
    expect(r.missing, 'the bad row is reported, not retried into').toEqual([A[1]!]);
    expect(r.failed).toEqual([]);
    expect(h.calls.confirmed.flat().sort()).toEqual([A[2]!, A[3]!].sort());
  });

  it('a burned deed is reported missing, never built into a transaction', async () => {
    // The safe multi-fetch simply omits it; silence here would hide a DB row
    // pointing at nothing and the sweep would re-attempt it every lap.
    const r = await updateLandDeedUris({
      ...BATCH_OPTS, updates: [{ asset: A[4]!, uri: vUri(A[4]!, 'aaaaaaaa') }],
    });
    expect(r.missing).toEqual([A[4]!]);
    expect(h.calls.update).toHaveLength(0);
  });

  it('a failing tx does not abort the rest, and names its assets in `failed`', async () => {
    // Partial progress is real: each tx confirms independently, and the failed
    // assets must be NAMED so a permanently-bad one is visible rather than
    // silently re-attempted forever.
    h.state.txCapacity = 2;
    for (const a of [A[5]!, A[6]!, A[7]!, A[8]!, A[9]!]) {
      h.state.chainUris.set(a, vUri(a, 'old' + a.slice(0, 5)));
    }
    h.state.failTxAssets.add(A[6]!); // rides in the first tx of [5,6],[7,8],[9]
    const r = await updateLandDeedUris({
      ...BATCH_OPTS,
      updates: [A[5]!, A[6]!, A[7]!, A[8]!, A[9]!].map((a) => ({ asset: a, uri: vUri(a, 'aaaaaaaa') })),
    });
    // The failed tx carried BOTH its assets; the other two txs landed.
    expect(r.failed.sort()).toEqual([A[5]!, A[6]!].sort());
    expect(r.updated).toBe(3);
    expect(r.txs, 'only CONFIRMED txs are counted').toBe(2);
    expect(h.calls.confirmed.flat().sort()).toEqual([A[7]!, A[8]!, A[9]!].sort());
  });
});

describe('updateLandDeedUris — bulk re-point circuit breaker (review follow-up #6)', () => {
  // The sweep's job is moving ?v=. If the desired ORIGIN/PATH disagrees with
  // the chain for many assets at once, the public base moved or the config is
  // wrong — and an unattended loop rewriting the fleet to a host nobody serves
  // would break every wallet's deed, not just stale it.
  const OLD_HOST = 'https://old-host.example';

  function wantRepoints(n: number): { asset: string; uri: string }[] {
    return A.slice(0, n).map((a) => {
      h.state.chainUris.set(a, `${OLD_HOST}/deed/asset/${a}.json?v=aaaaaaaa`);
      return { asset: a, uri: vUri(a, 'aaaaaaaa') };
    });
  }

  it('refuses the WHOLE pass when more than a handful of addresses would move', async () => {
    const updates = wantRepoints(6);
    await expect(updateLandDeedUris({ ...BATCH_OPTS, updates }))
      .rejects.toThrow(/DEED_CHAIN_REURI/);
    expect(h.calls.confirmed, 'nothing may reach the chain').toHaveLength(0);
  });

  it('lets a handful through — the deed:reuri / claim-migration trickle is legitimate', async () => {
    const updates = wantRepoints(5);
    const r = await updateLandDeedUris({ ...BATCH_OPTS, updates });
    expect(r.updated).toBe(5);
    expect(r.txs).toBe(1);
  });

  it('?v=-only changes NEVER trip it, however many — that is the normal sweep', async () => {
    // Mutation guard for the address comparison: if the breaker compared full
    // URIs instead of origin+path, every content refresh would count as a
    // re-point and the sweep would freeze itself on any busy day.
    const updates = A.slice(0, 8).map((a) => {
      h.state.chainUris.set(a, vUri(a, 'aaaaaaaa'));
      return { asset: a, uri: vUri(a, 'bbbbbbbb') };
    });
    const r = await updateLandDeedUris({ ...BATCH_OPTS, updates });
    expect(r.updated).toBe(8);
  });

  it('allowRepoint:true (the attended path) performs the bulk move', async () => {
    const updates = wantRepoints(7);
    const r = await updateLandDeedUris({ ...BATCH_OPTS, updates, allowRepoint: true });
    expect(r.updated).toBe(7);
    expect(h.calls.confirmed.flat()).toHaveLength(7);
  });
});

/**
 * Deed-ops UpdateDelegate (dynamic deeds, owner GO 2026-08-03). The unattended
 * URI sweep should sign with a key that can ONLY update deeds, not the admin
 * key that mints KEEP and moves the treasury. These pin the collection-plugin
 * write path: add-vs-update decided by what the account carries, and the
 * delegate list REPLACED — the whole point is that rotating the ops key evicts
 * the old one. All chain calls are mocked; nothing here can sign or send.
 */
describe('addDeedUpdateDelegate — collection-level ops delegation', () => {
  // Reuse known-valid base58 fixtures as generic addresses.
  const OPS_KEY = CREATOR_B;
  const OLD_OPS_KEY = CREATOR_A;
  const delegateOpts = { ...OPTS, collection: COLLECTION, delegate: OPS_KEY };

  it('ADDS the plugin when the collection has none, admin-managed', async () => {
    // The default fixture carries no UpdateDelegate. updateCollectionPlugin on
    // a missing plugin fails on chain, so presence must decide the verb — the
    // same class of bug as the fetchAssetV1 gotcha in setDeedRoyalties.
    const r = await addDeedUpdateDelegate(delegateOpts);
    expect(r).toEqual({ action: 'added', before: [], after: [OPS_KEY] });
    expect(h.calls.updateCollectionPlugin).toHaveLength(0);
    expect(h.calls.addCollectionPlugin[0].plugin).toEqual({
      type: 'UpdateDelegate',
      additionalDelegates: [OPS_KEY],
      // The GRANT is additionalDelegates; the plugin itself stays admin-managed.
      // If the ops key held the plugin authority it could rewrite its own grant,
      // and rotation-after-compromise would be impossible.
      authority: { type: 'UpdateAuthority' },
    });
  });

  it('UPDATES when present, and the list is REPLACED — rotation evicts the old key', async () => {
    // Appending would keep a stolen key authorized forever; the env names ONE
    // ops key, so the chain must read exactly that one after the write.
    h.state.collection = {
      ...(collectionFixture() as object),
      updateDelegate: {
        authority: { type: 'UpdateAuthority' },
        additionalDelegates: [OLD_OPS_KEY, SIGNER],
      },
    };
    const r = await addDeedUpdateDelegate(delegateOpts);
    expect(r).toEqual({ action: 'updated', before: [OLD_OPS_KEY, SIGNER], after: [OPS_KEY] });
    expect(h.calls.addCollectionPlugin).toHaveLength(0);
    expect(h.calls.updateCollectionPlugin[0].plugin).toEqual({
      type: 'UpdateDelegate',
      additionalDelegates: [OPS_KEY], // exactly the new key — no old ones ride along
    });
  });

  it('sends NOTHING when the delegate is already exactly current', async () => {
    // The attended script is safe to re-run; an idempotent no-op must not pay
    // a transaction fee or touch the chain at all.
    h.state.collection = {
      ...(collectionFixture() as object),
      updateDelegate: { authority: { type: 'UpdateAuthority' }, additionalDelegates: [OPS_KEY] },
    };
    const r = await addDeedUpdateDelegate(delegateOpts);
    expect(r.action).toBe('unchanged');
    expect(h.calls.addCollectionPlugin).toHaveLength(0);
    expect(h.calls.updateCollectionPlugin).toHaveLength(0);
  });

  it('fetchDeedUpdateDelegates distinguishes "no plugin" from "empty list"', async () => {
    // null vs [] is what lets the CLI preflight print whether the write will
    // be an add or an update — the two fail differently on chain.
    expect(await fetchDeedUpdateDelegates({ ...OPTS, collection: COLLECTION })).toBeNull();
    h.state.collection = {
      ...(collectionFixture() as object),
      updateDelegate: { authority: { type: 'UpdateAuthority' }, additionalDelegates: [OPS_KEY] },
    };
    expect(await fetchDeedUpdateDelegates({ ...OPTS, collection: COLLECTION })).toEqual([OPS_KEY]);
  });
});
