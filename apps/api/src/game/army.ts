/**
 * Army: training queue + camp-held roster + Forge research (PLAN.md 4d
 * prerequisite — GDD §3.2, Addendum B1/B6).
 *
 * Rules enforced:
 * - The Barracks TRAINS (queue capacity 10/15/20 pts by its level, per
 *   barracks, summed); the Camp HOLDS (capacity 20/35/50 pts by level, camps
 *   stack). Queued + held points can never exceed camp capacity.
 * - Training costs deed-owned SHARDS up front; units complete lazily into that
 *   deed's camp. Paid timer FINISH remains a wallet KEEP sink.
 * - Research at the Forge: troop level ≤ Forge level, one research at a time,
 *   deed-owned SHARD cost level×400, does NOT occupy a builder (Addendum B1).
 */
import { randomUUID } from 'node:crypto';
import {
  NEW_ATTACKER_TROOPS,
  NEW_ROSTER_ENABLED,
  isDarkAttackerTroop,
  speedupCostKeep,
  STRUCTURES,
  TROOPS,
  TROOP_LEVELING,
  TROOP_TYPES,
  RESEARCH_CANCELLATION,
  TRAINING_CANCELLATION,
  TRAINING_SCHEDULE,
  TRAINING_FIRST_FINISH,
  type TrainingFreeFinishOffer,
  type TrainingFreeFinishReceipt,
  type TrainingScheduleConsent,
  type TrainingFinishAllConsent,
  isTrainableTroop,
  type TrainingComposition,
  type TrainingQuote,
  type TrainingBatchResult,
  type TroopStats,
  type TroopType,
} from '@shardkeep/shared';
import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  army, armyTrainingBatches, baseArmy, bases, baseTrainingQueue, baseTroopResearch, buildings,
  ledgerEntries, ledgerTransactions, players, trainingQueue, troopResearch,
} from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import {
  assertResearchEpisode, assertResearchLevel, assertResearchPrice,
  type ResearchEpisodeConsent, type ResearchFinishConsent, type ResearchStartConsent,
} from './researchConsent';
import { researchSpeedupIntent, replayResearchSpeedup } from './researchReceipt';
import { trainingFinishIntent, trainingFinishResult, replayTrainingFinish, assertTrainingFinishScope } from './trainingFinishReceipt';
import { validateTrainingComposition } from './armyPresets';
import { assertTrainingBatchOpen } from './trainingRecovery';
import { laneTail, queueConsent, queueConsentMatches, repackTrainingLane, requireFinishConsent, requireScheduleConsent, trainingRows, unitDurations } from './trainingSchedule';
import { getOnboardingStep, progressQuestBatch } from './quests';
import { onboardingTrainingFinishes, onboardingTrainingWallets } from '../db/onboardingTrainingSchema';
import { assertEliteTroopUnlocked, eliteUnlocksOf } from './troopUnlocks';
import { spendGameCurrency, spendShards } from './spend';
import { getBaseShardBalance, spendBaseShards } from './baseEconomy';
import { bootstrapSystemAccounts, getOrCreateBaseAccount, getOrCreatePlayerAccount, postTransaction } from '../ledger';
import {
  lockStablePrerequisiteBase,
  requireActiveStablePrerequisiteBase,
  requireStableBaseMutationContext,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';

const troopStatsOf = (raw: string): TroopStats | undefined =>
  Object.prototype.hasOwnProperty.call(TROOPS, raw)
    ? TROOPS[raw as TroopType]
    : undefined;

export function darkAttackerRosterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['DARK_ATTACKER_ROSTER_ENABLED'] === 'true';
}

function requireActiveTroop(type: TroopType): void {
  if (isDarkAttackerTroop(type) && !darkAttackerRosterEnabled()) {
    throw new HttpError(409, 'this troop is coming soon', 'TROOP_ROSTER_INACTIVE');
  }
}

async function unsupportedOwnedTroops(
  db: DbOrTx, wallet: string, baseId?: string,
): Promise<string[]> {
  const [held, queued] = baseId
    ? await Promise.all([
      db.select({ troop: baseArmy.troop }).from(baseArmy).where(eq(baseArmy.baseId, baseId)),
      db.select({ troop: baseTrainingQueue.troop }).from(baseTrainingQueue).where(and(
        eq(baseTrainingQueue.baseId, baseId), isNull(baseTrainingQueue.completedAt),
      )),
    ])
    : await Promise.all([
      db.select({ troop: army.troop }).from(army).where(eq(army.playerWallet, wallet)),
      db.select({ troop: trainingQueue.troop }).from(trainingQueue).where(and(
        eq(trainingQueue.playerWallet, wallet), isNull(trainingQueue.completedAt),
      )),
    ]);
  return [...new Set([...held, ...queued].map((r) => String(r.troop))
    .filter((troop) => !troopStatsOf(troop)))].sort();
}

// ---------------------------------------------------------------------------
// Capacity helpers
// ---------------------------------------------------------------------------

async function completedBuildingsOf(
  db: DbOrTx,
  wallet: string,
  type: 'barracks' | 'camp' | 'forge',
  baseId?: string,
) {
  // A building is "completed" when no unfinished build job references it; for
  // capacity purposes alpha treats all rows as live once their 60s–1h build
  // job completes — the join below excludes under-construction rows.
  const rows = await db.execute(sql`
    SELECT b.id, b.level FROM buildings b
    WHERE ${baseId === undefined ? sql`b.player_wallet = ${wallet}` : sql`b.base_id = ${baseId}`} AND b.type = ${type}
      AND NOT EXISTS (
        SELECT 1 FROM builder_jobs j
        WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
      )
  `);
  return rows as unknown as Array<{ id: string; level: number }>;
}

export async function campCapacityPts(db: DbOrTx, wallet: string, baseId?: string): Promise<number> {
  const camps = await completedBuildingsOf(db, wallet, 'camp', baseId);
  return camps.reduce((s, c) => s + (STRUCTURES.camp.capacityPts[c.level - 1] ?? 0), 0);
}

export async function barracksQueuePts(db: DbOrTx, wallet: string, baseId?: string): Promise<number> {
  const rows = await completedBuildingsOf(db, wallet, 'barracks', baseId);
  return rows.reduce((s, b) => s + (STRUCTURES.barracks.queuePts[b.level - 1] ?? 0), 0);
}

export async function rosterPts(db: DbOrTx, wallet: string, baseId?: string): Promise<number> {
  const rows = baseId
    ? await db.select().from(baseArmy).where(eq(baseArmy.baseId, baseId))
    : await db.select().from(army).where(eq(army.playerWallet, wallet));
  return rows.reduce((s, r) => s + (troopStatsOf(String(r.troop))?.pts ?? 0) * r.count, 0);
}

