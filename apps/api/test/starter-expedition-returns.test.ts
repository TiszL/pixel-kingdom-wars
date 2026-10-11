/** Real accepted synthetic trips; no runtime auction fallback or public issuer. */
import { randomUUID } from 'node:crypto';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  baseRaidLocks, bases, baseSlots, raids, resourceStocks, starterExpeditionEntries,
  starterExpeditionInflight, starterExpeditionReturns,
} from '../src/db/schema';
import { readStarterExpeditionReturn, settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
async function accepted() {
  const fixture = await createStarterExpeditionFixture(db);
  return { ...fixture, trip: await fixture.dispatch() };
}
type Fixture = Awaited<ReturnType<typeof accepted>>;
const settle = (f: Fixture, cutoff = f.trip.returnsAt) =>
  db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, cutoff));
const stock = async (f: Fixture) => (await db.select().from(resourceStocks)
  .where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.trip.resourceId))))[0];
const flight = async (f: Fixture) => (await db.select().from(starterExpeditionInflight)
  .where(eq(starterExpeditionInflight.expeditionId, f.trip.id)))[0];

describe('automatic starter returns preserve accepted source obligations', () => {
  it('returns at the exact deadline, with all three conserved legs and original scope', async () => {
    const f = await accepted();
    expect(await settle(f, new Date(f.trip.returnsAt.getTime() - 1))).toEqual([]);
    expect(await stock(f)).toBeUndefined();
    const [proof] = await settle(f);
    expect(proof!.expedition.id).toBe(f.trip.id);
    expect(proof!.receipt).toMatchObject({ expeditionId: f.trip.id, custodyWallet: f.wallet, returnedAt: f.trip.returnsAt });
    expect(proof!.entries.map(e => [e.bucket, e.delta])).toEqual([
      ['base_stock', f.trip.net], ['island_pool', f.trip.tax], ['issued', -f.trip.gross],
    ]);
    expect(proof!.entries.reduce((sum, e) => sum + e.delta, 0n)).toBe(0n);
    // Positively known zero winners still retain the full original-term tax.
    expect(f.snapshot.spots.every(spot => spot.ownerWallet === null)).toBe(true);
    expect(proof!.entries.find(entry => entry.bucket === 'island_pool')!.delta).toBeGreaterThan(0n);
    expect(await stock(f)).toMatchObject({ available: f.trip.net, reserved: 0n });
    expect(await flight(f)).toBeUndefined();
    expect(await readStarterExpeditionReturn(db, f.trip.id.toUpperCase())).toEqual(proof);
  });

  it('competing foreground/worker attempts and reconnect post exactly once', async () => {
    const f = await accepted();
    const results = await Promise.all(Array.from({ length: 4 }, () => settle(f)));
    expect(results.flat()).toHaveLength(1);
    expect(await settle(f)).toEqual([]);
    expect(await stock(f)).toMatchObject({ available: f.trip.net, reserved: 0n });
    const reopened = connectTestDb();
    try { expect(await readStarterExpeditionReturn(reopened.db, f.trip.id)).toEqual(results.flat()[0]); }
    finally { await reopened.sql.end(); }
  });

  it('credits the saved original base even after current custody becomes inactive', async () => {
    const f = await accepted(), buyer = await createTestPlayer(db);
    // Simulated completed custody transition; actual transfer hooks have their
    // own integration gate. This tests terminal service independence only.
    await db.transaction(async tx => {
      await tx.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
      await tx.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    });
    const [proof] = await settle(f);
    expect(proof!.expedition).toMatchObject({ actorWallet: f.wallet, baseId: f.baseId });
    expect(proof!.receipt.custodyWallet).toBe(buyer.wallet);
    expect(await stock(f)).toMatchObject({ available: f.trip.net });
  });

  it('does not need the current term reader when an old accepted term has ended', async () => {
    const f = await accepted();
    f.reader.readOperatingTerm = async () => { throw new Error('provider offline'); };
    const [proof] = await settle(f, new Date(Date.parse(f.snapshot.endsAt) + 1));
    expect(proof!.expedition.termId).toBe(f.trip.termId);
    expect(proof!.expedition.termHash).toBe(f.trip.termHash);
    expect(proof!.entries.find(e => e.bucket === 'island_pool')!.delta).toBe(f.trip.tax);
  });

  it('keeps reserved exposure and frozen raid evidence unchanged by a later source', async () => {
    const f = await accepted(), attacker = await createStarterExpeditionFixture(db);
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.trip.resourceId, available: 3n, reserved: 7n });
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId, defenderWallet: f.wallet, defenderBaseId: f.baseId, seed: 1n, snapshot: { frozenRaw: '10' }, armySnapshot: {},
      simVersion: 9, ordersDeadlineAt: new Date(f.trip.returnsAt.getTime() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: raid!.ordersDeadlineAt });
    await settle(f);
    expect(await stock(f)).toMatchObject({ available: 3n + f.trip.net, reserved: 7n });
    expect((await db.select().from(raids).where(eq(raids.id, raid!.id)))[0]).toEqual(raid);
  });

  it('outer caller rollback retains the vehicle and all original obligations', async () => {
    const f = await accepted();
    await expect(db.transaction(async tx => {
      expect(await settleDueStarterExpeditions(tx, f.baseId, f.trip.returnsAt)).toHaveLength(1);
      throw new Error('custody update failed');
    })).rejects.toThrow('custody update failed');
    expect(await stock(f)).toBeUndefined();
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    expect(await flight(f)).toBeDefined();
    expect(await settle(f)).toHaveLength(1);
  });

  it('a caught mid-write SQL failure cannot leave partial credit in an outer commit', async () => {
    const f = await accepted();
    await db.transaction(async tx => {
      // Requiring the deferred cross-table invariants immediately makes the
      // temporary flight+return intermediate state fail during the write.
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      await expect(settleDueStarterExpeditions(tx, f.baseId, f.trip.returnsAt)).rejects.toThrow();
      // Deliberately commit after catching the inner failure. Its savepoint
      // must also remove the newly-created empty stock projection.
    });
    expect(await stock(f)).toBeUndefined();
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    expect(await flight(f)).toBeDefined();
    expect(await settle(f)).toHaveLength(1);
  });

  it('int64 overflow including reservations retains the debt and permits later retry', async () => {
    const f = await accepted();
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.trip.resourceId,
      available: RAW_RESOURCE_STORAGE_MAX - 1n, reserved: 1n });
    await db.transaction(async tx => {
      await expect(settleDueStarterExpeditions(tx, f.baseId, f.trip.returnsAt)).rejects.toThrow('overflow');
    });
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    expect(await flight(f)).toBeDefined();
    expect(await stock(f)).toMatchObject({ available: RAW_RESOURCE_STORAGE_MAX - 1n, reserved: 1n });
    // Explicit test-only simulated downstream consumption frees exact capacity.
    await db.update(resourceStocks).set({ available: RAW_RESOURCE_STORAGE_MAX - f.trip.net - 1n })
      .where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.trip.resourceId)));
    expect(await settle(f)).toHaveLength(1);
    expect(await stock(f)).toMatchObject({ available: RAW_RESOURCE_STORAGE_MAX - 1n, reserved: 1n });
  });

  it('never settles another base or an unknown source by changing current selection', async () => {
    const f = await accepted(), other = await createStarterExpeditionFixture(db);
    expect(await db.transaction(tx => settleDueStarterExpeditions(tx, other.baseId, f.trip.returnsAt))).toEqual([]);
    expect(await flight(f)).toBeDefined();
    expect(await readStarterExpeditionReturn(db, randomUUID())).toBeNull();
    await expect(db.transaction(tx => settleDueStarterExpeditions(tx, randomUUID(), f.trip.returnsAt))).rejects.toThrow('missing');
  });

  it('immutable source receipts and exact balanced entries cannot be altered or removed', async () => {
    const f = await accepted(), [proof] = await settle(f);
    await expect(db.update(starterExpeditionReturns).set({ returnedAt: new Date() })
      .where(eq(starterExpeditionReturns.id, proof!.receipt.id))).rejects.toThrow();
    await expect(db.delete(starterExpeditionReturns).where(eq(starterExpeditionReturns.id, proof!.receipt.id))).rejects.toThrow();
    await expect(db.update(starterExpeditionEntries).set({ delta: 0n })
      .where(eq(starterExpeditionEntries.returnId, proof!.receipt.id))).rejects.toThrow();
    await expect(db.delete(starterExpeditionEntries).where(eq(starterExpeditionEntries.returnId, proof!.receipt.id))).rejects.toThrow();
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toEqual(proof);
  });

  it('reuses the installed vehicle without allowing an old return to release its new trip', async () => {
    const f = await createStarterExpeditionFixture(db), first = await f.dispatch();
    await db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, first.returnsAt));
    f.command = { ...f.command, id: randomUUID() };
    f.now = first.returnsAt;
    const second = await f.dispatch();
    expect(second.installationId).toBe(first.installationId);
    expect(await readStarterExpeditionReturn(db, first.id)).not.toBeNull();
    expect(await db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, first.returnsAt))).toEqual([]);
    expect((await db.select().from(starterExpeditionInflight)
      .where(eq(starterExpeditionInflight.installationId, f.installationId)))[0]!.expeditionId).toBe(second.id);
    expect(await db.transaction(tx => settleDueStarterExpeditions(tx, f.baseId, second.returnsAt))).toHaveLength(1);
    expect((await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId)))[0]!.available)
      .toBe(first.net + second.net);
  });

  it.each(['wrong-amounts', 'missing-entry', 'flight-retained'] as const)(
    'database commit rejects %s proof even when individual inserts are structurally legal', async mode => {
      const f = await accepted();
      await expect(db.transaction(async tx => {
        const [receipt] = await tx.insert(starterExpeditionReturns).values({ expeditionId: f.trip.id,
          custodyWallet: f.wallet, returnedAt: f.trip.returnsAt }).returning();
        await tx.insert(starterExpeditionEntries).values([
          { returnId: receipt!.id, bucket: 'issued', delta: -f.trip.gross },
          { returnId: receipt!.id, bucket: 'base_stock', delta: f.trip.net - (mode === 'wrong-amounts' ? 1n : 0n) },
          ...(mode === 'missing-entry' ? [] : [{ returnId: receipt!.id, bucket: 'island_pool' as const,
            delta: f.trip.tax + (mode === 'wrong-amounts' ? 1n : 0n) }]),
        ]);
        if (mode !== 'flight-retained') await tx.delete(starterExpeditionInflight)
          .where(eq(starterExpeditionInflight.expeditionId, f.trip.id));
      })).rejects.toThrow();
      expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
      expect(await flight(f)).toBeDefined();
    },
  );

  it('refuses invalid cutoff dates before any source write', async () => {
    const f = await accepted();
    await expect(settle(f, new Date(Number.NaN))).rejects.toThrow();
    expect(await stock(f)).toBeUndefined();
    expect(await flight(f)).toBeDefined();
  });
});
