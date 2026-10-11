/**
 * EVERY PARCEL IS ON REAL EARTH, IN A REAL COUNTRY — asserted against the shipped
 * data rather than described. (P3/P4b, 2026-08-10)
 *
 * This file is the other half of the ~270 lines `globeView.test.ts` deleted. Those
 * tests pinned a screen-space lattice: a pitch derived from the board's short side, a
 * 44 px gate, hit radii that tiled a grid nothing existed on. The premise changed
 * (owner Q1, 2026-08-10 — a tile is one real 0.5° Earth land cell), so the assertions
 * change with it, and the one the owner actually asked for is now DIRECTLY testable:
 *
 *   THE OWNER'S COMPLAINT, AS AN ASSERTION — every parcel of every patch resolves to a
 *   CLAIMABLE cell, i.e. ground with a sovereign, so a parcel in the water is not
 *   merely unlikely, it is impossible by construction.
 *
 * It runs against the REAL generated modules (both masks, the fine country index, the
 * real `parcelGrid`) because the whole point of the phase is that the data agrees:
 * mocking any of it would test the mock. A test may import `@shardkeep/shared/
 * parcelGrid` statically; the CLIENT may not, and `GlobeLayer`'s `await import()` is
 * what keeps the first-paint delta at 0 KB.
 */
import { EARTH_COARSE } from '@shardkeep/shared/earthMask';
import { EARTH_COUNTRIES_FINE } from '@shardkeep/shared/earthCountriesFine';
import { EARTH_FINE } from '@shardkeep/shared/earthMaskFine';
import * as parcelGrid from '@shardkeep/shared/parcelGrid';
import {
  cellAtDeg, countryIdOfCell, isLandCell, landSiteCount, lonlat, sectorCentreDeg, siteOf,
} from '@shardkeep/shared/globe';
import { describe, expect, it } from 'vitest';
import {
  cellOwnership, degText, earthCellCentre, patchCountries, placeParcels, seatLonLat, siteIdOfLonLat, tileCode,
  tileCountry, tileFacts, tileOrdinal,
} from './tiles';
import { type ParcelRow } from './globeView';

const IDX = EARTH_COUNTRIES_FINE;
const FINE = EARTH_FINE;
/** Degrees → the fine mask's packed cell, so "is this point on land?" is one call. */
const cellIndex = (lon: number, lat: number): number => {
  const c = cellAtDeg(FINE, lon, lat);
  return c.iy * FINE.cols + c.ix;
};
/** The measured shape of Earth under the shipped data (docs/EARTH-TILES-PLAN.md §9 +
 *  the P4a addendum): 120 patches of 491 claimable cells, 58,920 parcels. Pinned here
 *  because every assertion below is only meaningful against the same planet. */
const PATCHES = 120;

describe('a frozen deed address is the point rendered on Earth', () => {
  it('converts the persisted cell directly and round-trips to the same cell', () => {
    const cell = parcelGrid.parcelCell(0, 0, 0);
    const at = earthCellCentre(cell)!;
    expect(cellIndex(at.lon, at.lat)).toBe(cell);
    expect(earthCellCentre(-1)).toBeNull();
    expect(earthCellCentre(FINE.cols * FINE.rows)).toBeNull();
    expect(earthCellCentre(1.5)).toBeNull();
  });
});

