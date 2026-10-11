/**
 * The baked Earth (docs/WORLDMAP-GLOBE-PLAN.md §1.1). Encodes the WHY:
 *
 *  • IT MUST BE THE REAL EARTH. The masks are generated data — nobody reads
 *    16,200 bits in review — so "did we ship a plausible-looking fake planet?"
 *    has to be a test. Cities on five continents are land, open ocean is ocean,
 *    Antarctica exists, the Arctic does not, and the cos-lat-weighted land
 *    fraction matches Earth's real 29.2%. A mask that is upside-down,
 *    east-west-mirrored, or half-empty fails at least three of those.
 *  • THE SHAPE HAS ONE HOME. The generated modules carry their own cols/rows as
 *    data; these assertions pin them to GLOBE.* in constants.ts, so a
 *    regenerated mask cannot silently change resolution behind the tunable.
 *  • THE FINE MASK MUST NOT ENTER THE FIRST-PAINT GRAPH. Measured budget is
 *    995 / 1000 KB gzip and size-check.mjs fails the build at 1001. The fine
 *    mask is ~5.3 KB gzip of payload, so it is dynamic-import-only — asserted
 *    here by checking it is absent from the package's main entry point.
 */
import { describe, expect, it } from 'vitest';
import { GLOBE } from './constants';
import { EARTH_COARSE } from './earthMask';
import { EARTH_COUNTRIES } from './earthCountries';
import {
  cellAtDeg,
  cellCentreDeg,
  cellIndex,
  claimableCells,
  countryIdAtRank,
  countryIdOfCell,
  countryOfId,
  isLandAtDeg,
  landCellList,
  landCellRank,
  maskBit,
  type CountryIndex,
  type LandMask,
} from './globe';

/** cos(lat)-weighted land fraction — the physically meaningful "29% of Earth". */
function landAreaFraction(m: LandMask): number {
  let land = 0;
  let total = 0;
  for (let iy = 0; iy < m.rows; iy++) {
    const lat = 90 - (iy + 0.5) * (180 / m.rows);
    const w = Math.cos((lat * Math.PI) / 180);
    for (let ix = 0; ix < m.cols; ix++) {
      total += w;
      if (maskBit(m, ix, iy) === 1) land += w;
    }
  }
  return land / total;
}

const LAND_POINTS: [string, number, number][] = [
  ['London', -0.13, 51.5],
  ['Cairo', 31.24, 30.04],
  ['São Paulo', -46.63, -23.55],
  ['Sydney', 151.21, -33.87],
  ['Kansas', -98.0, 38.5],
  // Antarctica: Natural Earth includes it, and a globe that quietly drops it
  // loses 9% of the world's land and looks wrong at every southern rotation.
  ['Antarctica', 0, -80],
];

const OCEAN_POINTS: [string, number, number][] = [
  ['mid-Pacific', -140, 0],
  ['mid-Atlantic', -30, -20],
  ['Southern Ocean', 60, -60],
  ['North Pacific', -170, 40],
  // The Arctic is ocean. Together with Antarctica this pins the mask's
  // north–south orientation: a flipped mask fails both at once.
  ['Arctic Ocean', 0, 89],
];

describe.each([
  ['EARTH_COARSE', () => Promise.resolve(EARTH_COARSE), GLOBE.coarseCols, GLOBE.coarseRows],
  [
    'EARTH_FINE',
    () => import('./earthMaskFine').then((m) => m.EARTH_FINE),
    GLOBE.fineCols,
    GLOBE.fineRows,
  ],
] as const)('%s', (_name, load, cols, rows) => {
  it('has the resolution constants.ts says it has', async () => {
    const m = await load();
    expect(m.cols).toBe(cols);
    expect(m.rows).toBe(rows);
    expect(m.bits.length).toBe(Math.ceil((cols * rows) / 8));
  });

  it('agrees with its own landCells count', async () => {
    const m = await load();
    // landCellList throws if the header count and the bitset disagree — a
    // truncated or hand-edited generated file cannot pass silently.
    expect(landCellList(m).length).toBe(m.landCells);
  });

  it.each(LAND_POINTS)('has land at %s', async (_p, lon, lat) => {
    expect(isLandAtDeg(await load(), lon, lat)).toBe(true);
  });

  it.each(OCEAN_POINTS)('has ocean at %s', async (_p, lon, lat) => {
    expect(isLandAtDeg(await load(), lon, lat)).toBe(false);
  });

  it('covers ~29% of the sphere by area, like the real Earth', async () => {
    const m = await load();
    const f = landAreaFraction(m) * 100;
    expect(f).toBeGreaterThan(25);
    expect(f).toBeLessThan(33);
  });

  it('indexes row 0 as NORTH and column 0 from lon −180', async () => {
    const m = await load();
    expect(cellAtDeg(m, -180, 90)).toEqual({ ix: 0, iy: 0 });
    expect(cellAtDeg(m, 179.99, -89.99)).toEqual({ ix: m.cols - 1, iy: m.rows - 1 });
    // longitude wraps rather than throwing, latitude clamps at the poles
    expect(cellAtDeg(m, 180, 0)).toEqual(cellAtDeg(m, -180, 0));
    expect(cellAtDeg(m, 0, 91)).toEqual(cellAtDeg(m, 0, 90));
  });
});

