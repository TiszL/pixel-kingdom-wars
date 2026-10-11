/**
 * THE CPU RASTERISER — an orthographic earth splatted into a fixed-size
 * ImageData, blitted once with nearest-neighbour scaling.
 *
 * Not React, not Phaser, no WebGL, no dependency. `'map'` stays out of
 * CANVAS_SCREENS (PhaserGame.tsx) precisely because of this file: the base scene
 * keeps sleeping under the map, which is why map.tsx needs none of Overlay's
 * tap-swallowing workaround.
 *
 * WHY IT IS CHEAP (docs/WORLDMAP-GLOBE-PLAN.md §1.1)
 *  1. The buffer is a FIXED GLOBE.px-tall raster (~47 k px on a 375×812 phone),
 *     independent of screen size and device pixel ratio. A retina desktop costs
 *     the same as a phone; only the final `drawImage` upscale gets bigger, and
 *     that is the GPU's problem.
 *  2. `sin/cos` per mask ROW are precomputed once per mask, `sin/cos(λ−λ₀)` per
 *     mask COLUMN once per frame (`makeFrame`/`updateFrame` in @shardkeep/shared),
 *     so a land cell costs ~10 flops and ZERO trig.
 *  3. Land cells are walked from `landCellList` — the ~29% of cells that can draw
 *     anything — instead of bit-testing 71% ocean every frame.
 *  4. TWO PASSES, and the second one is what buys the terminator. Pass 1 writes a
 *     MATERIAL ID per pixel (ocean dither, limb ring, land tint by latitude).
 *     Pass 2 walks only the disc, computes one dot product against the sun
 *     direction in camera space, and writes `PALETTE[material][shade]`. That is
 *     cheaper than shading per cell AND it shades the ocean too — so the shadow
 *     crosses the whole planet instead of only the continents. It also keeps
 *     every colour decision in one small table, which is how pixel art stays
 *     coherent.
 *
 * The caller quantises the camera to whole raster pixels (`quantiseNav`) before
 * calling `draw`, so a slow spin does not shimmer.
 *
 * ---------------------------------------------------------------------------
 * EARTH TILES (docs/EARTH-TILES-PLAN.md §4, P2) — behind `VITE_FEATURE_EARTH_TILES`
 * ---------------------------------------------------------------------------
 *
 * `opts.tiles` selects a SECOND land pass. Everything else in the file — the
 * ocean disc, the limb ring, the terminator, the blit, the palette entries the
 * old pass uses — is untouched, so with the flag off the picture is the shipped
 * one BYTE FOR BYTE: `splatLandPass` below is today's loop, moved into a named
 * function and not otherwise edited.
 *
 * WHAT THE TILE PASS DOES DIFFERENTLY, AND WHY EACH ONE IS A PREREQUISITE RATHER
 * THAN A POLISH:
 *
 *  • TRUE CELL QUADS, not the equator-only square. The old pass stamps a square
 *    of side R·Δlat around the projected CENTRE, which over-covers a real 0.5°
 *    cell by a measured 2.02× in longitude at 60° and 5.90× at 80°. Harmless
 *    over-draw for a silhouette; FATAL for a grid, because the lines would not
 *    coincide with cell boundaries and a tap would disagree with what the player
 *    sees. So the tile pass projects the four CORNERS (`EdgeFrame`) and fills
 *    their bbox half-open, `[x0, x1)`, which makes neighbouring cells tile
 *    exactly instead of overlapping.
 *
 *  • CORNERS ARE ROUNDED, not just the camera. `quantiseNav` already snaps the
 *    camera to whole raster pixels so coastlines cannot shimmer; a 1 px grid is
 *    far more shimmer-sensitive than a coastline, so the corner coordinates are
 *    rounded too (EARTH-TILES-PLAN §4.4).
 *
 *  • A WINDOWED ROW/COLUMN WALK. The old pass walks all 86,122 fine land cells
 *    every frame even at the zoom where it draws 24 of them — measured 2.2–2.5 ms
 *    flat in zoom. The tile pass converts the screen box into a latitude band
 *    (one `asin`), then per visible ROW into a longitude window (one `acos` per
 *    row edge, one `asin`), and finds each row's land cells through `rowOff` +
 *    a binary search. Two to four transcendentals per visible ROW, still ZERO
 *    per cell, and the corner buffers are indexed by row parity so the row you
 *    just computed as a bottom edge IS the next row's top edge — ~1 fresh corner
 *    projection per cell amortised, the same order as one centre splat.
 *
 *  • COUNTRY COLOUR BY MAPCOLOR9, NEVER BY COUNTRY ID (EARTH-TILES-PLAN R19).
 *    `mat` is a `Uint8Array`, so ~240 countries × 6 latitude bands × 2 dither
 *    twins would overflow it SILENTLY — colour corruption, not an exception.
 *    Natural Earth ships MAPCOLOR9 for exactly this purpose (adjacent countries
 *    differ), so the palette is 9 hues, each blended with the latitude biome tint
 *    the globe already had: Greenland still reads as ice and the Congo as jungle,
 *    while Brazil no longer reads as Peru. `MAT_COUNT ≤ 256` is asserted by a test.
 *
 *  • BAKED EDGES. Which of a cell's four sides face a different country and which
 *    face ocean is a property of the mask, so it is computed once per mask (never
 *    per frame) into `edge`. Measured: 21% of fine land cells carry any edge at
 *    all, so 79% of tiles pay nothing for borders.
 */
import { GLOBE } from '@shardkeep/shared';
import {
  cellCentreDeg, countryIdAtRank, DEG_TO_RAD, landCellList, makeFrame, newProjected, splatIndex,
  updateFrame,
  type CountryIndex, type GlobeCamera, type GlobeFrame, type LandMask,
} from '@shardkeep/shared/globe';
import { latTintIndex, navCamera, sunCameraVector, sunLonLat, TINT_BANDS, type GlobeNav } from './globeView';

// --- palette ----------------------------------------------------------------

/** Little-endian RGBA byte order in a Uint32Array view is 0xAABBGGRR. */
const rgba = (r: number, g: number, b: number): number =>
  ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/**
 * The material ids. Exported because a material is only ever OBSERVABLE as a
 * colour: a test that wants to say "this pixel is Georgia" or "with the flag off
 * nothing outside the shipped block was drawn" has to read the same two tables
 * the renderer read, and re-deriving them in the test would assert nothing.
 */
export const MAT_SPACE = 0;
export const MAT_OCEAN_A = 1;
export const MAT_OCEAN_B = 2;
export const MAT_RING = 3;
export const MAT_LAND = 4;
/** 2 dither variants per latitude band, so a continent has texture without a
 *  second sprite sheet or a second colour decision. */
export const LAND_VARIANTS = 2;
/** Where the flag-off material block ends. Every id below this one keeps exactly
 *  the colour it had before Earth tiles existed — that is what makes flag-off
 *  byte-for-byte rather than merely similar. */
export const MAT_LAND_END = MAT_LAND + TINT_BANDS * LAND_VARIANTS;

/** Natural Earth MAPCOLOR9 buckets: 1..9, and adjacent countries differ. */
export const COUNTRY_HUES = 9;
/**
 * First country material: `MAT_COUNTRY + ((color − 1)·TINT_BANDS + band)·2`, and
 * `+ 1` is that fill's dark twin — which the tile pass spends on the GRID LINE
 * rather than on a dither, so the grid costs no material of its own and is legible
 * on all 54 fills.
 */
