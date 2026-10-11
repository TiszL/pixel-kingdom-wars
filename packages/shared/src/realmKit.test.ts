import { describe, expect, it } from 'vitest';
import { assertRealmKitAssetPixels, assertRealmKitManifest, decodeRealmKitRle, encodeRealmKitRle, OBSTACLE_SPRITE_KEYS, realmKitCell, realmKitCellSource,
  realmKitEdgeMask, realmKitFacingRow, realmKitFloorPlan, realmKitGroundBandPlan, realmKitIsqrt, realmKitObstacleSprite, realmKitOverviewPlan, realmKitPathPlan, realmKitPathPose,
  realmKitPlacementFrame, realmKitPlacementHidden, realmKitPlacementSeat, realmKitPropPlan, realmKitResolvePath, realmKitSegmentFacing, realmKitSpriteSource, realmKitTileHash,
  realmKitTileState, REALM_KIT_EXTENT, REALM_KIT_FACINGS, REALM_KIT_FIELD, REALM_KIT_LAYER_IDS, REALM_KIT_PROTECTED_FRAME, REALM_KIT_SMALLEST_KINGDOM, renderRealmKitPixels,
  type RealmKitEdgeVariant, type RealmKitManifest, type RealmKitPath, type RealmKitPlacement, type RealmKitTileState } from './realmKit';
import { FIXTURE_CELL, FIXTURE_KINGDOM_ROAD, FIXTURE_LAKE, FIXTURE_RIVER, FIXTURE_ROAD_ROW, FIXTURE_STUMP_RGB, FIXTURE_YARD, fixtureCellRgb, fixtureClaim, fixtureCobblesAt,
  fixtureDirtAt, fixtureEdgeVariants, fixtureFarRgb, fixtureFlowerAt, fixtureGrid, fixturePropRgb, fixtureReachableClaims, realmKitFixture, realmKitFixturePixels,
  realmKitPathProbeFixture, realmKitProbeFixture } from './realmKit.fixture';
import { layeredIntersects, type LayeredPixels } from './layeredGround';
import { BASE_GROUND_WORLD_GEOMETRY, CAPS, GRID, LAYERED_GROUND_LIMITS_R5, OBSTACLES, PLOT_GEOMETRY, REALM_KIT } from './constants';
import { isBaseVisualContext, isLayeredBaseVisualContext, isRealmKitBaseVisualContext } from './baseVisual';

const C = FIXTURE_CELL, N = REALM_KIT.fieldTiles, O = REALM_KIT.fieldOriginTiles;
const CLAIMS = { 14: fixtureClaim(14), 26: fixtureClaim(26), 50: fixtureClaim(50) } as const;
/** Deterministic LCG so grid tests never depend on Math.random. */
function lcgGrid(length: number, seed: number, values: number): Uint16Array {
  const out = new Uint16Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; out[i] = (s >>> 8) % values; }
  return out;
}

describe('realm kit geometry constants', () => {
  it('pins the kit to the same field, frame and tile numbers the rest of the game already uses, so nothing moves a coordinate', () => {
    expect(REALM_KIT.tilePixels).toBe(GRID.tilePx);
    expect(REALM_KIT.fieldOriginTiles).toBe(BASE_GROUND_WORLD_GEOMETRY.worldOriginTiles);
    expect(REALM_KIT.fieldTiles).toBe(BASE_GROUND_WORLD_GEOMETRY.worldTiles);
    expect({ min: REALM_KIT.frameMinTile, max: REALM_KIT.frameMaxTile }).toEqual(PLOT_GEOMETRY.boundsByVersion[2]);
    expect(REALM_KIT_FIELD).toEqual({ x: -1088, y: -1088, width: 3136, height: 3136 });
    expect(REALM_KIT_PROTECTED_FRAME).toEqual({ x: -320, y: -320, width: 1600, height: 1600 });
    // The drawable extent (field + REALM_KIT.edgeExtendTiles on every side = tiles -98..128) is the one rect the
    // web tilemap sizes from and the floor plan / deed rasterizer clip to; Kotlin pins the same tile rect from
    // constants.json (RealmKitGroundTest: extentOriginTile -98, extentTiles 226). A margin change shows up here first.
    expect(REALM_KIT_EXTENT).toEqual({ x: -3136, y: -3136, width: 7232, height: 7232 });
    expect(REALM_KIT_EXTENT.x).toBe(REALM_KIT_FIELD.x - REALM_KIT.edgeExtendTiles * REALM_KIT.tilePixels);
    expect(REALM_KIT_EXTENT.width).toBe(REALM_KIT_FIELD.width + 2 * REALM_KIT.edgeExtendTiles * REALM_KIT.tilePixels);
    // The floor cap equals a full base layer plus the water/overlay headroom the limits comment promises.
    // The bake stays a full base layer plus ≤ 6,780 water/overlay cells; one floor plan may cover the whole
    // edge-clamped extent on water + base plus that water/overlay share, and never three full extent layers.
    const extent = N + 2 * REALM_KIT.edgeExtendTiles;
    expect(LAYERED_GROUND_LIMITS_R5.bakedTiles - N * N).toBe(6780);
    expect(LAYERED_GROUND_LIMITS_R5.floorTiles).toBeGreaterThanOrEqual(2 * extent * extent + (LAYERED_GROUND_LIMITS_R5.bakedTiles - N * N));
    expect(LAYERED_GROUND_LIMITS_R5.floorTiles).toBeLessThan(2 * extent * extent + N * N);
    expect(LAYERED_GROUND_LIMITS_R5.cells).toBe((LAYERED_GROUND_LIMITS_R5.dimension / REALM_KIT.tilePixels) ** 2);
    // The r3/r4 web loader keeps its own 256 KiB literal; the kit loader (apps/web
    // realmKitGround.ts) reads this constant. 512 KiB fits the ~1,700-placement
    // Crownlands manifest (~333 KB) with room for the other realms; raising it
    // further is a download-budget decision, not a tuning knob.
    expect(LAYERED_GROUND_LIMITS_R5.manifestBytes).toBe(512 * 1024);
    // §2 ring variants (K-177 road end): the row cap is a hard wall on the builder's bake, one row per in-frame
    // non-wild base cell a ring can cross. Crownlands' road bakes 4 (rows are per baked cell, not per ring tile;
    // scripts/src/realm-kit.test.ts pins the count); 512 is room for yards and tracks meeting the rings from
    // every side, and it must stay a fraction of `cells`, since every row is a cell too.
    expect(LAYERED_GROUND_LIMITS_R5.edgeVariants).toBe(512);
    expect(LAYERED_GROUND_LIMITS_R5.edgeVariants).toBeLessThan(LAYERED_GROUND_LIMITS_R5.cells / 4);
    expect([...OBSTACLE_SPRITE_KEYS]).toEqual(['bush', 'stump', 'rock_s', 'pine1', 'pine2', 'rock_l', 'tree_old', 'boulder']);
    expect(OBSTACLE_SPRITE_KEYS).toHaveLength(Object.values(OBSTACLES.tiers).reduce((n, t) => n + t.kinds.length, 0));
  });
  it('admits groundRevision 5 as the realm-kit member of the layered family without letting the r3/r4 readers claim it', () => {
    const kit = { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 5 } as const;
    expect(isBaseVisualContext(kit)).toBe(true);
    expect(isRealmKitBaseVisualContext(kit)).toBe(true);
    expect(isLayeredBaseVisualContext(kit)).toBe(false);
    expect(isRealmKitBaseVisualContext({ ...kit, groundRevision: 4 })).toBe(false);
    expect(isBaseVisualContext({ ...kit, artVersion: 1 })).toBe(false);
    expect(isBaseVisualContext({ ...kit, groundRevision: 6 as never })).toBe(false);
  });
});

describe('realm kit run-length codec', () => {
  it('round-trips every grid byte-exactly and canonically, so a baked layer survives the manifest hash unchanged', () => {
    const grids = [new Uint16Array(0), new Uint16Array(N * N), new Uint16Array(N * N).fill(65535),
      Uint16Array.from({ length: 300 }, (_, i) => i % 2), Uint16Array.from({ length: 200 }, (_, i) => i),
      lcgGrid(N * N, 7, 3), lcgGrid(N * N, 11, 4096), lcgGrid(5000, 13, 65536), new Uint16Array([0, 0, 0, 7, 7, 1, 65535, 65535])];
    for (const grid of grids) {
      const rle = encodeRealmKitRle(grid);
      expect(rle).not.toMatch(/[,A-Z\s]/);
      const back = decodeRealmKitRle(rle, grid.length);
      expect(back).toEqual(grid);
      expect(encodeRealmKitRle(back)).toBe(rle);
    }
    expect(encodeRealmKitRle(new Uint16Array([0, 0, 0, 7, 7, 1, 65535, 65535]))).toBe('0:3;7:2;1;1ekf:2');
    expect(encodeRealmKitRle(new Uint16Array(N * N))).toBe('0:7es');
  });
  it('rejects malformed, non-canonical or mis-sized input so a corrupted manifest fails admission instead of drawing garbage', () => {
    for (const [rle, length] of [
      ['0:3', 2], ['0:3', 4], ['0:2;', 2], [';0:2', 2], ['0:2;;1', 3], ['1,2', 2], ['A', 1], ['01', 1], ['0:01', 1],
      ['1:1', 1], ['1;1', 2], ['1ekg', 1], ['zzzz', 1], ['a:', 1], [':3', 3], ['0:0', 0], ['-1', 1], ['1.5', 1], ['1 ', 1],
      ['', 1], ['0', 0], ['0:2', -2], ['0:2', 2.5], ['0:7et', N * N + 1],
    ] as const) expect(() => decodeRealmKitRle(rle, length), `${rle} @ ${length}`).toThrow('Invalid realm kit manifest');
    expect(() => decodeRealmKitRle(5 as never, 1)).toThrow();
    expect(decodeRealmKitRle('', 0)).toEqual(new Uint16Array(0));
  });
});

