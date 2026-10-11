/**
 * Defense firing visuals (HANDOFF §4.1, asset brief "engine recoil"): the
 * batch-13 fire-frame loop, the fx muzzle overlay, and the engine recoil.
 *
 * On a `fire` event the defense type picks a muzzle overlay composited at the
 * sprite's muzzle point: cannon `fx_fire_cannon`, tower `fx_fire_tower`, mortar
 * `fx_fire_mortar`, mage `fx_fire_magetower`. The overlay shows f1 ~180ms → f2 →
 * hides ~400ms. When the target is WEST of the muzzle we mirror BOTH the defense
 * sprite and the overlay with flipX — the contracted X-flip (HANDOFF §4.1 aim()).
 *
 * BATCH 13 changed two of the assumptions this file was written on:
 *  - the reworked defences now ship their OWN firing frames (`_fire_f1/_f2`
 *    for the six older ones, `_fire_f1.._f4` for the v2 electric tower), so
 *    the shot is animated by the building, not only by an fx overlay;
 *  - they grew a floating level crown and up to 4.3 tiles of height, so
 *    "N px below the sprite top" no longer lands anywhere near the weapon.
 * Both are handled below, and the `fx_fire_*` overlay frames themselves still
 * have no baked recoil — the kick for the types whose art does not move is
 * still pure engine.
 */
import type Phaser from 'phaser';
import { atlasGroupFor, B13_DEFENCES, DEFENSES } from '@shardkeep/shared';

const F1_MS = 180;
const F2_MS = 180; // hide ~400ms after f1 (180 + 220 ≈ App)
const RECOIL_PX = 4;
const RECOIL_MS = 100;

/** Types with an fx muzzle OVERLAY. The electric tower left this union in v2:
 *  its discharge (bolt, tip flares, ozone bloom) is fully baked into its own
 *  `_fire_f1.._f4` masters, and the legacy fx_fire_electric flash would
 *  double-draw on top of the authored art. */
type Type = 'cannon' | 'archertower' | 'mortar' | 'magetower';

/** DEFENSES holds a per-type shape; index it as a lookup table (as ui/sheets). */
const CADENCE = DEFENSES as Record<
  string,
  { fireIntervalSec?: number; spawnIntervalSec?: number } | undefined
>;

/** The defences batch 13 redrew (v2: seven, the electric tower included) —
 *  the only ones with `_fire_f*` art. Every other building must keep rendering
 *  exactly what it rendered before. */
const FIRE_ART = new Set<string>(B13_DEFENCES);

/**
 * How long a defence holds its firing art before returning to idle.
 *
 * The sim has no "stopped firing" event — only the shot itself — so the hold has
 * to come from the weapon's own cadence, and it MUST stay under it: at or above
 * the interval the 0.5s archer tower would re-enter its fire frames before it
 * ever got back to idle and would simply never look idle. The ceiling is the
 * other half of it: the mortar fires every 4s, and holding a recoil pose for
 * 2.8s of that reads as jammed rather than as a big gun, so slow weapons show a
 * discrete puff of firing and settle.
 */
const FIRE_HOLD_MAX_MS = 360;
const FIRE_HOLD_FRACTION = 0.7;

/** Hold for one shot of `type`, in ms. Exported for the test that pins the
 *  hold < fireInterval invariant against the real DEFENSES table. */
export function fireHoldMs(type: string): number {
  const d = CADENCE[type];
  // The Dragon Nest has no fire interval: it has no direct-fire weapon at all,
  // and its cadence is the spawn loop that its fire art actually depicts.
  const sec = d?.fireIntervalSec ?? d?.spawnIntervalSec ?? 1;
  return Math.min(FIRE_HOLD_MAX_MS, Math.round(sec * 1000 * FIRE_HOLD_FRACTION));
}

/**
 * Shot counter per sprite, bumped on every fire and on cancel. A fire schedules
 * three texture writes; without this token a shot that started before the tower
 * collapsed would repaint the rubble as a tower 350ms later, and two overlapping
 * shots would fight over the idle reset.
 */
const shot = new WeakMap<Phaser.GameObjects.Sprite, number>();

/** Durable defense sprites survive a verdict jump, but their recoil tween does
 * not. Retain the authoritative seat and a token so cancel can both snap home
 * and make an already-queued onComplete callback harmless. */
const recoil = new WeakMap<Phaser.GameObjects.Sprite, { homeX: number; token: number }>();

/** Muzzle overlays are driven only by scene timers, so a verdict that clears
 * those timers must explicitly destroy the already-visible images. */
const activeMuzzleFx = new WeakMap<Phaser.Scene, Set<Phaser.GameObjects.Image>>();

