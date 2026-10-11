/** Real service/transaction integration with synthetic authority and opening raw
 * fixtures. This does not claim genuine chain, placement or public admission. */
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_ORDINARY_CRAFTING as P, pvpAttackShardCostForKeepLevel } from '@shardkeep/shared';
import { ORDINARY_CRAFTING_ITEM_IDS } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { SIM_VERSION } from '@shardkeep/sim';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bases, baseSlots, baseTransfers, buildings, builderJobs, craftingStocks, deedOwnershipObservations, ordinaryCraftingCompletions, players,
  raids, rawRaidResources, resourceStocks } from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { assertFreshLockedBaseAuthority, observationHash, refreshBaseOwnership, transferStableBase } from '../src/game/baseOwnership';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { claimRect } from '../src/game/footprints';
import { readOrdinaryCrafting, settleDueOrdinaryCrafting, startOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { createRaid, type RaidBaseAuthority } from '../src/game/raids';
import { bootstrapSystemAccounts } from '../src/ledger';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db;
beforeAll(() => bootstrapSystemAccounts(db));
afterAll(() => conn.sql.end());
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true'); vi.stubEnv('ORDINARY_CRAFTING_ENABLED', 'true'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const key = () => Keypair.generate().publicKey.toBase58();
async function fixture(now?: Date) {
  const wallet = key(); await db.insert(players).values({ wallet });
  const f = await createStarterExpeditionFixture(db, { wallet, ...(now ? { now } : {}) });
  const [workshop] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet, type: BuildingType.Workshop, tx: 9, ty: 2 }).returning();
  const completedAt = new Date(f.now.getTime() - 1_000);
  await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: workshop!.id, kind: 'build',
    startedAt: new Date(completedAt.getTime() - BUILD_COSTS[BuildingType.Workshop].buildSec * 1_000), finishesAt: completedAt, completedAt });
  await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: 'frost_quartz', available: BigInt(P.v1.refining.rawPerOutput) });
  const command = { id: randomUUID(), baseId: f.baseId, recipeId: 'refine_frostglass', recipeVersion: P.v1.recipeVersion, quantity: 1 };
  const proof = await startOrdinaryCrafting(db, wallet, command, f.authority, { clock: () => f.now });
  return { ...f, command, job: proof.job, workshopId: workshop!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const stock = async (f: Fixture) => (await db.select().from(craftingStocks)
  .where(and(eq(craftingStocks.baseId, f.baseId), eq(craftingStocks.itemId, 'frostglass'))))[0]!;
const receipt = (f: Fixture) => readOrdinaryCrafting(db, f.job.id);
async function read(f: Fixture, at = f.job.readyAt) {
  const state = await getBaseState(db, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => at);
  if (!state.craftingStock) throw new Error('Authorized stock missing');
  return { ...state, craftingStock: state.craftingStock };
}
async function deed(f: Fixture) {
  const buyer = key(), asset = key(), collection = key(); await db.insert(players).values({ wallet: buyer });
  // Existing custody suites cover registration; this marks this accepted job's
  // historical base as deed-backed without admitting a fake production proof.
  await db.update(bases).set({ deedAssetId: asset, deedMintAssetId: asset, landPaidAt: f.now }).where(eq(bases.id, f.baseId));
  return { ...f, buyer, asset, collection, proof: { owner: buyer, collection, frozen: false, delegate: null, slot: 100 } };
}
type DeedFixture = Awaited<ReturnType<typeof deed>>;
const move = (path: 'direct' | 'observer', f: DeedFixture, at: Date) => path === 'direct'
  ? transferStableBase(db, f.baseId, f.wallet, f.buyer, f.asset, { ...f.proof, observedAtMs: at.getTime() }, () => at)
  : refreshBaseOwnership(db, f.baseId, async () => f.proof, f.collection, at, 'test-crafting-transfer', () => at);
const raidAuthority: RaidBaseAuthority = async (wallet, id, tx) => { if (tx) await assertFreshLockedBaseAuthority(tx, wallet, id); };
// 2026-10-10: 0286 refuses a raid capture cutoff later than Postgres clock_timestamp(), which no test can fake, so the
// raid fixtures share one calendar three real days ago instead of the starter fixture's 2035 default.
const raidCalendar = new Date(Date.now() - 3 * 86_400_000);
async function raidReady(fund = true) {
  const f = await fixture(raidCalendar), claim = claimRect(0), level = 5;
  await db.update(bases).set({ keepLevel: level }).where(eq(bases.id, f.baseId));
  await db.update(players).set({ keepLevel: level }).where(eq(players.wallet, f.wallet));
  for (const [i, id] of [f.berthId, f.lodgeId, f.workshopId].entries())
    await db.update(buildings).set({ tx: claim.min + i * 3, ty: claim.min }).where(eq(buildings.id, id));
  await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId, type: BuildingType.Keep, level, tx: claim.min + 9, ty: claim.min });
  if (fund) await rewardBaseShards(db, f.baseId, BigInt(pvpAttackShardCostForKeepLevel(level)), 'crafting.integration.fixture', randomUUID());
  return f;
}
const options = (a: Fixture, d: Fixture) => ({ attackerBaseId: a.baseId, defenderBaseId: d.baseId, defenderWallet: d.wallet,
  idempotencyKey: randomUUID(), authorizeAttackerBase: raidAuthority, authorizeDefenderBase: raidAuthority });

