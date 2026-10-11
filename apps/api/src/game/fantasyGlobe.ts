/** Read-only fantasy world transport. Bulk reads expose public deed silhouettes
 * plus one effective `shielded` boolean per kingdom (D-181, owner 2026-09-26:
 * shielded state on the public realm feed); wallet, shield clocks and action
 * data stay confined to one metered parcel inspection. */
import { FANTASY_WORLD, GLOBE } from '@shardkeep/shared';
import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, getFantasyTile } from '@shardkeep/shared/fantasyWorld';
import { and, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bases, baseProfiles, baseSlots, fantasyLandClaims, fantasyWorldCatalog, players } from '../db/schema';
import { HttpError } from '../lib/errors';
import { earthViewportCellRanges, getFantasyOccupiedParcelDetail } from './world';
import { resolveActiveBase } from './baseOwnership';
import { getEffectivelyShieldedBaseIds } from './baseShields';
import { getGameConfig } from './gameConfig';
import { isWarzoneActive, warzoneStatus } from './warzone';

const publicClaim = sql`${fantasyLandClaims.state}='assigned'
  AND ${fantasyLandClaims.worldId}=${FANTASY_WORLD_ID}
  AND ${bases.status}='active' AND ${bases.landPaidAt} IS NOT NULL
  AND EXISTS (SELECT 1 FROM base_slots bs WHERE bs.base_id=${bases.id}
    AND bs.active AND bs.wallet=${bases.ownerWallet})
  AND NOT EXISTS (SELECT 1 FROM fantasy_retirement_exclusions e WHERE e.base_id=${bases.id}
    OR (e.mint_id IS NOT NULL AND e.mint_id=${bases.deedAssetId}))`;
function avatar(hash: string | null, generation: string | null): string | null {
  return /^[a-f0-9]{64}$/.test(hash ?? '') && /^[a-f0-9-]{36}$/.test(generation ?? '')
    ? `/api/avatars/${generation}.webp` : null;
}
async function assertCatalog(db: Db): Promise<void> {
  const [catalog] = await db.select().from(fantasyWorldCatalog)
    .where(eq(fantasyWorldCatalog.worldId, FANTASY_WORLD_ID));
  if (!catalog || catalog.catalogHash !== FANTASY_CATALOG_HASH || catalog.tileCount !== FANTASY_WORLD.totalTiles) {
    throw new HttpError(503, 'Fantasy land catalog is not ready', 'FANTASY_WORLD_NOT_READY');
  }
}

