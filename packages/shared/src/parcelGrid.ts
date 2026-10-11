/**
 * SHARDKEEP — THE PARCEL ↔ EARTH-CELL MAPPING (docs/EARTH-TILES-PLAN.md §5.2, P4a).
 *
 * A parcel is still exactly the `plots` row it is today — that is the 2026-08-09
 * lock "THE PARCEL IS THE PLOT", and nothing here reads, writes or reinterprets
 * that row. What this file adds is a second, DERIVED address for the same parcel:
 * a real 0.5° Earth land cell, in a real country (owner decision 2026-08-10 Q1).
 *
 *   PATCH        = WORLD.valleyCapacity − WORLD.campsPerValley = 491
 *   patchCells(siteId) = the siteId-th disjoint run of 491 CLAIMABLE fine cells,
 *                        streamed in the order `landSites()` walks coarse cells
 *   parcelCell(siteId, x, y) = patchCells(siteId)[fillIndex(x, y)]
 *
 * FOUR PROPERTIES THAT ARE THE WHOLE POINT
 *
 * 1. NOTHING MOVES. The mapping is a pure function of two integers that are
 *    already frozen in the database — `valleys.site_id` (NOT NULL UNIQUE since
 *    migration 0052, assigned once as max+1 and never reused) and `plots.(x, y)`.
 *    So every live parcel gains a cell and a country with zero UPDATEs, and
 *    because `transferBase` re-points `player_wallet` without touching x/y, the
 *    cell moves with the deed for free.
 * 2. WATER IS IMPOSSIBLE BY CONSTRUCTION, one resolution below the existing
 *    proof for valley sites. The stream IS `claimableCells(fine, countries)`, so
 *    a parcel cannot be sited in the sea any more than a valley can today — and
 *    unlike `lonlat()`'s 4×4 sub-cell offset there is no sub-cell nudge left to
 *    re-check (that offset is why 4.84% of slot centres, including production's
 *    only valley, are 0.5° water today).
 * 3. IT IS CLAIMABLE cells, NOT land cells. Antarctica is land with no sovereign
 *    and is not claimable (Q4a); 57 sub-tile countries own a cell the majority
 *    rule calls ocean and ARE claimable (Q4b, `CountryIndex.extraCells`). Both
 *    are decided in one place — `claimableCells` in globe.ts — and streaming
 *    `landCellList` instead would hand out Antarctic tiles with no country and
 *    lose Barbados.
 * 4. IT THROWS PAST THE LAST PATCH, in this same commit (R10). A modulo wrap
 *    would silently stack two players on one cell — two deeds conveying one
 *    place, no error, no log — and Earth's ceiling is now inside launch range,
 *    so this is reachable in a SUCCESSFUL launch rather than theoretical.
 *
 * TWO FORMULAS ARE MIRRORED FROM apps/api/src/game/world.ts, DELIBERATELY, and a
 * cross-package test asserts they still agree: `plotFillOrder`'s 5→3→2→1 stride
 * and `campCoords`'s camp lattice. They cannot be imported (this package cannot
 * depend on the server) and world.ts cannot be changed to import them, because
 * EARTH-TILES-PLAN R1/R2 require `plotFillOrder` and `campCoords` to be
 * byte-identical through P4 — they are the guard surface for the highest-stakes
 * table in the system. So the duplication is the cheaper of two evils, and
 * `apps/api/test/parcel-cells.test.ts` is what makes it safe: if either formula
 * ever changes on one side, that test goes red instead of silently relocating
 * land.
 *
 * PURITY / LOAD ORDER. No DOM, no Phaser, no Fastify, no clock, no randomness.
 * This module statically imports the FINE mask and the FINE country index, so it
 * is `await import()`-ONLY on the client (it rides the same lazy chunk as
 * `earthMaskFine`; the first-paint JS budget is 995/1000 KB gzip) and static on
 * the server. It is off the package barrel and banned from `packages/sim`'s
 * module graph for the same reason those two are.
 */
