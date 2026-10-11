/**
 * SHARDKEEP — earth land-mask + country generator (docs/WORLDMAP-GLOBE-PLAN.md
 * §1.1, docs/EARTH-TILES-PLAN.md §3).
 *
 * Rasterises Natural Earth vectors into equirectangular tables and writes them as
 * CHECKED-IN generated TypeScript modules in `packages/shared/src/`:
 *
 *   EARTH_COARSE          180×90 (2°)    → src/earthMask.ts        (eager: globe band + LAND_SITES)
 *   EARTH_FINE            720×360 (0.5°) → src/earthMaskFine.ts    (dynamic import() only — see the
 *                                          first-paint JS budget note in the plan's risk register)
 *   EARTH_COUNTRIES       180×90 (2°)    → src/earthCountries.ts     (eager: one byte per coarse land cell)
 *   EARTH_COUNTRIES_FINE  720×360 (0.5°) → src/earthCountriesFine.ts (dynamic import() only)
 *
 * Zero npm dependencies by design: the globe's whole reason for existing on a
 * CPU raster is that the measured first-paint budget (995 / 1000 KB gzip,
 * re-measured 2026-08-10) cannot afford three.js or d3-geo. This generator uses
 * only `fetch` + `node:zlib`.
 *
 * SOURCE DATA
 *   Natural Earth 1:110m and 1:50m "land" (physical) and "admin_0_countries"
 *   (cultural) vector layers, in the GeoJSON conversion published by
 *   martynafford/natural-earth-geojson:
 *     https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json
 *     https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/physical/ne_50m_land.json
 *     https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/cultural/ne_110m_admin_0_countries.json
 *     https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/cultural/ne_50m_admin_0_countries.json
 *   LICENSE: Natural Earth raster + vector map data is in the PUBLIC DOMAIN
 *   (no permission needed, no attribution required — https://www.naturalearthdata.com/about/terms-of-use/).
 *   The GeoJSON conversion is published under CC0-1.0.
 *   Natural Earth's own disclaimer, which the game credits line must carry
 *   verbatim: "Natural Earth Vector draws boundaries of countries according to
 *   de facto status." The generator NEVER hand-edits geometry (see WHY THE
 *   COUNTRY LAYER IS THE SAME RASTER, rule 5).
 *
 * GENERATION COMMAND
 *   pnpm --filter @shardkeep/scripts earth:mask
 *   (offline: set EARTH_MASK_CACHE=/some/dir holding the four files above)
 *
 * WHY SUBSAMPLED MAJORITY COVERAGE AND NOT A CENTRE SAMPLE. A single centre
 * sample per cell makes every coastline a coin-flip and drops narrow land
 * (Japan, the UK, Central America) at 2°. Each cell is instead sampled on a
 * SUB×SUB grid and counted as land when at least HALF the samples fall inside a
 * land polygon — "mostly land is land", which needs no tuning to justify.
 * Measured, it also happens to be the honest threshold: it reproduces Earth's
 * real cos-lat-weighted land fraction to within 0.1 pt (29.1% coarse / 28.9%
 * fine vs. 29.2% actual) while keeping every coastal sanity point in
 * `earthMask.test.ts` on land. Both facts are asserted by that test, not
 * eyeballed. For the record, at SUB=4 the alternatives measured:
 *   ≥1/16 → 34.3% (coastline inflation)   ≥8/16 → 29.1% (chosen)
 *   ≥11/16 → 27.3% and London falls into the sea.
 *
 * Polygons are filled with a GLOBAL even-odd scanline: Natural Earth land
 * polygons are disjoint and holes (the Caspian, Great Lakes) are nested inside
 * their outer ring, so one crossing-parity pass over every ring is both correct
 * and O(edges) per sample row.
 *
 * WHY THE COUNTRY LAYER IS THE SAME RASTER, NOT A SECOND ONE.
 *   1. The 16 subsample votes that decide IS-LAND are the votes that decide
 *      WHICH COUNTRY, at zero extra cost. A cell straddling a border is resolved
 *      by the same "mostly X is X" majority the land rule already argues for, so
 *      there is no second rule to justify or tune. Nearest-centroid is rejected:
 *      a centroid is not on the border, so it mis-assigns exclaves such as
 *      Kaliningrad and needs a whole extra table.
 *   2. Ties resolve to the LOWEST feature index with a strict `>`, so the pass is
 *      total and deterministic. (Measured: the admin_0 polygons are genuinely
 *      disjoint — at most one feature's parity is ever odd at a sample point —
 *      so the tiebreak is dead code kept only to make the pass total.)
 *   3. BYTE-IDENTITY IS ENFORCED, NOT ASSUMED (EARTH-TILES-PLAN R21). The union
 *      of the admin_0 rings must rasterise to EXACTLY the checked-in physical
 *      land mask at the same resolution, and this generator throws if it does
 *      not. That is what makes "every land cell has a country" true BY
 *      CONSTRUCTION rather than nearly true: mask and index are the same 8-of-16
 *      cover count over one parse of one file. Keeping a 110m-land mask while
 *      indexing from 50m-countries would leave ~0.55% of coarse cells
 *      countryless — hence the same-resolution pairing below, and hence the
 *      land masks are still generated from `physical/land` and left untouched,
 *      with equality PROVEN on every run instead of the source being swapped.
 *   4. Country ids are 1-based ranks in a sort by `ADM0_A3` (unique at both
 *      resolutions, asserted). NEVER file order (a data refresh would silently
 *      renumber every tile) and NEVER `ISO_A2` (4 of 177 / 7 of 241 features
 *      carry '-99'). 0 is the sentinel for ground with no sovereign.
 *   5. NO GEOMETRY IS EVER EDITED and no flags are emitted. `NAME` ships
 *      verbatim, alongside `ADM0_A3_IS/UN/US` so a future "UN point of view"
 *      switch is one constant and not a regeneration. The two stale mirror names
 *      (Macedonia, Swaziland) are patched by the documented 2-entry NAME_FIX
 *      table below — the only text this generator overrides, and it renames
 *      nothing on the map that Natural Earth 5.1.1 does not already rename.
 *
 * WHAT IS DELIBERATELY NOT CLAIMABLE EARTH. Antarctica (`ADM0_A3 = 'ATA'`) is
 * 28.2% of 0.5° land cells and Natural Earth assigns it NO sovereign of its own
 * ("Multiple claims held in abeyance"), so any country label there would be
 * something this studio invented. Owner decision 2026-08-10 (Q4): drop it. It is
 * dropped HERE, in the generator, as a country-table exclusion — its cells carry
 * the 0 sentinel — and NOT from the land masks, because the masks are the globe's
 * silhouette and the site lattice: removing cells from `EARTH_COARSE` would
 * renumber `landSites()` and physically relocate every valley that already
 * exists. "No country ⇒ not claimable" is therefore one lookup, and "every
 * CLAIMABLE cell has a country" is unconditionally true.
 *
 * SUB-TILE COUNTRIES (owner decision 2026-08-10, Q4b). A country smaller than one
 * cell wins no cell on votes alone, and a country that is simply absent from
 * Earth is a bug the player sees. Each such feature is therefore granted EXACTLY
 * ONE cell, deterministically: the land cell where it polled highest but lost,
 * else — for countries too small to be sampled at all, like Vatican City — the
 * nearest land cell to the centroid of its largest ring. Ties and collisions are
 * broken by `ADM0_A3` order, and a grant never takes a victim's LAST cell. The
 * generator then asserts that every non-dropped feature owns at least one cell,
 * so a country silently missing from Earth cannot ship.
 */
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_SRC = join(HERE, '..', '..', 'packages', 'shared', 'src');

