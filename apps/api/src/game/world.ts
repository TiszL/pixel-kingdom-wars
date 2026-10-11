import {readBoundCosmeticBase} from './boundCosmeticPresentation';
import { plotVersionForClaim } from '@shardkeep/shared';
/**
 * World map: valleys, plot assignment, viewport markers, scouting, PvE camps
 * (PLAN.md 4e — GDD §3.4/§3.6).
 *
 * - New players spawn into the NEWEST valley with room; a full valley rolls
 *   over to a fresh one (cohorts grow up together, GDD §3.4).
 * - Plots fill row-major over a 25×20 grid; PvE camps occupy reserved
 *   deterministic coordinates seeded at valley creation.
 * - Markers expose keep level, trophies, shield state and a boolean surplus
 *   tease — NEVER the exact number (GDD §3.4).
 * - PvE camps: parametric tiered layouts (T1 bare keep → T8 maxed "perfect
 *   defence" fortress with every epic defense), KEEP bounty PVE.bountyByTier
 *   from the emission pool, max 3/day, no energy/trophies/shield-break; respawn daily.
 * - Tier 9 "MAXED" (owner 2026-08-03): an everything-at-L20 practice fortress,
 *   spawned ONLY by the ops tool (db/spawnMaxedCamp.ts) — never by the valley
 *   rotation. Campaign stages use a separate generator.
 */
import {
  BUILD_COUNT_CAP_BY_KEEP,
  approximateLootRange,
  vaultExposureBps,
  BuildingType,
  CAMPAIGN,
  CAMPAIGN_LAYOUT,
  CAPS,
  DEFENSES,
  GLOBE,
  GRID,
  HERO_LEVELING,
  LOOT,
  pvpAttackAllowed,
  pvpMinDefenderKeep,
  PVE,
  RAID_RULES,
  RAID_BATTLEFIELD,
  STRUCTURES,
  wallCapForKeepLevel,
  WARZONE,
  WORLD,
  type BaseSnapshot,
} from '@shardkeep/shared';
import { randomInt } from 'node:crypto';
import { resolveBaseVisual } from './baseVisual';
import { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  accounts, baseProfiles, baseRaidLocks, bases, baseSlots, buildings, clanMembers, clans,
  earthCountries, obstacles, players, plots,
  mineAccrualStates, plotReservations, pveCamps, raids, shields, valleys,
} from '../db/schema';
import { claimRect, footprintOf } from './footprints';
import { HttpError } from '../lib/errors';
import {
  getValleySnapshot, invalidateValley, type CampRow, type RosterRow, type ValleySnapshot,
} from '../lib/mapCache';
import { invalidateGlobe } from '../lib/globeCache';
import { NO_SOVEREIGN_A3, globeGeo, type LonLat } from '../lib/globeGeo';
import { getGameConfig } from './gameConfig';
import { progressQuestBatch } from './quests';
import { isWarzoneActive, warzoneStatus } from './warzone';
import { getEffectiveShieldStatus } from './baseShields';
import { sameLandTier } from './land';
import { buildDeedMetadata, type DeedMetadata } from './deedMetadata';
import { utcDay } from './emission';
import { fantasyWorldEnabled, heroGearCombatEnabled, multiBaseEnabled } from '../config';
import { recruitedHeroPlacementsOf } from './heroes';
import { resolveHeroLoadouts } from './items';
import { resolveActiveBase } from './baseOwnership';
import { getBaseMineAccruedForPreview } from './baseMining';
import { resolveFantasyLocation } from './fantasyLocationRead';

// ---------------------------------------------------------------------------
// PvE camp templates — PARAMETRIC tiered layouts (owner 2026-07-24: "npc raid
// bases are too primitive, add challenging bases lowest level to max level
// perfect defence bases"). Each CAMP_TIERS entry is a difficulty band; a
// deterministic placer builds a walled base with the roster + levels for that
// band, ramping from a bare keep (T1) to a maxed all-defenses fortress (T8).
// Layouts are collision-checked by a test (world.test.ts). PVE.bountyByTier
// scales the reward with the tier.
// ---------------------------------------------------------------------------

/** Highest camp tier in NORMAL rotation (campCoords cycle). The campaign uses
 * its own Keep-band generator. NOT the CAMP_TIERS length: tier 9 is ops-only. */
export const MAX_CAMP_TIER = 8;
/** Tier 9 — the MAXED practice camp (owner 2026-08-03): keep/levels/wall all 20,
 *  ALL SEVEN defence types. Spawned only via spawnMaxedCamp (ops tool), so it
 *  never enters the valley rotation. */
export const MAXED_CAMP_TIER = 9;

interface CampTier {
  keep: number;
  /** Level applied to every defense/structure in the base. */
  lvl: number;
  /** Wall tier (0 = no walls) and how many concentric perimeter rings. */
  wallTier: number;
  rings: number;
  /** Defense roster to scatter (2×2 mortar/dragonnest placed first, then 1×1). */
  defenses: Partial<Record<'cannon' | 'archertower' | 'mortar' | 'electrictower' | 'magetower' | 'lasertower' | 'dragonnest', number>>;
  traps: number;
  vault: number;
  mines: number;
  /** Authored campaign layouts rotate their approach instead of every breach
   * opening on the same southern tile. PvE camp templates keep zero. */
  formation?: 0 | 1 | 2 | 3;
  /** Campaign encounters are ordinary legal bases, so they carry the support
   * structures unlocked at this Keep. Rotating practice camps stay unchanged. */
  ordinarySupport?: boolean;
  defenderHero?: { hero: 'vex' | 'theodor'; level: number };
}

/** Difficulty bands (T1 starter → T8 "perfect defence"). Keep/defense levels
 *  and roster scale up; higher tiers unlock the epic defenses. ⚠ ALPHA — tune.
 *  T1 RETUNED cannon 2 → 1 for D-060/SIM11: at the doubled 6-tile cannon reach
 *  the old ADJACENT pair killed all four of a fresh player's L1 turriders on
 *  approach (0★ at 23%, every seed) — the practice/earn loop must stay
 *  winnable by the starter army (pinned in world.test.ts), matching the
 *  campaign's stage-1 single-cannon opener. */
const CAMP_TIERS: readonly CampTier[] = [
  { keep: 1,  lvl: 1,  wallTier: 0,  rings: 0, defenses: { cannon: 1 }, traps: 0, vault: 0, mines: 1 },
  { keep: 2,  lvl: 1,  wallTier: 1,  rings: 1, defenses: { cannon: 1, mortar: 1 }, traps: 0, vault: 2, mines: 1 },
  { keep: 3,  lvl: 2,  wallTier: 1,  rings: 1, defenses: { archertower: 2, cannon: 1 }, traps: 3, vault: 3, mines: 1 },
  { keep: 5,  lvl: 3,  wallTier: 3,  rings: 1, defenses: { cannon: 2, archertower: 2, mortar: 1 }, traps: 3, vault: 5, mines: 1 },
  { keep: 8,  lvl: 5,  wallTier: 5,  rings: 1, defenses: { cannon: 2, archertower: 2, electrictower: 1, mortar: 1 }, traps: 4, vault: 8, mines: 2 },
  { keep: 11, lvl: 8,  wallTier: 8,  rings: 2, defenses: { archertower: 2, electrictower: 2, magetower: 1, mortar: 2 }, traps: 5, vault: 11, mines: 2 },
  { keep: 14, lvl: 12, wallTier: 12, rings: 2, defenses: { electrictower: 2, magetower: 2, lasertower: 1, dragonnest: 1, mortar: 1 }, traps: 6, vault: 14, mines: 2 },
  { keep: 18, lvl: 18, wallTier: 18, rings: 2, defenses: { lasertower: 2, dragonnest: 2, magetower: 2, electrictower: 2, archertower: 2, mortar: 2 }, traps: 8, vault: 18, mines: 2 },
  // T9 MAXED (owner 2026-08-03: dev-spawnable practice fortress) — everything at
  // L20 with ALL SEVEN defence types so every defence fires in one fight. Ops-only:
  // MAX_CAMP_TIER stays 8, so campCoords()/CAMPAIGN never reach this row. ⚠ ALPHA.
  { keep: 20, lvl: 20, wallTier: 20, rings: 3, defenses: { cannon: 2, archertower: 2, mortar: 2, electrictower: 2, magetower: 2, lasertower: 2, dragonnest: 2 }, traps: 10, vault: 20, mines: 2 },
];

// Defenses with a 2×2 footprint (DEFENSES[type].footprint) — placed before the
// 1×1 roster so they get contiguous space. airdefence joined in M23 a2: the M22
// building had never been placed by an NPC generator, and leaving it out made
// placeSpread reserve one tile for a 2×2 footprint (overlap caught by test).
const TWO_BY_TWO = new Set(['mortar', 'dragonnest', 'airdefence']);
/** Builders are base capacity plus worker actors, not a placeable BuildingType.
 * Campaigns therefore use only real, destructible support structures. The order
 * reserves the largest footprints before one-tile buildings fragment the claim. */
const CAMPAIGN_SUPPORT_TYPES = [
  BuildingType.Camp,
  BuildingType.GoldForge,
  BuildingType.Barracks,
  BuildingType.Forge,
] as const;

/**
 * Build a camp base for a difficulty tier (1..MAX_CAMP_TIER). Deterministic
 * (no RNG): the keep sits centered, `rings` wall rings line the claim edge,
 * defenses ring the keep (2×2 to the corners first, 1×1 spread), and traps /
 * vault / mines fill the remaining interior. All footprints are validated
 * against the claim bounds + an occupancy grid, so nothing overlaps.
 */
function makeNpcSnapshot(
  spec: CampTier,
  expansion = 0,
  wallProfile: 'outpost' | 'breach' | 'fortress' = 'fortress',
): BaseSnapshot {
  const claim = claimRect(expansion);
  const off = claim.min - GRID.deployRingTiles; // +6 (fresh-base recenter, migration 0018)
  const LO = claim.min - off; // 2
  const HI = claim.max - off; // 16 (local claim bounds [LO, HI))

  const occ = new Set<string>();
  const buildings: Array<{ id: string; type: BuildingType; level: number; tx: number; ty: number }> = [];
  let idc = 0;
  const key = (x: number, y: number): string => `${x},${y}`;
  const rotatePoint = (
    x: number, y: number, lo = LO, hi = HI - 1,
  ): { x: number; y: number } => {
    const formation = spec.formation ?? 0;
    if (formation === 1) return { x: hi - (y - lo), y: lo + (x - lo) };
    if (formation === 2) return { x: hi - (x - lo), y: hi - (y - lo) };
    if (formation === 3) return { x: lo + (y - lo), y: hi - (x - lo) };
    return { x, y };
  };
  const fits = (tx: number, ty: number, fw: number, fh: number): boolean => {
    if (tx < LO || ty < LO || tx + fw > HI || ty + fh > HI) return false;
    for (let dx = 0; dx < fw; dx++) for (let dy = 0; dy < fh; dy++) if (occ.has(key(tx + dx, ty + dy))) return false;
    return true;
  };
  const put = (type: BuildingType, level: number, fw: number, fh: number, tx: number, ty: number): boolean => {
    if (!fits(tx, ty, fw, fh)) return false;
    for (let dx = 0; dx < fw; dx++) for (let dy = 0; dy < fh; dy++) occ.add(key(tx + dx, ty + dy));
    buildings.push({ id: `pve-${type}-${idc++}`, type, level, tx: tx + off, ty: ty + off });
    return true;
  };

  // Keep centered.
  const center = Math.floor((LO + HI) / 2) - 1; // 8
  put(BuildingType.Keep, spec.keep, 2, 2, center, center);

  // Wall rings hugging the claim edge (full perimeter — attackers breach it).
  for (let r = 0; r < spec.rings && spec.wallTier > 0; r++) {
    const lo = LO + r, hi = HI - 1 - r;
    const wall = (x: number, y: number): void => {
      const gap = rotatePoint(center, hi, lo, hi);
      const designedGap = wallProfile === 'breach' && x === gap.x && y === gap.y;
      const partialGap = wallProfile === 'outpost' && (x + y + r) % 3 === 0;
      if (!designedGap && !partialGap) put(BuildingType.Wall, spec.wallTier, 1, 1, x, y);
    };
    for (let x = lo; x <= hi; x++) { wall(x, lo); wall(x, hi); }
    for (let y = lo + 1; y < hi; y++) { wall(lo, y); wall(hi, y); }
  }

  // Candidate interior anchors (inside the rings), sorted by distance from the
  // keep DESCENDING so towers push to the corners and traps fill toward center.
  const inLo = LO + spec.rings, inHi = HI - spec.rings;
  const mid = (LO + HI) / 2;
  const anchors: Array<{ x: number; y: number }> = [];
  for (let y = inLo; y < inHi; y++) for (let x = inLo; x < inHi; x++) anchors.push({ x, y });
  const dist = (a: { x: number; y: number }): number => Math.max(Math.abs(a.x + 0.5 - mid), Math.abs(a.y + 0.5 - mid));
  const authoredTie = (a: { x: number; y: number }): number => {
    const p = rotatePoint(a.x, a.y);
    return p.y * GRID.plotTiles + p.x;
  };
  const outward = [...anchors].sort((a, b) => dist(b) - dist(a) || authoredTie(a) - authoredTie(b));
  const inward = [...anchors].sort((a, b) => dist(a) - dist(b) || authoredTie(a) - authoredTie(b));

  const placeSpread = (type: BuildingType, level: number, count: number, big: boolean): void => {
    const fw = big ? 2 : 1;
    let placed = 0;
    for (const a of outward) {
      if (placed >= count) break;
      if (put(type, level, fw, fw, a.x, a.y)) placed++;
    }
  };

  // 2×2 defenses first (need contiguous space), then 1×1, then fillers.
  const roster = Object.entries(spec.defenses) as Array<[keyof CampTier['defenses'], number]>;
  for (const [type, n] of roster.filter(([t]) => TWO_BY_TWO.has(t))) placeSpread(type as BuildingType, spec.lvl, n ?? 0, true);
  for (const [type, n] of roster.filter(([t]) => !TWO_BY_TWO.has(t))) placeSpread(type as BuildingType, spec.lvl, n ?? 0, false);

  /** Place an exact legal count, failing loudly instead of silently emitting a
   * campaign base that lies about its support capability. */
  const placeInward = (
    type: BuildingType, level: number, count: number,
  ): Array<{ x: number; y: number }> => {
    const { fw, fh } = footprintOf(type);
    const placed: Array<{ x: number; y: number }> = [];
    for (const a of inward) {
      if (placed.length >= count) break;
      if (put(type, level, fw, fh, a.x, a.y)) placed.push(a);
    }
    if (placed.length !== count) {
      throw new Error(`campaign ${type} placement ${placed.length}/${count} does not fit for Keep ${spec.keep}`);
    }
    return placed;
  };

  // A defending hero's real recruitment building is part of the target base.
  // Reserve its 2x2 footprint before the ordinary support roster.
  let heroAltar: { x: number; y: number } | undefined;
  if (spec.defenderHero) {
    const altarType = spec.defenderHero.hero === 'vex' ? BuildingType.HeroAltar : BuildingType.SiegeStool;
    heroAltar = placeInward(altarType, 1, 1)[0]!;
  }

  if (spec.ordinarySupport) {
    for (const type of CAMPAIGN_SUPPORT_TYPES) {
      const count = BUILD_COUNT_CAP_BY_KEEP[type]?.[spec.keep - 1] ?? 0;
      placeInward(type, spec.lvl, count);
    }
  }

  // Vault(s) + mines toward the middle (protected), then traps salt the paths.
  for (const a of inward) { if (buildings.filter((x) => x.type === BuildingType.Vault).length >= (spec.vault > 0 ? 1 : 0)) break; if (spec.vault > 0) put(BuildingType.Vault, spec.vault, 1, 1, a.x, a.y); }
  let mines = 0;
  for (const a of inward) { if (mines >= spec.mines) break; if (put(BuildingType.Mine, spec.lvl, 1, 1, a.x, a.y)) mines++; }
  let traps = 0;
  for (const a of inward) { if (traps >= spec.traps) break; if (put(BuildingType.SpikeTrap, 1, 1, 1, a.x, a.y)) traps++; }

  if (spec.defenderHero) {
    return {
      keepLevel: spec.keep, surplusShards: 0, claimMin: claim.min, claimMax: claim.max, buildings,
      defenderHeroes: [{
        hero: spec.defenderHero.hero,
        level: spec.defenderHero.level,
        guardTx: heroAltar!.x + off + 1,
        guardTy: heroAltar!.y + off + 1,
      }],
    };
  }
  return { keepLevel: spec.keep, surplusShards: 0, claimMin: claim.min, claimMax: claim.max, buildings };
}

