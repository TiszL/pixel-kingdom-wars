/** Test-only synthetic revision-5 manifest and the Kotlin parity probe. Not a
 * package export and never imported by shipping code: the real Crownlands kit
 * comes from the builder (scripts/src/realm-kit.ts). Every value is chosen by
 * hand so a failing rule names itself. */
import { CAPS, REALM_KIT } from './constants';
import { decodeRealmKitRle, encodeRealmKitRle, realmKitCell, realmKitEdgeMask, realmKitGroundBandPlan, realmKitPathPlan, realmKitPlacementHidden, realmKitPlacementSeat, realmKitTileState,
  REALM_KIT_FIELD, REALM_KIT_LAYER_IDS,
  type RealmKitClaim, type RealmKitEdgeVariant, type RealmKitFacing, type RealmKitLayerId, type RealmKitManifest, type RealmKitObstacleState } from './realmKit';
import { realmKitObstacleKindFor, realmKitObstacleRow, realmKitObstacleSpriteAt } from './realmKitObstacles';
import type { LayeredAsset, LayeredPixels } from './layeredGround';

const O = REALM_KIT.fieldOriginTiles, N = REALM_KIT.fieldTiles;
export const FIXTURE_CELL = {
  meadow: 1, meadowAlt: 2, turf: 3, turfAlt: 4, edgeFirst: 5, /* …edgeFirst + 15 */
  water: 21, flower: 22, forest: 23, road: 24,
  /** The fully transparent base cell baked over open water (§7 water convention). */
  bed: 25,
  /** In-frame BASE ground that is not the wild meadow (§2 ring variants): the kingdom road's cobbles
   * (a ground-level terrain the claim overwrites — unlike the `road` decal on FIXTURE_ROAD_ROW) and a
   * dirt yard, the two cells whose ring tiles resolve to variants. */
  cobbles: 26, dirt: 27,
  /** …variantFirst + n: one synthetic ring composite per reachable (cobbles|dirt, mask) pair, in the
   * order fixtureEdgeVariants meets them. Every other ring tile draws edgeFirst + mask. */
  variantFirst: 28,
} as const;
/** Deterministic in-frame sprinkle so overlay tests have something to clear. */
export const fixtureFlowerAt = (tx: number, ty: number) => ((tx * 7 + ty * 3) % 11 + 11) % 11 === 0;
export const FIXTURE_LAKE = { min: 50, max: 60 } as const;
/** Two river arms leave the lake — east and south — and reach the field's edge, so a
 * field-edge tile carries water and the beyond-field probes pin the water clamp by data
 * (the lake alone touches no edge, and a clamp that dropped water would pass 0 == 0). */
export const FIXTURE_RIVER = { min: 53, max: 56 } as const;
export const FIXTURE_ROAD_ROW = 45;
/** P0 road into the kingdom (REALM-THEMES-PLAN §3, K-177): cobbles on the BASE layer two tiles wide
 * (columns [min,max)) from the field's south edge north to the smallest kingdom, ending on row
 * `endRow` inside REALM_KIT_SMALLEST_KINGDOM — so every claim's south ring crosses road cells and the
 * road meets the land through a ring variant wherever the claim is. Beyond the field the edge clamp
 * runs the cobbles on south. */
export const FIXTURE_KINGDOM_ROAD = { min: 14, max: 16, endRow: 20 } as const;
/** A dirt yard north-east of the smallest kingdom, in the frame: the 14–20-tile claims' north ring,
 * north-east corner and east ring cross it, so the parity file pins ring variants under the straight
 * masks 3 and 10 and the corner mask 2 as well as the road's south run (12). */
export const FIXTURE_YARD = { min: { x: 20, y: 3 }, max: { x: 26, y: 9 } } as const;
export const fixtureCobblesAt = (tx: number, ty: number) => tx >= FIXTURE_KINGDOM_ROAD.min && tx < FIXTURE_KINGDOM_ROAD.max && ty >= FIXTURE_KINGDOM_ROAD.endRow && ty < O + N;
export const fixtureDirtAt = (tx: number, ty: number) => tx >= FIXTURE_YARD.min.x && tx < FIXTURE_YARD.max.x && ty >= FIXTURE_YARD.min.y && ty < FIXTURE_YARD.max.y;
/** The claim rects a base can hold (apps/api footprints.claimRect over CAPS.claimTilesByExpansion). */
export const fixtureReachableClaims = (): RealmKitClaim[] => CAPS.claimTilesByExpansion.map(fixtureClaim);
/** §2 ring variants the way the builder derives them: walk the one-tile ring of every reachable claim,
 * take realmKitEdgeMask of each ring tile, and for every (baked base cell, mask) pair over a cell that is
 * not the wild ground — here cobbles and dirt — bake one ring cell; dedupe. The fixture's "composite" is a
 * fresh synthetic cell (variantFirst + n) per pair in first-seen order (claims in CAPS order, ring tiles
 * row-major), so a probe on the road's ring resolves to a cell nothing else uses and a mirror that read
 * the default table there fails by data. Returns the rows and how many variant cells to add to the table. */