describe('first-paint budget', () => {
  it('does NOT re-export EITHER mask from the package entry point', async () => {
    // Two guards in one assertion.
    //   FINE: keeps ~5.3 KB gzip out of the first-paint graph — if a future
    //   `export * from './earthMaskFine'` lands in index.ts this fails here
    //   instead of in apps/web's size-check at 1001 KB.
    //   COARSE: packages/sim imports THIS barrel, and an `export *` would put a
    //   base64 decode (and, through globe.ts, trig) inside the deterministic
    //   simulator's module graph. Both masks are subpath-only:
    //   `@shardkeep/shared/earthMask` / `/earthMaskFine`. See index.ts's header
    //   and packages/sim/tests/import-graph.test.ts.
    const entry = await import('./index');
    expect(Object.keys(entry)).not.toContain('EARTH_COARSE');
    expect(Object.keys(entry)).not.toContain('EARTH_FINE');
  });

  it('keeps the coarse mask small enough to ship eagerly', async () => {
    // ~2 KB raw packed / ~0.83 KB gzip as measured by the generator.
    expect(EARTH_COARSE.bits.byteLength).toBeLessThan(2_500);
    const fine = (await import('./earthMaskFine')).EARTH_FINE;
    expect(fine.bits.byteLength).toBeGreaterThan(EARTH_COARSE.bits.byteLength * 10);
  });

  it('keeps NEITHER country index on the package entry point either', async () => {
    // Same two reasons as the masks (first-paint budget for the fine index, sim's
    // deterministic module graph for both) — and packages/sim/tests/import-graph
    // asserts the other half of it by walking the real graph.
    const entry = await import('./index');
    expect(Object.keys(entry)).not.toContain('EARTH_COUNTRIES');
    expect(Object.keys(entry)).not.toContain('EARTH_COUNTRIES_FINE');
  });

  it('keeps the coarse country index small enough to ship eagerly', async () => {
    // 1.39 KB gzip of payload as measured by the generator, against ~5 KB of
    // first-paint headroom — so the EAGER half of the country layer has to stay
    // one byte per COARSE land cell. The fine index is 6.71 KB gzip and is
    // dynamic-import-only for exactly that reason.
    expect(EARTH_COUNTRIES.cells.byteLength).toBe(EARTH_COARSE.landCells);
    expect(EARTH_COUNTRIES.cells.byteLength).toBeLessThan(6_000);
    const fine = (await import('./earthCountriesFine')).EARTH_COUNTRIES_FINE;
    expect(fine.cells.byteLength).toBeGreaterThan(EARTH_COUNTRIES.cells.byteLength * 10);
  });
});

