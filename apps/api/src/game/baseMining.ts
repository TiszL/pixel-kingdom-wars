/** Per-deed, per-physical-Mine lazy accrual (owner decision D-035). */
import { DAILY_CACHE, MINING, getMiningQuota } from '@shardkeep/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  baseEconomyBackfills, baseStreaks, bases, builderJobs, buildings,
  mineAccrualStates, players,
} from '../db/schema';
import { phaseEMiningEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { getEmissionMultBps } from './gameConfig';
import { rewardBaseShards } from './baseEconomy';
import {
  lockStablePrerequisiteBase, requireActiveStablePrerequisiteBase,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';

import { bootstrapSystemAccounts, getOrCreateBaseAccount, postTransaction } from '../ledger';
import {
  hasPhysicalMineTaxEra, initializePhysicalMineTaxEra, assertPhysicalMineTaxBuffer,
  recordPhysicalMineTaxAccrual, physicalMineTaxHeld, recordPhysicalMineTaxHold, recordPhysicalMineLegacyAdoption, lockPhysicalMineTaxActors,
  physicalMineTaxPartitions,
} from '../mining/shardsTaxMineSources';
import { planPhysicalMineCollections, finishPhysicalMineIssue, lockPhysicalMineTaxWallets } from '../mining/shardsTaxMineAccounting';
import { initializePhysicalMinePolicyEra } from '../mining/shardsTaxMineLifecycle';
import { prepareMineProductionSettlement } from '../mining/shardsTaxMineProduction';

export const MINE_DAY_MS = 86_400_000;

interface ProducingMine {
  id: string;
  level: number;
  productionStartedAt: Date | null;
}

export interface MineFillProjection {
  accrued: bigint;
  capacity: bigint;
  /** Earliest integral millisecond at which the lazy accrual reaches capacity. */
  fullAtMs: bigint | null;
  /** Present only for an explicitly tracked fractional production clock. */
  remainder?: bigint;
}

/** One exact bigint projection for status, collection, and notification timing.
 * The ceiling inverse is paired with the floor used for accrual, so the event
 * can never fire one millisecond before the balance is actually full. */
export function projectMineFill(
  previous: bigint, lastAt: Date, dailyQuota: number, now: Date, remainder?: bigint | null,
): MineFillProjection {
  const quota = BigInt(Math.max(0, Math.trunc(dailyQuota)));
  const capacity = quota * BigInt(MINING.MINE_STORAGE_DAYS);
  const tracked = remainder !== undefined && remainder !== null;
  const fraction = remainder ?? 0n;
  if (fraction < 0n || fraction >= BigInt(MINE_DAY_MS)) throw Error('Invalid Mine production fraction');
  if (tracked && +now < +lastAt) throw Error('Mine production clock regression');
  if (quota === 0n) return { accrued: previous, capacity, fullAtMs: null, ...(tracked ? { remainder: fraction } : {}) };
  const lastAtMs = BigInt(lastAt.getTime());
  const nowMs = BigInt(now.getTime());
  const elapsed = nowMs - lastAtMs;
  const numerator = fraction + (elapsed > 0n ? quota * elapsed : 0n);
  const gain = numerator / BigInt(MINE_DAY_MS);
  const next = previous + gain;
  const accrued = next > capacity ? (previous > capacity ? previous : capacity) : next;
  const fullAtMs = previous >= capacity
    ? lastAtMs
    : lastAtMs + ((capacity - previous) * BigInt(MINE_DAY_MS) - fraction + quota - 1n) / quota;
  return { accrued, capacity, fullAtMs, ...(tracked ? { remainder: accrued >= capacity ? 0n : numerator % BigInt(MINE_DAY_MS) } : {}) };
}

function notificationCheckAt(projection: MineFillProjection): Date | null {
  if (projection.fullAtMs === null) return null;
  const ms = Number(projection.fullAtMs);
  return Number.isSafeInteger(ms) ? new Date(ms) : null;
}

async function producingMines(
  db: DbOrTx, baseId: string, now: Date, excludeMineId?: string,
): Promise<ProducingMine[]> {
  const rows = await db.select({
    id: buildings.id,
    level: buildings.level,
    finishesAt: builderJobs.finishesAt,
    completedAt: builderJobs.completedAt,
  }).from(buildings).leftJoin(builderJobs, and(
    eq(builderJobs.buildingId, buildings.id),
    eq(builderJobs.kind, 'build'),
  )).where(and(eq(buildings.baseId, baseId), eq(buildings.type, 'mine')));
  return rows.filter((row) => row.id !== excludeMineId
    && (row.completedAt !== null || row.finishesAt === null || row.finishesAt <= now))
    .map((row) => ({
      id: row.id,
      level: row.level,
      // A lazily-completed build starts producing at its authoritative finish
      // time, not when the owner next opens that deed. Existing pre-job Mines
      // are anchored by migration; a missing state safely starts now.
      productionStartedAt: row.finishesAt,
    }));
}

async function baseStreakDays(db: DbOrTx, baseId: string): Promise<number> {
  const [row] = await db.select({ days: baseStreaks.currentDays }).from(baseStreaks)
    .where(eq(baseStreaks.baseId, baseId));
  return row?.days ?? 0;
}

export function oneMineQuota(
  keepLevel: number, mineLevel: number, streakDays: number, epochBps: number,
  /** D-052: +50 bps per active qualified referral of the base's OWNER. Every
   * quota consumer (status preview, accrual settle, collect, storage cap)
   * threads the same value so a mine can never display one rate and pay
   * another. */
  referralBonusBps = 0,
): number {
  return getMiningQuota(keepLevel, [mineLevel], streakDays, epochBps, referralBonusBps);
}

/** The live referral quota bonus for a base's owner (D-052). Dynamic import —
 * social.ts reaches baseEconomy, which reaches back here; the old match
 * sidecar used the same seam for the same cycle. */
async function ownerReferralBonusBps(db: DbOrTx, ownerWallet: string, now: Date): Promise<number> {
  const { activeReferralBonusBps } = await import('./social');
  return activeReferralBonusBps(db, ownerWallet, now);
}

/** Current one-day capacity for one physical Mine. Raid restoration uses the
 * same live Keep/Mine/streak/emission inputs as ordinary accrual, so a buffer
 * detached at raid start cannot be added back above the Mine's truthful cap. */
export async function currentMineStorageCap(
  db: DbOrTx, mineBuildingId: string, now = new Date(),
): Promise<bigint> {
  const [mine] = await db.select({
    baseId: buildings.baseId,
    level: buildings.level,
  }).from(buildings).where(and(
    eq(buildings.id, mineBuildingId),
    eq(buildings.type, 'mine'),
  )).for('update');
  if (!mine?.baseId) throw new Error(`reserved Mine ${mineBuildingId} vanished`);
  const [base] = await db.select({ keepLevel: bases.keepLevel, ownerWallet: bases.ownerWallet })
    .from(bases).where(eq(bases.id, mine.baseId));
  if (!base) throw new Error(`reserved Mine ${mineBuildingId} lost its base`);
  const [streak, epochBps, bonusBps] = await Promise.all([
    baseStreakDays(db, mine.baseId),
    getEmissionMultBps(db),
    ownerReferralBonusBps(db, base.ownerWallet, now),
  ]);
  return BigInt(oneMineQuota(base.keepLevel, mine.level, streak, epochBps, bonusBps))
    * BigInt(MINING.MINE_STORAGE_DAYS);
}

async function ensureAndLockMineStates(
  db: DbOrTx, mines: readonly ProducingMine[], now: Date,
) {
  if (mines.length === 0) return [];
  const inserted = await db.insert(mineAccrualStates).values(mines.map((mine) => ({
    mineBuildingId: mine.id,
    lastAccrualAt: mine.productionStartedAt && mine.productionStartedAt < now
      ? mine.productionStartedAt : now,
  }))).onConflictDoNothing().returning({ id: mineAccrualStates.mineBuildingId });
  const states = await db.select().from(mineAccrualStates)
    .where(inArray(mineAccrualStates.mineBuildingId, mines.map((mine) => mine.id)))
    .orderBy(mineAccrualStates.mineBuildingId).for('update');
  const fresh = new Set(inserted.map(row => row.id));
  for (const state of states) await initializePhysicalMinePolicyEra(db, {
    mineId: state.mineBuildingId, at: now, freshlyInserted: fresh.has(state.mineBuildingId),
  });
  return states;
}

/** Anchor one new physical Mine. It owns a buffer even when its deed is not selected. */
export async function ensureBaseMineState(
  db: DbTx, mineBuildingId: string, productionStartedAt = new Date(),
  initializedAt = new Date(),
): Promise<void> {
  const [mine] = await db.select({ baseId: buildings.baseId, type: buildings.type, level: buildings.level })
    .from(buildings).where(eq(buildings.id, mineBuildingId)).for('update');
  if (!mine?.baseId || mine.type !== 'mine') {
    throw new Error(`cannot anchor non-Mine building ${mineBuildingId}`);
  }
  const inserted = await db.insert(mineAccrualStates)
    .values({ mineBuildingId, lastAccrualAt: productionStartedAt })
    .onConflictDoNothing().returning({ id: mineAccrualStates.mineBuildingId });
  await initializePhysicalMinePolicyEra(db, {
    mineId: mineBuildingId, at: initializedAt, freshlyInserted: inserted.length > 0,
  });

  // A legacy wallet may have had accrued Mine SHARDS but no completed physical
  // Mine at cutover. The first Mine completed on its deterministic primary deed
  // adopts that buffer under the same transaction/row lock. This is deliberately
  // separate from the ledger cutover: boot must not be blocked forever merely
  // because a player has not built a Mine yet, but the buffer must never vanish.
  const [backfill] = await db.select({
    wallet: baseEconomyBackfills.legacyWallet,
    pending: baseEconomyBackfills.legacyMineBufferPending,
  }).from(baseEconomyBackfills).where(eq(
    baseEconomyBackfills.primaryBaseId, mine.baseId,
  )).for('update');
  if (backfill && backfill.pending > 0n) {
    await recordPhysicalMineLegacyAdoption(db, { mineId: mineBuildingId, baseId: mine.baseId,
      wallet: backfill.wallet, amount: backfill.pending, at: productionStartedAt });
    await db.update(mineAccrualStates).set({
      accruedShards: sql`${mineAccrualStates.accruedShards} + ${backfill.pending}`,
      version: sql`${mineAccrualStates.version} + 1`,
    }).where(eq(mineAccrualStates.mineBuildingId, mineBuildingId));
    await db.update(baseEconomyBackfills).set({
      legacyMineBufferPending: 0n,
      mineBackfilledAt: new Date(),
    }).where(eq(baseEconomyBackfills.legacyWallet, backfill.wallet));
  }
  if (inserted.length === 0 && (!backfill || backfill.pending <= 0n)) return;

  const [base] = await db.select({ keepLevel: bases.keepLevel, ownerWallet: bases.ownerWallet })
    .from(bases).where(eq(bases.id, mine.baseId));
  const [state] = await db.select().from(mineAccrualStates)
    .where(eq(mineAccrualStates.mineBuildingId, mineBuildingId));
  if (!base || !state) throw new Error(`new Mine ${mineBuildingId} lost its accrual context`);
  const at = state.lastAccrualAt;
  const quota = oneMineQuota(
    base.keepLevel, mine.level, await baseStreakDays(db, mine.baseId),
    await getEmissionMultBps(db), await ownerReferralBonusBps(db, base.ownerWallet, at),
  );
  await db.update(mineAccrualStates).set({
    fullNotificationCheckAt: notificationCheckAt(
      projectMineFill(state.accruedShards, at, quota, at),
    ),
  }).where(eq(mineAccrualStates.mineBuildingId, mineBuildingId));
}

/** Settle every existing Mine at its old rate before Keep/Mine/streak changes. */
export async function reanchorBaseMineAccrual(
  db: DbOrTx, baseId: string, now: Date, excludeMineId?: string, ownershipUnresolved = false,
  targetMineIds?: readonly string[],
): Promise<void> {
  const [base] = await db.select({ keepLevel: bases.keepLevel, ownerWallet: bases.ownerWallet })
    .from(bases).where(eq(bases.id, baseId));
  if (!base) throw new HttpError(404, 'base not found', 'BASE_NOT_FOUND');
  const mines = (await producingMines(db, baseId, now, excludeMineId))
    .filter(mine => !targetMineIds || targetMineIds.includes(mine.id));
  if (mines.length === 0) return;
  const streakDays = await baseStreakDays(db, baseId);
  const epochBps = await getEmissionMultBps(db);
  const bonusBps = await ownerReferralBonusBps(db, base.ownerWallet, now);
  const states = await ensureAndLockMineStates(db, mines, now);
  if ((await Promise.all(states.map(s=>hasPhysicalMineTaxEra(db,s.mineBuildingId)))).some(Boolean))
    await lockPhysicalMineTaxActors(db,[base.ownerWallet]);
  const byId = new Map(mines.map((mine) => [mine.id, mine]));
  for (const state of states) {
    const mine = byId.get(state.mineBuildingId)!;
    const quota = oneMineQuota(base.keepLevel, mine.level, streakDays, epochBps, bonusBps);
    const projection = projectMineFill(state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder);
    const settled = projection.accrued;
    const productionSettlementId = state.productionRemainder === null ? undefined : await prepareMineProductionSettlement(db, {
      mineId: mine.id, baseId, wallet: base.ownerWallet, version: state.version,
      lastAt: state.lastAccrualAt, previous: state.accruedShards, remainderBefore: state.productionRemainder,
      now, quota: BigInt(quota), capacity: projection.capacity, gross: settled - state.accruedShards,
      remainderAfter: projection.remainder!, targetBuffer: settled, targetAt: now, kind: 'reanchor',
    });
    if (await hasPhysicalMineTaxEra(db, mine.id)) {
      await assertPhysicalMineTaxBuffer(db, mine.id, state.accruedShards);
      await recordPhysicalMineTaxAccrual(db, { mineId: mine.id, baseId, wallet: base.ownerWallet,
        version: state.version, lastAt: state.lastAccrualAt, now, gross: settled - state.accruedShards,
        quota: BigInt(quota), dayMs: BigInt(MINE_DAY_MS), ownershipUnresolved,
        remainder: state.productionRemainder ?? undefined, productionSettlementId });
    }
    await db.update(mineAccrualStates).set({
      accruedShards: settled,
      lastAccrualAt: now,
      ...(state.productionRemainder === null ? {} : { productionRemainder: projection.remainder! }),
      fullNotificationCheckAt: notificationCheckAt(projectMineFill(settled, now, quota, now, projection.remainder)),
      version: state.version + 1,
    }).where(and(
      eq(mineAccrualStates.mineBuildingId, mine.id),
      eq(mineAccrualStates.version, state.version),
    ));
  }
}

/** Explicit prospective source admission, under the caller's player/base locks. */
export async function preparePhysicalMineTaxAdmission(db: DbTx, baseId: string, wallet: string, now: Date, targetMineIds?: readonly string[]) {
  const selected = (await producingMines(db, baseId, now)).filter(mine => !targetMineIds || targetMineIds.includes(mine.id));
  const originals = await ensureAndLockMineStates(db, selected, now);
  if (originals.some(state=>state.lastAccrualAt>now)) throw new Error('Mine source clock regression');
  await reanchorBaseMineAccrual(db, baseId, now, undefined, false, targetMineIds);
  const [base] = await db.select().from(bases).where(eq(bases.id, baseId));
  if (!base || base.ownerWallet !== wallet) throw new Error('original Mine owner changed');
  const mines = (await producingMines(db, baseId, now)).filter(mine => !targetMineIds || targetMineIds.includes(mine.id));
  const states = await ensureAndLockMineStates(db, mines, now);
  const streak = await baseStreakDays(db, baseId), epoch = await getEmissionMultBps(db);
  const bonus = await ownerReferralBonusBps(db, wallet, now);
  await lockPhysicalMineTaxActors(db,[wallet]);
  for (const state of states) await initializePhysicalMineTaxEra(db, {
    mineId: state.mineBuildingId, baseId, at: now, legacy: state.accruedShards,
  });
  return mines.map(mine => ({ id: mine.id,
    quota: BigInt(oneMineQuota(base.keepLevel, mine.level, streak, epoch, bonus)) }));
}

/** Phase E: settle only saturated uncovered production for historical recovery.
 * Caller owns player/base/provenance locks and freshly checked current custody.
 * Full storage has no pending earnable fraction. Partial/empty/covered siblings
 * retain their original clocks; no operating admission is created here. */
export async function captureFullBaseMineAccrual(db: DbTx, baseId: string, now: Date, includePartial = false): Promise<void> {
  const [base] = await db.select({ keepLevel: bases.keepLevel, ownerWallet: bases.ownerWallet })
    .from(bases).where(eq(bases.id, baseId));
  if (!base || !Number.isSafeInteger(+now)) throw new HttpError(503, 'Mine capture context unavailable', 'SHARDS_MINE_CAPTURE_HELD');
  const mines = await producingMines(db, baseId, now);
  const states = await ensureAndLockMineStates(db, mines, now);
  const streakDays = await baseStreakDays(db, baseId), epochBps = await getEmissionMultBps(db);
  const bonusBps = await ownerReferralBonusBps(db, base.ownerWallet, now);
  const byId = new Map(mines.map(mine => [mine.id, mine]));
  for (const state of states) {
    if (state.lastAccrualAt > now) throw new HttpError(503, 'Mine capture clock regressed', 'SHARDS_MINE_CAPTURE_HELD');
    if (!await hasPhysicalMineTaxEra(db, state.mineBuildingId)) continue;
    const mine = byId.get(state.mineBuildingId)!;
    const quota = oneMineQuota(base.keepLevel, mine.level, streakDays, epochBps, bonusBps);
    const projection = projectMineFill(state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder);
    const gross = projection.accrued - state.accruedShards;
    if (gross <= 0n || projection.capacity <= 0n || (!includePartial && projection.accrued < projection.capacity)) continue;
    const capture = { mineId: mine.id, baseId, wallet: base.ownerWallet, version: state.version,
      lastAt: state.lastAccrualAt, now, gross, quota: BigInt(quota), dayMs: BigInt(MINE_DAY_MS),
      remainder: state.productionRemainder ?? undefined };
    if (!(await physicalMineTaxPartitions(db, capture)).some(part => !part.covered && !part.legacy)) continue;
    await assertPhysicalMineTaxBuffer(db, mine.id, state.accruedShards);
    const tracked = state.productionRemainder !== null || projection.accrued < projection.capacity;
    const fractional = tracked ? projectMineFill(state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder ?? 0n) : projection;
    const productionSettlementId = !tracked ? undefined : await prepareMineProductionSettlement(db, {
      mineId: mine.id, baseId, wallet: base.ownerWallet, version: state.version,
      lastAt: state.lastAccrualAt, previous: state.accruedShards, remainderBefore: state.productionRemainder,
      now, quota: BigInt(quota), capacity: fractional.capacity, gross,
      remainderAfter: fractional.remainder!, targetBuffer: fractional.accrued, targetAt: now, kind: 'capture',
    });
    await recordPhysicalMineTaxAccrual(db, { ...capture, productionSettlementId });
    // One real settlement fixes completed units and their earned fraction. The
    // next interval still samples the live referral/emission quota.
    const updated = await db.update(mineAccrualStates).set({ accruedShards: projection.accrued,
      ...(tracked ? { productionRemainder: fractional.remainder! } : {}),
      lastAccrualAt: now, fullNotificationCheckAt: notificationCheckAt(fractional), version: state.version + 1,
    }).where(and(eq(mineAccrualStates.mineBuildingId, mine.id), eq(mineAccrualStates.version, state.version)))
      .returning({ id: mineAccrualStates.mineBuildingId });
    if (updated.length !== 1) throw new Error(`Mine full capture version race for ${mine.id}`);
  }
}

/** A returning whole raid buffer can fill storage without a production-clock
 * advance. Record the unearnable fraction's disposition at that actual event. */
export async function discardFullMineProductionFraction(db: DbOrTx, mineId: string, capacity: bigint, now: Date) {
  const [state] = await db.select().from(mineAccrualStates)
    .where(eq(mineAccrualStates.mineBuildingId, mineId)).for('update');
  if (!state) throw Error('Mine production state unavailable');
  if (state.productionRemainder === null || state.productionRemainder === 0n || capacity <= 0n || state.accruedShards < capacity) return state;
  const [base] = await db.select({ id: bases.id, ownerWallet: bases.ownerWallet }).from(buildings)
    .innerJoin(bases, eq(bases.id, buildings.baseId)).where(eq(buildings.id, mineId));
  if (!base) throw Error('Mine production base unavailable');
  await prepareMineProductionSettlement(db, { mineId, baseId: base.id, wallet: base.ownerWallet, version: state.version,
    lastAt: state.lastAccrualAt, previous: state.accruedShards, remainderBefore: state.productionRemainder,
    now, quota: capacity / BigInt(MINING.MINE_STORAGE_DAYS), capacity, gross: 0n,
    remainderAfter: 0n, targetBuffer: state.accruedShards, targetAt: state.lastAccrualAt, kind: 'capacity_discard' });
  const [updated] = await db.update(mineAccrualStates).set({ productionRemainder: 0n, version: state.version + 1 })
    .where(and(eq(mineAccrualStates.mineBuildingId, mineId), eq(mineAccrualStates.version, state.version))).returning();
  if (!updated) throw Error('Mine production capacity race');
  return updated;
}

/** Recompute only the notification deadline after a quota input changes at an
 * already-settled boundary. It deliberately does not touch balance, clock,
 * version, or cycle. */
export async function rescheduleBaseMineFullChecks(
  db: DbOrTx, baseId: string, now: Date,
): Promise<void> {
  const [base] = await db.select({ keepLevel: bases.keepLevel, ownerWallet: bases.ownerWallet })
    .from(bases).where(eq(bases.id, baseId));
  if (!base) throw new HttpError(404, 'base not found', 'BASE_NOT_FOUND');
  const mines = await producingMines(db, baseId, now);
  if (mines.length === 0) return;
  const [streakDays, epochBps, bonusBps] = await Promise.all([
    baseStreakDays(db, baseId), getEmissionMultBps(db),
    ownerReferralBonusBps(db, base.ownerWallet, now),
  ]);
  const states = await ensureAndLockMineStates(db, mines, now);
  const byId = new Map(mines.map((mine) => [mine.id, mine]));
  for (const state of states) {
    const mine = byId.get(state.mineBuildingId)!;
    const quota = oneMineQuota(base.keepLevel, mine.level, streakDays, epochBps, bonusBps);
    await db.update(mineAccrualStates).set({
      fullNotificationCheckAt: notificationCheckAt(projectMineFill(
        state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder,
      )),
    }).where(eq(mineAccrualStates.mineBuildingId, state.mineBuildingId));
  }
}

async function lockBaseMiningContext<T>(
  db: Db,
  wallet: string,
  context: StableBaseMutationContext,
  work: (tx: DbTx, keepLevel: number) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Canonical player -> base -> active slot lock order shared with transfer.
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const base = await lockStablePrerequisiteBase(tx, wallet, context);
    return work(tx, base.keepLevel);
  });
}

