import { describe, expect, it } from 'vitest';
import { archivedBuildingHealth } from '../src/game/raidReplayHealth';
import { nativeBuildingHealth } from '../src/native/health';
import { NativePresentationSchema, NativePresentationStateSchema } from '../src/native/contracts';

describe('native authoritative building health', () => {
  it.each([14, 15, 16, 17, 18])('uses persisted maxima in SIM%s even when final health is zero', (version) => {
    expect(nativeBuildingHealth(version, { buildings: [
      { id: 'wall', hp: 0, maxHp: 1777, destroyed: true },
      { id: 'trap', hp: 0, maxHp: 0, destroyed: false },
    ] })).toEqual([{ id: 'wall', initialHp: 1777, maxHp: 1777 }, { id: 'trap', initialHp: 0, maxHp: 0 }]);
  });
  it('leaves unsupported archives or absent historic outcomes unknown instead of using current stats', () => {
    for (const version of [1, 13, 19]) expect(nativeBuildingHealth(version, { buildings: [{ id: 'wall', maxHp: 100 }] })).toBeUndefined();
    expect(nativeBuildingHealth(14, null)).toBeUndefined();
    expect(nativeBuildingHealth(14, {})).toBeUndefined();
    expect(archivedBuildingHealth({ simVersion: 14 })).toBeUndefined();
    expect(archivedBuildingHealth({ simVersion: 13, buildingHealth: [{ id: 'wall', initialHp: 1, maxHp: 1 }] })).toBeUndefined();
  });
  it('refuses ambiguous or malformed health instead of silently guessing', () => {
    for (const maxHp of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100'])
      expect(() => nativeBuildingHealth(14, { buildings: [{ id: 'wall', maxHp }] })).toThrow();
    expect(() => nativeBuildingHealth(14, { buildings: [{ id: 'wall', maxHp: 1 }, { id: 'wall', maxHp: 2 }] })).toThrow('Duplicate');
  });
  it('keeps both transport contracts compatible when optional display health is absent', () => {
    for (const schema of [NativePresentationSchema.shape.buildingHealth, NativePresentationStateSchema.shape.buildingHealth]) {
      expect(schema.parse(undefined)).toBeUndefined();
      expect(schema.parse([{ id: 'wall', initialHp: 100, maxHp: 100 }])).toEqual([{ id: 'wall', initialHp: 100, maxHp: 100 }]);
    }
  });
});