// ---------------------------------------------------------------------------
// The country layer (docs/EARTH-TILES-PLAN.md §3). Encodes the WHY:
//
//  • A TILE MUST HAVE A COUNTRY, OR IT IS THE OLD FEATURELESS DOT. That is only
//    true BY CONSTRUCTION because the mask and the country index come from ONE
//    parse of ONE file at ONE resolution: the same 8-of-16 subsample cover count
//    decides both "is this land" and "whose land". The generator proves it by
//    refusing to emit unless the union of the admin_0 rings rasterises to the
//    checked-in land mask byte-identically, and the assertions below are the
//    in-repo half of that guarantee.
//  • THE ONLY CELLS WITHOUT A COUNTRY ARE THE ONES DELIBERATELY DROPPED.
//    Antarctica has no Natural Earth sovereign, so labelling it would be a
//    fabrication and it is not claimable ground (owner decision 2026-08-10 Q4).
//    Asserted as an EXACT set, by latitude, so "a cell fell through the vote
//    pass" can never hide inside "some cells have no country".
//  • EVERY COUNTRY IS ON EARTH. 61 countries are smaller than one 0.5° cell and
//    would win nothing on votes. Each is granted exactly one tile, and every one
//    of the 61 is named here: a silent omission means a country simply is not on
//    the planet, which is not a thing a review would notice.
// ---------------------------------------------------------------------------

/** The four sanity points the plan names, plus the two that exercise the
 *  sub-tile grants. Asserted at 0.5°, the resolution a tile is defined at — at 2°
 *  a single cell spans three Caucasus countries and the 110m source does not even
 *  contain Singapore, so these would be assertions about resolution, not data. */
const COUNTRY_POINTS: [string, number, number, string][] = [
  ['London', -0.13, 51.5, 'United Kingdom'],
  ['Tbilisi', 44.83, 41.72, 'Georgia'],
  ['Manhattan', -73.97, 40.78, 'United States of America'],
  ['Singapore', 103.82, 1.35, 'Singapore'],
  // Both of these live in `extraCells`: their own cell is >50% water, so the
  // majority rule calls it ocean, and the tile is there anyway because that is
  // where the country is. A "nearest land cell" rule would put Barbados inside
  // Venezuela, which is the whole reason extraCells exists.
  ['Barbados', -59.55, 13.16, 'Barbados'],
  ['Vatican', 12.45, 41.9, 'Vatican'],
];

/**
 * THE 61. Hand-enumerated from the generator's emitted list, every one asserted
 * to own exactly one tile. Natural Earth `NAME` verbatim, abbreviations included
 * — matching NE rather than prettifying is what keeps this list checkable against
 * the source.
 */
const SUB_TILE_COUNTRIES: [string, string][] = [
  ['ABW', 'Aruba'],
  ['AIA', 'Anguilla'],
  ['ALD', 'Åland'],
  ['AND', 'Andorra'],
  ['ASM', 'American Samoa'],
  ['ATC', 'Ashmore and Cartier Is.'],
  ['ATG', 'Antigua and Barb.'],
  ['BHR', 'Bahrain'],
  ['BLM', 'St-Barthélemy'],
  ['BMU', 'Bermuda'],
  ['BRB', 'Barbados'],
  ['COK', 'Cook Is.'],
  ['COM', 'Comoros'],
  ['CPV', 'Cabo Verde'],
  ['CUW', 'Curaçao'],
  ['CYM', 'Cayman Is.'],
  ['DMA', 'Dominica'],
  ['FRO', 'Faeroe Is.'],
  ['FSM', 'Micronesia'],
  ['GGY', 'Guernsey'],
  ['GRD', 'Grenada'],
  ['GUM', 'Guam'],
  ['HKG', 'Hong Kong'],
  ['HMD', 'Heard I. and McDonald Is.'],
  ['IMN', 'Isle of Man'],
  ['IOA', 'Indian Ocean Ter.'],
  ['IOT', 'Br. Indian Ocean Ter.'],
  ['JEY', 'Jersey'],
  ['KIR', 'Kiribati'],
  ['KNA', 'St. Kitts and Nevis'],
  ['LCA', 'Saint Lucia'],
  ['LIE', 'Liechtenstein'],
  ['MAC', 'Macao'],
  ['MAF', 'St-Martin'],
  ['MCO', 'Monaco'],
  ['MDV', 'Maldives'],
  ['MHL', 'Marshall Is.'],
  ['MLT', 'Malta'],
  ['MNP', 'N. Mariana Is.'],
  ['MSR', 'Montserrat'],
  ['NFK', 'Norfolk Island'],
  ['NIU', 'Niue'],
  ['NRU', 'Nauru'],
  ['PCN', 'Pitcairn Is.'],
  ['PLW', 'Palau'],
  ['PYF', 'Fr. Polynesia'],
  ['SGP', 'Singapore'],
  ['SHN', 'Saint Helena'],
  ['SMR', 'San Marino'],
  ['SPM', 'St. Pierre and Miquelon'],
  ['STP', 'São Tomé and Principe'],
  ['SXM', 'Sint Maarten'],
  ['SYC', 'Seychelles'],
  ['TCA', 'Turks and Caicos Is.'],
  ['TON', 'Tonga'],
  ['VAT', 'Vatican'],
  ['VCT', 'St. Vin. and Gren.'],
  ['VGB', 'British Virgin Is.'],
  ['VIR', 'U.S. Virgin Is.'],
  ['WLF', 'Wallis and Futuna Is.'],
  ['WSM', 'Samoa'],
];

