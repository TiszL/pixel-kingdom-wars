/**
 * SHARDKEEP — tests for the PURE PARTS of the earth mask/country generator
 * (`scripts/src/earth-mask.ts`, docs/EARTH-TILES-PLAN.md §3, adversarial finding
 * D10: 868 new lines of generator shipped with no test in this package).
 *
 * WHY THIS FILE LOADS THE GENERATOR THROUGH A HARNESS INSTEAD OF IMPORTING IT.
 * `earth-mask.ts` is a script, not a library: it exports nothing and it ends in a
 * top-level `main().catch(…)` that fetches ~30 MB of Natural Earth GeoJSON and
 * OVERWRITES four checked-in modules in `packages/shared/src`. Importing it would
 * therefore hit the network and rewrite generated source as a side effect of
 * running the suite. It must not be edited to add exports either — EARTH-TILES
 * R21 makes the generator's output byte-identical to what is checked in, so the
 * file's behaviour is load-bearing and this pass is explicitly not allowed to
 * change it.
 *
 * So the harness reads the real source, cuts it at the `main()` invocation,
 * appends a `module.exports` of the internals, transpiles it with the
 * `typescript` compiler this package already depends on, and evaluates it. Both
 * surgeries are ASSERTED: if the runner line or the `import.meta.url` use ever
 * moves, the harness throws instead of quietly testing a stale shape.
 *
 * WHAT IS AND IS NOT COVERED. Everything below the fetch is pure and covered
 * here: the country-index assembly (`loadCountries`), the ≤255 assert, the
 * scanline rasteriser's land/vote pass, the Antarctica drop, and the sub-tile
 * grant / `extraCells` split (`assignCountries`). The byte-identity gate itself
 * lives inline in `main()` and cannot be reached without running the fetch, so
 * what is tested here is the PROPERTY it compares plus the sensitivity of its two
 * conditions — see the last describe block.
 *
 * The fixtures are hand-built 10° worlds (36×18), not Earth: a test that needs
 * the real 50m source to say anything is a test that only runs when the network
 * is up. The real-Earth assertions live in `packages/shared/src/earthMask.test.ts`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Ring = number[][];
interface Feature { props: Record<string, string>; rings: Ring[] }
interface Raster {
  cols: number; rows: number; bits: Uint8Array; landCells: number;
  areaFraction: number; cellFraction: number;
  winner: Int32Array; cells: Int32Array; polled: Map<number, [number, number][]>;
}
interface Grant { a3: string; name: string; cell: number; how: 'own' | 'anchor' | 'shared'; from: string }
interface Assigned {
  index: Uint8Array; table: Feature[]; extra: { cell: number; id: number }[];
  grants: Grant[]; dropped: string[]; droppedCells: number;
}
interface Internals {
  loadCountries(which: 'coarseCountries' | 'fineCountries'): Promise<Feature[]>;
  rasterise(feats: readonly Feature[], cols: number, rows: number): Raster;
  assignCountries(feats: readonly Feature[], r: Raster): Assigned;
  ringArea(ring: Ring): number;
  largestLandmassDeg(f: Feature): { lon: number; lat: number };
  NAME_FIX: Record<string, string>;
  NO_SOVEREIGN: Set<string>;
  SUB: number;
  COVER_MIN: number;
}

const GENERATOR = fileURLToPath(new URL('./earth-mask.ts', import.meta.url));
/** The one line that turns the module from a library into a script. */
const RUNNER = 'main().catch(';
/** The one construct the CommonJS transpile cannot represent. */
const META_URL = 'import.meta.url';

