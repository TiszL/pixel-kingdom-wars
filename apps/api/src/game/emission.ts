/**
 * Mining (fixed per-player quota) + Daily Shard Cache (streak ladder).
 * Economy v3 — ECONOMY.md §2/§3, ✅ LOCKED 2026-06-13. SUPERSEDES the GDD §4.4
 * power-weighted pool-split (no pro-rata pool, no mining power, no 4.0 cap).
 *
 * MINING (§2): each Mine produces a FIXED daily quota (never diluted by player
 * count). CoC-style lazy accrual — the quota fills `mine_state.accruedShards`
 * over real time, clamped to a 1-day storage cap; production pauses when full
 * (nothing is ever seized). COLLECT credits the buffer to the ledger FROM the
 * emission pool and clears it. The quota is computed in PURE INTEGER basis-point
 * bigint math (no float touches a balance — CLAUDE.md hard rule):
 *   quota = MINE_QUOTA_BASE × mineBps × keepBps × consBps × epochBps / BPS_ONE^4.
 *
 * DAILY CACHE (§3): a small flat streak reward (NOT the mining quota, NOT
 * emission-split-per-player). First week ever ladders 100..700; afterwards 500/day
 * if the streak ≥ 7, else 100/day. Reaching a 7-day streak flips on the mining
 * CONSISTENCY bonus. Once per UTC day; a >1-day gap resets the streak to 1.
 *
 * TRANSACTION SAFETY (security review findings 1–4): COLLECT and CLAIM each run
 * in ONE db.transaction and lock the touched row FOR UPDATE (create-then-lock),
 * so concurrent taps credit exactly once and never over-mint the emission pool.
 * getMineStatus is READ-ONLY — it computes the display buffer in memory and
 * never persists (a GET must not mint or resurrect a spent buffer).
 */
import { DAILY_CACHE, MINING, getMiningQuota } from '@shardkeep/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  accounts, baseDailyActivity, bases, baseSlots, builderJobs, buildings, dailyActivity, mineState, players, streaks,
} from '../db/schema';
import { multiBaseEnabled } from '../config';
import { HttpError } from '../lib/errors';
import { getEmissionMultBps } from './gameConfig';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';

export const DAY_MS = 86_400_000;

export interface MineMutationContext {
  assertActiveAuthority: (tx: DbTx, wallet: string) => Promise<void>;
}

/** A public multi-base extraction must carry the route's pre-acquired evidence
 * into its money transaction. Requiring the context here prevents a future
 * caller from refreshing chain state and then forgetting the locked re-check. */
async function assertMineMutationAuthority(
  tx: DbTx, wallet: string, context?: MineMutationContext,
): Promise<void> {
  if (!multiBaseEnabled()) return;
  if (!context) {
    throw new HttpError(
      503, 'stable mine authority context is unavailable', 'DEED_AUTHORITY_UNAVAILABLE',
    );
  }
  await context.assertActiveAuthority(tx, wallet);
}

/** UTC day string YYYY-MM-DD. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Activity marking (proof-of-play / active tracking). Retained for telemetry
// and quest hooks; the cache STREAK advances on claimDailyCache, not here.
// ---------------------------------------------------------------------------

async function upsertActivity(db: DbOrTx, wallet: string, day: string): Promise<void> {
  await db.insert(dailyActivity).values({ playerWallet: wallet, day }).onConflictDoNothing();
}

async function upsertBaseActivity(db: DbOrTx, baseId: string, day: string): Promise<void> {
  await db.insert(baseDailyActivity).values({ baseId, day }).onConflictDoNothing();
}

export async function markBuildAction(
  db: DbOrTx, wallet: string, at = new Date(), baseId?: string,
): Promise<void> {
  const day = utcDay(at);
  if (baseId) {
    await upsertBaseActivity(db, baseId, day);
    await db.update(baseDailyActivity).set({ builds: sql`${baseDailyActivity.builds} + 1` })
      .where(and(eq(baseDailyActivity.baseId, baseId), eq(baseDailyActivity.day, day)));
    return;
  }
  await upsertActivity(db, wallet, day);
  await db.update(dailyActivity).set({ builds: sql`${dailyActivity.builds} + 1` })
    .where(and(eq(dailyActivity.playerWallet, wallet), eq(dailyActivity.day, day)));
}

export async function markRaidAction(
  db: Db, wallet: string, at = new Date(), baseId?: string,
): Promise<void> {
  const day = utcDay(at);
  if (baseId) {
    await upsertBaseActivity(db, baseId, day);
    await db.update(baseDailyActivity).set({ raids: sql`${baseDailyActivity.raids} + 1` })
      .where(and(eq(baseDailyActivity.baseId, baseId), eq(baseDailyActivity.day, day)));
    return;
  }
  await upsertActivity(db, wallet, day);
  await db.update(dailyActivity).set({ raids: sql`${dailyActivity.raids} + 1` })
    .where(and(eq(dailyActivity.playerWallet, wallet), eq(dailyActivity.day, day)));
}

// ---------------------------------------------------------------------------
// Mining quota (ECONOMY.md §2) — pure integer basis-point bigint math
// ---------------------------------------------------------------------------

/** Highest completed mine level a player owns, 0 if none. */
async function highestMineLevel(db: DbOrTx, wallet: string): Promise<number> {
  const levels = await mineLevelsFor(db, wallet);
  return levels.reduce((max, level) => Math.max(max, level), 0);
}

