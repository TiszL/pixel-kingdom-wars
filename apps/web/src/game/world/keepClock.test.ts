import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({
  default: { Textures: { FilterMode: { NEAREST: 1 } } },
}));

import {
  EMPTY_KEEP_CLOCK_METADATA,
  KeepClockLayer,
  keepClockFrameIndices,
  parseKeepClockMetadata,
  resolveKeepClockFace,
  type KeepClockMetadata,
} from './keepClock';

const FACE = {
  pivotPx: [8, 6] as const,
  canvasPx: [16, 20] as const,
  handScale: 1,
};

const METADATA: KeepClockMetadata = {
  frames: {
    ware_bld_keep_l20_idle_f1: FACE,
    ware_bld_keep_l20_collapse_f1: null,
    cycle_a: { sourceFrame: 'cycle_b' },
    cycle_b: { sourceFrame: 'cycle_a' },
  },
  levels: {
    1: null,
    20: {
      sourceFrame: 'bld_keep_l20', pivotPx: [16, 12], canvasPx: [32, 40], handScale: 2,
    },
  },
};

describe('KEEP clock metadata', () => {
  it('resolves actual rich WARE frames and the exact eager per-level source frame', () => {
    expect(resolveKeepClockFace(METADATA, 'ware_bld_keep_l20_idle_f1', 20)).toEqual({
      sourceFrame: 'ware_bld_keep_l20_idle_f1',
      ...FACE,
    });
    expect(resolveKeepClockFace(METADATA, 'bld_keep_l20', 20)).toEqual({
      sourceFrame: 'bld_keep_l20',
      pivotPx: [16, 12], canvasPx: [32, 40], handScale: 2,
    });
  });

  it('fails closed for occluded, missing, wrong-level, cyclic, and malformed faces', () => {
    expect(resolveKeepClockFace(METADATA, 'ware_bld_keep_l20_collapse_f1', 20)).toBeNull();
    expect(resolveKeepClockFace(METADATA, 'ware_bld_keep_l20_work_f1', 20)).toBeNull();
    expect(resolveKeepClockFace(METADATA, 'bld_keep_l20', 1)).toBeNull();
    expect(resolveKeepClockFace(METADATA, 'cycle_a', 20)).toBeNull();
    expect(resolveKeepClockFace(EMPTY_KEEP_CLOCK_METADATA, 'bld_keep_l20', 20)).toBeNull();
    expect(resolveKeepClockFace({
      frames: { broken: { pivotPx: [99, 1], canvasPx: [10, 10], handScale: 1 } },
      levels: {},
    }, 'broken', 20)).toBeNull();
  });

  it('rejects the complete downloaded sidecar when any binding is malformed', () => {
    expect(parseKeepClockMetadata(METADATA)).toEqual(METADATA);
    expect(parseKeepClockMetadata({
      frames: { ware_bld_keep_l20_idle_f1: FACE, broken: { sourceFrame: 7 } },
      levels: METADATA.levels,
    })).toBe(EMPTY_KEEP_CLOCK_METADATA);
    expect(parseKeepClockMetadata({ frames: {}, levels: [], extra: true }))
      .toBe(EMPTY_KEEP_CLOCK_METADATA);
  });

  it('derives minute and smoothly stepped hour hands from viewer-local fields', () => {
    // Component construction is deliberately local-time, so the assertion is
    // timezone-independent while still catching an accidental getUTC* switch.
    const local = new Date(2026, 7, 26, 13, 47, 30);
    expect(keepClockFrameIndices(local)).toEqual({ hour: 9, minute: 47 });
  });
});

class FakeImage {
  active = true;
  visible = true;
  destroyed = false;
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  alpha = 1;
  depth = 0;
  depthWrites = 0;
  transformWrites = 0;
  readonly textures: Array<readonly [string, string]> = [];

  setOrigin(): this { return this; }
  setPosition(x: number, y: number): this { this.transformWrites++; this.x = x; this.y = y; return this; }
  setScale(x: number, y = x): this { this.transformWrites++; this.scaleX = x; this.scaleY = y; return this; }
  setDepth(depth: number): this { this.depthWrites++; this.depth = depth; return this; }
  setAlpha(alpha: number): this { this.transformWrites++; this.alpha = alpha; return this; }
  setVisible(visible: boolean): this { this.visible = visible; return this; }
  setTexture(texture: string, frame: string): this { this.textures.push([texture, frame]); return this; }
  destroy(): void { this.destroyed = true; this.active = false; }
}