export function makeCampSnapshot(tier: number): BaseSnapshot {
  // Clamp to the FULL table (not MAX_CAMP_TIER): tier 9 is a valid layout, it is
  // just excluded from rotation — the exclusion lives in campCoords(), not here.
  return makeNpcSnapshot(CAMP_TIERS[Math.min(Math.max(tier, 1), CAMP_TIERS.length) - 1]!);
}

// ---------------------------------------------------------------------------
// Campaign designed-base placer (owner 2026-08-16: "better complex more
// challenging bases in campaign" — the stage-62 screenshot showed a sparse,
// thinly-walled cluster). Every stage realizes as a DESIGNED fort: an outer
// wall at CAMPAIGN_LAYOUT.outerWallInset with the support economy living
// outside it, a sealed citadel + 3×3 compartment cross-walls from wallRings 2,
// a doubled outer wall at wallRings 3, cannon on the wall line, an interior
// archer lattice + courtyard casters + side-mid air-defence (see the
// air-defense-in-depth note below), and traps at the choke points the
// profile creates (BREACH funnels, wall-mid approaches, citadel corners).
// Deterministic — no RNG, no wall-clock; `formation` rotates the gate side and
// every anchor phase. All counts come from the authored CAMPAIGN_ENCOUNTERS
// row; all geometry numbers from CAMPAIGN_LAYOUT.
// ---------------------------------------------------------------------------

type CampaignEncounterRow = (typeof CAMPAIGN.encounters)[number];

/** A campaign stage is its own deterministic difficulty surface, never an alias
 * for the eight rotating camp tiers. Five stages exercise each Keep band. */
export function makeCampaignSnapshot(stage: number): BaseSnapshot {
  const bounded = Math.min(Math.max(Math.trunc(stage), 1), CAMPAIGN.totalStages);
  return makeDesignedCampaignBase(CAMPAIGN.encounters[bounded - 1]!);
}

function makeDesignedCampaignBase(e: CampaignEncounterRow): BaseSnapshot {
  const L = CAMPAIGN_LAYOUT;
  const keep = e.keepLevel;
  const lvl = e.defenseLevel;
  const claimTiles = CAMPAIGN.claimTilesByKeep[keep - 1]!;
  const expansion = CAPS.claimTilesByExpansion.indexOf(claimTiles);
  const claim = claimRect(expansion);
  const A = claim.min, B = claim.max; // claim is [A, B) in absolute plot tiles
  const S = B - A;
  const formation = e.formation;
  const rings = e.wallRings;

  const occ = new Set<string>();
  const buildings: BaseSnapshot['buildings'] = [];
  let idc = 0;
  const key = (x: number, y: number): string => `${x},${y}`;
  const fits = (tx: number, ty: number, fw: number, fh: number): boolean => {
    if (tx < A || ty < A || tx + fw > B || ty + fh > B) return false;
    for (let dx = 0; dx < fw; dx++) {
      for (let dy = 0; dy < fh; dy++) if (occ.has(key(tx + dx, ty + dy))) return false;
    }
    return true;
  };
  const put = (type: BuildingType, level: number, tx: number, ty: number): boolean => {
    const { fw, fh } = footprintOf(type);
    if (!fits(tx, ty, fw, fh)) return false;
    for (let dx = 0; dx < fw; dx++) for (let dy = 0; dy < fh; dy++) occ.add(key(tx + dx, ty + dy));
    buildings.push({ id: `pve-${type}-${idc++}`, type, level, tx, ty });
    return true;
  };
  /** Clockwise square-ring walk [a..b]², south edge W→E first — the one
   *  deterministic perimeter order every phased placement below indexes. */
  const ringWalk = (a: number, b: number): Array<{ x: number; y: number }> => {
    const cells: Array<{ x: number; y: number }> = [];
    if (b < a) return cells;
    if (a === b) return [{ x: a, y: a }];
    for (let x = a; x <= b; x++) cells.push({ x, y: b });
    for (let y = b - 1; y >= a; y--) cells.push({ x: b, y });
    for (let x = b - 1; x >= a; x--) cells.push({ x, y: a });
    for (let y = a + 1; y <= b - 1; y++) cells.push({ x: a, y });
    return cells;
  };
  /** Deterministic near-placement: expanding square rings around the anchor. */
  const putNear = (
    type: BuildingType, level: number, ax: number, ay: number, what: string,
  ): { x: number; y: number } => {
    if (put(type, level, ax, ay)) return { x: ax, y: ay };
    for (let r = 1; r <= S; r++) {
      for (const c of ringWalk(-r, r)) {
        if (put(type, level, ax + c.x, ay + c.y)) return { x: ax + c.x, y: ay + c.y };
      }
    }
    throw new Error(`campaign stage ${e.stage}: no room for ${what}`);
  };

  // --- The Keep, dead center (S and every footprint are even). --------------
  const k0 = A + S / 2 - 1;
  put(BuildingType.Keep, keep, k0, k0);

  // --- Walls. ---------------------------------------------------------------
  const m = L.outerWallInset;
  const o0 = A + m, o1 = B - 1 - m;
  const doubled = rings >= 3;
  const wIn = o0 + (doubled ? 1 : 0); // innermost outer-wall coordinate
  const wInHi = o1 - (doubled ? 1 : 0);
  // Citadel bounds; wallRings 1 keeps a pseudo-box (the Keep footprint) so the
  // anchor math below stays uniform without placing citadel walls.
  const cs = S >= L.citadelWideFromClaimTiles ? L.citadelWideSizeTiles : L.citadelSizeTiles;
  const hasCitadel = rings >= 2;
  const c0 = hasCitadel ? A + (S - cs) / 2 : k0 - 1;
  const c1 = hasCitadel ? c0 + cs - 1 : k0 + 2;

  // Gate side: formation 0 = south, 1 = west, 2 = north, 3 = east (same
  // orientation the pre-redesign generator rotated its breach gap through).
  const gate = new Set<string>();
  if (e.profile === 'BREACH') {
    const lanes = [k0, k0 + 1]; // breachGateTiles = 2, centered
    const edges = doubled ? [0, 1] : [0];
    for (const d of edges) {
      for (const lane of lanes) {
        if (formation === 0) gate.add(key(lane, o1 - d));
        else if (formation === 1) gate.add(key(o0 + d, lane));
        else if (formation === 2) gate.add(key(lane, o0 + d));
        else gate.add(key(o1 - d, lane));
      }
    }
  }
  let wallCount = 0;
  const wall = (x: number, y: number): void => {
    if (put(BuildingType.Wall, lvl, x, y)) wallCount++;
  };
  const placeRing = (a: number, b: number, gapPhase: number): void => {
    ringWalk(a, b).forEach((c, i) => {
      if (e.profile === 'OUTPOST' && (i + formation + gapPhase) % L.outpostGapEvery === 0) return;
      if (gate.has(key(c.x, c.y))) return;
      wall(c.x, c.y);
    });
  };
  if (rings >= 1) placeRing(o0, o1, 0); // Keep 1 stays an open camp (rings 0)
  if (doubled) placeRing(o0 + 1, o1 - 1, 2); // offset gaps: no aligned corridor
  if (hasCitadel) {
    for (const c of ringWalk(c0, c1)) wall(c.x, c.y); // sealed, every profile
    // 3×3 compartment cross-walls: the citadel edges extended toward the outer
    // wall, stopping ONE tile short of it — the doorway is a deliberate choke
    // (and what keeps the densest Keep-18 BREACH inside its 228-wall cap).
    for (const x of [c0, c1]) {
      for (let y = wIn + 2; y < c0; y++) wall(x, y);
      for (let y = c1 + 1; y < wInHi - 1; y++) wall(x, y);
    }
    for (const y of [c0, c1]) {
      for (let x = wIn + 2; x < c0; x++) wall(x, y);
      for (let x = c1 + 1; x < wInHi - 1; x++) wall(x, y);
    }
  }
  // BREACH funnel: two trap-lined wall stubs pulling the gate into a kill lane.
  const funnel: Array<{ x: number; y: number }> = [];
  if (e.profile === 'BREACH') {
    for (let d = 1; d <= L.breachFunnelDepthTiles; d++) {
      if (formation === 0) {
        wall(k0 - 1, wInHi - d); wall(k0 + 2, wInHi - d);
        funnel.push({ x: k0, y: wInHi - d }, { x: k0 + 1, y: wInHi - d });
      } else if (formation === 1) {
        wall(wIn + d, k0 - 1); wall(wIn + d, k0 + 2);
        funnel.push({ x: wIn + d, y: k0 }, { x: wIn + d, y: k0 + 1 });
      } else if (formation === 2) {
        wall(k0 - 1, wIn + d); wall(k0 + 2, wIn + d);
        funnel.push({ x: k0, y: wIn + d }, { x: k0 + 1, y: wIn + d });
      } else {
        wall(wInHi - d, k0 - 1); wall(wInHi - d, k0 + 2);
        funnel.push({ x: wInHi - d, y: k0 }, { x: wInHi - d, y: k0 + 1 });
      }
    }
  }
  const wallCap = wallCapForKeepLevel(keep);
  if (wallCount > wallCap) {
    throw new Error(
      `campaign stage ${e.stage}: ${wallCount} walls exceed the Keep ${keep} cap ${wallCap}`,
    );
  }

  // --- Anchor kits (rotated by formation so sister stages differ). ----------
  const rot = <T>(list: T[]): T[] => list.map((_, i, arr) => arr[(i + formation) % arr.length]!);
  const dd = hasCitadel ? Math.floor(cs / 2) + 1 : 3; // just outside the citadel
  const sideAnchors = rot([
    { x: k0, y: k0 + dd }, { x: k0 - dd, y: k0 },
    { x: k0, y: k0 - dd }, { x: k0 + dd, y: k0 },
  ]);
  const diagAnchors = rot([
    { x: k0 - dd, y: k0 - dd }, { x: k0 + dd, y: k0 - dd },
    { x: k0 + dd, y: k0 + dd }, { x: k0 - dd, y: k0 + dd },
  ]);
  // Compartment mid-points of the 3×3 grid (the layout is x/y symmetric, so
  // the low/high mids serve both axes): corners first, then edge compartments.
  const gLo = (o0 + c0) >> 1, gHi = (c1 + o1) >> 1;
  const compartmentAnchors = rot([
    { x: gLo, y: gLo }, { x: gHi, y: gLo }, { x: gHi, y: gHi }, { x: gLo, y: gHi },
  ]).concat(rot([
    { x: k0, y: gLo }, { x: gHi, y: k0 }, { x: k0, y: gHi }, { x: gLo, y: k0 },
  ]));

  // --- A defending hero's recruitment building is part of the target base. --
  let heroAltar: { x: number; y: number } | undefined;
  if (e.defenderHero) {
    const altarType = e.defenderHero.hero === 'vex' ? BuildingType.HeroAltar : BuildingType.SiegeStool;
    const back = sideAnchors[2]!; // opposite the gate side
    heroAltar = putNear(altarType, 1, back.x, back.y, 'hero altar');
  }

  // --- Towers: AIR-DEFENSE-IN-DEPTH. Under SIM10 a Dragon's attack run
  // out-reached every 4-tile tower (K-030, closed by D-060's edge-anchored
  // anti-air + 7-tile archers), but layering stays right: interior targets
  // shield each other and a dragon eating one tower stands in several others'
  // reach (the reason camp T8 kills dragons and thin rings never did). Ground-
  // only cannon hold the wall line over the skirt; archers form an interior
  // lattice around the citadel; casters hold the courtyard; the air-defence
  // battery sits at the side mids where its 6-tile reach covers the interior.
  const counts = e.defenses as Partial<Record<string, number>>;
  const placeAnchored = (type: BuildingType, n: number, anchors: Array<{ x: number; y: number }>): void => {
    for (let i = 0; i < n; i++) {
      const a = anchors[i % anchors.length]!;
      putNear(type, lvl, a.x, a.y, type);
    }
  };
  placeAnchored(BuildingType.AirDefence, counts['airdefence'] ?? 0, sideAnchors);
  placeAnchored(BuildingType.Mortar, counts['mortar'] ?? 0, diagAnchors);
  placeAnchored(BuildingType.DragonNest, counts['dragonnest'] ?? 0, [sideAnchors[1]!, sideAnchors[3]!]);
  // 1×1 casters inside the citadel courtyard (putNear overflows them outward).
  placeAnchored(BuildingType.MageTower, counts['magetower'] ?? 0, [
    { x: k0 - 1, y: k0 - 1 }, { x: k0 + 2, y: k0 + 2 }, { x: k0 + 2, y: k0 - 1 },
  ]);
  placeAnchored(BuildingType.ElectricTower, counts['electrictower'] ?? 0, [
    { x: k0 - 1, y: k0 + 2 }, { x: k0 + 2, y: k0 + 1 }, { x: k0 - 1, y: k0 },
  ]);
  placeAnchored(BuildingType.LaserTower, counts['lasertower'] ?? 0, compartmentAnchors);
  // Archer lattice: even arcs two tiles outside the citadel wall, formation-
  // phased — any interior building sits inside some archer's reach.
  const archRing = ringWalk(c0 - 2, c1 + 2);
  const nArcher = counts['archertower'] ?? 0;
  for (let j = 0; j < nArcher; j++) {
    const at = archRing[(Math.floor((j * archRing.length) / Math.max(1, nArcher))
      + formation * 3) % archRing.length]!;
    putNear(BuildingType.ArcherTower, lvl, at.x, at.y, BuildingType.ArcherTower);
  }
  // Cannon hold the wall: even arcs one tile inside the innermost wall ring.
  const towerRing = ringWalk(wIn + 1, wInHi - 1);
  const nCannon = counts['cannon'] ?? 0;
  for (let j = 0; j < nCannon; j++) {
    const at = towerRing[(Math.floor((j * towerRing.length) / Math.max(1, nCannon))
      + formation * 3) % towerRing.length]!;
    putNear(BuildingType.Cannon, lvl, at.x, at.y, BuildingType.Cannon);
  }

  // --- Vaults guard the compartments; the Keep-band count matches a player's.
  const vaultCount = BUILD_COUNT_CAP_BY_KEEP['vault']![keep - 1]!;
  placeAnchored(BuildingType.Vault, vaultCount, compartmentAnchors.slice().reverse());

  // --- Traps at the choke points the walls actually create. -----------------
  const trapCells: Array<{ x: number; y: number }> = [...funnel];
  for (const side of rot([0, 1, 2, 3])) {
    for (const lane of [k0 - 1, k0, k0 + 1, k0 + 2]) {
      if (side === 0) trapCells.push({ x: lane, y: wInHi - 1 });
      else if (side === 1) trapCells.push({ x: wIn + 1, y: lane });
      else if (side === 2) trapCells.push({ x: lane, y: wIn + 1 });
      else trapCells.push({ x: wInHi - 1, y: lane });
    }
  }
  trapCells.push(
    { x: c0 - 1, y: c0 - 1 }, { x: c1 + 1, y: c0 - 1 },
    { x: c1 + 1, y: c1 + 1 }, { x: c0 - 1, y: c1 + 1 },
  );
  for (const c of towerRing) trapCells.push(c);
  const trapFamily = (i: number): BuildingType => {
    if (keep >= L.airMineFromKeep && (i + 1) % L.airMineEvery === 0) return BuildingType.AirMine;
    const cycle = [BuildingType.SpikeTrap, BuildingType.PowderMine, BuildingType.Pitfall];
    return cycle[i % cycle.length]!;
  };
  let trapsPlaced = 0;
  for (const c of trapCells) {
    if (trapsPlaced >= e.traps) break;
    if (put(trapFamily(trapsPlaced), lvl, c.x, c.y)) trapsPlaced++;
  }
  if (trapsPlaced < e.traps) {
    throw new Error(`campaign stage ${e.stage}: only ${trapsPlaced}/${e.traps} traps fit`);
  }

  // --- The support economy lives OUTSIDE the wall (CoC-style skirt). --------
  const skirt = ringWalk(A, B - 1);
  const supportPlan: Array<{ type: BuildingType; level: number }> = [];
  for (const type of CAMPAIGN_SUPPORT_TYPES) {
    const n = BUILD_COUNT_CAP_BY_KEEP[type]?.[keep - 1] ?? 0;
    for (let i = 0; i < n; i++) supportPlan.push({ type, level: lvl });
  }
  for (let i = 0; i < e.mines; i++) supportPlan.push({ type: BuildingType.Mine, level: lvl });
  supportPlan.forEach((item, j) => {
    const at = skirt[(Math.floor((j * skirt.length) / Math.max(1, supportPlan.length))
      + formation * 7) % skirt.length]!;
    putNear(item.type, item.level, at.x, at.y, item.type);
  });

  if (e.defenderHero && heroAltar) {
    return {
      keepLevel: keep, surplusShards: 0, claimMin: A, claimMax: B, buildings,
      defenderHeroes: [{
        hero: e.defenderHero.hero,
        level: e.defenderHero.level,
        guardTx: heroAltar.x + 1,
        guardTy: heroAltar.y + 1,
      }],
    };
  }
  return { keepLevel: keep, surplusShards: 0, claimMin: A, claimMax: B, buildings };
}

