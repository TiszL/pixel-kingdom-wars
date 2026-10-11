/**
 * Projectiles, impacts, beams, breath cones and burn scorches (HANDOFF §4.1,
 * batch-13 v2 fx pack README §1/§6).
 *
 *   cannonball  fx_cannonball_f1/f2   480ms flat, rotated to its heading
 *   arrow       fx_arrow_f1           420ms flat, rotated to its heading
 *   orb         fx_orb_f1/f2          420ms flat (mage bolt), rotated
 *   shell       fx_shell_f1/f2        900ms with arc  y -= 180*sin(pi*t),
 *               while a detached fx_shell_shadow tracks the GROUND lerp
 *   beam        fx_beam_f1/f2         instant stretch segment (laser tower)
 *   zap         fx_zap_f1..f3         instant stretch segment (electric tower)
 *
 * Every flight ends in its own authored `_hit` clip at the landing point — the
 * sim's hit/damage events still drive the hit star and the numbers separately.
 * Flight sprites are authored travelling EAST; the engine rotates them along
 * the heading (west is a rotation of ~pi, so no flip is needed).
 *
 * The mortar shell has no sim "explosion" event — its landing self-drives the
 * 4-frame fx_shell_hit + a 6px/150ms camera shake, exactly as the App's
 * shoot() did with the old generic explosion. explode() (6-frame fx_explosion)
 * stays for the keg runner's detonate event, which never was a projectile.
 */
import type Phaser from 'phaser';
import { haptic, shake } from '../../lib/juice';
import { buildingDepth, overlayDepth } from '../world/depth';

const ARC_PX = 180; // peak shell height (world px)

/* ───────────────────────── art facts, beside the code ─────────────────────
 * Frame counts, anchors and rates are ATLAS/ART facts (HERO_WALK_FRAMES
 * precedent) — from the pack README §6 rate table and the pack manifest's
 * pixel anchors — NOT game numbers, so they live here, not in shared
 * constants. A wrong frame name or origin is SILENT: Phaser draws nothing for
 * a missing frame and an off-anchor impact just looks "a bit beside" the
 * target, so projectiles.test.ts pins the literal strings and the origins. */

/** README §6: flight loops 110–160ms / impacts once 150–180ms / breath cones
 *  110–130ms / burning ground 200–240ms. Mid-band values. */
export const FX_RATES = {
  flightFrameMs: 130,
  impactFrameMs: 165,
  breathFrameMs: 120,
  burnFrameMs: 220,
} as const;

/** Burn scorches hold for 3 full 2-frame cycles, then fade 300ms — client
 *  feel: long enough to read as burning ground, short enough that a mortar
 *  duel does not carpet the field in persistent decals. */
const BURN_CYCLES = 3;
const BURN_FADE_MS = 300;

export type ProjKind = 'cannonball' | 'arrow' | 'shell' | 'orb';

interface HitArt {
  base: string;
  frames: number;
  /** Origin from the pack manifest anchor (anchor_px / canvas_px). The README
   *  claims "impact anchors are sprite centre" but the manifest measures two
   *  exceptions (arrow, cannonball) — the manifest wins. */
  origin: readonly [number, number];
  scale: number;
}

interface ProjArt {
  flightMs: number;
  frames: readonly string[];
  origin: readonly [number, number];
  /** Rotate along the heading (art drawn travelling east). The shell arcs, so
   *  no single heading is true for it — it stays unrotated, as it always was. */
  rotate: boolean;
  hit: HitArt;
}

const CENTRE = [0.5, 0.5] as const;

export const PROJ_ART: Record<ProjKind, ProjArt> = {
  cannonball: {
    flightMs: 480,
    frames: ['fx_cannonball_f1', 'fx_cannonball_f2'],
    origin: [9 / 14, 0.5], // manifest anchor (9,6) of 14×12 — aft of centre, nose leads
    rotate: true,
    // manifest anchor (13,12) of 26×20: crater sits at y 0.6, NOT centre
    hit: { base: 'fx_cannonball_hit', frames: 3, origin: [0.5, 0.6], scale: 1 },
  },
  arrow: {
    flightMs: 420,
    frames: ['fx_arrow_f1'],
    origin: CENTRE, // manifest anchor (10,3) of 20×6
    rotate: true,
    // manifest anchor (6,10) of 14×12: the hit is a STUCK SHAFT, anchored near
    // its ground end so the arrowhead sits where the shot landed
    hit: { base: 'fx_arrow_hit', frames: 2, origin: [6 / 14, 10 / 12], scale: 1 },
  },
  shell: {
    flightMs: 900,
    frames: ['fx_shell_f1', 'fx_shell_f2'], // the live fuse burns in flight
    origin: CENTRE, // manifest anchor (9,6) of 18×12
    rotate: false,
    // README: 4 frames, "the biggest explosion in the kit" — drawn at 2× so a
    // mortar landing unmistakably outclasses every other impact
    hit: { base: 'fx_shell_hit', frames: 4, origin: CENTRE, scale: 2 },
  },
  orb: {
    flightMs: 420,
    frames: ['fx_orb_f1', 'fx_orb_f2'],
    origin: [10 / 16, 0.5], // manifest anchor (10,7) of 16×14 — aft of centre
    rotate: true,
    hit: { base: 'fx_orb_hit', frames: 3, origin: CENTRE, scale: 1 },
  },
};

