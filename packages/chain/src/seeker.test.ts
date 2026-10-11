/**
 * SGT predicate + `.skr` derivation.
 *
 * WHY these tests: the Seeker badge is an anti-sybil claim ("one physical
 * device, one account"). If the predicate accepted anything less than all four
 * issuer-controlled fields, ANY user could mint a Token-2022 NFT with a
 * metadataPointer aimed at Solana Mobile's metadata account and print badges —
 * the badge would then mean nothing, which is worse than not having one. So
 * each look-alike below removes exactly ONE field and must still be rejected.
 */
import { describe, expect, it } from 'vitest';
import { SEEKER } from '@shardkeep/shared';
import {
  assertMainnetCluster, checkSgtMint, independentSourceCount, SeekerRpcError,
  SeekerSourceConflictError, verifySgtOwnership, type ParsedMintAccount,
} from './seeker';
import { decodeNameRecord, deriveSkrNameAccount, parseSkrLabel } from './skr';

/** The owner's real SGT, as mainnet returns it (brief §4, verified 2026-07-29). */
const REAL_MINT = '5NkcDPoxuB5EXWiD9hd5qsxnCXk7dYnuBds4XPxWtdPT';
function realSgtAccount(): ParsedMintAccount {
  return {
    owner: SEEKER.sgt.tokenProgram,
    data: {
      parsed: {
        type: 'mint',
        info: {
          decimals: 0,
          supply: '1',
          mintAuthority: SEEKER.sgt.mintAuthority,
          extensions: [
            { extension: 'metadataPointer', state: { authority: SEEKER.sgt.metadataAuthority, metadataAddress: SEEKER.sgt.metadataAddress } },
            { extension: 'permanentDelegate', state: {} },
            { extension: 'mintCloseAuthority', state: {} },
            { extension: 'groupMemberPointer', state: {} },
            { extension: 'tokenGroupMember', state: { group: SEEKER.sgt.group, memberNumber: 76095 } },
          ],
        },
      },
    },
  };
}

const ATTACKER = 'GTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('checkSgtMint — the four-way predicate', () => {
  it('accepts the real Seeker Genesis Token and reports its member number', () => {
    expect(checkSgtMint(REAL_MINT, realSgtAccount())).toEqual({ mint: REAL_MINT, memberNumber: 76095 });
  });

  it('rejects a look-alike with a forged mint authority', () => {
    const a = realSgtAccount();
    a.data!.parsed!.info!.mintAuthority = ATTACKER;
    expect(checkSgtMint(REAL_MINT, a)).toBeNull();
  });

  it('rejects a look-alike whose metadataPointer authority is not Solana Mobile', () => {
    const a = realSgtAccount();
    a.data!.parsed!.info!.extensions![0]!.state!.authority = ATTACKER;
    expect(checkSgtMint(REAL_MINT, a)).toBeNull();
  });

  it('rejects a look-alike pointing at the wrong metadata address', () => {
    const a = realSgtAccount();
    a.data!.parsed!.info!.extensions![0]!.state!.metadataAddress = ATTACKER;
    expect(checkSgtMint(REAL_MINT, a)).toBeNull();
  });

  it('rejects a look-alike in the wrong token group', () => {
    const a = realSgtAccount();
    a.data!.parsed!.info!.extensions![4]!.state!.group = ATTACKER;
    expect(checkSgtMint(REAL_MINT, a)).toBeNull();
  });

  it('rejects a mint with no group membership at all', () => {
    const a = realSgtAccount();
    a.data!.parsed!.info!.extensions = a.data!.parsed!.info!.extensions!.filter((e) => e.extension !== 'tokenGroupMember');
    expect(checkSgtMint(REAL_MINT, a)).toBeNull();
  });

  it('rejects a legacy SPL-Token mint (not Token-2022)', () => {
    const a = realSgtAccount();
    a.owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    expect(checkSgtMint(REAL_MINT, a)).toBeNull();
  });

  it('rejects a fungible look-alike (supply > 1) so one mint cannot back many holders', () => {
    const a = realSgtAccount();
    a.data!.parsed!.info!.supply = '1000';
    expect(checkSgtMint(REAL_MINT, a)).toBeNull();
  });

  it('rejects a missing account rather than throwing', () => {
    expect(checkSgtMint(REAL_MINT, null)).toBeNull();
  });
});

