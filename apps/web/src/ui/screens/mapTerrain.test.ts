/**
 * mapTerrain is the ported MAPS-handout terrain kit; the map screens trust it
 * blindly, so these tests pin WHY it works: the authored grids must keep the
 * handout's exact dimensions (the server's encounter positions target them),
 * tile choice must be deterministic (the map may never shimmer between
 * renders/sessions), and the water autotiler must pick edge frames from the
 * actual neighbours (a wrong frame reads as a torn coastline).
 */
import { CAMPAIGN } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  campaignTerrain, CAMPAIGN_ACTS, genTile, groundFrameAt, outsideDist, spriteAt,
  suppressTerrainOverlay, terrainTransformAt, TILE_VARIANTS, worldTerrain,
} from './mapTerrain';

describe('authored grids (verbatim from the handout)', () => {
  it('world is 12×20, campaign is 12×22, every row full width', () => {
    expect(worldTerrain.cols).toBe(12);
    expect(worldTerrain.rows).toBe(20);
    expect(campaignTerrain.cols).toBe(12);
    expect(campaignTerrain.rows).toBe(22);
    for (const t of [worldTerrain, campaignTerrain]) {
      for (const row of t.grid) expect(row.length).toBe(t.cols);
    }
  });

  it('derives ten complete ten-stage act bands from the shared campaign config', () => {
    // M23 a2: the act list must FOLLOW the shared CAMPAIGN scheme — a hardcoded
    // copy is exactly what let the old five-act list lie after a restructure.
    expect(CAMPAIGN_ACTS).toHaveLength(10);
    expect(CAMPAIGN_ACTS.map((a) => a.name)).toEqual([...CAMPAIGN.actNames]);
    for (let act = 1; act <= CAMPAIGN_ACTS.length; act++) {
      expect(CAMPAIGN_ACTS[act - 1]!.act).toBe(act);
      expect(CAMPAIGN_ACTS[act - 1]!.sub)
        .toBe(`STAGES ${(act - 1) * CAMPAIGN.stagesPerAct + 1}–${act * CAMPAIGN.stagesPerAct}`);
    }
    expect(CAMPAIGN_ACTS.at(-1)!.sub).toBe(`STAGES 91–${CAMPAIGN.totalStages}`);
  });
});

describe('deterministic tiles', () => {
  it('same coordinate always yields the same frame, inside and beyond the grid', () => {
    for (const [c, r] of [[0, 0], [5, 9], [-7, 3], [40, -12]] as const) {
      expect(spriteAt(worldTerrain, c, r)).toBe(spriteAt(worldTerrain, c, r));
      expect(spriteAt(campaignTerrain, c, r)).toBe(spriteAt(campaignTerrain, c, r));
    }
  });

  it('variant index stays within 1..n for negative frontier coordinates too', () => {
    for (let c = -30; c <= 30; c += 3) {
      for (let r = -30; r <= 30; r += 3) {
        const frame = spriteAt(worldTerrain, c, r);
        const m = /^map_(grass|forest|pine|hill)_(\d)$/.exec(frame);
        if (m) {
          const letter = { grass: 'g', forest: 'F', pine: 'P', hill: 'H' }[m[1]!]!;
          const idx = Number(m[2]);
          expect(idx).toBeGreaterThanOrEqual(1);
          expect(idx).toBeLessThanOrEqual(TILE_VARIANTS[letter]!);
        }
      }
    }
  });

  it('outsideDist is 0 inside the grid and grows with distance', () => {
    expect(outsideDist(worldTerrain, 5, 5)).toBe(0);
    expect(outsideDist(worldTerrain, -3, 5)).toBe(3);
    expect(outsideDist(worldTerrain, 5, 21)).toBe(2);
    expect(outsideDist(worldTerrain, 14, 22)).toBe(3);
  });

  it('varies only seam-locked one-master ground without changing tile identity', () => {
    // WHY: ash/sand/snow otherwise expose the same internal motif every 32 px;
    // landmarks and shoreline topology must never be rotated as a side effect.
    for (const frame of ['map_ash', 'map_snow']) {
      const values = new Set<number>();
      for (let c = -8; c <= 8; c++) {
        for (let r = -8; r <= 8; r++) {
          const value = terrainTransformAt(frame, c, r);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(8);
          expect(value).toBe(terrainTransformAt(frame, c, r));
          values.add(value);
        }
      }
      expect(values).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    }
    expect(terrainTransformAt('map_sand', 3, 4)).toBe(0);
    expect(terrainTransformAt('map_water_n', 3, 4)).toBe(0);
    expect(terrainTransformAt('map_forest_1', 3, 4)).toBe(0);
  });

  it('paints material below silhouettes instead of their baked green squares', () => {
    // WHY: the same mountain art appears in the northern ashlands and the green
    // valley. A packed grass background made one of those contexts wrong.
    expect(spriteAt(campaignTerrain, 4, 0)).toBe('map_mtn_peak');
    expect(groundFrameAt(campaignTerrain, 4, 0)).toBe('map_ash');
    expect(spriteAt(campaignTerrain, 0, 4)).toBe('map_mtn_low');
    expect(groundFrameAt(campaignTerrain, 0, 4)).toMatch(/^map_grass_[1-4]$/);

    // The old one-cell beach staircase is presentation-only; the connected
    // shoreline remains the coast and the yellow square overlay is suppressed.
    expect(spriteAt(campaignTerrain, 1, 11)).toBe('map_sand');
    expect(groundFrameAt(campaignTerrain, 1, 11)).toMatch(/^map_grass_[1-4]$/);
    expect(suppressTerrainOverlay('map_sand')).toBe(true);
    expect(suppressTerrainOverlay('map_forest_1')).toBe(false);
  });
});

describe('water-edge autotiling (campaign coast)', () => {
  // Campaign grid row 11 is '~SggFFggggHg' — (0,11) is the first sea tile:
  // land above (row 10 'g…') and to the east ('S'), sea south and west
  // (west is off-grid where coastFrontier returns open sea for c<0).
  it('picks the NE corner frame when land lies north and east', () => {
    expect(spriteAt(campaignTerrain, 0, 11)).toBe('map_water_ne');
  });

  it('picks open water when surrounded by sea on all four sides', () => {
    // (0,20) — row 20 '~~~~~~SggFgg', with sea at (0,19), (0,21), (1,20), (-1,20).
    expect(spriteAt(campaignTerrain, 0, 20)).toBe('map_water_c');
  });

  it('honours the land override: a marker tile never renders as sea and the shore re-edges', () => {
    const land = new Set(['0,20']);
    expect(genTile(campaignTerrain, 0, 20, land)).toBe('g');
    expect(spriteAt(campaignTerrain, 0, 20, land)).toMatch(/^map_grass_\d$/);
    // The sea tile just south now has land to its north → an N-edge shore frame.
    expect(spriteAt(campaignTerrain, 0, 21, land)).toBe('map_water_n');
  });
});
