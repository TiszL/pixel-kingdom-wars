import { OBSTACLES, isInsidePlot } from '@shardkeep/shared';
import { supportedPlotVersion } from '../../game/world/basePlot';
import { footprintOf } from '../../game/fx/stats';
import type {
  LayoutBuilding, LayoutObstacle, LayoutPosition, LayoutSlot, LayoutSlotDto,
} from './types';

export const LAYOUT_UNDO_LIMIT = 40;
export const LEGACY_LAYOUT_STORAGE_KEY = 'skp_layouts';
const LEGACY_IMPORT_VERSION = 1;

export interface LayoutGeometry {
  geometryVersion: number;
  plotVersion?: number;
  claim: { min: number; max: number };
  buildings: LayoutBuilding[];
  obstacles: LayoutObstacle[];
}

interface DraftSnapshot {
  positions: LayoutPosition[];
  trayIds: string[];
  selectedId: string | null;
}

export interface LayoutDraft extends DraftSnapshot {
  history: DraftSnapshot[];
  dirty: boolean;
}

export interface DraftResult {
  draft: LayoutDraft;
  error: string | null;
}

const canonical = (positions: readonly LayoutPosition[]): LayoutPosition[] => [...positions]
  .map(({ buildingId, tx, ty }) => ({ buildingId, tx, ty }))
  .sort((a, b) => a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0);

const snapshot = (draft: LayoutDraft): DraftSnapshot => ({
  positions: canonical(draft.positions),
  trayIds: [...draft.trayIds],
  selectedId: draft.selectedId,
});

function changed(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function commit(draft: LayoutDraft, next: DraftSnapshot): LayoutDraft {
  const before = snapshot(draft);
  const normalized = { ...next, positions: canonical(next.positions) };
  if (!changed(before, normalized)) return draft;
  return {
    ...normalized,
    history: [...draft.history, before].slice(-LAYOUT_UNDO_LIMIT),
    dirty: true,
  };
}

function obstacleSize(spriteKey: string): number {
  for (const tier of Object.values(OBSTACLES.tiers)) {
    if ((tier.kinds as readonly string[]).includes(spriteKey)) return tier.sizeTiles;
  }
  return 1;
}

function overlaps(
  a: { tx: number; ty: number; fw: number; fh: number },
  b: { tx: number; ty: number; fw: number; fh: number },
): boolean {
  return a.tx < b.tx + b.fw && b.tx < a.tx + a.fw
    && a.ty < b.ty + b.fh && b.ty < a.ty + a.fh;
}

export function validatePlacement(
  geometry: LayoutGeometry,
  positions: readonly LayoutPosition[],
  buildingId: string,
  tx: number,
  ty: number,
): string | null {
  if (!supportedPlotVersion(geometry.plotVersion)) return 'UPDATE THE GAME TO EDIT THIS BASE';
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) return 'BUILDINGS SNAP TO WHOLE TILES';
  const building = geometry.buildings.find((row) => row.id === buildingId);
  if (!building) return 'BUILDING NO LONGER EXISTS';
  const [fw, fh] = footprintOf(building.type, geometry.geometryVersion);
  const target = { tx, ty, fw, fh };
  if (!isInsidePlot(target, geometry.plotVersion)
    || tx < geometry.claim.min || ty < geometry.claim.min
    || tx + fw > geometry.claim.max || ty + fh > geometry.claim.max) {
    return 'OUTSIDE THE ACTIVE CLAIM';
  }
  for (const position of positions) {
    if (position.buildingId === buildingId) continue;
    const other = geometry.buildings.find((row) => row.id === position.buildingId);
    if (!other) continue;
    const [ofw, ofh] = footprintOf(other.type, geometry.geometryVersion);
    if (overlaps(target, { tx: position.tx, ty: position.ty, fw: ofw, fh: ofh })) {
      return 'ANOTHER BUILDING OCCUPIES THOSE TILES';
    }
  }
  for (const obstacle of geometry.obstacles) {
    const size = obstacleSize(obstacle.spriteKey);
    if (overlaps(target, { tx: obstacle.tx, ty: obstacle.ty, fw: size, fh: size })) {
      return 'AN OBSTACLE BLOCKS THOSE TILES';
    }
  }
  return null;
}

