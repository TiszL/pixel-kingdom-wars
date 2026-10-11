/**
 * Patrol layer (owner 2026-07-28): the base's SOLDIERS in motion —
 *  - the Army Camp garrison no longer stands walking-in-place at fixed offsets:
 *    each unit strolls between points on a ring around its camp's footprint, at
 *    villager scale ("camp garrison troops are too big");
 *  - the recruited hero no longer idles pinned to the altar dais: they walk the
 *    loop of building doors around the base at hero scale, idling at stops,
 *    with occasional returns to the dais ("the hero should patrol the base").
 *
 * WHY a separate layer and not ambience.ts: ambience sprites are rebuilt-by-key
 * on every sync and never ticked per frame, so anything that MOVES lives here,
 * following the shared walker/occupancy seam. Same rules as the retired
 * decorative-walker implementation, and for the same reasons:
 *  - never `setInteractive` — a tap must always reach the building underneath;
 *  - a sprite's frames advance on the clock ITS ART WAS AUTHORED FOR, and on
 *    exactly one of them: the legacy/batch-13 and `hero_*` masters were drawn to
 *    the house 260ms `AnimTicker` and stay on it; the v2/game-v4 grid sheets
 *    publish a per-clip fps and ride `V2Ticker`, the same per-clip clock the
 *    battle scene, the builder (world/jobs.ts) and every other v2 consumer
 *    already use. Mixing them is the FLICKER (owner 2026-08-30 "all of them are
 *    flickering"): a 10fps walk delivered at 3.85fps holds each authored
 *    in-between 2.6x too long, so a gait built from multi-pixel body steps
 *    arrives as discrete jumps instead of a stride, and on a unit whose body
 *    step exceeds its forward travel it reads as vibrating on the spot. A
 *    walker is registered on at most ONE of the two tickers at a time —
 *    `stand()` and `walk()` unregister from the other before registering;
 *  - movement rides real elapsed dt, so pace is framerate-independent;
 *  - depth = the walker's own feet Y (painter's order, HANDOFF §3.3), which is
 *    only correct while the FEET are on free ground — so every waypoint, every
 *    leg and every step goes through occupancy.ts and no walker ever stands in
 *    a building or a wall (owner 2026-07-29);
 *  - `reduceMotion` freezes movement but keeps everyone dressed — and a frozen
 *    walker is STOOD DOWN first, because a sprite left registered on its walk
 *    cycle marches in place (the exact bug villagers.ts fixed; not reintroduced);
 *  - walkers are seeded with a local LCG (garrison: camp id, hero: wallet+id) so
 *    a base moves the same way every session and a bug is reproducible. Each
 *    walker owns its OWN stream, drawn only on its own arrivals, so one unit's
 *    route never perturbs another's.
 *
 * ART LEVEL — the garrison renders the batch-13 per-level dragon/giant masters,
 * but ONLY when both halves of the contract hold (2026-08-03; this REPLACES the
 * earlier level-agnostic decision, which stood while /base shipped no level):
 *  - the server sent the troop's level on its /base army row. A troop level is
 *    a game number and the client never invents one, so a row WITHOUT a level
 *    (an older server, or a troop with no per-level art) renders the legacy
 *    `trp` masters exactly as before batch 13;
 *  - that level's `trpdg_l<N>` atlas is actually REGISTERED (the
 *    `isLevelArtLoaded` gate sync() takes, fed by BaseScene from
 *    world/atlasLoader.ts). The per-level atlases are on-demand (~8.6MB each,
 *    deliberately not in the boot set), and Phaser draws NOTHING, silently, for
 *    a frame its texture does not have — so while the load is in flight, and
 *    forever if it FAILS, the walkers use the eager current-v2 stand alias when
 *    metadata supplies one (legacy only when it cannot), instead of vanishing.
 *    BaseScene re-syncs when the atlas lands; the art level is part of sync()'s
 *    signature precisely so that re-sync is not early-returned.
 * garrisonArtLevel() below is the ONE place the desired art level is computed:
 * BaseScene derives the atlases to fetch from it and this layer keys sprites
 * from it, so the two cannot disagree about which texture a garrison needs.
 * patrol.test.ts pins the gate from both sides.
 */
import { AMBIENCE, artTierOfLevel, atlasGroupFor, LEVELED_TROOPS } from '@shardkeep/shared';
import type Phaser from 'phaser';
import type { AnimTicker } from '../anim';
import { facing, firstMoveFrame, walkSeq, type Dir } from '../anim';
import { atlasFor } from '../scenes/BootScene';
import {
  clipFrames, clipKey, facingRow,
  type Facing8, type V2Clip, type V2ClipMap,
} from '../v2/clips';
import type { V2Phase, V2Ticker } from '../v2/ticker';
import {
  requiredV2FallbackLocomotionAtlasGroups, v2FallbackDirectionalStandSpec,
  v2FallbackSpec, v2TroopDrawScale, v2TroopProfile,
} from '../v2/troop';
import { actorDepth } from './depth';
import type { Occupancy, Pt } from './occupancy';

interface PatrolBuilding { id: string; type: string; tx: number; ty: number; underConstruction: boolean }
export interface PatrolHeroState {
  hero: 'vex' | 'theodor'; recoveryUntil: string | null; available: boolean;
}

/** Which hero each recruitment building fields (HEROES MVP — mirrors the old
 *  dais idler in ambience.ts). */
const HERO_BY_BUILDING: Record<string, 'vex' | 'theo'> = { heroaltar: 'vex', siegestool: 'theo' };

/** Per-hero animation frame COUNTS — atlas facts (apps/web/public/atlas/
 *  hero@1x.json ships vex with 4 walk / 4 idle frames, theo with 8 / 6), not
 *  game numbers, so they live with the render code that consumes them. */
/**
 * How decisively the other axis must lead before a walker changes facing.
 * 0.85 = the new axis must beat the current one by ~15%. A render tunable (it
 * shapes an animation, not a game rule), so it lives here rather than in
 * shared constants. Too low and diagonal legs flap; too high and real turns
 * lag visibly behind the movement.
 */
const FACING_HYSTERESIS = 0.85;

const HERO_FRAMES: Record<'vex' | 'theo', { walk: number; idle: number }> = {
  vex: { walk: 4, idle: 4 },
  theo: { walk: 8, idle: 6 },
};

