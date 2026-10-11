import { trainSpeedup, trainTroop } from './training-consent';
/**
 * Deed-native army progression.
 *
 * WHY: one wallet may own several deeds, and neither a rich Barracks nor a
 * paid queue/research row on one deed may manufacture capacity or troops for a
 * sibling deed. The stable base UUID is also the transfer boundary and the
 * live-raid lock must fence every explicit army mutation before any debit.
 */
import { randomUUID } from 'node:crypto';
import { BuildingType, TRAINING_CANCELLATION, TROOPS } from '@shardkeep/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  baseArmy, baseRaidLocks, bases, baseSlots, baseTrainingQueue,
  baseTroopResearch, buildings, players, raids,
} from '../src/db/schema';
import {
  baseArmyCoversOrders, consumeBaseArmy, getArmyState, researchSpeedup, researchTroop,
  cancelTraining,
} from '../src/game/army';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { transferStableBase } from '../src/game/baseOwnership';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const previousMultiBase = process.env['MULTI_BASE_ENABLED'];
let sequence = 0;
const key = () => `base-army-${++sequence}-${randomUUID()}`;
const context = (baseId: string): StableBaseMutationContext => ({
  baseId,
  assertAuthority: async () => {},
});

async function addPlayableBase(wallet: string, slot: number) {
  const deedAssetId = `base-army-deed-${randomUUID()}`;
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet,
    deedAssetId,
    deedMintAssetId: deedAssetId,
    status: 'active',
    keepLevel: 8,
    landPaidAt: new Date('2026-08-12T00:00:00.000Z'),
  }).returning();
  await db.insert(baseSlots).values({ wallet, slot, baseId: base!.id });
  await db.insert(buildings).values([
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Keep, level: 8, tx: 14, ty: 14 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Barracks, level: 3, tx: 8, ty: 8 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
    { playerWallet: wallet, baseId: base!.id, type: BuildingType.Forge, level: 3, tx: 8, ty: 18 },
  ]);
  await rewardBaseShards(db, base!.id, 100_000n, 'test.base-army', key());
  return base!;
}

beforeAll(async () => {
  process.env['MULTI_BASE_ENABLED'] = 'true';
  await bootstrapSystemAccounts(db);
});

