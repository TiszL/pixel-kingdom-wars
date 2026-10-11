/**
 * SHARDKEEP — pure globe math (docs/WORLDMAP-GLOBE-PLAN.md §1.1 / §1.2).
 *
 * Orthographic azimuthal projection, its inverse, the 288-sector grid, and the
 * land-site lattice that turns a valley ordinal into a place on Earth. No
 * dependencies, no I/O, no state beyond two memoised derived tables.
 *
 * THREE RULES THIS FILE LIVES BY
 *
 * 1. `packages/sim` MUST NEVER IMPORT THIS FILE. The simulator's
 *    `banned-tokens.test.ts` scans only `packages/sim/src`, so the
 *    transcendental-Math ban does not reach here and the trig below is legal —
 *    but one import would drag `Math.sin`/`Math.atan2` into the deterministic
 *    replay graph. The globe is presentation and placement; it is never a rule.
 * 2. UNITS ARE EXPLICIT IN EVERY NAME. The projection core speaks RADIANS
 *    because it is the per-frame hot path; everything that faces the server or
 *    the DB (sectors, sites, mask lookups) speaks DEGREES, because that is what
 *    a `lon`/`lat` column and a JSON payload carry. `*Deg` wrappers bridge them.
 * 3. NOTHING HERE ALLOCATES PER FRAME. `project`/`unproject`/`splatCell` all
 *    write into a caller-owned `out` object, and the per-frame trig tables are
 *    allocated once by `makeFrame` and refilled in place by `updateFrame`.
 *
 * `plots.(x, y)` is never read, written, or reinterpreted by anything in this
 * file. A valley gains a lat/lon; its 25×20 internal layout is untouched. That
 * is the whole migration-free proof.
 */
import { GLOBE } from './constants';
import { EARTH_COARSE } from './earthMask';

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

/** Longitude/latitude in DEGREES. */
export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * An equirectangular land bitmask. Row 0 is the northernmost row (lat +90),
 * column 0 starts at lon −180. Bit `iy * cols + ix`, LSB-first within a byte.
 * The generated modules `earthMask.ts` (coarse, eager) and `earthMaskFine.ts`
 * (fine, dynamic-import only) are the only implementations.
 */
export interface LandMask {
  cols: number;
  rows: number;
  bits: Uint8Array;
  /** Population count of `bits` — carried as data so consumers need not scan. */
  landCells: number;
}

/** Camera for the orthographic globe. Angles in RADIANS, lengths in raster px. */
export interface GlobeCamera {
  /** Centre longitude λ₀, radians. */
  lam0: number;
  /** Centre latitude φ₀, radians. Callers clamp to ±80° for usable rotation. */
  phi0: number;
  /** Sphere radius in raster px. */
  R: number;
  /** Disc centre in raster px. */
  cx: number;
  cy: number;
}

/** Result of a forward projection. Reused across calls — never retained. */
export interface Projected {
  x: number;
  y: number;
  /** cos of the angular distance from the camera centre. */
  cosc: number;
  /** `cosc >= 0` — the near hemisphere. This is the entire culling test. */
  visible: boolean;
}

export function newProjected(): Projected {
  return { x: 0, y: 0, cosc: 0, visible: false };
}

// ---------------------------------------------------------------------------
// Forward / inverse projection (plan §1.1)
// ---------------------------------------------------------------------------

/**
 * Orthographic azimuthal projection. `lon`/`lat` in RADIANS.
 *
 *   cosc = sinφ₀·sinφ + cosφ₀·cosφ·cosΔ
 *   x    = cx + R·cosφ·sinΔ
 *   y    = cy − R·(cosφ₀·sinφ − sinφ₀·cosφ·cosΔ)
 *
 * `x`/`y` are computed even when `visible` is false: the far-side coordinates
 * are the mirror of the near side, which is why a caller MUST test `visible`
 * rather than clipping on the disc radius.
 */
export function project(lon: number, lat: number, cam: GlobeCamera, out: Projected = newProjected()): Projected {
  const d = lon - cam.lam0;
  const sinPhi = Math.sin(lat);
  const cosPhi = Math.cos(lat);
  const sinPhi0 = Math.sin(cam.phi0);
  const cosPhi0 = Math.cos(cam.phi0);
  const cosD = Math.cos(d);
  const cosc = sinPhi0 * sinPhi + cosPhi0 * cosPhi * cosD;
  out.cosc = cosc;
  out.visible = cosc >= 0;
  out.x = cam.cx + cam.R * cosPhi * Math.sin(d);
  out.y = cam.cy - cam.R * (cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosD);
  return out;
}

