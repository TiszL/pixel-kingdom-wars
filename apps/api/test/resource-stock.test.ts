/** DARK persistence tests, not production earning/permission fixtures. Opening
 * balances exist ONLY here; the service has no issuance or balance-patch API. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PHASE_E_RAW_RESOURCE_IDS, RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { baseRaidLocks, bases, baseSlots, raids, resourceStockEntries, resourceStockOperations, resourceStocks } from '../src/db/schema';
import { transferStableBase } from '../src/game/baseOwnership';
import { consumeRawStockReservation, readRaidExposedRawStock, readResourceStockProof, releaseRawStockReservation, reserveRawStock } from '../src/game/resourceStock';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
const resourceId = PHASE_E_RAW_RESOURCE_IDS[0];
const authority = (baseId: string) => ({ baseId, assertAuthority: async () => {} });
async function fixture(quantity = 100n) {
  const { wallet } = await createTestPlayer(db);
  const deed = `resource-stock-${randomUUID()}`;
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', deedAssetId: deed, deedMintAssetId: deed, landPaidAt: new Date() }).returning();
  const baseId = base!.id;
  await db.insert(baseSlots).values({ wallet, slot: 1, baseId });
  // Explicit synthetic opening balance, never a production source event.
  await db.insert(resourceStocks).values({ baseId, resourceId, available: quantity });
  return { wallet, baseId, deed };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = (f: Fixture, quantity = 30n, operationId: string = randomUUID()) => ({ baseId: f.baseId, resourceId, quantity, operationId });
const reserve = (f: Fixture, quantity = 30n, key: string = randomUUID()) => reserveRawStock(db, f.wallet, input(f, quantity, key), authority(f.baseId));
const stock = async (f: Fixture) => (await readRaidExposedRawStock(db, f.baseId)).find(r => r.resourceId === resourceId)!;

describe('stable-base raw stock without issuance', () => {
  it('keeps all reserved raw stock exposed; only consumption reduces total', async () => {
    const f = await fixture(), reserved = await reserve(f);
    expect(await stock(f)).toEqual({ resourceId, available: '70', reserved: '30', total: '100' });
    expect(reserved.entries.map(e => e.delta).reduce((a, b) => a + b)).toBe(0n);
    const consumed = await consumeRawStockReservation(db, randomUUID(), reserved.operation.id);
    expect(consumed.entries.map(e => [e.bucket, e.delta])).toEqual([['consumed', 30n], ['reserved', -30n]]);
    expect(await stock(f)).toEqual({ resourceId, available: '70', reserved: '0', total: '70' });
    expect((await readRaidExposedRawStock(db, f.baseId)).filter(r => r.total === '0')).toHaveLength(7);
  });

  it('releases the full reservation exactly once without minting or retaxing', async () => {
    const f = await fixture(), reserved = await reserve(f), key = randomUUID();
    const proof = await releaseRawStockReservation(db, key, reserved.operation.id);
    expect(await releaseRawStockReservation(db, key, reserved.operation.id)).toEqual(proof);
    expect(await readResourceStockProof(db, key)).toEqual(proof);
    await expect(releaseRawStockReservation(db, randomUUID(), reserved.operation.id)).rejects.toMatchObject({ code: 'RESOURCE_RESERVATION_SETTLED' });
    await expect(consumeRawStockReservation(db, randomUUID(), reserved.operation.id)).rejects.toMatchObject({ code: 'RESOURCE_RESERVATION_SETTLED' });
    expect(await stock(f)).toMatchObject({ available: '100', reserved: '0', total: '100' });
  });

  it('serializes same-key concurrent reservations and returns original proof after reconnect', async () => {
    const f = await fixture(), key = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => reserve(f, 60n, key)));
    expect(results.every(r => r.operation.id === key)).toBe(true);
    expect(await stock(f)).toMatchObject({ available: '40', reserved: '60', total: '100' });
    const reopened = connectTestDb();
    try { expect(await readResourceStockProof(reopened.db, key)).toEqual(results[0]); }
    finally { await reopened.sql.end(); }
  });

  it.each(['release', 'consume'] as const)('normalizes mixed-case UUIDs before original %s replay without duplicate movement', async kind => {
    const f = await fixture(), key = randomUUID();
    const request = { ...input(f, 30n, key.toUpperCase()), baseId: f.baseId.toUpperCase() };
    // Mixed request/context casing must reach the authority callback as the
    // same canonical DB base, while retaining its normal wallet binding.
    let checkedBase: string | undefined;
    const proof = await reserveRawStock(db, f.wallet, request, {
      baseId: f.baseId, assertAuthority: async (_tx, wallet, baseId) => {
        expect(wallet).toBe(f.wallet); checkedBase = baseId;
      },
    });
    expect(checkedBase).toBe(f.baseId);
    expect(await reserveRawStock(db, f.wallet, input(f, 30n, key), authority(f.baseId.toUpperCase()))).toEqual(proof);
    expect(await reserveRawStock(db, f.wallet, request, authority(f.baseId.toUpperCase()))).toEqual(proof);
    expect(await readResourceStockProof(db, key.toUpperCase())).toEqual(proof);
    expect(await readRaidExposedRawStock(db, f.baseId.toUpperCase())).toEqual(await readRaidExposedRawStock(db, f.baseId));
    expect(await stock(f)).toMatchObject({ available: '70', reserved: '30', total: '100' });
    const finish = kind === 'release' ? releaseRawStockReservation : consumeRawStockReservation;
    const terminalKey = randomUUID();
    const terminal = await finish(db, terminalKey.toUpperCase(), key.toUpperCase());
    expect(await finish(db, terminalKey, key)).toEqual(terminal);
    expect(await finish(db, terminalKey.toUpperCase(), key.toUpperCase())).toEqual(terminal);
    expect(await readResourceStockProof(db, terminalKey.toUpperCase())).toEqual(terminal);
    await expect(reserve(f, 31n, key.toUpperCase())).rejects.toMatchObject({ code: 'RESOURCE_STOCK_KEY_MISMATCH' });
    expect(await stock(f)).toMatchObject({ reserved: '0', total: kind === 'release' ? '100' : '70' });
  });

  it('does not oversubscribe existing stock with different concurrent keys', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([reserve(f, 60n), reserve(f, 60n)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await stock(f)).toMatchObject({ available: '40', reserved: '60', total: '100' });
  });

  it('release-versus-consume concurrency has one terminal winner and balanced stock', async () => {
    const f = await fixture(), r = await reserve(f);
    const results = await Promise.allSettled([releaseRawStockReservation(db, randomUUID(), r.operation.id), consumeRawStockReservation(db, randomUUID(), r.operation.id)]);
    const winner = results.find(r => r.status === 'fulfilled');
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    if (winner?.status !== 'fulfilled') throw new Error('missing terminal winner');
    expect(await stock(f)).toMatchObject({ reserved: '0', total: winner.value.operation.kind === 'release' ? '100' : '70' });
  });

  it('binds the global operation key to original wallet/base/resource/amount/kind', async () => {
    const f = await fixture(), other = await fixture(), key = randomUUID();
    await reserve(f, 30n, key);
    for (const changed of [input(f, 31n, key), { ...input(f, 30n, key), resourceId: PHASE_E_RAW_RESOURCE_IDS[1] }]) {
      await expect(reserveRawStock(db, f.wallet, changed, authority(f.baseId))).rejects.toMatchObject({ code: 'RESOURCE_STOCK_KEY_MISMATCH' });
    }
    await expect(reserve(other, 30n, key)).rejects.toMatchObject({ code: 'RESOURCE_STOCK_KEY_MISMATCH' });
    await expect(reserveRawStock(db, other.wallet, input(f, 30n, key), authority(f.baseId))).rejects.toMatchObject({ code: 'RESOURCE_STOCK_KEY_MISMATCH' });
    await expect(releaseRawStockReservation(db, key, key)).rejects.toMatchObject({ code: 'RESOURCE_STOCK_KEY_MISMATCH' });
    expect(await stock(f)).toMatchObject({ total: '100', reserved: '30' });
  });

  it('retains original reserver proof after real deed transfer; release follows the base', async () => {
    const f = await fixture(), r = await reserve(f), buyer = await createTestPlayer(db);
    await transferStableBase(db, f.baseId, f.wallet, buyer.wallet, f.deed);
    expect((await reserve(f, 30n, r.operation.id)).operation.custodyWallet).toBe(f.wallet);
    await expect(reserve(f)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const terminal = await releaseRawStockReservation(db, randomUUID(), r.operation.id);
    expect(terminal.operation).toMatchObject({ baseId: f.baseId, custodyWallet: buyer.wallet });
    expect(await stock(f)).toMatchObject({ total: '100', available: '100' });
  });

  it('does not strand terminal settlement on an inactive original base', async () => {
    const f = await fixture(), r = await reserve(f);
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    await consumeRawStockReservation(db, randomUUID(), r.operation.id);
    expect(await stock(f)).toMatchObject({ total: '70', reserved: '0' });
  });

  it('uses real authority before reserving; refusal changes no stock or operation key', async () => {
    const f = await fixture(), request = input(f);
    await expect(reserveRawStock(db, f.wallet, request, { baseId: f.baseId, assertAuthority: async () => { throw new Error('authority unavailable'); } })).rejects.toThrow('authority unavailable');
    expect(await readResourceStockProof(db, request.operationId)).toBeNull();
    expect(await stock(f)).toMatchObject({ available: '100', reserved: '0' });
  });

  it('blocks consumption behind a frozen raid, but release keeps its entire exposure', async () => {
    const f = await fixture(), attacker = await fixture(), r = await reserve(f), key = randomUUID();
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId, defenderWallet: f.wallet, defenderBaseId: f.baseId,
      seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: 9, ordersDeadlineAt: new Date(Date.now() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: new Date(Date.now() + 60_000) });
    await expect(consumeRawStockReservation(db, key, r.operation.id)).rejects.toMatchObject({ code: 'BASE_BEING_RAIDED' });
    expect(await readResourceStockProof(db, key)).toBeNull();
    await expect(reserve(f)).rejects.toMatchObject({ code: 'BASE_BEING_RAIDED' });
    await releaseRawStockReservation(db, randomUUID(), r.operation.id);
    expect(await stock(f)).toMatchObject({ available: '100', reserved: '0', total: '100' });
  });

  it('rolls back accepted stock/entries/key when the enclosing job transition fails', async () => {
    const f = await fixture(), key = randomUUID();
    await expect(db.transaction(async tx => {
      await reserveRawStock(tx, f.wallet, input(f, 30n, key), authority(f.baseId));
      throw new Error('job insert failed');
    })).rejects.toThrow('job insert failed');
    expect(await readResourceStockProof(db, key)).toBeNull();
    expect(await stock(f)).toMatchObject({ available: '100', reserved: '0' });
    const r = await reserve(f);
    await expect(db.transaction(async tx => {
      await consumeRawStockReservation(tx, key, r.operation.id);
      throw new Error('job completion failed');
    })).rejects.toThrow('job completion failed');
    expect(await readResourceStockProof(db, key)).toBeNull();
    expect(await stock(f)).toMatchObject({ available: '70', reserved: '30', total: '100' });
  });

  it('handles int64 precisely and rejects malformed/overflow quantities before mutation', async () => {
    const f = await fixture(RAW_RESOURCE_STORAGE_MAX);
    const r = await reserve(f, RAW_RESOURCE_STORAGE_MAX);
    expect(await stock(f)).toMatchObject({ available: '0', reserved: RAW_RESOURCE_STORAGE_MAX.toString(), total: RAW_RESOURCE_STORAGE_MAX.toString() });
    await releaseRawStockReservation(db, randomUUID(), r.operation.id);
    for (const amount of [0n, -1n, RAW_RESOURCE_STORAGE_MAX + 1n]) await expect(reserve(f, amount)).rejects.toThrow();
    await expect(reserveRawStock(db, f.wallet, { ...input(f), resourceId: 'forge_ingot' as typeof resourceId }, authority(f.baseId))).rejects.toThrow();
    await expect(db.update(resourceStocks).set({ reserved: 1n }).where(eq(resourceStocks.baseId, f.baseId))).rejects.toThrow();
    expect(await stock(f)).toMatchObject({ reserved: '0', total: RAW_RESOURCE_STORAGE_MAX.toString() });
  });
});

describe('database evidence constraints', () => {
  it('pins catalogue IDs and forbids hidden balances in unknown resource rows', async () => {
    const migration = readFileSync(new URL('../drizzle/0139_resource_stock.sql', import.meta.url), 'utf8');
    const checks = [...migration.matchAll(/resource_id IN \(([^)]+)\)/g)];
    expect(checks).toHaveLength(2);
    for (const match of checks) expect([...match[1]!.matchAll(/'([^']+)'/g)].map(m => m[1])).toEqual([...PHASE_E_RAW_RESOURCE_IDS]);
    const f = await fixture();
    await expect(db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: 'refined', available: 1n })).rejects.toThrow();
  });

  it('rejects zero-sum but wrong-bucket evidence and an empty operation at COMMIT', async () => {
    const f = await fixture();
    for (const wrongEntries of [false, true]) {
      const key = randomUUID();
      await expect(db.transaction(async tx => {
        await tx.insert(resourceStockOperations).values({ id: key, kind: 'reserve', baseId: f.baseId, resourceId, quantity: 1n, custodyWallet: f.wallet });
        if (wrongEntries) await tx.insert(resourceStockEntries).values([
          { operationId: key, bucket: 'available', delta: -1n }, { operationId: key, bucket: 'consumed', delta: 1n },
        ]);
      })).rejects.toThrow();
      expect(await readResourceStockProof(db, key)).toBeNull();
    }
  });

  it('keeps immutable receipt evidence and cannot release another reservation amount', async () => {
    const f = await fixture(), r = await reserve(f);
    await expect(db.update(resourceStockOperations).set({ quantity: 1n }).where(eq(resourceStockOperations.id, r.operation.id))).rejects.toThrow();
    await expect(db.delete(resourceStockEntries).where(eq(resourceStockEntries.operationId, r.operation.id))).rejects.toThrow();
    await expect(db.delete(resourceStockOperations).where(eq(resourceStockOperations.id, r.operation.id))).rejects.toThrow();
    const key = randomUUID();
    await expect(db.transaction(async tx => {
      await tx.insert(resourceStockOperations).values({ id: key, kind: 'release', baseId: f.baseId, resourceId, quantity: 1n, custodyWallet: f.wallet, reservationId: r.operation.id });
      await tx.insert(resourceStockEntries).values([{ operationId: key, bucket: 'reserved', delta: -1n }, { operationId: key, bucket: 'available', delta: 1n }]);
    })).rejects.toThrow();
    expect(await readResourceStockProof(db, key)).toBeNull();
    expect(await readResourceStockProof(db, r.operation.id)).toEqual(r);
  });

  it('rolls back a failed cache UPDATE after proof insertion, including inside a savepoint', async () => {
    const f = await fixture(), key = randomUUID();
    // Force the storage-bound check to fail AFTER the service inserted both
    // original entries. This is a test-only DB trigger, never a runtime escape.
    await db.execute(sql.raw(`CREATE FUNCTION resource_stock_test_fail_${key.replaceAll('-', '')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.base_id = '${f.baseId}'::uuid THEN NEW.available := -1; END IF; RETURN NEW; END $$`));
    const name = `resource_stock_test_fail_${key.replaceAll('-', '')}`;
    try {
      await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE UPDATE ON resource_stocks FOR EACH ROW EXECUTE FUNCTION ${name}()`));
      await db.transaction(async tx => {
        await expect(reserveRawStock(tx, f.wallet, input(f, 30n, key), authority(f.baseId))).rejects.toThrow();
        expect(await readResourceStockProof(tx, key)).toBeNull();
      });
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON resource_stocks`));
      await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    }
    expect(await stock(f)).toMatchObject({ available: '100', reserved: '0' });
    expect(await db.select().from(resourceStockEntries).where(eq(resourceStockEntries.operationId, key))).toEqual([]);
    expect(await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, resourceId)))).toHaveLength(1);
  });
});
