/**
 * V2TroopFx — data-driven battle controller for the authored grid troops.
 *
 * Owns one sprite whose clips resolve to their packed atlas and mirrors TroopFx's event
 * surface (fx/troop.ts delegates here when the v2 atlas is loaded): pos
 * tweens, standing attack, hit flinch, death. On top of the legacy surface it
 * renders the v2-only verbs — the giant's boulder throw (sim `troopFire`
 * proj:'boulder') and the dragon's 3-part breath stream.
 *
 * Facing is true 8-directional: nearest-of-8 from the movement heading, held
 * with hysteresis (clips.ts facing8Stable) so a near-diagonal leg does not
 * flap rows every frame — the anim.ts "dizzy shuffle" bug, third incarnation.
 * Row swaps go through V2Ticker.play, which preserves the stride phase.
 *
 * Scale is `v2TroopDrawScale` — the @1x→@2x pack conversion times the unit's
 * PUBLISHED world fit (ART_V2.troopSourceScale) — times the battle's own
 * BATTLE_SCALE.troop shrink. See v2TroopDrawScale and bodyScale below for why
 * both halves exist; before 2026-08-30 there was no fit and no battle shrink,
 * and every reworked troop drew larger than the Keep it was attacking.
 */
import {
  ART_V2,
  BATTLE_BODY_PRESENTATION,
  BATTLE_SCALE,
  TROOP_ABILITIES,
  V2_COMPACT_COMBAT_STATES,
  V2_FALLBACK_ATLAS, V2_FALLBACK_LOCOMOTION_STATES, V2_FALLBACK_STAND_STATES,
  atlasGroupFor, isV2FallbackUnit, v2DirewyvernCoreAtlasGroups,
  v2CompactCombatAtlasGroup, v2CompactCombatDownsample, v2CompactCombatFrameKey,
  v2DirewyvernEnhancementAtlasGroups,
  v2DirewyvernFxBaseKey,
  v2FallbackFrameKey, v2LocomotionAtlasGroup,
  v2LocomotionStandFrameKey,
} from '@shardkeep/shared';
import type Phaser from 'phaser';
import { haptic, shake } from '../../lib/juice';
import { BreathStream } from './breath';
import {
  clipFrames, clipKey, facing8Stable, facingRow, parseFxAt, toWorldPx, V2_DRAW_SCALE,
  type BreathStreamMeta, type Facing8, type V2Clip, type V2ClipMap,
  type V2ProjKind,
} from './clips';
import { emitterWorld, launchV2Projectile, playV2Fx } from './projectiles';
import type { V2Ticker } from './ticker';
import { actorDepth } from '../world/depth';

/** Death hold-then-fade, matching TroopFx's feel exactly (the clip itself
 *  already runs at its authored fps; only the hold/fade are house numbers). */
const DEATH_HOLD_MS = 400;
const DEATH_FADE_MS = 400;

export interface V2TroopDeps {
  ticker: V2Ticker;
  clips: V2ClipMap;
  breath: BreathStreamMeta | null;
  unit: V2TroopUnit;
  tier: number;
  /** Mandatory reduced-resolution behavior-complete core. It uses the same
   * clip metadata and restores each body cell to identical world geometry. */
  compact?: boolean;
  /** Resolve shared FX metadata keys into this controller's admitted local
   * shard. A compact controller never reaches into optional global v2fx. */
  fxBaseFor?: (metaBase: string) => string | null;
  /** Barrowling column block. Omitted is the deterministic first variant. */
  variant?: number;
  /** This actor belongs to a v5 event stream with target-aware melee cues.
   *  Omitted preserves the auto-swing fallback for persisted v3/v4 logs. */
  meleeDriven?: boolean;
}

export interface V2TroopProfile {
  /** Sprite-key root. Hexbarrow is a troop whose authored keys are `bld_`. */
  kind: 'trp' | 'bld';
  move: string;
  /** Optional combat locomotion. Base patrols deliberately keep `move`. */
  battleMove?: string;
  stand: string;
  /** One or more authored clips making up the ordinary standing attack. */
  attack: readonly string[];
  /** Event-driven special clips; never auto-played from local time. */
  abilities?: readonly string[];
  spawn?: string;
  hit?: string;
  /** Persistent low-health loop; currently authored only for Hexbarrow. */
  damaged?: string;
  death: string;
  autoAttack?: boolean;
  flying?: boolean;
  burrow?: Readonly<{ enter: string; tunnel: string; surface: string }>;
  detonate?: string;
  /** Target-aware melee presentation. The sim event decides which real target
   * family took damage; these strings only select the delivered one-shot. */
  melee?: Readonly<{ troop: string; building: string }>;
  /** Projectile release cue; its fxAt remains 0-based in metadata. */
  ranged?: Readonly<{
    state: string;
    fx: string;
    /** Owner-published attachment table used as the exact launch origin. */
    emitter: string;
    /** Optional radial release flash pinned to the same attachment. */
    flash?: string;
    projectile: V2ProjKind;
  }>;
}

/** Visual facts only: no stats, timing rules, or target policy live here. */
export const V2_TROOP_PROFILES = {
  highlander: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['attack'], spawn: 'spawn', hit: 'hit', death: 'death', melee: { troop: 'attack', building: 'attack' } },
  bowman: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['draw', 'loose'], spawn: 'spawn', hit: 'hit', death: 'death', autoAttack: false, ranged: { state: 'loose', fx: 'arrow', emitter: 'nock', projectile: 'arrow' } },
  kegrunner: { kind: 'trp', move: 'run', stand: 'idle', attack: ['prime'], spawn: 'spawn', hit: 'hit', death: 'detonate', autoAttack: false, detonate: 'detonate' },
  tunneler: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['attack'], hit: 'hit', death: 'death', burrow: { enter: 'burrow', tunnel: 'tunnel', surface: 'surface' }, melee: { troop: 'attack', building: 'attack' } },
  turrider: { kind: 'trp', move: 'walk', battleMove: 'charge', stand: 'idle', attack: ['attack'], spawn: 'spawn', hit: 'hit', death: 'death', melee: { troop: 'attack', building: 'attack' } },
  plunderer: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['attack'], spawn: 'spawn', hit: 'hit', death: 'death', melee: { troop: 'attack', building: 'attack' } },
  giant: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['attack'], spawn: 'spawn', hit: 'hit', death: 'death', melee: { troop: 'attack', building: 'attack' } },
  troll: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['attack'], spawn: 'spawn', hit: 'hit', death: 'death', melee: { troop: 'attack', building: 'pound' } },
  dragon: { kind: 'trp', move: 'fly', stand: 'hover', attack: ['breath'], spawn: 'spawn', hit: 'hit', death: 'death', autoAttack: false, flying: true },
  // Mage's size correction (owner 2026-08-11) used to live here as a bare
  // `drawScale: 0.5`, which was a game number outside constants.ts. It is now
  // ART_V2.troopSourceScale.mage, and it is a fit like every other root's: the
  // owner halved the mage while the whole pack was ~2.5x over, so the number
  // that survives is the intent ("the mage must not tower"), not the factor.
  mage: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['cast'], spawn: 'spawn', hit: 'hit', death: 'death', autoAttack: false, ranged: { state: 'cast', fx: 'bolt', emitter: 'staff', flash: 'castflash', projectile: 'bolt' } },
  bilgewraith: { kind: 'trp', move: 'walk', stand: 'idle', attack: ['attack'], hit: 'hit', death: 'death', burrow: { enter: 'burrow', tunnel: 'tunnel', surface: 'surface' }, melee: { troop: 'attack', building: 'attack' } },
  // Extended roster: the first three are trainable; Barrowling is spawned by Hexbarrow.
  gloamfang: { kind: 'trp', move: 'prowl', stand: 'prowl', attack: ['rend'], abilities: ['howl', 'leap', 'lunge'], spawn: 'spawn', hit: 'hit', death: 'death', melee: { troop: 'rend', building: 'rend' } },
  direwyvern: { kind: 'trp', move: 'glide', stand: 'hover', attack: ['firestorm'], abilities: ['maul'], spawn: 'spawn', hit: 'hit', death: 'death', autoAttack: false, flying: true },
  hexbarrow: { kind: 'bld', move: 'roll', stand: 'idle', attack: ['fire'], abilities: ['disgorge'], damaged: 'damaged', death: 'collapse', autoAttack: false, ranged: { state: 'fire', fx: 'hexshot', emitter: 'muzzle', projectile: 'hexshot' } },
  barrowling: { kind: 'trp', move: 'scurry', stand: 'scurry', attack: ['claw'], spawn: 'spawn', hit: 'hit', death: 'death', melee: { troop: 'claw', building: 'claw' } },
} as const satisfies Record<string, V2TroopProfile>;

