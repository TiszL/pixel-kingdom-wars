/**
 * Quest Board (PLAN.md 4f — GDD §5): 3 dailies rotating deterministically
 * from the template pool (12 → 50, M23 a15 owner 2026-08-15) + 1 weekly that
 * rotates per ISO week across QUESTS.weeklyTemplates. The all-three bonus pays
 * automatically with the third daily claim.
 *
 * QUESTS PAY SHARDS (locked owner decision 2026-08-09, docs/LAND-DEED-ONBOARDING-PLAN.md
 * §7 Q3). They used to credit `player_keep` out of `quest_bucket` while the
 * constants that fed them were named `rewardShards` — the constants were right and
 * the ledger was wrong. Under free onboarding that mismatch would have been the
 * economy hole: quests stay FREE (no land required), and only `player_keep` is
 * withdrawable, so a deedless account must never be able to mint any. Shards are
 * minted from `shard_genesis` like mining and cannot leave the game.
 *
 * THIS IS UNCONDITIONAL AND DELIBERATELY *NOT* BEHIND `FREE_ONBOARDING` (security
 * review 2026-08-09 F2). The flag's contract is NOT "off means exactly today's
 * behaviour" — that claim was withdrawn as an overpromise and narrowed to
 * "authorization is unchanged (bar a named list of un-gatings) and no base exists
 * before the entry credit" (config.ts). This change touches neither half of that
 * promise: it moves no route between groups and creates nothing. It is listed in
 * config.ts's "what is NOT behind the flag" set, for two reasons:
 *  1. IT IS A BUG FIX THAT STANDS ALONE. `QUESTS.*.rewardShards` is the source of
 *     truth for the amount (CLAUDE.md: every game number lives in constants.ts),
 *     and the ledger disagreed with it about the CURRENCY. Pre-TGE Shards and KEEP
 *     are 1:1 (ECONOMY.md §7.5), so the number a player sees is unchanged; what
 *     changes is the account kind and the mint source, i.e. exactly the thing that
 *     was wrong. A flag would make the currency of a reward depend on an ops
 *     switch, which is worse than either behaviour.
 *  2. THE FLAG-OFF DELTA IS NAMED, NOT HIDDEN: a landowner's quest claim now
 *     credits non-withdrawable shards where it once credited withdrawable KEEP.
 *     That is the owner's locked decision (Q3), not a side effect of the free
 *     tier, and it applies to everyone from the same commit.
 *
 * The `quests.reward_keep` COLUMN keeps its name (renaming it is DDL for no
 * behavioural gain) but now holds SHARDS; `getQuestBoard` ships the honest
 * `rewardShards` field alongside the legacy `rewardKeep` one so the client can
 * migrate without a flag day.
 *
 * Progress is event-driven: game systems call progressQuest with a template
 * code; if that template is live today (or this week) the player's counter
 * advances. Templates whose counters are amounts (steal_500, spend_200) pass
 * the amount as the increment.
 */
