import { describe, expect, it } from 'vitest';

import {
  normalizeProviderFrameGroup,
  type DecodedFrame,
  type FrameGroupOptions,
} from './provider-production-normalize.js';

function frame(width: number, height: number, direction = 's', id: number | string = 1): DecodedFrame {
  return { width, height, direction, frame: id, rgba: new Uint8Array(width * height * 4) };
}

function pixel(image: DecodedFrame, x: number, y: number, rgba: readonly number[]): void {
  image.rgba.set(rgba, ((y * image.width) + x) * 4);
}

function outputPixel(data: Uint8Array, width: number, x: number, y: number): number[] {
  const offset = ((y * width) + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

function options(frames: readonly DecodedFrame[], overrides: Partial<FrameGroupOptions> = {}): FrameGroupOptions {
  return { frames, runtimeCell: { width: frames[0]!.width, height: frames[0]!.height },
    preferredSourceOffset: { x: 0, y: 0 }, directionOrder: ['s'], frameOrder: [1], ...overrides };
}

describe('provider production frame normalization', () => {
  it('keeps a 112→112 group exact while thresholding alpha and clearing transparent RGB', () => {
    const source = frame(112, 112);
    pixel(source, 4, 5, [9, 8, 7, 127]);
    pixel(source, 6, 7, [3, 2, 1, 128]);
    const result = normalizeProviderFrameGroup(options([source]));
    expect(result.metadata.directions[0]!.sourceWindow).toEqual({ x: 0, y: 0, width: 112, height: 112 });
    expect(outputPixel(result.frames[0]!.rgba, 112, 4, 5)).toEqual([0, 0, 0, 0]);
    expect(outputPixel(result.frames[0]!.rgba, 112, 6, 7)).toEqual([3, 2, 1, 255]);
    expect(result.frames[0]!.metrics.partialAlphaPixels).toBe(2);
  });

  it('crops the current 156→112 Giant-style provider canvas at the nearest feasible offset', () => {
    const source = frame(156, 156);
    pixel(source, 30, 28, [10, 20, 30, 255]);
    pixel(source, 129, 133, [40, 50, 60, 255]);
    const result = normalizeProviderFrameGroup(options([source], {
      runtimeCell: { width: 112, height: 112 }, preferredSourceOffset: { x: 22, y: 22 },
    }));
    expect(result.metadata.directions[0]!.sourceWindow).toEqual({ x: 22, y: 22, width: 112, height: 112 });
    expect(result.metadata.directions[0]!.anchorDelta).toEqual({ x: -22, y: -22 });
    expect(result.metadata.directions[0]!.runtimeUnionOpaqueBounds).toMatchObject({ minX: 8, minY: 6, maxX: 107, maxY: 111 });

    const wouldPreviouslyClampTo23 = frame(156, 156);
    pixel(wouldPreviouslyClampTo23, 30, 28, [10, 20, 30, 255]);
    pixel(wouldPreviouslyClampTo23, 129, 134, [40, 50, 60, 255]);
    expect(() => normalizeProviderFrameGroup(options([wouldPreviouslyClampTo23], {
      runtimeCell: { width: 112, height: 112 }, preferredSourceOffset: { x: 22, y: 22 },
    }))).toThrow('s: union opaque height bounds [28,134] do not fit requested height window [22,133]; exact anchor mapping forbids clamping');
  });

  it('never clamps an unsafe preferred offset, and preserves a safe odd offset exactly', () => {
    const source = frame(15, 15);
    pixel(source, 5, 4, [1, 1, 1, 255]);
    pixel(source, 14, 13, [1, 1, 1, 255]);
    expect(() => normalizeProviderFrameGroup(options([source], {
      runtimeCell: { width: 11, height: 11 }, preferredSourceOffset: { x: 3, y: 1 },
    }))).toThrow('s: union opaque width bounds [5,14] do not fit requested width window [3,13]; exact anchor mapping forbids clamping');
    const result = normalizeProviderFrameGroup(options([source], {
      runtimeCell: { width: 11, height: 11 }, preferredSourceOffset: { x: 4, y: 3 },
    }));
    expect(result.metadata.directions[0]!.sourceWindow).toEqual({ x: 4, y: 3, width: 11, height: 11 });
  });

  it('pads a smaller provider without moving its opaque union out of the runtime cell', () => {
    const source = frame(3, 3);
    pixel(source, 0, 0, [1, 2, 3, 255]);
    pixel(source, 2, 2, [4, 5, 6, 255]);
    const result = normalizeProviderFrameGroup(options([source], {
      runtimeCell: { width: 6, height: 6 }, preferredSourceOffset: { x: -2, y: -1 },
    }));
    expect(result.metadata.directions[0]!.sourceWindow).toEqual({ x: -2, y: -1, width: 6, height: 6 });
    expect(result.metadata.directions[0]!.padding).toEqual({ left: 2, top: 1, right: 1, bottom: 2 });
    expect(outputPixel(result.frames[0]!.rgba, 6, 2, 1)).toEqual([1, 2, 3, 255]);
  });

  it('rejects an opaque union larger than runtime instead of scaling or repainting it', () => {
    const first = frame(8, 8, 's', 1);
    const second = frame(8, 8, 's', 2);
    pixel(first, 0, 0, [1, 1, 1, 255]);
    pixel(second, 7, 7, [1, 1, 1, 255]);
    expect(() => normalizeProviderFrameGroup(options([first, second], {
      runtimeCell: { width: 7, height: 8 }, directionOrder: ['s'], frameOrder: [1, 2],
    }))).toThrow('s: union opaque width bounds [0,7] span 8 exceeds runtime width 7; rescaling is forbidden');
  });

  it('requires complete direction × frame coverage and stitches in caller order', () => {
    const make = (direction: string, id: number, red: number): DecodedFrame => {
      const value = frame(1, 1, direction, id);
      pixel(value, 0, 0, [red, 0, 0, 255]);
      return value;
    };
    const unordered = [make('n', 2, 42), make('s', 1, 11), make('n', 1, 41), make('s', 2, 12)];
    const result = normalizeProviderFrameGroup(options(unordered, {
      runtimeCell: { width: 1, height: 1 }, directionOrder: ['s', 'n'], frameOrder: [1, 2],
    }));
    expect([...result.sheet.rgba.filter((_, index) => index % 4 === 0)]).toEqual([11, 12, 41, 42]);
    expect(result.sheet).toMatchObject({ width: 2, height: 2 });
    expect(() => normalizeProviderFrameGroup(options(unordered.slice(0, 3), {
      runtimeCell: { width: 1, height: 1 }, directionOrder: ['s', 'n'], frameOrder: [1, 2],
    }))).toThrow('missing 1, unexpected 0');
  });

  it('normalizes different provider canvases with one shared window per direction', () => {
    const south1 = frame(156, 156, 's', 1);
    const south2 = frame(156, 156, 's', 2);
    const north1 = frame(148, 148, 'n', 1);
    const north2 = frame(148, 148, 'n', 2);
    pixel(south1, 30, 28, [11, 0, 0, 255]);
    pixel(south2, 129, 133, [12, 0, 0, 255]);
    pixel(north1, 20, 20, [21, 0, 0, 255]);
    pixel(north2, 127, 127, [22, 0, 0, 255]);
    const result = normalizeProviderFrameGroup(options([north2, south1, north1, south2], {
      runtimeCell: { width: 112, height: 112 }, preferredSourceOffset: { x: 0, y: 0 },
      preferredSourceOffsets: { s: { x: 22, y: 22 }, n: { x: 18, y: 18 } },
      directionOrder: ['s', 'n'], frameOrder: [1, 2],
    }));
    expect(result.metadata.directions).toEqual([
      expect.objectContaining({ direction: 's', providerCanvas: { width: 156, height: 156 },
        sourceWindow: { x: 22, y: 22, width: 112, height: 112 }, anchorDelta: { x: -22, y: -22 } }),
      expect.objectContaining({ direction: 'n', providerCanvas: { width: 148, height: 148 },
        sourceWindow: { x: 18, y: 18, width: 112, height: 112 }, anchorDelta: { x: -18, y: -18 } }),
    ]);
    expect(result.sheet).toMatchObject({ width: 224, height: 224 });
    expect(outputPixel(result.sheet.rgba, 224, 8, 6)).toEqual([11, 0, 0, 255]);
    expect(outputPixel(result.sheet.rgba, 224, 221, 221)).toEqual([22, 0, 0, 255]);
  });

  it('uses ordered palette insertion for deterministic distance ties', () => {
    const source = frame(1, 1);
    pixel(source, 0, 0, [1, 0, 0, 255]);
    const result = normalizeProviderFrameGroup(options([source], { palette: [[2, 0, 0], [0, 0, 0]] }));
    expect([...result.frames[0]!.rgba]).toEqual([2, 0, 0, 255]);
    expect(result.frames[0]!.metrics).toMatchObject({ remappedPixels: 1, sourceOpaqueColors: 1, outputOpaqueColors: 1 });
    expect(result.metadata.palette).toEqual(['#020000', '#000000']);
  });

  it('does not mutate frames/options and emits byte-stable secret/path-free metadata', () => {
    const source = frame(2, 2);
    pixel(source, 1, 1, [7, 8, 9, 200]);
    const before = new Uint8Array(source.rgba);
    const config = options([source]);
    const first = normalizeProviderFrameGroup(config);
    const second = normalizeProviderFrameGroup(config);
    expect(source.rgba).toEqual(before);
    expect(first.metadataJson).toBe(second.metadataJson);
    expect(first.sheet.rgba).toEqual(second.sheet.rgba);
    expect(first.metadataJson).not.toMatch(/(?:\/Users\/|Authorization|Bearer|token)/i);
  });
});
