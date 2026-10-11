/** Build the accepted immutable fantasy pack into the existing SHA-versioned
 * atlas inventory. These PNGs stay standalone and lazy; they never join the
 * eager Phaser atlas set. Validate every source before publishing any bytes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { publishAcceptedLayeredGround, pinAcceptedLayeredGround } from './layered-ground.js';
import { BASE_GROUND_ART, BASE_GROUND_ART_V2, BASE_GROUND_ART_V3, BASE_GROUND_ART_V4, baseGroundTransport, REALM_IDS } from '../../packages/shared/src/baseVisual.js';

export const FANTASY_ART_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export interface FantasyArtFile { path: string; sha256: string; width: number; height: number; id?: string; sourceSha256?: string }
export interface FantasyArtManifest { files: FantasyArtFile[]; [key: string]: unknown }

export async function validateFantasyArt(
  sourceDir: string, manifest: FantasyArtManifest,
): Promise<Array<{ file: FantasyArtFile; bytes: Buffer }>> {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Fantasy art inventory is empty');
  const paths = new Set<string>(), canonical = await fs.realpath(sourceDir);
  const result: Array<{ file: FantasyArtFile; bytes: Buffer }> = [];
  for (const file of manifest.files) {
    if (!/^(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:png|webp)$/.test(file.path)
      || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
      || ![file.width, file.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096)) {
      throw new Error(`Invalid fantasy art inventory entry: ${file.path}`);
    }
    paths.add(file.path);
    const filename = path.join(sourceDir, file.path);
    if (!(await fs.realpath(filename)).startsWith(canonical + path.sep)) throw new Error('Fantasy source escapes its immutable pack');
    const bytes = await fs.readFile(filename);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Fantasy source hash mismatch: ${file.path}`);
    const meta = await sharp(bytes).metadata();
    if (meta.format !== (file.path.endsWith('.webp') ? 'webp' : 'png') || meta.width !== file.width || meta.height !== file.height) throw new Error(`Fantasy source dimensions mismatch: ${file.path}`);
    result.push({ file, bytes });
  }
  return result;
}

/** Lossless representation changes must never alter a frozen pixel, including
 * alpha. Copy pinned derivatives instead of regenerating platform-specific bytes. */
export async function assertGroundTransportParity(source: Buffer, transport: Buffer): Promise<void> {
  const [original, decoded] = await Promise.all([
    sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(transport).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (original.info.width !== decoded.info.width || original.info.height !== decoded.info.height
    || !original.data.equals(decoded.data)) throw new Error('Ground transport changes decoded RGBA pixels');
}

export async function validateGroundTransports(root = FANTASY_ART_ROOT): Promise<{
  manifest: FantasyArtManifest; rows: Array<{ file: FantasyArtFile; bytes: Buffer }>;
}> {
  return validateGroundTransportSet(root, undefined);
}

export async function validateClearingTransports(root = FANTASY_ART_ROOT) {
  return validateGroundTransportSet(root, 2);
}

async function validateGroundTransportSet(root: string, groundRevision: 2 | undefined): Promise<{
  manifest: FantasyArtManifest; rows: Array<{ file: FantasyArtFile; bytes: Buffer }>;
}> {
  const sourceDir = path.join(root, groundRevision === 2 ? 'art/fantasy-ground-v4/transport' : 'art/fantasy-ground-transport-v1');
  const group = groundRevision === 2 ? 'ground-v4' : 'ground-v2';
  const contract = groundRevision === 2 ? BASE_GROUND_ART_V4 : BASE_GROUND_ART_V2;
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, 'manifest.json'), 'utf8')) as FantasyArtManifest;
  if (manifest.files.length !== REALM_IDS.length) throw new Error('Ground transport inventory changed');
  const rows = await validateFantasyArt(sourceDir, manifest);
  for (const realm of REALM_IDS) {
    const row = rows.find(entry => entry.file.path === `${group}/${realm}.webp`);
    const descriptor = baseGroundTransport({ version: 1, realmId: realm, artVersion: 2, groundRevision });
    const sourceHash = contract.sources[realm].sha256;
    if (!row || row.file.id !== realm || row.file.sha256 !== descriptor.sha256
      || row.file.sourceSha256 !== sourceHash || row.file.width !== contract.sourceSize
      || row.file.height !== contract.sourceSize) throw new Error(`Ground transport contract changed: ${realm}`);
    const original = await fs.readFile(path.join(root, `art/fantasy-${group}/ground`, `${realm}.png`));
    if (createHash('sha256').update(original).digest('hex') !== sourceHash) throw new Error(`Ground source changed: ${realm}`);
    await assertGroundTransportParity(original, row.bytes);
  }
  return { manifest, rows };
}