/** Troops with real per-level art — from the shared grouping module, so this
 *  layer, the packer and the on-demand loader cannot disagree about who has
 *  `_l<N>_` keys. */
const LEVELED = new Set<string>(LEVELED_TROOPS);

/* ── Rework-v2 garrison art (Phase D) ──────────────────────────────────────
 * When BaseScene GRANTS a v2 tier (server level present AND every locomotion
 * atlas registered — the same want/grant gate as garrisonArtLevel), a walker
 * renders its v2 grid frames instead of the legacy/batch-13 masters. Verbs,
 * frame counts, row order and the trp/bld key root all come from the shared
 * visual profile + packed V2ClipMap; a missing profile or clip therefore
 * fails closed to legacy art instead of fabricating a frame. The patrol keeps
 * its 3-direction + flip facing model —
 * v2 ships real west rows, so 'e'+flip maps to row w and the flip is cleared
 * (a mirrored east row would put the club in the wrong hand); the full 8-way
 * facing lives in the battle scene, where headings actually vary. Cadence
 * rides the ONE shared 260ms AnimTicker like every other base walker (layer
 * law above) — the authored fps plays in battle on the per-clip V2Ticker.
 */
/**
 * Draw scale for a garrison walker. Legacy art is @2x, so AMBIENCE.garrisonScale
 * lands it at 0.66 of native; the v2 pack is @1x (clips.ts V2_DRAW_SCALE
 * explains why), so a v2 walker is the retunable garrison scale times
 * `v2TroopDrawScale` — the pack conversion times that root's PUBLISHED world
 * fit. Every per-unit correction, Mage's included, travels through that one
 * helper, so the rich body, the eager current-art fallback and this base
 * walker cannot disagree about how big a unit is. Exported for the tests.
 */
export function garrisonScaleFor(troop: string, v2Tier: number | null): number {
  return v2Tier !== null
    ? AMBIENCE.garrisonScale * v2TroopDrawScale(troop)
    : AMBIENCE.garrisonScale;
}

/** v2 frame sequence for a walker (exported for the patrol tests). */
export function v2WalkerSeq(
  clips: V2ClipMap,
  troop: string,
  tier: number,
  state: 'move' | 'stand',
  dir: Dir,
  flipped: boolean,
): string[] {
  const profile = v2TroopProfile(troop);
  if (!profile) return [];
  const verb = state === 'move' ? profile.move : profile.stand;
  const base = clipKey(profile.kind, troop, tier, verb);
  const clip = clips[base];
  if (!clip) return [];
  const facing: Facing8 = dir === 'e' && flipped ? 'w' : dir;
  return clipFrames(base, clip, facingRow(clip, facing));
}

/**
 * The full V2Ticker play spec for a walker's move cycle — the frames PLUS the
 * cadence the pack authored them at. Exported for the patrol tests.
 *
 * `fps`/`loop` are published per clip in the packed metadata, so routing the
 * base patrol through this adds NO game number: it stops the base guessing a
 * cadence the art was never drawn for. Missing metadata returns null and the
 * caller keeps the legacy path, exactly as v2WalkerSeq already fails closed.
 */
export function v2WalkerPlay(
  clips: V2ClipMap,
  troop: string,
  tier: number,
  dir: Dir,
  flipped: boolean,
): { atlas: string; base: string; seq: string[]; fps: number; loop: boolean } | null {
  const profile = v2TroopProfile(troop);
  if (!profile) return null;
  const base = clipKey(profile.kind, troop, tier, profile.move);
  const clip: V2Clip | undefined = clips[base];
  if (!clip) return null;
  const seq = v2WalkerSeq(clips, troop, tier, 'move', dir, flipped);
  const first = seq[0];
  if (!first) return null;
  return {
    atlas: atlasGroupFor(first),
    base,
    seq,
    // A locomotion clip the pack forgot to publish an fps for would otherwise
    // be handed 0 and held STATIC by V2Ticker — a sliding walker with frozen
    // legs. 10fps is the pack's own locomotion cadence (every published walk /
    // run / prowl clip in the atlas is 10 or 12).
    fps: clip.fps && clip.fps > 0 ? clip.fps : 10,
    loop: clip.loop ?? true,
  };
}

/** Authored feet anchor of the move clip, expressed as Phaser origin ratios. */
export function v2WalkerOrigin(
  clips: V2ClipMap,
  troop: string,
  tier: number,
): readonly [number, number] | null {
  const profile = v2TroopProfile(troop);
  if (!profile) return null;
  const clip = clips[clipKey(profile.kind, troop, tier, profile.move)];
  const anchor = clip?.anchorPx;
  if (!clip || !anchor || clip.cellW <= 0 || clip.cellH <= 0
    || !Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) return null;
  return [anchor[0] / clip.cellW, anchor[1] / clip.cellH];
}

/**
 * Atlas groups a base-view walker needs. Active/spawned v2 roots request only
 * their compact movement group plus one authored stand pose per heading. The
 * historical derivation remains a fail-closed compatibility path for any profile
 * outside that explicit table. This is the ONE derivation used by BaseScene's
 * load and grant sides. In particular,
 * Direwyvern's split firestorm group is battle-only and cannot leak into base;
 * Hexbarrow routes through its authored `bld` key root. An incomplete
 * metadata pair returns no groups, making legacy the safe path.
 */
export function requiredV2PatrolAtlasGroups(
  clips: V2ClipMap,
  troop: string,
  tier: number,
): string[] {
  const profile = v2TroopProfile(troop);
  if (!profile || v2WalkerOrigin(clips, troop, tier) === null) return [];
  const compact = requiredV2FallbackLocomotionAtlasGroups(clips, troop, tier);
  if (compact.length > 0) return compact;
  const groups: string[] = [];
  for (const verb of new Set([profile.move, profile.stand])) {
    const base = clipKey(profile.kind, troop, tier, verb);
    const clip = clips[base];
    if (!clip) return [];
    const first = clipFrames(base, clip, 0)[0];
    if (!first) return [];
    groups.push(atlasGroupFor(first));
  }
  return [...new Set(groups)];
}

/** Levels of per-level art batch 13 shipped. An ATLAS bound, not a game number
 *  (anim.ts and BattleScene clamp the same way for the same reason): a troop
 *  levelled past the art renders the top tier, and the clamp is what stops
 *  BaseScene FETCHING a `trpdg_l21` that was never packed. */
const TROOP_ART_LEVELS = 20;

