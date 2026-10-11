/** A tiny atlas player for loading. It intentionally does not import Phaser,
 * which would pull the engine back into the first-paint bundle. */
import { useEffect, useRef, useState } from 'react';
import { versionedPublicAsset } from '../../lib/version';
import { TIP_FPS, type TipClip } from './loadingTipData';

export interface AtlasFrame {
  filename: string;
  frame: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  spriteSourceSize: { x: number; y: number; w: number; h: number };
}

interface AtlasJson { textures: Array<{ frames: AtlasFrame[] }> }
interface Sheet { json: AtlasJson; image: HTMLImageElement }
interface LoadedClip { image: HTMLImageElement; frames: AtlasFrame[]; cell: { w: number; h: number } }

const sheets = new Map<string, Promise<Sheet>>();

function loadSheet(atlas: string): Promise<Sheet> {
  const cached = sheets.get(atlas);
  if (cached) return cached;
  const pending = Promise.all([
    fetch(versionedPublicAsset(`/atlas/${atlas}@1x.json`)).then((response) => {
      if (!response.ok) throw new Error(`atlas json ${response.status}`);
      return response.json() as Promise<AtlasJson>;
    }),
    new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('atlas image failed'));
      image.src = versionedPublicAsset(`/atlas/${atlas}@1x.png`);
    }),
  ]).then(([json, image]) => ({ json, image }));
  void pending.catch(() => sheets.delete(atlas));
  sheets.set(atlas, pending);
  return pending;
}

export function clipFramesOf(json: AtlasJson, stem: string): AtlasFrame[] {
  const prefix = `${stem}_f`;
  return json.textures[0]?.frames
    .filter((frame) => frame.filename.startsWith(prefix)
      && /^\d+$/.test(frame.filename.slice(prefix.length)))
    .sort((a, b) => Number(a.filename.slice(prefix.length))
      - Number(b.filename.slice(prefix.length))) ?? [];
}

/** Integer pixel layout for one clip. Every frame is drawn at the same whole
 * scale into a fixed backing size, and CSS fits that canvas into the tip box
 * once. A fractional draw scale rounded each frame's offset and size
 * differently, so the sprite wobbled by a pixel from frame to frame. */
export function atlasClipLayout(cell: { w: number; h: number }, size: number): {
  scale: number; width: number; height: number; ox: number; oy: number;
} {
  const scale = Math.max(1, Math.floor(size / Math.max(cell.w, cell.h)));
  const width = Math.max(size, cell.w * scale);
  const height = Math.max(size, cell.h * scale);
  return {
    scale, width, height,
    ox: Math.floor((width - cell.w * scale) / 2),
    oy: Math.floor((height - cell.h * scale) / 2),
  };
}

function osReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function AtlasClip({ clip, size, reduceMotion = false }: {
  clip: TipClip;
  size: number;
  reduceMotion?: boolean;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loaded, setLoaded] = useState<LoadedClip | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    void loadSheet(clip.atlas)
      .then(({ json, image }) => {
        if (!live) return;
        const frames = clipFramesOf(json, clip.stem);
        if (frames.length > 0) setLoaded({ image, frames, cell: frames[0]!.sourceSize });
      })
      .catch(() => { /* decorative failure leaves the advice intact */ });
    return () => { live = false; };
  }, [clip.atlas, clip.stem]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !loaded) return undefined;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const { image, frames, cell } = loaded;
    const { scale, width, height, ox, oy } = atlasClipLayout(cell, size);
    // Assigning a canvas dimension clears and reallocates it, even when equal.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    let index = 0;
    const draw = (): void => {
      const frame = frames[index]!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(
        image,
        frame.frame.x, frame.frame.y, frame.frame.w, frame.frame.h,
        ox + frame.spriteSourceSize.x * scale,
        oy + frame.spriteSourceSize.y * scale,
        frame.frame.w * scale,
        frame.frame.h * scale,
      );
    };
    draw();
    if (frames.length < 2 || reduceMotion || osReducedMotion()) return undefined;
    const timer = setInterval(() => {
      index = (index + 1) % frames.length;
      draw();
    }, Math.round(1000 / TIP_FPS));
    return () => clearInterval(timer);
  }, [loaded, reduceMotion, size]);

  return <canvas ref={canvasRef} aria-hidden="true" style={{ width: size, height: size, objectFit: 'contain', imageRendering: 'pixelated', display: 'block' }} />;
}
