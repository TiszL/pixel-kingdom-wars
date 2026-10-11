/** Tiny first-paint-safe tier resolver shared by the HUD chip and lazy screen. */
import { LEAGUES, type League } from '@shardkeep/shared';

export const LEAGUE_TIERS: readonly League[] = ['bronze', 'silver', 'gold', 'sol'];

export const TIER_LABEL: Readonly<Record<League, string>> = {
  bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD', sol: 'SOL',
};

export const TIER_COLOR: Readonly<Record<League, string>> = {
  bronze: '#C08551', silver: '#DDE4E9', gold: '#F4D77B', sol: '#14F195',
};

const CREST: Readonly<Record<League, string>> = {
  bronze: new URL('../../../../../art/source/leagues/league_bronze.png', import.meta.url).href,
  silver: new URL('../../../../../art/source/leagues/league_silver.png', import.meta.url).href,
  gold: new URL('../../../../../art/source/leagues/league_gold.png', import.meta.url).href,
  sol: new URL('../../../../../art/source/leagues/league_sol.png', import.meta.url).href,
};

export function leagueCrestUrl(tier: League): string {
  return CREST[tier];
}

export function tierForTrophies(trophies: number): League {
  let tier: League = 'bronze';
  for (const [index, threshold] of LEAGUES.thresholds.entries()) {
    if (trophies >= threshold) tier = LEAGUE_TIERS[index] ?? tier;
  }
  return tier;
}

export function tierIndex(tier: League): number {
  return LEAGUE_TIERS.indexOf(tier);
}

export function tierFloor(tier: League): number {
  return LEAGUES.thresholds[tierIndex(tier)] ?? 0;
}

export function nextThreshold(trophies: number): number | null {
  return LEAGUES.thresholds[tierIndex(tierForTrophies(trophies)) + 1] ?? null;
}

export function tierProgressPct(trophies: number): number {
  const tier = tierForTrophies(trophies);
  const low = tierFloor(tier);
  const high = nextThreshold(trophies);
  if (high === null || high <= low) return 100;
  return Math.max(0, Math.min(100, Math.round(((trophies - low) / (high - low)) * 100)));
}

export function leagueRailLabel(trophies: number): string {
  const high = nextThreshold(trophies);
  if (high === null) return 'TOP TIER';
  const next = LEAGUE_TIERS[tierIndex(tierForTrophies(trophies)) + 1]!;
  return `${high - trophies} TO ${TIER_LABEL[next]}`;
}
