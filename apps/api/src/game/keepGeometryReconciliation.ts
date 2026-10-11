/**
 * Pure planning for the candidate KEEP geometry rollout.
 *
 * This module never reads or writes persistence. It turns one active layout and
 * any saved-layout coordinate sets into deterministic, JSON-hashable reports.
 * Audit mode is the default and only reports collisions. Relocation must be
 * requested explicitly; it moves each blocker to the nearest legal top-left
 * coordinate, ordered by Manhattan distance, then y, then x.
 */
import {
  BUILDING_GEOMETRY,
  BuildingType,
  OBSTACLES,
  type BuildingGeometryVersion,
} from '@shardkeep/shared';
import { footprintOf, overlaps, type Rect } from './footprints';

export type KeepReconciliationMode = 'audit' | 'relocate-conflicts';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue }

export interface KeepReconciliationBuilding {
  readonly id: string;
  readonly type: BuildingType;
  readonly level: number;
  readonly tx: number;
  readonly ty: number;
  readonly jobs?: readonly JsonValue[];
  readonly metadata?: JsonObject;
}

export interface KeepReconciliationObstacle {
  readonly id: string;
  readonly spriteKey: string;
  readonly tx: number;
  readonly ty: number;
  readonly metadata?: JsonObject;
}

export interface SavedLayoutCoordinates {
  readonly slot: string;
  readonly positions: readonly { readonly buildingId: string; readonly tx: number; readonly ty: number }[];
}

export interface KeepGeometryReconciliationInput {
  readonly geometryVersion: number;
  readonly claim: Readonly<{ minTx: number; minTy: number; maxTx: number; maxTy: number }>;
  readonly buildings: readonly KeepReconciliationBuilding[];
  readonly obstacles: readonly KeepReconciliationObstacle[];
  readonly savedLayouts?: readonly SavedLayoutCoordinates[];
  readonly mode?: KeepReconciliationMode;
}

export interface KeepGeometryConflict {
  readonly kind: 'building' | 'obstacle';
  readonly id: string;
  readonly rect: Readonly<Rect>;
  readonly overlap: Readonly<Rect>;
}

export interface KeepGeometryRelocation {
  readonly kind: 'building' | 'obstacle';
  readonly id: string;
  readonly from: Readonly<{ tx: number; ty: number }>;
  readonly to: Readonly<{ tx: number; ty: number }>;
}

export interface KeepLayoutReconciliation {
  readonly name: 'active' | string;
  readonly keep: Readonly<{
    id: string;
    old: Readonly<Rect>;
    proposed: Readonly<Rect>;
  }>;
  readonly buildings: readonly KeepReconciliationBuilding[];
  readonly obstacles: readonly KeepReconciliationObstacle[];
  readonly conflicts: readonly KeepGeometryConflict[];
  readonly relocations: readonly KeepGeometryRelocation[];
  readonly collisionFree: boolean;
}

export interface KeepGeometryReconciliationReport {
  readonly sourceGeometryVersion: BuildingGeometryVersion;
  readonly targetGeometryVersion: BuildingGeometryVersion;
  readonly mode: KeepReconciliationMode;
  readonly claim: Readonly<{ minTx: number; minTy: number; maxTx: number; maxTy: number }>;
  readonly active: KeepLayoutReconciliation;
  readonly savedLayouts: readonly KeepLayoutReconciliation[];
  readonly readyToApply: boolean;
}

interface Entity {
  kind: 'building' | 'obstacle';
  id: string;
  rect: Rect;
}

const targetVersion = BUILDING_GEOMETRY.candidateVersion;