/**
 * The art level a garrison troop WANTS: the server's level, clamped to the
 * shipped art — or null for the legacy level-agnostic masters (no level sent,
 * non-finite level, or a troop with no per-level art). Exported because
 * BaseScene computes the atlases to fetch from this same rule; a second copy
 * of it would let the fetch set and the render keys drift apart. NOTE this is
 * the want, not the grant — sync() still gates every use on the level's atlas
 * being registered (see ART LEVEL in the header).
 */
export function garrisonArtLevel(troop: string, level: number | undefined): number | null {
  if (level === undefined || !Number.isFinite(level) || !LEVELED.has(troop)) return null;
  return Math.min(TROOP_ART_LEVELS, Math.max(1, Math.trunc(level)));
}

interface Walker {
  sprite: Phaser.GameObjects.Sprite;
  /** Stable identity across a sync (camp+slot+troop, or hero building). A walker
   *  whose key survives is REUSED mid-stride instead of being destroyed and
   *  respawned — see sync(). */
  key: string;
  /** garrison units use troop walk frames; the hero uses hero_<k>_* frames. */
  troop: string | null;
  /** The ART level this walker's frames are keyed at, or null for the legacy
   *  masters. Fixed at spawn (it is in the walker's key): granting a level
   *  means a different atlas, i.e. a legitimate respawn via sync(). */
  level: number | null;
  /** GRANTED rework-v2 art tier, or null. Fixed at spawn, in the key, and it
   *  outranks `level`: a v2 walker never asks a batch-13 frame. */
  v2Tier: number | null;
  /** Eager current-art stand alias while the full animation atlas is absent. */
  fallbackTier: number | null;
  hero: 'vex' | 'theo' | null;
  speed: number;
  /** current / destination feet position in world px */
  x: number; y: number;
  tx: number; ty: number;
  /** waypoints AFTER the current leg target — the bends of an L-route around a
   *  building. Reaching a bend is not an arrival: no pause, keep walking. */
  path: Pt[];
  /** ms remaining of the pause at a stop; 0 = walking */
  pauseLeft: number;
  dir: Dir;
  /**
   * Is this walker facing WEST? For legacy art `dir:'e'` + `west` is drawn by
   * mirroring the east frames; the v2 pack ships a real west row instead, so
   * `west` picks V2_ROW_WEST and the sprite's flipX is cleared.
   *
   * Kept on the WALKER, never read back off `sprite.flipX`: the v2 walk/stand
   * branches clear the flag on the sprite (a mirrored east row would put the
   * club in the wrong hand), so the sprite stops being a record of anything.
   * Reading it back made V2_ROW_WEST unreachable from stand() — the arrival and
   * blocked branches call stand() without touching facing, so a west-walking
   * giant snapped to the EAST idle row — and made a hysteresis-held diagonal
   * leg play the east walk row while moving west (the dizzy-shuffle family).
   */
  west: boolean;
  /** waypoint pool: the garrison's camp ring, or the hero's door loop. */
  stops: Array<{ x: number; y: number }>;
  /** hero only: cursor into `stops` so the patrol LOOPS the base in order
   *  instead of dithering door-to-door like a villager. */
  routeI: number;
  /** hero only: the altar dais, for the occasional return home. */
  home: { x: number; y: number } | null;
  rnd: () => number;
  /** Last applied render state; movement frames never rebuild an unchanged clip. */
  motionSignature: string;
  houseWalkPhase: number | null;
  v2WalkPhase: V2Phase | null;
}

/** Same tiny deterministic LCG as villagers.ts — no Math.random in a layer that
 *  must replay identically per base. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0x100000000; };
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The units ONE camp shows, capped at garrisonMaxPerCamp.
 *
 * The army is dealt ACROSS the camps, not handed to each of them (owner
 * 2026-07-28: garrison "should be moving around only army camp"). Giving every
 * camp the same roster meant a base with N camps drew N× the army — and on a
 * base whose camps share a tile that is one churning pile of identical sprites
 * on one patch of ground. Dealing means the garrison you SEE is the army you
 * OWN, split between the camps that house it.
 *
 * The roster is interleaved by troop first (a…b…c, a…b…c) so each camp's slice
 * is a mixed one rather than six of whichever troop sorts first. Empty army →
 * empty camp (train units and they appear — #56).
 */
function garrisonUnits(
  army: ReadonlyArray<{ troop: string; count: number }>,
  campIndex: number,
  campCount: number,
): string[] {
  const left = army.filter((a) => a.count > 0).map((a) => ({ troop: a.troop, n: a.count }));
  const roster: string[] = [];
  while (left.some((r) => r.n > 0)) {
    for (const r of left) { if (r.n > 0) { roster.push(r.troop); r.n--; } }
  }
  const mine = roster.filter((_, i) => i % Math.max(1, campCount) === campIndex);
  return mine.slice(0, AMBIENCE.garrisonMaxPerCamp);
}

/**
 * Unique troop types the patrol can actually draw, in first-spawn order.
 * This deliberately delegates to garrisonUnits so atlas demand follows the
 * exact same interleave, deal and per-camp cap as rendering. Troops beyond the
 * visible cap must not make BaseScene fetch atlases no sprite can reference.
 */
export function visibleGarrisonTroops(
  army: ReadonlyArray<{ troop: string; count: number }>,
  campCount: number,
): string[] {
  if (campCount <= 0) return [];
  const visible: string[] = [];
  const seen = new Set<string>();
  for (let campIndex = 0; campIndex < campCount; campIndex++) {
    for (const troop of garrisonUnits(army, campIndex, campCount)) {
      if (seen.has(troop)) continue;
      seen.add(troop);
      visible.push(troop);
    }
  }
  return visible;
}

export class PatrolLayer {
  private walkers: Walker[] = [];
  private signature = '';
  /** true while reduceMotion holds everyone stood-down (so we stand them ONCE,
   *  not every frame). */
  private frozen = false;

  constructor(
    private scene: Phaser.Scene,
    /** House 260ms clock — legacy `trp_*` and `hero_*` masters only. */
    private ticker: AnimTicker,
    /** Per-clip clock for the v2/game-v4 sheets, at their authored fps. The
     *  SAME instance BaseScene hands JobLayer, so the builder and the garrison
     *  he walks past cannot run on two different clocks. */
    private v2Ticker: V2Ticker,
    /** world px per tile (64) */
    private T: number,
    /** shared blocked-tile grid, rebuilt by BaseScene from the live town. */
    private occ: Occupancy,
    /** Packed visual truth. Missing locomotion metadata keeps legacy art. */
    private v2clips: V2ClipMap = {},
  ) {}