/**
 * The mining reward formula (getMiningQuota) now lives in @shardkeep/shared
 * (packages/shared/src/mining.ts) so the server, the #45 emission controller, and
 * the #47 economic simulation share ONE source. Re-exported here so existing
 * importers (tests, base HUD math) are unchanged. Callers that MINT pass the live
 * emission multiplier (quotaFor / getMineStatus below); the default 4th arg is the
 * compile-time MINING.EPOCH_RATE_BPS (1.0×), preserving old behavior + fixtures.
 */
export { getMiningQuota };

/**
 * Every PRODUCING mine's level for a player (empty = none producing). A mine only
 * contributes to the quota once its build job COMPLETES — a still-under-construction
 * mine is excluded (LEFT JOIN on an incomplete 'build' job), so adding a mine can't
 * raise the quota before it exists (security review 2026-07-19, over-credit fix).
 * `excludeBuildingId` drops one specific mine — used when re-anchoring the accrual
 * clock the instant a mine's build completes, so the settle uses the PRIOR quota.
 */
async function mineLevelsFor(db: DbOrTx, wallet: string, excludeBuildingId?: string): Promise<number[]> {
  if (multiBaseEnabled()) {
    const profiles = await activeBaseMineProfiles(db, wallet, excludeBuildingId);
    return profiles.flatMap((profile) => profile.levels);
  }
  const rows = await db.select({ id: buildings.id, level: buildings.level, pendingBuild: builderJobs.id })
    .from(buildings)
    .leftJoin(builderJobs, and(
      eq(builderJobs.buildingId, buildings.id),
      eq(builderJobs.kind, 'build'),
      isNull(builderJobs.completedAt),
    ))
    .where(and(eq(buildings.playerWallet, wallet), eq(buildings.type, 'mine')));
  return rows
    .filter((r) => r.pendingBuild === null && r.id !== excludeBuildingId)
    .map((r) => r.level);
}

interface ActiveBaseMineProfile { id: string; keepLevel: number; levels: number[] }

/** Stable-base mining inputs. Child wallet columns deliberately remain the
 * seller after a deed transfer, so authority and quota must follow base_id plus
 * the current active-slot owner—not buildings.player_wallet. */
async function activeBaseMineProfiles(
  db: DbOrTx, wallet: string, excludeBuildingId?: string,
): Promise<ActiveBaseMineProfile[]> {
  const active = await db.select({ id: bases.id, keepLevel: bases.keepLevel })
    .from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active')));
  if (active.length === 0) return [];
  const ids = active.map((base) => base.id);
  const mines = await db.select({
    id: buildings.id, baseId: buildings.baseId, level: buildings.level,
    pendingBuild: builderJobs.id,
  }).from(buildings)
    .leftJoin(builderJobs, and(
      eq(builderJobs.buildingId, buildings.id), eq(builderJobs.kind, 'build'),
      isNull(builderJobs.completedAt),
    ))
    .where(and(inArray(buildings.baseId, ids), eq(buildings.type, 'mine')));
  return active.map((base) => ({
    ...base,
    levels: mines
      .filter((mine) => mine.baseId === base.id && mine.pendingBuild === null && mine.id !== excludeBuildingId)
      .map((mine) => mine.level),
  }));
}

/** Compute every active base independently and use only the strongest legal
 * quota. Five deeds therefore never multiply the wallet-wide shard faucet. */
