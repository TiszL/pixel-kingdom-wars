/**
 * Authoritative saved base layouts (GDD §3.9).
 *
 * A/B are the two player-facing slots (HOME/FARM); C remains a hidden legacy
 * reservation.  Layout rows and SHARDS are both keyed by stable base id, so the
 * entitlement and presets convey with a deed without copying wallet state.
 *
 * Every mutation locks player -> base -> active slot -> incoming raid lock via
 * stableBasePrerequisites before it reads layouts/buildings.  Applying a layout
 * is one transaction and one set-based coordinate update: swaps never pass
 * through an invalid intermediate position and failures move nothing.
 */
import { createHash } from 'node:crypto';
import {
  BUILDING_GEOMETRY, ECONOMY, OBSTACLES, plotBounds, plotVersionForClaim, resolvePlotVersion, type BuildingType,
} from '@shardkeep/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  buildings, layouts, obstacles, players,
} from '../db/schema';
import { getOrCreateBaseAccount } from '../ledger/accounts';
import { InsufficientFundsError } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { spendBaseShards } from './baseEconomy';
import { claimRect, footprintOf, insideClaim, overlaps, type Rect } from './footprints';
import {
  lockStablePrerequisiteBase, requireActiveStablePrerequisiteBase,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';

export const LAYOUT_GEOMETRY_VERSION = BUILDING_GEOMETRY.legacyVersion;
export const FARM_LAYOUT_UNLOCK_SHARDS = ECONOMY.secondLayoutSlotShards;

export type PublicLayoutSlot = 'HOME' | 'FARM';
type StorageLayoutSlot = 'A' | 'B' | 'C';

export interface LayoutPosition {
  buildingId: string;
  tx: number;
  ty: number;
}

export interface SaveLayoutInput {
  geometryVersion: number;
  plotVersion?: number | undefined;
  mode: 'save' | 'save_apply';
  expectedSlotEtag: string;
  expectedActiveEtag?: string | undefined;
  positions: LayoutPosition[];
}

type BuildingRow = typeof buildings.$inferSelect;
type ObstacleRow = typeof obstacles.$inferSelect;
type LayoutRow = typeof layouts.$inferSelect;

const toStorageSlot = (slot: PublicLayoutSlot): 'A' | 'B' => slot === 'HOME' ? 'A' : 'B';
const toPublicSlot = (slot: StorageLayoutSlot | null): PublicLayoutSlot | null => (
  slot === 'A' ? 'HOME' : slot === 'B' ? 'FARM' : null
);

function canonicalPositions(positions: readonly LayoutPosition[]): LayoutPosition[] {
  return [...positions]
    .map(({ buildingId, tx, ty }) => ({ buildingId, tx, ty }))
    // UUID byte/text order is locale-independent, so the same content hashes to
    // the same ETag on every host regardless of its ICU/default locale.
    .sort((a, b) => a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0);
}

function samePositions(a: readonly LayoutPosition[], b: readonly LayoutPosition[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((position, index) => {
    const other = b[index];
    return other !== undefined
      && position.buildingId === other.buildingId
      && position.tx === other.tx
      && position.ty === other.ty;
  });
}

function sha256Etag(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function slotEtag(slot: PublicLayoutSlot, positions: readonly LayoutPosition[]): string {
  return sha256Etag({ kind: 'layout-slot', geometryVersion: LAYOUT_GEOMETRY_VERSION, slot, positions });
}

function activeEtag(
  storageSlot: StorageLayoutSlot | null,
  claim: { min: number; max: number },
  positions: readonly LayoutPosition[],
): string {
  return sha256Etag({
    kind: 'active-layout', geometryVersion: LAYOUT_GEOMETRY_VERSION,
    storageSlot, claim, positions,
  });
}

function activeStorageSlot(rows: readonly LayoutRow[]): StorageLayoutSlot | null {
  const active = rows.filter((row) => row.isActive);
  return active.length === 1 ? active[0]!.slot : null;
}

function positionsOfBuildings(rows: readonly BuildingRow[]): LayoutPosition[] {
  return canonicalPositions(rows.map((row) => ({ buildingId: row.id, tx: row.tx, ty: row.ty })));
}

interface StoredPositions {
  positions: LayoutPosition[];
  malformed: boolean;
}

/** Persistence predates the API and is jsonb: parse defensively and surface a
 * repair state instead of returning unsafe/untyped data to the client. */
function storedPositions(value: unknown): StoredPositions {
  if (!Array.isArray(value)) return { positions: [], malformed: true };
  const parsed: LayoutPosition[] = [];
  let malformed = false;
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      malformed = true;
      continue;
    }
    const candidate = item as Partial<LayoutPosition>;
    if (typeof candidate.buildingId !== 'string'
      || !Number.isInteger(candidate.tx) || !Number.isInteger(candidate.ty)) {
      malformed = true;
      continue;
    }
    parsed.push({ buildingId: candidate.buildingId, tx: candidate.tx!, ty: candidate.ty! });
  }
  return { positions: canonicalPositions(parsed), malformed };
}

function obstacleRect(row: ObstacleRow): Rect {
  for (const definition of Object.values(OBSTACLES.tiers)) {
    if ((definition.kinds as readonly string[]).includes(row.spriteKey)) {
      return { tx: row.tx, ty: row.ty, fw: definition.sizeTiles, fh: definition.sizeTiles };
    }
  }
  throw new HttpError(500, `unknown obstacle sprite: ${row.spriteKey}`, 'LAYOUT_OBSTACLE_UNKNOWN');
}

function invalidLayout(message: string): never {
  throw new HttpError(422, message, 'LAYOUT_INVALID');
}

/** Validate the COMPLETE target inventory against live types/claim/terrain.
 * Jobs, levels, resources and trap state are intentionally neither read nor
 * written: a layout is coordinates only. */
function validateTarget(
  requested: readonly LayoutPosition[],
  liveBuildings: readonly BuildingRow[],
  liveObstacles: readonly ObstacleRow[],
  expansions: number,
): LayoutPosition[] {
  const bounds = plotBounds(plotVersionForClaim(claimRect(expansions)));
  if (requested.length > (bounds.max - bounds.min) ** 2) invalidLayout('layout has too many positions');
  const positions = canonicalPositions(requested);
  const liveById = new Map(liveBuildings.map((building) => [building.id, building]));
  const seen = new Set<string>();
  for (const position of positions) {
    if (!position.buildingId || seen.has(position.buildingId)) {
      invalidLayout('layout contains a missing or duplicate building id');
    }
    seen.add(position.buildingId);
    if (!Number.isInteger(position.tx) || !Number.isInteger(position.ty)) {
      invalidLayout('layout coordinates must be integers');
    }
    if (!liveById.has(position.buildingId)) invalidLayout('layout contains a foreign or removed building');
  }
  if (positions.length !== liveBuildings.length
    || liveBuildings.some((building) => !seen.has(building.id))) {
    invalidLayout('layout must place every current building exactly once');
  }
  if (liveBuildings.filter((building) => building.type === 'keep').length !== 1) {
    invalidLayout('base must contain exactly one Keep');
  }

  const rects = positions.map((position) => {
    const building = liveById.get(position.buildingId)!;
    const rect: Rect = {
      tx: position.tx, ty: position.ty,
      ...footprintOf(building.type as BuildingType, LAYOUT_GEOMETRY_VERSION),
    };
    if (!insideClaim(rect, expansions)) invalidLayout('a building would leave the buildable claim');
    return { buildingId: building.id, rect };
  });
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (overlaps(rects[i]!.rect, rects[j]!.rect)) {
        invalidLayout('layout buildings overlap');
      }
    }
  }
  const terrain = liveObstacles.map(obstacleRect);
  for (const { rect } of rects) {
    if (terrain.some((obstacle) => overlaps(rect, obstacle))) {
      invalidLayout('a building would be blocked by an obstacle');
    }
  }
  return positions;
}

