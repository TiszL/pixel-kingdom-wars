/**
 * Land Deeds — Metaplex Core NFTs (Phase 6, ONRAMP-WALLETS-PLAN §6 + the
 * ITEMS-LOOTBOX-MARKETPLACE-PLAN §8/§9 decoupling rules).
 *
 * Design invariants (do not weaken):
 *  - The deed conveys the complete playable base, including its deed-local
 *    SHARDS economy, structures, armies, progression and history. Wallet-level
 *    KEEP, SOL and account identity never transfer with it (D-035).
 *  - Attackability is a pure function of SERVER state — gameplay never reads
 *    deed/DAS state, so no on-chain action on a deed can grant protection.
 *  - Every deed carries a PermanentFreezeDelegate held by the ADMIN, so trading
 *    can be killed fleet-wide if it ever has to be. Whether a NEW mint arrives
 *    frozen is driven by `MARKETPLACE.tradingEnabled` and nothing else — the
 *    flag and the chain must never disagree (security review 2026-07-29 F6).
 *  - Royalties (5%) live on the COLLECTION and are mirrored verbatim onto every
 *    asset. They are MARKETPLACE-HONOURED, not enforced on chain: the rule set
 *    is `None`, which makes mpl-core ABSTAIN on transfer — Tensor / Magic Eden
 *    pay the creator because they choose to, and a direct wallet-to-wallet
 *    transfer pays nothing. Enforcement would require a ProgramAllowList rule
 *    set, which blocks trading anywhere off the list.
 *  - The royalty DESTINATION is CONFIGURED, never inferred from the signer
 *    (owner 2026-07-29: "5% royalty I want to be flexible ... before mainnet
 *    deployment I will add final address there"). Callers pass it explicitly:
 *    `createDeedCollection` takes `royaltyCreator`, and the mint/backfill paths
 *    take it as `expectedCreator` — an ASSERTION against the collection, not a
 *    second source of truth, so the collection stays the one place the address
 *    is written and `setDeedCollectionRoyaltyCreator` is the only way to move
 *    it. A solo builder moves the treasury by editing one env var and running
 *    one script; no multisig ceremony is involved or implied.
 *
 * Chosen standard: Metaplex Core (royalty plugin + on-chain attributes;
 * ~0.003 SOL/mint) per the plan's compressed-NFT-versus-Core analysis.
 */
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import {
  addCollectionPlugin, addPlugin, create, createCollection, fetchAsset, fetchAssetV1, fetchCollection,
  mplCore, ruleSet, safeFetchAllAssetV1, safeFetchAssetV1, update, updateCollectionPlugin, updatePlugin,
  type CollectionV1, type RuleSet,
} from '@metaplex-foundation/mpl-core';
import {
  createSignerFromKeypair, generateSigner, keypairIdentity, publicKey as toUmiPk,
  transactionBuilder,
  type PublicKey, type Signer, type Umi,
} from '@metaplex-foundation/umi';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { MARKETPLACE } from '@shardkeep/shared';

export interface DeedChainOpts {
  rpcUrl: string;
  /** Signer secret key bytes (payer + collection/update authority). Usually
   *  the admin; for URI-sweep calls it may be the deed-ops delegate installed
   *  by addDeedUpdateDelegate, which mpl-core accepts as update authority for
   *  every asset in the collection. */
  adminSecret: Uint8Array;
}

function makeUmi(opts: DeedChainOpts): Umi {
  const umi = createUmi(opts.rpcUrl).use(mplCore());
  const admin = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(opts.adminSecret));
  umi.use(keypairIdentity(admin));
  return umi;
}

/** One-time: create the Land Deed collection with a 5% marketplace-honoured
 *  royalty (ruleSet None — not enforced on chain; enforcement would require a
 *  ProgramAllowList rule set, which blocks trading anywhere off the list). This
 *  collection is the ROYALTY SOURCE OF TRUTH: every mint and the backfill copy
 *  its Royalties plugin verbatim.
 *
 *  `royaltyCreator` is the CONFIGURED destination (DEED_ROYALTY_CREATOR). It
 *  falls back to the signing key only because that is the devnet status quo —
 *  and a fallback is honest here, unlike in the mint path, since this is the
 *  one call that WRITES the address rather than copying it.
 *  Returns the collection address (persist in infra/devnet.addresses.json). */
export async function createDeedCollection(
  opts: DeedChainOpts & {
    name: string; uri: string; royaltyBps: number;
    /** Base58 address that receives the royalty. Omit ⇒ the admin signer. */
    royaltyCreator?: string | undefined;
  },
): Promise<{ collection: string; royaltyCreator: string }> {
  const umi = makeUmi(opts);
  const collection = generateSigner(umi);
  const creator = opts.royaltyCreator ? toUmiPk(opts.royaltyCreator) : umi.identity.publicKey;
  await createCollection(umi, {
    collection,
    name: opts.name,
    uri: opts.uri,
    plugins: [{
      type: 'Royalties',
      basisPoints: opts.royaltyBps,
      creators: [{ address: creator, percentage: 100 }],
      ruleSet: ruleSet('None'),
    }],
  }).sendAndConfirm(umi);
  return { collection: collection.publicKey.toString(), royaltyCreator: creator.toString() };
}

