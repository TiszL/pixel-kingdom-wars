/**
 * The scene-side face of the WORLD_DEPTH band contract (packages/shared —
 * read the block there for WHY the bands exist and what each one holds).
 *
 * Every `setDepth` on a world sprite goes through one of these four. They are
 * deliberately the only exports: a caller that cannot say which band its
 * sprite belongs to is a caller that has not decided what it is drawing.
 */
import {
  WORLD_DEPTH, structureDepth, worldDepth, type StructureDepthKind,
} from '@shardkeep/shared';

export { structureDepth };
export type { StructureDepthKind };

/** Buildings, defences, obstacles, scaffolds and anything painted ON a
 *  building (damage overlays, fires, smoke). `groundY` = the footprint's
 *  south edge in world px. */
export function buildingDepth(groundY: number): number {
  return structureDepth('building', groundY);
}

/** Wall segments share the structure painter axis. A wall only overflows a
 * building when its own footprint ends farther south; equal ties favour the
 * building/defence so a northern wall cannot cover its roof. */
export function wallDepth(groundY: number): number {
  return structureDepth('wall', groundY);
}

/** Troops, heroes, villagers, garrisons, builders. `feetY` = the sprite's
 *  ground contact, i.e. its own y for a bottom-anchored actor. */
export function actorDepth(feetY: number): number {
  return worldDepth(WORLD_DEPTH.actor, feetY);
}

/** UI drawn ON the world and never occluded by it: HP bars, damage numbers,
 *  projectiles and their FX, timer chips, the drag ghost, selection rings.
 *  `rank` keeps the pre-band relative order of these among themselves. */
export function overlayDepth(rank: number): number {
  return worldDepth(WORLD_DEPTH.overlay, rank);
}
