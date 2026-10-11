/**
 * Public playtest statistics (D-103, M35 lane B).
 *
 * Every number here is SQL over the authoritative tables — players, sessions,
 * bases, buildings, raids, deposits, withdrawals, listings, faucet grants and
 * the three tester ledgers — so the public page can never disagree with the
 * game. Nothing is taken from a client claim. The worker snapshots the result
 * every `PLAYTEST_STATS.refreshEveryMs` into `playtest_stats_snapshots` and
 * `GET /playtest/stats` serves the latest row; the API never computes this
 * on request (one pass touches every large table).
 *
 * ONE EXCLUSION PREDICATE for every player-level figure (`eligiblePlayers`):
 * internal wallets (ALPHA/ADMIN env), admin-hidden board wallets, and players
 * with zero `sessions` rows (the K-048 scripted cohort never signed in through
 * the client). Activity and feedback rows are attributed through the acting
 * wallet, so the same predicate excludes them there too. MONEY IS THE
 * EXCEPTION (owner 2026-09-04): `money.*` counts every credited SOL deposit,
 * whoever sent it — see the DTO comment.
 *
 * COHORT. "Solana Mobile" = `players.seeker_verified` OR the first sign-in was
 * recorded from the installed shell (`players.first_client = 'solana-mobile'`,
 * written by /auth/verify from this release on). Everyone else is "browser";
 * older rows without a Seeker link therefore count as browser (D-103).
 */
import { PLAYTEST_CAMPAIGN, PLAYTEST_COMPETITIONS, PLAYTEST_STATS, TESTER_PROGRAM } from '@shardkeep/shared';
import { desc, lt, sql, type SQL } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { playtestStatsSnapshots } from '../db/schema';
import { computeActivityStats, type ActivityStats } from './playtestActivity';
import { notInternalPlaytestWallet } from './playtestEligibility';

import { mintVerificationStatus } from './playtestCampaigns';

type Row = Record<string, unknown>;

/** The slice of config the statistics need; the worker passes its Config. */
export type PlaytestStatsEnv = Pick<Config, 'ALPHA_WALLETS' | 'ADMIN_WALLETS' | 'CAMPAIGN_START_AT'>;

export interface PlaytestCohort {
  players: number;
  /** Founded a Keep (a bases row, or a legacy keep building). */
  onboarded: number;
  tutorialDone: number;
  /** Active paid base (bases.status active AND land_paid_at) or legacy entry_paid_at. */
  landOwners: number;
  /** Owns a Gold Forge building (`buildings.type = 'goldforge'`). */
  forgeBuilt: number;
  /** At least one resolved raid as attacker (PvE or PvP). */
  firstRaid: number;
  /** At least one resolved raid as attacker against another player. */
  firstPvp: number;
  /** @deprecated Historical last-seen figures; public activity uses engagement. */
  active7d: number;
  active30d: number;
  /** Seen again more than seven days after the players row was created. */
  returnedAfter7d: number;
  /** @deprecated Historical points-derived count; public DAU uses engagement. */
  activeToday: number;
}

