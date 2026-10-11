/**
 * Deploy preflight: every layered-ground manifest pinned in the shared catalogue
 * (revisions 3, 4 and 5) must exist under apps/web/public with the pinned size
 * and sha256. The API reads them from disk at runtime inside its image
 * (apps/api/src/game/kitObstacles.ts, the deed renderer), so a publish miss
 * turns into a 500 on every base of that realm the day its revision flips —
 * exactly what the QA candidate did on 2026-09-25 when its image was built from
 * atlases generated before the pin. `pnpm assets` must have run first.
 * The same renderer then opens every assets[] entry of that manifest and checks
 * its size and sha256 (apps/api/src/game/baseRender.ts), so a published manifest
 * whose artwork is missing or altered fails the same way; each one is checked too.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BASE_LAYERED_GROUND_V3, BASE_LAYERED_GROUND_V4, BASE_LAYERED_GROUND_V5, type LayeredGroundDescriptor } from '../../packages/shared/src/layeredGroundCatalogue.js';

export type PublishedGroundCatalogues = Readonly<Record<string, Readonly<Partial<Record<string, LayeredGroundDescriptor>>>>>;
export const PINNED_GROUND_CATALOGUES: PublishedGroundCatalogues = Object.freeze({
  revision3: BASE_LAYERED_GROUND_V3, revision4: BASE_LAYERED_GROUND_V4, revision5: BASE_LAYERED_GROUND_V5,
});

export interface PublishedGroundReport { checked: number; perCatalogue: Record<string, number>; problems: string[] }

/** Pure check; never throws on a bad file, every problem is one line naming the catalogue, realm and path. */
export async function verifyPublishedGround(publicRoot: string, catalogues: PublishedGroundCatalogues = PINNED_GROUND_CATALOGUES): Promise<PublishedGroundReport> {
  const report: PublishedGroundReport = { checked: 0, perCatalogue: {}, problems: [] };
  for (const [name, catalogue] of Object.entries(catalogues)) {
    report.perCatalogue[name] = 0;
    for (const [realmId, descriptor] of Object.entries(catalogue)) {
      if (!descriptor) continue;
      report.checked += 1; report.perCatalogue[name] += 1;
      const file = path.join(publicRoot, descriptor.manifestPath);
      let bytes: Buffer;
      try { bytes = await readFile(file); } catch { report.problems.push(`${name} ${realmId}: missing ${descriptor.manifestPath}`); continue; }
      if (bytes.length !== descriptor.size) { report.problems.push(`${name} ${realmId}: size ${bytes.length} != pinned ${descriptor.size} (${descriptor.manifestPath})`); continue; }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== descriptor.sha256) { report.problems.push(`${name} ${realmId}: sha256 ${sha256.slice(0, 12)}… != pinned ${descriptor.sha256.slice(0, 12)}… (${descriptor.manifestPath})`); continue; }
      report.problems.push(...await verifyManifestAssets(publicRoot, bytes, `${name} ${realmId}`, descriptor.manifestPath));
    }
  }
  return report;
}

/** Asset paths are relative to the same public root as manifestPath
 * (hash-addressed atlas/fantasy/layered-ground/assets/<sha256>.png|webp). */
async function verifyManifestAssets(publicRoot: string, manifestBytes: Buffer, label: string, manifestPath: string): Promise<string[]> {
  let assets: unknown;
  try { assets = (JSON.parse(manifestBytes.toString('utf8')) as { assets?: unknown }).assets; }
  catch { return [`${label}: manifest is not valid JSON (${manifestPath})`]; }
  if (!Array.isArray(assets) || assets.length === 0) return [`${label}: manifest lists no assets (${manifestPath})`];
  const problems: string[] = [];
  for (const asset of assets as Array<{ path?: unknown; size?: unknown; sha256?: unknown }>) {
    const { path: assetPath, size, sha256: pinned } = asset ?? {};
    if (typeof assetPath !== 'string' || typeof size !== 'number' || typeof pinned !== 'string') {
      problems.push(`${label}: manifest has an asset without path, size and sha256 (${manifestPath})`); continue;
    }
    let bytes: Buffer;
    try { bytes = await readFile(path.join(publicRoot, assetPath)); } catch { problems.push(`${label}: missing asset ${assetPath} (${manifestPath})`); continue; }
    if (bytes.length !== size) { problems.push(`${label}: asset size ${bytes.length} != pinned ${size} (${assetPath})`); continue; }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== pinned) problems.push(`${label}: asset sha256 ${sha256.slice(0, 12)}… != pinned ${pinned.slice(0, 12)}… (${assetPath})`);
  }
  return problems;
}

/** `pnpm --filter … run` executes in scripts/, so a relative argument resolves against
 * pnpm's INIT_CWD (the invoking directory); no argument means this repo's apps/web/public. */
export function resolvePublicRoot(argument: string | undefined, initCwd: string | undefined, cwd: string): string {
  if (argument === undefined) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps', 'web', 'public');
  return path.resolve(initCwd ?? cwd, argument);
}

async function main(argv: string[]): Promise<number> {
  const publicRoot = resolvePublicRoot(argv[0], process.env['INIT_CWD'], process.cwd());
  const report = await verifyPublishedGround(publicRoot);
  const summary = Object.entries(report.perCatalogue).map(([name, count]) => `${name} ${count}`).join(', ');
  if (report.problems.length) {
    console.error(`published ground: ${report.problems.length} problem(s) under ${publicRoot} (${summary})`);
    for (const problem of report.problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`published ground: ${report.checked} pinned manifest(s) verified under ${publicRoot} (${summary})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