describe('realm kit manifest validator', () => {
  it('accepts the synthetic fixture: the exact contract the Crownlands builder has to hit', () => {
    const m = realmKitFixture();
    expect(() => assertRealmKitManifest(m)).not.toThrow();
    expect(() => assertRealmKitManifest({ ...m, status: 'accepted' })).not.toThrow();
    expect(() => assertRealmKitManifest(JSON.parse(JSON.stringify(m)))).not.toThrow();
    const { overview: _omitted, ...withoutOverview } = m.ground;
    expect(() => assertRealmKitManifest({ ...m, ground: withoutOverview })).not.toThrow();
    // §2 ring variants are additive: a kit baked before them (no `variants`) or one with an empty list still admits,
    // and a row may leave every mask it cannot reach at 0.
    expect(m.ground.state.edge.variants!.length).toBeGreaterThan(0);
    expect(m.ground.state.edge.variants!.some(v => v.cells.includes(0))).toBe(true);
    expect(() => assertRealmKitManifest({ ...m, ground: { ...m.ground, state: { ...m.ground.state, edge: { cells: m.ground.state.edge.cells } } } })).not.toThrow();
    expect(() => assertRealmKitManifest({ ...m, ground: { ...m.ground, state: { ...m.ground.state, edge: { cells: m.ground.state.edge.cells, variants: [] } } } })).not.toThrow();
    // §7: `frame` defaults to 0, and a clip may end on the sheet's last cell.
    delete m.placements[2]!.frame; m.placements[0]!.frame = 2;
    expect(() => assertRealmKitManifest(m)).not.toThrow();
    // E-11 expansion obstacles: the builder's `prop` id and `footprint` are optional, validated shapes.
    Object.assign(m.placements[0]!, { prop: 'oak', footprint: [1, 1] });
    Object.assign(m.placements[1]!, { prop: 'canopy-log', footprint: [LAYERED_GROUND_LIMITS_R5.footprintTiles, 1] });
    expect(() => assertRealmKitManifest(m)).not.toThrow();
  });
  const full = (id: number) => encodeRealmKitRle(fixtureGrid(() => id));
  /** A 2048-cell table on a 2048×1024 tileset (every other rule intact), so a test can address more cells than the fixture bakes. */
  const grow = (m: RealmKitManifest) => {
    const tiles = m.assets[0]!; tiles.width = tiles.frameWidth = 2048; tiles.height = tiles.frameHeight = 1024;
    m.ground.cells = Array.from({ length: 2048 }, (_, i) => ({ asset: 'tiles', x: (i % 64) * 32, y: Math.floor(i / 64) * 32 }));
  };
  const variantRows = (n: number): RealmKitEdgeVariant[] => Array.from({ length: n }, (_, i) => ({ cell: i + 1, cells: new Array<number>(16).fill(0) }));
  /** Every other rule satisfied at its cap (2048-cell tileset, noisy base, 1024 placements, 32×64-point paths):
   * only the manifest JSON itself is oversize. Dropping the placements brings it back under the cap. */
  const oversize = (m: RealmKitManifest) => {
    grow(m);
    m.ground.layers[1]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => ((tx * 31 + ty * 17) % 2048 + 2048) % 2048 + 1));
    for (let i = m.placements.length; i < LAYERED_GROUND_LIMITS_R5.placements; i++) m.placements.push({ ...m.placements[1]!, id: `stump-${'x'.repeat(50)}-${i}`, x: 400 + i });
    for (let i = m.paths.length; i < LAYERED_GROUND_LIMITS_R5.paths; i++) m.paths.push({ ...m.paths[0]!, id: `p-${i}`, points: Array.from({ length: 64 }, (_, k) => ({ x: 1400 + k, y: -900 })) });
  };
  const mutations: [rule: string, mutate: (m: RealmKitManifest) => void][] = [
    ['schemaVersion is pinned to 3 (r4 readers must never open a kit)', m => Object.assign(m, { schemaVersion: 2 })],
    ['groundRevision is pinned to 5', m => Object.assign(m, { groundRevision: 4 })],
    ['realmId must be a known realm', m => Object.assign(m, { realmId: 'atlantis' })],
    ['status is preview-only or accepted', m => Object.assign(m, { status: 'draft' })],
    ['tilePixels is 32 (1 art px = 1 texel)', m => Object.assign(m, { tilePixels: 64 })],
    ['field is pinned to the 98-tile world', m => { m.field.x = -1056; }],
    ['protectedFrame is pinned to the 50×50 clearing', m => { m.protectedFrame.width = m.protectedFrame.height = 1472; }],
    ['ground kind is tiles', m => Object.assign(m.ground, { kind: 'painting' })],
    ['paddingColor is #rrggbb', m => { m.ground.paddingColor = 'olive'; }],
    ['a layer may only reference cell ids in the table', m => { m.ground.layers[1]!.rle = full(99); }],
    ['a layer grid is exactly 98×98 cells', m => { m.ground.layers[1]!.rle = encodeRealmKitRle(new Uint16Array(N * N - 1).fill(1)); }],
    ['a layer grid must decode', m => { m.ground.layers[1]!.rle = '1,2'; }],
    ['layer ids are unique', m => { m.ground.layers[0]!.id = 'base'; }],
    ['layer ids come from the three draw layers', m => Object.assign(m.ground.layers[2]!, { id: 'shadow' })],
    ['the base layer is required', m => { m.ground.layers.splice(1, 1); }],
    ['the base layer has no holes (the far repeat must never show inside the field)', m => { const g = fixtureGrid(() => 1); g[0] = 0; m.ground.layers[1]!.rle = encodeRealmKitRle(g); }],
    ['water never enters the 50×50 frame', m => { const g = fixtureGrid((tx, ty) => tx === 0 && ty === 0 ? C.water : 0); m.ground.layers[0]!.rle = encodeRealmKitRle(g); }],
    ['water stays out of the meadow rings outside the frame (a full claim\'s ring must never meet water)', m => { m.ground.layers[0]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => tx === -11 && ty === 15 ? C.water : 0)); }],
    ['water stays out of the meadow rings on the far side too', m => { m.ground.layers[0]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => tx === 20 && ty === 41 ? C.water : 0)); }],
    ['baked non-empty tiles stay under the floor cap', m => { m.ground.layers[2]!.rle = full(C.flower); }],
    ['layers are listed in draw order (water, base, overlay), which the floor plan and native chunk batches emit verbatim', m => { m.ground.layers.reverse(); }],
    ['layers are listed in draw order even when only two are present', m => { m.ground.layers = [m.ground.layers[1]!, m.ground.layers[0]!]; }],
    ['layer count is capped', m => { m.ground.layers = []; }],
    ['at least one cell exists', m => { m.ground.cells = []; }],
    ['cells sit on the 32-px grid so a tileset index can address them', m => { m.ground.cells[0]!.x = 5; }],
    ['every cell addresses the one tileset', m => { m.ground.cells[3]!.asset = 'far'; }],
    ['the tileset is a power-of-two single-frame sheet', m => { m.assets[0]!.width = m.assets[0]!.frameWidth = 320; }],
    ['the tileset is not the far asset', m => { const far = m.assets[1]!; far.width = far.height = far.frameWidth = far.frameHeight = 256; for (const c of m.ground.cells) c.asset = 'far'; }],
    ['an animated cell needs frameDurationMs', m => { delete m.ground.cells[C.water - 1]!.frameDurationMs; }],
    ['frameDurationMs is 50..10000', m => { m.ground.cells[C.water - 1]!.frameDurationMs = 20; }],
    ['frames is ≥1', m => { m.ground.cells[C.water - 1]!.frames = 0; }],
    ['animated frames fit inside the tileset', m => { m.ground.cells[C.water - 1]!.x = 224; }],
    ['a cell fits inside the tileset vertically', m => { m.ground.cells[0]!.y = 256; }],
    ['edge.cells has exactly 16 corner-Wang entries', m => { m.ground.state.edge.cells.pop(); }],
    ['edge.cells entries are cell ids', m => { m.ground.state.edge.cells[3] = 0; }],
    // §2 ring variants: a malformed row would draw garbage on the ring of one client and be refused by the other.
    ['edge.variants, when given, is an array', m => Object.assign(m.ground.state.edge, { variants: {} })],
    ['edge.variants rows are objects', m => { m.ground.state.edge.variants = [7 as never]; }],
    ['edge.variants row cell is a cell id (not 0)', m => { m.ground.state.edge.variants![0]!.cell = 0; }],
    ['edge.variants row cell is a cell id (inside the table)', m => { m.ground.state.edge.variants![0]!.cell = m.ground.cells.length + 1; }],
    ['edge.variants row cell is an integer', m => { m.ground.state.edge.variants![0]!.cell = 26.5; }],
    ['edge.variants rows are unique per base cell (two rows for one cell would race)', m => { m.ground.state.edge.variants!.push({ ...m.ground.state.edge.variants![0]! }); }],
    ['edge.variants row cells has exactly 16 masks (one short)', m => { m.ground.state.edge.variants![0]!.cells.pop(); }],
    ['edge.variants row cells has exactly 16 masks (one over)', m => { m.ground.state.edge.variants![0]!.cells.push(0); }],
    ['edge.variants row cells is an array', m => Object.assign(m.ground.state.edge.variants![0]!, { cells: 'x'.repeat(16) })],
    ['edge.variants entries are 0 or a cell id (outside the table)', m => { m.ground.state.edge.variants![0]!.cells[12] = m.ground.cells.length + 1; }],
    ['edge.variants entries are 0 or a cell id (negative)', m => { m.ground.state.edge.variants![0]!.cells[3] = -1; }],
    ['edge.variants entries are integers', m => { m.ground.state.edge.variants![0]!.cells[3] = 1.5; }],
    ['edge.variants row count is capped (LAYERED_GROUND_LIMITS_R5.edgeVariants)', m => { grow(m); m.ground.state.edge.variants = variantRows(LAYERED_GROUND_LIMITS_R5.edgeVariants + 1); }],
    ['turf has at least one variant', m => { m.ground.state.turf = []; }],
    ['turf entries are cell ids', m => { m.ground.state.turf = [999]; }],
    ['clearInside is true (kingdom always clears the overlay)', m => Object.assign(m.ground.state, { clearInside: false })],
    ['the far asset exists', m => { m.ground.far.asset = 'nope'; }],
    ['the far asset is power-of-two', m => { m.assets[1]!.width = m.assets[1]!.frameWidth = 48; }],
    ['the far period is at least one tile', m => { m.ground.far.period.width = 16; }],
    ['the far origin is finite', m => { m.ground.far.origin.x = Infinity; }],
    ['the overview covers the field at pxPerTile', m => { m.assets[2]!.width = m.assets[2]!.frameWidth = 200; }],
    ['the overview pxPerTile is 1..32', m => { m.ground.overview!.pxPerTile = 0; }],
    ['the overview asset exists', m => { m.ground.overview!.asset = 'nope'; }],
    // The count comes from the constant: the cap moved 24 → 32 for the creature sheets (D-173 creature
    // paths) and a literal here passed by accident once (a fixture sha collided with an extra's path).
    ['asset count is capped (LAYERED_GROUND_LIMITS_R5.assets)', m => { for (let i = 0; i < LAYERED_GROUND_LIMITS_R5.assets; i++) { const sha = (0x20 + i).toString(16).repeat(32); m.assets.push({ ...m.assets[5]!, id: `extra-${i}`, sha256: sha, path: `atlas/fantasy/layered-ground/assets/${sha}.png` }); } }],
    ['asset paths are hash-addressed under layered-ground/assets', m => { m.assets[0]!.path = '../escape.png'; }],
    ['asset sha256 is 64 hex', m => { m.assets[0]!.sha256 = 'wrong'; }],
    ['asset ids are unique', m => { m.assets[1]!.id = 'tiles'; }],
    ['asset dimensions are capped', m => { m.assets[3]!.height = m.assets[3]!.frameHeight = 4096; }],
    ['decoded RGBA stays within 16 MiB', m => { for (const i of [0, 1]) m.assets[i]!.width = m.assets[i]!.height = m.assets[i]!.frameWidth = m.assets[i]!.frameHeight = 2048; }],
    ['compressed bytes include the manifest itself', m => { m.assets[0]!.size = LAYERED_GROUND_LIMITS_R5.compressedBytes - 500; }],
    // The rule name is derived from the constant so it cannot go stale again when the cap moves
    // (it said 256 KiB after the raise to 512 KiB); the kit loader (apps/web realmKitGround.ts) reads the same value.
    [`the manifest JSON fits the ${LAYERED_GROUND_LIMITS_R5.manifestBytes / 1024} KiB manifestBytes cap the kit loader reads from LAYERED_GROUND_LIMITS_R5`, oversize],
    ['a frame grid must tile the sheet', m => { m.assets[3]!.frameCount = 3; }],
    ['reducedMotionFrame is 0', m => Object.assign(m.assets[3]!, { reducedMotionFrame: 1 })],
    // E-6 amended: a prop may stand in the frame, but never where the smallest claim's ring already hides it.
    ['placements are not seated inside the smallest kingdom or its ring', m => { m.placements[0]!.x = 15 * 32 + 16; m.placements[0]!.y = 16 * 32; }],
    ['placements on the smallest ring itself are hidden too', m => { m.placements[0]!.x = 7 * 32 + 16; m.placements[0]!.y = 23 * 32; }],
    ['placements stay inside the field', m => { m.placements[0]!.x = -2000; }],
    ['placements cannot draw the tileset, far or overview sheets', m => { m.placements[1]!.asset = 'tiles'; }],
    // Rewritten for §7 (was "phaseFrame is within its frames"): on revision 5 the loop start is `frame`, so an
    // r4 phase — even one that fits the sheet — is rejected rather than silently ignored by one client and honoured by another.
    ['placement phaseFrame is 0 (r4 phase semantics do not apply; the loop starts at `frame`)', m => { m.placements[0]!.phaseFrame = 1; }],
    ['placement frame is a cell of its sheet', m => { m.placements[2]!.frame = 4; }],
    ['placement frame is a non-negative integer', m => { m.placements[2]!.frame = -1; }],
    ['placement frame is an integer', m => { m.placements[2]!.frame = 1.5; }],
    ['placement clip is an object', m => Object.assign(m.placements[0]!, { clip: 2 })],
    ['placement clip has at least two frames', m => { m.placements[0]!.clip!.frames = 1; }],
    ['placement clip fits the sheet after its start cell (frame + frames ≤ frameCount)', m => { m.placements[0]!.frame = 3; }],
    ['placement clip frameDurationMs is at least 50', m => { m.placements[0]!.clip!.frameDurationMs = 20; }],
    ['placement clip frameDurationMs is at most 10000', m => { m.placements[0]!.clip!.frameDurationMs = 20000; }],
    ['placement animated is true iff clip is present (animated without a clip)', m => { m.placements[2]!.animated = true; }],
    ['placement animated is true iff clip is present (clip without animated)', m => { m.placements[0]!.animated = false; }],
    ['placements stay non-interactive (tap-to-clear is the only economy interaction)', m => { m.placements[0]!.interactive = true as false; }],
    ['placement ids are unique', m => { m.placements[1]!.id = 'oak-east'; }],
    ['placement states name existing sprite assets', m => { m.placements[0]!.states!.remnant = 'nope'; }],
    ['placement states.intact is the placement asset', m => { m.placements[0]!.states!.intact = 'oak-stump'; }],
    ['placement prop, when given, is a kit id', m => { m.placements[0]!.prop = 'Oak Tree'; }],
    ['placement prop is a string', m => Object.assign(m.placements[0]!, { prop: 7 })],
    ['placement footprint, when given, is a [w, h] pair', m => Object.assign(m.placements[0]!, { footprint: [1] })],
    ['placement footprint tiles are positive integers', m => { m.placements[0]!.footprint = [0, 1]; }],
    ['placement footprint tiles are integers', m => { m.placements[0]!.footprint = [1.5, 1]; }],
    ['placement footprint tiles are capped (LAYERED_GROUND_LIMITS_R5.footprintTiles)', m => { m.placements[0]!.footprint = [1, LAYERED_GROUND_LIMITS_R5.footprintTiles + 1]; }],
    ['placement count is capped', m => { for (let i = 0; i < LAYERED_GROUND_LIMITS_R5.placements; i++) m.placements.push({ ...m.placements[1]!, id: `s-${i}`, x: 400 + i }); }],
    ['obstacleSprites keys are the eight server sprite keys', m => Object.assign(m.obstacleSprites, { dragon: { intact: 'oak', remnant: 'oak-stump' } })],
    ['obstacleSprites values are existing sprite assets', m => { m.obstacleSprites.stump = { intact: 'tiles', remnant: 'oak-stump' }; }],
    ['obstacleSprites clearing, when given, is a sprite asset', m => { m.obstacleSprites.stump = { intact: 'oak', clearing: 'far', remnant: 'oak-stump' }; }],
    ['path vertices stay outside the frame (sprite bounds included)', m => { m.paths[0]!.points[1] = { x: 1287, y: 500 }; }],
    ['path vertices stay outside the frame', m => { m.paths[0]!.points[1] = { x: 500, y: 500 }; }],
    ['path segments cannot cross the frame between two outside vertices', m => { m.paths[0]!.points = [{ x: -900, y: 500 }, { x: 1900, y: 500 }]; }],
    ['path segments cannot cut a frame corner diagonally', m => { m.paths[0]!.points = [{ x: 1200, y: 1350 }, { x: 1350, y: 1200 }]; }],
    ['path vertices stay inside the field', m => { m.paths[0]!.points[2] = { x: 2045, y: 1900 }; }],
    ['a path needs at least two vertices', m => { m.paths[0]!.points.length = 1; }],
    ['path vertex count is capped', m => { m.paths[0]!.points = Array.from({ length: 65 }, (_, i) => ({ x: 1400 + i, y: -900 })); }],
    ['path speed is 1..4096 art px/s', m => { m.paths[0]!.speed = 0; }],
    ['path assets are sprite assets', m => { m.paths[0]!.asset = 'overview'; }],
    ['path ids are unique', m => { m.paths.push({ ...m.paths[0]! }); }],
    ['path count is capped (LAYERED_GROUND_LIMITS_R5.paths, raised to 96 for the roaming creatures)', m => { for (let i = 0; i < LAYERED_GROUND_LIMITS_R5.paths; i++) m.paths.push({ ...m.paths[0]!, id: `p-${i}` }); }],
    // D-173 creature paths: a facing row that does not tile the sheet would draw another facing's cells
    // (or read past the sheet) on one client and be refused by the other.
    // The gull sheet has 3 cells, so `directions: 3, frames: 1` tiles it exactly: only the [1, 2, 4] membership
    // rule can reject it (on the hare, 3 × 2 ≠ 8 tripped the tiling rule first and hid a dropped membership check).
    ['path directions is 1, 2 or 4', m => Object.assign(m.paths[0]!, { directions: 3, frames: 1 })],
    ['path directions × frames tiles the sheet exactly (frames too many)', m => { m.paths[1]!.frames = 3; }],
    ['path directions × frames tiles the sheet exactly (directions too few for the frames given)', m => { m.paths[1]!.directions = 2; }],
    ['path directions × frames tiles the sheet exactly (default frames must divide the sheet)', m => { m.paths[0]!.directions = 2; }],
    ['path frames is a positive integer', m => { m.paths[1]!.frames = 0; }],
    ['path frameDurationMs is at least 50', m => { m.paths[1]!.frameDurationMs = 20; }],
    ['path frameDurationMs is at most 10000', m => { m.paths[1]!.frameDurationMs = 10001; }],
    ['path dwellMs is a non-negative integer', m => { m.paths[1]!.dwellMs = -1; }],
    ['path dwellMs is at most 60000 (a creature that never leaves its vertex is a still, not a path)', m => { m.paths[1]!.dwellMs = 60001; }],
    ['path dwellMs is an integer', m => { m.paths[1]!.dwellMs = 0.5; }],
    ['path loop is cycle or pingpong', m => Object.assign(m.paths[1]!, { loop: 'bounce' })],
    ['path layer is a ground-band layer 0..15', m => { m.paths[0]!.layer = 16; }],
    ['creature path vertices stay outside the frame (sprite bounds included)', m => { m.paths[1]!.points[1] = { x: 1287, y: 500 }; }],
  ];
  it.each(mutations)('rejects a manifest where %s', (_rule, mutate) => {
    const m = realmKitFixture();
    mutate(m);
    expect(() => assertRealmKitManifest(m)).toThrow('Invalid realm kit manifest');
  });
  it('rejects path directions outside {1, 2, 4} on its own: a sheet the bad count tiles exactly is still refused', () => {
    // realmKitFacingRow(3, …) answers row 0 for every facing, so a `directions: 3` creature would walk every side with
    // its down-facing cycle on whichever client dropped the membership check. Pin the precondition (the mutation
    // passes the tiling rule) so the rejection below can only come from the membership rule.
    const m = realmKitFixture();
    const gull = m.assets.find(a => a.id === m.paths[0]!.asset)!;
    expect(gull.frameCount).toBe(3);
    Object.assign(m.paths[0]!, { directions: 3, frames: 1 });
    expect(m.paths[0]!.directions! * m.paths[0]!.frames!).toBe(gull.frameCount);
    expect(() => assertRealmKitManifest(m)).toThrow('Invalid realm kit manifest');
    Object.assign(m.paths[0]!, { directions: 1, frames: 3 });
    expect(() => assertRealmKitManifest(m)).not.toThrow();
  });
  it('admits exactly LAYERED_GROUND_LIMITS_R5.edgeVariants rows and refuses one more, so the cap is the row count and nothing else', () => {
    const m = realmKitFixture();
    grow(m);
    m.ground.state.edge.variants = variantRows(LAYERED_GROUND_LIMITS_R5.edgeVariants);
    expect(() => assertRealmKitManifest(m)).not.toThrow();
    m.ground.state.edge.variants.push({ cell: LAYERED_GROUND_LIMITS_R5.edgeVariants + 1, cells: new Array<number>(16).fill(0) });
    expect(() => assertRealmKitManifest(m)).toThrow('Invalid realm kit manifest');
  });
  it('rejects an oversize manifest for its byte size alone: the same manifest passes once trimmed under the cap', () => {
    const m = realmKitFixture();
    oversize(m);
    const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v) + '\n').byteLength;
    expect(bytes(m)).toBeGreaterThan(LAYERED_GROUND_LIMITS_R5.manifestBytes);
    expect(() => assertRealmKitManifest(m)).toThrow('Invalid realm kit manifest');
    m.placements.length = 2;
    expect(bytes(m)).toBeLessThanOrEqual(LAYERED_GROUND_LIMITS_R5.manifestBytes);
    expect(() => assertRealmKitManifest(m)).not.toThrow();
  });
  it('lets a path hug the frame edge and cut past a corner without entering, so authored routes are not rejected for touching', () => {
    const m = realmKitFixture();
    // Gull frame 16×16, anchor 8: bounds touch the frame's east edge (x = 1280) at x = 1288 exactly.
    m.paths[0]!.points = [{ x: 1288, y: -900 }, { x: 1288, y: 1900 }, { x: 1900, y: 1900 }];
    expect(() => assertRealmKitManifest(m)).not.toThrow();
    m.paths[0]!.points = [{ x: 1300, y: 1288 }, { x: 1600, y: 1288 }];
    expect(() => assertRealmKitManifest(m)).not.toThrow();
    m.paths[0]!.points = [{ x: 1288, y: 1600 }, { x: 1600, y: 1288 }]; // outside the corner diagonal
    expect(() => assertRealmKitManifest(m)).not.toThrow();
    m.paths[0]!.points = [{ x: 1287, y: -900 }, { x: 1287, y: 1900 }]; // one pixel in and the sprite overlaps the frame
    expect(() => assertRealmKitManifest(m)).toThrow();
  });
});

