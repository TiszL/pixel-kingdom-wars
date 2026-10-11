/**
 * game-v4 render overlay — a generalised, additive sibling of the bounded
 * three-file `art-candidate.ts` proof gate.
 *
 * WHAT IT IS. The overlay replaces **PNG BYTES ONLY**. Every legacy manifest
 * keeps owning identity and geometry: cell size, grid (cols × rows), anchor,
 * fps, loop, row order, emitters, footprint. An overlay file is joined to a
 * manifest entry by RUNTIME KEY and then substituted for the bytes the SVG
 * renderer would have produced. That is the whole reason gameplay, sprite
 * keys, atlas grouping, `meta.json` shape and every client controller stay
 * unchanged (recon §4.3 / D-072 §3: runtime identity is the compatibility
 * contract).
 *
 * NAMING CONTRACT. `art/game-v4/manifest.json` joins canonical nested paths,
 * legacy flat paths and recorded claims to the active ledger key. The 3.5 MB
 * target ledger is not a rasterize input; its generated manifest is. A flat
 * `<category>/<collection>-<runtimeKey>.png` parser remains only as a strict
 * diagnostic fallback for stale/outside-ledger names.
 *
 * Exact manifest membership is load-bearing, not cosmetic. The pack also holds
 * working trees (`superseded/<family>/flat/ware-*.png`, `labs/`) which repeat
 * runtime-key basenames verbatim. Matching on basename or folder precedence
 * would let withdrawn art win a runtime key.
 *
 * WHAT FAILS THE BUILD (loud, never silent):
 *  - a file named for a collection whose runtime key matches no manifest entry;
 *  - a file whose pixel dimensions are not exactly cellW*cols × cellH*rows;
 *  - differing duplicate claims without an explicit LOCAL-REVIEW select/hold;
 *  - every differing duplicate in production/CI/release mode, policy or not;
 *  - a `direct-` / `brand_*` target (brand standalones have three bypass paths
 *    in the pipeline, so an override there would silently no-op).
 *
 * WHAT IS MERELY COUNTED: any other PNG under the root. `art/game-v4` also
 * carries the studio's authoring layout (`buildings/keep/l20/idle.png`,
 * `actors/giant/t4/walk.png`, per-level `identity.png` stills). Those are not
 * runtime targets, so they are reported as unmatched rather than failing.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Boolean enable. Mirrors SHARDKEEP_ART_CANDIDATE_ROOT's SHARDKEEP_ prefix. */
export const GAME_V4_OVERLAY_ENV = 'SHARDKEEP_GAME_V4_OVERLAY' as const;
/** The second, explicit opt-in that lifts the production/CI refusal. */
export const GAME_V4_OVERLAY_RELEASE_ENV = 'SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE' as const;

/** Local-review decisions live beside the pack, never in historical provenance. */
export const GAME_V4_OVERLAY_POLICY_FILE = 'overlay-policy.json' as const;

/** Logical root recorded in meta.json; absolute paths never reach a runtime asset. */
export const GAME_V4_OVERLAY_LOGICAL_ROOT = 'art/game-v4' as const;

/** The eight ledger output categories. A PNG anywhere else under the root is
 * working material, not a runtime target. */
export const GAME_V4_OVERLAY_CATEGORIES = [
  'actors', 'brand', 'buildings', 'fx', 'items', 'portraits', 'ui', 'world',
] as const;

/** Manifest families this seam can substitute bytes for. */
export const GAME_V4_OVERLAY_COLLECTIONS = ['legacy', 'v2', 'ware'] as const;
export type GameV4OverlayCollection = typeof GAME_V4_OVERLAY_COLLECTIONS[number];

/** Ledger collection prefixes that exist but cannot be overridden here. */
const UNSUPPORTED_COLLECTIONS = ['direct'] as const;

const RUNTIME_KEY_RE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const RUNTIME_KEY_PREFIX_RE = /^[a-z0-9_]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GameV4OverlayEnvironment {
  SHARDKEEP_GAME_V4_OVERLAY?: string | undefined;
  SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE?: string | undefined;
  NODE_ENV?: string | undefined;
  CI?: string | undefined;
}

export interface GameV4OverlaySource {
  /** The runtime key came from manifest.json, so it is a real ledger target, not a typo. */
  ledgerKey?: boolean;
  /** POSIX path relative to the overlay root — never an absolute directory. */
  file: string;
  collection: GameV4OverlayCollection;
  runtimeKey: string;
  sha256: string;
  png: Buffer;
  width: number;
  height: number;
}

export interface GameV4OverlayPolicyRule {
  id: string;
  match: { key?: string; keyPrefix?: string };
  action: 'hold' | 'select';
  reason: string;
  expectedKeys: number;
  /** A narrower select may cross a broader hold only when the owner says so explicitly. */
  ownerOverride?: boolean;
  /** Exact-key selection. Both path and sha256 are mandatory together. */
  path?: string;
  sha256?: string;
  /** Family selection. Rewrites each ledger-canonical path and pins the whole set. */
  pathPrefix?: { from: string; to: string };
  selectionSha256?: string;
}