export async function collectBaseMines(
  db: Db,
  wallet: string,
  context: StableBaseMutationContext,
  now = new Date(),
): Promise<{ amount: bigint; mines: readonly { id: string; amount: bigint }[] }> {
  const result = await lockBaseMiningContext(db, wallet, context, async (tx, keepLevel) => {
    const mines = await producingMines(tx, context.baseId, now);
    if (mines.length === 0) throw new HttpError(422, 'build a Mine first');
    const streakDays = await baseStreakDays(tx, context.baseId);
    const epochBps = await getEmissionMultBps(tx);
    // The locked authority IS the owner (D-052): the collect settles at the
    // same bonus rate the status preview showed.
    const bonusBps = await ownerReferralBonusBps(tx, wallet, now);
    const states = await ensureAndLockMineStates(tx, mines, now);
    const byId = new Map(mines.map((mine) => [mine.id, mine]));
    const paid: Array<{ id: string; amount: bigint }> = [];
    let held = false;
    for (const state of states) {
      if (!await hasPhysicalMineTaxEra(tx, state.mineBuildingId)) {
        if (phaseEMiningEnabled()) throw new HttpError(503, 'Mine source admission required', 'SHARDS_SOURCE_REQUIRED');
        continue;
      }
      const mine = byId.get(state.mineBuildingId)!;
      const quota = oneMineQuota(keepLevel, mine.level, streakDays, epochBps, bonusBps);
      const projected = projectMineFill(state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder).accrued;
      await assertPhysicalMineTaxBuffer(tx, mine.id, state.accruedShards);
      const capture = { mineId: mine.id, baseId: context.baseId, wallet, version: state.version,
        lastAt: state.lastAccrualAt, now, gross: projected - state.accruedShards,
        quota: BigInt(quota), dayMs: BigInt(MINE_DAY_MS), remainder: state.productionRemainder ?? undefined };
      if (await physicalMineTaxHeld(tx, capture)) {
        held = true;
        await recordPhysicalMineTaxHold(tx, { ...capture, previous: state.accruedShards, projected });
      }
    }
    // Commit durable evidence while preserving the pre-existing fractional clock.
    if (held) return { amount: 0n, mines: paid, held: true };
    await lockPhysicalMineTaxWallets(tx, context.baseId, wallet);
    const batch = [];
    for (const state of states) {
      const mine = byId.get(state.mineBuildingId)!;
      const quota = oneMineQuota(keepLevel, mine.level, streakDays, epochBps, bonusBps);
      const projection = projectMineFill(state.accruedShards,state.lastAccrualAt,quota,now,state.productionRemainder);
      const amount = projection.accrued;
      const productionSettlementId = state.productionRemainder === null || amount === 0n ? undefined : await prepareMineProductionSettlement(tx, {
        mineId: mine.id, baseId: context.baseId, wallet, version: state.version,
        lastAt: state.lastAccrualAt, previous: state.accruedShards, remainderBefore: state.productionRemainder,
        now, quota: BigInt(quota), capacity: projection.capacity, gross: amount - state.accruedShards,
        remainderAfter: projection.remainder!, targetBuffer: 0n, targetAt: now, kind: 'collect',
      });
      if (await hasPhysicalMineTaxEra(tx,mine.id)) await recordPhysicalMineTaxAccrual(tx, {
        mineId:mine.id,baseId:context.baseId,wallet,version:state.version,lastAt:state.lastAccrualAt,
        now,gross:amount-state.accruedShards,quota:BigInt(quota),dayMs:BigInt(MINE_DAY_MS),
        remainder:state.productionRemainder??undefined,productionSettlementId });
      batch.push({mineId:mine.id,amount,operationKey:`mine.collect:${mine.id}:v${state.version}`});
    }
    const plans = await planPhysicalMineCollections(tx,batch,context.baseId,now);
    for (const state of states) {
      const mine = byId.get(state.mineBuildingId)!;
      const quota = oneMineQuota(keepLevel, mine.level, streakDays, epochBps, bonusBps);
      const projection = projectMineFill(state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder);
      const amount = projection.accrued;
      // Collect-all may drain a faster sibling before this Mine has earned a
      // whole SHARD. Preserve its clock (and notification/idempotency state)
      // so repeated empty taps cannot discard that elapsed fractional time.
      if (amount === 0n) {
        paid.push({ id: mine.id, amount });
        continue;
      }
      let net = amount;
      if (await hasPhysicalMineTaxEra(tx, mine.id)) {
        const key = `mine.collect:${mine.id}:v${state.version}`;
        const plan = plans.get(mine.id)!;
        const sys = await bootstrapSystemAccounts(tx);
        const base = await getOrCreateBaseAccount(tx, context.baseId, 'base_shards');
        const entries = [{ account: sys.shard_genesis, delta: -amount },
          ...(plan.net ? [{ account: base.id, delta: plan.net }] : []),
          ...(plan.tax ? [{ account: sys.shards_tax_escrow, delta: plan.tax }] : [])];
        const posted = await postTransaction(tx, { idempotencyKey: key, type: 'mine.collect', entries,
          metadata: { baseId: context.baseId, mineBuildingId: mine.id } });
        await finishPhysicalMineIssue(tx, plan, posted, entries, 'mine.collect');
        net = plan.net;
      } else {
        await rewardBaseShards(tx, context.baseId, amount, 'mine.collect',
          `mine.collect:${mine.id}:v${state.version}`, { mineBuildingId: mine.id });
      }
      const updated = await tx.update(mineAccrualStates).set({
        accruedShards: 0n,
        // Tracked earned fractions survive a positive drain; historical Mines
        // without this source clock keep their existing settlement behavior.
        lastAccrualAt: now,
        ...(state.productionRemainder === null ? {} : { productionRemainder: projection.remainder! }),
        fullNotificationCycle: amount > 0n ? state.fullNotificationCycle + 1 : state.fullNotificationCycle,
        // A real drain ends the pre-rollout buffer. A delayed bootstrap must
        // not suppress the next fill as if it were historical stock.
        fullNotificationBootstrapPending: amount > 0n ? false : state.fullNotificationBootstrapPending,
        fullNotificationCheckAt: notificationCheckAt(projectMineFill(0n, now, quota, now, projection.remainder)),
        version: state.version + 1,
      }).where(and(
        eq(mineAccrualStates.mineBuildingId, mine.id),
        eq(mineAccrualStates.version, state.version),
      )).returning({ id: mineAccrualStates.mineBuildingId });
      if (updated.length !== 1) throw new Error(`mine collection version race for ${mine.id}`);
      paid.push({ id: mine.id, amount: net });
    }
    return {
      amount: paid.reduce((sum, mine) => sum + mine.amount, 0n),
      mines: paid,
    };
  });
  if ('held' in result && result.held) throw new HttpError(503, 'Mine issuance held: original earning term unavailable', 'SHARDS_SOURCE_HELD');
  // D-052 (owner 2026-08-15): no referral sidecar any more — the referrer's
  // bonus is a quota factor inside oneMineQuota, so a referee's collect never
  // mints a second payment for anyone else.
  // M23 a15: collect quests tick on realized mining income only, AFTER the
  // credit committed — the same after-commit discipline the old sidecar used.
  if (result.amount > 0n) {
    const { progressQuestBatch } = await import('./quests');
    await progressQuestBatch(db, wallet, [
      ['collect_mines', 1],
      ['collect_1000_mined', Number(result.amount)],
    ], now, context.baseId);
  }
  return { amount: result.amount, mines: result.mines };
}

