/**
 * Cancelling a RUNNING building upgrade (tester request 2026-09-04) is a
 * money path: the refund is the job's own recorded SHARD debit, posted once,
 * and nothing about the loop may be farmable. These pin the rules that would
 * quietly break the economy if lost: the refund comes from the receipt (never
 * a cost table), the builder is freed and the level untouched, a replayed
 * cancel key returns the same result without a second refund, SOL-paid and
 * pre-receipt jobs are refused with distinct codes, non-upgrade jobs are
 * refused, the durable UTC-day ceilings hold, and — the v2 training precedent
 * — the upgrade and SHARD-spend quests tick only when the level LANDS, so a
 * start → cancel → refund loop earns nothing.
 */
import { and, eq } from 'drizzle-orm';
import { BuildingType, UPGRADE_CANCELLATION, UPGRADE_COSTS } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bases, builderJobs, buildings, ledgerTransactions, players, questProgress, quests,
} from '../src/db/schema';
import {
  applyPaidUpgrade, cancelUpgrade, completeDueJobs, ensureStartingBase, getBaseState,
  placeBuilding, upgradeBuilding,
} from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let seq = 0;
const k = (): string => `upgrade-cancel-${++seq}-${Math.random().toString(36).slice(2)}`;
const VAULT_COST = BigInt(UPGRADE_COSTS.vault[0]!);
const NOW = new Date('2026-09-01T10:00:00.000Z');
const DAY = '2026-09-01';

/** Wallet-keyed (legacy) player, like army.test's: no stable base identity, so
 *  jobs and quest progress stay on the wallet and the wallet reads below are
 *  the whole truth. base-cancel.test.ts covers the deed-keyed twin. */
async function freshPlayer(builders = 1) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  await fundTestKeep(db, p.wallet, 100_000n, 'test.fund', k());
  await rewardShards(db, p.wallet, 100_000n, 'test.fund.shards', k());
  // Strict Keep-tallest law: a building cannot out-level the Keep.
  await db.update(players).set({ keepLevel: 5, builders }).where(eq(players.wallet, p.wallet));
  await db.update(bases).set({ keepLevel: 5, builders }).where(eq(bases.ownerWallet, p.wallet));
  return p;
}

/** A completed Vault at L1 — inserted with no build job, like the army tests
 *  insert their Barracks, so the only builder job in play is the upgrade. */
async function vault(wallet: string, tx = 11, ty = 10) {
  const [b] = await db.insert(buildings)
    .values({ playerWallet: wallet, type: BuildingType.Vault, level: 1, tx, ty }).returning();
  return b!;
}

const shardBalance = async (wallet: string): Promise<bigint> =>
  (await getOrCreatePlayerAccount(db, wallet, 'player_shards')).balance;
const jobRow = async (id: string) => (await db.select().from(builderJobs).where(eq(builderJobs.id, id)))[0]!;
const level = async (id: string): Promise<number> =>
  (await db.select({ level: buildings.level }).from(buildings).where(eq(buildings.id, id)))[0]!.level;
const refunds = (jobId: string) => db.select().from(ledgerTransactions)
  .where(eq(ledgerTransactions.idempotencyKey, `build-upgrade-cancel:${jobId}`));