async function queuedPts(db: DbOrTx, wallet: string, baseId?: string): Promise<number> {
  const rows = baseId
    ? await db.select().from(baseTrainingQueue).where(and(
      eq(baseTrainingQueue.baseId, baseId), isNull(baseTrainingQueue.completedAt),
    ))
    : await db.select().from(trainingQueue).where(and(
      eq(trainingQueue.playerWallet, wallet), isNull(trainingQueue.completedAt),
    ));
  return rows.reduce((s, r) => s + (troopStatsOf(String(r.troop))?.pts ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Lazy completion
// ---------------------------------------------------------------------------

type TrainingEconomyRow = {
  id: string;
  troop: string;
  finishesAt: Date;
  completedAt: Date | null;
  economyVersion: number;
  paidShardCost: bigint | null;
  questCreditedAt: Date | null;
};

/** V2 training earns both TRAIN and SHARD-SPEND quest credit only when the
 * paid unit actually reaches camp. The caller owns the queue-row claim and an
 * outer transaction, so the troop, quest ticks and marker commit together.
 * Quest rotation follows the unit's effective ready event: a naturally due
 * unit belongs to finishesAt even if lazy settlement happens after midnight;
 * a paid speed-up belongs to its earlier completedAt. questCreditedAt remains
 * the processing/audit timestamp and can therefore be later. */
async function creditCompletedTrainingQuests(
  db: DbOrTx,
  wallet: string,
  row: TrainingEconomyRow,
  processedAt: Date,
  baseId?: string,
): Promise<void> {
  if (row.economyVersion !== 2 || row.questCreditedAt !== null) return;
  if (row.paidShardCost === null || row.paidShardCost <= 0n) {
    throw new HttpError(409, 'training economy receipt is incomplete', 'TRAINING_RECEIPT_INVALID');
  }
  const stats = troopStatsOf(row.troop);
  // A rolling newer binary may have queued a troop this rollback binary does
  // not know. Completion/read must remain available; leave its marker NULL so
  // a binary that knows the troop can reconcile the quest exactly once later.
  if (!stats) return;
  const spend = Number(row.paidShardCost);
  if (!Number.isSafeInteger(spend)) {
    throw new HttpError(409, 'training economy receipt is outside the supported range', 'TRAINING_RECEIPT_INVALID');
  }
  if (!row.completedAt) {
    throw new HttpError(409, 'completed training receipt has no completion time', 'TRAINING_RECEIPT_INVALID');
  }
  const readyAt = row.completedAt < row.finishesAt ? row.completedAt : row.finishesAt;
  await progressQuestBatch(db, wallet, [
    ['train_5_troops', 1],
    ['train_20_points', stats.pts],
    ['first_troops', stats.pts],
    ['train_100_points', stats.pts],
    ...(row.troop === 'turrider' ? [['train_tur_rider', 1] as const] : []),
    ['spend_200', spend],
    ['spend_500', spend],
  ], readyAt, baseId);
  if (baseId) {
    await db.update(baseTrainingQueue).set({ questCreditedAt: processedAt }).where(and(
      eq(baseTrainingQueue.id, row.id),
      isNull(baseTrainingQueue.questCreditedAt),
      isNull(baseTrainingQueue.cancelledAt),
      isNotNull(baseTrainingQueue.completedAt),
    ));
  } else {
    await db.update(trainingQueue).set({ questCreditedAt: processedAt }).where(and(
      eq(trainingQueue.id, row.id),
      isNull(trainingQueue.questCreditedAt),
      isNull(trainingQueue.cancelledAt),
      isNotNull(trainingQueue.completedAt),
    ));
  }
}

async function completeDueLegacyTraining(db: DbOrTx, wallet: string, now: Date): Promise<void> {
  const due = await db.select().from(trainingQueue).where(and(
    eq(trainingQueue.playerWallet, wallet),
    isNull(trainingQueue.completedAt),
    lte(trainingQueue.finishesAt, now),
  ));
  for (const unit of due) {
    await db.transaction(async (tx) => {
      await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      const claimed = await tx.update(trainingQueue)
        .set({ completedAt: now })
        .where(and(eq(trainingQueue.id, unit.id), isNull(trainingQueue.completedAt)))
        .returning({
          id: trainingQueue.id,
          troop: trainingQueue.troop,
          finishesAt: trainingQueue.finishesAt,
          completedAt: trainingQueue.completedAt,
          economyVersion: trainingQueue.economyVersion,
          paidShardCost: trainingQueue.paidShardCost,
          questCreditedAt: trainingQueue.questCreditedAt,
        });
      if (claimed.length === 0) return;
      await tx.insert(army)
        .values({ playerWallet: wallet, troop: unit.troop, count: 1 })
        .onConflictDoUpdate({
          target: [army.playerWallet, army.troop],
          set: { count: sql`${army.count} + 1` },
        });
      await creditCompletedTrainingQuests(tx, wallet, claimed[0]!, now);
    });
  }
  // Rolling rollback fence: an old binary can complete a pending v2 row but
  // cannot know the new completion-time quest marker. Reconcile it under the
  // same wallet lock, exactly once; cancelled rows are excluded permanently.
  await db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    const uncredited = await tx.select().from(trainingQueue).where(and(
      eq(trainingQueue.playerWallet, wallet),
      eq(trainingQueue.economyVersion, 2),
      isNotNull(trainingQueue.completedAt),
      isNull(trainingQueue.cancelledAt),
      isNull(trainingQueue.questCreditedAt),
    ));
    for (const row of uncredited) await creditCompletedTrainingQuests(tx, wallet, row, now);
  });
  // Research completion
  const research = await db.select().from(troopResearch).where(and(
    eq(troopResearch.playerWallet, wallet),
  ));
  for (const r of research) {
    if (r.researchingToLevel && r.finishesAt && r.finishesAt <= now) {
      const toLevel = r.researchingToLevel;
      const finishesAt = r.finishesAt;
      // Claim predicate mirrors the training-queue half above (security review
      // 2026-08-03 finding 2): without pinning the row to the EXACT research we
      // read, two concurrent completions can interleave with a fresh
      // researchTroop() and the stale update wipes a research the player just
      // PAID for. A same-troop restart can reuse the target and even deadline;
      // bind both the original deadline and debit receipt (including legacy null).
      await db.transaction(async (tx) => {
        await tx.select({ wallet: players.wallet }).from(players)
          .where(eq(players.wallet, wallet)).for('update');
        const landed = await tx.update(troopResearch)
          .set({ level: toLevel, researchingToLevel: null, finishesAt: null })
          .where(and(
            eq(troopResearch.playerWallet, wallet),
            eq(troopResearch.troop, r.troop),
            eq(troopResearch.researchingToLevel, toLevel),
            eq(troopResearch.finishesAt, finishesAt),
            r.debitLedgerTxnId === null
              ? isNull(troopResearch.debitLedgerTxnId)
              : eq(troopResearch.debitLedgerTxnId, r.debitLedgerTxnId),
          ))
          .returning({ paidShardCost: troopResearch.paidShardCost });
        if (landed[0]) await creditCompletedResearchQuests(tx, wallet, landed[0], finishesAt);
      });
    }
  }
}

/** SHARD-spend quest credit for a landed receipt-carrying research — the
 * research twin of creditCompletedTrainingQuests. Credited only when the level
 * lands (natural or paid FINISH), inside the claim that lands it, so a
 * start → cancel → refund loop cannot farm spend quests. A row without a
 * receipt predates cancellable research and was credited at start. */
async function creditCompletedResearchQuests(
  db: DbOrTx,
  wallet: string,
  row: { paidShardCost: bigint | null },
  readyAt: Date,
  baseId?: string,
): Promise<void> {
  if (row.paidShardCost === null) return;
  const spend = Number(row.paidShardCost);
  if (!Number.isSafeInteger(spend)) {
    throw new HttpError(409, 'research receipt is outside the supported range', 'RESEARCH_RECEIPT_INVALID');
  }
  await progressQuestBatch(db, wallet, [['spend_200', spend], ['spend_500', spend]], readyAt, baseId);
}

/** Complete deed-owned timers while the caller holds the selected base row.
 * Both natural completion and paid FINISH use this same transition, so a unit
 * can never be credited to a wallet or to a sibling deed by accident. */
async function completeDueBaseTrainingLocked(
  db: DbOrTx, wallet: string, baseId: string, now: Date,
): Promise<void> {
  const due = await db.select().from(baseTrainingQueue).where(and(
    eq(baseTrainingQueue.baseId, baseId),
    isNull(baseTrainingQueue.completedAt),
    lte(baseTrainingQueue.finishesAt, now),
  ));
  for (const unit of due) {
    const claimed = await db.update(baseTrainingQueue)
      .set({ completedAt: now })
      .where(and(
        eq(baseTrainingQueue.id, unit.id),
        eq(baseTrainingQueue.baseId, baseId),
        isNull(baseTrainingQueue.completedAt),
      ))
      .returning({
        id: baseTrainingQueue.id,
        troop: baseTrainingQueue.troop,
        finishesAt: baseTrainingQueue.finishesAt,
        completedAt: baseTrainingQueue.completedAt,
        economyVersion: baseTrainingQueue.economyVersion,
        paidShardCost: baseTrainingQueue.paidShardCost,
        questCreditedAt: baseTrainingQueue.questCreditedAt,
      });
    if (claimed.length === 0) continue;
    await db.insert(baseArmy)
      .values({ baseId, troop: unit.troop, count: 1 })
      .onConflictDoUpdate({
        target: [baseArmy.baseId, baseArmy.troop],
        set: { count: sql`${baseArmy.count} + 1` },
      });
    await creditCompletedTrainingQuests(db, wallet, claimed[0]!, now, baseId);
  }

  const uncredited = await db.select().from(baseTrainingQueue).where(and(
    eq(baseTrainingQueue.baseId, baseId),
    eq(baseTrainingQueue.economyVersion, 2),
    isNotNull(baseTrainingQueue.completedAt),
    isNull(baseTrainingQueue.cancelledAt),
    isNull(baseTrainingQueue.questCreditedAt),
  ));
  for (const row of uncredited) {
    await creditCompletedTrainingQuests(db, wallet, row, now, baseId);
  }

  const research = await db.select().from(baseTroopResearch)
    .where(eq(baseTroopResearch.baseId, baseId));
  for (const row of research) {
    if (!row.researchingToLevel || !row.finishesAt || row.finishesAt > now) continue;
    const landed = await db.update(baseTroopResearch)
      .set({ level: row.researchingToLevel, researchingToLevel: null, finishesAt: null })
      .where(and(
        eq(baseTroopResearch.baseId, baseId),
        eq(baseTroopResearch.troop, row.troop),
        eq(baseTroopResearch.researchingToLevel, row.researchingToLevel),
      ))
      .returning({ paidShardCost: baseTroopResearch.paidShardCost });
    if (landed[0]) await creditCompletedResearchQuests(db, wallet, landed[0], row.finishesAt, baseId);
  }
}

/** Lazy timer settlement. In stable mode a base id is mandatory and completion
 * is serialized by the deed row; ownership is rechecked under that lock. */
export async function completeDueTraining(
  db: Db, wallet: string, now = new Date(), baseId?: string,
): Promise<void> {
  if (!multiBaseEnabled()) return completeDueLegacyTraining(db, wallet, now);
  if (!baseId) throw new HttpError(409, 'baseId is required while multi-base is active', 'BASE_ID_REQUIRED');
  await db.transaction(async (tx) => {
    const [base] = await tx.select({ id: bases.id }).from(bases).where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    )).for('update');
    if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
    await requireActiveStablePrerequisiteBase(tx, wallet, baseId);
    await completeDueBaseTrainingLocked(tx, wallet, baseId, now);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function buildArmyState(
  roster: Array<{ troop: string; count: number }>,
  queue: Array<{
    id: string; troop: string; startedAt: Date; finishesAt: Date; scheduleVersion: number;
    economyVersion: number; paidShardCost: bigint | null; debitLedgerTxnId: string | null;
  }>,
  research: Array<{
    troop: string; level: number; researchingToLevel: number | null; finishesAt: Date | null;
    paidShardCost: bigint | null; debitLedgerTxnId: string | null;
  }>,
  campCap: number,
  queueCap: number,
  eliteUnlocks: Record<string, boolean>,
  now: Date,
) {
  const counts = Object.fromEntries(TROOP_TYPES.map((t) => [t, 0])) as Record<TroopType, number>;
  for (const r of roster) {
    if (troopStatsOf(String(r.troop))) counts[r.troop as TroopType] = r.count;
  }
  const levels = Object.fromEntries(TROOP_TYPES.map((t) => [t, 1])) as Record<TroopType, number>;
  for (const r of research) {
    if (troopStatsOf(String(r.troop))) levels[r.troop as TroopType] = r.level;
  }
  const unsupportedTroops = [...new Set([...roster, ...queue, ...research]
    .map((r) => String(r.troop)).filter((troop) => !troopStatsOf(troop)))].sort();
  const darkRosterEnabled = darkAttackerRosterEnabled();
  return {
    counts,
    levels,
    research: research.filter((r) => r.researchingToLevel && troopStatsOf(String(r.troop))).map((r) => ({
      troop: r.troop, toLevel: r.researchingToLevel, finishesAt: r.finishesAt,
      episodeId: r.debitLedgerTxnId,
      // Payment consent uses the server's clock and original episode. A missing
      // deadline is not permission for a client to invent a minimum-price quote.
      finishQuote: r.finishesAt && r.finishesAt.getTime() > now.getTime()
        && r.level >= 1 && r.researchingToLevel === r.level + 1
        && r.researchingToLevel <= TROOP_LEVELING.maxLevel ? {
          currentLevel: r.level, toLevel: r.researchingToLevel,
          finishesAt: r.finishesAt.toISOString(), episodeId: r.debitLedgerTxnId,
          maxCostKeep: String(speedupCostKeep(Math.ceil((r.finishesAt.getTime() - now.getTime()) / 1000))),
        } satisfies ResearchFinishConsent : null,
      // Server verdict on the CANCEL control: a pre-receipt research hides it.
      canCancel: r.paidShardCost !== null && r.paidShardCost > 0n && r.debitLedgerTxnId !== null,
      refundShards: r.paidShardCost !== null ? r.paidShardCost.toString() : null,
    })),
    queue: queue.filter((q) => troopStatsOf(String(q.troop))).map((q) => ({
      id: q.id, troop: q.troop, startedAt: q.startedAt, finishesAt: q.finishesAt, scheduleVersion: q.scheduleVersion,
      canCancel: q.economyVersion === 2 && q.paidShardCost !== null
        && q.paidShardCost > 0n && q.debitLedgerTxnId !== null,
      refundShards: q.economyVersion === 2 && q.paidShardCost !== null
        ? q.paidShardCost.toString()
        : null,
    })),
    rosterPts: roster.reduce((s, r) => s + (troopStatsOf(String(r.troop))?.pts ?? 0) * r.count, 0),
    queuedPts: queue.reduce((s, r) => s + (troopStatsOf(String(r.troop))?.pts ?? 0), 0),
    campCapacityPts: campCap,
    barracksQueuePts: queueCap,
    unsupportedTroops,
    // D-058: which elite (item-gated) troops THIS WALLET may train. The client
    // renders lock badges from this server verdict, never from local guesses.
    eliteUnlocks,
    finishAllQuote: {
      version: TRAINING_SCHEDULE.version, queue: queueConsent(queue),
      maxCostKeep: String(queue.length ? speedupCostKeep(Math.ceil((laneTail(queue, now) - now.getTime()) / 1000)) : 0),
    } satisfies TrainingFinishAllConsent,
    features: {
      trainingScheduling: { version: TRAINING_SCHEDULE.version, mode: 'sequential' as const, lanes: TRAINING_SCHEDULE.lanesPerBase, consentRequired: true },
      researchConsent: { version: 1 },
      researchSpeedupReceipts: { version: 1 },
      trainingFinishReceipts: { version: 1 },
      darkAttackerRoster: {
        enabled: darkRosterEnabled,
        code: darkRosterEnabled ? 'active' : 'coming_soon',
        message: darkRosterEnabled ? 'AVAILABLE' : 'COMING SOON',
      },
    },
  };
}

/** Explicit deed-native read for raid snapshot consumers. */
export async function getBaseArmyState(
  db: DbOrTx, wallet: string, baseId: string, now = new Date(),
) {
  return db.transaction(async (tx) => {
    const [base] = await tx.select({ id: bases.id }).from(bases).where(and(
      eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
    )).for('update');
    if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
    await requireActiveStablePrerequisiteBase(tx, wallet, baseId);
    await completeDueBaseTrainingLocked(tx, wallet, baseId, now);
    const [roster, queue, research, campCap, queueCap, eliteUnlocks] = await Promise.all([
      tx.select().from(baseArmy).where(eq(baseArmy.baseId, baseId)),
      tx.select().from(baseTrainingQueue).where(and(
        eq(baseTrainingQueue.baseId, baseId), isNull(baseTrainingQueue.completedAt),
      )).orderBy(baseTrainingQueue.finishesAt),
      tx.select().from(baseTroopResearch).where(eq(baseTroopResearch.baseId, baseId)),
      campCapacityPts(tx, wallet, baseId),
      barracksQueuePts(tx, wallet, baseId),
      eliteUnlocksOf(tx, wallet),
    ]);
    const state = await buildArmyState(roster, queue, research, campCap, queueCap, eliteUnlocks, now);
    return { ...state, ...await freeTrainingState(tx, wallet, baseId, state.finishAllQuote) };
  });
}

export async function getArmyState(db: DbOrTx, wallet: string, now = new Date(), baseId?: string) {
  if (multiBaseEnabled()) {
    if (!baseId) throw new HttpError(409, 'baseId is required while multi-base is active', 'BASE_ID_REQUIRED');
    return getBaseArmyState(db, wallet, baseId, now);
  }
  await completeDueLegacyTraining(db, wallet, now);
  const [roster, queue, research, campCap, queueCap, eliteUnlocks] = await Promise.all([
    db.select().from(army).where(eq(army.playerWallet, wallet)),
    db.select().from(trainingQueue).where(and(
      eq(trainingQueue.playerWallet, wallet), isNull(trainingQueue.completedAt),
    )).orderBy(trainingQueue.finishesAt),
    db.select().from(troopResearch).where(eq(troopResearch.playerWallet, wallet)),
    campCapacityPts(db, wallet),
    barracksQueuePts(db, wallet),
    eliteUnlocksOf(db, wallet),
  ]);
  const state = await buildArmyState(roster, queue, research, campCap, queueCap, eliteUnlocks, now);
  return { ...state, ...await freeTrainingState(db, wallet, undefined, state.finishAllQuote) };
}

/** The offer is advisory; the mutation repeats eligibility under the wallet,
 * base and completion-latch locks. Canonical quest completion never renews when
 * a player acquires another deed or resumes an old guide. */
async function freeTrainingState(db: DbOrTx, wallet: string, baseId: string | undefined, consent: TrainingFinishAllConsent) {
  const [receipt] = await db.select().from(onboardingTrainingFinishes).where(eq(onboardingTrainingFinishes.wallet, wallet));
  const freeFinishAllReceipt: TrainingFreeFinishReceipt | null = receipt
    ? { idempotencyKey: receipt.idempotencyKey, baseId: receipt.baseId, consent: receipt.consent, completed: receipt.completed } : null;
  const [latch] = await db.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, wallet));
  const freeFinishAllReviewRequired = !receipt && !latch?.completedAt && !!latch?.reviewEvidence;
  let freeFinishAllOffer: TrainingFreeFinishOffer | null = null;
  if (!receipt && !latch?.completedAt && !freeFinishAllReviewRequired && consent.queue.length > 0) {
    const step = await getOnboardingStep(db, wallet, baseId);
    if (step?.templateCode === TRAINING_FIRST_FINISH.offer && !step.completed) {
      freeFinishAllOffer = { offer: TRAINING_FIRST_FINISH.offer, consent: { ...consent, maxCostKeep: '0' } };
    }
  }
  return { freeFinishAllOffer, freeFinishAllReceipt, freeFinishAllReviewRequired };
}

