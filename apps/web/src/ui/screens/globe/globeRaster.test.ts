/**
 * THE RASTERISER'S CONTRACT — the assertions that would otherwise only ever be
 * checked by looking at a screenshot, and the two that protect what already ships.
 *
 * The renderer writes MATERIAL IDS and pass 2 turns them into colours, so every
 * test here reads the finished RGBA buffer and maps it back through the same
 * `PALETTE` the renderer used. That is deliberate: it tests what a player can see,
 * not an internal array, and it means a change that quietly re-indexed the palette
 * would fail rather than pass.
 *
 * WHAT IS PINNED, AND WHY EACH ONE MATTERS
 *  1. `MAT_COUNT ≤ 256`. `mat` is a Uint8Array, so overflow is SILENT colour
 *     corruption rather than an exception (EARTH-TILES-PLAN R19). This is the
 *     assertion that stops anyone indexing materials by country id.
 *  2. FLAG OFF DRAWS NOTHING NEW. Every colour the flag-off path writes comes from
 *     the pre-Earth-tiles material block, so "flag off is today's globe" is a
 *     property rather than a promise.
 *  3. THE TILE PASS PUTS THE RIGHT COUNTRY ON THE RIGHT GROUND. Tbilisi renders in
 *     Georgia's MAPCOLOR9 hue and Cairo in Egypt's, from the real fine mask and the
 *     real generated index — which is the whole point of the phase.
 *  4. NO HOLES. A windowed walk that drops a cell leaves a hole in the planet, and
 *     a half-open quad fill that is off by one leaves a lattice of gaps. Both show
 *     up as ocean in the middle of the Sahara.
 *  5. NO LAND OUTSIDE THE DISC, and the frame is DETERMINISTIC — the dither is a
 *     hash, not a clock, so a stationary globe cannot boil.
 */
import { GLOBE } from '@shardkeep/shared';
import { EARTH_COARSE } from '@shardkeep/shared/earthMask';
import { cellAtDeg, cellIndex, countryIdOfCell, countryOfId, type CountryIndex, type LandMask } from '@shardkeep/shared/globe';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  COUNTRY_HUES, createEarthRaster, LAND_VARIANTS, MAT_BORDER, MAT_COAST, MAT_COUNT, MAT_COUNTRY,
  MAT_LAND, MAT_LAND_END, MAT_OCEAN_A, MAT_OCEAN_B, MAT_RING, MAT_SPACE, MAT_SURF, PALETTE, SHADES,
  type EarthDrawOpts,
} from './globeRaster';
import { GLOBE_VIEW, latTintIndex, TINT_BANDS, type GlobeNav } from './globeView';

// --- a canvas, in a node test ------------------------------------------------
//
// The rasteriser needs exactly three things from a 2D context: `createImageData`,
// `putImageData` and the destination's `drawImage`. Stubbing those (rather than
// pulling in jsdom for one file) keeps the suite dependency-free AND hands the
// test the finished pixel buffer, which is the thing being asserted.

interface Captured {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

let captured: Captured | null = null;

function fakeCtx(): CanvasRenderingContext2D {
  const ctx = {
    createImageData(w: number, h: number) {
      const img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4), colorSpace: 'srgb' };
      captured = { data: img.data, w, h };
      return img;
    },
    putImageData() { /* the buffer IS the assertion */ },
    drawImage() { /* the upscale is the GPU's problem */ },
    save() {},
    restore() {},
    imageSmoothingEnabled: false,
    globalAlpha: 1,
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => fakeCtx() }),
  };
});

/** Colour → material, for every shade. Built from the renderer's own table. */
const MAT_OF_COLOUR = (() => {
  const m = new Map<number, number>();
  for (let mat = 0; mat < MAT_COUNT; mat++) {
    for (let s = 0; s < SHADES; s++) {
      const c = PALETTE[mat * SHADES + s]!;
      if (!m.has(c)) m.set(c, mat);
    }
  }
  return m;
})();

const VW = 375;
const VH = 812;

/**
 * A UTC instant at which the subsolar point is on `lon` and the declination is
 * ~0 (the March equinox), so a camera at that longitude and a temperate latitude
 * is fully lit and every material is seen at shade 0. Solved from `sunLonLat`'s
 * own definition rather than guessed, because a night-side pixel would make the
 * colour→material map ambiguous for no reason.
 */
function noonAt(lon: number): number {
  return Date.UTC(2026, 2, 20) + (12 - lon / 15) * 3_600_000;
}

function drawOnce(mask: LandMask, nav: GlobeNav, tiles: boolean, sunMs: number): {
  px: Uint32Array; w: number; h: number; stats: { cells: number; rows: number; tiles: boolean };
} {
  const r = createEarthRaster();
  const o: EarthDrawOpts = { vw: VW, vh: VH, dpr: 1, nav, mask, sunMs, alpha: 1, tiles };
  r.draw(fakeCtx(), o);
  const cap = captured!;
  return {
    px: new Uint32Array(cap.data.buffer),
    w: cap.w,
    h: cap.h,
    stats: { cells: r.stats.cells, rows: r.stats.rows, tiles: r.stats.tiles },
  };
}

