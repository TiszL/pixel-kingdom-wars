/** Synthetic accepted deed observations/terms exercise the real SQL/service
 * boundary. These tests make no genuine Seeker or finalized-chain claim. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_HARVESTER as P } from '@shardkeep/shared';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, builderJobs, buildings, deedOwnershipObservations, harvesterCustodyStops,
  harvesterEntries, harvesterEvents, harvesterSourceClosures, harvesterSourceHeads, players, resourceStocks } from '../src/db/schema';
import { observationHash } from '../src/game/baseOwnership';
import { closeHarvesterSources, HarvesterStorageCapacityError, readHarvesterSettlement,
  recordHarvesterCustodyStop, settleDueHarvesterSources } from '../src/game/harvesterSettlement';
import { selectHarvesterSource } from '../src/game/harvesterSources';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db, V1 = P.v1;
afterAll(() => conn.sql.end());
const after = (at: Date, n: number) => new Date(at.getTime() + n * V1.cadenceSec * 1_000);
const read = async (id: string) => (await readHarvesterSettlement(db, id))!;
async function fixture() {
  const f = await createStarterExpeditionFixture(db);
  const [building] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet,
    type: BuildingType.Harvester, tx: 9, ty: 2 }).returning();
  const completedAt = new Date(f.now.getTime() - 1_000);
  await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: building!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Harvester].buildSec * 1_000), finishesAt: completedAt, completedAt });
  const source = await selectHarvesterSource(db, f.wallet, { id: randomUUID(), baseId: f.baseId,
    harvesterId: building!.id, policyVersion: V1.policyVersion }, f.authority, { clock: () => f.now,
    reader: { async readOperatingTerm() { return { snapshot: f.snapshot,
      finality: { commitment: 'finalized', contextSlot: '200', observedAt: f.now.toISOString() } }; } } });
  // Seed only the later custody boundary; the original admitted source stays
  // byte-for-byte intact and still proves its original free-home geography.
  const assetId = Keypair.generate().publicKey.toBase58(), buyer = Keypair.generate().publicKey.toBase58();
  await db.insert(players).values({ wallet: buyer });
  await db.update(bases).set({ deedAssetId: assetId, deedMintAssetId: assetId }).where(eq(bases.id, f.baseId));
  return { ...f, source, assetId, buyer };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function observed(f: Fixture, checkedAt: Date, overrides: Partial<typeof deedOwnershipObservations.$inferInsert> = {}) {
  const proof = { baseId: f.baseId, assetId: f.assetId, owner: f.buyer, slot: 300n,
    status: 'mismatch' as const, source: 'synthetic-finalized-test', ...overrides, checkedAt: overrides.checkedAt ?? checkedAt };
  const [row] = await db.insert(deedOwnershipObservations).values({ ...proof,
    auditHash: observationHash(proof.assetId, proof.owner ?? null, proof.status, proof.slot ?? null, proof.checkedAt) }).returning();
  return row!;
}
const stop = (f: Fixture, at: Date) => db.transaction(tx => recordHarvesterCustodyStop(tx, f.baseId, at));

describe('immutable Harvester custody stop before deferred delivery', () => {
  it('retains first positive loss through saturation, projection replacement and late capacity recovery', async () => {
    const f = await fixture(), cutoff = after(f.now, 5.5), late = after(f.now, 10);
    const observation = await observed(f, cutoff);
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    const first = await db.transaction(async tx => {
      const [marker] = await recordHarvesterCustodyStop(tx, f.baseId, cutoff);
      try { await closeHarvesterSources(tx, f.baseId, cutoff, 'custody_change'); throw new Error('expected capacity refusal'); }
      catch (error) { expect(error).toBeInstanceOf(HarvesterStorageCapacityError); }
      return marker!;
    });
    expect(first).toMatchObject({ sourceId: f.source.id, cutoffAt: cutoff, custodyWallet: f.wallet,
      observationId: observation.id, observedOwner: f.buyer, observedSlot: 300n, auditHash: observation.auditHash });
    expect(await read(f.source.id)).toMatchObject({ source: f.source, stop: first, events: [], closure: null });
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id))).toHaveLength(1);
    // The historical reader and idempotent stop cannot substitute today's
    // unavailable projection, new custody or later cutoff for original proof.
    await db.update(deedOwnershipObservations).set({ owner: null, slot: null, status: 'unavailable', checkedAt: late,
      auditHash: observationHash(f.assetId, null, 'unavailable', null, late) }).where(eq(deedOwnershipObservations.id, observation.id));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: f.buyer, status: 'inactive' }).where(eq(bases.id, f.baseId));
    expect(await stop(f, late)).toEqual([first]);
    expect((await read(f.source.id)).stop).toEqual(first);
    await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.baseId));
    const [delivered] = await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, late));
    expect(delivered!.events).toHaveLength(5);
    expect(delivered!.events.map(({ event }) => event.earnedAt)).toEqual([1, 2, 3, 4, 5].map(n => after(f.now, n)));
    expect(delivered!.events.every(({ event }) => event.actorWallet === f.wallet && event.custodyWallet === f.buyer
      && event.settledAt.getTime() === late.getTime())).toBe(true);
    expect(delivered!.events.reduce((sum, { event }) => sum + event.gross, 0n)).toBe(5n);
    expect(delivered!.events.reduce((sum, { event }) => sum + event.net, 0n)).toBe(4n);
    expect(delivered!.events.reduce((sum, { event }) => sum + event.tax, 0n)).toBe(1n);
    expect(delivered!.events.flatMap(proof => proof.entries).reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
    expect(delivered!.events.at(-1)!.event.carryAfter).toBe(0n);
    const [closed] = await db.transaction(tx => closeHarvesterSources(tx, f.baseId, late, 'replacement'));
    expect(closed!.closure).toEqual({ sourceId: f.source.id, cutoffAt: cutoff, reason: 'custody_change', custodyWallet: f.buyer, processedOrdinal: 5 });
    expect(closed!.source).toEqual(f.source); expect(closed!.stop).toEqual(first);
    expect(await db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId))).toMatchObject([{ available: 4n, reserved: 0n }]);
    expect(await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(f.now, 20)))).toEqual([]);
    expect(await read(f.source.id)).toEqual(closed);
  });

  it.each(['unavailable', 'same-owner', 'wrong-asset', 'unsafe-slot', 'future-proof'] as const)(
    'refuses %s without stopping or losing the original pending head', async kind => {
      const f = await fixture(), cutoff = after(f.now, 2);
      const overrides = kind === 'unavailable' ? { owner: null, slot: null, status: 'unavailable' as const }
        : kind === 'same-owner' ? { owner: f.wallet, status: 'owned' as const }
          : kind === 'wrong-asset' ? { assetId: Keypair.generate().publicKey.toBase58() }
            : kind === 'unsafe-slot' ? { slot: BigInt(Number.MAX_SAFE_INTEGER) + 1n }
              : { checkedAt: new Date(cutoff.getTime() + 1) };
      await observed(f, cutoff, overrides);
      await expect(stop(f, cutoff)).rejects.toThrow('accepted finalized ownership evidence');
      expect((await read(f.source.id)).stop).toBeNull();
      expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id))).toHaveLength(1);
    });

  it('accepts the already-journaled positive owned claim proof and rolls back with its caller', async () => {
    const f = await fixture(), cutoff = after(f.now, 1.5);
    await observed(f, cutoff, { status: 'owned' });
    await expect(db.transaction(async tx => { await recordHarvesterCustodyStop(tx, f.baseId, cutoff); throw new Error('outer rollback'); })).rejects.toThrow('outer rollback');
    expect((await read(f.source.id)).stop).toBeNull();
    expect((await stop(f, cutoff))[0]!.observationStatus).toBe('owned');
  });

  it('SQL retains first evidence and rejects caller-invented proof or retroactive earning cutoff', async () => {
    const f = await fixture(), cutoff = after(f.now, 1.5);
    const observation = await observed(f, cutoff);
    const values = { sourceId: f.source.id, cutoffAt: cutoff, custodyWallet: f.wallet,
      observationId: observation.id, assetId: f.assetId, observedOwner: f.buyer, observedSlot: observation.slot!,
      checkedAt: cutoff, observationStatus: observation.status, observationSource: observation.source, auditHash: observation.auditHash };
    await expect(db.insert(harvesterCustodyStops).values({ ...values, observedSlot: observation.slot! + 1n })).rejects.toThrow();
    const [first] = await stop(f, cutoff);
    await expect(db.update(harvesterCustodyStops).set({ cutoffAt: after(f.now, 3) }).where(eq(harvesterCustodyStops.sourceId, f.source.id))).rejects.toThrow();
    await expect(db.delete(harvesterCustodyStops).where(eq(harvesterCustodyStops.sourceId, f.source.id))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE harvester_custody_stops`)).rejects.toThrow();
    expect((await read(f.source.id)).stop).toEqual(first);
    const other = await fixture();
    await db.transaction(tx => settleDueHarvesterSources(tx, other.baseId, after(other.now, 2)));
    await observed(other, after(other.now, 1));
    await expect(stop(other, after(other.now, 1))).rejects.toThrow();
    expect((await read(other.source.id)).events).toHaveLength(2);
    expect((await read(other.source.id)).stop).toBeNull();
  });

  it('SQL rejects otherwise valid balanced poststop earning and closures that change the first cutoff or reason', async () => {
    const f = await fixture(), cutoff = after(f.now, 1.5);
    await db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, after(f.now, 1)));
    await observed(f, cutoff); await stop(f, cutoff);
    const before = await read(f.source.id), event = before.events[0]!.event;
    await expect(db.transaction(async tx => {
      await tx.insert(harvesterEvents).values({ ...event, ordinal: 2, walletSequence: 2n,
        earnedAt: after(f.now, 2), settledAt: after(f.now, 2), carryBefore: event.carryAfter, carryAfter: event.carryAfter * 2n });
      await tx.insert(harvesterEntries).values([{ sourceId: f.source.id, ordinal: 2, bucket: 'issued', delta: -1n },
        { sourceId: f.source.id, ordinal: 2, bucket: 'base_stock', delta: 1n },
        { sourceId: f.source.id, ordinal: 2, bucket: 'island_pool', delta: 0n }]);
    })).rejects.toMatchObject({ cause: { message: 'Harvester event exceeds original custody stop' } });
    for (const change of [{ reason: 'replacement', cutoffAt: cutoff }, { reason: 'custody_change', cutoffAt: after(f.now, 1) }]) {
      await expect(db.transaction(async tx => {
        await tx.insert(harvesterSourceClosures).values({ sourceId: f.source.id, custodyWallet: f.wallet, processedOrdinal: 1, ...change });
        await tx.delete(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id));
      })).rejects.toMatchObject({ cause: { message: 'Harvester closure must retain original custody stop' } });
    }
    expect(await read(f.source.id)).toEqual(before);
    const [closed] = await db.transaction(tx => closeHarvesterSources(tx, f.baseId, after(f.now, 5), 'deactivation'));
    expect(closed!.closure).toMatchObject({ cutoffAt: cutoff, reason: 'custody_change', processedOrdinal: 1 });
  });
});
