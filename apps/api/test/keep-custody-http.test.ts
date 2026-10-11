/** Installed clients must recover accepted money receipts across the custody
 * cutover, while new custodial obligations stop atomically at the DB fence. */
import { randomBytes, randomUUID } from 'node:crypto';
import { TOKEN } from '@shardkeep/shared';
import bs58 from 'bs58';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { deposits, ledgerTransactions, sessions } from '../src/db/schema';
import { bootstrapEconomyAllocations, bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { createDepositIntent, creditDeposit } from '../src/money/deposits';
import { createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';

const database = `phase_e_custody_http_${randomUUID().replaceAll('-', '')}_test`;
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || !/^phase_e_custody_http_[0-9a-f]{32}_test$/.test(database)) throw new Error('unsafe custody HTTP fixture database');
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
let conn: ReturnType<typeof createDb>;
beforeAll(async () => {
  await admin.unsafe(`create database ${database}`);
  conn = createDb(url.toString(), { max: 4 });
  await runMigrations(conn.db);
  await bootstrapEconomyAllocations(conn.db);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await conn?.sql.end();
  try { await admin.unsafe(`drop database if exists ${database}`); } finally { await admin.end(); }
});

describe('custody cutover through the authenticated API', () => {
  it('closes new KEEP admission, drains an accepted payment once, and recovers conversion receipts after freeze and pause', async () => {
    vi.stubEnv('GEMS_ENABLED', 'true');
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    // Every phase and player belongs to this rolled-back fixture transaction;
    // the shared test database is left in its default-open phase afterwards.
    const rollback = new Error('rollback custody HTTP fixture');
    try { await conn.db.transaction(async tx => {
      const db = tx as unknown as Db;
      const system = await bootstrapSystemAccounts(db);
      const { wallet } = await createTestPlayer(db);
      await fundTestKeep(db, wallet, 10n, 'test.fund', randomUUID());
      const [session] = await db.insert(sessions).values({ wallet,
        expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
      const app = await buildApp(TEST_CONFIG, db);
      await app.ready();
      try {
        const post = (url: string, payload: object) => app.inject({ method: 'POST', url, cookies, payload });
        const phase = (from: string, to: string) => db.execute(sql`select shardkeep_advance_keep_custody_phase(${from}, ${to})`);
        const key = randomUUID();
        const accepted = await post('/gems/from-keep', { keep: '5', idempotencyKey: key });
        expect(accepted.statusCode, accepted.body).toBe(201);
        const receiptId = accepted.json().receiptId;
        const deposit = await createDepositIntent(db, wallet, 'keep_deposit');

        await phase('open', 'fenced');
        const closingKey = randomUUID();
        const closed = await post('/gems/from-keep', { keep: '1', idempotencyKey: closingKey });
        expect(closed.statusCode, closed.body).toBe(423);
        expect(closed.json()).toMatchObject({ error: { code: 'KEEP_CUSTODY_CLOSING' } });
        const newDeposit = await post('/deposits', { kind: 'keep_deposit' });
        expect(newDeposit.statusCode, newDeposit.body).toBe(423);
        expect(newDeposit.json()).toMatchObject({ error: { code: 'KEEP_CUSTODY_CLOSING' } });

        // Finality authority is injected at the existing verified-payment seam.
        // This is an already accepted intent, never a newly admitted deposit.
        const payment = { wallet, kind: 'keep_deposit' as const,
          lamports: 2n * 10n ** BigInt(TOKEN.decimals), txSignature: bs58.encode(randomBytes(64)), finalized: true as const };
        expect(await creditDeposit(db, deposit.id, payment)).toMatchObject({ credited: true });
        expect(await creditDeposit(db, deposit.id, payment)).toMatchObject({ credited: false });
        const [credited] = await db.select().from(deposits).where(eq(deposits.id, deposit.id));
        expect(credited?.status).toBe('credited');
        const keep = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
        expect(keep.balance).toBe(7n);

        // An ordinary pre-freeze KEEP spend remains possible while accepted
        // obligations drain. No retirement mint or operator bypass is used.
        const spend = { idempotencyKey: randomUUID(), type: 'fixture.legacy_spend', entries: [
          { account: keep.id, delta: -7n }, { account: system.emission_pool, delta: 7n },
        ] };
        const posted = await postTransaction(db, spend);
        await phase('fenced', 'withdrawals_closed');
        await phase('withdrawals_closed', 'frozen');

        // The definitive retirement refusal wins over a misleading zero-funds
        // error, and the rejected attempt leaves no claimed idempotency key.
        const frozenKey = randomUUID();
        const frozen = await post('/gems/from-keep', { keep: '1', idempotencyKey: frozenKey });
        expect(frozen.statusCode, frozen.body).toBe(423);
        expect(frozen.json()).toMatchObject({ error: { code: 'KEEP_CUSTODY_FROZEN' } });
        for (const rejected of [closingKey, frozenKey]) {
          expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
            `gems:from-keep:${wallet}:${rejected}`))).toEqual([]);
        }
        const replay = await post('/gems/from-keep', { keep: '5', idempotencyKey: key });
        expect(replay.statusCode, replay.body).toBe(200);
        expect(replay.json()).toMatchObject({ receiptId, duplicate: true, gems: '5', keep: '5' });
        expect(await postTransaction(db, spend)).toMatchObject({ duplicate: true, transaction: { id: posted.transaction.id } });
        expect((await getOrCreatePlayerAccount(db, wallet, 'player_keep')).balance).toBe(0n);
        expect((await getOrCreatePlayerAccount(db, wallet, 'player_gems')).balance).toBe(5n);

        vi.stubEnv('GEMS_ENABLED', 'false');
        const receipt = await app.inject({ method: 'GET', url: `/gems/from-keep/by-key/${key}`, cookies });
        expect(receipt.statusCode, receipt.body).toBe(200);
        expect(receipt.headers['cache-control']).toBe('private, no-store');
        expect(receipt.json()).toMatchObject({ status: 'accepted', receipt: { receiptId } });
      } finally { await app.close(); }
      throw rollback;
    }); } catch (error) { if (error !== rollback) throw error; }
  });
});
