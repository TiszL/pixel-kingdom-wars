/**
 * A TILE IS A PLACE ON EARTH — the pure half of tile identity. (P3/P4b, 2026-08-10)
 *
 * Everything here answers one of four questions about a 0.5° land cell, and every
 * one of them is a pure function of already-frozen data, so all four can be
 * asserted without a browser:
 *
 *   WHAT IS THIS CELL?      `tileFacts` — country, ISO codes, a stable tile id, the
 *                           cell centre in degrees. This is the "identifiable" half
 *                           of the owner's request, and the answer to "dots are not
 *                           fun".
 *   WHOSE VALLEY IS THIS?   `siteIdOfLonLat` — the inverse of the server's own
 *                           siting, so the client can name the patch a valley owns.
 *   WHERE IS A PARCEL?      `placeParcels` — `plots.(x, y)` → a real cell → a real
 *                           lon/lat. THE line the owner rejected used to be here in
 *                           spirit: a screen-space lattice with no geography.
 *   IS THIS CELL TAKEN?     `cellOwnership` — free / claimed / yours / unseated.
 *
 * This module remains place-only even though ParcelRow now carries the owner's
 * public name/avatar for rendering. `cellOwnership` never returns either field,
 * and wallet identity never enters this file.
 *
 * NO POLITICS ARE DECIDED HERE. Country names, ISO codes and boundaries come from
 * the generated Natural Earth index verbatim (see `Country` in
 * @shardkeep/shared/globe): no re-merging, no flags, no editorial. This module only
 * formats what that data says.
 */
import { GLOBE } from '@shardkeep/shared';
import {
  cellCentreDeg, countryIdOfCell, countryOfId, isLandCell, landCellList, landSiteCount,
  landSites, normalizeLon, siteOf, SLOT_SUB,
  type Country, type CountryIndex, type LandMask,
} from '@shardkeep/shared/globe';
import { parcelPins, type ParcelPin, type ParcelRow } from './globeView';

/** Frozen fine-grid address → cell centre without importing the generated mask. */
export function earthCellCentre(cell: number): { lon: number; lat: number } | null {
  const total = GLOBE.fineCols * GLOBE.fineRows;
  if (!Number.isInteger(cell) || cell < 0 || cell >= total) return null;
  const ix = cell % GLOBE.fineCols;
  const iy = (cell / GLOBE.fineCols) | 0;
  return {
    lon: -180 + (ix + 0.5) * (360 / GLOBE.fineCols),
    lat: 90 - (iy + 0.5) * (180 / GLOBE.fineRows),
  };
}

/**
 * THE PARCEL GRID AS THIS BAND CONSUMES IT — a structural type, not an import.
 *
 * `@shardkeep/shared/parcelGrid` reaches the fine mask AND the fine country index,
 * so on the client it is an `await import()` (GlobeLayer's `useParcelGrid`) and must
 * never be reachable from a static graph — the first-paint budget is 995 / 1000 KB
 * gzip and `size-check.mjs` fails the build at 1001. Declaring the shape instead of
 * importing it is what keeps every function below testable against the REAL module
 * (a test may import it statically; a bundle may not).
 */
export interface ParcelGridApi {
  /** 491 — `WORLD.valleyCapacity − WORLD.campsPerValley`, DERIVED in the shared
   *  module and read from it here rather than restated (every game number lives in
   *  `constants.ts`, and this one is two of them subtracted). */
  PARCELS_PER_PATCH: number;
  parcelCell(siteId: number, x: number, y: number): number;
  parcelOf(cell: number): { siteId: number; x: number; y: number } | null;
  patchCells(siteId: number): Int32Array;
  patchCount(): number;
  parcelCapacity(): number;
  /** Legacy diagnostic surface used by data tests. Nothing on the globe is placed
   *  from a seat any more (D-096: every marker anchors to base cells), and
   *  GlobeLayer must not call either method. */
  siteSeatCell(site: { cell: number; slot: number }): number;
  siteSeatLonLat(site: { cell: number; slot: number }): { lon: number; lat: number };
}

// ---------------------------------------------------------------------------
// Which valley owns which patch
// ---------------------------------------------------------------------------

/** cell → its rank in the Hilbert site walk. Built once; `landSites()` is a
 *  memoised singleton, so this is the matching reverse of exactly that array. */
let siteRank: Map<number, number> | null = null;

