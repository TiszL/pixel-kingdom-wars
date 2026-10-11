import { describe, expect, it } from 'vitest';
import { CAPS, STRUCTURES, wallCapForKeepLevel } from '@shardkeep/shared';
import { fantasyAcceptanceWalls, fantasyFixtureId } from '../scripts/fantasy-acceptance-layout';
import { claimRect, insideClaim, overlaps } from '../src/game/footprints';

describe('local fantasy acceptance fixture geometry', () => {
  const buildings = [{ tx: 14, ty: 14, fw: 4, fh: 4 }, { tx: 24, ty: 16, fw: 1, fh: 1 },
    { tx: 24, ty: 20, fw: 2, fh: 1 }, { tx: 24, ty: 24, fw: 2, fh: 2 }];
  it('covers every level with exactly the legal dense cap and no hidden footprint overlaps', () => {
    for (const dense of [true, false]) {
      const walls = fantasyAcceptanceWalls(buildings, dense);
      expect(walls.length).toBeLessThanOrEqual(wallCapForKeepLevel(20));
      if (dense) {
        expect(walls).toHaveLength(250);
        expect(walls.some(w => w.tx < 0 || w.ty < 0)).toBe(true);
      }
      expect(new Set(walls.map(w => w.level)).size).toBe(STRUCTURES.wall.maxTier);
      expect(new Set(walls.map(w => `${w.tx},${w.ty}`)).size).toBe(walls.length);
      for (const wall of walls) {
        expect(wall.level).toBeGreaterThanOrEqual(1);
        expect(wall.level).toBeLessThanOrEqual(STRUCTURES.wall.maxTier);
        const rect = { ...wall, fw: 1, fh: 1 };
        expect(insideClaim(rect, CAPS.expansionsMax)).toBe(true);
        expect(buildings.some(b => overlaps(rect, b))).toBe(false);
      }
      expect(fantasyAcceptanceWalls(buildings, dense)).toEqual(walls);
    }
  });
  it('refuses invalid fixed scenery rather than seeding an untestable layout', () => {
    expect(() => fantasyAcceptanceWalls([...buildings, { tx: 14, ty: 14, fw: 1, fh: 1 }], true)).toThrow('overlap');
    const { min, max } = claimRect(CAPS.expansionsMax);
    for (const tx of [min - 1, max - 1]) {
      expect(() => fantasyAcceptanceWalls([{ tx, ty: 20, fw: 2, fh: 2 }], true)).toThrow('legal claim');
    }
  });
  it('keeps synthetic base, wall and grant identities stable across repeated setup', () => {
    const id = fantasyFixtureId('test-wallet', 'frostveil:wall:4:4');
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(fantasyFixtureId('test-wallet', 'frostveil:wall:4:4')).toBe(id);
    expect(fantasyFixtureId('test-wallet', 'elderwood:wall:4:4')).not.toBe(id);
  });
});
