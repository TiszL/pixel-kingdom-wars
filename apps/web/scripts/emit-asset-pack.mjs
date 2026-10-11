/**
 * Emit the deterministic, build-bound manifest used by the Solana Mobile TWA.
 *
 * The Android shell remains a thin TWA. Its first launch may fill every game
 * asset in the background while ordinary browsers reuse the same SHA inventory
 * on demand. Keeping this as a post-build inventory means the manifest describes
 * the exact deployed bytes, including Vite chunks and atlas/audio trees.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetPackTier } from './asset-pack-core.mjs';

export const ASSET_PACK_SCHEMA = 2;
export const PACK_ROOTS = ['assets', 'atlas', 'audio', 'brand', 'icons'];

// These names were live in an older brand pass. A release must fail instead of
// silently putting their bytes back on a player's phone.
export const RETIRED_ASSET_PATHS = new Set([
  '/brand/brand_emblem_pulse_f1.png',
  '/brand/brand_emblem_pulse_f1@2x.png',
  '/brand/brand_emblem.png',
  '/brand/brand_emblem@2x.png',
  '/brand/brand_emblem_f2.png',
  '/brand/brand_emblem_f2@2x.png',
]);
export const RETIRED_ASSET_PATTERNS = [
  // Vite used to emit every assets-v3 brand master through icons.ts's eager
  // glob. Only the unchanged KEEP token and wordmark may remain JS assets; all
  // current screen/app marks come from generated public/brand and public/icons.
  /^\/assets\/brand_(?!token_logo-|logo_wordmark-)/,
];
export const RETIRED_TEXT_TOKENS = ['brand_emblem'];
// The installed Solana Mobile pack must be self-contained. In particular,
// wallet-standard-mobile's optional embedded modal must never smuggle its
// Google-hosted font stylesheet into the emitted entry bundle.
export const FORBIDDEN_EXTERNAL_TEXT_TOKENS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg']);

async function coreTierMaxBytes() {
  // Keep the ceiling in the canonical gameplay/constants file. This build-only
  // script cannot import that TypeScript module in plain Node because its graph
  // uses bundler-style extensionless imports, so read and narrowly parse the
  // one multiplication expression rather than duplicate the number here.
  const constants = await readFile(new URL('../../../packages/shared/src/constants.ts', import.meta.url), 'utf8');
  const block = /export const ASSET_PACK_TRANSFER = \{([\s\S]*?)\} as const;/.exec(constants)?.[1];
  const expression = /coreTierMaxBytes:\s*([\d_]+(?:\s*\*\s*[\d_]+)*)/.exec(block ?? '')?.[1];
  if (!expression) throw new Error('ASSET_PACK_TRANSFER.coreTierMaxBytes is not readable');
  const value = expression.split('*').reduce((product, factor) => product * Number(factor.trim().replaceAll('_', '')), 1);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('ASSET_PACK_TRANSFER.coreTierMaxBytes is invalid');
  return value;
}

function physicalBytes(files) {
  return [...new Map(files.map((file) => [file.sha256, file.bytes])).values()]
    .reduce((sum, bytes) => sum + bytes, 0);
}

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.woff2', 'font/woff2'],
]);

function contentType(path) {
  const dot = path.lastIndexOf('.');
  const type = CONTENT_TYPES.get(dot < 0 ? '' : path.slice(dot).toLowerCase());
  if (!type) throw new Error(`asset pack has no pinned MIME type for: ${path}`);
  return type;
}

function assertNoRetiredText(path, bytes) {
  const dot = path.lastIndexOf('.');
  if (!TEXT_EXTENSIONS.has(dot < 0 ? '' : path.slice(dot).toLowerCase())) return;
  const text = bytes.toString('utf8');
  for (const token of RETIRED_TEXT_TOKENS) {
    if (text.includes(token)) throw new Error(`retired runtime token ${token} reached production dist: ${path}`);
  }
  for (const token of FORBIDDEN_EXTERNAL_TEXT_TOKENS) {
    if (text.includes(token)) throw new Error(`external font origin ${token} reached production dist: ${path}`);
  }
}

async function walk(root, dir = root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, full));
    else if (entry.isFile()) files.push(full);
    else throw new Error(`asset pack refuses non-regular entry: ${relative(root, full)}`);
  }
  return files;
}

export async function createAssetPackManifest(dist, build) {
  if (!build || typeof build !== 'string') throw new Error('asset pack build id is required');
  const root = resolve(dist);
  const files = [];

  for (const prefix of PACK_ROOTS) {
    const dir = join(root, prefix);
    let info;
    try { info = await stat(dir); } catch { throw new Error(`asset pack root missing: ${prefix}/`); }
    if (!info.isDirectory()) throw new Error(`asset pack root is not a directory: ${prefix}/`);
    for (const full of await walk(root, dir)) {
      const rel = relative(root, full).split(sep).join('/');
      const path = `/${rel}`;
      // This byte-preservation archive belongs to the API's deed endpoints;
      // it is never game artwork and must not enter a phone's offline pack.
      if (path.startsWith('/atlas/retired-deeds/')) continue;
      // Unshipped revision2 studies were rejected by the owner. Preserve their
      // audit files on disk without prefetching them into a player's offline pack.
      if (path.startsWith('/atlas/fantasy/ground-v4/')) continue;
      // The world v2 pack (D-186, ~32 MB) is fetched on demand when a player
      // opens the world map, from its own pack-versioned path. In the inventory
      // it would join the full tier and every Seeker TWA would download it in
      // the background.
      if (path.startsWith('/atlas/world-v2/')) continue;
      if (RETIRED_ASSET_PATHS.has(path)) {
        throw new Error(`retired asset reached production dist: ${path}`);
      }
      if (RETIRED_ASSET_PATTERNS.some((pattern) => pattern.test(path))) {
        throw new Error(`retired Vite brand asset reached production dist: ${path}`);
      }
      const bytes = await readFile(full);
      assertNoRetiredText(path, bytes);
      files.push({
        path,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        contentType: contentType(path),
        tier: assetPackTier(path),
      });
    }
  }

  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (files.length === 0) throw new Error('asset pack inventory is empty');
  // A digest is downloaded once even when several logical paths have identical
  // bytes. Report the physical transfer/storage total, not an inflated path sum.
  const totalBytes = physicalBytes(files);
  const coreBytes = physicalBytes(files.filter((file) => file.tier === 'core'));
  const coreLimit = await coreTierMaxBytes();
  if (coreBytes > coreLimit) {
    throw new Error(`asset pack core tier is ${coreBytes} bytes; limit is ${coreLimit}`);
  }
  return { schema: ASSET_PACK_SCHEMA, build, totalBytes, files };
}

export async function emitAssetPack(dist) {
  const versionPath = join(dist, 'version.json');
  const version = JSON.parse(await readFile(versionPath, 'utf8'));
  if (typeof version.gitSha !== 'string' || !version.gitSha) {
    throw new Error(`${versionPath} does not contain a gitSha`);
  }
  const manifest = await createAssetPackManifest(dist, version.gitSha);
  await writeFile(join(dist, 'asset-pack.json'), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const defaultDist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const dist = resolve(process.argv[2] ?? defaultDist);
  const manifest = await emitAssetPack(dist);
  const coreFiles = manifest.files.filter((file) => file.tier === 'core');
  console.log(`  asset-pack.json: ${manifest.files.length} files, ${manifest.totalBytes} bytes; core ${physicalBytes(coreFiles)} bytes (${manifest.build})`);
}
