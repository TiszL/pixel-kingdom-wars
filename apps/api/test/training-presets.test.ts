import { trainBatch, trainTroop } from './training-consent';
/** Additional army plans must never convert a partial preview, retry or cancelled
 * unit into an unconfirmed purchase or quest reward. Tests use real ledger rows. */
import { randomUUID } from 'node:crypto';
import { BuildingType, STRUCTURES, TRAINING_PRESETS, TROOPS, type TrainingComposition } from '@shardkeep/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { armyTrainingBatches, baseArmy, bases, baseSlots, baseTrainingQueue, buildings, ledgerEntries, raids } from '../src/db/schema';
import { cancelTraining, getArmyState, quoteTraining} from '../src/game/army';
import { deleteArmyPreset, listArmyPresets, previousAttackArmy, saveArmyPreset } from '../src/game/armyPresets';
import { getBaseShardBalance, rewardBaseShards } from '../src/game/baseEconomy';
import { transferStableBase } from '../src/game/baseOwnership';
import { connectTestDb, createTestPlayer } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const oldMulti = process.env['MULTI_BASE_ENABLED'];
const at = new Date('2026-09-05T08:00:00.000Z');
const key = () => randomUUID();
const context = (baseId: string) => ({ baseId, assertAuthority: async () => {} });
async function fixture(amount = 100_000n) {
  const owner = await createTestPlayer(db);
  const asset = `training-preset-${key()}`;
  const [base] = await db.insert(bases).values({ ownerWallet: owner.wallet, deedAssetId: asset, deedMintAssetId: asset, status: 'active', keepLevel: 8, landPaidAt: at }).returning();
  await db.insert(baseSlots).values({ wallet: owner.wallet, slot: 1, baseId: base!.id });
  await db.insert(buildings).values([
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Keep, level: 8, tx: 14, ty: 14 },
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Barracks, level: 3, tx: 8, ty: 8 },
    { playerWallet: owner.wallet, baseId: base!.id, type: BuildingType.Camp, level: 3, tx: 18, ty: 8 },
  ]);
  if (amount) await rewardBaseShards(db, base!.id, amount, 'test.training-presets', key());
  return { wallet: owner.wallet, base: base!, ctx: context(base!.id) };
}
beforeAll(() => { process.env['MULTI_BASE_ENABLED'] = 'true'; });
afterAll(async () => { if (oldMulti === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = oldMulti; await conn.sql.end(); });

describe.sequential('wallet training plans and locked batches', () => {
  it('stores exactly three wallet-private ordered presets without changing balances', async () => {
    const f = await fixture(); const other = await fixture(); const before = await getBaseShardBalance(db, f.base.id);
    const composition: TrainingComposition = [{ troop: 'bowman', count: 3 }, { troop: 'highlander', count: 2 }];
    for (let slot = 1; slot <= TRAINING_PRESETS.slots; slot += 1) await saveArmyPreset(db, f.wallet, { slot, name: ` Army ${slot} `, composition });
    expect((await listArmyPresets(db, f.wallet))[0]).toEqual({ slot: 1, name: 'Army 1', composition });
    expect(await listArmyPresets(db, other.wallet)).toEqual([]);
    await expect(saveArmyPreset(db, f.wallet, { slot: 4, name: 'extra', composition })).rejects.toMatchObject({ code: 'TRAINING_PRESET_INVALID' });
    await expect(saveArmyPreset(db, f.wallet, { slot: 1, name: 'duplicate', composition: [{ troop: 'bowman', count: 1 }, { troop: 'bowman', count: 1 }] })).rejects.toMatchObject({ code: 'TRAINING_COMPOSITION_INVALID' });
    await deleteArmyPreset(db, other.wallet, 1);
    expect(await listArmyPresets(db, f.wallet)).toHaveLength(TRAINING_PRESETS.slots);
    await deleteArmyPreset(db, f.wallet, 1);
    expect(await listArmyPresets(db, f.wallet)).toHaveLength(TRAINING_PRESETS.slots - 1);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(before);
  });

  it('fills whole troops in saved order, explains locked troops and never spends for a preview', async () => {
    const f = await fixture(BigInt(TROOPS.bowman.costKeep * 3));
    const quote = await quoteTraining(db, f.wallet, [{ troop: 'mage', count: 1 }, { troop: 'bowman', count: 5 }, { troop: 'highlander', count: 1 }], at, f.ctx);
    expect(quote.queueable).toEqual([{ troop: 'bowman', count: 3 }]);
    expect(quote.remaining).toEqual([
      expect.objectContaining({ troop: 'mage', count: 1, reason: expect.stringContaining('locked') }),
      { troop: 'bowman', count: 2, reason: 'Not enough SHARDS' },
      { troop: 'highlander', count: 1, reason: 'Not enough SHARDS' },
    ]);
    expect(quote.costShards).toBe(String(TROOPS.bowman.costKeep * 3));
    // One base lane trains the three accepted units in sequence.
    expect(quote.completionSec).toBe(TROOPS.bowman.trainSec * 3);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(BigInt(quote.costShards));
    expect(await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, f.base.id))).toHaveLength(0);
  });

  it('respects Barracks room and counts held plus queued troops against Camp capacity', async () => {
    const f = await fixture();
    const quote = await quoteTraining(db, f.wallet, [{ troop: 'highlander', count: 100 }], at, f.ctx);
    expect(quote.queueable[0]!.count).toBe(STRUCTURES.barracks.queuePts[2]! / TROOPS.highlander.pts);
    expect(quote.remaining[0]!.reason).toBe('Barracks queue is full');
    await db.insert(baseArmy).values({ baseId: f.base.id, troop: 'highlander', count: Math.floor(STRUCTURES.camp.capacityPts[2]! / TROOPS.highlander.pts) - 1 });
    const campQuote = await quoteTraining(db, f.wallet, [{ troop: 'highlander', count: 3 }], at, f.ctx);
    expect(campQuote.queueable).toEqual([{ troop: 'highlander', count: 1 }]);
    expect(campQuote.remaining).toEqual([{ troop: 'highlander', count: 2, reason: 'Army Camps are full' }]);
  });

  it('requires renewed confirmation on cost or eligibility changes and purchases only the displayed partial subset', async () => {
    const f = await fixture(BigInt(TROOPS.bowman.costKeep * 2));
    const quote = await quoteTraining(db, f.wallet, [{ troop: 'bowman', count: 4 }], at, f.ctx);
    await expect(trainBatch(db, f.wallet, quote.requested, quote.costShards, key(), at, f.ctx)).rejects.toMatchObject({ code: 'TRAINING_QUOTE_CHANGED', details: { quote: expect.objectContaining({ queueable: quote.queueable }) } });
    await expect(trainBatch(db, f.wallet, quote.queueable, String(Number(quote.costShards) - 1), key(), at, f.ctx)).rejects.toMatchObject({ code: 'TRAINING_QUOTE_CHANGED' });
    const result = await trainBatch(db, f.wallet, quote.queueable, quote.costShards, key(), at, f.ctx);
    expect(result.queue).toHaveLength(2);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(0n);
  });

  it('replays concurrent or lost-response purchases without another debit, queue or changed receipt', async () => {
    const f = await fixture(); const composition: TrainingComposition = [{ troop: 'bowman', count: 2 }]; const idem = key();
    const cost = String(TROOPS.bowman.costKeep * 2); const before = await getBaseShardBalance(db, f.base.id);
    const results = await Promise.all([trainBatch(db, f.wallet, composition, cost, idem, at, f.ctx), trainBatch(db, f.wallet, composition, cost, idem, at, f.ctx)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results[0]!.queue).toEqual(results[1]!.queue);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(before - BigInt(cost));
    await expect(trainBatch(db, f.wallet, [{ troop: 'bowman', count: 1 }], String(TROOPS.bowman.costKeep), idem, at, f.ctx)).rejects.toMatchObject({ code: 'TRAINING_BATCH_KEY_REUSED' });
    const receipt = await trainBatch(db, f.wallet, composition, cost, idem, new Date(at.getTime() + 86_400_000), f.ctx);
    expect(receipt.queue).toEqual(results[0]!.queue);
    expect((await getArmyState(db, f.wallet, new Date(at.getTime() + 86_400_000), f.base.id)).counts.bowman).toBe(2);
  });

  it('serializes independent batches competing for the final Camp slot', async () => {
    const f = await fixture();
    await db.insert(baseArmy).values({ baseId: f.base.id, troop: 'highlander', count: Math.floor(STRUCTURES.camp.capacityPts[2]! / TROOPS.highlander.pts) - 1 });
    const results = await Promise.allSettled([1, 2].map(() => trainBatch(db, f.wallet, [{ troop: 'highlander', count: 1 }], String(TROOPS.highlander.costKeep), key(), at, f.ctx)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, f.base.id))).toHaveLength(1);
  });

  it('keeps exactly one original debit per unit so individual cancellation refunds only that troop', async () => {
    const f = await fixture(); const before = await getBaseShardBalance(db, f.base.id);
    const result = await trainBatch(db, f.wallet, [{ troop: 'bowman', count: 2 }], String(TROOPS.bowman.costKeep * 2), key(), at, f.ctx);
    const rows = await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, f.base.id));
    expect(new Set(rows.map((r) => r.debitLedgerTxnId)).size).toBe(2);
    for (const row of rows) expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, row.debitLedgerTxnId!))).toHaveLength(2);
    await cancelTraining(db, f.wallet, result.queue[0]!.id, key(), at, f.ctx);
    expect(await getBaseShardBalance(db, f.base.id)).toBe(before - BigInt(TROOPS.bowman.costKeep));
    const final = await getArmyState(db, f.wallet, new Date(at.getTime() + 86_400_000), f.base.id);
    expect(final.counts.bowman).toBe(1);
    const receiptRows = await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, f.base.id));
    expect(receiptRows.filter((r) => r.questCreditedAt !== null)).toHaveLength(1);
  });

  it('rolls back every unit and debit when final deed authority fails', async () => {
    const f = await fixture(); const before = await getBaseShardBalance(db, f.base.id); const idem = key(); let proofs = 0;
    await expect(trainBatch(db, f.wallet, [{ troop: 'bowman', count: 2 }], String(TROOPS.bowman.costKeep * 2), idem, at, {
      baseId: f.base.id, assertAuthority: async () => { if (++proofs > 1) throw new Error('deed proof expired'); },
    })).rejects.toThrow('deed proof expired');
    expect(await getBaseShardBalance(db, f.base.id)).toBe(before);
    expect(await db.select().from(baseTrainingQueue).where(eq(baseTrainingQueue.baseId, f.base.id))).toHaveLength(0);
    expect(await db.select().from(armyTrainingBatches).where(eq(armyTrainingBatches.playerWallet, f.wallet))).toHaveLength(0);
  });

  it('refuses the old owner after a transfer and keeps wallet presets with their author', async () => {
    const f = await fixture(); const buyer = await createTestPlayer(db); const composition: TrainingComposition = [{ troop: 'bowman', count: 1 }];
    await saveArmyPreset(db, f.wallet, { slot: 1, name: 'mine', composition });
    await transferStableBase(db, f.base.id, f.wallet, buyer.wallet, f.base.deedAssetId!);
    await expect(quoteTraining(db, f.wallet, composition, at, f.ctx)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    await expect(trainBatch(db, f.wallet, composition, String(TROOPS.bowman.costKeep), key(), at, f.ctx)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    expect(await listArmyPresets(db, buyer.wallet)).toEqual([]);
    expect(await listArmyPresets(db, f.wallet)).toHaveLength(1);
  });

  it('uses only actual deployments from the newest resolved attack, including retreat, never reserves or empty visits', async () => {
    const f = await fixture(); const other = await fixture();
    const insert = async (offset: number, orders: unknown, extra = {}) => {
      const [row] = await db.insert(raids).values({ attackerWallet: f.wallet, attackerBaseId: f.base.id, seed: 1n, snapshot: {}, armySnapshot: { counts: { bowman: 99 } }, orders, ordersDeadlineAt: at, status: 'resolved', result: { stars: 0, retreated: true }, createdAt: new Date(at.getTime() + offset), resolvedAt: new Date(at.getTime() + offset), ...extra }).returning();
      return row!;
    };
    const actual = await insert(1, { deploys: [{ troop: 'bowman' }, { troop: 'highlander' }, { troop: 'bowman' }], heroDeploys: [{ hero: 'vex' }] });
    await insert(2, { deploys: [] });
    await insert(3, { deploys: [{ troop: 'giant' }] }, { attackerBaseId: other.base.id });
    expect(await previousAttackArmy(db, f.wallet, f.base.id)).toEqual({ raidId: actual.id, composition: [{ troop: 'bowman', count: 2 }, { troop: 'highlander', count: 1 }], message: null });
    const heroOnly = await insert(4, { deploys: [], heroDeploys: [{ hero: 'vex' }] });
    expect(await previousAttackArmy(db, f.wallet, f.base.id)).toMatchObject({ raidId: heroOnly.id, composition: [], message: expect.stringContaining('heroes only') });
    await expect(previousAttackArmy(db, other.wallet, f.base.id)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
  });

  it('keeps the existing single-unit path compatible with batch cancellation receipts', async () => {
    const f = await fixture();
    const single = await trainTroop(db, f.wallet, 'bowman', key(), at, f.ctx);
    await cancelTraining(db, f.wallet, single.id, key(), at, f.ctx);
    expect(await db.select().from(baseTrainingQueue).where(and(eq(baseTrainingQueue.baseId, f.base.id), isNull(baseTrainingQueue.completedAt)))).toHaveLength(0);
    expect(await db.execute(sql`SELECT 1`)).toHaveLength(1);
  });
});