/** The ONE royalty shape deeds use, so the collection, every new mint and the
 *  backfill can never drift apart. `ruleSet` is a PARAMETER, not a constant, so
 *  a future enforcement policy (ProgramAllowList) is expressible without
 *  touching call sites. */
interface DeedRoyalties {
  type: 'Royalties';
  basisPoints: number;
  creators: Array<{ address: PublicKey; percentage: number }>;
  ruleSet: RuleSet;
}

/**
 * Read the royalty policy off the COLLECTION and hand back the exact plugin to
 * stamp on an asset.
 *
 * WHY the collection and not the caller (security review 2026-07-29 F2+F3): in
 * mpl-core an asset-level plugin REPLACES the collection's rather than merging
 * with it, so the moment a deed carries its own Royalties plugin the collection
 * copy stops mattering for that deed. Deriving the creators from whoever signed
 * (`umi.identity`) made that worse — a mint from a different admin key would
 * silently redirect the royalty. Copying {basisPoints, creators, ruleSet}
 * verbatim keeps the collection the single source of truth even though the
 * asset is what marketplaces read, and the bps assertion makes a drift between
 * the chain and `MARKETPLACE.deedRoyaltyBps` a loud failure instead of a quiet
 * split fleet.
 *
 * `expectedCreator` (DEED_ROYALTY_CREATOR) is the same kind of assertion for
 * the DESTINATION: it is checked, never substituted. Substituting it would make
 * an env var silently outrank the chain and split the fleet across two payees;
 * asserting it means "the env says the treasury moved but the collection was
 * never repointed" fails loudly, and `deed:royalty:creator` is the one way to
 * make it true.
 */
function collectionRoyalties(
  collection: CollectionV1, expectedBps: number, expectedCreator?: string | undefined,
): DeedRoyalties {
  const r = collection.royalties;
  if (!r) {
    throw new Error(
      `deed collection ${collection.publicKey} has NO Royalties plugin — refusing to invent one. `
      + 'Stamping a royalty the collection does not carry would make the asset the only source of '
      + 'truth. Fix the collection first (deed:collection creates it with one).',
    );
  }
  if (r.basisPoints !== expectedBps) {
    throw new Error(
      `deed royalty drift: collection ${collection.publicKey} carries ${r.basisPoints} bps but `
      + `MARKETPLACE.deedRoyaltyBps is ${expectedBps}. Refusing to mint/stamp a deed at a rate the `
      + 'collection disagrees with — reconcile the constant with the chain first.',
    );
  }
  if (expectedCreator !== undefined) {
    const actual = r.creators.map((c) => c.address.toString());
    // Exactly one creator, and it is the configured one. A partial match (the
    // treasury plus a leftover creator) is still a split royalty, so it fails.
    if (actual.length !== 1 || actual[0] !== expectedCreator) {
      throw new Error(
        `deed royalty DESTINATION drift: collection ${collection.publicKey} pays `
        + `[${actual.join(', ') || 'nobody'}] but DEED_ROYALTY_CREATOR is ${expectedCreator}. `
        + 'Refusing to act on a collection that pays somewhere the config denies. Repoint the '
        + 'collection AND every minted deed with: '
        + 'pnpm --filter @shardkeep/scripts deed:royalty:creator --confirm',
      );
    }
  }
  return {
    type: 'Royalties',
    basisPoints: r.basisPoints,
    creators: r.creators.map((c) => ({ address: c.address, percentage: c.percentage })),
    ruleSet: r.ruleSet,
  };
}

/** READ-ONLY preflight for ops scripts: what royalty policy does the collection
 *  actually carry right now? Returned flat (strings/numbers) so a CLI can print
 *  it and compare it against the constant BEFORE writing to assets it may no
 *  longer own. Throws if the collection has no Royalties plugin. */
export async function fetchDeedCollectionRoyalties(
  opts: DeedChainOpts & { collection: string },
): Promise<{
  basisPoints: number;
  creators: Array<{ address: string; percentage: number }>;
  ruleSet: string;
}> {
  const umi = makeUmi(opts);
  const collection = await fetchCollection(umi, toUmiPk(opts.collection));
  const r = collection.royalties;
  if (!r) throw new Error(`deed collection ${opts.collection} has NO Royalties plugin`);
  return {
    basisPoints: r.basisPoints,
    creators: r.creators.map((c) => ({ address: c.address.toString(), percentage: c.percentage })),
    // Both the unwrapped ({type}) and the raw kinobi ({__kind}) shapes reach
    // here depending on how the account was deserialized — print either.
    ruleSet: (r.ruleSet as { type?: string; __kind?: string }).type
      ?? (r.ruleSet as { __kind?: string }).__kind ?? 'unknown',
  };
}