export async function maxActiveMineQuota(
  db: DbOrTx, wallet: string, streakDays: number, epochBps: number,
  excludeBuildingId?: string,
): Promise<number> {
  const profiles = await activeBaseMineProfiles(db, wallet, excludeBuildingId);
  return profiles.reduce((max, profile) => Math.max(
    max, getMiningQuota(profile.keepLevel, profile.levels, streakDays, epochBps),
  ), 0);
}

/** Resolve a player's live summed quota from all their PRODUCING mines + cache
 *  streak. `excludeBuildingId` drops one mine (used by reanchorMineAccrual). */
async function quotaFor(db: DbOrTx, wallet: string, excludeBuildingId?: string): Promise<number> {
  const [s] = await db.select({ days: streaks.currentDays }).from(streaks)
    .where(eq(streaks.playerWallet, wallet));
  // Live emission multiplier (#45): the treasury-aware controller's throttle takes
  // effect at this player's next collect, no player iteration (lazy accrual).
  const epochBps = await getEmissionMultBps(db);
  if (multiBaseEnabled()) {
    return maxActiveMineQuota(db, wallet, s?.days ?? 0, epochBps, excludeBuildingId);
  }
  const [player] = await db.select({ keepLevel: players.keepLevel }).from(players)
    .where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  const levels = await mineLevelsFor(db, wallet, excludeBuildingId);
  return getMiningQuota(player.keepLevel, levels, s?.days ?? 0, epochBps);
}

// ---------------------------------------------------------------------------
// Lazy accrual (ECONOMY.md §2) — a PURE function; persistence is the caller's
// (only the transactional collectMine writes accrual, under the row lock).
// ---------------------------------------------------------------------------

/**
 * Buffer after accruing continuously from `lastAccrualAt` to `now` at `quota`
 * per day, clamped to the 1-day storage cap and NEVER decreasing (we don't seize
 * an over-full buffer if the quota later dropped). Integer-safe:
 *   gain = floor(quota × elapsedMs / DAY_MS).
 */
export function accrue(prevAccrued: bigint, lastAccrualAt: Date, quota: number, now: Date): bigint {
  const elapsedMs = now.getTime() - lastAccrualAt.getTime();
  if (elapsedMs <= 0 || quota <= 0) return prevAccrued;
  const cap = BigInt(quota) * BigInt(MINING.MINE_STORAGE_DAYS);
  const gain = (BigInt(quota) * BigInt(elapsedMs)) / BigInt(DAY_MS);
  const next = prevAccrued + gain;
  if (next > cap) return prevAccrued > cap ? prevAccrued : cap; // pause at cap, never seize
  return next;
}

/**
 * Ensures the accrual anchor row exists (idempotent). Called when a Mine build
 * completes so accrual starts ticking at build time (not first collect). Safe
 * under concurrency via the mine_state PK + onConflictDoNothing.
 */
export async function ensureMineState(db: DbOrTx, wallet: string, now = new Date()): Promise<void> {
  await db.insert(mineState)
    .values({ playerWallet: wallet, accruedShards: 0n, lastAccrualAt: now })
    .onConflictDoNothing();
}

/**
 * Settle the accrual buffer at the CURRENT quota and advance the clock to `now`
 * WITHOUT paying out — called under the SAME transaction, right BEFORE an event
 * RAISES the summed quota (a mine build/upgrade or Keep upgrade completing, or the
 * cache streak crossing the 7-day consistency line). Banking the buffer first at
 * the OLD rate means the higher rate applies only from `now` forward, so newly
 * added capacity can never back-credit income for a window it did not exist in
 * (security review 2026-07-19 over-credit fix). No-op if the player has no
 * mine_state yet (nothing has accrued). `excludeBuildingId` computes the settle
 * quota with one mine dropped — used at a mine's build completion, whose job row
 * is already marked done (so it would otherwise count) but must NOT count yet.
 * Locks mine_state FOR UPDATE so it serializes with a concurrent collect.
 */
export async function reanchorMineAccrual(
  tx: DbOrTx, wallet: string, now: Date, excludeBuildingId?: string,
): Promise<void> {
  const [row] = await tx.select().from(mineState)
    .where(eq(mineState.playerWallet, wallet)).for('update');
  if (!row) return;
  const quota = await quotaFor(tx, wallet, excludeBuildingId);
  const settled = accrue(row.accruedShards, row.lastAccrualAt, quota, now);
  await tx.update(mineState)
    .set({ accruedShards: settled, lastAccrualAt: now })
    .where(eq(mineState.playerWallet, wallet));
}