const fineCountries = (): Promise<CountryIndex> =>
  import('./earthCountriesFine').then((m) => m.EARTH_COUNTRIES_FINE);

/** Every cell owned by a country, by ADM0_A3, land cells and extras together. */
function cellsByCountry(m: LandMask, idx: CountryIndex): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const push = (id: number, cell: number): void => {
    const c = countryOfId(idx, id);
    if (!c) return;
    const list = out.get(c.a3);
    if (list) list.push(cell);
    else out.set(c.a3, [cell]);
  };
  const land = landCellList(m);
  for (let rank = 0; rank < land.length; rank++) push(idx.cells[rank]!, land[rank]!);
  for (let i = 0; i < idx.extraCells.length; i++) push(idx.extraIds[i]!, idx.extraCells[i]!);
  return out;
}

describe.each([
  ['EARTH_COUNTRIES', () => Promise.resolve(EARTH_COUNTRIES), () => Promise.resolve(EARTH_COARSE)],
  ['EARTH_COUNTRIES_FINE', fineCountries, () => import('./earthMaskFine').then((m) => m.EARTH_FINE)],
] as const)('%s', (_name, loadIdx, loadMask) => {
  it('is one byte per land cell of the mask it belongs to', async () => {
    const [idx, m] = [await loadIdx(), await loadMask()];
    expect(idx.cols).toBe(m.cols);
    expect(idx.rows).toBe(m.rows);
    // The index is keyed by RANK in landCellList, not by grid cell — the whole
    // reason it is 5 KB and not 260 KB.
    expect(idx.cells.length).toBe(m.landCells);
  });

  it('fits ≤ 255 countries, because the index byte has a 0 sentinel', async () => {
    // 10m Natural Earth has exactly 255 features, so this has ZERO headroom at
    // the next resolution up. The failure mode is a silently wrapped id — a
    // country rendering as a different country — so it must be loud here.
    const idx = await loadIdx();
    expect(idx.countries.length).toBeGreaterThan(100);
    expect(idx.countries.length).toBeLessThanOrEqual(255);
    for (let i = 0; i < idx.cells.length; i++) {
      expect(idx.cells[i]!).toBeLessThanOrEqual(idx.countries.length);
    }
  });

  it('keys ids on a sorted, unique ADM0_A3 — never on file order', async () => {
    // A data refresh that reorders rows must not renumber a single tile, which is
    // why the id is a rank in this sort and not the row index.
    const idx = await loadIdx();
    const codes = idx.countries.map((c) => c.a3);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    for (const c of idx.countries) {
      expect(c.a3, `${c.a3} must be a 3-letter code`).toMatch(/^[A-Z0-9]{3}$/);
      expect(c.name.length, `${c.a3} must have a name`).toBeGreaterThan(0);
      // MAPCOLOR9 is the RENDER key: `mat` is a Uint8Array, so materials must be
      // indexed by 9 hues and never by ~240 country ids (EARTH-TILES-PLAN R19).
      expect(c.color, `${c.a3} MAPCOLOR9`).toBeGreaterThanOrEqual(1);
      expect(c.color, `${c.a3} MAPCOLOR9`).toBeLessThanOrEqual(9);
    }
  });

  it('gives EVERY land cell a country except the deliberately dropped ones', async () => {
    // This is what the Antarctica drop buys, and it is asserted as an EXACT set:
    // every countryless cell is south of 60°S. If a cell anywhere else ever lost
    // its country, the "one parse, one file, one resolution" property broke and
    // this fails instead of shipping a blank tile.
    const [idx, m] = [await loadIdx(), await loadMask()];
    const land = landCellList(m);
    let countryless = 0;
    for (let rank = 0; rank < land.length; rank++) {
      if (idx.cells[rank] !== 0) continue;
      countryless++;
      const cell = land[rank]!;
      const ll = cellCentreDeg(m, cell % m.cols, (cell / m.cols) | 0);
      expect(ll.lat, `cell ${cell} has no country but is not Antarctica`).toBeLessThan(-60);
    }
    // Antarctica is ~28% of land cells, and it must not be ~0% (a drop that
    // silently stopped working) or ~100% (a drop that ate the planet).
    const share = countryless / m.landCells;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.35);
  });

  it('gives every country at least one tile, so none is missing from Earth', async () => {
    const [idx, m] = [await loadIdx(), await loadMask()];
    const owned = cellsByCountry(m, idx);
    for (const c of idx.countries) {
      expect(owned.get(c.a3)?.length ?? 0, `${c.a3} (${c.name}) owns no tile`).toBeGreaterThan(0);
    }
  });

  it('defines claimable Earth as land-with-a-country plus the sub-tile cells', async () => {
    const [idx, m] = [await loadIdx(), await loadMask()];
    const countryless = [...idx.cells].filter((v) => v === 0).length;
    const claimable = claimableCells(m, idx);
    expect(claimable.length).toBe(m.landCells - countryless + idx.extraCells.length);
    // Ascending and unique, because P4 streams this list to build parcel patches.
    for (let i = 1; i < claimable.length; i++) expect(claimable[i]!).toBeGreaterThan(claimable[i - 1]!);
    // Every claimable cell has a country; no exceptions, by construction.
    for (const cell of claimable) expect(countryIdOfCell(m, idx, cell)).toBeGreaterThan(0);
  });

  it('holds the sub-tile cells OUTSIDE the mask, ascending, each with a country', async () => {
    const [idx, m] = [await loadIdx(), await loadMask()];
    for (let i = 0; i < idx.extraCells.length; i++) {
      const cell = idx.extraCells[i]!;
      // Outside the mask is the point: these are cells the majority rule calls
      // ocean, so they cannot collide with a land cell's rank.
      expect(landCellRank(m, cell), `extra cell ${cell} is already a land cell`).toBe(-1);
      expect(idx.extraIds[i]!).toBeGreaterThan(0);
      if (i > 0) expect(cell).toBeGreaterThan(idx.extraCells[i - 1]!);
    }
    expect(idx.extraIds.length).toBe(idx.extraCells.length);
  });
});

