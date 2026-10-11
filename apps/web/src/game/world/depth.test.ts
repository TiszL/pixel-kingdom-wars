/**
 * The layer contract itself (owner 2026-08-30: "defences and building should
 * not be rendered top of troops, troops should be on layer above … walls should
 * overflow buildings not buildings, and troops should overflow other buildings
 * defences and walls").
 *
 * These cases are about ORDER BETWEEN LAYERS, which is what one shared screen-Y
 * axis could not express: they fail the moment someone reintroduces a bare
 * `setDepth(y)` for an actor or a building, or shrinks the band stride below the
 * field. The per-scene tests pin that each caller uses the right band; this file
 * pins that the bands mean what the owner asked for.
 */
import { describe, expect, it } from 'vitest';
import { GRID, WORLD_DEPTH } from '@shardkeep/shared';
import { actorDepth, buildingDepth, overlayDepth, wallDepth } from './depth';

const T = 64; // world px per tile
/** The largest Y any scene can produce: the battle field is the plot plus a
 *  deploy margin on every side, plus the decorative grass/tree skirt beyond it.
 *  Generous on purpose — the stride must survive a bigger map, not just today's. */
const MAX_FIELD_Y = (GRID.plotTiles + 40) * T;

describe('WORLD_DEPTH bands', () => {
  it('keeps the WORST case apart: the southernmost building under the northernmost troop', () => {
    // THE BUG. A building at the bottom of the plot has the largest bottom-edge
    // Y on the board; a troop at the very top has the smallest feet Y. On one
    // shared axis the building wins by ~2000 and swallows the troop. It must
    // now lose, by construction, at every Y on the board.
    const southmostBuilding = buildingDepth(MAX_FIELD_Y);
    const northmostTroop = actorDepth(0);
    expect(southmostBuilding).toBeLessThan(northmostTroop);
    expect(wallDepth(MAX_FIELD_Y)).toBeLessThan(northmostTroop);
  });

  it('lets a building win an equal-Y wall tie while actors stay above both', () => {
    // A troop standing in a doorway: its feet Y IS the building's south edge.
    // That exact tie is what `walkerDepthBias: 3` used to paper over.
    const y = 12 * T;
    expect(wallDepth(y)).toBeLessThan(buildingDepth(y));
    expect(wallDepth(y)).toBeLessThan(actorDepth(y));
    expect(actorDepth(MAX_FIELD_Y)).toBeLessThan(overlayDepth(0));
  });

  it('lets only a strictly southern wall overflow a building', () => {
    const y = 12 * T;
    expect(wallDepth(y - 1)).toBeLessThan(buildingDepth(y));
    expect(wallDepth(y)).toBeLessThan(buildingDepth(y));
    expect(wallDepth(y + 1)).toBeGreaterThan(buildingDepth(y));
  });

  it('still Y-sorts inside a band, or the world stops looking 3/4', () => {
    // The bands must not flatten a layer: a thing lower on screen still draws
    // in front of a thing higher up within the SAME layer.
    expect(buildingDepth(5 * T)).toBeLessThan(buildingDepth(6 * T));
    expect(actorDepth(5 * T)).toBeLessThan(actorDepth(6 * T));
    expect(wallDepth(5 * T)).toBeLessThan(wallDepth(6 * T));
  });

  it('keeps the complete scaled structure field below every actor', () => {
    // If a band's Y range could reach the next band, a low sprite would leak
    // into the layer above and the whole contract silently degrades to the old
    // single-axis behaviour for the bottom of the map only — the worst kind of
    // regression, because it looks fine in a screenshot of the top half.
    expect(buildingDepth(MAX_FIELD_Y)).toBeLessThan(actorDepth(0));
    expect(wallDepth(MAX_FIELD_Y)).toBeLessThan(actorDepth(0));
    expect(actorDepth(MAX_FIELD_Y)).toBeLessThan(overlayDepth(0));
  });

  it('leaves the ground band below every world sprite', () => {
    // Grass (0), the battle deploy wash (2) and the skirt decor spec depths
    // (clamped 2..899) live here and are painted under everything.
    expect(899).toBeLessThan(buildingDepth(0));
    expect(WORLD_DEPTH.ground).toBe(0);
  });
});