export interface PlaytestStats {
  computedAt: string;
  /** D-118: points-independent, authoritative activity and exact retention. */
  engagement: ActivityStats;
  campaign: {
    name: string;
    totalDays: number;
    startAt: string | null;
    endAt: string | null;
    /** 1-based day inside the window, null outside it or when no window is set. */
    dayIndex: number | null;
    rewardCopy: string;
    /** Community goal rungs for MINTED LAND DEEDS (owner 2026-09-04). */
    deedGoals: number[];
    /** Null means verification unavailable, never zero verified players. */
    checkpointCount: number | null;
    checkpointAvailable: boolean;
    founderSpots: number;
    rankedSpots: number;
    snapshotComplete: boolean;
  };
  cohorts: { total: PlaytestCohort; solanaMobile: PlaytestCohort; browser: PlaytestCohort };
  activity: {
    battlesResolved: number;
    pvpBattles: number;
    pveBattles: number;
    battlesLast7d: number;
    /** Completed builder_jobs of kind upgrade on a mine. */
    mineUpgrades: number;
    /** Index i = number of onboarded eligible players whose Keep is level i+1 (L1–L20). */
    keepLevels: number[];
    deedsMinted: number;
    depositsCredited: number;
    withdrawalsSent: number;
    /** item_listings settled as sold. */
    marketTrades: number;
  };
  /** Mining and Gold Forge participation (owner 2026-09-04: "how much people
   *  build gold forge and participating in mining"). Wallets are eligible
   *  players; a wallet counts once however many mines or bases it runs. */
  mining: {
    /** Distinct wallets with a `mine.collect` ledger transaction in the last 7 days / ever. */
    miners7d: number;
    minersTotal: number;
    /** Distinct wallets that deployed Shards into the Gold Forge (`forge.contribute`) in the last 7 days / ever. */
    forgeWorkers7d: number;
    forgeWorkersTotal: number;
    /** Ledger transactions over the whole playtest. */
    mineCollections: number;
    forgeDeployments: number;
    /** Gold Forges standing on eligible players' bases (same rule as cohorts.*.forgeBuilt, summed). */
    forgesBuilt: number;
  };
  /** SOL amounts are lamports rendered as a decimal string with two places
   *  ("0.20"); KEEP-denominated deposits (`keep_deposit`) are never summed here.
   *  MONEY IS NOT FILTERED BY PLAYER ELIGIBILITY (owner 2026-09-04: "I want real
   *  metrics"): every credited deposit row is a payment the treasuries received,
   *  verified on-chain by signature, whoever sent it — the team wallet included,
   *  hidden and zero-session wallets included. The funnels exclude the team; the
   *  money figures report what actually moved. `solSpentByKind` folds the `entry`
   *  and `deed` deposit kinds into one `land` key: both are Land Deed purchases at
   *  ECONOMY.entryFeeSol, `entry` is only the first one a wallet makes.
   *  `solSpentCountByKind` is the number of credited purchases behind each
   *  amount, same keys. */
  money: {
    solSpentTotal: string; solSpentByKind: Record<string, string>;
    solSpentCountByKind: Record<string, number>; faucetSolGranted: string;
  };
  feedback: { received: number; accepted: number; fixed: number };
  points: { total: number; awardedToday: number; testersListed: number };
}