import { WORLD } from './constants';
import { EARTH_COARSE } from './earthMask';
import { EARTH_COUNTRIES_FINE } from './earthCountriesFine';
import { EARTH_FINE } from './earthMaskFine';
import {
  cellCentreDeg, cellIx, cellIy, claimableCells, isLandCell, landSites, SLOTS_PER_SITE,
  type CountryIndex, type LandMask, type LonLat, type Site,
} from './globe';

/**
 * 491 — parcels per valley, and therefore Earth cells per patch. DERIVED from
 * two existing constants, never a third copy of the number: a valley's 25×20
 * grid seats `valleyCapacity` tiles and `campsPerValley` of them are PvE camps,
 * which hold grid tiles but are not deeded land and so get no Earth cell.
 */
export const PARCELS_PER_PATCH = WORLD.valleyCapacity - WORLD.campsPerValley;

/** A parcel's grid tile inside its valley — `plots.(x, y)`. */
export interface ParcelTile {
  siteId: number;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// The valley grid: which tiles are deeded land, and in what order they fill
// ---------------------------------------------------------------------------

/** MIRRORS apps/api/src/game/world.ts `plotFillOrder`. See the header. */
const FILL_STRIDES = [5, 3, 2, 1] as const;

const GRID_TILES = WORLD.gridCols * WORLD.gridRows;

/** MIRRORS apps/api/src/game/world.ts `campCoords`. See the header. */
function campTileKeys(): number[] {
  const out: number[] = [];
  for (let i = 0; i < WORLD.campsPerValley; i++) {
    const x = (i * 7 + 3) % WORLD.gridCols;
    const y = (i * 5 + 2) % WORLD.gridRows;
    out.push(y * WORLD.gridCols + x);
  }
  return out;
}

/**
 * The 491 deeded tiles of a valley, in the order plot assignment fills them, as
 * packed `y * gridCols + x` keys. Camp tiles are visited (so the order matches
 * `plotFillOrder` tile for tile) and then dropped, which is what makes this a
 * bijection onto `[0, PARCELS_PER_PATCH)`.
 *
 * WHY THE FILL ORDER AND NOT ROW-MAJOR: the patch's cells are contiguous in the
 * stream, so index 0 and index 1 are Earth neighbours. Keying off the fill order
 * therefore makes a valley's FIRST arrivals neighbours on Earth; row-major would
 * scatter them by the stride-5 lattice plot assignment starts on.
 */
function buildFillOrder(): { tiles: Int32Array; indexOfTile: Int16Array } {
  const camp = new Uint8Array(GRID_TILES);
  let camps = 0;
  for (const k of campTileKeys()) {
    if (camp[k] === 1) throw new Error(`camp lattice collides at tile ${k}`);
    camp[k] = 1;
    camps++;
  }
  if (camps !== WORLD.campsPerValley) throw new Error(`expected ${WORLD.campsPerValley} camp tiles, got ${camps}`);

  const tiles = new Int32Array(PARCELS_PER_PATCH);
  const indexOfTile = new Int16Array(GRID_TILES).fill(-1);
  const seen = new Uint8Array(GRID_TILES);
  let n = 0;
  for (const step of FILL_STRIDES) {
    for (let y = 0; y < WORLD.gridRows; y += step) {
      for (let x = 0; x < WORLD.gridCols; x += step) {
        const k = y * WORLD.gridCols + x;
        if (seen[k] === 1) continue;
        seen[k] = 1;
        if (camp[k] === 1) continue;
        indexOfTile[k] = n;
        tiles[n++] = k;
      }
    }
  }
  if (n !== PARCELS_PER_PATCH) {
    throw new Error(`fill order covers ${n} deeded tiles, expected ${PARCELS_PER_PATCH}`);
  }
  return { tiles, indexOfTile };
}

let fillOrder: { tiles: Int32Array; indexOfTile: Int16Array } | null = null;

function order(): { tiles: Int32Array; indexOfTile: Int16Array } {
  return (fillOrder ??= buildFillOrder());
}

/**
 * A parcel tile's index within its patch, `[0, 491)`. THROWS for a tile off the
 * grid and for a PvE camp tile — a camp is not deeded land, so asking for its
 * Earth cell is a bug in the caller, not a value to invent.
 */
export function fillIndex(x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0
      || x >= WORLD.gridCols || y >= WORLD.gridRows) {
    throw new Error(`fillIndex(${x}, ${y}): not a tile of the ${WORLD.gridCols}×${WORLD.gridRows} valley grid`);
  }
  const i = order().indexOfTile[y * WORLD.gridCols + x]!;
  if (i < 0) {
    throw new Error(
      `fillIndex(${x}, ${y}): that tile is a PvE camp, which holds a grid tile but is not deeded `
      + `land and therefore has no Earth cell (docs/EARTH-TILES-PLAN.md R2).`,
    );
  }
  return i;
}

