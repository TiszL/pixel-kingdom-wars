/**
 * Rework-v2 clip registry (Phase D of docs/REWORK-V2-PLAN.md).
 *
 * A typed, PURE view over the `v2Clips` sidecar the asset pipeline packs into
 * apps/web/public/atlas/meta.json — frame-name building, facing-row and
 * heading-row math, per-frame emitter lookup, fxAt parsing, and the projectile
 * arc profiles. No Phaser import: everything here is unit-testable data logic,
 * and every renderer (V2 troop fx, V2 defence fx, projectiles, the deed
 * renderer mirrors the same contract server-side) reads THIS module rather
 * than re-deriving the pack format.
 *
 * Pack format facts (HANDOFF-V2.md + the packed meta, verified):
 *  - one atlas per (unit, tier, state); frame keys are
 *    `v2_<svg-stem>_d<row>_f<col+1>` for multi-row sheets and
 *    `v2_<svg-stem>_f<n>` for single-row ones;
 *  - unit-facing rows run in rowOrder `[s,sw,w,nw,n,ne,e,se]`;
 *  - travel-set sheets (`travel: true`) use HEADING rows instead: row 0 = +x
 *    screen right, +45° CCW per row — different semantics, same key shape;
 *  - `emitters.muzzle[row][frame] = [x,y]` cell px and
 *    `emitters.axis[row][frame]` degrees (dragon: `maw`). NEVER derive an
 *    angle from muzzle recoil deltas — the mortar's whole muzzle table spans
 *    0.7px and manifest rounding noise dominates (the labs' hard lesson).
 */
import {
  ART_V2, artTierOfLevel, DEFENSES, V2_BUILDING_FALLBACKS,
} from '@shardkeep/shared';

export { artTierOfLevel };

/**
 * The ONE factor that converts v2 PACK pixels into WORLD pixels.
 *
 * The client world is @2x: `BaseScene`'s `const T = 64` is "world px per tile
 * (32 game px @2x)", and every LEGACY atlas group is fetched from the @2x PNGs
 * (BootScene's eager groups and atlasLoader's on-demand `trpdg` tiers all ask
 * for `@2x`). The v2 pack is authored at 32 GAME px per tile — "2x2 footprint =
 * 64px of ground" (`Giant dragon cannon  mortar rework v2/_src/_cannon2.js`
 * header) — and the pipeline packs it @1x ONLY, because a @2x dragon tier would
 * blow the 4096² single-texture cap (docs/REWORK-V2-PLAN.md phase C).
 *
 * So one pack px is HALF a world px: undrawn-at-scale v2 art renders at half
 * the size of the legacy art it replaces. Every v2 sprite draws ×2, and so does
 * every pack-px quantity that crosses into world space — emitter offsets,
 * breath-stream geometry, projectile art, shadow offsets. Route all of it
 * through this constant; a bare literal 2 is how the two halves drift apart
 * when the pack is ever re-packed @2x.
 */
export const V2_DRAW_SCALE = 2;

/** Pack px → world px. */
export function toWorldPx(packPx: number): number {
  return packPx * V2_DRAW_SCALE;
}

/** Unit-facing row order (DIR_YAW s=180…). The manifest repeats it per clip;
 *  this is the fallback when a clip entry omits it. */
export const V2_DIRS = ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'] as const;
export type Facing8 = (typeof V2_DIRS)[number];

export interface V2Emitters {
  /** Cannon/mortar weapon axis. Point attachments use the named tables below. */
  axis?: number[][];
  muzzle?: number[][][];
  maw?: number[][][];
  nock?: number[][][];
  staff?: number[][][];
  palm?: number[][][];
  blade?: number[][][];
  fist?: number[][][];
  pick?: number[][][];
  lance?: number[][][];
  keg?: number[][][];
  fuse?: number[][][];
  hatch?: number[][][];
  sack?: number[][][];
  /**
   * Published per-facing, per-frame attachment points (`muzzle`, `maw`,
   * `nock`, `staff`, `blade`, `fist`, `pick`, `lance`, `keg`, ...).
   * `axis` is the one non-point table and is narrowed by emitterAxis().
   */
  [name: string]: number[][][] | number[][] | undefined;
}