function loadInternals(): Internals {
  const src = readFileSync(GENERATOR, 'utf8');
  const cut = src.indexOf(RUNNER);
  if (cut < 0) {
    throw new Error(`${GENERATOR}: no ${RUNNER} — the harness cannot tell script from library any more`);
  }
  if (src.split(META_URL).length !== 2) {
    throw new Error(`${GENERATOR}: expected exactly one ${META_URL}; the harness substitutes it`);
  }
  const body = `${src.slice(0, cut).replace(META_URL, JSON.stringify(pathToFileURL(GENERATOR).href))}
module.exports = {
  loadCountries, rasterise, assignCountries, ringArea, largestLandmassDeg,
  NAME_FIX, NO_SOVEREIGN, SUB, COVER_MIN,
};
`;
  const js = ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as Internals };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('require', 'module', 'exports', '__filename', '__dirname', js)(
    createRequire(GENERATOR), mod, mod.exports, GENERATOR, dirname(GENERATOR),
  );
  return mod.exports;
}

const G = loadInternals();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 36×18 = 10° cells, so a cell's 4×4 samples sit at +1.25/3.75/6.25/8.75°. */
const COLS = 36;
const ROWS = 18;
const cellOf = (ix: number, iy: number): number => iy * COLS + ix;
/** Grid indices of a lon/lat, on the fixture grid. */
const ixOf = (lon: number): number => Math.floor((lon + 180) / 10);
const iyOf = (lat: number): number => Math.floor((90 - lat) / 10);

/** A closed rectangular ring, counter-clockwise. */
function rect(lon0: number, lat0: number, lon1: number, lat1: number): Ring {
  return [[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]];
}

function feature(a3: string, rings: Ring[], extra: Partial<Feature['props']> = {}): Feature {
  return { props: { a3, name: a3, iso2: '', a3is: a3, a3un: '', a3us: a3, color: '1', ...extra }, rings };
}

/**
 * The fixture world, built so that ONE raster exercises every branch of the
 * grant pass. Sub-tile squares sit in HOLES of their neighbours rather than on
 * top of them, because the vote pass resolves a genuine overlap to the lowest
 * feature index — Natural Earth's admin_0 polygons are disjoint and the fixture
 * has to be too, or the small country simply polls zero.
 *
 *   ATA  8 cells in the far south      → dropped, its cells carry the 0 sentinel
 *   BIG  8 cells at the equator, with a pinhole at one sample point
 *   MIN  a square inside BIG's pinhole → wins a LAND cell, TRANSFERRED from BIG
 *   SOL  exactly 1 cell, with a pinhole
 *   SO2  a square inside SOL's pinhole → must NOT take SOL's only cell ⇒ 'shared'
 *   TSE  a square in an OCEAN cell     → 'own', and an EXTRA (no victim)
 *   DOT  a square between sample points → polls nowhere ⇒ 'anchor', and an EXTRA
 */
const BIG_HOLE = { lon: 11.25, lat: 8.75 };
const SOL_HOLE = { lon: 101.25, lat: 38.75 };
const TSE_AT = { lon: -98.75, lat: -1.25 };
const DOT_AT = { lon: 75, lat: 55 };

function pinhole(at: { lon: number; lat: number }, r: number): Ring {
  return rect(at.lon - r, at.lat - r, at.lon + r, at.lat + r);
}

const WORLD: Feature[] = [
  feature('ATA', [rect(-170, -80, -130, -60)]),
  feature('BIG', [rect(0, -10, 40, 10), pinhole(BIG_HOLE, 0.25)]),
  feature('DOT', [pinhole(DOT_AT, 0.1)]),
  feature('MIN', [pinhole(BIG_HOLE, 0.15)]),
  feature('SO2', [pinhole(SOL_HOLE, 0.15)]),
  feature('SOL', [rect(100, 30, 110, 40), pinhole(SOL_HOLE, 0.25)]),
  feature('TSE', [pinhole(TSE_AT, 0.25)]),
];
/** `assignCountries` relies on ascending index BEING ascending ADM0_A3. */
const idOfA3 = (a3: string): number => WORLD.filter((f) => f.props.a3! !== 'ATA')
  .findIndex((f) => f.props.a3 === a3) + 1;

// ---------------------------------------------------------------------------
// loadCountries — the country-index assembly
// ---------------------------------------------------------------------------

interface RawProps { [k: string]: unknown }