function utcDay(at: Date): string { return at.toISOString().slice(0, 10); }

function projectedStreak(currentDays: number, last: string | null, today: string): number {
  if (!last) return 1;
  const gap = Math.round((new Date(`${today}T00:00:00Z`).getTime()
    - new Date(`${last}T00:00:00Z`).getTime()) / MINE_DAY_MS);
  return gap === 1 ? currentDays + 1 : gap === 0 ? currentDays : 1;
}

function cacheAmount(everCompletedWeek1: boolean, streak: number): number {
  return !everCompletedWeek1
    ? Math.min(streak, DAILY_CACHE.consistencyStreakDays) * DAILY_CACHE.firstWeekStepShards
    : streak >= DAILY_CACHE.consistencyStreakDays
      ? DAILY_CACHE.consistentShards : DAILY_CACHE.baseShards;
}

export async function claimBaseDailyCache(
  db: Db,
  wallet: string,
  context: StableBaseMutationContext,
  now = new Date(),
): Promise<{ amount: bigint; streakDays: number; everCompletedWeek1: boolean }> {
  const result = await lockBaseMiningContext(db, wallet, context, async (tx) => {
    await tx.insert(baseStreaks).values({ baseId: context.baseId }).onConflictDoNothing();
    const [streak] = await tx.select().from(baseStreaks)
      .where(eq(baseStreaks.baseId, context.baseId)).for('update');
    if (!streak) throw new Error('base streak row vanished');
    // D-153.196: the reward is untaxed. Retain Mine parent/clock ordering
    // because crossing the cache streak boundary still changes Mine production.
    const mines = await tx.select({ id: buildings.id }).from(buildings)
      .where(and(eq(buildings.baseId, context.baseId), eq(buildings.type, 'mine')))
      .orderBy(buildings.id).for('update');
    if (mines.length) await tx.select().from(mineAccrualStates)
      .where(inArray(mineAccrualStates.mineBuildingId, mines.map(mine => mine.id)))
      .orderBy(mineAccrualStates.mineBuildingId).for('update');
    await lockPhysicalMineTaxActors(tx, [wallet]);
    await context.assertAuthority(tx, wallet, context.baseId);
    if (context.shardsCacheSource) now = new Date((context.shardsCacheSource.clock?.() ?? new Date()).getTime());
    if ((await producingMines(tx, context.baseId, now)).length === 0) {
      throw new HttpError(422, 'build a Mine first');
    }

    const today = utcDay(now);
    if (streak.cacheClaimedDay === today) throw new HttpError(422, 'already claimed today');
    const nextDays = projectedStreak(
      streak.currentDays, streak.cacheClaimedDay ?? streak.lastActiveDate, today,
    );
    const consistencyChanged =
      (streak.currentDays >= MINING.CONSISTENCY_STREAK_DAYS)
      !== (nextDays >= MINING.CONSISTENCY_STREAK_DAYS);
    if (consistencyChanged) await reanchorBaseMineAccrual(tx, context.baseId, now);
    const everCompletedWeek1 = streak.everCompletedWeek1
      || nextDays >= DAILY_CACHE.consistencyStreakDays;
    const amount = BigInt(cacheAmount(streak.everCompletedWeek1, nextDays));
    await tx.update(baseStreaks).set({
      currentDays: nextDays,
      lastActiveDate: today,
      cacheClaimedDay: today,
      everCompletedWeek1,
    }).where(eq(baseStreaks.baseId, context.baseId));
    if (consistencyChanged) await rescheduleBaseMineFullChecks(tx, context.baseId, now);
    if (amount > 0n) {
      await rewardBaseShards(tx, context.baseId, amount, 'cache.claim',
        `cache.claim:${context.baseId}:${today}`, { day: today, streakDays: nextDays });
    }
    return { amount, streakDays: nextDays, everCompletedWeek1 };
  });
  // M23 a15: the once-per-day guard above (cacheClaimedDay) already committed,
  // so this ticks at most once per UTC day per base.
  const { progressQuestBatch } = await import('./quests');
  await progressQuestBatch(db, wallet, [['claim_daily_cache', 1]], now, context.baseId);
  return result;
}

