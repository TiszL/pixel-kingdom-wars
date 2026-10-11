/**
 * KEEP mining model — property tests (Phase E E1, 2026-09-20). Each block names
 * the OWNER RULE it pins (the "why", per CLAUDE.md test rule) so that a later
 * change to the rule must rewrite the test, never delete it:
 *  1. Conservation: Σ awards + remainder + unallocated = B_d; awards ≤ B_d.
 *  2. Units are capped by earned capacity: units ≤ Cap ≤ C_max(T4).
 *  3. Sub-parity against the LIVE ECONOMY.shardsPerKeep: F_min × R > ceiling × s.
 *  4. An aborted epoch releases every reservation exactly once and pays nothing
 *     (replayed with retries).
 *  5. A zero-score wallet with purchased ingots earns 0 (purchases fill, never create).
 *  6. A late claim leaves U, B and F unchanged (claims draw encumbered balance).
 *  7. Award is monotone non-decreasing in own units and non-increasing in U.
 *  8. Ingot conservation across refine / list / transfer / commit / settle / abort.
 *  9. Deed-rotation adversary: ring total ≤ one wallet's T4 capacity.
 * 10. Undetected sybil ring per controller ≤ 1× one honest deed wallet under the
 *     amended rules (T0 free capacity; no market credit; auto-match-only PvP).
 * 11. Amended scoring rules: KEEP-market settlements never score; only the first
 *     three auto-match raids score; gameplay normaliser 4.
 * PROPOSED_PARAMS are not constants; tests that sweep them say so.
 */
import { ECONOMY, TOKEN } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  BPS, KEEP_BASE_UNITS, PROPOSED_PARAMS, abortEpochOnAccount, applySettlementToAccount, budgetForDay,
  capacityUnits, claimFromVault, commitIngots, consistencyFactor, dailyScore, defaultCohorts, dropEligible,
  evaluateThresholds, floorForDay, ingotBalanceOk, keepToBase, listIngots, maxKeepPerShard, mulberry32,
  newIngotAccount, recordAwards, refineIngots, runwayYearsAtCeiling, settleMiningDay, simulateKeepMining,
  subParityHolds, tierOf, transferIngots, unencumberedKeep, type DaySignals, type KeepMiningParams,
  type SettlementEntry, type TierIndex, type Vault,
} from './keep-mining-model';

const CASES = 200;
const P = PROPOSED_PARAMS;
const T4 = P.capacityByTier[4];
const int = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

function randomEntries(rng: () => number, n: number): SettlementEntry[] {
  return Array.from({ length: n }, (_, i) => ({ id: `w${i}`, capacityUnits: int(rng, 0, T4), committedIngots: int(rng, 0, 40) }));
}

const baseSignals: DaySignals = {
  mineCollected: false, harvesterCollected: false, ownRefineCompletions: 0, expeditionReturns: 0,
  autoMatchPvp: [], pveStarBattles: 0, buildStarted: false, trainingQueued: false,
  vehicleBurnsNonPurchased: 0, solSettlementsAboveFloorWithRoyalty: 0, nominatedDeedValid: false, keepLevel: 1,
};

