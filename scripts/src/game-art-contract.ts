import { createHash } from 'node:crypto';
import path from 'node:path';

export const GAME_ART_CONTRACT_SCHEMA = 1 as const;
export const GAME_ART_IDENTITY_KINDS = ['simple', 'v2', 'ware', 'standalone'] as const;

export type GameArtIdentityKind = typeof GAME_ART_IDENTITY_KINDS[number];
export type GameArtIdentity = `${GameArtIdentityKind}:${string}`;
export type GameArtJson = null | boolean | number | string | GameArtJson[] | { [key: string]: GameArtJson };

export interface GameArtContractEntry {
  /** Stable runtime identity. It never depends on the source file extension. */
  identity: GameArtIdentity;
  width: number;
  height: number;
  /** Validator selected by the caller, for example `v2`, `ware`, or a v4 palette id. */
  pixelLaw: string;
  /** Runtime geometry/timing facts. Array order is significant (for example rowOrder). */
  metadata?: GameArtJson;
}

export interface GameArtContract {
  schemaVersion: typeof GAME_ART_CONTRACT_SCHEMA;
  entries: readonly GameArtContractEntry[];
}

const IDENTITY_RE = /^(simple|v2|ware|standalone):([a-z0-9][a-z0-9_./-]*)$/;
const PIXEL_LAW_RE = /^[a-z0-9][a-z0-9_.-]*$/;

/** Locale-independent ECMAScript string ordering (UTF-16 code units). */
export function compareGameArtStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

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

function assertJson(value: unknown, label: string): asserts value is GameArtJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJson(item, `${label}[${index}]`));
    return;
  }
  assertPlainObject(value, label);
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) throw new Error(`${label}.${key} is undefined`);
    assertJson(item, `${label}.${key}`);
  }
}

function cloneAndFreezeJson(value: GameArtJson): GameArtJson {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeJson)) as unknown as GameArtJson[];
  }
  return Object.freeze(Object.fromEntries(
    Object.keys(value).sort(compareGameArtStrings).map((key) => [key, cloneAndFreezeJson(value[key]!)]),
  )) as { [key: string]: GameArtJson };
}

function hasUnsafeSegments(value: string): boolean {
  return value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function assertGameArtIdentity(value: unknown, label = 'art identity'): asserts value is GameArtIdentity {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const match = IDENTITY_RE.exec(value);
  if (!match || hasUnsafeSegments(match[2]!)) {
    throw new Error(`${label} must be simple:/v2:/ware:/standalone: followed by a normalized lower-case id`);
  }
}

/** Strict POSIX relative path used in tracked manifests and secret-free metadata. */
export function normalizeGameArtPath(value: unknown, label = 'art path'): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')
      || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || hasUnsafeSegments(value)) {
    throw new Error(`${label} must be a normalized relative POSIX path`);
  }
  return value;
}

/** Canonical JSON keeps hashes stable across object-key and manifest-entry ordering. */
export function canonicalGameArtJson(value: GameArtJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalGameArtJson).join(',')}]`;
  return `{${Object.keys(value).sort(compareGameArtStrings).map((key) =>
    `${JSON.stringify(key)}:${canonicalGameArtJson(value[key]!)}`).join(',')}}`;
}

export function gameArtJsonSha256(value: GameArtJson): string {
  return createHash('sha256').update(canonicalGameArtJson(value)).digest('hex');
}

/** Validate, clone and sort the immutable runtime contract before it is hashed. */
export function normalizeGameArtContract(value: unknown): GameArtContract {
  assertPlainObject(value, 'game art contract');
  assertExactKeys(value, ['schemaVersion', 'entries'], 'game art contract');
  if (value.schemaVersion !== GAME_ART_CONTRACT_SCHEMA) {
    throw new Error(`game art contract schemaVersion must be ${GAME_ART_CONTRACT_SCHEMA}`);
  }
  if (!Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error('game art contract entries must be a non-empty array');
  }

  const seen = new Set<GameArtIdentity>();
  const entries = value.entries.map((raw, index): GameArtContractEntry => {
    const label = `game art contract entry ${index}`;
    assertPlainObject(raw, label);
    assertExactKeys(raw, ['identity', 'width', 'height', 'pixelLaw', 'metadata'], label);
    assertGameArtIdentity(raw.identity, `${label}.identity`);
    if (seen.has(raw.identity)) throw new Error(`duplicate game art contract identity ${raw.identity}`);
    seen.add(raw.identity);
    if (!Number.isSafeInteger(raw.width) || (raw.width as number) <= 0
        || !Number.isSafeInteger(raw.height) || (raw.height as number) <= 0) {
      throw new Error(`${raw.identity}: contract width and height must be positive safe integers`);
    }
    if (typeof raw.pixelLaw !== 'string' || !PIXEL_LAW_RE.test(raw.pixelLaw)) {
      throw new Error(`${raw.identity}: contract pixelLaw is invalid`);
    }
    if (raw.metadata !== undefined) assertJson(raw.metadata, `${raw.identity}.metadata`);
    const metadata = raw.metadata === undefined
      ? undefined
      : cloneAndFreezeJson(raw.metadata as GameArtJson);
    return Object.freeze({
      identity: raw.identity,
      width: raw.width as number,
      height: raw.height as number,
      pixelLaw: raw.pixelLaw,
      ...(metadata === undefined ? {} : { metadata }),
    });
  }).sort((left, right) => compareGameArtStrings(left.identity, right.identity));

  return Object.freeze({ schemaVersion: GAME_ART_CONTRACT_SCHEMA, entries: Object.freeze(entries) });
}

export function gameArtContractSha256(contract: GameArtContract): string {
  const normalized = normalizeGameArtContract(contract);
  return gameArtJsonSha256(normalized as unknown as GameArtJson);
}
