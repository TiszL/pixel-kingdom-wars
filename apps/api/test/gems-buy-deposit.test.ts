/**
 * Get Gems from a wallet — the `gems_buy` deposit kind (E2-GEMS-CONTRACT §1.2
 * `gems.buy`, §2 `POST /deposits`, §4 flags, §7; GEMS-CURRENCY §4.4; K-150).
 *
 * WHY these pins exist:
 *  - A wallet-signed KEEP transfer is real money leaving a player's wallet. It
 *    must credit exactly once, only when it landed in the EMISSION-RESERVE ATA
 *    (never custody, never an auxiliary account), and it must credit whether
 *    or not the intent gate is still open — money moved is money honoured.
 *  - Every Gem minted by this rail is backed in the SAME ledger row by the
 *    KEEP observed on-chain (`onchain_inflow −k / emission_pool +k`), so G-3
 *    cannot be violated by a partial, dusty or replayed credit.
 *  - Sub-KEEP dust is disclosed, never rounded up; a transfer below 1 KEEP
 *    strands as paid-failed for ops instead of minting 0 or 1 Gems.
 *  - The flag and the destination gate intent creation and the advertised
 *    sources together: a source without a destination would invite transfers
 *    nothing can credit, and a destination is never advertised without the
 *    source (security review 2026-09-20 #3).
 *  - The reserve ATA and mint are FROZEN into the intent row (security review
 *    #1): verification proves the transfer against the row, so a rotated or
 *    unset GEMS_RESERVE_ATA can neither strand a paid intent nor let a transfer
 *    to a stale account credit. The env gates creation and advertising only.
 *  - A key whose row is no longer payable never comes back payable-looking
 *    (security review #2): 409 INTENT_TERMINAL, definitive, names the row.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { ECONOMY, GEMS, TOKEN } from '@shardkeep/shared';
import { keepAta } from '@shardkeep/chain';
import { Keypair, PublicKey, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { loadConfig } from '../src/config';
import { accounts, deposits, ledgerEntries, ledgerTransactions, players, sessions } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { createDepositIntent, creditDeposit } from '../src/money/deposits';
import { makeCombinedDepositCommitVerifier, makeCombinedDepositVerifier, verifyDepositNow } from '../src/money/depositWatcher';
import { gemsReserveAta } from '../src/money/economyIdentity';
import { bindGemsTestReserve, gemsTestAta, gemsTestHot, gemsTestMint, gemsTestOwner } from './gems-reserve-fixture';
import { depositMint } from '../src/money/mintDimension';
import { NativeCapabilitiesSchema } from '../src/native/contracts';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;

const UNIT = 10n ** BigInt(TOKEN.decimals);
const keepMint = gemsTestMint;
const hotWallet = gemsTestHot;
const hotAta = keepAta(hotWallet, keepMint);
const reserveOwner = gemsTestOwner;
const reserve = gemsTestAta;

// ---------------------------------------------------------------------------
// Fake finalized chain (house seam: no RPC in unit tests). A transaction is
// registered against the references it carries; the REAL @shardkeep/chain
// verifier then reads it exactly as it would read devnet.
// ---------------------------------------------------------------------------
interface FakeTx {
  signer: PublicKey;
  staticKeys: PublicKey[];
  loaded?: { writable: PublicKey[]; readonly: PublicKey[] };
  balances: Array<{ index: number; pre: bigint; post: bigint }>;
}
const byReference = new Map<string, string[]>();
const bySignature = new Map<string, FakeTx>();
const connection = {
  getSignaturesForAddress: async (ref: PublicKey) => (byReference.get(ref.toBase58()) ?? [])
    .map((signature) => ({ signature, err: null, blockTime: Math.floor(Date.now() / 1_000) + 60 })),
  getTransaction: async (signature: string) => {
    const t = bySignature.get(signature);
    if (!t) return null;
    const mint = keepMint.toBase58();
    return {
      transaction: { message: { staticAccountKeys: t.staticKeys } },
      meta: {
        err: null,
        ...(t.loaded ? { loadedAddresses: t.loaded } : {}),
        preTokenBalances: t.balances.map((b) => ({ accountIndex: b.index, mint, uiTokenAmount: { amount: b.pre.toString() } })),
        postTokenBalances: t.balances.map((b) => ({ accountIndex: b.index, mint, uiTokenAmount: { amount: b.post.toString() } })),
      },
    };
  },
} as unknown as Connection;

/** Land one KEEP transfer of `baseUnits` into `destination`, tagged with every reference given. */
function landTransfer(input: {
  signer: string; references: string[]; destination: PublicKey; baseUnits: bigint; viaLookupTable?: boolean;
}): string {
  const signature = bs58.encode(randomBytes(64));
  const signer = new PublicKey(input.signer);
  const refs = input.references.map((r) => new PublicKey(r));
  const tx: FakeTx = input.viaLookupTable
    ? { signer, staticKeys: [signer, ...refs], loaded: { writable: [input.destination], readonly: [] },
      balances: [{ index: 1 + refs.length, pre: 100n * UNIT, post: 100n * UNIT + input.baseUnits }] }
    : { signer, staticKeys: [signer, ...refs, input.destination],
      balances: [{ index: 1 + refs.length, pre: 100n * UNIT, post: 100n * UNIT + input.baseUnits }] };
  bySignature.set(signature, tx);
  for (const ref of input.references) byReference.set(ref, [...(byReference.get(ref) ?? []), signature]);
  return signature;
}

// No reserve ATA is handed to the verifiers: a gems_buy row carries its own
// frozen destination + mint, exactly like production (server.ts passes none).
const verifier = makeCombinedDepositVerifier(connection, { liquidity: null, hot: { keepMint, pubkey: hotWallet } });
const commitVerifier = makeCombinedDepositCommitVerifier(connection, { liquidity: null, hot: { keepMint, pubkey: hotWallet } });

// ---------------------------------------------------------------------------
// Env + app
// ---------------------------------------------------------------------------
const ENV_KEYS = ['GEMS_ENABLED', 'GEMS_WALLET_BUY_ENABLED', 'GEMS_RESERVE_ATA', 'MULTI_BASE_ENABLED'] as const;
const prior: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const setEnv = (key: string, value: string | undefined) => {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
};
const withEnv = async <T>(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => Promise<T>) => {
  const saved = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) setEnv(k, v);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) setEnv(k, v); }
};