export const MAT_COUNTRY = MAT_LAND_END;
const MAT_COUNTRY_END = MAT_COUNTRY + COUNTRY_HUES * TINT_BANDS * LAND_VARIANTS;
/** An INTERNATIONAL border: ink, one material for every country pair. */
export const MAT_BORDER = MAT_COUNTRY_END;
/** The seaward pixel of a COASTAL cell — the shoreline, darkened. */
export const MAT_COAST = MAT_BORDER + 1;
/** One pixel of surf on the OCEAN side of a coast. The plan's "one surf material". */
export const MAT_SURF = MAT_COAST + 1;
export const MAT_COUNT = MAT_SURF + 1;

/** Shade levels: 0 day · 1 dusk · 2 night. Three, not a gradient, because this
 *  is pixel art — a smooth ramp at 320 px just looks like a JPEG artefact. */
export const SHADES = 3;
const SHADE_MUL = [1, 0.72, 0.4];
/** Night is not merely darker, it is COLDER: shading mixes toward this instead
 *  of toward black, which is what keeps a night-side coastline readable. */
const NIGHT_TINT = [0x0a, 0x0e, 0x1a] as const;

/** The six latitude biome tints — the globe's existing terrain colour. */
const BANDS: Array<readonly [number, number, number]> = [
  [0xd6, 0xdc, 0xda], // 0 ice cap
  [0x8c, 0x8e, 0x74], // 1 tundra
  [0x4e, 0x6b, 0x45], // 2 boreal
  [0x71, 0x8c, 0x4e], // 3 temperate
  [0xa3, 0x8b, 0x54], // 4 arid / savanna
  [0x3f, 0x7b, 0x46], // 5 tropical
];

/**
 * The nine MAPCOLOR9 hues. Deliberately NOT nine saturated primaries: a tile is
 * territory on a pixel-art earth, not a political atlas plate, so these are
 * muted and are then blended 45% into the latitude biome tint — enough that two
 * neighbours never read as one country, little enough that the planet still reads
 * as land rather than as a chart.
 */
const HUES: Array<readonly [number, number, number]> = [
  [0x8e, 0x5a, 0x4a], // 1 clay
  [0x4a, 0x6e, 0x8e], // 2 slate blue
  [0x8e, 0x7d, 0x3f], // 3 ochre
  [0x5a, 0x7a, 0x4a], // 4 olive
  [0x7a, 0x4a, 0x6e], // 5 plum
  [0x3f, 0x7a, 0x72], // 6 teal
  [0x8e, 0x6a, 0x3f], // 7 amber
  [0x60, 0x5a, 0x8e], // 8 indigo
  [0x7a, 0x7a, 0x60], // 9 stone
];
/** How much of the country hue is mixed into the biome tint. */
const HUE_MIX = 0.45;

const mix1 = (a: number, b: number, w: number): number => Math.round(a * (1 - w) + b * w);

/** Day colours, `[r,g,b]`, indexed by material. */
const DAY: Array<readonly [number, number, number]> = (() => {
  const out: Array<readonly [number, number, number]> = [];
  out[MAT_SPACE] = [0, 0, 0];
  out[MAT_OCEAN_A] = [0x25, 0x44, 0x60];
  out[MAT_OCEAN_B] = [0x1b, 0x35, 0x4c];
  // The limb: a lighter rim, dithered against the ocean, reads as atmosphere and
  // gives the disc depth for the price of one extra material.
  out[MAT_RING] = [0x4a, 0x76, 0x8c];
  for (let b = 0; b < TINT_BANDS; b++) {
    const [r, g, bl] = BANDS[b]!;
    out[MAT_LAND + b * LAND_VARIANTS] = [r, g, bl];
    // The darker dither twin: −14% keeps the band identity but breaks up flats.
    out[MAT_LAND + b * LAND_VARIANTS + 1] = [
      Math.round(r * 0.86), Math.round(g * 0.86), Math.round(bl * 0.86),
    ];
  }
  // Country × biome. The dark twin doubles as the TILE GRID line, which is why
  // the grid costs no material of its own.
  for (let c = 0; c < COUNTRY_HUES; c++) {
    const h = HUES[c]!;
    for (let b = 0; b < TINT_BANDS; b++) {
      const t = BANDS[b]!;
      const r = mix1(t[0], h[0], HUE_MIX);
      const g = mix1(t[1], h[1], HUE_MIX);
      const bl = mix1(t[2], h[2], HUE_MIX);
      const i = MAT_COUNTRY + (c * TINT_BANDS + b) * LAND_VARIANTS;
      out[i] = [r, g, bl];
      out[i + 1] = [Math.round(r * 0.86), Math.round(g * 0.86), Math.round(bl * 0.86)];
    }
  }
  out[MAT_BORDER] = [0x2a, 0x22, 0x2c];
  out[MAT_COAST] = [0x1e, 0x2c, 0x36];
  out[MAT_SURF] = [0x6d, 0x9a, 0xad];
  return out;
})();

/** `PALETTE[mat * SHADES + shade]` — built once at module load. */
export const PALETTE = (() => {
  const pal = new Uint32Array(MAT_COUNT * SHADES);
  for (let m = 0; m < MAT_COUNT; m++) {
    const c = DAY[m] ?? [0, 0, 0];
    for (let s = 0; s < SHADES; s++) {
      const f = SHADE_MUL[s]!;
      pal[m * SHADES + s] = rgba(
        Math.round(c[0] * f + NIGHT_TINT[0] * (1 - f)),
        Math.round(c[1] * f + NIGHT_TINT[1] * (1 - f)),
        Math.round(c[2] * f + NIGHT_TINT[2] * (1 - f)),
      );
    }
  }
  return pal;
})();

// --- the country index, loaded the way the budget requires -------------------

/**
 * The generated country modules are DYNAMIC IMPORTS, both of them.
 *
 * The whole globe band is already behind a dynamic import (map.tsx), so a static
 * import here would not reach the first-paint number — but the measured headroom
 * is 5 KB of 1000 (EARTH-TILES-PLAN R8) and "it cannot reach the entry chunk"
 * is an argument, whereas an `import()` is a guarantee. It also means flag OFF
 * downloads none of it: the loader is never called.
 *
 * A failed load is NOT retried and NOT an error state: the silhouette pass keeps
 * drawing, exactly as the coarse mask keeps drawing while the fine one is in
 * flight.
 */
const idxByKey = new Map<string, CountryIndex>();
const idxTried = new Set<string>();
/**
 * EVERY waiter, not just the first one's. (P3, 2026-08-10)
 *
 * There are now two consumers of the same load: this rasteriser, which needs the
 * index to paint, and the chrome, which needs the country NAME under the crosshair
 * and in the tile inspector. `onReady` used to be captured once per key, so whichever
 * caller lost the race got `null` back and never heard that the index had landed —
 * a crosshair that stayed blank until the next gesture committed the camera. A set
 * of waiters costs nothing and makes the loader correct for N callers.
 *
 * A FAILED LOAD LEAVES THEM UNCALLED ON PURPOSE, and is never retried: the
 * silhouette keeps drawing and the chrome keeps saying nothing about countries,
 * exactly as the coarse mask keeps drawing while the fine one is in flight. A
 * missing chunk is a degradation, not an error state.
 */
const idxWaiters = new Map<string, Set<() => void>>();

