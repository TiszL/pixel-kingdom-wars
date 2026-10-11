/**
 * Seeker identity + usernames.
 *
 * WHY these matter (not "what the code does"):
 *  - The Seeker badge is an ANTI-SYBIL claim. If an unproven wallet could bind,
 *    or one SGT could bind twice, the badge stops meaning "one physical device,
 *    one account" and every perk hung off it becomes farmable. Those two are the
 *    load-bearing tests here.
 *  - Usernames label raid targets and item-market sellers. Without
 *    case-insensitive uniqueness one player can rename INTO another's name and
 *    impersonate them on a money surface — which is exactly what shipped before.
 *  - A Privy/social player has no external wallet and can never hold an SGT.
 *    They must still be able to name themselves; gating identity on hardware
 *    would lock out the whole social on-ramp.
 */
import { readFile } from 'node:fs/promises';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveSkrNameAccount, deriveSkrReverseAccount } from '@shardkeep/chain';
import { SEEKER, USERNAMES } from '@shardkeep/shared';
import { buildApp } from '../src/app';
import { alphaAccess, authNonces, players, seekerLinks } from '../src/db/schema';
import { adoptSkrUsername, setUsername } from '../src/game/username';
import { buildSignInMessage } from '../src/auth/message';
import {
  autoDetectSeeker, recheckSeeker, resetAutoDetectBudget, type LinkDeps,
} from '../src/auth/seeker';
import { SESSION_COOKIE } from '../src/auth/session';
import { TEST_CONFIG, connectTestDb, createTestPlayer } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;

/** The owner's real SGT mint (mainnet ground truth, brief §4). */
const REAL_MINT = '5NkcDPoxuB5EXWiD9hd5qsxnCXk7dYnuBds4XPxWtdPT';

/** A `jsonParsed` Token-2022 mint that satisfies the full four-way predicate. */
function sgtMintAccount(memberNumber = 76095) {
  return {
    owner: SEEKER.sgt.tokenProgram,
    data: {
      parsed: {
        type: 'mint',
        info: {
          decimals: 0, supply: '1', mintAuthority: SEEKER.sgt.mintAuthority as string,
          extensions: [
            { extension: 'metadataPointer', state: { authority: SEEKER.sgt.metadataAuthority, metadataAddress: SEEKER.sgt.metadataAddress } },
            { extension: 'tokenGroupMember', state: { group: SEEKER.sgt.group, memberNumber } },
          ],
        },
      },
    },
  };
}

/**
 * Fake mainnet. `holdings` maps a wallet → the mint it holds; `mints` maps a
 * mint → its account. Everything the server believes about Seeker status must
 * come from here — never from the request body.
 */
/** A wallet may hold SEVERAL 1-of-1s (the multi-SGT re-check cases). */
const holdings = new Map<string, string | string[]>();
const mints = new Map<string, unknown>();
/** ANS name accounts, base64 — `.skr` records live here, not in `mints`. */
const nameAccounts = new Map<string, string>();
/** Every call the server makes to "mainnet". The unit of the F4 budget. */
let rpcCalls = 0;
/** getProgramAccounts calls only — the expensive read discovery must ration. */
let gpaCalls = 0;
const fakeMainnet = (async (_url: string, init?: RequestInit) => {
  rpcCalls += 1;
  const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
  if (body.method === 'getTokenAccountsByOwner') {
    const held = holdings.get(String(body.params[0]));
    const mintList = held === undefined ? [] : Array.isArray(held) ? held : [held];
    const value = mintList.map((mint) => (
      { account: { data: { parsed: { info: { mint, tokenAmount: { amount: '1', decimals: 0 } } } } } }
    ));
    return { ok: true, json: async () => ({ result: { value } }) } as Response;
  }
  // Mint reads are BATCHED (a Seeker whose wallet holds >100 assets must still
  // be found — 2026-07-29 review, finding (b)). ANS reverse records are read
  // through the same method, base64-encoded, so they are served first.
  if (body.method === 'getMultipleAccounts') {
    const value = (body.params[0] as string[]).map((m) => {
      const ans = nameAccounts.get(m);
      return ans ? { data: [ans, 'base64'] } : (mints.get(m) ?? null);
    });
    return { ok: true, json: async () => ({ result: { value } }) } as Response;
  }
  // The discovery scan: apply the real memcmp filters over every stored ANS
  // record, so the test proves the server's filters — not a canned answer —
  // are what keep foreign owners and foreign TLDs out of the candidate set.
  if (body.method === 'getProgramAccounts') {
    gpaCalls += 1;
    const cfg = (body.params[1] ?? {}) as {
      dataSlice?: { offset: number; length: number };
      filters?: { memcmp?: { offset: number; bytes: string } }[];
    };
    const result: unknown[] = [];
    for (const [pubkey, b64] of nameAccounts) {
      const buf = Buffer.from(b64, 'base64');
      const matches = (cfg.filters ?? []).every((f) => {
        if (!f.memcmp) return true;
        const want = Buffer.from(bs58.decode(f.memcmp.bytes));
        return buf.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
      });
      if (!matches) continue;
      const slice = cfg.dataSlice
        ? buf.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length)
        : buf;
      result.push({ pubkey, account: { data: [slice.toString('base64'), 'base64'] } });
    }
    return { ok: true, json: async () => ({ result }) } as Response;
  }
  if (body.method === 'getAccountInfo') {
    const addr = String(body.params[0]);
    const ans = nameAccounts.get(addr);
    if (ans) return { ok: true, json: async () => ({ result: { value: { data: [ans, 'base64'] } } }) } as Response;
    return { ok: true, json: async () => ({ result: { value: mints.get(addr) ?? null } }) } as Response;
  }
  return { ok: true, json: async () => ({ result: null }) } as Response;
}) as unknown as typeof fetch;

/** Mainnet is down. Distinct from "holds nothing" — the whole outage policy. */
const deadMainnet = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
const liveDeps: LinkDeps = { mainnetRpcUrl: 'https://fake-mainnet.test', fetchImpl: fakeMainnet };
const deadDeps: LinkDeps = { mainnetRpcUrl: 'https://fake-mainnet.test', fetchImpl: deadMainnet };

beforeAll(async () => {
  conn = connectTestDb();
  app = await buildApp(
    { ...TEST_CONFIG, SOLANA_MAINNET_RPC_URL: 'https://fake-mainnet.test' },
    conn.db,
    { seekerFetch: fakeMainnet },
  );
  await app.ready();
});

// Every automatic gate probe and every manual link verify spends from the GLOBAL
// ceiling (SEEKER.autoDetectGlobalPerMin). Reset it per test so this file's
// dozens of probes can't starve an unrelated case into a 503/skip — the
// ceiling's own semantics are pinned by the dedicated budget tests, which
// exhaust and reset it inside a single case.
beforeEach(() => resetAutoDetectBudget());

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

async function makeKeypair() {
  const secretKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(secretKey);
  return { secretKey, wallet: bs58.encode(publicKey) };
}

async function sign(message: string, secretKey: Uint8Array): Promise<string> {
  return bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
}

/** Sign in for real (challenge → verify) and return the session cookie. */
async function login(kp: { secretKey: Uint8Array; wallet: string }): Promise<string> {
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
  expect(ch.statusCode).toBe(200);
  const verify = await app.inject({
    method: 'POST', url: '/auth/verify',
    payload: { wallet: kp.wallet, signature: await sign(ch.json().message, kp.secretKey) },
  });
  expect(verify.statusCode).toBe(200);
  return verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}

/** A signed-in player. */
async function newPlayer() {
  const kp = await makeKeypair();
  const cookie = await login(kp);
  return { ...kp, cookie };
}

/** Give `wallet` a genuine SGT on the fake mainnet. */
function grantSgt(wallet: string, mint = REAL_MINT, memberNumber = 76095): void {
  holdings.set(wallet, mint);
  mints.set(mint, sgtMintAccount(memberNumber));
}

/**
 * Publish a REAL ANS record for `label`.skr owned by `owner` — the name account
 * PDA and the 121-byte NameRecordHeader layout are the production ones, so the
 * server resolves this exactly as it would resolve mainnet. That matters: the
 * whole point of F1 is that a domain can be genuinely, provably owned and still
 * be an unacceptable username.
 */
