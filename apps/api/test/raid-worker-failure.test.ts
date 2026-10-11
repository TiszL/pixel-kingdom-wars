import { PVE, RAID_RULES } from '@shardkeep/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaidSimulationWorkerInput } from '../src/game/raidSimulationWorker';

const workerControl = vi.hoisted(() => ({
  mode: 'system' as 'system' | 'representation' | 'success',
  runs: 0,
  beforeReturn: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../src/game/raidSimulationRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game/raidSimulationRunner')>();
  const sim = await import('@shardkeep/sim');
  return {
    ...actual,
    claimRaidSimulationPermit: () => ({
      run: async (input: RaidSimulationWorkerInput) => {
        workerControl.runs += 1;
        if (workerControl.mode === 'system') {
          throw new actual.RaidSimulationSystemError('injected worker failure');
        }
        if (workerControl.mode === 'representation') {
          throw new sim.SimRepresentationLimitError('injected replay representation limit');
        }
        const outcome = sim.simulateRaid(input.snapshot, input.orders, input.seed, input.options);
        await workerControl.beforeReturn?.();
        return outcome;
      },
      release: async () => {},
    }),
  };
});

import {
  army, buildings, ledgerTransactions, players, pveCamps, raids,
} from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import {
  createPveRaid, createRaid, getRaidEnergy, recoverDueStartedLiveRaids, submitOrders,
} from '../src/game/raids';
import { acceptLiveRaidCommand, retreatLiveRaid, startLiveRaid } from '../src/game/liveRaids';
import { makeCampSnapshot } from '../src/game/world';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { rewardShards } from '../src/game/spend';
import { postTransaction } from '../src/ledger/ledger';
import { connectTestDb, createTestPlayer, createTestValley, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let sequence = 0;
const key = () => `worker-fail-${++sequence}`;
const shards = async (wallet: string) =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;

async function fighter() {
  const player = await createTestPlayer(db);
  await ensureStartingBase(db, player.wallet);
  await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, player.wallet));
  await rewardShards(db, player.wallet, 100_000n, 'test.worker-failure', key());
  await fundTestKeep(db, player.wallet, 100_000n, 'test.worker-failure.keep', key());
  await db.insert(army).values({ playerWallet: player.wallet, troop: 'highlander', count: 1 });
  return player;
}

async function target() {
  const player = await createTestPlayer(db);
  await ensureStartingBase(db, player.wallet);
  await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, player.wallet));
  return player;
}

const orders = () => ({
  deploys: [{ troop: 'highlander' as const, tx: 6, ty: 14, tMs: 0 }],
  idempotencyKey: key(),
});

beforeAll(async () => bootstrapSystemAccounts(db));
beforeEach(() => {
  workerControl.mode = 'system';
  workerControl.runs = 0;
  workerControl.beforeReturn = undefined;
});
afterAll(async () => conn.sql.end());

