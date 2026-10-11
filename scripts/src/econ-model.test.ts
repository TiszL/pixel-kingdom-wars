/**
 * Economic pool-reservoir model (#47). Encodes the WHY: the pool drains ONLY by
 * withdrawals only (starter grants are SHARDS), survival is monotonic in
 * player count (so a stable cap exists), the emission controller strictly EXTENDS
 * that cap (bounded — it can't manufacture supply), and a maxed "whale" population
 * drains the 500M pool in weeks (why 100k+ mature bases are structurally impossible).
 */
import { ECONOMY } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { findStableCap, simulateEconomy, type EconParams, type EconProfile } from './econ-model';

const climbing: EconProfile = { keepLevel: 5, mineLevels: [4, 4], streakDays: 7, withdrawFraction: 0.15 };
const mature: EconProfile = { keepLevel: 20, mineLevels: [20, 20, 20, 20, 20, 20, 20, 20], streakDays: 7, withdrawFraction: 0.9 };

const base = (over: Partial<EconParams>): EconParams => ({
  players: 100, days: 365, controller: false, rampDays: 30, profile: climbing, ...over,
});

describe('conservation identity — starter SHARDS never drain the KEEP pool', () => {
  it('finalPool == initialPool − totalWithdrawn and starter grants are reported separately', () => {
    const r = simulateEconomy(base({ players: 50, profile: climbing }));
    expect(r.survived).toBe(true);
    const initialPool = 500_000_000;
    expect(r.finalPool).toBeCloseTo(initialPool - r.totalWithdrawn, 2);
    // DERIVED, not restated: the rule under test is "starter grants are SHARDS
    // and are reported separately from the KEEP pool" — not any particular
    // grant size. Hardcoding 2,000 made an owner retune (2,000 → 5,000 on
    // 2026-08-16) read as an economic failure when nothing about the identity
    // above had changed.
    expect(r.totalStarterShards).toBe(50 * ECONOMY.starterShards);
  });
});

describe('survival is monotonic in player count (a stable cap exists)', () => {
  it('a cap survives, and triple the cap does not', () => {
    const cap = findStableCap(base({ profile: climbing }));
    expect(cap).toBeGreaterThan(0);
    expect(simulateEconomy(base({ players: cap, profile: climbing })).survived).toBe(true);
    expect(simulateEconomy(base({ players: cap * 3, profile: climbing })).survived).toBe(false);
  });
});

describe('the emission controller strictly extends the stable cap', () => {
  it('climbing: cap(on) > cap(off)', () => {
    const off = findStableCap(base({ profile: climbing, controller: false }));
    const on = findStableCap(base({ profile: climbing, controller: true }));
    expect(on).toBeGreaterThan(off);
  });
  it('mature: cap(on) >= cap(off), both tiny (a maxed base is expensive to the pool)', () => {
    const off = findStableCap(base({ profile: mature, controller: false }));
    const on = findStableCap(base({ profile: mature, controller: true }));
    expect(on).toBeGreaterThanOrEqual(off);
    expect(off).toBeLessThan(50); // whales are structurally scarce
  });
  it('the controller cannot manufacture supply — headroom is bounded (< ~20×)', () => {
    const off = findStableCap(base({ profile: climbing, controller: false }));
    const on = findStableCap(base({ profile: climbing, controller: true }));
    expect(on).toBeLessThan(off * 20); // the 10% emission floor caps the benefit
  });
});

describe('a maxed-whale population drains the pool fast (100k+ is impossible)', () => {
  it('100 mature players exhaust 500M within two months', () => {
    const r = simulateEconomy(base({ players: 100, profile: mature, controller: false, rampDays: 0 }));
    expect(r.survived).toBe(false);
    expect(r.deadDay).not.toBeNull();
    expect(r.deadDay!).toBeLessThan(60);
  });
});
