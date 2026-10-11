/**
 * The `map` atlas, read from React.
 *
 * WHY: the world/campaign boards used to mount one `<img>` per visible tile —
 * ~435 of them on a desktop viewport — each pointing at a separate SVG master.
 * Panning re-laid-out all of them; a single zoom step re-rasterised 46 distinct
 * SVGs and stalled for ~140 ms. Collapsing the terrain into ONE canvas needs a
 * raster source with frame rects, and the game already ships exactly that:
 * `/atlas/map@2x.png` (728×694, 86 frames, ~81 KB) which BootScene fetches at
 * boot for the Phaser layer. Same trick, same reasoning as
 * game/world/grass.ts — which replaced 2,500 per-tile Images with one baked
 * texture — except the consumer here is a 2D canvas rather than a TileSprite.
 *
 * The URL carries `?v=<gitSha>` for the SAME reason BootScene's does: the PNG
 * and its JSON are one artifact split in two files and a repack moves every
 * rect, so an unversioned URL lets a cache pair files from different deploys.
 * Using the identical URL also means this is a browser-cache hit, not a second
 * download.
 *
 * Module-scope promise: one atlas request may be in flight at a time, and a
 * successful decode is reused for the session. A failed attempt is deliberately
 * released so a visible map can recover without a full-page reload.
 */
import { useEffect, useState } from 'react';
import { WORLD } from '@shardkeep/shared';
import { BUILD } from '../lib/version';

export interface AtlasFrame { x: number; y: number; w: number; h: number }

export interface MapAtlas {
  /** The decoded atlas sheet, drawn from with drawImage(sheet, sx,sy,sw,sh, …). */
  sheet: CanvasImageSource;
  /**
   * A luminance copy of the same sheet. Silhouette keeps render
   * `filter: grayscale(1); opacity: .35`, and canvas `ctx.filter` is not
   * dependable across the browsers this ships to (it is unimplemented in some
   * WebViews and silently ignored rather than erroring), so the grey is baked
   * ONCE at load instead of asked for per draw. Alpha still comes from
   * globalAlpha, which is universal.
   */
  gray: CanvasImageSource;
  frame(name: string): AtlasFrame | null;
}

interface PackedFrame { filename: string; frame: AtlasFrame }

/** Luminance-only copy of an image. Same-origin PNG, so getImageData is legal. */
function bakeGray(img: HTMLImageElement): CanvasImageSource {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return img; // no 2D context (jsdom) — fall back to the colour sheet
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, cv.width, cv.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    // Rec. 601 luma, the same weights a CSS grayscale(1) filter applies.
    const l = (px[i]! * 299 + px[i + 1]! * 587 + px[i + 2]! * 114) / 1000;
    px[i] = l; px[i + 1] = l; px[i + 2] = l;
  }
  ctx.putImageData(data, 0, 0);
  return cv;
}

let pending: Promise<MapAtlas | null> | null = null;

export function loadMapAtlas(): Promise<MapAtlas | null> {
  if (pending) return pending;
  const attempt = (async () => {
    try {
      const v = `?v=${BUILD.gitSha}`;
      const [json, sheet] = await Promise.all([
        fetch(`/atlas/map@2x.json${v}`).then((r) => r.json() as Promise<{ textures: Array<{ frames: PackedFrame[] }> }>),
        new Promise<HTMLImageElement>((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = () => rej(new Error('map atlas image failed'));
          img.src = `/atlas/map@2x.png${v}`;
        }),
      ]);
      const rects = new Map<string, AtlasFrame>();
      for (const f of json.textures[0]?.frames ?? []) rects.set(f.filename, f.frame);
      return { sheet, gray: bakeGray(sheet), frame: (n: string) => rects.get(n) ?? null };
    } catch {
      // No atlas ⇒ no terrain canvas. The board still renders (markers, chrome,
      // pan, zoom); it just draws on the flat pine background. A map screen that
      // throws is strictly worse than one missing its wallpaper.
      pending = null;
      return null;
    }
  })();
  pending = attempt;
  return attempt;
}

export function useMapAtlas(): MapAtlas | null {
  const [atlas, setAtlas] = useState<MapAtlas | null>(null);
  useEffect(() => {
    let live = true;
    let running = false;
    let timer = 0;
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, WORLD.mapPollSec * 1_000);
    };
    const run = (): void => {
      if (!live || running) return;
      if (document.visibilityState === 'hidden') { schedule(); return; }
      running = true;
      void loadMapAtlas().then((a) => {
        if (!live) return;
        if (a) setAtlas(a);
        else schedule();
      }).finally(() => { running = false; });
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible' || running) return;
      window.clearTimeout(timer);
      run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    run();
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return atlas;
}