function inspectSlot(
  raw: unknown,
  liveBuildings: readonly BuildingRow[],
  liveObstacles: readonly ObstacleRow[],
  expansions: number,
): {
  positions: LayoutPosition[];
  compatibility: 'empty' | 'ready' | 'needs_repair';
  unplacedBuildingIds: string[];
  removedBuildingIds: string[];
} {
  const stored = storedPositions(raw);
  const currentIds = new Set(liveBuildings.map((building) => building.id));
  const savedIds = new Set(stored.positions.map((position) => position.buildingId));
  const unplacedBuildingIds = liveBuildings.map((building) => building.id)
    .filter((id) => !savedIds.has(id)).sort();
  const removedBuildingIds = stored.positions.map((position) => position.buildingId)
    .filter((id) => !currentIds.has(id)).sort();
  if (stored.positions.length === 0 && !stored.malformed) {
    return { positions: [], compatibility: 'empty', unplacedBuildingIds, removedBuildingIds };
  }
  let compatible = !stored.malformed;
  if (compatible) {
    try {
      validateTarget(stored.positions, liveBuildings, liveObstacles, expansions);
    } catch {
      compatible = false;
    }
  }
  return {
    positions: stored.positions,
    compatibility: compatible ? 'ready' : 'needs_repair',
    unplacedBuildingIds,
    removedBuildingIds,
  };
}

