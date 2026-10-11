/**
 * THE PARCEL ↔ EARTH-CELL CONTRACT (docs/EARTH-TILES-PLAN.md §5.2, P4a).
 *
 * Every assertion here exists because a specific way of being wrong would be
 * INVISIBLE in production: a parcel in the sea, two deeds on one cell, a valley
 * whose 491 parcels are scattered across three continents, or a silent wrap past
 * the last patch. The numbers are measured against the checked-in 0.5° mask and
 * country index, and they are stated in the test names so a regeneration that
 * moves them shows up as a named failure rather than a diff.
 */
import { describe, expect, it } from 'vitest';
import { WORLD } from './constants';
import { EARTH_COARSE } from './earthMask';
import { EARTH_COUNTRIES_FINE } from './earthCountriesFine';
import { EARTH_FINE } from './earthMaskFine';
import {
  cellCentreDeg, cellIx, cellIy, claimableCells, countryIdOfCell, greatCircleKm, isLandCell,
  landSiteCount, lonlat, siteCapacity, siteOf, SLOTS_PER_SITE,
} from './globe';
import {
  PARCELS_PER_PATCH, fillIndex, parcelCapacity, parcelCell, parcelOf, patchCells, patchCount,
  patchStats, siteSeatCell, siteSeatLonLat, tileOfFillIndex,
} from './parcelGrid';

const M = EARTH_FINE;
const IDX = EARTH_COUNTRIES_FINE;

/** Degrees → the packed cell of a mask. Used to ask "is the point the SHIPPED
 *  siting produced actually on land?", which is the whole of the D3 defect. */
const cellAt = (m: typeof M, lon: number, lat: number): number =>
  Math.floor((90 - lat) / (180 / m.rows)) * m.cols + Math.floor((lon + 180) / (360 / m.cols));
const cellAtFine = (lon: number, lat: number): number => cellAt(M, lon, lat);
const coarseCellAt = (lon: number, lat: number): number => cellAt(EARTH_COARSE, lon, lat);

/** Every seated parcel's cell, once — built here rather than per test. */
const seatedCells: number[] = [];
for (let s = 0; s < patchCount(); s++) for (const c of patchCells(s)) seatedCells.push(c);

const centre = (cell: number) => cellCentreDeg(M, cellIx(M, cell), cellIy(M, cell));

describe('the patch stream', () => {
  it('cuts Earth into 120 patches of 491 = 58,920 parcels — NOT the 82,488 the plan headlines', () => {
    // WHY IT MATTERS: 82,488 was measured before owner decision Q4a (2026-08-10)
    // dropped Antarctica. The stream is claimableCells(), not landCellList(), so
    // 24,276 Antarctic land cells with no sovereign are NOT seats. Anyone quoting
    // 82,488 as the launch ceiling after this commit is quoting a stale number,
    // and the difference (23,568 parcels) is large enough to matter to a roadmap.
    expect(PARCELS_PER_PATCH).toBe(WORLD.valleyCapacity - WORLD.campsPerValley);
    expect(PARCELS_PER_PATCH).toBe(491);
    expect(patchCount()).toBe(120);
    expect(parcelCapacity()).toBe(58_920);
  });

  it('reaches 59,071 of 61,903 claimable cells (95.43%), leaving 151 short of a 121st patch', () => {
    // The 2,832 unreachable cells are small islands no COARSE land cell contains
    // (the stream is anchored on the coarse Hilbert walk on purpose — see the
    // clustering tests). The 151 leftover cells are dropped rather than
    // half-seating valley 120, which is what makes patchCells throw cleanly.
    const st = patchStats();
    expect(st.claimable).toBe(claimableCells(M, IDX).length);
    expect(st.claimable).toBe(61_903);
    expect(st.reached).toBe(59_071);
    expect(st.unreachable).toBe(2_832);
    expect(st.leftover).toBe(151);
    expect(st.patches * PARCELS_PER_PATCH + st.leftover).toBe(st.reached);
  });
});

