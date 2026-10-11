/**
 * Sim-internal types: orders, events, outcome (ARCHITECTURE §6).
 * Cross-package types (BaseSnapshot, DeployOrder, …) come from @shardkeep/shared.
 */
import type { AttackRunEvent, BuildingType, DefenseFireEvent, DeployOrder, HeroCombatLoadout, TrapType, TroopType } from '@shardkeep/shared';

/** Pre-battle consumables; at most one of each per raid (GDD §3.5). */
export interface BuffSet {
  warhorn?: boolean;
  swiftboots?: boolean;
  powdercharge?: boolean;
}

/** The once-per-raid Rally pulse (GDD §3.5). tMs since deploy-phase start. */
export interface RallyOrder {
  tx: number;
  ty: number;
  tMs: number;
}

/** One hero drop (D4a, 2026-07-28): the hero is spawned as a pseudo-deploy of
 *  its donor troop so it reuses the deterministic troop machinery, but the donor
 *  supplies the SPRITE only — hp/dps come from HERO_LEVELING and every
 *  behavioural field (speed, reach, targeting, wall policy) from HERO_COMBAT
 *  (2026-07-29: inheriting the donor's role was two live bugs). One per raid
 *  (API-enforced); part of the stored orders, so replays carry it for free. */
/** `level` is the hero's OWN level (1..HERO_LEVELING.maxLevel), stamped by the
 *  server from hero_levels — never taken from the client. Absent = 1, which is
 *  bit-identical to the pre-leveling tables, so old replays are unaffected. */
export interface HeroDeploy {
  hero: 'vex' | 'theodor';
  tx: number;
  ty: number;
  tMs: number;
  level?: number;
  /** Server-stamped only. The public order schema strips any client attempt. */
  loadout?: HeroCombatLoadout;
}

export type HeroSide = 'attacker' | 'defender';
export type HeroSkillName =
  | 'crimsonDash' | 'moonsunderWave' | 'degenAwakening'
  | 'doubleOrNothingHeads' | 'doubleOrNothingTails' | 'omegaShardstorm'
  | 'cheekQuake' | 'snotRocket' | 'cannonball' | 'skillIssue'
  | 'bellyBounce' | 'brownNote' | 'rageQuit' | 'rageQuitWake'
  | 'silentButDeadly';
export type HeroSkillPhase =
  | 'windup' | 'takeoff' | 'impact' | 'active' | 'depart'
  | 'fakeDeath' | 'revive' | 'heads' | 'tails' | 'reflect';

/** Everything the attacker chose. Together with (snapshot, seed) this is the full replay input. */
export interface RaidOrders {
  deploys: DeployOrder[];
  heroDeploys?: HeroDeploy[];
  buffs?: BuffSet;
  rally?: RallyOrder;
}

// ---------------------------------------------------------------------------
// Events — the replayable battle log. Compact flat records; `t` = tick (100ms).
// Positions are in 1/256-tile units.
// ---------------------------------------------------------------------------