export interface V2Clip {
  frames: number;
  rows: number;
  cellW: number;
  cellH: number;
  rowOrder?: readonly string[];
  anchorPx?: readonly [number, number];
  fps?: number;
  loop?: boolean;
  fxAt?: string | null;
  /** Column-packed cosmetic variants (Barrowling); source indices are 0-based. */
  variants?: number;
  /** Semantic frames per variant inside the sheet's full column count. */
  variantStride?: number;
  emitters?: V2Emitters;
  travel?: boolean;
  footprint?: readonly [number, number];
}

export type V2ClipMap = Record<string, V2Clip>;

/** meta.json top-level `breathStream` block (geometry of the 3-part stream). */
export interface BreathStreamMeta {
  minRange: number;
  tileWidth: number;
}

/** What BootScene stashes in the game registry under 'v2meta'. */
export interface V2Meta {
  clips: V2ClipMap;
  breathStream: BreathStreamMeta | null;
  /** Exact decoded RGBA bytes by on-demand atlas group, generated from each
   *  packed texture's JSON size at the scale the runtime actually fetches. */
  atlasBytes: Readonly<Record<string, number>>;
}

/** Clip base key, e.g. clipKey('trp','giant',1,'walk') → 'v2_trp_giant_t1_walk'. */
export function clipKey(
  kind: 'trp' | 'bld',
  unit: string,
  tier: number,
  state: string,
): string {
  return `v2_${kind}_${unit}_t${tier}_${state}`;
}

/**
 * Frame name for (clip base, row, 1-based frame). Single-row clips carry no
 * `_d` token — passing a row for one anyway must not fabricate `_d0` (the
 * packer never emitted it), so the caller passes the CLIP and the row is
 * clamped to its real shape here.
 */
export function frameName(base: string, clip: V2Clip, row: number, frame1: number): string {
  const f = Math.min(clip.frames, Math.max(1, frame1));
  if (clip.rows <= 1) return `${base}_f${f}`;
  const d = Math.min(clip.rows - 1, Math.max(0, row));
  return `${base}_d${d}_f${f}`;
}

/** Every frame of one row of a clip, in order — a playback sequence. */
export function clipFrames(base: string, clip: V2Clip, row: number): string[] {
  return Array.from({ length: clip.frames }, (_, i) => frameName(base, clip, row, i + 1));
}

/** rowOrder index of a facing (manifest order, fallback V2_DIRS). */
export function facingRow(clip: V2Clip, facing: Facing8): number {
  const order = clip.rowOrder ?? V2_DIRS;
  const i = order.indexOf(facing);
  return i >= 0 ? i : 0;
}

/**
 * Nearest of 8 facings from a screen-space movement delta (y grows DOWN, so
 * dy > 0 walks south). atan2 sectors of 45°, east at 0°.
 */
export function facing8(dx: number, dy: number): Facing8 {
  const seq: readonly Facing8[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];
  const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return seq[((k % 8) + 8) % 8]!;
}

/**
 * Extra degrees a heading must travel PAST a sector boundary before the
 * facing switches. Render tunable (patrol.ts FACING_HYSTERESIS precedent):
 * a near-diagonal walk sits on a 45° boundary and sub-pixel wobble flips the
 * nearest sector every frame — each flip re-registers the walk row, which is
 * exactly the "dizzy shuffle" bug anim.ts documents. 10° holds a diagonal
 * steady while a genuine turn (≥ ~32.5° swing) still snaps within a frame.
 */
export const FACING8_HYSTERESIS_DEG = 10;

const FACING_ANGLE: Record<Facing8, number> = {
  e: 0, se: 45, s: 90, sw: 135, w: 180, nw: -135, n: -90, ne: -45,
};

/**
 * facing8 with hysteresis: keep `current` unless the new heading is clearly
 * outside current's 45° sector widened by FACING8_HYSTERESIS_DEG each side.
 */