class FakeCanvasTexture {
  readonly frames: string[] = [];
  rgba = new Uint8ClampedArray();
  filter: number | null = null;
  refreshed = false;

  getContext(): Pick<CanvasRenderingContext2D, 'createImageData' | 'putImageData'> {
    return {
      createImageData: ((width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4), width, height,
      })) as CanvasRenderingContext2D['createImageData'],
      putImageData: ((image: ImageData) => { this.rgba = image.data; }) as CanvasRenderingContext2D['putImageData'],
    };
  }
  add(name: string): Record<string, never> { this.frames.push(name); return {}; }
  setFilter(filter: number): void { this.filter = filter; }
  refresh(): this { this.refreshed = true; return this; }
}

function harness(now: Date): {
  layer: KeepClockLayer;
  body: Record<string, unknown>;
  images: FakeImage[];
  texture: FakeCanvasTexture;
  setNow: (next: Date) => void;
} {
  let localTime = now;
  const images: FakeImage[] = [];
  const texture = new FakeCanvasTexture();
  let textureExists = false;
  const scene = {
    textures: {
      exists: () => textureExists,
      createCanvas: () => { textureExists = true; return texture; },
    },
    add: {
      image: () => { const image = new FakeImage(); images.push(image); return image; },
    },
  };
  const body = {
    frame: { name: 'ware_bld_keep_l20_idle_f1' },
    active: true,
    visible: true,
    alpha: 1,
    originX: 0.5,
    originY: 1,
    flipX: false,
    flipY: false,
    x: 100,
    y: 200,
    scaleX: 2,
    scaleY: 2,
    depth: 400,
  };
  return {
    layer: new KeepClockLayer(scene as never, METADATA, () => localTime),
    body,
    images,
    texture,
    setNow: (next) => { localTime = next; },
  };
}