/**
 * A deed's identity is keyed to the ASSET, never to the wallet that happens to
 * hold it (security review 2026-07-29 F2). A wallet-keyed URI survives a sale
 * on chain but not in meaning: the buyer's asset would keep pointing at the
 * SELLER's document — rendering the seller's rebuilt base — and the seller's
 * next deed would collide on the very same URI. Both helpers below take the
 * asset address, which is knowable at mint time (the asset signer is generated
 * locally, before the transaction is sent).
 */
export function deedJsonUri(publicBase: string, assetId: string): string {
  return `${publicBase.replace(/\/$/, '')}/deed/asset/${assetId}.json`;
}

/**
 * The same URI plus a content version — what makes a deed genuinely dynamic.
 *
 * WHY A QUERY PARAM AT ALL. Wallets and explorers do not read the URI; they read
 * a DAS indexer, and DAS re-fetches a document only when something ON CHAIN
 * changes. With a fixed URI the traits it cached at mint are the traits it shows
 * forever. Observed on devnet: R2 served Keep 17 / 111 buildings while every
 * wallet showed Keep 15 / 85, with no mechanism that would ever correct it.
 * Changing the stored URI is the only signal an indexer acts on.
 *
 * FIXED WIDTH, deliberately. A Core asset stores its URI on chain, so a
 * longer URI costs rent. Every version is `?v=` + exactly 8 hex chars, so the
 * account grows ONCE (11 bytes, ~0.00008 SOL) on the first versioned write and
 * never again — subsequent updates are pure transaction fee.
 *
 * The version is a hash of the metadata document, so it changes if and only if
 * what a wallet would display changes. Passing the same content twice produces
 * the same URI, which is what makes the on-chain updater idempotent.
 */
export function deedJsonUriVersioned(publicBase: string, assetId: string, version: string): string {
  const v = version.slice(0, 8).padStart(8, '0');
  return `${deedJsonUri(publicBase, assetId)}?v=${v}`;
}

/** The `v` of a stored URI, or null for an unversioned one (pre-migration). */
export function deedUriVersion(uri: string): string | null {
  return /[?&]v=([0-9a-f]{8})\b/.exec(uri)?.[1] ?? null;
}

/** On-chain + metadata display name. Asset-derived so it does not name a holder. */
export function deedAssetName(assetId: string): string {
  return `Land Deed · ${assetId.slice(0, 4)}…${assetId.slice(-4)}`;
}

/**
 * Domain-separated, deterministic Core signer for one stable base id.
 *
 * Exactly-once is an address property, not a transaction-signature property:
 * Solana may accept `create` and then let the RPC timeout, so blindly generating
 * another signer on retry creates a second, perfectly tradeable orphan deed.
 * The API persists this public address before the first broadcast and every
 * retry reconstructs this same signer. Nothing secret is stored in Postgres.
 *
 * Changing the admin key (or this derivation version) changes the derived
 * address. The API compares it to the persisted address and fails closed, so a
 * key rotation can never quietly strand the old mint and create a replacement.
 */
function fixedDeedSigner(umi: Umi, adminSecret: Uint8Array, operationId: string): Signer {
  const op = operationId.trim();
  if (!op) throw new Error('deed mint operationId must not be empty');
  const message = new TextEncoder().encode(`SHARDKEEP:LAND_DEED_ASSET:v1:${op}`);
  const seed = hmac(sha256, adminSecret, message);
  return createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSeed(seed));
}

/** Read-only/local planning step. Safe to call inside a database transaction:
 * it performs no RPC and signs/sends nothing. The returned address MUST be
 * durably stored before `mintLandDeed` is allowed to broadcast. */
export function deriveLandDeedAsset(
  opts: DeedChainOpts & { operationId: string },
): string {
  const umi = makeUmi(opts);
  return fixedDeedSigner(umi, opts.adminSecret, opts.operationId).publicKey.toString();
}

function sameRoyaltyPolicy(
  actual: NonNullable<NonNullable<Awaited<ReturnType<typeof safeFetchAssetV1>>>['royalties']>,
  expected: DeedRoyalties,
): boolean {
  if (actual.basisPoints !== expected.basisPoints) return false;
  if (actual.creators.length !== expected.creators.length) return false;
  for (let i = 0; i < actual.creators.length; i++) {
    const a = actual.creators[i]!;
    const e = expected.creators[i]!;
    if (a.address.toString() !== e.address.toString() || a.percentage !== e.percentage) return false;
  }
  // mpl-core's hooked account decoder and collection decoder return the same
  // RuleSet representation. JSON is sufficient here because rule sets contain
  // only tagged data + public keys (which stringify canonically).
  return JSON.stringify(actual.ruleSet) === JSON.stringify(expected.ruleSet);
}