export async function getBaseMineStatus(
  db: Db,
  wallet: string,
  baseId: string,
  now = new Date(),
) {
  const base = await requireActiveStablePrerequisiteBase(db, wallet, baseId);
  const mines = await producingMines(db, baseId, now);
  const streakDays = await baseStreakDays(db, baseId);
  const epochBps = await getEmissionMultBps(db);
  const bonusBps = await ownerReferralBonusBps(db, wallet, now);
  const states = mines.length === 0 ? [] : await db.select().from(mineAccrualStates)
    .where(inArray(mineAccrualStates.mineBuildingId, mines.map((mine) => mine.id)));
  const stateById = new Map(states.map((state) => [state.mineBuildingId, state]));
  const perMine = mines.map((mine) => {
    const quota = oneMineQuota(base.keepLevel, mine.level, streakDays, epochBps, bonusBps);
    const state = stateById.get(mine.id);
    const projection = state
      ? projectMineFill(state.accruedShards, state.lastAccrualAt, quota, now, state.productionRemainder)
      : projectMineFill(0n, mine.productionStartedAt ?? now, quota, now);
    const accrued = projection.accrued;
    return {
      id: mine.id,
      level: mine.level,
      quotaPerDay: quota,
      accrued: Number(accrued),
      storageCap: Number(projection.capacity),
      full: accrued >= projection.capacity,
    };
  });
  const today = utcDay(now);
  const [streak] = await db.select().from(baseStreaks).where(eq(baseStreaks.baseId, baseId));
  const claimedToday = streak?.cacheClaimedDay === today;
  const projected = projectedStreak(
    streakDays, streak?.cacheClaimedDay ?? streak?.lastActiveDate ?? null, today,
  );
  const maxMines = MINING.MAX_MINES_BY_KEEP[Math.min(base.keepLevel, MINING.MAX_MINES_BY_KEEP.length) - 1]
    ?? MINING.MAX_MINES_BY_KEEP[MINING.MAX_MINES_BY_KEEP.length - 1]!;
  return {
    mining: {
      quotaPerDay: perMine.reduce((sum, mine) => sum + mine.quotaPerDay, 0),
      accrued: perMine.reduce((sum, mine) => sum + mine.accrued, 0),
      storageCap: perMine.reduce((sum, mine) => sum + mine.storageCap, 0),
      ratePerHour: Math.floor(perMine.reduce((sum, mine) => sum + mine.quotaPerDay, 0) / 24),
      mineCount: perMine.length,
      maxMines,
      mines: perMine,
    },
    cache: {
      streakDays,
      currentDay: Math.min(DAILY_CACHE.consistencyStreakDays, streakDays),
      cacheShards: cacheAmount(streak?.everCompletedWeek1 ?? false, claimedToday ? streakDays : projected),
      claimable: perMine.length > 0 && !claimedToday,
      nextClaimAt: new Date(`${utcDay(new Date(now.getTime() + MINE_DAY_MS))}T00:00:00Z`).toISOString(),
    },
  };
}