  /**
   * Rebuild the walker set from live store state. Cheap on every base:refresh —
   * early-returns unless the shape actually changed (camps / hero buildings /
   * army mix / door layout), so walkers keep strolling across a refresh instead
   * of teleporting back to spawn. Any building MOVE is in the signature: stale
   * waypoints would send walkers to where a building used to be.
   *
   * TWO defences against a re-sync resetting a walk mid-stride (owner
   * 2026-07-28 "the hero is frozen"), because the base DOES re-fetch on a timer
   * and after every action:
   *  - the signature is ORDER-INSENSITIVE (sorted keys). The server's building
   *    and army queries carry no ORDER BY, so the same base can come back with
   *    its rows shuffled; an order-sensitive signature flipped on that alone and
   *    tore the layer down. Since each walker's LCG is seeded from constants, a
   *    teardown put everyone back on their exact spawn pixel with their exact
   *    first pause — a refresh cadence faster than that pause pins them there
   *    forever, which is what "frozen on the dais" actually was;
   *  - even on a REAL change, walkers are matched by key and CARRIED OVER with
   *    their position, target and pause intact (the villagers.ts pooling idea).
   *    Only the delta is spawned/destroyed, so building one wall no longer
   *    teleports the whole garrison home.
   * The scale constants are in the signature too: scale is applied at spawn, so
   * without them an HMR retune would leave old-size sprites on screen forever.
   */
  sync(
    buildings: ReadonlyArray<PatrolBuilding>,
    footprintOf: (b: PatrolBuilding) => { fw: number; fh: number },
    /** the player's trained army (troop → count, optional server level) — fills
     *  the camps (#56). Absent level = legacy art (see ART LEVEL). */
    army: ReadonlyArray<{ troop: string; count: number; level?: number }>,
    /** hero routes are seeded per wallet+building so a player's patrol is theirs. */
    seedText: string,
    /** Is this level's `trpdg_l<N>` atlas registered and drawable? (BaseScene
     *  passes world/atlasLoader's isTroopLevelAtlasLoaded.) The gate that keeps
     *  an in-flight or failed load rendering legacy art instead of nothing. */
    isLevelArtLoaded: (level: number) => boolean,
    /** Rework-v2 grant: the GRANTED full-animation v2 art tier (atlas loaded),
     *  or null = eager current-art fallback when supported. Optional so older callers/tests are
     *  unchanged; when granted it outranks the batch-13 level — the rework
     *  fully replaces that troop's older art. */
    v2TierOf?: (troop: string, level: number | undefined) => number | null,
    /** Server-authoritative home availability. Omitted by older callers/tests,
     * which preserves their historical completed-altar behavior. */
    heroes?: ReadonlyArray<PatrolHeroState>,
    _nowMs = Date.now(),
  ): void {
    const T = this.T;
    const byId = (a: PatrolBuilding, b: PatrolBuilding): number => (a.id < b.id ? -1 : 1);
    const done = buildings.filter((b) => !b.underConstruction);
    const camps = done.filter((b) => b.type === 'camp').sort(byId);
    const heroBlds = done.filter((b) => {
      const hero = HERO_BY_BUILDING[b.type];
      if (hero === undefined) return false;
      if (heroes === undefined) return true;
      const key = hero === 'theo' ? 'theodor' : hero;
      return heroes.some((state) => state.hero === key && state.available);
    }).sort(byId);

    // Hero waypoints = building doors (bottom-centre), the villagers.ts idea —
    // the patrol traces the town the player built, not open grass. Walls are NOT
    // stops: a walled base is mostly wall segments, and routing through 40-odd of
    // them turned the patrol into a shuffle between points a few px apart.
    // A door sits on its building's BOTTOM EDGE, i.e. in the tile row below the
    // footprint — free ground on any sane base. Where it is not (a wall hugging
    // the south face), the stop is pushed to the nearest free tile instead of
    // being a standing order to walk into the wall.
    const doors = done
      .filter((b) => b.type !== 'wall')
      .map((b) => {
        const fp = footprintOf(b);
        return this.occ.nearestFree({ x: (b.tx + fp.fw / 2) * T, y: (b.ty + fp.fh) * T });
      })
      .filter((d): d is Pt => d !== null);

    // The art level each troop's walkers must be keyed at RIGHT NOW: the want
    // (garrisonArtLevel) granted only once its atlas is drawable, else null =
    // the legacy masters. Computed before the signature because it is PART of
    // the signature: when BaseScene re-syncs after the atlas lands, this — and
    // only this — is what changed, and an early-return here would leave the
    // garrison on legacy art forever.
    const artOf = new Map<string, number | null>();
    const v2Of = new Map<string, number | null>();
    const fallbackOf = new Map<string, number | null>();
    for (const a of army) {
      const want = garrisonArtLevel(a.troop, a.level);
      artOf.set(a.troop, want !== null && isLevelArtLoaded(want) ? want : null);
      const granted = v2TierOf?.(a.troop, a.level) ?? null;
      v2Of.set(
        a.troop,
        granted !== null && requiredV2PatrolAtlasGroups(this.v2clips, a.troop, granted).length > 0
          ? granted
          : null,
      );
      const tier = a.level !== undefined && Number.isFinite(a.level) ? artTierOfLevel(a.level) : null;
      fallbackOf.set(a.troop, tier !== null && v2FallbackSpec(this.v2clips, a.troop, tier) ? tier : null);
    }

    const sig = [
      camps.map((c) => `${c.id}@${c.tx},${c.ty}`).join(','),
      army.filter((a) => a.count > 0)
        .map((a) => `${a.troop}=${a.count}:l${artOf.get(a.troop) ?? 0}:v${v2Of.get(a.troop) ?? 0}:f${fallbackOf.get(a.troop) ?? 0}`)
        .sort().join(','),
      heroBlds.map((h) => `${h.id}@${h.tx},${h.ty}`).join(','),
      heroes?.map((hero) => `${hero.hero}:${hero.recoveryUntil ?? 'ready'}`).sort().join(',') ?? 'legacy-heroes',
      hash(doors.map((d) => `${d.x},${d.y}`).sort().join(';')),
      `${AMBIENCE.garrisonScale}/${AMBIENCE.heroPatrolScale}`,
      // Occupancy changes move waypoints (a new wall can invalidate a whole
      // ring), so a re-route must happen — but ONLY on a real change, or the
      // layer would tear down on every refresh (see the frozen-hero note above).
      `occ${this.occ.version}`,
    ].join('|');
    if (sig === this.signature) return;
    this.signature = sig;

    // Carry survivors over by key; whatever is left in `prev` genuinely vanished.
    const prev = new Map(this.walkers.map((w) => [w.key, w]));
    this.walkers = [];
    camps.forEach((camp, i) => this.spawnGarrison(camp, footprintOf(camp), army, i, camps.length, prev, artOf, v2Of, fallbackOf));
    for (const b of heroBlds) this.spawnHero(b, footprintOf(b), doors, seedText, prev);
    for (const w of prev.values()) { this.release(w); w.sprite.destroy(); }
  }

