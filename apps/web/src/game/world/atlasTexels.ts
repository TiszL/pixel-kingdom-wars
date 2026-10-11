/**
 * @1x texels in @2x frame space — how a constrained device draws the
 * historical atlases from their @1x files without any consumer changing
 * (D-101 residency; `deviceAtlasScale` in @shardkeep/shared picks the file).
 *
 * WHY NOT JUST LOAD THE @1x ATLAS. The client world is @2x: `T = 64` world px
 * per 32-px tile, `V2_DRAW_SCALE = 2`, and every sprite cut from a historical
 * atlas is drawn at scale 1 on the assumption that its frame is @2x pixels.
 * Anchors are normalised, but `sourceScale` seats, the baked KEEP-clock pivots
 * (`meta.json keepClock.levels`, multiplied by the eager scale at asset-build
 * time), hit areas and `displayHeight` seating all live in that frame space.
 * Loading a @1x file the plain way halves every one of them.
 *
 * WHAT THIS DOES INSTEAD. Phaser receives the @1x file and @1x JSON. Frame
 * sizes and trim geometry are expanded into the historical @2x logical space,
 * while `Frame.setUVs` is then given the ORIGINAL source-pixel rectangle. The
 * distinction matters: free-tex-packer keeps padding at three pixels at both
 * scales, so @2x packed x/y coordinates are NOT simply twice @1x coordinates.
 * Multiplying the packed x/y would sample neighbouring sprites. The GPU source
 * stays at its real @1x dimensions (and residency accounting therefore stays
 * truthful); only each frame's drawn quad is twice as large.
 *
 * WHAT MUST READ TEXELS INSTEAD. Anything that reads the source IMAGE through
 * frame coordinates is now off by the texel step: the grass bake's
 * `drawImage(cut…)` and the pixel-perfect hit test (`getPixelAlpha` draws the
 * cut pixel onto a 1×1 canvas). Both go through the helpers below. The Canvas
 * renderer draws sprites the same way, which is why BootScene only chooses a
 * @1x file under WebGL.
 */
import type Phaser from 'phaser';
import type { DeviceArtProfile } from '@shardkeep/shared';

/** Game registry key BootScene publishes the session's profile under, so the
 *  on-demand loader fetches `trpdg_l<N>` at the same density as the eager set. */
export const ART_PROFILE_REGISTRY_KEY = 'artProfile';

export function sceneArtProfile(scene: Phaser.Scene): DeviceArtProfile {
  const stored = (scene.registry as { get?: (key: string) => unknown } | undefined)
    ?.get?.(ART_PROFILE_REGISTRY_KEY);
  return stored === 'constrained' ? 'constrained' : 'full';
}

/** The free-tex-packer JSONArray frame fields Phaser's parser reads. */
interface PackerFrame {
  filename: string;
  rotated?: boolean;
  trimmed?: boolean;
  frame: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
}

interface StampedSource {
  width: number;
  height: number;
  image?: { naturalWidth?: number; width?: number } | null;
}

interface LogicalFrame extends Phaser.Textures.Frame {
  setUVs(width: number, height: number, u0: number, v0: number, u1: number, v1: number): this;
}

/** Logical-frame expansion is WebGL-only: Canvas draws from cutWidth/cutHeight
 * and cannot separate source texels from logical quad pixels as WebGL UVs can. */
export function supportsLogicalAtlasUpscale(scene: Phaser.Scene): boolean {
  return Boolean((scene.game?.renderer as { gl?: unknown } | undefined)?.gl);
}

const texelSteps = new WeakMap<Phaser.Textures.Texture, number>();

/**
 * Register `frames` (packer JSONArray) over `image` as texture `key`, with
 * frame sizes/trim geometry expressed `texelStep` times larger than the
 * image's pixels while packed x/y remain source-texel coordinates.
 * `texelStep` 1 is the plain historical path; 2 draws a @1x file into @2x
 * frame space. Rotated frames cannot be re-spaced and are refused loudly —
 * the scripts test keeps the pack unrotated, so this is a packer regression,
 * not a runtime case.
 */
export function stitchAtlas(
  scene: Phaser.Scene,
  key: string,
  image: HTMLImageElement,
  frames: unknown[],
  texelStep: number,
): void {
  if (texelStep === 1) {
    scene.textures.addAtlas(key, image, { frames } as never);
    return;
  }
  const input = frames as PackerFrame[];
  const spaced = input.map((f) => {
    if (f.rotated) throw new Error(`atlas ${key}: rotated frame ${f.filename} cannot be re-spaced`);
    return {
      ...f,
      frame: {
        // x/y address the source image and remain real @1x texel positions.
        x: f.frame.x, y: f.frame.y,
        w: f.frame.w * texelStep, h: f.frame.h * texelStep,
      },
      ...(f.sourceSize && {
        sourceSize: { w: f.sourceSize.w * texelStep, h: f.sourceSize.h * texelStep },
      }),
      ...(f.spriteSourceSize && {
        spriteSourceSize: {
          x: f.spriteSourceSize.x * texelStep, y: f.spriteSourceSize.y * texelStep,
          w: f.spriteSourceSize.w * texelStep, h: f.spriteSourceSize.h * texelStep,
        },
      }),
    };
  });
  scene.textures.addAtlas(key, image, { frames: spaced } as never);
  const texture = scene.textures.get(key);
  texelSteps.set(texture, texelStep);
  const source = texture.source[0] as unknown as StampedSource;
  const sourceWidth = image.naturalWidth || image.width || source.width;
  const sourceHeight = image.naturalHeight || image.height || source.height;
  for (const packed of input) {
    const frame = texture.get(packed.filename) as LogicalFrame;
    const { x, y, w, h } = packed.frame;
    // Keep Canvas draw data on the real source rectangle and override the UVs
    // that addAtlas derived from the expanded logical cutWidth/cutHeight.
    frame.setUVs(
      w, h,
      x / sourceWidth, 1 - y / sourceHeight,
      (x + w) / sourceWidth, 1 - (y + h) / sourceHeight,
    );
  }
}