/** `project` in DEGREES. */
export function projectDeg(lon: number, lat: number, cam: GlobeCamera, out?: Projected): Projected {
  return project(lon * DEG_TO_RAD, lat * DEG_TO_RAD, cam, out);
}

/**
 * Inverse projection: raster px → lon/lat in RADIANS, or `null` when the point
 * is outside the disc (tapped space). Needed for tap-to-select and
 * tap-to-rotate, which is why the miss case is an explicit `null` and not a
 * clamped nearest point — "I tapped the void" is a real, distinct gesture.
 *
 * Returned longitude is normalised to (−π, π].
 *
 * THE LIMB TOLERANCE IS LOAD-BEARING, not slop. `project` calls a point visible
 * when `cosc >= 0`, and for such a point ρ ≤ R only in exact arithmetic — in
 * floats ρ lands a few ulps past R. Rejecting on a bare `rho > R` therefore
 * makes `unproject` disagree with `project` about the outermost ring of the
 * globe: cells you can see but cannot tap. `LIMB_EPS` is a RELATIVE tolerance,
 * so it is sub-nanometre at any R a screen can have, and the round-trip test
 * asserts the two functions agree everywhere `visible` is true.
 */
const LIMB_EPS = 1e-9;

export function unproject(sx: number, sy: number, cam: GlobeCamera, out: LonLat = { lon: 0, lat: 0 }): LonLat | null {
  const px = sx - cam.cx;
  const py = cam.cy - sy; // screen y grows downward; py' of the plan
  const rho = Math.sqrt(px * px + py * py);
  if (rho > cam.R * (1 + LIMB_EPS)) return null;
  if (rho === 0) {
    out.lon = normalizeRad(cam.lam0);
    out.lat = cam.phi0;
    return out;
  }
  // clamp: a tap exactly on the limb can land a hair over 1 in floating point.
  const c = Math.asin(clamp(rho / cam.R, -1, 1));
  const sinc = Math.sin(c);
  const cosc = Math.cos(c);
  const sinPhi0 = Math.sin(cam.phi0);
  const cosPhi0 = Math.cos(cam.phi0);
  out.lat = Math.asin(clamp(cosc * sinPhi0 + (py * sinc * cosPhi0) / rho, -1, 1));
  out.lon = normalizeRad(cam.lam0 + Math.atan2(px * sinc, rho * cosc * cosPhi0 - py * sinc * sinPhi0));
  return out;
}

/** `unproject` in DEGREES. */
export function unprojectDeg(sx: number, sy: number, cam: GlobeCamera, out?: LonLat): LonLat | null {
  const r = unproject(sx, sy, cam, out);
  if (!r) return null;
  r.lon *= RAD_TO_DEG;
  r.lat *= RAD_TO_DEG;
  return r;
}

/**
 * Normalise radians to the HALF-OPEN range [−π, π).
 *
 * Half-open, and −π rather than +π at the antimeridian, because every bin in
 * this file is half-open too: mask column 0 is `[−180°, −178°)` and sector 0 is
 * `[−180°, −165°)`. A `(−π, π]` convention would put the antimeridian in the
 * LAST column and the LAST sector — an off-by-one that only shows up in the
 * Pacific, i.e. in production.
 */
export function normalizeRad(a: number): number {
  const twoPi = Math.PI * 2;
  return (((a + Math.PI) % twoPi) + twoPi) % twoPi - Math.PI;
}

