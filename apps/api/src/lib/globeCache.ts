/**
 * Globe snapshot cache (docs/WORLDMAP-GLOBE-PLAN.md §1.4).
 *
 * Deliberately shaped like `mapCache.ts` — in-process Map-of-one, TTL from
 * constants, an explicit invalidate, and a TYPE-ENFORCED public/private split —
 * so MAP-SCALE-PLAN L2's Redis swap stays a one-file change.
 *
 * WHY ONE ENTRY AND NOT ONE PER VIEWER. The expensive half of a globe open is
 * VIEWER-AGNOSTIC: every player looking at the planet sees the same valleys in
 * the same places with the same population. So the aggregate is ONE query per
 * `GLOBE.cacheSec` GLOBALLY (not per request, not per viewer) — 0.017 q/s at any
 * population, which is why the globe tier is flat from 1 K to 37 M players. The
 * per-viewer half is a single indexed row (own valley + trophies) applied on top.
 *
 * TYPE-ENFORCED PRIVACY: `GlobeSnapshot` is the SHARED struct. Nothing derived
 * from the viewer (own valley, trophies, reach, ranking) may be stored here — if
 * it were, one player would be served another player's reach highlight. Keeping
 * those fields off these types makes that a compile error rather than a review
 * catch. `warzoneActive` is also absent ON PURPOSE: it is a request-time
 * predicate that flips shield visibility globally (see mapCache's key comment),
 * so it is stamped onto the response at serialisation and never cached.
 *
 * O(1) IN KEYS BY CONSTRUCTION: one snapshot plus at most one derived list per
 * sector (≤ sectorsLon × sectorsLat = 288), and the derived lists are dropped
 * wholesale with the snapshot they came from. It cannot reproduce mapCache's
 * unbounded-Map defect.
 */

/**
 * One REGION-band cluster as every viewer of the planet sees it: the bases whose
 * frozen `plots.earth_cell` falls inside ONE 2° coarse cell of ONE sector (D-096).
 * PUBLIC — no viewer state, no identity, no shield-derived field.
 *
 * Keyed by (sector, coarse cell) and not by the coarse cell alone because 15° is
 * not a multiple of 2°: a coarse cell can straddle a sector edge, and a sector must
 * never count ground beyond its own bounds. The pin is the centre of ONE counted
 * base's cell — the one nearest their centroid — so it lies inside both the cell
 * and the sector by membership: nothing to re-check, no seat to drift from, and no
 * mean to land in the water between two shores (game/globe.ts explains).
 */
export interface GlobeCluster {
  sectorId: number;
  /** `EARTH_COARSE` cell id (`coarseCellOfFineCell`). Unique within its sector. */
  cell: number;
  lon: number;
  lat: number;
  /** Occupied deed cells counted here. */
  players: number;
  /** Occupants seen within WORLD.mapOnlineMin at snapshot time. */
  active: number;
}

/** One valley container's PUBLIC population across the whole planet — the
 *  "is this base on the globe yet" truth other suites assert against. */
export interface GlobeValleyCount {
  valleyId: string;
  players: number;
  active: number;
}

/** One sector's population, anchored ON one of the bases it counts.
 *  PUBLIC — no viewer state, no shield-derived field. */
export interface GlobeSectorCounts {
  id: number;
  /** Distinct valley containers holding a counted base here. Kept on the wire
   *  under its old name; a client only ever tests it for zero. */
  valleys: number;
  players: number;
  active: number;
  /** Centre of the counted base cell nearest the sector's centroid (degrees) —
   *  inside the sector because a member is, and on a base's own ground rather than
   *  at a mean that can fall in the sea between two shores (D-096). */
  lon: number;
  lat: number;
}

/** Everything about the planet that does not depend on who is looking. */
export interface GlobeSnapshot {
  /** Cache stamp (ms) — the viewer-agnostic half of the ETag. Changes only when
   *  the aggregate is re-run, so 59 of every 60 seconds of polling is a 304. */
  at: number;
  /** Populated sectors only (a sector with no base has nothing to draw),
   *  ascending id so the serialised body — and its ETag — are stable. */
  sectors: readonly GlobeSectorCounts[];
  /** Sector id → its clusters, ranked players-desc then cell. Viewer-agnostic
   *  MEMBERSHIP; per-viewer proximity only ever refines the order. */
  bySector: ReadonlyMap<number, readonly GlobeCluster[]>;
  /** Sector id → Keep level (1..20) → occupants. COUNTS ONLY — this is what
   *  turns "who can I fight" (D-099: their Keep at least half yours) into a JS
   *  scan over ONE shared struct instead of a per-viewer query, and a count per
   *  level can never identify a player. ≤ 20 levels × ~110 populated sectors
   *  ≈ 9 KB of server memory in total, at any population. */
  byKeepLevel: ReadonlyMap<number, ReadonlyMap<number, number>>;
  /** Valley id → its public population. NOT a place any more: a valley's bases
   *  span many cells and can span sectors, so "where is valley X" has no single
   *  honest answer and nothing asks it. */
  byValleyId: ReadonlyMap<string, GlobeValleyCount>;
}