export type V2TroopUnit = keyof typeof V2_TROOP_PROFILES;

export function v2TroopProfile(unit: string): V2TroopProfile | undefined {
  return (V2_TROOP_PROFILES as Record<string, V2TroopProfile | undefined>)[unit];
}

/**
 * Pack pixels → world pixels for one troop body: the @1x→@2x pack conversion
 * times the unit's PUBLISHED world fit, exactly as `v2BldDrawScale` and
 * `wareSeat` compose theirs.
 *
 * Both halves are load-bearing and neither may be inlined at a call site. The
 * pack conversion alone is what shipped, and it is why every reworked troop
 * drew larger than the building it was attacking (owner 2026-08-30 "troops are
 * very big") — every WARE family had been fitted to the base it stands on and
 * the troop pack never was. This is the ONE place that decides how big an actor
 * body is: the base garrison, the villagers, the builder, the battle body and
 * every projectile emitter offset all compose their own factor onto THIS
 * product, so a unit cannot be one size in the base view and another in a raid.
 *
 * An unknown root falls back to 1 — the raw pack conversion — deliberately: a
 * newly delivered art root that nobody has fitted yet renders visibly too big
 * rather than invisibly wrong, and `actorFit.test.ts` fails the build for it.
 */
export function v2TroopDrawScale(unit: string): number {
  const fit: Record<string, number> = ART_V2.troopSourceScale;
  return V2_DRAW_SCALE * (fit[unit] ?? 1);
}

/**
 * THE ONE NUMBER A TROOP LENDS TO ITS OWN ATTACHED ART — muzzle/attachment
 * OFFSETS (`emitterWorld`) and, since 2026-08-30, the size of the projectiles,
 * impacts and contact effects that leave them (`projectiles.ts` V2ArtFit).
 *
 * It is the body's drawn scale expressed against the pack conversion, so it
 * carries everything the body carries EXCEPT the @1x→@2x conversion the two
 * consumers apply themselves: the unit's published world fit and the battle
 * shrink. Keeping them one number is what makes the bowman's arrow leave his
 * hand AND be arrow-sized at every scale — a fit applied to the body alone
 * detaches every muzzle in the game, and a fit applied to the offset alone is
 * what left him firing an arrow as long as himself.
 *
 * The compact core's ×2 restore is deliberately NOT included: attachment points
 * are published in FULL-resolution cell px and the fx sheets are full-resolution
 * too, so scaling either by a factor that exists only to undo a half-resolution
 * BODY texture would double-count it.
 *
 * Exported because three paths outside this class fire a troop's shot — the
 * battle scene's ranged route, its budget-rejected fallback route, and
 * `fx/troop.ts`'s compact contact fx — and all four must read ONE definition or
 * the same unit fires two different sizes depending on which art path the
 * residency budget picked, i.e. a size that moves with a download.
 */
export function v2TroopArtFit(unit: string): number {
  return (v2TroopDrawScale(unit) * BATTLE_SCALE.troop) / V2_DRAW_SCALE;
}

export interface V2TroopFallbackDeps {
  clips: V2ClipMap;
  unit: V2TroopUnit;
  tier: number;
  /** Present only when the compact current-pack controller was admitted. */
  ticker?: V2Ticker;
}

export interface V2FallbackSpec {
  atlas: typeof V2_FALLBACK_ATLAS;
  frame: string;
  origin: readonly [number, number];
  scale: number;
}

export interface V2FallbackLocomotionSpec {
  atlas: string;
  base: string;
  seq: string[];
  fps: number;
  origin: readonly [number, number];
  scale: number;
}

export interface V2FallbackDirectionalStandSpec {
  atlas: string;
  frame: string;
  origin: readonly [number, number];
  scale: number;
}

/** Geometry + stable alias for the eager current-art stand frame. */
export function v2FallbackSpec(
  clips: V2ClipMap,
  unit: string,
  tier: number,
): V2FallbackSpec | null {
  if (!isV2FallbackUnit(unit) || !Number.isInteger(tier) || tier < 1 || tier > 4) return null;
  const profile = v2TroopProfile(unit);
  if (!profile || profile.stand !== V2_FALLBACK_STAND_STATES[unit]) return null;
  const clip = clips[clipKey(profile.kind, unit, tier, profile.stand)];
  const anchor = clip?.anchorPx;
  if (!clip || !anchor || clip.cellW <= 0 || clip.cellH <= 0
    || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) return null;
  return {
    atlas: V2_FALLBACK_ATLAS,
    frame: v2FallbackFrameKey(unit, tier),
    origin: [anchor[0] / clip.cellW, anchor[1] / clip.cellH],
    scale: v2TroopDrawScale(unit),
  };
}

/**
 * Authored current-pack movement clip used after the complete controller is
 * rejected by the residency budget. The helper fails closed unless the frame
 * routes to the dedicated compact atlas; a stale generated atlas can therefore
 * never make Phaser request a frame from the eager static fallback texture.
 */
export function v2FallbackLocomotionSpec(
  clips: V2ClipMap,
  unit: string,
  tier: number,
  facing: Facing8,
): V2FallbackLocomotionSpec | null {
  if (!isV2FallbackUnit(unit) || !Number.isInteger(tier) || tier < 1 || tier > 4) return null;
  const profile = v2TroopProfile(unit);
  if (!profile) return null;
  const verb = profile.battleMove ?? profile.move;
  if (!(V2_FALLBACK_LOCOMOTION_STATES[unit] as readonly string[]).includes(verb)) return null;
  const base = clipKey(profile.kind, unit, tier, verb);
  const clip = clips[base];
  const anchor = clip?.anchorPx;
  if (!clip || !anchor || clip.cellW <= 0 || clip.cellH <= 0
    || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) return null;
  const seq = clipFrames(base, clip, facingRow(clip, facing));
  if (seq.length === 0) return null;
  const atlas = atlasGroupFor(seq[0]!);
  if (atlas !== v2LocomotionAtlasGroup(unit, tier)) return null;
  return {
    atlas, base, seq, fps: clip.fps ?? 10,
    origin: [anchor[0] / clip.cellW, anchor[1] / clip.cellH],
    scale: v2TroopDrawScale(unit),
  };
}

/** One authored current stand pose per real heading, packed with locomotion. */
export function v2FallbackDirectionalStandSpec(
  clips: V2ClipMap,
  unit: string,
  tier: number,
  facing: Facing8,
): V2FallbackDirectionalStandSpec | null {
  if (!isV2FallbackUnit(unit) || !Number.isInteger(tier) || tier < 1 || tier > 4) return null;
  const profile = v2TroopProfile(unit);
  if (!profile || profile.stand !== V2_FALLBACK_STAND_STATES[unit]) return null;
  const clip = clips[clipKey(profile.kind, unit, tier, profile.stand)];
  const anchor = clip?.anchorPx;
  if (!clip || !anchor || clip.cellW <= 0 || clip.cellH <= 0
    || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) return null;
  const row = facingRow(clip, facing);
  const frame = v2LocomotionStandFrameKey(unit, tier, row);
  const atlas = atlasGroupFor(frame);
  if (atlas !== v2LocomotionAtlasGroup(unit, tier)) return null;
  return {
    atlas, frame,
    origin: [anchor[0] / clip.cellW, anchor[1] / clip.cellH],
    scale: v2TroopDrawScale(unit),
  };
}

/** Complete compact fallback set for one active troop tier. */
export function requiredV2FallbackLocomotionAtlasGroups(
  clips: V2ClipMap,
  unit: string,
  tier: number,
): string[] {
  if (!isV2FallbackUnit(unit)) return [];
  const profile = v2TroopProfile(unit);
  if (!profile) return [];
  const groups: string[] = [];
  for (const verb of V2_FALLBACK_LOCOMOTION_STATES[unit]) {
    const base = clipKey(profile.kind, unit, tier, verb);
    const clip = clips[base];
    const first = clip ? clipFrames(base, clip, 0)[0] : undefined;
    if (!first) return [];
    groups.push(atlasGroupFor(first));
  }
  const unique = [...new Set(groups)];
  if (unique.length !== 1 || unique[0] !== v2LocomotionAtlasGroup(unit, tier)) return [];
  if (unit === 'gloamfang') unique.push(atlasGroupFor(`${clipKey('trp', unit, tier, 'rend')}_f1`));
  return [...new Set(unique)];
}

