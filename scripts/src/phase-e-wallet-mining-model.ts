/**
 * PROTOTYPE only: owner-revised Phase E mining experiment, 2026-09-20.
 * No runtime imports this module. Historical keep-mining-model.ts remains intact.
 * Local parameters are an authorized E1 simulation proposal, NOT live constants;
 * any later implementation must promote approved values to shared/constants.ts.
 * See docs/phase-e/OWNER-MINING-MODEL-2026-09-20.md for assumptions and limits.
 */
export const WALLET_MINING_PARAMS = {
  // LOCKED owner 2026-09-20, including later capacity/roster clarification.
  dailyCeilingKeep: 98_000, freePoolBps: 500,
  freeUnitsPerWallet: 2, maxActiveBases: 5, maxFreeBases: 2,
  shardsPerIngot: 10_000, secondFreeBaseShards: 100_000,
  rosterReplacementLamports: 100_000_000,
  seekerBonusBps: 1_000, genesisBonusBps: 2_000, graceHours: 48,
  // PROPOSED tuning, not owner locks: decay to zero by day 7; score normalization
  // is upstream input, not an asserted measurement of human activity.
  zeroAfterHours: 168, activityParts: 2, experienceParts: 1, chainParts: 1,
  minProgressFactorBps: 2_500, deedMinUnits: 4, deedMaxUnits: 24,
  freeFloorUnits: 2_000, deedFloorUnits: 2_000,
  refineDailyCapacityMultiple: 3, inventoryCapacityMultiple: 7,
} as const;
const BPS = 10_000;
export const KEEP_ATOMS = 1_000_000_000n;
const min = (a: bigint, b: bigint): bigint => a < b ? a : b;
const natural = (n: number, name: string): number => {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return n;
};
const bps = (n: number): number => {
  natural(n, 'score');
  if (n > BPS) throw new Error('score exceeds BPS');
  return n;
};
export interface MiningBase {
  id: string;
  hasDeed: boolean;
  genesis: boolean;
  /** Frozen active roster; ownership must hold throughout the epoch. */
  ownedEntireDay: boolean;
  forgeReady: boolean;
  progressBps: number;
  committedIngots: number;
}
export interface MiningWallet {
  id: string;
  /** Controller is simulation truth only, never a production identity claim. */
  controller: string;
  seeker: boolean;
  /** Includes deeds outside the active roster: provisional free-pool separation. */
  ownsAnyDeed: boolean;
  /** Server-verified development/qualification, not merely repeated collection. */
  developmentEligible: boolean;
  /** Receipt for qualifying activity in THIS epoch; retention cannot replace it. */
  freshActivity: boolean;
  activityBps: number;
  experienceBps: number;
  usefulChainBps: number;
  hoursSinceScoreRefresh: number;
  bases: readonly MiningBase[];
}
export interface BaseAward {
  walletId: string;
  baseId: string;
  pool: 'free' | 'deed';
  scoreBps: number;
  bonusBps: number;
  consumed: number;
  returned: number;
  weight: bigint;
  award: bigint;
}
export interface PoolResult { budget: bigint; awarded: bigint; retained: bigint; totalWeight: bigint }
export interface WalletMiningResult {
  budget: bigint;
  entries: BaseAward[];
  walletAwards: Map<string, bigint>;
  pools: { free: PoolResult; deed: PoolResult };
}

/** PROPOSED linear decay: full at 48h, half at 108h, zero at 168h. */
export function retainedScoreBps(hours: number): number {
  natural(hours, 'hours');
  const p = WALLET_MINING_PARAMS;
  if (hours <= p.graceHours) return BPS;
  if (hours >= p.zeroAfterHours) return 0;
  return Math.floor((p.zeroAfterHours - hours) * BPS / (p.zeroAfterHours - p.graceHours));
}

/** PROPOSED wallet activity/EXP/chain score, multiplied by each base's progress.
 * No paid deed points or resource score: deed selects the pool, ingots supply
 * the contribution independently. Upstream normalization remains unspecified.
 */
export function baseScoreBps(wallet: MiningWallet, base: MiningBase): number {
  const p = WALLET_MINING_PARAMS;
  const walletScore = Math.floor((bps(wallet.activityBps) * p.activityParts
    + bps(wallet.experienceBps) * p.experienceParts + bps(wallet.usefulChainBps) * p.chainParts)
    / (p.activityParts + p.experienceParts + p.chainParts));
  const progression = p.minProgressFactorBps
    + Math.floor((BPS - p.minProgressFactorBps) * bps(base.progressBps) / BPS);
  return Number(BigInt(walletScore) * BigInt(progression)
    * BigInt(retainedScoreBps(wallet.hoursSinceScoreRefresh)) / BigInt(BPS * BPS));
}

export function baseBonusBps(wallet: MiningWallet, base: MiningBase): number {
  const p = WALLET_MINING_PARAMS;
  return BPS + (wallet.seeker ? p.seekerBonusBps : 0)
    + (base.hasDeed && base.genesis ? p.genesisBonusBps : 0);
}