/** Reserved camp coordinates inside a valley grid — deterministic, collision-free.
 *  Tiers cycle 1..MAX_CAMP_TIER so every valley spans the full difficulty ramp. */
export function campCoords(): Array<{ x: number; y: number; tier: number }> {
  const out: Array<{ x: number; y: number; tier: number }> = [];
  for (let i = 0; i < WORLD.campsPerValley; i++) {
    // spread across the grid on a fixed lattice, tiers cycling the full ramp
    const x = (i * 7 + 3) % WORLD.gridCols;
    const y = (i * 5 + 2) % WORLD.gridRows;
    out.push({ x, y, tier: (i % MAX_CAMP_TIER) + 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Valleys & plot assignment
// ---------------------------------------------------------------------------

/**
 * Seed (or re-seed) a valley's PvE camps from the CURRENT campCoords() ramp.
 * Idempotent — upserts on the (valleyId, x, y) unique key — so it is safe to
 * re-run over a populated valley.
 *
 * Why re-seeding must exist: camps were previously written ONLY at valley
 * creation, so a valley made before the tier ramp widened (1..3 → 1..MAX_CAMP_TIER)
 * keeps its old difficulty band forever, leaving a maxed Keep with nothing but
 * starter camps to attack. `respawnsAt` is deliberately left untouched — re-tiering
 * must never resurrect a camp the player already cleared today.
 *
 * Camps with a raid still inside its deploy window are SKIPPED: submitOrders
 * pays the bounty from the camp's LIVE lootKeep while the fight runs against the
 * frozen snapshot, so re-tiering mid-raid would pay a new (possibly 15×) bounty
 * for beating the old layout. Skipped camps pick the new tier up on the next
 * reseed run once the window lapses (verification 2026-07-26).
 */
export async function reseedValleyCamps(db: DbOrTx, valleyId: string, now = new Date()): Promise<number> {
  const inFlight = await db.select({ x: pveCamps.x, y: pveCamps.y }).from(pveCamps)
    .innerJoin(raids, eq(raids.pveCampId, pveCamps.id))
    .where(and(
      eq(pveCamps.valleyId, valleyId),
      eq(raids.status, 'pending_orders'),
      gt(raids.ordersDeadlineAt, now), // past-deadline rows can never submit — safe to re-tier
    ));
  const locked = new Set(inFlight.map((c) => `${c.x},${c.y}`));
  const camps = campCoords()
    .filter((c) => !locked.has(`${c.x},${c.y}`))
    .map((c) => ({
      valleyId,
      x: c.x,
      y: c.y,
      tier: c.tier,
      snapshot: makeCampSnapshot(c.tier),
      lootKeep: BigInt(PVE.bountyByTier[c.tier - 1]!),
    }));
  if (camps.length > 0) {
    await db.insert(pveCamps).values(camps).onConflictDoUpdate({
      target: [pveCamps.valleyId, pveCamps.x, pveCamps.y],
      set: {
        tier: sql`excluded.tier`,
        snapshot: sql`excluded.snapshot`,
        lootKeep: sql`excluded.loot_keep`,
      },
    });
  }
  return camps.length;
}

/**
 * Deterministic valley name from its 1-based ordinal (MAP-SCALE-PLAN S6). The
 * banner used to print `VALLEY <uuid-fragment>` — a database identifier shown to
 * a human. prefix × suffix gives WORLD.valleyNameParts.prefixes.length ×
 * .suffixes.length distinct names; past that the generator numbers the cycle so
 * two valleys never share a label.
 */
export function valleyName(ordinal: number): string {
  const { prefixes, suffixes } = WORLD.valleyNameParts;
  const i = Math.max(0, ordinal - 1);
  const p = prefixes.length, s = suffixes.length;
  const base = `${prefixes[i % p]} ${suffixes[Math.floor(i / p) % s]}`;
  const cycle = Math.floor(i / (p * s));
  return cycle > 0 ? `${base} ${cycle + 1}` : base;
}

/**
 * Did this insert lose the race for a site id? 23505 = unique_violation on
 * `valleys_site_id_uq`.
 *
 * EXPORTED FOR THE TEST HELPER (`createTestValley`), which allocates site ids the
 * same way and needs the same answer — and one predicate is the only way both can
 * be right. drizzle wraps driver errors, so `.cause` is unwrapped too (the
 * clans.ts / username.ts convention): the wrapper's own `message` is
 * "Failed query: insert into …" and carries NEITHER the code nor the constraint
 * name, so a message-only test silently never matches — verified against a real
 * violation rather than assumed.
 */
export function isSiteIdCollision(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
  const code = (err as { code?: string }).code ?? cause?.code;
  const constraint = String(
    (err as { constraint_name?: string }).constraint_name ?? cause?.constraint_name ?? '',
  );
  return code === '23505' && constraint.includes('valleys_site_id_uq');
}

/** The machine-readable reason a signup was refused because the planet is full.
 *  A client (or an ops alert) must not have to string-match a human sentence to
 *  tell "Earth sold out" from a transient outage — the two need opposite
 *  responses, and only one of them is answered by retrying. */
export const EARTH_FULL_CODE = 'EARTH_FULL';

/**
 * EARTH IS FINITE, AND RUNNING OUT MUST SAY SO (D4, 2026-08-10).
 *
 * `patchCount()` seats exactly 120 valleys (58,920 parcels) because a parcel is a
 * real 0.5° land cell and `patchCells` THROWS rather than wrapping past the last
 * patch — a wrap would be two deeds conveying one 55 km county. Without this guard
 * the failure arrived in the worst possible order: `createValley` committed a valley
 * row at site 120 with its 9 camps, `invalidateGlobe()` published it, and then EVERY
 * signup 500ed on a raw `Error: Earth is full` thrown from inside `parcelCell` —
 * with an orphan valley left behind that no player could ever be seated in.
 *
 * So the ceiling is checked BEFORE the row is written, and it fails as a typed
 * `HttpError` with `EARTH_FULL_CODE`. This is the moment the whole finite-Earth
 * decision exists for (owner 2026-08-10 Q1: "selling out is what unlocks the next
 * planet", Addendum C: Moon and Jupiter are pre-wired), so it has to read as a
 * product state and not as a crash.
 *
 * 503, NOT 4xx AND NOT 500: nothing about the request is wrong and nothing is
 * broken — the server genuinely cannot seat this player until another body exists.
 * That is also the only honest hint to give: retrying will not help, and the
 * message says so rather than implying a wait.
 *
 * A PLANET THAT DOES NOT PUBLISH A CAPACITY IS NOT GUESSED AT. `patchCount` is
 * optional on the seam (a substitute planet may have no tile layer at all), and if
 * it is missing this guard stands aside — `earthAddressOf` then refuses the seat
 * with its own typed 500 rather than inventing an address.
 */
function assertEarthSeatsAnotherValley(siteId: number): void {
  const seats = globeGeo().patchCount?.();
  if (seats === undefined || siteId < seats) return;
  throw new HttpError(
    503,
    `Earth is sold out — all ${seats} regions (${seats * (WORLD.valleyCapacity - WORLD.campsPerValley)} `
    + 'parcels) are allocated, so there is no land left to seat a new base. This will not '
    + 'resolve by retrying: the next planet has to open.',
    EARTH_FULL_CODE,
  );
}

/**
 * Mint a valley AND ITS PLACE ON THE PLANET (P5).
 *
 * `site_id` is `max(site_id) + 1`, which is the same number the old derived
 * `row_number() over (order by created_at, id) - 1` produced for a fresh row — so
 * this writes down what the globe already believed instead of choosing anything
 * new. It is written here, at creation, because a place a valley is GIVEN cannot
 * drift, while a place a valley is COMPUTED from the table's contents can (see
 * schema.ts's site_id docstring).
 *
 * THE UNIQUE CONSTRAINT IS THE CONCURRENCY MECHANISM, not a safety net. This read
 * is unlocked (like the `count(*)` the name has always used), so two simultaneous
 * rollovers can compute the same site_id — and `valleys_site_id_uq` then rejects
 * the loser rather than letting two valleys share one pin. The loser does NOT
 * retry with a bumped number: it joins the valley the winner just created, which
 * is exactly what `rolloverValley` already does for a concurrent rollover ("do not
 * mint yet another, join that one"). Only a race with no winner visible is retried.
 */
/** Find the first unused Earth patch. Player-selected high sites may exist
 * before lower ones, so max(site_id)+1 would permanently strand valid land. */
async function lowestUnusedEarthSite(db: DbOrTx): Promise<number> {
  const used = await db.select({ siteId: valleys.siteId }).from(valleys)
    .where(eq(valleys.planetId, 0)).orderBy(asc(valleys.siteId));
  let candidate = 0;
  for (const row of used) {
    if (row.siteId < candidate) continue;
    if (row.siteId === candidate) candidate++;
    else break;
  }
  assertEarthSeatsAnotherValley(candidate);
  return candidate;
}

/** Create or find the valley at one frozen Earth site. A savepoint contains a
 * concurrent unique loss so the caller's outer land-intent transaction remains
 * usable and can join the winner. */
export async function ensureValleyAtSite(db: DbOrTx, siteId: number): Promise<string> {
  assertEarthSeatsAnotherValley(siteId);
  const [existing] = await db.select({ id: valleys.id }).from(valleys)
    .where(and(eq(valleys.planetId, 0), eq(valleys.siteId, siteId)));
  if (existing) return existing.id;
  try {
    const created = await db.transaction(async (tx) => {
      const [raced] = await tx.select({ id: valleys.id }).from(valleys)
        .where(and(eq(valleys.planetId, 0), eq(valleys.siteId, siteId)));
      if (raced) return { id: raced.id, inserted: false };
      const [v] = await tx.insert(valleys)
        .values({ name: valleyName(siteId + 1), siteId, planetId: 0 })
        .returning({ id: valleys.id });
      await reseedValleyCamps(tx, v!.id);
      return { id: v!.id, inserted: true };
    });
    if (created.inserted) invalidateGlobe();
    return created.id;
  } catch (err) {
    if (!isSiteIdCollision(err)) throw err;
    const [winner] = await db.select({ id: valleys.id }).from(valleys)
      .where(and(eq(valleys.planetId, 0), eq(valleys.siteId, siteId)));
    if (winner) return winner.id;
    throw err;
  }
}

async function createValley(db: Db): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const siteId = await lowestUnusedEarthSite(db);
    try {
      return await ensureValleyAtSite(db, siteId);
    } catch (err) {
      // Only a site_id collision is recoverable by joining someone else's valley;
      // anything else (a real DB fault) must surface.
      if (!isSiteIdCollision(err)) throw err;
      const [newest] = await db.select({ id: valleys.id }).from(valleys)
        .orderBy(desc(valleys.createdAt)).limit(1);
      if (newest) return newest.id;
    }
  }
  throw new HttpError(500, 'valley creation failed');
}

export interface EarthParcelIdentity {
  earthCell: number;
  siteId: number;
  x: number;
  y: number;
  countryA3: string;
}

/** Resolve a player-selected frozen cell through the one globe-data seam. */
export function earthParcelIdentity(earthCell: number): EarthParcelIdentity {
  const geo = globeGeo();
  if (!Number.isInteger(earthCell) || earthCell < 0 || !geo.parcelOf || !geo.countryA3) {
    throw new HttpError(422, 'Earth cell is not a seatable parcel', 'EARTH_CELL_UNAVAILABLE');
  }
  const tile = geo.parcelOf(earthCell);
  if (!tile) throw new HttpError(422, 'Earth cell is not a seatable parcel', 'EARTH_CELL_UNAVAILABLE');
  const countryA3 = geo.countryA3(earthCell);
  if (countryA3 === NO_SOVEREIGN_A3) {
    throw new HttpError(422, 'Earth cell has no sovereign parcel', 'EARTH_CELL_UNAVAILABLE');
  }
  return { earthCell, ...tile, countryA3 };
}

/** Choose from every currently seatable cell, excluding both converted plots
 * and live payment reservations. Reservoir sampling is crypto-random without
 * allocating a 58,920-object candidate list. */
export async function chooseAvailableEarthParcel(
  db: DbOrTx, requestedCell?: number,
): Promise<EarthParcelIdentity> {
  const [occupiedRows, reservedRows] = await Promise.all([
    db.select({ earthCell: plots.earthCell }).from(plots),
    db.select({ earthCell: plotReservations.earthCell }).from(plotReservations)
      .where(inArray(plotReservations.state, ['reserved', 'paid', 'converted'])),
  ]);
  const unavailable = new Set([
    ...occupiedRows.map((row) => row.earthCell),
    ...reservedRows.map((row) => row.earthCell),
  ]);
  if (requestedCell !== undefined) {
    const chosen = earthParcelIdentity(requestedCell);
    if (unavailable.has(requestedCell)) {
      throw new HttpError(409, 'Earth cell is already occupied or reserved', 'EARTH_CELL_UNAVAILABLE');
    }
    return chosen;
  }

  const geo = globeGeo();
  if (!geo.patchCount || !geo.parcelCell || !geo.countryA3) {
    throw new HttpError(500, 'this planet has no Earth-tile layer, so it cannot reserve a parcel');
  }
  const campTiles = new Set(campCoords().map((c) => `${c.x},${c.y}`));
  let seen = 0;
  let chosen: EarthParcelIdentity | undefined;
  for (let siteId = 0; siteId < geo.patchCount(); siteId++) {
    for (const [x, y] of plotFillOrder()) {
      if (campTiles.has(`${x},${y}`)) continue;
      const earthCell = geo.parcelCell(siteId, x, y);
      if (unavailable.has(earthCell)) continue;
      const countryA3 = geo.countryA3(earthCell);
      if (countryA3 === NO_SOVEREIGN_A3) continue;
      seen++;
      if (randomInt(seen) === 0) chosen = { earthCell, siteId, x, y, countryA3 };
    }
  }
  if (!chosen) throw new HttpError(503, 'Earth is sold out', EARTH_FULL_CODE);
  return chosen;
}

/**
 * The valley is full — pick where the next cohort goes. If a CONCURRENT signup
 * already rolled the world over to a newer valley, join that one instead of
 * minting yet another: without this, N signups arriving at a full valley each
 * created their own, fragmenting the world into half-empty cohorts (the exact
 * failure GDD §3.4's "cohorts grow up together" depends on not happening).
 */
async function rolloverValley(db: Db, fullValleyId: string): Promise<string> {
  const [newest] = await db.select({ id: valleys.id }).from(valleys)
    .orderBy(desc(valleys.createdAt)).limit(1);
  if (newest && newest.id !== fullValleyId) return newest.id;
  return createValley(db);
}

/**
 * The parcel's REAL EARTH ADDRESS — the cell AND the country that holds it —
 * resolved through the one seam (lib/globeGeo.ts). This is the ONLY call site of
 * the seam's Earth-tile members outside the capacity guard above.
 *
 * A plot cannot be created without both. `plots.earth_cell` is NOT NULL UNIQUE
 * (migration 0053) and `plots.country_a3` is NOT NULL (migration 0054) because the
 * country goes on the deed (owner decision 2026-08-10 Q3) and a deed is published
 * on a chain that cannot be recalled. Written down once here, neither can move
 * again; recomputed per request the COUNTRY would move whenever someone
 * regenerated the Earth data, because the cell → country lookup runs through the
 * mask's land enumeration and the index's rank-based ids (D1, 2026-08-10).
 *
 * A substitute planet with no tile layer cannot seat players, and says so instead
 * of writing a placeholder that would later be read as real land.
 *
 * A CELL WITH NO SOVEREIGN IS A BUG ON EARTH, AND IT FAILS LOUDLY. `parcelCell`
 * only ever returns cells from `claimableCells`, which is "land cells with a
 * country" ∪ the sub-tile countries' cells — so every seatable cell has one. If the
 * mask and the country index ever disagree, refusing the signup is right: the
 * alternative is a deed that names no country, minted before anyone notices.
 */
function earthAddressOf(siteId: number, x: number, y: number): { cell: number; countryA3: string } {
  const geo = globeGeo();
  const resolve = geo.parcelCell;
  const sovereign = geo.countryA3;
  if (!resolve || !sovereign) {
    throw new HttpError(500, 'this planet has no Earth-tile layer, so it cannot seat a parcel');
  }
  const cell = resolve(siteId, x, y);
  const countryA3 = sovereign(cell);
  if (countryA3 === NO_SOVEREIGN_A3) {
    throw new HttpError(
      500,
      `Earth cell ${cell} is claimable but has no sovereign — the mask and the country index disagree`,
    );
  }
  return { cell, countryA3 };
}

/**
 * One assignment attempt against ONE valley, serialized on that valley's row.
 *
 * The FOR UPDATE is what makes `taken.size < valleyCapacity` true rather than
 * hopeful: unlocked, N concurrent signups all read the same stale occupancy, so
 * a valley could both over-fill AND spray rollovers. Returns null when the valley
 * genuinely has no room. Per-insert SAVEPOINT (the nested tx) so a unique race
 * can still fall through to the next coordinate without poisoning the outer
 * transaction — a plain catch inside a transaction cannot continue in Postgres.
 *
 * P5: the plot's Earth cell is written in THE SAME INSERT. Not a second statement
 * and not a later backfill — a plot that exists for even one transaction without
 * its frozen address is a plot whose address could then be computed against a
 * different mask.
 */
async function tryAssignInValley(
  db: Db, valleyId: string, wallet: string, order: ReadonlyArray<readonly [number, number]>,
  baseId?: string, authorizeBase?: (tx: DbTx, wallet: string, baseId: string) => Promise<void>,
): Promise<{ valleyId: string; x: number; y: number } | null> {
  return db.transaction(async (tx) => {
    if (baseId) {
      await tx.select({ wallet: players.wallet }).from(players)
        .where(eq(players.wallet, wallet)).for('update');
      const [base] = await tx.select({ id: bases.id }).from(bases).where(and(
        eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
      )).for('update');
      if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
      if (authorizeBase) await authorizeBase(tx, wallet, baseId);
    }
    // The lock now also READS `site_id`, because that (with x/y) is the parcel's
    // Earth address. No extra query: this is the row the FOR UPDATE already took.
    const [v] = await tx.select({ id: valleys.id, siteId: valleys.siteId })
      .from(valleys).where(eq(valleys.id, valleyId)).for('update');
    // A valley that vanished between the caller's read and this lock has no room in
    // it, so the caller rolls over — the same answer as a full valley.
    if (!v) return null;

    const taken = new Set<string>();
    const ps = await tx.select({ x: plots.x, y: plots.y }).from(plots).where(eq(plots.valleyId, valleyId));
    ps.forEach((p) => taken.add(`${p.x},${p.y}`));
    const reserved = await tx.select({ x: plotReservations.x, y: plotReservations.y })
      .from(plotReservations).where(and(
        eq(plotReservations.siteId, v.siteId),
        inArray(plotReservations.state, ['reserved', 'paid', 'converted']),
      ));
    reserved.forEach((p) => taken.add(`${p.x},${p.y}`));
    const cs = await tx.select({ x: pveCamps.x, y: pveCamps.y }).from(pveCamps).where(eq(pveCamps.valleyId, valleyId));
    cs.forEach((c) => taken.add(`${c.x},${c.y}`));
    if (taken.size >= WORLD.valleyCapacity) return null;

    // The 9 camp tiles are not deeded land and have no Earth cell (R2), so they
    // are skipped by the LATTICE rather than only by the rows in `taken` above:
    // a valley whose camps were never seeded would otherwise reach one of them
    // and fail the whole signup on `parcelCell`'s camp-tile guard.
    const campTiles = new Set(campCoords().map((c) => `${c.x},${c.y}`));

    for (const [x, y] of order) {
      const key = `${x},${y}`;
      if (taken.has(key) || campTiles.has(key)) continue;
      const { cell: earthCell, countryA3 } = earthAddressOf(v.siteId, x, y);
      try {
        const row = await tx.transaction(async (sp) => {
          const [r] = await sp.insert(plots)
            .values({ valleyId, x, y, playerWallet: wallet, baseId, earthCell, countryA3 })
            .returning();
          return r!;
        });
        return { valleyId, x, y };
      } catch {
        // unique race (another player grabbed it) — try the next coord
      }
    }
    return null;
  });
}

/** Deterministic tile visit order for plot assignment: coarse lattice (stride
 *  5→3→2) first, then every remaining tile, so bases spread out while a sparse
 *  valley fills, yet all WORLD.gridCols×gridRows tiles stay reachable. */
export function plotFillOrder(): Array<[number, number]> {
  const order: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const step of [5, 3, 2, 1]) {
    for (let y = 0; y < WORLD.gridRows; y += step) {
      for (let x = 0; x < WORLD.gridCols; x += step) {
        const k = `${x},${y}`;
        if (!seen.has(k)) { seen.add(k); order.push([x, y]); }
      }
    }
  }
  return order;
}

/** Assign the player a plot in the newest valley with room (idempotent). */
export async function ensurePlotAssigned(db: Db, wallet: string): Promise<{ valleyId: string; x: number; y: number }> {
  const existing = await db.select().from(plots).where(eq(plots.playerWallet, wallet));
  if (existing[0]) {
    const plot = existing[0];
    if (plot.valleyId === null || plot.x === null || plot.y === null) throw new HttpError(409, 'Use the fantasy world map', 'WORLD_UPDATE_REQUIRED');
    return { valleyId: plot.valleyId, x: plot.x, y: plot.y };
  }

  // newest valley first
  const vs = await db.select().from(valleys).orderBy(desc(valleys.createdAt)).limit(1);
  let valleyId = vs[0]?.id;
  if (!valleyId) valleyId = await createValley(db);

  // Visit tiles in a SPREAD order — a coarse lattice first (stride 5→3→2), then
  // every remaining tile — so a sparsely populated valley spaces bases out instead
  // of packing them tile-adjacent from (0,0). Deterministic (no Math.random); all
  // tiles are still reachable at stride 1, so valleyCapacity is unchanged.
  const order = plotFillOrder();

  // Three attempts, not two: (1) the newest valley, (2) whichever valley a
  // concurrent signup rolled over to while we were blocked on its row lock, and
  // (3) a valley we minted ourselves — which cannot be full. Two attempts could
  // land on a rolled-over-but-already-full valley and 500 a legitimate signup.
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await tryAssignInValley(db, valleyId, wallet, order);
    if (got) {
      // A new keep must appear on the map now, not after the cache TTL lapses.
      invalidateValley(got.valleyId);
      return got;
    }
    valleyId = await rolloverValley(db, valleyId); // full (GDD §3.4)
  }
  throw new HttpError(500, 'plot assignment failed');
}