describe('a parcel is real, claimable Earth', () => {
  it('gives EVERY parcel of EVERY valley a cell with a sovereign — the whole bug being fixed', () => {
    // WHY IT MATTERS: today a parcel is a screen-space lattice offset from its
    // valley's pin (globeView.ts:426-433), so parcels float over the Bering Sea —
    // and the valley pin itself is 0.5° water 4.84% of the time. Here the parcel
    // IS a claimable cell, so water is impossible by construction rather than
    // filtered: if this ever fails, the stream stopped being claimableCells().
    let countryless = 0;
    for (const c of seatedCells) if (countryIdOfCell(M, IDX, c) === 0) countryless++;
    expect(countryless).toBe(0);
  });

  it('seats only 3 cells the silhouette mask calls ocean, and each is a sub-tile country', () => {
    // Owner decision Q4b: a country smaller than a cell still gets one tile, and
    // those 57 cells live OUTSIDE the mask (CountryIndex.extraCells) because the
    // masks cannot gain a cell without renumbering landSites() and relocating
    // every existing valley. Only 3 of the 57 fall inside a coarse land cell, so
    // only 3 are reachable by this stream. P2 must draw them as land anyway.
    const oceanSeats = seatedCells.filter((c) => !isLandCell(M, c));
    expect(oceanSeats.length).toBe(3);
    const extras = new Set([...IDX.extraCells]);
    for (const c of oceanSeats) expect(extras.has(c)).toBe(true);
  });

  it('seats no Antarctic ground — dropped in the country table, so it cannot be a seat', () => {
    // Every countryless cell is south of 60°S (asserted in earthMask.test.ts), so
    // "every seat has a sovereign" already implies this. Stated separately because
    // the OWNER decision was about Antarctica, not about sentinels: if someone
    // re-admits it, the reader should see Antarctica named in the failure.
    for (const c of seatedCells) expect(centre(c).lat).toBeGreaterThan(-60);
  });

  it('never seats one cell twice — 58,920 parcels, 58,920 distinct cells', () => {
    // WHY IT MATTERS: this is the failure R10 was written for. Two parcels on one
    // cell is two deeds conveying one place on Earth, with no error and no log.
    expect(new Set(seatedCells).size).toBe(58_920);
    expect(seatedCells.length).toBe(58_920);
  });
});

describe('a valley reads as ONE territory', () => {
  // WHY IT MATTERS: the coarse-anchored stream exists ONLY for this. Walking the
  // claimable list directly seats more players (126 patches / 61,866) but its
  // consecutive cells jump a whole parallel at every row end (measured 1.21% of
  // steps over ~2,000 km, vs 0.03% here), so a valley would render as speckle
  // across a hemisphere instead of a region — and it would relocate production's
  // only valley. These thresholds are the price of that choice, made explicit.
  const stepsByPatch: number[][] = [];
  for (let s = 0; s < patchCount(); s++) {
    const pts = [...patchCells(s)].map((c) => ({ ...centre(c) }));
    const steps: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      steps.push(greatCircleKm(pts[i - 1]!.lon, pts[i - 1]!.lat, pts[i]!.lon, pts[i]!.lat));
    }
    stepsByPatch.push(steps);
  }
  const all = stepsByPatch.flat();

  it('keeps consecutive parcels ADJACENT: every patch median ≤ 60 km (measured 11.3–55.6)', () => {
    // A 0.5° cell is 55.6 km wide at the equator, so a median step at or below one
    // cell width means the typical next parcel is the literal next cell.
    for (const steps of stepsByPatch) {
      const s = [...steps].sort((a, b) => a - b);
      expect(s[s.length >> 1]!).toBeLessThanOrEqual(60);
    }
  });

  it('jumps over 2,000 km in 0.03% of steps (pinned < 0.5%) — inherited from the Hilbert walk', () => {
    const big = all.filter((d) => d > 2_000).length;
    expect(big / all.length).toBeLessThan(0.005);
  });

  it('keeps a patch regional: median bbox diagonal 2,106 km, pinned ≤ 3,000', () => {
    // 491 cells × ~2,200 km² ≈ 1.08 M km², about Egypt — this is the "a valley is
    // a region, a parcel is a county" arithmetic the owner accepted, in a test.
    const diags: number[] = [];
    for (let s = 0; s < patchCount(); s++) {
      let lo = 999, hi = -999, la = 999, lb = -999;
      for (const c of patchCells(s)) {
        const p = centre(c);
        lo = Math.min(lo, p.lon); hi = Math.max(hi, p.lon);
        la = Math.min(la, p.lat); lb = Math.max(lb, p.lat);
      }
      diags.push(greatCircleKm(lo, la, hi, lb));
    }
    diags.sort((a, b) => a - b);
    expect(diags[diags.length >> 1]!).toBeLessThanOrEqual(3_000);
  });

  it("keeps production's only valley in its own neighbourhood (patch 0 spans its site)", () => {
    // site_id 0 resolves to lon −173.75, lat +67.75 — Chukotka on the Bering
    // Strait. That EXACT point is 0.5° water (§0's second, unreported cause), so
    // it cannot itself be a parcel; what must hold is that the patch it anchors
    // still covers it, or the alpha's one valley teleports on deploy.
    let lo = 999, hi = -999, la = 999, lb = -999;
    for (const c of patchCells(0)) {
      const p = centre(c);
      lo = Math.min(lo, p.lon); hi = Math.max(hi, p.lon);
      la = Math.min(la, p.lat); lb = Math.max(lb, p.lat);
    }
    expect(lo).toBeCloseTo(-179.75, 6);
    expect(hi).toBeCloseTo(-152.25, 6);
    expect(la).toBeCloseTo(58.25, 6);
    expect(lb).toBeCloseTo(71.25, 6);
    expect(-173.75).toBeGreaterThanOrEqual(lo);
    expect(-173.75).toBeLessThanOrEqual(hi);
    expect(67.75).toBeGreaterThanOrEqual(la);
    expect(67.75).toBeLessThanOrEqual(lb);
  });
});