beforeAll(async () => {
  for (const key of ENV_KEYS) prior[key] = process.env[key];
  process.env['GEMS_ENABLED'] = 'true';
  process.env['GEMS_WALLET_BUY_ENABLED'] = 'true';
  process.env['GEMS_RESERVE_ATA'] = reserve.toBase58();
  process.env['MULTI_BASE_ENABLED'] = 'false';
  await bootstrapSystemAccounts(db);
  await bindGemsTestReserve(db);
  app = await buildApp(TEST_CONFIG, db, {
    keepDeposit: { hotWalletAta: hotAta.toBase58(), keepMint: keepMint.toBase58(), decimals: TOKEN.decimals },
    depositVerifier: verifier,
    depositPaymentCommitVerifier: commitVerifier,
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  for (const key of ENV_KEYS) setEnv(key, prior[key]);
  await conn.sql.end();
});

/** A REAL keypair wallet (createTestPlayer's random bytes may be off-curve, and
 *  the intent derives the player's KEEP ATA, which only exists for curve points). */
async function signedIn() {
  const wallet = Keypair.generate().publicKey.toBase58();
  await db.insert(players).values({ wallet });
  await getOrCreatePlayerAccount(db, wallet, 'player_keep');
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
  return { wallet, cookies };
}
type Json = Record<string, unknown> & { error?: { code?: string; message?: string } };
const post = (url: string, cookies: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url, cookies, payload: payload as Record<string, unknown> });
const get = (url: string, cookies?: Record<string, string>) => app.inject({ method: 'GET', url, ...(cookies ? { cookies } : {}) });
const gemsOf = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_gems')).balance;
const sysBal = async (id: string) => (await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id)))[0]!.balance;
const intentFor = (cookies: Record<string, string>, keepIn: number, idempotencyKey = randomUUID()) =>
  post('/deposits', cookies, { kind: 'gems_buy', keepIn, idempotencyKey });
const rowOf = async (id: string) => (await db.select().from(deposits).where(eq(deposits.id, id)))[0]!;
const creditTxn = async (depositId: string) => (await db.select().from(ledgerTransactions)
  .where(eq(ledgerTransactions.idempotencyKey, `deposit:${depositId}:credit`)))[0];
async function entriesOf(txnId: string) {
  const rows = await db.select({ delta: ledgerEntries.delta, kind: accounts.kind, currency: accounts.currency, owner: accounts.ownerWallet })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txnId));
  return rows.map((r) => `${r.kind}:${r.currency}:${r.delta}:${r.owner ? 'w' : '-'}`).sort();
}

describe('POST /deposits { kind: gems_buy } — intent', () => {
  it('returns the SPL transfer the wallet must build: reserve destination, mint, decimals, quote and TTL', async () => {
    const { wallet, cookies } = await signedIn();
    const key = randomUUID();
    const res = await intentFor(cookies, 250, key);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body).toMatchObject({
      kind: 'gems_buy', status: 'pending', keepIn: 250, gemsOut: 250 * GEMS.gemsPerKeep,
      source: keepAta(new PublicKey(wallet), keepMint).toBase58(),
      destination: reserve.toBase58(), mint: keepMint.toBase58(), decimals: TOKEN.decimals,
      serverNow: expect.any(String), expiresAt: expect.any(String), reference: expect.any(String), id: expect.any(String),
    });
    // Never the custody ATA: that would credit KEEP, not Gems.
    expect(body['destination']).not.toBe(hotAta.toBase58());
    expect(Date.parse(body['expiresAt'] as string) - Date.parse(body['serverNow'] as string))
      .toBe(ECONOMY.depositPendingTtlMin * 60_000);
    const row = await rowOf(body['id'] as string);
    expect(row).toMatchObject({ kind: 'gems_buy', status: 'pending', playerWallet: wallet,
      payload: { idempotencyKey: key, keepIn: 250, gemsOut: 250, destination: reserve.toBase58(), mint: keepMint.toBase58() } });
  });

  it('is one intent per (wallet, idempotencyKey): replay returns the same row, another amount is 409', async () => {
    const { cookies } = await signedIn();
    const key = randomUUID();
    const first = (await intentFor(cookies, 40, key)).json() as Json;
    const replay = await intentFor(cookies, 40, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: first['id'], reference: first['reference'] });
    const mismatch = await intentFor(cookies, 41, key);
    expect(mismatch.statusCode).toBe(409);
    expect((mismatch.json() as Json).error?.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    // A different wallet may reuse the same client key: uniqueness is per wallet.
    const other = await signedIn();
    expect((await intentFor(other.cookies, 40, key)).statusCode).toBe(200);
  });

  it('replaying a key whose row is no longer payable is 409 INTENT_TERMINAL and never payable-looking', async () => {
    // Decision (security review #2): a DEFINITIVE 409 carrying the row, not a
    // 200 stripped of its transfer fields — a MoneyOp client must branch on the
    // code, then recover through GET /deposits/:id or mint a new key.
    const { wallet, cookies } = await signedIn();
    const key = randomUUID();
    const first = (await intentFor(cookies, 6, key)).json() as Json;
    const paid = { txSignature: bs58.encode(randomBytes(64)), wallet, kind: 'gems_buy' as const, lamports: 6n * UNIT, finalized: true as const };
    expect((await creditDeposit(db, first['id'] as string, paid)).credited).toBe(true);
    for (const keepIn of [6, 7]) { // same or different amount: the row is dead either way
      const replay = await intentFor(cookies, keepIn, key);
      expect(replay.statusCode).toBe(409);
      const body = replay.json() as Json;
      expect(body.error).toMatchObject({ code: 'INTENT_TERMINAL', depositId: first['id'], status: 'credited' });
      for (const field of ['reference', 'source', 'destination', 'mint', 'decimals']) expect(body).not.toHaveProperty(field);
    }
    for (const status of ['expired', 'failed'] as const) {
      const k = randomUUID();
      const row = (await intentFor(cookies, 3, k)).json() as Json;
      await db.update(deposits).set({ status }).where(eq(deposits.id, row['id'] as string));
      const replay = await intentFor(cookies, 3, k);
      expect(replay.statusCode).toBe(409);
      expect((replay.json() as Json).error).toMatchObject({ code: 'INTENT_TERMINAL', depositId: row['id'], status });
    }
    // A pending row too old to sign, land AND finalize inside its TTL is dead too
    // (the same reuse window every other intent kind applies).
    const stale = randomUUID();
    const aged = (await intentFor(cookies, 3, stale)).json() as Json;
    const tooOld = new Date(Date.now() - (ECONOMY.depositPendingTtlMin - ECONOMY.depositReuseMinRemainingMin + 1) * 60_000);
    await db.update(deposits).set({ createdAt: tooOld }).where(eq(deposits.id, aged['id'] as string));
    const late = await intentFor(cookies, 3, stale);
    expect(late.statusCode).toBe(409);
    expect((late.json() as Json).error).toMatchObject({ code: 'INTENT_TERMINAL', depositId: aged['id'], status: 'expired' });
    // Still-payable rows keep replaying normally.
    const fresh = randomUUID();
    const live = (await intentFor(cookies, 3, fresh)).json() as Json;
    expect((await intentFor(cookies, 3, fresh)).json()).toMatchObject({ id: live['id'], destination: reserve.toBase58(), mint: keepMint.toBase58() });
  });

  it('enforces the shared conversion bounds (GEMS.minConvertKeep / maxConvertKeepPerTx) as 422 D codes', async () => {
    const { cookies } = await signedIn();
    const below = await intentFor(cookies, GEMS.minConvertKeep - 1);
    expect(below.statusCode).toBe(422);
    expect((below.json() as Json).error?.code).toBe('GEMS_PURCHASE_BELOW_MINIMUM');
    const negative = await intentFor(cookies, -5);
    expect(negative.statusCode).toBe(422);
    expect((negative.json() as Json).error?.code).toBe('GEMS_PURCHASE_BELOW_MINIMUM');
    const above = await intentFor(cookies, GEMS.maxConvertKeepPerTx + 1);
    expect(above.statusCode).toBe(422);
    expect((above.json() as Json).error?.code).toBe('GEMS_PURCHASE_ABOVE_MAXIMUM');
    expect((await intentFor(cookies, GEMS.maxConvertKeepPerTx)).statusCode).toBe(200);
    expect((await post('/deposits', cookies, { kind: 'gems_buy', keepIn: 5 })).statusCode).toBe(422); // no key
    expect((await post('/deposits', cookies, { kind: 'gems_buy', idempotencyKey: randomUUID() })).statusCode).toBe(422); // no amount
    expect((await post('/deposits', cookies, { kind: 'gems_buy', keepIn: 1.5, idempotencyKey: randomUUID() })).statusCode).toBe(400); // not whole
  });

  it('creation requires the child flag and startup-verified reserve; anonymous is 401', async () => {
    const { cookies } = await signedIn();
    expect((await app.inject({ method: 'POST', url: '/deposits', payload: { kind: 'gems_buy', keepIn: 5, idempotencyKey: randomUUID() } })).statusCode).toBe(401);
    for (const overrides of [
      { GEMS_WALLET_BUY_ENABLED: 'false' }, { GEMS_WALLET_BUY_ENABLED: undefined },
      { GEMS_ENABLED: 'false' },
    ]) {
      await withEnv(overrides, async () => {
        const res = await intentFor(cookies, 5);
        expect(res.statusCode).toBe(503);
        expect((res.json() as Json).error?.code).toBe('GEMS_WALLET_BUY_DISABLED');
      });
    }
    expect((await intentFor(cookies, 5)).statusCode).toBe(200);
  });
});

