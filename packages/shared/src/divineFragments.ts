/** D153.192 bounded arithmetic only. These values prove neither occupation,
 * historical Seeker authority, source admission, delivery nor crafting rights. */
import { PHASE_E_DIVINE_FRAGMENTS as P, PHASE_E_POLICY } from './constants';
import { RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';
import { splitResourceEarnings } from './phaseEResourceTax';

const denominator = BigInt(P.basisPoints);
const individualGross = P.weeklyGross * P.individualBps / denominator;
const clanGross = P.weeklyGross * P.clanBps / denominator;
const salvageGross = P.weeklyGross * P.salvageBps / denominator;
const grossPerSite = individualGross / BigInt(P.individualSites);

export const DIVINE_FRAGMENT_POLICY = Object.freeze({
  version: P.version, resourceId: P.resourceId, weeklyGross: String(P.weeklyGross),
  periodDays: P.periodDays, individualGross: String(individualGross),
  clanGross: String(clanGross), salvageGross: String(salvageGross),
  individualSites: P.individualSites, grossPerSite: String(grossPerSite),
  basisPoints: P.basisPoints, playerBps: P.playerBps, seekerBps: P.seekerBps,
  developerBps: P.developerBps,
});

/** UTC epoch alignment, deliberately independent of Saturday trial entry. */
export function divineFragmentWeekAt(earnedAt: string): string {
  const ms = Date.parse(earnedAt);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(earnedAt)
    || !Number.isFinite(ms) || new Date(ms).toISOString() !== earnedAt)
    throw new RangeError('Expected a canonical UTC earning timestamp');
  const periodMs = P.periodDays * 24 * 60 * 60 * 1_000;
  return new Date(Math.floor(ms / periodMs) * periodMs).toISOString();
}

/** Vacancies and other-source allowances never become additional site awards. */
export function divineFragmentIndividualBudget(occupiedSites: number) {
  if (!Number.isInteger(occupiedSites) || occupiedSites < 0 || occupiedSites > P.individualSites)
    throw new RangeError('Occupied sites exceed the original individual allocation');
  const issuedGross = BigInt(occupiedSites) * grossPerSite;
  return Object.freeze({ weeklyGross: P.weeklyGross, individualGross, issuedGross,
    unissuedIndividual: individualGross - issuedGross,
    unissuedOther: P.weeklyGross - individualGross, unissuedTotal: P.weeklyGross - issuedGross });
}

/** Caller must retain original wallet/resource carry across every base and term. */
export function splitDivineFragmentAward(carryBefore: bigint) {
  return Object.freeze(splitResourceEarnings(grossPerSite, carryBefore));
}

/** Permanent spot rights, including King's spot without a multiplier. A proven
 * zero-winner term is held, and cannot be passed to this claim calculation. */
export function divineFragmentSeekerShare(poolTotal: bigint, winnerCount: number, previousTotal: bigint) {
  if (typeof poolTotal !== 'bigint' || typeof previousTotal !== 'bigint') throw new TypeError('Expected bigint quantities');
  if (poolTotal < 0n || poolTotal > RAW_RESOURCE_STORAGE_MAX || previousTotal < 0n || previousTotal > RAW_RESOURCE_STORAGE_MAX
    || !Number.isInteger(winnerCount) || winnerCount < 1 || winnerCount > PHASE_E_POLICY.seekerIsland.totalSpots)
    throw new RangeError('Invalid original fragment pool or winning spots');
  const cumulativeTotal = poolTotal / BigInt(winnerCount);
  if (previousTotal > cumulativeTotal) throw new RangeError('Previously claimed share exceeds original pool');
  return Object.freeze({ cumulativeTotal, quantity: cumulativeTotal - previousTotal, dust: poolTotal % BigInt(winnerCount) });
}

/** D193: each original clan site has its fixed allowance. Vacancies and roster
 * division dust stay unissued; no leader, treasury or later owner receives them. */
export const DIVINE_FRAGMENT_CLAN_SITE_GROSS = clanGross / BigInt(P.clanSites);
export function divineFragmentClanSite(rosterSize: number) {
  if (!Number.isInteger(rosterSize) || rosterSize < 1 || rosterSize > P.clanRosterCap)
    throw new RangeError('Invalid original clan roster size');
  const gross = DIVINE_FRAGMENT_CLAN_SITE_GROSS / BigInt(rosterSize);
  return Object.freeze({ siteGross: DIVINE_FRAGMENT_CLAN_SITE_GROSS, gross,
    issuedGross: gross * BigInt(rosterSize), unissuedDust: DIVINE_FRAGMENT_CLAN_SITE_GROSS % BigInt(rosterSize) });
}
export function splitDivineClanFragmentAward(rosterSize: number, carryBefore: bigint) {
  return Object.freeze(splitResourceEarnings(divineFragmentClanSite(rosterSize).gross, carryBefore));
}