describe('the legacy raw-lattice inverse explains why the wire now carries siteId', () => {
  it('round-trips EVERY site the wire can carry — it is an inverse, not a guess', () => {
    // `siteIdOfLonLat` is the only place the client reconstructs a frozen server
    // integer, and it is load-bearing: `parcelCell(site_id, x, y)` cannot be called
    // without it while `GlobeSectorValley` carries no ordinal. So it is asserted over a
    // wide sweep rather than at one point — 4,000 ordinals is ~74× the live world and
    // covers slot wraps (a slot changes every 5,432 ordinals).
    for (let o = 0; o < 4_000; o++) {
      const s = siteOf(o);
      const at = lonlat(s.cell, s.slot);
      expect(siteIdOfLonLat(EARTH_COARSE, at.lon, at.lat)).toBe(o);
    }
    // Slot 1 and slot 2 explicitly, so a change to SLOT_SUB cannot pass by only ever
    // being tested inside the first slot.
    for (const o of [landSiteCount(), landSiteCount() * 2 + 17]) {
      const s = siteOf(o);
      const at = lonlat(s.cell, s.slot);
      expect(siteIdOfLonLat(EARTH_COARSE, at.lon, at.lat)).toBe(o);
    }
  });

  it('recovers production’s only valley as site 0 — Chukotka, exactly as sited', () => {
    // The live world, so a regression here is a regression in what somebody owns.
    const at = lonlat(siteOf(0).cell, siteOf(0).slot);
    expect(at).toEqual({ lon: -173.75, lat: 67.75 });
    expect(siteIdOfLonLat(EARTH_COARSE, at.lon, at.lat)).toBe(0);
  });

  it('REFUSES a point that is not a site, instead of snapping to the nearest one', () => {
    // A sector centre is what `homeAt` falls back to when the valley is unknown, and a
    // camera position is what a drag produces. Both are ordinary points on the globe:
    // answering them with a site id would place somebody's parcels on a patch chosen by
    // where the camera happened to be.
    expect(siteIdOfLonLat(EARTH_COARSE, sectorCentreDeg(0).lon, sectorCentreDeg(0).lat)).toBeNull();
    expect(siteIdOfLonLat(EARTH_COARSE, 0.123, 51.7)).toBeNull();
    // Mid-Pacific: on the slot lattice or not, there is no land cell there.
    expect(siteIdOfLonLat(EARTH_COARSE, -140.75, -20.25)).toBeNull();
    expect(siteIdOfLonLat(EARTH_COARSE, Number.NaN, 0)).toBeNull();
  });
});

describe('THE VALLEY PIN IS ON LAND TOO — the same complaint, one level up (D3)', () => {
  it('re-seats production’s valley out of the Bering Strait without leaving its patch', () => {
    // WHAT THE OWNER SEES FIRST is the valley pin, and the shipped siting puts it in
    // open water: `lonlat` offsets onto a blind 4×4 sub-lattice inside the 2° cell and
    // nothing re-checks. 4,203 of 86,912 sites (4.84%) are 0.5° water and site 0 — the
    // only valley in production — is one of them.
    const at = lonlat(siteOf(0).cell, siteOf(0).slot);
    expect(at).toEqual({ lon: -173.75, lat: 67.75 });
    expect(isLandCell(FINE, cellIndex(at.lon, at.lat))).toBe(false);

    const seat = seatLonLat(parcelGrid, 0);
    expect(seat).toEqual({ lon: -173.75, lat: 66.75 });
    expect(isLandCell(FINE, cellIndex(seat!.lon, seat!.lat))).toBe(true);
    // The exact old client bug: the API now sends this SEATED point. Treating it as
    // identity does not recover site 0, so the client must consume wire `siteId`.
    expect(siteIdOfLonLat(EARTH_COARSE, seat!.lon, seat!.lat)).not.toBe(0);
    // THE IDENTITY IS UNCHANGED, which is what stops this from relocating anybody: the
    // site id is still recovered from the SERVER's point, the patch is a pure function
    // of that id, and the seat is a sub-cell of the same 2° cell.
    expect(siteIdOfLonLat(EARTH_COARSE, at.lon, at.lat)).toBe(0);
    expect(parcelGrid.parcelOf(cellIndex(seat!.lon, seat!.lat))).toEqual({ siteId: 0, x: 0, y: 0 });
  });

  it('never seats a pin outside the valley’s own 2° cell, over the whole lattice', () => {
    // The one invariant the chrome depends on: a pin may move tens of km onto adjacent
    // land, never into another region — because `siteIdOfLonLat`, the patch, the sector
    // aggregate and the roster are all keyed off the ORIGINAL point.
    for (let o = 0; o < 4_000; o += 7) {
      const s = siteOf(o);
      const before = lonlat(s.cell, s.slot);
      const seat = seatLonLat(parcelGrid, o);
      expect(seat).not.toBeNull();
      expect(isLandCell(FINE, cellIndex(seat!.lon, seat!.lat))).toBe(true);
      const cx = Math.floor((seat!.lon + 180) / (360 / EARTH_COARSE.cols));
      const cy = Math.floor((90 - seat!.lat) / (180 / EARTH_COARSE.rows));
      expect(cy * EARTH_COARSE.cols + cx).toBe(s.cell);
      expect(Math.abs(seat!.lon - before.lon)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(seat!.lat - before.lat)).toBeLessThanOrEqual(1.5);
    }
  });

  it('answers null instead of throwing for an ordinal Earth does not seat', () => {
    // The layer falls back to the server's own point when a seat cannot be produced,
    // so a bad ordinal must not take the whole pin layer down with it.
    expect(seatLonLat(parcelGrid, landSiteCount() * 16)).toBeNull(); // past siteCapacity()
    expect(seatLonLat(parcelGrid, Number.NaN)).toBeNull();
  });
});

