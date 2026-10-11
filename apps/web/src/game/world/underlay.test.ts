import { describe, expect, it } from 'vitest';
import { BASE_CAMERA } from '@shardkeep/shared';
import { CURRENT_BASE_VISUAL, DEFAULT_BASE_VISUAL, REALM_IDS } from '@shardkeep/shared/baseVisual';
import { claimPerimeter, claimPerimeterDrawn, skirtTint } from './underlay';

const T = 64;
const style = {
  dashMinTiles: BASE_CAMERA.claimPerimeterDashMinTiles,
  dashJitterTiles: BASE_CAMERA.claimPerimeterDashJitterTiles,
  gapMinTiles: BASE_CAMERA.claimPerimeterGapMinTiles,
  gapJitterTiles: BASE_CAMERA.claimPerimeterGapJitterTiles,
  wobbleTiles: BASE_CAMERA.claimPerimeterWobbleTiles,
  stoneOffsetTiles: BASE_CAMERA.claimPerimeterStoneOffsetTiles,
};

describe('claimPerimeter', () => {
  it('draws no perimeter stroke or stones on revision 5 because the terrain ring is the boundary; revisions ≤4 keep them', () => {
    // REALM-KIT-PLAN §3: the realm kit generates a corner-Wang edge ring from
    // the same server claim, so a dashed stroke plus stones on top would draw
    // the boundary twice. Paintings (rev ≤4, and the legacy v1/v2 rasters)
    // carry no claim and still need the stroke to show what is owned.
    for (const realmId of REALM_IDS) {
      expect(claimPerimeterDrawn({ version: 1, artVersion: 2, realmId, groundRevision: 5 })).toBe(false);
      for (const groundRevision of [1, 2, 3, 4] as const) {
        if (groundRevision === 1 && realmId !== 'crownlands') continue;
        expect(claimPerimeterDrawn({ version: 1, artVersion: 2, realmId, groundRevision })).toBe(true);
      }
      expect(claimPerimeterDrawn({ ...DEFAULT_BASE_VISUAL, realmId })).toBe(true);
      // Since the owner flip (2026-09-26, D-184) the current context IS the kit: its terrain
      // ring is the boundary, so a stroke on top would draw the claim twice.
      expect(claimPerimeterDrawn({ ...CURRENT_BASE_VISUAL, realmId })).toBe(false);
    }
    // An absent or unknown context resolves to the painted default and keeps the stroke.
    expect(claimPerimeterDrawn(undefined)).toBe(true);
    expect(claimPerimeterDrawn({ version: 1, artVersion: 2, realmId: 'crownlands', groundRevision: 9 })).toBe(true);
  });

  it('marks all four authoritative edges with broken strokes and no area fill for the painted revisions', () => {
    const a = claimPerimeter({ min: 8, max: 22 }, T, style);
    const b = claimPerimeter({ min: 8, max: 22 }, T, style);
    expect(a).toEqual(b);
    expect(a.segments.length).toBeGreaterThan(20);
    expect(a.stones).toHaveLength(8);
    const lo = 8 * T;
    const hi = 22 * T;
    const tolerance = BASE_CAMERA.claimPerimeterWobbleTiles * T + 0.001;
    expect(a.segments.some((s) => Math.abs(s.y1 - lo) <= tolerance)).toBe(true);
    expect(a.segments.some((s) => Math.abs(s.y1 - hi) <= tolerance)).toBe(true);
    expect(a.segments.some((s) => Math.abs(s.x1 - lo) <= tolerance)).toBe(true);
    expect(a.segments.some((s) => Math.abs(s.x1 - hi) <= tolerance)).toBe(true);
  });

  it('re-derives from an expanded server claim rather than a default plot', () => {
    const small = claimPerimeter({ min: 8, max: 22 }, T, style);
    const expanded = claimPerimeter({ min: 4, max: 26 }, T, style);
    expect(expanded).not.toEqual(small);
    expect(Math.min(...expanded.segments.flatMap((s) => [s.x1, s.x2])))
      .toBeLessThan(Math.min(...small.segments.flatMap((s) => [s.x1, s.x2])));
    expect(Math.max(...expanded.segments.flatMap((s) => [s.x1, s.x2])))
      .toBeGreaterThan(Math.max(...small.segments.flatMap((s) => [s.x1, s.x2])));
  });
});


it('preserves historical skirt colors while distinguishing current realm materials', () => {
  for (const realmId of REALM_IDS) {
    expect(skirtTint('dec_pine_1', { ...DEFAULT_BASE_VISUAL, realmId })).toBe(0xffffff);
    expect(skirtTint('dec_rock_s', { ...DEFAULT_BASE_VISUAL, realmId })).toBe(0xffffff);
  }
  const frost = { ...CURRENT_BASE_VISUAL, realmId: 'frostveil' };
  expect(skirtTint('dec_rock_s', frost)).not.toBe(skirtTint('dec_pine_1', frost));
  expect(skirtTint('dec_rock_s', frost))
    .not.toBe(skirtTint('dec_rock_s', { ...CURRENT_BASE_VISUAL, realmId: 'cinderfall' }));
  expect(skirtTint('dec_pine_1', CURRENT_BASE_VISUAL)).toBe(0xffffff);
});