describe('KEEP mining — allocation conservation and caps (plan §6)', () => {
  it('Σ awards + remainder + unallocated = B_d and awards ≤ B_d for 200 seeded days', () => {
    const rng = mulberry32(1);
    for (let c = 0; c < CASES; c++) {
      const budgetKeep = int(rng, 0, P.ceilingKeepPerDay);
      const floorUnits = int(rng, 1, 5_000);
      const s = settleMiningDay({ budgetKeep, floorUnits, entries: randomEntries(rng, int(rng, 0, 300)) });
      const sum = s.entries.reduce((a, e) => a + e.awardBase, 0n);
      expect(sum).toBe(s.awardedBase);
      expect(s.awardedBase + s.remainderBase + s.unallocatedBase).toBe(keepToBase(budgetKeep));
      expect(s.awardedBase <= keepToBase(budgetKeep)).toBe(true);
      expect(s.remainderBase >= 0n && s.unallocatedBase >= 0n).toBe(true);
      // the floor lets out at most B × U/F: units cap issuance
      expect(s.awardedBase <= (keepToBase(budgetKeep) * BigInt(s.totalUnits)) / BigInt(floorUnits)).toBe(true);
    }
  });

  it('units ≤ Cap ≤ C_max(T4) for every tier/score/k, and excess ingots are returned not consumed', () => {
    const rng = mulberry32(2);
    for (let c = 0; c < CASES; c++) {
      const tier = int(rng, 0, 4) as TierIndex;
      const cap = capacityUnits(tier, int(rng, 0, BPS), int(rng, P.consistencyMinBps, BPS));
      expect(cap.units).toBeLessThanOrEqual(cap.cMax);
      expect(cap.cMax).toBeLessThanOrEqual(T4);
      const committed = int(rng, 0, 60);
      const s = settleMiningDay({ budgetKeep: P.ceilingKeepPerDay, floorUnits: P.floorMinUnits, entries: [{ id: 'a', capacityUnits: cap.units, committedIngots: committed }] });
      const e = s.entries[0]!;
      expect(e.units).toBe(Math.min(cap.units, committed));
      expect(e.consumedIngots + e.returnedIngots).toBe(committed);
      expect(e.units).toBeLessThanOrEqual(T4);
    }
  });

  it('capacity progress bar: milliUnits carries the fraction and one gameplay action is ≥ one visible step at T1 (normaliser 4)', () => {
    const k = consistencyFactor(14);
    const before = dailyScore({ ...baseSignals, mineCollected: true });
    const after = dailyScore({ ...baseSignals, mineCollected: true, pveStarBattles: 1 });
    const c0 = capacityUnits(1, before.scoreBps, k), c1 = capacityUnits(1, after.scoreBps, k);
    // one PvE stage = 0.25 gameplay × 0.25 weight = 0.0625 S → 0.75 ingot at T1: visible on the bar
    expect(c1.milliUnits - c0.milliUnits).toBeGreaterThanOrEqual(700);
    expect(c0.toNextMilli).toBeGreaterThan(0);
  });
});

describe('KEEP mining — sub-parity against the LIVE conversion rate', () => {
  it('F_min × R > ceiling × ECONOMY.shardsPerKeep (imported, not assumed 1) and the max return per SHARD < 1', () => {
    expect(subParityHolds(P, ECONOMY.shardsPerKeep)).toBe(true);
    expect(P.floorMinUnits * P.shardsPerIngot).toBeGreaterThan(P.ceilingKeepPerDay * ECONOMY.shardsPerKeep);
    expect(maxKeepPerShard(P) * ECONOMY.shardsPerKeep).toBeLessThan(1);
    // the guard is a property of R and F_min, not of the current rate being 1:
    // raising shardsPerKeep past F_min×R/ceiling (≈2.04 today) would re-open the loop
    expect(subParityHolds(P, 3)).toBe(false);
    expect(subParityHolds({ ...P, floorMinUnits: 900 }, ECONOMY.shardsPerKeep)).toBe(false);
  });

  it('runway: 500M play pool at the 98,000 ceiling is 13.98 y (NOT ≥ 14 as the design prose says)', () => {
    const y = runwayYearsAtCeiling(TOKEN.allocation.playPool, P);
    expect(y).toBeGreaterThan(13.9);
    expect(y).toBeLessThan(14);
    // ≥ 14.0 y needs ceiling ≤ 97,847 KEEP/day at this pool — recorded in the spec register (M-01)
    expect(Math.floor(TOKEN.allocation.playPool / (14 * 365))).toBe(97_847);
  });
});