export async function getFantasyGlobe(db: Db, viewer: string, requestedBaseId?: string, now = new Date()) {
  await assertCatalog(db);
  // Explicit base IDs receive the same selected-base authorization as gameplay.
  if (requestedBaseId) await resolveActiveBase(db, viewer, requestedBaseId);
  const [counts, privateBases, config] = await Promise.all([
    db.execute(sql`SELECT t.realm_id AS "realmId", count(*)::int AS total,
      count(*) FILTER (WHERE c.state='assigned')::int AS occupied,
      count(*) FILTER (WHERE c.state='held')::int AS held,
      count(*) FILTER (WHERE c.id IS NULL AND t.allocation='ordinary')::int AS available,
      min(c.tile_id) FILTER (WHERE c.state='assigned' AND b.status='active'
        AND b.land_paid_at IS NOT NULL AND EXISTS (SELECT 1 FROM base_slots s
          WHERE s.base_id=b.id AND s.active AND s.wallet=b.owner_wallet)) AS "anchorTileId"
      FROM fantasy_world_tiles t
      LEFT JOIN fantasy_land_claims c ON c.world_id=t.world_id AND c.tile_id=t.tile_id AND c.state IN ('held','assigned')
      LEFT JOIN bases b ON b.id=c.base_id
      WHERE t.world_id=${FANTASY_WORLD_ID} GROUP BY t.realm_id`),
    db.select({ baseId: bases.id, status: bases.status, tileId: fantasyLandClaims.tileId,
      state: fantasyLandClaims.state, name: players.name, keepLevel: bases.keepLevel,
      avatarHash: players.avatarHash, avatarGeneration: players.avatarGeneration,
      active: baseSlots.active, selectedAt: baseSlots.selectedAt,
    }).from(bases).innerJoin(players, eq(players.wallet, bases.ownerWallet))
      .leftJoin(baseSlots, and(eq(baseSlots.baseId, bases.id), eq(baseSlots.wallet, viewer)))
      .leftJoin(fantasyLandClaims, and(eq(fantasyLandClaims.baseId, bases.id),
        eq(fantasyLandClaims.state, 'assigned'), eq(fantasyLandClaims.worldId, FANTASY_WORLD_ID)))
      .where(and(eq(bases.ownerWallet, viewer), isNotNull(bases.landPaidAt))),
    getGameConfig(db),
  ]);
  const selectedBaseId = requestedBaseId ?? privateBases.filter(b => b.active && b.status === 'active')
    .sort((a, b) => (b.selectedAt?.getTime() ?? 0) - (a.selectedAt?.getTime() ?? 0) || a.baseId.localeCompare(b.baseId))[0]?.baseId ?? null;
  const ownedTiles = privateBases.flatMap(b => {
    const tile = b.tileId === null ? null : getFantasyTile(b.tileId);
    return tile ? [{ baseId: b.baseId, tileId: tile.tileId, realmId: tile.realmId,
      name: b.name, avatarUrl: avatar(b.avatarHash, b.avatarGeneration), keepLevel: b.keepLevel,
      active: Boolean(b.active && b.status === 'active'), selected: b.baseId === selectedBaseId }] : [];
  });
  const byRealm = new Map((counts as unknown as Array<{ realmId: string; total: number; occupied: number; held: number; available: number; anchorTileId: number | null }>).map(row => [row.realmId, row]));
  return { worldId: FANTASY_WORLD_ID, catalogHash: FANTASY_CATALOG_HASH, ready: true, warzone: warzoneStatus(config, now),
    realms: REALM_IDS.map(realmId => byRealm.get(realmId) ?? { realmId, total: 0, occupied: 0, held: 0, available: 0, anchorTileId: null }),
    me: { baseId: selectedBaseId, selectedTileId: ownedTiles.find(t => t.selected)?.tileId ?? null, ownedTiles } };
}

/** Search has the same active paid visibility as markers, and never returns
 * the original Earth address or a wallet-to-history association. */
export async function searchFantasyPlayers(db: Db, query: string) {
  await assertCatalog(db);
  const needle = query.trim();
  if (needle.length < 2) return { results: [] };
  const escaped = needle.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
  const rows = await db.select({ tileId: fantasyLandClaims.tileId, name: players.name,
    avatarHash: players.avatarHash, avatarGeneration: players.avatarGeneration,
    keepLevel: bases.keepLevel, seeker: players.seekerVerified,
    trophies: sql<number>`coalesce(${baseProfiles.trophies}, 0)::int`,
  }).from(fantasyLandClaims).innerJoin(bases, eq(bases.id, fantasyLandClaims.baseId))
    .innerJoin(players, eq(players.wallet, bases.ownerWallet))
    .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
    .where(and(publicClaim, or(ilike(players.name, `%${escaped}%`), ilike(players.wallet, `${escaped}%`))))
    .orderBy(desc(sql`coalesce(${baseProfiles.trophies}, 0)`), fantasyLandClaims.tileId).limit(10);
  return { results: rows.map(row => ({ tileId: row.tileId, realmId: getFantasyTile(row.tileId)!.realmId,
    name: row.name, avatarUrl: avatar(row.avatarHash, row.avatarGeneration),
    keepLevel: row.keepLevel, trophies: row.trophies, seeker: row.seeker })) };
}

/** One bulk realm-feed kingdom. Never widen this by spreading a row: a base row
 * would also disclose wallet, shield clocks, loot, presence and raid state. */
export interface FantasyViewportMarker {
  tileId: number;
  name: string;
  avatarUrl: string | null;
  keepLevel: number;
  /** Effective protection at the request instant, the raid gate's own rule: a
   * live shield counts unless the current warzone suppresses it. Never an expiry. */
  shielded: boolean;
}