describe('country lookups', () => {
  it.each(COUNTRY_POINTS)('says %s is in %s', async (_p, lon, lat, name) => {
    const [idx, m] = [await fineCountries(), await import('./earthMaskFine').then((x) => x.EARTH_FINE)];
    const c = cellAtDeg(m, lon, lat);
    const id = countryIdOfCell(m, idx, cellIndex(m, c.ix, c.iy));
    expect(countryOfId(idx, id)?.name).toBe(name);
  });

  it('reports NO country for open ocean and for Antarctica', async () => {
    // The 0 sentinel means "not claimable", and ocean and dropped ground share it
    // deliberately: a caller that checks `id !== 0` has checked both.
    const [idx, m] = [await fineCountries(), await import('./earthMaskFine').then((x) => x.EARTH_FINE)];
    for (const [, lon, lat] of OCEAN_POINTS) {
      const c = cellAtDeg(m, lon, lat);
      expect(countryIdOfCell(m, idx, cellIndex(m, c.ix, c.iy))).toBe(0);
    }
    const a = cellAtDeg(m, 0, -80);
    expect(isLandAtDeg(m, 0, -80)).toBe(true); // Antarctica IS land …
    expect(countryIdOfCell(m, idx, cellIndex(m, a.ix, a.iy))).toBe(0); // … and has no sovereign.
  });

  it('agrees with itself by rank and by cell, and refuses a mismatched mask', async () => {
    const [idx, m] = [await fineCountries(), await import('./earthMaskFine').then((x) => x.EARTH_FINE)];
    const land = landCellList(m);
    for (const rank of [0, 1, 1_000, 40_000, land.length - 1]) {
      expect(countryIdOfCell(m, idx, land[rank]!)).toBe(countryIdAtRank(idx, rank));
    }
    // The server placing a valley on a subtly different planet than the client is
    // the one bug that makes the globe unfixable, so a coarse mask against a fine
    // index throws rather than returning a plausible wrong answer.
    expect(() => countryIdOfCell(EARTH_COARSE, idx, 0)).toThrow(/720×360|180×90/);
  });

  it('gives each of the 61 sub-tile countries EXACTLY one tile', async () => {
    // Hand-enumerated (see SUB_TILE_COUNTRIES): a country missing from Earth is
    // invisible in review, so every one of the 61 is named and checked. "Exactly
    // one" is the other half — a grant that accidentally claimed a run of cells
    // would silently annex a neighbour.
    const [idx, m] = [await fineCountries(), await import('./earthMaskFine').then((x) => x.EARTH_FINE)];
    const owned = cellsByCountry(m, idx);
    expect(SUB_TILE_COUNTRIES.length).toBe(61);
    for (const [a3, name] of SUB_TILE_COUNTRIES) {
      const c = idx.countries.find((x) => x.a3 === a3);
      expect(c, `${a3} is not in the country table at all`).toBeDefined();
      expect(c!.name).toBe(name);
      expect(owned.get(a3)?.length ?? 0, `${a3} (${name}) must own exactly one tile`).toBe(1);
    }
    // And the list must not go stale. A country owning exactly one tile is either
    // one of the 61 granted ones or one of these six, which WIN their single cell
    // on votes and need no grant — Bahamas, Brunei, Siachen Glacier, Luxembourg,
    // Mauritius, Vanuatu. Pinning the union means a data refresh that pushes a new
    // country below one cell fails here instead of quietly relying on a stale
    // enumeration, which is the one way a country goes missing unnoticed.
    const wonOutright = ['BHS', 'BRN', 'KAS', 'LUX', 'MUS', 'VUT'];
    const singles = [...owned.entries()].filter(([, cells]) => cells.length === 1).map(([a3]) => a3);
    expect(singles.sort()).toEqual([...SUB_TILE_COUNTRIES.map(([a3]) => a3), ...wonOutright].sort());
    // 57 of the 61 sit in extraCells; the other 4 (Andorra, Liechtenstein,
    // Monaco, San Marino) are landlocked micro-states whose own cell IS land, so
    // their tile is transferred from the country around them.
    expect(idx.extraCells.length).toBe(57);
  });

  it('ships the alternate-viewpoint codes so a viewpoint switch is one constant', async () => {
    // Natural Earth draws de facto boundaries and says so; it also ships the
    // US/IS points of view AS DATA. Emitting them means switching viewpoint later
    // is a constant, not a regeneration — and it is why no flag art exists here.
    const idx = await fineCountries();
    const ru = idx.countries.find((c) => c.a3 === 'RUS')!;
    expect(ru.iso2).toBe('RU');
    expect(ru.a3us).toBe('RUS');
    // MEASURED against the checked-in source, and asserted so a mirror refresh
    // that starts or stops carrying a column is visible: _US is populated for
    // every feature, _IS for all but one, and _UN for NONE — this GeoJSON simply
    // has no UN column, so "switch to the UN view" is NOT available from this
    // data and '' must be read as "same as a3".
    expect(idx.countries.filter((c) => c.a3us !== '').length).toBe(idx.countries.length);
    expect(idx.countries.filter((c) => c.a3is !== '').length).toBe(idx.countries.length - 1);
    expect(idx.countries.filter((c) => c.a3un !== '').length).toBe(0);
    // Disputed features carry their own NAME and no invented sovereign.
    for (const a3 of ['KOS', 'PSX', 'TWN', 'CYN', 'SOL', 'SAH']) {
      expect(idx.countries.some((c) => c.a3 === a3), `${a3} must survive verbatim`).toBe(true);
    }
    // The mirror's two stale names are patched, and only those two.
    expect(idx.countries.find((c) => c.a3 === 'MKD')?.name).toBe('North Macedonia');
    expect(idx.countries.find((c) => c.a3 === 'SWZ')?.name).toBe('eSwatini');
  });
});
