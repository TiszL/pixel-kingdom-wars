/** First deployment and cancellation must share a fresh locked lifecycle view.
 * The UPDATE's original snapshot is not refreshed merely by waiting for its
 * target raid row: the clock being checked lives in a different table. */
import { randomUUID } from 'node:crypto';
import { SIM_VERSION } from '@shardkeep/sim';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { baseRaidLocks, bases, players, raidCommands, raidLiveStates, raids, shields } from '../src/db/schema';
import {
  acceptLiveRaidCommandReceipt, closeLiveRaidStream, getLiveRaidCommands,
  initializeLiveRaid, setLiveRaidSpeed,
} from '../src/game/liveRaids';
import { compensatePendingRaid, getRaidEnergy } from '../src/game/raids';
import { connectTestDb, createTestPlayer, insertActiveTestBase } from './helpers';

const conn = connectTestDb();
const db = conn.db;
afterAll(async () => { await conn.sql.end(); });

async function waitingPid(blockerPid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await conn.sql<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity
      WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
      ORDER BY pid LIMIT 1
    `;
    if (row) return row.pid;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no transaction waited on backend ${blockerPid}`);
}

describe.sequential('live raid cancellation snapshot boundary', () => {
  it.each(['compensation', 'stale expiry'] as const)(
    '%s re-reads the lifecycle after waiting for first deployment to commit',
    async (path) => {
      // Raids are stamped no later than the database clock: since D153.235 /
      // D153.238 (0284/0286) the capture triggers refuse a future created_at.
      const t0 = new Date();
      const attacker = await createTestPlayer(db);
      const defender = await createTestPlayer(db);
      const attackerBase = await insertActiveTestBase(db, { ownerWallet: attacker.wallet, status: 'active', keepLevel: 5 });
      const defenderBase = await insertActiveTestBase(db, { ownerWallet: defender.wallet, status: 'active', keepLevel: 5 });
      const [raid] = await db.insert(raids).values({
        idempotencyKey: `cancel-race-${randomUUID()}`,
        attackerWallet: attacker.wallet, attackerBaseId: attackerBase!.id,
        defenderWallet: defender.wallet, defenderBaseId: defenderBase!.id,
        seed: 7n, simVersion: SIM_VERSION, createdAt: t0,
        ordersDeadlineAt: new Date(t0.getTime() + 120_000),
        snapshot: { keepLevel: 5, buildings: [], surplusShards: 0, claimMin: 8, claimMax: 22 },
        armySnapshot: { counts: { highlander: 1 }, levels: { highlander: 1 }, heroes: [], attackerKeepLevel: 5 },
      }).returning();
      await initializeLiveRaid(db, raid!.id, defenderBase!.id, raid!.ordersDeadlineAt, t0, 2);
      const [shield] = await db.insert(shields).values({
        playerWallet: attacker.wallet, baseId: attackerBase!.id, source: 'loss',
        expiresAt: new Date(t0.getTime() + 3_600_000),
      }).returning();

      // Hold only the shield row: the real first-deploy path has already locked
      // raids/base/live and sampled its valid timestamp before blocking here.
      let releaseShield!: () => void;
      let shieldLocked!: () => void;
      let shieldPid = 0;
      const release = new Promise<void>((resolve) => { releaseShield = resolve; });
      const locked = new Promise<void>((resolve) => { shieldLocked = resolve; });
      const shieldBlocker = db.transaction(async (tx) => {
        const pid = await tx.execute(sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`);
        shieldPid = Number(pid[0]!.pid);
        await tx.select({ id: shields.id }).from(shields)
          .where(eq(shields.id, shield!.id)).for('update');
        shieldLocked();
        await release;
      });
      await locked;

      const deployment = acceptLiveRaidCommandReceipt(
        db, attacker.wallet, raid!.id, 'first-unit',
        { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } },
        new Date(t0.getTime() + 29_999),
      );
      let cancellation: Promise<unknown> | undefined;
      try {
        const deploymentPid = await waitingPid(shieldPid);
        cancellation = path === 'compensation'
          ? compensatePendingRaid(db, raid!, false)
          : getRaidEnergy(db, attacker.wallet, new Date(t0.getTime() + 120_001));
        // Prove cancellation started its statement before the first deploy's
        // clock write could commit. No sleeps are used to guess this ordering.
        await waitingPid(deploymentPid);
      } finally {
        releaseShield();
        await shieldBlocker;
      }
      const accepted = await deployment;
      const cancelled = await cancellation;
      expect(accepted.clock.revision).toBe(1);
      if (path === 'compensation') expect(cancelled).toBe(false);
      const [state] = await db.select().from(raidLiveStates)
        .where(eq(raidLiveStates.raidId, raid!.id));
      expect(state?.startedAt).toEqual(new Date(t0.getTime() + 29_999));
      expect((await db.select().from(raids).where(eq(raids.id, raid!.id)))[0]?.status)
        .toBe('pending_orders');
      expect(await db.select().from(raidCommands).where(eq(raidCommands.raidId, raid!.id)))
        .toHaveLength(1);
      expect(await db.select().from(baseRaidLocks).where(eq(baseRaidLocks.raidId, raid!.id)))
        .toHaveLength(1);
    },
  );

  it.each(['deploy', 'speed', 'finish', 'defender read'] as const)(
    '%s cannot invert the player/base locks held by a concurrent create-style expiry',
    async (action) => {
      // Not in the future: see the D153.235 / D153.238 note above.
      const t0 = new Date();
      const attacker = await createTestPlayer(db);
      const defender = await createTestPlayer(db);
      const attackerBase = await insertActiveTestBase(db, { ownerWallet: attacker.wallet, status: 'active', keepLevel: 5 });
      const defenderBase = await insertActiveTestBase(db, { ownerWallet: defender.wallet, status: 'active', keepLevel: 5 });
      const baseRows = [attackerBase, defenderBase];
      const [raid] = await db.insert(raids).values({
        idempotencyKey: `lock-order-${randomUUID()}`,
        attackerWallet: attacker.wallet, attackerBaseId: attackerBase.id,
        defenderWallet: defender.wallet, defenderBaseId: defenderBase.id,
        seed: 7n, simVersion: SIM_VERSION, createdAt: t0,
        ordersDeadlineAt: new Date(t0.getTime() + 120_000),
        snapshot: { keepLevel: 5, buildings: [], surplusShards: 0, claimMin: 8, claimMax: 22 },
        armySnapshot: { counts: { highlander: 2 }, levels: { highlander: 1 }, heroes: [], attackerKeepLevel: 5 },
      }).returning();
      await initializeLiveRaid(db, raid!.id, defenderBase.id, raid!.ordersDeadlineAt, t0, 2);
      if (action !== 'deploy') {
        await acceptLiveRaidCommandReceipt(
          db, attacker.wallet, raid!.id, 'prior-unit',
          { kind: 'deploy', payload: { troop: 'highlander', tx: 1, ty: 1 } }, t0,
        );
      }
      const at = new Date(t0.getTime() + (action === 'finish' ? 90_000 : 1_000));
      let allowExpiry!: () => void;
      let authorityLocked!: () => void;
      let createPid = 0;
      const proceed = new Promise<void>((resolve) => { allowExpiry = resolve; });
      const locked = new Promise<void>((resolve) => { authorityLocked = resolve; });
      // All three real create paths hold the player/base authority roots before
      // invoking stale expiry. Exercise precisely that shared lock segment,
      // without unrelated camp/scouting admission changing which lock is hit.
      const creating = db.transaction(async (tx) => {
        const pid = await tx.execute(sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`);
        createPid = Number(pid[0]!.pid);
        await tx.select({ wallet: players.wallet }).from(players)
          .where(inArray(players.wallet, [attacker.wallet, defender.wallet]))
          .orderBy(players.wallet).for('update');
        await tx.select({ id: bases.id }).from(bases)
          .where(inArray(bases.id, baseRows.map((base) => base.id)))
          .orderBy(bases.id).for('update');
        authorityLocked();
        await proceed;
        return getRaidEnergy(tx as unknown as typeof db, attacker.wallet, at);
      });
      await locked;
      const competing = action === 'deploy'
        ? acceptLiveRaidCommandReceipt(
          db, attacker.wallet, raid!.id, 'competing-unit',
          { kind: 'deploy', payload: { troop: 'highlander', tx: 2, ty: 1 } }, at,
        )
        : action === 'speed'
          ? setLiveRaidSpeed(db, attacker.wallet, raid!.id, 'competing-speed', 1, 2, true, at)
          : action === 'finish'
            ? closeLiveRaidStream(db, attacker.wallet, raid!.id, at)
            : getLiveRaidCommands(db, defender.wallet, raid!.id, -1, at);
      const outcomes = Promise.allSettled([creating, competing]);
      try {
        await waitingPid(createPid);
      } finally {
        allowExpiry();
      }
      // Without the player-first mutex the competing path owns raid→waits-base,
      // while create owns base→waits-raid: PostgreSQL aborts one with 40P01.
      expect(await outcomes).toEqual([
        expect.objectContaining({ status: 'fulfilled' }),
        expect.objectContaining({ status: 'fulfilled' }),
      ]);
      expect((await db.select().from(raids).where(eq(raids.id, raid!.id)))[0]?.status)
        .toBe('pending_orders');
    },
  );
});
