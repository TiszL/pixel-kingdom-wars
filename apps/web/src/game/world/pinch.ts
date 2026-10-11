/**
 * Pinch-to-zoom (HANDOFF §5.2, read-app-engines §3): two-pointer distance ratio
 * drives zoom = clamp(z0 · d/d0, min, max) — the band defaults to the base
 * view's 0.55–1.6 and is overridable per scene. A second finger landing cancels any
 * pan/drag and starts pinch; releasing either finger ends it. The optional
 * callback reports direct gesture zoom to a scene without becoming a HUD command.
 *
 * Returns helpers the scene wires into its pointer handlers; `active()` lets the
 * pan/drag code bail while a pinch is in progress (App: pan disabled during
 * pinch).
 */
import Phaser from 'phaser';
import { ZOOM_MAX, ZOOM_MIN } from './camera';

export class PinchZoom {
  private startDist = 0;
  private startZoom = 1;
  private engaged = false;
  private min: number = ZOOM_MIN;
  private max: number = ZOOM_MAX;

  constructor(
    private cam: Phaser.Cameras.Scene2D.Camera,
    /** Direct-gesture observer; must never emit a multiplier command back here. */
    private emitZoom: (factor: number) => void,
    /** Optional zoom band. Defaults to the BASE view's 0.55–1.6; the RAID camera
     *  passes a much wider, viewport-derived band (RAID_CAMERA) because its
     *  battlefield is 38 tiles wide and its floor has to be computed per device.
     *  Left as a ctor option because each scene owns a different live band. */
    limits?: { min: number; max: number },
  ) {
    if (limits) this.setLimits(limits.min, limits.max);
  }

  /** Re-band the pinch (the raid camera recomputes its floor on viewport resize). */
  setLimits(min: number, max: number): void {
    this.min = min;
    this.max = max;
  }

  /** True while two pointers are down — pan/single-drag must yield. */
  active(): boolean {
    return this.engaged;
  }

  /**
   * Call on every pointermove. Returns true if it consumed the event (a pinch
   * was applied) so the caller skips pan. Uses the live pointer pair off input.
   */
  onMove(p1: Phaser.Input.Pointer, p2: Phaser.Input.Pointer): boolean {
    if (!p1.isDown || !p2.isDown) {
      this.engaged = false;
      return false;
    }
    const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
    if (!this.engaged) {
      // engage on the second finger: snapshot the baseline distance + zoom
      this.engaged = true;
      this.startDist = dist || 1;
      this.startZoom = this.cam.zoom;
      return true;
    }
    if (this.startDist <= 0) return true;
    const z = Phaser.Math.Clamp((this.startZoom * dist) / this.startDist, this.min, this.max);
    if (z !== this.cam.zoom) {
      this.cam.setZoom(z);
      this.emitZoom(z);
    }
    return true;
  }

  /** Call on pointerup/cancel: a finger lifting ends the pinch. */
  onUp(): void {
    this.engaged = false;
    this.startDist = 0;
  }
}