export async function getFantasyViewport(db: Db, rect: { x0: number; x1: number; y0: number; y1: number }, centre?: { lon: number; lat: number }, now = new Date()) {
  await assertCatalog(db);
  // The accepted fantasy lattice has the same dimensions; this existing helper
  // validates area/span limits and antimeridian ranges without reading Earth art.
  const ranges = earthViewportCellRanges(rect);
  const predicates = ranges.map(r => sql`${fantasyLandClaims.tileId} BETWEEN ${r.min} AND ${r.max}`);
  const [rows, config] = await Promise.all([db.select({ baseId: bases.id, tileId: fantasyLandClaims.tileId, name: players.name,
    avatarHash: players.avatarHash, avatarGeneration: players.avatarGeneration, keepLevel: bases.keepLevel,
  }).from(fantasyLandClaims).innerJoin(bases, eq(bases.id, fantasyLandClaims.baseId))
    .innerJoin(players, eq(players.wallet, bases.ownerWallet))
    .where(and(publicClaim, sql`(${sql.join(predicates, sql` OR `)})`)).limit(GLOBE.parcelViewportMaxCells),
  getGameConfig(db)]);
  const endX = rect.x1 < rect.x0 ? rect.x1 + FANTASY_WORLD.columns : rect.x1;
  const from = centre ?? { lon: ((rect.x0 + endX + 1) / 2 * 360 / FANTASY_WORLD.columns) % 360 - 180,
    lat: 90 - (rect.y0 + rect.y1 + 1) / 2 * 180 / FANTASY_WORLD.rows };
  const distance = (id: number) => {
    const tile = getFantasyTile(id);
    if (!tile) throw new Error('Persisted fantasy marker is not in catalog');
    const dx = ((tile.lon - from.lon + 540) % 360) - 180;
    return (dx * Math.cos(from.lat * Math.PI / 180)) ** 2 + (tile.lat - from.lat) ** 2;
  };
  rows.sort((a, b) => distance(a.tileId) - distance(b.tileId) || a.tileId - b.tileId);
  const kept = rows.slice(0, GLOBE.parcelViewportMaxMarkers);
  // One batched read for the kept kingdoms only, never one per marker. The
  // warzone flag is the CURRENT window, which warzoneStatus already publishes;
  // a future purge start stays private.
  const shielded = await getEffectivelyShieldedBaseIds(db, kept.map(r => r.baseId), now, isWarzoneActive(config, now));
  const markers = kept.map((r): FantasyViewportMarker => ({ tileId: r.tileId, name: r.name,
    avatarUrl: avatar(r.avatarHash, r.avatarGeneration), keepLevel: r.keepLevel, shielded: shielded.has(r.baseId) }));
  return { worldId: FANTASY_WORLD_ID, scope: rect, matched: rows.length, truncated: kept.length < rows.length, markers };
}

export async function getFantasyParcel(db: Db, viewer: string, tileId: number, now = new Date(), viewerBaseId?: string) {
  await assertCatalog(db);
  const tile = getFantasyTile(tileId);
  if (!tile) throw new HttpError(404, 'This is not deeded terrain', 'FANTASY_TILE_NOT_FOUND');
  if (viewerBaseId) await resolveActiveBase(db, viewer, viewerBaseId);
  if (tile.allocation !== 'ordinary') return { worldId: FANTASY_WORLD_ID, tile, availability: 'reserved' as const, detail: null };
  const [claim] = await db.select().from(fantasyLandClaims).where(and(
    eq(fantasyLandClaims.worldId, FANTASY_WORLD_ID), eq(fantasyLandClaims.tileId, tileId),
    inArray(fantasyLandClaims.state, ['held', 'assigned']),
  ));
  if (!claim) return { worldId: FANTASY_WORLD_ID, tile, availability: 'available' as const, detail: null };
  if (claim.state === 'held') return { worldId: FANTASY_WORLD_ID, tile, availability: 'held' as const, detail: null };
  const [visible] = await db.select({ id: bases.id }).from(fantasyLandClaims)
    .innerJoin(bases, eq(bases.id, fantasyLandClaims.baseId)).where(and(publicClaim, eq(fantasyLandClaims.id, claim.id)));
  const detail = visible ? await getFantasyOccupiedParcelDetail(db, viewer, tileId, claim.baseId, now, viewerBaseId) : null;
  return { worldId: FANTASY_WORLD_ID, tile, availability: 'occupied' as const, detail };
}