export function fixtureEdgeVariants(base: Uint16Array): { variants: RealmKitEdgeVariant[]; count: number } {
  const rows = new Map<number, number[]>();
  let count = 0;
  for (const claim of fixtureReachableClaims()) {
    const lo = claim.min - REALM_KIT.edgeRingTiles, hi = claim.max + REALM_KIT.edgeRingTiles;
    for (let ty = lo; ty < hi; ty++) for (let tx = lo; tx < hi; tx++) {
      if (realmKitTileState(claim, tx, ty) !== 'edge') continue;
      const cell = base[(ty - O) * N + (tx - O)]!;
      if (cell !== FIXTURE_CELL.cobbles && cell !== FIXTURE_CELL.dirt) continue;
      const row = rows.get(cell) ?? new Array<number>(16).fill(0);
      rows.set(cell, row);
      const mask = realmKitEdgeMask(claim, tx, ty);
      if (!row[mask]) row[mask] = FIXTURE_CELL.variantFirst + count++;
    }
  }
  return { variants: [...rows].map(([cell, cells]) => ({ cell, cells })), count };
}

function asset(id: string, hex: string, width: number, height: number, frameWidth = width, frameHeight = height,
  anchor = { x: 0, y: 0 }): LayeredAsset {
  return { id, path: `atlas/fantasy/layered-ground/assets/${hex.repeat(64)}.png`, sha256: hex.repeat(64), size: 100,
    width, height, frameWidth, frameHeight, frameCount: width / frameWidth * (height / frameHeight), frameDurationMs: 100,
    anchor, reducedMotionFrame: 0 };
}
export function fixtureGrid(fill: (tx: number, ty: number) => number): Uint16Array {
  const grid = new Uint16Array(N * N);
  for (let ty = 0; ty < N; ty++) for (let tx = 0; tx < N; tx++) grid[ty * N + tx] = fill(tx + O, ty + O);
  return grid;
}
const inFrame = (tx: number, ty: number) => tx >= REALM_KIT.frameMinTile && tx < REALM_KIT.frameMaxTile
  && ty >= REALM_KIT.frameMinTile && ty < REALM_KIT.frameMaxTile;