import { QUESTS, TROOPS, type TroopType } from '@shardkeep/shared';
import { and, eq, inArray, isNotNull, isNull, notExists, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import {
  army,
  baseArmy,
  baseTrainingQueue,
  trainingQueue,
  baseQuestProgress,
  bases,
  builderJobs,
  buildings,
  players,
  questProgress,
  quests,
  raids,
} from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { utcDay } from './emission';
import { rewardBaseShards } from './baseEconomy';
import { rewardShards } from './spend';
import {
  lockStablePrerequisiteBase,
  requireActiveStablePrerequisiteBase,
  requireStableBaseMutationContext,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';


/** Deterministic day hash → same 3 dailies on every server instance. */
function dayHash(day: string): number {
  let h = 2166136261;
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Monday of the week containing `day` (UTC) — the weekly quest anchor. */
export function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return utcDay(new Date(d.getTime() - dow * 86_400_000));
}

/** EVERY daily template is live every day (owner 2026-08-16: "only 3 visible
 * still. Needs fix" — the 3-slot rotation is gone; players see and progress
 * the whole pool). Kept as a function so the day parameter documents intent
 * at the call sites and a future re-shrink has one seam. */
export function dailyQuestPicksFor(_day: string): ReadonlyArray<(typeof QUESTS.dailyTemplates)[number]> {
  return QUESTS.dailyTemplates;
}

/** Deterministic pure pick of THE weekly template for a week-start day (M23
 * a15: the weekly now rotates across QUESTS.weeklyTemplates; earn_8_stars
 * remains in the pool, and progressWeeklyStars still keys on its id). */
export function weeklyQuestTemplateFor(week: string): (typeof QUESTS.weeklyTemplates)[number] {
  const pool = QUESTS.weeklyTemplates;
  return pool[dayHash(week) % pool.length]!;
}

/**
 * The single day every ONBOARDING quest row lives on.
 *
 * The chain does not rotate — a player's first Mine is their first Mine whatever
 * the date — but `quests.active_on` is NOT NULL and carries the (scope,
 * activeOn, templateCode) unique key that makes ensureQuests idempotent. Pinning
 * the scope to one sentinel day gives the chain exactly one row per template for
 * the lifetime of the database and keeps that key doing its job. It is a storage
 * sentinel, not a game number, so it lives here rather than in constants.ts.
 *
 * The value is arbitrary but FROZEN: player progress rows reference these quest
 * ids, so moving the day would orphan every unfinished first-run chain.
 */
const ONBOARDING_ACTIVE_ON = '2000-01-01';

/**
 * Make the first-run chain exist. Unlike the dailies there is no day to roll
 * over, so this is a one-time backfill that then costs one indexed count.
 */
async function ensureOnboardingQuests(db: DbOrTx): Promise<void> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(quests)
    .where(and(eq(quests.scope, 'onboarding'), eq(quests.activeOn, ONBOARDING_ACTIVE_ON),
      inArray(quests.templateCode, QUESTS.onboardingTemplates.map((template) => template.id)))) as [{ n: number }];
  if (n >= QUESTS.onboardingTemplates.length) return;
  await db.insert(quests).values(QUESTS.onboardingTemplates.map((t) => ({
    scope: 'onboarding' as const,
    templateCode: t.id as string,
    target: t.target,
    rewardKeep: BigInt(t.rewardShards), // legacy column name, SHARDS value
    activeOn: ONBOARDING_ACTIVE_ON,
  }))).onConflictDoNothing();
}

export async function ensureQuests(db: DbOrTx, day: string): Promise<void> {
  const week = weekStart(day);
  await ensureOnboardingQuests(db);
  // Dailies: per-template upsert of the WHOLE pool (owner 2026-08-16 — every
  // daily is live every day; the 3-slot rotation is gone). The old existence
  // guard ("a day with rows is frozen") is deliberately dropped for dailies:
  // this rollout must BACKFILL the current production day, whose 3 legacy rows
  // (and any player progress attached to their ids) survive untouched because
  // the (scope, activeOn, templateCode) unique key makes their re-insert a
  // no-op. The daily bonus no longer counts board size (dailyBonusAt claims),
  // so appending rows to a live day is safe. Racing instances insert
  // identical rows — onConflictDoNothing absorbs both.
  {
    // Cheap fast-path: liveQuests() runs on every board read AND every
    // progress event, so skip the 50-row upsert once the day is complete.
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(quests)
      .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, day))) as [{ n: number }];
    if (n < QUESTS.dailyTemplates.length) {
      const rows: Array<typeof quests.$inferInsert> = dailyQuestPicksFor(day).map((t) => ({
        scope: 'daily' as const,
        templateCode: t.id as string,
        target: QUESTS.progressTargets[t.id] ?? 1,
        // Legacy column name, SHARDS value (see the module header).
        rewardKeep: BigInt(t.rewardShards),
        activeOn: day,
      }));
      await db.insert(quests).values(rows).onConflictDoNothing();
    }
  }
  const [weeklyExists] = await db.select({ id: quests.id }).from(quests)
    .where(and(eq(quests.scope, 'weekly'), eq(quests.activeOn, week))).limit(1);
  if (!weeklyExists) {
    const t = weeklyQuestTemplateFor(week);
    await db.insert(quests).values({
      scope: 'weekly' as const,
      templateCode: t.id as string,
      target: t.target,
      rewardKeep: BigInt(t.rewardShards), // legacy column name, SHARDS value
      activeOn: week,
    }).onConflictDoNothing();
  }
}