/** Stable-base parcel lookup/repair. Ownership follows bases.owner_wallet; the
 * legacy plots.player_wallet is intentionally ignored after a deed transfer. */
export async function ensureBasePlotAssigned(
  db: Db, wallet: string, baseId: string,
  authorizeBase?: (tx: DbTx, wallet: string, baseId: string) => Promise<void>,
): Promise<{ valleyId: string | null; x: number | null; y: number | null;
  landAddress?: { kind: 'fantasy'; worldId: 'fantasy-v1'; tileId: number } }> {
  const existing = await db.transaction(async (tx) => {
    await tx.select({ wallet: players.wallet }).from(players)
      .where(eq(players.wallet, wallet)).for('update');
    const [base] = await tx.select({ id: bases.id, paidAt: bases.landPaidAt }).from(baseSlots)
      .innerJoin(bases, eq(bases.id, baseSlots.baseId)).where(and(
        eq(bases.id, baseId), eq(bases.ownerWallet, wallet), eq(bases.status, 'active'),
        eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
      )).for('update');
    if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
    if (authorizeBase) await authorizeBase(tx, wallet, baseId);
    const [plot] = await tx.select({ valleyId: plots.valleyId, x: plots.x, y: plots.y, addressKind: plots.addressKind })
      .from(plots).where(eq(plots.baseId, baseId));
    if (fantasyWorldEnabled() || plot?.addressKind === 'fantasy') {
      const location = await resolveFantasyLocation(tx, baseId);
      if (!base.paidAt || !location) throw new HttpError(409, 'This base has no assigned fantasy location', 'FANTASY_LOCATION_PENDING');
      if (!plot) await tx.insert(plots).values({ baseId, playerWallet: wallet,
        addressKind: 'fantasy', fantasyWorldId: location.worldId, fantasyTileId: location.tileId });
      return { valleyId: null, x: null, y: null,
        landAddress: { kind: 'fantasy' as const, worldId: location.worldId, tileId: location.tileId } };
    }
    if (plot) return { valleyId: plot.valleyId, x: plot.x, y: plot.y };
    return undefined;
  });
  if (existing) return existing;

  const vs = await db.select().from(valleys).orderBy(desc(valleys.createdAt)).limit(1);
  let valleyId = vs[0]?.id;
  if (!valleyId) valleyId = await createValley(db);
  const order = plotFillOrder();
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await tryAssignInValley(db, valleyId, wallet, order, baseId, authorizeBase);
    if (got) {
      invalidateValley(got.valleyId);
      // Stable plot assignment changes the public globe population and valley
      // membership just as activation does. Publish both caches only after the
      // assigning transaction has committed.
      invalidateGlobe();
      return got;
    }
    valleyId = await rolloverValley(db, valleyId);
  }
  throw new HttpError(500, 'plot assignment failed');
}

// ---------------------------------------------------------------------------
// Viewport markers + scout
// ---------------------------------------------------------------------------

/** Per-viewer half of a marker — NEVER stored in the shared valley snapshot. */
interface ViewerOverlay {
  isMe: boolean;
  /** Server truth for the attack gate — since D-099 the KEEP-asymmetry predicate
   * (`pvpAttackAllowed`, the same call createRaid makes), not a trophy window.
   * THE WIRE NAME IS KEPT FOR ONE RELEASE so a deployed client keeps reading it
   * through the rolling deploy; rename to `attackable` next release. */
  inWindow: boolean;
  /** This player raided you within RAID_RULES.revengeLockHours and it resolved. */
  revenge: boolean;
}

export type MapPlayerMarker = { kind: 'player'; baseId?: string } & RosterRow & ViewerOverlay;
/** Minimal public deed identity. Never widen this by spreading RosterRow: that
 * would also disclose wallet, shield, loot, presence and raid-state fields. */
export interface MapSilhouetteMarker {
  kind: 'silhouette'; x: number; y: number; earthCell: number; keepLevel: number; trophies: number;
  name: string;
  avatarUrl: string | null;
  /** Viewer-relative ownership only; never an owner identifier. Present only in
   * the explicit parcel-band projection. */
  isMe?: true;
}
export type MapCampMarker = { kind: 'pve' } & CampRow;
export type MapMarker = MapPlayerMarker | MapSilhouetteMarker | MapCampMarker;
export type MapRecommendedTarget = string | { wallet: string; baseId: string };

/** D-040's complete bulk identity contract. This is deliberately a separate
 * type from MapSilhouetteMarker so local coordinates, trophies and viewer state
 * cannot leak into the multi-valley Earth viewport through an object spread. */
export interface ViewportParcelMarker {
  earthCell: number;
  name: string;
  avatarUrl: string | null;
  keepLevel: number;
}

/**
 * GET /globe/parcels. `markers` is at most GLOBE.parcelViewportMaxMarkers of the
 * `matched` bases the rect holds, nearest the request centre first; when the two
 * differ `truncated` says so, so the client can tell the player "1,024 of 2,300"
 * rather than draw a window that looks complete and is not (D-097).
 */
export interface ViewportParcels {
  scope: EarthViewportRect;
  markers: ViewportParcelMarker[];
  truncated: boolean;
  matched: number;
}

export interface EarthViewportRect {
  /** Fine-grid columns, inclusive. x0 > x1 means the box crosses ±180°. */
  x0: number;
  x1: number;
  /** Fine-grid rows, inclusive, north to south. y0 must be <= y1. */
  y0: number;
  y1: number;
}

/** One indexed `plots_earth_cell_uq` interval per fine-grid row (two per row
 * across the antimeridian). Keeping x/y logic here gives both validation tests
 * and the SQL query one definition of the wrapped bbox. */
export function earthViewportCellRanges(
  rect: EarthViewportRect,
): Array<{ min: number; max: number }> {
  const { x0, x1, y0, y1 } = rect;
  const width = x0 <= x1 ? x1 - x0 + 1 : GLOBE.fineCols - x0 + x1 + 1;
  const height = y1 - y0 + 1;
  if (![x0, x1, y0, y1].every(Number.isInteger)
    || x0 < 0 || x0 >= GLOBE.fineCols || x1 < 0 || x1 >= GLOBE.fineCols
    || y0 < 0 || y1 >= GLOBE.fineRows || height < 1
    || width > GLOBE.parcelViewportMaxSpanCells
    || height > GLOBE.parcelViewportMaxSpanCells
    || width * height > GLOBE.parcelViewportMaxCells) {
    throw new RangeError('invalid or oversized Earth parcel viewport');
  }

  const ranges: Array<{ min: number; max: number }> = [];
  for (let y = y0; y <= y1; y++) {
    const row = y * GLOBE.fineCols;
    if (x0 <= x1) ranges.push({ min: row + x0, max: row + x1 });
    else {
      ranges.push({ min: row + x0, max: row + GLOBE.fineCols - 1 });
      ranges.push({ min: row, max: row + x1 });
    }
  }
  return ranges;
}

/**
 * Where a viewport's markers are ranked from when the client sends no centre
 * (D-097): the rect's own middle, in degrees, on the same 0.5° grid
 * `fineCellCentreDeg` reads — a one-cell rect ranks from that cell's centre.
 * Wraps across ±180° exactly as `earthViewportCellRanges` does, so a box on the
 * antimeridian ranks from the middle of the box, not from the far side of the
 * planet.
 */
export function earthViewportCentreDeg(rect: EarthViewportRect): LonLat {
  const { x0, x1, y0, y1 } = rect;
  const width = x0 <= x1 ? x1 - x0 + 1 : GLOBE.fineCols - x0 + x1 + 1;
  const col = (x0 + width / 2) % GLOBE.fineCols;
  const row = (y0 + y1 + 1) / 2;
  return { lon: -180 + col * (360 / GLOBE.fineCols), lat: 90 - row * (180 / GLOBE.fineRows) };
}

/**
 * All eligible deed identities in one bounded Earth viewport, across valleys —
 * the nearest GLOBE.parcelViewportMaxMarkers of them to `centre` (the rect's own
 * middle when the client sends none).
 *
 * Every range is an inclusive slice of the existing unique btree on
 * `plots.earth_cell`; there is no modulo/filter scan and no schema change. The
 * stable D-040 predicate is repeated at this public boundary on purpose: a plot
 * row alone is not proof of a public deed, and another planet's mask-relative
 * cell number must never appear on Earth.
 *
 * THE CAP IS A CUT, NOT A FILTER (D-097, owner 2026-09-02). D-042 bounds the RECT
 * at 4,096 cells, which with 59k minted bases is 4,096 markers — four times what
 * a phone draws in a frame. So the rows are ranked by distance from the viewer's
 * centre and cut at the cap, and the answer says both that it cut (`truncated`)
 * and what the rect really holds (`matched`). The rank is a pure function of the
 * set — distance ascending, lowest cell on a tie — never of row order, so a reload
 * of an unchanged window cannot swap markers in and out at the cap's edge. The
 * seam's great-circle distance is used as is: it already wraps the antimeridian,
 * and a second formula would be one more way for the server and client to
 * disagree about "near". The SQL LIMIT stays at the rect's cell bound —
 * `earth_cell` is unique, so a rect can never hold more qualifying rows than
 * cells — which is what makes `matched` exact rather than "at least".
 */