let cacheDir: string;
let prevCache: string | undefined;

function writeSource(features: { properties: RawProps; rings?: Ring[] }[]): void {
  writeFileSync(join(cacheDir, 'ne_110m_admin_0_countries.json'), JSON.stringify({
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      properties: f.properties,
      geometry: { type: 'Polygon', coordinates: [f.rings?.[0] ?? rect(0, 0, 1, 1)] },
    })),
  }));
}

/** NAME_FIX asserts both of its keys are still in the source, so every valid
 *  fixture must carry them — that assertion is itself tested below. */
function props(a3: string, over: RawProps = {}): RawProps {
  return { ADM0_A3: a3, NAME: a3, ISO_A2: a3.slice(0, 2), ADM0_A3_IS: a3, ADM0_A3_UN: -99, ADM0_A3_US: a3, MAPCOLOR9: 3, ...over };
}
const RENAMED = [{ properties: props('MKD', { NAME: 'Macedonia' }) }, { properties: props('SWZ', { NAME: 'Swaziland' }) }];

beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'shardkeep-earth-mask-'));
  prevCache = process.env.EARTH_MASK_CACHE;
  process.env.EARTH_MASK_CACHE = cacheDir;
});

afterAll(() => {
  if (prevCache === undefined) delete process.env.EARTH_MASK_CACHE;
  else process.env.EARTH_MASK_CACHE = prevCache;
});

