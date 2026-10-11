/**
 * Tester program (owner 2026-08-21): alpha testers earn points for verified
 * game actions plus rated feedback; a public board lives on the landing site and
 * an in-game TESTER screen shows each wallet its progress.
 *
 * Every milestone is DERIVED from the authoritative tables (ledger, raids,
 * deposits, …) by `detectMilestones`, so existing players are backfilled and a
 * recompute is idempotent: `tester_milestones` has a (wallet, key) primary key
 * and inserts are `on conflict do nothing`. Points are frozen at insert. A
 * milestone is never un-earned even when its signal regresses (tutorial reset,
 * 2FA disabled, gear unequipped) — that is the point of the latch table.
 *
 * Daily points (D-103, owner 2026-09-04): a second ledger,
 * `tester_daily_points`, pays each `TESTER_DAILY` source at most once per UTC
 * day (capped sources up to their cap), derived by the same recompute from the
 * same authoritative tables through `actionDay.ts`. Rows are insert-or-raise
 * only — a count is never lowered, a row never deleted — so the recompute is
 * idempotent and safe under the sweep and the on-demand path at once. Every
 * daily point adds to the all-time total the public board shows.
 *
 * Nothing here moves money or game state; the whole module is read-only over
 * the game and append-only over its own tables.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FEEDBACK_CLIENTS, FEEDBACK_THREADS, FEEDBACK_ISSUES, type FeedbackClient } from '@shardkeep/shared/feedback';
import { TESTER_DAILY, TESTER_PROGRAM, type TesterDailyKey, type TesterMilestoneKey } from '@shardkeep/shared';
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import type { Config } from '../config';
import { feedbackLastExportedRevision } from './feedbackExports';
import type { Db, DbOrTx } from '../db/client';
import { feedbackIssueLinks, players, testerBoardHidden, testerDailyPoints, testerFeedback, testerMilestones } from '../db/schema';
import { notInternalPlaytestWallet } from './playtestEligibility';
import { HttpError } from '../lib/errors';
import { serverTrack } from '../telemetry';
import { lockFeedbackModeration } from './feedbackRewards';
import { FeedbackClientOriginContext, feedbackOriginSql, type FeedbackClientOrigin } from './feedbackOrigin';
import { actionDayCounts, actionDaysOf, shiftDay, utcDay, utcDaysEndingAt } from './actionDay';

type Row = Record<string, unknown>;

const MILESTONES = TESTER_PROGRAM.milestones;
const POINTS_BY_KEY = new Map<string, number>(MILESTONES.map((m) => [m.key, m.points]));
const DAILY_SOURCES = new Map(TESTER_DAILY.sources.map((s) => [s.key as TesterDailyKey, s]));
const DAILY_PLAYED = TESTER_DAILY.sources.find((s) => s.key === 'played')!;
/** Longest streak bonus — bounds how far back the streak walk must look. */
const MAX_STREAK_DAYS = Math.max(...TESTER_DAILY.streaks.map((s) => s.days));

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function asInt(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** First ledger transaction of `type` that touched any account owned by the
 * wallet directly or through one of its bases (both economy arms). */
function ledgerFirst(wallet: string, type: string): SQL {
  return sql`select min(t.created_at) as achieved_at from ledger_transactions t
    where t.type = ${type} and exists (
      select 1 from ledger_entries e
        join accounts a on a.id = e.account_id
        left join bases b on b.id = a.base_id
      where e.txn_id = t.id and (a.owner_wallet = ${wallet} or b.owner_wallet = ${wallet}))`;
}

/** Every ledger transaction time of `type` for the wallet, oldest first. */
function ledgerTimes(wallet: string, type: string): SQL {
  return sql`select t.created_at as at from ledger_transactions t
    where t.type = ${type} and exists (
      select 1 from ledger_entries e
        join accounts a on a.id = e.account_id
        left join bases b on b.id = a.base_id
      where e.txn_id = t.id and (a.owner_wallet = ${wallet} or b.owner_wallet = ${wallet}))
    order by t.created_at asc`;
}

async function one(db: DbOrTx, query: SQL): Promise<Date | null> {
  const rows = await db.execute<Row>(query);
  const first = (rows as unknown as Row[])[0];
  return first ? asDate(first['achieved_at']) : null;
}

async function times(db: DbOrTx, query: SQL): Promise<Date[]> {
  const rows = await db.execute<Row>(query);
  return (rows as unknown as Row[]).map((r) => asDate(r['at'])).filter((d): d is Date => d !== null);
}

/** The Nth event time (1-based) or null when fewer events exist. */
function nth(sorted: readonly Date[], n: number): Date | null {
  return sorted.length >= n ? sorted[n - 1]! : null;
}

/**
 * Detect every milestone the wallet has earned, with the best available event
 * time. Each detector reads one authoritative surface; nothing is inferred from
 * the tester tables themselves. Returns only earned keys.
 */
export async function detectMilestones(db: DbOrTx, wallet: string): Promise<Map<TesterMilestoneKey, Date>> {
  const earned = new Map<TesterMilestoneKey, Date>();
  const set = (key: TesterMilestoneKey, at: Date | null): void => { if (at) earned.set(key, at); };
  const w = wallet;

  // --- First steps -----------------------------------------------------------
  set('signed_in', await one(db, sql`select created_at as achieved_at from players where wallet = ${w}`));
  set('name_set', await one(db, sql`select coalesce(name_changed_at, now()) as achieved_at from players
    where wallet = ${w} and name_key <> ''`));
  set('avatar_set', await one(db, sql`select coalesce(avatar_updated_at, now()) as achieved_at from players
    where wallet = ${w} and avatar_hash is not null`));
  set('tutorial_done', await one(db, sql`select completed_at as achieved_at from tutorial_progress
    where player_wallet = ${w} and completed_at is not null`));
  set('base_founded', await one(db, sql`select coalesce(
      (select min(created_at) from bases where owner_wallet = ${w}),
      case when exists (select 1 from buildings where player_wallet = ${w} and type = 'keep') then now() end
    ) as achieved_at`));
  // A cancelled upgrade (D-104) sets completed_at too; only a landed one counts.
  set('mine_upgraded', await one(db, sql`select coalesce(
      (select min(j.completed_at) from builder_jobs j join buildings b on b.id = j.building_id
        where j.player_wallet = ${w} and j.kind = 'upgrade' and b.type = 'mine'
          and j.completed_at is not null and j.cancelled_at is null),
      case when exists (select 1 from buildings where player_wallet = ${w} and type = 'mine' and level >= 2) then now() end
    ) as achieved_at`));
  set('mine_collected', await one(db, ledgerFirst(w, 'mine.collect')));
  set('cache_claimed', await one(db, ledgerFirst(w, 'cache.claim')));
  set('building_upgraded', await one(db, sql`select least(
      (select min(completed_at) from builder_jobs where player_wallet = ${w} and kind = 'upgrade'
        and completed_at is not null and cancelled_at is null),
      (select min(t.created_at) from ledger_transactions t
        where t.type = 'build.upgrade'
          and not exists (select 1 from builder_jobs cj where cj.debit_ledger_txn_id = t.id and cj.cancelled_at is not null)
          and exists (
            select 1 from ledger_entries e
              join accounts a on a.id = e.account_id
              left join bases b on b.id = a.base_id
            where e.txn_id = t.id and (a.owner_wallet = ${w} or b.owner_wallet = ${w})))
    ) as achieved_at`));

  // --- Progression -------------------------------------------------------------
  const keepRows = await db.execute<Row>(sql`select greatest(
      (select coalesce(max(keep_level), 0) from bases where owner_wallet = ${w}),
      (select coalesce(keep_level, 0) from players where wallet = ${w})
    ) as keep_level`);
  const keepLevel = asInt(((keepRows as unknown as Row[])[0] ?? {})['keep_level']);
  for (const [key, level] of [['keep_l3', 3], ['keep_l5', 5], ['keep_l8', 8], ['keep_l10', 10], ['keep_l15', 15], ['keep_l20', 20]] as const) {
    if (keepLevel >= level) earned.set(key, new Date());
  }
  const questClaims = await times(db, sql`select claimed_at as at from (
      select claimed_at from quest_progress where player_wallet = ${w} and claimed_at is not null
      union all
      select q.claimed_at from base_quest_progress q join bases b on b.id = q.base_id
        where b.owner_wallet = ${w} and q.claimed_at is not null
    ) x order by claimed_at asc`);
  set('quests_10', nth(questClaims, 10));
  set('quests_50', nth(questClaims, 50));

  // --- Army & heroes -----------------------------------------------------------
  const trains = await times(db, ledgerTimes(w, 'army.train'));
  set('troops_trained', nth(trains, 1));
  set('troops_trained_10', nth(trains, 10));
  set('hero_recruited', await one(db, ledgerFirst(w, 'hero.recruit')));
  set('gear_equipped', await one(db, sql`select min(at) as achieved_at from (
      select equipped_at as at from hero_equipment where player_wallet = ${w}
      union all
      select e.equipped_at from base_hero_equipment e join bases b on b.id = e.base_id where b.owner_wallet = ${w}
    ) x`));
  set('item_used', await one(db, sql`select min(used_at) as achieved_at from item_uses where player_wallet = ${w}`));
  set('elite_unlocked', await one(db, sql`select min(created_at) as achieved_at from troop_unlocks
    where player_wallet = ${w} and source = 'item'`));

  // --- Combat ------------------------------------------------------------------
  const pvpRaids = await times(db, sql`select coalesce(resolved_at, created_at) as at from raids
    where attacker_wallet = ${w} and defender_wallet is not null and status = 'resolved'
    order by coalesce(resolved_at, created_at) asc`);
  set('raid_attack', nth(pvpRaids, 1));
  set('raid_attack_10', nth(pvpRaids, 10));
  set('raid_attack_50', nth(pvpRaids, 50));
  set('raid_star', await one(db, sql`select least(
      (select min(created_at) from base_battle_records where owner_wallet_at_battle = ${w} and role = 'attacker' and stars >= 1),
      (select min(coalesce(resolved_at, created_at)) from raids where attacker_wallet = ${w} and defender_wallet is not null
        and status = 'resolved' and coalesce((result->>'stars')::int, 0) >= 1)
    ) as achieved_at`));
  set('raid_three_stars', await one(db, sql`select least(
      (select min(created_at) from base_battle_records where owner_wallet_at_battle = ${w} and role = 'attacker' and stars = 3),
      (select min(coalesce(resolved_at, created_at)) from raids where attacker_wallet = ${w} and defender_wallet is not null
        and status = 'resolved' and coalesce((result->>'stars')::int, 0) = 3)
    ) as achieved_at`));
  set('defense_held', await one(db, sql`select least(
      (select min(created_at) from base_battle_records where owner_wallet_at_battle = ${w} and role = 'defender' and stars = 0),
      (select min(coalesce(resolved_at, created_at)) from raids where defender_wallet = ${w}
        and status = 'resolved' and coalesce((result->>'stars')::int, 0) = 0)
    ) as achieved_at`));
  const campaignStage = async (stage: number): Promise<Date | null> => one(db, sql`select min(at) as achieved_at from (
      select updated_at as at from campaign_progress where player_wallet = ${w} and best_stars > 0 and stage >= ${stage}
      union all
      select p.updated_at from base_campaign_progress p join bases b on b.id = p.base_id
        where b.owner_wallet = ${w} and p.best_stars > 0 and p.stage >= ${stage}
    ) x`);
  set('campaign_stage', await campaignStage(1));
  set('campaign_stage_10', await campaignStage(10));
  set('campaign_stage_25', await campaignStage(25));
  // 'pve_bounty' retired 2026-08-23 (D-069: PvE is the Campaign only); latched rows keep their points.

  // --- Economy -----------------------------------------------------------------
  // D-103: "built gold forge" is a headline playtest metric — the building
  // itself, before any Shards are deployed into it (both economy arms).
  set('forge_built', await one(db, sql`select case when exists (
      select 1 from buildings g left join bases gb on gb.id = g.base_id
      where g.type = 'goldforge' and coalesce(gb.owner_wallet, g.player_wallet) = ${w}
    ) then now() end as achieved_at`));
  set('forge_deployed', await one(db, ledgerFirst(w, 'forge.contribute')));
  set('forge_claimed', await one(db, ledgerFirst(w, 'forge.claim')));
  set('forge_drop', await one(db, sql`select min(at) as achieved_at from (
      select coalesce(settled_at, updated_at) as at from base_forge_positions
        where settlement_owner_wallet = ${w} and jsonb_typeof(items_dropped) = 'array' and jsonb_array_length(items_dropped) > 0
      union all
      select settled_at from forge_contributions where player_wallet = ${w} and item_dropped is not null
    ) x`));
  set('shop_bought', await one(db, ledgerFirst(w, 'item.buy')));
  set('market_listed', await one(db, sql`select min(created_at) as achieved_at from item_listings where seller_wallet = ${w}`));
  set('market_bought', await one(db, sql`select min(coalesce(settled_at, created_at)) as achieved_at from item_listings
    where buyer_wallet = ${w} and status = 'sold'`));

  // --- Land & money (web3) -----------------------------------------------------
  set('land_bought', await one(db, sql`select least(
      (select min(coalesce(finalized_at, created_at)) from deposits
        where player_wallet = ${w} and kind in ('entry', 'deed') and status = 'credited'),
      (select entry_paid_at from players where wallet = ${w})
    ) as achieved_at`));
  set('deed_minted', await one(db, sql`select case when
      exists (select 1 from bases where owner_wallet = ${w} and deed_asset_id is not null)
      or exists (select 1 from players where wallet = ${w} and deed_asset_id is not null)
    then now() end as achieved_at`));
  set('second_base', await one(db, sql`select case when
      (select count(*) from bases where owner_wallet = ${w} and land_paid_at is not null) >= 2
    then now() end as achieved_at`));
  set('deed_transferred', await one(db, sql`select min(created_at) as achieved_at from base_transfers where from_wallet = ${w}`));
  set('keep_deposited', await one(db, sql`select min(coalesce(finalized_at, created_at)) as achieved_at from deposits
    where player_wallet = ${w} and kind = 'keep_deposit' and status = 'credited'`));
  set('withdrawal_requested', await one(db, sql`select min(created_at) as achieved_at from withdrawals where player_wallet = ${w}`));
  set('withdrawal_sent', await one(db, sql`select min(coalesce(completed_at, created_at)) as achieved_at from withdrawals
    where player_wallet = ${w} and status = 'sent'`));
  set('twofa_enabled', await one(db, sql`select coalesce(totp_enabled_at, now()) as achieved_at from players
    where wallet = ${w} and (totp_enabled_at is not null or email_verified = true)`));
  set('seeker_linked', await one(db, sql`select verified_at as achieved_at from seeker_links
    where wallet = ${w} and verified_at is not null`));

  // --- Social ------------------------------------------------------------------
  set('chat_sent', await one(db, sql`select min(created_at) as achieved_at from global_chat_messages where author_wallet = ${w}`));
  set('mail_claimed', await one(db, sql`select min(claimed_at) as achieved_at from mail_messages
    where recipient_wallet = ${w} and claimed_at is not null`));
  set('referral_used', await one(db, sql`select created_at as achieved_at from referrals where referee_wallet = ${w}`));
  set('friend_invited', await one(db, sql`select min(created_at) as achieved_at from referrals where referrer_wallet = ${w}`));
  set('friend_qualified', await one(db, sql`select min(qualified_at) as achieved_at from referrals
    where referrer_wallet = ${w} and qualified_at is not null`));

  return earned;
}

export interface EarnedMilestone { kind: 'milestone'; key: TesterMilestoneKey; points: number; achievedAt: Date }
/** A daily row this recompute created or raised; `points` is the DELTA paid
 * by this pass (the toast amount), `count` the row's new count. */
export interface EarnedDaily { kind: 'daily'; key: TesterDailyKey; day: string; count: number; points: number; achievedAt: Date }
export type EarnedAward = EarnedMilestone | EarnedDaily;

/**
 * Insert every detected-but-missing milestone for one wallet, then re-derive
 * its daily points for the lookback window. Idempotent: the (wallet, key)
 * primary key plus `on conflict do nothing` means concurrent recomputes can
 * never double-award a milestone, and the daily upsert only ever raises a
 * count. Returns only what this call created or raised, so callers can toast
 * "+25 TESTER POINTS" exactly once.
 */
export async function recomputeTesterMilestones(
  db: Db, wallet: string, source: 'derived' | 'hook' = 'derived', now = new Date(),
): Promise<EarnedAward[]> {
  const [player] = await db.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet));
  if (!player) return [];
  const detected = await detectMilestones(db, wallet);
  const earned: EarnedAward[] = [];
  if (detected.size > 0) {
    const rows = [...detected.entries()].map(([key, achievedAt]) => ({
      wallet, key, points: POINTS_BY_KEY.get(key) ?? 0, source, achievedAt,
    }));
    const inserted = await db.insert(testerMilestones).values(rows)
      .onConflictDoNothing({ target: [testerMilestones.wallet, testerMilestones.key] })
      .returning({ key: testerMilestones.key, points: testerMilestones.points, achievedAt: testerMilestones.achievedAt });
    for (const r of inserted) {
      earned.push({ kind: 'milestone', key: r.key as TesterMilestoneKey, points: r.points, achievedAt: r.achievedAt });
      // Stamped with the time the milestone was ACHIEVED, not the sweep that
      // noticed it — a nightly sweep otherwise files every milestone at 03:00.
      serverTrack('tester_milestone_earned', wallet, { key: r.key, points: r.points, source }, {
        eventId: `tester:${wallet}:${r.key}`, timestamp: r.achievedAt.toISOString(),
      });
    }
  }
  earned.push(...await recomputeDailyPoints(db, wallet, now));
  return earned;
}