const SOURCES = {
  coarse: {
    file: 'ne_110m_land.json',
    url: 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/physical/ne_110m_land.json',
  },
  fine: {
    file: 'ne_50m_land.json',
    url: 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/physical/ne_50m_land.json',
  },
  coarseCountries: {
    file: 'ne_110m_admin_0_countries.json',
    url: 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/110m/cultural/ne_110m_admin_0_countries.json',
  },
  fineCountries: {
    file: 'ne_50m_admin_0_countries.json',
    url: 'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/50m/cultural/ne_50m_admin_0_countries.json',
  },
} as const;

/** Subsamples per cell axis. 4 → 16 samples per cell. */
const SUB = 4;
/** Majority rule: a cell is land when at least half its samples are. See header. */
const COVER_MIN = (SUB * SUB) / 2;

/** `ADM0_A3` of ground that is NOT claimable Earth and gets no country id. See header. */
const NO_SOVEREIGN = new Set(['ATA']);

/**
 * The mirror's GeoJSON predates Natural Earth 5.1.1's renames. Keyed on ADM0_A3
 * so it cannot accidentally match a different feature, and asserted to still hit
 * something (a mirror refresh that fixes the names upstream must make this table
 * fail loudly rather than rot).
 */
const NAME_FIX: Record<string, string> = { MKD: 'North Macedonia', SWZ: 'eSwatini' };

type Ring = number[][];

/**
 * One admin_0 feature: its Natural Earth properties and every ring of every
 * polygon, flattened. The land layers are loaded as a SINGLE synthetic feature
 * holding all rings, which makes per-feature parity mathematically identical to
 * the global even-odd parity the land mask has always used — that is what lets
 * one rasteriser serve both jobs with no risk to the checked-in bits.
 */
interface Feature {
  props: Record<string, string>;
  rings: Ring[];
}