// ---------------------------------------------------------------------------
// COLLECT (ECONOMY.md §2) — transactional, row-locked, cap-safe
// ---------------------------------------------------------------------------

/**
 * COLLECT the Mine: settle accrual, credit the buffer to the player's KEEP
 * account FROM emission_pool, clear the buffer — all in ONE transaction:
 *  1. create-then-SELECT-FOR-UPDATE the mine_state row (serializes same-player taps);
 *  2. settle the buffer in memory (pure `accrue`);
 *  3. SELECT-FOR-UPDATE emission_pool and CLAMP the credit to its balance — the
 *     ledger's non-negative invariant on emission_pool IS the lifetime cap, so
 *     concurrent collects near an empty pool can never over-mint;
 *  4. post one idempotent txn (stable key = the pre-settle lastAccrualAt), then
 *     write back `settled − minted` and advance the accrual clock to `now`.
 * A double-tap therefore credits ONCE (the 2nd sees an empty, freshly-clocked
 * buffer).
 */
export async function collectMine(
  db: Db, wallet: string, now = new Date(), context?: MineMutationContext,
): Promise<{ amount: bigint }> {
  const result = await db.transaction(async (tx) => {
    // Canonical multi-base boundary: player -> every active base -> slots ->
    // finalized evidence, all before mine_state or ledger rows. The callback
    // performs no RPC and rejects a transfer/aged proof that won the lock race.
    await assertMineMutationAuthority(tx, wallet, context);
    const mineLevel = await highestMineLevel(tx, wallet);
    if (mineLevel <= 0) throw new HttpError(422, 'build a Mine first');

    // 1. Anchor row must exist, then lock it (create-then-lock so the very first
    //    collect also serializes concurrent taps).
    await tx.insert(mineState)
      .values({ playerWallet: wallet, accruedShards: 0n, lastAccrualAt: now })
      .onConflictDoNothing();
    const [row] = await tx.select().from(mineState)
      .where(eq(mineState.playerWallet, wallet)).for('update');
    if (!row) throw new HttpError(500, 'mine_state vanished');

    // 2. Settle the buffer in memory.
    const quota = await quotaFor(tx, wallet);
    const settled = accrue(row.accruedShards, row.lastAccrualAt, quota, now);
    const stableKey = `mine.collect:${wallet}:${row.lastAccrualAt.toISOString()}`;

    if (settled <= 0n) {
      await tx.update(mineState).set({ accruedShards: 0n, lastAccrualAt: now })
        .where(eq(mineState.playerWallet, wallet));
      return { amount: 0n, stableKey };
    }

    // 3. DUAL-CURRENCY SPLIT (owner 2026-07-24, ITEMS plan §3): mining now
    // mints SHARDS from shard_genesis — the soft currency has no pool cap, so
    // the old emission_pool clamp is gone. KEEP enters play ONLY through the
    // Gold Forge's daily budget (game/forge.ts), which is what the 500M pool
    // and the #45 controller now govern. The mining quota (epochBps) remains
    // the shard-rate throttle.
    const sys = await bootstrapSystemAccounts(tx);
    const amount = settled;

    // 4. Credit + write back the leftover and advance the clock.
    if (amount > 0n) {
      const player = await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
      await postTransaction(tx, {
        idempotencyKey: stableKey,
        type: 'mine.collect',
        entries: [
          { account: sys.shard_genesis, delta: -amount },
          { account: player.id, delta: amount },
        ],
        metadata: { wallet },
      });
    }
    await tx.update(mineState)
      .set({ accruedShards: settled - amount, lastAccrualAt: now })
      .where(eq(mineState.playerWallet, wallet));
    return { amount, stableKey };
  });

  // D-052 (owner 2026-08-15): the 5%-match sidecar is gone. This legacy
  // wallet-mode collect path is dead in production (the deed-economy fence is
  // permanently `ready`), so it deliberately does NOT gain the v2 referral
  // quota bonus either — stable-mode baseMining owns that.
  // M23 a15: collect quests tick on realized mining income only, AFTER the
  // credit committed. Dynamic import: quests.ts statically imports utcDay
  // from this module.
  if (result.amount > 0n) {
    const { progressQuestBatch } = await import('./quests');
    await progressQuestBatch(db, wallet, [
      ['collect_mines', 1],
      ['collect_1000_mined', Number(result.amount)],
    ], now);
  }
  return { amount: result.amount };
}