/** Atomic body portion of the mandatory compact combat controller. */
export function requiredV2CompactCombatAtlasGroups(
  clips: V2ClipMap,
  unit: string,
  tier: number,
): string[] {
  if (!isV2FallbackUnit(unit)) return [];
  const profile = v2TroopProfile(unit);
  if (!profile) return [];
  for (const state of V2_COMPACT_COMBAT_STATES[unit]) {
    const clip = clips[clipKey(profile.kind, unit, tier, state)];
    if (!clip || clip.frames <= 0 || clip.rows <= 0) return [];
  }
  return [v2CompactCombatAtlasGroup(unit, tier)];
}

function profileStates(profile: V2TroopProfile): string[] {
  return [
    profile.move, profile.battleMove, profile.stand, ...profile.attack, ...(profile.abilities ?? []),
    profile.spawn, profile.hit,
    profile.damaged, profile.death,
    profile.burrow?.enter, profile.burrow?.tunnel, profile.burrow?.surface, profile.detonate,
    profile.melee?.troop, profile.melee?.building,
  ].filter((state): state is string => state !== undefined);
}

/** Event-capable core sheets that must fit before this controller is admitted. */
export function requiredV2TroopAtlasGroups(unit: V2TroopUnit, tier: number): string[] {
  if (unit === 'direwyvern') return v2DirewyvernCoreAtlasGroups(tier);
  const profile = V2_TROOP_PROFILES[unit] as V2TroopProfile;
  return [...new Set(profileStates(profile).map((state) =>
    atlasGroupFor(`${clipKey(profile.kind, unit, tier, state)}_f1`),
  ))];
}

/** Optional rich layers loaded only after a complete event-capable controller
 * is safe. Dire retains directional hover and held lifecycle fallbacks when
 * these sheets lose the fixed residency-budget admission. */
export function optionalV2TroopAtlasGroups(unit: V2TroopUnit, tier: number): string[] {
  return unit === 'direwyvern' ? v2DirewyvernEnhancementAtlasGroups(tier) : [];
}

type State = 'spawning' | 'idle' | 'walking' | 'acting' | 'melee' | 'priming' | 'burrowing' | 'burrowed' | 'emerging' | 'dying' | 'dead';
type VariantClip = V2Clip & { variants?: number; variantStride?: number };

const FACING_ROTATION_DEG: Record<Facing8, number> = {
  e: 0, se: 45, s: 90, sw: 135, w: 180, nw: -135, n: -90, ne: -45,
};

/** Published point attachment for each ordinary melee contact family. */
const MELEE_FX_EMITTER: Partial<Record<V2TroopUnit, Readonly<Record<string, string>>>> = {
  highlander: { sweep: 'blade' },
  gloamfang: { rend: 'fist' },
  troll: { sweep: 'fist', impact_slam: 'fist' },
  tunneler: { pick_hit: 'pick' },
  turrider: { lance_hit: 'lance' },
  bilgewraith: { slash: 'blade' },
};

export class V2TroopFx {
  readonly sprite: Phaser.GameObjects.Sprite;
  private state: State = 'idle';
  private facing: Facing8 = 's';
  private stream: BreathStream | null = null;
  private streamAttachment: { clip: V2Clip; frame1: number; x: number; y: number } | null = null;
  private nearest: (() => { x: number; y: number } | null) | null = null;
  /** Separates adjacent Phaser tweens whose completion callbacks may run after
   * the next keyframe has already started its segment. */
  private moveGeneration = 0;
  private moving = false;
  /** Old persisted event logs have no troopAttack cue and keep the historical
   * auto-swing fallback. Once the current protocol owns an actor, exact
   * target-aware events own its melee and standing gaps stay idle. */
  private meleeDriven: boolean;
  /** Scene-owned projectile fallback waiting for an authored release frame. */
  private pendingRangedRelease: { fallback: () => void } | null = null;
  private rangedActionActive = false;
  private rangedQueue: Array<{
    ix: number;
    iy: number;
    onRelease: (at: { x: number; y: number }) => void;
  }> = [];
  /** Persistent art state mirrors the scene's authoritative HP ledger. */
  private damaged = false;
  /** Lunge damage resolves later than its cast cue. The next authoritative pos
   *  is the sim-computed landing point and must snap, not add another 500ms. */
  private snapNextPos = false;
  /** Ability-owned sprites (firestorm fan) must not survive death/replacement. */
  private ownedSprites = new Set<Phaser.GameObjects.Sprite>();
  private ownedAbilityFx = new Set<Phaser.GameObjects.Image>();
  private abilityTimers = new Set<Phaser.Time.TimerEvent>();
  private readonly profile: V2TroopProfile;
  readonly initialAtlas: string;

  constructor(
    private scene: Phaser.Scene,
    private deps: V2TroopDeps,
    x: number,
    y: number,
    depth: number,
  ) {
    this.profile = V2_TROOP_PROFILES[deps.unit] as V2TroopProfile;
    this.meleeDriven = deps.meleeDriven ?? false;
    const requestedInitialState = this.profile.spawn ?? this.profile.stand;
    const requestedInitial = this.clip(requestedInitialState);
    const requestedFrames = requestedInitial
      ? this.frames(requestedInitialState, requestedInitial)
      : [];
    const requestedAtlas = requestedFrames[0] ? atlasGroupFor(requestedFrames[0]) : '';
    // A supplied controller already means its REQUIRED groups were admitted.
    // Only Dire lifecycle art is optional, so only that unit needs a runtime
    // texture probe here. Applying the probe to every controller breaks the
    // dependency contract and can synchronously skip ordinary spawn/actions.
    const hasRequestedInitial = requestedInitial !== undefined
      && requestedFrames.length > 0
      && (this.deps.unit !== 'direwyvern' || this.scene.textures.exists(requestedAtlas));
    const initialState = hasRequestedInitial ? requestedInitialState : this.profile.stand;
    const spawn = this.clip(initialState);
    // Origin from ANY clip of this unit, not just spawn: every clip of a unit
    // shares its cell + anchor, and hardcoding a fallback here silently seated
    // the DRAGON (160×120, anchor 80,110) with the GIANT's numbers (112×112,
    // 56,100) whenever its spawn clip was absent from the packed meta. Centre
    // of the cell is the only unit-agnostic last resort.
    const geom = spawn ?? this.anyClip();
    const [ax, ay] = geom?.anchorPx ?? [(geom?.cellW ?? 2) / 2, (geom?.cellH ?? 2) / 2];
    const first = spawn ? this.frames(initialState, spawn)[0]! : '';
    const directional = !this.deps.compact
      && this.deps.unit === 'direwyvern' && !hasRequestedInitial
      ? v2FallbackDirectionalStandSpec(
        this.deps.clips, this.deps.unit, this.deps.tier, this.facing,
      )
      : null;
    this.initialAtlas = directional?.atlas
      ?? atlasGroupFor(first || `${this.base(initialState)}_f1`);
    const initialFrame = directional?.frame ?? first;
    this.sprite = scene.add
      .sprite(x, y, this.initialAtlas, initialFrame)
      .setOrigin(
        directional?.origin[0] ?? ax / (geom?.cellW ?? 1),
        directional?.origin[1] ?? ay / (geom?.cellH ?? 1),
      )
      .setDepth(actorDepth(depth))
      // The unit's published world fit, then the battle's own shrink — see
      // bodyScale().
      .setScale(this.bodyScale());
    // Entrance: the authored spawn clip (giant lands with a dust kick at f3,
    // the dragon drops in and flares its wings), then straight to standing.
    if (this.profile.spawn && hasRequestedInitial) {
      this.state = 'spawning';
      this.playOnce(this.profile.spawn, () => {
        if (this.state !== 'spawning') return;
        if (this.moving) {
          this.state = 'walking';
          this.playLoop(this.profile.battleMove ?? this.profile.move);
        } else {
          this.stand();
        }
      });
    }
    else this.stand();
  }

  private base(state: string): string {
    return clipKey(this.profile.kind, this.deps.unit, this.deps.tier, state);
  }