/** Exact server-internal sum used only before public bucketing. Callers must
 * never return this value directly: it is private loot-source state. */
export async function getBaseMineAccruedForPreview(
  db: Db, baseId: string, now = new Date(),
): Promise<bigint> {
  const [base] = await db.select({ keepLevel: bases.keepLevel, ownerWallet: bases.ownerWallet })
    .from(bases).where(eq(bases.id, baseId));
  if (!base) throw new HttpError(404, 'base not found', 'BASE_NOT_FOUND');
  const mines = await producingMines(db, baseId, now);
  if (mines.length === 0) return 0n;
  // A due upgrade is materialized at `now`: completeDueJobs first accrues the
  // elapsed interval at the stored (old) level, then advances the level. The
  // read-only preview must therefore keep the stored rate for this interval;
  // applying the new rate retroactively would overstate the frozen Mine buffer.
  const streakDays = await baseStreakDays(db, baseId);
  const epochBps = await getEmissionMultBps(db);
  const bonusBps = await ownerReferralBonusBps(db, base.ownerWallet, now);
  const states = await db.select().from(mineAccrualStates)
    .where(inArray(mineAccrualStates.mineBuildingId, mines.map((mine) => mine.id)));
  const byState = new Map(states.map((state) => [state.mineBuildingId, state]));
  return mines.reduce((sum, mine) => {
    const state = byState.get(mine.id);
    return sum + projectMineFill(
      state?.accruedShards ?? 0n,
      state?.lastAccrualAt ?? mine.productionStartedAt ?? now,
      oneMineQuota(base.keepLevel, mine.level, streakDays, epochBps, bonusBps),
      now, state?.productionRemainder,
    ).accrued;
  }, 0n);
}