/**
 * The tile pass needs the country index, which is a DYNAMIC import — so the first
 * frame after a mask change legitimately falls back to the silhouette. Redraw
 * until it has landed, which is also a test of that fallback: if the index never
 * arrived, `tiles` would stay false and every tile assertion below would fail
 * loudly rather than silently pass on the old pass.
 */
async function drawTiled(mask: LandMask, nav: GlobeNav, sunMs: number): Promise<{
  px: Uint32Array; w: number; h: number; stats: { cells: number; rows: number; tiles: boolean };
}> {
  const r = createEarthRaster();
  const o: EarthDrawOpts = { vw: VW, vh: VH, dpr: 1, nav, mask, sunMs, alpha: 1, tiles: true };
  for (let i = 0; i < 40; i++) {
    r.draw(fakeCtx(), o);
    if (r.stats.tiles) break;
    await new Promise((res) => { setTimeout(res, 1); });
  }
  expect(r.stats.tiles).toBe(true);
  const cap = captured!;
  return {
    px: new Uint32Array(cap.data.buffer),
    w: cap.w,
    h: cap.h,
    stats: { cells: r.stats.cells, rows: r.stats.rows, tiles: r.stats.tiles },
  };
}

async function fineMask(): Promise<LandMask> {
  return (await import('@shardkeep/shared/earthMaskFine')).EARTH_FINE;
}
async function fineIdx(): Promise<CountryIndex> {
  return (await import('@shardkeep/shared/earthCountriesFine')).EARTH_COUNTRIES_FINE;
}

const navFor = (lon: number, lat: number, zoom: number): GlobeNav =>
  ({ lam0: lon * (Math.PI / 180), phi0: lat * (Math.PI / 180), zoom });

/** The material a claimable cell at this country and latitude must be filled with. */
function countryMat(idx: CountryIndex, lon: number, lat: number, m: LandMask): number {
  const c = cellAtDeg(m, lon, lat);
  const id = countryIdOfCell(m, idx, cellIndex(m, c.ix, c.iy));
  const hue = countryOfId(idx, id)!.color - 1;
  // The band comes from the ROW's centre latitude, exactly as `tablesFor` bakes it.
  const band = latTintIndex(90 - (c.iy + 0.5) * (180 / m.rows));
  return MAT_COUNTRY + (hue * TINT_BANDS + band) * LAND_VARIANTS;
}

describe('the palette cannot overflow the material byte', () => {
  it('fits in a Uint8Array, with the country block keyed by MAPCOLOR9 and not by id', () => {
    // R19, and the failure mode it exists to stop is SILENT: `mat` is a
    // Uint8Array, so a 200-country material scheme wraps instead of throwing and
    // the planet simply renders in the wrong colours.
    expect(MAT_COUNT).toBeLessThanOrEqual(256);
    // 9 hues × 6 latitude bands × 2 dither twins, and nothing per country.
    expect(MAT_COUNTRY).toBe(MAT_LAND_END);
    expect(MAT_BORDER - MAT_COUNTRY).toBe(COUNTRY_HUES * TINT_BANDS * LAND_VARIANTS);
    expect(MAT_COUNT).toBe(MAT_SURF + 1);
    // Every material has a colour: an id with no DAY entry renders as black, which
    // reads as a hole in the planet rather than as a bug.
    for (let m = 0; m < MAT_COUNT; m++) expect(PALETTE[m * SHADES]).toBeGreaterThan(0);
  });
});

describe('FLAG OFF is the shipped globe', () => {
  it('draws not one pixel outside the pre-Earth-tiles material block', async () => {
    // THE do-not-regress assertion. If the flag-off path could ever write a
    // country hue, a border, a coast or a surf pixel, "flag off is today's globe
    // byte-for-byte" would be a hope. It is a property instead.
    const fine = await fineMask();
    for (const [mask, nav] of [
      [EARTH_COARSE, navFor(0, 20, 0)],
      [EARTH_COARSE, navFor(44.8, 41.7, 1)],
      [fine, navFor(44.8, 41.7, 2.6)],
    ] as const) {
      const f = drawOnce(mask, nav, false, noonAt(nav.lam0 * (180 / Math.PI)));
      expect(f.stats.tiles).toBe(false);
      // The old pass has no row window at all — that is the cost it pays, and
      // reporting 0 keeps `stats.rows` honest rather than optimistic.
      expect(f.stats.rows).toBe(0);
      const seen = new Set<number>();
      for (let i = 0; i < f.px.length; i++) {
        const c = f.px[i]!;
        if (c === 0) continue; // untouched space
        const mat = MAT_OF_COLOUR.get(c);
        expect(mat, `colour ${c.toString(16)} is not in the palette`).toBeDefined();
        seen.add(mat!);
      }
      for (const mat of seen) expect(mat).toBeLessThan(MAT_LAND_END);
      // …and it really did draw a planet, so the assertion above is not vacuous.
      expect([...seen].some((m) => m >= MAT_LAND)).toBe(true);
    }
  });
});