const BEAM_HIT: HitArt = { base: 'fx_beam_hit', frames: 2, origin: CENTRE, scale: 1 };
const ZAP_HIT: HitArt = { base: 'fx_zap_hit', frames: 2, origin: CENTRE, scale: 1 };

/** Dragon breath is anchored at the cone ROOT (the maw end) per the manifest:
 *  (1,11) of 40×22. M22 Hatchling fire has its own WARE projectile route, so
 *  this generic table intentionally exposes no Wyrmling-compatible kind. */
export const BREATH_ART: Record<'dragon', {
  base: string;
  frames: number;
  origin: readonly [number, number];
}> = {
  dragon: { base: 'fx_breath_dragon', frames: 4, origin: [1 / 40, 0.5] as const },
};

/**
 * Generic combat FX whose visible objects otherwise live only in timer/tween
 * closures. Phaser's TweenManager does not expose a shell or its shadow as an
 * addCounter target, and a burn scorch has no tween at all until its hold ends.
 * Battle verdict cleanup therefore needs an explicit scene-owned inventory.
 */
const activeFx = new WeakMap<Phaser.Scene, Set<Phaser.GameObjects.Image>>();
const activeLoopTimers = new WeakMap<Phaser.Scene, Set<Phaser.Time.TimerEvent>>();

function trackLoopTimer(scene: Phaser.Scene, timer: Phaser.Time.TimerEvent): Phaser.Time.TimerEvent {
  let timers = activeLoopTimers.get(scene);
  if (!timers) {
    timers = new Set();
    activeLoopTimers.set(scene, timers);
  }
  timers.add(timer);
  return timer;
}

function stopLoopTimer(scene: Phaser.Scene, timer: Phaser.Time.TimerEvent): void {
  const timers = activeLoopTimers.get(scene);
  timers?.delete(timer);
  if (timers?.size === 0) activeLoopTimers.delete(scene);
  timer.remove();
}

/** Stop only presentation loops before a large Clock seek. One-shot timeline
 * and expiry callbacks remain active so authoritative state still hydrates. */
export function quiesceProjectileFx(scene: Phaser.Scene): void {
  const timers = activeLoopTimers.get(scene);
  if (!timers) return;
  activeLoopTimers.delete(scene);
  for (const timer of timers) timer.remove();
}

function trackFx<T extends Phaser.GameObjects.Image>(scene: Phaser.Scene, image: T): T {
  let sceneFx = activeFx.get(scene);
  if (!sceneFx) {
    sceneFx = new Set();
    activeFx.set(scene, sceneFx);
  }
  sceneFx.add(image);
  // Phaser GameObjects always expose EventEmitter.once; the defensive guard
  // also keeps this renderer helper usable by the lightweight scene seams.
  if (typeof image.once === 'function') {
    image.once('destroy', () => {
      const owned = activeFx.get(scene);
      owned?.delete(image);
      if (owned?.size === 0) activeFx.delete(scene);
    });
  }
  return image;
}

function destroyFx(scene: Phaser.Scene, image: Phaser.GameObjects.Image): void {
  const sceneFx = activeFx.get(scene);
  sceneFx?.delete(image);
  if (sceneFx?.size === 0) activeFx.delete(scene);
  if (image.active) image.destroy();
}

/** Destroy every generic projectile/impact/beam/scorch owned by this scene.
 * Timer and tween cancellation remains the scene's responsibility; this is
 * the missing visible-object half of verdict settlement. Safe to call twice. */
export function clearProjectileFx(scene: Phaser.Scene): void {
  quiesceProjectileFx(scene);
  const sceneFx = activeFx.get(scene);
  if (!sceneFx) return;
  activeFx.delete(scene);
  for (const image of sceneFx) {
    if (image.active) image.destroy();
  }
}

/** Step a one-shot `_f1..fN` fx clip at the impact rate, then destroy it. */
function playHit(scene: Phaser.Scene, art: HitArt, x: number, y: number): void {
  const img = trackFx(scene, scene.add
    .image(x, y, 'fx', `${art.base}_f1`)
    .setDepth(overlayDepth(2685))
    .setOrigin(art.origin[0], art.origin[1])
    .setScale(art.scale));
  for (let f = 2; f <= art.frames; f++) {
    scene.time.delayedCall(FX_RATES.impactFrameMs * (f - 1), () => {
      if (img.active) img.setTexture('fx', `${art.base}_f${f}`);
    });
  }
  scene.time.delayedCall(FX_RATES.impactFrameMs * art.frames, () => destroyFx(scene, img));
}

