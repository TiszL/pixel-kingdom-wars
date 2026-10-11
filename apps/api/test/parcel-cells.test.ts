/**
 * THE SERVER'S HALF OF THE EARTH-TILE LAYER (docs/EARTH-TILES-PLAN.md P4a).
 *
 * Two jobs, and the first one is the important one.
 *
 * 1. THE MIRROR GUARD. `packages/shared/src/parcelGrid.ts` re-implements two
 *    formulas that live in `apps/api/src/game/world.ts` — `plotFillOrder`'s
 *    5→3→2→1 stride and `campCoords`'s camp lattice — because `shared` cannot
 *    import the server and R1/R2 require those two functions to stay
 *    byte-identical through P4 (they are the guard surface for `plots`, the
 *    highest-stakes table in the system). Duplication is only safe if divergence
 *    is LOUD, and this is what makes it loud: if either formula changes on either
 *    side, these tests fail here instead of quietly relocating land that deeds
 *    convey.
 * 2. THE SEAM. `globeGeo.ts` is the only file in apps/api allowed to touch the
 *    generated Earth data, so "does the server agree with the client about tile
 *    X?" stays a one-file question — and since D1 (2026-08-10) it is a WRITE-TIME
 *    seam: the only production caller is `tryAssignInValley` freezing a new plot's
 *    `earth_cell` + `country_a3`, plus `createValley`'s capacity guard. Nothing that
 *    SERVES a stored parcel is allowed back through here, which is what
 *    earth-address.test.ts's import scan of the deed path asserts.
 *
 * THERE IS NO `PARCEL_CELLS` FLAG ANY MORE (D6, 2026-08-10). It was documented as
 * the lever that kept a cell or a country off the wire and it had no production
 * caller at all — no API response carries either; the globe derives tiles in the
 * browser behind `VITE_FEATURE_EARTH_TILES`. It was deleted rather than wired,
 * because wiring it meant inventing a payload to gate. The tests that pinned its
 * parsing went with it; `DEED_LOCATION_V2` (deed.test.ts) is the real switch.
 */
import { describe, expect, it } from 'vitest';
import { WORLD } from '@shardkeep/shared';
import { cellCentreDeg, cellIx, cellIy } from '@shardkeep/shared/globe';
import { EARTH_FINE } from '@shardkeep/shared/earthMaskFine';
import { PARCELS_PER_PATCH, fillIndex, parcelCell, tileOfFillIndex } from '@shardkeep/shared/parcelGrid';
import { NO_SOVEREIGN_A3, globeGeo, setGlobeGeo, type GlobeGeo } from '../src/lib/globeGeo';
import { campCoords, plotFillOrder } from '../src/game/world';

describe('parcelGrid mirrors world.ts, and the mirror is enforced', () => {
  it('agrees with campCoords() on which 9 tiles are camps, tile for tile', () => {
    // WHY IT MATTERS: a camp holds a grid tile but is not deeded land, so it gets
    // no Earth cell. If the two lattices ever drift, some camp tile becomes a
    // parcel AND some parcel loses its cell — and because 500 tiles would then map
    // into 491 cells, two players would share one cell in silence (R2 + R10).
    const camps = new Set(campCoords().map((c) => `${c.x},${c.y}`));
    expect(camps.size).toBe(WORLD.campsPerValley);
    const refused = new Set<string>();
    for (let y = 0; y < WORLD.gridRows; y++) {
      for (let x = 0; x < WORLD.gridCols; x++) {
        try { fillIndex(x, y); } catch { refused.add(`${x},${y}`); }
      }
    }
    expect([...refused].sort()).toEqual([...camps].sort());
  });

  it('agrees with plotFillOrder() on the order the 491 deeded tiles fill', () => {
    // WHY IT MATTERS: the patch's cells are contiguous, so index 0 and index 1 are
    // Earth neighbours. Keying off the SAME order plot assignment uses is what
    // makes a valley's first arrivals neighbours on Earth rather than scattered
    // across a stride-5 lattice — and, more sharply, a reordering here silently
    // moves every existing parcel's cell.
    const order = plotFillOrder();
    expect(order.length).toBe(WORLD.gridCols * WORLD.gridRows);
    const camps = new Set(campCoords().map((c) => `${c.x},${c.y}`));
    const deeded = order.filter(([x, y]) => !camps.has(`${x},${y}`));
    expect(deeded.length).toBe(PARCELS_PER_PATCH);
    deeded.forEach(([x, y], i) => {
      expect(fillIndex(x, y)).toBe(i);
      expect(tileOfFillIndex(i)).toEqual({ x, y });
    });
  });
});