/**
 * Minimal fake mainnet: `wallets` maps owner → the mints it holds, `mints` maps
 * a mint → its account. Serves BOTH batched mint reads and the single-account
 * shape, so a test never has to know how the module chunks its reads.
 */
function fakeMainnet(
  wallets: Record<string, string[]>, mints: Record<string, ParsedMintAccount | null>,
  onCall?: (method: string) => void,
): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    onCall?.(body.method);
    let result: unknown = null;
    if (body.method === 'getTokenAccountsByOwner') {
      result = {
        value: (wallets[String(body.params[0])] ?? []).map((mint) => ({
          account: { data: { parsed: { info: { mint, tokenAmount: { amount: '1', decimals: 0 } } } } },
        })),
      };
    } else if (body.method === 'getMultipleAccounts') {
      result = { value: (body.params[0] as string[]).map((m) => mints[m] ?? null) };
    }
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) } as Response;
  }) as unknown as typeof fetch;
}

describe('verifySgtOwnership', () => {
  const owner = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';

  it('finds the SGT among the wallet Token-2022 accounts', async () => {
    const v = await verifySgtOwnership({
      rpcUrl: 'https://fake', owner,
      fetchImpl: fakeMainnet({ [owner]: [REAL_MINT] }, { [REAL_MINT]: realSgtAccount() }),
    });
    expect(v.holding).toEqual({ mint: REAL_MINT, memberNumber: 76095 });
  });

  it('returns null (no badge) when the wallet holds only a look-alike', async () => {
    const fake = realSgtAccount();
    fake.data!.parsed!.info!.mintAuthority = ATTACKER;
    const v = await verifySgtOwnership({
      rpcUrl: 'https://fake', owner,
      fetchImpl: fakeMainnet({ [owner]: ['FAKEmint1'] }, { FAKEmint1: fake }),
    });
    expect(v.holding).toBeNull();
  });

  it('finds the SGT in a wallet holding 250 UNRELATED assets — a real Seeker is never missed', async () => {
    // THE BUG THIS PINS: the mint reads used to be capped at 12 and issued one
    // call each, so a Seeker who also collects NFTs was told "no Seeker Genesis
    // Token in that wallet". They bought the device; the game denied it. The cap
    // now bounds the CANDIDATE LIST (500) while the reads are batched, so this
    // costs 1 + ceil(251/100) = 4 calls, not 251.
    const junk = Array.from({ length: 250 }, (_, i) => `JUNKmint${i}`);
    const mints: Record<string, ParsedMintAccount | null> = { [REAL_MINT]: realSgtAccount() };
    for (const m of junk) mints[m] = null;
    let calls = 0;

    const v = await verifySgtOwnership({
      rpcUrl: 'https://fake', owner,
      // SGT last, i.e. the worst case: every junk asset is inspected first.
      fetchImpl: fakeMainnet({ [owner]: [...junk, REAL_MINT] }, mints, () => { calls += 1; }),
    });
    expect(v.holding).toEqual({ mint: REAL_MINT, memberNumber: 76095 });
    expect(calls).toBe(1 + Math.ceil(251 / SEEKER.mintBatchSize));
  });

  it('answers about the EXPECTED mint first when the wallet holds TWO SGTs', async () => {
    // THE BUG THIS PINS: the first predicate hit in token-account order used to
    // win, and the caller does not control that order. SGTs are freely
    // sellable, so a second one landing in a linked wallet could outrace the
    // LINKED mint — and a re-check that asked "do you still hold YOUR token?"
    // was answered about the OTHER one, spuriously revoking a valid link.
    const second = 'SGT2ndDeviceMint11111111111111111111111111';
    const two = { [owner]: [second, REAL_MINT] }; // expected LAST = worst case
    const mints = { [second]: realSgtAccount(), [REAL_MINT]: realSgtAccount() };

    const asked = await verifySgtOwnership({
      rpcUrl: 'https://fake', owner, expectedMint: REAL_MINT,
      fetchImpl: fakeMainnet(two, mints),
    });
    expect(asked.holding?.mint).toBe(REAL_MINT);

    // Without the hint enumeration order wins — the hazard the hint exists for.
    const unasked = await verifySgtOwnership({
      rpcUrl: 'https://fake', owner, fetchImpl: fakeMainnet(two, mints),
    });
    expect(unasked.holding?.mint).toBe(second);
  });

  it('FAILS CLOSED when mainnet is unconfigured — an outage is not a "no"', async () => {
    await expect(verifySgtOwnership({ rpcUrl: undefined, owner })).rejects.toBeInstanceOf(SeekerRpcError);
  });

  it('FAILS CLOSED on a transport error rather than silently revoking', async () => {
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(verifySgtOwnership({ rpcUrl: 'https://fake', owner, fetchImpl: boom }))
      .rejects.toBeInstanceOf(SeekerRpcError);
  });

  it('CAPS the work a stuffed wallet can cost us — bounded calls AND a bounded candidate list', async () => {
    // The loop is attacker-shaped: anyone can airdrop NFTs into their own wallet
    // (security review F4). Two bounds have to hold at once — the number of RPC
    // calls (batching) and the number of mints inspected (the cap) — or the fix
    // for one becomes the hole for the other.
    const junk = Array.from({ length: SEEKER.maxCandidateMints * 3 }, (_, i) => `JUNKmint${i}`);
    const inspected = new Set<string>();
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls += 1;
      let result: unknown = null;
      if (body.method === 'getTokenAccountsByOwner') {
        result = { value: junk.map((mint) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount: '1', decimals: 0 } } } } } })) };
      } else if (body.method === 'getMultipleAccounts') {
        const batch = body.params[0] as string[];
        expect(batch.length).toBeLessThanOrEqual(SEEKER.mintBatchSize); // RPC hard limit
        for (const m of batch) inspected.add(m);
        result = { value: batch.map(() => null) };
      }
      return { ok: true, json: async () => ({ result }) } as Response;
    }) as unknown as typeof fetch;

    const v = await verifySgtOwnership({ rpcUrl: 'https://fake', owner, fetchImpl });
    expect(v.holding).toBeNull();
    expect(inspected.size).toBe(SEEKER.maxCandidateMints);
    expect(calls).toBe(1 + SEEKER.maxCandidateMints / SEEKER.mintBatchSize);
  });

  it('gives up on a HANGING mainnet instead of holding the request open forever', async () => {
    // No timeout meant a slow third party could pin a request worker — and
    // /me now reaches mainnet lazily, so that is a request every player makes.
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(verifySgtOwnership({ rpcUrl: 'https://fake', owner, fetchImpl: hang }))
      .rejects.toBeInstanceOf(SeekerRpcError); // an outage, so callers fail closed
    expect(Date.now() - started).toBeLessThan(SEEKER.rpcTimeoutMs * 2);
  }, SEEKER.rpcTimeoutMs * 4);

  it('a SECOND hanging source does not extend the budget — both share one deadline', async () => {
    // Two sources must cost latency-MAX, not latency-sum: the cross-check runs
    // inside the same request that /me makes.
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    await expect(verifySgtOwnership({
      rpcUrl: 'https://one', secondaryRpcUrl: 'https://two', owner, fetchImpl: hang,
    })).rejects.toBeInstanceOf(SeekerRpcError);
    expect(Date.now() - started).toBeLessThan(SEEKER.rpcTimeoutMs * 2);
  }, SEEKER.rpcTimeoutMs * 4);
});