export async function getViewportParcels(
  db: Db, rect: EarthViewportRect, centre: LonLat | null = null,
): Promise<ViewportParcels> {
  const ranges = earthViewportCellRanges(rect);
  const inViewport = or(...ranges.map(({ min, max }) => and(
    gte(plots.earthCell, min), lte(plots.earthCell, max),
  )));
  const scope = { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
  if (!inViewport) return { scope, markers: [], truncated: false, matched: 0 };

  const rows = await db.select({
    earthCell: plots.earthCell,
    name: players.name,
    avatarHash: players.avatarHash,
    avatarGeneration: players.avatarGeneration,
    keepLevel: bases.keepLevel,
  }).from(plots)
    .innerJoin(valleys, eq(valleys.id, plots.valleyId))
    .innerJoin(bases, eq(bases.id, plots.baseId))
    .innerJoin(baseSlots, eq(baseSlots.baseId, bases.id))
    .innerJoin(players, eq(players.wallet, bases.ownerWallet))
    .where(and(
      eq(valleys.planetId, 0),
      eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
      eq(baseSlots.active, true), eq(baseSlots.wallet, bases.ownerWallet),
      inViewport,
    ))
    .orderBy(asc(plots.earthCell))
    .limit(GLOBE.parcelViewportMaxCells);

  const geo = globeGeo();
  const from = centre ?? earthViewportCentreDeg(rect);
  const kept = rows
    .filter((row): row is typeof row & { earthCell: number } => row.earthCell !== null)
    .map((row) => {
      const at = geo.fineCellCentreDeg(row.earthCell);
      return { row, km: geo.greatCircleKm(from.lon, from.lat, at.lon, at.lat) };
    })
    .sort((a, b) => a.km - b.km || a.row.earthCell - b.row.earthCell)
    .slice(0, GLOBE.parcelViewportMaxMarkers);

  return {
    scope,
    markers: kept.map(({ row }) => ({
      earthCell: row.earthCell,
      name: row.name,
      avatarUrl: row.avatarHash && row.avatarGeneration
        ? `/api/avatars/${row.avatarGeneration}.webp`
        : null,
      keepLevel: row.keepLevel,
    })),
    truncated: kept.length < rows.length,
    matched: rows.length,
  };
}

/**
 * GET /map's body. Explicitly typed (not inferred) because there are now two
 * ways out of getMapChunk — your own valley and a read-only visit — and they
 * must be the SAME shape, or every client branch becomes a shape sniff.
 *
 * THIS IS ALSO THE GLOBE'S PARCEL BAND (P6, docs/LAND-DEED-ONBOARDING-PLAN.md).
 * Below GLOBE.localZoom the globe draws one pin per OCCUPIED PARCEL inside one
 * valley, and that data is already here — no new endpoint and no new query:
 *
 *  - ONE ENTRY PER OCCUPIED PARCEL. `MapQuery`'s rect DEFAULTS to the whole
 *    25×20 grid (game/routes.ts), and every occupied plot in the rect yields
 *    exactly one marker — `kind: 'player'` if this viewer earned the identity,
 *    `kind: 'silhouette'` otherwise. `kind: 'pve'` markers are CAMPS, not
 *    parcels; the band must skip them.
 *  - THE PARCEL ADDRESS IS `earthCell`, read directly from `plots.earth_cell` —
 *    the same frozen value the deed's Tile trait names. `(x, y)` remains its local
 *    valley coordinate. The browser must never reconstruct the frozen address
 *    from a seated display lon/lat; display coordinates are not identity.
 *  - PARCEL IDENTITY IS MINIMAL. The owner superseded anonymous parcel shapes on
 *    2026-08-13: every authoritative deed parcel may carry its chosen name and
 *    opaque avatar URL. It still carries no wallet, shield/loot/presence fields,
 *    camp ids or action state. Pinned by test/parcel-band.test.ts.
 */
export interface MapChunk {
  valleyId: string;
  valleyName: string;
  warzoneActive: boolean;
  markers: MapMarker[];
  /** Legacy servers return wallet strings. Stable mode names the exact base so
   * two deeds held by one wallet cannot collapse into the same attack target. */
  recommended: MapRecommendedTarget[];
  /** true = you are LOOKING AT someone else's valley: minimal deed identity,
   * frozen parcel addresses and a valley name. Exact loot/shield/action state is
   * available only through the separately metered single-cell detail read; there
   * are still no wallets, presence fields or camp ids in this bulk payload. */
  visiting: boolean;
}

// ---------------------------------------------------------------------------
// Explicit parcel inspection
// ---------------------------------------------------------------------------

/** Why a preview action is unavailable. `keep_too_far_below` replaced
 * `outside_trophy_window` (D-099): the web keeps the old code in its switch for
 * one release so a client ahead of the API still reads the old server. */
export type ParcelActionBlock =
  | 'self'
  | 'keep_too_far_below'
  | 'shielded'
  | 'temporarily_unavailable';

export interface ParcelDetail {
  parcel: {
    earthCell: number;
    x: number;
    y: number;
    valleyId: string;
    valleyName: string;
    siteId: number;
    planetId: number;
    country: { a3: string; name: string } | null;
  };
  player: {
    wallet: string;
    name: string;
    avatarUrl: string | null;
    clanTag: string | null;
    seeker: boolean;
    keepLevel: number;
    trophies: number;
  };
  deed: {
    assetId: string | null;
    status: 'minted' | 'minting' | 'pending';
    metadata: DeedMetadata;
  };
  base: {
    /** Stable identity required to scout/attack one of several bases owned by a wallet. */
    id?: string;
    completedStructures: number;
    defenses: number;
    walls: number;
    landWidth: number;
  };
  shielded: boolean;
  shield: {
    active: boolean;
    source: 'loss' | 'purchase' | 'warzone' | null;
    expiresAt: Date | null;
    remainingMs: number;
    suppressedByWarzone: boolean;
  };
  /** The next instant at which warzone rules can change this selected deed's
   * effective protection/actions. Client refreshes the authoritative detail at
   * this boundary instead of guessing from its own clock. */
  warzone: {
    active: boolean;
    boundaryAt: Date | null;
    remainingMs: number | null;
  };
  actions: {
    /** Scouting is refused only for self (and cross-tier, which 404s before this
     * DTO exists) — never for a shield (D-099: "everyone can scout everyone"). */
    scout: { allowed: boolean; blockedBy: Extract<ParcelActionBlock, 'self'> | null };
    attack: {
      allowed: boolean;
      blockedBy: ParcelActionBlock | null;
      /** The two Keep levels the gate compared and the bar it applied, so the
       * client can say "L3 vs your L11" without a second rule of its own. */
      keepReach: { attackerKeep: number; defenderKeep: number; minDefenderKeep: number };
    };
  };
  /** Per-star approximate ranges for combined balance + physical-Mine loot.
   * Private components and the defender's exact balance never cross this boundary. */
  availableLootRanges: {
    oneStar: { min: string; max: string };
    twoStars: { min: string; max: string };
    threeStars: { min: string; max: string };
  };
}

interface ParcelTargetRow {
  baseId: string | null;
  earthCell: number | null;
  x: number | null;
  y: number | null;
  valleyId: string | null;
  valleyName: string | null;
  siteId: number | null;
  planetId: number | null;
  countryA3: string | null;
  countryName: string | null;
  wallet: string;
  name: string;
  avatarHash: string | null;
  avatarGeneration: string | null;
  avatarUpdatedAt: Date | null;
  clanTag: string | null;
  seeker: boolean;
  keepLevel: number;
  trophies: number;
  expansions: number;
  entryPaidAt: Date | null;
  deedAssetId: string | null;
  deedMintingAt: Date | null;
  lastSeenAt: Date | null;
}

export function availableParcelLootRanges(
  balanceLootPool: bigint, mineLoot: bigint, vaultLevels: readonly number[],
): ParcelDetail['availableLootRanges'] {
  if (balanceLootPool < 0n || mineLoot < 0n
    || vaultLevels.some((level) => !Number.isInteger(level) || level < 1)) {
    throw new RangeError('loot preview inputs cannot be negative');
  }
  const range = (stars: 1 | 2 | 3) => {
    const starPrize = balanceLootPool * BigInt(LOOT.starPayoutBps[stars]) / 10_000n;
    // D-065: the best standing Vault shields part of the pool; breaking every
    // Vault exposes all of it. Mine buffers are all-or-nothing per destroyed
    // physical Mine, so the safe combined preview spans "every Vault stands,
    // no Mine falls" through "everything falls".
    const minimumExposure = vaultExposureBps(vaultLevels.reduce((best, level) => Math.max(best, level), 0));
    const minimum = starPrize * BigInt(minimumExposure) / 10_000n;
    const maximum = starPrize + mineLoot;
    return {
      min: approximateLootRange(minimum).min,
      max: approximateLootRange(maximum).max,
    };
  };
  return { oneStar: range(1), twoStars: range(2), threeStars: range(3) };
}

/**
 * One deliberate disclosure for one frozen parcel address.
 *
 * Bulk `/globe` and `/globe/sector` stay aggregate-only. Foreign `/map` exposes
 * only the owner-approved public name and opaque avatar for each valid deed.
 * This lookup is reachable only through the authenticated + land-owned,
 * rate-limited route and only after a player explicitly selects one `earthCell`.
 * It returns enough public game state to decide whether to scout/attack, including
 * the selected deed's effective protection clock, but no presence timestamp, raw
 * balance, army or base layout.
 */
async function readOccupiedParcelDetail(
  db: Db, viewer: string, earthCell: number | null, now = new Date(), viewerBaseId?: string,
  _avatarPublicBaseUrl?: string, targetBaseId?: string,
): Promise<Omit<ParcelDetail, 'parcel'> & { parcel: ParcelDetail['parcel'] | null }> {
  if (earthCell === null && !targetBaseId) throw new HttpError(404, 'parcel not found');
  const stable = multiBaseEnabled();
  const selectedViewerBase = stable
    ? await resolveActiveBase(db, viewer, viewerBaseId)
    : null;
  const viewerRead = stable && selectedViewerBase
    ? db.select({
      entryPaidAt: bases.landPaidAt,
      keepLevel: bases.keepLevel,
      trophies: sql<number>`coalesce(${baseProfiles.trophies}, 0)::int`,
    }).from(bases)
      .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
      .where(eq(bases.id, selectedViewerBase.base.id))
      .then((rows) => rows[0])
    : db.select({
      entryPaidAt: players.entryPaidAt,
      keepLevel: players.keepLevel,
      trophies: players.trophies,
    }).from(players).where(eq(players.wallet, viewer)).then((rows) => rows[0]);
  const targetRead = stable
    ? db.select({
      baseId: bases.id,
      earthCell: plots.earthCell,
      x: plots.x,
      y: plots.y,
      valleyId: valleys.id,
      valleyName: valleys.name,
      siteId: valleys.siteId,
      planetId: valleys.planetId,
      countryA3: plots.countryA3,
      countryName: earthCountries.name,
      wallet: players.wallet,
      name: players.name,
      avatarHash: players.avatarHash,
      avatarGeneration: players.avatarGeneration,
      avatarUpdatedAt: players.avatarUpdatedAt,
      clanTag: clans.tag,
      seeker: players.seekerVerified,
      keepLevel: bases.keepLevel,
      trophies: sql<number>`coalesce(${baseProfiles.trophies}, 0)::int`,
      expansions: bases.expansions,
      entryPaidAt: bases.landPaidAt,
      deedAssetId: bases.deedAssetId,
      deedMintingAt: bases.deedMintingAt,
      lastSeenAt: players.lastSeenAt,
    }).from(bases)
      .leftJoin(plots, eq(bases.id, plots.baseId))
      .innerJoin(baseSlots, eq(baseSlots.baseId, bases.id))
      .innerJoin(players, eq(players.wallet, bases.ownerWallet))
      .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
      .leftJoin(valleys, eq(valleys.id, plots.valleyId))
      .leftJoin(earthCountries, eq(earthCountries.a3, plots.countryA3))
      .leftJoin(clanMembers, eq(clanMembers.playerWallet, players.wallet))
      .leftJoin(clans, eq(clans.id, clanMembers.clanId))
      .where(and(
        targetBaseId ? eq(bases.id, targetBaseId) : eq(plots.earthCell, earthCell!),
        eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
        eq(baseSlots.active, true), eq(baseSlots.wallet, bases.ownerWallet),
      )).limit(1)
      .then((rows) => rows[0] as ParcelTargetRow | undefined)
    : db.select({
      baseId: plots.baseId,
      earthCell: plots.earthCell,
      x: plots.x,
      y: plots.y,
      valleyId: valleys.id,
      valleyName: valleys.name,
      siteId: valleys.siteId,
      planetId: valleys.planetId,
      countryA3: plots.countryA3,
      countryName: earthCountries.name,
      wallet: players.wallet,
      name: players.name,
      avatarHash: players.avatarHash,
      avatarGeneration: players.avatarGeneration,
      avatarUpdatedAt: players.avatarUpdatedAt,
      clanTag: clans.tag,
      seeker: players.seekerVerified,
      keepLevel: players.keepLevel,
      trophies: players.trophies,
      expansions: players.expansions,
      entryPaidAt: players.entryPaidAt,
      deedAssetId: players.deedAssetId,
      deedMintingAt: players.deedMintingAt,
      lastSeenAt: players.lastSeenAt,
    }).from(plots)
      .innerJoin(players, eq(players.wallet, plots.playerWallet))
      .innerJoin(valleys, eq(valleys.id, plots.valleyId))
      .leftJoin(earthCountries, eq(earthCountries.a3, plots.countryA3))
      .leftJoin(clanMembers, eq(clanMembers.playerWallet, players.wallet))
      .leftJoin(clans, eq(clans.id, clanMembers.clanId))
      .where(and(eq(plots.earthCell, earthCell!), isNotNull(players.entryPaidAt))).limit(1)
      .then((rows) => rows[0] as ParcelTargetRow | undefined);
  const [me, target] = await Promise.all([
    viewerRead,
    targetRead,
  ]);

  // A direct function call receives the same partition protection as the route.
  // Unknown, unpaid and cross-tier targets are one indistinguishable 404 so this
  // endpoint cannot become an existence oracle for plotless free accounts.
  if (!me || !target || !sameLandTier(me, target) || target.entryPaidAt === null) {
    throw new HttpError(404, 'parcel not found');
  }

  const currentWarzone = warzoneStatus(await getGameConfig(db), now);
  const warzoneActive = currentWarzone.active;
  const dayStart = new Date(`${utcDay(now)}T00:00:00Z`);
  const warzoneSince = new Date(now.getTime() - WARZONE.attackCooldownHours * 3_600_000);

  const [
    metadata, completed, shardAccounts, mineAccrued, shield, cooldownRows, activeRaidLock,
    outgoingRaid,
  ] = await Promise.all([
    buildDeedMetadata(db, target.wallet, undefined, target.baseId ?? undefined),
    stable && target.baseId ? db.execute(sql`
      SELECT b.type, b.level FROM buildings b
      WHERE b.base_id = ${target.baseId}
        AND NOT EXISTS (
          SELECT 1 FROM builder_jobs j
          WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
            AND j.finishes_at > ${now.toISOString()}::timestamptz
        )
    `) as unknown as Promise<Array<{ type: string; level: number }>> : db.execute(sql`
      SELECT b.type, b.level FROM buildings b
      WHERE b.player_wallet = ${target.wallet}
        AND NOT EXISTS (
          SELECT 1 FROM builder_jobs j
          WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
            AND j.finishes_at > ${now.toISOString()}::timestamptz
        )
    `) as unknown as Promise<Array<{ type: string; level: number }>>,
    stable && target.baseId
      ? db.select({ kind: accounts.kind, balance: accounts.balance }).from(accounts)
        .where(and(
          eq(accounts.baseId, target.baseId),
          inArray(accounts.kind, ['base_shards', 'base_forge_escrow']),
        ))
      : db.select({ kind: accounts.kind, balance: accounts.balance }).from(accounts)
        .where(and(eq(accounts.ownerWallet, target.wallet), eq(accounts.kind, 'player_shards'))),
    stable && target.baseId
      ? getBaseMineAccruedForPreview(db, target.baseId, now)
      : Promise.resolve(0n),
    getEffectiveShieldStatus(db, target.wallet, now, warzoneActive,
      stable ? target.baseId ?? undefined : undefined),
    warzoneActive
      ? db.select({ id: raids.id }).from(raids).where(and(
        stable && target.baseId ? eq(raids.defenderBaseId, target.baseId) : eq(raids.defenderWallet, target.wallet),
        gte(raids.createdAt, warzoneSince),
      )).limit(1)
      : db.select({ id: raids.id }).from(raids).where(and(
        stable && selectedViewerBase
          ? eq(raids.attackerBaseId, selectedViewerBase.base.id)
          : eq(raids.attackerWallet, viewer),
        stable && target.baseId ? eq(raids.defenderBaseId, target.baseId) : eq(raids.defenderWallet, target.wallet),
        gte(raids.createdAt, dayStart),
      )).limit(1),
    stable && target.baseId
      ? db.select({ raidId: baseRaidLocks.raidId }).from(baseRaidLocks)
        .where(eq(baseRaidLocks.baseId, target.baseId)).limit(1)
      : Promise.resolve([]),
    db.select({ id: raids.id }).from(raids).where(and(
      stable && target.baseId
        ? eq(raids.attackerBaseId, target.baseId)
        : eq(raids.attackerWallet, target.wallet),
      inArray(raids.status, ['pending_orders', 'resolving']),
    )).limit(1),
  ]);

  // A paid plot must produce metadata; failing loud is safer than returning a
  // hand-built second version of deed traits that could disagree with the NFT.
  if (!metadata) throw new HttpError(404, 'parcel not found');

  const liquid = shardAccounts.find((account) => account.kind === 'base_shards')?.balance
    ?? shardAccounts.find((account) => account.kind === 'player_shards')?.balance
    ?? 0n;
  const forge = shardAccounts.find((account) => account.kind === 'base_forge_escrow')?.balance ?? 0n;
  const balanceLootPool = (liquid + forge) * BigInt(LOOT.balanceLootableBps) / 10_000n;
  const claim = claimRect(target.expansions);
  const isSelf = target.wallet === viewer;
  // EXACT mirror of createRaid's Keep gate (D-099) — the same shared predicate,
  // fed the same two columns, so the preview can never offer an attack the raid
  // refuses. Trophies are shown, not judged.
  const keepReach = {
    attackerKeep: me.keepLevel,
    defenderKeep: target.keepLevel,
    minDefenderKeep: pvpMinDefenderKeep(me.keepLevel),
  };
  const keepAllowed = pvpAttackAllowed(me.keepLevel, target.keepLevel);
  // Online/logoff protection was retired with live defender spectating. A base
  // is unavailable only for an actual cooldown/shield/active raid lock, never
  // merely because its owner currently has the game open.
  const temporarilyUnavailable = cooldownRows.length > 0
    || activeRaidLock.length > 0
    || outgoingRaid.length > 0;
  const shielded = shield.active;

  // Scouting is ungated by shields (D-099: "everyone can scout everyone … only
  // attacks should" be gated) — a scout refused by a shield teaches nothing.
  const scoutBlockedBy = isSelf ? 'self' : null;
  // The order is the order a player can act on: the Keep rule is permanent
  // (until somebody upgrades), a shield expires, a cooldown expires sooner.
  const attackBlockedBy: ParcelActionBlock | null = isSelf
    ? 'self'
    : !keepAllowed
      ? 'keep_too_far_below'
      : shielded
        ? 'shielded'
        : temporarilyUnavailable
          ? 'temporarily_unavailable'
          : null;

  const defenseTypes = new Set<string>(Object.keys(DEFENSES));
  const vaultLevels = completed
    .filter((building) => building.type === BuildingType.Vault)
    .map((building) => building.level);
  return {
    parcel: target.earthCell !== null && target.x !== null && target.y !== null
      && target.valleyId !== null && target.valleyName !== null && target.siteId !== null && target.planetId !== null ? {
      earthCell: target.earthCell,
      x: target.x,
      y: target.y,
      valleyId: target.valleyId,
      valleyName: target.valleyName,
      siteId: target.siteId,
      planetId: target.planetId,
      country: target.countryName === null || target.countryA3 === null
        ? null
        : { a3: target.countryA3, name: target.countryName },
    } : null,
    player: {
      wallet: target.wallet,
      name: target.name,
      avatarUrl: /^[0-9a-f]{64}$/.test(target.avatarHash ?? '')
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target.avatarGeneration ?? '')
        ? `/api/avatars/${target.avatarGeneration}.webp`
        : null,
      clanTag: target.clanTag,
      seeker: target.seeker,
      keepLevel: target.keepLevel,
      trophies: target.trophies,
    },
    deed: {
      assetId: target.deedAssetId,
      status: target.deedAssetId !== null
        ? 'minted'
        : target.deedMintingAt !== null ? 'minting' : 'pending',
      metadata,
    },
    base: {
      ...(stable && target.baseId ? { id: target.baseId } : {}),
      completedStructures: completed.length,
      defenses: completed.filter((b) => defenseTypes.has(b.type)).length,
      walls: completed.filter((b) => b.type === BuildingType.Wall).length,
      landWidth: claim.max - claim.min,
    },
    shield,
    shielded,
    warzone: {
      active: currentWarzone.active,
      boundaryAt: currentWarzone.active
        ? currentWarzone.endsAt
        : currentWarzone.mode === 'scheduled'
          ? currentWarzone.startsAt ?? currentWarzone.nextStartsAt
          : null,
      remainingMs: currentWarzone.remainingMs,
    },
    actions: {
      scout: { allowed: scoutBlockedBy === null, blockedBy: scoutBlockedBy },
      attack: { allowed: attackBlockedBy === null, blockedBy: attackBlockedBy, keepReach },
    },
    availableLootRanges: availableParcelLootRanges(balanceLootPool, mineAccrued, vaultLevels),
  };
}

