import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import {
  ART_PROFILE_REGISTRY_KEY, atlasTexelStep, firstOpaqueRow, frameOpaqueTopRatio, frameTexelPoint,
  frameTexelRect, sceneArtProfile, stitchAtlas, supportsLogicalAtlasUpscale,
} from './atlasTexels';

interface FakePackedFrame {
  filename: string;
  rotated?: boolean;
  trimmed?: boolean;
  frame: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
}

function harness(webgl = true) {
  const image = { width: 64, height: 32, naturalWidth: 64, naturalHeight: 32 };
  const source = { width: 64, height: 32, image };
  const frames = new Map<string, Record<string, unknown>>();
  const texture = {
    source: [source],
    frames: Object.create(null) as Record<string, unknown>,
    get: (name: string) => frames.get(name),
  };
  const addAtlas = vi.fn((_key: string, _image: unknown, data: { frames: FakePackedFrame[] }) => {
    for (const packed of data.frames) {
      const sprite = packed.spriteSourceSize;
      const logical = packed.sourceSize ?? { w: packed.frame.w, h: packed.frame.h };
      const frame = {
        cutX: packed.frame.x,
        cutY: packed.frame.y,
        cutWidth: packed.frame.w,
        cutHeight: packed.frame.h,
        x: sprite?.x ?? 0,
        y: sprite?.y ?? 0,
        source,
        realWidth: logical.w,
        realHeight: logical.h,
        data: { drawImage: { width: packed.frame.w, height: packed.frame.h } },
        u0: 0, v0: 0, u1: 0, v1: 0,
        setUVs(width: number, height: number, u0: number, v0: number, u1: number, v1: number) {
          this.data.drawImage.width = width;
          this.data.drawImage.height = height;
          this.u0 = u0; this.v0 = v0; this.u1 = u1; this.v1 = v1;
          return this;
        },
      };
      frames.set(packed.filename, frame);
      texture.frames[packed.filename] = frame;
    }
  });
  const getPixelAlpha = vi.fn(() => 255);
  const textures = {
    addAtlas,
    get: () => texture,
    getFrame: (_key: string, name: string) => frames.get(name),
    getPixelAlpha,
  };
  const scene = {
    game: { renderer: webgl ? { gl: {} } : {} },
    textures,
    registry: { get: (key: string) => key === ART_PROFILE_REGISTRY_KEY ? 'constrained' : undefined },
  } as unknown as Phaser.Scene;
  return { scene, image, source, texture, frames, addAtlas, getPixelAlpha };
}

describe('logical @2x frames over @1x texels', () => {
  const packed: FakePackedFrame = {
    filename: 'tile_grass_1',
    frame: { x: 3, y: 5, w: 10, h: 8 },
    sourceSize: { w: 10, h: 8 },
    spriteSourceSize: { x: 0, y: 0, w: 10, h: 8 },
  };

  it('expands logical size without multiplying packed padding coordinates or source bytes', () => {
    const h = harness();
    stitchAtlas(h.scene, 'tile', h.image as unknown as HTMLImageElement, [packed], 2);
    const frame = h.frames.get(packed.filename)! as Record<string, number> & {
      data: { drawImage: { width: number; height: number } };
    };

    expect([frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight]).toEqual([3, 5, 20, 16]);
    expect([frame.realWidth, frame.realHeight]).toEqual([20, 16]);
    expect([h.source.width, h.source.height]).toEqual([64, 32]);
    expect([frame.u0, frame.v0, frame.u1, frame.v1]).toEqual([
      3 / 64, 1 - 5 / 32, 13 / 64, 1 - 13 / 32,
    ]);
    expect(frame.data.drawImage).toMatchObject({ width: 10, height: 8 });
    expect(atlasTexelStep(h.texture as unknown as Phaser.Textures.Texture)).toBe(2);
    expect(frameTexelRect(
      h.texture as unknown as Phaser.Textures.Texture,
      frame as unknown as Phaser.Textures.Frame,
    )).toEqual({ x: 3, y: 5, w: 10, h: 8 });
  });

  it('maps logical hit-test pixels back to the exact packed source texel', () => {
    const h = harness();
    stitchAtlas(h.scene, 'tile', h.image as unknown as HTMLImageElement, [packed], 2);
    const frame = h.frames.get(packed.filename)! as unknown as Phaser.Textures.Frame;
    const texture = h.texture as unknown as Phaser.Textures.Texture;
    expect(frameTexelPoint(texture, frame, 0, 0)).toEqual({ x: 3, y: 5 });
    expect(frameTexelPoint(texture, frame, 19, 15)).toEqual({ x: 12, y: 12 });
    expect(frameTexelPoint(texture, frame, 20, 0)).toBeNull();
    expect(frameTexelPoint(texture, frame, -1, 0)).toBeNull();
  });

  it('keeps the native path byte-for-byte and refuses rotated pack output', () => {
    const native = harness();
    stitchAtlas(native.scene, 'tile', native.image as unknown as HTMLImageElement, [packed], 1);
    expect(native.addAtlas).toHaveBeenCalledWith('tile', native.image, { frames: [packed] });
    expect(atlasTexelStep(native.texture as unknown as Phaser.Textures.Texture)).toBe(1);

    const rotated = harness();
    expect(() => stitchAtlas(
      rotated.scene,
      'tile',
      rotated.image as unknown as HTMLImageElement,
      [{ ...packed, rotated: true }],
      2,
    )).toThrow('rotated frame');
  });
});

describe('profile registry and renderer gate', () => {
  it('enables the logical upscale only in WebGL and defaults unknown registry state to full', () => {
    const webgl = harness(true);
    const canvas = harness(false);
    expect(supportsLogicalAtlasUpscale(webgl.scene)).toBe(true);
    expect(supportsLogicalAtlasUpscale(canvas.scene)).toBe(false);
    expect(sceneArtProfile(webgl.scene)).toBe('constrained');
    (canvas.scene as unknown as { registry: { get: () => unknown } }).registry = { get: () => undefined };
    expect(sceneArtProfile(canvas.scene)).toBe('full');
  });
});

describe('where a frame\'s art begins', () => {
  // Building families share one fixed cell across all twenty levels, so a
  // Level 1 Camp leaves most of it empty. A chip seated on the CELL top floats
  // a building-height above the roof (owner 2026-09-19: "floating box").
  const rgba = (rows: number[][]): number[] => rows.flatMap((row) => row.flatMap((alpha) => [0, 0, 0, alpha]));

  it('finds the first row of real art and ignores soft shadow alpha', () => {
    const image = rgba([[0, 0, 0], [0, 40, 0], [0, 0, 200], [255, 255, 255]]);
    expect(firstOpaqueRow(image, 3, 4, 96)).toBe(2);
    expect(firstOpaqueRow(image, 3, 4, 32)).toBe(1);
    expect(firstOpaqueRow(rgba([[0, 0], [0, 0]]), 2, 2, 96)).toBe(2);
  });

  it('falls back to the frame top when the source cannot be read', () => {
    const scene = { textures: { get: () => undefined, getFrame: () => undefined } } as never as Phaser.Scene;
    expect(frameOpaqueTopRatio(scene, 'missing', 'frame')).toBe(0);
  });
});