/** Build an immutable proposal; callers must separately authorize and execute any persistence change. */
export function planKeepGeometryReconciliation(
  input: KeepGeometryReconciliationInput,
): KeepGeometryReconciliationReport {
  const sourceVersion = resolveExactVersion(input.geometryVersion);
  validateClaim(input.claim);
  const mode = input.mode ?? 'audit';
  if (mode !== 'audit' && mode !== 'relocate-conflicts') {
    throw new RangeError(`unsupported KEEP reconciliation mode: ${String(mode)}`);
  }

  const inventory = normalizeInventory(input.buildings);
  const obstacles = normalizeObstacles(input.obstacles);
  const active = planLayout('active', inventory, obstacles, input.claim, sourceVersion, mode);

  const seenSlots = new Set<string>();
  const savedLayouts = [...(input.savedLayouts ?? [])]
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map((layout) => {
      if (seenSlots.has(layout.slot)) throw new Error(`duplicate saved-layout slot: ${layout.slot}`);
      seenSlots.add(layout.slot);
      const positioned = applySavedCoordinates(inventory, layout);
      return planLayout(layout.slot, positioned, obstacles, input.claim, sourceVersion, mode);
    });

  return deepFreeze({
    sourceGeometryVersion: sourceVersion,
    targetGeometryVersion: targetVersion,
    mode,
    claim: { ...input.claim },
    active,
    savedLayouts,
    readyToApply: active.collisionFree && savedLayouts.every((layout) => layout.collisionFree),
  });
}

function planLayout(
  name: string,
  buildings: readonly KeepReconciliationBuilding[],
  obstacles: readonly KeepReconciliationObstacle[],
  claim: KeepGeometryReconciliationInput['claim'],
  sourceVersion: BuildingGeometryVersion,
  mode: KeepReconciliationMode,
): KeepLayoutReconciliation {
  const keep = onlyKeep(buildings);
  const sourceKeepFootprint = footprintOf(BuildingType.Keep, sourceVersion);
  const targetKeepFootprint = footprintOf(BuildingType.Keep, targetVersion);
  const shiftX = exactCentreShift(sourceKeepFootprint.fw, targetKeepFootprint.fw);
  const shiftY = exactCentreShift(sourceKeepFootprint.fh, targetKeepFootprint.fh);
  const oldKeep = { tx: keep.tx, ty: keep.ty, ...sourceKeepFootprint };
  const proposedKeep = sourceVersion === targetVersion
    ? { tx: keep.tx, ty: keep.ty, ...targetKeepFootprint }
    : { tx: keep.tx - shiftX, ty: keep.ty - shiftY, ...targetKeepFootprint };

  const sourceEntities = entitiesOf(buildings, obstacles, sourceVersion);
  assertSourceGeometry(sourceEntities, claim);
  if (!inside(proposedKeep, claim)) throw new RangeError(`${name} proposed KEEP is outside claim bounds`);

  const blockers = sourceEntities
    .filter((entity) => entity.id !== keep.id || entity.kind !== 'building')
    .filter((entity) => overlaps(entity.rect, proposedKeep))
    .sort(compareEntity);
  const conflicts = blockers.map((entity) => ({
    kind: entity.kind,
    id: entity.id,
    rect: { ...entity.rect },
    overlap: intersection(entity.rect, proposedKeep),
  }));

  const positions = new Map(sourceEntities.map((entity) => [entityKey(entity), { ...entity.rect }]));
  positions.set(entityKey({ kind: 'building', id: keep.id }), proposedKeep);
  const relocations: KeepGeometryRelocation[] = [];
  if (mode === 'relocate-conflicts') {
    for (const blocker of blockers) {
      const occupied = [...positions.entries()]
        .filter(([key]) => key !== entityKey(blocker))
        .map(([, rect]) => rect);
      const to = nearestLegal(blocker.rect, claim, occupied);
      if (!to) throw new Error(`${name} has no legal relocation slot for ${blocker.kind} ${blocker.id}`);
      positions.set(entityKey(blocker), to);
      relocations.push({
        kind: blocker.kind,
        id: blocker.id,
        from: { tx: blocker.rect.tx, ty: blocker.rect.ty },
        to: { tx: to.tx, ty: to.ty },
      });
    }
  }

  const proposedBuildings = buildings.map((building) => {
    const rect = positions.get(`building:${building.id}`)!;
    return normalizeBuilding({ ...building, tx: rect.tx, ty: rect.ty });
  }).sort(compareId);
  const proposedObstacles = obstacles.map((obstacle) => {
    const rect = positions.get(`obstacle:${obstacle.id}`)!;
    return normalizeObstacle({ ...obstacle, tx: rect.tx, ty: rect.ty });
  }).sort(compareId);
  const collisionFree = allCollisionFree([...positions.values()]);
  if (mode === 'relocate-conflicts' && !collisionFree) {
    throw new Error(`${name} reconciliation did not produce collision-free target geometry`);
  }

  return deepFreeze({
    name,
    keep: { id: keep.id, old: oldKeep, proposed: proposedKeep },
    buildings: proposedBuildings,
    obstacles: proposedObstacles,
    conflicts,
    relocations,
    collisionFree,
  });
}