describe('A VALLEY IS NOT A COUNTRY, and the chrome must not imply it is (D11)', () => {
  it('measures 91 of 120 patches spanning more than one country, worst case 21', () => {
    // A DESIGN CONSEQUENCE THE PLAN NEVER STATED. A patch is 491 CONSECUTIVE claimable
    // cells — which is precisely what makes a valley's neighbours Earth neighbours —
    // and consecutive cells near a border are in two countries. Nothing here is a bug
    // to fix; it is a fact the UI has to say out loud, so it is pinned as a number.
    let multi = 0;
    let worst = 0;
    let total = 0;
    for (let site = 0; site < PATCHES; site++) {
      const cs = patchCountries(FINE, IDX, parcelGrid, site);
      const sum = cs.reduce((a, c) => a + c.cells, 0);
      expect(sum).toBe(parcelGrid.PARCELS_PER_PATCH); // every cell counted exactly once
      // Descending by share, so the chrome can name the majority country first.
      for (let i = 1; i < cs.length; i++) expect(cs[i - 1]!.cells).toBeGreaterThanOrEqual(cs[i]!.cells);
      if (cs.length > 1) multi++;
      worst = Math.max(worst, cs.length);
      total += cs.length;
    }
    expect(multi).toBe(91);
    expect(worst).toBe(21);
    expect(total / PATCHES).toBeCloseTo(4.17, 2);
  });

  it('names production’s own valley as TWO countries — 420 American cells, 71 Russian', () => {
    // The alpha's single valley is a Russian pin over a mostly-American patch. If the
    // chrome ever says "your valley is in <country>", this is the row that makes it a
    // lie, so the numbers are pinned where a copy change would have to face them.
    const cs = patchCountries(FINE, IDX, parcelGrid, 0);
    expect(cs.map((c) => [c.name, c.cells])).toEqual([
      ['United States of America', 420],
      ['Russia', 71],
    ]);
    // …and the valley's own PIN is in the minority country, which is the sharpest
    // possible statement of "a valley is not a country".
    const seat = seatLonLat(parcelGrid, 0)!;
    expect(tileCountry(FINE, IDX, cellIndex(seat.lon, seat.lat))?.name).toBe('Russia');
  });

  it('is empty for a valley Earth cannot seat, rather than guessing a country', () => {
    expect(patchCountries(FINE, IDX, parcelGrid, PATCHES)).toEqual([]);
    expect(patchCountries(FINE, IDX, parcelGrid, -1)).toEqual([]);
  });
});