export async function buildFantasyArt(root = FANTASY_ART_ROOT): Promise<{ files: number; bytes: number }> {
  // Vite copies the entire public tree, not only the offline-pack inventory.
  // Refuse stale study output before any write; cleanup belongs to the caller's
  // owned generated tree, never an immutable source or retained release.
  try {
    await fs.lstat(path.join(root, 'apps/web/public/atlas/fantasy/ground-v4'));
    throw new Error('Rejected revision2 study output remains in public/atlas/fantasy/ground-v4; remove it from the owned generated tree before publication');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const sets = await Promise.all(['ground', 'ground-v2', 'ground-v3', 'globe'].map(async group => {
    const sourceDir = group === 'ground-v2' || group === 'ground-v3'
      ? path.join(root, `art/fantasy-${group}/ground`)
      : path.join(root, 'art/fantasy-world-v1', group);
    const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, 'manifest.json'), 'utf8')) as FantasyArtManifest;
    if (group !== 'globe') {
      const contract = group === 'ground-v3' ? BASE_GROUND_ART_V3 : group === 'ground-v2' ? BASE_GROUND_ART_V2 : BASE_GROUND_ART;
      const realms = group === 'ground-v3' ? ['crownlands'] as const : REALM_IDS;
      if (manifest.files.length !== realms.length) throw new Error('Fantasy ground inventory changed');
      for (const realm of realms) {
        const file = manifest.files.find(row => row.path === `${realm}.png`);
        if (!file || file.id !== realm || file.sha256 !== contract.sources[realm].sha256
          || file.width !== contract.sourceSize || file.height !== contract.sourceSize) {
          throw new Error(`Fantasy ground contract changed: ${realm}`);
        }
      }
    }
    return { group, manifest, rows: await validateFantasyArt(sourceDir, manifest) };
  }));
  const transports = await validateGroundTransports(root);
  let files = 0, bytes = 0;
  for (const set of sets) {
    const target = path.join(root, 'apps/web/public/atlas/fantasy', set.group);
    for (const row of set.rows) {
      const filename = path.join(target, row.file.path);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, row.bytes);
      files++; bytes += row.bytes.length;
    }
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(set.manifest, null, 2) + '\n');
  }
  const target = path.join(root, 'apps/web/public/atlas/fantasy');
  for (const row of transports.rows) {
    const filename = path.join(target, row.file.path);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, row.bytes);
    files++; bytes += row.bytes.length;
  }
  await fs.writeFile(path.join(target, 'transport-manifest.json'), JSON.stringify(transports.manifest, null, 2) + '\n');
  // Revision 5 (realm kit) publishes only `accepted` registry rows; a missing registry or
  // preview-only rows are inert, so kit work in review never breaks the asset build.
  const layered = [...await publishAcceptedLayeredGround(root), ...await publishAcceptedLayeredGround(root, undefined, 4), ...await publishAcceptedLayeredGround(root, undefined, 5)];
  for (const realm of layered) { files += realm.files.length; bytes += realm.files.reduce((sum, asset) => sum + asset.size, 0); }
  return { files, bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--pin-layered') || process.argv.includes('--pin-layered-r4') || process.argv.includes('--pin-layered-r5')) {
    const rows = await pinAcceptedLayeredGround(FANTASY_ART_ROOT, undefined, process.argv.includes('--pin-layered-r5') ? 5 : process.argv.includes('--pin-layered-r4') ? 4 : 3);
    console.log(`Pinned ${rows.length} immutable layered realm descriptors; rerun the asset build to publish.`);
  } else {
    const result = await buildFantasyArt();
    console.log(`Fantasy art: ${result.files} verified images / ${result.bytes} bytes`);
  }
}
