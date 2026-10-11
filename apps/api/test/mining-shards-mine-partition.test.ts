import { describe, expect, it } from 'vitest';
import { partitionMineWholeUnits } from '../src/mining/shardsTaxMinePartition';

describe('physical Mine whole-unit earning times', () => {
  it('assigns a unit completed exactly at the half-open term end to the unresolved next term', () => {
    expect(partitionMineWholeUnits({ anchorMs: 0n, quota: 3n, dayMs: 12n, gross: 3n,
      term: { startsAtMs: 0n, endsAtMs: 8n } })).toEqual([
      { firstUnit: 1n, lastUnit: 1n, firstAtMs: 4n, lastAtMs: 4n, gross: 1n, covered: true },
      { firstUnit: 2n, lastUnit: 3n, firstAtMs: 8n, lastAtMs: 12n, gross: 2n, covered: false },
    ]);
  });
  it('keeps original fractional time through repeated held views and does not round early', () => {
    const input = { anchorMs: 10n, quota: 3n, dayMs: 10n, gross: 3n, term: null };
    expect(partitionMineWholeUnits(input)).toEqual([
      { firstUnit: 1n, lastUnit: 3n, firstAtMs: 14n, lastAtMs: 20n, gross: 3n, covered: false },
    ]);
    expect(partitionMineWholeUnits(input)).toEqual(partitionMineWholeUnits(input));
  });
  it('partitions a capped huge quantity in at most three ranges, preserving every original unit', () => {
    const parts = partitionMineWholeUnits({ anchorMs: 0n, quota: 1_000_000n,
      dayMs: 86_400_000n, gross: 900_000n, term: { startsAtMs: 1_000n, endsAtMs: 2_000n } });
    expect(parts).toHaveLength(3);
    expect(parts.reduce((sum, part) => sum + part.gross, 0n)).toBe(900_000n);
    expect(parts[1]!.firstAtMs).toBeGreaterThanOrEqual(1_000n);
    expect(parts[1]!.lastAtMs).toBeLessThan(2_000n);
  });
});


describe('Mine policy boundary preserves original whole-unit production', () => {
  it('keeps the boundary-completing unit taxable with its original ordinal', () => {
    expect(partitionMineWholeUnits({ anchorMs: 0n, quota: 3n, dayMs: 12n, gross: 3n,
      legacyBeforeMs: 8n, term: { startsAtMs: 8n, endsAtMs: 12n } })).toEqual([
      { firstUnit: 1n, lastUnit: 1n, firstAtMs: 4n, lastAtMs: 4n, gross: 1n, covered: false, legacy: true },
      { firstUnit: 2n, lastUnit: 2n, firstAtMs: 8n, lastAtMs: 8n, gross: 1n, covered: true, legacy: false },
      { firstUnit: 3n, lastUnit: 3n, firstAtMs: 12n, lastAtMs: 12n, gross: 1n, covered: false, legacy: false },
    ]);
  });
  it('retains fractional accrual when policy starts between completed units', () => {
    expect(partitionMineWholeUnits({ anchorMs: 10n, quota: 3n, dayMs: 10n, gross: 3n,
      legacyBeforeMs: 16n, term: null })).toEqual([
      { firstUnit: 1n, lastUnit: 1n, firstAtMs: 14n, lastAtMs: 14n, gross: 1n, covered: false, legacy: true },
      { firstUnit: 2n, lastUnit: 3n, firstAtMs: 17n, lastAtMs: 20n, gross: 2n, covered: false, legacy: false },
    ]);
  });
  it('does not require a term to exempt genuine pre-policy production', () => {
    const parts = partitionMineWholeUnits({ anchorMs: 0n, quota: 3n, dayMs: 12n,
      gross: 2n, legacyBeforeMs: 9n, term: null });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ gross: 2n, firstUnit: 1n, lastUnit: 2n, legacy: true, covered: false });
  });
  it('never exempts production beginning at or after policy activation', () => {
    const parts = partitionMineWholeUnits({ anchorMs: 8n, quota: 3n, dayMs: 12n,
      gross: 3n, legacyBeforeMs: 8n, term: null });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ gross: 3n, firstAtMs: 12n, lastAtMs: 20n, legacy: false, covered: false });
  });
  it('preserves capped gross and never assigns a legacy unit to the tax pool', () => {
    const parts = partitionMineWholeUnits({ anchorMs: 0n, quota: 10n, dayMs: 12n,
      gross: 5n, legacyBeforeMs: 4n, term: { startsAtMs: 0n, endsAtMs: 5n } });
    expect(parts.reduce((sum, part) => sum + part.gross, 0n)).toBe(5n);
    expect(parts.map(part => [part.firstUnit, part.lastUnit, part.legacy, part.covered]))
      .toEqual([[1n, 2n, true, false], [3n, 3n, false, true], [4n, 5n, false, false]]);
  });
  it('agrees with integral-time enumeration across fractional rates and policy/term boundaries', () => {
    for (let quota = 1; quota <= 7; quota++) for (let boundary = 0; boundary <= 14; boundary++) {
      const parts = partitionMineWholeUnits({ anchorMs: 0n, quota: BigInt(quota), dayMs: 11n,
        gross: BigInt(quota), legacyBeforeMs: BigInt(boundary), term: { startsAtMs: 5n, endsAtMs: 10n } });
      const actual = parts.flatMap(part => Array.from({ length: Number(part.gross) }, (_, i) =>
        ({ unit: Number(part.firstUnit) + i, legacy: part.legacy, covered: part.covered })));
      const expected = [];
      for (let unit = 1; unit <= quota; unit++) {
        let completedAt = 0;
        while (Math.floor(completedAt * quota / 11) < unit) completedAt++;
        const legacy = completedAt < boundary;
        expected.push({ unit, legacy, covered: !legacy && completedAt >= 5 && completedAt < 10 });
      }
      expect(actual).toEqual(expected);
      expect(parts.length).toBeLessThanOrEqual(4);
    }
  });
});
