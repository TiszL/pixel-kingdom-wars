/** Deed-native campaign progression and one-time reward settlement. */
import { CAMPAIGN } from '@shardkeep/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { baseCampaignProgress } from '../db/schema';
import { HttpError } from '../lib/errors';
import { rewardBaseShards } from './baseEconomy';
import { requireActiveStablePrerequisiteBase } from './stableBasePrerequisites';

export async function assertBaseCampaignStageUnlocked(
  db: DbOrTx,
  baseId: string,
  stage: number,
): Promise<void> {
  if (!Number.isInteger(stage) || stage < 1 || stage > CAMPAIGN.totalStages) {
    throw new HttpError(404, 'no such campaign stage');
  }
  if (stage === 1) return;
  const [previous] = await db.select({ stars: baseCampaignProgress.bestStars })
    .from(baseCampaignProgress)
    .where(and(
      eq(baseCampaignProgress.baseId, baseId),
      eq(baseCampaignProgress.stage, stage - 1),
    ));
  if ((previous?.stars ?? 0) < CAMPAIGN.unlockStarsRequired) {
    throw new HttpError(422, `clear stage ${stage - 1} first`);
  }
}

export async function getBaseCampaignBoard(db: Db, wallet: string, baseId: string) {
  await requireActiveStablePrerequisiteBase(db, wallet, baseId);
  const rows = await db.select().from(baseCampaignProgress)
    .where(eq(baseCampaignProgress.baseId, baseId));
  const byStage = new Map(rows.map((row) => [row.stage, row]));
  return {
    baseId,
    stages: Array.from({ length: CAMPAIGN.totalStages }, (_, index) => {
      const stage = index + 1;
      const encounter = CAMPAIGN.encounters[index]!;
      const keepLevel = encounter.keepLevel;
      const previous = stage === 1 ? undefined : byStage.get(stage - 1);
      return {
        stage,
        act: Math.floor(index / CAMPAIGN.stagesPerAct) + 1,
        tier: keepLevel,
        keepLevel,
        name: encounter.name,
        theme: encounter.theme,
        tactic: encounter.tactic,
        profile: encounter.profile,
        threat: encounter.threat,
        position: { c: encounter.c, r: encounter.r },
        defenderHero: encounter.defenderHero?.hero ?? null,
        recommendedArmyPoints: CAMPAIGN.recommendedArmyPointsByKeep[keepLevel - 1],
        maxArmyPoints: CAMPAIGN.maxArmyPointsByKeep[keepLevel - 1],
        bestStars: byStage.get(stage)?.bestStars ?? 0,
        unlocked: stage === 1 || (previous?.bestStars ?? 0) >= CAMPAIGN.unlockStarsRequired,
        firstThreeStarClaimed: byStage.get(stage)?.firstThreeStarAt != null,
      };
    }),
  };
}

export interface BaseCampaignOutcome {
  firstThreeStar: boolean;
  rewardShards: bigint;
}

/**
 * Raid-resolution helper. It is intentionally wallet-independent: base_id is
 * the reward/progress identity, while ownerWallet is audit metadata only.
 */
export async function recordBaseCampaignOutcome(
  db: DbOrTx,
  baseId: string,
  ownerWallet: string,
  stage: number,
  stars: number,
  now = new Date(),
): Promise<BaseCampaignOutcome> {
  return db.transaction((tx) => recordBaseCampaignOutcomeTx(
    tx, baseId, ownerWallet, stage, stars, now,
  ));
}

async function recordBaseCampaignOutcomeTx(
  db: DbOrTx,
  baseId: string,
  ownerWallet: string,
  stage: number,
  stars: number,
  now: Date,
): Promise<BaseCampaignOutcome> {
  if (!Number.isInteger(stage) || stage < 1 || stage > CAMPAIGN.totalStages) {
    throw new HttpError(404, 'no such campaign stage');
  }
  if (!Number.isInteger(stars) || stars < 0 || stars > 3) {
    throw new RangeError(`campaign stars must be 0..3, got ${stars}`);
  }
  await db.insert(baseCampaignProgress).values({
    baseId, stage, bestStars: stars, updatedAt: now,
  }).onConflictDoUpdate({
    target: [baseCampaignProgress.baseId, baseCampaignProgress.stage],
    set: {
      bestStars: sql`GREATEST(${baseCampaignProgress.bestStars}, ${stars})`,
      updatedAt: now,
    },
  });
  if (stars < 3) return { firstThreeStar: false, rewardShards: 0n };

  const claimed = await db.update(baseCampaignProgress)
    .set({ firstThreeStarAt: now })
    .where(and(
      eq(baseCampaignProgress.baseId, baseId),
      eq(baseCampaignProgress.stage, stage),
      sql`${baseCampaignProgress.firstThreeStarAt} IS NULL`,
    ))
    .returning({ stage: baseCampaignProgress.stage });
  if (claimed.length === 0) return { firstThreeStar: false, rewardShards: 0n };

  const act = Math.ceil(stage / CAMPAIGN.stagesPerAct);
  // Reward is keyed by the AUTHORED row's Keep band, never re-derived
  // arithmetically: a stage→keep mapping change must not silently pay 0.
  const encounter = CAMPAIGN.encounters[stage - 1];
  if (!encounter) throw new Error(`campaign stage ${stage} has no authored encounter row`);
  const keepLevel = encounter.keepLevel;
  const reward = BigInt(CAMPAIGN.firstThreeStarShardsByKeep[keepLevel - 1] ?? 0);
  if (reward > 0n) {
    await rewardBaseShards(
      db,
      baseId,
      reward,
      'campaign.first_three_star',
      `campaign-3star:${baseId}:${stage}`,
      { stage, act, ownerWallet },
    );
  }
  return { firstThreeStar: true, rewardShards: reward };
}