  /** Advance every walker. `dtMs` is real elapsed time (framerate-independent). */
  update(dtMs: number, reduceMotion: boolean): void {
    if (reduceMotion) {
      // Frozen but dressed — and stood down ONCE, or walk cycles left registered
      // on the ticker would march everyone in place (the villagers.ts bug).
      if (!this.frozen) { this.frozen = true; for (const w of this.walkers) this.stand(w); }
      return;
    }
    this.frozen = false;
    for (const w of this.walkers) {
      if (w.pauseLeft > 0) { w.pauseLeft -= dtMs; continue; }
      // An eager current-art fallback is a truthful STAND pose, not a walk
      // cycle. Translating it made dragons and troops glide as static cut-outs
      // while their compact locomotion atlas loaded (or after a failed fetch).
      // Hold position until BaseScene adopts the real tier and re-syncs.
      if (!w.hero && w.v2Tier === null && w.fallbackTier !== null) {
        this.stand(w);
        w.pauseLeft = AMBIENCE.garrisonPauseMinMs;
        continue;
      }
      const step = (w.speed * dtMs) / 1000;
      // Every step is filtered through occupancy: a leg is pre-routed clear, but
      // this is the backstop that makes "never inside a building" a property of
      // the movement itself rather than of the routing being perfect.
      const next = this.occ.advance(w.x, w.y, w.tx, w.ty, step);
      const dx = next.x - w.x;
      const dy = next.y - w.y;
      w.x = next.x; w.y = next.y;
      if (!next.moved) {
        // Boxed in mid-leg (a wall went up across it). Stand the shortest pause
        // and re-route rather than grinding into the corner.
        w.pauseLeft = w.hero ? AMBIENCE.heroPatrolPauseMinMs : AMBIENCE.garrisonPauseMinMs;
        this.stand(w);
        this.retarget(w);
      } else if (w.x === w.tx && w.y === w.ty) {
        const bend = w.path.shift();
        if (bend) {
          w.tx = bend.x; w.ty = bend.y; // a bend is not a stop — keep walking
          this.faceLeg(w);              // ...but it IS a new leg, so re-face once
        } else {
          const [min, max] = w.hero
            ? [AMBIENCE.heroPatrolPauseMinMs, AMBIENCE.heroPatrolPauseMaxMs]
            : [AMBIENCE.garrisonPauseMinMs, AMBIENCE.garrisonPauseMaxMs];
          w.pauseLeft = min + w.rnd() * (max - min);
          this.stand(w); // arriving = stop the legs (garrison pins, hero idles)
          this.retarget(w);
        }
      } else {
        // FACING HYSTERESIS. facing() switches the instant |dx| and |dy| cross,
        // so a leg travelling near-diagonally flaps between 'e' and 's' every
        // frame as sub-pixel movement changes which is larger — and each flap
        // re-registers the walk cycle. Hold the current facing until the other
        // axis leads by a clear margin, so a genuine turn still snaps promptly
        // while a diagonal walk keeps one facing. Ratio, not pixels: it has to
        // hold at every zoom and step size.
        // FACING IS A PROPERTY OF THE LEG, decided once in setLeg().
        //
        // It used to be recomputed every frame from `dx`/`dy`, and that is the
        // flicker the owner reported on 2026-08-30 ("swaps between two
        // different pictures", "frame switching very fast ... dribbling").
        // occupancy.advance() does NOT always move along the true vector: when
        // the diagonal step is blocked it falls back to a PURE AXIS step, so a
        // walker sliding along a wall emits (step,0) then (0,step) on alternate
        // frames. That makes `sub` 0, and the hysteresis guard that exists to
        // stop flapping passes trivially because 0 <= anything. The facing then
        // flipped every frame and V2Ticker.play's phase-preserving row swap
        // faithfully repainted the sprite in the other facing each time.
        //
        // Recomputing from `target - position` does NOT fix it either: the
        // position itself stair-steps, so the residual vector tilts each way on
        // alternate frames. Only the leg is stable, so only the leg may decide.
        this.walk(w);
      }
      // WORLD_DEPTH.actor: a walker is never occluded by a building, a wall or
      // an altar, at any Y — which retired both the +3 bias AND the dais
      // exception that used to force a hero standing on the altar's own base
      // line above the altar sprite and its ambience pulse copy. Feet Y still
      // sorts walkers against each other. Depth is written only when it
      // changed: Phaser's setter queues a display-list sort on every write.
      const depth = actorDepth(w.y);
      w.sprite.setPosition(w.x, w.y);
      if (w.sprite.depth !== depth) w.sprite.setDepth(depth);
    }
  }

  destroy(): void {
    this.clear();
    // A suspended base rebuilds the patrol from the same store snapshot on
    // wake. Clearing the signature ensures that identical snapshot is not
    // mistaken for an already-rendered walker set.
    this.signature = '';
  }

  // -- internals ------------------------------------------------------------