describe('realm kit tile state', () => {
  const states = (claim: { min: number; max: number }, probes: [number, number, RealmKitTileState][]) => {
    for (const [tx, ty, expected] of probes) expect(realmKitTileState(claim, tx, ty), `${claim.min}..${claim.max} @ ${tx},${ty}`).toBe(expected);
  };
  it('derives kingdom, ring, wilderness and exterior from the server claim rect alone, so raids, deeds and both clients agree', () => {
    expect(CLAIMS[14]).toEqual({ min: 8, max: 22 }); expect(CLAIMS[26]).toEqual({ min: 2, max: 28 }); expect(CLAIMS[50]).toEqual({ min: -10, max: 40 });
    states(CLAIMS[14], [[8, 8, 'kingdom'], [21, 21, 'kingdom'], [15, 15, 'kingdom'], [7, 7, 'edge'], [22, 22, 'edge'], [7, 15, 'edge'], [15, 22, 'edge'],
      [22, 7, 'edge'], [6, 15, 'wilderness'], [15, 23, 'wilderness'], [-10, -10, 'wilderness'], [39, 39, 'wilderness'], [0, 0, 'wilderness'],
      [-11, 15, 'exterior'], [40, 40, 'exterior'], [-34, 63, 'exterior'], [64, 0, 'exterior']]);
    states(CLAIMS[26], [[2, 2, 'kingdom'], [27, 27, 'kingdom'], [1, 1, 'edge'], [28, 28, 'edge'], [1, 28, 'edge'], [28, 1, 'edge'], [0, 15, 'wilderness'],
      [15, 29, 'wilderness'], [-10, 39, 'wilderness'], [-11, 0, 'exterior']]);
    // A full claim's ring lies in the innermost exterior ring, which the layout keeps as meadow (REALM_KIT.meadowRingsOutsideFrame).
    states(CLAIMS[50], [[-10, -10, 'kingdom'], [39, 39, 'kingdom'], [0, 0, 'kingdom'], [-11, -11, 'edge'], [40, 40, 'edge'], [-11, 15, 'edge'],
      [15, 40, 'edge'], [40, -11, 'edge'], [-12, 0, 'exterior'], [41, 41, 'exterior'], [-12, -12, 'exterior']]);
    expect(REALM_KIT.meadowRingsOutsideFrame).toBeGreaterThanOrEqual(REALM_KIT.edgeRingTiles);
  });
  it('fails loud on claims the server could never send, so a corrupt claim cannot silently draw a wrong kingdom', () => {
    for (const claim of [{ min: 10, max: 10 }, { min: 12, max: 10 }, { min: 7.5, max: 21.5 }, { min: -11, max: 39 }, { min: 0, max: 41 }, { min: '8', max: 22 }, null]) {
      expect(() => realmKitTileState(claim as never, 15, 15), JSON.stringify(claim)).toThrow('Invalid realm kit manifest');
    }
    expect(() => realmKitTileState(CLAIMS[14], 1.5, 0)).toThrow();
    expect(() => realmKitCell(realmKitFixture(), CLAIMS[14], 'base', 0, NaN)).toThrow();
    expect(() => realmKitCell(realmKitFixture(), CLAIMS[14], 'shadow' as never, 0, 0)).toThrow();
  });
});

describe('realm kit edge ring', () => {
  it('assigns corner-Wang masks from the claim rect on a 4-tile claim: straight runs on the sides, one corner each, no interior tile in the ring', () => {
    const claim = { min: 10, max: 14 };
    for (let t = 10; t < 14; t++) {
      expect(realmKitEdgeMask(claim, t, 9), `north ${t}`).toBe(3);
      expect(realmKitEdgeMask(claim, t, 14), `south ${t}`).toBe(12);
      expect(realmKitEdgeMask(claim, 9, t), `west ${t}`).toBe(5);
      expect(realmKitEdgeMask(claim, 14, t), `east ${t}`).toBe(10);
    }
    expect([realmKitEdgeMask(claim, 9, 9), realmKitEdgeMask(claim, 14, 9), realmKitEdgeMask(claim, 9, 14), realmKitEdgeMask(claim, 14, 14)]).toEqual([1, 2, 4, 8]);
    // Only the eight straight/corner masks are reachable from a rectangle; a full-upper mask means a kingdom tile.
    const reached = new Set<number>();
    for (let ty = 8; ty <= 15; ty++) for (let tx = 8; tx <= 15; tx++) {
      const state = realmKitTileState(claim, tx, ty);
      const inside = tx >= 10 && tx < 14 && ty >= 10 && ty < 14;
      expect(state === 'kingdom', `${tx},${ty}`).toBe(inside);
      expect(state === 'edge', `${tx},${ty}`).toBe(!inside && tx >= 9 && tx <= 14 && ty >= 9 && ty <= 14);
      if (state === 'edge') reached.add(realmKitEdgeMask(claim, tx, ty));
      if (inside) expect(realmKitEdgeMask(claim, tx, ty)).toBe(15);
    }
    expect([...reached].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 8, 10, 12]);
    // The ring's base cell is the edge table entry for that mask; the other layers are cleared on it.
    const m = realmKitFixture();
    expect(realmKitCell(m, claim, 'base', 9, 9)).toBe(C.edgeFirst + 1);
    expect(realmKitCell(m, claim, 'base', 11, 14)).toBe(C.edgeFirst + 12);
    expect(realmKitCell(m, claim, 'overlay', 9, 9)).toBe(0);
    expect(realmKitCell(m, claim, 'water', 9, 9)).toBe(0);
  });
});

describe('realm kit ring variants (§2, K-177 road end: the road meets the land through turf-road)', () => {
  const R = FIXTURE_KINGDOM_ROAD, Y = FIXTURE_YARD;
  const rows = (m: RealmKitManifest) => new Map(m.ground.state.edge.variants!.map(v => [v.cell, v.cells]));
  it('emits the fixture rows from the reachable rings alone: cobbles under the south run, dirt under the north run, the corner and the east run, nothing else', () => {
    const m = realmKitFixture(), base = decodeRealmKitRle(m.ground.layers[1]!.rle, N * N);
    // The road: two columns of cobbles from the field's south edge to row 20 inside the smallest kingdom, so every
    // claim's south ring crosses it; the yard: a dirt patch in the frame north-east of the smallest kingdom.
    expect(R.endRow).toBeGreaterThanOrEqual(REALM_KIT_SMALLEST_KINGDOM.min); expect(R.endRow).toBeLessThan(REALM_KIT_SMALLEST_KINGDOM.max);
    expect(base[(63 - O) * N + (15 - O)]).toBe(C.cobbles); expect(base[(R.endRow - O) * N + (14 - O)]).toBe(C.cobbles);
    expect(base[(R.endRow - 1 - O) * N + (14 - O)]).toBe(C.meadowAlt); expect(base[(R.endRow - O) * N + (13 - O)]).toBe(C.meadowAlt); // the chequer either side
    expect(base[(Y.min.y - O) * N + (Y.min.x - O)]).toBe(C.dirt); expect(base[(Y.max.y - O) * N + (Y.max.x - O)]).toBe(C.meadowAlt);
    expect(fixtureReachableClaims()).toEqual(CAPS.claimTilesByExpansion.map(tiles => ({ min: 15 - tiles / 2, max: 15 + tiles / 2 })));
    expect(fixtureReachableClaims()[0]).toEqual(REALM_KIT_SMALLEST_KINGDOM);
    // Rows: one per non-wild cell a ring crosses; the masks are exactly the ones the 13 rings put on them, each its own cell.
    const { variants, count } = fixtureEdgeVariants(base);
    expect(variants).toEqual(m.ground.state.edge.variants);
    expect(variants.map(v => v.cell).sort((a, b) => a - b)).toEqual([C.cobbles, C.dirt]);
    const masks = (cell: number) => variants.find(v => v.cell === cell)!.cells.map((c, mask) => c ? mask : -1).filter(mask => mask >= 0);
    expect(masks(C.cobbles)).toEqual([12]); expect(masks(C.dirt)).toEqual([2, 3, 10]);
    const cells = variants.flatMap(v => v.cells.filter(Boolean)).sort((a, b) => a - b);
    expect(cells).toEqual([0, 1, 2, 3].map(i => C.variantFirst + i)); expect(count).toBe(4);
    expect(m.ground.cells).toHaveLength(C.variantFirst + count - 1);
    for (const id of cells) expect(m.ground.cells[id - 1]).toEqual({ asset: 'tiles', x: ((2 + id - C.variantFirst) % 8) * 32, y: 128 });
    // Deterministic: the same grid gives the same rows, so the parity file cannot drift on a rebuild.
    expect(fixtureEdgeVariants(base)).toEqual({ variants, count });
  });
  it('draws the baked cell\'s variant on a ring tile over the road or the yard and the default ring cell everywhere else — a mirror that ignores the rows fails here', () => {
    const m = realmKitFixture(), v = rows(m), road = v.get(C.cobbles)!, dirt = v.get(C.dirt)!;
    const d = (mask: number) => m.ground.state.edge.cells[mask]!;
    // Claim 14 [8,22): its south ring (row 22, mask 12) crosses the road at 14 and 15; either side is meadow → default.
    expect(realmKitCell(m, CLAIMS[14], 'base', 14, 22)).toBe(road[12]); expect(realmKitCell(m, CLAIMS[14], 'base', 15, 22)).toBe(road[12]);
    expect(road[12]).toBeGreaterThanOrEqual(C.variantFirst); expect(road[12]).not.toBe(d(12));
    expect(realmKitCell(m, CLAIMS[14], 'base', 13, 22)).toBe(d(12)); expect(realmKitCell(m, CLAIMS[14], 'base', 16, 22)).toBe(d(12));
    // Its north ring (row 7, mask 3), north-east corner (22,7 → mask 2) and east ring (22,8 → mask 10) cross the yard.
    expect(realmKitCell(m, CLAIMS[14], 'base', 20, 7)).toBe(dirt[3]); expect(realmKitCell(m, CLAIMS[14], 'base', 21, 7)).toBe(dirt[3]);
    expect(realmKitCell(m, CLAIMS[14], 'base', 22, 7)).toBe(dirt[2]); expect(realmKitCell(m, CLAIMS[14], 'base', 22, 8)).toBe(dirt[10]);
    expect(realmKitCell(m, CLAIMS[14], 'base', 19, 7)).toBe(d(3)); expect(realmKitCell(m, CLAIMS[14], 'base', 22, 9)).toBe(d(10)); expect(realmKitCell(m, CLAIMS[14], 'base', 7, 7)).toBe(d(1));
    expect(new Set([road[12], dirt[3], dirt[2], dirt[10]]).size).toBe(4);
    // Every claim's south ring meets the road: 26 at row 28, 50 at row 40 (the first exterior ring, no longer pure meadow).
    expect(realmKitCell(m, CLAIMS[26], 'base', 15, 28)).toBe(road[12]); expect(realmKitCell(m, CLAIMS[50], 'base', 14, 40)).toBe(road[12]);
    expect(realmKitCell(m, CLAIMS[26], 'base', 16, 28)).toBe(d(12)); expect(realmKitCell(m, CLAIMS[50], 'base', 13, 40)).toBe(d(12));
    // A 0 entry means "no variant for this mask": the default draws, whatever the baked cell.
    const zeroed = realmKitFixture(); rows(zeroed).get(C.cobbles)![12] = 0;
    expect(realmKitCell(zeroed, CLAIMS[14], 'base', 15, 22)).toBe(d(12));
    // No rows at all (a kit baked before §2) or an empty list: the default ring everywhere, as before.
    const bare = realmKitFixture(); delete bare.ground.state.edge.variants;
    expect(realmKitCell(bare, CLAIMS[14], 'base', 15, 22)).toBe(d(12)); expect(realmKitCell(bare, CLAIMS[14], 'base', 22, 7)).toBe(d(2));
    const empty = realmKitFixture(); empty.ground.state.edge.variants = [];
    expect(realmKitCell(empty, CLAIMS[14], 'base', 15, 22)).toBe(d(12));
    // The floor plan and the deed rasterizer take the same cell (one rule, three surfaces).
    const plan = realmKitFloorPlan(m, 32, { x: 14 * 32, y: 22 * 32, width: 64, height: 32 }, CLAIMS[14], 0, true);
    expect(plan.tiles.filter(t => t.layer === 'base').map(t => t.cell)).toEqual([road[12], road[12]]);
  });
  it('never applies a variant off the ring and keeps water and overlay at 0 on it: turf inside, the baked cobbles outside, the ring cell alone on the ring', () => {
    const m = realmKitFixture(), road = rows(m).get(C.cobbles)!;
    // The road's cells inside the claim are turf (the claim overwrites ground-level terrain), outside it cobbles,
    // beyond the field still cobbles (edge clamp) — a variant cell appears on ring tiles only.
    expect(m.ground.state.turf).toContain(realmKitCell(m, CLAIMS[14], 'base', 15, 21)); expect(m.ground.state.turf).toContain(realmKitCell(m, CLAIMS[14], 'base', 14, R.endRow));
    expect(realmKitCell(m, CLAIMS[14], 'base', 15, 23)).toBe(C.cobbles); expect(realmKitCell(m, CLAIMS[14], 'base', 15, 63)).toBe(C.cobbles);
    expect(realmKitCell(m, CLAIMS[14], 'base', 15, 64)).toBe(C.cobbles); expect(realmKitCell(m, CLAIMS[14], 'base', 15, 63 + REALM_KIT.edgeExtendTiles)).toBe(C.cobbles);
    expect(realmKitCell(m, CLAIMS[50], 'base', 15, 41)).toBe(C.cobbles); expect(realmKitCell(m, CLAIMS[14], 'base', 22, 6)).toBe(C.dirt);
    for (const claim of fixtureReachableClaims()) {
      for (let ty = -12; ty < 42; ty++) for (let tx = -12; tx < 42; tx++) {
        const cell = realmKitCell(m, claim, 'base', tx, ty), state = realmKitTileState(claim, tx, ty);
        if (cell >= C.variantFirst) expect(state, `${claim.min}..${claim.max} @ ${tx},${ty}`).toBe('edge');
        if (state === 'edge') {
          // Every ring tile over cobbles or dirt has a variant (the rows come from these very rings); every other ring tile is the default.
          const row = fixtureCobblesAt(tx, ty) ? road : fixtureDirtAt(tx, ty) ? rows(m).get(C.dirt)! : undefined, mask = realmKitEdgeMask(claim, tx, ty);
          expect(cell, `${claim.min}..${claim.max} @ ${tx},${ty}`).toBe(row ? row[mask] : m.ground.state.edge.cells[mask]);
          if (row) expect(cell).toBeGreaterThanOrEqual(C.variantFirst);
          expect(realmKitCell(m, claim, 'water', tx, ty)).toBe(0); expect(realmKitCell(m, claim, 'overlay', tx, ty)).toBe(0);
        }
      }
    }
    // Water or a decal baked onto a ring tile over the road stays cleared: only the base layer draws the ring.
    const wet = realmKitFixture();
    wet.ground.layers[0]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => tx === 15 && ty === 22 ? C.water : 0));
    wet.ground.layers[2]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => tx === 15 && ty === 22 ? C.flower : 0));
    expect(realmKitCell(wet, CLAIMS[14], 'water', 15, 22)).toBe(0); expect(realmKitCell(wet, CLAIMS[14], 'overlay', 15, 22)).toBe(0);
    expect(realmKitCell(wet, CLAIMS[14], 'base', 15, 22)).toBe(road[12]);
    expect(realmKitFloorPlan(wet, 32, { x: 15 * 32, y: 22 * 32, width: 32, height: 32 }, CLAIMS[14], 0, true).tiles.map(t => [t.layer, t.cell])).toEqual([['base', road[12]]]);
  });
  it('rasterizes the road crossing as turf, the variant, then cobbles down one column, and the default ring one column over, so the deed shows the road meeting the land', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m), road = rows(m).get(C.cobbles)!;
    const px = (claim: { min: number; max: number }, tx: number, ty: number) => rgba(renderRealmKitPixels(m, p, claim, 1, 1, tx * 32 + 7, ty * 32 + 9), 1, 0, 0);
    const turf = m.ground.state.turf.map(id => opaque(fixtureCellRgb(id)));
    for (const [claim, row] of [[CLAIMS[14], 22], [CLAIMS[26], 28], [CLAIMS[50], 40]] as const) {
      expect(turf, `${row}`).toContainEqual(px(claim, 14, row - 1));
      expect(px(claim, 14, row), `${row}`).toEqual(opaque(fixtureCellRgb(road[12]!)));
      expect(px(claim, 14, row + 1), `${row}`).toEqual(opaque(fixtureCellRgb(C.cobbles)));
      expect(px(claim, 13, row), `${row}`).toEqual(opaque(fixtureCellRgb(C.edgeFirst + 12)));
    }
    expect(px(CLAIMS[14], 22, 7)).toEqual(opaque(fixtureCellRgb(rows(m).get(C.dirt)![2]!)));
  });
  it('pins the variants in the parity probes: ring tiles over the road and the yard under every probed claim, and the default beside the road', () => {
    const m = realmKitFixture(), probe = realmKitProbeFixture(m), road = rows(m).get(C.cobbles)!;
    for (const tiles of [14, 26, 50]) {
      const claim = fixtureClaim(tiles), ring = probe.filter(s => s.claim.min === claim.min && realmKitTileState(claim, s.tx, s.ty) === 'edge');
      // Both road columns on the south ring resolve to the cobbles row's mask-12 cell ((15, max) is also the mid-edge probe).
      expect(new Set(ring.filter(s => s.cells.base === road[12]).map(s => `${s.tx},${s.ty}`)), `${tiles}`).toEqual(new Set([`14,${claim.max}`, `15,${claim.max}`]));
      expect(ring.filter(s => s.tx === 13 && s.ty === claim.max).map(s => s.cells)).toEqual([{ water: 0, base: C.edgeFirst + 12, overlay: 0 }]);
      expect(ring.filter(s => s.tx === 16 && s.ty === claim.max).map(s => s.cells)).toEqual([{ water: 0, base: C.edgeFirst + 12, overlay: 0 }]);
      for (const s of ring) { expect(s.cells.water).toBe(0); expect(s.cells.overlay).toBe(0); }
    }
    const dirt = rows(m).get(C.dirt)!, yard = probe.filter(s => s.claim.min === 8 && fixtureDirtAt(s.tx, s.ty) && realmKitTileState(s.claim, s.tx, s.ty) === 'edge');
    expect(new Set(yard.map(s => `${s.tx},${s.ty}:${s.cells.base}`))).toEqual(new Set([`20,7:${dirt[3]}`, `21,7:${dirt[3]}`, `22,7:${dirt[2]}`, `22,8:${dirt[10]}`]));
    expect(probe.filter(s => s.claim.min !== 8 && s.cells.base >= C.variantFirst).every(s => fixtureCobblesAt(s.tx, s.ty))).toBe(true); // only the road under 26 and 50
    // Off the ring no probe carries a variant cell.
    for (const s of probe) if (realmKitTileState(s.claim, s.tx, s.ty) !== 'edge') expect(s.cells.base, `${s.tx},${s.ty}`).toBeLessThan(C.variantFirst);
  });
});

