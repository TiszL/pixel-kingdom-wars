/**
 * sim.ts — the deterministic raid simulator (ARCHITECTURE §6, GDD §3.2–§3.3).
 *
 * simulateRaid(snapshot, orders, seed) is a pure function: fixed 100ms ticks,
 * integer positions (1/256 tile), mulberry32 randomness, stable iteration in
 * spawn/building order. Identical inputs replay bit-identically on any engine.
 *
 * DOCUMENTED CONTRACTS (deliberate simplifications, v0.1):
 * - Coordinates are plot-relative tiles. Legacy snapshots use the 30×30 plot
 *   plus a four-tile margin and exclude the claim's strict interior. SIM15/v2
 *   opens the full 98×98 realm and empty claim tiles. Frozen building footprints
 *   remain unavailable for deployment even after destruction.
 * - PATHING: troops walk straight at their target. Only WALLS block movement
 *   (buildings do not — troops stop at attack range anyway). A non-tunneler
 *   whose next tile holds a live wall attacks that wall until it falls
 *   (CoC-style), then resumes. A tunneler burrows on wall contact, travels
 *   under (untargetable mound; spike traps still trigger on it), and emerges
 *   after clearing the wall line + 2 tiles or on reaching its target, with a
 *   1s vulnerable window (GDD §3.2). The keg runner picks the wall opening the
 *   army's cheapest path (Dijkstra, see path.ts) and detonates on reaching it
 *   — or on whatever wall blocks it first.
 * - RANDOMNESS: the only rng use is a ±6% damage roll on DEFENSE shots (and
 *   mortar splash). Troop melee damage is exact. Raids stay skill-determined
 *   (GDD §8); the roll exists so distinct seeds produce distinct-but-close
 *   replays.
 * - SIM10 troop damage is cycle-based: full authored bodies are never sped up,
 *   projectiles/contact frames own damage time, and compact attackRun records
 *   preserve exact integer long-run DPS. Defender Wyrmlings keep their stable
 *   sim identity while the client renders the eight-direction WARE Hatchling.
 * - Destruction % excludes walls and all four trap families (owner 2026-08-15/M22).
 * - Stars: +1 at ≥50% destruction, +1 for the Keep, +1 at 100% (GDD §3.3).
 * - The keg runner only detonates on REACHING its target; if shot down on the
 *   way it dies without a blast.
 */
import { battlefieldBounds, isBattlefieldTileDeployable, occupiedBattlefieldTiles } from '@shardkeep/shared/battlefield';
import {
  HERO_COMBAT,
  HERO_DEFENCE,
  HERO_LEVELING,
  HERO_SKILLS,
  AUTHORED_ATTACK_TIMINGS,
  INVENTORY,
  heroTier,
  BUFFS,
  BuildingType,
  DEFENSES,
  DEFENSE_PROJECTILE_TIMINGS,
  isInsidePlot,
  plotBounds,
  PLOT_GEOMETRY,
  RAID_RULES,
  RAID_REPLAY_LIMITS,
  RALLY,
  SIM_TARGETING,
  TROOPS,
  TROOP_ABILITIES,
  TROOP_LEVELING,
  attackPayloadDeci,
  authoredAttackTiming,
  resolveAttackTiming,
  splitAttackPayloadDeci,
  isTrainableTroop,
  type AttackRunEvent,
  type BaseSnapshot,
  type DeployOrder,
  type HeroCombatLoadout,
  type HeroCombatModifiers,
  type TroopStats,
  type TroopMechanics,
  type TroopType,
  type TrapType,
} from '@shardkeep/shared';
import { mulberry32, type Rng } from './rng';
import {
  closestPointOnRect,
  COMPASS8,
  dist2,
  dist2ToRect,
  isqrt,
  tileCenter,
  unitToTile,
  UNITS_PER_TILE,
} from './fixed';
import { costField, kegPath, WALL_COST, type PathGrid } from './path';
import {
  buildingMaxHp,
  DEPLOY_WINDOW_TICKS,
  defenseCombat,
  footprintOf,
  heroCombat,
  kegSplashDeci,
  kegWallBurstDeci,
  MAX_TICKS,
  reachFor,
  TICKS_PER_SEC,
  trapCombat,
  troopCombat,
  type DefenseCombat,
} from './stats';
import {
  SimInputError, SimRepresentationLimitError,
  type HeroDeploy, type RaidOrders, type RaidOutcome, type SimEvent,
} from './types';

// ---------------------------------------------------------------------------
// Internal entity state
// ---------------------------------------------------------------------------

interface BState {
  id: string;
  type: BuildingType;
  level: number;
  tx: number; ty: number; fw: number; fh: number;
  hpDeci: number;
  maxHpDeci: number;
  destroyed: boolean;
  countsForDestruction: boolean;
  def: DefenseCombat | null;
  cooldown: number;
  defTarget: number; // troop id or -1
  trapArmed: boolean;
}

/**
 * `idle` is TERMINAL: pass 3 skips it and NOTHING ever clears it, so an idled
 * unit never acts again for the rest of the raid (that is deliberate for an
 * attacker with no target left — the `anyAlive` end-condition counts it as gone).
 *
 * `guarding` is the opposite: a LIVE parked phase for a defender that cannot act
 * *this tick* — stunned, or with no reachable enemy (e.g. every raider burrowed).
 * Pass 3 re-evaluates it every tick, so the unit resumes on its own. Never use
 * `idle` for a temporary pause (2026-07-29: a Cheek Quake stun was deleting
 * wyrmlings from the battle permanently, and a burrowed opener idled the whole
 * defense forever).
 */
type TroopPhase = 'moving' | 'attacking' | 'burrowed' | 'emerging' | 'guarding' | 'idle' | 'dead';

interface TState {
  id: number;
  type: TroopType;
  level: number;
  /** D4b: set for hero units — the skill pass keys off it; undefined for troops. */
  hero?: 'vex' | 'theodor';
  /** Frozen and cap-normalized; absent keeps all historical arithmetic intact. */
  combatModifiers?: HeroCombatModifiers;
  /** Skill seed includes hero damage + ability damage in one integer floor. */
  abilityDpsDeci?: number;
  firstHitAvailable?: boolean;
  /** D4b: per-skill next-allowed tick (autocast cooldowns), keyed by skill id. */
  skillReadyAt?: Record<string, number>;
  /** D4b: stunned until this tick (Cheek Quake hits defender troops too — the
   *  spec's "everything in 3 tiles is stunned"). Undefined = never stunned. */
  stunUntil?: number;
  /**
   * Z3 — untargetable/immune until this tick. RAGE QUIT's fake death ("mark him
   * untargetable for 3s, defences must re-acquire") and DOUBLE OR NOTHING's 1s
   * heads immunity are the same window: nothing may target or damage him, and he
   * does nothing himself.
   *
   * Deliberately NOT expressed as a phase. `phase = 'idle'` is excluded from the
   * `anyAlive` end-condition, so a solo hero playing dead would END the raid;
   * `phase = 'burrowed'` drives burrow MOVEMENT in pass 3. He keeps a live phase
   * and simply skips acting.
   */
  untargetableUntil?: number;
  /** Z2 — timed self-buff windows, keyed by skill id ("degen" → DEGEN AWAKENING).
   *  A separate map from `skillReadyAt` on purpose: overloading a field named
   *  "ready at" with the inverted meaning "active until" is the kind of ambiguity
   *  the role-leak guard exists to prevent. */
  buffUntil?: Record<string, number>;
  /** New-roster deterministic action/cooldown clocks. Optional so every legacy
   *  actor retains its exact state shape and arithmetic. */
  abilityReadyAt?: Record<string, number>;
  actionUntil?: number;
  attackReadyAt?: number;
  /** A reached-target keg is committed; lethal fire cannot cancel its fuse. */
  detonationTick?: number;
  tauntTarget?: number;
  tauntUntil?: number;
  fearUntil?: number;
  fearFromX?: number;
  fearFromY?: number;
  cannonballGift?: { bi: number; dps: number; durationTicks: number };
  silentX?: number;
  silentY?: number;
  /** attacker = deployed by the raider; defender = Dragon-Nest-spawned wyrmling. */
  side: 'attacker' | 'defender';
  spawnTick: number;    // tick this troop entered (for wyrmling lifespan)
  fromNest: number;     // spawning Dragon-Nest building index (-1 for attackers)
  /** Hexbarrow source id for attacker-side summons (-1/undefined otherwise). */
  fromSpawner?: number;
  /** Defensive hero altar anchor. Undefined for attackers and spawned troops. */
  guardX?: number;
  guardY?: number;
  guardEngaged?: boolean;
  expiresTick?: number;
  variant?: number;
  x: number; y: number;
  hpDeci: number;
  /** Spawn HP, kept so % -of-max-HP effects (RAGE QUIT's 60%, DOUBLE OR NOTHING's
   *  50%, MOONSUNDER WAVE's bleed, lifesteal's heal cap) need no table lookup. */
  maxHpDeci: number;
  phase: TroopPhase;
  targetB: number;      // main target building index, -1 = none
  blockedWall: number;  // wall building index currently blocking, -1 = none
  /** 1 while committed to a wall-free detour around a wall — see the movement
   *  section. Cleared on retarget and when the detour is spent. */
  routing: number;
  kegWall: number;      // keg runner's chosen wall, -1 = none
  /** D-099: the wall this unit has COMMITTED to open, -1 = none. Set once by
   *  decideAtWall when breaching beats the detour; cleared only when that wall
   *  falls (breachOpened), the target dies, or a teleport moves the unit. Its
   *  existence is what allies see as a live breach to join. */
  breachWall: number;
  emergeLeft: number;   // ticks of emerge vulnerability remaining
  burrowedUnits: number;// units traveled while burrowed
  // resolved combat numbers
  dpsDeci: number;
  unitsPerTick: number;
  rangeUnits: number;
}

interface Projectile {
  impactTick: number;
  releaseTick: number;
  released: boolean;
  fromB: number;
  targetTroop: number; // followed by cannon/arrow
  splash: boolean;     // mortar / mage-tower: impact at fixed point with AoE
  targetsAir: boolean; // firing defense can hit flying troops (splash air rule)
  ix: number; iy: number;
  dmgDeci: number;
  splashUnits: number;
  /** Electric tower only: secondary chain hops applied at impact (undefined otherwise). */
  chainMax?: number;
  chainFalloffPct?: readonly number[];
}

interface ScheduledTroopImpact {
  tick: number;
  releaseTick: number;
  released: boolean;
  source: number;
  targetKind: 'troop' | 'building';
  targetIndex: number;
  dmgDeci: number;
  melee: boolean;
  requiresLiveSource: boolean;
}

/**
 * Z1 — a lingering damage-over-time, drained once per tick in pass 4c.
 *
 * Four hero skills need one: CANNONBALL's parting gift (a building rots under
 * him), BROWN NOTE's gas and SILENT BUT DEADLY's cloud (ground zones), and
 * MOONSUNDER WAVE's bleed (a specific victim). One flat shape covers all three
 * kinds rather than three parallel lists.
 *
 * INTEGER IDENTITY: a flat "N dps" is exactly N deci-HP per tick (N×10 deci/s ÷
 * 10 ticks/s), so every spec DPS number lands with no division and no drift.
 */
interface Dot {
  kind: 'building' | 'zone' | 'troop';
  bi: number;                          // 'building': target index (else -1)
  ti: number;                          // 'troop': victim troop id (else -1)
  cx: number; cy: number; r2: number;  // 'zone': centre + radius² in units
  dmgDeciPerTick: number;
  untilTick: number;
  ownerSide?: 'attacker' | 'defender';
}

interface BurnField {
  owner: number;
  centers: readonly { x: number; y: number }[];
  radius2: number;
  dmgDeciPerTick: number;
  untilTick: number;
}

type ScheduledTroopEffect =
  | { tick: number; kind: 'howl'; source: number }
  | { tick: number; kind: 'lunge'; source: number; target: number }
  | { tick: number; kind: 'firestorm'; source: number; x: number; y: number; dx: number; dy: number }
  | { tick: number; kind: 'maul'; source: number; x: number; y: number }
  | { tick: number; kind: 'brood'; source: number; count: number; firstSlot: number }
  | { tick: number; kind: 'detonate'; source: number; ctx: number; cty: number };

// Game numbers derived from shared constants (values unchanged, so golden
// replays stay bit-identical): 1s emerge window, 2-tile burrow-clear radius,
// ±6% defense-damage jitter.
const EMERGE_TICKS = (TROOPS.tunneler.emergeVulnerableSec ?? 1) * TICKS_PER_SEC; // 1s → 10
const BURROW_CLEAR_UNITS = RAID_RULES.burrowClearTiles * UNITS_PER_TILE; // 2 tiles
const POS_KEYFRAME_EVERY = 5;
const DMG_JITTER_PCT = RAID_RULES.dmgJitterPct; // ±6%

const MODIFIER_KEYS = [
  'hero_hp_bps', 'hero_damage_bps', 'ability_damage_bps',
  'cooldown_reduction_bps', 'move_speed_bps',
  'incoming_damage_reduction_bps', 'first_hit_reduction_bps',
  'wall_damage_bps', 'allied_troop_hp_bps', 'allied_troop_damage_bps',
] as const satisfies readonly (keyof HeroCombatModifiers)[];

const applyBps = (value: number, bps: number): number =>
  Math.floor((value * (10_000 + bps)) / 10_000);

/** Snapshots are server-authored, but replay inputs are still validated at the
 * pure boundary. Values are clamped to the shared caps so a future producer
 * cannot accidentally amplify an already-resolved bucket. */
const normalizedModifiers = (loadout?: HeroCombatLoadout): HeroCombatModifiers | undefined => {
  if (!loadout) return undefined;
  if (!Number.isInteger(loadout.catalogRevision) || loadout.catalogRevision < 0
    || !Number.isInteger(loadout.version) || loadout.version < 0
    || typeof loadout.hash !== 'string' || loadout.hash.length < 1 || loadout.hash.length > 128) {
    throw new SimInputError('invalid hero loadout identity');
  }
  const out = {} as HeroCombatModifiers;
  for (const key of MODIFIER_KEYS) {
    const raw = loadout.modifiers?.[key] ?? 0;
    if (!Number.isInteger(raw)) throw new SimInputError(`invalid hero modifier: ${key}`);
    const cap = INVENTORY.modifierCapsBps[key];
    out[key] = Math.max(-cap, Math.min(cap, raw));
  }
  return out;
};

const armyModifiers = (loadouts: readonly (HeroCombatLoadout | undefined)[]): {
  hpBps: number; damageBps: number;
} => {
  let hpBps = 0;
  let damageBps = 0;
  for (const loadout of loadouts) {
    const m = normalizedModifiers(loadout);
    hpBps += m?.allied_troop_hp_bps ?? 0;
    damageBps += m?.allied_troop_damage_bps ?? 0;
  }
  return {
    hpBps: Math.max(-INVENTORY.modifierCapsBps.allied_troop_hp_bps,
      Math.min(INVENTORY.modifierCapsBps.allied_troop_hp_bps, hpBps)),
    damageBps: Math.max(-INVENTORY.modifierCapsBps.allied_troop_damage_bps,
      Math.min(INVENTORY.modifierCapsBps.allied_troop_damage_bps, damageBps)),
  };
};

/**
 * Every BEHAVIOURAL field the sim reads off a unit — movement, reach, targeting,
 * wall policy and the role flags. Also widens TROOPS[type] (which narrows to a
 * per-troop literal hiding the optional role fields) so the sim reads them
 * uniformly, undefined when absent.
 *
 * A hero is spawned as a pseudo-deploy of its donor troop (`tr.type` stays the
 * donor, for the sprite), so reading `TROOPS[tr.type]` handed heroes the
 * donor's role: Vex ran at the
 * highlander's 1.2 tiles/s and Theodor inherited the giant's wallPolicy 'break'
 * + 2x buildingDamageMult and spent whole raids gnawing perimeter at 38 dps
 * (owner report 2026-07-29). Heroes now own these in HERO_COMBAT.
 *
 * NON-hero units return TROOPS[tr.type] verbatim, so every existing code path is
 * byte-identical and the golden replays (which contain no hero deploys) are
 * untouched.
 *
 * ROLE IS DATA, NEVER A TYPE STRING (2026-07-29, adversarial review). Three
 * branches still keyed off `tr.type` — keg wall-selection, keg detonation and
 * the plunderer's resource multiplier — so a hero riding a kegrunner or
 * plunderer donor would have silently inherited that role: the exact bug class
 * that made Theodor (giant donor) chew walls. They read `selfDestructs` /
 * `resourceDamageMult` through behaviorOf now, so declaring the field is the ONLY
 * way to get the role. (`resourceDamageMult` was in this Pick but unread —
 * a hero author setting it got a typecheck-clean no-op.)
 *
 * MAGNITUDE IS DATA TOO (2026-07-29, second pass). `selfDestructs` was routed
 * through here, but the keg BLAST SIZE was still read straight off
 * TROOPS.kegrunner and scaled by `tr.level` — the HERO level for a hero. The
 * role said "not a bomber" while the numbers said "a keg runner's 900 wall burst
 * on a hero's curve". `wallBurst` now travels with the behaviour, and the
 * non-wall splash is derived from the acting unit's own dps, so a unit's blast
 * can only ever be its own.
 */
type UnitBehavior = Pick<TroopStats,
  'speedTilesPerSec' | 'range' | 'aiTarget' | 'wallPolicy' | 'buildingDamageMult'
  | 'isFlying' | 'burrowsUnderWalls' | 'emergeVulnerableSec' | 'resourceDamageMult'
  | 'splashRadiusTiles' | 'selfDestructs' | 'wallBurst' | 'siegeThrow' | 'spawnOnly'>;
const behaviorOf = (tr: TState): UnitBehavior => (tr.hero ? HERO_COMBAT[tr.hero] : TROOPS[tr.type]);
const NO_TROOP_MECHANICS: TroopMechanics = {};
const mechanicsOf = (tr: TState): TroopMechanics => tr.hero
  ? NO_TROOP_MECHANICS
  : (TROOP_ABILITIES[tr.type as keyof typeof TROOP_ABILITIES] ?? NO_TROOP_MECHANICS);
const positionKeyframeEvery = (tr: TState): number =>
  behaviorOf(tr).spawnOnly
    ? TROOP_ABILITIES.hexbarrow.brood.positionKeyframeTicks
    : POS_KEYFRAME_EVERY;
/** The role lookup, exported for tests. EVERY role trait must resolve through
 *  this — a branch that reads `tr.type` instead is how a hero silently
 *  inherits its donor's role (Theodor/walls, 2026-07-29). Testing it directly
 *  locks the wall-SELECTION branch, whose only other observable consequence is
 *  already covered by the detonation test. */
export const roleOf = (hero: 'vex' | 'theodor' | null, type: TroopType): UnitBehavior =>
  behaviorOf({ hero, type } as TState);

/** Star derivation, exported for unit tests (GDD §3.3). */
export function computeStars(destructionPct: number, keepDestroyed: boolean): 0 | 1 | 2 | 3 {
  let s = 0;
  if (destructionPct >= RAID_RULES.oneStarDestructionPct) s++;
  if (keepDestroyed) s++;
  if (destructionPct >= RAID_RULES.threeStarDestructionPct) s++;
  return s as 0 | 1 | 2 | 3;
}

const isTrapType = (type: BuildingType): type is BuildingType.SpikeTrap |
  BuildingType.PowderMine | BuildingType.Pitfall | BuildingType.AirMine =>
  type === BuildingType.SpikeTrap || type === BuildingType.PowderMine ||
  type === BuildingType.Pitfall || type === BuildingType.AirMine;

/** Troop levels default to 1 when the caller doesn't supply research levels. */
export interface SimOptions {
  troopLevels?: Partial<Record<TroopType, number>>;
  /**
   * Stop after this tick (inclusive) instead of at the horn/drain. The outcome
   * is then the battle's exact state at that boundary — stars, destruction,
   * keep, every building's hp and the event prefix (`t <= stopAfterTick`).
   * Every earlier tick is simulated identically, so the result is the
   * byte-identical prefix of the full run. The API settles an accepted RETREAT
   * with it (2026-09-17, tester f7c978e8 + owner on native: a started retreat
   * settled as a 0 % / 0★ placeholder with trophy loss while the archived
   * prefix showed the keep falling). No post-horn drain applies: whatever had
   * not landed by the retreat tick never lands. Omitted (the default) leaves
   * every existing replay and golden fixture byte-for-byte unchanged.
   */
  stopAfterTick?: number;
}