/**
 * WHY: the whole badge is derived from what a third-party RPC says. One
 * unauthenticated response used to be enough to mint an anti-sybil identity —
 * no confirmation, no second opinion (2026-07-29 review, finding (a)).
 */
describe('verifySgtOwnership — two independent sources', () => {
  const owner = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';
  const holdsSgt = fakeMainnet({ [owner]: [REAL_MINT] }, { [REAL_MINT]: realSgtAccount() });
  /** Routes each endpoint to its own fake chain, by URL. */
  const perEndpoint = (byUrl: Record<string, typeof fetch>): typeof fetch =>
    ((url: string, init?: RequestInit) => byUrl[url]!(url, init)) as unknown as typeof fetch;

  it('grants a CONFIRMED verdict when both sources agree', async () => {
    const v = await verifySgtOwnership({
      rpcUrl: 'https://one', secondaryRpcUrl: 'https://two', owner,
      fetchImpl: perEndpoint({ 'https://one': holdsSgt, 'https://two': holdsSgt }),
    });
    expect(v).toEqual({ holding: { mint: REAL_MINT, memberNumber: 76095 }, sources: 2, confirmed: true });
  });

  it('grants NOTHING when the second source disagrees — one of them is lying', async () => {
    // The attack this blocks: a single hijacked / spoofed / MITM'd endpoint
    // answering "yes, this wallet holds the SGT" is no longer sufficient.
    const noSgt = fakeMainnet({ [owner]: [] }, {});
    const err = await verifySgtOwnership({
      rpcUrl: 'https://one', secondaryRpcUrl: 'https://two', owner,
      fetchImpl: perEndpoint({ 'https://one': holdsSgt, 'https://two': noSgt }),
    }).then(() => null, (e: unknown) => e);
    // A SeekerRpcError subclass, so EVERY existing caller already fails closed:
    // no badge granted, and (in recheck) no badge revoked either.
    expect(err).toBeInstanceOf(SeekerSourceConflictError);
    expect(err).toBeInstanceOf(SeekerRpcError);
  });

  it('rejects disagreement about WHICH mint, not just whether there is one', async () => {
    const other = 'OTHERmint11111111111111111111111111111111';
    const otherSgt = fakeMainnet({ [owner]: [other] }, { [other]: realSgtAccount() });
    await expect(verifySgtOwnership({
      rpcUrl: 'https://one', secondaryRpcUrl: 'https://two', owner,
      fetchImpl: perEndpoint({ 'https://one': holdsSgt, 'https://two': otherSgt }),
    })).rejects.toBeInstanceOf(SeekerSourceConflictError);
  });

  it('DEGRADES HONESTLY with one endpoint configured — verdict stands, confirmed does not', async () => {
    const v = await verifySgtOwnership({ rpcUrl: 'https://one', owner, fetchImpl: holdsSgt });
    expect(v).toEqual({ holding: { mint: REAL_MINT, memberNumber: 76095 }, sources: 1, confirmed: false });
  });

  it('degrades the same way when the cross-check is DOWN — an outage must not block linking', async () => {
    const dead = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const v = await verifySgtOwnership({
      rpcUrl: 'https://one', secondaryRpcUrl: 'https://two', owner,
      fetchImpl: perEndpoint({ 'https://one': holdsSgt, 'https://two': dead }),
    });
    expect(v.holding).toEqual({ mint: REAL_MINT, memberNumber: 76095 });
    expect(v.confirmed).toBe(false); // …and the API says so to the client
  });

  it('still fails closed when EVERY source is down', async () => {
    const dead = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(verifySgtOwnership({
      rpcUrl: 'https://one', secondaryRpcUrl: 'https://two', owner, fetchImpl: dead,
    })).rejects.toBeInstanceOf(SeekerRpcError);
  });

  it('the SAME provider twice is ONE source — an api-key suffix is not independence', async () => {
    expect(independentSourceCount('https://rpc.example/?api-key=a', 'https://rpc.example/?api-key=b')).toBe(1);
    expect(independentSourceCount('https://one.example', 'https://two.example')).toBe(2);
    expect(independentSourceCount(undefined, 'https://two.example')).toBe(0);
    expect(independentSourceCount('https://one.example')).toBe(1);

    // …and it is not merely reported as 1, it is never READ twice.
    const seen: string[] = [];
    const count = ((url: string, init?: RequestInit) => {
      seen.push(url);
      return holdsSgt(url, init);
    }) as unknown as typeof fetch;
    const v = await verifySgtOwnership({
      rpcUrl: 'https://rpc.example/?api-key=a', secondaryRpcUrl: 'https://rpc.example/?api-key=b',
      owner, fetchImpl: count,
    });
    expect(v.sources).toBe(1);
    expect(new Set(seen).size).toBe(1);
  });
});

