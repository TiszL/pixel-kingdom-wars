/** SQL/service boundary fixtures only, NOT authorized raid outcomes. Root's raw
 * raid suite separately exercises the canonical freeze/settlement writer. */
import { randomUUID } from 'node:crypto';
import { FORGE_INGOT } from '@shardkeep/shared';
import { PHASE_E_RAW_RESOURCE_IDS } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { DbTx } from '../src/db/client';
import { bases, baseSlots, raids, rawRaidAllocations, rawRaidEntries, rawRaidReservationDebits, rawRaidResources, rawRaidSnapshots, rawRaidTerminals, resourceStockEntries, resourceStockOperations, resourceStocks } from '../src/db/schema';
import { consumeRawStockReservation, readRawStockReservationRemainder, readResourceStockProof, releaseRawStockReservation, reserveRawStock } from '../src/game/resourceStock';
import { connectTestDb, createTestPlayer } from './helpers';
const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
const resourceId = PHASE_E_RAW_RESOURCE_IDS[0];
const domain = BigInt(FORGE_INGOT.rawStockTheftDivisor);
async function fixture(small = false) {
  const { wallet } = await createTestPlayer(db), attacker = await createTestPlayer(db);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active' }).returning();
  const [attackBase] = await db.insert(bases).values({ ownerWallet: attacker.wallet, status: 'active' }).returning();
  const baseId = base!.id, attackerBaseId = attackBase!.id;
  await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  await db.insert(resourceStocks).values({ baseId, resourceId, available: domain });
  const authority = { baseId, assertAuthority: async () => {} };
  const original = await reserveRawStock(db, wallet, { operationId: randomUUID(), baseId, resourceId, quantity: small ? 1n : domain }, authority);
  if (small) await reserveRawStock(db, wallet, { operationId: randomUUID(), baseId, resourceId, quantity: domain - 1n }, authority);
  return { wallet, attacker: attacker.wallet, baseId, attackerBaseId, original, quantity: small ? 1n : domain };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function freeze(f: Fixture, keepId: string | null = randomUUID()) {
  return db.transaction(async tx => {
    const [raid] = await tx.insert(raids).values({ attackerWallet: f.attacker, attackerBaseId: f.attackerBaseId,
      defenderWallet: f.wallet, defenderBaseId: f.baseId, seed: 1n, snapshot: {}, armySnapshot: {}, ordersDeadlineAt: new Date() }).returning();
    const raidId = raid!.id;
    await tx.insert(rawRaidSnapshots).values({ raidId, attackerBaseId: f.attackerBaseId, defenderBaseId: f.baseId,
      keepId, frozenDivisor: FORGE_INGOT.rawStockTheftDivisor, theftVersion: FORGE_INGOT.rawStockTheftVersion, frozenAt: new Date(0) });
    await tx.insert(rawRaidResources).values(PHASE_E_RAW_RESOURCE_IDS.map(id => ({ raidId, resourceId: id,
      available: 0n, reserved: id === resourceId ? domain : 0n, maximum: id === resourceId ? 1n : 0n, fromAvailable: 0n })));
    await tx.insert(rawRaidAllocations).values({ raidId, resourceId, reservationId: f.original.operation.id, quantity: 1n });
    return raidId;
  });
}
async function writeLoss(tx: DbTx, f: Fixture, raidId: string, releaseOperationId: string | null = null) {
  const bucket = releaseOperationId ? 'available' as const : 'reserved' as const;
  await tx.insert(rawRaidTerminals).values({ raidId, outcome: 'transferred', reason: 'synthetic_sql_fixture', settledAt: new Date() });
  await tx.insert(rawRaidReservationDebits).values({ raidId, resourceId, reservationId: f.original.operation.id, quantity: 1n, bucket, releaseOperationId });
  await tx.insert(rawRaidEntries).values(PHASE_E_RAW_RESOURCE_IDS.flatMap(id => [
    { raidId, resourceId: id, bucket: 'defender_available' as const, delta: id === resourceId && bucket === 'available' ? -1n : 0n },
    { raidId, resourceId: id, bucket: 'defender_reserved' as const, delta: id === resourceId && bucket === 'reserved' ? -1n : 0n },
    { raidId, resourceId: id, bucket: 'attacker_available' as const, delta: id === resourceId ? 1n : 0n },
  ]));
  // Projection mutation is intentionally fixture-only, not a production escape.
  await tx.update(resourceStocks).set(bucket === 'reserved' ? { reserved: sql`${resourceStocks.reserved} - 1` } : { available: sql`${resourceStocks.available} - 1` })
    .where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, resourceId)));
  await tx.insert(resourceStocks).values({ baseId: f.attackerBaseId, resourceId, available: 1n });
}
const lose = (f: Fixture, raidId: string, releaseOperationId: string | null = null) => db.transaction(tx => writeLoss(tx, f, raidId, releaseOperationId));
const stock = async (f: Fixture) => (await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, resourceId))))[0]!;