export async function getBaseLayouts(db: Db, wallet: string, baseId: string) {
  const base = await requireActiveStablePrerequisiteBase(db, wallet, baseId);
  const [liveBuildings, liveObstacles, saved] = await Promise.all([
    db.select().from(buildings).where(eq(buildings.baseId, base.id)).orderBy(asc(buildings.id)),
    db.select().from(obstacles).where(and(
      eq(obstacles.baseId, base.id), isNull(obstacles.clearedAt),
    )).orderBy(asc(obstacles.id)),
    db.select().from(layouts).where(eq(layouts.baseId, base.id)).orderBy(asc(layouts.slot)),
  ]);
  const claim = claimRect(base.expansions);
  const live = positionsOfBuildings(liveBuildings);
  const bySlot = new Map(saved.map((row) => [row.slot, row]));
  const activeStorage = activeStorageSlot(saved);
  const homeRow = bySlot.get('A');
  const farmRow = bySlot.get('B');
  // Before HOME is explicitly saved, its useful initial draft is the live base.
  const home = homeRow
    ? inspectSlot(homeRow.positions, liveBuildings, liveObstacles, base.expansions)
    : inspectSlot(live, liveBuildings, liveObstacles, base.expansions);
  const farm = farmRow
    ? inspectSlot(farmRow.positions, liveBuildings, liveObstacles, base.expansions)
    : inspectSlot([], liveBuildings, liveObstacles, base.expansions);
  return {
    baseId: base.id,
    geometryVersion: LAYOUT_GEOMETRY_VERSION,
    ...(plotVersionForClaim(claim) === 2 ? { plotVersion: 2 as const } : {}),
    claim: { ...claim, size: claim.max - claim.min },
    active: {
      slot: toPublicSlot(activeStorage),
      etag: activeEtag(activeStorage, claim, live),
    },
    farmUnlock: {
      locked: farmRow === undefined,
      costShards: FARM_LAYOUT_UNLOCK_SHARDS,
    },
    slots: [
      {
        slot: 'HOME' as const, locked: false,
        etag: slotEtag('HOME', home.positions), ...home,
      },
      {
        slot: 'FARM' as const, locked: farmRow === undefined,
        etag: slotEtag('FARM', farm.positions), ...farm,
      },
    ],
  };
}