interface Entry {
  snap: GlobeSnapshot;
  /** `sectorId:cap` → the capped region-band list, built on first request for that
   *  sector and dropped with the snapshot. The cap is in the key because it is an
   *  input to the answer: a memo keyed on the sector alone would serve a list built
   *  under a different cap if the constant ever moves (or a test uses another). */
  sectorLists: Map<string, readonly GlobeCluster[]>;
}

let entry: Entry | null = null;
/** Loader invocations — proves "one aggregate serves every viewer" in tests. */
let loads = 0;
/**
 * SINGLE FLIGHT. The in-flight reload, shared by everyone who arrives during it.
 *
 * Without this the cache is a stampede generator, not a shield: on a miss, N
 * concurrent requests each see `entry` stale and each call `loader()`. And this
 * loader is the heaviest query in the system — two sequential scans over plots and
 * players, a hash join, three sorts — against DB_POOL_MAX 10. So the moment the
 * TTL lapses, every globe request in flight piles onto the pool at once, and at
 * real concurrency they queue behind each other, take LONGER than one query
 * would, and the extra ones are pure waste: they compute the identical snapshot.
 * A 60 s TTL turns that into a self-inflicted spike once a minute, forever.
 *
 * Memoising the PROMISE (not the result) collapses that to one query per TTL
 * however many callers arrive — which is the load-bearing "0.017 q/s at any
 * population" claim, and it was only true of a sequential caller.
 *
 * On rejection the slot is cleared so the next request retries: a failed aggregate
 * must not be remembered as "a load is happening" or the globe stays down.
 */
let inFlight: Promise<GlobeSnapshot> | null = null;

/**
 * The cached planet snapshot. `nowMs` is injectable for the same reason it is in
 * mapCache: a TTL test must not sleep.
 */
export async function getGlobeSnapshot(
  ttlSec: number,
  loader: () => Promise<GlobeSnapshot>,
  nowMs: number = Date.now(),
): Promise<GlobeSnapshot> {
  const hit = entry;
  if (hit && nowMs - hit.snap.at < ttlSec * 1000 && nowMs >= hit.snap.at) return hit.snap;
  // Join the reload already under way rather than starting a second one. Callers
  // that arrive mid-flight get the snapshot it produces, which is exactly what
  // they would have computed themselves.
  if (inFlight) return inFlight;
  loads++;
  const flight = loader();
  inFlight = flight;
  try {
    const snap = await flight;
    // Publish only if this is still the load everyone is waiting on. An
    // invalidateGlobe() during the query (a new valley) means this snapshot was
    // already stale when it arrived, and caching it would hide the new valley for
    // a whole TTL — the one thing invalidateGlobe exists to prevent.
    if (inFlight === flight) entry = { snap, sectorLists: new Map() };
    return snap;
  } finally {
    // Only clear OUR flight: a caller that started the next one must not have its
    // promise dropped from under it.
    if (inFlight === flight) inFlight = null;
  }
}

/**
 * The capped, viewer-agnostic cluster list for one sector, memoised against the
 * CURRENT snapshot. `cap` bounds the region-band payload by MEANING (the same
 * idea as WORLD.mapCandidateCap): membership is decided by population and cell
 * only, so no viewer can influence WHICH clusters another viewer is shown. A
 * sector holds at most 8 × 8 coarse cells, so the cap is a ceiling the geometry
 * already sits under; it stays because the memo key and the tests speak in it.
 */
export function getSectorClusters(
  snap: GlobeSnapshot, sectorId: number, cap: number,
): readonly GlobeCluster[] {
  const all = snap.bySector.get(sectorId) ?? [];
  const hit = entry;
  // A snapshot that is no longer the cached one (a reload raced this request)
  // still answers correctly — it just does not populate the memo.
  if (!hit || hit.snap !== snap) return all.slice(0, cap);
  const key = `${sectorId}:${cap}`;
  const memo = hit.sectorLists.get(key);
  if (memo) return memo;
  const list = all.slice(0, cap);
  hit.sectorLists.set(key, list);
  return list;
}

/** Drop the planet snapshot. Called when the world provably changed — a NEW
 *  VALLEY must not wait out the TTL to appear (a player whose valley is missing
 *  from the globe cannot find their own keep). */
export function invalidateGlobe(): void { entry = null; inFlight = null; }

/** Test seam: total loader invocations since process start / last reset. */
export function globeCacheLoads(): number { return loads; }

/** Test seam: empty the cache and zero the counter. */
export function resetGlobeCache(): void { entry = null; inFlight = null; loads = 0; }