export function facing8Stable(dx: number, dy: number, current: Facing8): Facing8 {
  // A near-zero delta has NO heading: atan2(0,0) is 0° ('e'), which flipped a
  // west-walking actor 180° for exactly one frame whenever an interpolation
  // tick landed on (or float-jittered around) its endpoint — the K-029
  // "opposite side in the same frame" dizziness (owner 2026-08-15). Movement
  // below half a world pixel keeps the current facing.
  if (dx * dx + dy * dy < 0.25) return current;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  let diff = Math.abs(deg - FACING_ANGLE[current]) % 360;
  if (diff > 180) diff = 360 - diff;
  if (diff <= 22.5 + FACING8_HYSTERESIS_DEG) return current;
  return facing8(dx, dy);
}

/**
 * Vertical foreshortening every caller must apply to dy BEFORE asking for a
 * heading row (labs: `headingRow(tx-from[0], (ty-from[1])*0.25)`).
 *
 * The travel sets are drawn for the pack's 3/4 view, so screen-y covers ~4×
 * the ground distance screen-x does; feeding raw dy makes a shallow shot read
 * as a steep one and lands a whole octant off on any diagonal.
 */
export const PROJ_Y_FORESHORTEN = 0.25;

/**
 * HEADING row for a travel-set sheet: row 0 = +x screen right, +45° clockwise
 * per row in screen-y-down coordinates. The generated masters use
 * `sin(angle)` for y, so negating atan2 mirrors every non-horizontal shot.
 * Callers pass the ACTUAL travel vector with dy scaled by
 * PROJ_Y_FORESHORTEN; a hardcoded +x is right only while everything happens
 * to fire rightward.
 */
export function headingRow(dx: number, dy: number): number {
  const k = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  return ((k % 8) + 8) % 8;
}

/**
 * Published attachment point (cell px) for an emitter at (row, 0-based
 * frame). Falls back row → row 0 and clamps the frame like the labs' attachA;
 * a clip with no emitter table falls back to the CELL CENTRE — the manifest
 * documents the giant as having NO emitters, boulders leave his cell centre.
 */
export function emitterPoint(
  clip: V2Clip,
  name: string,
  row: number,
  frame0: number,
): readonly [number, number] {
  // Every named attachment except the reserved `axis` table has this shape.
  // Keep the cast here, at the one typed boundary, rather than at every
  // renderer that consumes an owner-published attachment name.
  const table = clip.emitters?.[name] as number[][][] | undefined;
  const g = table?.[row] ?? table?.[0];
  if (!g || g.length === 0) return [clip.cellW / 2, clip.cellH / 2];
  const p = g[Math.min(frame0, g.length - 1)]!;
  return [p[0]!, p[1]!];
}

/** Published on-screen weapon axis in DEGREES at (row, 0-based frame). The
 *  axis table is projected from the rig's base→mouth vector by the generator —
 *  stable by construction. 0 when a clip carries none. */
export function emitterAxis(clip: V2Clip, row: number, frame0: number): number {
  const table = clip.emitters?.axis;
  const g = table?.[row] ?? table?.[0];
  if (!g || g.length === 0) return 0;
  return g[Math.min(frame0, g.length - 1)]!;
}

