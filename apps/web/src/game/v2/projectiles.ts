/**
 * Rework-v2 projectiles, impacts and muzzle FX (Phase D; lab reference
 * `Giant dragon cannon  mortar rework v2/_src/_lab.js`).
 *
 * Travel sets are PRE-BAKED per heading — 8 rows, row 0 = +x screen right,
 * +45° CCW per row — because a runtime-rotated pixel sprite shears its dither
 * (HANDOFF-V2 §Projectiles). So flight sprites are never rotated: the row is
 * picked from the ACTUAL travel vector and the frames cycle at the clip's fps
 * (which is also what makes the boulder/shell visibly tumble).
 *
 * Arcs are the labs' formula y = yb − arc·range·4·t·(1−t) with the per-kind
 * profiles in clips.ts (art facts). Arced flights pair with the 3-column
 * altitude shadow tracking the flat ground lerp; heavy impacts (crater /
 * rubble) anchor at the manifest CONTACT POINT (38,52 of 76×76), not centre.
 */
import { atlasGroupFor } from '@shardkeep/shared';
import type Phaser from 'phaser';
import {
  clipFrames, emitterAxis, emitterPoint, frameName, headingRow, PROJ_Y_FORESHORTEN,
  shadowFrame, toWorldPx, V2_DRAW_SCALE, V2_PROJ, V2_TICK_MS,
  type V2Clip, type V2ClipMap, type V2ProjKind,
} from './clips';
import { combatEffectPool } from './effects';
import { overlayDepth } from '../world/depth';

/** Default shared on-demand FX group; Dire aliases route to its local shard. */
export const V2FX_ATLAS = 'v2fx';

export interface V2ProjectileArt {
  /** Resolve a metadata base to the frame base in an admitted texture. */
  baseFor: (metaBase: string) => string | null;
}

/** Depth bands — the legacy projectile/impact/shadow bands (fx/projectiles.ts),
 *  kept so v2 and legacy shots layer identically in a mixed battle. */
const DEPTH_PROJ = overlayDepth(2680);
const DEPTH_SHADOW = overlayDepth(2670);
const DEPTH_IMPACT = overlayDepth(2685);

/**
 * THE FIT A SHOT INHERITS FROM WHOEVER FIRED IT.
 *
 * Owner 2026-08-30: "I want smaller projectiles for arrows and such staff.
 * Arrows can't be the same size as the archer, right? So every troop should
 * have corresponding size projectiles and attacks."
 *
 * Every function in this file used to draw at a BARE `V2_DRAW_SCALE` — a flat
 * ×2 for every shot in the game. That was harmless while every actor was also a
 * flat ×2, and became the bug the moment `ART_V2.troopSourceScale` fitted the
 * bodies down: a bowman is 40 world px tall while `fx_arrow` renders 20×6 pack
 * px of ink at ×2 = 40×12 world px — an arrow exactly as long as the archer who
 * shot it. The dragon looked right throughout for the same reason it always
 * did: it is a big unit, so a ×2 shot happened to be in proportion to it.
 *
 * `fit` is the firing actor's own drawn scale expressed against the pack
 * conversion — `bodyScale / V2_DRAW_SCALE`, i.e. EXACTLY the number the caller
 * already passes `emitterWorld` as `bodyScale`. Passing one number for both is
 * the point: the muzzle offset and the art that leaves it can never drift, and
 * it fixes every unit at once instead of a per-asset table.
 *
 * IT DOES NOT DOUBLE-APPLY. `emitterWorld` multiplies `fit` by a pack-px
 * OFFSET (anchor → emitter) to place the shot; here it multiplies
 * `V2_DRAW_SCALE` to size the shot's own ART. The muzzle stays on the hand
 * while the arrow shrinks.
 *
 * Default 1 = the historical bare ×2, which is what every DRAGON cue keeps:
 * the dragon fires no `V2_PROJ` projectile at all (its ranged attack is the
 * three-part `BreathStream`, or the one-piece breath fx through `playV2Fx`),
 * and the owner reports its fx as already correct, so nothing on the dragon's
 * path passes a fit and nothing on it changes.
 */
export type V2ArtFit = number;

/** Step a one-shot v2 fx clip (single-row) at its own fps, anchored by its
 *  manifest anchorPx and drawn at `V2_DRAW_SCALE × fit`, then destroy it.
 *  Origin from anchorPx is what puts a crater's CONTACT POINT — not its centre
 *  — on the landing pixel; the origin is a FRACTION, so it survives the scale
 *  untouched while the contact offset it encodes scales with the art. */