/** The grid tile a patch index belongs to — the inverse of `fillIndex`. */
export function tileOfFillIndex(i: number): { x: number; y: number } {
  if (!Number.isInteger(i) || i < 0 || i >= PARCELS_PER_PATCH) {
    throw new Error(`tileOfFillIndex(${i}): a patch holds ${PARCELS_PER_PATCH} parcels`);
  }
  const k = order().tiles[i]!;
  return { x: k % WORLD.gridCols, y: (k / WORLD.gridCols) | 0 };
}

// ---------------------------------------------------------------------------
// The stream: claimable fine cells in coarse-Hilbert order, cut into patches
// ---------------------------------------------------------------------------

interface PatchStream {
  /** `patches × PARCELS_PER_PATCH` cells. The tail that cannot fill a whole
   *  patch is DROPPED here rather than half-seating a valley. */
  cells: Int32Array;
  patches: number;
  /** Claimable cells the stream reached, before the tail was dropped. */
  reached: number;
  /** Claimable cells in total — `reached` short of this is the small-island
   *  ground no coarse land cell contains. */
  claimable: number;
}

const streams = new WeakMap<LandMask, PatchStream>();
const reverse = new WeakMap<LandMask, Map<number, number>>();

/**
 * Stream and cut a whole planet, once. Memoised on the FINE MASK OBJECT — the
 * same `WeakMap<LandMask, …>` idiom `landCellList` uses, so a patch is streamed
 * once per process and a second planet's mask gets its own entry instead of
 * silently reusing Earth's.
 *
 * WHY THE COARSE WALK ANCHORS IT. Walking the claimable list directly seats more
 * players (a measured 126 patches / 61,866 vs 120 / 58,920) but its consecutive
 * cells jump a whole parallel at every row end — re-measured 1.01% of steps over
 * ~2,000 km against 0.027% here — so a valley would render as speckle across a
 * hemisphere instead of a region, and it would relocate production's only valley.
 * Emitting each coarse cell's fine sub-cells in `landSites()` order instead
 * inherits `globe.test.ts`'s tested Hilbert clustering for free.
 *
 * STILL EARTH-BOUND IN ONE PLACE: the coarse side is `EARTH_COARSE` +
 * `landSites()`, both of which memoise a singleton today. P5 parameterises those
 * by mask (the ~10-line change §5.3 describes); until then passing a non-Earth
 * fine mask here would stream it against Earth's coarse walk, which is why the
 * only caller is `earthStream()`.
 */
function streamFor(fine: LandMask, idx: CountryIndex): PatchStream {
  const hit = streams.get(fine);
  if (hit) return hit;

  const coarse = EARTH_COARSE;
  const fx = fine.cols / coarse.cols;
  const fy = fine.rows / coarse.rows;
  if (!Number.isInteger(fx) || !Number.isInteger(fy) || fx < 1 || fy < 1) {
    throw new Error(
      `the fine mask (${fine.cols}×${fine.rows}) must be a whole multiple of the coarse one `
      + `(${coarse.cols}×${coarse.rows}) or a coarse cell does not contain whole fine cells`,
    );
  }

  const claim = claimableCells(fine, idx);
  // A membership bitmap over the fine grid, so the walk is O(cells) rather than a
  // binary search per sub-cell. Transient: dropped when this function returns.
  const claimable = new Uint8Array(fine.cols * fine.rows);
  for (let i = 0; i < claim.length; i++) claimable[claim[i]!] = 1;

  const buf = new Int32Array(claim.length);
  let n = 0;
  const sites = landSites();
  for (let s = 0; s < sites.length; s++) {
    const cc = sites[s]!;
    const bx = cellIx(coarse, cc) * fx;
    const by = cellIy(coarse, cc) * fy;
    for (let dy = 0; dy < fy; dy++) {
      const row = (by + dy) * fine.cols;
      for (let dx = 0; dx < fx; dx++) {
        const cell = row + bx + dx;
        if (claimable[cell] === 1) buf[n++] = cell;
      }
    }
  }

  const patches = Math.floor(n / PARCELS_PER_PATCH);
  const out: PatchStream = {
    cells: buf.slice(0, patches * PARCELS_PER_PATCH),
    patches,
    reached: n,
    claimable: claim.length,
  };
  streams.set(fine, out);
  return out;
}