async function replayFreeFinish(tx: DbTx, wallet: string, key: string, baseId: string | undefined, consent: TrainingFinishAllConsent) {
  const [receipt] = await tx.select().from(onboardingTrainingFinishes).where(eq(onboardingTrainingFinishes.wallet, wallet));
  if (!receipt) return null;
  if (receipt.idempotencyKey !== key) throw new HttpError(409, 'Your free training finish has already been used.', 'TRAINING_FREE_FINISH_UNAVAILABLE');
  if (receipt.baseId !== (baseId ?? null) || JSON.stringify(requireFinishConsent(receipt.consent)) !== JSON.stringify(consent)) {
    throw new HttpError(409, 'This free finish request belongs to a different queue.', 'TRAINING_FREE_FINISH_MISMATCH');
  }
  return { cost: 0n, completed: receipt.completed };
}

async function authorizeFreeFinish(tx: DbTx, wallet: string, baseId: string | undefined, consent: TrainingFinishAllConsent) {
  await tx.insert(onboardingTrainingWallets).values({ wallet }).onConflictDoNothing();
  const [latch] = await tx.select().from(onboardingTrainingWallets).where(eq(onboardingTrainingWallets.wallet, wallet)).for('update');
  if (consent.maxCostKeep !== '0' || latch?.completedAt) {
    throw new HttpError(409, 'Your free training finish is no longer available. Refresh your army.', 'TRAINING_FREE_FINISH_UNAVAILABLE');
  }
  if (latch?.reviewEvidence) {
    throw new HttpError(409, 'Your free finish eligibility needs historical verification. Troops still train normally.', 'TRAINING_FREE_FINISH_REVIEW_REQUIRED');
  }
  const step = await getOnboardingStep(tx, wallet, baseId);
  if (step?.templateCode !== TRAINING_FIRST_FINISH.offer || step.completed) {
    throw new HttpError(409, 'The free finish is available only during your first-army objective.', 'TRAINING_FREE_FINISH_UNAVAILABLE');
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Caller holds the wallet/base locks and has checked current eligibility and
 * capacity. Every unit retains its existing two-entry debit and queue receipt,
 * so cancellation is still the exact inverse of that individual purchase. */
async function enqueueTrainingUnit(
  tx: DbTx, wallet: string, troop: TroopType, idempotencyKey: string, now: Date, selectedBaseId?: string,
): Promise<{ id: string; finishesAt: Date }> {
  const stats = TROOPS[troop];
  // Namespaced + duplicate-gated (security review 2026-07-24 #5): a reused key
  // charges nothing, so it must never queue a free troop.
  const queueId = randomUUID();
  const paidShardCost = BigInt(stats.costKeep);
  const debitMetadata = {
    wallet,
    troop,
    queueId,
    costShards: stats.costKeep,
    economyVersion: 2,
  };
  const posted = selectedBaseId
    ? await spendBaseShards(
      tx, selectedBaseId, paidShardCost, 'army.train',
      `train:${selectedBaseId}:${idempotencyKey}`, debitMetadata,
      { progressQuests: false },
    )
    : await spendShards(
      tx, wallet, paidShardCost, 'army.train',
      `train:${wallet}:${idempotencyKey}`, debitMetadata,
      { progressQuests: false },
    );
  if (posted.duplicate) throw new HttpError(409, 'duplicate train request — refresh the barracks');
  const startedAt = new Date(laneTail(await trainingRows(tx, wallet, selectedBaseId), now));
  const finishesAt = new Date(startedAt.getTime() + Math.round(stats.trainSec * 1000));
  const [row] = selectedBaseId
    ? await tx.insert(baseTrainingQueue).values({
      id: queueId, baseId: selectedBaseId, troop, startedAt, finishesAt, scheduleVersion: TRAINING_SCHEDULE.version,
      economyVersion: 2, paidShardCost, debitLedgerTxnId: posted.transaction.id,
      questCreditedAt: null,
    }).returning({ id: baseTrainingQueue.id, finishesAt: baseTrainingQueue.finishesAt })
    : await tx.insert(trainingQueue).values({
      id: queueId, playerWallet: wallet, troop, startedAt, finishesAt, scheduleVersion: TRAINING_SCHEDULE.version,
      economyVersion: 2, paidShardCost, debitLedgerTxnId: posted.transaction.id,
      questCreditedAt: null,
    }).returning({ id: trainingQueue.id, finishesAt: trainingQueue.finishesAt });
  return { id: row!.id, finishesAt: row!.finishesAt };
}

export async function trainTroop(
  db: Db, wallet: string, troop: TroopType, idempotencyKey: string, now = new Date(),
  baseContext?: StableBaseMutationContext, consent?: TrainingScheduleConsent, confirmedCostShards?: string,
): Promise<{ id: string; finishesAt: Date }> {
  const stats = troopStatsOf(troop);
  if (!stats) throw new HttpError(422, `unknown troop: ${troop}`);
  // Spawn products are typed for replay persistence but are never player-owned.
  if (!isTrainableTroop(troop)) {
    throw new HttpError(422, stats.defenderOnly ? 'that unit is defender-only' : 'that unit is spawn-only');
  }
  requireActiveTroop(troop);
  if (!NEW_ROSTER_ENABLED && (NEW_ATTACKER_TROOPS as readonly string[]).includes(troop)) {
    throw new HttpError(422, 'this troop is coming soon');
  }
  const stableContext = multiBaseEnabled()
    ? requireStableBaseMutationContext(baseContext)
    : undefined;
  if (!stableContext) await completeDueLegacyTraining(db, wallet, now);
  const result = await db.transaction(async (tx) => {
    // Legacy takes one per-wallet lock; stable mode then takes the selected deed
    // lock. Capacity checks,
    // SHARD debit and queue creation are one custodial state transition: no two
    // calls can both admit the final slot, and an INSERT failure rolls back cash.
    const [player] = await tx.select({ keepLevel: players.keepLevel }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const selectedBase = stableContext
      ? await lockStablePrerequisiteBase(tx, wallet, stableContext)
      : undefined;
    const selectedBaseId = selectedBase?.id;
    if (selectedBaseId) await completeDueBaseTrainingLocked(tx, wallet, selectedBaseId, now);
    const keepLevel = selectedBase?.keepLevel ?? player.keepLevel;
    const barracks = await completedBuildingsOf(tx, wallet, 'barracks', selectedBaseId);
    if (barracks.length === 0) throw new HttpError(422, 'build a Barracks first');
    if (stats.requiresKeepLevel !== undefined && keepLevel < stats.requiresKeepLevel) {
      throw new HttpError(422, `requires Keep level ${stats.requiresKeepLevel}`);
    }
    // Elite item gate (D-058, owner 2026-08-16) — inside the wallet lock, before
    // any debit, with the lazy grandfather self-heal for pre-existing armies.
    await assertEliteTroopUnlocked(tx, wallet, troop);
    const unsupported = await unsupportedOwnedTroops(tx, wallet, selectedBaseId);
    if (unsupported.length > 0) {
      throw new HttpError(409, 'army contains troops unsupported by this server; update before training', 'TROOP_ROSTER_UNSUPPORTED');
    }
    const held = await rosterPts(tx, wallet, selectedBaseId);
    const queued = await queuedPts(tx, wallet, selectedBaseId);
    const campCap = await campCapacityPts(tx, wallet, selectedBaseId);
    const queueCap = await barracksQueuePts(tx, wallet, selectedBaseId);
    if (queued + stats.pts > queueCap) throw new HttpError(422, 'training queue is full');
    if (held + queued + stats.pts > campCap) throw new HttpError(422, 'army camps are full');

    const composition = [{ troop, count: 1 }];
    const quote = await trainingQuoteLocked(tx, wallet, composition, keepLevel, now, selectedBaseId);
    await assertScheduleMatches(tx, wallet, selectedBaseId, composition, consent, quote, now);
    if (confirmedCostShards === undefined) throw new HttpError(409, 'confirm the current SHARDS price before training', 'TRAINING_CONSENT_REQUIRED');
    if (confirmedCostShards !== quote.costShards) throw new HttpError(409, 'training price changed; review the refreshed preview', 'TRAINING_QUOTE_CHANGED', { quote });
    const queuedUnit = await enqueueTrainingUnit(tx, wallet, troop, idempotencyKey, now, selectedBaseId);
    if (stableContext && selectedBaseId) await stableContext.assertAuthority(tx, wallet, selectedBaseId);
    return queuedUnit;

  });
  // V2 training and SHARD-spend quests advance only when the unit reaches the
  // camp. Cancellation therefore cannot be farmed for quest progress.
  return result;
}

/** Quote and purchase share one locked view. Stored plans never carry prices,
 * unlocks or capacity; all of those come from the selected base now. */
async function trainingQuoteLocked(
  tx: DbTx, wallet: string, composition: TrainingComposition, keepLevel: number, now: Date, baseId?: string,
): Promise<TrainingQuote> {
  const [barracks, held, queued, campCap, queueCap, unsupported, shardBalance] = await Promise.all([
    completedBuildingsOf(tx, wallet, 'barracks', baseId), rosterPts(tx, wallet, baseId),
    queuedPts(tx, wallet, baseId), campCapacityPts(tx, wallet, baseId), barracksQueuePts(tx, wallet, baseId),
    unsupportedOwnedTroops(tx, wallet, baseId),
    baseId ? getBaseShardBalance(tx, baseId) : getOrCreatePlayerAccount(tx, wallet, 'player_shards').then((a) => a.balance),
  ]);
  if (unsupported.length) throw new HttpError(409, 'army contains unsupported troops; update before training', 'TROOP_ROSTER_UNSUPPORTED');
  let available = shardBalance;
  let addedPts = 0;
  let durationMs = 0;
  const queueable: TrainingComposition = [];
  const remaining: TrainingQuote['remaining'] = [];
  for (const row of composition) {
    const stats: TroopStats = TROOPS[row.troop];
    let reason: string | null = null;
    if (!barracks.length) reason = 'Build a Barracks first';
    else if (isDarkAttackerTroop(row.troop) && !darkAttackerRosterEnabled()) reason = 'Coming soon';
    else if (!NEW_ROSTER_ENABLED && (NEW_ATTACKER_TROOPS as readonly string[]).includes(row.troop)) reason = 'Coming soon';
    else if (stats.requiresKeepLevel !== undefined && keepLevel < stats.requiresKeepLevel) reason = `Requires Keep level ${stats.requiresKeepLevel}`;
    else {
      try { await assertEliteTroopUnlocked(tx, wallet, row.troop); }
      catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'TROOP_ITEM_LOCKED') throw error;
        reason = error.message;
      }
    }
    let count = 0;
    while (!reason && count < row.count) {
      if (queued + addedPts + stats.pts > queueCap) reason = 'Barracks queue is full';
      else if (held + queued + addedPts + stats.pts > campCap) reason = 'Army Camps are full';
      else if (available < BigInt(stats.costKeep)) reason = 'Not enough SHARDS';
      else { count += 1; addedPts += stats.pts; available -= BigInt(stats.costKeep); }
    }
    if (count) {
      queueable.push({ troop: row.troop, count });
      durationMs += Math.round(stats.trainSec * 1000) * count;
    }
    if (count < row.count) remaining.push({ troop: row.troop, count: row.count - count, reason: reason! });
  }
  const activeQueue = await trainingRows(tx, wallet, baseId);
  const startMs = laneTail(activeQueue, now);
  const waitMs = startMs - now.getTime();
  return {
    requested: composition, queueable, remaining, costShards: String(shardBalance - available),
    availableShards: String(shardBalance),
    camp: { used: held + queued, capacity: campCap, after: held + queued + addedPts },
    barracks: { used: queued, capacity: queueCap, after: queued + addedPts },
    completionSec: queueable.length ? (waitMs + durationMs) / 1000 : 0,
    consent: { version: TRAINING_SCHEDULE.version, queue: queueConsent(activeQueue), unitDurations: unitDurations(queueable) },
    schedule: {
      version: TRAINING_SCHEDULE.version, mode: 'sequential', serverNow: now.toISOString(),
      startsAt: new Date(startMs).toISOString(), finishesAt: new Date(startMs + durationMs).toISOString(), waitMs, durationMs,
    },
  };
}

async function assertScheduleMatches(
  tx: DbTx, wallet: string, baseId: string | undefined, composition: TrainingComposition,
  raw: TrainingScheduleConsent | undefined, quote: TrainingQuote, now: Date,
): Promise<void> {
  const consent = requireScheduleConsent(raw);
  const durations = unitDurations(composition);
  if (durations.length !== consent.unitDurations.length
    || durations.some((r, i) => r.troop !== consent.unitDurations[i]?.troop || r.durationMs !== consent.unitDurations[i]?.durationMs)
    || !await queueConsentMatches(tx, wallet, baseId, consent.queue, await trainingRows(tx, wallet, baseId), now)) {
    throw new HttpError(409, 'training schedule changed; review the refreshed preview', 'TRAINING_QUOTE_CHANGED', { quote });
  }
}

async function withTrainingLocks<T>(
  db: Db, wallet: string, now: Date, context: StableBaseMutationContext | undefined,
  work: (tx: DbTx, keepLevel: number, baseId?: string) => Promise<T>,
): Promise<T> {
  const stable = multiBaseEnabled() ? requireStableBaseMutationContext(context) : undefined;
  if (!stable) await completeDueLegacyTraining(db, wallet, now);
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ keepLevel: players.keepLevel }).from(players).where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const base = stable ? await lockStablePrerequisiteBase(tx, wallet, stable) : undefined;
    if (base) await completeDueBaseTrainingLocked(tx, wallet, base.id, now);
    const result = await work(tx, base?.keepLevel ?? player.keepLevel, base?.id);
    // A large accepted batch must not outlive its finalized ownership proof.
    // Failure rolls back the queue, every debit and the idempotency receipt.
    if (stable && base) await stable.assertAuthority(tx, wallet, base.id);
    return result;
  });
}