export function simulateRaid(
  snapshot: BaseSnapshot,
  orders: RaidOrders,
  seed: number,
  opts: SimOptions = {},
): RaidOutcome {
  if (orders.deploys.length > RAID_REPLAY_LIMITS.maxDirectDeploys) {
    throw new SimRepresentationLimitError(
      `replay direct-actor limit exceeded: ${orders.deploys.length}/${RAID_REPLAY_LIMITS.maxDirectDeploys}`,
    );
  }
  if (opts.stopAfterTick !== undefined
    && (!Number.isInteger(opts.stopAfterTick) || opts.stopAfterTick < 0)) {
    throw new SimInputError(`stopAfterTick must be a non-negative integer tick: ${opts.stopAfterTick}`);
  }
  const stopAfterTick = opts.stopAfterTick ?? -1;
  const rng = mulberry32(seed);
  const visualCueTicks = RAID_RULES.troopFireVisualTicks;
  /**
   * A SECOND, independent PRNG, used by exactly one thing: DOUBLE OR NOTHING's
   * coin. It must not come from `rng` — every draw there re-phases the defense
   * damage jitter for the rest of the raid, so a hero's coin flip would
   * retro-actively change unrelated damage numbers elsewhere in the same battle.
   * A separately seeded mulberry32 is just as replayable and fully isolated.
   * 0x9e3779b9 is the golden-ratio mixing constant — a decorrelating XOR key, not
   * a game number, so it lives here rather than in constants.ts.
   */
  const coinRng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const events: SimEvent[] = [];
  const assertRepresentationLimits = (actors: number): void => {
    if (actors > RAID_REPLAY_LIMITS.maxActors) {
      throw new SimRepresentationLimitError(
        `replay actor limit exceeded: ${actors}/${RAID_REPLAY_LIMITS.maxActors}`,
      );
    }
    if (events.length > RAID_REPLAY_LIMITS.maxEvents) {
      throw new SimRepresentationLimitError(
        `replay event limit exceeded: ${events.length}/${RAID_REPLAY_LIMITS.maxEvents}`,
      );
    }
  };
  const { min: plotMin, max: plotMax } = plotBounds(snapshot.plotVersion);
  const plot = plotMax - plotMin;
  // Path grids use zero-based indexes even when the frozen building frame is
  // signed. Convert only at this boundary; stored coordinates never move.
  const plotIndex = (tx: number, ty: number): number => (ty - plotMin) * plot + tx - plotMin;
  const inPlot = (tx: number, ty: number): boolean =>
    tx >= plotMin && ty >= plotMin && tx < plotMax && ty < plotMax;
  const pathPoint = (index: number): { x: number; y: number } => ({
    x: tileCenter(index % plot + plotMin),
    y: tileCenter((index - (index % plot)) / plot + plotMin),
  });
  // Versioned bounds govern deployment AND every off-plot movement clamp.
  // The plot grid is independent: surrounding terrain adds no collision cells.
  const { min: fieldMin, max: fieldMax } = battlefieldBounds(snapshot.battlefieldVersion);

  // --- Buildings --------------------------------------------------------
  const buildings: BState[] = snapshot.buildings.map((b) => {
    const { fw, fh } = footprintOf(b.type, snapshot.geometryVersion);
    // Preserve legacy admission byte-for-byte. New signed plots require the
    // complete integer footprint, not merely an anchor inside the new bounds.
    if (snapshot.plotVersion === PLOT_GEOMETRY.currentVersion
      ? !isInsidePlot({ tx: b.tx, ty: b.ty, fw, fh }, snapshot.plotVersion)
      : b.tx < 0 || b.ty < 0 || b.tx + fw > plot || b.ty + fh > plot) {
      throw new SimInputError(`building ${b.id} out of plot bounds`);
    }
    const maxHp = buildingMaxHp(b.type, b.level);
    const isTrap = isTrapType(b.type);
    const isWall = b.type === BuildingType.Wall;
    return {
      id: b.id,
      type: b.type,
      level: b.level,
      tx: b.tx, ty: b.ty, fw, fh,
      hpDeci: maxHp * 10,
      maxHpDeci: maxHp * 10,
      destroyed: false,
      countsForDestruction: !isTrap && !isWall,
      // A live snapshot's Keep level and Keep building level are equal. Requiring
      // both avoids arming malformed/legacy fixtures that carried a cosmetic L20
      // Keep inside a low-level snapshot before Keep combat existed.
      def: b.type === BuildingType.Keep && snapshot.keepLevel < 15
        ? null : defenseCombat(b.type, b.level),
      cooldown: 0,
      defTarget: -1,
      trapArmed: isTrap,
    };
  });

  const totalDestructibleDeci = buildings
    .filter((b) => b.countsForDestruction)
    .reduce((s, b) => s + b.maxHpDeci, 0);
  if (totalDestructibleDeci === 0) throw new SimInputError('snapshot has no destructible buildings');

  // Wall tile lookup (rebuilt lazily when a wall falls).
  const wallIdx = new Int32Array(plot * plot).fill(-1);
  const rebuildWalls = (): void => {
    wallIdx.fill(-1);
    buildings.forEach((b, i) => {
      if (b.type === BuildingType.Wall && !b.destroyed) wallIdx[plotIndex(b.tx, b.ty)] = i;
    });
    fieldCache.clear(); // a fallen wall can open a route — every field is stale
  };
  /** targetBuildingIndex → cost-to-that-building field. Built on demand and
   *  dropped whenever the wall layout changes, so "is there a way in?" is answered
   *  against the CURRENT breaches (owner 2026-07-26: troops kept chewing intact
   *  wall beside a hole their tank had already opened). */
  const fieldCache = new Map<number, Int32Array>();
  rebuildWalls();
  const pathGrid: PathGrid = { size: plot, wallIndex: wallIdx };

  /** Tiles adjacent to (or under) building `bi` — the "arrived" set for routing.
   *  A tile holding a LIVE wall is never a goal (D-099, owner 2026-09-02). The
   *  cost field charges for ENTERING a tile, so a wall hugging the target sat at
   *  cost 0 and the free tile outside it at cost 1: the building read as open,
   *  and a unit blocked at an outer wall walked around it toward that "gap" and
   *  found masonry — the "Giants turn back at walls" report. A wall that IS the
   *  target keeps its own tile, or the last-resort wall target has no goal. */
  const goalTilesFor = (bi: number): number[] => {
    const b = buildings[bi]!;
    const out: number[] = [];
    for (let gy = Math.max(plotMin, b.ty - 1); gy < Math.min(plotMax, b.ty + b.fh + 1); gy++) {
      for (let gx = Math.max(plotMin, b.tx - 1); gx < Math.min(plotMax, b.tx + b.fw + 1); gx++) {
        const idx = plotIndex(gx, gy);
        const w = wallIdx[idx]!;
        if (w >= 0 && w !== bi) continue;
        out.push(idx);
      }
    }
    return out;
  };
  const fieldFor = (bi: number): Int32Array => {
    const cached = fieldCache.get(bi);
    if (cached) return cached;
    const built = costField(pathGrid, goalTilesFor(bi));
    fieldCache.set(bi, built);
    return built;
  };
  /** The troop's tile, clamped into the plot grid from the surrounding field. */
  const clampTile = (ux: number, uy: number): number => {
    const tx = Math.max(plotMin, Math.min(plotMax - 1, unitToTile(ux)));
    const ty = Math.max(plotMin, Math.min(plotMax - 1, unitToTile(uy)));
    return plotIndex(tx, ty);
  };
  /**
   * Next tile to walk toward along the cheapest WALL-FREE route to `bi`, or -1 if
   * no such route exists from here. Rule 2 ("if entry is available, go inside"):
   * a troop only consults this when a wall blocks it, so open-field movement stays
   * the straight line it always was — replays without walls are untouched.
   */
  const stepThroughGap = (tr: TState, bi: number): number => {
    const f = fieldFor(bi);
    const here = clampTile(tr.x, tr.y);
    if (f[here]! >= WALL_COST) return -1; // every route from here crosses a wall
    const hx = here % plot, hy = (here - hx) / plot;
    const neigh = [
      hy > 0 ? here - plot : -1,
      hx > 0 ? here - 1 : -1,
      hx < plot - 1 ? here + 1 : -1,
      hy < plot - 1 ? here + plot : -1,
    ];
    let best = -1, bestC = f[here]!;
    for (const v of neigh) {
      if (v < 0 || wallIdx[v]! >= 0) continue; // never step onto a live wall
      if (f[v]! < bestC) { bestC = f[v]!; best = v; }
    }
    return best;
  };

  /** Live wall at a world position, or -1 in the surrounding battlefield. */
  const wallAt = (ux: number, uy: number): number => {
    const tx = unitToTile(ux);
    const ty = unitToTile(uy);
    if (!inPlot(tx, ty)) return -1;
    return wallIdx[plotIndex(tx, ty)]!;
  };
  /** A unit that is no longer at its wall — moved past it, teleported, or
   *  re-targeted — holds no wall commitment either: a stale `breachWall` would
   *  walk it BACK to masonry it has already left (D-099). */
  const unblock = (u: TState): void => { u.blockedWall = -1; u.breachWall = -1; };

  // --- Deploy orders ------------------------------------------------------
  // Hero drops (D4a) merge into ONE stream as pseudo-deploys of their donor
  // troop, tagged so the spawn overrides combat stats + the event carries hero
  // identity. Deterministic: the combined sort key is total (tMs, tx, ty,
  // hero-last), so identical inputs order identically.
  type AnyDeploy = DeployOrder & {
    __hero?: HeroDeploy['hero'];
    __heroLevel?: number;
    __heroLoadout?: HeroCombatLoadout;
  };
  // A hero is ONE unit: you own exactly one Vex, so the same hero can never be
  // dropped twice in a raid. Enforced here (not just in the UI) so a bugged
  // client or a hand-rolled replay cannot field three Theodors — the owner saw
  // exactly that on 2026-07-28.
  const seenHeroes: HeroDeploy['hero'][] = [];
  for (const h of orders.heroDeploys ?? []) {
    if (seenHeroes.includes(h.hero)) throw new SimInputError(`duplicate hero deploy: ${h.hero}`);
    seenHeroes.push(h.hero);
  }
  const heroPseudo: AnyDeploy[] = (orders.heroDeploys ?? []).map((h) => ({
    troop: HERO_COMBAT[h.hero].donor, tx: h.tx, ty: h.ty, tMs: h.tMs, __hero: h.hero,
    __heroLevel: h.level ?? 1,
    ...(h.loadout ? { __heroLoadout: h.loadout } : {}),
  }));
  const attackerArmyGear = armyModifiers((orders.heroDeploys ?? []).map((h) => h.loadout));
  const deploys: AnyDeploy[] = ([...orders.deploys, ...heroPseudo] as AnyDeploy[]).sort(
    (a, b) => a.tMs - b.tMs || a.tx - b.tx || a.ty - b.ty
      || (a.__hero ? 1 : 0) - (b.__hero ? 1 : 0),
  );
  const occupied = occupiedBattlefieldTiles(buildings);
  // Runtime spawners/landings still consult living buildings. Deployment uses
  // the separate frozen set above so late reserves cannot reuse destroyed plots.
  const onBuilding = (tx: number, ty: number): boolean =>
    buildings.some((b) => !b.destroyed && tx >= b.tx && tx < b.tx + b.fw && ty >= b.ty && ty < b.ty + b.fh);
  deploys.forEach((d: DeployOrder) => {
    if (!(d as AnyDeploy).__hero && !isTrainableTroop(d.troop)) {
      throw new SimInputError(`troop cannot be deployed directly: ${d.troop}`);
    }
    if (!isBattlefieldTileDeployable(d.tx, d.ty, snapshot, occupied)) {
      throw new SimInputError(`deploy outside the deploy zone: (${d.tx},${d.ty})`);
    }
    // A deploy may land at ANY point in the battle, not only inside the pre-battle
    // window: the loop at `1) deploys scheduled for this tick` already schedules by
    // tMs across all MAX_TICKS, and the owner wants remaining troops committable
    // during the fight (2026-07-26). RAID_RULES.deployWindowSec is the CLIENT's
    // pre-battle countdown before auto-commit — never a cap on landing time.
    // This only WIDENS what is accepted, so no previously-valid replay changes.
    const tick = Math.floor(d.tMs / 100);
    if (tick < 0 || tick >= MAX_TICKS) throw new SimInputError(`deploy outside the battle: ${d.tMs}ms`);
  });

  const buffDmgNum = orders.buffs?.warhorn ? Math.round(BUFFS.warhorn.troopDamageMult * 100) : 100;
  const buffSpdNum = orders.buffs?.swiftboots ? Math.round(BUFFS.swiftboots.troopSpeedMult * 100) : 100;
  const powderMultNum = orders.buffs?.powdercharge ? Math.round(BUFFS.powdercharge.wallDamageMult * 100) : 100;
  const rallyTick = orders.rally ? Math.floor(orders.rally.tMs / 100) : -1;
  const rallyMultNum = Math.round(RALLY.speedAndDamageMult * 100);
  const rallyRadius2 = Math.floor(RALLY.radiusTiles * UNITS_PER_TILE) ** 2;
  const rallyDurTicks = RALLY.durationSec * 10;

  const troops: TState[] = [];
  const projectiles: Projectile[] = [];
  /** Z1 — live lingering DoTs, drained in insertion order (pass 4c). */
  const dots: Dot[] = [];
  const burnFields: BurnField[] = [];
  const scheduledTroopEffects: ScheduledTroopEffect[] = [];
  const scheduledTroopImpacts: ScheduledTroopImpact[] = [];
  let nextDeploy = 0;
  let destroyedDeci = 0;
  let starsEmitted = 0;
  let keepDestroyed = false;

  // Defender heroes are frozen into the base snapshot and exist from tick zero.
  // Omission preserves every pre-SIM7 replay byte and actor id.
  const seenDefenders = new Set<'vex' | 'theodor'>();
  for (const h of snapshot.defenderHeroes ?? []) {
    if (seenDefenders.has(h.hero)) throw new SimInputError(`duplicate defender hero: ${h.hero}`);
    seenDefenders.add(h.hero);
    if (!HERO_DEFENCE.enabled[h.hero]) continue;
    if (!Number.isInteger(h.guardTx) || !Number.isInteger(h.guardTy)
      || !inPlot(h.guardTx, h.guardTy)) {
      throw new SimInputError(`defender hero guard out of bounds: ${h.hero}`);
    }
    const level = Math.max(1, Math.min(HERO_LEVELING.maxLevel, h.level));
    const x = tileCenter(h.guardTx), y = tileCenter(h.guardTy);
    const modifiers = normalizedModifiers(h.loadout);
    const baseHp = Math.floor((HERO_LEVELING.hp[h.hero][level - 1]! * HERO_DEFENCE.statPct) / 100);
    const baseDps = Math.floor((HERO_LEVELING.dps[h.hero][level - 1]! * HERO_DEFENCE.statPct) / 100);
    const hp = applyBps(baseHp, modifiers?.hero_hp_bps ?? 0);
    const dps = applyBps(baseDps, modifiers?.hero_damage_bps ?? 0);
    const abilityDps = applyBps(baseDps,
      (modifiers?.hero_damage_bps ?? 0) + (modifiers?.ability_damage_bps ?? 0));
    const id = troops.length;
    const combat = heroCombat(h.hero);
    troops.push({
      id, type: HERO_COMBAT[h.hero].donor, level, hero: h.hero, skillReadyAt: {},
      ...(modifiers ? { combatModifiers: modifiers, abilityDpsDeci: abilityDps,
        firstHitAvailable: modifiers.first_hit_reduction_bps > 0 } : {}),
      side: 'defender', spawnTick: 0, fromNest: -1, guardX: x, guardY: y,
      x, y, hpDeci: hp * 10, maxHpDeci: hp * 10, phase: 'guarding',
      targetB: -1, blockedWall: -1, routing: 0, kegWall: -1, breachWall: -1,
      emergeLeft: 0, burrowedUnits: 0, dpsDeci: dps,
      unitsPerTick: applyBps(combat.unitsPerTick, modifiers?.move_speed_bps ?? 0),
      rangeUnits: combat.rangeUnits,
    });
    events.push({ t: 0, e: 'deploy', id, troop: HERO_COMBAT[h.hero].donor,
      hero: h.hero, side: 'defender', x, y });
  }

  // --- helpers ------------------------------------------------------------

  const destructionPct = (): number => {
    if (destroyedDeci >= totalDestructibleDeci) return 100;
    return Math.floor((destroyedDeci * 100) / totalDestructibleDeci);
  };

  const emitStars = (t: number): void => {
    const s = computeStars(destructionPct(), keepDestroyed);
    while (starsEmitted < s) {
      starsEmitted++;
      events.push({ t, e: 'star', n: starsEmitted as 1 | 2 | 3 });
    }
  };

  /** Returns the CLAMPED damage actually dealt (never overkill), so a caller can
   *  take a percentage of real damage — lifesteal on a dying wall must heal for
   *  the sliver that landed, not the whole swing. Purely additive: every existing
   *  caller ignores the value and the arithmetic is unchanged. */
  /** The hole is open (D-099): every unit committed to THIS segment walks
   *  through it along the fresh field. Nobody else is touched — a unit
   *  committed to a different breach keeps chewing (walking over would be the
   *  reversal the owner reported), and an uncommitted unit prices the new hole
   *  when it is next blocked. Replaces the SIM7 reset that re-planned every
   *  same-side unit whenever the elected breach fell. Whoever opened the wall
   *  — the chewers, a keg, a dash, Brown Note — the effect is the same. */
  const breachOpened = (wi: number): void => {
    for (const o of troops) {
      if (o.breachWall !== wi) continue;
      unblock(o);
      o.routing = 1;
    }
  };

  const damageBuilding = (t: number, bi: number, dmgDeci: number): number => {
    const b = buildings[bi]!;
    if (b.destroyed || isTrapType(b.type)) return 0;
    const applied = Math.min(b.hpDeci, dmgDeci);
    b.hpDeci -= applied;
    if (b.countsForDestruction) destroyedDeci += applied;
    if (b.hpDeci <= 0) {
      b.destroyed = true;
      events.push({ t, e: 'destroyed', id: b.id });
      if (b.type === BuildingType.Keep) keepDestroyed = true;
      if (b.type === BuildingType.Wall) { rebuildWalls(); breachOpened(bi); }
      emitStars(t);
    }
    return applied;
  };

  /**
   * SIM14: publish a hero basic swing's building damage as a `hit` (tester
   * report 2026-09-04: `heroAttack` carries no amount, and the client's building
   * HP mirror moves on `hit` alone, so a hero-only assault kept the bar full
   * until `destroyed`). Pushed BEFORE damageBuilding so it precedes any
   * `destroyed`. The amount is the whole-HP step the sim's own ceil-rounded HP
   * takes (the outcome's `hp` convention) rather than round(applied / 10): the
   * committed wall chew publishes every 100 ms tick, and rounding a 38-deci tick
   * to 4 drifts the mirror ~5 %, emptying the bar four ticks before the segment
   * actually falls. This form keeps the client mirror equal to the sim's HP
   * after every swing and empties it exactly on the destroying tick.
   */
  const publishHeroSwingHit = (t: number, bi: number, dmgDeci: number): void => {
    const b = buildings[bi]!;
    const after = Math.max(0, b.hpDeci - dmgDeci);
    events.push({ t, e: 'hit', target: b.id, dmg: Math.ceil(b.hpDeci / 10) - Math.ceil(after / 10) });
  };

  /** True while a unit may neither be targeted nor damaged nor act (Z3). Only
   *  heroes ever set the field, so this is `false` for every troop. */
  const untargetable = (u: TState, t: number): boolean =>
    u.untargetableUntil !== undefined && t < u.untargetableUntil;

  /**
   * Damage reduction the VICTIM carries, as an integer percent chain applied
   * multiplicatively. Theodor's SKILL ISSUE (−20/30/35/40% from L8) and BELLY
   * BOUNCE's self-DR (−5/8/10/12% from L11) are both permanent passives, so they
   * are read off level rather than stored. Returns the input unchanged for every
   * non-hero — all existing damage is byte-identical.
   */
  const mitigate = (tr: TState, dmgDeci: number): number => {
    let d = dmgDeci;
    if (tr.hero) {
      const gearDr = tr.combatModifiers?.incoming_damage_reduction_bps ?? 0;
      if (gearDr !== 0) d = Math.floor((d * (10_000 - gearDr)) / 10_000);
      if (tr.firstHitAvailable) {
        d = Math.floor((d * (10_000
          - (tr.combatModifiers?.first_hit_reduction_bps ?? 0))) / 10_000);
        tr.firstHitAvailable = false;
      }
    }
    if (tr.hero !== 'theodor') return d;
    const i = heroTier(tr.level) - 1;
    const si = HERO_SKILLS.theodor.skillIssue;
    if (tr.level >= si.unlockLevel) d = Math.floor((d * (100 - si.dmgTakenReductionPct[i]!)) / 100);
    const bb = HERO_SKILLS.theodor.bellyBounce;
    if (tr.level >= bb.unlockLevel) d = Math.floor((d * (100 - bb.selfDrPct[i]!)) / 100);
    return d;
  };

  const abilityDpsOf = (tr: TState): number => tr.abilityDpsDeci ?? tr.dpsDeci;
  const wallAdjusted = (tr: TState, bi: number, dmgDeci: number): number =>
    buildings[bi]?.type === BuildingType.Wall && tr.hero
      ? applyBps(dmgDeci, tr.combatModifiers?.wall_damage_bps ?? 0)
      : dmgDeci;

  /** Once-per-battle bookkeeping with ZERO new state: a cooldown parked past the
   *  end of the battle can never come ready again. */
  const onceAvailable = (tr: TState, k: string): boolean => (tr.skillReadyAt?.[k] ?? 0) <= MAX_TICKS;
  const markUsedOnce = (tr: TState, k: string): void => { (tr.skillReadyAt ??= {})[k] = MAX_TICKS + 1; };

  /**
   * On-lethal-damage hooks — RAGE QUIT (Theodor, L17: the first death is a lie)
   * and DOUBLE OR NOTHING (Vex, L15: a coin decides). Returns true when the unit
   * survives what would have killed it.
   *
   * This is the ONLY correct site. Lethal damage arrives from projectiles in pass
   * 6 and from DoTs in pass 4c, neither of which pass 4b can intercept — and
   * `damageTroop` is the single choke point every one of them funnels through.
   */
  const cheatDeath = (t: number, tr: TState): boolean => {
    if (tr.hero === 'theodor') {
      const s = HERO_SKILLS.theodor.rageQuit;
      if (tr.level >= s.unlockLevel && onceAvailable(tr, 'rageQuit')) {
        markUsedOnce(tr, 'rageQuit');
        tr.hpDeci = Math.floor((tr.maxHpDeci * s.fakeDeathHpPct) / 100);
        tr.untargetableUntil = t + s.untargetableSec * TICKS_PER_SEC;
        events.push({ t, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
          skill: 'rageQuit', phase: 'fakeDeath', x: tr.x, y: tr.y, until: tr.untargetableUntil });
        return true;
      }
    } else if (tr.hero === 'vex') {
      const s = HERO_SKILLS.vex.doubleOrNothing;
      const revive = s.reviveHpPct[heroTier(tr.level) - 1]!;
      if (tr.level >= s.unlockLevel && revive > 0 && onceAvailable(tr, 'doubleOrNothing')) {
        markUsedOnce(tr, 'doubleOrNothing');
        const heads = coinRng.nextInt(100) < s.headsPct;
        // The coin RESULT is reported as two distinct skill names: the client
        // needs them for the fx, and TAILS is how the server will learn to comp
        // half the regen timer (`tailsRegenRefundPct` — no downed-hero state
        // exists server-side yet, so today the sim only has to say it happened).
        events.push({ t, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
          skill: heads ? 'doubleOrNothingHeads' : 'doubleOrNothingTails',
          phase: heads ? 'heads' : 'tails', x: tr.x, y: tr.y,
          ...(!heads ? { refundPct: s.tailsRegenRefundPct[heroTier(tr.level) - 1]! } : {}) });
        if (heads) {
          tr.hpDeci = Math.floor((tr.maxHpDeci * revive) / 100);
          tr.untargetableUntil = t + s.immuneSec * TICKS_PER_SEC;
          return true;
        }
      }
    }
    return false;
  };

  /** Returns the CLAMPED damage actually dealt (see damageBuilding). */
  const damageTroop = (
    t: number, ti: number, dmgDeci: number, emitHit: boolean,
    sourceId?: number, melee = false,
  ): number => {
    const tr = troops[ti]!;
    if (tr.phase === 'dead') return 0;
    if (untargetable(tr, t)) return 0; // playing dead / post-revive immunity
    const dmg = mitigate(tr, dmgDeci);
    const applied = Math.min(tr.hpDeci, dmg);
    tr.hpDeci -= dmg;
    // Report what LANDED, not what was thrown: the client HP mirror must track the
    // mitigated number or Theodor's bars drift the moment SKILL ISSUE is up.
    if (emitHit) events.push({ t, e: 'hit', target: ti, dmg: Math.round(dmg / 10) });
    if (tr.hpDeci <= 0 && tr.detonationTick !== undefined) {
      // Once the reached-target fuse is visible it is authoritative. Keep one
      // internal HP until the synchronized blast resolves next tick.
      tr.hpDeci = 1;
    } else if (tr.hpDeci <= 0 && !cheatDeath(t, tr)) {
      tr.phase = 'dead';
      events.push({ t, e: 'troopDeath', id: ti });
    }
    if (melee && sourceId !== undefined && applied > 0 && tr.hero === 'theodor') {
      const belly = HERO_SKILLS.theodor.bellyBounce;
      const tier = heroTier(tr.level) - 1;
      const pct = tr.level >= belly.unlockLevel ? belly.reflectPct[tier]! : 0;
      const source = troops[sourceId];
      if (pct > 0 && source && source.side !== tr.side && source.phase !== 'dead') {
        const reflected = Math.floor((applied * pct) / 100);
        if (reflected > 0) damageTroop(t, source.id, reflected, true);
        const push = belly.knockbackTiles[tier]! * UNITS_PER_TILE;
        if (push > 0 && source.hpDeci > 0) {
          const dx = source.x - tr.x, dy = source.y - tr.y;
          const desired = stepToward(source, source.x + dx, source.y + dy, push);
          const tx = unitToTile(desired.nx), ty = unitToTile(desired.ny);
          if (inPlot(tx, ty)
            && (behaviorOf(source).isFlying || wallAt(desired.nx, desired.ny) < 0)
            && !onBuilding(tx, ty)) {
            source.x = desired.nx; source.y = desired.ny;
            events.push({ t, e: 'pos', id: source.id, x: source.x, y: source.y });
          }
        }
        events.push({ t, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
          skill: 'bellyBounce', phase: 'reflect', x: tr.x, y: tr.y, target: source.id });
      }
    }
    return applied;
  };

  /** Starts one complete authored body cycle and schedules damage only at its
   * visible contact(s). Live simulation deliberately publishes an immutable
   * count-one run: a later accepted command may change the future, so extending
   * an older record would violate the byte-identical prefix contract. The run
   * vocabulary still permits bounded archival batching and safe resume. */
  const startTroopAttack = (
    t: number, tr: TState, targetKind: 'troop' | 'building', targetIndex: number,
    target: number | string, ix: number, iy: number, dmgDeci: number, siegeThrow = false,
  ): void => {
    if (tr.hero || tr.side === 'defender') return;
    const timing = authoredAttackTiming(
      tr.type as Exclude<TroopType, 'wyrmling'>, targetKind, siegeThrow,
    );
    const run: AttackRunEvent = { t, e: 'attackRun', id: tr.id, side: tr.side,
      troop: tr.type, targetKind, target, ix, iy, mode: timing.mode,
      technique: timing.technique, cycleMs: timing.cycleMs,
      releaseOffsetMs: timing.releaseOffsetMs, cycleTicks: timing.cycleTicks,
      releaseOffsetTicks: timing.releaseOffsetTicks,
      impactOffsetsTicks: [...timing.impactOffsetsTicks],
      cadenceTicks: timing.cadenceTicks, count: 1 };
    // Never mutate a published earlier record: live mid-battle commands require
    // every event prefix before the command tick to stay byte-identical.
    events.push(run);
    const payload = attackPayloadDeci(dmgDeci, timing.cadenceTicks);
    const split = splitAttackPayloadDeci(payload, timing.impactOffsetsTicks.length);
    const projectile = timing.mode === 'projectile';
    for (let i = 0; i < timing.impactOffsetsTicks.length; i++) {
      scheduledTroopImpacts.push({ tick: t + timing.impactOffsetsTicks[i]!, source: tr.id,
        releaseTick: t + timing.releaseOffsetTicks,
        released: !projectile || timing.releaseOffsetTicks === 0,
        targetKind, targetIndex, dmgDeci: split[i]!, melee: timing.mode === 'melee',
        requiresLiveSource: !projectile });
    }
    tr.attackReadyAt = t + timing.cadenceTicks;
    tr.actionUntil = t + timing.cycleTicks;
  };

  /** Nearest alive building matching filter; ties → lower index. */
  const nearestBuilding = (x: number, y: number, filter: (b: BState) => boolean): number => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i]!;
      if (b.destroyed || !filter(b)) continue;
      const d = dist2ToRect(x, y, b.tx, b.ty, b.fw, b.fh);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  /** Nearest live OPPOSITE-side troop to (x,y), ties → lower id, within maxD2 (attack
   *  range²). Powers troop-vs-troop combat: defender wyrmlings hunt attackers, and
   *  attackers retaliate on wyrmlings in range. Burrowed troops are untargetable. */
  const nearestEnemyTroop = (t: number, side: 'attacker' | 'defender', x: number, y: number, maxD2 = Infinity): number => {
    let best = -1, bestD = Infinity;
    for (const o of troops) {
      if (o.phase === 'dead' || o.phase === 'burrowed' || o.side === side) continue;
      if (untargetable(o, t)) continue; // RAGE QUIT: he is lying on the floor
      const d = dist2(x, y, o.x, o.y);
      if (d <= maxD2 && d < bestD) { bestD = d; best = o.id; }
    }
    return best;
  };

  const isDefense = (b: BState): boolean => b.def !== null || b.type === BuildingType.DragonNest;
  const isResource = (b: BState): boolean =>
    b.type === BuildingType.Vault || b.type === BuildingType.Mine;
  const isTargetable = (b: BState): boolean =>
    b.type !== BuildingType.Wall && !isTrapType(b.type);

  /**
   * The NEAREST live breach on the unit's side (D-099, owner 2026-09-02): a
   * wall some same-side unit — hero or troop — is committed to opening, still
   * standing, measured from the asking unit itself; ties go to the lower wall
   * index. SIM7 published ONE breach per side, the lowest troop id's wall, and
   * pulled every blocked ally to it: a unit twelve tiles from that segment
   * walked the perimeter to regroup, and when the segment fell every ally was
   * re-planned. The concentration the owner asked for on 2026-07-26 (one hole,
   * the army through it) now comes from decideAtWall PRICING the join instead
   * of imposing it, so the hole is joined when joining is faster and opened
   * beside when it is not.
   */
  const nearestLiveBreach = (self: TState): number => {
    let best = -1, bestD = Infinity;
    for (const o of troops) {
      if (o.side !== self.side || o.phase === 'dead' || o.phase === 'burrowed') continue;
      const wi = o.breachWall;
      if (wi < 0 || buildings[wi]!.destroyed) continue;
      const w = buildings[wi]!;
      const d = dist2ToRect(self.x, self.y, w.tx, w.ty, w.fw, w.fh);
      if (d < bestD || (d === bestD && wi < best)) { bestD = d; best = wi; }
    }
    return best;
  };

  /**
   * DECIDE ONCE AT THE WALL (D-099; owner 2026-09-02: "Giants/Theodor turn back
   * at walls"). The blocked branch used to re-run the gap check every tick and
   * re-elect the side breach, so a unit could step toward a gap, be pulled to
   * the breach, step out again — reversals a 90-second battle cannot afford.
   * The FIRST tick a grounded unit is blocked it prices both answers in ticks
   * and commits:
   *
   *   detour = wall-free field distance to the target's goal tiles at its own
   *            speed (Infinity when every route from here crosses a wall);
   *   breach = walk into reach of the wall
   *          + ceil(wall hp / its own per-tick wall damage, buildingDamageMult
   *            included)
   *          + the tiles still between that wall and the target once the hole
   *            is open (through the segment, then as the crow walks).
   *
   * The breach candidate is its own blocking wall, or the nearest live breach
   * on its side when joining that hole is no dearer (see nearestLiveBreach).
   * breach <= detour commits `breachWall`; otherwise the unit routes along the
   * field (`routing`). The choice is re-made only when the target dies
   * (pickTarget), the committed wall falls (breachOpened) or a teleport clears
   * the block (unblock). Walls only ever fall, so a chosen detour can only get
   * shorter and needs no re-check. Heroes decide exactly like troops — the
   * SIM6 habit of following a moving ally to its wall is gone.
   *
   * Integer throughout: isqrt for the one true distance, ceilings by
   * (n + d - 1) / d. Ranged units subtract the whole tiles of their reach.
   */
  const ticksToCover = (units: number, step: number): number =>
    units <= 0 ? 0 : Math.floor((units + step - 1) / step);
  /** Whole tiles between two footprints along each axis (0 when they touch). */
  const tilesBetween = (a: BState, c: BState): number =>
    Math.max(0, c.tx - (a.tx + a.fw), a.tx - (c.tx + c.fw))
    + Math.max(0, c.ty - (a.ty + a.fh), a.ty - (c.ty + c.fh));
  const decideAtWall = (tr: TState, dmgDeci: number, step: number): void => {
    const tgt = buildings[tr.targetB]!;
    const rangeTiles = Math.floor(tr.rangeUnits / UNITS_PER_TILE);
    const perTick = Math.max(1, wallAdjusted(tr, tr.blockedWall,
      dmgDeci * (behaviorOf(tr).buildingDamageMult ?? 1)));
    const breachTicks = (wi: number): number => {
      const w = buildings[wi]!;
      const approach = isqrt(dist2ToRect(tr.x, tr.y, w.tx, w.ty, w.fw, w.fh)) - tr.rangeUnits;
      const chew = Math.floor((w.hpDeci + perTick - 1) / perTick);
      const after = Math.max(0, 1 + tilesBetween(w, tgt) - rangeTiles);
      return ticksToCover(approach, step) + chew + ticksToCover(after * UNITS_PER_TILE, step);
    };
    const f = fieldFor(tr.targetB)[clampTile(tr.x, tr.y)]!;
    const detour = f >= WALL_COST
      ? Infinity
      : ticksToCover(Math.max(0, f - rangeTiles) * UNITS_PER_TILE, step);
    let wall = tr.blockedWall;
    let cost = breachTicks(wall);
    const join = nearestLiveBreach(tr);
    if (join !== -1 && join !== wall) {
      const joinCost = breachTicks(join);
      if (joinCost <= cost) { wall = join; cost = joinCost; }
    }
    if (cost <= detour) {
      tr.breachWall = wall;
      tr.blockedWall = wall;
    } else {
      tr.routing = 1;
    }
  };

  /** Whether `tr` has a deterministic way to make progress against a non-wall
   *  building right now. Favorite target classes are a PRIORITY, never a lock:
   *  an enclosed out-of-reach favorite must not strand a unit while an exposed
   *  fallback exists. Openers/burrowers/fliers can still commit to the favorite
   *  because their declared wall policy provides the route. */
  const targetReachable = (tr: TState, bi: number): boolean => {
    const b = buildings[bi]!;
    const s = behaviorOf(tr);
    if (s.isFlying || s.burrowsUnderWalls || s.wallPolicy === 'break') return true;
    const reach = reachFor(tr.rangeUnits, s.siegeThrow, isDefense(b));
    if (dist2ToRect(tr.x, tr.y, b.tx, b.ty, b.fw, b.fh) <= reach * reach) return true;
    if (fieldFor(bi)[clampTile(tr.x, tr.y)]! < WALL_COST) return true;
    return nearestLiveBreach(tr) !== -1;
  };

  /** Nearest reachable building matching filter; ties stay in snapshot order. */
  const nearestReachableBuilding = (tr: TState, filter: (b: BState) => boolean): number =>
    nearestBuilding(tr.x, tr.y, (b) => {
      if (!filter(b)) return false;
      const bi = buildings.indexOf(b);
      return bi >= 0 && targetReachable(tr, bi);
    });

  const pickTarget = (tr: TState): void => {
    const s = behaviorOf(tr);
    let preferred: ((b: BState) => boolean) | undefined;
    if (s.aiTarget === 'defenses') preferred = isDefense;
    else if (s.aiTarget === 'resources') preferred = isResource;
    else if (s.aiTarget === 'mines') preferred = (b) => b.type === BuildingType.Mine;
    else if (s.aiTarget === 'buildings' || s.aiTarget === 'nearest') preferred = isTargetable;

    // Exact hierarchy: reachable favorite (defence-seekers: priced against the
    // nearest defence behind masonry, SIM16 below) → reachable ordinary
    // structure → the nearest favorite behind masonry → any remaining
    // structure → live wall.
    // A structure stays the strategic target while the `blockedWall` branch
    // makes the encountered wall the tactical fallback; hero wall skills key
    // off that distinction. `walls` remains the keg's route-planning role:
    // kegPath selects the breach.
    //
    // D-099 (owner 2026-09-02): a defence-seeker never trades a sealed defence
    // for an open ordinary building — the tank walks AT the guns and breaches
    // toward them; the Keep and the rest are its fallback only once no defence
    // stands. Other favourites (resources, mines) keep the exposed-fallback
    // step: a plunderer with an open Vault beside a sealed Mine should loot.
    let bi = preferred ? nearestReachableBuilding(tr, preferred) : -1;
    if (preferred && s.aiTarget === 'defenses') {
      // SIM16 (owner relaying players 2026-09-17: giants "going to another
      // place when a target is nearby"). "Reachable first" let ANY open defence
      // — thirteen tiles off — beat a sealed one four tiles from the drop, so
      // the tank marched away from the gun beside him. A sealed defence is now
      // priced as its distance plus SIM_TARGETING.sealedDefenceAllowanceTiles
      // (a breach allowance) and the cheaper defence wins; equal cost keeps the
      // open one. When no defence is reachable the nearest sealed one is still
      // the target (D-099 unchanged). Byte-identical for fliers, burrowers and
      // wall-breakers: targetReachable is always true for them.
      const sealed = nearestBuilding(tr.x, tr.y, preferred);
      if (sealed !== -1 && sealed !== bi) {
        if (bi === -1) bi = sealed;
        else {
          const sb = buildings[sealed]!, rb = buildings[bi]!;
          const sealedCost = isqrt(dist2ToRect(tr.x, tr.y, sb.tx, sb.ty, sb.fw, sb.fh))
            + SIM_TARGETING.sealedDefenceAllowanceTiles * UNITS_PER_TILE;
          if (sealedCost < isqrt(dist2ToRect(tr.x, tr.y, rb.tx, rb.ty, rb.fw, rb.fh))) bi = sealed;
        }
      }
    }
    if (bi === -1) bi = nearestReachableBuilding(tr, isTargetable);
    if (bi === -1 && preferred) bi = nearestBuilding(tr.x, tr.y, preferred);
    if (bi === -1) bi = nearestBuilding(tr.x, tr.y, isTargetable);
    if (bi === -1) bi = nearestBuilding(tr.x, tr.y, (b) => b.type === BuildingType.Wall);
    tr.targetB = bi;
    // Keg carriers pick the wall opening the army's cheapest path. Gated on the
    // BEHAVIOUR flag, not the type string: only a unit that self-destructs has a
    // keg to place (TROOPS.kegrunner is the sole troop with it, so this is
    // byte-identical for troops).
    if (s.selfDestructs) {
      tr.kegWall = -1;
      if (bi !== -1) {
        const b = buildings[bi]!;
        const goals = new Set<number>();
        for (let gy = Math.max(plotMin, b.ty - 1); gy < Math.min(plotMax, b.ty + b.fh + 1); gy++) {
          for (let gx = Math.max(plotMin, b.tx - 1); gx < Math.min(plotMax, b.tx + b.fw + 1); gx++) {
            goals.add(plotIndex(gx, gy));
          }
        }
        // Clamp the keg's start tile into the plot grid: a keg deployed in the
        // surrounding field enters at the nearest edge tile, so Dijkstra
        // always begins from a valid in-grid cell.
        const start = clampTile(tr.x, tr.y);
        const res = kegPath(pathGrid, start, goals);
        tr.kegWall = res.wallBuildingIndex;
      }
    }
  };

  /** Detonate the keg runner: cross blast centered on `ctx,cty` (GDD §3.2/§14). */
  const detonate = (t: number, ti: number, ctx: number, cty: number): void => {
    const tr = troops[ti]!;
    const cross = [
      [ctx, cty], [ctx, cty - 1], [ctx, cty + 1], [ctx - 1, cty], [ctx + 1, cty],
    ] as const;
    // MAGNITUDE from the ACTING unit's behaviour data, never from TROOPS.kegrunner:
    // a hero that declares `selfDestructs` but no `wallBurst` bursts for 0 rather
    // than inheriting a keg runner's 900 on a hero's level curve. Byte-identical
    // for a real keg runner (its own wallBurst, and dpsDeci IS the level-scaled dps).
    const splashDeci = kegSplashDeci(tr.dpsDeci);
    const wallDmg = Math.floor((kegWallBurstDeci(behaviorOf(tr).wallBurst ?? 0, tr.level) * powderMultNum) / 100);
    const hitBuildings = new Set<number>();
    for (const [cx, cy] of cross) {
      if (!inPlot(cx, cy)) continue;
      const wi = wallIdx[plotIndex(cx, cy)]!;
      if (wi >= 0) {
        events.push({ t, e: 'hit', target: buildings[wi]!.id, dmg: Math.round(wallDmg / 10) });
        damageBuilding(t, wi, wallDmg);
      }
      // splash to non-wall buildings overlapping a cross tile
      for (let i = 0; i < buildings.length; i++) {
        const b = buildings[i]!;
        if (b.destroyed || b.type === BuildingType.Wall || isTrapType(b.type) || hitBuildings.has(i)) continue;
        if (cx >= b.tx && cx < b.tx + b.fw && cy >= b.ty && cy < b.ty + b.fh) {
          hitBuildings.add(i);
          events.push({ t, e: 'hit', target: b.id, dmg: Math.round(splashDeci / 10) });
          damageBuilding(t, i, splashDeci);
        }
      }
    }
    tr.phase = 'dead';
    delete tr.detonationTick;
    events.push({ t, e: 'troopDeath', id: ti });
  };

  const beginDetonation = (t: number, tr: TState, ctx: number, cty: number): void => {
    const timing = authoredAttackTiming('kegrunner', 'building');
    const x = tileCenter(ctx), y = tileCenter(cty);
    events.push({ t, e: 'detonate', id: tr.id, x, y });
    events.push({ t, e: 'attackRun', id: tr.id, side: tr.side, troop: 'kegrunner',
      targetKind: 'building', target: tr.kegWall >= 0 ? buildings[tr.kegWall]!.id : buildings[tr.targetB]!.id,
      ix: x, iy: y, mode: timing.mode, technique: timing.technique,
      cycleMs: timing.cycleMs, releaseOffsetMs: timing.releaseOffsetMs,
      cycleTicks: timing.cycleTicks, releaseOffsetTicks: timing.releaseOffsetTicks,
      impactOffsetsTicks: [...timing.impactOffsetsTicks], cadenceTicks: timing.cadenceTicks, count: 1 });
    tr.phase = 'attacking';
    tr.actionUntil = t + timing.cycleTicks;
    tr.detonationTick = t + timing.impactOffsetsTicks[0]!;
    scheduledTroopEffects.push({ tick: tr.detonationTick, kind: 'detonate',
      source: tr.id, ctx, cty });
  };

  /** Mage attacker AoE: full damage to every live non-trap building (walls incl.)
   *  within `radiusUnits` of (cx,cy). A hitBuildings Set prevents a building being
   *  double-counted toward destruction (mirrors detonate). */
  const damageBuildingsInRadius = (
    t: number, cx: number, cy: number, radiusUnits: number, dmgDeci: number,
    source?: TState,
  ): void => {
    const r2 = radiusUnits * radiusUnits;
    const hitBuildings = new Set<number>();
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i]!;
      if (b.destroyed || isTrapType(b.type) || hitBuildings.has(i)) continue;
      if (dist2ToRect(cx, cy, b.tx, b.ty, b.fw, b.fh) <= r2) {
        hitBuildings.add(i);
        const applied = source ? wallAdjusted(source, i, dmgDeci) : dmgDeci;
        events.push({ t, e: 'hit', target: b.id, dmg: Math.round(applied / 10) });
        damageBuilding(t, i, applied);
      }
    }
  };

  /** Last-resort contact with a blocking wall still uses the troop's real
   * attack technique. Favorite-target fallback must not turn a Mage into an
   * invisible melee unit or make a Hexbarrow silently grind masonry: ranged
   * units publish their ordinary fire cue, and Mage splash keeps its authored
   * radius around the wall contact point. Called only when the cadence clock is
   * ready, so this adds no second damage path. */
  const attackBlockingWall = (
    t: number, tr: TState, wi: number, dmgDeci: number, interval: number,
  ): void => {
    const s = behaviorOf(tr);
    const m = mechanicsOf(tr);
    const wall = buildings[wi]!;
    const q = closestPointOnRect(tr.x, tr.y, wall.tx, wall.ty, wall.fw, wall.fh);
    if (tr.hero) {
      // Presentation-only: heroes already apply this exact wall damage below,
      // but unlike their ordinary building branch the committed breach used to
      // publish no body cue at all and looked inert for the whole wall chew.
      events.push({ t, e: 'heroAttack', id: tr.id, hero: tr.hero, side: tr.side,
        targetKind: 'building', target: wall.id, ix: q.x, iy: q.y,
        recoveryUntil: t + interval });
    } else if (tr.side === 'attacker' && s.range !== 'melee'
      && (m.attackIntervalDeciSec !== undefined
        || (t - tr.spawnTick) % visualCueTicks === 0)) {
      events.push({ t, e: 'troopFire', id: tr.id, target: wall.id, ix: q.x, iy: q.y });
    }
    const attackDamageDeci = dmgDeci * interval;
    if (s.splashRadiusTiles) {
      damageBuildingsInRadius(
        t, q.x, q.y, Math.floor(s.splashRadiusTiles * UNITS_PER_TILE), attackDamageDeci,
      );
    } else {
      // SIM14: the chew's applied damage is published as an ordinary `hit`
      // (the splash branch above already does through damageBuildingsInRadius).
      // The client's HP mirror only moves on `hit`, so the committed segment
      // used to keep a full bar for the whole breach until `destroyed`. Only
      // heroes reach this branch today (the sole caller gates on tr.hero).
      const applied = wallAdjusted(tr, wi, attackDamageDeci * (s.buildingDamageMult ?? 1));
      publishHeroSwingHit(t, wi, applied);
      damageBuilding(t, wi, applied);
    }
  };

  /** Centre of a building's footprint, in units (the pattern pass 4b/5 inline). */
  const centerOf = (b: BState): { x: number; y: number } => ({
    x: tileCenter(b.tx) + ((b.fw - 1) * UNITS_PER_TILE) / 2,
    y: tileCenter(b.ty) + ((b.fh - 1) * UNITS_PER_TILE) / 2,
  });

  /**
   * MOONSUNDER WAVE's crescent — a stationary line sweep, and the shape Omega
   * Shardstorm fires eight of. Crimson Dash's integer stepping verbatim (one
   * truncated division of an integer product per sample), except the hero does
   * not move: everything the line crosses takes `dmgDeci`, walls and buildings
   * alike ("pierces everything"). WIDTH 2 samples a second parallel line, the two
   * offset ±half a tile along the perpendicular.
   *
   * COLLECT-THEN-APPLY: a wall dying mid-sweep calls rebuildWalls() and would
   * otherwise change what the rest of the same sweep sees. Sets iterate in
   * insertion order, so application order is fixed.
   *
   * Returns false — spending nothing — when the line would hit nothing at all, so
   * an autocast never burns its cooldown on empty ground.
   */
  const castCrescent = (
    t: number, tr: TState, dirX: number, dirY: number, dirLen: number,
    lengthUnits: number, widthTiles: number, dmgDeci: number, bleedPct: number,
  ): boolean => {
    if (dirLen <= 0 || lengthUnits <= 0) return false;
    const half = UNITS_PER_TILE / 2;
    const steps = Math.max(1, Math.floor(lengthUnits / half));
    // Perpendicular half-tile offset, integer. Width 1 = the centre line only.
    const px = Math.trunc((-dirY * half) / dirLen);
    const py = Math.trunc((dirX * half) / dirLen);
    const lines: ReadonlyArray<readonly [number, number]> =
      widthTiles >= 2 ? [[px, py], [-px, -py]] : [[0, 0]];
    const hitB = new Set<number>();
    const hitT = new Set<number>();
    for (const [ox, oy] of lines) {
      for (let st = 1; st <= steps; st++) {
        const nx = tr.x + ox + Math.trunc((dirX * st * lengthUnits) / (dirLen * steps));
        const ny = tr.y + oy + Math.trunc((dirY * st * lengthUnits) / (dirLen * steps));
        if (tr.side === 'attacker') {
          for (let bi = 0; bi < buildings.length; bi++) {
            const b = buildings[bi]!;
            if (b.destroyed || isTrapType(b.type) || hitB.has(bi)) continue;
            if (dist2ToRect(nx, ny, b.tx, b.ty, b.fw, b.fh) === 0) hitB.add(bi);
          }
        }
        for (const foe of troops) {
          if (foe.side === tr.side || foe.phase === 'dead' || hitT.has(foe.id)) continue;
          if (dist2(nx, ny, foe.x, foe.y) <= half * half) hitT.add(foe.id);
        }
      }
    }
    if (hitB.size === 0 && hitT.size === 0) return false;
    for (const bi of hitB) {
      const applied = wallAdjusted(tr, bi, dmgDeci);
      events.push({ t, e: 'hit', target: buildings[bi]!.id, dmg: Math.round(applied / 10) });
      damageBuilding(t, bi, applied);
    }
    const bleedSec = HERO_SKILLS.vex.moonsunderWave.bleedSec;
    for (const ti of hitT) {
      damageTroop(t, ti, dmgDeci, true);
      // BLEED is % of the victim's MAX HP over one 4s window (see constants).
      // Defender troops only — % max HP against buildings is a balance cliff
      // nobody signed off on (Q4).
      const victim = troops[ti]!;
      if (bleedPct <= 0 || victim.phase === 'dead') continue;
      const perTick = Math.floor((victim.maxHpDeci * bleedPct) / (100 * bleedSec * TICKS_PER_SEC));
      if (perTick > 0) {
        dots.push({ kind: 'troop', bi: -1, ti, cx: 0, cy: 0, r2: 0,
          dmgDeciPerTick: perTick, untilTick: t + bleedSec * TICKS_PER_SEC });
      }
    }
    return true;
  };

  /** DEGEN AWAKENING's damage bonus while the Z2 window is open, as an integer
   *  percent. `atkSpeedPct` is ADDED to `dmgPct` because this sim has no swing
   *  timer — the decision and its arithmetic live in constants.ts (Q5). */
  const degenPctOf = (tr: TState, t: number, key: 'dmg' | 'lifesteal'): number => {
    if (tr.hero !== 'vex' || (tr.buffUntil?.['degen'] ?? 0) <= t) return 0;
    const d = HERO_SKILLS.vex.degenAwakening;
    const i = heroTier(tr.level) - 1;
    return key === 'dmg' ? d.dmgPct[i]! + d.atkSpeedPct[i]! : d.lifestealPct[i]!;
  };

  /** Heal for a percentage of damage that ACTUALLY landed (never overkill),
   *  capped at the unit's own max HP. No-op at 0%, i.e. for everything but an
   *  awakened Vex. */
  const lifesteal = (tr: TState, t: number, applied: number, pct: number): void => {
    if (pct <= 0 || applied <= 0) return;
    const before = tr.hpDeci;
    tr.hpDeci = Math.min(tr.maxHpDeci, tr.hpDeci + Math.floor((applied * pct) / 100));
    const healed = tr.hpDeci - before;
    // EMIT IT. An independent mutation audit found damageTroop's damage CLAMP
    // unkillable: its only consumer is this heal, healing produced no event, and
    // the overkill difference was always erased by the next tick's cap. A heal
    // the player can see is also a heal a test can assert — and the client wants
    // the fx regardless (audit 2026-07-29, M09).
    if (healed > 0) events.push({ t, e: 'heal', id: tr.id, amount: Math.round(healed / 10) });
  };

  /** ±6% multiplicative jitter on defense damage (the sim's only rng use). */
  const jitter = (base: number, r: Rng): number => {
    const roll = r.nextInt(DMG_JITTER_PCT * 2 + 1) - DMG_JITTER_PCT;
    return Math.max(1, base + Math.trunc((base * roll) / 100));
  };

  const abilityReady = (tr: TState, key: string, at: number): boolean =>
    (tr.abilityReadyAt?.[key] ?? at) <= tick;
  const startAbilityCooldown = (tr: TState, key: string, readyAt: number): void => {
    (tr.abilityReadyAt ??= {})[key] = readyAt;
  };

  /** Spawn one Hexbarrow brood actor. The slot fixes both its visual variant and
   *  compass offset, so no RNG draw can re-phase defense damage jitter. */
  const spawnBarrowling = (t: number, source: TState, slot: number): void => {
    assertRepresentationLimits(troops.length + 1);
    const brood = TROOP_ABILITIES.hexbarrow.brood;
    const c = troopCombat('barrowling', source.level);
    const id = troops.length;
    const [vx, vy] = COMPASS8[slot % COMPASS8.length]!;
    const offset = Math.floor(brood.spawnRadiusTiles * UNITS_PER_TILE);
    // A parent may stop on the outermost legal deployment tile. Its half-tile
    // hatch offset must not create a child outside the expanded battlefield,
    // where no direct deploy can exist and replay cameras cannot follow it.
    const fieldMinUnit = fieldMin * UNITS_PER_TILE;
    const fieldMaxUnit = fieldMax * UNITS_PER_TILE - 1;
    const x = Math.max(fieldMinUnit, Math.min(fieldMaxUnit,
      source.x + Math.trunc((vx * offset) / UNITS_PER_TILE)));
    const y = Math.max(fieldMinUnit, Math.min(fieldMaxUnit,
      source.y + Math.trunc((vy * offset) / UNITS_PER_TILE)));
    const variant = slot % brood.variants;
    const tr: TState = {
      id, type: 'barrowling', level: source.level, side: 'attacker',
      spawnTick: t, fromNest: -1, fromSpawner: source.id,
      expiresTick: t + brood.lifespanSec * TICKS_PER_SEC, variant,
      x, y, hpDeci: c.hp * 10, maxHpDeci: c.hp * 10, phase: 'moving',
      targetB: -1, blockedWall: -1, routing: 0, kegWall: -1, breachWall: -1,
      emergeLeft: 0, burrowedUnits: 0,
      dpsDeci: c.dpsDeci, unitsPerTick: c.unitsPerTick, rangeUnits: c.rangeUnits,
    };
    troops.push(tr);
    events.push({ t, e: 'troopSpawn', id, from: source.id, troop: 'barrowling',
      level: source.level, variant, x, y });
    pickTarget(tr);
  };

  /** Cross the first contiguous live-wall strip on the line to (gx,gy), landing
   *  on the first clear non-building tile within the authored leap range. */
  const tryGloamLeap = (t: number, tr: TState, gx: number, gy: number): boolean => {
    const leap = mechanicsOf(tr).leap;
    if (!leap) return false;
    const range = Math.floor(leap.rangeTiles * UNITS_PER_TILE);
    const sample = UNITS_PER_TILE / 2; // fixed geometry resolution, not a tunable
    let crossedWall = false;
    for (let distance = sample; distance <= range; distance += sample) {
      const p = stepToward(tr, gx, gy, distance);
      if (wallAt(p.nx, p.ny) >= 0) { crossedWall = true; continue; }
      if (!crossedWall) continue;
      if (onBuilding(unitToTile(p.nx), unitToTile(p.ny))) continue;
      const ox = tr.x, oy = tr.y;
      tr.x = p.nx; tr.y = p.ny;
      unblock(tr);
      tr.routing = 0;
      tr.phase = 'moving';
      tr.actionUntil = t + leap.travelDeciSec;
      events.push({ t, e: 'troopAbility', id: tr.id, ability: 'leap', x: ox, y: oy, ix: tr.x, iy: tr.y });
      events.push({ t, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
      return true;
    }
    return false;
  };

  // --- main loop ----------------------------------------------------------

  let tick = 0;
  for (; tick < MAX_TICKS + RAID_REPLAY_LIMITS.postBattleDrainTicks; tick++) {
    const draining = tick >= MAX_TICKS;
    if (draining && projectiles.length === 0 && scheduledTroopImpacts.length === 0
      && scheduledTroopEffects.length === 0 && burnFields.length === 0 && dots.length === 0) break;

    // Release instants ceil onto this deterministic tick boundary. Commit them
    // before resolving contacts at the same boundary: a death this tick is not
    // "before release", while a source already dead from an earlier tick cancels.
    for (let i = scheduledTroopImpacts.length - 1; i >= 0; i--) {
      const impact = scheduledTroopImpacts[i]!;
      if (impact.released || impact.releaseTick > tick) continue;
      const source = troops[impact.source];
      if (!source || source.phase === 'dead') scheduledTroopImpacts.splice(i, 1);
      else impact.released = true;
    }
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const projectile = projectiles[i]!;
      if (projectile.released || projectile.releaseTick > tick) continue;
      if (buildings[projectile.fromB]?.destroyed) projectiles.splice(i, 1);
      else projectile.released = true;
    }

    // 1) deploys scheduled for this tick
    while (nextDeploy < deploys.length && Math.floor(deploys[nextDeploy]!.tMs / 100) <= tick) {
      const d = deploys[nextDeploy]!;
      // Clamp to the researched troop-level ceiling (owner 2026-07-20: 3 → 20 with
      // the L1-20 expansion). L≤3 is unaffected, so golden replays stay identical.
      const lv = Math.max(1, Math.min(TROOP_LEVELING.maxLevel, opts.troopLevels?.[d.troop] ?? 1));
      const c = troopCombat(d.troop, lv);
      const id = troops.length;
      // Hero override (D4a; completed 2026-07-29): the donor supplies the SPRITE
      // and nothing else. hp/dps come from the HERO_LEVELING integer table,
      // movement/reach from HERO_COMBAT via heroCombat(), and every behavioural
      // read goes through behaviorOf() — no formulas enter the sim.
      const hero = (d as { __hero?: 'vex' | 'theodor' }).__hero;
      // Hero level is the HERO's own (server-stamped from hero_levels), NEVER
      // the donor troop's research level — that leak once let L16 highlander
      // research buy T4 Crimson Dash. Index 0 of the HERO_LEVELING tables is
      // bit-identical to HERO_COMBAT, so an unlevelled hero replays as before.
      const hLv = hero
        ? Math.max(1, Math.min(HERO_LEVELING.maxLevel, (d as { __heroLevel?: number }).__heroLevel ?? 1))
        : 1;
      const modifiers = hero
        ? normalizedModifiers((d as AnyDeploy).__heroLoadout)
        : undefined;
      const baseHeroDps = hero ? HERO_LEVELING.dps[hero][hLv - 1]! : 0;
      const baseHp = hero ? HERO_LEVELING.hp[hero][hLv - 1]! : c.hp;
      const armyHpBps = hero ? 0 : attackerArmyGear.hpBps;
      const armyDamageBps = hero ? 0 : attackerArmyGear.damageBps;
      const tr: TState = {
        id, type: d.troop, level: hero ? hLv : lv, side: 'attacker', spawnTick: tick, fromNest: -1,
        ...(hero ? { hero, skillReadyAt: {},
          ...(modifiers ? { combatModifiers: modifiers,
            abilityDpsDeci: applyBps(baseHeroDps,
              modifiers.hero_damage_bps + modifiers.ability_damage_bps),
            firstHitAvailable: modifiers.first_hit_reduction_bps > 0 } : {}) } : {}),
        x: tileCenter(d.tx), y: tileCenter(d.ty),
        hpDeci: applyBps(baseHp, hero ? (modifiers?.hero_hp_bps ?? 0) : armyHpBps) * 10,
        maxHpDeci: applyBps(baseHp, hero ? (modifiers?.hero_hp_bps ?? 0) : armyHpBps) * 10,
        phase: 'moving',
        targetB: -1, blockedWall: -1, routing: 0, kegWall: -1, breachWall: -1,
        emergeLeft: 0, burrowedUnits: 0,
        // NO x10. `dpsDeci` is deci-damage per TICK (stats.ts: "dps points/sec ==
        // deci-points per 100ms tick"), so it is numerically the dps figure — that
        // is how every troop is built. Heroes were spawned with dps x 10, which is
        // deci per SECOND, and both heroes therefore hit for 10x their stat all the
        // way through D4a/D4b: an L1 Vex ran at 950 dps while the hero panel the
        // API serves him (game/heroes.ts) said 95. Found 2026-07-29 by tracing a
        // t3 wall dying in 13 ticks.
        dpsDeci: hero
          ? applyBps(baseHeroDps, modifiers?.hero_damage_bps ?? 0)
          : applyBps(c.dpsDeci, armyDamageBps),
        ...(hero ? {
          unitsPerTick: applyBps(heroCombat(hero).unitsPerTick, modifiers?.move_speed_bps ?? 0),
          rangeUnits: heroCombat(hero).rangeUnits,
        } : { unitsPerTick: c.unitsPerTick, rangeUnits: c.rangeUnits }),
      };
      troops.push(tr);
      assertRepresentationLimits(troops.length);
      events.push({ t: tick, e: 'deploy', id, troop: d.troop, x: tr.x, y: tr.y, ...(hero ? { hero } : {}) });
      pickTarget(tr);
      nextDeploy++;
    }

    // New-roster delayed effects resolve before anyone acts. Stable insertion
    // order is the tie-break for same-tick casts; no effect consumes either RNG.
    if (scheduledTroopEffects.length > 0) {
      let write = 0;
      for (let si = 0; si < scheduledTroopEffects.length; si++) {
        const effect = scheduledTroopEffects[si]!;
        if (effect.tick > tick) { scheduledTroopEffects[write++] = effect; continue; }
        const source = troops[effect.source];
        if (effect.kind === 'detonate') {
          if (source && source.detonationTick !== undefined) {
            detonate(tick, source.id, effect.ctx, effect.cty);
          }
          continue;
        }
        if (!source || source.phase === 'dead') continue;
        if (effect.kind === 'howl') {
          const h = TROOP_ABILITIES.gloamfang.howl;
          const r2 = (h.radiusTiles * UNITS_PER_TILE) ** 2;
          for (const ally of troops) {
            if (ally.side !== 'attacker' || ally.phase === 'dead' || ally.hero) continue;
            if (!isTrainableTroop(ally.type)) continue;
            if (dist2(source.x, source.y, ally.x, ally.y) > r2) continue;
            (ally.buffUntil ??= {}).gloamHowl = Math.max(
              ally.buffUntil?.gloamHowl ?? 0,
              tick + h.durationSec * TICKS_PER_SEC,
            );
          }
        } else if (effect.kind === 'lunge') {
          const foe = troops[effect.target];
          if (foe && foe.side === 'defender' && foe.phase !== 'dead') {
            const lunge = TROOP_ABILITIES.gloamfang.lunge;
            const d = isqrt(dist2(source.x, source.y, foe.x, foe.y));
            const advance = Math.max(0, d - source.rangeUnits);
            const p = stepToward(source, foe.x, foe.y, advance);
            source.x = p.nx; source.y = p.ny;
            unblock(source);
            events.push({ t: tick, e: 'pos', id: source.id, x: source.x, y: source.y });
            const dmg = Math.max(1, Math.floor(
              (source.dpsDeci * TICKS_PER_SEC * lunge.damagePctDps) / 100,
            ));
            damageTroop(tick, foe.id, dmg, true);
          }
        } else if (effect.kind === 'firestorm') {
          const f = TROOP_ABILITIES.direwyvern.firestorm;
          const len = Math.max(1, isqrt(effect.dx * effect.dx + effect.dy * effect.dy));
          const off = Math.floor(f.fieldOffsetTiles * UNITS_PER_TILE);
          const ox = Math.trunc((-effect.dy * off) / len);
          const oy = Math.trunc((effect.dx * off) / len);
          const centers = [
            { x: effect.x - ox, y: effect.y - oy },
            { x: effect.x, y: effect.y },
            { x: effect.x + ox, y: effect.y + oy },
          ] as const;
          // Same-caster fields refresh/replace. Different casters remain separate
          // and therefore stack, exactly and deterministically.
          for (let fi = burnFields.length - 1; fi >= 0; fi--) {
            if (burnFields[fi]!.owner === source.id) burnFields.splice(fi, 1);
          }
          const untilTick = tick + f.fieldLifetimeSec * TICKS_PER_SEC;
          const dmg = Math.max(1, Math.floor((source.dpsDeci * f.fieldDpsPct) / 100));
          burnFields.push({ owner: source.id, centers,
            radius2: (f.fieldRadiusTiles * UNITS_PER_TILE) ** 2,
            dmgDeciPerTick: dmg, untilTick });
          for (const c of centers) {
            events.push({ t: tick, e: 'burnfield', id: source.id, x: c.x, y: c.y, until: untilTick });
          }
        } else if (effect.kind === 'maul') {
          const m = TROOP_ABILITIES.direwyvern.maul;
          const r2 = (m.radiusTiles * UNITS_PER_TILE) ** 2;
          const dmg = Math.max(1, Math.floor(
            (source.dpsDeci * TICKS_PER_SEC * m.damagePctDps) / 100,
          ));
          for (const foe of troops) {
            if (foe.side !== 'defender' || foe.phase === 'dead') continue;
            if (dist2(effect.x, effect.y, foe.x, foe.y) <= r2) damageTroop(tick, foe.id, dmg, true);
          }
        } else {
          for (let n = 0; n < effect.count; n++) spawnBarrowling(tick, source, effect.firstSlot + n);
        }
      }
      scheduledTroopEffects.length = write;
    }

    // SIM9 contacts/projectiles land before actors choose their next action.
    // A projectile is committed only at its authored release: death during the
    // wind-up cancels it, while death after release cannot recall it. Melee and
    // attached streams still require a living source at every contact.
    if (scheduledTroopImpacts.length > 0) {
      let write = 0;
      for (let ii = 0; ii < scheduledTroopImpacts.length; ii++) {
        const impact = scheduledTroopImpacts[ii]!;
        if (impact.tick > tick) { scheduledTroopImpacts[write++] = impact; continue; }
        if (!impact.released) continue;
        const source = troops[impact.source];
        if (impact.requiresLiveSource && (!source || source.phase === 'dead')) continue;
        if (impact.targetKind === 'troop') {
          const target = troops[impact.targetIndex];
          if (target && target.phase !== 'dead') {
            damageTroop(tick, target.id, impact.dmgDeci, true,
              impact.melee ? impact.source : undefined, impact.melee);
          }
        } else {
          const target = buildings[impact.targetIndex];
          if (target && !target.destroyed) {
            events.push({ t: tick, e: 'hit', target: target.id,
              dmg: Math.round(impact.dmgDeci / 10) });
            damageBuilding(tick, impact.targetIndex, impact.dmgDeci);
          }
        }
      }
      scheduledTroopImpacts.length = write;
    }

    // Spawn-only brood lives for an exact fixed window independent of its parent.
    for (const tr of troops) {
      if (tr.expiresTick !== undefined && tr.phase !== 'dead' && tick >= tr.expiresTick) {
        tr.phase = 'dead';
        events.push({ t: tick, e: 'troopDeath', id: tr.id });
      }
    }

    // 2) rally pulse
    if (rallyTick === tick && orders.rally) {
      events.push({ t: tick, e: 'rally', x: tileCenter(orders.rally.tx), y: tileCenter(orders.rally.ty) });
    }
    const rallyActive = rallyTick >= 0 && tick >= rallyTick && tick < rallyTick + rallyDurTicks;

    // 3) troops act (id order — deterministic). The horn stops NEW actions;
    // accepted casts, contacts and projectiles drain below.
    if (!draining) for (const tr of troops) {
      if (tr.phase === 'dead' || tr.phase === 'idle') continue;
      // RAGE QUIT: "He flops, snores, waits for everyone to walk away." He keeps a
      // LIVE phase (so `anyAlive` does not end the raid on a solo hero) and simply
      // does nothing. Never true for a non-hero.
      if (untargetable(tr, tick)) continue;
      // STUN — honoured for BOTH SIDES, here, once. It used to be read at
      // exactly one line INSIDE the defender branch, which made stunning an
      // ATTACKER a write nothing ever read (an audit caught it as an equivalent
      // mutant: deleting the side filter changed nothing). That is a trap with
      // a fuse on it — a DEFENDING Theodor stuns attacker troops, so the moment
      // hero defence lands his ult would have done nothing, silently. A stunned
      // unit simply loses the tick: it does not move, attack, or cast. Defenders
      // park in the live 'guarding' phase so pass 3 re-evaluates them; attackers
      // keep whatever phase they had, so nothing about `anyAlive` changes.
      if (tr.stunUntil !== undefined && tick < tr.stunUntil) {
        if (tr.side === 'defender') tr.phase = 'guarding';
        continue;
      }
      // Fear is real movement, not a renamed stun. Step directly away from the
      // source, clamp to the battlefield, and refuse a step through masonry.
      if ((tr.fearUntil ?? 0) > tick && tr.fearFromX !== undefined && tr.fearFromY !== undefined) {
        const dx = tr.x - tr.fearFromX, dy = tr.y - tr.fearFromY;
        const away = stepToward(tr, tr.x + dx, tr.y + dy, tr.unitsPerTick);
        const minU = fieldMin * UNITS_PER_TILE, maxU = fieldMax * UNITS_PER_TILE - 1;
        const nx = Math.max(minU, Math.min(maxU, away.nx));
        const ny = Math.max(minU, Math.min(maxU, away.ny));
        if (behaviorOf(tr).isFlying || wallAt(nx, ny) < 0) { tr.x = nx; tr.y = ny; }
        tr.phase = 'moving';
        if (tick % positionKeyframeEvery(tr) === 0) {
          events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
        }
        continue;
      }
      if (tr.actionUntil !== undefined && tick < tr.actionUntil) continue;

      const inRally = rallyActive && orders.rally
        ? dist2(tr.x, tr.y, tileCenter(orders.rally.tx), tileCenter(orders.rally.ty)) <= rallyRadius2
        : false;
      let dmgNum = (buffDmgNum * (inRally ? rallyMultNum : 100)) / 100; // percent
      let spdNum = (buffSpdNum * (inRally ? rallyMultNum : 100)) / 100;
      if ((tr.buffUntil?.gloamHowl ?? 0) > tick) {
        dmgNum = (dmgNum * (100 + TROOP_ABILITIES.gloamfang.howl.damagePct)) / 100;
        spdNum = (spdNum * (100 + TROOP_ABILITIES.gloamfang.howl.speedPct)) / 100;
      }
      const step = Math.floor((tr.unitsPerTick * spdNum) / 100);
      let dmgDeci = Math.max(1, Math.trunc((tr.dpsDeci * dmgNum) / 100));
      // DEGEN AWAKENING folds into the SAME integer percent chain as warhorn and
      // rally, one tier further out. 0 unless an awakened Vex is inside his Z2
      // window, so every other unit's damage is byte-identical.
      const degenDmgPct = degenPctOf(tr, tick, 'dmg');
      if (degenDmgPct > 0) dmgDeci = Math.max(1, Math.trunc((dmgDeci * (100 + degenDmgPct)) / 100));

      // DEFENDER wyrmling (Dragon-Nest spawn): flies to the nearest attacker troop
      // and attacks it — troops are otherwise inactive on defense. It ignores walls
      // (isFlying), buildings, keg/burrow logic entirely.
      if (tr.side === 'defender') {
        // Cheek Quake stun: a stunned wyrmling neither moves nor bites — but it is
        // PAUSED, not gone, so it parks in `guarding` and resumes when the stun ends.
        // No reachable raider right now (nearestEnemyTroop skips BURROWED units, so a
        // tunneler opener empties the board for a while). Also a pause, not an exit.
        let enemy = -1;
        if (tr.hero && tr.guardX !== undefined && tr.guardY !== undefined) {
          const acquire = (tr.guardEngaged
            ? HERO_DEFENCE.leashRadiusTiles
            : HERO_DEFENCE.aggroRadiusTiles) * UNITS_PER_TILE;
          let best = Infinity;
          for (const foe of troops) {
            if (foe.side !== 'attacker' || foe.phase === 'dead' || foe.phase === 'burrowed'
              || untargetable(foe, tick)) continue;
            if (dist2(tr.guardX, tr.guardY, foe.x, foe.y) > acquire * acquire) continue;
            const d = dist2(tr.x, tr.y, foe.x, foe.y);
            if (d < best) { best = d; enemy = foe.id; }
          }
          tr.guardEngaged = enemy !== -1;
          if (enemy === -1) {
            const homeD2 = dist2(tr.x, tr.y, tr.guardX, tr.guardY);
            if (homeD2 > tr.unitsPerTick * tr.unitsPerTick) {
              const home = stepToward(tr, tr.guardX, tr.guardY, step);
              tr.x = home.nx; tr.y = home.ny; tr.phase = 'moving';
              if (tick % positionKeyframeEvery(tr) === 0) {
                events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
              }
            } else tr.phase = 'guarding';
            continue;
          }
        } else {
          enemy = nearestEnemyTroop(tick, 'defender', tr.x, tr.y);
        }
        if (enemy === -1) { tr.phase = 'guarding'; continue; }
        const e = troops[enemy]!;
        if (dist2(tr.x, tr.y, e.x, e.y) <= tr.rangeUnits ** 2) {
          tr.phase = 'attacking';
          const interval = tr.hero ? HERO_COMBAT[tr.hero].attackRecoveryDeciSec : 1;
          if ((tr.attackReadyAt ?? 0) <= tick) {
            damageTroop(tick, enemy, dmgDeci * interval, true, tr.id, true);
            if (tr.hero) events.push({ t: tick, e: 'heroAttack', id: tr.id, hero: tr.hero,
              side: tr.side, targetKind: 'troop', target: enemy, ix: e.x, iy: e.y,
              recoveryUntil: tick + interval });
            else if (tick % visualCueTicks === 0) {
              // The Nest itself has no weapon: this is the spawned Wyrmling's
              // authoritative breath/contact cue. Previously its damage appeared
              // as an unexplained hit despite BattleScene already owning wyrm FX.
              events.push({ t: tick, e: 'troopFire', id: tr.id, target: enemy, ix: e.x, iy: e.y });
            }
            tr.attackReadyAt = tick + interval;
          }
        } else {
          tr.phase = 'moving';
          const moved = stepToward(tr, e.x, e.y, step);
          tr.x = moved.nx; tr.y = moved.ny;
          if (tick % positionKeyframeEvery(tr) === 0) events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
        }
        continue;
      }

      const behavior = behaviorOf(tr);
      const mechanics = mechanicsOf(tr);
      // Defensive Theodor inverts Skill Issue: attacker units in his aura are
      // forced onto his body for the exact 4-second window.
      if (tr.side === 'attacker' && (tr.tauntUntil ?? 0) > tick && tr.tauntTarget !== undefined) {
        const taunter = troops[tr.tauntTarget];
        if (taunter && taunter.side === 'defender' && taunter.phase !== 'dead') {
          const d2 = dist2(tr.x, tr.y, taunter.x, taunter.y);
          if (d2 <= tr.rangeUnits ** 2) {
            tr.phase = 'attacking';
            const interval = tr.hero ? HERO_COMBAT[tr.hero].attackRecoveryDeciSec : 1;
            if ((tr.attackReadyAt ?? 0) <= tick) {
              damageTroop(tick, taunter.id, dmgDeci * interval, true, tr.id, true);
              if (tr.hero) events.push({ t: tick, e: 'heroAttack', id: tr.id, hero: tr.hero,
                side: tr.side, targetKind: 'troop', target: taunter.id,
                ix: taunter.x, iy: taunter.y, recoveryUntil: tick + interval });
              tr.attackReadyAt = tick + interval;
            }
          } else {
            const moved = stepToward(tr, taunter.x, taunter.y, step);
            if (behavior.isFlying || wallAt(moved.nx, moved.ny) < 0) {
              tr.x = moved.nx; tr.y = moved.ny;
            }
            tr.phase = 'moving';
            if (tick % positionKeyframeEvery(tr) === 0) {
              events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
            }
          }
          continue;
        }
      }
      // Authored cast loops are data-gated, so legacy troops never enter them.
      if (mechanics.howl && abilityReady(tr, 'howl', tr.spawnTick + mechanics.howl.firstDelaySec * TICKS_PER_SEC)) {
        events.push({ t: tick, e: 'troopAbility', id: tr.id, ability: 'howl', x: tr.x, y: tr.y });
        scheduledTroopEffects.push({
          tick: tick + mechanics.howl.effectDelayDeciSec, kind: 'howl', source: tr.id,
        });
        startAbilityCooldown(tr, 'howl', tick + mechanics.howl.cooldownSec * TICKS_PER_SEC);
        tr.actionUntil = tick + mechanics.howl.castDeciSec;
        continue;
      }
      if (mechanics.brood && abilityReady(tr, 'brood', tr.spawnTick + mechanics.brood.firstDelaySec * TICKS_PER_SEC)) {
        events.push({ t: tick, e: 'troopAbility', id: tr.id, ability: 'disgorge', x: tr.x, y: tr.y });
        let slot = 0;
        for (let i = 0; i < mechanics.brood.spawnOffsetsDeciSec.length; i++) {
          scheduledTroopEffects.push({ tick: tick + mechanics.brood.spawnOffsetsDeciSec[i]!,
            kind: 'brood', source: tr.id, count: mechanics.brood.spawnCounts[i]!, firstSlot: slot });
          slot += mechanics.brood.spawnCounts[i]!;
        }
        startAbilityCooldown(tr, 'brood', tick + mechanics.brood.intervalSec * TICKS_PER_SEC);
        tr.actionUntil = tick + mechanics.brood.castDeciSec;
        continue;
      }

      if (tr.phase === 'emerging') {
        tr.emergeLeft--;
        if (tr.emergeLeft <= 0) tr.phase = 'moving';
        continue;
      }

      // Gloamfang hunts live defenders before buildings. Lunge is a delayed,
      // deterministic gap-close; ordinary bites retain exact authored cadence.
      if (mechanics.enemyTroopPriority && tr.blockedWall === -1) {
        const enemyId = nearestEnemyTroop(tick, 'attacker', tr.x, tr.y);
        if (enemyId !== -1) {
          const enemy = troops[enemyId]!;
          const d2 = dist2(tr.x, tr.y, enemy.x, enemy.y);
          if (mechanics.lunge && d2 > tr.rangeUnits ** 2
            && d2 <= (mechanics.lunge.rangeTiles * UNITS_PER_TILE) ** 2
            && abilityReady(tr, 'lunge', tr.spawnTick)) {
            events.push({ t: tick, e: 'troopAbility', id: tr.id, ability: 'lunge',
              x: tr.x, y: tr.y, ix: enemy.x, iy: enemy.y });
            scheduledTroopEffects.push({ tick: tick + mechanics.lunge.travelDeciSec,
              kind: 'lunge', source: tr.id, target: enemyId });
            startAbilityCooldown(tr, 'lunge', tick + mechanics.lunge.cooldownSec * TICKS_PER_SEC);
            // Effects resolve before the action pass. Lock THROUGH the impact
            // tick (+1 for the `< actionUntil` guard), otherwise the lunge lands
            // and the same actor immediately adds a basic bite in that tick.
            tr.actionUntil = tick + mechanics.lunge.travelDeciSec + 1;
            continue;
          }
          if (d2 <= tr.rangeUnits ** 2) {
            tr.phase = 'attacking';
            const interval = mechanics.attackIntervalDeciSec ?? 1;
            if ((tr.attackReadyAt ?? 0) <= tick) {
              startTroopAttack(tick, tr, 'troop', enemyId, enemy.id,
                enemy.x, enemy.y, dmgDeci);
            }
            continue;
          }
          tr.phase = 'moving';
          const moved = stepToward(tr, enemy.x, enemy.y, step);
          const enteringWall = wallAt(moved.nx, moved.ny);
          if (enteringWall >= 0) {
            if (!tryGloamLeap(tick, tr, enemy.x, enemy.y)) tr.blockedWall = enteringWall;
          } else {
            tr.x = moved.nx; tr.y = moved.ny;
            if (tick % positionKeyframeEvery(tr) === 0) {
              events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
            }
          }
          continue;
        }
      }

      // Direwyvern's only anti-troop strike is the close maul. While it cools
      // down the flier continues its structure firestorm instead of silently
      // gaining the legacy continuous defender bite as a third attack.
      if (mechanics.maul && abilityReady(tr, 'maul', tr.spawnTick)) {
        const enemyId = nearestEnemyTroop(
          tick, 'attacker', tr.x, tr.y,
          (mechanics.maul.radiusTiles * UNITS_PER_TILE) ** 2,
        );
        if (enemyId !== -1) {
          const timing = AUTHORED_ATTACK_TIMINGS.direMaul;
          const resolved = resolveAttackTiming(timing);
          events.push({ t: tick, e: 'troopAbility', id: tr.id, ability: 'maul', x: tr.x, y: tr.y });
          events.push({ t: tick, e: 'attackRun', id: tr.id, side: tr.side,
            troop: tr.type, targetKind: 'troop', target: enemyId, ix: tr.x, iy: tr.y,
            mode: timing.mode, technique: timing.technique,
            cycleMs: resolved.cycleMs, releaseOffsetMs: resolved.releaseOffsetMs,
            cycleTicks: resolved.cycleTicks, releaseOffsetTicks: resolved.releaseOffsetTicks,
            impactOffsetsTicks: [...resolved.impactOffsetsTicks], cadenceTicks: resolved.cadenceTicks, count: 1 });
          scheduledTroopEffects.push({ tick: tick + mechanics.maul.impactDelayDeciSec,
            kind: 'maul', source: tr.id, x: tr.x, y: tr.y });
          startAbilityCooldown(tr, 'maul', tick + mechanics.maul.cooldownSec * TICKS_PER_SEC);
          // Maul consumes the impact tick. Without +1, its delayed hit resolves
          // before actions and the wyvern immediately casts firestorm too.
          tr.actionUntil = tick + resolved.cycleTicks;
          continue;
        }
      }

      // ATTACKER retaliation: swat a defender wyrmling that flew into attack range,
      // otherwise stay focused on the base (foe === -1 when no wyrmlings exist, so
      // this is inert — and byte-identical — for every raid without a Dragon Nest).
      const foe = mechanics.firestorm ? -1
        : nearestEnemyTroop(tick, 'attacker', tr.x, tr.y, tr.rangeUnits ** 2);
      if (foe !== -1) {
        tr.phase = 'attacking';
        const enemy = troops[foe]!;
        const interval = tr.hero
          ? HERO_COMBAT[tr.hero].attackRecoveryDeciSec
          : (mechanics.attackIntervalDeciSec ?? 1);
        if ((tr.attackReadyAt ?? 0) <= tick) {
          if (tr.hero) {
            events.push({ t: tick, e: 'heroAttack', id: tr.id, hero: tr.hero,
              side: tr.side, targetKind: 'troop', target: enemy.id, ix: enemy.x, iy: enemy.y,
              recoveryUntil: tick + interval });
            lifesteal(tr, tick, damageTroop(tick, foe, dmgDeci * interval, true, tr.id, true), degenPctOf(tr, tick, 'lifesteal'));
            tr.attackReadyAt = tick + interval;
          } else startTroopAttack(tick, tr, 'troop', foe, enemy.id,
            enemy.x, enemy.y, dmgDeci);
        }
        continue;
      }

      // (re)acquire target
      if (tr.targetB === -1 || buildings[tr.targetB]!.destroyed) {
        unblock(tr);
        tr.routing = 0; // a new target means a new route — and a new wall decision
        pickTarget(tr);
        if (tr.targetB === -1) { tr.phase = 'idle'; continue; }
      }
      if (tr.targetB >= 0 && buildings[tr.targetB]!.type === BuildingType.Wall
        && behavior.aiTarget !== 'walls') {
        // A newly deployed opener / newly opened route can make the favorite
        // reachable again; wall fallback is never an irreversible target lock.
        pickTarget(tr);
      }
      if (tr.blockedWall !== -1 && buildings[tr.blockedWall]!.destroyed) unblock(tr);
      if (tr.kegWall !== -1 && buildings[tr.kegWall]!.destroyed) pickTarget(tr);

      // NEVER WALK PAST A GUN YOU CAN HIT (SIM16; owner relaying players
      // 2026-09-17: giants "going to another place when a target is nearby").
      // A target is chosen at deploy and held until it dies, so a defence that
      // came inside the giant's throw reach on the way — or the one his own
      // breach just exposed two tiles inside the ring — was walked straight
      // past. While the held target is OUT of reach, the nearest defence
      // inside siegeThrow reach takes over; the in-range branch below fires on
      // it this tick. He does not move while attacking and buildings do not,
      // so an in-reach target stays in reach and the switch cannot oscillate;
      // the held target is re-picked when this one falls. A new target drops
      // any wall commitment (D-099 unblock). Gated on the siegeThrow ROLE via
      // behaviorOf, so every other unit — Theodor included — is byte-identical.
      if (behavior.siegeThrow !== undefined && tr.targetB >= 0) {
        const held = buildings[tr.targetB]!;
        const heldReach = reachFor(tr.rangeUnits, behavior.siegeThrow, isDefense(held));
        if (dist2ToRect(tr.x, tr.y, held.tx, held.ty, held.fw, held.fh) > heldReach ** 2) {
          const throwReach2 = reachFor(tr.rangeUnits, behavior.siegeThrow, true) ** 2;
          const near = nearestBuilding(tr.x, tr.y, (b) =>
            isDefense(b) && dist2ToRect(tr.x, tr.y, b.tx, b.ty, b.fw, b.fh) <= throwReach2);
          if (near !== -1) {
            unblock(tr);
            tr.routing = 0;
            tr.targetB = near;
          }
        }
      }

      // keg runner: head to its wall (or its building target) and detonate.
      // behaviorOf, not tr.type — see UnitBehavior: a hero riding a kegrunner
      // donor must not blow itself up on arrival.
      if (behaviorOf(tr).selfDestructs && tr.phase !== 'burrowed') {
        // A keg serves the army's hole: the nearest one being opened, if any.
        const breach = nearestLiveBreach(tr);
        if (breach !== -1) tr.kegWall = breach;
        const goal = tr.kegWall !== -1 ? buildings[tr.kegWall]! : buildings[tr.targetB]!;
        const reach = dist2ToRect(tr.x, tr.y, goal.tx, goal.ty, goal.fw, goal.fh) <= tr.rangeUnits ** 2;
        if (reach) {
          const ctx = tr.kegWall !== -1 ? goal.tx : unitToTile(tr.x);
          const cty = tr.kegWall !== -1 ? goal.ty : unitToTile(tr.y);
          beginDetonation(tick, tr, ctx, cty);
          continue;
        }
        // move toward goal, detonating on any wall that blocks first
        const p = closestPointOnRect(tr.x, tr.y, goal.tx, goal.ty, goal.fw, goal.fh);
        const moved = stepToward(tr, p.x, p.y, step);
        const wAt = wallAt(moved.nx, moved.ny);
        if (wAt >= 0 && wAt !== tr.kegWall) {
          beginDetonation(tick, tr, buildings[wAt]!.tx, buildings[wAt]!.ty);
          continue;
        }
        tr.x = moved.nx; tr.y = moved.ny;
        // Keg movement used to be the only attacker path that never emitted
        // position keyframes. The sim reached the wall, but replay renderers
        // left the body running at its deployment point and exploded there.
        // Keep the same render-only cadence as every other moving unit; combat
        // arithmetic and the authoritative detonation point are unchanged.
        if (tick % positionKeyframeEvery(tr) === 0) {
          events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
        }
        continue;
      }

      // A wall stands between this troop and its target. What happens next is the
      // troop's wallPolicy (owner behavior table 2026-07-26 — TroopWallPolicy in
      // constants.ts is the single home for that table).
      if (tr.blockedWall !== -1) {
        const policy = behaviorOf(tr).wallPolicy;
        const wallTgt = tr.targetB >= 0 ? buildings[tr.targetB] : undefined;

        if (wallTgt && mechanicsOf(tr).leap) {
          const p = closestPointOnRect(tr.x, tr.y, wallTgt.tx, wallTgt.ty, wallTgt.fw, wallTgt.fh);
          const gx = wallTgt.type === BuildingType.Wall ? p.x + (p.x - tr.x) : p.x;
          const gy = wallTgt.type === BuildingType.Wall ? p.y + (p.y - tr.y) : p.y;
          if (tryGloamLeap(tick, tr, gx, gy)) continue;
        }

        // 'over' (ranged + flyers, rule 4): if the real target is already in reach
        // it fires through — walls don't block line of fire, the sim has no
        // line-of-sight model. If it must close distance, it uses a gap/opener
        // first and attacks the blocker with its real technique only as the final
        // fallback. This prevents ranged troops from stalling at sealed bases.
        //
        // A siegeThrow unit (the giant, rework v2 owner 2026-08-08) shares the
        // convention when its target is a DEFENSE inside throw range: the boulder
        // arcs over the masonry, he never walks through it. Beyond throw range he
        // is an ordinary 'follow' troop (gap preference, opener regroup, below).
        // reachFor returns tr.rangeUnits verbatim when siegeThrow is absent or the
        // target is not a defense, so every existing troop is byte-identical here.
        const overReach = wallTgt
          ? reachFor(tr.rangeUnits, behaviorOf(tr).siegeThrow, isDefense(wallTgt))
          : 0;
        const throwsAtTarget = behaviorOf(tr).siegeThrow !== undefined && !!wallTgt && isDefense(wallTgt);
        const canShootOver = (policy === 'over' || throwsAtTarget) && !!wallTgt && !wallTgt.destroyed
          && dist2ToRect(tr.x, tr.y, wallTgt.tx, wallTgt.ty, wallTgt.fw, wallTgt.fh) <= overReach ** 2;

        if (canShootOver) {
          // Nothing to decide: the target is already in reach from here. Ahead
          // of the wall decision, since committing to a walk while able to fire
          // would be its own reversal.
          unblock(tr); // the in-range branch below fires this tick
        } else {
          // D-099 — price breach against detour ONCE, then hold the answer.
          // `routing` is the detour commitment (the movement section follows the
          // field until it is spent), `breachWall` the breach commitment; a unit
          // holding neither at a wall has not decided yet.
          if (tr.breachWall === -1 && !tr.routing) decideAtWall(tr, dmgDeci, step);

          if (tr.breachWall === -1) {
            // DETOUR — "if entry is available, troops go inside" (owner
            // 2026-07-26), now a commitment rather than a per-tick check. Only
            // consulted while BLOCKED, so open-field movement stays a straight
            // line and wall-free replays are untouched.
            const gap = stepThroughGap(tr, tr.targetB);
            if (gap !== -1) {
              const point = pathPoint(gap);
              const moved = stepToward(tr, point.x, point.y, step);
              if (wallAt(moved.nx, moved.ny) < 0) {
                tr.x = moved.nx; tr.y = moved.ny;
                tr.blockedWall = -1; // routing around it, no longer blocked
              }
              tr.routing = 1; // COMMITTED — see the movement section below
              tr.phase = 'moving';
              if (tick % positionKeyframeEvery(tr) === 0) events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
              continue;
            }
            // Every route from here crosses a wall after all — the unit was
            // displaced since it chose (fear, a taunt). The wall in front is
            // the breach now; no walking away from it.
            tr.routing = 0;
            tr.breachWall = tr.blockedWall;
          }

          // BREACH — close on the committed segment and open it. Allies see this
          // commitment as a live breach and price joining it themselves.
          tr.blockedWall = tr.breachWall;
          const w = buildings[tr.breachWall]!;
          const inWallRange = dist2ToRect(tr.x, tr.y, w.tx, w.ty, w.fw, w.fh) <= tr.rangeUnits ** 2;
          if (!inWallRange) {
            // A joined breach can lie around a corner of the ring: walk to it
            // along the segment's own wall-free field, never a straight line
            // into masonry. The line is the fallback only when no such route
            // exists (a second ring between), which the next block re-prices.
            const via = stepThroughGap(tr, tr.breachWall);
            const q = via !== -1
              ? pathPoint(via)
              : closestPointOnRect(tr.x, tr.y, w.tx, w.ty, w.fw, w.fh);
            const moved = stepToward(tr, q.x, q.y, step);
            if (wallAt(moved.nx, moved.ny) < 0) { tr.x = moved.nx; tr.y = moved.ny; }
            tr.phase = 'moving';
            if (tick % positionKeyframeEvery(tr) === 0) events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
            continue;
          }
          tr.phase = 'attacking';
          const interval = mechanicsOf(tr).attackIntervalDeciSec ?? 1;
          if ((tr.attackReadyAt ?? 0) <= tick) {
            const q = closestPointOnRect(tr.x, tr.y, w.tx, w.ty, w.fw, w.fh);
            if (tr.hero) {
              attackBlockingWall(tick, tr, tr.breachWall, dmgDeci, interval);
              tr.attackReadyAt = tick + interval;
            } else startTroopAttack(tick, tr, 'building', tr.breachWall, w.id,
              q.x, q.y, wallAdjusted(tr, tr.breachWall,
                dmgDeci * (behaviorOf(tr).buildingDamageMult ?? 1)));
          }
          // When the segment falls, damageBuilding → breachOpened releases every
          // unit committed to it, whoever landed the blow.
          continue;
        }
      }

      const tgt = buildings[tr.targetB]!;
      // Reach is TARGET-dependent (rework v2, owner 2026-08-08): a siegeThrow
      // unit gets its 2.5-tile boulder reach against a DEFENSE target and its
      // own rangeUnits (melee) against everything else — see reachFor. Resolved
      // through behaviorOf, so a giant-donor hero (Theodor) keeps melee reach.
      const reach = reachFor(tr.rangeUnits, behaviorOf(tr).siegeThrow, isDefense(tgt));
      const inRange = dist2ToRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh) <= reach ** 2;

      if (tr.phase === 'burrowed') {
        // travel under; emerge when clear of walls + cleared distance, or at target.
        // Burrow speed + emerge window read the ACTING troop's own stats (tunneler
        // and bilgewraith both burrow); tunneler's values are unchanged → identical.
        const p = closestPointOnRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh);
        const burrowStep = Math.floor((Math.floor((behaviorOf(tr).speedTilesPerSec * 256) / 10) * spdNum) / 100);
        const moved = stepToward(tr, p.x, p.y, burrowStep);
        tr.burrowedUnits += isqrt(dist2(tr.x, tr.y, moved.nx, moved.ny));
        tr.x = moved.nx; tr.y = moved.ny;
        const onWall = wallAt(tr.x, tr.y) >= 0;
        const arrived = dist2ToRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh) <= tr.rangeUnits ** 2;
        if (arrived || (!onWall && tr.burrowedUnits >= BURROW_CLEAR_UNITS)) {
          // Burrow movement used to update only authoritative coordinates. The
          // replay body stayed at wall entry, then surfaced there. Keep normal
          // keyframes on POS_KEYFRAME_EVERY and always emit the terminal point
          // immediately before `emerge` (including off-cadence); otherwise art can
          // still surface up to four ticks behind. The cadence coincidence is one
          // event, never a duplicate.
          events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
          tr.phase = 'emerging';
          tr.emergeLeft = (behaviorOf(tr).emergeVulnerableSec ?? 1) * TICKS_PER_SEC;
          events.push({ t: tick, e: 'emerge', id: tr.id, x: tr.x, y: tr.y });
        } else if (tick % positionKeyframeEvery(tr) === 0) {
          events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
        }
        continue;
      }

      if (inRange) {
        tr.phase = 'attacking';
        const s = behaviorOf(tr);
        if (mechanics.firestorm) {
          if (abilityReady(tr, 'firestorm', tr.spawnTick)) {
            const q = closestPointOnRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh);
            const dx = q.x - tr.x, dy = q.y - tr.y;
            const timing = AUTHORED_ATTACK_TIMINGS.direFirestorm;
            const resolved = resolveAttackTiming(timing);
            events.push({ t: tick, e: 'troopAbility', id: tr.id, ability: 'firestorm',
              x: tr.x, y: tr.y, ix: q.x, iy: q.y, targetBuildingId: tgt.id });
            events.push({ t: tick, e: 'attackRun', id: tr.id, side: tr.side,
              troop: tr.type, targetKind: 'building', target: tgt.id, ix: q.x, iy: q.y,
              mode: timing.mode, technique: timing.technique,
              cycleMs: resolved.cycleMs, releaseOffsetMs: resolved.releaseOffsetMs,
              cycleTicks: resolved.cycleTicks, releaseOffsetTicks: resolved.releaseOffsetTicks,
              impactOffsetsTicks: [...resolved.impactOffsetsTicks],
              cadenceTicks: resolved.cadenceTicks, count: 1 });
            scheduledTroopEffects.push({ tick: tick + mechanics.firestorm.effectDelayDeciSec,
              kind: 'firestorm', source: tr.id, x: q.x, y: q.y, dx, dy });
            startAbilityCooldown(tr, 'firestorm', tick + mechanics.firestorm.cooldownSec * TICKS_PER_SEC);
            // Firestorm also resolves before the action pass; occupy its impact
            // tick so it cannot immediately chain a maul in the same 100ms step.
            tr.actionUntil = tick + resolved.cycleTicks;
          }
          // Damage is the field, never an impact hit or hidden basic attack.
          continue;
        }
        const attackInterval = tr.hero
          ? HERO_COMBAT[tr.hero].attackRecoveryDeciSec
          : (mechanics.attackIntervalDeciSec ?? 1);
        if ((tr.attackReadyAt ?? 0) > tick) continue;
        const q = closestPointOnRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh);
        // Giant defense attacks inside siege range are authored boulder throws,
        // not melee contacts. His wall/non-defense damage still emits strike.
        const throwing = s.siegeThrow !== undefined && isDefense(tgt);
        // Raider bonus vs the target: resourceDamageMult when the target IS a
        // Mine/Vault and the ACTING unit declares one (plunderer 2×), else its
        // buildingDamageMult (giant hits structures at 2×). Read off behaviorOf,
        // so the plunderer's role travels with the flag rather than its type
        // string — and a hero declaring resourceDamageMult finally gets it.
        const mult = isResource(tgt) && s.resourceDamageMult !== undefined
          ? s.resourceDamageMult
          : (s.buildingDamageMult ?? 1);
        // Lifesteal reads the CLAMPED return, so finishing a 5-HP wall heals for
        // 5 HP, not for a full swing.
        if (tr.hero) {
          tr.attackReadyAt = tick + attackInterval;
          events.push({ t: tick, e: 'heroAttack', id: tr.id, hero: tr.hero,
            side: tr.side, targetKind: 'building', target: tgt.id, ix: q.x, iy: q.y,
            recoveryUntil: tick + attackInterval });
          const applied = wallAdjusted(tr, tr.targetB, dmgDeci * attackInterval * mult);
          // SIM14: the swing's damage is published as an ordinary `hit`, like
          // every troop impact, skill and splash path (see publishHeroSwingHit).
          publishHeroSwingHit(tick, tr.targetB, applied);
          lifesteal(tr, tick,
            damageBuilding(tick, tr.targetB, applied),
            degenPctOf(tr, tick, 'lifesteal'));
        } else startTroopAttack(tick, tr, 'building', tr.targetB, tgt.id, q.x, q.y,
          wallAdjusted(tr, tr.targetB, dmgDeci * mult), throwing);
        continue;
      }

      // move toward target
      tr.phase = 'moving';
      // A unit that had to route around a wall KEEPS following the cost field
      // until the detour is spent. Aiming straight at the target again the tick
      // after stepping through a gap walks it right back into the wall, and the
      // two rules deadlock in a 2-cycle: gap-step out, straight-step back, net
      // zero for the rest of the raid. That is the "hero stuck at the wall while
      // a breach is open" the owner reported on 2026-07-29 — Theodor detoured
      // correctly around three sides of a ring, then bounced between two tiles
      // eight tiles short of the hole. The field descends to the target, so
      // following it is never worse than the straight line, and it runs out on
      // its own (no strictly-lower neighbour) once he is through and closing.
      let aimX = 0, aimY = 0;
      const route = tr.routing && tr.targetB >= 0 && !behaviorOf(tr).isFlying
        ? stepThroughGap(tr, tr.targetB)
        : -1;
      if (route !== -1) {
        const point = pathPoint(route);
        aimX = point.x;
        aimY = point.y;
      } else {
        tr.routing = 0;
        const p = closestPointOnRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh);
        aimX = p.x; aimY = p.y;
      }
      const moved = stepToward(tr, aimX, aimY, step);
      // FLYING attackers (the Dragon) ignore walls entirely — they fly straight over.
      const enteringWall = behaviorOf(tr).isFlying ? -1 : wallAt(moved.nx, moved.ny);
      if (enteringWall >= 0) {
        if (mechanicsOf(tr).leap && tryGloamLeap(tick, tr, aimX, aimY)) {
          continue;
        } else if (behaviorOf(tr).burrowsUnderWalls) {
          tr.phase = 'burrowed';
          tr.burrowedUnits = 0;
          events.push({ t: tick, e: 'burrow', id: tr.id });
        } else {
          tr.blockedWall = enteringWall;
        }
        continue;
      }
      tr.x = moved.nx; tr.y = moved.ny;
      if (tick % positionKeyframeEvery(tr) === 0) events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
    }

    // 4) traps (after movement, building/id order; each spends exactly once).
    for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi]!;
      if (!isTrapType(b.type) || !b.trapArmed) continue;
      const trap = trapCombat(b.type as TrapType, b.level);
      for (const tr of troops) {
        if (tr.phase === 'dead' || tr.phase === 'idle' || tr.phase === 'emerging') continue;
        if (untargetable(tr, tick)) continue; // a body playing dead sets nothing off
        if (tr.side !== 'attacker' || !!behaviorOf(tr).isFlying !== trap.targetsAir) continue;
        if (unitToTile(tr.x) === b.tx && unitToTile(tr.y) === b.ty) {
          b.trapArmed = false;
          b.destroyed = true; // spent, retained in the raid outcome for repair UI
          const victims = trap.splashUnits === 0 ? [tr] : troops.filter((o) =>
            o.side === 'attacker' && o.phase !== 'dead' && o.phase !== 'burrowed' &&
            !untargetable(o, tick) && !!behaviorOf(o).isFlying === trap.targetsAir &&
            dist2(tr.x, tr.y, o.x, o.y) <= trap.splashUnits ** 2);
          const victimIds = victims.map((o) => o.id);
          const stunUntil = trap.stunTicks > 0 ? tick + trap.stunTicks : undefined;
          events.push({ t: tick, e: 'trap', id: b.id, victim: tr.id,
            kind: b.type as TrapType, victims: victimIds, ...(stunUntil ? { stunUntil } : {}) });
          for (const victim of victims) {
            damageTroop(tick, victim.id, trap.damageDeci, true);
            if (stunUntil !== undefined && victim.phase !== 'dead') {
              victim.stunUntil = Math.max(victim.stunUntil ?? 0, stunUntil);
            }
          }
          break;
        }
      }
    }

    // 4b) hero skills — AUTOCAST in troop-id order (D4b). Placed BETWEEN traps
    // and defense fire so a Cheek Quake stun applied THIS tick suppresses THIS
    // tick's shot — the deterministic reading of "stunned".
    //
    // ALL THIRTEEN SKILLS ARE LIVE (2026-07-29). Each is gated on the hero's OWN
    // level vs HERO_SKILLS[hero][skill].unlockLevel and tiered via heroTier(), so
    // a level-1 hero fires exactly the two L1 signatures it always did. Within a
    // hero the skills are evaluated in UNLOCK ORDER — arbitrary but fixed, which
    // is all determinism requires. All integer math; cooldowns are ticks in
    // skillReadyAt; once-per-battle is a cooldown parked past MAX_TICKS; every
    // cast emits a heroSkill event (rendering cue only — the sim has already
    // applied the effect).
    //
    // A skill whose tier row is the `0 = unavailable` sentinel does NOT cast at
    // all. Three skills unlock inside a tier band whose own row is still 0 (see
    // the HERO_SKILLS header) — casting them for zero effect on cooldown would be
    // strictly worse than staying silent about a data bug.
    for (const tr of troops) {
      if (!tr.hero || tr.phase === 'dead') continue;
      const lvl = tr.level;
      const tierIdx = heroTier(lvl) - 1;
      const ready = (skill: string): boolean => (tr.skillReadyAt?.[skill] ?? 0) <= tick;
      const startCd = (skill: string, cdSec: number): void => {
        const baseTicks = cdSec * TICKS_PER_SEC;
        const reduction = tr.combatModifiers?.cooldown_reduction_bps ?? 0;
        (tr.skillReadyAt ??= {})[skill] = tick
          + Math.max(1, Math.floor((baseTicks * (10_000 - reduction)) / 10_000));
      };
      const foesWithin = (radiusUnits: number): TState[] => troops.filter((foe) =>
        foe.side !== tr.side && foe.phase !== 'dead' && !untargetable(foe, tick)
        && dist2(tr.x, tr.y, foe.x, foe.y) <= radiusUnits * radiusUnits);
      const nearestFoe = (radiusUnits: number): TState | undefined => {
        let best: TState | undefined;
        let bestD = Infinity;
        for (const foe of foesWithin(radiusUnits)) {
          const d = dist2(tr.x, tr.y, foe.x, foe.y);
          if (d < bestD || (d === bestD && foe.id < (best?.id ?? Infinity))) { best = foe; bestD = d; }
        }
        return best;
      };
      /** Is any live building within `radiusUnits`? The cast gate every AoE uses,
       *  so an ultimate is never dumped on empty ground the tick the hero lands. */
      const anyBuildingWithin = (radiusUnits: number): boolean => {
        for (const b of buildings) {
          if (b.destroyed || isTrapType(b.type)) continue;
          if (dist2ToRect(tr.x, tr.y, b.tx, b.ty, b.fw, b.fh) <= radiusUnits * radiusUnits) return true;
        }
        return false;
      };
      /** A once-only radial finisher waits until there are live targets on all
       * four sides. Firing at the first perimeter contact turns seven of its
       * eight authoritative crescents into guaranteed empty-ground no-ops. */
      const hasRadialTargets = (radiusUnits: number): boolean => {
        let east = false, west = false, north = false, south = false;
        for (const b of buildings) {
          if (b.destroyed || isTrapType(b.type)) continue;
          const c = centerOf(b);
          if (dist2(tr.x, tr.y, c.x, c.y) > radiusUnits * radiusUnits) continue;
          if (c.x > tr.x) east = true;
          if (c.x < tr.x) west = true;
          if (c.y > tr.y) south = true;
          if (c.y < tr.y) north = true;
        }
        return east && west && north && south;
      };
      const densePerimeterAhead = (radiusUnits: number): boolean => {
        let walls = 0;
        for (const b of buildings) {
          if (b.destroyed || b.type !== BuildingType.Wall) continue;
          if (dist2ToRect(tr.x, tr.y, b.tx, b.ty, b.fw, b.fh) <= radiusUnits * radiusUnits) walls++;
        }
        return walls >= 8 && !hasRadialTargets(radiusUnits);
      };
      /** Stun every defense and defender troop within `radiusUnits`. A defense's
       *  own `cooldown` IS the stun (pass 5 decrements and skips) — zero new
       *  state, and pass 4b runs first so this tick's shot is suppressed. */
      const stunAround = (radiusUnits: number, stunTicks: number): void => {
        if (tr.side === 'attacker') {
          for (const b of buildings) {
            if (b.destroyed || !b.def) continue;
            const c = centerOf(b);
            if (dist2(tr.x, tr.y, c.x, c.y) <= radiusUnits * radiusUnits) {
              b.cooldown = Math.max(b.cooldown, stunTicks);
            }
          }
        }
        for (const foe of troops) {
          if (foe.side === tr.side || foe.phase === 'dead') continue;
          if (dist2(tr.x, tr.y, foe.x, foe.y) <= radiusUnits * radiusUnits) {
            foe.stunUntil = Math.max(foe.stunUntil ?? 0, tick + stunTicks);
          }
        }
      };

      // Cannonball's gift begins when Theodor actually leaves the roof (or the
      // roof collapses), never on landing. The depart phase is replay-visible.
      if (tr.hero === 'theodor' && tr.cannonballGift) {
        const gift = tr.cannonballGift;
        const target = buildings[gift.bi];
        const stillOnTarget = target && !target.destroyed
          && dist2ToRect(tr.x, tr.y, target.tx, target.ty, target.fw, target.fh) === 0;
        if (!stillOnTarget) {
          if (target && !target.destroyed && gift.dps > 0) {
            dots.push({ kind: 'building', bi: gift.bi, ti: -1, cx: 0, cy: 0, r2: 0,
              dmgDeciPerTick: gift.dps, untilTick: tick + gift.durationTicks });
          }
          events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
            skill: 'cannonball', phase: 'depart', x: tr.x, y: tr.y,
            ...(target ? { target: target.id } : {}) });
          delete tr.cannonballGift;
        }
      }

      // Silent But Deadly resolves only after its authored 5s eating + 3s swell.
      // During the windup pass 3 locks the actor; this equality is exact-once.
      if (tr.hero === 'theodor' && tr.buffUntil?.silentWindup === tick) {
        const sd = HERO_SKILLS.theodor.silentButDeadly;
        const cx = tr.silentX ?? tr.x, cy = tr.silentY ?? tr.y;
        const radius = sd.novaRadiusTiles * UNITS_PER_TILE;
        const nova = Math.floor((abilityDpsOf(tr) * sd.novaDmgPctDps) / 100);
        if (tr.side === 'attacker') {
          damageBuildingsInRadius(tick, cx, cy, radius, nova, tr);
          stunAround(radius, sd.fearSec * TICKS_PER_SEC);
        }
        for (const foe of troops) {
          if (foe.side === tr.side || foe.phase === 'dead') continue;
          if (dist2(cx, cy, foe.x, foe.y) > radius * radius) continue;
          damageTroop(tick, foe.id, nova, true);
          foe.fearUntil = tick + sd.fearSec * TICKS_PER_SEC;
          foe.fearFromX = cx; foe.fearFromY = cy;
        }
        dots.push({ kind: 'zone', bi: -1, ti: -1, cx, cy, r2: radius * radius,
          dmgDeciPerTick: sd.cloudDps, untilTick: tick + sd.cloudSec * TICKS_PER_SEC,
          ownerSide: tr.side });
        events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
          skill: 'silentButDeadly', phase: 'impact', x: cx, y: cy });
        delete tr.silentX; delete tr.silentY;
      }
      // RAGE QUIT wake-up (C1): the tick his untargetable window ENDS he gets up
      // with an AoE stun ("getup_f1..f4 with a 1s AoE stun"). Equality fires it
      // exactly once. Only rageQuit opens a window on Theodor — Vex's is DOUBLE
      // OR NOTHING's immunity — so the hero check is the whole disambiguation.
      if (tr.hero === 'theodor' && tr.untargetableUntil !== undefined
        && tr.untargetableUntil <= tick && !onceAvailable(tr, 'rageQuit')
        && onceAvailable(tr, 'rageQuitWake')) {
        const rq = HERO_SKILLS.theodor.rageQuit;
        markUsedOnce(tr, 'rageQuitWake');
        stunAround(rq.wakeStunRadiusTiles * UNITS_PER_TILE, rq.wakeStunSec * TICKS_PER_SEC);
        events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
          skill: 'rageQuitWake', phase: 'revive', x: tr.x, y: tr.y });
      }
      if ((tr.actionUntil ?? 0) > tick) continue;

      // Defender heroes reuse the same level/cooldown/event vocabulary, but
      // every target is side-relative and no branch can damage defender-owned
      // buildings. Their guard movement ran in pass 3 above.
      if (tr.side === 'defender') {
        if (tr.hero === 'vex') {
          const dash = HERO_SKILLS.vex.crimsonDash;
          const dashFoe = nearestFoe(dash.rangeTiles[tierIdx]! * UNITS_PER_TILE);
          if (dashFoe && lvl >= dash.unlockLevel && ready('crimsonDash')
            && dist2(tr.x, tr.y, dashFoe.x, dashFoe.y) >= (dash.minGapTiles * UNITS_PER_TILE) ** 2) {
            const fromX = tr.x, fromY = tr.y;
            const advance = Math.max(0, isqrt(dist2(tr.x, tr.y, dashFoe.x, dashFoe.y)) - tr.rangeUnits);
            const landing = stepToward(tr, dashFoe.x, dashFoe.y, advance);
            if (wallAt(landing.nx, landing.ny) < 0) { tr.x = landing.nx; tr.y = landing.ny; }
            damageTroop(tick, dashFoe.id,
              Math.floor((abilityDpsOf(tr) * dash.lineDmgPctDps[tierIdx]!) / 100), true);
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
              skill: 'crimsonDash', phase: 'impact', x: tr.x, y: tr.y,
              fromX, fromY, toX: tr.x, toY: tr.y, target: dashFoe.id });
            events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
            startCd('crimsonDash', dash.cdSec);
          }
          const wave = HERO_SKILLS.vex.moonsunderWave;
          const waveFoe = nearestFoe(wave.rangeTiles * UNITS_PER_TILE);
          if (waveFoe && lvl >= wave.unlockLevel && wave.waveDmgPctDps[tierIdx]! > 0
            && ready('moonsunderWave')) {
            const fired = castCrescent(tick, tr, waveFoe.x - tr.x, waveFoe.y - tr.y,
              isqrt(dist2(tr.x, tr.y, waveFoe.x, waveFoe.y)),
              wave.rangeTiles * UNITS_PER_TILE, wave.widthTiles[tierIdx]!,
              Math.floor((abilityDpsOf(tr) * wave.waveDmgPctDps[tierIdx]!) / 100),
              wave.bleedPctMaxHpPer4s[tierIdx]!);
            if (!fired) continue;
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
              skill: 'moonsunderWave', phase: 'impact', x: tr.x, y: tr.y,
              toX: waveFoe.x, toY: waveFoe.y, target: waveFoe.id });
            startCd('moonsunderWave', wave.cdSec);
          }
          const dg = HERO_SKILLS.vex.degenAwakening;
          if (lvl >= dg.unlockLevel && ready('degenAwakening') && tr.guardEngaged) {
            (tr.buffUntil ??= {}).degen = tick + dg.durationSec * TICKS_PER_SEC;
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
              skill: 'degenAwakening', phase: 'active', x: tr.x, y: tr.y,
              until: tick + dg.durationSec * TICKS_PER_SEC });
            startCd('degenAwakening', dg.cdSec);
          }
          const om = HERO_SKILLS.vex.omegaShardstorm;
          const omegaFoes = foesWithin(om.novaRadiusTiles * UNITS_PER_TILE);
          if (lvl >= om.unlockLevel && onceAvailable(tr, 'omegaShardstorm')
            && (tr.buffUntil?.degen ?? 0) > tick && omegaFoes.length > 0) {
            markUsedOnce(tr, 'omegaShardstorm');
            const dmg = Math.floor((abilityDpsOf(tr) * om.novaDmgPctDps[tierIdx]!) / 100);
            const stun = Math.floor((om.stunDeciSec[tierIdx]! * TICKS_PER_SEC) / 10);
            for (const foe of omegaFoes) {
              damageTroop(tick, foe.id, dmg, true);
              foe.stunUntil = Math.max(foe.stunUntil ?? 0, tick + stun);
            }
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
              skill: 'omegaShardstorm', phase: 'impact', x: tr.x, y: tr.y });
          }
        } else {
          const quake = HERO_SKILLS.theodor.cheekQuake;
          const quakeFoes = foesWithin(quake.aoeTiles * UNITS_PER_TILE);
          if (lvl >= quake.unlockLevel && ready('cheekQuake') && quakeFoes.length > 0) {
            const dmg = Math.floor((abilityDpsOf(tr) * quake.aoeDmgPctDps[tierIdx]!) / 100);
            const stun = Math.floor((quake.stunDeciSec[tierIdx]! * TICKS_PER_SEC) / 10);
            for (const foe of quakeFoes) { damageTroop(tick, foe.id, dmg, true); foe.stunUntil = tick + stun; }
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
              skill: 'cheekQuake', phase: 'impact', x: tr.x, y: tr.y });
            startCd('cheekQuake', quake.cdSec);
          }
          const snot = HERO_SKILLS.theodor.snotRocket;
          const snotFoe = nearestFoe(snot.castRangeTiles * UNITS_PER_TILE);
          if (lvl >= snot.unlockLevel && ready('snotRocket') && snotFoe) {
            damageTroop(tick, snotFoe.id,
              Math.floor((abilityDpsOf(tr) * snot.dmgPctDps[tierIdx]!) / 100), true);
            snotFoe.stunUntil = Math.max(snotFoe.stunUntil ?? 0,
              tick + Math.floor((snot.blindDeciSec[tierIdx]! * TICKS_PER_SEC) / 10));
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
              skill: 'snotRocket', phase: 'impact', x: snotFoe.x, y: snotFoe.y, target: snotFoe.id });
            startCd('snotRocket', snot.cdSec);
          }
          const cb = HERO_SKILLS.theodor.cannonball;
          const leapFoe = nearestFoe(cb.leapRangeTiles[tierIdx]! * UNITS_PER_TILE);
          if (lvl >= cb.unlockLevel && ready('cannonball') && leapFoe
            && dist2(tr.x, tr.y, leapFoe.x, leapFoe.y) > tr.rangeUnits ** 2) {
            const fromX = tr.x, fromY = tr.y;
            const landing = stepToward(tr, leapFoe.x, leapFoe.y,
              Math.max(0, isqrt(dist2(tr.x, tr.y, leapFoe.x, leapFoe.y)) - tr.rangeUnits));
            if (wallAt(landing.nx, landing.ny) < 0) { tr.x = landing.nx; tr.y = landing.ny; }
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
              skill: 'cannonball', phase: 'impact', x: tr.x, y: tr.y,
              fromX, fromY, toX: tr.x, toY: tr.y, target: leapFoe.id });
            events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
            startCd('cannonball', cb.cdSec);
          }
          const aura = HERO_SKILLS.theodor.skillIssue;
          if (lvl >= aura.unlockLevel) {
            const radius = HERO_DEFENCE.theodorTauntRadiusTiles * UNITS_PER_TILE;
            let pulled = false;
            for (const foe of foesWithin(radius)) {
              foe.tauntTarget = tr.id;
              foe.tauntUntil = tick + HERO_DEFENCE.theodorTauntSec * TICKS_PER_SEC;
              pulled = true;
            }
            if (pulled && onceAvailable(tr, 'skillIssue')) {
              markUsedOnce(tr, 'skillIssue');
              events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
                skill: 'skillIssue', phase: 'active', x: tr.x, y: tr.y,
                until: tick + HERO_DEFENCE.theodorTauntSec * TICKS_PER_SEC });
            }
          }
          const sd = HERO_SKILLS.theodor.silentButDeadly;
          if (lvl >= sd.unlockLevel && onceAvailable(tr, 'silentButDeadly')
            && foesWithin(sd.novaRadiusTiles * UNITS_PER_TILE).length > 0) {
            markUsedOnce(tr, 'silentButDeadly');
            const windup = (sd.eatWindupSec + sd.swellWindupSec) * TICKS_PER_SEC;
            (tr.buffUntil ??= {}).silentWindup = tick + windup;
            tr.actionUntil = tick + windup;
            tr.silentX = tr.x; tr.silentY = tr.y;
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
              skill: 'silentButDeadly', phase: 'windup', x: tr.x, y: tr.y,
              until: tick + windup });
          }
        }
        continue;
      }
      // Still playing dead → casts nothing.
      if (untargetable(tr, tick)) continue;

      if (tr.hero === 'vex') {
        const s = HERO_SKILLS.vex.crimsonDash;
        if (lvl >= s.unlockLevel && ready('crimsonDash') && tr.targetB >= 0) {
          const tgt = buildings[tr.targetB];
          if (tgt && !tgt.destroyed) {
            const cx = tileCenter(tgt.tx) + ((tgt.fw - 1) * UNITS_PER_TILE) / 2;
            const cy = tileCenter(tgt.ty) + ((tgt.fh - 1) * UNITS_PER_TILE) / 2;
            const dx = cx - tr.x;
            const dy = cy - tr.y;
            const dist = isqrt(dx * dx + dy * dy);
            if (dist >= s.minGapTiles * UNITS_PER_TILE) {
              // Dash: advance up to rangeTiles along the line in ONE tick,
              // stepping tile-by-tile; every live wall crossed takes line
              // damage x wallMult (keg-runner wall-burst precedent, hit events
              // included so the client HP mirror tracks) and troops on the
              // line take the edge too (spec: "troops AND walls"). The dash
              // is wall-piercing MOVEMENT — it never blocks on what it hits.
              const range = s.rangeTiles[tierIdx]! * UNITS_PER_TILE;
              const adv = Math.min(range, dist - UNITS_PER_TILE / 2); // stop shy of the target center
              const steps = Math.max(1, Math.floor(adv / (UNITS_PER_TILE / 2)));
              const dmgDeci = Math.floor((abilityDpsOf(tr) * s.lineDmgPctDps[tierIdx]!) / 100);
              const wallDmg = dmgDeci * s.wallMult[tierIdx]!;
              const hitWalls = new Set<number>();
              const hitTroops = new Set<number>();
              // Land on the LAST sample whose tile holds no live wall: committing
              // the raw endpoint could strand the hero INSIDE a wall, where the
              // cost field prices his own tile at WALL_COST and movement freezes
              // for the rest of the battle (confirmed adversarial finding).
              let lx = tr.x;
              let ly = tr.y;
              for (let st = 1; st <= steps; st++) {
                // Integer math throughout (sim hard rule): one truncated division
                // of an integer product, matching stepToward — never a float ratio.
                const nx = tr.x + Math.trunc((dx * st * adv) / (dist * steps));
                const ny = tr.y + Math.trunc((dy * st * adv) / (dist * steps));
                const wtx = Math.floor(nx / UNITS_PER_TILE);
                const wty = Math.floor(ny / UNITS_PER_TILE);
                const wi = inPlot(wtx, wty) ? wallIdx[plotIndex(wtx, wty)]! : -1;
                if (wi >= 0 && !hitWalls.has(wi) && !buildings[wi]!.destroyed) {
                  hitWalls.add(wi);
                  const applied = wallAdjusted(tr, wi, wallDmg);
                  events.push({ t: tick, e: 'hit', target: buildings[wi]!.id, dmg: Math.round(applied / 10) });
                  damageBuilding(tick, wi, applied);
                }
                for (let ti = 0; ti < troops.length; ti++) {
                  const foe = troops[ti]!;
                  if (foe.side === tr.side || foe.phase === 'dead' || hitTroops.has(ti)) continue;
                  if (dist2(nx, ny, foe.x, foe.y) <= (UNITS_PER_TILE / 2) ** 2) {
                    hitTroops.add(ti);
                    damageTroop(tick, ti, dmgDeci, true);
                  }
                }
                if (wi < 0 || buildings[wi]!.destroyed) { lx = nx; ly = ny; }
              }
              const fromX = tr.x, fromY = tr.y;
              tr.x = lx;
              tr.y = ly;
              // The dash rewrote the hero's position: any pre-dash wall block is
              // stale (damaging it from afar / freezing pathing were both real).
              unblock(tr);
              events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
                skill: 'crimsonDash', phase: 'impact', x: tr.x, y: tr.y,
                fromX, fromY, toX: tr.x, toY: tr.y });
              events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
              startCd('crimsonDash', s.cdSec);
            }
          }
        }

        // --- MOONSUNDER WAVE (L5, CD 16s) ----------------------------------
        // "An iai draw so fast only the wave is visible. The crescent travels 6
        // tiles, pierces everything, and leaves BLEED ticking." He does NOT move:
        // this is Vex's only ranged option and his answer to a wall he does not
        // want to dash past. castCrescent declines (spending nothing) if the line
        // is empty, so he never swings at air.
        {
          const w = HERO_SKILLS.vex.moonsunderWave;
          const wDmgPct = w.waveDmgPctDps[tierIdx]!;
          if (lvl >= w.unlockLevel && wDmgPct > 0 && ready('moonsunderWave') && tr.targetB >= 0) {
            const tgt = buildings[tr.targetB];
            if (tgt && !tgt.destroyed) {
              const c = centerOf(tgt);
              const dx = c.x - tr.x;
              const dy = c.y - tr.y;
              const dist = isqrt(dx * dx + dy * dy);
              const fired = castCrescent(
                tick, tr, dx, dy, dist, w.rangeTiles * UNITS_PER_TILE, w.widthTiles[tierIdx]!,
                Math.floor((abilityDpsOf(tr) * wDmgPct) / 100), w.bleedPctMaxHpPer4s[tierIdx]!,
              );
              if (fired) {
                events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
                  skill: 'moonsunderWave', phase: 'impact', x: tr.x, y: tr.y,
                  toX: c.x, toY: c.y, target: tgt.id });
                startCd('moonsunderWave', w.cdSec);
              }
            }
          }
        }

        // --- DEGEN AWAKENING (L10, CD 40s, 10s window) ---------------------
        // "The shard takes over… faster, hungrier, unstoppable." A pure Z2 timed
        // self-buff: the damage bonus is read in pass 3's percent chain and the
        // lifesteal at the two places he deals damage. Cast only while ENGAGED
        // (phase 'attacking'), so a 40s cooldown is not burned walking in.
        {
          const dg = HERO_SKILLS.vex.degenAwakening;
          const live = dg.dmgPct[tierIdx]! + dg.atkSpeedPct[tierIdx]! + dg.lifestealPct[tierIdx]!;
          if (lvl >= dg.unlockLevel && live > 0 && ready('degenAwakening') && tr.phase === 'attacking') {
            (tr.buffUntil ??= {})['degen'] = tick + dg.durationSec * TICKS_PER_SEC;
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
              skill: 'degenAwakening', phase: 'active', x: tr.x, y: tr.y,
              until: tick + dg.durationSec * TICKS_PER_SEC });
            startCd('degenAwakening', dg.cdSec);
          }
        }

        // --- ALL IN: OMEGA SHARDSTORM (L20, once per battle, AWAKENED ONLY) --
        // "Vex plants Moonsunder and detonates the chest-shard: a 6-tile nova plus
        // eight crescents. Everything caught pays 300% DPS and eats a 2s stun."
        // AWAKENED ONLY is a real gate: it requires DEGEN AWAKENING's Z2 window to
        // be open, so the ult costs him the buff cast first.
        {
          const om = HERO_SKILLS.vex.omegaShardstorm;
          const novaPct = om.novaDmgPctDps[tierIdx]!;
          const radius = om.novaRadiusTiles * UNITS_PER_TILE;
          if (lvl >= om.unlockLevel && novaPct > 0 && onceAvailable(tr, 'omegaShardstorm')
            && (tr.buffUntil?.['degen'] ?? 0) > tick && anyBuildingWithin(radius)
            && !densePerimeterAhead(radius)) {
            markUsedOnce(tr, 'omegaShardstorm');
            const nova = Math.floor((abilityDpsOf(tr) * novaPct) / 100);
            damageBuildingsInRadius(tick, tr.x, tr.y, radius, nova, tr);
            for (const foe of troops) {
              if (foe.side === tr.side || foe.phase === 'dead') continue;
              if (dist2(tr.x, tr.y, foe.x, foe.y) <= radius * radius) damageTroop(tick, foe.id, nova, true);
            }
            stunAround(radius, Math.floor((om.stunDeciSec[tierIdx]! * TICKS_PER_SEC) / 10));
            // Eight crescents on FIXED integer bearings — the spec row is literally
            // "8 x wave dmg", so they are Moonsunder Waves and read its numbers.
            // COMPASS8 is a pre-computed integer table — see fixed.ts for why the
            // bearings are not derived trigonometrically.
            const w = HERO_SKILLS.vex.moonsunderWave;
            const cDmg = Math.floor((abilityDpsOf(tr) * w.waveDmgPctDps[tierIdx]!) / 100);
            for (const [ux, uy] of COMPASS8) {
              castCrescent(tick, tr, ux, uy, isqrt(ux * ux + uy * uy), w.rangeTiles * UNITS_PER_TILE,
                w.widthTiles[tierIdx]!, cDmg, w.bleedPctMaxHpPer4s[tierIdx]!);
            }
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'vex', side: tr.side,
              skill: 'omegaShardstorm', phase: 'impact', x: tr.x, y: tr.y });
          }
        }
      } else if (tr.hero === 'theodor') {
        const s = HERO_SKILLS.theodor.cheekQuake;
        if (lvl >= s.unlockLevel && ready('cheekQuake')) {
          // Cast only when it DOES something: a building inside the AoE.
          const aoe = s.aoeTiles * UNITS_PER_TILE;
          let any = false;
          for (let bi = 0; bi < buildings.length && !any; bi++) {
            const b = buildings[bi]!;
            if (b.destroyed) continue;
            const bx = tileCenter(b.tx) + ((b.fw - 1) * UNITS_PER_TILE) / 2;
            const by = tileCenter(b.ty) + ((b.fh - 1) * UNITS_PER_TILE) / 2;
            if (dist2(tr.x, tr.y, bx, by) <= aoe * aoe) any = true;
          }
          if (any) {
            const dmgDeci = Math.floor((abilityDpsOf(tr) * s.aoeDmgPctDps[tierIdx]!) / 100);
            damageBuildingsInRadius(tick, tr.x, tr.y, aoe, dmgDeci, tr);
            // Stun: defenses in the AoE skip fire for stunDeciSec (their own
            // cooldown field IS the stun — zero new state, fully replayable).
            const stunTicks = Math.floor((s.stunDeciSec[tierIdx]! * TICKS_PER_SEC) / 10);
            // Spec: "EVERYTHING in 3 tiles is stunned" — defender troops in the
            // AoE take the damage AND sit out the stun, not just defenses.
            for (let ti = 0; ti < troops.length; ti++) {
              const foe = troops[ti]!;
              if (foe.side === tr.side || foe.phase === 'dead') continue;
              if (dist2(tr.x, tr.y, foe.x, foe.y) <= aoe * aoe) {
                damageTroop(tick, ti, dmgDeci, true);
                if (troops[ti]!.phase !== 'dead') foe.stunUntil = Math.max(foe.stunUntil ?? 0, tick + stunTicks);
              }
            }
            const taunt = s.tauntTiles[tierIdx]! * UNITS_PER_TILE;
            for (const b of buildings) {
              if (b.destroyed || !b.def) continue;
              const bx = tileCenter(b.tx) + ((b.fw - 1) * UNITS_PER_TILE) / 2;
              const by = tileCenter(b.ty) + ((b.fh - 1) * UNITS_PER_TILE) / 2;
              const d2 = dist2(tr.x, tr.y, bx, by);
              if (d2 <= aoe * aoe) b.cooldown = Math.max(b.cooldown, stunTicks);
              // Taunt: defenses in the taunt radius drop their target for the
              // stool. Sticky targeting keeps them on him while he lives.
              if (d2 <= taunt * taunt) b.defTarget = tr.id;
            }
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
              skill: 'cheekQuake', phase: 'impact', x: tr.x, y: tr.y });
            startCd('cheekQuake', s.cdSec);
          }
        }

        // --- SNOT ROCKET (L3, CD 8s) ---------------------------------------
        // "Blinds the target, coats it in slime, and makes it forget every other
        // enemy on the field." Cheek Quake with radius 0 and one victim: damage,
        // a blind that IS the defense's own cooldown, and a forced-aggro
        // defTarget. Targets a live SHOOTER (b.def) — blinding a Dragon Nest,
        // which fires nothing, would be a wasted cast.
        {
          const sr = HERO_SKILLS.theodor.snotRocket;
          if (lvl >= sr.unlockLevel && ready('snotRocket')) {
            const range = sr.castRangeTiles * UNITS_PER_TILE;
            const bi = nearestBuilding(tr.x, tr.y, (b) => b.def !== null);
            const tgt = bi >= 0 ? buildings[bi]! : undefined;
            if (tgt && dist2ToRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh) <= range * range) {
              const dmgDeci = Math.floor((abilityDpsOf(tr) * sr.dmgPctDps[tierIdx]!) / 100);
              events.push({ t: tick, e: 'hit', target: tgt.id, dmg: Math.round(dmgDeci / 10) });
              damageBuilding(tick, bi, dmgDeci);
              tgt.cooldown = Math.max(tgt.cooldown, Math.floor((sr.blindDeciSec[tierIdx]! * TICKS_PER_SEC) / 10));
              tgt.defTarget = tr.id; // FORCED AGGRO: yes at every tier
              const c = centerOf(tgt);
              events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
                skill: 'snotRocket', phase: 'impact', x: c.x, y: c.y, target: tgt.id });
              startCd('snotRocket', sr.cdSec);
            }
          }
        }

        // --- CANNONBALL (L5, CD 14s) ---------------------------------------
        // "He launches himself up to 6 tiles and lands arse-first ON TOP of a
        // building — over walls, over troops, over your feelings." A fixed
        // teleport, not a parabola (the parabola is the client's: "the engine
        // translates the sprite… the frames carry the pose only"). Sitting on a
        // footprint needs no support — only WALLS block movement here — so from
        // the landing tick he simply attacks it at range 0.
        {
          const cb = HERO_SKILLS.theodor.cannonball;
          if (lvl >= cb.unlockLevel && ready('cannonball') && tr.targetB >= 0) {
            const tgt = buildings[tr.targetB];
            const leap = cb.leapRangeTiles[tierIdx]! * UNITS_PER_TILE;
            const d2r = tgt && !tgt.destroyed
              ? dist2ToRect(tr.x, tr.y, tgt.tx, tgt.ty, tgt.fw, tgt.fh) : -1;
            // Only worth it as a GAP CLOSER: not already in reach, and inside the leap.
            if (tgt && d2r > tr.rangeUnits ** 2 && d2r <= leap * leap) {
              const c = centerOf(tgt);
              const fromX = tr.x, fromY = tr.y;
              tr.x = c.x; tr.y = c.y;
              unblock(tr); // he went over it
              const dmgDeci = Math.floor((abilityDpsOf(tr) * cb.impactDmgPctDps[tierIdx]!) / 100);
              const applied = wallAdjusted(tr, tr.targetB, dmgDeci);
              events.push({ t: tick, e: 'hit', target: tgt.id, dmg: Math.round(applied / 10) });
              damageBuilding(tick, tr.targetB, applied);
              const gift = cb.partingGiftDps[tierIdx]!;
              if (gift > 0 && !tgt.destroyed) tr.cannonballGift = {
                bi: tr.targetB, dps: wallAdjusted(tr, tr.targetB, gift),
                durationTicks: cb.partingGiftSec * TICKS_PER_SEC,
              };
              events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
                skill: 'cannonball', phase: 'impact', x: tr.x, y: tr.y,
                fromX, fromY, toX: tr.x, toY: tr.y, target: tgt.id });
              events.push({ t: tick, e: 'pos', id: tr.id, x: tr.x, y: tr.y });
              startCd('cannonball', cb.cdSec);
            }
          }
        }

        // --- SKILL ISSUE (L8, always-on aura) ------------------------------
        // "Every defence in radius drops what it was doing and shoots at him
        // instead — which is exactly the plan, because he barely notices."
        // Two halves: this retarget loop, and the damage reduction, which lives in
        // `mitigate` because it must cover EVERY damage source, not just defenses.
        // Re-asserting defTarget per tick is idempotent (it is sticky, and only
        // `valid()` drops it). Always on: the block carries no cooldown, so a
        // duration would be unobservable — see Q2 in constants.ts.
        {
          const si = HERO_SKILLS.theodor.skillIssue;
          if (lvl >= si.unlockLevel) {
            const r = si.retargetTiles[tierIdx]! * UNITS_PER_TILE;
            let pulled = false;
            for (const b of buildings) {
              if (b.destroyed || !b.def) continue;
              const c = centerOf(b);
              if (dist2(tr.x, tr.y, c.x, c.y) <= r * r) { b.defTarget = tr.id; pulled = true; }
            }
            // ONE render cue per battle: a per-tick event would add ~900 entries
            // to the log for an effect that never turns off.
            if (pulled && onceAvailable(tr, 'skillIssue')) {
              markUsedOnce(tr, 'skillIssue');
              events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
                skill: 'skillIssue', phase: 'active', x: tr.x, y: tr.y });
            }
          }
        }

        // --- BROWN NOTE (L14, CD 20s) --------------------------------------
        // "He turns, braces against the masonry, and lets go. One wall segment is
        // DELETED outright — tier is irrelevant, HP is irrelevant." Theodor's ONLY
        // wall answer (his wallPolicy is 'follow' and his dps is a joke by design).
        //
        // Passing the segment's exact hpDeci deletes it with no overkill, fires
        // `destroyed`, and triggers rebuildWalls() — which drops every cached cost
        // field and re-opens pathing for the whole army. That re-route IS the
        // skill. Walls never count toward destruction %, so the number is untouched.
        //
        // He braces against the wall that is actually BLOCKING him: that gate is
        // the spec image and, unlike a cast range, it invents no number.
        {
          const bn = HERO_SKILLS.theodor.brownNote;
          if (lvl >= bn.unlockLevel && ready('brownNote')
            && tr.blockedWall >= 0 && !buildings[tr.blockedWall]!.destroyed) {
            const first = tr.blockedWall;
            const w0 = buildings[first]!;
            const targets = [first];
            // T4 takes a second, ADJACENT segment. Neighbours are read BEFORE the
            // first deletion, because rebuildWalls() clears wallIdx. Fixed order
            // N, W, E, S — deterministic, and it prefers extending the run.
            if (bn.wallSegments[tierIdx]! > 1) {
              const nb = [[w0.tx, w0.ty - 1], [w0.tx - 1, w0.ty], [w0.tx + 1, w0.ty], [w0.tx, w0.ty + 1]] as const;
              for (const [nx, ny] of nb) {
                if (targets.length >= bn.wallSegments[tierIdx]!) break;
                if (!inPlot(nx, ny)) continue;
                const wi = wallIdx[plotIndex(nx, ny)]!;
                if (wi >= 0 && !buildings[wi]!.destroyed) targets.push(wi);
              }
            }
            const gasSec = bn.gasSec[tierIdx]!;
            for (const wi of targets) {
              const w = buildings[wi]!;
              if (w.destroyed) continue;
              events.push({ t: tick, e: 'hit', target: w.id, dmg: Math.round(w.hpDeci / 10) });
              damageBuilding(tick, wi, w.hpDeci); // exact: no overkill, no partial
              // GAS: a ground zone over the hole. Defender troops only (Q4) — so
              // against a base with no Dragon Nest the deletion is the whole skill.
              if (gasSec > 0) {
                dots.push({ kind: 'zone', bi: -1, ti: -1,
                  cx: tileCenter(w.tx), cy: tileCenter(w.ty),
                  r2: (bn.gasRadiusTiles * UNITS_PER_TILE) ** 2,
                  dmgDeciPerTick: bn.gasDps, untilTick: tick + gasSec * TICKS_PER_SEC });
              }
            }
            unblock(tr); // the masonry is gone; re-path next tick
            const c = centerOf(w0);
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
              skill: 'brownNote', phase: 'impact', x: c.x, y: c.y, target: w0.id });
            startCd('brownNote', bn.cdSec);
          }
        }

        // --- SILENT BUT DEADLY (L20, once per battle) -----------------------
        // "A 6-tile nova, a lingering cloud, and every troop caught inside runs
        // the other way." The 5s+3s wind-up occupies the hero action clock;
        // impact stamps fear origin/time, and pass 3 moves victims away from it.
        {
          const sd = HERO_SKILLS.theodor.silentButDeadly;
          const radius = sd.novaRadiusTiles * UNITS_PER_TILE;
          if (lvl >= sd.unlockLevel && onceAvailable(tr, 'silentButDeadly') && anyBuildingWithin(radius)) {
            markUsedOnce(tr, 'silentButDeadly');
            const windup = (sd.eatWindupSec + sd.swellWindupSec) * TICKS_PER_SEC;
            (tr.buffUntil ??= {}).silentWindup = tick + windup;
            tr.actionUntil = tick + windup;
            tr.silentX = tr.x; tr.silentY = tr.y;
            events.push({ t: tick, e: 'heroSkill', id: tr.id, hero: 'theodor', side: tr.side,
              skill: 'silentButDeadly', phase: 'windup', x: tr.x, y: tr.y,
              until: tick + windup });
          }
        }
      }
    }

    // 4c) lingering DoTs (Z1) — CANNONBALL's parting gift (a building), BROWN
    // NOTE's gas and SILENT BUT DEADLY's cloud (ground zones), MOONSUNDER WAVE's
    // bleed (a victim). Drained in insertion order, BEFORE defenses fire, so a
    // gift that finishes a tower this tick silences it this tick. Compacted in
    // place so expiry preserves order and allocates nothing. Inert (and therefore
    // byte-identical for every non-hero raid) while the list is empty.
    if (dots.length > 0) {
      let write = 0;
      for (let di = 0; di < dots.length; di++) {
        const d = dots[di]!;
        if (tick >= d.untilTick) continue;
        if (d.kind === 'building') {
          const b = buildings[d.bi]!;
          if (!b.destroyed) {
            events.push({ t: tick, e: 'hit', target: b.id, dmg: Math.round(d.dmgDeciPerTick / 10) });
            damageBuilding(tick, d.bi, d.dmgDeciPerTick);
          }
        } else if (d.kind === 'troop') {
          damageTroop(tick, d.ti, d.dmgDeciPerTick, true);
        } else {
          for (const foe of troops) {
            if (foe.phase === 'dead' || (d.ownerSide !== undefined && foe.side === d.ownerSide)) continue;
            if (d.ownerSide === undefined && foe.side !== 'defender') continue;
            if (dist2(d.cx, d.cy, foe.x, foe.y) <= d.r2) damageTroop(tick, foe.id, d.dmgDeciPerTick, true);
          }
        }
        dots[write++] = d;
      }
      dots.length = write;
    }

    // Direwyvern burn zones damage the union of their three patches once per
    // caster per tick. Different casters still stack in COMBAT, but their damage
    // is coalesced into one target hit/event per tick: a legal 28-wyvern roster
    // must not multiply replay JSON by caster × target × 50 field ticks.
    if (burnFields.length > 0) {
      let write = 0;
      for (let fi = 0; fi < burnFields.length; fi++) {
        const f = burnFields[fi]!;
        if (tick >= f.untilTick) continue;
        burnFields[write++] = f;
      }
      burnFields.length = write;
      for (let bi = 0; bi < buildings.length; bi++) {
        const b = buildings[bi]!;
        if (b.destroyed || isTrapType(b.type)) continue;
        let dmgDeci = 0;
        for (const f of burnFields) {
          if (f.centers.some((c) => dist2ToRect(c.x, c.y, b.tx, b.ty, b.fw, b.fh) <= f.radius2)) {
            dmgDeci += f.dmgDeciPerTick;
          }
        }
        if (dmgDeci <= 0) continue;
        events.push({ t: tick, e: 'hit', target: b.id, dmg: Math.round(dmgDeci / 10) });
        damageBuilding(tick, bi, dmgDeci);
      }
      for (const foe of troops) {
        if (foe.side !== 'defender' || foe.phase === 'dead') continue;
        let dmgDeci = 0;
        for (const f of burnFields) {
          if (f.centers.some((c) => dist2(c.x, c.y, foe.x, foe.y) <= f.radius2)) {
            dmgDeci += f.dmgDeciPerTick;
          }
        }
        if (dmgDeci > 0) damageTroop(tick, foe.id, dmgDeci, true);
      }
    }

    // 5) defenses fire (building order — deterministic)
    if (!draining) for (let bi = 0; bi < buildings.length; bi++) {
      const b = buildings[bi]!;
      if (b.destroyed || !b.def) continue;
      if (b.cooldown > 0) { b.cooldown--; continue; }
      const cx = tileCenter(b.tx) + ((b.fw - 1) * UNITS_PER_TILE) / 2;
      const cy = tileCenter(b.ty) + ((b.fh - 1) * UNITS_PER_TILE) / 2;
      const profileAt = (d2: number): DefenseCombat =>
        b.def!.lowRange && d2 <= b.def!.lowRange.rangeUnits ** 2 ? b.def!.lowRange : b.def!;
      // sticky target if still valid
      let ti = b.defTarget;
      const valid = (k: number): boolean => {
        const tr = troops[k];
        if (!tr || tr.phase === 'dead' || tr.phase === 'burrowed' || tr.phase === 'idle') return false;
        if (untargetable(tr, tick)) return false; // RAGE QUIT: "defences must re-acquire"
        if (tr.side !== 'attacker') return false; // never shoot friendly wyrmlings
        // a FLYING attacker (Dragon) is only hittable by air-capable towers
        // (archer/mage/electric/air-defence) — cannon/mortar/laser can't touch it.
        const d2 = dist2(cx, cy, tr.x, tr.y);
        const def = profileAt(d2);
        if (behaviorOf(tr).isFlying ? !def.targetsAir : !def.targetsGround) return false;
        // ANTI-AIR reach is measured to this defense's FOOTPRINT EDGE — the same
        // anchor the flyer's own attack uses against the defense (reachFor →
        // dist2ToRect). SIM10 measured centre-to-point both ways, so a range-4
        // Dragon dismantling a range-4 tower hovered ~4.4–4.9 tiles from its
        // centre and the tower fired ZERO shots for the whole fight (K-030); a
        // symmetric anchor makes an equal-range duel an actual duel. Ground
        // targeting stays centre-measured — every ground matchup is deliberately
        // untouched (D-060/SIM11). Air-capable defenses all have minRange 0, so
        // the dead-zone comparison only ever gates centre-measured ground fire.
        const gate2 = behaviorOf(tr).isFlying
          ? dist2ToRect(tr.x, tr.y, b.tx, b.ty, b.fw, b.fh) : d2;
        return gate2 <= def.rangeUnits ** 2 && gate2 >= def.minRangeUnits ** 2;
      };
      if (ti === -1 || !valid(ti)) {
        ti = -1;
        let bestD = Infinity;
        for (const tr of troops) {
          if (!valid(tr.id)) continue;
          const d2 = dist2(cx, cy, tr.x, tr.y);
          if (d2 < bestD) { bestD = d2; ti = tr.id; }
        }
        b.defTarget = ti;
      }
      if (ti === -1) continue;
      const tr = troops[ti]!;
      const activeDef = profileAt(dist2(cx, cy, tr.x, tr.y));
      const dmg = jitter(activeDef.shotDeci, rng);
      const defenseKey = b.type === BuildingType.Keep
        ? (activeDef.proj === 'shell' ? 'mortar' : 'cannon')
        : b.type as keyof typeof DEFENSE_PROJECTILE_TIMINGS;
      const shotTiming = DEFENSE_PROJECTILE_TIMINGS[defenseKey];
      projectiles.push({
        impactTick: tick + activeDef.projTicks,
        releaseTick: tick + Math.ceil(shotTiming.releaseOffsetMs / 100),
        released: shotTiming.releaseOffsetMs === 0,
        fromB: bi,
        targetTroop: ti,
        splash: activeDef.splashUnits > 0,
        targetsAir: activeDef.targetsAir,
        ix: tr.x, iy: tr.y,
        dmgDeci: dmg,
        splashUnits: activeDef.splashUnits,
        // chain fields only for the electric tower (exactOptionalPropertyTypes:
        // omit rather than assign undefined)
        ...(activeDef.chainMax !== undefined
          ? { chainMax: activeDef.chainMax, chainFalloffPct: activeDef.chainFalloffPct }
          : {}),
      });
      events.push({ t: tick, e: 'fire', id: b.id, target: ti, proj: activeDef.proj,
        ix: tr.x, iy: tr.y, releaseOffsetMs: shotTiming.releaseOffsetMs,
        flightMs: shotTiming.flightMs, impactOffsetTicks: activeDef.projTicks });
      b.cooldown = activeDef.intervalTicks - 1;
    }

    // 6) projectile impacts
    for (let pi = projectiles.length - 1; pi >= 0; pi--) {
      const p = projectiles[pi]!;
      if (p.impactTick !== tick) continue;
      if (p.splash) {
        for (const tr of troops) {
          if (tr.phase === 'dead' || tr.phase === 'burrowed' || tr.phase === 'idle') continue;
          if (untargetable(tr, tick)) continue;
          if (tr.side !== 'attacker') continue; // no friendly splash on wyrmlings
          if (behaviorOf(tr).isFlying && !p.targetsAir) continue; // ground splash can't hit air
          if (dist2(p.ix, p.iy, tr.x, tr.y) <= p.splashUnits ** 2) {
            damageTroop(tick, tr.id, p.dmgDeci, true);
          }
        }
      } else {
        // direct shots always connect if the target is still alive (CoC convention)
        const tr = troops[p.targetTroop];
        // A shot already in flight when RAGE QUIT procs whiffs entirely — chain
        // hops included, since the bolt never connected to arc from.
        if (tr && tr.phase !== 'dead' && tr.phase !== 'burrowed' && !untargetable(tr, tick)) {
          damageTroop(tick, p.targetTroop, p.dmgDeci, true);
          // electric chain: hop from the last-hit troop to the nearest OTHER live
          // troop (ties → lower id, never revisiting), decaying by chainFalloffPct.
          // Deterministic (dist2 ordering, integer % of the ONE jittered base) — the
          // hops are reported via a single 'chain' event, not per-hop 'hit's.
          if (p.chainMax && p.chainFalloffPct) {
            const hitSet = new Set<number>([p.targetTroop]);
            let fromX = tr.x, fromY = tr.y;
            const targets: number[] = [], dmgs: number[] = [];
            for (let h = 0; h < p.chainMax; h++) {
              let best = -1, bestD = Infinity;
              for (const o of troops) {
                if (o.phase === 'dead' || o.phase === 'burrowed' || o.phase === 'idle' || hitSet.has(o.id)) continue;
                if (untargetable(o, tick)) continue;
                if (o.side !== 'attacker') continue; // chain only arcs across raiders
                const d = dist2(fromX, fromY, o.x, o.y);
                if (d < bestD) { bestD = d; best = o.id; }
              }
              if (best === -1) break;
              const hopDmg = Math.floor((p.dmgDeci * (p.chainFalloffPct[h] ?? 0)) / 100);
              if (hopDmg > 0) {
                damageTroop(tick, best, hopDmg, false);
                targets.push(best); dmgs.push(Math.round(hopDmg / 10));
              }
              hitSet.add(best);
              fromX = troops[best]!.x; fromY = troops[best]!.y;
            }
            if (targets.length > 0) events.push({ t: tick, e: 'chain', id: buildings[p.fromB]!.id, targets, dmg: dmgs });
          }
        }
      }
      projectiles.splice(pi, 1);
    }

    // 6.5) Dragon Nest spawns DEFENDER wyrmlings — the only troops active on defense
    // (trained troops never defend). Expire wyrmlings past their lifespan, then each
    // live nest spawns up to maxSpawns concurrent wyrmlings every spawnIntervalSec
    // while raiders remain. Inert unless a DragonNest is in the snapshot → the golden
    // fixtures (no nest) are byte-identical.
    if (!draining) {
      const nestDef = DEFENSES.dragonnest;
      const lifespanTicks = nestDef.spawnLifespanSec * TICKS_PER_SEC;
      for (const w of troops) {
        if (w.side === 'defender' && w.phase !== 'dead' && tick - w.spawnTick >= lifespanTicks) {
          w.phase = 'dead';
          events.push({ t: tick, e: 'troopDeath', id: w.id });
        }
      }
      if (tick > 0 && tick % (nestDef.spawnIntervalSec * TICKS_PER_SEC) === 0 &&
          troops.some((t) => t.side === 'attacker' && t.phase !== 'dead')) {
        for (let bi = 0; bi < buildings.length; bi++) {
          const nest = buildings[bi]!;
          if (nest.destroyed || nest.type !== BuildingType.DragonNest) continue;
          const alive = troops.filter((t) => t.side === 'defender' && t.fromNest === bi && t.phase !== 'dead').length;
          if (alive >= nestDef.maxSpawns) continue;
          const c = troopCombat('wyrmling', 1);
          const id = troops.length;
          const wx = tileCenter(nest.tx) + ((nest.fw - 1) * UNITS_PER_TILE) / 2;
          const wy = tileCenter(nest.ty) + ((nest.fh - 1) * UNITS_PER_TILE) / 2;
          troops.push({
            id, type: 'wyrmling', level: 1, side: 'defender', spawnTick: tick, fromNest: bi,
            x: wx, y: wy, hpDeci: c.hp * 10, maxHpDeci: c.hp * 10, phase: 'moving',
            targetB: -1, blockedWall: -1, routing: 0, kegWall: -1, breachWall: -1, emergeLeft: 0, burrowedUnits: 0,
            dpsDeci: c.dpsDeci, unitsPerTick: c.unitsPerTick, rangeUnits: c.rangeUnits,
          });
          assertRepresentationLimits(troops.length);
          events.push({ t: tick, e: 'spawn', id, from: nest.id, troop: 'wyrmling', x: wx, y: wy });
        }
      }
    }

    // 7) end conditions
    assertRepresentationLimits(troops.length);
    if (destructionPct() >= 100) { tick++; break; }
    // only ATTACKER troops keep the raid alive (defender wyrmlings don't count — else
    // a Nest would run the clock to MAX_TICKS after the raider is wiped).
    const anyAlive = troops.some((t) => t.side === 'attacker' && t.phase !== 'dead' && t.phase !== 'idle');
    const pendingAccepted = projectiles.length > 0 || scheduledTroopImpacts.length > 0
      || scheduledTroopEffects.length > 0 || burnFields.length > 0 || dots.length > 0;
    if (nextDeploy >= deploys.length && !anyAlive && !pendingAccepted) { tick++; break; }
    if (draining && !pendingAccepted) { tick++; break; }
    // An accepted RETREAT boundary: this tick is fully resolved, nothing later
    // (in-flight impacts included) may land. Checked last so the ordinary end
    // conditions above keep their exact tick when they fire first.
    if (stopAfterTick >= 0 && tick >= stopAfterTick) { tick++; break; }
  }

  emitStars(tick);
  assertRepresentationLimits(troops.length);
  const pct = destructionPct();
  const stars = computeStars(pct, keepDestroyed);

  return {
    stars,
    destructionPct: pct,
    keepDestroyed,
    vaultDestroyed: buildings.some((b) => b.type === BuildingType.Vault && b.destroyed),
    mineDestroyed: buildings.some((b) => b.type === BuildingType.Mine && b.destroyed),
    victory: stars >= 1,
    buildings: buildings.map((b) => ({
        id: b.id,
        type: b.type,
        hp: Math.ceil(b.hpDeci / 10),
        maxHp: b.maxHpDeci / 10,
        destroyed: b.destroyed,
      })),
    ticks: tick,
    events,
  };
}

/** One movement step toward (gx,gy); exact-integer proportional step. */
function stepToward(tr: { x: number; y: number }, gx: number, gy: number, step: number): { nx: number; ny: number } {
  const dx = gx - tr.x;
  const dy = gy - tr.y;
  const d = isqrt(dx * dx + dy * dy);
  if (d === 0 || d <= step) return { nx: gx, ny: gy };
  return {
    nx: tr.x + Math.trunc((dx * step) / d),
    ny: tr.y + Math.trunc((dy * step) / d),
  };
}