/** Deterministic daily allocation. All token math uses bigint atoms.
 * Free/deed budgets never spill over. Owner removed the proposed fixed
 * per-wallet payout cap: only funded pools, score and contribution constrain
 * issuance. This calculates new accrual, never a claim-backlog limit.
 */
export function settleWalletMining(wallets: readonly MiningWallet[], fundedBudget: bigint,
  aborted = false, floors: { free: number; deed: number } = {
    free: WALLET_MINING_PARAMS.freeFloorUnits, deed: WALLET_MINING_PARAMS.deedFloorUnits,
  }): WalletMiningResult {
  natural(floors.free, 'free floor'); natural(floors.deed, 'deed floor');
  if (fundedBudget < 0n) throw new Error('negative funding');
  const p = WALLET_MINING_PARAMS;
  const budget = min(fundedBudget, BigInt(p.dailyCeilingKeep) * KEEP_ATOMS);
  const freeBudget = budget * BigInt(p.freePoolBps) / BigInt(BPS);
  const pools = {
    free: { budget: freeBudget, awarded: 0n, retained: 0n, totalWeight: 0n },
    deed: { budget: budget - freeBudget, awarded: 0n, retained: 0n, totalWeight: 0n },
  };
  const entries: BaseAward[] = [];
  const walletIds = new Set<string>();
  const baseIds = new Set<string>();
  for (const wallet of wallets) {
    if (walletIds.has(wallet.id)) throw new Error('duplicate wallet');
    walletIds.add(wallet.id);
    if (wallet.bases.length > p.maxActiveBases) throw new Error('too many active bases');
    if (wallet.bases.filter((b) => !b.hasDeed).length > p.maxFreeBases) throw new Error('too many free bases');
    if (!wallet.ownsAnyDeed && wallet.bases.some((b) => b.hasDeed)) throw new Error('deed ownership mismatch');
    let freeRoom: number = p.freeUnitsPerWallet;
    // Canonical roster order prevents request ordering from deciding which
    // free base consumes the shared two-unit allowance.
    for (const base of [...wallet.bases].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      if (baseIds.has(base.id)) throw new Error('duplicate base');
      baseIds.add(base.id);
      natural(base.committedIngots, 'commitment');
      if (base.genesis && !base.hasDeed) throw new Error('genesis must have a deed');
      const scoreBps = baseScoreBps(wallet, base);
      const bonusBps = baseBonusBps(wallet, base);
      const pool = base.hasDeed ? 'deed' : 'free';
      const eligible = !aborted && pools[pool].budget > 0n && wallet.developmentEligible && wallet.freshActivity
        && base.ownedEntireDay && base.forgeReady && scoreBps > 0
        && (base.hasDeed || !wallet.ownsAnyDeed);
      const capacity = base.hasDeed
        ? p.deedMinUnits + Math.floor((p.deedMaxUnits - p.deedMinUnits) * base.progressBps / BPS)
        : freeRoom;
      const consumed = eligible ? Math.min(capacity, base.committedIngots) : 0;
      if (!base.hasDeed) freeRoom -= consumed;
      const weight = BigInt(consumed) * BigInt(scoreBps) * BigInt(bonusBps);
      pools[pool].totalWeight += weight;
      entries.push({ walletId: wallet.id, baseId: base.id, pool, scoreBps, bonusBps,
        consumed, returned: base.committedIngots - consumed, weight, award: 0n });
    }
  }
  const walletAwards = new Map<string, bigint>(wallets.map((w) => [w.id, 0n]));
  for (const entry of entries) {
    const pool = pools[entry.pool];
    const floorUnits = floors[entry.pool];
    const floorWeight = BigInt(floorUnits) * BigInt(BPS * BPS);
    const denominator = pool.totalWeight > floorWeight ? pool.totalWeight : floorWeight;
    entry.award = denominator === 0n ? 0n : pool.budget * entry.weight / denominator;
    walletAwards.set(entry.walletId, (walletAwards.get(entry.walletId) ?? 0n) + entry.award);
    pool.awarded += entry.award;
  }
  for (const pool of Object.values(pools)) pool.retained = pool.budget - pool.awarded;
  return { budget, entries, walletAwards, pools };
}

/** PROPOSED bounds count held, listed, reserved AND in-progress inventory.
 * Workshop requirement and 10,000-SHARDS recipe are LOCKED. Refining is a
 * resource-only prototype; this does not simulate job duration or transfers.
 */
export function refineWalletIngots(input: {
  workshopReady: boolean; shards: number; requested: number; capacity: number;
  refinedToday: number; held: number; listed: number; reserved: number; inProgress: number;
}): { ingots: number; shardsSunk: number } {
  for (const [key, value] of Object.entries(input)) if (typeof value === 'number') natural(value, key);
  const p = WALLET_MINING_PARAMS;
  const holding = input.held + input.listed + input.reserved + input.inProgress;
  const ingots = input.workshopReady ? Math.min(input.requested,
    Math.floor(input.shards / p.shardsPerIngot),
    Math.max(0, input.capacity * p.refineDailyCapacityMultiple - input.refinedToday),
    Math.max(0, input.capacity * p.inventoryCapacityMultiple - holding)) : 0;
  return { ingots, shardsSunk: ingots * p.shardsPerIngot };
}
