/** Safe offline filesystem wrapper for the pure provider frame normalizer. */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import {
  normalizeProviderFrameGroup,
  type DecodedFrame,
  type FrameToken,
  type Rgb,
} from './provider-production-normalize.js';

export interface ProviderProductionSpec {
  schemaVersion: 1;
  inputRoot: string;
  outputRoot: string;
  runtimeCell: { width: number; height: number };
  preferredSourceOffset: { x: number; y: number };
  preferredSourceOffsets?: Record<string, { x: number; y: number }>;
  directionOrder: string[];
  frameOrder: FrameToken[];
  alphaThreshold?: number;
  palette?: string[];
  inputs: { pattern: string } | { frames: Array<{ direction: string; frame: FrameToken; path: string }> };
  outputs: { sheet: string; frames?: string; provenance: string };
}

export interface PublicationOptions {
  /** Test/review barrier after complete staging and before any active output moves. */
  beforeActivate?: (() => void | Promise<void>) | undefined;
}

export interface PublicationResult {
  outputFiles: readonly { file: string; sha256: string }[];
  provenanceFile: string;
}

interface ResolvedInput {
  direction: string;
  frame: FrameToken;
  relative: string;
  absolute: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains unsupported field ${extras[0]}`);
}

function normalizedRelative(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a normalized POSIX relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || value.split('/').includes('..')) {
    throw new Error(`${label} must be a normalized POSIX relative path without traversal`);
  }
  return value;
}

function absoluteRoot(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return value;
}

function sameOrContained(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalFuturePath(absolute: string): Promise<{ path: string; exactSymlink: boolean }> {
  let probe = absolute;
  const missing: string[] = [];
  let exactSymlink = false;
  for (;;) {
    try {
      const stat = await fs.lstat(probe);
      if (probe === absolute) exactSymlink = stat.isSymbolicLink();
      const canonical = await fs.realpath(probe);
      return { path: path.join(canonical, ...missing), exactSymlink };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

async function canonicalizeRoots(spec: ProviderProductionSpec): Promise<void> {
  const inputStat = await fs.lstat(spec.inputRoot);
  if (inputStat.isSymbolicLink() || !inputStat.isDirectory()) throw new Error('inputRoot must be a real directory');
  const canonicalInput = await fs.realpath(spec.inputRoot);
  const canonicalOutput = await canonicalFuturePath(spec.outputRoot);
  if (sameOrContained(canonicalOutput.path, canonicalInput) || sameOrContained(canonicalInput, canonicalOutput.path)) {
    throw new Error('canonical inputRoot and outputRoot must be disjoint; filesystem aliases or containment are forbidden');
  }
  if (canonicalOutput.exactSymlink) throw new Error('outputRoot must not be a symlink');
  spec.inputRoot = canonicalInput;
  spec.outputRoot = canonicalOutput.path;
}

function formatPattern(pattern: string, direction: string, frame: FrameToken, label: string): string {
  let result = pattern.replaceAll('{direction}', direction);
  result = result.replace(/\{frame(?::(\d+))?\}/g, (_match, width: string | undefined) => {
    const text = String(frame);
    if (width === undefined) return text;
    if (typeof frame !== 'number' || !Number.isSafeInteger(frame)) throw new Error(`${label} padded frame requires an integer token`);
    return text.padStart(Number(width), '0');
  });
  if (/[{}]/.test(result)) throw new Error(`${label} contains an unsupported or unresolved placeholder`);
  return normalizedRelative(result, label);
}

function parsePalette(values: readonly string[] | undefined): readonly Rgb[] | undefined {
  return values?.map((value, index) => {
    if (!/^#[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`palette[${index}] must be #RRGGBB`);
    return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16),
      Number.parseInt(value.slice(5, 7), 16)] as const;
  });
}