describe('D153.20 original reservation impairment', () => {
  it('retains original accepted quantity and releases only the residual exactly once', async () => {
    const f = await fixture(), raidId = await freeze(f); await lose(f, raidId);
    expect(await readResourceStockProof(db, f.original.operation.id)).toEqual(f.original);
    expect(await readRawStockReservationRemainder(db, f.original.operation.id)).toMatchObject({ lost: 1n, remaining: domain - 1n, terminal: null });
    const key = randomUUID(), released = await releaseRawStockReservation(db, key, f.original.operation.id);
    expect(released.operation).toMatchObject({ quantity: domain, effectiveQuantity: domain - 1n });
    expect(await releaseRawStockReservation(db, key, f.original.operation.id)).toEqual(released);
    expect(await readResourceStockProof(db, key)).toEqual(released);
    await expect(releaseRawStockReservation(db, randomUUID(), f.original.operation.id)).rejects.toMatchObject({ code: 'RESOURCE_RESERVATION_SETTLED' });
    expect(await stock(f)).toMatchObject({ available: domain - 1n, reserved: 0n });
  });
  it('refuses to complete an impaired job even after later new credits replenish inventory', async () => {
    const f = await fixture(), raidId = await freeze(f); await lose(f, raidId);
    await db.update(resourceStocks).set({ available: domain }).where(eq(resourceStocks.baseId, f.baseId));
    const key = randomUUID();
    await expect(consumeRawStockReservation(db, key, f.original.operation.id)).rejects.toMatchObject({ code: 'RESOURCE_RESERVATION_IMPAIRED' });
    expect(await readResourceStockProof(db, key)).toBeNull();
    expect(await stock(f)).toMatchObject({ available: domain, reserved: domain - 1n });
  });
  it('allows one zero-residual release with two explicit zero legs, not a second grant', async () => {
    const f = await fixture(true), raidId = await freeze(f); await lose(f, raidId);
    const key = randomUUID(), proof = await releaseRawStockReservation(db, key, f.original.operation.id);
    expect(proof.operation).toMatchObject({ quantity: 1n, effectiveQuantity: 0n });
    expect(proof.entries.map(e => e.delta)).toEqual([0n, 0n]);
    expect(await readResourceStockProof(db, key)).toEqual(proof);
    expect(await stock(f)).toMatchObject({ available: 0n, reserved: domain - 1n });
  });
  it('follows an original released claim without retroactively impairing its receipt', async () => {
    const f = await fixture(), raidId = await freeze(f);
    const release = await releaseRawStockReservation(db, randomUUID(), f.original.operation.id);
    await lose(f, raidId, release.operation.id);
    expect(await readResourceStockProof(db, release.operation.id)).toEqual(release);
    expect(await readRawStockReservationRemainder(db, f.original.operation.id)).toMatchObject({ lost: 0n, remaining: domain, terminal: release });
    expect(await stock(f)).toMatchObject({ available: domain - 1n, reserved: 0n });
  });
  it('rolls back residual terminal and projection together with a failed enclosing job', async () => {
    const f = await fixture(), raidId = await freeze(f); await lose(f, raidId); const key = randomUUID();
    await expect(db.transaction(async tx => { await releaseRawStockReservation(tx, key, f.original.operation.id); throw new Error('job cancellation failed'); })).rejects.toThrow('job cancellation failed');
    expect(await readResourceStockProof(db, key)).toBeNull();
    expect(await stock(f)).toMatchObject({ available: 0n, reserved: domain - 1n });
  });
  it('keeps legacy full-release evidence readable without adding modern fields to the old proof', async () => {
    const f = await fixture(), key = randomUUID();
    await db.transaction(async tx => {
      await tx.insert(resourceStockOperations).values({ id: key, kind: 'release', baseId: f.baseId, resourceId, quantity: domain, custodyWallet: f.wallet, reservationId: f.original.operation.id });
      await tx.insert(resourceStockEntries).values([{ operationId: key, bucket: 'reserved', delta: -domain }, { operationId: key, bucket: 'available', delta: domain }]);
      await tx.update(resourceStocks).set({ available: domain, reserved: 0n }).where(eq(resourceStocks.baseId, f.baseId));
    });
    expect((await readResourceStockProof(db, key))!.operation.effectiveQuantity).toBeNull();
  });
});

