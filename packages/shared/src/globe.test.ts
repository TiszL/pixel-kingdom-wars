/**
 * Globe math (docs/WORLDMAP-GLOBE-PLAN.md §1.1 / §1.2). Encodes the WHY:
 *
 *  • FORWARD ↔ INVERSE MUST BE EXACT INVERSES, including at the three places
 *    orthographic projections normally break — the poles (longitude is
 *    degenerate), the antimeridian (±180° is the same place), and the limb
 *    (ρ/R rounds past 1 and `asin` returns NaN). Tap-to-select and
 *    tap-to-rotate are built on `unproject`, so a NaN there is a dead globe.
 *  • THE FAST PATH MUST NOT DRIFT FROM THE SLOW PATH. `splatCell` exists purely
 *    to get trig out of a 5,432-cell inner loop; if it ever disagrees with
 *    `project`, the globe renders a subtly wrong Earth that nothing else
 *    catches. Asserted cell-by-cell, not spot-checked.
 *  • SITES MUST CLUSTER AND MUST NEVER BE WET. Clustering is the entire reason
 *    for a Hilbert order over `hash(uuid)` (an alpha with three valleys has to
 *    read as one settled coastline, not three dots in the void), and "never in
 *    the ocean" is what makes ocean-placement impossible BY CONSTRUCTION rather
 *    than by a validation step someone can forget.
 *  • SITING IS PURE IN THE VALLEY ORDINAL AND NOTHING ELSE — never a plot,
 *    never a wallet, never a clock. This is the migration-free proof from the
 *    plan's regression register: `plots.(x, y)` is never touched.
 */
import { describe, expect, it } from 'vitest';
import { GLOBE } from './constants';
import { EARTH_COARSE } from './earthMask';
import { EARTH_FINE } from './earthMaskFine';
import { patchCells, patchCount, siteSeatLonLat } from './parcelGrid';
import {
  DEG_TO_RAD,
  RAD_TO_DEG,
  SECTOR_COUNT,
  SLOTS_PER_SITE,
  SLOT_SUB,
  bandForZoom,
  cellAtDeg,
  cellCentreDeg,
  cellIndex,
  cellIx,
  cellIy,
  coarseCellOfFineCell,
  fineCellCentreDeg,
  greatCircleKm,
  isLandCell,
  landCellList,
  landSiteCount,
  landSites,
  lonlat,
  makeFrame,
  newProjected,
  normalizeLon,
  ordinalLonLat,
  project,
  projectDeg,
  sectorBounds,
  sectorCentreDeg,
  sectorIdOf,
  sectorIdOfFineCell,
  sectorIndices,
  siteCapacity,
  siteOf,
  splatCell,
  splatIndex,
  unproject,
  unprojectDeg,
  updateFrame,
  type GlobeCamera,
} from './globe';

const CAM: GlobeCamera = { lam0: 10 * DEG_TO_RAD, phi0: 20 * DEG_TO_RAD, R: 160, cx: 160, cy: 160 };

/** Unit vector on the sphere — the only pole-safe way to compare two lon/lats. */
function vec(lonRad: number, latRad: number): [number, number, number] {
  return [Math.cos(latRad) * Math.cos(lonRad), Math.cos(latRad) * Math.sin(lonRad), Math.sin(latRad)];
}

function vecDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('orthographic projection — forward', () => {
  it('puts the camera centre at the disc centre and the antipode at maximum distance', () => {
    const c = projectDeg(10, 20, CAM);
    expect(c.x).toBeCloseTo(CAM.cx, 9);
    expect(c.y).toBeCloseTo(CAM.cy, 9);
    expect(c.cosc).toBeCloseTo(1, 9);
    expect(c.visible).toBe(true);

    const anti = projectDeg(10 + 180, -20, CAM);
    expect(anti.cosc).toBeCloseTo(-1, 9);
    expect(anti.visible).toBe(false);
  });

  it('never places a visible point outside the disc', () => {
    const p = newProjected();
    for (let lon = -180; lon < 180; lon += 3) {
      for (let lat = -90; lat <= 90; lat += 3) {
        projectDeg(lon, lat, CAM, p);
        if (!p.visible) continue;
        const rho = Math.hypot(p.x - CAM.cx, p.y - CAM.cy);
        expect(rho).toBeLessThanOrEqual(CAM.R + 1e-9);
      }
    }
  });

  it('draws north up: at φ₀ = 0 a higher latitude has a smaller screen y', () => {
    const cam: GlobeCamera = { lam0: 0, phi0: 0, R: 100, cx: 100, cy: 100 };
    expect(projectDeg(0, 40, cam).y).toBeLessThan(projectDeg(0, 10, cam).y);
    // ...and east is right.
    expect(projectDeg(20, 0, cam).x).toBeGreaterThan(projectDeg(-20, 0, cam).x);
  });
});