/**
 * The country index for a mask, loaded the way the budget requires.
 *
 * Exported because the CHROME needs the same object (EARTH-TILES-PLAN P3): the
 * inspector's country name and the crosshair readout must come from the index the
 * pixels were painted from, or the two could disagree about what a tile is. It
 * keys on the mask's DIMENSIONS and refuses a resolution mismatch rather than
 * painting a lie — country ids are only meaningful against the index the byte was
 * read from.
 */
export function countryIndexFor(m: LandMask, onReady?: () => void): CountryIndex | null {
  const key = `${m.cols}x${m.rows}`;
  const hit = idxByKey.get(key);
  if (hit) return hit;
  const fine = m.cols === GLOBE.fineCols && m.rows === GLOBE.fineRows;
  const coarse = m.cols === GLOBE.coarseCols && m.rows === GLOBE.coarseRows;
  if (!fine && !coarse) return null;
  if (onReady) {
    const set = idxWaiters.get(key) ?? new Set<() => void>();
    set.add(onReady);
    idxWaiters.set(key, set);
  }
  if (idxTried.has(key)) return null;
  idxTried.add(key);
  const load: Promise<CountryIndex> = fine
    ? import('@shardkeep/shared/earthCountriesFine').then((x) => x.EARTH_COUNTRIES_FINE)
    : import('@shardkeep/shared/earthCountries').then((x) => x.EARTH_COUNTRIES);
  void load.then((idx) => {
    // The index is keyed by RANK in this mask's land-cell list, so a mismatched
    // pair would silently paint the wrong countries. Refuse rather than draw a
    // lie — the same standing as the generator's own byte-identity throw.
    if (idx.cols !== m.cols || idx.rows !== m.rows || idx.cells.length !== m.landCells) return;
    idxByKey.set(key, idx);
    const waiting = idxWaiters.get(key);
    idxWaiters.delete(key);
    if (waiting) for (const cb of waiting) cb();
  }).catch(() => { /* silhouette keeps drawing */ });
  return null;
}

// --- per-mask derived tables -------------------------------------------------

/**
 * Corner trig, the tile pass's half of `GlobeFrame`.
 *
 * DEVIATION FROM THE PLAN, RECORDED ON PURPOSE: EARTH-TILES-PLAN §4.1(2) puts
 * `sinLatE`/`cosLatE`/`sinDE`/`cosDE` on `GlobeFrame` in `packages/shared`. P2's
 * brief scopes this phase to `apps/web/src/ui/screens/globe/*`, so the corner
 * tables live here instead — same tables, same cost (`cols` extra trig calls per
 * frame: 1,441 vs 1,440 for the fine mask), and `packages/shared` keeps a
 * `GlobeFrame` with no unused fields. If a later phase needs corners on the
 * server, this is the block to move.
 *
 * `sinDE`/`cosDE` are `cols + 1` long and entry `cols` MIRRORS entry 0: corner
 * column `cols` is longitude +180, which is the same meridian as −180, so the
 * mirror removes a modulo from the hot path.
 */
interface EdgeFrame {
  cols: number;
  rows: number;
  readonly sinLatE: Float64Array;
  readonly cosLatE: Float64Array;
  readonly sinDE: Float64Array;
  readonly cosDE: Float64Array;
  sinPhi0: number;
  cosPhi0: number;
  R: number;
  cx: number;
  cy: number;
  lam0: number;
  /**
   * TWO CORNER ROWS, indexed by the PARITY of the mask row they hold. That is
   * what makes the bottom edge of row `iy` the top edge of row `iy + 1` for free:
   * the stamp carries the row id, so walking rows in order finds every shared
   * corner already computed and nothing has to be copied or swapped.
   */
  readonly cxs: [Float64Array, Float64Array];
  readonly cys: [Float64Array, Float64Array];
  readonly ccs: [Float64Array, Float64Array];
  readonly cst: [Int32Array, Int32Array];
}

function makeEdgeFrame(cols: number, rows: number): EdgeFrame {
  const sinLatE = new Float64Array(rows + 1);
  const cosLatE = new Float64Array(rows + 1);
  const dLat = 180 / rows;
  for (let iy = 0; iy <= rows; iy++) {
    const lat = (90 - iy * dLat) * DEG_TO_RAD;
    sinLatE[iy] = Math.sin(lat);
    cosLatE[iy] = Math.cos(lat);
  }
  const corner = (): [Float64Array, Float64Array] => [new Float64Array(cols + 1), new Float64Array(cols + 1)];
  return {
    cols,
    rows,
    sinLatE,
    cosLatE,
    sinDE: new Float64Array(cols + 1),
    cosDE: new Float64Array(cols + 1),
    sinPhi0: 0,
    cosPhi0: 1,
    R: 1,
    cx: 0,
    cy: 0,
    lam0: 0,
    cxs: corner(),
    cys: corner(),
    ccs: corner(),
    cst: [new Int32Array(cols + 1).fill(-1), new Int32Array(cols + 1).fill(-1)],
  };
}

/** Refill the per-corner-longitude table for a new camera. Allocates nothing. */
function updateEdgeFrame(ef: EdgeFrame, cam: GlobeCamera): void {
  const dLon = 360 / ef.cols;
  for (let ix = 0; ix < ef.cols; ix++) {
    const d = (-180 + ix * dLon) * DEG_TO_RAD - cam.lam0;
    ef.sinDE[ix] = Math.sin(d);
    ef.cosDE[ix] = Math.cos(d);
  }
  ef.sinDE[ef.cols] = ef.sinDE[0]!;
  ef.cosDE[ef.cols] = ef.cosDE[0]!;
  ef.sinPhi0 = Math.sin(cam.phi0);
  ef.cosPhi0 = Math.cos(cam.phi0);
  ef.R = cam.R;
  ef.cx = cam.cx;
  ef.cy = cam.cy;
  ef.lam0 = cam.lam0;
  // The camera moved, so every cached corner is stale. Two 721-entry fills, not
  // 259,200 projections.
  ef.cst[0].fill(-1);
  ef.cst[1].fill(-1);
}

/** Project one cell corner into the parity buffer for its row, once per frame. */
function corner(ef: EdgeFrame, ix: number, iy: number): number {
  const b = iy & 1;
  const st = ef.cst[b]!;
  if (st[ix] === iy) return b;
  const sinPhi = ef.sinLatE[iy]!;
  const cosPhi = ef.cosLatE[iy]!;
  const sinD = ef.sinDE[ix]!;
  const cosD = ef.cosDE[ix]!;
  ef.ccs[b]![ix] = ef.sinPhi0 * sinPhi + ef.cosPhi0 * cosPhi * cosD;
  // ROUNDED, like the camera: a 1 px grid crawls otherwise (plan §4.4).
  ef.cxs[b]![ix] = Math.round(ef.cx + ef.R * cosPhi * sinD);
  ef.cys[b]![ix] = Math.round(ef.cy - ef.R * (ef.cosPhi0 * sinPhi - ef.sinPhi0 * cosPhi * cosD));
  st[ix] = iy;
  return b;
}

/** N / E / S / W, as the mask sees them: `iy` grows SOUTH. */
const E_N = 1;
const E_E = 2;
const E_S = 4;
const E_W = 8;
/** The same four sides, one nibble up, when the neighbour is not claimable at
 *  all (ocean, or ground with no sovereign) — a COAST rather than a border. */
const COAST_SHIFT = 4;

/** Cell size in raster px below which a 1 px grid is moiré rather than a grid. */
export const GRID_MIN_PX = 3;
/** …and below which a border eats the tile it is bordering. */
const EDGE_MIN_PX = 2;

