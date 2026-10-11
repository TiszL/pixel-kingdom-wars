import { requiredFixture } from './helpers';
/**
 * GLOBE band — aggregation rules + wire contract (docs/WORLDMAP-GLOBE-PLAN.md §1.4,
 * D-096).
 *
 * TWO HALVES, ON PURPOSE.
 *
 * 1. PURE tests over synthetic per-base rows, driven by a TINY FAKE PLANET (the
 *    real 720×360 fine grid cut into 4 × 2 sectors instead of 24 × 12). They pin
 *    what the server decides: that a base is counted by the sector and the 2°
 *    cluster that CONTAIN ITS CELL, that every marker sits ON one of the bases it
 *    counts (the cell nearest their centroid — never the centroid itself, which
 *    can be sea), how reach is derived from the trophy histogram, how the region
 *    band is capped and ranked. A test that asserted "cell 28852 lands in
 *    sector 91" against the real earth mask would be pinning the MASK — it would
 *    go red the next time the mask is regenerated, and it would prove nothing
 *    about the rules.
 * 2. WIRE tests through app.inject against the real database, because the two
 *    things that make a 60 s poll affordable — the conditional request and the
 *    one-query-per-minute cache — live in the HTTP layer and in the cache, where
 *    a unit test of the builders cannot see them.
 *
 * The DB half asserts RELATIVE facts (my cluster is present, counts are at least
 * what I seeded, the key set is exactly the allowed one). The test database is
 * shared by every suite, so absolute sector totals are not the server's to
 * promise here.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { GLOBE, pvpMinDefenderKeep } from '@shardkeep/shared';
import { EARTH_COARSE } from '@shardkeep/shared/earthMask';
import { EARTH_FINE } from '@shardkeep/shared/earthMaskFine';
import {
  cellAtDeg, cellIndex, coarseCellOfFineCell, fineCellCentreDeg, greatCircleKm, isLandAtDeg,
  isLandCell, sectorIdOf, siteOf,
} from '@shardkeep/shared/globe';
import { parcelOf, patchCells, siteSeatLonLat } from '@shardkeep/shared/parcelGrid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { bases, baseSlots, players, plots, valleys } from '../src/db/schema';
import { SESSION_COOKIE } from '../src/auth/session';
import {
  buildGlobeResponse, buildGlobeSectorResponse, buildGlobeSnapshot, globeContext, globeEtagInput,
  reachSectorIds, sectorName,
  type GlobeAggRow, type GlobeContext, type GlobeResponse, type GlobeSectorResponse,
} from '../src/game/globe';
import {
  getGlobeSnapshot, getSectorClusters, globeCacheLoads, resetGlobeCache,
} from '../src/lib/globeCache';
import { globeGeo, setGlobeGeo, type GlobeGeo } from '../src/lib/globeGeo';
import {
  TEST_CONFIG, connectTestDb, createTestPlayer, createTestValley, randomWallet, seedPlot,
} from './helpers';

// ---------------------------------------------------------------------------
// The fake planet keeps the REAL 720×360 fine grid — a frozen `plots.earth_cell`
// is a real number in the wire suites, seeded through parcelCell — but cuts it
// into 4 lon sectors × 2 lat bands instead of 24 × 12, so a bucket can be checked
// by eye: sector = lonIdx·2 + latIdx, lonIdx = ⌊ix / 180⌋ (90° each), latIdx 1 for
// the northern half and 0 for the southern. The cell anchors are stated in one
// line each and need no mask, which is the point of the seam.
// ---------------------------------------------------------------------------
const COLS = GLOBE.fineCols;
const ROWS = GLOBE.fineRows;
const cellAt = (ix: number, iy: number): number => iy * COLS + ix;
const FAKE: GlobeGeo = {
  tuning: { sectorsLon: 4, sectorsLat: 2, valleysPerSectorCap: 2, cacheSec: 60 },
  siteOf: (ordinal) => ({ cell: ordinal % 4, slot: (ordinal / 4) | 0 }),
  lonlat: (cell, slot) => ({ lon: -135 + cell * 90 + slot * 0.5, lat: 45 }),
  sectorIdOfFineCell: (cell) =>
    (((cell % COLS) / (COLS / 4)) | 0) * 2 + (((cell / COLS) | 0) < ROWS / 2 ? 1 : 0),
  // The real 4 × 4 grouping and the real cell centre: pure grid math, no mask.
  coarseCellOfFineCell,
  fineCellCentreDeg,
  sectorIdOf: (lon, lat) =>
    Math.min(3, Math.max(0, Math.floor((lon + 180) / 90))) * 2 + (lat >= 0 ? 1 : 0),
  sectorCentreDeg: (id) => ({ lon: -135 + ((id / 2) | 0) * 90, lat: id % 2 ? 45 : -45 }),
  // Manhattan on degrees: ordering-equivalent to a great circle inside one sector.
  greatCircleKm: (aLon, aLat, bLon, bLat) => Math.abs(aLon - bLon) + Math.abs(aLat - bLat),
};

/** Same planet, production-sized region cap: the wire tests share the test DB with
 *  every other suite (world.test.ts alone seeds a 300-player valley), so a cap of 2
 *  would make "my cluster is listed" depend on who else happens to live nearby. */
const ROUTE_GEO: GlobeGeo = {
  ...FAKE,
  tuning: { ...FAKE.tuning, valleysPerSectorCap: GLOBE.valleysPerSectorCap },
};

// Named cells on the fake planet. A…C share fake sector 1 (north-west); A1..A3
// share coarse cell 362, B1/B2 share 370, C1 is alone in 380. E1 is in sector 3,
// W1 in sector 7. Coarse ids are `⌊iy/4⌋·180 + ⌊ix/4⌋`.
const A1 = cellAt(8, 8);
const A2 = cellAt(9, 8);
const A3 = cellAt(9, 9);
const B1 = cellAt(40, 8);
const B2 = cellAt(41, 8);
const C1 = cellAt(80, 8);
const E1 = cellAt(200, 8);
const W1 = cellAt(600, 8);
const CL_A = coarseCellOfFineCell(A1);
const CL_B = coarseCellOfFineCell(B1);
const CL_C = coarseCellOfFineCell(C1);

const base = (over: Partial<GlobeAggRow> & { earthCell: number }): GlobeAggRow => ({
  valleyId: 'vale-a', keepLevel: 1, active: false, ...over,
});

/** A viewer whose selected Home is the base at `earthCell` (stable mode shape). */
const at = (earthCell: number): { siteId: number; earthCell: number; x: number; y: number } =>
  ({ siteId: 0, earthCell, x: 1, y: 1 });

/** What an owned beacon shows (D-096) — the same for every deed of one wallet
 *  except the keep level, which is per base. */
const shows: { name: string; avatarUrl: string | null; keepLevel: number } =
  { name: 'OWNER', avatarUrl: null, keepLevel: 1 };

/** The real coarse cell under a lon/lat — the check that a pin stays inside the
 *  cell whose members it stands on. */