function assertExistingDeedMatches(
  existing: NonNullable<Awaited<ReturnType<typeof safeFetchAssetV1>>>,
  expected: {
    asset: string; collection: string; name: string; uri: string;
    royalties: DeedRoyalties;
  },
): void {
  if (existing.publicKey.toString() !== expected.asset) {
    throw new Error(`deed recovery returned ${existing.publicKey}, expected ${expected.asset}`);
  }
  if (
    existing.updateAuthority.type !== 'Collection'
    || existing.updateAuthority.address?.toString() !== expected.collection
  ) {
    throw new Error(
      `deed ${expected.asset} exists under an unexpected update authority; refusing recovery`,
    );
  }
  if (existing.name !== expected.name || existing.uri !== expected.uri) {
    throw new Error(
      `deed ${expected.asset} exists with unexpected identity metadata; refusing recovery`,
    );
  }
  const freeze = existing.permanentFreezeDelegate;
  if (
    !freeze
    || freeze.authority.type !== 'UpdateAuthority'
    || freeze.frozen !== !MARKETPLACE.tradingEnabled
  ) {
    throw new Error(
      `deed ${expected.asset} exists without the configured permanent freeze policy; refusing recovery`,
    );
  }
  if (!existing.royalties || !sameRoyaltyPolicy(existing.royalties, expected.royalties)) {
    throw new Error(`deed ${expected.asset} exists with an unexpected royalty policy; refusing recovery`);
  }
}

/** Mint one Land Deed to `owner`.
 *
 *  FREEZE: the PermanentFreezeDelegate is ALWAYS attached, with the ADMIN as
 *  the delegate authority — it is the fleet-wide kill switch and dropping it
 *  would make that switch unbuildable later. Whether the deed ARRIVES frozen is
 *  `!MARKETPLACE.tradingEnabled`, i.e. exactly the flag the UI reads. Before
 *  the 2026-07-29 review this was hardcoded `true`, so every new player minted
 *  a soulbound deed while the market screen said "TRADING LIVE" (F6).
 *
 *  `identity` is a CALLBACK, not two strings: name and uri must be derived from
 *  the asset address (F2), and that address exists only after the local signer
 *  is generated here. */
export async function mintLandDeed(
  opts: DeedChainOpts & {
    collection: string; owner: string;
    /** Stable server operation id (the base UUID), never a request id. */
    operationId: string;
    /** Address persisted by the caller before this function is invoked. */
    expectedAsset: string;
    identity: (asset: string) => { name: string; uri: string };
    /** ASSERTION, not a setting: the bps the caller believes the collection
     *  carries (MARKETPLACE.deedRoyaltyBps). The mint aborts on disagreement —
     *  the plugin actually stamped is copied from the collection. */
    royaltyBps: number;
    /** ASSERTION, not a setting: the configured royalty destination
     *  (DEED_ROYALTY_CREATOR). Omit ⇒ no destination check (devnet default,
     *  where the creator is simply whoever created the collection). Set ⇒ a
     *  collection that has not been repointed yet refuses to mint, instead of
     *  minting deeds that pay the old address forever. */
    expectedCreator?: string | undefined;
  },
): Promise<{ asset: string; recovered: boolean }> {
  const umi = makeUmi(opts);
  const collection = await fetchCollection(umi, toUmiPk(opts.collection));
  const asset = fixedDeedSigner(umi, opts.adminSecret, opts.operationId);
  const assetId = asset.publicKey.toString();
  if (assetId !== opts.expectedAsset) {
    throw new Error(
      `deed signer mismatch for operation ${opts.operationId}: persisted ${opts.expectedAsset}, `
      + `current key derives ${assetId}; refusing to mint after key/derivation rotation`,
    );
  }
  const { name, uri } = opts.identity(assetId);
  const royalties = collectionRoyalties(collection, opts.royaltyBps, opts.expectedCreator);
  const validation = {
    asset: assetId, collection: opts.collection, name, uri, royalties,
  };

  // Retry path first: if an earlier send landed but confirmation threw, recover
  // that exact account. Its current owner is intentionally not required to be
  // the original buyer: deeds are transferable, and the ownership observer
  // will move the base after this exact asset is attached in Postgres.
  const existing = await safeFetchAssetV1(umi, asset.publicKey);
  if (existing) {
    assertExistingDeedMatches(existing, validation);
    return { asset: assetId, recovered: true };
  }

  const tx = create(umi, {
    asset,
    collection,
    name,
    uri,
    owner: toUmiPk(opts.owner),
    plugins: [
      {
        type: 'PermanentFreezeDelegate',
        frozen: !MARKETPLACE.tradingEnabled,
        authority: { type: 'UpdateAuthority' },
      },
      // ASSET-LEVEL ROYALTIES as well as the collection's (owner 2026-07-29,
      // "why does it say seller fee 0%"). Core lets an asset INHERIT the
      // collection's Royalties plugin — but explorers, wallets and aggregators
      // that read only the asset print `Seller Fee 0%` and `no creators`, which
      // a buyer reads as "this NFT pays no royalty". Stamping the collection's
      // OWN plugin (verbatim, never re-derived from the signer) makes the number
      // true everywhere it is read and changes nothing economically.
      royalties,
    ],
  });
  try {
    await tx.sendAndConfirm(umi);
    return { asset: assetId, recovered: false };
  } catch (sendError) {
    // `sendAndConfirm` is ambiguous: the write may be finalized even though the
    // client observed an RPC timeout. Query the SAME address before surfacing
    // failure. If indexing/confirmation has not caught up yet, the next API
    // retry repeats this exact check and uses this exact signer again.
    const landed = await safeFetchAssetV1(umi, asset.publicKey).catch(() => null);
    if (landed) {
      assertExistingDeedMatches(landed, validation);
      return { asset: assetId, recovered: true };
    }
    throw sendError;
  }
}