export function launchProjectile(
  scene: Phaser.Scene,
  kind: ProjKind,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): void {
  const art = PROJ_ART[kind];
  const dur = art.flightMs;
  const proj = trackFx(scene, scene.add
    .image(fromX, fromY, 'fx', art.frames[0]!)
    .setDepth(overlayDepth(2680))
    .setOrigin(art.origin[0], art.origin[1]));

  if (art.rotate) proj.setRotation(Math.atan2(toY - fromY, toX - fromX));
  if (art.frames.length > 1) {
    let f = 0;
    const timer = trackLoopTimer(scene, scene.time.addEvent({
      delay: FX_RATES.flightFrameMs, loop: true,
      callback: () => { if (proj.active) proj.setTexture('fx', art.frames[(f = (f + 1) % art.frames.length)]!); },
    }));
    scene.time.delayedCall(dur, () => stopLoopTimer(scene, timer));
  }

  if (kind === 'shell') {
    // Ground shadow tracks the flat lerp; the shell arcs above it.
    const shadow = trackFx(scene, scene.add
      .image(fromX, fromY, 'fx', 'fx_shell_shadow')
      .setDepth(overlayDepth(2670))
      .setAlpha(0.7));
    const start = { x: fromX, y: fromY };
    scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: dur,
      onUpdate: (tw) => {
        const t = tw.getValue() ?? 0;
        const gx = start.x + (toX - start.x) * t;
        const gy = start.y + (toY - start.y) * t;
        if (shadow.active) shadow.setPosition(gx, gy + 4);
        if (proj.active) proj.setPosition(gx, gy - ARC_PX * Math.sin(Math.PI * t));
      },
      onComplete: () => {
        destroyFx(scene, shadow);
        destroyFx(scene, proj);
        // The landing IS the explosion (no sim event): authored 4-frame hit,
        // a scorch, and the §3.10 keg/mortar juice budget (6px/150ms shake +
        // medium haptic + big boom — same numbers explode() applies).
        playHit(scene, art.hit, toX, toY);
        burnScorch(scene, toX, toY);
        shake(scene, 150, 0.004);
        haptic('medium');
      },
    });
    return;
  }

  // Flat shots: straight lerp; the authored impact plays where they land
  // (damage numbers + hit star still arrive via the sim's own hit events).
  scene.tweens.add({
    targets: proj,
    x: toX,
    y: toY,
    duration: dur,
    ease: 'Linear',
    onComplete: () => {
      destroyFx(scene, proj);
      playHit(scene, art.hit, toX, toY);
    },
  });
}

/**
 * Laser-tower beam: the stretchable fx_beam segment (v2 art — replaces the old
 * fx_beam_laser masters) from muzzle to target, 2-frame flicker + its 2-frame
 * hit at the far end. Instant — the laser has no flight time, so the README's
 * travelling-flight rate does not apply; the historical 50/120ms flicker does.
 */
export function laserBeam(
  scene: Phaser.Scene,
  fromX: number, fromY: number, toX: number, toY: number,
): void {
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  const beam = trackFx(scene, scene.add.image(fromX + dx / 2, fromY + dy / 2, 'fx', 'fx_beam_f1')
    .setDepth(overlayDepth(2680))
    .setRotation(Math.atan2(dy, dx))
    .setOrigin(0.5, 0.5));
  beam.setDisplaySize(len, beam.height); // stretch to reach, keep native thickness
  scene.time.delayedCall(50, () => beam.active && beam.setTexture('fx', 'fx_beam_f2'));
  scene.time.delayedCall(120, () => destroyFx(scene, beam));
  playHit(scene, BEAM_HIT, toX, toY);
}

/**
 * Electric bolt: the stretchable fx_zap segment, 3 frames and gone.
 *
 * This REPLACES both the old fx_bolt_electric travelling projectile and the
 * hand-drawn Graphics chain fork, rather than augmenting them: the zap is
 * authored as a stretch segment exactly like the laser's fx_beam, so the
 * coherent path is the one the beam already walks (rotate + setDisplaySize to
 * span, native thickness) — one visual language for "electricity connects two
 * points", whether it is the primary discharge or a chain hop. Lightning has
 * no flight time either, so the 3 frames crackle through at the beam's
 * flicker cadence (~55ms) instead of the travelling-flight loop, and the
 * whole bolt lives about as long as the old Graphics fork did (110ms).
 */
