import { trainTroop } from './training-consent';
/** Onboarding cannot sell already-free time, count cancelled troops, or open an
 * impossible first battle. Exercise real service transactions and persisted facts. */
import { randomUUID } from 'node:crypto';
import { BuildingType, QUESTS, RAID_RULES, TROOPS } from '@shardkeep/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { army, baseArmy, bases, baseSlots, buildings, builderJobs, ledgerTransactions, players, questProgress, quests, raids } from '../src/db/schema';
import { cancelTraining, completeDueTraining} from '../src/game/army';
import { cancelUpgrade, completeDueJobs, ensureStartingBase, getBaseState, speedupJob, upgradeBuilding } from '../src/game/base';
import { getQuestBoard, progressQuest } from '../src/game/quests';
import { acceptLiveRaidCommand } from '../src/game/liveRaids';
import { createCampaignRaid, getRaidEnergy } from '../src/game/raids';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const key = () => randomUUID();
const now = new Date('2030-01-01T00:00:00Z');
beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });
async function player() {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  return p;
}
async function troopsProgress(wallet: string) {
  return (await getQuestBoard(db, wallet, now)).quests.find((q) => q.templateCode === 'first_troops')!;
}
async function construction(wallet: string, kind: 'build' | 'upgrade' = 'build', finishesAt = new Date(now.getTime() + 60_000)) {
  const [building] = await db.insert(buildings).values({ playerWallet: wallet, type: BuildingType.Camp, level: 1, tx: 9, ty: 9 }).returning();
  const [job] = await db.insert(builderJobs).values({ playerWallet: wallet, buildingId: building!.id, kind,
    startedAt: new Date('2026-08-01T00:00:00Z'), finishesAt }).returning();
  return { building: building!, job: job! };
}