export function playV2Fx(
  scene: Phaser.Scene,
  clips: V2ClipMap,
  base: string,
  x: number,
  y: number,
  opts: {
    depth?: number; rotationDeg?: number; metaBase?: string; fit?: V2ArtFit;
  } = {},
): Phaser.GameObjects.Image | null {
  const clip = clips[opts.metaBase ?? base];
  if (!clip) return null;
  const first = frameName(base, clip, 0, 1);
  const atlas = atlasGroupFor(first);
  if (!scene.textures.exists(atlas)) return null;
  const [ax, ay] = clip.anchorPx ?? [clip.cellW / 2, clip.cellH / 2];
  const img = scene.add
    .image(x, y, atlas, first)
    .setDepth(opts.depth ?? DEPTH_IMPACT)
    .setOrigin(ax / clip.cellW, ay / clip.cellH)
    .setScale(V2_DRAW_SCALE * (opts.fit ?? 1));
  // Published axis degrees are SCREEN-space clockwise-positive: the cannon's
  // axis table reads 90 for the south row (barrel pointing down the screen) and
  // −90 for north. The labs apply it as CSS `rotate(+deg)`, and Phaser's
  // rotation is clockwise-positive too — so it goes in UNNEGATED. Negating it
  // mirrored every flash about the horizon (south-firing guns flashed north).
  if (opts.rotationDeg !== undefined) img.setRotation((opts.rotationDeg * Math.PI) / 180);
  const stepMs = 1000 / (clip.fps ?? 12);
  let shown = 1;
  combatEffectPool(scene).add(
    stepMs * clip.frames,
    (elapsed) => {
      const frame = Math.min(clip.frames, Math.floor(elapsed / stepMs) + 1);
      if (img.active && frame !== shown) {
        shown = frame;
        img.setTexture(atlas, frameName(base, clip, 0, frame));
      }
    },
    () => img.destroy(),
    () => img.destroy(),
  );
  return img;
}

/**
 * Launch a v2 travelling projectile from (fromX,fromY) to (toX,toY).
 * Returns false when the resolved current-art atlas or metadata clip is
 * missing. The caller decides whether it owns genuinely legacy art; an
 * ART_V2 actor must fail closed rather than mix in a historical projectile.
 */