describe('the VALLEY PIN is on land too (adversarial pass D3)', () => {
  // The owner's sentence was "each tile should also be on land, water tiles should
  // be removed", and P4b only answered it for PARCELS. `lonlat(cell, slot)` still
  // offsets onto a blind 4×4 sub-lattice, so 4,203 of 86,912 valley sites (4.84%)
  // are 0.5° water — production's site 0 among them. These assertions are what stop
  // that from coming back, and what stop the fix from relocating anybody.

  it('puts EVERY one of the 86,912 valley pins on 0.5° land — measured 0 in water, was 4,203', () => {
    let water = 0;
    let unclaimable = 0;
    for (let o = 0; o < siteCapacity(); o++) {
      const cell = siteSeatCell(siteOf(o));
      if (!isLandCell(M, cell)) water++;
      if (countryIdOfCell(M, IDX, cell) === 0) unclaimable++;
    }
    expect(water).toBe(0);
    // The only pins on ground with no sovereign are Antarctica's, because those
    // 1,529 coarse cells contain no claimable fine cell AT ALL (owner decision Q4a
    // dropped Antarctica from the country table, not from the site lattice). Real
    // land with no country is the honest answer there; open water is not.
    expect(unclaimable).toBe(1_529 * SLOTS_PER_SITE);
    expect(unclaimable).toBe(24_464);
  });

  it("moves production's site 0 out of the Bering Strait and 111 km onto Chukotka", () => {
    const s = siteOf(0);
    const before = lonlat(s.cell, s.slot);
    expect(before).toEqual({ lon: -173.75, lat: 67.75 });
    expect(isLandCell(M, cellAtFine(before.lon, before.lat))).toBe(false); // the defect

    const after = siteSeatLonLat(s);
    expect(after).toEqual({ lon: -173.75, lat: 66.75 });
    expect(isLandCell(M, siteSeatCell(s))).toBe(true);
    expect(countryIdOfCell(M, IDX, siteSeatCell(s))).not.toBe(0);
    expect(greatCircleKm(before.lon, before.lat, after.lon, after.lat)).toBeCloseTo(111.2, 0);

    // THE PATCH DOES NOT MOVE, which is the constraint that outranks the defect:
    // the patch is a pure function of site_id, and the seat is a sub-cell of the
    // SAME coarse cell, so both the bbox above and the coarse cell are unchanged.
    expect(coarseCellAt(after.lon, after.lat)).toBe(s.cell);
    expect(coarseCellAt(before.lon, before.lat)).toBe(s.cell);
    // …and the seat is literally the valley's OWN first parcel, because the patch
    // stream emits a coarse cell's claimable sub-cells in this same order.
    expect(siteSeatCell(s)).toBe(patchCells(0)[0]);
    expect(siteSeatCell(s)).toBe(parcelCell(0, tileOfFillIndex(0).x, tileOfFillIndex(0).y));
  });

  it('never leaves the valley\'s own 2° cell — max 235.9 km, so no pin changes region', () => {
    let moved = 0;
    let maxKm = 0;
    for (let o = 0; o < siteCapacity(); o++) {
      const s = siteOf(o);
      const before = lonlat(s.cell, s.slot);
      const after = siteSeatLonLat(s);
      // The invariant that makes "nobody is relocated" a proof rather than a hope.
      expect(coarseCellAt(after.lon, after.lat)).toBe(s.cell);
      if (after.lon !== before.lon || after.lat !== before.lat) {
        moved++;
        maxKm = Math.max(maxKm, greatCircleKm(before.lon, before.lat, after.lon, after.lat));
      }
    }
    expect(moved).toBe(10_654); // 12.3% of slots; the other 87.7% are byte-identical
    expect(maxKm).toBeLessThan(236);
  });

  it('keeps the Hilbert clustering globe.test.ts pins: median 222 km, >2,000 km in 0.33%', () => {
    // The whole reason siting walks a space-filling curve is that consecutive
    // valleys must be NEIGHBOURS (globe.test.ts: median < 300 km, mean < 500 km,
    // >2,000 km jumps < 2%). Re-seating inside the same 2° cell cannot break that,
    // and this is the measurement that says so rather than assuming it.
    const pts: { lon: number; lat: number }[] = [];
    for (let o = 0; o < landSiteCount(); o++) pts.push({ ...siteSeatLonLat(siteOf(o)) });
    const d: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      d.push(greatCircleKm(pts[i - 1]!.lon, pts[i - 1]!.lat, pts[i]!.lon, pts[i]!.lat));
    }
    const sorted = [...d].sort((a, b) => a - b);
    expect(sorted[sorted.length >> 1]!).toBeLessThan(300);
    expect(d.reduce((a, b) => a + b, 0) / d.length).toBeLessThan(500);
    expect(d.filter((x) => x > 2_000).length / d.length).toBeLessThan(0.02);
  });

  it('is pure in (cell, slot), and refuses a cell that seats no valley', () => {
    const s = siteOf(41);
    expect(siteSeatCell(s)).toBe(siteSeatCell({ ...s }));
    expect(siteSeatLonLat(s)).toEqual(siteSeatLonLat({ ...s }));
    // Ocean coarse cell 0 (lon −180…−178, lat 88…90): `landSites()` never returns
    // it, so asking for its seat is a caller bug and gets an error, not a guess.
    expect(() => siteSeatCell({ cell: 0, slot: 0 })).toThrow(/no 0.5° land cell/);
  });
});