// ---------------------------------------------------------------------------
// Daily Shard Cache — streak state machine (ECONOMY.md §3), transactional
// ---------------------------------------------------------------------------

/** Compute the cache reward for a given (post-increment) streak + week-1 flag. */
function cacheShardsFor(everCompletedWeek1: boolean, newStreak: number): number {
  if (!everCompletedWeek1) {
    return Math.min(newStreak, DAILY_CACHE.consistencyStreakDays) * DAILY_CACHE.firstWeekStepShards;
  }
  return newStreak >= DAILY_CACHE.consistencyStreakDays ? DAILY_CACHE.consistentShards : DAILY_CACHE.baseShards;
}

/** Projected next streak from the last claimed/active day (gap 1 → +1, 0 → same, else 1). */
function projectStreak(currentDays: number, last: string | null, today: string): number {
  if (!last) return 1;
  const gapDays = Math.round(
    (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${last}T00:00:00Z`).getTime()) / DAY_MS,
  );
  if (gapDays === 1) return currentDays + 1;
  if (gapDays === 0) return currentDays;
  return 1;
}

/**
 * Claim today's Daily Shard Cache (ECONOMY.md §3). Requires a Mine. Once per UTC
 * day. Runs in ONE transaction with the streak row locked FOR UPDATE (create-
 * then-lock) so the day-check, streak advance, credit, and upsert are atomic:
 * two concurrent claims → exactly one credit, the second rejected. Advances the
 * streak (consecutive day → +1; gap >1 → reset to 1); on the first 7-day
 * completion latches everCompletedWeek1. Reward is capped by emission_pool (the
 * cache draws from the same play pool as mining).
 */
export async function claimDailyCache(
  db: Db, wallet: string, now = new Date(), context?: MineMutationContext,
): Promise<{
  amount: bigint; streakDays: number; everCompletedWeek1: boolean;
}> {
  const today = utcDay(now);

  const result = await db.transaction(async (tx) => {
    await assertMineMutationAuthority(tx, wallet, context);
    const mineLevel = await highestMineLevel(tx, wallet);
    if (mineLevel <= 0) throw new HttpError(422, 'build a Mine first');

    // Lock the streak row (create-then-lock) so concurrent claims serialize.
    await tx.insert(streaks).values({ playerWallet: wallet, currentDays: 0 }).onConflictDoNothing();
    const [s] = await tx.select().from(streaks).where(eq(streaks.playerWallet, wallet)).for('update');
    if (!s) throw new HttpError(500, 'streak row vanished');
    if (s.cacheClaimedDay === today) throw new HttpError(422, 'already claimed today');

    const newStreak = projectStreak(s.currentDays, s.cacheClaimedDay ?? s.lastActiveDate ?? null, today);
    const wasCompleted = s.everCompletedWeek1;
    const amount = BigInt(cacheShardsFor(wasCompleted, newStreak));
    const everCompletedWeek1 = wasCompleted || newStreak >= DAILY_CACHE.consistencyStreakDays;

    // Crossing the 7-day line flips the ×1.4 mining bonus on (or off, on a reset),
    // changing the quota. Settle the mine buffer at the OLD streak's rate first so
    // the new rate never applies to the window before it flipped (over-credit fix).
    const crossedConsistency =
      (s.currentDays >= MINING.CONSISTENCY_STREAK_DAYS) !== (newStreak >= MINING.CONSISTENCY_STREAK_DAYS);
    if (crossedConsistency) await reanchorMineAccrual(tx, wallet, now);

    await tx.update(streaks)
      .set({ currentDays: newStreak, lastActiveDate: today, cacheClaimedDay: today, everCompletedWeek1 })
      .where(eq(streaks.playerWallet, wallet));

    if (amount > 0n) {
      // DUAL-CURRENCY SPLIT: the Daily SHARD Cache pays literal shards now —
      // it feeds the mining/streak loop, not the KEEP pool (which only funds
      // the Gold Forge). No pool clamp: shards mint from shard_genesis.
      const sys = await bootstrapSystemAccounts(tx);
      const player = await getOrCreatePlayerAccount(tx, wallet, 'player_shards');
      await postTransaction(tx, {
        idempotencyKey: `cache.claim:${wallet}:${today}`,
        type: 'cache.claim',
        entries: [
          { account: sys.shard_genesis, delta: -amount },
          { account: player.id, delta: amount },
        ],
        metadata: { wallet, day: today, streakDays: newStreak },
      });
    }
    return { amount, streakDays: newStreak, everCompletedWeek1 };
  });
  // M23 a15: the once-per-day guard above (cacheClaimedDay) already committed,
  // so this ticks at most once per UTC day. Dynamic import (see collectMine).
  const { progressQuestBatch } = await import('./quests');
  await progressQuestBatch(db, wallet, [['claim_daily_cache', 1]], now);
  return result;
}

// ---------------------------------------------------------------------------
// Read-only status for the Mine sheet + Claim screen + HUD pill (ECONOMY.md §2/§3)
// ---------------------------------------------------------------------------

interface StreakRow {
  currentDays: number;
  lastActiveDate: string | null;
  everCompletedWeek1: boolean;
  cacheClaimedDay: string | null;
}

/**
 * Mining + cache status. STRICTLY READ-ONLY (security review finding 2): it
 * computes the display buffer in memory via `accrue` and NEVER persists — a GET
 * must not mint, advance the accrual clock, or resurrect a spent buffer. Only
 * collectMine writes accrual (under its row lock).
 */
export async function getMineStatus(db: Db, wallet: string, now = new Date()) {
  const [player] = await db.select({ keepLevel: players.keepLevel }).from(players)
    .where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  const levels = await mineLevelsFor(db, wallet);
  const hasMine = levels.length > 0;
  const today = utcDay(now);
  const [s] = await db.select().from(streaks).where(eq(streaks.playerWallet, wallet)) as StreakRow[];
  const streakDays = s?.currentDays ?? 0;

  // Mining side — compute the live buffer in memory (no writes). The HUD reflects
  // the controller multiplier (#45) for free, so players see the current rate.
  const epochBps = await getEmissionMultBps(db);
  const quota = hasMine
    ? multiBaseEnabled()
      ? await maxActiveMineQuota(db, wallet, streakDays, epochBps)
      : getMiningQuota(player.keepLevel, levels, streakDays, epochBps)
    : 0;
  const storageCap = BigInt(quota) * BigInt(MINING.MINE_STORAGE_DAYS);
  let accrued = 0n;
  if (hasMine) {
    const [mine] = await db.select().from(mineState).where(eq(mineState.playerWallet, wallet));
    if (mine) accrued = accrue(mine.accruedShards, mine.lastAccrualAt, quota, now);
  }
  const [activeKeep] = multiBaseEnabled()
    ? await db.select({ level: sql<number>`coalesce(max(${bases.keepLevel}), 1)::int` })
      .from(baseSlots).innerJoin(bases, eq(bases.id, baseSlots.baseId))
      .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true), eq(bases.status, 'active')))
    : [{ level: player.keepLevel }];
  const keepLevel = activeKeep?.level ?? 1;
  const maxMines = MINING.MAX_MINES_BY_KEEP[Math.min(keepLevel, MINING.MAX_MINES_BY_KEEP.length) - 1]
    ?? MINING.MAX_MINES_BY_KEEP[MINING.MAX_MINES_BY_KEEP.length - 1]!;

  // Cache side — what today's claim would pay + whether it's claimable.
  const claimedToday = s?.cacheClaimedDay === today;
  const projectedStreak = projectStreak(streakDays, s?.cacheClaimedDay ?? s?.lastActiveDate ?? null, today);
  const cacheShards = cacheShardsFor(
    s?.everCompletedWeek1 ?? false,
    claimedToday ? streakDays : projectedStreak,
  );
  const currentDay = Math.min(DAILY_CACHE.consistencyStreakDays, streakDays); // lit dot 0–7
  const next = new Date(`${utcDay(new Date(now.getTime() + DAY_MS))}T00:00:00Z`);

  return {
    mining: {
      quotaPerDay: quota,
      accrued: Number(accrued),
      storageCap: Number(storageCap),
      ratePerHour: Math.floor(quota / 24),
      mineCount: levels.length,
      maxMines,
    },
    cache: {
      streakDays,
      currentDay,
      cacheShards,
      claimable: hasMine && !claimedToday,
      nextClaimAt: next.toISOString(),
    },
  };
}
