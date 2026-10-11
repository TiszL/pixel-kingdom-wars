/**
 * stats.ts — resolve per-entity combat numbers from @shardkeep/shared constants.
 *
 * Damage bookkeeping is in DECI-HP (1 HP = 10 deci) so a per-tick DPS tick
 * (dps / 10 per 100ms) stays integral: a troop with 18 dps deals exactly
 * 18 deci per tick. All level scaling multiplies floats from constants then
 * rounds ONCE — multiplication and Math.round are IEEE-exact and deterministic
 * across engines.
 */
import {
  BuildingType,
  BUILDING_GEOMETRY,
  DEFENSES,
  DEFENSE_PROJECTILE_TIMINGS,
  HERO_COMBAT,
  KEEP_BATTERIES,
  LEVEL_STEP_BUILDING,
  LEVEL_STEP_TROOP,
  RAID_RULES,
  resolveBuildingGeometryVersion,
  STRUCTURES,
  TROOPS,
  artTierOfLevel,
  type TrapType,
  type TroopType,
} from '@shardkeep/shared';

/** Sim tick rate: 100ms ticks (a sim discretization detail, not a game tunable). */
export const TICKS_PER_SEC = 10;
/** Battle + deploy durations are GAME numbers (shared), realized in ticks here. */
export const MAX_TICKS = RAID_RULES.battleDurationSec * TICKS_PER_SEC; // 90s → 900
export const DEPLOY_WINDOW_TICKS = RAID_RULES.deployWindowSec * TICKS_PER_SEC; // 60s → 600

/** Scale a base stat to `level` by multiplying the per-level STEP array (STEP[i] =
 *  the multiplier that reaches level i+1; STEP[0..1]=1). Repeated multiply (the
 *  power builtin is banned here), round ONCE — IEEE-exact + deterministic. Building
 *  L≤5 / troop L≤3 steps are the literal 1.25/1.20 the sim shipped, so golden
 *  replays are byte-identical (owner 2026-07-20, L1-20 expansion). */
function levelScale(base: number, steps: readonly number[], level: number): number {
  let v = base;
  for (let i = 1; i < level; i++) v *= steps[i] ?? 1;
  return Math.round(v);
}

export interface FootprintInfo {
  fw: number;
  fh: number;
}

export function footprintOf(type: BuildingType, geometryVersion?: number): FootprintInfo {
  const resolvedVersion = resolveBuildingGeometryVersion(geometryVersion);
  const defense = (DEFENSES as Record<string, { footprint?: readonly [number, number] }>)[type];
  const structure = (STRUCTURES as Record<string, { footprint?: readonly [number, number] }>)[type];
  const footprint = type === BuildingType.Keep
    ? BUILDING_GEOMETRY.keepFootprintByVersion[resolvedVersion]
    : defense?.footprint ?? structure?.footprint;
  if (!footprint) throw new RangeError(`building footprint unavailable: ${type}`);
  return { fw: footprint[0], fh: footprint[1] };
}

