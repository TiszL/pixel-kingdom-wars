/**
 * Client-side combat stat helpers for BattleScene FX.
 *
 * These MIRROR the authoritative server math in `packages/sim/src/stats.ts`
 * (`buildingMaxHp`, `troopCombat`, `footprintOf`) so the rendered HP bars and
 * damage numbers agree with the sim's outcome — the sim stays the only
 * authority; this file only re-derives *display* maxima from the same
 * `@shardkeep/shared` constants the sim reads. Keep these in lock-step with
 * `packages/sim/src/stats.ts` if the scaling rules ever change.
 */
import {
  BUILDING_GEOMETRY,
  DEFENSES,
  HERO_LEVELING,
  HERO_DEFENCE,
  INVENTORY,
  LEVEL_STEP_BUILDING,
  LEVEL_STEP_TROOP,
  STRUCTURES,
  TROOPS,
  resolveBuildingGeometryVersion,
  type TroopType,
  type HeroCombatLoadout,
  type HeroKey,
} from '@shardkeep/shared';

export interface BattleHealthContext {
  /** Only heroes in accepted orders contribute, including orders after victory. */
  heroLoadouts?: Partial<Record<HeroKey, HeroCombatLoadout>>;
}

/** Replay orders and their frozen army snapshot are the only gear authority.
 * Missing historical gear stays absent; never read the player's current gear. */
export function battleHealthContext(
  orders?: { heroDeploys?: readonly { hero: HeroKey; loadout?: HeroCombatLoadout }[] } | null,
  frozen?: Partial<Record<HeroKey, HeroCombatLoadout>>,
): BattleHealthContext {
  const heroLoadouts: Partial<Record<HeroKey, HeroCombatLoadout>> = {};
  for (const order of orders?.heroDeploys ?? []) {
    const loadout = order.loadout ?? frozen?.[order.hero];
    if (loadout) heroLoadouts[order.hero] = loadout;
  }
  return Object.keys(heroLoadouts).length ? { heroLoadouts } : {};
}

function hpModifier(loadout: HeroCombatLoadout | undefined, key: 'hero_hp_bps' | 'allied_troop_hp_bps'): number {
  const raw = loadout?.modifiers[key] ?? 0;
  if (!Number.isInteger(raw)) throw new Error(`Invalid frozen HP modifier: ${key}`);
  const cap = INVENTORY.modifierCapsBps[key];
  return Math.max(-cap, Math.min(cap, raw));
}

/** Mirrors sim armyModifiers: clamp each contribution, then the total. */
export function battleArmyHpBps(context: BattleHealthContext): number {
  const cap = INVENTORY.modifierCapsBps.allied_troop_hp_bps;
  const total = Object.values(context.heroLoadouts ?? {}).reduce(
    (sum, loadout) => sum + hpModifier(loadout, 'allied_troop_hp_bps'), 0,
  );
  return Math.max(-cap, Math.min(cap, total));
}

/**
 * Scale a base stat to `level` via the tapered per-level STEP array — a BYTE
 * IDENTICAL copy of `packages/sim/src/stats.ts#levelScale`. The sim switched
 * from a single 1.25/1.20 multiplier to tapered arrays (steps ease off at
 * higher levels), so this MUST use the same arrays or high-level HP bars drift
 * (buildings diverged at L≥6, troops at L≥4 under the old single-mult mirror).
 * STEP[i] is the multiplier reaching level i+1; STEP[0]=STEP[1]=1.
 */
function levelScale(base: number, steps: readonly number[], level: number): number {
  let v = base;
  for (let i = 1; i < level; i++) v *= steps[i] ?? 1;
  return Math.round(v);
}

/**
 * Max HP for a snapshot building at a level/tier — mirror of
 * `packages/sim/src/stats.ts#buildingMaxHp`, covering EVERY placeable type
 * (the new epic defenses + Gold Forge included — without them the client
 * returned 0 → no HP bar and no damage smoke/fire for those buildings in a
 * real raid). Walls use the explicit tier table; spike traps have no HP.
 */
export function buildingMaxHp(type: string, level: number): number {
  if (type === 'wall') {
    return STRUCTURES.wall.hpByTier[level - 1] ?? STRUCTURES.wall.hpByTier[0]!;
  }
  const defense = (DEFENSES as Record<string, { hp?: number }>)[type];
  const structure = (STRUCTURES as Record<string, { hp?: number }>)[type];
  const baseHp = defense?.hp ?? structure?.hp;
  // Trap constants intentionally have no HP and therefore remain untargetable.
  // This data-driven mirror also admits new shared structures immediately; the
  // previous switch silently gave Air Defence and Clan Hall zero HP in raids.
  return baseHp === undefined ? 0 : levelScale(baseHp, LEVEL_STEP_BUILDING, level);
}

/**
 * Troop max HP at an army level — mirror of `troopCombat().hp` (tapered
 * LEVEL_STEP_TROOP, rounded). `level` defaults to 1 when armyLevels is absent.
 */
export function troopMaxHp(troop: TroopType, level: number): number {
  const s = TROOPS[troop];
  if (!s) return 1;
  return levelScale(s.hp, LEVEL_STEP_TROOP, Math.max(1, level));
}

/**
 * Display max HP for one deployed attacker. Heroes borrow a troop only for
 * their sprite/order channel; the simulator gives them their own frozen hero
 * level and HERO_LEVELING HP. Keeping that distinction here prevents replay
 * heals from clamping Vex/Theodor to the donor troop's much smaller maximum.
 */
export function battleUnitMaxHp(
  troop: TroopType,
  troopLevel: number,
  hero?: 'vex' | 'theodor',
  heroLevel = 1,
  gear: { armyHpBps?: number; loadout?: HeroCombatLoadout; defender?: boolean } = {},
): number {
  let base: number;
  if (!hero) base = troopMaxHp(troop, troopLevel);
  else {
    const level = Math.max(1, Math.min(HERO_LEVELING.maxLevel, Math.trunc(heroLevel)));
    base = HERO_LEVELING.hp[hero][level - 1]!;
    if (gear.defender) base = Math.floor(base * HERO_DEFENCE.statPct / 100);
  }
  const bps = hero ? hpModifier(gear.loadout, 'hero_hp_bps') : gear.defender ? 0 : (gear.armyHpBps ?? 0);
  // Fixed-point basis-point conversion, identical to sim applyBps.
  return Math.floor(base * (10_000 + bps) / 10_000);
}

/** Footprint (cols × rows) — mirror of `packages/sim/src/stats.ts#footprintOf`.
 * Missing/v1 is the archived layout; only an explicit v2 battle snapshot may
 * widen its KEEP. BaseScene deliberately does not use this version argument. */
export function footprintOf(type: string, geometryVersion?: number): [number, number] {
  const resolvedVersion = resolveBuildingGeometryVersion(geometryVersion);
  const defense = (DEFENSES as Record<string, { footprint?: readonly [number, number] }>)[type];
  const structure = (STRUCTURES as Record<string, { footprint?: readonly [number, number] }>)[type];
  const footprint = type === 'keep'
    ? BUILDING_GEOMETRY.keepFootprintByVersion[resolvedVersion]
    : defense?.footprint ?? structure?.footprint;
  // Old persisted snapshots can contain a future/removed presentation type.
  // Keep rendering those conservatively, but never maintain a second manual
  // footprint table for known buildings: the shared sim constants are the one
  // authoritative geometry contract.
  return footprint ? [footprint[0], footprint[1]] : [1, 1];
}
