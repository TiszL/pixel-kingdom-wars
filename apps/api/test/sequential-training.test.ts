/** Queue order, timer consent and refunds are one base-owned purchase contract. */
import { randomUUID } from 'node:crypto';
import { BuildingType, TROOPS, type TrainingComposition } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { armyTrainingBatches, bases, baseSlots, baseTrainingQueue, buildings, trainingQueue } from '../src/db/schema';
import { cancelTraining, getArmyState, quoteTraining, trainBatch, trainSpeedup, trainTroop } from '../src/game/army';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { ensureStartingBase } from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import { transferStableBase } from '../src/game/baseOwnership';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb(), db = conn.db;
const priorMulti = process.env['MULTI_BASE_ENABLED'];
const at = new Date('2026-09-06T10:00:00.000Z');
const later = (ms: number) => new Date(at.getTime() + ms);
const composition: TrainingComposition = [{ troop: 'bowman', count: 3 }];
async function fixture() {
  const owner = await createTestPlayer(db); const asset = `sequential-${randomUUID()}`;
  const [base] = await db.insert(bases).values({ ownerWallet: owner.wallet, deedAssetId: asset, deedMintAssetId: asset,
    status: 'active', keepLevel: 8, landPaidAt: at }).returning();
  await db.insert(baseSlots).values({ wallet: owner.wallet, slot: 1, baseId: base!.id });
  await db.insert(buildings).values([
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Keep, level: 8, tx: 14, ty: 14 },
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Barracks, level: 3, tx: 8, ty: 8 },
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
  ]);
  await rewardBaseShards(db, base!.id, 100_000n, 'test.sequential', randomUUID());
  return { wallet: owner.wallet, base: base!, ctx: { baseId: base!.id, assertAuthority: async () => {} } };
}
async function buy(f: Awaited<ReturnType<typeof fixture>>, units = composition, now = at) {
  const q = await quoteTraining(db, f.wallet, units, now, f.ctx);
  return trainBatch(db, f.wallet, q.queueable, q.costShards, randomUUID(), now, f.ctx, q.consent);
}
beforeEach(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => { if (priorMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = priorMulti; await conn.sql.end(); });

describe.sequential('one lane and explicit timer/price consent', () => {
  it('queues mixed units in purchase order with exact fractional tenth-duration timing', async () => {
    const f = await fixture(); const units: TrainingComposition = [{ troop: 'kegrunner', count: 2 }, { troop: 'highlander', count: 1 }];
    const q = await quoteTraining(db, f.wallet, units, at, f.ctx);
    expect(TROOPS.kegrunner.trainSec).toBe(7.5); expect(TROOPS.highlander.trainSec).toBe(12);
    expect(q.schedule).toMatchObject({ waitMs: 0, durationMs: 27_000 });
    expect(q.completionSec).toBe(27);
    await buy(f, units);
    const state = await getArmyState(db, f.wallet, at, f.base.id);
    expect(state.queue.map((r) => [r.startedAt, r.finishesAt, r.scheduleVersion])).toEqual([
      [at, later(7500), 2], [later(7500), later(15000), 2], [later(15000), later(27000), 2],
    ]);
    expect((await getArmyState(db, f.wallet, later(7500), f.base.id)).counts.kegrunner).toBe(1);
    expect((await getArmyState(db, f.wallet, later(27000), f.base.id)).queue).toEqual([]);
  });
  it('retains old concurrent promises and appends new work after their longest finish', async () => {
    const f = await fixture();
    const old = await db.insert(baseTrainingQueue).values([
      { baseId: f.base.id, troop: 'bowman', startedAt: at, finishesAt: later(90_000) },
      { baseId: f.base.id, troop: 'highlander', startedAt: at, finishesAt: later(120_000) },
    ]).returning();
    const q = await quoteTraining(db, f.wallet, composition, at, f.ctx);
    expect(q.schedule).toMatchObject({ waitMs: 120_000, durationMs: 27_000 }); expect(q.completionSec).toBe(147);
    await buy(f);
    const state = await getArmyState(db, f.wallet, at, f.base.id);
    expect(state.queue.slice(0, 2).map((r) => [r.id, r.startedAt, r.finishesAt, r.scheduleVersion]))
      .toEqual(old.map((r) => [r.id, r.startedAt, r.finishesAt, 1]));
    expect(state.queue.slice(2).map((r) => r.finishesAt)).toEqual([later(129000), later(138000), later(147000)]);
  });
  it('rejects missing consent for both new single and batch purchases without spending', async () => {
    const f = await fixture(); const before = await getBaseShardBalance(db, f.base.id);
    await expect(trainTroop(db, f.wallet, 'bowman', randomUUID(), at, f.ctx)).rejects.toMatchObject({ code: 'TRAINING_CONSENT_REQUIRED' });
    await expect(trainBatch(db, f.wallet, composition, '30', randomUUID(), at, f.ctx)).rejects.toMatchObject({ code: 'TRAINING_CONSENT_REQUIRED' });
    const q = await quoteTraining(db, f.wallet, [{ troop: 'bowman', count: 1 }], at, f.ctx);
    await expect(trainTroop(db, f.wallet, 'bowman', randomUUID(), at, f.ctx, q.consent)).rejects.toMatchObject({ code: 'TRAINING_CONSENT_REQUIRED' });
    await expect(trainTroop(db, f.wallet, 'bowman', randomUUID(), at, f.ctx, q.consent, '1')).rejects.toMatchObject({ code: 'TRAINING_QUOTE_CHANGED' });
    expect(await getBaseShardBalance(db, f.base.id)).toBe(before);
    expect((await getArmyState(db, f.wallet, at, f.base.id)).queue).toEqual([]);
  });
  it('fences a second purchase that would silently lengthen a quoted wait', async () => {
    const f = await fixture(); const q = await quoteTraining(db, f.wallet, composition, at, f.ctx);
    const results = await Promise.allSettled([1, 2].map(() => trainBatch(db, f.wallet, composition, q.costShards, randomUUID(), at, f.ctx, q.consent)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'TRAINING_QUOTE_CHANGED' } });
    expect((await getArmyState(db, f.wallet, at, f.base.id)).queue).toHaveLength(3);
  });
  it('replays one immutable receipt despite later rescheduling or absent new consent', async () => {
    const f = await fixture(), key = randomUUID(); const q = await quoteTraining(db, f.wallet, composition, at, f.ctx);
    const pair = await Promise.all([1, 2].map(() => trainBatch(db, f.wallet, composition, q.costShards, key, at, f.ctx, q.consent)));
    expect(pair.map((r) => r.replayed).sort()).toEqual([false, true]);
    await cancelTraining(db, f.wallet, pair[0]!.queue[0]!.id, randomUUID(), later(3000), f.ctx);
    const replay = await trainBatch(db, f.wallet, composition, q.costShards, key, later(3000), f.ctx);
    expect(replay.queue).toEqual(pair[0]!.queue);
    const [stored] = await db.select().from(armyTrainingBatches).where(eq(armyTrainingBatches.idempotencyKey, key));
    expect(stored!.result).toMatchObject({ queue: pair[0]!.queue });
    expect((await getArmyState(db, f.wallet, later(3000), f.base.id)).queue.map((r) => r.finishesAt)).toEqual([later(12000), later(21000)]);
  });
  it.each([0, 1, 2])('cancels exact row %i and pulls only future rows forward', async (index) => {
    const f = await fixture(), result = await buy(f); const before = await getBaseShardBalance(db, f.base.id);
    const key = randomUUID();
    await cancelTraining(db, f.wallet, result.queue[index]!.id, key, later(3000), f.ctx);
    const replay = await cancelTraining(db, f.wallet, result.queue[index]!.id, key, later(3000), f.ctx);
    expect(replay.replayed).toBe(true); expect(await getBaseShardBalance(db, f.base.id)).toBe(before + 10n);
    const state = await getArmyState(db, f.wallet, later(3000), f.base.id);
    expect(state.queue.map((r) => [r.startedAt, r.finishesAt])).toEqual(index === 0
      ? [[later(3000), later(12000)], [later(12000), later(21000)]]
      : [[at, later(9000)], [later(9000), later(18000)]]);
  });
  it('allows naturally completed quoted rows, but not fabricated or changed duration consent', async () => {
    const f = await fixture(); await buy(f, [{ troop: 'bowman', count: 1 }]);
    const q = await quoteTraining(db, f.wallet, composition, at, f.ctx);
    await expect(trainBatch(db, f.wallet, composition, q.costShards, randomUUID(), at, f.ctx,
      { ...q.consent, unitDurations: [{ troop: 'bowman', durationMs: 1 }] })).rejects.toMatchObject({ code: 'TRAINING_QUOTE_CHANGED' });
    await expect(trainBatch(db, f.wallet, composition, q.costShards, randomUUID(), at, f.ctx,
      { ...q.consent, queue: [...q.consent.queue, { id: randomUUID(), startedAt: at.toISOString(), finishesAt: at.toISOString() }] })).rejects.toMatchObject({ code: 'TRAINING_QUOTE_CHANGED' });
    const result = await trainBatch(db, f.wallet, composition, q.costShards, randomUUID(), later(9000), f.ctx, q.consent);
    expect(result.queue[0]!.finishesAt).toBe(later(18000).toISOString());
  });
  it('requires finish price/scope consent and rejects a larger queue or lower cap before debit', async () => {
    const f = await fixture(); await fundTestKeep(db, f.wallet, 1000n, 'test.sequential.keep', randomUUID()); await buy(f);
    const q = (await getArmyState(db, f.wallet, at, f.base.id)).finishAllQuote;
    await expect(trainSpeedup(db, f.wallet, randomUUID(), at, f.ctx)).rejects.toMatchObject({ code: 'TRAINING_CONSENT_REQUIRED' });
    await expect(trainSpeedup(db, f.wallet, randomUUID(), at, f.ctx, { ...q, maxCostKeep: '0' })).rejects.toMatchObject({ code: 'TRAINING_FINISH_QUOTE_CHANGED' });
    await buy(f, [{ troop: 'highlander', count: 1 }]);
    await expect(trainSpeedup(db, f.wallet, randomUUID(), at, f.ctx, q)).rejects.toMatchObject({ code: 'TRAINING_FINISH_QUOTE_CHANGED' });
    const fresh = (await getArmyState(db, f.wallet, at, f.base.id)).finishAllQuote;
    const key = randomUUID(); const done = await trainSpeedup(db, f.wallet, key, at, f.ctx, fresh);
    expect(done.cost.toString()).toBe(fresh.maxCostKeep);
    expect(done.completed).toEqual([{ troop: 'bowman', count: 3 }, { troop: 'highlander', count: 1 }]);
    await expect(trainSpeedup(db, f.wallet, key, at, f.ctx, fresh)).rejects.toMatchObject({ statusCode: 404 });
    expect((await getArmyState(db, f.wallet, at, f.base.id)).queue).toEqual([]);
  });
  it('uses the same sequential duration and refund repack on the legacy wallet lane', async () => {
    process.env['MULTI_BASE_ENABLED'] = 'false';
    const p = await createTestPlayer(db); await ensureStartingBase(db, p.wallet);
    await rewardShards(db, p.wallet, 1000n, 'test.sequential.legacy', randomUUID());
    await db.insert(buildings).values([
      { playerWallet: p.wallet, type: BuildingType.Barracks, level: 3, tx: 8, ty: 8 },
      { playerWallet: p.wallet, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
    ]);
    const q = await quoteTraining(db, p.wallet, composition, at);
    const result = await trainBatch(db, p.wallet, composition, q.costShards, randomUUID(), at, undefined, q.consent);
    await cancelTraining(db, p.wallet, result.queue[0]!.id, randomUUID(), later(3000));
    const rows = await db.select().from(trainingQueue).where(eq(trainingQueue.playerWallet, p.wallet));
    expect(rows.filter((r) => !r.completedAt).sort((a, b) => a.finishesAt.getTime() - b.finishesAt.getTime())
      .map((r) => [r.startedAt, r.finishesAt, r.scheduleVersion]))
      .toEqual([[later(3000), later(12000), 2], [later(12000), later(21000), 2]]);
    expect((await getArmyState(db, p.wallet, later(21000))).counts.bowman).toBe(2);
  });
  it('pulls future work behind the remaining grandfathered promise after cancelling its old tail', async () => {
    const f = await fixture();
    const old = await buy(f, [{ troop: 'bowman', count: 1 }, { troop: 'highlander', count: 1 }]);
    await db.update(baseTrainingQueue).set({ scheduleVersion: 1, startedAt: at, finishesAt: later(90000) }).where(eq(baseTrainingQueue.id, old.queue[0]!.id));
    await db.update(baseTrainingQueue).set({ scheduleVersion: 1, startedAt: at, finishesAt: later(120000) }).where(eq(baseTrainingQueue.id, old.queue[1]!.id));
    await buy(f);
    await cancelTraining(db, f.wallet, old.queue[1]!.id, randomUUID(), later(3000), f.ctx);
    const state = await getArmyState(db, f.wallet, later(3000), f.base.id);
    expect(state.queue.map((r) => [r.startedAt, r.finishesAt])).toEqual([
      [at, later(90000)], [later(90000), later(99000)], [later(99000), later(108000)], [later(108000), later(117000)],
    ]);
  });
  it('does not mistake a previously accelerated row for natural completion in stale consent', async () => {
    const f = await fixture(); await fundTestKeep(db, f.wallet, 1000n, 'test.sequential.keep', randomUUID());
    await buy(f, [{ troop: 'bowman', count: 1 }]);
    const quote = await quoteTraining(db, f.wallet, composition, at, f.ctx);
    const finish = (await getArmyState(db, f.wallet, at, f.base.id)).finishAllQuote;
    await trainSpeedup(db, f.wallet, randomUUID(), at, f.ctx, finish);
    await expect(trainBatch(db, f.wallet, composition, quote.costShards, randomUUID(), later(9000), f.ctx, quote.consent))
      .rejects.toMatchObject({ code: 'TRAINING_QUOTE_CHANGED' });
    expect((await getArmyState(db, f.wallet, later(9000), f.base.id)).queue).toHaveLength(0);
  });
  it('rejects transferred ownership and rolls back every row when final authority expires', async () => {
    const f = await fixture(), buyer = await createTestPlayer(db); const q = await quoteTraining(db, f.wallet, composition, at, f.ctx);
    await expect(trainBatch(db, f.wallet, composition, q.costShards, randomUUID(), at,
      { ...f.ctx, assertAuthority: async () => { throw new Error('authority expired'); } }, q.consent)).rejects.toThrow('authority expired');
    expect((await getArmyState(db, f.wallet, at, f.base.id)).queue).toEqual([]);
    await transferStableBase(db, f.base.id, f.wallet, buyer.wallet, f.base.deedAssetId!);
    await expect(trainBatch(db, f.wallet, composition, q.costShards, randomUUID(), at, f.ctx, q.consent)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
  });
});