describe('globeGeo is the one seam for a parcel\'s place on Earth', () => {
  it('resolves a parcel to a cell and to the country CODE that gets frozen', () => {
    const geo = globeGeo();
    const cell = geo.parcelCell!(0, 0, 0);
    expect(cell).toBe(parcelCell(0, 0, 0));
    // `ADM0_A3` AND NOT AN ID OR A NAME (D1). The index's numeric ids are ranks in
    // an `ADM0_A3`-sorted list, so a data refresh renumbers them, and the NAME is a
    // display string the same refresh can reword. The code is the identity — the
    // very sort key those ranks are ranks in — which is why it is what
    // `plots.country_a3` stores and what this seam returns. The NAME lives in the
    // `earth_countries` registry, which only a migration changes.
    expect(geo.countryA3!(cell)).toBe('RUS');
    // site_id 0 is Chukotka on the Bering Strait, so the alpha's only valley is in
    // Russia and its far corner is in the USA. Natural Earth's de-facto boundary
    // set, never redrawn here (R20).
    expect(geo.countryA3!(geo.parcelCell!(0, 24, 19))).toBe('USA');
    const d = cellCentreDeg(EARTH_FINE, cellIx(EARTH_FINE, cell), cellIy(EARTH_FINE, cell));
    expect(d).toEqual({ lon: -173.75, lat: 66.75 });
  });

  it('says "ZZZ" for ground with no sovereign rather than inventing one', () => {
    const geo = globeGeo();
    // ISO 3166-1 reserves ZZZ for user assignment, so it cannot be a real country;
    // earth-address.test.ts asserts that against all 240 features, and there is no
    // `earth_countries` row for it, so a deed omits the trait instead of naming it.
    expect(geo.countryA3!(0)).toBe(NO_SOVEREIGN_A3); // lon −180, lat +90: ocean
    // Antarctica: land in the mask, dropped from the country table (owner Q4a), so
    // it shares the ocean sentinel — "has a sovereign" is the single "is this
    // claimable" test, which is why the two must NOT be distinguishable here.
    expect(geo.countryA3!(cellIndexOf(0, -75))).toBe(NO_SOVEREIGN_A3);
  });

  it('reports a FINITE Earth — 120 valleys, 58,920 parcels', () => {
    // Not 82,488: that figure predates owner decision Q4a (drop Antarctica), which
    // took 24,276 land cells out of claimable Earth. Selling out is the point, so
    // the number the server reports has to be the real one.
    const geo = globeGeo();
    expect(geo.patchCount!()).toBe(120);
    expect(geo.parcelCapacity!()).toBe(58_920);
    expect(() => geo.parcelCell!(120, 0, 0)).toThrow(/Earth is full/);
  });

  it('lets a substitute planet omit the tile layer entirely', () => {
    // R14: apps/api/test/globe.test.ts drives a four-site FAKE planet through this
    // seam and must stay green UNTOUCHED. That is only possible while the Earth-tile
    // members are optional — a fake planet has no country data, and every caller
    // has to handle "no tile layer" anyway (game/world.ts refuses the seat with a
    // typed 500 rather than inventing an address).
    const FAKE: GlobeGeo = {
      tuning: { sectorsLon: 4, sectorsLat: 2, valleysPerSectorCap: 2, cacheSec: 60 },
      siteOf: (o) => ({ cell: o % 4, slot: (o / 4) | 0 }),
      lonlat: (cell, slot) => ({ lon: -135 + cell * 90 + slot * 0.5, lat: 45 }),
      // The cell anchors are REQUIRED (globeGeo.ts): a substitute planet states
      // them in one line each, mask-free, and the tile layer stays optional.
      sectorIdOfFineCell: (cell) => cell % 4,
      coarseCellOfFineCell: (cell) => cell,
      fineCellCentreDeg: (cell) => ({ lon: -135 + (cell % 4) * 90, lat: 45 }),
      sectorIdOf: (lon) => Math.min(3, Math.max(0, Math.floor((lon + 180) / 90))),
      sectorCentreDeg: (id) => ({ lon: -135 + id * 90, lat: 45 }),
      greatCircleKm: (aLon, aLat, bLon, bLat) => Math.abs(aLon - bLon) + Math.abs(aLat - bLat),
    };
    setGlobeGeo(FAKE);
    try {
      expect(globeGeo().parcelCell).toBeUndefined();
      expect(globeGeo().countryA3).toBeUndefined();
      expect(globeGeo().patchCount).toBeUndefined();
    } finally {
      setGlobeGeo(null);
    }
    expect(globeGeo().parcelCell).toBeDefined();
    expect(globeGeo().countryA3).toBeDefined();
  });
});

/** A fine-mask cell index from degrees — local so the test states its own geometry. */
function cellIndexOf(lon: number, lat: number): number {
  const ix = Math.floor((lon + 180) / (360 / EARTH_FINE.cols));
  const iy = Math.floor((90 - lat) / (180 / EARTH_FINE.rows));
  return iy * EARTH_FINE.cols + ix;
}