const inLake = (tx: number, ty: number) => tx >= FIXTURE_LAKE.min && tx < FIXTURE_LAKE.max && ty >= FIXTURE_LAKE.min && ty < FIXTURE_LAKE.max;
const inRiverArm = (along: number, across: number) => across >= FIXTURE_RIVER.min && across < FIXTURE_RIVER.max && along >= FIXTURE_LAKE.min && along < O + N;
/** Open water: the lake plus its east arm (rows FIXTURE_RIVER) and south arm (columns FIXTURE_RIVER) to the field edge. */
export const fixtureWaterAt = (tx: number, ty: number) => inLake(tx, ty) || inRiverArm(tx, ty) || inRiverArm(ty, tx);
export function realmKitFixture(): RealmKitManifest {
  const c = FIXTURE_CELL;
  // Base: the transparent bed over water, cobbles and dirt where the road and the yard are, the meadow
  // chequer elsewhere in the frame, forest floor outside it.
  const base = fixtureGrid((tx, ty) => fixtureWaterAt(tx, ty) ? c.bed : fixtureCobblesAt(tx, ty) ? c.cobbles : fixtureDirtAt(tx, ty) ? c.dirt
    : inFrame(tx, ty) ? ((tx + ty) % 2 ? c.meadowAlt : c.meadow) : c.forest);
  const { variants, count } = fixtureEdgeVariants(base);
  // Tileset rows: 0 the pure cells, 1–2 the 16 default ring cells, 3 water (4 frames) + decals + bed,
  // 4… cobbles, dirt, then the variant cells row-major (8 cells a row on the 256-px sheet).
  const variantCells = Array.from({ length: count }, (_, i) => ({ asset: 'tiles', x: ((2 + i) % 8) * 32, y: 128 + Math.floor((2 + i) / 8) * 32 }));
  return {
    schemaVersion: 3, groundRevision: 5, realmId: 'crownlands', status: 'preview-only', tilePixels: 32,
    field: { x: -1088, y: -1088, width: 3136, height: 3136 }, protectedFrame: { x: -320, y: -320, width: 1600, height: 1600 },
    ground: {
      kind: 'tiles', paddingColor: '#6f7a3a',
      cells: [
        { asset: 'tiles', x: 0, y: 0 }, { asset: 'tiles', x: 32, y: 0 }, { asset: 'tiles', x: 64, y: 0 }, { asset: 'tiles', x: 96, y: 0 },
        ...Array.from({ length: 16 }, (_, i) => ({ asset: 'tiles', x: (i % 8) * 32, y: 32 + Math.floor(i / 8) * 32 })),
        { asset: 'tiles', x: 0, y: 96, frames: 4, frameDurationMs: 250 },
        { asset: 'tiles', x: 128, y: 96 }, { asset: 'tiles', x: 160, y: 96 }, { asset: 'tiles', x: 192, y: 96 }, { asset: 'tiles', x: 224, y: 96 },
        { asset: 'tiles', x: 0, y: 128 }, { asset: 'tiles', x: 32, y: 128 }, ...variantCells,
      ],
      layers: [
        { id: 'water', rle: encodeRealmKitRle(fixtureGrid((tx, ty) => fixtureWaterAt(tx, ty) ? c.water : 0)) },
        { id: 'base', rle: encodeRealmKitRle(base) },
        { id: 'overlay', rle: encodeRealmKitRle(fixtureGrid((tx, ty) => ty === FIXTURE_ROAD_ROW && tx >= 15 ? c.road : fixtureFlowerAt(tx, ty) && !fixtureWaterAt(tx, ty) ? c.flower : 0)) },
      ],
      state: { turf: [c.turf, c.turfAlt], edge: { cells: Array.from({ length: 16 }, (_, i) => c.edgeFirst + i), variants }, clearInside: true },
      far: { asset: 'far', origin: { x: 0, y: 0 }, period: { width: 64, height: 64 } },
      overview: { asset: 'overview', pxPerTile: 2 },
    },
    assets: [
      asset('tiles', 'a', 256, 256), asset('far', 'b', 64, 64), asset('overview', 'c', N * 2, N * 2),
      // 'oak' is a §7 prop sheet: four 32×48 cells (2 columns × 2 rows) seated bottom-centre —
      // cells 0–1 the oak's sway loop, cell 2 a dead oak, cell 3 spare.
      asset('oak', 'd', 64, 96, 32, 48, { x: 16, y: 48 }), asset('oak-stump', 'e', 16, 16, 16, 16, { x: 8, y: 16 }),
      asset('gull', 'f', 48, 16, 16, 16, { x: 8, y: 8 }),
      // 'hare' is a D-173 creature sheet: 4 facings × 2 walk frames as 16×16 cells, row-major in
      // REALM_KIT_FACINGS order (down, left, right, up), seated bottom-centre like a prop.
      asset('hare', '7', 32, 64, 16, 16, { x: 8, y: 16 }),
    ],
    placements: [
      { id: 'oak-east', asset: 'oak', x: 1500, y: 1500, width: 32, height: 48, layer: 1, phaseFrame: 0, animated: true, interactive: false,
        frame: 0, clip: { frames: 2, frameDurationMs: 100 }, states: { intact: 'oak', remnant: 'oak-stump' } },
      { id: 'stump-north', asset: 'oak-stump', x: 400, y: -600, width: 16, height: 16, layer: 0, phaseFrame: 0, animated: false, interactive: false },
      { id: 'oak-dead-west', asset: 'oak', x: -700, y: 200, width: 32, height: 48, layer: 1, phaseFrame: 0, animated: false, interactive: false, frame: 2 },
      // Seated on frame tile (30, 15): visible under the 14- and 26-tile claims, hidden
      // once a 30-tile claim's ring reaches tile 30 (E-6 amended: land bought clears it).
      { id: 'oak-frame-east', asset: 'oak', x: 976, y: 512, width: 32, height: 48, layer: 1, phaseFrame: 0, animated: false, interactive: false, frame: 3 },
    ],
    obstacleSprites: { tree_old: { intact: 'oak', remnant: 'oak-stump' }, stump: { intact: 'oak-stump', remnant: 'oak-stump' } },
    paths: [
      { id: 'gulls', asset: 'gull', points: [{ x: 1400, y: -900 }, { x: 1900, y: -600 }, { x: 1900, y: 1900 }], speed: 40, layer: 2 },
      // A closed square walked clockwise (right, down, left, up) at 100 px/s — 2 s a side — with a
      // half-second dwell at every corner: period 4 × (500 + 2000) = 10 000 ms.
      { id: 'hare-walk', asset: 'hare', points: [{ x: 1500, y: -900 }, { x: 1700, y: -900 }, { x: 1700, y: -700 }, { x: 1500, y: -700 }, { x: 1500, y: -900 }],
        speed: 100, directions: 4, frames: 2, frameDurationMs: 100, dwellMs: 500, loop: 'cycle' },
      // An open two-point path paced there and back (diagonal, |dx| < |dy| so it faces down then up),
      // no dwell: 316 px (⌊√100000⌋) each way at 100 px/s → period 6 320 ms.
      { id: 'hare-pace', asset: 'hare', points: [{ x: 1600, y: 1500 }, { x: 1700, y: 1800 }], speed: 100, directions: 4, frames: 2, frameDurationMs: 100, loop: 'pingpong' },
      // A three-point pingpong with a dwell, west of the frame: the unfold walks A B C B A, so the middle
      // vertex is passed both ways and the far end is dwelt at ONCE — a mirror that repeats or drops an
      // end vertex (A B C C B A, A B C A B) shifts every return-leg pose. 200-px legs at 100 px/s, 250 ms
      // per vertex → period 4 × (250 + 2000) = 9 000 ms, so the probe clocks 5432 and 7777 fall mid-walk on
      // the two return legs; its feet cross oak-frame-east's seat row (512) on the way.
      { id: 'hare-corner', asset: 'hare', points: [{ x: -700, y: 400 }, { x: -500, y: 400 }, { x: -500, y: 600 }], speed: 100, directions: 4, frames: 2, frameDurationMs: 100, dwellMs: 250, loop: 'pingpong' },
      // A side-only sheet (directions 2: rows [left, right], the hare sheet's first two rows, 2 × 4 = 8 cells)
      // round a closed square south-west of the frame, one leg per row rule: down leaning 1 px west (row left),
      // right (row right), up with no lean (row right — the tie), left (row left). 200/200/200/199 px at
      // 100 px/s, no dwell → period 7 990 ms.
      { id: 'hare-side', asset: 'hare', points: [{ x: -800, y: 1400 }, { x: -801, y: 1600 }, { x: -601, y: 1600 }, { x: -601, y: 1400 }, { x: -800, y: 1400 }],
        speed: 100, directions: 2, frames: 4, frameDurationMs: 100, loop: 'cycle' },
    ],
  };
}
/** Server claim rects the way apps/api footprints.claimRect centres them on tile 15. */
export function fixtureClaim(tiles: number): RealmKitClaim {
  const min = 15 - tiles / 2;
  return { min, max: min + tiles };
}
export interface RealmKitProbeSample { claim: RealmKitClaim; tx: number; ty: number; cells: Record<RealmKitLayerId, number> }
export interface RealmKitPropProbeSample { claim: RealmKitClaim; visible: string[] }
/** Which fixture placements each claim leaves visible (realmKitPlacementHidden), in
 * manifest order — the Kotlin mirror pins the same list. */
