/**
 * `.skr` reverse DISCOVERY (wallet → domain) — the auto-adoption machinery.
 *
 * WHY these tests exist: discovery output becomes a player's USERNAME with no
 * human in the loop. The two failure classes that matter are
 *  - DRIFT: our hand-ported PDA derivations disagree with what AllDomains
 *    actually deployed, so every adopted name is wrong or missing — pinned by
 *    a golden fixture from a live mainnet read (2026-07-31);
 *  - TRUST INVERSION: the reverse machinery (gPA + reverse records, which any
 *    RPC can lie about) being treated as PROOF instead of nomination — pinned
 *    by the forward-closure tests, where a lying record must yield NOTHING.
 */
import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { SEEKER } from '@shardkeep/shared';
import {
  decodeMainDomainLabel, deriveSkrMainDomainAccount, deriveSkrNameAccount,
  deriveSkrReverseAccount, discoverSkrOwnedBy,
} from './skr';

// --- GOLDEN FIXTURE: live mainnet reads, 2026-07-31 --------------------------
/** Owner wallet of torqueond.skr. */
const OWNER = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';
/** Its ANS name account (also pinned in seeker.test.ts). */
const NAME_ACCOUNT = '4eDbAer2fqjQWD8Q9HDcMofEEXz24UUZGptCh1t7snc5';
/** Its reverse-lookup account — space 209, label "torqueond" after byte 200. */
const REVERSE_ACCOUNT = '5PeCJ6o64GZ6yySmVAovRaRQJpHZSw2yYz7wqbGTfaJW';
/** The name account's raw data, captured from mainnet (see seeker.test.ts). */
const FORWARD_DATA_B64 = 'REhYLA+nZ/PQkRssJac6RUW3MEbYZkOSyaLiM38ITowKt0gsuxZTuiH2afxSqBXQt8SDRANYkL6YefaO9SlV5vTcpYa9Q/FwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJae72gAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/** Reverse-account bytes as they exist on chain: 200-byte header + raw label. */
function reverseRecordB64(label: string): string {
  return Buffer.concat([
    Buffer.alloc(SEEKER.skr.nameRecordByteSize), Buffer.from(label, 'utf8'),
  ]).toString('base64');
}

/** A NameRecordHeader owned by `owner` under the `.skr` parent. */
function forwardRecordB64(owner: string, createdAtSec: bigint): string {
  const buf = Buffer.alloc(SEEKER.skr.nameRecordByteSize);
  new PublicKey(SEEKER.skr.parentNameAccount).toBuffer().copy(buf, 8);
  new PublicKey(owner).toBuffer().copy(buf, 40);
  buf.writeBigUInt64LE(createdAtSec, 112); // expiresAt @104 stays 0 = "never"
  return buf.toString('base64');
}

/** A borsh MainDomain account: discriminator + nameAccount + tld + domain. */
function mainDomainB64(tld: string, domain: string, discriminator?: number[]): string {
  const str = (s: string): Buffer => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([
    Buffer.from(discriminator ?? (SEEKER.skr.mainDomainDiscriminator as unknown as number[])),
    Buffer.alloc(32), // nameAccount — unused; the forward closure re-derives
    str(tld), str(domain),
  ]).toString('base64');
}

/**
 * Fake mainnet keyed by (method, first-param address). `accounts` maps address
 * → base64 data for getAccountInfo/getMultipleAccounts; `programAccounts` is
 * what gPA returns. Records every requested address, so tests can pin WHICH
 * PDAs the discovery asked for — that is the derivation under test.
 */