describe('realm kit cell resolution', () => {
  it('keys turf variants on absolute tile coordinates with the stated 32-bit mix, so buying an expansion never reshuffles existing kingdom ground', () => {
    const m = realmKitFixture();
    const mix = (tx: number, ty: number) => { // Independent BigInt model of the documented Kotlin arithmetic.
      const M = 0xffffffffn, mul = (a: bigint, b: bigint) => (a * b) & M, ushr = (a: bigint, n: bigint) => a >> n;
      const i32 = (n: number) => BigInt(n) & M;
      let h = mul(i32(tx), 0x27d4eb2dn) ^ mul(i32(ty), 0x165667b1n) ^ 0x5bd1e995n;
      h ^= ushr(h, 15n); h = mul(h, 0x2c1b3c6dn); h ^= ushr(h, 12n); h = mul(h, 0x297a2d39n); h ^= ushr(h, 15n);
      return Number(h);
    };
    for (const [tx, ty, pinned] of [[0, 0, 851924796], [-34, -34, 4209988391], [63, 63, 2185463103], [15, 15, 1044870719], [-10, 40, 2091324121], [1, -1, 2225299044]] as const) {
      expect(realmKitTileHash(tx, ty), `${tx},${ty}`).toBe(pinned);
      expect(mix(tx, ty)).toBe(pinned);
    }
    const seen = new Set<number>();
    for (let ty = -10; ty < 40; ty++) for (let tx = -10; tx < 40; tx++) {
      const cell = realmKitCell(m, CLAIMS[50], 'base', tx, ty);
      expect(m.ground.state.turf).toContain(cell);
      seen.add(cell);
      if (tx >= 8 && tx < 22 && ty >= 8 && ty < 22) expect(realmKitCell(m, CLAIMS[14], 'base', tx, ty)).toBe(cell);
      if (tx >= 2 && tx < 28 && ty >= 2 && ty < 28) expect(realmKitCell(m, CLAIMS[26], 'base', tx, ty)).toBe(cell);
      expect(realmKitCell(m, CLAIMS[50], 'overlay', tx, ty)).toBe(0);
      expect(realmKitCell(m, CLAIMS[50], 'water', tx, ty)).toBe(0);
    }
    expect(seen.size).toBe(2); // both variants actually appear
  });
  it('returns baked cells for wilderness and exterior, clears overlay only inside the claim, and nothing beyond the field', () => {
    const m = realmKitFixture();
    expect(realmKitCell(m, CLAIMS[14], 'base', 0, 0)).toBe(C.meadow);
    expect(realmKitCell(m, CLAIMS[14], 'base', 1, 0)).toBe(C.meadowAlt);
    expect(realmKitCell(m, CLAIMS[14], 'base', -34, -34)).toBe(C.forest);
    expect(realmKitCell(m, CLAIMS[14], 'base', 63, 63)).toBe(C.forest);
    expect(realmKitCell(m, CLAIMS[14], 'water', 55, 55)).toBe(C.water);
    expect(realmKitCell(m, CLAIMS[14], 'base', 55, 55)).toBe(C.bed); // open water carries the transparent bed on base (§7)
    expect(realmKitCell(m, CLAIMS[14], 'water', 49, 55)).toBe(0);
    expect(realmKitCell(m, CLAIMS[14], 'base', 49, 55)).toBe(C.forest);
    expect(realmKitCell(m, CLAIMS[14], 'overlay', 20, FIXTURE_ROAD_ROW)).toBe(C.road);
    const flower = [...Array(50).keys()].map(i => i - 10).flatMap(ty => [...Array(50).keys()].map(i => i - 10).map(tx => [tx, ty] as const))
      .find(([tx, ty]) => fixtureFlowerAt(tx, ty) && realmKitTileState(CLAIMS[14], tx, ty) === 'wilderness')!;
    expect(realmKitCell(m, CLAIMS[14], 'overlay', ...flower)).toBe(C.flower);
    expect(realmKitCell(m, CLAIMS[50], 'overlay', ...flower)).toBe(0);
    // Edge clamp (owner: "waters are cut off … fill that till the end"): within REALM_KIT.edgeExtendTiles
    // beyond the field a tile takes the nearest field tile's water/base cell, never a decal; farther out nothing.
    const E = REALM_KIT.edgeExtendTiles;
    for (const [tx, ty, ftx, fty] of [[-35, 0, -34, 0], [0, -35, 0, -34], [64, 0, 63, 0], [0, 64, 0, 63], [-34 - E, 63 + E, -34, 63], [55, 63 + E, 55, 63]]) {
      expect(realmKitCell(m, CLAIMS[14], 'base', tx!, ty!), `base ${tx},${ty}`).toBe(realmKitCell(m, CLAIMS[14], 'base', ftx!, fty!));
      expect(realmKitCell(m, CLAIMS[14], 'water', tx!, ty!), `water ${tx},${ty}`).toBe(realmKitCell(m, CLAIMS[14], 'water', ftx!, fty!));
      expect(realmKitCell(m, CLAIMS[14], 'overlay', tx!, ty!), `overlay ${tx},${ty}`).toBe(0);
    }
    // The river arms reach the field's east and south edges, so the water clamp is pinned against WATER, never 0 == 0:
    // the water runs on through the whole margin on both layers and stops at the extent.
    const r = FIXTURE_RIVER.min;
    expect(realmKitCell(m, CLAIMS[14], 'water', 63, r)).toBe(C.water); expect(realmKitCell(m, CLAIMS[14], 'water', r, 63)).toBe(C.water);
    for (const [tx, ty] of [[64, r], [63 + E, r], [r, 64], [r, 63 + E]]) {
      expect(realmKitCell(m, CLAIMS[14], 'water', tx!, ty!), `water ${tx},${ty}`).toBe(C.water);
      expect(realmKitCell(m, CLAIMS[14], 'base', tx!, ty!), `base ${tx},${ty}`).toBe(C.bed);
    }
    expect(realmKitCell(m, CLAIMS[14], 'water', 64 + E, r)).toBe(0); expect(realmKitCell(m, CLAIMS[14], 'water', r, 64 + E)).toBe(0);
    expect(realmKitCell(m, CLAIMS[14], 'water', -35, r)).toBe(0); // the west edge clamps to a dry field tile
    // The road reaches the field's east edge (row FIXTURE_ROAD_ROW, tx ≥ 15), so the overlay rule is pinned against a
    // DECAL, never 0 == 0: decals do not repeat outward — the margin beside the road end is bare on overlay while base clamps.
    expect(realmKitCell(m, CLAIMS[14], 'overlay', 63, FIXTURE_ROAD_ROW)).toBe(C.road);
    expect(realmKitCell(m, CLAIMS[14], 'overlay', 64, FIXTURE_ROAD_ROW)).toBe(0); expect(realmKitCell(m, CLAIMS[14], 'overlay', 63 + E, FIXTURE_ROAD_ROW)).toBe(0);
    expect(realmKitCell(m, CLAIMS[14], 'base', 64, FIXTURE_ROAD_ROW)).toBe(realmKitCell(m, CLAIMS[14], 'base', 63, FIXTURE_ROAD_ROW));
    for (const [tx, ty] of [[-35 - E, 0], [0, -35 - E], [64 + E, 0], [0, 64 + E], [1000, 1000]]) for (const id of REALM_KIT_LAYER_IDS) expect(realmKitCell(m, CLAIMS[14], id, tx!, ty!)).toBe(0);
    // A manifest without a water layer simply has no water anywhere.
    m.ground.layers.splice(0, 1);
    expect(realmKitCell(m, CLAIMS[14], 'water', 55, 55)).toBe(0);
  });
  it('maps a cell frame to a 32-px source rect stepping right, so animated water addresses the same texels on every client', () => {
    const m = realmKitFixture();
    expect(realmKitCellSource(m, C.water, 3)).toEqual({ asset: m.assets[0], source: { x: 96, y: 96, width: 32, height: 32 } });
    expect(realmKitCellSource(m, C.meadow, 0).source).toEqual({ x: 0, y: 0, width: 32, height: 32 });
    for (const [cell, frame] of [[0, 0], [C.meadow, 1], [C.water, 4], [99, 0], [1.5, 0]]) expect(() => realmKitCellSource(m, cell!, frame!)).toThrow();
  });
});