describe('THE OWNER’S COMPLAINT, AS AN ASSERTION: no parcel is ever in the water', () => {
  const FULL_COORDS: Array<{ x: number; y: number }> = [];
  // A whole patch: every one of the 491 plot coordinates a valley can seat, built from
  // the grid's own fill order so no camp tile is included (a camp holds a grid tile but
  // is not deeded land, and `fillIndex` throws for one on purpose).
  for (let i = 0; i < parcelGrid.PARCELS_PER_PATCH; i++) {
    const t = parcelGrid.tileOfFillIndex(i);
    FULL_COORDS.push({ x: t.x, y: t.y });
  }
  const fullAt = (site: number): ParcelRow[] => FULL_COORDS.map((t) => ({
    ...t, earthCell: parcelGrid.parcelCell(site, t.x, t.y), keepLevel: 1, mine: false,
  }));

  it('places all 58,920 parcels of all 120 patches on CLAIMABLE Earth', () => {
    // The whole planet, not a sample. `claimable` means the cell has a sovereign —
    // which is the single test for "is this Earth a player may own", so ocean and
    // Antarctica fail it together and by the same sentinel.
    expect(parcelGrid.patchCount()).toBe(PATCHES);
    expect(parcelGrid.parcelCapacity()).toBe(PATCHES * parcelGrid.PARCELS_PER_PATCH);
    const seen = new Set<number>();
    let maskOcean = 0;
    for (let site = 0; site < PATCHES; site++) {
      const placed = placeParcels(fullAt(site), site, parcelGrid, FINE);
      expect(placed).toHaveLength(parcelGrid.PARCELS_PER_PATCH);
      for (const p of placed) {
        expect(countryIdOfCell(FINE, IDX, p.cell)).not.toBe(0);
        // …and the pin is drawn at that cell's own centre, never at its valley's site.
        const c = cellAtDeg(FINE, p.lon, p.lat);
        expect(c.iy * FINE.cols + c.ix).toBe(p.cell);
        seen.add(p.cell);
        if (!isLandCell(FINE, p.cell)) maskOcean++;
      }
    }
    // ONE PLAYER, ONE CELL: 58,920 parcels, 58,920 distinct cells. Two deeds on one
    // county is the failure this exists to make impossible.
    expect(seen.size).toBe(PATCHES * parcelGrid.PARCELS_PER_PATCH);
    // THE 57 SUB-TILE COUNTRIES ARE THE ONLY CELLS THE SILHOUETTE CALLS SEA, and they
    // are claimable Earth by owner decision Q4b ("every country gets one tile"):
    // Barbados is 431 km² against a 3,091 km² cell, so it polls 2 of 16 samples and the
    // majority rule calls its own cell ocean. 3 of them are seated. Pinned as an exact
    // number so a REAL ocean parcel could never hide inside "a few".
    expect(maskOcean).toBe(3);
    for (let i = 0; i < IDX.extraCells.length; i++) {
      if (!seen.has(IDX.extraCells[i]!)) continue;
      expect(IDX.extraIds[i]).not.toBe(0);
    }
  }, 30_000); // Exhaustive by design; parallel workspace load can exceed Vitest's 5 s default.

  it('keeps the draw order that stops 490 neighbours burying your own parcel', () => {
    const rows: ParcelRow[] = [
      {
        x: 3, y: 4, earthCell: parcelGrid.parcelCell(0, 3, 4), keepLevel: 9, mine: false,
        name: 'THEODOR', avatarUrl: '/api/avatars/theodor.webp',
      },
      { x: 12, y: 8, earthCell: parcelGrid.parcelCell(0, 12, 8), keepLevel: 1, mine: true },
      { x: 20, y: 2, earthCell: parcelGrid.parcelCell(0, 20, 2), keepLevel: 4, mine: false },
    ];
    const placed = placeParcels(rows, 0, parcelGrid, FINE);
    expect(placed).toHaveLength(3);
    expect(placed.at(-1)).toMatchObject({ x: 12, y: 8, mine: true });
    // …and `plots.(x, y)` is carried through untouched. A pin may be drawn anywhere;
    // it may not renumber the land, because those two integers ARE the deed's parcel.
    expect(placed.map((p) => `${p.x},${p.y}`).sort()).toEqual(['12,8', '20,2', '3,4']);
    expect(placed.find((p) => p.x === 3)).toMatchObject({
      name: 'THEODOR', avatarUrl: '/api/avatars/theodor.webp',
    });
  });

  it('consumes the deed’s frozen earthCell and refuses generated-address drift', () => {
    const exact = parcelGrid.parcelCell(0, 3, 4);
    const row: ParcelRow = { x: 3, y: 4, earthCell: exact, keepLevel: 1, mine: true };
    expect(placeParcels([row], 0, parcelGrid, FINE)[0]?.cell).toBe(exact);
    // A regenerated grid may suggest another valid cell; moving the deed there
    // would be worse than failing closed because the NFT already names `exact`.
    expect(placeParcels([{ ...row, earthCell: parcelGrid.parcelCell(0, 4, 4) }], 0, parcelGrid, FINE))
      .toEqual([]);
  });

  it('refuses to place a valley Earth cannot seat, rather than inventing ground', () => {
    // Past the 120th patch there is no land left in the stream, and the honest answer
    // is nothing on screen plus a chrome that says so. The alternative — wrapping — is
    // two deeds conveying one county, which is exactly what `patchCells` throws over.
    expect(placeParcels(fullAt(0), PATCHES, parcelGrid, FINE)).toEqual([]);
    expect(placeParcels(fullAt(0), PATCHES + 5_000, parcelGrid, FINE)).toEqual([]);
    expect(placeParcels(fullAt(0), -1, parcelGrid, FINE)).toEqual([]);
    expect(placeParcels(fullAt(0), 1.5, parcelGrid, FINE)).toEqual([]);
  });

  it('drops a camp tile instead of asking Earth for a cell it does not have', () => {
    // Camps hold grid tiles but are not deeded land (`parcels.ts` states the rule and
    // `fillIndex` enforces it by throwing), so a camp row must not become a pin — and
    // must not take the whole band down either.
    const camps = [{ x: 3, y: 2, earthCell: 0, keepLevel: 1, mine: false }];
    expect(() => parcelGrid.fillIndex(3, 2)).toThrow(/PvE camp/);
    expect(placeParcels(camps, 0, parcelGrid, FINE)).toEqual([]);
  });
});

