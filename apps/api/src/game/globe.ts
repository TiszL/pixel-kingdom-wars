/**
 * The GLOBE band's server half (docs/WORLDMAP-GLOBE-PLAN.md §1.4, P3/P4; D-096).
 *
 * Two read-only endpoints sit on this module: GET /globe (one pin per POPULATED
 * SECTOR) and GET /globe/sector/:id (the 2° CLUSTERS of bases inside one sector).
 * Both follow the same split as GET /map — a viewer-agnostic snapshot
 * (globeCache.ts) plus a private wallet-scoped viewer overlay — for the same
 * reason: the expensive half of the answer is identical for everyone looking at
 * the same planet.
 *
 * EVERY MARKER IS ANCHORED TO REAL BASE CELLS (D-096, owner 2026-09-02). A sector
 * counts a base because the base's frozen `plots.earth_cell` lies inside it, a
 * cluster is the bases inside one 2° coarse cell of that sector, and both are
 * drawn ON ONE OF THE CELLS THEY COUNT: the counted cell nearest the centroid of
 * all of them (lowest cell id on a tie). Not AT the centroid — a mean of coastal
 * cells is the water between them (sector 10, whose bases stand on both shores of
 * the Bering Strait, averaged to −173.05° / 66.65° in the Bering Sea; measured
 * 2026-09-02), which is exactly the owner's "marker on the ocean, nothing there
 * when I zoom". Nothing is placed from a valley's Hilbert site seat any more: the
 * seat sat ~45 coarse cells along the walk from the valley's own patch (828–2,271
 * km for site 1, measured), which drew "1 BASES" pins over empty ground and
 * mis-bucketed the sector totals and reach rings under them.
 * packages/shared/src/globe.ts `sectorIdOfFineCell` carries the measurement.
 *
 * WHAT THE GLOBE IS AND IS NOT (owner decisions locked 2026-08-09):
 *  - It is HONEST and fully browsable. It shows real population EVERYWHERE, and
 *    reach (who you can actually fight) is a HIGHLIGHT — `me.reachSectorIds` —
 *    never a filter. No sector is ever omitted, dimmed or hidden for being out
 *    of reach: reach is Keep level (D-099), not distance, and pretending
 *    otherwise would signpost travel the game does not have (MAP-SCALE-PLAN's
 *    own objection).
 *  - It shows POPULATION, never OWNERSHIP. There is no district/territory table
 *    (MAP-SCALE-PLAN L9 is unbuilt), so a globe implying clan-held ground would
 *    promise something the schema cannot keep.
 *  - It leaks NO identities (D-040). Sector and cluster rows are aggregates: a
 *    count and a place. No wallet, no player name, no shield state, at any zoom.
 *    A globe that hands out the roster is worse than no globe. The parcel band
 *    (GET /globe/parcels) is where a deed's public name appears, bounded (D-042).
 *
 * COST: one aggregate query per GLOBE.cacheSec GLOBALLY (not per request). The
 * query now returns ONE ROW PER PUBLIC BASE rather than one per valley — Earth
 * seats 58,920 parcels, so the ceiling is ~59 k rows a minute through one
 * connection, which is what a cell-honest planet costs — and the HTTP payloads
 * stay bounded by geometry: ≤288 sectors, ≤64 clusters per sector.
 */
import { pvpMinDefenderKeep, WORLD } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  getGlobeSnapshot,
  type GlobeCluster, type GlobeSectorCounts, type GlobeSnapshot, type GlobeValleyCount,
} from '../lib/globeCache';
import { globeGeo, type GlobeGeo } from '../lib/globeGeo';
import { HttpError } from '../lib/errors';
import { getGameConfig } from './gameConfig';
import { isWarzoneActive } from './warzone';
import { multiBaseEnabled } from '../config';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One GLOBE-band pin, on one of the bases it counts. `warzone` is the LIVE
 *  global window (warzone.ts), stamped per request — never cached, because it
 *  flips shield rules globally. */