describe('advertising the wallet source (GET /gems, GET /native/capabilities)', () => {
  it("lists 'wallet-keep' only with the flag and a verified reserve; mutable env cannot redirect it", async () => {
    const { cookies } = await signedIn();
    expect(((await get('/gems', cookies)).json() as Json)['sources']).toEqual(['ledger-keep', 'wallet-keep']);
    const caps = NativeCapabilitiesSchema.parse((await app.inject('/native/capabilities')).json());
    expect(caps.economy.gems).toMatchObject({ enabled: true, sources: ['ledger-keep', 'wallet-keep'], destinationAta: reserve.toBase58() });
    await withEnv({ GEMS_RESERVE_ATA: undefined }, async () => {
      expect(gemsReserveAta(db)).toBe(reserve.toBase58());
      expect(((await get('/gems', cookies)).json() as Json)['sources']).toEqual(['ledger-keep', 'wallet-keep']);
      const off = NativeCapabilitiesSchema.parse((await app.inject('/native/capabilities')).json());
      expect(off.economy.gems).toMatchObject({ enabled: true, sources: ['ledger-keep', 'wallet-keep'], destinationAta: reserve.toBase58() });
    });
    await withEnv({ GEMS_WALLET_BUY_ENABLED: 'false' }, async () => {
      expect(((await get('/gems', cookies)).json() as Json)['sources']).toEqual(['ledger-keep']);
      const off = NativeCapabilitiesSchema.parse((await app.inject('/native/capabilities')).json());
      // The ATA is configured but must NOT be published without its source (#3).
      expect(gemsReserveAta(db)).toBe(reserve.toBase58());
      expect(off.economy.gems).toMatchObject({ enabled: true, sources: ['ledger-keep'], destinationAta: null });
    });
    await withEnv({ GEMS_ENABLED: 'false' }, async () => {
      const dark = NativeCapabilitiesSchema.parse((await app.inject('/native/capabilities')).json());
      expect(dark.economy.gems).toMatchObject({ enabled: false, sources: [], destinationAta: null });
    });
  });

  it('fails boot without the reserve OWNER or custody identity; the optional ATA cannot select a target', () => {
    const base = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: 'test-secret-test-secret-test-secret!',
      WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test', GEMS_ENABLED: 'true', GEMS_WALLET_BUY_ENABLED: 'true' };
    expect(() => loadConfig(base)).toThrow(/GEMS_RESERVE_OWNER/);
    expect(() => loadConfig({ ...base, GEMS_RESERVE_ATA: reserve.toBase58() })).toThrow(/GEMS_RESERVE_OWNER/);
    expect(() => loadConfig({ ...base, GEMS_RESERVE_OWNER: 'not-base58-0OIl' })).toThrow(/GEMS_RESERVE_OWNER/);
    expect(() => loadConfig({ ...base, GEMS_RESERVE_OWNER: reserveOwner.toBase58() })).toThrow(/HOT_WALLET_PUBKEY/);
    expect(() => loadConfig({ ...base, GEMS_ENABLED: 'false', GEMS_RESERVE_OWNER: reserveOwner.toBase58(), HOT_WALLET_PUBKEY: hotWallet.toBase58() })).toThrow(/GEMS_WALLET_BUY_ENABLED/);
    expect(loadConfig({ ...base, GEMS_RESERVE_OWNER: reserveOwner.toBase58(), HOT_WALLET_PUBKEY: hotWallet.toBase58() }).GEMS_RESERVE_ATA).toBeUndefined();
  });

  it('an app/database handle without finalized startup proof cannot create a wallet Gems intent', async () => {
    const other = connectTestDb();
    try {
      const { wallet } = await signedIn();
      expect(gemsReserveAta(other.db)).toBeNull();
      await expect(createDepositIntent(other.db, wallet, 'gems_buy', { keepIn: 5, idempotencyKey: randomUUID(), mint: keepMint.toBase58() }))
        .rejects.toMatchObject({ code: 'GEMS_WALLET_BUY_DISABLED' });
    } finally { await other.sql.end(); }
  });

});