/**
 * Parse a manifest `fxAt` string — 'muzzle@2 + cannonball@2 + smoke@3',
 * 'dust@1,5', 'breath@3-5' — into fx name → **1-based** frame numbers, which is
 * what V2Ticker.onFrame reports. The expanded delivery also embeds the same
 * tokens in prose (`dust@1 at launch and dust@7 on landing`) and spells ranges
 * with two dots (`loot_rise@1..7`); token extraction deliberately ignores the
 * prose while preserving every authored cue.
 *
 * THE PACK'S NUMBERS ARE 0-BASED FRAME INDICES, so every one is shifted +1
 * here — once, in the parser, rather than as a ±1 at each call site (where a
 * missed one fires an effect a frame early AND reads the wrong row of the
 * emitter table). Evidence, three independent ways:
 *  - HANDOFF-V2 §Cannon: "f2 is ignition: fx_muzzle, launch the ball, full
 *    recoil and muzzle heat all land together" against the manifest's own
 *    `emitters.muzzle` for `bld_cannon_t1_fire` row 2, whose x runs
 *    36 → 36.5 → **41.6** → 40.1 → 37.9 → 36.6: peak recoil is at INDEX 2, i.e.
 *    the third frame;
 *  - the labs (`lab-cannon.html` scene `cn-fire`) hold `flash.at = 2` and
 *    `proj.at = 2` while the actor's own frame is `min(c-1, max(0, t - off))`
 *    with `off = 0` — so the flash spawns when the 0-based frame index is 2;
 *  - `_lab.js#attachA` reads `em[name][row][f]` with that SAME 0-based index,
 *    which is why the callers here read the emitter table at `frame1 - 1`.
 */
export function parseFxAt(fxAt: string | null | undefined): Array<{ fx: string; frames: number[] }> {
  if (!fxAt) return [];
  const out: Array<{ fx: string; frames: number[] }> = [];
  const tokens = fxAt.matchAll(/([a-z0-9_]+)@(\d+(?:(?:-|\.{2})\d+)?(?:,\d+(?:(?:-|\.{2})\d+)?)*)/gi);
  for (const m of tokens) {
    const frames: number[] = [];
    for (const tok of m[2]!.split(',')) {
      const range = /^(\d+)(?:-|\.{2})(\d+)$/.exec(tok);
      if (range) {
        for (let f = Number(range[1]); f <= Number(range[2]); f++) frames.push(f + 1);
      } else if (tok !== '') {
        frames.push(Number(tok) + 1);
      }
    }
    out.push({ fx: m[1]!, frames });
  }
  return out;
}

/* ───────────────────── v2 building seating (ONE decider) ─────────────────────
 * Three renderers draw the same v2 tower — the base view (BaseScene), its
 * animated ambience copy (world/ambience.ts) and the deed PNG
 * (apps/api/src/game/baseRender.ts, which mirrors this in server code). The
 * ART_V2 "same tower on deed and base" guard is load-bearing, and the ambience
 * layer's own comments already demand that exactly one place decide what an
 * idle copy looks like — so origin, draw scale and the footprint seat all come
 * from here rather than being re-derived per renderer.
 */

/** Any v2 BUILDING frame name → its clip base key + unit. */
const V2_BLD_FRAME = /^(v2_bld_([a-z]+)_t\d+_[a-z]+)(?:_d\d+)?_f\d+$/;
const V2_BLD_FALLBACK_FRAME =
  /^v2_fallback_bld_([a-z]+)_t(\d+)_([a-z]+)_d0_f\d+$/;

/**
 * World draw scale for a v2 building: the @1x→@2x pack conversion times the
 * unit's PUBLISHED world fit, exactly as `wareSeat` composes it.
 *
 * Both halves are load-bearing and neither may be inlined at a call site. The
 * pack conversion alone is what shipped, and it is why the Mortar and Cannon
 * drew larger than the Keep (owner 2026-08-30) — every WARE family had been
 * fitted to the base it stands on and these two never were. `defense.ts` and
 * the deed renderer must read this same product, or the same tower is three
 * different sizes in the base view, a raid and the deed PNG.
 */
export function v2BldDrawScale(unit: string): number {
  const fit: Record<string, number> = ART_V2.buildingSourceScale;
  return V2_DRAW_SCALE * (fit[unit] ?? 1);
}

/**
 * The same fit expressed against the pack conversion — what a v2 TOWER lends to
 * the art it emits: its muzzle offsets (`emitterWorld`) and, since 2026-08-30,
 * the flash and the round themselves (`projectiles.ts` V2ArtFit).
 *
 * A defence tower is not a troop, so it does not inherit `BATTLE_SCALE.troop`;
 * what it does inherit is the same rule — A SHOT IS THE SIZE OF WHAT FIRED IT.
 * A Mortar fitted to 0.625 of its authored size lobs a 0.625 shell, or the
 * round is wider than the barrel it left. Extracted rather than inlined so the
 * muzzle and the round cannot be given two different numbers.
 */
