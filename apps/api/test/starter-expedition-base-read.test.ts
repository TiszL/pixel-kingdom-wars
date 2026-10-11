/** Authorized foreground materialization only; synthetic accepted trip fixtures
 * are not a genuine auction reader or a public dispatch entitlement. */
import { randomUUID } from 'node:crypto';
import { HEROES } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  baseHeroProgress, baseRaidLocks, bases, baseSlots, baseTrainingQueue, builderJobs, buildings,
  raids, resourceStocks, shields, starterExpeditionInflight, starterExpeditionReturns,
} from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { readStarterExpeditionReturn } from '../src/game/starterExpeditionReturns';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
beforeEach(() => { vi.stubEnv('MULTI_BASE_ENABLED', 'true'); });
afterEach(() => vi.unstubAllEnvs());
async function accepted() {
  const f = await createStarterExpeditionFixture(db);
  return { ...f, trip: await f.dispatch() };
}
type Fixture = Awaited<ReturnType<typeof accepted>>;
const read = (f: Fixture, at = f.trip.returnsAt) => getBaseState(db, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => at);
const stock = async (f: Fixture) => (await db.select().from(resourceStocks)
  .where(and(eq(resourceStocks.baseId, f.baseId), eq(resourceStocks.resourceId, f.trip.resourceId))))[0];
const active = async (f: Fixture) => (await db.select().from(starterExpeditionInflight)
  .where(eq(starterExpeditionInflight.expeditionId, f.trip.id)))[0];
async function dueRepair(f: Fixture) {
  const [trap] = await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId,
    type: 'spiketrap', tx: 10, ty: 10, trapSpentAt: f.trip.departedAt }).returning();
  const [job] = await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId, buildingId: trap!.id,
    kind: 'repair', startedAt: f.trip.departedAt, finishesAt: f.trip.returnsAt }).returning();
  return { trap: trap!, job: job! };
}
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }

describe('authorized stable /base automatic return boundary', () => {
  it('returns exactly once at the deadline during an incoming raid, without changing the existing DTO or frozen raid', async () => {
    const f = await accepted(), attacker = await createStarterExpeditionFixture(db);
    const [raid] = await db.insert(raids).values({ idempotencyKey: randomUUID(), attackerWallet: attacker.wallet,
      attackerBaseId: attacker.baseId, defenderWallet: f.wallet, defenderBaseId: f.baseId, seed: 1n,
      snapshot: { rawFrozenBeforeReturn: true }, armySnapshot: {}, simVersion: 9,
      ordersDeadlineAt: new Date(f.trip.returnsAt.getTime() + 60_000) }).returning();
    await db.insert(baseRaidLocks).values({ baseId: f.baseId, raidId: raid!.id, expiresAt: raid!.ordersDeadlineAt });
    const state = await read(f);
    expect(state.baseId).toBe(f.baseId); expect(state).not.toHaveProperty('rawResources');
    expect(await stock(f)).toMatchObject({ available: f.trip.net, reserved: 0n });
    expect(await active(f)).toBeUndefined();
    expect((await readStarterExpeditionReturn(db, f.trip.id))!.receipt.returnedAt).toEqual(f.trip.returnsAt);
    await read(f); expect(await stock(f)).toMatchObject({ available: f.trip.net });
    expect(await db.select().from(starterExpeditionReturns).where(eq(starterExpeditionReturns.expeditionId, f.trip.id))).toHaveLength(1);
    expect((await db.select().from(raids).where(eq(raids.id, raid!.id)))[0]).toEqual(raid);
  });

  it('does not claim a future return or its vehicle and later materializes at the exact boundary', async () => {
    const f = await accepted(); await read(f, new Date(f.trip.returnsAt.getTime() - 1));
    expect(await stock(f)).toBeUndefined(); expect(await active(f)).toBeDefined();
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    await read(f); expect(await stock(f)).toMatchObject({ available: f.trip.net });
  });

  it.each(['wrong-owner', 'inactive', 'missing-slot', 'authority'] as const)('%s cannot materialize through another base read', async reason => {
    const f = await accepted();
    if (reason === 'wrong-owner') f.wallet = (await createTestPlayer(db)).wallet;
    if (reason === 'inactive') await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, f.baseId));
    if (reason === 'missing-slot') await db.delete(baseSlots).where(eq(baseSlots.baseId, f.baseId));
    if (reason === 'authority') f.authority.assertAuthority = async () => { throw new Error('authority unavailable'); };
    await expect(read(f)).rejects.toThrow();
    expect(await stock(f)).toBeUndefined(); expect(await active(f)).toBeDefined();
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
  });

  it('keeps the legacy/unprotected path free of source issuance even with an explicit stable ID and due clock', async () => {
    const f = await accepted();
    await getBaseState(db, f.wallet, f.trip.returnsAt, f.baseId);
    vi.stubEnv('MULTI_BASE_ENABLED', 'false');
    await getBaseState(db, f.wallet, f.trip.returnsAt);
    expect(await stock(f)).toBeUndefined(); expect(await active(f)).toBeDefined();
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
  });

  it('outer failure rolls back both builder completion and returned stock, receipt and vehicle release', async () => {
    const f = await accepted();
    const { job } = await dueRepair(f);
    await expect(db.transaction(async tx => {
      const state = await getBaseState(tx, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => f.trip.returnsAt);
      expect(state.jobs.some(j => j.id === job!.id)).toBe(false);
      expect(await readStarterExpeditionReturn(tx, f.trip.id)).not.toBeNull();
      throw new Error('outer caller failed');
    })).rejects.toThrow('outer caller failed');
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]!.completedAt).toBeNull();
    expect(await stock(f)).toBeUndefined(); expect(await active(f)).toBeDefined();
    expect(await readStarterExpeditionReturn(db, f.trip.id)).toBeNull();
    await read(f);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id)))[0]!.completedAt).toEqual(f.trip.returnsAt);
  });

  it('waits for the base lock before sampling one cutoff for returns, builder, army, shield and hero state', async () => {
    const f = await accepted(), before = new Date(f.trip.returnsAt.getTime() - 1);
    await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId, type: HEROES.vex.altar, tx: 8, ty: 8 });
    await db.insert(baseHeroProgress).values({ baseId: f.baseId, hero: 'vex', recoveryUntil: f.trip.returnsAt });
    await db.insert(shields).values({ playerWallet: f.wallet, baseId: f.baseId, source: 'loss', expiresAt: f.trip.returnsAt });
    await db.insert(baseTrainingQueue).values({ baseId: f.baseId, troop: 'bowman', startedAt: f.trip.departedAt, finishesAt: f.trip.returnsAt });
    const { job } = await dueRepair(f);
    const permit = gate(); let holderPid: number | undefined;
    const holder = db.transaction(async tx => {
      await tx.select().from(bases).where(eq(bases.id, f.baseId)).for('update');
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
      holderPid = row!.pid; await permit.promise;
    });
    let pending: ReturnType<typeof getBaseState> | undefined;
    const clock = vi.fn(() => before);
    try {
      await expect.poll(() => holderPid, { timeout: 5_000 }).toBeDefined();
      pending = getBaseState(db, f.wallet, before, f.baseId, f.authority.assertAuthority, clock);
      await expect.poll(async () => (await conn.sql<{ waiting: boolean }[]>`
        select exists(select 1 from pg_stat_activity where ${holderPid!} = ANY(pg_blocking_pids(pid))) as waiting
      `)[0]!.waiting, { timeout: 5_000 }).toBe(true);
      expect(clock).not.toHaveBeenCalled(); clock.mockImplementation(() => f.trip.returnsAt); permit.release();
      const state = await pending;
      expect(clock).toHaveBeenCalledTimes(1);
      expect(state.jobs.some(j => j.id === job!.id)).toBe(false);
      expect(state.shield).toBeNull(); expect(state.heroes.find(h => h.hero === 'vex')!.available).toBe(true);
      expect(state.army.find(t => t.troop === 'bowman')?.count).toBe(1);
      expect((await readStarterExpeditionReturn(db, f.trip.id))!.receipt.returnedAt).toEqual(f.trip.returnsAt);
    } finally { permit.release(); await Promise.allSettled([holder, ...(pending ? [pending] : [])]); }
  });

  it('invalid server clock refuses before economic materialization', async () => {
    const f = await accepted();
    await expect(getBaseState(db, f.wallet, f.trip.returnsAt, f.baseId, f.authority.assertAuthority, () => new Date(NaN)))
      .rejects.toThrow('Invalid stable base event clock');
    expect(await stock(f)).toBeUndefined(); expect(await active(f)).toBeDefined();
  });
});