describe('crediting a finalized transfer', () => {
  it('posts ONE four-entry row backed by the observed KEEP (G-3/G-4) and exposes the receipt', async () => {
    const { wallet, cookies } = await signedIn();
    const sys = await bootstrapSystemAccounts(db);
    const [inflowBefore, poolBefore, mintBefore] = await Promise.all([sysBal(sys.onchain_inflow), sysBal(sys.emission_pool), sysBal(sys.gems_mint)]);
    const intent = (await intentFor(cookies, 12)).json() as Json;
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 12n * UNIT });

    await expect(verifyDepositNow(db, verifier, wallet, intent['id'] as string)).resolves.toEqual({ action: 'credited' });
    expect(await gemsOf(wallet)).toBe(12n * BigInt(GEMS.gemsPerKeep));
    expect(await sysBal(sys.onchain_inflow)).toBe(inflowBefore - 12n);
    expect(await sysBal(sys.emission_pool)).toBe(poolBefore + 12n);
    expect(await sysBal(sys.gems_mint)).toBe(mintBefore - 12n);

    const txn = await creditTxn(intent['id'] as string);
    expect(txn).toBeDefined();
    expect(txn!.type).toBe('gems.buy');
    expect(txn!.metadata).toEqual({
      wallet, depositId: intent['id'], txSignature: signature, keepBaseUnits: (12n * UNIT).toString(),
      keep: '12', gems: '12', rate: GEMS.gemsPerKeep, source: 'wallet',
      mint: keepMint.toBase58(), destination: reserve.toBase58(),
    });
    expect(await entriesOf(txn!.id)).toEqual([
      'emission_pool:KEEP:12:-', 'gems_mint:GEMS:-12:-', 'onchain_inflow:KEEP:-12:-', 'player_gems:GEMS:12:w',
    ]);
    const row = await rowOf(intent['id'] as string);
    expect(row).toMatchObject({ status: 'credited', txSignature: signature, amount: 12n * UNIT });
    expect(row.mint).toBe(depositMint('gems_buy')); // KEEP-denominated, like keep_deposit
    const receipt = (await get(`/deposits/${intent['id']}`, cookies)).json() as Json;
    expect(receipt).toMatchObject({ kind: 'gems_buy', status: 'credited', txSignature: signature, amount: (12n * UNIT).toString(),
      keepIn: 12, gemsOut: 12, keepCredited: '12', gemsCredited: '12', dustBaseUnits: '0' });
  });

  it('never credits a transfer that landed in custody instead of the reserve (and vice versa)', async () => {
    const { wallet, cookies } = await signedIn();
    const gems = (await intentFor(cookies, 9)).json() as Json;
    landTransfer({ signer: wallet, references: [gems['reference'] as string], destination: hotAta, baseUnits: 9n * UNIT });
    await expect(verifyDepositNow(db, verifier, wallet, gems['id'] as string)).resolves.toEqual({ action: 'none' });
    expect(await gemsOf(wallet)).toBe(0n);
    expect((await rowOf(gems['id'] as string)).status).toBe('pending');
    // The mirror: a custody deposit paid into the reserve credits no KEEP either.
    const custody = await createDepositIntent(db, wallet, 'keep_deposit');
    landTransfer({ signer: wallet, references: [custody.reference], destination: reserve, baseUnits: 9n * UNIT });
    await expect(verifyDepositNow(db, verifier, wallet, custody.id)).resolves.toEqual({ action: 'none' });
    expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(0n);
    // The /paid commit proof holds the same line.
    const wrong = landTransfer({ signer: wallet, references: [gems['reference'] as string], destination: hotAta, baseUnits: 9n * UNIT });
    const right = landTransfer({ signer: wallet, references: [gems['reference'] as string], destination: reserve, baseUnits: 9n * UNIT });
    const pending = { id: gems['id'] as string, playerWallet: wallet, kind: 'gems_buy' as const, reference: gems['reference'] as string,
      createdAt: new Date(), destination: reserve.toBase58(), mint: keepMint.toBase58() };
    await expect(commitVerifier({ ...pending, paymentSignature: wrong })).resolves.toBeNull();
    await expect(commitVerifier({ ...pending, paymentSignature: right })).resolves.toMatchObject({ txSignature: right });
  });

  it('credits a v0 transaction whose reserve ATA comes from an address lookup table', async () => {
    const { wallet, cookies } = await signedIn();
    const intent = (await intentFor(cookies, 33)).json() as Json;
    landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 33n * UNIT, viaLookupTable: true });
    await expect(verifyDepositNow(db, verifier, wallet, intent['id'] as string)).resolves.toEqual({ action: 'credited' });
    expect(await gemsOf(wallet)).toBe(33n);
  });

  it('one finalized transaction carrying two gems_buy references credits exactly one', async () => {
    const { wallet, cookies } = await signedIn();
    const a = (await intentFor(cookies, 10)).json() as Json;
    const b = (await intentFor(cookies, 10)).json() as Json;
    const signature = landTransfer({ signer: wallet, references: [a['reference'] as string, b['reference'] as string], destination: reserve, baseUnits: 10n * UNIT });
    await expect(verifyDepositNow(db, verifier, wallet, a['id'] as string)).resolves.toEqual({ action: 'credited' });
    // The same signature cannot settle the second intent: the credit is refused
    // and the row stays pending (never a second mint, never a silent expiry of a paid row).
    await expect(verifyDepositNow(db, verifier, wallet, b['id'] as string)).resolves.toEqual({ action: 'none' });
    await expect(creditDeposit(db, b['id'] as string, { txSignature: signature, wallet, kind: 'gems_buy', lamports: 10n * UNIT, finalized: true }))
      .rejects.toThrow(/already bound to another deposit/);
    expect(await gemsOf(wallet)).toBe(10n);
    expect((await rowOf(a['id'] as string))).toMatchObject({ status: 'credited', txSignature: signature });
    expect((await rowOf(b['id'] as string))).toMatchObject({ status: 'pending', txSignature: null });
  });

  it('floors to whole KEEP: dust stays on-chain and is disclosed; a sub-KEEP transfer strands as paid-failed', async () => {
    const { wallet, cookies } = await signedIn();
    const dusty = (await intentFor(cookies, 5)).json() as Json;
    const dust = 5n * UNIT + UNIT / 2n; // 5.5 KEEP
    landTransfer({ signer: wallet, references: [dusty['reference'] as string], destination: reserve, baseUnits: dust });
    await expect(verifyDepositNow(db, verifier, wallet, dusty['id'] as string)).resolves.toEqual({ action: 'credited' });
    expect(await gemsOf(wallet)).toBe(5n);
    const txn = await creditTxn(dusty['id'] as string);
    expect(txn!.metadata).toMatchObject({ keepBaseUnits: dust.toString(), keep: '5', gems: '5' });
    expect(await entriesOf(txn!.id)).toEqual([
      'emission_pool:KEEP:5:-', 'gems_mint:GEMS:-5:-', 'onchain_inflow:KEEP:-5:-', 'player_gems:GEMS:5:w',
    ]);
    const receipt = (await get(`/deposits/${dusty['id']}`, cookies)).json() as Json;
    expect(receipt).toMatchObject({ status: 'credited', amount: dust.toString(), keepCredited: '5', gemsCredited: '5', dustBaseUnits: (UNIT / 2n).toString() });

    // Below one whole KEEP: reported, never credited (no 0-Gem row, no round-up).
    const tiny = (await intentFor(cookies, 1)).json() as Json;
    const sub = UNIT - 1n;
    const signature = landTransfer({ signer: wallet, references: [tiny['reference'] as string], destination: reserve, baseUnits: sub });
    await expect(creditDeposit(db, tiny['id'] as string, { txSignature: signature, wallet, kind: 'gems_buy', lamports: sub, finalized: true }))
      .rejects.toThrow(/below 1 KEEP/i);
    await expect(verifyDepositNow(db, verifier, wallet, tiny['id'] as string)).resolves.toEqual({ action: 'none' });
    expect(await gemsOf(wallet)).toBe(5n);
    expect(await creditTxn(tiny['id'] as string)).toBeUndefined();
    // Past the TTL the paid-but-ungrantable row terminalizes as `failed` WITH its proof for ops.
    const afterTtl = new Date(Date.now() + (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    await expect(verifyDepositNow(db, verifier, wallet, tiny['id'] as string, afterTtl)).resolves.toEqual({ action: 'failed' });
    expect(await rowOf(tiny['id'] as string)).toMatchObject({ status: 'failed', txSignature: signature, amount: sub });
    // Paid-failed is observed money, never a proven ledger credit (K-156).
    expect((await get(`/deposits/${tiny['id']}`, cookies)).json()).toMatchObject({ status: 'failed', keepCredited: null, gemsCredited: null, receipt: null, dustBaseUnits: sub.toString() });
    expect(await gemsOf(wallet)).toBe(5n);
  });

  it('credits with the flags OFF: money moved is money honoured, the gate is on intent creation only', async () => {
    const { wallet, cookies } = await signedIn();
    const intent = (await intentFor(cookies, 7)).json() as Json;
    landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 7n * UNIT });
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false', GEMS_RESERVE_ATA: undefined }, async () => {
      // No new intent can be minted…
      expect((await intentFor(cookies, 7)).statusCode).toBe(503);
      // …but the already-paid one settles through the same on-demand route the client polls.
      const res = await post(`/deposits/${intent['id']}/verify`, cookies, {});
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'credited', keepCredited: '7', gemsCredited: '7' });
    });
    expect(await gemsOf(wallet)).toBe(7n);
    // creditDeposit itself never consults a flag either.
    const direct = await createDepositIntent(db, wallet, 'gems_buy', { keepIn: 3, idempotencyKey: randomUUID(), mint: keepMint.toBase58() });
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false' }, async () => {
      const paid = { txSignature: bs58.encode(randomBytes(64)), wallet, kind: 'gems_buy' as const, lamports: 3n * UNIT, finalized: true as const };
      expect((await creditDeposit(db, direct.id, paid)).credited).toBe(true);
    });
    expect(await gemsOf(wallet)).toBe(10n);
  });

  it('replaying the credit key is a no-op: neither the row nor the ledger moves twice', async () => {
    const { wallet, cookies } = await signedIn();
    const intent = (await intentFor(cookies, 4)).json() as Json;
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 4n * UNIT });
    const paid = { txSignature: signature, wallet, kind: 'gems_buy' as const, lamports: 4n * UNIT, finalized: true as const };
    expect((await creditDeposit(db, intent['id'] as string, paid)).credited).toBe(true);
    expect((await creditDeposit(db, intent['id'] as string, paid)).credited).toBe(false);
    await expect(verifyDepositNow(db, verifier, wallet, intent['id'] as string)).resolves.toEqual({ action: 'none' });
    const sys = await bootstrapSystemAccounts(db);
    const gemsAcct = await getOrCreatePlayerAccount(db, wallet, 'player_gems');
    const replay = await postTransaction(db, {
      idempotencyKey: `deposit:${intent['id']}:credit`, type: 'gems.buy',
      entries: [
        { account: sys.onchain_inflow, delta: -4n }, { account: sys.emission_pool, delta: 4n },
        { account: sys.gems_mint, delta: -4n }, { account: gemsAcct.id, delta: 4n },
      ],
    });
    expect(replay.duplicate).toBe(true);
    expect(await gemsOf(wallet)).toBe(4n);
    expect((await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `deposit:${intent['id']}:credit`))).length).toBe(1);
  });

  it('mutable env never redirects new quotes and paid intents still credit their frozen destination', async () => {
    const { wallet, cookies } = await signedIn();
    const rotated = keepAta(Keypair.generate().publicKey, keepMint);
    const old = (await intentFor(cookies, 8)).json() as Json;
    const oldSig = landTransfer({ signer: wallet, references: [old['reference'] as string], destination: reserve, baseUnits: 8n * UNIT });
    await withEnv({ GEMS_RESERVE_ATA: rotated.toBase58() }, async () => {
      const fresh = (await intentFor(cookies, 2)).json() as Json;
      expect(fresh['destination']).toBe(reserve.toBase58());
      expect((await rowOf(fresh['id'] as string)).payload).toMatchObject({ destination: reserve.toBase58(), mint: keepMint.toBase58() });
      expect((await post(`/deposits/${old['id']}/paid`, cookies, { signature: oldSig })).statusCode).toBe(200);
      landTransfer({ signer: wallet, references: [fresh['reference'] as string], destination: rotated, baseUnits: 2n * UNIT });
      await expect(verifyDepositNow(db, verifier, wallet, fresh['id'] as string)).resolves.toEqual({ action: 'none' });
      landTransfer({ signer: wallet, references: [fresh['reference'] as string], destination: reserve, baseUnits: 2n * UNIT });
      await expect(verifyDepositNow(db, verifier, wallet, fresh['id'] as string)).resolves.toEqual({ action: 'credited' });
    });
    await withEnv({ GEMS_RESERVE_ATA: undefined, GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false' }, async () => {
      await expect(verifyDepositNow(db, verifier, wallet, old['id'] as string)).resolves.toEqual({ action: 'credited' });
    });
    expect(await gemsOf(wallet)).toBe(10n);
    expect(await rowOf(old['id'] as string)).toMatchObject({ status: 'credited', txSignature: oldSig, paymentSignature: oldSig });
    await expect(verifier({ id: old['id'] as string, playerWallet: wallet, kind: 'gems_buy', reference: old['reference'] as string, createdAt: new Date(0) }))
      .resolves.toBeNull();
  });

  it('credits an over-payment above GEMS.maxConvertKeepPerTx: the bound is intent-only, every Gem is backed by the observed inflow', async () => {
    // Decision (security review #4): refusing would strand real money for a
    // number that protects nothing at credit time — the KEEP is on-chain in the
    // reserve, so the mint is fully backed whatever the quote said.
    const { wallet, cookies } = await signedIn();
    const over = BigInt(GEMS.maxConvertKeepPerTx) + 1n;
    const intent = (await intentFor(cookies, 5)).json() as Json;
    landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: over * UNIT });
    await expect(verifyDepositNow(db, verifier, wallet, intent['id'] as string)).resolves.toEqual({ action: 'credited' });
    expect(await gemsOf(wallet)).toBe(over * BigInt(GEMS.gemsPerKeep));
    const txn = await creditTxn(intent['id'] as string);
    expect(txn!.metadata).toMatchObject({ keep: over.toString(), gems: over.toString() });
    expect(await entriesOf(txn!.id)).toEqual([
      `emission_pool:KEEP:${over}:-`, `gems_mint:GEMS:-${over}:-`, `onchain_inflow:KEEP:-${over}:-`, `player_gems:GEMS:${over}:w`,
    ]);
    expect((await get(`/deposits/${intent['id']}`, cookies)).json()).toMatchObject({ keepIn: 5, gemsOut: 5, keepCredited: over.toString(), gemsCredited: over.toString() });
    // Shared test DB hygiene: return the extreme KEEP leg so other suites' pool
    // expectations are unaffected (KEEP-only, per-currency balanced, no Gems leg).
    const sys = await bootstrapSystemAccounts(db);
    await postTransaction(db, { idempotencyKey: `test.gems-buy.cleanup:${intent['id']}`, type: 'test.cleanup',
      entries: [{ account: sys.emission_pool, delta: -over }, { account: sys.onchain_inflow, delta: over }] });
  });

  it('refuses a payment whose wallet does not match the intent', async () => {
    const { wallet, cookies } = await signedIn();
    const other = await createTestPlayer(db);
    const intent = (await intentFor(cookies, 2)).json() as Json;
    await expect(creditDeposit(db, intent['id'] as string, { txSignature: bs58.encode(randomBytes(64)), wallet: other.wallet, kind: 'gems_buy', lamports: 2n * UNIT, finalized: true }))
      .rejects.toThrow(/wallet does not match/);
    expect(await gemsOf(wallet)).toBe(0n);
    expect(await gemsOf(other.wallet)).toBe(0n);
  });
});