export function validateCompleteLayout(
  geometry: LayoutGeometry,
  positions: readonly LayoutPosition[],
): string | null {
  if (positions.length !== geometry.buildings.length) return 'LAYOUT MUST PLACE EVERY BUILDING';
  const ids = new Set(positions.map((position) => position.buildingId));
  if (ids.size !== positions.length
    || geometry.buildings.some((building) => !ids.has(building.id))) {
    return 'LAYOUT BUILDING IDENTITIES DO NOT MATCH THIS BASE';
  }
  for (const position of positions) {
    const error = validatePlacement(
      geometry, positions, position.buildingId, position.tx, position.ty,
    );
    if (error) return error;
  }
  return null;
}

/** Empty/repair slots begin from the authoritative live base. A repair never
 * guesses where a removed or newly-built identity should go. */
export function createDraft(
  buildings: readonly LayoutBuilding[],
  slot: LayoutSlotDto,
): LayoutDraft {
  const live = canonical(buildings.map(({ id, tx, ty }) => ({ buildingId: id, tx, ty })));
  const positions = slot.compatibility === 'ready' ? canonical(slot.positions) : live;
  return {
    positions,
    trayIds: [],
    selectedId: null,
    history: [],
    dirty: slot.compatibility !== 'ready',
  };
}

export function selectBuilding(draft: LayoutDraft, buildingId: string | null): LayoutDraft {
  return { ...draft, selectedId: buildingId };
}

export function moveBuilding(
  draft: LayoutDraft,
  geometry: LayoutGeometry,
  buildingId: string,
  tx: number,
  ty: number,
): DraftResult {
  const error = validatePlacement(geometry, draft.positions, buildingId, tx, ty);
  if (error) return { draft, error };
  const exists = draft.positions.some((position) => position.buildingId === buildingId);
  const positions = exists
    ? draft.positions.map((position) => position.buildingId === buildingId
      ? { buildingId, tx, ty } : position)
    : [...draft.positions, { buildingId, tx, ty }];
  return {
    draft: commit(draft, {
      positions,
      trayIds: draft.trayIds.filter((id) => id !== buildingId),
      selectedId: buildingId,
    }),
    error: null,
  };
}

export function nudgeSelected(
  draft: LayoutDraft,
  geometry: LayoutGeometry,
  dx: number,
  dy: number,
): DraftResult {
  if (!draft.selectedId) return { draft, error: 'SELECT A BUILDING FIRST' };
  const current = draft.positions.find((position) => position.buildingId === draft.selectedId);
  if (!current) return { draft, error: 'PLACE THIS BUILDING FROM THE TRAY FIRST' };
  return moveBuilding(draft, geometry, current.buildingId, current.tx + dx, current.ty + dy);
}

export function moveToTray(
  draft: LayoutDraft,
  buildings: readonly LayoutBuilding[],
  buildingId: string,
): DraftResult {
  const building = buildings.find((row) => row.id === buildingId);
  if (!building) return { draft, error: 'BUILDING NO LONGER EXISTS' };
  if (draft.trayIds.includes(buildingId)) return { draft, error: null };
  return {
    draft: commit(draft, {
      positions: draft.positions.filter((position) => position.buildingId !== buildingId),
      trayIds: [...draft.trayIds, buildingId],
      selectedId: buildingId,
    }),
    error: null,
  };
}

export function pickUpAll(draft: LayoutDraft, buildings: readonly LayoutBuilding[]): LayoutDraft {
  return commit(draft, {
    positions: [],
    trayIds: buildings.map((building) => building.id),
    selectedId: null,
  });
}

/** Paint consumes existing trayed wall identities in stable tray order. It
 * never creates a wall or changes its level/trap/job state. Invalid tiles are
 * skipped, matching the ordinary wall stroke without hiding a partial result. */
