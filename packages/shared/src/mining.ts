/**
 * Mining emission — the pure reward formula + the treasury-aware controller policy
 * (owner 2026-07-20). Lifted here from apps/api/src/game/emission.ts so the SAME
 * math is the single source for the server (which mints against it), the #45
 * emission controller, and the #47 economic simulation — none re-derive it. All
 * numbers come from constants.ts; this file holds only pure functions (no I/O, no
 * clock), so it is trivially testable and safe to import anywhere.
 */
import { EMISSION_CONTROL, MINING } from './constants';

/**
 * Fixed daily mining quota in shards (integer). Mining is the SUM over ALL of a
 * player's mines — each contributes MINE_QUOTA_BASE × its OWN level multiplier —
 * then scaled by the player-wide keep, consistency, and epoch multipliers. No
 * mines or no keep → 0. Computed entirely in bigint basis points (multiply-before-
 * divide, / BPS_ONE^4) so no float ever produces a balance (CLAUDE.md hard rule).
 *
 * `epochBps` is the runtime emission multiplier (#45): it defaults to the compile-
 * time MINING.EPOCH_RATE_BPS (10000 = 1.0×) so every existing caller and test is
 * unchanged; the server passes the live game_config value so the controller's
 * throttle takes effect at each player's next collect via the existing lazy accrual.
 */
export function getMiningQuota(
  keepLevel: number,
  mineLevels: number[],
  streakDays: number,
  epochBps: number = MINING.EPOCH_RATE_BPS,
  /** Additive referral bonus in bps ABOVE one (D-052, owner 2026-08-15):
   * +50 per active qualified referral, so 3 actives pass 150 → ×1.015. The
   * server computes the count (activity + deed checks live there); the
   * formula stays pure and integer. 0 = no referrals, every legacy caller. */
  referralBonusBps: number = 0,
): number {
  if (mineLevels.length === 0 || keepLevel <= 0) return 0;
  const one = BigInt(MINING.BPS_ONE);
  // Sum each mine's OWN level multiplier (additive per-mine income).
  let sumMineBps = 0n;
  for (const lvl of mineLevels) {
    sumMineBps += BigInt(
      MINING.MINE_MULT_BPS[Math.min(Math.max(lvl, 1), MINING.MINE_MULT_BPS.length) - 1] ?? MINING.BPS_ONE,
    );
  }
  const keepBps = BigInt(MINING.KEEP_MULT_BPS[Math.min(keepLevel, MINING.KEEP_MULT_BPS.length) - 1] ?? MINING.BPS_ONE);
  const consBps = BigInt(streakDays >= MINING.CONSISTENCY_STREAK_DAYS ? MINING.CONSISTENCY_BPS : MINING.BPS_ONE);
  const epoch = BigInt(epochBps);
  const referral = one + BigInt(Math.max(0, Math.trunc(referralBonusBps)));
  const quota = (BigInt(MINING.MINE_QUOTA_BASE) * sumMineBps * keepBps * consBps * epoch * referral)
    / (one * one * one * one * one);
  return Number(quota);
}

// ---------------------------------------------------------------------------
// Treasury-aware emission controller policy (#45) — pure, integer bps.
// ---------------------------------------------------------------------------

/** Live telemetry the controller maps to a target multiplier. */
export interface EmissionSignals {
  /** Percent of the 500M pool still remaining (0–100). */
  poolPct: number;
  /** KEEP withdrawn over the rolling last 24h (permanent outflow). */
  outflow24h: number;
  /** Remaining emission_pool balance in KEEP. */
  poolBalance: number;
  /** Players active within EMISSION_CONTROL.activeWindowSec. */
  activePlayers: number;
}

/**
 * Linear-interpolate a raw signal to an emission multiplier in [minBps, maxBps].
 * `good` = the input at which emission is FULL (maxBps); `bad` = where it hits the
 * floor (minBps). Works in either direction (good>bad for pool%, good<bad for the
 * outflow ratio) because the fraction (x−good)/(bad−good) carries the sign.
 */
function signalBps(x: number, good: number, bad: number): number {
  const C = EMISSION_CONTROL;
  if (good === bad) return x === good ? C.maxBps : C.minBps;
  const t = (x - good) / (bad - good); // 0 at good → maxBps, 1 at bad → minBps
  const clamped = Math.max(0, Math.min(1, t));
  return Math.round(C.maxBps - clamped * (C.maxBps - C.minBps));
}

/**
 * Target emission multiplier (bps) = MIN of three independent throttles: pool
 * health, withdrawal outflow, and crowd size. The most-constraining signal wins,
 * so ANY of a draining pool / a cash-out spike / a player flood pulls emission
 * down. Pure integer bps, clamped to [minBps, maxBps].
 */
export function emissionTargetBps(s: EmissionSignals): number {
  const C = EMISSION_CONTROL;
  const poolSig = signalBps(s.poolPct, C.poolHealthyPct, C.poolCriticalPct);
  const ratioBps = s.poolBalance > 0
    ? Math.floor((s.outflow24h * MINING.BPS_ONE) / s.poolBalance)
    : C.outflowHardBps;
  const outSig = signalBps(ratioBps, C.outflowSoftBps, C.outflowHardBps);
  const crowdSig = s.activePlayers <= C.crowdBaseline
    ? C.maxBps
    : Math.max(C.minBps, Math.floor((C.maxBps * C.crowdBaseline) / s.activePlayers));
  return Math.max(C.minBps, Math.min(C.maxBps, Math.min(poolSig, outSig, crowdSig)));
}

/**
 * Asymmetric smoothing toward `target`: cut fast (up to cutStepBps/tick), recover
 * slow (up to recoverStepBps/tick). A transient outflow spike throttles within a
 * few 10-min ticks but the rate eases back over hours, so it can't oscillate.
 */
export function smoothEmissionBps(current: number, target: number): number {
  const C = EMISSION_CONTROL;
  const next = target < current
    ? Math.max(target, current - C.cutStepBps)
    : Math.min(target, current + C.recoverStepBps);
  return Math.max(C.minBps, Math.min(C.maxBps, next));
}
