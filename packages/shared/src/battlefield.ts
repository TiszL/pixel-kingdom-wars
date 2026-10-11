import { GRID, RAID_BATTLEFIELD } from './constants';
import type { BattlefieldVersion } from './types';

/** Persisted wire values must fail closed; a future rule is never legacy. */
export function resolveBattlefieldVersion(value: number | undefined): BattlefieldVersion {
  if (value === undefined || value === RAID_BATTLEFIELD.legacyVersion) return 1;
  if (value === 2 || value === 3) return value;
  throw new RangeError(`unsupported battlefield version: ${value}`);
}

export function battlefieldBounds(version?: number): { min: number; max: number } {
  const margin = RAID_BATTLEFIELD.marginTilesByVersion[resolveBattlefieldVersion(version)];
  return { min: -margin, max: GRID.plotTiles + margin };
}

export interface BattlefieldContext {
  battlefieldVersion?: number | undefined;
  claimMin?: number | undefined;
  claimMax?: number | undefined;
  deploymentBlockers?: readonly { tx: number; ty: number; fw: number; fh: number }[] | undefined;
}

/** Build once from the frozen snapshot, never from surviving scene objects.
 * Traps/walls and later-destroyed buildings continue to reserve their footprint.
 * Decorations and obstacle records deliberately never enter this collection. */
export function occupiedBattlefieldTiles(
  buildings: readonly { tx: number; ty: number; fw: number; fh: number }[],
): Set<string> {
  const occupied = new Set<string>();
  for (const b of buildings) {
    for (let dy = 0; dy < b.fh; dy++) {
      for (let dx = 0; dx < b.fw; dx++) occupied.add(`${b.tx + dx},${b.ty + dy}`);
    }
  }
  return occupied;
}

/** One legality predicate for API, simulation and both input implementations.
 * The caller supplies immutable occupancy derived with the snapshot's geometry. */
export function isBattlefieldTileDeployable(
  tx: number, ty: number, context: BattlefieldContext, occupied: ReadonlySet<string>,
): boolean {
  const version = resolveBattlefieldVersion(context.battlefieldVersion);
  const { min, max } = battlefieldBounds(version);
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) return false;
  const empty = (x: number, y: number): boolean => {
    if (x < min || x >= max || y < min || y >= max) return false;
    if (version === 1) {
      const claimMin = context.claimMin ?? GRID.deployRingTiles;
      const claimMax = context.claimMax ?? claimMin + GRID.claimTiles;
      if (x > claimMin && x < claimMax - 1 && y > claimMin && y < claimMax - 1) return false;
    } else if (context.deploymentBlockers?.some((b) =>
      x >= b.tx && x < b.tx + b.fw && y >= b.ty && y < b.ty + b.fh)) {
      return false;
    }
    return !occupied.has(`${x},${y}`);
  };
  if (!empty(tx, ty)) return false;
  if (version !== 3) return true;
  const size = RAID_BATTLEFIELD.deploymentSquareTiles;
  // Selected tile can be any corner. No reachability, temporary unit occupancy
  // or scene decoration is involved; every cell uses the frozen snapshot.
  for (let oy = ty - size + 1; oy <= ty; oy++) {
    for (let ox = tx - size + 1; ox <= tx; ox++) {
      let clear = true;
      for (let dy = 0; dy < size && clear; dy++) {
        for (let dx = 0; dx < size; dx++) if (!empty(ox + dx, oy + dy)) { clear = false; break; }
      }
      if (clear) return true;
    }
  }
  return false;
}