export async function unlockFarmLayout(
  db: Db,
  wallet: string,
  context: StableBaseMutationContext,
  idempotencyKey: string,
) {
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const base = await lockStablePrerequisiteBase(tx, wallet, context);
    const [existing] = await tx.select().from(layouts).where(and(
      eq(layouts.baseId, base.id), eq(layouts.slot, 'B'),
    )).for('update');
    if (existing) {
      // Compatibility wallet is not authority, but keeping it current prevents
      // old tooling from presenting the seller after a deed transfer.
      if (existing.playerWallet !== wallet) {
        await tx.update(layouts).set({ playerWallet: wallet }).where(eq(layouts.id, existing.id));
      }
      const account = await getOrCreateBaseAccount(tx, base.id, 'base_shards');
      return {
        baseId: base.id, slot: 'FARM' as const, locked: false,
        chargedShards: '0', balanceShards: account.balance.toString(),
      };
    }
    try {
      await spendBaseShards(
        tx, base.id, BigInt(FARM_LAYOUT_UNLOCK_SHARDS), 'layout.farm_unlock',
        `layout-farm-unlock:${base.id}:${idempotencyKey}`,
        { baseId: base.id, slot: 'FARM', wallet },
      );
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new HttpError(
          // Slot-neutral: the client labels slot B (D-099 "BASE"); the wire id
          // FARM is a contract (D-087), not copy a player should read.
          422, `unlocking this layout slot costs ${FARM_LAYOUT_UNLOCK_SHARDS} shards`, 'INSUFFICIENT_SHARDS',
        );
      }
      throw error;
    }
    await tx.insert(layouts).values({
      playerWallet: wallet, baseId: base.id, slot: 'B', isActive: false, positions: [],
    });
    const account = await getOrCreateBaseAccount(tx, base.id, 'base_shards');
    return {
      baseId: base.id, slot: 'FARM' as const, locked: false,
      chargedShards: String(FARM_LAYOUT_UNLOCK_SHARDS), balanceShards: account.balance.toString(),
    };
  });
}