describe('a tile is identifiable: a country, a code, and a place', () => {
  it('names production’s own first parcel — Russia, on the Chukotka coast', () => {
    // parcelCell(0, 0, 0): the first arrival in the alpha's only valley. Every number
    // here is measured from the shipped data, so this test is what would catch a mask
    // regeneration silently relocating somebody's county.
    const cell = parcelGrid.parcelCell(0, 0, 0);
    expect(cell).toBe(33_132);
    const t = tileFacts(FINE, IDX, cell)!;
    expect(t.name).toBe('Russia');
    expect(t.iso2).toBe('RU');
    expect(t.a3).toBe('RUS');
    expect(t.claimable).toBe(true);
    expect(t.lat).toBeCloseTo(66.75, 6);
    expect(t.lon).toBeCloseTo(-173.75, 6);
    expect(t.code).toBe('RUS-3156');
    // The far corner of the same patch is in a DIFFERENT COUNTRY, which is the scale
    // stated as a fact: 491 counties is a region the size of Egypt, and this one
    // straddles the Bering Strait.
    expect(tileFacts(FINE, IDX, parcelGrid.parcelCell(0, 24, 19))!.a3).toBe('USA');
  });

  it('gives every tile of a country a distinct, stable, 1-based ordinal', () => {
    // The tile id is DERIVED and never stored (nothing persists until P5 freezes the
    // cell in a column), so its stability is exactly this: same mask + same index ⇒
    // same string. Uniqueness is what makes it an ADDRESS rather than a decoration.
    const codes = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const cell = parcelGrid.parcelCell(7, ...(() => {
        const t = parcelGrid.tileOfFillIndex(i);
        return [t.x, t.y] as const;
      })());
      const t = tileFacts(FINE, IDX, cell)!;
      expect(t.ordinal).toBeGreaterThan(0);
      expect(t.code).toBe(tileCode(t.a3, t.ordinal));
      expect(codes.has(t.code)).toBe(false);
      codes.add(t.code);
    }
    // Four digits, zero-padded, so a registry of ~9,700 cells sorts as text.
    expect(tileCode('GEO', 42)).toBe('GEO-0042');
    expect(tileCode('GEO', 0)).toBe('');
    expect(tileCode('', 42)).toBe('');
  });

  it('says NO SOVEREIGN for the sea and for Antarctica, and means the same thing', () => {
    // Ocean and Antarctica share the 0 sentinel deliberately: `id !== 0` is the ONE
    // is-this-claimable test, so a border against Antarctica reads as a coast and a
    // tile there can never be sold. Antarctica is dropped by owner decision Q4a — NE
    // assigns it no sovereign ("claims held in abeyance"), so labelling it would be a
    // fabrication of ours.
    const sea = cellAtDeg(FINE, -140.25, -20.25);
    const seaTile = tileFacts(FINE, IDX, sea.iy * FINE.cols + sea.ix)!;
    expect(seaTile.claimable).toBe(false);
    expect(seaTile.name).toBe('');
    expect(seaTile.code).toBe('');
    expect(seaTile.ordinal).toBe(0);
    const ice = cellAtDeg(FINE, 0.25, -78.25);
    expect(isLandCell(FINE, ice.iy * FINE.cols + ice.ix)).toBe(true);
    expect(tileFacts(FINE, IDX, ice.iy * FINE.cols + ice.ix)!.claimable).toBe(false);
    // A cell off the grid entirely is null — the only null this function returns.
    expect(tileFacts(FINE, IDX, -1)).toBeNull();
    expect(tileFacts(FINE, IDX, FINE.cols * FINE.rows)).toBeNull();
  });

  it('answers the CROSSHAIR without paying for an ordinal nobody reads', () => {
    // `tileCountry` exists because the crosshair readout is recomputed on every camera
    // commit and only ever shows a name: it must not run `tileOrdinal`'s pass over
    // 86,122 cells for a number that is not on screen. Same answer, different cost.
    for (const [lon, lat, a3] of [
      [-0.12, 51.5, 'GBR'], [44.79, 41.72, 'GEO'], [-73.97, 40.78, 'USA'],
      [139.7, 35.68, 'JPN'], [28.04, -26.2, 'ZAF'], [133.8, -23.7, 'AUS'],
    ] as const) {
      const c = cellAtDeg(FINE, lon, lat);
      const cell = c.iy * FINE.cols + c.ix;
      const cheap = tileCountry(FINE, IDX, cell)!;
      const full = tileFacts(FINE, IDX, cell)!;
      expect(cheap.a3).toBe(a3);
      expect(cheap.name).toBe(full.name);
      expect(cheap.id).toBe(full.countryId);
      expect(tileOrdinal(FINE, IDX, cell, cheap.id)).toBe(full.ordinal);
    }
  });

  it('reads out the cell centre to one decimal, in hemispheres and not signs', () => {
    // One decimal because a 0.5° cell is 55 km across: a second would claim precision
    // the tile does not have.
    expect(degText(-173.75, 66.75)).toBe('66.8°N 173.8°W');
    expect(degText(44.75, -33.25)).toBe('33.3°S 44.8°E');
    expect(degText(0, 0)).toBe('0.0°N 0.0°E');
    // A camera that has spun east forever still says W, because the longitude is
    // normalised first.
    expect(degText(-173.75 + 720, 66.75)).toBe('66.8°N 173.8°W');
  });
});