describe('raw raid SQL evidence boundaries', () => {
  it('rejects a reserved loss after release instead of invalidating historical proof', async () => {
    const f = await fixture(), raidId = await freeze(f), release = await releaseRawStockReservation(db, randomUUID(), f.original.operation.id);
    await expect(lose(f, raidId)).rejects.toThrow();
    expect(await readResourceStockProof(db, release.operation.id)).toEqual(release);
    expect(await db.select().from(rawRaidTerminals).where(eq(rawRaidTerminals.raidId, raidId))).toEqual([]);
  });
  it('rejects a released-unit loss linked to another reservation', async () => {
    const f = await fixture(), other = await fixture(), raidId = await freeze(f);
    const release = await releaseRawStockReservation(db, randomUUID(), other.original.operation.id);
    await expect(lose(f, raidId, release.operation.id)).rejects.toThrow();
    expect(await stock(f)).toMatchObject({ reserved: domain });
  });
  it('requires remaining original quantity for future allocation, not the original face value', async () => {
    const f = await fixture(true), first = await freeze(f); await lose(f, first);
    expect(await readRawStockReservationRemainder(db, f.original.operation.id)).toMatchObject({ remaining: 0n });
    // Drizzle wraps the PostgreSQL constraint error. Pin the actual residual
    // refusal, not the wrapper SQL text or an empty-message regex.
    await expect(freeze(f)).rejects.toMatchObject({ cause: {
      code: '23514', message: 'raw allocation exceeds open residual',
    } });
  });
  it('rejects transfer without the original eligible Keep, rolling back all proof and stock', async () => {
    const f = await fixture(), raidId = await freeze(f, null);
    await expect(lose(f, raidId)).rejects.toThrow();
    expect(await stock(f)).toMatchObject({ reserved: domain });
  });
  it('does not permit zero reserve entries just because zero residual releases exist', async () => {
    const f = await fixture(), key = randomUUID();
    await expect(db.transaction(async tx => {
      await tx.insert(resourceStockOperations).values({ id: key, kind: 'reserve', baseId: f.baseId, resourceId, quantity: 1n, custodyWallet: f.wallet });
      await tx.insert(resourceStockEntries).values([{ operationId: key, bucket: 'available', delta: 0n }, { operationId: key, bucket: 'reserved', delta: 0n }]);
    })).rejects.toThrow();
  });
  it('rolls back a transfer with a missing or wrongly signed original entry', async () => {
    const f = await fixture(), raidId = await freeze(f);
    await expect(db.transaction(async tx => {
      await tx.insert(rawRaidTerminals).values({ raidId, outcome: 'transferred', reason: 'malformed', settledAt: new Date() });
      await tx.insert(rawRaidReservationDebits).values({ raidId, resourceId, reservationId: f.original.operation.id, quantity: 1n, bucket: 'reserved' });
      await tx.insert(rawRaidEntries).values({ raidId, resourceId, bucket: 'attacker_available', delta: -1n });
    })).rejects.toThrow();
    expect(await readRawStockReservationRemainder(db, f.original.operation.id)).toMatchObject({ lost: 0n });
  });
  it('forbids update/delete/truncate of new immutable loss evidence', async () => {
    const f = await fixture(), raidId = await freeze(f); await lose(f, raidId);
    await expect(db.update(rawRaidReservationDebits).set({ quantity: 2n }).where(eq(rawRaidReservationDebits.raidId, raidId))).rejects.toThrow();
    await expect(db.delete(rawRaidReservationDebits).where(eq(rawRaidReservationDebits.raidId, raidId))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE raw_raid_reservation_debits`)).rejects.toThrow();
    expect(await readRawStockReservationRemainder(db, f.original.operation.id)).toMatchObject({ lost: 1n });
  });
});
