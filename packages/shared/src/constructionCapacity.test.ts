import { describe, expect, it } from 'vitest';
import { advertisedBerthBuildCapacity, BUILD_COSTS, BUILD_COUNT_CAP_BY_KEEP, buildCountCapForKeep,
  effectiveBuildCountCapForKeep, PHASE_E_VEHICLES, STRUCTURES } from './constants';
describe('ordinary vehicle berth capacity', () => {
  it('preserves every frozen cap while paused and every non-berth cap when admitted', () => {
    for (const type of Object.keys(BUILD_COUNT_CAP_BY_KEEP)) for (let level = 1; level <= STRUCTURES.keep.maxLevel; level++) {
      expect(effectiveBuildCountCapForKeep(type, level, false)).toBe(buildCountCapForKeep(type, level));
      if (type !== 'berth') expect(effectiveBuildCountCapForKeep(type, level, true)).toBe(buildCountCapForKeep(type, level));
    }
    expect(effectiveBuildCountCapForKeep('mine', 5, true)).toBeUndefined();
  });
  it('adds all destinations only after the existing berth unlock with strict true', () => {
    for (let level = 1; level <= STRUCTURES.keep.maxLevel; level++) expect(effectiveBuildCountCapForKeep('berth', level, true))
      .toBe(level < BUILD_COSTS.berth.requiresKeepLevel ? buildCountCapForKeep('berth', level) : PHASE_E_VEHICLES.installationsPerBaseMax);
    expect(effectiveBuildCountCapForKeep('berth', 5, 'true' as never)).toBe(buildCountCapForKeep('berth', 5));
  });
  it('accepts only a versioned nonnegative integer server capacity', () => {
    expect(advertisedBerthBuildCapacity({ version: 1, berth: { max: 5 } })).toBe(5);
    expect(advertisedBerthBuildCapacity({ version: 1, berth: { max: 0 } })).toBe(0);
    for (const bad of [undefined, null, {}, { version: 2, berth: { max: 5 } }, { version: '1', berth: { max: 5 } },
      ...[-1, 1.5, '5', NaN, Infinity].map(max => ({ version: 1, berth: { max } }))]) expect(advertisedBerthBuildCapacity(bad)).toBeUndefined();
  });
});