export function v2BldArtFit(unit: string): number {
  return v2BldDrawScale(unit) / V2_DRAW_SCALE;
}

export interface V2BldSeat {
  /** Sprite origin fractions, from the clip's manifest `anchorPx`. */
  origin: readonly [number, number];
  /** Draw scale — `v2BldDrawScale`, never a bare V2_DRAW_SCALE. */
  scale: number;
}

/**
 * THE SEAT: a building's drawn BOTTOM EDGE sits on the south edge of its
 * footprint (HANDOFF §3.2, and what `positionBuilding` has always claimed to
 * do). Returns the sprite Y for a sprite whose origin-y is `originY` and whose
 * on-screen height is `drawnH`; the anchor cancels out of the vertical seat
 * entirely, which is the point — the answer is `bottom = (ty + fh) * tile` for
 * every family, in every renderer.
 *
 * IT REPLACES the `footprintFrac` seat (owner 2026-08-30, verbatim: "this
 * defences and building need to fit into its tiles, keep should be located
 * lower 2 tiles and will fit in box perfectly, not even making it smaller is
 * needed" — plus the same report against the cannon and the hero altar).
 * The old rule seated a pixel-anchored building on the MIDDLE row of its
 * footprint, because the packs publish the anchor at the centre of the art's
 * own ground quad. That quad is drawn in 3/4 view — 2 tiles of depth as ~32
 * authored px — while the game's footprint rect is a flat top-down 2×64 world
 * px, so the two centres can never coincide and matching them LIFTED every
 * building off its plot: measured against the yellow selection box, the L15
 * Keep floated 49 px above its south edge while overhanging the box top by 62,
 * the Mortar floated 66, the Air Defence 56. The art was never too large — the
 * L15 Keep's ink is 134×141 against a 128×128 box — it was seated too high,
 * which is exactly what the owner diagnosed from the box.
 *
 * Aligning the FRONT edges instead is what walls, every legacy sprite and the
 * `HANDOFF §3.2` rule already did, and it is what the packs author: in every
 * WARE/v2 building clip the ink stops within 0–18 px of the cell bottom, i.e.
 * the cell bottom IS the pack's ground line.
 *
 * DEPTH is NOT this point — depth stays `(ty + fh) * T` unscaled, or a tall
 * tower would sort in front of the row of walls it stands behind (patrol.ts
 * walkers depend on that ordering).
 */
export function buildingSeatY(
  ty: number, fh: number, tile: number, originY: number, drawnH: number,
): number {
  return (ty + fh) * tile - (1 - originY) * drawnH;
}

/** Seating for a v2 building frame, or null for every non-v2 key (whose
 *  caller keeps its own meta.sprites anchor + unit scale). */
export function v2BldSeat(clips: V2ClipMap, frameKey: string): V2BldSeat | null {
  const current = V2_BLD_FRAME.exec(frameKey);
  const fallback = V2_BLD_FALLBACK_FRAME.exec(frameKey);
  if (!current && !fallback) return null;
  const unit = current?.[2] ?? fallback?.[1];
  if (!unit) return null;
  let base = current?.[1];
  if (fallback) {
    const config = V2_BUILDING_FALLBACKS[
      unit as keyof typeof V2_BUILDING_FALLBACKS
    ];
    if (!config || config.state !== fallback[3]) return null;
    base = `v2_bld_${unit}_t${fallback[2]}_${fallback[3]}`;
  }
  if (!base) return null;
  const clip = clips[base];
  if (!clip) return null;
  // The anchor stays the sprite ORIGIN — `emitterWorld` measures every muzzle
  // as (emitter − anchor), so moving the origin would move every shot's spawn
  // point off the barrel. It no longer decides the SEAT: see buildingSeatY.
  const [ax, ay] = clip.anchorPx ?? [clip.cellW / 2, clip.cellH];
  return {
    origin: [ax / clip.cellW, ay / clip.cellH],
    scale: v2BldDrawScale(unit),
  };
}