export async function quoteTraining(
  db: Db, wallet: string, composition: TrainingComposition, now = new Date(), context?: StableBaseMutationContext,
): Promise<TrainingQuote> {
  validateTrainingComposition(composition);
  return withTrainingLocks(db, wallet, now, context, (tx, level, baseId) => trainingQuoteLocked(tx, wallet, composition, level, now, baseId));
}

export async function trainBatch(
  db: Db, wallet: string, composition: TrainingComposition, confirmedCostShards: string,
  idempotencyKey: string, now = new Date(), context?: StableBaseMutationContext, consent?: TrainingScheduleConsent,
): Promise<TrainingBatchResult> {
  validateTrainingComposition(composition);
  if (!/^(0|[1-9][0-9]*)$/.test(confirmedCostShards)) throw new HttpError(422, 'invalid training cost');
  return withTrainingLocks(db, wallet, now, context, async (tx, level, baseId) => {
    const request = { composition, confirmedCostShards };
    const [receipt] = await tx.select().from(armyTrainingBatches).where(and(
      eq(armyTrainingBatches.playerWallet, wallet), eq(armyTrainingBatches.idempotencyKey, idempotencyKey),
    ));
    if (receipt) {
      const stored = receipt.request as typeof request;
      if (receipt.baseId !== (baseId ?? null) || stored.confirmedCostShards !== confirmedCostShards
        || stored.composition.length !== composition.length
        || stored.composition.some((row, index) => row.troop !== composition[index]!.troop || row.count !== composition[index]!.count)) {
        throw new HttpError(409, 'this request key was already used for a different batch', 'TRAINING_BATCH_KEY_REUSED');
      }
      return { ...(receipt.result as TrainingBatchResult), replayed: true };
    }
    await assertTrainingBatchOpen(tx, wallet, idempotencyKey);
    const quote = await trainingQuoteLocked(tx, wallet, composition, level, now, baseId);
    if (quote.remaining.length || quote.costShards !== confirmedCostShards) {
      throw new HttpError(409, 'training conditions changed; review and confirm the refreshed preview', 'TRAINING_QUOTE_CHANGED', { quote });
    }
    await assertScheduleMatches(tx, wallet, baseId, composition, consent, quote, now);
    const batchKey = randomUUID();
    const queue: TrainingBatchResult['queue'] = [];
    for (const row of composition) {
      for (let unit = 0; unit < row.count; unit += 1) {
        const queued = await enqueueTrainingUnit(tx, wallet, row.troop, `batch:${batchKey}:${queue.length}`, now, baseId);
        queue.push({ id: queued.id, troop: row.troop, finishesAt: queued.finishesAt.toISOString() });
      }
    }
    const result: TrainingBatchResult = { queue, costShards: quote.costShards, replayed: false };
    await tx.insert(armyTrainingBatches).values({ playerWallet: wallet, idempotencyKey, baseId: baseId ?? null, request, result });
    return result;
  });
}

type CancelableTrainingRow = TrainingEconomyRow & {
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelIdempotencyKey: string | null;
  debitLedgerTxnId: string | null;
  refundLedgerTxnId: string | null;
};

export interface CancelTrainingResult {
  id: string;
  troop: TroopType;
  refundShards: string;
  cancelledAt: Date;
  replayed: boolean;
}

/** Validate the immutable training debit before creating its exact inverse.
 * Constants are deliberately absent: refunds come only from the queue row's
 * snapshotted cost and linked append-only ledger receipt. */
async function requireTrainingDebit(
  tx: DbOrTx,
  row: CancelableTrainingRow,
  wallet: string,
  baseId?: string,
) {
  if (row.economyVersion !== 2 || row.paidShardCost === null
    || row.paidShardCost <= 0n || row.debitLedgerTxnId === null) {
    throw new HttpError(
      409,
      'this troop was queued before refundable training; it will finish normally',
      'TRAINING_NOT_REFUNDABLE',
    );
  }
  const [debit] = await tx.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.id, row.debitLedgerTxnId));
  const debitEntries = await tx.select().from(ledgerEntries)
    .where(eq(ledgerEntries.txnId, row.debitLedgerTxnId));
  const metadata = debit?.metadata as Record<string, unknown> | undefined;
  const sys = await bootstrapSystemAccounts(tx);
  const owner = baseId
    ? await getOrCreateBaseAccount(tx, baseId, 'base_shards')
    : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
  const cost = row.paidShardCost;
  if (!Number.isSafeInteger(Number(cost))) {
    throw new HttpError(409, 'training debit receipt is outside the supported range', 'TRAINING_RECEIPT_INVALID');
  }
  const validDebit = debit?.type === 'army.train'
    && metadata?.['troop'] === row.troop
    && metadata?.['queueId'] === row.id
    && metadata?.['costShards'] === Number(cost)
    && metadata?.['economyVersion'] === 2
    && (baseId ? metadata?.['baseId'] === baseId : metadata?.['wallet'] === wallet)
    && debitEntries.length === 2
    && debitEntries.some((entry) => entry.accountId === owner.id && entry.delta === -cost)
    && debitEntries.some((entry) => entry.accountId === sys.shard_burn && entry.delta === cost);
  if (!validDebit) {
    throw new HttpError(409, 'training debit receipt does not match this troop', 'TRAINING_RECEIPT_INVALID');
  }
  return { sys, owner, cost };
}

async function assertTrainingRefundReceipt(
  tx: DbOrTx,
  row: CancelableTrainingRow,
  wallet: string,
  refundTxnId: string | null,
  context: Awaited<ReturnType<typeof requireTrainingDebit>>,
  baseId?: string,
): Promise<void> {
  if (!refundTxnId) {
    throw new HttpError(409, 'training refund receipt is missing', 'TRAINING_REFUND_INVALID');
  }
  const [refundTxn] = await tx.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.id, refundTxnId));
  const refundEntries = await tx.select().from(ledgerEntries)
    .where(eq(ledgerEntries.txnId, refundTxnId));
  const refundMetadata = refundTxn?.metadata as Record<string, unknown> | undefined;
  const validRefund = refundTxn?.idempotencyKey === `army-train-cancel:${row.id}`
    && refundTxn.type === 'army.train.cancel'
    && refundMetadata?.['queueId'] === row.id
    && refundMetadata?.['troop'] === row.troop
    && refundMetadata?.['debitLedgerTxnId'] === row.debitLedgerTxnId
    && (baseId ? refundMetadata?.['baseId'] === baseId : refundMetadata?.['wallet'] === wallet)
    && refundEntries.length === 2
    && refundEntries.some((entry) => entry.accountId === context.sys.shard_burn && entry.delta === -context.cost)
    && refundEntries.some((entry) => entry.accountId === context.owner.id && entry.delta === context.cost);
  if (!validRefund) {
    throw new HttpError(409, 'training refund receipt does not match this troop', 'TRAINING_REFUND_INVALID');
  }
}

async function postTrainingRefund(
  tx: DbOrTx,
  row: CancelableTrainingRow,
  wallet: string,
  idempotencyKey: string,
  context: Awaited<ReturnType<typeof requireTrainingDebit>>,
  baseId?: string,
) {
  const posted = await postTransaction(tx, {
    idempotencyKey,
    type: 'army.train.cancel',
    entries: [
      { account: context.sys.shard_burn, delta: -context.cost },
      { account: context.owner.id, delta: context.cost },
    ],
    metadata: {
      wallet,
      ...(baseId ? { baseId } : {}),
      queueId: row.id,
      troop: row.troop,
      debitLedgerTxnId: row.debitLedgerTxnId,
    },
  });
  await assertTrainingRefundReceipt(
    tx, row, wallet, posted.transaction.id, context, baseId,
  );
  return posted;
}