/** Normalise degrees to the half-open range [−180, 180). See `normalizeRad`. */
export function normalizeLon(d: number): number {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Per-frame precomputation — why the inner loop is ~10 flops and ZERO trig
// ---------------------------------------------------------------------------

/**
 * Trig tables for splatting a whole `LandMask` at one camera.
 *
 * Naïvely, 4,800 land cells × (sin, cos, sin, cos) per frame. Instead:
 *   • `sinLat`/`cosLat` — one value per mask ROW, computed ONCE by `makeFrame`.
 *   • `sinD`/`cosD` of (λ − λ₀) — one value per mask COLUMN, refilled ONCE PER
 *     FRAME by `updateFrame` (360 trig calls for the coarse mask, not 4,800).
 * Per cell the remaining work is one dot product and two multiply-adds.
 */
export interface GlobeFrame {
  cols: number;
  rows: number;
  readonly sinLat: Float64Array;
  readonly cosLat: Float64Array;
  readonly sinD: Float64Array;
  readonly cosD: Float64Array;
  /** Camera scalars, hoisted out of the loop by `updateFrame`. */
  sinPhi0: number;
  cosPhi0: number;
  R: number;
  cx: number;
  cy: number;
}

/**
 * Allocate the tables for a mask's geometry. Call once per mask, then
 * `updateFrame` every frame the camera moves (and never when it does not — the
 * renderer's dirty flag is what makes a stationary globe free).
 */
export function makeFrame(cols: number, rows: number): GlobeFrame {
  const sinLat = new Float64Array(rows);
  const cosLat = new Float64Array(rows);
  const dLat = 180 / rows;
  for (let iy = 0; iy < rows; iy++) {
    const lat = (90 - (iy + 0.5) * dLat) * DEG_TO_RAD;
    sinLat[iy] = Math.sin(lat);
    cosLat[iy] = Math.cos(lat);
  }
  return {
    cols,
    rows,
    sinLat,
    cosLat,
    sinD: new Float64Array(cols),
    cosD: new Float64Array(cols),
    sinPhi0: 0,
    cosPhi0: 1,
    R: 1,
    cx: 0,
    cy: 0,
  };
}

/** Refill the per-longitude table for a new camera. Allocates nothing. */
export function updateFrame(f: GlobeFrame, cam: GlobeCamera): void {
  const dLon = 360 / f.cols;
  for (let ix = 0; ix < f.cols; ix++) {
    const d = (-180 + (ix + 0.5) * dLon) * DEG_TO_RAD - cam.lam0;
    f.sinD[ix] = Math.sin(d);
    f.cosD[ix] = Math.cos(d);
  }
  f.sinPhi0 = Math.sin(cam.phi0);
  f.cosPhi0 = Math.cos(cam.phi0);
  f.R = cam.R;
  f.cx = cam.cx;
  f.cy = cam.cy;
}

/**
 * THE HOT PATH. Project one mask cell using the precomputed tables: ~10 flops,
 * zero trig, zero allocation. Identical output to `project` on the cell centre
 * (asserted in globe.test.ts, so the fast path can never quietly drift).
 */
export function splatCell(f: GlobeFrame, ix: number, iy: number, out: Projected): Projected {
  const sinPhi = f.sinLat[iy]!;
  const cosPhi = f.cosLat[iy]!;
  const cosD = f.cosD[ix]!;
  const cosc = f.sinPhi0 * sinPhi + f.cosPhi0 * cosPhi * cosD;
  out.cosc = cosc;
  out.visible = cosc >= 0;
  out.x = f.cx + f.R * cosPhi * f.sinD[ix]!;
  out.y = f.cy - f.R * (f.cosPhi0 * sinPhi - f.sinPhi0 * cosPhi * cosD);
  return out;
}

/** `splatCell` for a packed cell index, as returned by `landCellList`. */
export function splatIndex(f: GlobeFrame, cell: number, out: Projected): Projected {
  const iy = (cell / f.cols) | 0;
  return splatCell(f, cell - iy * f.cols, iy, out);
}

// ---------------------------------------------------------------------------
// Mask geometry
// ---------------------------------------------------------------------------

export function cellIndex(m: LandMask, ix: number, iy: number): number {
  return iy * m.cols + ix;
}

export function cellIx(m: LandMask, cell: number): number {
  return cell % m.cols;
}

export function cellIy(m: LandMask, cell: number): number {
  return (cell / m.cols) | 0;
}

export function maskBit(m: LandMask, ix: number, iy: number): 0 | 1 {
  if (ix < 0 || iy < 0 || ix >= m.cols || iy >= m.rows) return 0;
  const bit = iy * m.cols + ix;
  return ((m.bits[bit >> 3]! >> (bit & 7)) & 1) as 0 | 1;
}

export function isLandCell(m: LandMask, cell: number): boolean {
  return ((m.bits[cell >> 3]! >> (cell & 7)) & 1) === 1;
}

/** Cell containing a DEGREE lon/lat. Longitude wraps; latitude clamps at the poles. */
export function cellAtDeg(m: LandMask, lon: number, lat: number): { ix: number; iy: number } {
  const dLon = 360 / m.cols;
  const dLat = 180 / m.rows;
  const ix = clamp(Math.floor((normalizeLon(lon) + 180) / dLon), 0, m.cols - 1);
  const iy = clamp(Math.floor((90 - clamp(lat, -90, 90)) / dLat), 0, m.rows - 1);
  return { ix, iy };
}

/** Is the DEGREE lon/lat on land, at this mask's resolution? */
export function isLandAtDeg(m: LandMask, lon: number, lat: number): boolean {
  const c = cellAtDeg(m, lon, lat);
  return maskBit(m, c.ix, c.iy) === 1;
}

/** Centre of a cell, in DEGREES. */
export function cellCentreDeg(m: LandMask, ix: number, iy: number, out: LonLat = { lon: 0, lat: 0 }): LonLat {
  out.lon = -180 + (ix + 0.5) * (360 / m.cols);
  out.lat = 90 - (iy + 0.5) * (180 / m.rows);
  return out;
}

const landCellCache = new WeakMap<LandMask, Int32Array>();

/**
 * Every land cell of a mask, ascending row-major, as packed indices. Lets the
 * renderer walk only the ~29% of cells that can draw anything, in a
 * cache-friendly order, with no per-frame bit tests. Memoised per mask.
 */
export function landCellList(m: LandMask): Int32Array {
  const hit = landCellCache.get(m);
  if (hit) return hit;
  const out = new Int32Array(m.landCells);
  let n = 0;
  const total = m.cols * m.rows;
  for (let cell = 0; cell < total; cell++) if (isLandCell(m, cell)) out[n++] = cell;
  if (n !== m.landCells) {
    throw new Error(`${m.cols}×${m.rows} mask: landCells says ${m.landCells}, bitset has ${n}`);
  }
  landCellCache.set(m, out);
  return out;
}

/**
 * Rank of a land cell in `landCellList(m)`, or −1 if the cell is ocean.
 *
 * The renderer never needs this — it walks `landCellList` and already has the
 * rank — but the tap path does: `unproject` → `cellAtDeg` → a cell index, which
 * must become a rank to read any per-land-cell table. Binary search over the
 * ascending list: 17 steps at 0.5°, no allocation, no reverse map to keep in sync.
 */
export function landCellRank(m: LandMask, cell: number): number {
  const list = landCellList(m);
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid]!;
    if (v === cell) return mid;
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Countries — docs/EARTH-TILES-PLAN.md §3. The DATA is generated
// (src/earthCountries.ts eager / src/earthCountriesFine.ts dynamic); the two
// lookups live here because this file owns the cell order they are keyed by.
// ---------------------------------------------------------------------------

/**
 * One Natural Earth admin_0 feature. `NAME` verbatim — this file never redraws,
 * merges or renames a boundary, and there are deliberately NO flags (there is no
 * flag for "Siachen Glacier", and picking one for a disputed feature is an
 * editorial act the generator refuses to make).
 */
export interface Country {
  /** NE `ADM0_A3`. UNIQUE at both resolutions and the id's sort key: ids are
   *  ranks in this order, never file order, so a data refresh cannot renumber
   *  tiles. Not `ISO_A2`, which is '-99' for several features. */
  a3: string;
  /** NE `NAME`. What a player reads. */
  name: string;
  /** NE `ISO_A2`, or '' where NE carries its −99 sentinel. */
  iso2: string;
  /**
   * NE `ADM0_A3_IS` / `_UN` / `_US` — the alternate points of view NE ships *as
   * data*, so "switch to the US or UN view" is one constant and not a
   * regeneration. `''` means NE carries its −99 sentinel there; READ IT AS "same
   * as `a3`" (`c.a3us || c.a3`). Measured against the checked-in 50m source:
   * `_US` is populated for all 241 features, `_IS` for 240, and `_UN` for NONE —
   * this mirror's GeoJSON simply has no UN column, so a UN view is not available
   * from this data even though the field is carried.
   */
  a3is: string;
  a3un: string;
  a3us: string;
  /** NE `MAPCOLOR9`, 1..9. Adjacent countries differ, which is the whole point:
   *  the renderer keys materials off THIS and never off the country id, because
   *  `mat` is a Uint8Array and ~200 countries × tints would overflow it
   *  silently (EARTH-TILES-PLAN R19). */
  color: number;
}

/**
 * Which country owns each land cell of one mask.
 *
 * `cells` is ONE BYTE PER LAND CELL in `landCellList` order (ascending
 * row-major over the mask's land cells) — NOT one byte per grid cell. Index it
 * by RANK, so a renderer walking `landCellList` pays nothing, and a tap pays one
 * `landCellRank` binary search.
 *
 * `0` means NO SOVEREIGN, which by owner decision (2026-08-10 Q4) means NOT
 * CLAIMABLE EARTH — Antarctica is the only ground in that state. Every other land
 * cell has a country by construction, because the same 8-of-16 subsample cover
 * count decides both is-land and which-country from one parse of one file.
 */
export interface CountryIndex {
  cols: number;
  rows: number;
  cells: Uint8Array;
  /**
   * CLAIMABLE CELLS THE MASK DOES NOT CONTAIN, ascending. One per country that is
   * smaller than a cell: Barbados is 431 km² against a ~3,090 km² cell, so its own
   * cell polls 2 of 16 samples and the majority rule calls it ocean — yet it is
   * unambiguously where Barbados is. Every country gets exactly one tile (owner
   * decision 2026-08-10 Q4b), and putting these here rather than transferring a
   * mainland cell is what stops a Barbados tile from appearing inside Venezuela.
   *
   * So CLAIMABLE EARTH = (land cells whose country id ≠ 0) ∪ `extraCells`.
   */
  extraCells: Int32Array;
  /** Country id of `extraCells[i]`. Never 0. */
  extraIds: Uint8Array;
  /** 1-based: id `n` is `countries[n - 1]`. Sorted by `a3`. */
  countries: readonly Country[];
}

/** Country id of a land cell BY RANK (`landCellList` order). 0 = no sovereign. */
export function countryIdAtRank(idx: CountryIndex, rank: number): number {
  return rank >= 0 && rank < idx.cells.length ? idx.cells[rank]! : 0;
}

/**
 * Country id of a packed cell index, checking the mask's land cells and then the
 * sub-tile `extraCells`. 0 means "no sovereign", which is the same thing as "not
 * claimable" — ocean, and Antarctica, share the sentinel deliberately.
 */
export function countryIdOfCell(m: LandMask, idx: CountryIndex, cell: number): number {
  if (m.cols !== idx.cols || m.rows !== idx.rows) {
    throw new Error(`country index is ${idx.cols}×${idx.rows} but the mask is ${m.cols}×${m.rows}`);
  }
  const rank = landCellRank(m, cell);
  if (rank >= 0) return countryIdAtRank(idx, rank);
  let lo = 0;
  let hi = idx.extraCells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = idx.extraCells[mid]!;
    if (v === cell) return idx.extraIds[mid]!;
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return 0;
}

/** Every cell a player may own, ascending: land with a sovereign, plus the
 *  sub-tile countries' cells. THE definition of claimable Earth. */
export function claimableCells(m: LandMask, idx: CountryIndex): Int32Array {
  if (m.cols !== idx.cols || m.rows !== idx.rows) {
    throw new Error(`country index is ${idx.cols}×${idx.rows} but the mask is ${m.cols}×${m.rows}`);
  }
  const land = landCellList(m);
  const out = new Int32Array(land.length + idx.extraCells.length);
  let n = 0;
  let e = 0;
  for (let rank = 0; rank < land.length; rank++) {
    const cell = land[rank]!;
    while (e < idx.extraCells.length && idx.extraCells[e]! < cell) out[n++] = idx.extraCells[e++]!;
    if (idx.cells[rank] !== 0) out[n++] = cell;
  }
  while (e < idx.extraCells.length) out[n++] = idx.extraCells[e++]!;
  return out.subarray(0, n);
}

/** The country for an id, or null for the 0 sentinel / an out-of-range id. */
export function countryOfId(idx: CountryIndex, id: number): Country | null {
  return id >= 1 && id <= idx.countries.length ? idx.countries[id - 1]! : null;
}

// ---------------------------------------------------------------------------
// Sectors — 24 lon × 12 lat = 288 of 15°×15° (plan §1.3). Derived, never stored.
// ---------------------------------------------------------------------------

/** 288. */
export const SECTOR_COUNT = GLOBE.sectorsLon * GLOBE.sectorsLat;
/** 15. */
export const SECTOR_LON_DEG = 360 / GLOBE.sectorsLon;
/** 15. */
export const SECTOR_LAT_DEG = 180 / GLOBE.sectorsLat;

/**
 * `sectorId = lonIdx * sectorsLat + latIdx`, where lonIdx counts east from
 * −180 and latIdx counts NORTH from −90 (so latIdx 0 is the southern edge).
 */
export function sectorIdOf(lon: number, lat: number): number {
  const lonIdx = clamp(Math.floor((normalizeLon(lon) + 180) / SECTOR_LON_DEG), 0, GLOBE.sectorsLon - 1);
  const latIdx = clamp(Math.floor((clamp(lat, -90, 90) + 90) / SECTOR_LAT_DEG), 0, GLOBE.sectorsLat - 1);
  return lonIdx * GLOBE.sectorsLat + latIdx;
}

export function sectorIndices(id: number): { lonIdx: number; latIdx: number } {
  return { lonIdx: (id / GLOBE.sectorsLat) | 0, latIdx: id % GLOBE.sectorsLat };
}

/** Half-open in lon and lat: `[lonMin, lonMax) × [latMin, latMax)`. */
export function sectorBounds(id: number): { lonMin: number; lonMax: number; latMin: number; latMax: number } {
  const { lonIdx, latIdx } = sectorIndices(id);
  const lonMin = -180 + lonIdx * SECTOR_LON_DEG;
  const latMin = -90 + latIdx * SECTOR_LAT_DEG;
  return { lonMin, lonMax: lonMin + SECTOR_LON_DEG, latMin, latMax: latMin + SECTOR_LAT_DEG };
}

export function sectorCentreDeg(id: number, out: LonLat = { lon: 0, lat: 0 }): LonLat {
  const b = sectorBounds(id);
  out.lon = b.lonMin + SECTOR_LON_DEG / 2;
  out.lat = b.latMin + SECTOR_LAT_DEG / 2;
  return out;
}

// ---------------------------------------------------------------------------
// Fine cells → sector / coarse cell (D-096, 2026-09-02). Integer math over the
// grid SHAPE in GLOBE, with no mask import: this file is in the first-paint graph
// and the fine mask is not (parcelGrid.ts explains the budget).
// ---------------------------------------------------------------------------

/**
 * Centre of a FINE (0.5°) grid cell in DEGREES, from `GLOBE.fineCols/fineRows`
 * alone — the arithmetic `cellCentreDeg` does with a mask in hand, for callers
 * that only hold a frozen `plots.earth_cell`: the server's globe aggregate and the
 * client's parcel band (apps/web tiles.ts `earthCellCentre`). It is an address
 * lookup, not a land test: whether the address is claimable was settled when the
 * plot was frozen, and nothing here re-decides it.
 */
export function fineCellCentreDeg(cell: number, out: LonLat = { lon: 0, lat: 0 }): LonLat {
  const ix = cell % GLOBE.fineCols;
  const iy = (cell / GLOBE.fineCols) | 0;
  out.lon = -180 + (ix + 0.5) * (360 / GLOBE.fineCols);
  out.lat = 90 - (iy + 0.5) * (180 / GLOBE.fineRows);
  return out;
}

/**
 * THE SECTOR A BASE IS COUNTED IN: from its own frozen `plots.earth_cell`, never
 * from its valley's site seat.
 *
 * WHY THE SEAT IS GONE (D-096). A valley's pin used to stand on its Hilbert-walk
 * site seat (`siteOf` → parcelGrid's `siteSeatLonLat`), and every sector total was
 * bucketed from that seat — but the valley's BASES live in patch #site_id, 491
 * fine cells at stream offset `site_id × 491`, which is ~45 coarse cells further
 * along the same walk. Only site 0's seat coincides with its own patch. MEASURED
 * against the checked-in masks (globe.test.ts turns the measurement into a test):
 * all 120 patches hold a parcel outside the seat's sector, 119 of them hold NO
 * parcel inside it, and site 1's seat is 828–2,271 km from every one of its
 * parcels. That is the grey "1 BASES" pin that zoomed into empty ground, and it
 * mis-counted the sector totals and reach rings underneath it.
 *
 * A fine cell is 0.5° and a sector is 15°, so 30 fine columns make one sector
 * column and 30 fine rows one sector row — exact integer division, asserted in the
 * tests together with the divisibility it relies on. `latIdx` counts NORTH from
 * −90 (the `sectorIdOf` convention) while fine row 0 is the NORTH pole, hence the
 * flip. Agrees with `sectorIdOf(fineCellCentreDeg(cell))` for every fine cell.
 */
export function sectorIdOfFineCell(cell: number): number {
  const ix = cell % GLOBE.fineCols;
  const iy = (cell / GLOBE.fineCols) | 0;
  const lonIdx = (ix / (GLOBE.fineCols / GLOBE.sectorsLon)) | 0;
  const latIdx = GLOBE.sectorsLat - 1 - ((iy / (GLOBE.fineRows / GLOBE.sectorsLat)) | 0);
  return lonIdx * GLOBE.sectorsLat + latIdx;
}

/**
 * The 2° COARSE cell (`EARTH_COARSE` grid, packed `iy · cols + ix`) holding a fine
 * cell — the REGION band's cluster id. A coarse cell is exactly 4 × 4 fine cells,
 * so this is the same lattice `lonlat` and `siteSeatCell` walk, read backwards.
 * Note a 2° cell is NOT aligned to the 15° sector grid (15 / 2 is not whole), so a
 * coarse cell can straddle two sectors; the server therefore keys a cluster by
 * (sector, coarse cell) and only ever counts a cell inside the sector that counts
 * it — a sector never claims ground across its own edge.
 */
export function coarseCellOfFineCell(cell: number): number {
  const ix = cell % GLOBE.fineCols;
  const iy = (cell / GLOBE.fineCols) | 0;
  const fx = GLOBE.fineCols / GLOBE.coarseCols;
  const fy = GLOBE.fineRows / GLOBE.coarseRows;
  return ((iy / fy) | 0) * GLOBE.coarseCols + ((ix / fx) | 0);
}

// ---------------------------------------------------------------------------
// Land sites — a valley ordinal becomes a place on Earth (plan §1.2)
// ---------------------------------------------------------------------------

/** 16 — deterministic sub-cell slots per site. */
export const SLOTS_PER_SITE = GLOBE.slotsPerSite;
/** 4 — the √16 × √16 lattice of slot offsets inside a coarse cell. */
export const SLOT_SUB = Math.round(Math.sqrt(SLOTS_PER_SITE));

/** A valley's derived place: which coarse land cell, and which slot inside it. */
export interface Site {
  cell: number;
  slot: number;
}

let sites: Int32Array | null = null;

/**
 * Coarse land cells in HILBERT (space-filling) order.
 *
 * Built lazily and memoised: importing this module must stay free, because
 * `constants.ts` consumers are in the first-paint graph and most of them never
 * touch a site.
 *
 * WHY HILBERT AND NOT `hash(uuid)`. A hash scatters valley #1 and #2 to
 * opposite hemispheres, so an alpha with three valleys renders as three lonely
 * dots in the void — and it collides (≈50% chance by valley 82 against ~4,800
 * sites). Consecutive ordinals along a space-filling curve are spatial
 * neighbours, so the world reads as CLUSTERED, GROWING SETTLEMENT, with zero
 * collisions by construction.
 */
export function landSites(): Int32Array {
  if (sites) return sites;
  const m = EARTH_COARSE;
  const order = hilbertSide(Math.max(m.cols, m.rows));
  const out = new Int32Array(m.landCells);
  let n = 0;
  for (let d = 0; d < order * order; d++) {
    const xy = hilbertXY(order, d);
    const ix = (xy / 65536) | 0;
    const iy = xy % 65536;
    if (ix >= m.cols || iy >= m.rows) continue; // the curve's square overhangs the grid
    if (maskBit(m, ix, iy) === 1) out[n++] = iy * m.cols + ix;
  }
  if (n !== m.landCells) throw new Error(`Hilbert walk found ${n} land cells, mask says ${m.landCells}`);
  sites = out;
  return out;
}

/** Number of distinct sites; `landSites().length`. */
export function landSiteCount(): number {
  return landSites().length;
}

/**
 * A valley's site from its ordinal — `valleys.site_id`, a persisted, UNIQUE
 * column the server assigns once at creation (it was derived per request from
 * `row_number() over (order by created_at, id)` until that column landed, which
 * made a base's place a function of the valley table's contents).
 * Pure in the ordinal and NOTHING else — never a plot, never a wallet, never a
 * clock. Ordinals advance along the Hilbert curve first, so the frontier of
 * settlement grows outward; slots fill on each wrap.
 *
 * THE LATTICE IS FINITE AND SAYS SO (docs/EARTH-TILES-PLAN.md R10, formerly
 * LAND-DEED R11). This used to end in `% SLOTS_PER_SITE`, which meant valley
 * `siteCapacity()` was silently sited on the exact pixel of valley 0 — no error,
 * no log, no test, two deeds conveying the same point on Earth. That wrap was
 * unreachable while the ceiling was 86,912 valleys, but the Earth-tiles model
 * lowers the reachable ceiling into launch range, so the wrap now THROWS and the
 * modulo is gone rather than merely unreachable: a guard behind a fallback is a
 * guard that gets deleted. Running out of Earth is a real event with a real
 * answer (allocate on a second planet — `valleys.planet_id`), and a 500 on the
 * globe aggregate is the correct way to learn it, because the alternative is
 * quietly conveying land twice.
 *
 * WHAT STAYS LEGAL, DELIBERATELY: FINITE negative ordinals clamp to 0 and
 * fractional ordinals truncate, exactly as before — a malformed map request must
 * not be a crash, and both coercions land on a real, single site. What is NOT
 * legal is any input that would resolve to a site the caller did not ask for:
 * past the end of the lattice, or non-finite.
 *
 * THE NON-FINITE CHECK RUNS BEFORE THE CLAMP, AND THAT ORDER IS THE WHOLE POINT
 * (docs/EARTH-TILES-PLAN.md adversarial pass D8, 2026-08-10). It used to run
 * after, so `Math.max(0, Math.trunc(-Infinity))` had already produced `0` by the
 * time finiteness was tested: `siteOf(-Infinity)` returned VALLEY 0's site while
 * the paragraph above promised it was refused. `NaN` and `+Infinity` threw and
 * `-Infinity` did not, which is the worst of the three answers — a code path that
 * hands out an arbitrary real valley's place for a value that means nothing.
 * Docstring and code now say the same thing, and the throw is the reading they
 * agree on: `-Infinity` is not "the smallest ordinal", it is not an ordinal.
 */
export function siteOf(ordinal: number): Site {
  const n = landSiteCount();
  const cap = n * SLOTS_PER_SITE;
  const o = Math.max(0, Math.trunc(ordinal));
  if (!Number.isFinite(ordinal) || o >= cap) {
    throw new Error(
      `siteOf(${ordinal}): the site lattice seats ${cap} valleys (${n} coarse land cells × ` +
        `${SLOTS_PER_SITE} slots) and this ordinal is not one of them. Earth is full: allocate ` +
        `on another planet (valleys.planet_id) — do NOT wrap, which would site this valley on ` +
        `top of an existing one.`,
    );
  }
  return { cell: landSites()[o % n]!, slot: (o / n) | 0 };
}

/**
 * The DEGREE lon/lat of a (cell, slot): the cell's √n × √n slot lattice, so 16
 * valleys share a 2° cell without sharing a pixel. Because the cell list IS the
 * land-cell list, a valley can never be sited in the ocean.
 */
export function lonlat(cell: number, slot: number, out: LonLat = { lon: 0, lat: 0 }): LonLat {
  const m = EARTH_COARSE;
  const ix = cellIx(m, cell);
  const iy = cellIy(m, cell);
  const s = ((slot % SLOTS_PER_SITE) + SLOTS_PER_SITE) % SLOTS_PER_SITE;
  const sx = s % SLOT_SUB;
  const sy = (s / SLOT_SUB) | 0;
  out.lon = -180 + (ix + (sx + 0.5) / SLOT_SUB) * (360 / m.cols);
  out.lat = 90 - (iy + (sy + 0.5) / SLOT_SUB) * (180 / m.rows);
  return out;
}

/** `lonlat(siteOf(ordinal))` — the one call the API layer actually wants. */
export function ordinalLonLat(ordinal: number, out?: LonLat): LonLat {
  const s = siteOf(ordinal);
  return lonlat(s.cell, s.slot, out);
}

/** Total valleys the coarse lattice seats before slots start repeating. */
export function siteCapacity(): number {
  return landSiteCount() * SLOTS_PER_SITE;
}

// --- Hilbert d → (x, y), Wikipedia's iterative `d2xy`. -----------------------

/** Smallest power of two ≥ n — the Hilbert curve needs a square, 2^k side. */
function hilbertSide(n: number): number {
  let s = 1;
  while (s < n) s *= 2;
  return s;
}

function hilbertXY(side: number, d: number): number {
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < side; s *= 2) {
    const rx = 1 & (t >> 1);
    const ry = 1 & (t ^ rx);
    // rotate the quadrant
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      const tmp = x;
      x = y;
      y = tmp;
    }
    x += s * rx;
    y += s * ry;
    t >>= 2;
  }
  return x * 65536 + y; // packed: side ≤ 256 for our masks, so 16 bits each is ample
}

// ---------------------------------------------------------------------------
// Great-circle distance — used by tests and by "nearest valley" ranking.
// ---------------------------------------------------------------------------

/** Great-circle distance between two DEGREE lon/lats, in kilometres. */
export function greatCircleKm(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const p1 = aLat * DEG_TO_RAD;
  const p2 = bLat * DEG_TO_RAD;
  const dp = p2 - p1;
  const dl = (bLon - aLon) * DEG_TO_RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Zoom bands (plan §1.3). `zoom` is one scalar; the band is DERIVED.
// ---------------------------------------------------------------------------

export type MapBand = 'globe' | 'region' | 'local';

export function bandForZoom(zoom: number): MapBand {
  if (zoom >= GLOBE.localZoom) return 'local';
  if (zoom >= GLOBE.regionZoom) return 'region';
  return 'globe';
}