describe('KEEP mining — aborted epoch, purchases, late claims (M-12, M-18)', () => {
  it('aborted epoch replayed with retries releases each reservation exactly once and pays nothing', () => {
    const rng = mulberry32(3);
    for (let c = 0; c < CASES; c++) {
      const a = newIngotAccount();
      refineIngots(a, { shardsAvailable: 100_000, requestedIngots: int(rng, 1, 40), tier: 4, workshopLevel: 1 });
      const committed = commitIngots(a, int(rng, 1, 40));
      const heldBefore = a.held;
      const s = settleMiningDay({ budgetKeep: P.ceilingKeepPerDay, floorUnits: P.floorMinUnits, entries: [{ id: 'a', capacityUnits: 24, committedIngots: committed }], aborted: true });
      expect(s.awardedBase).toBe(0n);
      expect(s.unallocatedBase).toBe(keepToBase(P.ceilingKeepPerDay));
      expect(s.entries[0]!.returnedIngots).toBe(committed);
      const retries = int(rng, 1, 5);
      let released = 0;
      for (let r = 0; r < retries; r++) released += abortEpochOnAccount(a, 'd1');
      expect(released).toBe(committed);
      expect(a.reserved).toBe(0);
      expect(a.held).toBe(heldBefore + committed);
      // a settlement arriving after the abort for the same day is a no-op
      applySettlementToAccount(a, 'd1', 5);
      expect(a.consumed).toBe(0);
      expect(ingotBalanceOk(a)).toBe(true);
    }
  });

  it('a zero-score wallet with purchased ingots earns 0 — purchases fill capacity, never create it', () => {
    const rng = mulberry32(4);
    for (let c = 0; c < CASES; c++) {
      const seller = newIngotAccount(); refineIngots(seller, { shardsAvailable: 10_000, requestedIngots: 100, tier: 4, workshopLevel: 1 });
      const buyer = newIngotAccount(); transferIngots(seller, buyer, int(rng, 1, 100));
      const tier = int(rng, 0, 4) as TierIndex;
      const cap = capacityUnits(tier, 0, consistencyFactor(14));
      expect(cap.units).toBe(0);
      const committed = commitIngots(buyer, buyer.held);
      const s = settleMiningDay({ budgetKeep: P.ceilingKeepPerDay, floorUnits: P.floorMinUnits, entries: [{ id: 'b', capacityUnits: cap.units, committedIngots: committed }] });
      expect(s.entries[0]!.awardBase).toBe(0n);
      expect(s.entries[0]!.returnedIngots).toBe(committed);
    }
  });

  it('a late claim of day d−5 leaves U, B_d and F_d unchanged (claims draw already-encumbered vault balance)', () => {
    const rng = mulberry32(5);
    for (let c = 0; c < CASES; c++) {
      const vault: Vault = { balanceBase: keepToBase(int(rng, 100_000, 3_000_000)), encumberedBase: 0n };
      const history = Array.from({ length: 7 }, () => int(rng, 0, 40_000));
      const entries = randomEntries(rng, int(rng, 1, 200));
      const old = settleMiningDay({ budgetKeep: budgetForDay(unencumberedKeep(vault)), floorUnits: floorForDay(history), entries });
      recordAwards(vault, old.awardedBase);
      const bBefore = budgetForDay(unencumberedKeep(vault)); const fBefore = floorForDay(history);
      const today = settleMiningDay({ budgetKeep: bBefore, floorUnits: fBefore, entries });
      // now the late claim lands
      claimFromVault(vault, old.awardedBase);
      const bAfter = budgetForDay(unencumberedKeep(vault)); const fAfter = floorForDay(history);
      const again = settleMiningDay({ budgetKeep: bAfter, floorUnits: fAfter, entries });
      expect(bAfter).toBe(bBefore); expect(fAfter).toBe(fBefore);
      expect(again.totalUnits).toBe(today.totalUnits);
      expect(again.awardedBase).toBe(today.awardedBase);
    }
  });
});

