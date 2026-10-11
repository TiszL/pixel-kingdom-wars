/**
 * Action-day derivation (D-103, owner 2026-09-04: daily participation counts
 * on "Action, any" — a sign-in alone never counts).
 *
 * ONE aggregator answers, for a wallet and a list of UTC days, which
 * `TESTER_DAILY` sources fired on each day and how many times, reading only
 * the authoritative ledgers and tables (never the tester tables, never a
 * client claim). The daily-points recompute (game/tester.ts) and the public
 * playtest statistics both build on it, so "played today" has exactly one
 * definition. The list of signals is documented in
 * `TESTER_DAILY.actionSignals`; the table/column choices below mirror
 * `detectMilestones` so a first-time milestone and its daily counterpart can
 * never disagree about what happened.
 *
 * Attribution: wallet-keyed rows go to that wallet; base-keyed rows (base
 * quests, base ledger accounts, builder jobs on a base) go to the base's
 * CURRENT owner (`bases.owner_wallet`) and the base id is reported so the
 * award can snapshot it in `meta`. Combat rows use the owner AT battle time
 * (`raids.attacker_wallet` / `base_battle_records.owner_wallet_at_battle`),
 * which is who fought. Deposits: every kind is paid in SOL except
 * `keep_deposit` (money/deposits.ts — `keep_vend` is a SOL purchase of KEEP),
 * so `sol_deposit` = credited deposits of any other kind.
 */
import type { TesterDailyKey } from '@shardkeep/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';

type Row = Record<string, unknown>;

/** Source keys the aggregator can report (everything in TESTER_DAILY.sources
 * except the two derived ones — `played` and `referral_active`). */
export type ActionSourceKey = Exclude<TesterDailyKey, 'played' | 'referral_active' | `streak_${number}`>;

export interface ActionCount {
  /** Distinct events (ledger transactions, raids, rows) of this source that day. */
  count: number;
  /** For base-keyed rows: one base the events belong to (snapshot for `meta`). */
  baseId: string | null;
}

/** day ('YYYY-MM-DD', UTC) → source → count. Days with no action are absent. */
export type ActionDayCounts = Map<string, Map<ActionSourceKey, ActionCount>>;

const DAY_MS = 86_400_000;