async function readSource(which: keyof typeof SOURCES): Promise<unknown> {
  const { file, url } = SOURCES[which];
  const cache = process.env.EARTH_MASK_CACHE;
  if (cache) return JSON.parse(readFileSync(join(cache, file), 'utf8'));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

interface RawFeature {
  properties?: Record<string, unknown>;
  geometry?: { type: string; coordinates: unknown };
}

function ringsOf(f: RawFeature): Ring[] {
  const g = f.geometry;
  if (!g) return [];
  const polys = g.type === 'Polygon' ? [g.coordinates as Ring[]] : (g.coordinates as Ring[][]);
  const out: Ring[] = [];
  for (const poly of polys) for (const ring of poly) out.push(ring);
  return out;
}

function featuresOf(raw: unknown, file: string): RawFeature[] {
  const fc = raw as { features?: RawFeature[] };
  if (!fc.features?.length) throw new Error(`${file}: no features`);
  return fc.features;
}

/** The land layers: every ring of every feature, as ONE feature (global parity). */
async function loadLand(which: 'coarse' | 'fine'): Promise<Feature[]> {
  const raw = await readSource(which);
  const rings: Ring[] = [];
  for (const f of featuresOf(raw, SOURCES[which].file)) rings.push(...ringsOf(f));
  return [{ props: {}, rings }];
}

/** A string property, '' when Natural Earth's "missing" sentinel −99 is present. */
function str(props: Record<string, unknown>, key: string): string {
  const v = props[key];
  const s = v == null ? '' : String(v);
  return s === '-99' ? '' : s;
}

/**
 * The admin_0 layers: one Feature per country, SORTED BY `ADM0_A3` so the id of a
 * country is a property of its code and not of the file's row order.
 */
async function loadCountries(which: 'coarseCountries' | 'fineCountries'): Promise<Feature[]> {
  const file = SOURCES[which].file;
  const out: Feature[] = [];
  for (const f of featuresOf(await readSource(which), file)) {
    const props = f.properties ?? {};
    const a3 = str(props, 'ADM0_A3');
    if (!a3) throw new Error(`${file}: a feature has no ADM0_A3, which is the only stable id`);
    const color = Number(props.MAPCOLOR9);
    if (!Number.isInteger(color) || color < 1 || color > 9) {
      throw new Error(`${file}: ${a3} has MAPCOLOR9=${String(props.MAPCOLOR9)}, expected 1..9`);
    }
    out.push({
      props: {
        a3,
        name: NAME_FIX[a3] ?? str(props, 'NAME'),
        iso2: str(props, 'ISO_A2'),
        a3is: str(props, 'ADM0_A3_IS'),
        a3un: str(props, 'ADM0_A3_UN'),
        a3us: str(props, 'ADM0_A3_US'),
        color: String(color),
      },
      rings: ringsOf(f),
    });
  }
  for (const a3 of Object.keys(NAME_FIX)) {
    if (!out.some((f) => f.props.a3 === a3)) {
      throw new Error(`${file}: NAME_FIX has an entry for ${a3}, which is not in the source any more`);
    }
  }
  out.sort((a, b) => (a.props.a3! < b.props.a3! ? -1 : a.props.a3! > b.props.a3! ? 1 : 0));
  const codes = new Set(out.map((f) => f.props.a3!));
  if (codes.size !== out.length) throw new Error(`${file}: ADM0_A3 is not unique, so it cannot be the id`);
  // 0 is the sentinel, so N features need ids 1..N inside a Uint8Array.
  if (out.length > 255) throw new Error(`${file}: ${out.length} features > 255 — the index byte would wrap`);
  return out;
}

/** Edges bucketed by whole-degree latitude band so a sample row touches ~1% of them. */
interface EdgeIndex {
  /** band index 0..179 (lat −90 + band) → flat [x1,y1,x2,y2,featIdx, …] */
  bands: number[][];
}

function indexEdges(feats: readonly Feature[]): EdgeIndex {
  const bands: number[][] = Array.from({ length: 180 }, () => []);
  for (let fi = 0; fi < feats.length; fi++) {
    for (const ring of feats[fi]!.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const y1 = a[1]!;
        const y2 = b[1]!;
        if (y1 === y2) continue; // horizontal edges never produce a crossing
        const lo = Math.min(y1, y2);
        const hi = Math.max(y1, y2);
        const b0 = Math.max(0, Math.min(179, Math.floor(lo + 90)));
        const b1 = Math.max(0, Math.min(179, Math.floor(hi + 90)));
        for (let bi = b0; bi <= b1; bi++) bands[bi]!.push(a[0]!, y1, b[0]!, y2, fi);
      }
    }
  }
  return { bands };
}

/**
 * Longitudes where a boundary crosses `lat`, ascending, with the feature each
 * crossing belongs to in the parallel `feat` array. The multiset of longitudes is
 * exactly what the land pass has always consumed, so carrying the feature index
 * alongside cannot change a single mask bit.
 */
function crossingsAt(idx: EdgeIndex, lat: number, out: number[], feat: number[]): void {
  const band = idx.bands[Math.max(0, Math.min(179, Math.floor(lat + 90)))]!;
  const lon: number[] = [];
  const fs: number[] = [];
  for (let i = 0; i < band.length; i += 5) {
    const x1 = band[i]!;
    const y1 = band[i + 1]!;
    const x2 = band[i + 2]!;
    const y2 = band[i + 3]!;
    // Half-open rule: counts each vertex exactly once, so a vertex exactly on
    // the sample row cannot produce a double crossing and invert a whole span.
    if (y1 <= lat === y2 <= lat) continue;
    lon.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
    fs.push(band[i + 4]!);
  }
  const order = lon.map((_, i) => i).sort((p, q) => lon[p]! - lon[q]!);
  out.length = 0;
  feat.length = 0;
  for (const i of order) {
    out.push(lon[i]!);
    feat.push(fs[i]!);
  }
}

interface Raster {
  cols: number;
  rows: number;
  /** Packed bitset, bit `iy*cols + ix`, LSB-first. Row 0 = north. */
  bits: Uint8Array;
  landCells: number;
  /** cos(lat)-weighted land fraction — the physically meaningful "29% of Earth". */
  areaFraction: number;
  /** Raw land-cells / total-cells. Equirect over-weights the poles; reported for context. */
  cellFraction: number;
  /**
   * Per LAND cell, in ascending row-major order (the order `landCellList` in
   * packages/shared/src/globe.ts produces), the feature that won its 16 votes.
   * Always 0 for the single-feature land jobs; the country jobs read it.
   */
  winner: Int32Array;
  /** Land cells, ascending row-major — `winner[i]` is the winner of `cells[i]`. */
  cells: Int32Array;
  /**
   * For each feature, every cell where it polled at all — LAND OR NOT — as
   * `[cell, votes]` pairs, minus the cells it outright won. This is what puts a
   * sub-tile country's single tile ON that country: Barbados is 431 km² against a
   * ~3,090 km² cell, so its own cell polls 2/16 and is therefore OCEAN in the
   * mask, yet it is unambiguously the cell where Barbados is. Only consulted for
   * features that won no cell at all.
   */
  polled: Map<number, [number, number][]>;
}