function trackMuzzleFx(scene: Phaser.Scene, image: Phaser.GameObjects.Image): void {
  let sceneFx = activeMuzzleFx.get(scene);
  if (!sceneFx) {
    sceneFx = new Set();
    activeMuzzleFx.set(scene, sceneFx);
  }
  sceneFx.add(image);
}

function destroyMuzzleFx(scene: Phaser.Scene, image: Phaser.GameObjects.Image): void {
  const sceneFx = activeMuzzleFx.get(scene);
  sceneFx?.delete(image);
  if (sceneFx?.size === 0) activeMuzzleFx.delete(scene);
  if (image.active) image.destroy();
}

/** Destroy timer-owned muzzle overlays. Safe at verdict and SHUTDOWN. */
export function clearMuzzleFx(scene: Phaser.Scene): void {
  const sceneFx = activeMuzzleFx.get(scene);
  if (!sceneFx) return;
  activeMuzzleFx.delete(scene);
  for (const image of sceneFx) {
    if (image.active) image.destroy();
  }
}

/**
 * Play a batch-13 defence's own firing animation: `_fire_f1` → … → `_fire_fN`
 * → back to `idleKey`. A no-op for every other building type.
 *
 * `idleKey` is the building's resting frame (`bld_mortar_l7`); the fire frames
 * hang off it and are packed in the same atlas group — a Phaser texture swap
 * cannot span two textures, which is exactly why the packer keeps them together.
 * All state frames are authored at the same size, so nothing that reads
 * displayHeight (HP bar, muzzle point) shifts while a tower fires.
 *
 * The clip LENGTH is an art fact that differs per defence — the six older
 * towers ship `_fire_f1/_f2`, the v2 electric tower `_fire_f1.._f4` — so it is
 * probed from the packed sprite meta (the same `${key}_fN`-presence walk
 * ambience.ts uses for idle clips) rather than hardcoded at 2, which would
 * silently freeze the electric discharge at half its authored frames.
 *
 * Frames spread evenly across the hold, idle landing at `hold` — for 2 frames
 * that is f1 at 0 and f2 at hold/2, the exact historical schedule. The electric
 * tower's 4 discharge frames therefore step ~90ms at its 1.2s cadence, a shade
 * under the pack README's 110–130ms suggestion, because the hold-under-cadence
 * invariant (see FIRE_HOLD_MAX_MS above) outranks the suggested rate: a
 * discharge clip that outlived the hold would never return to idle art.
 */
export function defenceFire(
  scene: Phaser.Scene,
  defense: Phaser.GameObjects.Sprite,
  type: string,
  idleKey: string,
  meta: Record<string, unknown>,
): void {
  if (!FIRE_ART.has(type)) return;
  const frames: string[] = [];
  for (let f = 1; `${idleKey}_fire_f${f}` in meta; f++) frames.push(`${idleKey}_fire_f${f}`);
  // Meta without the fire family (should not happen for FIRE_ART types, but a
  // missing frame is drawn as NOTHING, so the guard fails safe to no animation).
  if (frames.length === 0) return;
  const atlas = atlasGroupFor(idleKey);
  const token = (shot.get(defense) ?? 0) + 1;
  shot.set(defense, token);
  const hold = fireHoldMs(type);
  const set = (frame: string): void => {
    if (defense.active && shot.get(defense) === token) defense.setTexture(atlas, frame);
  };
  set(frames[0]!);
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i]!;
    scene.time.delayedCall(Math.round((hold * i) / frames.length), () => set(frame));
  }
  scene.time.delayedCall(hold, () => set(idleKey));
}

/** Abandon any firing animation still in flight on this sprite — the scene calls
 *  it when the building is destroyed, so a late frame cannot paint over rubble. */
export function cancelDefenceFire(defense: Phaser.GameObjects.Sprite): void {
  shot.set(defense, (shot.get(defense) ?? 0) + 1);
  const activeRecoil = recoil.get(defense);
  if (!activeRecoil) return;
  // Invalidate an onComplete that Phaser may already have queued before the
  // scene kills the tween, then restore the durable building to its map seat.
  recoil.set(defense, { homeX: activeRecoil.homeX, token: activeRecoil.token + 1 });
  if (defense.active) defense.x = activeRecoil.homeX;
}

