/** Disposable, committed gameplay around the real local custody retirement.
 * No phase/ledger trigger is bypassed; this fixture grants no operator authority. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { buildApp } from '../../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { createDb } from '../../src/db/client';
import { applyFixtureL1Retirement } from '../../src/db/keepCustodyJournal';
import { runMigrations } from '../../src/db/migrate';
import { accounts, bases, ledgerEntries, ledgerTransactions, players, sessions } from '../../src/db/schema';
import { ensureStartingBase } from '../../src/game/base';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../../src/ledger';
import { ADMIN_DATABASE_URL } from '../db-url';
import { createTestPlayer, fundTestKeep, TEST_CONFIG } from '../helpers';

const FLAGS = ['GEMS_ENABLED', 'FREE_ONBOARDING', 'MULTI_BASE_ENABLED', 'HERO_RECRUITMENT_ENABLED'] as const;
export const key = () => randomUUID();
export const future = (minutes: number) => new Date(Date.now() + minutes * 60_000);

export async function custodySinkMatrixFixture() {
  const prior = Object.fromEntries(FLAGS.map(flag => [flag, process.env[flag]]));
  process.env['GEMS_ENABLED'] = 'true'; process.env['FREE_ONBOARDING'] = 'true';
  process.env['MULTI_BASE_ENABLED'] = 'false'; process.env['HERO_RECRUITMENT_ENABLED'] = 'true';
  const database = `shardkeep_custody_apply_${key().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + database;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Local custody fixture required');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${database}`);
  const conn = createDb(url.toString());
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  async function dispose() {
    try {
      await app?.close(); await conn.sql.end();
      await admin.unsafe(`drop database if exists ${database}`);
    } finally {
      await admin.end();
      for (const flag of FLAGS) {
        if (prior[flag] === undefined) delete process.env[flag]; else process.env[flag] = prior[flag];
      }
    }
  }
  try {
    await runMigrations(conn.db); await bootstrapSystemAccounts(conn.db);
    app = await buildApp(TEST_CONFIG, conn.db); await app.ready();
  } catch (error) { await dispose(); throw error; }
  const db = conn.db;
  async function player(keep = 1_000_000n) {
    const { wallet } = await createTestPlayer(db); await ensureStartingBase(db, wallet);
    if (keep > 0n) await fundTestKeep(db, wallet, keep, 'test.fund', key());
    await getOrCreatePlayerAccount(db, wallet, 'player_gems');
    const [session] = await db.insert(sessions).values({ wallet,
      expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    return { wallet, cookies };
  }
  async function stampLand(wallet: string) {
    const paid = new Date();
    await db.update(players).set({ entryPaidAt: paid }).where(eq(players.wallet, wallet));
    await db.update(bases).set({ landPaidAt: paid }).where(eq(bases.ownerWallet, wallet));
  }
  async function freeze() {
    const retained = await conn.sql<{ wallet: string; keep: string }[]>`
      select owner_wallet as wallet,balance::text as keep from accounts
      where kind='player_keep' and balance>0 order by owner_wallet`;
    await db.execute(sql`select shardkeep_advance_keep_custody_phase('open','fenced')`);
    await db.execute(sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`);
    await applyFixtureL1Retirement({ fixtureId: key(), asOf: new Date().toISOString(),
      players: retained.map(row => ({ ...row, internal: false })) },
    { HOLD_BEFORE_MIGRATE: '1', TEST_DATABASE_URL: url.toString() }, () => ({ db, close: async () => {} }));
  }
  const balances = async (wallet: string) => Promise.all(['player_keep', 'player_gems'].map(async kind =>
    (await getOrCreatePlayerAccount(db, wallet, kind as 'player_keep' | 'player_gems')).balance));
  const txn = async (idempotencyKey: string) => (await db.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, idempotencyKey)))[0];
  async function shape(id: string) {
    const legs = await db.select({ kind: accounts.kind, delta: ledgerEntries.delta }).from(ledgerEntries)
      .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, id));
    return legs.map(leg => `${leg.kind}:${leg.delta}`).sort();
  }
  const snapshot = async () => ({
    money: await conn.sql`select * from accounts order by id`,
    transactions: await conn.sql`select * from ledger_transactions order by id`,
    entries: await conn.sql`select * from ledger_entries order by id`,
    buildings: await conn.sql`select * from buildings order by id`,
    jobs: await conn.sql`select * from builder_jobs order by id`,
    raids: await conn.sql`select * from raids order by id`,
    commands: await conn.sql`select * from raid_commands order by id`,
    items: await conn.sql`select * from player_items order by player_wallet,item_id`,
    heroes: await conn.sql`select * from hero_levels order by player_wallet,hero`,
    training: await conn.sql`select * from training_queue order by id`,
    research: await conn.sql`select * from troop_research order by player_wallet,troop`,
    baseTraining: await conn.sql`select * from base_training_queue order by id`,
    baseResearch: await conn.sql`select * from base_troop_research order by base_id,troop`,
  });
  return { ...conn, app: app!, player, stampLand, freeze, balances, txn, shape, snapshot, dispose };
}
export type CustodySinkFixture = Awaited<ReturnType<typeof custodySinkMatrixFixture>>;
