/** Real enabled construction and raid admission. Only ordinary free base/army
 * prerequisites are seeded; every Phase E facility is placed by the service.
 * This establishes no renderer/art, genuine Seeker or public-release readiness. */
import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType, CAPS, PHASE_E_BUILDINGS, STRUCTURES,
  pvpAttackShardCostForKeepLevel, type BaseSnapshot } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbOrTx } from '../src/db/client';
import { baseArmy, baseDailyActivity, baseQuestProgress, bases, baseSlots, builderJobs, buildings,
  ledgerTransactions, players, raids } from '../src/db/schema';
import { completeDueJobs, getBaseState, moveBuilding, placeBuilding } from '../src/game/base';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { getConstructionReceipt } from '../src/game/constructionReceipt';
import * as emission from '../src/game/emission';
import { claimRect, footprintOf } from '../src/game/footprints';
import { compensatePendingRaid, createRaid, type RaidBaseAuthority } from '../src/game/raids';
import { createTestPlayer } from './helpers';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';

const conn = resourceClaimsDatabase(), db = conn.db;
// Exercise the legacy vehicles-off one-per-base cap; vehicles-on five-berth
// admission are preserved; IW5 now advertises all five types under the same dark flag.
const types = PHASE_E_BUILDINGS.types, claim = claimRect(0);
// Both explicit raid admissions must precede compensation's real wall clock.
// Keep the whole construction window in the past; a fixed future fixture
// correctly fails the immutable terminal.settledAt >= snapshot.frozenAt guard.
const now = new Date(Date.now() - (Math.max(...types.map(type => BUILD_COSTS[type].buildSec)) + 1) * 1_000);
const level = Math.max(...types.map(type => BUILD_COSTS[type].requiresKeepLevel));
const budget = BigInt(types.reduce((sum, type) => sum + BUILD_COSTS[type].costShards, 0)
  + BUILD_COSTS.vault.costShards + pvpAttackShardCostForKeepLevel(level)) * 2n;