describe('orthographic projection — inverse round-trips', () => {
  const CAMS: GlobeCamera[] = [
    { lam0: 0, phi0: 0, R: 160, cx: 160, cy: 160 },
    CAM,
    // The two hard cameras: near-polar view, and a westward λ₀ that forces the
    // atan2 branch to wrap across the antimeridian.
    { lam0: -170 * DEG_TO_RAD, phi0: 80 * DEG_TO_RAD, R: 64, cx: 64, cy: 64 },
    { lam0: 179 * DEG_TO_RAD, phi0: -75 * DEG_TO_RAD, R: 320, cx: 400, cy: 240 },
  ];

  it('recovers every visible point on a dense grid, including the poles and the antimeridian', () => {
    const p = newProjected();
    let checked = 0;
    for (const cam of CAMS) {
      for (let lon = -180; lon <= 180; lon += 5) {
        for (let lat = -90; lat <= 90; lat += 5) {
          const lonR = lon * DEG_TO_RAD;
          const latR = lat * DEG_TO_RAD;
          project(lonR, latR, cam, p);
          if (!p.visible) continue;
          const back = unproject(p.x, p.y, cam);
          expect(back).not.toBeNull();
          // Compare as unit vectors: at a pole longitude is undefined and at the
          // antimeridian −180 and +180 are the same place, so comparing the
          // scalars directly would fail on correct output.
          expect(vecDist(vec(lonR, latR), vec(back!.lon, back!.lat))).toBeLessThan(1e-6);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(2_000); // the grid really did cover the hemisphere
  });

  it('recovers longitude too, away from the degenerate poles', () => {
    const p = newProjected();
    for (let lon = -180; lon <= 180; lon += 7) {
      for (let lat = -85; lat <= 85; lat += 7) {
        projectDeg(lon, lat, CAM, p);
        if (!p.visible || p.cosc < 1e-3) continue; // skip the limb, tested separately
        const back = unprojectDeg(p.x, p.y, CAM)!;
        expect(back.lat).toBeCloseTo(lat, 6);
        expect(normalizeLon(back.lon - normalizeLon(lon))).toBeCloseTo(0, 6);
      }
    }
  });

  it('survives the poles: the pole projects, comes back as ±90°, and never NaNs', () => {
    for (const cam of CAMS) {
      for (const lat of [90, -90]) {
        const p = projectDeg(0, lat, cam);
        if (!p.visible) continue;
        const back = unprojectDeg(p.x, p.y, cam)!;
        expect(Number.isNaN(back.lat)).toBe(false);
        expect(Number.isNaN(back.lon)).toBe(false);
        // 4 decimals, deliberately: asin's derivative is infinite at the pole,
        // so ~1e-6° of round-trip loss is inherent to the projection, not a
        // bug. 1e-6° is 11 cm on Earth — it cannot move a 15° sector or a 2°
        // mask cell, which is all this value is ever used to pick.
        expect(back.lat).toBeCloseTo(lat, 4);
      }
    }
  });

  it('survives the limb: ρ = R exactly still returns a finite lon/lat, not NaN', () => {
    // asin(ρ/R) with ρ/R a hair over 1 is the classic NaN here; the clamp in
    // unproject is what this asserts, and a tap on the rim is a real gesture.
    for (const cam of CAMS) {
      for (let a = 0; a < 360; a += 11) {
        const t = a * DEG_TO_RAD;
        const back = unproject(cam.cx + cam.R * Math.cos(t), cam.cy + cam.R * Math.sin(t), cam);
        expect(back).not.toBeNull();
        expect(Number.isFinite(back!.lon)).toBe(true);
        expect(Number.isFinite(back!.lat)).toBe(true);
      }
    }
  });

  it('returns null outside the disc — "I tapped space" is a distinct answer', () => {
    expect(unproject(CAM.cx + CAM.R + 0.001, CAM.cy, CAM)).toBeNull();
    expect(unproject(CAM.cx, CAM.cy - CAM.R - 5, CAM)).toBeNull();
    expect(unproject(0, 0, CAM)).toBeNull();
    // ...and the exact centre is the camera centre, not a divide-by-zero.
    const mid = unprojectDeg(CAM.cx, CAM.cy, CAM)!;
    expect(mid.lon).toBeCloseTo(10, 9);
    expect(mid.lat).toBeCloseTo(20, 9);
  });

  it('normalises returned longitude into the half-open [−180, 180)', () => {
    const cam: GlobeCamera = { lam0: 175 * DEG_TO_RAD, phi0: 0, R: 100, cx: 0, cy: 0 };
    for (let dx = -99; dx <= 99; dx += 3) {
      const back = unprojectDeg(dx, 0, cam)!;
      expect(back.lon).toBeGreaterThanOrEqual(-180);
      expect(back.lon).toBeLessThan(180);
    }
  });
});

describe('per-frame precomputation', () => {
  it('splatCell equals project on the cell centre — for EVERY cell', () => {
    // The whole point of the tables is ~10 flops and zero trig per cell. If the
    // fast path drifts, the globe draws a subtly wrong Earth and nothing else
    // notices, so this is exhaustive rather than sampled.
    const m = EARTH_COARSE;
    const f = makeFrame(m.cols, m.rows);
    updateFrame(f, CAM);
    const a = newProjected();
    const b = newProjected();
    const ll = { lon: 0, lat: 0 };
    let worst = 0;
    for (let iy = 0; iy < m.rows; iy++) {
      for (let ix = 0; ix < m.cols; ix++) {
        cellCentreDeg(m, ix, iy, ll);
        projectDeg(ll.lon, ll.lat, CAM, a);
        splatCell(f, ix, iy, b);
        worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.cosc - b.cosc));
        expect(b.visible).toBe(a.visible);
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('splatIndex decodes a packed cell to the same point as splatCell', () => {
    // landCellList hands the renderer packed indices, so this is the form the
    // inner loop actually calls.
    const m = EARTH_COARSE;
    const f = makeFrame(m.cols, m.rows);
    updateFrame(f, CAM);
    const a = newProjected();
    const b = newProjected();
    for (const cell of [0, 1, m.cols, m.cols * 7 + 13, m.cols * m.rows - 1]) {
      splatIndex(f, cell, a);
      splatCell(f, cellIx(m, cell), cellIy(m, cell), b);
      expect(a).toEqual(b);
    }
  });

  it('updateFrame reuses its tables, so a moving globe allocates nothing per frame', () => {
    const f = makeFrame(EARTH_COARSE.cols, EARTH_COARSE.rows);
    const sinD = f.sinD;
    const cosD = f.cosD;
    updateFrame(f, CAM);
    updateFrame(f, { ...CAM, lam0: 1 });
    expect(f.sinD).toBe(sinD);
    expect(f.cosD).toBe(cosD);
  });
});

describe('sectors — 24 × 12 of 15°, derived and never stored', () => {
  it('is exactly 288 sectors of 15° × 15°', () => {
    expect(SECTOR_COUNT).toBe(288);
    expect(GLOBE.sectorsLon * GLOBE.sectorsLat).toBe(288);
    const b = sectorBounds(0);
    expect(b.lonMax - b.lonMin).toBe(15);
    expect(b.latMax - b.latMin).toBe(15);
  });

  it('round-trips id → indices → centre → id for every sector', () => {
    for (let id = 0; id < SECTOR_COUNT; id++) {
      const { lonIdx, latIdx } = sectorIndices(id);
      expect(lonIdx * GLOBE.sectorsLat + latIdx).toBe(id);
      const c = sectorCentreDeg(id);
      expect(sectorIdOf(c.lon, c.lat)).toBe(id);
      const b = sectorBounds(id);
      expect(c.lon).toBeGreaterThan(b.lonMin);
      expect(c.lon).toBeLessThan(b.lonMax);
    }
  });

  it('is half-open, so a shared edge belongs to exactly one sector', () => {
    const b = sectorBounds(sectorIdOf(0, 0));
    expect(b.lonMin).toBe(0);
    expect(b.latMin).toBe(0);
    expect(sectorIdOf(14.999, 0)).toBe(sectorIdOf(0, 0));
    expect(sectorIdOf(15, 0)).not.toBe(sectorIdOf(0, 0));
  });

  it('wraps longitude and clamps the poles instead of throwing', () => {
    expect(sectorIdOf(-180, 0)).toBe(sectorIdOf(180, 0));
    expect(sectorIdOf(190, 0)).toBe(sectorIdOf(-170, 0));
    expect(sectorIdOf(0, 90)).toBe(sectorIdOf(0, 89.999));
    expect(sectorIdOf(0, -90)).toBe(sectorIdOf(0, -89.999));
  });
});

describe('fine cells → sectors and coarse cells (D-096: markers anchor to real base cells)', () => {
  const total = GLOBE.fineCols * GLOBE.fineRows;

  it('relies on exact integer divisibility, and says so', () => {
    // The helpers are `| 0` divisions with no remainder handling. If a future grid
    // shape broke these ratios the maths would silently shift every sector edge.
    expect(GLOBE.fineCols % GLOBE.sectorsLon).toBe(0);
    expect(GLOBE.fineRows % GLOBE.sectorsLat).toBe(0);
    expect(GLOBE.fineCols % GLOBE.coarseCols).toBe(0);
    expect(GLOBE.fineRows % GLOBE.coarseRows).toBe(0);
  });

  it('centres a fine cell exactly where the fine mask says it is', () => {
    // `fineCellCentreDeg` exists so first-paint code can place a frozen cell WITHOUT
    // the 5.3 KB mask; it must not become a second, subtly different grid.
    const a = { lon: 0, lat: 0 };
    const b = { lon: 0, lat: 0 };
    for (let cell = 0; cell < total; cell += 97) {
      fineCellCentreDeg(cell, a);
      cellCentreDeg(EARTH_FINE, cellIx(EARTH_FINE, cell), cellIy(EARTH_FINE, cell), b);
      expect(a).toEqual(b);
    }
  });

  it('agrees with sectorIdOf on the cell centre — for EVERY fine cell', () => {
    // Exhaustive rather than sampled for the same reason the splat test is: a
    // sector edge that drifts by one row shows up only in the row it drifted in.
    const ll = { lon: 0, lat: 0 };
    for (let cell = 0; cell < total; cell++) {
      fineCellCentreDeg(cell, ll);
      if (sectorIdOfFineCell(cell) !== sectorIdOf(ll.lon, ll.lat)) {
        throw new Error(`cell ${cell}: sectorIdOfFineCell ${sectorIdOfFineCell(cell)} ≠ sectorIdOf ${sectorIdOf(ll.lon, ll.lat)}`);
      }
    }
    // A sector holds exactly 30 × 30 fine cells, and the half-open edge belongs to
    // the sector on its east/north side, matching sectorIdOf.
    expect(sectorIdOfFineCell(0)).toBe(sectorIdOf(-179.75, 89.75));
    expect(sectorIdOfFineCell(29)).toBe(sectorIdOfFineCell(0));
    expect(sectorIdOfFineCell(30)).not.toBe(sectorIdOfFineCell(0));
    expect(sectorIdOfFineCell(total - 1)).toBe(sectorIdOf(179.75, -89.75));
  });

  it('puts a fine cell in the coarse cell that contains it, 16 to a cell', () => {
    const ll = { lon: 0, lat: 0 };
    for (let cell = 0; cell < total; cell += 13) {
      fineCellCentreDeg(cell, ll);
      const c = cellAtDeg(EARTH_COARSE, ll.lon, ll.lat);
      expect(coarseCellOfFineCell(cell)).toBe(cellIndex(EARTH_COARSE, c.ix, c.iy));
    }
    // Every coarse cell is hit by exactly 4 × 4 fine cells.
    const hits = new Map<number, number>();
    for (let cell = 0; cell < total; cell++) {
      const k = coarseCellOfFineCell(cell);
      hits.set(k, (hits.get(k) ?? 0) + 1);
    }
    expect(hits.size).toBe(GLOBE.coarseCols * GLOBE.coarseRows);
    expect([...hits.values()].every((n) => n === SLOT_SUB * SLOT_SUB)).toBe(true);
  });

  it('proves the valley SEAT was the wrong anchor: its parcels are counted elsewhere', () => {
    // WHY THIS TEST EXISTS (D-096). Sector totals and region pins used to be bucketed
    // from `siteSeatLonLat(siteOf(site_id))`, while the valley's bases sit in patch
    // #site_id — ~45 coarse cells further along the Hilbert walk. This turns the
    // 2026-09-02 scratch measurement into a reproducible fact: EVERY patch holds a
    // parcel the seat's sector does not contain, and every patch but site 0 holds no
    // parcel inside it at all (site 0 is the one seat that coincides with its patch's
    // first cell — parcelGrid.ts documents why). Reverting the aggregate to seats
    // would make this red, and it explains why seats are gone rather than tuned.
    const n = patchCount();
    let patchesWithAStray = 0;
    let patchesFullyElsewhere = 0;
    for (let site = 0; site < n; site++) {
      const seat = siteSeatLonLat(siteOf(site));
      const seatSector = sectorIdOf(seat.lon, seat.lat);
      let elsewhere = 0;
      const cells = patchCells(site);
      for (const cell of cells) if (sectorIdOfFineCell(cell) !== seatSector) elsewhere++;
      if (elsewhere > 0) patchesWithAStray++;
      if (elsewhere === cells.length) patchesFullyElsewhere++;
      // The named sites the plan measured, pinned individually so a single
      // regenerated patch cannot hide inside the totals.
      if (site === 1 || site === 10 || site === 50) expect(elsewhere).toBe(cells.length);
    }
    expect(patchesWithAStray).toBe(n);
    expect(patchesFullyElsewhere).toBe(n - 1);
    // …and the distances behind the "1 BASES pin that zooms into empty ground":
    // site 1's seat is at least 800 km from every one of its parcels.
    const seat1 = siteSeatLonLat(siteOf(1));
    const ll = { lon: 0, lat: 0 };
    for (const cell of patchCells(1)) {
      fineCellCentreDeg(cell, ll);
      expect(greatCircleKm(seat1.lon, seat1.lat, ll.lon, ll.lat)).toBeGreaterThan(800);
    }
  });
});

describe('land sites — a valley ordinal becomes a place on Earth', () => {
  it('lists every land cell of the coarse mask exactly once', () => {
    const sites = landSites();
    expect(sites.length).toBe(EARTH_COARSE.landCells);
    expect(new Set(sites).size).toBe(sites.length);
    expect([...sites].sort((a, b) => a - b)).toEqual([...landCellList(EARTH_COARSE)]);
  });

  it('NEVER returns an ocean cell — ocean placement is impossible by construction', () => {
    // The site list IS the land-cell list, so this cannot be defeated by a
    // forgotten validation step. Checked across four full wraps of the lattice.
    const n = landSiteCount();
    for (const ordinal of [0, 1, 2, 3, 17, 499, 5_000, n - 1, n, n + 1, 2 * n + 7, 4 * n - 1]) {
      const s = siteOf(ordinal);
      expect(isLandCell(EARTH_COARSE, s.cell)).toBe(true);
      const ll = lonlat(s.cell, s.slot);
      // the slot offset must stay inside its own land cell
      const c = cellAtDeg(EARTH_COARSE, ll.lon, ll.lat);
      expect(c.ix).toBe(cellIx(EARTH_COARSE, s.cell));
      expect(c.iy).toBe(cellIy(EARTH_COARSE, s.cell));
    }
    for (let ordinal = 0; ordinal < 4_000; ordinal += 7) {
      expect(isLandCell(EARTH_COARSE, siteOf(ordinal).cell)).toBe(true);
    }
  });

  it('CLUSTERS consecutive ordinals — the reason for Hilbert over hash(uuid)', () => {
    // An alpha with three valleys must read as one settled coastline. A hash
    // would scatter them ~10,000 km apart (a random pair on Earth averages
    // ~8,800 km), so this bound is the difference between "settlement" and
    // "confetti", not a tolerance.
    let sum = 0;
    let worstMedianBucket = 0;
    const d: number[] = [];
    for (let o = 0; o < 3_000; o++) {
      const a = ordinalLonLat(o);
      const b = ordinalLonLat(o + 1);
      const km = greatCircleKm(a.lon, a.lat, b.lon, b.lat);
      d.push(km);
      sum += km;
      if (km > 2_000) worstMedianBucket++;
    }
    d.sort((x, y) => x - y);
    const median = d[Math.floor(d.length / 2)]!;
    expect(median).toBeLessThan(300); // one 2° cell is ~220 km at the equator
    expect(sum / d.length).toBeLessThan(500);
    // Clipping the Hilbert square to a 180×90 grid leaves a handful of long
    // jumps; they must stay rare enough to be invisible as settlement pattern.
    expect(worstMedianBucket / d.length).toBeLessThan(0.02);

    // ...and the first few valleys, which is what the alpha actually renders.
    const first = ordinalLonLat(0);
    for (const o of [1, 2, 3]) {
      const p = ordinalLonLat(o);
      expect(greatCircleKm(first.lon, first.lat, p.lon, p.lat)).toBeLessThan(1_000);
    }
  });

  it('is pure in the ordinal and nothing else, and stable across calls', () => {
    // The migration-free proof: siting reads no plot, no wallet and no clock.
    // (90_001 used to be one of these probes; it is now PAST siteCapacity()
    // 86,912 and therefore throws — see the overflow test below. It was only ever
    // meant to be "a big ordinal", so it is replaced by the largest ordinal the
    // lattice actually seats, which tests the same purity property honestly.)
    for (const o of [0, 41, 1_234, siteCapacity() - 1]) {
      expect(siteOf(o)).toEqual(siteOf(o));
      expect(ordinalLonLat(o)).toEqual(ordinalLonLat(o));
    }
    // Negative / fractional ordinals are STILL coerced rather than rejected, and
    // that is deliberate: a malformed map request must not be a crash, and both
    // coercions land on a real, single site. Only inputs that would resolve to a
    // site the caller did not ask for are refused (next test).
    expect(siteOf(-5)).toEqual(siteOf(0));
    expect(siteOf(3.9)).toEqual(siteOf(3));
  });

  it('THROWS past the end of the lattice instead of siting on top of valley 0', () => {
    // Was: `landSites()[o % n]` with `slot % SLOTS_PER_SITE`, so ordinal
    // siteCapacity() resolved to EXACTLY ordinal 0's cell and slot — the same
    // point on Earth, silently, for two different valleys and therefore two
    // different deeds. Unreachable at 86,912 valleys; reachable in a successful
    // launch once a tile is one player's land (docs/EARTH-TILES-PLAN.md R10).
    // Running out of Earth is a real event with a real answer (a second planet),
    // so it must surface as an error, not as duplicated land.
    const cap = siteCapacity();
    expect(() => siteOf(cap)).toThrow(/full/i);
    expect(() => siteOf(cap + 1)).toThrow();
    expect(() => siteOf(cap * 3)).toThrow();
    // The last seat is legal and is NOT the first seat — the off-by-one that
    // would make the guard fire one valley early, or one valley late.
    expect(() => siteOf(cap - 1)).not.toThrow();
    expect(siteOf(cap - 1)).not.toEqual(siteOf(0));
    // A non-finite ordinal used to return `{ cell: undefined }` through a `!`
    // assertion and paint a NaN lon/lat; it is now refused for the same reason.
    expect(() => siteOf(Number.NaN)).toThrow();
    expect(() => siteOf(Number.POSITIVE_INFINITY)).toThrow();
    // −Infinity IS NON-FINITE TOO, and it used to be the one that got through
    // (adversarial pass D8, 2026-08-10): the finiteness test ran AFTER
    // `Math.max(0, Math.trunc(ordinal))`, which had already turned it into 0, so
    // `siteOf(-Infinity)` quietly answered with VALLEY 0's real place while the
    // docstring said non-finite was illegal. NaN threw, +Infinity threw, −Infinity
    // handed out somebody's land: the docstring and the code now agree, and they
    // agree on the throw, because −Infinity is not "the smallest ordinal".
    expect(() => siteOf(Number.NEGATIVE_INFINITY)).toThrow();
    // …and the deliberate clamp is untouched, which is what makes the fix a fix
    // rather than a tightening: a FINITE negative is still valley 0.
    expect(siteOf(-1e9)).toEqual(siteOf(0));
  });

  it('gives every ordinal in a site a distinct point inside the same cell', () => {
    const n = landSiteCount();
    const seen = new Set<string>();
    for (let slot = 0; slot < SLOTS_PER_SITE; slot++) {
      const s = siteOf(slot * n); // same cell, successive slots
      expect(s.cell).toBe(siteOf(0).cell);
      expect(s.slot).toBe(slot);
      const ll = lonlat(s.cell, s.slot);
      seen.add(`${ll.lon.toFixed(6)},${ll.lat.toFixed(6)}`);
    }
    expect(seen.size).toBe(SLOTS_PER_SITE);
    expect(SLOT_SUB * SLOT_SUB).toBe(SLOTS_PER_SITE); // the slot lattice must be square
  });

  it('seats the capacity the scale verdict in plan §2 is built on', () => {
    expect(siteCapacity()).toBe(landSiteCount() * SLOTS_PER_SITE);
    // ≥ 70k valleys × 491 player plots ≈ 34 M players before the lattice needs
    // the fine-mask escape hatch (plan §2).
    expect(siteCapacity()).toBeGreaterThan(70_000);
  });
});

describe('cross-package contract', () => {
  it('exposes the eight functions and five tuning numbers apps/api resolves BY NAME', async () => {
    // apps/api/src/lib/globeGeo.ts deliberately looks these up by name in ONE file,
    // rather than assembling a second, subtly different planet — so a rename here is
    // a server that disagrees with the client about where valley #7 is. The names
    // are therefore pinned here.
    //
    // ON THE SUBPATH, NOT THE BARREL: this module is reached at
    // `@shardkeep/shared/globe` and is deliberately absent from index.ts, because
    // packages/sim imports the barrel and an `export *` would drag this file's trig
    // into the deterministic simulator's module graph (see index.ts's header and
    // packages/sim/tests/import-graph.test.ts). Both halves are asserted: present
    // here, absent there.
    const mod = (await import('./globe')) as unknown as Record<string, unknown>;
    const barrel = (await import('./index')) as unknown as Record<string, unknown>;
    for (const fn of [
      'siteOf', 'lonlat', 'sectorIdOf', 'sectorCentreDeg', 'greatCircleKm',
      // D-096: the cell-based anchors the globe aggregate buckets and centres by.
      'sectorIdOfFineCell', 'coarseCellOfFineCell', 'fineCellCentreDeg',
    ]) {
      expect(typeof mod[fn]).toBe('function');
      expect(barrel[fn], `${fn} must NOT be on the shared barrel`).toBeUndefined();
    }
    // No `trophyBucket` since D-099: the reach histogram is keyed on Keep level,
    // which needs no width constant — a level IS its own bucket.
    for (const k of ['sectorsLon', 'sectorsLat', 'valleysPerSectorCap', 'cacheSec'] as const) {
      expect(typeof GLOBE[k]).toBe('number');
    }
  });
});

describe('zoom bands', () => {
  it('derives the band from the single zoom scalar', () => {
    expect(bandForZoom(GLOBE.zoomMin)).toBe('globe');
    expect(bandForZoom(GLOBE.regionZoom - 0.001)).toBe('globe');
    expect(bandForZoom(GLOBE.regionZoom)).toBe('region');
    expect(bandForZoom(GLOBE.localZoom - 0.001)).toBe('region');
    expect(bandForZoom(GLOBE.localZoom)).toBe('local');
    expect(bandForZoom(99)).toBe('local');
  });
});

describe('helpers', () => {
  it('normalizeLon maps every wrap onto the half-open [−180, 180)', () => {
    // −180, not +180, so the antimeridian lands in mask column 0 and sector 0
    // rather than the last one. That off-by-one would only ever appear in the
    // Pacific, so it must be pinned here.
    expect(normalizeLon(180)).toBe(-180);
    expect(normalizeLon(-180)).toBe(-180);
    expect(normalizeLon(181)).toBeCloseTo(-179, 12);
    expect(normalizeLon(-181)).toBeCloseTo(179, 12);
    expect(normalizeLon(720 + 30)).toBeCloseTo(30, 12);
    expect(sectorIdOf(-180, -90)).toBe(0);
  });

  it('greatCircleKm matches known distances', () => {
    // London → Cairo ≈ 3,500 km; London → Sydney ≈ 16,990 km.
    expect(greatCircleKm(-0.13, 51.5, 31.24, 30.04)).toBeGreaterThan(3_300);
    expect(greatCircleKm(-0.13, 51.5, 31.24, 30.04)).toBeLessThan(3_700);
    expect(greatCircleKm(-0.13, 51.5, 151.21, -33.87)).toBeGreaterThan(16_500);
    expect(greatCircleKm(0, 0, 0, 0)).toBe(0);
  });

  it('RAD_TO_DEG and DEG_TO_RAD are inverses', () => {
    expect(180 * DEG_TO_RAD * RAD_TO_DEG).toBeCloseTo(180, 12);
  });
});