async function liveQuests(db: DbOrTx, day: string) {
  await ensureQuests(db, day);
  const daily = await db.select().from(quests)
    .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, day)));
  const weekly = await db.select().from(quests)
    .where(and(eq(quests.scope, 'weekly'), eq(quests.activeOn, weekStart(day))));
  // The first-run chain is live on every day there is: a player who reaches
  // their first Mine on day 40 must still tick `first_mine`, and a tick for a
  // step they already claimed is absorbed by the LEAST(target, …) clamp.
  const onboarding = await db.select().from(quests)
    .where(and(eq(quests.scope, 'onboarding'), eq(quests.activeOn, ONBOARDING_ACTIVE_ON)));
  return [...daily, ...weekly, ...onboarding];
}

async function advanceQuest(
  db: DbOrTx,
  q: { id: string; target: number; templateCode: string },
  wallet: string,
  increment: number,
  baseId?: string,
  minimum = false,
): Promise<void> {
  if (baseId && q.templateCode === 'first_troops') {
    // Reconciliation also reaches this path outside army's transaction. Hold
    // conveyance until canonical completion and its wallet actor are captured;
    // a stale owner's request must never become the buyer's completion proof.
    await db.transaction(async (tx) => {
      const [base] = await tx.select({ owner: bases.ownerWallet, status: bases.status })
        .from(bases).where(eq(bases.id, baseId)).for('update');
      if (!base || base.owner !== wallet || base.status !== 'active') {
        throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
      }
      await applyQuestProgress(tx, q, wallet, increment, baseId, minimum);
    });
    return;
  }
  await applyQuestProgress(db, q, wallet, increment, baseId, minimum);
}

async function applyQuestProgress(
  db: DbOrTx,
  q: { id: string; target: number },
  wallet: string,
  increment: number,
  baseId?: string,
  minimum = false,
): Promise<void> {
  if (baseId) {
    const next = minimum ? sql`GREATEST(${baseQuestProgress.progress}, ${increment})`
      : sql`${baseQuestProgress.progress} + ${increment}`;
    await db.insert(baseQuestProgress)
      .values({ questId: q.id, baseId, progress: 0 })
      .onConflictDoNothing();
    await db.update(baseQuestProgress)
      .set({
        progress: sql`LEAST(${q.target}, ${next})`,
        completedAt: sql`CASE WHEN ${next} >= ${q.target}
          AND ${baseQuestProgress.completedAt} IS NULL THEN NOW() ELSE ${baseQuestProgress.completedAt} END`,
      })
      .where(and(eq(baseQuestProgress.questId, q.id), eq(baseQuestProgress.baseId, baseId)));
  } else {
    const next = minimum ? sql`GREATEST(${questProgress.progress}, ${increment})`
      : sql`${questProgress.progress} + ${increment}`;
    await db.insert(questProgress)
      .values({ questId: q.id, playerWallet: wallet, progress: 0 })
      .onConflictDoNothing();
    await db.update(questProgress)
      .set({
        progress: sql`LEAST(${q.target}, ${next})`,
        completedAt: sql`CASE WHEN ${next} >= ${q.target}
          AND ${questProgress.completedAt} IS NULL THEN NOW() ELSE ${questProgress.completedAt} END`,
      })
      .where(and(eq(questProgress.questId, q.id), eq(questProgress.playerWallet, wallet)));
  }
}

/**
 * Repair event ticks that pre-date the quest-driven onboarding chain.
 *
 * The chain was added after real players had already built their first army
 * buildings, bought land and won raids. Those durable facts are authoritative;
 * leaving progress at zero merely because the original event happened before
 * the hook existed strands a returning player on an impossible first step.
 *
 * This is deliberately a reconciliation, not a reward path. It only uses the
 * same clamped progress upsert as live events, never stamps claimed_at and never
 * touches the ledger. In stable-base mode facts and progress follow base_id so
 * they convey with the deed. The wallet columns are consulted only by the
 * legacy wallet-keyed mode.
 */
