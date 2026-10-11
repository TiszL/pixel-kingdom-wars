/** Safe filesystem wrapper for the pure provider masked-repair compositor. */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import {
  composeProviderMaskedRepair,
  type MaskedRepairMetrics,
  type RepairFrame,
  type RepairMask,
  type RepairRgb,
} from './provider-masked-repair.js';

export interface ProviderMaskedRepairSpec {
  schemaVersion: 1;
  original: string;
  provider: string;
  output: string;
  provenance?: string;
  masks: RepairMask[];
  alphaThreshold?: number;
  preserveOriginalOpaque?: boolean;
  /** Ordered colors; the first entry wins equal-distance ties. */
  palette?: string[];
}

export interface MaskedRepairPublicationResult {
  outputFile: string;
  outputSha256: string;
  provenanceFile?: string;
  metrics: MaskedRepairMetrics;
}

export interface MaskedRepairPublicationOptions {
  /** Test/review barrier after both files are staged and before either is activated. */
  beforeActivate?: (() => void | Promise<void>) | undefined;
}

interface DecodedPng {
  frame: RepairFrame;
  sha256: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new Error(`${label} contains unsupported field ${extra}`);
}

function absoluteNormalizedPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') ||
      !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function parsePalette(values: unknown): readonly RepairRgb[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length === 0) throw new Error('palette must be a non-empty ordered array');
  return values.map((value, index) => {
    if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
      throw new Error(`palette[${index}] must be #RRGGBB`);
    }
    return [
      Number.parseInt(value.slice(1, 3), 16),
      Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16),
    ] as const;
  });
}

function parseSpec(raw: unknown): { spec: ProviderMaskedRepairSpec; palette?: readonly RepairRgb[] } {
  if (!isRecord(raw)) throw new Error('spec must be a JSON object');
  assertExactKeys(raw, ['schemaVersion', 'original', 'provider', 'output', 'provenance', 'masks',
    'alphaThreshold', 'preserveOriginalOpaque', 'palette'], 'spec');
  if (raw.schemaVersion !== 1) throw new Error('spec.schemaVersion must be 1');
  const original = absoluteNormalizedPath(raw.original, 'original');
  const provider = absoluteNormalizedPath(raw.provider, 'provider');
  const output = absoluteNormalizedPath(raw.output, 'output');
  const provenance = raw.provenance === undefined
    ? undefined
    : absoluteNormalizedPath(raw.provenance, 'provenance');
  if (!Array.isArray(raw.masks) || raw.masks.length === 0) {
    throw new Error('masks must contain at least one rectangle');
  }
  const masks = raw.masks.map((value, index): RepairMask => {
    if (!isRecord(value)) throw new Error(`masks[${index}] must be a rectangle`);
    assertExactKeys(value, ['x', 'y', 'width', 'height'], `masks[${index}]`);
    for (const field of ['x', 'y', 'width', 'height'] as const) {
      if (!Number.isSafeInteger(value[field])) throw new Error(`masks[${index}].${field} must be an integer`);
    }
    const mask = value as unknown as RepairMask;
    if (mask.width <= 0 || mask.height <= 0) throw new Error(`masks[${index}] must have positive width and height`);
    if (mask.x < 0 || mask.y < 0) throw new Error(`masks[${index}] must use non-negative coordinates`);
    return { x: mask.x, y: mask.y, width: mask.width, height: mask.height };
  });
  if (raw.alphaThreshold !== undefined &&
      (!Number.isInteger(raw.alphaThreshold) || (raw.alphaThreshold as number) < 1 || (raw.alphaThreshold as number) > 255)) {
    throw new Error('alphaThreshold must be an integer from 1 through 255');
  }
  if (raw.preserveOriginalOpaque !== undefined && typeof raw.preserveOriginalOpaque !== 'boolean') {
    throw new Error('preserveOriginalOpaque must be a boolean');
  }
  const palette = parsePalette(raw.palette);
  const spec: ProviderMaskedRepairSpec = {
    schemaVersion: 1,
    original,
    provider,
    output,
    masks,
    ...(provenance === undefined ? {} : { provenance }),
    ...(raw.alphaThreshold === undefined ? {} : { alphaThreshold: raw.alphaThreshold as number }),
    ...(raw.preserveOriginalOpaque === undefined ? {} : { preserveOriginalOpaque: raw.preserveOriginalOpaque }),
    ...(raw.palette === undefined ? {} : { palette: raw.palette as string[] }),
  };
  return { spec, ...(palette === undefined ? {} : { palette }) };
}

