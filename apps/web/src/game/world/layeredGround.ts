/** Explicit art-review adapter. There is no live scene/default selector here.
 * A replacement stays private until all pages are ready; the caller swaps it in
 * only after prepare() resolves, retaining its current valid scene meanwhile. */
import type Phaser from 'phaser';
import { assertLayeredGroundManifest, layeredDrawPlan, layeredFloorPlan, LAYERED_GROUND_LIMITS,
  type LayeredGroundManifest, type LayeredRect } from '@shardkeep/shared/layeredGround';
import type { BaseVisualContext } from '@shardkeep/shared/baseVisual';
import { layeredGroundDescriptor } from '@shardkeep/shared/layeredGroundCatalogue';
import { downloadGround } from './groundDownload';
import { versionedPublicAsset } from '../../lib/version';

export interface LayeredGroundProgress { phase: 'download' | 'verify' | 'decode' | 'upload' | 'ready'; completed: number; total: number }
export type LayeredGroundReporter = (progress: LayeredGroundProgress) => void;
let nextInstance = 0, resident = 0;
export class LayeredGround {
  private readonly id = ++nextInstance;
  private readonly keys = new Map<string, string>();
  private readonly images = new Map<string, Phaser.GameObjects.Image>();
  private readonly floor: Phaser.GameObjects.Image[] = [];
  private material?: Phaser.GameObjects.TileSprite;
  private stopListening: (() => void) | undefined;
  private destroyed = false;
  private elapsed = 0;
  private constructor(private scene: Phaser.Scene, readonly manifest: LayeredGroundManifest, private tilePixels: number) {}
  static async prepareContext(scene: Phaser.Scene, context: BaseVisualContext, tilePixels: number, signal: AbortSignal, report: LayeredGroundReporter = () => {}): Promise<LayeredGround> {
    const descriptor = layeredGroundDescriptor(context);
    const bytes = await downloadGround(versionedPublicAsset(`/${descriptor.manifestPath}`), signal, p => report({ phase: 'download', completed: p.completed, total: descriptor.size }), { maxBytes: 256 * 1024 });
    report({ phase: 'verify', completed: bytes.byteLength, total: descriptor.size });
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (bytes.byteLength !== descriptor.size || bytes.byteLength > 256 * 1024 || sha256 !== descriptor.sha256) throw new Error('Layered manifest integrity mismatch');
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    assertLayeredGroundManifest(value);
    if (value.realmId !== context.realmId || value.groundRevision !== context.groundRevision || value.status !== 'accepted') throw new Error('Layered manifest disagrees with its frozen context');
    return this.prepare(scene, value, tilePixels, signal, p => report({ ...p, completed: p.completed + bytes.byteLength, total: p.total + bytes.byteLength }));
  }
  static async prepare(scene: Phaser.Scene, value: unknown, tilePixels: number, signal: AbortSignal, report: LayeredGroundReporter = () => {}, previewAllowed = false): Promise<LayeredGround> {
    assertLayeredGroundManifest(value);
    if (value.status !== 'accepted' && !previewAllowed) throw new Error('Unapproved layered artwork requires a preview host');
    if (!Number.isFinite(tilePixels) || tilePixels <= 0 || resident >= LAYERED_GROUND_LIMITS.residentRealms) throw new Error('Layered preview residency unavailable');
    const result = new LayeredGround(scene, value, tilePixels); resident++;
    const callerSignal = signal, abort = new AbortController();
    const cancelled = () => abort.abort(callerSignal.reason);
    const stopped = () => { abort.abort(new Error('Layered preview scene stopped')); result.destroy(); };
    callerSignal.addEventListener('abort', cancelled, { once: true });
    scene.events.once('shutdown', stopped);
    result.stopListening = () => scene.events.off('shutdown', stopped);
    if (callerSignal.aborted) cancelled(); signal = abort.signal;
    try {
      let completed = 0; const total = value.assets.reduce((sum, asset) => sum + asset.size, 0);
      // One hash/decode/upload page at a time; cancellation cannot leave orphan
      // textures in a later scene or enqueue obsolete visual preparations.
      for (const asset of value.assets) {
        signal.throwIfAborted(); await foregroundFrame(signal);
        const bytes = await downloadGround(versionedPublicAsset(`/${asset.path}`), signal, p => report({ phase: 'download', completed: completed + p.completed, total }), { maxBytes: asset.size });
        completed += bytes.byteLength; report({ phase: 'verify', completed, total });
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== asset.size || hash !== asset.sha256) throw new Error('Layered preview integrity mismatch');
        const url = URL.createObjectURL(new Blob([bytes], { type: asset.path.endsWith('.webp') ? 'image/webp' : 'image/png' }));
        try {
          report({ phase: 'decode', completed, total });
          const image = new Image(); image.src = url; await image.decode(); signal.throwIfAborted();
          if (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height) throw new Error('Layered preview dimensions mismatch');
          await foregroundFrame(signal);
          report({ phase: 'upload', completed, total });
          const key = `layered-preview-${result.id}-${asset.sha256}`;
          scene.textures.addSpriteSheet(key, image, { frameWidth: asset.frameWidth, frameHeight: asset.frameHeight });
          result.keys.set(asset.id, key);
        } finally { URL.revokeObjectURL(url); }
      }
      signal.throwIfAborted();
      for (const p of value.placements) result.images.set(p.id, scene.add.image(0, 0, result.keys.get(p.asset)!, 0).setOrigin(0).setDepth(1 + p.layer).setVisible(false));
      report({ phase: 'ready', completed, total });
      return result;
    } catch (error) { result.destroy(); throw error; }
    finally { callerSignal.removeEventListener('abort', cancelled); }
  }
  update(view: LayeredRect, deltaMs: number, reducedMotion: boolean, background = false): void {
    if (this.destroyed) return;
    const visible = !background && !document.hidden;
    for (const image of [...this.images.values(), ...this.floor]) image.setVisible(false);
    this.material?.setVisible(false);
    if (!visible) return;
    if (!reducedMotion && Number.isFinite(deltaMs) && deltaMs > 0) this.elapsed += Math.min(deltaMs, 100);
    const m = this.manifest, scale = this.tilePixels / m.tilePixels;
    if (m.ground.sampling === 'repeat') {
      this.material ??= this.scene.add.tileSprite(0, 0, 1, 1, this.keys.get(m.ground.asset)!, 0).setOrigin(0).setDepth(0);
      this.material.setPosition(view.x, view.y).setSize(view.width / scale, view.height / scale).setScale(scale).setVisible(true);
      this.material.tilePositionX = view.x / scale; this.material.tilePositionY = view.y / scale;
    } else {
      let tileIndex = 0;
      for (const draw of layeredFloorPlan(m, this.tilePixels, view)) {
        if (draw.repeat) {
          this.material ??= this.scene.add.tileSprite(0, 0, 1, 1, this.keys.get(draw.asset.id)!, 0).setOrigin(0).setDepth(0);
          const sx = draw.repeat.period.width / draw.asset.width, sy = draw.repeat.period.height / draw.asset.height;
          this.material.setPosition(view.x, view.y).setSize(view.width, view.height).setScale(1).setTileScale(sx, sy).setVisible(true);
          // Phaser's tile position is measured in source texels, independently
          // of object scale. Fixed world phase prevents scenery moving on pan.
          this.material.tilePositionX = (view.x - draw.repeat.origin.x) / sx;
          this.material.tilePositionY = (view.y - draw.repeat.origin.y) / sy;
          continue;
        }
        const texture = this.scene.textures.get(this.keys.get(draw.asset.id)!);
        const frame = `perimeter-${draw.source.x}-${draw.source.y}-${draw.source.width}-${draw.source.height}`;
        if (!texture.has(frame)) texture.add(frame, 0, draw.source.x, draw.source.y, draw.source.width, draw.source.height);
        const image = this.floor[tileIndex] ??= this.scene.add.image(0, 0, texture.key, frame).setOrigin(0).setDepth(0);
        if (m.groundRevision === 4) image.setTexture(texture.key, frame).setDepth(draw.asset.id === m.ground.asset ? 0.2 : 0.1);
        else image.setFrame(frame);
        image.setPosition(draw.destination.x, draw.destination.y)
          .setDisplaySize(draw.destination.width, draw.destination.height).setFlip(draw.flipX ?? false, draw.flipY ?? false).setVisible(true);
        tileIndex++;
      }
    }
    for (const draw of layeredDrawPlan(m, this.tilePixels, view, this.elapsed, reducedMotion)) {
      this.images.get(draw.id)!.setPosition(draw.destination.x, draw.destination.y).setDisplaySize(draw.destination.width, draw.destination.height).setFrame(draw.frame).setVisible(true);
    }
  }
  destroy(): void {
    if (this.destroyed) return; this.destroyed = true;
    this.stopListening?.(); this.stopListening = undefined;
    for (const image of [...this.images.values(), ...this.floor]) image.destroy();
    this.material?.destroy(); for (const key of this.keys.values()) this.scene.textures.remove(key);
    this.images.clear(); this.floor.length = 0; this.keys.clear(); resident--;
  }
}
function foregroundFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = () => { cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', schedule); signal.removeEventListener('abort', aborted); };
    const aborted = () => { finish(); reject(signal.reason); };
    let frame = 0;
    const schedule = () => {
      if (document.hidden || frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (document.hidden) return; finish(); resolve(); });
    };
    signal.addEventListener('abort', aborted, { once: true }); document.addEventListener('visibilitychange', schedule);
    if (signal.aborted) aborted(); else schedule();
  });
}

/** Art-only review entry point. Gameplay callers use LayeredGround.prepare,
 * which admits accepted manifests only. */
export const LayeredGroundPreview = {
  prepare(scene: Phaser.Scene, value: unknown, tilePixels: number, signal: AbortSignal): Promise<LayeredGround> {
    return LayeredGround.prepare(scene, value, tilePixels, signal, undefined, true);
  },
};