/** Backfill: stamp the COLLECTION's Royalties onto an EXISTING deed that only
 *  inherited them (or carries a stale copy — this is also the per-asset half of
 *  a destination change). Idempotent — updatePlugin when present, addPlugin when
 *  not. Aborts if the collection has no royalties, disagrees with `royaltyBps`,
 *  or (when given) pays someone other than `expectedCreator`. */
export async function setDeedRoyalties(
  opts: DeedChainOpts & {
    collection: string; asset: string; royaltyBps: number;
    /** ASSERTION against the collection (DEED_ROYALTY_CREATOR). In the
     *  destination sweep the collection is repointed FIRST, so this is what
     *  proves each asset is copying the NEW address and not the old one. */
    expectedCreator?: string | undefined;
  },
): Promise<'added' | 'updated'> {
  const umi = makeUmi(opts);
  // fetchAssetV1 (raw), NOT fetchAsset: the latter MERGES the collection's
  // plugins into the asset view, so an inherited-only royalty looks like an
  // asset-level one and updatePlugin fails with "plugin not found" (0x4).
  const existing = await fetchAssetV1(umi, toUmiPk(opts.asset));
  const plugin = collectionRoyalties(
    await fetchCollection(umi, toUmiPk(opts.collection)), opts.royaltyBps, opts.expectedCreator,
  );
  if (existing.royalties) {
    await updatePlugin(umi, {
      asset: toUmiPk(opts.asset), collection: toUmiPk(opts.collection), plugin,
    }).sendAndConfirm(umi);
    return 'updated';
  }
  await addPlugin(umi, {
    asset: toUmiPk(opts.asset), collection: toUmiPk(opts.collection), plugin,
  }).sendAndConfirm(umi);
  return 'added';
}

/**
 * Repoint the COLLECTION's royalty to a new creator (owner 2026-07-29: the
 * destination must be flexible via env before mainnet). This is the ONLY
 * function that changes where deed royalties are paid — assets never carry an
 * address of their own choosing, they copy this one, so a destination change is
 * always "repoint here, then re-stamp every asset" (`deed:royalty:creator`).
 *
 * The new plugin keeps the collection's EXISTING basisPoints and ruleSet and
 * replaces only the creators, with the configured address at 100%. Splitting
 * across several payees is deliberately not expressible: one env var, one
 * destination, no ambiguity about who is owed what.
 *
 * Returns before/after creator lists so the CLI can print the actual diff
 * rather than what it intended to write.
 */
export async function setDeedCollectionRoyaltyCreator(
  opts: DeedChainOpts & { collection: string; creator: string; royaltyBps: number },
): Promise<{ before: string[]; after: string[]; basisPoints: number }> {
  const umi = makeUmi(opts);
  const collection = await fetchCollection(umi, toUmiPk(opts.collection));
  // Reuse the same guard the mint path uses (no royalties / bps drift), without
  // the destination assertion — moving the destination is the point here.
  const current = collectionRoyalties(collection, opts.royaltyBps);
  await updateCollectionPlugin(umi, {
    collection: toUmiPk(opts.collection),
    plugin: {
      type: 'Royalties',
      basisPoints: current.basisPoints,
      creators: [{ address: toUmiPk(opts.creator), percentage: 100 }],
      ruleSet: current.ruleSet,
    },
  }).sendAndConfirm(umi);
  return {
    before: current.creators.map((c) => c.address.toString()),
    after: [opts.creator],
    basisPoints: current.basisPoints,
  };
}

