/**
 * Read-only weekly season view for the Leagues card (overnight builder,
 * 2026-10-06; owner: "show live prize and potential winners before season ends").
 *
 * PROJECTION ONLY. Nothing here claims, allocates, records, signs or pays. The
 * official SKR allocation (D153.286) ranks close total minus an immutable v2
 * week-start snapshot; this server has no v2 close yet, so the projection uses
 * this week's trophy change from resolved rated (deed PvP) raids instead.
 * Eligibility and ordering mirror the reviewed allocation: legacy reward
 * candidate (trophies > 0, the minimum rated attacks, one kingdom per wallet),
 * weekly score at least `minWeeklyScore`, then weekly score desc, total trophies
 * desc, base id asc. Per-place amounts use the allocation's integer math, so
 * unfilled places and dust are never re-weighted.
 */
import {
  LEAGUE_SEASON_TEST_POT, LEAGUE_SEASON_VIEW, LEAGUES, PHASE_E_LEAGUE_REWARDS,
  type LeagueSeasonView, type LeagueSeasonYouReason,
} from '@shardkeep/shared';
import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { baseProfiles, bases, players, raids } from '../db/schema';
import {
  LEAGUE_TIERS, leagueForTrophies, leagueWeeklyRewards, leagueWindow,
  ratedAttacksByBase, resolveLeagueBaseId, rewardedBaseIds, type RankedBase,
} from './leagues';

const SKR = PHASE_E_LEAGUE_REWARDS.v1.skr;

export interface LeagueSeasonPrizePolicy {
  /** True only on devnet with LEAGUE_SEASON_TEST_POT_ENABLED=true. */
  testPotEnabled: boolean;
}

export function defaultSeasonPrizePolicy(cluster: string): LeagueSeasonPrizePolicy {
  return {
    testPotEnabled: cluster === LEAGUE_SEASON_TEST_POT.cluster
      && process.env['LEAGUE_SEASON_TEST_POT_ENABLED'] === 'true',
  };
}

/** The pot this view may show, or null (the designed "not set" state). */
export function seasonPot(policy: LeagueSeasonPrizePolicy): { potRaw: bigint; decimals: number } | null {
  if (!policy.testPotEnabled) return null;
  return { potRaw: BigInt(LEAGUE_SEASON_TEST_POT.potRaw), decimals: LEAGUE_SEASON_TEST_POT.decimals };
}

/** Raw SKR for one place, exactly as the reviewed allocation computes it. */
export function seasonPlaceAmountRaw(place: number, potRaw: bigint): bigint {
  if (!Number.isSafeInteger(place) || place < 1 || place > SKR.maxPlaces) {
    throw new RangeError(`season place out of range: ${place}`);
  }
  if (place < SKR.band2.firstPlace) {
    return potRaw * BigInt(SKR.band1PlaceBps[place - 1]!) / BigInt(SKR.basisPoints);
  }
  const band = place <= SKR.band2.lastPlace ? SKR.band2 : SKR.band3;
  return potRaw * BigInt(band.bps)
    / (BigInt(SKR.basisPoints) * BigInt(band.lastPlace - band.firstPlace + 1));
}

/** The payout table, places 1..maxPlaces, contiguous; amounts null without a pot. */
export function seasonPayoutTable(potRaw: bigint | null): LeagueSeasonView['prize']['places'] {
  const amount = (place: number) => potRaw === null ? null : seasonPlaceAmountRaw(place, potRaw).toString();
  return [
    ...SKR.band1PlaceBps.map((bps, index) => ({
      band: 1 as const, fromPlace: index + 1, toPlace: index + 1, shareBps: bps, amountRawEach: amount(index + 1),
    })),
    { band: 2 as const, fromPlace: SKR.band2.firstPlace, toPlace: SKR.band2.lastPlace, shareBps: SKR.band2.bps,
      amountRawEach: amount(SKR.band2.firstPlace) },
    { band: 3 as const, fromPlace: SKR.band3.firstPlace, toPlace: SKR.band3.lastPlace, shareBps: SKR.band3.bps,
      amountRawEach: amount(SKR.band3.firstPlace) },
  ];
}

export interface SeasonCandidate extends RankedBase {
  name: string | null;
  ratedAttacks: number;
  weeklyScore: number;
}

export interface SeasonPlace extends SeasonCandidate { place: number }

/** Pure: the places if the week closed now. */
export function rankSeason(candidates: readonly SeasonCandidate[]): SeasonPlace[] {
  const attacks = new Map(candidates.map((row) => [row.baseId, row.ratedAttacks]));
  const walletPick = rewardedBaseIds([...candidates], attacks);
  return candidates
    .filter((row) => walletPick.has(row.baseId) && row.weeklyScore >= SKR.minWeeklyScore)
    .sort((a, b) => b.weeklyScore - a.weeklyScore || b.trophies - a.trophies
      || (a.baseId < b.baseId ? -1 : a.baseId > b.baseId ? 1 : 0))
    .slice(0, SKR.maxPlaces)
    .map((row, index) => ({ ...row, place: index + 1 }));
}

/** Pure: why the selected kingdom is or is not placed. */
export function seasonYouReason(
  you: SeasonCandidate, places: readonly SeasonPlace[], walletBases: readonly SeasonCandidate[],
): LeagueSeasonYouReason {
  if (places.some((row) => row.baseId === you.baseId)) return 'placed';
  if (you.trophies <= 0) return 'needs_trophies';
  if (you.ratedAttacks < LEAGUES.rewardMinAttackerRaids) return 'needs_rated_attacks';
  const pick = rewardedBaseIds([...walletBases], new Map(walletBases.map((row) => [row.baseId, row.ratedAttacks])));
  if (!pick.has(you.baseId)) return 'another_kingdom';
  if (you.weeklyScore < SKR.minWeeklyScore) return 'needs_weekly_score';
  return 'beyond_places';
}

