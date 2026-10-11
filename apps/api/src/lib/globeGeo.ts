/**
 * The ONE place apps/api depends on the globe's spatial scheme
 * (`packages/shared/src/globe.ts`, docs/WORLDMAP-GLOBE-PLAN.md §1.1/§1.2).
 *
 * The scheme is pure math over a baked land-cell list and it lives in `shared`
 * because the web renderer must use the very same functions — the server placing
 * valleys on a second, subtly different planet is the one bug that would make the
 * globe unfixable. The server needs five of them plus the GLOBE tuning block, the
 * three cell anchors D-096 draws every marker from, and since P4a four more that
 * answer "which real Earth cell, in which country, is this parcel, and how many
 * are left?" — see the optional half of `GlobeGeo`.
 *
 * THIS SEAM IS A WRITE-TIME SEAM, NOT A READ-TIME ONE (D1, 2026-08-10). The four
 * Earth-tile members are called on ONE path — `tryAssignInValley` freezing a new
 * plot's `earth_cell` + `country_a3` — and by the capacity guard in `createValley`.
 * Nothing that SERVES a stored parcel comes back here: `game/deedMetadata.ts` reads
 * the two frozen columns and the `earth_countries` registry, and imports neither
 * this file nor the generated data. That is deliberate and it is the whole safety
 * property behind owner decision Q3 — `countryIdOfCell` resolves a cell through the
 * mask's land ENUMERATION and the index's own rank-based ids, both of which a
 * regeneration renumbers, so a request-time lookup could have moved the country a
 * minted deed already names.
 *
 * WHY A SEAM AND NOT A DIRECT IMPORT AT EVERY CALL SITE:
 *  1. The dependency is auditable in one file: this is the only place the API
 *     touches globe math, so "does the server agree with the client about where
 *     valley #7 is?" is a one-file question — and a `packages/sim` import of it
 *     (banned: sim must stay pure) would be equally obvious.
 *  2. Tests drive the aggregation with a TINY FAKE PLANET (four sites, a 4×2
 *     sector grid). A test asserting "valley #7 lands in sector 91" would be
 *     pinning the earth MASK rather than the server's bucketing, capping and
 *     privacy rules, and would go red every time the mask is regenerated.
 */
import { GLOBE } from '@shardkeep/shared';
// SUBPATHS, not the barrel: globe.ts and the generated Earth data are off
// `@shardkeep/shared`'s index so they can never reach packages/sim's module graph
// (see that barrel's header). THIS FILE IS THE ONLY PLACE IN apps/api THAT MAY
// IMPORT THEM — one grep answers "does the server agree with the client?".
import {
  coarseCellOfFineCell, countryIdOfCell, countryOfId, fineCellCentreDeg, greatCircleKm, lonlat,
  sectorCentreDeg, sectorIdOf, sectorIdOfFineCell, siteOf,
} from '@shardkeep/shared/globe';
import { EARTH_COUNTRIES_FINE } from '@shardkeep/shared/earthCountriesFine';
import { EARTH_FINE } from '@shardkeep/shared/earthMaskFine';
import { parcelCell, parcelCapacity, parcelOf, patchCount } from '@shardkeep/shared/parcelGrid';

/**
 * "NO SOVEREIGN", as an `ADM0_A3`-shaped value that can be stored.
 *
 * ISO 3166-1 reserves the `ZZ`/`ZZZ` range for user assignment, so it can never
 * collide with a Natural Earth `ADM0_A3` — asserted against all 240 features in
 * apps/api/test/earth-address.test.ts rather than assumed. It is what
 * `plots.country_a3` holds for ground no country holds (ocean and Antarctica share
 * the sentinel by design, because "no sovereign" and "not claimable" are the same
 * fact) and for a parcel on a body that has no country layer at all. There is
 * deliberately NO `earth_countries` row for it: the deed omits the Country trait
 * rather than printing a fabricated one.
 */
export const NO_SOVEREIGN_A3 = 'ZZZ';

/** A valley's site: which coarse land cell, and which slot inside it. */
export interface GlobeSite { cell: number; slot: number }

/** Degrees. Longitude −180..180, latitude −90..90. */
export interface LonLat { lon: number; lat: number }

/** The globe's tuning numbers, narrowed to what the server actually reads.
 *  Every one of them is `GLOBE.*` in packages/shared/src/constants.ts. */
export interface GlobeTuning {
  /** Sector grid — sectorsLon × sectorsLat sectors cover the planet. */
  sectorsLon: number;
  sectorsLat: number;
  /** Max clusters one REGION-band response may carry (the name predates D-096's
   *  clusters; it has always bounded that list). */
  valleysPerSectorCap: number;
  /** Snapshot TTL, seconds — ONE aggregate query per this many seconds GLOBALLY. */
  cacheSec: number;
}