function earthStream(): PatchStream {
  return streamFor(EARTH_FINE, EARTH_COUNTRIES_FINE);
}

/**
 * How many valleys Earth seats as real territory. MEASURED at 0.5° by running
 * this function: **120** (58,920 parcels). An earlier comment here said 167 and
 * the plan headlined 168 / 82,488 — both were measured against `landCellList`
 * BEFORE Antarctica stopped being claimable and before `extraCells` existed.
 * Re-derived: 86,122 land cells − 24,276 with no sovereign + 57 sub-tile cells =
 * 61,903 claimable, of which the coarse-anchored stream reaches 59,071 (95.42%;
 * the rest is island ground no 2° land cell contains), and 59,071 / 491 = 120
 * patches with a 151-cell tail dropped. See docs/EARTH-TILES-PLAN.md §10.
 */
export function patchCount(): number {
  return earthStream().patches;
}

/** How many parcels Earth seats — `patchCount() × 491`. THE Earth ceiling. */
export function parcelCapacity(): number {
  return earthStream().patches * PARCELS_PER_PATCH;
}

/** Coverage of the coarse-anchored stream, for tests and for the record. */
export function patchStats(): {
  claimable: number; reached: number; unreachable: number;
  patches: number; capacity: number; leftover: number;
} {
  const s = earthStream();
  return {
    claimable: s.claimable,
    reached: s.reached,
    unreachable: s.claimable - s.reached,
    patches: s.patches,
    capacity: s.patches * PARCELS_PER_PATCH,
    leftover: s.reached - s.patches * PARCELS_PER_PATCH,
  };
}

function assertPatch(siteId: number, patches: number): void {
  if (!Number.isInteger(siteId) || siteId < 0) {
    throw new Error(`patch ${siteId}: a site id is a non-negative integer (valleys.site_id)`);
  }
  if (siteId >= patches) {
    throw new Error(
      `patch ${siteId}: Earth holds ${patches} patches of ${PARCELS_PER_PATCH} claimable 0.5° cells `
      + `(${patches * PARCELS_PER_PATCH} parcels) and this valley is not one of them. Earth is full: `
      + `allocate on another planet (valleys.planet_id) — do NOT wrap, which would put two players `
      + `on one cell and two deeds on one place.`,
    );
  }
}

/**
 * The 491 Earth cells of one valley, in patch order. A COPY: the stream is
 * memoised and shared, so handing out a view would let one consumer corrupt
 * every other one. Prefer `parcelCell` in a loop — it reads the stream directly
 * and allocates nothing.
 */
export function patchCells(siteId: number): Int32Array {
  const s = earthStream();
  assertPatch(siteId, s.patches);
  const from = siteId * PARCELS_PER_PATCH;
  return s.cells.slice(from, from + PARCELS_PER_PATCH);
}

/**
 * THE FUNCTION. A parcel's Earth cell, from its valley's `site_id` and its
 * `plots.(x, y)`. Pure in those two integers and nothing else — never a wallet,
 * never a clock, never the contents of any table.
 */
export function parcelCell(siteId: number, x: number, y: number): number {
  const s = earthStream();
  assertPatch(siteId, s.patches);
  return s.cells[siteId * PARCELS_PER_PATCH + fillIndex(x, y)]!;
}

// ---------------------------------------------------------------------------
// The VALLEY PIN — the same defect, one level up (adversarial pass D3, 2026-08-10)
// ---------------------------------------------------------------------------