export interface GameV4OverlayPolicy {
  schemaVersion: 1;
  localReviewOnly: true;
  rules: readonly GameV4OverlayPolicyRule[];
}

export interface GameV4OverlayAlternateGroup {
  collection: GameV4OverlayCollection;
  runtimeKey: string;
  selectedFile: string | null;
  files: string[];
}

export interface GameV4OverlayHold {
  collection: GameV4OverlayCollection;
  runtimeKey: string;
  rule: string;
  reason: string;
  files: string[];
}

export interface GameV4Overlay {
  /** Files skipped because an identical master already claimed the same runtime key. */
  duplicateFiles?: string[];
  /** Absolute scan root. Deliberately absent from every emitted artifact. */
  root: string;
  /** True when the production/CI refusal was explicitly opted out of. */
  releaseOptIn: boolean;
  selectionMode: 'local-review' | 'strict';
  /** Null only for old/synthetic roots with no generated game-v4 manifest. */
  activeLedgerKeys: readonly string[] | null;
  scannedFiles: number;
  /** One entry per PNG that carries a `<collection>-<runtimeKey>` name. */
  sources: readonly GameV4OverlaySource[];
  /** PNGs under the root that name no runtime target, sorted. */
  unmatchedFiles: readonly string[];
  /** Parsable baseline keys which are deliberately outside the active target ledger. */
  outsideLedgerFiles: readonly string[];
  unresolvedHolds: readonly GameV4OverlayHold[];
  identicalAlternates: readonly GameV4OverlayAlternateGroup[];
  conflictingAlternates: readonly GameV4OverlayAlternateGroup[];
  /** Present only after the exact local-review decisions were materialized
   * into a one-claim-per-key release root and independently re-read in strict
   * mode. The strict overlay's own hold/conflict counts remain zero. */
  releasePromotion?: {
    sourceScannedFiles: number;
    selectedFiles: number;
    excludedHolds: number;
    resolvedIdenticalAlternates: number;
    resolvedConflictingAlternates: number;
    selectionSha256: string;
  };
}

export interface GameV4OverlayCollectionCoverage {
  /** Manifest entries this collection could have overridden. */
  manifestEntries: number;
  overridden: number;
  /** manifestEntries - overridden: still rendered from the legacy master. */
  fallback: number;
}

export interface GameV4OverlayCoverage {
  root: typeof GAME_V4_OVERLAY_LOGICAL_ROOT;
  selectionMode: 'local-review' | 'strict';
  /** Every PNG found under the root. */
  scannedFiles: number;
  /** Files that named a runtime target and were bound to a manifest entry. */
  matchedFiles: number;
  selectedFiles: number;
  /** Files that named no runtime target (authoring layout, identity stills). */
  unmatchedFiles: number;
  outsideLedgerFiles: number;
  manifestEntries: number;
  overriddenEntries: number;
  fallbackEntries: number;
  /** Baseline entries which are active targets but received no selected v4 bytes. */
  activeLedgerFallbacks: number;
  /** Runtime baseline entries outside M25's active ledger; not an art-coverage defect. */
  outsideLedgerBaseline: number;
  unresolvedHolds: number;
  identicalAlternates: number;
  conflictingAlternates: number;
  unbindableEntries: number;
  byCollection: Record<GameV4OverlayCollection, GameV4OverlayCollectionCoverage>;
  /** Up to ten unmatched paths, so the report is actionable without the log. */
  unmatchedSample: string[];
  holdSample: string[];
  identicalAlternateSample: string[];
  conflictingAlternateSample: string[];
  unbindableSample: string[];
}

/** True when the name was resolved from manifest.json (a real ledger key), false when it
 *  was parsed from the flat filename grammar and may therefore be a typo or a stale key. */
export type GameV4OverlayName =
  | { kind: 'target'; collection: GameV4OverlayCollection; runtimeKey: string; ledgerKey?: boolean }
  | { kind: 'unsupported'; collection: string; runtimeKey: string }
  | { kind: 'unnamed' };

function booleanEnvironmentValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !['', '0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Classify one overlay-relative path against the ledger's output convention.
 * Splitting on the FIRST hyphen is safe because no runtime key contains one.
 */
/**
 * Path -> runtime-key index built from art/game-v4/manifest.json.
 *
 * The canonical layout is NESTED (`buildings/keep/l20/idle.png`), but the name parser
 * below can only read the FLAT spelling (`buildings/ware-ware_bld_keep_l20_idle.png`).
 * Without this index every nested master — the whole gold forge progression, the wall
 * kit, the Keep and the Giant — is classified `unnamed` and reaches the game as nothing.
 * The manifest already states the mapping authoritatively, so join on it rather than
 * teaching the parser a second grammar.
 */
export type GameV4ManifestIndex = ReadonlyMap<string, {
  collection: GameV4OverlayCollection;
  runtimeKey: string;
}>;

interface GameV4ManifestMaster {
  id: string;
  key: string;
  path?: string;
  legacyFlatPath?: string;
  actualPath?: string;
  claims?: Array<{ path?: string }>;
}

function validRelativePath(value: string, options: { prefix?: boolean } = {}): boolean {
  if (value.startsWith('/') || value.includes('\\')) return false;
  if (options.prefix !== true && !value.endsWith('.png')) return false;
  if (options.prefix === true && !value.endsWith('/')) return false;
  const body = options.prefix ? value.slice(0, -1) : value;
  return body.length > 0 && body.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Parse the review policy as data. Provenance labels are intentionally absent. */
export function parseGameV4OverlayPolicy(input: unknown): GameV4OverlayPolicy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: policy must be an object`);
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || raw.localReviewOnly !== true || !Array.isArray(raw.rules)) {
    throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: expected schemaVersion 1, localReviewOnly true, and rules[]`);
  }
  const ids = new Set<string>();
  const selectors = new Set<string>();
  const rules = raw.rules.map((value, index): GameV4OverlayPolicyRule => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: rules[${index}] must be an object`);
    }
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || row.id.trim() === '' || ids.has(row.id)) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: rules[${index}] needs a unique id`);
    }
    ids.add(row.id);
    if (!row.match || typeof row.match !== 'object' || Array.isArray(row.match)) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${row.id} needs match.key or match.keyPrefix`);
    }
    const matchRaw = row.match as Record<string, unknown>;
    const key = typeof matchRaw.key === 'string' ? matchRaw.key : undefined;
    const keyPrefix = typeof matchRaw.keyPrefix === 'string' ? matchRaw.keyPrefix : undefined;
    if ((key === undefined) === (keyPrefix === undefined)
        || (key !== undefined && !RUNTIME_KEY_RE.test(key))
        || (keyPrefix !== undefined && !RUNTIME_KEY_PREFIX_RE.test(keyPrefix))) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${row.id} must match exactly one valid key or keyPrefix`);
    }
    const selector = key !== undefined ? `key:${key}` : `prefix:${keyPrefix}`;
    if (selectors.has(selector)) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: duplicate selector ${selector}`);
    }
    selectors.add(selector);
    if (row.action !== 'hold' && row.action !== 'select') {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${row.id} action must be hold or select`);
    }
    if (typeof row.reason !== 'string' || row.reason.trim() === '') {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${row.id} needs a reason`);
    }
    if (!Number.isInteger(row.expectedKeys) || (row.expectedKeys as number) <= 0) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${row.id} needs positive expectedKeys`);
    }
    if (row.ownerOverride !== undefined && typeof row.ownerOverride !== 'boolean') {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${row.id} ownerOverride must be boolean`);
    }
    const rule: GameV4OverlayPolicyRule = {
      id: row.id,
      match: key !== undefined ? { key } : { keyPrefix: keyPrefix! },
      action: row.action,
      reason: row.reason,
      expectedKeys: row.expectedKeys as number,
      ...(row.ownerOverride === true ? { ownerOverride: true } : {}),
    };
    if (row.action === 'hold') {
      if (row.path !== undefined || row.sha256 !== undefined || row.pathPrefix !== undefined
          || row.selectionSha256 !== undefined) {
        throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: hold ${row.id} cannot name selection bytes`);
      }
      return rule;
    }
    if (key !== undefined) {
      if (typeof row.path !== 'string' || !validRelativePath(row.path)
          || typeof row.sha256 !== 'string' || !SHA256_RE.test(row.sha256)
          || row.pathPrefix !== undefined || row.selectionSha256 !== undefined) {
        throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: exact select ${row.id} needs path + sha256`);
      }
      return { ...rule, path: row.path, sha256: row.sha256 };
    }
    if (!row.pathPrefix || typeof row.pathPrefix !== 'object' || Array.isArray(row.pathPrefix)) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: family select ${row.id} needs pathPrefix`);
    }
    const pathPrefix = row.pathPrefix as Record<string, unknown>;
    if (typeof pathPrefix.from !== 'string' || !validRelativePath(pathPrefix.from, { prefix: true })
        || typeof pathPrefix.to !== 'string' || !validRelativePath(pathPrefix.to, { prefix: true })
        || typeof row.selectionSha256 !== 'string' || !SHA256_RE.test(row.selectionSha256)
        || row.path !== undefined || row.sha256 !== undefined) {
      throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: family select ${row.id} needs valid pathPrefix + selectionSha256`);
    }
    return {
      ...rule,
      pathPrefix: { from: pathPrefix.from, to: pathPrefix.to },
      selectionSha256: row.selectionSha256,
    };
  });
  return { schemaVersion: 1, localReviewOnly: true, rules };
}

export async function loadGameV4OverlayPolicy(root: string): Promise<GameV4OverlayPolicy | null> {
  try {
    const raw = await fs.readFile(path.join(root, GAME_V4_OVERLAY_POLICY_FILE), 'utf8');
    return parseGameV4OverlayPolicy(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function manifestMasters(manifest: unknown): GameV4ManifestMaster[] {
  const masters = (manifest as { masters?: unknown })?.masters;
  if (!Array.isArray(masters)) return [];
  return masters.filter((entry): entry is GameV4ManifestMaster => {
    const row = entry as Partial<GameV4ManifestMaster>;
    return typeof row.id === 'string' && typeof row.key === 'string';
  });
}

function ruleMatches(rule: GameV4OverlayPolicyRule, key: string): boolean {
  return rule.match.key !== undefined ? rule.match.key === key : key.startsWith(rule.match.keyPrefix!);
}

function effectivePolicyRule(
  policy: GameV4OverlayPolicy | null,
  key: string,
): GameV4OverlayPolicyRule | null {
  if (!policy) return null;
  const matches = policy.rules.filter((rule) => ruleMatches(rule, key));
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aScore = a.match.key !== undefined ? Number.MAX_SAFE_INTEGER : a.match.keyPrefix!.length;
    const bScore = b.match.key !== undefined ? Number.MAX_SAFE_INTEGER : b.match.keyPrefix!.length;
    return bScore - aScore;
  });
  const winner = matches[0]!;
  const winnerScore = winner.match.key !== undefined ? Number.MAX_SAFE_INTEGER : winner.match.keyPrefix!.length;
  const tied = matches.filter((rule) =>
    (rule.match.key !== undefined ? Number.MAX_SAFE_INTEGER : rule.match.keyPrefix!.length) === winnerScore);
  if (tied.length !== 1) {
    throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ambiguous rules for ${key}: ${tied.map((r) => r.id).join(', ')}`);
  }
  if (winner.action === 'select' && matches.some((rule) => rule !== winner && rule.action === 'hold')
      && winner.ownerOverride !== true) {
    throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${winner.id} selects through a broader hold without ownerOverride`);
  }
  return winner;
}

function selectedPathForRule(rule: GameV4OverlayPolicyRule, canonicalPath: string): string {
  if (rule.path) return rule.path;
  const prefix = rule.pathPrefix!;
  if (!canonicalPath.startsWith(prefix.from)) {
    throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} cannot rewrite ${canonicalPath}`);
  }
  return `${prefix.to}${canonicalPath.slice(prefix.from.length)}`;
}

