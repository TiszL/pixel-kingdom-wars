/** M22 Dragon-Nest hatchling: exact-current eager pose plus optional 8-way lifecycle. */
import {
  AUTHORED_ATTACK_TIMINGS, WARE_FALLBACK_ATLAS, artTierOfLevel, atlasGroupFor,
  wareHatchlingFallbackKey,
} from '@shardkeep/shared';
import type Phaser from 'phaser';
import {
  V2_DRAW_SCALE, emitterPoint, facing8Stable, facingRow, type Facing8,
} from '../v2/clips';
import type { V2Ticker } from '../v2/ticker';
import {
  wareFacingFrames, wareHatchlingClipKey, type WareClip, type WareClipMap,
} from './clips';
import { actorDepth } from '../world/depth';

type HatchlingState = 'spawning' | 'hovering' | 'moving' | 'acting' | 'hit' | 'dying' | 'dead';
const RICH_STATES = ['fly', 'hover', 'attack', 'spawn', 'hit', 'death'] as const;

export interface WareHatchlingDeps {
  ticker: V2Ticker;
  clips: WareClipMap;
  level: number;
  /** True only after the complete tier group was admitted and loaded. */
  rich: boolean;
}

export class WareHatchlingFx {
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly initialAtlas: string;
  readonly rich: boolean;
  private readonly tier: number;
  private state: HatchlingState = 'spawning';
  private facing: Facing8 = 's';
  private nearest: (() => { x: number; y: number } | null) | null = null;
  private generation = 0;

  constructor(
    private scene: Phaser.Scene,
    private deps: WareHatchlingDeps,
    x: number,
    y: number,
    depth: number,
  ) {
    this.tier = artTierOfLevel(deps.level);
    const hoverBase = wareHatchlingClipKey(deps.level, 'hover');
    const hover = deps.clips[hoverBase];
    const richAtlas = atlasGroupFor(`${hoverBase}_d0_f1`);
    this.rich = deps.rich
      && RICH_STATES.every((state) => !!deps.clips[wareHatchlingClipKey(deps.level, state)])
      && scene.textures.exists(richAtlas);
    this.initialAtlas = this.rich ? richAtlas : WARE_FALLBACK_ATLAS;
    const first = this.rich ? `${wareHatchlingClipKey(deps.level, 'spawn')}_d0_f1`
      : wareHatchlingFallbackKey(this.tier);
    const [ax, ay] = hover?.anchorPx ?? [hover?.cellW ?? 2, hover?.cellH ?? 2];
    this.sprite = scene.add.sprite(x, y, this.initialAtlas, first)
      .setOrigin(ax / (hover?.cellW ?? 2), ay / (hover?.cellH ?? 2))
      .setScale(V2_DRAW_SCALE)
      .setDepth(actorDepth(depth));
    if (this.rich) {
      this.play('spawn', false, undefined, () => this.hover());
    } else {
      this.state = 'hovering';
    }
  }

  get alive(): boolean { return this.state !== 'dying' && this.state !== 'dead'; }

  setNearestBuildingFn(fn: () => { x: number; y: number } | null): void {
    this.nearest = fn;
  }

  private clip(state: string): WareClip | undefined {
    return this.deps.clips[wareHatchlingClipKey(this.deps.level, state)];
  }

  private play(
    state: string,
    loop: boolean,
    onFrame?: (frame1: number, clip: WareClip, row: number) => void,
    onComplete?: () => void,
  ): boolean {
    if (!this.rich) return false;
    const base = wareHatchlingClipKey(this.deps.level, state);
    const clip = this.deps.clips[base];
    if (!clip) return false;
    const row = facingRow(clip, this.facing);
    const seq = wareFacingFrames(this.deps.clips, base, this.facing);
    if (seq.length === 0) return false;
    this.deps.ticker.play(this.sprite, {
      atlas: atlasGroupFor(seq[0]!), base, seq, fps: clip.fps ?? 12, loop,
      onFrame: onFrame ? (frame1) => onFrame(frame1, clip, row) : undefined,
      onComplete,
    });
    return true;
  }

  private hover(): void {
    if (!this.alive || !this.sprite.active) return;
    this.state = 'hovering';
    this.play('hover', true);
  }

