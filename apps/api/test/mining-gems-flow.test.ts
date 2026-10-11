import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { getOrCreatePlayerAccount, postTransaction } from '../src/ledger';
import { convertKeepToGems, convertGemsToShards } from '../src/game/gems';
import { fundGemsRewardBudget, grantGems } from '../src/game/gemsGrants';
import { spendGems, spendGameCurrency, refundPostedSpend } from '../src/game/spend';
import { initializeGemsFlowEvidence, readGemsFlowEvidence } from '../src/mining/gemsFlowEvidence';
import { withGemsFlow, migration } from './fixtures/gemsFlow';

describe('complete prospective Gems flow source facts', () => {
 it('orders actual conversions, grants, sinks, refund and excluded SHARDS without assigning mixed origins', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 100n, randomUUID());
  await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'fixture.budget', entries: [{ account: f.sys.keep_genesis, delta: -50n }, { account: f.sys.emission_pool, delta: 50n }] });
  await fundGemsRewardBudget(f.conn.db, 50n, randomUUID()); await grantGems(f.conn.db, { wallet: f.wallet, gems: 50n, reason: 'dev' });
  const spent = await spendGems(f.conn.db, f.wallet, 20n, 'raid.buffs', randomUUID());
  await refundPostedSpend(f.conn.db, spent, randomUUID(), 'raid.buffs.system_refund', { originalTxnId: spent.transaction.id });
  await convertGemsToShards(f.conn.db, f.wallet, 10n, randomUUID()); await f.close();
  const e = await f.read(); expect(e.facts.filter(x => x.sourceTable === 'ledger_entries').map(x => x.classification)).toEqual(['custodial-conversion', 'grant', 'system-spend', 'sink-refund', 'excluded-gems-to-shards']);
  expect(e.netGems).toBe('140'); expect(e.usefulChainCreditAuthorized).toBe(false); expect(e.allocationReady).toBe(false); expect(e.hasSourceMutations).toBe(false);
  expect(e.facts.every(x => /^\d+$/.test(x.transactionMarker) && /\.\d{6}Z$/.test(x.observedAt))).toBe(true);
  const refund = e.facts.find(x => x.classification === 'sink-refund'); expect(refund?.source).toMatchObject({ transaction: { metadata: { originalTxnId: spent.transaction.id } } });
 }), 30000);
 it('does not turn original KEEP fallback or a misleading speedup label into a Gems spend', async () => withGemsFlow(async f => {
  const paid = await spendGameCurrency(f.conn.db, f.wallet, 10n, 'build.speedup', randomUUID(), {}, { currency: 'GEMS' }); expect(paid.currency).toBe('KEEP');
  await convertKeepToGems(f.conn.db, f.wallet, 10n, randomUUID()); await spendGems(f.conn.db, f.wallet, 10n, 'build.speedup', randomUUID(), { jobId: randomUUID() }); await f.close();
  const e = await f.read(); expect(e.facts.filter(x => x.classification === 'system-spend')).toHaveLength(1); expect(e.netGems).toBe('0'); expect(e.usefulChainCreditAuthorized).toBe(false);
 }), 30000);
 it('retains inserts, changed debits and deletion in one transaction, including later transaction identity mutation', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 100n, randomUUID()); let txn = '';
  // Owner edit with plain DELETEs and no trigger paused: 0302 (K-night-E1) stopped the 0267 crafting guard swallowing them.
  await f.conn.db.transaction(async tx => {
   const spent = await spendGems(tx, f.wallet, 10n, 'hero.recruit', randomUUID()); txn = spent.transaction.id;
   await tx.execute(sql`update ledger_entries set delta=-11 where txn_id=${txn}::uuid and account_id=${f.gems.id}::uuid`);
   await tx.execute(sql`delete from ledger_entries where txn_id=${txn}::uuid`);
   await tx.execute(sql`update ledger_transactions set type='relabeled' where id=${txn}::uuid`);
   await tx.execute(sql`delete from ledger_transactions where id=${txn}::uuid`);
  }); await f.close(); const e = await f.read();
  const changes = e.facts.filter(x => x.transactionId === txn); expect(changes.map(x => x.operation)).toEqual(['INSERT', 'UPDATE', 'DELETE', 'DELETE', 'UPDATE', 'DELETE']);
  expect(changes.filter(x => x.operation === 'DELETE' && x.sourceTable === 'ledger_entries').map(x => x.accountId).sort()).toEqual([f.gems.id, f.sys.gems_sink].sort()); expect(new Set(changes.map(x => x.transactionMarker)).size).toBe(1); expect(e.hasSourceMutations).toBe(true); expect(e.netGems).toBe(null);
  expect(changes[0]?.source).toMatchObject({ entry: { delta: '-10' }, transaction: { type: 'hero.recruit' } });
 }), 30000);
 it('preserves negative-only account attribution and rejects destructive truncation', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 10n, randomUUID()); const spent = await spendGems(f.conn.db, f.wallet, 10n, 'hero.recruit', randomUUID());
  // The origin-bearing account stays immutable while its positive Gems entry exists (stronger 0161 rule).
  await expect(f.conn.sql`delete from accounts where id=${f.gems.id}`).rejects.toThrow('MINING_FREE_ATTRIBUTION_IMMUTABLE');
  await f.conn.sql.begin(async tx => {
   await tx`delete from ledger_entries where account_id=${f.gems.id}`; await tx`delete from accounts where id=${f.gems.id}`;
  }); await f.close();
  const e = await f.read(); expect(e.facts.some(x => x.sourceTable === 'accounts' && x.operation === 'DELETE')).toBe(true); expect(e.hasSourceMutations).toBe(true);
  // Include dependent witness tables so PostgreSQL reaches the source-retention
  // trigger instead of rejecting this attempt during foreign-key preflight.
  await expect(f.conn.sql`truncate ledger_entries cascade`).rejects.toThrow('MINING_GEMS_FLOW_SOURCE_RETAINED');
  expect(e.facts.some(x => x.transactionId === spent.transaction.id && x.operation === 'INSERT')).toBe(true);
 }), 30000);
 it('keeps historical cutoffs stable after later destructive edits, pause and migration retry', async () => withGemsFlow(async f => {
  const p = await convertKeepToGems(f.conn.db, f.wallet, 20n, randomUUID()); await f.close(); const before = await f.read();
  await f.conn.sql.begin(async tx => {
   await tx`delete from ledger_entries where txn_id=${p.receiptId}`; await tx`delete from ledger_transactions where id=${p.receiptId}`;
  });
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); await f.conn.sql.unsafe(migration);
  const conn = createDb(f.url.toString()); try { expect(await readGemsFlowEvidence(conn.db, { wallet: f.wallet, day: '2035-01-01' })).toEqual(before); } finally { await conn.sql.end(); }
 }), 30000);
 it('keeps unknown credits explicit and never treats a retirement label as proven payment', async () => withGemsFlow(async f => {
  await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'gems.late_credit', metadata: { wallet: f.wallet }, entries: [{ account: f.keep.id, delta: -5n }, { account: f.sys.emission_pool, delta: 5n }, { account: f.sys.gems_mint, delta: -5n }, { account: f.gems.id, delta: 5n }] }); await f.close();
  const e = await f.read(); expect(e.facts.filter(x => x.sourceTable === 'ledger_entries')[0]?.classification).toBe('unclassified'); expect(e.hasUnclassified).toBe(true); expect(e.usefulChainCreditAuthorized).toBe(false);
 }), 30000);
 it('stays dormant until explicit initialization and refuses births before independent flow coverage at microsecond precision', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 5n, randomUUID()); expect(await f.conn.sql`select id from mining_gems_flow_events`).toHaveLength(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); await expect(initializeGemsFlowEvidence(f.conn.db)).rejects.toMatchObject({ code: 'DISABLED' }); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  await f.clock('2035-01-01T00:00:00.000001Z'); await initializeGemsFlowEvidence(f.conn.db); await f.close(); await expect(f.read()).rejects.toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
 }, false), 30000);
 it('refuses birth relabel, caller authority, open days, source contention and unsupported isolation', async () => withGemsFlow(async f => {
  await expect(f.read()).rejects.toMatchObject({ code: 'DAY_OPEN' }); await f.close();
  await expect(readGemsFlowEvidence(f.conn.db, { wallet: f.wallet, day: '2035-01-01', credited: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(readGemsFlowEvidence(f.conn.db, { wallet: '1'.repeat(100000), day: '2035-01-01' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  let release!: () => void, ready!: () => void; const gate = new Promise<void>(r => release = r), started = new Promise<void>(r => ready = r);
  const writer = f.conn.sql.begin(async tx => { await tx`lock table ledger_entries in row exclusive mode`; ready(); await gate; }); try { await started; await expect(f.read()).rejects.toMatchObject({ code: 'BUSY' }); } finally { release(); await writer; }
  await expect(f.conn.db.transaction(async tx => { await tx.execute(sql`set transaction isolation level repeatable read`); await readGemsFlowEvidence(tx, { wallet: f.wallet, day: '2035-01-01' }); })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await f.clock('2035-01-01T12:00:00Z'); await f.conn.sql`update players set created_at='2035-01-01T00:00:00.000001Z' where wallet=${f.wallet}`; await f.close(); await expect(f.read()).rejects.toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
 }), 30000);
 it('bounds decoded data before returning metadata and refuses non-owner forgery', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 20n, randomUUID()); await spendGems(f.conn.db, f.wallet, 1n, 'hero.recruit', randomUUID(), { payload: 'x'.repeat(1024 * 1024 + 1) }); await f.close(); await expect(f.read()).rejects.toMatchObject({ code: 'TOO_LARGE' });
  const role = `gems_flow_${randomUUID().replaceAll('-', '')}`; await f.admin.unsafe(`create role ${role}`);
  try { await f.conn.sql.unsafe(`grant all on all tables in schema public to ${role}; grant all on all sequences in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
   await expect(f.conn.sql.begin(async tx => { await tx.unsafe(`set local role ${role}`); await tx`insert into mining_gems_flow_coverage(id) values(true)`; })).rejects.toThrow('MINING_GEMS_FLOW_IMMUTABLE');
   await expect(f.conn.sql.begin(async tx => { await tx.unsafe(`set local role ${role}`); await tx`create temporary table ledger_entries(id bigint,txn_id uuid,account_id uuid,delta bigint) on commit drop`; await tx`create trigger ledger_entries_mining_gems_flow_capture after insert on pg_temp.ledger_entries for each row execute function public.shardkeep_capture_mining_gems_flow()`; await tx`insert into pg_temp.ledger_entries values(1,${randomUUID()},${f.gems.id},1)`; })).rejects.toThrow('MINING_GEMS_FLOW_SOURCE_INVALID');
   await expect(f.conn.sql`delete from mining_gems_flow_events`).rejects.toThrow('MINING_GEMS_FLOW_IMMUTABLE');
  } finally { await f.conn.sql.unsafe(`drop owned by ${role}`); await f.admin.unsafe(`drop role ${role}`); }
 }), 30000);
 it('proves covered zero without a balance lookup or cohort enrollment', async () => withGemsFlow(async f => { await f.close(); const e = await f.read(); expect(e.netGems).toBe('0'); expect(e.facts.filter(x => x.sourceTable === 'ledger_entries')).toHaveLength(0); expect(e.allocationReady).toBe(false); }), 30000);
 it('refuses a birth and balances from before initialization even when their timestamps equal the boundary', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 20n, randomUUID()); await initializeGemsFlowEvidence(f.conn.db); await f.close(); await expect(f.read()).rejects.toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
 }, false), 30000);
 it('records counterparty edits and extra receipt legs as mutations without rewriting the original posting', async () => withGemsFlow(async f => {
  const p = await convertKeepToGems(f.conn.db, f.wallet, 20n, randomUUID());
  await f.conn.sql`update ledger_entries set delta=21 where txn_id=${p.receiptId} and account_id=${f.sys.emission_pool}`;
  await f.conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${p.receiptId},${f.sys.emission_pool},1,22)`;
  await f.close(); const e = await f.read(); expect(e.hasSourceMutations).toBe(true); expect(e.netGems).toBe(null);
  const original = e.facts.find(x => x.classification === 'custodial-conversion'); expect(original?.receipt).toEqual(expect.arrayContaining([expect.objectContaining({ accountId: f.sys.emission_pool, delta: '20' })]));
  expect(e.facts.filter(x => x.accountId === f.sys.emission_pool).map(x => x.operation)).toEqual(['UPDATE', 'INSERT']);
 }), 30000);
 it('records system account identity edits for wallets whose copied receipts used that account', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 20n, randomUUID());
  await f.conn.sql.begin(async tx => {
   await tx`delete from ledger_entries where account_id=${f.sys.emission_pool}`; await tx`delete from accounts where id=${f.sys.emission_pool}`;
  });
  await f.close(); const e = await f.read(); expect(e.facts.some(x => x.sourceTable === 'accounts' && x.accountId === f.sys.emission_pool && x.operation === 'DELETE')).toBe(true); expect(e.hasSourceMutations).toBe(true);
 }), 30000);
 it('marks a structurally backed wallet posting as ledger-only, retaining its deposit and signature identifiers', async () => withGemsFlow(async f => {
  const depositId = randomUUID(), signature = 'fixture-finality-is-not-authorized';
  await postTransaction(f.conn.db, { idempotencyKey: `deposit:${depositId}:credit`, type: 'gems.buy', metadata: { wallet: f.wallet, depositId, txSignature: signature, gems: '20', keep: '20', rate: 1, source: 'wallet' }, entries: [{ account: f.sys.onchain_inflow, delta: -20n }, { account: f.sys.emission_pool, delta: 20n }, { account: f.sys.gems_mint, delta: -20n }, { account: f.gems.id, delta: 20n }] }); await f.close();
  const e = await f.read(); expect(e.facts.find(x => x.classification === 'wallet-conversion-ledger')?.source).toMatchObject({ transaction: { metadata: { depositId, txSignature: signature } } }); expect(e.usefulChainCreditAuthorized).toBe(false);
 }), 30000);
 it('does not silently truncate a receipt larger than its bounded complete-source capacity', async () => withGemsFlow(async f => {
  await convertKeepToGems(f.conn.db, f.wallet, 100n, randomUUID());
  await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'fixture.many_legs', entries: Array.from({ length: 17 }, () => [{ account: f.gems.id, delta: -1n }, { account: f.sys.gems_sink, delta: 1n }]).flat() }); await f.close(); await expect(f.read()).rejects.toMatchObject({ code: 'TOO_LARGE' });
 }), 30000);
 it('requires exact birth-capture trigger function and timing before initializing', async () => withGemsFlow(async f => {
  await f.conn.sql`alter table players disable trigger players_mining_free_capture`;
  await expect(initializeGemsFlowEvidence(f.conn.db)).rejects.toMatchObject({ cause: { message: 'MINING_GEMS_FLOW_BIRTH_COVERAGE_REQUIRED' } });
  expect(await f.conn.sql`select id from mining_gems_flow_coverage`).toHaveLength(0);
  expect((await f.conn.sql`select tgenabled from pg_trigger where tgrelid='public.ledger_entries'::regclass and tgname='ledger_entries_mining_gems_flow_capture'`)[0]?.tgenabled).toBe('D');
 }, false), 30000);

 it('makes a cross-wallet database transaction crossing midnight visible only as a whole at its last observation', async () => withGemsFlow(async f => {
  const other = Keypair.generate().publicKey.toBase58(); await f.conn.sql`insert into players(wallet,created_at) values(${other},'2035-01-01T00:00:00Z')`;
  const keep = await getOrCreatePlayerAccount(f.conn.db, other, 'player_keep');
  await postTransaction(f.conn.db, { idempotencyKey: randomUUID(), type: 'fixture.keep', entries: [{ account: f.sys.keep_genesis, delta: -20n }, { account: keep.id, delta: 20n }] });
  await convertKeepToGems(f.conn.db, f.wallet, 20n, randomUUID()); await convertKeepToGems(f.conn.db, other, 20n, randomUUID());
  await f.clock('2035-01-01T23:59:59.999999Z');
  await f.conn.db.transaction(async tx => {
   await spendGems(tx, f.wallet, 5n, 'hero.recruit', randomUUID()); await f.clock('2035-01-02T00:00:00.000001Z'); await spendGems(tx, other, 5n, 'hero.recruit', randomUUID());
  }); await f.clock('2035-01-03T00:00:00Z');
  for (const wallet of [f.wallet, other]) {
   const earlier = await readGemsFlowEvidence(f.conn.db, { wallet, day: '2035-01-01' }), later = await readGemsFlowEvidence(f.conn.db, { wallet, day: '2035-01-02' });
   expect(earlier.netGems).toBe('20'); expect(earlier.facts.some(x => x.classification === 'system-spend')).toBe(false); expect(later.netGems).toBe('15');
   const spend = later.facts.find(x => x.classification === 'system-spend'); expect(spend?.effectiveObservedAt).toBe('2035-01-02T00:00:00.000001Z'); expect(later.sourcePolicyVersion).toBe(1);
   if (wallet === f.wallet) expect(spend?.observedAt).toBe('2035-01-01T23:59:59.999999Z');
   vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); expect(await readGemsFlowEvidence(f.conn.db, { wallet, day: '2035-01-01' })).toEqual(earlier);
  }
 }), 30000);

 it('rejects too many candidate events before group lookups or JSON decoding even if all would be excluded', async () => {
  const wallet = Keypair.generate().publicKey.toBase58(), queries: string[] = [], dialect = new PgDialect();
  const db = { transaction: async (read: (tx: unknown) => Promise<unknown>) => read({ execute: async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
   const query = dialect.sqlToQuery(statement).sql; queries.push(query);
   if (query.startsWith('lock table')) return [];
   if (query.includes('transaction_isolation')) return [{ closed: true, isolation: 'read committed' }];
   if (query.includes('as started from mining_gems_flow_coverage')) return [{ started: '2035-01-01T00:00:00.000000Z' }];
   if (query.includes('from mining_free_cohort_events e cross join')) return [{ id: '1', operation: 'INSERT', valid: true }];
   if (query.includes('as candidate_count')) return [{ candidate_count: '10001' }];
   throw new Error('Unbounded candidate set reached group lookup or decoded source');
  } }) } as unknown as Parameters<typeof readGemsFlowEvidence>[0];
  await expect(readGemsFlowEvidence(db, { wallet, day: '2035-01-01' })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  expect(queries.some(query => query.includes('later.transaction_marker'))).toBe(false);
  expect(queries.some(query => query.includes('before_state::text'))).toBe(false);
 });

});