/** Everything the tile pass needs that is a property of the MASK, not the frame. */
export interface TileTables {
  idx: CountryIndex;
  /** Material for each land cell BY RANK, dither variant NOT included. */
  matBase: Uint8Array;
  /** `E_*` border bits, plus the same four shifted by `COAST_SHIFT`, by rank. */
  edge: Uint8Array;
  /** Is this rank claimable Earth (i.e. has a sovereign)? Antarctica is not. */
  claim: Uint8Array;
  /** Rank of the first land cell of each mask row; `rows + 1` entries. */
  rowOff: Int32Array;
  /** The sub-tile countries' cells, which the MASK calls ocean (plan §9). */
  extraCells: Int32Array;
  extraMat: Uint8Array;
}

/**
 * Bake the country material, the edge bits and the row offsets for one mask.
 *
 * Called once per (mask, index) pair and memoised on the mask, so none of this is
 * per-frame work. The neighbour lookup goes through a transient full-grid
 * `Uint8Array` of country ids (259 KB at 0.5°, released when this returns) rather
 * than 4 × 86,122 binary searches.
 */
export function buildTileTables(m: LandMask, idx: CountryIndex, rowTint: Uint8Array): TileTables {
  const cells = landCellList(m);
  const n = cells.length;
  const matBase = new Uint8Array(n);
  const claim = new Uint8Array(n);
  const edge = new Uint8Array(n);
  const rowOff = new Int32Array(m.rows + 1);
  // Country id per GRID cell — 0 for ocean AND for ground with no sovereign,
  // which is the whole point: `id !== 0` is the single "is this claimable" test,
  // so a border against Antarctica reads as a coast, which is what it looks like.
  const ids = new Uint8Array(m.cols * m.rows);
  for (let rank = 0; rank < n; rank++) ids[cells[rank]!] = countryIdAtRank(idx, rank);
  for (let i = 0; i < idx.extraCells.length; i++) ids[idx.extraCells[i]!] = idx.extraIds[i]!;

  const matFor = (id: number, iy: number): number => {
    const band = rowTint[iy]!;
    if (id === 0) return MAT_LAND + band * LAND_VARIANTS;
    const hue = Math.min(COUNTRY_HUES, Math.max(1, idx.countries[id - 1]?.color ?? 1)) - 1;
    return MAT_COUNTRY + (hue * TINT_BANDS + band) * LAND_VARIANTS;
  };

  let row = 0;
  for (let rank = 0; rank < n; rank++) {
    const cell = cells[rank]!;
    const iy = (cell / m.cols) | 0;
    const ix = cell - iy * m.cols;
    while (row <= iy) rowOff[row++] = rank;
    const id = ids[cell]!;
    matBase[rank] = matFor(id, iy);
    claim[rank] = id === 0 ? 0 : 1;
    if (id === 0) continue; // Antarctica gets no grid and no border: it is not land you can own.
    // Longitude WRAPS (the antimeridian is a column boundary, not an edge of the
    // world); latitude does not — off the pole there is no neighbour, and no
    // border either.
    const w = ids[cell - ix + ((ix + m.cols - 1) % m.cols)]!;
    const e = ids[cell - ix + ((ix + 1) % m.cols)]!;
    const nn = iy > 0 ? ids[cell - m.cols]! : 0;
    const s = iy < m.rows - 1 ? ids[cell + m.cols]! : 0;
    let bits = 0;
    if (nn === 0) bits |= E_N << COAST_SHIFT; else if (nn !== id) bits |= E_N;
    if (e === 0) bits |= E_E << COAST_SHIFT; else if (e !== id) bits |= E_E;
    if (s === 0) bits |= E_S << COAST_SHIFT; else if (s !== id) bits |= E_S;
    if (w === 0) bits |= E_W << COAST_SHIFT; else if (w !== id) bits |= E_W;
    edge[rank] = bits;
  }
  while (row <= m.rows) rowOff[row++] = n;

  const extraMat = new Uint8Array(idx.extraCells.length);
  for (let i = 0; i < idx.extraCells.length; i++) {
    extraMat[i] = matFor(idx.extraIds[i]!, (idx.extraCells[i]! / m.cols) | 0);
  }
  return { idx, matBase, edge, claim, rowOff, extraCells: idx.extraCells, extraMat };
}

interface MaskTables {
  frame: GlobeFrame;
  cells: Int32Array;
  /** Latitude tint band per mask ROW — the free colour LUT the plan calls for:
   *  the row index is already in hand for every cell. */
  rowTint: Uint8Array;
  /** Corner trig for the tile pass. Allocated with the mask, refilled per frame,
   *  and NEVER touched with the flag off. */
  edgeFrame: EdgeFrame;
  /** Built the first time the tile pass runs with an index in hand. */
  tiles: TileTables | null;
}
const tables = new WeakMap<LandMask, MaskTables>();

function tablesFor(m: LandMask): MaskTables {
  const hit = tables.get(m);
  if (hit) return hit;
  const rowTint = new Uint8Array(m.rows);
  const ll = { lon: 0, lat: 0 };
  for (let iy = 0; iy < m.rows; iy++) {
    cellCentreDeg(m, 0, iy, ll);
    rowTint[iy] = latTintIndex(ll.lat);
  }
  const t: MaskTables = {
    frame: makeFrame(m.cols, m.rows),
    cells: landCellList(m),
    rowTint,
    edgeFrame: makeEdgeFrame(m.cols, m.rows),
    tiles: null,
  };
  tables.set(m, t);
  return t;
}

// --- the rasteriser ---------------------------------------------------------

export interface EarthDrawOpts {
  /** Board size in CSS px. */
  vw: number;
  vh: number;
  /** Device pixel ratio of the destination canvas (its backing store is
   *  vw·dpr × vh·dpr). Does NOT affect the raster cost — only the blit. */
  dpr: number;
  nav: GlobeNav;
  mask: LandMask;
  /** UTC ms for the terminator. Passed in (never read from a clock in here) so
   *  the shadow is reproducible and the component owns the only clock. */
  sunMs: number;
  /** Layer opacity for the band cross-fade. */
  alpha: number;
  /** `VITE_FEATURE_EARTH_TILES`. Off ⇒ the shipped splat loop, byte for byte. */
  tiles?: boolean;
}

export interface EarthStats {
  /** Land cells that produced pixels on the last frame. */
  cells: number;
  /** Raster buffer dimensions actually in use. */
  bw: number;
  bh: number;
  /** Wall-clock ms of the last `draw`, for the frame-cost measurement. */
  ms: number;
  /** Did the EARTH TILES pass draw the last frame? False whenever the flag is
   *  off, and also while a country index is still in flight — so "is the tile
   *  path live" is a measurement off the running app, not an assumption. */
  tiles: boolean;
  /** Mask rows walked on the last frame. With the flag off this is 0: the old
   *  pass has no notion of a row window, which is the cost it pays. */
  rows: number;
}

/**
 * ONE COUNTRY LABEL ANCHOR, in RASTER px, as the tile pass measured it this frame.
 *
 * The plan's §4.2 promise that the below-z1 country names are "computable inside the
 * same row walk for free" is literally true: the pass is already visiting every
 * visible cell and already knows its country, so an area-weighted centroid is three
 * adds per cell. That is why the anchor is the country's VISIBLE centroid rather
 * than its true one — a label for a country half-way round the limb belongs on the
 * half you can see, and a real centroid would put Russia's name behind the planet.
 *
 * `x` / `y` are raster px (the buffer is a fixed GLOBE.px-tall ImageData), so the
 * text pass divides by the same `scale` the projection used. `area` is drawn pixels,
 * which is what the visibility ranking has to be: the biggest thing on screen, not
 * the biggest thing on Earth.
 */