/** Legacy inspection keeps its exact address contract while native readers use
 * the same authoritative disclosure rules without constructing Earth fields. */
export async function getParcelDetail(
  db: Db, viewer: string, earthCell: number, now = new Date(), viewerBaseId?: string,
  avatarPublicBaseUrl?: string,
): Promise<ParcelDetail> {
  const detail = await readOccupiedParcelDetail(db, viewer, earthCell, now, viewerBaseId, avatarPublicBaseUrl);
  if (!detail.parcel) throw new HttpError(404, 'parcel not found');
  return { ...detail, parcel: detail.parcel };
}

/** Native parcel identity wraps the existing disclosure/attack rules, with no
 * public Earth history or fabricated Earth coordinates. The persisted resolver
 * proves the requested tile belongs to the selected target before disclosure. */
export async function getFantasyOccupiedParcelDetail(
  db: Db, viewer: string, tileId: number, targetBaseId: string, now = new Date(), viewerBaseId?: string,
): Promise<Omit<ParcelDetail, 'parcel'>> {
  const location = await resolveFantasyLocation(db, targetBaseId);
  if (!location || location.tileId !== tileId) throw new HttpError(404, 'parcel not found');
  if (!multiBaseEnabled()) throw new HttpError(503, 'Fantasy land requires stable base identity');
  const { parcel: legacyPrivateBinding, ...detail } = await readOccupiedParcelDetail(
    db, viewer, null, now, viewerBaseId, undefined, targetBaseId,
  );
  void legacyPrivateBinding;
  return detail;
}

/**
 * A read-only visit to a valley that is not yours: every authoritative occupied
 * plot with minimal public profile identity, plus the valley's name.
 *
 * Deliberately NOT a filtered version of the normal path — a separate, tiny
 * function, so "did a wallet leak into a visit?" is answered by reading eight
 * lines rather than by auditing the promotion/ranking pipeline below. Camps are
 * omitted on purpose: createPveRaid does not check that a camp is in the
 * attacker's valley, so shipping foreign camp ids WOULD be an attack affordance.
 */
function visitValley(
  snap: ValleySnapshot,
  rect: { x0: number; y0: number; x1: number; y1: number },
  warzoneActive: boolean,
): MapChunk {
  const markers: MapMarker[] = [];
  for (const r of snap.players) {
    if (r.x < rect.x0 || r.x > rect.x1 || r.y < rect.y0 || r.y > rect.y1) continue;
    markers.push({
      kind: 'silhouette', x: r.x, y: r.y, earthCell: r.earthCell,
      keepLevel: r.keepLevel, trophies: r.trophies,
      name: r.name, avatarUrl: r.avatarUrl,
    });
  }
  return {
    valleyId: snap.valleyId,
    valleyName: snap.valleyName,
    warzoneActive,
    markers,
    recommended: [],
    visiting: true,
  };
}

/** The globe parcel band is intentionally narrower than the local tactical map.
 * Even when the named valley is the viewer's own, it may receive only the public
 * deed identity tuple (plus a viewer-relative ownership bit). In particular this
 * must never reuse `full()` below, whose RosterRow spread contains wallet,
 * presence, shield, loot-tease and raid-state fields. */
function parcelBandValley(
  snap: ValleySnapshot,
  rect: { x0: number; y0: number; x1: number; y1: number },
  warzoneActive: boolean,
  viewer: string,
): MapChunk {
  const markers: MapMarker[] = [];
  let ownsValley = false;
  for (const r of snap.players) {
    const isMe = r.wallet === viewer;
    ownsValley ||= isMe;
    if (r.x < rect.x0 || r.x > rect.x1 || r.y < rect.y0 || r.y > rect.y1) continue;
    markers.push({
      kind: 'silhouette', x: r.x, y: r.y, earthCell: r.earthCell,
      keepLevel: r.keepLevel, trophies: r.trophies,
      name: r.name, avatarUrl: r.avatarUrl,
      ...(isMe ? { isMe: true as const } : {}),
    });
  }
  return {
    valleyId: snap.valleyId,
    valleyName: snap.valleyName,
    warzoneActive,
    markers,
    recommended: [],
    visiting: !ownsValley,
  };
}

/**
 * Load everything about a valley that does NOT depend on who is looking, in a
 * fixed number of set-based queries (5) regardless of population. This replaced a
 * per-marker loop that issued a shields SELECT + getOrCreatePlayerAccount — the
 * latter an INSERT on a GET, i.e. a write to the ledger table on a read path.
 * A missing accounts row now simply means balance 0, which is exactly right for
 * surplusTease; every path that actually needs the row still creates it itself.
 */
async function loadValleySnapshot(
  db: Db, valleyId: string, warzoneActive: boolean, now: Date,
): Promise<ValleySnapshot> {
  const [valley] = await db.select({ name: valleys.name }).from(valleys).where(eq(valleys.id, valleyId));
  const stable = multiBaseEnabled();
  const roster = stable ? await db
    .select({
      baseId: bases.id,
      x: plots.x, y: plots.y, earthCell: plots.earthCell,
      wallet: players.wallet, name: players.name,
      avatarHash: players.avatarHash, avatarGeneration: players.avatarGeneration,
      keepLevel: bases.keepLevel,
      trophies: sql<number>`coalesce(${baseProfiles.trophies}, 0)::int`,
      lastSeenAt: players.lastSeenAt, clanTag: clans.tag,
      seeker: players.seekerVerified,
    })
    .from(plots)
    .innerJoin(bases, eq(bases.id, plots.baseId))
    .innerJoin(baseSlots, eq(baseSlots.baseId, bases.id))
    .innerJoin(players, eq(players.wallet, bases.ownerWallet))
    .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
    .leftJoin(clanMembers, eq(clanMembers.playerWallet, players.wallet))
    .leftJoin(clans, eq(clans.id, clanMembers.clanId))
    .where(and(
      eq(plots.valleyId, valleyId),
      eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
      eq(baseSlots.active, true), eq(baseSlots.wallet, bases.ownerWallet),
    )) : await db
    .select({
      baseId: plots.baseId,
      x: plots.x, y: plots.y, earthCell: plots.earthCell,
      wallet: players.wallet, name: players.name,
      avatarHash: players.avatarHash, avatarGeneration: players.avatarGeneration,
      keepLevel: players.keepLevel, trophies: players.trophies,
      lastSeenAt: players.lastSeenAt, clanTag: clans.tag,
      // Seeker badge (denormalized on players so this hot read needs no join).
      seeker: players.seekerVerified,
    })
    .from(plots)
    .innerJoin(players, eq(players.wallet, plots.playerWallet))
    .leftJoin(clanMembers, eq(clanMembers.playerWallet, players.wallet))
    .leftJoin(clans, eq(clans.id, clanMembers.clanId))
    .where(and(eq(plots.valleyId, valleyId), isNotNull(players.entryPaidAt)));

  const wallets = [...new Set(roster.map((r) => r.wallet))];
  const baseIds = stable
    ? roster.flatMap((r) => r.baseId === null ? [] : [r.baseId])
    : [];
  const shieldedSet = new Set<string>();
  const balances = new Map<string, bigint>();
  const burningSet = new Set<string>();
  if (wallets.length > 0) {
    // #46/#49: during a warzone a base shows attackable UNLESS it holds a paid
    // warzone-source shield (loss-shields are suppressed) — matching the raid gate.
    // NB: reports the CURRENT window only; never reveals a future/upcoming purge start.
    if (stable && baseIds.length > 0) {
      const sh = await db.select({ baseId: shields.baseId }).from(shields)
        .where(warzoneActive
          ? and(inArray(shields.baseId, baseIds), gt(shields.expiresAt, now), eq(shields.source, 'warzone'))
          : and(inArray(shields.baseId, baseIds), gt(shields.expiresAt, now)));
      sh.forEach((s) => { if (s.baseId) shieldedSet.add(s.baseId); });
    } else {
      const sh = await db.select({ wallet: shields.playerWallet }).from(shields)
        .where(warzoneActive
          ? and(inArray(shields.playerWallet, wallets), gt(shields.expiresAt, now), eq(shields.source, 'warzone'))
          : and(inArray(shields.playerWallet, wallets), gt(shields.expiresAt, now)));
      sh.forEach((s) => shieldedSet.add(s.wallet));
    }

    if (stable && baseIds.length > 0) {
      const accs = await db.select({ baseId: accounts.baseId, balance: accounts.balance })
        .from(accounts).where(and(
          inArray(accounts.baseId, baseIds),
          inArray(accounts.kind, ['base_shards', 'base_forge_escrow']),
        ));
      accs.forEach((account) => {
        if (account.baseId) {
          balances.set(account.baseId, (balances.get(account.baseId) ?? 0n) + account.balance);
        }
      });
      for (const baseId of baseIds) {
        balances.set(
          baseId,
          (balances.get(baseId) ?? 0n) * BigInt(LOOT.balanceLootableBps) / 10_000n,
        );
      }
      const mines = await db.select({
        baseId: buildings.baseId,
        accrued: mineAccrualStates.accruedShards,
      }).from(mineAccrualStates).innerJoin(
        buildings, eq(buildings.id, mineAccrualStates.mineBuildingId),
      ).where(inArray(buildings.baseId, baseIds));
      mines.forEach((mine) => {
        if (mine.baseId) {
          balances.set(mine.baseId, (balances.get(mine.baseId) ?? 0n) + mine.accrued);
        }
      });
    } else {
      const accs = await db.select({ wallet: accounts.ownerWallet, balance: accounts.balance })
        .from(accounts).where(and(
          inArray(accounts.ownerWallet, wallets), eq(accounts.kind, 'player_shards'),
        ));
      accs.forEach((account) => {
        if (account.wallet) {
          balances.set(
            account.wallet,
            account.balance * BigInt(LOOT.balanceLootableBps) / 10_000n,
          );
        }
      });
    }

    const burnSince = new Date(now.getTime() - WORLD.mapBurningHours * 3_600_000);
    if (stable && baseIds.length > 0) {
      const burnt = await db.selectDistinct({ baseId: raids.defenderBaseId }).from(raids)
        .where(and(inArray(raids.defenderBaseId, baseIds), gt(raids.createdAt, burnSince)));
      burnt.forEach((b) => { if (b.baseId) burningSet.add(b.baseId); });
    } else {
      const burnt = await db.selectDistinct({ wallet: raids.defenderWallet }).from(raids)
        .where(and(inArray(raids.defenderWallet, wallets), gt(raids.createdAt, burnSince)));
      burnt.forEach((b) => { if (b.wallet) burningSet.add(b.wallet); });
    }
  }

  const onlineSince = now.getTime() - WORLD.mapOnlineMin * 60_000;
  const players_: RosterRow[] = roster.filter((r): r is typeof r & { x: number; y: number; earthCell: number } =>
    r.x !== null && r.y !== null && r.earthCell !== null).map((r) => ({
    ...(stable && r.baseId ? { baseId: r.baseId } : {}),
    x: r.x, y: r.y, earthCell: r.earthCell, wallet: r.wallet, name: r.name,
    avatarUrl: r.avatarHash && r.avatarGeneration
      ? `/api/avatars/${r.avatarGeneration}.webp`
      : null,
    keepLevel: r.keepLevel, trophies: r.trophies,
    shielded: shieldedSet.has(stable ? r.baseId ?? '' : r.wallet),
    surplusTease: (balances.get(stable ? r.baseId ?? '' : r.wallet) ?? 0n)
      > BigInt(WORLD.surplusTeaseThreshold),
    clanTag: r.clanTag,
    seeker: r.seeker,
    online: r.lastSeenAt !== null && r.lastSeenAt.getTime() > onlineSince,
    burning: burningSet.has(stable ? r.baseId ?? '' : r.wallet),
  }));

  const campRows = await db.select().from(pveCamps).where(eq(pveCamps.valleyId, valleyId));
  const camps: CampRow[] = campRows.map((c) => ({
    id: c.id, x: c.x, y: c.y, tier: c.tier,
    cleared: c.respawnsAt !== null && c.respawnsAt > now,
    bounty: Number(c.lootKeep),
  }));

  return { valleyId, valleyName: valley?.name ?? 'THE VALLEY', players: players_, camps };
}