/** Repoint a deed's metadata URI (admin/update authority only). Exists because
 *  early devnet deeds minted with a localhost URI before the R2 bucket became
 *  the public metadata home (owner 2026-07-26) — Core URIs are mutable by the
 *  update authority, so a re-mint is never needed. Owner/plugins untouched.
 *
 *  `name` is optional and used by the F2 migration: deeds minted before the
 *  asset-keyed scheme carry `Land Deed · <minter wallet>` ON CHAIN, which after
 *  a resale names the wrong party forever. Omit it to leave the name alone. */
export async function updateLandDeedUri(
  opts: DeedChainOpts & { collection: string; asset: string; uri: string; name?: string },
): Promise<void> {
  const umi = makeUmi(opts);
  await update(umi, {
    asset: await fetchAsset(umi, toUmiPk(opts.asset)),
    collection: { publicKey: toUmiPk(opts.collection) },
    uri: opts.uri,
    ...(opts.name === undefined ? {} : { name: opts.name }),
  }).sendAndConfirm(umi);
}

/** One deed's desired on-chain URI. */
export interface DeedUriUpdate { asset: string; uri: string }

/**
 * Circuit-breaker threshold for the batch updater (security review 2026-08-03
 * follow-up #6): how many deeds in ONE pass may change their URI's ADDRESS —
 * origin + path, as opposed to the ?v= version — before the pass refuses to
 * run. Not a game number: an ops safety limit, same class as SWEEP_BATCH.
 *
 * "A handful" is deliberate: a few address changes per pass are legitimate
 * (early devnet deeds minted with a localhost URI trickle through `deed:reuri`,
 * a claimed deed migrates). MANY in one pass mean the public base URL moved or
 * the config is wrong — and an unattended loop rewriting the whole fleet to a
 * host nobody serves is strictly worse than the stale deeds this feature fixes,
 * because every wallet would then show a BROKEN deed, not an old one.
 */
const MAX_REPOINTS_PER_PASS = 5;

/** The document ADDRESS of a deed URI: origin + path, query stripped. The ?v=
 *  version moves on every content change by design; the address moving means
 *  the deed is being pointed at a different host or route. */
function uriAddress(uri: string): string {
  return uri.replace(/\?.*$/, '');
}

export interface BatchUpdateResult {
  /** Deeds whose URI was written on chain. */
  updated: number;
  /** Transactions actually sent — the batching win is `updated / txs`. */
  txs: number;
  /** Assets skipped because chain already had that exact URI. */
  alreadyCurrent: number;
  /** Assets that could not be read (not found / not a Core asset). */
  missing: string[];
  /** Assets in a transaction that failed to confirm. They are NOT updated and
   *  retry on the next sweep; reported so a permanently-bad one is visible
   *  rather than silently re-attempted forever. */
  failed: string[];
}

/**
 * Repoint MANY deeds' metadata URIs, batched into as few transactions as fit.
 *
 * WHY THIS EXISTS. Land Deeds are dynamic: the traits and the base picture are
 * rebuilt from live server state and republished continuously. But wallets and
 * explorers do not read the URI — they read a DAS indexer, and DAS has no
 * reason to re-fetch a document whose URI never changed. Measured on devnet:
 * the R2 document said Keep 17 / 111 buildings while every wallet showed
 * Keep 15 / 85, indefinitely. Changing the ON-CHAIN URI is the only thing that
 * tells an indexer to look again, so "dynamic" costs one transaction.
 *
 * BATCHING IS THE WHOLE POINT. A Core `update` is a small instruction and the
 * cost is dominated by the per-signature fee, so packing many into one
 * transaction divides the cost by the batch size. The batch size is DISCOVERED,
 * not hardcoded: `unsafeSplitByTransactionSize` packs until the serialized
 * transaction would exceed the limit, which stays correct if the instruction,
 * the address-table story or the fee payer ever changes.
 *
 * IDEMPOTENT. Assets whose on-chain URI already equals the requested one are
 * dropped before building anything — so a re-run after a partial failure costs
 * nothing, and a caller that cannot remember what it sent is still safe.
 *
 * PARTIAL PROGRESS IS REAL. Each transaction confirms independently; an
 * failure part-way leaves earlier batches applied. That is deliberate — the
 * alternative is all-or-nothing across hundreds of deeds, which cannot be
 * expressed in one transaction anyway. Callers re-run; the idempotence above
 * makes that cheap.
 *
 * BULK RE-POINTING IS REFUSED (follow-up #6). If more than a handful of assets
 * in one call would change their URI's origin/path — not just the ?v= — the
 * whole pass throws before anything is sent, unless `allowRepoint` is set.
 * Moving the fleet to a new address is the attended `deed:reuri` script's job.
 */
