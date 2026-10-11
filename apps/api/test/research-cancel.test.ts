/**
 * Cancelling the RUNNING troop research (tester request 2026-09-04) refunds
 * the exact SHARD debit the research recorded when it started and hands the
 * Forge lane back with the troop at its old level. The research row is reused
 * per troop, so these pin the episode rules: the refund is the row's own
 * receipt (never TROOP_LEVELING), a replayed cancel key returns the same
 * result without a second refund, a fresh start clears the old cancellation,
 * pre-receipt rows and finished research are refused, the durable UTC-day
 * ceilings hold, and SHARD-spend quests tick only when the level lands.
 */
import { and, eq } from 'drizzle-orm';
import { BuildingType, RESEARCH_CANCELLATION, TROOP_LEVELING } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildings, ledgerTransactions, players, questProgress, quests, troopResearch } from '../src/db/schema';
import { cancelResearch, getArmyState, researchSpeedup, researchTroop } from '../src/game/army';
import { ensureStartingBase } from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let seq = 0;
const k = (): string => `research-cancel-${++seq}-${Math.random().toString(36).slice(2)}`;
const L1_COST = BigInt(TROOP_LEVELING.researchCostKeep[0]!);
const L1_SEC = TROOP_LEVELING.researchTimeSec[0]!;
const NOW = new Date('2026-09-01T10:00:00.000Z');
const DAY = '2026-09-01';

async function forgePlayer() {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await fundTestKeep(db, p.wallet, 10_000_000n, 'test.fund', k());
  await rewardShards(db, p.wallet, 100_000n, 'test.fund.shards', k());
  await db.insert(buildings).values({ playerWallet: p.wallet, type: BuildingType.Forge, level: 3, tx: 11, ty: 8 });
  return p;
}

const shardBalance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;
const row = async (wallet: string, troop: 'giant' | 'bowman') =>
  (await db.select().from(troopResearch).where(and(
    eq(troopResearch.playerWallet, wallet), eq(troopResearch.troop, troop),
  )))[0]!;
const refunds = (debitId: string) => db.select().from(ledgerTransactions)
  .where(eq(ledgerTransactions.idempotencyKey, `army-research-cancel:${debitId}`));
