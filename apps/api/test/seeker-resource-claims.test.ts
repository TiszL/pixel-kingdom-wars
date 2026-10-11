import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { bases, baseSlots, harvesterEntries, resourceStocks } from '../src/db/schema';
import { claimSeekerResourceTax, readSeekerResourceClaim } from '../src/game/seekerResourceClaims';
import * as harvester from '../src/game/harvesterSettlement';
import { createResourceTaxFixture } from './fixtures/seekerResourceClaims';
import { createTestPlayer } from './helpers';
const conn = resourceClaimsDatabase(), db = conn.db;
const migration = readFileSync(new URL('../drizzle/0181_seeker_resource_claims.sql', import.meta.url), 'utf8');
beforeAll(async () => {
 await conn.setup();
 await conn.sql.unsafe("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='shardkeep_api_runtime') THEN CREATE ROLE shardkeep_api_runtime NOLOGIN;END IF;END $$");
 for (const statement of migration.split('--> statement-breakpoint')) await conn.sql.unsafe(statement);
});
afterAll(async () => { vi.unstubAllEnvs(); await conn.close(); });
// Fresh fixture claims explicitly enable the production gate; callbacks cannot bypass it.
beforeEach(()=>vi.stubEnv('PHASE_E_SEEKER_ENABLED','true'));
const enabled = { assertAdmission() {} };
const stock = async (baseId: string, resourceId: string) => (await db.select().from(resourceStocks)
 .where(and(eq(resourceStocks.baseId, baseId), eq(resourceStocks.resourceId, resourceId))))[0];

