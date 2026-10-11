/**
 * SHARDKEEP — canonical game numbers. EVERY tunable lives here and ONLY here
 * (ARCHITECTURE §6: "ALL numbers live ONLY in packages/shared/src/constants.ts").
 *
 * Chain of authority (ARCHITECTURE intro): GDD Addendum v1.6 > GDD v1.5 body
 * > HANDOFF.md > the reference App (SHARDKEEP App.html, extracted in
 * docs/research/read-app-data-model.md — cited below as "App").
 * Each table carries a source comment. Known conflicts are flagged inline
 * rather than silently averaged.
 */
import { TROOP_TYPES, type BuildingGeometryVersion, type DefenseType, type StructureType, type TroopAttackTechnique, type TroopType } from './types';

// ---------------------------------------------------------------------------
// Grid & plot — GDD §3.0 + App GRID (tile 32px, 14×14 claim in an 18×18 plot)
// ---------------------------------------------------------------------------

export const GRID = {
  /** Buildable inner grid at a FRESH base, 14×14 tiles (GDD §3.0). Grows with
   * land expansions up to 50×50 (CAPS.claimTilesByExpansion). */
  claimTiles: 14,
  /** Full plot incl. attacker deployment ring. Grown 18→30 for the Pixel Kingdom
   * Wars big-base expansion (owner 2026-07-20): max claim 26 + a 2-tile deploy
   * ring each side = 30. The claim is CENTERED (footprints.claimRect); existing
   * bases were re-centered by migration 0018 (per-player shift (6 − expansions),
   * i.e. +6 for a fresh base, 0 for a fully-expanded one). */
  plotTiles: 30,
  /** Outer ring width where attackers may drop troops (GDD §3.0). */
  deployRingTiles: 2,
  /** Tile size in pixels at 1× (App L7). */
  tilePx: 32,
} as const;

/** Owner 2026-09-15: playable 50×50 expansion keeps every saved coordinate.
 * GRID.plotTiles remains the frozen legacy frame, including archived replays.
 * This home/placement frame is independent of the absolute raid battlefield.
 * Expansion prices/unlocks are reviewed separately; declaring bounds grants no
 * land and does not enable any new purchase. */
export const PLOT_GEOMETRY = {
  legacyVersion: 1,
  currentVersion: 2,
  boundsByVersion: {
    1: { min: 0, max: GRID.plotTiles },
    2: { min: -10, max: 40 },
  },
} as const;

// ---------------------------------------------------------------------------
// Troops — pts/cost/train: GDD §14; hp/dps/speed: App TSTATS (chain of
// authority: ARCHITECTURE §6 picks Addendum B2 + App stats over the GDD §14
// v0.1 combat table where they differ — tunneler 90hp not 70, turrider 520/40
// not 450/30, plunderer 35/24 not 30/8, speeds per App).
// ---------------------------------------------------------------------------

export type TroopAiTarget = 'nearest' | 'walls' | 'defenses' | 'resources' | 'buildings' | 'mines';

/**
 * What a troop does about a wall standing between it and its target — the owner's
 * signed-off behavior table (2026-07-26, docs/COMBAT-UX-PLAN.md B0). Encoded here
 * rather than as role lists inside the sim so the table has ONE home.
 *
 *  'break'  — a wall-opener: smashes the blocking wall. Tanks + the keg runner.
 *  'burrow' — goes under it (tunneler, bilgewraith; drives `burrowsUnderWalls`).
 *  'over'   — shoots or flies over it when the target is in range; otherwise
 *             uses a gap/opener and attacks the blocker only as a last resort.
 *  'follow' — prefers a wall-free opening; if the base is sealed it moves to the
 *             nearest LIVE 'break' troop and pours through the breach that troop
 *             makes. Chewing the wall itself is a last resort when no opener lives.
 */
export type TroopWallPolicy = 'break' | 'burrow' | 'over' | 'follow';

export interface TroopStats {
  /** Army capacity points (GDD §3.2). */
  pts: number;
  /** Legacy field name; the live API charges this train cost in SHARDS. */
  costKeep: number;
  /** Train time, seconds: owner 2026-09-06, tenfold faster per unit; one sequential base lane. */
  trainSec: number;
  hp: number;
  dps: number;
  speedTilesPerSec: number;
  /** Attack range in tiles, or melee. */
  range: number | 'melee';
  aiTarget: TroopAiTarget;
  /** Wall behaviour — see TroopWallPolicy (owner behavior table 2026-07-26). */
  wallPolicy: TroopWallPolicy;
  /** Keg Runner: one-shot damage to walls, cross-shaped blast (GDD §3.2/§14). */
  wallBurst?: number;
  /** Keg Runner dies on detonation (GDD §14). */
  selfDestructs?: boolean;
  /** Tunneler dives under walls; untargetable mound (GDD §3.2). */
  burrowsUnderWalls?: boolean;
  /** Tunneler vulnerability window after emerging, seconds (GDD §3.2). */
  emergeVulnerableSec?: number;
  /** Plunderer: damage multiplier vs Mine/Vault (GDD §3.2). */
  resourceDamageMult?: number;
  /** Giant: bonus damage multiplier vs buildings incl. walls (Pixel Kingdom Wars §3E). */
  buildingDamageMult?: number;
  /**
   * Giant (owner 2026-08-08, rework v2): a RANGED reach used ONLY against
   * defense-class targets — he lobs boulders at the towers hunting him while
   * staying melee everywhere else (walls, last-resort chew). rangeTiles sits
   * deliberately BELOW bowman 3.5 / archertower 4: the tank closes distance,
   * he does not outrange the ranged corps. Resolved via behaviorOf so hero
   * donors (Theodor) never inherit the throw.
   */
  siegeThrow?: { rangeTiles: number };
  /** Wyrmling: flies — ignores walls, targetable in flight. */
  isFlying?: boolean;
  /** Wyrmling: Nest-spawned defender, never trained (excluded from the barracks roster). */
  defenderOnly?: boolean;
  /** Barrowling: attacker-side summon, never trained, researched or directly deployed. */
  spawnOnly?: boolean;
  /** Late-roster barracks gate; checked server-side before any training debit. */
  requiresKeepLevel?: number;
  /** Mage: AoE splash radius in tiles vs buildings. */
  splashRadiusTiles?: number;
}

/** Authored simulation-only mechanics are a separate top-level export so web
 * first paint can retain lightweight TROOPS stats without retaining every
 * ability payload. All numbers remain in this authoritative constants module. */
export interface TroopMechanics {
  /** Burst cadence for new units; deciseconds keep the 100ms sim exact. */
  attackIntervalDeciSec?: number;
  /** Gloamfang: pursue live defender actors before resuming the building raid. */
  enemyTroopPriority?: boolean;
  /** Gloamfang's visible, non-stacking allied troop buff. */
  howl?: {
    firstDelaySec: number;
    cooldownSec: number;
    effectDelayDeciSec: number;
    castDeciSec: number;
    radiusTiles: number;
    durationSec: number;
    damagePct: number;
    speedPct: number;
  };
  /** Gloamfang's defender gap-close. Damage is % of one second of DPS. */
  lunge?: {
    rangeTiles: number;
    cooldownSec: number;
    damagePctDps: number;
    travelDeciSec: number;
  };
  /** Gloamfang crosses, but never damages, a contiguous wall strip. */
  leap?: { rangeTiles: number; travelDeciSec: number };
  /** Direwyvern: firestorm lays three damage zones; its sweep has no impact hit. */
  firestorm?: {
    cooldownSec: number;
    effectDelayDeciSec: number;
    fieldOffsetTiles: number;
    fieldRadiusTiles: number;
    fieldLifetimeSec: number;
    fieldDpsPct: number;
  };
  /** Direwyvern's close anti-defender wing slam. */
  maul?: {
    cooldownSec: number;
    impactDelayDeciSec: number;
    radiusTiles: number;
    damagePctDps: number;
  };
  /** Hexbarrow's deterministic ten-actor hatch cycle. */
  brood?: {
    firstDelaySec: number;
    intervalSec: number;
    castDeciSec: number;
    spawnOffsetsDeciSec: readonly number[];
    spawnCounts: readonly number[];
    lifespanSec: number;
    variants: number;
    spawnRadiusTiles: number;
    positionKeyframeTicks: number;
  };
}

export const TROOPS = {
  highlander: { pts: 2, costKeep: 12, trainSec: 12, hp: 120, dps: 18, speedTilesPerSec: 1.2, range: 'melee', aiTarget: 'nearest', wallPolicy: 'follow' },
  bowman:     { pts: 1, costKeep: 10, trainSec: 9,  hp: 45,  dps: 14, speedTilesPerSec: 1.4, range: 3.5,    aiTarget: 'nearest', wallPolicy: 'over' },
  // 900 to walls (cross blast) + 45 splash, self-destructs (GDD §14 + App).
  kegrunner:  { pts: 1, costKeep: 10, trainSec: 7.5,  hp: 25,  dps: 45, speedTilesPerSec: 2.4, range: 'melee', aiTarget: 'walls', wallPolicy: 'break', wallBurst: 900, selfDestructs: true },
  tunneler:   { pts: 2, costKeep: 18, trainSec: 18, hp: 90,  dps: 22, speedTilesPerSec: 1.1, range: 'melee', aiTarget: 'nearest', wallPolicy: 'burrow', burrowsUnderWalls: true, emergeVulnerableSec: 1 },
  turrider:   { pts: 5, costKeep: 35, trainSec: 30, hp: 520, dps: 40, speedTilesPerSec: 0.9, range: 'melee', aiTarget: 'defenses', wallPolicy: 'break' },
  plunderer:  { pts: 1, costKeep: 8,  trainSec: 6,  hp: 35,  dps: 24, speedTilesPerSec: 1.8, range: 'melee', aiTarget: 'resources', wallPolicy: 'follow', resourceDamageMult: 2 },
  // --- Pixel Kingdom Wars new roster (DARK; strategic roles, master plan §3E) ---
  // TANK (rework v2, owner 2026-08-08 — supersedes the 2026-07-29 numbers: "he
  // dies like a fly"): hp 700→1600 so he actually soaks; dps 55 in BOTH modes.
  // He hunts DEFENCES: within siegeThrow range he lobs boulders at them (even
  // over walls — same no-LoS convention as 'over'), and a wall standing in his
  // path is now melee'd at dps×buildingDamageMult (was 1× last-resort only).
  // Still 'follow': he prefers an existing gap and never SEEKS walls — opening
  // walls on purpose stays troll/turrider/kegrunner work.
  giant:      { pts: 7, costKeep: 50, trainSec: 30, hp: 1600, dps: 55, speedTilesPerSec: 0.85, range: 'melee', aiTarget: 'defenses', wallPolicy: 'follow', buildingDamageMult: 2, siegeThrow: { rangeTiles: 2.5 } },
  troll:      { pts: 6, costKeep: 40, trainSec: 27, hp: 900, dps: 30, speedTilesPerSec: 1.0,  range: 'melee', aiTarget: 'nearest', wallPolicy: 'break' },
  dragon:     { pts: 8, costKeep: 60, trainSec: 36, hp: 800, dps: 70, speedTilesPerSec: 1.0,  range: 4,       aiTarget: 'defenses', wallPolicy: 'over', isFlying: true },
  mage:       { pts: 3, costKeep: 22, trainSec: 15, hp: 90,  dps: 30, speedTilesPerSec: 1.3,  range: 4,       aiTarget: 'nearest', wallPolicy: 'over' },
  bilgewraith:{ pts: 2, costKeep: 16, trainSec: 15, hp: 70,  dps: 24, speedTilesPerSec: 1.3,  range: 'melee', aiTarget: 'mines', wallPolicy: 'burrow', burrowsUnderWalls: true, emergeVulnerableSec: 1 },
  // Dark attacker family — owner 2026-08-11: "Make their stats on your own by
  // analyzing rest of the troops. New troops should be stronger and wyvern
  // should be much stronger than dragon ... 20-30 [army points]." The fielded
  // units trade proportionally larger camp footprints for elite stats. The
  // Barrowling is deliberately weak alone because ten make one Hexbarrow brood.
  //
  // ITEM-GATED (owner 2026-08-16: "some troops are also items, dragon, wyvern,
  // gloamfang, hexabraw(cannon), mage … dragon only can be dropped from gold
  // forge, same for wyvern and rest of other way unlocked troops"): the former
  // requiresKeepLevel gates on gloamfang/direwyvern/hexbarrow are REPLACED by
  // ELITE_TROOP_UNLOCKS item gates (train/research require a consumed unlock
  // item; existing eligible players are grandfathered — see
  // ELITE_TROOP_UNLOCKS.grandfather.legacyKeepGates for the retired numbers).
  gloamfang: {
    pts: 10, costKeep: 80, trainSec: 48,
    hp: 1500, dps: 100, speedTilesPerSec: 1.5, range: 'melee',
    aiTarget: 'nearest', wallPolicy: 'follow',
  },
  direwyvern: {
    pts: 25, costKeep: 190, trainSec: 90,
    hp: 3200, dps: 220, speedTilesPerSec: 0.65, range: 4.5,
    aiTarget: 'defenses', wallPolicy: 'over', isFlying: true,
  },
  hexbarrow: {
    pts: 18, costKeep: 140, trainSec: 72,
    hp: 2200, dps: 90, speedTilesPerSec: 0.55, range: 5,
    aiTarget: 'buildings', wallPolicy: 'break', buildingDamageMult: 3,
  },
  barrowling: {
    pts: 0, costKeep: 0, trainSec: 0, hp: 40, dps: 8,
    speedTilesPerSec: 2.0, range: 'melee', aiTarget: 'defenses',
    wallPolicy: 'follow', spawnOnly: true,
  },
  // Wyrmling: Dragon-Nest spawn, defender-only (never trained; pts/cost 0).
  wyrmling:   { pts: 0, costKeep: 0,  trainSec: 0,   hp: 60,  dps: 20, speedTilesPerSec: 1.6,  range: 2,       aiTarget: 'nearest', wallPolicy: 'over', isFlying: true, defenderOnly: true },
} as const satisfies Record<TroopType, TroopStats>;

export const TROOP_ABILITIES = {
  gloamfang: {
    attackIntervalDeciSec: 10,
    enemyTroopPriority: true,
    howl: {
      firstDelaySec: 2, cooldownSec: 15, effectDelayDeciSec: 2,
      castDeciSec: 7, radiusTiles: 4, durationSec: 5,
      damagePct: 20, speedPct: 20,
    },
    lunge: { rangeTiles: 3, cooldownSec: 5, damagePctDps: 150, travelDeciSec: 5 },
    leap: { rangeTiles: 3, travelDeciSec: 6 },
  },
  direwyvern: {
    firestorm: {
      cooldownSec: 5, effectDelayDeciSec: 6,
      fieldOffsetTiles: 1.5, fieldRadiusTiles: 1.5,
      fieldLifetimeSec: 5, fieldDpsPct: 100,
    },
    maul: { cooldownSec: 8, impactDelayDeciSec: 2, radiusTiles: 2, damagePctDps: 200 },
  },
  hexbarrow: {
    attackIntervalDeciSec: 25,
    brood: {
      firstDelaySec: 15, intervalSec: 15, castDeciSec: 8,
      spawnOffsetsDeciSec: [2, 3, 4, 5], spawnCounts: [3, 3, 2, 2],
      lifespanSec: 12, variants: 4, spawnRadiusTiles: 0.5, positionKeyframeTicks: 10,
    },
  },
  barrowling: { attackIntervalDeciSec: 10 },
} as const satisfies Partial<Record<TroopType, TroopMechanics>>;

/** One shared barracks/deploy predicate. Spawn products are real TroopTypes for
 * replay typing, but no zero-cost actor may enter the player-owned army. */
export function isTrainableTroop(type: TroopType): boolean {
  const stats: TroopStats = TROOPS[type];
  return !stats.defenderOnly && !stats.spawnOnly;
}

/**
 * ═══════════════ THE SIZE CONTRACT — one rule for every drawn thing ═════════
 *
 * Owner 2026-08-30, verbatim: "building and troops sizes are not well balanced
 * in raids either, rework it properly … stabilize buildings and defences size
 * and troops size and their correspondence with each other, because now it's
 * total mess in sizing" — and, naming the worst offenders, "look at the cannon
 * how big and ugly it is, and mortar too", "this defences and building need to
 * fit into its tiles".
 *
 * THE MESS WAS THAT THERE WAS NO RULE. Each family was fitted in its own pass,
 * against whatever its own pass cared about, so the base ended up holding both
 * buildings that burst their plot (the Cannon drew 82.5 world px on a 64 px
 * tile) and buildings that floated inside a half-empty one (the 2×2 Mortar drew
 * 83.8×65 in a 128×128 plot — SMALLER than the 1×1 Cannon beside it). This
 * block replaces every one of those per-family judgements with a single law.
 *
 * ─────────────────────────── THE LAW ────────────────────────────────────────
 * A 3/4 projection gives a drawn body exactly two extents, and each has exactly
 * one owner:
 *
 *   GROUND — width is the axis a PLOT owns. A body wider than its plot is
 *     standing on ground that belongs to the building next door. So:
 *        inkWidth ≤ footprintWidth × tile × maxPlotOverhang
 *
 *   SKY — height is elevation, and no plot owns elevation. The one structure
 *     that owns it is the Keep (owner: "The Keep is the biggest thing on a
 *     base; nothing reaches it"). So, for every family except the Keep, at
 *     every level:
 *        inkHeight  <  keepInkHeight(sameLevel)          — nothing REACHES it
 *        inkArea    <  keepInkArea(sameLevel)            — nothing OUT-MASSES it
 *
 * That is the whole contract. It is two clauses because the projection has two
 * axes, not because there are two rules — and it needs exactly ONE tunable
 * number, below.
 *
 * WHY 1.15 AND NOT A TASTE CALL: it is the Keep's own overhang. Measured in the
 * running scene, the L20 Keep draws 146.3 world px on its 128 px plot = 1.143.
 * Setting the allowance at 1.15 therefore says: NO STRUCTURE TAKES MORE OF ITS
 * PLOT THAN THE KEEP TAKES OF ITS OWN. The Keep is not an exception to the
 * ground clause, it IS the ground clause — and 1.15 sits well under the owner's
 * stated defect line ("an overhang over ~1.25x is a defect, not character").
 *
 * A FAMILY IS ONLY COMPARED AGAINST A KEEP IT CAN STAND BESIDE. The sky clause
 * runs from each family's `BUILD_COSTS.requiresKeepLevel` upward, not from
 * level 1: a Clan Hall is gated to Keep 5 and never shares a base with a
 * level-1 Keep, so holding it under one is not a rule, it is an accident of
 * where a loop starts. This matters concretely — the starter Keep is a modest
 * 53×80 authored px tower against the level-6 Keep's 113×87 — and getting it
 * wrong would have shrunk three families to ~60% of their plots to satisfy a
 * comparison that never happens on a real base.
 *
 * WHAT IT COSTS, derived by solving the law against ink measured off live
 * sprites at Keep L1/L6/L11/L16/L20 in BOTH scenes and pinned in
 * `buildingFit.test.ts`:
 *   clanhall    0.85  → 0.61   keep skyline. It drew TALLER than the Keep at
 *                              every level it can exist at — the biggest
 *                              building on the base, and nothing checked it,
 *                              because the shipped fit test covered only
 *                              DEFENCE families and named this one as
 *                              deliberately out of scope.
 *   lasertower  1.0   → 0.88   keep skyline @L16 (the last family still on the
 *                              unfitted 1)
 *   vault       0.675 → 0.59   ground: 62 ink px on a one-tile plot was 1.31 of
 *                              it. Never measured before this pass.
 *   forge       0.65  → 0.57   ground: 1.30 of its plot, same story.
 *   cannon      0.55  → 0.39   worst in the game at 1.29 of its plot; now
 *                              0.91, inside its own tile rather than merely
 *                              inside the law, and small enough that the 2×2
 *                              Mortar out-masses it without growing.
 *   mortar      0.625 UNCHANGED — an intermediate 0.89 was shipped for one
 *                              turn and withdrawn; see ART_V2.buildingSourceScale.
 *
 * TWO PROPOSED SHRINKS WERE WITHDRAWN, and why matters more than the numbers:
 *   magetower   0.825 HELD — measures 0.799 of its plot. Already legal.
 *   barracks    0.775 HELD — measures 1.114 of its plot. Already legal.
 * Both were derived from ink measured off an atlas built WITHOUT the game-v4
 * overlay, i.e. off the superseded art. Re-measured against
 * `SHARDKEEP_GAME_V4_OVERLAY=1` output, neither breaches the law, so neither
 * moves: this contract shrinks a body that breaks the rule, never one that
 * merely could be smaller.
 *
 * ⚠ MEASURE AGAINST AN OVERLAY BUILD OR DO NOT MEASURE. A plain rasterize
 * packs the PRE-overlay art and reports success, so every ink figure it yields
 * is of art the game does not ship. That single mistake produced a phantom
 * "the pack shrank 44%" and, from it, four wrong fits and a false claim that
 * `troopSourceScale` had gone stale. The four numbers above that DID survive
 * were re-derived from an overlay build on 2026-08-30 and each is stated with
 * the plot ratio it produces, so the next reader can check them in one command
 * instead of trusting this comment.
 *
 * ⚠ RAIDS ARE THE SAME WORLD. A building carries NO battle multiplier, so this
 * contract holds identically in a raid; the actor half of the correspondence is
 * ACTOR_WORLD_SCALE below, which is where the raid used to break it.
 *
 * ⚠ THESE BOUND ART, NOT GAMEPLAY. Never widen a live footprint to make a body
 * fit — refit the body (owner 2026-08-15).
 */
export const BUILDING_FIT = {
  /** Ground clause: `inkWidth ≤ fw × tile × this`. The Keep's own 1.143. */
  maxPlotOverhang: 1.15,
} as const;

/** Five-tier wall presentation, owner 2026-09-09. These are cosmetic source
 * dimensions and HP appearance thresholds, not wall balance or collision changes.
 * The other structure/troop families keep ART_V2's four-tier progression. */
export const WALL_ART = {
  tiers: 5,
  levelsPerTier: 4,
  sourceTileSize: 32,
  drawScale: 2,
  preparationBudgetMs: 4,
  sourceFrameHeights: [44, 48, 52, 56, 60],
  sourceBodyOffset: 36,
  contextFrameHeight: 60,
  lightDamageBelow: 0.5,
  heavyDamageBelow: 0.25,
  collapseFrames: 4,
  collapseFps: 12,
} as const;

/**
 * Rework-v2 art tiers (owners 2026-08-08 + 2026-08-10). The second delivery
 * extends the same grid/anchor contract to the rest of the authored troop
 * roster; it does NOT replace the already-wired giant/dragon/cannon/mortar
 * masters, which keep source precedence in the asset pipeline. Four additional
 * art roots are present ahead of their owner-authorised balance table, so this
 * is deliberately an ART roster rather than a TroopType roster.
 *
 * The pack ships 4 visual tiers per unit, not 20 levels: art tier =
 * ceil(level/5). Shared here because every renderer and portrait resolver must
 * make the same tier decision.
 */
export const ART_V2 = {
  tiers: 4,
  levelsPerTier: 5,
  /** Troop roots authored in the combined delivery. Wyrmling is absent. */
  troops: [
    'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
    'giant', 'troll', 'dragon', 'mage', 'bilgewraith',
    'gloamfang', 'direwyvern', 'hexbarrow', 'barrowling',
  ],
  /** Fixed-building roots; both remain sourced from the protected old pack. */
  buildings: ['cannon', 'mortar'],
  /** Every root whose art is routed through the v2 atlas namespace. */
  units: [
    'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
    'giant', 'troll', 'dragon', 'mage', 'bilgewraith',
    'gloamfang', 'direwyvern', 'hexbarrow', 'barrowling',
    'cannon', 'mortar',
  ],
  /**
   * v2 BUILDINGS whose published anchor is the CENTRE of the art's own ground
   * quad rather than a ground-line point — "anchor (56,104) = centre of the
   * footprint" (`Giant dragon cannon  mortar rework v2/_src/_cannon2.js`
   * header, `_src/_mortar2.js` header, HANDOFF-V2 anchor table). Troop anchors
   * in the same pack ARE ground-line points, so this is per-unit, not per-pack.
   *
   * ⚠ THIS IS AN ART FACT ABOUT THE SPRITE ORIGIN, NOT A SEATING RULE. It used
   * to decide where the tower SAT (anchor on the footprint's middle row), and
   * that is what floated both towers above their plots — the art's ground quad
   * is drawn in 3/4 view at ~half the depth of the flat top-down footprint
   * rect, so the two centres cannot coincide (owner 2026-08-30: "this defences
   * and building need to fit into its tiles"). Seating is now one rule for
   * every family — drawn bottom edge on the footprint's south edge,
   * `apps/web/src/game/v2/clips.ts#buildingSeatY`. The anchor remains the
   * sprite ORIGIN, because `emitterWorld` measures every muzzle from it.
   */
  buildingAnchorAtFootprintCentre: ['cannon', 'mortar'],
  /**
   * World-art fit for the two v2 towers — the same contract, same units and
   * same meaning as WARE_WORLD_PRESENTATION's `sourceScale`: a uniform
   * multiplier in the authored 32-px-per-tile game space, which the @2x web
   * world multiplies by two and the @1x deed renderer applies directly.
   *
   * IT EXISTS BECAUSE ITS ABSENCE WAS THE BUG (owner 2026-08-30: "mortar is
   * bigger than keep why ???"). Every WARE family publishes a fit; the v2 pack
   * published none, so `v2BldSeat` had no choice but to hardcode the raw pack
   * conversion and both towers drew at full authored size while every building
   * around them had been fitted down. Measured in the running scene, that put
   * the L1 Cannon at 122×160 world px against a 101×108 Keep.
   *
   * The rule these two numbers satisfy is BUILDING_FIT above — the same law
   * every WARE family obeys, pinned for all of them by `buildingFit.test.ts`.
   *
   * BOTH GUNS COME DOWN: cannon 0.55 → 0.42, mortar back to its original 0.625.
   *
   * An earlier version of this comment argued the Mortar should go UP to 0.89,
   * because the 1×1 Cannon drew more mass than the 2×2 Mortar and a footprint
   * ought to buy visible bulk. The ordering argument was right; the remedy was
   * not. THE OWNER HAS NOW SAID THREE TIMES THAT BOTH GUNS READ TOO BIG
   * ("look at the cannon how big and ugly it is, and mortar too", then "mortar
   * still big and cannons still big ugly and unprofessional"). Fixing the
   * ordering by ENLARGING one of them moved the pair in the direction they had
   * explicitly rejected. The ordering is now to be fixed in the ART — the guns
   * are getting a quality pass — and not by inflating a body on a screen the
   * owner already finds crowded.
   *
   * The owner named both in one breath ("look at the cannon how big and ugly it
   * is, and mortar too") and they were the two ends of one defect: the 1×1
   * Cannon drew 82.5×110 world px — 1.289 of its plot's width, the largest
   * overhang in the game — while the 2×2 Mortar drew 83.8×77.5 inside a 128×128
   * plot. THE SMALL GUN WAS THE BIG ONE. The first pass that fitted these two
   * had only a Keep-dominance rule to satisfy, and a body far too small
   * satisfies that rule exactly as well as a body that is right, so nothing
   * ever pushed back on the Mortar.
   *
   * A LATER RE-MEASUREMENT SAID THE CANNON HAD SHRUNK AND 0.55 WAS NOW SAFE,
   * AND ON THAT BASIS THE SHRINK WAS ABANDONED. It should not have been.
   * IT WAS MEASURED AGAINST AN ATLAS BUILT WITHOUT THE game-v4 OVERLAY, and
   * that reading (49.5×71.5, 0.77 of plot) is of the PRE-OVERLAY art, not the
   * art the game ships. Re-measured against `SHARDKEEP_GAME_V4_OVERLAY=1`
   * output, the tier-4 Cannon's idle-south body is 75 ink px = 150 world px at
   * 0.55, i.e. **1.289 of its plot** — still the largest overhang in the game,
   * exactly the figure the first derivation found. So 0.49 was right all along
   * and is restored:
   *
   *   cannon 0.39 = the gun INSIDE its own tile, and small enough that the
   *     2×2 Mortar out-masses it by the 1.4× this file demands WITHOUT the
   *     Mortar having to grow. BUILDING_FIT permits 0.49 (tier 4 at 1.148, on
   *     the Keep's own overhang) and 0.49 shipped for exactly one turn before
   *     the owner said it still read big. Solving the ordering rule across
   *     every tier caps the Cannon at 0.393 — tier 16/20 binds — so 0.39 lands
   *     tier 4 at 0.91 of its plot and tier 1 at 0.74. The law is a ceiling;
   *     a defence the owner has named three times is held well below it.
   *
   *   mortar 0.625 = restored. It draws 0.65 of its two-tile plot, which is
   *     modest for a 2×2 — that is the known cost of the decision above and is
   *     accepted rather than hidden.
   *
   * The lesson is worth more than either number: a fit derived from an atlas
   * is only as good as the atlas, and a rasterize WITHOUT the overlay silently
   * measures the superseded art while reporting success. Anything that
   * re-derives a fit must state which build it measured.
   *
   *   For the record, the law would ALLOW the mortar up to 0.895 (the binding
   *     clause is the sky one: at its gate of Keep 3 it may not out-mass the
   *     Keep beside it). It is held far under that on the owner's judgement,
   *     not on a measurement.
   *
   * The result is the ordering a footprint is supposed to buy — pay for four
   * tiles, get a gun that reads like four tiles.
   * ⚠ Re-derive both if either pack's masters are re-authored. They just were.
   */
  buildingSourceScale: { cannon: 0.39, mortar: 0.625 },
  /**
   * World-art fit for every v2 TROOP root — the same contract, the same units
   * and the same meaning as `buildingSourceScale` above and
   * `WARE_WORLD_PRESENTATION.sourceScale`: a uniform multiplier in the authored
   * 32-px-per-tile game space, which the @2x web world doubles.
   *
   * IT EXISTS BECAUSE ITS ABSENCE WAS THE BUG, exactly as it was for the two v2
   * towers (owner 2026-08-30, playing their own base: "troops are very big").
   * Every WARE family publishes a fit; the v2 troop pack published none, so
   * `v2TroopDrawScale` had no choice but to return the raw @1x→@2x pack
   * conversion and every reworked unit drew at full authored size while the
   * buildings around it had all been fitted down. Measured off the shipped
   * atlas: a giant's body rendered 138 world px against a 108-px Keep at L1 and
   * a 154-px Keep at L20 — the biggest thing on the base was a troop.
   *
   * WHY PER UNIT and not one pack-wide number. A pack-wide multiplier keeps the
   * proportions the ARTIST drew, and those are not the game's: measured, the
   * pack authors the giant only 1.36x the rank-and-file's body, where every
   * shipped predecessor put him at 2.2–2.4x. One number therefore buys "no
   * troop out-sizes the Keep" at the price of "the giant stops reading as a
   * giant". This is the same reason WARE_WORLD_PRESENTATION is per family.
   *
   * THE DERIVATION — one rule, applied to every root: A REWORKED UNIT RENDERS AT
   * THE WORLD HEIGHT OF THE ART IT REPLACES. Those predecessor heights are the
   * owner-tuned, shipped, owner-verified ladder (see `AMBIENCE.garrisonScale`
   * and `heroPatrolScale`), measured off the legacy `trp_*`/`trpdg_l<N>` masters
   * at that same garrison scale: rank-and-file 34, mage 34, tunneler/plunderer
   * 29–30, turrider 63, troll 67, giant 82 (L1) … 100 (L20), dragon 70 … 88.
   * Each value below is therefore `targetWorldHeight / (ink × 2 ×
   * AMBIENCE.garrisonScale)`, rounded to 0.005.
   *
   * The four roots with NO predecessor art — Gloamfang, Direwyvern, Hexbarrow,
   * Barrowling — cannot use that rule, so they take the ceiling instead: seated
   * on the ladder by role (elite beast above the troll, the wyvern above the
   * dragon, the brood minion under the rank-and-file) and held under the Keep.
   *
   * THE CEILING, pinned by `apps/web/src/game/v2/actorFit.test.ts`: no troop
   * family's body out-sizes the Keep ON THE BASE — the scene the owner states
   * the rule in and the one they play — and nothing out-sizes a fully upgraded
   * Keep even at the raid's enlargement. Units whose ink WIDTH is an
   * outstretched SPAN rather than upright bulk are exempt on width only: a
   * wingspan is not a footprint, and neither is a quadruped's nose-to-tail
   * length. Height is never exempt, because height is what stacks against the
   * skyline.
   *
   * THE APEX RUNGS (owner 2026-08-30, second pass: "gloamfang ×1.5", "dragon
   * up", "direwyvern must end larger than dragon"). The first pass' ceiling —
   * battle height under the Keep at the tier's own band start — was a single
   * flat number (88.7 base-view px for EVERY family, since the Keep it compares
   * against does not move with the unit), and the giant already sat at 82 of it.
   * Three more rungs cannot be expressed in 6 px, so the ceiling moved to the
   * scene the owner stated it in and the ladder now reads, in base-view world
   * px: giant 82 · dragon 88 · gloamfang 93 · direwyvern 100, against a 108-px
   * Keep at L1 and 154 at L20. Gloamfang lands BETWEEN the two dragons: taller
   * than the Dragon by its raised spines while the Dragon still covers more of
   * the screen (130 px of wingspan against 113 px of beast), and clearly under
   * the Direwyvern, which stays the largest thing a player can field.
   * ⚠ These are derived from ART MEASUREMENTS. Re-derive every value if the
   * troop pack is re-authored.
   *
   * ═══════ RETRACTED 2026-08-30: THIS TABLE WAS NEVER STALE ════════════════
   *
   * A size pass reported that `art/game-v4` had re-delivered the troop pack and
   * that every body had shrunk ~45%, leaving a Highlander drawing 22.5 world px
   * against a 34 px ladder. It listed all 15 roots and recommended not trusting
   * any of them. THE MEASUREMENT WAS OF AN ATLAS BUILT WITHOUT THE OVERLAY:
   * `art/game-v4` reaches the game only through
   * `SHARDKEEP_GAME_V4_OVERLAY=1 pnpm assets`, and a plain rasterize packs the
   * SUPERSEDED art while exiting 0. The masters themselves never changed —
   * `actors/highlander/t1/idle.png` is byte-identical across both checkouts.
   *
   * Re-measured against an overlay build (stand pose, south row, frame 1, tier
   * 1; draws = ink.h × V2_DRAW_SCALE × ACTOR_WORLD_SCALE.troop × fit):
   *
   *     root           stand ink   draws   ladder   ratio
   *     highlander        60×75     41.1      34     1.21
   *     bowman            50×73     35.7      34     1.05
   *     kegrunner         75×70     30.0      34     0.88
   *     tunneler          63×85     35.3      29     1.22
   *     turrider          30×85     56.7      63     0.90
   *     plunderer         49×66     32.7      30     1.09
   *     giant             75×97     75.5      82     0.92
   *     troll             61×60     50.3      67     0.75
   *     dragon           100×62     67.5      88     0.77
   *     mage              49×75     35.6      34     1.05
   *     bilgewraith       65×74     29.8      30     0.99
   *     gloamfang         49×91     72.1      93     0.77
   *     direwyvern      278×192     92.5     100     0.93
   *     hexbarrow         97×91     66.1      70     0.94
   *     barrowling        47×45     24.7      28     0.88
   *
   * Every root lands within 0.75–1.22 of its published target — tuning drift,
   * not a broken contract, and no root needs a fit above 1. (The retracted
   * table gave the Direwyvern as 215×96 "now" versus 278×192 "before"; the
   * overlay build measures 278×192, which is the tell: it was reading the old
   * art and calling it the new.)
   *
   * The four roots at 0.75–0.77 (troll, dragon, gloamfang) draw smaller than
   * their ladder says and are the honest candidates for a future retune. That
   * is a deliberate non-action here: the owner's live complaint is that units
   * read too BIG, and enlarging three of them mid-pass would fight the seating
   * and camera corrections landing alongside this.
   *
   * TO RE-DERIVE, when the pack settles: `fit = targetWorldHeight / (standInk.h
   * × V2_DRAW_SCALE × ACTOR_WORLD_SCALE.troop)`, with the target ladder above.
   * Measure the stand pose, south row, frame 1, at tier 1 — one basis for every
   * root, which is what makes the ladder comparable at all.
   * ═════════════════════════════════════════════════════════════════════════
   */
  troopSourceScale: {
    highlander: 0.415, bowman: 0.37, kegrunner: 0.325, tunneler: 0.315,
    turrider: 0.505, plunderer: 0.375, giant: 0.59, troll: 0.845,
    dragon: 0.825, mage: 0.36, bilgewraith: 0.305,
    gloamfang: 0.6, direwyvern: 0.365, hexbarrow: 0.55, barrowling: 0.415,
  },
} as const;

/** level (1-based, any range) → v2 art tier 1..ART_V2.tiers. */
export function artTierOfLevel(level: number): number {
  const l = Math.max(1, Math.floor(level));
  return Math.min(ART_V2.tiers, Math.ceil(l / ART_V2.levelsPerTier));
}

/** Troop leveling — GDD Addendum B1 (Forge) + App tStat. Extended to L20 for the
 *  Pixel Kingdom Wars expansion (owner 2026-07-20). */
export const TROOP_LEVELING = {
  /** Legacy scalar — the SIM now scales via the tapered LEVEL_STEP_TROOP array;
   * kept only for the client's approximate stat preview (aligned in the asset
   * phase). ×1.2/level matched STEP_TROOP for L≤3, so early levels are identical. */
  statMultPerLevel: 1.2,
  maxLevel: 20,
  /** Legacy field name; live research charges SHARDS. L1→2 … L19→20 = level × 400. */
  researchCostKeep: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400, 4800, 5200, 5600, 6000, 6400, 6800, 7200, 7600],
  /** Research times, monotonic to L20 (geometric 2h → 5d); Forge, no builder (Addendum B1). */
  researchTimeSec: [7_200, 9_040, 11_300, 14_200, 17_900, 22_500, 28_200, 35_400, 44_400, 55_800, 70_000, 87_900, 110_000, 139_000, 174_000, 218_000, 274_000, 344_000, 432_000],
  /** Gate: troop level ≤ Forge level; one research at a time (Addendum B1). */
  gatedByForgeLevel: true,
  concurrentResearch: 1,
} as const;

// ---------------------------------------------------------------------------
// Defenses — GDD Addendum B2 (hp/dps), GDD §14 (fire rates, ranges, splash)
// ---------------------------------------------------------------------------

export const DEFENSES = {
  // targetsAir: can this defense hit FLYING attackers (the Dragon troop)? Only the
  // archer/mage/electric(tesla) towers can; ground/arc/beam defenses cannot (owner
  // 2026-07-20 — the dedicated air-defense building landed in M22). Anti-AIR reach
  // is measured to the defense's footprint edge in the sim (D-060/SIM11) — the
  // same anchor a flyer uses against the defense — so an equal-range duel is a
  // duel, not a permanent hover outside retaliation (K-030).
  // D-060 (owner 2026-08-16 verbatim): "increase cannon range 2 times for attack"
  // — 3 → 6. Ground-only stays ground-only: the doubling buys reach, not an air gun.
  cannon:      { hp: 420, dps: 55, rangeTiles: 6, fireIntervalSec: 1.2, targetsAir: false, footprint: [1, 1] },
  // D-060 (owner 2026-08-16 verbatim): "increase archer range too". 7 chosen
  // (owner-tunable) so the lattice tower out-reaches a Dragon's ~4.7-tile hover
  // (range 4 to the tower's edge ≈ 4.4–4.9 tiles from its centre, K-030) with
  // enough spare to cover neighbouring towers the dragon is dismantling.
  archertower: { hp: 360, dps: 34, rangeTiles: 7, fireIntervalSec: 0.5, targetsAir: true,  footprint: [1, 1] },
  // Dead zone: cannot hit targets closer than rangeMinTiles (GDD §3.1/§14).
  mortar:      { hp: 300, dps: 80, rangeMinTiles: 2, rangeMaxTiles: 7, splashRadiusTiles: 1.5, fireIntervalSec: 4, targetsAir: false, footprint: [2, 2] },
  /** Dedicated air-only harpoon (owner 2026-08-15 / M22; a harpoon is visual
   * damage and applies no status). D-060 (owner 2026-08-16: dragons are "air
   * defence's preferred target if it can see it in range" — the counter must
   * actually counter): dps 45 → 110. The M22 "conservative, between Archer and
   * Cannon" figure meant a capped PAIR of batteries tickled a leveled dragon
   * stack for under one dragon per fight; at 110 (AGENT-CHOSEN, owner-tunable,
   * sim-proven in the campaign difficulty tests) the keep-12+ battery pair
   * denies a recommended-budget all-dragon army its 3★ exams while the
   * max-points fairness floor still holds on all 100 stages. */
  airdefence:  { hp: 450, dps: 110, rangeTiles: 6, fireIntervalSec: 1.5, targetsAir: true, targetsGround: false, footprint: [2, 2] },
  /** Four deterministic trap tiers, T1=L1–5 … T4=L16–20 (owner 2026-08-15/M22).
   * Values stay below equivalent tower volleys because traps are unavoidable burst. */
  spiketrap:   { burstDamageByTier: [250, 325, 425, 550], oneUse: true, footprint: [1, 1] },
  powdermine:  { burstDamageByTier: [110, 150, 210, 280], splashRadiusTilesByTier: [1, 1, 1.25, 1.5], oneUse: true, footprint: [1, 1] },
  pitfall:     { burstDamageByTier: [70, 100, 140, 190], stunTicksByTier: [8, 10, 12, 15], oneUse: true, footprint: [1, 1] },
  airmine:     { burstDamageByTier: [130, 180, 250, 340], splashRadiusTilesByTier: [1, 1.25, 1.5, 1.75], oneUse: true, footprint: [1, 1] },
  // --- Pixel Kingdom Wars epic defenses (DARK; master plan §3D). electric/mage
  // target air; laser does not. The Dragon Nest SPAWNS defender wyrmlings (a
  // separate spawn loop), so it has no direct-fire projectile. ---
  electrictower: { hp: 380, dps: 40, rangeTiles: 4, fireIntervalSec: 1.2, chainMax: 2, chainFalloffPct: [50, 25], targetsAir: true,  footprint: [1, 1] },
  magetower:     { hp: 340, dps: 24, rangeTiles: 4, fireIntervalSec: 2.0, splashRadiusTiles: 3, targetsAir: true,  footprint: [1, 1] },
  lasertower:    { hp: 320, dps: 30, rangeTiles: 7, fireIntervalSec: 1.5, beam: true, targetsAir: false, footprint: [1, 1] },
  dragonnest:    { hp: 700, rangeTiles: 4, spawnIntervalSec: 6, maxSpawns: 2, spawnLifespanSec: 8, footprint: [2, 2] },
} as const;

/** Keep weapon unlocks (owner 2026-08-15/M22). The long-range ground battery
 * comes online first; the close-range ground battery later covers its dead zone. */
export const KEEP_BATTERIES = {
  highRangeUnlockLevel: 15,
  lowRangeUnlockLevel: 17,
  /** The low battery borrows the Cannon's profile but keeps the PRE-D-060 3-tile
   * reach: its published job is covering the high battery's 2-tile mortar dead
   * zone, and the owner's 2026-08-16 "increase cannon range 2 times" bought the
   * CANNON building reach — silently doubling the L17 Keep's point-defense bubble
   * too would rewrite the M22 battery matchup nobody asked to change. */
  lowRangeTiles: 3,
} as const;

/** Defense leveling — Addendum B1 ("+25% HP and DPS per level") + App dStat.
 * M22 trap burst uses explicit art-tier tables; wall HP uses its tier table.
 * Extended to L20 (owner 2026-07-20); the sim scales via LEVEL_STEP_BUILDING. */
export const DEFENSE_LEVELING = {
  /** Legacy scalar — the SIM now scales via the tapered LEVEL_STEP_BUILDING array;
   * kept for the client's approximate stat preview. ×1.25/level matched STEP for
   * L≤5, so early levels are identical (aligned in the asset phase). */
  statMultPerLevel: 1.25,
  maxLevel: 20,
} as const;

/**
 * Per-level stat STEP multipliers (owner 2026-07-20, the L1-20 expansion).
 * `levelScale(base, STEP, level)` multiplies base by STEP[2..level] to reach a
 * level's HP/DPS. The bands TAPER (1.25 → 1.10) so the DEFENSE:TROOP power ratio
 * stays 1.085 at EVERY level — a maxed raid is the shipped L1-3 raid rescaled, not
 * the mathematically-unbeatable L20 wall a flat ×1.25/×1.20 geometry produces.
 * STEP[0..1]=1 preserve base & L1; building L≤5 / troop L≤3 keep the literal
 * 1.25/1.20 the sim shipped, so the golden-replay fixtures are byte-identical
 * (master plan §3A: M_building(20)=17.189, M_troop(20)=15.841).
 */
export const LEVEL_STEP_BUILDING = [1, 1.25, 1.25, 1.25, 1.25, 1.18, 1.18, 1.18, 1.18, 1.15, 1.15, 1.15, 1.13, 1.13, 1.13, 1.11, 1.11, 1.11, 1.10, 1.10] as const;
export const LEVEL_STEP_TROOP = [1, 1.20, 1.20, 1.25, 1.25, 1.18, 1.18, 1.18, 1.18, 1.15, 1.15, 1.15, 1.13, 1.13, 1.13, 1.11, 1.11, 1.11, 1.10, 1.10] as const;

/**
 * NEW ROSTER (Pixel Kingdom Wars) FEATURE FLAG (owners 2026-07-20/2026-08-11).
 * The 4 epic defenses + 8 new attacker troops are fully statted and engine-ready;
 * this switch gates their placement/training and is currently enabled. Wyrmling
 * and Barrowling remain spawn products regardless of the flag.
 */
export const NEW_ROSTER_ENABLED = true;
export const NEW_DEFENSE_TYPES = ['electrictower', 'magetower', 'lasertower', 'dragonnest'] as const;
export const NEW_ATTACKER_TROOPS = [
  'giant', 'troll', 'dragon', 'mage', 'bilgewraith',
  'gloamfang', 'direwyvern', 'hexbarrow',
] as const;
/** Compatibility rollout boundary for the SIM6 actor/event family. Default OFF:
 * the server may understand and replay these types before it admits new rows or
 * orders. The API owns the default-off environment switch; Barrowling stays
 * spawn-only even after activation. */
export const DARK_ATTACKER_TROOPS = [
  'gloamfang', 'direwyvern', 'hexbarrow', 'barrowling',
] as const;
export function isDarkAttackerTroop(type: string): type is (typeof DARK_ATTACKER_TROOPS)[number] {
  return (DARK_ATTACKER_TROOPS as readonly string[]).includes(type);
}
/**
 * The Dragon Nest is a SPAWNER (defender-spawns-attacking-troops) whose sim model
 * inverts the damage flow and whose product contract (respawn / concurrent cap /
 * retaliation) is still unsettled — so it stays behind its OWN flag even after the
 * rest of the roster (the 6 Phase-2b mechanics) enables. Keep false until the spawn
 * loop + balance land (Phase 2b-2).
 */
export const DRAGON_NEST_ENABLED = true;

/**
 * Versioned KEEP collision footprint (owner 2026-08-26). Geometry v1 is the
 * shipped/archive contract. V2 is reserved for the isolated game-v4 candidate;
 * production snapshot creation must not stamp it before the base-layout rollout
 * has its own migration/feature gate.
 */
export const BUILDING_GEOMETRY = {
  legacyVersion: 1,
  candidateVersion: 2,
  keepFootprintByVersion: {
    1: [2, 2],
    2: [4, 4],
  },
} as const satisfies {
  legacyVersion: BuildingGeometryVersion;
  candidateVersion: BuildingGeometryVersion;
  keepFootprintByVersion: Readonly<Record<BuildingGeometryVersion, readonly [number, number]>>;
};

/** Persisted JSON is not protected by TypeScript: reject unknown versions rather
 * than silently resolving them with whichever geometry is current. */
export function resolveBuildingGeometryVersion(value: number | undefined): BuildingGeometryVersion {
  if (value === undefined || value === BUILDING_GEOMETRY.legacyVersion) return 1;
  if (value === BUILDING_GEOMETRY.candidateVersion) return 2;
  throw new RangeError(`unsupported building geometry version: ${value}`);
}

// ---------------------------------------------------------------------------
// Structures — Addendum B2 (HP) + App DSTATS (caps/queues). HP given at L1,
// scales ×1.25^(lv−1) like defenses (Addendum B1 symmetry / App dStat); walls
// use the explicit tier table. NOTE: GDD §14's "Structure HP" rows (Keep
// 1000…3000 etc.) are superseded by Addendum B2 + App.
// ---------------------------------------------------------------------------

export const STRUCTURES = {
  /** Live placement remains geometry v1 until the separately-gated migration. */
  keep:     { hp: 1200, maxLevel: 20, footprint: BUILDING_GEOMETRY.keepFootprintByVersion[1] },
  /** Capacity per level (L1-20): balance above cap = raidable surplus (GDD §3.1).
   * L1-5 frozen; extended monotonically to ~1.8M (~2 days maxed income). */
  vault:    { hp: 500,  maxLevel: 20, capacity: [500, 1_500, 4_000, 10_000, 25_000, 40_000, 62_000, 95_000, 140_000, 200_000, 280_000, 380_000, 500_000, 640_000, 800_000, 980_000, 1_170_000, 1_370_000, 1_580_000, 1_800_000], footprint: [1, 1] },
  mine:     { hp: 300,  maxLevel: 20, footprint: [1, 1] },
  /** Trains only; queue size in army points per level, L1-20 (Addendum B6 / App). */
  barracks: { hp: 350,  maxLevel: 20, queuePts: [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105], footprint: [2, 1] },
  forge:    { hp: 380,  maxLevel: 20, footprint: [1, 1] },
  /** Holds the army; capacity in points per level (L1-20), multiple camps stack
   * (Addendum B6). L1-3 frozen; grown to ~180 (4 camps → ~720 army pts at L20). */
  camp:     { hp: 250,  maxLevel: 20, capacityPts: [20, 35, 50, 54, 58, 63, 68, 73, 79, 85, 91, 99, 106, 115, 123, 133, 144, 155, 167, 180], footprint: [2, 2] },
  /** HP by tier 1–20 (Addendum B1 / App dStat). T1-3 [300,600,1200] frozen. */
  wall:     { hpByTier: [300, 600, 1_200, 1_500, 1_875, 2_212, 2_611, 3_081, 3_635, 4_180, 4_808, 5_529, 6_247, 7_060, 7_977, 8_855, 9_829, 10_910, 12_001, 13_201], maxTier: 20, footprint: [1, 1] },
  /** Gold Forge (owner 2026-07-24) — hero 2×2 economy building; its level gates
   * FORGE.contributionCapByLevel. HP between vault and keep: it guards the
   * shards→KEEP faucet, so it must be a real raid target. ⚠ ALPHA PLACEHOLDER. */
  goldforge: { hp: 600, maxLevel: 20, footprint: [2, 2] },
  /** Hero altars (HEROES MVP, overnight 2026-07-26). maxLevel 1: hero LEVELS
   * live on player_heroes, not the building — the altar is the recruitment
   * anchor and the hero's home dais. ⚠ hp = alpha placeholder. */
  heroaltar:  { hp: 800, maxLevel: 1, footprint: [2, 2] },
  siegestool: { hp: 800, maxLevel: 1, footprint: [2, 2] },
  /** Clan membership remains account-level; this is only its destructible 2×2
   * world structure (owner 2026-08-15 / M22). */
  clanhall: { hp: 650, maxLevel: 20, footprint: [2, 2] },
  /** Phase E service buildings + berth (D-152 §5 commit A; E2-WORKSHOP-CONTRACT
   * §0/§1; E1-CONTRACTS §1.3). DARK: no placement until PHASE_E_BUILDINGS_ENABLED
   * (commit B, SIM 18), so no replay can contain them. Passive destructibles like
   * a camp: hp only, no attack fields — the berth is "attackable, non-firing"
   * (owner). hp mirrors the Gold Forge's alpha placeholder.
   * D-149 §10 delegated tuning — PROPOSED, dark. */
  workshop:  { hp: 600, maxLevel: 20, footprint: [2, 2] },
  lodge:     { hp: 600, maxLevel: 20, footprint: [2, 2] },
  market:    { hp: 600, maxLevel: 20, footprint: [2, 2] },
  harvester: { hp: 600, maxLevel: 20, footprint: [2, 2] },
  berth:     { hp: 600, maxLevel: 20, footprint: [2, 2] },
} as const satisfies Record<StructureType, object>;

/**
 * WARE world-art fit (owner 2026-08-15: new bodies must fit the established
 * gameplay tiles like the prior rework; never widen live footprints to match
 * presentation). `sourceScale` is the uniform multiplier in the authored
 * 32-px-per-tile coordinate space. The @2x web world multiplies it by two for
 * rich @1x sheets, while eager @2x aliases use it directly; the deed renderer
 * also uses it directly against @1x crops.
 *
 * Values are rounded DOWN from the maximum steady-body opaque horizontal
 * radius across every shipped tier/level. Transient fire, collapse and FX may
 * leave the footprint briefly. The Keep deliberately retains a tightly bounded
 * presentation overhang so its 20 distinct levels remain readable;
 * every other selectable/resting silhouette stays inside its logical width.
 * Mine's small horizontal correction recentres its open-yard body after
 * the locked D-047 2x2-authoring -> 1x1-gameplay compatibility override.
 */
export const WARE_WORLD_PRESENTATION = {
  keep:         {
    sourceScale: 0.625, offsetGamePx: [0, 0], maxHorizontalOverhangGamePx: 5,
  },
  goldforge:    { sourceScale: 0.7,   offsetGamePx: [0, 0] },
  vault:        { sourceScale: 0.59,  offsetGamePx: [0, 0] },
  // 0.775 → 0.735: the Barracks is a Keep-level-1 building and drew more mass
  // than the level-1 Keep it stands beside. BUILDING_FIT sky clause, at the one
  // level where a level-1 comparison is not hypothetical.
  barracks:     { sourceScale: 0.775, offsetGamePx: [0, 0] },
  forge:        { sourceScale: 0.57,  offsetGamePx: [0, 0] },
  camp:         { sourceScale: 1,     offsetGamePx: [0, 0] },
  // The three towers below were left at the unfitted 1 and, measured in the
  // running scene, out-grew the Keep from their second art tier up (T4 archer
  // 120×186 world px, electric 88×162, air defence 190×122, against a 136×144
  // Keep at L16). Refitted under the Keep-dominance rule `buildingFit.test.ts`
  // pins — owner 2026-08-30, same report as the Mortar. A defence tower has
  // never been allowed to be the biggest thing on the base; nothing checked it.
  archertower:  { sourceScale: 0.65,  offsetGamePx: [0, 0] },
  electrictower:{ sourceScale: 0.725, offsetGamePx: [0, 0] },
  // 0.825 → 0.765: it drew 123.8 world px tall against a 115-px Keep at L16.
  magetower:    { sourceScale: 0.825, offsetGamePx: [0, 0] },
  // Rebuilt T1-T4 family: steady ink is 58px wide at every tier. 0.625 draws
  // 36.25 authored px, inside the 1x1 plot's Keep-derived 1.15 allowance.
  lasertower:   { sourceScale: 0.625, offsetGamePx: [0, 0] },
  mine:         { sourceScale: 0.45,  offsetGamePx: [1, 0] },
  /** 0.85 → 0.70, and this one was the biggest miss on the base: measured, the
   *  Clan Hall drew TALLER THAN THE KEEP at every level it can stand beside, in
   *  the pack it shipped on AND in the pack that replaced it mid-pass. From
   *  Keep level 5 up, the tallest building on every base was the Clan Hall, not
   *  the Keep. It went unnoticed because the shipped fit test only ever covered
   *  DEFENCE families and named this one as deliberately out of scope; the
   *  owner's rule ("the Keep is the biggest thing on a base; nothing reaches
   *  it") has no such exemption, so BUILDING_FIT's sky clause now covers every
   *  family and this is what it costs. */
  clanhall:     { sourceScale: 0.61,  offsetGamePx: [0, 0] },
  /** RE-DERIVED 2026-08-30. The 0.95 predated the dragon-nest rework shipped in
   *  c2320c8: the new art is wider, so at 0.95 its steady frame spanned 149-231
   *  against a 160-223 footprint -- 11px west and 8px east outside its own 2x2,
   *  which baseRender's audited envelope caught. 0.73 is 0.95 x (63/82), the
   *  measured ratio of footprint width to drawn width. Replacing a family's art
   *  without re-deriving its fit is the mistake this comment exists to prevent. */
  dragonnest:   { sourceScale: 0.70,  offsetGamePx: [0, 0] },
  airdefence:   { sourceScale: 0.575, offsetGamePx: [0, 0] },
  spiketrap:    { sourceScale: 1,     offsetGamePx: [0, 0] },
  powdermine:   { sourceScale: 1,     offsetGamePx: [0, 0] },
  pitfall:      { sourceScale: 1,     offsetGamePx: [0, 0] },
  airmine:      { sourceScale: 1,     offsetGamePx: [0, 0] },
  wall:         { sourceScale: 1,     offsetGamePx: [0, 0] },
} as const;

// ---------------------------------------------------------------------------
// Build costs (new construction, Shards) — GDD §14 where priced there
// (defenses, barracks, wall, trap); otherwise App BUILD_ITEMS (mine, vault,
// camp, forge). The Keep is never built — L1 comes free with the base
// (GDD §3.1). buildSec: see L1_BUILD_SEC — every new construction is one
// minute; the GDD §14 first durations now apply only from L1→L2 upward
// (UPGRADE_TIMES_SEC), which is where the time-gate sink actually lives.
// CONFLICTS (GDD §14 chosen, per chain of authority decision for this table):
//   wall 20 vs Addendum B5 "50 Shards v0.1" vs App 50 — §14 wins here;
//   trap 30 (GDD §14 "Spike Trap 30 each") vs App 300;
//   cannon 200 / archertower 250 / mortar 400 / barracks 300 vs App
//   600/900/2400/1200.
// ---------------------------------------------------------------------------

/**
 * Level-1 build time for EVERY building, in seconds. Owner 2026-08-29, verbatim:
 * "first level building should not need hour to build it should be all 1 minute
 * builds, to speed up player onboarding and let them instantly have fun".
 *
 * This overrides the GDD §14 first-build durations (cannon/barracks 1h, mortar/
 * air defence 2h, the epic defenses up to 5h) — a new player must never wait an
 * hour to see a building they just paid for. The progression time-gate is
 * UNCHANGED: it starts at L1→L2 in UPGRADE_TIMES_SEC. Placement cost, Keep-level
 * gates and count caps are the real L1 brakes, not the clock.
 *
 * Referenced rather than written out 20 times so the rule stays one number —
 * constants.test.ts pins the whole table to it so a per-building edit cannot
 * silently reintroduce an hour.
 */
export const L1_BUILD_SEC = 60;

export const BUILD_COSTS = {
  cannon:      { costShards: 200,   buildSec: L1_BUILD_SEC },
  archertower: { costShards: 250,   buildSec: L1_BUILD_SEC },
  mortar:      { costShards: 400,   buildSec: L1_BUILD_SEC, requiresKeepLevel: 3 }, // Keep L3+ gate (GDD §14/§3.1)
  airdefence:  { costShards: 1_100, buildSec: L1_BUILD_SEC, requiresKeepLevel: 7 }, // owner 2026-08-15/M22: before flying armies
  barracks:    { costShards: 300,   buildSec: L1_BUILD_SEC },
  // Walls are the ONE exception to L1_BUILD_SEC: they place instantly with no
  // builder job at all (owner 2026-07-20 — the higher cost is the balance), so
  // 0 is already faster than a minute. Raising it to 60 would slow the game
  // down, which is the opposite of what the 1-minute decision is for.
  wall:        { costShards: 150,   buildSec: 0 },
  spiketrap:   { costShards: 30,    buildSec: L1_BUILD_SEC },
  powdermine:  { costShards: 75,    buildSec: L1_BUILD_SEC, requiresKeepLevel: 4 },
  pitfall:     { costShards: 90,    buildSec: L1_BUILD_SEC, requiresKeepLevel: 6 },
  airmine:     { costShards: 120,   buildSec: L1_BUILD_SEC, requiresKeepLevel: 8 },
  mine:        { costShards: 400,   buildSec: L1_BUILD_SEC },
  vault:       { costShards: 800,   buildSec: L1_BUILD_SEC },
  camp:        { costShards: 1_000, buildSec: L1_BUILD_SEC },
  forge:       { costShards: 1_500, buildSec: L1_BUILD_SEC, requiresKeepLevel: 2 }, // Keep L2 gate (Addendum B1)
  // Pixel Kingdom Wars epic defenses — staggered Keep gates (master plan §3G/§3H).
  // DARK: NEW_ROSTER_ENABLED gates placement even once the Keep level is met.
  electrictower: { costShards: 900,   buildSec: L1_BUILD_SEC, requiresKeepLevel: 8 },
  magetower:     { costShards: 1_400, buildSec: L1_BUILD_SEC, requiresKeepLevel: 10 },
  lasertower:    { costShards: 2_200, buildSec: L1_BUILD_SEC, requiresKeepLevel: 12 },
  dragonnest:    { costShards: 3_500, buildSec: L1_BUILD_SEC, requiresKeepLevel: 14 },
  /** Gold Forge (owner 2026-07-24): priciest economy build — it unlocks the
   * shards→KEEP faucet. Keep L3 gate. ⚠ ALPHA PLACEHOLDER (owner tunes). */
  goldforge:     { costShards: 2_500, buildSec: L1_BUILD_SEC, requiresKeepLevel: 3 },
  /** Recruiting a hero = building their altar (HEROES MVP). REPRICED
   * 2026-08-16 (owner verbatim: "hero unlock start from keep level 5. Vex hero
   * cost is 3000 KEEP, Theodor 10,000 KEEP"): both altars now gate at Keep L5
   * and the SHARD price is gone — placement instead consumes 1 hero-contract
   * item (UNLOCK_ITEMS) or charges HEROES[hero].recruitCostKeep in KEEP
   * (spendKeep → emission_pool). costShards stays 0 so no generic shard spend
   * fires; base.ts placeBuilding owns the altar-specific charge. */
  heroaltar:     { costShards: 0, buildSec: L1_BUILD_SEC, requiresKeepLevel: 5 },
  siegestool:    { costShards: 0, buildSec: L1_BUILD_SEC, requiresKeepLevel: 5 },
  clanhall:      { costShards: 2_000, buildSec: L1_BUILD_SEC, requiresKeepLevel: 5 },
  /** Phase E (D-152 §5 commit A). DARK: base.ts refuses placement until
   * PHASE_E_BUILDINGS_ENABLED (commit B). Workshop: ≤ 2,000 SHARDS at Keep L3 so
   * the starter grant reaches it on day 1 (E2-WORKSHOP-CONTRACT §0, JOURNEY-MODEL
   * §3.1). The other four are placeholders at or above the Workshop gate.
   * D-149 §10 delegated tuning — PROPOSED, dark. */
  workshop:      { costShards: 2_000, buildSec: L1_BUILD_SEC, requiresKeepLevel: 3 },
  lodge:         { costShards: 2_000, buildSec: L1_BUILD_SEC, requiresKeepLevel: 4 },
  market:        { costShards: 2_000, buildSec: L1_BUILD_SEC, requiresKeepLevel: 4 },
  harvester:     { costShards: 2_000, buildSec: L1_BUILD_SEC, requiresKeepLevel: 5 },
  berth:         { costShards: 2_000, buildSec: L1_BUILD_SEC, requiresKeepLevel: 5 },
} as const;

/** Spent traps remain placed and require this explicit repair (owner 2026-08-15/M22). */
export const TRAP_REPAIR = {
  spiketrap:  { costShardsByTier: [20, 30, 45, 65], repairSec: 30 },
  powdermine: { costShardsByTier: [45, 65, 90, 125], repairSec: 45 },
  pitfall:    { costShardsByTier: [55, 80, 110, 150], repairSec: 45 },
  airmine:    { costShardsByTier: [70, 100, 140, 190], repairSec: 60 },
} as const satisfies Record<import('./types').TrapType, object>;

// ---------------------------------------------------------------------------
// Upgrade costs & times — GDD §14 exact. Index 0 = upgrade to L2 (walls: to
// tier 2). Camp and Forge upgrade costs are NOT specified anywhere in the GDD
// or Addendum — deliberately absent; do not invent them (alpha tuning TODO).
// ---------------------------------------------------------------------------

// Owner 2026-07-20: extended to 19 steps (L1→2 … L19→20) for the L1-20 expansion.
// Each is a strictly-increasing geometric SHARDS curve. REVAMPED 2026-07-20
// (÷~8.2 from the prior curve): maxing one base's structures is approximately a
// 25M-SHARDS progression sink. The API enforces these through spendBaseShards;
// the separately priced timer speed-ups are KEEP sinks.
export const UPGRADE_COSTS = {
  keep:        [182, 290, 464, 741, 1_180, 1_890, 3_010, 4_810, 7_690, 12_300, 19_600, 31_200, 49_900, 79_700, 128_000, 203_000, 324_000, 517_000, 826_000],
  mine:        [61, 95, 148, 231, 359, 561, 876, 1_370, 2_140, 3_330, 5_190, 8_100, 12_600, 19_700, 30_700, 48_000, 74_800, 117_000, 182_000],
  vault:       [49, 74, 114, 175, 268, 412, 631, 969, 1_480, 2_280, 3_500, 5_360, 8_220, 12_600, 19_300, 29_600, 45_400, 69_700, 107_000],
  cannon:      [97, 141, 204, 296, 431, 624, 907, 1_310, 1_910, 2_770, 4_020, 5_830, 8_460, 12_300, 17_900, 25_900, 37_500, 54_400, 78_900],
  archertower: [121, 175, 251, 362, 521, 749, 1_080, 1_550, 2_230, 3_220, 4_630, 6_650, 9_570, 13_700, 19_800, 28_500, 41_000, 59_000, 85_000],
  mortar:      [194, 278, 397, 568, 812, 1_160, 1_660, 2_380, 3_400, 4_860, 6_950, 9_930, 14_200, 20_300, 29_000, 41_500, 59_400, 84_900, 121_000],
  airdefence:  [182, 256, 361, 508, 714, 1_000, 1_410, 1_990, 2_790, 3_930, 5_540, 7_780, 11_000, 15_400, 21_700, 30_500, 43_000, 60_500, 85_000],
  spiketrap:   [24, 36, 52, 72, 108, 156, 224, 328, 476, 684, 996, 1_444, 2_092, 3_036, 4_400, 6_360, 9_240, 13_400, 19_440],
  powdermine:  [36, 54, 78, 108, 162, 234, 336, 492, 714, 1_026, 1_494, 2_166, 3_138, 4_554, 6_600, 9_540, 13_860, 20_100, 29_160],
  pitfall:     [42, 63, 91, 126, 189, 273, 392, 574, 833, 1_197, 1_743, 2_527, 3_661, 5_313, 7_700, 11_130, 16_170, 23_450, 34_020],
  airmine:     [48, 72, 104, 144, 216, 312, 448, 656, 952, 1_368, 1_992, 2_888, 4_184, 6_072, 8_800, 12_720, 18_480, 26_800, 38_880],
  barracks:    [146, 209, 300, 430, 617, 884, 1_260, 1_820, 2_610, 3_740, 5_370, 7_690, 11_000, 15_800, 22_700, 32_500, 46_600, 66_900, 95_900],
  /** Per-segment wall tier upgrades T1→2 … T19→20 (geometric). Owner 2026-07-20:
   *  walls are now FULLY INSTANT (no build OR upgrade timer/builder — base.ts), so
   *  SHARDS cost is the ONLY balance lever → scaled ×8 vs the other buildings' revamp
   *  (~125k/segment to max T1→20, so mass-maxing a wall ring is a real SHARDS sink). */
  wall:        [48, 72, 104, 144, 216, 312, 448, 656, 952, 1_368, 1_992, 2_888, 4_184, 6_072, 8_800, 12_720, 18_480, 26_800, 38_880],
  /** ALPHA PLACEHOLDER curve (no GDD source — mirrors barracks; tune in alpha). */
  camp:        [146, 209, 300, 430, 617, 884, 1_260, 1_820, 2_610, 3_740, 5_370, 7_690, 11_000, 15_800, 22_700, 32_500, 46_600, 66_900, 95_900],
  forge:       [146, 209, 300, 430, 617, 884, 1_260, 1_820, 2_610, 3_740, 5_370, 7_690, 11_000, 15_800, 22_700, 32_500, 46_600, 66_900, 95_900],
  // Pixel Kingdom Wars epic defenses (DARK) — geometric to a per-tower endgame top.
  electrictower: [182, 256, 361, 508, 714, 1_000, 1_410, 1_990, 2_790, 3_930, 5_540, 7_780, 11_000, 15_400, 21_700, 30_500, 43_000, 60_500, 85_000],
  magetower:     [304, 418, 577, 794, 1_090, 1_510, 2_080, 2_870, 3_950, 5_430, 7_480, 10_300, 14_200, 19_600, 27_000, 37_200, 51_100, 70_600, 97_200],
  lasertower:    [486, 652, 876, 1_170, 1_580, 2_110, 2_840, 3_810, 5_110, 6_870, 9_220, 12_400, 16_600, 22_300, 29_900, 40_200, 53_900, 72_400, 97_200],
  dragonnest:    [729, 962, 1_260, 1_680, 2_210, 2_910, 3_840, 5_060, 6_690, 8_830, 11_600, 15_300, 20_300, 26_700, 35_200, 46_500, 61_400, 81_000, 107_000],
  /** Gold Forge (owner 2026-07-24): mirrors the Keep building's SHARDS curve — the steepest in the
   * game, deliberately, because each level raises the player's daily KEEP-faucet
   * cap (FORGE.contributionCapByLevel). ⚠ ALPHA PLACEHOLDER (owner tunes). */
  goldforge:     [182, 290, 464, 741, 1_180, 1_890, 3_010, 4_810, 7_690, 12_300, 19_600, 31_200, 49_900, 79_700, 128_000, 203_000, 324_000, 517_000, 826_000],
  clanhall:      [146, 209, 300, 430, 617, 884, 1_260, 1_820, 2_610, 3_740, 5_370, 7_690, 11_000, 15_800, 22_700, 32_500, 46_600, 66_900, 95_900],
  /** Phase E (D-152 §5 commit A): the Gold Forge SHARDS curve, copied — each
   * Workshop level raises batch size and refine speed (E2-WORKSHOP-CONTRACT §0),
   * the same "level = economy throughput" shape. Upper-level SOL prices stay
   * unapproved (E1-CONTRACTS §1.3): upgradeSolLamports returns 0 for these.
   * D-149 §10 delegated tuning — PROPOSED, dark. */
  workshop:      [182, 290, 464, 741, 1_180, 1_890, 3_010, 4_810, 7_690, 12_300, 19_600, 31_200, 49_900, 79_700, 128_000, 203_000, 324_000, 517_000, 826_000],
  lodge:         [182, 290, 464, 741, 1_180, 1_890, 3_010, 4_810, 7_690, 12_300, 19_600, 31_200, 49_900, 79_700, 128_000, 203_000, 324_000, 517_000, 826_000],
  market:        [182, 290, 464, 741, 1_180, 1_890, 3_010, 4_810, 7_690, 12_300, 19_600, 31_200, 49_900, 79_700, 128_000, 203_000, 324_000, 517_000, 826_000],
  harvester:     [182, 290, 464, 741, 1_180, 1_890, 3_010, 4_810, 7_690, 12_300, 19_600, 31_200, 49_900, 79_700, 128_000, 203_000, 324_000, 517_000, 826_000],
  berth:         [182, 290, 464, 741, 1_180, 1_890, 3_010, 4_810, 7_690, 12_300, 19_600, 31_200, 49_900, 79_700, 128_000, 203_000, 324_000, 517_000, 826_000],
} as const;

/** Seconds; same keys/indexing as UPGRADE_COSTS. Wall upgrade time is not
 * specified in GDD §14 — absent on purpose. */
// Owner 2026-08-30 (D-085) replaced the per-building geometric curves with ONE hand-authored
// ladder, dictated level by level: 10m, 20m, 45m, 1h, 1.5h, 2h, 3h, 4h, 8h, 10h, 12h, 16h,
// 20h, 24h, 28h, 32h, 48h, 60h, 72h — 342.75h to L20 against the ~810h it replaces.
// KEEP and GOLDFORGE take the same ladder x1.2 (411.3h); x1.2 is exact on every step, so the
// two tables stay integral and a test pins that relationship rather than trusting the digits.
// TRAPS (spiketrap/powdermine/pitfall/airmine) deliberately KEEP their old fast curve — the
// owner ruled that a disposable defence going 40.6h -> 342.75h changes what it is.
// The L1 build itself stays 60s for every building (D-081); this table starts at L1->L2.
// Superseded: owner 2026-07-20's geometric curves (Keep ~14d, mine/vault ~7d, others ~5d).
// Soft cap unchanged: speed-ups (KEEP -> emission_pool) let players shortcut, so time is a sink.
export const UPGRADE_TIMES_SEC = {
  keep:        [720, 1_440, 3_240, 4_320, 6_480, 8_640, 12_960, 17_280, 34_560, 43_200, 51_840, 69_120, 86_400, 103_680, 120_960, 138_240, 207_360, 259_200, 311_040],
  mine:        [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  vault:       [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  cannon:      [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  archertower: [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  mortar:      [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  airdefence:  [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  spiketrap:   [600, 745, 925, 1_150, 1_420, 1_760, 2_180, 2_700, 3_350, 4_160, 5_150, 6_390, 7_930, 9_830, 12_200, 15_100, 18_700, 23_200, 28_800],
  powdermine:  [600, 745, 925, 1_150, 1_420, 1_760, 2_180, 2_700, 3_350, 4_160, 5_150, 6_390, 7_930, 9_830, 12_200, 15_100, 18_700, 23_200, 28_800],
  pitfall:     [600, 745, 925, 1_150, 1_420, 1_760, 2_180, 2_700, 3_350, 4_160, 5_150, 6_390, 7_930, 9_830, 12_200, 15_100, 18_700, 23_200, 28_800],
  airmine:     [600, 745, 925, 1_150, 1_420, 1_760, 2_180, 2_700, 3_350, 4_160, 5_150, 6_390, 7_930, 9_830, 12_200, 15_100, 18_700, 23_200, 28_800],
  barracks:    [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  /** ALPHA PLACEHOLDER — see UPGRADE_COSTS note. */
  camp:        [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  forge:       [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  // Pixel Kingdom Wars epic defenses (DARK) — monotonic to ~5d, matching defenses.
  electrictower: [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  magetower:     [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  lasertower:    [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  dragonnest:    [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  /** Gold Forge: economy-building band (mine/vault curve, ~7d top step). */
  goldforge:     [720, 1_440, 3_240, 4_320, 6_480, 8_640, 12_960, 17_280, 34_560, 43_200, 51_840, 69_120, 86_400, 103_680, 120_960, 138_240, 207_360, 259_200, 311_040],
  clanhall:      [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  /** Phase E (D-152 §5 commit A): the D-085 owner-dictated ladder every non-trap
   * building takes (the x1.2 band is reserved for KEEP/GOLDFORGE and pinned by
   * constants.test.ts). D-149 §10 delegated tuning — PROPOSED, dark. */
  workshop:      [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  lodge:         [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  market:        [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  harvester:     [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
  berth:         [600, 1_200, 2_700, 3_600, 5_400, 7_200, 10_800, 14_400, 28_800, 36_000, 43_200, 57_600, 72_000, 86_400, 100_800, 115_200, 172_800, 216_000, 259_200],
} as const;

/** Wall segment cap by Keep level — now the Keep-scaled 40→250 curve
 * (BUILD_COUNT_CAP_BY_KEEP.wall, owner 2026-07-20), replacing the old 20/40/60
 * bands so walls grow with the base. */
export function wallCapForKeepLevel(keepLevel: number): number {
  return buildCountCapForKeep('wall', keepLevel)!;
}

// ---------------------------------------------------------------------------
// Caps — GDD §3.1 (walls, traps), Addendum B7 (builders), GDD §4.6 + App
// expandLand (expansions)
// ---------------------------------------------------------------------------

export const CAPS = {
  /** "20/40/60 segments by Keep level" (GDD §3.1 / Addendum B5). Three bands
   * for five Keep levels; the level→band mapping is not specified — server
   * decides at alpha tuning. */
  wallSegments: [20, 40, 60],
  /** Aggregate max across all four trap families by Keep level 1–20 (owner
   * 2026-08-15/M22; preserves the earlier spike-only curve rather than adding
   * four independent burst budgets).
   * min(20, 2×keep) — plateaus at 20 from Keep L10). Without the L6-20 entries a
   * base past Keep 5 would read `undefined` → a 0 trap cap. */
  trapsByKeepLevel: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20],
  /** Six builders maximum: the first is free and five more are hired with SOL
   * (owner 2026-08-11). */
  buildersMax: 6,
  /** One-time SOL price for builders 2–6 (owner 2026-08-11). */
  builderPricesSol: [0.5, 0.75, 1, 1.5, 3],
  /** Land expansions, 0..12. Owner 2026-09-16 approved six additional steps
   * through 50×50 (docs/BASE-EXPANSION-50-PLAN.md); the original six stay intact. */
  expansionsMax: 12,
  /** On-chain buy_expansion price (slots 0–2 via shardkeep-core; the program caps at
   * 2). Kept scalar for bootstrap + the current client path. GDD §4.6. */
  expansionPriceSol: 0.15,
  /** SOL price per expansion PURCHASE index (0-based). Original six: master
   * plan §3I. Appended six: owner 2026-09-16, BASE-EXPANSION-50-PLAN.md.
   * Server-priced deposit quotes freeze the amount before payment. */
  expansionPriceSolByIndex: [0.15, 0.25, 0.40, 0.65, 1.00, 1.50, 1.75, 2.00, 2.25, 2.50, 2.75, 3.00],
  /** Keep level required to buy the Nth expansion (index 0 = 1st): L3/6/9/12/15/18,
   * followed by L19/20/20/20/20/20 (owner 2026-09-16). Purchases stay sequential. */
  expansionReqKeepLevel: [3, 6, 9, 12, 15, 18, 19, 20, 20, 20, 20, 20],
  /** Claim size after N expansions. Preserve the original 14→26 coordinates;
   * owner 2026-09-16 appends 30/34/38/42/46/50 around the same centre15.
   * min = (GRID.plotTiles − size)/2 reaches −10; no saved layout is shifted. */
  claimTilesByExpansion: [14, 16, 18, 20, 22, 24, 26, 30, 34, 38, 42, 46, 50],
} as const;

/** Multi-base ownership limits and chain-freshness contract (owner 2026-08-11).
 * Five is an activation cap, never an NFT ownership cap. Privileged mutations
 * synchronously refresh observations older than 10 seconds; the background
 * observer renews every proof well inside that window (pacing below).
 *
 * DEED-PROOF PACING — retuned 2026-09-19, owner upgraded the production RPC key
 * to the Helius DEVELOPER plan. Production deed reads go to Helius
 * (SOLANA_RPC_URL = devnet.helius-rpc.com on API and worker, D-142), never the
 * public endpoint the previous numbers were sized for. Helius docs
 * (billing/plans + billing/rate-limits, read 2026-09-19): Developer = 10M
 * credits/month and 50 RPC req/s (sendTransaction 5/s, getProgramAccounts 25/s,
 * DAS + enhanced APIs 10/s), HTTP 429 beyond that; a standard RPC call,
 * getMultipleAccounts included, costs 1 credit; Free was 1M credits and
 * 10 req/s. The same key also serves the player RPC relay, deposit and market
 * payment verification, deed minting and the chain URI sync, so the deed
 * subsystem only gets the slice in DEED_RPC_BUDGET. Its REQUEST RATE would be
 * harmless even on the Free plan; its CREDITS are NOT Free-plan-safe. The
 * observer alone bills 1.56M-2.68M credits a month (below) against Free's 1M -
 * the previous cadence billed about 0.26M and fitted. On a Free key the monthly
 * allowance is gone by about day 19 at 75 deeds (day 11-12 at 160), sooner with
 * the relay and payment traffic, and Helius then rejects EVERY call on the key
 * until the monthly reset: payment verification, payouts, deed minting, the
 * relay and deed authority (every gated action 503). This pacing REQUIRES the
 * Developer plan on the project that owns the production key.
 *
 * Observer arithmetic. One wave = ONE getMultipleAccounts = 1 credit (at most
 * observationConcurrency assets + the collection). Waves start at least
 * observationBatchIntervalMs apart and a full sweep holds its queue-global job
 * one more interval after its last wave, so the observer NEVER sends more than
 * one request per second, across sweeps, replicas and the startup sweep too.
 *   75 deeds (2026-09-19): ceil(75/32) = 3 waves -> sweep 3 s, idle 2 s,
 *     period 5 s -> 0.6 req/s -> 51,840/day -> 1.56M credits per 30 days
 *     (1.61M in a 31-day month).
 *   160 deeds (ceiling):   ceil(160/32) = 5 waves -> sweep 5 s = the poll
 *     period, back to back -> 1.0 req/s -> 86,400/day -> 2.59M credits per
 *     30 days (2.68M in a 31-day month).
 * BullMQ 5.78 `every` produces the next sweep (previous scheduled time + every)
 * when the current one becomes ACTIVE, and the queue runs one sweep at a time:
 * IN STEADY STATE the sweep period is max(sweep duration, observationPollMs).
 * Sweeps cannot overlap and at most one occurrence is ever pending.
 * NOT after a late occurrence. One that becomes active more than a period late
 * (a wave that ran into observationReadTimeoutMs, a worker restart) is
 * realigned by BullMQ to floor(now / every) * every + every + stored offset.
 * With the offset on this grid (< every) that is ONE start-to-start gap of just
 * under 2 x observationPollMs = 10 s; proofs can pass the 10 s rule for the end
 * of that gap and the paced foreground read is the fallback (fail-closed, far
 * inside the 60 s SLA). BullMQ keeps a stored offset across a changed `every`,
 * and a stale 15 s-grid offset would stretch the gap to every + 15 s = 20 s, so
 * scheduleDeedOwnershipObserver (apps/api/src/jobs.ts) resets a scheduler
 * stored at another cadence (Redis-backed test in apps/api/test/jobs.test.ts).
 * At the ceiling sweeps run a little over 5 s, so the lateness creeps past one
 * period about every 15-20 minutes (estimate); an on-grid offset makes that
 * realignment skip one slot without a hole.
 * Worst steady-state proof age = period + DEED_RPC_BUDGET.proofReadLatencyBudgetMs
 *   = 5_000 + 1_500 = 6_500 ms at 75 AND at 160 deeds: below the 7_000 ms at
 * which the gate starts an early renewal (mutationFreshnessMs -
 * gateRefreshAheadMs) and 3.5 s inside the 10 s rule, so a steady-state request
 * needs no foreground read. Before: 10.25 s waves made one 75-deed sweep ~31 s,
 * a proof was fresh about a third of the time and real owners saw false 503s
 * (2026-09-18). apps/api/test/baseOwnershipPacing.test.ts recomputes all of
 * this from the constants; a retune that breaks the budget fails there. */
export const BASE_OWNERSHIP = {
  maxActive: 5,
  mutationFreshnessMs: 10_000,
  /** Observer sweep cadence (BullMQ `every`). = ceil(observationMaxActiveDeeds /
   * observationConcurrency) x observationBatchIntervalMs, so a sweep at the
   * supported ceiling exactly fills one period. Was 15_000 until 2026-09-19. */
  observationPollMs: 5_000,
  /** A finalized asset+collection read has one end-to-end deadline. Together
   * with the bounded fan-out/cap this keeps a complete observer pass below the
   * owner's one-minute ownership-loss target, even at the supported ceiling. */
  observationReadTimeoutMs: 8_000,
  /** Minimum start-to-start gap between observer waves, within a sweep and
   * (through the full-sweep tail hold) across consecutive sweeps: the hard
   * "at most 1 observer request per second" of the pacing note above — 2 % of
   * the Developer plan, 10 % of Free. Was 10_250 (sized for the public Solana
   * RPC's 40 calls per method per rolling 10 s) until 2026-09-19. */
  observationBatchIntervalMs: 1_000,
  observationConcurrency: 32,
  /** Foreground stale-proof reads are the FALLBACK now (worker stopped for the
   * nightly backup or a deploy, a failed observer wave). Each reader starts at
   * most one read per interval — 2.5 starts/s, retries included — and fails
   * closed instead of building an unbounded queue (security review 2026-08-12;
   * the batch observer bypasses this single-read gate). Three readers carry
   * traffic (API game routes, API mail routes — mail/routes.ts builds its own —
   * and the worker): worst case 3 x 2.5 + 1 observer = 8.5 req/s, inside the
   * 10 req/s deed budget. One reader absorbs floor(8_000 / 400) + 1 = 21
   * distinct deeds within foregroundReadQueueTimeoutMs. Was 500 (2 starts/s,
   * 17 deeds) until 2026-09-19. */
  foregroundReadStartIntervalMs: 400,
  foregroundReadQueueTimeoutMs: 8_000,
  /** Production incident 2026-09-18: two legitimate owners were answered 503
   * DEED_AUTHORITY_UNAVAILABLE in steady state. A foreground read gets ONE more
   * paced start, only after a TRANSPORT failure (RPC error, rate limit,
   * timeout, node behind the context floor) and only inside the original
   * foregroundReadQueueTimeoutMs deadline. A positive answer — owner, mismatch,
   * ineligible or missing asset — is never retried. */
  foregroundReadTransportRetries: 1,
  /** Same incident. The pre-transaction gate STARTS a renewal of a proof that
   * has less than this much life left, so the locked re-check inside the
   * action's transaction is less likely to expire a proof the gate accepted
   * moments earlier (GET /base re-checks twice under row locks; POST /raids
   * re-checks the attacker after a paced defender read: one foreground start
   * slot plus an RPC round trip). The request never WAITS for that renewal
   * (security review 2026-09-18: a read can outlive the proof it renews); it
   * proceeds on the still-valid proof. It only makes the gate read EARLIER:
   * mutationFreshnessMs remains the hard limit every privileged action is
   * re-checked against. */
  gateRefreshAheadMs: 3_000,
  observationMaxActiveDeeds: 160,
  /** /health and flag-on boot require every active deed's latest finalized
   * ownership proof to remain inside the one-minute loss-detection SLA. */
  observationHealthFreshnessMs: 60_000,
  reservationTtlMs: 15 * 60_000,
} as const;

/** RPC budget the BASE_OWNERSHIP pacing is sized against (owner 2026-09-19,
 * Helius Developer plan; figures from the Helius docs cited above). Nothing
 * reads these at runtime: apps/api/test/baseOwnershipPacing.test.ts derives the
 * observer rate, the worst-case subsystem rate, the monthly credits and the
 * worst proof age from BASE_OWNERSHIP and fails when one leaves this budget. */
export const DEED_RPC_BUDGET = {
  planRequestsPerSecond: 50,
  /** Developer plan monthly credits. The observer must fit with room for the
   * relay and the money paths on the same key. */
  planCreditsPerMonth: 10_000_000,
  /** Request RATE harmless on Free; CREDITS require Developer (pacing note
   * above): the observer bills more than freePlanCreditsPerMonth at every
   * load from typicalActiveDeeds up, and the pacing test pins that fact. */
  freePlanRequestsPerSecond: 10,
  freePlanCreditsPerMonth: 1_000_000,
  /** Observer + every foreground reader, sustained worst case: 20 % of the
   * plan. The other 80 % belongs to the relay and the money paths. */
  maxSubsystemRequestsPerSecond: 10,
  maxObserverRequestsPerSecond: 1,
  maxForegroundStartsPerSecondPerReader: 5,
  /** makeFinalizedDeedReader call sites that carry traffic: API game routes,
   * API mail routes, worker jobs (the worker builds the app too, but its HTTP
   * surface is the unexposed /health port, so its two route readers are idle).
   * The pacing test counts the call sites in the source. */
  foregroundReaders: 3,
  creditsPerRequest: 1,
  /** Active deeds in production on 2026-09-19 — the "typical" load. */
  typicalActiveDeeds: 75,
  /** A quarter of the Developer plan's 10M monthly credits. */
  maxTypicalCreditsPerMonth: 2_500_000,
  /** RPC round trip + the wave's DB commits + queue hand-off between sweeps. */
  proofReadLatencyBudgetMs: 1_500,
  /** Distinct deeds that may all need a foreground read at the same instant
   * (every proof stale at once after a worker outage) and must still each get
   * a start slot inside foregroundReadQueueTimeoutMs instead of a queue-timeout
   * 503. A SIZING ASSUMPTION for ~75 deeds, not a measurement — owner tunes. */
  foregroundBurstDeeds: 20,
} as const;

/** Deposit-chain verification resource bounds (security review 2026-08-12).
 * RPC is performed while a short DB advisory lease protects the paid/terminal
 * transition, so keep concurrency well below the API pool and abort sick RPCs. */
/** Client land recovery bounds (2026-09-06 wrong-network checkout incident).
 * These bound waiting for responses, never the authoritative payment window. */
export const LAND_CHECKOUT_RECOVERY = {
  requestTimeoutMs: 15_000,
  walletResponseGraceMs: 30_000,
  /** Explicit same-intent retry is safe only for the one-time pay_entry PDA. */
  firstEntryRetryMs: 60_000,
  pollMs: 2_500,
} as const;

export const DEPOSIT_VERIFICATION = {
  concurrency: 4,
  rpcTimeoutMs: 8_000,
} as const;

/**
 * Per-building placement COUNT cap by KEEP LEVEL (owner 2026-07-20 — counts grow
 * with the Keep so the base scales with progression, not a flat ceiling). Each
 * array is length-20 (Keep L1..L20): 0 before the type's unlock (requiresKeepLevel),
 * then growing to its L20 cap. WALLS scale to 250 (a max base + internal walls).
 * Mine (MAX_MINES_BY_KEEP) and aggregate traps (trapsByKeepLevel) keep their own Keep
 * arrays; every other buildable is here (walls included — wallCapForKeepLevel reads
 * this). Generated from (unlock, L20-cap) with a linear ramp — tune freely.
 */
export const BUILD_COUNT_CAP_BY_KEEP: Readonly<Record<string, readonly number[]>> = {
  wall:          [40, 51, 62, 73, 84, 95, 106, 117, 128, 139, 151, 162, 173, 184, 195, 206, 217, 228, 239, 250],
  cannon:        [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10],
  archertower:   [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10],
  barracks:      [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4],
  camp:          [1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4],
  /** One extra Vault every four Keep levels (owner 2026-08-12). */
  vault:         [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5],
  forge:         [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  mortar:        [0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5],
  airdefence:    [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4],
  electrictower: [0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4],
  magetower:     [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3],
  lasertower:    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 3],
  dragonnest:    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2],
  /** Gold Forge: exactly ONE per base from Keep L3 (owner 2026-07-24). */
  goldforge:     [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  heroaltar:     [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  siegestool:    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  clanhall:      [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  /** Phase E (D-152 §5 commit A): exactly ONE per base for the four services
   * (LOCKED owner rule, E1-CONTRACTS §1.3); berth count by Keep level, 1 at
   * launch. 0 before each type's BUILD_COSTS gate. DARK until commit B.
   * D-149 §10 delegated tuning — PROPOSED, dark. */
  workshop:      [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  lodge:         [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  market:        [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  harvester:     [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  berth:         [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
} as const;

/** Phase E building catalogue metadata (E1-CONTRACTS §1.3; D-152 §5). No game
 * numbers: it names the five DARK types so every consumer that enumerates
 * building tables (the sim plot-v2 capacity fixture, the future placement gate)
 * excludes them by one list instead of five literals. Commit B flips placement;
 * until then these types are enum values with constants rows and nothing else. */
export const PHASE_E_BUILDINGS = {
  serviceTypes: ['workshop', 'lodge', 'market', 'harvester'],
  berthType: 'berth',
  /** Every dark type, for exclusion lists. */
  types: ['workshop', 'lodge', 'market', 'harvester', 'berth'],
  visualTiers: 4,
  harvesterRealmVariants: 8,
  onePerBase: true,
} as const;

/** Placement count cap for a building type at a Keep level (owner 2026-07-20:
 *  Keep-level-based). undefined = uses a Keep-scaled cap elsewhere (mine/traps). */
export function buildCountCapForKeep(type: string, keepLevel: number): number | undefined {
  const arr = BUILD_COUNT_CAP_BY_KEEP[type];
  if (!arr) return undefined;
  return arr[Math.min(Math.max(keepLevel, 1), arr.length) - 1];
}

/** Wall swipe request bound: the existing route allowed the maximum Keep wall
 * population (250 at L20, owner #59). Derive it from that unchanged authority. */
export const WALL_BATCH = { maxTiles: BUILD_COUNT_CAP_BY_KEEP.wall!.at(-1)! } as const;

/**
 * Refund-churn admission for troop training (security review 2026-09-02).
 *
 * The durable daily ceilings are derived from the largest legal queue: four
 * max-level Barracks, each holding 105 points, filled with one-point troops.
 * A wallet may activate five bases. These are successful-refund ceilings, not
 * request ceilings; exact idempotent replays do not consume them. The smaller
 * per-IP minute budget is only a Redis-backed abuse shield — PostgreSQL remains
 * authoritative when that secondary store is unavailable.
 */
const TRAINING_CANCEL_MAX_QUEUE_PTS = STRUCTURES.barracks.queuePts.at(-1)!;
const TRAINING_CANCEL_MAX_BARRACKS = BUILD_COUNT_CAP_BY_KEEP['barracks']!.at(-1)!;
const TRAINING_CANCEL_MIN_TROOP_PTS = Math.min(
  ...TROOP_TYPES.filter(isTrainableTroop).map((troop) => TROOPS[troop].pts),
);
const TRAINING_CANCEL_MAX_BASES = BASE_OWNERSHIP.maxActive;
const TRAINING_CANCEL_MAX_PER_BASE = (
  TRAINING_CANCEL_MAX_QUEUE_PTS * TRAINING_CANCEL_MAX_BARRACKS
) / TRAINING_CANCEL_MIN_TROOP_PTS;

export const TRAINING_CANCELLATION = {
  maxQueuePtsPerBarracks: TRAINING_CANCEL_MAX_QUEUE_PTS,
  maxBarracksPerBase: TRAINING_CANCEL_MAX_BARRACKS,
  minTrainableTroopPts: TRAINING_CANCEL_MIN_TROOP_PTS,
  maxBasesPerWallet: TRAINING_CANCEL_MAX_BASES,
  maxRefundsPerBaseUtcDay: TRAINING_CANCEL_MAX_PER_BASE,
  maxRefundsPerWalletUtcDay: TRAINING_CANCEL_MAX_PER_BASE * TRAINING_CANCEL_MAX_BASES,
  /** Cadence-derived (D-096): cancellation is tap-tap-tap with no dialog, one
   * serialized POST per tap, so one device can never exceed the client's own
   * hold floor (~5.5 taps/s ≈ 330/min) and a thumb through real round-trips
   * stays far under it. 300/min sits at that whole-minute ceiling so only a
   * script meets it, and it is not set tighter because carrier-NAT phones share
   * one IP. This is a request shield, not the budget: the durable 420/base/day
   * and 2,100/wallet/day ceilings above remain the authority. (Supersedes the
   * pre-D-096 "a confirmation flow cannot need thirty/min" justification.) */
  ipRateLimitPerMin: 300,
  ipRateLimitWindowMs: 60_000,
} as const;

/**
 * Refund-churn admission for cancelling a running building UPGRADE or troop
 * RESEARCH (tester request 2026-09-04: "if I accidentally start the wrong
 * upgrade/research … I have to wait until it finishes"). Same three layers as
 * TRAINING_CANCELLATION: durable per-base and per-wallet UTC-day ceilings on
 * SUCCESSFUL refunds (PostgreSQL, authoritative; exact idempotent replays do
 * not consume them) plus a per-IP minute shield (Redis, abuse only).
 *
 * The daily ceilings derive from the build caps the same way training's derive
 * from the largest legal queue: a base can run at most `buildersMax` upgrade
 * jobs (research: `concurrentResearch` lanes) at once, and a human who changes
 * their mind ONCE PER LANE PER HOUR all day long is already implausible — so
 * lanes × 24 is the successful-refund ceiling. A wallet may activate five bases.
 * Cancelling refunds the exact SHARD debit the job recorded when it started;
 * a SOL- or KEEP-paid start is never cancellable, so no ceiling exists for it.
 */
const CANCEL_LANE_REFUNDS_PER_HOUR = 1;
const CANCEL_HOURS_PER_UTC_DAY = 24;
const UPGRADE_CANCEL_MAX_PER_BASE = CAPS.buildersMax * CANCEL_LANE_REFUNDS_PER_HOUR * CANCEL_HOURS_PER_UTC_DAY;
const RESEARCH_CANCEL_MAX_PER_BASE = TROOP_LEVELING.concurrentResearch
  * CANCEL_LANE_REFUNDS_PER_HOUR * CANCEL_HOURS_PER_UTC_DAY;

export const UPGRADE_CANCELLATION = {
  maxLanesPerBase: CAPS.buildersMax,
  maxBasesPerWallet: BASE_OWNERSHIP.maxActive,
  maxRefundsPerBaseUtcDay: UPGRADE_CANCEL_MAX_PER_BASE,
  maxRefundsPerWalletUtcDay: UPGRADE_CANCEL_MAX_PER_BASE * BASE_OWNERSHIP.maxActive,
  /** A confirmation dialog stands in front of every upgrade cancellation (the
   * tester asked for one), so a human cannot honestly need thirty per minute —
   * the same justification the troop shield carried before D-096 removed its
   * dialog. Request shield only; the durable ceilings above are the budget. */
  ipRateLimitPerMin: 30,
  ipRateLimitWindowMs: 60_000,
} as const;

export const RESEARCH_CANCELLATION = {
  maxLanesPerBase: TROOP_LEVELING.concurrentResearch,
  maxBasesPerWallet: BASE_OWNERSHIP.maxActive,
  maxRefundsPerBaseUtcDay: RESEARCH_CANCEL_MAX_PER_BASE,
  maxRefundsPerWalletUtcDay: RESEARCH_CANCEL_MAX_PER_BASE * BASE_OWNERSHIP.maxActive,
  /** Dialog-gated like UPGRADE_CANCELLATION. */
  ipRateLimitPerMin: 30,
  ipRateLimitWindowMs: 60_000,
} as const;

// ---------------------------------------------------------------------------
// Raiding = ENERGY + a SHARD ante (ECONOMY.md §4, v3 + owner 2026-07-26).
// SUPERSEDES the old pay-per-raid KEEP ante: raiding never costs KEEP. Each PvP
// raid spends 1 raid-energy plus shards scaled by the attacker's Keep level
// (PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL). Every player regenerates freePerDay each
// UTC day; beyond that they BUY energy with SOL (never KEEP, never burned — the
// SOL is split 40/35/25 into sol_treasury). There is NO daily raid ceiling: the
// energy you hold and the shards you can afford are the only limits, so bought
// energy stockpiles. PvE (Ruined Keeps) costs neither (PVE.costsEnergy).
// ---------------------------------------------------------------------------

export const RAID_ENERGY = {
  /** Energy consumed by each PvP entry (ECONOMY.md §4); retreat does not refund it. */
  perRaid: 1,
  /** Regenerating free raid-energy per UTC day (owner 2026-07-26: 3 → 6). */
  freePerDay: 6,
  /** SOL price to buy 1 extra raid-energy: 0.03 SOL, split 40/35/25 into
   * sol_treasury, NEVER burned (ECONOMY.md §4). Owner 2026-07-26 dropped it
   * from 0.1 and added the pack below. */
  solLamportsPerEnergy: 30_000_000,
  /** Multi-buy (owner 2026-07-26, pricing settled same day): PER-UNIT pack
   * pricing — 0.015 SOL each × 6 = 0.09 SOL, a 50% bulk discount against the
   * 0.03 single. The literal reading of the original ask (6 for 0.015 TOTAL)
   * priced pack energy at 0.0025 — 12× under the single, which would kill the
   * single SKU and undercut the whole energy sink; owner delegated the call.
   * Wired as buy_sink kind 7 — an UNRESERVED kind the program routes through
   * unchanged (same no-program-change path as warzone_shield/kind 6). */
  packSize: 6,
  packLamports: 90_000_000, // 6 × 15_000_000 (0.015 SOL per energy)
} as const;

/**
 * Shards burned by the ATTACKER on every PvP raid (owner 2026-07-26: "each PvP
 * attack costs some shards based on your keep level"). This — not a daily cap —
 * is now the only throttle on attack volume, so it has to bite without making
 * raiding -EV: each entry is 10% of that level's loot CEILING
 * (LOOT.capPerAttackerKeepLevel × level), leaving a raid strongly net-positive
 * against a worthwhile target. PvE never pays it (PVE.costsEnergy). ⚠ ALPHA
 * PLACEHOLDER — owner tunes.
 */
export const PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL: readonly number[] = [
  100,   200,   300,   400,   500,    // L1–5
  600,   700,   800,   900,   1_000,  // L6–10
  1_100, 1_200, 1_300, 1_400, 1_500,  // L11–15
  1_600, 1_700, 1_800, 1_900, 2_000,  // L16–20
];

/** Shard cost of one PvP attack at a Keep level, clamped to the table. */
export function pvpAttackShardCostForKeepLevel(keepLevel: number): number {
  const i = Math.min(Math.max(keepLevel, 1), PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL.length) - 1;
  return PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL[i]!;
}

// ---------------------------------------------------------------------------
// Shield — GDD §3.3 + ECONOMY.md §4a (✅ LOCKED v3). A successful raid auto-
// shields the DEFENDER for hoursOnLoss. Shields are bought/extended with SOL
// ONLY (never KEEP; the SOL is split, not burned). Attacking drops the shield.
// ---------------------------------------------------------------------------

export const SHIELD = {
  /** Owner 2026-08-12: any successful raid grants the defender 48 hours. */
  hoursOnLoss: 48,
  /** Paid extension length (SOL-priced). */
  extendHours: 12,
  /** SOL cost to extend a shield: debited player_sol_credit → sol_treasury,
   * NEVER burned (ECONOMY.md §4a). Alpha placeholder amount (no GDD SOL price
   * for shields; the old 50-KEEP path is removed in v3). */
  extendCostSolLamports: 50_000_000, // 0.05 SOL
  /** Protection may never extend beyond 48 hours. */
  maxHours: 48,
  /** A +12h purchase is legal only after protection falls to this threshold. */
  extendPurchaseMaxRemainingHours: 36,
  /** A zero-star defense is not a loss and grants no automatic shield. */
  requiresAttackerVictory: true,
  /** Shield breaks the moment you attack another player (PvE never breaks it). */
  breaksOnAttack: true,
} as const;

/** Permanent deed battle-history paging. Records are never retention-pruned;
 * these limits only bound one authenticated response. Owner 2026-08-12. */
export const BATTLE_HISTORY = {
  defaultPageSize: 20,
  maxPageSize: 50,
  cursorVersion: 1,
  replayFormatVersion: 1,
  replayCodec: 'br-json-v1',
  /** Brotli quality 5 is the balanced, bounded-cost Node setting for live raid
   * settlement; higher archival qualities add CPU without changing truth. */
  replayCompressionQuality: 5,
  /** Newest defences carried on GET /base for the HUD's RAIDED chip and its
   * base-load toast (D-099, owner 2026-09-02: "no notification that you have
   * been raided"). A count, not a page: the raid log stays the paged record. */
  hudRecentDefences: 5,
} as const;

// ---------------------------------------------------------------------------
// Battle buffs & Rally — GDD §3.5 (+§14 prices). CONFLICT: the App shop tab
// shows War Horn 60 / "Powder ×3 45"; GDD §3.5/§14 (40/30/35) is canonical.
// ---------------------------------------------------------------------------

export const BUFFS = {
  warhorn:      { costKeep: 40, troopDamageMult: 1.15 },
  swiftboots:   { costKeep: 30, troopSpeedMult: 1.2 },
  /** Turns a Keg Runner into a t3-wall one-shot (GDD §3.5). */
  powdercharge: { costKeep: 35, wallDamageMult: 1.6 },
  /** Up to one of each per raid, consumed on use (GDD §3.5). */
  maxOfEachPerRaid: 1,
} as const;

export const RALLY = {
  unlockKeepLevel: 3,
  durationSec: 5,
  /** +25% speed AND damage in the pulse radius (GDD §3.5). */
  speedAndDamageMult: 1.25,
  /** Radius locked to the overlay ring asset r2.5 (GDD §14). */
  radiusTiles: 2.5,
  usesPerRaid: 1,
  costKeep: 0, // free — the skill ceiling is WHEN you pop it
} as const;

// ---------------------------------------------------------------------------
// Loot & trophies — GDD §3.3
// ---------------------------------------------------------------------------

export const LOOT = {
  /** Frozen with every private deed-loot reservation and battle record.
   *  v1 = star slice + destroyed-Vault slice; v2 (D-065, owner 2026-08-21) =
   *  Vault LEVEL protection. Settlement branches on the reservation's version. */
  formulaVersion: 2,
  /** @deprecated Legacy settlement compatibility; D-035 uses balanceLootableBps. */
  surplusFraction: 0.1,
  /** @deprecated Legacy globe/settlement compatibility; new loot is defender-deed based. */
  capPerAttackerKeepLevel: 1_000,
  /** @deprecated Legacy binary Vault bonus; formula A uses vaultSliceBps. */
  vaultDestroyedBonusFraction: 0.05,
  /** Deed-local SIM9 raid loot. Integer basis points avoid settlement drift.
   *  Up to this share of the deed's liquid + open-Forge shards can be taken. */
  balanceLootableBps: 5_000,
  starPayoutBps: [0, 2_500, 5_000, 10_000] as const,
  /** @deprecated formula v1 only (reservations frozen before D-065). */
  starSliceBps: 7_500,
  /** @deprecated formula v1 only (reservations frozen before D-065). */
  vaultSliceBps: 2_500,
  /** D-065 (owner 2026-08-21: "during raid 50% of your shards can be taken so
   *  vault should be able to reduce that 30% based on level of vault"): the
   *  highest STANDING Vault shields up to 30 percentage points of the 50%
   *  lootable share, linearly by level over STRUCTURES.vault.maxLevel —
   *  L1 protects 1.5 points (48.5% lootable), L20 protects 30 (20% lootable).
   *  A Vault destroyed in the raid protects nothing. Replaces the v1
   *  destroyed-Vault slice; Mine buffers are unchanged. */
  vaultProtectionMaxBps: 3_000,
  mineBuffersPaidOnlyWhenDestroyed: true,
  /** Public globe previews round the combined maximum loot into half-decade
   * buckets, never exposing either private source or an exact deed balance. */
  previewMinimumBucketShards: 100,
  previewBucketsPerDecade: 2,
} as const;

export const TROPHIES = {
  /** Attacker gain for 1★/2★/3★; defender mirrors; both Elo-damped by gap. */
  winByStars: [8, 12, 16],
  /** 0★ fail. */
  zeroStarLoss: -10,
  /** ALPHA PLACEHOLDER damp curve (GDD §3.3 says "Elo-damped by the trophy
   * gap" with no formula): factor_bps = clamp(10000 − gap×dampBpsPerTrophy,
   * minFactorBps, maxFactorBps), gap = attacker − defender trophies. */
  dampBpsPerTrophy: 10,
  minFactorBps: 5_000,
  maxFactorBps: 15_000,
  /** On a 0★ loss the damp INVERTS (a favored attacker who whiffs loses more):
   * loss = zeroStarLoss × (lossInversionBps − factor) / 10000. 20000 = 2×BPS_ONE
   * mirrors `factor` around 1.0. Part of the ALPHA-PLACEHOLDER damp curve. */
  lossInversionBps: 20_000,
} as const;

/**
 * Base AMBIENCE — the townsfolk and life in your own base (owner 2026-07-26: "I
 * want the base to look alive … it should be alive to hook players to love their
 * bases"). Pure presentation: the sim never sees any of this, and none of it is
 * interactive. Numbers live here per the constants rule so the feel is tunable in
 * one place. ⚠ ALPHA — owner tunes.
 */
/**
 * WORLD_DEPTH — the ONE draw-order contract for every world sprite, in the base
 * scene, the battle scene and the deed renderer alike.
 *
 * IT EXISTS BECAUSE ONE SHARED AXIS CANNOT EXPRESS THE RULE (owner 2026-08-30:
 * "defences and building should not be rendered top of troops, troops should be
 * on layer above … walls should overflow buildings not buildings, and troops
 * should overflow other buildings defences and walls").
 *
 * Until this, EVERY world sprite sorted on screen-Y alone: a building took its
 * footprint's south edge, a walker took its feet. Those are the same number when
 * a troop stands in a doorway, and strictly worse when the troop stands one row
 * NORTH of a tall building's base line — there the building legitimately won and
 * swallowed the troop whole. `AMBIENCE.walkerDepthBias` (+3, retired with this
 * block) was a patch on the tie alone and could never fix the ordering.
 *
 * The fix is a BAND per layer, Y-sorted INSIDE the band. Structures need one
 * additional tie lane: walls and buildings share painter order, because a wall
 * is allowed to cover a building only when its footprint is farther south.
 *
 *     actors:     depth = band + groundY
 *     structures: depth = band + groundY * 8 + kindTie
 *                  // groundY = footprint south edge, or actor feet
 *
 *   ground   0        grass, scorch, the deploy wash — painted under everything
 *   structure 100_000 buildings, defences, obstacles, scaffolds and walls
 *   actor    300_000  troops, heroes, villagers, builders, garrisons
 *   overlay  400_000  UI ON the world: HP bars, damage numbers, projectiles,
 *                     timer chips, the drag ghost, selection rings
 *
 * The stride is 100_000 world px: the largest field any scene builds is the
 * battle's plot + deploy margin (~2.5k px) plus a decor skirt, so no band can
 * ever reach into the next one. Y-sorting still works normally within a band —
 * a troop lower on screen still overlaps a troop higher up.
 *
 * ⚠ Every world `setDepth` must go through `worldDepth` or `structureDepth`.
 * A bare number is how the piecemeal rules got here in the first place.
 */
export const WORLD_DEPTH = {
  ground: 0,
  structure: 100_000,
  /** Compatibility aliases. Structure callers must use `structureDepth` so
   * their wall/building equal-Y tie is explicit. */
  building: 100_000,
  wall: 100_000,
  actor: 300_000,
  overlay: 400_000,
} as const;

/** Integer sub-lanes inside the structure band. Multiplying ground Y leaves
 * room for body-attached fire/damage layers (+1..+3). A one-pixel-southern
 * structure still outranks every tie offset; at equal Y the building wins. */
export const STRUCTURE_DEPTH = {
  groundYScale: 8,
  wallTie: 0,
  buildingTie: 4,
} as const;

export type StructureDepthKind = 'wall' | 'building';

export function structureDepth(kind: StructureDepthKind, groundY: number): number {
  return WORLD_DEPTH.structure
    + groundY * STRUCTURE_DEPTH.groundYScale
    + (kind === 'wall' ? STRUCTURE_DEPTH.wallTie : STRUCTURE_DEPTH.buildingTie);
}

/** `band + groundY` — see WORLD_DEPTH. groundY is the sprite's contact line with
 *  the ground: a building's footprint south edge, an actor's feet. */
export function worldDepth(band: number, groundY: number): number {
  return band + groundY;
}

/**
 * ═══════════ THE ACTOR HALF OF THE SIZE CONTRACT — one size, both scenes ════
 *
 * An actor family has ONE drawn size, and it is the same size on the base and
 * in a raid. Owner 2026-08-30: "raids must hold the same correspondence".
 *
 * THIS IS A DELIBERATE DECISION TO DELETE A MULTIPLIER, so here is the case.
 * A building carries no battle factor at all — `wareSeat` and `v2BldSeat` hand
 * the base view and the raid the identical product (verified: every family
 * measures the same world px in both scenes). So ANY actor-only battle factor
 * is, by definition, a change in the troop-to-building correspondence between
 * the two scenes. The shipped numbers were `troop 0.8` against a base garrison
 * of 0.66 and `hero 1.6` against a base patrol of 1.05 — a troop grew 1.21× and
 * a hero grew 1.52× on entering a raid, WHILE THE BUILDINGS AROUND THEM DID
 * NOT. That is precisely why the base ladder did not survive combat, and it is
 * why two actors broke the Keep ceiling in raids and only in raids: measured,
 * Theodor drew 137.6×160 world px against a 146×154 Keep at L20 and a 101×107
 * Keep at L1, and the Direwyvern drew 112.1 tall against that same 107.5.
 *
 * WHY THE BASE NUMBERS ARE THE SURVIVORS, not the battle ones. `troop` (0.66)
 * and `hero` (1.05) are the ends of explicit owner tuning series — 0.72 "too
 * big" → 0.18 "too small" → 0.3 "still too small" → 0.66, and 1.35 "too big" →
 * 0.34 "very small" → 0.55 "still too small" → 1.05 — and every published
 * `ART_V2.troopSourceScale` was then derived against THAT ladder. The battle
 * pair has no such derivation: it dates from 2026-07-28, when BATTLE_SCALE was
 * the only actor lever a raid had and therefore had to carry the whole
 * correction by itself. Now that each root publishes a fit, a second raid-only
 * factor is that same correction applied twice.
 *
 * The 2026-07-28 report ("heroes should be bigger but not too big and troops
 * should be smaller") is not being overturned — it is being honoured once
 * instead of twice: a hero still reads ~1.6× a rank-and-file body, because that
 * relationship lives HERE, in the ratio between these two numbers, and it is
 * now the same relationship in both scenes.
 *
 * `BATTLE_SCALE` and `AMBIENCE.{garrisonScale,heroPatrolScale}` are kept as
 * NAMES because a hundred call sites and tests read them, but they are views on
 * this one table, never independent numbers. Two names that must agree is how
 * the correspondence broke the first time.
 *
 * Render-only: the sim's hitboxes and ranges are unit-space and unaffected.
 */
export const ACTOR_WORLD_SCALE = {
  /** The rank-and-file body — the unit the whole actor ladder is measured in. */
  troop: 0.66,
  /**
   * A hero. 1.05/0.66 = 1.59× a rank-and-file body, which is the "heroic, not
   * giant" relationship BATTLE_SCALE was originally written to express.
   */
  hero: 1.05,
  /**
   * A townsfolk. 0.56/0.66 = 0.85 of a soldier.
   *
   * IT WAS 0.72 — LARGER THAN A SOLDIER — while its own comment said the
   * opposite. The number was tuned when villagers rode legacy @2x masters and
   * troops rode a different product; once `v2FallbackSpec` put both families on
   * the identical `v2TroopDrawScale` product (villagers are re-tinted
   * plunderer/bowman/highlander bodies), 0.72 against the garrison's 0.66 drew
   * every townsfolk 9% BIGGER than the guard walking beside them. 0.56 restores
   * the ~35 world px townsfolk beside a ~42 px soldier that the villager
   * comment has always described.
   */
  villager: 0.56,
} as const;

/** Battle-scene unit presentation — a VIEW on ACTOR_WORLD_SCALE, never its own
 *  numbers. See the block above for why a raid applies no enlargement. */
export const BATTLE_SCALE = {
  troop: ACTOR_WORLD_SCALE.troop,
  hero: ACTOR_WORLD_SCALE.hero,
} as const;

/** Existing web battle body presentation, exported to native without changing
 * combat timing or health. Dragon Nest spawn is its visual firing cue. */
export const BATTLE_BODY_PRESENTATION = {
  dragonNestWorkMs: 500,
  damagedTroopHealthRatio: 0.5,
} as const;

export const AMBIENCE = {
  /** Owner feedback 2026-09-12: base building loops should be a little slower.
   * Cosmetic idle/work/damaged playback only; combat and one-shots stay authored. */
  baseBuildingLoopSpeed: 0.75,
  /** Townsfolk at Keep L1, and one more per this many Keep levels — so upgrading
   *  the Keep visibly REPOPULATES the town. That reward loop is the actual hook;
   *  random wanderers get tuned out within a session. */
  villagersAtKeepL1: 2,
  villagerPerKeepLevels: 2,
  /** Hard cap: past this the town reads as a crowd, and the per-frame cost stops
   *  being free. Also bounds the pooled sprite count. */
  villagersMax: 12,
  /** Villagers render smaller than soldiers so they read as civilians even while
   *  they are re-tinted troop sprites (see docs/COMBAT-UX-PLAN.md G6).
   *  A VIEW on ACTOR_WORLD_SCALE.villager — see that block for why the literal
   *  0.72 that used to live here drew a townsfolk LARGER than the guard beside
   *  them, which is the opposite of what this comment has always promised. */
  villagerScale: ACTOR_WORLD_SCALE.villager,
  /** Builder Workman (owner 2026-09-10): authored 1×, shared 84px cells with
   * 58px body ink. At the world's T/32 scale, 0.275 gives ~32 world pixels,
   * below the troops. This civilian has no troop downsample or Keep-tier fit. */
  builderScale: 0.275,
  /** Owner 2026-09-10: six game pixels between the Workman's foot anchor and
   * scaffold edge, so the scaled hammer reaches the site (12 world px at T=64). */
  builderSiteGapPx: 6,
  /** Stroll speed in world px/sec (1 tile = 64), and the idle pause at each stop. */
  villagerSpeedPxPerSec: 24,
  villagerPauseMinMs: 800,
  villagerPauseMaxMs: 2_800,
  /** Chance a villager's next trip heads OUT of town — to a tree, a rock, or the
   *  outskirts — instead of to another building door (owner 2026-07-26: "villagers
   *  also should move outside city to trees and etc"). Kept a minority so the town
   *  still reads as the busy part; too high and everyone drifts into the woods. */
  villagerOutdoorTripPct: 30,
  /** How far beyond the claim edge the outskirt waypoints sit, in tiles. Close
   *  enough to stay on camera at normal zoom — the skirt treeline is ~10 tiles out
   *  and a trip there would be mostly invisible. */
  villagerOutskirtTiles: 3,
  /** Idle vignette (G1e): when a villager stops within this radius (world px) of
   *  another ALREADY-stopped villager, the pair turn to face each other and hold
   *  for a chat. Two townsfolk who stop near each other and ignore each other is
   *  what makes a crowd read as a screensaver; this is the cheapest fix that
   *  makes them read as PEOPLE. ~1.5 tiles — close enough to be legibly "together". */
  villagerChatRadiusPx: 96,
  villagerChatMinMs: 2_000,
  villagerChatMaxMs: 5_000,
  /** RETIRED 2026-08-30 with WORLD_DEPTH: `walkerDepthBias: 3` lifted a walker
   *  just past the building sprite (yB), its ambience copy (yB+1) and the altar
   *  pulse (yB+2) that tied with its feet in a doorway. It only ever fixed the
   *  TIE — a troop one row north of a tall building's base line still lost. The
   *  actor band is above the whole building band at every Y, so there is nothing
   *  left for a bias to break. Do not reintroduce it: a per-walker nudge is how
   *  a layer rule becomes six different rules again. */
  /** Camp garrison presentation (owner 2026-07-28: "camp garrison troops are too
   *  big" on the home base; follow-up same day: "make them 3 or 5 times smaller,
   *  covering a lot of space" — troop masters are far larger than villager
   *  masters, so a villager-sized FACTOR still drew giant sprites. 0.72/4).
   *  Scale 1.0 == the @2x master drawn 1:1 against the 64px tile, so a rank-and-
   *  file troop at 1.0 is a whole tile tall. Owner tuning series 2026-07-28:
   *  0.72 "too big" -> 0.18 "too small" -> 0.3 "still too small" (twice). 0.66
   *  is the window those three answers leave: 2.2x the last "too small" and a
   *  notch under the "too big" mark. Verified on the live base at zoom 1 — a
   *  highlander stands ~43px against the 64px tile, reading as a soldier on the
   *  ground next to a ~35px townsfolk. NOTE the "covering a lot of space" half
   *  of that complaint was the SWARM (every camp drew the whole army), fixed in
   *  patrol.ts by dealing the roster across camps — not by shrinking sprites.
   *  2026-08-30: unchanged, and it did not need to change — the reworked art
   *  arrives here through ART_V2.troopSourceScale and lands a v2 highlander at
   *  ~42 world px, i.e. back on the very ladder this number was tuned to. What
   *  had drifted was the pack fit, not the garrison scale.
   *  2026-08-30 (size contract): the literal 0.66 became a VIEW on
   *  ACTOR_WORLD_SCALE.troop, which BATTLE_SCALE.troop now reads too — a troop
   *  is one size in both scenes. See that block. */
  garrisonScale: ACTOR_WORLD_SCALE.troop,
  /** Garrison wander (owner 2026-07-28: "garrison troops should move"): each unit
   *  strolls between points on a ring just outside its camp's footprint, pausing
   *  at each. Slower than townsfolk and pausing longer — guards amble, they do
   *  not run errands. Cap = the old fixed-spot count (#56). */
  garrisonMaxPerCamp: 6,
  garrisonSpeedPxPerSec: 20,
  garrisonWanderPadTiles: 0.4,
  /** Pauses shortened (owner 2026-07-28 "they should be moving"): at 1.2–4.0 s a
   *  guard was standing far more often than walking, which reads as frozen. */
  garrisonPauseMinMs: 700,
  garrisonPauseMaxMs: 2_400,
  /** Hero patrol (owner 2026-07-28: "the hero should patrol the base"): the hero
   *  walks the loop of building doors, idles at stops, and occasionally returns
   *  to the altar dais. Brisker than townsfolk, and clearly larger than a
   *  garrison unit — the owner tuning series (2026-07-28): 1.35 "too big" →
   *  0.34 "very small" → 0.55 "still too small" (twice) → 1.05, which is ~1.6
   *  tiles tall: verified on the live base at zoom 1, Theodor stands ~109px, a
   *  clear 2.2x the garrison and half the barracks' height — heroic, and still
   *  well under the 1.35 the owner called too big.
   *  DELIBERATELY UNTOUCHED on 2026-08-30 ("heroes are not wired"): the heroes
   *  were spawning, patrolling and animating the whole time — what was wrong is
   *  that they did not DOMINATE, because the troops beside them had never been
   *  fitted. Sizing the troops is the fix; retuning an owner-verified hero
   *  number on top of it would be tuning twice. Theodor now reads ~2.6x the
   *  garrison rather than 2.2x.
   *  2026-08-30 (size contract): the literal 1.05 became a VIEW on
   *  ACTOR_WORLD_SCALE.hero, which BATTLE_SCALE.hero now reads too — the hero
   *  no longer grows by half again on entering a raid, where he was out-topping
   *  even a fully upgraded Keep. See that block. */
  heroPatrolScale: ACTOR_WORLD_SCALE.hero,
  heroPatrolSpeedPxPerSec: 34,
  heroPatrolPauseMinMs: 900,
  heroPatrolPauseMaxMs: 2_600,
  /** Shortest hero leg, in tiles: the patrol skips forward past doors closer than
   *  this, so every leg is a visible walk rather than a twitch between pauses. */
  heroPatrolMinLegTiles: 3,
  /** Dropped from 30 (owner 2026-07-28 "the hero is frozen on the dais"): at 30%
   *  with the old always-roll, a third of all legs ended back home. */
  heroAltarReturnPct: 10,
  /** Walker collision (owner 2026-07-29: "troops and heroes on base moving under
   *  buildings and walls … they should just avoid overflowing on building").
   *  Villagers, garrison troops and the hero never enter a tile occupied by a
   *  building, a wall or an obstacle (apps/web/src/game/world/occupancy.ts).
   *  How far a waypoint that landed ON a footprint may be pushed to reach free
   *  ground, in tiles, before it is dropped from the stop list — 3 clears any
   *  single building (max footprint 3×3) plus its wall. */
  walkerDetourSearchTiles: 3,
  /** How many destinations a walker may try before standing a beat and
   *  re-rolling. Routing is complete (it finds a path whenever one exists), so
   *  a miss means the destination is genuinely walled off — on a sealed base
   *  most of the town is, and standing a beat is the honest answer. Bounds the
   *  work per retarget: each try is one path search. */
  walkerRouteRetries: 6,
  /** Ambient work bed (G4a): a soft hammer strike repeats while any builder job
   *  runs — the base SOUNDS busy exactly when it IS busy. One-shots on a beat,
   *  never a loop, so the stopAllLoops() discipline is moot by construction; the
   *  beat rides the scene update, so sleeping the scene (battle) silences it for
   *  free. Jitter keeps it from reading as a metronome. Volume sits well under
   *  gameplay SFX — it is a texture, not an event. */
  hammerPeriodMs: 3_200,
  hammerJitterMs: 1_100,
  hammerVolume: 0.16,
} as const;

export type CampaignProfile = 'OUTPOST' | 'BREACH' | 'FORTRESS';
export type CampaignThreat = 'standard' | 'mini_boss' | 'boss';
export type CampaignTheme = 'coast' | 'marsh' | 'ash' | 'gloam' | 'wastes';
export type CampaignDefenseType = Exclude<DefenseType, 'spiketrap'>;

export interface CampaignEncounter {
  stage: number;
  keepLevel: number;
  name: string;
  theme: CampaignTheme;
  tactic: string;
  profile: CampaignProfile;
  threat: CampaignThreat;
  /** Local position on the reusable ten-node act board. */
  c: number;
  r: number;
  /** Rotates the authored approach/gap and placement tie-breaks. */
  formation: 0 | 1 | 2 | 3;
  defenseLevel: number;
  wallRings: number;
  traps: number;
  mines: number;
  defenses: Partial<Record<CampaignDefenseType, number>>;
  defenderHero?: { hero: 'vex' | 'theodor'; level: number };
}

/**
 * One hundred authored campaign encounters — the DENSE redesign (owner
 * 2026-08-16: "I asked for better complex more challenging bases in campaign
 * and got 100 rubbish easy battles", after the stage-62 screenshot showed a
 * sparse, thinly-walled cluster; supersedes the M23 a2 thin-ring rows). These
 * rows are gameplay data, not UI aliases: makeCampaignSnapshot consumes the
 * exact roster, formation, wall, trap and hero contract below (D-030, owner
 * directive 2026-08-12 — an explicit table so no generator can silently emit
 * filler or duplicate stages).
 *
 * Density contract (pinned by apps/api campaign tests): inside every 5-stage
 * Keep band, band position p fields ceil(cap x num[p]/12) of EVERY defense
 * type / trap / mine cap its Keep has unlocked, where num =
 * CAMPAIGN_LAYOUT.densityNumeratorByBandPosition — so an OUTPOST opens at 2/3
 * strength and the FORTRESS exam fields the FULL BUILD_COUNT_CAP_BY_KEEP
 * complement (the owner ceiling: "use build counts as the ceiling").
 * defenseLevel = keep - lag by band position; wallRings is the structural
 * tier of CAMPAIGN_LAYOUT (1 ring / 2 compartments / 3 double wall). Band
 * shape stays OUTPOST, OUTPOST, BREACH, BREACH, FORTRESS; each act carries a
 * mini-boss at its midpoint and a hero-garrisoned boss finale (bosses
 * alternate vex/theodor at keep-2; from act 6 the mini-boss fields the act's
 * OFF hero at keep-4, so late acts are hero-garrisoned twice).
 */
export const CAMPAIGN_ENCOUNTERS: readonly CampaignEncounter[] = [
  // Stage 1 is the ONE authored density exception: the tutorial opener drops
  // its archer so a fresh player's first four L1 turriders 3★ it with seed
  // margin (world.test.ts pins that win) — its tactic is literally the lane.
  { stage: 1, keepLevel: 1, name: 'DRIFTWOOD CAMP', theme: 'coast', tactic: 'single cannon lane', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 1, wallRings: 0, traps: 2, mines: 1, defenses: { cannon: 1 } },
  { stage: 2, keepLevel: 1, name: 'SALT FLATS', theme: 'coast', tactic: 'archer on the dunes', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 1, wallRings: 0, traps: 2, mines: 1, defenses: { cannon: 1, archertower: 1 } },
  { stage: 3, keepLevel: 1, name: 'BROKEN JETTY', theme: 'coast', tactic: 'gap in the pilings', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 1, wallRings: 0, traps: 2, mines: 1, defenses: { cannon: 1, archertower: 1 } },
  { stage: 4, keepLevel: 1, name: 'GULL ROCK', theme: 'coast', tactic: 'crossfire at the shallows', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 1, wallRings: 0, traps: 2, mines: 1, defenses: { cannon: 1, archertower: 1 } },
  { stage: 5, keepLevel: 1, name: 'SMUGGLER HOLE', theme: 'coast', tactic: 'sealed smuggler ring', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 1, wallRings: 0, traps: 2, mines: 2, defenses: { cannon: 1, archertower: 1 } },

  { stage: 6, keepLevel: 2, name: 'BRINEWATCH STOCKADE', theme: 'coast', tactic: 'stockade cannon post', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 1, wallRings: 1, traps: 3, mines: 2, defenses: { cannon: 1, archertower: 1 } },
  { stage: 7, keepLevel: 2, name: "WRECKERS' ROW", theme: 'coast', tactic: 'archers over the wrecks', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 1, wallRings: 1, traps: 3, mines: 2, defenses: { cannon: 1, archertower: 1 } },
  { stage: 8, keepLevel: 2, name: 'REEDHOOK LANDING', theme: 'coast', tactic: 'breach at the reedline', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 1, wallRings: 1, traps: 4, mines: 2, defenses: { cannon: 1, archertower: 1 } },
  { stage: 9, keepLevel: 2, name: "CORSAIR'S CUT", theme: 'coast', tactic: 'false landing channel', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 1, wallRings: 1, traps: 4, mines: 2, defenses: { cannon: 1, archertower: 1 } },
  { stage: 10, keepLevel: 2, name: 'THE TIDE FORT', theme: 'coast', tactic: 'Vex at the seawall', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 2, wallRings: 1, traps: 4, mines: 3, defenses: { cannon: 1, archertower: 1 }, defenderHero: { hero: 'vex', level: 1 } },

  { stage: 11, keepLevel: 3, name: 'REEDMOOR', theme: 'marsh', tactic: 'cannon in the reeds', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 1, wallRings: 1, traps: 4, mines: 2, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 12, keepLevel: 3, name: 'HANGING BOG', theme: 'marsh', tactic: 'archers over the mire', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 1, wallRings: 1, traps: 5, mines: 3, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 13, keepLevel: 3, name: 'WOODCUTTER ROW', theme: 'marsh', tactic: 'timber-gap breach', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 2, wallRings: 1, traps: 5, mines: 3, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 14, keepLevel: 3, name: 'CROOKED MILL', theme: 'marsh', tactic: 'millrace mortar gate', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 2, wallRings: 1, traps: 6, mines: 3, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 15, keepLevel: 3, name: 'FENLIGHT CROSSING', theme: 'marsh', tactic: 'sealed fenlight ring', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 3, wallRings: 1, traps: 6, mines: 4, defenses: { cannon: 2, archertower: 2, mortar: 1 } },

  { stage: 16, keepLevel: 4, name: 'ROOTBOUND WARD', theme: 'marsh', tactic: 'arched root lane', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 2, wallRings: 1, traps: 6, mines: 3, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 17, keepLevel: 4, name: 'WITCHWATER FORD', theme: 'marsh', tactic: 'mortar bait channel', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 2, wallRings: 1, traps: 6, mines: 3, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 18, keepLevel: 4, name: 'MOSS-CROWN REDOUBT', theme: 'marsh', tactic: 'moss-wall breach', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 3, wallRings: 1, traps: 7, mines: 4, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 19, keepLevel: 4, name: 'SUNK BELL ABBEY', theme: 'marsh', tactic: 'bell-tower crossfire', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 3, wallRings: 1, traps: 8, mines: 4, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 20, keepLevel: 4, name: 'WARDEN KEEP', theme: 'marsh', tactic: 'Theodor holds the bog', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 4, wallRings: 1, traps: 8, mines: 5, defenses: { cannon: 2, archertower: 2, mortar: 1 }, defenderHero: { hero: 'theodor', level: 2 } },

  { stage: 21, keepLevel: 5, name: 'CINDER ROAD', theme: 'ash', tactic: 'cinder lane cannon', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 3, wallRings: 1, traps: 7, mines: 4, defenses: { cannon: 2, archertower: 2, mortar: 1 } },
  { stage: 22, keepLevel: 5, name: 'SLAG PITS', theme: 'ash', tactic: 'split slag approach', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 3, wallRings: 1, traps: 8, mines: 4, defenses: { cannon: 3, archertower: 3, mortar: 1 } },
  { stage: 23, keepLevel: 5, name: 'THE BLACK GATE', theme: 'ash', tactic: 'black iron breach', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 4, wallRings: 1, traps: 9, mines: 5, defenses: { cannon: 3, archertower: 3, mortar: 1 } },
  { stage: 24, keepLevel: 5, name: 'EMBER HOLLOW', theme: 'ash', tactic: 'mortar behind embers', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 4, wallRings: 1, traps: 10, mines: 5, defenses: { cannon: 3, archertower: 3, mortar: 1 } },
  { stage: 25, keepLevel: 5, name: 'CHARBONE YARD', theme: 'ash', tactic: 'charbone kill ring', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 5, wallRings: 1, traps: 10, mines: 6, defenses: { cannon: 3, archertower: 3, mortar: 1 } },

  { stage: 26, keepLevel: 6, name: 'ASHFALL SPIRE', theme: 'ash', tactic: 'spire-shadow lane', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 4, wallRings: 1, traps: 8, mines: 4, defenses: { cannon: 2, archertower: 2, mortar: 2 } },
  { stage: 27, keepLevel: 6, name: 'FURNACE CAUSEWAY', theme: 'ash', tactic: 'furnace flank guns', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 4, wallRings: 1, traps: 9, mines: 5, defenses: { cannon: 3, archertower: 3, mortar: 2 } },
  { stage: 28, keepLevel: 6, name: 'GLASSWIND CAMP', theme: 'ash', tactic: 'crosswind kill box', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 5, wallRings: 1, traps: 10, mines: 5, defenses: { cannon: 3, archertower: 3, mortar: 2 } },
  { stage: 29, keepLevel: 6, name: 'MOLTEN CROWN', theme: 'ash', tactic: 'molten double gate', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 5, wallRings: 1, traps: 11, mines: 6, defenses: { cannon: 3, archertower: 3, mortar: 2 } },
  { stage: 30, keepLevel: 6, name: 'THE CINDER REGENT', theme: 'ash', tactic: 'Vex on the kiln throne', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 6, wallRings: 1, traps: 12, mines: 7, defenses: { cannon: 3, archertower: 3, mortar: 2 }, defenderHero: { hero: 'vex', level: 4 } },

  { stage: 31, keepLevel: 7, name: 'MOONLESS FORD', theme: 'gloam', tactic: 'mortar-lit ford', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 5, wallRings: 1, traps: 10, mines: 5, defenses: { cannon: 3, archertower: 3, mortar: 2, airdefence: 1 } },
  { stage: 32, keepLevel: 7, name: 'WOLFPINE CROSSING', theme: 'gloam', tactic: 'pine-shadow lane', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 5, wallRings: 1, traps: 11, mines: 6, defenses: { cannon: 3, archertower: 3, mortar: 2, airdefence: 1 } },
  { stage: 33, keepLevel: 7, name: "MOURNERS' TRACK", theme: 'gloam', tactic: 'mourning gate breach', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 6, wallRings: 1, traps: 12, mines: 6, defenses: { cannon: 4, archertower: 4, mortar: 2, airdefence: 1 } },
  { stage: 34, keepLevel: 7, name: 'GLOAMFEN CAMP', theme: 'gloam', tactic: 'fen mortar pocket', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 6, wallRings: 1, traps: 13, mines: 7, defenses: { cannon: 4, archertower: 4, mortar: 2, airdefence: 1 } },
  { stage: 35, keepLevel: 7, name: 'DIREFANG DEN', theme: 'gloam', tactic: 'first flak over the den', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 7, wallRings: 1, traps: 14, mines: 8, defenses: { cannon: 4, archertower: 4, mortar: 2, airdefence: 1 } },

  { stage: 36, keepLevel: 8, name: 'WITCHFIRE CAUSEWAY', theme: 'gloam', tactic: 'witchfire tower arc', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 6, wallRings: 1, traps: 11, mines: 5, defenses: { cannon: 3, archertower: 3, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 37, keepLevel: 8, name: 'SHROUDED SPIRE', theme: 'gloam', tactic: 'shrouded battery', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 6, wallRings: 1, traps: 12, mines: 6, defenses: { cannon: 3, archertower: 3, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 38, keepLevel: 8, name: 'THE LONG HOWL', theme: 'gloam', tactic: 'howling eastern breach', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 7, wallRings: 1, traps: 14, mines: 6, defenses: { cannon: 4, archertower: 4, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 39, keepLevel: 8, name: 'BLACKROOT HOLLOW', theme: 'gloam', tactic: 'charged blackroot gap', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 7, wallRings: 1, traps: 15, mines: 7, defenses: { cannon: 4, archertower: 4, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 40, keepLevel: 8, name: "GLOAMFANG'S COURT", theme: 'gloam', tactic: 'Theodor in moonshadow', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 8, wallRings: 1, traps: 16, mines: 8, defenses: { cannon: 4, archertower: 4, mortar: 2, airdefence: 1, electrictower: 1 }, defenderHero: { hero: 'theodor', level: 6 } },

  { stage: 41, keepLevel: 9, name: 'SHARDWIND VERGE', theme: 'wastes', tactic: 'shardwind battery', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 8, wallRings: 2, traps: 15, mines: 6, defenses: { cannon: 5, archertower: 5, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 42, keepLevel: 9, name: 'BROKEN PRISM', theme: 'wastes', tactic: 'prismatic gun line', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 8, wallRings: 2, traps: 17, mines: 7, defenses: { cannon: 5, archertower: 5, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 43, keepLevel: 9, name: 'NINEFOLD SCAR', theme: 'wastes', tactic: 'ninefold breach', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 8, wallRings: 2, traps: 17, mines: 7, defenses: { cannon: 5, archertower: 5, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 44, keepLevel: 9, name: 'STARVED QUARRY', theme: 'wastes', tactic: 'quarry shelf gate', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 9, wallRings: 2, traps: 18, mines: 8, defenses: { cannon: 5, archertower: 5, mortar: 2, airdefence: 1, electrictower: 1 } },
  { stage: 45, keepLevel: 9, name: 'VOIDGLASS CAMP', theme: 'wastes', tactic: 'voidglass sealed ring', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 9, wallRings: 2, traps: 18, mines: 8, defenses: { cannon: 5, archertower: 5, mortar: 2, airdefence: 1, electrictower: 1 } },

  { stage: 46, keepLevel: 10, name: 'CRYSTAL MAW', theme: 'wastes', tactic: 'crystal mouth guns', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 9, wallRings: 2, traps: 17, mines: 6, defenses: { cannon: 5, archertower: 5, mortar: 3, airdefence: 1, electrictower: 2, magetower: 1 } },
  { stage: 47, keepLevel: 10, name: "LAST MINERS' HOLD", theme: 'wastes', tactic: 'miners bait the lane', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 9, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 5, archertower: 5, mortar: 3, airdefence: 1, electrictower: 2, magetower: 1 } },
  { stage: 48, keepLevel: 10, name: 'SHARDSUNDER GATE', theme: 'wastes', tactic: 'shardsunder gap', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 9, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 5, archertower: 5, mortar: 3, airdefence: 1, electrictower: 2, magetower: 1 } },
  { stage: 49, keepLevel: 10, name: 'THE PALE CRUCIBLE', theme: 'wastes', tactic: 'crucible mage gate', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 10, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 5, archertower: 5, mortar: 3, airdefence: 1, electrictower: 2, magetower: 1 } },
  { stage: 50, keepLevel: 10, name: 'THE SPLINTER CROWN', theme: 'wastes', tactic: 'Vex beneath the crown', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 10, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 5, archertower: 5, mortar: 3, airdefence: 1, electrictower: 2, magetower: 1 }, defenderHero: { hero: 'vex', level: 8 } },

  { stage: 51, keepLevel: 11, name: 'STORMGLASS BASTION', theme: 'coast', tactic: 'stormglass gun line', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 10, wallRings: 2, traps: 17, mines: 6, defenses: { cannon: 5, archertower: 5, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1 } },
  { stage: 52, keepLevel: 11, name: 'GALLOWS SHOAL', theme: 'coast', tactic: 'gibbet lane guns', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 10, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1 } },
  { stage: 53, keepLevel: 11, name: 'BLACKWAKE ANCHORAGE', theme: 'coast', tactic: 'harbor ring breach', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 10, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1 } },
  { stage: 54, keepLevel: 11, name: 'THE DROWNED ARMADA', theme: 'coast', tactic: 'sunken fleet gate', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 11, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1 } },
  { stage: 55, keepLevel: 11, name: 'LEVIATHAN GRAVE', theme: 'coast', tactic: 'flak over the bones', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 11, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1 }, defenderHero: { hero: 'vex', level: 7 } },

  { stage: 56, keepLevel: 12, name: "SIRENS' STAIR", theme: 'coast', tactic: 'siren stair battery', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 11, wallRings: 2, traps: 17, mines: 6, defenses: { cannon: 5, archertower: 5, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1, lasertower: 1 } },
  { stage: 57, keepLevel: 12, name: 'THE SALT THRONE', theme: 'coast', tactic: 'salt throne guns', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 11, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1, lasertower: 1 } },
  { stage: 58, keepLevel: 12, name: 'UNDERTOW BASTILLE', theme: 'coast', tactic: 'undertow breach', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 11, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1, lasertower: 1 } },
  { stage: 59, keepLevel: 12, name: 'MAELSTROM WATCH', theme: 'coast', tactic: 'maelstrom laser arc', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 12, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1, lasertower: 1 } },
  { stage: 60, keepLevel: 12, name: "THE DRIFTKING'S COURT", theme: 'coast', tactic: 'Theodor rules the wrecks', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 12, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 1, lasertower: 1 }, defenderHero: { hero: 'theodor', level: 10 } },

  { stage: 61, keepLevel: 13, name: 'THE DEEP GLADE', theme: 'marsh', tactic: 'lanterns under roots', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 12, wallRings: 2, traps: 17, mines: 6, defenses: { cannon: 6, archertower: 6, mortar: 3, airdefence: 2, electrictower: 2, magetower: 2, lasertower: 1 } },
  { stage: 62, keepLevel: 13, name: 'PEATFIRE ROW', theme: 'marsh', tactic: 'peatfire gun row', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 12, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 7, archertower: 7, mortar: 3, airdefence: 2, electrictower: 2, magetower: 2, lasertower: 1 } },
  { stage: 63, keepLevel: 13, name: "WARDEN'S CAUSEWAY", theme: 'marsh', tactic: 'charged causeway gap', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 12, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 7, archertower: 7, mortar: 3, airdefence: 2, electrictower: 2, magetower: 2, lasertower: 1 } },
  { stage: 64, keepLevel: 13, name: 'DROWNED CHAPEL', theme: 'marsh', tactic: 'chapel bell breach', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 13, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 7, archertower: 7, mortar: 3, airdefence: 2, electrictower: 2, magetower: 2, lasertower: 1 } },
  { stage: 65, keepLevel: 13, name: 'THE MIRE TYRANT', theme: 'marsh', tactic: 'flak over the mire', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 13, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 7, archertower: 7, mortar: 3, airdefence: 2, electrictower: 2, magetower: 2, lasertower: 1 }, defenderHero: { hero: 'theodor', level: 9 } },

  { stage: 66, keepLevel: 14, name: 'BLACKWATER STILTS', theme: 'marsh', tactic: 'stilt-town batteries', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 13, wallRings: 2, traps: 17, mines: 6, defenses: { cannon: 6, archertower: 6, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 67, keepLevel: 14, name: 'EELGRASS WARREN', theme: 'marsh', tactic: 'eelgrass gun nests', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 13, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 7, archertower: 7, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 68, keepLevel: 14, name: 'THE SUNKEN PALISADE', theme: 'marsh', tactic: 'palisade water gate', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 13, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 7, archertower: 7, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 69, keepLevel: 14, name: 'HERONBONE GATE', theme: 'marsh', tactic: 'heronbone crossfire', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 14, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 7, archertower: 7, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 70, keepLevel: 14, name: 'THE FEN SOVEREIGN', theme: 'marsh', tactic: 'Vex wades to war', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 14, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 7, archertower: 7, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 }, defenderHero: { hero: 'vex', level: 12 } },

  { stage: 71, keepLevel: 15, name: 'RED KILN FORTRESS', theme: 'ash', tactic: 'kiln lane batteries', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 14, wallRings: 2, traps: 17, mines: 6, defenses: { cannon: 7, archertower: 7, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 72, keepLevel: 15, name: 'SOOTFALL TERRACE', theme: 'ash', tactic: 'sootfall gun terrace', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 14, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 73, keepLevel: 15, name: 'PYREBOUND KEEP', theme: 'ash', tactic: 'pyre gate breach', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 14, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 74, keepLevel: 15, name: 'THE CINDER SCALES', theme: 'ash', tactic: 'scale-yard kill box', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 15, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 75, keepLevel: 15, name: 'MAGMA THROAT', theme: 'ash', tactic: 'flak in the updraft', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 15, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 2, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 }, defenderHero: { hero: 'vex', level: 11 } },

  { stage: 76, keepLevel: 16, name: 'THE CHARRED CHOIR', theme: 'ash', tactic: 'choir of cannons', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 15, wallRings: 2, traps: 17, mines: 6, defenses: { cannon: 7, archertower: 7, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 77, keepLevel: 16, name: 'OBSIDIAN SHELF', theme: 'ash', tactic: 'obsidian shelf guns', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 15, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 78, keepLevel: 16, name: 'FIRESTORM BULWARK', theme: 'ash', tactic: 'firestorm west gate', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 15, wallRings: 2, traps: 19, mines: 7, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 79, keepLevel: 16, name: 'THE SLAG THRONE', theme: 'ash', tactic: 'slag throne breach', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 16, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 } },
  { stage: 80, keepLevel: 16, name: 'THE ASH REGNANT', theme: 'ash', tactic: 'Theodor crowns the pyre', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 16, wallRings: 2, traps: 20, mines: 8, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 1 }, defenderHero: { hero: 'theodor', level: 14 } },

  { stage: 81, keepLevel: 17, name: 'NIGHTGLASS RAMPART', theme: 'gloam', tactic: 'nightglass laser fan', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 16, wallRings: 3, traps: 17, mines: 6, defenses: { cannon: 8, archertower: 8, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 2 } },
  { stage: 82, keepLevel: 17, name: 'THE VEILED BARROW', theme: 'gloam', tactic: 'barrow lantern guns', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 16, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 9, archertower: 9, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 2 } },
  { stage: 83, keepLevel: 17, name: 'HOLLOW MOON FORT', theme: 'gloam', tactic: 'hollow moon breach', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 16, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 9, archertower: 9, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 2 } },
  { stage: 84, keepLevel: 17, name: 'SHADOWTHORN DYKE', theme: 'gloam', tactic: 'thorn dyke gate', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 17, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 9, archertower: 9, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 2 } },
  { stage: 85, keepLevel: 17, name: 'THE UNSLEEPING EYE', theme: 'gloam', tactic: 'flak beneath the eye', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 17, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 9, archertower: 9, mortar: 4, airdefence: 3, electrictower: 3, magetower: 2, lasertower: 2, dragonnest: 2 }, defenderHero: { hero: 'theodor', level: 13 } },

  { stage: 86, keepLevel: 18, name: 'COLDCANDLE CLOISTER', theme: 'gloam', tactic: 'coldcandle batteries', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 17, wallRings: 3, traps: 17, mines: 6, defenses: { cannon: 8, archertower: 8, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 87, keepLevel: 18, name: 'THE MOTH COURT', theme: 'gloam', tactic: 'moth court crossfire', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 17, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 9, archertower: 9, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 88, keepLevel: 18, name: 'GRAVEMIST GATE', theme: 'gloam', tactic: 'gravemist breach', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 17, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 9, archertower: 9, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 89, keepLevel: 18, name: 'THE STARLESS WALL', theme: 'gloam', tactic: 'starless double ring', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 18, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 9, archertower: 9, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 90, keepLevel: 18, name: "KING NOTHING'S VIGIL", theme: 'gloam', tactic: 'Vex keeps the vigil', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 18, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 9, archertower: 9, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 }, defenderHero: { hero: 'vex', level: 16 } },

  { stage: 91, keepLevel: 19, name: 'END OF THE ROAD', theme: 'wastes', tactic: 'last road batteries', profile: 'OUTPOST', threat: 'standard', c: 8, r: 20, formation: 2, defenseLevel: 18, wallRings: 3, traps: 17, mines: 6, defenses: { cannon: 9, archertower: 9, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 92, keepLevel: 19, name: 'THE GLASS STEPPE', theme: 'wastes', tactic: 'glass steppe guns', profile: 'OUTPOST', threat: 'standard', c: 9, r: 19, formation: 3, defenseLevel: 18, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 93, keepLevel: 19, name: 'WORLDSPINE BREACH', theme: 'wastes', tactic: 'worldspine gap', profile: 'BREACH', threat: 'standard', c: 7, r: 18, formation: 0, defenseLevel: 18, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 94, keepLevel: 19, name: 'THE NULL BASTION', theme: 'wastes', tactic: 'null bastion gate', profile: 'BREACH', threat: 'standard', c: 9, r: 17, formation: 1, defenseLevel: 19, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 95, keepLevel: 19, name: 'EVENTIDE SCAR', theme: 'wastes', tactic: 'flak at eventide', profile: 'FORTRESS', threat: 'mini_boss', c: 9, r: 15, formation: 2, defenseLevel: 19, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 3, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 }, defenderHero: { hero: 'vex', level: 15 } },

  { stage: 96, keepLevel: 20, name: 'THE UNMADE GATE', theme: 'wastes', tactic: 'unmade gate guns', profile: 'OUTPOST', threat: 'standard', c: 7, r: 13, formation: 0, defenseLevel: 19, wallRings: 3, traps: 17, mines: 6, defenses: { cannon: 9, archertower: 9, mortar: 5, airdefence: 4, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 97, keepLevel: 20, name: 'RELIC OF THE FIRST KEEP', theme: 'wastes', tactic: 'relic ring batteries', profile: 'OUTPOST', threat: 'standard', c: 9, r: 12, formation: 1, defenseLevel: 19, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 4, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 98, keepLevel: 20, name: 'THE FINAL PALISADE', theme: 'wastes', tactic: 'final palisade breach', profile: 'BREACH', threat: 'standard', c: 6, r: 11, formation: 2, defenseLevel: 19, wallRings: 3, traps: 19, mines: 7, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 4, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 99, keepLevel: 20, name: 'SHATTERSPIRE', theme: 'wastes', tactic: 'shatterspire kill ring', profile: 'BREACH', threat: 'standard', c: 5, r: 9, formation: 3, defenseLevel: 20, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 4, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 } },
  { stage: 100, keepLevel: 20, name: 'THE SHARD TYRANT', theme: 'wastes', tactic: 'Theodor at worlds end', profile: 'FORTRESS', threat: 'boss', c: 7, r: 8, formation: 0, defenseLevel: 20, wallRings: 3, traps: 20, mines: 8, defenses: { cannon: 10, archertower: 10, mortar: 5, airdefence: 4, electrictower: 4, magetower: 3, lasertower: 3, dragonnest: 2 }, defenderHero: { hero: 'theodor', level: 18 } },
] as const;

/**
 * CAMPAIGN — one hundred deterministic authored fights, paged into ten
 * ten-stage acts of five-stage Keep bands (owner 2026-08-15: restructured from
 * 60/5×12/3-per-keep). This is deliberately separate from the rotating PvE
 * camp tiers; a player's legal claim, defenses and Camp capacity remain the
 * balance envelope.
 */
export const CAMPAIGN = {
  totalStages: 100,
  stagesPerAct: 10,
  stagesPerKeep: 5,
  /** Compatibility/display mapping: campaign difficulty is now Keep band. */
  tierByStage: Array.from({ length: 100 }, (_, i) => Math.floor(i / 5) + 1),
  /** Acts 1-5 keep their launch names; 6-10 revisit the five themes harder
   *  (owner 2026-08-15: ten acts of ten). */
  actNames: [
    'THE BANDIT COAST', 'THE DROWNED WOOD', 'THE ASHLANDS',
    'THE GLOAM MARCH', 'THE SHARD WASTES',
    'THE WRECKING TIDE', 'THE BLACK FEN', 'THE BURNING REACH',
    'THE HOLLOW NIGHT', 'THE LAST SHARD',
  ],
  profiles: ['OUTPOST', 'BREACH', 'FORTRESS'],
  encounters: CAMPAIGN_ENCOUNTERS,
  /** Claim size and one-max-Camp capacity at Keep 1..20. */
  claimTilesByKeep: [14, 14, 16, 16, 16, 18, 18, 18, 20, 20, 20, 22, 22, 22, 24, 24, 24, 26, 26, 26],
  recommendedArmyPointsByKeep: [20, 35, 50, 54, 58, 63, 68, 73, 79, 85, 91, 99, 106, 115, 123, 133, 144, 155, 167, 180],
  maxArmyPointsByKeep: [20, 35, 50, 54, 116, 126, 136, 146, 158, 170, 273, 297, 318, 345, 369, 399, 576, 620, 668, 720],
  /** Per-stage first-3★ reward is selected by the stage's Keep band. */
  firstThreeStarShardsByKeep: [
    400, 400, 1_200, 1_200, 3_000, 3_000, 3_500, 3_500, 4_500, 4_500,
    5_500, 5_500, 6_500, 6_500, 7_500, 7_500, 8_500, 8_500, 10_000, 10_000,
  ],
  /** A stage unlocks when the previous one has ≥1★ (stage 1 always open). */
  unlockStarsRequired: 1,
} as const;

/**
 * CAMPAIGN_LAYOUT — geometry + density contract of the designed campaign
 * placer (owner 2026-08-16: "better complex more challenging bases in
 * campaign"; the stage-62 screenshot showed a sparse, unwalled cluster).
 * Consumed by makeCampaignSnapshot (apps/api world.ts) and re-derived by the
 * campaign density tests, so a future edit cannot silently make stages sparse
 * again. Rotating PvE camps keep their own CAMP_TIERS templates.
 */
export const CAMPAIGN_LAYOUT = {
  /** Outer wall inset from the claim edge, tiles. The band outside the wall
   *  carries the ordinary support economy (camps/barracks/forges/mines),
   *  CoC-style, so the base reads as a living settlement around a fort. */
  outerWallInset: 2,
  /** Citadel (Keep compartment) outer size: wide claims get an 8-tile citadel
   *  whose courtyard fits a 2×2 splash tower beside the Keep; small claims a
   *  6-tile one (1-tile courtyard, 1×1 towers only). */
  citadelSizeTiles: 6,
  citadelWideSizeTiles: 8,
  citadelWideFromClaimTiles: 22,
  /** OUTPOST rings skip every Nth perimeter tile — a patrolled stockade with
   *  many entrances. BREACH seals all but ONE gate (gateTiles wide) behind a
   *  trap-lined funnel funnelDepth tiles deep. FORTRESS seals everything. */
  outpostGapEvery: 4,
  breachGateTiles: 2,
  breachFunnelDepthTiles: 3,
  /** Band-position density shares: position p (0..4 inside a 5-stage Keep
   *  band) fields ceil(cap × num[p] / den) of every unlocked defense, trap and
   *  mine cap — 2/3 strength opener to the full-cap FORTRESS exam. From
   *  lateFromKeep the on-ramp is over: openers field 5/6 of cap and the last
   *  two stages of every band sit at the full player build-cap ceiling (the
   *  90-second clock is what makes half-strength armies fail there — proven by
   *  the campaign difficulty tests). */
  densityNumeratorByBandPosition: [8, 9, 10, 11, 12],
  lateDensityNumeratorByBandPosition: [10, 11, 11, 12, 12],
  densityDenominator: 12,
  lateFromKeep: 9,
  /** defenseLevel = keep − lag[p], floored at 1 (walls/support share it). */
  defenseLevelLagByBandPosition: [2, 2, 1, 1, 0],
  lateDefenseLevelLagByBandPosition: [1, 1, 1, 0, 0],
  /** Structural wall tier by Keep: 0 = open camp (Keep 1 only — the act-1
   *  opener must stay winnable by a fresh player's first four turriders,
   *  pinned in world.test.ts); 1 = outer ring; 2 = + citadel + 3×3
   *  compartment cross-walls; 3 = + doubled outer wall. Budgeted to stay
   *  within wallCapForKeepLevel at every Keep (asserted in tests). */
  wallRingsByKeep: [0, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3],
  /** Trap families cycle spike→powder→pitfall at choke points; from the
   *  air-defence Keep every Nth trap is an Air Mine so all-air armies keep
   *  paying the choke toll too. Trap level = defenseLevel (tier via
   *  artTierOfLevel), so late-band traps carry their authored burst tiers. */
  airMineFromKeep: 7,
  airMineEvery: 5,
  /** Boss finales field the act's ON hero at keep − bossHeroLag; from
   *  miniBossHeroFromKeep the act midpoint fields the OFF hero at
   *  keep − miniBossHeroLag (late acts are hero-garrisoned twice). */
  bossHeroLag: 2,
  miniBossHeroFromKeep: 11,
  miniBossHeroLag: 4,
} as const;

/** Every hero in the game, in canonical order. The ONE source of "how many
 *  heroes exist" — the raid order schema caps hero drops at this length rather
 *  than a literal (one drop per distinct hero, D4a). */
export const HERO_KEYS = ['vex', 'theodor'] as const;
export type HeroKey = (typeof HERO_KEYS)[number];

/** Defensive hero guard contract (owner 2026-07-29, reaffirmed 2026-08-11).
 * Anchoring aggro on the altar gives attackers a far-side counterplay; Theodor's
 * inverted taunt is the sole per-hero override. */
export const HERO_DEFENCE = {
  enabled: { vex: true, theodor: true },
  statPct: 100,
  aggroRadiusTiles: 5,
  leashRadiusTiles: 8,
  theodorTauntRadiusTiles: 6,
  theodorTauntSec: 4,
  knockoutStartsRegen: false,
} as const;

/**
 * HEROES (overnight 2026-07-26 — HERO Vex Shardborn.html + HERO Theodor
 * Tsiodora.html, MVP scope per OVERNIGHT-INTEGRATION-PLAN D). Stats/curves are
 * the specs' formulas as DATA; every number ⚠ ALPHA ("Spec v0.1, GDD stays
 * canonical" — the specs' own words). What ships tonight: recruitment via the
 * altar building, the HEROES build tab, base presence. What does NOT: combat
 * (skills/taunts/wall-deletion — sim work, plan D4; when it lands these curves
 * must be SNAPSHOTTED to integer tables — Math.pow never enters packages/sim)
 * and LEVEL-UPS (the specs price them in KEEP, up to ~278k at the top end — a
 * real-token sink that needs the owner: plan D-Q1).
 */
export interface HeroSpec {
  name: string;
  title: string;
  altar: 'heroaltar' | 'siegestool';
  unlockKeepLevel: number;
  /** Recruit price in whole KEEP (owner 2026-08-16 verbatim: "Vex hero cost is
   * 3000 KEEP, Theodor 10,000 KEEP"). Charged at altar placement UNLESS the
   * wallet/base consumes its hero-contract item instead (UNLOCK_ITEMS). */
  recruitCostKeep: number;
  /** The tradeable hero-contract item (UNLOCK_ITEMS key) that altar placement
   * consumes in place of the KEEP charge. Owner 2026-08-16: "heroes are also
   * items which can be sold in-game market". */
  recruitItemId: string;
  maxLevel: number;
  hpAt(level: number): number;
  dpsAt(level: number): number;
  /** Downed-hero regen timer in minutes at a level. */
  regenMinAt(level: number): number;
  /** ⚠ SPEC PRICES THESE IN KEEP — unwired until D-Q1 (owner). */
  upgradeCostAt(level: number): number;
  tiers: ReadonlyArray<{ name: string; atLevel: number }>;
}

export const HEROES: Record<'vex' | 'theodor', HeroSpec> = {
  vex: {
    name: 'Vex',
    title: 'The Shardborn',
    altar: 'heroaltar',
    // Owner 2026-08-16: "hero unlock start from keep level 5" (was L3).
    unlockKeepLevel: 5,
    recruitCostKeep: 3_000, // owner 2026-08-16: "Vex hero cost is 3000 KEEP"
    recruitItemId: 'item_hero_vex',
    maxLevel: 20,
    hpAt: (n) => Math.round((1400 * Math.pow(1.07, n - 1)) / 5) * 5,
    dpsAt: (n) => Math.round(95 * Math.pow(1.065, n - 1)),
    regenMinAt: (n) => 10 + 5 * (n - 1),
    upgradeCostAt: (n) => Math.round((2500 * Math.pow(n, 1.6)) / 100) * 100,
    tiers: [
      { name: 'Shardborn', atLevel: 1 }, { name: 'Awakened', atLevel: 6 },
      { name: 'Moonsunder', atLevel: 11 }, { name: 'The Nephilim', atLevel: 16 },
    ],
  },
  theodor: {
    name: 'Theodor',
    title: 'The Tsiodora',
    altar: 'siegestool',
    // Owner 2026-08-16: "hero unlock start from keep level 5" (was L4).
    unlockKeepLevel: 5,
    recruitCostKeep: 10_000, // owner 2026-08-16: "Theodor 10,000 KEEP"
    recruitItemId: 'item_hero_theodor',
    maxLevel: 20,
    hpAt: (n) => Math.round(4200 * Math.pow(1.085, n - 1)),
    dpsAt: (n) => Math.round(38 * Math.pow(1.042, n - 1)),
    regenMinAt: (n) => 15 + 6 * (n - 1),
    upgradeCostAt: (n) => Math.round((2200 * Math.pow(n, 1.6)) / 100) * 100,
    tiers: [
      { name: 'Latrine Duty', atLevel: 1 }, { name: 'Bench Pressed', atLevel: 6 },
      { name: 'Grease Baron', atLevel: 11 }, { name: 'The Tsiodora', atLevel: 16 },
    ],
  },
} as const;

/**
 * HERO COMBAT (D4a, owner go-ahead 2026-07-28; behaviour split out 2026-07-29)
 * — the INTEGER tables the sim consumes (packages/sim never sees Math.pow;
 * hp/dpsDeci are HEROES.hpAt/dpsAt evaluated at L1, and HERO_LEVELING below
 * carries L1–20).
 *
 * A hero is deployed as a pseudo-deploy of its `donor` troop, but a hero
 * INHERITS NO BEHAVIOUR from that donor — every field the sim reads lives
 * here. Until 2026-07-29 only hp/dps were overridden and the donor's
 * movement/targeting/wall policy leaked through, which produced two reported
 * bugs: Vex sprinted at the highlander's 1.2 tiles/s, and Theodor inherited the
 * giant's `wallPolicy: 'break'` + `buildingDamageMult: 2` and spent whole
 * battles grinding wall HP at 38 dps (16–55 s per segment) while the rest of
 * the 'follow' army regrouped on him as the designated opener.
 *
 * ⚠ ALPHA — the spec pages state no tiles/sec, so the movement numbers below are
 * anchored on each kit's stated ROLE (quoted per hero); owner tunes.
 */
export const HERO_COMBAT: Record<'vex' | 'theodor', {
  /** ART + the `troop` field of the deploy event ONLY — never behaviour. */
  donor: TroopType;
  hp: number;
  dpsDeci: number;
  /** Authoritative basic-attack recovery in 100 ms ticks. Damage is accumulated
   * across the interval, preserving listed DPS while giving replay art one cue. */
  attackRecoveryDeciSec: number;
  /** Own movement — floor(x*256/10) units/tick must be integral-ish; see comments. */
  speedTilesPerSec: number;
  range: number | 'melee';
  aiTarget: TroopAiTarget;
  wallPolicy: TroopWallPolicy;
  buildingDamageMult?: number;
  isFlying?: boolean;
  burrowsUnderWalls?: boolean;
  emergeVulnerableSec?: number;
  /** 2× vs Mine/Vault (the plunderer's role). Undeclared = no bonus — a hero
   *  never inherits it from a plunderer donor (sim reads it via behaviorOf). */
  resourceDamageMult?: number;
  splashRadiusTiles?: number;
  /**
   * Carries a keg: detonates on reaching its wall/target and dies (the keg
   * runner's role). Undeclared = the hero never blows up, even with a kegrunner
   * donor.
   */
  selfDestructs?: boolean;
  /**
   * Cross-blast damage to WALLS on detonation — the magnitude half of the keg
   * role (2026-07-29). Until now `selfDestructs` was data but the blast SIZE was
   * not: the sim read TROOPS.kegrunner.wallBurst unconditionally and scaled it by
   * `tr.level`, which for a hero is the HERO level — so a self-destructing hero
   * inherited a keg runner's 900 wall damage on a hero's level curve, nobody
   * having written that down. The sim now reads this field through `behaviorOf`,
   * so a hero that does not declare it bursts for 0 and must be given its own
   * number before shipping. (The non-wall splash needs no field: it is one second
   * of the DETONATING unit's own dps, which is already per-unit data.)
   */
  wallBurst?: number;
}> = {
  /**
   * Vex — "NEPHILIM RONIN · RAID LEADER" (HERO Vex Shardborn.html). His mobility
   * IS Crimson Dash ("dash if target ≥3 tiles (wall-piercing)"), so the WALK is
   * a deliberate advance BELOW the highlander's 1.2 raider pace and the dash
   * reads as the burst; 1.0 → floor(1.0*256/10) = 25 units/tick.
   * wallPolicy 'follow': his dash pierces walls, he never chews wall HP.
   */
  vex: {
    donor: 'highlander', hp: 1_400, dpsDeci: 95, attackRecoveryDeciSec: 6,
    speedTilesPerSec: 1.0, range: 'melee', aiTarget: 'nearest', wallPolicy: 'follow',
  },
  /**
   * Theodor — "TANK · AGGRO MAGNET", "WADDLE", "HOW HE DIES: Slowly, loudly"
   * (HERO Theodor Tsiodora.html). Slowest unit in the game, under the giant's
   * 0.85; 0.7 → floor(0.7*256/10) = 17 units/tick.
   * aiTarget 'defenses' is his spec role verbatim ("PULLS ALL DEFENCES IN R6",
   * "Every arrow aimed at him is an arrow not aimed at anything that matters")
   * — he must walk AT the guns, which is also what Cheek Quake's taunt assumes.
   * wallPolicy 'follow': his wall answer is BROWN NOTE deletion ("the only unit
   * that ignores wall HP entirely", unlockLevel 14), NOT damage.
   * NO buildingDamageMult — the 2x is the GIANT's; "DMG EMBARRASSING · his ladle
   * does less damage than a thrown boot" is his entire design.
   */
  theodor: {
    donor: 'giant', hp: 4_200, dpsDeci: 38, attackRecoveryDeciSec: 10,
    speedTilesPerSec: 0.7, range: 'melee', aiTarget: 'defenses', wallPolicy: 'follow',
  },
};

/** Hero tier from level: T1 L1–5, T2 L6–10, T3 L11–15, T4 L16–20 (both kits). */
export function heroTier(level: number): 1 | 2 | 3 | 4 {
  return (1 + (level >= 6 ? 1 : 0) + (level >= 11 ? 1 : 0) + (level >= 16 ? 1 : 0)) as 1 | 2 | 3 | 4;
}

/**
 * HERO LEVELING (D-Q1, hero spec pages + owner 2026-07-28) — the INTEGER source
 * of truth for hero levels 1–20. These are `HEROES.hpAt/dpsAt/upgradeCostAt`
 * SNAPSHOTTED at levels 1..20 with JS Math.round semantics, so no Math.pow ever
 * reaches the server hot path or `packages/sim` (sim purity rule). The HEROES
 * spec object above stays as the documented formula; THIS block is what code
 * consumes.
 *
 * INDEX 0 IS TODAY'S LIVE L1: hp[hero][0] / dps[hero][0] equal HERO_COMBAT's
 * hp / dpsDeci exactly (vex 1400/95, theodor 4200/38), so existing golden
 * replays — every hero in them is L1 — are bit-identical and unaffected.
 *
 * Hero upgrades are paid in KEEP (owner 2026-07-28). Troop research is a
 * separate SHARDS path despite its legacy `researchCostKeep` field name;
 * `upgradeCostKeep[i]` here buys hero level i+1 → i+2, so the array is
 * maxLevel-1 long (L1→2 … L19→20).
 */
export const HERO_LEVELING = {
  maxLevel: 20,
  /** Hero HP at level n = hp[hero][n-1]. */
  hp: {
    vex: [1400, 1500, 1605, 1715, 1835, 1965, 2100, 2250, 2405, 2575, 2755, 2945, 3155, 3375, 3610, 3865, 4135, 4420, 4730, 5065],
    theodor: [4200, 4557, 4944, 5365, 5821, 6315, 6852, 7435, 8067, 8752, 9496, 10303, 11179, 12129, 13160, 14279, 15493, 16810, 18238, 19789],
  },
  /** Hero DPS at level n = dps[hero][n-1] (whole DPS — and `dpsDeci` is deci
   *  per 100ms TICK, which is the same number, so the sim consumes this as-is.
   *  It used to ×10 it, giving both heroes 10× their stat; fixed 2026-07-29. */
  dps: {
    vex: [95, 101, 108, 115, 122, 130, 139, 148, 157, 167, 178, 190, 202, 215, 229, 244, 260, 277, 295, 314],
    theodor: [38, 40, 41, 43, 45, 47, 49, 51, 53, 55, 57, 60, 62, 65, 68, 70, 73, 76, 80, 83],
  },
  /** KEEP to go from level n → n+1 = upgradeCostKeep[hero][n-1]. */
  upgradeCostKeep: {
    vex: [2500, 7600, 14500, 23000, 32800, 44000, 56200, 69600, 84100, 99500, 115900, 133200, 151400, 170500, 190400, 211100, 232600, 254900, 277900],
    theodor: [2200, 6700, 12800, 20200, 28900, 38700, 49500, 61300, 74000, 87600, 102000, 117200, 133300, 150000, 167600, 185800, 204700, 224300, 244600],
  },
} as const;

/**
 * HERO SKILLS (D4b, owner 2026-07-28) — the two kits' EXACT tier tables from
 * the spec pages (_hero_page.js SKILLS arrays; extraction wf_73984e68), stored
 * as INTEGER data indexed [T1,T2,T3,T4]; 0 = unavailable at that tier. Damage
 * percents are % of the hero's DPS; deci-seconds keep the sim integer at 100ms
 * ticks.
 * ⚠ "Spec v0.1, GDD stays canonical" — owner tunes.
 *
 * ALL THIRTEEN SKILLS HAVE ENGINE CODE (2026-07-29). Every one is gated on the
 * hero's OWN level vs `unlockLevel` and tiered via `heroTier(level)`.
 *
 * ⚠ FIVE numbers the engine needs are stated NOWHERE in the spec pages. They are
 * marked `⚠ ALPHA — NOT IN SPEC` below with the anchor each was reasoned from,
 * and they are the only invented values in this block. Owner sign-off pending:
 *   snotRocket.castRangeTiles · brownNote.gasRadiusTiles · rageQuit.wakeStunRadiusTiles
 *   doubleOrNothing.headsPct · doubleOrNothing.immuneSec (the last is spec PROSE,
 *   not a table row — "1s immune").
 *
 * UNLOCK/TIER COLLISION (owner 2026-08-11). Zero-effect tier rows are sentinels,
 * tier tables use `0 = unavailable at that tier`, but three skills unlock at a
 * level whose OWN tier index is still 0:
 *   - moonsunderWave  unlocks L5  → heroTier(5)=1  → waveDmgPctDps[0]  === 0
 *   - degenAwakening  unlocks L10 → heroTier(10)=2 → dmgPct[1]/atkSpeedPct[1]/lifestealPct[1] === 0
 *   - doubleOrNothing unlocks L15 → heroTier(15)=3 → reviveHpPct[2]    === 0
 * so the advertised unlocks are the first levels whose own tier has an effect:
 * 6/11/16. Belly Bounce remains level 11 because its T3 row is already live.
 */
export const HERO_SKILLS = {
  vex: {
    crimsonDash: {
      unlockLevel: 1, cdSec: 12,
      lineDmgPctDps: [200, 260, 320, 400], wallMult: [3, 3, 4, 4], rangeTiles: [4, 4, 5, 5],
      /** Gap-closer trigger: dash when the target sits at least this far away. */
      minGapTiles: 3,
    },
    moonsunderWave: {
      unlockLevel: 6, cdSec: 16,
      waveDmgPctDps: [0, 150, 200, 250], bleedPctMaxHpPer4s: [0, 5, 8, 12], widthTiles: [0, 1, 1, 2],
      /** Travel distance. Spec PROSE, not a table row: "The crescent travels 6
       *  tiles, pierces everything" (vexassets/_hero_page.js SKILLS.moonwave). */
      rangeTiles: 6,
      /** The BLEED row is a RATE ("BLEED /4s · 5% max HP"), and the spec states
       *  no duration. Read as one 4-second window per application — the reading
       *  that needs no invented number; a re-cast refreshes it. Bleed lands on
       *  DEFENDER TROOPS only ("bleed ticks show fx_vex_bleed on victims"):
       *  % of MAX HP against a building would raze a base in ~34s (see Q4). */
      bleedSec: 4,
    },
    // ⚠ Q5 — `atkSpeedPct` cannot shorten SIM9's authored body cycles: that
    // would visibly accelerate the art, contrary to D-034. Preserve the locked
    // effective output by folding it into damage: dmgPct + atkSpeedPct
    // (T3 +70%, T4 +90%).
    degenAwakening: { unlockLevel: 11, cdSec: 40, durationSec: 10, dmgPct: [0, 0, 40, 60], atkSpeedPct: [0, 0, 30, 30], lifestealPct: [0, 0, 20, 30] },
    doubleOrNothing: {
      unlockLevel: 16, oncePerBattle: true,
      reviveHpPct: [0, 0, 0, 50], tailsRegenRefundPct: [0, 0, 0, 50],
      /** ⚠ ALPHA — NOT IN SPEC. The page says "a coin goes up" and never states
       *  odds; a coin is 50/50, so that is what ships. The sim draws it from a
       *  SEPARATE mulberry32 stream seeded off the raid seed, so a hero's coin
       *  never re-phases the shared defense-jitter stream. */
      headsPct: 50,
      /** Spec PROSE: "HEADS: back at half HP, 1s immune". */
      immuneSec: 1,
    },
    // Crescents reuse MOONSUNDER WAVE's numbers verbatim — the spec row is
    // literally "CRESCENTS · 8 × wave dmg", so this block carries the COUNT only.
    omegaShardstorm: { unlockLevel: 20, oncePerBattle: true, novaDmgPctDps: [0, 0, 0, 300], stunDeciSec: [0, 0, 0, 20], crescents: [0, 0, 0, 8], novaRadiusTiles: 6 },
  },
  theodor: {
    cheekQuake: {
      unlockLevel: 1, cdSec: 10, aoeTiles: 3,
      aoeDmgPctDps: [60, 75, 90, 110], stunDeciSec: [10, 12, 15, 20], tauntTiles: [3, 4, 4, 5],
    },
    snotRocket: {
      unlockLevel: 3, cdSec: 8, dmgPctDps: [25, 30, 35, 40], blindDeciSec: [20, 30, 30, 40],
      /** ⚠ ALPHA — NOT IN SPEC. The skill has no stated range. Anchored on his
       *  own headline role, "PULLS ALL DEFENCES IN R6" (HERO Theodor
       *  Tsiodora.html): he spits at a gun he is already pulling. */
      castRangeTiles: 6,
    },
    cannonball: { unlockLevel: 5, cdSec: 14, impactDmgPctDps: [120, 150, 180, 220], leapRangeTiles: [4, 5, 6, 6], partingGiftDps: [0, 20, 35, 50], partingGiftSec: 8 },
    // durationSec -1 = the spec's T4 "hold" (indefinite while toggled) — NOT the
    // block's "0 = unavailable" sentinel, which would silently zero the top tier.
    // ⚠ Q2 — there is NO cdSec, so a duration is unobservable: an autocast
    // re-toggles the instant it lapses and T1–T3 collapse into T4's "hold". The
    // sim therefore runs SKILL ISSUE as an always-on passive aura from L8 and
    // `durationSec` is RENDER-ONLY data. Give it a cooldown to make it a real
    // toggle.
    skillIssue: { unlockLevel: 8, retargetTiles: [4, 5, 6, 7], dmgTakenReductionPct: [20, 30, 35, 40], durationSec: [4, 5, 6, -1] },
    // ⚠ Q4 — reflectPct/knockbackTiles are DATA-ONLY (no engine code). Both need
    // the ATTACKER's identity at the damage site, and `damageTroop` takes no
    // source; worse, "melee hits" in this sim only ever means a Dragon-Nest
    // wyrmling, so both would be strict no-ops against a base without a Nest.
    // `selfDrPct` IS live (always on from L11).
    bellyBounce: { unlockLevel: 11, reflectPct: [0, 15, 20, 30], knockbackTiles: [0, 1, 1, 2], selfDrPct: [5, 8, 10, 12] },
    brownNote: {
      unlockLevel: 14, cdSec: 20, wallSegments: [1, 1, 1, 2], gasSec: [0, 4, 6, 8], gasDps: 30,
      /** ⚠ ALPHA — NOT IN SPEC. The gas "lingers and poisons whatever walks
       *  through the gap", so it is sized to THE GAP: one tile around the
       *  deleted segment. It damages DEFENDER TROOPS only (see Q4) — against a
       *  base with no Dragon Nest the gas is a knowing no-op and the wall
       *  deletion is the whole skill. */
      gasRadiusTiles: 1,
    },
    rageQuit: {
      unlockLevel: 17, oncePerBattle: true, fakeDeathHpPct: 60, untargetableSec: 3, wakeStunSec: 1,
      /** ⚠ ALPHA — NOT IN SPEC. "getup … with a 1s AoE stun" states no radius.
       *  Anchored on CHEEK QUAKE's `aoeTiles` — his other AoE, same body, same
       *  animation vocabulary. */
      wakeStunRadiusTiles: 3,
    },
    // The spec's "five seconds of eating, three seconds of swelling" wind-up is
    // RENDER-ONLY: the sim's event contract is "events are rendering cues, the
    // sim applies effects", so the nova/cloud/fear land on the cast tick and the
    // client plays the wind-up. "BLOATED ONLY" is self-satisfied — per the
    // integration notes BLOATED is a palette swap driven BY this ult, and no
    // other Theodor skill grants it, so there is nothing to gate on.
    silentButDeadly: {
      unlockLevel: 20, oncePerBattle: true, eatWindupSec: 5, swellWindupSec: 3,
      novaDmgPctDps: 250, fearSec: 3, cloudSec: 10, cloudDps: 60, novaRadiusTiles: 6,
    },
  },
} as const;

/**
 * Clans — Phase 3 pulled forward (owner 2026-07-26, docs/CLANS-SELLABLE-DEEDS-PLAN.md).
 * GDD deferred clans with no spec, so every number here is an ⚠ ALPHA
 * PLACEHOLDER awaiting owner sign-off (plan item C5). MVP scope: create/join/
 * leave/roster/leaderboard + the weekly chest; no wars, no chat (Discord per GDD).
 */
export const CLANS = {
  /** Shard cost to found a clan — a real sink (burned), so throwaway clan spam
   *  costs something. ~10 days of L1 mining. */
  createCostShards: 5_000,
  /** Roster cap (leader included). */
  rosterCap: 20,
  /** Name: display string; tag: the short badge next to names in raid logs. */
  nameMinLen: 3,
  nameMaxLen: 24,
  tagMinLen: 2,
  tagMaxLen: 5,
  /** Share of every member's legacy PvP raid loot routed into the clan's
   * weekly chest. Ranked leagues take no raid tithe (owner 2026-08-30). */
  chestTitheBps: 200,
} as const;

/** Raid matchmaking & flow rules — GDD §3.3/§3.4/§3.8, ARCHITECTURE §5. */
export const RAID_RULES = {
  /** PRE-BATTLE deploy window (owner 2026-07-26: "player should have 30 seconds to
   * deploy troops before raid starts automatically"). This is the countdown on
   * `raids.ordersDeadlineAt` after which the client auto-commits — it is NOT a cap
   * on WHEN a troop may land: the sim accepts deploys across the whole battle
   * (sim.ts bounds them by MAX_TICKS) so remaining troops can be committed during
   * the fight. Was 60s. */
  deployWindowSec: 30,
  /** Battle length after the deploy window closes (GDD §3.3): 90s. The sim
   * derives its MAX_TICKS from this × its tick rate. */
  battleDurationSec: 90,
  /** Batch replay submission tail after the 90s horn: SIM9 may drain 60 ×
   * 100ms ticks (6s), BattleScene publishes done 1s after its last event, and
   *  3s remains for the final API dispatch/round-trip. `ordersDeadlineAt` keeps
   * its deployed deploy+fight meaning for rolling compatibility; the API adds
   * this tail only when accepting/expiring batch submissions. Live first-deploy
   * authority remains exactly 30s. */
  batchOrdersGraceSec: 10,
  /** THE PvP ATTACK GATE (D-099, owner 2026-09-02: "KEEP 10 cannot attack KEEP
   * 1; KEEP 1 can attack KEEP 10"). A defender is attackable when
   *     defenderKeep × 10 000 ≥ attackerKeep × pvpMinDefenderKeepBps
   * — their Keep is at least this share of yours: K3→≥2, K6→≥3, K10→≥5,
   * K11→≥6, K20→≥10; the weaker side can always attack up. This REPLACED the
   * trophy windows (±15 % auto-match, ±20 % map, floor 50, ×3 retry): trophies
   * measure activity, not strength, so a strong base with few trophies was
   * unattackable while a KEEP that out-climbed its peers had nobody to fight.
   * Trophies survive only as auto-match's SORT (nearest-rated first).
   * ⚠ 50 % is the default pending the owner's confirmation of the ratio. */
  pvpMinDefenderKeepBps: 5_000,
  /** Candidate rows pulled per auto-match pass, nearest-rated first. Trophies
   * are a sort preference, never a filter (D-099), so this cap is what bounds
   * one pass and the ordering is what keeps the page worth reading. */
  autoMatchCandidatePool: 50,
  /** Auto-match picks uniformly among this many of the nearest-rated survivors
   * of the per-row filters (shield, cooldown, Keep present). Random so the same
   * neighbour is not farmed on repeat; nearest so it is still a peer fight
   * (D-099, owner 2026-09-02 "random among the nearest ten"). */
  autoMatchNearestPick: 10,
  revengeLockHours: 4,
  /** Never the same target twice per day (GDD §3.3). */
  sameTargetCooldownHours: 24,
  /** GDD §3.4 scout: a 30-second layout preview. */
  scoutPreviewSec: 30,
  /** Store the 20 most recent replays per player (GDD §3.8). */
  replayRetention: 20,
  /** ★ at ≥50% destruction, ★★ Keep destroyed, ★★★ 100% (GDD §3.3). */
  oneStarDestructionPct: 50,
  threeStarDestructionPct: 100,
  /** Deploy zone = the plot + this many tiles of margin (GDD §3.5). Enforced
   * identically by the sim and the client deploy overlay. */
  deployMarginTiles: 4,
  /** Hold-to-deploy repeat rate (ms between units while the finger stays down).
   * PURELY a client input affordance — the sim never sees it: holding just emits
   * the same deploys a series of taps would (owner 2026-07-26: "if I have 40
   * archers … not to tap on screen 40 times"). ~8 units/sec, fast enough to place
   * a full army in a few seconds, slow enough to stop on the tile you meant. */
  deployHoldRepeatMs: 120,
  /** Legacy visual cadence for Wyrmlings and hero/donor routes that have not
   * migrated to SIM9 `attackRun`. Ordinary attacker timing comes exclusively
   * from AUTHORED_ATTACK_TIMINGS and damage lands at its published contacts. */
  troopFireVisualTicks: 5,
  /** ±% deterministic jitter applied to defense damage — the sim's ONLY seeded
   * RNG (packages/sim is otherwise pure integer math). */
  dmgJitterPct: 6,
  /** A tunneler emerging clears walls within this many tiles (burrow radius). */
  burrowClearTiles: 2,
} as const;

/** D-146 (owner 2026-09-19): new raids require an empty square containing
 * the selected tile. D-136 version 2 retains single-cell deployment throughout
 * the 98×98 realm; missing/version 1 retains its margin and claim exclusion. */
export const RAID_BATTLEFIELD = {
  legacyVersion: 1,
  currentVersion: 3,
  marginTilesByVersion: { 1: RAID_RULES.deployMarginTiles, 2: 34, 3: 34 },
  /** D-146: all four tiles must be free; the selected tile may be any corner. */
  deploymentSquareTiles: 2,
  /** Existing forgiving web placement (owner 2026-08-15), shared with native. */
  snapRadiusTiles: 1,
} as const;

/** Lowest defender Keep a Keep of `attackerKeep` may attack (D-099): the
 * integer ceiling of attackerKeep × pvpMinDefenderKeepBps / 10 000, so K11 → 6
 * and K1 → 1. Integer math on purpose — the API puts the same bound in SQL. */
export function pvpMinDefenderKeep(attackerKeep: number): number {
  return Math.floor((attackerKeep * RAID_RULES.pvpMinDefenderKeepBps + 9_999) / 10_000);
}

/** THE ONE Keep-asymmetry predicate. createRaid (named target and auto-match),
 * the parcel preview, the legacy valley map and the globe reach ring all call
 * this, so none of them can disagree about who may attack whom (D-099). */
export function pvpAttackAllowed(attackerKeep: number, defenderKeep: number): boolean {
  return defenderKeep * 10_000 >= attackerKeep * RAID_RULES.pvpMinDefenderKeepBps;
}

/** Client battle-playback pacing (owner 2026-09-02, D-096 "battle clock").
 * Presentation only: the sim, the server and the raid result never see it. */
export const RAID_PLAYBACK = {
  /** Scene-clock multiplier BattleScene applies after the browser paused
   * Phaser's loop (hidden tab) until the missed span has been replayed, so the
   * troops fast-forward to where the wall-clock battle actually is instead of
   * finishing late by the whole absence. 8× turns a 20 s tab switch into 2.5 s
   * of catch-up — brisk enough that the HUD (wall-clock) and the field agree
   * again before the verdict, slow enough to still read as the fight. */
  catchUpTimeScale: 8,
} as const;

/** Deterministic replay representation safety boundary (security review
 * 2026-08-11). The max legal four-camp roster contains 40 Hexbarrows and can
 * create 2,040 attacker actors across a full 90-second raid; 2,500 also covers
 * heroes and every legal Dragon-Nest spawn. Event storage is stopped before a
 * pathological snapshot can create an unbounded JSONB/replay response. */
export const RAID_REPLAY_LIMITS = {
  /** Four L20 camps × 180 points ÷ the 1-point Bowman. This is existing legal
   * capacity, not a new balance cap. */
  maxDirectDeploys: BUILD_COUNT_CAP_BY_KEEP.camp!.at(-1)! * STRUCTURES.camp.capacityPts.at(-1)!,
  maxActors: 2_500,
  maxEvents: 50_000,
  /** Distributed submit single-flight. A crashed resolver becomes retryable
   * after this lease; comfortably above the measured worst legal SIM6 run. */
  simulationLeaseSec: 30,
  /** Parent-side worker deadline. It must remain below the distributed lease so
   * a timed-out worker releases its own token before another host can take it. */
  simulationWorkerTimeoutSec: 20,
  /** Durable per-wallet CPU admission spacing; route-level IP limiting is a
   * second independent boundary. Neither changes combat or army capacity. */
  simulationWalletCooldownSec: 15,
  /** At the measured ~2s worst legal replay, six admissions cap one IP at
   * roughly 20% of a process-minute while allowing normal battle retries. */
  submitRateLimitPerMin: 6,
  /** Route very large legal simulations through the cross-host heavy lease.
   * This is CPU admission only; it never removes actors or visual events. */
  heavySimulationAboveActors: 100,
  /** A cast accepted before the 90-second horn may finish, including the
   * Direwyvern's delayed fan plus complete five-second burnfield. */
  postBattleDrainTicks: 60,
  /** No legal authored run can contain more cycles than battle ticks. */
  maxAttackRunCycles: RAID_RULES.battleDurationSec * 10,
  /** Dragon's root/mid/tip is the widest authored contact fan. */
  maxAttackContactsPerCycle: 3,
} as const;

/**
 * Simulator pathing numbers (D-099, owner 2026-09-02: blocked units decide once
 * at a wall). Read only by packages/sim/src/path.ts and sim.ts.
 */
export const SIM_PATHING = {
  /** Dijkstra cost to ENTER a tile holding a live wall; a free tile costs 1.
   * Any cost-field value at or above this means "every route from here crosses
   * a wall", which is the whole "is there a way in?" question — so it only has
   * to exceed the longest wall-free walk on the 30×30 field (≤ 900). Lived as a
   * hardcoded WALL_COST in packages/sim/src/path.ts until SIM12. */
  wallCost: 1_000,
} as const;

/**
 * Simulator targeting numbers. Read only by packages/sim/src/sim.ts.
 */
export const SIM_TARGETING = {
  /** SIM16 (owner relaying players 2026-09-17: giants "going to another place
   * when a target is nearby"). When a defence-seeker picks a target, a defence
   * behind masonry is priced as its straight distance PLUS this many tiles —
   * a breach allowance — against the nearest open defence, and the cheaper
   * one wins. 6 tiles is roughly what the giant spends chewing a T2–T3 wall
   * at dps×2 (600–1200 hp at 110/s, 0.85 tiles/s), so a sealed gun four
   * tiles away beats an open one thirteen tiles away while a sealed one
   * beside an open one a tile farther does not. Default pending the owner's
   * confirmation; one number, no other code path reads it. */
  sealedDefenceAllowanceTiles: 6,
} as const;

/** Server-sequenced live raid command/reconnect protocol (owner 2026-09-03).
 * V1 remains readable forever; V2 is an explicit, fail-closed create opt-in. */
export const LIVE_RAID = {
  protocolVersion: 2,
  legacyProtocolVersion: 1,
  clockRates: [1, 2] as const,
  /** Owner 2026-09-03: a raid may change clock rate at most 24 times. */
  speedChangeLimit: 24,
  /** Owner 2026-09-03: start/speed controls share a 30/minute IP shield. */
  controlRateLimitPerMin: 30,
  controlRateLimitWindowMs: 60_000,
  /** A legal max army plus heroes and bounded rally/buff/finish control input. */
  maxCommands: BUILD_COUNT_CAP_BY_KEEP.camp!.at(-1)! * STRUCTURES.camp.capacityPts.at(-1)!
    + HERO_KEYS.length + 8 + 24 + 2,
  reconnectPageSize: 250,
  /** Recovery retains a lock long enough to resolve a disconnected started raid. */
  recoveryGraceSec: 120,
  clientCommandIdMaxLength: 128,
  payloadMaxBytes: 2_048,
  commandRateLimitPerMin: 600,
  reconnectRateLimitPerMin: 120,
  /** Singleton worker cadence and bounded batch for disconnected started raids. */
  recoverySweepSec: 5,
  recoveryBatchSize: 4,
} as const;

/** SIM9 source-of-truth attack timing. Frames/fps and projectile milliseconds
 * come from the authored V2 atlas manifests; explicit cadence preserves the
 * existing Gloamfang/Hexbarrow/Barrowling balance. Wyrmling is deliberately
 * absent until its directional art is re-authored (owner 2026-08-12). */
export interface AuthoredAttackTiming {
  technique: TroopAttackTechnique;
  mode: 'melee' | 'projectile' | 'stream' | 'detonate';
  frames?: number;
  fps?: number;
  releaseFrame?: number;
  clips?: readonly { frames: number; fps: number }[];
  contactFrames: readonly number[];
  projectileTravelMs?: number;
  cadenceTicks?: number;
  /** Multi-clip attacks (Bowman draw→loose) cannot be represented by one fps. */
  authoredCycleMs?: number;
  authoredReleaseMs?: number;
}
export const AUTHORED_ATTACK_TIMINGS = {
  highlander: { technique: 'strike', mode: 'melee', frames: 6, fps: 12, releaseFrame: 2, contactFrames: [2] },
  bowman: { technique: 'arrow', mode: 'projectile', clips: [{ frames: 6, fps: 14 }, { frames: 4, fps: 20 }],
    contactFrames: [0], authoredCycleMs: 629, authoredReleaseMs: 429, projectileTravelMs: 950 },
  kegrunner: { technique: 'detonate', mode: 'detonate', frames: 6, fps: 13, releaseFrame: 1, contactFrames: [1] },
  tunneler: { technique: 'strike', mode: 'melee', frames: 6, fps: 13, releaseFrame: 3, contactFrames: [3] },
  turrider: { technique: 'strike', mode: 'melee', frames: 6, fps: 13, releaseFrame: 3, contactFrames: [3] },
  plunderer: { technique: 'strike', mode: 'melee', frames: 6, fps: 14, releaseFrame: 3, contactFrames: [3] },
  giant: { technique: 'strike', mode: 'melee', frames: 8, fps: 11, releaseFrame: 4, contactFrames: [4] },
  giantBoulder: { technique: 'boulder', mode: 'projectile', frames: 6, fps: 12, releaseFrame: 3, contactFrames: [3], projectileTravelMs: 1_045 },
  trollTroop: { technique: 'slam', mode: 'melee', frames: 8, fps: 12, releaseFrame: 4, contactFrames: [4] },
  trollBuilding: { technique: 'slam', mode: 'melee', frames: 6, fps: 11, releaseFrame: 3, contactFrames: [3] },
  dragon: { technique: 'breath', mode: 'stream', frames: 8, fps: 12, releaseFrame: 3, contactFrames: [3, 4, 5] },
  /** M22 Dragon-Nest defender: six-frame authored hatchling attack, released
   * from its published maw onto the small direction-baked fire projectile. */
  wyrmling: { technique: 'breath', mode: 'projectile', frames: 6, fps: 12, releaseFrame: 3, contactFrames: [3], projectileTravelMs: 420 },
  mage: { technique: 'bolt', mode: 'projectile', frames: 8, fps: 13, releaseFrame: 4, contactFrames: [4], projectileTravelMs: 855 },
  bilgewraith: { technique: 'strike', mode: 'melee', frames: 6, fps: 13, releaseFrame: 3, contactFrames: [3] },
  gloamfang: { technique: 'rend', mode: 'melee', frames: 6, fps: 14, releaseFrame: 2, contactFrames: [2], cadenceTicks: 10 },
  direFirestorm: { technique: 'firestorm', mode: 'stream', frames: 8, fps: 11, releaseFrame: 1, contactFrames: [6], cadenceTicks: 50 },
  direMaul: { technique: 'maul', mode: 'melee', frames: 6, fps: 12, releaseFrame: 2, contactFrames: [2], cadenceTicks: 80 },
  hexbarrow: { technique: 'hexshot', mode: 'projectile', frames: 6, fps: 12, releaseFrame: 2, contactFrames: [2], projectileTravelMs: 855, cadenceTicks: 25 },
  barrowling: { technique: 'claw', mode: 'melee', frames: 4, fps: 16, releaseFrame: 1, contactFrames: [1], cadenceTicks: 10 },
} as const satisfies Record<string, AuthoredAttackTiming>;

/** Defense projectile clocks. V2 Cannon/Mortar include the frame-3 release;
 * legacy/epic towers release at event time and retain their authored flights. */
export const DEFENSE_PROJECTILE_TIMINGS = {
  cannon: { releaseOffsetMs: 143, flightMs: 950 },
  archertower: { releaseOffsetMs: 0, flightMs: 420 },
  mortar: { releaseOffsetMs: 143, flightMs: 1_235 },
  airdefence: { releaseOffsetMs: 0, flightMs: 650 },
  electrictower: { releaseOffsetMs: 0, flightMs: 300 },
  magetower: { releaseOffsetMs: 0, flightMs: 500 },
  lasertower: { releaseOffsetMs: 0, flightMs: 100 },
} as const satisfies Record<Exclude<DefenseType, 'dragonnest'>,
  { releaseOffsetMs: number; flightMs: number }>;

// ---------------------------------------------------------------------------
// Base camera — presentation-only framing (owner 2026-08-13: narrow phones must
// be able to fit the current claim while aligning buildings and walls).
// ---------------------------------------------------------------------------

export const BASE_CAMERA = {
  /** Normal readability floor; safe-rect fitting may go slightly below it. */
  minZoom: 0.20,
  /** Emergency floor for unusually small webviews. */
  absoluteMinZoom: 0.14,
  /** Authored close-up ceiling retained from HANDOFF §5.2. */
  maxZoom: 1.6,
  /**
   * Breathing room around the live server claim, in tiles per side — the ONE
   * number that decides how much world the base view opens on, and therefore
   * how big every building, wall and troop reads on screen.
   *
   * 1.5 → 4 (owner 2026-08-30: buildings, walls, defences and the hero altar
   * "read too big"). Measured, the art was not the cause: no family draws wider
   * than ~1.3× its own footprint, and a wall segment is exactly 1.00 tile wide.
   * The framing was. `fitBaseCamera` opens on `claim + 2 × this`, so a fresh
   * 14-tile claim was framed in 17 tiles — the outer wall ring 1.5 tiles from
   * the edge of the safe rect, with HUD chrome over the top of it. Worse, the
   * SAME number sets the zoom FLOOR, so on a desktop the floor and the fit
   * coincided and the player could not pull back at all: 17 tiles was both the
   * opening framing and the widest view obtainable.
   *
   * 4 frames a fresh claim in 22 tiles — everything on screen at 77% of its
   * former size, art untouched — and leaves real room to zoom out beneath it.
   * It is deliberately ABSOLUTE, not proportional: a fully expanded 26-tile
   * claim goes 29 → 34 tiles (−15%), so the correction lands where the
   * magnification actually was, on a small base.
   */
  fitPadTiles: 4,
  /** Grass outside the plot; 34 tiles keep the canonical 915×311 Seeker webview
   * covered while its max claim plus breathing room fits above the HUD. */
  skirtTiles: 34,
  /** One deliberate HUD zoom step; the inverse is used for zoom-out. */
  zoomStep: 1.18,
  /** Placement guide strokes in SCREEN px, preserved as the camera zoom changes. */
  placementGridLinePx: 1,
  placementOutlinePx: 3,
  placementFootprintPx: 4,
  /** Persistent claim read: broken earth-toned strokes plus sparse stones,
   * never a filled/boxed plot. Values are world-pixel presentation only. */
  claimPerimeterLinePx: 2,
  claimPerimeterColor: 0x9b8458,
  claimPerimeterAlpha: 0.48,
  claimPerimeterStoneAlpha: 0.72,
  claimPerimeterDashMinTiles: 0.42,
  claimPerimeterDashJitterTiles: 0.28,
  claimPerimeterGapMinTiles: 0.32,
  claimPerimeterGapJitterTiles: 0.24,
  claimPerimeterWobbleTiles: 0.045,
  claimPerimeterStoneOffsetTiles: 0.18,
} as const;

// ---------------------------------------------------------------------------
// Raid camera — the BATTLE screen's camera + gesture band (owner 2026-07-29:
// "the raid is unplayable on a phone"). The battlefield is plot 30 + a 4-tile
// deploy margin each side = 38 tiles = 2432 world px; at the old hardcoded
// zoom 0.5 a 390px phone showed 12 of those 38 columns with NO pan and NO
// pinch, so most of the base and most of the deploy ring were unreachable.
//
// PRESENTATION ONLY. Nothing here reaches packages/sim: the camera changes
// which tiles you can SEE and TAP, never which events are applied — a deploy
// still goes through the one `deployValid` gate in RaidUI and is stamped by
// order, not by wall-clock, so replay parity is untouched.
// ---------------------------------------------------------------------------

export const RAID_CAMERA = {
  /** Hard zoom floor. Pulled all the way back a 390px phone needs 390/2432 =
   * 0.16 to hold the entire 38-tile field, so the floor sits just under that;
   * the scene computes its own per-device floor and never goes below this. */
  minZoom: 0.14,
  /** Hard zoom ceiling — parity with BASE_CAMERA.maxZoom (owner 2026-08-15,
   * M23 a1: the enemy base must be inspectable at the same closeness as your
   * own; the old 1.2 made attack views read smaller than home views). */
  maxZoom: 1.6,
  /** Cap on the ENTRY framing. Raised 0.6 → 1.1 (owner 2026-08-15, M23 a1):
   * the old cap bound exactly on large viewports, where an own-base entry
   * reaches ~1.1 for a fresh claim — so the attack view opened at nearly half
   * the size of the home view of the same base. 1.1 restores parity there
   * while noWaste/baseFits keep phone framing unchanged. */
  fitMaxZoom: 1.1,
  /** Extra tiles of breathing room around the fitted claim+deploy-ring box.
   * 0 since M23 a1: the ring's outer edge IS the frame — the old 1-tile skirt
   * only shrank the base on every screen for two tiles of empty margin. */
  fitPadTiles: 0,
  /** Render-only northern camera allowance (D-102). This lets a top-edge
   * deployment actor be panned completely below measured HUD chrome; it never
   * changes tile coordinates, deploy legality or simulator input. */
  northHeadroomWorldPx: 128,
  /** Screen px of raid HUD chrome reserved when fitting/centering: the battle
   * HUD's two pill rows at the top and the deploy tray at the bottom. The fit
   * targets the space BETWEEN them, or the base sits under the tray. */
  hudTopPx: 96,
  hudBottomPx: 152,
  /** Gap between the deploy tray's real measured top and the camera pills. The
   *  pills used to sit at a hardcoded 128px, which the two-row tray (152px)
   *  swallowed whole — the re-frame button was unreachable (verify 2026-07-29).
   *  Both the pill position and the fit now use the MEASURED tray; these two
   *  numbers are only the value used before the first measurement lands. */
  pillGapPx: 10,
  /** Movement (screen px) past which a press is a camera PAN, not a deploy.
   * Matches BaseScene's DRAG_THRESHOLD so both scenes feel identical. */
  panThresholdPx: 12,
  /** A press must stay inside panThresholdPx this long before the hold-to-deploy
   * stream starts. Below this a press is still an ordinary tap, above it the
   * finger is clearly parked — this is what makes "drag = pan" and "hold = spray"
   * separable at all (previously the first repeat beat fired at 120ms, so any
   * pan attempt longer than 120ms silently dropped units). */
  holdConfirmMs: 260,
  /** Multiplier per tap of the battle HUD's − / + zoom pills (desktop + a11y
   * path for anyone who cannot pinch). */
  zoomStep: 1.25,
} as const;

// ---------------------------------------------------------------------------
// Mining — ECONOMY.md (FIXED per-mine contribution, ✅ LOCKED 2026-06-13).
// SUPERSEDES the GDD §4.4 power-weighted pool-split: there is no pro-rata pool
// share, no mine×streak×league×seeker×newcomer power, no 4.0 hard cap. Each
// Mine contributes a fixed daily quota; the per-base result sums all physical
// Mines and fills their 1-day storage buffers. The player COLLECTs it;
// production pauses when full (nothing is ever seized).
// Computed in PURE INTEGER basis points (no float in balances, CLAUDE.md rule):
//   dailyQuota = MINE_QUOTA_BASE × sum(MINE_MULT_BPS[each mineLv])
//                × KEEP_MULT_BPS[keepLv] × consistency × epoch × referral
// ---------------------------------------------------------------------------

export const MINING = {
  /** PER-MINE daily income anchor: one L1 Mine at L1 Keep, no streak = 500
   * shards/day. Owner 2026-07-19: mining is now the SUM over ALL mines (each
   * × its own level multiplier), not a single per-player quota keyed on the
   * highest mine — so more mines = proportionally more passive income. A lone
   * L1 mine is unchanged (500/day). */
  MINE_QUOTA_BASE: 500,
  /** Max mines a player may own, gated by Keep level 1..20 (base-level gate):
   * min(8, keep+1) — economy-tuned so a maxed base's mining stays under the
   * withdrawal cap (owner 2026-07-20; was L1-5 → 2..6). */
  MAX_MINES_BY_KEEP: [2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8],
  /** Progressive game-currency cost to BUILD the Nth mine (index 0 = the 1st
   * mine). The first costs SHARDS; mines 2–8 charge the listed amount in KEEP,
   * which recycles to emission_pool. Each next mine costs much more, so linear
   * per-mine income meets a super-linear acquisition curve. */
  MINE_BUILD_KEEP: [400, 1_500, 4_000, 10_000, 22_000, 45_000, 80_000, 130_000],
  /** Progressive SOL cost (lamports) to build the Nth mine — ALL ZERO since
   * D-057. Owner 2026-08-16 (verbatim): "we should not gate miners with sol at
   * start" — BUILDING a mine (any count) is SOL-free; mines 2+ charge only the
   * progressive MINE_BUILD_KEEP above, through POST /base/buildings.
   * The array is deliberately RETAINED (not deleted): creditDeposit →
   * applyMineBuild still price-checks IN-FLIGHT pre-D-057 'mine_build' intents
   * against it, and any already-paid amount ≥ 0 passes — so a player whose SOL
   * was in flight at the cutover is never stranded. New 'mine_build' intents
   * are refused at creation (money/deposits.ts). */
  MINE_BUILD_SOL_LAMPORTS: [0, 0, 0, 0, 0, 0, 0, 0],
  /** Fixed-point ONE — all mining multipliers are basis points (×/BPS_ONE), so
   * the quota is computed in pure bigint integer math (NO float in balances,
   * CLAUDE.md hard rule). ECONOMY.md §2. */
  BPS_ONE: 10_000,
  /** Mine upgrade multiplier in bps, mine level 1–20 (owner 2026-07-20, RETUNED so
   * a fully-maxed base tops out at ~250k SHARDS/day, down from ~806k). L1 stays ×1.0
   * (a lone L1 mine still earns 500/day — early game unchanged); the L20 top drops
   * from ×12 to ×6.68, keeping the same relative pacing. Income ∝ M², so at
   * 8×L20 mines + L20 keep + streak the daily quota ≈ 500×8×6.68×6.68×1.4 ≈ 250k —
   * This is a base-currency progression rate, not withdrawable KEEP; the bounded
   * Gold Forge is the only gameplay path from contributed SHARDS to KEEP. */
  MINE_MULT_BPS: [10_000, 13_600, 18_800, 25_500, 32_700, 35_000, 37_300, 39_500, 41_800, 44_100, 46_400, 48_600, 50_900, 53_200, 55_400, 57_700, 60_000, 62_300, 64_500, 66_800],
  /** Keep upgrade multiplier in bps, keep level 1–20 (same curve as MINE_MULT_BPS). */
  KEEP_MULT_BPS: [10_000, 13_600, 18_800, 25_500, 32_700, 35_000, 37_300, 39_500, 41_800, 44_100, 46_400, 48_600, 50_900, 53_200, 55_400, 57_700, 60_000, 62_300, 64_500, 66_800],
  /** "Day-7 mining bonus": ×1.4 (14000 bps) when the cache streak ≥ 7 days (ECONOMY.md §2/§3). */
  CONSISTENCY_BPS: 14_000,
  CONSISTENCY_STREAK_DAYS: 7,
  /** Storage buffer holds one day's quota; full → production pauses, nothing
   * lost (ECONOMY.md §2). */
  MINE_STORAGE_DAYS: 1,
  /** Mainnet sustainability knob (ECONOMY.md §6 epoch base-rate halving) in bps:
   * multiplies the whole quota. 10000 (=1.0) on devnet — never touched. */
  EPOCH_RATE_BPS: 10_000,
  /** SOL (lamports) to upgrade a Mine TO the keyed TARGET level — D-057.
   * Owner 2026-08-16 (verbatim): "we should not gate miners with sol at start,
   * mines should be paid to upgrade from level 5, 6,7,8 levels start with 0.5
   * sol pricing." Upgrades to L2–L4 are SOL-free (shards only, through the
   * normal upgrade route); a missing key means that target level charges no
   * SOL. L5 = the owner-set 0.5 SOL entry price. Paid as a direct SOL transfer
   * 100% to the LIQUIDITY wallet ('mine' deposit intent), verified at
   * finalized before the upgrade applies — same routing as before D-057.
   *
   * ⚠⚠ ASSUMPTION — THE OWNER SET ONLY THE L5 ENTRY PRICE (0.5 SOL); the rest
   * of this curve is agent-chosen and the owner may retune every entry:
   *   - L6/L7 = 0.65 / 0.85 SOL — a modest progression from the 0.5 entry,
   *     NOT owner numbers. L8 = 1.04 SOL, deliberately the OLD L7→8 price
   *     (not a rounder 1.1): every new price must stay ≤ its pre-D-057 quote
   *     or an in-flight payment frozen at the old price 409s at credit and
   *     strands a paid player (security review 2026-08-16 finding 1).
   *   - L9–L20 carry the pre-D-057 curve forward UNCHANGED (those exact prices
   *     were already live for these steps); the directive only ungated the
   *     START, so deep-level monetization was not silently deleted. If the
   *     owner meant "SOL only on 5/6/7/8", delete the 9–20 keys.
   *   - ⚠ WHEN RETUNING: never raise a step above its previously-published
   *     price while any deposit intent could be in flight (the credit rule
   *     honours frozen quote ≥ current table only).
   * Look up via upgradeSolLamports('mine', targetLevel). */
  UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL: {
    5: 500_000_000, 6: 650_000_000, 7: 850_000_000, 8: 1_040_000_000,
    9: 1_220_000_000, 10: 1_400_000_000, 11: 1_580_000_000, 12: 1_760_000_000,
    13: 1_940_000_000, 14: 2_120_000_000, 15: 2_300_000_000, 16: 2_480_000_000,
    17: 2_660_000_000, 18: 2_840_000_000, 19: 3_020_000_000, 20: 3_200_000_000,
  } as Readonly<Record<number, number>>,
} as const;

/**
 * SOL price (lamports) to upgrade `type` TO `targetLevel` — 0 when that step
 * charges no SOL (which is also the answer for every un-gated building type).
 * D-057: exactly two buildings are SOL-gated — the Mine (targets L5+) and the
 * Gold Forge (targets L2+). SERVER-authoritative: apps/api prices every paid
 * upgrade from this helper, and the web client may only use it to decide which
 * levels DISPLAY a SOL price.
 */
export function upgradeSolLamports(type: string, targetLevel: number): number {
  if (type === 'mine') return MINING.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL[targetLevel] ?? 0;
  if (type === 'goldforge') return FORGE.UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL[targetLevel] ?? 0;
  return 0;
}

// ---------------------------------------------------------------------------
// Treasury-aware emission controller (owner 2026-07-20, #45). MINING.EPOCH_RATE_BPS
// is the COMPILE-TIME baseline (10000 = 1.0×); at runtime a 10-min job drives an
// emissionMultBps in game_config between these bounds so mining THROTTLES as the
// 500M pool drains, as 24h withdrawal outflow spikes, or as the active-player crowd
// floods (the player-cap analysis: a 500M pool cannot fund 100k+ maturing bases, so
// per-player emission must fall as N grows). These are the ONLY controller numbers;
// the policy that reads them is pure `emissionTargetBps()` in shared/mining.ts.
// ---------------------------------------------------------------------------

export const EMISSION_CONTROL = {
  /** Runtime multiplier bounds (bps). maxBps = MINING.EPOCH_RATE_BPS = 1.0× (full
   *  nominal emission); minBps = 0.1× (hardest throttle, 10% floor). */
  minBps: 1_000,
  maxBps: 10_000,
  /** POOL signal: at ≥healthyPct of the 500M pool remaining → no pool throttle
   *  (maxBps); at ≤criticalPct → floor (minBps); linear between. */
  poolHealthyPct: 50,
  poolCriticalPct: 10,
  /** OUTFLOW signal: rolling-24h withdrawal outflow as a fraction of the REMAINING
   *  pool, in bps. ≤softBps (1%/day) → no throttle; ≥hardBps (6%/day) → floor;
   *  linear between. Slows minting precisely when KEEP is leaving custody fast. */
  outflowSoftBps: 100,
  outflowHardBps: 600,
  /** CROWD signal: active players (last 24h) at/under baseline → no throttle;
   *  above, throttle ∝ baseline/active (so ~2× baseline ≈ 0.5×, ~15× ≈ floor).
   *  Baseline ≈ the simulated stable "climbing" cap (~1,300–1,500). */
  crowdBaseline: 1_500,
  /** Asymmetric smoothing per 10-min tick (bps): cut fast, recover slow — a
   *  transient outflow spike throttles within ~2–3 ticks but eases back over
   *  hours, so the rate can't oscillate. */
  cutStepBps: 4_000,
  recoverStepBps: 500,
  /** Active-player window (sec) for the crowd signal (players.lastSeenAt within). */
  activeWindowSec: 86_400,
} as const;

// ---------------------------------------------------------------------------
// Warzone / shieldless windows (owner 2026-07-20, #46). Two modes, switchable via
// a runtime lever (game_config.shieldlessMode): a PREDICTABLE 'scheduled' weekend
// window (players know when), and an UNANNOUNCED 'purge' (admin sets a start/end no
// endpoint ever reveals). During a window ALL bases are attackable (individual
// shields are SUPPRESSED, not deleted, so they resume after) — but a given defender
// is hittable only once per attackCooldownHours ("attackable every 4h"). The number
// source of truth; the predicate is game/warzone.ts.
// ---------------------------------------------------------------------------

export const WARZONE = {
  /** No-shield window length — 48h for both scheduled + purge. */
  durationHours: 48,
  /** Per-defender attack cooldown DURING a window (any attacker): a base becomes
   *  attackable again every this-many hours. Outside a window the once/day-per-
   *  attacker rule (attackedToday) applies instead. Supersedes the (unused)
   *  RAID_RULES.sameTargetCooldownHours during warzones. */
  attackCooldownHours: 4,
  /** SCHEDULED window: opens weekly on this UTC weekday/hour (0=Sun … 6=Sat) and
   *  runs durationHours. Default = the whole weekend (Sat 00:00 UTC → Mon 00:00). */
  scheduledStartDayUtc: 6,
  scheduledStartHourUtc: 0,
  /** Client cadence for re-reading CURRENT phase. Runtime mode changes can
   * supersede a disclosed boundary; polling current truth also discovers an
   * ops-started purge without disclosing its future start time. */
  currentPhasePollSec: 60,
  /** WARZONE SHIELD (owner 2026-07-20): the ONLY protection usable during a warzone.
   *  Normal loss-shields are suppressed while a window is open; a player can pay for
   *  THIS shield to stay protected. Buyable ONLY while a warzone is active. 10 SOL,
   *  48h. SOL routing intent: 50% straight to the liquidity pool + 50% via the usual
   *  dev/mkt/ops split (solSplitBps) — see money/ wiring for the on-chain path. */
  shieldCostSolLamports: 10_000_000_000, // 10 SOL
  shieldDurationHours: 48,
  /** Of the SOL paid, the fraction (bps) routed STRAIGHT to liquidity; the rest
   *  flows through the normal solSplitBps (dev/mkt/ops) buy_sink split. */
  shieldLiquidityDirectBps: 5_000, // 50%
} as const;

// ---------------------------------------------------------------------------
// Daily Shard Cache — ECONOMY.md §3. Small flat streak reward (NOT emission-
// split), separate from mining. First week onboarding ladder, then 500/100 by
// consistency; reaching a 7-day streak flips on the MINING.CONSISTENCY_BPS bonus.
// ---------------------------------------------------------------------------

export const DAILY_CACHE = {
  /** First week ever (one-time): cacheShards = streak × this → D1 100 … D7 700. */
  firstWeekStepShards: 100,
  /** Lifetime, after week 1, when streak ≥ 7 (consistent). */
  consistentShards: 500,
  /** Lifetime, after week 1, when streak < 7 (rebuilding after a miss). */
  baseShards: 100,
  /** Streak length that earns consistentShards + turns on the mining bonus. */
  consistencyStreakDays: 7,
} as const;

// ---------------------------------------------------------------------------
// Target TGE supply & allocation — GDD §4.2. These constants describe the
// intended mainnet model and the legacy allocation bootstrap; they are NOT a
// statement of the current branded devnet mint. RPC verification on 2026-08-18
// found that mint at 500M KEEP with mint + freeze authorities still enabled.
// ---------------------------------------------------------------------------

/** Historical devnet ledger allocation retired 2026-08-18. Kept only so the
 * append-only reconciliation can validate the exact legacy genesis posting;
 * it is not an active reward budget or a mainnet allocation decision. */
export const LEGACY_QUEST_KEEP_ALLOCATION = 50_000_000;

export const TOKEN = {
  /** On-chain SPL metadata (Pixel Kingdom Wars rebrand). Ticker stays KEEP so no
   *  in-game copy changes; the mint's metadata name is the full currency name. */
  name: 'Pixel Kingdom Gold',
  symbol: 'KEEP',
  totalSupply: 1_000_000_000,
  decimals: 9,
  /** Allocation buckets, GDD §4.2 — sums to totalSupply. */
  allocation: {
    playPool: 500_000_000,   // 50% play mining emissions
    liquidity: 100_000_000,  // 10% TGE liquidity (LP burned)
    team: 150_000_000,       // 15% — 12-mo cliff, 36-mo vest
    ecosystem: 100_000_000,  // 10% Solana Mobile campaigns/creators
    // Former 5% quest allocation. Quests are SHARDS-only; the final mainnet
    // assignment remains deliberately unallocated until the launch ceremony.
    unallocated: LEGACY_QUEST_KEEP_ALLOCATION,
    treasury: 100_000_000,   // 10% multisig reserve
  },
} as const;

/** D153.331 (owner 2026-10-03; review 5dd99ced), using GDD §4.2 playPool:
 * the new Phase E devnet KEEP genesis goes only to RESERVE. Gems are custodial;
 * no Gems-reserve allocation or other TGE bucket is minted by this ceremony. */
export const PHASE_E_KEEP_V4_GENESIS = { reserve: TOKEN.allocation.playPool } as const;

// ---------------------------------------------------------------------------
// Referrals — v2 mining-bonus model (owner 2026-08-15, M23 a16; D-052).
// STRICTLY ONE LEVEL; never multi-tier. Supersedes the GDD §5 5%-match:
// "1 referral = 0.5% increased mining reward but only if referred user has
//  minted land deed and got to 3 level KEEP … if your referred user is
//  inactive more than 7 days reward for it disappears … real referred user is
//  land deed, that land deed stays your referral … if its on market not
//  active player then no reward for it."
// The anti-sybil bound survives the redesign: each bonus point still costs a
// real 0.2 SOL deed mint (security review 2026-08-09 F4 reasoning), and the
// bonus pays nothing while the referred deed is sold or its player is gone.
// ---------------------------------------------------------------------------

export const REFERRALS = {
  /** +0.5% mining per ACTIVE qualified referral, in basis points, stacking
   * additively and applied as one integer-bps factor in getMiningQuota. */
  miningBonusBpsPerReferral: 50,
  /** Qualification: the referred player MINTED THEIR LAND DEED and reached
   * Keep L3 (owner 2026-08-15; was L2 + 7 account-age days under the match
   * model). Qualification is sticky; ACTIVITY is what gates the payout. */
  qualifyKeepLevel: 3,
  /** The bonus LAPSES while the referred player has been inactive longer than
   * this (players.last_seen_at) or no longer owns an active paid deed; it
   * resumes when they return. Enforced where the money moves — at quota
   * computation — never only in a cron. */
  inactivityLapseDays: 7,
  /** A referral code can only be USED within this many days of account creation
   * (anti-backfill). Economy v2 dropped the referee mining-power bonus, but the
   * onboarding window to redeem a code is preserved (was MINING.refereeDays). */
  useWindowDays: 14,
  /** How many closed-alpha ADMISSIONS one player's code may grant (security
   * review 2026-08-15 F2: admin invite codes are single-use; a publicly
   * shared referral link must not open the whole alpha). Matches the ops
   * brief's 25–50 cohort batches; the mining-bonus stack itself is separate
   * and remains uncapped under D-052. */
  maxAlphaAdmissionsPerReferrer: 25,
} as const;

// ---------------------------------------------------------------------------
// Ranked leagues — owner 2026-08-30. Trophies are cumulative: Monday closes a
// reward window but never resets or decays the ladder. Rewards are deed-owned
// SHARDS + deterministic consumables only. There is no KEEP/SOL pool, raid
// tithe, energy grant, random roll, or season-reset interpretation.
// ---------------------------------------------------------------------------

export const LEAGUES = {
  /** Minimum cumulative trophies for bronze/silver/gold/sol. */
  thresholds: [0, 10, 50, 150],
  /** Monday 00:00 UTC earning-window start for the first paid alpha week. */
  rewardStartWeek: '2026-09-07',
  /** First full-window settlement: Sep 7–14 closes, then pays at 00:15 UTC. */
  firstSettlementAt: '2026-09-14T00:15:00.000Z',
  /** The immutable input snapshot is taken at the boundary, before the gap. */
  closeCron: '0 0 * * 1',
  /** Whole finalized ownership sweeps are retried; waves from different attempts
   * or bank slots are never mixed into one reward snapshot. */
  closeAuthoritySweepAttempts: 3,
  closeAuthoritySweepRetryMs: 250,
  /** 160 supported deeds / 32 accounts per finalized transport wave. */
  closeAuthorityMaxConcurrentWaves: 5,
  /** BullMQ retries cover a coincident boundary mutation or unhealthy RPC. */
  closeSnapshotAttempts: 6,
  closeSnapshotRetryMs: 5 * 1_000,
  /** Durable boundary watchdog. Five-minute cadence retries inside the 00:15
   * window and keeps running afterward, so DB/RPC recovery cannot require a
   * worker restart to release a missing-close mutation fence. */
  closeRecoveryCron: '*/5 * * * *',
  /** Frozen receipts become drainable only after this post-close review gap. */
  settlementDelayMs: 15 * 60 * 1_000,
  /** Exactly one production scheduler owns the payout job. */
  settlementCron: '15 0 * * 1',
  /** Retry any frozen-but-unsettled per-base receipt after a worker failure. */
  reconcileMs: 15 * 60 * 1_000,
  /** Bounded recovery batch; a failed base cannot starve the remaining week. */
  settlementBatchSize: 100,
  /** Resolved attacker-side deed PvP raids required inside the closed week. */
  rewardMinAttackerRaids: 3,
  /** Multi-deed wallets receive at most one cache per week. */
  rewardsPerWalletMax: 1,
  /**
   * Bronze cache by Keep level, index 0 = Keep 1. Owner-approved conservative
   * alpha ladder (2026-08-30), approximately one tenth of a mining day before
   * the tier multiplier. It is intentionally bounded at 17,000 for Keep 20.
   */
  weeklyCacheShardsByKeepLevel: [
       150,    200,    350,  1_000,  2_000,
     3_000,  5_000,  5_500,  6_500,  7_000,
     8_000,  9_000, 10_000, 11_000, 12_000,
    13_000, 14_000, 15_000, 16_000, 17_000,
  ],
  /** Bronze/Silver/Gold/Sol = 1×/2×/4×/6× the Keep-level cache. */
  cacheTierMultBps: { bronze: 10_000, silver: 20_000, gold: 40_000, sol: 60_000 },
  /** Deterministic, stackable consumables. No Powder, Aegis, gear, or writs. */
  weeklyItemsByTier: {
    bronze: [{ itemId: 'keg_of_haste', qty: 1 }],
    silver: [{ itemId: 'keg_of_haste', qty: 2 }],
    gold: [{ itemId: 'finishers_seal', qty: 1 }],
    sol: [{ itemId: 'finishers_seal', qty: 1 }, { itemId: 'keg_of_haste', qty: 2 }],
  },
} as const;

// League v2: D153.277/.278; values approved by D153.285 (2026-10-02).
// Additive to LEAGUES: installed clients retain the four-tier cumulative model.
// D153.287 final ruling excludes crystal fragments from all league rewards.
export const PHASE_E_LEAGUE_TIERS = {
  status: 'APPROVED',
  tiers: ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'solana', 'seeker'],
  thresholds: [0, 100, 300, 800, 2_000, 5_000, 10_000],
} as const;

/** D153.278 §6: changing reward tuning requires a new version. */
export const PHASE_E_LEAGUE_REWARDS = {
  currentPolicyVersion: 1,
  v1: {
    status: 'APPROVED',
    policyVersion: 1,
    // D153.278 §1, approved D153.285 answer 3; fixed per eligible base/week.
    fixed: {
      shards: { bronze: 5_000, silver: 7_500, gold: 10_000, platinum: 15_000, diamond: 22_500, solana: 32_500, seeker: 50_000 },
      gems: { bronze: 150, silver: 200, gold: 275, platinum: 375, diamond: 500, solana: 700, seeker: 1_000 },
    },
    // D153.278, approved D153.285 answer 4: raw realm resources only.
    pack: {
      rawUnitsByTier: { bronze: 20, silver: 35, gold: 60, platinum: 100, diamond: 160, solana: 250, seeker: 400 },
      rareResourceCount: 2,
      rareFromTier: 'gold',
      // Frozen D-128 deedable tile counts (fantasy-world-v1.json).
      frequencyWeights: { frost_quartz: 13_126, heartwood_logs: 13_610, sunstone_rubble: 13_925, crown_iron_ore: 12_959,
        rough_prism: 5_582, storm_ore: 15_270, thorn_fibre: 6_705, ember_nodules: 4_237 },
    },
    skr: {
      // D153.342 (4b38e1d8): owner-approved claim window from on-chain opening.
      claimWindowSec: 2_419_200,
      // review 679d2d57: leader-default extension ceiling, flagged to the owner.
      claimWindowMaxSec: 4_838_400,
      // D153.286 answer 8: the weekly season ranks net trophy change.
      ranking: 'weekly_net',
      minWeeklyScore: 1,
      // D153.277 §2, approved D153.285 answer 2: dust/unfilled places carry.
      maxPlaces: 500,
      basisPoints: 10_000,
      band1PlaceBps: [600, 450, 360, 300, 270, 240, 220, 200, 190, 170],
      band2: { firstPlace: 11, lastPlace: 100, bps: 3_500 },
      band3: { firstPlace: 101, lastPlace: 500, bps: 3_500 },
    },
  },
} as const;

/**
 * DEVNET TEST VALUE, NOT AN OWNER NUMBER (overnight builder, 2026-10-06).
 * The weekly SKR season pot is still owed by the owner: leader handoff
 * 2026-10-05 B9 "Blocked on an owner number: the weekly SKR pot amount" and
 * its open owner question 4. This value only lets the read-only Leagues PRIZE
 * view (GET /leagues/season) show a labelled TEST pot on devnet, and only while
 * LEAGUE_SEASON_TEST_POT_ENABLED=true. It funds, allocates, records and pays
 * nothing. Replace it with the owner's number and decision id before any claim
 * route or allocation reads a pot.
 */
export const LEAGUE_SEASON_TEST_POT = {
  status: 'DEVNET_TEST_AWAITING_OWNER',
  cluster: 'devnet',
  /** 10,000 test SKR at 6 decimals (raw base units). */
  potRaw: '10000000000',
  decimals: 6,
} as const;

/** Read-only season view (overnight builder, 2026-10-06): how often an open
 * Leagues card re-reads GET /leagues/season. Presentation cadence, not tuning. */
export const LEAGUE_SEASON_VIEW = {
  refreshAfterSec: 60,
} as const;

// ---------------------------------------------------------------------------
// Quests — GDD §5 (Quest Board).
//
// REWARDS ARE SHARDS, minted from shard_genesis (locked owner decision
// 2026-08-09, docs/LAND-DEED-ONBOARDING-PLAN.md §7 Q3). Every `rewardShards`
// number below was ALWAYS named shards, but the API credited them as KEEP out of
// the capped quest_bucket until 2026-08-09; the constants were right and the
// ledger was wrong. Quests are the one earner that stays FREE under free
// onboarding, and only KEEP is withdrawable, so paying shards is what makes a
// deedless quest board safe. Do not reintroduce a KEEP reward here.
// ---------------------------------------------------------------------------

/** Owner 2026-09-08: first-army tutorial has one wallet-scoped free queue finish. */
export const TRAINING_FIRST_FINISH = { offer: 'first_troops', usesPerWallet: 1 } as const;

/** Owner 2026-09-08 reliability plan: bounded finalized reads and fresh snapshot evidence. */
export const MINT_INVENTORY = { maxScanAttempts: 3, scanDeadlineMs: 20_000, receiptFreshnessMs: 60_000 } as const;

export const QUESTS = {
  /** The daily bonus pays when this many dailies are CLAIMED in one UTC day
   * (owner 2026-08-16: the whole pool is live simultaneously — "only 3
   * visible still. Needs fix" — superseding the GDD §5 3-slot rotation; the
   * bonus keeps its historical size and its 3-claim trigger). */
  dailyBonusAt: 3,
  /**
   * Daily template pool. The FIRST 12 ids are the original GDD §5 pool and are
   * FROZEN — live quest rows key on templateCode, so an id/target/reward change
   * would silently orphan production progress. The rest are the M23 a15
   * expansion (owner 2026-08-15: "at least 50 interesting, fully working
   * quests") — every id here has a real server-side progression hook in
   * apps/api (raids/base/army/world/baseMining/emission/forge/heroes/spend);
   * a template without a hook must not ship. Rewards 10–30 shards, scaled to
   * effort within the owner's 10–40 band (owner 2026-08-15, M23 a15).
   */
  dailyTemplates: [
    { id: 'win_2_star',        name: 'Win a raid with 2★',           rewardShards: 20 },
    { id: 'steal_500',         name: 'Steal 500 Shards',             rewardShards: 20 },
    { id: 'two_keg_runners',   name: 'Use 2 Keg Runners in one raid', rewardShards: 15 },
    // Owner 2026-08-23 (D-069): PvE is the CAMPAIGN only; the Ruined Keep camps are
    // gone from the world, so these three ids (kept stable for existing progress
    // rows) now count Campaign stage clears.
    { id: 'clear_ruined_keep', name: 'Clear a Campaign stage',        rewardShards: 15 },
    { id: 'upgrade_any',       name: 'Upgrade any building',         rewardShards: 15 },
    { id: 'defend_success',    name: 'Defend successfully',          rewardShards: 30 },
    { id: 'spend_200',         name: 'Spend 200 Shards',             rewardShards: 15 },
    { id: 'scout_3',           name: 'Scout 3 bases',                rewardShards: 10 },
    { id: 'place_5_walls',     name: 'Place 5 wall segments',        rewardShards: 10 },
    { id: 'train_tur_rider',   name: 'Train a Tur Rider',            rewardShards: 15 },
    { id: 'all_3_buffs',       name: 'Use all 3 buffs in one raid',  rewardShards: 30 },
    { id: 'win_from_map',      name: 'Win from the World Map',       rewardShards: 20 },
    // --- M23 a15 expansion (owner 2026-08-15) — raiding ---
    { id: 'win_3_star',        name: 'Win a raid with 3★',           rewardShards: 30 },
    { id: 'win_2_raids',       name: 'Win 2 raids',                  rewardShards: 30 },
    { id: 'raid_3_times',      name: 'Go raiding 3 times',           rewardShards: 20 },
    { id: 'steal_1500',        name: 'Steal 1,500 Shards',           rewardShards: 30 },
    { id: 'earn_5_stars',      name: 'Earn 5 stars in raids',        rewardShards: 25 },
    { id: 'clear_2_keeps',     name: 'Clear 2 Campaign stages',      rewardShards: 25 },
    { id: 'vault_buster',      name: 'Destroy an enemy Vault',       rewardShards: 20 },
    { id: 'deploy_hero',       name: 'Send a hero into battle',      rewardShards: 10 },
    { id: 'hero_untouched',    name: 'Win with a hero, lose no hero', rewardShards: 25 },
    { id: 'deploy_20_troops',  name: 'Deploy 20 troops',             rewardShards: 20 },
    { id: 'use_5_highlanders', name: 'Deploy 5 Highlanders',         rewardShards: 10 },
    { id: 'use_5_bowmen',      name: 'Deploy 5 Bowmen',              rewardShards: 10 },
    { id: 'use_3_tunnelers',   name: 'Deploy 3 Tunnelers',           rewardShards: 15 },
    { id: 'use_3_tur_riders',  name: 'Deploy 3 Tur Riders',          rewardShards: 15 },
    { id: 'use_2_plunderers',  name: 'Deploy 2 Plunderers',          rewardShards: 10 },
    { id: 'use_2_giants',      name: 'Deploy 2 Giants',              rewardShards: 20 },
    { id: 'use_2_trolls',      name: 'Deploy 2 Trolls',              rewardShards: 20 },
    { id: 'use_a_dragon',      name: 'Deploy a Dragon',              rewardShards: 20 },
    { id: 'use_a_mage',        name: 'Deploy a Mage',                rewardShards: 20 },
    { id: 'use_war_horn',      name: 'Raid with the War Horn',       rewardShards: 15 },
    { id: 'use_swift_boots',   name: 'Raid with Swift Boots',        rewardShards: 15 },
    { id: 'use_powder_charge', name: 'Raid with a Powder Charge',    rewardShards: 15 },
    // --- campaign ---
    { id: 'campaign_clear',    name: 'Clear a campaign stage',       rewardShards: 20 },
    { id: 'campaign_3star',    name: 'Earn 3★ on a campaign stage',  rewardShards: 30 },
    { id: 'campaign_2_stages', name: 'Clear 2 campaign stages',      rewardShards: 30 },
    // --- building ---
    { id: 'upgrade_2_buildings', name: 'Start 2 building upgrades',  rewardShards: 25 },
    { id: 'upgrade_to_level_3',  name: 'Push a building to level 3+', rewardShards: 25 },
    { id: 'place_10_walls',    name: 'Place 10 wall segments',       rewardShards: 15 },
    { id: 'clear_obstacle',    name: 'Clear an obstacle',            rewardShards: 15 },
    // --- training ---
    { id: 'train_5_troops',    name: 'Train 5 troops',               rewardShards: 15 },
    { id: 'train_20_points',   name: 'Train 20 army points',         rewardShards: 25 },
    // --- economy ---
    { id: 'collect_mines',     name: 'Collect from your Mines',      rewardShards: 10 },
    { id: 'collect_1000_mined', name: 'Collect 1,000 mined Shards',  rewardShards: 25 },
    { id: 'claim_daily_cache', name: 'Claim the Daily Cache',        rewardShards: 10 },
    { id: 'spend_500',         name: 'Spend 500 Shards',             rewardShards: 25 },
    { id: 'forge_smelt',       name: 'Smelt Shards in the Gold Forge', rewardShards: 20 },
    // --- scouting / heroes ---
    { id: 'scout_1',           name: 'Scout an enemy base',          rewardShards: 10 },
    { id: 'upgrade_hero',      name: 'Upgrade a hero',               rewardShards: 25 },
  ],
  /** Complete all 3 dailies → bonus (GDD §5). */
  allThreeBonusShards: 25,
  weekly: { id: 'earn_8_stars', name: 'Earn 8 stars', goalStars: 8, rewardShards: 100 },
  /**
   * Weekly rotation pool (M23 a15, owner 2026-08-15): ONE weekly is live per
   * ISO week, picked deterministically from this pool by the API
   * (apps/api game/quests.ts weeklyQuestTemplateFor). `earn_8_stars` stays in
   * the pool and MUST keep matching `weekly` above (pinned by a shared test) —
   * progressWeeklyStars still keys on that id. All weeklies pay the original
   * weekly's 100 shards.
   */
  weeklyTemplates: [
    { id: 'earn_8_stars',     name: 'Earn 8 stars',           target: 8,    rewardShards: 100 },
    { id: 'win_10_raids',     name: 'Win 10 raids',           target: 10,   rewardShards: 100 },
    { id: 'steal_5000',       name: 'Steal 5,000 Shards',     target: 5000, rewardShards: 100 },
    { id: 'clear_5_keeps',    name: 'Clear 5 Campaign stages', target: 5,   rewardShards: 100 },
    { id: 'train_100_points', name: 'Train 100 army points',  target: 100,  rewardShards: 100 },
  ],
  /**
   * ONBOARDING CHAIN — the first-run path, in the order a new player walks it
   * (owner 2026-08-28: "onboarding should be quest driven"; the fuller ask names
   * the steps — "First level camp, mine, barracks everything that player can
   * build and also direct them to buy land and perform first raid").
   *
   * THE ARRAY ORDER IS THE CHAIN ORDER. The client walks it top to bottom and
   * shows exactly one step as the live objective; the API stores these as quest
   * rows of scope 'onboarding' on a single sentinel day, so they reuse the whole
   * existing quest machinery — same progress counters, same claim route, same
   * per-deed isolation — instead of a parallel progress system.
   *
   * THEY ARE NOT DAILIES AND MUST NOT BECOME ONE. The all-three daily bonus
   * counts `scope = 'daily'` rows only (game/quests.ts claimQuest), so nothing
   * here can pay it; a new player finishing their first base cannot mint the
   * daily bonus for each onboarding step.
   *
   * REWARDS ARE COPIED, NOT AUTHORED (2026-08-28, quest-onboarding lane): reward
   * balance is the owner's call, so every number below is an EXISTING daily's
   * value reused verbatim — 15 = upgrade_any (a build-a-thing quest), 30 =
   * defend_success (the top daily), 20 = win_2_star (a win-a-raid quest), and
   * 25 = train_20_points (owner 2026-09-05 training step). If the owner wants
   * the first-run path to pay differently, these six are the numbers
   * to move and nothing else depends on them.
   */
  onboardingTemplates: [
    { id: 'first_camp',     name: 'Build an Army Camp', target: 1, rewardShards: 15 },
    { id: 'first_mine',     name: 'Build a Mine',       target: 1, rewardShards: 15 },
    { id: 'first_barracks', name: 'Build a Barracks',   target: 1, rewardShards: 15 },
    // Owner 2026-09-05: fill the existing level-one Camp before land/raids;
    // reuse train_20_points reward, with normal paid training and manual claim.
    { id: 'first_troops', name: 'Train your first army', target: STRUCTURES.camp.capacityPts[0], rewardShards: 25 },
    { id: 'first_land',     name: 'Claim your Land',    target: 1, rewardShards: 30 },
    { id: 'first_raid',     name: 'Win your first raid', target: 1, rewardShards: 20 },
  ],
  /** Progress target per daily-quest id (how many events complete it). Most are
   * single-shot (1); the counted ones encode the goal in their name. Lives here
   * so the goal numbers are not a second source of truth in the API. A shared
   * test pins the bijection with dailyTemplates (M23 a15). */
  progressTargets: {
    win_2_star: 1,
    steal_500: 500,
    two_keg_runners: 1,
    clear_ruined_keep: 1,
    upgrade_any: 1,
    defend_success: 1,
    spend_200: 200,
    scout_3: 3,
    place_5_walls: 5,
    train_tur_rider: 1,
    all_3_buffs: 1,
    win_from_map: 1,
    // M23 a15 expansion (owner 2026-08-15)
    win_3_star: 1,
    win_2_raids: 2,
    raid_3_times: 3,
    steal_1500: 1500,
    earn_5_stars: 5,
    clear_2_keeps: 2,
    vault_buster: 1,
    deploy_hero: 1,
    hero_untouched: 1,
    deploy_20_troops: 20,
    use_5_highlanders: 5,
    use_5_bowmen: 5,
    use_3_tunnelers: 3,
    use_3_tur_riders: 3,
    use_2_plunderers: 2,
    use_2_giants: 2,
    use_2_trolls: 2,
    use_a_dragon: 1,
    use_a_mage: 1,
    use_war_horn: 1,
    use_swift_boots: 1,
    use_powder_charge: 1,
    campaign_clear: 1,
    campaign_3star: 1,
    campaign_2_stages: 2,
    upgrade_2_buildings: 2,
    upgrade_to_level_3: 1,
    place_10_walls: 10,
    clear_obstacle: 1,
    train_5_troops: 5,
    train_20_points: 20,
    collect_mines: 1,
    collect_1000_mined: 1000,
    claim_daily_cache: 1,
    spend_500: 500,
    forge_smelt: 1,
    scout_1: 1,
    upgrade_hero: 1,
  } as Record<string, number>,
} as const;

/**
 * First-run tutorial (owner 2026-08-15, M23 a6: "step-by-step, replayable
 * in-game tutorial explaining each core system").
 *
 * IDS AND COUNT ONLY — player-facing copy lives in the web layer
 * (apps/web/src/ui/tutorial/TutorialOverlay.tsx, a lazy chunk), so the shared
 * barrel that packages/sim consumes never carries tutorial prose. The server
 * stores progress as the INDEX into `ids` (apps/api tutorial_progress.step)
 * and only ever accepts current+1, so this order is a wire contract shared by
 * api and web — insert new steps at the END or bump both sides together.
 * `done` is the terminal marker: advancing onto it stamps completion.
 *
 * SHRUNK FROM 14 CONTENT CARDS TO 3 (owner 2026-08-28: onboarding "needs more
 * interactive approach, instead of displaying cards we should direct player to
 * do things like in professionally built games"). The eleven cards that TOLD the
 * player to build a mine, raise a building, train troops, raid and buy land are
 * replaced by QUESTS.onboardingTemplates, which make the same five actions real
 * objectives with server-tracked progress and a reward. What is left is the two
 * things no quest can express — who you are and how to move the camera — plus
 * the hand-off card that shows the player where their objectives now live.
 *
 * SHORTENING THIS LIST STRANDS NOBODY, and that is enforced rather than hoped:
 * a live row parked on a retired index finds no copy for its step, and
 * TutorialOverlay settles it through /tutorial/skip on sight (see the no-copy
 * branch there). Lengthening it again is still append-only.
 */
export const TUTORIAL_STEPS = {
  ids: ['welcome', 'camera', 'quests', 'done'],
  count: 4,
} as const;

// `count` must equal ids.length — both are literal types under `as const`, so
// adding or removing a step without updating the other fails to compile.
const _tutorialStepCount: (typeof TUTORIAL_STEPS)['ids']['length'] = TUTORIAL_STEPS.count;
void _tutorialStepCount;

// ---------------------------------------------------------------------------
// World map — GDD §3.4: valleys of ~500 plots; cohorts grow up together.
// Grid shape + camp count are server decisions within the GDD's "~500"/"2–4
// camps per chunk" envelope (chunk = valley in alpha).
// ---------------------------------------------------------------------------

export const WORLD = {
  valleyCapacity: 500,
  /** Plot grid per valley: 25 × 20 = 500. */
  gridCols: 25,
  gridRows: 20,
  /** Reserved tiles per valley grid (historically PvE camps; D-069 2026-08-23:
   * PvE is the Campaign only — these tiles stay reserved so parcel addressing
   * never moves, but nothing player-facing lives on them). */
  campsPerValley: 9,
  /** Gold-glint tease threshold: marker shows surplus exists above this (never the number). */
  surplusTeaseThreshold: 500,

  // --- Map scale & interest (docs/MAP-SCALE-PLAN.md "SHIP NOW", 2026-07-29) ---
  // The valley roster is VIEWER-AGNOSTIC, so one load serves every viewer of a
  // valley for this long. Sizing at 20k players (40 valleys × 500 plots): roster
  // DB load is flat in viewer count — 40 valleys × 5 queries ÷ 20 s ≈ 10 q/s.
  /** Roster cache TTL, seconds. Client poll aligns to it (mapPollSec). */
  mapCacheSec: 20,
  /** Client refetch cadence for the visible rect, seconds. Kept EQUAL to
   *  mapCacheSec so a polling client never fights a warm cache. */
  mapPollSec: 20,
  /** Max FULL tactical markers (wallet/gameplay flags) in one normal /map
   * response. Your own plot and revenge targets are additional. The explicit
   * globe parcel-band mode bypasses full markers entirely and projects every deed
   * as the fixed public name/avatar silhouette. */
  mapCandidateCap: 120,
  /** WAR ROOM shortlist size — the ranked, directly-actionable targets. */
  recommendedTargets: 12,
  /** How long after being raided a keep still renders scorched, hours. */
  mapBurningHours: 12,
  /** Presentation-only lastSeenAt window for the "lit window" marker. Online
   * status never gates attacks (owner retired logoff protection 2026-08-12). */
  mapOnlineMin: 10,
  /** Rect-size guard for GET /map, in tiles. Oversized rects are CLAMPED (with a
   *  server warn), never rejected, so a client that has not shipped the rect yet
   *  keeps working. A whole valley (25×20 = 500) fits under this deliberately. */
  mapChunkMaxTiles: 600,
  /** Hot valley rosters held in the in-process cache at once (mapCache.ts).
   *  512 × a ≤500-player roster ≈ 75 MB worst case, and a valley only occupies a
   *  slot while someone is looking at it inside mapCacheSec — so this is ~250 K
   *  concurrent map viewers' worth of DISTINCT valleys, well past the LOCAL
   *  tier's egress ceiling (the thing that actually breaks first).
   *  Source: docs/WORLDMAP-GLOBE-PLAN.md P5 (bounded LRU + expiry sweep, pulled
   *  forward because the unbounded Map failed catastrophically rather than slowly). */
  mapCacheMaxValleys: 512,

  // --- Per-IP rate limits for the map reads (docs/WORLDMAP-GLOBE-PLAN.md P4).
  // These routes are behind `paid`, but the global limiter (300/60 s, skipOnError)
  // is a DDoS floor, not a cost ceiling: /map builds a whole ≤500-row roster into
  // the cache for every DISTINCT valley id it is handed, so an id-walking client
  // could thrash mapCacheMaxValleys entries and drive cold roster loads at will.
  //
  // WHAT A REAL MINUTE OF MAP USE COSTS, from the client's own numbers (map.tsx):
  //   poll                 60 / mapPollSec                        =  3 requests
  //   pan refetches        the fetch rect is quantised to q2 = 4 tiles, i.e. one
  //                        refetch per 4 tiles of camera travel = 129–294 CSS px
  //                        of drag (TILE 46 px at zoom 1.6 → 0.7). A phone flick
  //                        pans ~250 px, so ~1–2 refetches per flick, and a hard
  //                        minute of looking around is ~20 flicks       ≈ 40
  //   zoom steps           each step moves the rect's far edge         ≈  6
  //                                                              total ≈ 49 / min
  // Nothing is refunded: the client's AbortController supersedes the RESULT, not
  // the socket, so every one of those requests reaches the server and is counted.
  /** GET /map for the valley you live in — and, in its own counter, for a valley
   *  you are CONTINUING to look at (see mapVisitOpenRateLimitPerMin). 49/min honest
   *  peak × ~2.4 headroom = 120 (2/s). The previous 60 claimed "~20× headroom" by
   *  counting the 3 polls and forgetting the ~46 pan/zoom refetches beside them —
   *  1.2× real headroom, i.e. a hard pan 429ed a player mid-drag. DB cost is
   *  unaffected by the raise: these are all reads of ONE valley behind the
   *  mapCacheSec snapshot, so ≤3 roster loads/min however hard the client polls. */
  mapRateLimitPerMin: 120,
  /** GET /map?valleyId=<someone else's> where that valley's roster is NOT already
   *  in mapCache — i.e. OPENING a new place. This is the only expensive shape (a
   *  cold ≤500-row load + an LRU slot), so it is the one metered tightly, and it is
   *  metered in its own counter so exploring can never eat your own valley's poll
   *  budget (nor borrow it to walk valley ids).
   *  Per valley, cold reads are self-limiting at 1 per mapCacheSec — the first miss
   *  repopulates the cache — so an honest explorer spends: 3/min for the valley
   *  they are sitting in (a poll landing on the TTL boundary) + 1 per valley opened.
   *  A tap every 5 s = 12 opens/min ⇒ 15/min; ×1.6 for the double-miss when a fast
   *  pan fires a second rect before the first load returns ⇒ 24. That caps one IP at
   *  24 cold rosters/min (0.4/s) and 24 of mapCacheMaxValleys churned per minute,
   *  while a browse-and-pan session pays out of mapRateLimitPerMin above. */
  mapVisitOpenRateLimitPerMin: 24,
  /** GET /map/search — name/wallet lookup over `players INNER JOIN plots`, ≤10 rows.
   *  It needs its OWN ceiling (not the global 300/60 s floor) for two reasons, and
   *  free onboarding is what made it urgent: the route moved from the paid group to
   *  the free one, so reaching it no longer costs 0.2 SOL.
   *  COST: the name predicate is `ilike '%needle%'` — a LEADING wildcard, which no
   *  index can serve, so every call is a scan of the joined set. That is the most
   *  expensive uncached read on the free tier.
   *  HARVEST: it returns landowners by prefix, 10 at a time. The needle minimum is 2
   *  chars, so the base58 wallet-prefix space is 58² = 3,364 queries for a full
   *  sweep: ~11 min per IP at the 300/min floor, ~56 min at 60/min.
   *  HONEST PEAK: the client debounces 250 ms and aborts stale results but not the
   *  sockets (see mapRateLimitPerMin — nothing is refunded), so a search term costs
   *  ≤4 requests (mid-word pause, corrections, the final term). A hard minute is a
   *  search every 5 s ⇒ 12 × 4 = 48/min. 60 = 1.25× that; deliberately thinner
   *  headroom than mapRateLimitPerMin's 2.4× because a 429 here degrades ONE search
   *  box while the map keeps working, and a minute busier than that is pathological. */
  mapSearchRateLimitPerMin: 60,
  /** Deterministic valley names from the valley's ordinal (prefix × suffix), so a
   *  human sees "Grey Tarn" instead of a UUID fragment. 12 × 12 = 144 unique
   *  names before the generator starts numbering cycles. */
  valleyNameParts: {
    prefixes: ['Grey', 'Ashfall', 'Iron', 'Hollow', 'Black', 'Salt', 'Elder', 'Wither', 'Copper', 'Frost', 'Amber', 'Storm'],
    suffixes: ['Tarn', 'Hollow', 'Reach', 'Fen', 'Vale', 'March', 'Barrow', 'Downs', 'Moor', 'Hold', 'Cleft', 'Wold'],
  },
} as const;

// ---------------------------------------------------------------------------
// Globe — docs/WORLDMAP-GLOBE-PLAN.md (plan of record, 2026-08-09), owner
// decisions locked 2026-08-09. The globe is a NAVIGATION SHELL above the
// existing valley map: it shows POPULATION honestly everywhere and highlights
// who you can actually fight (reach is trophies, never distance). It adds no
// money code, no sim code, and no DDL.
// ---------------------------------------------------------------------------

export const GLOBE = {
  /** Offscreen raster diameter in px for the CPU-splatted earth (plan §1.1).
   * FIXED regardless of screen size — client cost must not scale with device. */
  px: 320,

  // --- Sector grid: 24 × 12 = 288 sectors of 15°×15°, 179 with land (§1.3).
  // Derived, never stored. sectorId = lonIdx * sectorsLat + latIdx.
  // 179 is MEASURED against the checked-in coarse mask (2026-08-10): the count of
  // distinct sectorIdOf(cellCentreDeg(cell)) over landCellList(EARTH_COARSE)'s
  // 5,432 cells. The "~110" this comment carried until then was an estimate made
  // before the mask was generated.
  sectorsLon: 24,
  sectorsLat: 12,

  // --- Site lattice (§1.2). A valley is a PLACE with a lat/lon; plots.(x,y)
  // is never reinterpreted, so there is no migration.
  /** Deterministic sub-cell offsets per coarse land cell. MUST be a perfect
   * square (the offsets are a √n × √n lattice inside the cell). MEASURED against
   * the checked-in coarse mask (2026-08-10): 5,432 coarse land cells × 16 =
   * 86,912 valleys, and 86,912 × (valleyCapacity − campsPerValley = 491) =
   * 42,673,792 parcels (§2). The "4,800 → 76,800 → ≈37.7 M" this comment carried
   * until then predated the generated mask; `siteCapacity()` is the live number
   * and `globe.test.ts` pins it. */
  slotsPerSite: 16,

  // --- Baked land-mask resolutions (§1.1). The generated modules
  // (src/earthMask.ts, src/earthMaskFine.ts) carry their own shape as data;
  // earthMask.test.ts asserts it still equals these numbers, so the tunable
  // has exactly one home and a regenerated mask cannot silently change shape.
  /** Coarse mask, 2°. Eager: it is the globe band AND the site lattice. */
  coarseCols: 180,
  coarseRows: 90,
  /** Fine mask, 0.5°. Dynamic import() ONLY — the first-paint JS budget is
   * measured at 995 / 1000 KB gzip and size-check.mjs fails the build at 1001. */
  fineCols: 720,
  fineRows: 360,

  // --- Server aggregation (§1.4). Counts only; never a shield-derived field.
  /** GET /globe snapshot TTL, seconds. One aggregate query per minute GLOBALLY
   * (0.017 q/s at any population), so globe DB load is flat in player count. */
  cacheSec: 60,
  /** GET /globe/sector/:id TTL, seconds. Kept equal to cacheSec so a polling
   * client never fights a warm cache (same reasoning as WORLD.mapPollSec). */
  sectorCacheSec: 60,
  /** Max CLUSTERS returned for one sector (GET /globe/sector/:id), ranked
   * players-desc then proximity. The name predates D-096's 2° clusters — it has
   * always bounded the region-band list, and a sector holds at most 8 × 8 coarse
   * cells, so the geometry already sits under it. Bounds the payload by MEANING,
   * like WORLD.mapCandidateCap. */
  valleysPerSectorCap: 240,
  /** Per-IP cap per minute on EACH globe route (GET /globe and GET
   * /globe/sector/:id keep separate counters — the limiter namespaces per route).
   * The client polls a band once per cacheSec (1/min) and one request is spent per
   * sector tap, so 60 is generous for a human spinning the planet while still
   * bounding the one request that can miss the snapshot cache and hit the DB. */
  rateLimitPerMin: 60,

  // --- Fine-grid parcel viewport (D-040 + owner 2026-08-14 multi-valley view).
  /** Maximum fine cells — and therefore maximum possible parcel DTOs — in one
   * GET /globe/parcels response. Owner 2026-08-14: 4,096; larger camera boxes
   * are tiled by the client rather than turning one read into a world dump. */
  parcelViewportMaxCells: 4_096,
  /** Longest inclusive edge of one viewport tile. Owner 2026-08-14: 256 cells,
   * capping the indexed SQL row-range count independently of the area bound. */
  parcelViewportMaxSpanCells: 256,
  /** Client bbox edges quantize outward to this many fine cells, limiting cache
   * churn during small camera moves. Owner 2026-08-14: 8 cells (4°). */
  parcelViewportQuantumCells: 8,
  /** Camera-settle delay before a viewport read. Owner 2026-08-14: 250 ms. */
  parcelViewportDebounceMs: 250,
  /** Maximum nearest-first viewport tiles fetched for one camera footprint.
   * Owner 2026-08-14: 4; readable z2.6 needs no more than two on target phones. */
  parcelViewportMaxRequests: 4,
  /** Exact completed viewport scopes retained for immediate revisit restore.
   * Owner 2026-08-14: 4; bounded A→B→A reuse without cross-scope marker mixing. */
  parcelViewportCacheScopes: 4,
  /** Fail-closed pre-auth per-IP ceiling. Owner 2026-08-14: 600/min preserves
   * carrier-grade NAT headroom while bounding unauthenticated scan attempts. */
  parcelViewportIpRateLimitPerMin: 600,
  /** Independent post-auth wallet ceiling. Owner 2026-08-14: 120/min, matching
   * the measured honest hard-pan allowance and following a wallet across IPs. */
  parcelViewportWalletRateLimitPerMin: WORLD.mapRateLimitPerMin,
  /** Most markers ONE GET /globe/parcels response carries. D-097, owner
   * 2026-09-02: 59k minted bases must never return more markers than a phone can
   * draw, and ordering by distance to the viewer's centre (`cx`/`cy`, default the
   * rect's own centre) keeps the nearest bases when a dense window is cut; the cut
   * is flagged (`truncated`, with `matched` = what the rect really holds) so the
   * client can say so instead of drawing a window that looks complete. Bounds the
   * RESPONSE; D-042's cells / span / quantum above bound the RECT and are unchanged,
   * which is why this sits at or under parcelViewportMaxCells — above it, it could
   * never bite. */
  parcelViewportMaxMarkers: 1_024,

  // --- Zoom bands (§1.3). `zoom` is one scalar; the band is DERIVED, never
  // stored. GLOBE [zoomMin, regionZoom) · REGION [regionZoom, localZoom) ·
  // LOCAL [localZoom, ∞) = today's WorldMap byte-for-byte. The LOCAL band's own
  // zoom clamp stays a render constant in map.tsx (MAP-SCALE-PLAN:47).
  zoomMin: 0,
  regionZoom: 1,
  localZoom: 4,

  /** Metres per LOCAL plot tile, for the presentational "52.31°N 4.94°E · plot
   * 12,7" readout only (§1.2). A 25×20 valley is then 1.5 km × 1.2 km. Stored
   * nowhere, affects no rule. */
  tileMetres: 60,
} as const;

// ---------------------------------------------------------------------------
// PvE — Ruined Keeps (GDD §3.6)
// ---------------------------------------------------------------------------

export const PVE = {
  /** Bounty by camp tier 1–9 (owner 2026-07-24: PvE ramps to max-level "perfect
   * defence" bases), funded from the bounded gameplay emission pool. Scales
   * with difficulty — a maxed fortress is a rare KEEP prize. Tier 9 (owner
   * 2026-08-03: MAXED practice camp,
   * ops-spawned only — never in valley rotation or the campaign) continues the
   * T7→T8 ~1.67× ramp. ⚠ ALPHA PLACEHOLDERS (owner tunes). */
  bountyByTier: [30, 50, 80, 140, 240, 420, 720, 1_200, 2_000],
  maxCampsPerDay: 3,
  costsEnergy: false,
  breaksShield: false,
  awardsTrophies: false,
  campsPerValleyChunkMin: 2,
  campsPerValleyChunkMax: 4,
} as const;

// ---------------------------------------------------------------------------
// Economy plumbing — GDD §4.6/§4.8/§4.9, Addendum B3/B4
// ---------------------------------------------------------------------------

export const ECONOMY = {
  /** Speed-up LINEAR rate (KEEP per 30 s remaining). Doubled to 2 (owner 2026-07-20)
   * as part of the SUPER-LINEAR speed-up — see speedupCostKeep(). Linear-only made
   * skipping the whole ~1-year time-gate trivially cheap (the real inflation hole). */
  speedupKeepPer30Sec: 2,
  /** Granularity of the speed-up charge (units = ceil(remainingSec / this)). Lives
   * here so the API and client compute it identically. */
  speedupGranularitySec: 30,
  /** Super-linear softness: bigger = gentler quadratic term. cost gains u²/SOFT KEEP,
   * so short finishes stay cheap while a full time-gate skip stays expensive. REVAMPED
   * 800→9000 (owner 2026-07-20): speeding up ALL of a base's timers now totals ~25M
   * KEEP (was ~144M). The separate structure-upgrade curve is ~25M SHARDS, so an
   * instant-max path spends both currencies rather than 50M KEEP. Short single-job
   * speed-ups are unchanged (the quadratic only bites for very long jobs). */
  speedupQuadraticSoftUnits: 9_000,
  /** Withdrawal fee, posted to the internal ledger burn sink (GDD §4.6: 2%). */
  withdrawFeeBps: 200,
  /** Withdrawal unbonding — frozen, raid-protected, cancellable (GDD §4.9).
   * Owner decision 2026-07-19: 48h was too long for player UX; the default
   * cooldown is 24h. A mature authenticator plus exact-intent wallet proof may
   * bypass this delay; verified email is contact/account-factor proof only —
   * see D-027 + TWOFA + money/withdrawals.ts. */
  unbondingHours: 24,
  /** Minimum single withdrawal. Bounds how many destination ATAs the payout hot
   * wallet funds within a player's daily cap (security review 2026-07-18 — the
   * ATA-rent siphon). NOTE: with the level-scaled cap below, the ATA-siphon
   * surface grows with level and remains part of the advanced-withdrawal review. */
  minWithdrawKeep: 500,
  /** ORDINARY KEEP SPENDING NEVER BURNS — it RECYCLES (ECONOMY.md, ✅ LOCKED v3): every current
   * in-game KEEP sink (heroes, items/buffs, speed-ups and additional Mines)
   * credits emission_pool 100% instead of the old 60/25/15
   * burn/league/treasury split. This keeps ordinary KEEP spending inside the
   * reward economy; Mine production itself is denominated in SHARDS.
   * The only KEEP that still burns is the 2% withdrawal fee (withdrawFeeBps). */
  keepSinkRecycles: true,
  /** ALL pre-TGE SOL: 40% liquidity / 35% dev / 25% ops, bps — validated to
   * sum 10000 on-chain (GDD §4.6, ARCHITECTURE §4.1). */
  solSplitBps: { liquidity: 4_000, dev: 3_500, ops: 2_500 },
  /** KEEP → SHARDS conversion rate: each KEEP mints this many SHARDS. The
   * reverse direction remains exclusively the Gold Forge (owner 2026-08-11).
   * Phase E (D-152): superseded by GEMS.shardsPerGem once Gems ship; unchanged for
   * the live custodial path until then. */
  shardsPerKeep: 1,
  /** First-land price. Free admitted wallets can play a limited deedless base;
   *  paying this creates land/world presence and mints a Metaplex Core deed. */
  entryFeeSol: 0.2,
  /** SHARDS granted once when a base is first created (owner 2026-08-16:
   * "change starting balance of new player to 5000 shards from 2000";
   * previously 2,000 per owner 2026-08-11). Existing players keep what they
   * have — this is a creation-time grant, never a retro top-up. */
  starterShards: 5_000,
  /** Historical v1 grant, retained only to calculate the one-time deedless-wallet
   * compensating top-up. Never use this for a new grant. */
  starterShardsV1: 500,
  /** Deposit watcher (ARCHITECTURE §5, R9): poll cadence for pending on-chain
   * deposit intents, and how long an intent stays pollable before it expires
   * (the client then mints a fresh intent; a finalized tx is still recoverable
   * historically via its reference key, and entry additionally via the Player
   * PDA, so nothing paid is ever lost). */
  depositPollSec: 15,
  depositPendingTtlMin: 30,
  /** Least TTL an EXISTING pending intent must still have before it may be
   * handed back to a client that asks to pay (money/deposits.ts). A pending row
   * is only stamped 'expired' lazily, so without this floor a long-idle intent
   * still looks reusable: the owner sat on OPEN YOUR KEEP for 37 min, paid
   * 0.2 SOL against the 15:31 intent, and the first verify — running before the
   * tx finalized — expired it on age alone (incident 2026-07-26). The floor must
   * cover sign + land + finalize with room to spare. */
  depositReuseMinRemainingMin: 10,
  /** Treasury-aware emission controller cadence (#45): recompute the emission
   *  multiplier every this-many seconds. 10 min — fast enough to react to an
   *  outflow spike, slow enough to be cheap. Runs via BullMQ when ENABLE_WORKERS,
   *  else an always-on server tick (crediting never depends on workers). */
  emissionControllerSec: 600,
  /** Second saved-layout slot (GDD §3.9). */
  secondLayoutSlotShards: 500,
  /** 3 free emotes; 3 more at 200 Shards each (GDD §3.9). */
  emoteCostShards: 200,
  emotesFree: 3,
  emotesPaid: 3,
} as const;

/**
 * Speed-up cost in KEEP for a builder job with `remainingSec` left — SUPER-LINEAR
 * (owner 2026-07-20). ONE shared pure helper so the client's FINISH-button label and
 * the server charge are byte-identical. Linear term (u·RATE) keeps short finishes
 * cheap; the quadratic term (u²/SOFT) makes skipping a whole multi-day gate cost
 * ~25× more, closing the cheap-skip inflation hole. Integer Math only (u ≤ ~40320
 * for the longest job, so u² is well within MAX_SAFE_INTEGER). Recycles to
 * emission_pool like every KEEP sink.
 */
export function speedupCostKeep(remainingSec: number): number {
  const rate = ECONOMY.speedupKeepPer30Sec;
  const u = Math.max(1, Math.ceil(remainingSec / ECONOMY.speedupGranularitySec));
  return Math.max(1, u * rate + Math.ceil((rate * u * u) / ECONOMY.speedupQuadraticSoftUnits));
}

/**
 * Per-player rolling-24h withdrawal cap by Keep level (owner 2026-07-19,
 * explicitly retained 2026-08-12). The cap scales with progression so a late-game
 * base can move more value while an early one stays bounded: L1 = 50,000,
 * L5 = 92,000, L20 = 250,000 KEEP. A wallet with several active paid bases uses
 * its strongest base; allowances never add together. The cross-player global cap
 * was removed by D-032 because one wallet must not consume another wallet's limit.
 */
export const WITHDRAW_DAILY_CAP_KEEP_BY_LEVEL: readonly number[] = [
  50_000,  60_000,  71_000,  82_000,  92_000,   //  L1–5
  103_000, 113_000, 124_000, 134_000, 145_000,  //  L6–10
  155_000, 166_000, 176_000, 187_000, 197_000,  //  L11–15
  208_000, 218_000, 229_000, 239_000, 250_000,  //  L16–20
];

/** Per-player rolling-24h withdrawal cap, clamped to the authored level table. */
export function withdrawDailyCapForKeepLevel(keepLevel: number): number {
  const i = Math.min(Math.max(keepLevel, 1), WITHDRAW_DAILY_CAP_KEEP_BY_LEVEL.length) - 1;
  return WITHDRAW_DAILY_CAP_KEEP_BY_LEVEL[i]!;
}

// ---------------------------------------------------------------------------
// Withdrawal 2FA (owner 2026-07-19)
// ---------------------------------------------------------------------------

/** Account 2FA. A mature authenticator is the only factor that may shorten the
 * 24h withdrawal delay; verified email supports contact, factor changes and key
 * export because the server cannot prove it is independent of Privy login. These
 * values bound those email-code lifecycles and TOTP clock-skew tolerance. */
export const TWOFA = {
  /** Digits in an email verification code. */
  emailCodeDigits: 6,
  /** Email code time-to-live (seconds). */
  emailCodeTtlSec: 600,
  /** Wrong guesses before a code is burned (brute-force guard). */
  maxCodeAttempts: 5,
  /** Minimum seconds between email-code sends per player (anti-spam). */
  emailResendCooldownSec: 30,
  /** TOTP step tolerance: ±N 30s windows accepted, for client clock skew. */
  totpWindow: 1,
  /** Failed withdrawal-2FA attempts (any method) before the account is locked
   * out — per-account brute-force guard on top of the per-IP HTTP limit. */
  maxWithdrawAttempts: 5,
  /** How long a locked-out account must wait before trying 2FA again (minutes). */
  lockoutMinutes: 15,
  /** Per-IP rate cap for the sensitive 2FA verify / withdrawal endpoints
   * (requests per minute), tighter than the global default. */
  verifyRateLimitPerMin: 12,
  /** Lost-authenticator recovery stays pending for this long before the old
   * factor can be cleared. Owner 2026-09-01: verified email + fresh wallet
   * proofs at both ends, with a visible security delay. */
  recoveryHoldHours: 24,
  /** A held recovery must be completed within this many days. Expiry preserves
   * the old authenticator instead of leaving an account indefinitely blocked. */
  recoveryCompletionDays: 7,
} as const;

// ---------------------------------------------------------------------------
// Obstacles — App OBS_TYPES (live API charges the legacy `costKeep` field in
// SHARDS; clear time per tier, +15 SHARDS found)
// ---------------------------------------------------------------------------

export const OBSTACLES = {
  tiers: {
    small:  { costKeep: 10, clearSec: 60,  sizeTiles: 1, kinds: ['bush', 'stump', 'rock_s'] },
    medium: { costKeep: 25, clearSec: 180, sizeTiles: 1, kinds: ['pine1', 'pine2', 'rock_l'] },
    large:  { costKeep: 60, clearSec: 600, sizeTiles: 2, kinds: ['tree_old', 'boulder'] }, // 2×2
  },
  /**
   * "+15 SHARDS FOUND" on clear (App).
   *
   * ⚠ THIS IS NET-POSITIVE AGAINST THE `small` TIER (10 → 15 = +5) AND THAT IS
   * ONLY SAFE BECAUSE TERRAIN IS FINITE. Measured by running the generator: a plot
   * holds exactly 189 obstacles (73 small / 84 medium / 32 large), a clear
   * tombstones its row forever, and only tiles INSIDE the current claim can be
   * cleared at all — 4 tiles at expansions 0, 49 at 1, 122 at 2. So the ceiling is
   * +365 shards over a base's entire life, gated behind SOL-bought expansions: a
   * ONE-TIME land-improvement bonus, not an income line, and ECONOMY.md
   * deliberately lists none for obstacles.
   *
   * Regenerating that terrain therefore turns it into a faucet: until the
   * 2026-08-09 F5 fix, `abandonFreeBase` deleted the rows and the next `GET /base`
   * re-ran the deterministic generator, so abandon → rebuild → clear minted the
   * reachable smalls again (+5/cycle at expansions 0, which abandon resets you to)
   * with no cooldown and no per-wallet cap. Two guarantees keep this number safe:
   * `ensureStartingBase` generates a wallet's terrain exactly once ever, and
   * `abandonFreeBase` tombstones instead of deleting. Relax either and this number
   * has to move first.
   */
  clearRewardShards: 15,
  /** Procedural starting-obstacle placement tuning (App-derived). The generator
   * hashes each tile to 0–99: outside the claim place when hash < outsideDensityPct;
   * on the claim's fringe place sparse starters when hash < fringeStarterMax; and
   * outside, hash < largeThreshold makes it a large (2×2) obstacle. */
  generation: {
    outsideDensityPct: 34,
    fringeStarterMax: 8,
    largeThreshold: 6,
  },
} as const;

/** docs/REALM-KIT-PLAN.md E-11 (D-173, owner 2026-09-21): a cleared obstacle keeps
 * its remnant (stump/rubble) on the terrain for this many days, served as
 * `clearedObstacles[]` on `GET /base`. Presentation only: the row is already
 * tombstoned, the tile is buildable, and no reward or timer depends on it. */
export const OBSTACLE_REMNANT_DAYS = 7;

/** docs/REALM-KIT-PLAN.md E-11, D-173 expansion obstacles (owner 2026-09-21: "what
 * happens to trees when you extend base? … they are not interactive like in-base
 * trees"): a baked kit prop whose seat tile an expansion reaches becomes a server
 * obstacle row of the tier below — the plot's own tap-to-clear flow, cost, timer
 * and +15 reward — while the drawn sprite stays the prop's own still (the species
 * never changes because land was bought). The row's rect must cover exactly the
 * prop's footprint, so only 1×1 props map to the 1-tile tiers and only 2×2 props
 * to the 2-tile tier; anything else (2×1 logs, 3×3 mills, 5×4 waterfall cliffs) and every
 * cell of the creature sheet stays a hidden prop as before. The rule lives in
 * packages/shared/src/realmKitObstacles.ts; the numbers live only here.
 *
 * ECONOMY (awaiting owner ratification, docs/DECISIONS.md D-173 expansion
 * obstacles, recounted 2026-09-24 after the Crownlands rework (D-174(6)) opened
 * an east lawn inside the frame and trimmed the woods zones, which reseeded the
 * scatter (186 / 135 / 46 / 5, +595 → 122 / 94 / 24 / 4, +485), and again the
 * same day after the fair's dirt grounds shortened the copse scatter's candidate
 * list and re-rolled it (115 / 85 / 26 / 4, +495), and a third time when 13 lone
 * trees planted that lawn (medium rows only, so the ceiling held): Crownlands
 * bakes 128 props inside the frame outside the plot —
 * 98 medium trees (−10 net each), 26 smalls (+5 net each),
 * 4 that never map (4 logs) — so the obstacle faucet ceiling
 * moves from +365 to +495 shards per base life, still one-time and gated behind
 * SOL-bought expansions. The Crownlands block of scripts/src/realm-kit.test.ts
 * recounts the committed build and fails when this text and the build disagree. */
export const KIT_OBSTACLES = {
  /** Kit prop id (dashed, as the placement's `prop` / id prefix) → sprite key,
   * matched by prefix before the layer rule; each key's tier size must still
   * equal the prop's footprint or the prop never maps. */
  byProp: { 'rock-l': 'rock_l', 'rock-s': 'rock_s', stump: 'stump', 'canopy-log': 'stump', boulder: 'boulder' },
  /** 1×1 props on the tall layer (trees): realmKitTileHash(seat) parity picks the species twin. */
  tallByParity: ['pine1', 'pine2'],
  /** 2×2 props on the tall layer → the large tree. */
  tallLarge: 'tree_old',
  /** 1×1 props on the low layer (bushes, brambles, mushrooms, flowers) → the small bush. */
  low: 'bush',
  /** A sheet whose cell is exactly this square (the builder's props32: deer, rabbits,
   * foxes …) is the creature sheet — never an obstacle, whatever the layer. */
  creatureCellPixels: 32,
} as const;

// ---------------------------------------------------------------------------
// Gold Forge — the ONLY shards→KEEP faucet (owner rules, 2026-07-24, ITEMS-
// LOOTBOX-MARKETPLACE-PLAN §5). Daily emission spans the play allocation over
// 5 years; deed positions split each day's pool pro-rata; a SOFT CAP scales the
// day's distribution down when participation is low. Each deed may transact any
// number of times during the day, bounded only by its Forge-level daily cap.
//
// SUB-PARITY INVARIANT (forge-model.ts, tested): the payout rate is
//   rate = dailyEmissionKeep / max(totalShards, softCapShards)
// — constant below the soft cap, decaying above it. Because deposits buy
// shards at 1:1, softCapShards MUST exceed dailyEmissionKeep or the forge
// becomes a money printer. Here: 273 972 / 350 000 ≈ 0.78 KEEP/shard max.
// ---------------------------------------------------------------------------

export const FORGE = {
  /** SOL (lamports) to upgrade the Gold Forge TO the keyed TARGET level — D-057.
   * Owner 2026-08-16 (verbatim): "gold forge lv1>2 should cost 0.1 sol next
   * more 0.15 sol next more 0.2 sol and increase every level price for 0.05."
   * — the OWNER-SET curve: L2 = 0.10 SOL, then +0.05 SOL per target level
   * (Lk = 0.05×k, topping at 1.00 SOL for L20). This supersedes the earlier
   * agent-assumed 0.2 + 0.1/level progression (only the 0.2 entry price was
   * owner-set then; see the D-057 addendum in docs/DECISIONS.md).
   * Building the L1 forge stays shards-only (BUILD_COSTS.goldforge, Keep L3
   * gate); every upgrade to L2+ charges this SOL ON TOP of its
   * UPGRADE_COSTS.goldforge shards, paid as a direct SOL transfer 100% to the
   * LIQUIDITY wallet through the same 'mine'-kind deposit intent +
   * verification flow as mine upgrades.
   *
   * IN-FLIGHT SAFETY (D-057 retuning rule): every step here is exactly HALF
   * its previously-published price, so any in-flight intent frozen at the old
   * quote still covers the current table price and credits under the
   * greater-is-honoured rule — no paid player strands. Never raise a step
   * above its previously-published price while intents could be in flight.
   * Look up via upgradeSolLamports('goldforge', targetLevel). */
  UPGRADE_SOL_LAMPORTS_BY_TARGET_LEVEL: {
    2: 100_000_000, 3: 150_000_000, 4: 200_000_000, 5: 250_000_000,
    6: 300_000_000, 7: 350_000_000, 8: 400_000_000, 9: 450_000_000,
    10: 500_000_000, 11: 550_000_000, 12: 600_000_000, 13: 650_000_000,
    14: 700_000_000, 15: 750_000_000, 16: 800_000_000, 17: 850_000_000,
    18: 900_000_000, 19: 950_000_000, 20: 1_000_000_000,
  } as Readonly<Record<number, number>>,
  /** Emission horizon (owner): the play allocation spans 5 years of dailies. */
  emissionYears: 5,
  /** Daily KEEP budget = floor(playPool 500M / (5 × 365)). Kept as a literal
   * (hard rule: numbers live here); the derivation is asserted in tests. */
  dailyEmissionKeep: 273_972,
  /** Soft cap (shards/day): below it only total/softCap of the day's emission
   * distributes. ⚠ ALPHA PLACEHOLDER (owner tunes) — MUST stay > dailyEmissionKeep
   * (sub-parity invariant above). */
  softCapShards: 350_000,
  /** @deprecated Legacy settlement response compatibility. This is not an
   * admission ceiling; D-035 permits every deed up to its level-based daily cap. */
  maxDailyShareBps: 3_000,
  /** Per-deed contribution-window cap (shards) by Gold Forge BUILDING level,
   * index 0 = no Gold Forge built (owner 2026-07-24: "upgrading forge should
   * increase forge contribution cap per player … if they don't upgrade forge on
   * higher levels they won't be able to contribute above certain amount").
   * L0 = 0: the building IS the faucet — no Gold Forge, no contributions.
   * Geometric 2 000 → 200 000 over L1..L20 (~×1.27/level). This is the sole
   * contribution ceiling and is tracked independently for every deed/day.
   * ⚠ ALPHA PLACEHOLDER. */
  contributionCapByLevel: [0, 2_000, 2_550, 3_250, 4_150, 5_300, 6_750, 8_600, 11_000, 14_000, 17_800, 22_700, 28_900, 36_800, 46_900, 59_800, 76_200, 97_100, 124_000, 158_000, 200_000],

  // --- Claimable payouts (dashboard, 2026-07-29) ---------------------------
  // Settlement no longer auto-credits: it moves the day's KEEP into
  // forge_payout_escrow and the player CLAIMS it. The pour is the moment of
  // the game; a claim is what makes it one.
  /** Days a settled allocation stays claimable before it sweeps BACK to
   * emission_pool. ⚠ OWNER DECISION defaulted here: returning unclaimed
   * emission to the lifetime-mint pool means it was never minted out (the
   * 500M cap only ever tightens), and it stops the escrow becoming an
   * unbounded permanent liability Proof-of-Reserves must cover forever.
   * The alternative ("never expires") is a growing PoR liability; expiring to
   * TREASURY is off the table — that is the operator profiting from player
   * inattention on a money surface. Every claimable allocation shows its
   * expiry date in the UI (minimum acceptable disclosure). */
  claimWindowDays: 30,
  /** Max allocation rows one POST /forge/claim resolves — bounds transaction
   * size and lock span. A player away longer claims in several taps, and the
   * response's `remaining` tells the UI to offer another. */
  claimBatchMax: 30,
  /** Max rows swept per lazy expiry pass (same bounding reason). */
  expireBatchMax: 200,
  /** Default / hard-ceiling page size of GET /forge/allocations (own history). */
  historyPageDays: 30,
  historyMaxPageDays: 90,
  /** Default / hard-ceiling page size of GET /forge/global (mirrors the 200
   * clamp itemMarket.getListings already uses). */
  globalPageSize: 50,
  globalMaxPageSize: 200,
  /** How many recent SETTLED cycles the global list offers as day chips. */
  globalListDays: 14,
  /** Wallet abbreviation in the PUBLIC global list, computed SERVER-side
   * (4+4, matching the client's existing shortAddr). Truncating in React
   * would still ship every full address in the JSON — a one-request harvester
   * linking in-game identity to on-chain holdings. Be honest about what this
   * buys: it prevents BULK harvesting, it does not anonymise anyone who
   * already holds the address. */
  globalWalletHeadChars: 4,
  globalWalletTailChars: 4,
  /** GET /forge/drops/recent — the PUBLIC relics-won feed (tester 69arc,
   * report 0d1b6d9d "RELICS WON DISPLAY", 2026-09-17: a drop nobody can see
   * is a drop nobody believes). Default / hard-ceiling row count, and the
   * server-side cache window: the route is uncredentialed, so one query per
   * window serves every viewer regardless of how many poll it. */
  recentDropsPageSize: 20,
  recentDropsMaxPageSize: 50,
  recentDropsCacheSec: 60,
} as const;

// ---------------------------------------------------------------------------
// Items — ITEMS-LOOTBOX-MARKETPLACE-PLAN §6/§11. KEEP spent on items recycles
// 100% to emission_pool like every other sink.
//
// The three keep-skin cosmetics (phase 1) were REMOVED from the game entirely
// (owner 2026-08-15, M23 a8): M22's rebuilt castle stopped rendering them, so
// the owner retired the catalog entries. Owners are refunded under D-009
// ("money moved is money honoured") via REMOVED_SKIN_REFUNDS below.
// ---------------------------------------------------------------------------

/** Consumable effects (USABLE items — owner priority 2026-07-24). Effects are
 * deliberately chosen to never undercut an existing sink:
 *  - `finish_job` is BOUNDED by maxRemainingSec, so chaining items can never
 *    bypass the super-linear speed-up curve (the bound keeps each use inside
 *    the cheap-linear zone the curve already allows).
 *  - `raid_energy` duplicates a SOL-only sink, so its KEEP price sits at a
 *    deliberate PREMIUM over the SOL price's vend-equivalent — a convenience
 *    for the KEEP-rich, never the cheaper path (ECONOMY.md §4a stays intact).
 *  - Shield extension stays SOL-ONLY — no shield consumable, by design. */
export type ItemEffect =
  | { type: 'finish_job'; maxRemainingSec: number }
  | { type: 'raid_energy'; amount: number }
  /** Deploy a 48h WARZONE-source shield (the only cover that holds during a
   *  warzone). Forge-drop only — see FORGE_DROPS. */
  | { type: 'warzone_shield' }
  /** Permanently unlock TRAINING of one elite troop for the consuming WALLET
   *  (owner 2026-08-16 — see ELITE_TROOP_UNLOCKS). Refused (422, item kept)
   *  when the wallet already holds the unlock. */
  | { type: 'troop_unlock'; troop: TroopType };

/** Inventory/gear contract (OVERNIGHT-E2E-PLAN-2026-08-11 §7.1).
 * Percentages are integer basis points so API snapshots and the deterministic
 * simulator can apply one multiply+floor with no display-string parsing. */
// 'material' (E2-WORKSHOP-CONTRACT §2): base-scoped crafted inputs such as the
// Forge Ingot — never sold by the system, ordinary tradable materials.
export const ITEM_KINDS = ['gear', 'consumable', 'relic', 'deed', 'cosmetic', 'material'] as const;
export type ItemKind = typeof ITEM_KINDS[number];
export const ITEM_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type ItemRarity = typeof ITEM_RARITIES[number];
export const GEAR_SLOTS = [
  'helm', 'amulet', 'chest', 'cloak', 'gloves',
  'ring', 'boots', 'banner', 'weapon', 'offhand',
] as const;
export type GearSlot = typeof GEAR_SLOTS[number];
export const GEAR_MODIFIER_STATS = [
  'hero_hp_bps', 'hero_damage_bps', 'ability_damage_bps',
  'cooldown_reduction_bps', 'move_speed_bps',
  'incoming_damage_reduction_bps', 'first_hit_reduction_bps',
  'wall_damage_bps', 'allied_troop_hp_bps', 'allied_troop_damage_bps',
] as const;
export type GearModifierStat = typeof GEAR_MODIFIER_STATS[number];

export interface GearModifier {
  stat: GearModifierStat;
  value: number;
}

export type ItemAcquisition =
  | { type: 'shop' }
  | { type: 'keep_level'; keepLevel: number }
  | { type: 'campaign_three_star'; stage: number; requiresMaxHero?: boolean }
  | { type: 'drop' }
  /** Produced by a building job (Workshop refining, E2-WORKSHOP-CONTRACT §2):
   *  buyItem refuses it like a drop; it enters base_items only through collect. */
  | { type: 'craft' };

/** One backpack for phase one. Equipped gear does not consume this capacity;
 * overflow from a return is retained but blocks all new acquisitions. */
export const INVENTORY = {
  catalogRevision: 2,
  capacity: 160,
  modifierCapsBps: {
    hero_hp_bps: 4_000,
    hero_damage_bps: 3_000,
    ability_damage_bps: 1_500,
    cooldown_reduction_bps: 2_000,
    move_speed_bps: 1_500,
    incoming_damage_reduction_bps: 1_000,
    first_hit_reduction_bps: 2_500,
    wall_damage_bps: 5_000,
    allied_troop_hp_bps: 1_500,
    allied_troop_damage_bps: 1_000,
  } satisfies Record<GearModifierStat, number>,
  wardenSet: {
    equippedPieces: 9,
    modifiers: [{ stat: 'allied_troop_hp_bps', value: 800 }] as const satisfies readonly GearModifier[],
  },
} as const;

export interface ItemSpec {
  /** Display name (shop copy). */
  name: string;
  kind: ItemKind;
  /** Equip slot (gear only since the keep-skin retirement, M23 a8). */
  slot?: GearSlot;
  /** Price in whole KEEP (recycles to emission_pool on purchase). */
  costKeep: number;
  /** Master-sprite base: an icon (consumables) or handout art key (gear). */
  asset: string;
  desc: string;
  rarity: ItemRarity;
  /** Integer backpack weight per unequipped unit. */
  weight: number;
  acquisition: ItemAcquisition;
  /** null means capacity is the only stack limit. */
  maxOwned: number | null;
  /** Set-family identity; only matching pieces count toward its threshold. */
  set?: 'warden';
  modifiers?: readonly GearModifier[];
  /** What USE does (consumables only). */
  effect?: ItemEffect;
  /** Not purchasable AND not sellable — earned only (Gold Forge drops). `buyItem`
   *  rejects buying it and `listItem` rejects listing it (owner 2026-08-09): a
   *  free-won relic listed for SOL is a faucet straight out of the game, and under
   *  free onboarding making another account is the cheap way to roll for one. */
  dropOnly?: boolean;
}

/** The seven pre-gear items. Kept as a separate export so legacy shop/forge
 * surfaces do not pull the gear catalog into the first-paint web graph. */
export const LEGACY_ITEMS = {
  // --- consumables (stackable, USE applies the effect) --------------------
  keg_of_haste: {
    name: 'KEG OF HASTE', kind: 'consumable', costKeep: 60,
    asset: 'ui_icon_swiftboots', desc: 'Instantly finish a build with under 30m left.',
    rarity: 'common', weight: 1, acquisition: { type: 'shop' }, maxOwned: null,
    effect: { type: 'finish_job', maxRemainingSec: 1_800 },
  },
  finishers_seal: {
    name: "FINISHER'S SEAL", kind: 'consumable', costKeep: 300,
    asset: 'ui_icon_timer', desc: 'Instantly finish a build with under 2h left.',
    rarity: 'uncommon', weight: 1, acquisition: { type: 'shop' }, maxOwned: null,
    effect: { type: 'finish_job', maxRemainingSec: 7_200 },
  },
  powder_charge: {
    name: 'POWDER CHARGE', kind: 'consumable', costKeep: 1_500,
    asset: 'ui_icon_powdercharge', desc: 'One extra raid today. Premium-priced — SOL is the cheap route.',
    rarity: 'rare', weight: 2, acquisition: { type: 'shop' }, maxOwned: null,
    effect: { type: 'raid_energy', amount: 1 },
  },
  warzone_aegis: {
    name: 'WARZONE AEGIS', kind: 'consumable', costKeep: 8_000, dropOnly: true,
    // ui_icon_shield, NOT map_marker_shield: the latter is a 32x32 map OVERLAY
    // (a pale outline meant to sit on top of a keep marker) and rendered as an
    // empty dotted ring at every item size — the scarcest drop in the game
    // looked like a broken image next to real item art (E2E 2026-07-29).
    asset: 'ui_icon_shield',
    desc: 'Deploy a 2d warzone shield — the only cover that holds while a warzone rages. Forge-drop only: one is forged a day.',
    rarity: 'legendary', weight: 3, acquisition: { type: 'drop' }, maxOwned: null,
    effect: { type: 'warzone_shield' },
  },
} as const satisfies Record<string, ItemSpec>;

/**
 * D-009 refund table for the three retired keep-skin cosmetics (owner
 * 2026-08-15, M23 a8: "completely remove base skins from game"). Amounts are
 * the ORIGINAL purchase prices (gilded 1 200 / frost 900 / voidstone 5 000
 * KEEP, per the pre-removal catalog entries). The worker-boot sweep
 * (apps/api/src/game/skinRefunds.ts) posts `skin.refund` ledger transactions
 * from emission_pool — the account the purchases recycled into — per owned
 * copy, then consumes the player_items row. Do not delete or retune entries:
 * a reserved mid-sale listing settling later still owes its buyer this refund.
 */
export const REMOVED_SKIN_REFUNDS = Object.freeze({
  skin_keep_gilded: 1_200,
  skin_keep_frost: 900,
  skin_keep_voidstone: 5_000,
} as const);
export type RemovedSkinId = keyof typeof REMOVED_SKIN_REFUNDS;

/**
 * In-game mail resource and reward bounds (owner 2026-08-15 / M22).
 * Reward limits are deliberately below end-game balances and ordinary inventory
 * capacity: mail is an admin recovery/reward lane, never a bulk ledger or item
 * migration mechanism. Only stackable legacy consumables are allow-listed.
 */
type MailConsumableId = {
  [K in keyof typeof LEGACY_ITEMS]: (typeof LEGACY_ITEMS)[K]['kind'] extends 'consumable' ? K : never
}[keyof typeof LEGACY_ITEMS];

const MAIL_CONSUMABLE_IDS = Object.freeze(
  (Object.keys(LEGACY_ITEMS) as Array<keyof typeof LEGACY_ITEMS>)
    .filter((id): id is MailConsumableId => LEGACY_ITEMS[id].kind === 'consumable'),
);

export const MAIL = {
  rewardExpiryDays: 30,
  /** Bounded lazy expiry sweep; operational alpha limit (owner 2026-08-15/M22). */
  expiryBatchSize: 100,
  subjectMaxChars: 120,
  bodyMaxChars: 4_000,
  listLimitDefault: 20,
  listLimitMax: 50,
  maxInformationalBroadcastRecipients: 500,
  maxAttachments: 3,
  rewardKeepMax: 1_000_000,
  rewardShardsMax: 250_000,
  rewardConsumableQtyMax: 10,
  approvedStackableConsumableIds: MAIL_CONSUMABLE_IDS,
} as const;

/** Fixed-stat Warden gear. This export is consumed by lazy inventory and the
 * authoritative server; it must remain absent from legacy first-paint UI.
 *
 * FORGE-DROP-EXCLUSIVE since 2026-08-16 (owner verbatim: "gear also should be
 * gathered exclusively from drops. we should drop 1-2 per item daily not
 * more"): every piece carries `acquisition: 'drop'` (buyItem refuses — the
 * shop/KEEP purchase path and the retired Keep/campaign purchase gates are
 * gone) and `costKeep: 0` means "never sold for KEEP", the same convention as
 * the forge writs. Gear ALREADY BOUGHT under the retired prices stays owned
 * (money moved is money honoured — no clawback), and gear stays
 * market-tradeable (not dropOnly): forge rolls are per-DEED/day, so the
 * 2026-08-09 free-account drop-farming rationale does not apply (D-058).
 * Drop odds live in FORGE_DROPS.independentDropBps. */
export const GEAR_ITEMS = {
  // --- Warden gear (fixed stats; no random rolls) ------------------------
  wardens_helm: {
    name: "WARDEN'S HELM", kind: 'gear', slot: 'helm', costKeep: 0,
    asset: 'itm_helm', desc: 'A watch captain\'s crown, reinforced around the first shard.',
    rarity: 'rare', weight: 4, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [
      { stat: 'hero_hp_bps', value: 600 }, { stat: 'ability_damage_bps', value: 400 },
    ],
  },
  shardplate_cuirass: {
    name: 'SHARDPLATE CUIRASS', kind: 'gear', slot: 'chest', costKeep: 0,
    asset: 'itm_chest', desc: 'Massive shardplate that trades speed for survival.',
    rarity: 'epic', weight: 11, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [
      { stat: 'hero_hp_bps', value: 1_200 }, { stat: 'move_speed_bps', value: -500 },
    ],
  },
  siege_gauntlets: {
    name: 'SIEGE GAUNTLETS', kind: 'gear', slot: 'gloves', costKeep: 0,
    asset: 'itm_gloves', desc: 'Knuckle plates made to split masonry.',
    rarity: 'uncommon', weight: 3, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [
      { stat: 'hero_damage_bps', value: 600 }, { stat: 'wall_damage_bps', value: 1_500 },
    ],
  },
  marchers_greaves: {
    name: "MARCHER'S GREAVES", kind: 'gear', slot: 'boots', costKeep: 0,
    asset: 'itm_boots', desc: 'Light greaves for closing distance quickly.',
    rarity: 'common', weight: 3, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [{ stat: 'move_speed_bps', value: 1_200 }],
  },
  voidweave_cloak: {
    name: 'VOIDWEAVE CLOAK', kind: 'gear', slot: 'cloak', costKeep: 0,
    asset: 'itm_cloak', desc: 'Its first fold drinks the opening blow.',
    rarity: 'epic', weight: 2, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [
      { stat: 'first_hit_reduction_bps', value: 2_500 }, { stat: 'move_speed_bps', value: 500 },
    ],
  },
  keepward_signet: {
    name: 'KEEPWARD SIGNET', kind: 'gear', slot: 'ring', costKeep: 0,
    asset: 'itm_ring', desc: 'A compact focus that restores ability cadence.',
    rarity: 'rare', weight: 0, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [{ stat: 'cooldown_reduction_bps', value: 800 }],
  },
  first_shard_amulet: {
    name: 'AMULET OF THE FIRST SHARD', kind: 'gear', slot: 'amulet', costKeep: 0,
    asset: 'itm_amulet', desc: 'A legendary focus for endurance and decisive skills.',
    rarity: 'legendary', weight: 1, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [
      { stat: 'hero_hp_bps', value: 800 }, { stat: 'ability_damage_bps', value: 1_000 },
      { stat: 'cooldown_reduction_bps', value: 600 },
    ],
  },
  breaker_of_gates: {
    name: 'BREAKER OF GATES', kind: 'gear', slot: 'weapon', costKeep: 0,
    asset: 'itm_hammer', desc: 'A gate hammer whose power must be carried deliberately.',
    rarity: 'legendary', weight: 14, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [
      { stat: 'hero_damage_bps', value: 1_800 }, { stat: 'wall_damage_bps', value: 3_500 },
      { stat: 'move_speed_bps', value: -800 },
    ],
  },
  bulwark_deep_keep: {
    name: 'BULWARK OF THE DEEP KEEP', kind: 'gear', slot: 'offhand', costKeep: 0,
    asset: 'itm_shield', desc: 'Deep-Keep iron that blunts incoming force.',
    rarity: 'epic', weight: 9, acquisition: { type: 'drop' }, maxOwned: 2, set: 'warden',
    modifiers: [
      { stat: 'hero_hp_bps', value: 1_000 }, { stat: 'incoming_damage_reduction_bps', value: 800 },
      { stat: 'move_speed_bps', value: -400 },
    ],
  },
  banner_of_nine: {
    name: 'BANNER OF THE NINE', kind: 'gear', slot: 'banner', costKeep: 0,
    asset: 'itm_banner', desc: 'The mythic standard that binds an army together.',
    rarity: 'mythic', weight: 5,
    acquisition: { type: 'drop' }, maxOwned: 1, set: 'warden',
    modifiers: [
      { stat: 'allied_troop_hp_bps', value: 600 }, { stat: 'allied_troop_damage_bps', value: 600 },
    ],
  },
} as const satisfies Record<string, ItemSpec>;

/**
 * Hero-contract + elite-troop unlock items (owner 2026-08-16, verbatim: "heroes
 * are also items which can be sold in-game market, and some troops are also
 * items, dragon, wyvern, gloamfang, hexabraw(cannon), mage. some of them for
 * example mage should cost 5,000 KEEP, dragon only can be dropped from gold
 * forge, same for wyvern and rest of other way unlocked troops").
 *
 * Design (D-058):
 *  - HERO CONTRACTS are consumed by placing the hero's altar (placeBuilding) —
 *    NOT via /items/use, because recruitment needs the 2×2 altar position. A
 *    placement without the item charges HEROES[hero].recruitCostKeep instead;
 *    the completed altar stays the ONLY recruitment record.
 *  - TROOP WRITS are /items/use consumables: USE inserts a permanent per-WALLET
 *    troop_unlocks row; a wallet that already holds the unlock gets a 422 and
 *    KEEPS the item (sell it on the market instead).
 *  - The mage writ is shop-purchasable (5,000 KEEP). Dragon / direwyvern /
 *    gloamfang / hexbarrow writs are FORGE-DROP-ONLY (acquisition 'drop' —
 *    buyItem refuses) but, unlike the dropOnly Warzone Aegis, they ARE
 *    market-tradeable: forge drops are per-DEED/day (land costs real SOL), so
 *    the 2026-08-09 free-account drop-farming rationale does not apply.
 *  - costKeep 0 on the forge writs means "never sold for KEEP", not free.
 *  - ⚠ rarities/weights are agent picks for owner tuning (see FORGE_DROPS).
 */
export const UNLOCK_ITEMS = {
  item_hero_vex: {
    name: 'HERO CONTRACT: VEX', kind: 'consumable', costKeep: 3_000,
    asset: 'hero_vex_portrait',
    desc: 'Recruits Vex the Shardborn: place his altar to consume this contract. Tradeable until used.',
    rarity: 'epic', weight: 2, acquisition: { type: 'keep_level', keepLevel: 5 }, maxOwned: 1,
  },
  item_hero_theodor: {
    name: 'HERO CONTRACT: THEODOR', kind: 'consumable', costKeep: 10_000,
    asset: 'hero_theo_portrait',
    desc: 'Recruits Theodor the Tsiodora: place his siege stool to consume this contract. Tradeable until used.',
    rarity: 'legendary', weight: 2, acquisition: { type: 'keep_level', keepLevel: 5 }, maxOwned: 1,
  },
  item_troop_mage: {
    name: 'MAGE TRAINING WRIT', kind: 'consumable', costKeep: 5_000,
    asset: 'ui_portrait_mage_t1',
    desc: 'USE to permanently unlock training Mages on this account. Tradeable until used.',
    rarity: 'rare', weight: 2, acquisition: { type: 'shop' }, maxOwned: 1,
    effect: { type: 'troop_unlock', troop: 'mage' },
  },
  item_troop_dragon: {
    name: 'DRAGON TRAINING WRIT', kind: 'consumable', costKeep: 0,
    asset: 'ui_portrait_dragon_t1',
    desc: 'USE to permanently unlock training Dragons on this account. Won from the Gold Forge; tradeable until used.',
    rarity: 'epic', weight: 2, acquisition: { type: 'drop' }, maxOwned: null,
    effect: { type: 'troop_unlock', troop: 'dragon' },
  },
  item_troop_gloamfang: {
    name: 'GLOAMFANG TRAINING WRIT', kind: 'consumable', costKeep: 0,
    asset: 'ui_portrait_gloamfang_t1',
    desc: 'USE to permanently unlock training Gloamfangs on this account. Won from the Gold Forge; tradeable until used.',
    rarity: 'epic', weight: 2, acquisition: { type: 'drop' }, maxOwned: null,
    effect: { type: 'troop_unlock', troop: 'gloamfang' },
  },
  item_troop_hexbarrow: {
    name: 'HEXBARROW TRAINING WRIT', kind: 'consumable', costKeep: 0,
    asset: 'ui_portrait_hexbarrow_t1',
    desc: 'USE to permanently unlock training Hexbarrows on this account. Won from the Gold Forge; tradeable until used.',
    rarity: 'epic', weight: 2, acquisition: { type: 'drop' }, maxOwned: null,
    effect: { type: 'troop_unlock', troop: 'hexbarrow' },
  },
  item_troop_direwyvern: {
    name: 'DIREWYVERN TRAINING WRIT', kind: 'consumable', costKeep: 0,
    asset: 'ui_portrait_direwyvern_t1',
    desc: 'USE to permanently unlock training Direwyverns on this account. The rarest forge prize; tradeable until used.',
    rarity: 'legendary', weight: 2, acquisition: { type: 'drop' }, maxOwned: null,
    effect: { type: 'troop_unlock', troop: 'direwyvern' },
  },
} as const satisfies Record<string, ItemSpec>;

/**
 * Phase E crafted materials (E2-WORKSHOP-CONTRACT §2; D-149 §5 recipe LOCKED:
 * 10,000 SHARDS → 1 Forge Ingot at a standing Workshop). costKeep 0 = never
 * sold by the system (the gear/writ convention); not dropOnly (owner: an
 * ordinary tradable material). Base-scoped inventory (`base_items`, follows the
 * deed on transfer); `acquired_via: 'craft'`. DARK until FORGE_INGOTS_ENABLED.
 */
export const MATERIAL_ITEMS = {
  forge_ingot: {
    name: 'FORGE INGOT', kind: 'material', costKeep: 0,
    asset: 'pe_ingot',
    desc: 'Refined from 10,000 SHARDS at the Workshop. Feeds the Gold Forge.',
    rarity: 'uncommon', weight: 0, acquisition: { type: 'craft' }, maxOwned: null,
  },
} as const satisfies Record<string, ItemSpec>;

/** Authoritative complete catalog. */
export const ITEMS = /* @__PURE__ */ Object.assign({}, LEGACY_ITEMS, GEAR_ITEMS, UNLOCK_ITEMS, MATERIAL_ITEMS) as
  typeof LEGACY_ITEMS & typeof GEAR_ITEMS & typeof UNLOCK_ITEMS & typeof MATERIAL_ITEMS;

export type ItemId = keyof typeof ITEMS;

/**
 * Elite troop item-gating (owner 2026-08-16 — quoted on UNLOCK_ITEMS above).
 * A wallet may TRAIN or RESEARCH these five troops only after consuming the
 * matching writ (troop_unlocks row, apps/api game/troopUnlocks.ts).
 */
export const ELITE_TROOP_UNLOCKS = {
  /** troop → the UNLOCK_ITEMS writ that unlocks it. */
  itemByTroop: {
    mage: 'item_troop_mage',
    dragon: 'item_troop_dragon',
    gloamfang: 'item_troop_gloamfang',
    hexbarrow: 'item_troop_hexbarrow',
    direwyvern: 'item_troop_direwyvern',
  },
  /**
   * GRANDFATHERING (critical — live players): any wallet that could train one
   * of these under the RETIRED rules at rollout, or that holds one in an
   * army/queue/research row, keeps the ability permanently. A one-shot worker
   * -boot backfill (grandfatherEliteTroopUnlocks) seeds troop_unlocks rows for
   * players created before `cutoverIso` using `legacyKeepGates` (the exact
   * requiresKeepLevel numbers this change removed; 1 = no gate existed, i.e.
   * every pre-cutover wallet), and train/research lazily self-heal any wallet
   * that already fields the troop. ⚠ cutoverIso is set one day past the
   * authoring date so every wallet existing at the first post-deploy worker
   * boot is covered; deploying after 2026-08-17 should move it forward.
   */
  grandfather: {
    cutoverIso: '2026-08-17T00:00:00.000Z',
    legacyKeepGates: {
      mage: 1,       // never Keep-gated — every existing wallet keeps it
      dragon: 1,     // never Keep-gated — every existing wallet keeps it
      gloamfang: 8,  // retired TROOPS.gloamfang.requiresKeepLevel
      hexbarrow: 10, // retired TROOPS.hexbarrow.requiresKeepLevel
      direwyvern: 14, // retired TROOPS.direwyvern.requiresKeepLevel
    },
  },
} as const;

export type EliteTroop = keyof typeof ELITE_TROOP_UNLOCKS.itemByTroop;

export function isEliteTroop(troop: string): troop is EliteTroop {
  return Object.prototype.hasOwnProperty.call(ELITE_TROOP_UNLOCKS.itemByTroop, troop);
}

// ---------------------------------------------------------------------------
// Gold Forge item drops (D-035, owner 2026-08-12). At settlement, each positive
// remaining deed/day position receives exactly one deterministic independent
// roll for every item. Transaction splitting creates no extra rolls. There is
// no minimum position, global quantity limit, or mutual exclusion.
// ---------------------------------------------------------------------------

export const FORGE_DROPS = {
  /** Hard ceiling on how many units of ONE item id a single deed can win per
   * UTC day, across however many settlement passes/retries run (owner
   * 2026-08-16: "we should drop 1-2 per item daily not more"). The v2 roll
   * design already yields at most ONE unit per item per deed/day
   * (computeBaseForgeDrops rolls each item id exactly once per deed/day, and
   * the settledAt claim gate + unique(day, baseId) position row make re-runs
   * grant nothing) — this constant pins the owner's ceiling so any future
   * multi-roll change has an explicit limit to respect, and tests enforce
   * that the per-deed/day yield never exceeds it. */
  dailyPerItemCap: 2,
  /** Independent chance per positive remaining deed/day position at settlement;
   * no eligibility floor, quantity limit, or mutual exclusion (bounded per
   * item by dailyPerItemCap above).
   *
   * The four elite TRAINING WRITS (owner 2026-08-16: "dragon only can be
   * dropped from gold forge, same for wyvern and rest of other way unlocked
   * troops") are forge-drop-only and market-tradeable (UNLOCK_ITEMS). ⚠ THE
   * WRIT ODDS ARE AGENT ASSUMPTIONS FOR OWNER TUNING (D-058): ranked by fielded
   * power (dragon 1.2% > gloamfang 0.8% > hexbarrow 0.5% > direwyvern 0.3%),
   * all rarer than every consumable but 12–48× the one-a-day-scale Aegis so an
   * active deed sees its first writ in days-to-weeks, not months.
   *
   * The ten WARDEN GEAR pieces are forge-drop-EXCLUSIVE since 2026-08-16
   * (owner: "gear also should be gathered exclusively from drops") — see
   * GEAR_ITEMS. ⚠ THE GEAR ODDS ARE AGENT ASSUMPTIONS FOR OWNER TUNING:
   * ranked by the pieces' retired KEEP prices (2.5% greaves → 0.15% mythic
   * banner) so cheap starter pieces land in weeks per deed while the Banner
   * of the Nine stays the rarest prize in the game. */
  independentDropBps: {
    keg_of_haste: 800,
    finishers_seal: 400,
    powder_charge: 200,
    warzone_aegis: 25,
    item_troop_dragon: 120,
    item_troop_gloamfang: 80,
    item_troop_hexbarrow: 50,
    item_troop_direwyvern: 30,
    marchers_greaves: 250,
    siege_gauntlets: 180,
    wardens_helm: 100,
    keepward_signet: 100,
    shardplate_cuirass: 60,
    voidweave_cloak: 60,
    bulwark_deep_keep: 60,
    first_shard_amulet: 40,
    breaker_of_gates: 40,
    banner_of_nine: 15,
  },
  /** @deprecated SIM8 settlement compatibility; API migration removes this.
   * Its legacy per-item limits are GLOBAL winner counts for the retired
   * wallet-scoped path (each wallet wins at most ONE item/day there), so the
   * per-deed dailyPerItemCap holds on that path too. */
  minCountedShards: 100,
  /** @deprecated SIM8 settlement compatibility; new awards use independentDropBps. */
  table: [
    { itemId: 'warzone_aegis', dailyLimit: 1 },
    { itemId: 'powder_charge', dailyLimit: 2 },
    { itemId: 'finishers_seal', dailyLimit: 4 },
    { itemId: 'keg_of_haste', dailyLimit: 8 },
  ],
} as const satisfies {
  dailyPerItemCap: number;
  independentDropBps: Readonly<Record<
    | 'keg_of_haste' | 'finishers_seal' | 'powder_charge' | 'warzone_aegis'
    | 'item_troop_dragon' | 'item_troop_gloamfang' | 'item_troop_hexbarrow' | 'item_troop_direwyvern'
    | keyof typeof GEAR_ITEMS,
    number
  >>;
  minCountedShards: number;
  table: ReadonlyArray<{ itemId: ItemId; dailyLimit: number }>;
};

// ---------------------------------------------------------------------------
// Treasury buy-vend pricing retained for historical-intent recovery
// (ONRAMP-WALLETS-PLAN §2/§5, Phase 4, owner 2026-07-24). NEW intents are
// fail-closed until real reserve KEEP funding exists. BUY-ONLY by design when
// re-enabled: the reverse (an operated
// KEEP→SOL sell-desk) is a money-transmission red line — selling happens only
// via user-signed withdrawal + DEX post-liquidity. During the liquidity
// bootstrap the vend SOL routes 100% to the liquidity wallet (same rail as
// mine builds), and every ledger credit must stay covered by the hot wallet's
// KEEP reserve (Proof of Reserves, money/snapshot.ts).
// ---------------------------------------------------------------------------

export const VEND = {
  /** KEEP per 1 SOL. ⚠ ALPHA PLACEHOLDER retained for the disabled vend; no
   * market exists pre-TGE and this rate must be reviewed before any re-enable. */
  keepPerSol: 50_000,
  /** Per-purchase bounds (whole KEEP) — dust floor + fat-finger/whale ceiling. */
  minKeepPerPurchase: 100,
  maxKeepPerPurchase: 1_000_000,
} as const;

/** Lamports charged for `wholeKeep` at the vend rate — server + client compute
 * identically (ceil so the treasury never undercharges by rounding). */
export function vendLamportsForKeep(wholeKeep: number): bigint {
  return (BigInt(wholeKeep) * 1_000_000_000n + BigInt(VEND.keepPerSol) - 1n) / BigInt(VEND.keepPerSol);
}

// ---------------------------------------------------------------------------
// PROFILE › WALLET tab (owner 2026-08-15/M23): the connected wallet's on-chain
// balances + Jupiter exchange. These are CHAIN CONFIG, not game numbers, but
// they live here so both agents and the api/web share one source.
// ---------------------------------------------------------------------------

export const WALLET_HUB = {
  /** Read-only mainnet RPC for the SKR/USDT/USDC balance rows (the game runs
   * on devnet in alpha; those assets exist only on mainnet). The public
   * endpoint is rate-limited but fine for a few reads per tab open. */
  mainnetRpc: 'https://api.mainnet-beta.solana.com',
  /** Jupiter Plugin (Ultra) script — swaps settle on MAINNET, user-signed,
   * no RPC of ours involved (developers.jup.ag/docs/tool-kits/plugin). Selling
   * KEEP stays withdrawal→DEX per ONRAMP-WALLETS-PLAN D2; we never operate a
   * conversion desk. */
  jupiterPluginUrl: 'https://plugin.jup.ag/plugin-v1.js',
  /** SPL token rows shown in the tab. `cluster: 'game'` reads the app's own
   * connection (devnet in alpha); `cluster: 'mainnet'` reads mainnetRpc.
   * Decimals come from the parsed account response, never hardcoded.
   * ⚠ KEEP mint = infra/devnet.addresses.json `keepMint` (v3, 2026-07-28).
   * A mint rotation or the mainnet TGE MUST update this row (the addresses
   * file's rotation checklist applies). */
  tokens: [
    { symbol: 'KEEP', cluster: 'game', mint: '5GQh8Dg2BFtH3Yso5drRA2K8omw46m3KAQrhH3TMpWJC' },
    // SKR (Seeker | Solana Mobile), TGE 2026-01. Mint cross-checked 2026-08-15
    // against Solflare's price page and the GeckoTerminal SKR/SOL pool.
    { symbol: 'SKR', cluster: 'mainnet', mint: '79dd8EvWuGjPTnTMMBoY6Nqtdw5u1cXaGh4azuLGjiAj' },
    // Circle USDC + Tether USDT canonical mainnet mints.
    { symbol: 'USDC', cluster: 'mainnet', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    { symbol: 'USDT', cluster: 'mainnet', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  ],
} as const;
export type WalletHubCluster = (typeof WALLET_HUB.tokens)[number]['cluster'];

// ---------------------------------------------------------------------------
// Marketplace — Lane A (external NFT marketplaces, MARKETPLACE-ESCROW-SPEC §3).
// Tradable assets are Metaplex Core NFTs (deeds now; NFT cosmetics later) that
// carry a 5% royalty on the collection AND on each asset — MARKETPLACE-HONOURED,
// not enforced on chain (ruleSet None: mpl-core abstains on transfer, so Tensor /
// Magic Eden pay it because they choose to). Enforcement would require a
// ProgramAllowList rule set, which blocks trading anywhere off the list. Still
// ZERO program from us. These are the canonical mainnet URL patterns; devnet has
// no Tensor/ME liquidity, so the links only matter at TGE.
// ---------------------------------------------------------------------------

export const MARKETPLACE = {
  /** Team fee on the IN-APP item market (SOL-settled, apps/api game/itemMarket).
   *  Seeded at 5% to match deedRoyaltyBps, but this one is a live server-side
   *  knob: it applies per sale, so
   *  changing it only changes future fills. ⚠ ALPHA PLACEHOLDER (owner tunes). */
  feeBps: 500,
  /** Creator royalty written into every Land Deed (collection plugin + a
   *  matching asset-level plugin on each mint). Marketplace-HONOURED, not
   *  enforced on chain — see the block comment above.
   *
   *  ⚠ NOT A LIVE KNOB, unlike feeBps: this number is written IMMUTABLY into
   *  each minted asset's Royalties plugin. Changing it here only affects the
   *  collection + future mints; every already-minted deed keeps the old bps
   *  until an admin re-stamps it with a full `deed:royalty` sweep over every
   *  asset in the players table. Change the number and the sweep together, or
   *  the fleet silently splits into two royalty rates.
   *  ⚠ THE RATE ONLY. WHERE it is paid is NOT here and must never be: an
   *  address is deployment config, not a game number, and the owner needs to
   *  set the final treasury without a code change ("5% royalty I want to be
   *  flexible so lets add it in env file and I will set address manually there
   *  so before mainnet deployment I will add final address there", 2026-07-29).
   *  The destination lives in `DEED_ROYALTY_CREATOR` (.env / apps/api config),
   *  and the ON-CHAIN source of truth is the collection's Royalties plugin,
   *  which every deed mirrors verbatim. Moving it is one command:
   *    pnpm --filter @shardkeep/scripts deed:royalty:creator --confirm
   *  Source: owner 2026-07-29 "deed nfts should be tradeable and should have
   *  royalty fee"; 5% owner-selected. */
  deedRoyaltyBps: 500,
  /** Trading gate: whether deeds are TRANSFERABLE. This is the single source of
   *  truth for the mint path too — mintLandDeed sets the PermanentFreezeDelegate
   *  to `frozen: !tradingEnabled`, so the flag and the chain can never disagree
   *  (security review 2026-07-29 F6: they did, and new players were minting
   *  soulbound deeds while the UI advertised live trading). TRUE since
   *  2026-07-29: the owner called the thaw ("deed nfts should be tradeable"),
   *  all 4 devnet deeds were thawed on chain (frozen: false verified), and the
   *  buyer-claim path that makes a traded deed actually convey a base is live
   *  and reviewed. Flipping this back to false re-freezes NEW mints only —
   *  already-thawed assets need a re-freeze sweep; the chain is the truth. */
  tradingEnabled: true,
  /** Pull-based base claim (CLANS-SELLABLE-DEEDS-PLAN S1-Q, resolved by the
   *  owner 2026-07-29: "deed nfts should be tradeable and should have royalty
   *  fee"). A deed that trades on an external marketplace only conveys a base
   *  when the BUYER claims it — the server re-reads DAS at that moment, which
   *  is what kills the stale-observation / indexer-lag / escrow-lockout classes
   *  a push watcher had. These two numbers bound the claim's fan-out. */
  claim: {
    /** Per-IP cap on /base/claimable + /base/claim. Each call costs 1 DAS
     *  search + up to `maxCandidates` getAsset reads, so this caps the Helius
     *  spend a single client can force. */
    rateLimitPerMin: 10,
    /** Deeds verified per claim call. A buyer claims ONE base; >1 only happens
     *  when a wallet holds several deeds, and the extra ones stay claimable on
     *  the next call. Bounds the RPC fan-out per request. */
    maxCandidates: 5,
  },
  /** In-app item market (SOL-settled, owner 2026-07-24). Consumables trade P2P
   *  for SOL: buyer pays the seller 95% + our fee treasury feeBps, direct from
   *  their wallet (non-custodial). Unlike deeds, items aren't soulbound → LIVE
   *  now. Price bounds in LAMPORTS: dust-floor 0.0001 SOL → ceiling 1000 SOL.
   *  ⚠ ALPHA PLACEHOLDERS (owner tunes). */
  itemMarket: {
    minPriceLamports: 100_000, // 0.0001 SOL
    maxPriceLamports: 1_000_000_000_000, // 1000 SOL
    /** Cap concurrent open listings per seller (anti-spam). */
    maxActiveListingsPerSeller: 20,
    /** Cap concurrent live reservations per buyer (anti-grief: reserving is free
     *  and hides a listing from browse, so a whale could lock the whole market —
     *  security review 2026-07-24 #3). */
    maxReservationsPerBuyer: 5,
    /** Reservation lock window (seconds). Solana finalizes in ~13s and the client
     *  polls settle every 2.5s, so a short window is ample and bounds griefing. */
    reserveTtlSec: 120,
    /** Extra grace (seconds) past the TTL before a lapsed reservation can be
     *  RECLAIMED/taken over, even WITHOUT a committed signature. Set above a
     *  blockhash's validity window (~150s) so ANY payment broadcast during the
     *  reservation has finalized — and is caught by the paid-check — before a
     *  reclaim can fire. This makes the client's signature-commit a pure
     *  optimization (shorter hold when it lands), never a correctness dependency:
     *  a dropped /paid POST can't cost a buyer their SOL (security review
     *  2026-07-24 #2a + zero-loss follow-up). */
    reclaimGraceSec: 180,
    /** Once the buyer COMMITS a payment signature (safeguard), the reservation
     *  stays locked to them for this long — long past any blockhash's validity
     *  (~150s) so a valid payment always finalizes (→ settles to the buyer) before
     *  a stuck/dropped one can be reclaimed. A buyer with a committed payment can
     *  therefore never lose the item to a reopen. */
    settleTimeoutSec: 600,
    /** Worker reconciler cadence (seconds) for reservations the buyer's client
     *  stopped polling (tester report 24b9184d, 2026-09-16: a lapsed reservation
     *  sat `reserved` for hours with the item held and nobody told either side).
     *  Every pass settles committed/paid rows to their buyer and releases lapsed
     *  UNPAID rows back to the book once they pass the reclaim cutoff above, so
     *  neither outcome ever depends on a client tab staying open. */
    reconcilePollSec: 60,
    /** Rows one reconciler pass may verify (each is up to two RPC reference
     *  scans); never-attempted rows first (oldest reservation first among
     *  them), then least recently attempted — see reconcileRetrySec. */
    reconcileBatch: 25,
    /** Minimum seconds between reconciler attempts on ONE reservation a pass
     *  could not resolve (finalized proof unavailable, RPCs disagree, committed
     *  but not yet final). Rows queue least-recently-attempted first and
     *  never-attempted first of all, so a freshly lapsed reservation is read on
     *  its first eligible pass however many stuck rows exist (security review
     *  2026-09-17 #1: 25 permanently uncertain rows filled every batch and
     *  starved newer lapsed reservations, at two RPC calls per row per
     *  minute). Well past a blockhash's validity (~150s): a proof still absent
     *  after this interval will not appear by polling harder, while a buyer
     *  whose client closed still receives delivery within reconcilePollSec +
     *  this once finality lands. */
    reconcileRetrySec: 300,
  },
  /** External marketplace bases (MAINNET). */
  tensorBase: 'https://www.tensor.trade',
  magicEdenBase: 'https://magiceden.io',
} as const;

/** Tensor item page for a Core asset mint. */
export function tensorItemUrl(mint: string): string {
  return `${MARKETPLACE.tensorBase}/item/${mint}`;
}
/** Magic Eden item page for a Core asset mint. */
export function magicEdenItemUrl(mint: string): string {
  return `${MARKETPLACE.magicEdenBase}/item-details/${mint}`;
}
/** Tensor collection page (by collection mint address). */
export function tensorCollectionUrl(collection: string): string {
  return `${MARKETPLACE.tensorBase}/trade/${collection}`;
}
/** Magic Eden collection page (by collection mint address). */
export function magicEdenCollectionUrl(collection: string): string {
  return `${MARKETPLACE.magicEdenBase}/marketplace/${collection}`;
}

// ---------------------------------------------------------------------------
// Seeker identity (Solana Mobile) + usernames
// ---------------------------------------------------------------------------

/**
 * Solana Mobile **Seeker Genesis Token** identity.
 *
 * Source: the Solana Mobile SGT specification and live mainnet-beta reads,
 * recorded in `docs/research/research-solana-client-stack.md` §5 and verified
 * 2026-07-29.
 *
 * IMPORTANT: the SGT lives on **mainnet-beta** while the game economy runs on
 * devnet, so verification uses a SEPARATE read-only connection
 * (`SOLANA_MAINNET_RPC_URL`); it never touches the devnet money path.
 *
 * The badge test is the FOUR-WAY predicate below — all four must hold on the
 * candidate mint, on top of Token-2022 + supply 1 + decimals 0. Any single one
 * is forgeable on its own (anyone can mint a Token-2022 NFT and point a
 * metadataPointer wherever they like); the conjunction is not, because
 * `mintAuthority` and `tokenGroupMember.group` are set by Solana Mobile.
 */
export const SEEKER = {
  sgt: {
    /** Token-2022. A legacy SPL-Token mint can never be an SGT. */
    tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    /** mint.mintAuthority — Solana Mobile's issuing authority. */
    mintAuthority: 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4',
    /** extensions.metadataPointer.authority — same issuer. */
    metadataAuthority: 'GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4',
    /** extensions.metadataPointer.metadataAddress — the collection metadata. */
    metadataAddress: 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te',
    /** extensions.tokenGroupMember.group — the Genesis Token group. */
    group: 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te',
  },
  /**
   * AllDomains ANS `.skr` namespace — used for NAMING ONLY, never for the badge.
   * Verified live 2026-07-29 against `torqueond.skr` (name account
   * `4eDbAer2fqjQWD8Q9HDcMofEEXz24UUZGptCh1t7snc5`).
   *
   * `.skr` is a commercial namespace with no proven Seeker exclusivity and no
   * sybil resistance, so owning one grants NO badge (brief §4). A verified
   * Seeker may adopt theirs as a username; that is all.
   */
  skr: {
    tld: '.skr',
    ansProgram: 'ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK',
    tldHouse: '4RKP4BEMu5sXBfXSH7xN2owtQrnAJvhhwtBBmj9JEYkA',
    /** The `.skr` parent name account — asserted so a `foo.sol` can't pose as `.skr`. */
    parentNameAccount: 'F3A8kuikEiu6k2399oSJ1PWfcJYDHqpwoQ2e8psSDNuF',
    /**
     * AllDomains TLD House PROGRAM (distinct from the `.skr` tldHouse ACCOUNT
     * above) — owns the per-wallet MainDomain PDA used as the discovery fast
     * path. Source: onsol-labs/tld-parser; verified live 2026-07-31 against
     * torqueond.skr's owner wallet.
     */
    tldHouseProgram: 'TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S',
    /** MainDomain PDA seed prefix: PDA([prefix, owner], tldHouseProgram).
     *  Source: tld-parser `getMainDomainKey`. */
    mainDomainPrefix: 'main_domain',
    /** Anchor account discriminator of MainDomain — sha256("account:MainDomain")
     *  [0..8], per tld-parser's borsh layout. Checked before decoding so an
     *  unrelated account at the PDA can never be misread as a domain. */
    mainDomainDiscriminator: [109, 239, 227, 199, 98, 226, 66, 175],
    /**
     * NameRecordHeader byte size — a reverse-lookup account stores the raw
     * label AFTER this offset (no length prefix). Verified live 2026-07-31:
     * reverse account 5PeCJ6o64GZ6yySmVAovRaRQJpHZSw2yYz7wqbGTfaJW has space
     * 209 = 200-byte header + "torqueond" (9 bytes).
     */
    nameRecordByteSize: 200,
    /** Reverse-lookup candidates inspected per discovery. Bounds what a
     *  domain-hoarding wallet can make one link cost us; earliest-created
     *  domains sort first, so real Seekers fit comfortably inside it. */
    maxReverseCandidates: 8,
  },
  /**
   * mainnet-beta's genesis hash — the cluster fingerprint asserted at boot
   * against SOLANA_MAINNET_RPC_URL (security review F8). Nothing else in the
   * config distinguishes clusters, and aiming that variable at devnet would make
   * every SGT check silently fail — or, on a cluster where anyone can create the
   * authorities the predicate trusts, silently PASS.
   * Source: `solana genesis-hash --url mainnet-beta` (fixed since genesis).
   */
  mainnetGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  /**
   * Badge staleness budget. Two meanings, both server-enforced:
   *  - a verdict younger than this is REUSED (no mainnet read), so a client
   *    spamming `?refresh=1` cannot turn our badge into an RPC amplifier;
   *  - a verdict older than this is NOT TRUSTED — the badge is re-verified
   *    lazily on the next read, so selling the SGT drops the badge within a
   *    day even with no cron running (security review F4/F5).
   */
  recheckHours: 24,
  /** Link-challenge TTL (minutes) — mirrors the sign-in NONCE_TTL_MS. */
  linkChallengeTtlMin: 5,
  /**
   * TOTAL wall-clock budget for ONE holding verification, across every RPC call
   * it makes. A third party we do not control sits on the other end of these
   * reads and /me now triggers them lazily, so an unbounded read would let a
   * slow mainnet endpoint pin our request workers (security review F4).
   */
  rpcTimeoutMs: 5_000,
  /**
   * Cap on 1-of-1 Token-2022 mints INSPECTED in one verification.
   *
   * This bounds the candidate LIST, not the number of RPC calls: the mints are
   * read `mintBatchSize` at a time with `getMultipleAccounts`, so 500 candidates
   * cost 5 calls, not 500 (security review F4 is satisfied by the batching, not
   * by refusing to look). The old cap of 12 bounded the calls instead and was a
   * correctness bug: a Seeker whose wallet also holds a few dozen airdropped
   * NFTs was told "no Seeker Genesis Token in that wallet" — they bought the
   * device and the game denied it (2026-07-29 review, finding (b)).
   */
  maxCandidateMints: 500,
  /**
   * Mints per `getMultipleAccounts` call. 100 is the documented server-side
   * maximum for that method on Agave RPC; larger requests are rejected outright.
   */
  mintBatchSize: 100,
  /** `GET /seeker/status?refresh=1` per IP per minute — the only authenticated
   *  route that can reach mainnet, so it gets its own ceiling on top of
   *  recheckHours (security review F4). Ignored under NODE_ENV=test. */
  statusRefreshPerMin: 10,
  /** After a lazy re-verify FAILS (mainnet unreachable), how long before this
   *  account tries again. Without it an outage turns every /me poll into another
   *  outbound call — the F4 hole arriving through the front door. */
  recheckBackoffMin: 5,
  /**
   * Seeker AUTO-DETECTION at the first alpha-gate probe after sign-in (owner
   * 2026-08-08: Seeker users enter with no invite code, detected automatically).
   * The completed sign-in already proves control of the session wallet, so the
   * server may probe THAT wallet for an SGT with no second challenge. Session
   * creation itself never waits on mainnet. Both knobs bound what the OPEN,
   * pre-alpha-gate surface can make us spend there.
   */
  /** A wallet whose probe answered a definitive "no SGT" this recently is not
   *  probed again — the negative twin of recheckHours. */
  autoDetectRecheckHours: 24,
  /**
   * Ceiling on SGT probes per minute, ALL wallets combined (in-process
   * counter) — spent by gate auto-detect and by the manual
   * /seeker/link/verify holding check alike. Both are reachable before the
   * alpha gate, so without a global cap a stream of fresh wallets could spend
   * the whole mainnet RPC quota — and a starved quota fail-closes REAL
   * Seekers' badges. Past the ceiling auto-detect silently defers to a later
   * gate or /me read; the manual link answers a retryable 503.
   */
  autoDetectGlobalPerMin: 60,
} as const;

/**
 * Username rules (owner 2026-07-29: "there is 0 indication that I am a seeker
 * user" → identity needs to be visible AND unforgeable).
 *
 * `clans.name` has been UNIQUE since day one; `players.name` never was, so two
 * players could share a name and one could rename INTO another's name — free
 * impersonation on a money surface. Uniqueness is case-folded via
 * `players.name_key`.
 */
export const USERNAMES = {
  minLen: 3,
  maxLen: 16,
  /** Self-chosen names: letters/digits/_/- , must start+end alphanumeric.
   *  NO spaces and NO dots — dots are reserved so a self-chosen name can never
   *  collide with a verified `x.skr` domain name. */
  pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{1,14}[A-Za-z0-9]$',
  /**
   * Adopted `x.skr` names get their OWN bounds — they are proven on-chain, so
   * they may carry the one dot `pattern` bans, but "proven" is not "safe":
   * `support.skr` beside a VERIFIED badge is a phishing surface, and ANS allows
   * 63-char labels that would blow the name out of every UI it appears in
   * (security review F1). Label charset is `pattern`'s, minus the length floor —
   * a 2-character domain is a real on-chain name and its owner may still have it.
   */
  skrMaxLen: 24,
  /** Label of `x.skr`: same character class as `pattern`, any length ≥ 1.
   *  Matched against the lowercased label (ANS labels are lowercase). */
  skrLabelPattern: '^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$',
  /** Anti-impersonation: a rename is a change of identity, not a costume. */
  changeCooldownDays: 30,
} as const;

/** Owner 2026-09-07 private feedback: readable, metadata-free screenshots.
 * Storage/decoder limits bound API memory and work; counts/retention are enforced
 * by the thread lifecycle, not by the object store. */
/** Private thread response/request bounds (owner 2026-09-07). */
/** D-116: bounded deterministic search over admin-curated public issue text. */
export const FEEDBACK_ISSUES = {
  /** D-116: bounded admin catalogue/audit pages with complete cursor traversal. */
  adminPageSize: 50, cursorMaxLen: 160,
  /** D-116 operational transaction bound; reject oversized merges without writes. */
  maxMergeReports: 500, maxSplitReports: 500,
  /** Debounce typed issue suggestions; same cadence as the existing map lookup. */
  searchDebounceMs: 250,
  resultLimit: 20, queryMaxLen: 160, maxTerms: 8,
  titleTermWeight: 4, summaryTermWeight: 1, workaroundTermWeight: 1,
} as const;

export const FEEDBACK_THREADS = { pageSize: 50, replyMaxLen: 2_000, requestIdMaxLen: 120,
  reportCursorMaxLen: 384,
  /** D-103: existing optional report fix-reference length, shared by old/new controls. */
  fixedRefMaxLen: 120,
  /** D-116: wallet-bound defense independent of IP/Redis admission. */
  replyWindowMs: 60_000, maxRepliesPerWindow: 12, moderationReasonMaxLen: 1_000,
  contextScreenMaxLen: 32, viewportMaxPx: 32_768, devicePixelRatioMax: 16,
  /** Owner 2026-09-18: display-only client label. Bounds the release parsed from
   * the native `PKW-Native/<release>` User-Agent ("0.5.4", "0.5.4-candidate:20:<sha40>"). */
  clientReleaseMaxLen: 80,
} as const;

export const FEEDBACK_SCREENSHOTS = {
  maxPerMessage: 8,
  maxPerThread: 32,
  /** Fixed staff allocation keeps private note activity out of player quotas. */
  maxStaffPerThread: 16,
  uploadWindowMs: 60_000,
  maxUploadsPerWindow: 16,
  maxUploadBytes: 8 * 1024 * 1024,
  maxNormalizedBytes: 8 * 1024 * 1024,
  maxDecodedPixels: 24_000_000,
  maxInputEdge: 16_384,
  maxOutputEdge: 4_096,
  webpEffort: 4,
  maxConcurrentNormalizations: 2,
  maxConcurrentRawUploads: 2,
  /** Same bounded receive window as profile uploads; phone connections may be slow. */
  uploadReceiveTimeoutMs: 240_000,
  maxConcurrentReads: 8,
  maxConcurrentMutations: 2,
  storageTimeoutMs: 10_000,
  abandonedRetentionHours: 24,
  closedRetentionDays: 180,
  /** D-116: bounded cleanup with durable late-PUT tombstone retries. */
  cleanupBatchSize: 4,
  cleanupPollMs: 60_000,
  cleanupRetryMs: 60 * 60 * 1000,
} as const;

/** D-116: private background exports stream through disk/R2 rather than RAM.
 * A two-GiB artifact stays below R2's single-upload ceiling; oversize jobs fail
 * explicitly so an admin can narrow the selection, never receive truncation. */
export const FEEDBACK_EXPORTS = {
  // Private export worker resource bounds; one durable preparation lease globally.
  cleanupBatchSize: 4,
  cleanupPollMs: 60_000,
  cleanupRetryMs: 60 * 60 * 1000,
  temporaryScanEntries: 256,
  temporaryMarkerMaxBytes: 512,
  preparationPollMs: 5_000,
  maxActiveJobsPerAdmin: 4,
  maxRequestsPerHour: 12,
  preparationLeaseMs: 180_000,
  preparationHeartbeatMs: 30_000,
  preparationRetryMs: 60_000,
  maxPreparationAttempts: 3,
  schemaVersion: 1,
  pageSize: 50,
  retentionHours: 24,
  maxBytes: 2 * 1024 * 1024 * 1024,
  maxArchiveEntries: 100_000,
  storageTimeoutMs: 300_000,
  maxConcurrentReads: 2,
  maxConcurrentMutations: 2,
} as const;

/**
 * Public profile-avatar resource bounds (owner 2026-08-13: upload a custom
 * avatar from phone or PC). These are security/cost limits as well as product
 * limits: hostile compressed images are decoded inside the API process and
 * normalized results are written to the public object store.
 */
export const PROFILE_AVATAR = {
  maxUploadBytes: 8 * 1024 * 1024,
  maxDecodedPixels: 24_000_000,
  outputSizePx: 256,
  maxNormalizedBytes: 256 * 1024,
  maxConcurrentNormalizations: 2,
  /** R2 writes/deletes run while the wallet avatar generation is serialized.
   * Bound both pool occupancy and the number of hostile buffers held in memory. */
  maxConcurrentMutations: 2,
  /** Opaque same-origin globe images are proxied in bounded parallel so one
   * visible valley cannot turn an R2 slowdown into unbounded API sockets. At
   * the normalized object cap this admits at most 4 MiB of response bodies. */
  maxConcurrentReads: 16,
  /** Pre-auth/IP abuse ceiling for the opaque image proxy. It is deliberately
   * much higher than an honest wallet budget: carrier-grade NAT can put several
   * active globe/chat players behind one IP, while 1,200 remains a finite,
   * fail-closed cap ahead of session verification and DB/R2 work. */
  readIpAbuseLimitPerMin: 1_200,
  /** Post-auth wallet ceiling. A combined globe (36) + chat history (50) can
   * paint 86 distinct avatars; 360 admits four such cold views per minute plus
   * UI churn, without letting IP rotation create an unbounded proxy reader. */
  readWalletLimitPerMin: 360,
  /** Mobile-safe receive window for the full 8 MiB upload (~0.27 Mbps minimum).
   * Long enough for weak cellular uplinks, finite so authenticated slow-body
   * clients cannot occupy both process-local raw-buffer permits indefinitely. */
  uploadReceiveTimeoutMs: 240_000,
  storageMutationTimeoutMs: 5_000,
  /** Retired immutable avatar generations are deleted by the existing minute
   * worker. Transient object-store failures retry forever, but durable backoff
   * keeps an old outage from starving newer retirement rows. */
  retirementBatchSize: 20,
  /** One isolated worker invocation drains at most four batches. Admission is
   * capped at that same 80-row healthy-drain window, so distributed API replicas
   * cannot grow an unbounded public-object retirement backlog during an outage. */
  retirementMaxBatchesPerRun: 4,
  retirementMaxPending: 80,
  retirementPollMs: 60_000,
  retirementRetryBaseMs: 60_000,
  retirementRetryFactor: 2,
  retirementRetryMaxMs: 3_600_000,
  retirementAlertAfterAttempts: 8,
  retirementWorkerConcurrency: 1,
  mutationsPerMinute: 6,
  publicCacheSeconds: 300,
} as const;

/** Global-chat launch contract (owner 2026-08-13). These are product, abuse,
 * storage and mobile-polling limits, so every client and the authoritative API
 * consume one definition. Global only; this does not enable clan/DM chat. */
export const CHAT = {
  maxGraphemes: 280,
  maxUtf8Bytes: 1024,
  /** JSON envelope headroom while rejecting oversized bodies before auth. */
  requestBodyMaxBytes: 3 * 1024,
  maxLines: 4,
  pageSize: 50,
  domMessageLimit: 200,
  pollOpenMs: 2_000,
  pollClosedMs: 20_000,
  /** One open panel polls events 30/min. Four times that honest cadence leaves
   * reconnect/history/status headroom while keeping one authenticated wallet
   * bounded independently of a carrier-NAT IP shared by many phones. */
  readsPerWalletMinute: 120,
  /** Pre-auth DDoS floor only. High enough for many phones behind one NAT;
   * authenticated fairness is enforced independently per wallet. */
  readsPerIpMinute: 3_000,
  /** Tapping a message author opens one compact public card (owner
   * 2026-09-18). A person opens a handful a minute; an own wallet bucket keeps
   * card taps from spending polling capacity and bounds harvesting the visible
   * page (pageSize messages) into profiles. */
  authorCardsPerWalletMinute: 30,
  blockMutationsPerHour: 30,
  /** Admin moderation presets; null remains the explicit permanent option. */
  muteDurationHours: [1, 24, 168] as const,
  sendCooldownMs: 5_000,
  sendsPerHour: 20,
  /** NAT-safe shared IP ceiling; wallet cap remains the primary spam budget. */
  sendsPerIpHour: 200,
  visibleRetentionDays: 7,
  evidenceRetentionDays: 90,
  reportsPerDay: 10,
  reportsPerIpDay: 100,
  retentionBatchSize: 500,
  /** Five bounded batches per isolated run provide 120k deletions/day: above
   * the supported 160 active deeds × 20 sends/hour × 24h = 76,800/day. */
  retentionMaxBatchesPerRun: 5,
  retentionWorkerConcurrency: 1,
  retentionPollMs: 30 * 60_000,
  rateBucketRetentionDays: 2,
} as const;

/**
 * Browser SFX working-set and voice limits (owner 2026-08-14: the complete
 * 247-export pack must remain smooth during complex raids on narrow phones).
 *
 * These are presentation limits, never simulator rules. A battle acquires only
 * its relevant sound bank; the 16 MiB decoded-buffer ceiling is deliberately
 * far below the ~87 MiB a naive decode of all 247 two-second mono cues would
 * occupy, while leaving room for a normal 20–40-cue battle bank. Four fetches
 * avoid a cellular request burst, and 24 voices / three duplicates preserve
 * important variety without allowing one same-tick impact family to monopolize
 * a mobile AudioContext. The 24 ms coalesce window is shorter than one 30 fps
 * frame and well below the 120 ms hold-deploy cadence.
 */
export const AUDIO_RUNTIME = {
  maxDecodedBytes: 16 * 1024 * 1024,
  preloadConcurrency: 4,
  maxOneShotVoices: 24,
  maxOneShotVoicesPerCue: 3,
  duplicateCoalesceMs: 24,
  /** Replay cues are decoded in six-second slices, with the next slice warmed
   * three seconds early. At most two ordinary slices overlap on a healthy CDN. */
  battleBankWindowMs: 6_000,
  battleBankPreloadLeadMs: 3_000,
  /** Network stalls degrade to the old pack instead of freezing ATTACK. */
  manifestRequestTimeoutMs: 1_500,
  manifestRetryDelayMs: 5_000,
  assetRequestTimeoutMs: 3_500,
  bankReadyDeadlineMs: 3_500,
  /** Audio is optional juice; initial ATTACK waits at most a perceptually
   * sub-frame budget, and a mid-battle re-feed never waits for it. */
  initialBattleAudioBudgetMs: 120,
  /** Environmental bed stays beneath both the 0.4 music bus and action SFX. */
  ambienceVolume: 0.16,
} as const;

// ---------------------------------------------------------------------------
// Tester program (owner 2026-08-21: "implement leaderboard for users on website
// … who finished what … each finished task should have points award for testers.
// based on what's more important more points … feedback engine every feedback
// received certain points based on importance"). Points are frozen into
// tester_milestones at insert; retuning here changes only FUTURE awards.
// Weights: money/web3 paths (withdrawal, land, deposit) > combat/economy loops >
// onboarding basics > social. Tiered keys (…_10, …_50) are separate milestones.
// ---------------------------------------------------------------------------
export const TESTER_PROGRAM = {
  /** Public board size and the per-wallet progress lookup are read-only. */
  leaderboardLimit: 100,
  /** One public/in-game recompute per wallet per this many ms (cheap, but
   *  bounded — the worker sweep covers everyone else). */
  recomputeMinIntervalMs: 60_000,
  /** Worker sweep cadence over every player (backfill + catch-up). */
  sweepEveryMs: 10 * 60_000,
  /** Public board hygiene (owner 2026-08-22: no ghost/test accounts): a wallet
   *  is listed only once it has founded a base; team/internal wallets and
   *  admin-hidden wallets never appear. Points still accrue and the wallet
   *  still sees its own progress in-game. */
  board: {
    requiredMilestone: 'base_founded',
    /** Owner 2026-08-22 ("we need that KEEPER account if not real users
     *  removed"): production showed scripted bursts of sign-in-once wallets
     *  (25 on 2026-06-12, 25 on 06-13, 13 on 07-18; none ever returned) whose
     *  only milestones were these two, plus deed rows with zero sessions. A
     *  listed wallet must therefore have done at least one thing BEYOND
     *  founding, and must have signed in at least once (a session row). */
    foundingOnlyKeys: ['signed_in', 'base_founded'],
    requireSession: true,
  },
  feedback: {
    /** Awarded on submit for the first `dailyPaidSubmissions` per UTC day. */
    basePoints: 10,
    dailyPaidSubmissions: 3,
    /** Hard per-day submission cap (anti-spam); later ones are refused. */
    dailyMaxSubmissions: 8,
    /** Admin importance rating bonus — replaces, never stacks. */
    importanceBonus: { low: 0, medium: 20, high: 50, critical: 120 },
    /** A rejected / duplicate report keeps its base points but earns no bonus. */
    categories: ['bug', 'balance', 'ux', 'idea', 'other'],
    titleMaxLen: 80,
    bodyMinLen: 10,
    bodyMaxLen: 2_000,
  },
  /** Milestone catalog. `key` is the durable identity in tester_milestones. */
  milestones: [
    // --- First steps ---------------------------------------------------------
    { key: 'signed_in', category: 'first_steps', points: 5, title: 'Sign in with your wallet', hint: 'Connect and sign the SIWS message once.' },
    { key: 'name_set', category: 'first_steps', points: 5, title: 'Choose a display name', hint: 'Profile → set your name (3–16 chars).' },
    { key: 'avatar_set', category: 'first_steps', points: 5, title: 'Set a profile avatar', hint: 'Profile → upload an avatar.' },
    { key: 'tutorial_done', category: 'first_steps', points: 15, title: 'Finish the tutorial', hint: 'Complete every tutorial step (replayable from the menu).' },
    { key: 'base_founded', category: 'first_steps', points: 10, title: 'Found your base', hint: 'Your first Keep stands.' },
    { key: 'mine_upgraded', category: 'first_steps', points: 10, title: 'Upgrade a Mine', hint: 'Any Mine reaches level 2 or higher.' },
    { key: 'mine_collected', category: 'first_steps', points: 10, title: 'Collect mined shards', hint: 'Tap a Mine to collect its buffer.' },
    { key: 'cache_claimed', category: 'first_steps', points: 10, title: 'Claim a daily cache', hint: 'Claim the daily cache once.' },
    { key: 'building_upgraded', category: 'first_steps', points: 10, title: 'Upgrade any building', hint: 'Finish one upgrade job.' },
    // --- Progression -----------------------------------------------------------
    { key: 'keep_l3', category: 'progression', points: 15, title: 'Keep level 3', hint: 'Upgrade your Keep to level 3.' },
    { key: 'keep_l5', category: 'progression', points: 25, title: 'Keep level 5', hint: 'Upgrade your Keep to level 5.' },
    { key: 'keep_l8', category: 'progression', points: 40, title: 'Keep level 8', hint: 'Upgrade your Keep to level 8.' },
    { key: 'keep_l10', category: 'progression', points: 60, title: 'Keep level 10', hint: 'Upgrade your Keep to level 10.' },
    // Added 2026-09-04 (D-103): the playtest measures Keep depth; late tiers stay rare.
    { key: 'keep_l15', category: 'progression', points: 80, title: 'Keep level 15', hint: 'Upgrade your Keep to level 15.' },
    { key: 'keep_l20', category: 'progression', points: 120, title: 'Keep level 20', hint: 'Max out your Keep.' },
    { key: 'quests_10', category: 'progression', points: 20, title: 'Claim 10 quests', hint: 'Claim ten daily/weekly quest rewards.' },
    { key: 'quests_50', category: 'progression', points: 50, title: 'Claim 50 quests', hint: 'Claim fifty quest rewards.' },
    // --- Army & heroes ---------------------------------------------------------
    { key: 'troops_trained', category: 'army', points: 10, title: 'Train troops', hint: 'Queue any training batch.' },
    { key: 'troops_trained_10', category: 'army', points: 20, title: 'Train 10 batches', hint: 'Ten training batches paid.' },
    { key: 'hero_recruited', category: 'army', points: 15, title: 'Recruit a hero', hint: 'Place a hero altar / stool.' },
    { key: 'gear_equipped', category: 'army', points: 15, title: 'Equip hero gear', hint: 'Equip any item on a hero.' },
    { key: 'item_used', category: 'army', points: 10, title: 'Use a consumable', hint: 'USE any consumable item.' },
    { key: 'elite_unlocked', category: 'army', points: 40, title: 'Unlock an elite troop', hint: 'Consume a training writ won from the Gold Forge.' },
    // --- Combat ----------------------------------------------------------------
    { key: 'raid_attack', category: 'combat', points: 25, title: 'Attack another player', hint: 'Resolve one PvP raid.' },
    { key: 'raid_star', category: 'combat', points: 15, title: 'Earn a star', hint: 'Win at least 1★ in a PvP raid.' },
    { key: 'raid_three_stars', category: 'combat', points: 40, title: 'Three-star a base', hint: 'A 3★ PvP victory.' },
    { key: 'raid_attack_10', category: 'combat', points: 30, title: '10 PvP raids', hint: 'Resolve ten PvP raids.' },
    { key: 'raid_attack_50', category: 'combat', points: 80, title: '50 PvP raids', hint: 'Resolve fifty PvP raids.' },
    { key: 'defense_held', category: 'combat', points: 25, title: 'Hold a defense', hint: 'An attacker leaves your base with 0★.' },
    { key: 'campaign_stage', category: 'combat', points: 15, title: 'Clear a campaign stage', hint: 'Win any campaign stage.' },
    { key: 'campaign_stage_10', category: 'combat', points: 30, title: 'Campaign stage 10', hint: 'Clear stage 10.' },
    { key: 'campaign_stage_25', category: 'combat', points: 60, title: 'Campaign stage 25', hint: 'Clear stage 25.' },
    // --- Economy ---------------------------------------------------------------
    { key: 'forge_deployed', category: 'economy', points: 20, title: 'Deploy to the Gold Forge', hint: 'Deploy shards before UTC midnight.' },
    { key: 'forge_claimed', category: 'economy', points: 20, title: 'Claim a Forge payout', hint: 'Claim KEEP from a settled cycle.' },
    { key: 'forge_drop', category: 'economy', points: 30, title: 'Win a Forge drop', hint: 'Any relic/writ/gear drop lands.' },
    // Added 2026-09-04 (D-103): "built gold forge" is a headline playtest metric.
    { key: 'forge_built', category: 'economy', points: 20, title: 'Build the Gold Forge', hint: 'Place the Gold Forge on your land.' },
    { key: 'shop_bought', category: 'economy', points: 10, title: 'Buy from the shop', hint: 'Spend KEEP in the shop.' },
    { key: 'market_listed', category: 'economy', points: 25, title: 'List an item for SOL', hint: 'Create a market listing.' },
    { key: 'market_bought', category: 'economy', points: 30, title: 'Buy an item for SOL', hint: 'Complete a market purchase.' },
    // --- Land & money (web3) ---------------------------------------------------
    { key: 'land_bought', category: 'web3', points: 100, title: 'Buy land', hint: 'Pay the land price on devnet and receive your deed.' },
    { key: 'deed_minted', category: 'web3', points: 20, title: 'Deed minted', hint: 'Your Land Deed NFT exists on devnet.' },
    { key: 'second_base', category: 'web3', points: 80, title: 'Own a second base', hint: 'Buy a second deed.' },
    { key: 'deed_transferred', category: 'web3', points: 60, title: 'Transfer a deed', hint: 'Send a deed to another wallet; the base follows.' },
    { key: 'keep_deposited', category: 'web3', points: 60, title: 'Deposit KEEP', hint: 'A KEEP deposit credited.' },
    { key: 'withdrawal_requested', category: 'web3', points: 40, title: 'Request a withdrawal', hint: 'Start a KEEP withdrawal.' },
    { key: 'withdrawal_sent', category: 'web3', points: 120, title: 'Withdrawal paid on-chain', hint: 'A withdrawal reaches SENT.' },
    { key: 'twofa_enabled', category: 'web3', points: 30, title: 'Enable 2FA', hint: 'Authenticator or verified email.' },
    { key: 'seeker_linked', category: 'web3', points: 30, title: 'Link a Seeker', hint: 'Prove a Solana Mobile Seeker.' },
    // --- Social ----------------------------------------------------------------
    { key: 'chat_sent', category: 'social', points: 5, title: 'Say hello in chat', hint: 'Send one global chat message.' },
    { key: 'mail_claimed', category: 'social', points: 10, title: 'Claim a mail reward', hint: 'Open your mail and claim a reward.' },
    { key: 'referral_used', category: 'social', points: 15, title: 'Join with a friend\'s code', hint: 'Redeem a KEEP-xxxxx referral code.' },
    { key: 'friend_invited', category: 'social', points: 30, title: 'Invite a friend', hint: 'A friend joins with your code.' },
    { key: 'friend_qualified', category: 'social', points: 60, title: 'Your friend qualifies', hint: 'Your invitee buys land and reaches Keep 3.' },
  ],
} as const;

// ---------------------------------------------------------------------------
// Daily tester points (D-103, owner 2026-09-04: "points should be awarded for
// mining in golden forge, withdrawals, deposits, PvP, and we should award daily
// participation … not as one milestone"; "Make it small and competitive and
// logical. We need to test everything. Even in-game marketplace so
// participation in every part of game is important"; "Points should not be
// exploitable or can't be done more than once a day per thing"; "PvP points
// wins max 20 times a day"; referral daily points only for a QUALIFIED referee
// ("deed plus keep lvl 3") and only on days the referee acted; everything is
// "added up to current all time" points).
//
// Every source is DERIVED from authoritative ledgers/tables by the tester
// recompute (never client claims) and keyed (wallet, utc_day, key) in
// tester_daily_points, so a thing can pay at most once per UTC day; `cap` > 1
// sources store a count and pay count × points, never more than cap × points.
// Points are frozen at insert like tester_milestones; retuning changes only
// future days. Sizes are deliberately small: a fully engaged day pays well
// under one land purchase (land_bought 100) so the money/web3 milestones keep
// their weight (D-066) while daily play decides ties over a 14-day window.
// ---------------------------------------------------------------------------
export const TESTER_DAILY = {
  /** UTC days (including today) the recompute re-derives on every pass, so
   *  lazily-completed builds and late settlements still land on their day. */
  lookbackDays: 3,
  /** "Played today" (owner: "Action, any"): the UTC day has at least one row
   *  in any of these ledgers/tables for the wallet (or one of its bases).
   *  Login alone is NOT an action. The API's actionDay module is the single
   *  implementation; this list documents the contract for docs and tests. */
  actionSignals: [
    'ledger:mine.collect', 'ledger:cache.claim', 'ledger:build.*', 'builder_jobs.started_at',
    'ledger:army.train', 'quest claims', 'raids.resolved (attacker)', 'ledger:forge.contribute',
    'ledger:forge.claim', 'ledger:item.buy', 'item_uses', 'item_listings (seller/buyer)',
    'deposits.credited', 'withdrawals.created', 'chat messages', 'mail claims',
    'tester_feedback.created_at',
  ],
  /** Consecutive action days pay a one-off bonus the day the streak reaches
   *  exactly N (keyed streak_N so it cannot repeat inside one run). */
  streaks: [
    { days: 3, key: 'streak_3', points: 5, title: '3-day streak', hint: 'Act in the game three days in a row.' },
    { days: 7, key: 'streak_7', points: 15, title: '7-day streak', hint: 'Seven days in a row.' },
    { days: 14, key: 'streak_14', points: 40, title: '14-day streak', hint: 'Every day of a founding fortnight.' },
  ],
  /** Per-day sources. `cap` = maximum count paid per UTC day (1 = once). */
  sources: [
    // --- Daily play -----------------------------------------------------------
    { key: 'played', category: 'daily', points: 2, cap: 1, title: 'Play today', hint: 'Any in-game action counts. Signing in alone does not.' },
    { key: 'mine_collected', category: 'daily', points: 2, cap: 1, title: 'Collect your Mines', hint: 'Collect Shards from any Mine.' },
    { key: 'cache_claimed', category: 'daily', points: 2, cap: 1, title: 'Claim the Daily Cache', hint: 'Claim the Daily Shard Cache.' },
    { key: 'build_started', category: 'daily', points: 3, cap: 1, title: 'Build or upgrade', hint: 'Start any construction or upgrade.' },
    { key: 'troops_trained', category: 'daily', points: 2, cap: 1, title: 'Train troops', hint: 'Queue training in a Barracks.' },
    { key: 'quest_claimed', category: 'daily', points: 2, cap: 1, title: 'Claim a quest', hint: 'Claim any daily or weekly quest.' },
    { key: 'pve_battle', category: 'daily', points: 2, cap: 1, title: 'Fight the campaign', hint: 'Resolve a campaign or camp raid.' },
    { key: 'pvp_win', category: 'daily', points: 2, cap: 20, title: 'Win a PvP raid', hint: 'Take at least one star from another player. Up to 20 wins a day.' },
    { key: 'defence_held', category: 'daily', points: 3, cap: 1, title: 'Hold a defence', hint: 'An attacker leaves your base with zero stars.' },
    { key: 'forge_deployed', category: 'daily', points: 3, cap: 1, title: 'Work the Gold Forge', hint: 'Deploy Shards into the Gold Forge.' },
    { key: 'forge_claimed', category: 'daily', points: 3, cap: 1, title: 'Claim Forge KEEP', hint: 'Claim a finished Forge day.' },
    { key: 'shop_bought', category: 'daily', points: 2, cap: 1, title: 'Shop with KEEP', hint: 'Buy any shop item.' },
    { key: 'market_listed', category: 'daily', points: 3, cap: 1, title: 'List on the market', hint: 'Create a SOL listing.' },
    { key: 'market_bought', category: 'daily', points: 3, cap: 1, title: 'Buy on the market', hint: 'Complete a SOL purchase.' },
    { key: 'item_used', category: 'daily', points: 2, cap: 1, title: 'Use an item', hint: 'Consume any inventory item.' },
    { key: 'sol_deposit', category: 'daily', points: 3, cap: 1, title: 'Spend SOL in-game', hint: 'Any SOL purchase credited (builder, mine, expansion, shield, energy…).' },
    { key: 'keep_deposit', category: 'daily', points: 3, cap: 1, title: 'Deposit KEEP', hint: 'A KEEP deposit credited.' },
    { key: 'withdrawal_sent', category: 'daily', points: 5, cap: 1, title: 'Withdraw KEEP', hint: 'A withdrawal paid on-chain.' },
    { key: 'chat_sent', category: 'daily', points: 1, cap: 1, title: 'Talk in chat', hint: 'Send a global chat message.' },
    { key: 'mail_claimed', category: 'daily', points: 1, cap: 1, title: 'Claim your mail', hint: 'Claim a reward from mail.' },
    { key: 'feedback_sent', category: 'daily', points: 0, cap: 1, title: 'Send feedback', hint: 'Feedback pays through its own rules (see FEEDBACK); this only marks the day.' },
    // --- Referrals --------------------------------------------------------------
    { key: 'referral_active', category: 'referral', points: 3, cap: 25, title: 'A friend played today', hint: 'Per qualified friend (owns land, Keep 3+) who acted today. Nothing on days they skip.' },
  ],
  /** Display order/labels for the two new categories on every surface. */
  categoryLabels: { daily: 'Daily play', referral: 'Referrals' },
} as const;

export type TesterDailyKey = (typeof TESTER_DAILY.sources)[number]['key'] | (typeof TESTER_DAILY.streaks)[number]['key'];

// ---------------------------------------------------------------------------
// Founding Kingdoms playtest campaign framing (D-103, owner 2026-09-04). Dates
// are NOT decided ("we don't have start date yet"): the window is optional env
// (CAMPAIGN_START_AT); without it every surface says the playtest is live and
// shows no day counter. Rewards are Genesis Land Deed whitelist spots, never
// SOL ("devnet sol does not have any monetary value … no budget").
// ---------------------------------------------------------------------------
export const PLAYTEST_CAMPAIGN = {
  name: 'Founding Kingdoms',
  totalDays: 14,
  /** Public reward sentence (site, in-game, docs). Keep it factual.
   *  Owner 2026-09-04: "not all testers get WL … WL will be acquired only by
   *  ones who acquired and minted land deed. if many people will mint land
   *  deed top 300 players will get by points WL". */
  // Owner D-118 (2026-09-07): first 50 immutable reservations plus independent campaign awards.
  rewardCopy: 'First 50 verified original deed minters receive guaranteed whitelist spots. Up to 250 additional qualifying deed holders earn spots by Founding campaign points during its 14 days.',
  /** The whitelist rule behind the sentence, for every surface that marks who
   *  qualifies: a minted Land Deed is the ticket; points only rank ties past
   *  the cap. */
  whitelist: { requiresLandDeed: true, spots: 300 },
  /** Community goal ladder shown as a progress rail. Owner 2026-09-04: "we
   *  should only include players who has onchain activity by minting land
   *  deed" — the rail counts MINTED LAND DEEDS (active paid bases of real
   *  players), not founded Keeps. Purely presentational; reaching a rung
   *  changes nothing server-side. Owner may retune before the window opens. */
  deedGoals: [50, 100, 200, 300],
} as const;

// ---------------------------------------------------------------------------
// Public playtest statistics (D-103). One worker computes a snapshot on a
// cadence; the uncredentialed endpoint only ever serves the latest snapshot.
// Every count is SQL over authoritative tables with the exclusion predicate
// below; nothing is client-reported. Cohort "solanaMobile" = Seeker-verified
// OR first sign-in from the Solana Mobile shell (players.first_client).
// ---------------------------------------------------------------------------
export const PLAYTEST_STATS = {
  /** D-118 / owner 2026-09-07: public snapshots update within one minute. */
  refreshEveryMs: 30_000,
  freshnessThresholdMs: 60_000,
  /** Exact return-day cohorts, not rolling activity windows. */
  retentionWindowsDays: [1, 7, 14],
  /** Snapshots are kept for the post-campaign report, trimmed beyond this. */
  retentionDays: 120,
  publicCacheSec: 0,
  /** Sessions/players counted as active when seen within these windows. */
  activeWindowsDays: [7, 30],
  /** Keep level histogram is reported for L1–L20 (STRUCTURES.keep levels). */
  keepLevels: 20,
  /** Excluded from every public number: internal wallets (ALPHA/ADMIN env),
   *  admin-hidden board wallets, and players with zero sessions (the K-048
   *  scripted cohort never signed in through the client). */
  excludeZeroSessionPlayers: true,
} as const;

// ---------------------------------------------------------------------------
// Public release feed (M47 §5, owner 2026-09-27: "publish a changelog and the
// Android APK automatically as part of the ordinary deployment"). The website's
// /changelog and /download Functions read two uncredentialed API routes; the
// release-notes lint (scripts/src/release-notes.ts), the recording CLI and the
// routes all take their limits from here so the three can never disagree.
// ---------------------------------------------------------------------------
export const RELEASE_FEED = {
  /** M47 §5: `GET /public/releases?limit=` defaults to 20 and accepts 1..50. */
  defaultLimit: 20,
  maxLimit: 50,
  /** M47 §5: both routes answer `Cache-Control: public, max-age=60`. */
  publicCacheSec: 60,
  /** Same per-IP budget as the other public board read (/playtest/stats). */
  rateLimitPerMinute: 60,
  /** Stable Android rows listed by `GET /public/android` (newest first). */
  androidHistoryMax: 50,
  /** M47 §5 fragment schema: title ≤ 80 chars, body ≤ 600 chars, 1–3 sentences. */
  titleMaxChars: 80,
  bodyMaxChars: 600,
  bodyMaxSentences: 3,
  /** One release row never carries more entries than a reader can scan. */
  maxEntriesPerRelease: 40,
} as const;

// ---------------------------------------------------------------------------
// Playtest onboarding (owner 2026-08-22: "make onboarding seamless" — no more
// "Closed Alpha" wording, auto devnet SOL, a KEEP welcome reward). Everything
// here is a DEVNET PLAYTEST convenience and must be removable before mainnet:
// the faucet refuses any cluster but devnet, the welcome KEEP is posted only on
// devnet, and both are switched by env flags documented in .env.example.
// ---------------------------------------------------------------------------
export const PLAYTEST = {
  /** KEEP attached to the welcome mail of every new base on devnet (owner
   *  2026-08-22: "every user should get 5000 KEEP tokens in reward on sign up
   *  for fast ramp ups and testing"). Claimed from MAIL; funded from the
   *  bounded emission pool like every system KEEP reward (D-062). */
  welcomeKeep: 5_000,
  /** D-152: when Gems ship the devnet welcome aid is granted as Gems, once per wallet
   * (`welcome-gems:<wallet>`), gated on the devnet cluster exactly like welcomeKeep.
   * Same amount by owner decision; not a mainnet economy feature. */
  welcomeGems: 5_000,
} as const;

export const DEVNET_FAUCET = {
  /** SOL per grant — enough for one Land Deed (ECONOMY.entryFeeSol) plus fees. */
  grantSol: 0.5,
  /** Lifetime SOL a wallet may receive from the in-game faucet — 1.5 → 3.0
   *  (D-098, owner 2026-09-02: a capped player was sent to faucet.solana.com,
   *  which wanted a mainnet balance; exposure is 6 grants per wallet against a
   *  33.5 SOL treasury with the floor and daily budget below unchanged). */
  lifetimeCapSol: 3.0,
  /** Only wallets below this balance are funded (the faucet tops up, never stacks). */
  minBalanceSol: 0.25,
  /** Minimum hours between two grants to the same wallet — 12 → 6 (D-098,
   *  owner 2026-09-02: a player who spends a grant the same day can be topped
   *  up again that day). */
  cooldownHours: 6,
  /** The faucet treasury never spends below this floor (keeps deed mints funded). */
  treasuryFloorSol: 2,
  /** Worker cadence and batch for pending grants. */
  pollMs: 5_000,
  maxGrantsPerSweep: 20,
  /** A request nobody paid within this window is failed as `stale` instead of
   * being paid later without a fresh balance check (worker downtime). */
  requestTtlMinutes: 30,
  /** Treasury-wide ceiling per UTC day across all wallets (referral trees can
   * mint many eligible wallets); beyond it rows fail `daily_budget`. */
  dailyBudgetSol: 25,
} as const;

/** D153.263/D153.275; F1/F3 and copy PROPOSED by Warden 25dcf35d.
 * No activation without the owner's mint/inventory manifest. The inventory ceilings
 * (treasuryFloorSkr/dailyBudgetSkr) are the owner's, N-045 (6 Oct 2026). */
export const SKR_FAUCET = {
  devnet: {
    grantSkr: 1_000,
    claimsPerWalletPerDay: 1,
    dayBoundary: 'utc_calendar',
    label: 'Devnet Test SKR — not official SKR',
    symbol: 'tSKR',
    refusedMints: [
      WALLET_HUB.tokens.find((token) => token.symbol === 'SKR')!.mint,
      'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
    ],
    // Owner decision N-045 (6 Oct 2026, 12:15 UTC): the faucet treasury never pays below 100,000 tSKR and pays at most
    // 50,000 tSKR per UTC day across all wallets (50 grants of grantSkr 1,000). Replaces the null PROPOSAL (K-night-02).
    treasuryFloorSkr: 100_000 as number | null,
    dailyBudgetSkr: 50_000 as number | null,
    pollMs: 5_000,
    maxGrantsPerSweep: 20,
    claimRateLimitPerMin: 6,
    // PROPOSAL for design review; not an accepted activation parameter.
    maxAttempts: 3,
    // Wallet safety bound from D-141; player alone pays it.
    maxWalletAddedPriorityFeeLamports: 10_000_000,
    referenceScanPageSize: 16,
    referenceScanCap: 256,
    // review 8938311c M1 author4 PROPOSAL: operational caps, not activation approval.
    reconcileSweepRpcBudget: 24,
    reconcileAttemptRpcBudget: 12,
    reconcileSweepMs: 5_000,
    reconcileBackoffMs: 30_000,
    reconcileBackoffMaxMs: 900_000,
    reconcileLeaseMs: 120_000,
    reconcileParkAfter: 3,
    // PROPOSED confirmed-block margin for signing and one broadcast.
    submitHeightMargin: 20,
    // K-night-03 (2026-10-06): page size of the owned nonterminal grant read GET /devnet-skr-faucet/grants. The native
    // client reads this same value from the catalogue (SkrFaucetBounds.grantReadPageSize) and refuses a page with more
    // rows, or a nextCursor on a shorter page, so server and client must share this one number. 20 = the native fixtures.
    grantReadPageSize: 20,
  },
  'mainnet-beta': null,
} as const;

export type TesterMilestoneKey = (typeof TESTER_PROGRAM.milestones)[number]['key'];
export type TesterMilestoneCategory = (typeof TESTER_PROGRAM.milestones)[number]['category'];

// ---------------------------------------------------------------------------
// M33 — Solana Mobile performance + push notifications (D-101, owner 2026-09-03)
// ---------------------------------------------------------------------------

/** Opt-in client performance diagnostics (Codex advice #3; owner 2026-09-03:
 *  "the game has become heavy and a bit of freezing"; D-101). The overlay and
 *  the telemetry summary never run without `?diag=1` or the Settings row. */
export const PERF_DIAG = {
  /** One bounded `perf_summary` telemetry event per window, nothing in between. */
  summaryWindowMs: 60_000,
  /** Ring buffer of frame deltas kept for the percentiles (10 s at 60 fps). */
  frameRingSize: 600,
  /** A frame slower than this counts as a stall (same floor as `longtask`). */
  stallFrameMs: 50,
  /** Hard cap on summaries per page session (the telemetry sink allows 30 req/min/IP). */
  maxSummariesPerSession: 30,
} as const;

/** Device art profile (P1a, D-101): a constrained device loads the eager
 *  historical atlases at @1x (64.5 MiB decoded) instead of @2x (141.7 MiB).
 *  The canvas is CSS-pixel sized, so @2x is always minified on a phone. */
export const DEVICE_ART = {
  /** `navigator.deviceMemory` at or below this many GiB ⇒ constrained. */
  constrainedDeviceMemoryGb: 4,
  /** `navigator.hardwareConcurrency` at or below this ⇒ constrained. */
  constrainedHardwareConcurrency: 4,
  /** Eager atlas scale on a constrained profile (`?art=2x` overrides). */
  constrainedEagerScale: 1,
} as const;

/** Asset-pack transfer discipline (P2 + core tier, D-101): the background
 *  download never shares the main thread with a battle, and React learns
 *  about progress at most once per second (was 250 ms → a 4 Hz re-render of
 *  the whole overlay). */
export const ASSET_PACK_TRANSFER = {
  /** Progress is published to the UI at most this often. */
  progressPublishMs: 1_000,
  /** Delay before the transfer resumes after a battle ends or the tab is visible again. */
  resumeDelayMs: 3_000,
  /** Ceiling on the core tier's compressed bytes; a scripts test enforces it. */
  coreTierMaxBytes: 96 * 1024 * 1024,
} as const;

/** Android Back policy for the installed Solana-Mobile TWA (D-102). */
export const MOBILE_BACK = {
  /** A second Back inside this window exits/minimizes from the base. */
  exitConfirmMs: 2_000,
} as const;

/** Web Push notifications (owner 2026-09-03: being attacked, Mine full,
 *  building finished, training finished, mail received; D-101). Worker sweep numbers. */
export const NOTIFICATIONS = {
  sweepEveryMs: 30_000,
  /** M34 rollout safety: one recovery tick classifies only this many legacy
   * Mine rows. The partial index empties permanently after the resumable pass. */
  mineBootstrapBatchSize: 32,
  /** Events older than this are never pushed (protects the first deploy from a history flood). */
  sweepLookbackMs: 6 * 3_600_000,
  /** Build/training completions for one wallet inside this window collapse into one push. */
  batchWindowMs: 120_000,
  /** Pushes per wallet per rolling hour; excess rows are recorded with outcome `capped`. */
  perWalletHourlyCap: 12,
  /** Duration of that rolling cap window (owner 2026-09-03, D-101). */
  hourlyWindowMs: 60 * 60 * 1000,
  /** Push-service TTL per kind (seconds). */
  ttlSec: { raided: 6 * 3600, mine_full: 6 * 3600, mail: 24 * 3600, build: 3600, training: 3600 },
  /** Urgency header per kind. */
  urgency: { raided: 'high', mine_full: 'normal', mail: 'normal', build: 'normal', training: 'normal' },
  /** Live subscriptions kept per wallet; the oldest is retired beyond this. */
  subscriptionMaxPerWallet: 5,
  /** Consecutive delivery failures before a subscription is disabled (404/410 disable at once). */
  disableAfterFailures: 5,
  /** Bound one push-service request so a dead endpoint cannot stall the isolated worker. */
  deliveryTimeoutMs: 5_000,
} as const;
export type NotificationKind = keyof typeof NOTIFICATIONS.ttlSec;

// ---------------------------------------------------------------------------
// Cross-table type guards (compile-time only)
// ---------------------------------------------------------------------------

// Every defense type has stats and leveled upgrade rows.
const _defenseCheck: Record<DefenseType, unknown> = DEFENSES;
void _defenseCheck;

/** Owner 2026-09-05 (D-109): wallet-private training plans; this input bound is
 * defensive only and never increases current Camp/Barracks capacity. */
export const TRAINING_PRESETS = { slots: 3, nameMaxLength: 32, maxCompositionUnits: 1000 } as const;
/** Owner 2026-09-06: one serial training lane per base, exact tenth-duration units. */
export const TRAINING_SCHEDULE = { version: 2, lanesPerBase: 1, maxConsentQueueRows: TRAINING_PRESETS.maxCompositionUnits } as const;

/** Owner 2026-09-05 (D-109): pending login is not a gameplay session. */
export const LOGIN_AUTH = { pendingTtlSec: 15 * 60 } as const;

/** Owner-approved open-playtest competition, 2026-09-07 (D-118).
 * Independent scoring windows never pause or import lifetime points. */
export const PLAYTEST_COMPETITIONS = {
  durationDays: 14,
  foundingId: 'founding-kingdoms',
  rewardedId: 'rewarded-playtest',
  // Owner 2026-09-08 (D-120): distinct public campaign names; stable IDs.
  names: { founding: 'Founding Kingdoms', rewarded: 'Crown Clash' },
  founderSpots: 50,
  rankedSpots: 250,
  participationBonus: { activeDays: 3, points: 25 },
  revengeWinsPerOpponentDay: 1,
  videoWeights: { feedback: 40, evidence: 30, clarity: 20, coverage: 10 },
  prizes: [
    { id: 'champion', title: 'Crown Champion', amountUsd: 100, category: 'gameplay', metric: 'score' },
    { id: 'challenger', title: 'Royal Challenger', amountUsd: 75, category: 'gameplay', metric: 'score' },
    { id: 'bronze', title: 'Bronze Banner', amountUsd: 50, category: 'gameplay', metric: 'score' },
    // Owner 2026-09-08: allocate the remaining $50 here to complete the $600 pool (D-118).
    { id: 'revenge', title: 'Grudge Settler', amountUsd: 100, category: 'gameplay', metric: 'revenge' },
    { id: 'daily', title: 'Daily Defender', amountUsd: 25, category: 'gameplay', metric: 'activeDays' },
    { id: 'explorer', title: 'Realm Explorer', amountUsd: 25, category: 'gameplay', metric: 'stages' },
    { id: 'bug-1', title: 'Bug Scout', amountUsd: 25, category: 'report', metric: 'judged' },
    { id: 'bug-2', title: 'Bug Scout', amountUsd: 25, category: 'report', metric: 'judged' },
    { id: 'bug-3', title: 'Bug Scout', amountUsd: 25, category: 'report', metric: 'judged' },
    { id: 'bug-4', title: 'Bug Scout', amountUsd: 25, category: 'report', metric: 'judged' },
    { id: 'bug-5', title: 'Bug Scout', amountUsd: 25, category: 'report', metric: 'judged' },
    { id: 'video', title: 'Unfiltered Field Report', amountUsd: 100, category: 'video', metric: 'judged' },
  ],
} as const;

/** Owner 2026-09-10, D-128: frozen fantasy deed supply and migration origin.
 * These are allocation facts, independent of artwork and simulation rules. */
export const FANTASY_WORLD = {
  columns: 720, rows: 360, totalTiles: 85_414, ordinaryTiles: 79_832,
  genesisTiles: 2_000, seekerTiles: 3_582,
  crownlandsCenter: { lon: 26, lat: 23 },
} as const;

/** D-128 approved base paintings: native 32px art spans the existing 30-tile
 * plot. The 48px outskirts blend is visual only, never collision geometry. */
export const BASE_GROUND_GEOMETRY = { tilePx: 32, plotTiles: 30, edgeBlendPx: 48 } as const;

/** Owner 2026-09-10: a single complete terrain painting spans BaseScene's
 * existing −34..64 tile world. These bounds never resize the buildable plot. */
export const BASE_GROUND_WORLD_GEOMETRY = {
  ...BASE_GROUND_GEOMETRY, worldOriginTiles: -34, worldTiles: 98,
} as const;

/** Owner 2026-09-12: realm ambience remains legible at phone fit zoom without
 * extra textures. Reduced-motion and hidden scenes do not advance it. */
export const BASE_GROUND_MOTION = {
  frameMs: 125, cellTiles: 5, maxVisiblePoints: 160,
  minAmbientScreenPx: 1.25, minStrokeScreenPx: 0.8, minDriftScreenPx: 6, maxFeatureScale: 1.75,
} as const;

/** Phase E locked policy catalogue, D-149/D-150 (owner 2026-09-20).
 * D-151 authorizes implementation, not activation. These are future policy
 * facts only: live ECONOMY, MINING and FORGE still govern current gameplay.
 * No proposed score weights, decay endpoint, resource rates, storage caps,
 * spot assignments or sales-day boundary is promoted to a runtime rule here.
 * Integer units make the read-only catalogue safe to serialize as JSON. */
/** D-152 (owner 2026-09-20): Gems are the in-game currency. KEEP → Gems 1:1 is the
 * only player source; Gems → SHARDS 1:1 replaces KEEP → SHARDS; KEEP paid for Gems
 * recycles to the emission reserve (never burned, never minted on demand); Gems are
 * never withdrawable, never listable and never convert back to KEEP.
 * Specification: docs/phase-e/GEMS-CURRENCY.md. Rates are LOCKED; the two bounds are
 * operational (whole KEEP only; the largest single sink today is 277,900). Nothing here
 * enables Gems at runtime: no GEMS_ENABLED flag or Gems ledger kind exists yet. */
export const GEMS = {
  gemsPerKeep: 1,
  shardsPerGem: 1,
  minConvertKeep: 1,
  maxConvertKeepPerTx: 1_000_000,
  purchaseBurnBps: 0,
  withdrawable: false,
  listable: false,
} as const;

/** PROPOSED (D-152 invariant G-6; not an owner lock): the per-pool participation floor
 * that keeps the KEEP → Gems → SHARDS → ingot → mining loop loss-making
 * (`minUnitsPerPool × shardsPerIngot > grossDailyCeilingKeep × shardsPerGem`). Kept
 * outside PHASE_E_POLICY so the catalogue never advertises it as locked. Once mining
 * settlement exists it must read this constant, never a model's parameter block. */
export const KEEP_MINING_FLOOR = { minUnitsPerPool: 2_000 } as const;

export const PHASE_E_POLICY = {
  // Locked: docs/phase-e/EFFICIENT-CLOSURE-PLAN.md row 5
  // (100 Solana / 100 Seeker / 500 Divine individual / 50 Divine clan), D-150.
  solanaIsland: { workshopLicences: 100 },
  basisPoints: 10_000,
  mining: {
    // Prior E1 funded ceiling retained by D-149; D-150 explicitly makes it gross.
    grossDailyCeilingKeep: 98_000,
    freePoolBps: 500, deedPoolBps: 9_500,
    freeCapacityUnitsPerWalletDay: 2,
    fixedWalletPayoutCapKeep: null,
    scoreGraceSec: 48 * 60 * 60,
    seekerBonusBps: 1_000, genesisBaseBonusBps: 2_000,
  },
  bases: {
    activePerWalletMax: 5, freePerWalletMax: 2,
    replacementFeeLamports: 100_000_000, navigationFeeLamports: 0,
    secondFreeBaseCostShards: 100_000,
  },
  forge: { shardsPerIngot: 10_000 },
  taxes: {
    // D-150: only new earnings; no developer share of resource or KEEP taxes.
    resources: { playerBps: 8_000, islandPoolBps: 2_000, devBps: 0 },
    minedKeep: { playerBps: 8_000, islandPoolBps: 1_000, recycleBps: 1_000, devBps: 0 },
    keepMarket: { sellerBps: 9_000, burnBps: 1_000 },
  },
  seekerIsland: {
    totalSpots: 100, kingSpots: 20, regularSpots: 80, realmCount: 8,
    regularRealmCountMin: 1, regularRealmCountMax: 4,
    paidContractsPerSpotDayMax: 10,
    operatingTermSec: 7 * 24 * 60 * 60, overlappingAuctionSec: 24 * 60 * 60,
    permitDurationSec: 7 * 24 * 60 * 60, permitPriceLamports: 10_000_000,
    // D-150: follows this sale's seller, never pooled across winning spots.
    contractSellerBps: 5_000, contractDevBps: 5_000,
  },
  currencies: {
    // D-152: four spendable currencies; SHARDS, the eight realm resources and Crystal
    // Fragments are resources, not currencies. Gems mirror the GEMS block above.
    spendable: ['SOL', 'SKR', 'KEEP', 'GEMS'],
    resources: { shards: true, realmResourceCount: 8, crystalFragments: true },
    gems: {
      gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem,
      purchaseBurnBps: GEMS.purchaseBurnBps,
      withdrawable: GEMS.withdrawable, listable: GEMS.listable,
    },
    // D-152: resource and in-game item markets settle in KEEP (90/10 real burn),
    // NFTs in SOL, island auctions in SKR; Gems price nothing on any market.
    markets: { resources: 'KEEP', items: 'KEEP', nft: 'SOL', auctions: 'SKR' },
    // D-152: no genesis program; custodial devnet KEEP becomes Gems at the cutover.
    legacyCustodialKeep: 'converts-to-gems-at-cutover',
  },
  // E1-ONCHAIN-DESIGN §7.1 / D153.207: original application obligation;
  // oracle budget is separate. Public fallback pays the entire fee to project.
  craft: { applicationFeeLamports: 50_000_000, operatorBps: 7_000, projectBps: 3_000 },
  claims: { applicationFeeLamports: 0 },
} as const;

/** D-153.17: initial explicit free-base expedition home policy, dark. A persisted
 * assignment authorizes this realm; renderer fallbacks never do. This is partial
 * home-only access, not foreign permits or all-essential-input recipe readiness. */
export const PHASE_E_STARTER_ACCESS = {
  policyVersion: 1,
  freeHomeRealm: 'crownlands',
} as const;

/** D-153.18: selected initial dark starter HOME preview tuning. No dispatch,
 * fleet, permit or island-term authority is supplied by this catalogue. Whole
 * outputs have exact D-150 tax; generic earning-source carry remains separate.
 * Accepted future trips must freeze contents, not re-read these mutable tables. */
export const PHASE_E_STARTER_ROUTES = {
  routeCatalogueVersion: 2,
  rewardTableVersion: 2,
  routes: {
    introduction: { durationSec: 5 * 60, grossRaw: 5 },
    coastal_survey: { durationSec: 30 * 60, grossRaw: 25 },
    long_survey: { durationSec: 2 * 60 * 60, grossRaw: 80 },
  },
  // D-153.26: explicit starter-only common access, for eligible free/deed bases.
  // No paid permit, material or unlock; one existing vehicle, no broader access.
  // Foreign common output is one fifth of the same-length HOME survey.
  // Immutable v1 policy: future tuning adds another policy; never rewrite v1.
  commonV1: {
    accessPolicyVersion: 1,
    durationSec: 30 * 60,
    grossRaw: 5,
    routes: {
      common_frostveil: 'frostveil',
      common_elderwood: 'elderwood',
      common_sunscar: 'sunscar',
      common_crownlands: 'crownlands',
      common_seeker_reach: 'seeker-reach',
      common_stormcairn: 'stormcairn',
      common_thornwake: 'thornwake',
      common_cinderfall: 'cinderfall',
    },
  },
} as const;

/**
 * Forge Ingot refining (E1-CONTRACTS §1.2 field names; E2-WORKSHOP-CONTRACT §0).
 * LOCKED: the recipe (`shardsPerIngot`, D-149 §5 — referenced from
 * PHASE_E_POLICY.forge, never duplicated) and `committedExposure` (D-149:
 * committed ingots are protected, increase-only, consumed at settlement). Every
 * other number is D-149 §10 delegated tuning, dark. D-153.13 selects the
 * Workshop-only capacity ladder and cap multipliers; other tuning stays
 * PROPOSED. The Phase E catalogue does not advertise them; routes read here.
 * Duration = ingots × refineSecPerIngot × (1 − refineSpeedupBpsPerLevel ×
 * (level − 1) / 10,000); batch = min(max, baseSize + level × perWorkshopLevel).
 */
export const FORGE_INGOT = {
  shardsPerIngot: PHASE_E_POLICY.forge.shardsPerIngot,
  /** PROPOSED 10 / 1 / 30 (E2-WORKSHOP-CONTRACT §0). */
  batch: { baseSize: 10, perWorkshopLevel: 1, max: 30 },
  /** PROPOSED: 360 s per ingot at Workshop L1. */
  refineSecPerIngot: 360,
  /** PROPOSED: −2 % per Workshop level above L1. */
  refineSpeedupBpsPerLevel: 200,
  /** D-153.13 Workshop v1: ≤ 3 × allowance capacity ingots started per UTC day. */
  refineDailyCapMultiplier: 3,
  /** D-153.13 Workshop v1: held + listed + reserved + in-progress ≤ 7 × allowance capacity. */
  holdingCapMultiplier: 7,
  /** LOCKED: native PHASE_E_DECISIONS@11504e2 §raw theft, each resource separately on Keep destruction. */
  rawStockTheftDivisor: 100,
  /** D153.20: freeze allocation/version with the raid; never reprice old loot. */
  rawStockTheftVersion: 1,
  /** LOCKED (D-149): protected, final commitment. */
  committedExposure: 'protected_final',
  /** Frozen into every refining job; a bump answers RECIPE_VERSION_STALE at start only. */
  recipeVersion: 1,
  /**
   * D-153.13 Workshop-only v1 before E4 (E2-WORKSHOP-CONTRACT §0):
   * all free bases share the wallet's free units; a deed base has
   * `deedMinUnits + floor((deedMaxUnits − deedMinUnits) × progressBps / 10,000)`.
   * This selects Workshop progression, not E4 mining/activity qualification.
   */
  capacity: {
    freeUnits: PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay,
    deedMinUnits: 4,
    deedMaxUnits: 24,
  },
} as const;

/** One owner-authored one-time Gems task (D-152 amendment, owner 2026-09-20:
 * "one time tasks … they won't be redoable and should be very limited").
 * Claimable once per wallet, journaled `grant:task:<taskId>:<wallet>`, minted
 * against the Gems reward budget (E2-GEMS-CONTRACT §1.3). */
export interface GemsTaskSpec {
  gems: number;
  oncePerWallet: true;
  active: boolean;
  title: string;
}

/** The task catalogue. ENTRIES ARE OWNER CONTENT — an agent never authors a
 * task here; the owner adds `{ gems, oncePerWallet: true, active, title }` rows
 * and `infra/ops/census-e3.sql` prints the exposure Σ gems × eligible wallets.
 * Empty at launch: no task exists until the owner writes one. */
export const GEMS_TASKS = {} as const satisfies Record<string, GemsTaskSpec>;

/** PROPOSED (E2-GEMS-CONTRACT §1.3; D-152 amendment "≤ 10 % of the previous
 * day's recycled KEEP"): the per-UTC-day cap on the journaled operator posting
 * emission_pool → gems_reward_budget, as a share of the previous day's recycled
 * mined KEEP. Every task/welcome/refund Gem is minted against this budget so no
 * Gem is ever unbacked (invariant G-3). */
export const GEMS_REWARD_BUDGET = { recycledLegShareBps: 1_000 } as const;


/** D153.22: minimal Seeker auction implementation policy. Public activation held.
 * The Rust program consumes generated constants from these values plus D150's
 * PHASE_E_POLICY.seekerIsland, never separately tuned numeric copies. */
export const PHASE_E_SEEKER_AUCTION = {
  // D153.24: maximum age of genuine prefetched finality at locked dispatch acceptance.
  observationMaxAgeMs: 10_000,
  openingBidSkr: 10,
  prizeBps: PHASE_E_POLICY.basisPoints,
  settlementGraceSec: 600,
  maxPolicyPermitTtlSec: 600,
  issuedPolicyPermitTtlSec: 540,
  permitReceiptRetentionSec: 7 * 24 * 60 * 60,
  regularRealmCount: 4,
} as const;

/** SA-0 / D-141: wallet-safety ceiling is locked, cluster-independent.
 * review 356db8d1: operational defaults below remain PROPOSED for review;
 * these never change the chain calendar or enable the runtime. */
export const PHASE_E_SEEKER_AUCTION_RUNTIME = {
  maxWalletAddedPriorityFeeLamports: 10_000_000,
  openAlarmLeadSec: 3_600,
  crankPollMs: 15_000,
  // Seeker auction crank: hold after ISSUER_REFUSED; review bc3f47ad-6972-466e-8f28-2b9b676616e2
  issuerRefusalBackoffMs: 60_000,
  settleBatchMax: 4,
  readRoundsBack: 4,
  snapshotReadAttempts: 3,
  readRateLimitPerMin: 120,
  // review d954db2f / 6c312736: wallet-wide refund discovery has its own budget.
  refundReadRateLimitPerMin: 6,
  writeRateLimitPerMin: 12,
  refundBidCandidateMax: 1_024,
  refundPageSize: 25,
  // K-026: same age-only terminal-history policy as the existing main queue.
  // Purge limits bound each Lua cleanup; active/waiting jobs are unaffected.
  completedJobAgeSec: 21_600,
  completedJobPurgeMax: 100,
  failedJobAgeSec: 86_400,
  failedJobPurgeMax: 25,
} as const;

/** Night 2026-10-06 devnet TEST deployment only (owner: "devnet auctions will be shorter";
 * overnight handoff section 6 Track 4 step 2). Read only by the `devnet-test` cargo feature of
 * shardkeep-economy (through scripts/src/generate-economy-constants.ts) and by the night tools in
 * programs/night-devnet/. Never by the accepted build, API defaults or clients. */
export const PHASE_E_DEVNET_TEST = {
  profile: 'night-devnet-test-2026-10-06',
  /** Replaces PHASE_E_POLICY.seekerIsland.overlappingAuctionSec in the devnet-test build only; the operating term stays 7 days.
   * Owner decision 2026-10-06 09:15 UTC ("lets make bidding for 2 hours"): 2 hours for today's demo, was 30 minutes.
   * Compiled into the devnet-test economy binary (constants_devnet_test.rs): takes effect only after a rebuild + upgrade. */
  overlappingAuctionSec: 2 * 60 * 60,
  /** The night init tool sets first_operating_start this far ahead of the chain clock: the auction length plus the
   * 15-minute window rehearsed for opening all 100 auctions (owner's original "about 45 minutes" = 30 + 15; with the
   * 2-hour auction of 2026-10-06 09:15 UTC it is 2 h 15 min, so the opening window stays 15 minutes). */
  firstOperatingStartLeadSec: 2 * 60 * 60 + 15 * 60,
  /** Test SKR (tSKR): the whole supply goes to the faucet reserve, then both mint authorities are revoked. */
  // leagueTestWeekSkr equals LEAGUE_SEASON_TEST_POT.potRaw (10,000 tSKR; potRaw is in 6-decimal base units), added tonight by another agent; the main loop must keep only one of the two.
  testSkr: { decimals: 6, supplySkr: 1_000_000_000, faucetGrantSkr: 1_000, testPlayerSkr: 1_000, leagueTestWeekSkr: 10_000 },
  /** KEEP-style test mint: same supply as the D153.331 genesis; decimals are TOKEN.decimals. */
  keepStyle: { supplyKeep: PHASE_E_KEEP_V4_GENESIS.reserve },
} as const;

/** D153.164: private Charter creation admission policy, activation held.
 * v1 is immutable for historical descriptors. This is not auction eligibility
 * or a signing capability; any future signer rechecks its own current policy. */
export const PHASE_E_CHARTER_ADMISSION = {
  currentPolicyVersion: 1,
  v1: { policyVersion: 1, issuedPermitTtlSec: 540, observationMaxAgeMs: 10_000 },
} as const;


/** D153.27: initial ordinary refining tuning, dark. v1 is an immutable historical
 * policy: future balancing adds a version instead of repricing accepted jobs.
 * Separate from Forge Ingot/SHARDS economics and mining allowance. */
export const PHASE_E_ORDINARY_CRAFTING = {
  currentRecipeVersion: 1,
  v1: {
    recipeVersion: 1, maxBatch: 10, maxConcurrentPerBase: 1,
    refining: { rawPerOutput: 10, outputPerBatch: 1, secondsPerOutput: 60 },
    navigationKit: { prismstoneLensPerOutput: 1, frostglassPerOutput: 1, outputPerBatch: 1, secondsPerOutput: 120 },
  },
} as const;

/** D153.28: initial wallet-wide Harvester tuning, dark. These v1 terms are
 * immutable for an accepted interval; future tuning requires another version.
 * No facility level, deed count or source replacement multiplies this budget. */
export const PHASE_E_HARVESTER = {
  currentPolicyVersion: 1,
  v1: {
    policyVersion: 1,
    producingSourcesPerWallet: 1,
    grossPerWalletUtcDay: 15,
    grossPerCadence: 1,
    cadenceSec: 5_760,
    maxLeaseSec: 24 * 60 * 60,
    // D-150 / D153.28: freeze the resource-tax lineage for already admitted v1
    // leases. Future current tax tuning must not reprice their earned units.
    taxPolicyVersion: 1,
    taxBasisPoints: 10_000,
    islandPoolBps: 2_000,
  },
} as const;

/** docs/REALM-KIT-PLAN.md E-9 (D-173, owner 2026-09-21): the groundRevision-5
 * realm-kit admission budget, one step above LAYERED_GROUND_LIMITS (r3/r4).
 * compressedBytes counts the manifest JSON as well as every sheet; manifestBytes
 * is the E-5 cap on the manifest JSON alone (the web loader refuses a larger
 * download, so the validator must refuse it first); cells is the
 * 32-px cell table of one 2048² POT tileset (64×64); layers caps the ordered
 * draw layers; paths caps render-only ambient routes and pathPoints their
 * polyline length; bakedTiles caps the non-empty cells of a manifest's three field
 * layers (a full 98² base plus ≤ 6,780 water/overlay cells — the validator refuses a
 * denser bake); floorTiles is the hard wall on tiles one floor plan may emit: water
 * and base over the whole edge-clamped extent (2 × (98 + 2·64)² = 102,152) plus the
 * field's water/overlay share of bakedTiles, which a claim can only lower. Native
 * mirrors read the catalogue values rather than restating them. */
export const LAYERED_GROUND_LIMITS_R5 = {
  compressedBytes: 4 * 1024 * 1024,
  /** ~1,700 placements at ~150 B each plus three RLE layers: 512 KiB keeps the
   * manifest one small download (web reads this cap) with room for the other realms. */
  manifestBytes: 512 * 1024, rgbaBytes: 16 * 1024 * 1024,
  residentRealms: 2,
  /** Sheets per realm. 24 held the tileset, the prop sheets, the eight obstacle twins, the
   * ambient sprites, far and overview (Crownlands: 19); the roaming creatures (D-173 creature
   * paths, owner 2026-09-21) add one four-facing walk sheet per species — eight in Crownlands —
   * because a path names its sheet and reads it row-major by facing. Native still flushes a
   * batch per texture switch, and a creature interleaving with trees switches anyway. */
  assets: 32, dimension: 2048,
  /** A realm's woods are individual 1×1-footprint trees with overlapping 2-tile
   * canopies (ART-NOTES: no canopy terrain), so the authored Crownlands field
   * carries ~1,700 props; both clients cull per frame and native enters them in
   * the sorted structure pass, which the r4 cap of 1,024 never sized for. */
  placements: 2048,
  cells: 4096, layers: 4,
  /** Render-only ambient routes: roaming animals ≈ 40 creatures (Crownlands authors 19 today:
   * 8 farm, 8 meadow, 3 ducks) plus the ambient bird and smoke routes, with room for a realm
   * that stocks its woods more densely. */
  paths: 96, pathPoints: 64, bakedTiles: 16384, floorTiles: 110000,
  /** Widest/tallest placement `footprint` a manifest may declare (the largest kit
   * prop, Crownlands' `waterfall_cliff`, is 5×4; KIT_OBSTACLES only ever maps 1×1 and 2×2). */
  footprintTiles: 8,
  /** REALM-KIT-PLAN §2 ring variants (D-173; K-177 "road end"): rows of
   * `ground.state.edge.variants`. The builder bakes, for every in-frame base cell whose
   * terrain is not the boundary wild ground and that a reachable claim ring can cross,
   * one ring cell per reachable corner-Wang mask (kingdom corners turf, the other
   * corners the cell's own terrains, three-way composited) — reachable = the one-tile
   * rings of the 13 CAPS.claimTilesByExpansion rects, masks from realmKitEdgeMask — so
   * the kingdom road meets the land through turf-road instead of stopping in the meadow.
   * One row per base cell, 16 masks each, 0 = the default turf↔wild ring cell. Rows are keyed
   * by baked cell, not by ring tile: Crownlands' straight width-2 road crosses only the
   * south rings (mask 12) and bakes 4 rows — its two hashed pure-road cells and the two
   * road-edge Wang cells — however many rings cross it (scripts/src/realm-kit.test.ts pins
   * the count against the committed build). 512 leaves room for a realm whose yards and
   * tracks meet the rings from every side; a realm in the tens of rows is already unusual,
   * and more is a layout mistake, not content. */
  edgeVariants: 512,
} as const;

/** docs/REALM-KIT-PLAN.md §1, §3, §5 and E-6/E-8 (D-173, owner 2026-09-21): the
 * realm-kit geometry in tiles. The field is BaseScene's −34..64 world (98×98 = the
 * manifest `field` at 32 px); the protected frame is PLOT_GEOMETRY v2's [-10,40)
 * 50×50 clearing, where baked GROUND stays meadow-level (no water, no forest floor)
 * while trees and rocks may stand anywhere (owner 2026-09-21: "trees can grow
 * anywhere inside and outside base") — a prop whose seat lies inside the claim
 * plus its edge ring is hidden, so buying land clears it; the edge ring is the one
 * corner-Wang transition tile outside the claim; below overviewMaxZoom native may draw
 * the published overview still instead of tiles, but only where one still texel is at
 * most 2 physical px (owner 2026-09-25, D-173; on a phone every scene draws tiles);
 * the innermost exterior rings are
 * wild meadow so the ring never meets water. None of this grants land or moves a
 * coordinate. */
export const REALM_KIT = {
  tilePixels: 32, fieldOriginTiles: -34, fieldTiles: 98, frameMinTile: -10, frameMaxTile: 40,
  edgeRingTiles: 1, overviewMaxZoom: 0.35, meadowRingsOutsideFrame: 2,
  /** Owner 2026-09-21: "at the end of theme waters are cut off, we need to fill that till the
   * end". A wide desktop view at the zoom floor reaches past the 98-tile field, where only
   * the far repeat drew and every river stopped dead. Tiles within this many tiles beyond the
   * field take the nearest field tile's water/base cell (edge clamp), so a river leaving the
   * field runs on to the world's end; the overlay stays empty there. 64 covers a 3440-px
   * ultrawide at a 0.30 zoom floor (179 tiles) with the field's 98. */
  edgeExtendTiles: 64,
  /** D-173 creature paths (2026-09-21): every placement or path layer below this is ONE painter's band —
   * bottom-seated props and roaming creatures drawn by their anchor row, so a deer south of a tree's seat
   * walks in front of it, a hen north of a hay bale behind it — while this layer and above (birds, smoke)
   * stack over the band by layer. A placement's 0/1 stays the E-11 low/tall semantic, not a draw band. */
  airLayer: 2,
} as const;

/** Phase E / D-153.55 delegated second-free-base development gate, dark.
 * The 100,000-SHARDS cost and two-free/five-active limits remain in the locked
 * PHASE_E_POLICY. Completed facilities qualify; pending upgrades do not. */
export const PHASE_E_FREE_BASE_POLICY = {
  version: 1,
  minKeepLevel: 5,
  minWorkshopLevel: 1,
  minGoldForgeLevel: 1,
} as const;

// Phase E wallet experience — D-153.56 (revisable tuning, not an earning entitlement).
export const PHASE_E_MINING_EXPERIENCE_POLICY = {
  version: 1,
  minPveStars: 1,
  xpPerQualifiedRaid: 100,
  maxRewardedRaidsPerDay: 3,
  raidsForFullActivity: 3,
  xpForFullScore: 4_200,
  scoreScale: 10_000,
} as const;

// Phase E mining score — D-153.58, delegated first-free pacing. No funding authority.
export const PHASE_E_MINING_SCORE_POLICY = {
  version: 1,
  activityWeight: 2,
  experienceWeight: 1,
  usefulChainWeight: 1,
  baseFloorBps: 2_500,
  baseProgressBps: 7_500,
  developmentWeights: { keep: 1, workshop: 1, goldforge: 1 },
  requiredLevel: { keep: 3, workshop: 1, goldforge: 1 },
  fullLevel: { keep: 20, workshop: 20, goldforge: 20 },
  decayZeroAfterSec: 7 * 24 * 60 * 60,
} as const;


// Phase E mining publication — D-153.62 delegated audit/timing and integer split.
// Persist the split position across epochs; full cycles implement D-150 exactly.
export const PHASE_E_MINING_PUBLICATION = {
  version: 1,
  daySec: 24 * 60 * 60,
  claimDelaySec: 2 * 60 * 60,
  publisherMaxGapDays: 2,
  splitPeriod: 10,
  splitPlayerUnits: 8,
  splitRecycleUnits: 1,
  splitTaxUnits: 1,
} as const;

// Phase E mining claim quote; D-153.69. Entitlement never expires; only the
// unsigned preparation's signing window is bounded, independently of blockheight.
export const PHASE_E_MINING_CLAIM_QUOTE = { version: 1, ttlSec: 120 } as const;

// Phase E Gems mining contribution — delegated v1 selection of the PROPOSED
// GEMS-CURRENCY §0-8 values (D-153.85). All Phase E activation remains held.
// This bounds only Gems' part of the useful-chain component, not KEEP payouts.
export const PHASE_E_GEMS_MINING_CREDIT = {
  version: 1,
  minConvertedGemsSpent: 100,
  maxCreditsPerWalletDay: 1,
  usefulComponentBps: 1_000, // Setting zero disables this contribution.
} as const;

// ── Phase E atomic Seeker sales — D153.88 (PROPOSED, revisable) ──
// A buyer signs a short-lived atomic sale; this is separate from auction policy permits.
export const PHASE_E_SEEKER_SALE = { version: 1, quoteTtlSec: 600 } as const;

// ── Phase E paid starter access — D-153.93 (PROPOSED, revisable) ──
// Explicit paid destinations use the existing HOME coastal survey economics.
// This append-only policy leaves HOME/common catalogue v2 and its previews intact.
export const PHASE_E_PAID_STARTER_ROUTES = {
  routeCatalogueVersion: 3,
  rewardTableVersion: PHASE_E_STARTER_ROUTES.rewardTableVersion,
  accessPolicyVersion: 1,
  durationSec: PHASE_E_STARTER_ROUTES.routes.coastal_survey.durationSec,
  grossRaw: PHASE_E_STARTER_ROUTES.routes.coastal_survey.grossRaw,
  routes: {
    paid_frostveil: 'frostveil',
    paid_elderwood: 'elderwood',
    paid_sunscar: 'sunscar',
    paid_crownlands: 'crownlands',
    paid_seeker_reach: 'seeker-reach',
    paid_stormcairn: 'stormcairn',
    paid_thornwake: 'thornwake',
    paid_cinderfall: 'cinderfall',
  },
} as const;

// ── Phase E historical expedition term v1 — D-153.111 ──
// Frozen wire-format dimensions from D-150; future Seeker tuning must version
// its term format rather than invalidating an original earning's saved evidence.
export const PHASE_E_EXPEDITION_TERM_V1 = Object.freeze({
  totalSpots: 100,
  operatingTermSec: 7 * 24 * 60 * 60,
} as const);

// ── Phase E advanced vehicle identity — D-153.123 ──
// Owner locks: native PHASE_E_DECISIONS.md@11504e2, vehicle lifecycle.
// These are identity/lifecycle bounds, not placement, dispatch or mint authority.
// The five-installation maximum includes the separate non-NFT starter family.
export const PHASE_E_VEHICLES = {
  advancedFamilyCount: 4,
  tiers: [1, 2, 3, 4],
  installationsPerFamilyPerBase: 1,
  installationsPerBaseMax: 5,
  completedUsesPerInstall: 100,
} as const;

// ── Phase E advanced expeditions — D-153.133, delegated v1 tuning ──
// Revisable choices, not individually owner-approved numbers. Future tuning
// adds a version; accepted v1 snapshots retain these profiles and provisions.
// One advanced flight/base runs alongside the independent free starter. No
// permit, mint, installation, term or dispatch authority follows from this table.
export const PHASE_E_ADVANCED_EXPEDITIONS = {
  currentPolicyVersion: 1,
  v1: {
    policyVersion: 1,
    maxConcurrentPerBase: 1,
    // Frozen D-150 split dimensions, not a new tax choice.
    basisPoints: 10_000,
    islandPoolBps: 2_000,
    // Frozen original D-153.18 starter alternatives; future starter tables
    // must not reprice already accepted advanced v1 trips.
    balloonAlternateHome: {
      introduction: { durationSec: 5 * 60, grossRaw: 5 },
      long_survey: { durationSec: 2 * 60 * 60, grossRaw: 80 },
    },
    families: {
      survey_balloon: {
        homeRoutes: ['introduction', 'coastal_survey', 'long_survey'],
        durationSecByTier: [30 * 60, 30 * 60, 30 * 60, 30 * 60],
        grossRawByTier: [30, 35, 40, 45],
        supplies: [{ resourceId: 'rough_prism', quantity: 1 }],
      },
      cargo_cutter: {
        homeRoutes: ['coastal_survey'],
        durationSecByTier: [30 * 60, 30 * 60, 30 * 60, 30 * 60],
        grossRawByTier: [40, 45, 50, 55],
        supplies: [{ resourceId: 'heartwood_logs', quantity: 2 }],
      },
      courier_airship: {
        homeRoutes: ['coastal_survey'],
        durationSecByTier: [20 * 60, 16 * 60, 12 * 60, 10 * 60],
        grossRawByTier: [20, 20, 20, 20],
        supplies: [{ resourceId: 'ember_nodules', quantity: 1 }],
      },
      expedition_barge: {
        homeRoutes: ['long_survey'],
        durationSecByTier: [120 * 60, 120 * 60, 120 * 60, 120 * 60],
        grossRawByTier: [120, 135, 150, 165],
        supplies: [{ resourceId: 'heartwood_logs', quantity: 2 }, { resourceId: 'crown_iron_ore', quantity: 1 }],
      },
    },
  },
} as const;

/** D153.166: fixture-verified Charter v0 profile; no configured live issuer.
 * Core fee: pinned upstream e72d63e4118a0a95ac9b40221e81b19d49e1e102
 * programs/mpl-core/src/state/collect.rs. Compute limit matches accepted B6g. */
export const PHASE_E_CHARTER_PREPARATION = {
  version: 1, computeUnitLimit: 400_000, coreCreateFeeLamports: 1_500_000,
  timeoutMs: 60_000, maxPending: 8,
} as const;

/** D-153.174 delegated ordinary paid/free mining qualification (B3 completion).
 * E1-NUMERICAL-SPEC §8 proposed one Renown per finalized participation day;
 * selected here only for a positive funded, source-qualified wallet award.
 * Claim timing, number of active bases and retries never multiply this award.
 * Existing D149/D150 prices, pool splits and score constants are unchanged. */
export const PHASE_E_MINING_PARTICIPATION = {
  version: 1,
  renownPerQualifiedDay: 1,
  daysPerQualifiedDay: 1,
} as const;

/** D153.175 / E1-ONCHAIN-DESIGN §6: locked5% creator royalty included in
 * controlled Charter SOL sales, with no additional sale fee. Treasury is an
 * immutable deployment-config address, never a game number or live pin here. */
export const PHASE_E_CHARTER_TRANSFER = { royaltyBps: 500 } as const;

/** D153.181 owner-approved funded weekly Charter tournament. Refined prizes
 * redistribute existing stock; fragment issuance stays held. UTC week starts
 * Saturday, play Sunday, passive occupation the following Monday to Monday. */
export const PHASE_E_CHARTER_TOURNAMENT = {
  version: 1,
  entryWeekdayUtc: 6,
  entryDurationDays: 1,
  playDurationDays: 1,
  occupationDurationDays: 7,
  raidsPerWallet: 3,
  maxPendingRequestsPerWallet: 1,
  // Operational abuse bound includes cancelled identities; replies reuse keys.
  maxRequestIdentitiesPerWallet: 16,
  divineSites: 50,
  maxStarsPerRaid: 3,
  maxDestructionPerRaid: 100,
  maxReplayInputBytes: 16 * 1024 * 1024,
} as const;

/** D153.182 delegated operational bounds for original legacy vehicle consent.
 * These cap transport, discovery and local retention; they add no game charge,
 * priority fee, mint, cancellation or replacement authority. */
export const PHASE_E_VEHICLE_CLIENT = {
  version: 1, reviewMaxAgeMs: 30_000, rpcTimeoutMs: 10_000, maxPendingRpc: 8,
  maxNetworkFeeLamports: 100_000, discoveryPageSize: 20,
  localPendingLimit: 128, localArchiveLimit: 128,
} as const;

/** D153.183 delegated catalogue tuning: art identities do not grant realm rights.
 * Immutable v2 scales v1 default profiles; required vehicle tier equals grade.
 * D8 crops refer to the pinned existing detail atlas, not new packaged assets. */
export const PHASE_E_ORDINARY_ROUTES = {
  policyVersion: 2,
  gradeFactors: { 1: 1, 2: 2, 3: 4, 4: 8 },
  art: { columns: 3, cell: 320, atlas: 1024 },
  routes: {
    'glasswake-1': { chain: 'glasswake', index: 0, realmId: 'seeker-reach', grade: 1 },
    'glasswake-2': { chain: 'glasswake', index: 1, realmId: 'seeker-reach', grade: 2 },
    'glasswake-3': { chain: 'glasswake', index: 2, realmId: 'seeker-reach', grade: 3 },
    'glasswake-4': { chain: 'glasswake', index: 3, realmId: 'seeker-reach', grade: 4 },
    'aurora-1': { chain: 'aurora', index: 0, realmId: 'frostveil', grade: 1 },
    'aurora-2': { chain: 'aurora', index: 1, realmId: 'frostveil', grade: 2 },
    'aurora-3': { chain: 'aurora', index: 2, realmId: 'frostveil', grade: 3 },
    'aurora-4': { chain: 'aurora', index: 3, realmId: 'frostveil', grade: 4 },
    'emberwake-1': { chain: 'emberwake', index: 0, realmId: 'cinderfall', grade: 1 },
    'emberwake-2': { chain: 'emberwake', index: 1, realmId: 'cinderfall', grade: 2 },
    'emberwake-3': { chain: 'emberwake', index: 2, realmId: 'cinderfall', grade: 3 },
    'emberwake-4': { chain: 'emberwake', index: 3, realmId: 'cinderfall', grade: 4 },
    'whispering-1': { chain: 'whispering', index: 0, realmId: 'elderwood', grade: 1 },
    'whispering-2': { chain: 'whispering', index: 1, realmId: 'elderwood', grade: 2 },
    'whispering-3': { chain: 'whispering', index: 2, realmId: 'elderwood', grade: 3 },
    'whispering-4': { chain: 'whispering', index: 3, realmId: 'elderwood', grade: 4 },
    'mintwake-1': { chain: 'mintwake', index: 0, realmId: 'crownlands', grade: 1 },
    'mintwake-2': { chain: 'mintwake', index: 1, realmId: 'crownlands', grade: 2 },
    'mintwake-3': { chain: 'mintwake', index: 2, realmId: 'crownlands', grade: 3 },
    'mintwake-4': { chain: 'mintwake', index: 3, realmId: 'crownlands', grade: 4 },
    'prismforge-1': { chain: 'prismforge', index: 0, realmId: 'sunscar', grade: 1 },
    'prismforge-2': { chain: 'prismforge', index: 1, realmId: 'sunscar', grade: 2 },
    'prismforge-3': { chain: 'prismforge', index: 2, realmId: 'sunscar', grade: 3 },
    'prismforge-4': { chain: 'prismforge', index: 3, realmId: 'sunscar', grade: 4 },
    'lumenreef-1': { chain: 'lumenreef', index: 0, realmId: 'thornwake', grade: 1 },
    'lumenreef-2': { chain: 'lumenreef', index: 1, realmId: 'thornwake', grade: 2 },
    'lumenreef-3': { chain: 'lumenreef', index: 2, realmId: 'thornwake', grade: 3 },
    'lumenreef-4': { chain: 'lumenreef', index: 3, realmId: 'thornwake', grade: 4 },
    'aurora-5': { chain: 'aurora', index: 4, realmId: 'stormcairn', grade: 1 },
    'emberwake-5': { chain: 'emberwake', index: 4, realmId: 'stormcairn', grade: 2 },
    'emberwake-6': { chain: 'emberwake', index: 5, realmId: 'stormcairn', grade: 3 },
    'whispering-5': { chain: 'whispering', index: 4, realmId: 'stormcairn', grade: 4 },
  },
} as const;

/** D153.184 delegated v1 Divine individual planning challenge. Existing stage5,
 * SIM17 and K1's20 army points; no ordinary army/energy/reward mutation. Every
 * entrant gets the same public seed/roster. Bounds are operational, not fees. */
export const PHASE_E_DIVINE_TRIALS = {
  version: 1, entryWeekdayUtc: 6, entryDurationDays: 1, playDurationDays: 1,
  occupationDurationDays: 7, divineSites: 500, attemptsPerWallet: 3,
  maxUnfinishedAttempts: 1, minRenown: 1, minDaysAttested: 1,
  minWinningStars: 1, maxStars: 3, maxDestruction: 100,
  campaignStage: 5, simVersion: 17, seed: 184,
  army: { highlander: 6, bowman: 8 }, levels: { highlander: 1, bowman: 1 },
  maxDeploys: 14, deployTimeMs: 0,
  observationMaxAgeMs: 30_000, rpcTimeoutMs: 30_000, maxSourceConcurrency: 32,
  discoveryPageSize: 20, localEventLimit: 32,
  maxSnapshotBuildings: 128, maxStringLength: 256, maxObjectKeys: 64,
  maxJsonDepth: 16, maxJsonNodes: 1_000_000, maxPayloadBytes: 16 * 1024 * 1024,
  maxReplayEvents: RAID_REPLAY_LIMITS.maxEvents,
} as const;

// ── BEGIN PROPOSED PHASE_E_FRAGMENT_MODEL — D153.187 ──
/** D153.187 PROPOSED numerical sensitivity inputs, not live issuance or recipe
 * acceptance. D149/D150/D152 constrain economics; native decisions@11504e2:374–381
 * require one budget and personally earned precommitted salvage. Locked maxima,
 * taxes and application fees are references, never new policy copies. */
export const PHASE_E_FRAGMENT_MODEL = {
  version: 1,
  weeklyCeiling: 10_000n, periodDays: 7n,
  weeklyCeilings: [1_000n, 10_000n, 100_000n],
  allocations: [[7_000n, 2_000n, 1_000n], [6_000n, 2_500n, 1_500n], [5_000n, 3_000n, 2_000n]],
  individualSites: PHASE_E_DIVINE_TRIALS.divineSites,
  clanSites: PHASE_E_CHARTER_TOURNAMENT.divineSites,
  seekerSites: PHASE_E_POLICY.seekerIsland.totalSpots,
  opportunitiesPerWalletDay: 1n, admissionDays: 7n,
  marketCreatesEligibility: false,
  salvageMax: 1n, salvageBps: 2_500n,
  recipeInputs: [2n, 6n, 18n, 54n],
  recipeSuccessBps: [8_000n, 6_500n, 4_500n, 2_500n],
  populationScenarios: [0n, 10n, 500n, 5_000n],
} as const;
// ── END PROPOSED PHASE_E_FRAGMENT_MODEL — D153.187 ──

// ── Phase E ordinary equipment · D153.188 delegated v1 tuning ──
// Native PHASE_E_ITEMS@11504e2: durable ordinary Workshop tool; shorter trip,
// smaller cargo, no mining/score/uses/access benefit. Two refined metals/optics
// each and five minutes provide an attainable non-currency durable recipe.
export const PHASE_E_ORDINARY_EQUIPMENT = {
  recipeVersion: 1, maxBatch: 1, policyVersion: 1,
  recipe: { prismstoneLens: 2, crownsteel: 2, durationSec: 300, outputQuantity: 1 },
  durationNumerator: 4, durationDenominator: 5, cargoNumerator: 3, cargoDenominator: 4,
} as const;

/** D153.189 delegated Survey Lens: one ordinary fitting changes the common
 * material mix within the original budget. No added yield, speed or scoring. */
export const PHASE_E_SURVEY_LENS = {
  catalogueVersion: 2, recipeVersion: 1, maxBatch: 1, policyVersion: 1,
  recipe: { prismstoneLens: 2, frostglass: 2, durationSec: 300, outputQuantity: 1 },
  secondaryNumerator: 1, secondaryDenominator: 5,
} as const;

// ── Phase E KEEP equipment market · D153.190 delegated v1 minimum ──
// E1-ONCHAIN-DESIGN §8 proposed0.001KEEP minimum adopted for the initial ordinary
// Compass/Lens market. Locked90/10 remains PHASE_E_POLICY.tax.keepMarket;
// TOKEN.decimals remains the mint scale. Payment foundation alone is not a market.
export const PHASE_E_KEEP_EQUIPMENT_MARKET = {
  policyVersion: 1, minFillBaseUnits: 1_000_000n,
} as const;

// D153.190 bounded market discovery. Pagination is transport policy; no limit
// on ownership, listings or earned equipment follows from one response page.
export const PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT = {pageSize:20,reviewMaxAgeMs:30_000,rpcTimeoutMs:10_000,maxPendingRpc:8,localPendingLimit:32,localArchiveLimit:128} as const;

/** D153.192 accepts only D187's first weekly partition for the prospective
 * individual issuer. Clan/salvage allocations stay unissued; no recipe or art
 * admission follows. Taxes reference locked D150. Discovery bounds reuse D184. */
export const PHASE_E_DIVINE_FRAGMENTS = {
  version: 1, resourceId: 'crystal_fragment', economicLineage: 'shardkeep',
  weeklyGross: PHASE_E_FRAGMENT_MODEL.weeklyCeiling,
  periodDays: Number(PHASE_E_FRAGMENT_MODEL.periodDays),
  individualBps: PHASE_E_FRAGMENT_MODEL.allocations[0][0],
  clanBps: PHASE_E_FRAGMENT_MODEL.allocations[0][1],
  salvageBps: PHASE_E_FRAGMENT_MODEL.allocations[0][2],
  individualSites: PHASE_E_DIVINE_TRIALS.divineSites,
  // D153.193: the existing clan partition is shared by the original D181 sites/rosters.
  clanSites: PHASE_E_CHARTER_TOURNAMENT.divineSites,
  clanRosterCap: CLANS.rosterCap,
  basisPoints: PHASE_E_POLICY.basisPoints,
  playerBps: PHASE_E_POLICY.taxes.resources.playerBps,
  seekerBps: PHASE_E_POLICY.taxes.resources.islandPoolBps,
  developerBps: PHASE_E_POLICY.taxes.resources.devBps,
  pageSize: PHASE_E_DIVINE_TRIALS.discoveryPageSize,
  localPendingLimit: PHASE_E_DIVINE_TRIALS.localEventLimit,
} as const;

// ── Phase E mining contribution v2 · D153.199 owner caps / delegated tuning ──
// Version1 policies above are immutable replay inputs. These are mining weights,
// not market prices. Refining preserves value; currencies and equipment do not count.
export const PHASE_E_MINING_CONTRIBUTION_V2 = {
  version: 2,
  valuePerIngot: PHASE_E_POLICY.forge.shardsPerIngot,
  freeValuePerWalletDay: PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay * PHASE_E_POLICY.forge.shardsPerIngot,
  deedValuePerDay: null,
  shardsValue: 1,
  rawValue: 100,
  fragmentValue: PHASE_E_POLICY.forge.shardsPerIngot,
  consistencyWindowDays: 14,
  consistencyBonusPerDayBps: 200,
  dayMs: PHASE_E_MINING_PUBLICATION.daySec * 1_000,
} as const;

/** D153.123 / K231: the starter keeps its berth; admitted advanced families add
 * destinations only after the existing Keep unlock. Legacy cap tables stay frozen. */
export function effectiveBuildCountCapForKeep(type: string, keepLevel: number, vehiclesEnabled: boolean): number | undefined {
  const legacy = buildCountCapForKeep(type, keepLevel);
  return type === 'berth' && vehiclesEnabled === true && legacy !== undefined && legacy > 0
    && keepLevel >= BUILD_COSTS.berth.requiresKeepLevel ? PHASE_E_VEHICLES.installationsPerBaseMax : legacy;
}

/** Additive GET /base capacity; absence preserves an older server's build table. */
export interface ConstructionCapacity { version: 1; berth: { max: number } }
export function advertisedBerthBuildCapacity(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('berth' in value) || !value.berth || typeof value.berth !== 'object' || !('max' in value.berth)) return undefined;
  const max = value.berth.max;
  return typeof max === 'number' && Number.isSafeInteger(max) && max >= 0 ? max : undefined;
}

/** D153.206: explicit ordered-v0 mining compatibility profile. The existing
 * legacy default is unchanged; no priority fee is added by this instruction. */
export const PHASE_E_MINING_CLAIM_FORMAT = { version: 1, computeUnitLimit: 200_000 } as const;


/** D153.208 / ORDINARY-KITS-CONTRACT: delegated immutable recipe2. Owner
 * identities are Expedition = Heartwood + Thornsilk + SHARDS and Climate =
 * Sunstone + Embercore. SHARDS is an ingredient, never a service fee or tax.
 * Historical PHASE_E_ORDINARY_CRAFTING.v1 is deliberately unchanged. */
export const PHASE_E_ORDINARY_CRAFTING_V2 = {
  recipeVersion: 2, maxBatch: PHASE_E_ORDINARY_CRAFTING.v1.maxBatch,
  maxConcurrentPerBase: PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase,
  refining: PHASE_E_ORDINARY_CRAFTING.v1.refining,
  navigationKit: PHASE_E_ORDINARY_CRAFTING.v1.navigationKit,
  climateKit: { sunstoneBlocksPerOutput: 1, embercorePerOutput: 1, outputPerBatch: 1, secondsPerOutput: 120 },
  expeditionKit: { heartwoodBeamsPerOutput: 1, thornsilkPerOutput: 1, shardsPerOutput: 25, outputPerBatch: 1, secondsPerOutput: 180 },
} as const;

/** D153.208: prospective kit valuation preserves all v2 inputs and allowance.
 * Kit values are derived from consumed ingredients by miningResourceUnitValue;
 * this version alone does not authorize a UTC-day cutover or an emission. */
export const PHASE_E_MINING_CONTRIBUTION_V3 = {
  ...PHASE_E_MINING_CONTRIBUTION_V2,
  version: 3,
} as const;

/** D153.211 / VEHICLE-MATERIAL-CONTRACT: new delegated immutable catalogue1,
 * distinct from the proposed fragment model. One chosen family/target tier,
 * exact leaf ingredients, no intermediate assembly SKU or normal-loss refund.
 * Application fees remain PHASE_E_POLICY.craft, not another recipe charge. */
export const PHASE_E_VEHICLE_RECIPES = {
  recipeVersion: 1, outputQuantity: 1,
  tiers: {
    1: { materialMultiplier: 1, crystalFragments: 2, oddsBps: 8_000 },
    2: { materialMultiplier: 3, crystalFragments: 6, oddsBps: 6_500 },
    3: { materialMultiplier: 9, crystalFragments: 18, oddsBps: 4_500 },
    4: { materialMultiplier: 27, crystalFragments: 54, oddsBps: 2_500 },
  },
  refined: {
    survey_balloon: { heartwood_beams: 8, thornsilk: 8, prismstone_lens: 2, crownsteel: 2 },
    cargo_cutter: { heartwood_beams: 8, crownsteel: 8, stormalloy: 2, frostglass: 2 },
    courier_airship: { thornsilk: 8, stormalloy: 8, embercore: 2, prismstone_lens: 2 },
    expedition_barge: { heartwood_beams: 8, crownsteel: 8, sunstone_blocks: 2, embercore: 2 },
  },
} as const;

// ── Phase E bound cosmetics · D153 delegated CANDIDATE (2026-09-30) ──
/** Architect Blueprint: Artisan Finishes and its five bound cosmetic recipes,
 * exactly as docs/phase-e/BOUND-COSMETICS-PROPOSAL.md (SHA256 d2dbeff1…, primary
 * 3dd6365a4; candidate numbers unchanged since f73cffe1…) under
 * the original D153 "decisions make yourself" delegation. CANDIDATE STATUS:
 * selected for finite verification (BOUND-COSMETICS-NEXT.md, C1); these numbers
 * become implementation policy only after the finite model and independent
 * review pass and root records the selection. A bound record is an account
 * appearance for its original actor: no inventory SKU, NFT, price, resale,
 * reward, tax, EXP, Renown or mining credit, and no SHARDS/Gems/KEEP/SOL charge.
 * Facility ids are BuildingType values; input ids are existing refined items. */
export const PHASE_E_BOUND_COSMETICS = {
  currentRecipeVersion: 1,
  v1: {
    recipeVersion: 1,
    blueprintId: 'architect_blueprint_artisan_finishes_v1',
    /** Granted once to the ORIGINAL actor of one completed ordinary refining job
     * (any refine_* recipe) with at least one output; repeat checks grant nothing. */
    blueprint: { qualifyingCompletedRefiningJobs: 1, minimumOutputsPerJob: 1 },
    /** Every craft needs a genuinely completed Workshop on the selected controlled
     * base plus the recipe's own facility at the listed completed level or higher.
     * Awning facility levels are the floors of the existing five-level Market
     * visual tiers (STRUCTURES.market.maxLevel / PHASE_E_BUILDINGS.visualTiers). */
    craftFacility: 'workshop',
    outputPerCraft: 1,
    recipes: {
      craft_artisan_market_awning_t1_v1: { facility: 'market', facilityLevel: 1, durationSec: 300, inputs: { heartwood_beams: 2, thornsilk: 2, crownsteel: 1 } },
      craft_artisan_market_awning_t2_v1: { facility: 'market', facilityLevel: 6, durationSec: 600, inputs: { heartwood_beams: 4, thornsilk: 4, crownsteel: 2 } },
      craft_artisan_market_awning_t3_v1: { facility: 'market', facilityLevel: 11, durationSec: 900, inputs: { heartwood_beams: 8, thornsilk: 8, crownsteel: 4 } },
      craft_artisan_market_awning_t4_v1: { facility: 'market', facilityLevel: 16, durationSec: 1_200, inputs: { heartwood_beams: 16, thornsilk: 16, crownsteel: 8 } },
      craft_aurora_wake_v1: { facility: 'lodge', facilityLevel: 1, durationSec: 600, inputs: { prismstone_lens: 4, frostglass: 4, thornsilk: 4 } },
    },
  },
} as const;

/** Frozen raid advanced appearance v1 (D153.235 successor, delegated October1).
 * Historical mapping is permanently pinned to this version; future gameplay
 * allowance changes must introduce a new frozen contract version. */
export const RAID_ADVANCED_PRESENTATION_V1 = Object.freeze({completedUsesPerInstall:100});