beforeAll(() => conn.setup(), 120000);
afterAll(() => conn.close());
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('PHASE_E_VEHICLES_ENABLED', 'false'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function fixture(keepLevel = level, builders: number = CAPS.buildersMax, funding = budget) {
  const { wallet } = await createTestPlayer(db);
  await db.update(players).set({ keepLevel, builders }).where(eq(players.wallet, wallet));
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', keepLevel, builders }).returning();
  const baseId = base!.id;
  await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  await db.insert(buildings).values({ playerWallet: wallet, baseId, type: BuildingType.Keep,
    level: keepLevel, tx: claim.min, ty: claim.min });
  await rewardBaseShards(db, baseId, funding, 'test.phase-e.placement', randomUUID());
  const context = { baseId, assertAuthority: async (tx: DbOrTx, actor: string, id: string) => {
    await assertFreshLockedBaseAuthority(tx, actor, id);
  } };
  return { wallet, baseId, context };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const place = (f: Fixture, type: BuildingType, x = claim.min + 4, y = claim.min, key = randomUUID()) =>
  placeBuilding(db, f.wallet, type, x, y, key, now, f.baseId, f.context);
const jobs = (f: Fixture) => db.select().from(builderJobs).where(eq(builderJobs.baseId, f.baseId)).orderBy(builderJobs.id);
const placed = (f: Fixture) => db.select().from(buildings).where(eq(buildings.baseId, f.baseId)).orderBy(buildings.id);
const state = (f: Fixture) => Promise.all([getBaseShardBalance(db, f.baseId), placed(f), jobs(f),
  db.select().from(baseDailyActivity).where(eq(baseDailyActivity.baseId, f.baseId)),
  db.select().from(baseQuestProgress).where(eq(baseQuestProgress.baseId, f.baseId)).orderBy(baseQuestProgress.questId)]);
const read = (f: Fixture, at: Date) => getBaseState(db, f.wallet, at, f.baseId, f.context.assertAuthority, () => at);
const raidAuthority: RaidBaseAuthority = async (wallet, baseId, tx) => {
  if (tx) await assertFreshLockedBaseAuthority(tx, wallet, baseId);
};
async function attack(defender: Fixture, at: Date) {
  const attacker = await fixture();
  await db.insert(baseArmy).values({ baseId: attacker.baseId, troop: 'plunderer', count: 1 });
  return createRaid(db, attacker.wallet, { attackerBaseId: attacker.baseId, defenderBaseId: defender.baseId,
    defenderWallet: defender.wallet, idempotencyKey: randomUUID(),
    authorizeAttackerBase: raidAuthority, authorizeDefenderBase: raidAuthority }, at);
}

describe('enabled Phase E placement reaches authoritative combat snapshots', () => {
  it.each(types)('%s charges the catalogue price, blocks construction tiles and joins combat only at completion', async name => {
    const type = name as BuildingType, f = await fixture(level, 1), key = randomUUID();
    const before = await getBaseShardBalance(db, f.baseId), building = await place(f, type, claim.min + 4, claim.min, key);
    expect(building).toMatchObject({ type, level: 1, baseId: f.baseId });
    expect(await getBaseShardBalance(db, f.baseId)).toBe(before - BigInt(BUILD_COSTS[name].costShards));
    const construction = (await jobs(f))[0]!;
    expect(await jobs(f)).toHaveLength(1);
    expect(construction).toMatchObject({ kind: 'build', buildingId: building.id, startedAt: now, completedAt: null,
      finishesAt: new Date(now.getTime() + BUILD_COSTS[name].buildSec * 1_000) });
    const receiptRequest = { type, tx: building.tx, ty: building.ty, baseId: f.baseId, idempotencyKey: key };
    const receipt = await getConstructionReceipt(db, f.wallet, receiptRequest);
    expect(receipt).toMatchObject({ status: 'accepted', request: receiptRequest,
      funding: { currency: 'SHARDS', amount: String(BUILD_COSTS[name].costShards) } });
    await expect(place(f, BuildingType.Vault, claim.min + 8)).rejects.toThrow('all builders are busy');
    const beforeDue = new Date(construction.finishesAt.getTime() - 1);
    const constructing = await read(f, beforeDue);
    expect(constructing.features.phaseEBuildings).toEqual({ version: 1, enabledTypes: [...PHASE_E_BUILDINGS.types] });
    expect(constructing.buildings.find(b => b.id === building.id)?.underConstruction).toBe(true);
    const unfinished = await attack(f, beforeDue);
    try {
      const snapshot = unfinished.snapshot as BaseSnapshot;
      expect(unfinished.simVersion).toBe(SIM_VERSION);
      expect(snapshot.buildings.some(b => b.id === building.id)).toBe(false);
      expect(snapshot.deploymentBlockers).toContainEqual({ tx: building.tx, ty: building.ty, ...footprintOf(type) });
    } finally { expect(await compensatePendingRaid(db, unfinished, false)).toBe(true); }
    // Raid admission itself must materialize the due construction even when
    // neither owner has fetched Home since its original timer elapsed.
    const complete = await attack(f, construction.finishesAt);
    try {
      const snapshot = complete.snapshot as BaseSnapshot;
      expect(snapshot.buildings).toContainEqual({ id: building.id, type, level: 1, tx: building.tx, ty: building.ty });
      expect(snapshot.deploymentBlockers ?? []).not.toContainEqual({ tx: building.tx, ty: building.ty, ...footprintOf(type) });
      expect((await jobs(f))[0]!.completedAt).toEqual(construction.finishesAt);
      expect((await read(f, construction.finishesAt)).buildings.find(b => b.id === building.id)?.underConstruction).toBe(false);
      expect(await getConstructionReceipt(db, f.wallet, receiptRequest)).toEqual(receipt);
      expect((await db.select().from(raids).where(eq(raids.id, unfinished.id)))[0]!.snapshot).toEqual(unfinished.snapshot);
    } finally { expect(await compensatePendingRaid(db, complete, false)).toBe(true); }
  });

  it.each(types)('%s occupies its complete 2×2 footprint while building and cannot cross either claim edge', async name => {
    const f = await fixture(), type = name as BuildingType, before = await state(f);
    expect(STRUCTURES[name].footprint).toEqual([2, 2]);
    await expect(place(f, type, claim.max - 1, claim.min)).rejects.toThrow('outside the buildable claim');
    await expect(place(f, type, claim.min + 4, claim.max - 1)).rejects.toThrow('outside the buildable claim');
    expect(await state(f)).toEqual(before);
    const building = await place(f, type), occupied = await state(f), { fw, fh } = footprintOf(type);
    for (let dx = 0; dx < fw; dx++) for (let dy = 0; dy < fh; dy++)
      await expect(place(f, BuildingType.Wall, building.tx + dx, building.ty + dy)).rejects.toThrow('overlaps another building');
    expect(await state(f)).toEqual(occupied);
    // The first adjacent tile is legal; occupancy cannot silently grow past2×2.
    expect(await place(f, BuildingType.Wall, building.tx + fw, building.ty)).toMatchObject({ type: BuildingType.Wall });
  });

  for (const sameKey of [false, true]) it.each(types)(`%s enforces its Keep gate and one-per-base cap under ${sameKey ? 'same' : 'different'}-key races`, async name => {
    const type = name as BuildingType, gate = BUILD_COSTS[name].requiresKeepLevel;
    const f = await fixture(gate - 1), before = await state(f);
    await expect(place(f, type)).rejects.toThrow(`requires Keep level ${gate}`);
    expect(await state(f)).toEqual(before);
    await db.update(bases).set({ keepLevel: gate }).where(eq(bases.id, f.baseId));
    await db.update(players).set({ keepLevel: gate }).where(eq(players.wallet, f.wallet));
    await db.update(buildings).set({ level: gate }).where(and(eq(buildings.baseId, f.baseId), eq(buildings.type, BuildingType.Keep)));
    const firstKey = randomUUID(), secondKey = sameKey ? firstKey : randomUUID();
    const attempts = await Promise.allSettled([place(f, type, claim.min + 4, claim.min, firstKey),
      place(f, type, claim.min + 8, claim.min, secondKey)]);
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
    expect((await placed(f)).filter(b => b.type === type)).toHaveLength(1);
    expect(await jobs(f)).toHaveLength(1);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(budget - BigInt(BUILD_COSTS[name].costShards));
    const accepted = await state(f);
    await expect(place(f, type, claim.min + 10)).rejects.toThrow(`${type} cap reached`);
    expect(await state(f)).toEqual(accepted);
  });

  it('rolls the real debit back when construction fails after charging, and leaves the original key reusable', async () => {
    const f = await fixture(), type = BuildingType.Workshop, key = randomUUID(), before = await state(f);
    const realMark = emission.markBuildAction;
    const fault = vi.spyOn(emission, 'markBuildAction').mockImplementationOnce(async (tx, wallet, at, baseId) => {
      expect(await getBaseShardBalance(tx, f.baseId)).toBe(budget - BigInt(BUILD_COSTS.workshop.costShards));
      await realMark(tx, wallet, at, baseId);
      throw new Error('construction tail failed');
    });
    await expect(place(f, type, claim.min + 4, claim.min, key)).rejects.toThrow('construction tail failed');
    fault.mockRestore(); expect(await state(f)).toEqual(before);
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey, `build:${f.wallet}:${key}`))).toEqual([]);
    expect(await place(f, type, claim.min + 4, claim.min, key)).toMatchObject({ type });
    expect(await jobs(f)).toHaveLength(1);
  });

  it('an insufficient balance cannot create a building, job, activity or accepted receipt', async () => {
    const f = await fixture(level, CAPS.buildersMax, BigInt(BUILD_COSTS.harvester.costShards) - 1n);
    const key = randomUUID(), before = await state(f), type = BuildingType.Harvester;
    await expect(place(f, type, claim.min + 4, claim.min, key)).rejects.toMatchObject({ code: 'INSUFFICIENT_SHARDS' });
    expect(await state(f)).toEqual(before);
    expect(await getConstructionReceipt(db, f.wallet, { type, tx: claim.min + 4, ty: claim.min, baseId: f.baseId, idempotencyKey: key }))
      .toMatchObject({ status: 'unknown' });
  });

  it('original placement receipts survive completion, movement and pause without replacing or charging again', async () => {
    const f = await fixture(), type = BuildingType.Lodge, key = randomUUID(), building = await place(f, type, claim.min + 4, claim.min, key);
    const request = { type, tx: building.tx, ty: building.ty, baseId: f.baseId, idempotencyKey: key };
    const receipt = await getConstructionReceipt(db, f.wallet, request), due = (await jobs(f))[0]!.finishesAt;
    expect(receipt.status).toBe('accepted'); await completeDueJobs(db, f.wallet, due, f.baseId);
    await moveBuilding(db, f.wallet, building.id, building.tx, building.ty + 3, f.baseId, f.context);
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false');
    const paused = await read(f, due);
    expect(paused.features.phaseEBuildings).toEqual({ version: 1, enabledTypes: [] });
    expect(paused.buildings.find(b => b.id === building.id)).toMatchObject({ type, tx: building.tx, ty: building.ty + 3, underConstruction: false });
    const before = await state(f);
    expect(await getConstructionReceipt(db, f.wallet, request)).toEqual(receipt);
    expect(await getConstructionReceipt(db, f.wallet, { ...request, ty: building.ty + 3 })).toMatchObject({ status: 'unknown' });
    await expect(place(f, type, request.tx, request.ty, key)).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
    expect(await state(f)).toEqual(before);
  });
});