async function reconcileOnboardingFacts(
  db: DbOrTx,
  wallet: string,
  baseId?: string,
): Promise<void> {
  let landed = false;
  if (baseId) {
    // Repeat the read-side authority fence inside the service. The HTTP route's
    // selected base can convey between its precheck and this eager tutorial
    // read; a stale owner must get BASE_NOT_OWNED, never another deed's chain.
    const base = await requireActiveStablePrerequisiteBase(db, wallet, baseId);
    landed = base.landPaidAt != null;
  } else {
    const [player] = await db.select({ entryPaidAt: players.entryPaidAt }).from(players)
      .where(eq(players.wallet, wallet));
    if (!player) return;
    landed = player.entryPaidAt != null;
  }

  await ensureOnboardingQuests(db);
  const onboarding = await db.select().from(quests)
    .where(and(eq(quests.scope, 'onboarding'), eq(quests.activeOn, ONBOARDING_ACTIVE_ON)));
  if (onboarding.length === 0) return;

  const questIds = onboarding.map((q) => q.id);
  const storedProgress = baseId
    ? await db.select({ questId: baseQuestProgress.questId, progress: baseQuestProgress.progress })
      .from(baseQuestProgress).where(and(
        eq(baseQuestProgress.baseId, baseId),
        inArray(baseQuestProgress.questId, questIds),
      ))
    : await db.select({ questId: questProgress.questId, progress: questProgress.progress })
      .from(questProgress).where(and(
        eq(questProgress.playerWallet, wallet),
        inArray(questProgress.questId, questIds),
      ));
  const progressByQuest = new Map(storedProgress.map((p) => [p.questId, p.progress]));
  const unresolved = onboarding.filter((q) => (progressByQuest.get(q.id) ?? 0) < q.target);
  // Returning players hit /tutorial on every base mount. Once their chain is
  // complete, never rescan building-job and raid history on that hot path.
  if (unresolved.length === 0) return;

  const buildingScope = baseId
    ? eq(buildings.baseId, baseId)
    : eq(buildings.playerWallet, wallet);
  const jobScope = baseId
    ? eq(builderJobs.baseId, baseId)
    : eq(builderJobs.playerWallet, wallet);
  const raidScope = baseId
    ? eq(raids.attackerBaseId, baseId)
    : eq(raids.attackerWallet, wallet);
  const buildStepByType = {
    camp: 'first_camp',
    mine: 'first_mine',
    barracks: 'first_barracks',
  } as const;
  const unresolvedCodes = new Set(unresolved.map((q) => q.templateCode));
  const unresolvedBuildingTypes = (Object.keys(buildStepByType) as Array<keyof typeof buildStepByType>)
    .filter((type) => unresolvedCodes.has(buildStepByType[type]));
  const [completedBuildings, wonRaids] = await Promise.all([
    unresolvedBuildingTypes.length === 0
      ? Promise.resolve([] as Array<{ type: string }>)
      : db.selectDistinct({ type: buildings.type }).from(buildings).where(and(
        buildingScope,
        inArray(buildings.type, unresolvedBuildingTypes),
        // Placement creates the building row before its timer finishes. Only a
        // structure with no live BUILD job is historical proof of completion;
        // an upgrade/repair in progress does not make an already-built structure
        // cease to exist. Scope the anti-join so the hot tutorial read never
        // searches another wallet/base's job history.
        notExists(db.select({ id: builderJobs.id }).from(builderJobs).where(and(
          jobScope,
          eq(builderJobs.buildingId, buildings.id),
          eq(builderJobs.kind, 'build'),
          isNull(builderJobs.completedAt),
        ))),
      )),
    !unresolvedCodes.has('first_raid')
      ? Promise.resolve([] as Array<{ id: string }>)
      : db.select({ id: raids.id }).from(raids).where(and(
        raidScope,
        eq(raids.status, 'resolved'),
        sql`COALESCE((${raids.result}->>'stars')::int, 0) >= 1`,
      )).limit(1),
  ]);

  let trainedPoints = 0;
  if (unresolvedCodes.has('first_troops')) {
    const [completed, held] = baseId
      ? await Promise.all([
        db.select({ troop: baseTrainingQueue.troop, count: sql<number>`count(*)::int` })
          .from(baseTrainingQueue).where(and(eq(baseTrainingQueue.baseId, baseId),
            isNotNull(baseTrainingQueue.completedAt), isNull(baseTrainingQueue.cancelledAt)))
          .groupBy(baseTrainingQueue.troop),
        db.select({ troop: baseArmy.troop, count: baseArmy.count }).from(baseArmy)
          .where(eq(baseArmy.baseId, baseId)),
      ])
      : await Promise.all([
        db.select({ troop: trainingQueue.troop, count: sql<number>`count(*)::int` })
          .from(trainingQueue).where(and(eq(trainingQueue.playerWallet, wallet),
            isNotNull(trainingQueue.completedAt), isNull(trainingQueue.cancelledAt)))
          .groupBy(trainingQueue.troop),
        db.select({ troop: army.troop, count: army.count }).from(army)
          .where(eq(army.playerWallet, wallet)),
      ]);
    const points = (rows: Array<{ troop: string; count: number }>) => rows.reduce((total, row) => {
      const stats = Object.prototype.hasOwnProperty.call(TROOPS, row.troop)
        ? TROOPS[row.troop as TroopType] : undefined;
      return total + row.count * (stats?.pts ?? 0);
    }, 0);
    // Held troops are a historical minimum, not extra completed training.
    // Summing both would count each newly completed unit twice.
    trainedPoints = Math.max(points(completed), points(held));
  }

  const facts = new Set<string>();
  for (const row of completedBuildings) {
    const step = buildStepByType[row.type as keyof typeof buildStepByType];
    if (step) facts.add(step);
  }
  if (landed && unresolvedCodes.has('first_land')) facts.add('first_land');
  if (wonRaids.length > 0) facts.add('first_raid');

  for (const q of unresolved) {
    const minimum = q.templateCode === 'first_troops' ? trainedPoints
      : facts.has(q.templateCode) ? q.target : 0;
    if (minimum <= 0) continue;
    await advanceQuest(db, q, wallet, minimum, baseId, true);
  }
}

