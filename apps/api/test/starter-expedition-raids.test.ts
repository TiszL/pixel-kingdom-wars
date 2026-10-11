/** Return timing integration, not raw-resource loot implementation or SIM18. */
import { randomUUID } from 'node:crypto';
import { BuildingType, pvpAttackShardCostForKeepLevel } from '@shardkeep/shared';
import { RAW_RESOURCE_STORAGE_MAX } from '@shardkeep/shared/phaseEResources';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bases, buildings, players, raidLootReservations, raids, resourceStocks, starterExpeditionInflight } from '../src/db/schema';
import { claimRect } from '../src/game/footprints';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { createRaid, getRaidEnergy, raidOrdersWindowMs, type RaidBaseAuthority } from '../src/game/raids';
import { readStarterExpeditionReturn, settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { bootstrapSystemAccounts, getOrCreateBaseAccount } from '../src/ledger';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db;
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
beforeAll(async () => { process.env['MULTI_BASE_ENABLED'] = 'true'; await bootstrapSystemAccounts(db); });
afterAll(async () => {
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
  await conn.sql.end();
});
const authority: RaidBaseAuthority = async (wallet, baseId, tx) => {
  if (tx) await assertFreshLockedBaseAuthority(tx, wallet, baseId);
};
// 2026-10-10: 0286 refuses a raid capture cutoff later than Postgres clock_timestamp() and 0257/0279 a starter return
// after it; no test can fake the DB clock. The fixture's 2035-01-01T01:00Z default becomes 01:00Z three real days ago,
// keeping the UTC-midnight alignment the base-lock test crosses.
const DAY_MS = 86_400_000, day = new Date(Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS), dispatchAt = new Date(+day + 3_600_000);
async function ready(fund = true) {
  const f = await createStarterExpeditionFixture(db, { now: dispatchAt });
  const claim = claimRect(0), keepLevel = 5;
  await db.update(bases).set({ keepLevel }).where(eq(bases.id, f.baseId));
  await db.update(players).set({ keepLevel }).where(eq(players.wallet, f.wallet));
  await db.update(buildings).set({ tx: claim.min, ty: claim.min }).where(eq(buildings.id, f.berthId));
  await db.update(buildings).set({ tx: claim.min + 3, ty: claim.min }).where(eq(buildings.id, f.lodgeId));
  await db.insert(buildings).values({ playerWallet: f.wallet, baseId: f.baseId, type: BuildingType.Keep,
    level: keepLevel, tx: claim.min + 6, ty: claim.min });
  const ante = BigInt(pvpAttackShardCostForKeepLevel(keepLevel));
  expect(ante).toBeGreaterThan(0n);
  // Explicit synthetic test funding; no production source authority implied.
  if (fund) await rewardBaseShards(db, f.baseId, ante, 'expedition.raid.fixture', randomUUID());
  return f;
}
type Fixture = Awaited<ReturnType<typeof ready>>;
const options = (a: Fixture, d: Fixture, key = randomUUID()) => ({ attackerBaseId: a.baseId,
  defenderBaseId: d.baseId, defenderWallet: d.wallet, idempotencyKey: key,
  authorizeAttackerBase: authority, authorizeDefenderBase: authority });
const raw = (f: Fixture) => db.select().from(resourceStocks).where(eq(resourceStocks.baseId, f.baseId));

describe('stable raid creation materializes accepted sources atomically', () => {
  it('settles both bases at the same cutoff before freezing the raid', async () => {
    const a = await ready(), d = await ready(), outgoing = await a.dispatch(), returning = await d.dispatch();
    const raid = await createRaid(db, a.wallet, options(a, d), returning.returnsAt);
    expect((await readStarterExpeditionReturn(db, outgoing.id))!.receipt.returnedAt).toEqual(returning.returnsAt);
    expect((await readStarterExpeditionReturn(db, returning.id))!.receipt.returnedAt).toEqual(returning.returnsAt);
    expect((await raw(a))[0]!.available).toBe(outgoing.net);
    expect((await raw(d))[0]!.available).toBe(returning.net);
    expect(raid.ordersDeadlineAt.getTime()).toBe(returning.returnsAt.getTime() + raidOrdersWindowMs());
  });

  it('a later return does not rewrite an earlier snapshot or existing SHARDS reservation', async () => {
    const a = await ready(), d = await ready(), trip = await d.dispatch();
    const raid = await createRaid(db, a.wallet, options(a, d), new Date(trip.returnsAt.getTime() - 1));
    expect(await readStarterExpeditionReturn(db, trip.id)).toBeNull();
    const reservation = await db.select().from(raidLootReservations).where(eq(raidLootReservations.raidId, raid.id));
    await db.transaction(tx => settleDueStarterExpeditions(tx, d.baseId, trip.returnsAt));
    expect((await raw(d))[0]!.available).toBe(trip.net);
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0]!.snapshot).toEqual(raid.snapshot);
    expect(await db.select().from(raidLootReservations).where(eq(raidLootReservations.raidId, raid.id))).toEqual(reservation);
  });

  it('failed downstream ante rolls back both returns and vehicle releases', async () => {
    const a = await ready(false), d = await ready(), at = await a.dispatch(), dt = await d.dispatch();
    await expect(createRaid(db, a.wallet, options(a, d), dt.returnsAt)).rejects.toThrow('not enough shards');
    expect(await raw(a)).toEqual([]); expect(await raw(d)).toEqual([]);
    expect(await readStarterExpeditionReturn(db, at.id)).toBeNull();
    expect(await readStarterExpeditionReturn(db, dt.id)).toBeNull();
    for (const trip of [at, dt]) expect(await db.select().from(starterExpeditionInflight)
      .where(eq(starterExpeditionInflight.expeditionId, trip.id))).toHaveLength(1);
    expect(await db.select().from(raids).where(eq(raids.attackerBaseId, a.baseId))).toEqual([]);
  });

  it('original raid replay neither resamples time nor settles a newly due source', async () => {
    const a = await ready(), d = await ready(), trip = await d.dispatch(), request = options(a, d);
    const raid = await createRaid(db, a.wallet, request, new Date(trip.returnsAt.getTime() - 1));
    const replay = await createRaid(db, a.wallet, request, () => { throw new Error('clock must not run on receipt replay'); });
    expect(replay.id).toBe(raid.id);
    expect(await readStarterExpeditionReturn(db, trip.id)).toBeNull();
    expect(await raw(d)).toEqual([]);
  });

  it('samples after a real base-lock wait across the return deadline and UTC day', async () => {
    const a = await ready(), d = await ready(), trip = await d.dispatch();
    let cutoff = new Date(+day - 1), release!: () => void, entered!: () => void;
    let holderPid = 0;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      const [pid] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
      holderPid = pid!.pid;
      await tx.select({ id: bases.id }).from(bases).where(eq(bases.id, d.baseId)).for('update');
      entered(); await gate;
    });
    await acquired;
    const pending = createRaid(db, a.wallet, options(a, d), () => cutoff)
      .then(value => ({ value }), error => ({ error }));
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [row] = await db.execute(sql`select exists(select 1 from pg_stat_activity
          where datname = current_database() and ${holderPid} = any(pg_blocking_pids(pid))) as blocked`) as unknown as Array<{ blocked: boolean }>;
        if (row?.blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      cutoff = trip.returnsAt;
    } finally { release(); await holder; await pending; }
    const outcome = await pending;
    if ('error' in outcome) throw outcome.error;
    expect((await readStarterExpeditionReturn(db, trip.id))!.receipt.returnedAt).toEqual(trip.returnsAt);
    expect(outcome.value.ordersDeadlineAt.getTime()).toBe(trip.returnsAt.getTime() + raidOrdersWindowMs());
    expect(outcome.value.createdAt).toEqual(trip.returnsAt);
    expect((await getRaidEnergy(db, a.wallet, trip.returnsAt, a.baseId)).used).toBe(1);
    await expect(createRaid(db, a.wallet, options(a, d), trip.returnsAt)).rejects.toThrow('already attacked today');
  });

  it('locked current-authority refusal cannot materialize sources', async () => {
    const a = await ready(), d = await ready(), trip = await d.dispatch();
    await expect(createRaid(db, a.wallet, { ...options(a, d), authorizeDefenderBase: async (_wallet, _baseId, tx) => {
      if (tx) throw new Error('authority expired while waiting');
    } }, trip.returnsAt)).rejects.toThrow('authority expired');
    expect(await readStarterExpeditionReturn(db, trip.id)).toBeNull();
    expect(await raw(d)).toEqual([]);
  });

  it('a source overflow prevents raid creation without spending its ante', async () => {
    const a = await ready(), d = await ready(), trip = await d.dispatch();
    await db.insert(resourceStocks).values({ baseId: d.baseId, resourceId: trip.resourceId, available: RAW_RESOURCE_STORAGE_MAX });
    const before = (await getOrCreateBaseAccount(db, a.baseId, 'base_shards')).balance;
    await expect(createRaid(db, a.wallet, options(a, d), trip.returnsAt)).rejects.toThrow('overflow');
    expect((await getOrCreateBaseAccount(db, a.baseId, 'base_shards')).balance).toBe(before);
    expect(await readStarterExpeditionReturn(db, trip.id)).toBeNull();
    expect(await db.select().from(raids).where(eq(raids.attackerBaseId, a.baseId))).toEqual([]);
  });
});