describe('who holds a tile — and never, ever who they are', () => {
  const site = 0;
  const cellOf = (x: number, y: number): number => parcelGrid.parcelCell(site, x, y);
  const rows: ParcelRow[] = [
    { x: 0, y: 0, earthCell: parcelGrid.parcelCell(site, 0, 0), keepLevel: 3, mine: true },
    { x: 5, y: 5, earthCell: parcelGrid.parcelCell(site, 5, 5), keepLevel: 1, mine: false },
  ];

  it('gives the five honest answers, and no sixth', () => {
    expect(cellOwnership(cellOf(0, 0), site, parcelGrid, rows).state).toBe('yours');
    expect(cellOwnership(cellOf(5, 5), site, parcelGrid, rows).state).toBe('claimed');
    // Seated ground with nobody on it: the answer the old selection could not give at
    // all, because a selection used to BE a roster row.
    expect(cellOwnership(cellOf(9, 9), site, parcelGrid, rows).state).toBe('free');
    // Another valley's patch: we hold one roster at a time (one GET /map per
    // selection, no new endpoint), so occupancy there is genuinely unknown.
    expect(cellOwnership(parcelGrid.parcelCell(1, 0, 0), site, parcelGrid, rows).state)
      .toBe('elsewhere');
    // Real land that no patch of 491 reaches — 2,832 claimable cells are in that state
    // (measured), and nobody can be seated on one as Earth stands.
    const unseated = (() => {
      for (let c = 0; c < FINE.cols * FINE.rows; c++) {
        if (countryIdOfCell(FINE, IDX, c) !== 0 && !parcelGrid.parcelOf(c)) return c;
      }
      throw new Error('every claimable cell is seated — the ceiling changed');
    })();
    expect(cellOwnership(unseated, site, parcelGrid, rows).state).toBe('unseated');
    // No roster yet, or no valley selected: 'elsewhere' rather than a cheerful 'free'.
    expect(cellOwnership(cellOf(9, 9), null, parcelGrid, rows).state).toBe('elsewhere');
    expect(cellOwnership(cellOf(9, 9), site, parcelGrid, null).state).toBe('elsewhere');
  });

  it('carries a PLACE and cannot be extended into an identity', () => {
    // The privacy floor as a SHAPE, not a habit (EARTH-TILES-PLAN R11 /
    // apps/api/test/parcel-band.test.ts): the answer is four fields, none of which
    // could hold a wallet or a player name, and a future field would break this test
    // rather than somebody's anonymity.
    const own = cellOwnership(cellOf(5, 5), site, parcelGrid, rows);
    expect(Object.keys(own).sort()).toEqual(['siteId', 'state', 'x', 'y']);
    expect(own).toEqual({ state: 'claimed', siteId: 0, x: 5, y: 5 });
  });

  it('round-trips a cell back to the parcel it is', () => {
    // `parcelOf` is what makes a TAP work: the finger gives a cell, and this says which
    // plot that cell is. The two directions must agree or a tap would select a
    // neighbour.
    for (const [x, y] of [[0, 0], [24, 19], [12, 9], [1, 7]] as const) {
      expect(parcelGrid.parcelOf(cellOf(x, y))).toEqual({ siteId: site, x, y });
    }
  });
});
