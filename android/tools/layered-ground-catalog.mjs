// Accepted inventory and explicit previews use identical immutable byte admission.
import path from 'node:path';
import { createHash } from 'node:crypto';
const REALMS = new Set(['frostveil','elderwood','sunscar','crownlands','seeker-reach','stormcairn','thornwake','cinderfall']);
async function prepare({source, filename, readFile, verifySources, status, realmId, groundRevision}) {
  const relative = path.relative(source, filename);
  if (!/^art\/(?:[a-z0-9_-]+\/)+layered-(?:preview|manifest)\.json$/.test(relative)) throw new Error('Layered manifest must be an explicit source-art sidecar');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  if ((groundRevision !== undefined && manifest.groundRevision !== groundRevision) || manifest.status !== status || (realmId && manifest.realmId !== realmId)) throw new Error('Layered source admission mismatch');
  const sources = JSON.parse(await readFile(path.join(path.dirname(filename), 'layered-sources.json'), 'utf8'));
  const verified = await verifySources(source, manifest, sources);
  const bytes = Buffer.from(JSON.stringify(verified.manifest) + '\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { verified, bytes, descriptor: {realmId: manifest.realmId, manifestPath: `atlas/fantasy/layered-ground/${sha256}/manifest.json`, sha256, size: bytes.length} };
}
async function publish(rows, put, tier = 'optional') {
  const seen = new Set();
  for (const row of rows) {
    for (const asset of row.verified.rows) if (!seen.has(asset.asset.path)) {
      await put(asset.asset.path, asset.bytes, tier); seen.add(asset.asset.path);
    }
    await put(row.descriptor.manifestPath, row.bytes, tier);
  }
}
export async function buildLayeredGroundSection({source, previewManifest, readFile, put, verifySources, groundRevision}) {
  if (!previewManifest) return undefined;
  const row = await prepare({source, filename: previewManifest, readFile, verifySources, status: 'preview-only', groundRevision});
  await publish([row], put);
  return {version: 1, status: 'preview-only', ...row.descriptor, manifest: row.verified.manifest};
}
/** Empty registry is intentional until final art QA. Verify every source before
 * writing any optional pack file, so a later bad realm cannot partially publish. */
export async function buildAcceptedLayeredGroundSection({source, registry, readFile, put, verifySources, pinnedCatalogue, groundRevision}) {
  // Revision 5 (scripts/src/layered-ground.ts RealmKitRegistry) carries no root status: each row states its own, and a
  // `preview-only` row is the owner's review material, skipped before any verify or write, exactly as the source publisher does.
  const perRowStatus = groundRevision === 5;
  if (!registry || registry.schemaVersion !== 1 || (!perRowStatus && registry.status !== 'accepted') || !Array.isArray(registry.manifests)) throw new Error('Invalid accepted layered registry');
  if (registry.manifests.length > REALMS.size || new Set(registry.manifests.map(r => r.realmId)).size !== registry.manifests.length) throw new Error('Duplicate layered realm');
  const rows = [];
  for (const r of registry.manifests) {
    if (!REALMS.has(r.realmId) || typeof r.manifest !== 'string' || path.isAbsolute(r.manifest)) throw new Error('Invalid accepted layered realm');
    if (perRowStatus) {
      if (r.status !== 'accepted' && r.status !== 'preview-only') throw new Error('Invalid realm kit registry status');
      if (r.status === 'preview-only') continue;
    }
    rows.push(await prepare({source, filename: path.join(source, r.manifest), readFile, verifySources, status: 'accepted', realmId: r.realmId, groundRevision}));
  }
  if (pinnedCatalogue) {
    if (rows.length !== Object.keys(pinnedCatalogue).length || rows.some(r => JSON.stringify(r.descriptor) !== JSON.stringify(pinnedCatalogue[r.descriptor.realmId]))) throw new Error('Accepted layered descriptors must match frozen source catalogue');
  }
  if (!rows.length) return undefined;
  // Ground belongs to the installed pack; only the active realm is decoded/GPU-resident.
  await publish(rows, put, 'core');
  return {version: 1, status: 'accepted', manifests: rows.map(r => r.descriptor)};
}
/** Revision-5 manifests (schemaVersion 3) verify with the realm-kit validator, which lives beside the layered
 * publisher in scripts/src/layered-ground.ts (scripts/src/realm-kit.ts is the kit builder and exports no verifier).
 * The r3/r4 validator rejects every revision-5 manifest, so it can never stand in for the kit validator. */
export const realmKitVerifier = (load) => async (...values) => (await load('scripts/src/layered-ground.ts')).verifyRealmKitSources(...values);
