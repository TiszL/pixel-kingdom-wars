/**
 * Forge-model property tests — the OWNER RULES the implementation must ship
 * with (the "why", per CLAUDE.md test rule):
 *  1. Soft cap: low-participation days distribute only total/softCap of the
 *     emission — 5 early players can NOT mine the whole daily allocation.
 *  2. The soft cap IS the printer guard: rate = emission/max(total, softCap)
 *     stays sub-parity whenever softCap > dailyEmission; an undersized soft
 *     cap re-opens the deposit→forge→withdraw printer.
 *  3. Per-player 30% cap: a 90%-whale takes 30% of the pool, gets the excess
 *     shards REFUNDED, and the uncaptured emission stays in the pool.
 *  4. The sub-parity invariant holds for the LIVE constants.
 */
import { FORGE, TOKEN } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { settleForgeDay, simulateForge, type ForgeParams } from './forge-model';

const base: ForgeParams = {
  players: 1_000,
  days: 365,
  profile: { keepLevel: 5, mineLevels: [4, 4], streakDays: 7 },
  forgeFraction: 0.5,
  withdrawFraction: 0.3,
  whaleDepositKeepPerDay: 0,
};

describe('gold forge — owner rules (2026-07-24)', () => {
  it('LIVE CONSTANTS: sub-parity invariant + 5-year emission derivation', () => {
    // softCap > dailyEmission ⇒ max rate < 1 KEEP/shard (printer impossible)
    expect(FORGE.softCapShards).toBeGreaterThan(FORGE.dailyEmissionKeep);
    // daily emission spans the 500M play allocation over 5 years
    expect(FORGE.dailyEmissionKeep).toBe(Math.floor(TOKEN.allocation.playPool / (FORGE.emissionYears * 365)));
  });

  it('soft cap: 5 early players cannot mine the full daily allocation', () => {
    const five = settleForgeDay([100, 100, 100, 100, 100]); // 500 shards << softCap
    // only total/softCap of the emission distributes…
    const expected = (FORGE.dailyEmissionKeep * 500) / FORGE.softCapShards;
    expect(five.distributed).toBeCloseTo(expected, 6);
    expect(five.distributed).toBeLessThan(FORGE.dailyEmissionKeep * 0.01);
    // …at the constant sub-parity rate, split evenly among equal contributors
    expect(five.rate).toBeCloseTo(FORGE.dailyEmissionKeep / FORGE.softCapShards, 9);
    expect(five.payouts[0]).toBeCloseTo(five.distributed / 5, 6);
  });

  it('above the soft cap the FULL daily emission distributes and rate decays', () => {
    // four equal contributors (25% each — under the 30% cap, so nothing is
    // withheld; two 50% contributors would BOTH cap and leave 40% in the pool)
    const total = FORGE.softCapShards * 4;
    const each = total / 4;
    const res = settleForgeDay([each, each, each, each]);
    expect(res.distributed).toBeCloseTo(FORGE.dailyEmissionKeep, 6);
    expect(res.rate).toBeCloseTo(FORGE.dailyEmissionKeep / total, 9);
  });

  it('30% cap: a 90% whale gets 30% of the pool + excess shards refunded; the rest stays in the pool', () => {
    const total = FORGE.softCapShards; // exactly at cap → full emission
    const whale = total * 0.9, small = total * 0.1;
    const res = settleForgeDay([whale, small]);
    // whale payout capped at 30% of the DISTRIBUTED pool
    expect(res.payouts[0]).toBeCloseTo((FORGE.dailyEmissionKeep * 0.3), 3);
    // whale's counted shards = 30% of total; the rest come back
    expect(res.refunds[0]).toBeCloseTo(whale - total * 0.3, 6);
    // small contributor is NOT redistributed the whale's uncaptured share
    expect(res.payouts[1]).toBeCloseTo(small * res.rate, 6);
    // total paid < full emission — the uncaptured 60% stays in the pool
    expect(res.payouts[0]! + res.payouts[1]!).toBeLessThan(FORGE.dailyEmissionKeep * 0.5);
  });

  it('PRINTER: an undersized soft cap (< daily emission) re-opens the exploit; live constants close it', () => {
    const bad = simulateForge({ ...base, players: 0, whaleDepositKeepPerDay: 10_000, softCapShards: 20_000 });
    expect(bad.maxRate).toBeGreaterThan(1);
    expect(bad.printerLeak).toBeGreaterThan(0);
    const good = simulateForge({ ...base, players: 0, whaleDepositKeepPerDay: 10_000 });
    expect(good.maxRate).toBeLessThan(1);
    expect(good.printerLeak).toBe(0);
  });

  it('a populated forge survives a 2-year horizon with zero leak', () => {
    const r = simulateForge({ ...base, players: 20_000, days: 730 });
    expect(r.depletedDay).toBeNull();
    expect(r.printerLeak).toBe(0);
    expect(r.maxRate).toBeLessThan(1);
  });
});