type TrainingCancellationQuota = {
  trainingCancelDay: string | null;
  trainingCancelCount: number;
};

function nextTrainingCancellationCount(
  quota: TrainingCancellationQuota,
  day: string,
  max: number,
): number {
  const count = quota.trainingCancelDay === day ? quota.trainingCancelCount : 0;
  if (count >= max) {
    throw new HttpError(
      429,
      'daily troop-training cancellation limit reached',
      'TRAINING_CANCEL_RATE_LIMITED',
    );
  }
  return count + 1;
}

/** Spend durable successful-refund budgets while the caller holds the player
 * and (when present) base row locks. Both writes share the refund transaction,
 * so a failed ledger post or terminal queue write restores the counters. */
async function consumeTrainingCancellationQuota(
  tx: DbOrTx,
  wallet: string,
  player: TrainingCancellationQuota,
  now: Date,
  base?: TrainingCancellationQuota & { id: string },
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const playerCount = nextTrainingCancellationCount(
    player, day, TRAINING_CANCELLATION.maxRefundsPerWalletUtcDay,
  );
  const baseCount = base
    ? nextTrainingCancellationCount(
      base, day, TRAINING_CANCELLATION.maxRefundsPerBaseUtcDay,
    )
    : undefined;

  await tx.update(players).set({
    trainingCancelDay: day,
    trainingCancelCount: playerCount,
  }).where(eq(players.wallet, wallet));
  if (base && baseCount !== undefined) {
    await tx.update(bases).set({
      trainingCancelDay: day,
      trainingCancelCount: baseCount,
    }).where(eq(bases.id, base.id));
  }
}

type CancelOutcome =
  | { result: CancelTrainingResult }
  | { error: { statusCode: number; message: string; code: string } };

function throwCancelError(outcome: CancelOutcome): CancelTrainingResult {
  if ('result' in outcome) return outcome.result;
  throw new HttpError(outcome.error.statusCode, outcome.error.message, outcome.error.code);
}

/** Cancel one exact still-training row and compensate its exact SHARD debit.
 * Stable mode refunds the deed account, so ownership transfer never redirects
 * deed-local value to either the old or new wallet. */
export async function cancelTraining(
  db: Db,
  wallet: string,
  queueId: string,
  idempotencyKey: string,
  now = new Date(),
  baseContext?: StableBaseMutationContext,
): Promise<CancelTrainingResult> {
  if (multiBaseEnabled()) {
    const context = requireStableBaseMutationContext(baseContext);
    const outcome = await db.transaction<CancelOutcome>(async (tx) => {
      const [player] = await tx.select({
        wallet: players.wallet,
        trainingCancelDay: players.trainingCancelDay,
        trainingCancelCount: players.trainingCancelCount,
      }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) return { error: { statusCode: 404, message: 'player not found', code: 'PLAYER_NOT_FOUND' } };
      const base = await lockStablePrerequisiteBase(tx, wallet, context);
      await completeDueBaseTrainingLocked(tx, wallet, base.id, now);
      const [row] = await tx.select().from(baseTrainingQueue).where(and(
        eq(baseTrainingQueue.id, queueId), eq(baseTrainingQueue.baseId, base.id),
      )).for('update');
      if (!row) return { error: { statusCode: 404, message: 'training row not found', code: 'TRAINING_NOT_FOUND' } };
      if (row.cancelledAt && row.cancelIdempotencyKey === idempotencyKey && row.paidShardCost !== null) {
        const context = await requireTrainingDebit(tx, row, wallet, base.id);
        await assertTrainingRefundReceipt(
          tx, row, wallet, row.refundLedgerTxnId, context, base.id,
        );
        return { result: {
          id: row.id, troop: row.troop as TroopType,
          refundShards: row.paidShardCost.toString(), cancelledAt: row.cancelledAt, replayed: true,
        } };
      }
      if (row.completedAt) {
        return { error: { statusCode: 409, message: 'training already finished or was cancelled', code: 'TRAINING_NOT_ACTIVE' } };
      }
      const [keyOwner] = await tx.select({ id: baseTrainingQueue.id }).from(baseTrainingQueue).where(and(
        eq(baseTrainingQueue.baseId, base.id), eq(baseTrainingQueue.cancelIdempotencyKey, idempotencyKey),
      ));
      if (keyOwner && keyOwner.id !== row.id) {
        return { error: { statusCode: 409, message: 'cancellation key was already used for another troop', code: 'TRAINING_CANCEL_KEY_REUSED' } };
      }
      const refundContext = await requireTrainingDebit(tx, row, wallet, base.id);
      await consumeTrainingCancellationQuota(tx, wallet, player, now, base);
      const refundKey = `army-train-cancel:${row.id}`;
      const posted = await postTrainingRefund(
        tx, row, wallet, refundKey, refundContext, base.id,
      );
      const [cancelled] = await tx.update(baseTrainingQueue).set({
        completedAt: now,
        cancelledAt: now,
        cancelIdempotencyKey: idempotencyKey,
        refundLedgerTxnId: posted.transaction.id,
      }).where(and(
        eq(baseTrainingQueue.id, row.id), eq(baseTrainingQueue.baseId, base.id),
        isNull(baseTrainingQueue.completedAt), isNull(baseTrainingQueue.cancelledAt),
      )).returning();
      if (!cancelled) throw new HttpError(409, 'training changed before cancellation', 'TRAINING_CHANGED');
      await repackTrainingLane(tx, wallet, now, base.id);
      return { result: {
        id: row.id, troop: row.troop as TroopType,
        refundShards: row.paidShardCost!.toString(), cancelledAt: now, replayed: posted.duplicate,
      } };
    });
    return throwCancelError(outcome);
  }

  await completeDueLegacyTraining(db, wallet, now);
  const outcome = await db.transaction<CancelOutcome>(async (tx) => {
    const [player] = await tx.select({
      wallet: players.wallet,
      trainingCancelDay: players.trainingCancelDay,
      trainingCancelCount: players.trainingCancelCount,
    }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) return { error: { statusCode: 404, message: 'player not found', code: 'PLAYER_NOT_FOUND' } };
    const [row] = await tx.select().from(trainingQueue).where(and(
      eq(trainingQueue.id, queueId), eq(trainingQueue.playerWallet, wallet),
    )).for('update');
    if (!row) return { error: { statusCode: 404, message: 'training row not found', code: 'TRAINING_NOT_FOUND' } };
    if (row.cancelledAt && row.cancelIdempotencyKey === idempotencyKey && row.paidShardCost !== null) {
      const context = await requireTrainingDebit(tx, row, wallet);
      await assertTrainingRefundReceipt(tx, row, wallet, row.refundLedgerTxnId, context);
      return { result: {
        id: row.id, troop: row.troop as TroopType,
        refundShards: row.paidShardCost.toString(), cancelledAt: row.cancelledAt, replayed: true,
      } };
    }
    if (row.completedAt) {
      return { error: { statusCode: 409, message: 'training already finished or was cancelled', code: 'TRAINING_NOT_ACTIVE' } };
    }
    const [keyOwner] = await tx.select({ id: trainingQueue.id }).from(trainingQueue).where(and(
      eq(trainingQueue.playerWallet, wallet), eq(trainingQueue.cancelIdempotencyKey, idempotencyKey),
    ));
    if (keyOwner && keyOwner.id !== row.id) {
      return { error: { statusCode: 409, message: 'cancellation key was already used for another troop', code: 'TRAINING_CANCEL_KEY_REUSED' } };
    }
    const refundContext = await requireTrainingDebit(tx, row, wallet);
    await consumeTrainingCancellationQuota(tx, wallet, player, now);
    const refundKey = `army-train-cancel:${row.id}`;
    const posted = await postTrainingRefund(tx, row, wallet, refundKey, refundContext);
    const [cancelled] = await tx.update(trainingQueue).set({
      completedAt: now,
      cancelledAt: now,
      cancelIdempotencyKey: idempotencyKey,
      refundLedgerTxnId: posted.transaction.id,
    }).where(and(
      eq(trainingQueue.id, row.id), eq(trainingQueue.playerWallet, wallet),
      isNull(trainingQueue.completedAt), isNull(trainingQueue.cancelledAt),
    )).returning();
    if (!cancelled) throw new HttpError(409, 'training changed before cancellation', 'TRAINING_CHANGED');
    await repackTrainingLane(tx, wallet, now);
    return { result: {
      id: row.id, troop: row.troop as TroopType,
      refundShards: row.paidShardCost!.toString(), cancelledAt: now, replayed: posted.duplicate,
    } };
  });
  return throwCancelError(outcome);
}