describe('realm kit floor plan', () => {
  const T = 64;
  it('emits only tiles that intersect the view and every non-empty one inside it, so scrolling never pops a tile late', () => {
    const m = realmKitFixture(), claim = CLAIMS[26];
    for (const view of [{ x: -700, y: -700, width: 1400, height: 1400 }, { x: 3100, y: 3100, width: 700, height: 500 },
      { x: -2176 - 300, y: -2176 - 300, width: 900, height: 900 }, { x: 5000, y: 5000, width: 100, height: 100 }, { x: 0, y: 0, width: 1, height: 1 }]) {
      const plan = realmKitFloorPlan(m, T, view, claim, 0, false);
      const seen = new Set<string>();
      for (const t of plan.tiles) {
        expect(layeredIntersects(t.destination, view), JSON.stringify(t)).toBe(true);
        expect(t.destination).toEqual({ x: t.tx * T, y: t.ty * T, width: T, height: T });
        expect(t.cell).toBe(realmKitCell(m, claim, t.layer, t.tx, t.ty));
        seen.add(`${t.layer}:${t.tx}:${t.ty}`);
      }
      let expected = 0;
      const E = REALM_KIT.edgeExtendTiles; // the plan covers the edge-clamped margin as well as the field
      for (let ty = O - E; ty < O + N + E; ty++) for (let tx = O - E; tx < O + N + E; tx++) for (const id of REALM_KIT_LAYER_IDS) {
        if (layeredIntersects({ x: tx * T, y: ty * T, width: T, height: T }, view) && realmKitCell(m, claim, id, tx, ty)) { expected++; expect(seen.has(`${id}:${tx}:${ty}`)).toBe(true); }
      }
      expect(plan.tiles).toHaveLength(expected);
      expect(plan.far.destination).toEqual(view);
    }
  });
  it('is deterministic and orders draws layer-major then row-major, which native chunk batches rely on', () => {
    const m = realmKitFixture(), view = { x: -400, y: -400, width: 1200, height: 900 };
    const a = realmKitFloorPlan(m, T, view, CLAIMS[14], 1234, false), b = realmKitFloorPlan(realmKitFixture(), T, view, CLAIMS[14], 1234, false);
    expect(a).toEqual(b);
    const order = a.tiles.map(t => `${REALM_KIT_LAYER_IDS.indexOf(t.layer)}:${t.ty}:${t.tx}`);
    const key = (s: string) => s.split(':').map(Number);
    for (let i = 1; i < order.length; i++) {
      const [la, ya, xa] = key(order[i - 1]!), [lb, yb, xb] = key(order[i]!);
      expect(la! < lb! || (la === lb && (ya! < yb! || (ya === yb && xa! < xb!))), `${order[i - 1]} before ${order[i]}`).toBe(true);
    }
  });
  it('pins frame 0 under reduced motion and advances ⌊elapsed/duration⌋ mod frames otherwise, so a still is always frame 0', () => {
    const m = realmKitFixture(), view = { x: 55 * T, y: 55 * T, width: T, height: T };
    const frame = (elapsed: number, reduced: boolean) => realmKitFloorPlan(m, T, view, CLAIMS[14], elapsed, reduced).tiles.find(t => t.layer === 'water')!.frame;
    expect([0, 249, 250, 260, 749, 750, 1000, 1990].map(e => frame(e, false))).toEqual([0, 0, 1, 1, 2, 3, 0, 3]);
    expect([0, 260, 1990].map(e => frame(e, true))).toEqual([0, 0, 0]);
    expect(realmKitFloorPlan(m, T, view, CLAIMS[14], 1990, false).tiles.find(t => t.layer === 'base')!.frame).toBe(0);
    for (const bad of [[NaN, false], [-1, false]] as const) expect(() => realmKitFloorPlan(m, T, view, CLAIMS[14], bad[0], bad[1])).toThrow();
  });
  it('mirrors the revision-4 far repeat primitive scaled to renderer tiles, so battle coverage beyond the field is one draw', () => {
    const m = realmKitFixture(); m.ground.far.origin = { x: 17, y: -21 };
    const view = { x: -20000, y: -18000, width: 50000, height: 41000 };
    const { far } = realmKitFloorPlan(m, T, view, CLAIMS[14], 0, true);
    expect(far).toEqual({ id: 'floor-far', asset: m.assets[1], frame: 0, source: { x: 0, y: 0, width: 64, height: 64 }, destination: view,
      repeat: { origin: { x: 34, y: -42 }, period: { width: 128, height: 128 } } });
    expect(realmKitFloorPlan(m, T, { ...view, x: view.x + 1 }, CLAIMS[14], 0, true).far.repeat).toEqual(far.repeat);
  });
  // Rewritten for §2 ring variants (was "the ring draws its Wang cells" = edge.cells[mask] everywhere): where the ring
  // crosses the road or the yard it draws the baked cell's own variant for the mask, so the road meets the land through
  // turf-road instead of stopping in the meadow (K-177 road end); the default ring stays everywhere else.
  it('renders kingdom turf and no overlay inside the claim while the ring draws its Wang cells — the baked cell\'s variant over the road and the yard, the default elsewhere', () => {
    const m = realmKitFixture(), claim = CLAIMS[14];
    const plan = realmKitFloorPlan(m, T, { x: 6 * T, y: 6 * T, width: 18 * T, height: 18 * T }, claim, 0, true);
    const rows = new Map(m.ground.state.edge.variants!.map(v => [v.cell, v.cells]));
    let variants = 0;
    for (const t of plan.tiles) {
      const state = realmKitTileState(claim, t.tx, t.ty);
      if (state === 'kingdom') { expect(t.layer).toBe('base'); expect(m.ground.state.turf).toContain(t.cell); }
      if (state === 'edge') {
        expect(t.layer).toBe('base');
        const mask = realmKitEdgeMask(claim, t.tx, t.ty), row = rows.get(fixtureCobblesAt(t.tx, t.ty) ? C.cobbles : fixtureDirtAt(t.tx, t.ty) ? C.dirt : 0);
        expect(t.cell, `${t.tx},${t.ty}`).toBe(row?.[mask] || m.ground.state.edge.cells[mask]);
        if (row) { expect(t.cell).toBeGreaterThanOrEqual(C.variantFirst); variants++; }
      }
    }
    expect(plan.tiles.filter(t => realmKitTileState(claim, t.tx, t.ty) === 'kingdom')).toHaveLength(14 * 14);
    expect(plan.tiles.filter(t => realmKitTileState(claim, t.tx, t.ty) === 'edge')).toHaveLength(16 * 4 - 4);
    expect(variants).toBe(2 + 4); // the two road tiles on the south ring, the yard's two north, one corner and one east tile
  });
  it('fails loud above the floor tile cap instead of allocating an unbounded quad list', () => {
    const m = realmKitFixture();
    for (const layer of m.ground.layers) layer.rle = encodeRealmKitRle(fixtureGrid(() => C.forest));
    // Three full layers over the whole edge-clamped extent exceed the cap; the fixture's real field does not, even over the extent.
    const E = REALM_KIT.edgeExtendTiles, extent = { x: (O - E) * T, y: (O - E) * T, width: (N + 2 * E) * T, height: (N + 2 * E) * T };
    expect(() => realmKitFloorPlan(m, T, extent, CLAIMS[14], 0, true)).toThrow('Invalid realm kit manifest');
    expect(() => realmKitFloorPlan(realmKitFixture(), T, extent, CLAIMS[14], 0, true)).not.toThrow();
    for (const view of [{ ...extent, width: Infinity }, { ...extent, x: NaN }, { ...extent, height: 0 }]) expect(() => realmKitFloorPlan(m, T, view, CLAIMS[14], 0, true)).toThrow();
    expect(() => realmKitFloorPlan(m, 0, extent, CLAIMS[14], 0, true)).toThrow();
  });
});