/** Frame-space pixels per source texel: 1 for a natively-spaced atlas, 2 for a
 *  @1x file stitched into @2x space. The mark is attached only after a
 *  successful stitch; an unknown texture reports the historical value 1. */
export function atlasTexelStep(texture: Phaser.Textures.Texture | undefined): number {
  return texture ? texelSteps.get(texture) ?? 1 : 1;
}

/** Source-image rectangle of a frame, in texels — for `drawImage` bakes. */
export function frameTexelRect(
  texture: Phaser.Textures.Texture,
  frame: Phaser.Textures.Frame,
): { x: number; y: number; w: number; h: number } {
  const k = atlasTexelStep(texture);
  return { x: frame.cutX, y: frame.cutY, w: frame.cutWidth / k, h: frame.cutHeight / k };
}

/** Convert logical frame coordinates to a source-image texel, or null when
 * outside the visible (possibly trimmed) frame. Kept pure so the hit-test
 * mapping is pinned without depending on a browser canvas implementation. */
export function frameTexelPoint(
  texture: Phaser.Textures.Texture,
  frame: Phaser.Textures.Frame,
  x: number,
  y: number,
): { x: number; y: number } | null {
  const k = atlasTexelStep(texture);
  const tx = Math.floor(frame.cutX + (x - frame.x) / k);
  const ty = Math.floor(frame.cutY + (y - frame.y) / k);
  if (tx < frame.cutX || tx >= frame.cutX + frame.cutWidth / k
    || ty < frame.cutY || ty >= frame.cutY + frame.cutHeight / k) return null;
  return { x: tx, y: ty };
}

let alphaContext: CanvasRenderingContext2D | null | undefined;

function tempAlphaContext(): CanvasRenderingContext2D | null {
  if (alphaContext === undefined) {
    if (typeof document === 'undefined') {
      alphaContext = null;
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      alphaContext = canvas.getContext('2d', { willReadFrequently: true });
    }
  }
  return alphaContext;
}

/**
 * Alpha of a frame's pixel at frame-space (x, y): Phaser's
 * `TextureManager.getPixelAlpha` — and exactly that call on a natively-spaced
 * atlas, so the full profile is byte-for-byte the old path — with the
 * coordinates mapped into texels for a re-spaced one.
 */
export function frameAlphaAt(
  scene: Phaser.Scene,
  key: string,
  frameName: string,
  x: number,
  y: number,
): number | null {
  const textures = scene.textures as Phaser.Textures.TextureManager & {
    get?: (key: string) => Phaser.Textures.Texture;
  };
  const k = atlasTexelStep(textures.get?.(key));
  if (k === 1) return textures.getPixelAlpha(x, y, key, frameName);
  const frame = textures.getFrame(key, frameName);
  const image = frame?.source.image as CanvasImageSource | null | undefined;
  if (!frame || !image) return null;
  // Same order as Phaser: undo the trim offset, then add the cut origin.
  const point = frameTexelPoint(textures.get(key), frame, x, y);
  if (!point) return null;
  const ctx = tempAlphaContext();
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.drawImage(image, point.x, point.y, 1, 1, 0, 0, 1, 1);
  return ctx.getImageData(0, 0, 1, 1).data[3] ?? null;
}

/** First row holding a pixel at or above `threshold` alpha, or `height` when
 *  the image has none. Pure, so the scan is pinned without a browser canvas. */
export function firstOpaqueRow(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  threshold: number,
): number {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) >= threshold) return y;
    }
  }
  return height;
}

/** Soft ground shadows stay below this; roofs, banners and poles are above it. */
const OPAQUE_ART_ALPHA = 96;
const opaqueTopRatios = new Map<string, number>();

/**
 * How far down its own frame a sprite's ART begins, as a 0–1 share of the
 * frame height. Building families share one fixed cell across all levels, so a
 * low-level structure leaves most of the cell empty: a chip seated on the frame
 * top floats a building-height above the roof. Measured once per frame from
 * the source texels and cached; 0 (the frame top) whenever the source cannot
 * be read, which is the previous behaviour.
 */
export function frameOpaqueTopRatio(scene: Phaser.Scene, key: string, frameName: string): number {
  const cacheKey = `${key}\n${frameName}`;
  const cached = opaqueTopRatios.get(cacheKey);
  if (cached !== undefined) return cached;
  let ratio = 0;
  try {
    const texture = scene.textures.get(key);
    const frame = scene.textures.getFrame(key, frameName);
    const image = frame?.source.image as CanvasImageSource | null | undefined;
    if (frame && image && typeof document !== 'undefined') {
      const rect = frameTexelRect(texture, frame);
      const canvas = document.createElement('canvas');
      canvas.width = rect.w; canvas.height = rect.h;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context && rect.w > 0 && rect.h > 0) {
        context.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
        const row = firstOpaqueRow(context.getImageData(0, 0, rect.w, rect.h).data, rect.w, rect.h, OPAQUE_ART_ALPHA);
        // Trimmed frames sit inside their untrimmed source cell.
        const k = atlasTexelStep(texture);
        ratio = row >= rect.h ? 0 : (frame.y + row * k) / Math.max(1, frame.realHeight);
      }
    }
  } catch {
    ratio = 0; // tainted or compressed source: keep the frame-top seat
  }
  opaqueTopRatios.set(cacheKey, ratio);
  return ratio;
}