  tickAttack(): void {
    if (this.state !== 'hovering') return;
    const target = this.nearest?.();
    if (!target) return;
    const next = facing8Stable(
      target.x - this.sprite.x, target.y - this.sprite.y, this.facing,
    );
    if (next === this.facing) return;
    this.facing = next;
    this.play('hover', true);
  }

  onPos(toX: number, toY: number, durationMs: number): void {
    if (!this.alive) return;
    const dx = toX - this.sprite.x;
    const dy = toY - this.sprite.y;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      this.hover();
      return;
    }
    this.facing = facing8Stable(dx, dy, this.facing);
    const generation = ++this.generation;
    this.state = 'moving';
    this.play('fly', true);
    this.scene.tweens.killTweensOf(this.sprite);
    this.scene.tweens.add({
      targets: this.sprite, x: toX, y: toY, duration: durationMs, ease: 'Linear',
      onUpdate: () => this.sprite.setDepth(actorDepth(this.sprite.y)),
      onComplete: () => {
        if (generation === this.generation && this.alive) this.hover();
      },
    });
  }

  /** Absolute replay seek; unlike a duration-0 tween this is visible before
   * the verdict/cold frame is rendered. */
  snapPosition(toX: number, toY: number): void {
    if (!this.alive) return;
    this.generation++;
    this.scene.tweens.killTweensOf(this.sprite);
    this.sprite.setPosition(toX, toY).setDepth(actorDepth(toY));
    this.hover();
  }

  /** End an elapsed spawn/attack transition at its persistent hover state. */
  finishSeek(): void {
    this.hover();
  }

  onRangedAttack(
    targetX: number,
    targetY: number,
    onRelease: (at: { x: number; y: number }) => void,
  ): void {
    if (!this.alive) return;
    this.facing = facing8Stable(targetX - this.sprite.x, targetY - this.sprite.y, this.facing);
    const generation = ++this.generation;
    this.state = 'acting';
    let released = false;
    const release = (clip?: WareClip, row = 0, frame1 = 1): void => {
      if (released) return;
      released = true;
      const [ax, ay] = clip?.anchorPx ?? [clip?.cellW ?? 2, clip?.cellH ?? 2];
      const [mx, my] = clip ? emitterPoint(clip, 'maw', row, frame1 - 1) : [ax, ay];
      onRelease({
        x: this.sprite.x + (mx - ax) * V2_DRAW_SCALE,
        y: this.sprite.y + (my - ay) * V2_DRAW_SCALE,
      });
    };
    if (!this.play('attack', false, (frame1, clip, row) => {
      if (frame1 === AUTHORED_ATTACK_TIMINGS.wyrmling.releaseFrame) release(clip, row, frame1);
    }, () => {
      if (generation !== this.generation || !this.alive) return;
      release(this.clip('attack'), facingRow(this.clip('attack')!, this.facing),
        AUTHORED_ATTACK_TIMINGS.wyrmling.releaseFrame);
      this.hover();
    })) {
      // The eager alias is still current authored art. It releases from its
      // published anchor immediately and never touches the retired Wyrmling.
      release(this.clip('hover'), 0, 1);
      this.hover();
    }
  }

  onHit(): void {
    if (!this.alive || !this.rich) return;
    const generation = ++this.generation;
    this.state = 'hit';
    this.play('hit', false, undefined, () => {
      if (generation === this.generation && this.alive) this.hover();
    });
  }

  onDeath(): void {
    if (!this.alive) return;
    ++this.generation;
    this.state = 'dying';
    this.scene.tweens.killTweensOf(this.sprite);
    const finish = (): void => {
      if (!this.sprite.active) return;
      this.scene.tweens.add({
        targets: this.sprite, alpha: 0, duration: 400,
        onComplete: () => { this.state = 'dead'; this.sprite.destroy(); },
      });
    };
    if (!this.play('death', false, undefined, finish)) finish();
  }

  destroy(): void {
    ++this.generation;
    this.scene.tweens.killTweensOf(this.sprite);
    this.deps.ticker.unregister(this.sprite);
    this.state = 'dead';
    this.sprite.destroy();
  }
}
