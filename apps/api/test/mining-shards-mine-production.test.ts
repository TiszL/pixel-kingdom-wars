import { describe, expect, it } from 'vitest';
import { MINE_DAY_MS, projectMineFill } from '../src/game/baseMining';
import { partitionMineWholeUnits } from '../src/mining/shardsTaxMinePartition';
import { mineUnitCompletion } from '../src/mining/shardsTaxMineProduction';
const day = BigInt(MINE_DAY_MS), at = (n: number) => new Date(n);
describe('earned physical Mine fractions', () => {
  it('keeps exact old projection shape when no fractional clock was settled', () => {
    expect(projectMineFill(0n, at(0), 3, at(MINE_DAY_MS / 2))).toEqual({ accrued: 1n, capacity: 3n, fullAtMs: day });
  });
  it('agrees with one uninterrupted numerator after repeated nonintegral settlements', () => {
    const quota = 137, times = [11, 127, 911, 12345, 13001, 400000];
    let previous = 0n, remainder = 0n, anchor = 0;
    for (const now of times) {
      const p = projectMineFill(previous, at(anchor), quota, at(now), remainder);
      expect(p.accrued * day + p.remainder!).toBe(BigInt(quota * now));
      previous = p.accrued; remainder = p.remainder!; anchor = now;
    }
  });
  it('retains a previously earned fraction while a newly observed live quota changes', () => {
    const first = projectMineFill(0n, at(0), 137, at(700000), 0n);
    const second = projectMineFill(first.accrued, at(700000), 211, at(1000000), first.remainder);
    expect(second.accrued * day + second.remainder!).toBe(137n * 700000n + 211n * 300000n);
    expect(second.accrued * day + second.remainder!).not.toBe(211n * 1000000n);
  });
  it('does not destroy earned fraction under a zero live quota or empty tap', () => {
    const remainder = day - 1n;
    expect(projectMineFill(0n, at(100), 0, at(999999), remainder)).toEqual({ accrued: 0n, capacity: 0n, fullAtMs: null, remainder });
    expect(projectMineFill(0n, at(100), 7, at(100), remainder).remainder).toBe(remainder);
  });
  it('discards only unearnable fraction once physical storage reaches its cap', () => {
    expect(projectMineFill(2n, at(0), 3, at(Number(day)), day - 1n)).toMatchObject({ accrued: 3n, remainder: 0n });
    expect(projectMineFill(5n, at(0), 3, at(0), day - 1n)).toMatchObject({ accrued: 5n, remainder: 0n });
  });
  it('refuses a regressing tracked clock and a numerator that hides a whole unit', () => {
    expect(() => projectMineFill(0n, at(2), 3, at(1), 0n)).toThrow('clock regression');
    expect(() => projectMineFill(0n, at(0), 3, at(1), day)).toThrow('fraction');
    expect(() => mineUnitCompletion(0n, 1n, day, 1n, -1n)).toThrow('clock');
  });
  it('agrees with enumerated first completion and half-open policy/term boundaries', () => {
    for (let q = 1n; q <= 7n; q++) for (let r = 0n; r < 11n; r++) for (let cut = 0n; cut <= 14n; cut++) {
      const parts = partitionMineWholeUnits({ anchorMs: 0n, quota: q, dayMs: 11n, gross: q,
        remainder: r, legacyBeforeMs: cut, term: { startsAtMs: 5n, endsAtMs: 10n } });
      const actual = parts.flatMap(p => Array.from({ length: Number(p.gross) }, (_, i) => ({
        unit: p.firstUnit + BigInt(i), legacy: p.legacy, covered: p.covered,
      })));
      const expected = [];
      for (let u = 1n; u <= q; u++) {
        let ms = 0n; while ((r + q * ms) / 11n < u) ms++;
        expect(mineUnitCompletion(0n, q, 11n, u, r)).toBe(ms);
        const legacy = ms < cut; expected.push({ unit: u, legacy, covered: !legacy && ms >= 5n && ms < 10n });
      }
      expect(actual).toEqual(expected);
    }
  });
});
