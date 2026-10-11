/**
 * World v2 bundle (D-186): publish the tracked export of the new world's pack to the web.
 *
 *   pnpm assets:world        (also the last step of `pnpm assets`, after rasterize has rebuilt apps/web/public/atlas)
 *
 * The export at art/world-v2/<packVersion>/ is native's 166-file selection of the concept pack pm1-cb8faa56909faa31
 * (pin 02e9da84, pack-manifest sha256 ac241498…), with native's own content.json byte for byte. It is generated
 * bytes, not masters, and it is tracked because the pack cannot be rebuilt from git and deploy builds from a fresh
 * clone. The web must draw exactly native's bytes (D-176/D-168), so this command:
 *   1. refuses a content.json whose sha256 is not the pinned one (that pins every file transitively);
 *   2. checks every export file's byte count and sha256 against content.json, and refuses unlisted files;
 *   3. copies the export to apps/web/public/atlas/world-v2/<packVersion>/ through a staged directory swapped in
 *      with one rename, re-checking every copied byte, so the web never serves half a generation;
 *   4. does nothing when the published copy already matches (idempotent; a run is hashing ~32 MB, well under a second).
 * Any mismatch fails with every problem listed and nothing written. apps/web/public/atlas/world-v2/ belongs to this
 * command alone: an older pack version there is replaced, never merged.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The pinned generation. Re-pinning means a new export directory and these four values, in one commit. */
export const WORLD_V2_EXPORT = Object.freeze({
  packVersion: 'pm1-cb8faa56909faa31',
  /** native pkw-android-globe app/src/main/assets/world/content.json at globe-native 7b5075b */
  contentSha256: '60ac87104ac35efffd393bd559a86286a65e9d3ffd69860bfec9973ef529c725',
  /** the GLSL and pack lock (native world-shaders.lock.json source.commit; globe-realms-veil) */
  pin: '02e9da8414156b9e0000df1653de6273b196cca6',
  /** concepts/globe3d-2026-09-23/pack-manifest.json at the pin (native lock contentManifest.sha256) */
  manifestSha256: 'ac241498c956d8da3309ddfa5228b6cb147ad751ee40d9a75b31f4f9069c9007',
});
export const EXPORT_DIR = 'art/world-v2';
export const PUBLISH_DIR = 'apps/web/public/atlas/world-v2';
export const INDEX = 'content.json';

export interface WorldFile { path: string; sha256: string; bytes: number }
export interface WorldContent {
  schema: 1; pin: string; manifest: { path: string; sha256: string; packVersion: string };
  phaseEIslands: boolean; realms: Array<{ id: string; status: string; packVersion: string }>;
  totals: { files: number; bytes: number }; files: WorldFile[];
}
export interface WorldPin { packVersion: string; contentSha256: string; pin: string; manifestSha256: string }
export interface PublishResult { packVersion: string; files: number; bytes: number; changed: boolean; dest: string }

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
// Pack-relative, no traversal, no query: the export is served verbatim under /atlas/world-v2/ (fieldsA.png is mixed case).
const SAFE_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp|json)$/;

function walk(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(entry => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walk(dir, child);
    if (!entry.isFile()) throw new Error(`world bundle refuses a non-regular entry: ${child}`);
    return [child];
  }).sort();
}

/** content.json as the pin names it, or an Error. The sha check comes first: nothing else in an unpinned index is trusted. */
export function readIndex(exportDir: string, pin: WorldPin = WORLD_V2_EXPORT): WorldContent {
  const file = path.join(exportDir, INDEX);
  if (!fs.existsSync(file)) throw new Error(`world bundle: missing ${file}`);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== pin.contentSha256) {
    throw new Error(`world bundle: ${file} is not the pinned index (sha256 ${sha256(bytes).slice(0, 12)}… != ${pin.contentSha256.slice(0, 12)}…)`);
  }
  const index = JSON.parse(bytes.toString('utf8')) as WorldContent;
  const problems: string[] = [];
  if (index.schema !== 1) problems.push(`schema ${String(index.schema)} is not 1`);
  if (index.pin !== pin.pin) problems.push(`pin ${String(index.pin)} is not ${pin.pin}`);
  if (index.manifest?.sha256 !== pin.manifestSha256) problems.push(`pack manifest ${String(index.manifest?.sha256)} is not ${pin.manifestSha256}`);
  if (index.manifest?.packVersion !== pin.packVersion) problems.push(`packVersion ${String(index.manifest?.packVersion)} is not ${pin.packVersion}`);
  if (path.basename(exportDir) !== pin.packVersion) problems.push(`export directory ${path.basename(exportDir)} is not named ${pin.packVersion}`);
  const seen = new Set<string>();
  let total = 0;
  for (const f of index.files ?? []) {
    if (typeof f.path !== 'string' || !SAFE_PATH.test(f.path) || f.path === INDEX) problems.push(`unsafe path ${String(f.path)}`);
    else if (seen.has(f.path)) problems.push(`duplicate path ${f.path}`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || !Number.isSafeInteger(f.bytes) || f.bytes < 0) problems.push(`bad entry ${String(f.path)}`);
    seen.add(f.path);
    total += f.bytes;
  }
  if (index.totals?.files !== seen.size || index.totals?.bytes !== total) {
    problems.push(`totals ${index.totals?.files} files / ${index.totals?.bytes} bytes do not match the ${seen.size} listed / ${total} bytes`);
  }
  if (problems.length) throw new Error(`world bundle: ${file} is malformed:\n  ${problems.join('\n  ')}`);
  return index;
}