describe('Seeker original-winner raw-resource delivery', () => {
 it('pays equal King/regular shares of both real source ledgers into usable stock; tax receipts are not taxed again', async () => {
  const f = await createResourceTaxFixture(db), a = f.command(0), b = f.command(20);
  const first = await claimSeekerResourceTax(db, f.winner.wallet, a, f.authority, enabled);
  const second = await claimSeekerResourceTax(db, f.winner.wallet, b, f.authority, enabled);
  const pool = f.trip.tax + 3n, share = pool / 3n;
  expect(first).toMatchObject({ wallet: f.winner.wallet, termId: f.trip.termId, termHash: f.trip.termHash,
   resourceId: f.trip.resourceId, spotId: 0, poolTotal: pool.toString(), winnerCount: 3,
   previousTotal: '0', cumulativeTotal: share.toString(), quantity: share.toString(), shardsIncluded: false });
  expect(second.quantity).toBe(first.quantity);
  expect((await stock(f.baseId, f.trip.resourceId))!.available).toBe(share * 2n);
  const entries = await conn.sql`select bucket,delta::text from seeker_resource_claim_entries where claim_id=${first.id} order by bucket`;
  expect(entries).toEqual([{ bucket: 'base_stock', delta: share.toString() }, { bucket: 'island_pool', delta: (-share).toString() }]);
  expect(BigInt(first.poolTotal) - share * 3n).toBe(pool % 3n);
  expect(await db.select().from(harvesterEntries).where(eq(harvesterEntries.sourceId, f.harvester.id))).toHaveLength(45);
 });

 it('serializes last rights across simultaneous keys and permits exact recovery after reconnect', async () => {
  const f = await createResourceTaxFixture(db), command = f.command();
  const results = await Promise.all(Array.from({ length: 4 }, () => claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled)));
  expect(results.every(row => JSON.stringify(row) === JSON.stringify(results[0]))).toBe(true);
  await expect(claimSeekerResourceTax(db, f.winner.wallet, f.command(), f.authority, enabled)).rejects.toMatchObject({ code: 'SEEKER_RESOURCE_NOTHING_DUE' });
  const reopened = conn.reopen();
  try { expect(await readSeekerResourceClaim(reopened.db, f.winner.wallet, command.idempotencyKey)).toEqual(results[0]); }
  finally { await reopened.sql.end(); }
  expect((await stock(f.baseId, f.trip.resourceId))!.available.toString()).toBe(results[0]!.quantity);
 });

 it('keeps committed original-recipient replay through pause and transfer, while a new delivery refuses the sold base', async () => {
  const f = await createResourceTaxFixture(db), command = f.command(), original = await claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled);
  const buyer = await createTestPlayer(db);
  await db.transaction(async tx => { await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId)); await tx.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId)); });
  const paused = { assertAdmission() { throw new Error('paused'); } };
  expect(await claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, paused)).toEqual(original);
  await expect(claimSeekerResourceTax(db, f.winner.wallet, f.command(20), f.authority, enabled)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
  expect(await readSeekerResourceClaim(db, buyer.wallet, command.idempotencyKey)).toBeNull();
  expect((await stock(f.baseId, f.trip.resourceId))!.available.toString()).toBe(original.quantity);
 });

 it('recovers additional floor-difference rights from late original-term producer completion', async () => {
  const f = await createResourceTaxFixture(db, { singleWinner: true, settleHarvester: false });
  const first = await claimSeekerResourceTax(db, f.winner.wallet, f.command(), f.authority, enabled);
  expect(first.quantity).toBe(f.trip.tax.toString());
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.parse(f.source.snapshot.endsAt) + 1));
  try {
   await f.settle(15);
   const later = await claimSeekerResourceTax(db, f.winner.wallet, f.command(), f.authority, enabled);
   expect(later.quantity).toBe('3'); expect(later.previousTotal).toBe(first.cumulativeTotal);
   expect(later.termId).toBe(f.trip.termId);
  } finally { vi.useRealTimers(); }
 });

 it('refuses unsold/other-wallet spots, zero-winner pools and SHARDS without changing stock', async () => {
  const f = await createResourceTaxFixture(db);
  for (const spot of [1, 21]) await expect(claimSeekerResourceTax(db, f.winner.wallet, f.command(spot), f.authority, enabled)).rejects.toMatchObject({ code: 'SEEKER_RESOURCE_NOT_OWNER' });
  await expect(claimSeekerResourceTax(db, f.winner.wallet, { ...f.command(), resourceId: 'shards' }, f.authority, enabled)).rejects.toThrow();
  const zero = await createResourceTaxFixture(db, { zeroWinners: true });
  await expect(claimSeekerResourceTax(db, zero.winner.wallet, zero.command(), zero.authority, enabled)).rejects.toMatchObject({ code: 'SEEKER_RESOURCE_NOT_OWNER' });
  expect(await stock(f.baseId, f.trip.resourceId)).toBeUndefined();
 });

 it('requires the exact request on replay and defaults new admission off', async () => {
  const f = await createResourceTaxFixture(db), command = f.command();
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  await expect(claimSeekerResourceTax(db, f.winner.wallet, command, f.authority)).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');
  await claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled);
  await expect(claimSeekerResourceTax(db, f.winner.wallet, { ...command, spotId: 20 }, f.authority, enabled)).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  await expect(claimSeekerResourceTax(db, f.winner.wallet, { ...command, amount: '999' } as typeof command, f.authority, enabled)).rejects.toThrow();
 });

 it('rolls back both ledger and stock on overflow, then allows the same original request after capacity recovers', async () => {
  const f = await createResourceTaxFixture(db), command = f.command();
  await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.trip.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
  await expect(claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled)).rejects.toThrow();
  expect(await readSeekerResourceClaim(db, f.winner.wallet, command.idempotencyKey)).toBeNull();
  await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.baseId));
  const result = await claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled);
  expect((await stock(f.baseId, f.trip.resourceId))!.available.toString()).toBe(result.quantity);
 });

 it('migration retries preserve receipts and forbid rewriting, deleting, truncating or fabricating economic fields', async () => {
  const f = await createResourceTaxFixture(db), command = f.command(), original = await claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled);
  for (const statement of migration.split('--> statement-breakpoint')) await conn.sql.unsafe(statement);
  for (const query of [sql`update seeker_resource_claims set quantity=quantity+1 where id=${original.id}`, sql`delete from seeker_resource_claims where id=${original.id}`,
   sql`truncate seeker_resource_claims cascade`, sql`update seeker_resource_claim_entries set delta=delta+1 where claim_id=${original.id}`]) await expect(db.execute(query)).rejects.toThrow();
  await expect(db.execute(sql`insert into seeker_resource_claims(id,wallet,base_id,term_id,resource_id,spot_id,expected_pool,expected_previous,quantity)
   values(${randomUUID()},${f.winner.wallet},${f.baseId},${f.trip.termId},${f.trip.resourceId},20,${original.poolTotal},0,999)`)).rejects.toThrow();
  expect(await readSeekerResourceClaim(db, f.winner.wallet, command.idempotencyKey)).toEqual(original);
 });

 it('runtime INSERT cannot forge totals or recipients, or directly manufacture ledger legs', async () => {
  const f = await createResourceTaxFixture(db), total = f.trip.tax + 3n;
  for (const [wallet, pool, spot] of [[f.other.wallet, total, 0], [f.winner.wallet, total + 1n, 0], [f.winner.wallet, total, 21]] as const) {
   await expect(db.transaction(async tx => {
    await tx.execute(sql`set local role shardkeep_api_runtime`);
    await tx.execute(sql`insert into seeker_resource_claims(id,wallet,base_id,term_id,resource_id,spot_id,expected_pool,expected_previous)
     values(${randomUUID()},${wallet},${f.baseId},${f.trip.termId},${f.trip.resourceId},${spot},${pool.toString()},0)`);
   })).rejects.toThrow();
  }
  await expect(db.transaction(async tx => {
   await tx.execute(sql`set local role shardkeep_api_runtime`);
   await tx.execute(sql`insert into seeker_resource_claim_entries(claim_id,bucket,delta) values(${randomUUID()},'base_stock',999)`);
  })).rejects.toThrow();
  expect(await stock(f.baseId, f.trip.resourceId)).toBeUndefined();
  // The role may request a real owner's exact frozen rights; SQL derives all
  // economic columns and applies precisely the conserved stock effect.
  const id = randomUUID();
  await db.transaction(async tx => {
   await tx.execute(sql`set local role shardkeep_api_runtime`);
   await tx.execute(sql`insert into seeker_resource_claims(id,wallet,base_id,term_id,resource_id,spot_id,expected_pool,expected_previous)
    values(${id},${f.winner.wallet},${f.baseId},${f.trip.termId},${f.trip.resourceId},0,${total.toString()},0)`);
  });
  expect((await readSeekerResourceClaim(db, f.winner.wallet, id))!.quantity).toBe((total / 3n).toString());
 });

 it('refuses a missing producer ledger leg without treating a partial pool as complete', async () => {
  const f = await createResourceTaxFixture(db), command = f.command();
  // Owner-only corruption simulation in this disposable database. Restore the
  // exact row in finally; runtime never has this bypass or table privileges.
  const original = (await conn.sql`select * from harvester_entries where source_id=${f.harvester.id} and ordinal=1 and bucket='issued'`)[0]!;
  await conn.sql.begin(async tx => { await tx.unsafe('SET LOCAL session_replication_role=replica'); await tx`delete from harvester_entries where source_id=${f.harvester.id} and ordinal=1 and bucket='issued'`; });
  try {
   await expect(claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled)).rejects.toThrow('Invalid original Harvester event proof');
   expect(await stock(f.baseId, f.trip.resourceId)).toBeUndefined();
   expect(await readSeekerResourceClaim(db, f.winner.wallet, command.idempotencyKey)).toBeNull();
  } finally {
   await conn.sql.begin(async tx => { await tx.unsafe('SET LOCAL session_replication_role=replica'); await tx`insert into harvester_entries(source_id,ordinal,bucket,delta) values(${original.source_id},${original.ordinal},${original.bucket},${original.delta})`; });
  }
 });

 it('refuses a source-total race atomically and recovers the same key from newly completed receipts', async () => {
  const f = await createResourceTaxFixture(db, { singleWinner: true, settleHarvester: false }), command = f.command();
  const read = harvester.readHarvesterSettlement;
  const spy = vi.spyOn(harvester, 'readHarvesterSettlement').mockImplementationOnce(async (...args) => {
   const old = await read(...args); await f.settle(15); return old;
  });
  try {
   await expect(claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled)).rejects.toMatchObject({ code: 'SEEKER_RESOURCE_SOURCE_CHANGED' });
   expect(await stock(f.baseId, f.trip.resourceId)).toBeUndefined();
   expect(await readSeekerResourceClaim(db, f.winner.wallet, command.idempotencyKey)).toBeNull();
  } finally { spy.mockRestore(); }
  expect((await claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled)).quantity).toBe((f.trip.tax + 3n).toString());
 });

 it('bounds persisted source bytes before decoding a large original JSON body', async () => {
  const f = await createResourceTaxFixture(db), command = f.command();
  const original = (await conn.sql`select home_evidence from harvester_sources where id=${f.harvester.id}`)[0]!.home_evidence;
  await conn.sql.begin(async tx => {
   await tx.unsafe('SET LOCAL session_replication_role=replica');
   await tx`update harvester_sources set home_evidence=home_evidence||jsonb_build_object('oversized',repeat('x',9*1024*1024)) where id=${f.harvester.id}`;
  });
  try {
   await expect(claimSeekerResourceTax(db, f.winner.wallet, command, f.authority, enabled)).rejects.toMatchObject({ code: 'SEEKER_RESOURCE_SOURCE_BOUNDS' });
   expect(await stock(f.baseId, f.trip.resourceId)).toBeUndefined();
  } finally {
   await conn.sql.begin(async tx => { await tx.unsafe('SET LOCAL session_replication_role=replica'); await tx`update harvester_sources set home_evidence=${JSON.stringify(original)}::jsonb where id=${f.harvester.id}`; });
  }
 });

 it('serializes different winning wallets and spots against one original pool', async () => {
  const f = await createResourceTaxFixture(db), [destination] = await db.insert(bases).values({ ownerWallet: f.other.wallet, status: 'active' }).returning();
  await db.insert(baseSlots).values({ wallet: f.other.wallet, slot: 1, baseId: destination!.id });
  const other = { ...f.command(21), baseId: destination!.id };
  const results = await Promise.all([
   claimSeekerResourceTax(db, f.winner.wallet, f.command(0), f.authority, enabled),
   claimSeekerResourceTax(db, f.winner.wallet, f.command(20), f.authority, enabled),
   claimSeekerResourceTax(db, f.other.wallet, other, { ...f.authority, baseId: destination!.id }, enabled),
  ]);
  const paid = results.reduce((sum, row) => sum + BigInt(row.quantity), 0n), total = f.trip.tax + 3n;
  expect(paid).toBe(total / 3n * 3n); expect(total - paid).toBe(total % 3n);
  expect((await stock(f.baseId, f.trip.resourceId))!.available + (await stock(destination!.id, f.trip.resourceId))!.available).toBe(paid);
 });
});
