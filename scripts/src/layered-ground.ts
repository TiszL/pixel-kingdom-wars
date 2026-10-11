/** Versioned publisher; callers select accepted inventory or explicit previews.
 * Every byte is verified before the first write; published identities are hashes.
 * This infrastructure intentionally contains no admitted pilot or default selector. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { isRealmId } from '../../packages/shared/src/baseVisual.js';
import { BASE_LAYERED_GROUND_V3, BASE_LAYERED_GROUND_V4, BASE_LAYERED_GROUND_V5, type LayeredGroundDescriptor } from '../../packages/shared/src/layeredGroundCatalogue.js';
import { assertLayeredGroundManifest, assertLayeredGroundAssetPixels, renderLayeredGroundPixels, type LayeredAsset, type LayeredGroundManifest, type LayeredPixels } from '../../packages/shared/src/layeredGround.js';
import { assertRealmKitManifest, assertRealmKitAssetPixels, type RealmKitManifest } from '../../packages/shared/src/realmKit.js';
export const layeredSha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
export interface LayeredSource { asset: string; source: string }
/** Revisions 3/4 are painted layered ground; revision 5 is the tile-based realm kit
 * (REALM-KIT-PLAN E-2) — one registry/publisher family, two validators. */
export type LayeredRevision = 3 | 4 | 5;
export type LayeredPublishable = LayeredGroundManifest | RealmKitManifest;
const REGISTRY_PATH: Record<LayeredRevision, string> = { 3: 'art/realm-environments-v5/accepted.json', 4: 'art/realm-environments-v6/accepted.json', 5: 'art/realm-kit-v1/accepted.json' };
/** Verify every source byte of a manifest of either family before any write. */
export async function verifyLayeredSources(root: string, value: unknown, sources: LayeredSource[]) {
  if (value && typeof value === 'object' && (value as { groundRevision?: unknown }).groundRevision === 5) return verifyRealmKitSources(root, value, sources);
  return verifyLayeredGroundSources(root, value, sources);
}
export async function verifyRealmKitSources(root: string, value: unknown, sources: LayeredSource[]) {
  assertRealmKitManifest(value);
  const m = value;
  // Revision 5 sheets are lossless PNG only (E-13: 1 art px = 1 texel).
  for (const a of m.assets) if (!a.path.endsWith('.png')) throw new Error('Realm kit assets must be lossless PNG sheets');
  const rows = await verifyAssetSources(root, m.assets, sources, (asset, pixels) => assertRealmKitAssetPixels(m, asset, pixels));
  return { manifest: m, rows };
}
export async function verifyLayeredGroundSources(root: string, value: unknown, sources: LayeredSource[]) {
  assertLayeredGroundManifest(value);
  const m = value;
  const rows = await verifyAssetSources(root, m.assets, sources, (asset, pixels) => assertLayeredGroundAssetPixels(m, asset, pixels));
  return { manifest: m, rows };
}
async function verifyAssetSources(root: string, assets: LayeredAsset[], sources: LayeredSource[], admit: (asset: LayeredAsset, pixels: LayeredPixels) => void) {
  const canonical = await fs.realpath(root);
  if (sources.length !== assets.length || new Set(sources.map(s => s.asset)).size !== sources.length) throw new Error('Layered source inventory mismatch');
  const rows: Array<{ asset: LayeredAsset; bytes: Buffer; pixels: LayeredPixels }> = [];
  // Sequential preparation bounds decode residency; never queue every realm.
  for (const asset of assets) {
    const source = sources.find(s => s.asset === asset.id);
    if (!source || !/^art\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:png|webp)$/.test(source.source)) throw new Error('Invalid layered source path');
    const filename = await fs.realpath(path.join(root, source.source));
    if (!filename.startsWith(canonical + path.sep)) throw new Error('Layered source escapes repository');
    const bytes = await fs.readFile(filename);
    if (bytes.length !== asset.size || layeredSha256(bytes) !== asset.sha256) throw new Error('Layered source digest mismatch');
    const meta = await sharp(bytes).metadata();
    if (meta.format !== (asset.path.endsWith('.webp') ? 'webp' : 'png') || meta.width !== asset.width || meta.height !== asset.height) throw new Error('Layered source dimensions mismatch');
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    admit(asset, { data, width: info.width, height: info.height });
    rows.push({ asset, bytes, pixels: { data, width: info.width, height: info.height } });
  }
  return rows;
}
export async function buildLayeredGround(root: string, value: unknown, sources: LayeredSource[], outputRoot: string) {
  const { manifest, rows } = await verifyLayeredSources(root, value, sources);
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n'), sha256 = layeredSha256(bytes);
  const manifestPath = `atlas/fantasy/layered-ground/${sha256}/manifest.json`;
  // Immutable output must not be overwritten with a different byte sequence.
  for (const row of [...rows.map(r => ({ path: r.asset.path, bytes: r.bytes })), { path: manifestPath, bytes }]) {
    const filename = path.join(outputRoot, row.path);
    let existing: Buffer | undefined;
    try { existing = await fs.readFile(filename); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (existing && !existing.equals(row.bytes)) throw new Error('Immutable layered output already has different bytes');
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, row.bytes);
  }
  return { status: manifest.status, manifestPath, sha256, manifest, files: rows.map(r => r.asset) };
}
/** Server/base-image adapters use this same verified source geometry at frame0. */
export async function renderLayeredGroundPreview(root: string, value: unknown, sources: LayeredSource[], width: number, height: number, x = 0, y = 0) {
  const { manifest, rows } = await verifyLayeredGroundSources(root, value, sources);
  return renderLayeredGroundPixels(manifest, new Map(rows.map(r => [r.asset.id, r.pixels])), width, height, x, y);
}