function grantSkr(owner: string, label: string, createdAtSec = 1_700_000_000): string {
  const buf = Buffer.alloc(SEEKER.skr.nameRecordByteSize); // the full 200-byte header
  new PublicKey(SEEKER.skr.parentNameAccount).toBuffer().copy(buf, 8);
  Buffer.from(bs58.decode(owner)).copy(buf, 40);
  // nclass 32 zeros @72, expiresAt 0 ("never") @104, createdAt @112, flag @120
  buf.writeBigUInt64LE(BigInt(createdAtSec), 112);
  const nameAccount = deriveSkrNameAccount(label);
  nameAccounts.set(nameAccount, buf.toString('base64'));
  // The on-chain REVERSE record: raw label after the 200-byte header. Its
  // header is all zeros, so the gPA parent/owner filters can never return it
  // as a forward domain — exactly like mainnet, where its parent differs.
  nameAccounts.set(
    deriveSkrReverseAccount(nameAccount),
    Buffer.concat([Buffer.alloc(SEEKER.skr.nameRecordByteSize), Buffer.from(label)]).toString('base64'),
  );
  return `${label}.skr`;
}

/** Link, offering `skrDomain` for adoption as the username. */
async function linkWithSkr(
  player: { cookie: string }, seeker: { secretKey: Uint8Array; wallet: string }, skrDomain: string,
) {
  const ch = await app.inject({
    method: 'POST', url: '/seeker/link/challenge',
    cookies: { [SESSION_COOKIE]: player.cookie }, payload: { seekerWallet: seeker.wallet },
  });
  expect(ch.statusCode).toBe(200);
  return app.inject({
    method: 'POST', url: '/seeker/link/verify',
    cookies: { [SESSION_COOKIE]: player.cookie },
    payload: {
      seekerWallet: seeker.wallet, skrDomain,
      signature: await sign(ch.json().message, seeker.secretKey),
    },
  });
}

/** Age the link so the next read treats the verdict as expired. */
async function ageLink(wallet: string): Promise<Date> {
  const stale = new Date(Date.now() - (SEEKER.recheckHours + 1) * 3_600_000);
  await conn.db.update(seekerLinks).set({ lastCheckedAt: stale }).where(eq(seekerLinks.wallet, wallet));
  return stale;
}

const badgeOf = async (wallet: string): Promise<boolean> => {
  const [row] = await conn.db.select().from(players).where(eq(players.wallet, wallet));
  return row!.seekerVerified;
};

/** Full happy-path link: challenge → sign with the SEEKER key → verify.
 *  `on` lets a test drive a differently-CONFIGURED server (e.g. two sources)
 *  against the same database. */
async function linkSeeker(
  player: { cookie: string }, seeker: { secretKey: Uint8Array; wallet: string },
  on: FastifyInstance = app,
) {
  const ch = await on.inject({
    method: 'POST', url: '/seeker/link/challenge',
    cookies: { [SESSION_COOKIE]: player.cookie },
    payload: { seekerWallet: seeker.wallet },
  });
  expect(ch.statusCode).toBe(200);
  return on.inject({
    method: 'POST', url: '/seeker/link/verify',
    cookies: { [SESSION_COOKIE]: player.cookie },
    payload: { seekerWallet: seeker.wallet, signature: await sign(ch.json().message, seeker.secretKey) },
  });
}