describe('ordinary completion at authorized stable boundaries', () => {
  it('publishes only available/pending decimal stock from the selected base at the exact deadline', async () => {
    const f = await fixture(), other = await fixture();
    const before = await read(f, new Date(f.job.readyAt.getTime() - 1));
    expect(before.craftingStock.map(r => r.itemId)).toEqual([...ORDINARY_CRAFTING_ITEM_IDS]);
    expect(before.craftingStock.find(r => r.itemId === 'frostglass')).toEqual({ itemId: 'frostglass', available: '0', pendingOutput: f.job.outputQuantity.toString() });
    const after = await read(f);
    expect(after.craftingStock.find(r => r.itemId === 'frostglass')).toEqual({ itemId: 'frostglass', available: f.job.outputQuantity.toString(), pendingOutput: '0' });
    expect(() => JSON.stringify(after.craftingStock)).not.toThrow();
    expect(await read(f)).toEqual(after);
    expect((await receipt(other))!.completion).toBeNull();
    expect(await db.select().from(ordinaryCraftingCompletions).where(eq(ordinaryCraftingCompletions.jobId, f.job.id))).toHaveLength(1);
  });

  it.each(['wrong-owner', 'inactive', 'missing-slot', 'authority'] as const)('%s cannot complete or read crafting through another base', async reason => {
    const f = await fixture();
    if (reason === 'wrong-owner') { f.wallet = key(); await db.insert(players).values({ wallet: f.wallet }); }
    if (reason === 'inactive') await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    if (reason === 'missing-slot') await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    if (reason === 'authority') f.authority.assertAuthority = async () => { throw new Error('unavailable'); };
    await expect(read(f)).rejects.toThrow();
    expect((await receipt(f))!.completion).toBeNull(); expect((await stock(f)).available).toBe(0n);
  });

  it('keeps legacy/unprotected reads free of the field and completion side effects', async () => {
    const f = await fixture();
    expect(await getBaseState(db, f.wallet, f.job.readyAt, f.baseId)).not.toHaveProperty('craftingStock');
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    expect(await getBaseState(db, f.wallet, f.job.readyAt)).not.toHaveProperty('craftingStock');
    expect((await receipt(f))!.completion).toBeNull();
  });

  it('rolls authorized read completion and protected projection back with its outer transaction', async () => {
    const f = await fixture();
    await expect(db.transaction(async tx => {
      const state = await getBaseState(tx, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => f.job.readyAt);
      expect(state).toHaveProperty('craftingStock'); expect((await readOrdinaryCrafting(tx, f.job.id))!.completion).not.toBeNull();
      throw new Error('outer failed');
    })).rejects.toThrow('outer failed');
    expect((await receipt(f))!.completion).toBeNull(); expect((await stock(f)).pendingOutput).toBe(f.job.outputQuantity);
  });

  it('samples the authorized read cutoff after a real base-lock wait crosses readiness', async () => {
    const f = await fixture(); let release!: () => void, holderPid: number | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
      const [row] = await tx.execute(sql`SELECT pg_backend_pid() AS pid`) as unknown as Array<{ pid: number }>;
      holderPid = row!.pid; await gate;
    });
    const clock = vi.fn(() => new Date(f.job.readyAt.getTime() - 1));
    let pending: ReturnType<typeof getBaseState> | undefined;
    try {
      await expect.poll(() => holderPid, { timeout: 5_000 }).toBeDefined();
      pending = getBaseState(db, f.wallet, f.now, f.baseId, f.authority.assertAuthority, clock);
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid!}=ANY(pg_blocking_pids(pid))) AS waiting`)[0]!.waiting,
        { timeout: 5_000 }).toBe(true);
      expect(clock).not.toHaveBeenCalled(); clock.mockImplementation(() => f.job.readyAt); release(); await pending;
      expect(clock).toHaveBeenCalledTimes(1); expect((await receipt(f))!.completion!.completedAt).toEqual(f.job.readyAt);
    } finally { release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); }
  });

  it.each(['direct', 'observer'] as const)('completes due work before %s custody, while retaining original job ownership', async path => {
    const f = await deed(await fixture()); await move(path, f, f.job.readyAt);
    expect((await receipt(f))!).toMatchObject({ job: { actorWallet: f.wallet, baseId: f.baseId }, completion: { custodyWallet: f.wallet, completedAt: f.job.readyAt } });
    expect((await db.select().from(bases).where(eq(bases.id, f.baseId)))[0]!.ownerWallet).toBe(f.buyer);
    expect((await stock(f)).available).toBe(f.job.outputQuantity);
  });

  it.each(['direct', 'observer'] as const)('keeps future work on the original base through %s custody and later credits the buyer', async path => {
    const f = await deed(await fixture()); await move(path, f, new Date(f.job.readyAt.getTime() - 1));
    expect((await receipt(f))!.completion).toBeNull();
    await db.transaction(tx => settleDueOrdinaryCrafting(tx, f.baseId, f.job.readyAt));
    expect((await receipt(f))!.completion!.custodyWallet).toBe(f.buyer);
  });

  it('rolls canonical transfer and completion back while retaining the independently finalized custody fact', async () => {
    const f = await deed(await fixture()), transaction = db.transaction.bind(db);
    const beforeBase = await db.select().from(bases).where(eq(bases.id, f.baseId));
    const beforeSlots = await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    const fail = vi.spyOn(db, 'transaction').mockImplementation((work, config) => transaction(async tx => {
      const result = await work(tx);
      // The independent fact journal writes no transfer or completion. Fail
      // only after the canonical move has produced its actual transfer audit.
      const transfers = await tx.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, f.asset));
      if (!transfers.length) return result;
      expect(transfers).toHaveLength(1);
      expect((await readOrdinaryCrafting(tx, f.job.id))!.completion).toMatchObject({ custodyWallet: f.wallet, completedAt: f.job.readyAt });
      expect((await tx.select().from(bases).where(eq(bases.id, f.baseId)))[0]!.ownerWallet).toBe(f.buyer);
      throw new Error('transfer tail failed');
    }, config));
    try { await expect(move('direct', f, f.job.readyAt)).rejects.toThrow('transfer tail failed'); }
    finally { fail.mockRestore(); }
    expect((await receipt(f))!.completion).toBeNull(); expect((await stock(f)).available).toBe(0n);
    expect(await db.select().from(bases).where(eq(bases.id, f.baseId))).toEqual(beforeBase);
    expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, f.baseId))).toEqual(beforeSlots);
    expect(await db.select().from(baseTransfers).where(eq(baseTransfers.deedAssetId, f.asset))).toEqual([]);
    expect(await db.select().from(deedOwnershipObservations).where(eq(deedOwnershipObservations.baseId, f.baseId))).toMatchObject([
      { assetId: f.asset, owner: f.buyer, status: 'mismatch', slot: BigInt(f.proof.slot), checkedAt: f.job.readyAt,
        auditHash: observationHash(f.asset, f.buyer, 'mismatch', BigInt(f.proof.slot), f.job.readyAt) },
    ]);
  });

  it('retains outgoing-raid refusal/defer before either custody completion path', async () => {
    const f = await deed(await fixture()), opponent = await fixture();
    await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: f.wallet, attackerBaseId: f.baseId, defenderWallet: opponent.wallet,
      defenderBaseId: opponent.baseId, seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: SIM_VERSION, ordersDeadlineAt: new Date(f.job.readyAt.getTime() + 60_000) });
    await expect(move('direct', f, f.job.readyAt)).rejects.toMatchObject({ code: 'BASE_BUSY_ATTACKING' });
    expect(await move('observer', f, f.job.readyAt)).toBe('mismatch'); expect((await receipt(f))!.completion).toBeNull();
  });

  it('raid admission completes both bases without adding protected output to raw loot', async () => {
    const a = await raidReady(), d = await raidReady();
    const raid = await createRaid(db, a.wallet, options(a, d), d.job.readyAt);
    for (const f of [a, d]) expect((await receipt(f))!.completion!.completedAt).toEqual(d.job.readyAt);
    const raw = await db.select().from(rawRaidResources).where(eq(rawRaidResources.raidId, raid.id));
    expect(raw).toHaveLength(8); expect(raw.every(r => r.available === 0n && r.reserved === 0n && r.maximum === 0n)).toBe(true);
    expect((await stock(d)).available).toBe(d.job.outputQuantity);
  });

  it('later authorized completion during an incoming raid preserves its frozen loot and battle snapshot', async () => {
    const a = await raidReady(), d = await raidReady();
    const raid = await createRaid(db, a.wallet, options(a, d), new Date(d.job.readyAt.getTime() - 1));
    const frozen = await db.select().from(rawRaidResources).where(eq(rawRaidResources.raidId, raid.id));
    expect((await receipt(d))!.completion).toBeNull(); await read(d);
    expect((await receipt(d))!.completion).not.toBeNull();
    expect(await db.select().from(rawRaidResources).where(eq(rawRaidResources.raidId, raid.id))).toEqual(frozen);
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0]!.snapshot).toEqual(raid.snapshot);
  });

  it('failed raid payment rolls back automatic completion on both bases', async () => {
    const a = await raidReady(false), d = await raidReady();
    await expect(createRaid(db, a.wallet, options(a, d), d.job.readyAt)).rejects.toThrow('not enough shards');
    for (const f of [a, d]) { expect((await receipt(f))!.completion).toBeNull(); expect((await stock(f)).available).toBe(0n); }
  });
});