function normalizeInventory(buildings: readonly KeepReconciliationBuilding[]): KeepReconciliationBuilding[] {
  const ids = new Set<string>();
  const normalized = buildings.map((building) => {
    if (!building.id || ids.has(building.id)) throw new Error(`duplicate or empty building id: ${building.id}`);
    ids.add(building.id);
    if (!Number.isInteger(building.level)) {
      throw new RangeError(`invalid building level for ${building.id}`);
    }
    return normalizeBuilding(building);
  }).sort(compareId);
  onlyKeep(normalized);
  return normalized;
}

function normalizeObstacles(obstacles: readonly KeepReconciliationObstacle[]): KeepReconciliationObstacle[] {
  const ids = new Set<string>();
  return obstacles.map((obstacle) => {
    if (!obstacle.id || ids.has(obstacle.id)) throw new Error(`duplicate or empty obstacle id: ${obstacle.id}`);
    ids.add(obstacle.id);
    obstacleSize(obstacle.spriteKey);
    return normalizeObstacle(obstacle);
  }).sort(compareId);
}

function normalizeBuilding(building: KeepReconciliationBuilding): KeepReconciliationBuilding {
  assertCoordinate(building.tx, building.ty, `building ${building.id}`);
  return {
    id: building.id,
    type: building.type,
    level: building.level,
    tx: building.tx,
    ty: building.ty,
    jobs: canonicalJsonArray(building.jobs ?? []),
    metadata: canonicalJsonObject(building.metadata ?? {}),
  };
}

function normalizeObstacle(obstacle: KeepReconciliationObstacle): KeepReconciliationObstacle {
  assertCoordinate(obstacle.tx, obstacle.ty, `obstacle ${obstacle.id}`);
  return {
    id: obstacle.id,
    spriteKey: obstacle.spriteKey,
    tx: obstacle.tx,
    ty: obstacle.ty,
    metadata: canonicalJsonObject(obstacle.metadata ?? {}),
  };
}

function applySavedCoordinates(
  inventory: readonly KeepReconciliationBuilding[],
  layout: SavedLayoutCoordinates,
): KeepReconciliationBuilding[] {
  const expected = new Set(inventory.map((building) => building.id));
  const positions = new Map<string, { tx: number; ty: number }>();
  for (const position of layout.positions) {
    if (!expected.has(position.buildingId) || positions.has(position.buildingId)) {
      throw new Error(`saved-layout ${layout.slot} diverges at building ${position.buildingId}`);
    }
    assertCoordinate(position.tx, position.ty, `saved-layout ${layout.slot} building ${position.buildingId}`);
    positions.set(position.buildingId, { tx: position.tx, ty: position.ty });
  }
  const missing = [...expected].filter((id) => !positions.has(id)).sort();
  if (missing.length > 0) throw new Error(`saved-layout ${layout.slot} is missing buildings: ${missing.join(',')}`);
  return inventory.map((building) => ({ ...building, ...positions.get(building.id)! }));
}

function entitiesOf(
  buildings: readonly KeepReconciliationBuilding[],
  obstacles: readonly KeepReconciliationObstacle[],
  geometryVersion: BuildingGeometryVersion,
): Entity[] {
  return [
    ...buildings.map((building) => ({
      kind: 'building' as const,
      id: building.id,
      rect: { tx: building.tx, ty: building.ty, ...footprintOf(building.type, geometryVersion) },
    })),
    ...obstacles.map((obstacle) => {
      const size = obstacleSize(obstacle.spriteKey);
      return { kind: 'obstacle' as const, id: obstacle.id, rect: { tx: obstacle.tx, ty: obstacle.ty, fw: size, fh: size } };
    }),
  ];
}

function assertSourceGeometry(entities: readonly Entity[], claim: KeepGeometryReconciliationInput['claim']): void {
  for (const entity of entities) {
    if (entity.kind === 'building' && !inside(entity.rect, claim)) {
      throw new RangeError(`building ${entity.id} is outside claim bounds`);
    }
  }
  for (let i = 0; i < entities.length; i += 1) {
    for (let j = i + 1; j < entities.length; j += 1) {
      if (overlaps(entities[i]!.rect, entities[j]!.rect)) {
        throw new Error(`source geometry overlaps: ${entityKey(entities[i]!)} and ${entityKey(entities[j]!)}`);
      }
    }
  }
}