export interface GlobeSectorPin {
  id: number;
  valleys: number;
  players: number;
  active: number;
  /** The centre of one counted base's cell, degrees — the one nearest the
   *  sector's centroid. The client draws the pin HERE and never at the sector's
   *  geometric centre (186 of 288 of those are sea), nor at the centroid itself
   *  (sea too, when the bases straddle a coast). */
  lon: number;
  lat: number;
  warzone: boolean;
}

export interface GlobeMe {
  /** The sector holding your own base cell — null until you have a plot. */
  sectorId: number | null;
  valleyId: string | null;
  /** The viewer's STORED parcel address. `earthCell` is the frozen deed address;
   *  `siteId` is the valley's frozen seat. Neither is reconstructed from a
   *  display lon/lat, because that round trip is not an identity. */
  parcel: GlobeParcelLocation | null;
  /** Every plotted base currently owned by this wallet, including inactive
   *  deeds. This is private viewer state: it lets either selected base render
   *  the same complete ownership set without widening the public aggregates. */
  ownedParcels: GlobeOwnedParcel[];
  /** Sectors holding at least one base YOUR Keep may attack (D-099: their Keep
   *  is at least half yours). A HIGHLIGHT, never a filter (owner decision 1).
   *  Ascending. */
  reachSectorIds: number[];
}

export interface GlobeParcelLocation {
  siteId: number;
  earthCell: number;
  x: number;
  y: number;
}

export interface GlobeOwnedParcel {
  baseId: string;
  active: boolean;
  sectorId: number;
  valleyId: string;
  parcel: GlobeParcelLocation;
  /**
   * What the owner's own beacon shows (D-096): their chosen display name, the
   * same opaque avatar URL GET /globe/parcels serves, and this base's keep level.
   * VIEWER-PRIVATE — it is the viewer's own wallet, so nothing here widens what
   * anyone else can see — and it is what stops the beacon reading "?" until the
   * public parcel page happens to include the same cell.
   */
  name: string;
  avatarUrl: string | null;
  keepLevel: number;
}

export interface GlobeResponse {
  sectors: GlobeSectorPin[];
  me: GlobeMe;
}

/**
 * One REGION-band cluster pin: the bases inside one 2° coarse cell of this
 * sector, pinned on the counted cell nearest their centroid. No wallet, no player
 * name, no valley name, ever.
 *
 * `active` IS ABSENT FOR EVERY CLUSTER BUT THE ONE HOLDING YOUR SELECTED HOME —
 * deliberately, and the field is optional rather than zeroed so the client renders
 * nothing instead of rendering a lie (owner-approved resolution, 2026-08-09).
 *
 * WHY: a per-cluster count of who was seen inside WORLD.mapOnlineMin is a PRESENCE
 * ORACLE for a place you do not live — a 2° cell can hold one base, and
 * GET /globe/parcels names who owns it, so "is X online right now?" becomes one
 * request sampled as often as you like. That is a real-world safety disclosure
 * (when someone is at their keyboard), not a game stat, and no feature needs it.
 * The world still feels alive at SECTOR level: GlobeSectorPin.active aggregates
 * many clusters, where a count identifies nobody. That is the whole trade.
 */
export interface GlobeSectorCluster {
  /** `EARTH_COARSE` cell id — the 2° cell these bases share. Unique within the
   *  sector; the same cell can appear under a neighbouring sector with THAT
   *  sector's share of its bases, because 15° is not a multiple of 2°. */
  id: number;
  lon: number;
  lat: number;
  players: number;
  /** Present ONLY for the cluster holding the viewer's selected Home cell. */
  active?: number;
  warzone: boolean;
}

/**
 * GET /globe/sector/:id — the D-096 shape and nothing else. The per-valley
 * `valleys[]` list that shipped alongside `clusters` for one release is gone
 * (D-097): deploy.sh drains traffic and every client reloads on the version
 * change, so there is no mixed window for a pre-cluster client to live in, and a
 * valley is a container rather than a place — its bases span ~45 coarse cells —
 * so nothing honest was ever left to pin per valley.
 */