const dailyQuestProgress = async (wallet: string, templateCode: string): Promise<number> => {
  const [r] = await db.select({ progress: questProgress.progress }).from(questProgress)
    .innerJoin(quests, eq(quests.id, questProgress.questId))
    .where(and(
      eq(questProgress.playerWallet, wallet), eq(quests.scope, 'daily'),
      eq(quests.activeOn, DAY), eq(quests.templateCode, templateCode),
    ));
  return r?.progress ?? 0;
};

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('cancelResearch — the money checklist', () => {
  it('refunds the exact recorded debit, frees the lane and keeps the old level', async () => {
    const { wallet } = await forgePlayer();
    const before = await shardBalance(wallet);
    await researchTroop(db, wallet, 'giant', k(), NOW);
    expect(await shardBalance(wallet)).toBe(before - L1_COST);
    const started = await row(wallet, 'giant');
    expect(started).toMatchObject({ researchingToLevel: 2, paidShardCost: L1_COST, cancelledAt: null });
    expect(started.debitLedgerTxnId).not.toBeNull();
    expect((await getArmyState(db, wallet, NOW)).research).toEqual([expect.objectContaining({
      troop: 'giant', toLevel: 2, canCancel: true, refundShards: String(L1_COST),
    })]);

    const result = await cancelResearch(db, wallet, 'giant', k(), NOW);
    expect(result).toMatchObject({
      troop: 'giant', toLevel: 2, refundShards: String(L1_COST), cancelledAt: NOW, replayed: false,
    });
    expect(await shardBalance(wallet)).toBe(before);
    const state = await getArmyState(db, wallet, NOW);
    expect(state.research).toEqual([]);
    expect(state.levels.giant).toBe(1);
    expect(await row(wallet, 'giant')).toMatchObject({
      level: 1, researchingToLevel: null, finishesAt: null, cancelledAt: NOW,
    });
    expect(await refunds(started.debitLedgerTxnId!)).toHaveLength(1);
    // The lane is free: a new research on the SAME troop starts a fresh
    // episode with its own receipt and no lingering cancellation.
    await researchTroop(db, wallet, 'giant', k(), NOW);
    const restarted = await row(wallet, 'giant');
    expect(restarted).toMatchObject({ researchingToLevel: 2, paidShardCost: L1_COST, cancelledAt: null, refundLedgerTxnId: null, cancelIdempotencyKey: null });
    expect(restarted.debitLedgerTxnId).not.toBe(started.debitLedgerTxnId);
    // A whole-level completion later lands L2 exactly once.
    expect((await getArmyState(db, wallet, new Date(NOW.getTime() + (L1_SEC + 1) * 1000))).levels.giant).toBe(2);
  });

  it('replays the same cancel key without a second refund; other keys see the truth', async () => {
    const { wallet } = await forgePlayer();
    const before = await shardBalance(wallet);
    await researchTroop(db, wallet, 'giant', k(), NOW);
    const debitId = (await row(wallet, 'giant')).debitLedgerTxnId!;
    const cancelKey = k();
    await cancelResearch(db, wallet, 'giant', cancelKey, NOW);
    const replay = await cancelResearch(db, wallet, 'giant', cancelKey, NOW);
    expect(replay).toMatchObject({ troop: 'giant', refundShards: String(L1_COST), replayed: true });
    expect(await shardBalance(wallet)).toBe(before);
    expect(await refunds(debitId)).toHaveLength(1);
    await expect(cancelResearch(db, wallet, 'giant', k(), NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'RESEARCH_NOT_ACTIVE' });
    await expect(cancelResearch(db, wallet, 'bowman', k(), NOW)).rejects
      .toMatchObject({ statusCode: 404, code: 'RESEARCH_NOT_FOUND' });
    // The used key cannot cancel another troop's research.
    await researchTroop(db, wallet, 'bowman', k(), NOW);
    await expect(cancelResearch(db, wallet, 'bowman', cancelKey, NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'RESEARCH_CANCEL_KEY_REUSED' });
    expect(await shardBalance(wallet)).toBe(before - L1_COST);
  });

  it('a stale cancel key replays its own refund and never cancels the restarted episode', async () => {
    // WHY (review 2026-09-04): restarting the same troop rewrites the row's
    // receipt and clears its cancel key, so a delayed client retry of the OLD
    // cancel used to reach the new episode and refund it a second time under
    // the same key — money-neutral, but one key must mean one refund, and the
    // player's new research must survive their flaky network.
    const { wallet } = await forgePlayer();
    await researchTroop(db, wallet, 'giant', k(), NOW);
    const firstDebit = (await row(wallet, 'giant')).debitLedgerTxnId!;
    const cancelKey = k();
    const first = await cancelResearch(db, wallet, 'giant', cancelKey, NOW);
    expect(first.replayed).toBe(false);
    await researchTroop(db, wallet, 'giant', k(), NOW);
    const secondDebit = (await row(wallet, 'giant')).debitLedgerTxnId!;
    expect(secondDebit).not.toBe(firstDebit);
    const balanceRunning = await shardBalance(wallet);
    const stale = await cancelResearch(db, wallet, 'giant', cancelKey, NOW);
    expect(stale).toMatchObject({ troop: 'giant', refundShards: String(L1_COST), replayed: true });
    const running = await row(wallet, 'giant');
    expect(running.researchingToLevel).toBe(2);
    expect(running.cancelledAt).toBeNull();
    expect(await shardBalance(wallet)).toBe(balanceRunning);
    expect(await refunds(firstDebit)).toHaveLength(1);
    expect(await refunds(secondDebit)).toHaveLength(0);
    // A fresh key still cancels the new episode normally.
    const fresh = await cancelResearch(db, wallet, 'giant', k(), NOW);
    expect(fresh.replayed).toBe(false);
    expect(await refunds(secondDebit)).toHaveLength(1);
  });

  it('lands an elapsed research instead of refunding it', async () => {
    const { wallet } = await forgePlayer();
    const before = await shardBalance(wallet);
    await researchTroop(db, wallet, 'giant', k(), NOW);
    const later = new Date(NOW.getTime() + (L1_SEC + 1) * 1000);
    await expect(cancelResearch(db, wallet, 'giant', k(), later)).rejects
      .toMatchObject({ statusCode: 409, code: 'RESEARCH_NOT_ACTIVE' });
    expect((await getArmyState(db, wallet, later)).levels.giant).toBe(2);
    expect(await shardBalance(wallet)).toBe(before - L1_COST);
  });

  it('refuses a pre-receipt research and hides the control: it finishes normally', async () => {
    const { wallet } = await forgePlayer();
    await db.insert(troopResearch).values({
      playerWallet: wallet, troop: 'giant', level: 1, researchingToLevel: 2,
      finishesAt: new Date(NOW.getTime() + L1_SEC * 1000),
    });
    expect((await getArmyState(db, wallet, NOW)).research).toEqual([expect.objectContaining({
      troop: 'giant', canCancel: false, refundShards: null,
    })]);
    const before = await shardBalance(wallet);
    await expect(cancelResearch(db, wallet, 'giant', k(), NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'RESEARCH_NOT_REFUNDABLE' });
    expect(await shardBalance(wallet)).toBe(before);
    expect((await row(wallet, 'giant')).researchingToLevel).toBe(2);
  });

  it('enforces the durable wallet ceiling and permits replay at cap', async () => {
    const { wallet } = await forgePlayer();
    await researchTroop(db, wallet, 'giant', k(), NOW);
    await db.update(players).set({
      researchCancelDay: DAY, researchCancelCount: RESEARCH_CANCELLATION.maxRefundsPerWalletUtcDay - 1,
    }).where(eq(players.wallet, wallet));
    const cancelKey = k();
    await cancelResearch(db, wallet, 'giant', cancelKey, NOW);
    const afterOne = await shardBalance(wallet);
    await researchTroop(db, wallet, 'bowman', k(), NOW);
    await expect(cancelResearch(db, wallet, 'bowman', k(), NOW)).rejects
      .toMatchObject({ statusCode: 429, code: 'RESEARCH_CANCEL_RATE_LIMITED' });
    expect(await shardBalance(wallet)).toBe(afterOne - L1_COST);
    expect((await row(wallet, 'bowman'))).toMatchObject({ researchingToLevel: 2, cancelledAt: null, refundLedgerTxnId: null });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
      .toMatchObject({ researchCancelDay: DAY, researchCancelCount: RESEARCH_CANCELLATION.maxRefundsPerWalletUtcDay });
    await expect(cancelResearch(db, wallet, 'giant', cancelKey, NOW)).resolves.toMatchObject({ replayed: true });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0]!.researchCancelCount)
      .toBe(RESEARCH_CANCELLATION.maxRefundsPerWalletUtcDay);
    // The next UTC day starts a fresh counter. By then the refused research
    // has landed (2 h), so the day-two cancellation is a NEW research.
    const nextDay = new Date('2026-09-02T00:00:00.000Z');
    await expect(cancelResearch(db, wallet, 'bowman', k(), nextDay)).rejects
      .toMatchObject({ statusCode: 409, code: 'RESEARCH_NOT_ACTIVE' });
    expect((await getArmyState(db, wallet, nextDay)).levels.bowman).toBe(2);
    await researchTroop(db, wallet, 'giant', k(), nextDay);
    await expect(cancelResearch(db, wallet, 'giant', k(), nextDay)).resolves.toMatchObject({ replayed: false });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
      .toMatchObject({ researchCancelDay: '2026-09-02', researchCancelCount: 1 });
  });

  it('credits SHARD-spend quests only when the level lands (natural or paid FINISH) — a cancel earns nothing', async () => {
    const { wallet } = await forgePlayer();
    await researchTroop(db, wallet, 'giant', k(), NOW);
    expect(await dailyQuestProgress(wallet, 'spend_200')).toBe(0);
    await cancelResearch(db, wallet, 'giant', k(), NOW);
    expect(await dailyQuestProgress(wallet, 'spend_200')).toBe(0);

    await researchTroop(db, wallet, 'giant', k(), NOW);
    await getArmyState(db, wallet, new Date(NOW.getTime() + (L1_SEC + 1) * 1000)); // lazy natural landing
    const afterNatural = await dailyQuestProgress(wallet, 'spend_200');
    expect(afterNatural).toBeGreaterThan(0);

    await researchTroop(db, wallet, 'bowman', k(), NOW);
    await researchSpeedup(db, wallet, 'bowman', k(), NOW); // paid landing credits too
    expect(await dailyQuestProgress(wallet, 'spend_500')).toBeGreaterThan(0);
    expect((await getArmyState(db, wallet, NOW)).levels.bowman).toBe(2);
  });
});