/** Advance a template's counter if it is live; completes when target reached. */
export async function progressQuest(
  db: DbOrTx,
  wallet: string,
  templateCode: string,
  increment = 1,
  at = new Date(),
  baseId?: string,
): Promise<void> {
  await progressQuestBatch(db, wallet, [[templateCode, increment]], at, baseId);
}

/**
 * Advance MANY templates with ONE live-quest lookup (M23 a15). Raid settlement
 * now fires a volley of ticks (troop-deploy, buff, star, loot, campaign …);
 * per-template calls would each re-run ensureQuests + two selects. Only
 * templates live today (or this week) advance — a tick for a rotated-out
 * template is a no-op, which is what lets every call site fire its whole
 * volley unconditionally.
 */
export async function progressQuestBatch(
  db: DbOrTx,
  wallet: string,
  ticks: ReadonlyArray<readonly [templateCode: string, increment: number]>,
  at = new Date(),
  baseId?: string,
): Promise<void> {
  if (ticks.length === 0) return;
  const live = await liveQuests(db, utcDay(at));
  for (const [templateCode, increment] of ticks) {
    for (const q of live) {
      if (q.templateCode !== templateCode) continue;
      await advanceQuest(db, q, wallet, increment, baseId);
    }
  }
}

/** Internal event helper for base/build/raid systems. */
export async function progressBaseQuest(
  db: DbOrTx,
  baseId: string,
  templateCode: string,
  increment = 1,
  at = new Date(),
): Promise<void> {
  await progressQuest(db, '', templateCode, increment, at, baseId);
}

