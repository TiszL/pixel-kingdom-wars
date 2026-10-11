/** Writes the revision-5 realm-kit parity fixture the native lane pins Kotlin
 * against (docs/REALM-KIT-PLAN.md §2, the layered-ground probe precedent): the
 * synthetic manifest from packages/shared, its ~600 (claim, tile) cell probes,
 * and PNG sheets of the synthetic pixels. The manifest's sha256/size/path are
 * stamped from the encoded bytes, so the file is one self-consistent kit the
 * native admission path (hash + alpha checks) can load verbatim. Test-only data:
 * never published, never an art master, never a default selector. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { assertRealmKitAssetPixels, assertRealmKitManifest, type RealmKitManifest } from '../../packages/shared/src/realmKit.js';
import { realmKitFixture, realmKitFixturePixels, realmKitObstacleProbeFixture, realmKitPathProbeFixture, realmKitProbeFixture, realmKitPropProbeFixture,
  type RealmKitObstacleProbeFixture, type RealmKitPathProbeSample, type RealmKitProbeSample, type RealmKitPropProbeSample } from '../../packages/shared/src/realmKit.fixture.js';

export const REALM_KIT_FIXTURE_FILE = 'realm-kit-fixture.json';
export interface RealmKitFixtureFile {
  schemaVersion: 1;
  manifest: RealmKitManifest;
  probes: RealmKitProbeSample[];
  /** E-6 amended: which placements each claim leaves visible (realmKitPlacementHidden), manifest order. */
  propProbes: RealmKitPropProbeSample[];
  /** E-11 expansion obstacles: the kind each placement becomes and the sprite each row draws (realmKitObstacles.ts). */
  obstacleProbes: RealmKitObstacleProbeFixture;
  /** D-173 creature paths: every path's pose, sheet cell and facing at a spread of clocks, and the
   * ground band order (props + creatures) under the 14-tile claim (realmKitPathPlan / realmKitGroundBandPlan). */
  pathProbes: RealmKitPathProbeSample[];
  /** base64 PNG of the tileset (`manifest.ground.cells[0].asset`): flat colour per cell, the bed cell a hole. */
  tileset: string;
  /** base64 PNG of the prop sheet the animated placement draws from (§7 frame/clip cells). */
  props: string;
  /** base64 PNG per asset id, every asset the manifest names. */
  assets: Record<string, string>;
}
export async function realmKitFixtureFile(): Promise<RealmKitFixtureFile> {
  const manifest = realmKitFixture(), pixels = realmKitFixturePixels(manifest), assets: Record<string, string> = {};
  for (const a of manifest.assets) {
    const p = pixels.get(a.id);
    if (!p) throw new Error(`Fixture pixels missing for ${a.id}`);
    assertRealmKitAssetPixels(manifest, a, p);
    const png = await sharp(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength), { raw: { width: p.width, height: p.height, channels: 4 } })
      .png({ palette: false, compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
    a.sha256 = createHash('sha256').update(png).digest('hex'); a.size = png.length; a.path = `atlas/fantasy/layered-ground/assets/${a.sha256}.png`;
    assets[a.id] = png.toString('base64');
  }
  assertRealmKitManifest(manifest);
  const animated = manifest.placements.find(p => p.clip);
  if (!animated) throw new Error('Fixture has no animated placement');
  return { schemaVersion: 1, manifest, probes: realmKitProbeFixture(manifest), propProbes: realmKitPropProbeFixture(manifest),
    obstacleProbes: realmKitObstacleProbeFixture(manifest), pathProbes: realmKitPathProbeFixture(manifest),
    tileset: assets[manifest.ground.cells[0]!.asset]!, props: assets[animated.asset]!, assets };
}
export async function writeRealmKitFixture(outDir: string): Promise<string> {
  const value = await realmKitFixtureFile(), file = path.join(outDir, REALM_KIT_FIXTURE_FILE);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value) + '\n');
  return file;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const outDir = process.argv[2];
  if (outDir === undefined || process.argv.length !== 3) {
    console.error('usage: tsx scripts/src/realm-kit-fixture.ts <out-dir>');
    process.exitCode = 2;
  } else {
    console.log(await writeRealmKitFixture(outDir));
  }
}
