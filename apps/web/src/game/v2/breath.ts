/** Connected three-part Dragon flame stream. Root is pinned to the maw, one
 * tileable middle spans the full gap, and the tip anchor sits on the target. */
import { atlasGroupFor } from '@shardkeep/shared';
import type Phaser from 'phaser';
import { frameName, V2_DRAW_SCALE, type V2Clip, type V2ClipMap } from './clips';
import { combatEffectPool, type EffectHandle } from './effects';
import { overlayDepth } from '../world/depth';

const DEPTH_STREAM = overlayDepth(2680);

export class BreathStream {
  private readonly container: Phaser.GameObjects.Container;
  private readonly root: Phaser.GameObjects.Image | null;
  private readonly mid: Phaser.GameObjects.TileSprite | null;
  private readonly tip: Phaser.GameObjects.Image | null;
  private readonly rootClip: V2Clip | undefined;
  private readonly midClip: V2Clip | undefined;
  private readonly tipClip: V2Clip | undefined;
  private readonly rootBase: string | null;
  private readonly midBase: string | null;
  private readonly tipBase: string | null;
  private readonly clock: EffectHandle | null;
  private frame = 0;
  private destroyed = false;

  constructor(
    scene: Phaser.Scene,
    clips: V2ClipMap,
    tier: number,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    baseFor?: (metaBase: string) => string | null,
  ) {
    const resolve = (meta: string): string | null => baseFor ? baseFor(meta) : meta;
    const rootMeta = `v2_fx_stream_root_t${tier}`;
    const midMeta = `v2_fx_stream_mid_t${tier}`;
    const tipMeta = `v2_fx_stream_tip_t${tier}`;
    this.rootClip = clips[rootMeta];
    this.midClip = clips[midMeta];
    this.tipClip = clips[tipMeta];
    this.rootBase = resolve(rootMeta);
    this.midBase = resolve(midMeta);
    this.tipBase = resolve(tipMeta);
    // DELIBERATELY the bare pack conversion, and the one v2 emission that is.
    // When every projectile was made to inherit its firer's fit (2026-08-30,
    // projectiles.ts V2ArtFit) the dragon was the stated exception: the owner
    // reports its fx as already correct, and the stream is not a projectile —
    // it is geometry assembled from the maw to the target, whose LENGTH is the
    // range and whose thickness is the authored flame. Scaling it would also
    // scale `update()`'s `distance / V2_DRAW_SCALE` and detach the tip from the
    // target. If the dragon's flame is ever refitted, both must move together.
    this.container = scene.add.container(fromX, fromY)
      .setDepth(DEPTH_STREAM)
      .setScale(V2_DRAW_SCALE);

    if (!this.rootClip || !this.midClip || !this.tipClip
      || !this.rootBase || !this.midBase || !this.tipBase) {
      this.root = null;
      this.mid = null;
      this.tip = null;
      this.clock = null;
      return;
    }
    const rootAtlas = atlasGroupFor(frameName(this.rootBase, this.rootClip, 0, 1));
    const midAtlas = atlasGroupFor(frameName(this.midBase, this.midClip, 0, 1));
    const tipAtlas = atlasGroupFor(frameName(this.tipBase, this.tipClip, 0, 1));
    if (!scene.textures.exists(rootAtlas)
      || !scene.textures.exists(midAtlas)
      || !scene.textures.exists(tipAtlas)) {
      this.root = null;
      this.mid = null;
      this.tip = null;
      this.clock = null;
      return;
    }

    const [rootAx, rootAy] = this.rootClip.anchorPx ?? [4, this.rootClip.cellH / 2];
    const [tipAx, tipAy] = this.tipClip.anchorPx ?? [0, this.tipClip.cellH / 2];
    this.root = scene.add.image(
      0, 0, rootAtlas, frameName(this.rootBase, this.rootClip, 0, 1),
    ).setOrigin(rootAx / this.rootClip.cellW, rootAy / this.rootClip.cellH);
    this.mid = scene.add.tileSprite(
      0, 0, 1, this.midClip.cellH,
      midAtlas, frameName(this.midBase, this.midClip, 0, 1),
    ).setOrigin(0, 0.5);
    this.tip = scene.add.image(
      0, 0, tipAtlas, frameName(this.tipBase, this.tipClip, 0, 1),
    ).setOrigin(tipAx / this.tipClip.cellW, tipAy / this.tipClip.cellH);
    this.container.add([this.root, this.mid, this.tip]);
    this.update(fromX, fromY, toX, toY);

    const stepMs = 1000 / (this.rootClip.fps ?? 14);
    this.clock = combatEffectPool(scene).addLoop(
      (elapsed) => {
        const next = Math.floor(elapsed / stepMs) % this.rootClip!.frames;
        if (next === this.frame) return;
        this.frame = next;
        this.root?.setTexture(rootAtlas, frameName(this.rootBase!, this.rootClip!, 0, next + 1));
        this.mid?.setTexture(midAtlas, frameName(this.midBase!, this.midClip!, 0, next + 1));
        this.tip?.setTexture(tipAtlas, frameName(this.tipBase!, this.tipClip!, 0, next + 1));
      },
      () => this.disposeVisual(),
    );
  }

  /** Reattach on every render update while actor and target can move. */
  update(fromX: number, fromY: number, toX: number, toY: number): void {
    if (this.destroyed || !this.rootClip || !this.midClip || !this.tipClip) return;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const distance = Math.hypot(dx, dy) / V2_DRAW_SCALE;
    const rootAx = this.rootClip.anchorPx?.[0] ?? 4;
    const rootEnd = Math.max(0, this.rootClip.cellW - rootAx);
    const middleWidth = Math.max(1, distance - rootEnd);
    this.container.setPosition(fromX, fromY).setRotation(Math.atan2(dy, dx));
    this.mid?.setPosition(rootEnd, 0).setSize(middleWidth, this.midClip.cellH);
    this.tip?.setPosition(distance, 0);
  }

  destroy(): void {
    this.clock?.cancel();
    this.disposeVisual();
  }

  private disposeVisual(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.container.destroy(true);
  }
}