/** The UTC calendar day of an instant, as 'YYYY-MM-DD'. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `day` shifted by `delta` calendar days (UTC). */
export function shiftDay(day: string, delta: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00.000Z`) + delta * DAY_MS));
}

/** The `n` UTC days ending at `now` (inclusive), ascending. */
export function utcDaysEndingAt(now: Date, n: number): string[] {
  const today = utcDay(now);
  return Array.from({ length: n }, (_, i) => shiftDay(today, i - (n - 1)));
}

/**
 * Per-day per-source event counts for one wallet over `days` (any order;
 * only those days are reported). One round trip: every source is a branch of
 * one UNION, each already bounded to the window so the wallet/time indexes
 * do the work, then grouped by UTC day and key.
 */
export async function actionDayCounts(
  db: DbOrTx, wallet: string, days: readonly string[],
): Promise<ActionDayCounts> {
  const out: ActionDayCounts = new Map();
  if (days.length === 0) return out;
  const sorted = [...days].sort();
  const from = `${sorted[0]}T00:00:00.000Z`;
  const to = `${shiftDay(sorted[sorted.length - 1]!, 1)}T00:00:00.000Z`;
  const w = wallet;
  const win = (col: SQL): SQL => sql`${col} >= ${from}::timestamptz and ${col} < ${to}::timestamptz`;
  // Base-keyed rows belong to whoever owned the base WHEN the action happened.
  // `bases.owner_wallet` is the current owner and `accounts.owner_wallet` is
  // never rewritten by a deed sale, so without this bound a buyer would be
  // credited (and the lookback would re-derive) the seller's last days of
  // collecting, building and questing on that base. The latest transfer TO
  // this wallet is when its ownership of the base's deed began.
  const ownedSince = (b: SQL): SQL => sql`coalesce((select max(bt.created_at) from base_transfers bt
      where bt.deed_asset_id = ${b}.deed_asset_id and bt.to_wallet = ${w}), '-infinity'::timestamptz)`;

  const rows = await db.execute<Row>(sql`
    select to_char(x.at at time zone 'UTC', 'YYYY-MM-DD') as day, x.key,
      count(distinct x.ref)::int as n, min(x.base_id) as base_id
    from (
      -- Ledger-backed actions (both economy arms: wallet accounts and base accounts).
      select t.created_at as at,
        case t.type
          when 'mine.collect' then 'mine_collected'
          when 'cache.claim' then 'cache_claimed'
          when 'army.train' then 'troops_trained'
          when 'forge.contribute' then 'forge_deployed'
          when 'forge.claim' then 'forge_claimed'
          when 'item.buy' then 'shop_bought'
          else 'build_started' end as key,
        t.id::text as ref, a.base_id::text as base_id
      from ledger_transactions t
        join ledger_entries e on e.txn_id = t.id
        join accounts a on a.id = e.account_id
        left join bases b on b.id = a.base_id
      where t.type in ('mine.collect', 'cache.claim', 'army.train', 'forge.contribute', 'forge.claim', 'item.buy',
          -- Construction STARTS only: paying to speed up a job already running
          -- ('build.speedup') starts nothing and is not a build day.
          'build.place', 'build.upgrade', 'build.mine', 'build.repair', 'build.upgrade_mine', 'build.upgrade_goldforge')
        and (a.owner_wallet = ${w} or (b.owner_wallet = ${w} and t.created_at >= ${ownedSince(sql`b`)}))
        -- A debit that was refunded by cancelling the upgrade (D-104) bought
        -- nothing: start-then-cancel must not mark a build day.
        and not exists (select 1 from builder_jobs cj where cj.debit_ledger_txn_id = t.id and cj.cancelled_at is not null)
        and ${win(sql`t.created_at`)}
      union all
      -- Any construction start (build, upgrade, clear, repair), wallet- or base-keyed.
      -- A cancelled job (D-104) never counts, whenever it was cancelled.
      select j.started_at, 'build_started', j.id::text, j.base_id::text
      from builder_jobs j left join bases b on b.id = j.base_id
      where (j.player_wallet = ${w} or (b.owner_wallet = ${w} and j.started_at >= ${ownedSince(sql`b`)}))
        and j.cancelled_at is null
        and ${win(sql`j.started_at`)}
      union all
      -- Quest claims: legacy wallet-keyed rows plus the live base-keyed table.
      select q.claimed_at, 'quest_claimed', q.id::text, null::text
      from quest_progress q where q.player_wallet = ${w} and q.claimed_at is not null and ${win(sql`q.claimed_at`)}
      union all
      select q.claimed_at, 'quest_claimed', q.id::text, q.base_id::text
      from base_quest_progress q join bases b on b.id = q.base_id
      where b.owner_wallet = ${w} and q.claimed_at is not null and q.claimed_at >= ${ownedSince(sql`b`)}
        and ${win(sql`q.claimed_at`)}
      union all
      -- Combat. A raid is counted once even when both the raids row and its
      -- battle record qualify (count(distinct ref) on the raid id).
      -- PvE: a campaign stage is free and replayable, so a zero-star attempt
      -- (one unit sent to die) is not a battle day — the same proof-of-play
      -- rule markRaidAction applies (game/raids.ts).
      select coalesce(r.resolved_at, r.created_at), 'pve_battle', r.id::text, r.attacker_base_id::text
      from raids r where r.attacker_wallet = ${w} and r.defender_wallet is null and r.status = 'resolved'
        and (r.campaign_stage is null or coalesce((r.result->>'stars')::int, 0) >= 1)
        and ${win(sql`coalesce(r.resolved_at, r.created_at)`)}
      union all
      -- PvP wins need an opponent: the raids row carries defender_wallet, the
      -- battle record carries counterparty_base_id. Camp and campaign raids
      -- also write attacker battle records (with no counterparty) and must
      -- never pay the capped PvP source.
      select coalesce(r.resolved_at, r.created_at), 'pvp_win', r.id::text, r.attacker_base_id::text
      from raids r where r.attacker_wallet = ${w} and r.defender_wallet is not null and r.status = 'resolved'
        and coalesce((r.result->>'stars')::int, 0) >= 1 and ${win(sql`coalesce(r.resolved_at, r.created_at)`)}
      union all
      select bb.created_at, 'pvp_win', bb.raid_id::text, bb.base_id::text
      from base_battle_records bb where bb.owner_wallet_at_battle = ${w} and bb.role = 'attacker' and bb.stars >= 1
        and bb.counterparty_base_id is not null and ${win(sql`bb.created_at`)}
      union all
      -- A held defence is a real outcome but a PASSIVE one (see PASSIVE_KEYS);
      -- an attacker who retreats at once did not test the defence at all.
      select coalesce(r.resolved_at, r.created_at), 'defence_held', r.id::text, r.defender_base_id::text
      from raids r where r.defender_wallet = ${w} and r.status = 'resolved'
        and coalesce((r.result->>'stars')::int, 0) = 0 and coalesce(r.result->>'retreated', 'false') <> 'true'
        and ${win(sql`coalesce(r.resolved_at, r.created_at)`)}
      union all
      select bb.created_at, 'defence_held', bb.raid_id::text, bb.base_id::text
      from base_battle_records bb join raids r on r.id = bb.raid_id
      where bb.owner_wallet_at_battle = ${w} and bb.role = 'defender' and bb.stars = 0
        and coalesce(r.result->>'retreated', 'false') <> 'true' and ${win(sql`bb.created_at`)}
      union all
      -- SOL marketplace.
      select l.created_at, 'market_listed', l.id::text, l.base_id::text
      from item_listings l where l.seller_wallet = ${w} and ${win(sql`l.created_at`)}
      union all
      select coalesce(l.settled_at, l.created_at), 'market_bought', l.id::text, l.buyer_base_id::text
      from item_listings l where l.buyer_wallet = ${w} and l.status = 'sold'
        and ${win(sql`coalesce(l.settled_at, l.created_at)`)}
      union all
      select u.used_at, 'item_used', u.id::text, null::text
      from item_uses u where u.player_wallet = ${w} and ${win(sql`u.used_at`)}
      union all
      -- Money. Credited deposits by kind; withdrawals once paid on-chain.
      select coalesce(d.finalized_at, d.created_at),
        case when d.kind = 'keep_deposit' then 'keep_deposit' else 'sol_deposit' end, d.id::text, null::text
      from deposits d where d.player_wallet = ${w} and d.status = 'credited'
        and ${win(sql`coalesce(d.finalized_at, d.created_at)`)}
      union all
      select coalesce(wd.completed_at, wd.created_at), 'withdrawal_sent', wd.id::text, null::text
      from withdrawals wd where wd.player_wallet = ${w} and wd.status = 'sent'
        and ${win(sql`coalesce(wd.completed_at, wd.created_at)`)}
      union all
      -- Social and program.
      select c.created_at, 'chat_sent', c.id::text, null::text
      from global_chat_messages c where c.author_wallet = ${w} and ${win(sql`c.created_at`)}
      union all
      select m.claimed_at, 'mail_claimed', m.id::text, m.claim_base_id::text
      from mail_messages m where m.recipient_wallet = ${w} and m.claimed_at is not null and ${win(sql`m.claimed_at`)}
      union all
      select f.created_at, 'feedback_sent', f.id::text, null::text
      from tester_feedback f where f.wallet = ${w} and ${win(sql`f.created_at`)}
    ) x
    group by 1, 2`);

  const wanted = new Set(days);
  for (const r of rows as unknown as Row[]) {
    const day = String(r['day']);
    if (!wanted.has(day)) continue;
    const key = String(r['key']) as ActionSourceKey;
    const n = Number(r['n'] ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    let byKey = out.get(day);
    if (!byKey) { byKey = new Map(); out.set(day, byKey); }
    byKey.set(key, { count: n, baseId: typeof r['base_id'] === 'string' ? r['base_id'] : null });
  }
  return out;
}

/** Sources that happen TO a wallet rather than being done BY it. They pay
 * their own points but never make a day "played" (D-103: played = any real
 * action of the player's own), so an alt raiding a dormant main cannot keep
 * its streak — or its referrer's referral days — alive. */
export const PASSIVE_KEYS: ReadonlySet<ActionSourceKey> = new Set<ActionSourceKey>(['defence_held']);

/** The days on which the wallet itself did anything ("played"). */
export function actionDaysOf(counts: ActionDayCounts): Set<string> {
  const days = new Set<string>();
  for (const [day, byKey] of counts) {
    for (const key of byKey.keys()) {
      if (!PASSIVE_KEYS.has(key)) { days.add(day); break; }
    }
  }
  return days;
}
