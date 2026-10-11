import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import {
  assertGameArtIdentity,
  compareGameArtStrings,
  gameArtContractSha256,
  gameArtJsonSha256,
  normalizeGameArtContract,
  normalizeGameArtPath,
  type GameArtContract,
  type GameArtContractEntry,
  type GameArtIdentity,
  type GameArtJson,
} from './game-art-contract.js';

export const GAME_ART_PACK_SCHEMA = 1 as const;
export const GAME_ART_PROVENANCE_SCHEMA = 1 as const;
/** Keep full-pack Sharp decodes bounded; approved packs contain thousands of PNGs. */
export const GAME_ART_PACK_VALIDATION_CONCURRENCY = 4 as const;

export type GameArtPackProfile = 'candidate' | 'approved';

export interface GameArtPackManifestEntry {
  identity: GameArtIdentity;
  file: string;
  sha256: string;
}

export interface GameArtPackManifest {
  schemaVersion: typeof GAME_ART_PACK_SCHEMA;
  packId: string;
  profile: GameArtPackProfile;
  contractSha256: string;
  /** Candidate scope may be partial; approved scope must equal the full contract. */
  scope: readonly GameArtIdentity[];
  entries: readonly GameArtPackManifestEntry[];
}

export interface GameArtProvenanceOutput extends GameArtPackManifestEntry {
  width: number;
  height: number;
}

export interface GameArtPackProvenance {
  schemaVersion: typeof GAME_ART_PROVENANCE_SCHEMA;
  producer: string;
  outputs: readonly GameArtProvenanceOutput[];
}

export interface GameArtDecodedPng {
  data: Buffer;
  width: number;
  height: number;
}

export type GameArtPixelValidator = (
  png: GameArtDecodedPng,
  entry: GameArtContractEntry,
) => void | Promise<void>;

export interface LoadGameArtPackOptions {
  root: string;
  expectedProfile: GameArtPackProfile;
  contract: GameArtContract;
  manifest: GameArtPackManifest;
  provenance: GameArtPackProvenance;
  /** Directories whose complete regular-file inventory is owned by this manifest. */
  managedRoots: readonly string[];
  pixelValidators: Readonly<Record<string, GameArtPixelValidator>>;
}

export interface LoadedGameArtPack {
  readonly packId: string;
  readonly profile: GameArtPackProfile;
  readonly contractSha256: string;
  readonly manifestSha256: string;
  readonly provenanceSha256: string;
  readonly identities: readonly GameArtIdentity[];
  readonly logicalFiles: readonly string[];
  /** Returns a defensive copy of the validated snapshot; it never rereads disk. */
  readPng(identity: GameArtIdentity): Buffer;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const PACK_ID_RE = /^[a-z0-9][a-z0-9.-]*$/;
const PRODUCER_RE = /^[a-z0-9][a-z0-9_.-]*$/;

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unexpected fields: ${unexpected.sort(compareGameArtStrings).join(', ')}`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lower-case SHA256`);
  }
}

function sortedExact(actual: readonly string[], expected: readonly string[], label: string): void {
  const left = [...actual].sort(compareGameArtStrings);
  const right = [...expected].sort(compareGameArtStrings);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    const expectedSet = new Set(right);
    const actualSet = new Set(left);
    const missing = right.filter((value) => !actualSet.has(value));
    const extra = left.filter((value) => !expectedSet.has(value));
    throw new Error(`${label} differs; missing [${missing.join(', ')}], extra [${extra.join(', ')}]`);
  }
}