export type SimEvent =
  | AttackRunEvent
  | DefenseFireEvent
  | { t: number; e: 'deploy'; id: number; troop: TroopType; x: number; y: number;
      /** Set for hero drops — the client renders hero art instead of the donor troop's. */
      hero?: 'vex' | 'theodor'; side?: HeroSide }
  | { t: number; e: 'pos'; id: number; x: number; y: number }
  /** One exhaustive hero phase. Optional geometry is present only when that
   * phase travels or contacts a distinct point; `until` is an exact sim tick. */
  | { t: number; e: 'heroSkill'; id: number; hero: 'vex' | 'theodor'; side: HeroSide;
      skill: HeroSkillName; phase: HeroSkillPhase; x: number; y: number;
      fromX?: number; fromY?: number; toX?: number; toY?: number;
      target?: number | string; until?: number; refundPct?: number }
  | { t: number; e: 'heroAttack'; id: number; hero: 'vex' | 'theodor'; side: HeroSide;
      targetKind: 'troop' | 'building'; target: number | string; ix: number; iy: number;
      recoveryUntil: number }
  /**
   * Legacy ranged release cue retained for pre-SIM9 logs, defender Wyrmlings,
   * and hero/donor paths. Ordinary SIM9 attackers publish `attackRun`, whose
   * authored release/contact clock also owns authoritative damage timing.
   *
   * Legacy emitters use RAID_RULES.troopFireVisualTicks. Ordinary ranged troops
   * in historical logs carry NO `proj`
   * field on purpose — which sprite a bowman vs mage vs dragon throws is a
   * presentation choice, and the client already knows each troop's type from
   * its `deploy` event.
   *
   * `proj: 'boulder'` (rework v2, owner 2026-08-08) is the one exception: the
   * giant is a MELEE-typed troop whose siegeThrow makes his attack mode
   * target-dependent (throw at defenses, slam at walls), so troop type alone
   * cannot tell the client which animation to play. OPTIONAL and render-only;
   * every other emitter leaves it unset.
   */
  | { t: number; e: 'troopFire'; id: number; target: number | string; ix: number; iy: number; proj?: 'boulder' }
  /** Legacy pre-SIM9 non-hero melee cue; new logs use `attackRun`. The redundant actor/target
   *  discriminants make a persisted event self-describing; pre-SIM7 logs omit
   *  them at runtime and remain accepted by replay clients. `strike` selects
   *  the actor's ordinary attack; Troll/Gloam retain `slam`/`rend`. */
  | { t: number; e: 'troopAttack'; id: number; troop: TroopType;
      side: 'attacker' | 'defender'; targetKind: 'troop' | 'building';
      target: number | string; ix: number; iy: number;
      technique: 'strike' | 'slam' | 'rend'; cadenceTicks: number }
  /** New-roster authored ability cue. `ix`/`iy` are present when the cast aims
   *  away from the actor (lunge/firestorm); simulation effects are authoritative. */
  | { t: number; e: 'troopAbility'; id: number;
      ability: 'howl' | 'leap' | 'lunge' | 'firestorm' | 'maul' | 'disgorge';
      x: number; y: number; ix?: number; iy?: number;
      /** SIM7 visual identity for firestorm; the ground impact remains ix/iy. */
      targetBuildingId?: string }
  /** Hexbarrow attacker-side summon. Separate from Dragon Nest's defender
   *  `spawn` contract because source identity and level/variant are replay data. */
  | { t: number; e: 'troopSpawn'; id: number; from: number; troop: 'barrowling';
      level: number; variant: number; x: number; y: number }
  /** One authoritative Direwyvern burn patch. Damage begins on this tick and
   *  lasts while t < until; clients use the same boundary for its ground FX. */
  | { t: number; e: 'burnfield'; id: number; x: number; y: number; until: number }
  | { t: number; e: 'hit'; target: number | string; dmg: number }
  // Electric-tower chain lightning: `targets`/`dmg` are the secondary hops after the
  // primary hit (Pixel Kingdom Wars Phase 2b). Parallel arrays, one entry per hop.
  | { t: number; e: 'chain'; id: string; targets: number[]; dmg: number[] }
  // Dragon Nest spawns a defender wyrmling (id = new troop id, from = nest building).
  | { t: number; e: 'spawn'; id: number; from: string; troop: TroopType; x: number; y: number }
  | { t: number; e: 'troopDeath'; id: number }
  /** A unit healed itself (DEGEN AWAKENING lifesteal). Render-only — the sim has
   *  already applied it — but it is also the ONLY observable of damageTroop's
   *  damage clamp, which was otherwise untestable (audit 2026-07-29 M09). */
  | { t: number; e: 'heal'; id: number; amount: number }
  | { t: number; e: 'destroyed'; id: string }
  | { t: number; e: 'detonate'; id: number; x: number; y: number }
  | { t: number; e: 'burrow'; id: number }
  /** Burrow exit point. Current logs carry the authoritative coordinate so a
   *  renderer can cancel the same-tick terminal `pos` tween and surface here;
   *  persisted pre-v5 logs may omit x/y at runtime and remain playable. */
  | { t: number; e: 'emerge'; id: number; x: number; y: number }
  | { t: number; e: 'trap'; id: string; victim: number; kind: TrapType;
      victims: number[]; stunUntil?: number }
  | { t: number; e: 'rally'; x: number; y: number }
  | { t: number; e: 'star'; n: 1 | 2 | 3 };

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface BuildingOutcome {
  id: string;
  type: BuildingType;
  /** Remaining HP (whole points; 0 when destroyed). */
  hp: number;
  maxHp: number;
  destroyed: boolean;
}

export interface RaidOutcome {
  stars: 0 | 1 | 2 | 3;
  /** 0–100; HP-weighted over non-wall, non-trap buildings (all traps excluded). */
  destructionPct: number;
  keepDestroyed: boolean;
  vaultDestroyed: boolean;
  mineDestroyed: boolean;
  victory: boolean;
  buildings: BuildingOutcome[];
  /** Ticks simulated, including a bounded post-horn accepted-effect drain. */
  ticks: number;
  events: SimEvent[];
}

/** Thrown on structurally invalid input (server pre-validates; the sim still refuses). */
export class SimInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimInputError';
  }
}

/** A valid-looking input whose deterministic replay representation would cross
 * the declared storage/response boundary. API callers compensate the unopened
 * raid instead of leaving a paid pending row that can never resolve. */
export class SimRepresentationLimitError extends SimInputError {
  constructor(message: string) {
    super(message);
    this.name = 'SimRepresentationLimitError';
  }
}