describe('realm kit props, obstacles and overview', () => {
  // Rewritten for §7 (was "produces byte-for-byte the revision-4 placement plan"): props come from uniform-cell
  // sheets and own their frame math, so the r4 plan is no longer the oracle — the frame rule below is.
  it('draws a still at its `frame`, a clip at frame + ⌊elapsed/duration⌋ mod frames, and pins the still under reduced motion or in the background', () => {
    const m = realmKitFixture(), east = { x: 2900, y: 2800, width: 400, height: 400 }, west = { x: -1500, y: 250, width: 200, height: 200 };
    const frames = (view: typeof east, elapsed: number, reduced: boolean, background = false) => realmKitPropPlan(m, 64, view, CLAIMS[14], elapsed, reduced, background).map(d => d.frame);
    expect([0, 99, 100, 199, 200, 350].map(e => frames(east, e, false))).toEqual([[0], [0], [1], [1], [0], [1]]);
    expect([0, 150, 999].map(e => frames(east, e, true))).toEqual([[0], [0], [0]]);
    expect([0, 150, 999].map(e => frames(east, e, false, true))).toEqual([[0], [0], [0]]);
    expect([0, 150, 999].map(e => frames(west, e, false))).toEqual([[2], [2], [2]]);
    const [oak] = realmKitPropPlan(m, 64, east, CLAIMS[14], 150, false);
    expect(oak).toEqual({ id: 'oak-east', asset: m.assets[3], frame: 1, destination: { x: 2968, y: 2904, width: 64, height: 96 }, source: { x: 32, y: 0, width: 32, height: 48 } });
    const [dead] = realmKitPropPlan(m, 64, west, CLAIMS[14], 150, false);
    expect(dead).toEqual({ id: 'oak-dead-west', asset: m.assets[3], frame: 2, destination: { x: -1432, y: 304, width: 64, height: 96 }, source: { x: 0, y: 48, width: 32, height: 48 } });
    // A clip starting past cell 0 walks its own cells and never wraps to the sheet's first cell.
    m.placements[0]!.frame = 2;
    expect([0, 100, 200].map(e => frames(east, e, false))).toEqual([[2], [3], [2]]);
    expect(realmKitPlacementFrame(m.placements[0]!, 100, false)).toBe(3);
    expect(realmKitPlacementFrame(m.placements[0]!, 100, true)).toBe(2);
    const { frame: _f, clip: _c, ...bare } = m.placements[0]!;
    expect(realmKitPlacementFrame(bare as RealmKitPlacement, 100, false)).toBe(0); // no frame → cell 0
    expect(realmKitSpriteSource(m.assets[3]!, 3)).toEqual({ x: 32, y: 48, width: 32, height: 48 });
    expect(realmKitSpriteSource(m.assets[5]!, 2)).toEqual({ x: 32, y: 0, width: 16, height: 16 });
    for (const frame of [4, -1, 1.5]) expect(() => realmKitSpriteSource(m.assets[3]!, frame)).toThrow('Invalid realm kit manifest');
  });
  // Rewritten for D-173 creature paths (was "by layer then manifest order"): with animals walking among the
  // props, the ground band needs one painter's order — bottom-seated sprites by their anchor row, whatever
  // their low/tall layer — or a hen north of a hay bale (layer 0) would be drawn over it while a deer south of
  // a tree (layer 1) hid behind the trunk. Only REALM_KIT.airLayer and above (birds, smoke) stack over the band.
  it('culls to the scaled bounds and orders draws by the painter\'s band then the anchor row then manifest order, the stacking every client and the rasterizer share', () => {
    const m = realmKitFixture(), all = { x: -3000, y: -3000, width: 8000, height: 8000 };
    expect(realmKitPropPlan(m, 64, { x: 0, y: 0, width: 10, height: 10 }, CLAIMS[14], 0, false)).toEqual([]);
    // Anchor rows: stump −600 (layer 0), dead oak 200, frame oak 512, east oak 1500 (layer 1): south is in front.
    expect(realmKitPropPlan(m, 64, all, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['stump-north', 'oak-dead-west', 'oak-frame-east', 'oak-east']);
    const stump = m.placements[1]!, oak = m.placements[0]!, dead = m.placements[2]!;
    // A low prop south of a tall one draws over it (the bush in front of the trunk), a tall one south of a low one likewise.
    m.placements = [{ ...dead, layer: 1 }, { ...oak, layer: 1 }, { ...stump, layer: 0, y: 1600 }];
    expect(realmKitPropPlan(m, 64, all, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['oak-dead-west', 'oak-east', 'stump-north']);
    m.placements[2]!.y = 1500; // a tie on the anchor row keeps manifest order
    expect(realmKitPropPlan(m, 64, all, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['oak-dead-west', 'oak-east', 'stump-north']);
    m.placements = [{ ...stump, layer: 0, y: 1500 }, { ...dead, layer: 1 }, { ...oak, layer: 1 }];
    expect(realmKitPropPlan(m, 64, all, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['oak-dead-west', 'stump-north', 'oak-east']);
    // The air band: a layer ≥ REALM_KIT.airLayer draws over every ground prop however far north it is.
    m.placements = [{ ...dead, layer: 1 }, { ...oak, layer: 1 }, { ...stump, layer: REALM_KIT.airLayer }];
    expect(realmKitPropPlan(m, 64, all, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['oak-dead-west', 'oak-east', 'stump-north']);
    m.placements = [{ ...dead, layer: 1 }, { ...oak, layer: 1 }, { ...stump, layer: 0 }];
    expect(realmKitPropPlan(m, 64, all, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['stump-north', 'oak-dead-west', 'oak-east']);
    // The dead oak's scaled bounds are x −1432..−1368, y 304..400: touching one world pixel lists it, one pixel above does not.
    expect(realmKitPropPlan(m, 64, { x: -1432, y: 304, width: 1, height: 1 }, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['oak-dead-west']);
    expect(realmKitPropPlan(m, 64, { x: -1432, y: 303, width: 1, height: 1 }, CLAIMS[14], 0, false)).toEqual([]);
    expect(realmKitPropPlan(m, 32, { x: -716, y: 152, width: 1, height: 1 }, CLAIMS[14], 0, false).map(d => d.id)).toEqual(['oak-dead-west']);
    // A backgrounded scene still lists its (culled) props, pinned to the still, unlike the r4 plan.
    expect(realmKitPropPlan(m, 64, all, CLAIMS[14], 150, false, true).map(d => [d.id, d.frame])).toEqual([['stump-north', 0], ['oak-dead-west', 2], ['oak-east', 0]]);
    // E-6 amended: the frame-seated oak (tile 30,15) shows under claims whose ring stops short of tile 30 and vanishes once it is owned or ringed.
    const seated = realmKitFixture();
    expect(realmKitPropPlan(seated, 64, all, CLAIMS[26], 0, false).map(d => d.id)).toContain('oak-frame-east');
    expect(realmKitPropPlan(seated, 64, all, fixtureClaim(30), 0, false).map(d => d.id)).not.toContain('oak-frame-east');
    expect(realmKitPropPlan(seated, 64, all, CLAIMS[50], 0, false).map(d => d.id)).toEqual(['stump-north', 'oak-dead-west', 'oak-east']);
    expect(realmKitPlacementSeat(seated.placements[3]!)).toEqual({ tx: 30, ty: 15 });
    expect(realmKitPlacementSeat({ ...seated.placements[3]!, x: 31 * 32 + 32, y: 17 * 32 })).toEqual({ tx: 32, ty: 16 }); // 2×2 footprint → right column, last row
    expect(realmKitPlacementHidden(seated.placements[3]!, { min: 14, max: 30 })).toBe(true); // the ring reaches tile 30
    expect(realmKitPlacementHidden(seated.placements[3]!, { min: 14, max: 29 })).toBe(false); // ring ends at 29
    expect(() => realmKitPropPlan(seated, 64, all, { min: 5, max: 5 }, 0, false)).toThrow();
    for (const [elapsed, reduced] of [[NaN, false], [-1, false], [Infinity, true]] as const) expect(() => realmKitPropPlan(m, 64, all, CLAIMS[14], elapsed, reduced)).toThrow();
    expect(() => realmKitPropPlan(m, 0, all, CLAIMS[14], 0, false)).toThrow();
    for (const view of [{ ...all, width: Infinity }, { ...all, x: NaN }, { ...all, height: 0 }]) expect(() => realmKitPropPlan(m, 64, view, CLAIMS[14], 0, false)).toThrow();
    m.placements[0]!.asset = 'nope';
    expect(() => realmKitPropPlan(m, 64, all, CLAIMS[14], 0, false)).toThrow();
  });
  it('maps server obstacle rows to kit sprites by state, keeps the dec_ fallback for unmapped keys and rejects unknown keys', () => {
    const m = realmKitFixture();
    expect(realmKitObstacleSprite(m, 'tree_old', 'intact')?.id).toBe('oak');
    expect(realmKitObstacleSprite(m, 'tree_old', 'clearing')?.id).toBe('oak');
    expect(realmKitObstacleSprite(m, 'tree_old', 'remnant')?.id).toBe('oak-stump');
    m.obstacleSprites.tree_old!.clearing = 'gull';
    expect(realmKitObstacleSprite(m, 'tree_old', 'clearing')?.id).toBe('gull');
    expect(realmKitObstacleSprite(m, 'boulder', 'intact')).toBeUndefined();
    expect(() => realmKitObstacleSprite(m, 'dragon', 'intact')).toThrow();
    expect(() => realmKitObstacleSprite(m, 'stump', 'burning' as never)).toThrow();
    m.obstacleSprites.stump!.remnant = 'gone';
    expect(() => realmKitObstacleSprite(m, 'stump', 'remnant')).toThrow();
  });
  it('draws the overview still over the field plus a paddingColor kingdom fill, culled to the view, so the zoom floor never draws tiles', () => {
    const m = realmKitFixture(), field = { x: -2176, y: -2176, width: 6272, height: 6272 };
    const plan = realmKitOverviewPlan(m, 64, { x: -3000, y: -3000, width: 8000, height: 8000 }, CLAIMS[26]);
    expect(plan.far.id).toBe('floor-far');
    expect(plan.overview).toEqual({ id: 'floor-overview', asset: m.assets[2], frame: 0, source: { x: 0, y: 0, width: 196, height: 196 }, destination: field });
    expect(plan.kingdom).toEqual({ destination: { x: 128, y: 128, width: 26 * 64, height: 26 * 64 }, color: '#6f7a3a' });
    const away = realmKitOverviewPlan(m, 64, { x: 9000, y: 9000, width: 10, height: 10 }, CLAIMS[26]);
    expect(away.overview).toBeUndefined(); expect(away.margin).toEqual([]); expect(away.kingdom).toBeUndefined();
    expect(away.far.destination).toEqual({ x: 9000, y: 9000, width: 10, height: 10 });
    expect(realmKitOverviewPlan(m, 64, { x: -2000, y: -2000, width: 10, height: 10 }, CLAIMS[26]).kingdom).toBeUndefined();
    delete m.ground.overview;
    expect(() => realmKitOverviewPlan(m, 64, field, CLAIMS[26])).toThrow();
  });
  it('draws the edge-clamped margin below the zoom floor from the still\'s outer rows and columns, so a river leaving the field runs on at the zoom floor too', () => {
    // Owner: "waters are cut off, we need to fill that till the end". The tile LOD clamps every margin tile to
    // its nearest field tile (realmKitCell); before this the still covered the field only, so the margin was
    // the far repeat again exactly in the zoom band where a phone view reaches past the field.
    const m = realmKitFixture(), T = 64, E = REALM_KIT.edgeExtendTiles, px = m.ground.overview!.pxPerTile, still = N * px;
    const extent = { x: (O - E) * T, y: (O - E) * T, width: (N + 2 * E) * T, height: (N + 2 * E) * T };
    const plan = realmKitOverviewPlan(m, T, extent, CLAIMS[26]);
    expect(plan.margin.map(d => d.id)).toEqual(['floor-margin-nw', 'floor-margin-n', 'floor-margin-ne', 'floor-margin-w', 'floor-margin-e', 'floor-margin-sw', 'floor-margin-s', 'floor-margin-se']);
    // The eight rects plus the field tile the extent exactly: same area, no two overlap.
    const rects = [plan.overview!.destination, ...plan.margin.map(d => d.destination)];
    expect(rects.reduce((s, r) => s + r.width * r.height, 0)).toBe(extent.width * extent.height);
    rects.forEach((a, i) => rects.forEach((b, j) => { if (i !== j) expect(layeredIntersects(a, b)).toBe(false); }));
    for (const d of plan.margin) expect(d.asset).toBe(plan.overview!.asset);
    // Tile for tile the strips are realmKitCell's clamp: on an axis outside the field a margin tile draws the
    // block of the field's edge tile on that side (the strip's source is that one tile row/column of the still);
    // on the axis inside the field the strip spans the whole still over the whole field, so tx keeps its own block.
    const clamp = (t: number) => t < O ? O : t >= O + N ? O + N - 1 : t;
    const covering = (tx: number, ty: number) => plan.margin.filter(d => layeredIntersects(d.destination, { x: tx * T, y: ty * T, width: T, height: T }));
    const samples: [number, number][] = [[O - E, O - E], [O - 1, O + 10], [O + N, O + N - 1], [O + 40, O - E], [O + 3, O + N + E - 1], [O + N + E - 1, O + N + E - 1], [O - E, O + N + 1]];
    for (const [tx, ty] of samples) {
      const [d, ...rest] = covering(tx, ty);
      expect(rest).toEqual([]); expect(d).toBeDefined();
      for (const [t, lo, size, sLo, sSize] of [[tx, d!.destination.x, d!.destination.width, d!.source.x, d!.source.width], [ty, d!.destination.y, d!.destination.height, d!.source.y, d!.source.height]] as const) {
        if (t < O || t >= O + N) { expect([lo, size]).toEqual([t < O ? (O - E) * T : (O + N) * T, E * T]); expect([sLo, sSize]).toEqual([(clamp(t) - O) * px, px]); }
        else { expect([lo, size]).toEqual([O * T, N * T]); expect([sLo, sSize]).toEqual([0, still]); }
      }
    }
    // Beyond the extent nothing but the far repeat; a view over the east margin alone still gets its strips.
    expect(covering(O + N + E, O)).toEqual([]);
    const east = realmKitOverviewPlan(m, T, { x: (O + N + 5) * T, y: (O + 20) * T, width: 10 * T, height: 10 * T }, CLAIMS[26]);
    expect(east.overview).toBeUndefined(); expect(east.margin.map(d => d.id)).toEqual(['floor-margin-e']);
  });
});

describe('realm kit creature paths (D-173, owner 2026-09-21: animals animated and moving to all sides)', () => {
  const m = realmKitFixture(), field = { ...REALM_KIT_FIELD };
  const draw = (id: string, elapsedMs: number, reducedMotion = false, background = false, view = field, tilePixels = 32) =>
    realmKitPathPlan(m, tilePixels, view, elapsedMs, reducedMotion, background).find(d => d.id === id);
  it('walks the polyline at `speed` art px/s with integer-only arithmetic, so a deer stands on the same pixel on web, native and the deed', () => {
    // isqrt is exact floor(sqrt) without Math.sqrt (the Kotlin mirror uses Long Newton steps).
    for (const [n, root] of [[0, 0], [1, 1], [2, 1], [3, 1], [4, 2], [15, 3], [16, 4], [99, 9], [100, 10], [100000, 316], [340000, 583], [2 ** 40 - 1, 2 ** 20 - 1], [2 ** 40, 2 ** 20]]) expect(realmKitIsqrt(n!), String(n)).toBe(root);
    expect(() => realmKitIsqrt(-1)).toThrow(); expect(() => realmKitIsqrt(1.5)).toThrow();
    // hare-walk: a 200-px square at 100 px/s (2000 ms a side) with a 500 ms dwell at every corner → period 10 000 ms.
    const walk = realmKitResolvePath(m, m.paths[1]!);
    expect(walk).toMatchObject({ directions: 4, frames: 2, frameDurationMs: 100, dwellMs: 500, loop: 'cycle', layer: 1 });
    expect(realmKitPathPose(walk, 0, false)).toEqual({ x: 1500, y: -900, facing: 'right', dx: 200, dy: 0, dwelling: true });
    expect(realmKitPathPose(walk, 499, false).dwelling).toBe(true);
    expect(realmKitPathPose(walk, 500, false)).toMatchObject({ x: 1500, y: -900, dwelling: false });
    expect(realmKitPathPose(walk, 700, false)).toMatchObject({ x: 1520, y: -900, facing: 'right' }); // 200 px × 200 / 2000 ms
    expect(realmKitPathPose(walk, 1234, false)).toMatchObject({ x: 1573, y: -900 }); // ⌊200 × 734 / 2000⌋ = 73
    expect(realmKitPathPose(walk, 2499, false)).toMatchObject({ x: 1699, y: -900, dwelling: false });
    expect(realmKitPathPose(walk, 2500, false)).toEqual({ x: 1700, y: -900, facing: 'down', dx: 0, dy: 200, dwelling: true });
    expect(realmKitPathPose(walk, 5000, false)).toMatchObject({ x: 1700, y: -700, facing: 'left', dwelling: true });
    expect(realmKitPathPose(walk, 7777, false)).toMatchObject({ x: 1500, y: -700, facing: 'up', dwelling: true });
    expect(realmKitPathPose(walk, 9000, false)).toMatchObject({ x: 1500, y: -800, facing: 'up', dwelling: false });
    expect(realmKitPathPose(walk, 10000, false)).toEqual(realmKitPathPose(walk, 0, false)); // the period wraps
    expect(realmKitPathPose(walk, 12345, false)).toMatchObject({ x: 1684, y: -900, facing: 'right', dwelling: false });
    expect(realmKitPathPose(walk, 61234, false)).toEqual(realmKitPathPose(walk, 1234, false));
    // Reduced motion / background: the first vertex facing along the first segment, whatever the clock.
    expect(realmKitPathPose(walk, 7777, true)).toEqual(realmKitPathPose(walk, 0, false));
  });
  it('faces each segment by its dominant axis and reads the sheet row for it, so the walk cycle of the facing ahead plays', () => {
    expect(realmKitSegmentFacing(200, 0)).toBe('right'); expect(realmKitSegmentFacing(-1, 0)).toBe('left');
    expect(realmKitSegmentFacing(3, 3)).toBe('right'); expect(realmKitSegmentFacing(-3, 3)).toBe('left'); // ties go to the side rows
    expect(realmKitSegmentFacing(2, 3)).toBe('down'); expect(realmKitSegmentFacing(2, -3)).toBe('up'); expect(realmKitSegmentFacing(0, 0)).toBe('right');
    expect(REALM_KIT_FACINGS).toEqual(['down', 'left', 'right', 'up']);
    for (const [i, f] of REALM_KIT_FACINGS.entries()) expect(realmKitFacingRow(4, f, 0)).toBe(i);
    // Two rows [left, right]: up/down lean on the x component's sign.
    expect(realmKitFacingRow(2, 'left', -5)).toBe(0); expect(realmKitFacingRow(2, 'right', 5)).toBe(1);
    expect(realmKitFacingRow(2, 'down', -1)).toBe(0); expect(realmKitFacingRow(2, 'down', 0)).toBe(1); expect(realmKitFacingRow(2, 'up', 3)).toBe(1);
    for (const f of REALM_KIT_FACINGS) expect(realmKitFacingRow(1, f, -9)).toBe(0);
    // The draw's sheet cell is row × frames + walk frame: frame 0 while dwelling, ⌊elapsed / 100⌋ mod 2 on the move.
    expect(draw('hare-walk', 0)).toMatchObject({ facing: 'right', frame: 4, anchor: { x: 1500, y: -900 }, layer: 1, destination: { x: 1492, y: -916, width: 16, height: 16 } });
    expect(draw('hare-walk', 0)!.source).toEqual(realmKitSpriteSource(m.assets[6]!, 4));
    expect(draw('hare-walk', 500)!.frame).toBe(5); expect(draw('hare-walk', 700)!.frame).toBe(5); expect(draw('hare-walk', 1234)!.frame).toBe(4);
    expect(draw('hare-walk', 2500)).toMatchObject({ facing: 'down', frame: 0 });
    expect(draw('hare-walk', 3000)).toMatchObject({ facing: 'down', frame: 0 }); expect(draw('hare-walk', 3100)).toMatchObject({ facing: 'down', frame: 1 });
    expect(draw('hare-walk', 5000)).toMatchObject({ facing: 'left', frame: 2 });
    expect(draw('hare-walk', 7777)).toMatchObject({ facing: 'up', frame: 6 });
    expect(draw('hare-walk', 9999)).toMatchObject({ facing: 'up', frame: 7, anchor: { x: 1500, y: -900 } });
    // The renderer scale moves the destination, never the pose: 64 px/tile doubles it.
    expect(draw('hare-walk', 700, false, false, { x: -3000, y: -3000, width: 9000, height: 9000 }, 64)!.destination).toEqual({ x: (1520 - 8) * 2, y: (-900 - 16) * 2, width: 32, height: 32 });
  });
  it('paces an open path there and back under pingpong and cycles a closed loop, while a one-row sprite ignores facing', () => {
    // hare-pace: (1600,1500)→(1700,1800) is 316 px (⌊√100000⌋) → 3160 ms each way, no dwell → period 6320 ms.
    const pace = realmKitResolvePath(m, m.paths[2]!);
    expect(pace.loop).toBe('pingpong'); expect(pace.dwellMs).toBe(0);
    expect(realmKitPathPose(pace, 0, false)).toEqual({ x: 1600, y: 1500, facing: 'down', dx: 100, dy: 300, dwelling: false });
    expect(realmKitPathPose(pace, 700, false)).toMatchObject({ x: 1622, y: 1566, facing: 'down' });
    expect(realmKitPathPose(pace, 3160, false)).toEqual({ x: 1700, y: 1800, facing: 'up', dx: -100, dy: -300, dwelling: false });
    expect(realmKitPathPose(pace, 5000, false)).toMatchObject({ x: 1641, y: 1625, facing: 'up' }); // ⌊−100 × 1840 / 3160⌋ = −59 (floor, not truncation)
    expect(realmKitPathPose(pace, 6320, false)).toEqual(realmKitPathPose(pace, 0, false));
    expect(draw('hare-pace', 0)!.frame).toBe(0); expect(draw('hare-pace', 700)!.frame).toBe(1); expect(draw('hare-pace', 3160)!.frame).toBe(7); expect(draw('hare-pace', 5000)!.frame).toBe(6);
    // A three-point pingpong unfolds to A B C B A: the middle vertex is walked in both directions.
    const tri = realmKitResolvePath(m, { ...m.paths[2]!, points: [{ x: 1600, y: 1500 }, { x: 1700, y: 1500 }, { x: 1700, y: 1600 }], speed: 100 });
    expect(realmKitPathPose(tri, 500, false)).toMatchObject({ x: 1650, y: 1500, facing: 'right' });
    expect(realmKitPathPose(tri, 1500, false)).toMatchObject({ x: 1700, y: 1550, facing: 'down' });
    expect(realmKitPathPose(tri, 2500, false)).toMatchObject({ x: 1700, y: 1550, facing: 'up' });
    expect(realmKitPathPose(tri, 3500, false)).toMatchObject({ x: 1650, y: 1500, facing: 'left' });
    expect(realmKitPathPose(tri, 4000, false)).toEqual(realmKitPathPose(tri, 0, false));
    // An open cycle teleports back: gulls (directions 1, frames 3 @ 100 ms) at 40 px/s over 583 + 2500 px → period 77 075 ms.
    const gulls = realmKitResolvePath(m, m.paths[0]!);
    expect(gulls).toMatchObject({ directions: 1, frames: 3, frameDurationMs: 100, dwellMs: 0, loop: 'cycle', layer: 2 });
    expect(realmKitPathPose(gulls, 77074, false)).toMatchObject({ x: 1900, y: 1899, dwelling: false });
    expect(realmKitPathPose(gulls, 77075, false)).toMatchObject({ x: 1400, y: -900 });
    expect(draw('gulls', 250)).toMatchObject({ frame: 2, facing: 'right', layer: 2 }); // one row: the walk frame alone
    // Two rows [left, right] for a side-only sheet: a vertical segment borrows the side its x leans to.
    const twoRow: RealmKitPath = { ...m.paths[1]!, id: 'hare-side', directions: 2, frames: 4, points: [{ x: 1500, y: -900 }, { x: 1499, y: -700 }, { x: 1500, y: -900 }] };
    const side = realmKitResolvePath({ ...m, paths: [twoRow] }, twoRow);
    expect(realmKitPathPose(side, 600, false)).toMatchObject({ facing: 'down', dx: -1 });
    expect(realmKitPathPlan({ ...m, paths: [twoRow] }, 32, field, 600, false)[0]!.frame).toBe(0 * 4 + 2); // row left, walk frame ⌊600/100⌋ mod 4
    expect(realmKitPathPlan({ ...m, paths: [twoRow] }, 32, field, 3100, false)[0]!.frame).toBe(1 * 4 + 3); // back up: dx +1 → row right
    // A path whose every segment is shorter than a millisecond of travel stands at its first vertex.
    const still = realmKitResolvePath(m, { ...m.paths[2]!, points: [{ x: 1600, y: 1500 }, { x: 1600, y: 1500 }], speed: 4096 });
    expect(realmKitPathPose(still, 999, false)).toMatchObject({ x: 1600, y: 1500, facing: 'right', dwelling: true });
  });
  it('culls by the scaled sprite bounds and pins reduced motion or a backgrounded scene to the first vertex at frame 0', () => {
    expect(realmKitPathPlan(m, 32, field, 700, false).map(d => d.id)).toEqual(['gulls', 'hare-walk', 'hare-pace', 'hare-corner', 'hare-side']);
    expect(realmKitPathPlan(m, 32, { x: 1510, y: -930, width: 10, height: 10 }, 700, false).map(d => d.id)).toEqual([]); // above the hare's 16-px cell
    expect(realmKitPathPlan(m, 32, { x: 1500, y: -915, width: 10, height: 10 }, 700, false).map(d => d.id)).toEqual([]); // west of it (its cell starts at 1512)
    expect(realmKitPathPlan(m, 32, { x: 1510, y: -915, width: 10, height: 10 }, 700, false).map(d => d.id)).toEqual(['hare-walk']);
    expect(realmKitPathPlan(m, 64, { x: 3020, y: -1830, width: 10, height: 10 }, 700, false).map(d => d.id)).toEqual(['hare-walk']); // (1520 − 8) · 2 = 3024 at 64 px/tile
    expect(realmKitPathPlan(m, 64, { x: 3000, y: -1830, width: 10, height: 10 }, 700, false).map(d => d.id)).toEqual([]);
    expect(realmKitPathPlan(m, 32, { x: 1510, y: -915, width: 10, height: 10 }, 5000, false).map(d => d.id)).toEqual([]); // walked away
    for (const [reducedMotion, background] of [[true, false], [false, true], [true, true]] as const) {
      const plan = realmKitPathPlan(m, 32, field, 5000, reducedMotion, background);
      expect(plan.map(d => [d.id, d.frame, d.facing, d.anchor])).toEqual([['gulls', 0, 'right', { x: 1400, y: -900 }], ['hare-walk', 4, 'right', { x: 1500, y: -900 }], ['hare-pace', 0, 'down', { x: 1600, y: 1500 }],
        ['hare-corner', 4, 'right', { x: -700, y: 400 }], ['hare-side', 0, 'down', { x: -800, y: 1400 }]]);
    }
    expect(() => realmKitPathPlan(m, 32, field, -1, false)).toThrow(); expect(() => realmKitPathPlan(m, 0, field, 0, false)).toThrow();
    expect(() => realmKitPathPlan(m, 32, { ...field, width: 0 }, 0, false)).toThrow();
    expect(() => realmKitPathPlan({ ...m, paths: [{ ...m.paths[0]!, asset: 'nope' }] }, 32, field, 0, false)).toThrow('Invalid realm kit manifest');
  });
  it('orders the ground band by the painter\'s band then the anchor row, props before creatures on a tie, so a deer walks behind a tree north of it and in front south of it on every client', () => {
    const ids = (elapsedMs: number, reducedMotion = false, background = false) => realmKitGroundBandPlan(m, 32, field, fixtureClaim(14), elapsedMs, reducedMotion, background).map(d => d.id);
    // t = 0: hare-walk at y −900 (north of everything, the stump at −600 included), hare-corner at y 400 between
    // the dead oak (200) and the frame oak (512), hare-side at y 1400, hare-pace at y 1500 = oak-east's seat
    // (tie → the prop first), gulls on the air layer last.
    expect(ids(0)).toEqual(['hare-walk', 'stump-north', 'oak-dead-west', 'hare-corner', 'oak-frame-east', 'hare-side', 'oak-east', 'hare-pace', 'gulls']);
    // t = 700: hare-pace has walked to y 1566, south of the oak's seat: now in front of it.
    expect(ids(700)).toEqual(['hare-walk', 'stump-north', 'oak-dead-west', 'hare-corner', 'oak-frame-east', 'hare-side', 'oak-east', 'hare-pace', 'gulls']);
    const band = realmKitGroundBandPlan(m, 32, field, fixtureClaim(14), 700, false);
    expect(band.map(d => [d.layer, d.bottom])).toEqual([[1, -900], [0, -600], [1, 200], [1, 400], [1, 512], [1, 1470], [1, 1500], [1, 1566], [2, -886]]); // the gull has flown 14 px south
    // A creature one row north of a low prop hides behind it: the stump (layer 0, y −600) covers a hare at y −610.
    const behindStump = { ...m, paths: [{ ...m.paths[1]!, points: [{ x: 400, y: -610 }, { x: 400, y: -700 }] }] };
    expect(realmKitGroundBandPlan(behindStump, 32, field, fixtureClaim(14), 0, false).map(d => d.id)).toEqual(['hare-walk', 'stump-north', 'oak-dead-west', 'oak-frame-east', 'oak-east']);
    expect(band.find(d => d.id === 'hare-pace')).toMatchObject({ facing: 'down', frame: 1 });
    expect(band.find(d => d.id === 'oak-east')!.frame).toBe(1); expect(band.find(d => d.id === 'oak-east')!.facing).toBeUndefined(); // the oak's own clip keeps its §7 frame rule
    // A creature north of the tree's seat row sorts before it.
    const north = { ...m, paths: [{ ...m.paths[2]!, points: [{ x: 1500, y: 1490 }, { x: 1500, y: 1400 }] }] };
    expect(realmKitGroundBandPlan(north, 32, field, fixtureClaim(14), 0, false).map(d => d.id)).toEqual(['stump-north', 'oak-dead-west', 'oak-frame-east', 'hare-pace', 'oak-east']);
    // Reduced motion pins the creature at its first vertex (y 1490): the stacking follows the pinned pose, not the clock.
    expect(realmKitGroundBandPlan(north, 32, field, fixtureClaim(14), 5000, true).map(d => d.id)).toEqual(['stump-north', 'oak-dead-west', 'oak-frame-east', 'hare-pace', 'oak-east']);
    // Hidden props stay out; reduced motion and background pin the creatures with the props.
    expect(ids(0, false, false).includes('oak-frame-east')).toBe(true);
    expect(realmKitGroundBandPlan(m, 32, field, fixtureClaim(30), 0, false).map(d => d.id)).not.toContain('oak-frame-east');
    expect(ids(5000, true)).toEqual(ids(0)); expect(ids(5000, false, true)).toEqual(ids(0));
    // Culling applies to both kinds through one view.
    expect(realmKitGroundBandPlan(m, 32, { x: 1480, y: 1480, width: 140, height: 40 }, fixtureClaim(14), 0, false).map(d => d.id)).toEqual(['oak-east', 'hare-pace']);
  });
  it('emits the Kotlin path probes from the same functions, so the parity file cannot drift from the rule', () => {
    const probes = realmKitPathProbeFixture(m);
    expect(probes.length).toBeGreaterThanOrEqual(15);
    expect(probes.map(p => p.reducedMotion).filter(Boolean)).toHaveLength(1);
    for (const p of probes) {
      expect(p.draws).toEqual(realmKitPathPlan(m, 32, field, p.elapsedMs, p.reducedMotion).map(d => ({ id: d.id, frame: d.frame, facing: d.facing, anchor: d.anchor, destination: d.destination })));
      expect(p.band).toEqual(realmKitGroundBandPlan(m, 32, field, fixtureClaim(14), p.elapsedMs, p.reducedMotion).map(d => d.id));
      expect(p.draws.map(d => d.id)).toEqual(['gulls', 'hare-walk', 'hare-pace', 'hare-corner', 'hare-side']);
    }
    expect(probes.find(p => p.elapsedMs === 5000 && !p.reducedMotion)!.draws[1]).toEqual({ id: 'hare-walk', frame: 2, facing: 'left', anchor: { x: 1700, y: -700 }, destination: { x: 1692, y: -716, width: 16, height: 16 } });
    expect(probes.find(p => p.elapsedMs === 9999)!.draws[1]).toMatchObject({ frame: 7, facing: 'up' }); // floor(−200 · 1999 / 2000) = −200: home a millisecond early
    expect(probes.find(p => p.reducedMotion)!.draws.map(d => d.frame)).toEqual([0, 4, 0, 4, 0]);
    // The probes must exercise the two branches the hand pins above cover, or a Kotlin mirror that unfolds a
    // pingpong wrongly (A B C C B A, A B C A B) or breaks the two-row tie passes the parity file untouched:
    // hare-corner at 5432 is 682 ms up the C→B return leg (⌊−200 · 682 / 2000⌋ = −69, floor not truncation) and
    // at 7777 on B→A; hare-side's four legs draw row left (down leaning west), right, right (up, dx 0: the tie), left.
    expect(probes.find(p => p.elapsedMs === 5432)!.draws[3]).toEqual({ id: 'hare-corner', frame: 6, facing: 'up', anchor: { x: -500, y: 531 }, destination: { x: -508, y: 515, width: 16, height: 16 } });
    expect(probes.find(p => p.elapsedMs === 7777)!.draws[3]).toMatchObject({ id: 'hare-corner', frame: 3, facing: 'left', anchor: { x: -578, y: 400 } });
    expect([700, 2500, 5432, 7777].map(t => probes.find(p => p.elapsedMs === t)!.draws[4]!).map(d => [d.frame, d.facing]))
      .toEqual([[0 * 4 + 3, 'down'], [1 * 4 + 1, 'right'], [1 * 4 + 2, 'up'], [0 * 4 + 1, 'left']]);
  });
});

describe('realm kit parity probe', () => {
  it('samples ~900 deterministic (claim, tile) cells covering all four states and every extent boundary, the Kotlin fixture without touching disk', () => {
    const m = realmKitFixture(), probe = realmKitProbeFixture(m);
    expect(probe.length).toBeGreaterThanOrEqual(850); expect(probe.length).toBeLessThanOrEqual(1000);
    expect(probe).toEqual(realmKitProbeFixture(realmKitFixture()));
    const states = new Set(probe.map(s => realmKitTileState(s.claim, s.tx, s.ty)));
    expect([...states].sort()).toEqual(['edge', 'exterior', 'kingdom', 'wilderness']);
    expect(new Set(probe.map(s => `${s.claim.min}`)).size).toBe(3);
    for (const s of probe) for (const id of REALM_KIT_LAYER_IDS) expect(s.cells[id]).toBe(realmKitCell(m, s.claim, id, s.tx, s.ty));
    expect(probe.some(s => s.cells.water === C.water && s.tx >= FIXTURE_LAKE.min)).toBe(true);
    expect(probe.some(s => s.cells.base >= C.edgeFirst && s.cells.base < C.edgeFirst + 16)).toBe(true);
    // The lattice steps one tile before and one past the field on both axes, and to the last margin tile and the
    // first tile past the extent, so the mirror's edge clamp is exercised at every boundary, not assumed: within the
    // margin a tile carries the NEAREST field tile's water/base cell (clamped on both sides) and no overlay; past the
    // extent every layer is 0. The river arms reach the edge, so the water clamp is pinned against WATER, not 0 == 0.
    const E = REALM_KIT.edgeExtendTiles, extentEnd = O + N + E, clamp = (t: number) => t < O ? O : t >= O + N ? O + N - 1 : t;
    const outside = probe.filter(s => s.tx < O || s.ty < O || s.tx >= O + N || s.ty >= O + N);
    const beyond = outside.filter(s => s.tx < extentEnd && s.ty < extentEnd), cut = outside.filter(s => s.tx >= extentEnd || s.ty >= extentEnd);
    for (const t of [O - 1, O + N, extentEnd - 1]) { expect(beyond.some(s => s.tx === t), `tx ${t}`).toBe(true); expect(beyond.some(s => s.ty === t), `ty ${t}`).toBe(true); }
    expect(cut.some(s => s.tx === extentEnd)).toBe(true); expect(cut.some(s => s.ty === extentEnd)).toBe(true);
    expect(probe.some(s => s.tx === O + N - 2 && s.ty === O + N - 2 && s.cells.base === C.forest)).toBe(true); // …and the last in-field lattice point still resolves to a baked cell
    for (const s of beyond) {
      expect(s.cells, `${s.tx},${s.ty}`).toEqual({ water: realmKitCell(m, s.claim, 'water', clamp(s.tx), clamp(s.ty)), base: realmKitCell(m, s.claim, 'base', clamp(s.tx), clamp(s.ty)), overlay: 0 });
      expect(s.cells.base, `${s.tx},${s.ty}`).not.toBe(0);
    }
    expect(beyond.some(s => s.tx === O + N && s.cells.water === C.water)).toBe(true); expect(beyond.some(s => s.ty === extentEnd - 1 && s.cells.water === C.water)).toBe(true);
    expect(beyond.some(s => s.tx === O - 1 && s.cells.base === C.forest)).toBe(true);
    // …and at least one margin probe sits beside a decal, so `overlay: 0` above is pinned against a flower, not 0 == 0.
    expect(beyond.some(s => realmKitCell(m, s.claim, 'overlay', clamp(s.tx), clamp(s.ty)) !== 0)).toBe(true);
    for (const s of cut) expect(s.cells, `${s.tx},${s.ty}`).toEqual({ water: 0, base: 0, overlay: 0 });
    expect(JSON.parse(JSON.stringify(probe))).toEqual(probe);
  });
});

const rgba = (data: Uint8ClampedArray, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
const opaque = (rgb: readonly number[]) => [...rgb, 255];
const mod = (n: number, size: number) => ((n % size) + size) % size;

describe('realm kit asset pixels', () => {
  it('gives every cell frame, prop cell, sprite frame and far texel a colour nothing else uses, so a rendered pixel names its source', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m), seen = new Set<string>();
    const add = (rgb: readonly number[]) => { const key = rgb.join(','); expect(seen.has(key), key).toBe(false); seen.add(key); };
    m.ground.cells.forEach((c, i) => { if (i + 1 !== C.bed) for (let f = 0; f < (c.frames ?? 1); f++) add(fixtureCellRgb(i + 1, f)); });
    for (let cell = 0; cell < 4; cell++) add(fixturePropRgb(cell));
    add(FIXTURE_STUMP_RGB); add(m.ground.paddingColor.match(/[0-9a-f]{2}/g)!.map(h => parseInt(h, 16)));
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) add(fixtureFarRgb(x, y));
    // The tiles sheet really carries those colours at the cell rects, and the bed is a hole.
    const tiles = p.get('tiles')!, bed = m.ground.cells[C.bed - 1]!, water = m.ground.cells[C.water - 1]!;
    expect(rgba(tiles.data as Uint8ClampedArray, 256, water.x + 32 * 3 + 9, water.y + 9)).toEqual(opaque(fixtureCellRgb(C.water, 3)));
    expect(rgba(tiles.data as Uint8ClampedArray, 256, bed.x + 9, bed.y + 9)).toEqual([0, 0, 0, 0]);
    for (const a of m.assets) expect(p.get(a.id)).toMatchObject({ width: a.width, height: a.height });
  });
  it('accepts the synthetic sheets: binary alpha, an opaque far and overview, and a transparent bed above every water cell', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m);
    for (const a of m.assets) expect(() => assertRealmKitAssetPixels(m, a, p.get(a.id)!), a.id).not.toThrow();
    const { overview: _omitted, ...withoutOverview } = m.ground;
    expect(() => assertRealmKitAssetPixels({ ...m, ground: withoutOverview }, m.assets[1]!, p.get('far')!)).not.toThrow();
  });
  it('rejects a translucent texel anywhere, a hole in the far or overview, mismatched pixels, and a base texel that covers open water in any frame', () => {
    const m = realmKitFixture();
    const changed = (id: string, mutate: (px: LayeredPixels) => void, manifest = m) => {
      const px = realmKitFixturePixels(m).get(id)!; mutate(px);
      return () => assertRealmKitAssetPixels(manifest, manifest.assets.find(a => a.id === id)!, px);
    };
    expect(changed('tiles', px => { px.data[3] = 128; })).toThrow('Invalid realm kit manifest');
    expect(changed('oak', px => { px.data[(10 * 64 + 10) * 4 + 3] = 1; })).toThrow();
    expect(changed('gull', px => { px.data[(8 * 48 + 20) * 4 + 3] = 254; })).toThrow();
    expect(changed('far', px => { px.data[(63 * 64 + 63) * 4 + 3] = 0; })).toThrow();
    expect(changed('overview', px => { px.data[(5 * 196 + 5) * 4 + 3] = 0; })).toThrow();
    expect(changed('oak-stump', px => { px.data[3] = 0; })).not.toThrow(); // a sprite may have holes
    expect(changed('tiles', px => { px.width = 128; })).toThrow();
    expect(changed('tiles', px => { px.data = px.data.subarray(4); })).toThrow();
    const at = (x: number, y: number) => (y * 256 + x) * 4 + 3;
    const bed = m.ground.cells[C.bed - 1]!, water = m.ground.cells[C.water - 1]!;
    expect(changed('tiles', px => { px.data[at(bed.x + 5, bed.y + 7)] = 255; })).toThrow();
    // …unless the water is transparent there in every frame (a keyed shore under a masked water cell).
    expect(changed('tiles', px => { px.data[at(bed.x + 5, bed.y + 7)] = 255; for (let f = 0; f < 4; f++) px.data[at(water.x + f * 32 + 5, water.y + 7)] = 0; })).not.toThrow();
    // Every water frame counts: opaque in frame 3 alone still forbids the base texel above it.
    expect(changed('tiles', px => { px.data[at(bed.x + 5, bed.y + 7)] = 255; for (let f = 0; f < 3; f++) px.data[at(water.x + f * 32 + 5, water.y + 7)] = 0; })).toThrow();
    // The rule binds base only: an opaque overlay cell (foam, lily pads) over the whole lake is fine; without a water layer it is moot.
    const foam = realmKitFixture();
    foam.ground.layers[2]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => tx >= FIXTURE_LAKE.min && tx < FIXTURE_LAKE.max && ty >= FIXTURE_LAKE.min && ty < FIXTURE_LAKE.max ? C.road : 0));
    expect(changed('tiles', () => {}, foam)).not.toThrow();
    const dry = realmKitFixture(); dry.ground.layers.splice(0, 1);
    expect(changed('tiles', px => { px.data[at(bed.x + 5, bed.y + 7)] = 255; }, dry)).not.toThrow();
    // The rule follows the baked grids: baking forest over the lake makes forest the covering cell.
    const covered = realmKitFixture();
    covered.ground.layers[1]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => tx >= -10 && tx < 40 && ty >= -10 && ty < 40 ? C.meadow : C.forest));
    expect(changed('tiles', () => {}, covered)).toThrow();
  });
});