  /**
   * World scale of the battle body.
   *
   * `BATTLE_SCALE.troop` DOES apply (it did not until 2026-08-30, and that was
   * the second half of "troops are very big"). The old refusal was reasoned
   * from a real risk — a blanket shrink would flatten the authored
   * Giant/Dragon/dark-family size differences — but that risk belonged to the
   * era when the pack conversion was the whole scale. Now that every root
   * publishes its own fit, the relationships live in ART_V2.troopSourceScale
   * and a UNIFORM battle factor preserves them exactly.
   *
   * What it restores is the pre-rework contract that BATTLE_SCALE documents and
   * that the legacy troops never stopped honouring: a troop's battle body is
   * `0.8 / AMBIENCE.garrisonScale` = 1.21x its base-view body, not 1.52x. While
   * this was skipped, the reworked units were the only actors in the game that
   * grew by half again on entering a raid, which is where the giant out-grew
   * the Keep by the widest margin.
   */
  private bodyScale(): number {
    return v2TroopDrawScale(this.deps.unit) * BATTLE_SCALE.troop * (this.deps.compact
      ? v2CompactCombatDownsample(this.deps.unit) : 1);
  }

  private applyBodyScale(): void {
    this.sprite.setScale(this.bodyScale());
  }

  /**
   * Scale for an emitter/attachment OFFSET — a launch point, not a body.
   *
   * `emitterWorld` already applies the @1x→@2x pack conversion itself
   * (`toWorldPx`), so what it still needs from here is everything ELSE the body
   * carries: the unit's published world fit and the battle shrink. Keeping the
   * two in step is what makes the bowman's arrow leave his hand and the giant's
   * boulder leave his fist at every scale — a fit applied to the body alone
   * would detach every muzzle in the game.
   *
   * The compact core's x2 restore is deliberately NOT included: attachment
   * points are published in FULL-resolution cell px, so scaling them by a factor
   * that exists only to undo a half-resolution body would double-count it.
   */
  private emitterScale(): number {
    return v2TroopArtFit(this.deps.unit);
  }

  private clip(state: string): V2Clip | undefined {
    return this.deps.clips[this.base(state)];
  }

  /** Any clip of THIS unit+tier — cell/anchor geometry is shared across a
   *  unit's clips, so this recovers the right origin when a specific clip
   *  (e.g. spawn) is missing from the packed meta. */
  private anyClip(): V2Clip | undefined {
    const prefix = clipKey(this.profile.kind, this.deps.unit, this.deps.tier, '');
    for (const [key, clip] of Object.entries(this.deps.clips)) {
      if (key.startsWith(prefix)) return clip;
    }
    return undefined;
  }

  private row(clip: V2Clip): number {
    return facingRow(clip, this.facing);
  }

  /** Barrowling variants are contiguous column blocks, not extra frames. */
  private frames(state: string, clip: V2Clip): string[] {
    const c = clip as VariantClip;
    const row = this.row(clip);
    if (!c.variants || c.variants <= 1) {
      if (this.deps.compact) {
        return Array.from({ length: clip.frames }, (_, i) =>
          v2CompactCombatFrameKey(
            this.deps.unit, this.deps.tier, state, row, i + 1, clip.rows,
          ));
      }
      return clipFrames(this.base(state), clip, row);
    }
    const stride = Math.max(1, c.variantStride ?? clip.frames);
    const variant = Math.min(c.variants - 1, Math.max(0, Math.trunc(this.deps.variant ?? 0)));
    if (this.deps.compact) {
      return Array.from({ length: stride }, (_, i) =>
        v2CompactCombatFrameKey(
          this.deps.unit, this.deps.tier, state, row,
          variant * stride + i + 1, clip.rows,
        ));
    }
    const rowToken = clip.rows > 1 ? `_d${row}` : '';
    return Array.from({ length: stride }, (_, i) =>
      `${this.base(state)}${rowToken}_f${variant * stride + i + 1}`,
    );
  }

  private atlasFor(state: string, clip: V2Clip): string {
    return atlasGroupFor(this.frames(state, clip)[0] ?? `${this.base(state)}_f1`);
  }

  private fxBase(metaBase: string): string | null {
    if (this.deps.fxBaseFor) return this.deps.fxBaseFor(metaBase);
    if (this.deps.unit === 'direwyvern') {
      const match = /^v2_fx_(firestorm|burnfield|impact_slam)_t\d+$/.exec(metaBase);
      if (match) return v2DirewyvernFxBaseKey(
        match[1] as 'firestorm' | 'burnfield' | 'impact_slam', this.deps.tier,
      );
    }
    return metaBase;
  }

  /** Every effect this actor emits — rend, slam, soil, burn, the lot — is drawn
   *  at the actor's OWN fit (owner 2026-08-30: "every troop should have
   *  corresponding size projectiles and attacks"). A barrowling's claw contact
   *  is barrowling-sized and the giant's is giant-sized, from one lever. */
  private playEffect(
    metaBase: string,
    x: number,
    y: number,
    opts: { depth?: number; rotationDeg?: number } = {},
  ): Phaser.GameObjects.Image | null {
    const base = this.fxBase(metaBase);
    return base
      ? playV2Fx(this.scene, this.deps.clips, base, x, y, {
        ...opts, metaBase, fit: this.emitterScale(),
      })
      : null;
  }

  private isOptionalDireState(state: string): boolean {
    return !this.deps.compact && this.deps.unit === 'direwyvern'
      && (state === this.profile.stand
        || state === this.profile.spawn
        || state === this.profile.hit
        || state === this.profile.death);
  }

  /** End one authored ranged body and start the next legacy-overlap cue only
   * after the prior clip has fully dwelled. SIM9 cadence normally leaves this
   * queue empty; it preserves complete cycles in older persisted replays. */
  private finishRangedAction(): void {
    this.pendingRangedRelease = null;
    this.rangedActionActive = false;
    const next = this.rangedQueue.shift();
    if (next && this.alive) this.onRangedAttack(next.ix, next.iy, next.onRelease);
  }

  private ownAbilityImage(image: Phaser.GameObjects.Image | null): void {
    if (!image) return;
    this.ownedAbilityFx.add(image);
    image.once('destroy', () => this.ownedAbilityFx.delete(image));
  }

  private delayedAbilityCall(delay: number, callback: () => void): void {
    let timer!: Phaser.Time.TimerEvent;
    timer = this.scene.time.delayedCall(delay, () => {
      this.abilityTimers.delete(timer);
      callback();
    });
    this.abilityTimers.add(timer);
  }

  private clearAbilityVisuals(): void {
    for (const timer of this.abilityTimers) timer.remove();
    this.abilityTimers.clear();
    for (const sprite of this.ownedSprites) sprite.destroy();
    this.ownedSprites.clear();
    for (const image of this.ownedAbilityFx) image.destroy();
    this.ownedAbilityFx.clear();
  }

  get alive(): boolean {
    return this.state !== 'dying' && this.state !== 'dead';
  }

  /** Scene-owned flight selects the projectile from the same authored profile
   *  that owns its release frame. */
  get rangedProjectile(): V2ProjKind | undefined {
    return this.profile.ranged?.projectile;
  }

  setNearestBuildingFn(fn: () => { x: number; y: number } | null): void {
    this.nearest = fn;
  }

  /** A replacement full replay stream may reveal a future target-aware cue for
   *  an actor that already exists. Arm it before scheduling that cue so the
   *  standing gap cannot invent a generic attack in the meantime. */
  setMeleeDriven(): void {
    if (!this.profile.melee) return;
    this.meleeDriven = true;
    // Generic fallback attacks deliberately keep state='idle' while their
    // one-shot runs. A replacement v5 stream must cut that invented swing now,
    // not wait up to one authored clip before the flag reaches stand().
    if (this.state === 'idle') this.playLoop(this.profile.stand);
  }