function parseSpec(raw: unknown): ProviderProductionSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('spec must be a JSON object');
  const spec = raw as unknown as ProviderProductionSpec;
  assertExactKeys(raw as Record<string, unknown>, ['schemaVersion', 'inputRoot', 'outputRoot', 'runtimeCell',
    'preferredSourceOffset', 'preferredSourceOffsets', 'directionOrder', 'frameOrder', 'alphaThreshold', 'palette', 'inputs', 'outputs'], 'spec');
  if (spec.schemaVersion !== 1) throw new Error('spec.schemaVersion must be 1');
  spec.inputRoot = absoluteRoot(spec.inputRoot, 'inputRoot');
  spec.outputRoot = absoluteRoot(spec.outputRoot, 'outputRoot');
  if (spec.inputRoot === spec.outputRoot || spec.inputRoot.startsWith(`${spec.outputRoot}${path.sep}`) ||
      spec.outputRoot.startsWith(`${spec.inputRoot}${path.sep}`)) throw new Error('inputRoot and outputRoot must be disjoint');
  if (!spec.runtimeCell || !spec.preferredSourceOffset || !Array.isArray(spec.directionOrder) ||
      !Array.isArray(spec.frameOrder) || !spec.inputs || !spec.outputs) throw new Error('spec is missing required fields');
  assertExactKeys(spec.runtimeCell as unknown as Record<string, unknown>, ['width', 'height'], 'runtimeCell');
  assertExactKeys(spec.preferredSourceOffset as unknown as Record<string, unknown>, ['x', 'y'], 'preferredSourceOffset');
  assertExactKeys(spec.inputs as unknown as Record<string, unknown>, ['pattern', 'frames'], 'inputs');
  assertExactKeys(spec.outputs as unknown as Record<string, unknown>, ['sheet', 'frames', 'provenance'], 'outputs');
  if (![spec.runtimeCell.width, spec.runtimeCell.height].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('runtimeCell dimensions must be positive integers');
  }
  if (![spec.preferredSourceOffset.x, spec.preferredSourceOffset.y].every(Number.isSafeInteger)) {
    throw new Error('preferredSourceOffset coordinates must be integers');
  }
  if (spec.directionOrder.length === 0 || spec.directionOrder.some((value) => typeof value !== 'string' || !/^[a-z0-9_-]+$/.test(value)) ||
      new Set(spec.directionOrder).size !== spec.directionOrder.length) throw new Error('directionOrder must contain unique safe identifiers');
  if (spec.preferredSourceOffsets !== undefined) {
    if (spec.preferredSourceOffsets === null || typeof spec.preferredSourceOffsets !== 'object' || Array.isArray(spec.preferredSourceOffsets)) {
      throw new Error('preferredSourceOffsets must be an object keyed by direction');
    }
    for (const [direction, offset] of Object.entries(spec.preferredSourceOffsets)) {
      if (!spec.directionOrder.includes(direction)) throw new Error(`preferredSourceOffsets contains unexpected direction ${direction}`);
      if (offset === null || typeof offset !== 'object') throw new Error(`preferredSourceOffsets.${direction} must be an object`);
      assertExactKeys(offset as unknown as Record<string, unknown>, ['x', 'y'], `preferredSourceOffsets.${direction}`);
      if (![offset.x, offset.y].every(Number.isSafeInteger)) throw new Error(`preferredSourceOffsets.${direction} must use integer coordinates`);
    }
  }
  const validFrame = (value: FrameToken): boolean => typeof value === 'string'
    ? /^[A-Za-z0-9_-]+$/.test(value)
    : Number.isSafeInteger(value);
  if (spec.frameOrder.length === 0 || !spec.frameOrder.every(validFrame) ||
      new Set(spec.frameOrder.map((value) => `${typeof value}:${String(value)}`)).size !== spec.frameOrder.length) {
    throw new Error('frameOrder must contain unique string or integer identifiers');
  }
  if (spec.alphaThreshold !== undefined && (!Number.isInteger(spec.alphaThreshold) || spec.alphaThreshold < 1 || spec.alphaThreshold > 255)) {
    throw new Error('alphaThreshold must be an integer from 1 through 255');
  }
  if (Array.isArray(spec.palette)) parsePalette(spec.palette);
  normalizedRelative(spec.outputs.sheet, 'outputs.sheet');
  normalizedRelative(spec.outputs.provenance, 'outputs.provenance');
  if (spec.outputs.frames !== undefined) {
    normalizedRelative(spec.outputs.frames, 'outputs.frames');
    if (spec.directionOrder.length > 1 && !spec.outputs.frames.includes('{direction}')) throw new Error('outputs.frames must include {direction}');
    if (spec.frameOrder.length > 1 && !spec.outputs.frames.includes('{frame')) throw new Error('outputs.frames must include a frame placeholder');
  }
  const hasPattern = 'pattern' in spec.inputs;
  const hasFrames = 'frames' in spec.inputs;
  if (hasPattern === hasFrames) throw new Error('inputs must contain exactly one of pattern or frames');
  if ('pattern' in spec.inputs) {
    normalizedRelative(spec.inputs.pattern, 'inputs.pattern');
    if (spec.directionOrder.length > 1 && !spec.inputs.pattern.includes('{direction}')) throw new Error('inputs.pattern must include {direction}');
    if (spec.frameOrder.length > 1 && !spec.inputs.pattern.includes('{frame')) throw new Error('inputs.pattern must include a frame placeholder');
  }
  else if (!Array.isArray(spec.inputs.frames)) throw new Error('inputs.frames must be an array');
  else for (const [index, entry] of spec.inputs.frames.entries()) {
    if (entry === null || typeof entry !== 'object') throw new Error(`inputs.frames[${index}] must be an object`);
    assertExactKeys(entry as unknown as Record<string, unknown>, ['direction', 'frame', 'path'], `inputs.frames[${index}]`);
  }
  return spec;
}