describe('KeepClockLayer', () => {
  it('keeps Date construction out of the per-frame transform path', () => {
    const source = readFileSync(new URL('./keepClock.ts', import.meta.url), 'utf8');
    const transformAt = source.indexOf('private refreshTransform');
    const clockAt = source.indexOf('private refreshClock');
    expect(transformAt).toBeGreaterThanOrEqual(0);
    expect(clockAt).toBeGreaterThan(transformAt);
    const transform = source.slice(transformAt, clockAt);
    expect(transform).not.toContain('new Date');
    expect(source.slice(clockAt)).toContain('new Date(nowMs)');
  });

  it('pre-renders binary-alpha nearest-neighbour hands and updates texture frames once/minute', () => {
    const h = harness(new Date(2026, 7, 26, 13, 47, 10));
    h.layer.sync('keep', h.body as never, 20);

    expect(h.images).toHaveLength(2);
    expect(h.texture.frames).toHaveLength(120);
    expect(h.texture.filter).toBe(1);
    expect(h.texture.refreshed).toBe(true);
    const alpha = [...h.texture.rgba].filter((_value, index) => index % 4 === 3);
    expect(new Set(alpha)).toEqual(new Set([0, 255]));
    for (let i = 0; i < h.texture.rgba.length; i += 4) {
      if (h.texture.rgba[i + 3] === 0) {
        expect([...h.texture.rgba.slice(i, i + 3)]).toEqual([0, 0, 0]);
      }
    }
    expect(h.images[0]!.textures.at(-1)).toEqual(['keep-clock-hands', 'hour_9']);
    expect(h.images[1]!.textures.at(-1)).toEqual(['keep-clock-hands', 'minute_47']);
    expect([h.images[0]!.x, h.images[0]!.y]).toEqual([100, 172]);
    expect([h.images[0]!.scaleX, h.images[0]!.scaleY]).toEqual([2, 2]);

    // The eager body is loaded @2x and drawn at half the rich @1x scale. Its
    // generated face metadata is doubled, so both paths land pixel-identically.
    (h.body as { frame: { name: string } }).frame.name = 'bld_keep_l20';
    (h.body as { scaleX: number; scaleY: number }).scaleX = 1;
    (h.body as { scaleX: number; scaleY: number }).scaleY = 1;
    h.layer.update();
    expect([h.images[0]!.x, h.images[0]!.y]).toEqual([100, 172]);
    expect([h.images[0]!.scaleX, h.images[0]!.scaleY]).toEqual([2, 2]);

    (h.body as { alpha: number }).alpha = 0.75;
    h.layer.update();
    expect(h.images.map((image) => image.alpha)).toEqual([0.75, 0.75]);

    h.layer.sync('keep', h.body as never, 20); // ordinary store refresh
    expect(h.images[0]!.textures).toHaveLength(1);

    // Position follows the body each render, but the texture frame does not
    // churn within the same minute.
    (h.body as { x: number }).x = 103.4;
    h.setNow(new Date(2026, 7, 26, 13, 47, 59));
    h.layer.update();
    expect(h.images[0]!.x).toBe(103);
    expect(h.images[0]!.textures).toHaveLength(1);

    h.setNow(new Date(2026, 7, 26, 13, 48, 0));
    h.layer.update();
    expect(h.images[1]!.textures.at(-1)).toEqual(['keep-clock-hands', 'minute_48']);
    expect(h.images[0]!.textures).toHaveLength(2);

    // A scene/tab resume applies local time immediately even within the same minute.
    h.layer.resume();
    expect(h.images[0]!.textures).toHaveLength(3);
  });

  /**
   * M33 package D (D-101): Phaser's Depth setter has no equality check — every
   * setDepth queues a display-list sort — and the transform/alpha setters each
   * dirty the render tree. A KEEP that has not moved must cost nothing per
   * frame, so the hands are written only when the body's values changed.
   */
  it('issues no depth or transform writes while the body is unchanged', () => {
    const h = harness(new Date(2026, 7, 26, 13, 47, 10));
    h.layer.sync('keep', h.body as never, 20);
    const depth = h.images.map((image) => image.depthWrites);
    const transform = h.images.map((image) => image.transformWrites);
    expect(depth).toEqual([1, 1]);

    for (let frame = 0; frame < 60; frame++) h.layer.update();
    expect(h.images.map((image) => image.depthWrites)).toEqual(depth);
    expect(h.images.map((image) => image.transformWrites)).toEqual(transform);
    // …and the hands are still seated and visible.
    expect([h.images[0]!.x, h.images[0]!.y, h.images[0]!.depth]).toEqual([100, 172, 400.1]);
    expect(h.images.map((image) => image.visible)).toEqual([true, true]);

    // A real depth change (the KEEP re-sorted) is exactly one write per hand.
    (h.body as { depth: number }).depth = 500;
    h.layer.update();
    h.layer.update();
    expect(h.images.map((image) => image.depthWrites)).toEqual([2, 2]);
    expect(h.images.map((image) => image.depth)).toEqual([500.1, 500.2]);
  });

  it('hides unapproved states and destroys both overlays on collapse/removal', () => {
    const h = harness(new Date(2026, 7, 26, 8, 0));
    h.layer.sync('keep', h.body as never, 20);
    (h.body as { frame: { name: string } }).frame.name = 'ware_bld_keep_l20_collapse_f1';
    h.layer.update();
    expect(h.images.map((image) => image.visible)).toEqual([false, false]);

    h.layer.remove('keep');
    expect(h.images.map((image) => image.destroyed)).toEqual([true, true]);
  });

  it('allocates nothing when final art has not published a pivot', () => {
    const images: FakeImage[] = [];
    const scene = {
      textures: { exists: () => false, createCanvas: vi.fn() },
      add: { image: () => { const image = new FakeImage(); images.push(image); return image; } },
    };
    const body = harness(new Date()).body;
    new KeepClockLayer(scene as never, EMPTY_KEEP_CLOCK_METADATA, () => new Date())
      .sync('keep', body as never, 20);
    expect(images).toHaveLength(0);
    expect(scene.textures.createCanvas).not.toHaveBeenCalled();
  });
});