function rasterise(feats: readonly Feature[], cols: number, rows: number): Raster {
  const nFeat = feats.length;
  const idx = indexEdges(feats);
  const bits = new Uint8Array(Math.ceil((cols * rows) / 8));
  const dLon = 360 / cols;
  const dLat = 180 / rows;
  // Per sample row: parity spans, then SUB samples per cell reading those spans.
  const cover = new Uint8Array(cols);
  // Votes for this row only: votes[ix * nFeat + fi]. At most SUB*SUB = 16 per cell.
  const votes = new Uint8Array(cols * nFeat);
  // Parity per feature at the current sample point, plus the (measured: ≤1-long)
  // list of features currently odd, so "am I inside anything, and inside the
  // lowest-indexed what" is O(active) rather than O(features).
  const par = new Uint8Array(nFeat);
  const active: number[] = [];
  const xs: number[] = [];
  const xf: number[] = [];
  const cellList: number[] = [];
  const winners: number[] = [];
  const polled = new Map<number, [number, number][]>();
  let landCells = 0;
  let landW = 0;
  let totalW = 0;
  for (let iy = 0; iy < rows; iy++) {
    cover.fill(0);
    votes.fill(0);
    const latTop = 90 - iy * dLat;
    for (let sy = 0; sy < SUB; sy++) {
      const lat = latTop - ((sy + 0.5) / SUB) * dLat;
      crossingsAt(idx, lat, xs, xf);
      if (xs.length < 2) continue;
      par.fill(0);
      active.length = 0;
      let k = 0; // index of the next crossing at or after the current sample lon
      for (let ix = 0; ix < cols; ix++) {
        for (let sx = 0; sx < SUB; sx++) {
          const lon = -180 + (ix + (sx + 0.5) / SUB) * dLon;
          while (k < xs.length && xs[k]! <= lon) {
            const fi = xf[k]!;
            if (par[fi] === 1) {
              par[fi] = 0;
              active.splice(active.indexOf(fi), 1);
            } else {
              par[fi] = 1;
              active.push(fi);
            }
            k++;
          }
          if (active.length === 0) continue;
          cover[ix] = cover[ix]! + 1;
          // Lowest index wins a genuine overlap, so the pass is total and
          // deterministic. Measured: `active.length` never exceeds 1.
          let lo = active[0]!;
          for (let a = 1; a < active.length; a++) if (active[a]! < lo) lo = active[a]!;
          votes[ix * nFeat + lo] = votes[ix * nFeat + lo]! + 1;
        }
      }
    }
    const latMid = latTop - dLat / 2;
    const w = Math.cos((latMid * Math.PI) / 180);
    for (let ix = 0; ix < cols; ix++) {
      totalW += w;
      const cell = iy * cols + ix;
      const isLand = cover[ix]! >= COVER_MIN;
      // argmax with a STRICT `>` so a tie keeps the lowest feature index.
      const base = ix * nFeat;
      let best = 0;
      let bestV = votes[base]!;
      for (let fi = 1; fi < nFeat; fi++) {
        const v = votes[base + fi]!;
        if (v > bestV) {
          bestV = v;
          best = fi;
        }
      }
      if (isLand) {
        bits[cell >> 3]! |= 1 << (cell & 7);
        landCells++;
        landW += w;
        cellList.push(cell);
        winners.push(best);
      }
      if (nFeat > 1) {
        for (let fi = 0; fi < nFeat; fi++) {
          const v = votes[base + fi]!;
          if (v === 0 || (isLand && fi === best)) continue;
          const list = polled.get(fi);
          if (list) list.push([cell, v]);
          else polled.set(fi, [[cell, v]]);
        }
      }
    }
  }
  return {
    cols,
    rows,
    bits,
    landCells,
    areaFraction: landW / totalW,
    cellFraction: landCells / (cols * rows),
    winner: Int32Array.from(winners),
    cells: Int32Array.from(cellList),
    polled,
  };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Emitted verbatim into every generated module. Shared so the mask files and the
 * country files cannot drift into two subtly different decoders.
 */
const UNPACK_BLOCK = `// Base64 decoded by hand rather than with atob/Buffer: this module is imported
// by the browser bundle, the Fastify server AND vitest, and \`atob\` is a global
// that packages/shared does not declare in its \`lib\`. 12 lines removes the
// environment assumption entirely.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function unpack(s: string): Uint8Array {
  const pad = s.indexOf('=');
  const n = pad < 0 ? s.length : pad;
  const out = new Uint8Array((n * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}`;

/** The base64 payload, wrapped as a 96-char-per-line TS string concatenation. */
function packedLiteral(bytes: Uint8Array): { b64: string; literal: string } {
  const b64 = base64(bytes);
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += 96) chunks.push(`  '${b64.slice(i, i + 96)}'`);
  return { b64, literal: chunks.join(' +\n') };
}