describe('the valley grid → patch index', () => {
  it('is a bijection over the 491 DEEDED tiles and excludes the 9 camps', () => {
    // WHY IT MATTERS: a camp holds a grid tile but is not deeded land
    // (EARTH-TILES-PLAN R2 — camps are FK'd by raids.pve_camp_id and may pay a
    // bounded emission-pool bounty, so they must never consume Earth). If camps
    // were included, 500 tiles would map into 491 cells and nine parcels would
    // silently share a cell with someone else.
    const seen = new Set<number>();
    let camps = 0;
    for (let y = 0; y < WORLD.gridRows; y++) {
      for (let x = 0; x < WORLD.gridCols; x++) {
        let i: number;
        try { i = fillIndex(x, y); } catch { camps++; continue; }
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(PARCELS_PER_PATCH);
        expect(seen.has(i)).toBe(false);
        seen.add(i);
        expect(tileOfFillIndex(i)).toEqual({ x, y });
      }
    }
    expect(camps).toBe(WORLD.campsPerValley);
    expect(seen.size).toBe(PARCELS_PER_PATCH);
  });

  it('fills in plot-assignment order, so a valley\'s first arrivals are Earth neighbours', () => {
    // The first three tiles plot assignment hands out are (0,0), (5,0), (10,0)
    // (stride 5). Keying the cell off the FILL order rather than row-major is what
    // makes those the patch's first three cells — i.e. adjacent on Earth.
    expect(fillIndex(0, 0)).toBe(0);
    expect(fillIndex(5, 0)).toBe(1);
    expect(fillIndex(10, 0)).toBe(2);
    const p = patchCells(0);
    expect(parcelCell(0, 0, 0)).toBe(p[0]);
    expect(parcelCell(0, 5, 0)).toBe(p[1]);
    expect(parcelCell(0, 10, 0)).toBe(p[2]);
    expect(greatCircleKm(centre(p[0]!).lon, centre(p[0]!).lat, centre(p[2]!).lon, centre(p[2]!).lat))
      .toBeLessThan(100);
  });
});