describe('KEEP mining — award monotonicity and ingot conservation', () => {
  it('award is monotone non-decreasing in own units and non-increasing in U (others\' units)', () => {
    const rng = mulberry32(6);
    for (let c = 0; c < CASES; c++) {
      const budgetKeep = int(rng, 1, P.ceilingKeepPerDay); const floorUnits = int(rng, 1, 5_000);
      const others = randomEntries(rng, int(rng, 0, 100));
      const mine = int(rng, 0, T4 - 1);
      const run = (u: number, extra: SettlementEntry[]): bigint => settleMiningDay({ budgetKeep, floorUnits, entries: [{ id: 'me', capacityUnits: T4, committedIngots: u }, ...others, ...extra] }).entries[0]!.awardBase;
      expect(run(mine + 1, []) >= run(mine, [])).toBe(true);
      expect(run(mine, [{ id: 'x', capacityUnits: T4, committedIngots: int(rng, 1, T4) }]) <= run(mine, [])).toBe(true);
    }
  });

  it('ingot conservation: refined + purchased = held + listed + reserved + inProgress + consumed + sold across transfer, settle and abort', () => {
    const rng = mulberry32(7);
    for (let c = 0; c < CASES; c++) {
      const a = newIngotAccount(); const b = newIngotAccount();
      const tier = int(rng, 1, 4) as TierIndex;
      const r = refineIngots(a, { shardsAvailable: int(rng, 0, 20_000), requestedIngots: int(rng, 0, 200), tier, workshopLevel: int(rng, 1, 20) });
      expect(r.ingots).toBeLessThanOrEqual(P.refineCapMultiplier * P.capacityByTier[tier]);
      expect(r.shardsSunk).toBe(r.ingots * P.shardsPerIngot);
      listIngots(a, int(rng, 0, 10)); transferIngots(a, b, int(rng, 0, 10));
      const ca = commitIngots(a, int(rng, 0, 30)); const cb = commitIngots(b, int(rng, 0, 30));
      if (rng() < 0.5) { applySettlementToAccount(a, 'd', int(rng, 0, ca)); applySettlementToAccount(a, 'd', 99); }
      else { abortEpochOnAccount(a, 'd'); abortEpochOnAccount(a, 'd'); }
      applySettlementToAccount(b, 'd', int(rng, 0, cb));
      expect(ingotBalanceOk(a)).toBe(true); expect(ingotBalanceOk(b)).toBe(true);
      expect(a.refined + b.refined).toBe(a.held + a.listed + a.reserved + a.consumed + b.held + b.listed + b.reserved + b.consumed);
      // holding cap counts held + listed + reserved + in-progress jobs (amended §6.1)
      const c2 = newIngotAccount(); c2.inProgress = P.holdingCapMultiplier * P.capacityByTier[tier];
      expect(refineIngots(c2, { shardsAvailable: 1e6, requestedIngots: 10, tier, workshopLevel: 1 }).refinedBy).toBe('holding_cap');
      expect(refineIngots(c2, { shardsAvailable: 1e6, requestedIngots: 10, tier, workshopLevel: 1 }).ingots).toBe(0);
    }
  });
});

describe('KEEP mining — amended scoring rules (plan §6.1)', () => {
  it('KEEP-market settlements never change the score; only irreversible on-chain actions count (≤2)', () => {
    const rng = mulberry32(8);
    for (let c = 0; c < CASES; c++) {
      const sig: DaySignals = { ...baseSignals, mineCollected: rng() < 0.5, pveStarBattles: int(rng, 0, 3), keepLevel: int(rng, 1, 20) };
      expect(dailyScore({ ...sig, keepMarketSettlements: int(rng, 1, 50) }).scoreBps).toBe(dailyScore(sig).scoreBps);
      const burn = dailyScore({ ...sig, vehicleBurnsNonPurchased: 1 });
      expect(burn.components.chain).toBe(BPS / 2);
      expect(dailyScore({ ...sig, vehicleBurnsNonPurchased: 5, solSettlementsAboveFloorWithRoyalty: 5 }).components.chain).toBe(BPS);
    }
  });

  it('only the first three auto-match PvP raids score (1 meaningful +1 win); named-target raids are not an input; gameplay saturates at 4 points', () => {
    const won = { meaningful: true, won: true };
    const three = dailyScore({ ...baseSignals, autoMatchPvp: [won, won, won] });
    const six = dailyScore({ ...baseSignals, autoMatchPvp: [won, won, won, won, won, won] });
    expect(six.points.gameplay).toBe(three.points.gameplay);
    expect(three.points.gameplay).toBe(6);
    expect(three.components.gameplay).toBe(BPS);
    const retreat = dailyScore({ ...baseSignals, autoMatchPvp: [{ meaningful: false, won: false }, won, won] });
    expect(retreat.points.gameplay).toBe(4); // the retreat scores 0 but the design's "burns a slot" was dropped only for retreats at the API layer; here it occupies a slot — see spec §2
    expect(dailyScore({ ...baseSignals, pveStarBattles: 2, buildStarted: true, trainingQueued: true }).components.gameplay).toBe(BPS);
  });

  it('consistency: k(10..14) identical, 3 days/week ≈ 0.8, day-1 = 0.55; deed nomination needs ownership at open AND settlement', () => {
    for (let a = 10; a <= 14; a++) expect(consistencyFactor(a)).toBe(BPS);
    expect(consistencyFactor(6)).toBe(8_000);
    expect(consistencyFactor(1)).toBe(5_500);
    expect(tierOf({ goldForgeLevel: 16, hasDeed: true, sgtLinked: false, ownedAtOpenAndSettlement: false })).toBeNull();
    expect(tierOf({ goldForgeLevel: 16, hasDeed: true, sgtLinked: false, ownedAtOpenAndSettlement: true })).toBe(4);
    expect(tierOf({ goldForgeLevel: 1, hasDeed: false, sgtLinked: false, ownedAtOpenAndSettlement: true })).toBe(0);
    expect(tierOf({ goldForgeLevel: 1, hasDeed: false, sgtLinked: true, ownedAtOpenAndSettlement: true })).toBe(1);
    expect(tierOf({ goldForgeLevel: 0, hasDeed: true, sgtLinked: false, ownedAtOpenAndSettlement: true })).toBeNull();
  });

  it('drops are deed-gated with a tier minimum: T0 never rolls, a deed position needs ≥ the tier minimum', () => {
    expect(dropEligible(0, false, 2)).toBe(false);
    expect(dropEligible(1, false, 12)).toBe(false);
    expect(dropEligible(1, true, 3)).toBe(false);
    expect(dropEligible(1, true, 4)).toBe(true);
    expect(dropEligible(4, true, 10)).toBe(true);
  });
});