function rankOfCoarseCell(cell: number): number {
  if (!siteRank) {
    const s = landSites();
    siteRank = new Map<number, number>();
    for (let i = 0; i < s.length; i++) siteRank.set(s[i]!, i);
  }
  return siteRank.get(cell) ?? -1;
}

/**
 * LEGACY DIAGNOSTIC: `valleys.site_id` from a raw lattice lon/lat.
 *
 * This is deliberately NOT used by GlobeLayer. `/globe/sector/:id` now carries
 * persisted `siteId` beside an already-seated display lon/lat; inverting and then
 * seating that display point was the production zoom-disappearance bug. It remains
 * only to prove the old raw lattice round trip in data tests. A raw site's longitude is
 * `−180 + (ix + (sx + 0.5)/4) · 2`, so `ix` is a floor and `sx` is a round, with no
 * ambiguity anywhere. Recovering the integer is not a guess.
 *
 * It is a derivation, and it is EARTH-bound. `landSites()` memoises a
 * singleton hard-bound to `EARTH_COARSE`, so this can only ever answer for planet 0
 * — which is why it REFUSES a mask whose land-cell count is not the site lattice's
 * rather than answering for the wrong planet. It is not a wire fallback and must
 * not be extended into one.
 *
 * @returns the site id, or `null` when the point is not a site centre at all (the
 *   sector centre `homeAt` falls back to, a camera position, an ocean cell).
 */
export function siteIdOfLonLat(coarse: LandMask, lon: number, lat: number): number | null {
  if (coarse.landCells !== landSiteCount()) {
    throw new Error(
      `siteIdOfLonLat: the site lattice holds ${landSiteCount()} cells and this mask holds `
      + `${coarse.landCells}. Only the coarse EARTH mask sites valleys today — a second planet `
      + `needs landSites() parameterised by mask (EARTH-TILES-PLAN §5.3 step 1).`,
    );
  }
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const u = (normalizeLon(lon) + 180) / (360 / coarse.cols);
  const v = (90 - lat) / (180 / coarse.rows);
  const ix = Math.floor(u);
  const iy = Math.floor(v);
  if (ix < 0 || ix >= coarse.cols || iy < 0 || iy >= coarse.rows) return null;
  // The sub-cell slot: `(s + 0.5) / SLOT_SUB` of the way across the cell. A point
  // that is not on that lattice is not a site, so it is refused rather than snapped.
  const sx = Math.round((u - ix) * SLOT_SUB - 0.5);
  const sy = Math.round((v - iy) * SLOT_SUB - 0.5);
  if (sx < 0 || sx >= SLOT_SUB || sy < 0 || sy >= SLOT_SUB) return null;
  if (Math.abs((u - ix) * SLOT_SUB - 0.5 - sx) > 1e-6) return null;
  if (Math.abs((v - iy) * SLOT_SUB - 0.5 - sy) > 1e-6) return null;
  const cell = iy * coarse.cols + ix;
  if (!isLandCell(coarse, cell)) return null;
  const rank = rankOfCoarseCell(cell);
  if (rank < 0) return null;
  // `siteOf(o) = { cell: sites[o % n], slot: (o / n) | 0 }`, so this is its inverse.
  return (sy * SLOT_SUB + sx) * landSiteCount() + rank;
}

/**
 * LEGACY DIAGNOSTIC MIRROR OF THE SERVER'S SEAT. (D3, 2026-08-10)
 *
 * The raw lattice point from `lonlat(siteOf(site_id))` offsets
 * onto a blind 4×4 sub-lattice inside a 2° cell and never re-checks the result — so
 * **4,203 of 86,912 valley sites (4.84%) are 0.5° water, and production's site 0 is
 * one of them** (lon −173.75, lat +67.75, the Bering Strait). P4b put every PARCEL on
 * real land; this is the same defect one level up, and it is the one a player looks
 * at first, because the valley pin is what they tap.
 *
 * The API performs this once. The seat is a LAND sub-cell of the valley's OWN 2°
 * cell (`siteSeatCell` — measured max 235.9 km, and 0 of 86,912 in water), so the
 * valley stays in its neighbourhood, its patch and its patch's bbox. Historically
 * the raw point doubled as identity; the seated point cannot be inverted without
 * drift. That is precisely why the current wire carries persisted `siteId` and this
 * diagnostic takes that integer rather than display lon/lat.
 *
 * @returns the seated point, or `null` when the grid cannot seat it (a coarse cell
 *   with no land sub-cell, which is measured to be none of the 5,432 that site
 *   valleys). GlobeLayer consumes the API's result and persisted siteId directly;
 *   it must never call this helper.
 */
