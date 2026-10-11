/**
 * Offline, deterministic boundary between provider proof exports and the
 * SHARDKEEP candidate-art gate. This module performs no network calls and has
 * no credential/configuration inputs: it consumes one fixed local inventory,
 * normalizes pixels, validates the result, and writes three candidate sheets.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { ART_CANDIDATE_ENV, ART_CANDIDATE_FILES } from './art-candidate.js';
import {
  PALETTE_16,
  V2_PALETTE,
} from './rasterize.js';

export const PROVIDER_PROOF_NORMALIZER_VERSION = 2 as const;
export const PROVIDER_PROOF_DIRECTIONS = ['s', 'sw', 'w', 'nw', 'n', 'ne', 'e', 'se'] as const;
export const KEEP_MASK_FALLBACK_LIMIT_PERCENT = 5 as const;

export const KEEP_CELL = { width: 144, height: 136 } as const;
export const KEEP_OWNER_IDENTITY_SHA256 = 'ede51193991184c5e43b2a98dc4d43079ec195e485ef4ac1a03260b154de7e1c' as const;
export const GIANT_CELL = { width: 112, height: 112 } as const;
export const GIANT_ANCHOR = { x: 56, y: 100 } as const;
export const GIANT_MIN_OPAQUE_PIXELS = 1_000 as const;
export const GIANT_MIN_BBOX_WIDTH = 32 as const;
export const GIANT_MIN_BBOX_HEIGHT = 48 as const;

/**
 * Symmetric semantic regions measured from the immutable 144x136 L20 master.
 * Only reference-derived structural edges/signature pixels inside these boxes
 * are overlaid; flat interiors remain available for material/detail upgrades.
 */
export const KEEP_PROTECTED_FEATURE_REGIONS = [
  { name: 'central-tower-device', x: 48, y: 40, width: 48, height: 57 },
  { name: 'left-window', x: 52, y: 47, width: 17, height: 23 },
  { name: 'right-window', x: 75, y: 47, width: 17, height: 23 },
  { name: 'centered-arch', x: 56, y: 102, width: 32, height: 34 },
  { name: 'left-battery', x: 31, y: 76, width: 26, height: 25 },
  { name: 'right-battery', x: 87, y: 76, width: 26, height: 25 },
] as const;

export type ProofDirection = typeof PROVIDER_PROOF_DIRECTIONS[number];
export type Rgb = readonly [red: number, green: number, blue: number];

export interface RgbaImage {
  width: number;
  height: number;
  data: Buffer;
}

export interface KeepNormalizationResult {
  /** Runtime frames: normalized source frames 1, 2, and 3. */
  frames: readonly [Buffer, Buffer, Buffer];
  /** Auditable generated-pixel gaps for all four source frames. */
  maskFallbackPixels: readonly [number, number, number, number];
  referenceOpaquePixels: number;
  protectedFeaturePixels: number;
}

export interface GiantFrameMetrics {
  opaquePixels: number;
  groundPixels: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
}

export interface ProofPublicationOptions {
  /** Failure-injection/review barrier called after staging and before the one atomic pointer swap. */
  beforeActivate?: (() => void | Promise<void>) | undefined;
}

interface LoadedPng extends RgbaImage {
  encoded: Buffer;
  sha256: string;
}

interface ProvenanceFileHash {
  file: string;
  sha256: string;
}

export interface ProviderProofNormalizationProvenance {
  schemaVersion: typeof PROVIDER_PROOF_NORMALIZER_VERSION;
  normalizer: 'shardkeep-provider-proof-normalizer';
  transformPolicy: {
    execution: 'offline-only';
    input: '8-bit RGBA static PNG; exact canvas required; no resize or inferred anchor';
    pixels: 'byte-exact accepted game-v4 RGBA pixels; no palette remap, mask repair, resize, or translation';
    keepIdentity: 'reference and KEEP idle frame-01 must have identical decoded RGBA';
    giantCell: 'hash-pinned accepted game-v4 sheets; metrics are recorded but do not rewrite accepted anchor placement';
    output: 'row-major assembly with deterministic PNG encoding; encoded SHA256 must equal the accepted game-v4 pin';
    acceptedOutputs: readonly {
      file: string;
      sha256: string;
      width: number;
      height: number;
    }[];
  };
  selection: {
    keep: {
      sourceFrames: readonly [1, 2, 3, 4];
      outputFrames: readonly [1, 2, 3];
      closure: 'source frame-04 must byte-equal source frame-01';
      identity: 'reference must byte-equal source frame-01 decoded RGBA';
    };
    giant: {
      directions: typeof PROVIDER_PROOF_DIRECTIONS;
      walkFrames: readonly [1, 2, 3, 4, 5, 6, 7, 8];
      throwFrames: readonly [1, 2, 3, 4, 5, 6];
      frameChecks: readonly ({
        state: 'walk' | 'throw';
        direction: ProofDirection;
        frame: number;
      } & GiantFrameMetrics)[];
    };
  };
  inputs: readonly ProvenanceFileHash[];
  outputs: readonly (ProvenanceFileHash & { width: number; height: number })[];
}