export function realmKitPropProbeFixture(m: RealmKitManifest): RealmKitPropProbeSample[] {
  return [14, 26, 30, 50].map(tiles => {
    const claim = fixtureClaim(tiles);
    return { claim, visible: m.placements.filter(p => !realmKitPlacementHidden(p, claim)).map(p => p.id) };
  });
}
export interface RealmKitObstacleProbeFixture {
  /** Every placement: its seat, the kind it becomes (null = never an obstacle) and the row the API would store. */
  kinds: { id: string; seat: { tx: number; ty: number }; kind: string | null; row: { tx: number; ty: number } | null }[];
  /** realmKitObstacleSpriteAt over each placement's own row, a plot-style row with no prop, a
   * row whose key is not the seated prop's kind, and an unmapped key: asset/frame or null (dec_). */
  sprites: { tx: number; ty: number; spriteKey: string; state: RealmKitObstacleState; asset: string | null; frame: number | null }[];
}
/** E-11 expansion obstacles: what the shared rule answers for the fixture, pinned by the
 * Kotlin mirror so a felled tree keeps its species and tier on every surface. */
export function realmKitObstacleProbeFixture(m: RealmKitManifest): RealmKitObstacleProbeFixture {
  const states: RealmKitObstacleState[] = ['intact', 'clearing', 'remnant'];
  const kinds = m.placements.map(p => {
    const seat = realmKitPlacementSeat(p), kind = realmKitObstacleKindFor(m, p) ?? null;
    return { id: p.id, seat, kind, row: kind ? realmKitObstacleRow(kind, seat) : null };
  });
  const rows: { tx: number; ty: number; spriteKey: string }[] = kinds.flatMap(k => k.row ? [{ ...k.row, spriteKey: k.kind! }] : []);
  rows.push({ tx: 10, ty: 10, spriteKey: 'tree_old' }, { tx: 30, ty: 15, spriteKey: 'pine1' }, { tx: 12, ty: 12, spriteKey: 'bush' });
  const sprites = rows.flatMap(r => states.map(state => {
    const draw = realmKitObstacleSpriteAt(m, r.tx, r.ty, r.spriteKey, state);
    return { ...r, state, asset: draw?.asset.id ?? null, frame: draw?.frame ?? null };
  }));
  return { kinds, sprites };
}
export interface RealmKitPathProbeSample {
  elapsedMs: number; reducedMotion: boolean;
  draws: { id: string; frame: number; facing: RealmKitFacing; anchor: { x: number; y: number }; destination: { x: number; y: number; width: number; height: number } }[];
  /** realmKitGroundBandPlan ids under the 14-tile claim: props and creatures in one depth order. */
  band: string[];
}
/** D-173 creature paths: every path's draw at a spread of clocks (dwells, mid-segment walks,
 * the period boundary, a long run) at the kit's own 32 px/tile over the whole field, plus one
 * reduced-motion sample — what the Kotlin mirror pins so a deer stands on the same pixel on
 * both clients at the same clock. */