export function paintWalls(
  draft: LayoutDraft,
  geometry: LayoutGeometry,
  level: number,
  tiles: readonly { tx: number; ty: number }[],
): DraftResult {
  const buildingById = new Map(geometry.buildings.map((building) => [building.id, building]));
  const walls = draft.trayIds.filter((id) => {
    const building = buildingById.get(id);
    return building?.type === 'wall' && building.level === level;
  });
  if (walls.length === 0) return { draft, error: `PUT LEVEL ${level} WALLS IN THE TRAY BEFORE PAINTING` };
  let positions = canonical(draft.positions);
  const placed: string[] = [];
  const seenTiles = new Set<string>();
  for (const tile of tiles) {
    const id = walls[placed.length];
    if (!id) break;
    const key = `${tile.tx},${tile.ty}`;
    if (seenTiles.has(key)) continue;
    seenTiles.add(key);
    if (validatePlacement(geometry, positions, id, tile.tx, tile.ty)) continue;
    positions = [...positions, { buildingId: id, tx: tile.tx, ty: tile.ty }];
    placed.push(id);
  }
  if (placed.length === 0) return { draft, error: 'NO FREE WALL TILES IN THAT STROKE' };
  return {
    draft: commit(draft, {
      positions,
      trayIds: draft.trayIds.filter((id) => !placed.includes(id)),
      selectedId: placed.at(-1) ?? null,
    }),
    error: null,
  };
}

export function replaceDraftPositions(
  draft: LayoutDraft,
  positions: readonly LayoutPosition[],
): LayoutDraft {
  return commit(draft, { positions: canonical(positions), trayIds: [], selectedId: null });
}

export function undoDraft(draft: LayoutDraft): LayoutDraft {
  const prior = draft.history.at(-1);
  if (!prior) return draft;
  return {
    ...prior,
    history: draft.history.slice(0, -1),
    dirty: true,
  };
}

interface LegacyPreset { t?: unknown; b?: unknown }
interface LegacyPresetMap { A?: LegacyPreset; B?: LegacyPreset; C?: LegacyPreset }

export function legacyImportMarker(baseId: string, slot: LayoutSlot): string {
  return `skp_layouts_imported_v${LEGACY_IMPORT_VERSION}:${baseId}:${slot}`;
}

/** Exact-ID one-release import. A partial/foreign preset is ignored rather than
 * matched by type or order, because building identity is the layout contract. */
export function readLegacyLayout(
  storage: Pick<Storage, 'getItem'>,
  baseId: string,
  slot: LayoutSlot,
  buildings: readonly LayoutBuilding[],
): LayoutPosition[] | null {
  if (storage.getItem(legacyImportMarker(baseId, slot)) === '1') return null;
  let rawPreset: unknown;
  try {
    rawPreset = JSON.parse(storage.getItem(LEGACY_LAYOUT_STORAGE_KEY) ?? '{}') as unknown;
  } catch {
    return null;
  }
  if (!rawPreset || typeof rawPreset !== 'object' || Array.isArray(rawPreset)) return null;
  const parsed = rawPreset as LegacyPresetMap;
  const value = slot === 'HOME' ? parsed.A?.b : parsed.B?.b;
  if (!Array.isArray(value) || value.length !== buildings.length) return null;
  const currentIds = new Set(buildings.map((building) => building.id));
  const seen = new Set<string>();
  const positions: LayoutPosition[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as { id?: unknown; tx?: unknown; ty?: unknown };
    if (typeof row.id !== 'string' || !currentIds.has(row.id) || seen.has(row.id)
      || !Number.isInteger(row.tx) || !Number.isInteger(row.ty)) return null;
    seen.add(row.id);
    positions.push({ buildingId: row.id, tx: row.tx as number, ty: row.ty as number });
  }
  return seen.size === currentIds.size ? canonical(positions) : null;
}

export function markLegacyImported(
  storage: Pick<Storage, 'setItem'>,
  baseId: string,
  slot: LayoutSlot,
): void {
  storage.setItem(legacyImportMarker(baseId, slot), '1');
}

/**
 * THE ONE place a layout slot becomes on-screen copy (D-099, owner 2026-09-02:
 * "remove wording FARM … we have BASE"). The wire id stays 'FARM' — D-087 made
 * the API path, the zod enum, the DTO slot and the ledger reason contracts —
 * so only what a player READS changes; every tab, notice, toast and error
 * string routes through here, and model.test.ts pins that no label says FARM.
 * The editor's header says LAYOUTS (not "BASE LAYOUT") so that "BASE" names
 * exactly one thing on that screen.
 */
export const LAYOUT_SLOT_LABELS: Readonly<Record<LayoutSlot, string>> = {
  HOME: 'HOME',
  FARM: 'BASE',
};

export function slotLabel(slot: LayoutSlot): string {
  return LAYOUT_SLOT_LABELS[slot];
}