/** The narrow surface the server codes against — see the header. */
export interface GlobeGeo {
  tuning: GlobeTuning;
  /** Valley ordinal (0-based — `valleys.site_id`, frozen at creation since P5)
   *  → its site. Pure in the ordinal and nothing else: never a plot, never a
   *  wallet, never a clock. The globe aggregate no longer places anything from
   *  it (D-096: markers anchor to base cells, never to a valley's seat); it stays
   *  on the seam as the identity `valleys.site_id` is assigned against. */
  siteOf(ordinal: number): GlobeSite;
  lonlat(cell: number, slot: number): LonLat;
  // --- THE CELL ANCHORS (D-096, 2026-09-02) ----------------------------------
  // Everything the globe draws is derived from a base's frozen `plots.earth_cell`
  // through these three, and nothing else: the sector that counts it, the 2° cluster
  // it joins in the REGION band, and the point its centroid is averaged from. They
  // are pure integer math over the grid SHAPE (no mask), so a substitute planet
  // states its own in one line each — which is why they are REQUIRED, unlike the
  // tile layer below.
  sectorIdOfFineCell(cell: number): number;
  coarseCellOfFineCell(cell: number): number;
  fineCellCentreDeg(cell: number): LonLat;
  sectorIdOf(lon: number, lat: number): number;
  /** Sector centre — the server labels sectors from it, so the name is derived,
   *  never stored (there is no territory table and the globe must not imply one). */
  sectorCentreDeg(id: number): LonLat;
  greatCircleKm(aLon: number, aLat: number, bLon: number, bLat: number): number;

  // --- THE EARTH-TILE LAYER (docs/EARTH-TILES-PLAN.md P4a) -------------------
  // OPTIONAL, because a substitute planet has no country layer. The four-site fake
  // planet in apps/api/test/globe.test.ts is a full GlobeGeo literal, and R14 names
  // that suite the cleanest regression signal in the system precisely because it is
  // resolution-INDEPENDENT — making these required would turn it red at typecheck
  // for a reason that has nothing to do with the server's bucketing, capping or
  // privacy rules. Every caller therefore handles "this planet has no tiles", and
  // says so loudly instead of writing a placeholder address (see
  // `earthAddressOf`, game/world.ts).
  /** A parcel's real 0.5° Earth cell, from its valley's `site_id` and its
   *  `plots.(x, y)`. THROWS past the last patch and for a camp tile — never
   *  wraps, because a wrap is two deeds on one place. */
  parcelCell?(siteId: number, x: number, y: number): number;
  /** Reverse of parcelCell for a player-selected address. Null means that fine
   * cell is not in Earth's finite seatable parcel stream. */
  parcelOf?(cell: number): { siteId: number; x: number; y: number } | null;
  /**
   * Which country holds a fine cell, as Natural Earth `ADM0_A3` — or
   * `NO_SOVEREIGN_A3` for ground with no sovereign, which is the same thing as
   * "not claimable": ocean and Antarctica share the sentinel deliberately.
   *
   * A3 AND NOT AN ID OR A NAME, and that is the whole point of this member. The
   * generated index's numeric ids are RANKS in an `ADM0_A3`-sorted list, so a data
   * refresh renumbers them; the `NAME` is a display string the same refresh can
   * reword. `ADM0_A3` is the identity — it is the sort key those ranks are ranks
   * IN — so it is the only form of the answer that is worth writing down. This is
   * called ONCE per parcel, at creation, and the result is frozen in
   * `plots.country_a3`; the deed path reads that column and never comes back here
   * (see game/deedMetadata.ts). The NAME lives in the `earth_countries` registry.
   */
  countryA3?(cell: number): string;
  /** Valleys Earth seats as real territory, and parcels in total. Finite on
   *  purpose: selling out is what unlocks the next planet. */
  patchCount?(): number;
  parcelCapacity?(): number;
}

const REAL: GlobeGeo = {
  tuning: {
    sectorsLon: GLOBE.sectorsLon,
    sectorsLat: GLOBE.sectorsLat,
    valleysPerSectorCap: GLOBE.valleysPerSectorCap,
    cacheSec: GLOBE.cacheSec,
  },
  siteOf,
  lonlat,
  sectorIdOfFineCell,
  coarseCellOfFineCell,
  fineCellCentreDeg,
  sectorIdOf,
  sectorCentreDeg,
  greatCircleKm,
  parcelCell,
  parcelOf,
  // The fine mask and the fine country index are bound HERE, once. Resolving a
  // cell through a different pair than the client uses is exactly the "second,
  // subtly different planet" this file exists to prevent, and `countryIdOfCell`
  // throws rather than guesses if the two resolutions ever disagree.
  //
  // THE ONLY IMPORT OF THE GENERATED COUNTRY DATA IN THE WHOLE SERVER, and it is
  // reached from exactly one call site: `tryAssignInValley` freezing a new plot's
  // `country_a3`. Everything downstream — the deed above all — reads the column.
  countryA3: (cell) => {
    const id = countryIdOfCell(EARTH_FINE, EARTH_COUNTRIES_FINE, cell);
    return id === 0 ? NO_SOVEREIGN_A3 : countryOfId(EARTH_COUNTRIES_FINE, id)?.a3 ?? NO_SOVEREIGN_A3;
  },
  patchCount,
  parcelCapacity,
};

let override: GlobeGeo | null = null;

/** Test seam: drive the globe with a fake planet (header reason 2). Pass null to
 *  restore the real one. */
export function setGlobeGeo(geo: GlobeGeo | null): void { override = geo; }

/** The globe geometry in force. */
export function globeGeo(): GlobeGeo { return override ?? REAL; }