/** Max HP (whole points) for a building at a level/tier. Traps have no HP (untargetable). */
export function buildingMaxHp(type: BuildingType, level: number): number {
  switch (type) {
    case BuildingType.Wall: {
      const hp = STRUCTURES.wall.hpByTier[level - 1];
      if (hp === undefined) throw new RangeError(`wall tier out of range: ${level}`);
      return hp;
    }
    case BuildingType.SpikeTrap:
    case BuildingType.PowderMine:
    case BuildingType.Pitfall:
    case BuildingType.AirMine:
      return 0;
    case BuildingType.Cannon:
      return levelScale(DEFENSES.cannon.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.ArcherTower:
      return levelScale(DEFENSES.archertower.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Mortar:
      return levelScale(DEFENSES.mortar.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.AirDefence:
      return levelScale(DEFENSES.airdefence.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Keep:
      return levelScale(STRUCTURES.keep.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Vault:
      return levelScale(STRUCTURES.vault.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Mine:
      return levelScale(STRUCTURES.mine.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Barracks:
      return levelScale(STRUCTURES.barracks.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Forge:
      return levelScale(STRUCTURES.forge.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Camp:
      return levelScale(STRUCTURES.camp.hp, LEVEL_STEP_BUILDING, level);
    // Pixel Kingdom Wars epic defenses (HP scales like every other defense).
    case BuildingType.ElectricTower:
      return levelScale(DEFENSES.electrictower.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.MageTower:
      return levelScale(DEFENSES.magetower.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.LaserTower:
      return levelScale(DEFENSES.lasertower.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.DragonNest:
      return levelScale(DEFENSES.dragonnest.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.GoldForge:
      return levelScale(STRUCTURES.goldforge.hp, LEVEL_STEP_BUILDING, level);
    // Hero altars (HEROES MVP): plain destructibles in a raid — the HERO
    // fighting is a separate phase (OVERNIGHT-INTEGRATION-PLAN D4); tonight the
    // altar is just a building with hp, exactly like a camp or barracks.
    case BuildingType.HeroAltar:
      return levelScale(STRUCTURES.heroaltar.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.SiegeStool:
      return levelScale(STRUCTURES.siegestool.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.ClanHall:
      return levelScale(STRUCTURES.clanhall.hp, LEVEL_STEP_BUILDING, level);
    // Phase E service buildings + berth (D-152 §5 commit A, DARK): passive
    // destructibles exactly like a camp — hp only, never targeted by type. No
    // snapshot can carry them until PHASE_E_BUILDINGS_ENABLED (commit B, SIM 18),
    // so these cases change no replay (E2-WORKSHOP-CONTRACT §1/§7).
    case BuildingType.Workshop:
      return levelScale(STRUCTURES.workshop.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Lodge:
      return levelScale(STRUCTURES.lodge.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Market:
      return levelScale(STRUCTURES.market.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Harvester:
      return levelScale(STRUCTURES.harvester.hp, LEVEL_STEP_BUILDING, level);
    case BuildingType.Berth:
      return levelScale(STRUCTURES.berth.hp, LEVEL_STEP_BUILDING, level);
  }
}

export interface TroopCombat {
  hp: number;            // whole points
  dpsDeci: number;       // deci-damage per tick at troop level, before buffs
  unitsPerTick: number;  // base movement, before buffs
  rangeUnits: number;    // attack reach from troop point to building rect edge
  pts: number;
}

/** Melee reach: just over half a tile so an adjacent-tile target is in reach. */
const MELEE_REACH_UNITS = 160;

export function troopCombat(type: TroopType, level: number): TroopCombat {
  const s = TROOPS[type];
  const hp = levelScale(s.hp, LEVEL_STEP_TROOP, level);
  const dpsScaled = levelScale(s.dps, LEVEL_STEP_TROOP, level);
  return {
    hp,
    dpsDeci: dpsScaled, // dps points/sec == deci-points per 100ms tick
    unitsPerTick: Math.floor((s.speedTilesPerSec * 256) / TICKS_PER_SEC),
    rangeUnits: s.range === 'melee' ? MELEE_REACH_UNITS : Math.floor(s.range * 256),
    pts: s.pts,
  };
}

/**
 * Attack reach vs a SPECIFIC target kind (rework v2, owner 2026-08-08). A unit
 * with `siegeThrow` (the giant) gets floor(rangeTiles×256) — 640 units — ONLY
 * when its current target is a defense: he lobs boulders at the guns hunting
 * him. Everything else (walls, the last-resort chew, non-defense buildings)
 * stays at the unit's own `rangeUnits` (melee for the giant). The caller MUST
 * resolve `siegeThrow` through behaviorOf, never off TROOPS[tr.type]: a hero
 * on a giant donor (Theodor) declares no siegeThrow and must not inherit the
 * throw — the exact donor-role leak class documented at behaviorOf in sim.ts.
 */
export function reachFor(
  rangeUnits: number,
  siegeThrow: { rangeTiles: number } | undefined,
  targetIsDefense: boolean,
): number {
  return siegeThrow !== undefined && targetIsDefense
    ? Math.floor(siegeThrow.rangeTiles * 256)
    : rangeUnits;
}

/**
 * A hero's OWN movement/reach, resolved exactly like a troop's (same integer
 * expressions as `troopCombat`, so no new math enters the sim). Heroes borrow
 * a donor troop's SPRITE only: reading `troopCombat(donor)` for these once gave
 * Vex the highlander's 1.2 tiles/s (2026-07-29 bug report). Hero hp/dps come
 * from HERO_LEVELING, so this deliberately returns movement/reach alone.
 */
export function heroCombat(hero: 'vex' | 'theodor'): Pick<TroopCombat, 'unitsPerTick' | 'rangeUnits'> {
  const h = HERO_COMBAT[hero];
  return {
    unitsPerTick: Math.floor((h.speedTilesPerSec * 256) / TICKS_PER_SEC),
    rangeUnits: h.range === 'melee' ? MELEE_REACH_UNITS : Math.floor(h.range * 256),
  };
}

export interface DefenseCombat {
  shotDeci: number;       // deci-damage per shot at level
  intervalTicks: number;
  rangeUnits: number;
  minRangeUnits: number;  // mortar dead zone; 0 otherwise
  splashUnits: number;    // mortar / mage-tower AoE radius; 0 otherwise
  projTicks: number;      // flight time
  proj: 'cannonball' | 'arrow' | 'shell' | 'beam';
  /** Can hit FLYING attackers (Dragon troop). Only archer/mage/electric towers. */
  targetsAir: boolean;
  /** Air Defence is intentionally inert against ground; all older towers are true. */
  targetsGround: boolean;
  /** Keep L17+ point battery; selected only inside its range. */
  lowRange?: DefenseCombat;
  /** Electric tower: number of secondary chain hops after the primary hit. */
  chainMax?: number;
  /** Electric tower: per-hop damage as a % of the primary (e.g. [50, 25]). */
  chainFalloffPct?: readonly number[];
}

/**
 * Per-shot damage = dps × fireInterval at level. Addendum B2 numbers are read
 * uniformly as DPS (chain-of-authority choice documented in shared constants);
 * alpha tuning adjusts constants, never this code.
 */
export function defenseCombat(type: BuildingType, level: number): DefenseCombat | null {
  const steps = LEVEL_STEP_BUILDING;
  switch (type) {
    case BuildingType.Cannon: {
      const d = DEFENSES.cannon;
      return {
        shotDeci: levelScale(d.dps * d.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(d.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: d.rangeTiles * 256,
        minRangeUnits: 0,
        splashUnits: 0,
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.cannon.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.cannon.flightMs) / 100),
        proj: 'cannonball', targetsAir: d.targetsAir, targetsGround: true,
      };
    }
    case BuildingType.ArcherTower: {
      const d = DEFENSES.archertower;
      return {
        shotDeci: levelScale(d.dps * d.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(d.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: d.rangeTiles * 256,
        minRangeUnits: 0,
        splashUnits: 0,
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.archertower.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.archertower.flightMs) / 100),
        proj: 'arrow', targetsAir: d.targetsAir, targetsGround: true,
      };
    }
    case BuildingType.Mortar: {
      const d = DEFENSES.mortar;
      return {
        shotDeci: levelScale(d.dps * d.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(d.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: d.rangeMaxTiles * 256,
        minRangeUnits: d.rangeMinTiles * 256,
        splashUnits: Math.floor(d.splashRadiusTiles * 256),
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.mortar.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.mortar.flightMs) / 100),
        proj: 'shell', targetsAir: d.targetsAir, targetsGround: true,
      };
    }
    case BuildingType.AirDefence: {
      const d = DEFENSES.airdefence;
      return {
        shotDeci: levelScale(d.dps * d.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(d.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: d.rangeTiles * 256, minRangeUnits: 0, splashUnits: 0,
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.airdefence.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.airdefence.flightMs) / 100),
        proj: 'arrow', targetsAir: true, targetsGround: false,
      };
    }
    case BuildingType.Keep: {
      if (level < KEEP_BATTERIES.highRangeUnlockLevel) return null;
      const high = DEFENSES.mortar;
      const result: DefenseCombat = {
        shotDeci: levelScale(high.dps * high.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(high.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: high.rangeMaxTiles * 256,
        minRangeUnits: high.rangeMinTiles * 256,
        splashUnits: Math.floor(high.splashRadiusTiles * 256),
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.mortar.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.mortar.flightMs) / 100),
        proj: 'shell', targetsAir: false, targetsGround: true,
      };
      if (level >= KEEP_BATTERIES.lowRangeUnlockLevel) {
        const low = DEFENSES.cannon;
        result.lowRange = {
          shotDeci: levelScale(low.dps * low.fireIntervalSec * 10, steps, level),
          intervalTicks: Math.round(low.fireIntervalSec * TICKS_PER_SEC),
          // NOT low.rangeTiles: the D-060 cannon doubling is a Cannon-building
          // buff; the Keep's point battery keeps its own pinned dead-zone reach.
          rangeUnits: KEEP_BATTERIES.lowRangeTiles * 256, minRangeUnits: 0, splashUnits: 0,
          projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.cannon.releaseOffsetMs
            + DEFENSE_PROJECTILE_TIMINGS.cannon.flightMs) / 100),
          proj: 'cannonball', targetsAir: false, targetsGround: true,
        };
      }
      return result;
    }
    // Pixel Kingdom Wars epic towers (Phase 2b live mechanics; DARK until
    // NEW_ROSTER_ENABLED). The Dragon Nest is a spawner (no direct fire → default
    // null, like a Vault) until DRAGON_NEST_ENABLED + its spawn loop land.
    case BuildingType.ElectricTower: {
      // Chain lightning: primary bolt + `chainMax` secondary hops decaying by
      // chainFalloffPct (applied at impact in sim.ts). Primary is single-target.
      const d = DEFENSES.electrictower;
      return {
        shotDeci: levelScale(d.dps * d.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(d.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: d.rangeTiles * 256,
        minRangeUnits: 0, splashUnits: 0,
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.electrictower.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.electrictower.flightMs) / 100),
        proj: 'arrow', targetsAir: d.targetsAir, targetsGround: true,
        chainMax: d.chainMax, chainFalloffPct: d.chainFalloffPct,
      };
    }
    case BuildingType.MageTower: {
      // Arcane blast: AoE splash on troops (reuses the mortar splash path).
      const d = DEFENSES.magetower;
      return {
        shotDeci: levelScale(d.dps * d.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(d.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: d.rangeTiles * 256,
        minRangeUnits: 0, splashUnits: Math.floor(d.splashRadiusTiles * 256),
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.magetower.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.magetower.flightMs) / 100),
        proj: 'arrow', targetsAir: d.targetsAir, targetsGround: true,
      };
    }
    case BuildingType.LaserTower: {
      // Focus beam: near-instant single-target (visual 'beam' kind, projTicks 1).
      const d = DEFENSES.lasertower;
      return {
        shotDeci: levelScale(d.dps * d.fireIntervalSec * 10, steps, level),
        intervalTicks: Math.round(d.fireIntervalSec * TICKS_PER_SEC),
        rangeUnits: d.rangeTiles * 256,
        minRangeUnits: 0, splashUnits: 0,
        projTicks: Math.ceil((DEFENSE_PROJECTILE_TIMINGS.lasertower.releaseOffsetMs
          + DEFENSE_PROJECTILE_TIMINGS.lasertower.flightMs) / 100),
        proj: 'beam', targetsAir: d.targetsAir, targetsGround: true,
      };
    }
    default:
      return null;
  }
}

export interface TrapCombat {
  damageDeci: number;
  splashUnits: number;
  stunTicks: number;
  targetsAir: boolean;
}

export function trapCombat(type: TrapType, level: number): TrapCombat {
  const tier = artTierOfLevel(level) - 1;
  switch (type) {
    case 'spiketrap': return { damageDeci: DEFENSES.spiketrap.burstDamageByTier[tier]! * 10,
      splashUnits: 0, stunTicks: 0, targetsAir: false };
    case 'powdermine': return { damageDeci: DEFENSES.powdermine.burstDamageByTier[tier]! * 10,
      splashUnits: Math.floor(DEFENSES.powdermine.splashRadiusTilesByTier[tier]! * 256), stunTicks: 0, targetsAir: false };
    case 'pitfall': return { damageDeci: DEFENSES.pitfall.burstDamageByTier[tier]! * 10,
      splashUnits: 0, stunTicks: DEFENSES.pitfall.stunTicksByTier[tier]!, targetsAir: false };
    case 'airmine': return { damageDeci: DEFENSES.airmine.burstDamageByTier[tier]! * 10,
      splashUnits: Math.floor(DEFENSES.airmine.splashRadiusTilesByTier[tier]! * 256), stunTicks: 0, targetsAir: true };
  }
}

/** Pre-SIM10 compatibility name used by exact hero mitigation tests (T1 spike). */
export const TRAP_BURST_DECI = DEFENSES.spiketrap.burstDamageByTier[0] * 10;
/**
 * Keg cross-blast damage to WALLS, scaled by the DETONATING UNIT's level (master
 * plan P2, so a researched keg opens tougher walls).
 *
 * The keg ROLE became data on 2026-07-29 (`selfDestructs` via behaviorOf) but the
 * MAGNITUDE did not: this function read `TROOPS.kegrunner.wallBurst` unconditionally
 * and the caller scaled it by `tr.level` — which for a hero is the HERO level. A
 * hero declaring `selfDestructs` therefore inherited a keg runner's 900 wall burst
 * on a hero's level curve, exactly the donor-role leak the guard test exists to
 * prevent. `wallBurst` is now passed IN by the caller off `behaviorOf(tr)`, so a
 * unit bursts for what its OWN behaviour data says (0 when it declares nothing).
 * A keg runner still passes TROOPS.kegrunner.wallBurst, and levelScale(v, steps, 1)
 * === v, so golden fixtures are byte-identical.
 */
export function kegWallBurstDeci(wallBurst: number, level: number): number {
  return levelScale(wallBurst, LEVEL_STEP_TROOP, level) * 10;
}
/**
 * Keg blast splash to non-walls = ONE SECOND of the detonating unit's OWN dps.
 * For a keg runner `tr.dpsDeci` is exactly `levelScale(TROOPS.kegrunner.dps, …,
 * level)`, so this is arithmetically the same number the TROOPS-keyed version
 * produced at every level — but it now reads the ACTING unit, so a hero detonates
 * for a hero's dps rather than a keg runner's.
 */
export function kegSplashDeci(dpsDeci: number): number {
  return dpsDeci * TICKS_PER_SEC;
}
