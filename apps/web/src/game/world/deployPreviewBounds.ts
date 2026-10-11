import type Phaser from 'phaser';
import { atlasTexelStep, frameTexelRect } from './atlasTexels';

interface Bounds { left: number; top: number; right: number; bottom: number }
const frameBounds = new WeakMap<Phaser.Textures.Frame, Bounds>();

/** Every nontransparent texel belongs to the visible body, including soft edges.
 * Atlas padding does not. Empty animation frames have no visible envelope. */
export function opaqueTexelBounds(data: ArrayLike<number>, width: number, height: number): Bounds {
  let left = width, top = height, right = 0, bottom = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1);
    }
  }
  return right === 0 ? { left: 0, top: 0, right: 0, bottom: 0 } : { left, top, right, bottom };
}

/** Project the admitted frame's visible pixels, respecting logical @1x upscale,
 * origin, flip, scale and parent transforms. Weak frame keys cannot retain an
 * evicted atlas. Unreadable images retain the conservative full-sprite guard. */
export function deploySpriteBodyBounds(sprite: Phaser.GameObjects.Sprite): Bounds {
  const fallback = (): Bounds => sprite.getBounds();
  const frame = sprite.frame;
  if (!frame?.source?.image || frame.rotated || typeof document === 'undefined') return fallback();
  try {
    let body = frameBounds.get(frame);
    if (!body) {
      const source = frameTexelRect(sprite.texture, frame);
      const canvas = document.createElement('canvas');
      canvas.width = source.w; canvas.height = source.h;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return fallback();
      context.drawImage(frame.source.image as CanvasImageSource, source.x, source.y,
        source.w, source.h, 0, 0, source.w, source.h);
      const texels = opaqueTexelBounds(context.getImageData(0, 0, source.w, source.h).data,
        source.w, source.h);
      const step = atlasTexelStep(sprite.texture);
      body = {
        left: frame.x + texels.left * step, top: frame.y + texels.top * step,
        right: frame.x + texels.right * step, bottom: frame.y + texels.bottom * step,
      };
      frameBounds.set(frame, body);
    }
    if (body.left === body.right || body.top === body.bottom) {
      return { left: sprite.x, top: sprite.y, right: sprite.x, bottom: sprite.y };
    }
    const left = (sprite.flipX ? frame.realWidth - body.right : body.left) - sprite.displayOriginX;
    const right = (sprite.flipX ? frame.realWidth - body.left : body.right) - sprite.displayOriginX;
    const top = (sprite.flipY ? frame.realHeight - body.bottom : body.top) - sprite.displayOriginY;
    const bottom = (sprite.flipY ? frame.realHeight - body.top : body.bottom) - sprite.displayOriginY;
    const matrix = sprite.getWorldTransformMatrix();
    const points = [[left, top], [right, top], [left, bottom], [right, bottom]]
      .map(([x, y]) => matrix.transformPoint(x!, y!));
    return {
      left: Math.min(...points.map((p) => p.x)), top: Math.min(...points.map((p) => p.y)),
      right: Math.max(...points.map((p) => p.x)), bottom: Math.max(...points.map((p) => p.y)),
    };
  } catch {
    return fallback();
  }
}