/** Hash binds every selected key to both its relative path and exact bytes. */
export function gameV4SelectionSha256(
  rows: readonly { runtimeKey: string; file: string; sha256: string }[],
): string {
  const payload = [...rows]
    .sort((a, b) => a.runtimeKey.localeCompare(b.runtimeKey))
    .map((row) => `${row.runtimeKey}\t${row.file}\t${row.sha256}\n`)
    .join('');
  return createHash('sha256').update(payload).digest('hex');
}

function validatePolicyCoverage(policy: GameV4OverlayPolicy | null, masters: GameV4ManifestMaster[]): void {
  if (!policy) return;
  for (const rule of policy.rules) {
    const count = masters.filter((row) => ruleMatches(rule, row.key)).length;
    if (count !== rule.expectedKeys) {
      throw new Error(
        `${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} expected ${rule.expectedKeys} ledger keys, matched ${count}`,
      );
    }
  }
}

export function buildGameV4ManifestIndex(
  manifest: unknown,
  policy: GameV4OverlayPolicy | null = null,
): GameV4ManifestIndex {
  const index = new Map<string, { collection: GameV4OverlayCollection; runtimeKey: string }>();
  const masters = manifestMasters(manifest);
  validatePolicyCoverage(policy, masters);
  const add = (candidate: string, value: { collection: GameV4OverlayCollection; runtimeKey: string }) => {
    const previous = index.get(candidate);
    if (previous && (previous.collection !== value.collection || previous.runtimeKey !== value.runtimeKey)) {
      throw new Error(`${GAME_V4_OVERLAY_ENV}: manifest path ${candidate} claims two runtime keys`);
    }
    index.set(candidate, value);
  };
  for (const row of masters) {
    const collection = row.id.slice(0, row.id.indexOf(':'));
    if (!(GAME_V4_OVERLAY_COLLECTIONS as readonly string[]).includes(collection)) continue;
    // Brand standalones reach apps/web/public/brand through three separate bypasses
    // (WAVE2_BRAND_FILES, BRAND_OVERRIDES, renderBrand), so this seam genuinely cannot
    // serve them and attach() refuses one on sight. Indexing a delivered brand master
    // here would therefore turn `pnpm assets` into a hard failure the moment brand art
    // exists. Leave them unindexed: they count as unmatched working material, and brand
    // still ships through its own path.
    if (row.key.startsWith('brand_')) continue;
    const value = { collection: collection as GameV4OverlayCollection, runtimeKey: row.key };
    // actualPath is where the master really is on disk today, which may be neither the
    // canonical path nor the flat spelling — e.g. the wall kit lives under buildings/walls/
    // because validate.mjs pins sha256s there, while the layout's canonical dir is wall/.
    // Index all three so a delivered master reaches the game whatever its placement.
    for (const candidate of [
      row.path, row.legacyFlatPath, row.actualPath,
      ...(row.claims ?? []).map((claim) => claim.path),
    ]) {
      if (typeof candidate === 'string' && candidate.length > 0) add(candidate, value);
    }
    const rule = effectivePolicyRule(policy, row.key);
    if (rule?.action === 'select' && typeof row.path === 'string') {
      add(selectedPathForRule(rule, row.path), value);
    }
  }
  return index;
}