describe('KEEP mining — adversary properties (plan §6.1 exploits lens)', () => {
  it('deed-rotation adversary: any rotation schedule of one T4 deed through N wallets yields ≤ one wallet\'s T4 capacity per day', () => {
    const rng = mulberry32(9);
    for (let c = 0; c < CASES; c++) {
      const n = int(rng, 2, 20);
      const holderAtOpen = int(rng, 0, n - 1);
      const transfers = int(rng, 0, 3); // intraday hops
      const holderAtSettle = transfers === 0 ? holderAtOpen : int(rng, 0, n - 1);
      let total = 0;
      for (let w = 0; w < n; w++) {
        const owned = w === holderAtOpen && w === holderAtSettle && transfers === 0;
        const tier = tierOf({ goldForgeLevel: 20, hasDeed: w === holderAtSettle, sgtLinked: false, ownedAtOpenAndSettlement: owned });
        total += capacityUnits(tier, BPS, BPS).units;
      }
      expect(total).toBeLessThanOrEqual(T4);
    }
  });

  it('undetected sybil ring (10 free T0 wallets, no market credit, bot S ≤ 0.70) per controller ≤ 1× one honest deed L10 wallet', () => {
    const rng = mulberry32(10);
    const honest = capacityUnits(2, 7_600, BPS).units; // consistent deed L10 → T2
    for (let c = 0; c < CASES; c++) {
      const ringSize = 10; let ring = 0;
      for (let w = 0; w < ringSize; w++) ring += capacityUnits(0, int(rng, 3_000, 7_000), BPS).units;
      expect(ring).toBeLessThanOrEqual(honest);
    }
    // the bound is a property of T0=2 with floor(): at T0=3 a full-effort bot ring (S 0.70) exceeds one honest wallet
    const p3: KeepMiningParams = { ...P, capacityByTier: [3, 12, 16, 20, 24] };
    expect(10 * capacityUnits(0, 7_000, BPS, p3).units).toBeGreaterThan(honest);
  });
});

describe('KEEP mining — cohort simulation (deterministic, per-controller metrics)', () => {
  it('is deterministic for a seed, conserves budget every day, and evaluates the acceptance thresholds', () => {
    const a = simulateKeepMining(defaultCohorts(), 60, P, 42, 200);
    const b = simulateKeepMining(defaultCohorts(), 60, P, 42, 200);
    expect(JSON.stringify(a.cohorts)).toBe(JSON.stringify(b.cohorts));
    for (const d of a.days_) expect(d.awardedKeep + d.unallocatedKeep).toBeLessThanOrEqual(d.budgetKeep);
    const th = evaluateThresholds(a);
    expect(th.length).toBeGreaterThanOrEqual(13);
    const byId = Object.fromEntries(th.map((t) => [t.id, t]));
    expect(byId['A7']!.pass).toBe(true);   // deed-rotation ≤ T4
    expect(byId['A11']!.pass).toBe(true);  // drop farming = 0
    expect(byId['A12']!.pass).toBe(true);  // wash trading = 0
    expect(byId['A2']!.pass).toBe(true);   // one miss identical
    expect(a.cohorts.find((c) => c.name.startsWith('ADVERSARY wash'))!.exploitGainIfMarketCreditKeep).toBeGreaterThan(0);
    // the sim reports the legacy loot exposure the ingot design removes (L20: 50% of 200,000)
    expect(a.cohorts.find((c) => c.name.startsWith('legacy L20'))!.legacyLootExposureRemovedPerDay).toBe(100_000);
    expect(Number(KEEP_BASE_UNITS)).toBe(1e9);
  });
});