function fakeRpc(opts: {
  accounts?: Record<string, string>;
  programAccounts?: { pubkey: string; data: string }[];
}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(body);
    let result: unknown = null;
    if (body.method === 'getAccountInfo') {
      const b64 = opts.accounts?.[String(body.params[0])];
      result = { value: b64 ? { data: [b64, 'base64'] } : null };
    } else if (body.method === 'getMultipleAccounts') {
      result = {
        value: (body.params[0] as string[]).map((a) => {
          const b64 = opts.accounts?.[a];
          return b64 ? { data: [b64, 'base64'] } : null;
        }),
      };
    } else if (body.method === 'getProgramAccounts') {
      result = (opts.programAccounts ?? []).map((p) => ({
        pubkey: p.pubkey, account: { data: [p.data, 'base64'] },
      }));
    }
    return { ok: true, json: async () => ({ result }) } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const methodsOf = (calls: { method: string }[]): string[] => calls.map((c) => c.method);

describe('.skr reverse-lookup derivation (golden fixture)', () => {
  it('derives the real torqueond.skr reverse account from its name account', () => {
    // If this breaks, the hashed-name/class/parent recipe drifted from what
    // AllDomains deployed and every auto-adopted username is suspect.
    expect(deriveSkrReverseAccount(NAME_ACCOUNT)).toBe(REVERSE_ACCOUNT);
  });

  it('decodes a MainDomain account and rejects a wrong discriminator or foreign TLD', () => {
    // Discriminator first: the PDA is derived from seeds WE chose, so any
    // account parked there by another program must be unreadable as a domain.
    expect(decodeMainDomainLabel(Buffer.from(mainDomainB64('.skr', 'torqueond'), 'base64'))).toBe('torqueond');
    // FQDN-vs-label semantics are unverified live — both must normalise.
    expect(decodeMainDomainLabel(Buffer.from(mainDomainB64('.skr', 'torqueond.skr'), 'base64'))).toBe('torqueond');
    expect(decodeMainDomainLabel(Buffer.from(mainDomainB64('.sol', 'torqueond'), 'base64'))).toBeNull();
    expect(decodeMainDomainLabel(Buffer.from(mainDomainB64('.skr', 'torqueond', [1, 2, 3, 4, 5, 6, 7, 8]), 'base64'))).toBeNull();
  });
});

describe('discoverSkrOwnedBy — nomination is not ownership', () => {
  it('GOLDEN: discovers torqueond.skr via gPA → reverse label → forward proof', async () => {
    // End-to-end pin of every derivation at once: the reverse account it asks
    // for and the forward name account it proves against are the LIVE ones.
    const { impl, calls } = fakeRpc({
      accounts: {
        [REVERSE_ACCOUNT]: reverseRecordB64('torqueond'),
        [NAME_ACCOUNT]: FORWARD_DATA_B64,
      },
      programAccounts: [{ pubkey: NAME_ACCOUNT, data: FORWARD_DATA_B64 }],
    });
    const rec = await discoverSkrOwnedBy({ rpcUrl: 'https://fake', owner: OWNER, fetchImpl: impl });
    expect(rec).toEqual({ domain: 'torqueond.skr', nameAccount: NAME_ACCOUNT, owner: OWNER });
    // The batched reverse read asked for exactly the live reverse PDA.
    const gma = calls.find((c) => c.method === 'getMultipleAccounts')!;
    expect(gma.params[0]).toEqual([REVERSE_ACCOUNT]);
  });

  it('a reverse record nominating a label the owner does NOT hold yields null, never a name', async () => {
    // THE trust-inversion case: gPA and the reverse account both come from an
    // unauthenticated RPC. Here the reverse record lies ("vexlord"), and the
    // forward account for vexlord.skr belongs to someone else — adoption must
    // degrade to nothing rather than assign the lie.
    const liar = deriveSkrNameAccount('vexlord');
    const { impl } = fakeRpc({
      accounts: {
        [REVERSE_ACCOUNT]: reverseRecordB64('vexlord'),
        [liar]: forwardRecordB64('11111111111111111111111111111111', 1n),
      },
      programAccounts: [{ pubkey: NAME_ACCOUNT, data: FORWARD_DATA_B64 }],
    });
    expect(await discoverSkrOwnedBy({ rpcUrl: 'https://fake', owner: OWNER, fetchImpl: impl })).toBeNull();
  });

  it('the MainDomain fast path wins without a gPA scan — and is still forward-proven', async () => {
    // The wallet DECLARED its main domain; one getAccountInfo replaces the
    // whole scan. If this regresses to gPA-always, every link pays the most
    // expensive read mainnet offers for nothing.
    const { impl, calls } = fakeRpc({
      accounts: {
        [deriveSkrMainDomainAccount(OWNER)]: mainDomainB64('.skr', 'torqueond'),
        [NAME_ACCOUNT]: FORWARD_DATA_B64,
      },
    });
    const rec = await discoverSkrOwnedBy({ rpcUrl: 'https://fake', owner: OWNER, fetchImpl: impl });
    expect(rec?.domain).toBe('torqueond.skr');
    expect(methodsOf(calls)).not.toContain('getProgramAccounts');
  });

  it('a non-.skr MainDomain falls through to the scan instead of ending discovery', async () => {
    // A wallet whose main domain is a .sol may still own an undeclared .skr —
    // stopping at the fast path would deny real Seekers their name.
    const { impl, calls } = fakeRpc({
      accounts: {
        [deriveSkrMainDomainAccount(OWNER)]: mainDomainB64('.sol', 'torqueond'),
        [REVERSE_ACCOUNT]: reverseRecordB64('torqueond'),
        [NAME_ACCOUNT]: FORWARD_DATA_B64,
      },
      programAccounts: [{ pubkey: NAME_ACCOUNT, data: FORWARD_DATA_B64 }],
    });
    const rec = await discoverSkrOwnedBy({ rpcUrl: 'https://fake', owner: OWNER, fetchImpl: impl });
    expect(rec?.domain).toBe('torqueond.skr');
    expect(methodsOf(calls)).toContain('getProgramAccounts');
  });

  it('earliest createdAt wins; equal timestamps tiebreak on the LOWER pubkey', async () => {
    // Determinism across relinks is the contract: the same wallet must adopt
    // the same name every time, and "first .skr claimed" is the closest proxy
    // for the Seeker onboarding domain. Both rules pinned in one scenario.
    const na = (label: string): string => deriveSkrNameAccount(label);
    // Sort the two tied labels by their NAME-ACCOUNT pubkey (the tiebreak key).
    const [oldA, oldB] = ['tiea', 'tieb'].sort((x, y) => (na(x) < na(y) ? -1 : 1));
    const winner = oldA!;
    const { impl } = fakeRpc({
      accounts: {
        [deriveSkrReverseAccount(na('late'))]: reverseRecordB64('late'),
        [deriveSkrReverseAccount(na(oldA!))]: reverseRecordB64(oldA!),
        [deriveSkrReverseAccount(na(oldB!))]: reverseRecordB64(oldB!),
        [na(winner)]: forwardRecordB64(OWNER, 100n),
      },
      programAccounts: [
        { pubkey: na('late'), data: forwardRecordB64(OWNER, 500n) },
        { pubkey: na(oldB!), data: forwardRecordB64(OWNER, 100n) },
        { pubkey: na(oldA!), data: forwardRecordB64(OWNER, 100n) },
      ],
    });
    const rec = await discoverSkrOwnedBy({ rpcUrl: 'https://fake', owner: OWNER, fetchImpl: impl });
    expect(rec?.domain).toBe(`${winner}.skr`);
  });

  it('caps reverse lookups at maxReverseCandidates — a hoarder cannot inflate one link', async () => {
    // The cap bounds OUR cost, not the player's rights: candidates are sorted
    // before capping, so the earliest domains always make the cut.
    const labels = Array.from({ length: SEEKER.skr.maxReverseCandidates + 4 }, (_, i) => `hoard${i}`);
    const { impl, calls } = fakeRpc({
      programAccounts: labels.map((l, i) => ({
        pubkey: deriveSkrNameAccount(l), data: forwardRecordB64(OWNER, BigInt(i + 1)),
      })),
    });
    await discoverSkrOwnedBy({ rpcUrl: 'https://fake', owner: OWNER, fetchImpl: impl });
    const gma = calls.find((c) => c.method === 'getMultipleAccounts')!;
    expect((gma.params[0] as string[]).length).toBe(SEEKER.skr.maxReverseCandidates);
  });

  it('never throws: a dead RPC or missing config resolves to null', async () => {
    // `.skr` is decoration — an exception here would fail the LINK, turning a
    // naming nicety into a badge outage.
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(discoverSkrOwnedBy({ rpcUrl: 'https://fake', owner: OWNER, fetchImpl: boom }))
      .resolves.toBeNull();
    await expect(discoverSkrOwnedBy({ owner: OWNER })).resolves.toBeNull();
  });
});