const coarseCellAtDeg = (lon: number, lat: number): number => {
  const c = cellAtDeg(EARTH_COARSE, lon, lat);
  return cellIndex(EARTH_COARSE, c.ix, c.iy);
};

const conn = connectTestDb();
const db = conn.db;

describe('globe aggregation (pure)', () => {
  it('counts every base in the sector that CONTAINS its cell, pinned ON the counted cell nearest their centroid', () => {
    // WHY (D-096): the sector pin is the entire GLOBE-band payload, and it must be
    // the sum of real bases counted WHERE THEY STAND. They used to be bucketed from
    // their valley's site seat, ~45 coarse cells along the Hilbert walk from the
    // valley's own patch — a pin over empty ground and a total in the wrong box.
    // And the pin stands ON one of the counted cells, never at their mean: the mean
    // of bases on two shores is the water between them (the real-Earth suite below
    // shows the Bering Strait doing exactly that), which is "marker on the ocean,
    // nothing there when I zoom" all over again.
    const rows = [
      base({ earthCell: A1, active: true }),
      base({ earthCell: A2 }),
      base({ earthCell: B1, valleyId: 'vale-b', active: true }),
      base({ earthCell: E1, valleyId: 'vale-c' }),
    ];
    const snap = buildGlobeSnapshot(rows, FAKE, 1_000);

    expect(snap.sectors.map((s) => s.id)).toEqual([1, 3]); // ascending, stable ETag
    expect(snap.sectors[0]).toMatchObject({ id: 1, valleys: 2, players: 3, active: 2 });
    expect(snap.sectors[1]).toMatchObject({ id: 3, valleys: 1, players: 1, active: 0 });

    // The sector's pin is the counted cell NEAREST the mean of its cells. The mean
    // itself is empty ground between A2 and B1 — no counted base stands there —
    // and the nearest counted cell is A2: neither the first row nor the lowest id,
    // so it is "nearest" doing the work here, not the tie-break.
    const kmFrom = (from: { lon: number; lat: number }, c: number): number => {
      const p = fineCellCentreDeg(c);
      return FAKE.greatCircleKm(from.lon, from.lat, p.lon, p.lat);
    };
    const counted = [A1, A2, B1];
    const centres = counted.map((c) => fineCellCentreDeg(c));
    const mean = {
      lon: centres.reduce((a, c) => a + c.lon, 0) / 3,
      lat: centres.reduce((a, c) => a + c.lat, 0) / 3,
    };
    expect(centres).not.toContainEqual(mean);
    expect(counted.reduce((best, c) => (kmFrom(mean, c) < kmFrom(mean, best) ? c : best))).toBe(A2);
    expect(A2).not.toBe(Math.min(...counted));
    const s1 = snap.sectors[0]!;
    expect({ lon: s1.lon, lat: s1.lat }).toEqual(fineCellCentreDeg(A2));
    expect(FAKE.sectorIdOf(s1.lon, s1.lat)).toBe(1);
    expect({ lon: s1.lon, lat: s1.lat }).not.toEqual(FAKE.sectorCentreDeg(1));

    // Clusters: one per 2° cell that holds a base, ranked busiest first, each ON
    // one of ITS cells and therefore inside its own cell. A1 and A2 are equidistant
    // from their mean, and the tie resolves to the LOWEST cell id: the pin must be
    // a pure function of the counted set, not of row order, or a reload of an
    // unchanged planet would move a marker.
    const clusters = snap.bySector.get(1)!;
    expect(clusters.map((c) => [c.cell, c.players])).toEqual([[CL_A, 2], [CL_B, 1]]);
    const a = clusters[0]!;
    const aMean = {
      lon: (centres[0]!.lon + centres[1]!.lon) / 2, lat: (centres[0]!.lat + centres[1]!.lat) / 2,
    };
    expect(kmFrom(aMean, A1)).toBe(kmFrom(aMean, A2));
    expect(A1).toBeLessThan(A2);
    expect({ lon: a.lon, lat: a.lat }).toEqual(fineCellCentreDeg(A1));
    expect(coarseCellAtDeg(a.lon, a.lat)).toBe(CL_A);
    expect(FAKE.sectorIdOfFineCell(A1)).toBe(a.sectorId);
    // A valley is a container, not a place (D-097): the snapshot pins sectors and
    // clusters and keeps a per-valley POPULATION, never a per-valley pin — the
    // one-release `valleys[]` list left with the clients that read it.
    expect(Object.keys(snap).sort()).toEqual(['at', 'byKeepLevel', 'bySector', 'byValleyId', 'sectors']);
    // Row order moves nothing: the same rows reversed pin the same cells.
    const reversed = buildGlobeSnapshot([...rows].reverse(), FAKE, 1_000);
    expect(reversed.sectors[0]).toMatchObject({ lon: s1.lon, lat: s1.lat });
    expect(reversed.bySector.get(1)![0]).toMatchObject({ lon: a.lon, lat: a.lat });
    // …and the public per-valley population is still answered, for the suites that
    // ask "is this base on the globe yet".
    expect(snap.byValleyId.get('vale-a')).toMatchObject({ players: 2, active: 1 });
  });

  it('draws nothing without a base: no row, no sector, no cluster', () => {
    // WHY: historical/dev valley rows are implementation containers, not bases.
    // The aggregate is one row PER PUBLIC BASE, so an empty container cannot reach
    // the globe at all — the fake places the owner explicitly removed have no row
    // to come back through.
    const snap = buildGlobeSnapshot([], FAKE, 1_000);
    expect(snap.sectors).toHaveLength(0);
    expect(snap.bySector.size).toBe(0);
  });

  it('reach highlights every sector holding a Keep you may attack, at any distance', () => {
    // WHY: reach is KEEP LEVEL, NOT DISTANCE (owner decision 1, restated by D-099:
    // their Keep at least half yours). The predicate is the same one
    // getMapChunk's inWindow and createRaid's gate use, so the globe can never
    // disagree with the raid rules about who is reachable. A K10 viewer's bar is
    // K5; a K20 base is in reach too — the weaker side always attacks up — and a
    // level is its own bucket, so the ring is exact, not approximate.
    const viewerKeep = 10;
    const bar = pvpMinDefenderKeep(viewerKeep);
    expect(bar).toBe(5);

    const snap = buildGlobeSnapshot([
      base({ earthCell: A1, keepLevel: bar }),     // exactly on the bar: in reach
      base({ earthCell: E1, keepLevel: bar - 1 }), // one under: too far below
      base({ earthCell: W1, keepLevel: 20 }),      // far above: still a target
    ], FAKE, 1_000);

    // The out-of-reach sector is still ON the globe — it is simply not ringed.
    expect(snap.sectors.map((s) => s.id)).toEqual([1, 3, 7]);
    expect(reachSectorIds(snap, FAKE, {
      valleyId: null, trophies: 300, keepLevel: viewerKeep, parcel: null, ownedParcels: [],
    })).toEqual([1, 7]);
  });

  it('your own keep never makes your own sector look like a target', () => {
    // WHY: a lone player would otherwise see their own sector ringed as if it held
    // someone to fight — the one answer that is always wrong, and the first thing
    // an alpha player sees. Their neighbour at the same level still counts. The
    // viewer's own cell decides which sector to discount — the same derivation the
    // aggregate used, so the two cannot disagree.
    const snapAlone = buildGlobeSnapshot([base({ earthCell: A1, keepLevel: 3 })], FAKE, 1_000);
    expect(reachSectorIds(snapAlone, FAKE, {
      valleyId: 'vale-a', trophies: 300, keepLevel: 3, parcel: at(A1), ownedParcels: [],
    })).toEqual([]);

    const snapShared = buildGlobeSnapshot([
      base({ earthCell: A1, keepLevel: 3 }), base({ earthCell: A2, keepLevel: 3 }),
    ], FAKE, 1_000);
    expect(reachSectorIds(snapShared, FAKE, {
      valleyId: 'vale-a', trophies: 300, keepLevel: 3, parcel: at(A1), ownedParcels: [],
    })).toEqual([1]);
  });

  it('discounts every public active owned base regardless of which one is Home', () => {
    // WHY: reach is wallet authority, not selected-base presentation. Private
    // inactive deeds remain in the owner overlay but are absent from the public
    // histogram, so subtracting them would erase an unrelated public target.
    // Each owned deed is discounted AT ITS OWN KEEP (D-099): the beacon's
    // keepLevel is the same column the public row was counted under.
    const snap = buildGlobeSnapshot([
      base({ earthCell: A1, keepLevel: 3 }),
      base({ earthCell: E1, valleyId: 'vale-c', keepLevel: 3 }),
    ], FAKE, 1_000);
    const ownedParcels = [
      { baseId: 'base-a', active: true, sectorId: 1, valleyId: 'vale-a', parcel: at(A1), ...shows, keepLevel: 3 },
      { baseId: 'base-b', active: false, sectorId: 3, valleyId: 'vale-c', parcel: at(E1), ...shows, keepLevel: 3 },
    ];
    for (const home of ownedParcels) {
      expect(reachSectorIds(snap, FAKE, {
        valleyId: home.valleyId, trophies: 300, keepLevel: home.keepLevel, parcel: home.parcel, ownedParcels,
      })).toEqual([3]);
    }

    const sharedSnap = buildGlobeSnapshot([
      base({ earthCell: A1, keepLevel: 3 }), base({ earthCell: A2, keepLevel: 3 }),
    ], FAKE, 1_000);
    const sharedOwned = [
      { ...ownedParcels[0]! },
      { ...ownedParcels[1]!, sectorId: 1, valleyId: 'vale-a', parcel: at(A2) },
    ];
    expect(reachSectorIds(sharedSnap, FAKE, {
      valleyId: 'vale-a', trophies: 300, keepLevel: 3, parcel: sharedOwned[0]!.parcel, ownedParcels: sharedOwned,
    })).toEqual([1]); // only the active owned deed exists in the public histogram
  });

  it('does not subtract an owned base that sits under its own bar', () => {
    // WHY: a second deed of yours that is too far below your selected Keep was
    // never counted in the reach range, so subtracting it would erase a stranger
    // at the bar who shares its sector — the same over-discount the inactive-deed
    // rule guards against, from the other side.
    const snap = buildGlobeSnapshot([
      base({ earthCell: A1, keepLevel: 5 }), base({ earthCell: A2, keepLevel: 1 }),
    ], FAKE, 1);
    expect(reachSectorIds(snap, FAKE, {
      valleyId: 'vale-a', trophies: 300, keepLevel: 10, parcel: at(A2),
      ownedParcels: [{
        baseId: 'my-low-deed', active: true, valleyId: 'vale-a',
        sectorId: 1, parcel: at(A2), ...shows, keepLevel: 1,
      }],
    })).toEqual([1]);
  });

  it('does not subtract private inactive deeds from the public reach histogram', () => {
    const snap = buildGlobeSnapshot([base({ earthCell: A1, keepLevel: 3 })], FAKE, 1);
    expect(reachSectorIds(snap, FAKE, {
      valleyId: null, trophies: 300, keepLevel: 3, parcel: null,
      ownedParcels: [{
        baseId: 'inactive-private-deed', active: false, valleyId: 'vale-a',
        sectorId: 1, parcel: at(A2), ...shows,
      }],
    })).toEqual([1]);
  });

  it('caps a sector by population and refines only the ORDER per viewer', () => {
    // WHY: the cap bounds the region payload by MEANING (like WORLD.mapCandidateCap),
    // and its population-ranked source stays viewer-agnostic — otherwise the
    // cached list would depend on who asked first and one viewer could shape
    // another's world. (The viewer's own quiet cluster is the explicit exception,
    // asserted separately below; neither anchor in this test needs it.)
    // Proximity is a TIEBREAK under population, so it can never hide a busy cluster.
    const snap = buildGlobeSnapshot([
      base({ earthCell: A1 }), base({ earthCell: A2 }), // near: cluster CL_A, 2 bases
      base({ earthCell: B1 }), base({ earthCell: B2 }), // far: cluster CL_B, 2 bases
      base({ earthCell: C1 }),                          // small: cluster CL_C, 1 base
    ], FAKE, 1_000);

    // cap = 2 → the two busiest, regardless of who is looking.
    expect(getSectorClusters(snap, 1, FAKE.tuning.valleysPerSectorCap).map((c) => c.cell))
      .toEqual([CL_A, CL_B]);

    const ctx = (home: number): GlobeContext =>
      ({
        snap, geo: FAKE,
        me: { valleyId: 'vale-a', trophies: 0, keepLevel: 1, parcel: at(home), ownedParcels: [] },
        warzoneActive: false,
      });
    const fromFar = buildGlobeSectorResponse(ctx(B1), 1);
    expect(fromFar.clusters).toHaveLength(2);
    expect(fromFar.clusters[0]!.id).toBe(CL_B); // your own neighbourhood first
    const fromNear = buildGlobeSectorResponse(ctx(A1), 1);
    expect(fromNear.clusters[0]!.id).toBe(CL_A);
    // Same population-cap membership either way — only the order moved.
    expect(fromFar.clusters.map((c) => c.id).sort()).toEqual(fromNear.clusters.map((c) => c.id).sort());
  });

  it('keeps your own quiet cluster inside a capped busy sector', () => {
    // WHY: a sector pin can honestly say the viewer lives there while its capped
    // cluster response omits the quiet cluster. That strands the home affordance at
    // the zoom handoff where it needs a stable place to continue into.
    const snap = buildGlobeSnapshot([
      base({ earthCell: A1 }), base({ earthCell: A2 }), base({ earthCell: A3 }),
      base({ earthCell: B1 }), base({ earthCell: B2 }),
      base({ earthCell: C1 }),
    ], FAKE, 1_000);
    const ctx: GlobeContext = {
      snap, geo: FAKE,
      me: { valleyId: 'vale-a', trophies: 0, keepLevel: 1, parcel: at(C1), ownedParcels: [] },
      warzoneActive: false,
    };

    const response = buildGlobeSectorResponse(ctx, 1);
    expect(response.clusters).toHaveLength(FAKE.tuning.valleysPerSectorCap);
    expect(response.clusters.map((c) => c.id)).toContain(CL_C);
    expect(response.clusters.map((c) => c.id)).toContain(CL_A);
  });

  it('keeps owned parcels complete while the sector list stays capped and private', () => {
    // WHY: unlimited ownership cannot be squeezed through the public REGION cap.
    // The private exact-cell overlay must retain every deed, while the cluster list
    // admits Home then other owned clusters deterministically and still never leaks
    // live presence for a non-selected deed.
    const snap = buildGlobeSnapshot([
      base({ earthCell: A1, active: true }), base({ earthCell: A2, active: true }),
      base({ earthCell: A3, active: true }),
      base({ earthCell: B1, active: true }), base({ earthCell: B2, active: true }),
      base({ earthCell: C1, active: true }),
    ], FAKE, 1_000);
    const ownedParcels = [
      { baseId: 'base-a', active: true, sectorId: 1, valleyId: 'vale-a', parcel: at(A1), ...shows },
      { baseId: 'base-b', active: false, sectorId: 1, valleyId: 'vale-a', parcel: at(B1), ...shows },
      { baseId: 'base-c', active: true, sectorId: 1, valleyId: 'vale-a', parcel: at(C1), ...shows, keepLevel: 4 },
    ];
    const ctx: GlobeContext = {
      snap, geo: FAKE,
      me: {
        valleyId: 'vale-a', trophies: 0, keepLevel: 1, parcel: ownedParcels[2]!.parcel,
        ownedParcels,
      },
      warzoneActive: false,
    };

    const globe = buildGlobeResponse(ctx);
    expect(globe.me.ownedParcels).toEqual(ownedParcels);

    const sector = buildGlobeSectorResponse(ctx, 1);
    expect(sector.clusters).toHaveLength(FAKE.tuning.valleysPerSectorCap);
    expect(sector.clusters.map((c) => c.id)).toEqual([CL_C, CL_A]);
    expect(sector.clusters[0]!.active).toBe(1);
    expect(Object.keys(sector.clusters[1]!)).not.toContain('active');
  });

  it('puts the frozen home address in the private cache validator', () => {
    // WHY: a deed transfer or repaired plot can keep the same valley while its
    // parcel changes. Reusing the old ETag would answer 304 and leave the browser
    // pointing at the previous owner's cell even though the database is correct.
    const snap = buildGlobeSnapshot([base({ earthCell: A1 })], FAKE, 1_000);
    const ctx = (earthCell: number): GlobeContext => ({
      snap, geo: FAKE,
      me: {
        valleyId: 'vale-a',
        trophies: 0,
        keepLevel: 1,
        parcel: { siteId: 0, earthCell, x: 1, y: 2 },
        ownedParcels: [],
      },
      warzoneActive: false,
    });
    expect(globeEtagInput(ctx(10), 'globe')).not.toBe(globeEtagInput(ctx(11), 'globe'));
  });

  it('puts the complete owned-base set — and what each beacon shows — in the private cache validator', () => {
    // WHY: buying, transferring or activating a second deed may leave the selected
    // Home unchanged. If that wallet-wide state is absent from the ETag, a correct
    // database read still answers 304 and the browser keeps the old incomplete map.
    // The same goes for a rename, an avatar upload or a keep upgrade (D-096): the
    // beacon draws them, so a 304 must not keep the old face on the globe.
    const snap = buildGlobeSnapshot([base({ earthCell: A1 })], FAKE, 1_000);
    const ctx = (
      active: boolean, includeSecond: boolean, show: Partial<typeof shows> = {},
    ): GlobeContext => ({
      snap, geo: FAKE,
      me: {
        valleyId: 'vale-a', trophies: 0, keepLevel: 1,
        parcel: { siteId: 0, earthCell: 10, x: 1, y: 2 },
        ownedParcels: [
          {
            baseId: 'base-a', active: true, sectorId: 0, valleyId: 'vale-a',
            parcel: { siteId: 0, earthCell: 10, x: 1, y: 2 }, ...shows, ...show,
          },
          ...(includeSecond ? [{
            baseId: 'base-b', active, sectorId: 1, valleyId: 'second',
            parcel: { siteId: 1, earthCell: 11, x: 3, y: 4 }, ...shows,
          }] : []),
        ],
      },
      warzoneActive: false,
    });
    const original = globeEtagInput(ctx(false, false), 'globe');
    expect(globeEtagInput(ctx(false, true), 'globe')).not.toBe(original);
    expect(globeEtagInput(ctx(true, true), 'globe'))
      .not.toBe(globeEtagInput(ctx(false, true), 'globe'));
    expect(globeEtagInput(ctx(false, false, { name: 'RENAMED' }), 'globe')).not.toBe(original);
    expect(globeEtagInput(ctx(false, false, { avatarUrl: '/api/avatars/g1.webp' }), 'globe')).not.toBe(original);
    expect(globeEtagInput(ctx(false, false, { keepLevel: 2 }), 'globe')).not.toBe(original);
  });

  it('names a sector after its place, never after who holds it', () => {
    // WHY: there is no territory table (MAP-SCALE-PLAN L9 is unbuilt). A possessive
    // label would promise ownership the schema cannot keep, and the fiction would
    // have to be walked back publicly.
    expect(sectorName(FAKE, 0)).toBe('45°S 135°W');
    expect(sectorName(FAKE, 7)).toBe('45°N 135°E');
  });

  it('a sector payload carries no ownership marker and no identity', () => {
    // WHY: admission may privately prioritise owned clusters, but the cluster
    // records remain anonymous places (D-040). Ownership is compared client-side
    // against the private globe overlay and is never stamped onto a cluster. And
    // the payload is clusters ONLY (D-097): the per-valley list that named the
    // container for one release is gone — a valley is not a place, and its name
    // and seat have nothing to do on a cell-anchored wire.
    const snap = buildGlobeSnapshot([base({ earthCell: A1 }), base({ earthCell: A2 })], FAKE, 1_000);
    const res: GlobeSectorResponse = buildGlobeSectorResponse(
      {
        snap, geo: FAKE,
        me: { valleyId: 'vale-a', trophies: 0, keepLevel: 1, parcel: at(A1), ownedParcels: [] },
        warzoneActive: false,
      }, 1,
    );
    expect(Object.keys(res.clusters[0]!).sort())
      .toEqual(['active', 'id', 'lat', 'lon', 'players', 'warzone']);
    expect(Object.keys(res).sort()).toEqual(['clusters', 'id', 'name']);
  });

  it('never emits a per-cluster ACTIVE count for a cluster that is not yours', () => {
    // WHY: `active` counts players seen inside WORLD.mapOnlineMin, so per cluster it
    // is a PRESENCE ORACLE — a 2° cell can hold one base, GET /globe/parcels names
    // who owns it, and the pair answers "is X at their keyboard right now?",
    // repeatable as often as you like. Nothing in the game disclosed that before
    // (/map's `online` flag only describes the valley you stand in), and no feature
    // needs it. The world still feels alive at SECTOR level, where the count
    // aggregates many clusters and identifies nobody — that is the whole trade.
    // The field is OMITTED, not zeroed: absent renders as nothing, whereas 0 would
    // assert "nobody is home", which is a different and possibly false statement.
    const snap = buildGlobeSnapshot([
      base({ earthCell: A1, active: true }), base({ earthCell: A2, active: true }),
      base({ earthCell: A3, active: true }),
      base({ earthCell: B1, valleyId: 'vale-b', active: true }),
    ], FAKE, 1_000);
    const res = buildGlobeSectorResponse(
      {
        snap, geo: FAKE,
        me: { valleyId: 'vale-a', trophies: 0, keepLevel: 1, parcel: at(A1), ownedParcels: [] },
        warzoneActive: false,
      }, 1,
    );

    const own = res.clusters.find((c) => c.id === CL_A)!;
    const foreign = res.clusters.find((c) => c.id === CL_B)!;
    expect(own.active).toBe(3);
    expect(Object.keys(foreign)).not.toContain('active');
    expect(foreign.players).toBe(1); // population is still honest — that is the globe
    // And the SECTOR aggregate still knows, so the planet is not dead-quiet.
    expect(snap.sectors.find((s) => s.id === 1)!.active).toBe(4);
  });

  it('needs no mask at all: a substitute planet states its cell anchors in one line each', () => {
    // WHY: the seat-based globe needed `siteSeatLonLat` — and therefore the fine
    // mask — to place a pin, so a substitute planet had to be allowed to fall back
    // to a raw lattice point that could be in water. A cell-anchored globe places
    // everything from three integer functions of the frozen cell, so the fake planet
    // is a full GlobeGeo with no optional escape hatch to keep honest.
    expect('siteSeatLonLat' in FAKE).toBe(false);
    const snap = buildGlobeSnapshot([base({ earthCell: E1 })], FAKE, 1_000);
    const [cluster] = snap.bySector.get(3)!;
    expect({ lon: cluster!.lon, lat: cluster!.lat }).toEqual(FAKE.fineCellCentreDeg(E1));
    expect(snap.sectors[0]).toMatchObject(FAKE.fineCellCentreDeg(E1));
  });
});