describe('Seeker link — proof of ownership', () => {
  it('binds a wallet that holds a real SGT and signs the challenge', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    const mint = `MINT-ok-${seeker.wallet.slice(0, 8)}`;
    grantSgt(seeker.wallet, mint, 4242);

    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(200);
    expect(res.json().seeker).toMatchObject({
      linked: true, seekerWallet: seeker.wallet, sgtMint: mint, memberNumber: 4242, stale: false,
    });

    // The badge is mirrored onto players for the hot roster reads.
    const [row] = await conn.db.select().from(players).where(eq(players.wallet, p.wallet));
    expect(row!.seekerVerified).toBe(true);
    // …and /me exposes it, so the client never has to guess.
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: p.cookie } });
    expect(me.json().seeker.linked).toBe(true);
    expect(me.json().seeker.memberNumber).toBe(4242);
  });

  it('an UNPROVEN wallet cannot bind — no signature means no badge', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-unproven-${seeker.wallet.slice(0, 8)}`);

    // Challenge issued, but the attacker signs with their OWN key, not the
    // Seeker's. Holding an SGT is not enough; you must control the wallet.
    const ch = await app.inject({
      method: 'POST', url: '/seeker/link/challenge',
      cookies: { [SESSION_COOKIE]: p.cookie }, payload: { seekerWallet: seeker.wallet },
    });
    const res = await app.inject({
      method: 'POST', url: '/seeker/link/verify',
      cookies: { [SESSION_COOKIE]: p.cookie },
      payload: { seekerWallet: seeker.wallet, signature: await sign(ch.json().message, p.secretKey) },
    });
    expect(res.statusCode).toBe(401);

    const links = await conn.db.select().from(seekerLinks).where(eq(seekerLinks.wallet, p.wallet));
    expect(links).toHaveLength(0);
  });

  it('skipping the challenge entirely is rejected', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-nochal-${seeker.wallet.slice(0, 8)}`);
    const res = await app.inject({
      method: 'POST', url: '/seeker/link/verify',
      cookies: { [SESSION_COOKIE]: p.cookie },
      payload: { seekerWallet: seeker.wallet, signature: await sign('anything', seeker.secretKey) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a wallet holding only a LOOK-ALIKE mint gets no badge (client claim is worthless)', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    const fake = `MINT-fake-${seeker.wallet.slice(0, 8)}`;
    const acct = sgtMintAccount();
    acct.data.parsed.info.mintAuthority = 'GTfakefakefakefakefakefakefakefakefakefake1';
    holdings.set(seeker.wallet, fake);
    mints.set(fake, acct);

    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(404); // no_sgt
    const [row] = await conn.db.select().from(players).where(eq(players.wallet, p.wallet));
    expect(row!.seekerVerified).toBe(false);
  });

  it('the SAME SGT cannot bind twice — one device, one account', async () => {
    const shared = `MINT-shared-${Date.now()}`;
    const a = await newPlayer();
    const seekerA = await makeKeypair();
    grantSgt(seekerA.wallet, shared);
    expect((await linkSeeker(a, seekerA)).statusCode).toBe(200);

    // A second account, a second wallet — but the same physical token. Moving
    // the SGT to a fresh wallet is exactly the sybil attempt this blocks.
    const b = await newPlayer();
    const seekerB = await makeKeypair();
    holdings.set(seekerB.wallet, shared);
    const res = await linkSeeker(b, seekerB);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/already linked/i);

    const [rowB] = await conn.db.select().from(players).where(eq(players.wallet, b.wallet));
    expect(rowB!.seekerVerified).toBe(false);
  });

  it('unlink drops the badge but KEEPS the mint claimed, so relinking elsewhere still fails', async () => {
    const mint = `MINT-unlink-${Date.now()}`;
    const a = await newPlayer();
    const seekerA = await makeKeypair();
    grantSgt(seekerA.wallet, mint);
    expect((await linkSeeker(a, seekerA)).statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: '/seeker/link', cookies: { [SESSION_COOKIE]: a.cookie } });
    expect(del.statusCode).toBe(200);
    const [rowA] = await conn.db.select().from(players).where(eq(players.wallet, a.wallet));
    expect(rowA!.seekerVerified).toBe(false);

    const b = await newPlayer();
    const seekerB = await makeKeypair();
    holdings.set(seekerB.wallet, mint);
    expect((await linkSeeker(b, seekerB)).statusCode).toBe(409);
  });

  it('FAILS CLOSED with 503 (and writes nothing) when mainnet is unconfigured', async () => {
    const offline = await buildApp(TEST_CONFIG, conn.db, { seekerFetch: fakeMainnet }); // no SOLANA_MAINNET_RPC_URL
    await offline.ready();
    try {
      const kp = await makeKeypair();
      const ch = await offline.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
      const v = await offline.inject({
        method: 'POST', url: '/auth/verify',
        payload: { wallet: kp.wallet, signature: await sign(ch.json().message, kp.secretKey) },
      });
      const cookie = v.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
      const seeker = await makeKeypair();
      grantSgt(seeker.wallet, `MINT-503-${seeker.wallet.slice(0, 8)}`);

      const chal = await offline.inject({
        method: 'POST', url: '/seeker/link/challenge',
        cookies: { [SESSION_COOKIE]: cookie }, payload: { seekerWallet: seeker.wallet },
      });
      const res = await offline.inject({
        method: 'POST', url: '/seeker/link/verify',
        cookies: { [SESSION_COOKIE]: cookie },
        payload: { seekerWallet: seeker.wallet, signature: await sign(chal.json().message, seeker.secretKey) },
      });
      expect(res.statusCode).toBe(503);
      const links = await conn.db.select().from(seekerLinks).where(eq(seekerLinks.wallet, kp.wallet));
      expect(links).toHaveLength(0);
    } finally {
      await offline.close();
    }
  });

  // The two tests below exercise `eq(authNonces.purpose, 'signin')` in
  // /auth/verify. Deleting that one line must break them BOTH — the previous
  // version of this test passed without it, because signing the LINK message
  // and posting it to /auth/verify fails on the signature check (a different
  // message is rebuilt there) whether or not the nonce is scoped. The guard was
  // untested (security review F7).
  it('a link NONCE can never mint a session — the takeover needs only the nonce, not the message', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-scope-${seeker.wallet.slice(0, 8)}`);
    const chal = await app.inject({
      method: 'POST', url: '/seeker/link/challenge',
      cookies: { [SESSION_COOKIE]: p.cookie }, payload: { seekerWallet: seeker.wallet },
    });
    expect(chal.statusCode).toBe(200);

    // The attack: take the PENDING link nonce and sign the sign-in message that
    // /auth/verify would rebuild from it. Nothing about the link message is
    // needed. Unscoped, that SELECT hands back this row and the signature
    // verifies — a link challenge would be a session-minting primitive for the
    // Seeker wallet.
    const [row] = await conn.db.select().from(authNonces)
      .where(eq(authNonces.nonce, chal.json().nonce as string));
    const forged = buildSignInMessage({
      domain: new URL(TEST_CONFIG.WEB_ORIGIN[0]!).host,
      wallet: seeker.wallet, nonce: row!.nonce, issuedAt: row!.issuedAt,
    });
    const takeover = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet: seeker.wallet, signature: await sign(forged, seeker.secretKey) },
    });
    expect(takeover.statusCode).toBe(401);
    expect(takeover.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    // …and the nonce is still unspent, i.e. it was never even considered here.
    const [after] = await conn.db.select().from(authNonces).where(eq(authNonces.id, row!.id));
    expect(after!.usedAt).toBeNull();
  });

  it('a pending link challenge does not lock the same wallet OUT of signing in', async () => {
    // The other half of the scope: /auth/verify takes the LATEST nonce for a
    // wallet. A Seeker wallet that is also a game account would have its own
    // sign-in shadowed by its newer link challenge — unscoped, this 401s.
    const kp = await makeKeypair();
    const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: kp.wallet } });
    expect(ch.statusCode).toBe(200);

    const other = await newPlayer();
    await new Promise((r) => setTimeout(r, 5)); // ensure a strictly later issuedAt
    const link = await app.inject({
      method: 'POST', url: '/seeker/link/challenge',
      cookies: { [SESSION_COOKIE]: other.cookie }, payload: { seekerWallet: kp.wallet },
    });
    expect(link.statusCode).toBe(200);

    const verify = await app.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet: kp.wallet, signature: await sign(ch.json().message, kp.secretKey) },
    });
    expect(verify.statusCode).toBe(200);
  });

  it('unlink → RE-link the same token to the SAME account succeeds (F3: not a life sentence)', async () => {
    const mint = `MINT-relink-${Date.now()}`;
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, mint);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);
    expect((await app.inject({
      method: 'DELETE', url: '/seeker/link', cookies: { [SESSION_COOKIE]: p.cookie },
    })).statusCode).toBe(200);
    expect(await badgeOf(p.wallet)).toBe(false);

    // Same person, same device, same account. Refusing this is a permanent
    // lockout with no security benefit: the mint is already bound to THEM.
    const again = await linkSeeker(p, seeker);
    expect(again.statusCode).toBe(200);
    expect(again.json().seeker).toMatchObject({ linked: true, sgtMint: mint });
    expect(await badgeOf(p.wallet)).toBe(true);
    // Exactly one row — revival, not a second claim on the mint.
    const rows = await conn.db.select().from(seekerLinks).where(eq(seekerLinks.sgtMint, mint));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).toBeNull();
  });

  it('a relink with a DIFFERENT token is still refused — the row cannot change mints', async () => {
    const p = await newPlayer();
    const seekerA = await makeKeypair();
    grantSgt(seekerA.wallet, `MINT-first-${Date.now()}`);
    expect((await linkSeeker(p, seekerA)).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: '/seeker/link', cookies: { [SESSION_COOKIE]: p.cookie } });

    // Re-pointing the row at a second, unclaimed SGT would RELEASE the first,
    // letting one device badge account after account.
    const seekerB = await makeKeypair();
    grantSgt(seekerB.wallet, `MINT-second-${Date.now()}`);
    const res = await linkSeeker(p, seekerB);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/different Seeker Genesis Token/i);
    expect(await badgeOf(p.wallet)).toBe(false);
  });
});

describe('Seeker badge expiry (F4/F5) — a verdict is rented, not owned', () => {
  it('re-verifies a STALE badge on a PLAIN read: selling the SGT drops it with no cron, no refresh flag', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-stale-${Date.now()}`);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);
    expect(await badgeOf(p.wallet)).toBe(true);

    await ageLink(p.wallet);
    holdings.delete(seeker.wallet); // sold the device

    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: p.cookie } });
    expect(me.json().seeker.linked).toBe(false);
    // The badge every OTHER player sees (map roster, raid log, clan roster) is
    // the denormalized column — it is the one that must go dark.
    expect(await badgeOf(p.wallet)).toBe(false);
  });

  it('a verdict inside the recheck window is REUSED — 25 refreshes cost ZERO mainnet calls', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-budget-${Date.now()}`);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);

    const before = rpcCalls;
    for (let i = 0; i < 25; i += 1) {
      const res = await app.inject({
        url: '/seeker/status?refresh=1', cookies: { [SESSION_COOKIE]: p.cookie },
      });
      expect(res.json().linked).toBe(true);
    }
    // The PoC behind F4: 25 requests → 50 mainnet calls. The window is the fix;
    // the route rate limit is the backstop (and is disabled under NODE_ENV=test).
    expect(rpcCalls - before).toBe(0);
  });

  it('an unreachable mainnet HIDES a stale badge but never revokes the link', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    const mint = `MINT-outage-${Date.now()}`;
    grantSgt(seeker.wallet, mint);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);
    await ageLink(p.wallet);

    const t0 = new Date();
    const down = await recheckSeeker(conn.db, deadDeps, p.wallet, t0);
    // Fail CLOSED: we have no proof inside the budget, so the public badge goes
    // dark…
    expect(await badgeOf(p.wallet)).toBe(false);
    expect(down.stale).toBe(true);
    // …but an outage is not evidence of a sale, so the LINK survives untouched —
    // otherwise the mint would be released and the account would have to re-earn
    // an identity because someone else's server had a bad minute.
    const [row] = await conn.db.select().from(seekerLinks).where(eq(seekerLinks.wallet, p.wallet));
    expect(row!.revokedAt).toBeNull();
    expect(row!.sgtMint).toBe(mint);

    // Mainnet returns (after the failure back-off) → the badge lights back up
    // with no user action.
    const back = await recheckSeeker(
      conn.db, liveDeps, p.wallet, new Date(t0.getTime() + (SEEKER.recheckBackoffMin + 1) * 60_000),
    );
    expect(back.linked).toBe(true);
    expect(back.stale).toBe(false);
    expect(await badgeOf(p.wallet)).toBe(true);
  });

  it('a FRESH badge is never revoked by a transient error — mainnet is not even asked', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-fresh-${Date.now()}`);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);

    const before = rpcCalls;
    const status = await recheckSeeker(conn.db, deadDeps, p.wallet);
    expect(status.linked).toBe(true);
    expect(status.stale).toBe(false);
    expect(await badgeOf(p.wallet)).toBe(true);
    expect(rpcCalls - before).toBe(0);
  });
});

/**
 * WHY: the badge is an anti-sybil claim built entirely from what a third-party
 * RPC says. It used to rest on ONE unauthenticated response, with no second
 * opinion and no confirmation — the push-based deed watcher this replaced
 * demanded N consecutive confirmations (2026-07-29 review, finding (a)).
 */