export function launchV2Projectile(
  scene: Phaser.Scene,
  clips: V2ClipMap,
  kind: V2ProjKind,
  tier: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  onLand?: () => void,
  art?: V2ProjectileArt,
  /** The firing actor's fit — see V2ArtFit. 1 keeps the historical bare ×2. */
  fit: V2ArtFit = 1,
): boolean {
  const resolveBase = (meta: string): string | null => art ? art.baseFor(meta) : meta;
  const metaBase = `v2_fx_${kind}_t${tier}`;
  const base = resolveBase(metaBase);
  const clip = clips[metaBase];
  if (!base || !clip) return false;
  const atlas = atlasGroupFor(frameName(base, clip, 0, 1));
  if (!scene.textures.exists(atlas)) return false;
  const prof = V2_PROJ[kind];
  const dx = toX - fromX;
  const dy = toY - fromY;
  const range = Math.hypot(dx, dy);
  // Heading from the actual travel vector, y foreshortened ×0.25 exactly as
  // the labs project it (_src/_lab.js:269 `headingRow(tx-from[0],
  // (ty-from[1])*0.25)`) — a defence firing out of its own base fires LEFT,
  // and the row must say so or the shell flies fuse-first.
  //
  // The FORESHORTENING is the load-bearing half, and passing raw dy silently
  // broke it: the travel sets are drawn for a 3/4 view, so a pure-south shot
  // reads as a shallow one, not a straight-down one. Unforeshortened, a 45°
  // screen diagonal picked row 7 where the labs pick row 0 — the art faced a
  // whole octant wrong on every diagonal shot, which is most of them.
  const row = headingRow(dx, dy * PROJ_Y_FORESHORTEN);
  const seq = clipFrames(base, clip, row);
  const durMs = prof.travelTicks * V2_TICK_MS;

  const proj = scene.add
    .image(fromX, fromY, atlas, seq[0]!)
    .setDepth(DEPTH_PROJ)
    .setOrigin(0.5, 0.5) // travel cells are centred (anchor = cell centre)
    .setScale(V2_DRAW_SCALE * fit);
  const frameStepMs = 1000 / (clip.fps ?? 12);
  let shownFrame = 0;

  // Shadow sits the labs' 6 PACK px below the flat ground lerp (`yb+6`), so the
  // drop is 6 world px only in an unscaled lab — here it scales with the art,
  // INCLUDING the firer's fit: the drop is a pack-px measurement of the shadow
  // sprite itself, so a shrunken shot whose shadow kept the full drop would
  // fly with its shadow detached below it.
  const SHADOW_DROP = toWorldPx(6) * fit;
  const shadowMetaBase = 'v2_fx_shadow';
  const shadowBase = resolveBase(shadowMetaBase);
  const shadowClip = clips[shadowMetaBase];
  const shadowAtlas = shadowBase && shadowClip
    ? atlasGroupFor(frameName(shadowBase, shadowClip, 0, 1))
    : null;
  // At t=0 the projectile is ON the ground, so the shadow starts on its LARGE
  // column (lift 0) and shrinks as the shot climbs; seeding it from `prof.arc`
  // flashed the peak column for the first frame.
  const shadow = prof.shadow && shadowBase && shadowClip && shadowAtlas
    && scene.textures.exists(shadowAtlas)
    ? scene.add
      .image(fromX, fromY + SHADOW_DROP, shadowAtlas,
        frameName(shadowBase, shadowClip, 0, shadowFrame(0)))
      .setDepth(DEPTH_SHADOW)
      .setAlpha(0.7)
      .setScale(V2_DRAW_SCALE * fit)
    : null;

  const dispose = (): void => {
    proj.destroy();
    shadow?.destroy();
  };
  combatEffectPool(scene).add(
    durMs,
    (elapsed, t) => {
      const frame = Math.floor(elapsed / frameStepMs) % seq.length;
      if (proj.active && frame !== shownFrame) {
        shownFrame = frame;
        proj.setTexture(atlas, seq[frame]!);
      }
      const gx = fromX + dx * t;
      const gy = fromY + dy * t;
      // labs: y = yb − arc·h·4t(1−t) with arc·h = the peak = arc × range.
      const lift = prof.arc * 4 * t * (1 - t);
      // `lift` and `arc` are FRACTIONS OF RANGE and `range` is already world px,
      // so the arc height needs no scale factor — it is dimensionless × world.
      if (proj.active) proj.setPosition(gx, gy - lift * range);
      if (shadow?.active) {
        shadow.setPosition(gx, gy + SHADOW_DROP);
        shadow.setTexture(
          shadowAtlas!, frameName(shadowBase!, shadowClip!, 0, shadowFrame(lift)),
        );
      }
    },
    () => {
      dispose();
      if (prof.impact) {
        // Most heavy rounds share the impact_<family> stems. The mage's small
        // contact family is intentionally named bolt_hit in the owner pack.
        const impactMetaBase = prof.impact === 'bolt_hit'
          ? `v2_fx_bolt_hit_t${tier}`
          : `v2_fx_impact_${prof.impact}_t${tier}`;
        const impactBase = resolveBase(impactMetaBase);
        if (impactBase) {
          // The landing art travels with the shot: a bowman's burn is a
          // bowman-sized burn, a mortar's crater a mortar-sized one.
          playV2Fx(scene, clips, impactBase, toX, toY, { metaBase: impactMetaBase, fit });
        }
      }
      onLand?.();
    },
    dispose,
  );
  return true;
}

/**
 * Muzzle-point FX (muzzle flash / mortarflash / powder smoke) at a world
 * point, rotated to the PUBLISHED weapon axis. The fx cells are authored
 * pointing +x and carry their own anchor in the manifest (muzzle/smoke (4,16),
 * mortarflash (6,18)) — read, never assumed, and the rotation pivots on it.
 */
export function playV2MuzzleFx(
  scene: Phaser.Scene,
  clips: V2ClipMap,
  base: string,
  x: number,
  y: number,
  axisDeg: number,
  depth: number,
  /** The firing actor's fit — see V2ArtFit. A flash is weapon-sized. */
  fit: V2ArtFit = 1,
): void {
  playV2Fx(scene, clips, base, x, y, { depth, rotationDeg: axisDeg, fit });
}

/**
 * World-space emitter point + axis for a clip drawn by `sprite` (origin =
 * anchorPx, drawn at V2_DRAW_SCALE): the emitter table is in CELL px, and the
 * sprite's position is its anchor point, so the offset from anchor to emitter
 * is a pack-px vector and has to be scaled into world px like the art around
 * it — unscaled, a cannon's muzzle flash lands halfway down the barrel.
 */
export function emitterWorld(
  sprite: { x: number; y: number },
  clip: V2Clip,
  name: string,
  row: number,
  frame0: number,
  bodyScale = 1,
): { x: number; y: number; axisDeg: number } {
  const [ax, ay] = clip.anchorPx ?? [clip.cellW / 2, clip.cellH];
  const [ex, ey] = emitterPoint(clip, name, row, frame0);
  return {
    x: sprite.x + toWorldPx(ex - ax) * bodyScale,
    y: sprite.y + toWorldPx(ey - ay) * bodyScale,
    axisDeg: emitterAxis(clip, row, frame0),
  };
}