  /** Loop a state clip in the current facing (phase-preserving on row-only
   *  changes — V2Ticker.play decides). */
  private playLoop(state: string): void {
    const clip = this.clip(state);
    if (!clip) return;
    this.applyBodyScale();
    const atlas = this.atlasFor(state, clip);
    // Dire's authored hover grid is exceptionally large. Prefer it whenever
    // the admitted controller actually loaded that group; a capacity-safe
    // split may instead admit only the compact, owner-authored directional
    // hover aliases beside glide. This branch is visual fallback only and
    // never changes the event/state contract.
    if (this.deps.unit === 'direwyvern' && state === this.profile.stand
      && !this.scene.textures.exists(atlas)) {
      const fallback = v2FallbackDirectionalStandSpec(
        this.deps.clips, this.deps.unit, this.deps.tier, this.facing,
      );
      if (fallback && this.scene.textures.exists(fallback.atlas)) {
        this.sprite.setOrigin(fallback.origin[0], fallback.origin[1]);
        this.deps.ticker.play(this.sprite, {
          atlas: fallback.atlas,
          base: fallback.frame,
          seq: [fallback.frame],
          fps: 1,
          loop: true,
        });
        return;
      }
    }
    this.deps.ticker.play(this.sprite, {
      atlas,
      base: this.base(state),
      seq: this.frames(state, clip),
      fps: clip.fps ?? 10,
      loop: clip.loop ?? true,
      onFrame: this.fxAtHandler(clip),
    });
  }

  /** One-shot a state clip toward the current facing. */
  private playOnce(state: string, onComplete: () => void, onFrame?: (f: number) => void): void {
    const clip = this.clip(state);
    if (!clip || (this.isOptionalDireState(state)
      && !this.scene.textures.exists(this.atlasFor(state, clip)))) {
      onComplete();
      return;
    }
    this.applyBodyScale();
    const fxAt = this.fxAtHandler(clip);
    this.deps.ticker.play(this.sprite, {
      atlas: this.atlasFor(state, clip),
      base: this.base(state),
      seq: this.frames(state, clip),
      fps: clip.fps ?? 10,
      loop: false,
      onFrame: (f) => {
        fxAt?.(f);
        onFrame?.(f);
      },
      onComplete,
    });
  }

  /** Manifest fxAt → concrete effects the troop owns itself. Projectile
   *  release cues (boulder, breath, arrow, bolt) remain owned by their verbs. */
  private fxAtHandler(clip: V2Clip): ((f: number) => void) | undefined {
    const melee = MELEE_FX_EMITTER[this.deps.unit];
    const entries = parseFxAt(clip.fxAt).filter((e) =>
      e.fx === 'dust' || e.fx === 'slam' || e.fx === 'soil' || melee?.[e.fx] !== undefined,
    );
    if (entries.length === 0) return undefined;
    return (f: number) => {
      for (const e of entries) {
        if (!e.frames.includes(f)) continue;
        if (e.fx === 'dust') {
          this.playEffect('v2_fx_dust', this.sprite.x, this.sprite.y, {
            depth: this.sprite.depth - 1,
          });
        } else if (e.fx === 'slam') {
          // Slam connects a half-tile toward whatever the giant is hammering.
          // These two offsets are WORLD px already (half of BaseScene's T = 64,
          // and a small lift off the feet line), not pack px — no draw-scale
          // factor applies.
          const tgt = this.nearest?.();
          const dx = tgt ? Math.sign(tgt.x - this.sprite.x) : 0;
          this.playEffect(
            `v2_fx_impact_slam_t${this.deps.tier}`,
            this.sprite.x + dx * 32, this.sprite.y - 8, { depth: this.sprite.depth + 1 },
          );
        } else if (e.fx === 'soil') {
          // Burrow/surface soil is ground contact, not a body attachment.
          this.playEffect(
            `v2_fx_soil_t${this.deps.tier}`,
            this.sprite.x, this.sprite.y, { depth: this.sprite.depth - 1 },
          );
        } else {
          const emitter = melee?.[e.fx];
          if (!emitter) continue;
          const at = emitterWorld(
            this.sprite, clip, emitter, this.row(clip), f - 1, this.emitterScale(),
          );
          // These contact cells are authored pointing +x. The actor art has
          // eight discrete facings, so rotate the effect to that same facing;
          // deriving a weapon axis from sub-pixel attachment motion would be
          // unstable (the same reason cannon publishes a separate axis table).
          this.playEffect(
            `v2_fx_${e.fx}_t${this.deps.tier}`,
            at.x, at.y, {
              depth: this.sprite.depth + 1,
              rotationDeg: FACING_ROTATION_DEG[this.facing],
            },
          );
        }
      }
    };
  }

  /** Standing behaviour: the giant swings its attack clip at the nearest
   *  target (idle when there is nothing left to hit); the dragon hovers —
   *  its attack is the breath, which arrives as troopFire events. */
  private stand(): void {
    if (!this.alive) return;
    // Transform playback is orthogonal to body actions. If an authored action
    // finishes while a position segment is still live, return to locomotion;
    // only the segment owner may return the actor to a true stand.
    if (this.moving) {
      this.state = 'walking';
      this.playLoop(this.profile.battleMove ?? this.profile.move);
      return;
    }
    this.state = 'idle';
    this.faceTarget();
    const standState = this.damaged && this.profile.damaged
      ? this.profile.damaged
      : this.profile.stand;
    if (this.profile.autoAttack === false || (this.meleeDriven && this.profile.melee)) {
      this.playLoop(standState);
      return;
    }
    // The attack clip must EXIST before we re-arm on its completion: playOnce
    // calls onComplete SYNCHRONOUSLY when the clip is missing, so a giant whose
    // attack clip failed to pack would recurse stand → playOnce → stand until
    // the stack blew — a hard crash out of missing art, where every other v2
    // fallback degrades to a held frame. Degrade the same way here.
    if (this.nearest?.() && this.profile.attack.every((state) => this.clip(state))) {
      this.playAttack(0);
    } else {
      this.playLoop(standState);
    }
  }

  private playAttack(index: number): void {
    const state = this.profile.attack[index];
    if (!state) {
      if (this.state === 'idle') this.stand();
      return;
    }
    this.playOnce(state, () => {
      if (this.state === 'idle') this.playAttack(index + 1);
    });
  }

  private faceTarget(): void {
    const tgt = this.nearest?.();
    if (!tgt) return;
    this.facing = facing8Stable(tgt.x - this.sprite.x, tgt.y - this.sprite.y, this.facing);
  }