export interface CountryLabel {
  id: number;
  name: string;
  x: number;
  y: number;
  area: number;
}

/**
 * A country needs this many drawn raster px before it is worth a name.
 *
 * The whole disc is ~12,700 raster px at zoom 0 and land is ~30% of it, so 40 px is
 * about a third of a percent of the planet — enough to reject the slivers that make
 * a label field look like noise, low enough that the six largest visible countries
 * always qualify. With `GLOBE_VIEW.labelMax` on top, the worst case below z1 is six
 * plates, which is the budget the ladder promises.
 */
export const LABEL_MIN_PX = 40;

export interface EarthRaster {
  draw(ctx: CanvasRenderingContext2D, o: EarthDrawOpts): void;
  readonly stats: EarthStats;
  /**
   * The country label anchors for the LAST frame, biggest visible first, already
   * filtered by `LABEL_MIN_PX`. Empty whenever the tile pass did not run (flag off,
   * or the index still in flight), so the caller needs no second condition.
   *
   * Read straight after `draw` and used immediately — it is rewritten in place every
   * frame rather than reallocated, for the same reason nothing else in this file
   * allocates per frame.
   */
  readonly labels: readonly CountryLabel[];
}

/**
 * TODAY'S LAND PASS, verbatim, in a named function.
 *
 * One splat per cell. Side = R·Δlat (radians): for a 2:1 equirectangular mask
 * Δlon == Δlat, so a square of that side covers a cell at the equator and
 * over-covers it toward the poles (cos φ shrinks the longitude extent) —
 * over-draw, never a gap.
 *
 * This is what `tiles: false` draws, and the reason it was moved rather than
 * rewritten: flag-off has to be the shipped picture, and the cheapest proof of
 * that is that the code producing it did not change.
 */
function splatLandPass(
  mat: Uint8Array, bw: number, bh: number, cam: GlobeCamera, m: LandMask, t: MaskTables,
): number {
  const { R, cx, cy } = cam;
  const f = t.frame;
  const p = newProjected();
  const side = Math.max(1, Math.ceil((R * Math.PI) / m.rows) + 1);
  const half = side / 2;
  const R2 = R * R;
  const cells = t.cells;
  let drawn = 0;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    splatIndex(f, cell, p);
    if (!p.visible) continue;
    let sx0 = Math.round(p.x - half);
    let sy0 = Math.round(p.y - half);
    let sx1 = sx0 + side;
    let sy1 = sy0 + side;
    if (sx1 <= 0 || sy1 <= 0 || sx0 >= bw || sy0 >= bh) continue;
    if (sx0 < 0) sx0 = 0;
    if (sy0 < 0) sy0 = 0;
    if (sx1 > bw) sx1 = bw;
    if (sy1 > bh) sy1 = bh;
    const iy = (cell / f.cols) | 0;
    const base = MAT_LAND + t.rowTint[iy]! * LAND_VARIANTS;
    // Deterministic per-cell dither variant (no Math.random: a globe that
    // re-dithers itself every frame boils).
    const variant = ((cell * 2654435761) >>> 29) & 1;
    const m0 = base + variant;
    // Near the limb the square would spill past the silhouette, so those cells
    // — and only those — pay a per-pixel disc test.
    const clip = p.cosc < 0.35;
    for (let yy = sy0; yy < sy1; yy++) {
      const row = yy * bw;
      if (clip) {
        const dy = yy - cy;
        const dy2 = dy * dy;
        for (let xx = sx0; xx < sx1; xx++) {
          const dx = xx - cx;
          if (dx * dx + dy2 <= R2) mat[row + xx] = m0;
        }
      } else {
        for (let xx = sx0; xx < sx1; xx++) mat[row + xx] = m0;
      }
    }
    drawn++;
  }
  return drawn;
}

/**
 * THE LONGITUDE WINDOW FOR ONE MASK ROW, as up to four column spans.
 *
 * Two constraints, both solved rather than sampled:
 *  1. `cosc ≥ 0` (the near hemisphere) ⇒ |Δ| ≤ acos(−sinφ₀sinφ / cosφ₀cosφ).
 *  2. |x − cx| ≤ halfW + pad ⇒ |sinΔ| ≤ (halfW + pad)/(R cosφ).
 *
 * Constraint 2 is NOT monotone over constraint 1's whole range: |sinΔ| falls
 * again as Δ approaches π, and those Δ are real, visible, over-the-pole ground.
 * So the answer is the near arc [−w, w] PLUS, when the near-hemisphere arc
 * actually reaches that far, the two far arcs either side of the antimeridian.
 * Dropping them would punch a hole in the planet at a polar camera, which is
 * exactly the class of bug a windowed walk invites.
 *
 * Both constraints are evaluated at the row's WIDER edge (smallest cos φ for the
 * x bound, largest arc for the visibility bound), so the window can only ever be
 * too generous — a cell may be walked and rejected by its bbox, never skipped.
 *
 * @returns the number of spans written, as `[lo, hi]` inclusive column pairs
 *   already wrapped into `[0, cols − 1]`. At most `SPANS_MAX`.
 */
export const SPANS_MAX = 6;

function rowColumnSpans(
  out: Int32Array, ef: EdgeFrame, iy: number, halfW: number, pad: number,
): number {
  const cols = ef.cols;
  const sinA = ef.sinLatE[iy]!;
  const sinB = ef.sinLatE[iy + 1]!;
  const cosA = ef.cosLatE[iy]!;
  const cosB = ef.cosLatE[iy + 1]!;
  const arc = (sinPhi: number, cosPhi: number): number => {
    const A = ef.sinPhi0 * sinPhi;
    const B = ef.cosPhi0 * cosPhi;
    if (B <= 1e-12) return A >= 0 ? Math.PI : 0;
    const r = -A / B;
    return r <= -1 ? Math.PI : r >= 1 ? 0 : Math.acos(r);
  };
  const w1 = Math.max(arc(sinA, cosA), arc(sinB, cosB));
  if (w1 <= 0) return 0;
  const cosMin = Math.min(cosA, cosB);
  const s = cosMin <= 1e-12 ? 2 : (halfW + pad) / (ef.R * cosMin);
  const w2 = s >= 1 ? Math.PI : Math.asin(s);
  // Δ per COLUMN, and the fractional column of the camera's own meridian.
  const dCol = (2 * Math.PI) / cols;
  const c0 = (ef.lam0 + Math.PI) / dCol;
  let n = 0;
  const push = (a: number, b: number): void => {
    // One cell of pad each side, then wrap into [0, cols − 1] as one or two spans.
    let lo = Math.floor(c0 + a / dCol) - 1;
    let hi = Math.floor(c0 + b / dCol) + 1;
    if (hi - lo >= cols - 1) { out[n++] = 0; out[n++] = cols - 1; return; }
    lo = ((lo % cols) + cols) % cols;
    hi = ((hi % cols) + cols) % cols;
    if (lo <= hi) { out[n++] = lo; out[n++] = hi; return; }
    out[n++] = lo; out[n++] = cols - 1;
    out[n++] = 0; out[n++] = hi;
  };
  const near = Math.min(w1, w2);
  push(-near, near);
  if (w2 < Math.PI && w1 > Math.PI - w2) {
    push(Math.PI - w2, w1);
    push(-w1, -(Math.PI - w2));
  }
  return n / 2;
}