describe('Seeker verification sources — one indexer is not proof', () => {
  const SECOND_RPC = 'https://fake-mainnet-2.test';

  /** A second endpoint that sees the SAME chain as the first. */
  const twoSourceConfig = {
    ...TEST_CONFIG, SOLANA_MAINNET_RPC_URL: 'https://fake-mainnet.test',
    SOLANA_MAINNET_RPC_URL_2: SECOND_RPC,
  };
  /** A second endpoint that says every wallet is empty — i.e. it disagrees. */
  const conflicting = (async (url: string, init?: RequestInit) => {
    if (url === SECOND_RPC) {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === 'getTokenAccountsByOwner') {
        return { ok: true, json: async () => ({ result: { value: [] } }) } as Response;
      }
    }
    return (fakeMainnet as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;

  it('a SINGLE-SOURCE deployment still links, but the response admits it is unconfirmed', async () => {
    // Degrading honestly beats pretending: the operator may not have a second
    // provider yet, and the client must be able to show that.
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-1src-${Date.now()}`);

    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(200);
    expect(res.json().seeker).toMatchObject({ linked: true, verificationSources: 1, unconfirmed: true });
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: p.cookie } });
    expect(me.json().seeker.unconfirmed).toBe(true);
  });

  it('two AGREEING sources produce a confirmed badge', async () => {
    const two = await buildApp(twoSourceConfig, conn.db, { seekerFetch: fakeMainnet });
    await two.ready();
    try {
      const p = await newPlayer();
      const seeker = await makeKeypair();
      grantSgt(seeker.wallet, `MINT-2src-${Date.now()}`);

      const res = await linkSeeker(p, seeker, two);
      expect(res.statusCode).toBe(200);
      expect(res.json().seeker).toMatchObject({ verificationSources: 2, unconfirmed: false });
      expect(await badgeOf(p.wallet)).toBe(true);
    } finally {
      await two.close();
    }
  });

  it('a DISAGREEING second source grants NO badge and writes nothing', async () => {
    // The attack: one hijacked/spoofed endpoint answering "yes, this wallet
    // holds the SGT". With a cross-check that is no longer sufficient.
    const conflicted = await buildApp(twoSourceConfig, conn.db, { seekerFetch: conflicting });
    await conflicted.ready();
    try {
      const p = await newPlayer();
      const seeker = await makeKeypair();
      grantSgt(seeker.wallet, `MINT-conflict-${Date.now()}`);

      const res = await linkSeeker(p, seeker, conflicted);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.message).toMatch(/disagree/i);
      // Not "you own nothing" (404) and not a badge: we simply cannot say.
      expect(await conn.db.select().from(seekerLinks).where(eq(seekerLinks.wallet, p.wallet))).toHaveLength(0);
      expect(await badgeOf(p.wallet)).toBe(false);
    } finally {
      await conflicted.close();
    }
  });

  it('a disagreement on RE-CHECK hides the badge but never revokes the link', async () => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    const mint = `MINT-recheck-conflict-${Date.now()}`;
    grantSgt(seeker.wallet, mint);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);
    await ageLink(p.wallet);

    const conflictDeps: LinkDeps = {
      mainnetRpcUrl: 'https://fake-mainnet.test', mainnetRpcUrlSecondary: SECOND_RPC,
      fetchImpl: conflicting,
    };
    const out = await recheckSeeker(conn.db, conflictDeps, p.wallet);
    // We cannot vouch, so the public badge goes dark…
    expect(await badgeOf(p.wallet)).toBe(false);
    expect(out.stale).toBe(true);
    // …but "the sources disagree" is not evidence of a sale: revoking here would
    // release the mint on the word of a possibly-lying endpoint.
    const [row] = await conn.db.select().from(seekerLinks).where(eq(seekerLinks.wallet, p.wallet));
    expect(row!.revokedAt).toBeNull();
    expect(row!.sgtMint).toBe(mint);
  });

  it('a Seeker whose wallet holds 250 OTHER tokens is still verified', async () => {
    // finding (b): the mint reads were capped at 12 and issued one at a time, so
    // a Seeker who also collects NFTs was told "no Seeker Genesis Token in that
    // wallet". They bought the device; the game denied it.
    const p = await newPlayer();
    const seeker = await makeKeypair();
    const mint = `MINT-crowded-${Date.now()}`;
    mints.set(mint, sgtMintAccount(7777));
    const junk = Array.from({ length: 250 }, (_, i) => `JUNK-${i}-${Date.now()}`);
    for (const m of junk) mints.set(m, null);

    // A wallet whose SGT sits behind 250 unrelated 1-of-1s.
    const crowded = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === 'getTokenAccountsByOwner' && String(body.params[0]) === seeker.wallet) {
        const value = [...junk, mint].map((m) => ({
          account: { data: { parsed: { info: { mint: m, tokenAmount: { amount: '1', decimals: 0 } } } } },
        }));
        return { ok: true, json: async () => ({ result: { value } }) } as Response;
      }
      return (fakeMainnet as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const crowdedApp = await buildApp(
      { ...TEST_CONFIG, SOLANA_MAINNET_RPC_URL: 'https://fake-mainnet.test' },
      conn.db, { seekerFetch: crowded },
    );
    await crowdedApp.ready();
    try {
      const res = await linkSeeker(p, seeker, crowdedApp);
      expect(res.statusCode).toBe(200);
      expect(res.json().seeker).toMatchObject({ linked: true, sgtMint: mint, memberNumber: 7777 });
    } finally {
      await crowdedApp.close();
    }
  });
});

describe('usernames', () => {
  const patch = (cookie: string, name: string) =>
    app.inject({ method: 'PATCH', url: '/me', cookies: { [SESSION_COOKIE]: cookie }, payload: { name } });

  it('a Privy/social player with no external wallet can still set a username', async () => {
    // A Privy session is the SAME SIWS session, just with an embedded wallet
    // that can never hold an SGT. Identity must not require hardware.
    const p = await newPlayer();
    const res = await patch(p.cookie, `Privy_${Date.now().toString(36)}`);
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: p.cookie } });
    expect(me.json().name).toBe(res.json().name);
    expect(me.json().seeker.linked).toBe(false); // no badge — and that's fine
  });

  it('rejects a name outside the shared length bounds', async () => {
    const p = await newPlayer();
    expect((await patch(p.cookie, 'ab')).statusCode).toBe(400);
    expect((await patch(p.cookie, 'a'.repeat(USERNAMES.maxLen + 1))).statusCode).toBe(400);
  });

  it('rejects spaces and dots so a self-chosen name can never look like an x.skr', async () => {
    const p = await newPlayer();
    expect((await patch(p.cookie, 'space name')).statusCode).toBe(400);
    expect((await patch(p.cookie, 'torqueond.skr')).statusCode).toBe(400);
    expect((await patch(p.cookie, 'wat!!')).statusCode).toBe(400);
  });

  it('rejects reserved system names (an "ADMIN" in the raid log is a phishing surface)', async () => {
    const p = await newPlayer();
    expect((await patch(p.cookie, 'Admin')).statusCode).toBe(409);
    expect((await patch(p.cookie, 'SUPPORT')).statusCode).toBe(409);
  });

  it('uniqueness is CASE-INSENSITIVE — nobody may re-skin another player name', async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    const name = `Uniq${Date.now().toString(36)}`;
    expect((await patch(a.cookie, name)).statusCode).toBe(200);
    const res = await patch(b.cookie, name.toUpperCase());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/taken/i);

    // …and the advisory check agrees, so the UI can say so before submitting.
    const chk = await app.inject({
      url: '/username/check', query: { name: name.toLowerCase() },
      cookies: { [SESSION_COOKIE]: b.cookie },
    });
    expect(chk.json()).toMatchObject({ available: false, reason: 'taken' });
  });

  it('enforces the rename cooldown, but re-saving the SAME name is a free no-op', async () => {
    const p = await newPlayer();
    const first = `Cool${Date.now().toString(36)}`;
    expect((await patch(p.cookie, first)).statusCode).toBe(200);

    // Idempotent re-save: must not burn the cooldown or 422.
    expect((await patch(p.cookie, first)).statusCode).toBe(200);

    const second = await patch(p.cookie, `${first}x`);
    expect(second.statusCode).toBe(422);
    expect(second.json().error.message).toMatch(/change your name again/i);

    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: p.cookie } });
    expect(me.json().name).toBe(first);
    expect(me.json().nameCooldownDays).toBe(USERNAMES.changeCooldownDays);
  });

  it('a legacy `.skr`-shaped key never squats the domain (F6: the proven owner can claim it)', async () => {
    // The old charset allowed dots, so a legacy display name could BE 'x.skr'.
    // Migration 0044 keys those rows off the '#' escape instead of the bare
    // name, which is what leaves the domain claimable by whoever can prove it.
    const label = `sq${Date.now().toString(36)}`;
    const squatter = await newPlayer();
    await conn.db.update(players).set({ name: `${label}.skr`, nameKey: `#${squatter.wallet}` })
      .where(eq(players.wallet, squatter.wallet));

    const owner = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-squat-${Date.now()}`);
    const res = await linkWithSkr(owner, seeker, grantSkr(seeker.wallet, label));
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(`${label}.skr`);
    // The squatter keeps their DISPLAY name — only the internal key moved.
    const [sq] = await conn.db.select().from(players).where(eq(players.wallet, squatter.wallet));
    expect(sq!.name).toBe(`${label}.skr`);
  });

  it('a rename is allowed again once the cooldown has elapsed', async () => {
    const p = await newPlayer();
    const first = `Aged${Date.now().toString(36)}`;
    expect((await patch(p.cookie, first)).statusCode).toBe(200);
    // Backdate past the window — the rule is time-based, not a one-shot latch.
    await conn.db.update(players)
      .set({ nameChangedAt: new Date(Date.now() - (USERNAMES.changeCooldownDays + 1) * 86_400_000) })
      .where(eq(players.wallet, p.wallet));
    expect((await patch(p.cookie, `${first}b`)).statusCode).toBe(200);
  });
});

/**
 * F1. The `.skr` adoption path used to skip EVERY check — reserved words,
 * length and charset — on the theory that an on-chain proof made the name
 * trustworthy. It does not: `.skr` is a purchasable namespace, so `support.skr`
 * beside a VERIFIED SEEKER badge is a phishing surface that the badge itself
 * lends credibility to, and ANS labels run to 63 characters.
 *
 * Every case below owns the domain for real (real PDA, real record, real
 * forward check) and must STILL be refused as a username — while the LINK
 * succeeds, because the badge is about the token, not the name. Failing the
 * other way (no badge for a Seeker with an awkward domain) would be a worse bug.
 */
describe('.skr adoption (F1) — provably owned is not the same as safe', () => {
  const adopt = async (label: string) => {
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-skr-${label.slice(0, 6)}-${Date.now()}`);
    const res = await linkWithSkr(p, seeker, grantSkr(seeker.wallet, label));
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: p.cookie } });
    return { res, me, wallet: p.wallet };
  };

  it('adopts a well-formed domain (the control — the feature still works)', async () => {
    const label = `sk${Date.now().toString(36)}`;
    const { res, me } = await adopt(label);
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(`${label}.skr`);
    expect(me.json().name).toBe(`${label}.skr`);
  });

  for (const [why, label] of [
    ['a RESERVED label', 'support'],
    ['an over-length domain', 'a'.repeat(USERNAMES.skrMaxLen + 1)],
    ['an illegal label (non-alphanumeric ends)', '-admin-'],
  ] as const) {
    it(`refuses ${why} — and the LINK still succeeds`, async () => {
      const { res, me, wallet } = await adopt(label);
      // The link is not collateral damage: verified, badged, and the domain is
      // still recorded (it IS theirs) — they just pick a name by hand.
      expect(res.statusCode).toBe(200);
      expect(res.json().seeker.linked).toBe(true);
      expect(await badgeOf(wallet)).toBe(true);
      // Adopt NOTHING. Not a truncated name, not a suffixed one — nothing.
      expect(res.json().username).toBeNull();
      expect(me.json().name).toBe('');
      const [row] = await conn.db.select().from(players).where(eq(players.wallet, wallet));
      expect(row!.nameKey).toBe('');
    });
  }
});