export function realmKitPathProbeFixture(m: RealmKitManifest): RealmKitPathProbeSample[] {
  const view = { ...REALM_KIT_FIELD }, claim = fixtureClaim(14);
  const clocks: [number, boolean][] = [[0, false], [100, false], [250, false], [499, false], [500, false], [700, false], [1234, false], [2500, false], [2999, false], [3000, false],
    [4999, false], [5000, false], [5432, false], [7777, false], [9999, false], [10000, false], [12345, false], [61234, false], [700, true]];
  return clocks.map(([elapsedMs, reducedMotion]) => ({ elapsedMs, reducedMotion,
    draws: realmKitPathPlan(m, m.tilePixels, view, elapsedMs, reducedMotion).map(d => ({ id: d.id, frame: d.frame, facing: d.facing, anchor: d.anchor, destination: d.destination })),
    band: realmKitGroundBandPlan(m, m.tilePixels, view, claim, elapsedMs, reducedMotion).map(d => d.id) }));
}
/** ~900 deterministic samples for the Kotlin mirror: a stride-8 lattice over the
 * field plus, on each axis, the tile before it (O − 1), the first beyond it (O + N),
 * the last of the edge-clamped margin and the first past the extent (where every
 * layer is 0 and the far repeat shows) under claims 14, 26 and 50, every ring
 * corner and mid-edge of each claim, every ring tile over a base cell that has a §2
 * variant row (the road crossing and the yard) and the ring tiles either side of the
 * road crossing (default ring beside a variant, not 0 == 0). So both clamps, the cut-off
 * and the ring variants are pinned by data, water included (the river arms reach the
 * edge). Written to disk by a later stage, never here; the values are what
 * `realmKitCell` returns today. */
export function realmKitProbeFixture(m: RealmKitManifest): RealmKitProbeSample[] {
  const samples: RealmKitProbeSample[] = [];
  const extentEnd = O + N + REALM_KIT.edgeExtendTiles;
  const axis = [O - 1, ...Array.from({ length: Math.ceil(N / 8) }, (_, i) => O + i * 8), O + N, extentEnd - 1, extentEnd];
  const sample = (claim: RealmKitClaim, tx: number, ty: number) => samples.push({ claim, tx, ty,
    cells: Object.fromEntries(REALM_KIT_LAYER_IDS.map(id => [id, realmKitCell(m, claim, id, tx, ty)])) as Record<RealmKitLayerId, number> });
  const base = decodeRealmKitRle(m.ground.layers.find(l => l.id === 'base')!.rle, N * N), rows = new Set((m.ground.state.edge.variants ?? []).map(v => v.cell));
  for (const tiles of [14, 26, 50]) {
    const claim = fixtureClaim(tiles);
    for (const ty of axis) for (const tx of axis) sample(claim, tx, ty);
    const lo = claim.min - 1, hi = claim.max, mid = Math.floor((claim.min + claim.max) / 2);
    for (const [tx, ty] of [[lo, lo], [hi, lo], [lo, hi], [hi, hi], [mid, lo], [mid, hi], [lo, mid], [hi, mid]] as const) sample(claim, tx, ty);
    for (let ty = lo; ty <= hi; ty++) for (let tx = lo; tx <= hi; tx++) {
      if (realmKitTileState(claim, tx, ty) === 'edge' && rows.has(base[(ty - O) * N + (tx - O)]!)) sample(claim, tx, ty);
    }
    sample(claim, FIXTURE_KINGDOM_ROAD.min - 1, hi); sample(claim, FIXTURE_KINGDOM_ROAD.max, hi);
  }
  return samples;
}