/**
 * Viewport markers for the world map (MAP-SCALE-PLAN S1/S3/S4).
 *
 * The response is bounded by MEANING, not by valley size: at most
 * WORLD.mapCandidateCap full markers (plus your own keep and your revenge
 * targets), everyone else as a minimal public deed silhouette. `inWindow` is computed
 * server-side with the SAME predicate as the raid gate (raids.ts), so the map
 * stops being a wall of un-attackable names and starts being a target list.
 */
export async function getMapChunk(
  db: Db, viewer: string,
  rect: {
    baseId?: string | undefined; valleyId?: string | undefined;
    parcelBand?: boolean | undefined;
    x0: number; y0: number; x1: number; y1: number;
  },
  now = new Date(),
): Promise<MapChunk> {
  const stable = multiBaseEnabled();
  // Selection is request-scoped. Slot 1 is activation capacity, not a global
  // server preference: every stable read resolves the exact client selection,
  // and omission is accepted only for a genuinely single-base wallet.
  const selectedBase = stable ? await resolveActiveBase(db, viewer, rect.baseId) : null;
  let valleyId = rect.valleyId;
  if (!valleyId) {
    if (stable) {
      if (!selectedBase) throw new HttpError(404, 'no active parcel found');
      const [home] = await db.select({ valleyId: plots.valleyId }).from(plots)
        .where(eq(plots.baseId, selectedBase.base.id));
      if (!home?.valleyId) throw new HttpError(409, 'Use the fantasy world map', 'WORLD_UPDATE_REQUIRED');
      valleyId = home.valleyId;
    } else {
      const assigned = await ensurePlotAssigned(db, viewer);
      valleyId = assigned.valleyId;
    }
  }

  const warzoneActive = isWarzoneActive(await getGameConfig(db), now);
  const snap = await getValleySnapshot(
    valleyId, warzoneActive,
    () => loadValleySnapshot(db, valleyId!, warzoneActive, now),
    now.getTime(),
  );

  // READ-ONLY VALLEY VISIT (WORLDMAP-GLOBE-PLAN owner decision 2, 2026-08-09).
  // The globe is explorable: you may zoom a distant valley and see its deeds and
  // public profile identities. A visitor gets name + opaque avatar, its FROZEN
  // earthCell and keep presentation: no wallet, shield/loot/presence, camp ids or
  // recommended list. A deliberate tap may resolve ONE cell through the separately
  // gated + metered detail route. Before this branch existed, `?valleyId=` served
  // a foreign valley exactly like your own — full markers with wallet + name for anyone inside the
  // trophy window, plus every camp id — so a client that walked valley ids had a
  // roster scraper (MAP-SCALE-PLAN L8's plot-id-walking concern, from the other
  // end). The live web client has never sent valleyId, so nothing regresses.
  //
  // A VISIT NEVER WRITES, AND NEVER SIGNS ANYONE UP. This branch used to settle
  // "is this my valley?" by calling ensurePlotAssigned — which, for a caller with
  // no plot, escalates a GET into the FOR UPDATE signup transaction that mints a
  // plot (and possibly a whole valley). So `?valleyId=` was an unauthenticated-
  // shaped write amplifier: cheap to fire, expensive to serve, and it took the
  // newest valley's row lock — the launch-day cliff — on a read path. Membership
  // is decided from the ROSTER WE ALREADY LOADED instead: if you are not on it and
  // you asked for a specific valley, you are a visitor. Consequence, stated so it
  // is a decision and not an accident: a player with no plot who explicitly passes
  // ?valleyId= gets the visitor view. Signup happens on the no-valleyId path above
  // (and on /map/me), which is the only path the client uses to arrive.
  const baseIdOf = (p: RosterRow): string | undefined =>
    (p as RosterRow & { baseId?: string }).baseId;
  const identityOf = (p: RosterRow): string => stable ? baseIdOf(p) ?? p.wallet : p.wallet;
  const mine = stable
    ? snap.players.find((p) => baseIdOf(p) === selectedBase?.base.id)
    : snap.players.find((p) => p.wallet === viewer);
  if (rect.parcelBand) return parcelBandValley(snap, rect, warzoneActive, viewer);
  if (!mine && rect.valleyId !== undefined) return visitValley(snap, rect, warzoneActive);

  // --- per-viewer overlay ---------------------------------------------------
  // Revenge: who resolved a raid on YOU inside RAID_RULES.revengeLockHours. A
  // badge and a sort key only — the Keep rule still applies, so a revenge
  // target you cannot legally hit renders honestly as out of reach.
  const revengeSince = new Date(now.getTime() - RAID_RULES.revengeLockHours * 3_600_000);
  // createdAt comes along so the promotion cap below can keep the FRESHEST
  // grudges rather than an arbitrary slice.
  const revengeRows = stable && selectedBase
    ? await db.select({ identity: raids.attackerBaseId, at: raids.createdAt }).from(raids)
      .where(and(
        eq(raids.defenderBaseId, selectedBase.base.id),
        isNotNull(raids.attackerBaseId),
        eq(raids.status, 'resolved'),
        gt(raids.createdAt, revengeSince),
      ))
    : await db.select({ identity: raids.attackerWallet, at: raids.createdAt }).from(raids)
      .where(and(
        eq(raids.defenderWallet, viewer),
        eq(raids.status, 'resolved'),
        gt(raids.createdAt, revengeSince),
      ));
  const revengeSet = new Set(revengeRows.flatMap((r) => r.identity ? [r.identity] : []));
  const revengeAt = new Map<string, number>();
  for (const r of revengeRows) {
    if (!r.identity) continue;
    const ms = r.at ? new Date(r.at).getTime() : 0;
    if (ms > (revengeAt.get(r.identity) ?? 0)) revengeAt.set(r.identity, ms);
  }

  // Trophies still ORDER the candidates below; the Keep level GATES them. The
  // selected stable base is the source of both while the flag is on, the wallet
  // row while it is off — the same columns createRaid reads.
  let myTrophies = mine?.trophies;
  let myKeepLevel = mine?.keepLevel ?? selectedBase?.base.keepLevel;
  if (myTrophies === undefined || myKeepLevel === undefined) {
    const [me] = await db.select({ trophies: players.trophies, keepLevel: players.keepLevel })
      .from(players).where(eq(players.wallet, viewer));
    myTrophies ??= me?.trophies ?? 0;
    myKeepLevel ??= me?.keepLevel ?? 1;
  }
  const viewerKeep = myKeepLevel;
  const viewerTrophies = myTrophies;
  // EXACT mirror of the attack gate in raids.ts (D-099) — one shared predicate,
  // two callers, so the map never names a target the raid will refuse.
  const attackableKeep = (keepLevel: number): boolean => pvpAttackAllowed(viewerKeep, keepLevel);

  const inRect = (p: { x: number; y: number }): boolean =>
    p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1;

  const full = (r: RosterRow): MapPlayerMarker => ({
    kind: 'player', ...r,
    isMe: r.wallet === viewer,
    inWindow: attackableKeep(r.keepLevel),
    revenge: revengeSet.has(identityOf(r)),
  });

  const markers: MapMarker[] = [];
  const promoted = new Set<string>();
  // Your own keep always ships in full, even when the viewport has panned off it —
  // the client's "home" affordance and centring depend on finding it.
  if (mine) { markers.push(full(mine)); promoted.add(identityOf(mine)); }
  // A wallet can own up to five bases in one valley. Keep every one visibly
  // self-owned and non-actionable, but add the selected one first so the web
  // client's existing `find(isMe)` home affordance centres the requested base.
  for (const owned of snap.players) {
    if (owned.wallet !== viewer || promoted.has(identityOf(owned))) continue;
    markers.push(full(owned));
    promoted.add(identityOf(owned));
  }
  // Revenge targets ship in full wherever they stand in the valley, so the WAR
  // ROOM can centre the camera on one that is currently off-screen — but CAPPED.
  // Uncapped, this loop scanned the whole valley and ignored the viewport, so a
  // player everyone had raided could pull 491 full markers (~128 KB) out of a
  // 1x1-tile request and defeat both bounding mechanisms at once (verification
  // 2026-07-29 P1). The cap is the WAR ROOM's own list length: more revenge
  // badges than that cannot be acted on in one sitting anyway. Most recent
  // grudge first, so the cap keeps the ones that still sting.
  const revengeRanked = snap.players
    .filter((r) => !promoted.has(identityOf(r)) && revengeSet.has(identityOf(r)))
    .sort((a, b) => (revengeAt.get(identityOf(b)) ?? 0) - (revengeAt.get(identityOf(a)) ?? 0)
      || identityOf(a).localeCompare(identityOf(b)))
    .slice(0, WORLD.recommendedTargets);
  for (const r of revengeRanked) {
    markers.push(full(r));
    promoted.add(identityOf(r));
  }

  // Rank the rest by expected value (MAP-SCALE-PLAN S3): a surplus first, then
  // actually attackable, then the bigger keep, then the closest rating.
  const candidates = snap.players
    .filter((r) => !promoted.has(identityOf(r)) && inRect(r) && attackableKeep(r.keepLevel))
    .sort((a, b) =>
      Number(b.surplusTease) - Number(a.surplusTease)
      || Number(a.shielded) - Number(b.shielded)
      || b.keepLevel - a.keepLevel
      || Math.abs(a.trophies - viewerTrophies) - Math.abs(b.trophies - viewerTrophies));
  for (const r of candidates.slice(0, WORLD.mapCandidateCap)) {
    markers.push(full(r));
    promoted.add(identityOf(r));
  }

  // Everyone else: a shape on the terrain. Keeps the valley legible (and the
  // land-override honest) without leaking who they are.
  for (const r of snap.players) {
    if (promoted.has(identityOf(r)) || !inRect(r)) continue;
    markers.push({
      kind: 'silhouette', x: r.x, y: r.y, earthCell: r.earthCell,
      keepLevel: r.keepLevel, trophies: r.trophies,
      name: r.name, avatarUrl: r.avatarUrl,
    });
  }

  for (const c of snap.camps) {
    if (inRect(c)) markers.push({ kind: 'pve', ...c });
  }

  // WAR ROOM shortlist: revenge first, then the ranked candidates. Shielded and
  // out-of-reach targets are excluded — this list exists to be tapped.
  const recommended: MapRecommendedTarget[] = [
    ...snap.players.filter((r) => revengeSet.has(identityOf(r)) && !r.shielded && attackableKeep(r.keepLevel)),
    ...candidates.filter((r) => !r.shielded),
  ].slice(0, WORLD.recommendedTargets).map((r) => stable && baseIdOf(r)
    ? { wallet: r.wallet, baseId: baseIdOf(r)! }
    : r.wallet);

  return { valleyId, valleyName: snap.valleyName, warzoneActive, markers, recommended, visiting: false };
}

/** Free 30s layout preview (GDD §3.4). Refused only for self and for a base on
 * the other side of the land line — NEVER for a shield or the Keep rule (D-099:
 * "everyone can scout everyone … only attacks should" be gated). Rate limits
 * stay on the route. */