async function loadGameV4ManifestState(root: string, policy: GameV4OverlayPolicy | null): Promise<{
  index: GameV4ManifestIndex;
  activeLedgerKeys: string[] | null;
  canonicalPathByIdentity: Map<string, string>;
  masters: GameV4ManifestMaster[];
}> {
  try {
    const raw = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(raw) as unknown;
    const masters = manifestMasters(manifest);
    const canonicalPathByIdentity = new Map<string, string>();
    for (const row of masters) {
      const collection = row.id.slice(0, row.id.indexOf(':'));
      if ((GAME_V4_OVERLAY_COLLECTIONS as readonly string[]).includes(collection)
          && !row.key.startsWith('brand_') && typeof row.path === 'string') {
        canonicalPathByIdentity.set(`${collection}:${row.key}`, row.path);
      }
    }
    return {
      index: buildGameV4ManifestIndex(manifest, policy),
      activeLedgerKeys: masters
        .filter((row) => !row.key.startsWith('brand_'))
        .map((row) => row.key),
      canonicalPathByIdentity,
      masters,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { index: new Map(), activeLedgerKeys: null, canonicalPathByIdentity: new Map(), masters: [] };
    }
    throw error;
  }
}

export async function loadGameV4ManifestIndex(root: string): Promise<GameV4ManifestIndex> {
  const policy = await loadGameV4OverlayPolicy(root);
  return (await loadGameV4ManifestState(root, policy)).index;
}

export function parseGameV4OverlayName(
  file: string,
  index?: GameV4ManifestIndex,
): GameV4OverlayName {
  const fromManifest = index?.get(file);
  if (fromManifest) {
    return {
      kind: 'target', collection: fromManifest.collection,
      runtimeKey: fromManifest.runtimeKey, ledgerKey: true,
    };
  }
  const segments = file.split('/');
  if (segments.length !== 2) return { kind: 'unnamed' };
  if (!(GAME_V4_OVERLAY_CATEGORIES as readonly string[]).includes(segments[0]!)) {
    return { kind: 'unnamed' };
  }
  const base = segments[1]!;
  if (!base.endsWith('.png')) return { kind: 'unnamed' };
  const stem = base.slice(0, -'.png'.length);
  const split = stem.indexOf('-');
  if (split <= 0) return { kind: 'unnamed' };
  const collection = stem.slice(0, split);
  const runtimeKey = stem.slice(split + 1);
  if (!RUNTIME_KEY_RE.test(runtimeKey)) return { kind: 'unnamed' };
  if ((GAME_V4_OVERLAY_COLLECTIONS as readonly string[]).includes(collection)) {
    return { kind: 'target', collection: collection as GameV4OverlayCollection, runtimeKey };
  }
  if ((UNSUPPORTED_COLLECTIONS as readonly string[]).includes(collection)) {
    return { kind: 'unsupported', collection, runtimeKey };
  }
  return { kind: 'unnamed' };
}

/** Exact pixel size straight from IHDR — no decode, and a non-PNG fails loud. */
export function readPngSize(data: Buffer, label: string): { width: number; height: number } {
  if (data.length < 24
      || !data.subarray(0, 8).equals(PNG_SIGNATURE)
      || data.subarray(12, 16).toString('latin1') !== 'IHDR') {
    throw new Error(`${GAME_V4_OVERLAY_ENV}: ${label} is not a PNG`);
  }
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

async function scanPngFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const listing = await fs.readdir(directory, { withFileTypes: true });
    for (const item of listing) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        await walk(path.join(directory, item.name), relative);
      } else if (item.isFile() && item.name.endsWith('.png')) {
        found.push(relative);
      }
    }
  }
  await walk(root, '');
  return found.sort();
}

/**
 * Read and classify the whole overlay as one unit. Returns null when the
 * feature is off, so the pipeline's default path is untouched.
 */
