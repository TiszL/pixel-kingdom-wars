import { describe, expect, it } from 'vitest';
import { BASE_GROUND_WORLD_GEOMETRY } from './constants';
import { REALM_IDS } from './baseVisual';
import { GROUND_ENVIRONMENT_REVISION_2, groundEnvironmentFeatures } from './groundEnvironment';

describe('immutable realm environment seats', () => {
  it('keeps scenery accents outside the complete building frame with finite unique source seats', () => {
    const { sourceSize, features } = GROUND_ENVIRONMENT_REVISION_2;
    expect(Object.keys(features)).toEqual(REALM_IDS);
    const { worldOriginTiles, worldTiles, plotTiles } = BASE_GROUND_WORLD_GEOMETRY;
    const lo = -worldOriginTiles / worldTiles * sourceSize, hi = (plotTiles - worldOriginTiles) / worldTiles * sourceSize;
    for (const realm of REALM_IDS) {
      const points = features[realm];
      expect(points.length).toBeGreaterThan(0);
      expect(new Set(points.map(p => p.seed)).size).toBe(points.length);
      expect(new Set(points.map(p => `${p.x}:${p.y}`)).size).toBe(points.length);
      for (const p of points) {
        expect([p.x, p.y].every(n => Number.isSafeInteger(n) && n >= 0 && n < sourceSize)).toBe(true);
        expect([p.width, p.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= sourceSize)).toBe(true);
        expect(p.x < lo || p.y < lo || p.x >= hi || p.y >= hi, `${realm}:${p.x},${p.y}`).toBe(true);
      }
    }
  });
  it('never changes the feature selection of archived art or an unknown future revision', () => {
    for (const realmId of REALM_IDS) {
      expect(groundEnvironmentFeatures({ version: 1, realmId, artVersion: 1 })).toBeUndefined();
      expect(groundEnvironmentFeatures({ version: 1, realmId, artVersion: 2 })).toBeUndefined();
      expect(groundEnvironmentFeatures({ version: 1, realmId, artVersion: 2, groundRevision: 1 })).toBeUndefined();
      expect(groundEnvironmentFeatures({ version: 1, realmId, artVersion: 2, groundRevision: 2 })).toEqual(GROUND_ENVIRONMENT_REVISION_2.features[realmId]);
    }
  });
});
