/**
 * Economic pool-reservoir model (#47, owner 2026-07-20). Answers: "what is the
 * stable player cap, with and without the #45 emission controller?"
 *
 * It lives in @shardkeep/scripts (NOT packages/sim): a reservoir/behavioral model
 * wants floats + adoption ramps, which packages/sim's purity guard bans — and it
 * needs NO cross-engine determinism (it touches no golden fixtures). It imports
 * EVERY number from @shardkeep/shared (playPool, the MINING bps tables via
 * getMiningQuota, starterShards, withdraw caps, the controller policy) so it can
 * never drift from the live game (CLAUDE.md hard rule).
 *
 * The economy's key truth (ECONOMY.md §4b): the 500M KEEP pool DRAINS only via
 * WITHDRAWALS — starter grants are non-withdrawable SHARDS. So there is
 * no infinite steady state; a "stable cap" = the largest active-player count whose
 * pool survives a chosen horizon (e.g. 1 year). The controller slows the drain by
 * cutting per-player emission as the pool shrinks / outflow spikes / the crowd grows.
 */
import {
  EMISSION_CONTROL,
  TOKEN,
  ECONOMY,
  emissionTargetBps,
  getMiningQuota,
  smoothEmissionBps,
} from '@shardkeep/shared';

/** A representative player's base + cash-out behavior. */
export interface EconProfile {
  keepLevel: number;
  mineLevels: number[];
  streakDays: number;
  /** Fraction of daily mined KEEP that is WITHDRAWN (the permanent pool exit); the
   *  rest is spent on in-game sinks and RECYCLES to the pool. Climbing bases keep
   *  this low (reinvesting); mature/maxed bases keep it high (nothing left to buy). */
  withdrawFraction: number;
}

export interface EconParams {
  /** Steady-state active-player count the model ramps to. */
  players: number;
  /** Horizon in days. */
  days: number;
  /** Whether the #45 emission controller is driving the multiplier. */
  controller: boolean;
  /** Linear onboarding ramp to `players` over this many days (0 = all at once). */
  rampDays: number;
  profile: EconProfile;
  /** One-time per-new-player SHARD grant; reported but never debited from KEEP. */
  starterShards?: number;
  /** Initial pool. Defaults to TOKEN.allocation.playPool (500M). */
  initialPool?: number;
}

export interface EconDay {
  day: number;
  pool: number;
  epochBps: number;
  active: number;
  mined: number;
  withdrawn: number;
  starterShards: number;
}

export interface EconResult {
  days: EconDay[];
  /** True iff the pool stayed > 0 through the whole horizon. */
  survived: boolean;
  /** First day the pool hit 0, or null if it survived. */
  deadDay: number | null;
  finalPool: number;
  /** Lowest emission multiplier the controller reached (10000 if never throttled). */
  minEpochBps: number;
  totalWithdrawn: number;
  totalStarterShards: number;
}

/** Active players on day `d` under a linear onboarding ramp. */
export function activeOnDay(d: number, target: number, rampDays: number): number {
  if (rampDays <= 0 || d >= rampDays) return target;
  return Math.round((target * d) / rampDays);
}

/**
 * Simulate the emission pool day-by-day. Each day: onboard new players (and
 * report their separate SHARD grant), optionally retune the multiplier, mine
 * (bounded by the remaining pool — the pool floors at 0), withdraw a fraction
 * (permanent exit) and recycle the rest. Because recycling exactly offsets the
 * non-withdrawn mining, the KEEP pool nets down only by withdrawals. Starter
 * SHARDS are tracked separately and never debit this reservoir.
 */
export function simulateEconomy(p: EconParams): EconResult {
  const initialPool = p.initialPool ?? TOKEN.allocation.playPool;
  const starterShards = p.starterShards ?? ECONOMY.starterShards;
  let pool = initialPool;
  let epochBps: number = EMISSION_CONTROL.maxBps;
  let prevActive = 0;
  let prevWithdrawn = 0;
  let minEpochBps: number = epochBps;
  let totalWithdrawn = 0;
  let totalStarterShards = 0;
  const days: EconDay[] = [];
  let deadDay: number | null = null;

  for (let d = 1; d <= p.days; d++) {
    const active = activeOnDay(d, p.players, p.rampDays);
    const newPlayers = Math.max(0, active - prevActive);

    if (p.controller) {
      const poolPct = initialPool > 0 ? (pool * 100) / initialPool : 0;
      const target = emissionTargetBps({ poolPct, outflow24h: prevWithdrawn, poolBalance: pool, activePlayers: active });
      epochBps = smoothEmissionBps(epochBps, target);
    } else {
      epochBps = EMISSION_CONTROL.maxBps;
    }
    minEpochBps = Math.min(minEpochBps, epochBps);

    // Mining is a WASH on the pool: what players mine, they mostly spend back
    // (sinks recycle 100%). Starter grants are SHARDS outside this KEEP reservoir,
    // so track withdrawn KEEP as the only permanent pool drain and report onboarding
    // SHARDS separately.
    const perPlayerMined = getMiningQuota(p.profile.keepLevel, p.profile.mineLevels, p.profile.streakDays, epochBps);
    const wantedMined = active * perPlayerMined;
    const withdrawn = wantedMined * p.profile.withdrawFraction; // permanent exit
    const starterGranted = newPlayers * starterShards;
    const drain = withdrawn;

    if (drain >= pool) {
      // The pool can't fund another full day of net outflow → exhausted.
      totalWithdrawn += Math.min(withdrawn, pool);
      totalStarterShards += starterGranted;
      days.push({ day: d, pool: 0, epochBps, active, mined: wantedMined, withdrawn, starterShards: starterGranted });
      deadDay = d;
      pool = 0;
      break;
    }
    pool -= drain;
    totalWithdrawn += withdrawn;
    totalStarterShards += starterGranted;
    days.push({ day: d, pool, epochBps, active, mined: wantedMined, withdrawn, starterShards: starterGranted });
    prevActive = active;
    prevWithdrawn = withdrawn;
  }

  return {
    days,
    survived: deadDay === null,
    deadDay,
    finalPool: pool,
    minEpochBps,
    totalWithdrawn,
    totalStarterShards,
  };
}

/**
 * Largest steady-state player count whose pool survives the horizon — binary search
 * over N (survival is monotonic in N: more players drain faster). Returns `hi` if
 * even that survives.
 */
export function findStableCap(base: Omit<EconParams, 'players'>, hi = 2_000_000): number {
  if (simulateEconomy({ ...base, players: hi }).survived) return hi;
  let lo = 0;
  let high = hi;
  while (lo < high) {
    const mid = Math.ceil((lo + high) / 2);
    if (simulateEconomy({ ...base, players: mid }).survived) lo = mid;
    else high = mid - 1;
  }
  return lo;
}