export async function researchTroop(
  db: Db, wallet: string, troop: TroopType, idempotencyKey: string, now = new Date(),
  baseContext?: StableBaseMutationContext, consent?: ResearchStartConsent,
) {
  const stats = troopStatsOf(troop);
  if (!stats) throw new HttpError(422, `unknown troop: ${troop}`);
  if (!isTrainableTroop(troop)) {
    throw new HttpError(422, stats.defenderOnly ? 'that unit is defender-only' : 'that unit is spawn-only');
  }
  requireActiveTroop(troop);
  if (!NEW_ROSTER_ENABLED && (NEW_ATTACKER_TROOPS as readonly string[]).includes(troop)) {
    throw new HttpError(422, 'this troop is coming soon');
  }
  const stableContext = multiBaseEnabled()
    ? requireStableBaseMutationContext(baseContext)
    : undefined;
  if (!stableContext) await completeDueLegacyTraining(db, wallet, now);
  return db.transaction(async (tx) => {
    // Serialize the single research lane and keep its admission, SHARD debit,
    // and row update atomic. Distinct troop requests can no longer both observe
    // an empty lane; same-troop races cannot double-pay one level.
    const [player] = await tx.select({ keepLevel: players.keepLevel }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const selectedBase = stableContext
      ? await lockStablePrerequisiteBase(tx, wallet, stableContext)
      : undefined;
    const selectedBaseId = selectedBase?.id;
    if (selectedBaseId) await completeDueBaseTrainingLocked(tx, wallet, selectedBaseId, now);
    const keepLevel = selectedBase?.keepLevel ?? player.keepLevel;
    if (stats.requiresKeepLevel !== undefined && keepLevel < stats.requiresKeepLevel) {
      throw new HttpError(422, `requires Keep level ${stats.requiresKeepLevel}`);
    }
    // Research shares the training gate: leveling a troop you cannot train is
    // the same account knowledge (D-058); the self-heal keeps live armies safe.
    await assertEliteTroopUnlocked(tx, wallet, troop);
    const forges = await completedBuildingsOf(tx, wallet, 'forge', selectedBaseId);
    const forgeLevel = forges.reduce((m, f) => Math.max(m, f.level), 0);
    if (forgeLevel === 0) throw new HttpError(422, 'build a Forge first');
    const running = selectedBaseId
      ? await tx.select().from(baseTroopResearch).where(and(
        eq(baseTroopResearch.baseId, selectedBaseId),
        sql`${baseTroopResearch.researchingToLevel} IS NOT NULL`,
      ))
      : await tx.select().from(troopResearch).where(and(
        eq(troopResearch.playerWallet, wallet),
        sql`${troopResearch.researchingToLevel} IS NOT NULL`,
      ));
    if (running.length > 0) throw new HttpError(422, 'one research at a time');
    const [r] = selectedBaseId
      ? await tx.select().from(baseTroopResearch).where(and(
        eq(baseTroopResearch.baseId, selectedBaseId), eq(baseTroopResearch.troop, troop),
      ))
      : await tx.select().from(troopResearch).where(and(
        eq(troopResearch.playerWallet, wallet), eq(troopResearch.troop, troop),
      ));
    const current = r?.level ?? 1;
    assertResearchLevel(current, consent);
    const next = current + 1;
    if (next > TROOP_LEVELING.maxLevel) throw new HttpError(422, 'already at max level');
    if (next > forgeLevel) throw new HttpError(422, `requires Forge level ${next}`);
    const cost = TROOP_LEVELING.researchCostKeep[current - 1];
    const sec = TROOP_LEVELING.researchTimeSec[current - 1];
    if (cost === undefined || sec === undefined) throw new HttpError(422, 'no research row defined');
    assertResearchPrice(BigInt(cost), consent?.maxCostShards);

    const posted = selectedBaseId
      ? await spendBaseShards(
        tx, selectedBaseId, BigInt(cost), 'army.research',
        `research:${selectedBaseId}:${idempotencyKey}`, { wallet, troop, to: next, costShards: cost },
        // Research is CANCELLABLE: spend quests are credited when the level
        // lands (creditCompletedResearchQuests), never at the refundable debit.
        { progressQuests: false },
      )
      : await spendShards(
        tx, wallet, BigInt(cost), 'army.research',
        `research:${wallet}:${idempotencyKey}`, { troop, to: next, costShards: cost },
        { progressQuests: false },
      );
    if (posted.duplicate) throw new HttpError(409, 'duplicate research request — refresh the forge');
    const finishesAt = new Date(now.getTime() + sec * 1000);
    // The row is one troop's CURRENT episode: the new debit replaces the old
    // receipt and clears any earlier cancellation, so a stale cancel key can
    // never replay an old refund against this research.
    const receipt = {
      paidShardCost: BigInt(cost), debitLedgerTxnId: posted.transaction.id,
      cancelledAt: null, refundLedgerTxnId: null, cancelIdempotencyKey: null,
    };
    if (selectedBaseId) {
      await tx.insert(baseTroopResearch)
        .values({ baseId: selectedBaseId, troop, level: current, researchingToLevel: next, finishesAt, ...receipt })
        .onConflictDoUpdate({
          target: [baseTroopResearch.baseId, baseTroopResearch.troop],
          set: { researchingToLevel: next, finishesAt, ...receipt },
        });
    } else {
      await tx.insert(troopResearch)
        .values({ playerWallet: wallet, troop, level: current, researchingToLevel: next, finishesAt, ...receipt })
        .onConflictDoUpdate({
          target: [troopResearch.playerWallet, troopResearch.troop],
          set: { researchingToLevel: next, finishesAt, ...receipt },
        });
    }
    return { troop, toLevel: next, finishesAt };
  });
}

export interface CancelResearchResult {
  troop: TroopType;
  toLevel: number;
  refundShards: string;
  cancelledAt: Date;
  replayed: boolean;
}

type CancellableResearchRow = {
  troop: string;
  level: number;
  researchingToLevel: number | null;
  paidShardCost: bigint | null;
  debitLedgerTxnId: string | null;
  refundLedgerTxnId: string | null;
  cancelledAt: Date | null;
  cancelIdempotencyKey: string | null;
};

/** Validate the immutable research debit before creating its exact inverse.
 * No cost table is consulted: the refund is the row's snapshotted receipt and
 * its linked append-only ledger post, or nothing. */
async function requireResearchDebit(
  tx: DbOrTx, row: CancellableResearchRow, wallet: string, baseId?: string,
) {
  if (row.paidShardCost === null || row.paidShardCost <= 0n || row.debitLedgerTxnId === null) {
    throw new HttpError(
      409, 'this research was started before refundable research; it will finish normally',
      'RESEARCH_NOT_REFUNDABLE',
    );
  }
  const cost = row.paidShardCost;
  if (!Number.isSafeInteger(Number(cost))) {
    throw new HttpError(409, 'research debit receipt is outside the supported range', 'RESEARCH_RECEIPT_INVALID');
  }
  const [debit] = await tx.select().from(ledgerTransactions)
    .where(eq(ledgerTransactions.id, row.debitLedgerTxnId));
  const debitEntries = await tx.select().from(ledgerEntries)
    .where(eq(ledgerEntries.txnId, row.debitLedgerTxnId));
  const metadata = debit?.metadata as Record<string, unknown> | undefined;
  const sys = await bootstrapSystemAccounts(tx);
  const owner = baseId
    ? await getOrCreateBaseAccount(tx, baseId, 'base_shards')
    : await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
  const validDebit = debit?.type === 'army.research'
    && metadata?.['troop'] === row.troop
    && metadata?.['costShards'] === Number(cost)
    && (baseId ? metadata?.['baseId'] === baseId : metadata?.['wallet'] === wallet)
    && debitEntries.length === 2
    && debitEntries.some((entry) => entry.accountId === owner.id && entry.delta === -cost)
    && debitEntries.some((entry) => entry.accountId === sys.shard_burn && entry.delta === cost);
  if (!validDebit) {
    throw new HttpError(409, 'research debit receipt does not match this troop', 'RESEARCH_RECEIPT_INVALID');
  }
  return { sys, owner, cost };
}

async function assertResearchRefundReceipt(
  tx: DbOrTx, row: CancellableResearchRow, wallet: string, refundTxnId: string | null,
  context: Awaited<ReturnType<typeof requireResearchDebit>>, baseId?: string,
): Promise<void> {
  if (!refundTxnId) throw new HttpError(409, 'research refund receipt is missing', 'RESEARCH_REFUND_INVALID');
  const [refundTxn] = await tx.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, refundTxnId));
  const refundEntries = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.txnId, refundTxnId));
  const refundMetadata = refundTxn?.metadata as Record<string, unknown> | undefined;
  // One refund per DEBIT, enforced by the ledger key itself: the row is reused
  // per troop, so the debit id (not the row) is the episode identity.
  const validRefund = refundTxn?.idempotencyKey === `army-research-cancel:${row.debitLedgerTxnId}`
    && refundTxn.type === 'army.research.cancel'
    && refundMetadata?.['troop'] === row.troop
    && refundMetadata?.['debitLedgerTxnId'] === row.debitLedgerTxnId
    && (baseId ? refundMetadata?.['baseId'] === baseId : refundMetadata?.['wallet'] === wallet)
    && refundEntries.length === 2
    && refundEntries.some((entry) => entry.accountId === context.sys.shard_burn && entry.delta === -context.cost)
    && refundEntries.some((entry) => entry.accountId === context.owner.id && entry.delta === context.cost);
  if (!validRefund) {
    throw new HttpError(409, 'research refund receipt does not match this troop', 'RESEARCH_REFUND_INVALID');
  }
}

/** Spend the durable successful-refund budgets while the caller holds the
 * player (and, in stable mode, base) row locks. Shares the refund transaction,
 * so a failed ledger post or terminal row write restores the counters. */
async function consumeResearchCancellationQuota(
  tx: DbOrTx, wallet: string, now: Date, baseId?: string,
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const [player] = await tx.select({ day: players.researchCancelDay, count: players.researchCancelCount })
    .from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found', 'PLAYER_NOT_FOUND');
  const next = (quota: { day: string | null; count: number }, max: number): number => {
    const count = quota.day === day ? quota.count : 0;
    if (count >= max) {
      throw new HttpError(429, 'daily research cancellation limit reached', 'RESEARCH_CANCEL_RATE_LIMITED');
    }
    return count + 1;
  };
  const playerCount = next(player, RESEARCH_CANCELLATION.maxRefundsPerWalletUtcDay);
  let baseCount: number | undefined;
  if (baseId) {
    const [base] = await tx.select({ day: bases.researchCancelDay, count: bases.researchCancelCount })
      .from(bases).where(eq(bases.id, baseId));
    if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
    baseCount = next(base, RESEARCH_CANCELLATION.maxRefundsPerBaseUtcDay);
  }
  await tx.update(players).set({ researchCancelDay: day, researchCancelCount: playerCount })
    .where(eq(players.wallet, wallet));
  if (baseId && baseCount !== undefined) {
    await tx.update(bases).set({ researchCancelDay: day, researchCancelCount: baseCount })
      .where(eq(bases.id, baseId));
  }
}

/** The shared core of both cancelResearch modes, run under the caller's
 * player (+ base) locks: replay by cancel key, receipt both ways, quota,
 * exact compensation, then the row returns to idle at its OLD level. */
type CancelResearchOutcome = { result: CancelResearchResult } | { error: HttpError };

async function cancelResearchLocked(
  tx: DbOrTx, wallet: string, troop: TroopType, idempotencyKey: string, now: Date, baseId?: string,
  consent?: ResearchEpisodeConsent,
): Promise<CancelResearchOutcome> {
  const [row] = baseId
    ? await tx.select().from(baseTroopResearch).where(and(
      eq(baseTroopResearch.baseId, baseId), eq(baseTroopResearch.troop, troop),
    )).for('update')
    : await tx.select().from(troopResearch).where(and(
      eq(troopResearch.playerWallet, wallet), eq(troopResearch.troop, troop),
    )).for('update');
  if (!row) return { error: new HttpError(404, 'no research in progress', 'RESEARCH_NOT_FOUND') };
  // Refusals decided BEFORE any money moves are returned, not thrown, so the
  // lazy completion that made them true (an elapsed research landing) commits
  // with them — the same outcome shape cancelTraining uses.
  let refundContext: Awaited<ReturnType<typeof requireResearchDebit>>;
  try {
    if (row.cancelledAt && row.cancelIdempotencyKey === idempotencyKey && row.paidShardCost !== null) {
      const context = await requireResearchDebit(tx, row, wallet, baseId);
      await assertResearchRefundReceipt(tx, row, wallet, row.refundLedgerTxnId, context, baseId);
      return { result: {
        troop, toLevel: row.level + 1, refundShards: row.paidShardCost.toString(),
        cancelledAt: row.cancelledAt, replayed: true,
      } };
    }
    if (!row.researchingToLevel) {
      throw new HttpError(409, 'research already finished or was cancelled', 'RESEARCH_NOT_ACTIVE');
    }
    const [keyOwner] = baseId
      ? await tx.select({ troop: baseTroopResearch.troop }).from(baseTroopResearch).where(and(
        eq(baseTroopResearch.baseId, baseId), eq(baseTroopResearch.cancelIdempotencyKey, idempotencyKey),
      ))
      : await tx.select({ troop: troopResearch.troop }).from(troopResearch).where(and(
        eq(troopResearch.playerWallet, wallet), eq(troopResearch.cancelIdempotencyKey, idempotencyKey),
      ));
    if (keyOwner && keyOwner.troop !== troop) {
      throw new HttpError(409, 'cancellation key was already used for another research', 'RESEARCH_CANCEL_KEY_REUSED');
    }
    // A restart of the same troop rewrites the row's receipt and clears its
    // cancel key, so a delayed retry of an OLD cancel would otherwise reach
    // here and cancel the NEW episode with a second refund. The refund ledger
    // post remembers the client key; a key that already paid is a replay of
    // that payment, whatever the row says now.
    const [priorRefund] = await tx.select({
      createdAt: ledgerTransactions.createdAt, metadata: ledgerTransactions.metadata,
    }).from(ledgerTransactions).where(and(
      eq(ledgerTransactions.type, 'army.research.cancel'),
      sql`${ledgerTransactions.metadata}->>'cancelIdempotencyKey' = ${idempotencyKey}`,
      baseId
        ? sql`${ledgerTransactions.metadata}->>'baseId' = ${baseId}`
        : sql`${ledgerTransactions.metadata}->>'wallet' = ${wallet} and ${ledgerTransactions.metadata}->>'baseId' is null`,
    )).limit(1);
    if (priorRefund) {
      const prior = priorRefund.metadata as Record<string, unknown>;
      if (prior['troop'] !== troop || prior['debitLedgerTxnId'] === row.debitLedgerTxnId) {
        // Same episode replays are handled above; a different troop is a reuse.
        throw new HttpError(409, 'cancellation key was already used for another research', 'RESEARCH_CANCEL_KEY_REUSED');
      }
      return { result: {
        troop, toLevel: Number(prior['toLevel']), refundShards: String(prior['costShards'] ?? '0'),
        cancelledAt: priorRefund.createdAt, replayed: true,
      } };
    }
    assertResearchEpisode(row, consent);
    refundContext = await requireResearchDebit(tx, row, wallet, baseId);
  } catch (error) {
    if (error instanceof HttpError) return { error };
    throw error;
  }
  await consumeResearchCancellationQuota(tx, wallet, now, baseId);
  const toLevel = row.researchingToLevel;
  const posted = await postTransaction(tx, {
    idempotencyKey: `army-research-cancel:${row.debitLedgerTxnId}`,
    type: 'army.research.cancel',
    entries: [
      { account: refundContext.sys.shard_burn, delta: -refundContext.cost },
      { account: refundContext.owner.id, delta: refundContext.cost },
    ],
    metadata: {
      wallet, ...(baseId ? { baseId } : {}),
      troop, toLevel, debitLedgerTxnId: row.debitLedgerTxnId,
      costShards: Number(refundContext.cost), cancelIdempotencyKey: idempotencyKey,
    },
  });
  await assertResearchRefundReceipt(tx, row, wallet, posted.transaction.id, refundContext, baseId);
  const terminal = {
    researchingToLevel: null, finishesAt: null,
    cancelledAt: now, cancelIdempotencyKey: idempotencyKey, refundLedgerTxnId: posted.transaction.id,
  };
  // Pinned to the exact episode (same predicate as completion): a stale
  // update after a concurrent completion or restart is a no-op, and the throw
  // rolls the refund back with it.
  const cancelled = baseId
    ? await tx.update(baseTroopResearch).set(terminal).where(and(
      eq(baseTroopResearch.baseId, baseId), eq(baseTroopResearch.troop, troop),
      eq(baseTroopResearch.researchingToLevel, toLevel), isNull(baseTroopResearch.cancelledAt),
    )).returning({ troop: baseTroopResearch.troop })
    : await tx.update(troopResearch).set(terminal).where(and(
      eq(troopResearch.playerWallet, wallet), eq(troopResearch.troop, troop),
      eq(troopResearch.researchingToLevel, toLevel), isNull(troopResearch.cancelledAt),
    )).returning({ troop: troopResearch.troop });
  if (cancelled.length === 0) throw new HttpError(409, 'research changed before cancellation', 'RESEARCH_CHANGED');
  return { result: {
    troop, toLevel, refundShards: refundContext.cost.toString(),
    cancelledAt: now, replayed: posted.duplicate,
  } };
}