export async function updateLandDeedUris(
  opts: DeedChainOpts & {
    collection: string; updates: readonly DeedUriUpdate[];
    /** Permit a pass that re-points many URI origins/paths. The unattended loop
     *  passes DEED_CHAIN_REURI; ops scripts doing a deliberate migration pass
     *  `true`. Absent ⇒ the circuit breaker is armed. */
    allowRepoint?: boolean;
  },
): Promise<BatchUpdateResult> {
  const result: BatchUpdateResult = { updated: 0, txs: 0, alreadyCurrent: 0, missing: [], failed: [] };
  if (opts.updates.length === 0) return result;

  const umi = makeUmi(opts);
  const collection = { publicKey: toUmiPk(opts.collection) };

  // Read current state in as few round trips as possible: fetchAllAssetV1 maps
  // onto getMultipleAccounts, which caps at 100 keys per call.
  const wanted = new Map(opts.updates.map((u) => [u.asset, u.uri]));
  const keys = [...wanted.keys()];
  const assets = [];
  for (let i = 0; i < keys.length; i += 100) {
    const slice = keys.slice(i, i + 100);
    try {
      // `safe` variant: a deed that no longer exists on chain (burned) is
      // omitted rather than throwing the whole call.
      assets.push(...await safeFetchAllAssetV1(umi, slice.map((k) => toUmiPk(k))));
    } catch {
      // An account that EXISTS but does not deserialize as a Core asset — a
      // wrong id in the DB — throws for the whole chunk. Isolate it: one bad
      // row must not permanently stop every other deed from updating, which is
      // exactly the silent-freeze failure this whole feature exists to fix.
      for (const k of slice) {
        try {
          const one = await safeFetchAssetV1(umi, toUmiPk(k));
          if (one) assets.push(one);
        } catch { /* reported via `missing` below */ }
      }
    }
  }
  const byKey = new Map(assets.map((a) => [a.publicKey.toString(), a]));
  for (const k of keys) if (!byKey.has(k)) result.missing.push(k);

  // Track which assets ride in which instruction, so a failed transaction can
  // name the deeds it did not update instead of reporting a bare count.
  let builder = transactionBuilder();
  const assetOfItem: string[] = [];
  const repointed: string[] = [];
  let pending = 0;
  for (const [assetId, uri] of wanted) {
    const asset = byKey.get(assetId);
    if (!asset) continue;
    if (asset.uri === uri) { result.alreadyCurrent++; continue; }
    if (uriAddress(asset.uri) !== uriAddress(uri)) repointed.push(assetId);
    builder = builder.add(update(umi, { asset, collection, uri }));
    assetOfItem.push(assetId);
    pending++;
  }
  if (pending === 0) return result;

  // CIRCUIT BREAKER (follow-up #6): a version bump only ever moves ?v=. Many
  // ADDRESS changes in one pass mean the desired base and the chain disagree —
  // a moved public host, or a misconfigured one — and blasting that across the
  // fleet unattended would repoint every wallet at documents nobody may serve.
  // The WHOLE pass is refused, not just the re-points: the same config computed
  // every URI in it, so none of them is above suspicion. Throwing (rather than
  // returning a partial result) is deliberate — the sweep's cursor then does
  // not advance, the loop retries into the same wall every tick, the error
  // recorder turns /health red, and a human decides: fix the config, or run
  // the attended migration.
  if (repointed.length > MAX_REPOINTS_PER_PASS && opts.allowRepoint !== true) {
    throw new Error(
      `[deed] REFUSING the whole pass: ${repointed.length} deed(s) would change URI origin/path `
      + `(first: ${repointed.slice(0, 3).join(', ')}), and a content refresh only ever moves ?v=. `
      + 'This looks like a moved or misconfigured public base. Bulk re-pointing belongs to the '
      + 'attended deed:reuri script; if this change is intentional, set DEED_CHAIN_REURI=true.',
    );
  }

  // Split by SERIALIZED SIZE rather than a guessed instruction count.
  let i = 0;
  for (const tx of builder.unsafeSplitByTransactionSize(umi)) {
    const n = tx.items.length;
    const batch = assetOfItem.slice(i, i + n);
    i += n;
    // An empty builder would send a zero-instruction transaction and pay a fee
    // for nothing. Only reachable if one update ever exceeds the size limit.
    if (n === 0) continue;
    try {
      await tx.sendAndConfirm(umi);
      result.txs++;
      // Counted per CONFIRMED transaction, so the reported number is what
      // actually landed rather than what was queued.
      result.updated += n;
    } catch (e) {
      // ONE failing transaction must not abort the rest, and must not throw out
      // of the sweep. If it did, the caller's cursor would never advance: the
      // next tick would re-read the same page, hit the same failure, and every
      // deed after it would never be visited again — the whole fleet frozen on
      // one bad row or one flaky page, silently. That is strictly worse than the
      // stale deeds this feature exists to fix.
      result.failed.push(...batch);
      console.error(
        `[deed] URI update tx failed for ${batch.length} deed(s) (retries next sweep):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
  return result;
}

/**
 * DEED-OPS DELEGATE (dynamic deeds, owner GO 2026-08-03): grant a dedicated
 * ops key the right to update every deed in the collection, so the UNATTENDED
 * URI sweep stops holding the admin key.
 *
 * MECHANISM: a COLLECTION-level UpdateDelegate plugin whose `additionalDelegates`
 * carries the ops key. mpl-core then accepts that key as the update authority
 * for every asset whose update authority is the collection — which is every
 * deed — so `updateLandDeedUris` works unchanged with the ops key as signer.
 * The delegate can rewrite URIs/names and authority-managed plugins (and mint
 * INTO the collection — an mpl-core given, not a choice made here), but it
 * cannot mint KEEP, post epoch roots, or move the treasury: losing the box the
 * sweep runs on becomes an inconvenience, not a catastrophe.
 *
 * REPLACED, NOT APPENDED. `additionalDelegates` is written as exactly
 * `[delegate]`. The env names ONE ops key, and the point of a delegate is
 * rotation-after-compromise: appending would keep a stolen key authorized
 * forever, and "which of these delegates is current?" is a question with no
 * on-chain answer. Rotation is therefore one attended command, and the old key
 * is evicted by the same write that installs the new one.
 *
 * The plugin's own authority stays `UpdateAuthority` (the admin): putting the
 * ops key there would let it rewrite its own grant, which defeats rotation.
 *
 * IDEMPOTENT: if the list already reads exactly `[delegate]`, nothing is sent
 * ('unchanged') — a re-run of the attended script is free.
 */
export async function addDeedUpdateDelegate(
  opts: DeedChainOpts & { collection: string; delegate: string },
): Promise<{ action: 'added' | 'updated' | 'unchanged'; before: string[]; after: string[] }> {
  const umi = makeUmi(opts);
  // Same decision rule as the fetchAssetV1-not-fetchAsset gotcha in
  // setDeedRoyalties above: add-vs-update must come from what the ACCOUNT
  // actually carries, because updateCollectionPlugin fails on a missing plugin
  // and addCollectionPlugin fails on a present one. Collections have no parent
  // to inherit plugins from, so fetchCollection IS the raw read here.
  const collection = await fetchCollection(umi, toUmiPk(opts.collection));
  const before = collection.updateDelegate?.additionalDelegates.map((d) => d.toString()) ?? [];
  const after = [opts.delegate];
  const plugin = {
    type: 'UpdateDelegate' as const,
    additionalDelegates: [toUmiPk(opts.delegate)],
  };
  if (collection.updateDelegate === undefined) {
    await addCollectionPlugin(umi, {
      collection: toUmiPk(opts.collection),
      // Explicit, not defaulted: the DELEGATION lives in additionalDelegates;
      // the plugin itself remains admin-managed so only the admin can change
      // (or revoke) the grant.
      plugin: { ...plugin, authority: { type: 'UpdateAuthority' } },
    }).sendAndConfirm(umi);
    return { action: 'added', before, after };
  }
  if (before.length === 1 && before[0] === opts.delegate) {
    return { action: 'unchanged', before, after };
  }
  await updateCollectionPlugin(umi, {
    collection: toUmiPk(opts.collection),
    plugin,
  }).sendAndConfirm(umi);
  return { action: 'updated', before, after };
}

/** READ-ONLY preflight for the ops script: the collection's current
 *  additionalDelegates, or null when the UpdateDelegate plugin is absent
 *  altogether — distinct from `[]` (plugin present, nobody delegated) so the
 *  CLI can print exactly what add-vs-update will happen. */
export async function fetchDeedUpdateDelegates(
  opts: DeedChainOpts & { collection: string },
): Promise<string[] | null> {
  const umi = makeUmi(opts);
  const collection = await fetchCollection(umi, toUmiPk(opts.collection));
  return collection.updateDelegate
    ? collection.updateDelegate.additionalDelegates.map((d) => d.toString())
    : null;
}

/** Liquidity event: thaw a deed so it becomes tradable (owner decision — deeds
 *  are soulbound-until-liquidity). Run per asset by an ops script. */
export async function thawLandDeed(
  opts: DeedChainOpts & { collection: string; asset: string },
): Promise<void> {
  const umi = makeUmi(opts);
  await updatePlugin(umi, {
    asset: toUmiPk(opts.asset),
    collection: toUmiPk(opts.collection),
    plugin: { type: 'PermanentFreezeDelegate', frozen: false },
  }).sendAndConfirm(umi);
}