/** Synthetic flat colours, one per (cell, frame), so a rendered pixel names its cell. */
export function fixtureCellRgb(id: number, frame = 0): [number, number, number] {
  return [(id * 10) & 255, (30 + frame * 60) & 255, (255 - id * 10) & 255];
}
export const fixtureFarRgb = (x: number, y: number): [number, number, number] => [x * 4, y * 4, 128];
export const FIXTURE_OVERVIEW_RGB: readonly [number, number, number] = [11, 22, 33];
export const fixturePropRgb = (cell: number): [number, number, number] => [200, 40 + cell * 50, 60];
export const FIXTURE_STUMP_RGB: readonly [number, number, number] = [120, 80, 40];
export const fixtureGullRgb = (frame: number): [number, number, number] => [240, 240, 200 + frame * 20];
/** One flat colour per (facing row, walk frame) of the creature sheet, so a rendered texel names its cell. */
export const fixtureHareRgb = (row: number, frame: number): [number, number, number] => [90 + row * 40, 60 + frame * 120, 30];
/** Prop cells keep 4 transparent columns each side so alpha is exercised; the ink reaches the bottom row (E-13). */
export const fixturePropInk = (u: number) => u >= 4 && u < 28;
/** The synthetic RGBA for every fixture asset — binary alpha, the `bed` cell fully
 * transparent, water frames distinct — shared by the shared tests and the
 * scripts CLI that writes the Kotlin parity fixture, so both pin one pixel set. */
export function realmKitFixturePixels(m: RealmKitManifest): Map<string, LayeredPixels> {
  const out = new Map<string, LayeredPixels>();
  const sheet = (a: LayeredAsset, texel: (x: number, y: number) => readonly [number, number, number, number]) => {
    const data = new Uint8ClampedArray(a.width * a.height * 4);
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) data.set(texel(x, y), (y * a.width + x) * 4);
    out.set(a.id, { width: a.width, height: a.height, data });
  };
  const byId = new Map(m.assets.map(a => [a.id, a]));
  const tiles = byId.get('tiles')!, cellOf = new Map<string, [number, number]>();
  m.ground.cells.forEach((c, i) => { for (let f = 0; f < (c.frames ?? 1); f++) cellOf.set(`${c.x + f * 32},${c.y}`, [i + 1, f]); });
  sheet(tiles, (x, y) => {
    const hit = cellOf.get(`${x - x % 32},${y - y % 32}`);
    if (!hit || hit[0] === FIXTURE_CELL.bed) return [0, 0, 0, 0];
    return [...fixtureCellRgb(hit[0], hit[1]), 255];
  });
  sheet(byId.get('far')!, (x, y) => [...fixtureFarRgb(x, y), 255]);
  sheet(byId.get('overview')!, () => [...FIXTURE_OVERVIEW_RGB, 255]);
  sheet(byId.get('oak')!, (x, y) => [...fixturePropRgb(Math.floor(x / 32) + Math.floor(y / 48) * 2), fixturePropInk(x % 32) ? 255 : 0]);
  sheet(byId.get('oak-stump')!, () => [...FIXTURE_STUMP_RGB, 255]);
  sheet(byId.get('gull')!, (x, y) => [...fixtureGullRgb(Math.floor(x / 16)), y >= 4 ? 255 : 0]);
  // Two 16-px cells per row (frames), four rows (facings); ink from row 4 to the cell's bottom row (seated, E-13).
  sheet(byId.get('hare')!, (x, y) => [...fixtureHareRgb(Math.floor(y / 16), Math.floor(x / 16)), y % 16 >= 4 ? 255 : 0]);
  return out;
}