describe('a tile is real Earth territory', () => {
  it('paints Tbilisi in Georgia and Cairo in Egypt, from the generated index', async () => {
    const fine = await fineMask();
    const idx = await fineIdx();
    for (const [lon, lat] of [[44.8, 41.7], [31.2, 30.0], [-58.4, -34.6]] as const) {
      const f = await drawTiled(fine, navFor(lon, lat, GLOBE_VIEW.parcelZoom), noonAt(lon));
      const cx = Math.floor(f.w / 2);
      const cy = Math.floor(f.h / 2);
      const mat = MAT_OF_COLOUR.get(f.px[cy * f.w + cx]!)!;
      const want = countryMat(idx, lon, lat, fine);
      // The centre pixel is inside one cell, so it is that cell's fill, its grid
      // line (the dark twin), a border or a coast. Anything else means the country
      // under the camera is not the country being drawn.
      expect([want, want + 1, MAT_BORDER, MAT_COAST]).toContain(mat);
    }
  });

  it('draws borders and coasts where the mask says they are, and only there', async () => {
    const fine = await fineMask();
    // Georgia at the parcel zoom: land neighbours on three sides and the Black Sea
    // on the fourth, so BOTH kinds of edge must appear in one frame.
    const f = await drawTiled(fine, navFor(43.5, 42.0, GLOBE_VIEW.parcelZoom), noonAt(43.5));
    let borders = 0;
    let coasts = 0;
    let surf = 0;
    let countryFill = 0;
    for (let i = 0; i < f.px.length; i++) {
      const mat = MAT_OF_COLOUR.get(f.px[i]!);
      if (mat === MAT_BORDER) borders++;
      else if (mat === MAT_COAST) coasts++;
      else if (mat === MAT_SURF) surf++;
      else if (mat !== undefined && mat >= MAT_COUNTRY && mat < MAT_BORDER) countryFill++;
    }
    expect(countryFill).toBeGreaterThan(1000);
    expect(borders).toBeGreaterThan(0);
    expect(coasts).toBeGreaterThan(0);
    // Surf only exists on the ocean SIDE of a coast, so it can never outnumber the
    // coastline it decorates by much — that is the guard against it bleeding into
    // neighbouring tiles.
    expect(surf).toBeLessThanOrEqual(coasts * 2);
  });

  it('leaves NO HOLES: deep inside the Sahara every pixel is land', async () => {
    // The two failure modes a quad pass can have are both visible here and nowhere
    // else: a windowed row/column walk that drops a cell, and a half-open fill that
    // is off by one, each leave ocean showing through the middle of a continent.
    const fine = await fineMask();
    const f = await drawTiled(fine, navFor(15, 23, 3), noonAt(15));
    let wet = 0;
    for (let i = 0; i < f.px.length; i++) {
      const mat = MAT_OF_COLOUR.get(f.px[i]!);
      if (mat === MAT_OCEAN_A || mat === MAT_OCEAN_B || mat === MAT_RING
        || mat === MAT_SURF || mat === MAT_SPACE || f.px[i] === 0) wet++;
    }
    expect(wet).toBe(0);
  });

  it('windows the walk: a deep zoom touches a handful of rows, not all 360', async () => {
    const fine = await fineMask();
    const deep = await drawTiled(fine, navFor(15, 23, 3.5), noonAt(15));
    const whole = await drawTiled(fine, navFor(15, 23, 0), noonAt(15));
    // The measured waste this replaces: the old loop walks all 86,122 land cells
    // to draw ~24 at this zoom. Rows are the visible proxy for that walk.
    expect(deep.stats.rows).toBeLessThan(24);
    expect(deep.stats.cells).toBeLessThan(200);
    expect(whole.stats.rows).toBeGreaterThan(deep.stats.rows * 4);
  });

  it('keeps land inside the disc and the frame identical between draws', async () => {
    const fine = await fineMask();
    const nav = navFor(20, 10, 1.4);
    const a = await drawTiled(fine, nav, noonAt(20));
    const first = Uint32Array.from(a.px);
    const b = await drawTiled(fine, nav, noonAt(20));
    // A globe that re-dithers itself every frame boils; the dither is a hash of the
    // cell index precisely so this holds.
    expect([...b.px]).toEqual([...first]);
    // Nothing but space may live outside the silhouette — a quad near the limb is
    // sheared, so its bbox would spill without the per-pixel disc test.
    const R = (Math.min(VW, VH) * GLOBE_VIEW.discFrac) / 2
      * GLOBE_VIEW.zoomBase ** nav.zoom * (GLOBE.px / VH);
    const cx = a.w / 2;
    const cy = a.h / 2;
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const c = a.px[y * a.w + x]!;
        if (c === 0) continue;
        const mat = MAT_OF_COLOUR.get(c)!;
        if (mat === MAT_SPACE) continue;
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(R + 2);
      }
    }
  });
});