/**
 * THE EARTH TILES LAND PASS — real cell quads, windowed, bordered, gridded.
 *
 * Writes material ids exactly as the old pass does, so pass 2 (the terminator)
 * and the blit are unchanged: a tile is shaded by the same sun as the ocean it
 * sits in, and a night-side border is still a border.
 */
/**
 * The per-country visible-area accumulator: `[area, Σx·area, Σy·area]` by country
 * id. Allocated once per raster (256 × 3 doubles = 6 KB) and zeroed per frame, which
 * is 768 writes against the 8,000-cell walk it serves.
 */
const LABEL_ACC_STRIDE = 3;
/** Country ids are a `Uint8Array` byte, so 0…255 is the whole possible range and
 *  the accumulator can be sized once for any data refresh (the generator asserts
 *  `features ≤ 255` for exactly this reason). */
const COUNTRY_IDS = 256;

function quadLandPass(
  mat: Uint8Array, bw: number, bh: number, cam: GlobeCamera, m: LandMask,
  t: MaskTables, tt: TileTables, spans: Int32Array, tileRes: boolean, acc: Float64Array,
): { cells: number; rows: number } {
  const ef = t.edgeFrame;
  const { R, cx, cy } = cam;
  const R2 = R * R;
  const cells = t.cells;
  const cols = m.cols;
  const rows = m.rows;
  const halfW = Math.max(cx, bw - cx);
  const halfH = Math.max(cy, bh - cy);
  // The biggest a cell can be on screen — the pad every window is widened by, so
  // a cell whose CORNERS are off screen but whose body is not still gets walked.
  const pad = Math.ceil((R * Math.PI) / rows) + 2;
  // The screen box as an angular radius from the camera centre: one asin, once.
  const alpha = Math.asin(Math.min(1, Math.hypot(halfW + pad, halfH + pad) / Math.max(1e-6, R)));
  const dLat = 180 / rows;
  const phiDeg = cam.phi0 / DEG_TO_RAD;
  const aDeg = alpha / DEG_TO_RAD;
  const iy0 = Math.max(0, Math.floor((90 - Math.min(90, phiDeg + aDeg)) / dLat) - 1);
  const iy1 = Math.min(rows - 1, Math.floor((90 - Math.max(-90, phiDeg - aDeg)) / dLat) + 1);

  let drawn = 0;
  let walkedRows = 0;

  // The clipped box of the cell being decorated, and whether it needs the disc
  // test. Held in the PASS's scope, not the cell's: the four line helpers below
  // are allocated once per pass rather than six closures per cell, which at
  // 8,000 cells a frame is the difference between free and a GC pause.
  let qx0 = 0;
  let qx1 = 0;
  let qy0 = 0;
  let qy1 = 0;
  let qclip = false;

  /** One horizontal run inside the cell, only over pixels this cell owns. */
  const hline = (yy: number, mval: number): void => {
    if (yy < qy0 || yy >= qy1) return;
    const row = yy * bw;
    if (qclip) {
      const dy = yy - cy;
      const dy2 = dy * dy;
      for (let xx = qx0; xx < qx1; xx++) {
        const dx = xx - cx;
        if (dx * dx + dy2 <= R2) mat[row + xx] = mval;
      }
    } else {
      for (let xx = qx0; xx < qx1; xx++) mat[row + xx] = mval;
    }
  };
  const vline = (xx: number, mval: number): void => {
    if (xx < qx0 || xx >= qx1) return;
    const dx = xx - cx;
    const dx2 = dx * dx;
    for (let yy = qy0; yy < qy1; yy++) {
      if (qclip) {
        const dy = yy - cy;
        if (dx2 + dy * dy > R2) continue;
      }
      mat[yy * bw + xx] = mval;
    }
  };
  /**
   * One pixel of surf, OUTSIDE the cell.
   *
   * Two rules, both load-bearing. It is written ONLY over ocean, so it can never
   * overwrite a neighbouring tile (land cells are walked in ascending order, so a
   * surf pixel can land on ground that has not been drawn yet — that one is
   * harmless, it gets overwritten; landing on ground already drawn would not be).
   * And it is DITHERED against the ocean on the same `(x + y) & 1` checker the limb
   * ring and the terminator use: solid, it read as a cartographic halo around every
   * continent rather than as surf.
   */
  const surfH = (yy: number): void => {
    if (yy < 0 || yy >= bh) return;
    const row = yy * bw;
    for (let xx = qx0; xx < qx1; xx++) {
      if ((xx + yy) & 1) continue;
      const cur = mat[row + xx]!;
      if (cur === MAT_OCEAN_A || cur === MAT_OCEAN_B) mat[row + xx] = MAT_SURF;
    }
  };
  const surfV = (xx: number): void => {
    if (xx < 0 || xx >= bw) return;
    for (let yy = qy0; yy < qy1; yy++) {
      if ((xx + yy) & 1) continue;
      const cur = mat[yy * bw + xx]!;
      if (cur === MAT_OCEAN_A || cur === MAT_OCEAN_B) mat[yy * bw + xx] = MAT_SURF;
    }
  };

  /**
   * Fill one cell quad and its decorations.
   *
   * NO PER-CELL DITHER, and that is a deliberate difference from the silhouette
   * pass rather than an omission. The dither exists because the old planet had six
   * colours: without it a continent is one flat. A tiled planet has 54 fills, a
   * grid line and two edge inks, and at 5–50 px per cell the ±14% twin stopped
   * reading as texture and started reading as VERTICAL BANDING across a country
   * (looked at on a 375 px board before it was removed). The dark twin still
   * earns its palette slot as the grid line.
   *
   * @param base      the cell's fill material.
   * @param edgeBits  baked `E_*` border bits + coast bits, or 0 for no edges.
   * @param asTile    this cell IS a tile: the mask is the 0.5° grid AND the cell is
   *   claimable, so it gets the 1 px grid and its international borders. Below tile
   *   resolution a 2° cell is not a tile and its neighbour is not a country
   *   boundary, so the coarse band gets country FILLS and COASTLINES only — which
   *   is exactly what EARTH-TILES-PLAN §4.3 prescribes for that band. Antarctica is
   *   never a tile at any resolution: it has no sovereign, so it is not claimable.
   */
  const quad = (
    ix: number, iy: number, base: number, edgeBits: number, asTile: boolean, cid: number,
  ): void => {
    const bT = corner(ef, ix, iy);
    corner(ef, ix + 1, iy);
    const bB = corner(ef, ix, iy + 1);
    corner(ef, ix + 1, iy + 1);
    const xT = ef.cxs[bT]!;
    const yT = ef.cys[bT]!;
    const cT = ef.ccs[bT]!;
    const xB = ef.cxs[bB]!;
    const yB = ef.cys[bB]!;
    const cB = ef.ccs[bB]!;
    const c00 = cT[ix]!;
    const c10 = cT[ix + 1]!;
    const c01 = cB[ix]!;
    const c11 = cB[ix + 1]!;
    if (c00 < 0 && c10 < 0 && c01 < 0 && c11 < 0) return; // wholly on the far side
    const x00 = xT[ix]!;
    const x10 = xT[ix + 1]!;
    const x01 = xB[ix]!;
    const x11 = xB[ix + 1]!;
    const y00 = yT[ix]!;
    const y10 = yT[ix + 1]!;
    const y01 = yB[ix]!;
    const y11 = yB[ix + 1]!;
    // HALF-OPEN in both axes, which is what makes neighbours TILE: this cell's
    // right corner is its neighbour's left corner, and only one of them owns that
    // column of pixels.
    let sx0 = Math.min(x00, x10, x01, x11);
    let sx1 = Math.max(x00, x10, x01, x11);
    let sy0 = Math.min(y00, y10, y01, y11);
    let sy1 = Math.max(y00, y10, y01, y11);
    // A cell narrower than a pixel still has to paint one, or the planet gets
    // holes where longitude converges at the poles.
    if (sx1 <= sx0) sx1 = sx0 + 1;
    if (sy1 <= sy0) sy1 = sy0 + 1;
    if (sx1 <= 0 || sy1 <= 0 || sx0 >= bw || sy0 >= bh) return;
    const w = sx1 - sx0;
    const h = sy1 - sy0;
    const cx0 = sx0 < 0 ? 0 : sx0;
    const cx1 = sx1 > bw ? bw : sx1;
    const cy0 = sy0 < 0 ? 0 : sy0;
    const cy1 = sy1 > bh ? bh : sy1;
    if (cx1 <= cx0 || cy1 <= cy0) return;
    // Only cells near the limb pay a per-pixel disc test, exactly as before.
    const clip = Math.min(c00, c10, c01, c11) < 0.35;
    for (let yy = cy0; yy < cy1; yy++) {
      const row = yy * bw;
      if (clip) {
        const dy = yy - cy;
        const dy2 = dy * dy;
        for (let xx = cx0; xx < cx1; xx++) {
          const dx = xx - cx;
          if (dx * dx + dy2 <= R2) mat[row + xx] = base;
        }
      } else {
        for (let xx = cx0; xx < cx1; xx++) mat[row + xx] = base;
      }
    }
    drawn++;
    // THE COUNTRY LABEL ANCHOR, accumulated in the pass that is already here.
    // Area-weighted, and weighted by the CLIPPED box, so a country sliding off the
    // edge of the board loses its label rather than dragging it out of view.
    if (cid !== 0) {
      const a = (cx1 - cx0) * (cy1 - cy0);
      const o = cid * LABEL_ACC_STRIDE;
      acc[o] = acc[o]! + a;
      acc[o + 1] = acc[o + 1]! + a * (cx0 + cx1) * 0.5;
      acc[o + 2] = acc[o + 2]! + a * (cy0 + cy1) * 0.5;
    }
    if (h < EDGE_MIN_PX || w < EDGE_MIN_PX) return;
    qx0 = cx0;
    qx1 = cx1;
    qy0 = cy0;
    qy1 = cy1;
    qclip = clip;

    // THE TILE GRID: the material's own dark twin, so it costs no material and is
    // legible on every hue. Top + left only, so adjacent tiles share one line.
    if (asTile && w >= GRID_MIN_PX && h >= GRID_MIN_PX) {
      hline(sy0, base + 1);
      vline(sx0, base + 1);
    }
    if (edgeBits === 0) return;
    // COASTS AT EVERY RESOLUTION — a coastline is a fact about the mask, and it is
    // what keeps a continent's shape readable once the whole planet is coloured.
    if (edgeBits & (E_N << COAST_SHIFT)) { hline(sy0, MAT_COAST); surfH(sy0 - 1); }
    if (edgeBits & (E_S << COAST_SHIFT)) { hline(sy1 - 1, MAT_COAST); surfH(sy1); }
    if (edgeBits & (E_W << COAST_SHIFT)) { vline(sx0, MAT_COAST); surfV(sx0 - 1); }
    if (edgeBits & (E_E << COAST_SHIFT)) { vline(sx1 - 1, MAT_COAST); surfV(sx1); }
    if (!asTile) return;
    // Borders over coasts: where NE draws a boundary down a shoreline the boundary
    // is the more informative line.
    if (edgeBits & E_N) hline(sy0, MAT_BORDER);
    if (edgeBits & E_S) hline(sy1 - 1, MAT_BORDER);
    if (edgeBits & E_W) vline(sx0, MAT_BORDER);
    if (edgeBits & E_E) vline(sx1 - 1, MAT_BORDER);
  };

  for (let iy = iy0; iy <= iy1; iy++) {
    const lo = tt.rowOff[iy]!;
    const hi = tt.rowOff[iy + 1]!;
    if (lo >= hi) continue; // an all-ocean row: the Pacific costs one compare
    const nSpans = rowColumnSpans(spans, ef, iy, halfW, pad);
    if (nSpans === 0) continue;
    walkedRows++;
    const rowBase = iy * cols;
    for (let s = 0; s < nSpans; s++) {
      const cLo = spans[s * 2]!;
      const cHi = spans[s * 2 + 1]!;
      const from = rowBase + cLo;
      const to = rowBase + cHi;
      // Binary search for the row's first land cell inside this span. The row's
      // slice of `landCellList` is ascending, so this is the whole windowing win:
      // the walk never touches a cell outside the box.
      let a = lo;
      let b = hi - 1;
      let start = hi;
      while (a <= b) {
        const mid = (a + b) >> 1;
        if (cells[mid]! >= from) { start = mid; b = mid - 1; } else a = mid + 1;
      }
      for (let rank = start; rank < hi; rank++) {
        const cell = cells[rank]!;
        if (cell > to) break;
        const claimable = tt.claim[rank] === 1;
        // The country id BY RANK is the index's own array — no extra table, and it
        // is the same byte the material was baked from.
        quad(cell - rowBase, iy, tt.matBase[rank]!, tt.edge[rank]!, tileRes && claimable,
          tt.idx.cells[rank]!);
      }
    }
  }

  // The sub-tile countries: 57 cells at 0.5° that the majority rule calls ocean
  // and that are nonetheless where those countries ARE (plan §9). Every side of
  // one is a coast by construction, and there are too few to window.
  const allCoast = (E_N | E_E | E_S | E_W) << COAST_SHIFT;
  for (let i = 0; i < tt.extraCells.length; i++) {
    const cell = tt.extraCells[i]!;
    const iy = (cell / cols) | 0;
    if (iy < iy0 || iy > iy1) continue;
    quad(cell - iy * cols, iy, tt.extraMat[i]!, allCoast, tileRes, tt.idx.extraIds[i]!);
  }

  return { cells: drawn, rows: walkedRows };
}

