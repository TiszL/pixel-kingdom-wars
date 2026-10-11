import { describe, expect, it } from 'vitest';
import type { AttackRunEvent } from './types';
import { attackRunCycleStarts, attackRunSuffixFromTick, expandAttackRunLegacy } from './replay';

const run: AttackRunEvent = { t: 10, e: 'attackRun', id: 4, side: 'attacker',
  troop: 'bowman', targetKind: 'building', target: 'keep', ix: 1, iy: 2,
  mode: 'projectile', technique: 'arrow', cycleMs: 629, releaseOffsetMs: 429,
  cycleTicks: 7,
  releaseOffsetTicks: 5, impactOffsetsTicks: [14], cadenceTicks: 7, count: 3 };

describe('bounded attack-run replay codec', () => {
  it('expands repeated cycle clocks without inventing 100ms damage ticks', () => {
    expect(attackRunCycleStarts(run)).toEqual([10, 17, 24]);
    expect(expandAttackRunLegacy(run).map((e) => e.t)).toEqual([10, 17, 24]);
  });

  it('rejects malformed or unbounded persisted counts', () => {
    expect(() => attackRunCycleStarts({ ...run, count: 0 })).toThrow(RangeError);
    expect(() => attackRunCycleStarts({ ...run, count: 901 })).toThrow(RangeError);
    expect(() => attackRunCycleStarts({ ...run, impactOffsetsTicks: [1, 2, 3, 4] })).toThrow(RangeError);
  });

  it('retains only not-yet-started cycles when a live timeline is replaced', () => {
    expect(attackRunSuffixFromTick(run, 10)).toEqual(run);
    expect(attackRunSuffixFromTick(run, 15)).toMatchObject({ t: 17, count: 2 });
    expect(attackRunSuffixFromTick(run, 17)).toMatchObject({ t: 17, count: 2 });
    expect(attackRunSuffixFromTick(run, 24)).toMatchObject({ t: 24, count: 1 });
    expect(attackRunSuffixFromTick(run, 25)).toBeNull();
    expect(attackRunSuffixFromTick(run, 13.5)).toMatchObject({ t: 17, count: 2 });
    expect(() => attackRunSuffixFromTick(run, Number.NaN)).toThrow(RangeError);
    expect(() => attackRunSuffixFromTick(run, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => attackRunSuffixFromTick(run, -0.5)).toThrow(RangeError);
  });
});