export async function saveBaseLayout(
  db: Db,
  wallet: string,
  context: StableBaseMutationContext,
  slot: PublicLayoutSlot,
  input: SaveLayoutInput,
) {
  if (input.geometryVersion !== LAYOUT_GEOMETRY_VERSION) {
    throw new HttpError(409, 'layout geometry changed — refresh before saving', 'LAYOUT_GEOMETRY_STALE');
  }
  return db.transaction(async (tx) => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    if (!player) throw new HttpError(404, 'player not found');
    const base = await lockStablePrerequisiteBase(tx, wallet, context);
    const plotVersion = plotVersionForClaim(claimRect(base.expansions));
    let requestedPlotVersion: number;
    try { requestedPlotVersion = resolvePlotVersion(input.plotVersion); }
    catch { throw new HttpError(409, 'layout plot changed — refresh before saving', 'LAYOUT_PLOT_STALE'); }
    if (requestedPlotVersion !== plotVersion) {
      throw new HttpError(409, 'layout plot changed — refresh before saving', 'LAYOUT_PLOT_STALE');
    }
    const saved = await tx.select().from(layouts).where(eq(layouts.baseId, base.id))
      .orderBy(asc(layouts.slot)).for('update');
    const liveBuildings = await tx.select().from(buildings).where(eq(buildings.baseId, base.id))
      .orderBy(asc(buildings.id)).for('update');
    const liveObstacles = await tx.select().from(obstacles).where(and(
      eq(obstacles.baseId, base.id), isNull(obstacles.clearedAt),
    )).orderBy(asc(obstacles.id));
    const storageSlot = toStorageSlot(slot);
    const targetRow = saved.find((row) => row.slot === storageSlot);
    if (slot === 'FARM' && !targetRow) {
      throw new HttpError(403, 'unlock this layout slot before saving it', 'LAYOUT_SLOT_LOCKED');
    }
    const target = validateTarget(input.positions, liveBuildings, liveObstacles, base.expansions);
    const claim = claimRect(base.expansions);
    const live = positionsOfBuildings(liveBuildings);
    const activeStorage = activeStorageSlot(saved);
    const parsedTargetRow = targetRow ? storedPositions(targetRow.positions) : null;
    const currentSlot = parsedTargetRow
      ? parsedTargetRow.positions
      : live; // unsaved HOME begins as a virtual copy of the live base
    const currentSlotEtag = slotEtag(slot, currentSlot);
    const currentActiveEtag = activeEtag(activeStorage, claim, live);

    // Content-idempotent retry wins over stale ETags. This branch deliberately
    // requires an actual saved row: a virtual unsaved HOME still needs its first
    // durable write even when its coordinates equal the live base.
    const slotAlreadySaved = targetRow !== undefined && parsedTargetRow?.malformed === false
      && samePositions(currentSlot, target);
    const liveAlreadyApplied = samePositions(live, target) && activeStorage === storageSlot;
    if (slotAlreadySaved && (input.mode === 'save' || liveAlreadyApplied)) {
      return {
        baseId: base.id, slot, geometryVersion: LAYOUT_GEOMETRY_VERSION,
        ...(plotVersion === 2 ? { plotVersion } : {}),
        slotEtag: currentSlotEtag, activeEtag: currentActiveEtag,
        activeSlot: toPublicSlot(activeStorage), moved: 0,
        unchanged: liveBuildings.length, replayed: true,
      };
    }
    if (input.expectedSlotEtag !== currentSlotEtag) {
      throw new HttpError(409, 'saved layout changed — refresh before saving', 'LAYOUT_STALE');
    }
    if (input.mode === 'save_apply') {
      if (!input.expectedActiveEtag || input.expectedActiveEtag !== currentActiveEtag) {
        throw new HttpError(409, 'active base changed — refresh before applying', 'LAYOUT_STALE');
      }
    }

    const liveById = new Map(live.map((position) => [position.buildingId, position]));
    const moved = input.mode === 'save_apply'
      ? target.filter((position) => {
        const before = liveById.get(position.buildingId)!;
        return before.tx !== position.tx || before.ty !== position.ty;
      }).length
      : 0;
    if (input.mode === 'save_apply' && moved > 0) {
      // One statement, not N sequential moves. PostgreSQL validates/commits the
      // final coordinate set as a unit, so swapping two occupied tiles is safe.
      const payload = JSON.stringify(target.map((position) => ({
        id: position.buildingId, tx: position.tx, ty: position.ty,
      })));
      await tx.execute(sql`
        update ${buildings} as b
           set tx = p.tx, ty = p.ty
          from jsonb_to_recordset(${payload}::jsonb) as p(id uuid, tx integer, ty integer)
         where b.id = p.id and b.base_id = ${base.id}
      `);
    }
    if (input.mode === 'save_apply') {
      await tx.update(layouts).set({ isActive: false }).where(eq(layouts.baseId, base.id));
    }
    if (targetRow) {
      await tx.update(layouts).set({
        playerWallet: wallet, positions: target,
        ...(input.mode === 'save_apply' ? { isActive: true } : {}),
      }).where(eq(layouts.id, targetRow.id));
    } else {
      await tx.insert(layouts).values({
        playerWallet: wallet, baseId: base.id, slot: storageSlot,
        isActive: input.mode === 'save_apply', positions: target,
      });
    }
    const nextActiveStorage = input.mode === 'save_apply' ? storageSlot : activeStorage;
    const nextLive = input.mode === 'save_apply' ? target : live;
    return {
      baseId: base.id, slot, geometryVersion: LAYOUT_GEOMETRY_VERSION,
        ...(plotVersion === 2 ? { plotVersion } : {}),
      slotEtag: slotEtag(slot, target),
      activeEtag: activeEtag(nextActiveStorage, claim, nextLive),
      activeSlot: toPublicSlot(nextActiveStorage), moved,
      unchanged: liveBuildings.length - moved, replayed: false,
    };
  });
}