/**
 * Where a shot leaves a defence, as a fraction of its RENDERED height above the
 * ground. Used for the muzzle overlay, the projectile origin and the beam origin
 * so all three agree.
 *
 * 0.6 is the historical value and still holds where the weapon sits low: the
 * cannon's gun measures 0.47–0.60 across L1–20 and the mortar's tube 0.47–0.57.
 * The three tall towers moved, because batch 13 grew them to as much as 4.3
 * tiles and put a floating level crown on top — 0.6 now lands on bare shaft well
 * below the archer. The values below are measured from the masters themselves:
 * a `_fire_f1` frame differs from its idle frame ONLY where the weapon is, which
 * is precisely the muzzle. Band centres, L1 → L20:
 *   archertower 0.82 → 0.75, magetower 0.90 → 0.85, lasertower 0.86 → 0.86.
 * The v2 electric tower needed a different measurement: its discharge repaints
 * most of the mast (bolt + tip flares + ozone bloom), so the fire-vs-idle diff
 * band is the whole tower, not the weapon. The bolt itself leaves the crown's
 * TOP electrode prong, and the masters fill the canvas to the very top —
 * measured: the topmost opaque row is 0 at L1/L10/L20, idle and fire alike —
 * so 0.92 keeps the origin on the prong stack rather than floating above it.
 * (v2 also changed the electric tower's height on 18 of 20 levels, so the old
 * flat 0.6 was doubly stale.)
 */
const MUZZLE_FRAC: Record<string, number> = {
  archertower: 0.78,
  magetower: 0.87,
  lasertower: 0.86,
  electrictower: 0.92,
};
const MUZZLE_FRAC_DEFAULT = 0.6;

/** World Y a shot leaves `defense` from (origin is bottom-centre: y = ground). */
export function muzzleY(defense: Phaser.GameObjects.Sprite, type: string): number {
  return defense.y - defense.displayHeight * (MUZZLE_FRAC[type] ?? MUZZLE_FRAC_DEFAULT);
}

/**
 * Per-type overlay key; the flash rides the muzzle point.
 *
 * Top-anchoring was the rule for every type until batch 13, and it broke on the
 * new art: the level crown is a fixed band that only appears from ~L10, so a
 * constant offset from the top cannot be right at both L1 and L20 — the cannon's
 * flash ended up in the empty space above its crown. The one type that still
 * top-anchored (the electric tower) lost its overlay entirely in v2, so the
 * `topDy` escape hatch went with it.
 */
const OVERLAY: Record<Type, { key: string }> = {
  cannon: { key: 'fx_fire_cannon' },
  archertower: { key: 'fx_fire_tower' },
  mortar: { key: 'fx_fire_mortar' },
  magetower: { key: 'fx_fire_magetower' },
};

/**
 * Defences whose batch-13 fire frames BAKE the recoil — measured: the cannon's
 * fire frames redraw rows 16–151 of 158 and the mortar's 12–183 of 192, i.e. the
 * whole gun and its platform shift. Adding the engine kick on top of that would
 * double the motion and fight the authored animation.
 *
 * The other four only redraw the weapon itself (the archer tower repaints rows
 * 56–83 of 274 — just the archer), so those keep the engine kick they shipped
 * with; it is the only thing that makes them move at all.
 */
const BAKED_RECOIL = new Set(['cannon', 'mortar']);

export function muzzleFlash(
  scene: Phaser.Scene,
  defense: Phaser.GameObjects.Sprite,
  type: Type,
  targetX: number,
): void {
  const cfg = OVERLAY[type];
  if (!cfg) return;
  const west = targetX < defense.x;

  // Flip the defender toward its target (mirror of anchor x). Still right for the
  // batch-13 art: the archer, the gun barrel and the mortar tube are all drawn
  // facing east, so a shot to the west without this fires out of the tower's back.
  defense.setFlipX(west);

  const ov = scene.add
    .image(defense.x, muzzleY(defense, type), 'fx', `${cfg.key}_f1`)
    .setDepth(defense.depth + 1)
    .setFlipX(west);
  trackMuzzleFx(scene, ov);
  scene.time.delayedCall(F1_MS, () => ov.active && ov.setTexture('fx', `${cfg.key}_f2`));
  scene.time.delayedCall(F1_MS + F2_MS, () => destroyMuzzleFx(scene, ov));

  if (BAKED_RECOIL.has(type)) return;

  // Engine recoil: kick backwards (away from the target) then ease home.
  const dir = west ? RECOIL_PX : -RECOIL_PX; // target west → kick east (+x)
  const previous = recoil.get(defense);
  const homeX = previous?.homeX ?? defense.x;
  const token = (previous?.token ?? 0) + 1;
  recoil.set(defense, { homeX, token });
  scene.tweens.add({
    targets: defense,
    x: homeX + dir,
    duration: RECOIL_MS / 2,
    yoyo: true,
    ease: 'Quad.easeOut',
    onComplete: () => {
      if (defense.active && recoil.get(defense)?.token === token) defense.x = homeX;
    },
  });
}