/** This week's trophy change per kingdom from resolved deed-PvP raids. The
 * defenderWallet filter matches the deed PvP definition and the partial
 * resolved-raid index. A defender clamped at zero trophies is recorded with
 * the full negative delta, so the projection can only under-count them. */
async function weeklyTrophyChange(db: DbOrTx, startsAt: Date, closesAt: Date): Promise<Map<string, number>> {
  const window = and(
    eq(raids.status, 'resolved'), isNotNull(raids.defenderWallet),
    isNotNull(raids.attackerBaseId), isNotNull(raids.defenderBaseId),
    gte(raids.resolvedAt, startsAt), lt(raids.resolvedAt, closesAt),
  );
  const attackerSide = await db.select({
    baseId: raids.attackerBaseId,
    delta: sql<number>`coalesce(sum((${raids.result}->>'attackerTrophyDelta')::int), 0)::int`,
  }).from(raids).where(window).groupBy(raids.attackerBaseId);
  const defenderSide = await db.select({
    baseId: raids.defenderBaseId,
    delta: sql<number>`coalesce(sum((${raids.result}->>'defenderTrophyDelta')::int), 0)::int`,
  }).from(raids).where(window).groupBy(raids.defenderBaseId);
  const change = new Map<string, number>();
  for (const row of [...attackerSide, ...defenderSide]) {
    if (row.baseId) change.set(row.baseId, (change.get(row.baseId) ?? 0) + Number(row.delta));
  }
  return change;
}

function dateKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export async function getLeagueSeasonView(
  db: Db,
  wallet: string,
  requestedBaseId: string | undefined,
  policy: LeagueSeasonPrizePolicy,
  now = new Date(),
): Promise<LeagueSeasonView> {
  const window = leagueWindow(now);
  const baseId = await resolveLeagueBaseId(db, wallet, requestedBaseId);
  const landed = await db.select({
    baseId: bases.id,
    ownerWallet: bases.ownerWallet,
    name: players.name,
    trophies: baseProfiles.trophies,
    keepLevel: bases.keepLevel,
  }).from(bases)
    .innerJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
    .innerJoin(players, eq(players.wallet, bases.ownerWallet))
    .where(and(eq(bases.status, 'active'), isNotNull(bases.landPaidAt), isNotNull(bases.deedAssetId)));
  const attacks = await ratedAttacksByBase(db, landed.map((row) => row.baseId), window.startsAt, window.closesAt);
  const change = await weeklyTrophyChange(db, window.startsAt, window.closesAt);
  const candidates: SeasonCandidate[] = landed.map((row) => ({
    baseId: row.baseId, ownerWallet: row.ownerWallet, name: row.name || null,
    trophies: row.trophies, keepLevel: row.keepLevel,
    ratedAttacks: attacks.get(row.baseId) ?? 0, weeklyScore: change.get(row.baseId) ?? 0,
  }));
  const places = rankSeason(candidates);
  const pot = seasonPot(policy);
  const amountAt = (place: number | null) => pot === null || place === null
    ? null : seasonPlaceAmountRaw(place, pot.potRaw).toString();

  const selected = baseId ? candidates.find((row) => row.baseId === baseId) ?? null : null;
  let you: LeagueSeasonView['standings']['you'] = null;
  if (selected) {
    const place = places.find((row) => row.baseId === selected.baseId)?.place ?? null;
    you = {
      baseId: selected.baseId, place, weeklyScore: selected.weeklyScore, ratedAttacks: selected.ratedAttacks,
      trophies: selected.trophies, tier: leagueForTrophies(selected.trophies), amountRaw: amountAt(place),
      reason: seasonYouReason(selected, places, candidates.filter((row) => row.ownerWallet === selected.ownerWallet)),
    };
  }
  const keepLevel = selected?.keepLevel ?? null;
  return {
    serverTime: now.toISOString(),
    refreshAfterSec: LEAGUE_SEASON_VIEW.refreshAfterSec,
    season: {
      week: dateKey(window.startsAt),
      startsAt: window.startsAt.toISOString(),
      closesAt: window.closesAt.toISOString(),
      settlesAt: window.settlesAt.toISOString(),
    },
    tierRewards: {
      keepLevel,
      tiers: LEAGUE_TIERS.map((tier, index) => ({
        tier,
        fromTrophies: LEAGUES.thresholds[index]!,
        cacheShards: keepLevel === null ? null : leagueWeeklyRewards(tier, keepLevel).cacheShards.toString(),
        items: LEAGUES.weeklyItemsByTier[tier].map((item) => ({ ...item })),
      })),
    },
    prize: {
      currency: 'SKR',
      status: pot === null ? 'unset' : 'devnet_test',
      potRaw: pot === null ? null : pot.potRaw.toString(),
      decimals: pot === null ? null : pot.decimals,
      ranking: SKR.ranking,
      minWeeklyScore: SKR.minWeeklyScore,
      minRatedAttacks: LEAGUES.rewardMinAttackerRaids,
      maxPlaces: SKR.maxPlaces,
      places: seasonPayoutTable(pot === null ? null : pot.potRaw),
    },
    standings: {
      basis: 'projection_resolved_raids',
      eligibleCount: places.length,
      leaders: places.slice(0, SKR.band1PlaceBps.length).map((row) => ({
        place: row.place, baseId: row.baseId, name: row.name, weeklyScore: row.weeklyScore,
        trophies: row.trophies, tier: leagueForTrophies(row.trophies), amountRaw: amountAt(row.place),
        you: row.baseId === baseId,
      })),
      you,
    },
  };
}