/** Every problem between a directory and the index (empty = exact): missing, wrong size, wrong sha256, unlisted. */
export function drift(dir: string, index: WorldContent): string[] {
  if (!fs.existsSync(dir)) return [`missing ${dir}`];
  const problems: string[] = [];
  const listed = new Set([INDEX, ...index.files.map(f => f.path)]);
  for (const f of index.files) {
    const file = path.join(dir, f.path);
    if (!fs.existsSync(file)) { problems.push(`missing ${f.path}`); continue; }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== f.bytes) problems.push(`size ${f.path}: ${bytes.length} != ${f.bytes}`);
    else if (sha256(bytes) !== f.sha256) problems.push(`sha256 ${f.path}`);
  }
  for (const rel of walk(dir)) if (!listed.has(rel)) problems.push(`unlisted ${rel}`);
  return problems;
}

/** Exact equality of the published tree: only <packVersion>/ under world-v2/, holding exactly the export. */
function publishedDrift(publishDir: string, packVersion: string, index: WorldContent, indexBytes: Buffer): string[] {
  if (!fs.existsSync(publishDir)) return [`missing ${publishDir}`];
  const others = fs.readdirSync(publishDir).filter(name => name !== packVersion);
  const problems = others.map(name => `stale ${name}`);
  const dest = path.join(publishDir, packVersion);
  problems.push(...drift(dest, index));
  const published = path.join(dest, INDEX);
  if (fs.existsSync(published) && !fs.readFileSync(published).equals(indexBytes)) problems.push(`changed ${INDEX}`);
  return problems;
}

/** Verify the export, then publish it (or confirm it is already published). Throws with every problem listed. */
export function publishWorldBundle(root: string, pin: WorldPin = WORLD_V2_EXPORT): PublishResult {
  const exportDir = path.join(root, EXPORT_DIR, pin.packVersion);
  const publishDir = path.join(root, PUBLISH_DIR);
  const index = readIndex(exportDir, pin);
  const indexBytes = fs.readFileSync(path.join(exportDir, INDEX));
  const bad = drift(exportDir, index);
  if (bad.length) throw new Error(`REFUSED: the tracked export is not the pinned world pack (${bad.length} problem(s)); nothing was published:\n  ${bad.join('\n  ')}`);
  const result = { packVersion: pin.packVersion, files: index.files.length, bytes: index.totals.bytes, dest: path.join(publishDir, pin.packVersion) };
  if (publishedDrift(publishDir, pin.packVersion, index, indexBytes).length === 0) return { ...result, changed: false };

  // Staged beside public/ (same filesystem, never inside it) so a crash cannot leave a half copy that a web build
  // would ship; swapped in with one rename.
  const stage = path.join(root, 'apps/web', `.world-v2-stage-${process.pid}`);
  const old = path.join(root, 'apps/web', `.world-v2-old-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  try {
    const target = path.join(stage, pin.packVersion);
    for (const f of index.files) {
      fs.mkdirSync(path.dirname(path.join(target, f.path)), { recursive: true });
      // A copy-on-write clone where the filesystem offers one (APFS), a plain copy otherwise.
      fs.copyFileSync(path.join(exportDir, f.path), path.join(target, f.path), fs.constants.COPYFILE_FICLONE);
    }
    fs.writeFileSync(path.join(target, INDEX), indexBytes);
    const copied = drift(target, index);
    if (copied.length) throw new Error(`REFUSED: the staged copy differs from the export:\n  ${copied.join('\n  ')}`);
    fs.mkdirSync(path.dirname(publishDir), { recursive: true });
    if (fs.existsSync(publishDir)) fs.renameSync(publishDir, old);
    fs.renameSync(stage, publishDir);
  } finally {
    for (const dir of [stage, old]) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { ...result, changed: true };
}

function main(): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const r = publishWorldBundle(root);
  console.log(`world v2: ${r.files} files, ${r.bytes} bytes (${r.packVersion}, pin ${WORLD_V2_EXPORT.pin.slice(0, 8)}) ${r.changed ? 'published to' : 'already published at'} ${path.relative(root, r.dest)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
}
