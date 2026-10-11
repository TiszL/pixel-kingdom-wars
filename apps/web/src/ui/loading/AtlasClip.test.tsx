/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtlasClip, atlasClipLayout, clipFramesOf, type AtlasFrame } from './AtlasClip';
import { LOADING_TIP_METRICS } from './LoadingTips';
import { LOADING_TIPS } from './loadingTipData';

const SIZES = [LOADING_TIP_METRICS.regular.sprite, LOADING_TIP_METRICS.compact.sprite];

describe('loading tip clip layout', () => {
  it('draws every shipped tip clip at a whole-number scale of at least 1 that fits its canvas', () => {
    // WHY: most tip cells are larger than the 56/76px tip box. A fractional
    // draw scale rounded each frame's offset and size differently, so sprites
    // wobbled a pixel per frame (owner 2026-09-24: "dizzy" loading animation).
    for (const tip of LOADING_TIPS) {
      const json = JSON.parse(readFileSync(`public/atlas/${tip.clip.atlas}@1x.json`, 'utf8')) as
        Parameters<typeof clipFramesOf>[0];
      const cell = clipFramesOf(json, tip.clip.stem)[0]!.sourceSize;
      for (const size of SIZES) {
        const layout = atlasClipLayout(cell, size);
        const label = `${tip.id}@${size}`;
        expect(Number.isInteger(layout.scale) && layout.scale >= 1, label).toBe(true);
        for (const value of [layout.width, layout.height, layout.ox, layout.oy]) {
          expect(Number.isInteger(value), label).toBe(true);
        }
        expect(layout.ox + cell.w * layout.scale, label).toBeLessThanOrEqual(layout.width);
        expect(layout.oy + cell.h * layout.scale, label).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  it('keeps small cells at the old whole-number enlargement inside the tip box', () => {
    expect(atlasClipLayout({ w: 32, h: 44 }, 76)).toEqual({ scale: 1, width: 76, height: 76, ox: 22, oy: 16 });
    expect(atlasClipLayout({ w: 24, h: 24 }, 76)).toEqual({ scale: 3, width: 76, height: 76, ox: 2, oy: 2 });
    expect(atlasClipLayout({ w: 144, h: 136 }, 56)).toEqual({ scale: 1, width: 144, height: 136, ox: 0, oy: 0 });
  });
});

describe('AtlasClip drawing', () => {
  const frame = (n: number, x: number): AtlasFrame => ({
    filename: `clip_f${n}`,
    frame: { x: n * 40, y: 0, w: 37, h: 81 },
    sourceSize: { w: 96, h: 88 },
    spriteSourceSize: { x, y: 3, w: 37, h: 81 },
  });
  let host: HTMLDivElement;
  let root: Root;
  let draws: number[][];
  let widthWrites: number;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    draws = [];
    widthWrites = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      textures: [{ frames: [frame(0, 29), frame(1, 30), frame(2, 31)] }],
    }))));
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    });
    const ctx = {
      setTransform: vi.fn(), clearRect: vi.fn(), imageSmoothingEnabled: true,
      drawImage: (...args: unknown[]) => { draws.push((args.slice(5) as number[])); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!;
    vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set').mockImplementation(function (this: HTMLCanvasElement, value: number) {
      widthWrites += 1;
      width.set!.call(this, value);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('places every frame on whole pixels at one scale and never reallocates an unchanged canvas', async () => {
    // WHY: per-frame rounding of a fractional scale jittered the sprite, and
    // re-assigning canvas.width wipes the canvas, flashing it blank.
    const clip = { atlas: 'test_atlas_integer', stem: 'clip' };
    await act(async () => root.render(<AtlasClip clip={clip} size={56} />));
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(draws.length).toBeGreaterThan(3);
    for (const args of draws) expect(args.every(Number.isInteger), String(args)).toBe(true);
    // Same drawn size on every frame: only the authored source offset moves.
    expect(new Set(draws.map(([, , w, h]) => `${w}x${h}`))).toEqual(new Set(['37x81']));
    const canvas = host.querySelector('canvas')!;
    expect([canvas.width, canvas.height]).toEqual([96, 88]);
    expect(widthWrites).toBe(1);

    await act(async () => root.render(<AtlasClip clip={clip} size={56} reduceMotion />));
    expect(widthWrites).toBe(1);
  });
});