// ---------------------------------------------------------------------------
// Daily points (D-103)
// ---------------------------------------------------------------------------

interface DailyRow { day: string; key: TesterDailyKey; count: number; points: number; meta: Record<string, unknown> | null }

/** Points a source pays for `count` events in one day: min(count, cap) × unit. */
function dailyPointsFor(key: TesterDailyKey, count: number): number {
  const src = DAILY_SOURCES.get(key);
  return src ? Math.min(count, src.cap) * src.points : 0;
}

/**
 * Referral days (owner: "Qualified referee deed plus keep lvl 3", only on days
 * the referee acted). For the wallet as REFERRER: per day, how many of its
 * qualified referees that still hold an active paid deed (or the legacy
 * `players.entry_paid_at` land) did anything that day. Derived live from the
 * referee's own action days, never from the referee's points rows. The
 * referee is credited nothing here — their own actions pay their own row.
 */
async function referralActiveDays(db: Db, wallet: string, days: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const rows = await db.execute<Row>(sql`select r.referee_wallet from referrals r
    where r.referrer_wallet = ${wallet} and r.qualified_at is not null and (
      exists (select 1 from bases b where b.owner_wallet = r.referee_wallet and b.status = 'active' and b.land_paid_at is not null)
      or exists (select 1 from players p where p.wallet = r.referee_wallet and p.entry_paid_at is not null))`);
  for (const r of rows as unknown as Row[]) {
    const referee = String(r['referee_wallet']);
    for (const day of actionDaysOf(await actionDayCounts(db, referee, days))) {
      out.set(day, (out.get(day) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Consecutive action days ending on `day` (0 when `day` itself was not
 * played), walking `played` back at most `limit` days. A run longer than
 * `limit` reports `limit + 1`, which is enough to know it passed every bonus.
 */
function runEndingAt(played: ReadonlySet<string>, day: string, limit: number): number {
  let run = 0;
  let d = day;
  while (played.has(d) && run <= limit) { run += 1; d = shiftDay(d, -1); }
  return run;
}

/**
 * Re-derive the wallet's daily rows for the last TESTER_DAILY.lookbackDays UTC
 * days and upsert them insert-or-raise only. `played` fires on any day a
 * source fired (points or not — feedback marks the day at 0), `referral_active`
 * from the referrer's qualified referees, and `streak_N` on the day the run of
 * consecutive played days reaches exactly N (keyed by day, so one run pays
 * each bonus once; a new run after a gap can earn it again). Returns the rows
 * this pass created or raised, with the points delta.
 */
async function recomputeDailyPoints(db: Db, wallet: string, now: Date): Promise<EarnedDaily[]> {
  const days = utcDaysEndingAt(now, TESTER_DAILY.lookbackDays);
  const counts = await actionDayCounts(db, wallet, days);
  const referral = await referralActiveDays(db, wallet, days);
  const rows: DailyRow[] = [];
  const derivedPlayed = actionDaysOf(counts);
  for (const day of days) {
    for (const [key, c] of counts.get(day) ?? []) {
      if (!DAILY_SOURCES.has(key)) continue;
      rows.push({ day, key, count: c.count, points: dailyPointsFor(key, c.count), meta: c.baseId ? { baseId: c.baseId } : null });
    }
    if (derivedPlayed.has(day)) rows.push({ day, key: 'played', count: 1, points: DAILY_PLAYED.points, meta: null });
    const active = referral.get(day) ?? 0;
    if (active > 0) {
      rows.push({ day, key: 'referral_active', count: active, points: dailyPointsFor('referral_active', active), meta: { referees: active } });
    }
  }

  // Streaks: the played history before the window comes from earlier passes'
  // rows (never lowered, so they are the record); the window itself from
  // today's derivation unioned with what was already written.
  const windowStart = shiftDay(days[0]!, -(MAX_STREAK_DAYS + 1));
  const history = await db.select({ day: testerDailyPoints.day })
    .from(testerDailyPoints)
    .where(and(eq(testerDailyPoints.wallet, wallet), eq(testerDailyPoints.key, 'played'), gte(testerDailyPoints.day, windowStart)));
  const played = new Set<string>([...history.map((h) => h.day), ...derivedPlayed]);
  for (const day of days) {
    const run = runEndingAt(played, day, MAX_STREAK_DAYS);
    const streak = TESTER_DAILY.streaks.find((s) => s.days === run);
    if (streak) rows.push({ day, key: streak.key, count: 1, points: streak.points, meta: { run } });
  }
  if (rows.length === 0) return [];

  // Read-then-upsert under a per-wallet lock so the points delta reported is
  // exact when the sweep and the on-demand path recompute the same wallet at
  // once; the `setWhere` guard is what makes the write itself monotonic.
  const written = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tester-daily:${wallet}`}, 0))`);
    const existing = await tx.select({ day: testerDailyPoints.day, key: testerDailyPoints.key, count: testerDailyPoints.count, points: testerDailyPoints.points })
      .from(testerDailyPoints)
      .where(and(eq(testerDailyPoints.wallet, wallet), inArray(testerDailyPoints.day, days)));
    const before = new Map(existing.map((e) => [`${e.day}|${e.key}`, e]));
    const toWrite = rows.filter((r) => (before.get(`${r.day}|${r.key}`)?.count ?? 0) < r.count);
    if (toWrite.length === 0) return [];
    const upserted = await tx.insert(testerDailyPoints)
      .values(toWrite.map((r) => ({ wallet, day: r.day, key: r.key, count: r.count, points: r.points, firstAt: now, lastAt: now, meta: r.meta })))
      .onConflictDoUpdate({
        target: [testerDailyPoints.wallet, testerDailyPoints.day, testerDailyPoints.key],
        set: {
          count: sql`greatest(${testerDailyPoints.count}, excluded.count)`,
          points: sql`greatest(${testerDailyPoints.points}, excluded.points)`,
          lastAt: now,
          meta: sql`coalesce(excluded.meta, ${testerDailyPoints.meta})`,
        },
        setWhere: sql`excluded.count > ${testerDailyPoints.count}`,
      })
      .returning({ day: testerDailyPoints.day, key: testerDailyPoints.key, count: testerDailyPoints.count, points: testerDailyPoints.points, lastAt: testerDailyPoints.lastAt });
    return upserted.map((u) => ({
      kind: 'daily' as const, key: u.key as TesterDailyKey, day: u.day, count: u.count,
      points: u.points - (before.get(`${u.day}|${u.key}`)?.points ?? 0), achievedAt: u.lastAt,
    }));
  });
  for (const e of written) {
    serverTrack('tester_daily_earned', wallet, { key: e.key, day: e.day, count: e.count, points: e.points }, {
      eventId: `tester-daily:${wallet}:${e.day}:${e.key}:${e.count}`,
    });
  }
  return written;
}

/** Current streak for display: the run ending today, or — when today has not
 * been played yet — the run ending yesterday (still alive until the day ends). */
async function currentStreakDays(db: Db, wallet: string, now: Date): Promise<number> {
  const today = utcDay(now);
  const rows = await db.select({ day: testerDailyPoints.day }).from(testerDailyPoints)
    .where(and(eq(testerDailyPoints.wallet, wallet), eq(testerDailyPoints.key, 'played')))
    .orderBy(desc(testerDailyPoints.day)).limit(366);
  const played = new Set(rows.map((r) => r.day));
  const from = played.has(today) ? today : shiftDay(today, -1);
  return runEndingAt(played, from, 366);
}

const recomputeGate = new Map<string, number>();

/** Bounded on-demand recompute (one per wallet per TESTER_PROGRAM.recomputeMinIntervalMs). */
export async function recomputeIfDue(db: Db, wallet: string, now = Date.now()): Promise<EarnedAward[]> {
  const last = recomputeGate.get(wallet) ?? 0;
  if (now - last < TESTER_PROGRAM.recomputeMinIntervalMs) return [];
  recomputeGate.set(wallet, now);
  return recomputeTesterMilestones(db, wallet);
}

/**
 * Worker sweep, time-boxed. Order is "least recently derived first": wallets
 * with no tester rows at all (never swept) come before everyone else, then the
 * oldest most-recent milestone, so successive sweeps rotate through the whole
 * player base instead of re-scanning the same newest prefix (review 2026-08-21).
 * Runs on its own BullMQ queue so it never delays custody jobs.
 */
export async function sweepTesterMilestones(
  db: Db, opts: { batch?: number; budgetMs?: number; now?: () => number } = {},
): Promise<{ scanned: number; awarded: number }> {
  const batch = opts.batch ?? 250;
  const budgetMs = opts.budgetMs ?? 20_000;
  const now = opts.now ?? Date.now;
  const started = now();
  const rows = await db.execute<Row>(sql`select p.wallet from players p
    left join (select wallet, max(achieved_at) as last_at from tester_milestones group by wallet) m on m.wallet = p.wallet
    order by m.last_at asc nulls first, coalesce(p.last_seen_at, p.created_at) desc
    limit ${batch}`);
  const wallets = (rows as unknown as Row[]).map((r) => ({ wallet: String(r['wallet']) }));
  let scanned = 0;
  let awarded = 0;
  for (const { wallet } of wallets) {
    if (now() - started > budgetMs) break;
    awarded += (await recomputeTesterMilestones(db, wallet)).length;
    scanned += 1;
  }
  return { scanned, awarded };
}

// ---------------------------------------------------------------------------
// Public reads (leaderboard + per-wallet progress)
// ---------------------------------------------------------------------------

export interface LeaderboardEntry {
  rank: number;
  /** Display name or null when the player never chose one. */
  name: string | null;
  /** First four + last four characters — the public board never prints a full key. */
  wallet: string;
  points: number;
  milestones: number;
  feedback: number;
  /** D-103: per-day source points (all keys but referral_active) and referral days. */
  dailyPoints: number;
  referralPoints: number;
  lastAt: string | null;
}

export function shortWallet(wallet: string): string {
  return wallet.length <= 10 ? wallet : `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
}

/** Board hygiene (owner 2026-08-22): SQL fragment selecting wallets that may
 * appear on the PUBLIC board — founded a base, not admin-hidden, not a team/
 * internal wallet. Progress and points are untouched; only visibility. */
function boardEligible(internalWallets: readonly string[]): SQL {
  const required = TESTER_PROGRAM.board.requiredMilestone;
  const foundingOnly = sql.join(TESTER_PROGRAM.board.foundingOnlyKeys.map((k) => sql`${k}`), sql`, `);
  const internal = sql`and ${notInternalPlaytestWallet(sql`u.wallet`, internalWallets)}`;
  const session = TESTER_PROGRAM.board.requireSession
    ? sql`and exists (select 1 from sessions s where s.wallet = u.wallet)`
    : sql``;
  // Founded a base AND did at least one thing beyond founding (a sign-in-once
  // auto-base is not a tester) AND has really signed in (a session row).
  return sql`exists (select 1 from tester_milestones r where r.wallet = u.wallet and r.key = ${required})
    and exists (select 1 from tester_milestones r2 where r2.wallet = u.wallet and r2.key not in (${foundingOnly}))
    ${session}
    and not exists (select 1 from tester_board_hidden h where h.wallet = u.wallet) ${internal}`;
}

/** Per-wallet totals across the three point ledgers (milestones, feedback,
 * daily), one row per wallet that has any. `last_at` is the latest award time
 * — the board's tie-breaker — so all three readers (board, totals, rank)
 * order identically. */
const POINTS_BY_WALLET = sql`
  m as (
    select wallet, sum(points)::int as pts, count(*)::int as n, max(achieved_at) as last_at
    from tester_milestones group by wallet
  ), f as (
    select wallet, sum(points)::int as pts, count(*)::int as n, max(created_at) as last_at
    from tester_feedback group by wallet
  ), d as (
    select wallet,
      coalesce(sum(points) filter (where key <> 'referral_active'), 0)::int as pts,
      coalesce(sum(points) filter (where key = 'referral_active'), 0)::int as rpts,
      max(first_at) as last_at
    from tester_daily_points group by wallet
  ), u as (
    select coalesce(m.wallet, f.wallet, d.wallet) as wallet,
      coalesce(m.pts, 0) + coalesce(f.pts, 0) + coalesce(d.pts, 0) + coalesce(d.rpts, 0) as points,
      coalesce(m.pts, 0) as milestone_points, coalesce(m.n, 0) as milestones,
      coalesce(f.pts, 0) as feedback_points, coalesce(f.n, 0) as feedback,
      coalesce(d.pts, 0) as daily_points, coalesce(d.rpts, 0) as referral_points,
      greatest(m.last_at, f.last_at, d.last_at) as last_at
    from m full outer join f on f.wallet = m.wallet
    full outer join d on d.wallet = coalesce(m.wallet, f.wallet)
  )`;

export async function testerLeaderboard(
  db: Db, opts: { limit?: number; internalWallets?: readonly string[] } = {},
): Promise<{ entries: LeaderboardEntry[]; totals: { testers: number; points: number; feedback: number } }> {
  const limit = opts.limit ?? TESTER_PROGRAM.leaderboardLimit;
  const eligible = boardEligible(opts.internalWallets ?? []);
  const rows = await db.execute<Row>(sql`
    with ${POINTS_BY_WALLET}
    select u.wallet, p.name, u.points, u.milestones, u.feedback, u.daily_points, u.referral_points, u.last_at,
      (p.entry_paid_at is not null or exists (select 1 from bases b
        where b.owner_wallet = u.wallet and b.status = 'active' and b.land_paid_at is not null)) as land_owner
    from u join players p on p.wallet = u.wallet
    where u.points > 0 and ${eligible}
    order by u.points desc, u.last_at asc nulls last, u.wallet asc
    limit ${limit}`);
  const totalsRows = await db.execute<Row>(sql`
    with ${POINTS_BY_WALLET}
    select count(*)::int as testers, coalesce(sum(u.points), 0)::int as points, coalesce(sum(u.feedback), 0)::int as feedback
    from u where u.points > 0 and ${eligible}`);
  const totals = (totalsRows as unknown as Row[])[0] ?? {};
  const entries = (rows as unknown as Row[]).map((r, i) => ({
    rank: i + 1,
    name: typeof r['name'] === 'string' && r['name'] !== '' ? r['name'] : null,
    wallet: shortWallet(String(r['wallet'])),
    points: asInt(r['points']),
    milestones: asInt(r['milestones']),
    feedback: asInt(r['feedback']),
    dailyPoints: asInt(r['daily_points']),
    referralPoints: asInt(r['referral_points']),
    /** A minted Land Deed (active paid base) — the whitelist ticket (PLAYTEST_CAMPAIGN.whitelist). */
    landOwner: r['land_owner'] === true,
    lastAt: asDate(r['last_at'])?.toISOString() ?? null,
  }));
  return {
    entries,
    totals: { testers: asInt(totals['testers']), points: asInt(totals['points']), feedback: asInt(totals['feedback']) },
  };
}

export interface TesterProgress {
  wallet: string;
  name: string | null;
  /** Whether this wallet appears on the public board (founded a base, not hidden/internal). */
  listed: boolean;
  /** Why the wallet is or is not on the board — only on the authed own read
   * (the public lookup must not reveal an admin hide). */
  listedReason?: ListedReason;
  points: number;
  rank: number | null;
  milestonePoints: number;
  feedbackPoints: number;
  feedbackCount: number;
  /** D-103 daily ledger totals (all days): sources vs referral days. */
  dailyPoints: number;
  referralPoints: number;
  /** A minted Land Deed — the whitelist ticket (owner 2026-09-04). Public: it
   *  is the same fact the globe and the board already show. */
  landOwner: boolean;
  milestones: Array<{
    key: string; category: string; title: string; hint: string; points: number;
    achieved: boolean;
    /** Only on the authed own-progress read; the public lookup never discloses
     * WHEN a wallet deposited, withdrew, enabled 2FA, … (review 2026-08-21). */
    achievedAt?: string | null;
  }>;
  /** Today's daily ledger (UTC) and the live streak — ONLY on the authed
   * own-progress read. The public lookup carries the all-time `dailyPoints`
   * and `referralPoints` totals and nothing per-day: which sources fired
   * today (a withdrawal, a deposit, PvP wins), the streak and the referral
   * network would otherwise be readable for any wallet by anyone. */
  daily: {
    todayPoints?: number;
    streakDays?: number;
    byKey?: Array<{ key: string; count: number; points: number; lastAt?: string }>;
  };
  referrals?: { invited: number; qualified: number; activeToday: number };
}

/** Board-hygiene verdicts, in the order boardEligible checks them. */
export type ListedReason = 'listed' | 'no_base' | 'no_action' | 'no_session' | 'hidden' | 'internal';

/** Per-wallet checklist: every catalog milestone with achieved flag (and, for
 * the wallet's own authed read, the achieved time), plus today's daily ledger
 * and referral counts. */
export async function testerProgress(
  db: Db, wallet: string,
  opts: { timestamps: boolean; internalWallets?: readonly string[]; now?: Date } = { timestamps: false },
): Promise<TesterProgress | null> {
  const now = opts.now ?? new Date();
  const [player] = await db.select({ wallet: players.wallet, name: players.name, entryPaidAt: players.entryPaidAt })
    .from(players).where(eq(players.wallet, wallet));
  if (!player) return null;
  const earned = await db.select({ key: testerMilestones.key, points: testerMilestones.points, achievedAt: testerMilestones.achievedAt })
    .from(testerMilestones).where(eq(testerMilestones.wallet, wallet));
  const earnedByKey = new Map(earned.map((e) => [e.key, e]));
  const fbRows = await db.execute<Row>(sql`select coalesce(sum(points), 0)::int as pts, count(*)::int as n
    from tester_feedback where wallet = ${wallet}`);
  const fb = (fbRows as unknown as Row[])[0] ?? {};
  const dailyRows = await db.execute<Row>(sql`select
      coalesce(sum(points) filter (where key <> 'referral_active'), 0)::int as pts,
      coalesce(sum(points) filter (where key = 'referral_active'), 0)::int as rpts
    from tester_daily_points where wallet = ${wallet}`);
  const daily = (dailyRows as unknown as Row[])[0] ?? {};
  const milestonePoints = earned.reduce((s, e) => s + e.points, 0);
  const feedbackPoints = asInt(fb['pts']);
  const dailyPoints = asInt(daily['pts']);
  const referralPoints = asInt(daily['rpts']);
  const points = milestonePoints + feedbackPoints + dailyPoints + referralPoints;
  const today = utcDay(now);
  const todayRows = await db.select({ key: testerDailyPoints.key, count: testerDailyPoints.count, points: testerDailyPoints.points, lastAt: testerDailyPoints.lastAt })
    .from(testerDailyPoints)
    .where(and(eq(testerDailyPoints.wallet, wallet), eq(testerDailyPoints.day, today)))
    .orderBy(testerDailyPoints.key);
  const streakDays = await currentStreakDays(db, wallet, now);
  const refRows = await db.execute<Row>(sql`select count(*)::int as invited, count(qualified_at)::int as qualified
    from referrals where referrer_wallet = ${wallet}`);
  const ref = (refRows as unknown as Row[])[0] ?? {};
  // Rank is among board-eligible wallets only, and only for a wallet that is
  // itself listed; an unlisted wallet still sees its points with rank null.
  const internalWallets = opts.internalWallets ?? [];
  const eligible = boardEligible(internalWallets);
  const listedRows = await db.execute<Row>(sql`
    with u as (select ${wallet}::text as wallet) select (${eligible}) as listed,
      exists (select 1 from tester_milestones r where r.wallet = u.wallet and r.key = ${TESTER_PROGRAM.board.requiredMilestone}) as has_base,
      exists (select 1 from tester_milestones r2 where r2.wallet = u.wallet
        and r2.key not in (${sql.join(TESTER_PROGRAM.board.foundingOnlyKeys.map((k) => sql`${k}`), sql`, `)})) as has_action,
      exists (select 1 from sessions s where s.wallet = u.wallet) as has_session,
      exists (select 1 from tester_board_hidden h where h.wallet = u.wallet) as hidden
    from u`);
  const verdict = (listedRows as unknown as Row[])[0] ?? {};
  const listed = Boolean(verdict['listed']);
  const listedReason: ListedReason = listed ? 'listed'
    : !verdict['has_base'] ? 'no_base'
    : !verdict['has_action'] ? 'no_action'
    : TESTER_PROGRAM.board.requireSession && !verdict['has_session'] ? 'no_session'
    : verdict['hidden'] ? 'hidden'
    : 'internal';
  let rank: number | null = null;
  if (points > 0 && listed) {
    // Same total ordering as testerLeaderboard (points desc, last_at asc nulls
    // last, wallet asc) so a tie shows the same rank here as on the board.
    const rankRows = await db.execute<Row>(sql`
      with ${POINTS_BY_WALLET}, me as (select points, last_at from u where wallet = ${wallet})
      select (count(*) + 1)::int as rank from u, me
      where ${eligible} and u.wallet <> ${wallet} and (
        u.points > me.points
        or (u.points = me.points and (
          (u.last_at < me.last_at) or (u.last_at is not null and me.last_at is null)
          or (u.last_at is not distinct from me.last_at and u.wallet < ${wallet})))
      )`);
    rank = asInt(((rankRows as unknown as Row[])[0] ?? {})['rank']) || null;
  }
  return {
    wallet: shortWallet(wallet),
    name: player.name !== '' ? player.name : null,
    listed,
    ...(opts.timestamps ? { listedReason } : {}),
    points, rank, milestonePoints, feedbackPoints, feedbackCount: asInt(fb['n']),
    dailyPoints, referralPoints,
    landOwner: player.entryPaidAt !== null || (await db.execute<Row>(sql`select 1 from bases
      where owner_wallet = ${wallet} and status = 'active' and land_paid_at is not null limit 1`) as unknown as Row[]).length > 0,
    milestones: MILESTONES.map((m) => ({
      key: m.key, category: m.category, title: m.title, hint: m.hint, points: m.points,
      achieved: earnedByKey.has(m.key),
      ...(opts.timestamps ? { achievedAt: earnedByKey.get(m.key)?.achievedAt.toISOString() ?? null } : {}),
    })),
    daily: opts.timestamps
      ? {
        todayPoints: todayRows.reduce((s, r) => s + r.points, 0),
        streakDays,
        byKey: todayRows.map((r) => ({ key: r.key, count: r.count, points: r.points, lastAt: r.lastAt.toISOString() })),
      }
      : {},
    ...(opts.timestamps
      ? {
        referrals: {
          invited: asInt(ref['invited']), qualified: asInt(ref['qualified']),
          activeToday: todayRows.find((r) => r.key === 'referral_active')?.count ?? 0,
        },
      }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Feedback engine
// ---------------------------------------------------------------------------

export type FeedbackCategory = (typeof TESTER_PROGRAM.feedback.categories)[number];
export type FeedbackImportance = keyof typeof TESTER_PROGRAM.feedback.importanceBonus;
export type FeedbackStatus = 'new' | 'reviewed' | 'accepted' | 'rejected' | 'duplicate' | 'fixed';
/** What an admin can SET (owner 2026-09-04): 'fixed' is a flag, not a status. */
export type TriageStatus = Exclude<FeedbackStatus, 'fixed'>;

export interface FeedbackInput {
  requestId?: string | undefined;
  category: FeedbackCategory;
  title: string;
  body: string;
  context?: Record<string, unknown> | undefined;
  /** Set by the route from request headers only; a body can never carry it. */
  origin?: FeedbackClientOrigin | undefined;
}

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Explicit diagnostics only. Unknown fields (tokens, logs, chat) are discarded
 * before hashing or storage. JSON serialization follows this fixed schema order. */
export const FeedbackDiagnosticContext = z.object({
  screen: z.string().max(FEEDBACK_THREADS.contextScreenMaxLen).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  build: z.string().regex(/^(?:[0-9a-f]{7,40}|dev|unknown)$/i).optional(),
  platform: z.enum(['desktop', 'android', 'ios', 'web', 'unknown']).optional(),
  baseId: z.string().uuid().optional(), raidId: z.string().uuid().optional(),
  viewportWidth: z.number().int().positive().max(FEEDBACK_THREADS.viewportMaxPx).optional(),
  viewportHeight: z.number().int().positive().max(FEEDBACK_THREADS.viewportMaxPx).optional(),
  devicePixelRatio: z.number().positive().max(FEEDBACK_THREADS.devicePixelRatioMax).optional(),
});
/** What a report row stores: the body's diagnostics plus the server-stamped client. */
export const StoredFeedbackContext = FeedbackDiagnosticContext.extend(FeedbackClientOriginContext.shape);
export type StoredFeedbackContext = z.infer<typeof StoredFeedbackContext>;
/** Policy 2 starts unawarded. A durable receipt precedes cap checks on replay. */
export async function submitTesterFeedback(
  db: DbOrTx, wallet: string, input: FeedbackInput, now = new Date(),
): Promise<{ id: string; basePoints: number; dailyRemaining: number }> {
  const [player] = await db.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  const cfg = TESTER_PROGRAM.feedback;
  if (!input.requestId) throw new HttpError(409, 'update the game before submitting feedback', 'FEEDBACK_CLIENT_UPDATE_REQUIRED');
  if (input.requestId.length > FEEDBACK_THREADS.requestIdMaxLen || !/^[A-Za-z0-9_-]+$/.test(input.requestId)) throw new HttpError(400, 'invalid feedback request ID');
  const diagnostics = FeedbackDiagnosticContext.safeParse(input.context ?? {});
  if (!diagnostics.success) throw new HttpError(400, 'invalid feedback diagnostic context');
  const context = diagnostics.data;

  if (!(cfg.categories as readonly string[]).includes(input.category)) throw new HttpError(400, 'unknown feedback category');
  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length === 0 || title.length > cfg.titleMaxLen) throw new HttpError(400, `title must be 1–${cfg.titleMaxLen} characters`);
  if (body.length < cfg.bodyMinLen || body.length > cfg.bodyMaxLen) {
    throw new HttpError(400, `feedback must be ${cfg.bodyMinLen}–${cfg.bodyMaxLen} characters`);
  }
  // The client stamp is display-only and stays OUT of the idempotency hash: an app
  // update between a lost response and its retry must replay the receipt, not 409.
  const requestHash = createHash('sha256').update(JSON.stringify({ category: input.category, title, body, context })).digest('hex');
  const stored = StoredFeedbackContext.parse({ ...context, ...(input.origin ? FeedbackClientOriginContext.parse(input.origin) : {}) });
  const dayStart = utcDayStart(now);
  // Count and insert are one unit of work: a per-wallet transaction-scoped
  // advisory lock serialises concurrent submits, so the daily cap and the
  // submission count cannot be overrun by two requests racing the count
  // (review 2026-08-21). Raw-SQL Date parameters are passed as ISO text with an
  // explicit cast (postgres-js otherwise rejects the bind).
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tester-feedback:${wallet}`}, 0))`);
    const [existing] = await tx.select({ requestHash: testerFeedback.requestHash, receipt: testerFeedback.submissionReceipt, trashedAt: testerFeedback.trashedAt }).from(testerFeedback)
      .where(and(eq(testerFeedback.wallet, wallet), eq(testerFeedback.requestId, input.requestId!)));
    if (existing) {
      if (existing.requestHash !== requestHash) throw new HttpError(409, 'feedback request changed; use a new request ID', 'FEEDBACK_REQUEST_CONFLICT');
      if (existing.trashedAt) throw new HttpError(409, 'this report was removed; start a new report if needed', 'FEEDBACK_REPORT_TRASHED');
      return existing.receipt as { id: string; basePoints: number; dailyRemaining: number };
    }
    const countRows = await tx.execute<Row>(sql`select count(*)::int as n from tester_feedback
      where wallet = ${wallet} and created_at >= ${dayStart.toISOString()}::timestamptz`);
    const today = asInt(((countRows as unknown as Row[])[0] ?? {})['n']);
    if (today >= cfg.dailyMaxSubmissions) {
      throw new HttpError(429, `feedback limit reached for today (${cfg.dailyMaxSubmissions}/day) — thank you, come back tomorrow`);
    }
    const id = randomUUID();
    const receipt = { id, basePoints: 0, dailyRemaining: Math.max(0, cfg.dailyMaxSubmissions - today - 1) };
    await tx.insert(testerFeedback).values({
      id, wallet, category: input.category, title, body, context: stored,
      requestId: input.requestId!, requestHash, submissionReceipt: receipt,
      rewardPolicyVersion: 2, basePoints: 0, bonusPoints: 0, points: 0, createdAt: now,
    });
    return receipt;
  });
  serverTrack('tester_feedback_submitted', wallet, { category: input.category, basePoints: result.basePoints }, {
    eventId: `feedback:${result.id}`,
  });
  return result;
}

/** Mode-specific cursors never expose staff-only activity to reporter lists.
 * Explicit outer qualification survives Drizzle's projection column rewriting. */
function feedbackListUnread(wallet: string, mode: 'reporter' | 'admin') {
  const outerId = sql`${sql.identifier('tester_feedback')}.${sql.identifier('id')}`;
  const sequence = mode === 'reporter' ? sql`m.reporter_revision` : sql`m.revision`;
  return sql<boolean>`exists (select 1 from feedback_messages m
    left join feedback_readers r on r.report_id = m.report_id and r.reader = ${`${mode}:${wallet}`}
    where m.report_id = ${outerId} and m.author <> ${wallet}
      and ${mode === 'reporter' ? sql`m.visibility = 'reporter'` : sql`true`}
      and ${sequence} > coalesce(r.revision, 0))`;
}

export async function listMyTesterFeedback(db: Db, wallet: string, limit = 50) {
  return db.select({
    id: testerFeedback.id, category: testerFeedback.category, title: testerFeedback.title,
    body: testerFeedback.body, status: sql<FeedbackStatus>`case when ${testerFeedback.fixedAt} is not null then 'fixed' else ${testerFeedback.status}::text end`, importance: testerFeedback.importance,
    rewardPolicyVersion: testerFeedback.rewardPolicyVersion, revision: testerFeedback.reporterRevision,
    unread: feedbackListUnread(wallet, 'reporter'),
    points: testerFeedback.points, adminNote: testerFeedback.adminNote,
    createdAt: testerFeedback.createdAt, reviewedAt: testerFeedback.reviewedAt,
    fixedAt: testerFeedback.fixedAt, fixedRef: testerFeedback.fixedRef,
  }).from(testerFeedback).where(and(eq(testerFeedback.wallet, wallet), isNull(testerFeedback.trashedAt)))
    .orderBy(desc(testerFeedback.createdAt)).limit(limit);
}

/** Effective lifecycle filters keep Accepted and Fixed mutually exclusive.
 * Persisted triage and the historical fixed timestamp remain compatible. */
export interface FeedbackListFilter {
  trashed?: boolean | undefined;
  status?: FeedbackStatus | undefined;
  fixed?: boolean | undefined;
  exported?: boolean | undefined;
  /** "Android app only": stamped client, or the legacy native signature. */
  client?: FeedbackClient | undefined;
}

function adminFeedbackProjection(adminWallet?: string) {
  return {
    id: testerFeedback.id, wallet: testerFeedback.wallet, name: players.name,
    category: testerFeedback.category, title: testerFeedback.title, body: testerFeedback.body,
    context: testerFeedback.context, status: sql<FeedbackStatus>`case when ${testerFeedback.fixedAt} is not null then 'fixed' else ${testerFeedback.status}::text end`, importance: testerFeedback.importance,
    rewardPolicyVersion: testerFeedback.rewardPolicyVersion, revision: testerFeedback.revision, reporterRevision: testerFeedback.reporterRevision,
    unread: adminWallet ? feedbackListUnread(adminWallet, 'admin') : sql<boolean>`false`,
    basePoints: testerFeedback.basePoints, bonusPoints: testerFeedback.bonusPoints, points: testerFeedback.points,
    adminNote: testerFeedback.adminNote, reviewedBy: testerFeedback.reviewedBy,
    createdAt: testerFeedback.createdAt, reviewedAt: testerFeedback.reviewedAt,
    fixedAt: testerFeedback.fixedAt, fixedRef: testerFeedback.fixedRef, exportedAt: testerFeedback.exportedAt,
    trashedAt: testerFeedback.trashedAt,
  };
}

export async function adminListTesterFeedback(db: Db, filter: FeedbackListFilter = {}, limit = 200, adminWallet?: string) {
  const conditions: SQL[] = [filter.trashed === true ? isNotNull(testerFeedback.trashedAt) : isNull(testerFeedback.trashedAt)];
  if (filter.status === 'fixed') conditions.push(isNotNull(testerFeedback.fixedAt));
  else if (filter.status) conditions.push(eq(testerFeedback.status, filter.status), isNull(testerFeedback.fixedAt));
  if (filter.fixed === true) conditions.push(isNotNull(testerFeedback.fixedAt));
  if (filter.fixed === false) conditions.push(isNull(testerFeedback.fixedAt));
  if (filter.exported === true) conditions.push(isNotNull(testerFeedback.exportedAt));
  if (filter.exported === false) conditions.push(isNull(testerFeedback.exportedAt));
  if (filter.client) conditions.push(sql`${feedbackOriginSql(sql`${testerFeedback.context}`)}=${filter.client}`);
  const rows = await db.select(adminFeedbackProjection(adminWallet)).from(testerFeedback).innerJoin(players, eq(players.wallet, testerFeedback.wallet))
    .where(conditions.length ? and(...conditions) : undefined).orderBy(desc(testerFeedback.createdAt)).limit(limit);
  return rows.map((r) => ({ ...r, fixed: r.fixedAt !== null, trashed: r.trashedAt !== null }));
}

/** Paginated report browser; legacy list keeps its original response contract. */
export const AdminFeedbackPageQuery = z.object({
  trashed:z.enum(['true','false']).optional(),
  status:z.enum(['new','reviewed','accepted','rejected','duplicate','fixed']).optional(),
  fixed:z.enum(['true','false']).optional(),exported:z.enum(['true','false']).optional(),
  category:z.enum(TESTER_PROGRAM.feedback.categories).optional(),issueId:z.string().uuid().optional(),
  client:z.enum(FEEDBACK_CLIENTS).optional(),
  cursor:z.string().max(FEEDBACK_ISSUES.cursorMaxLen).optional(),
}).strict();
const FeedbackPageCursor = z.object({t:z.number().int().nonnegative().safe(),i:z.string().uuid(),s:z.literal('reports')}).strict();
export async function adminPageTesterFeedback(db:Db,config:Pick<Config,'ADMIN_WALLETS'>,admin:string,raw:unknown={}) {
  if(!config.ADMIN_WALLETS?.includes(admin))throw new HttpError(404,'feedback not found');
  const parsed=AdminFeedbackPageQuery.safeParse(raw);if(!parsed.success)throw new HttpError(400,'invalid feedback filter');
  const input=parsed.data,conditions:SQL[]=[parsed.data.trashed==='true'?isNotNull(testerFeedback.trashedAt):isNull(testerFeedback.trashedAt)];
  const qualified=(name:string)=>sql`${sql.identifier('tester_feedback')}.${sql.identifier(name)}`;
  const lastExportedRevision=feedbackLastExportedRevision(qualified('id'),qualified('exported_at'));
  if(input.status==='fixed'||input.fixed==='true')conditions.push(isNotNull(testerFeedback.fixedAt));
  else if(input.fixed==='false')conditions.push(isNull(testerFeedback.fixedAt));
  if(input.status&&input.status!=='fixed')conditions.push(eq(testerFeedback.status,input.status),isNull(testerFeedback.fixedAt));
  if(input.category)conditions.push(eq(testerFeedback.category,input.category));
  if(input.issueId)conditions.push(eq(feedbackIssueLinks.issueId,input.issueId));
  if(input.client)conditions.push(sql`${feedbackOriginSql(sql`${testerFeedback.context}`)}=${input.client}`);
  if(input.exported!==undefined)conditions.push(input.exported==='true'?sql`${lastExportedRevision}>=${testerFeedback.revision}`:sql`${lastExportedRevision}<${testerFeedback.revision}`);
  if(input.cursor){
    try{
      if(!/^[A-Za-z0-9_-]+$/.test(input.cursor))throw new Error('cursor');
      const cursor=FeedbackPageCursor.parse(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));
      const date=asDate(cursor.t);if(!date)throw new Error('date');
      conditions.push(sql`(date_trunc('milliseconds',${testerFeedback.createdAt}),${testerFeedback.id})<(${date.toISOString()}::timestamptz,${cursor.i}::uuid)`);
    }catch{throw new HttpError(400,'invalid feedback cursor');}
  }
  const rows=await db.select({...adminFeedbackProjection(admin),issueId:feedbackIssueLinks.issueId,
    lockedAt:testerFeedback.lockedAt,closedAt:testerFeedback.closedAt,lastExportedRevision,
  }).from(testerFeedback).innerJoin(players,eq(players.wallet,testerFeedback.wallet))
    .leftJoin(feedbackIssueLinks,eq(feedbackIssueLinks.reportId,testerFeedback.id))
    .where(conditions.length?and(...conditions):undefined)
    .orderBy(desc(sql`date_trunc('milliseconds',${testerFeedback.createdAt})`),desc(testerFeedback.id)).limit(FEEDBACK_ISSUES.adminPageSize+1);
  const page=rows.slice(0,FEEDBACK_ISSUES.adminPageSize),last=page.at(-1);
  return{feedback:page.map(r=>({...r,fixed:r.fixedAt!==null,trashed:r.trashedAt!==null,exported:r.lastExportedRevision>=r.revision})),
    nextCursor:rows.length>FEEDBACK_ISSUES.adminPageSize&&last?Buffer.from(JSON.stringify({t:last.createdAt.getTime(),i:last.id,s:'reports'})).toString('base64url'):null};
}

/** Stamp the FIRST export time on the given reports (a re-export keeps the
 *  original stamp) and return what is now stamped, so the panel can show
 *  EXPORTED and the "not exported" filter stays honest across devices. */
export async function adminMarkFeedbackExported(db: Db, ids: readonly string[], now = new Date()) {
  if (ids.length === 0) return { stamped: 0, rows: [] as Array<{ id: string; exportedAt: Date | null }> };
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    const selected = await tx.select({ trashedAt: testerFeedback.trashedAt }).from(testerFeedback)
      .where(inArray(testerFeedback.id, [...ids])).orderBy(testerFeedback.id).for('update');
    if (selected.some(row => row.trashedAt)) throw new HttpError(409, 'restore trashed reports before exporting them', 'FEEDBACK_REPORT_TRASHED');
    const stampedRows = await tx.update(testerFeedback).set({ exportedAt: now })
      .where(and(inArray(testerFeedback.id, [...ids]), isNull(testerFeedback.exportedAt)))
      .returning({ id: testerFeedback.id });
    const rows = await tx.select({ id: testerFeedback.id, exportedAt: testerFeedback.exportedAt })
      .from(testerFeedback).where(inArray(testerFeedback.id, [...ids]));
    return { stamped: stampedRows.length, rows };
  });
}

/**
 * Admin rating: sets importance/status/note and REPLACES the bonus (never
 * stacks). A rejected or duplicate report keeps its base points but its bonus
 * is zero regardless of importance — the rating explains, the status pays.
 * `fixed` (D-103) is a payable terminal status: it keeps every point, stamps
 * `fixed_at` once (the first time the report becomes fixed) and records the
 * optional change reference, so "issues fixed from tester feedback" is a
 * count over rows rather than a number anyone types.
 */
export async function adminRateTesterFeedback(
  db: Db, id: string, admin: string,
  input: {
    importance?: FeedbackImportance | undefined; status?: TriageStatus | undefined; note?: string | undefined;
    /** Owner 2026-09-07: acceptance precedes Fixed. The stored triage stays
     * compatible; clearing the fixed stamp reopens an accepted report. */
    fixed?: boolean | undefined;
    fixedRef?: string | undefined;
  },
  now = new Date(),
) {
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    const [existing] = await tx.select().from(testerFeedback).where(eq(testerFeedback.id, id)).for('update');
    if (!existing) throw new HttpError(404, 'feedback not found');
    if (existing.trashedAt) throw new HttpError(409, 'restore this report before reviewing it', 'FEEDBACK_REPORT_TRASHED');
    if (existing.rewardPolicyVersion !== 1) throw new HttpError(409, 'use the reviewed feedback reward flow for this report', 'FEEDBACK_REVIEW_UPDATE_REQUIRED');
    const importance = input.importance ?? (existing.importance as FeedbackImportance | null) ?? null;
    // Rows written before migration 0105 could carry the transitional 'fixed'
    // status; read it as accepted + fixed.
    const existingStatus: TriageStatus = existing.status === 'fixed' ? 'accepted' : existing.status;
    const wasFixed = existing.fixedAt !== null || existing.status === 'fixed';
    const status: TriageStatus = input.status ?? (existingStatus === 'new' ? 'reviewed' : existingStatus);
    const fixed = input.fixed ?? wasFixed;
    if (fixed && (existingStatus !== 'accepted' || status !== 'accepted')) {
      throw new HttpError(409, 'accept the report before marking it fixed; reopen before changing triage', 'FEEDBACK_FIXED_CONFLICT');
    }
    const payable = status !== 'rejected' && status !== 'duplicate';
    const bonus = payable && importance ? TESTER_PROGRAM.feedback.importanceBonus[importance] : 0;
    const [updated] = await tx.update(testerFeedback).set({
      importance, status, bonusPoints: bonus, points: existing.basePoints + bonus,
      adminNote: input.note === undefined ? existing.adminNote : (input.note.trim() || null),
      reviewedBy: admin, reviewedAt: now,
      ...(fixed
        ? {
          fixedAt: existing.fixedAt ?? now,
          fixedRef: input.fixedRef === undefined ? existing.fixedRef : (input.fixedRef.trim() || null),
        }
        : { fixedAt: null, fixedRef: null }),
    }).where(and(eq(testerFeedback.id, id), eq(testerFeedback.wallet, existing.wallet)))
      .returning({
        id: testerFeedback.id, points: testerFeedback.points, status: testerFeedback.status, importance: testerFeedback.importance,
        fixedAt: testerFeedback.fixedAt, fixedRef: testerFeedback.fixedRef, exportedAt: testerFeedback.exportedAt,
      });
    serverTrack('tester_feedback_rated', existing.wallet, {
      importance: importance ?? 'unrated', status, bonus, fixed,
    }, { eventId: `feedback-rated:${id}:${now.getTime()}` });
    return { ...updated!, status: updated!.fixedAt !== null ? 'fixed' as const : updated!.status, fixed: updated!.fixedAt !== null };
  });
}

/** Admin export: full wallets + totals, for rewarding top testers later. */
export async function adminExportTesters(db: Db) {
  const rows = await db.execute<Row>(sql`
    with ${POINTS_BY_WALLET}
    select u.wallet, p.name, u.points, u.milestone_points, u.milestones,
      u.feedback_points, u.feedback, u.daily_points, u.referral_points
    from u join players p on p.wallet = u.wallet
    order by u.points desc, u.wallet asc`);
  return (rows as unknown as Row[]).map((r) => ({
    wallet: String(r['wallet']), name: typeof r['name'] === 'string' ? r['name'] : '',
    points: asInt(r['points']), milestonePoints: asInt(r['milestone_points']), milestones: asInt(r['milestones']),
    feedbackPoints: asInt(r['feedback_points']), feedback: asInt(r['feedback']),
    dailyPoints: asInt(r['daily_points']), referralPoints: asInt(r['referral_points']),
  }));
}

/** Admin: hide/unhide a wallet on the public board (owner 2026-08-22). */
export async function adminSetBoardHidden(
  db: Db, wallet: string, hidden: boolean, admin: string, reason?: string,
): Promise<{ wallet: string; hidden: boolean }> {
  const [player] = await db.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, wallet));
  if (!player) throw new HttpError(404, 'player not found');
  if (hidden) {
    await db.insert(testerBoardHidden).values({ wallet, reason: reason?.trim() || null, hiddenBy: admin })
      .onConflictDoUpdate({ target: testerBoardHidden.wallet, set: { reason: reason?.trim() || null, hiddenBy: admin, hiddenAt: new Date() } });
  } else {
    await db.delete(testerBoardHidden).where(eq(testerBoardHidden.wallet, wallet));
  }
  return { wallet, hidden };
}

export async function adminListBoardHidden(db: Db) {
  return db.select().from(testerBoardHidden).orderBy(desc(testerBoardHidden.hiddenAt));
}
