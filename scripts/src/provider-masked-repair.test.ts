import { describe, expect, it } from 'vitest';

import {
  composeProviderMaskedRepair,
  type MaskedRepairOptions,
  type RepairFrame,
} from './provider-masked-repair.js';

function frame(width: number, height: number): RepairFrame {
  return { width, height, rgba: new Uint8Array(width * height * 4) };
}

function clone(source: RepairFrame): RepairFrame {
  return { width: source.width, height: source.height, rgba: new Uint8Array(source.rgba) };
}

function setPixel(image: RepairFrame, x: number, y: number, rgba: readonly number[]): void {
  image.rgba.set(rgba, ((y * image.width) + x) * 4);
}

function getPixel(image: RepairFrame, x: number, y: number): number[] {
  const offset = ((y * image.width) + x) * 4;
  return [...image.rgba.subarray(offset, offset + 4)];
}

describe('provider masked repair compositor', () => {
  it('accepts the repair mask while restoring five Giant-style exterior drift pixels exactly', () => {
    const original = frame(8, 8);
    setPixel(original, 2, 2, [20, 30, 40, 255]);
    setPixel(original, 3, 2, [21, 31, 41, 255]);
    setPixel(original, 2, 3, [22, 32, 42, 255]);
    setPixel(original, 3, 3, [23, 33, 43, 255]);
    const provider = clone(original);
    setPixel(provider, 3, 3, [90, 80, 70, 255]);
    const drift = [[0, 0], [7, 0], [0, 7], [7, 7], [5, 4]] as const;
    for (const [x, y] of drift) setPixel(provider, x, y, [200, 100, 50, 255]);

    const originalBefore = new Uint8Array(original.rgba);
    const providerBefore = new Uint8Array(provider.rgba);
    const result = composeProviderMaskedRepair({ original, provider, masks: [{ x: 2, y: 2, width: 2, height: 2 }] });

    expect(getPixel(result, 3, 3)).toEqual([90, 80, 70, 255]);
    for (const [x, y] of drift) expect(getPixel(result, x, y)).toEqual([0, 0, 0, 0]);
    expect(result.metrics).toMatchObject({
      maskCount: 1,
      maskedPixels: 4,
      outsideMaskPixels: 60,
      discardedProviderOutsideMaskPixels: 5,
      outsideMaskChangedPixels: 0,
      outsideMaskChangedBytes: 0,
      candidateChangedPixels: 1,
      changedPixels: 1,
    });
    expect(original.rgba).toEqual(originalBefore);
    expect(provider.rgba).toEqual(providerBefore);
  });

  it('remaps only changed opaque candidates and uses ordered first-color tie breaking', () => {
    const original = frame(2, 1);
    setPixel(original, 0, 0, [9, 9, 9, 255]);
    setPixel(original, 1, 0, [3, 3, 3, 255]);
    const provider = clone(original);
    setPixel(provider, 0, 0, [1, 0, 0, 255]);

    const result = composeProviderMaskedRepair({
      original,
      provider,
      masks: [{ x: 0, y: 0, width: 2, height: 1 }],
      palette: [[2, 0, 0], [0, 0, 0]],
    });

    expect(getPixel(result, 0, 0)).toEqual([2, 0, 0, 255]);
    expect(getPixel(result, 1, 0)).toEqual([3, 3, 3, 255]);
    expect(result.metrics).toMatchObject({ candidateChangedPixels: 1, changedPixels: 1, remappedPixels: 1 });
  });

  it('enforces binary alpha and clears transparent RGB inside masks', () => {
    const original = frame(3, 1);
    const provider = clone(original);
    setPixel(provider, 0, 0, [1, 2, 3, 127]);
    setPixel(provider, 1, 0, [4, 5, 6, 128]);
    setPixel(provider, 2, 0, [7, 8, 9, 0]);

    const result = composeProviderMaskedRepair({
      original,
      provider,
      masks: [{ x: 0, y: 0, width: 3, height: 1 }],
    });

    expect([...result.rgba]).toEqual([0, 0, 0, 0, 4, 5, 6, 255, 0, 0, 0, 0]);
    expect(result.metrics).toMatchObject({
      providerPartialAlphaPixels: 2,
      alphaNormalizedPixels: 2,
      transparentRgbClearedPixels: 2,
      candidateChangedPixels: 1,
      changedPixels: 1,
    });
    for (let offset = 0; offset < result.rgba.length; offset += 4) {
      expect([0, 255]).toContain(result.rgba[offset + 3]);
      if (result.rgba[offset + 3] === 0) expect([...result.rgba.subarray(offset, offset + 3)]).toEqual([0, 0, 0]);
    }
  });

  it('keeps erase semantics by default and opt-in preserves only original opaque identity pixels', () => {
    const original = frame(3, 1);
    setPixel(original, 0, 0, [10, 20, 30, 255]);
    setPixel(original, 1, 0, [40, 50, 60, 255]);
    const provider = clone(original);
    setPixel(provider, 0, 0, [200, 100, 50, 0]);
    setPixel(provider, 1, 0, [1, 0, 0, 255]);
    setPixel(provider, 2, 0, [90, 80, 70, 0]);
    const masks = [{ x: 0, y: 0, width: 3, height: 1 }];

    const erased = composeProviderMaskedRepair({ original, provider, masks });
    expect(getPixel(erased, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(erased.metrics).toMatchObject({
      preservedOriginalOpaquePixels: 0,
      transparentRgbClearedPixels: 2,
      changedPixels: 2,
    });

    const preserved = composeProviderMaskedRepair({
      original,
      provider,
      masks,
      preserveOriginalOpaque: true,
      palette: [[2, 0, 0], [0, 0, 0]],
    });
    expect(getPixel(preserved, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(getPixel(preserved, 1, 0)).toEqual([2, 0, 0, 255]);
    expect(getPixel(preserved, 2, 0)).toEqual([0, 0, 0, 0]);
    expect(preserved.metrics).toMatchObject({
      preservedOriginalOpaquePixels: 1,
      transparentRgbClearedPixels: 1,
      candidateChangedPixels: 1,
      changedPixels: 1,
      remappedPixels: 1,
    });
  });

  it('treats overlapping rectangles as a union and counts covered pixels once', () => {
    const original = frame(4, 3);
    const provider = clone(original);
    setPixel(provider, 1, 1, [10, 20, 30, 255]);
    setPixel(provider, 2, 1, [40, 50, 60, 255]);
    setPixel(provider, 3, 2, [70, 80, 90, 255]);

    const result = composeProviderMaskedRepair({
      original,
      provider,
      masks: [
        { x: 0, y: 0, width: 3, height: 2 },
        { x: 1, y: 1, width: 3, height: 2 },
      ],
    });

    expect(result.metrics).toMatchObject({
      maskCount: 2,
      maskedPixels: 10,
      outsideMaskPixels: 2,
      changedPixels: 3,
      outsideMaskChangedPixels: 0,
      outsideMaskChangedBytes: 0,
    });
    expect(getPixel(result, 1, 1)).toEqual([10, 20, 30, 255]);
    expect(getPixel(result, 2, 1)).toEqual([40, 50, 60, 255]);
    expect(getPixel(result, 3, 2)).toEqual([70, 80, 90, 255]);
  });

  it('fails loud when the original is not already normalized', () => {
    const partial = frame(1, 1);
    setPixel(partial, 0, 0, [1, 2, 3, 128]);
    expect(() => composeProviderMaskedRepair({
      original: partial,
      provider: clone(partial),
      masks: [{ x: 0, y: 0, width: 1, height: 1 }],
    })).toThrow('original must already be normalized: pixel 0 has non-binary alpha 128');

    const dirtyTransparent = frame(1, 1);
    setPixel(dirtyTransparent, 0, 0, [1, 0, 0, 0]);
    expect(() => composeProviderMaskedRepair({
      original: dirtyTransparent,
      provider: clone(dirtyTransparent),
      masks: [{ x: 0, y: 0, width: 1, height: 1 }],
    })).toThrow('original must already be normalized: transparent pixel 0 has non-zero RGB');
  });

  it.each([
    ['non-positive dimensions', () => composeProviderMaskedRepair({
      original: { width: 0, height: 1, rgba: new Uint8Array() },
      provider: frame(1, 1), masks: [{ x: 0, y: 0, width: 1, height: 1 }],
    })],
    ['different dimensions', () => composeProviderMaskedRepair({
      original: frame(2, 1), provider: frame(1, 2), masks: [{ x: 0, y: 0, width: 1, height: 1 }],
    })],
    ['malformed original byte length', () => composeProviderMaskedRepair({
      original: { width: 1, height: 1, rgba: new Uint8Array(3) },
      provider: frame(1, 1), masks: [{ x: 0, y: 0, width: 1, height: 1 }],
    })],
    ['malformed provider byte length', () => composeProviderMaskedRepair({
      original: frame(1, 1), provider: { width: 1, height: 1, rgba: new Uint8Array(5) },
      masks: [{ x: 0, y: 0, width: 1, height: 1 }],
    })],
    ['empty masks', () => composeProviderMaskedRepair({ original: frame(2, 2), provider: frame(2, 2), masks: [] })],
    ['fractional mask', () => composeProviderMaskedRepair({
      original: frame(2, 2), provider: frame(2, 2), masks: [{ x: 0.5, y: 0, width: 1, height: 1 }],
    })],
    ['empty rectangle', () => composeProviderMaskedRepair({
      original: frame(2, 2), provider: frame(2, 2), masks: [{ x: 0, y: 0, width: 0, height: 1 }],
    })],
    ['out-of-bounds rectangle', () => composeProviderMaskedRepair({
      original: frame(2, 2), provider: frame(2, 2), masks: [{ x: 1, y: 1, width: 2, height: 1 }],
    })],
    ['empty palette', () => composeProviderMaskedRepair({
      original: frame(1, 1), provider: frame(1, 1), masks: [{ x: 0, y: 0, width: 1, height: 1 }], palette: [],
    })],
    ['malformed palette', () => composeProviderMaskedRepair({
      original: frame(1, 1), provider: frame(1, 1), masks: [{ x: 0, y: 0, width: 1, height: 1 }],
      palette: [[0, 0, 256]],
    })],
    ['invalid alpha threshold', () => composeProviderMaskedRepair({
      original: frame(1, 1), provider: frame(1, 1), masks: [{ x: 0, y: 0, width: 1, height: 1 }],
      alphaThreshold: 0,
    })],
    ['invalid preserveOriginalOpaque policy', () => composeProviderMaskedRepair({
      original: frame(1, 1), provider: frame(1, 1), masks: [{ x: 0, y: 0, width: 1, height: 1 }],
      preserveOriginalOpaque: 'yes' as unknown as boolean,
    })],
  ] satisfies readonly [string, () => MaskedRepairOptions | unknown][])(
    'rejects invalid input: %s',
    (_label, operation) => expect(operation).toThrow(),
  );
});