  /** A `pos` keyframe: tween there, playing the locomotion clip for the
   *  8-way heading (giant walks, dragon flies). */
  onPos(toX: number, toY: number, durMs: number): void {
    if (!this.alive) return;
    if (this.snapNextPos) {
      this.snapNextPos = false;
      this.scene.tweens.killTweensOf(this.sprite);
      this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));
      this.stand();
      return;
    }
    const generation = ++this.moveGeneration;
    // Replace the transform segment without replacing the authored body clip.
    // This is deliberately before the zero-distance branch: even an endpoint
    // correction invalidates the callback from the previous segment.
    this.scene.tweens.killTweensOf(this.sprite);
    const dx = toX - this.sprite.x;
    const dy = toY - this.sprite.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));
      this.moving = false;
      if (this.state === 'walking') this.stand();
      return;
    }
    const preserveVerb = this.state !== 'idle' && this.state !== 'walking';
    if (!preserveVerb) this.facing = facing8Stable(dx, dy, this.facing);
    if (this.state === 'burrowed') {
      this.moving = true;
      this.playLoop(this.profile.burrow!.tunnel);
      this.scene.tweens.add({
        targets: this.sprite, x: toX, y: toY, duration: durMs, ease: 'Linear',
        onUpdate: () => this.sprite.setDepth(actorDepth(this.sprite.y)),
        onComplete: () => {
          if (generation === this.moveGeneration) this.moving = false;
        },
      });
      return;
    }
    this.moving = true;
    // Tur Rider's authored contract distinguishes a calm base `walk` from its
    // signature battle `charge`. This selects animation only: simulation speed
    // remains the authoritative TROOPS.turrider value.
    if (!preserveVerb) {
      this.state = 'walking';
      this.playLoop(this.profile.battleMove ?? this.profile.move);
    }
    this.scene.tweens.add({
      targets: this.sprite,
      x: toX,
      y: toY,
      duration: durMs,
      ease: 'Linear',
      onUpdate: () => this.sprite.setDepth(actorDepth(this.sprite.y)),
      onComplete: () => {
        if (generation !== this.moveGeneration) return;
        this.moving = false;
        if (this.alive && this.state === 'walking') this.stand();
      },
    });
  }

  /** Absolute replay seek. Phaser clamps a zero-duration tween to a later
   * update, so a cold/jump hydration must mutate the transform directly. */
  snapPosition(toX: number, toY: number): void {
    if (!this.alive) return;
    this.moveGeneration++;
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));
    this.moving = false;
    if (this.state === 'walking') this.stand();
  }

  /** End constructor-time spawn/action state after an elapsed cold prefix. */
  finishSeek(): void {
    if (!this.alive || this.state === 'burrowed') return;
    this.moving = false;
    this.stand();
  }

  /** Per-frame: keep the standing swing aimed (row swap keeps phase). */
  tickAttack(): void {
    if (this.stream && this.streamAttachment) {
      const a = this.streamAttachment;
      const maw = emitterWorld(
        this.sprite, a.clip, 'maw', this.row(a.clip), Math.max(0, a.frame1 - 1),
        this.emitterScale(),
      );
      this.stream.update(maw.x, maw.y, a.x, a.y);
    }
    if (this.state !== 'idle') return;
    const before = this.facing;
    this.faceTarget();
    if (this.facing !== before) {
      // Re-issue the current registration with the new row; V2Ticker keeps
      // the frame index (same clip, same length).
      if (this.profile.autoAttack === false || (this.meleeDriven && this.profile.melee)) {
        this.playLoop(this.damaged && this.profile.damaged ? this.profile.damaged : this.profile.stand);
      }
      // The giant's swing re-rows itself on its next pass — mid-swing row
      // swaps read as a glitchy pivot with a weapon mid-arc.
    }
  }

  /**
   * Giant boulder throw (sim `troopFire` proj:'boulder' — defenses only,
   * 2.5 tiles, may cross walls). Throw clip toward the target; the boulder
   * leaves at the manifest fxAt frame (boulder@3) from the CELL CENTRE — the
   * giant has no emitter table, centre is the labs' documented fallback —
   * lobs at 45% of range, tumbles (heading-row frames), drops an altitude
   * shadow, and lands as impact_rubble at the contact anchor with the shell
   * landings' camera budget.
   */
  onSiegeThrow(ix: number, iy: number): void {
    if (!this.alive || this.deps.unit !== 'giant') return;
    const clip = this.clip('throw');
    if (!clip) return;
    this.state = 'acting';
    this.facing = facing8Stable(ix - this.sprite.x, iy - this.sprite.y, this.facing);
    // Frame NUMBERS (1-based), already shifted off the pack's 0-based indices by
    // parseFxAt — so the fallback for a clip with no fxAt is the manifest's
    // `boulder@3` read the same way, i.e. frame 4.
    const launch = parseFxAt(clip.fxAt).find((e) => e.fx === 'boulder')?.frames ?? [4];
    let thrown = false;
    this.playOnce(
      'throw',
      () => {
        if (this.state === 'acting') {
          this.state = 'idle';
          this.stand();
        }
      },
      (f) => {
        if (thrown || !launch.includes(f)) return;
        thrown = true;
        const [ax, ay] = clip.anchorPx ?? [56, 100];
        // Cell centre in world px: the anchor-to-centre delta is a PACK-px
        // vector, so it scales into world px like the art it measures — INCLUDING
        // the unit's published world fit (emitterScale). This is one of the two
        // places that reached past the emitter table straight to toWorldPx; at
        // the bare pack conversion the rock left a fitted giant 88 px above his
        // feet, i.e. well over his own head.
        const body = this.emitterScale();
        const fromX = this.sprite.x + toWorldPx(clip.cellW / 2 - ax) * body;
        const fromY = this.sprite.y + toWorldPx(clip.cellH / 2 - ay) * body;
        launchV2Projectile(
          this.scene, this.deps.clips, 'boulder', this.deps.tier,
          fromX, fromY, ix, iy,
          () => {
            // §3.10 keg/mortar juice budget — a rock this size lands like a shell.
            shake(this.scene, 150, 0.004);
            haptic('medium');
          },
          this.deps.fxBaseFor ? { baseFor: this.deps.fxBaseFor } : undefined,
          // The rock is the giant's rock: same fit as the fist that threw it.
          body,
        );
      },
    );
  }

  /**
   * Dragon breath (sim `troopFire`). At or past minRange the 3-part stream is
   * assembled from the maw to the impact point and burns the ground once at
   * onset; point-blank uses the protected pack's current one-piece breath.
   * Neither branch may cross into the historical `fx_breath_dragon` atlas.
   */
  onBreath(ix: number, iy: number): void {
    if (!this.alive || this.deps.unit !== 'dragon') return;
    const clip = this.clip('breath');
    if (!clip) return;
    const minRange = this.deps.breath?.minRange ?? 80;
    const dist = Math.hypot(ix - this.sprite.x, iy - this.sprite.y);
    const pointBlank = dist < minRange;
    this.state = 'acting';
    this.facing = facing8Stable(ix - this.sprite.x, iy - this.sprite.y, this.facing);
    // 1-based frame numbers (parseFxAt already shifted the pack's 0-based
    // indices); the fallback is the manifest's `breath@3-5` read the same way.
    const windowFrames = parseFxAt(clip.fxAt).find((e) => e.fx === 'breath')?.frames ?? [4, 5, 6];
    const last = windowFrames[windowFrames.length - 1]!;
    const row = this.row(clip);
    let started = false;
    this.playOnce(
      'breath',
      () => {
        this.stream?.destroy();
        this.stream = null;
        this.streamAttachment = null;
        if (this.state === 'acting') {
          this.state = 'idle';
          this.stand();
        }
      },
      (f) => {
        if (this.streamAttachment) this.streamAttachment.frame1 = f;
        if (windowFrames.includes(f) && !started) {
          started = true;
          const maw = emitterWorld(
            this.sprite, clip, 'maw', row, f - 1, this.emitterScale(),
          );
          if (pointBlank) {
            this.playEffect(
              `v2_fx_breath_t${this.deps.tier}`,
              maw.x, maw.y, {
                depth: this.sprite.depth + 1,
                rotationDeg: (Math.atan2(iy - maw.y, ix - maw.x) * 180) / Math.PI,
              },
            );
          } else {
            this.stream = new BreathStream(
              this.scene, this.deps.clips, this.deps.tier, maw.x, maw.y, ix, iy,
              this.deps.fxBaseFor,
            );
            this.streamAttachment = { clip, frame1: f, x: ix, y: iy };
            // The tip is the contact effect; impact_burn fires ONCE at onset.
            this.playEffect(`v2_fx_impact_burn_t${this.deps.tier}`, ix, iy);
          }
        } else if (f > last && this.stream) {
          this.stream.destroy();
          this.stream = null;
          this.streamAttachment = null;
        }
      },
    );
  }

  /**
   * A sim ranged-fire cue for units whose projectile is scene-owned. The
   * callback runs exactly once on the manifest release frame (metadata is
   * 0-based; parseFxAt converts to V2Ticker's 1-based frame numbers).
   */
  onRangedAttack(
    ix: number,
    iy: number,
    onRelease: (at: { x: number; y: number }) => void,
  ): void {
    if (!this.alive) return;
    if (this.rangedActionActive) {
      this.rangedQueue.push({ ix, iy, onRelease });
      return;
    }
    this.rangedActionActive = true;
    const ranged = this.profile.ranged;
    let released = false;
    const pending = { fallback: (): void => undefined };
    const release = (at = { x: this.sprite.x, y: this.sprite.y }): void => {
      if (released) return;
      released = true;
      if (this.pendingRangedRelease === pending) this.pendingRangedRelease = null;
      onRelease(at);
    };
    pending.fallback = () => release();
    this.pendingRangedRelease = pending;
    // A sim fire event must never disappear because a visual profile is absent
    // or a stale replay reaches a dead renderer. The scene callback owns the
    // legacy fallback and is guaranteed exactly one invocation.
    if (!ranged) {
      release();
      this.finishRangedAction();
      return;
    }
    // A server fire cue is a new action, so explicitly restart its authored
    // sequence. This matters for Mage: cast lasts beyond the 500 ms visual
    // cadence, while V2Ticker deliberately treats an identical registration as
    // a locomotion-safe no-op. Without the unregister, THIS cue's new release
    // callback is never attached. V2Ticker's global phase contract stays intact.
    this.deps.ticker.unregister(this.sprite);
    this.state = 'acting';
    this.facing = facing8Stable(ix - this.sprite.x, iy - this.sprite.y, this.facing);
    const play = (index: number): void => {
      const state = this.profile.attack[index];
      if (!state) {
        // Missing/re-authored art must not swallow a sim projectile.
        release();
        if (this.state === 'acting') this.stand();
        this.finishRangedAction();
        return;
      }
      const clip = this.clip(state);
      if (!clip) {
        release();
        if (this.state === 'acting') this.stand();
        this.finishRangedAction();
        return;
      }
      const releaseFrames = state === ranged.state
        ? parseFxAt(clip.fxAt).find((entry) => entry.fx === ranged.fx)?.frames ?? []
        : [];
      this.playOnce(state, () => {
        if (this.state === 'acting') play(index + 1);
      }, (frame1) => {
        if (!released && releaseFrames.includes(frame1)) {
          const at = emitterWorld(
            this.sprite, clip, ranged.emitter, this.row(clip), frame1 - 1,
            this.emitterScale(),
          );
          if (ranged.flash) {
            this.playEffect(
              `v2_fx_${ranged.flash}_t${this.deps.tier}`,
              at.x, at.y, { depth: this.sprite.depth + 1 },
            );
          }
          release({ x: at.x, y: at.y });
        }
      });
    };
    play(0);
  }

  /** Render the target family from a server-authored melee damage cue. Each
   * cue restarts its one-shot deliberately: both delivered clips are slightly
   * longer than the shared 500 ms visual cadence, and an identical ticker
   * registration would otherwise keep stale callbacks/phase. */
  onMeleeAttack(
    target: 'troop' | 'building', ix: number, iy: number,
    technique?: 'strike' | 'slam' | 'rend',
  ): void {
    if (!this.alive || !this.profile.melee) return;
    const state = this.profile.melee[target];
    if (technique === 'rend' && state !== 'rend') return;
    if (technique === 'slam' && state !== 'pound' && state !== 'attack') return;
    if (!this.clip(state)) return;
    this.meleeDriven = true;
    this.state = 'melee';
    this.facing = facing8Stable(ix - this.sprite.x, iy - this.sprite.y, this.facing);
    this.deps.ticker.unregister(this.sprite);
    this.playOnce(state, () => {
      if (this.state === 'melee') this.stand();
    });
  }

  /**
   * SIM6 authored ability cue. The event coordinates are authoritative: snap
   * the body to its cast origin before choosing a facing, and let only a later
   * `pos` event decide a lunge's actual landing point.
   */
  onAbility(
    ability: 'howl' | 'leap' | 'lunge' | 'firestorm' | 'maul' | 'disgorge',
    x: number,
    y: number,
    ix?: number,
    iy?: number,
  ): void {
    if (!this.alive) return;
    const aimed = ix !== undefined && iy !== undefined;
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.setPosition(x, y).setDepth(actorDepth(y));
    this.moving = false;
    if (aimed) this.facing = facing8Stable(ix - x, iy - y, this.facing);

    if (this.deps.unit === 'gloamfang') {
      if (ability === 'leap' && aimed) { this.playLeap(x, y, ix, iy); return; }
      if (ability === 'lunge' && aimed) {
        this.snapNextPos = true;
        this.playAbilityOnce('lunge');
        return;
      }
      if (ability === 'howl') {
        const clip = this.clip('howl');
        if (!clip) return;
        const keyed = parseFxAt(clip.fxAt).find((entry) => entry.fx === 'howl')?.frames ?? [3];
        let fired = false;
        this.playAbilityOnce('howl', (frame1) => {
          if (fired || !keyed.includes(frame1)) return;
          fired = true;
          this.ownAbilityImage(this.playEffect(
            `v2_fx_howl_t${this.deps.tier}`,
            this.sprite.x, this.sprite.y, { depth: this.sprite.depth - 1 },
          ));
        });
        return;
      }
    }

    if (this.deps.unit === 'direwyvern') {
      if (ability === 'firestorm' && aimed) { this.playFirestorm(ix, iy); return; }
      if (ability === 'maul') { this.playMaul(); return; }
    }
    if (this.deps.unit === 'hexbarrow' && ability === 'disgorge') {
      this.playAbilityOnce('disgorge');
    }
  }

  /** Restart one authored ability exactly once for one sim cue. */
  private playAbilityOnce(state: string, onFrame?: (frame1: number) => void): void {
    if (!this.clip(state)) return;
    this.deps.ticker.unregister(this.sprite);
    this.state = 'acting';
    this.playOnce(state, () => {
      if (this.state === 'acting') this.stand();
    }, onFrame);
  }

  /** Owner lab: a seven-tick, 30%-height arc with dust at both endpoints. */
  private playLeap(fromX: number, fromY: number, toX: number, toY: number): void {
    const clip = this.clip('leap');
    if (!clip) return;
    this.deps.ticker.unregister(this.sprite);
    this.state = 'acting';
    const duration = TROOP_ABILITIES.gloamfang.leap.travelDeciSec * 100;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const range = Math.hypot(dx, dy);
    this.playOnce('leap', () => {
      if (this.state === 'acting') this.stand();
    });
    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration,
      ease: 'Linear',
      onUpdate: (tw) => {
        const p = tw.getValue() ?? 0;
        const x = fromX + dx * p;
        const groundY = fromY + dy * p;
        // `0.30` is the owner lab's visual arc, not combat authority.
        const y = groundY - range * 0.30 * 4 * p * (1 - p);
        if (this.sprite.active) this.sprite.setPosition(x, y).setDepth(actorDepth(groundY));
      },
      onComplete: () => {
        if (this.sprite.active) this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));
      },
    });
  }

  /** Fan body + fan FX stay pinned to the per-frame published maw emitter. */
  private playFirestorm(ix: number, iy: number): void {
    const body = this.clip('firestorm');
    const fxMetaBase = `v2_fx_firestorm_t${this.deps.tier}`;
    const fxBase = v2DirewyvernFxBaseKey('firestorm', this.deps.tier);
    const fxClip = this.deps.clips[fxMetaBase];
    if (!body || !fxClip) return;
    const keyed = parseFxAt(body.fxAt).find((entry) => entry.fx === 'firestorm')?.frames
      ?? [2, 3, 4, 5, 6, 7];
    let fan: Phaser.GameObjects.Sprite | null = null;
    const pinFan = (frame1: number): void => {
      if (!keyed.includes(frame1)) return;
      const maw = emitterWorld(
        this.sprite, body, 'maw', this.row(body), frame1 - 1, this.emitterScale(),
      );
      if (!fan) {
        const seq = clipFrames(fxBase, fxClip, 0);
        const atlas = atlasGroupFor(seq[0]!);
        const [ax, ay] = fxClip.anchorPx ?? [fxClip.cellW / 2, fxClip.cellH / 2];
        fan = this.scene.add.sprite(maw.x, maw.y, atlas, seq[0]!)
          .setOrigin(ax / fxClip.cellW, ay / fxClip.cellH)
          // Pinned to her maw, so it is drawn at her fit like everything else
          // she emits; a bare V2_DRAW_SCALE here is the same bypass the arrow
          // had, and it fanned a full-size firestorm out of a fitted wyvern.
          .setScale(V2_DRAW_SCALE * this.emitterScale())
          .setDepth(this.sprite.depth + 1);
        this.ownedSprites.add(fan);
        fan.once('destroy', () => { if (fan) this.ownedSprites.delete(fan); });
        this.deps.ticker.play(fan, {
          atlas,
          base: fxBase,
          seq,
          fps: fxClip.fps ?? 11,
          loop: false,
          onComplete: () => fan?.destroy(),
        });
      }
      // The owner lab's aimed/reach firestorm scales along its firing axis:
      // rotating a fixed-length fan can still stop before or beyond the target.
      // Its thickness retains the actor fit, and the moving maw stays anchored.
      const authoredReach = fxClip.cellW - (fxClip.anchorPx?.[0] ?? fxClip.cellW / 2);
      fan.setPosition(maw.x, maw.y)
        .setScale(
          Math.hypot(ix - maw.x, iy - maw.y) / Math.max(1, authoredReach),
          V2_DRAW_SCALE * this.emitterScale(),
        )
        .setRotation(Math.atan2(iy - maw.y, ix - maw.x));
    };
    this.playAbilityOnce('firestorm', pinFan);
  }

  /** Owner lab: one impact under each wing, one body frame apart. */
  private playMaul(): void {
    const clip = this.clip('maul');
    if (!clip) return;
    const keyed = parseFxAt(clip.fxAt).find((entry) => entry.fx === 'impact_slam')?.frames ?? [3];
    let fired = false;
    this.playAbilityOnce('maul', (frame1) => {
      if (fired || !keyed.includes(frame1)) return;
      fired = true;
      // Wing span and ground offset are pack-px measurements OF THE BODY, so
      // they carry the body's fit (the second toWorldPx bypass) — otherwise the
      // wyvern's two impacts land a body-width outside her own silhouette.
      const body = this.emitterScale();
      const wing = toWorldPx(clip.cellW * 0.13) * body;
      const ground = this.sprite.y + toWorldPx(8) * body;
      this.ownAbilityImage(this.playEffect(`v2_fx_impact_slam_t${this.deps.tier}`,
        this.sprite.x - wing, ground, {
          depth: this.sprite.depth + 1,
        }));
      this.delayedAbilityCall(1000 / (clip.fps ?? 12), () => {
        if (!this.alive) return;
        this.ownAbilityImage(this.playEffect(`v2_fx_impact_slam_t${this.deps.tier}`,
          this.sprite.x + wing, ground, {
            depth: this.sprite.depth + 1,
          }));
      });
    });
  }

  /** Persistent damage survives chain hits and cold prefix hydration, without
   * starting a historical hit flinch. Healing never reverses this latched state. */
  syncHealth(healthRatio: number): void {
    if (this.profile.damaged && healthRatio <= BATTLE_BODY_PRESENTATION.damagedTroopHealthRatio) {
      if (this.damaged) return;
      this.damaged = true;
      if (this.state === 'idle') this.stand();
    }
  }

  /** Flinch on an incoming hit — only while standing; a mid-stride or
   *  mid-throw flinch would cut a clip whose fxAt has not fired yet. */
  onHit(healthRatio = 1): void {
    this.syncHealth(healthRatio);
    if (this.profile.damaged && this.damaged) return;
    if (this.state !== 'idle' || !this.profile.hit) return;
    this.state = 'acting';
    this.playOnce(this.profile.hit, () => {
      if (this.state === 'acting') {
        this.state = 'idle';
        this.stand();
      }
    });
  }

  /** Authored body→mound→body cycle for tunneler and bilgewraith. */
  onBurrow(): void {
    if (!this.alive || !this.profile.burrow) return;
    this.state = 'burrowing';
    this.playOnce(this.profile.burrow.enter, () => {
      if (this.state !== 'burrowing') return;
      this.state = 'burrowed';
      this.playLoop(this.profile.burrow!.tunnel);
    });
  }

  /** Materialize the persistent side of an already-applied burrow event. */
  seekBurrowed(): void {
    if (!this.alive || !this.profile.burrow) return;
    this.moveGeneration++;
    this.scene.tweens.killTweensOf(this.sprite);
    this.state = 'burrowed';
    this.moving = false;
    this.playLoop(this.profile.burrow.tunnel);
  }

  onEmerge(x?: number, y?: number): void {
    if (!this.alive || !this.profile.burrow) return;
    if (x !== undefined && y !== undefined) {
      this.scene.tweens.killTweensOf(this.sprite);
      this.sprite.setPosition(x, y).setDepth(actorDepth(y));
    }
    this.state = 'emerging';
    this.playOnce(this.profile.burrow.surface, () => {
      if (this.state === 'emerging') this.stand();
    });
  }

  /** Materialize the stable side of an emerge event without replaying its
   * historical one-shot after a seek. */
  seekEmerged(x?: number, y?: number): void {
    if (!this.alive || !this.profile.burrow) return;
    if (x !== undefined && y !== undefined) this.snapPosition(x, y);
    this.stand();
  }

  /** Visual anticipation for the already-authoritative Keg Runner detonation.
   * BattleScene schedules exactly one authored prime-loop duration before the
   * recorded blast; this method changes no combat timing or outcome. */
  onPrime(): void {
    if (!this.alive || this.deps.unit !== 'kegrunner' || !this.clip('prime')) return;
    this.state = 'priming';
    this.faceTarget();
    this.playLoop('prime');
  }

  /** A replacement replay stream cancels synthetic anticipation from the old
   * stream before it schedules new authoritative movement/detonation events. */
  cancelPrime(): void {
    if (this.state !== 'priming') return;
    if (this.moving) {
      this.state = 'walking';
      this.playLoop(this.profile.battleMove ?? this.profile.move);
    } else {
      this.stand();
    }
  }

  /** Replacement replay streams own a fresh set of exact-once action cues. */
  cancelReplayAction(): void {
    this.pendingRangedRelease = null;
    this.rangedQueue = [];
    this.rangedActionActive = false;
    this.snapNextPos = false;
    this.stream?.destroy();
    this.stream = null;
    this.streamAttachment = null;
    this.clearAbilityVisuals();
    this.scene.tweens.killTweensOf(this.sprite);
    if (this.alive && this.state === 'acting') this.stand();
  }

  /** Explicit Kegrunner detonation. Ordinary onDeath reuses the body frames
   *  without entering this gameplay-significant blast path. */
  onDetonate(onBlast?: (at: { x: number; y: number }) => void): void {
    if (!this.alive || !this.profile.detonate) {
      onBlast?.({ x: this.sprite.x, y: this.sprite.y });
      return;
    }
    const state = this.profile.detonate;
    const clip = this.clip(state);
    this.state = 'dying';
    let fired = false;
    const blast = (at = { x: this.sprite.x, y: this.sprite.y }): void => {
      if (fired) return;
      fired = true;
      onBlast?.(at);
    };
    if (!clip) {
      blast();
      this.finishDeath();
      return;
    }
    const keyed = parseFxAt(clip.fxAt).find((e) => e.fx === 'keg_blast')?.frames;
    // This manifest annotates the strict token with prose: `... at the KEG emitter`.
    const raw = /keg_blast@(\d+)/.exec(clip.fxAt ?? '');
    const frames = keyed ?? (raw ? [Number(raw[1]) + 1] : [2]);
    this.playOnce(state, () => {
      // A missing/re-authored cue still hands feedback back to the scene once.
      blast();
      this.finishDeath();
    }, (frame1) => {
      if (fired || !frames.includes(frame1)) return;
      const row = this.row(clip);
      const at = emitterWorld(
        this.sprite, clip, 'keg', row, frame1 - 1, this.emitterScale(),
      );
      this.playEffect(`v2_fx_keg_blast_t${this.deps.tier}`, at.x, at.y);
      blast({ x: at.x, y: at.y });
    });
  }

  onDeath(): void {
    // D-034: a death before the authored release cancels that projectile; one
    // already released is scene-pooled and survives independently.
    this.pendingRangedRelease = null;
    this.rangedQueue = [];
    this.rangedActionActive = false;
    if (!this.alive) return;
    this.state = 'dying';
    this.snapNextPos = false;
    this.scene.tweens.killTweensOf(this.sprite);
    this.stream?.destroy();
    this.stream = null;
    this.streamAttachment = null;
    this.clearAbilityVisuals();
    this.sprite.setVisible(true).setAlpha(1);
    this.playOnce(this.profile.death, () => this.finishDeath());
  }

  private finishDeath(): void {
    if (this.state !== 'dying') this.state = 'dying';
    this.scene.time.delayedCall(DEATH_HOLD_MS, () => {
      if (!this.sprite.active) return;
      this.scene.tweens.add({
        targets: this.sprite,
        alpha: 0,
        duration: DEATH_FADE_MS,
        onComplete: () => {
          this.state = 'dead';
          this.sprite.destroy();
        },
      });
    });
  }

  destroy(): void {
    // Teardown is cancellation, not a gameplay interruption: firing here would
    // create a projectile/SFX while BattleScene is retreating. Death and a
    // replacement fire cue deliberately settle via their own call sites.
    // Prefix correction can replace a WALKING actor between tween updates.
    // Cancel its tween and fence a completion already queued by Phaser before
    // destroy clears sprite.scene, or stand() calls setTexture on a dead sprite
    // and the uncaught exception stops Phaser's next animation frame.
    this.state = 'dead';
    this.moveGeneration++;
    this.moving = false;
    this.scene.tweens.killTweensOf(this.sprite);
    this.pendingRangedRelease = null;
    this.rangedQueue = [];
    this.rangedActionActive = false;
    this.stream?.destroy();
    this.stream = null;
    this.streamAttachment = null;
    this.clearAbilityVisuals();
    this.deps.ticker.unregister(this.sprite);
    this.sprite.destroy();
  }
}