export function createEarthRaster(onTablesReady?: () => void): EarthRaster {
  let buf: HTMLCanvasElement | null = null;
  let bctx: CanvasRenderingContext2D | null = null;
  let img: ImageData | null = null;
  let out: Uint32Array | null = null;
  let mat: Uint8Array | null = null;
  let bw = 0;
  let bh = 0;
  /** Scratch for `rowColumnSpans`, allocated once per raster, never per frame. */
  const spans = new Int32Array(SPANS_MAX * 2);
  const stats: EarthStats = { cells: 0, bw: 0, bh: 0, ms: 0, tiles: false, rows: 0 };
  /** The country label accumulator and the list it produces — both allocated once,
   *  the list rewritten in place, because nothing in this file allocates per frame. */
  const labelAcc = new Float64Array(COUNTRY_IDS * LABEL_ACC_STRIDE);
  const labels: CountryLabel[] = [];

  /** The buffer is GLOBE.px TALL and follows the board's aspect. Height is the
   *  anchor because both the disc and the zoom ladder are sized off the SHORT
   *  side in portrait, which is the case that has to look right first. */
  function ensureBuffer(vw: number, vh: number): boolean {
    const h = GLOBE.px;
    const w = Math.max(16, Math.min(GLOBE.px * 3, Math.round((GLOBE.px * vw) / Math.max(1, vh))));
    if (buf && bw === w && bh === h) return true;
    buf ??= document.createElement('canvas');
    buf.width = w;
    buf.height = h;
    bctx = buf.getContext('2d', { willReadFrequently: true });
    if (!bctx) return false;
    img = bctx.createImageData(w, h);
    out = new Uint32Array(img.data.buffer);
    mat = new Uint8Array(w * h);
    bw = w;
    bh = h;
    stats.bw = w;
    stats.bh = h;
    return true;
  }

  function draw(ctx: CanvasRenderingContext2D, o: EarthDrawOpts): void {
    const t0 = performance.now();
    if (o.vw <= 0 || o.vh <= 0 || !ensureBuffer(o.vw, o.vh) || !bctx || !img || !out || !mat) return;

    const scale = bh / o.vh;
    const cam = navCamera(o.nav, o.vw, o.vh, scale);
    const { R, cx, cy } = cam;
    const t = tablesFor(o.mask);

    mat.fill(MAT_SPACE);
    out.fill(0);

    // --- pass 1a: the ocean disc, two-tone dithered, with a dithered limb ring
    const y0 = Math.max(0, Math.ceil(cy - R));
    const y1 = Math.min(bh - 1, Math.floor(cy + R));
    const rIn = Math.max(0, R - 2.5);
    for (let iy = y0; iy <= y1; iy++) {
      const dy = iy - cy;
      const half2 = R * R - dy * dy;
      if (half2 <= 0) continue;
      const half = Math.sqrt(half2);
      const in2 = rIn * rIn - dy * dy;
      const halfIn = in2 > 0 ? Math.sqrt(in2) : -1;
      const x0 = Math.max(0, Math.ceil(cx - half));
      const x1 = Math.min(bw - 1, Math.floor(cx + half));
      const row = iy * bw;
      for (let ix = x0; ix <= x1; ix++) {
        const dx = ix - cx;
        const checker = (ix + iy) & 1;
        // Outside the inner circle ⇒ the limb ring, itself dithered against the
        // ocean so the rim never reads as a hard vector outline.
        mat[row + ix] = (halfIn < 0 || dx > halfIn || dx < -halfIn)
          ? (checker ? MAT_RING : MAT_OCEAN_A)
          : (checker ? MAT_OCEAN_A : MAT_OCEAN_B);
      }
    }

    // --- pass 1b: land ------------------------------------------------------
    // ONE of two passes, decided by the flag and by whether the country index for
    // this mask has landed yet. Both write nothing but material ids.
    let tiled = false;
    labels.length = 0;
    if (o.tiles) {
      const idx = t.tiles?.idx ?? countryIndexFor(o.mask, onTablesReady);
      if (idx) {
        t.tiles ??= buildTileTables(o.mask, idx, t.rowTint);
        labelAcc.fill(0);
        // Refill the per-corner-longitude trig table for this camera — once per
        // frame, not once per cell. Same contract as `updateFrame`.
        updateEdgeFrame(t.edgeFrame, cam);
        // THE TILE GRID IS ONLY HONEST AT TILE RESOLUTION. Below z1.2 the mask in
        // force is the 2° coarse one (globeView.wantFineMask), whose cells are
        // NOT tiles — drawing its lattice would be drawing a grid that is not the
        // one a player can own. So the coarse band gets country fills and coasts
        // and no grid, which is exactly what EARTH-TILES-PLAN §4.3 prescribes.
        const tileRes = o.mask.cols === GLOBE.fineCols && o.mask.rows === GLOBE.fineRows;
        const r = quadLandPass(mat, bw, bh, cam, o.mask, t, t.tiles, spans, tileRes, labelAcc);
        stats.cells = r.cells;
        stats.rows = r.rows;
        tiled = true;
        // Harvest the label anchors: area-weighted centroids, biggest visible first,
        // with everything under LABEL_MIN_PX dropped. Bounded by the number of
        // countries with any visible ground, and the caller takes the first N.
        for (let id = 1; id < COUNTRY_IDS; id++) {
          const a = labelAcc[id * LABEL_ACC_STRIDE]!;
          if (a < LABEL_MIN_PX) continue;
          const c = t.tiles.idx.countries[id - 1];
          if (!c) continue;
          labels.push({
            id,
            name: c.name,
            x: labelAcc[id * LABEL_ACC_STRIDE + 1]! / a,
            y: labelAcc[id * LABEL_ACC_STRIDE + 2]! / a,
            area: a,
          });
        }
        labels.sort((p, q) => q.area - p.area);
      }
    }
    if (!tiled) {
      // Refill the per-longitude trig table for this camera — once per frame, not
      // once per cell. This is the whole reason the inner loop has no trig in it.
      updateFrame(t.frame, cam);
      stats.cells = splatLandPass(mat, bw, bh, cam, o.mask, t);
      stats.rows = 0;
    }
    stats.tiles = tiled;

    // --- pass 2: the terminator ---------------------------------------------
    // One dot product per DISC pixel against the sun direction in camera space.
    // `pz` is the sphere depth, so this is a true day/night line on a sphere, not
    // a screen-space gradient — the shadow curves the way a real one does.
    const sun = sunCameraVector(o.nav, sunLonLat(o.sunMs));
    const R2 = R * R;
    const invR = 1 / R;
    for (let iy = y0; iy <= y1; iy++) {
      const dy = iy - cy;
      const dyUp = -dy; // screen y grows downward; the camera's north is up
      const half2 = R2 - dy * dy;
      if (half2 <= 0) continue;
      const hw = Math.sqrt(half2);
      const x0 = Math.max(0, Math.ceil(cx - hw));
      const x1 = Math.min(bw - 1, Math.floor(cx + hw));
      const row = iy * bw;
      for (let ix = x0; ix <= x1; ix++) {
        const m = mat[row + ix]!;
        if (m === MAT_SPACE) continue;
        const dx = ix - cx;
        const pz2 = R2 - dx * dx - dy * dy;
        const pz = pz2 > 0 ? Math.sqrt(pz2) : 0;
        const lit = (dx * sun.se + dyUp * sun.sn + pz * sun.so) * invR;
        // Ordered dither on both shade edges: a 1-px checkered terminator instead
        // of a banded one, which is what the rest of the art does at every edge.
        const jitter = ((ix + iy) & 1) ? 0.045 : -0.045;
        const v = lit + jitter;
        const shade = v > 0.12 ? 0 : v > -0.06 ? 1 : 2;
        out[row + ix] = PALETTE[m * SHADES + shade]!;
      }
    }

    bctx.putImageData(img, 0, 0);

    // --- blit: ONE nearest-neighbour upscale --------------------------------
    const dw = Math.round(o.vw * o.dpr);
    const dh = Math.round(o.vh * o.dpr);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = Math.max(0, Math.min(1, o.alpha));
    ctx.drawImage(buf!, 0, 0, bw, bh, 0, 0, dw, dh);
    ctx.restore();
    stats.ms = performance.now() - t0;
  }

  return { draw, stats, labels };
}
