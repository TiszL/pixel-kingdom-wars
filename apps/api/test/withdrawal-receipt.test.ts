import { randomBytes, randomUUID } from 'node:crypto';
import { ECONOMY } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { accounts, ledgerTransactions, players, sessions, withdrawalAuthorizations, withdrawals } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { getWithdrawalReceipt, WithdrawalReceiptQuerySchema, type WithdrawalReceiptRequest } from '../src/money/withdrawalReceipt';
import { cancelWithdrawal, requestWithdrawal } from '../src/money/withdrawals';
import { connectTestDb, createTestPlayer, fundTestKeep, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const originalMode = process.env['MULTI_BASE_ENABLED'];
const originalEnabled = process.env['WITHDRAWALS_ENABLED'];
const gross = BigInt(ECONOMY.minWithdrawKeep) * 2n;
const fee = gross * BigInt(ECONOMY.withdrawFeeBps) / 10_000n;
const fixtureWithdrawalIds: string[] = [];
beforeAll(async () => { process.env['MULTI_BASE_ENABLED'] = 'false'; process.env['WITHDRAWALS_ENABLED'] = 'true'; await bootstrapSystemAccounts(db); });
afterEach(async () => {
  // Corrupt evidence and synthetic lifecycle rows must never enter another
  // suite's global payout sweep. These fixtures test reads, not worker sends.
  if (fixtureWithdrawalIds.length) await db.update(withdrawals).set({ status: 'cancelled' })
    .where(inArray(withdrawals.id, fixtureWithdrawalIds.splice(0)));
});
afterAll(async () => {
  if (originalMode === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = originalMode;
  if (originalEnabled === undefined) delete process.env['WITHDRAWALS_ENABLED']; else process.env['WITHDRAWALS_ENABLED'] = originalEnabled;
  await conn.sql.end();
});
async function fixture(instant = false) {
  const { wallet } = await createTestPlayer(db);
  await fundTestKeep(db, wallet, gross * 4n, 'test.withdrawal.receipt', randomUUID());
  const request: WithdrawalReceiptRequest = {
    idempotencyKey: randomUUID(), grossAmount: gross.toString(), feeBurned: fee.toString(), netAmount: (gross - fee).toString(),
    destination: Keypair.generate().publicKey.toBase58(), mode: instant ? 'instant' : 'standard', cluster: 'devnet', keepMint: randomWallet(),
  };
  const options = { instant, authorization: { challengeToken: 'synthetic-withdrawal-challenge-'.repeat(2), signature: bs58.encode(randomBytes(64)) },
    authorizationNetwork: { cluster: request.cluster, keepMint: request.keepMint } };
  return { wallet, request, options,
    submit: async () => {
      const row = await requestWithdrawal(db, wallet, gross, request.destination, request.idempotencyKey, options);
      fixtureWithdrawalIds.push(row.id); return row;
    },
    receipt: (query = request) => getWithdrawalReceipt(db, wallet, query),
  };
}

describe('withdrawal immutable acceptance receipt', () => {
  for (const instant of [false, true]) it(`proves the original ${instant ? 'instant' : 'standard'} freeze and keeps payout lifecycle separate`, async () => {
    const f = await fixture(instant); const row = await f.submit(); const before = await f.receipt();
    expect(before).toEqual({ version: 1, status: 'accepted', wallet: f.wallet, request: f.request,
      receiptId: row.requestLedgerTxnId, acceptedAt: expect.any(String), funding: { currency: 'KEEP', amount: gross.toString() },
      result: { withdrawalId: row.id, unbondsAt: row.unbondsAt.toISOString() } });
    // These mutable states are deliberately NOT proof of a payout or refund.
    for (const status of ['processing', 'sent', 'failed', 'refunded', 'cancelled'] as const) {
      await db.update(withdrawals).set({ status, mint: randomWallet(), txSignature: status === 'sent' ? bs58.encode(randomBytes(64)) : null,
        lastError: 'private operator payout detail', completedAt: new Date() }).where(eq(withdrawals.id, row.id));
      expect(await f.receipt()).toEqual(before);
    }
    const document = JSON.stringify(before);
    for (const secret of ['challengeToken', 'walletSignature', 'lastError', 'private operator', 'validatedDigest', 'unbondingHours']) expect(document).not.toContain(secret);
  });
  it('remains the original acceptance after an actual cancellation returns escrow', async () => {
    const f = await fixture(); const row = await f.submit(); const receipt = await f.receipt();
    await cancelWithdrawal(db, f.wallet, row.id);
    expect(await f.receipt()).toEqual(receipt);
    expect((await getOrCreatePlayerAccount(db, f.wallet, 'player_keep')).balance).toBe(gross * 4n);
  });
  it('requires exact key, original network, destination, mode and amounts', async () => {
    const f = await fixture(); await f.submit();
    for (const query of [
      { ...f.request, idempotencyKey: randomUUID() }, { ...f.request, cluster: 'mainnet-beta' as const },
      { ...f.request, keepMint: randomWallet() }, { ...f.request, destination: randomWallet() },
      { ...f.request, mode: 'instant' as const },
      { ...f.request, grossAmount: (gross + 1n).toString(), netAmount: (gross + 1n - fee).toString() },
      { ...f.request, feeBurned: (fee + 1n).toString(), netAmount: (gross - fee - 1n).toString() },
    ]) expect((await f.receipt(query)).status).toBe('unknown');
    const other = await createTestPlayer(db);
    expect((await getWithdrawalReceipt(db, other.wallet, f.request)).status).toBe('unknown');
  });
  it('does not reconstruct authorization network for legacy rows or infer acceptance from a balance', async () => {
    const f = await fixture();
    expect((await f.receipt()).status).toBe('unknown');
    const row = await requestWithdrawal(db, f.wallet, gross, f.request.destination, f.request.idempotencyKey);
    fixtureWithdrawalIds.push(row.id);
    expect((await f.receipt()).status).toBe('unknown');
  });
  it('requires exactly the original payer KEEP debit and system withdrawal escrow credit', async () => {
    const sys = await bootstrapSystemAccounts(db);
    for (const corruption of ['metadata', 'type', 'payer', 'credit', 'amount', 'missing-entries', 'foreign-row']) {
      const f = await fixture(); const other = await createTestPlayer(db);
      await fundTestKeep(db, other.wallet, gross * 2n, 'test.withdrawal.receipt.other', randomUUID());
      const payer = await getOrCreatePlayerAccount(db, corruption === 'payer' ? other.wallet : f.wallet, 'player_keep');
      const key = `withdrawal.request:${f.wallet}:${f.request.idempotencyKey}`;
      const metadata = { wallet: corruption === 'metadata' ? other.wallet : f.wallet, destination: f.request.destination, instant: false };
      const amount = corruption === 'amount' ? gross - 1n : gross;
      const txnId = corruption === 'missing-entries'
        ? (await db.insert(ledgerTransactions).values({ type: 'withdrawal.request', idempotencyKey: key, metadata }).returning())[0]!.id
        : (await postTransaction(db, { type: corruption === 'type' ? 'test.wrong' : 'withdrawal.request', idempotencyKey: key, metadata,
          entries: [{ account: payer.id, delta: -amount }, { account: corruption === 'credit' ? sys.keep_genesis : sys.withdrawal_escrow, delta: amount }] })).transaction.id;
      const [row] = await db.insert(withdrawals).values({ playerWallet: corruption === 'foreign-row' ? other.wallet : f.wallet,
        currency: 'KEEP', amount: gross, feeBurned: fee, destination: f.request.destination, requestLedgerTxnId: txnId, unbondsAt: new Date() }).returning();
      fixtureWithdrawalIds.push(row!.id);
      await db.insert(withdrawalAuthorizations).values({ withdrawalId: row!.id, challengeToken: f.options.authorization.challengeToken,
        walletSignature: f.options.authorization.signature, cluster: f.request.cluster, keepMint: f.request.keepMint });
      expect((await f.receipt()).status, corruption).toBe('unknown');
    }
  });
  for (const rollback of [false, true]) it(`serializes with a pending freeze and observes ${rollback ? 'rollback' : 'commit'}`, async () => {
    const f = await fixture();
    let entered!: () => void; let release!: () => void; let readerEntered!: () => void; let readerPid = 0;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const readingStarted = new Promise<void>((resolve) => { readerEntered = resolve; });
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction')
      .mockImplementationOnce((work, config) => transaction(async (tx) => {
        const result = await work(tx); entered(); await finish; if (rollback) throw new Error('test rollback'); return result;
      }, config))
      .mockImplementationOnce((work, config) => transaction(async (tx) => {
        const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
        readerPid = Number(result[0]!['pid']); readerEntered(); return work(tx);
      }, config));
    const writing = f.submit().then(() => null, (error: unknown) => error);
    let reading: ReturnType<typeof f.receipt> | undefined;
    try {
      await inside; reading = f.receipt(); await readingStarted;
      // Starting a promise before commit does not prove it took the writer's lock.
      await expect.poll(async () => {
        const rows = await conn.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${readerPid}`;
        return rows[0]?.['wait_event_type'];
      }, { timeout: 2_000 }).toBe('Lock');
      release(); expect((await writing) === null).toBe(!rollback);
      expect((await reading).status).toBe(rollback ? 'unknown' : 'accepted');
    } finally { release(); await Promise.allSettled([writing, reading]); spy.mockRestore(); }
  });
  it('rejects incomplete or noncanonical fields without accepting a client-supplied wallet or hold', () => {
    const valid = { idempotencyKey: 'receipt-query', grossAmount: '100', feeBurned: '2', netAmount: '98', destination: randomWallet(),
      mode: 'standard', cluster: 'devnet', keepMint: randomWallet() };
    expect(WithdrawalReceiptQuerySchema.safeParse(valid).success).toBe(true);
    for (const invalid of [{ ...valid, wallet: randomWallet() }, { ...valid, unbondingHours: 24 }, { ...valid, feeBurned: '3' },
      { ...valid, grossAmount: '0100' }, { ...valid, grossAmount: '1e2' }, { ...valid, idempotencyKey: 'bad key!' },
      { ...valid, keepMint: undefined }, { ...valid, grossAmount: '9'.repeat(33) }]) expect(WithdrawalReceiptQuerySchema.safeParse(invalid).success).toBe(false);
  });
});

it('negotiates proof support and authenticates private GETs after land loss without a recent-auth grant', async () => {
  const f = await fixture();
  await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, f.wallet));
  await f.submit();
  await db.update(players).set({ entryPaidAt: null }).where(eq(players.wallet, f.wallet));
  const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, f.wallet, session!.id) };
  const other = await createTestPlayer(db);
  const [otherSession] = await db.insert(sessions).values({ wallet: other.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  const otherCookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, other.wallet, otherSession!.id) };
  const app = await buildApp(TEST_CONFIG, db);
  const url = `/withdrawals/receipt?${new URLSearchParams(f.request)}`;
  const before = await db.select().from(accounts);
  try {
    process.env['WITHDRAWALS_ENABLED'] = 'false';
    expect((await app.inject({ url: '/withdrawals', cookies })).json().features).toEqual({ withdrawalReceipts: { version: 1 } });
    for (const [options, status, receiptStatus] of [
      [{ url, cookies }, 200, 'accepted'], [{ url }, 401, undefined],
      [{ url: `${url}&wallet=${f.wallet}`, cookies }, 400, undefined],
      [{ url: url.replace(`grossAmount=${gross}`, 'grossAmount=1e2'), cookies }, 400, undefined],
      [{ url, cookies: { ...cookies, [LOGIN_COOKIE]: 'pending' } }, 403, undefined],
      [{ url: url.replace(f.request.idempotencyKey, randomUUID()), cookies }, 200, 'unknown'],
      [{ url, cookies: otherCookies }, 200, 'unknown'],
    ] as const) {
      const response = await app.inject(options);
      expect(response.statusCode).toBe(status); expect(response.headers['cache-control']).toBe('private, no-store');
      if (receiptStatus) expect(response.json().status).toBe(receiptStatus);
    }
    expect(await db.select().from(accounts)).toEqual(before);
    await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session!.id));
    const revoked = await app.inject({ url, cookies }); expect(revoked.statusCode).toBe(401); expect(revoked.headers['cache-control']).toBe('private, no-store');
  } finally { process.env['WITHDRAWALS_ENABLED'] = 'true'; await app.close(); }
});