// Compatibility names remain explicit; accepted publication uses the general API.
export const buildLayeredGroundPreview = buildLayeredGround;
export const renderLayeredGround = renderLayeredGroundPreview;

export interface LayeredRegistry { schemaVersion: 1; status: 'accepted'; manifests: Array<{realmId: string; manifest: string}> }
/** The revision-5 registry carries a status per realm: `preview-only` rows are the
 * owner's review material and are skipped entirely (never verified, never published),
 * so in-progress kit work cannot break `pnpm assets`; `accepted` rows publish like r4. */
export interface RealmKitRegistry { schemaVersion: 1; manifests: Array<{ realmId: string; manifest: string; status: 'preview-only' | 'accepted' }> }
/** Verify accepted art and compare frozen descriptors before publication. An
 * empty registry is deliberately inert while the owner is reviewing artwork. */
export async function acceptedLayeredGround(root: string, revision: LayeredRevision = 3) {
  let text: string;
  try { text = await fs.readFile(path.join(root, REGISTRY_PATH[revision]), 'utf8'); }
  catch (error) { if (revision !== 3 && (error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const registry = JSON.parse(text) as LayeredRegistry | RealmKitRegistry;
  if (registry.schemaVersion !== 1 || (revision !== 5 && (registry as LayeredRegistry).status !== 'accepted') || !Array.isArray(registry.manifests)
    || registry.manifests.length > 8 || new Set(registry.manifests.map(r => r.realmId)).size !== registry.manifests.length) throw new Error('Invalid accepted layered registry');
  const rows = [];
  for (const row of registry.manifests) {
    if (!isRealmId(row.realmId) || !/^art\/(?:[a-z0-9_-]+\/)+layered-manifest\.json$/.test(row.manifest)) throw new Error('Invalid accepted layered source');
    if (revision === 5) {
      const status = (row as RealmKitRegistry['manifests'][number]).status;
      if (status !== 'accepted' && status !== 'preview-only') throw new Error('Invalid realm kit registry status');
      if (status === 'preview-only') continue;
    }
    const filename = path.join(root, row.manifest);
    if (!(await fs.realpath(filename)).startsWith(await fs.realpath(root) + path.sep)) throw new Error('Layered manifest escapes repository');
    const value: unknown = JSON.parse(await fs.readFile(filename, 'utf8'));
    const sources = JSON.parse(await fs.readFile(path.join(path.dirname(filename), 'layered-sources.json'), 'utf8')) as LayeredSource[];
    const verified = await verifyLayeredSources(root, value, sources);
    if (verified.manifest.status !== 'accepted' || verified.manifest.realmId !== row.realmId || verified.manifest.groundRevision !== revision) throw new Error('Layered registry admission disagrees with manifest');
    const bytes = Buffer.from(JSON.stringify(verified.manifest) + '\n'), sha256 = layeredSha256(bytes);
    const descriptor: LayeredGroundDescriptor = { realmId: row.realmId, manifestPath: `atlas/fantasy/layered-ground/${sha256}/manifest.json`, sha256, size: bytes.length };
    rows.push({ ...verified, sources, descriptor });
  }
  return rows;
}
const CATALOGUE: Record<LayeredRevision, typeof BASE_LAYERED_GROUND_V3> = { 3: BASE_LAYERED_GROUND_V3, 4: BASE_LAYERED_GROUND_V4, 5: BASE_LAYERED_GROUND_V5 };
export async function pinAcceptedLayeredGround(root: string, previousCatalogue: typeof BASE_LAYERED_GROUND_V3 | undefined = undefined, revision: LayeredRevision = 3) {
  previousCatalogue ??= CATALOGUE[revision];
  const rows = await acceptedLayeredGround(root, revision);
  for (const [realm, previous] of Object.entries(previousCatalogue)) {
    const next = rows.find(r => r.descriptor.realmId === realm)?.descriptor;
    if (!next || JSON.stringify(next) !== JSON.stringify(previous)) throw new Error(`Published revision${revision} artwork is immutable; allocate a new ground revision`);
  }
  const values = Object.fromEntries(rows.map(r => [r.descriptor.realmId, r.descriptor]));
  const filename = path.join(root, 'packages/shared/src/layeredGroundCatalogue.ts');
  const source = await fs.readFile(filename, 'utf8');
  const generated = `// BEGIN GENERATED REVISION${revision} DESCRIPTORS\nexport const BASE_LAYERED_GROUND_V${revision}: Readonly<Partial<Record<RealmId, LayeredGroundDescriptor>>> = Object.freeze(` + JSON.stringify(values, null, 2) + `);\n// END GENERATED REVISION${revision} DESCRIPTORS`;
  const block = new RegExp(`// BEGIN GENERATED REVISION${revision} DESCRIPTORS[\\s\\S]*?// END GENERATED REVISION${revision} DESCRIPTORS`);
  if (!block.test(source)) throw new Error('Layered catalogue revision block is missing');
  await fs.writeFile(filename, source.replace(block, generated));
  return rows.map(r => r.descriptor);
}
export async function publishAcceptedLayeredGround(root: string, pinnedCatalogue: typeof BASE_LAYERED_GROUND_V3 | undefined = undefined, revision: LayeredRevision = 3) {
  pinnedCatalogue ??= CATALOGUE[revision];
  const rows = await acceptedLayeredGround(root, revision);
  if (rows.length !== Object.keys(pinnedCatalogue).length) throw new Error(`Accepted layered inventory must match pinned revision${revision} descriptors`);
  for (const row of rows) if (JSON.stringify(row.descriptor) !== JSON.stringify(pinnedCatalogue[row.descriptor.realmId])) throw new Error('Accepted layered descriptor is not pinned');
  const result = [];
  for (const row of rows) result.push(await buildLayeredGround(root, row.manifest, row.sources, path.join(root, 'apps/web/public')));
  return result;
}