function throwCancelResearchError(outcome: CancelResearchOutcome): CancelResearchResult {
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

/**
 * Cancel the running research of one troop: free the Forge lane, leave the
 * troop at its current level, and compensate the exact SHARD debit recorded at
 * start (never KEEP; a paid FINISH cannot be cancelled because it has already
 * landed). Stable mode refunds the deed account, so a transfer never redirects
 * deed value to either wallet. Same transaction shape as cancelTraining.
 */
export async function cancelResearch(
  db: Db, wallet: string, troop: TroopType, idempotencyKey: string, now = new Date(),
  baseContext?: StableBaseMutationContext, consent?: ResearchEpisodeConsent,
): Promise<CancelResearchResult> {
  if (!troopStatsOf(troop)) throw new HttpError(422, `unknown troop: ${troop}`);
  if (multiBaseEnabled()) {
    const context = requireStableBaseMutationContext(baseContext);
    return throwCancelResearchError(await db.transaction<CancelResearchOutcome>(async (tx) => {
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found', 'PLAYER_NOT_FOUND');
      const base = await lockStablePrerequisiteBase(tx, wallet, context);
      // Settle due work first: an elapsed research lands here and is then
      // honestly "already finished" below, never refunded.
      await completeDueBaseTrainingLocked(tx, wallet, base.id, now);
      return cancelResearchLocked(tx, wallet, troop, idempotencyKey, now, base.id, consent);
    }));
  }
  await completeDueLegacyTraining(db, wallet, now);
  return throwCancelResearchError(await db.transaction<CancelResearchOutcome>(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found', 'PLAYER_NOT_FOUND');
    return cancelResearchLocked(tx, wallet, troop, idempotencyKey, now, undefined, consent);
  }));
}

/**
 * ⚡ FINISH the running research — the paid twin of speedupJob (base.ts), and the
 * same KEEP sink: cost = speedupCostKeep(remaining) (THE shared super-linear
 * helper, so the client's label and the server's charge are byte-identical),
 * charged player_keep → emission_pool, then the level lands immediately.
 *
 * `troop` is technically redundant (concurrentResearch = 1 → at most one active
 * row) but required ON PURPOSE: the charge is priced by the row's remaining time,
 * so if the active research changed between the client rendering its FINISH label
 * and the click (the old one lazily completed, a new one was started elsewhere),
 * silently completing the OTHER row could charge far more than the price the
 * player agreed to. Echoing the troop turns that race into a clean 409.
 */
export async function researchSpeedup(
  db: Db, wallet: string, troop: TroopType, idempotencyKey: string, now = new Date(),
  baseContext?: StableBaseMutationContext, consent?: ResearchFinishConsent,
): Promise<{ cost: bigint; troop: TroopType; toLevel: number }> {
  const request = researchSpeedupIntent(troop, idempotencyKey, baseContext?.baseId, consent);
  const replay = await replayResearchSpeedup(db, wallet, request);
  if (replay) return replay;
  if (multiBaseEnabled()) {
    const stableContext = requireStableBaseMutationContext(baseContext);
    return db.transaction(async (tx) => {
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found');
      const replay = await replayResearchSpeedup(tx, wallet, request);
      if (replay) return replay;
      const selectedBase = await lockStablePrerequisiteBase(tx, wallet, stableContext);
      await completeDueBaseTrainingLocked(tx, wallet, selectedBase.id, now);
      const [r] = await tx.select().from(baseTroopResearch).where(and(
        eq(baseTroopResearch.baseId, selectedBase.id),
        sql`${baseTroopResearch.researchingToLevel} IS NOT NULL`,
      ));
      assertResearchEpisode(r?.troop === troop ? r : undefined, consent);
      if (!r) throw new HttpError(404, 'no research in progress');
      if (r.troop !== troop) throw new HttpError(409, 'that research is no longer active — refresh the forge');
      requireActiveTroop(troop);
      const toLevel = r.researchingToLevel!;
      const remSec = r.finishesAt
        ? Math.max(0, Math.ceil((r.finishesAt.getTime() - now.getTime()) / 1000))
        : 0;
      const cost = BigInt(speedupCostKeep(remSec));
      assertResearchPrice(cost, consent?.maxCostKeep);
      const posted = await spendGameCurrency(
        tx, wallet, cost, 'research.speedup',
        `rspeedup:${selectedBase.id}:${idempotencyKey}`,
        { baseId: selectedBase.id, troop, toLevel, remSec, ...(request ? { researchSpeedup: { version: 1, request } } : {}) },
      );
      if (posted.duplicate) throw new HttpError(409, 'duplicate speedup request — refresh the forge');
      const sped = await tx.update(baseTroopResearch)
        .set({ level: toLevel, researchingToLevel: null, finishesAt: null })
        .where(and(
          eq(baseTroopResearch.baseId, selectedBase.id),
          eq(baseTroopResearch.troop, troop),
          eq(baseTroopResearch.researchingToLevel, toLevel),
        ))
        .returning({ level: baseTroopResearch.level, paidShardCost: baseTroopResearch.paidShardCost });
      if (sped.length === 0) throw new HttpError(409, 'research already finished — refresh the forge');
      await creditCompletedResearchQuests(tx, wallet, sped[0]!, now, selectedBase.id);
      return { cost, troop, toLevel };
    });
  }
  // Army mutations settle due work first (trainTroop/researchTroop convention),
  // so a research whose timer already elapsed free-completes HERE and the paid
  // path below can never charge for time that has already passed — the analogue
  // of speedupJob's no-charge refusal of an already-completed job.
  await completeDueLegacyTraining(db, wallet, now);

  // Read, consent, price, debit and completion share the player lock. A stale
  // pre-lock snapshot must never finish a same-troop replacement episode.
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const replay = await replayResearchSpeedup(tx, wallet, request);
    if (replay) return replay;
    const [r] = await tx.select().from(troopResearch).where(and(
      eq(troopResearch.playerWallet, wallet),
      sql`${troopResearch.researchingToLevel} IS NOT NULL`,
    ));
    assertResearchEpisode(r?.troop === troop ? r : undefined, consent);
    if (!r) throw new HttpError(404, 'no research in progress');
    if (r.troop !== troop) throw new HttpError(409, 'that research is no longer active — refresh the forge');
    // Natural timer completion remains forward-tolerant, but a NEW paid speedup
    // must honor the live rollout authority and refuse before any KEEP debit.
    requireActiveTroop(troop);

    const toLevel = r.researchingToLevel!;
    // researchTroop always writes finishesAt alongside researchingToLevel; a
    // missing timestamp is treated as due-now (minimum charge) rather than a crash.
    const remSec = r.finishesAt ? Math.max(0, Math.ceil((r.finishesAt.getTime() - now.getTime()) / 1000)) : 0;
    const cost = BigInt(speedupCostKeep(remSec));
    assertResearchPrice(cost, consent?.maxCostKeep);
    // Namespaced + duplicate-gated (security review 2026-07-24 #5): a reused key
    // charges nothing, so it must never instant-finish a research for free.
    const posted = await spendGameCurrency(tx, wallet, cost, 'research.speedup', `rspeedup:${wallet}:${idempotencyKey}`, { troop, toLevel, remSec, ...(request ? { researchSpeedup: { version: 1, request } } : {}) });
    if (posted.duplicate) throw new HttpError(409, 'duplicate speedup request — refresh the forge');
    // Retain the conditional completion as a final guard against stale writes.
    const sped = await tx.update(troopResearch)
      .set({ level: toLevel, researchingToLevel: null, finishesAt: null })
      .where(and(
        eq(troopResearch.playerWallet, wallet),
        eq(troopResearch.troop, troop),
        eq(troopResearch.researchingToLevel, toLevel),
      ))
      .returning({ level: troopResearch.level, paidShardCost: troopResearch.paidShardCost });
    if (sped.length === 0) throw new HttpError(409, 'research already finished — refresh the forge');
    await creditCompletedResearchQuests(tx, wallet, sped[0]!, now);
    return { cost, troop, toLevel };
  });
}

/**
 * ⚡ FINISH the WHOLE training queue — the barracks twin of researchSpeedup and
 * the same KEEP sink (owner F1 2026-08: "speed up troop training while getting
 * ready to attack"). Whole-queue ON PURPOSE: a partial finish is useless for
 * attack prep. Each row carries its own finishesAt from enqueue time, so the
 * total remaining wall-clock for the queue is simply the LATEST finishesAt −
 * now; that single span is what speedupCostKeep prices (THE shared super-linear
 * helper, so the client's label and the server's charge are byte-identical).
 */