describe('realm kit rasterizer', () => {
  const padding = [0x6f, 0x7a, 0x3a, 255];
  it('draws kingdom turf inside the claim, the Wang ring around it and baked wilderness beyond, so a deed shows the terrain the client shows', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m), claim = CLAIMS[14]; // tiles 8..22
    const x0 = 6 * 32, y0 = 6 * 32, w = 4 * 32, h = 4 * 32; // tiles 6..9 on both axes
    const out = renderRealmKitPixels(m, p, claim, w, h, x0, y0);
    const px = (tx: number, ty: number, u = 3, v = 5) => rgba(out, w, tx * 32 - x0 + u, ty * 32 - y0 + v);
    const turf = m.ground.state.turf.map(id => opaque(fixtureCellRgb(id)));
    for (const tx of [8, 9]) for (const ty of [8, 9]) {
      expect(turf).toContainEqual(px(tx, ty));
      expect(px(tx, ty)).toEqual(opaque(fixtureCellRgb(realmKitCell(m, claim, 'base', tx, ty))));
      expect(px(tx, ty, 0, 0)).toEqual(px(tx, ty, 31, 31));
    }
    expect(px(7, 7)).toEqual(opaque(fixtureCellRgb(C.edgeFirst + 1))); // NW corner, mask 1
    expect(px(7, 8)).toEqual(opaque(fixtureCellRgb(C.edgeFirst + 5))); // west run, mask 5
    expect(px(8, 7)).toEqual(opaque(fixtureCellRgb(C.edgeFirst + 3))); // north run, mask 3
    expect(px(6, 6)).toEqual(opaque(fixtureCellRgb(C.meadow)));
    expect(px(7, 6)).toEqual(opaque(fixtureCellRgb(C.meadowAlt)));
    expect(px(8, 8)).not.toEqual(px(7, 7)); expect(px(7, 7)).not.toEqual(px(6, 6));
    // The same rect under the 26-tile claim: what was ring and wilderness is kingdom — the claim, not the manifest, decides.
    const big = renderRealmKitPixels(m, p, CLAIMS[26], w, h, x0, y0);
    for (let ty = 6; ty < 10; ty++) for (let tx = 6; tx < 10; tx++) expect(turf).toContainEqual(rgba(big, w, tx * 32 - x0 + 3, ty * 32 - y0 + 5));
  });
  it('is the floor plan and the prop plan sampled at 32 px/tile: every pixel is the topmost opaque frame-0 draw, so deed and clients cannot disagree', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m), claim = CLAIMS[14], g = m.ground;
    m.ground.far.origin = { x: 5, y: -9 };
    const predict = (view: { x: number; y: number; width: number; height: number }) => {
      const out = new Uint8ClampedArray(view.width * view.height * 4);
      const floor = realmKitFloorPlan(m, 32, view, claim, 0, true).tiles, props = realmKitPropPlan(m, 32, view, claim, 0, true), far = p.get('far')!;
      for (let y = 0; y < view.height; y++) for (let x = 0; x < view.width; x++) {
        const wx = view.x + x, wy = view.y + y;
        let color = padding;
        const fx = mod(Math.floor((wx - g.far.origin.x) * far.width / g.far.period.width), far.width), fy = mod(Math.floor((wy - g.far.origin.y) * far.height / g.far.period.height), far.height);
        color = rgba(far.data as Uint8ClampedArray, far.width, fx, fy);
        for (const t of floor) {
          if (wx < t.destination.x || wx >= t.destination.x + 32 || wy < t.destination.y || wy >= t.destination.y + 32) continue;
          const { asset, source } = realmKitCellSource(m, t.cell, t.frame), sheet = p.get(asset.id)!;
          const texel = rgba(sheet.data as Uint8ClampedArray, sheet.width, source.x + wx - t.destination.x, source.y + wy - t.destination.y);
          if (texel[3] === 255) color = texel;
        }
        for (const d of props) {
          if (wx < d.destination.x || wx >= d.destination.x + d.destination.width || wy < d.destination.y || wy >= d.destination.y + d.destination.height) continue;
          const sheet = p.get(d.asset.id)!;
          const texel = rgba(sheet.data as Uint8ClampedArray, sheet.width, d.source.x + wx - d.destination.x, d.source.y + wy - d.destination.y);
          if (texel[3] === 255) color = texel;
        }
        out.set(color, (y * view.width + x) * 4);
      }
      return out;
    };
    for (const view of [
      { x: 49 * 32 - 7, y: 49 * 32 - 7, width: 3 * 32, height: 3 * 32 }, // the lake's north-west corner: water under bed, forest beside it
      { x: 1484 - 3, y: 1452 - 3, width: 40, height: 56 }, // oak-east with its transparent margins
      { x: 14 * 32 - 5, y: 44 * 32 + 5, width: 70, height: 70 }, // the road overlay's first tile, over the cobbles and the forest beside them
      { x: 7 * 32 - 9, y: 21 * 32 - 9, width: 50, height: 50 }, // claim corner: turf, ring, meadow and an in-frame flower
      { x: 64 * 32 - 20, y: -1088 - 20, width: 40, height: 40 }, // the field's north-east corner meeting the far repeat
      { x: 392 - 2, y: -616 - 2, width: 20, height: 20 }, // stump-north
    ]) {
      const out = renderRealmKitPixels(m, p, claim, view.width, view.height, view.x, view.y);
      expect(out, JSON.stringify(view)).toEqual(predict(view));
    }
  });
  it('shows the water loop\'s still through the transparent bed and covers it again when the base above is opaque: layer order is water → base → overlay', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m);
    const lake = renderRealmKitPixels(m, p, CLAIMS[14], 32, 32, 55 * 32, 55 * 32);
    expect(rgba(lake, 32, 0, 0)).toEqual(opaque(fixtureCellRgb(C.water, 0)));
    expect(rgba(lake, 32, 31, 31)).toEqual(opaque(fixtureCellRgb(C.water, 0))); // frame 0 only, never a later loop frame
    const edge = renderRealmKitPixels(m, p, CLAIMS[14], 64, 1, 49 * 32, 50 * 32); // dry forest tile 49 beside lake tile 50
    expect(rgba(edge, 64, 31, 0)).toEqual(opaque(fixtureCellRgb(C.forest)));
    expect(rgba(edge, 64, 32, 0)).toEqual(opaque(fixtureCellRgb(C.water, 0)));
    // Bake an opaque cell over the lake: the manifest is still valid (admission catches this in assertRealmKitAssetPixels), and the water is hidden.
    const covered = realmKitFixture();
    covered.ground.layers[1]!.rle = encodeRealmKitRle(fixtureGrid((tx, ty) => tx >= -10 && tx < 40 && ty >= -10 && ty < 40 ? C.meadow : C.forest));
    expect(rgba(renderRealmKitPixels(covered, p, CLAIMS[14], 1, 1, 55 * 32, 55 * 32), 1, 0, 0)).toEqual(opaque(fixtureCellRgb(C.forest)));
    // The overlay draws over the base: the road tile shows road, and clearing it inside a claim shows turf.
    expect(rgba(renderRealmKitPixels(m, p, CLAIMS[14], 1, 1, 20 * 32 + 4, FIXTURE_ROAD_ROW * 32 + 4), 1, 0, 0)).toEqual(opaque(fixtureCellRgb(C.road)));
    const flower = [...Array(50).keys()].map(i => i - 10).flatMap(ty => [...Array(50).keys()].map(i => i - 10).map(tx => [tx, ty] as const))
      .find(([tx, ty]) => fixtureFlowerAt(tx, ty) && realmKitTileState(CLAIMS[14], tx, ty) === 'wilderness' && realmKitTileState(CLAIMS[50], tx, ty) === 'kingdom')!;
    expect(rgba(renderRealmKitPixels(m, p, CLAIMS[14], 1, 1, flower[0] * 32 + 1, flower[1] * 32 + 1), 1, 0, 0)).toEqual(opaque(fixtureCellRgb(C.flower)));
    expect(m.ground.state.turf.map(id => opaque(fixtureCellRgb(id)))).toContainEqual(rgba(renderRealmKitPixels(m, p, CLAIMS[50], 1, 1, flower[0] * 32 + 1, flower[1] * 32 + 1), 1, 0, 0));
  });
  it('seats placements at their anchor with their still cell and stacks them in prop-plan order over the ground', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m);
    // The bare ground at a world pixel: its overlay cell if any, else its base cell (the oak stands beside the road row).
    const ground = (wx: number, wy: number) => {
      const tx = Math.floor(wx / 32), ty = Math.floor(wy / 32);
      return opaque(fixtureCellRgb(realmKitCell(m, CLAIMS[14], 'overlay', tx, ty) || realmKitCell(m, CLAIMS[14], 'base', tx, ty)));
    };
    expect(ground(1500, 1451)).toEqual(opaque(fixtureCellRgb(C.road))); expect(ground(1500, 1500)).toEqual(opaque(fixtureCellRgb(C.forest)));
    // oak-east: (1500,1500) seated bottom-centre, 32×48 → x 1484..1516, y 1452..1500, ink in columns 4..28 of the cell.
    const out = renderRealmKitPixels(m, p, CLAIMS[14], 40, 56, 1480, 1448);
    const at = (wx: number, wy: number) => rgba(out, 40, wx - 1480, wy - 1448);
    expect(at(1500, 1499)).toEqual(opaque(fixturePropRgb(0))); // bottom-centre ink: the still cell, not the clip's second frame
    expect(at(1500, 1500)).toEqual(ground(1500, 1500)); // the seat row itself is ground
    expect(at(1500, 1452)).toEqual(opaque(fixturePropRgb(0))); // top row of the cell
    expect(at(1500, 1451)).toEqual(ground(1500, 1451)); // above the sprite
    expect(at(1486, 1470)).toEqual(ground(1486, 1470)); // a transparent margin column (u = 2) lets the ground through
    expect(at(1488, 1470)).toEqual(opaque(fixturePropRgb(0))); // first ink column (u = 4)
    expect(at(1483, 1470)).toEqual(ground(1483, 1470)); // left of the sprite
    expect(rgba(renderRealmKitPixels(m, p, CLAIMS[14], 1, 1, -700, 199), 1, 0, 0)).toEqual(opaque(fixturePropRgb(2))); // oak-dead-west draws cell 2
    expect(rgba(renderRealmKitPixels(m, p, CLAIMS[14], 1, 1, 400, -601), 1, 0, 0)).toEqual(opaque(FIXTURE_STUMP_RGB)); // stump-north, anchor 8,16
    expect(rgba(renderRealmKitPixels(m, p, CLAIMS[14], 1, 1, 400, -600), 1, 0, 0)).toEqual(ground(400, -600));
    // Stacking (rewritten for D-173 creature paths — was "the higher layer wins"): the ground band is one
    // painter's order by the anchor row, so a stump seated one row NORTH of the oak's seat (y 1499 < 1500) is
    // under the oak whatever its low/tall layer, a stump seated south of it is over it, a tie keeps manifest
    // order, and only REALM_KIT.airLayer lifts it over the band. The deed must stack exactly as both clients.
    m.placements[1] = { ...m.placements[1]!, x: 1500, y: 1499 }; // stump bounds x 1492..1508, y 1483..1499
    const stump = opaque(FIXTURE_STUMP_RGB), oak = opaque(fixturePropRgb(0));
    const sample = () => rgba(renderRealmKitPixels(m, p, CLAIMS[14], 1, 1, 1500, 1490), 1, 0, 0);
    expect(sample()).toEqual(oak); // stump layer 0 north of the oak: under it
    m.placements[1]!.layer = 1; expect(sample()).toEqual(oak); // the tall layer changes nothing: still north
    m.placements[1]!.layer = REALM_KIT.airLayer; expect(sample()).toEqual(stump); // the air band is over every ground prop
    m.placements[1]!.layer = 0; m.placements[1]!.y = 1500; expect(sample()).toEqual(stump); // a tie on the anchor row: the stump is later in the manifest
    m.placements = [m.placements[1]!, m.placements[0]!, m.placements[2]!]; expect(sample()).toEqual(oak);
    m.placements[0]!.y = 1501; expect(sample()).toEqual(stump); // one row south of the oak's seat: in front of it
  });
  it('fills paddingColor beneath the far repeat at its fixed world phase beyond the field, and the far never shows inside it', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m);
    m.ground.far.origin = { x: 17, y: -21 }; m.ground.far.period = { width: 128, height: 128 }; // 64 texels over 128 px: 2 px per texel
    const E = REALM_KIT.edgeExtendTiles * 32;
    const wx = 64 * 32 + E + 3, wy = -1088 - E - 5; // just past the edge-clamped extent's east edge, just above its north edge
    const texel = opaque(fixtureFarRgb(mod(Math.floor((wx - 17) / 2), 64), mod(Math.floor((wy + 21) / 2), 64)));
    const one = (x: number, y: number, pixels = p) => rgba(renderRealmKitPixels(m, pixels, CLAIMS[14], 1, 1, x, y), 1, 0, 0);
    expect(one(wx, wy)).toEqual(texel);
    expect(one(wx + 128, wy - 128)).toEqual(texel); // one period away: the same texel (fixed world phase)
    expect(one(wx + 2, wy)).not.toEqual(texel); // the next texel over
    expect(one(-1088 - E - 1, 0)).toEqual(opaque(fixtureFarRgb(mod(Math.floor((-1089 - E - 17) / 2), 64), mod(Math.floor((0 + 21) / 2), 64))));
    // Inside the extent the field's edge runs on: one texel past the east edge is the clamped base cell, not the far,
    // and on a river row it is the water frame 0 (the bed beneath is a hole), so a deed shows the river running on too.
    expect(one(64 * 32 + 3, 0)).toEqual(one(64 * 32 - 29, 0));
    expect(one(64 * 32 + 3, FIXTURE_RIVER.min * 32)).toEqual(opaque(fixtureCellRgb(C.water, 0)));
    expect(one(FIXTURE_RIVER.min * 32, 64 * 32 + E - 1)).toEqual(opaque(fixtureCellRgb(C.water, 0)));
    // Inside the field the base has no holes: no far texel (b = 128) survives on the field's top row.
    const strip = renderRealmKitPixels(m, p, CLAIMS[14], 3136, 1, -1088, -1088);
    for (let x = 0; x < 3136; x++) expect(strip[x * 4 + 2], `${x}`).not.toBe(128);
    // paddingColor is the floor of last resort: a transparent far (admission rejects it; the rasterizer only checks dimensions) leaves the padding.
    const clear = new Map(p); clear.set('far', { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) });
    expect(one(wx, wy, clear)).toEqual(padding);
    expect(one(1, 0, clear)).toEqual(opaque(fixtureCellRgb(realmKitCell(m, CLAIMS[14], 'overlay', 0, 0) || realmKitCell(m, CLAIMS[14], 'base', 0, 0)))); // inside the field: tiles, whatever the far
  });
  it('is deterministic, clips to the requested rect at negative origins, and fails loud on bad inputs instead of drawing a partial deed', () => {
    const m = realmKitFixture(), p = realmKitFixturePixels(m);
    const a = renderRealmKitPixels(m, p, CLAIMS[26], 96, 80, -50, -70);
    const b = renderRealmKitPixels(JSON.parse(JSON.stringify(m)), realmKitFixturePixels(realmKitFixture()), CLAIMS[26], 96, 80, -50, -70);
    expect(a).toEqual(b); expect(a).toHaveLength(96 * 80 * 4);
    const crop = renderRealmKitPixels(m, p, CLAIMS[26], 10, 7, -30, -60); // a sub-rect equals the crop of the larger render
    for (let y = 0; y < 7; y++) for (let x = 0; x < 10; x++) expect(rgba(crop, 10, x, y)).toEqual(rgba(a, 96, x + 20, y + 10));
    const render = (pixels: ReadonlyMap<string, LayeredPixels>) => () => renderRealmKitPixels(m, pixels, CLAIMS[26], 4, 4);
    const missing = new Map(p); missing.delete('gull'); expect(render(missing)).toThrow('Invalid realm kit manifest');
    const wrong = new Map(p); wrong.set('tiles', { width: 128, height: 256, data: new Uint8ClampedArray(128 * 256 * 4) }); expect(render(wrong)).toThrow();
    const short = new Map(p); short.set('far', { width: 64, height: 64, data: new Uint8ClampedArray(10) }); expect(render(short)).toThrow();
    for (const [w, h] of [[0, 1], [1, 4097], [1.5, 1]]) expect(() => renderRealmKitPixels(m, p, CLAIMS[26], w!, h!)).toThrow();
    expect(() => renderRealmKitPixels(m, p, { min: 0, max: 41 }, 1, 1)).toThrow();
    for (const [x, y] of [[0.5, 0], [0, NaN], [1 << 21, 0]]) expect(() => renderRealmKitPixels(m, p, CLAIMS[26], 1, 1, x, y)).toThrow();
    m.ground.paddingColor = 'olive';
    expect(() => renderRealmKitPixels(m, p, CLAIMS[26], 1, 1)).toThrow();
  });
});
