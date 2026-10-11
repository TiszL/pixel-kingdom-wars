/** Ordinary construction, actual cost/completion and retained starter identity.
 * No fixture-created berths stand in for the player's placement transaction. */
import { randomUUID } from 'node:crypto';
import { BUILD_COSTS, BuildingType, PHASE_E_BUILDINGS, PHASE_E_VEHICLES } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots, builderJobs, buildings, players } from '../src/db/schema';
import { completeDueJobs, getBaseState, placeBuilding } from '../src/game/base';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { claimRect } from '../src/game/footprints';
import { getStarterFleet, installStarterFleet } from '../src/game/starterFleet';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer } from './helpers';
const conn = connectTestDb(), db = conn.db, now = new Date('2026-09-22T10:00:00Z'), claim = claimRect(0);
beforeAll(() => bootstrapSystemAccounts(db)); afterAll(() => conn.sql.end());
beforeEach(() => {
  for (const name of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_VEHICLES_ENABLED']) vi.stubEnv(name, 'true');
  vi.stubEnv('PHASE_E_ART_ENABLED', undefined);
});
afterEach(() => vi.unstubAllEnvs());
async function fixture(level: number = BUILD_COSTS.berth.requiresKeepLevel, buildersCount = 3) {
  const { wallet } = await createTestPlayer(db);
  await db.update(players).set({ keepLevel: level }).where(eq(players.wallet, wallet));
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, keepLevel: level, builders: buildersCount }).returning();
  const baseId = base!.id; await db.insert(baseSlots).values({ wallet, baseId, slot: 1 });
  await rewardBaseShards(db, baseId, 100_000n, 'test.berth.cap', randomUUID());
  const context = { baseId, assertAuthority: async (tx: Parameters<typeof assertFreshLockedBaseAuthority>[0], actor: string, id: string) => { await assertFreshLockedBaseAuthority(tx, actor, id); } };
  const place = (index: number, type = BuildingType.Berth) => placeBuilding(db, wallet, type, claim.min + index * 2, claim.min, randomUUID(), now, baseId, context);
  const finish = async (id: string) => { const [job] = await db.select().from(builderJobs).where(eq(builderJobs.buildingId, id));
    await completeDueJobs(db, wallet, job!.finishesAt, baseId); return job!; };
  return { wallet, baseId, context, place, finish,
    balance: () => getBaseShardBalance(db, baseId),
    rows: () => db.select().from(buildings).where(eq(buildings.baseId, baseId)),
    view: () => getBaseState(db, wallet, now, baseId, context.assertAuthority, () => now) };
}
describe('ordinary five-berth construction', () => {
  it('charges and completes berths one through five, retains the real starter and refuses sixth without spend', async () => {
    const f = await fixture(), opening = await f.balance(), first = await f.place(0); await f.finish(first.id);
    const starter = await installStarterFleet(db, f.wallet, first.id, f.context);
    for (let i = 1; i < PHASE_E_VEHICLES.installationsPerBaseMax; i++) {
      const berth = await f.place(i); expect(berth).toMatchObject({ type: 'berth', level: 1, tx: claim.min + i * 2, ty: claim.min });
      const [job] = await db.select().from(builderJobs).where(eq(builderJobs.buildingId, berth.id));
      expect(job!.finishesAt.getTime() - job!.startedAt.getTime()).toBe(BUILD_COSTS.berth.buildSec * 1000);
      if (i < PHASE_E_VEHICLES.installationsPerBaseMax - 1) await f.finish(berth.id);
    }
    expect(await f.balance()).toBe(opening - BigInt(BUILD_COSTS.berth.costShards * PHASE_E_VEHICLES.installationsPerBaseMax));
    const view = await f.view(); expect(view.constructionCapacity).toEqual({ version: 1, berth: { max: 5 } });
    expect(view.features.phaseEBuildings).toEqual({ version: 1, enabledTypes: [...PHASE_E_BUILDINGS.types] });
    expect(view.buildings.filter(b => b.underConstruction)).toHaveLength(1);
    const before = await f.balance(); await expect(f.place(5)).rejects.toThrow('berth cap reached');
    expect(await f.balance()).toBe(before); expect(await f.rows()).toHaveLength(5);
    vi.stubEnv('PHASE_E_VEHICLES_ENABLED', 'false'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false');
    await completeDueJobs(db, f.wallet, new Date(now.getTime() + BUILD_COSTS.berth.buildSec * 1000), f.baseId);
    expect(await getStarterFleet(db, f.wallet, f.context)).toEqual(starter);
    expect((await f.view()).buildings.every(b => !b.underConstruction)).toBe(true);
    expect((await f.view()).constructionCapacity.berth.max).toBe(1);
    expect((await f.view()).features.phaseEBuildings.enabledTypes).toEqual([]);
  });
  it('preserves the legacy one-berth cap when vehicle admission is off or malformed', async () => {
    const f = await fixture(); const first = await f.place(0); await f.finish(first.id);
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      vi.stubEnv('PHASE_E_VEHICLES_ENABLED', value); const before = await f.balance();
      await expect(f.place(1)).rejects.toThrow('berth cap reached'); expect(await f.balance()).toBe(before);
      expect((await f.view()).constructionCapacity.berth.max).toBe(1);
    }
  });
  it('keeps the existing Keep unlock and pauses Phase E placement without charging', async () => {
    const f = await fixture(BUILD_COSTS.berth.requiresKeepLevel - 1), before = await f.balance();
    await expect(f.place(0)).rejects.toThrow('requires Keep level'); expect((await f.view()).constructionCapacity.berth.max).toBe(0);
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'false'); await expect(f.place(0)).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
    expect(await f.balance()).toBe(before); expect(await f.rows()).toHaveLength(0);
  });
  it('preserves builders and footprint checks, including a cap change during authority acquisition', async () => {
    const f = await fixture(BUILD_COSTS.berth.requiresKeepLevel, 1), first = await f.place(0), before = await f.balance();
    await expect(f.place(1)).rejects.toThrow('all builders are busy'); expect(await f.balance()).toBe(before);
    await f.finish(first.id); await expect(f.place(0)).rejects.toThrow(); expect(await f.balance()).toBe(before);
    const original = f.context.assertAuthority;
    f.context.assertAuthority = async (...args) => { await original(...args); vi.stubEnv('PHASE_E_VEHICLES_ENABLED', 'false'); };
    await expect(f.place(1)).rejects.toThrow('berth cap reached'); expect(await f.rows()).toHaveLength(1); expect(await f.balance()).toBe(before);
  });
  it('serializes the fifth/sixth race and counts an unfinished fifth berth', async () => {
    const f = await fixture(); for (let i = 0; i < 4; i++) { const b = await f.place(i); await f.finish(b.id); }
    const before = await f.balance(), attempts = await Promise.allSettled([f.place(4), f.place(5)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(attempts.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(await f.balance()).toBe(before - BigInt(BUILD_COSTS.berth.costShards)); expect(await f.rows()).toHaveLength(5);
    expect(await db.select().from(builderJobs).where(and(eq(builderJobs.baseId, f.baseId), eq(builderJobs.kind, 'build')))).toHaveLength(5);
  });
});

// D153.299–306 / IW5: discovery broadens under the existing dark flag only.
describe('five-type construction discovery remains default-off', () => {
  it.each([undefined, 'false', 'TRUE', '1', ''])('does not advertise types for flag %s', async value => {
    const f = await fixture(); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', value);
    const view = await f.view();
    expect(view.features.phaseEBuildings).toEqual({ version: 1, enabledTypes: [] });
    // b37cc131 S1: the server states art permission; building discovery alone never grants it.
    expect(view.features.phaseEArt).toEqual({ version: 1, enabled: false });
  });
  it('advertises exactly the five registry types while preserving their Keep gates', async () => {
    const f = await fixture(BUILD_COSTS.workshop.requiresKeepLevel - 1);
    const view = await f.view();
    expect(view.features.phaseEBuildings).toEqual({ version: 1,
      enabledTypes: ['workshop', 'lodge', 'market', 'harvester', 'berth'] });
    // b37cc131 S1: the server states art permission; building discovery alone never grants it.
    expect(view.features.phaseEArt).toEqual({ version: 1, enabled: false });
    for (const type of PHASE_E_BUILDINGS.types) {
      const before = await f.balance();
      await expect(f.place(0, type as BuildingType)).rejects.toThrow('requires Keep level');
      expect(await f.balance()).toBe(before);
    }
  });
});