describe('assertMainnetCluster — the config says nothing about which chain it is', () => {
  const genesis = (hash: string) => (async () => (
    { ok: true, json: async () => ({ result: hash }) } as Response
  )) as unknown as typeof fetch;

  it('accepts mainnet-beta', async () => {
    await expect(assertMainnetCluster({
      rpcUrl: 'https://fake', fetchImpl: genesis(SEEKER.mainnetGenesisHash),
    })).resolves.toBeUndefined();
  });

  it('REFUSES devnet with a plain Error — a misconfiguration must stop the boot', async () => {
    // The realistic mistake is pasting SOLANA_RPC_URL (devnet) into the mainnet
    // slot. Every SGT check would then answer "no badge" forever, with no
    // signal anywhere (security review F8).
    const devnetGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
    const err = await assertMainnetCluster({ rpcUrl: 'https://fake', fetchImpl: genesis(devnetGenesis) })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    // NOT a SeekerRpcError: the caller must be able to tell "wrong chain"
    // (refuse to boot) from "can't reach it right now" (boot, fail closed).
    expect(err).not.toBeInstanceOf(SeekerRpcError);
    expect(String(err)).toMatch(/not mainnet-beta/);
  });

  it('reports an unreachable endpoint as a transport error, so boot is not blocked by an outage', async () => {
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(assertMainnetCluster({ rpcUrl: 'https://fake', fetchImpl: boom }))
      .rejects.toBeInstanceOf(SeekerRpcError);
  });
});