function uniqueSortedIdentities(values: unknown, label: string): GameArtIdentity[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty array`);
  const seen = new Set<GameArtIdentity>();
  for (const [index, value] of values.entries()) {
    assertGameArtIdentity(value, `${label}[${index}]`);
    if (seen.has(value)) throw new Error(`${label} contains duplicate identity ${value}`);
    seen.add(value);
  }
  return [...seen].sort(compareGameArtStrings);
}

function normalizeManifest(value: unknown): GameArtPackManifest {
  assertPlainObject(value, 'game art manifest');
  assertExactKeys(
    value,
    ['schemaVersion', 'packId', 'profile', 'contractSha256', 'scope', 'entries'],
    'game art manifest',
  );
  if (value.schemaVersion !== GAME_ART_PACK_SCHEMA) {
    throw new Error(`game art manifest schemaVersion must be ${GAME_ART_PACK_SCHEMA}`);
  }
  if (typeof value.packId !== 'string' || !PACK_ID_RE.test(value.packId)) {
    throw new Error('game art manifest packId is invalid');
  }
  if (value.profile !== 'candidate' && value.profile !== 'approved') {
    throw new Error('game art manifest profile must be candidate or approved');
  }
  assertSha256(value.contractSha256, 'game art manifest contractSha256');
  const scope = uniqueSortedIdentities(value.scope, 'game art manifest scope');
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error('game art manifest entries must be a non-empty array');
  }
  const identities = new Set<GameArtIdentity>();
  const files = new Set<string>();
  const entries = value.entries.map((raw, index): GameArtPackManifestEntry => {
    const label = `game art manifest entry ${index}`;
    assertPlainObject(raw, label);
    assertExactKeys(raw, ['identity', 'file', 'sha256'], label);
    assertGameArtIdentity(raw.identity, `${label}.identity`);
    if (identities.has(raw.identity)) throw new Error(`duplicate game art manifest identity ${raw.identity}`);
    identities.add(raw.identity);
    const file = normalizeGameArtPath(raw.file, `${raw.identity}.file`);
    if (!file.endsWith('.png')) throw new Error(`${raw.identity}: source file must end in .png`);
    if (files.has(file)) throw new Error(`duplicate game art manifest file ${file}`);
    files.add(file);
    assertSha256(raw.sha256, `${raw.identity}.sha256`);
    return Object.freeze({ identity: raw.identity, file, sha256: raw.sha256 });
  }).sort((left, right) => compareGameArtStrings(left.identity, right.identity));
  sortedExact(entries.map(({ identity }) => identity), scope, 'game art manifest entries vs scope');
  return Object.freeze({
    schemaVersion: GAME_ART_PACK_SCHEMA,
    packId: value.packId,
    profile: value.profile,
    contractSha256: value.contractSha256,
    scope: Object.freeze(scope),
    entries: Object.freeze(entries),
  });
}

export function gameArtManifestSha256(manifest: GameArtPackManifest): string {
  return gameArtJsonSha256(normalizeManifest(manifest) as unknown as GameArtJson);
}

function normalizeProvenance(value: unknown): GameArtPackProvenance {
  assertPlainObject(value, 'game art provenance');
  assertExactKeys(value, ['schemaVersion', 'producer', 'outputs'], 'game art provenance');
  if (value.schemaVersion !== GAME_ART_PROVENANCE_SCHEMA) {
    throw new Error(`game art provenance schemaVersion must be ${GAME_ART_PROVENANCE_SCHEMA}`);
  }
  if (typeof value.producer !== 'string' || !PRODUCER_RE.test(value.producer)) {
    throw new Error('game art provenance producer is invalid');
  }
  if (!Array.isArray(value.outputs) || value.outputs.length === 0) {
    throw new Error('game art provenance outputs must be a non-empty array');
  }
  const identities = new Set<GameArtIdentity>();
  const files = new Set<string>();
  const outputs = value.outputs.map((raw, index): GameArtProvenanceOutput => {
    const label = `game art provenance output ${index}`;
    assertPlainObject(raw, label);
    assertExactKeys(raw, ['identity', 'file', 'sha256', 'width', 'height'], label);
    assertGameArtIdentity(raw.identity, `${label}.identity`);
    if (identities.has(raw.identity)) throw new Error(`duplicate game art provenance identity ${raw.identity}`);
    identities.add(raw.identity);
    const file = normalizeGameArtPath(raw.file, `${raw.identity}.file`);
    if (files.has(file)) throw new Error(`duplicate game art provenance file ${file}`);
    files.add(file);
    assertSha256(raw.sha256, `${raw.identity}.sha256`);
    if (!Number.isSafeInteger(raw.width) || (raw.width as number) <= 0
        || !Number.isSafeInteger(raw.height) || (raw.height as number) <= 0) {
      throw new Error(`${raw.identity}: provenance width and height must be positive safe integers`);
    }
    return Object.freeze({
      identity: raw.identity,
      file,
      sha256: raw.sha256,
      width: raw.width as number,
      height: raw.height as number,
    });
  }).sort((left, right) => compareGameArtStrings(left.identity, right.identity));
  return Object.freeze({
    schemaVersion: GAME_ART_PROVENANCE_SCHEMA,
    producer: value.producer,
    outputs: Object.freeze(outputs),
  });
}

export function gameArtProvenanceSha256(provenance: GameArtPackProvenance): string {
  return gameArtJsonSha256(normalizeProvenance(provenance) as unknown as GameArtJson);
}

function logicalPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/') || '.';
}

function isRealPathContained(rootRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertRealPathContained(
  rootRealPath: string,
  absolute: string,
  label: string,
): Promise<void> {
  const real = await fs.realpath(absolute);
  if (!isRealPathContained(rootRealPath, real)) {
    throw new Error(`${label} resolves outside the game art pack root`);
  }
}

async function listManagedFiles(
  root: string,
  rootRealPath: string,
  managedRoots: readonly string[],
): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const directoryLabel = logicalPath(root, directory);
    const directoryInfo = await fs.lstat(directory);
    if (directoryInfo.isSymbolicLink()) {
      throw new Error(`game art pack refuses symbolic link ${directoryLabel}`);
    }
    if (!directoryInfo.isDirectory()) throw new Error(`game art managed root is not a directory: ${directoryLabel}`);
    await assertRealPathContained(rootRealPath, directory, `game art directory ${directoryLabel}`);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => compareGameArtStrings(left.name, right.name))) {
      const absolute = path.join(directory, entry.name);
      const label = logicalPath(root, absolute);
      const info = await fs.lstat(absolute);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new Error(`game art pack refuses symbolic link ${label}`);
      }
      await assertRealPathContained(rootRealPath, absolute, `game art entry ${label}`);
      if (entry.isDirectory() && info.isDirectory()) await walk(absolute);
      else if (entry.isFile() && info.isFile()) files.push(label);
      else throw new Error(`game art pack refuses non-regular entry ${label}`);
    }
  };
  for (const managedRoot of managedRoots) await walk(path.join(root, ...managedRoot.split('/')));
  return files.sort(compareGameArtStrings);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index]!);
      }
    }),
  );
}

/**
 * Validate one pack atomically and snapshot its PNG bytes. The returned reader
 * serves defensive copies from memory, so a later disk rewrite cannot change
 * the bytes that the rasterizer accepted.
 */
export async function loadGameArtPack(options: LoadGameArtPackOptions): Promise<LoadedGameArtPack> {
  if (!path.isAbsolute(options.root)) throw new Error('game art pack root must be absolute');
  const rootInfo = await fs.lstat(options.root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('game art pack root must be a real directory, not a symbolic link');
  }
  const rootRealPath = await fs.realpath(options.root);
  const contract = normalizeGameArtContract(options.contract);
  const contractSha256 = gameArtContractSha256(contract);
  const manifest = normalizeManifest(options.manifest);
  const provenance = normalizeProvenance(options.provenance);
  if (manifest.profile !== options.expectedProfile) {
    throw new Error(`game art manifest profile ${manifest.profile} does not match expected ${options.expectedProfile}`);
  }
  if (manifest.contractSha256 !== contractSha256) {
    throw new Error('game art manifest contractSha256 does not match the runtime contract');
  }

  const contractByIdentity = new Map(contract.entries.map((entry) => [entry.identity, entry]));
  for (const identity of manifest.scope) {
    if (!contractByIdentity.has(identity)) throw new Error(`game art manifest scope contains unknown identity ${identity}`);
  }
  if (manifest.profile === 'approved') {
    sortedExact(manifest.scope, contract.entries.map(({ identity }) => identity), 'approved game art coverage');
  }

  const managedRoots = options.managedRoots.map((managedRoot, index) => managedRoot === '.'
    ? managedRoot
    : normalizeGameArtPath(managedRoot, `managedRoots[${index}]`));
  if (managedRoots.length === 0 || new Set(managedRoots).size !== managedRoots.length) {
    throw new Error('game art managedRoots must be a non-empty unique list');
  }
  for (const entry of manifest.entries) {
    if (!managedRoots.some((managedRoot) => managedRoot === '.' || entry.file.startsWith(`${managedRoot}/`))) {
      throw new Error(`${entry.identity}: file is outside the managed art roots`);
    }
  }
  sortedExact(await listManagedFiles(options.root, rootRealPath, managedRoots), manifest.entries.map(({ file }) => file),
    'game art managed file inventory');

  sortedExact(
    provenance.outputs.map(({ identity }) => identity),
    manifest.entries.map(({ identity }) => identity),
    'game art provenance outputs vs manifest',
  );
  const provenanceByIdentity = new Map(provenance.outputs.map((output) => [output.identity, output]));
  const snapshots = new Map<GameArtIdentity, Buffer>();

  await mapLimit(manifest.entries, GAME_ART_PACK_VALIDATION_CONCURRENCY, async (entry) => {
    const contractEntry = contractByIdentity.get(entry.identity)!;
    const output = provenanceByIdentity.get(entry.identity)!;
    if (output.file !== entry.file || output.sha256 !== entry.sha256
        || output.width !== contractEntry.width || output.height !== contractEntry.height) {
      throw new Error(`${entry.identity}: provenance differs from manifest or runtime contract`);
    }
    const absolute = path.join(options.root, ...entry.file.split('/'));
    const info = await fs.lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${entry.identity}: source must be a regular PNG file`);
    await assertRealPathContained(rootRealPath, absolute, `${entry.identity}: source`);
    const encoded = await fs.readFile(absolute);
    if (sha256(encoded) !== entry.sha256) throw new Error(`${entry.identity}: PNG SHA256 does not match provenance`);
    const metadata = await sharp(encoded).metadata();
    if (metadata.format !== 'png' || (metadata.pages ?? 1) !== 1
        || metadata.depth !== 'uchar' || metadata.channels !== 4 || metadata.hasAlpha !== true) {
      throw new Error(`${entry.identity}: source must be one static 8-bit RGBA PNG`);
    }
    if (metadata.width !== contractEntry.width || metadata.height !== contractEntry.height) {
      throw new Error(
        `${entry.identity}: source is ${metadata.width}x${metadata.height}, expected ${contractEntry.width}x${contractEntry.height}`,
      );
    }
    const decoded = await sharp(encoded).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const validator = Object.prototype.hasOwnProperty.call(options.pixelValidators, contractEntry.pixelLaw)
      ? options.pixelValidators[contractEntry.pixelLaw]
      : undefined;
    if (typeof validator !== 'function') {
      throw new Error(`${entry.identity}: no validator for pixel law ${contractEntry.pixelLaw}`);
    }
    await validator({ data: decoded.data, width: decoded.info.width, height: decoded.info.height }, contractEntry);
    snapshots.set(entry.identity, Buffer.from(encoded));
  });

  const identities = Object.freeze(manifest.entries.map(({ identity }) => identity));
  const logicalFiles = Object.freeze(manifest.entries.map(({ file }) => file).sort(compareGameArtStrings));
  return Object.freeze({
    packId: manifest.packId,
    profile: manifest.profile,
    contractSha256,
    manifestSha256: gameArtManifestSha256(manifest),
    provenanceSha256: gameArtProvenanceSha256(provenance),
    identities,
    logicalFiles,
    readPng(identity: GameArtIdentity): Buffer {
      const bytes = snapshots.get(identity);
      if (!bytes) throw new Error(`game art pack has no loaded identity ${identity}`);
      return Buffer.from(bytes);
    },
  });
}
