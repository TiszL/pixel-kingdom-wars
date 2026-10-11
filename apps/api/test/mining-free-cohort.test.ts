/** Prospective identity only: a fixture clock cannot create retrospective eligibility. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { BUILD_COSTS, GEMS } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { enrollInitialFreeCohort, readFreeCohortInterval, initializeFreeCohortCoverage } from '../src/mining/freeCohort';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { convertKeepToGems } from '../src/game/gems';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, initialize = true) {
  const f = await setup(initialize);
  try { await run(f); } finally { vi.unstubAllEnvs(); await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.name} with (force)`); await f.admin.end(); }
}
async function setup(initialize: boolean) {
  const name = `mining_cohort_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('fixture host required');
  url.pathname = `/${name}`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} }); await createMigratedDatabase(admin, name);
  const conn = createDb(url.toString(), { max: 4 });
  try { await runMigrations(conn.db);
  // Only the dedicated new clock is replaced, only in this generated fixture DB.
  const clock = async (value: string) => { await conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`); };
  await clock('2035-01-01T12:00:00Z');
  if (initialize) await initializeFreeCohortCoverage(conn.db);
  const wallet = Keypair.generate().publicKey.toBase58(), buyer = Keypair.generate().publicKey.toBase58(), baseId = randomUUID();
  await conn.sql`insert into players(wallet,created_at) values(${wallet},'2035-01-01T12:00:00Z'),(${buyer},'2035-01-01T12:00:00Z')`;
  await conn.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${wallet},${BUILD_COSTS.workshop.requiresKeepLevel})`;
  await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${baseId})`;
  await conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${wallet},${baseId},'keep',${BUILD_COSTS.workshop.requiresKeepLevel},10,10),(${wallet},${baseId},'workshop',1,20,20)`;
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  const context = { baseId, assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], w: string, b: string) => { await assertFreshLockedBaseAuthority(tx, w, b, new Date('2035-01-01T12:00:00Z')); } };
  const enroll = () => enrollInitialFreeCohort(conn.db, wallet, context);
  return { name, admin, conn, wallet, buyer, baseId, clock, enroll, context };
  } catch (error) { await conn.sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); throw error; }
}
describe('initial free mining cohort', () => {
  it('freezes a next-day baseline, ignores navigation, and retains prior valid days after an out/back transfer', async () => fixture(async f => {
    const baseline = await f.enroll(); expect(baseline.effectiveFrom).toBe('2035-01-02T00:00:00.000Z');
    expect(await f.enroll()).toEqual(baseline);
    await f.conn.sql`update base_slots set selected_at=now() where base_id=${f.baseId}`;
    await f.conn.sql`update players set last_seen_at=now() where wallet=${f.wallet}`;
    await f.clock('2035-01-03T12:00:00Z');
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-01')).valid).toBe(false);
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).valid).toBe(true);
    await f.conn.sql`update bases set owner_wallet=${f.buyer} where id=${f.baseId}`;
    await f.conn.sql`update bases set owner_wallet=${f.wallet} where id=${f.baseId}`;
    await f.clock('2035-01-04T00:00:00Z');
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).valid).toBe(true);
    const invalid = await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-03');
    expect(invalid.valid).toBe(false); expect(invalid.events).toHaveLength(2);
    expect(await f.enroll()).toEqual(baseline);
    await expect(f.conn.sql`update mining_free_cohorts set baseline='{}'`).rejects.toThrow('MINING_FREE_HISTORY_IMMUTABLE');
    await expect(f.conn.sql`delete from mining_free_cohort_events`).rejects.toThrow('MINING_FREE_HISTORY_IMMUTABLE');
  }), 30_000);
  it('refuses a second base ever, missing completed development, paid and revoked Seeker states', async () => fixture(async f => {
    await f.conn.sql`update buildings set level=0 where base_id=${f.baseId} and type='workshop'`;
    await expect(f.enroll()).rejects.toMatchObject({ cause: { message: 'MINING_FREE_DEVELOPMENT_REQUIRED' } });
    await f.conn.sql`update buildings set level=1 where base_id=${f.baseId} and type='workshop'`;
    const other = randomUUID(); await f.conn.sql`insert into bases(id,owner_wallet) values(${other},${f.wallet})`;
    await f.conn.sql`delete from bases where id=${other}`;
    await expect(f.enroll()).rejects.toMatchObject({ cause: { message: 'MINING_FREE_NOT_INITIAL' } });
    await f.conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint,revoked_at) values(${f.wallet},${f.wallet},'fixture-sgt',now())`;
    await expect(f.enroll()).rejects.toMatchObject({ cause: { message: 'MINING_FREE_INELIGIBLE' } });
    await f.conn.sql`delete from seeker_links where wallet=${f.wallet}`;

  }), 30_000);
  it('records membership, mint and Seeker out/back facts without blocking abandonment', async () => fixture(async f => {
    await f.enroll(); await f.clock('2035-01-02T12:00:00Z');
    await f.conn.sql`update bases set deed_mint_asset_id='fixture-reservation' where id=${f.baseId}`;
    await f.conn.sql`update bases set deed_mint_asset_id=null where id=${f.baseId}`;
    await f.conn.sql`update base_slots set active=false where base_id=${f.baseId}`;
    await f.conn.sql`update base_slots set active=true where base_id=${f.baseId}`;
    await f.conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.wallet},${f.wallet},'fixture-sgt')`;
    await f.conn.sql`delete from seeker_links where wallet=${f.wallet}`;
    await f.conn.sql`delete from buildings where base_id=${f.baseId}`;
    await f.conn.sql`delete from base_slots where base_id=${f.baseId}`;
    await f.conn.sql`delete from bases where id=${f.baseId}`;
    await f.clock('2035-01-03T00:00:00Z');
    const result = await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02');
    expect(result.valid).toBe(false); expect(result.events).toHaveLength(8);
  }), 30_000);
  it('rejects erased paid and pending-mint histories before enrollment', async () => fixture(async f => {
    await f.conn.sql`update bases set land_paid_at=now(),deed_mint_asset_id='fixture-paid' where id=${f.baseId}`;
    await f.conn.sql`update bases set land_paid_at=null,deed_mint_asset_id=null where id=${f.baseId}`;
    await expect(f.enroll()).rejects.toMatchObject({ cause: { message: 'MINING_FREE_INELIGIBLE' } });
  }), 30_000);
  it.each(['gems.from_keep', 'gems.buy'])('captures %s credit, keeps welcome allowed, and retains payment attribution', async type => fixture(async f => {
    const sys = await bootstrapSystemAccounts(f.conn.db), keep = BigInt(GEMS.minConvertKeep);
    const keepAccount = await getOrCreatePlayerAccount(f.conn.db, f.wallet, 'player_keep');
    const gemsAccount = await getOrCreatePlayerAccount(f.conn.db, f.wallet, 'player_gems');
    await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'fixture.keep', entries: [
      { account: sys.keep_genesis, delta: -keep }, { account: keepAccount.id, delta: keep }], metadata: {} });
    // A balanced fixture welcome receipt is allowed; its attribution may not be rewritten into a paid receipt.
    const welcome = await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'gems.grant', entries: [
      { account: keepAccount.id, delta: -keep }, { account: sys.emission_pool, delta: keep },
      { account: sys.gems_mint, delta: -keep }, { account: gemsAccount.id, delta: keep }], metadata: { reason: 'welcome' } });
    await f.enroll(); await f.clock('2035-01-03T00:00:00Z');
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).valid).toBe(true);
    await expect(f.conn.sql`update ledger_transactions set type='gems.buy' where id=${welcome.transaction.id}`).rejects.toThrow('MINING_FREE_ATTRIBUTION_IMMUTABLE');
    await expect(f.conn.sql`update accounts set owner_wallet=${f.buyer} where id=${gemsAccount.id}`).rejects.toThrow('MINING_FREE_ATTRIBUTION_IMMUTABLE');
    await f.clock('2035-01-03T12:00:00Z');
    await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'fixture.keep', entries: [
      { account: sys.keep_genesis, delta: -keep }, { account: keepAccount.id, delta: keep }], metadata: {} });
    if (type === 'gems.from_keep') await convertKeepToGems(f.conn.db, f.wallet, keep, randomUUID());
    else await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type, entries: [
      { account: keepAccount.id, delta: -keep }, { account: sys.emission_pool, delta: keep },
      { account: sys.gems_mint, delta: -keep }, { account: gemsAccount.id, delta: keep }], metadata: { fixtureOnly: true } });
    await f.clock('2035-01-04T00:00:00Z');
    const result = await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-03');
    expect(result.valid).toBe(false); expect(result.events).toHaveLength(1);
    expect(result.events[0]!.afterState).toMatchObject({ source_type: type });
  }), 30_000);
  it('preserves same-transaction out/back evidence and atomically rolls failed enrollment back', async () => fixture(async f => {
    await expect(f.conn.sql.begin(async tx => {
      await tx`insert into mining_free_cohorts(wallet,base_id) values(${f.wallet},${f.baseId})`;
      await tx`update bases set status='inactive' where id=${f.baseId}`;
      throw new Error('fixture rollback');
    })).rejects.toThrow('fixture rollback');
    expect(await f.conn.sql`select * from mining_free_cohorts`).toHaveLength(0);
    await f.conn.sql.begin(async tx => {
      await tx`insert into mining_free_cohorts(wallet,base_id) values(${f.wallet},${f.baseId})`;
      await tx`update bases set status='inactive' where id=${f.baseId}`;
      await tx`update bases set status='active' where id=${f.baseId}`;
    });
    await f.clock('2035-01-03T00:00:00Z');
    const result = await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02');
    expect(result.valid).toBe(false); expect(result.events).toHaveLength(2);
  }), 30_000);
  it('rejects broad runtime grants and GUC forgery while normal source writes still append evidence', async () => fixture(async f => {
    const role = `cohort_runtime_${randomUUID().replaceAll('-', '')}`;
    await f.conn.sql.unsafe(`create role ${role}`);
    try {
      await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);
      await f.conn.sql.unsafe(`grant select,insert,update,delete on all tables in schema public to ${role}`);
      await f.conn.sql.unsafe(`grant usage,select on all sequences in schema public to ${role}`);
      await expect(f.conn.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`); await tx`select set_config('shardkeep.mining_free_writer','on',true)`;
        await tx`insert into mining_free_cohorts(wallet,base_id) values(${f.wallet},${f.baseId})`;
      })).rejects.toThrow('MINING_FREE_OWNER_REQUIRED');
      await expect(f.conn.sql.begin(async tx => {
        await tx.unsafe(`set local role ${role}`);
        await tx`insert into mining_free_cohort_events(wallet,observed_at,source_table,source_id,operation) values(${f.wallet},now(),'bases',${f.baseId},'INSERT')`;
      })).rejects.toThrow('MINING_FREE_HISTORY_IMMUTABLE');
      await f.enroll();
      await f.conn.sql.begin(async tx => { await tx.unsafe(`set local role ${role}`); await tx`update bases set status='inactive' where id=${f.baseId}`; });
      await f.clock('2035-01-03T00:00:00Z');
      expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).valid).toBe(false);
    } finally { await f.conn.sql.unsafe(`drop owned by ${role}`); await f.conn.sql.unsafe(`drop role ${role}`); }
  }), 30_000);
  it('refuses a busy capture snapshot and observes the committed source event on retry', async () => fixture(async f => {
    await f.enroll(); await f.clock('2035-01-03T00:00:00Z');
    let captured!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { captured = resolve; }), release = new Promise<void>(resolve => { finish = resolve; });
    const writer = f.conn.sql.begin(async tx => { await tx`update bases set status='inactive' where id=${f.baseId}`; captured(); await release; });
    await ready;
    try { await expect(readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).rejects.toMatchObject({ cause: { code: '55P03' } }); }
    finally { finish(); await writer; }
    await f.clock('2035-01-04T00:00:00Z');
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-03')).valid).toBe(false);
  }), 30_000);
  it('refuses a stale pre-coverage repeatable-read writer instead of silently omitting history', async () => fixture(async f => {
    expect(await f.conn.sql`select * from mining_free_cohort_events`).toHaveLength(0);
    await expect(f.conn.sql.begin(async tx => {
      await tx`set transaction isolation level repeatable read`;
      expect(await tx`select * from mining_free_coverage`).toHaveLength(0);
      await initializeFreeCohortCoverage(f.conn.db);
      // The slot source reaches this mining guard directly; newer Charter
      // guards independently require RC for every base identity write.
      await tx`update base_slots set active=false where base_id=${f.baseId}`;
    })).rejects.toMatchObject({ code: 'P0001', message: 'MINING_FREE_READ_COMMITTED_REQUIRED' });
    expect((await f.conn.sql`select active from base_slots where base_id=${f.baseId}`)[0]!.active).toBe(true);
    expect(await f.conn.sql`select * from mining_free_cohort_events`).toHaveLength(0);
  }, false), 30_000);
  it('keeps mining capture dormant before initialization while global writer isolation, busy activation and migration retry remain enforced', async () => fixture(async f => {
    const before = await f.conn.sql`select * from bases where id=${f.baseId}`;
    await expect(f.conn.sql.begin('isolation level repeatable read', async tx => {
      await tx`update bases set status='inactive' where id=${f.baseId}`;
    })).rejects.toMatchObject({ code: 'P0001', message: 'CLAN_CHARTER_CUSTODY_READ_COMMITTED' });
    expect(await f.conn.sql`select * from bases where id=${f.baseId}`).toEqual(before);
    // Dormant mining capture still allows a normal RC source writer; it does
    // not exempt that writer from later global Charter isolation protection.
    await f.conn.sql.begin(async tx => {
      await tx`update bases set status='inactive' where id=${f.baseId}`;
      await expect(initializeFreeCohortCoverage(f.conn.db)).rejects.toMatchObject({ cause: { code: '55P03' } });
    });
    expect(await f.conn.sql`select * from mining_free_coverage`).toHaveLength(0);
    expect(await f.conn.sql`select * from mining_free_cohort_events`).toHaveLength(0);
    await initializeFreeCohortCoverage(f.conn.db);
    const coverage = await f.conn.sql`select * from mining_free_coverage`;
    const migration = readFileSync(new URL('../drizzle/0161_mining_free_cohorts.sql', import.meta.url), 'utf8');
    await f.conn.sql.begin(async tx => { for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement); });
    expect(await f.conn.sql`select * from mining_free_coverage`).toEqual(coverage);
    expect((await f.conn.sql`select tgenabled from pg_trigger where tgname='bases_mining_free_capture'`)[0]!.tgenabled).toBe('O');
  }, false), 30_000);
  it('rejects an uncovered wallet birth even after created_at is relabeled', async () => fixture(async f => {
    await initializeFreeCohortCoverage(f.conn.db);
    await f.conn.sql`update players set created_at='2035-01-01T12:00:01Z' where wallet=${f.wallet}`;
    await f.clock('2035-01-01T13:00:00Z');
    await expect(f.enroll()).rejects.toMatchObject({ cause: { message: 'MINING_FREE_COVERAGE_UNAVAILABLE' } });
    await expect(f.conn.sql`truncate players cascade`).rejects.toThrow('MINING_FREE_BIRTH_RETAINED');
  }, false), 30_000);
  it('retains deletion/rebirth even when the current player row looks new', async () => fixture(async f => {
    await initializeFreeCohortCoverage(f.conn.db);
    await f.conn.sql`delete from players where wallet=${f.buyer}`;
    await f.conn.sql`insert into players(wallet,created_at) values(${f.buyer},'2035-01-01T12:00:00Z')`;
    const base = randomUUID();
    await f.conn.sql`insert into bases(id,owner_wallet,keep_level) values(${base},${f.buyer},${BUILD_COSTS.workshop.requiresKeepLevel})`;
    await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.buyer},1,${base})`;
    await expect(f.conn.sql`insert into mining_free_cohorts(wallet,base_id) values(${f.buyer},${base})`).rejects.toThrow('MINING_FREE_COVERAGE_UNAVAILABLE');
  }, false), 30_000);

  it('ignores cosmetic updates but invalidates a birth identity rewrite after enrollment', async () => fixture(async f => {
    await f.enroll();
    await f.conn.sql`update players set last_seen_at=now() where wallet=${f.wallet}`;
    await f.clock('2035-01-03T00:00:00Z');
    expect((await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-02')).valid).toBe(true);
    await f.conn.sql`update players set created_at=created_at+interval '1 second' where wallet=${f.wallet}`;
    await f.clock('2035-01-04T00:00:00Z');
    const changed = await readFreeCohortInterval(f.conn.db, f.wallet, '2035-01-03');
    expect(changed.valid).toBe(false); expect(changed.events).toHaveLength(1); expect(changed.events[0]!.sourceTable).toBe('players');
  }), 30_000);

});