export async function resolveGameV4Overlay(options: {
  root: string;
  environment: GameV4OverlayEnvironment;
}): Promise<GameV4Overlay | null> {
  const { root, environment } = options;
  if (!booleanEnvironmentValue(environment.SHARDKEEP_GAME_V4_OVERLAY)) return null;

  const releaseOptIn = booleanEnvironmentValue(
    environment.SHARDKEEP_GAME_V4_OVERLAY_ALLOW_RELEASE,
  );
  const production = environment.NODE_ENV?.trim().toLowerCase() === 'production';
  const ci = booleanEnvironmentValue(environment.CI);
  if (!releaseOptIn) {
    if (production) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV} is forbidden when NODE_ENV=production without ${GAME_V4_OVERLAY_RELEASE_ENV}`,
      );
    }
    if (ci) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV} is forbidden in CI without ${GAME_V4_OVERLAY_RELEASE_ENV}`,
      );
    }
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`${GAME_V4_OVERLAY_ENV} root must be an absolute path`);
  }

  let files: string[];
  try {
    files = await scanPngFiles(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${GAME_V4_OVERLAY_ENV} root is missing`);
    }
    throw error;
  }

  // Release opt-in permits the overlay mechanism, but never imports the local
  // review policy's choices. Conflicts and holds remain fail-closed there.
  const strictSelection = releaseOptIn || production || ci;
  const policy = await loadGameV4OverlayPolicy(root);
  const manifest = await loadGameV4ManifestState(root, policy);
  const activeLedgerKeySet = manifest.activeLedgerKeys === null
    ? null
    : new Set(manifest.activeLedgerKeys);

  type Claim = GameV4OverlaySource;
  const claimsByIdentity = new Map<string, Claim[]>();
  const sources: GameV4OverlaySource[] = [];
  const unmatchedFiles: string[] = [];
  const outsideLedgerFiles: string[] = [];
  const unresolvedHolds: GameV4OverlayHold[] = [];
  const identicalAlternates: GameV4OverlayAlternateGroup[] = [];
  const conflictingAlternates: GameV4OverlayAlternateGroup[] = [];
  for (const file of files) {
    const parsed = parseGameV4OverlayName(file, manifest.index);
    if (parsed.kind === 'unnamed') {
      unmatchedFiles.push(file);
      continue;
    }
    if (parsed.kind === 'unsupported') {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: ${file} names the unsupported '${parsed.collection}' collection`,
      );
    }
    if (activeLedgerKeySet && !activeLedgerKeySet.has(parsed.runtimeKey)) {
      // A parsable legacy key is not automatically in M25. Leaving it on its
      // baseline bytes is deliberate, not a missing game-v4 master.
      outsideLedgerFiles.push(file);
      continue;
    }
    const identity = `${parsed.collection}:${parsed.runtimeKey}`;
    const png = await fs.readFile(path.join(root, ...file.split('/')));
    const { width, height } = readPngSize(png, file);
    const claim: Claim = {
      file, collection: parsed.collection, runtimeKey: parsed.runtimeKey,
      ledgerKey: parsed.ledgerKey === true,
      sha256: createHash('sha256').update(png).digest('hex'),
      png, width, height,
    };
    const group = claimsByIdentity.get(identity) ?? [];
    group.push(claim);
    claimsByIdentity.set(identity, group);
  }

  const activeMastersByIdentity = new Map<string, GameV4ManifestMaster>();
  for (const row of manifest.masters) {
    const collection = row.id.slice(0, row.id.indexOf(':'));
    if ((GAME_V4_OVERLAY_COLLECTIONS as readonly string[]).includes(collection)
        && !row.key.startsWith('brand_')) {
      activeMastersByIdentity.set(`${collection}:${row.key}`, row);
    }
  }

  if (strictSelection && policy) {
    const held = manifest.masters.filter((row) => effectivePolicyRule(policy, row.key)?.action === 'hold');
    if (held.length > 0) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: strict release has ${held.length} unresolved local-review hold(s); `
          + `${GAME_V4_OVERLAY_POLICY_FILE} cannot authorize production/CI`,
      );
    }
  }

  const identities = new Set(claimsByIdentity.keys());
  if (!strictSelection && policy) {
    for (const [identity, row] of activeMastersByIdentity) {
      if (effectivePolicyRule(policy, row.key)?.action === 'hold') identities.add(identity);
    }
  }

  const selectedByRule = new Map<string, Array<{ runtimeKey: string; file: string; sha256: string }>>();
  for (const identity of [...identities].sort()) {
    const claims = claimsByIdentity.get(identity) ?? [];
    const split = identity.indexOf(':');
    const collection = identity.slice(0, split) as GameV4OverlayCollection;
    const runtimeKey = identity.slice(split + 1);
    const row = activeMastersByIdentity.get(identity);
    const rule = strictSelection ? null : effectivePolicyRule(policy, runtimeKey);
    const hashes = new Set(claims.map((claim) => claim.sha256));
    const allIdentical = claims.length > 1 && hashes.size === 1;

    if (rule?.action === 'hold') {
      unresolvedHolds.push({
        collection, runtimeKey, rule: rule.id, reason: rule.reason,
        files: claims.map((claim) => claim.file).sort(),
      });
      if (claims.length > 1) {
        const group = {
          collection, runtimeKey, selectedFile: null,
          files: claims.map((claim) => claim.file).sort(),
        };
        (allIdentical ? identicalAlternates : conflictingAlternates).push(group);
      }
      continue;
    }

    if (claims.length === 0) {
      if (rule?.action === 'select') {
        throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} selects missing ${runtimeKey}`);
      }
      continue;
    }

    let selected: Claim;
    if (rule?.action === 'select') {
      const canonicalPath = row?.path ?? manifest.canonicalPathByIdentity.get(identity);
      if (!canonicalPath) {
        throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} has no canonical path for ${runtimeKey}`);
      }
      const selectedPath = selectedPathForRule(rule, canonicalPath);
      const hit = claims.find((claim) => claim.file === selectedPath);
      if (!hit) {
        throw new Error(`${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} selects missing path ${selectedPath}`);
      }
      if (rule.sha256 && hit.sha256 !== rule.sha256) {
        throw new Error(
          `${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} hash mismatch for ${selectedPath}: `
            + `expected ${rule.sha256}, got ${hit.sha256}`,
        );
      }
      selected = hit;
      const selectedRows = selectedByRule.get(rule.id) ?? [];
      selectedRows.push({ runtimeKey, file: hit.file, sha256: hit.sha256 });
      selectedByRule.set(rule.id, selectedRows);
    } else if (claims.length === 1) {
      selected = claims[0]!;
    } else if (allIdentical) {
      const canonicalPath = row?.path ?? manifest.canonicalPathByIdentity.get(identity);
      const canonical = canonicalPath ? claims.find((claim) => claim.file === canonicalPath) : undefined;
      if (!canonical) {
        throw new Error(
          `${GAME_V4_OVERLAY_ENV}: identical duplicate claims for ${runtimeKey} have no canonical path; `
            + `add an explicit ${GAME_V4_OVERLAY_POLICY_FILE} selection`,
        );
      }
      selected = canonical;
    } else {
      const claimList = claims.map((claim) => `${claim.file}@${claim.sha256}`).join(', ');
      if (strictSelection) {
        throw new Error(
          `${GAME_V4_OVERLAY_ENV}: ${runtimeKey} has different duplicate claims in strict mode: ${claimList}`,
        );
      }
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: ${runtimeKey} has different duplicate claims with no explicit `
          + `${GAME_V4_OVERLAY_POLICY_FILE} select/hold: ${claimList}`,
      );
    }

    sources.push(selected);
    if (claims.length > 1) {
      const group = {
        collection,
        runtimeKey,
        selectedFile: selected.file,
        files: claims.filter((claim) => claim !== selected).map((claim) => claim.file).sort(),
      };
      (allIdentical ? identicalAlternates : conflictingAlternates).push(group);
    }
  }

  if (!strictSelection && policy) {
    for (const rule of policy.rules.filter((candidate) =>
      candidate.action === 'select' && candidate.pathPrefix !== undefined)) {
      const selectedRows = selectedByRule.get(rule.id) ?? [];
      if (selectedRows.length !== rule.expectedKeys) {
        throw new Error(
          `${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} selected ${selectedRows.length} of ${rule.expectedKeys} keys`,
        );
      }
      const digest = gameV4SelectionSha256(selectedRows);
      if (digest !== rule.selectionSha256) {
        throw new Error(
          `${GAME_V4_OVERLAY_POLICY_FILE}: ${rule.id} selection hash mismatch: `
            + `expected ${rule.selectionSha256}, got ${digest}`,
        );
      }
    }
  }

  const duplicateFiles = [
    ...identicalAlternates.flatMap((group) => group.files),
    ...conflictingAlternates.flatMap((group) => group.files),
  ].sort();
  return {
    root,
    releaseOptIn,
    selectionMode: strictSelection ? 'strict' : 'local-review',
    activeLedgerKeys: manifest.activeLedgerKeys,
    scannedFiles: files.length,
    sources,
    unmatchedFiles,
    outsideLedgerFiles,
    unresolvedHolds,
    identicalAlternates,
    conflictingAlternates,
    duplicateFiles,
  };
}