describe('parcelCell / parcelOf', () => {
  it('is pure in (siteId, x, y) and nothing else', () => {
    expect(parcelCell(7, 3, 4)).toBe(parcelCell(7, 3, 4));
    expect(parcelCell(0, 0, 0)).toBe(33_132);
    // 66.75°N 173.75°W — Chukotka, on real land, one cell south of the site pin.
    expect(centre(33_132)).toEqual({ lon: -173.75, lat: 66.75 });
  });

  it('hands out a COPY of a patch, so one consumer cannot corrupt every other', () => {
    const a = patchCells(3);
    const before = a[0]!;
    a[0] = -1;
    expect(patchCells(3)[0]).toBe(before);
    expect(patchCells(3)).not.toBe(patchCells(3));
  });

  it('round-trips every seated parcel back to its (siteId, x, y)', () => {
    for (const [s, x, y] of [[0, 0, 0], [0, 24, 19], [1, 12, 7], [61, 4, 4], [119, 24, 19]] as const) {
      expect(parcelOf(parcelCell(s, x, y))).toEqual({ siteId: s, x, y });
    }
    // and exhaustively for one whole valley
    for (let i = 0; i < PARCELS_PER_PATCH; i++) {
      const t = tileOfFillIndex(i);
      expect(parcelOf(parcelCell(9, t.x, t.y))).toEqual({ siteId: 9, x: t.x, y: t.y });
    }
  });

  it('returns null for a cell no valley seats, rather than guessing', () => {
    expect(parcelOf(0)).toBeNull();               // lon −180, lat +90: ocean
    expect(parcelOf(-1)).toBeNull();
    const unreachable = claimableCells(M, IDX).find((c) => parcelOf(c) === null);
    expect(unreachable).toBeDefined();            // 2,832 of them: real, claimable, unseated
  });
});

describe('running out of Earth is a real event with a real answer', () => {
  it('THROWS past the last patch instead of wrapping onto valley 0', () => {
    // WHY IT MATTERS (R10, formerly LAND-DEED R11): a modulo wrap would site
    // valley 120's parcels on valley 0's cells — two deeds, one place, no error,
    // no log, no test. The ceiling used to be unreachable at 86,912 valleys; at
    // 120 it is reachable by a successful launch, so the guard ships WITH the
    // mapping and not after it.
    expect(() => patchCells(patchCount() - 1)).not.toThrow();
    expect(() => patchCells(patchCount())).toThrow(/Earth is full/);
    expect(() => parcelCell(patchCount(), 0, 0)).toThrow(/Earth is full/);
    expect(() => patchCells(1_000_000)).toThrow(/Earth is full/);
  });

  it('refuses a site id that is not one — negative, fractional or non-finite', () => {
    // Deliberately STRICTER than siteOf(), which clamps negatives and truncates
    // fractions so a malformed map request cannot 500. Here the input is a
    // persisted primary-key-shaped integer, and coercing it would hand the caller
    // a different valley's land than the one it asked about.
    for (const bad of [-1, 0.5, NaN, Infinity, -0.001]) {
      expect(() => patchCells(bad)).toThrow(/non-negative integer/);
    }
  });

  it('refuses a tile that is not a parcel: off the grid, or a camp', () => {
    expect(() => parcelCell(0, -1, 0)).toThrow(/valley grid/);
    expect(() => parcelCell(0, WORLD.gridCols, 0)).toThrow(/valley grid/);
    expect(() => parcelCell(0, 0, WORLD.gridRows)).toThrow(/valley grid/);
    expect(() => parcelCell(0, 1.5, 0)).toThrow(/valley grid/);
    expect(() => parcelCell(0, 3, 2)).toThrow(/PvE camp/); // campCoords()[0]
  });
});

describe('first-paint budget and sim purity', () => {
  it('is NOT re-exported from the package entry point', async () => {
    // Same two reasons as the masks and the country indexes: it statically imports
    // the FINE mask and the FINE country index (6.71 KB gzip of payload, plus a
    // base64 decode at module load), and packages/sim imports this barrel.
    // Subpath-only: `@shardkeep/shared/parcelGrid`. The other half of the guard is
    // packages/sim/tests/import-graph.test.ts, which walks the real graph.
    const entry = await import('./index');
    expect(Object.keys(entry)).not.toContain('parcelCell');
    expect(Object.keys(entry)).not.toContain('patchCells');
    expect(Object.keys(entry)).not.toContain('PARCELS_PER_PATCH');
  });
});