  /** One camp's units, each wandering its own ring of points around the camp
   *  footprint (corners + edge midpoints, pushed out by garrisonWanderPadTiles). */
  private spawnGarrison(
    camp: PatrolBuilding,
    fp: { fw: number; fh: number },
    army: ReadonlyArray<{ troop: string; count: number }>,
    campIndex: number,
    campCount: number,
    prev: Map<string, Walker>,
    /** troop → GRANTED art level (atlas loaded) or null = legacy — see sync(). */
    artOf: ReadonlyMap<string, number | null>,
    /** troop → GRANTED rework-v2 tier (atlas loaded) or null — outranks artOf. */
    v2Of: ReadonlyMap<string, number | null>,
    fallbackOf: ReadonlyMap<string, number | null>,
  ): void {
    const T = this.T;
    const pad = AMBIENCE.garrisonWanderPadTiles * T;
    const x0 = camp.tx * T - pad;
    const x1 = (camp.tx + fp.fw) * T + pad;
    const y0 = camp.ty * T - pad;
    const y1 = (camp.ty + fp.fh) * T + pad;
    const xm = (x0 + x1) / 2;
    const ym = (y0 + y1) / 2;
    // The ring lies just OUTSIDE the camp's own footprint, so it is free ground
    // by construction — but a neighbouring building or a wall can still sit on
    // one of its points, so each is pulled to the nearest free tile (and dropped
    // if it is walled in). Two points that land on the SAME spot are deduped:
    // an arrival is a full pause, so a zero-length leg is a guard standing still
    // pretending to patrol.
    const seen = new Set<string>();
    const ring = [
      { x: x0, y: y0 }, { x: xm, y: y0 }, { x: x1, y: y0 },
      { x: x1, y: ym }, { x: x1, y: y1 }, { x: xm, y: y1 },
      { x: x0, y: y1 }, { x: x0, y: ym },
    ]
      .map((p) => this.occ.nearestFree(p))
      .filter((p): p is Pt => p !== null)
      .filter((p) => { const k = `${p.x},${p.y}`; if (seen.has(k)) return false; seen.add(k); return true; });
    if (ring.length === 0) return; // camp sealed in — no room to muster
    garrisonUnits(army, campIndex, campCount).forEach((troop, i) => {
      const level = artOf.get(troop) ?? null;
      const v2Tier = v2Of.get(troop) ?? null;
      const fallbackTier = v2Tier === null ? fallbackOf.get(troop) ?? null : null;
      const fallback = fallbackTier !== null ? v2FallbackSpec(this.v2clips, troop, fallbackTier) : null;
      const v2Origin = v2Tier !== null ? v2WalkerOrigin(this.v2clips, troop, v2Tier) : fallback?.origin ?? null;
      // Slot identity survives a re-sync: same camp, same slot, same troop → the
      // same walker, still mid-stride. The troop is IN the key because a changed
      // army mix means this slot needs different art, i.e. a real respawn — and
      // the ART level is in it for the same reason: a granted (or upgraded)
      // level swaps every frame this walker will ever ask for. Same again for
      // the v2 tier.
      const key = `g:${camp.id}:${i}:${troop}:l${level ?? 0}:v${v2Tier ?? 0}:f${fallbackTier ?? 0}`;
      const kept = prev.get(key);
      if (kept) {
        prev.delete(key);
        kept.stops = ring;
        kept.speed = AMBIENCE.garrisonSpeedPxPerSec;
        kept.sprite.setOrigin(v2Origin?.[0] ?? 0.5, v2Origin?.[1] ?? 1);
        kept.sprite.setScale(garrisonScaleFor(troop, v2Tier ?? fallbackTier)); // picks up a live retune
        // The camp may have MOVED: a target off the new ring would march this
        // unit across the base to where its camp used to be. A unit standing
        // where a building has just gone up is evicted to free ground first.
        this.settle(kept);
        if (!ring.some((s) => s.x === kept.tx && s.y === kept.ty)) this.retarget(kept);
        this.walkers.push(kept);
        return;
      }
      // Seeded per camp+slot: each unit owns its stream, so the whole camp's
      // choreography is reproducible and units never sync-step.
      const rnd = lcg(hash(`${camp.id}:${i}`));
      const at = ring[Math.floor(rnd() * ring.length)]!;
      // fly_-locomotion troops have no walk_ frames — anim.ts resolves (and the
      // answer differs by level: an unlevelled dragon walks, a levelled one flies).
      // `level` is null unless sync() granted it — see ART LEVEL in the header.
      // A GRANTED v2 tier outranks both key families entirely.
      const first = v2Tier !== null
        ? v2WalkerSeq(this.v2clips, troop, v2Tier, 'move', 's', false)[0]!
        : (fallback?.frame ?? firstMoveFrame(troop, 's', level ?? undefined));
      const sp = this.scene.add.sprite(at.x, at.y, atlasFor(first), first)
        .setOrigin(v2Origin?.[0] ?? 0.5, v2Origin?.[1] ?? 1)
        .setScale(garrisonScaleFor(troop, v2Tier ?? fallbackTier))
        .setDepth(actorDepth(at.y));
      const w: Walker = {
        sprite: sp, key, troop, level, v2Tier, fallbackTier, hero: null, speed: AMBIENCE.garrisonSpeedPxPerSec,
        x: at.x, y: at.y, tx: at.x, ty: at.y, path: [],
        // start mid-pause, staggered, so the camp never moves as one body …
        pauseLeft: rnd() * AMBIENCE.garrisonPauseMaxMs,
        dir: 's', west: false, stops: ring, routeI: 0, home: null, rnd,
        motionSignature: '', houseWalkPhase: null, v2WalkPhase: null,
      };
      // … which means they must START stood down (spawning registered on the
      // walk cycle marched villagers in place until their first step).
      this.stand(w);
      this.retarget(w);
      this.walkers.push(w);
    });
  }