/**
 * Pure coverage arithmetic, kept separate from the manifest join so the report
 * the owner reads is independently testable.
 */
export function gameV4OverlayCoverage(input: {
  selectionMode?: 'local-review' | 'strict';
  scannedFiles: number;
  selectedFiles?: number;
  unmatchedFiles: readonly string[];
  outsideLedgerFiles?: readonly string[];
  manifestEntries: Record<GameV4OverlayCollection, number>;
  overridden: Record<GameV4OverlayCollection, number>;
  /** Active-ledger baseline entries and selected overrides, measured at the join. */
  activeLedgerEntries?: number;
  activeLedgerOverridden?: number;
  unresolvedHolds?: readonly GameV4OverlayHold[];
  identicalAlternates?: readonly GameV4OverlayAlternateGroup[];
  conflictingAlternates?: readonly GameV4OverlayAlternateGroup[];
  unbindableEntries?: readonly string[];
  /** Backwards-compatible numeric input for older callers/tests. */
  unbindableFiles?: number;
}): GameV4OverlayCoverage {
  const byCollection = {} as Record<GameV4OverlayCollection, GameV4OverlayCollectionCoverage>;
  let manifestEntries = 0;
  let overriddenEntries = 0;
  for (const collection of GAME_V4_OVERLAY_COLLECTIONS) {
    const entries = input.manifestEntries[collection];
    const overridden = input.overridden[collection];
    if (overridden > entries) {
      throw new Error(
        `${GAME_V4_OVERLAY_ENV}: ${collection} overrode ${overridden} of ${entries} manifest entries`,
      );
    }
    byCollection[collection] = { manifestEntries: entries, overridden, fallback: entries - overridden };
    manifestEntries += entries;
    overriddenEntries += overridden;
  }
  const unmatchedFiles = input.unmatchedFiles.length;
  const outsideLedgerFiles = input.outsideLedgerFiles?.length ?? 0;
  const matchedFiles = input.scannedFiles - unmatchedFiles - outsideLedgerFiles;
  const selectedFiles = input.selectedFiles ?? matchedFiles;
  const unbindable = input.unbindableEntries?.length ?? input.unbindableFiles ?? 0;
  if (selectedFiles - unbindable !== overriddenEntries) {
    throw new Error(
      `${GAME_V4_OVERLAY_ENV}: ${selectedFiles} selected files (${unbindable} unbindable) bound ${overriddenEntries} manifest entries`,
    );
  }
  const activeLedgerEntries = input.activeLedgerEntries ?? manifestEntries;
  const activeLedgerOverridden = input.activeLedgerOverridden ?? overriddenEntries;
  if (activeLedgerEntries < 0 || activeLedgerEntries > manifestEntries
      || activeLedgerOverridden < 0 || activeLedgerOverridden > activeLedgerEntries
      || activeLedgerOverridden > overriddenEntries) {
    throw new Error(`${GAME_V4_OVERLAY_ENV}: active-ledger fallback arithmetic is impossible`);
  }
  const outsideLedgerEntries = manifestEntries - activeLedgerEntries;
  const outsideLedgerOverrides = overriddenEntries - activeLedgerOverridden;
  if (outsideLedgerOverrides > outsideLedgerEntries) {
    throw new Error(`${GAME_V4_OVERLAY_ENV}: outside-ledger override arithmetic is impossible`);
  }
  const activeLedgerFallbacks = activeLedgerEntries - activeLedgerOverridden;
  const outsideLedgerBaseline = outsideLedgerEntries - outsideLedgerOverrides;
  const fallbackEntries = manifestEntries - overriddenEntries;
  if (activeLedgerFallbacks + outsideLedgerBaseline !== fallbackEntries) {
    throw new Error(`${GAME_V4_OVERLAY_ENV}: fallback buckets do not balance`);
  }
  const unresolvedHolds = input.unresolvedHolds ?? [];
  const identicalAlternates = input.identicalAlternates ?? [];
  const conflictingAlternates = input.conflictingAlternates ?? [];
  const unbindableEntries = input.unbindableEntries ?? [];
  return {
    root: GAME_V4_OVERLAY_LOGICAL_ROOT,
    selectionMode: input.selectionMode ?? 'local-review',
    scannedFiles: input.scannedFiles,
    matchedFiles,
    selectedFiles,
    unmatchedFiles,
    outsideLedgerFiles,
    manifestEntries,
    overriddenEntries,
    fallbackEntries,
    activeLedgerFallbacks,
    outsideLedgerBaseline,
    unresolvedHolds: unresolvedHolds.length,
    identicalAlternates: identicalAlternates.length,
    conflictingAlternates: conflictingAlternates.length,
    unbindableEntries: unbindable,
    byCollection,
    unmatchedSample: [...input.unmatchedFiles].sort().slice(0, 10),
    holdSample: unresolvedHolds.map((hold) => `${hold.collection}:${hold.runtimeKey}`).sort().slice(0, 10),
    identicalAlternateSample: identicalAlternates
      .map((group) => `${group.collection}:${group.runtimeKey}`).sort().slice(0, 10),
    conflictingAlternateSample: conflictingAlternates
      .map((group) => `${group.collection}:${group.runtimeKey}`).sort().slice(0, 10),
    unbindableSample: [...unbindableEntries].sort().slice(0, 10),
  };
}

/** One-line-per-fact report; printed by the pipeline and safe to paste. */
export function formatGameV4OverlayCoverage(coverage: GameV4OverlayCoverage): string {
  const perCollection = GAME_V4_OVERLAY_COLLECTIONS.map((collection) => {
    const row = coverage.byCollection[collection];
    return `${collection} ${row.overridden}/${row.manifestEntries}`;
  }).join(', ');
  return `game-v4 overlay (${coverage.selectionMode === 'local-review' ? 'LOCAL-REVIEW' : 'STRICT'}): `
    + `${coverage.overriddenEntries}/${coverage.manifestEntries} manifest entries overridden `
    + `(${perCollection}); active-ledger fallbacks ${coverage.activeLedgerFallbacks}, `
    + `outside-ledger baseline ${coverage.outsideLedgerBaseline}; unresolved holds ${coverage.unresolvedHolds}, `
    + `identical alternates ${coverage.identicalAlternates}, conflicting alternates ${coverage.conflictingAlternates}, `
    + `unbindable ${coverage.unbindableEntries}; ${coverage.scannedFiles} PNGs scanned under ${coverage.root}, `
    + `${coverage.unmatchedFiles} matched nothing`;
}