/**
 * WHERE A VALLEY'S PIN BELONGS: a 0.5° LAND cell inside the valley's own 2° cell.
 *
 * THE DEFECT THIS FIXES, IN THE OWNER'S OWN WORDS ("each tile should also be on
 * land, water tiles should be removed"). P4b put every PARCEL on a real land cell,
 * but `lonlat(cell, slot)` was left untouched, and it offsets onto a blind 4×4
 * sub-lattice inside the coarse cell with nothing re-checking the result. Measured
 * on the shipped code: **4,203 of 86,912 slot centres (4.84%) are water at 0.5°,
 * and production's site 0 is one of them** — cell 1983, slot 0 → lon −173.75, lat
 * +67.75, open water in the Bering Strait. A valley pin floating at sea is the same
 * defect as a parcel pin floating at sea, and it is the one a player looks at first.
 *
 * THE RULE, AND WHY IT CANNOT RELOCATE ANYBODY. The coarse mask is 2° and the fine
 * mask is 0.5°, so a coarse cell contains EXACTLY `SLOT_SUB × SLOT_SUB = 16` fine
 * cells — the slot lattice and the fine grid are the same 4×4 lattice, which is why
 * this is a re-pick rather than a new projection. The seat is the `slot`-th entry of
 * the coarse cell's own list of:
 *
 *   1. fine cells that are LAND **and** CLAIMABLE (ground a player can own), else
 *   2. fine cells that are LAND (Antarctica: real land, no sovereign, so no
 *      claimable cell exists in those 1,529 coarse cells — measured).
 *
 * The list is never empty (**measured: 0 of 5,432 coarse land cells have no land
 * fine cell**), so the pin is on land unconditionally: measured 0 of 86,912 slots in
 * water, down from 4,203. And because the candidates are sub-cells of the valley's
 * OWN coarse cell, a pin can move at most one 2° cell — **measured max 235.9 km,
 * mean 90.6 km over the 12.3% of slots that move at all, and the coarse cell, its
 * patch and its patch's bbox are unchanged by construction**. Nobody is relocated to
 * another region, which is the constraint the plan puts above the defect (§5.2: live
 * players do not move).
 *
 * PRODUCTION'S SITE 0, MEASURED BEFORE AND AFTER: (−173.75, +67.75) water →
 * (−173.75, +66.75) land, 111.2 km south, still coarse cell 1983, still patch 0
 * (bbox lon −179.75…−152.25, lat 58.25…71.25). And the seat is `patchCells(0)[0]`
 * exactly — the valley's OWN first parcel — because the patch stream emits a coarse
 * cell's claimable sub-cells in this same ascending order. That equality is asserted
 * in the tests rather than described here.
 *
 * WHAT IT IS NOT: it is not `patchCells(siteId)[0]` in general. A patch of 491 fine
 * cells spans ~45 coarse cells, so patch `k` begins ~45 coarse cells along the
 * Hilbert walk from site `k` — seating a pin on its patch's first cell would move
 * site 50 to another hemisphere and would throw for every site past `patchCount()`
 * (120), i.e. it would break valley creation at 121. Seating inside the valley's own
 * coarse cell is the reading of "one of the valley's own cells" that no live row can
 * notice.
 *
 * WHERE IT LIVES AND WHY NOT IN `lonlat`. This needs the FINE mask. `globe.ts` is in
 * the first-paint graph (map.tsx → globeView → @shardkeep/shared/globe), and the fine
 * mask is 5.3 KB gzip against 4 KB of headroom on a 996/1000 KB budget, so `lonlat`
 * cannot read it and stay shippable. This module already carries the fine mask, is
 * already `await import()`-only on the client and static on the server, and is
 * already banned from `packages/sim`'s graph — so the seat lives beside the parcel
 * mapping it agrees with. `lonlat` is therefore still the IDENTITY of a site (the
 * server's stored/served point, and what `siteIdOfLonLat` inverts); the seat is where
 * the pin is DRAWN. The two differ by at most one 2° cell, never by a region.
 */