export function zapBolt(
  scene: Phaser.Scene,
  fromX: number, fromY: number, toX: number, toY: number,
): void {
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  const bolt = trackFx(scene, scene.add.image(fromX + dx / 2, fromY + dy / 2, 'fx', 'fx_zap_f1')
    .setDepth(overlayDepth(2680))
    .setRotation(Math.atan2(dy, dx))
    .setOrigin(0.5, 0.5));
  bolt.setDisplaySize(len, bolt.height);
  scene.time.delayedCall(55, () => bolt.active && bolt.setTexture('fx', 'fx_zap_f2'));
  scene.time.delayedCall(110, () => bolt.active && bolt.setTexture('fx', 'fx_zap_f3'));
  scene.time.delayedCall(165, () => destroyFx(scene, bolt));
}

/** The zap's 2-frame impact, for the discharge's primary target. Chain hops
 *  deliberately skip it — they already flash + star per hop, and a second
 *  impact sprite per hop reads as noise, not as more lightning. */
export function zapHit(scene: Phaser.Scene, x: number, y: number): void {
  playHit(scene, ZAP_HIT, x, y);
}

/**
 * Fire-breath cone rooted at the breather's maw, rotated along the shot
 * (east-authored, like every flight sprite). Plays ONCE through at the breath
 * rate: the sim has no "stopped breathing" event — the same shape as
 * defenceFire's hold problem — so one pass through the cone IS the breath,
 * sized to sit inside the attack swing without any new timer machinery.
 */
export function breathCone(
  scene: Phaser.Scene,
  kind: keyof typeof BREATH_ART,
  x: number, y: number, toX: number, toY: number,
): void {
  const art = BREATH_ART[kind];
  const cone = trackFx(scene, scene.add
    .image(x, y, 'fx', `${art.base}_f1`)
    .setDepth(overlayDepth(2680))
    .setOrigin(art.origin[0], art.origin[1])
    .setRotation(Math.atan2(toY - y, toX - x)));
  for (let f = 2; f <= art.frames; f++) {
    scene.time.delayedCall(FX_RATES.breathFrameMs * (f - 1), () => {
      if (cone.active) cone.setTexture('fx', `${art.base}_f${f}`);
    });
  }
  scene.time.delayedCall(FX_RATES.breathFrameMs * art.frames, () => destroyFx(scene, cone));
}

/**
 * Burning-ground overlay at an impact point: fx_burn_1x1's 2-frame loop for a
 * short fixed hold, bottom-centre per its manifest anchor (14,18 of 28×20),
 * depth-sorted a hair under whatever stands there so it reads as ground, not
 * as a flame ON the unit. Paired only with impacts whose coordinates the sim
 * already sends (mortar shell landing, dragon breath impact) — no new sim
 * knowledge. The 1×1 variant is deliberate: picking 2×2 by target size would
 * need the target's footprint, which is exactly the knowledge this must not
 * require.
 */
export function burnScorch(scene: Phaser.Scene, x: number, y: number): void {
  const burn = trackFx(scene, scene.add
    .image(x, y, 'fx', 'fx_burn_1x1_f1')
    .setOrigin(0.5, 18 / 20)
    .setDepth(buildingDepth(y) - 1));
  let f = 1;
  const timer = trackLoopTimer(scene, scene.time.addEvent({
    delay: FX_RATES.burnFrameMs, loop: true,
    callback: () => { if (burn.active) burn.setTexture('fx', `fx_burn_1x1_f${(f = f === 1 ? 2 : 1)}`); },
  }));
  scene.time.delayedCall(FX_RATES.burnFrameMs * 2 * BURN_CYCLES, () => {
    stopLoopTimer(scene, timer);
    if (!burn.active) return;
    scene.tweens.add({
      targets: burn, alpha: 0, duration: BURN_FADE_MS,
      onComplete: () => destroyFx(scene, burn),
    });
  });
}

/** 6-frame keg explosion at (x,y) + screen shake (detonate). Mortar shells no
 *  longer route here — their landing plays the authored fx_shell_hit above —
 *  but the keg runner's blast never was a projectile and keeps this art. */
export function explode(scene: Phaser.Scene, x: number, y: number): void {
  const ex = trackFx(
    scene,
    scene.add.image(x, y, 'fx', 'fx_explosion_f1').setDepth(overlayDepth(2685)).setScale(2),
  );
  [2, 3, 4, 5, 6].forEach((f, i) =>
    scene.time.delayedCall(120 * (i + 1), () => ex.active && ex.setTexture('fx', `fx_explosion_f${f}`)),
  );
  scene.time.delayedCall(840, () => destroyFx(scene, ex));
  // §3.10: keg/mortar = 6px/150ms shake + medium haptic + big boom (centralized
  // so the concurrent-shake cap + reduce-motion apply).
  shake(scene, 150, 0.004);
  haptic('medium');
}