export async function scoutBase(
  db: Db, viewer: string, target: string, now = new Date(), viewerBaseId?: string,
) {
  const stable = multiBaseEnabled();
  const selectedViewerBase = stable
    ? await resolveActiveBase(db, viewer, viewerBaseId)
    : null;
  const targetIsBaseId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(target);
  const stableTargets = stable ? await db.select({
    baseId: bases.id,
    wallet: players.wallet,
    name: players.name,
    keepLevel: bases.keepLevel,
    expansions: bases.expansions,
    entryPaidAt: bases.landPaidAt,
    trophies: sql<number>`coalesce(${baseProfiles.trophies}, 0)::int`,
  }).from(bases)
    .innerJoin(baseSlots, eq(baseSlots.baseId, bases.id))
    .innerJoin(players, eq(players.wallet, bases.ownerWallet))
    .innerJoin(plots, eq(plots.baseId, bases.id))
    .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
    .where(and(
      targetIsBaseId
        ? or(eq(bases.id, target), eq(bases.ownerWallet, target))
        : eq(bases.ownerWallet, target),
      eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
      eq(baseSlots.active, true), eq(baseSlots.wallet, bases.ownerWallet),
    ))
    .orderBy(asc(bases.createdAt)).limit(2) : [];
  if (stable && stableTargets.length > 1 && stableTargets.every((row) => row.baseId !== target)) {
    throw new HttpError(409, 'baseId is required when the player owns multiple parcels', 'BASE_ID_REQUIRED');
  }
  const stableTarget = stableTargets.find((row) => row.baseId === target) ?? stableTargets[0];
  const targetWallet = stableTarget?.wallet ?? target;
  if (viewer === targetWallet) throw new HttpError(422, 'that is your own base');
  const [legacyTarget] = stable ? [] : await db.select().from(players).where(eq(players.wallet, target));
  const t = stableTarget ?? legacyTarget;
  if (!t) throw new HttpError(404, 'player not found');
  // THE LAND PARTITION (locked owner decision 2026-08-09): scouting is target
  // PICKING, so it must respect the same boundary as createRaid — a base on the
  // other side of the land line is "not in the world" as far as this viewer is
  // concerned. This look-up is by WALLET, not through the plots-joined roster, so
  // route gating cannot cover it: without this check a landowner handed a deedless
  // wallet out-of-band could read that base's full layout even though it has no map
  // row. Same 404 as an unknown wallet, so it is not an existence oracle either.
  //
  // UNCONDITIONAL, NOT BEHIND `FREE_ONBOARDING` (security review 2026-08-09 F2),
  // and this one would be actively DANGEROUS to flag. The partition is a security
  // invariant with two enforcement points — here and `createRaid` (raids.ts) — and
  // raids.ts enforces it unconditionally: flagging one and not the other makes them
  // disagree, and flagging both makes a boundary check depend on an ops switch,
  // which is how a partition gets bypassed by a config mistake. Flag-off delta,
  // stated rather than hidden: with the flag off, every pair this route can reach is
  // paid-vs-paid, so the ONLY change is that scouting an unpaid wallet now 404s
  // where it used to return an empty layout — which is exactly what an unknown
  // wallet already returned, so it is a correctness fix at any flag setting.
  const v = stable
    ? selectedViewerBase && { entryPaidAt: selectedViewerBase.base.landPaidAt }
    : (await db.select({ entryPaidAt: players.entryPaidAt }).from(players)
      .where(eq(players.wallet, viewer)))[0];
  if (!v || !sameLandTier(v, t)) throw new HttpError(404, 'player not found');
  // No shield check here, deliberately (D-099, owner 2026-09-02: "everyone can
  // scout everyone. it should not be gated by shield or anything else. only
  // attacks should"). The #46/#49 shield refusal that used to sit here taught the
  // scout nothing and the raid gate still refuses the attack.

  const rows = stableTarget ? await db.execute(sql`
    SELECT b.id, b.type, b.level, b.tx, b.ty FROM buildings b
    WHERE b.base_id = ${stableTarget.baseId}
      AND NOT EXISTS (
        SELECT 1 FROM builder_jobs j
        WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
      )
  `) as unknown as Array<{ id: string; type: string; level: number; tx: number; ty: number }> : await db.execute(sql`
    SELECT b.id, b.type, b.level, b.tx, b.ty FROM buildings b
    WHERE b.player_wallet = ${targetWallet}
      AND NOT EXISTS (
        SELECT 1 FROM builder_jobs j
        WHERE j.building_id = b.id AND j.kind = 'build' AND j.completed_at IS NULL
      )
  `) as unknown as Array<{ id: string; type: string; level: number; tx: number; ty: number }>;
  // Send the CENTERED claim bounds (same as snapshotDefender) + active obstacles so
  // the scout preview renders the base with the real base renderer — territory ring,
  // decor, and framing — not a flat board. The client reads these bounds and never
  // recomputes a claim, so scouting stays correct across the centered-claim geometry.
  const claim = claimRect(t.expansions);
  const obs = await db.select({ id: obstacles.id, spriteKey: obstacles.spriteKey, tx: obstacles.tx, ty: obstacles.ty })
    .from(obstacles)
    .where(and(
      stableTarget ? eq(obstacles.baseId, stableTarget.baseId) : eq(obstacles.playerWallet, targetWallet),
      isNull(obstacles.clearedAt),
    ));
  // Hero intelligence is disclosed only after the same self/land/shield gates as
  // the layout. Gear remains visible while its combat rollout is dark, but the
  // effective numbers reflect whether those modifiers are actually active.
  const combatEnabled = heroGearCombatEnabled();
  const [placements, loadouts] = await Promise.all([
    recruitedHeroPlacementsOf(db, targetWallet, now, stableTarget?.baseId),
    resolveHeroLoadouts(db, targetWallet, stableTarget?.baseId),
  ]);
  const heroIntel = placements.map((hero) => {
    const loadout = loadouts[hero.hero];
    const hp = HERO_LEVELING.hp[hero.hero][hero.level - 1]!;
    const damage = HERO_LEVELING.dps[hero.hero][hero.level - 1]!;
    const active = combatEnabled ? loadout.modifiers : undefined;
    const applyBps = (value: number, bps: number): number =>
      Math.floor((value * (10_000 + bps)) / 10_000);
    return {
      ...hero,
      recoveryUntil: hero.recoveryUntil?.toISOString() ?? null,
      gear: {
        catalogRevision: loadout.catalogRevision,
        version: loadout.version,
        hash: loadout.hash,
        equipment: loadout.equipment,
        itemIds: loadout.itemIds,
        modifiers: loadout.modifiers,
        setBonus: { pieces: loadout.wardenPieces, active: loadout.setActive },
        combatEnabled,
      },
      baseStats: { hp, basicDamage: damage, skillDamageSeed: damage },
      effectiveStats: {
        hp: applyBps(hp, active?.hero_hp_bps ?? 0),
        basicDamage: applyBps(damage, active?.hero_damage_bps ?? 0),
        skillDamageSeed: applyBps(
          damage,
          (active?.hero_damage_bps ?? 0) + (active?.ability_damage_bps ?? 0),
        ),
      },
    };
  });
  // Progress is the receipt for a SUCCESSFUL scout, not for naming a wallet.
  // Keep it after every existence / land-tier / shield eligibility check (and the
  // snapshot reads) so rejected probes cannot farm scout_3 progress.
  await progressQuestBatch(db, viewer, [
    ['scout_3', 1], ['scout_1', 1],
  ], now, selectedViewerBase?.base.id);
  return {
    ...(stableTarget ? { baseId: stableTarget.baseId } : {}),
    wallet: targetWallet,
    name: t.name,
    keepLevel: t.keepLevel,
    trophies: t.trophies,
    buildings: rows,
    obstacles: obs,
    claimMin: claim.min,
    claimMax: claim.max,
    battlefieldVersion: RAID_BATTLEFIELD.currentVersion,
    ...(plotVersionForClaim(claim) === 2 ? { plotVersion: 2 as const } : {}),
    heroes: heroIntel,
    previewSec: RAID_RULES.scoutPreviewSec,
    visualContext: await resolveBaseVisual(db, stableTarget?.baseId),
    ...(stableTarget ? { boundCosmeticVisual: await readBoundCosmeticBase(db, stableTarget.baseId, targetWallet) } : {}),
  };
}

// ---------------------------------------------------------------------------
// PvE camp lifecycle
// ---------------------------------------------------------------------------

export async function getCampForRaid(db: Db, campId: string, now = new Date()) {
  const [camp] = await db.select().from(pveCamps).where(eq(pveCamps.id, campId));
  if (!camp) throw new HttpError(404, 'camp not found');
  if (camp.respawnsAt && camp.respawnsAt > now) throw new HttpError(422, 'camp already cleared — respawns soon');
  return camp;
}

export async function markCampCleared(db: DbOrTx, campId: string, now = new Date()): Promise<void> {
  const nextUtcMidnight = new Date(`${new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`);
  // Never SHORTEN a future respawnsAt (security review 2026-08-03 finding 1):
  // removeMaxedCamp tombstones a camp with a far-future respawnsAt, and a raid
  // that was already in flight when ops removed it resolves later — an
  // unconditional overwrite here would quietly resurrect the "removed" camp at
  // the next cron and it would resume paying bounty until a human noticed.
  await db.update(pveCamps).set({ respawnsAt: nextUtcMidnight }).where(and(
    eq(pveCamps.id, campId),
    or(isNull(pveCamps.respawnsAt), lte(pveCamps.respawnsAt, nextUtcMidnight)),
  ));
}

/** Daily cron body: camps whose respawn time passed become attackable again. */
export async function respawnPveCamps(db: Db, now = new Date()): Promise<number> {
  const rows = await db.update(pveCamps)
    .set({ respawnsAt: null })
    .where(and(sql`${pveCamps.respawnsAt} IS NOT NULL`, lte(pveCamps.respawnsAt, now)))
    .returning({ id: pveCamps.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// MAXED practice camp (owner 2026-08-03) — tier 9, ops-spawned only
// ---------------------------------------------------------------------------

/** Removal sentinel for a maxed camp that raid history still references
 *  (raids.pve_camp_id FK — history is never rewritten, so the row cannot be
 *  deleted): a respawnsAt so far out that the daily cron (`lte now`) never
 *  revives it. getCampForRaid refuses it and the map shows it cleared. A later
 *  spawnMaxedCamp run finds and heals the tombstone instead of duplicating. */
const CAMP_TOMBSTONE = new Date('9999-01-01T00:00:00Z');

/**
 * Ops entry point (db/spawnMaxedCamp.ts — deliberately NO route): place or
 * refresh the tier-9 MAXED practice fortress next to `ownerWallet`'s plot.
 *
 * - Placement: nearest free tile to the plot, ring by ring (chebyshev) in a
 *   fixed scan order — deterministic, and "next to" degrades gracefully to "as
 *   close as the plot grammar allows" when all 8 neighbours are taken.
 * - Idempotent: at most ONE tier-9 camp per valley. A re-run heals it in place
 *   (respawnsAt → NULL, snapshot/lootKeep rewritten) rather than stacking a
 *   duplicate — also how a CAMP_TIERS tweak or a --remove tombstone is revived.
 * - Lifecycle: once placed it lives like any camp — clearing it schedules the
 *   normal next-UTC-midnight respawn (markCampCleared/respawnPveCamps make no
 *   tier distinction) — and it persists until removeMaxedCamp. Re-run to revive
 *   it before the cron does.
 * - Safe mid-raid: a raid fights its own frozen snapshot, and tier + lootKeep
 *   are value-identical on refresh, so (unlike reseedValleyCamps' re-tiering)
 *   this can never change what an in-flight win pays.
 */
export async function spawnMaxedCamp(
  db: Db, ownerWallet: string,
): Promise<{ action: 'spawned' | 'refreshed'; campId: string; valleyId: string; x: number; y: number }> {
  const [plot] = await db.select().from(plots).where(eq(plots.playerWallet, ownerWallet));
  if (!plot) throw new HttpError(404, `no plot for wallet ${ownerWallet} — enter the world once first`);

  if (plot.valleyId === null || plot.x === null || plot.y === null) throw new HttpError(409, 'Practice valley camps require a legacy valley');
  const [existing] = await db.select().from(pveCamps)
    .where(and(eq(pveCamps.valleyId, plot.valleyId), eq(pveCamps.tier, MAXED_CAMP_TIER)));
  if (existing) {
    await db.update(pveCamps).set({
      snapshot: makeCampSnapshot(MAXED_CAMP_TIER),
      lootKeep: BigInt(PVE.bountyByTier[MAXED_CAMP_TIER - 1]!),
      respawnsAt: null, // heal: attackable again right now
    }).where(eq(pveCamps.id, existing.id));
    invalidateValley(plot.valleyId);
    return { action: 'refreshed', campId: existing.id, valleyId: plot.valleyId, x: existing.x, y: existing.y };
  }

  const taken = new Set<string>();
  (await db.select({ x: plots.x, y: plots.y }).from(plots).where(eq(plots.valleyId, plot.valleyId)))
    .forEach((p) => taken.add(`${p.x},${p.y}`));
  (await db.select({ x: pveCamps.x, y: pveCamps.y }).from(pveCamps).where(eq(pveCamps.valleyId, plot.valleyId)))
    .forEach((c) => taken.add(`${c.x},${c.y}`));
  // Rotation lattice spots are off-limits even when currently EMPTY (a valley
  // predating the current campsPerValley/ramp — the very case db:reseed-camps
  // exists for): reseedValleyCamps upserts on (valleyId, x, y), so a T9 parked
  // on a lattice coordinate would be silently re-tiered into a rotation camp.
  // Rotation lattice spots are off-limits even when currently EMPTY (a valley
  // predating the current campsPerValley/ramp — the very case db:reseed-camps
  // exists for): reseedValleyCamps upserts on (valleyId, x, y), so a T9 parked
  // on a lattice coordinate would be silently re-tiered into a rotation camp.
  for (const c of campCoords()) taken.add(`${c.x},${c.y}`);
  let spot: { x: number; y: number } | undefined;
  const maxR = Math.max(WORLD.gridCols, WORLD.gridRows);
  outer: for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring cells only
        const x = plot.x + dx, y = plot.y + dy;
        if (x < 0 || y < 0 || x >= WORLD.gridCols || y >= WORLD.gridRows) continue;
        if (!taken.has(`${x},${y}`)) { spot = { x, y }; break outer; }
      }
    }
  }
  if (!spot) throw new HttpError(422, 'valley grid is completely full — no tile for the maxed camp');

  const [row] = await db.insert(pveCamps).values({
    valleyId: plot.valleyId, x: spot.x, y: spot.y, tier: MAXED_CAMP_TIER,
    snapshot: makeCampSnapshot(MAXED_CAMP_TIER),
    lootKeep: BigInt(PVE.bountyByTier[MAXED_CAMP_TIER - 1]!),
  }).returning();
  invalidateValley(plot.valleyId);
  return { action: 'spawned', campId: row!.id, valleyId: plot.valleyId, x: row!.x, y: row!.y };
}

/**
 * Remove every tier-9 camp in `ownerWallet`'s valley. Camps no raid ever
 * touched are deleted outright; camps referenced by raid history are
 * tombstoned (see CAMP_TOMBSTONE) because the FK forbids deletion and history
 * is never rewritten.
 */
export async function removeMaxedCamp(
  db: Db, ownerWallet: string,
): Promise<Array<{ action: 'deleted' | 'tombstoned'; campId: string; x: number; y: number }>> {
  const [plot] = await db.select().from(plots).where(eq(plots.playerWallet, ownerWallet));
  if (!plot) throw new HttpError(404, `no plot for wallet ${ownerWallet}`);
  if (plot.valleyId === null) throw new HttpError(409, 'Practice valley camps require a legacy valley');
  const rows = await db.select().from(pveCamps)
    .where(and(eq(pveCamps.valleyId, plot.valleyId), eq(pveCamps.tier, MAXED_CAMP_TIER)));
  const out: Array<{ action: 'deleted' | 'tombstoned'; campId: string; x: number; y: number }> = [];
  for (const c of rows) {
    const [ref] = await db.select({ n: sql<number>`count(*)::int` }).from(raids)
      .where(eq(raids.pveCampId, c.id));
    if ((ref?.n ?? 0) === 0) {
      try {
        await db.delete(pveCamps).where(eq(pveCamps.id, c.id));
        out.push({ action: 'deleted', campId: c.id, x: c.x, y: c.y });
        continue;
      } catch {
        // a raid landed between the count and the delete — fall through to tombstone
      }
    }
    await db.update(pveCamps).set({ respawnsAt: CAMP_TOMBSTONE }).where(eq(pveCamps.id, c.id));
    out.push({ action: 'tombstoned', campId: c.id, x: c.x, y: c.y });
  }
  if (rows.length > 0) invalidateValley(plot.valleyId);
  return out;
}

/**
 * Map search (MAPS handout E3 — the owner asked for "search"; the handout ships
 * only FIND MATCH + filters, so this is the added text half): name substring or
 * wallet prefix, capped small. PUBLIC game data only (name/level/trophies/plot)
 * — the same fields every map marker already shows any opponent.
 */
export async function searchPlayers(db: Db, q: string, limit = 10) {
  const needle = q.trim();
  if (needle.length < 2) return { results: [] };
  const filter = or(
    ilike(players.name, `%${needle.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`),
    ilike(players.wallet, `${needle.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`),
  );
  if (multiBaseEnabled()) {
    const rows = await db.select({
      baseId: bases.id,
      wallet: players.wallet, name: players.name, seeker: players.seekerVerified,
      keepLevel: bases.keepLevel,
      trophies: sql<number>`coalesce(${baseProfiles.trophies}, 0)::int`,
      valleyId: plots.valleyId, x: plots.x, y: plots.y,
    }).from(plots)
      .innerJoin(bases, eq(bases.id, plots.baseId))
      .innerJoin(baseSlots, eq(baseSlots.baseId, bases.id))
      .innerJoin(players, eq(players.wallet, bases.ownerWallet))
      .leftJoin(baseProfiles, eq(baseProfiles.baseId, bases.id))
      .where(and(
        filter,
        eq(bases.status, 'active'), isNotNull(bases.landPaidAt),
        eq(baseSlots.active, true), eq(baseSlots.wallet, bases.ownerWallet),
      ))
      .orderBy(desc(sql`coalesce(${baseProfiles.trophies}, 0)`)).limit(limit);
    return { results: rows };
  }
  const rows = await db
    .select({
      wallet: players.wallet, name: players.name, seeker: players.seekerVerified,
      keepLevel: players.keepLevel,
      trophies: players.trophies, valleyId: plots.valleyId, x: plots.x, y: plots.y,
    })
    .from(players)
    // INNER, not LEFT (2026-08-09): a plotless base has no map presence at all, and
    // the locked decision is that a deedless player "cannot be found, scouted or
    // raided". A LEFT JOIN listed them with a null valleyId, which handed out the
    // one thing the no-map-row design withholds — a wallet from the invisible pool,
    // by NAME PREFIX. `plots INNER JOIN players` is the same rule the valley roster
    // uses, so search and the map now agree on who exists.
    //
    // UNCONDITIONAL, NOT BEHIND `FREE_ONBOARDING` (security review 2026-08-09 F2).
    // This is a MAP search: every field it returns but the name exists to navigate
    // to a parcel, so a row with a null valleyId was never answerable — the caller
    // cannot go there. Flag-off delta, stated rather than hidden: wallets with no
    // plot stop appearing. Today that set is unpaid sign-ups (who have no base at
    // all under the flag-off flow) plus any paid player whose plot assignment was
    // interrupted — and for the latter, dropping an unusable row from a map search
    // is the correct answer, not a regression. Gating it would leave the enumeration
    // hole open on the ops switch that turns the free tier on.
    .innerJoin(plots, eq(plots.playerWallet, players.wallet))
    .where(and(filter, isNotNull(players.entryPaidAt)))
    .orderBy(desc(players.trophies))
    .limit(limit);
  return { results: rows };
}
