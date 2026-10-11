/** D-152: a converted player can keep playing, while exact command consent and
 * immutable receipts survive F. These are isolated, rolled-back local fixtures. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db/client';
import { applyFixtureL1Retirement } from '../src/db/keepCustodyJournal';
import { runMigrations } from '../src/db/migrate';
import { convertKeepToGems } from '../src/game/gems';
import { spendGameCurrency } from '../src/game/spend';
import { withClientCurrency, withClientCurrencyContext } from '../src/game/clientCurrency';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { ADMIN_DATABASE_URL } from './db-url';
import { createTestPlayer, fundTestKeep, TEST_CONFIG } from './helpers';

const database = `shardkeep_custody_apply_${randomUUID().replaceAll('-', '')}_test`;
const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('unsafe custody sink fixture');
const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
let conn: ReturnType<typeof createDb>;
beforeAll(async () => {
  await admin.unsafe(`create database ${database}`);
  conn = createDb(url.toString(), { max: 1 });
  await runMigrations(conn.db);
});
afterAll(async () => {
  await conn?.sql.end();
  try { await admin.unsafe(`drop database if exists ${database}`); } finally { await admin.end(); }
});

async function fixture(run: (f: {
  db: Db; wallet: string; freeze: () => Promise<void>;
  spend: (amount: bigint, key?: string) => ReturnType<typeof spendGameCurrency>;
  balances: () => Promise<bigint[]>; snapshot: () => Promise<string>;
}) => Promise<void>) {
  vi.stubEnv('GEMS_ENABLED', 'true');
  const rollback = new Error('rollback custody sink fixture');
  try {
    await conn.db.transaction(async tx => {
      const db = tx as unknown as Db;
      const { wallet } = await createTestPlayer(db);
      await fundTestKeep(db, wallet, 20n, 'test.fund', randomUUID());
      const balances = async () => Promise.all(['player_keep', 'player_gems'].map(async kind =>
        (await getOrCreatePlayerAccount(db, wallet, kind as 'player_keep' | 'player_gems')).balance));
      await balances();
      const freeze = async () => {
        const [keep] = await balances();
        await db.execute(sql`select shardkeep_advance_keep_custody_phase('open','fenced')`);
        await db.execute(sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`);
        await applyFixtureL1Retirement({ fixtureId: randomUUID(), asOf: '2035-01-01T00:00:00.000Z',
          players: keep! > 0n ? [{ wallet, keep: keep!.toString(), internal: false }] : [] },
        { HOLD_BEFORE_MIGRATE: '1', TEST_DATABASE_URL: url.toString() }, () => ({ db, close: async () => {} }));
      };
      const spend = (amount: bigint, key: string = randomUUID()) => spendGameCurrency(db, wallet, amount, 'fixture.custody_sink', key);
      const snapshot = async () => JSON.stringify(await db.execute(sql`select
        (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
        (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,
        (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries`));
      await withClientCurrency(undefined, () => run({ db, wallet, freeze, spend, balances, snapshot }));
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  finally { vi.unstubAllEnvs(); }
}

describe('ordinary sinks after custodial KEEP retirement', () => {
  it.each([undefined, 'KEEP', 'GEMS'] as const)('charges only Gems for preference %s after genuine L1 conversion', async currency => fixture(async f => {
    await f.freeze();
    const posted = await withClientCurrency(currency, () => f.spend(7n));
    expect(posted).toMatchObject({ currency: 'GEMS', duplicate: false });
    expect(await f.balances()).toEqual([0n, 13n]);
    const legs = await f.db.execute(sql`select a.kind,a.currency,e.delta::text from ledger_entries e
      join accounts a on a.id=e.account_id where e.txn_id=${posted.transaction.id} order by a.kind::text`);
    expect(legs).toEqual([{ kind: 'gems_sink', currency: 'GEMS', delta: '7' },
      { kind: 'player_gems', currency: 'GEMS', delta: '-7' }]);
  }));

  it('returns typed INSUFFICIENT_GEMS to code 25 with no partial debit or claimed key', async () => fixture(async f => {
    await f.freeze();
    const before = await f.snapshot();
    const app = await buildApp(TEST_CONFIG, f.db);
    app.post('/fixture-custody-sink', () => f.spend(21n));
    try {
      const response = await app.inject({ method: 'POST', url: '/fixture-custody-sink' });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_GEMS',
        costGems: '21', gemsBalance: '20', keepCustodial: '0' } });
      expect(await f.snapshot()).toBe(before);
    } finally { await app.close(); }
  }));

  it('never silently changes an exact KEEP command, while exact Gems remains usable', async () => fixture(async f => {
    await f.freeze();
    const before = await f.snapshot();
    await expect(withClientCurrencyContext({ currency: 'GEMS', expectedCurrency: 'KEEP' }, () => f.spend(7n)))
      .rejects.toMatchObject({ statusCode: 409, code: 'CURRENCY_CONSENT_CHANGED',
        details: { expectedCurrency: 'KEEP', cost: '7', reason: 'currency_unavailable' } });
    expect(await f.snapshot()).toBe(before);
    expect(await withClientCurrencyContext({ currency: 'KEEP', expectedCurrency: 'GEMS' }, () => f.spend(7n)))
      .toMatchObject({ currency: 'GEMS', duplicate: false });
    expect(await f.balances()).toEqual([0n, 13n]);
  }));

  it('replays an old KEEP receipt after F before checking current consent or available currency', async () => fixture(async f => {
    const key = randomUUID();
    const old = await f.spend(7n, key);
    expect(old.currency).toBe('KEEP');
    await f.freeze();
    await withClientCurrency('GEMS', () => f.spend(13n));
    const before = await f.snapshot();
    for (const expectedCurrency of [undefined, 'KEEP', 'GEMS'] as const) {
      expect(await withClientCurrencyContext({ currency: undefined, expectedCurrency }, () => f.spend(7n, key)))
        .toEqual({ ...old, duplicate: true });
    }
    expect(await f.snapshot()).toBe(before);
    expect(await f.balances()).toEqual([0n, 0n]);
  }));

  it('recovers an old Gems receipt with empty balances and after the Gems flag is paused', async () => fixture(async f => {
    await f.freeze();
    const key = randomUUID();
    const old = await withClientCurrency('GEMS', () => f.spend(20n, key));
    const before = await f.snapshot();
    expect(await f.spend(20n, key)).toEqual({ ...old, duplicate: true });
    vi.stubEnv('GEMS_ENABLED', 'false');
    for (const expectedCurrency of [undefined, 'KEEP', 'GEMS'] as const) {
      expect(await withClientCurrencyContext({ currency: undefined, expectedCurrency }, () => f.spend(20n, key)))
        .toEqual({ ...old, duplicate: true });
    }
    expect(await f.snapshot()).toBe(before);
    expect(await f.balances()).toEqual([0n, 0n]);
  }));

  it('leaves the flag-off KEEP shape unchanged and refuses new spending after F when Gems is paused', async () => fixture(async f => {
    vi.stubEnv('GEMS_ENABLED', 'false');
    const old = await withClientCurrency('GEMS', () => f.spend(7n));
    expect(old.currency).toBe('KEEP');
    const [receipt] = await f.db.execute<{ metadata: Record<string, unknown> }>(sql`select metadata from ledger_transactions where id=${old.transaction.id}`);
    expect(receipt!.metadata).toEqual({ wallet: f.wallet, recycled: true });
    await f.freeze();
    const before = await f.snapshot();
    const app = await buildApp(TEST_CONFIG, f.db);
    app.post('/fixture-custody-sink', () => f.spend(1n));
    try {
      const response = await app.inject({ method: 'POST', url: '/fixture-custody-sink' });
      expect(response.statusCode, response.body).toBe(423);
      expect(response.json()).toMatchObject({ error: { code: 'KEEP_CUSTODY_FROZEN' } });
      expect(await f.snapshot()).toBe(before);
    } finally { await app.close(); }
  }));

  it('surfaces a real fence race as typed 423 without interpreting it as a balance shortfall', async () => fixture(async f => {
    await convertKeepToGems(f.db, f.wallet, 20n, randomUUID());
    await f.db.execute(sql`select shardkeep_advance_keep_custody_phase('open','fenced')`);
    await f.db.execute(sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`);
    // Flip after the shim observes withdrawals_closed but before the ledger's
    // account-lock/fence check. The posting savepoint must roll back this test
    // trigger's phase flip together with its newly claimed key.
    await f.db.execute(sql`create function fixture_freeze_before_sink() returns trigger language plpgsql as $$
      begin
        if NEW.type='fixture.custody_sink' then
          perform shardkeep_advance_keep_custody_phase('withdrawals_closed','frozen');
        end if;
        return NEW;
      end $$`);
    await f.db.execute(sql`create trigger fixture_freeze_before_sink before insert on ledger_transactions
      for each row execute function fixture_freeze_before_sink()`);
    const before = await f.snapshot();
    const app = await buildApp(TEST_CONFIG, f.db);
    app.post('/fixture-custody-sink', () => f.spend(1n));
    try {
      const response = await app.inject({ method: 'POST', url: '/fixture-custody-sink' });
      expect(response.statusCode, response.body).toBe(423);
      expect(response.json()).toMatchObject({ error: { code: 'KEEP_CUSTODY_FROZEN' } });
      expect(await f.snapshot()).toBe(before);
      expect(await f.balances()).toEqual([0n, 20n]);
    } finally { await app.close(); }
  }));
});