/** Star ticks for the earn_8_stars weekly (GDD §5). With weekly rotation
 * (M23 a15) this is a no-op on weeks where a different weekly is live. */
export async function progressWeeklyStars(
  db: DbOrTx,
  wallet: string,
  stars: number,
  at = new Date(),
  baseId?: string,
): Promise<void> {
  if (stars > 0) await progressQuest(db, wallet, QUESTS.weekly.id, stars, at, baseId);
}

export async function getQuestBoard(db: Db, wallet: string, at = new Date(), baseId?: string) {
  await reconcileOnboardingFacts(db, wallet, baseId);
  const day = utcDay(at);
  const live = await liveQuests(db, day);
  const board = [];
  for (const q of live) {
    const [p] = baseId
      ? await db.select().from(baseQuestProgress)
        .where(and(eq(baseQuestProgress.questId, q.id), eq(baseQuestProgress.baseId, baseId)))
      : await db.select().from(questProgress)
        .where(and(eq(questProgress.questId, q.id), eq(questProgress.playerWallet, wallet)));
    board.push({
      id: q.id,
      scope: q.scope,
      templateCode: q.templateCode,
      target: q.target,
      /** The honest name (2026-08-09: quests pay SHARDS, not KEEP). */
      rewardShards: Number(q.rewardKeep),
      /** @deprecated legacy wire name for the SAME shards value — remove once the client reads rewardShards. */
      rewardKeep: Number(q.rewardKeep),
      progress: p?.progress ?? 0,
      completed: p?.completedAt != null,
      claimed: p?.claimedAt != null,
    });
  }
  return { day, quests: board, allThreeBonus: QUESTS.allThreeBonusShards };
}

/** One step of the first-run chain, as the base-screen objective strip needs it. */
export interface OnboardingStepDto {
  questId: string;
  templateCode: string;
  target: number;
  rewardShards: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
}

/**
 * The step the player is ON — the first chain entry they have not yet CLAIMED,
 * in QUESTS.onboardingTemplates order, or null once the chain is finished.
 *
 * Claimed, not completed, is the terminal condition on purpose: the reward is
 * part of the step, so a finished-but-unclaimed step must stay the live
 * objective until the player takes the payout. That is also what makes the strip
 * a CLAIM button at the end of every step rather than a silent hand-off.
 *
 * A NARROW READ, not getQuestBoard: this runs on the /tutorial probe, and the
 * board builds a per-quest progress query for all ~56 live rows.
 */
export async function getOnboardingStep(
  db: DbOrTx, wallet: string, baseId?: string,
): Promise<OnboardingStepDto | null> {
  await reconcileOnboardingFacts(db, wallet, baseId);
  const rows = await db.select().from(quests)
    .where(and(eq(quests.scope, 'onboarding'), eq(quests.activeOn, ONBOARDING_ACTIVE_ON)));
  const byCode = new Map(rows.map((q) => [q.templateCode, q]));
  for (const t of QUESTS.onboardingTemplates) {
    const q = byCode.get(t.id);
    if (!q) continue;
    const [p] = baseId
      ? await db.select().from(baseQuestProgress)
        .where(and(eq(baseQuestProgress.questId, q.id), eq(baseQuestProgress.baseId, baseId)))
      : await db.select().from(questProgress)
        .where(and(eq(questProgress.questId, q.id), eq(questProgress.playerWallet, wallet)));
    if (p?.claimedAt != null) continue;
    return {
      questId: q.id,
      templateCode: q.templateCode,
      target: q.target,
      rewardShards: Number(q.rewardKeep),
      progress: p?.progress ?? 0,
      completed: p?.completedAt != null,
      claimed: false,
    };
  }
  return null;
}