describe('wallet Gems recovery and original posting evidence (K-156)', () => {
  it('recovers a lost quote by its wallet/key while both flags and advertised destination are gone', async () => {
    const { wallet, cookies } = await signedIn();
    const key = randomUUID();
    const intent = (await intentFor(cookies, 7, key)).json() as Json;
    const payload = (await rowOf(intent['id'] as string)).payload;
    expect(payload).toMatchObject({ gemsBuyVersion: 1, decimals: TOKEN.decimals, expiresAt: intent['expiresAt'] });
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false', GEMS_RESERVE_ATA: undefined }, async () => {
      expect((await intentFor(cookies, 7, key)).statusCode).toBe(503);
      const res = await get(`/gems/buy/by-key/${key}`, cookies);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.json()).toMatchObject({ version: 1, wallet, idempotencyKey: key, recoveryOnly: true, status: 'known',
        deposit: { status: 'pending', receipt: null, keepCredited: null, gemsCredited: null,
          originalIntent: { id: intent['id'], kind: 'gems_buy', wallet, idempotencyKey: key,
            reference: intent['reference'], source: intent['source'], destination: intent['destination'],
            mint: intent['mint'], decimals: TOKEN.decimals, keepIn: 7, gemsOut: 7, expiresAt: intent['expiresAt'] } } });
      expect((await rowOf(intent['id'] as string)).status).toBe('pending'); // GET never settles or admits a transfer.
    });
  });

  it('keeps unknown, private failures and same-key wallets isolated', async () => {
    const { cookies } = await signedIn(); const other = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 3, key)).json() as Json;
    const unknown = await get(`/gems/buy/by-key/${key}`, other.cookies);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toMatchObject({ wallet: other.wallet, idempotencyKey: key, recoveryOnly: true, status: 'unknown', deposit: null });
    expect(unknown.body).not.toContain(intent['reference']);
    expect(unknown.headers['cache-control']).toBe('private, no-store');
    const own = (await intentFor(other.cookies, 4, key)).json() as Json;
    expect((await get(`/gems/buy/by-key/${key}`, other.cookies)).json()).toMatchObject({
      deposit: { originalIntent: { id: own['id'], wallet: other.wallet, keepIn: 4 } } });
    for (const [url, auth, status] of [[`/gems/buy/by-key/${key}`, undefined, 401], ['/gems/buy/by-key/short', cookies, 400]] as const) {
      const res = await get(url, auth);
      expect(res.statusCode).toBe(status); expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.body).not.toContain(intent['reference']);
    }
  });

  it('reads an existing intent through a DB handle with no current reserve admission or transfer config', async () => {
    const { cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 2, key)).json() as Json;
    const other = connectTestDb();
    const recoveryApp = await buildApp(TEST_CONFIG, other.db);
    try {
      expect(gemsReserveAta(other.db)).toBeNull();
      await recoveryApp.ready();
      const res = await recoveryApp.inject({ method: 'GET', url: `/gems/buy/by-key/${key}`, cookies });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ recoveryOnly: true, deposit: { originalIntent: {
        id: intent['id'], destination: reserve.toBase58(), mint: keepMint.toBase58() } } });
    } finally { await recoveryApp.close(); await other.sql.end(); }
  });

  it('recovers terminal deposit evidence rather than presenting a dead key as payable', async () => {
    const { cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 2, key)).json() as Json;
    await db.update(deposits).set({ status: 'expired' }).where(eq(deposits.id, intent['id'] as string));
    expect((await intentFor(cookies, 2, key)).statusCode).toBe(409);
    expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ recoveryOnly: true, status: 'known',
      deposit: { status: 'expired', originalIntent: { id: intent['id'] }, keepCredited: null, gemsCredited: null, receipt: null } });
  });

  it('does not mistake an observed whole-KEEP failed transfer for any Gems credit', async () => {
    const { cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 3, key)).json() as Json;
    const amount = 3n * UNIT + UNIT / 2n;
    await db.update(deposits).set({ status: 'failed', amount, txSignature: bs58.encode(randomBytes(64)), finalizedAt: new Date() })
      .where(eq(deposits.id, intent['id'] as string));
    const expected = { status: 'failed', amount: amount.toString(), keepCredited: null, gemsCredited: null,
      receipt: null, dustBaseUnits: (UNIT / 2n).toString() };
    expect((await get(`/deposits/${intent['id']}`, cookies)).json()).toMatchObject(expected);
    expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: expected });
    expect(await creditTxn(intent['id'] as string)).toBeUndefined();
  });

  it('honours an existing quote and reads the original receipt when capabilities disappear', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 6, key)).json() as Json;
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 6n * UNIT });
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false', GEMS_RESERVE_ATA: undefined }, async () => {
      expect((await post(`/deposits/${intent['id']}/paid`, cookies, { signature })).statusCode).toBe(200);
      expect((await post(`/deposits/${intent['id']}/verify`, cookies, {})).statusCode).toBe(200);
      const txn = (await creditTxn(intent['id'] as string))!;
      expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: { status: 'credited',
        receipt: { version: 1, receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(), wallet,
          depositId: intent['id'], txSignature: signature,
          funding: { currency: 'KEEP', amount: '6', baseUnits: (6n * UNIT).toString() },
          result: { currency: 'GEMS', amount: '6', rate: 1 } } } });
    });
  });

  it('keeps confirmed payment pending past the TTL until finality can prove its original credit', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 4, key)).json() as Json;
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 4n * UNIT });
    expect((await post(`/deposits/${intent['id']}/paid`, cookies, { signature })).statusCode).toBe(200);
    const transaction = bySignature.get(signature)!;
    bySignature.delete(signature); // CONFIRMED was proved, but the finalized provider is temporarily unavailable.
    const afterTtl = new Date(Date.now() + (ECONOMY.depositPendingTtlMin + 1) * 60_000);
    try {
      await verifyDepositNow(db, verifier, wallet, intent['id'] as string, afterTtl).catch(() => null);
      expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: {
        status: 'pending', paymentSignature: signature, keepCredited: null, gemsCredited: null, receipt: null } });
    } finally { bySignature.set(signature, transaction); }
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false' }, async () => {
      await expect(verifyDepositNow(db, verifier, wallet, intent['id'] as string, afterTtl)).resolves.toMatchObject({ action: 'credited' });
      expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: {
        status: 'credited', txSignature: signature, gemsCredited: '4' } });
    });
  });

  it('keeps pre-versioned funded quotes and historical receipts independent of later catalogue rates', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 5, key)).json() as Json;
    const row = await rowOf(intent['id'] as string);
    const legacy = { ...(row.payload as Record<string, unknown>) };
    delete legacy['gemsBuyVersion']; delete legacy['decimals']; delete legacy['expiresAt'];
    await db.update(deposits).set({ payload: legacy }).where(eq(deposits.id, row.id));
    const paid = { txSignature: bs58.encode(randomBytes(64)), wallet, kind: 'gems_buy' as const, lamports: 5n * UNIT, finalized: true as const };
    await creditDeposit(db, row.id, paid);
    const txn = (await creditTxn(row.id))!;
    const legacyMeta = { ...(txn.metadata as Record<string, unknown>) };
    delete legacyMeta['mint']; delete legacyMeta['destination'];
    await db.update(ledgerTransactions).set({ metadata: legacyMeta }).where(eq(ledgerTransactions.id, txn.id));
    const rates = GEMS as { gemsPerKeep: number }; const rate = rates.gemsPerKeep;
    try {
      rates.gemsPerKeep = rate + 1; // Deliberate future-code drift; never reprice an accepted posting.
      expect((await get(`/deposits/${row.id}`, cookies)).json()).toMatchObject({ keepCredited: '5', gemsCredited: '5',
        receipt: { receiptId: txn.id, result: { amount: '5', rate } } });
      expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: {
        originalIntent: { keepIn: 5, gemsOut: 5 }, receipt: { result: { amount: '5', rate } } } });
    } finally { rates.gemsPerKeep = rate; }
  });

  it('proves the finalized fallback payment when the earlier confirmed candidate is unavailable', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 3, key)).json() as Json;
    const reference = intent['reference'] as string;
    const candidate = landTransfer({ signer: wallet, references: [reference], destination: reserve, baseUnits: 3n * UNIT });
    expect((await post(`/deposits/${intent['id']}/paid`, cookies, { signature: candidate })).statusCode).toBe(200);
    bySignature.delete(candidate);
    const finalized = landTransfer({ signer: wallet, references: [reference], destination: reserve, baseUnits: 3n * UNIT });
    await expect(verifyDepositNow(db, verifier, wallet, intent['id'] as string)).resolves.toMatchObject({ action: 'credited' });
    const expected = { status: 'credited', paymentSignature: candidate, txSignature: finalized,
      keepCredited: '3', gemsCredited: '3', receipt: { txSignature: finalized, result: { amount: '3' } } };
    expect((await get(`/deposits/${intent['id']}`, cookies)).json()).toMatchObject(expected);
    expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: expected });
    expect(await gemsOf(wallet)).toBe(3n);
  });

  it('refuses malformed frozen rates before any Gems credit rather than repricing the purchase', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 4, key)).json() as Json; const row = await rowOf(intent['id'] as string);
    await db.update(deposits).set({ payload: { ...(row.payload as object), gemsOut: 8 } }).where(eq(deposits.id, row.id));
    await expect(creditDeposit(db, row.id, { txSignature: bs58.encode(randomBytes(64)), wallet,
      kind: 'gems_buy', lamports: 4n * UNIT, finalized: true })).rejects.toThrow(/evidence is inconsistent/);
    expect((await rowOf(row.id)).status).toBe('pending'); expect(await gemsOf(wallet)).toBe(0n);
    expect((await get(`/gems/buy/by-key/${key}`, cookies)).statusCode).toBe(500);
  });

  it('refuses a credited row without its original backing posting', async () => {
    const { cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 2, key)).json() as Json;
    await db.update(deposits).set({ status: 'credited', amount: 2n * UNIT, txSignature: bs58.encode(randomBytes(64)), finalizedAt: new Date() })
      .where(eq(deposits.id, intent['id'] as string));
    for (const url of [`/deposits/${intent['id']}`, `/gems/buy/by-key/${key}`]) {
      const res = await get(url, cookies); expect(res.statusCode).toBe(500); expect(res.json()).not.toHaveProperty('gemsCredited');
    }
  });

  it('rejects mismatched posting metadata even when the deposit is marked credited', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 3, key)).json() as Json;
    await creditDeposit(db, intent['id'] as string, { txSignature: bs58.encode(randomBytes(64)), wallet,
      kind: 'gems_buy', lamports: 3n * UNIT, finalized: true });
    const txn = (await creditTxn(intent['id'] as string))!;
    for (const patch of [{ wallet: Keypair.generate().publicKey.toBase58() }, { depositId: randomUUID() },
      { rate: 2 }, { keepBaseUnits: '1' }, { source: 'ledger' }, { destination: hotAta.toBase58() }]) {
      try {
        await db.update(ledgerTransactions).set({ metadata: { ...(txn.metadata as object), ...patch } }).where(eq(ledgerTransactions.id, txn.id));
        expect((await get(`/gems/buy/by-key/${key}`, cookies)).statusCode).toBe(500);
      } finally { await db.update(ledgerTransactions).set({ metadata: txn.metadata }).where(eq(ledgerTransactions.id, txn.id)); }
    }
  });

  it('rejects extra ledger entries instead of accepting matching totals as the four-entry purchase proof', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 2, key)).json() as Json; const id = intent['id'] as string;
    const signature = bs58.encode(randomBytes(64)); const sys = await bootstrapSystemAccounts(db);
    const gems = await getOrCreatePlayerAccount(db, wallet, 'player_gems');
    const shards = await getOrCreatePlayerAccount(db, wallet, 'player_shards');
    await postTransaction(db, { idempotencyKey: `deposit:${id}:credit`, type: 'gems.buy', entries: [
      { account: sys.onchain_inflow, delta: -2n }, { account: sys.emission_pool, delta: 2n },
      { account: sys.gems_mint, delta: -2n }, { account: gems.id, delta: 2n },
      { account: sys.shard_genesis, delta: -1n }, { account: shards.id, delta: 1n },
    ], metadata: { wallet, depositId: id, txSignature: signature, keepBaseUnits: (2n * UNIT).toString(),
      keep: '2', gems: '2', rate: 1, source: 'wallet' } });
    await db.update(deposits).set({ status: 'credited', amount: 2n * UNIT, txSignature: signature, finalizedAt: new Date() })
      .where(eq(deposits.id, id));
    expect((await get(`/gems/buy/by-key/${key}`, cookies)).statusCode).toBe(500);
  });
});

