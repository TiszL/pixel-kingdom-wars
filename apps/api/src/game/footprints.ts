/**
 * Building footprints + claim geometry, derived from @shardkeep/shared
 * (never hardcoded here). Coordinates are plot-relative tiles [0, 30); the
 * buildable claim is CENTERED in the plot with an empty deploy ring on every
 * side (Clash-of-Clans layout, owner 2026-07-20): a fresh 14-claim is [8,22)
 * and expansions grow it symmetrically outward to [2,28)
 * (CAPS.claimTilesByExpansion). Existing bases are re-centered by migration
 * 0018 (per-player shift (6 − expansions)); the client reads these bounds off
 * the raid snapshot and never recomputes them.
 */
import {
  BUILDING_GEOMETRY, CAPS, DEFENSES, GRID, STRUCTURES, BuildingType,
  resolveBuildingGeometryVersion,
} from '@shardkeep/shared';

export function footprintOf(type: BuildingType, geometryVersion?: number): { fw: number; fh: number } {
  const resolvedVersion = resolveBuildingGeometryVersion(geometryVersion);
  switch (type) {
    case BuildingType.Keep: return tuple(BUILDING_GEOMETRY.keepFootprintByVersion[resolvedVersion]);
    case BuildingType.Vault: return tuple(STRUCTURES.vault.footprint);
    case BuildingType.Mine: return tuple(STRUCTURES.mine.footprint);
    case BuildingType.Barracks: return tuple(STRUCTURES.barracks.footprint);
    case BuildingType.Forge: return tuple(STRUCTURES.forge.footprint);
    case BuildingType.Camp: return tuple(STRUCTURES.camp.footprint);
    case BuildingType.HeroAltar: return tuple(STRUCTURES.heroaltar.footprint);
    case BuildingType.SiegeStool: return tuple(STRUCTURES.siegestool.footprint);
    case BuildingType.Wall: return tuple(STRUCTURES.wall.footprint);
    case BuildingType.Cannon: return tuple(DEFENSES.cannon.footprint);
    case BuildingType.ArcherTower: return tuple(DEFENSES.archertower.footprint);
    case BuildingType.Mortar: return tuple(DEFENSES.mortar.footprint);
    case BuildingType.AirDefence: return tuple(DEFENSES.airdefence.footprint);
    case BuildingType.SpikeTrap: return tuple(DEFENSES.spiketrap.footprint);
    case BuildingType.PowderMine: return tuple(DEFENSES.powdermine.footprint);
    case BuildingType.Pitfall: return tuple(DEFENSES.pitfall.footprint);
    case BuildingType.AirMine: return tuple(DEFENSES.airmine.footprint);
    // Pixel Kingdom Wars epic defenses (DARK): the 3 towers are 1×1, the Dragon
    // Nest 2×2 (footprints carried in DEFENSES for a single source of truth).
    case BuildingType.ElectricTower: return tuple(DEFENSES.electrictower.footprint);
    case BuildingType.MageTower: return tuple(DEFENSES.magetower.footprint);
    case BuildingType.LaserTower: return tuple(DEFENSES.lasertower.footprint);
    case BuildingType.DragonNest: return tuple(DEFENSES.dragonnest.footprint);
    case BuildingType.GoldForge: return tuple(STRUCTURES.goldforge.footprint);
    case BuildingType.ClanHall: return tuple(STRUCTURES.clanhall.footprint);
    // Phase E service buildings + berth (D-152 §5 commit A, DARK): 2×2 each,
    // carried in STRUCTURES; placement stays refused until commit B.
    case BuildingType.Workshop: return tuple(STRUCTURES.workshop.footprint);
    case BuildingType.Lodge: return tuple(STRUCTURES.lodge.footprint);
    case BuildingType.Market: return tuple(STRUCTURES.market.footprint);
    case BuildingType.Harvester: return tuple(STRUCTURES.harvester.footprint);
    case BuildingType.Berth: return tuple(STRUCTURES.berth.footprint);
  }
}

function tuple(fp: readonly [number, number]): { fw: number; fh: number } {
  return { fw: fp[0], fh: fp[1] };
}

/** Claim rect [min, max) for a player's expansion count (0–2). */
export function claimRect(expansions: number): { min: number; max: number } {
  const tiles = CAPS.claimTilesByExpansion[expansions];
  if (tiles === undefined) throw new RangeError(`expansions out of range: ${expansions}`);
  // CENTERED in the plot (owner 2026-07-20 CoC layout): the base sits in the middle
  // with an empty deploy ring all around it. A fresh 14-claim is [8,22); expansions
  // grow it symmetrically to [2,28). Every claimTilesByExpansion value is even and
  // plotTiles is 30, so min stays integral (8/7/6/5/4/3/2). Existing bases were
  // re-centered by migration 0018 (per-player shift (6 − expansions)).
  const min = (GRID.plotTiles - tiles) / 2;
  return { min, max: min + tiles };
}

export interface Rect { tx: number; ty: number; fw: number; fh: number }

export function overlaps(a: Rect, b: Rect): boolean {
  return a.tx < b.tx + b.fw && b.tx < a.tx + a.fw && a.ty < b.ty + b.fh && b.ty < a.ty + a.fh;
}

export function insideClaim(r: Rect, expansions: number): boolean {
  const { min, max } = claimRect(expansions);
  return r.tx >= min && r.ty >= min && r.tx + r.fw <= max && r.ty + r.fh <= max;
}