const dailyQuestProgress = async (wallet: string, templateCode: string): Promise<number> => {
  const [row] = await db.select({ progress: questProgress.progress }).from(questProgress)
    .innerJoin(quests, eq(quests.id, questProgress.questId))
    .where(and(
      eq(questProgress.playerWallet, wallet), eq(quests.scope, 'daily'),
      eq(quests.activeOn, DAY), eq(quests.templateCode, templateCode),
    ));
  return row?.progress ?? 0;
};

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('cancelUpgrade — the money checklist', () => {
  it('refunds the exact recorded debit, frees the builder and leaves the level where it was', async () => {
    const { wallet } = await freshPlayer();
    const b = await vault(wallet);
    const before = await shardBalance(wallet);
    const { job } = await upgradeBuilding(db, wallet, b.id, k(), NOW);
    expect(await shardBalance(wallet)).toBe(before - VAULT_COST);
    expect((await getBaseState(db, wallet, NOW)).freeBuilders).toBe(0);
    // The receipt is the job's own, snapshotted at start.
    expect(await jobRow(job!.id)).toMatchObject({ paidShardCost: VAULT_COST, cancelledAt: null });
    expect((await getBaseState(db, wallet, NOW)).jobs).toEqual([expect.objectContaining({
      id: job!.id, canCancel: true, refundShards: String(VAULT_COST),
    })]);

    const result = await cancelUpgrade(db, wallet, job!.id, k(), NOW);
    expect(result).toMatchObject({
      id: job!.id, buildingId: b.id, refundShards: String(VAULT_COST), cancelledAt: NOW, replayed: false,
    });
    expect(await shardBalance(wallet)).toBe(before);
    const state = await getBaseState(db, wallet, NOW);
    expect(state.freeBuilders).toBe(1);
    expect(state.jobs).toEqual([]);
    expect(await level(b.id)).toBe(1);
    expect(await jobRow(job!.id)).toMatchObject({ completedAt: NOW, cancelledAt: NOW });
    expect(await refunds(job!.id)).toHaveLength(1);
    // The cancelled job can never land its level, however late it is settled.
    await completeDueJobs(db, wallet, new Date(NOW.getTime() + 7 * 24 * 3600 * 1000));
    expect(await level(b.id)).toBe(1);
  });

  it('replays the same cancel key without a second refund and refuses that key on another job', async () => {
    const { wallet } = await freshPlayer(2);
    const first = await vault(wallet, 11, 10);
    const second = await vault(wallet, 13, 10);
    const before = await shardBalance(wallet);
    const a = (await upgradeBuilding(db, wallet, first.id, k(), NOW)).job!;
    const b = (await upgradeBuilding(db, wallet, second.id, k(), NOW)).job!;
    const cancelKey = k();
    await cancelUpgrade(db, wallet, a.id, cancelKey, NOW);
    const replay = await cancelUpgrade(db, wallet, a.id, cancelKey, NOW);
    expect(replay).toMatchObject({ id: a.id, refundShards: String(VAULT_COST), replayed: true });
    expect(await shardBalance(wallet)).toBe(before - VAULT_COST); // one refund, one job still paid
    expect(await refunds(a.id)).toHaveLength(1);
    // A different key on the already-cancelled job is not a replay.
    await expect(cancelUpgrade(db, wallet, a.id, k(), NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'JOB_NOT_ACTIVE' });
    // The used key cannot cancel a second job.
    await expect(cancelUpgrade(db, wallet, b.id, cancelKey, NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'JOB_CANCEL_KEY_REUSED' });
    expect(await shardBalance(wallet)).toBe(before - VAULT_COST);
    expect((await jobRow(b.id)).cancelledAt).toBeNull();
  });

  it('lands an elapsed upgrade instead of refunding it', async () => {
    const { wallet } = await freshPlayer();
    const b = await vault(wallet);
    const before = await shardBalance(wallet);
    const { job } = await upgradeBuilding(db, wallet, b.id, k(), NOW);
    const later = new Date(NOW.getTime() + 3 * 3600 * 1000); // past the 2h vault upgrade
    await expect(cancelUpgrade(db, wallet, job!.id, k(), later)).rejects
      .toMatchObject({ statusCode: 409, code: 'JOB_NOT_ACTIVE' });
    expect(await level(b.id)).toBe(2);
    expect(await shardBalance(wallet)).toBe(before - VAULT_COST);
  });

  it('refuses a build job: only a running upgrade can be cancelled', async () => {
    const { wallet } = await freshPlayer();
    const b = await placeBuilding(db, wallet, BuildingType.Mine, 11, 8, k(), NOW);
    const state = await getBaseState(db, wallet, NOW);
    const job = state.jobs.find((j) => j.buildingId === b.id)!;
    expect(job).toMatchObject({ kind: 'build', canCancel: false, refundShards: null });
    const before = await shardBalance(wallet);
    await expect(cancelUpgrade(db, wallet, job.id, k(), NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'JOB_NOT_CANCELLABLE' });
    expect(await shardBalance(wallet)).toBe(before);
  });

  it('refuses a SOL-paid mine step and a pre-receipt job with distinct codes, and hides the control', async () => {
    const { wallet } = await freshPlayer(2);
    // D-057: Mine L4→L5 is SOL-priced and enters through applyPaidUpgrade.
    const [mine] = await db.insert(buildings)
      .values({ playerWallet: wallet, type: BuildingType.Mine, level: 4, tx: 11, ty: 10 }).returning();
    await db.transaction((tx) => applyPaidUpgrade(tx, wallet, mine!.id, k(), NOW));
    // A job written before the receipt existed (rolling deploy / history).
    const v = await vault(wallet, 13, 10);
    const [legacy] = await db.insert(builderJobs).values({
      playerWallet: wallet, kind: 'upgrade', buildingId: v.id, startedAt: NOW,
      finishesAt: new Date(NOW.getTime() + 3600 * 1000),
    }).returning();
    const state = await getBaseState(db, wallet, NOW);
    expect(state.jobs).toHaveLength(2);
    expect(state.jobs.every((j) => j.canCancel === false && j.refundShards === null)).toBe(true);
    const paidJob = state.jobs.find((j) => j.buildingId === mine!.id)!;
    const before = await shardBalance(wallet);
    await expect(cancelUpgrade(db, wallet, paidJob.id, k(), NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'UPGRADE_PAID_IN_SOL' });
    await expect(cancelUpgrade(db, wallet, legacy!.id, k(), NOW)).rejects
      .toMatchObject({ statusCode: 409, code: 'UPGRADE_NOT_REFUNDABLE' });
    expect(await shardBalance(wallet)).toBe(before);
    expect((await getBaseState(db, wallet, NOW)).jobs).toHaveLength(2); // both still finish normally
  });

  it('enforces the durable wallet ceiling, leaves the refused job untouched, and permits replay at cap', async () => {
    const { wallet } = await freshPlayer(2);
    const first = await vault(wallet, 11, 10);
    const second = await vault(wallet, 13, 10);
    const a = (await upgradeBuilding(db, wallet, first.id, k(), NOW)).job!;
    const b = (await upgradeBuilding(db, wallet, second.id, k(), NOW)).job!;
    const afterDebits = await shardBalance(wallet);
    await db.update(players).set({
      upgradeCancelDay: DAY, upgradeCancelCount: UPGRADE_CANCELLATION.maxRefundsPerWalletUtcDay - 1,
    }).where(eq(players.wallet, wallet));

    const cancelKey = k();
    await cancelUpgrade(db, wallet, a.id, cancelKey, NOW);
    await expect(cancelUpgrade(db, wallet, b.id, k(), NOW)).rejects
      .toMatchObject({ statusCode: 429, code: 'UPGRADE_CANCEL_RATE_LIMITED' });
    expect(await shardBalance(wallet)).toBe(afterDebits + VAULT_COST);
    expect(await jobRow(b.id)).toMatchObject({ completedAt: null, cancelledAt: null, refundLedgerTxnId: null });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
      .toMatchObject({ upgradeCancelDay: DAY, upgradeCancelCount: UPGRADE_CANCELLATION.maxRefundsPerWalletUtcDay });
    // An exact replay is not a new refund and does not consume the ceiling.
    await expect(cancelUpgrade(db, wallet, a.id, cancelKey, NOW)).resolves.toMatchObject({ replayed: true });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0]!.upgradeCancelCount)
      .toBe(UPGRADE_CANCELLATION.maxRefundsPerWalletUtcDay);
    // The next UTC day starts a fresh counter. By then the refused job has
    // landed (10 min), so the day-two cancellation is a NEW upgrade of it.
    const nextDay = new Date('2026-09-02T00:00:00.000Z');
    await expect(cancelUpgrade(db, wallet, b.id, k(), nextDay)).rejects
      .toMatchObject({ statusCode: 409, code: 'JOB_NOT_ACTIVE' });
    expect(await level(second.id)).toBe(2);
    const c = (await upgradeBuilding(db, wallet, second.id, k(), nextDay)).job!;
    await expect(cancelUpgrade(db, wallet, c.id, k(), nextDay)).resolves.toMatchObject({ replayed: false });
    expect((await db.select().from(players).where(eq(players.wallet, wallet)))[0])
      .toMatchObject({ upgradeCancelDay: '2026-09-02', upgradeCancelCount: 1 });
  });

  it('credits the upgrade and SHARD-spend quests only when the level lands — a cancel earns nothing', async () => {
    const { wallet } = await freshPlayer();
    const b = await vault(wallet);
    const { job } = await upgradeBuilding(db, wallet, b.id, k(), NOW);
    expect(await dailyQuestProgress(wallet, 'upgrade_any')).toBe(0);
    expect(await dailyQuestProgress(wallet, 'spend_200')).toBe(0);
    await cancelUpgrade(db, wallet, job!.id, k(), NOW);
    expect(await dailyQuestProgress(wallet, 'upgrade_any')).toBe(0);
    expect(await dailyQuestProgress(wallet, 'spend_200')).toBe(0);

    await upgradeBuilding(db, wallet, b.id, k(), NOW);
    await completeDueJobs(db, wallet, new Date(NOW.getTime() + 3 * 3600 * 1000));
    expect(await level(b.id)).toBe(2);
    expect(await dailyQuestProgress(wallet, 'upgrade_any')).toBe(1);
    expect(await dailyQuestProgress(wallet, 'upgrade_2_buildings')).toBe(1);
    expect(await dailyQuestProgress(wallet, 'spend_200')).toBeGreaterThan(0);
  });
});