/** K159: admission expiry cannot cancel a real transfer. Recovery consumes only
 * positive proof against the original quote and never creates another intent. */
describe('expired wallet Gems payment recovery', () => {
  const afterTtl = () => new Date(Date.now() + (ECONOMY.depositPendingTtlMin + 1) * 60_000);

  it('negotiates positive expired-payment recovery before either new creation or signing', async () => {
    const { cookies } = await signedIn(); const key = randomUUID();
    expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({
      version: 1, recoveryOnly: true, expiredPaymentRecovery: 1, status: 'unknown', deposit: null,
    });
    await intentFor(cookies, 3, key);
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false' }, async () => {
      expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({
        version: 1, recoveryOnly: true, expiredPaymentRecovery: 1, status: 'known',
      });
    });
  });

  it('recovers a late finalized transfer once against the expired original during a pause', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 7, key)).json() as Json;
    const id = intent['id'] as string;
    await expect(verifyDepositNow(db, verifier, wallet, id, afterTtl())).resolves.toEqual({ action: 'expired' });
    await expect(verifyDepositNow(db, verifier, wallet, id, afterTtl())).resolves.toEqual({ action: 'none' });
    expect((await rowOf(id)).status).toBe('expired');
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 7n * UNIT });
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false', GEMS_RESERVE_ATA: undefined }, async () => {
      const outcomes = await Promise.all([verifyDepositNow(db, verifier, wallet, id, afterTtl()), verifyDepositNow(db, verifier, wallet, id, afterTtl())]);
      expect(outcomes.filter(r => r.action === 'credited')).toHaveLength(1);
      expect(await gemsOf(wallet)).toBe(7n);
      expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: {
        status: 'credited', txSignature: signature, originalIntent: { id }, receipt: {
          depositId: id, wallet, txSignature: signature, funding: { currency: 'KEEP', amount: '7' }, result: { currency: 'GEMS', amount: '7', rate: 1 },
        },
      } });
    });
    expect((await intentFor(cookies, 7, key)).statusCode).toBe(409);
    expect(await entriesOf((await creditTxn(id))!.id)).toHaveLength(4);
  });

  it('a late exact confirmed signature revives only the original expired Gems row for settlement', async () => {
    const { wallet, cookies } = await signedIn();
    const intent = (await intentFor(cookies, 5)).json() as Json; const id = intent['id'] as string;
    await verifyDepositNow(db, verifier, wallet, id, afterTtl());
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 5n * UNIT });
    await withEnv({ GEMS_ENABLED: 'false', GEMS_WALLET_BUY_ENABLED: 'false' }, async () => {
      expect((await post(`/deposits/${id}/paid`, cookies, { signature })).statusCode).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: 'pending', paymentSignature: signature });
      expect(await gemsOf(wallet)).toBe(0n); // Confirmed proof alone never mints.
      const transaction = bySignature.get(signature)!; bySignature.delete(signature);
      try { await verifyDepositNow(db, verifier, wallet, id, afterTtl()).catch(() => null); }
      finally { bySignature.set(signature, transaction); }
      expect((await rowOf(id)).status).toBe('pending');
      expect((await post(`/deposits/${id}/verify`, cookies, {})).statusCode).toBe(200);
      expect(await gemsOf(wallet)).toBe(5n);
    });
  });

  it('wrong signer, wrong reserve, unconfirmed proof and another wallet cannot revive an expired quote', async () => {
    const { wallet, cookies } = await signedIn(); const other = await signedIn();
    const intent = (await intentFor(cookies, 3)).json() as Json; const id = intent['id'] as string;
    await verifyDepositNow(db, verifier, wallet, id, afterTtl());
    const signatures = [
      landTransfer({ signer: other.wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 3n * UNIT }),
      landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: hotAta, baseUnits: 3n * UNIT }),
      bs58.encode(randomBytes(64)),
    ];
    for (const signature of signatures) {
      expect((await post(`/deposits/${id}/paid`, cookies, { signature })).statusCode).toBe(422);
      expect(await rowOf(id)).toMatchObject({ status: 'expired', paymentSignature: null, amount: null });
    }
    expect((await post(`/deposits/${id}/paid`, other.cookies, { signature: signatures[0] })).statusCode).toBe(404);
    await expect(verifyDepositNow(db, verifier, other.wallet, id, afterTtl())).resolves.toEqual({ action: 'none' });
    await expect(verifyDepositNow(db, verifier, wallet, id, afterTtl())).resolves.toEqual({ action: 'none' });
    expect(await gemsOf(wallet)).toBe(0n);
  });

  it('one finalized transfer tagged with two expired Gems references cannot credit twice', async () => {
    const { wallet, cookies } = await signedIn();
    const a = (await intentFor(cookies, 8)).json() as Json, b = (await intentFor(cookies, 8)).json() as Json;
    for (const q of [a, b]) await verifyDepositNow(db, verifier, wallet, q['id'] as string, afterTtl());
    const signature = landTransfer({ signer: wallet, references: [a['reference'] as string, b['reference'] as string], destination: reserve, baseUnits: 8n * UNIT });
    const results = await Promise.allSettled([a, b].map(q => verifyDepositNow(db, verifier, wallet, q['id'] as string, afterTtl())));
    expect(results.filter(r => r.status === 'fulfilled' && r.value.action === 'credited')).toHaveLength(1);
    expect(await gemsOf(wallet)).toBe(8n);
    const rows = await Promise.all([rowOf(a['id'] as string), rowOf(b['id'] as string)]);
    expect(rows.filter(row => row.status === 'credited' && row.txSignature === signature)).toHaveLength(1);
    const loser = rows.find(row => row.status !== 'credited')!;
    expect((await post(`/deposits/${loser.id}/paid`, cookies, { signature })).statusCode).toBe(409);
    expect((await rowOf(loser.id)).status).toBe('expired');
  });

  it('retains late sub-whole payment evidence as paid-failed rather than losing it to expiry', async () => {
    const { wallet, cookies } = await signedIn(); const key = randomUUID();
    const intent = (await intentFor(cookies, 2, key)).json() as Json; const id = intent['id'] as string;
    await verifyDepositNow(db, verifier, wallet, id, afterTtl());
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: UNIT - 1n });
    await expect(verifyDepositNow(db, verifier, wallet, id, afterTtl())).resolves.toEqual({ action: 'failed' });
    expect((await get(`/gems/buy/by-key/${key}`, cookies)).json()).toMatchObject({ deposit: {
      status: 'failed', txSignature: signature, amount: (UNIT - 1n).toString(), dustBaseUnits: (UNIT - 1n).toString(),
      keepCredited: null, gemsCredited: null, receipt: null,
    } });
    expect(await gemsOf(wallet)).toBe(0n);
    await expect(verifyDepositNow(db, verifier, wallet, id, afterTtl())).resolves.toEqual({ action: 'none' });
  });

  it('a listed successful reference with unavailable transaction body cannot expire a pending Gems intent', async () => {
    const { wallet, cookies } = await signedIn();
    const intent = (await intentFor(cookies, 4)).json() as Json; const id = intent['id'] as string;
    const signature = landTransfer({ signer: wallet, references: [intent['reference'] as string], destination: reserve, baseUnits: 4n * UNIT });
    const transaction = bySignature.get(signature)!; bySignature.delete(signature);
    try {
      await expect(verifyDepositNow(db, verifier, wallet, id, afterTtl())).rejects.toThrow('transaction body is unavailable');
      expect(await rowOf(id)).toMatchObject({ status: 'pending', paymentSignature: null, amount: null });
    } finally { bySignature.set(signature, transaction); }
    await expect(verifyDepositNow(db, verifier, wallet, id, afterTtl())).resolves.toEqual({ action: 'credited' });
    expect(await gemsOf(wallet)).toBe(4n);
  });

  it('does not reopen failed Gems or expired custody deposits through the Gems recovery exception', async () => {
    const { wallet, cookies } = await signedIn();
    const gems = (await intentFor(cookies, 4)).json() as Json;
    await db.update(deposits).set({ status: 'failed' }).where(eq(deposits.id, gems['id'] as string));
    const custody = (await post('/deposits', cookies, { kind: 'keep_deposit' })).json() as Json;
    await db.update(deposits).set({ status: 'expired' }).where(eq(deposits.id, custody['id'] as string));
    for (const [quote, destination] of [[gems, reserve], [custody, hotAta]] as const) {
      const signature = landTransfer({ signer: wallet, references: [quote['reference'] as string], destination, baseUnits: 4n * UNIT });
      await expect(verifyDepositNow(db, verifier, wallet, quote['id'] as string, afterTtl())).resolves.toEqual({ action: 'none' });
      expect((await post(`/deposits/${quote['id']}/paid`, cookies, { signature })).statusCode).toBe(409);
      expect((await creditDeposit(db, quote['id'] as string, { txSignature: signature, wallet,
        kind: quote === gems ? 'gems_buy' : 'keep_deposit', lamports: 4n * UNIT, finalized: true })).credited).toBe(false);
    }
    expect(await gemsOf(wallet)).toBe(0n);
  });
});
