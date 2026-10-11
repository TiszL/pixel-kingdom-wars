/** D-118: commit triggers capture activity; consumers never poll mutable base
 * ownership or read points to reconstruct who played. */
import { PLAYTEST_STATS } from '@shardkeep/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';

/** Full-window closeout check. Capture is transactional with each source;
 * cancelling construction invalidates its event in the same transaction. */
export async function reconcilePlayerActions(db: DbOrTx, window: { from: Date; to: Date }): Promise<void> {
  const rows = await db.execute(sql`select started_at <= ${window.from.toISOString()}::timestamptz as covered
    from playtest_activity_coverage where key = 'authoritative-v1'`);
  if (rows[0]?.['covered'] !== true || window.to <= window.from) {
    throw new Error('Campaign window is outside authoritative activity coverage');
  }
}

export interface RetentionMetric {
  eligible: number;
  returned: number;
  percent: number | null;
  cohortFrom: string | null;
  cohortThrough: string | null;
}

export interface ActivityStats {
  measurementSince: string | null;
  measuredThrough: string;
  day: string;
  weekFrom: string;
  dau: number;
  wau: number;
  foughtToday: number;
  foughtPercent: number | null;
  retention: { d1: RetentionMetric; d7: RetentionMetric; d14: RetentionMetric };
  summary: string;
  definition: string;
}

/** Rounded percentages always carry their raw numerator/denominator. */
export function activityPercent(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round(numerator * 100 / denominator) : null;
}

export function activitySummary(stats: Pick<ActivityStats, 'dau' | 'foughtPercent' | 'retention'>): string {
  const returned = stats.retention.d1.percent;
  return `${stats.dau} ${stats.dau === 1 ? 'player' : 'players'} played today; ${returned === null ? 'there is not enough data for next-day retention' : `${returned}% of new players returned the next day`}; ${stats.foughtPercent === null ? 'there is not enough data for fighting share' : `${stats.foughtPercent}% of today's active players fought`}.`;
}

/** `eligible` is the same exclusion CTE used by every public player figure.
 * An old account's earliest surviving row cannot prove first-ever play. Only
 * accounts created after durable capture began enter acquisition cohorts. */
export async function computeActivityStats(db: DbOrTx, eligible: SQL, now: Date): Promise<ActivityStats> {
  const nowIso = now.toISOString();
  const day = nowIso.slice(0, 10);
  const [weekDays] = PLAYTEST_STATS.activeWindowsDays;
  const rows = await db.execute(sql`with e as (${eligible})
    select (select started_at from playtest_activity_coverage where key='authoritative-v1') as measurement_since,
      (${day}::date - (${weekDays} - 1))::text as week_from,
      count(distinct a.wallet) filter(where a.day=${day}::date)::int as dau,
      count(distinct a.wallet)::int as wau,
      count(distinct a.wallet) filter(where a.day=${day}::date and a.fought)::int as fought
    from player_activity_days a join e on e.wallet=a.wallet
    where a.day between ${day}::date - (${weekDays} - 1) and ${day}::date and a.first_at<=${nowIso}::timestamptz`);
  const row = rows[0]!;
  const coverage = row['measurement_since'];
  const retention = {} as ActivityStats['retention'];
  for (const days of PLAYTEST_STATS.retentionWindowsDays) {
    const cohortRows = await db.execute(sql`with e as (${eligible}), cohort as (
      select a.wallet,min(a.day) as first_day from player_activity_days a join e on e.wallet=a.wallet
      where e.created_at >= (select started_at from playtest_activity_coverage where key='authoritative-v1')
        and a.first_at >= e.created_at and a.first_at <= ${nowIso}::timestamptz group by a.wallet
    ), mature as (select * from cohort where first_day + ${days}::integer < ${day}::date)
    select count(*)::int as eligible,
      count(*) filter(where exists(select 1 from player_activity_days r where r.wallet=m.wallet and r.day=m.first_day+${days}::integer))::int as returned,
      min(first_day)::text as cohort_from,max(first_day)::text as cohort_through from mature m`);
    const c = cohortRows[0]!;
    const denominator = Number(c['eligible']);
    const returned = Number(c['returned']);
    retention[`d${days}`] = { eligible: denominator, returned, percent: activityPercent(returned, denominator),
      cohortFrom: c['cohort_from'] === null ? null : String(c['cohort_from']),
      cohortThrough: c['cohort_through'] === null ? null : String(c['cohort_through']) };
  }
  const stats: ActivityStats = {
    measurementSince: coverage ? (coverage instanceof Date ? coverage : new Date(String(coverage))).toISOString() : null,
    measuredThrough: nowIso, day, weekFrom: String(row['week_from']),
    dau: Number(row['dau']), wau: Number(row['wau']), foughtToday: Number(row['fought']),
    foughtPercent: activityPercent(Number(row['fought']), Number(row['dau'])), retention, summary: '',
    definition: 'Players are unique wallets taking authoritative in-game actions, deduplicated across lands and devices. Login and passive defence do not count. UTC calendar days; D1/D7/D14 measure return exactly that many days after first play, using completed target days and accounts created after measurement began. Earlier observed activity is incomplete and excluded from new-player cohorts.',
  };
  stats.summary = activitySummary(stats);
  return stats;
}