/**
 * `.skr` AUTO-DISCOVERY: linking with a BLANK domain field asks mainnet which
 * `.skr` the wallet owns and adopts it. WHY this block exists: discovery turns
 * unauthenticated RPC answers into a username with no human in the loop, so
 * every test pins one way that pipeline could either assign a name the wallet
 * does not own, spend RPC on a non-Seeker, or clobber an identity the player
 * already chose.
 */
describe('.skr auto-discovery — the wallet types nothing', () => {
  it('a blank link auto-adopts the owned .skr and never spends the rename', async () => {
    // The headline feature: no typed domain, one owned .skr → that IS the
    // username. nameChangedAt must stay null — the player never chose this
    // name, so it must not burn their one rename (2026-07-29 defect class).
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-auto-${seeker.wallet.slice(0, 8)}`);
    const domain = grantSkr(seeker.wallet, `auto${Date.now().toString(36)}`);

    const res = await linkSeeker(p, seeker); // NOTE: no skrDomain in the payload
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(domain);
    expect(res.json().seeker.skrDomain).toBe(domain);
    const [row] = await conn.db.select().from(players).where(eq(players.wallet, p.wallet));
    expect(row!.name).toBe(domain);
    expect(row!.nameChangedAt).toBeNull();
  });

  it('an already-named player keeps their name; the domain is still recorded', async () => {
    // Discovery must never override an identity the player picked — the badge
    // block records the domain (it IS theirs) but the name is untouched.
    const p = await newPlayer();
    const chosen = `Keep${Date.now().toString(36)}`;
    await setUsername(conn.db, p.wallet, chosen);
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-named-${seeker.wallet.slice(0, 8)}`);
    const domain = grantSkr(seeker.wallet, `nm${Date.now().toString(36)}`);

    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBeNull();
    expect(res.json().seeker.skrDomain).toBe(domain);
    const [row] = await conn.db.select().from(players).where(eq(players.wallet, p.wallet));
    expect(row!.name).toBe(chosen);
  });

  it('a discovery outage degrades to the old blank-input outcome: linked + badge + no name', async () => {
    // `.skr` is decoration. If a dead discovery path could fail the LINK, a
    // naming nicety would become a badge outage — the exact inversion the
    // never-throw contract exists to prevent.
    const discoveryDead = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      // Discovery's methods die; the SGT reads (getTokenAccountsByOwner +
      // jsonParsed getMultipleAccounts) keep answering.
      if (body.method === 'getProgramAccounts' || body.method === 'getAccountInfo') {
        throw new Error('ECONNRESET');
      }
      return (fakeMainnet as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const partial = await buildApp(
      { ...TEST_CONFIG, SOLANA_MAINNET_RPC_URL: 'https://fake-mainnet.test' },
      conn.db, { seekerFetch: discoveryDead },
    );
    await partial.ready();
    try {
      const p = await newPlayer();
      const seeker = await makeKeypair();
      grantSgt(seeker.wallet, `MINT-ddead-${seeker.wallet.slice(0, 8)}`);
      grantSkr(seeker.wallet, `dd${Date.now().toString(36)}`);

      const res = await linkSeeker(p, seeker, partial);
      expect(res.statusCode).toBe(200);
      expect(res.json().seeker.linked).toBe(true);
      expect(res.json().username).toBeNull();
      expect(res.json().seeker.skrDomain).toBeNull();
      expect(await badgeOf(p.wallet)).toBe(true);
    } finally {
      await partial.close();
    }
  });

  it('a lying reverse record adopts NOTHING — the forward proof is the decider', async () => {
    // The reverse machinery only NOMINATES. Here the wallet's reverse record
    // is corrupted to nominate a label owned by SOMEONE ELSE; without the
    // forward closure this would hand one player another player's domain name.
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-liar-${seeker.wallet.slice(0, 8)}`);
    const tag = Date.now().toString(36);
    grantSkr(seeker.wallet, `real${tag}`);
    const victim = await makeKeypair();
    grantSkr(victim.wallet, `victim${tag}`);
    nameAccounts.set(
      deriveSkrReverseAccount(deriveSkrNameAccount(`real${tag}`)),
      Buffer.concat([
        Buffer.alloc(SEEKER.skr.nameRecordByteSize), Buffer.from(`victim${tag}`),
      ]).toString('base64'),
    );

    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(200);
    expect(res.json().seeker.linked).toBe(true);
    expect(res.json().username).toBeNull();
    expect(res.json().seeker.skrDomain).toBeNull();
  });

  it('several domains: the EARLIEST-created wins, tiebroken by name-account pubkey', async () => {
    // Deterministic across relinks, and "first .skr claimed" is the closest
    // proxy for the Seeker onboarding domain. If this drifted to registration
    // order or alphabet, a relink could silently rename the player.
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-multi-${seeker.wallet.slice(0, 8)}`);
    const tag = Date.now().toString(36);
    grantSkr(seeker.wallet, `t1${tag}`, 100);
    grantSkr(seeker.wallet, `t2${tag}`, 100);
    grantSkr(seeker.wallet, `aaearly${tag}`, 500); // alphabetically first, claimed LAST
    const winner = deriveSkrNameAccount(`t1${tag}`) < deriveSkrNameAccount(`t2${tag}`)
      ? `t1${tag}` : `t2${tag}`;

    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(`${winner}.skr`);
  });

  it('a discovered RESERVED label links but adopts nothing — F1 applies to discovery too', async () => {
    // Discovery must feed the SAME adoption gate as a typed domain: a wallet
    // that genuinely owns admin.skr still may not wear it beside the badge.
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-resv-${seeker.wallet.slice(0, 8)}`);
    const domain = grantSkr(seeker.wallet, 'admin');

    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(200);
    expect(res.json().seeker.linked).toBe(true);
    expect(res.json().username).toBeNull();
    // The domain IS theirs, so it is recorded — they just pick a name by hand.
    expect(res.json().seeker.skrDomain).toBe(domain);
    const [row] = await conn.db.select().from(players).where(eq(players.wallet, p.wallet));
    expect(row!.name).toBe('');
  });

  it('a typed domain beats discovery — and discovery is never even asked', async () => {
    // The typed field is now an OVERRIDE. If discovery ran anyway it could
    // out-vote the player's explicit choice, and would spend a gPA for nothing.
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-typed-${seeker.wallet.slice(0, 8)}`);
    const tag = Date.now().toString(36);
    grantSkr(seeker.wallet, `ea${tag}`, 100); // discovery would pick this one
    const typed = grantSkr(seeker.wallet, `la${tag}`, 500);

    const before = gpaCalls;
    const res = await linkWithSkr(p, seeker, typed);
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(typed);
    expect(gpaCalls - before).toBe(0);
  });

  it('no SGT ⇒ ZERO discovery RPC — gPA is never spent on a non-Seeker', async () => {
    // Ordering is the F4 defense: discovery sits strictly AFTER the SGT gate,
    // otherwise any signed-in wallet could bill us mainnet's most expensive
    // read just by attempting a link.
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSkr(seeker.wallet, `nosgt${Date.now().toString(36)}`); // a domain, but no SGT

    const before = rpcCalls;
    const beforeGpa = gpaCalls;
    const res = await linkSeeker(p, seeker);
    expect(res.statusCode).toBe(404);
    expect(gpaCalls - beforeGpa).toBe(0);
    // The ONLY mainnet read was the SGT holdings query itself.
    expect(rpcCalls - before).toBe(1);
  });

  it('POST /seeker/skr/adopt fills a null skrDomain later, and 404s when there is nothing to do', async () => {
    // A Seeker who registers their .skr AFTER linking must not have to unlink
    // and relink (that path is anti-sybil-guarded and signature-gated) just to
    // pick up a name.
    const stranger = await newPlayer();
    const unlinked = await app.inject({
      method: 'POST', url: '/seeker/skr/adopt', cookies: { [SESSION_COOKIE]: stranger.cookie },
    });
    expect(unlinked.statusCode).toBe(404);

    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-late-${seeker.wallet.slice(0, 8)}`);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200); // owns no .skr yet

    // The domain arrives after the link…
    const domain = grantSkr(seeker.wallet, `late${Date.now().toString(36)}`);
    const res = await app.inject({
      method: 'POST', url: '/seeker/skr/adopt', cookies: { [SESSION_COOKIE]: p.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().username).toBe(domain);
    expect(res.json().seeker.skrDomain).toBe(domain);
    const [row] = await conn.db.select().from(seekerLinks).where(eq(seekerLinks.wallet, p.wallet));
    expect(row!.skrDomain).toBe(domain);

    // Once a domain is on file the route has nothing to do — 404, so a client
    // cannot use it as a free re-discovery loop against mainnet.
    const again = await app.inject({
      method: 'POST', url: '/seeker/skr/adopt', cookies: { [SESSION_COOKIE]: p.cookie },
    });
    expect(again.statusCode).toBe(404);
  });
});

/**
 * F2. The 0044 backfill deduped legacy names as `k-2`, `k-3`… — a key a
 * DIFFERENT player could already hold, which made `CREATE UNIQUE INDEX` fail and
 * aborted the whole migration on live data.
 *
 * This replays the REAL statement (read from the migration file, so the test
 * cannot drift from what runs) over exactly that adversarial data, inside a
 * transaction that is rolled back. The index already exists here, so a
 * colliding scheme surfaces as a unique violation on the UPDATE instead of on
 * the CREATE — same root cause, same detection.
 */
describe('username backfill (migration 0044) — unique BY CONSTRUCTION', () => {
  it('survives duplicates, an existing `k-2`, a `#`-name and a `.skr` squatter', async () => {
    const sqlText = await readFile(new URL('../drizzle/0044_usernames_seeker.sql', import.meta.url), 'utf8');
    const backfill = sqlText.split('--> statement-breakpoint')
      .map((s) => s.trim())
      .find((s) => s.includes('SET "name_key"'));
    expect(backfill, 'the backfill statement must still be in 0044').toBeDefined();

    const tag = Date.now().toString(36);
    const seed = [
      { wallet: `bf1-${tag}`, name: 'k', createdAt: new Date(Date.now() - 40_000) },
      { wallet: `bf2-${tag}`, name: 'k', createdAt: new Date(Date.now() - 30_000) },
      { wallet: `bf3-${tag}`, name: 'k', createdAt: new Date(Date.now() - 20_000) },
      // The player the old scheme collided with.
      { wallet: `bf4-${tag}`, name: 'k-2', createdAt: new Date(Date.now() - 10_000) },
      // A legacy dotted name that would squat a real Seeker's domain (F6).
      { wallet: `bf5-${tag}`, name: 'torqueond.skr', createdAt: new Date(Date.now() - 9_000) },
      // A legacy name already wearing the escape character.
      { wallet: `bf6-${tag}`, name: `#bf2-${tag}`, createdAt: new Date(Date.now() - 8_000) },
    ];
    const wallets = seed.map((s) => s.wallet);

    class Rollback extends Error {}
    let after: { wallet: string; name: string; nameKey: string }[] = [];
    try {
      await conn.db.transaction(async (tx) => {
        await tx.insert(players).values(seed);
        await tx.execute(sql.raw(backfill!)); // ← would raise 23505 pre-fix
        after = await tx.select({ wallet: players.wallet, name: players.name, nameKey: players.nameKey })
          .from(players).where(inArray(players.wallet, wallets));
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }

    const key = (w: string): string => after.find((r) => r.wallet === w)!.nameKey;
    // The oldest holder keeps the bare key; everyone else lands in the '#'
    // namespace, which no username the game can ever write reaches.
    expect(key(`bf1-${tag}`)).toBe('k');
    expect(key(`bf4-${tag}`)).toBe('k-2'); // untouched — it was never a duplicate
    expect(key(`bf2-${tag}`)).toBe(`#bf2-${tag}`);
    expect(key(`bf3-${tag}`)).toBe(`#bf3-${tag}`);
    expect(key(`bf5-${tag}`)).toBe(`#bf5-${tag}`); // .skr never squats
    expect(key(`bf6-${tag}`)).toBe(`#bf6-${tag}`); // a '#' name cannot forge another's key
    expect(new Set(after.map((r) => r.nameKey)).size).toBe(seed.length);
    // Nobody's DISPLAY name changed. That was the promise of the fold.
    for (const s of seed) expect(after.find((r) => r.wallet === s.wallet)!.name).toBe(s.name);
  });
});

