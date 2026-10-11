import { describe, expect, it } from 'vitest';
import { validatedBasketCount, validatedSmeltCommand, normalizeSpendArmedAt } from './GoldForgeInput';

describe('Gold Forge web-only numeric boundary (Lantern83b67ada M3)', () => {
  it('rejects nonfinite fractional and out-of-range items before smeltPrimaryCommand can enable SMELT', () => {
    for (const items of [NaN, Infinity, -Infinity, 0.5, -1, 2_147_483_648, '1', null, undefined]) {
      const result = validatedSmeltCommand('CHOOSING', items);
      expect(result.state).toBe('DISABLED');
      expect(result.sub).toBeNull();
      expect(result.reason).toBe('Check the basket quantities.');
    }
    expect(validatedSmeltCommand('CHOOSING', 1).state).toBe('ENABLED');
    expect(validatedSmeltCommand('CHOOSING', 0).state).toBe('DISABLED');
    expect(validatedSmeltCommand('CHOOSING', 2_147_483_647).sub).toBe('2147483647 items');
  });

  it('rejects invalid chosen counts and total overflow instead of resetting or wrapping a valid basket', () => {
    for (const chosen of [NaN, Infinity, -Infinity, 1.5, -1, 2_147_483_648, '1', null, undefined]) {
      expect(validatedBasketCount([{ chosen: 4 }, { chosen }])).toBeNull();
    }
    expect(validatedBasketCount([{ chosen: 2_147_483_647 }, { chosen: 1 }])).toBeNull();
    expect(validatedBasketCount([{ chosen: 2_147_483_647 }])).toBe(2_147_483_647);
    expect(validatedBasketCount([{ chosen: 3 }, { chosen: 0 }, { chosen: 2 }])).toBe(5);
    expect(validatedBasketCount([])).toBe(0);
  });

  it('normalizes omitted arming time from the quote and refuses unsafe clock input', () => {
    expect(normalizeSpendArmedAt({ quotedAtMs: 1000 })).toBe(1000);
    expect(normalizeSpendArmedAt({ quotedAtMs: 1000, armedAtMs: 1200 })).toBe(1200);
    expect(normalizeSpendArmedAt({ quotedAtMs: 1200, armedAtMs: 1000 })).toBe(1200);
    for (const invalid of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeSpendArmedAt({ quotedAtMs: invalid })).toBeNull();
      expect(normalizeSpendArmedAt({ quotedAtMs: 1000, armedAtMs: invalid })).toBeNull();
    }
  });
});