describe('.skr resolution (naming only — never the badge)', () => {
  // GOLDEN FIXTURE: ground truth from a live mainnet read 2026-07-29. If this
  // breaks, our hand-ported ANS derivation drifted and every .skr username is
  // suspect — that is exactly what this pins.
  it('derives the real torqueond.skr name account', () => {
    expect(deriveSkrNameAccount('torqueond')).toBe('4eDbAer2fqjQWD8Q9HDcMofEEXz24UUZGptCh1t7snc5');
  });

  it('decodes the real NameRecordHeader (parent, owner, never-expires, non-transferable)', () => {
    // The account's raw data, captured from mainnet.
    const data = Uint8Array.from(Buffer.from(
      'REhYLA+nZ/PQkRssJac6RUW3MEbYZkOSyaLiM38ITowKt0gsuxZTuiH2afxSqBXQt8SDRANYkL6YefaO9SlV5vTcpYa9Q/FwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJae72gAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      'base64'));
    expect(decodeNameRecord(data)).toEqual({
      parentName: SEEKER.skr.parentNameAccount,
      owner: '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf',
      expiresAt: 0n,
      nonTransferable: true,
    });
  });

  it('rejects non-.skr and multi-level names', () => {
    expect(parseSkrLabel('torqueond.sol')).toBeNull();
    expect(parseSkrLabel('a.b.skr')).toBeNull();
    expect(parseSkrLabel('TORQUEOND.SKR')).toBe('torqueond');
  });
});