async function canonicalFuturePath(absolute: string): Promise<{ canonical: string; exactSymlink: boolean }> {
  let probe = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      const stat = await fs.lstat(probe);
      const canonical = await fs.realpath(probe);
      return { canonical: path.join(canonical, ...missing), exactSymlink: probe === absolute && stat.isSymbolicLink() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

async function existingIdentity(absolute: string): Promise<{ dev: number; ino: number } | undefined> {
  try {
    const stat = await fs.stat(absolute);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertDistinctPaths(paths: readonly { label: string; value: string }[]): Promise<void> {
  const resolved = await Promise.all(paths.map(async (entry) => ({
    ...entry,
    future: await canonicalFuturePath(entry.value),
    identity: await existingIdentity(entry.value),
  })));
  for (const entry of resolved) {
    if (entry.future.exactSymlink) throw new Error(`${entry.label} must not be a symlink`);
  }
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      const a = resolved[left]!;
      const b = resolved[right]!;
      const sameCanonical = a.future.canonical === b.future.canonical;
      const sameInode = a.identity !== undefined && b.identity !== undefined &&
        a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino;
      if (sameCanonical || sameInode) throw new Error(`${a.label} and ${b.label} must not alias the same filesystem entry`);
    }
  }
}

async function decodeRgbaPng(absolute: string, label: string): Promise<DecodedPng> {
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file, not a symlink`);
  const encoded = await fs.readFile(absolute);
  const isRgba8 = encoded.length >= 29 && encoded.subarray(0, 8).equals(PNG_SIGNATURE) &&
    encoded.readUInt32BE(8) === 13 && encoded.subarray(12, 16).toString('ascii') === 'IHDR' &&
    encoded[24] === 8 && encoded[25] === 6;
  if (!isRgba8) throw new Error(`${label} must be one static 8-bit RGBA PNG`);
  const image = sharp(encoded, { animated: false, limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) {
    throw new Error(`${label} must be one static 8-bit RGBA PNG`);
  }
  const decoded = await image.raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 4 || decoded.info.width <= 0 || decoded.info.height <= 0) {
    throw new Error(`${label} must decode as 8-bit RGBA`);
  }
  return {
    frame: { width: decoded.info.width, height: decoded.info.height, rgba: new Uint8Array(decoded.data) },
    sha256: sha256(encoded),
  };
}

async function encodeRgba(frame: Readonly<RepairFrame>): Promise<Buffer> {
  const encoded = await sharp(Buffer.from(frame.rgba), {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  }).png({ palette: false, compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
  if (encoded.length < 29 || !encoded.subarray(0, 8).equals(PNG_SIGNATURE) ||
      encoded.readUInt32BE(16) !== frame.width || encoded.readUInt32BE(20) !== frame.height ||
      encoded[24] !== 8 || encoded[25] !== 6) {
    throw new Error('encoder failed to produce the exact static 8-bit RGBA PNG canvas');
  }
  return encoded;
}

async function assertWritableDestination(absolute: string, label: string): Promise<void> {
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file when it exists`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const parent = await fs.lstat(path.dirname(absolute));
  if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`${label} parent must be a real directory`);
}

async function stageAtomicFile(absolute: string, data: Uint8Array): Promise<{ activate: () => Promise<void>; cleanup: () => Promise<void> }> {
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.stage-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
  let active = true;
  return {
    activate: async () => {
      await fs.rename(temporary, absolute);
      active = false;
    },
    cleanup: async () => {
      if (active) await fs.rm(temporary, { force: true });
    },
  };
}

export async function publishProviderMaskedRepairSpec(
  rawSpec: unknown,
  options: MaskedRepairPublicationOptions = {},
): Promise<MaskedRepairPublicationResult> {
  const { spec, palette } = parseSpec(rawSpec);
  const namedPaths = [
    { label: 'original', value: spec.original },
    { label: 'provider', value: spec.provider },
    { label: 'output', value: spec.output },
    ...(spec.provenance === undefined ? [] : [{ label: 'provenance', value: spec.provenance }]),
  ];
  await assertDistinctPaths(namedPaths);
  const [original, provider] = await Promise.all([
    decodeRgbaPng(spec.original, 'original'),
    decodeRgbaPng(spec.provider, 'provider'),
  ]);
  const repaired = composeProviderMaskedRepair({
    original: original.frame,
    provider: provider.frame,
    masks: spec.masks,
    ...(spec.alphaThreshold === undefined ? {} : { alphaThreshold: spec.alphaThreshold }),
    ...(spec.preserveOriginalOpaque === undefined ? {} : { preserveOriginalOpaque: spec.preserveOriginalOpaque }),
    ...(palette === undefined ? {} : { palette }),
  });
  const outputBytes = await encodeRgba(repaired);
  const outputSha256 = sha256(outputBytes);
  const provenanceBytes = spec.provenance === undefined ? undefined : Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    producer: 'shardkeep-provider-masked-repair-cli',
    inputs: {
      original: { sha256: original.sha256 },
      provider: { sha256: provider.sha256 },
    },
    output: { sha256: outputSha256, width: repaired.width, height: repaired.height },
    transform: {
      masks: spec.masks,
      alphaThreshold: spec.alphaThreshold ?? 128,
      preserveOriginalOpaque: spec.preserveOriginalOpaque ?? false,
      ...(spec.palette === undefined ? {} : { palette: spec.palette }),
    },
    metrics: repaired.metrics,
  }, null, 2)}\n`);

  await assertWritableDestination(spec.output, 'output');
  if (spec.provenance !== undefined) await assertWritableDestination(spec.provenance, 'provenance');
  let outputStage: Awaited<ReturnType<typeof stageAtomicFile>> | undefined;
  let provenanceStage: Awaited<ReturnType<typeof stageAtomicFile>> | undefined;
  try {
    outputStage = await stageAtomicFile(spec.output, outputBytes);
    provenanceStage = spec.provenance === undefined || provenanceBytes === undefined
      ? undefined
      : await stageAtomicFile(spec.provenance, provenanceBytes);
    await options.beforeActivate?.();
    await outputStage.activate();
    await provenanceStage?.activate();
  } finally {
    await Promise.all([outputStage?.cleanup(), provenanceStage?.cleanup()]);
  }
  return {
    outputFile: spec.output,
    outputSha256,
    ...(spec.provenance === undefined ? {} : { provenanceFile: spec.provenance }),
    metrics: repaired.metrics,
  };
}

export async function publishProviderMaskedRepairSpecFile(
  specFile: string,
  options: MaskedRepairPublicationOptions = {},
): Promise<MaskedRepairPublicationResult> {
  const absolute = path.resolve(specFile);
  const encoded = await fs.readFile(absolute, 'utf8');
  const raw = JSON.parse(encoded) as unknown;
  if (isRecord(raw)) {
    const outputs = [raw.output, raw.provenance].filter((value): value is string => typeof value === 'string');
    await assertDistinctPaths([{ label: 'spec file', value: absolute },
      ...outputs.map((value, index) => ({ label: index === 0 ? 'output' : 'provenance', value }))]);
  }
  return publishProviderMaskedRepairSpec(raw, options);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const specFile = process.argv[2];
  if (specFile === undefined || process.argv.length !== 3) {
    console.error('usage: tsx scripts/src/provider-masked-repair-cli.ts <spec.json>');
    process.exitCode = 2;
  } else {
    await publishProviderMaskedRepairSpecFile(specFile);
  }
}