describe('worker system-failure compensation', () => {
  it.each(['system', 'representation'] as const)('retries %s retreat replay failure without refunding', async (failure) => {
    workerControl.mode = failure;
    const attacker = await fighter();
    const defender = await target();
    const raid = await createRaid(db, attacker.wallet, {
      defenderWallet: defender.wallet, idempotencyKey: key(),
      raidProtocolVersion: 2, allowRaidProtocolV2: true,
    });
    const t0 = raid.createdAt;
    const afterCreateShards = await shards(attacker.wallet);
    const afterCreateEnergy = await getRaidEnergy(db, attacker.wallet, t0);
    await acceptLiveRaidCommand(db, attacker.wallet, raid.id, 'retreat-deploy', {
      kind: 'deploy', payload: { troop: 'highlander', tx: 6, ty: 14 },
    }, t0);
    await startLiveRaid(db, attacker.wallet, raid.id, 'retreat-start', 0, t0);
    const receipt = await retreatLiveRaid(
      db, attacker.wallet, raid.id, 'retreat', new Date(t0.getTime() + 1_000),
    );
    await expect(submitOrders(
      db, attacker.wallet, raid.id, receipt.orders!, new Date(t0.getTime() + 2_000),
      true, false, true,
    )).rejects.toMatchObject({ statusCode: 503, code: 'RAID_SIMULATION_FAILED' });
    expect(workerControl.runs).toBe(1);
    const [pending] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(pending).toMatchObject({ status: 'pending_orders', simulationLeaseToken: null, simulationLeaseUntil: null });
    expect(await shards(attacker.wallet)).toBe(afterCreateShards);
    expect(await getRaidEnergy(db, attacker.wallet, t0)).toEqual(afterCreateEnergy);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(0);

    workerControl.mode = 'success';
    expect(await recoverDueStartedLiveRaids(
      db, new Date(t0.getTime() + 120_000), undefined, raid.id,
    )).toEqual({ resolved: 1, raced: 0 });
    const [resolved] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(resolved).toMatchObject({ status: 'resolved', result: { retreated: true, stars: 0, lootShards: 0 } });
    expect((resolved!.events as unknown[]).length).toBeGreaterThan(0);
    expect(await shards(attacker.wallet)).toBe(afterCreateShards);
    expect(await getRaidEnergy(db, attacker.wallet, t0)).toEqual(afterCreateEnergy);
    expect(await db.select({ count: army.count }).from(army).where(and(
      eq(army.playerWallet, attacker.wallet), eq(army.troop, 'highlander'),
    ))).toEqual([{ count: 0 }]);
  });

  it('restores a free PvP slot and exact ante once', async () => {
    const attacker = await fighter();
    const defender = await target();
    const before = await shards(attacker.wallet);
    const raid = await createRaid(db, attacker.wallet, {
      defenderWallet: defender.wallet, idempotencyKey: key(),
    });
    const afterCreate = await shards(attacker.wallet);
    expect(await shards(attacker.wallet)).toBeLessThan(before);

    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toMatchObject({
      statusCode: 503, code: 'RAID_SIMULATION_FAILED',
    });
    expect((await getRaidEnergy(db, attacker.wallet)).used).toBe(0);
    expect(await shards(attacker.wallet)).toBe(before);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(1);

    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toThrow(/already resolved/);
    expect(await shards(attacker.wallet)).toBe(before);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(1);
  });

  it('cancels a stale frozen army before worker CPU and compensates once', async () => {
    const attacker = await fighter();
    const defender = await target();
    const before = await shards(attacker.wallet);
    const raid = await createRaid(db, attacker.wallet, {
      defenderWallet: defender.wallet, idempotencyKey: key(),
    });
    const afterCreate = await shards(attacker.wallet);
    await db.update(army).set({ count: 0 }).where(eq(army.playerWallet, attacker.wallet));
    workerControl.mode = 'success';

    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toMatchObject({
      statusCode: 409, code: 'RAID_ARMY_CHANGED',
    });
    expect(workerControl.runs).toBe(0);
    expect(afterCreate).toBeLessThan(before);
    expect(await shards(attacker.wallet)).toBe(afterCreate);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(0);
    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toThrow(/already resolved/);
    expect(workerControl.runs).toBe(0);
  });

  it('terminally compensates an army race after one worker run', async () => {
    const attacker = await fighter();
    const defender = await target();
    const before = await shards(attacker.wallet);
    const raid = await createRaid(db, attacker.wallet, {
      defenderWallet: defender.wallet, idempotencyKey: key(),
    });
    const afterCreate = await shards(attacker.wallet);
    workerControl.mode = 'success';
    workerControl.beforeReturn = () => db.update(army).set({ count: 0 })
      .where(eq(army.playerWallet, attacker.wallet)).then(() => undefined);

    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toMatchObject({
      statusCode: 409, code: 'RAID_ARMY_CHANGED',
    });
    expect(workerControl.runs).toBe(1);
    expect(afterCreate).toBeLessThan(before);
    expect(await shards(attacker.wallet)).toBe(afterCreate);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(0);
    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toThrow(/already resolved/);
    expect(workerControl.runs).toBe(1);
  });

  it('does not mark an attacker-caused buff balance race as refundable system failure', async () => {
    const attacker = await fighter();
    const defender = await target();
    const before = await shards(attacker.wallet);
    const raid = await createRaid(db, attacker.wallet, {
      defenderWallet: defender.wallet, idempotencyKey: key(),
    });
    const afterCreate = await shards(attacker.wallet);
    workerControl.mode = 'success';
    workerControl.beforeReturn = async () => {
      const account = await getOrCreatePlayerAccount(db, attacker.wallet, 'player_keep');
      const system = await bootstrapSystemAccounts(db);
      await postTransaction(db, {
        idempotencyKey: key(),
        type: 'test.worker-buff-race',
        entries: [
          { account: account.id, delta: -account.balance },
          { account: system.emission_pool, delta: account.balance },
        ],
      });
    };
    await expect(submitOrders(db, attacker.wallet, raid.id, {
      ...orders(), buffs: { warhorn: true },
    })).rejects.toThrow(/cannot absorb/i);
    const [pending] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(pending).toMatchObject({
      status: 'pending_orders', simulationLeaseToken: null, simulationSystemAttemptedAt: null,
    });

    const sweepAt = new Date();
    await db.update(raids).set({ ordersDeadlineAt: new Date(sweepAt.getTime() - 1_000) })
      .where(eq(raids.id, raid.id));
    await getRaidEnergy(db, attacker.wallet, sweepAt);
    expect(await shards(attacker.wallet)).toBe(afterCreate);
    expect(afterCreate).toBeLessThan(before);
    expect(await db.select().from(ledgerTransactions).where(eq(
      ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`,
    ))).toHaveLength(0);
  });

  it('rate-spaces repeat heavy submissions per wallet before a second worker run', async () => {
    const prior = process.env.DARK_ATTACKER_ROSTER_ENABLED;
    process.env.DARK_ATTACKER_ROSTER_ENABLED = 'true';
    try {
      const attacker = await fighter();
      await db.delete(army).where(eq(army.playerWallet, attacker.wallet));
      await db.insert(army).values({ playerWallet: attacker.wallet, troop: 'hexbarrow', count: 4 });
      await db.insert(buildings).values({
        playerWallet: attacker.wallet, type: 'camp', level: 20, tx: 18, ty: 18,
      });
      const defenderA = await target();
      const defenderB = await target();
      const first = await createRaid(db, attacker.wallet, {
        defenderWallet: defenderA.wallet, idempotencyKey: key(),
      });
      const second = await createRaid(db, attacker.wallet, {
        defenderWallet: defenderB.wallet, idempotencyKey: key(),
      });
      const submitNow = new Date();
      const shortDeadline = new Date(submitNow.getTime() + 5_000);
      await db.update(raids).set({ ordersDeadlineAt: shortDeadline }).where(eq(raids.id, second.id));
      const heavyOrders = () => ({
        deploys: Array.from({ length: 2 }, () => ({
          troop: 'hexbarrow' as const, tx: 6, ty: 14, tMs: 0,
        })),
        idempotencyKey: key(),
      });
      workerControl.mode = 'success';
      await expect(submitOrders(db, attacker.wallet, first.id, heavyOrders(), submitNow)).resolves.toBeDefined();
      expect(workerControl.runs).toBe(1);
      await expect(submitOrders(db, attacker.wallet, second.id, heavyOrders(), submitNow)).rejects.toMatchObject({
        statusCode: 429, code: 'RAID_SIMULATION_COOLDOWN',
      });
      expect(workerControl.runs).toBe(1);
      const [afterCooldown] = await db.select().from(raids).where(eq(raids.id, second.id));
      expect(afterCooldown!.simulationSystemAttemptedAt).toBeNull();
      expect(afterCooldown!.ordersDeadlineAt.getTime()).toBeGreaterThan(shortDeadline.getTime());
      const cappedAt = afterCooldown!.createdAt.getTime()
        + (RAID_RULES.deployWindowSec + RAID_RULES.battleDurationSec) * 2_000;
      expect(afterCooldown!.ordersDeadlineAt.getTime()).toBeLessThanOrEqual(cappedAt);
      await expect(submitOrders(db, attacker.wallet, second.id, heavyOrders(), submitNow)).rejects.toMatchObject({
        statusCode: 429, code: 'RAID_SIMULATION_COOLDOWN',
      });
      expect((await db.select().from(raids).where(eq(raids.id, second.id)))[0]!.ordersDeadlineAt)
        .toEqual(afterCooldown!.ordersDeadlineAt);

      await db.update(players).set({ raidSimulationAdmittedAt: null })
        .where(eq(players.wallet, attacker.wallet));
      await expect(submitOrders(db, attacker.wallet, second.id, heavyOrders(), submitNow)).resolves.toBeDefined();
      expect(workerControl.runs).toBe(2);
      expect((await db.select().from(raids).where(eq(raids.id, second.id)))[0])
        .toMatchObject({ status: 'resolved', simulationSystemAttemptedAt: null });
    } finally {
      if (prior === undefined) delete process.env.DARK_ATTACKER_ROSTER_ENABLED;
      else process.env.DARK_ATTACKER_ROSTER_ENABLED = prior;
    }
  }, 15_000);

  it('restores purchased energy and PvP ante exactly once', async () => {
    const attacker = await fighter();
    const defender = await target();
    const before = await shards(attacker.wallet);
    const raid = await createRaid(db, attacker.wallet, {
      defenderWallet: defender.wallet, idempotencyKey: key(),
    });
    // Model the committed state after the purchased bucket supplied this raid.
    await db.update(raids).set({ energySource: 'purchased' }).where(eq(raids.id, raid.id));
    await db.update(players).set({ purchasedEnergy: 0 }).where(eq(players.wallet, attacker.wallet));

    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toMatchObject({
      statusCode: 503, code: 'RAID_SIMULATION_FAILED',
    });
    expect((await db.select({ n: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, attacker.wallet)))[0]!.n).toBe(1);
    expect(await shards(attacker.wallet)).toBe(before);
    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toThrow(/already resolved/);
    expect((await db.select({ n: players.purchasedEnergy }).from(players)
      .where(eq(players.wallet, attacker.wallet)))[0]!.n).toBe(1);
  });

  it('restores the free PvE attempt without minting energy or an ante refund', async () => {
    const attacker = await fighter();
    const valley = await createTestValley(db, { name: key(), createdAt: new Date('1999-01-01') });
    const [camp] = await db.insert(pveCamps).values({
      valleyId: valley.id, x: 0, y: 0, tier: 1,
      snapshot: makeCampSnapshot(1), lootKeep: BigInt(PVE.bountyByTier[0]!),
    }).returning();
    const before = await shards(attacker.wallet);
    const raid = await createPveRaid(db, attacker.wallet, camp!.id, key());

    await expect(submitOrders(db, attacker.wallet, raid.id, orders())).rejects.toMatchObject({
      statusCode: 503, code: 'RAID_SIMULATION_FAILED',
    });
    expect((await db.select().from(raids).where(eq(raids.id, raid.id)))[0]!.status).toBe('expired');
    expect(await shards(attacker.wallet)).toBe(before);
    expect(await db.select().from(ledgerTransactions).where(and(
      eq(ledgerTransactions.idempotencyKey, `raid-ante-refund:${raid.id}`),
    ))).toHaveLength(0);
  });
});
