/**
 * Mining formula + treasury-aware emission controller policy (#45). Encodes the
 * WHY: the reward formula is unchanged at the 1.0× baseline (so existing balances +
 * golden fixtures hold), the epoch multiplier scales it linearly, and the controller
 * pulls emission DOWN whenever ANY of pool health / withdrawal outflow / crowd size
 * degrades — cutting fast but recovering slow so it can't oscillate.
 */
import { describe, expect, it } from 'vitest';
import { EMISSION_CONTROL } from './constants';
import { emissionTargetBps, getMiningQuota, smoothEmissionBps } from './mining';

describe('getMiningQuota epochBps threading', () => {
  it('defaults to the 1.0× baseline (unchanged from the pre-lift values)', () => {
    // These are the same anchors the server test asserts — the lift must not move them.
    // Post-retune (owner 2026-07-20, maxed ~250k/day): L1 anchor stays 500; the maxed
    // single-mine values drop with the flatter L20 multiplier (×6.68, was ×12).
    expect(getMiningQuota(1, [1], 0)).toBe(500);
    expect(getMiningQuota(5, [5], 0)).toBe(5_346);
    expect(getMiningQuota(5, [5], 7)).toBe(7_485);
  });

  it('applies the referral bonus as one integer-bps factor (D-052)', () => {
    const base = getMiningQuota(5, [5], 7);
    // 3 active referrals → +150 bps → ×1.015, floor division, never floats.
    expect(getMiningQuota(5, [5], 7, 10_000, 150)).toBe(Number((BigInt(base) * 10_150n) / 10_000n));
    // 0 bonus and a negative/garbage bonus are the identity — the server owns
    // count validity; the pure formula refuses to shrink a quota.
    expect(getMiningQuota(5, [5], 7, 10_000, 0)).toBe(base);
    expect(getMiningQuota(5, [5], 7, 10_000, -500)).toBe(base);
  });

  it('scales linearly with the epoch multiplier (the controller knob)', () => {
    const full = getMiningQuota(5, [5], 7, 10_000);
    expect(getMiningQuota(5, [5], 7, 5_000)).toBe(Math.floor(full / 2));
    expect(getMiningQuota(5, [5], 7, 1_000)).toBe(Math.floor(full / 10));
    expect(getMiningQuota(5, [5], 7, 0)).toBe(0);
  });
});

describe('emissionTargetBps — any degraded signal throttles', () => {
  const healthy = { poolPct: 80, outflow24h: 0, poolBalance: 500_000_000, activePlayers: 100 };

  it('is full (maxBps) when pool/outflow/crowd are all healthy', () => {
    expect(emissionTargetBps(healthy)).toBe(EMISSION_CONTROL.maxBps);
  });

  it('floors (minBps) when the pool is at/below the critical level', () => {
    expect(emissionTargetBps({ ...healthy, poolPct: EMISSION_CONTROL.poolCriticalPct })).toBe(EMISSION_CONTROL.minBps);
  });

  it('throttles proportionally as the pool drains between healthy and critical', () => {
    const mid = emissionTargetBps({ ...healthy, poolPct: 30 }); // halfway 50→10
    expect(mid).toBeGreaterThan(EMISSION_CONTROL.minBps);
    expect(mid).toBeLessThan(EMISSION_CONTROL.maxBps);
  });

  it('floors when 24h outflow reaches the hard ratio of the pool', () => {
    // outflowHardBps of the pool = e.g. 6% → ratio hits the floor.
    const outflow24h = Math.floor((500_000_000 * EMISSION_CONTROL.outflowHardBps) / 10_000);
    expect(emissionTargetBps({ ...healthy, outflow24h })).toBe(EMISSION_CONTROL.minBps);
  });

  it('throttles ∝ baseline/active once the crowd exceeds the baseline', () => {
    const twoX = emissionTargetBps({ ...healthy, activePlayers: EMISSION_CONTROL.crowdBaseline * 2 });
    expect(twoX).toBeCloseTo(EMISSION_CONTROL.maxBps / 2, -2); // ~0.5×
    const flood = emissionTargetBps({ ...healthy, activePlayers: 200_000 });
    expect(flood).toBe(EMISSION_CONTROL.minBps); // a 100k+ flood is fully throttled
  });

  it('takes the MIN across signals (most-constraining wins)', () => {
    // Healthy pool but a crowd flood → the crowd signal dominates.
    const t = emissionTargetBps({ ...healthy, poolPct: 90, activePlayers: EMISSION_CONTROL.crowdBaseline * 4 });
    expect(t).toBeLessThan(EMISSION_CONTROL.maxBps / 3);
  });
});

describe('smoothEmissionBps — cut fast, recover slow', () => {
  it('cuts by up to cutStepBps in one tick', () => {
    expect(smoothEmissionBps(10_000, 1_000)).toBe(10_000 - EMISSION_CONTROL.cutStepBps);
  });
  it('recovers by only recoverStepBps in one tick', () => {
    expect(smoothEmissionBps(1_000, 10_000)).toBe(1_000 + EMISSION_CONTROL.recoverStepBps);
  });
  it('snaps exactly to target when within a step', () => {
    expect(smoothEmissionBps(1_000, 1_200)).toBe(1_200);
    expect(smoothEmissionBps(2_000, 1_500)).toBe(1_500);
  });
  it('never leaves the [minBps, maxBps] band', () => {
    expect(smoothEmissionBps(1_000, 0)).toBe(EMISSION_CONTROL.minBps);
    expect(smoothEmissionBps(10_000, 99_999)).toBe(EMISSION_CONTROL.maxBps);
  });
});
