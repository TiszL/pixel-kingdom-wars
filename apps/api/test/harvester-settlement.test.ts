/** Synthetic authority and seeded facilities prove DB accounting, not placement,
 * genuine Seeker finality, source renewal or a complete player journey. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BUILD_COSTS, BuildingType, PHASE_E_HARVESTER as P } from '@shardkeep/shared';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, builderJobs, buildings, harvesterEntries, harvesterEvents, harvesterSourceHeads,
  harvesterWalletLocks, players, resourceStocks } from '../src/db/schema';
import { readHarvesterSettlement, settleDueHarvesterSources } from '../src/game/harvesterSettlement';
import { selectHarvesterSource } from '../src/game/harvesterSources';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db, V1 = P.v1;
afterAll(() => conn.sql.end());
async function fixture(now?: Date, cadencesBeforeTermEnd?: number) {
  const f = await createStarterExpeditionFixture(db, now ? { now } : {});
  if (cadencesBeforeTermEnd !== undefined) f.now = new Date(Date.parse(f.snapshot.endsAt) - cadencesBeforeTermEnd * V1.cadenceSec * 1_000);
  const [building] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet,
    type: BuildingType.Harvester, tx: 9, ty: 2 }).returning();
  const completedAt = new Date(f.now.getTime() - 1_000);
  await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: building!.id,
    kind: 'build', startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Harvester].buildSec * 1_000),
    finishesAt: completedAt, completedAt });
  const source = await selectHarvesterSource(db, f.wallet, { id: randomUUID(), baseId: f.baseId, harvesterId: building!.id,
    policyVersion: V1.policyVersion }, f.authority, { clock: () => f.now, reader: { async readOperatingTerm() {
      return { snapshot: f.snapshot, finality: { commitment: 'finalized', contextSlot: '200', observedAt: f.now.toISOString() } };
    } } });
  return { ...f, source, buildingId: building!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const at = (f: Fixture, ordinal: number) => new Date(f.source.admittedAt.getTime() + ordinal * V1.cadenceSec * 1_000);
const settle = (f: Fixture, cutoff: Date) => db.transaction(tx => settleDueHarvesterSources(tx, f.baseId, cutoff));
const stock = async (f: Fixture) => (await db.select().from(resourceStocks).where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.source.resourceId))))[0];
const history = async (f: Fixture) => (await readHarvesterSettlement(db, f.source.id))!;

it('freezes migration economics to the accepted v1 policy', () => {
  const migration = readFileSync(new URL('../drizzle/0149_harvester_settlement.sql', import.meta.url), 'utf8');
  expect(migration).toContain(`interval '${V1.cadenceSec} seconds'`);
  expect(migration).toContain(`used+${V1.grossPerCadence}<=${V1.grossPerWalletUtcDay}`);
  expect(migration).toContain(`NEW.tax_basis_points=${V1.taxBasisPoints}`);
  expect(migration).toContain(`NEW.island_pool_bps=${V1.islandPoolBps}`);
  expect(migration).toContain(`NEW.tax_policy_version=${V1.taxPolicyVersion}`);
});

describe('original Harvester allowance, carry and conserved settlement', () => {
  it('earns only complete units, with immutable original day, term and three-entry proof', async () => {
    const f = await fixture();
    expect((await settle(f, new Date(at(f, 1).getTime() - 1)))[0]!.events).toEqual([]);
    const [first] = await settle(f, at(f, 1));
    expect(first!.events[0]!.event).toMatchObject({ sourceId: f.source.id, ordinal: 1, actorWallet: f.wallet,
      earnedAt: at(f, 1), gross: 1n, net: 1n, tax: 0n, carryBefore: 0n, carryAfter: 2_000n, walletSequence: 1n });
    expect(first!.events[0]!.entries.reduce((sum, e) => sum + e.delta, 0n)).toBe(0n);
    expect((await stock(f))!.available).toBe(1n);
    expect(first!.source.termHash).toBe(f.source.termHash);
  });
  it('partial/repeated/concurrent settlement advances only new ordinals and never counts its earlier use twice', async () => {
    const f = await fixture(); await settle(f, at(f, 2));
    const original = (await history(f)).events;
    const results = await Promise.all([settle(f, at(f, 10)), settle(f, at(f, 10))]);
    expect(results[0]).toEqual(results[1]);
    const proof = await history(f);
    expect(proof.events.slice(0, 2)).toEqual(original);
    expect(proof.events).toHaveLength(10);
    expect(proof.events.reduce((sum, p) => sum + p.event.gross, 0n)).toBe(10n);
    expect(proof.events.reduce((sum, p) => sum + p.event.tax, 0n)).toBe(2n);
    expect((await stock(f))!.available).toBe(8n);
  });
  it('uses the cadence completion UTC day and preserves carry across midnight', async () => {
    const f = await fixture(new Date('2035-01-01T20:00:00.000Z'));
    await settle(f, at(f, 5)); const p = await history(f);
    expect(p.events[1]!.event.utcDay.toISOString()).toBe('2035-01-01T00:00:00.000Z');
    expect(p.events[2]!.event.utcDay.toISOString()).toBe('2035-01-02T00:00:00.000Z');
    expect(p.events[4]!.event).toMatchObject({ gross: 1n, net: 0n, tax: 1n, carryBefore: 8_000n, carryAfter: 0n });
  });
  it('late recovery retains all 15 authorized units and never backfills beyond lease expiry', async () => {
    const f = await fixture(); await settle(f, at(f, 100));
    const p = await history(f);
    expect(p.events).toHaveLength(V1.grossPerWalletUtcDay);
    expect(p.events.at(-1)!.event.earnedAt).toEqual(f.source.leaseExpiresAt);
    expect((await stock(f))!.available).toBe(12n);
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id))).toHaveLength(1);
    await expect(selectHarvesterSource(db, f.wallet, { id: randomUUID(), baseId: f.baseId, harvesterId: f.buildingId,
      policyVersion: 1 }, f.authority)).rejects.toThrow('unavailable'); // renewal still requires fresh authority
  });
  it('excludes a cadence completing exactly at the original term end, even on late recovery', async () => {
    const f = await fixture(undefined, 2); await settle(f, at(f, 10));
    const p = await history(f);
    expect(p.events).toHaveLength(1);
    expect(p.events[0]!.event.earnedAt).toEqual(at(f, 1));
    expect(f.source.leaseExpiresAt.toISOString()).toBe(f.snapshot.endsAt);
  });
  it('full-batch overflow rolls back earlier units/carry/usage while retaining the original obligation', async () => {
    const f = await fixture();
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX - 1n });
    await expect(settle(f, at(f, 3))).rejects.toThrow('overflow');
    expect((await history(f)).events).toEqual([]);
    expect((await stock(f))!.available).toBe(RAW_RESOURCE_STORAGE_MAX - 1n);
    expect(await db.select().from(harvesterWalletLocks).where(eq(harvesterWalletLocks.wallet, f.wallet))).toEqual([]);
    await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.baseId));
    await settle(f, at(f, 3)); expect((await stock(f))!.available).toBe(3n);
  });
  it('a tax-only fifth unit settles at full stock, then a net-producing unit remains owed', async () => {
    const f = await fixture(); await settle(f, at(f, 4));
    await db.update(resourceStocks).set({ available: RAW_RESOURCE_STORAGE_MAX }).where(eq(resourceStocks.baseId, f.baseId));
    await settle(f, at(f, 5));
    expect((await history(f)).events.at(-1)!.event).toMatchObject({ net: 0n, tax: 1n });
    expect((await stock(f))!.available).toBe(RAW_RESOURCE_STORAGE_MAX);
    await expect(settle(f, at(f, 6))).rejects.toThrow('overflow');
    expect((await history(f)).events).toHaveLength(5);
  });
  it('savepoint rollback survives an outer caller catching failure and outer rollback undoes success', async () => {
    const f = await fixture();
    await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: f.source.resourceId, available: RAW_RESOURCE_STORAGE_MAX - 1n });
    await db.transaction(async tx => { await expect(settleDueHarvesterSources(tx, f.baseId, at(f, 3))).rejects.toThrow('overflow'); });
    expect((await history(f)).events).toEqual([]);
    await db.update(resourceStocks).set({ available: 0n }).where(eq(resourceStocks.baseId, f.baseId));
    await expect(db.transaction(async tx => { await settleDueHarvesterSources(tx, f.baseId, at(f, 5)); throw new Error('outer rollback'); })).rejects.toThrow('outer rollback');
    expect((await history(f)).events).toEqual([]); expect((await stock(f))!.available).toBe(0n);
  });
  it('original output follows the saved base after inactive custody change without new authority', async () => {
    const f = await fixture(), buyer = await createTestPlayer(db);
    await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    await db.update(bases).set({ ownerWallet: buyer.wallet, status: 'inactive' }).where(eq(bases.id, f.baseId));
    await db.update(buildings).set({ level: 0 }).where(eq(buildings.id, f.buildingId));
    await settle(f, at(f, 5));
    expect((await history(f)).events.every(p => p.event.actorWallet === f.wallet && p.event.custodyWallet === buyer.wallet)).toBe(true);
    expect((await stock(f))!.available).toBe(4n);
  });
  it('does not acquire a player lock behind the base or depend on current policy selection', async () => {
    const f = await fixture(); let release!: () => void, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => { await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update'); held = true; await gate; });
    const policy = P as unknown as { currentPolicyVersion: number }, original = policy.currentPolicyVersion;
    let work: Promise<unknown> | undefined;
    try {
      await expect.poll(() => held).toBe(true); policy.currentPolicyVersion = original + 1;
      let settled = false; work = settle(f, at(f, 1)).then(value => { settled = true; return value; });
      await expect.poll(() => settled, { timeout: 3_000 }).toBe(true);
    } finally { policy.currentPolicyVersion = original; release(); await Promise.allSettled([holder, ...(work ? [work] : [])]); }
    expect((await history(f)).events).toHaveLength(1);
  });
  it('preserves known-zero-winner original-term tax liability rather than redirecting it', async () => {
    const f = await fixture(); await settle(f, at(f, 5)); const p = await history(f);
    expect(f.snapshot.spots.every(spot => spot.ownerWallet === null)).toBe(true);
    expect(p.source.termId).toBe(f.snapshot.termId);
    expect(p.events.flatMap(p => p.entries).filter(e => e.bucket === 'island_pool').reduce((sum, e) => sum + e.delta, 0n)).toBe(1n);
  });
  it('SQL refuses history mutation, missing entries, forged cadence/carry/tax/day and skipped ordinals', async () => {
    const f = await fixture(); await settle(f, at(f, 1)); const event = (await history(f)).events[0]!.event;
    await expect(db.update(harvesterEvents).set({ carryAfter: 0n }).where(eq(harvesterEvents.sourceId, f.source.id))).rejects.toThrow();
    await expect(db.delete(harvesterEntries).where(eq(harvesterEntries.sourceId, f.source.id))).rejects.toThrow();
    const next = { ...event, ordinal: 2, walletSequence: 2n, earnedAt: at(f, 2), settledAt: at(f, 2), carryBefore: 2_000n, carryAfter: 4_000n };
    await expect(db.insert(harvesterEvents).values(next)).rejects.toThrow(); // deferred full receipt required
    for (const patch of [{ ordinal: 3 }, { carryBefore: 0n }, { tax: 1n, net: 0n }, { gross: 2n, net: 2n },
      { utcDay: new Date(event.utcDay.getTime() + 86_400_000) }, { earnedAt: new Date(at(f, 2).getTime() + 1) }]) {
      await expect(db.transaction(async tx => {
        await tx.insert(harvesterEvents).values({ ...next, ...patch });
        await tx.insert(harvesterEntries).values([{ bucket: 'issued' as const, delta: -1n }, { bucket: 'base_stock' as const, delta: 1n }, { bucket: 'island_pool' as const, delta: 0n }]
          .map(entry => ({ sourceId: f.source.id, ordinal: (patch as { ordinal?: number }).ordinal ?? 2, ...entry })));
      })).rejects.toThrow();
    }
    expect((await history(f)).events).toHaveLength(1);
    const [sum] = await db.select({ sum: sql<string>`sum(${harvesterEvents.gross})::text` }).from(harvesterEvents).where(eq(harvesterEvents.actorWallet, f.wallet));
    expect(sum!.sum).toBe('1');
  });
  it('rejects backward cutoff or absent base without creating accounting evidence', async () => {
    const f = await fixture(); await expect(settle(f, new Date(f.now.getTime() - 1))).rejects.toThrow('precedes');
    await expect(db.transaction(tx => settleDueHarvesterSources(tx, randomUUID(), at(f, 1)))).rejects.toThrow('missing');
    expect(await readHarvesterSettlement(db, randomUUID())).toBeNull();
  });
});