function emit(
  name: string,
  r: Raster,
  source: (typeof SOURCES)[keyof typeof SOURCES],
  eager: boolean,
): { ts: string; b64: string } {
  const { b64, literal } = packedLiteral(r.bits);
  const ts = `/**
 * GENERATED FILE — DO NOT EDIT. Regenerate with:
 *   pnpm --filter @shardkeep/scripts earth:mask
 * Generator: scripts/src/earth-mask.ts (records the full method + rationale).
 *
 * ${name}: equirectangular land bitmask, ${r.cols}×${r.rows} (${(360 / r.cols).toFixed(2)}°).
 * Row 0 = north (lat +90), column 0 starts at lon −180. Bit ${'`'}iy*cols + ix${'`'}, LSB-first.
 * ${r.landCells} land cells of ${r.cols * r.rows}; cos-lat-weighted land fraction ${(r.areaFraction * 100).toFixed(1)}%
 * (raw cell fraction ${(r.cellFraction * 100).toFixed(1)}% — equirect over-weights the poles).
 *
 * SOURCE: ${source.url}
 * LICENSE: Natural Earth vector data is PUBLIC DOMAIN
 * (https://www.naturalearthdata.com/about/terms-of-use/); the GeoJSON
 * conversion is CC0-1.0. No attribution required; recorded here anyway.
 *
 * ${
   eager
     ? 'LOADED EAGERLY, BUT NOT FROM index.ts. siteOf()/landSites() need this mask, so\n * it is a static import inside globe.ts rather than a dynamic one — but it is\n * reached ONLY at the subpath \'@shardkeep/shared/earthMask\' and is deliberately\n * absent from the barrel, because packages/sim imports the barrel and an\n * `export *` would put this base64 decode inside the deterministic replay graph\n * (index.ts\'s header states the rule; earthMask.test.ts and\n * packages/sim/tests/import-graph.test.ts assert both halves).'
     : 'NOT EXPORTED FROM index.ts. Reach it with await import(\'@shardkeep/shared/earthMaskFine\')\n * ONLY, so it lands in its own chunk and never enters the first-paint JS graph\n * (docs/WORLDMAP-GLOBE-PLAN.md: 995 / 1000 KB gzip measured, build fails at 1001).'
 }
 */
import type { LandMask } from './globe';

const PACKED =
${literal};

${UNPACK_BLOCK}

export const ${name}: LandMask = {
  cols: ${r.cols},
  rows: ${r.rows},
  bits: unpack(PACKED),
  landCells: ${r.landCells},
};
`;
  return { ts, b64 };
}

// ---------------------------------------------------------------------------
// Country assignment: the drop, then the sub-tile grants
// ---------------------------------------------------------------------------

/** Shoelace area of a ring in degree², signed. Magnitude is all we compare. */
function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0]! * q[1]! - q[0]! * p[1]!;
  }
  return a / 2;
}

/** Centroid of a feature's LARGEST ring — "its largest landmass", in degrees. */
function largestLandmassDeg(f: Feature): { lon: number; lat: number } {
  let best: Ring | null = null;
  let bestA = -1;
  for (const ring of f.rings) {
    const a = Math.abs(ringArea(ring));
    if (a > bestA) {
      bestA = a;
      best = ring;
    }
  }
  if (!best?.length) throw new Error(`${f.props.a3}: no rings, so it has no landmass to anchor to`);
  const a2 = ringArea(best) * 6;
  if (a2 !== 0) {
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < best.length; i++) {
      const p = best[i]!;
      const q = best[(i + 1) % best.length]!;
      const cross = p[0]! * q[1]! - q[0]! * p[1]!;
      cx += (p[0]! + q[0]!) * cross;
      cy += (p[1]! + q[1]!) * cross;
    }
    return { lon: cx / a2, lat: cy / a2 };
  }
  // A degenerate ring (all vertices collinear at this precision) still has a place.
  let sx = 0;
  let sy = 0;
  for (const p of best) {
    sx += p[0]!;
    sy += p[1]!;
  }
  return { lon: sx / best.length, lat: sy / best.length };
}

interface Grant {
  a3: string;
  name: string;
  /** The granted cell, `iy * cols + ix`. */
  cell: number;
  /** How the cell was chosen. */
  how:
    /** The cell where it polls highest — i.e. where the country actually is. */
    | 'own'
    /** It polls nowhere (too small for a 14 km sample pitch): the cell containing
     *  the centroid of its largest ring. */
    | 'anchor'
    /** Its own cell was already granted to another sub-tile country sharing the
     *  island (St-Martin / Sint Maarten), so it took the nearest free cell. */
    | 'shared';
  /** ADM0_A3 the cell was taken from, or '' when the mask sees the cell as ocean
   *  and the tile is an EXTRA rather than a transfer. */
  from: string;
}

interface Assigned {
  /** One byte per land cell, in `Raster.cells` order. 0 = no sovereign. */
  index: Uint8Array;
  /** id 1..N, ADM0_A3 order over KEPT features; `table[id - 1]`. */
  table: Feature[];
  /** Claimable cells the LAND MASK DOES NOT CONTAIN, ascending by cell: the tile
   *  of a country the 0.5° majority rule is too coarse to see. */
  extra: { cell: number; id: number }[];
  grants: Grant[];
  dropped: string[];
  droppedCells: number;
}