/* ───────────────────────── projectile arc profiles ─────────────────────────
 * ART FACTS not present in the packed meta (HANDOFF-V2.md "Arcs are documented
 * per projectile": fireball flat direct fire; cannonball shallow ballistic
 * peak ~18% of range; boulder high lob ~45%; shell ~55% — plus the labs'
 * travel clocks: 95ms global tick, travel 10 ticks default, spit/fireball 9,
 * boulder 11, shell 13). The arc formula is the labs':
 *   y = yb − arc * range * 4 * t * (1 − t)
 * so the peak (t = 0.5) is exactly arc × range.
 */
export const V2_TICK_MS = 95;

export type V2ProjKind =
  | 'fireball' | 'cannonball' | 'boulder' | 'shell'
  | 'arrow' | 'bolt' | 'hexshot';

export const V2_PROJ: Record<V2ProjKind, {
  /** peak height as a fraction of range (0 = flat). */
  arc: number;
  /** flight time in 95ms lab ticks. */
  travelTicks: number;
  /** impact family base (tiered) at the landing point, or null (fireball's
   *  contact is the breath/spit burn, fired by its owner). */
  impact: 'crater' | 'rubble' | 'burn' | 'bolt_hit' | null;
  /** Whether the lab pairs the flight with the altitude shadow set. */
  shadow: boolean;
}> = {
  fireball: { arc: 0, travelTicks: 9, impact: null, shadow: false },
  cannonball: { arc: 0.18, travelTicks: 10, impact: 'crater', shadow: true },
  boulder: { arc: 0.45, travelTicks: 11, impact: 'rubble', shadow: true },
  shell: { arc: 0.55, travelTicks: 13, impact: 'crater', shadow: true },
  // Expanded owner labs: Bowman line (arc .10, 10 ticks), Mage bolt
  // (arc .04, 9 ticks, explicitly no shadow), Hexbarrow wall shot (.12, 9).
  // Bowman's owner lab pairs both arrow examples with impact_burn on landing.
  arrow: { arc: 0.10, travelTicks: 10, impact: 'burn', shadow: true },
  bolt: { arc: 0.04, travelTicks: 9, impact: 'bolt_hit', shadow: false },
  hexshot: { arc: 0.12, travelTicks: 9, impact: 'crater', shadow: true },
};

/**
 * Altitude shadow column of `v2_fx_shadow` for a lift fraction (labs:
 * lift = arc*4*t*(1−t)): high above ground → small shadow (f1), descending →
 * medium (f2), near ground → large (f3). 1-based frame number.
 */
export function shadowFrame(lift: number): number {
  return lift > 0.28 ? 1 : lift > 0.12 ? 2 : 3;
}

/**
 * GAME footprints (cols × rows) of the v2 buildings, DERIVED from the shared
 * defense table rather than retyped — the locked owner decision is that the
 * cannon stays 1×1 in sim/server/DB and its bigger sprite merely overhangs its
 * tile, so the visual footprint the manifest publishes ([2,2] for BOTH units)
 * must never reach occupancy or placement. Deriving is what stops the sim, the
 * server and the client drifting: a footprint change in constants.ts moves all
 * three at once, and there is no second number here to forget.
 */
export const V2_BLD_FOOTPRINT: Record<string, readonly [number, number]> = (() => {
  // The art roster names buildings explicitly; never infer them from all unit
  // roots (the expanded delivery includes the mobile Hexbarrow under a `bld_`
  // asset stem even though it is a troop).
  const defenses: Record<string, { footprint: readonly [number, number] } | undefined> = DEFENSES;
  const out: Record<string, readonly [number, number]> = {};
  for (const u of ART_V2.buildings) {
    const fp = defenses[u]?.footprint;
    if (fp) out[u] = fp;
  }
  return out;
})();
