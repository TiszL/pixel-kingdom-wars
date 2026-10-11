/**
 * Drag-polish FX (HANDOFF §5, read-app-engines §1): the detached lift shadow
 * that stays at ground level while a piece is lifted, and the 2-frame dust
 * puff played on every valid drop / job completion.
 *
 * App parity:
 *  - dustAt: fx_dust_f1 sized fw*32 × 32 at (x, yB−24) z2600; → f2 @150ms;
 *    remove @320ms. (read-app-engines §1; App dustAt line 455.)
 *  - lift shadow: ovl_lift_shadow_{fw}x{fh} at ground level, z2340; height is
 *    32 App px if fh>1 else 16 (we use the sprite's own footprint atlas frame).
 *
 * Scene renders 2× → world px = App px × (T/32). Anchors come from meta
 * (dust f1/f2 are [0.5,0.5]; lift shadows are [0.5,0.5]).
 */
import type Phaser from 'phaser';
import { atlasFor } from '../scenes/BootScene';
import { overlayDepth } from './depth';

// Both are drag/drop polish drawn ON the world, so they live in
// WORLD_DEPTH.overlay with their original relative ranks: the lift shadow under
// the carried piece (LIFT_DEPTH 2500), the drop dust over it.
const DUST_DEPTH = overlayDepth(2600);
const SHADOW_DEPTH = overlayDepth(2340);

/** Two-frame dust puff at a footprint, removed ~320ms later. */
export function dustPuff(
  scene: Phaser.Scene,
  worldX: number,
  bottomY: number,
  fw: number,
  T: number,
): void {
  const s = T / 32;
  // App: at (x, yB−24) top-left, sized fw*32 × 32 → center = (x + fw*16, yB−24 + 16)
  const cx = worldX + (fw * 32 * s) / 2;
  const cy = bottomY - 24 * s + (32 * s) / 2;
  const d = scene.add.image(cx, cy, atlasFor('fx_dust_f1'), 'fx_dust_f1').setDepth(DUST_DEPTH);
  d.setDisplaySize(fw * 32 * s, 32 * s);
  scene.time.delayedCall(150, () => d.active && d.setTexture(atlasFor('fx_dust_f2'), 'fx_dust_f2'));
  scene.time.delayedCall(320, () => d.destroy());
}

/** Lift-shadow image for a footprint, placed at ground level. Caller owns it. */
export function liftShadow(
  scene: Phaser.Scene,
  worldX: number,
  bottomY: number,
  fw: number,
  fh: number,
  T: number,
): Phaser.GameObjects.Image {
  // pick the matching shadow master (1x1 / 2x1 / 2x2); fall back to 1x1
  const key = fw >= 2 && fh >= 2 ? 'ovl_lift_shadow_2x2' : fw >= 2 ? 'ovl_lift_shadow_2x1' : 'ovl_lift_shadow_1x1';
  // ground level = footprint bottom edge; shadow anchor is center, so sit it on
  // the south edge of the footprint (one tile band up from bottomY).
  const cx = worldX + (fw * T) / 2;
  const band = fh > 1 ? T : T / 2; // App: 32px tall if fh>1 else 16px
  const cy = bottomY - band / 2;
  return scene.add.image(cx, cy, atlasFor(key), key).setDepth(SHADOW_DEPTH);
}
