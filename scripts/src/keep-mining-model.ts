/**
 * KEEP mining model — Phase E, E1 numerical lane (2026-09-20).
 *
 * ⚠ PROPOSED_PARAMS BELOW ARE NOT CONSTANTS. They are the E1 proposal under
 * owner review (docs/phase-e/E1-NUMERICAL-SPEC.md §12 register). On owner
 * acceptance the block moves to packages/shared/src/constants.ts as
 * `KEEP_MINING` / `FORGE_INGOT` (with source comments) and this model imports
 * it, exactly as forge-model.ts imports FORGE. Until then nothing here is live;
 * the only LIVE numbers used are imported from @shardkeep/shared
 * (ECONOMY.shardsPerKeep, TOKEN.allocation.playPool, FORGE.contributionCapByLevel,
 * FORGE_DROPS.independentDropBps, LOOT.balanceLootableBps) so the guards below
 * are asserted against the real rate the server ships today.
 *
 * Design (approved plan §6 amended by §6.1):
 *  - S_d = Σ weight_i × component_i, each component a COUNT-based capped 0..1
 *    score; gameplay normaliser 4; only server-chosen (auto-match) PvP raids
 *    score; useful-on-chain counts only irreversible value destruction (no
 *    KEEP-market credit).
 *  - k = 0.5 + 0.5·min(1, A14/10): four misses in fourteen days cost nothing.
 *  - Cap = floor(C_max(tier) × S × k) per WALLET (one nominated base owned at
 *    open AND settlement). Free base T0 = 2 units (PROPOSED band 2–3), SGT-linked
 *    free base T1, deed bases T1..T4 = 12/16/20/24 by Gold Forge level band.
 *  - Commit anytime ≤ C_max; units = min(Cap_final, committed); excess returned;
 *    committed ingots protected, final, consumed at settlement; abort releases
 *    every reservation exactly once and pays nothing.
 *  - B_d = min(ceiling, floor(vault_unencumbered/14)); F_d = max(F_min,
 *    round(0.75 × 7-day mean U)); award = floor(B × units / max(U, F)).
 *    Σ awards + remainder + unallocated = B always. Sub-parity: F_min × R > ceiling
 *    with R measured against the LIVE ECONOMY.shardsPerKeep.
 *  - Drops: deed positions only, units ≥ tier minimum; never for T0.
 *
 * Pure integer math (bigint for KEEP base units); no wall-clock; no Math.random.
 * `mulberry32` (seeded, deterministic) is exported for simulateKeepMining and the
 * CLI only — none of the settlement/score functions consume randomness.
 */
import { ECONOMY, FORGE, FORGE_DROPS, LOOT, TOKEN } from '@shardkeep/shared';

export const BPS = 10_000;
export const KEEP_BASE_UNITS = 1_000_000_000n; // 10^9 base units per KEEP (plan §5.1 units)

export type TierIndex = 0 | 1 | 2 | 3 | 4;

export interface KeepMiningParams {
  ceilingKeepPerDay: number;
  vaultRunwayDivisorDays: number;
  prefundDays: number;
  floorMinUnits: number;
  floorMeanBps: number;
  floorWindowDays: number;
  weightsBps: { resources: number; gameplay: number; chain: number; deed: number; keep: number };
  normalisers: { resources: number; gameplay: number; chain: number; deed: number; keepLevels: number };
  pointCaps: { ownRefine: number; expeditionReturns: number; scoredPvpRaids: number; pveStars: number; chain: number };
  participationThresholdBps: number;
  consistencyWindowDays: number;
  consistencyThresholdDays: number;
  consistencyMinBps: number;
  capacityByTier: readonly [number, number, number, number, number];
  dropMinUnitsByTier: readonly [number, number, number, number, number];
  shardsPerIngot: number;
  batchBase: number;
  batchMax: number;
  refineSecPerIngotL1: number;
  refineSpeedupBpsPerLevel: number;
  refineCapMultiplier: number;
  holdingCapMultiplier: number;
  expPerMiningDay: number;
  renownPerParticipationDay: number;
  levelsPerTier: number;
}

export const PROPOSED_PARAMS: KeepMiningParams = {
  /** LOCKED ceiling (owner: 98,000 KEEP/day is a funded ceiling, not a promise). */
  ceilingKeepPerDay: 98_000,
  /** PROPOSED runway guard: B_d = min(ceiling, floor(vault_unencumbered / this)). */
  vaultRunwayDivisorDays: 14,
  /** PROPOSED vault pre-funding depth (days of ceiling) and weekly top-up target. */
  prefundDays: 28,
  /** PROPOSED announced floor: F_d = max(floorMinUnits, round(floorMeanBps × mean U over floorWindowDays)). */
  floorMinUnits: 2_000,
  floorMeanBps: 7_500,
  floorWindowDays: 7,
  /** PROPOSED component weights (owner simulation candidate 40/25/20/10/5). */
  weightsBps: { resources: 4_000, gameplay: 2_500, chain: 2_000, deed: 1_000, keep: 500 },
  /** PROPOSED normalisers (points needed for a full component): resources 6 of 7
   * available; gameplay 4 (amended from 8 so one action is one visible step at
   * T1); chain 2; deed 1; keep (L−1)/9. */
  normalisers: { resources: 6, gameplay: 4, chain: 2, deed: 1, keepLevels: 9 },
  /** PROPOSED per-day point caps per source (count-based, amount-blind). */
  pointCaps: { ownRefine: 3, expeditionReturns: 2, scoredPvpRaids: 3, pveStars: 2, chain: 2 },
  /** PROPOSED participation day threshold S_d ≥ 0.15. */
  participationThresholdBps: 1_500,
  /** PROPOSED consistency: 14-day window, 10-day saturation, k_min 0.5. */
  consistencyWindowDays: 14,
  consistencyThresholdDays: 10,
  consistencyMinBps: 5_000,
  /** PROPOSED capacity per tier (ingots/day per wallet). Index 0 = free base
   * without SGT link (amended §6.1: cost-bearing capacity; band 2–3, default 2);
   * 1..4 = Gold Forge level bands L1–5 / 6–10 / 11–15 / 16–20. */
  capacityByTier: [2, 12, 16, 20, 24],
  /** PROPOSED tier minimum units for a drop roll (index by tier); T0 never rolls. */
  dropMinUnitsByTier: [Number.POSITIVE_INFINITY, 4, 6, 8, 10],
  /** PROPOSED Forge Ingot recipe: R SHARDS per ingot; batch 10+Workshop level (≤30);
   * 360 s per ingot at Workshop L1, −2%/level; refine cap 3×C_max/day; holding cap
   * 7×C_max counting held + listed + reserved + in-progress jobs. */
  shardsPerIngot: 100,
  batchBase: 10,
  batchMax: 30,
  refineSecPerIngotL1: 360,
  refineSpeedupBpsPerLevel: 200,
  refineCapMultiplier: 3,
  holdingCapMultiplier: 7,
  /** PROPOSED progression: +50 EXP once per finalized day with units ≥ 1; +1 Renown
   * per participation day; 0 EXP for ingot refining. */
  expPerMiningDay: 50,
  renownPerParticipationDay: 1,
  /** PROPOSED legacy mapping: Gold Forge level → tier = ceil(level / 5). */
  levelsPerTier: 5,
};

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export interface DaySignals {
  /** Resources (7 available, 6 needed). */
  mineCollected: boolean;
  harvesterCollected: boolean;
  /** Own SHARDS→ingot batch (or E2 craft) completions; purchased ingots never count. */
  ownRefineCompletions: number;
  expeditionReturns: number;
  /** Gameplay (10 available, normaliser 4). Only server-chosen auto-match PvP
   * raids are listed here (named-target/revenge/free-pool raids are excluded
   * upstream); the first `scoredPvpRaids` count, 1 for a meaningful attack
   * (win or ≥25% destruction) +1 for a win; retreats do not burn a slot. */
  autoMatchPvp: ReadonlyArray<{ meaningful: boolean; won: boolean }>;
  pveStarBattles: number;
  buildStarted: boolean;
  trainingQueued: boolean;
  /** Useful on-chain (≤2): irreversible value destruction only. */
  vehicleBurnsNonPurchased: number;
  solSettlementsAboveFloorWithRoyalty: number;
  /** KEEP-market settlements are recorded for audit but NEVER score (amended §6.1). */
  keepMarketSettlements?: number;
  /** Deed: one nominated active paid deed owned at day open AND at settlement. */
  nominatedDeedValid: boolean;
  keepLevel: number;
}