function asInt(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return 0n;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Lamports → SOL with two decimals, rounded half-up, as a string ("0.20"). */
export function lamportsToSol(lamports: bigint): string {
  const hundredths = (lamports + LAMPORTS_PER_SOL / 200n) / (LAMPORTS_PER_SOL / 100n);
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

/** Team/internal wallets — the same set routes-tester.ts keeps off the board. */
export function internalWalletsOf(env: Pick<Config, 'ALPHA_WALLETS' | 'ADMIN_WALLETS'>): string[] {
  return [...new Set([...(env.ALPHA_WALLETS ?? []), ...(env.ADMIN_WALLETS ?? [])])];
}

/** Presentation-only window (D-103): unset env ⇒ no dates and no day counter. */
export function campaignWindow(
  startAt: string | undefined, now: Date,
): { startAt: string | null; endAt: string | null; dayIndex: number | null } {
  if (!startAt) return { startAt: null, endAt: null, dayIndex: null };
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return { startAt: null, endAt: null, dayIndex: null };
  const dayMs = 86_400_000;
  const end = new Date(start.getTime() + PLAYTEST_CAMPAIGN.totalDays * dayMs);
  const inside = now.getTime() >= start.getTime() && now.getTime() < end.getTime();
  const dayIndex = inside ? Math.floor((now.getTime() - start.getTime()) / dayMs) + 1 : null;
  return { startAt: start.toISOString(), endAt: end.toISOString(), dayIndex };
}

/**
 * THE exclusion predicate, as a CTE body: one row per player who counts.
 * `mobile` is the cohort flag. Reused by every query below so a change here
 * moves every public number together.
 */
function eligiblePlayers(internal: readonly string[]): SQL {
  const internalClause = sql`and ${notInternalPlaytestWallet(sql`p.wallet`, internal)}`;
  const sessionClause = PLAYTEST_STATS.excludeZeroSessionPlayers
    ? sql`and exists (select 1 from sessions s where s.wallet = p.wallet)`
    : sql``;
  return sql`select p.wallet, p.created_at, p.last_seen_at, p.keep_level, p.entry_paid_at,
      (p.seeker_verified or coalesce(p.first_client = 'solana-mobile', false)) as mobile
    from players p
    where not exists (select 1 from tester_board_hidden h where h.wallet = p.wallet)
      ${sessionClause} ${internalClause}`;
}

/** Board visibility, copied from tester.ts `boardEligible` (TESTER_PROGRAM.board)
 *  rather than imported so lane A can evolve that module without coupling. */
function boardListed(internal: readonly string[]): SQL {
  const required = TESTER_PROGRAM.board.requiredMilestone;
  const foundingOnly = sql.join(TESTER_PROGRAM.board.foundingOnlyKeys.map((k) => sql`${k}`), sql`, `);
  const internalClause = sql`and ${notInternalPlaytestWallet(sql`u.wallet`, internal)}`;
  const session = TESTER_PROGRAM.board.requireSession
    ? sql`and exists (select 1 from sessions s where s.wallet = u.wallet)`
    : sql``;
  return sql`exists (select 1 from tester_milestones r where r.wallet = u.wallet and r.key = ${required})
    and exists (select 1 from tester_milestones r2 where r2.wallet = u.wallet and r2.key not in (${foundingOnly}))
    ${session}
    and not exists (select 1 from tester_board_hidden h where h.wallet = u.wallet) ${internalClause}`;
}

function emptyCohort(): PlaytestCohort {
  return {
    players: 0, onboarded: 0, tutorialDone: 0, landOwners: 0, forgeBuilt: 0, firstRaid: 0, firstPvp: 0,
    active7d: 0, active30d: 0, returnedAfter7d: 0, activeToday: 0,
  };
}

function cohortFromRow(r: Row): PlaytestCohort {
  return {
    players: asInt(r['players']),
    onboarded: asInt(r['onboarded']),
    tutorialDone: asInt(r['tutorial_done']),
    landOwners: asInt(r['land_owners']),
    forgeBuilt: asInt(r['forge_built']),
    firstRaid: asInt(r['first_raid']),
    firstPvp: asInt(r['first_pvp']),
    active7d: asInt(r['active_7d']),
    active30d: asInt(r['active_30d']),
    returnedAfter7d: asInt(r['returned_after_7d']),
    activeToday: asInt(r['active_today']),
  };
}

function addCohorts(a: PlaytestCohort, b: PlaytestCohort): PlaytestCohort {
  const out = emptyCohort();
  for (const k of Object.keys(out) as Array<keyof PlaytestCohort>) out[k] = a[k] + b[k];
  return out;
}

/** UTC calendar day of `now` as a date literal for `tester_daily_points.day`. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** D-118: the admin-controlled campaign row is the sole date authority. Mint
 * checkpoints use verified original minters; after launch, standings eligibility
 * supplies the remaining spots. General minted-deed statistics stay independent. */
export async function computeFoundingCampaignStats(db: DbOrTx, now: Date, internal: readonly string[] = []): Promise<PlaytestStats['campaign']> {
  const mintStatus = await mintVerificationStatus(db, internal, now);
  const rows = await db.execute(sql`select c.start_at,c.end_at,c.snapshot_at,c.cancelled_at,
    (select count(*)::int from playtest_founders f where ${notInternalPlaytestWallet(sql`f.wallet`, internal)}) as founders,
    (select count(*)::int from playtest_campaign_scores s where s.campaign_id=${PLAYTEST_COMPETITIONS.foundingId}
      and s.eligible and s.points>0 and ${notInternalPlaytestWallet(sql`s.wallet`, internal)}
      and not exists(select 1 from playtest_founders f where f.wallet=s.wallet)) as ranked
    from (select 1) seed left join playtest_campaigns c on c.id=${PLAYTEST_COMPETITIONS.foundingId}`);
  const row = rows[0]!;
  const start = row['start_at'] ? new Date(String(row['start_at'])) : null;
  const end = row['end_at'] ? new Date(String(row['end_at'])) : null;
  const beforeLaunch = !start || now < start;
  const inside = start && end && now >= start && now < end && !row['cancelled_at'];
  return {
    name: PLAYTEST_CAMPAIGN.name, totalDays: PLAYTEST_COMPETITIONS.durationDays,
    startAt: start?.toISOString() ?? null, endAt: end?.toISOString() ?? null,
    dayIndex: inside ? Math.floor((+now - +start) / 86_400_000) + 1 : null,
    rewardCopy: PLAYTEST_CAMPAIGN.rewardCopy, deedGoals: [...PLAYTEST_CAMPAIGN.deedGoals],
    checkpointCount: beforeLaunch ? (row['snapshot_at'] ? Number(row['founders']) : mintStatus.complete ? Math.min(PLAYTEST_COMPETITIONS.founderSpots, mintStatus.verifiedUniqueWallets) : null)
      : Number(row['founders']) + Math.min(PLAYTEST_COMPETITIONS.rankedSpots, Number(row['ranked'])),
    checkpointAvailable: !beforeLaunch || !!row['snapshot_at'] || mintStatus.complete,
    founderSpots: PLAYTEST_COMPETITIONS.founderSpots, rankedSpots: PLAYTEST_COMPETITIONS.rankedSpots,
    snapshotComplete: !!row['snapshot_at'] && Number(row['founders']) === PLAYTEST_COMPETITIONS.founderSpots,
  };
}

/**
 * Compute the full public statistics document at `now`. Pure read; safe to
 * call from a test with fixtures and from the worker every five minutes.
 */
export async function computePlaytestStats(db: Db, env: PlaytestStatsEnv, now: Date): Promise<PlaytestStats> {
  const internal = internalWalletsOf(env);
  const eligible = eligiblePlayers(internal);
  const engagement = await computeActivityStats(db, eligible, now);
  const campaign = await computeFoundingCampaignStats(db, now, internal);
  // postgres.js binds a raw Date poorly in `execute`; pass ISO text and cast.
  const nowIso = now.toISOString();
  const today = utcDay(now);
  const [win7, win30] = PLAYTEST_STATS.activeWindowsDays;

  // --- Cohorts: one row per cohort flag, summed for `total` -------------------
  const cohortRows = await db.execute<Row>(sql`with e as (${eligible})
    select e.mobile,
      count(*)::int as players,
      count(*) filter (where exists (select 1 from bases b where b.owner_wallet = e.wallet)
        or exists (select 1 from buildings k where k.player_wallet = e.wallet and k.type = 'keep'))::int as onboarded,
      count(*) filter (where exists (select 1 from tutorial_progress t
        where t.player_wallet = e.wallet and t.completed_at is not null))::int as tutorial_done,
      count(*) filter (where e.entry_paid_at is not null or exists (select 1 from bases b
        where b.owner_wallet = e.wallet and b.status = 'active' and b.land_paid_at is not null))::int as land_owners,
      count(*) filter (where exists (select 1 from buildings g left join bases gb on gb.id = g.base_id
        where g.type = 'goldforge' and coalesce(gb.owner_wallet, g.player_wallet) = e.wallet))::int as forge_built,
      count(*) filter (where exists (select 1 from raids r
        where r.attacker_wallet = e.wallet and r.status = 'resolved'))::int as first_raid,
      count(*) filter (where exists (select 1 from raids r
        where r.attacker_wallet = e.wallet and r.status = 'resolved' and r.defender_wallet is not null))::int as first_pvp,
      count(*) filter (where e.last_seen_at >= ${nowIso}::timestamptz - make_interval(days => ${win7}))::int as active_7d,
      count(*) filter (where e.last_seen_at >= ${nowIso}::timestamptz - make_interval(days => ${win30}))::int as active_30d,
      count(*) filter (where e.last_seen_at > e.created_at + make_interval(days => ${win7}))::int as returned_after_7d,
      count(*) filter (where exists (select 1 from tester_daily_points d
        where d.wallet = e.wallet and d.day = ${today}::date and d.key = 'played'))::int as active_today
    from e group by e.mobile`);
  let solanaMobile = emptyCohort();
  let browser = emptyCohort();
  for (const r of cohortRows as unknown as Row[]) {
    if (r['mobile'] === true) solanaMobile = cohortFromRow(r);
    else browser = cohortFromRow(r);
  }

  // --- Activity -----------------------------------------------------------------
  const activityRows = await db.execute<Row>(sql`with e as (${eligible})
    select
      (select count(*) from raids r join e on e.wallet = r.attacker_wallet
        where r.status = 'resolved')::int as battles_resolved,
      (select count(*) from raids r join e on e.wallet = r.attacker_wallet
        where r.status = 'resolved' and r.defender_wallet is not null)::int as pvp_battles,
      (select count(*) from raids r join e on e.wallet = r.attacker_wallet
        where r.status = 'resolved' and r.defender_wallet is null)::int as pve_battles,
      (select count(*) from raids r join e on e.wallet = r.attacker_wallet
        where r.status = 'resolved' and r.resolved_at >= ${nowIso}::timestamptz - make_interval(days => ${win7}))::int as battles_last_7d,
      (select count(*) from builder_jobs j join buildings b on b.id = j.building_id join e on e.wallet = j.player_wallet
        where j.kind = 'upgrade' and b.type = 'mine' and j.completed_at is not null)::int as mine_upgrades,
      (select count(*) from bases b join e on e.wallet = b.owner_wallet where b.deed_asset_id is not null)::int as deeds_minted,
      (select count(*) from deposits d join e on e.wallet = d.player_wallet where d.status = 'credited')::int as deposits_credited,
      (select count(*) from withdrawals w join e on e.wallet = w.player_wallet where w.status = 'sent')::int as withdrawals_sent,
      (select count(*) from item_listings l join e on e.wallet = l.seller_wallet where l.status = 'sold')::int as market_trades`);
  const a = (activityRows as unknown as Row[])[0] ?? {};

  // Keep histogram: one bucket per onboarded eligible player at the greatest of
  // their bases' keep_level and the legacy players.keep_level (tester.ts rule),
  // so the sum of the buckets equals cohorts.total.onboarded.
  const keepRows = await db.execute<Row>(sql`with e as (${eligible}), k as (
      select greatest((select coalesce(max(b.keep_level), 0) from bases b where b.owner_wallet = e.wallet), e.keep_level) as lvl
      from e
      where exists (select 1 from bases b where b.owner_wallet = e.wallet)
        or exists (select 1 from buildings kb where kb.player_wallet = e.wallet and kb.type = 'keep'))
    select lvl, count(*)::int as n from k group by lvl`);
  const keepLevels: number[] = Array.from({ length: PLAYTEST_STATS.keepLevels }, () => 0);
  for (const r of keepRows as unknown as Row[]) {
    const idx = Math.min(PLAYTEST_STATS.keepLevels, Math.max(1, asInt(r['lvl']))) - 1;
    keepLevels[idx] = (keepLevels[idx] ?? 0) + asInt(r['n']);
  }

  // --- Money: credited deposits by kind, SOL kinds only ------------------------
  // `deposits.amount` is the paid lamports for every SOL kind and KEEP base
  // units for `keep_deposit` (money/mintDimension.ts KEEP_DENOMINATED), so the
  // KEEP kind is excluded here rather than mixed into a SOL total.
  // `entry` (a wallet's first Land Deed) and `deed` (every further one) are the
  // same purchase to a reader, so they are published as one `land` line.
  // No eligibility join here (see the DTO comment): a credited row is SOL the
  // treasuries received, verified by its transaction signature. Reconciled
  // against the chain on 2026-09-04: every credited SOL row matched its
  // on-chain transfer or PaymentMade event to the lamport.
  const moneyRows = await db.execute<Row>(sql`
    select case when d.kind in ('entry', 'deed') then 'land' else d.kind::text end as kind,
      count(*)::int as n, sum(d.amount)::text as lamports
    from deposits d
    where d.status = 'credited' and d.kind <> 'keep_deposit' and d.amount is not null
    group by 1 order by 1`);
  const solSpentByKind: Record<string, string> = {};
  const solSpentCountByKind: Record<string, number> = {};
  let solTotal = 0n;
  for (const r of moneyRows as unknown as Row[]) {
    const lamports = asBigInt(r['lamports']);
    solSpentByKind[String(r['kind'])] = lamportsToSol(lamports);
    solSpentCountByKind[String(r['kind'])] = asInt(r['n']);
    solTotal += lamports;
  }
  const faucetRows = await db.execute<Row>(sql`
    select coalesce(sum(g.lamports), 0)::text as lamports
    from devnet_faucet_grants g where g.status = 'sent'`);
  const faucetLamports = asBigInt(((faucetRows as unknown as Row[])[0] ?? {})['lamports']);

  // --- Mining and Gold Forge participation ---------------------------------------
  // Ledger transactions attributed the way tester.ts attributes them: through
  // the entry's account owner (wallet economy) or the account's base owner
  // (deed economy). A wallet counts once per bucket however many rows it has.
  const miningRows = await db.execute<Row>(sql`with e as (${eligible}), lt as (
      select distinct t.id, t.type, t.created_at, coalesce(a.owner_wallet, b.owner_wallet) as wallet
      from ledger_transactions t
        join ledger_entries en on en.txn_id = t.id
        join accounts a on a.id = en.account_id
        left join bases b on b.id = a.base_id
      where t.type in ('mine.collect', 'forge.contribute'))
    select
      count(distinct lt.wallet) filter (where lt.type = 'mine.collect'
        and lt.created_at >= ${nowIso}::timestamptz - make_interval(days => ${win7}))::int as miners_7d,
      count(distinct lt.wallet) filter (where lt.type = 'mine.collect')::int as miners_total,
      count(distinct lt.wallet) filter (where lt.type = 'forge.contribute'
        and lt.created_at >= ${nowIso}::timestamptz - make_interval(days => ${win7}))::int as forge_workers_7d,
      count(distinct lt.wallet) filter (where lt.type = 'forge.contribute')::int as forge_workers_total,
      count(distinct lt.id) filter (where lt.type = 'mine.collect')::int as mine_collections,
      count(distinct lt.id) filter (where lt.type = 'forge.contribute')::int as forge_deployments
    from lt join e on e.wallet = lt.wallet`);
  const mn = (miningRows as unknown as Row[])[0] ?? {};

  // --- Feedback → fixes ----------------------------------------------------------
  const feedbackRows = await db.execute<Row>(sql`with e as (${eligible})
    select count(*)::int as received,
      count(*) filter (where f.status in ('accepted', 'fixed') or f.fixed_at is not null)::int as accepted,
      count(*) filter (where f.fixed_at is not null or f.status = 'fixed')::int as fixed
    from tester_feedback f join e on e.wallet = f.wallet`);
  const f = (feedbackRows as unknown as Row[])[0] ?? {};

  // --- Points: all three ledgers, and the board-listed count --------------------
  const pointsRows = await db.execute<Row>(sql`with e as (${eligible})
    select
      ((select coalesce(sum(m.points), 0) from tester_milestones m join e on e.wallet = m.wallet)
        + (select coalesce(sum(fb.points), 0) from tester_feedback fb join e on e.wallet = fb.wallet)
        + (select coalesce(sum(d.points), 0) from tester_daily_points d join e on e.wallet = d.wallet))::int as total,
      (select coalesce(sum(d.points), 0) from tester_daily_points d join e on e.wallet = d.wallet
        where d.day = ${today}::date)::int as awarded_today,
      (select count(*) from players u where ${boardListed(internal)})::int as testers_listed`);
  const p = (pointsRows as unknown as Row[])[0] ?? {};

  return {
    computedAt: now.toISOString(),
    engagement,
    campaign,
    cohorts: { total: addCohorts(solanaMobile, browser), solanaMobile, browser },
    activity: {
      battlesResolved: asInt(a['battles_resolved']),
      pvpBattles: asInt(a['pvp_battles']),
      pveBattles: asInt(a['pve_battles']),
      battlesLast7d: asInt(a['battles_last_7d']),
      mineUpgrades: asInt(a['mine_upgrades']),
      keepLevels,
      deedsMinted: asInt(a['deeds_minted']),
      depositsCredited: asInt(a['deposits_credited']),
      withdrawalsSent: asInt(a['withdrawals_sent']),
      marketTrades: asInt(a['market_trades']),
    },
    mining: {
      miners7d: asInt(mn['miners_7d']),
      minersTotal: asInt(mn['miners_total']),
      forgeWorkers7d: asInt(mn['forge_workers_7d']),
      forgeWorkersTotal: asInt(mn['forge_workers_total']),
      mineCollections: asInt(mn['mine_collections']),
      forgeDeployments: asInt(mn['forge_deployments']),
      forgesBuilt: solanaMobile.forgeBuilt + browser.forgeBuilt,
    },
    money: {
      solSpentTotal: lamportsToSol(solTotal),
      solSpentByKind,
      solSpentCountByKind,
      faucetSolGranted: lamportsToSol(faucetLamports),
    },
    feedback: { received: asInt(f['received']), accepted: asInt(f['accepted']), fixed: asInt(f['fixed']) },
    points: { total: asInt(p['total']), awardedToday: asInt(p['awarded_today']), testersListed: asInt(p['testers_listed']) },
  };
}

/**
 * Worker entry: compute, persist one snapshot row, trim rows older than
 * `PLAYTEST_STATS.retentionDays`. Idempotent per `now` (computed_at is the
 * primary key) and never throws on a same-instant re-run.
 */
export async function writePlaytestStatsSnapshot(db: Db, env: PlaytestStatsEnv, now = new Date()): Promise<PlaytestStats> {
  const stats = await computePlaytestStats(db, env, now);
  await db.insert(playtestStatsSnapshots).values({ computedAt: now, payload: stats }).onConflictDoNothing();
  const cutoff = new Date(now.getTime() - PLAYTEST_STATS.retentionDays * 86_400_000);
  await db.delete(playtestStatsSnapshots).where(lt(playtestStatsSnapshots.computedAt, cutoff));
  return stats;
}

/** Latest snapshot for the public route, or null before the worker's first run. */
export async function latestPlaytestStats(db: Db): Promise<PlaytestStats | null> {
  const [row] = await db.select().from(playtestStatsSnapshots)
    .orderBy(desc(playtestStatsSnapshots.computedAt)).limit(1);
  if (!row) return null;
  return { ...(row.payload as PlaytestStats), computedAt: row.computedAt.toISOString() };
}