function assignCountries(feats: readonly Feature[], r: Raster): Assigned {
  const table: Feature[] = [];
  const idOf = new Int32Array(feats.length); // 0 = dropped / no sovereign
  const dropped: string[] = [];
  for (let fi = 0; fi < feats.length; fi++) {
    const a3 = feats[fi]!.props.a3!;
    if (NO_SOVEREIGN.has(a3)) {
      dropped.push(a3);
      continue;
    }
    table.push(feats[fi]!);
    idOf[fi] = table.length;
  }

  const n = r.cells.length;
  const index = new Uint8Array(n);
  const owned = new Int32Array(feats.length);
  for (let rank = 0; rank < n; rank++) {
    const fi = r.winner[rank]!;
    index[rank] = idOf[fi]!;
    owned[fi] = owned[fi]! + 1;
  }
  const rankOfCell = new Map<number, number>();
  for (let rank = 0; rank < n; rank++) rankOfCell.set(r.cells[rank]!, rank);
  const ownerFeat = Int32Array.from(r.winner);
  const grants: Grant[] = [];
  const extraOf = new Map<number, number>(); // cell → featIdx, for cells outside the mask
  const granted = new Set<number>(); // cells already handed to a sub-tile country

  /**
   * A cell may become a sub-tile country's tile if no other grant took it, and —
   * when the mask calls it land — only if it is not its current owner's LAST
   * cell. Nobody is removed from Earth to put somebody else on it.
   */
  const free = (cell: number): boolean => {
    if (granted.has(cell)) return false;
    const rank = rankOfCell.get(cell);
    return rank === undefined || owned[ownerFeat[rank]!]! > 1;
  };

  // Ascending fi IS ascending ADM0_A3 (loadCountries sorted), so a collision
  // between two sub-tile countries on ONE island (St-Martin / Sint Maarten share
  // a 0.5° cell) resolves by code and never by file order.
  for (let fi = 0; fi < feats.length; fi++) {
    if (idOf[fi] === 0 || owned[fi]! > 0) continue;
    const f = feats[fi]!;
    // Its strongest cell is where the country IS — whether or not the majority
    // rule counted that cell as land. Anything else (nearest land cell, say) puts
    // Barbados' tile on the Venezuelan mainland, which is not a Barbados tile.
    const polls = (r.polled.get(fi) ?? []).slice().sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    let cell = -1;
    let how: Grant['how'] = 'own';
    for (const [candidate] of polls) {
      if (free(candidate)) {
        cell = candidate;
        break;
      }
    }
    if (cell < 0) {
      // Either it polls nowhere at all — Vatican City is ~0.8 km across against a
      // ~14 km sample pitch — or every cell it polls in is already another
      // sub-tile country's tile. Anchor on the cell holding the centroid of its
      // largest ring, then spiral out to the first free cell.
      how = polls.length === 0 ? 'anchor' : 'shared';
      const at = largestLandmassDeg(f);
      const ix0 = Math.min(r.cols - 1, Math.max(0, Math.floor((at.lon + 180) / (360 / r.cols))));
      const iy0 = Math.min(r.rows - 1, Math.max(0, Math.floor((90 - at.lat) / (180 / r.rows))));
      for (let rad = 0; rad <= r.cols && cell < 0; rad++) {
        for (let dy = -rad; dy <= rad && cell < 0; dy++) {
          const iy = iy0 + dy;
          if (iy < 0 || iy >= r.rows) continue;
          for (let dx = -rad; dx <= rad && cell < 0; dx++) {
            if (rad > 0 && Math.abs(dx) !== rad && Math.abs(dy) !== rad) continue; // ring only
            const ix = (((ix0 + dx) % r.cols) + r.cols) % r.cols;
            const cand = iy * r.cols + ix;
            if (free(cand)) cell = cand;
          }
        }
      }
    }
    if (cell < 0) {
      throw new Error(
        `${f.props.a3} (${f.props.name}) cannot be given a tile: every cell near its largest ` +
          `landmass is taken. Every country must be on Earth (owner decision 2026-08-10 Q4b).`,
      );
    }
    granted.add(cell);
    owned[fi] = 1;
    const rank = rankOfCell.get(cell);
    let from = '';
    if (rank === undefined) {
      // The mask sees ocean here, so this is claimable ground the mask does not
      // carry: an EXTRA cell rather than a transfer. Nobody loses anything.
      extraOf.set(cell, fi);
    } else {
      const victim = ownerFeat[rank]!;
      owned[victim] = owned[victim]! - 1;
      ownerFeat[rank] = fi;
      index[rank] = idOf[fi]!;
      from = feats[victim]!.props.a3!;
    }
    grants.push({ a3: f.props.a3!, name: f.props.name!, cell, how, from });
  }

  const extra = [...extraOf.entries()]
    .map(([cell, fi]) => ({ cell, id: idOf[fi]! }))
    .sort((a, b) => a.cell - b.cell);
  for (const e of extra) {
    if (rankOfCell.has(e.cell)) throw new Error(`extra cell ${e.cell} is already a land cell`);
    if (e.id === 0) throw new Error(`extra cell ${e.cell} has no country`);
  }

  // The invariant the whole grant pass exists to guarantee. A country silently
  // absent from Earth is exactly the bug the owner asked to be impossible.
  const seen = new Set<number>(index);
  for (const e of extra) seen.add(e.id);
  for (let id = 1; id <= table.length; id++) {
    if (!seen.has(id)) {
      throw new Error(`${table[id - 1]!.props.a3} owns no cell after the sub-tile pass`);
    }
  }
  // THE SENTINEL IS EXACT, IN BOTH DIRECTIONS: a cell has no country if and only
  // if the feature that won it was dropped. Any other zero is a cell that fell
  // through the vote pass, which is precisely the "nearly true" failure mode the
  // byte-identity gate above exists to rule out.
  let droppedCells = 0;
  for (let rank = 0; rank < n; rank++) {
    const isDropped = NO_SOVEREIGN.has(feats[ownerFeat[rank]!]!.props.a3!);
    if (isDropped) droppedCells++;
    if ((index[rank] === 0) !== isDropped) {
      throw new Error(
        `cell ${r.cells[rank]} has country id ${index[rank]} but its winner is ` +
          `${feats[ownerFeat[rank]!]!.props.a3} — the sentinel and the drop list disagree`,
      );
    }
  }
  return { index, table, extra, grants, dropped, droppedCells };
}