function resolveInputs(spec: ProviderProductionSpec): ResolvedInput[] {
  const expected = spec.directionOrder.flatMap((direction) => spec.frameOrder.map((frame) => ({ direction, frame })));
  const explicit = 'frames' in spec.inputs
    ? new Map(spec.inputs.frames.map((entry) => [`${entry.direction.length}:${entry.direction}|${typeof entry.frame}:${String(entry.frame)}`, entry]))
    : null;
  if (explicit !== null && 'frames' in spec.inputs && explicit.size !== spec.inputs.frames.length) {
    throw new Error('inputs.frames contains duplicate identities');
  }
  const result = expected.map(({ direction, frame }) => {
    const key = `${direction.length}:${direction}|${typeof frame}:${String(frame)}`;
    const relative = 'pattern' in spec.inputs
      ? formatPattern(spec.inputs.pattern, direction, frame, 'inputs.pattern result')
      : normalizedRelative(explicit!.get(key)?.path ?? '', `inputs.frames ${direction}/${String(frame)}`);
    return { direction, frame, relative, absolute: path.join(spec.inputRoot, ...relative.split('/')) };
  });
  if (explicit !== null && explicit.size !== expected.length) throw new Error('inputs.frames must exactly cover directionOrder × frameOrder');
  return result;
}

async function assertNoSymlink(root: string, relative?: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`${relative === undefined ? 'root' : relative} must be a real directory`);
  if (relative === undefined) return;
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`${relative} must not traverse a symlink`);
  }
}