// ---------------------------------------------------------------------------
// The REAL planet: a marker always points at ground that holds a base
// ---------------------------------------------------------------------------
describe('globe aggregation on the real Earth', () => {
  it("anchors the owner's base (cell 28852, site 1) in its own sector and cluster, not at the seat", () => {
    // WHY (D-096): production cell 28852 is site 1, plot (13, 5). Its valley's seat —
    // where the region pin used to draw and the sector total used to count — is
    // 909 km away in a different sector, so the pin said "1 BASES" over empty
    // ground. The wire now carries the cell's own centroid, on land, in the sector
    // that contains it, and the seat is not consulted at all.
    setGlobeGeo(null);
    try {
      const geo = globeGeo();
      const cell = 28852;
      expect(parcelOf(cell)).toEqual({ siteId: 1, x: 13, y: 5 });
      const seat = siteSeatLonLat(siteOf(1));
      const here = geo.fineCellCentreDeg(cell);
      expect(greatCircleKm(seat.lon, seat.lat, here.lon, here.lat)).toBeGreaterThan(900);
      expect(sectorIdOf(seat.lon, seat.lat)).not.toBe(geo.sectorIdOfFineCell(cell));

      const snap = buildGlobeSnapshot([
        base({ earthCell: cell, valleyId: 'site-1' }),
      ], geo, 1_000);
      const sectorId = geo.sectorIdOfFineCell(cell);
      expect(snap.sectors.map((s) => s.id)).toEqual([sectorId]);
      const response = buildGlobeSectorResponse({
        snap, geo,
        me: { valleyId: null, trophies: 0, keepLevel: 1, parcel: null, ownedParcels: [] },
        warzoneActive: false,
      }, sectorId);
      expect(response.clusters).toHaveLength(1);
      const [placed] = response.clusters;
      expect(placed!.id).toBe(geo.coarseCellOfFineCell(cell));
      expect({ lon: placed!.lon, lat: placed!.lat }).toEqual(here);
      expect(isLandAtDeg(EARTH_FINE, placed!.lon, placed!.lat)).toBe(true);
      // And nothing on the wire names the valley or its seat: a site id has no
      // place in a cell-anchored payload (D-097).
      expect(JSON.stringify(response)).not.toContain('siteId');
    } finally {
      setGlobeGeo(ROUTE_GEO);
    }
  });

  it('a sector and a cluster always contain the cells they count, never a seat', () => {
    // WHY: this is the whole guarantee. A sector's pin and every cluster's pin stand
    // ON a cell they count (the one nearest their centroid), so each must classify
    // back to its own box — and the cluster totals must add up to the sector total,
    // or a player zooming from "n BASES" into the region would find more or fewer
    // than n. Driven by real parcels from four real patches, sampled, against the
    // real geometry.
    setGlobeGeo(null);
    try {
      const geo = globeGeo();
      const rows: GlobeAggRow[] = [];
      for (const site of [0, 1, 10, 50]) {
        const cells = patchCells(site);
        for (let i = 0; i < cells.length; i += 5) {
          rows.push(base({ earthCell: cells[i]!, valleyId: `site-${site}` }));
        }
      }
      const snap = buildGlobeSnapshot(rows, geo, 1_000);
      expect(snap.sectors.length).toBeGreaterThan(4); // four patches span many sectors
      let counted = 0;
      for (const s of snap.sectors) {
        expect(sectorIdOf(s.lon, s.lat)).toBe(s.id);
        expect({ lon: s.lon, lat: s.lat }).not.toEqual(geo.sectorCentreDeg(s.id));
        // Every pin is the centre of a cell it counts, not a mean between them.
        const here = rows.filter((r) => geo.sectorIdOfFineCell(r.earthCell) === s.id);
        expect(here.map((r) => geo.fineCellCentreDeg(r.earthCell))).toContainEqual({ lon: s.lon, lat: s.lat });
        const clusters = snap.bySector.get(s.id)!;
        let inClusters = 0;
        for (const c of clusters) {
          expect(c.sectorId).toBe(s.id);
          expect(sectorIdOf(c.lon, c.lat)).toBe(s.id);
          expect(coarseCellAtDeg(c.lon, c.lat)).toBe(c.cell);
          expect(here.filter((r) => geo.coarseCellOfFineCell(r.earthCell) === c.cell)
            .map((r) => geo.fineCellCentreDeg(r.earthCell))).toContainEqual({ lon: c.lon, lat: c.lat });
          inClusters += c.players;
        }
        expect(inClusters).toBe(s.players);
        counted += s.players;
      }
      expect(counted).toBe(rows.length);
      // No pin stands where the old seat stood unless a real parcel happens to be
      // there: the seats of sites 1, 10 and 50 hold none of their own parcels.
      for (const site of [1, 10, 50]) {
        const seat = siteSeatLonLat(siteOf(site));
        const seatCluster = coarseCellAtDeg(seat.lon, seat.lat);
        const seatSector = sectorIdOf(seat.lon, seat.lat);
        const ownRowsAtSeat = rows.filter((r) => r.valleyId === `site-${site}`
          && geo.sectorIdOfFineCell(r.earthCell) === seatSector
          && geo.coarseCellOfFineCell(r.earthCell) === seatCluster);
        expect(ownRowsAtSeat).toHaveLength(0);
      }
    } finally {
      setGlobeGeo(ROUTE_GEO);
    }
  });

  it('pins a sector whose bases straddle a coast ON a base cell, never on the water between them', () => {
    // WHY (owner, 2026-09-02): "marker on the ocean, nothing there when I zoom".
    // Sector 10 (180–165°W, 60–75°N) holds bases on BOTH shores of the Bering
    // Strait, and the CENTROID of those cells — where the pin was served until this
    // test — is open sea (−173.05° / 66.65° in local data, measured). A centroid is
    // only guaranteed to be inside the sector's BOX, not on ground; the pin must be
    // one of the counted cells, the one nearest the centroid, so that zooming into
    // any marker at any zoom finds a base under it (D-096).
    setGlobeGeo(null);
    try {
      const geo = globeGeo();
      const CHUKOTKA = 36010; // 174.75°W 64.75°N — the Russian shore
      const NOME_W = 36028;   // 165.75°W 64.75°N — the Alaskan shore, west of Nome
      const NOME = 36029;     // 165.25°W 64.75°N — the Alaskan shore, same 2° cell
      for (const c of [CHUKOTKA, NOME_W, NOME]) {
        expect(isLandCell(EARTH_FINE, c), `cell ${c} must be land on the fine mask`).toBe(true);
        expect(geo.sectorIdOfFineCell(c)).toBe(10);
      }
      const centre = (c: number) => geo.fineCellCentreDeg(c);
      const meanOf = (cells: number[]) => ({
        lon: cells.reduce((a, c) => a + centre(c).lon, 0) / cells.length,
        lat: cells.reduce((a, c) => a + centre(c).lat, 0) / cells.length,
      });
      const bering = (cells: number[]) => buildGlobeSnapshot(
        cells.map((earthCell) => base({ earthCell, valleyId: 'bering' })),
        geo, 1_000,
      );

      // One base on each shore: their mean is the strait, and both cells are exactly
      // as far from it. The tie resolves to the lowest cell id, and the pin is land.
      const strait = meanOf([CHUKOTKA, NOME]);
      expect(isLandAtDeg(EARTH_FINE, strait.lon, strait.lat)).toBe(false);
      const two = bering([CHUKOTKA, NOME]);
      expect(two.sectors).toHaveLength(1);
      expect(two.sectors[0]).toMatchObject({ id: 10, players: 2, ...centre(CHUKOTKA) });
      expect(isLandAtDeg(EARTH_FINE, two.sectors[0]!.lon, two.sectors[0]!.lat)).toBe(true);

      // A second Alaskan base pulls the mean east — still water — and the nearest
      // counted cell now wins outright: the western Alaskan cell, not the lowest id.
      const drift = meanOf([CHUKOTKA, NOME_W, NOME]);
      expect(isLandAtDeg(EARTH_FINE, drift.lon, drift.lat)).toBe(false);
      const three = bering([CHUKOTKA, NOME_W, NOME]);
      expect(three.sectors[0]).toMatchObject({ id: 10, players: 3, ...centre(NOME_W) });
      // The two Alaskan bases share a 2° cluster; their mean is the grid line between
      // them — on no cell — and the cluster pins on the lower id of the two.
      const alaska = three.bySector.get(10)!.find((c) => c.cell === geo.coarseCellOfFineCell(NOME))!;
      expect(alaska.players).toBe(2);
      expect(geo.coarseCellOfFineCell(NOME_W)).toBe(alaska.cell);
      expect([centre(NOME_W), centre(NOME)]).not.toContainEqual(meanOf([NOME_W, NOME]));
      expect({ lon: alaska.lon, lat: alaska.lat }).toEqual(centre(NOME_W));
    } finally {
      setGlobeGeo(ROUTE_GEO);
    }
  });
});