function emitCountries(
  name: string,
  r: Raster,
  a: Assigned,
  source: (typeof SOURCES)[keyof typeof SOURCES],
  eager: boolean,
): { ts: string; b64: string } {
  const { b64, literal } = packedLiteral(a.index);
  const rows = a.table.map((f) => {
    const p = f.props;
    const cols = [p.a3!, p.iso2!, p.a3is!, p.a3un!, p.a3us!, p.color!, p.name!];
    for (const c of cols) {
      if (c.includes('|') || c.includes('\n')) {
        throw new Error(`${p.a3}: field ${JSON.stringify(c)} would break the delimited table`);
      }
    }
    return cols.join('|');
  });
  // Single-quoted TS literals, so names with an apostrophe (Côte d'Ivoire) and a
  // backslash survive the round-trip. Non-ASCII stays literal UTF-8.
  const sq = (s: string): string =>
    `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  const chunkText: string[] = [];
  for (let i = 0; i < rows.length; i += 4) {
    // The trailing '\n' matters: without it the last row of one chunk and the
    // first of the next are glued into one row by the emitted `+`, and the only
    // symptom is a country called 'SwitzerlandCHL'. Proven, not assumed:
    chunkText.push(rows.slice(i, i + 4).join('\n') + (i + 4 < rows.length ? '\n' : ''));
  }
  if (chunkText.join('') !== rows.join('\n')) {
    throw new Error(`${name}: the chunked country table does not reconstruct itself`);
  }
  const tableChunks = chunkText.map((c) => `  ${sq(c)}`);
  const ts = `/**
 * GENERATED FILE — DO NOT EDIT. Regenerate with:
 *   pnpm --filter @shardkeep/scripts earth:mask
 * Generator: scripts/src/earth-mask.ts (records the full method + rationale).
 *
 * ${name}: which country owns each land cell of the ${r.cols}×${r.rows} (${(360 / r.cols).toFixed(2)}°) mask.
 * ONE BYTE PER LAND CELL, in ${'`'}landCellList()${'`'} order (ascending row-major over the
 * mask's land cells) — NOT one byte per grid cell. 0 = no sovereign; 1..${a.table.length} index
 * ${'`'}countries${'`'}, which is sorted by ADM0_A3 so a data refresh cannot renumber tiles.
 * ${r.landCells} land cells, ${a.table.length} countries, ${a.droppedCells} cells with no sovereign
 * (${((a.droppedCells / r.landCells) * 100).toFixed(1)}% — ${a.dropped.join(', ') || 'none'}: dropped, therefore NOT claimable Earth).
 *
 * The union of these country rings rasterises to the checked-in land mask
 * BYTE-IDENTICALLY (the generator throws otherwise), so every land cell that is
 * not dropped has a country BY CONSTRUCTION rather than nearly always.
 *
 * ${a.grants.length} SUB-TILE COUNTRIES, each smaller than one cell and each granted exactly one
 * tile so that no country is missing from Earth (owner decision 2026-08-10, Q4b).
 * The tile is the cell where the country IS: the cell it polls strongest in, or
 * for a country too small to be sampled at all, the cell holding the centroid of
 * its largest ring. ${a.extra.length} of those cells are ones the majority rule counts as
 * OCEAN (Barbados is 431 km² against a ~3,090 km² cell), and they are carried in
 * ${'`'}extraCells${'`'} instead of being stolen from a mainland neighbour — so no country's
 * tile ever lands inside a different country's territory. CLAIMABLE EARTH is
 * therefore "land cells with a country" PLUS ${'`'}extraCells${'`'}. Enumerated here so the
 * list is reviewable, and asserted one-by-one in earthMask.test.ts:
${a.grants
   .map(
     (g) =>
       ` *   ${g.a3} ${g.name} — ${
         g.how === 'own' ? 'its own cell' : g.how === 'anchor' ? 'centroid of its largest ring' : 'shares an island, took the nearest free cell'
       }, ${g.from ? `taken from ${g.from}` : 'extra (the mask sees ocean here)'}`,
   )
   .join('\n')}
 *
 * SOURCE: ${source.url}
 * LICENSE: Natural Earth vector data is PUBLIC DOMAIN
 * (https://www.naturalearthdata.com/about/terms-of-use/); the GeoJSON
 * conversion is CC0-1.0. No attribution required; recorded here anyway.
 * DISCLAIMER TO SHIP WITH ANY VISIBLE COUNTRY NAME, from Natural Earth itself:
 * "Natural Earth Vector draws boundaries of countries according to de facto
 * status." No boundary is redrawn or merged here, and no flags are emitted.
 *
 * ${
   eager
     ? 'LOADED EAGERLY, BUT NOT FROM index.ts — subpath \'@shardkeep/shared/earthCountries\'\n * only, for the same reason as earthMask.ts (packages/sim imports the barrel).'
     : `NOT EXPORTED FROM index.ts. Reach it with await import('@shardkeep/shared/${name === 'EARTH_COUNTRIES' ? 'earthCountries' : 'earthCountriesFine'}')\n * ONLY, so it lands in its own chunk and never enters the first-paint JS graph\n * (docs/WORLDMAP-GLOBE-PLAN.md: 995 / 1000 KB gzip measured, build fails at 1001).`
 }
 */
import type { CountryIndex } from './globe';

const PACKED =
${literal};

// a3|iso2|a3is|a3un|a3us|color|name, one row per country, ADM0_A3 order.
// ISO_A2 and the alternate-viewpoint codes are '' where Natural Earth says −99.
const TABLE =
${tableChunks.join(' +\n')};

// cell:countryId for the ${a.extra.length} sub-tile countries whose own cell the mask counts as
// ocean. Ascending by cell, so a lookup is a binary search.
const EXTRA = '${a.extra.map((e) => `${e.cell}:${e.id}`).join(',')}';

${UNPACK_BLOCK}

const extraPairs = EXTRA ? EXTRA.split(',').map((p) => p.split(':').map(Number)) : [];

export const ${name}: CountryIndex = {
  cols: ${r.cols},
  rows: ${r.rows},
  cells: unpack(PACKED),
  extraCells: Int32Array.from(extraPairs, (p) => p[0]!),
  extraIds: Uint8Array.from(extraPairs, (p) => p[1]!),
  countries: TABLE.split('\\n').map((row) => {
    const p = row.split('|');
    return {
      a3: p[0]!,
      iso2: p[1]!,
      a3is: p[2]!,
      a3un: p[3]!,
      a3us: p[4]!,
      color: Number(p[5]!),
      name: p[6]!,
    };
  }),
};
`;
  return { ts, b64 };
}

/** Two numbers, because only one of them is the build budget: the bundler strips
 *  the header comment, so the PAYLOAD figure — gzip of the base64 literal that
 *  actually reaches the browser — is what compares against
 *  apps/web/scripts/size-check.mjs. The file figure is for git. */
function report(head: string, ts: string, b64: string, out: string): void {
  const gzPayload = gzipSync(Buffer.from(b64, 'utf8')).length;
  const gzFile = gzipSync(Buffer.from(ts, 'utf8')).length;
  console.log(
    `${head}  payload gzip ${(gzPayload / 1024).toFixed(2)} KB` +
      `  file ${(ts.length / 1024).toFixed(1)} KB raw / ${(gzFile / 1024).toFixed(2)} KB gzip  → src/${out}`,
  );
}

async function main(): Promise<void> {
  mkdirSync(SHARED_SRC, { recursive: true });
  const jobs = [
    {
      land: 'coarse',
      countries: 'coarseCountries',
      name: 'EARTH_COARSE',
      out: 'earthMask.ts',
      countryName: 'EARTH_COUNTRIES',
      countryOut: 'earthCountries.ts',
      cols: 180,
      rows: 90,
      eager: true,
    },
    {
      land: 'fine',
      countries: 'fineCountries',
      name: 'EARTH_FINE',
      out: 'earthMaskFine.ts',
      countryName: 'EARTH_COUNTRIES_FINE',
      countryOut: 'earthCountriesFine.ts',
      cols: 720,
      rows: 360,
      eager: false,
    },
  ] as const;
  for (const j of jobs) {
    const land = rasterise(await loadLand(j.land), j.cols, j.rows);
    const mask = emit(j.name, land, SOURCES[j.land], j.eager);
    writeFileSync(join(SHARED_SRC, j.out), mask.ts);
    report(
      `${j.name.padEnd(20)} ${j.cols}×${j.rows}  land ${land.landCells}` +
        `  area ${(land.areaFraction * 100).toFixed(1)}%  cells ${(land.cellFraction * 100).toFixed(1)}%`,
      mask.ts,
      mask.b64,
      j.out,
    );

    // EARTH-TILES-PLAN R21: the country layer's "free switch" is a claim until
    // this passes. If the union of the admin_0 rings is not the SAME Earth as the
    // physical land layer, then either the country index leaves cells
    // countryless or the mask would have to change — and changing the coarse
    // mask renumbers landSites() and physically relocates every existing valley.
    // So it is a hard gate, not a warning.
    const feats = await loadCountries(j.countries);
    const cRaster = rasterise(feats, j.cols, j.rows);
    let diff = 0;
    for (let i = 0; i < land.bits.length; i++) if (land.bits[i] !== cRaster.bits[i]) diff++;
    console.log(
      `${''.padEnd(20)} byte-diff vs ${SOURCES[j.land].file}: ${diff} / ${land.bits.length}` +
        `  (${feats.length} features, land ${cRaster.landCells})`,
    );
    if (diff !== 0 || cRaster.landCells !== land.landCells) {
      throw new Error(
        `${j.countryName}: the union of ${SOURCES[j.countries].file}'s rings rasterises to a DIFFERENT ` +
          `Earth than ${SOURCES[j.land].file} (${diff} bytes differ, ${cRaster.landCells} vs ` +
          `${land.landCells} land cells). Do not ship this: either some land cells would have no ` +
          `country, or the checked-in mask would have to move and relocate every existing valley.`,
      );
    }

    const assigned = assignCountries(feats, cRaster);
    const countries = emitCountries(j.countryName, cRaster, assigned, SOURCES[j.countries], j.eager);
    writeFileSync(join(SHARED_SRC, j.countryOut), countries.ts);
    report(
      `${j.countryName.padEnd(20)} ${j.cols}×${j.rows}  countries ${assigned.table.length}` +
        `  no-sovereign cells ${assigned.droppedCells}  sub-tile grants ${assigned.grants.length}`,
      countries.ts,
      countries.b64,
      j.countryOut,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
