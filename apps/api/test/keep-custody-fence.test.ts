/** Exercise the SQL boundary on a dedicated migrated fixture database. The
 * one-way latch never changes the shared API suite database. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { accounts, ledgerTransactions } from '../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { convertKeepToGems } from '../src/game/gems';
import { spendGems } from '../src/game/spend';
import { createTestPlayer, fundTestKeep } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';

describe('custody write fence and ordered phase barrier', () => {
  it('keeps open admission, serializes both freeze races, preserves receipts and blocks forged exceptions', async () => {
    const database = `shardkeep_custody_${randomUUID().replaceAll('-', '')}_test`;
    const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^shardkeep_custody_[0-9a-f]{32}_test$/.test(database)) throw new Error('unsafe fixture database');
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    let conn: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`create database ${database}`);
      conn = createDb(url.toString(), { max: 10 }); const { db } = conn;
      await runMigrations(db);
      await runMigrations(db);
      const migration = await readFile(new URL('../drizzle/0154_keep_custody_fence.sql', import.meta.url), 'utf8');
      await conn.sql.unsafe(migration);
      const phase = async () => (await conn!.sql`select phase from keep_custody_cutover_state`)[0]!.phase;
      const advance = (expected: string, target: string) => conn!.sql`select shardkeep_advance_keep_custody_phase(${expected},${target})`;
      expect(await phase()).toBe('open');
      const f = await createTestPlayer(db), sys = await bootstrapSystemAccounts(db);
      await fundTestKeep(db, f.wallet, 100n, 'test.fund', randomUUID());
      const keep = await getOrCreatePlayerAccount(db, f.wallet, 'player_keep');
      const converted = await convertKeepToGems(db, f.wallet, 40n, 'before-fence');
      const posting = { idempotencyKey: randomUUID(), type: 'fixture.drain', entries: [
        { account: keep.id, delta: -60n }, { account: sys.emission_pool, delta: 60n }] };
      await expect(conn.sql`update keep_custody_cutover_state set phase='fenced'`).rejects.toThrow('KEEP_CUSTODY_BARRIER_REQUIRED');
      // Temporary relations must not forge the catalog evidence for the
      // barrier, even in an operator session that legitimately owns the latch.
      await expect(conn.sql.begin(async tx => {
        await tx`create temporary table pg_locks on commit drop as select * from pg_catalog.pg_locks where false`;
        await tx`insert into pg_temp.pg_locks (pid,locktype,relation,mode,granted)
          select pg_backend_pid(),'relation',oid,'AccessExclusiveLock',true from pg_catalog.pg_class`;
        await tx`update public.keep_custody_cutover_state set phase='fenced'`;
      })).rejects.toThrow('KEEP_CUSTODY_BARRIER_REQUIRED');
      await expect(conn.sql`delete from keep_custody_cutover_state`).rejects.toThrow('KEEP_CUSTODY_STATE_IMMUTABLE');
      await expect(conn.sql`truncate keep_custody_cutover_state`).rejects.toThrow('KEEP_CUSTODY_STATE_IMMUTABLE');
      await expect(advance('open', 'frozen')).rejects.toThrow('KEEP_CUSTODY_PHASE_INVALID');

      // Posting wins: it holds normal ledger/account locks first. NOWAIT makes
      // the phase request fail atomically instead of reversing the lock order.
      let release!: () => void, posted!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { posted = resolve; });
      const inFlight = db.transaction(async tx => { const result = await postTransaction(tx, posting); posted(); await gate; return result; });
      try {
        await ready;
        await expect(advance('open', 'fenced')).rejects.toMatchObject({ code: '55P03' });
        expect(await phase()).toBe('open');
      } finally { release(); }
      const saved = await inFlight;
      await advance('open', 'fenced'); expect(await phase()).toBe('fenced');
      expect((await convertKeepToGems(db, f.wallet, 40n, 'before-fence')).receiptId).toBe(converted.receiptId);
      await expect(convertKeepToGems(db, f.wallet, 1n, 'after-fence')).rejects.toMatchObject({ cause: { message: 'KEEP_CUSTODY_CLOSING' } });
      const pendingId = randomUUID();
      await expect(conn.sql`insert into deposits (id,player_wallet,kind,reference) values (${pendingId},${f.wallet},'keep_deposit',${randomUUID()})`).rejects.toThrow('KEEP_CUSTODY_CLOSING');
      await expect(conn.sql`insert into withdrawals (player_wallet,currency,amount,destination,unbonds_at,request_ledger_txn_id)
        values (${f.wallet},'KEEP',1,${f.wallet},now(),${saved.transaction.id})`).rejects.toThrow('KEEP_CUSTODY_CLOSING');
      await conn.sql`insert into deposits (id,player_wallet,kind,reference) values (${pendingId},${f.wallet},'gems_buy',${randomUUID()})`;
      await conn.sql`update deposits set status='failed' where id=${pendingId}`;
      await advance('fenced', 'withdrawals_closed');
      await expect(advance('withdrawals_closed', 'fenced')).rejects.toThrow('KEEP_CUSTODY_PHASE_INVALID');

      // Measured liabilities, not flags, guard the final boundary.
      await fundTestKeep(db, f.wallet, 1n, 'test.refund', randomUUID());
      await expect(advance('withdrawals_closed', 'frozen')).rejects.toThrow('KEEP_CUSTODY_LIABILITY_NONZERO');
      expect(await phase()).toBe('withdrawals_closed');
      await postTransaction(db, { ...posting, idempotencyKey: randomUUID(), entries: [
        { account: keep.id, delta: -1n }, { account: sys.emission_pool, delta: 1n }] });

      // Freeze wins: a transaction begun before F must see F after its ordinary
      // ledger relation lock is released, and roll its claimed key back too.
      let thaw!: () => void, frozen!: () => void;
      const freezeGate = new Promise<void>(resolve => { thaw = resolve; });
      const freezeReady = new Promise<void>(resolve => { frozen = resolve; });
      const freeze = db.transaction(async tx => {
        await tx.execute(sql`select shardkeep_advance_keep_custody_phase('withdrawals_closed','frozen')`);
        frozen(); await freezeGate;
      });
      let pending: ReturnType<typeof postTransaction> | undefined;
      const lateKey = randomUUID();
      try {
        await freezeReady;
        pending = postTransaction(db, { ...posting, idempotencyKey: lateKey, entries: [
          { account: sys.keep_genesis, delta: -1n }, { account: keep.id, delta: 1n }] });
        const rejected = expect(pending).rejects.toMatchObject({ cause: { message: 'KEEP_CUSTODY_FROZEN' } });
        await expect.poll(async () => (await conn!.sql`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and cardinality(pg_blocking_pids(pid))>0`)[0]!.n).toBeGreaterThan(0);
        thaw(); await freeze; await rejected;
      } finally { thaw(); await Promise.allSettled([freeze, ...(pending ? [pending] : [])]); }
      expect(await phase()).toBe('frozen');
      expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, lateKey))).toEqual([]);
      expect((await db.select().from(accounts).where(eq(accounts.id, keep.id)))[0]!.balance).toBe(0n);
      expect((await postTransaction(db, posting)).transaction).toEqual(saved.transaction);
      expect((await postTransaction(db, posting)).entries).toEqual(saved.entries);
      for (const bypass of ['late-credit', 'operator-settle']) {
        await expect(db.transaction(async tx => {
          await tx.execute(sql`select set_config('shardkeep.keep_custody_cutover',${bypass},true)`);
          await postTransaction(tx, { ...posting, idempotencyKey: randomUUID(), entries: [
            { account: sys.keep_genesis, delta: -1n }, { account: keep.id, delta: 1n }] });
        })).rejects.toMatchObject({ cause: { message: 'KEEP_CUSTODY_FROZEN' } });
      }
      await expect(conn.sql`update accounts set balance=1 where id=${keep.id}`).rejects.toThrow('KEEP_CUSTODY_FROZEN');
      await expect(conn.sql`update accounts set kind='player_gems',currency='GEMS' where id=${keep.id}`).rejects.toThrow('KEEP_CUSTODY_FROZEN');
      await expect(conn.sql`delete from accounts where id=${keep.id}`).rejects.toThrow('KEEP_CUSTODY_FROZEN');
      await spendGems(db, f.wallet, 1n, 'fixture.gems', randomUUID());
      for (const kind of ['withdrawal_escrow', 'forge_payout_escrow', 'mail_keep_escrow', 'league_entitlement_escrow'] as const) {
        await expect(postTransaction(db, { idempotencyKey: randomUUID(), type: 'fixture.new-obligation', entries: [
          { account: sys.emission_pool, delta: -1n }, { account: sys[kind], delta: 1n }] })).rejects.toMatchObject({ cause: { message: 'KEEP_CUSTODY_FROZEN' } });
      }
      await expect(postTransaction(db, { idempotencyKey: randomUUID(), type: 'fixture.forge-reservation', entries: [
        { account: sys.shard_genesis, delta: -1n }, { account: sys.forge_escrow, delta: 1n }] })).rejects.toMatchObject({ cause: { message: 'KEEP_CUSTODY_FROZEN' } });
      await expect(conn.sql`insert into base_forge_positions (base_id,day) values (${randomUUID()},'2035-01-01')`).rejects.toThrow('KEEP_CUSTODY_FROZEN');
      await expect(conn.sql`insert into forge_contributions (player_wallet,day,shards) values (${f.wallet},'2035-01-01',1)`).rejects.toThrow('KEEP_CUSTODY_FROZEN');
      await postTransaction(db, { idempotencyKey: randomUUID(), type: 'fixture.non-custodial', entries: [
        { account: sys.keep_genesis, delta: -1n }, { account: sys.emission_pool, delta: 1n }] });
      await expect(advance('frozen', 'retired')).rejects.toThrow('KEEP_CUSTODY_RETIREMENT_ATTESTATION_REQUIRED');
      expect(await phase()).toBe('frozen');
    } finally {
      await conn?.sql.end(); await admin.unsafe(`drop database if exists ${database} with (force)`); await admin.end();
    }
  }, 30_000);
});
