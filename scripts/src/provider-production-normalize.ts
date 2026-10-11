/**
 * Pure, offline provider production-frame normalization. The caller decodes
 * PNGs before this boundary and encodes the returned bytes after it. This file
 * never reads paths, performs network I/O, rescales, or repaints pixels.
 */

export const PROVIDER_PRODUCTION_NORMALIZER_VERSION = 1 as const;

export type Rgb = readonly [red: number, green: number, blue: number];
export type FrameToken = string | number;
export interface SourceOffset { x: number; y: number }

export interface DecodedFrame {
  direction: string;
  frame: FrameToken;
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface FrameGroupOptions {
  frames: readonly DecodedFrame[];
  runtimeCell: Readonly<{ width: number; height: number }>;
  /** Default crop origin preference, overridden per direction when supplied. */
  preferredSourceOffset: Readonly<SourceOffset>;
  preferredSourceOffsets?: Readonly<Record<string, Readonly<SourceOffset>>>;
  directionOrder: readonly string[];
  frameOrder: readonly FrameToken[];
  alphaThreshold?: number;
  palette?: readonly Rgb[];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface NormalizedFrame {
  direction: string;
  frame: FrameToken;
  width: number;
  height: number;
  rgba: Uint8Array;
  metrics: {
    opaquePixels: number;
    transparentPixels: number;
    partialAlphaPixels: number;
    remappedPixels: number;
    sourceOpaqueColors: number;
    outputOpaqueColors: number;
  };
}

export interface TransformMetadata {
  schemaVersion: typeof PROVIDER_PRODUCTION_NORMALIZER_VERSION;
  transform: 'shardkeep-provider-production-normalizer';
  runtimeCell: { width: number; height: number };
  directions: readonly {
    direction: string;
    providerCanvas: { width: number; height: number };
    preferredSourceOffset: SourceOffset;
    sourceWindow: { x: number; y: number; width: number; height: number };
    anchorDelta: SourceOffset;
    unionOpaqueBounds: Bounds;
    runtimeUnionOpaqueBounds: Bounds;
    crop: { left: number; top: number; right: number; bottom: number };
    padding: { left: number; top: number; right: number; bottom: number };
  }[];
  alphaThreshold: number;
  palette: readonly string[] | null;
  directionOrder: readonly string[];
  frameOrder: readonly FrameToken[];
  outputSheet: { width: number; height: number; rows: number; columns: number };
  frames: readonly Omit<NormalizedFrame, 'rgba' | 'width' | 'height'>[];
  policy: {
    alpha: 'alpha below threshold becomes transparent RGBA0; all other alpha becomes 255';
    crop: 'exact caller-requested per-direction source window; reject if union does not fit; no rescale';
    palette: 'squared Euclidean RGB distance; first ordered entry wins ties';
    sheet: 'direction rows then frame columns, exactly as ordered by caller';
  };
}

export interface NormalizedFrameGroup {
  frames: readonly NormalizedFrame[];
  sheet: { width: number; height: number; rgba: Uint8Array };
  metadata: TransformMetadata;
  /** Stable-property-order JSON suitable for hashing alongside encoded PNGs. */
  metadataJson: string;
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function tokenKey(direction: string, frame: FrameToken): string {
  return `${direction.length}:${direction}|${typeof frame}:${String(frame)}`;
}

function orderedPalette(palette: readonly Rgb[] | undefined): readonly Rgb[] | undefined {
  if (palette === undefined) return undefined;
  if (palette.length === 0) throw new Error('palette must not be empty');
  for (const [index, color] of palette.entries()) {
    if (color.length !== 3 || color.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      throw new Error(`palette[${index}] must contain three 8-bit integer channels`);
    }
  }
  return palette;
}

function nearest(red: number, green: number, blue: number, palette: readonly Rgb[]): Rgb {
  let result = palette[0]!;
  let best = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const dr = red - color[0];
    const dg = green - color[1];
    const db = blue - color[2];
    const distance = (dr * dr) + (dg * dg) + (db * db);
    if (distance < best) {
      result = color;
      best = distance;
    }
  }
  return result;
}

interface PreparedFrame {
  source: DecodedFrame;
  rgba: Uint8Array;
  partialAlphaPixels: number;
  remappedPixels: number;
  sourceOpaqueColors: number;
  outputOpaqueColors: number;
  opaquePixels: number;
}

function prepareFrame(frame: DecodedFrame, alphaThreshold: number, palette: readonly Rgb[] | undefined): PreparedFrame {
  const output = new Uint8Array(frame.rgba.length);
  const sourceColors = new Set<number>();
  const outputColors = new Set<number>();
  let partialAlphaPixels = 0;
  let remappedPixels = 0;
  let opaquePixels = 0;
  for (let offset = 0; offset < frame.rgba.length; offset += 4) {
    const alpha = frame.rgba[offset + 3]!;
    if (alpha > 0 && alpha < 255) partialAlphaPixels += 1;
    if (alpha < alphaThreshold) continue;
    opaquePixels += 1;
    const sourceKey = (frame.rgba[offset]! << 16) | (frame.rgba[offset + 1]! << 8) | frame.rgba[offset + 2]!;
    sourceColors.add(sourceKey);
    const color = palette === undefined
      ? [frame.rgba[offset]!, frame.rgba[offset + 1]!, frame.rgba[offset + 2]!] as const
      : nearest(frame.rgba[offset]!, frame.rgba[offset + 1]!, frame.rgba[offset + 2]!, palette);
    const outputKey = (color[0] << 16) | (color[1] << 8) | color[2];
    outputColors.add(outputKey);
    if (outputKey !== sourceKey) remappedPixels += 1;
    output[offset] = color[0];
    output[offset + 1] = color[1];
    output[offset + 2] = color[2];
    output[offset + 3] = 255;
  }
  return { source: frame, rgba: output, partialAlphaPixels, remappedPixels,
    sourceOpaqueColors: sourceColors.size, outputOpaqueColors: outputColors.size, opaquePixels };
}

function unionBounds(frames: readonly PreparedFrame[], width: number, height: number): Bounds {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const frame of frames) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (frame.rgba[((y * width) + x) * 4 + 3] === 0) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) throw new Error('frame group has no opaque pixels after alpha thresholding');
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function exactWindowOffset(
  runtimeSize: number,
  unionMin: number,
  unionMax: number,
  requested: number,
  axis: string,
  direction: string,
): number {
  if (unionMax - unionMin + 1 > runtimeSize) {
    throw new Error(`${direction}: union opaque ${axis} bounds [${unionMin},${unionMax}] span ${unionMax - unionMin + 1} ` +
      `exceeds runtime ${axis} ${runtimeSize}; rescaling is forbidden`);
  }
  const requestedMax = requested + runtimeSize - 1;
  if (unionMin < requested || unionMax > requestedMax) {
    throw new Error(`${direction}: union opaque ${axis} bounds [${unionMin},${unionMax}] do not fit requested ` +
      `${axis} window [${requested},${requestedMax}]; exact anchor mapping forbids clamping`);
  }
  return requested;
}

function boundsAtRuntime(bounds: Bounds, x: number, y: number): Bounds {
  return { minX: bounds.minX - x, minY: bounds.minY - y, maxX: bounds.maxX - x,
    maxY: bounds.maxY - y, width: bounds.width, height: bounds.height };
}

function paletteHex(palette: readonly Rgb[] | undefined): readonly string[] | null {
  return palette?.map((color) => `#${color.map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`) ?? null;
}

export function normalizeProviderFrameGroup(options: FrameGroupOptions): NormalizedFrameGroup {
  if (options.frames.length === 0) throw new Error('frames must not be empty');
  positiveInteger(options.runtimeCell.width, 'runtimeCell.width');
  positiveInteger(options.runtimeCell.height, 'runtimeCell.height');
  if (!Number.isSafeInteger(options.preferredSourceOffset.x) || !Number.isSafeInteger(options.preferredSourceOffset.y)) {
    throw new Error('preferredSourceOffset must use integer coordinates');
  }
  if (options.directionOrder.length === 0 || new Set(options.directionOrder).size !== options.directionOrder.length) {
    throw new Error('directionOrder must be non-empty and unique');
  }
  if (options.frameOrder.length === 0 || new Set(options.frameOrder.map((frame) => `${typeof frame}:${String(frame)}`)).size !== options.frameOrder.length) {
    throw new Error('frameOrder must be non-empty and unique');
  }
  for (const [direction, offset] of Object.entries(options.preferredSourceOffsets ?? {})) {
    if (!options.directionOrder.includes(direction)) throw new Error(`preferredSourceOffsets contains unexpected direction ${direction}`);
    if (!Number.isSafeInteger(offset.x) || !Number.isSafeInteger(offset.y)) {
      throw new Error(`preferredSourceOffsets.${direction} must use integer coordinates`);
    }
  }
  const alphaThreshold = options.alphaThreshold ?? 128;
  if (!Number.isInteger(alphaThreshold) || alphaThreshold < 1 || alphaThreshold > 255) {
    throw new Error('alphaThreshold must be an integer from 1 through 255');
  }
  const palette = orderedPalette(options.palette);
  const byIdentity = new Map<string, PreparedFrame>();
  for (const frame of options.frames) {
    positiveInteger(frame.width, `${frame.direction}/${String(frame.frame)} width`);
    positiveInteger(frame.height, `${frame.direction}/${String(frame.frame)} height`);
    if (frame.rgba.length !== frame.width * frame.height * 4) throw new Error(`${frame.direction}/${String(frame.frame)} has invalid 8-bit RGBA byte length`);
    const key = tokenKey(frame.direction, frame.frame);
    if (byIdentity.has(key)) throw new Error(`duplicate frame ${frame.direction}/${String(frame.frame)}`);
    byIdentity.set(key, prepareFrame(frame, alphaThreshold, palette));
  }
  const expectedKeys = options.directionOrder.flatMap((direction) => options.frameOrder.map((frame) => tokenKey(direction, frame)));
  const missing = expectedKeys.filter((key) => !byIdentity.has(key));
  const unexpected = [...byIdentity.keys()].filter((key) => !expectedKeys.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`frame group must exactly cover directionOrder × frameOrder (missing ${missing.length}, unexpected ${unexpected.length})`);
  }
  const cellBytes = options.runtimeCell.width * options.runtimeCell.height * 4;
  const normalizedFrames: NormalizedFrame[] = [];
  const directionMetadata: TransformMetadata['directions'][number][] = [];
  for (const direction of options.directionOrder) {
    const preparedFrames = options.frameOrder.map((frame) => byIdentity.get(tokenKey(direction, frame))!);
    const providerWidth = preparedFrames[0]!.source.width;
    const providerHeight = preparedFrames[0]!.source.height;
    if (!preparedFrames.every(({ source }) => source.width === providerWidth && source.height === providerHeight)) {
      throw new Error(`frames within direction ${direction} must share one provider canvas`);
    }
    const union = unionBounds(preparedFrames, providerWidth, providerHeight);
    const preferred = options.preferredSourceOffsets?.[direction] ?? options.preferredSourceOffset;
    const windowX = exactWindowOffset(options.runtimeCell.width, union.minX, union.maxX, preferred.x, 'width', direction);
    const windowY = exactWindowOffset(options.runtimeCell.height, union.minY, union.maxY, preferred.y, 'height', direction);
    for (const prepared of preparedFrames) {
      const rgba = new Uint8Array(cellBytes);
      for (let y = 0; y < options.runtimeCell.height; y += 1) {
        const sourceY = windowY + y;
        if (sourceY < 0 || sourceY >= providerHeight) continue;
        for (let x = 0; x < options.runtimeCell.width; x += 1) {
          const sourceX = windowX + x;
          if (sourceX < 0 || sourceX >= providerWidth) continue;
          const sourceOffset = ((sourceY * providerWidth) + sourceX) * 4;
          rgba.set(prepared.rgba.subarray(sourceOffset, sourceOffset + 4), ((y * options.runtimeCell.width) + x) * 4);
        }
      }
      normalizedFrames.push({ direction: prepared.source.direction, frame: prepared.source.frame,
        width: options.runtimeCell.width, height: options.runtimeCell.height, rgba,
        metrics: { opaquePixels: prepared.opaquePixels,
          transparentPixels: (providerWidth * providerHeight) - prepared.opaquePixels,
          partialAlphaPixels: prepared.partialAlphaPixels, remappedPixels: prepared.remappedPixels,
          sourceOpaqueColors: prepared.sourceOpaqueColors, outputOpaqueColors: prepared.outputOpaqueColors } });
    }
    directionMetadata.push({ direction, providerCanvas: { width: providerWidth, height: providerHeight },
      preferredSourceOffset: { x: preferred.x, y: preferred.y },
      sourceWindow: { x: windowX, y: windowY, width: options.runtimeCell.width, height: options.runtimeCell.height },
      anchorDelta: { x: -windowX, y: -windowY }, unionOpaqueBounds: union,
      runtimeUnionOpaqueBounds: boundsAtRuntime(union, windowX, windowY),
      crop: { left: Math.max(0, windowX), top: Math.max(0, windowY),
        right: Math.max(0, providerWidth - windowX - options.runtimeCell.width),
        bottom: Math.max(0, providerHeight - windowY - options.runtimeCell.height) },
      padding: { left: Math.max(0, -windowX), top: Math.max(0, -windowY),
        right: Math.max(0, windowX + options.runtimeCell.width - providerWidth),
        bottom: Math.max(0, windowY + options.runtimeCell.height - providerHeight) } });
  }
  const sheetWidth = options.runtimeCell.width * options.frameOrder.length;
  const sheetHeight = options.runtimeCell.height * options.directionOrder.length;
  const sheet = new Uint8Array(sheetWidth * sheetHeight * 4);
  normalizedFrames.forEach((frame, index) => {
    const row = Math.floor(index / options.frameOrder.length);
    const column = index % options.frameOrder.length;
    for (let y = 0; y < frame.height; y += 1) {
      const sourceStart = y * frame.width * 4;
      const targetStart = (((row * frame.height + y) * sheetWidth) + (column * frame.width)) * 4;
      sheet.set(frame.rgba.subarray(sourceStart, sourceStart + frame.width * 4), targetStart);
    }
  });
  const metadata: TransformMetadata = {
    schemaVersion: PROVIDER_PRODUCTION_NORMALIZER_VERSION,
    transform: 'shardkeep-provider-production-normalizer',
    runtimeCell: { width: options.runtimeCell.width, height: options.runtimeCell.height },
    directions: directionMetadata,
    alphaThreshold, palette: paletteHex(palette), directionOrder: [...options.directionOrder],
    frameOrder: [...options.frameOrder],
    outputSheet: { width: sheetWidth, height: sheetHeight, rows: options.directionOrder.length, columns: options.frameOrder.length },
    frames: normalizedFrames.map(({ direction, frame, metrics }) => ({ direction, frame, metrics })),
    policy: {
      alpha: 'alpha below threshold becomes transparent RGBA0; all other alpha becomes 255',
      crop: 'exact caller-requested per-direction source window; reject if union does not fit; no rescale',
      palette: 'squared Euclidean RGB distance; first ordered entry wins ties',
      sheet: 'direction rows then frame columns, exactly as ordered by caller',
    },
  };
  return { frames: normalizedFrames, sheet: { width: sheetWidth, height: sheetHeight, rgba: sheet },
    metadata, metadataJson: JSON.stringify(metadata) };
}