export async function claimQuest(
  db: Db,
  wallet: string,
  questId: string,
  at = new Date(),
  baseContext?: StableBaseMutationContext,
) {
  if (multiBaseEnabled()) {
    const context = requireStableBaseMutationContext(baseContext);
    return db.transaction(async (tx) => {
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found');
      const base = await lockStablePrerequisiteBase(tx, wallet, context);
      const [q] = await tx.select().from(quests).where(eq(quests.id, questId));
      if (!q) throw new HttpError(404, 'quest not found');
      const [p] = await tx.select().from(baseQuestProgress)
        .where(and(eq(baseQuestProgress.questId, questId), eq(baseQuestProgress.baseId, base.id)))
        .for('update');
      if (!p?.completedAt) throw new HttpError(422, 'quest not completed');
      if (p.claimedAt) throw new HttpError(422, 'already claimed');

      await tx.update(baseQuestProgress).set({ claimedAt: at })
        .where(and(eq(baseQuestProgress.questId, questId), eq(baseQuestProgress.baseId, base.id)));
      await rewardBaseShards(tx, base.id, q.rewardKeep, 'quest.reward',
        `quest:${questId}:${base.id}`, { templateCode: q.templateCode, ownerWallet: wallet });

      let bonusPaid = false;
      if (q.scope === 'daily') {
        const dailies = await tx.select().from(quests)
          .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, q.activeOn)));
        let claimedCount = 0;
        for (const daily of dailies) {
          const [claimed] = await tx.select({ id: baseQuestProgress.id }).from(baseQuestProgress)
            .where(and(
              eq(baseQuestProgress.questId, daily.id),
              eq(baseQuestProgress.baseId, base.id),
              isNotNull(baseQuestProgress.claimedAt),
            ));
          if (claimed) claimedCount++;
        }
        // Bonus fires on EXACTLY the trigger-count claim: the idempotency key
        // pays at most once anyway, but `bonusPaid` must not report a phantom
        // payout on every claim past the third (owner 2026-08-16 all-live board).
        if (claimedCount === QUESTS.dailyBonusAt) {
          await rewardBaseShards(tx, base.id, BigInt(QUESTS.allThreeBonusShards),
            'quest.all_three_bonus', `quest-bonus:${q.activeOn}:${base.id}`);
          bonusPaid = true;
        }
      }
      return { reward: Number(q.rewardKeep), bonusPaid };
    });
  }
  const [q] = await db.select().from(quests).where(eq(quests.id, questId));
  if (!q) throw new HttpError(404, 'quest not found');
  const [p] = await db.select().from(questProgress)
    .where(and(eq(questProgress.questId, questId), eq(questProgress.playerWallet, wallet)));
  if (!p?.completedAt) throw new HttpError(422, 'quest not completed');
  if (p.claimedAt) throw new HttpError(422, 'already claimed');

  await db.update(questProgress).set({ claimedAt: at })
    .where(and(eq(questProgress.questId, questId), eq(questProgress.playerWallet, wallet)));
  // SHARDS, from shard_genesis (2026-08-09). The idempotency key SHAPE is
  // unchanged on purpose: a claim that was already paid in the KEEP era keeps its
  // row, so a re-post is still a no-op — and `claimedAt` above makes a second claim
  // unreachable anyway, so there is no window where the change could double-pay.
  await rewardShards(db, wallet, q.rewardKeep, 'quest.reward',
    `quest:${questId}:${wallet}`, { templateCode: q.templateCode });

  // All-three bonus: pays exactly once, with the third claimed daily (GDD §5).
  let bonusPaid = false;
  if (q.scope === 'daily') {
    const day = q.activeOn;
    const dailies = await db.select().from(quests)
      .where(and(eq(quests.scope, 'daily'), eq(quests.activeOn, day)));
    let claimedCount = 0;
    for (const d of dailies) {
      const [dp] = await db.select().from(questProgress).where(and(
        eq(questProgress.questId, d.id),
        eq(questProgress.playerWallet, wallet),
        isNotNull(questProgress.claimedAt),
      ));
      if (dp) claimedCount++;
    }
    // Exactly-at-trigger, same reasoning as the stable-base path above.
    if (claimedCount === QUESTS.dailyBonusAt) {
      await rewardShards(db, wallet, BigInt(QUESTS.allThreeBonusShards),
        'quest.all_three_bonus', `quest-bonus:${day}:${wallet}`);
      bonusPaid = true;
    }
  }
  return { reward: Number(q.rewardKeep), bonusPaid };
}