  /** The hero, starting on their altar's dais, patrolling the door loop. */
  private spawnHero(
    b: PatrolBuilding,
    fp: { fw: number; fh: number },
    doors: Array<{ x: number; y: number }>,
    seedText: string,
    prev: Map<string, Walker>,
  ): void {
    const T = this.T;
    const hero = HERO_BY_BUILDING[b.type]!;
    // Dais point. It USED to sit 12px above the altar's bottom edge (ambience.ts's
    // old idler anchor), i.e. with the hero's feet INSIDE the altar's own last
    // tile row — the one authored exception to "never stand in a building", and
    // one the owner's 2026-07-29 report reads as the same bug as the rest. Moved
    // onto the altar's base line: free ground, no exemption in the collision
    // code, and at 64px/tile a 12px shift is imperceptible — the hero still
    // stands against the altar face. nearestFree covers a wall built on it.
    const home = this.occ.nearestFree({ x: (b.tx + fp.fw / 2) * T, y: (b.ty + fp.fh) * T })
      ?? { x: (b.tx + fp.fw / 2) * T, y: (b.ty + fp.fh) * T };
    // A PATROL is a loop, not a drunkard's walk: order the doors by angle
    // around the town centroid so the hero circles the base.
    let cx = 0, cy = 0;
    for (const d of doors) { cx += d.x; cy += d.y; }
    cx /= doors.length || 1; cy /= doors.length || 1;
    const route = doors.slice().sort(
      (a, z) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(z.y - cy, z.x - cx),
    );
    const key = `h:${b.id}`;
    const kept = prev.get(key);
    if (kept) {
      prev.delete(key);
      kept.stops = route;
      kept.home = home;
      kept.routeI = route.length > 0 ? kept.routeI % route.length : 0;
      kept.speed = AMBIENCE.heroPatrolSpeedPxPerSec;
      kept.sprite.setScale(AMBIENCE.heroPatrolScale); // picks up a live retune
      this.settle(kept); // a building may have gone up on the hero's own tile
      const stale = (kept.tx !== home.x && kept.ty !== home.y
        && !route.some((p) => p.x === kept.tx && p.y === kept.ty))
        // …or the leg it is walking now crosses something new (kept.path holds
        // the bends of a route computed against the PREVIOUS occupancy).
        || !this.occ.clearLine(kept.x, kept.y, kept.tx, kept.ty);
      if (stale) this.retarget(kept); // the building it was walking to is gone/moved
      this.walkers.push(kept);
      return;
    }
    const rnd = lcg(hash(`${seedText}:${b.id}`));
    const first = `hero_${hero}_idle_f1`;
    const sp = this.scene.add.sprite(home.x, home.y, atlasFor(first), first)
      .setOrigin(0.5, 1)
      .setScale(AMBIENCE.heroPatrolScale)
      .setDepth(actorDepth(home.y)); // the actor band already clears the altar art
    const w: Walker = {
      sprite: sp, key, troop: null, level: null, v2Tier: null, fallbackTier: null, hero, speed: AMBIENCE.heroPatrolSpeedPxPerSec,
      x: home.x, y: home.y, tx: home.x, ty: home.y, path: [],
      pauseLeft: rnd() * AMBIENCE.heroPatrolPauseMaxMs,
      dir: 's', west: false, stops: route, routeI: Math.floor(rnd() * (route.length || 1)),
      home, rnd, motionSignature: '', houseWalkPhase: null, v2WalkPhase: null,
    };
    this.stand(w); // dressed and idling on the dais until the first leg
    this.retarget(w);
    this.walkers.push(w);
  }

  /** Evict a walker that is standing inside a footprint (a building went up on
   *  top of it since the last sync) to the nearest free ground. A one-off
   *  teleport of a tile or two beats a soldier embedded in a wall — and it can
   *  only happen on a build, which is already a visual change. */
  private settle(w: Walker): void {
    if (this.occ.free(w.x, w.y)) return;
    const at = this.occ.nearestFree({ x: w.x, y: w.y });
    if (!at) return;
    w.x = at.x; w.y = at.y;
    w.sprite.setPosition(at.x, at.y);
    w.path = [];
    w.tx = at.x; w.ty = at.y;
  }

  /** Commit a routed leg: first waypoint becomes the target, the rest are bends. */
  private setLeg(w: Walker, route: Pt[]): void {
    const first = route[0]!;
    w.tx = first.x; w.ty = first.y;
    w.path = route.slice(1);
    this.faceLeg(w);
  }

  /** Point the walker down its CURRENT leg. Called wherever a target is set --
   *  setLeg() and the mid-leg bend -- and never per frame: see the note in
   *  update() for why a per-frame facing flaps against a wall. */
  private faceLeg(w: Walker): void {
    const f = facing(w.tx - w.x, w.ty - w.y);
    w.dir = f.dir;
    // `west` is walker state, like `dir`: walk()/stand() clear the sprite's
    // flipX on the v2 path, so the sprite can't be the record (see Walker).
    w.west = f.flip;
    w.sprite.setFlipX(f.flip);
  }

  /** Nowhere reachable: stand where you are and try again after the pause. */
  private hold(w: Walker): void {
    w.tx = w.x; w.ty = w.y; w.path = [];
  }

  /** Pick the next waypoint. Garrison: any other ring point. Hero: the next
   *  door on the loop, with an occasional detour home to the dais (the route
   *  cursor is untouched, so the patrol resumes where it left off).
   *  Every candidate is ROUTED (straight line or one bend) before it is
   *  accepted; an unreachable stop is skipped, never walked through. */
  private retarget(w: Walker): void {
    if (w.hero) {
      // The dais roll is skipped when the hero is ALREADY home — it used to
      // "travel" to its own position, burn a full pause and re-roll, which is
      // how a patrolling hero read as parked on the altar (owner 2026-07-28).
      const atHome = w.home !== null
        && Math.abs(w.x - w.home.x) + Math.abs(w.y - w.home.y) < 1;
      if (w.home && !atHome && w.rnd() * 100 < AMBIENCE.heroAltarReturnPct) {
        const back = this.occ.route(w.x, w.y, w.home);
        if (back) { this.setLeg(w, back); return; }
        // unreachable dais → fall through to the door loop rather than stall
      }
      if (w.stops.length === 0) { this.hold(w); return; } // altar-only base: stay on the dais
      // Advance to the next door far enough away to read as a WALK. Neighbouring
      // doors on a dense base can be a few px apart, and a leg that short is a
      // twitch between long pauses, not a patrol.
      const minLeg = AMBIENCE.heroPatrolMinLegTiles * this.T;
      // Pick the FARTHEST stop as the fallback: on a compact base where no stop
      // clears minLeg, the plain skip loop wrapped a full cycle back to the
      // hero's own tile — arrive instantly, burn a pause, repeat, i.e. a hero
      // parked exactly like the frozen-patrol bug this layer exists to fix
      // (verify 2026-07-29).
      let farI = w.routeI;
      let farD = -1;
      let farRoute: Pt[] | null = null;
      for (let i = 0; i < w.stops.length; i++) {
        w.routeI = (w.routeI + 1) % w.stops.length;
        const s = w.stops[w.routeI]!;
        const route = this.occ.route(w.x, w.y, s);
        if (!route) continue; // that door is behind a building from here
        const d = Math.hypot(s.x - w.x, s.y - w.y);
        if (d >= minLeg) { this.setLeg(w, route); return; }
        if (d > farD) { farD = d; farI = w.routeI; farRoute = route; }
      }
      if (farRoute) { w.routeI = farI; this.setLeg(w, farRoute); return; }
      this.hold(w); // walled in this beat; try again after the pause
      return;
    }
    // Garrison: step to a NEIGHBOURING point on the camp ring, either way round.
    // Picking any ring point at random walked units DIAGONALLY THROUGH their own
    // camp; circling the perimeter is what "moving around the army camp" looks
    // like (owner 2026-07-28), and it can never re-pick the point underfoot.
    // The index comes from the nearest stop rather than being stored, so a unit
    // carried over a re-sync onto a MOVED camp's ring still steps correctly.
    if (w.stops.length === 0) { this.hold(w); return; }
    let i = 0;
    let best = Infinity;
    for (let k = 0; k < w.stops.length; k++) {
      const s = w.stops[k]!;
      const d = Math.hypot(s.x - w.x, s.y - w.y);
      if (d < best) { best = d; i = k; }
    }
    // Keep circling in ONE direction, but skip past ring points the perimeter
    // can no longer reach (a wall built across the camp's shoulder) instead of
    // walking through them.
    const n = w.stops.length;
    const dir = w.rnd() < 0.5 ? 1 : -1;
    for (let k = 1; k <= Math.min(n - 1, AMBIENCE.walkerRouteRetries); k++) {
      const next = w.stops[(((i + dir * k) % n) + n) % n]!;
      if (next.x === w.x && next.y === w.y) continue;
      const route = this.occ.route(w.x, w.y, next);
      if (route) { this.setLeg(w, route); return; }
    }
    this.hold(w);
  }