function seatsOf(coarseCell: number): number[] {
  const fine = EARTH_FINE;
  const coarse = EARTH_COARSE;
  const fx = fine.cols / coarse.cols;
  const fy = fine.rows / coarse.rows;
  const bx = cellIx(coarse, coarseCell) * fx;
  const by = cellIy(coarse, coarseCell) * fy;
  const claim = claimableBit();
  const land: number[] = [];
  const owned: number[] = [];
  // SLOT ORDER, so seat 0 is the same corner `lonlat`'s slot 0 aims at: rows of
  // `sy` outer, `sx` inner, exactly as `lonlat` walks `s % SLOT_SUB` / `s / SLOT_SUB`.
  for (let sy = 0; sy < fy; sy++) {
    for (let sx = 0; sx < fx; sx++) {
      const cell = (by + sy) * fine.cols + bx + sx;
      if (!isLandCell(fine, cell)) continue;
      land.push(cell);
      if (claim[cell] === 1) owned.push(cell);
    }
  }
  return owned.length ? owned : land;
}

let claimBits: Uint8Array | null = null;

/** A membership bitmap over the fine grid — `claimableCells` as an O(1) test.
 *  Built once per process (10.8 KB) and shared with nothing that can mutate it. */
function claimableBit(): Uint8Array {
  if (claimBits) return claimBits;
  const claim = claimableCells(EARTH_FINE, EARTH_COUNTRIES_FINE);
  const bits = new Uint8Array(EARTH_FINE.cols * EARTH_FINE.rows);
  for (let i = 0; i < claim.length; i++) bits[claim[i]!] = 1;
  claimBits = bits;
  return bits;
}

const seatCache = new Map<number, number[]>();

/**
 * The FINE cell a valley's pin stands on. Throws for a coarse cell that is not
 * land — a valley cannot be sited there in the first place, so there is no seat to
 * invent (`siteOf` only ever returns land cells).
 *
 * `slot` wraps over the candidate list, so the 16 slots of a coastal cell share
 * fewer than 16 distinct seats (**measured: 925 of 5,432 coarse cells**). That is
 * the honest cost of "always on land", and it is unreachable in practice: slot 1
 * begins at ordinal `landSiteCount()` = the 5,433rd valley, because `siteOf` fills
 * every cell's slot 0 before any cell's slot 1.
 */
export function siteSeatCell(site: Site): number {
  let list = seatCache.get(site.cell);
  if (!list) {
    list = seatsOf(site.cell);
    if (list.length === 0) {
      throw new Error(
        `siteSeatCell(cell ${site.cell}): that 2° cell holds no 0.5° land cell, so it cannot `
        + `seat a valley pin. Only coarse LAND cells site valleys (globe.ts landSites()).`,
      );
    }
    seatCache.set(site.cell, list);
  }
  const s = ((site.slot % SLOTS_PER_SITE) + SLOTS_PER_SITE) % SLOTS_PER_SITE;
  return list[s % list.length]!;
}

/** `siteSeatCell` as degrees — the cell's centre, which is where the pin draws. */
export function siteSeatLonLat(site: Site, out: LonLat = { lon: 0, lat: 0 }): LonLat {
  const cell = siteSeatCell(site);
  const iy = (cell / EARTH_FINE.cols) | 0;
  return cellCentreDeg(EARTH_FINE, cell - iy * EARTH_FINE.cols, iy, out);
}

/**
 * The reverse lookup: which parcel a cell is, or null for a cell no valley
 * seats. Builds a cell→index map on first use (one entry per seated parcel) and
 * memoises it per mask, because the stream is in Hilbert order and therefore not
 * searchable.
 */
export function parcelOf(cell: number): ParcelTile | null {
  const s = earthStream();
  let map = reverse.get(EARTH_FINE);
  if (!map) {
    map = new Map<number, number>();
    for (let i = 0; i < s.cells.length; i++) map.set(s.cells[i]!, i);
    reverse.set(EARTH_FINE, map);
  }
  const i = map.get(cell);
  if (i === undefined) return null;
  const siteId = (i / PARCELS_PER_PATCH) | 0;
  const t = tileOfFillIndex(i - siteId * PARCELS_PER_PATCH);
  return { siteId, x: t.x, y: t.y };
}