async function decodePng(input: ResolvedInput): Promise<{ frame: DecodedFrame; sha256: string }> {
  await assertNoSymlink(path.dirname(input.absolute), path.basename(input.absolute));
  const stat = await fs.lstat(input.absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${input.relative} must be a regular file`);
  const encoded = await fs.readFile(input.absolute);
  const isRgba8 = encoded.length >= 29 && encoded.subarray(0, 8).equals(PNG_SIGNATURE) &&
    encoded.readUInt32BE(8) === 13 && encoded.subarray(12, 16).toString('ascii') === 'IHDR' &&
    encoded[24] === 8 && encoded[25] === 6;
  if (!isRgba8) throw new Error(`${input.relative} must be one static 8-bit RGBA PNG`);
  const image = sharp(encoded, { animated: false, limitInputPixels: 100_000_000 });
  const metadata = await image.metadata();
  if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1) throw new Error(`${input.relative} must be one static 8-bit RGBA PNG`);
  const decoded = await image.raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 4 || decoded.info.width === 0 || decoded.info.height === 0) {
    throw new Error(`${input.relative} must decode as 8-bit RGBA`);
  }
  return { frame: { direction: input.direction, frame: input.frame, width: decoded.info.width,
    height: decoded.info.height, rgba: new Uint8Array(decoded.data) }, sha256: sha256(encoded) };
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

async function encodeRgba(width: number, height: number, rgba: Uint8Array): Promise<Buffer> {
  const encoded = await sharp(Buffer.from(rgba), { raw: { width, height, channels: 4 } })
    .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  if (encoded.length < 29 || !encoded.subarray(0, 8).equals(PNG_SIGNATURE) || encoded[24] !== 8 || encoded[25] !== 6 ||
      encoded.readUInt32BE(16) !== width || encoded.readUInt32BE(20) !== height) {
    throw new Error('encoder failed to produce the exact static 8-bit RGBA PNG canvas');
  }
  return encoded;
}

async function listFilesRejectingSymlinks(root: string, relative = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    const stat = await fs.lstat(path.join(root, ...child.split('/')));
    if (stat.isSymbolicLink()) throw new Error(`existing output contains symlink ${child}`);
    if (stat.isDirectory()) files.push(...await listFilesRejectingSymlinks(root, child));
    else if (stat.isFile()) files.push(child);
    else throw new Error(`existing output contains unmanaged entry ${child}`);
  }
  return files.sort();
}

async function assertManagedExistingOutput(outputRoot: string, expected: ReadonlySet<string>): Promise<boolean> {
  try {
    const stat = await fs.lstat(outputRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('outputRoot must be a real directory when it exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const extras = (await listFilesRejectingSymlinks(outputRoot)).filter((file) => !expected.has(file));
  if (extras.length > 0) throw new Error(`existing output contains unmanaged extra ${extras[0]}`);
  return true;
}

async function writeStaged(root: string, relative: string, data: Uint8Array): Promise<void> {
  const destination = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, data, { flag: 'wx' });
}

function outputFramePaths(spec: ProviderProductionSpec): string[] {
  if (spec.outputs.frames === undefined) return [];
  return spec.directionOrder.flatMap((direction) => spec.frameOrder.map((frame) =>
    formatPattern(spec.outputs.frames!, direction, frame, 'outputs.frames result')));
}

export async function publishProviderProductionSpec(
  rawSpec: unknown,
  options: PublicationOptions = {},
): Promise<PublicationResult> {
  const spec = parseSpec(structuredClone(rawSpec));
  await canonicalizeRoots(spec);
  await assertNoSymlink(spec.inputRoot);
  const resolvedInputs = resolveInputs(spec);
  await Promise.all(resolvedInputs.map((input) => assertNoSymlink(spec.inputRoot, input.relative)));
  const decoded = await Promise.all(resolvedInputs.map(decodePng));
  const palette = parsePalette(spec.palette);
  const normalized = normalizeProviderFrameGroup({ frames: decoded.map(({ frame }) => frame),
    runtimeCell: spec.runtimeCell, preferredSourceOffset: spec.preferredSourceOffset,
    directionOrder: spec.directionOrder, frameOrder: spec.frameOrder,
    ...(spec.preferredSourceOffsets === undefined ? {} : { preferredSourceOffsets: spec.preferredSourceOffsets }),
    ...(spec.alphaThreshold === undefined ? {} : { alphaThreshold: spec.alphaThreshold }),
    ...(palette === undefined ? {} : { palette }) });
  const framePaths = outputFramePaths(spec);
  const expected = new Set([spec.outputs.sheet, spec.outputs.provenance, ...framePaths]);
  if (expected.size !== 2 + framePaths.length) throw new Error('output paths must be unique');
  await fs.mkdir(path.dirname(spec.outputRoot), { recursive: true });
  const outputParent = await fs.lstat(path.dirname(spec.outputRoot));
  if (outputParent.isSymbolicLink() || !outputParent.isDirectory()) throw new Error('outputRoot parent must be a real directory');
  const outputExists = await assertManagedExistingOutput(spec.outputRoot, expected);
  const stage = path.join(path.dirname(spec.outputRoot), `.${path.basename(spec.outputRoot)}.stage-${randomUUID()}`);
  const backup = path.join(path.dirname(spec.outputRoot), `.${path.basename(spec.outputRoot)}.backup-${randomUUID()}`);
  let activated = false;
  try {
    await fs.mkdir(stage);
    const outputFiles: { file: string; sha256: string }[] = [];
    const sheet = await encodeRgba(normalized.sheet.width, normalized.sheet.height, normalized.sheet.rgba);
    await writeStaged(stage, spec.outputs.sheet, sheet);
    outputFiles.push({ file: spec.outputs.sheet, sha256: sha256(sheet) });
    for (let index = 0; index < normalized.frames.length; index += 1) {
      const relative = framePaths[index];
      if (relative === undefined) break;
      const frame = normalized.frames[index]!;
      const encoded = await encodeRgba(frame.width, frame.height, frame.rgba);
      await writeStaged(stage, relative, encoded);
      outputFiles.push({ file: relative, sha256: sha256(encoded) });
    }
    const provenance = {
      schemaVersion: 1,
      normalizer: 'shardkeep-provider-production-normalizer-cli',
      inputs: resolvedInputs.map((input, index) => ({ direction: input.direction, frame: input.frame,
        file: input.relative, sha256: decoded[index]!.sha256 })),
      outputs: outputFiles,
      transform: normalized.metadata,
    };
    const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
    await writeStaged(stage, spec.outputs.provenance, provenanceBytes);
    await options.beforeActivate?.();
    if (outputExists) await fs.rename(spec.outputRoot, backup);
    try {
      await fs.rename(stage, spec.outputRoot);
      activated = true;
    } catch (error) {
      if (outputExists) await fs.rename(backup, spec.outputRoot);
      throw error;
    }
    if (outputExists) await fs.rm(backup, { recursive: true, force: false });
    return { outputFiles, provenanceFile: spec.outputs.provenance };
  } finally {
    if (!activated) await fs.rm(stage, { recursive: true, force: true });
  }
}

export async function publishProviderProductionSpecFile(
  specFile: string,
  options: PublicationOptions = {},
): Promise<PublicationResult> {
  const absolute = path.resolve(specFile);
  const encoded = await fs.readFile(absolute, 'utf8');
  return publishProviderProductionSpec(JSON.parse(encoded) as unknown, options);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const specFile = process.argv[2];
  if (specFile === undefined || process.argv.length !== 3) {
    console.error('usage: tsx scripts/src/provider-production-normalize-cli.ts <spec.json>');
    process.exitCode = 2;
  } else {
    await publishProviderProductionSpecFile(specFile);
  }
}
