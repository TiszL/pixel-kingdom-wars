/**
 * Direwyvern burn-field replay decal.
 *
 * The simulator owns the patch centre and its exclusive `until` tick. This
 * class only turns that interval into the owner's four authored frames: 1–2
 * loop while live, then 3–4 play once as the fire goes out. Keeping the timer
 * here (instead of a generic one-shot FX helper) lets BattleScene explicitly
 * destroy/rebuild live zones when a replay stream is replaced.
 */
import { atlasGroupFor, v2DirewyvernFxBaseKey } from '@shardkeep/shared';
import type Phaser from 'phaser';
import { frameName, V2_DRAW_SCALE, type V2ClipMap } from './clips';
import { buildingDepth } from '../world/depth';

export interface BurnfieldFrames {
  atlas: string;
  live: readonly [string, string];
  extinguish: readonly [string, string];
  stepMs: number;
  origin: readonly [number, number];
}

/** Validate the exact four-frame owner contract before creating any object. */
export function burnfieldFrames(
  clips: V2ClipMap,
  tier: number,
  direShard = false,
): BurnfieldFrames | null {
  const metaBase = `v2_fx_burnfield_t${tier}`;
  const base = direShard ? v2DirewyvernFxBaseKey('burnfield', tier) : metaBase;
  const clip = clips[metaBase];
  if (!clip || clip.frames < 4 || clip.cellW <= 0 || clip.cellH <= 0) return null;
  const [ax, ay] = clip.anchorPx ?? [clip.cellW / 2, clip.cellH / 2];
  const first = frameName(base, clip, 0, 1);
  return {
    atlas: atlasGroupFor(first),
    live: [first, frameName(base, clip, 0, 2)],
    extinguish: [frameName(base, clip, 0, 3), frameName(base, clip, 0, 4)],
    stepMs: 1000 / (clip.fps ?? 6),
    origin: [ax / clip.cellW, ay / clip.cellH],
  };
}

export class BurnfieldFx {
  private sprite: Phaser.GameObjects.Image | null = null;
  private loopTimer: Phaser.Time.TimerEvent | null = null;
  private expireTimer: Phaser.Time.TimerEvent | null = null;
  private finishTimer: Phaser.Time.TimerEvent | null = null;
  private liveFrame = 0;

  constructor(
    private readonly scene: Phaser.Scene,
    clips: V2ClipMap,
    tier: number,
    x: number,
    y: number,
    liveMs: number,
    direShard = false,
  ) {
    const frames = burnfieldFrames(clips, tier, direShard);
    if (!frames || liveMs <= 0 || !scene.textures.exists(frames.atlas)) return;
    this.sprite = scene.add.image(x, y, frames.atlas, frames.live[0])
      .setOrigin(frames.origin[0], frames.origin[1])
      .setScale(V2_DRAW_SCALE)
      .setDepth(buildingDepth(y) - 1);
    this.loopTimer = scene.time.addEvent({
      delay: frames.stepMs,
      loop: true,
      callback: () => {
        if (!this.sprite?.active) return;
        this.liveFrame = this.liveFrame === 0 ? 1 : 0;
        this.sprite.setTexture(frames.atlas, frames.live[this.liveFrame]);
      },
    });
    this.expireTimer = scene.time.delayedCall(liveMs, () => {
      this.expireTimer = null;
      this.loopTimer?.remove();
      this.loopTimer = null;
      if (!this.sprite?.active) return;
      this.sprite.setTexture(frames.atlas, frames.extinguish[0]);
      this.finishTimer = scene.time.delayedCall(frames.stepMs, () => {
        this.finishTimer = null;
        if (!this.sprite?.active) return;
        this.sprite.setTexture(frames.atlas, frames.extinguish[1]);
        this.finishTimer = scene.time.delayedCall(frames.stepMs, () => {
          this.finishTimer = null;
          this.destroy();
        });
      });
    });
  }

  get active(): boolean {
    return this.sprite?.active === true;
  }

  destroy(): void {
    this.loopTimer?.remove();
    this.expireTimer?.remove();
    this.finishTimer?.remove();
    this.loopTimer = null;
    this.expireTimer = null;
    this.finishTimer = null;
    this.sprite?.destroy();
    this.sprite = null;
  }
}