function parsePalette(palette: ReadonlySet<string>): Rgb[] {
  return [...palette].map((hex) => {
    if (!/^#[0-9A-F]{6}$/.test(hex)) throw new Error(`invalid closed-palette entry ${hex}`);
    return Object.freeze([
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ]) as Rgb;
  });
}

function uniquePalette(...palettes: readonly Rgb[][]): readonly Rgb[] {
  const seen = new Set<number>();
  const result: Rgb[] = [];
  for (const palette of palettes) {
    for (const color of palette) {
      const key = (color[0] << 16) | (color[1] << 8) | color[2];
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(color);
    }
  }
  return Object.freeze(result);
}

export const GIANT_PROOF_PALETTE = uniquePalette(parsePalette(V2_PALETTE));
export const KEEP_PROOF_PALETTE = uniquePalette(parsePalette(V2_PALETTE), parsePalette(PALETTE_16));

export function nearestPaletteColor(
  red: number,
  green: number,
  blue: number,
  palette: readonly Rgb[],
): Rgb {
  if (palette.length === 0) throw new Error('closed palette must not be empty');
  let nearest = palette[0]!;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const redDelta = red - color[0];
    const greenDelta = green - color[1];
    const blueDelta = blue - color[2];
    const distance = (redDelta * redDelta) + (greenDelta * greenDelta) + (blueDelta * blueDelta);
    // Deliberately strict: insertion order is the stable tie-break rule.
    if (distance < nearestDistance) {
      nearest = color;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function normalizeRgbaPixelsWithCache(
  source: Buffer,
  palette: readonly Rgb[],
  cache: Map<number, Rgb>,
): Buffer {
  if (source.length % 4 !== 0) throw new Error('RGBA byte length must be divisible by four');
  const normalized = Buffer.alloc(source.length);
  for (let offset = 0; offset < source.length; offset += 4) {
    if (source[offset + 3]! < 128) continue;
    const key = (source[offset]! << 16) | (source[offset + 1]! << 8) | source[offset + 2]!;
    let color = cache.get(key);
    if (color === undefined) {
      color = nearestPaletteColor(source[offset]!, source[offset + 1]!, source[offset + 2]!, palette);
      cache.set(key, color);
    }
    normalized[offset] = color[0];
    normalized[offset + 1] = color[1];
    normalized[offset + 2] = color[2];
    normalized[offset + 3] = 255;
  }
  return normalized;
}

/** Normalize one decoded RGBA buffer with binary alpha and a closed palette. */
export function normalizeRgbaPixels(source: Buffer, palette: readonly Rgb[]): Buffer {
  return normalizeRgbaPixelsWithCache(source, palette, new Map());
}

const KEEP_SIGNATURE_COLORS = new Set([
  '#100D15', '#1E1A26', '#2B2533', // silhouette/architectural outlines
  '#14181D', '#23282F', '#3C444E', // portcullis and battery iron
  '#9C6F1E', '#E3AE3C', '#F4D77B', '#FFF3C4', // $KEEP gold device
  '#0E4A52', '#1E8F94', '#6FE0D9', '#C4FFF6', // central shard
].map((hex) => Number.parseInt(hex.slice(1), 16)));

function protectedFeatureMaskFromNormalizedReference(normalizedReference: Buffer): Buffer {
  const mask = Buffer.alloc(KEEP_CELL.width * KEEP_CELL.height);
  const inProtectedRegion = (x: number, y: number): boolean => KEEP_PROTECTED_FEATURE_REGIONS.some((region) =>
    x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height);
  const pixelKey = (x: number, y: number): number => {
    const offset = ((y * KEEP_CELL.width) + x) * 4;
    return (normalizedReference[offset]! << 24) |
      (normalizedReference[offset + 1]! << 16) |
      (normalizedReference[offset + 2]! << 8) |
      normalizedReference[offset + 3]!;
  };

  for (let y = 0; y < KEEP_CELL.height; y += 1) {
    for (let x = 0; x < KEEP_CELL.width; x += 1) {
      if (!inProtectedRegion(x, y)) continue;
      const offset = ((y * KEEP_CELL.width) + x) * 4;
      const rgb = (normalizedReference[offset]! << 16) |
        (normalizedReference[offset + 1]! << 8) |
        normalizedReference[offset + 2]!;
      const signature = normalizedReference[offset + 3] === 255 && KEEP_SIGNATURE_COLORS.has(rgb);
      const current = pixelKey(x, y);
      const structuralEdge = (
        (x > 0 && pixelKey(x - 1, y) !== current) ||
        (x + 1 < KEEP_CELL.width && pixelKey(x + 1, y) !== current) ||
        (y > 0 && pixelKey(x, y - 1) !== current) ||
        (y + 1 < KEEP_CELL.height && pixelKey(x, y + 1) !== current)
      );
      if (signature || structuralEdge) mask[(y * KEEP_CELL.width) + x] = 1;
    }
  }

  // Geometry coverage itself must be bilateral even where lighting/materials
  // make the reference colors asymmetric.
  for (let y = 0; y < KEEP_CELL.height; y += 1) {
    for (let x = 0; x < KEEP_CELL.width; x += 1) {
      if (mask[(y * KEEP_CELL.width) + x] === 1) {
        mask[(y * KEEP_CELL.width) + (KEEP_CELL.width - 1 - x)] = 1;
      }
    }
  }
  return mask;
}

/** Build the immutable internal-logo structural overlay mask from the supplied reference. */
export function buildKeepProtectedFeatureMask(reference: RgbaImage): Buffer {
  assertImageShape(reference, KEEP_CELL, 'KEEP silhouette reference');
  return protectedFeatureMaskFromNormalizedReference(
    normalizeRgbaPixels(reference.data, KEEP_PROOF_PALETTE),
  );
}

function assertImageShape(image: RgbaImage, expected: typeof KEEP_CELL, label: string): void {
  if (image.width !== expected.width || image.height !== expected.height) {
    throw new Error(`${label}: image is ${image.width}x${image.height}, expected ${expected.width}x${expected.height}`);
  }
  const expectedBytes = expected.width * expected.height * 4;
  if (image.data.length !== expectedBytes) {
    throw new Error(`${label}: decoded RGBA has ${image.data.length} bytes, expected ${expectedBytes}`);
  }
}

/**
 * Apply the current KEEP's alpha as an authoritative binary mask. Generated
 * gaps inside the mask receive the normalized reference color and are counted;
 * more than 5% is rejected rather than silently presenting a repaired result.
 */
export function normalizeKeepFrames(
  sourceFrames: readonly [RgbaImage, RgbaImage, RgbaImage, RgbaImage],
  reference: RgbaImage,
): KeepNormalizationResult {
  assertImageShape(reference, KEEP_CELL, 'KEEP silhouette reference');
  sourceFrames.forEach((frame, index) => assertImageShape(frame, KEEP_CELL, `KEEP frame-${index + 1}`));

  const cache = new Map<number, Rgb>();
  const normalizedReference = normalizeRgbaPixelsWithCache(reference.data, KEEP_PROOF_PALETTE, cache);
  const protectedFeatureMask = protectedFeatureMaskFromNormalizedReference(normalizedReference);
  let protectedFeaturePixels = 0;
  for (const value of protectedFeatureMask) protectedFeaturePixels += value;
  if (protectedFeaturePixels === 0) throw new Error('KEEP reference has no protected feature geometry');
  let referenceOpaquePixels = 0;
  for (let offset = 3; offset < reference.data.length; offset += 4) {
    if (reference.data[offset]! >= 128) referenceOpaquePixels += 1;
  }
  if (referenceOpaquePixels === 0) throw new Error('KEEP silhouette reference has no opaque pixels');

  const normalizedFrames: Buffer[] = [];
  const fallbackCounts: number[] = [];
  for (let frameIndex = 0; frameIndex < sourceFrames.length; frameIndex += 1) {
    const source = sourceFrames[frameIndex]!;
    const normalized = normalizeRgbaPixelsWithCache(source.data, KEEP_PROOF_PALETTE, cache);
    let fallbackPixels = 0;
    for (let offset = 0; offset < normalized.length; offset += 4) {
      if (reference.data[offset + 3]! < 128) {
        normalized[offset] = 0;
        normalized[offset + 1] = 0;
        normalized[offset + 2] = 0;
        normalized[offset + 3] = 0;
      } else if (normalized[offset + 3] === 0) {
        normalized[offset] = normalizedReference[offset]!;
        normalized[offset + 1] = normalizedReference[offset + 1]!;
        normalized[offset + 2] = normalizedReference[offset + 2]!;
        normalized[offset + 3] = 255;
        fallbackPixels += 1;
      }
      if (protectedFeatureMask[offset / 4] === 1) {
        normalized[offset] = normalizedReference[offset]!;
        normalized[offset + 1] = normalizedReference[offset + 1]!;
        normalized[offset + 2] = normalizedReference[offset + 2]!;
        normalized[offset + 3] = normalizedReference[offset + 3]!;
      }
    }
    if ((fallbackPixels * 100) > (referenceOpaquePixels * KEEP_MASK_FALLBACK_LIMIT_PERCENT)) {
      throw new Error(
        `KEEP frame-${frameIndex + 1}: ${fallbackPixels}/${referenceOpaquePixels} mask pixels require ` +
        `reference fallback, exceeding ${KEEP_MASK_FALLBACK_LIMIT_PERCENT}%`,
      );
    }
    normalizedFrames.push(normalized);
    fallbackCounts.push(fallbackPixels);
  }

  if (!normalizedFrames[3]!.equals(normalizedFrames[0]!)) {
    throw new Error('KEEP normalized frame-04 must byte-equal normalized frame-01 to close the idle loop');
  }

  return {
    frames: [normalizedFrames[0]!, normalizedFrames[1]!, normalizedFrames[2]!],
    maskFallbackPixels: [
      fallbackCounts[0]!, fallbackCounts[1]!, fallbackCounts[2]!, fallbackCounts[3]!,
    ],
    referenceOpaquePixels,
    protectedFeaturePixels,
  };
}

/** Measure one accepted 112x112 Giant frame without rewriting its approved anchor placement. */
export function validateGiantFrame(data: Buffer, label: string): GiantFrameMetrics {
  const expectedBytes = GIANT_CELL.width * GIANT_CELL.height * 4;
  if (data.length !== expectedBytes) {
    throw new Error(`${label}: Giant frame has ${data.length} RGBA bytes, expected ${expectedBytes}`);
  }
  let opaquePixels = 0;
  let groundPixels = 0;
  let minX: number = GIANT_CELL.width;
  let minY: number = GIANT_CELL.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < GIANT_CELL.height; y += 1) {
    for (let x = 0; x < GIANT_CELL.width; x += 1) {
      const alpha = data[((y * GIANT_CELL.width) + x) * 4 + 3]!;
      if (alpha === 0) continue;
      opaquePixels += 1;
      if (y >= GIANT_ANCHOR.y - 4) groundPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (opaquePixels === 0) throw new Error(`${label}: Giant frame is fully transparent`);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  if (opaquePixels < GIANT_MIN_OPAQUE_PIXELS) {
    throw new Error(`${label}: Giant frame has only ${opaquePixels} opaque pixels; expected >=${GIANT_MIN_OPAQUE_PIXELS}`);
  }
  if (width < GIANT_MIN_BBOX_WIDTH || height < GIANT_MIN_BBOX_HEIGHT) {
    throw new Error(
      `${label}: Giant opaque bbox is ${width}x${height}; expected >=${GIANT_MIN_BBOX_WIDTH}x${GIANT_MIN_BBOX_HEIGHT}`,
    );
  }
  if (minX > GIANT_ANCHOR.x || maxX < GIANT_ANCHOR.x) {
    throw new Error(`${label}: Giant opaque bbox does not span anchor x=${GIANT_ANCHOR.x}`);
  }
  return { opaquePixels, groundPixels, bbox: { minX, minY, maxX, maxY, width, height } };
}

/** Stitch same-sized RGBA cells in exact row-major order without resampling. */
export function stitchRowMajor(
  rows: readonly (readonly Buffer[])[],
  cellWidth: number,
  cellHeight: number,
): RgbaImage {
  if (rows.length === 0 || rows[0]!.length === 0) throw new Error('sheet rows must not be empty');
  const columns = rows[0]!.length;
  const cellBytes = cellWidth * cellHeight * 4;
  if (!rows.every((row) => row.length === columns)) throw new Error('sheet rows must have equal column counts');
  if (!rows.every((row) => row.every((cell) => cell.length === cellBytes))) {
    throw new Error(`sheet cell must contain exactly ${cellBytes} RGBA bytes`);
  }

  const width = columns * cellWidth;
  const height = rows.length * cellHeight;
  const output = Buffer.alloc(width * height * 4);
  const sourceStride = cellWidth * 4;
  const outputStride = width * 4;
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      for (let y = 0; y < cellHeight; y += 1) {
        const sourceStart = y * sourceStride;
        const outputStart = ((rowIndex * cellHeight + y) * outputStride) + (columnIndex * sourceStride);
        cell.copy(output, outputStart, sourceStart, sourceStart + sourceStride);
      }
    });
  });
  return { width, height, data: output };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function pngHeaderIsEightBitRgba(encoded: Buffer): boolean {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return encoded.length >= 29 &&
    encoded.subarray(0, 8).equals(signature) &&
    encoded.readUInt32BE(8) === 13 &&
    encoded.subarray(12, 16).toString('ascii') === 'IHDR' &&
    encoded[24] === 8 &&
    encoded[25] === 6;
}

async function loadExactRgbaPng(
  studioRoot: string,
  logicalFile: string,
  expected: typeof KEEP_CELL | typeof GIANT_CELL,
): Promise<LoadedPng> {
  const absoluteFile = path.join(studioRoot, ...logicalFile.split('/'));
  let encoded: Buffer;
  try {
    encoded = await fs.readFile(absoluteFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${logicalFile}: missing required input`);
    }
    throw error;
  }
  if (!pngHeaderIsEightBitRgba(encoded)) {
    throw new Error(`${logicalFile}: input must be an 8-bit RGBA PNG`);
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(encoded, { failOn: 'error' }).metadata();
  } catch {
    throw new Error(`${logicalFile}: input is not a valid PNG`);
  }
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) {
    throw new Error(`${logicalFile}: input must be one static PNG`);
  }
  if (metadata.width !== expected.width || metadata.height !== expected.height) {
    throw new Error(
      `${logicalFile}: input is ${metadata.width}x${metadata.height}, expected ${expected.width}x${expected.height}`,
    );
  }
  if (metadata.channels !== 4 || metadata.hasAlpha !== true || metadata.depth !== 'uchar') {
    throw new Error(`${logicalFile}: input must decode as 8-bit RGBA`);
  }
  const decoded = await sharp(encoded, { failOn: 'error' }).raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== expected.width || decoded.info.height !== expected.height || decoded.info.channels !== 4) {
    throw new Error(`${logicalFile}: decoded RGBA dimensions changed unexpectedly`);
  }
  return {
    width: expected.width,
    height: expected.height,
    data: decoded.data,
    encoded,
    sha256: sha256(encoded),
  };
}

function assertBinaryPixels(data: Buffer, label: string): void {
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3]!;
    if (alpha === 0) {
      if (data[offset] !== 0 || data[offset + 1] !== 0 || data[offset + 2] !== 0) {
        throw new Error(`${label}: transparent pixel is not RGBA0 at byte ${offset}`);
      }
      continue;
    }
    if (alpha !== 255) throw new Error(`${label}: non-binary alpha ${alpha} at byte ${offset + 3}`);
  }
}

async function encodeAndVerifyExactSheet(
  image: RgbaImage,
  label: string,
  expectedSha256: string,
): Promise<Buffer> {
  assertBinaryPixels(image.data, label);

  const encoded = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 4 },
  }).png({
    adaptiveFiltering: false,
    compressionLevel: 9,
    force: true,
    palette: false,
    progressive: false,
  }).toBuffer();
  if (!pngHeaderIsEightBitRgba(encoded)) throw new Error(`${label}: encoder did not produce 8-bit RGBA PNG`);

  const metadata = await sharp(encoded).metadata();
  if (metadata.width !== image.width || metadata.height !== image.height || metadata.channels !== 4) {
    throw new Error(`${label}: encoded dimensions or channels changed unexpectedly`);
  }
  if (metadata.exif || metadata.icc || metadata.iptc || metadata.xmp) {
    throw new Error(`${label}: encoded PNG unexpectedly contains metadata`);
  }
  const decoded = await sharp(encoded).raw().toBuffer();
  if (!decoded.equals(image.data)) throw new Error(`${label}: encoded PNG changed accepted pixels`);
  const actualSha256 = sha256(encoded);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`${label}: assembled PNG SHA256 ${actualSha256} does not match accepted ${expectedSha256}`);
  }
  return encoded;
}

async function atomicWrite(destination: string, contents: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, contents);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function removeLegacyPublishedAlias(studioRoot: string, name: 'candidate' | 'provenance'): Promise<void> {
  const alias = path.join(studioRoot, name);
  const expectedTarget = `published/current/${name}`;
  try {
    const stats = await fs.lstat(alias);
    if (!stats.isSymbolicLink() || await fs.readlink(alias) !== expectedTarget) {
      throw new Error(
        `${name}: refusing unmanaged existing output; expected the legacy symlink to ${expectedTarget}`,
      );
    }
    await fs.unlink(alias);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Return the real directory accepted by the candidate loader, never a publication symlink. */
export async function resolvePublishedProviderProofCandidateRoot(studioRoot: string): Promise<string> {
  if (!path.isAbsolute(studioRoot)) throw new Error('provider proof studio root must be an absolute path');
  const publishedRoot = path.join(path.resolve(studioRoot), 'published');
  const target = await fs.readlink(path.join(publishedRoot, 'current'));
  if (!/^generations\/[0-9a-f]{64}$/.test(target)) {
    throw new Error('provider proof current publication target is invalid');
  }
  const candidateRoot = path.join(publishedRoot, ...target.split('/'), 'candidate');
  const info = await fs.lstat(candidateRoot);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('provider proof candidate publication must be a real directory');
  }
  return fs.realpath(candidateRoot);
}

async function verifyPublishedGeneration(
  generationRoot: string,
  files: ReadonlyMap<string, Buffer>,
): Promise<void> {
  for (const [logicalFile, expected] of files) {
    const actual = await fs.readFile(path.join(generationRoot, ...logicalFile.split('/')));
    if (!actual.equals(expected)) {
      throw new Error(`published generation collision for ${logicalFile}`);
    }
  }
}

/**
 * Publish candidate PNGs and provenance through one atomic `published/current`
 * symlink swap. Callers activate the resolved real generation/candidate
 * directory, because the candidate pack loader deliberately rejects symlinks.
 */
export async function publishProviderProofBundle(
  studioRoot: string,
  files: ReadonlyMap<string, Buffer>,
  generationDigest: string,
  options: ProofPublicationOptions = {},
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(generationDigest)) throw new Error('publication digest must be SHA256 hex');
  const publishedRoot = path.join(studioRoot, 'published');
  const generationsRoot = path.join(publishedRoot, 'generations');
  const stagingRoot = path.join(publishedRoot, 'staging');
  await fs.mkdir(generationsRoot, { recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  await removeLegacyPublishedAlias(studioRoot, 'candidate');
  await removeLegacyPublishedAlias(studioRoot, 'provenance');
  const stagedGeneration = path.join(stagingRoot, `.generation-${process.pid}-${randomUUID()}`);
  const generationRoot = path.join(generationsRoot, generationDigest);
  try {
    await fs.mkdir(stagedGeneration);
    for (const [logicalFile, contents] of files) {
      await atomicWrite(path.join(stagedGeneration, ...logicalFile.split('/')), contents);
    }
    try {
      await fs.rename(stagedGeneration, generationRoot);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyPublishedGeneration(generationRoot, files);
    }
  } finally {
    await fs.rm(stagedGeneration, { recursive: true, force: true });
  }

  const temporaryPointer = path.join(publishedRoot, `.current-${process.pid}-${randomUUID()}`);
  try {
    await fs.symlink(`generations/${generationDigest}`, temporaryPointer, 'dir');
    await options.beforeActivate?.();
    await fs.rename(temporaryPointer, path.join(publishedRoot, 'current'));
  } finally {
    await fs.rm(temporaryPointer, { force: true });
  }
  return resolvePublishedProviderProofCandidateRoot(studioRoot);
}

function frameFile(root: 'keep' | 'giant', state: string | null, direction: string | null, frame: number): string {
  const parts = ['raw', root];
  if (state !== null) parts.push(state);
  if (direction !== null) parts.push(direction);
  parts.push(`frame-${String(frame).padStart(2, '0')}.png`);
  return parts.join('/');
}

/** Normalize the complete fixed proof inventory beneath one absolute studio root. */
export async function normalizeProviderProof(
  studioRoot: string,
  publicationOptions: ProofPublicationOptions = {},
): Promise<ProviderProofNormalizationProvenance> {
  if (!path.isAbsolute(studioRoot)) throw new Error('provider proof studio root must be an absolute path');
  const normalizedRoot = path.resolve(studioRoot);
  const inputs: ProvenanceFileHash[] = [];
  const load = async (
    logicalFile: string,
    expected: typeof KEEP_CELL | typeof GIANT_CELL,
  ): Promise<LoadedPng> => {
    const loaded = await loadExactRgbaPng(normalizedRoot, logicalFile, expected);
    inputs.push({ file: logicalFile, sha256: loaded.sha256 });
    return loaded;
  };

  // Read and validate the entire fixed inventory before writing any candidate.
  const referenceFile = 'references/keep-l20-master-current.png';
  const reference = await load(referenceFile, KEEP_CELL);
  if (reference.sha256 !== KEEP_OWNER_IDENTITY_SHA256) {
    throw new Error(`${referenceFile}: SHA256 does not match the accepted KEEP owner identity`);
  }
  const keepSources: LoadedPng[] = [];
  for (let frame = 1; frame <= 4; frame += 1) {
    keepSources.push(await load(frameFile('keep', 'idle', null, frame), KEEP_CELL));
  }
  const giantSources: Record<'walk' | 'throw', LoadedPng[][]> = { walk: [], throw: [] };
  for (const state of ['walk', 'throw'] as const) {
    const frameCount = state === 'walk' ? 8 : 6;
    for (const direction of PROVIDER_PROOF_DIRECTIONS) {
      const row: LoadedPng[] = [];
      for (let frame = 1; frame <= frameCount; frame += 1) {
        row.push(await load(frameFile('giant', state, direction, frame), GIANT_CELL));
      }
      giantSources[state].push(row);
    }
  }

  if (!reference.data.equals(keepSources[0]!.data)) {
    throw new Error('KEEP reference must byte-equal source frame-01 decoded RGBA');
  }
  if (!keepSources[3]!.data.equals(keepSources[0]!.data)) {
    throw new Error('KEEP source frame-04 must byte-equal source frame-01 to close the idle loop');
  }

  const acceptedGiant: Record<'walk' | 'throw', Buffer[][]> = { walk: [], throw: [] };
  const giantFrameChecks: Array<{
    state: 'walk' | 'throw';
    direction: ProofDirection;
    frame: number;
  } & GiantFrameMetrics> = [];
  for (const state of ['walk', 'throw'] as const) {
    acceptedGiant[state] = giantSources[state].map((row, directionIndex) => row.map((frame, frameIndex) => {
      const direction = PROVIDER_PROOF_DIRECTIONS[directionIndex]!;
      giantFrameChecks.push({
        state,
        direction,
        frame: frameIndex + 1,
        ...validateGiantFrame(frame.data, `Giant ${state}/${direction}/frame-${frameIndex + 1}`),
      });
      return frame.data;
    }));
  }

  const sheets = [
    {
      file: 'candidate/keep/bld_keep_l20_idle.png',
      image: stitchRowMajor([
        [keepSources[0]!.data, keepSources[1]!.data, keepSources[2]!.data],
      ], KEEP_CELL.width, KEEP_CELL.height),
    },
    {
      file: 'candidate/giant/trp_giant_t4_walk.png',
      image: stitchRowMajor(acceptedGiant.walk, GIANT_CELL.width, GIANT_CELL.height),
    },
    {
      file: 'candidate/giant/trp_giant_t4_throw.png',
      image: stitchRowMajor(acceptedGiant.throw, GIANT_CELL.width, GIANT_CELL.height),
    },
  ].map((sheet) => {
    const accepted = ART_CANDIDATE_FILES.find(({ logicalFile }) => `candidate/${logicalFile}` === sheet.file);
    if (!accepted) throw new Error(`${sheet.file}: no accepted game-v4 proof contract`);
    return { ...sheet, accepted };
  });

  const encodedSheets = await Promise.all(sheets.map(async (sheet) => ({
    ...sheet,
    encoded: await encodeAndVerifyExactSheet(sheet.image, sheet.file, sheet.accepted.sha256),
  })));
  const provenance: ProviderProofNormalizationProvenance = {
    schemaVersion: PROVIDER_PROOF_NORMALIZER_VERSION,
    normalizer: 'shardkeep-provider-proof-normalizer',
    transformPolicy: {
      execution: 'offline-only',
      input: '8-bit RGBA static PNG; exact canvas required; no resize or inferred anchor',
      pixels: 'byte-exact accepted game-v4 RGBA pixels; no palette remap, mask repair, resize, or translation',
      keepIdentity: 'reference and KEEP idle frame-01 must have identical decoded RGBA',
      giantCell: 'hash-pinned accepted game-v4 sheets; metrics are recorded but do not rewrite accepted anchor placement',
      output: 'row-major assembly with deterministic PNG encoding; encoded SHA256 must equal the accepted game-v4 pin',
      acceptedOutputs: ART_CANDIDATE_FILES.map(({ logicalFile, sha256: digest, width, height }) => ({
        file: `candidate/${logicalFile}`,
        sha256: digest,
        width,
        height,
      })),
    },
    selection: {
      keep: {
        sourceFrames: [1, 2, 3, 4],
        outputFrames: [1, 2, 3],
        closure: 'source frame-04 must byte-equal source frame-01',
        identity: 'reference must byte-equal source frame-01 decoded RGBA',
      },
      giant: {
        directions: PROVIDER_PROOF_DIRECTIONS,
        walkFrames: [1, 2, 3, 4, 5, 6, 7, 8],
        throwFrames: [1, 2, 3, 4, 5, 6],
        frameChecks: giantFrameChecks,
      },
    },
    inputs,
    outputs: encodedSheets.map((sheet) => ({
      file: sheet.file,
      sha256: sha256(sheet.encoded),
      width: sheet.image.width,
      height: sheet.image.height,
    })),
  };

  const provenanceJson = `${JSON.stringify(provenance, null, 2)}\n`;
  if (provenanceJson.includes(normalizedRoot) ||
      /https?:\/\/|authorization|bearer|api[_-]?token|headers?/i.test(provenanceJson)) {
    throw new Error('normalization provenance contains forbidden local or credential material');
  }
  const publicationFiles = new Map<string, Buffer>(encodedSheets.map((sheet) => [sheet.file, sheet.encoded]));
  publicationFiles.set('provenance/normalization.json', Buffer.from(provenanceJson));
  await publishProviderProofBundle(
    normalizedRoot,
    publicationFiles,
    sha256(Buffer.from(provenanceJson)),
    publicationOptions,
  );
  return provenance;
}

export async function runProviderProofNormalizerCli(args: readonly string[]): Promise<void> {
  if (args.length !== 1) {
    throw new Error('usage: tsx scripts/src/provider-proof-normalize.ts /absolute/path/to/studio-root');
  }
  const provenance = await normalizeProviderProof(args[0]!);
  const candidateRoot = await resolvePublishedProviderProofCandidateRoot(args[0]!);
  console.log(
    `normalized provider proof: ${provenance.inputs.length} inputs -> ${provenance.outputs.length} candidate sheets`,
  );
  console.log(`${ART_CANDIDATE_ENV}=${candidateRoot}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProviderProofNormalizerCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