// ---------------------------------------------------------------------------
// The snapshot cache under CONCURRENCY — where the design's load claim lives
// ---------------------------------------------------------------------------
describe('globe snapshot cache', () => {
  const snapOf = (atMs: number) => buildGlobeSnapshot([base({ earthCell: A1 })], FAKE, atMs);

  it('collapses a CONCURRENT stampede into exactly one aggregate query', async () => {
    // WHY: this is the difference between the design's "0.017 q/s at any
    // population" and a self-inflicted spike every GLOBE.cacheSec. A cache with no
    // single-flight does not shield the database from concurrency at all — on the
    // tick the TTL lapses, every in-flight globe request sees a stale entry and
    // each runs the loader, which is the heaviest query in the system (two seq
    // scans + a hash join + three sorts) against DB_POOL_MAX 10. They then queue
    // behind each other and take LONGER than one query would, to compute the
    // identical snapshot N times. The sequential test below cannot see this: it
    // awaits each request, so there is never a second caller inside the window.
    resetGlobeCache();
    let calls = 0;
    let open!: () => void;
    const gate = new Promise<void>((res) => { open = res; });
    const loader = async () => { calls++; await gate; return snapOf(5_000); };

    // Fire them all before releasing the loader — i.e. all inside one miss window.
    const inFlight = Promise.all(
      Array.from({ length: 25 }, () => getGlobeSnapshot(60, loader, 5_000)),
    );
    open();
    const snaps = await inFlight;

    expect(calls).toBe(1);
    expect(globeCacheLoads()).toBe(1);
    // Everyone was handed the SAME object, not 25 equal ones — proof they joined
    // one flight rather than racing 25 of them to the same answer.
    expect(new Set(snaps).size).toBe(1);
  });

  it('does not remember a FAILED aggregate as still in flight', async () => {
    // WHY: the failure mode a naive memo introduces. If the rejected promise stayed
    // parked in the single-flight slot, every later request would join a load that
    // already failed and the globe would be down until the process restarted — a
    // permanent outage caused by one transient DB error.
    resetGlobeCache();
    let calls = 0;
    const loader = async () => {
      calls++;
      if (calls === 1) throw new Error('pool exhausted');
      return snapOf(5_000);
    };
    await expect(getGlobeSnapshot(60, loader, 5_000)).rejects.toThrow('pool exhausted');
    const snap = await getGlobeSnapshot(60, loader, 5_000);
    expect(calls).toBe(2);
    expect(snap.sectors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Wire contract
// ---------------------------------------------------------------------------
let app: FastifyInstance;
let cookie: string;
let wallet: string;
let valleyId: string;
const named = ['ORACLE_OF_TEST', 'GLOBE_NEIGHBOUR_TWO'];
const seeded: string[] = [];

beforeAll(async () => {
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
  setGlobeGeo(ROUTE_GEO);

  const secretKey = utils.randomSecretKey();
  wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  // A K6 viewer (D-099 bar: K3) and two K3 neighbours — exactly on the bar, so a
  // reach ring that drifted from the raid gate by one level would drop them.
  await db.update(players).set({
    entryPaidAt: new Date(), trophies: 300, keepLevel: 6, lastSeenAt: new Date(),
  }).where(eq(players.wallet, wallet));

  // An isolated, backdated valley (so it never becomes the newest and hijacks
  // another suite's signup) holding the viewer plus two NAMED neighbours.
  const v = await createTestValley(db, { name: 'GLOBE TEST VALE', createdAt: new Date('2000-01-02T00:00:00Z') });
  valleyId = v.id;
  await seedPlot(db, { valleyId, x: 0, y: 0, playerWallet: wallet });
  for (const name of named) {
    const w = randomWallet();
    seeded.push(w);
    await db.insert(players).values({
      wallet: w, name, trophies: 320, keepLevel: pvpMinDefenderKeep(6),
      lastSeenAt: new Date(), entryPaidAt: new Date(),
    });
    await seedPlot(db, { valleyId, x: seeded.length, y: 0, playerWallet: w });
  }
});

afterAll(async () => {
  setGlobeGeo(null);
  await app.close();
  await conn.sql.end();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie }, headers });

/** The frozen cells of every plot seeded into my valley, and which fake sector
 *  counts each: three neighbours in one patch are Earth neighbours but not
 *  necessarily in one 90° fake sector, so the floors below are per sector. */
async function mySeededCells(): Promise<Array<{ wallet: string; earthCell: number; sectorId: number }>> {
  const rows = await db.select({ wallet: plots.playerWallet, earthCell: plots.earthCell })
    .from(plots).where(eq(plots.valleyId, valleyId));
  return rows.map((r) => ({
    wallet: r.wallet ?? '', earthCell: requiredFixture(r.earthCell), sectorId: ROUTE_GEO.sectorIdOfFineCell(requiredFixture(r.earthCell)),
  }));
}

describe('GET /globe', () => {
  it('accepts a selected active free base while preserving every paid parcel', async () => {
    // WHY: WORLD is useful before a deed purchase. Selecting the active free base
    // must not be mistaken for foreign/inactive authority merely because it has no
    // plot, and selecting it must not hide the same wallet's paid land directory.
    const owner = await createTestPlayer(db);
    const [free, paid, inactive] = await db.insert(bases).values([
      { ownerWallet: owner.wallet, status: 'active' },
      { ownerWallet: owner.wallet, status: 'active', landPaidAt: new Date() },
      { ownerWallet: owner.wallet, status: 'inactive', landPaidAt: new Date() },
    ]).returning({ id: bases.id });
    await db.insert(baseSlots).values([
      { wallet: owner.wallet, slot: 1, baseId: free!.id },
      { wallet: owner.wallet, slot: 2, baseId: paid!.id },
      { wallet: owner.wallet, slot: 3, baseId: inactive!.id },
    ]);
    const paidValley = await createTestValley(db, {
      name: 'STABLE GLOBE PAID LAND', createdAt: new Date('2000-01-06T00:00:00Z'),
    });
    await seedPlot(db, {
      valleyId: paidValley.id, x: 4, y: 4, playerWallet: owner.wallet, baseId: paid!.id,
    });

    const previous = process.env['MULTI_BASE_ENABLED'];
    process.env['MULTI_BASE_ENABLED'] = 'true';
    try {
      const ctx = await globeContext(db, owner.wallet, new Date(), free!.id);
      expect(ctx.me).toMatchObject({ valleyId: null, parcel: null });
      expect(ctx.me.ownedParcels.map((entry) => entry.baseId)).toEqual([paid!.id]);
      // The owned overlay's sector is the one that COUNTS the cell — the same
      // derivation the public aggregate made (D-096) — and the beacon carries
      // what it shows: the owner's name, the opaque avatar URL and the keep level.
      const owned = ctx.me.ownedParcels[0]!;
      expect(owned.sectorId).toBe(ROUTE_GEO.sectorIdOfFineCell(owned.parcel.earthCell));
      expect(owned).toMatchObject({ name: '', avatarUrl: null, keepLevel: 1 });
      await db.update(players).set({ name: 'GLOBE_OWNED_NAME' }).where(eq(players.wallet, owner.wallet));
      await db.update(bases).set({ keepLevel: 3 }).where(eq(bases.id, paid!.id));
      const renamed = await globeContext(db, owner.wallet, new Date(), free!.id);
      expect(renamed.me.ownedParcels[0]).toMatchObject({ name: 'GLOBE_OWNED_NAME', keepLevel: 3 });
      expect(globeEtagInput(renamed, 'globe')).not.toBe(globeEtagInput(ctx, 'globe'));
      await expect(globeContext(db, owner.wallet, new Date(), inactive!.id))
        .rejects.toMatchObject({ statusCode: 404, code: 'BASE_NOT_OWNED' });
      await expect(globeContext(db, owner.wallet, new Date(), crypto.randomUUID()))
        .rejects.toMatchObject({ statusCode: 404, code: 'BASE_NOT_OWNED' });
    } finally {
      if (previous === undefined) delete process.env['MULTI_BASE_ENABLED'];
      else process.env['MULTI_BASE_ENABLED'] = previous;
    }
  });

  it('answers with sector pins plus my own place and reach', async () => {
    resetGlobeCache();
    const res = await get('/globe');
    expect(res.statusCode).toBe(200);
    const body = res.json() as GlobeResponse;

    expect(body.me.valleyId).toBe(valleyId);
    const [stored] = await db.select({
      siteId: valleys.siteId, earthCell: plots.earthCell, x: plots.x, y: plots.y,
    }).from(plots).innerJoin(valleys, eq(valleys.id, plots.valleyId))
      .where(eq(plots.playerWallet, wallet));
    expect(body.me.parcel).toEqual(stored);
    // Home's sector is the one that counts Home's CELL, not its valley's seat.
    expect(body.me.sectorId).toBe(ROUTE_GEO.sectorIdOfFineCell(requiredFixture(stored!.earthCell)));
    const mySector = body.sectors.find((s) => s.id === body.me.sectorId);
    expect(mySector, 'my own sector must be on the globe').toBeDefined();
    expect(Object.keys(mySector!).sort())
      .toEqual(['active', 'id', 'lat', 'lon', 'players', 'valleys', 'warzone']);
    // Every seeded neighbour is counted in the sector holding ITS cell; other
    // suites may share the sector, so each is a floor. The pin sits inside the
    // sector it names, never at the sector's geometric centre.
    const seededCells = await mySeededCells();
    for (const sectorId of new Set(seededCells.map((c) => c.sectorId))) {
      const sector = body.sectors.find((s) => s.id === sectorId)!;
      const here = seededCells.filter((c) => c.sectorId === sectorId).length;
      expect(sector.players).toBeGreaterThanOrEqual(here);
      expect(sector.active).toBeGreaterThanOrEqual(here);
      expect(ROUTE_GEO.sectorIdOf(sector.lon, sector.lat)).toBe(sectorId);
      expect({ lon: sector.lon, lat: sector.lat }).not.toEqual(ROUTE_GEO.sectorCentreDeg(sectorId));
    }
    // Two K3 neighbours against a K6 viewer (bar K3) → their sectors are in
    // reach, wherever their cells put them and whatever their trophies.
    for (const c of seededCells.filter((c) => seeded.includes(c.wallet))) {
      expect(body.me.reachSectorIds).toContain(c.sectorId);
    }
  });

  it('never ships a wallet or a player name, at any zoom', async () => {
    // WHY: the globe is browsable BECAUSE there is nothing on it to scrape. /map
    // already withholds identity from markers you cannot act on; a planet-wide
    // endpoint that handed out names would defeat that in one request.
    resetGlobeCache();
    const globe = (await get('/globe')).body;
    const sector = (await get(`/globe/sector/${(await get('/globe')).json<GlobeResponse>().me.sectorId}`)).body;
    for (const body of [globe, sector]) {
      for (const w of [wallet, ...seeded]) expect(body).not.toContain(w);
      for (const name of named) expect(body).not.toContain(name);
    }
  });

  it('serves every viewer from ONE aggregate query per cache window', async () => {
    // WHY: this is the load-bearing claim of the whole design — globe DB load is
    // ONE query per GLOBE.cacheSec GLOBALLY (0.017 q/s), not per request and not
    // per viewer, which is why the globe tier is flat from 1 K to 37 M players.
    resetGlobeCache();
    await get('/globe');
    await get('/globe');
    await get(`/globe/sector/0`);
    expect(globeCacheLoads()).toBe(1);
  });

  it('answers 304 from the validator alone, before any payload is built', async () => {
    // WHY: at 60 s polling, 59 of every 60 seconds must cost ~200 B. GET /map
    // hashes its FINISHED body, so a 304 there still pays for the whole assembly;
    // here the tag is (cache stamp, warzone, viewer) and the request short-circuits.
    resetGlobeCache();
    const first = await get('/globe');
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const again = await get('/globe', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    // A validator from ANOTHER route must never satisfy this one, or a browser
    // would render a sector list as a globe.
    const sectorRes = await get('/globe/sector/0');
    const crossed = await get('/globe', { 'if-none-match': sectorRes.headers['etag'] as string });
    expect(crossed.statusCode).toBe(200);
  });
});

describe('GET /globe/sector/:id', () => {
  it('lists the sector name and its clusters as places, capped — and no per-valley list any more', async () => {
    resetGlobeCache();
    const me = (await get('/globe')).json<GlobeResponse>().me;
    const res = await get(`/globe/sector/${me.sectorId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as GlobeSectorResponse;

    expect(body.id).toBe(me.sectorId);
    expect(body.name).toMatch(/°[NS] \d+°[EW]$/);
    expect(body.clusters.length).toBeLessThanOrEqual(ROUTE_GEO.tuning.valleysPerSectorCap);
    // My own cluster — the 2° cell holding my frozen cell — is listed, at a real place.
    const myCluster = ROUTE_GEO.coarseCellOfFineCell(me.parcel!.earthCell);
    const mine = body.clusters.find((c) => c.id === myCluster);
    expect(mine, 'my cluster must be listed in its own sector').toBeDefined();
    expect(mine!.players).toBeGreaterThanOrEqual(1);
    expect(typeof mine!.lon).toBe('number');
    expect(typeof mine!.lat).toBe('number');
    expect(ROUTE_GEO.sectorIdOf(mine!.lon, mine!.lat)).toBe(me.sectorId);
    // No `valleys[]` (D-097): the one-release compatibility for pre-cluster
    // clients ended because deploy.sh drains traffic and every client reloads on
    // the version change — there is no mixed window — and a valley was never a
    // place to pin. The wire is exactly the three D-096 fields, so a client that
    // still reads `valleys` fails at typecheck rather than rendering nothing.
    expect(Object.keys(body).sort()).toEqual(['clusters', 'id', 'name']);
  });

  it('rejects a sector id off the grid at the edge', async () => {
    // WHY: an out-of-range id must not answer 200 with an empty list — "nobody
    // lives there" and "there is no there" are different answers.
    expect((await get(`/globe/sector/${GLOBE.sectorsLon * GLOBE.sectorsLat}`)).statusCode).toBe(400);
    expect((await get('/globe/sector/-1')).statusCode).toBe(400);
    expect((await get('/globe/sector/nowhere')).statusCode).toBe(400);
  });

  it('is not a public surface', async () => {
    // WHY: aggregates are still the world's shape. Both globe routes sit behind
    // authenticate + requireEntryPaid (the `paid` preHandler). Their explicit
    // per-IP cap is asserted in map-rate-limit.test.ts — the rate-limit plugin is
    // not registered under NODE_ENV=test, so it cannot be observed from here.
    for (const url of ['/globe', '/globe/sector/0']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('withholds a foreign cluster\'s ACTIVE count over the wire', async () => {
    // WHY: the same presence-oracle rule as the pure test above, asserted on the
    // real payload — this is the shape the client renders, and the omission has to
    // survive serialisation (a `0` would have been indistinguishable from silence).
    const foreign = await createTestValley(db, {
      name: 'D7 PRESENCE VALE', createdAt: new Date('2000-01-04T00:00:00Z'),
    });
    const resident = randomWallet();
    await db.insert(players).values({
      wallet: resident, name: 'D7_RESIDENT', trophies: 320,
      lastSeenAt: new Date(), entryPaidAt: new Date(),
    });
    await seedPlot(db, { valleyId: foreign.id, x: 20, y: 19, playerWallet: resident });
    const [theirPlot] = await db.select({ earthCell: plots.earthCell }).from(plots)
      .where(eq(plots.playerWallet, resident));
    const theirSector = ROUTE_GEO.sectorIdOfFineCell(requiredFixture(theirPlot!.earthCell));
    const theirCluster = ROUTE_GEO.coarseCellOfFineCell(requiredFixture(theirPlot!.earthCell));

    resetGlobeCache();
    const me = (await get('/globe')).json<GlobeResponse>().me;
    const theirs = (await get(`/globe/sector/${theirSector}`)).json<GlobeSectorResponse>();
    const cluster = theirs.clusters.find((c) => c.id === theirCluster);
    expect(cluster, 'the foreign cluster must still be BROWSABLE — the globe is honest').toBeDefined();
    expect(cluster!.players).toBeGreaterThanOrEqual(1);
    expect(Object.keys(cluster!)).not.toContain('active');
    // Your own cluster keeps it: knowing who is home in YOUR cell is not an oracle.
    const mine = (await get(`/globe/sector/${me.sectorId}`)).json<GlobeSectorResponse>();
    const myCluster = ROUTE_GEO.coarseCellOfFineCell(me.parcel!.earthCell);
    expect(mine.clusters.find((c) => c.id === myCluster)?.active).toBeGreaterThanOrEqual(1);
    // The sector aggregate still reports presence, so the planet is not dead-quiet.
    const pins = (await get('/globe')).json<GlobeResponse>().sectors;
    expect(pins.some((s) => s.active > 0)).toBe(true);
  });
});