  /** Stop the legs. Legacy garrison pins frame 1 of the current facing (those masters have no
   *  idle art); the hero swaps to their real idle cycle — the ticker animating
   *  an IDLE at a stop is presence, not the marching-in-place bug. A v2 walker
   *  keeps an authored directional stand pose without loading the full idle. */
  private stand(w: Walker): void {
    const signature = `stand:${w.hero ?? w.troop}:${w.level ?? 0}:${w.v2Tier ?? 0}:${w.fallbackTier ?? 0}:${w.dir}:${w.west}`;
    if (w.motionSignature === signature) return;
    if (w.motionSignature.startsWith('walk:')) {
      w.houseWalkPhase = this.ticker.phase(w.sprite);
      w.v2WalkPhase = this.v2Ticker.phase(w.sprite);
    }
    w.motionSignature = signature;
    if (w.hero) {
      const n = HERO_FRAMES[w.hero].idle;
      const seq = Array.from({ length: n }, (_, i) => `hero_${w.hero}_idle_f${i + 1}`);
      w.sprite.setFlipX(false); // idle masters face front; a flipped walk must not persist
      this.v2Ticker.unregister(w.sprite);
      this.ticker.register(w.sprite, atlasFor(seq[0]!), seq);
      return;
    }
    if (w.v2Tier !== null) {
      const facing: Facing8 = w.dir === 'e' && w.west ? 'w' : w.dir;
      const stand = v2FallbackDirectionalStandSpec(
        this.v2clips, w.troop!, w.v2Tier, facing,
      );
      w.sprite.setFlipX(false); // v2 ships real west rows — flip must not stack
      this.release(w);
      if (stand) w.sprite.setTexture(stand.atlas, stand.frame);
      return;
    }
    if (w.fallbackTier !== null) {
      const fallback = v2FallbackSpec(this.v2clips, w.troop!, w.fallbackTier)!;
      this.release(w);
      w.sprite.setFlipX(false).setTexture(fallback.atlas, fallback.frame);
      return;
    }
    this.release(w);
    const frame = walkSeq(w.troop!, w.dir, w.level ?? undefined)[0];
    if (frame) w.sprite.setTexture(atlasFor(frame), frame);
  }

  private walk(w: Walker): void {
    const signature = `walk:${w.hero ?? w.troop}:${w.level ?? 0}:${w.v2Tier ?? 0}:${w.fallbackTier ?? 0}:${w.dir}:${w.west}`;
    if (w.motionSignature === signature) return;
    w.motionSignature = signature;
    // Missing/incomplete clip metadata FALLS THROUGH to the compact still and
    // then to legacy (the module's fail-closed rule), rather than asserting a
    // play spec into existence and throwing inside the per-frame update loop.
    const play = !w.hero && w.v2Tier !== null
      ? v2WalkerPlay(this.v2clips, w.troop!, w.v2Tier, w.dir, w.west)
      : null;
    if (play) {
      w.sprite.setFlipX(false); // row w carries the real west art
      // The house clock must let go FIRST, or a walker that stood down on it
      // and then resumed would be driven by both and tear between frames.
      this.ticker.unregister(w.sprite);
      // V2Ticker.play carries the same phase-preserving row-swap rule
      // AnimTicker.register has, so the dizzy-shuffle guard survives the move.
      this.v2Ticker.play(w.sprite, play, w.v2WalkPhase);
      w.v2WalkPhase = null;
      w.houseWalkPhase = null;
      return;
    }
    if (!w.hero && w.fallbackTier !== null) {
      // The eager single-frame fallback still: no cadence to play, so it comes
      // off both clocks rather than only the one it happened to be on.
      const fallback = v2FallbackSpec(this.v2clips, w.troop!, w.fallbackTier)!;
      this.release(w);
      w.sprite.setFlipX(false).setTexture(fallback.atlas, fallback.frame);
      return;
    }
    const seq = w.hero
      ? Array.from(
          { length: HERO_FRAMES[w.hero].walk },
          (_, i) => `hero_${w.hero}_walk_${w.dir}_f${i + 1}`,
        )
      : walkSeq(w.troop!, w.dir, w.level ?? undefined);
    this.v2Ticker.unregister(w.sprite);
    if (seq[0]) this.ticker.register(w.sprite, atlasFor(seq[0]), seq, w.houseWalkPhase ?? 0);
    w.houseWalkPhase = null;
    w.v2WalkPhase = null;
  }

  /** Drop a walker from BOTH clocks. Every stand-down goes through here: a
   *  sprite left registered on either ticker marches in place (the villagers.ts
   *  bug), and one left on the clock it is no longer driven by tears frames. */
  private release(w: Walker): void {
    this.ticker.unregister(w.sprite);
    this.v2Ticker.unregister(w.sprite);
  }

  private clear(): void {
    for (const w of this.walkers) {
      this.release(w);
      w.sprite.destroy();
    }
    this.walkers = [];
  }
}