describe.sequential('onboarding server recovery', () => {
  it('acknowledges concurrent L1 finishes successfully while completing and crediting the job once, without a zero ledger debit', async () => {
    const p = await player();
    const { job } = await construction(p.wallet);
    expect((await getBaseState(db, p.wallet, now)).jobs.find((j) => j.id === job.id)?.finishCostKeep).toBe('0');
    // A retry can use a different request key before a refreshed base arrives.
    // Both requests must acknowledge the same successful build.
    const requestKeys = [key(), key()];
    const attempts = await Promise.all([
      speedupJob(db, p.wallet, job.id, requestKeys[0]!, now),
      speedupJob(db, p.wallet, job.id, requestKeys[1]!, now),
    ]);
    expect(attempts).toEqual([{ cost: 0n }, { cost: 0n }]);
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance).toBe(0n);
    expect(await db.select().from(ledgerTransactions).where(inArray(ledgerTransactions.idempotencyKey,
      requestKeys.map((requestKey) => `speedup:${p.wallet}:${requestKey}`)))).toHaveLength(0);
    await completeDueJobs(db, p.wallet, now);
    const board = await getQuestBoard(db, p.wallet, now);
    expect(board.quests.find((q) => q.templateCode === 'first_camp')).toMatchObject({ progress: 1, completed: true, claimed: false });
  });

  it('acknowledges a naturally completed initial build without rewriting the job, quest progress or ledger', async () => {
    const p = await player();
    const { job } = await construction(p.wallet, 'build', new Date(now.getTime() - 1));
    await completeDueJobs(db, p.wallet, now);
    const board = await getQuestBoard(db, p.wallet, now);
    expect(board.quests.find((q) => q.templateCode === 'first_camp')).toMatchObject({ progress: 1, completed: true, claimed: false });
    const persisted = async () => ({
      // xmin detects even an otherwise identical UPDATE: a repeated Finish must
      // not run the quest path again just because its progress is clamped to one.
      job: await db.select({ version: sql<string>`xmin::text`, completedAt: builderJobs.completedAt,
        finishesAt: builderJobs.finishesAt }).from(builderJobs).where(eq(builderJobs.id, job.id)),
      quests: await db.select({ version: sql<string>`xmin::text`, id: questProgress.id,
        progress: questProgress.progress, completedAt: questProgress.completedAt })
        .from(questProgress).where(eq(questProgress.playerWallet, p.wallet)).orderBy(questProgress.id),
    });
    const before = await persisted();
    const requestKey = key();
    expect(await speedupJob(db, p.wallet, job.id, requestKey, new Date(now.getTime() + 1_000))).toEqual({ cost: 0n });
    expect(await speedupJob(db, p.wallet, job.id, requestKey, new Date(now.getTime() + 2_000))).toEqual({ cost: 0n });
    expect(await persisted()).toEqual(before);
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance).toBe(0n);
    expect(await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.idempotencyKey,
      `speedup:${p.wallet}:${requestKey}`))).toHaveLength(0);
  });

  it('does not turn absent or foreign construction into a successful free finish', async () => {
    const p = await player();
    const other = await player();
    const { job } = await construction(p.wallet);
    await completeDueJobs(db, p.wallet, new Date(job.finishesAt.getTime() + 1));
    await expect(speedupJob(db, p.wallet, key(), key(), now)).rejects.toThrow(/not found/);
    await expect(speedupJob(db, other.wallet, job.id, key(), now)).rejects.toThrow(/not found/);
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance).toBe(0n);
  });

  it('keeps a cancelled upgrade rejected instead of acknowledging it as completed construction', async () => {
    const p = await player();
    await db.update(players).set({ keepLevel: 2 }).where(eq(players.wallet, p.wallet));
    await rewardShards(db, p.wallet, 100_000n, 'test.cancelled-finish', key());
    const [building] = await db.insert(buildings).values({ playerWallet: p.wallet,
      type: BuildingType.Vault, level: 1, tx: 9, ty: 9 }).returning();
    const { job } = await upgradeBuilding(db, p.wallet, building!.id, key(), now);
    await cancelUpgrade(db, p.wallet, job!.id, key(), now);
    const [cancelled] = await db.select().from(builderJobs).where(eq(builderJobs.id, job!.id));
    expect(cancelled).toMatchObject({ completedAt: now, cancelledAt: now });
    await expect(speedupJob(db, p.wallet, job!.id, key(), now)).rejects.toThrow(/already done/);
    expect((await db.select().from(buildings).where(eq(buildings.id, building!.id)))[0]!.level).toBe(1);
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance).toBe(0n);
  });

  it.each(['upgrade', 'repair', 'clear_obstacle'] as const)('keeps %s acceleration paid while time remains', async (kind) => {
    const p = await player();
    const { job, building } = await construction(p.wallet);
    if (kind === 'repair') {
      await db.update(buildings).set({ type: BuildingType.PowderMine, trapSpentAt: now })
        .where(eq(buildings.id, building.id));
    }
    const obstacleId = kind === 'clear_obstacle'
      ? (await getBaseState(db, p.wallet, now)).obstacles[0]!.id : null;
    await db.update(builderJobs).set({ kind, obstacleId,
      buildingId: kind === 'clear_obstacle' ? null : building.id }).where(eq(builderJobs.id, job.id));
    const quote = (await getBaseState(db, p.wallet, now)).jobs.find((j) => j.id === job.id)!;
    expect(BigInt(quote.finishCostKeep)).toBeGreaterThan(0n);
    await expect(speedupJob(db, p.wallet, job.id, key(), now)).rejects.toThrow();
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job.id)))[0]!.completedAt).toBeNull();
    await fundTestKeep(db, p.wallet, 1_000n, 'test.onboarding-finish', key());
    expect(await speedupJob(db, p.wallet, job.id, key(), now)).toEqual({ cost: BigInt(quote.finishCostKeep) });
  });

  it('refuses a free finish after the selected deed changes owner', async () => {
    const seller = await player();
    const buyer = await player();
    const [base] = await db.insert(bases).values({ ownerWallet: seller.wallet, status: 'active' }).returning();
    await db.insert(baseSlots).values({ wallet: seller.wallet, slot: 1, baseId: base!.id });
    const { job, building } = await construction(seller.wallet);
    await db.update(builderJobs).set({ baseId: base!.id }).where(eq(builderJobs.id, job.id));
    await db.update(buildings).set({ baseId: base!.id }).where(eq(buildings.id, building.id));
    await db.update(bases).set({ ownerWallet: buyer.wallet }).where(eq(bases.id, base!.id));
    await expect(speedupJob(db, seller.wallet, job.id, key(), now, base!.id))
      .rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, job.id)))[0]!.completedAt).toBeNull();
  });

  it('reconciles held historical troops only on their deed without paying or claiming', async () => {
    const p = await player();
    const selected = await db.insert(bases).values([
      { ownerWallet: p.wallet, status: 'active' }, { ownerWallet: p.wallet, status: 'active' },
    ]).returning();
    await db.insert(baseSlots).values(selected.map((base, index) => ({ wallet: p.wallet, slot: index + 1, baseId: base.id })));
    const target = QUESTS.onboardingTemplates.find((q) => q.id === 'first_troops')!.target;
    await db.insert(baseArmy).values({ baseId: selected[0]!.id, troop: 'plunderer', count: target / TROOPS.plunderer.pts });
    const complete = (await getQuestBoard(db, p.wallet, now, selected[0]!.id)).quests.find((q) => q.templateCode === 'first_troops')!;
    const empty = (await getQuestBoard(db, p.wallet, now, selected[1]!.id)).quests.find((q) => q.templateCode === 'first_troops')!;
    expect(complete).toMatchObject({ progress: target, completed: true, claimed: false });
    expect(empty).toMatchObject({ progress: 0, completed: false, claimed: false });
  });

  it('charges no time for an overdue upgrade and refuses another wallet before completion', async () => {
    const p = await player();
    const other = await player();
    const { building, job } = await construction(p.wallet, 'upgrade', new Date(now.getTime() - 1));
    await expect(speedupJob(db, other.wallet, job.id, key(), now)).rejects.toThrow();
    expect(await speedupJob(db, p.wallet, job.id, key(), now)).toEqual({ cost: 0n });
    const [finished] = await db.select().from(buildings).where(eq(buildings.id, building.id));
    expect(finished!.level).toBe(2);
    await expect(speedupJob(db, p.wallet, job.id, key(), now)).rejects.toThrow(/already done/);
  });

  it('counts actual training once, never pending or cancelled rows, and reconciles history without claims', async () => {
    const p = await player();
    await db.insert(buildings).values([
      { playerWallet: p.wallet, type: BuildingType.Camp, level: 1, tx: 9, ty: 9 },
      { playerWallet: p.wallet, type: BuildingType.Barracks, level: 1, tx: 17, ty: 9 },
    ]);
    await rewardShards(db, p.wallet, 100_000n, 'test.onboarding', key());
    const queued = await trainTroop(db, p.wallet, 'plunderer', key(), now);
    expect((await troopsProgress(p.wallet)).progress).toBe(0);
    await cancelTraining(db, p.wallet, queued.id, key(), now);
    expect((await troopsProgress(p.wallet)).progress).toBe(0);
    await trainTroop(db, p.wallet, 'plunderer', key(), now);
    await completeDueTraining(db, p.wallet, new Date(now.getTime() + 3_600_000));
    expect((await troopsProgress(p.wallet)).progress).toBe(TROOPS.plunderer.pts);
    await completeDueTraining(db, p.wallet, new Date(now.getTime() + 3_600_000));
    expect((await troopsProgress(p.wallet)).progress).toBe(TROOPS.plunderer.pts);
    // Simulate a completed row predating the onboarding tick. The held troop
    // and its completion receipt describe the same unit and must not add up.
    const [q] = await db.select().from(quests).where(and(eq(quests.scope, 'onboarding'), eq(quests.templateCode, 'first_troops')));
    await db.delete(questProgress).where(and(eq(questProgress.playerWallet, p.wallet), eq(questProgress.questId, q!.id)));
    expect(await troopsProgress(p.wallet)).toMatchObject({ progress: TROOPS.plunderer.pts, claimed: false });
  });

  it('rejects an empty novice campaign even after a failed attempt, but preserves a veteran', async () => {
    const p = await player();
    await expect(createCampaignRaid(db, p.wallet, 1, key(), now)).rejects.toMatchObject({ code: 'FIRST_CAMPAIGN_ARMY_REQUIRED' });
    expect(await db.select().from(raids).where(eq(raids.attackerWallet, p.wallet))).toHaveLength(0);
    await db.insert(raids).values({ attackerWallet: p.wallet, idempotencyKey: key(), campaignStage: 1,
      seed: 1n, snapshot: {}, armySnapshot: {}, ordersDeadlineAt: now, status: 'resolved', result: { stars: 0 } });
    await expect(createCampaignRaid(db, p.wallet, 1, key(), now)).rejects.toMatchObject({ code: 'FIRST_CAMPAIGN_ARMY_REQUIRED' });
    await progressQuest(db, p.wallet, 'first_raid', QUESTS.onboardingTemplates.find((q) => q.id === 'first_raid')!.target, now);
    expect((await createCampaignRaid(db, p.wallet, 1, key(), now)).status).toBe('pending_orders');
  });

  it('permits a ready hero-only first campaign', async () => {
    const p = await player();
    await db.insert(buildings).values({ playerWallet: p.wallet, type: BuildingType.HeroAltar, level: 1, tx: 9, ty: 9 });
    const raid = await createCampaignRaid(db, p.wallet, 1, key(), now);
    expect(raid.status).toBe('pending_orders');
    expect((raid.armySnapshot as { heroes: string[] }).heroes).toContain('vex');
  });

  it('early campaign expiry preserves sibling deeds and accepted deployments', async () => {
    const p = await player();
    const selected = await db.insert(bases).values([
      { ownerWallet: p.wallet, status: 'active' }, { ownerWallet: p.wallet, status: 'active' },
      { ownerWallet: p.wallet, status: 'active' },
    ]).returning();
    await db.insert(baseSlots).values(selected.map((base, index) => ({ wallet: p.wallet, slot: index + 1, baseId: base.id })));
    await db.insert(baseArmy).values(selected.map((base) => ({ baseId: base.id, troop: 'plunderer' as const, count: 1 })));
    const previous = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const at = new Date();
      const pending = [];
      for (const base of selected) {
        pending.push(await createCampaignRaid(db, p.wallet, 1, key(), at, {
          attackerBaseId: base.id, authorizeAttackerBase: async () => {},
        }));
      }
      await acceptLiveRaidCommand(db, p.wallet, pending[2]!.id, key(), {
        kind: 'deploy', payload: { troop: 'plunderer', tx: 6, ty: 14, tMs: 0 },
      }, at);
      const afterDeployWindow = new Date(at.getTime() + RAID_RULES.deployWindowSec * 1000 + 1);
      await getRaidEnergy(db, p.wallet, afterDeployWindow, selected[0]!.id);
      await getRaidEnergy(db, p.wallet, afterDeployWindow, selected[2]!.id);
      const statuses = [];
      for (const raid of pending) statuses.push((await db.select().from(raids).where(eq(raids.id, raid.id)))[0]!.status);
      expect(statuses).toEqual(['expired', 'pending_orders', 'pending_orders']);
    } finally {
      if (previous === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = previous;
    }
  });

  it('expires only the requesting wallet’s empty campaign at the deploy deadline', async () => {
    const p = await player();
    const other = await player();
    for (const wallet of [p.wallet, other.wallet]) {
      await db.insert(army).values({ playerWallet: wallet, troop: 'plunderer', count: 1 });
    }
    const abandoned = await createCampaignRaid(db, p.wallet, 1, key(), now);
    const sibling = await createCampaignRaid(db, other.wallet, 1, key(), now);
    await getRaidEnergy(db, p.wallet, new Date(now.getTime() + RAID_RULES.deployWindowSec * 1000 + 1));
    const [expired] = await db.select().from(raids).where(eq(raids.id, abandoned.id));
    const [untouched] = await db.select().from(raids).where(eq(raids.id, sibling.id));
    expect(expired!.status).toBe('expired');
    expect(untouched!.status).toBe('pending_orders');
  });
});