/**
 * WHY: Seekers enter the closed alpha with NO invite code (owner 2026-08-08),
 * detected by the cookie-authenticated gate probe from the session wallet —
 * SIWS already proved control, so no second signature challenge exists. Keeping
 * this mainnet read after session creation means an RPC can never strand every
 * fresh wallet on SIGNING IN. The
 * load-bearing property is that detection and CLAIMING are one atomic write:
 * the SGT is freely sellable, and an admission without a mint claim would let
 * one token admit every wallet it passes through between sign-ins.
 */
describe('closed-alpha gate auto-detection (owner 2026-08-08)', () => {
  const accessOf = async (wallet: string) => {
    const [row] = await conn.db.select().from(alphaAccess).where(eq(alphaAccess.wallet, wallet));
    return row ?? null;
  };
  const linkOf = async (wallet: string) => {
    const [row] = await conn.db.select().from(seekerLinks).where(eq(seekerLinks.wallet, wallet));
    return row ?? null;
  };
  const probe = (cookie: string) => app.inject({
    method: 'POST', url: '/alpha/seeker', cookies: { [SESSION_COOKIE]: cookie },
  });
  /** The negative cache blocks a re-probe for 24h; tests clear it explicitly. */
  const clearNegativeCache = async (wallet: string): Promise<void> => {
    await conn.db.update(players).set({ sgtCheckedAt: null }).where(eq(players.wallet, wallet));
  };

  it('probing WITH the SGT session links, badges, admits and names — no button, no code', async () => {
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    const mint = `MINT-auto-${Date.now()}`;
    grantSgt(kp.wallet, mint, 41);
    const skrLabel = `auto${Date.now().toString(36)}`;
    grantSkr(kp.wallet, skrLabel);

    const cookie = await login(kp);
    expect((await probe(cookie)).statusCode).toBe(200);

    // The claim is the manual link's claim, written by the same code path:
    // wallet = seekerWallet = the session wallet, mint claimed forever.
    const row = await linkOf(kp.wallet);
    expect(row).not.toBeNull();
    expect(row!.seekerWallet).toBe(kp.wallet);
    expect(row!.sgtMint).toBe(mint);
    expect(row!.revokedAt).toBeNull();
    expect(await badgeOf(kp.wallet)).toBe(true);
    // The closed-alpha grant rode the same transaction, marked as its own
    // source so ops can tell (and bulk-revoke) seeker admissions.
    expect((await accessOf(kp.wallet))?.source).toBe('seeker');
    // The proven .skr became the username, exactly like a manual link.
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.json().seeker.linked).toBe(true);
    expect(me.json().seeker.skrDomain).toBe(`${skrLabel}.skr`);
    expect(me.json().name).toBe(`${skrLabel}.skr`);
  });

  it('a linked wallet passes a later gate probe for FREE — zero mainnet reads', async () => {
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    grantSgt(kp.wallet, `MINT-auto-free-${Date.now()}`);
    expect((await probe(await login(kp))).statusCode).toBe(200);

    const before = rpcCalls;
    expect((await probe(await login(kp))).statusCode).toBe(200);
    expect(rpcCalls - before).toBe(0);
  });

  it('a non-holder is probed ONCE — the negative verdict is cached, not re-asked', async () => {
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    expect((await probe(await login(kp))).statusCode).toBe(200); // first probe: definitive "no"
    expect(await linkOf(kp.wallet)).toBeNull();

    const before = rpcCalls;
    expect((await probe(await login(kp))).statusCode).toBe(200);
    expect(rpcCalls - before).toBe(0); // the cache answered
    expect(await badgeOf(kp.wallet)).toBe(false);
    expect(await accessOf(kp.wallet)).toBeNull();
  });

  it('an SGT already claimed by another account admits NOBODY at the gate probe', async () => {
    // The hot-potato attack: account A links the token, then the token's
    // wallet signs in directly hoping for a second admission. The mint unique
    // index fires; sign-in still succeeds; nothing is granted.
    resetAutoDetectBudget();
    const gameAccount = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-auto-claimed-${Date.now()}`);
    expect((await linkSeeker(gameAccount, seeker)).statusCode).toBe(200);

    const cookie = await login(seeker); // sign the SGT wallet in directly
    expect(cookie).toBeTruthy(); // sign-in itself is never blocked
    expect((await probe(cookie)).statusCode).toBe(200);
    expect(await linkOf(seeker.wallet)).toBeNull();
    expect(await badgeOf(seeker.wallet)).toBe(false);
    expect(await accessOf(seeker.wallet)).toBeNull();
    // …and the original claim is untouched.
    expect((await linkOf(gameAccount.wallet))!.sgtMint).toContain('MINT-auto-claimed-');
    // The conflict stamped the negative cache: a farmed wallet re-signing in
    // must not re-bill the probe every time — the next sign-in is free.
    const [row] = await conn.db.select({ sgtCheckedAt: players.sgtCheckedAt })
      .from(players).where(eq(players.wallet, seeker.wallet));
    expect(row!.sgtCheckedAt).not.toBeNull();
    const before = rpcCalls;
    expect((await probe(await login(seeker))).statusCode).toBe(200);
    expect(rpcCalls - before).toBe(0);
  });

  it('an OUTAGE stamps nothing — a bad mainnet minute must not become a 24h denial', async () => {
    resetAutoDetectBudget();
    const p = await createTestPlayer(conn.db);
    grantSgt(p.wallet, `MINT-auto-outage-${Date.now()}`);

    const t0 = new Date();
    const down = await autoDetectSeeker(conn.db, deadDeps, p.wallet, t0);
    expect(down.linked).toBe(false);
    const [row] = await conn.db.select({ sgtCheckedAt: players.sgtCheckedAt })
      .from(players).where(eq(players.wallet, p.wallet));
    expect(row!.sgtCheckedAt).toBeNull(); // no answer is not an answer

    // Inside the failure backoff even a live mainnet is not re-asked…
    const stillDown = await autoDetectSeeker(conn.db, liveDeps, p.wallet, t0);
    expect(stillDown.linked).toBe(false);
    // …and past it, the same automatic-detection path claims successfully.
    const later = new Date(t0.getTime() + (SEEKER.recheckBackoffMin + 1) * 60_000);
    const up = await autoDetectSeeker(conn.db, liveDeps, p.wallet, later);
    expect(up.linked).toBe(true);
    expect((await accessOf(p.wallet))?.source).toBe('seeker');
  });

  it('the global probe ceiling defers detection instead of failing the session', async () => {
    resetAutoDetectBudget();
    // One FIXED timestamp for the whole exhaust phase: the ceiling's window is
    // keyed to the wall-clock minute, so calls riding real time would flake
    // whenever the minute rolled over mid-test.
    const t0 = new Date();
    const filler = await createTestPlayer(conn.db);
    // Spend the whole minute's budget on one wallet by clearing its cache.
    for (let i = 0; i < SEEKER.autoDetectGlobalPerMin; i += 1) {
      await autoDetectSeeker(conn.db, liveDeps, filler.wallet, t0);
      await clearNegativeCache(filler.wallet);
    }
    const p = await createTestPlayer(conn.db);
    grantSgt(p.wallet, `MINT-auto-budget-${Date.now()}`);
    const before = rpcCalls;
    const starved = await autoDetectSeeker(conn.db, liveDeps, p.wallet, t0);
    expect(starved.linked).toBe(false); // silently deferred…
    expect(rpcCalls - before).toBe(0); // …at zero mainnet cost
    expect(await linkOf(p.wallet)).toBeNull();

    // The next minute the window resets on its own — nothing was lost.
    const found = await autoDetectSeeker(
      conn.db, liveDeps, p.wallet, new Date(t0.getTime() + 61_000),
    );
    expect(found.linked).toBe(true);
  });

  it('the MANUAL link verify draws from the same ceiling — 503, not a free probe', async () => {
    // The link routes are pre-gate now, so this is the one path an attacker
    // could use to spend mainnet reads outside the auto-detect budget: any
    // keypair can sign in and self-sign link challenges at the IP rate limit.
    resetAutoDetectBudget();
    // Deterministic across the minute boundary: the route stamps its own
    // clock, so keep the whole exhaust+assert inside one wall-clock minute.
    while (new Date().getSeconds() > 54) await new Promise((r) => setTimeout(r, 1_000));
    const filler = await createTestPlayer(conn.db);
    for (let i = 0; i < SEEKER.autoDetectGlobalPerMin; i += 1) {
      await autoDetectSeeker(conn.db, liveDeps, filler.wallet);
      await clearNegativeCache(filler.wallet);
    }
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-manual-budget-${Date.now()}`);
    const before = rpcCalls;
    const starved = await linkSeeker(p, seeker);
    expect(starved.statusCode).toBe(503); // busy, retryable — never a silent skip
    expect(rpcCalls - before).toBe(0);

    resetAutoDetectBudget();
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);
  });

  it('with a cross-check configured, an UNCONFIRMED verdict admits nobody', async () => {
    // Admission bar = the manual route's bar (money review 2026-07-29 #4): a
    // deployment that CAN cross-check never grants on a single answer. And an
    // unconfirmed verdict is outage-equivalent — no negative stamp, so the
    // Seeker is not locked out for 24h by the cross-check's bad minute.
    resetAutoDetectBudget();
    let secondaryDown = true;
    const routed = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('fake-mainnet-2') && secondaryDown) throw new Error('ECONNRESET');
      return (fakeMainnet as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const splitDeps: LinkDeps = {
      mainnetRpcUrl: 'https://fake-mainnet.test',
      mainnetRpcUrlSecondary: 'https://fake-mainnet-2.test',
      fetchImpl: routed,
    };
    const p = await createTestPlayer(conn.db);
    grantSgt(p.wallet, `MINT-auto-2src-${Date.now()}`);

    const t0 = new Date();
    const degraded = await autoDetectSeeker(conn.db, splitDeps, p.wallet, t0);
    expect(degraded.linked).toBe(false);
    expect(await linkOf(p.wallet)).toBeNull();
    expect(await accessOf(p.wallet)).toBeNull();
    const [row] = await conn.db.select({ sgtCheckedAt: players.sgtCheckedAt })
      .from(players).where(eq(players.wallet, p.wallet));
    expect(row!.sgtCheckedAt).toBeNull();

    // Cross-check recovers → both agree → confirmed → admitted.
    secondaryDown = false;
    const later = new Date(t0.getTime() + (SEEKER.recheckBackoffMin + 1) * 60_000);
    const confirmed = await autoDetectSeeker(conn.db, splitDeps, p.wallet, later);
    expect(confirmed.linked).toBe(true);
    expect(confirmed.verificationSources).toBe(2);
    expect((await accessOf(p.wallet))?.source).toBe('seeker');
  });

  it('the negative cache EXPIRES — a wallet is re-probed after autoDetectRecheckHours', async () => {
    resetAutoDetectBudget();
    const p = await createTestPlayer(conn.db);
    const t0 = new Date();
    expect((await autoDetectSeeker(conn.db, liveDeps, p.wallet, t0)).linked).toBe(false);

    grantSgt(p.wallet, `MINT-auto-expiry-${Date.now()}`);
    const before = rpcCalls;
    const cached = await autoDetectSeeker(
      conn.db, liveDeps, p.wallet, new Date(t0.getTime() + 3_600_000),
    );
    expect(cached.linked).toBe(false); // inside the window: the "no" stands
    expect(rpcCalls - before).toBe(0);

    const reprobed = await autoDetectSeeker(
      conn.db, liveDeps, p.wallet,
      new Date(t0.getTime() + (SEEKER.autoDetectRecheckHours + 1) * 3_600_000),
    );
    expect(reprobed.linked).toBe(true); // a Seeker is never denied forever
  });

  it('ops revocation sticks even through REVIVAL — the grant is insert-once', async () => {
    // The seeker_links row is the redemption anchor (the invite system's
    // "revocation must win" property): re-proving the same token after ops
    // deleted the grant revives the BADGE, never the admission.
    resetAutoDetectBudget();
    const p = await createTestPlayer(conn.db);
    const mint = `MINT-auto-ban-${Date.now()}`;
    grantSgt(p.wallet, mint);
    expect((await autoDetectSeeker(conn.db, liveDeps, p.wallet)).linked).toBe(true);
    expect((await accessOf(p.wallet))?.source).toBe('seeker');

    await conn.db.delete(alphaAccess).where(eq(alphaAccess.wallet, p.wallet)); // ops ban
    // The token wanders off; the stale re-check revokes the link…
    holdings.delete(p.wallet);
    await ageLink(p.wallet);
    expect((await recheckSeeker(conn.db, liveDeps, p.wallet)).linked).toBe(false);
    // …then comes back, and the revival re-lights the badge only.
    grantSgt(p.wallet, mint);
    await clearNegativeCache(p.wallet);
    const revived = await autoDetectSeeker(conn.db, liveDeps, p.wallet);
    expect(revived.linked).toBe(true);
    expect(await badgeOf(p.wallet)).toBe(true);
    expect(await accessOf(p.wallet)).toBeNull(); // the ban held
  });

  it('a SECOND SGT in the wallet cannot spuriously revoke the linked one on re-check', async () => {
    // readSgtFrom answers in token-account order; before the expectedMint fix
    // a second (freely purchasable) SGT winning the race made the re-check
    // read "the token moved" and revoke a perfectly valid link.
    resetAutoDetectBudget();
    const p = await newPlayer();
    const seeker = await makeKeypair();
    const mintA = `MINT-multi-A-${Date.now()}`;
    const mintB = `MINT-multi-B-${Date.now()}`;
    grantSgt(seeker.wallet, mintA);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);

    mints.set(mintB, sgtMintAccount(2));
    holdings.set(seeker.wallet, [mintB, mintA]); // the OTHER one enumerates first
    await ageLink(p.wallet);
    const status = await recheckSeeker(conn.db, liveDeps, p.wallet);
    expect(status.linked).toBe(true);
    expect(status.sgtMint).toBe(mintA);
    expect(await badgeOf(p.wallet)).toBe(true);
  });

  it('UNLINK holds: the very next read must not silently re-link a same-wallet Seeker', async () => {
    // Auto-detect revives a revoked row for the same mint — which would have
    // turned the player's explicit UNLINK into a no-op on the next /me poll.
    // The unlink stamps the negative cache, so the choice holds for
    // autoDetectRecheckHours; after that, automatic detection is the designed
    // behavior again.
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    grantSgt(kp.wallet, `MINT-auto-unlink-${Date.now()}`);
    const cookie = await login(kp);
    expect((await probe(cookie)).statusCode).toBe(200);
    expect((await badgeOf(kp.wallet))).toBe(true);

    const res = await app.inject({
      method: 'DELETE', url: '/seeker/link', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.json().seeker.linked).toBe(false); // not instantly revived
    expect(await badgeOf(kp.wallet)).toBe(false);
  });

  it('the pre-gate seeker routes still demand a session — anonymity gets 401', async () => {
    // Moving them off app.authenticate removed the alpha gate, NOT the auth:
    // the cookie is still fully verified, and no cookie is still a hard no.
    const ch = await app.inject({
      method: 'POST', url: '/seeker/link/challenge', payload: { seekerWallet: (await makeKeypair()).wallet },
    });
    expect(ch.statusCode).toBe(401);
    const verify = await app.inject({
      method: 'POST', url: '/seeker/link/verify',
      payload: { seekerWallet: (await makeKeypair()).wallet, signature: bs58.encode(new Uint8Array(64)) },
    });
    expect(verify.statusCode).toBe(401);
    const probe = await app.inject({ method: 'POST', url: '/alpha/seeker', payload: {} });
    expect(probe.statusCode).toBe(401);
  });

  it('a revoked link REVIVES for the same mint on detection — and never for a different one', async () => {
    resetAutoDetectBudget();
    const p = await createTestPlayer(conn.db);
    const mint = `MINT-auto-revive-${Date.now()}`;
    grantSgt(p.wallet, mint);
    expect((await autoDetectSeeker(conn.db, liveDeps, p.wallet)).linked).toBe(true);

    // The token leaves (sold); the stale re-check revokes the badge.
    holdings.delete(p.wallet);
    await ageLink(p.wallet);
    expect((await recheckSeeker(conn.db, liveDeps, p.wallet)).linked).toBe(false);
    expect((await linkOf(p.wallet))!.revokedAt).not.toBeNull();

    // A DIFFERENT token in the same wallet must not revive the row — moving
    // the mint would release the old one for a second account to claim.
    grantSgt(p.wallet, `${mint}-other`);
    await clearNegativeCache(p.wallet);
    expect((await autoDetectSeeker(conn.db, liveDeps, p.wallet)).linked).toBe(false);
    expect((await linkOf(p.wallet))!.revokedAt).not.toBeNull();

    // The SAME token returning revives it — the same person, the same device.
    grantSgt(p.wallet, mint);
    await clearNegativeCache(p.wallet);
    const revived = await autoDetectSeeker(conn.db, liveDeps, p.wallet);
    expect(revived.linked).toBe(true);
    expect((await linkOf(p.wallet))!.revokedAt).toBeNull();
    expect(await badgeOf(p.wallet)).toBe(true);
  });

  it('GET /me picks up a Seeker whose cookie outlived their sign-in', async () => {
    // Session JWTs live 7 days and verify statelessly: a returning player may
    // not touch /auth/verify for a week. /me is the read they cannot avoid.
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    const cookie = await login(kp); // not a Seeker at sign-in time
    grantSgt(kp.wallet, `MINT-auto-me-${Date.now()}`);
    await clearNegativeCache(kp.wallet);

    const me = await app.inject({ url: '/me', cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.json().seeker.linked).toBe(true);
    expect((await accessOf(kp.wallet))?.source).toBe('seeker');
  });

  it('the alpha grant is STICKY: unlinking keeps the door open', async () => {
    // Chosen over badge-tracking on purpose: the badge fails CLOSED on RPC
    // outages, and a gate keyed to it would 403 every Seeker-admitted player
    // whenever mainnet has a bad hour. One token still admits one account ever
    // — the mint claim outlives the unlink.
    resetAutoDetectBudget();
    const kp = await makeKeypair();
    grantSgt(kp.wallet, `MINT-auto-sticky-${Date.now()}`);
    const cookie = await login(kp);
    expect((await probe(cookie)).statusCode).toBe(200);
    expect((await accessOf(kp.wallet))?.source).toBe('seeker');

    const res = await app.inject({
      method: 'DELETE', url: '/seeker/link', cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(await badgeOf(kp.wallet)).toBe(false);
    expect((await accessOf(kp.wallet))?.source).toBe('seeker'); // access survives
  });

  it('a MANUAL link grants the same sticky access — split-wallet Seekers are not second-class', async () => {
    resetAutoDetectBudget();
    const p = await newPlayer();
    const seeker = await makeKeypair();
    grantSgt(seeker.wallet, `MINT-manual-grant-${Date.now()}`);
    expect((await linkSeeker(p, seeker)).statusCode).toBe(200);
    expect((await accessOf(p.wallet))?.source).toBe('seeker');
  });
});

describe('adopting a .skr does not consume the rename', () => {
  it('a freshly-linked Seeker can immediately pick their own name', async () => {
    // Browser-verified defect 2026-07-29: adoption stamped nameChangedAt, so the
    // profile promised "changing it replaces it with a name you pick" while the
    // server answered "you can change your name again in 30 days" — in exactly
    // the window a Seeker most wants to replace an auto-assigned domain name.
    // The player never CHOSE the domain name, so it must not spend their rename.
    const p = await createTestPlayer(conn.db);
    await adoptSkrUsername(conn.db, p.wallet, 'vexlord.skr');
    const [afterAdopt] = await conn.db.select({ name: players.name, changed: players.nameChangedAt })
      .from(players).where(eq(players.wallet, p.wallet));
    expect(afterAdopt!.name).toBe('vexlord.skr');
    expect(afterAdopt!.changed).toBeNull(); // the rename clock never started

    // …and the very next action can be their own pick, with no cooldown error.
    const res = await setUsername(conn.db, p.wallet, 'MyOwnPick_1');
    expect(res.name).toBe('MyOwnPick_1');
  });
});