afterAll(async () => {
  if (previousMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = previousMultiBase;
  await conn.sql.end();
});

describe.sequential('deed-native army, queue and troop research', () => {
  it('keeps the base refund budget through deed transfer', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addPlayableBase(seller.wallet, 1);
    const at = new Date('2026-09-01T10:00:00.000Z');
    const first = await trainTroop(db, seller.wallet, 'bowman', key(), at, context(base.id));
    const second = await trainTroop(db, seller.wallet, 'bowman', key(), at, context(base.id));
    const afterDebits = await getBaseShardBalance(db, base.id);
    await db.update(bases).set({
      trainingCancelDay: '2026-09-01',
      trainingCancelCount: TRAINING_CANCELLATION.maxRefundsPerBaseUtcDay - 1,
    }).where(eq(bases.id, base.id));
    await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);

    await cancelTraining(db, buyer.wallet, first.id, key(), at, context(base.id));
    const afterOne = await getBaseShardBalance(db, base.id);
    await expect(cancelTraining(db, buyer.wallet, second.id, key(), at, context(base.id)))
      .rejects.toMatchObject({ statusCode: 429, code: 'TRAINING_CANCEL_RATE_LIMITED' });
    expect(afterOne).toBe(afterDebits + BigInt(TROOPS.bowman.costKeep));
    expect(await getBaseShardBalance(db, base.id)).toBe(afterOne);
    expect((await db.select().from(bases).where(eq(bases.id, base.id)))[0])
      .toMatchObject({
        trainingCancelDay: '2026-09-01',
        trainingCancelCount: TRAINING_CANCELLATION.maxRefundsPerBaseUtcDay,
      });
    expect((await db.select().from(baseTrainingQueue)
      .where(eq(baseTrainingQueue.id, second.id)))[0]!.completedAt).toBeNull();
  });

  it('shares the wallet refund budget across sibling deeds', async () => {
    const owner = await createTestPlayer(db);
    const firstBase = await addPlayableBase(owner.wallet, 1);
    const secondBase = await addPlayableBase(owner.wallet, 2);
    const at = new Date('2026-09-01T10:00:00.000Z');
    const first = await trainTroop(db, owner.wallet, 'bowman', key(), at, context(firstBase.id));
    const second = await trainTroop(db, owner.wallet, 'bowman', key(), at, context(secondBase.id));
    await db.update(players).set({
      trainingCancelDay: '2026-09-01',
      trainingCancelCount: TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay - 1,
    }).where(eq(players.wallet, owner.wallet));

    await cancelTraining(db, owner.wallet, first.id, key(), at, context(firstBase.id));
    const secondBalance = await getBaseShardBalance(db, secondBase.id);
    await expect(cancelTraining(db, owner.wallet, second.id, key(), at, context(secondBase.id)))
      .rejects.toMatchObject({ statusCode: 429, code: 'TRAINING_CANCEL_RATE_LIMITED' });
    expect(await getBaseShardBalance(db, secondBase.id)).toBe(secondBalance);
    expect((await db.select().from(players).where(eq(players.wallet, owner.wallet)))[0]!.trainingCancelCount)
      .toBe(TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay);
    expect((await db.select().from(bases).where(eq(bases.id, secondBase.id)))[0])
      .toMatchObject({ trainingCancelDay: null, trainingCancelCount: 0 });
  });

  it('refunds the deed after transfer, never either wallet', async () => {
    const seller = await createTestPlayer(db);
    const buyer = await createTestPlayer(db);
    const base = await addPlayableBase(seller.wallet, 1);
    const before = await getBaseShardBalance(db, base.id);
    const at = new Date('2026-09-01T10:00:00.000Z');
    const queued = await trainTroop(db, seller.wallet, 'highlander', key(), at, context(base.id));
    expect(await getBaseShardBalance(db, base.id)).toBe(before - BigInt(TROOPS.highlander.costKeep));
    await transferStableBase(db, base.id, seller.wallet, buyer.wallet, base.deedAssetId!);

    await expect(cancelTraining(db, seller.wallet, queued.id, key(), at, context(base.id)))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const result = await cancelTraining(db, buyer.wallet, queued.id, key(), at, context(base.id));
    expect(result).toMatchObject({
      troop: 'highlander', refundShards: String(TROOPS.highlander.costKeep), replayed: false,
    });
    expect(await getBaseShardBalance(db, base.id)).toBe(before);
  });

  it('isolates two deeds of one wallet and carries the complete state through a sale', async () => {
    const owner = await createTestPlayer(db);
    const first = await addPlayableBase(owner.wallet, 1);
    const second = await addPlayableBase(owner.wallet, 2);
    const startedAt = new Date('2026-08-12T10:00:00.000Z');
    const sharedTrainKey = key();
    const sharedResearchKey = key();
    const firstBefore = await getBaseShardBalance(db, first.id);
    const secondBefore = await getBaseShardBalance(db, second.id);

    await trainTroop(db, owner.wallet, 'highlander', sharedTrainKey, startedAt, context(first.id));
    await researchTroop(db, owner.wallet, 'highlander', sharedResearchKey, startedAt, context(first.id));
    expect(await getBaseShardBalance(db, first.id)).toBeLessThan(firstBefore);
    expect(await getBaseShardBalance(db, second.id)).toBe(secondBefore);
    await trainTroop(db, owner.wallet, 'giant', sharedTrainKey, startedAt, context(second.id));
    await researchTroop(db, owner.wallet, 'giant', sharedResearchKey, startedAt, context(second.id));

    const [firstState, secondState] = await Promise.all([
      getArmyState(db, owner.wallet, startedAt, first.id),
      getArmyState(db, owner.wallet, startedAt, second.id),
    ]);
    expect(firstState.queue.map((row) => row.troop)).toEqual(['highlander']);
    expect(secondState.queue.map((row) => row.troop)).toEqual(['giant']);
    expect(firstState.research.map((row) => row.troop)).toEqual(['highlander']);
    expect(secondState.research.map((row) => row.troop)).toEqual(['giant']);
    expect(firstState.counts.giant).toBe(0);
    expect(secondState.counts.highlander).toBe(0);

    const completedAt = new Date('2026-08-14T10:00:00.000Z');
    const completedFirst = await getArmyState(db, owner.wallet, completedAt, first.id);
    expect(completedFirst.counts.highlander).toBe(1);
    expect(completedFirst.counts.giant).toBe(0);
    expect(completedFirst.levels.highlander).toBe(2);
    expect(await db.select().from(baseArmy).where(eq(baseArmy.baseId, second.id)))
      .toHaveLength(0);
    expect(await db.select().from(baseTrainingQueue).where(and(
      eq(baseTrainingQueue.baseId, second.id), isNull(baseTrainingQueue.completedAt),
    ))).toHaveLength(1);

    const buyer = await createTestPlayer(db);
    const deed = first.deedAssetId!;
    await transferStableBase(db, first.id, owner.wallet, buyer.wallet, deed);
    await expect(getArmyState(db, owner.wallet, completedAt, first.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    const conveyed = await getArmyState(db, buyer.wallet, completedAt, first.id);
    expect(conveyed.counts.highlander).toBe(1);
    expect(conveyed.levels.highlander).toBe(2);
    expect(conveyed.queue).toHaveLength(0);
    expect(await baseArmyCoversOrders(db, first.id, { highlander: 1 })).toBe(true);
    expect(await baseArmyCoversOrders(db, second.id, { highlander: 1 })).toBe(false);
    await consumeBaseArmy(db, first.id, { highlander: 1 });
    expect(await baseArmyCoversOrders(db, first.id, { highlander: 1 })).toBe(false);
    expect((await getArmyState(db, buyer.wallet, completedAt, first.id)).counts.highlander).toBe(0);
    expect((await getArmyState(db, owner.wallet, completedAt, second.id)).counts.giant).toBe(1);
  });

  it('rejects train, research and both paid FINISH paths under the deed raid lock', async () => {
    const defender = await createTestPlayer(db);
    const lockedBase = await addPlayableBase(defender.wallet, 1);
    const attacker = await createTestPlayer(db);
    const attackerBase = await addPlayableBase(attacker.wallet, 1);
    await fundTestKeep(db, defender.wallet, 100_000n, 'test.base-army.keep', key());
    const now = new Date('2026-08-12T12:00:00.000Z');

    await trainTroop(db, defender.wallet, 'highlander', key(), now, context(lockedBase.id));
    await researchTroop(db, defender.wallet, 'highlander', key(), now, context(lockedBase.id));
    const [raid] = await db.insert(raids).values({
      attackerWallet: attacker.wallet,
      attackerBaseId: attackerBase.id,
      defenderWallet: defender.wallet,
      defenderBaseId: lockedBase.id,
      seed: 17n,
      snapshot: {},
      armySnapshot: {},
      simVersion: 9,
      ordersDeadlineAt: new Date(now.getTime() + 120_000),
    }).returning();
    await db.insert(baseRaidLocks).values({
      baseId: lockedBase.id,
      raidId: raid!.id,
      expiresAt: new Date(now.getTime() + 300_000),
    });

    const shardsBefore = await getBaseShardBalance(db, lockedBase.id);
    const keepBefore = (await getOrCreatePlayerAccount(db, defender.wallet, 'player_keep')).balance;
    const locked = { code: 'BASE_BEING_RAIDED', statusCode: 423 };
    await expect(trainTroop(
      db, defender.wallet, 'giant', key(), now, context(lockedBase.id),
    )).rejects.toMatchObject(locked);
    await expect(researchTroop(
      db, defender.wallet, 'giant', key(), now, context(lockedBase.id),
    )).rejects.toMatchObject(locked);
    await expect(trainSpeedup(
      db, defender.wallet, key(), now, context(lockedBase.id),
    )).rejects.toMatchObject(locked);
    await expect(researchSpeedup(
      db, defender.wallet, 'highlander', key(), now, context(lockedBase.id),
    )).rejects.toMatchObject(locked);
    await expect(cancelTraining(
      db, defender.wallet,
      (await db.select().from(baseTrainingQueue).where(and(
        eq(baseTrainingQueue.baseId, lockedBase.id), isNull(baseTrainingQueue.completedAt),
      )))[0]!.id,
      key(), now, context(lockedBase.id),
    )).rejects.toMatchObject(locked);
    expect(await getBaseShardBalance(db, lockedBase.id)).toBe(shardsBefore);
    expect((await getOrCreatePlayerAccount(db, defender.wallet, 'player_keep')).balance).toBe(keepBefore);
    expect(await db.select().from(baseTrainingQueue).where(and(
      eq(baseTrainingQueue.baseId, lockedBase.id), isNull(baseTrainingQueue.completedAt),
    ))).toHaveLength(1);
    expect(await db.select().from(baseTroopResearch).where(and(
      eq(baseTroopResearch.baseId, lockedBase.id),
      eq(baseTroopResearch.researchingToLevel, 2),
    ))).toHaveLength(1);
  });
});