export function seatLonLat(grid: ParcelGridApi, siteId: number): { lon: number; lat: number } | null {
  try {
    // `siteOf` is the same pure derivation the SERVER used to produce the lon/lat
    // this siteId was recovered from, so the round trip cannot drift.
    return grid.siteSeatLonLat(siteOf(siteId));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What a tile IS
// ---------------------------------------------------------------------------

/** One tile's whole public identity. A PLACE — there is nowhere in here to put a
 *  person, which is the point (R11). */
export interface TileFacts {
  /** Packed FINE-mask cell index, `iy · cols + ix`. Not comparable to a coarse
   *  cell id, and not comparable across resolutions. */
  cell: number;
  /** Cell CENTRE in degrees (`cellCentreDeg`), which is what the readout shows. */
  lon: number;
  lat: number;
  /** Generated country id, 1-based. 0 = NO SOVEREIGN = not claimable Earth (ocean
   *  and Antarctica share the sentinel deliberately). */
  countryId: number;
  /** Natural Earth `NAME`, verbatim. '' for the 0 sentinel. */
  name: string;
  /** NE `ISO_A2`; '' where NE carries its −99 sentinel (7 of 241 features). */
  iso2: string;
  /** NE `ADM0_A3` — the id's own sort key, so it is unique at both resolutions. */
  a3: string;
  /** 1-based rank of this cell among its country's claimable cells, ascending by
   *  cell index. 0 for no sovereign. */
  ordinal: number;
  /** `GEO-0042` — the tile id a player reads and can say out loud. '' for no
   *  sovereign. */
  code: string;
  /** Claimable Earth: it has a sovereign. `id !== 0`, the single test. */
  claimable: boolean;
}

/**
 * A TILE ID THAT IS DERIVED, NEVER STORED: ISO-A3 + the cell's ordinal within its
 * own country.
 *
 * It reads as a land registry, it sorts naturally, and it makes "every tile has a
 * country" visible in one string. Derived is the load-bearing word: nothing has to
 * be persisted for `GEO-0042` to be the same tile tomorrow, because it is a pure
 * function of the frozen mask + index — and the moment that id goes somewhere it
 * cannot be recalled from (a URL, a deed), P5 freezes the cell in a column first
 * (EARTH-TILES-PLAN §5.2 step 4 / R15). The country on the DEED reads that frozen
 * column and never this function (locked owner decision Q3).
 *
 * Cost is one pass over the land-cell list (86,122 byte compares, ~0.1 ms), so it
 * is called on SELECTION and never per frame.
 */
export function tileOrdinal(m: LandMask, idx: CountryIndex, cell: number, id: number): number {
  if (id === 0) return 0;
  const land = landCellList(m);
  let n = 0;
  for (let rank = 0; rank < land.length; rank++) {
    if (idx.cells[rank] === id && land[rank]! <= cell) n++;
  }
  // The sub-tile countries' cells live OUTSIDE the mask (plan §9), and they are
  // claimable Earth too — so they count, or Barbados' only tile would be #0.
  for (let i = 0; i < idx.extraCells.length; i++) {
    if (idx.extraIds[i] === id && idx.extraCells[i]! <= cell) n++;
  }
  return n;
}

/** `GEO-0042`. Four digits because the largest country holds ~9,700 cells at 0.5°
 *  and a fixed width sorts as text. */
export function tileCode(a3: string, ordinal: number): string {
  if (!a3 || ordinal <= 0) return '';
  return `${a3}-${String(ordinal).padStart(4, '0')}`;
}

/** Just the sovereign, with no ordinal scan — the CROSSHAIR path.
 *
 *  The crosshair readout is recomputed on every camera commit, and it only ever
 *  shows a name, so it must not pay `tileOrdinal`'s pass over 86,122 cells for a
 *  number nobody is reading. `tileFacts` is for a SELECTION, which happens once. */
export function tileCountry(
  m: LandMask, idx: CountryIndex, cell: number,
): { id: number; name: string; iso2: string; a3: string } | null {
  if (!Number.isInteger(cell) || cell < 0 || cell >= m.cols * m.rows) return null;
  const id = countryIdOfCell(m, idx, cell);
  const c = countryOfId(idx, id);
  return { id, name: c?.name ?? '', iso2: c?.iso2 ?? '', a3: c?.a3 ?? '' };
}

/**
 * A COUNTRY IN A VALLEY'S PATCH, and how much of the patch it holds.
 *
 * A VALLEY IS NOT A COUNTRY, and the UI must not let a player assume otherwise
 * (adversarial pass D11, 2026-08-10). Measured over all 120 patches: **91 span more
 * than one country, the mean is 4.17 and the worst spans 21.** Production's patch 0
 * is 420 cells of the United States and 71 of Russia — so the alpha's single valley
 * is a Russian pin over a mostly-American patch, and its neighbours are in a
 * different nation to each other by construction.
 *
 * That is not a defect to fix: a patch is 491 consecutive claimable cells along a
 * space-filling curve, chosen because consecutive parcels must be Earth NEIGHBOURS
 * (§5.2), and neighbours near a border are in two countries. Snapping patches to
 * borders would relocate every valley and shatter the clustering. So the mechanism
 * stays and the CHROME says so out loud, which is what this function is for.
 *
 * Descending by cell count, so the caller can name the majority country first.
 * ~491 index lookups per valley selection, never per frame.
 */
export interface PatchCountry {
  id: number;
  name: string;
  iso2: string;
  a3: string;
  /** Cells of this patch that lie in this country. Sums to 491. */
  cells: number;
}

export function patchCountries(
  m: LandMask, idx: CountryIndex, grid: ParcelGridApi, siteId: number,
): PatchCountry[] {
  if (!Number.isInteger(siteId) || siteId < 0 || siteId >= grid.patchCount()) return [];
  const count = new Map<number, number>();
  for (const cell of grid.patchCells(siteId)) {
    const id = countryIdOfCell(m, idx, cell);
    count.set(id, (count.get(id) ?? 0) + 1);
  }
  return [...count.entries()]
    .map(([id, cells]) => {
      const c = countryOfId(idx, id);
      return { id, name: c?.name ?? '', iso2: c?.iso2 ?? '', a3: c?.a3 ?? '', cells };
    })
    .sort((a, b) => b.cells - a.cells || a.a3.localeCompare(b.a3));
}

/** Everything a tile is, from its cell. `null` only for a cell outside the mask's
 *  grid — ocean and Antarctica are legitimate answers with `claimable: false`. */
export function tileFacts(m: LandMask, idx: CountryIndex, cell: number): TileFacts | null {
  if (!Number.isInteger(cell) || cell < 0 || cell >= m.cols * m.rows) return null;
  const iy = (cell / m.cols) | 0;
  const at = cellCentreDeg(m, cell - iy * m.cols, iy);
  const id = countryIdOfCell(m, idx, cell);
  const c: Country | null = countryOfId(idx, id);
  const ordinal = tileOrdinal(m, idx, cell, id);
  const a3 = c?.a3 ?? '';
  return {
    cell,
    lon: at.lon,
    lat: at.lat,
    countryId: id,
    name: c?.name ?? '',
    iso2: c?.iso2 ?? '',
    a3,
    ordinal,
    code: tileCode(a3, ordinal),
    claimable: id !== 0,
  };
}

/**
 * The cell centre as a player reads it: `67.8°N 173.8°W`.
 *
 * One decimal, because a 0.5° cell is 55 km across and a second decimal would claim
 * a precision the tile does not have. Hemisphere letters rather than signs, and
 * `normalizeLon` first so a camera that has spun east forever still says W.
 */
export function degText(lon: number, lat: number): string {
  const la = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
  const l = normalizeLon(lon);
  return `${la} ${Math.abs(l).toFixed(1)}°${l >= 0 ? 'E' : 'W'}`;
}

// ---------------------------------------------------------------------------
// Where a parcel IS
// ---------------------------------------------------------------------------

/** A parcel pin that knows the ground it stands on. */
export interface PlacedParcel extends ParcelPin {
  /** The FINE cell `parcelCell(siteId, x, y)` resolved to. */
  cell: number;
  /** That cell's CENTRE, degrees — where the pin is drawn. Not the valley's site:
   *  that is the whole of P4b. */
  lon: number;
  lat: number;
}

/**
 * OCCUPIED PLOTS → PINS ON REAL EARTH. The line the owner rejected, replaced.
 *
 * Every pin used to be handed its VALLEY's lon/lat and then displaced on a rigid
 * screen-space lattice (`GlobeLayer.tsx:351-352` + `parcelOffset`), which is
 * arithmetically why tiles landed in the sea: the lattice was ~1,100 px across while
 * the 2° cell it was anchored in was a few px. Now each parcel resolves through
 * `parcelCell(site_id, x, y)` to one claimable 0.5° cell and is drawn at that cell's
 * centre — so a parcel CANNOT be in the water, by construction rather than by
 * filtering (the stream is built from `claimableCells`, and the mask's land list is
 * the only thing it can contain).
 *
 * Order is `parcelPins`' order, unchanged and still deliberate: small keeps first so
 * a maxed neighbour cannot bury a fresh one, YOUR parcel last so its marker is never
 * occluded by the 490 that are not yours.
 *
 * @returns `[]` when Earth's patch stream does not seat this valley at all (site ids
 *   past `patchCount()`), because the honest answer to "where is my land" is not a
 *   pin somewhere plausible — it is the chrome saying it cannot be placed.
 */
export function placeParcels(
  rows: readonly ParcelRow[], siteId: number, grid: ParcelGridApi, fine: LandMask,
): PlacedParcel[] {
  if (!Number.isInteger(siteId) || siteId < 0 || siteId >= grid.patchCount()) return [];
  const out: PlacedParcel[] = [];
  const at = { lon: 0, lat: 0 };
  for (const p of parcelPins(rows)) {
    const cell = p.earthCell;
    const address = Number.isInteger(cell) && cell >= 0 && cell < fine.cols * fine.rows
      ? grid.parcelOf(cell)
      : null;
    // The stored address is the deed's authority. Generated geography is only a
    // consistency check: if it no longer maps back to this exact valley/x/y, do
    // not move the deed to a newly computed cell and do not draw it somewhere
    // plausible. Fail closed and let the UI report an unplaceable parcel.
    if (!address || address.siteId !== siteId || address.x !== p.x || address.y !== p.y) continue;
    const iy = (cell / fine.cols) | 0;
    cellCentreDeg(fine, cell - iy * fine.cols, iy, at);
    out.push({ ...p, cell, lon: at.lon, lat: at.lat });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Is this cell taken — and never by whom
// ---------------------------------------------------------------------------

/**
 * The five honest answers to "is this tile free?", and the reason there are five.
 *
 * `yours` / `claimed` / `free` are the three the owner asked for. The other two are
 * the two ways the question genuinely cannot be answered, and saying so is better
 * than guessing:
 *  - `unseated` — no valley's patch contains this cell. 2,832 claimable cells are in
 *    that state (measured): the coarse-anchored stream cannot reach every small
 *    island, and the tail that cannot fill a whole patch of 491 is dropped rather
 *    than half-seating a valley. Nobody can ever own it as Earth stands.
 *  - `elsewhere` — the cell belongs to a DIFFERENT valley's patch, and the client
 *    holds one valley's roster at a time (one `GET /map` per selection, no new
 *    endpoint — EARTH-TILES-PLAN R7). We know the patch and not the occupancy.
 */
export type CellState = 'yours' | 'claimed' | 'free' | 'unseated' | 'elsewhere';

export interface CellOwnership {
  state: CellState;
  /** The valley whose patch seats this cell, when one does. */
  siteId: number | null;
  /** The plot coordinates this cell IS, when a valley seats it. `plots.(x, y)`,
   *  never reinterpreted. */
  x: number | null;
  y: number | null;
}

/**
 * Who holds a cell, from the one valley roster the client has.
 *
 * `rows` is `ParcelRow[]`, but this function deliberately returns only occupancy
 * and coordinates. Public profile rendering stays outside the geography model.
 */
export function cellOwnership(
  cell: number, siteId: number | null, grid: ParcelGridApi, rows: readonly ParcelRow[] | null,
): CellOwnership {
  const t = grid.parcelOf(cell);
  if (!t) return { state: 'unseated', siteId: null, x: null, y: null };
  const here = { siteId: t.siteId, x: t.x, y: t.y };
  if (siteId === null || t.siteId !== siteId || !rows) return { state: 'elsewhere', ...here };
  const row = rows.find((r) => r.x === t.x && r.y === t.y);
  if (!row) return { state: 'free', ...here };
  return { state: row.mine ? 'yours' : 'claimed', ...here };
}
