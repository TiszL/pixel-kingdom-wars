/**
 * Game-feel module (GDD §3.10) — the one place shake / flash / floatText /
 * haptics live, so the §3.10 table is honored consistently and reduce-motion is
 * never forgotten.
 *
 * Reduce motion (honored by shake, screen flash, and haptics):
 *   - the REDUCE MOTION profile toggle (localStorage 'skp_reduce_motion'), OR
 *   - the OS `prefers-reduced-motion: reduce` media query.
 * When either is set we drop camera shake and big flashes entirely and skip
 * haptics; sound + damage numbers still play (GDD rule: "never juice failure as
 * hard as success", but accessibility wins over juice).
 *
 * Haptics gate on the HAPTICS profile toggle (localStorage 'skp_haptics',
 * default OFF — matches the profile) AND reduce-motion. `navigator.vibrate`
 * patterns escalate light → heavy per the §3.10 column.
 *
 * Concurrent-shake cap: a global frame budget so a volley of mortar/keg hits
 * can't stack into an unreadable judder — at most CONCURRENT_SHAKE_CAP shakes
 * run at once; extra requests are dropped (the GDD's "concurrent-shake cap").
 */
import type Phaser from 'phaser';
import { popDamage } from '../game/fx/damagetext';

const REDUCE_MOTION_KEY = 'skp_reduce_motion';
const HAPTICS_KEY = 'skp_haptics';

/** True when motion should be minimized (profile toggle OR OS preference). */
export function reduceMotionOn(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof localStorage !== 'undefined' && localStorage.getItem(REDUCE_MOTION_KEY) === '1') {
    return true;
  }
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** HAPTICS profile toggle (localStorage). Defaults OFF in browsers, ON inside
 * the Solana-Mobile shell (owner 2026-08-16: the APK should ship "with good
 * haptics") — an explicit '0' from the player always wins. */
function hapticsOn(): boolean {
  if (typeof localStorage === 'undefined') return false;
  const v = localStorage.getItem(HAPTICS_KEY);
  if (v !== null) return v === '1';
  return localStorage.getItem('pkw:solana-mobile-client') != null;
}

// ---------------------------------------------------------------------------
// Camera shake — §3.10: keg/mortar = 6px / 150ms. Phaser's intensity is a
// fraction of the viewport; 0.004 reads as ~6px at the App's diorama scale.
// ---------------------------------------------------------------------------

const CONCURRENT_SHAKE_CAP = 2;
let activeShakes = 0;

/**
 * Camera shake with a concurrent cap; no-op under reduce-motion. `intensity` is
 * Phaser's viewport fraction (default 0.004 ≈ the §3.10 6px keg/mortar kick).
 */
export function shake(scene: Phaser.Scene, durationMs = 150, intensity = 0.004): void {
  if (reduceMotionOn()) return;
  if (activeShakes >= CONCURRENT_SHAKE_CAP) return;
  activeShakes++;
  const cam = scene.cameras.main;
  cam.shake(durationMs, intensity);
  scene.time.delayedCall(durationMs, () => { activeShakes = Math.max(0, activeShakes - 1); });
}

// ---------------------------------------------------------------------------
// Flash — §3.10: 1-frame Bone White flash on a hit victim. Phaser 4 split the
// old setTintFill call into a white tint plus TintModes.FILL (enum value 1).
// Keep the numeric mode here so this eagerly imported UI helper stays a
// type-only Phaser consumer; a runtime import would pull Phaser into first paint.
// ---------------------------------------------------------------------------

const FLASH_MS = 90;

/** 1-frame white flash on a sprite (hit victim). Plays even under reduce-motion
 *  (it's a hit-read cue, not large motion). */
export function flash(scene: Phaser.Scene, victim: Phaser.GameObjects.Sprite): void {
  if (!victim.active) return;
  victim.setTint(0xffffff).setTintMode(1);
  scene.time.delayedCall(FLASH_MS, () => victim.active && victim.clearTint?.());
}

// ---------------------------------------------------------------------------
// Float text — §3.10: damage/loot numbers pop above a target and rise. Delegates
// to the canonical scene-space implementation (fx/damagetext) so there is ONE
// pop animation; `gold` flags loot ticks.
// ---------------------------------------------------------------------------

/** Pop a rising number above (x,y) in scene/world space (delegates to popDamage). */
export function floatText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  amount: number,
  opts?: { gold?: boolean; prefix?: string },
): void {
  popDamage(scene, x, y, amount, opts);
}

// ---------------------------------------------------------------------------
// Haptics — §3.10 column: light/medium/heavy. Gated by the HAPTICS toggle and
// reduce-motion; silently no-ops where unsupported (desktop / iOS Safari).
// ---------------------------------------------------------------------------

export type Haptic = 'light' | 'medium' | 'heavy';

const PATTERN: Record<Haptic, number | number[]> = {
  light: 10,
  medium: 25,
  heavy: [35, 30, 45],
};

/** Fire a haptic buzz via navigator.vibrate, if enabled + supported. */
export function haptic(kind: Haptic): void {
  if (reduceMotionOn() || !hapticsOn()) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(PATTERN[kind]); } catch { /* unsupported / blocked */ }
}