export interface ScoreBreakdown {
  scoreBps: number;
  components: { resources: number; gameplay: number; chain: number; deed: number; keep: number };
  points: { resources: number; gameplay: number; chain: number; deed: number };
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const capped = (points: number, normaliser: number): number => clamp(Math.floor((points * BPS) / normaliser), 0, BPS);

/** S_d in basis points from count-based signals. Amounts never enter. */
export function dailyScore(sig: DaySignals, p: KeepMiningParams = PROPOSED_PARAMS): ScoreBreakdown {
  const resPts = (sig.mineCollected ? 1 : 0) + (sig.harvesterCollected ? 1 : 0)
    + clamp(sig.ownRefineCompletions, 0, p.pointCaps.ownRefine)
    + clamp(sig.expeditionReturns, 0, p.pointCaps.expeditionReturns);
  let pvp = 0;
  for (const r of sig.autoMatchPvp.slice(0, p.pointCaps.scoredPvpRaids)) {
    if (r.meaningful || r.won) pvp += 1;
    if (r.won) pvp += 1;
  }
  const gamePts = pvp + clamp(sig.pveStarBattles, 0, p.pointCaps.pveStars)
    + (sig.buildStarted ? 1 : 0) + (sig.trainingQueued ? 1 : 0);
  const chainPts = clamp(sig.vehicleBurnsNonPurchased + sig.solSettlementsAboveFloorWithRoyalty, 0, p.pointCaps.chain);
  const deedPts = sig.nominatedDeedValid ? 1 : 0;
  const components = {
    resources: capped(resPts, p.normalisers.resources),
    gameplay: capped(gamePts, p.normalisers.gameplay),
    chain: capped(chainPts, p.normalisers.chain),
    deed: capped(deedPts, p.normalisers.deed),
    keep: capped(clamp(sig.keepLevel, 1, 20) - 1, p.normalisers.keepLevels),
  };
  const w = p.weightsBps;
  const scoreBps = Math.floor((w.resources * components.resources + w.gameplay * components.gameplay
    + w.chain * components.chain + w.deed * components.deed + w.keep * components.keep) / BPS);
  return { scoreBps, components, points: { resources: resPts, gameplay: gamePts, chain: chainPts, deed: deedPts } };
}

export const isParticipationDay = (scoreBps: number, p: KeepMiningParams = PROPOSED_PARAMS): boolean =>
  scoreBps >= p.participationThresholdBps;

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

/** k in bps from participation days in the rolling window (today included). */
export function consistencyFactor(participationDaysInWindow: number, p: KeepMiningParams = PROPOSED_PARAMS): number {
  const a = clamp(participationDaysInWindow, 0, p.consistencyWindowDays);
  const sat = Math.min(a, p.consistencyThresholdDays);
  return p.consistencyMinBps + Math.floor(((BPS - p.consistencyMinBps) * sat) / p.consistencyThresholdDays);
}

// ---------------------------------------------------------------------------
// Tier and capacity
// ---------------------------------------------------------------------------

export interface NominatedBase {
  goldForgeLevel: number; // 0 = none / under construction
  hasDeed: boolean;
  sgtLinked: boolean;
  /** Owned at day open and still at settlement, no transfer during the day. */
  ownedAtOpenAndSettlement: boolean;
}

/** null = no capacity (no Gold Forge, or nomination invalidated by a transfer). */
export function tierOf(b: NominatedBase, p: KeepMiningParams = PROPOSED_PARAMS): TierIndex | null {
  if (b.goldForgeLevel <= 0) return null;
  if (!b.ownedAtOpenAndSettlement) return null;
  if (b.hasDeed) return clamp(Math.ceil(b.goldForgeLevel / p.levelsPerTier), 1, 4) as TierIndex;
  return b.sgtLinked ? 1 : 0;
}

export const cMax = (tier: TierIndex | null, p: KeepMiningParams = PROPOSED_PARAMS): number =>
  tier === null ? 0 : (p.capacityByTier[tier] ?? 0);

export interface Capacity { units: number; milliUnits: number; cMax: number; toNextMilli: number }

/** Cap = floor(C_max × S × k). milliUnits carries the fixed-point value for the
 * progress bar ("2 ingots · 0.8 to next"). */
export function capacityUnits(tier: TierIndex | null, scoreBps: number, kBps: number, p: KeepMiningParams = PROPOSED_PARAMS): Capacity {
  const c = cMax(tier, p);
  const milliUnits = Math.floor((c * 1000 * clamp(scoreBps, 0, BPS) * clamp(kBps, 0, BPS)) / (BPS * BPS));
  const units = Math.floor(milliUnits / 1000);
  return { units, milliUnits, cMax: c, toNextMilli: units >= c ? 0 : 1000 - (milliUnits % 1000) };
}

// ---------------------------------------------------------------------------
// Budget, floor, settlement
// ---------------------------------------------------------------------------

export const keepToBase = (keep: number | bigint): bigint => BigInt(keep) * KEEP_BASE_UNITS;

/** B_d (whole KEEP) fixed at day open. */
export function budgetForDay(vaultUnencumberedKeep: bigint, p: KeepMiningParams = PROPOSED_PARAMS): number {
  const guard = vaultUnencumberedKeep / BigInt(p.vaultRunwayDivisorDays);
  const ceiling = BigInt(p.ceilingKeepPerDay);
  return Number(guard < ceiling ? (guard < 0n ? 0n : guard) : ceiling);
}

/** F_d from the last `floorWindowDays` settled U values (oldest first; fewer is fine). */
export function floorForDay(settledUnitsHistory: ReadonlyArray<number>, p: KeepMiningParams = PROPOSED_PARAMS): number {
  const window = settledUnitsHistory.slice(-p.floorWindowDays);
  if (window.length === 0) return p.floorMinUnits;
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  return Math.max(p.floorMinUnits, Math.round((mean * p.floorMeanBps) / BPS));
}

export interface SettlementEntry { id: string; capacityUnits: number; committedIngots: number }
export interface SettledEntry extends SettlementEntry { units: number; awardBase: bigint; consumedIngots: number; returnedIngots: number }
export interface SettlementInput { budgetKeep: number; floorUnits: number; entries: ReadonlyArray<SettlementEntry>; aborted?: boolean }
export interface Settlement {
  entries: SettledEntry[];
  totalUnits: number;
  denominator: number;
  budgetBase: bigint;
  distributableBase: bigint;
  awardedBase: bigint;
  remainderBase: bigint;
  unallocatedBase: bigint;
  aborted: boolean;
}

/** award_i = floor(B × units_i / max(U, F)); units_i = min(Cap_i, committed_i).
 * distributable = floor(B × min(U,F) / F) is what the floor lets out;
 * unallocated = B − distributable; remainder = distributable − Σ awards (dust).
 * An aborted epoch returns every committed ingot and pays nothing. */
export function settleMiningDay(input: SettlementInput, p: KeepMiningParams = PROPOSED_PARAMS): Settlement {
  const budgetBase = keepToBase(input.budgetKeep);
  const floorUnits = Math.max(1, input.floorUnits);
  if (input.aborted) {
    return {
      entries: input.entries.map((e) => ({ ...e, units: 0, awardBase: 0n, consumedIngots: 0, returnedIngots: e.committedIngots })),
      totalUnits: 0, denominator: floorUnits, budgetBase, distributableBase: 0n, awardedBase: 0n,
      remainderBase: 0n, unallocatedBase: budgetBase, aborted: true,
    };
  }
  const units = input.entries.map((e) => Math.max(0, Math.min(e.capacityUnits, e.committedIngots)));
  const totalUnits = units.reduce((a, b) => a + b, 0);
  const denominator = Math.max(totalUnits, floorUnits);
  const denom = BigInt(denominator);
  let awardedBase = 0n;
  const entries: SettledEntry[] = input.entries.map((e, i) => {
    const u = units[i]!;
    const awardBase = (budgetBase * BigInt(u)) / denom;
    awardedBase += awardBase;
    return { ...e, units: u, awardBase, consumedIngots: u, returnedIngots: e.committedIngots - u };
  });
  const distributableBase = (budgetBase * BigInt(Math.min(totalUnits, floorUnits))) / BigInt(floorUnits);
  void p;
  return {
    entries, totalUnits, denominator, budgetBase, distributableBase, awardedBase,
    remainderBase: distributableBase - awardedBase, unallocatedBase: budgetBase - distributableBase, aborted: false,
  };
}

/** Sub-parity guard against the LIVE conversion rate: F_min × R must exceed the
 * ceiling in SHARDS-equivalent so the KEEP→SHARDS→ingot→pour loop can never
 * return ≥ 1 KEEP per KEEP converted. With shardsPerKeep = s, one KEEP buys s
 * SHARDS = s/R ingots; the best rate is ceiling/F_min KEEP per unit, so the loop
 * returns (s/R) × ceiling/F_min per KEEP — < 1 iff F_min × R > ceiling × s. */
export function subParityHolds(p: KeepMiningParams = PROPOSED_PARAMS, shardsPerKeep: number = ECONOMY.shardsPerKeep): boolean {
  return p.floorMinUnits * p.shardsPerIngot > p.ceilingKeepPerDay * shardsPerKeep;
}

/** Max KEEP returned per SHARD sunk at the announced floor. */
export const maxKeepPerShard = (p: KeepMiningParams = PROPOSED_PARAMS): number =>
  p.ceilingKeepPerDay / (p.floorMinUnits * p.shardsPerIngot);

/** Runway in years if the whole play pool paid the ceiling every day. */
export const runwayYearsAtCeiling = (poolKeep: number = TOKEN.allocation.playPool, p: KeepMiningParams = PROPOSED_PARAMS): number =>
  poolKeep / (p.ceilingKeepPerDay * 365);

// ---------------------------------------------------------------------------
// Vault (encumbrance) — late claims never move B_d
// ---------------------------------------------------------------------------

export interface Vault { balanceBase: bigint; encumberedBase: bigint }
export const unencumberedKeep = (v: Vault): bigint => (v.balanceBase - v.encumberedBase) / KEEP_BASE_UNITS;
export function recordAwards(v: Vault, awardedBase: bigint): void { v.encumberedBase += awardedBase; }
/** A claim pays already-encumbered balance: unencumbered (and so B_d) is unchanged. */
export function claimFromVault(v: Vault, amountBase: bigint): void {
  if (amountBase > v.encumberedBase) throw new Error('claim exceeds encumbered');
  v.balanceBase -= amountBase; v.encumberedBase -= amountBase;
}

// ---------------------------------------------------------------------------
// Forge Ingots — ledger, refine, commit, settle, abort
// ---------------------------------------------------------------------------

export interface IngotAccount {
  refined: number; purchased: number;
  held: number; listed: number; reserved: number; inProgress: number;
  consumed: number; sold: number;
  refinedToday: number;
  settledDays: Set<string>; abortedDays: Set<string>;
}
export const newIngotAccount = (): IngotAccount => ({
  refined: 0, purchased: 0, held: 0, listed: 0, reserved: 0, inProgress: 0, consumed: 0, sold: 0,
  refinedToday: 0, settledDays: new Set(), abortedDays: new Set(),
});
/** Conservation: refined + purchased = held + listed + reserved + inProgress + consumed + sold. */
export const ingotBalanceOk = (a: IngotAccount): boolean =>
  a.refined + a.purchased === a.held + a.listed + a.reserved + a.inProgress + a.consumed + a.sold;

export interface RefineRequest { shardsAvailable: number; requestedIngots: number; tier: TierIndex | null; workshopLevel: number }
export interface RefineResult { ingots: number; shardsSunk: number; batches: number; seconds: number; refinedBy: 'request' | 'shards' | 'refine_cap' | 'holding_cap' }

/** Refine own SHARDS into ingots under the daily refine cap and the holding cap
 * (held + listed + reserved + in-progress). Deterministic, no failure roll.
 * Ingots land in `held` (the job duration is reported, not simulated). */
export function refineIngots(a: IngotAccount, r: RefineRequest, p: KeepMiningParams = PROPOSED_PARAMS): RefineResult {
  const c = cMax(r.tier, p);
  const byShards = Math.floor(r.shardsAvailable / p.shardsPerIngot);
  const refineRoom = Math.max(0, p.refineCapMultiplier * c - a.refinedToday);
  const holdingRoom = Math.max(0, p.holdingCapMultiplier * c - (a.held + a.listed + a.reserved + a.inProgress));
  const candidates: Array<[number, RefineResult['refinedBy']]> = [
    [Math.max(0, r.requestedIngots), 'request'], [byShards, 'shards'], [refineRoom, 'refine_cap'], [holdingRoom, 'holding_cap'],
  ];
  let ingots = Number.POSITIVE_INFINITY; let refinedBy: RefineResult['refinedBy'] = 'request';
  for (const [n, why] of candidates) if (n < ingots) { ingots = n; refinedBy = why; }
  const batch = Math.min(p.batchMax, p.batchBase + Math.max(0, r.workshopLevel));
  const secPerIngot = Math.floor((p.refineSecPerIngotL1 * (BPS - p.refineSpeedupBpsPerLevel * Math.max(0, r.workshopLevel - 1))) / BPS);
  a.refined += ingots; a.held += ingots; a.refinedToday += ingots;
  return { ingots, shardsSunk: ingots * p.shardsPerIngot, batches: Math.ceil(ingots / batch), seconds: ingots * secPerIngot, refinedBy };
}

/** Commit is increase-only and final: held → reserved. */
export function commitIngots(a: IngotAccount, n: number): number {
  const add = Math.max(0, Math.min(n, a.held));
  a.held -= add; a.reserved += add;
  return add;
}
export function listIngots(a: IngotAccount, n: number): void { const m = Math.min(n, a.held); a.held -= m; a.listed += m; }
export function transferIngots(from: IngotAccount, to: IngotAccount, n: number): void {
  const m = Math.min(n, from.listed + from.held);
  const fromListed = Math.min(m, from.listed); from.listed -= fromListed; from.held -= m - fromListed;
  from.sold += m; to.purchased += m; to.held += m;
}
/** Idempotent per day key: consumes `units`, returns the rest, exactly once. */
export function applySettlementToAccount(a: IngotAccount, dayKey: string, units: number): void {
  if (a.settledDays.has(dayKey) || a.abortedDays.has(dayKey)) return;
  const consumed = Math.min(units, a.reserved);
  a.consumed += consumed; a.held += a.reserved - consumed; a.reserved = 0; a.refinedToday = 0;
  a.settledDays.add(dayKey);
}
/** Idempotent per day key: releases every reservation exactly once, pays nothing. */
export function abortEpochOnAccount(a: IngotAccount, dayKey: string): number {
  if (a.settledDays.has(dayKey) || a.abortedDays.has(dayKey)) return 0;
  const released = a.reserved; a.held += released; a.reserved = 0; a.refinedToday = 0;
  a.abortedDays.add(dayKey);
  return released;
}

// ---------------------------------------------------------------------------
// Drops (deed-gated, tier minimum) and legacy loot delta
// ---------------------------------------------------------------------------

export const dropEligible = (tier: TierIndex | null, hasDeed: boolean, units: number, p: KeepMiningParams = PROPOSED_PARAMS): boolean =>
  tier !== null && hasDeed && units >= (p.dropMinUnitsByTier[tier] ?? Number.POSITIVE_INFINITY);

/** Σ live independent drop odds (bps) — expected drops per eligible position/day ≈ this / 10⁴. */
export const totalDropBps = (): number => Object.values(FORGE_DROPS.independentDropBps).reduce((a, b) => a + b, 0);

/** Legacy open-Forge raid exposure that disappears: lootable share of one day's
 * contribution cap at Gold Forge `level` (LOOT.balanceLootableBps of base_forge_escrow). */
export const legacyForgeLootExposure = (level: number): number =>
  Math.floor(((FORGE.contributionCapByLevel[clamp(level, 0, 20)] ?? 0) * LOOT.balanceLootableBps) / BPS);

/** Protected SHARDS shelter bound created by ingots: holding cap × R. */
export const protectedShardsBound = (tier: TierIndex | null, p: KeepMiningParams = PROPOSED_PARAMS): number =>
  p.holdingCapMultiplier * cMax(tier, p) * p.shardsPerIngot;

// ---------------------------------------------------------------------------
// Seeded PRNG (simulation only)
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Cohort simulation (per-controller accounting)
// ---------------------------------------------------------------------------

export type AdversaryKind = 'sybil_ring' | 'deed_rotation' | 'wash_trade' | 'drop_farm';

export interface CohortSpec {
  name: string;
  kind: 'honest' | 'adversary';
  /** Fraction of the population's wallets in this cohort. */
  share: number;
  /** Wallets one human controls (1 for honest cohorts). */
  walletsPerController: number;
  goldForgeLevel: number;
  hasDeed: boolean;
  sgtLinked: boolean;
  keepLevel: number;
  workshopLevel: number;
  /** Days per week the wallet is active (7 = daily). */
  activeDaysPerWeek: number;
  /** Mean S on active days (bps) and ± jitter. */
  scoreBps: number;
  scoreJitterBps: number;
  /** Newcomer ramp: score rises linearly from rampStartBps to scoreBps over rampDays. */
  rampDays?: number;
  rampStartBps?: number;
  /** SHARDS income per day available to the wallet; forgeFraction of it may be refined. */
  shardsIncomePerDay: number;
  forgeFraction: number;
  /** Whale: buys ingots from the market to fill any shortfall between held and capacity. */
  buysIngotsToFill: boolean;
  /** Claim lag in days after settlement (1 = next day; sponsored fee payer for zero-SOL wallets). */
  claimLagDays: number;
  adversary?: AdversaryKind;
  /** Legacy Gold Forge level for the loot-delta report (legacy L20 cohort). */
  legacyForgeLevel?: number;
}

export interface CohortMetrics {
  name: string; kind: 'honest' | 'adversary'; wallets: number; controllers: number;
  keepPerWalletPerDay: number; keepPerControllerPerDay: number;
  unitsPerWalletPerDay: number; unitsPerControllerPerDay: number;
  participationRate: number; meanCapacityUnits: number;
  ingotsRefined: number; ingotsPurchased: number; ingotsConsumed: number; ingotsReturned: number;
  shardsSunk: number; shardsIncome: number;
  protectedShardsPerControllerMax: number;
  medianFirstClaimDay: number | null;
  dropsPerDay: number;
  /** Adversary-specific: KEEP earned from the exploit path beyond honest play under the AMENDED rules (0). */
  exploitGainKeep: number;
  /** Counterfactual: what the same exploit would have paid if KEEP-market settlements still scored. */
  exploitGainIfMarketCreditKeep: number;
  legacyLootExposureRemovedPerDay: number;
}

export interface SimDay { day: number; budgetKeep: number; floorUnits: number; totalUnits: number; awardedKeep: number; unallocatedKeep: number; dropsIssued: number; deedPositions: number }

export interface SimResult {
  population: number; days: number; seed: number; shardsPerIngot: number;
  cohorts: CohortMetrics[];
  days_: SimDay[];
  utilisation: number;
  giniControllers: number;
  top10PctShareControllers: number;
  sinkRatio: number;
  totalAwardedKeep: number;
  runwayYearsAtSimulatedRate: number;
  runwayYearsAtCeiling: number;
  dropsPerDeedPositionPerDay: number;
}

export function gini(values: ReadonlyArray<number>): number {
  const v = [...values].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length; if (n === 0) return 0;
  const sum = v.reduce((a, b) => a + b, 0); if (sum <= 0) return 0;
  let cum = 0; let weighted = 0;
  for (let i = 0; i < n; i++) { cum += v[i]!; weighted += cum; }
  return (n + 1 - (2 * weighted) / sum) / n;
}

interface WalletState {
  cohort: number; controller: number; ringIndex: number;
  window: number[]; // last 14 participation flags
  acct: IngotAccount;
  awardsBase: bigint; units: number; participationDays: number; activeDays: number; capacitySum: number;
  firstAwardDay: number | null; firstClaimDay: number | null;
  pendingClaims: Array<{ day: number; base: bigint }>;
  shardsSunk: number; shardsIncome: number; returned: number; drops: number; protectedMax: number;
  exploitGainBase: bigint; exploitGainIfMarketCreditBase: bigint;
}

/** Deterministic cohort simulation. Populations are wallet counts; metrics are
 * reported per wallet AND per controller (units per human) so a ring cannot
 * lower Gini by splitting. */
export function simulateKeepMining(cohorts: ReadonlyArray<CohortSpec>, days: number, params: KeepMiningParams, seed: number, population: number, opts: { initialVaultKeep?: number; topUpEveryDays?: number } = {}): SimResult {
  const rng = mulberry32(seed);
  const p = params;
  const wallets: WalletState[] = [];
  const cohortWalletCounts: number[] = [];
  let controllerSeq = 0;
  cohorts.forEach((c, ci) => {
    const n = Math.max(c.walletsPerController, Math.round(c.share * population));
    const nWallets = n - (n % c.walletsPerController);
    cohortWalletCounts.push(nWallets);
    for (let i = 0; i < nWallets; i++) {
      if (i % c.walletsPerController === 0) controllerSeq++;
      wallets.push({
        cohort: ci, controller: controllerSeq, ringIndex: i % c.walletsPerController, window: [], acct: newIngotAccount(),
        awardsBase: 0n, units: 0, participationDays: 0, activeDays: 0, capacitySum: 0, firstAwardDay: null, firstClaimDay: null,
        pendingClaims: [], shardsSunk: 0, shardsIncome: 0, returned: 0, drops: 0, protectedMax: 0, exploitGainBase: 0n, exploitGainIfMarketCreditBase: 0n,
      });
    }
  });

  const vault: Vault = { balanceBase: keepToBase(opts.initialVaultKeep ?? p.ceilingKeepPerDay * p.prefundDays), encumberedBase: 0n };
  const topUpEvery = opts.topUpEveryDays ?? 7;
  const history: number[] = [];
  const simDays: SimDay[] = [];
  const dropP = totalDropBps() / BPS;
  let totalAwardedBase = 0n; let totalBudget = 0; let totalShardsSunk = 0; let totalShardsIncome = 0; let totalDrops = 0; let totalDeedPositions = 0;

  for (let day = 1; day <= days; day++) {
    // weekly multisig top-up back to prefund depth
    if (day % topUpEvery === 1) {
      const target = keepToBase(p.ceilingKeepPerDay * p.prefundDays) + vault.encumberedBase;
      if (vault.balanceBase < target) vault.balanceBase = target;
    }
    const budgetKeep = budgetForDay(unencumberedKeep(vault), p);
    const floorUnits = floorForDay(history, p);
    const entries: SettlementEntry[] = [];
    const entryWallet: WalletState[] = [];
    const entryTier: Array<TierIndex | null> = [];
    let deedPositions = 0;
    const washExtraUnits = new Map<number, number>();

    for (let wi = 0; wi < wallets.length; wi++) {
      const w = wallets[wi]!; const c = cohorts[w.cohort]!;
      // claims: sponsored or self-paid, lagged
      while (w.pendingClaims.length > 0 && w.pendingClaims[0]!.day + c.claimLagDays <= day) {
        const cl = w.pendingClaims.shift()!; claimFromVault(vault, cl.base);
        if (w.firstClaimDay === null && cl.base > 0n) w.firstClaimDay = day;
      }
      w.shardsIncome += c.shardsIncomePerDay; totalShardsIncome += c.shardsIncomePerDay;
      const active = c.activeDaysPerWeek >= 7 ? true : rng() < c.activeDaysPerWeek / 7;
      let scoreBps = 0;
      if (active) {
        w.activeDays++;
        let mean = c.scoreBps;
        if (c.rampDays && c.rampStartBps !== undefined && day <= c.rampDays) {
          mean = c.rampStartBps + Math.floor(((c.scoreBps - c.rampStartBps) * (day - 1)) / c.rampDays);
        }
        const jitter = Math.floor((rng() * 2 - 1) * c.scoreJitterBps);
        scoreBps = clamp(mean + jitter, 0, BPS);
      }
      const participates = active && isParticipationDay(scoreBps, p);
      w.window.push(participates ? 1 : 0); if (w.window.length > p.consistencyWindowDays) w.window.shift();
      if (participates) w.participationDays++;
      const a14 = w.window.reduce((x, y) => x + y, 0);
      const kBps = consistencyFactor(a14, p);

      // nomination / tier
      let base: NominatedBase = { goldForgeLevel: c.goldForgeLevel, hasDeed: c.hasDeed, sgtLinked: c.sgtLinked, ownedAtOpenAndSettlement: true };
      if (c.adversary === 'deed_rotation') {
        // one deed passed through the ring; the amended rule credits the base to
        // at most one wallet per day, and only if it owned it at open AND settlement.
        const holder = (day % c.walletsPerController);
        const intradayTransfer = rng() < 0.5; // the ring tries to hand it on mid-day half the time
        base = holder === w.ringIndex
          ? { goldForgeLevel: c.goldForgeLevel, hasDeed: true, sgtLinked: false, ownedAtOpenAndSettlement: !intradayTransfer }
          : { goldForgeLevel: 0, hasDeed: false, sgtLinked: false, ownedAtOpenAndSettlement: false };
      }
      const tier = tierOf(base, p);
      const cap = active ? capacityUnits(tier, scoreBps, kBps, p) : capacityUnits(tier, 0, kBps, p);
      w.capacitySum += cap.units;

      // refine own SHARDS toward a stock of C_max, then commit up to C_max (commit-anytime)
      const c_ = cMax(tier, p);
      if (active && c_ > 0) {
        const budgetShards = Math.floor(c.shardsIncomePerDay * c.forgeFraction);
        const want = Math.max(0, c_ - w.acct.held);
        const r = refineIngots(w.acct, { shardsAvailable: budgetShards, requestedIngots: want, tier, workshopLevel: c.workshopLevel }, p);
        w.shardsSunk += r.shardsSunk; totalShardsSunk += r.shardsSunk;
        if (c.buysIngotsToFill && w.acct.held < c_) {
          // market purchase from an external seller (modelled as an unbounded counterparty)
          const seller = newIngotAccount(); seller.refined = c_; seller.held = c_;
          transferIngots(seller, w.acct, c_ - w.acct.held);
        }
        const committed = commitIngots(w.acct, c_);
        if (committed > 0) { entries.push({ id: String(wi), capacityUnits: cap.units, committedIngots: committed }); entryWallet.push(w); entryTier.push(tier); if (tier !== null && base.hasDeed) deedPositions++; }
      }
      w.protectedMax = Math.max(w.protectedMax, (w.acct.held + w.acct.listed + w.acct.reserved + w.acct.inProgress) * p.shardsPerIngot);
      // drop_farm alts commit one ingot each hoping for a roll; dropEligible()
      // (deed-gated + tier minimum) decides at settlement — T0 never rolls.
      if (c.adversary === 'wash_trade' && active && c_ > 0) {
        // what the daily 10-KEEP ping-pong WOULD unlock if KEEP-market credit still scored
        const would = capacityUnits(tier, clamp(scoreBps + p.weightsBps.chain, 0, BPS), kBps, p).units - cap.units;
        washExtraUnits.set(wi, Math.max(0, would));
      }
    }

    const s = settleMiningDay({ budgetKeep, floorUnits, entries }, p);
    recordAwards(vault, s.awardedBase);
    const dayKey = `d${day}`;
    let dropsIssued = 0;
    s.entries.forEach((e, i) => {
      const w = entryWallet[i]!; const c = cohorts[w.cohort]!;
      applySettlementToAccount(w.acct, dayKey, e.units);
      w.awardsBase += e.awardBase; w.units += e.units; w.returned += e.returnedIngots;
      if (e.awardBase > 0n) { if (w.firstAwardDay === null) w.firstAwardDay = day; w.pendingClaims.push({ day, base: e.awardBase }); }
      if (dropEligible(entryTier[i]!, c.hasDeed, e.units, p) && rng() < dropP) { w.drops++; dropsIssued++; }
    });
    for (const [wi, extra] of washExtraUnits) {
      const w = wallets[wi]!;
      w.exploitGainIfMarketCreditBase += (s.budgetBase * BigInt(extra)) / BigInt(s.denominator);
    }
    for (const w of wallets) { w.acct.refinedToday = 0; w.acct.settledDays.clear(); w.acct.abortedDays.clear(); }
    history.push(s.totalUnits);
    totalAwardedBase += s.awardedBase; totalBudget += budgetKeep; totalDrops += dropsIssued; totalDeedPositions += deedPositions;
    simDays.push({ day, budgetKeep, floorUnits, totalUnits: s.totalUnits, awardedKeep: Number(s.awardedBase / KEEP_BASE_UNITS), unallocatedKeep: Number((s.unallocatedBase + s.remainderBase) / KEEP_BASE_UNITS), dropsIssued, deedPositions });
  }

  // per-controller aggregation
  const ctrlKeep = new Map<number, number>();
  for (const w of wallets) ctrlKeep.set(w.controller, (ctrlKeep.get(w.controller) ?? 0) + Number(w.awardsBase / KEEP_BASE_UNITS));
  const ctrlValues = [...ctrlKeep.values()].sort((a, b) => b - a);
  const ctrlTotal = ctrlValues.reduce((a, b) => a + b, 0);
  const top10 = ctrlValues.slice(0, Math.max(1, Math.ceil(ctrlValues.length * 0.1))).reduce((a, b) => a + b, 0);

  const cohortMetrics: CohortMetrics[] = cohorts.map((c, ci) => {
    const ws = wallets.filter((w) => w.cohort === ci);
    const n = ws.length; const controllers = Math.max(1, n / c.walletsPerController);
    const keep = ws.reduce((a, w) => a + Number(w.awardsBase / KEEP_BASE_UNITS), 0);
    const units = ws.reduce((a, w) => a + w.units, 0);
    const firstClaims = ws.map((w) => w.firstClaimDay).filter((d): d is number => d !== null).sort((a, b) => a - b);
    const ctrlProtected = new Map<number, number>();
    for (const w of ws) ctrlProtected.set(w.controller, (ctrlProtected.get(w.controller) ?? 0) + w.protectedMax);
    return {
      name: c.name, kind: c.kind, wallets: n, controllers,
      keepPerWalletPerDay: n ? keep / n / days : 0, keepPerControllerPerDay: keep / controllers / days,
      unitsPerWalletPerDay: n ? units / n / days : 0, unitsPerControllerPerDay: units / controllers / days,
      participationRate: n ? ws.reduce((a, w) => a + w.participationDays, 0) / (n * days) : 0,
      meanCapacityUnits: n ? ws.reduce((a, w) => a + w.capacitySum, 0) / (n * days) : 0,
      ingotsRefined: ws.reduce((a, w) => a + w.acct.refined, 0), ingotsPurchased: ws.reduce((a, w) => a + w.acct.purchased, 0),
      ingotsConsumed: ws.reduce((a, w) => a + w.acct.consumed, 0), ingotsReturned: ws.reduce((a, w) => a + w.returned, 0),
      shardsSunk: ws.reduce((a, w) => a + w.shardsSunk, 0), shardsIncome: ws.reduce((a, w) => a + w.shardsIncome, 0),
      protectedShardsPerControllerMax: Math.max(0, ...ctrlProtected.values()),
      medianFirstClaimDay: firstClaims.length ? firstClaims[Math.floor(firstClaims.length / 2)]! : null,
      dropsPerDay: ws.reduce((a, w) => a + w.drops, 0) / days,
      exploitGainKeep: ws.reduce((a, w) => a + Number(w.exploitGainBase / KEEP_BASE_UNITS), 0),
      exploitGainIfMarketCreditKeep: ws.reduce((a, w) => a + Number(w.exploitGainIfMarketCreditBase / KEEP_BASE_UNITS), 0),
      legacyLootExposureRemovedPerDay: c.legacyForgeLevel ? legacyForgeLootExposure(c.legacyForgeLevel) : 0,
    };
  });

  const totalAwardedKeep = Number(totalAwardedBase / KEEP_BASE_UNITS);
  const perDay = totalAwardedKeep / days;
  return {
    population, days, seed, shardsPerIngot: p.shardsPerIngot, cohorts: cohortMetrics, days_: simDays,
    utilisation: totalBudget > 0 ? totalAwardedKeep / totalBudget : 0,
    giniControllers: gini(ctrlValues), top10PctShareControllers: ctrlTotal > 0 ? top10 / ctrlTotal : 0,
    sinkRatio: totalShardsIncome > 0 ? totalShardsSunk / totalShardsIncome : 0,
    totalAwardedKeep,
    runwayYearsAtSimulatedRate: perDay > 0 ? TOKEN.allocation.playPool / (perDay * 365) : Number.POSITIVE_INFINITY,
    runwayYearsAtCeiling: runwayYearsAtCeiling(TOKEN.allocation.playPool, p),
    dropsPerDeedPositionPerDay: totalDeedPositions > 0 ? totalDrops / totalDeedPositions : 0,
  };
}

/** The seven honest + four adversary cohorts of the plan (§6), population shares
 * PROPOSED for the sweep; scores are the design's worked examples re-scored
 * under the amended normalisers. */
export function defaultCohorts(): CohortSpec[] {
  const honest = (o: Partial<CohortSpec> & Pick<CohortSpec, 'name' | 'share' | 'goldForgeLevel' | 'hasDeed' | 'scoreBps' | 'shardsIncomePerDay'>): CohortSpec => ({
    kind: 'honest', walletsPerController: 1, sgtLinked: false, keepLevel: 5, workshopLevel: 1, activeDaysPerWeek: 7,
    scoreJitterBps: 500, forgeFraction: 0.6, buysIngotsToFill: false, claimLagDays: 1, ...o,
  });
  return [
    honest({ name: 'newcomer (free T0, zero-SOL, sponsored claim)', share: 0.10, goldForgeLevel: 1, hasDeed: false, keepLevel: 3, scoreBps: 5_500, rampDays: 7, rampStartBps: 2_500, shardsIncomePerDay: 940 + 400 }),
    honest({ name: 'consistent free base (T0)', share: 0.25, goldForgeLevel: 1, hasDeed: false, keepLevel: 5, scoreBps: 5_500, shardsIncomePerDay: 3_000 }),
    honest({ name: 'consistent free base, Seeker SGT-linked (T1)', share: 0.10, goldForgeLevel: 1, hasDeed: false, sgtLinked: true, keepLevel: 5, scoreBps: 5_500, shardsIncomePerDay: 3_000 }),
    honest({ name: 'consistent deed L10 (T2, 13/14)', share: 0.15, goldForgeLevel: 10, hasDeed: true, keepLevel: 10, scoreBps: 7_600, activeDaysPerWeek: 6.5, shardsIncomePerDay: 20_000 }),
    honest({ name: 'intermittent deed L10 (T2, 3 days/week)', share: 0.15, goldForgeLevel: 10, hasDeed: true, keepLevel: 10, scoreBps: 7_000, activeDaysPerWeek: 3, shardsIncomePerDay: 20_000 }),
    // the whale mines few SHARDS and BUYS its ingots on the market (equal play to the legacy L20 owner, different spend)
    honest({ name: 'whale spender (T4, buys ingots, equal play to legacy L20)', share: 0.02, goldForgeLevel: 18, hasDeed: true, keepLevel: 15, scoreBps: 7_000, buysIngotsToFill: true, shardsIncomePerDay: 1_000 }),
    honest({ name: 'legacy L20 Gold Forge owner (T4, no purchases)', share: 0.03, goldForgeLevel: 20, hasDeed: true, keepLevel: 20, scoreBps: 7_000, shardsIncomePerDay: 150_000, legacyForgeLevel: 20 }),
    { ...honest({ name: 'ADVERSARY undetected sybil ring (10 free T0 wallets, bot S≈0.45)', share: 0.10, goldForgeLevel: 1, hasDeed: false, keepLevel: 4, scoreBps: 4_500, shardsIncomePerDay: 3_000 }), kind: 'adversary', walletsPerController: 10, adversary: 'sybil_ring' },
    { ...honest({ name: 'ADVERSARY deed-rotation ring (one L16 deed, 10 wallets)', share: 0.05, goldForgeLevel: 16, hasDeed: true, keepLevel: 10, scoreBps: 7_000, shardsIncomePerDay: 20_000 }), kind: 'adversary', walletsPerController: 10, adversary: 'deed_rotation' },
    { ...honest({ name: 'ADVERSARY wash-trading pair (deed L3, 10-KEEP ping-pong)', share: 0.02, goldForgeLevel: 3, hasDeed: true, keepLevel: 5, scoreBps: 4_500, shardsIncomePerDay: 5_000 }), kind: 'adversary', walletsPerController: 2, adversary: 'wash_trade' },
    { ...honest({ name: 'ADVERSARY drop-farming alts (20 free T0 wallets, 1 ingot each)', share: 0.03, goldForgeLevel: 1, hasDeed: false, keepLevel: 3, scoreBps: 3_000, shardsIncomePerDay: 940 }), kind: 'adversary', walletsPerController: 20, adversary: 'drop_farm' },
  ];
}

// ---------------------------------------------------------------------------
// Acceptance thresholds (plan §6, amended §6.1)
// ---------------------------------------------------------------------------

export interface ThresholdResult { id: string; label: string; value: string; threshold: string; pass: boolean | null }

export function evaluateThresholds(r: SimResult, p: KeepMiningParams = PROPOSED_PARAMS): ThresholdResult[] {
  const by = (needle: string): CohortMetrics | undefined => r.cohorts.find((c) => c.name.startsWith(needle));
  const consistent = by('consistent deed L10'); const intermittent = by('intermittent deed L10');
  const free = by('consistent free base (T0)'); const freeSgt = by('consistent free base, Seeker');
  const newcomer = by('newcomer'); const whale = by('whale'); const legacy = by('legacy L20');
  const ring = by('ADVERSARY undetected sybil'); const rotation = by('ADVERSARY deed-rotation');
  const wash = by('ADVERSARY wash'); const farm = by('ADVERSARY drop-farming');
  const f2 = (n: number): string => n.toFixed(2);
  const out: ThresholdResult[] = [];
  const ratio = (a?: CohortMetrics, b?: CohortMetrics): number => a && b && b.keepPerWalletPerDay > 0 ? a.keepPerWalletPerDay / b.keepPerWalletPerDay : Number.NaN;
  out.push({ id: 'A1', label: 'consistent deed L10 ≥ 1.5× intermittent (same tier), KEEP/wallet/day', value: f2(ratio(consistent, intermittent)), threshold: '≥ 1.50', pass: ratio(consistent, intermittent) >= 1.5 });
  const k13 = consistencyFactor(13, p), k14 = consistencyFactor(14, p);
  out.push({ id: 'A2', label: 'missing exactly 1 of 14 days = identical award (k(13) == k(14))', value: `${k13}/${k14} bps`, threshold: 'equal', pass: k13 === k14 });
  out.push({ id: 'A3a', label: 'consistent free T0 ≥ 35% of consistent deed L10', value: f2(ratio(free, consistent)), threshold: '≥ 0.35', pass: ratio(free, consistent) >= 0.35 });
  out.push({ id: 'A3b', label: 'consistent free SGT-linked T1 ≥ 35% of consistent deed L10', value: f2(ratio(freeSgt, consistent)), threshold: '≥ 0.35', pass: ratio(freeSgt, consistent) >= 0.35 });
  out.push({ id: 'A4', label: 'newcomer first CLAIMED KEEP with a zero-SOL wallet, median day', value: String(newcomer?.medianFirstClaimDay ?? 'never'), threshold: '≤ 2', pass: newcomer?.medianFirstClaimDay !== null && newcomer !== undefined && newcomer.medianFirstClaimDay! <= 2 });
  out.push({ id: 'A5', label: 'whale with purchases ≤ 1.25× legacy L20 at equal play', value: f2(ratio(whale, legacy)), threshold: '≤ 1.25', pass: ratio(whale, legacy) <= 1.25 });
  const ringPerCtrl = ring?.keepPerControllerPerDay ?? Number.NaN; const honestDeed = consistent?.keepPerWalletPerDay ?? Number.NaN;
  out.push({ id: 'A6', label: 'undetected ring KEEP/day per controller ≤ 1× one honest deed L10 wallet', value: `${f2(ringPerCtrl)} vs ${f2(honestDeed)}`, threshold: '≤ 1.00×', pass: ringPerCtrl <= honestDeed });
  const rotUnits = rotation?.unitsPerControllerPerDay ?? Number.NaN;
  out.push({ id: 'A7', label: 'deed-rotation ring units/day per controller ≤ one wallet\'s T4 capacity', value: f2(rotUnits), threshold: `≤ ${p.capacityByTier[4]}`, pass: rotUnits <= p.capacityByTier[4] });
  const atScale = r.population >= 1_000;
  out.push({ id: 'A8a', label: 'top-10% controllers ≤ 30% of allocations (≥1k wallets)', value: f2(r.top10PctShareControllers), threshold: '≤ 0.30', pass: atScale ? r.top10PctShareControllers <= 0.30 : null });
  out.push({ id: 'A8b', label: 'Gini over controllers ≤ 0.35 (≥1k wallets)', value: f2(r.giniControllers), threshold: '≤ 0.35', pass: atScale ? r.giniControllers <= 0.35 : null });
  out.push({ id: 'A9', label: 'ingot SHARDS sunk / population SHARDS income', value: f2(r.sinkRatio), threshold: '0.03 … 0.15', pass: r.sinkRatio >= 0.03 && r.sinkRatio <= 0.15 });
  out.push({ id: 'A10a', label: 'runway at full ceiling (playPool / (ceiling × 365))', value: f2(r.runwayYearsAtCeiling) + ' y', threshold: '≥ 14 y', pass: r.runwayYearsAtCeiling >= 14 });
  out.push({ id: 'A10b', label: 'runway at simulated allocation rate', value: f2(r.runwayYearsAtSimulatedRate) + ' y', threshold: '≥ 14 y', pass: r.runwayYearsAtSimulatedRate >= 14 });
  out.push({ id: 'A11', label: 'drop-farming alts drops/day (deed-gated + tier minimum)', value: f2(farm?.dropsPerDay ?? Number.NaN), threshold: '= 0', pass: (farm?.dropsPerDay ?? 1) === 0 });
  out.push({ id: 'A12', label: 'wash-trading pair exploit gain (KEEP-market credit dropped)', value: f2(wash?.exploitGainKeep ?? Number.NaN), threshold: '= 0', pass: (wash?.exploitGainKeep ?? 1) === 0 });
  out.push({ id: 'A13', label: 'utilisation Σ awards / Σ B_d', value: f2(r.utilisation), threshold: r.population <= 200 ? '≤ 0.20 at 200' : r.population >= 10_000 ? '≈ 1.0 at 10k' : 'report', pass: r.population <= 200 ? r.utilisation <= 0.20 : r.population >= 10_000 ? r.utilisation >= 0.9 : null });
  return out;
}