function onlyKeep(buildings: readonly KeepReconciliationBuilding[]): KeepReconciliationBuilding {
  const keeps = buildings.filter((building) => building.type === BuildingType.Keep);
  if (keeps.length !== 1) throw new Error(`expected exactly one KEEP, found ${keeps.length}`);
  return keeps[0]!;
}

function obstacleSize(spriteKey: string): number {
  for (const tier of Object.values(OBSTACLES.tiers)) {
    if ((tier.kinds as readonly string[]).includes(spriteKey)) return tier.sizeTiles;
  }
  throw new Error(`unknown obstacle sprite: ${spriteKey}`);
}

function nearestLegal(
  from: Rect,
  claim: KeepGeometryReconciliationInput['claim'],
  occupied: readonly Rect[],
): Rect | undefined {
  const candidates: Rect[] = [];
  for (let ty = claim.minTy; ty + from.fh <= claim.maxTy; ty += 1) {
    for (let tx = claim.minTx; tx + from.fw <= claim.maxTx; tx += 1) {
      const rect = { tx, ty, fw: from.fw, fh: from.fh };
      if (!occupied.some((other) => overlaps(rect, other))) candidates.push(rect);
    }
  }
  candidates.sort((a, b) => {
    const distanceA = Math.abs(a.tx - from.tx) + Math.abs(a.ty - from.ty);
    const distanceB = Math.abs(b.tx - from.tx) + Math.abs(b.ty - from.ty);
    return distanceA - distanceB || a.ty - b.ty || a.tx - b.tx;
  });
  return candidates[0];
}

function validateClaim(claim: KeepGeometryReconciliationInput['claim']): void {
  assertCoordinate(claim.minTx, claim.minTy, 'claim minimum');
  assertCoordinate(claim.maxTx, claim.maxTy, 'claim maximum');
  if (claim.minTx >= claim.maxTx || claim.minTy >= claim.maxTy) throw new RangeError('invalid claim bounds');
}

function assertCoordinate(tx: number, ty: number, label: string): void {
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) throw new RangeError(`${label} coordinates must be integers`);
}

function inside(rect: Rect, claim: KeepGeometryReconciliationInput['claim']): boolean {
  return rect.tx >= claim.minTx && rect.ty >= claim.minTy
    && rect.tx + rect.fw <= claim.maxTx && rect.ty + rect.fh <= claim.maxTy;
}

function exactCentreShift(from: number, to: number): number {
  const delta = to - from;
  if (delta < 0 || delta % 2 !== 0) throw new Error(`KEEP footprint cannot preserve its centre: ${from} -> ${to}`);
  return delta / 2;
}

function intersection(a: Rect, b: Rect): Rect {
  const tx = Math.max(a.tx, b.tx);
  const ty = Math.max(a.ty, b.ty);
  return { tx, ty, fw: Math.min(a.tx + a.fw, b.tx + b.fw) - tx, fh: Math.min(a.ty + a.fh, b.ty + b.fh) - ty };
}

function allCollisionFree(rects: readonly Rect[]): boolean {
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (overlaps(rects[i]!, rects[j]!)) return false;
    }
  }
  return true;
}

function entityKey(entity: Pick<Entity, 'kind' | 'id'>): string {
  return `${entity.kind}:${entity.id}`;
}

function compareEntity(a: Entity, b: Entity): number {
  return a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
}

function compareId<T extends { id: string }>(a: T, b: T): number {
  return a.id.localeCompare(b.id);
}

function resolveExactVersion(value: number): BuildingGeometryVersion {
  if (value === BUILDING_GEOMETRY.legacyVersion) return BUILDING_GEOMETRY.legacyVersion;
  if (value === BUILDING_GEOMETRY.candidateVersion) return BUILDING_GEOMETRY.candidateVersion;
  throw new RangeError(`unsupported building geometry version: ${value}`);
}

function canonicalJsonArray(value: readonly JsonValue[]): readonly JsonValue[] {
  return value.map(canonicalJson);
}

function canonicalJsonObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key]!)]));
}

function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') return canonicalJsonObject(value as JsonObject);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('metadata must contain finite JSON numbers');
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