describe('loadCountries — a country id is a property of its code, not of the file', () => {
  it('sorts by ADM0_A3 so a source refresh cannot renumber a single tile', async () => {
    // Deliberately reverse-alphabetical in the file. Ids are ranks in the SORT,
    // and that is the whole reason a tile id like GEO-0042 is stable: a mirror
    // that reorders its features must not move anybody's country.
    writeSource([{ properties: props('ZWE') }, ...RENAMED, { properties: props('ALB') }]);
    const feats = await G.loadCountries('coarseCountries');
    expect(feats.map((f) => f.props.a3)).toEqual(['ALB', 'MKD', 'SWZ', 'ZWE']);
  });

  it("reads Natural Earth's −99 sentinel as absent rather than as a code", async () => {
    writeSource([...RENAMED, { properties: props('KOS', { ISO_A2: -99, ADM0_A3_IS: -99 }) }]);
    const kos = (await G.loadCountries('coarseCountries')).find((f) => f.props.a3 === 'KOS')!;
    expect(kos.props.iso2).toBe('');
    expect(kos.props.a3is).toBe('');
    // ADM0_A3_UN is −99 for every feature in this mirror, which is why the plan
    // records that a "UN point of view" is not available from this data.
    expect(kos.props.a3un).toBe('');
  });

  it('patches the two stale mirror names, and only those two', async () => {
    writeSource([...RENAMED, { properties: props('GEO', { NAME: 'Georgia' }) }]);
    const byA3 = new Map((await G.loadCountries('coarseCountries')).map((f) => [f.props.a3, f.props.name]));
    expect(byA3.get('MKD')).toBe('North Macedonia');
    expect(byA3.get('SWZ')).toBe('eSwatini');
    expect(byA3.get('GEO')).toBe('Georgia');
    expect(Object.keys(G.NAME_FIX)).toEqual(['MKD', 'SWZ']);
  });

  it('fails loudly when the mirror fixes a name upstream, instead of rotting', async () => {
    writeSource([{ properties: props('MKD', { NAME: 'North Macedonia' }) }]);
    await expect(G.loadCountries('coarseCountries')).rejects.toThrow(/NAME_FIX has an entry for SWZ/);
  });

  it('refuses a feature with no ADM0_A3 — there is no other stable id', async () => {
    writeSource([...RENAMED, { properties: props('XXX', { ADM0_A3: -99 }) }]);
    await expect(G.loadCountries('coarseCountries')).rejects.toThrow(/no ADM0_A3/);
  });

  it('refuses a duplicate ADM0_A3, because two countries would share a tile id', async () => {
    writeSource([...RENAMED, { properties: props('GEO') }, { properties: props('GEO', { NAME: 'other' }) }]);
    await expect(G.loadCountries('coarseCountries')).rejects.toThrow(/ADM0_A3 is not unique/);
  });

  it('refuses a MAPCOLOR9 outside 1..9 — the renderer keys its palette off it', async () => {
    for (const bad of [0, 10, -99, 'x']) {
      writeSource([...RENAMED, { properties: props('GEO', { MAPCOLOR9: bad }) }]);
      await expect(G.loadCountries('coarseCountries')).rejects.toThrow(/MAPCOLOR9/);
    }
  });

  it('refuses a source with no features at all', async () => {
    writeFileSync(join(cacheDir, 'ne_110m_admin_0_countries.json'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    await expect(G.loadCountries('coarseCountries')).rejects.toThrow(/no features/);
  });

  // The index is ONE BYTE per land cell and 0 is the no-sovereign sentinel, so
  // 255 features is the last count that can be represented. 10m NE has exactly
  // 255 — zero headroom — and the failure mode without this assert is a silent
  // wrap that hands one country's tiles to another.
  it('accepts exactly 255 features and refuses 256', async () => {
    const many = (n: number): { properties: RawProps }[] => Array.from({ length: n }, (_, i) => ({
      properties: props(`X${String(i).padStart(2, '0')}`),
    }));
    writeSource([...RENAMED, ...many(253)]);
    expect((await G.loadCountries('coarseCountries')).length).toBe(255);
    writeSource([...RENAMED, ...many(254)]);
    await expect(G.loadCountries('coarseCountries')).rejects.toThrow(/256 features > 255/);
  });
});

// ---------------------------------------------------------------------------
// rasterise — the shape the country index is indexed by
// ---------------------------------------------------------------------------

describe('rasterise — majority coverage, and the rank order everything else assumes', () => {
  const r = G.rasterise(WORLD, COLS, ROWS);

  it('is the 8-of-16 majority rule the header argues for', () => {
    expect(G.SUB).toBe(4);
    expect(G.COVER_MIN).toBe(8);
    // BIG's rectangle covers 8 whole cells; SOL's covers 1; ATA's covers 8. The
    // four sub-tile squares are each ≤1 of 16 samples, so none of them is land.
    expect(r.landCells).toBe(17);
    expect(r.cells.length).toBe(17);
    expect(r.winner.length).toBe(17);
  });

  it('emits land cells ASCENDING ROW-MAJOR — the contract `cells`-by-rank rests on', () => {
    // packages/shared/src/globe.ts `landCellList` produces this order, and the
    // country index is one byte per land cell IN IT. If the generator ever
    // emitted a different order, every tile would silently change country.
    for (let i = 1; i < r.cells.length; i++) expect(r.cells[i]!).toBeGreaterThan(r.cells[i - 1]!);
    expect([...r.cells]).toEqual([...r.cells].sort((a, b) => a - b));
  });

  it('agrees with the packed bitset it emits, cell for cell', () => {
    const set = new Set(r.cells);
    for (let cell = 0; cell < COLS * ROWS; cell++) {
      const bit = (r.bits[cell >> 3]! >> (cell & 7)) & 1;
      expect(bit === 1).toBe(set.has(cell));
    }
  });

  it('records where a sub-tile country POLLED but lost, land or not', () => {
    const fi = (a3: string): number => WORLD.findIndex((f) => f.props.a3 === a3);
    // TSE polls one sample in an ocean cell — that cell is where TSE is, and it
    // is the only reason a 431 km² country can be put on its own island.
    expect(r.polled.get(fi('TSE'))).toEqual([[cellOf(ixOf(TSE_AT.lon), iyOf(TSE_AT.lat)), 1]]);
    // MIN polls one sample inside a LAND cell that BIG won.
    expect(r.polled.get(fi('MIN'))).toEqual([[cellOf(ixOf(BIG_HOLE.lon), iyOf(BIG_HOLE.lat)), 1]]);
    // DOT is smaller than the sample pitch and polls nowhere at all.
    expect(r.polled.get(fi('DOT'))).toBeUndefined();
  });

  it('reports a cos-lat-weighted area fraction, not a raw cell count', () => {
    // "29% of Earth is land" is a cos-lat-weighted statement; an equirectangular
    // cell count over-weights the poles. earthMask.test.ts asserts the real mask
    // lands inside 25-33% on the WEIGHTED number, so the weighting has to be the
    // ratio it claims and not a cell count in disguise.
    const w = (cell: number): number => Math.cos(((90 - (Math.floor(cell / COLS) + 0.5) * (180 / ROWS)) * Math.PI) / 180);
    let landW = 0;
    let totalW = 0;
    for (let cell = 0; cell < COLS * ROWS; cell++) totalW += w(cell);
    for (const cell of r.cells) landW += w(cell);
    expect(r.areaFraction).toBeCloseTo(landW / totalW, 12);
    expect(r.cellFraction).toBeCloseTo(17 / (COLS * ROWS), 12);
    // This fixture's land is equator-heavy, so the two numbers genuinely differ —
    // which is the asymmetry that makes reporting both worth the two lines.
    expect(r.areaFraction).toBeGreaterThan(r.cellFraction);
  });
});

// ---------------------------------------------------------------------------
// assignCountries — the drop, and the grant/extra split
// ---------------------------------------------------------------------------

describe('assignCountries — Antarctica drops, and every other country gets a tile', () => {
  const r = G.rasterise(WORLD, COLS, ROWS);
  const a = G.assignCountries(WORLD, r);

  it('drops only ATA, and drops it from the TABLE rather than from the mask', () => {
    expect([...G.NO_SOVEREIGN]).toEqual(['ATA']);
    expect(a.dropped).toEqual(['ATA']);
    expect(a.table.map((f) => f.props.a3)).toEqual(['BIG', 'DOT', 'MIN', 'SO2', 'SOL', 'TSE']);
    // The 8 Antarctic cells are STILL LAND in the mask — removing them would
    // renumber landSites() and physically relocate every existing valley — they
    // simply carry the 0 sentinel, i.e. "not claimable Earth".
    expect(r.landCells).toBe(17);
    expect(a.droppedCells).toBe(8);
    expect([...a.index].filter((v) => v === 0).length).toBe(8);
  });

  it('makes the sentinel EXACT in both directions', () => {
    // A cell is countryless IFF the feature that won it was dropped. Any other
    // zero would be a cell that fell through the vote pass, hiding inside "some
    // cells have no country".
    for (let rank = 0; rank < r.cells.length; rank++) {
      const droppedWinner = G.NO_SOVEREIGN.has(WORLD[r.winner[rank]!]!.props.a3!);
      expect(a.index[rank] === 0).toBe(droppedWinner);
    }
  });

  it('gives every kept country at least one tile, so none is absent from Earth', () => {
    const seen = new Set<number>(a.index);
    for (const e of a.extra) seen.add(e.id);
    for (let id = 1; id <= a.table.length; id++) expect(seen.has(id)).toBe(true);
  });

  it('puts a sub-tile country whose own cell is OCEAN in extraCells, taking nothing', () => {
    const tse = a.grants.find((g) => g.a3 === 'TSE')!;
    expect(tse.how).toBe('own');
    expect(tse.from).toBe('');
    expect(tse.cell).toBe(cellOf(ixOf(TSE_AT.lon), iyOf(TSE_AT.lat)));
    expect(a.extra).toContainEqual({ cell: tse.cell, id: idOfA3('TSE') });
    // An extra is NOT a land cell — that is the definition — so claimable Earth
    // is "land cells with a country" ∪ extraCells and nothing else.
    expect([...r.cells]).not.toContain(tse.cell);
  });

  it('TRANSFERS a land cell when the sub-tile country really is inside it', () => {
    const min = a.grants.find((g) => g.a3 === 'MIN')!;
    const cell = cellOf(ixOf(BIG_HOLE.lon), iyOf(BIG_HOLE.lat));
    expect(min).toMatchObject({ how: 'own', from: 'BIG', cell });
    // The transfer is recorded in the index, not in extraCells.
    const rank = [...r.cells].indexOf(cell);
    expect(a.index[rank]).toBe(idOfA3('MIN'));
    expect(a.extra.map((e) => e.cell)).not.toContain(cell);
    // BIG keeps the other 7 of its 8 cells.
    expect([...a.index].filter((v) => v === idOfA3('BIG')).length).toBe(7);
  });

  it('never takes a victim\'s LAST cell — nobody leaves Earth so somebody can join', () => {
    const so2 = a.grants.find((g) => g.a3 === 'SO2')!;
    const solCell = cellOf(ixOf(SOL_HOLE.lon), iyOf(SOL_HOLE.lat));
    expect(so2.how).toBe('shared');
    expect(so2.cell).not.toBe(solCell);
    expect(so2.from).toBe('');
    // SOL still owns the one cell it had.
    expect([...a.index].filter((v) => v === idOfA3('SOL')).length).toBe(1);
    expect(a.index[[...r.cells].indexOf(solCell)]).toBe(idOfA3('SOL'));
  });

  it('anchors a country too small to be SAMPLED on its largest landmass', () => {
    const dot = a.grants.find((g) => g.a3 === 'DOT')!;
    expect(dot.how).toBe('anchor');
    expect(dot.cell).toBe(cellOf(ixOf(DOT_AT.lon), iyOf(DOT_AT.lat)));
    // …which is the cell holding the centroid of its largest ring, and NOT the
    // nearest land cell — that distinction is what stopped Barbados' tile from
    // being placed inside Venezuela.
    const at = G.largestLandmassDeg(WORLD.find((f) => f.props.a3 === 'DOT')!);
    expect(at.lon).toBeCloseTo(DOT_AT.lon, 6);
    expect(at.lat).toBeCloseTo(DOT_AT.lat, 6);
  });

  it('grants one cell per sub-tile country, all distinct, extras sorted ascending', () => {
    expect(a.grants.map((g) => g.a3)).toEqual(['DOT', 'MIN', 'SO2', 'TSE']);
    expect(new Set(a.grants.map((g) => g.cell)).size).toBe(4);
    // 3 of the 4 grants are cells the mask calls ocean.
    expect(a.extra.map((e) => e.cell)).toEqual([...a.extra.map((e) => e.cell)].sort((p, q) => p - q));
    expect(a.extra.length).toBe(3);
    for (const e of a.extra) expect(e.id).not.toBe(0);
  });

  it('is deterministic: the same features and raster give byte-identical output', () => {
    const b = G.assignCountries(WORLD, G.rasterise(WORLD, COLS, ROWS));
    expect([...b.index]).toEqual([...a.index]);
    expect(b.extra).toEqual(a.extra);
    expect(b.grants).toEqual(a.grants);
  });

  it('refuses to ship a country it cannot place anywhere', () => {
    // One cell of land in the whole world, owned by a country with exactly that
    // one cell, and a grid with nowhere else to spiral to: the grant pass must
    // throw rather than leave a country off the planet or steal the last cell.
    const one = [
      feature('AAA', [rect(-180, -90, 180, 90)]),
      feature('BBB', [rect(-179.9, -89.9, -179.8, -89.8)]),
    ];
    const tiny = G.rasterise(one, 1, 1);
    expect(tiny.landCells).toBe(1);
    expect(() => G.assignCountries(one, tiny)).toThrow(/cannot be given a tile/);
  });
});

// ---------------------------------------------------------------------------
// The byte-identity gate (EARTH-TILES R21)
// ---------------------------------------------------------------------------

describe('the byte-identity gate — the property it compares, and its sensitivity', () => {
  /** Exactly the comparison `main()` makes between the two rasters. */
  const gate = (land: Raster, countries: Raster): { diff: number; sameCells: boolean } => {
    let diff = 0;
    for (let i = 0; i < land.bits.length; i++) if (land.bits[i] !== countries.bits[i]) diff++;
    return { diff, sameCells: countries.landCells === land.landCells };
  };
  /** How `loadLand` builds a land layer: every ring, as ONE feature. */
  const asLand = (feats: readonly Feature[]): Feature[] => [{ props: {}, rings: feats.flatMap((f) => f.rings) }];

  it('holds for the same geometry read as one union or as N countries', () => {
    // This is the load-bearing claim of §3.2: per-feature parity over disjoint
    // admin_0 rings is the same Earth as global even-odd parity over their union,
    // so switching the country layer in changes no checked-in mask bit — and
    // therefore relocates no valley.
    const land = G.rasterise(asLand(WORLD), COLS, ROWS);
    const countries = G.rasterise(WORLD, COLS, ROWS);
    expect(gate(land, countries)).toEqual({ diff: 0, sameCells: true });
    expect([...land.bits]).toEqual([...countries.bits]);
  });

  it('fires on BOTH of its conditions when the two layers are different Earths', () => {
    // Drop a country and the union loses its cells: the gate must see a non-zero
    // byte diff AND a land-cell mismatch. A gate that only ever returns 0 is
    // indistinguishable from no gate at all, which is what this pins.
    const short = WORLD.filter((f) => f.props.a3 !== 'SOL');
    const g = gate(G.rasterise(asLand(WORLD), COLS, ROWS), G.rasterise(short, COLS, ROWS));
    expect(g.diff).toBeGreaterThan(0);
    expect(g.sameCells).toBe(false);
  });

  it('catches a one-cell disagreement — the 0.55% countryless case it exists for', () => {
    // Mismatched resolutions leave a fraction of a percent of cells countryless;
    // the gate has to notice a SINGLE cell, not just a continent.
    const grown = WORLD.map((f) => (f.props.a3 === 'SOL' ? feature('SOL', [rect(100, 30, 120, 40), pinhole(SOL_HOLE, 0.25)]) : f));
    const g = gate(G.rasterise(asLand(WORLD), COLS, ROWS), G.rasterise(grown, COLS, ROWS));
    expect(g.diff).toBe(1);
    expect(g.sameCells).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The geometry helpers the grant pass depends on
// ---------------------------------------------------------------------------

describe('ring geometry', () => {
  it('measures a ring signed, so winding order cannot change which ring is largest', () => {
    // `largestLandmassDeg` compares |area|; Natural Earth ships outer rings and
    // holes in opposite windings, so an unsigned or sign-sensitive comparison
    // would anchor a country on a hole.
    expect(G.ringArea(rect(0, 0, 2, 3))).toBeCloseTo(6, 9);
    expect(G.ringArea([...rect(0, 0, 2, 3)].reverse())).toBeCloseTo(-6, 9);
  });

  it('anchors on the LARGEST ring, not the first or the last', () => {
    const f = feature('X', [rect(0, 0, 1, 1), rect(20, 20, 30, 30), rect(-5, -5, -4, -4)]);
    const at = G.largestLandmassDeg(f);
    expect(at.lon).toBeCloseTo(25, 6);
    expect(at.lat).toBeCloseTo(25, 6);
  });

  it('still places a degenerate ring rather than dividing by zero', () => {
    // Collinear vertices give a zero-area ring; a country must still have a place.
    const at = G.largestLandmassDeg(feature('X', [[[10, 10], [12, 10], [14, 10], [10, 10]]]));
    expect(at.lat).toBeCloseTo(10, 9);
    expect(at.lon).toBeGreaterThan(9);
    expect(at.lon).toBeLessThan(15);
  });

  it('refuses a feature with no rings instead of inventing a location', () => {
    expect(() => G.largestLandmassDeg(feature('X', []))).toThrow(/no rings/);
  });
});