export interface GlobeSectorResponse {
  id: number;
  name: string;
  clusters: GlobeSectorCluster[];
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

/** One PUBLIC BASE of the planet aggregate — the unit every anchor derives from.
 *  Exported so the bucketing/sector rules can be tested as pure functions against
 *  synthetic rows (see globe.test.ts). Carries no identity: a cell, a container,
 *  a Keep level and a presence bit. */
export interface GlobeAggRow {
  /** `plots.earth_cell` — the frozen deed address (NOT NULL, unique). */
  earthCell: number;
  valleyId: string;
  /** The base's Keep level (1..20) — the reach histogram's key (D-099). */
  keepLevel: number;
  /** Seen within WORLD.mapOnlineMin at snapshot time. */
  active: boolean;
}

/**
 * ONE query for the whole planet: every public base, its frozen cell, its valley
 * container, its Keep level and whether it was recently seen.
 *
 * THE PREDICATE IS THE "41 BASES" PREDICATE AND IT IS UNCHANGED (D-096): an
 * active base with land paid, whose owner holds it in an active base slot. What
 * changed is the GRAIN — one row per base instead of one per valley — because a
 * valley is a container, not a place: its bases span ~45 coarse cells and can
 * span sectors, so no per-valley row can say which sector counts which base.
 *
 * `keepLevel` is the reach machinery (D-099): folded to a per-sector histogram
 * by `buildGlobeSnapshot`, it turns "which sectors hold someone I can fight"
 * into a JS scan over twenty counters per sector of the shared snapshot instead
 * of a per-viewer query. A level is its own bucket, so unlike the trophy
 * histogram this replaced there is no width, no rounding and no edge to be
 * over-inclusive at: the ring is EXACTLY the raid gate.
 */
async function loadGlobeRows(db: Db, _geo: GlobeGeo, now: Date): Promise<GlobeAggRow[]> {
  // An ISO string with an explicit cast, not a Date: the raw-SQL parameter path
  // binds strings, and a Date throws ERR_INVALID_ARG_TYPE at bind time.
  const onlineSince = new Date(now.getTime() - WORLD.mapOnlineMin * 60_000).toISOString();
  const rows = await db.execute(multiBaseEnabled() ? sql`
    SELECT p.earth_cell AS "earthCell", p.valley_id AS "valleyId",
           b.keep_level AS "keepLevel",
           COALESCE(pl.last_seen_at > ${onlineSince}::timestamptz, false) AS active
    FROM plots p
    JOIN bases b ON b.id = p.base_id
    JOIN base_slots bs ON bs.base_id = b.id
      AND bs.wallet = b.owner_wallet AND bs.active = true
    JOIN players pl ON pl.wallet = b.owner_wallet
    WHERE b.land_paid_at IS NOT NULL AND b.status = 'active'
    ORDER BY p.earth_cell
  ` : sql`
    SELECT p.earth_cell AS "earthCell", p.valley_id AS "valleyId",
           pl.keep_level AS "keepLevel",
           COALESCE(pl.last_seen_at > ${onlineSince}::timestamptz, false) AS active
    FROM plots p
    JOIN players pl ON pl.wallet = p.player_wallet
    WHERE pl.entry_paid_at IS NOT NULL
    ORDER BY p.earth_cell
  `) as unknown as GlobeAggRow[];
  return rows;
}

/**
 * A pin's anchor, settled in two passes over the rows: pass 1 sums the counted
 * cells' centres into a running centroid; pass 2 keeps the counted cell nearest
 * that centroid. The pin is served at THAT CELL's centre, never at the centroid —
 * see `buildGlobeSnapshot` for why.
 */
interface Anchor {
  /** Centroid sums (pass 1); divided when read. */
  lon: number;
  lat: number;
  n: number;
  /** The counted cell nearest the centroid so far (pass 2), and how far it is. */
  cell: number;
  km: number;
}

const newAnchor = (): Anchor => ({ lon: 0, lat: 0, n: 0, cell: -1, km: Infinity });

function countIn(a: Anchor, lon: number, lat: number): void {
  a.lon += lon;
  a.lat += lat;
  a.n += 1;
}

/**
 * Pass 2. An equal distance resolves to the LOWEST cell id, so the pin is a pure
 * function of the counted set and not of row order: a reload of an unchanged
 * planet must not move a marker between two equidistant cells.
 */
function pickNearest(a: Anchor, geo: GlobeGeo, cell: number, lon: number, lat: number): void {
  const km = geo.greatCircleKm(a.lon / a.n, a.lat / a.n, lon, lat);
  if (km < a.km || (km === a.km && cell < a.cell)) {
    a.km = km;
    a.cell = cell;
  }
}

/**
 * Bucket every public base onto the planet and total the sectors. Pure given rows.
 *
 * Three anchors per row, all from the frozen cell and nothing else: the SECTOR
 * that contains it (`sectorIdOfFineCell`), the 2° CLUSTER it joins inside that
 * sector (`coarseCellOfFineCell`), and the point it is counted at
 * (`fineCellCentreDeg`). Each pin is then placed ON a counted cell — the one
 * nearest the centroid of its members — in a second pass, because the centroid
 * itself is only guaranteed to lie inside the BOX (neither a sector nor a coarse
 * cell crosses the antimeridian; both grids start at −180°), not on ground: the
 * mean of bases on two shores is the sea between them. "A marker points at ground
 * that holds a base" (D-096) is therefore a MEMBERSHIP guarantee, not a geometric
 * one — and it keeps the pin inside its box for free, since a member is.
 */
export function buildGlobeSnapshot(rows: readonly GlobeAggRow[], geo: GlobeGeo, atMs: number): GlobeSnapshot {
  const sectorAcc = new Map<number, { counts: GlobeSectorCounts; anchor: Anchor; valleyIds: Set<string> }>();
  const clusterAcc = new Map<string, { cluster: GlobeCluster; anchor: Anchor }>();
  const byValleyId = new Map<string, GlobeValleyCount>();
  const byKeepLevel = new Map<number, Map<number, number>>();

  for (const r of rows) {
    const sectorId = geo.sectorIdOfFineCell(r.earthCell);
    const cell = geo.coarseCellOfFineCell(r.earthCell);
    const { lon, lat } = geo.fineCellCentreDeg(r.earthCell);
    const active = r.active ? 1 : 0;

    let s = sectorAcc.get(sectorId);
    if (!s) {
      s = {
        counts: { id: sectorId, valleys: 0, players: 0, active: 0, lon: 0, lat: 0 },
        anchor: newAnchor(),
        valleyIds: new Set(),
      };
      sectorAcc.set(sectorId, s);
    }
    s.counts.players += 1;
    s.counts.active += active;
    s.valleyIds.add(r.valleyId);
    countIn(s.anchor, lon, lat);

    const ck = `${sectorId}:${cell}`;
    let c = clusterAcc.get(ck);
    if (!c) {
      c = { cluster: { sectorId, cell, lon: 0, lat: 0, players: 0, active: 0 }, anchor: newAnchor() };
      clusterAcc.set(ck, c);
    }
    c.cluster.players += 1;
    c.cluster.active += active;
    countIn(c.anchor, lon, lat);

    const v = byValleyId.get(r.valleyId) ?? { valleyId: r.valleyId, players: 0, active: 0 };
    v.players += 1;
    v.active += active;
    byValleyId.set(r.valleyId, v);

    // Trophy histogram folded to the SECTOR, not kept per cluster: reach is asked
    // per sector, and a per-cluster scan would cost O(clusters) per request
    // instead of O(sectors).
    let hist = byKeepLevel.get(sectorId);
    if (!hist) { hist = new Map<number, number>(); byKeepLevel.set(sectorId, hist); }
    hist.set(r.keepLevel, (hist.get(r.keepLevel) ?? 0) + 1);
  }

  // Pass 2: settle every pin on the counted cell nearest its centroid. Every
  // accumulator a row can name was created by pass 1, so the lookups cannot miss.
  for (const r of rows) {
    const sectorId = geo.sectorIdOfFineCell(r.earthCell);
    const cell = geo.coarseCellOfFineCell(r.earthCell);
    const { lon, lat } = geo.fineCellCentreDeg(r.earthCell);
    pickNearest(sectorAcc.get(sectorId)!.anchor, geo, r.earthCell, lon, lat);
    pickNearest(clusterAcc.get(`${sectorId}:${cell}`)!.anchor, geo, r.earthCell, lon, lat);
  }

  const sectors: GlobeSectorCounts[] = [];
  for (const s of sectorAcc.values()) {
    s.counts.valleys = s.valleyIds.size;
    const pin = geo.fineCellCentreDeg(s.anchor.cell);
    s.counts.lon = pin.lon;
    s.counts.lat = pin.lat;
    sectors.push(s.counts);
  }
  sectors.sort((a, b) => a.id - b.id);

  const bySector = new Map<number, GlobeCluster[]>();
  for (const c of clusterAcc.values()) {
    const pin = geo.fineCellCentreDeg(c.anchor.cell);
    c.cluster.lon = pin.lon;
    c.cluster.lat = pin.lat;
    const list = bySector.get(c.cluster.sectorId);
    if (list) list.push(c.cluster); else bySector.set(c.cluster.sectorId, [c.cluster]);
  }
  // Rank each sector's clusters ONCE, viewer-agnostically: population desc, then
  // cell, so the cap below keeps the places worth looking at and the order is
  // identical for every viewer (proximity only refines it, per request).
  for (const list of bySector.values()) list.sort((a, b) => b.players - a.players || a.cell - b.cell);

  return { at: atMs, sectors, bySector, byValleyId, byKeepLevel };
}

// ---------------------------------------------------------------------------
// Viewer overlay
// ---------------------------------------------------------------------------

/** The whole per-viewer half of a globe request: indexed and proportional only
 * to the requesting wallet's own plotted-base count. */
export interface GlobeViewer {
  valleyId: string | null;
  trophies: number;
  /** The SELECTED base's Keep (the wallet's while the flag is off) — the
   *  attacker side of the D-099 reach predicate. */
  keepLevel: number;
  parcel: GlobeParcelLocation | null;
  ownedParcels: GlobeOwnedParcel[];
}

/**
 * The viewer's own place, rating and Keep. A LEFT JOIN, not `ensurePlotAssigned`: a
 * globe read must never write, and a player without a plot yet still gets an
 * honest planet (their own pin simply is not on it).
 */
async function loadViewer(
  db: Db, geo: GlobeGeo, viewer: string, requestedBaseId?: string,
): Promise<GlobeViewer> {
  const stable = multiBaseEnabled();
  const rows = await db.execute(stable ? sql`
    SELECT b.id AS "baseId",
           (b.status = 'active' AND COALESCE(bs.active, false)) AS active,
	           (b.land_paid_at IS NOT NULL) AS paid,
	           p.valley_id AS "valleyId", COALESCE(bp.trophies, 0)::int AS trophies,
           p.x, p.y, p.earth_cell AS "earthCell", v.site_id AS "siteId",
           pl.name AS name, pl.avatar_hash AS "avatarHash",
           pl.avatar_generation AS "avatarGeneration", b.keep_level AS "keepLevel"
    FROM players pl
    LEFT JOIN bases b ON b.owner_wallet = pl.wallet
	    LEFT JOIN base_slots bs ON bs.base_id = b.id AND bs.wallet = pl.wallet
	    LEFT JOIN base_profiles bp ON bp.base_id = b.id
    LEFT JOIN plots p ON p.base_id = b.id
    LEFT JOIN valleys v ON v.id = p.valley_id
    WHERE pl.wallet = ${viewer}
    ORDER BY b.id
  ` : sql`
    SELECT p.base_id AS "baseId", true AS active,
           p.valley_id AS "valleyId", pl.trophies AS trophies,
           p.x, p.y, p.earth_cell AS "earthCell", v.site_id AS "siteId",
           pl.keep_level AS "keepLevel"
    FROM players pl
    LEFT JOIN plots p ON p.player_wallet = pl.wallet
    LEFT JOIN valleys v ON v.id = p.valley_id
    WHERE pl.wallet = ${viewer} AND pl.entry_paid_at IS NOT NULL
    LIMIT 1
  `) as unknown as Array<{
    baseId: string | null;
    active: boolean;
    paid?: boolean;
    valleyId: string | null;
    trophies: number;
    x: number | null;
    y: number | null;
    earthCell: number | null;
    siteId: number | null;
    name?: string | null;
    avatarHash?: string | null;
    avatarGeneration?: string | null;
    keepLevel?: number | null;
  }>;
  const activeRows = stable ? rows.filter((candidate) => candidate.active) : rows;
  if (stable && requestedBaseId && !activeRows.some((candidate) => candidate.baseId === requestedBaseId)) {
    throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  }
  if (stable && !requestedBaseId && activeRows.length > 1) {
    throw new HttpError(409, 'baseId is required when multiple active bases exist', 'BASE_ID_REQUIRED');
  }
  const row = stable
    ? activeRows.find((candidate) => candidate.baseId === requestedBaseId) ?? activeRows[0]
    : rows[0];
  const parcel = row?.x !== null && row?.x !== undefined
    && row.y !== null && row.y !== undefined
    && row.earthCell !== null && row.earthCell !== undefined
    && row.siteId !== null && row.siteId !== undefined
    ? { x: row.x, y: row.y, earthCell: row.earthCell, siteId: row.siteId }
    : null;
  const ownedParcels = stable ? rows.flatMap((candidate): GlobeOwnedParcel[] => {
    if (!candidate.paid || !candidate.baseId || !candidate.valleyId
      || candidate.x === null || candidate.y === null
      || candidate.earthCell === null || candidate.siteId === null) return [];
    return [{
      baseId: candidate.baseId,
      active: candidate.active,
      // The sector that COUNTS this base, from the same cell the aggregate used —
      // so the private overlay and the public pins can never disagree about where
      // an owned deed is (D-096).
      sectorId: geo.sectorIdOfFineCell(candidate.earthCell),
      valleyId: candidate.valleyId,
      parcel: {
        siteId: candidate.siteId, earthCell: candidate.earthCell,
        x: candidate.x, y: candidate.y,
      },
      name: candidate.name ?? '',
      // The SAME opaque URL rule as getViewportParcels (game/world.ts): a
      // generation-keyed path, and only once an upload has actually landed.
      avatarUrl: candidate.avatarHash && candidate.avatarGeneration
        ? `/api/avatars/${candidate.avatarGeneration}.webp`
        : null,
      keepLevel: candidate.keepLevel ?? 1,
    }];
  }) : [];
  return {
    valleyId: row?.valleyId ?? null,
	    trophies: row?.trophies ?? 0,
    keepLevel: row?.keepLevel ?? 1,
    parcel,
    ownedParcels,
  };
}

/**
 * Sectors holding someone the viewer's Keep may attack, from the shared Keep
 * histogram. Uses THE attack predicate (D-099, `pvpMinDefenderKeep` — the same
 * bound createRaid's SQL and getParcelDetail apply), so the globe cannot
 * disagree with the raid rules about who is reachable. Exact, not a bucket
 * approximation: a level is its own bucket. Never used to omit a sector (owner
 * decision 1) — the ring is a highlight, the rest of the planet stays drawn.
 *
 * Every one of your PUBLIC, ACTIVE keeps that itself clears the bar is
 * discounted, AT ITS OWN LEVEL — each owned deed has its own Keep, and one that
 * falls below the bar is not in the counted range to begin with. Private
 * inactive deeds are absent from the public histogram and therefore have nothing
 * to subtract; without this filter an inactive deed could erase an unrelated
 * reachable player that happens to share its sector.
 */
export function reachSectorIds(
  snap: GlobeSnapshot, geo: GlobeGeo, me: GlobeViewer,
): number[] {
  const min = pvpMinDefenderKeep(me.keepLevel);
  const ownedBySector = new Map<number, number>();
  for (const owned of me.ownedParcels) {
    if (!owned.active || owned.keepLevel < min) continue;
    ownedBySector.set(owned.sectorId, (ownedBySector.get(owned.sectorId) ?? 0) + 1);
  }
  // Legacy mode has no stable base id to expose, but still has one wallet plot —
  // and its cell says which sector counts it, exactly as the aggregate decided.
  if (me.ownedParcels.length === 0 && me.parcel && me.keepLevel >= min) {
    ownedBySector.set(geo.sectorIdOfFineCell(me.parcel.earthCell), 1);
  }

  const out: number[] = [];
  for (const sector of snap.sectors) {
    const hist = snap.byKeepLevel.get(sector.id);
    if (!hist) continue;
    let found = 0;
    for (const [level, n] of hist) if (level >= min) found += n;
    found -= ownedBySector.get(sector.id) ?? 0;
    if (found > 0) out.push(sector.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request context — assembled BEFORE serialisation so the ETag is cheap
// ---------------------------------------------------------------------------

/**
 * Everything both globe routes need, and nothing more: the cached planet, the
 * wallet-scoped private viewer overlay and the live warzone flag.
 *
 * The split exists so the ETag can be computed and matched BEFORE any payload is
 * built (§1.4). GET /map hashes its finished ~48 KB body, so a 304 there still
 * pays for the whole snapshot assembly, the stringify and the sha1; here a 304 is
 * a cache read, indexed wallet-owned base/location reads and a string compare.
 */
export interface GlobeContext {
  snap: GlobeSnapshot;
  geo: GlobeGeo;
  me: GlobeViewer;
  warzoneActive: boolean;
}

export async function globeContext(
  db: Db, viewer: string, now = new Date(), baseId?: string,
): Promise<GlobeContext> {
  const geo = globeGeo();
  const [snap, me, cfg] = await Promise.all([
    getGlobeSnapshot(
      geo.tuning.cacheSec,
      async () => buildGlobeSnapshot(await loadGlobeRows(db, geo, now), geo, now.getTime()),
      now.getTime(),
    ),
    loadViewer(db, geo, viewer, baseId),
    getGameConfig(db),
  ]);
  return { snap, geo, me, warzoneActive: isWarzoneActive(cfg, now) };
}

/**
 * The validator: (cache stamp, warzone flag, viewer overlay). Everything either
 * route returns is a pure function of these plus the path, so an unchanged planet
 * answers 304 without building anything — the sector and cluster pins (the served
 * lon/lat) are part of the snapshot, so `snap.at` already covers them. The
 * viewer's own valley, trophies and Keep are IN the tag — one browser's cached
 * body can never be served to another account, and a Keep upgrade (which moves
 * the reach ring, D-099) must not answer 304 with the old ring — and so is what
 * the owned beacons SHOW (name, avatar, keep level): a rename or an avatar
 * upload must not answer 304 with the old face.
 */
export function globeEtagInput(ctx: GlobeContext, scope: string): string {
  const p = ctx.me.parcel;
  const owned = ctx.me.ownedParcels.map((entry) =>
    `${entry.baseId}:${entry.active ? 1 : 0}:${entry.sectorId}:${entry.valleyId}:`
      + `${entry.parcel.siteId}:${entry.parcel.earthCell}:${entry.parcel.x}:${entry.parcel.y}:`
      + `${entry.keepLevel}:${entry.avatarUrl ?? '-'}:${entry.name}`,
  ).join(',');
  return `${scope}|${ctx.snap.at}|${ctx.warzoneActive ? 1 : 0}|${ctx.me.valleyId ?? '-'}|${ctx.me.trophies}`
    + `|K${ctx.me.keepLevel}|${p ? `${p.siteId}:${p.earthCell}:${p.x}:${p.y}` : '-'}|${owned}`;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export function buildGlobeResponse(ctx: GlobeContext): GlobeResponse {
  return {
    // EVERY populated sector, always. Reach is the ring, not the guest list.
    sectors: ctx.snap.sectors.map((s) => ({
      id: s.id, valleys: s.valleys, players: s.players, active: s.active,
      lon: s.lon, lat: s.lat,
      warzone: ctx.warzoneActive,
    })),
    me: {
      // Home is a CELL, and the sector is the one that counts that cell — the same
      // derivation the aggregate made, so the pulse and the pin cannot part ways.
      sectorId: ctx.me.parcel ? ctx.geo.sectorIdOfFineCell(ctx.me.parcel.earthCell) : null,
      valleyId: ctx.me.valleyId,
      parcel: ctx.me.parcel,
      ownedParcels: ctx.me.ownedParcels,
      reachSectorIds: reachSectorIds(ctx.snap, ctx.geo, ctx.me),
    },
  };
}

/** A sector's label, derived from its centre. Deterministic, storage-free, and
 *  deliberately geographic rather than possessive — the globe shows population,
 *  never ownership, so a sector cannot be named after whoever holds it. */
export function sectorName(geo: GlobeGeo, id: number): string {
  const { lon, lat } = geo.sectorCentreDeg(id);
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.round(Math.abs(lat))}°${ns} ${Math.round(Math.abs(lon))}°${ew}`;
}

/**
 * Admit up to `cap` places from a viewer-agnostic ranked list: the viewer's own
 * places first (Home, then the wallet's other owned deeds, in that order), then
 * the ranked remainder. The shared cache is never written to — the result is a
 * fresh array per request — so nothing viewer-shaped can influence another
 * viewer's response, and even more same-sector deeds than the cap cannot grow
 * the shared place list (the complete owned set lives in `ownedParcels`).
 */
function admit<T>(ranked: readonly T[], keyOf: (t: T) => string, priority: readonly string[], cap: number): T[] {
  const selected: T[] = [];
  if (cap <= 0) return selected;
  for (const key of priority) {
    if (selected.length >= cap) break;
    const hit = ranked.find((t) => keyOf(t) === key);
    if (hit && !selected.includes(hit)) selected.push(hit);
  }
  for (const candidate of ranked) {
    if (selected.length >= cap) break;
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  return selected;
}

/** Dedupe while keeping first-seen order — the owned-priority list is ordered. */
function uniq(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  return keys.filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
}

/**
 * One sector's clusters, always capped at GLOBE.valleysPerSectorCap (the name
 * predates clusters; it has always bounded the region-band list). Private
 * membership priority is the cluster holding the selected Home cell first, then
 * the clusters holding the wallet's other owned deeds in stable owned-parcel
 * order; foreign capacity remains players-desc, proximity to Home, then cell.
 *
 * The ranked source stays cached and viewer-agnostic, and the exception is applied
 * to a fresh array per request. Nothing viewer-shaped is ever written back into
 * the shared cache or allowed to influence another viewer's response.
 */
export function buildGlobeSectorResponse(ctx: GlobeContext, id: number): GlobeSectorResponse {
  const { geo } = ctx;
  const cap = geo.tuning.valleysPerSectorCap;
  const home = ctx.me.parcel;
  const homeAt = home ? geo.fineCellCentreDeg(home.earthCell) : null;
  const dist = (lon: number, lat: number): number =>
    homeAt ? geo.greatCircleKm(homeAt.lon, homeAt.lat, lon, lat) : 0;

  const homeCluster = home && geo.sectorIdOfFineCell(home.earthCell) === id
    ? geo.coarseCellOfFineCell(home.earthCell)
    : null;
  const ownedClusterKeys = uniq([
    ...(homeCluster !== null ? [String(homeCluster)] : []),
    ...ctx.me.ownedParcels
      .filter((owned) => owned.sectorId === id)
      .map((owned) => String(geo.coarseCellOfFineCell(owned.parcel.earthCell))),
  ]);
  const clusterPriority = new Map(ownedClusterKeys.map((key, index) => [key, index]));
  const clusters = admit(ctx.snap.bySector.get(id) ?? [], (c) => String(c.cell), ownedClusterKeys, cap)
    .sort((a, b) => {
      const ap = clusterPriority.get(String(a.cell));
      const bp = clusterPriority.get(String(b.cell));
      if (ap !== undefined || bp !== undefined) {
        if (ap === undefined) return 1;
        if (bp === undefined) return -1;
        return ap - bp;
      }
      return b.players - a.players || dist(a.lon, a.lat) - dist(b.lon, b.lat) || a.cell - b.cell;
    })
    .map((c): GlobeSectorCluster => ({
      id: c.cell, lon: c.lon, lat: c.lat, players: c.players, warzone: ctx.warzoneActive,
      // Presence is yours to see about your OWN cluster only — see the wire type.
      // OMITTED, not zeroed: an absent field renders as nothing, whereas a 0 would
      // claim "nobody is home", which is a different (and false) statement.
      ...(c.cell === homeCluster ? { active: c.active } : {}),
    }));

  return { id, name: sectorName(geo, id), clusters };
}
