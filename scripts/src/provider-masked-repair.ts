/**
 * Pure compositor for accepting only explicitly masked pixels from a
 * provider repair. The original frame is the geometry/identity authority:
 * every byte outside the masks is restored from it.
 *
 * Policy: the original must already use binary alpha and RGBA(0,0,0,0) for
 * transparent pixels. We fail instead of silently normalizing it, because
 * doing so could change bytes outside the approved repair masks.
 */

export type RepairRgb = readonly [red: number, green: number, blue: number];

export interface RepairFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface RepairMask {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskedRepairOptions {
  original: Readonly<RepairFrame>;
  provider: Readonly<RepairFrame>;
  masks: readonly Readonly<RepairMask>[];
  /** Pixels below this alpha become transparent; all others become opaque. */
  alphaThreshold?: number;
  /** Inside masks, retain original opaque pixels where the normalized provider is transparent. */
  preserveOriginalOpaque?: boolean;
  /** Squared RGB distance; the first ordered color wins equal-distance ties. */
  palette?: readonly RepairRgb[];
}

export interface MaskedRepairMetrics {
  maskCount: number;
  maskedPixels: number;
  outsideMaskPixels: number;
  /** Provider-side differences outside the masks that were deliberately discarded. */
  discardedProviderOutsideMaskPixels: number;
  /** Must remain zero; output is compared byte-for-byte with the original. */
  outsideMaskChangedPixels: number;
  /** Must remain zero; output is compared byte-for-byte with the original. */
  outsideMaskChangedBytes: number;
  /** Masked pixels differing from original after alpha normalization, before palette remapping. */
  candidateChangedPixels: number;
  /** Masked output pixels differing byte-for-byte from the original. */
  changedPixels: number;
  /** Changed opaque candidate pixels whose RGB was altered by palette remapping. */
  remappedPixels: number;
  providerPartialAlphaPixels: number;
  alphaNormalizedPixels: number;
  transparentRgbClearedPixels: number;
  /** Transparent provider candidates replaced byte-for-byte by opaque original pixels. */
  preservedOriginalOpaquePixels: number;
}

export interface MaskedRepairResult extends RepairFrame {
  metrics: MaskedRepairMetrics;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertFrame(frame: Readonly<RepairFrame>, label: string): number {
  if (frame === null || typeof frame !== 'object') throw new Error(`${label} must be a decoded RGBA frame`);
  assertPositiveInteger(frame.width, `${label}.width`);
  assertPositiveInteger(frame.height, `${label}.height`);
  const pixels = frame.width * frame.height;
  const expectedBytes = pixels * 4;
  if (!Number.isSafeInteger(expectedBytes)) throw new Error(`${label} dimensions are too large`);
  if (!(frame.rgba instanceof Uint8Array) || frame.rgba.length !== expectedBytes) {
    throw new Error(`${label}.rgba must contain exactly ${expectedBytes} 8-bit RGBA bytes`);
  }
  return pixels;
}

function assertNormalizedOriginal(frame: Readonly<RepairFrame>): void {
  for (let offset = 0; offset < frame.rgba.length; offset += 4) {
    const alpha = frame.rgba[offset + 3]!;
    const pixel = offset / 4;
    if (alpha !== 0 && alpha !== 255) {
      throw new Error(`original must already be normalized: pixel ${pixel} has non-binary alpha ${alpha}`);
    }
    if (alpha === 0 && (frame.rgba[offset] !== 0 || frame.rgba[offset + 1] !== 0 || frame.rgba[offset + 2] !== 0)) {
      throw new Error(`original must already be normalized: transparent pixel ${pixel} has non-zero RGB`);
    }
  }
}

function assertPalette(palette: readonly RepairRgb[] | undefined): readonly RepairRgb[] | undefined {
  if (palette === undefined) return undefined;
  if (!Array.isArray(palette) || palette.length === 0) throw new Error('palette must be a non-empty ordered array');
  for (const [index, color] of palette.entries()) {
    if (!Array.isArray(color) || color.length !== 3 || color.some((channel) =>
      !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      throw new Error(`palette[${index}] must contain three 8-bit integer channels`);
    }
  }
  return palette;
}

function nearestColor(red: number, green: number, blue: number, palette: readonly RepairRgb[]): RepairRgb {
  let selected = palette[0]!;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const dr = red - color[0];
    const dg = green - color[1];
    const db = blue - color[2];
    const distance = (dr * dr) + (dg * dg) + (db * db);
    if (distance < selectedDistance) {
      selected = color;
      selectedDistance = distance;
    }
  }
  return selected;
}

function pixelDiffers(left: Uint8Array, right: Uint8Array, offset: number): boolean {
  return left[offset] !== right[offset]
    || left[offset + 1] !== right[offset + 1]
    || left[offset + 2] !== right[offset + 2]
    || left[offset + 3] !== right[offset + 3];
}

function validatedMaskCoverage(
  masks: readonly Readonly<RepairMask>[],
  width: number,
  height: number,
  pixelCount: number,
): { coverage: Uint8Array; maskedPixels: number } {
  if (!Array.isArray(masks) || masks.length === 0) throw new Error('masks must contain at least one rectangle');
  const coverage = new Uint8Array(pixelCount);
  let maskedPixels = 0;
  for (const [index, mask] of masks.entries()) {
    if (mask === null || typeof mask !== 'object') throw new Error(`masks[${index}] must be a rectangle`);
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (!Number.isSafeInteger(mask[field])) throw new Error(`masks[${index}].${field} must be an integer`);
    }
    if (mask.width <= 0 || mask.height <= 0) throw new Error(`masks[${index}] must have positive width and height`);
    if (mask.x < 0 || mask.y < 0 || mask.x + mask.width > width || mask.y + mask.height > height) {
      throw new Error(`masks[${index}] is outside the ${width}x${height} frame`);
    }
    for (let y = mask.y; y < mask.y + mask.height; y += 1) {
      for (let x = mask.x; x < mask.x + mask.width; x += 1) {
        const pixel = (y * width) + x;
        if (coverage[pixel] !== 0) continue;
        coverage[pixel] = 1;
        maskedPixels += 1;
      }
    }
  }
  return { coverage, maskedPixels };
}

export function composeProviderMaskedRepair(options: Readonly<MaskedRepairOptions>): MaskedRepairResult {
  if (options === null || typeof options !== 'object') throw new Error('options must be provided');
  const pixelCount = assertFrame(options.original, 'original');
  assertFrame(options.provider, 'provider');
  if (options.original.width !== options.provider.width || options.original.height !== options.provider.height) {
    throw new Error('original and provider dimensions must match exactly');
  }
  assertNormalizedOriginal(options.original);

  const alphaThreshold = options.alphaThreshold ?? 128;
  if (!Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 255) {
    throw new Error('alphaThreshold must be an integer from 1 through 255');
  }
  const preserveOriginalOpaque = options.preserveOriginalOpaque ?? false;
  if (typeof preserveOriginalOpaque !== 'boolean') throw new Error('preserveOriginalOpaque must be a boolean');
  const palette = assertPalette(options.palette);
  const { coverage, maskedPixels } = validatedMaskCoverage(
    options.masks,
    options.original.width,
    options.original.height,
    pixelCount,
  );

  const output = new Uint8Array(options.original.rgba);
  let discardedProviderOutsideMaskPixels = 0;
  let candidateChangedPixels = 0;
  let changedPixels = 0;
  let remappedPixels = 0;
  let providerPartialAlphaPixels = 0;
  let alphaNormalizedPixels = 0;
  let transparentRgbClearedPixels = 0;
  let preservedOriginalOpaquePixels = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    if (coverage[pixel] === 0) {
      if (pixelDiffers(options.original.rgba, options.provider.rgba, offset)) {
        discardedProviderOutsideMaskPixels += 1;
      }
      continue;
    }

    const sourceRed = options.provider.rgba[offset]!;
    const sourceGreen = options.provider.rgba[offset + 1]!;
    const sourceBlue = options.provider.rgba[offset + 2]!;
    const sourceAlpha = options.provider.rgba[offset + 3]!;
    if (sourceAlpha > 0 && sourceAlpha < 255) providerPartialAlphaPixels += 1;

    let outputAlpha = sourceAlpha < alphaThreshold ? 0 : 255;
    if (outputAlpha !== sourceAlpha) alphaNormalizedPixels += 1;
    let outputRed = outputAlpha === 0 ? 0 : sourceRed;
    let outputGreen = outputAlpha === 0 ? 0 : sourceGreen;
    let outputBlue = outputAlpha === 0 ? 0 : sourceBlue;
    if (outputAlpha === 0 && preserveOriginalOpaque && options.original.rgba[offset + 3] === 255) {
      outputRed = options.original.rgba[offset]!;
      outputGreen = options.original.rgba[offset + 1]!;
      outputBlue = options.original.rgba[offset + 2]!;
      outputAlpha = 255;
      preservedOriginalOpaquePixels += 1;
    } else if (outputAlpha === 0 && (sourceRed !== 0 || sourceGreen !== 0 || sourceBlue !== 0)) {
      transparentRgbClearedPixels += 1;
    }

    const candidateDiffers = outputRed !== options.original.rgba[offset]
      || outputGreen !== options.original.rgba[offset + 1]
      || outputBlue !== options.original.rgba[offset + 2]
      || outputAlpha !== options.original.rgba[offset + 3];
    if (candidateDiffers) candidateChangedPixels += 1;
    if (candidateDiffers && outputAlpha === 255 && palette !== undefined) {
      const mapped = nearestColor(outputRed, outputGreen, outputBlue, palette);
      if (mapped[0] !== outputRed || mapped[1] !== outputGreen || mapped[2] !== outputBlue) remappedPixels += 1;
      outputRed = mapped[0];
      outputGreen = mapped[1];
      outputBlue = mapped[2];
    }

    output[offset] = outputRed;
    output[offset + 1] = outputGreen;
    output[offset + 2] = outputBlue;
    output[offset + 3] = outputAlpha;
    if (pixelDiffers(output, options.original.rgba, offset)) changedPixels += 1;
  }

  let outsideMaskChangedPixels = 0;
  let outsideMaskChangedBytes = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (coverage[pixel] !== 0) continue;
    const offset = pixel * 4;
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (output[offset + channel] !== options.original.rgba[offset + channel]) {
        outsideMaskChangedBytes += 1;
        pixelChanged = true;
      }
    }
    if (pixelChanged) outsideMaskChangedPixels += 1;
  }

  return {
    width: options.original.width,
    height: options.original.height,
    rgba: output,
    metrics: {
      maskCount: options.masks.length,
      maskedPixels,
      outsideMaskPixels: pixelCount - maskedPixels,
      discardedProviderOutsideMaskPixels,
      outsideMaskChangedPixels,
      outsideMaskChangedBytes,
      candidateChangedPixels,
      changedPixels,
      remappedPixels,
      providerPartialAlphaPixels,
      alphaNormalizedPixels,
      transparentRgbClearedPixels,
      preservedOriginalOpaquePixels,
    },
  };
}