export async function trainSpeedup(
  db: Db, wallet: string, idempotencyKey: string, now = new Date(),
  baseContext?: StableBaseMutationContext, consent?: TrainingFinishAllConsent, freeOffer?: typeof TRAINING_FIRST_FINISH.offer,
): Promise<{ cost: bigint; completed: Array<{ troop: TroopType; count: number }> }> {
  if (freeOffer !== undefined && freeOffer !== TRAINING_FIRST_FINISH.offer) {
    throw new HttpError(422, 'Unknown free training offer.', 'TRAINING_FREE_FINISH_INVALID');
  }
  const request = trainingFinishIntent(idempotencyKey, baseContext?.baseId, consent, freeOffer);
  const replay = await replayTrainingFinish(db, wallet, request);
  if (replay) return replay;
  assertTrainingFinishScope(request, multiBaseEnabled());
  if (multiBaseEnabled()) {
    const stableContext = requireStableBaseMutationContext(baseContext);
    return db.transaction(async (tx) => {
      const [player] = await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      if (!player) throw new HttpError(404, 'player not found');
      const accepted = await replayTrainingFinish(tx, wallet, request);
      if (accepted) return accepted;
      if (freeOffer) {
        const replay = await replayFreeFinish(tx, wallet, idempotencyKey, stableContext.baseId, requireFinishConsent(consent));
        if (replay) return replay;
      }
      const selectedBase = await lockStablePrerequisiteBase(tx, wallet, stableContext);
      await completeDueBaseTrainingLocked(tx, wallet, selectedBase.id, now);
      const queue = await tx.select().from(baseTrainingQueue).where(and(
        eq(baseTrainingQueue.baseId, selectedBase.id),
        isNull(baseTrainingQueue.completedAt),
      )).orderBy(baseTrainingQueue.finishesAt);
      if (queue.length === 0) throw new HttpError(404, 'nothing is training', request ? 'TRAINING_NOT_RUNNING' : undefined);
      if (!darkAttackerRosterEnabled() && queue.some((q) => isDarkAttackerTroop(String(q.troop)))) {
        throw new HttpError(
          409,
          'dark attacker roster is coming soon; wait for rollout before speeding up this queue',
          'TROOP_ROSTER_INACTIVE',
        );
      }
      const last = queue[queue.length - 1]!;
      const remSec = Math.max(0, Math.ceil((last.finishesAt.getTime() - now.getTime()) / 1000));
      const cost = freeOffer ? 0n : BigInt(speedupCostKeep(remSec));
      const confirmed = requireFinishConsent(consent);
      if (cost > BigInt(confirmed.maxCostKeep)
        || !await queueConsentMatches(tx, wallet, selectedBase.id, confirmed.queue, queue, now)) {
        throw new HttpError(409, 'training queue or price changed; review FINISH ALL again', 'TRAINING_FINISH_QUOTE_CHANGED');
      }
      if (freeOffer) await authorizeFreeFinish(tx, wallet, selectedBase.id, confirmed);
      const posted = freeOffer ? { duplicate: false } : await spendGameCurrency(
        tx, wallet, cost, 'train.speedup',
        `tspeedup:${selectedBase.id}:${idempotencyKey}`,
        { baseId: selectedBase.id, rows: queue.length, remSec, ...(request ? { trainingFinish: { version: 1, request, result: trainingFinishResult(queue, now) } } : {}) },
      );
      if (posted.duplicate) throw new HttpError(409, 'duplicate speedup request — refresh the barracks');
      const claimed = await tx.update(baseTrainingQueue)
        .set({ completedAt: now })
        .where(and(
          eq(baseTrainingQueue.baseId, selectedBase.id),
          isNull(baseTrainingQueue.completedAt),
          inArray(baseTrainingQueue.id, queue.map((row) => row.id)),
        ))
        .returning({
          id: baseTrainingQueue.id,
          troop: baseTrainingQueue.troop,
          finishesAt: baseTrainingQueue.finishesAt,
          completedAt: baseTrainingQueue.completedAt,
          economyVersion: baseTrainingQueue.economyVersion,
          paidShardCost: baseTrainingQueue.paidShardCost,
          questCreditedAt: baseTrainingQueue.questCreditedAt,
        });
      if (claimed.length !== queue.length) {
        throw new HttpError(409, 'training changed before completion — refresh the barracks', 'TRAINING_CHANGED');
      }
      const claimedIds = new Set(claimed.map((row) => row.id));
      const counts = new Map<TroopType, number>();
      for (const row of queue) {
        if (claimedIds.has(row.id)) {
          const type = row.troop as TroopType;
          counts.set(type, (counts.get(type) ?? 0) + 1);
        }
      }
      for (const [type, count] of counts) {
        await tx.insert(baseArmy)
          .values({ baseId: selectedBase.id, troop: type, count })
          .onConflictDoUpdate({
            target: [baseArmy.baseId, baseArmy.troop],
            set: { count: sql`${baseArmy.count} + ${count}` },
          });
      }
      for (const row of claimed) {
        await creditCompletedTrainingQuests(tx, wallet, row, now, selectedBase.id);
      }
      const completed = [...counts].map(([type, count]) => ({ troop: type, count }));
      if (freeOffer) await tx.insert(onboardingTrainingFinishes).values({ wallet, idempotencyKey,
        baseId: selectedBase.id, consent: confirmed, completed, createdAt: now });
      return { cost, completed };
    });
  }
  // Army mutations settle due work first (module-wide completeDueTraining
  // convention): rows whose timer already elapsed free-complete HERE, so the
  // paid path below can never charge for — or double-credit — time that has
  // already passed. Modern replay must win before lazy completion, so it runs
  // inside the locked transaction below; legacy/free behavior stays unchanged.
  if (!request) await completeDueLegacyTraining(db, wallet, now);

  // Charge + completion are ONE transaction (E3, §4.3 — same shape as
  // researchSpeedup): nothing may observe a charged-but-unfinished state. The
  // queue is deliberately read and priced only AFTER the player lock: a
  // concurrent one-unit cancellation can remove the tail, and pricing a stale
  // pre-lock snapshot would overcharge the shorter queue that remains.
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const accepted = await replayTrainingFinish(tx, wallet, request);
    if (accepted) return accepted;
    if (request) await completeDueLegacyTraining(tx, wallet, now);
    if (freeOffer) {
      const replay = await replayFreeFinish(tx, wallet, idempotencyKey, undefined, requireFinishConsent(consent));
      if (replay) return replay;
    }
    const queue = await tx.select().from(trainingQueue).where(and(
      eq(trainingQueue.playerWallet, wallet),
      isNull(trainingQueue.completedAt),
    )).orderBy(trainingQueue.finishesAt);
    if (queue.length === 0) throw new HttpError(404, 'nothing is training', request ? 'TRAINING_NOT_RUNNING' : undefined);
    if (!darkAttackerRosterEnabled() && queue.some((q) => isDarkAttackerTroop(String(q.troop)))) {
      throw new HttpError(409, 'dark attacker roster is coming soon; wait for rollout before speeding up this queue', 'TROOP_ROSTER_INACTIVE');
    }
    const last = queue[queue.length - 1]!;
    const remSec = Math.max(0, Math.ceil((last.finishesAt.getTime() - now.getTime()) / 1000));
    const cost = freeOffer ? 0n : BigInt(speedupCostKeep(remSec));
    const confirmed = requireFinishConsent(consent);
    if (cost > BigInt(confirmed.maxCostKeep)
      || !await queueConsentMatches(tx, wallet, undefined, confirmed.queue, queue, now)) {
      throw new HttpError(409, 'training queue or price changed; review FINISH ALL again', 'TRAINING_FINISH_QUOTE_CHANGED');
    }
    // Namespaced + duplicate-gated (security review 2026-07-24 #5): a reused key
    // charges nothing, so it must never instant-finish a queue for free.
    if (freeOffer) await authorizeFreeFinish(tx, wallet, undefined, confirmed);
    const posted = freeOffer ? { duplicate: false } : await spendGameCurrency(tx, wallet, cost, 'train.speedup', `tspeedup:${wallet}:${idempotencyKey}`, { rows: queue.length, remSec, ...(request ? { trainingFinish: { version: 1, request, result: trainingFinishResult(queue, now) } } : {}) });
    if (posted.duplicate) throw new HttpError(409, 'duplicate speedup request — refresh the barracks');
    // Re-claim UNDER the transaction, pinned to the EXACT ids we read and
    // priced: rows a concurrent lazy completion already claimed are skipped
    // (never double-credited), and a row enqueued AFTER the read is never
    // finished (it was not part of the price). Zero claims means the whole
    // queue raced away — the throw rolls the charge back, so an already-empty
    // queue is never paid for.
    const claimed = await tx.update(trainingQueue)
      .set({ completedAt: now })
      .where(and(
        eq(trainingQueue.playerWallet, wallet),
        isNull(trainingQueue.completedAt),
        inArray(trainingQueue.id, queue.map((q) => q.id)),
      ))
      .returning({
        id: trainingQueue.id,
        troop: trainingQueue.troop,
        finishesAt: trainingQueue.finishesAt,
        completedAt: trainingQueue.completedAt,
        economyVersion: trainingQueue.economyVersion,
        paidShardCost: trainingQueue.paidShardCost,
        questCreditedAt: trainingQueue.questCreditedAt,
      });
    if (claimed.length !== queue.length) {
      throw new HttpError(409, 'training changed before completion — refresh the barracks', 'TRAINING_CHANGED');
    }
    // Credit the camp EXACTLY the way natural completion does
    // (completeDueTraining): an unconditional count increment. Capacity is
    // reserved at ENQUEUE time (trainTroop's queued+held gate) and completion
    // never re-checks it — instant finish must not invent a stricter rule.
    // Aggregated in queue (finishesAt) order so `completed` is deterministic.
    const claimedIds = new Set(claimed.map((c) => c.id));
    const counts = new Map<TroopType, number>();
    for (const q of queue) {
      if (claimedIds.has(q.id)) counts.set(q.troop as TroopType, (counts.get(q.troop as TroopType) ?? 0) + 1);
    }
    for (const [troop, count] of counts) {
      await tx.insert(army)
        .values({ playerWallet: wallet, troop, count })
        .onConflictDoUpdate({
          target: [army.playerWallet, army.troop],
          set: { count: sql`${army.count} + ${count}` },
        });
    }
    for (const row of claimed) {
      await creditCompletedTrainingQuests(tx, wallet, row, now);
    }
    const completed = [...counts].map(([troop, count]) => ({ troop, count }));
    if (freeOffer) await tx.insert(onboardingTrainingFinishes).values({ wallet, idempotencyKey,
      baseId: null, consent: confirmed, completed, createdAt: now });
    return { cost, completed };
  });
}

/** Consume troops after a raid (GDD §3.2: troops are consumed on raid). */
export class ArmyConsumptionError extends HttpError {
  constructor(troop: TroopType) {
    super(409, `not enough ${troop} in camp`, 'RAID_ARMY_CHANGED');
    this.name = 'ArmyConsumptionError';
  }
}

/** Revalidate a frozen raid order set against the deed's live camp immediately
 * before resolution. This is intentionally base-first so sibling deeds owned
 * by the same wallet cannot satisfy each other's reservation. */
export async function baseArmyCoversOrders(
  db: DbOrTx, baseId: string, used: Partial<Record<TroopType, number>>,
): Promise<boolean> {
  const rows = await db.select({ troop: baseArmy.troop, count: baseArmy.count })
    .from(baseArmy).where(eq(baseArmy.baseId, baseId));
  const counts = new Map(rows.map((row) => [row.troop, row.count]));
  return (Object.entries(used) as Array<[TroopType, number]>).every(
    ([troop, count]) => !count || (counts.get(troop) ?? 0) >= count,
  );
}

/** Base-identity consumption for raid resolution. No wallet key participates:
 * if a deed is conveyed, its frozen roster remains attached to that same base. */
export async function consumeBaseArmy(
  db: DbOrTx, baseId: string, used: Partial<Record<TroopType, number>>,
): Promise<void> {
  for (const [troop, n] of Object.entries(used) as Array<[TroopType, number]>) {
    if (!n) continue;
    const res = await db.update(baseArmy)
      .set({ count: sql`${baseArmy.count} - ${n}` })
      .where(and(
        eq(baseArmy.baseId, baseId),
        eq(baseArmy.troop, troop),
        sql`${baseArmy.count} >= ${n}`,
      ))
      .returning({ count: baseArmy.count });
    if (res.length === 0) throw new ArmyConsumptionError(troop);
  }
}

export async function consumeArmy(
  db: DbOrTx,
  wallet: string,
  used: Partial<Record<TroopType, number>>,
  baseId?: string,
): Promise<void> {
  if (multiBaseEnabled()) {
    if (!baseId) throw new HttpError(409, 'baseId is required while multi-base is active', 'BASE_ID_REQUIRED');
    return consumeBaseArmy(db, baseId, used);
  }
  for (const [troop, n] of Object.entries(used) as Array<[TroopType, number]>) {
    if (!n) continue;
    const res = await db.update(army)
      .set({ count: sql`${army.count} - ${n}` })
      .where(and(eq(army.playerWallet, wallet), eq(army.troop, troop), sql`${army.count} >= ${n}`))
      .returning({ count: army.count });
    if (res.length === 0) throw new ArmyConsumptionError(troop);
  }
}
