#!/usr/bin/env node
// Candidate contract 17 (N-C5-ART): extend an existing renderer16 cosmetics candidate
// with the authored fleet-journey art from a generated web source.
//
//   node tools/extend-fleet-pack.mjs --pack client-packs/candidate-<sha>-sim18-r16-cosmetics \
//     --fleet-source /path/to/SHARDKEEP --out client-packs/candidate-<sha>-sim18-r17-fleet
//
// The base pack's files are carried byte-identical (hard-linked when possible, copied
// otherwise) with their original pins — service graph, bound cosmetics and every other
// section survive unchanged; ONLY these are added:
//   atlas/pe_fleet_starter@1x.json / .png and the 20 advanced groups   (optional tier, exact pins)
//   atlas/pe_fleet_starter.manifest.json, atlas/pe_advanced_fleet.manifest.json (optional; sidecars verbatim)
//   render-catalog.json: rendererContractVersion 17 + ONE `fleetJourneys` block
//   manifest.json: rendererContractVersion 17, new contentVersion
// Nothing is activated, pinned, published or written into client-pack.lock.json; the
// output is a candidate directory that must not already exist. Pack GENERATION is not
// authorized in the N-C5-ART source scope: this CLI exists, it has not been run.
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, link, copyFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { sha256, manifestVersion, recordPackFile, verifyPack } from './pack.mjs';
import { assertServiceOptionalFiles } from './service-catalog.mjs';
import { COSMETICS_CONTRACT_VERSION } from './extend-cosmetics-pack.mjs';
import { buildFleetCatalogue, fleetGroupIds } from './fleet-catalog.mjs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return path.resolve(args[i + 1]); };

/** Private candidate identity: renderer16 (service graph + bound cosmetics) plus fleet journeys. */
export const FLEET_CONTRACT_VERSION = 17;
const serial = (data) => JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';
const sameProvenance = (a, b) => ['sourceManifestSha256', 'sourceIndexSha256', 'sourceTracksSha256'].every(key => typeof a?.[key] === 'string' && a[key] === b?.[key]);

/** Pure planning step (unit-tested): the extended render catalogue for a renderer16 candidate.
 *  Every base section — including `phaseE` and `boundCosmetics` — is carried unchanged; only the
 *  contract version changes and ONE additive `fleetJourneys` block records its own source. */
export function extendFleetCatalogue({ baseManifest, baseRenderCatalogue, fleet, fleetSource }) {
  if (baseManifest.rendererContractVersion !== COSMETICS_CONTRACT_VERSION || baseRenderCatalogue.rendererContractVersion !== COSMETICS_CONTRACT_VERSION) throw new Error('Only a renderer16 cosmetics candidate can be extended');
  if (!baseRenderCatalogue.phaseE || !Array.isArray(baseRenderCatalogue.phaseE.groups)) throw new Error('Base pack carries no service graph');
  if (!baseRenderCatalogue.boundCosmetics || !Array.isArray(baseRenderCatalogue.boundCosmetics.groups)) throw new Error('Base pack carries no bound cosmetics');
  if ('fleetJourneys' in baseRenderCatalogue) throw new Error('Base pack already carries fleet journeys');
  if (!fleet || fleet.version !== 1 || !Array.isArray(fleet.groups) || !fleet.metadata?.peStarterFleet || !fleet.metadata?.peAdvancedFleet) throw new Error('Fleet catalogue is required');
  const ids = fleet.groups.map(group => group.id);
  if (JSON.stringify([...ids].sort()) !== JSON.stringify(fleetGroupIds()) || new Set(ids).size !== ids.length) throw new Error('Fleet catalogue must pin exactly the 1 + 20 fleet groups');
  const taken = new Set([...baseRenderCatalogue.phaseE.groups, ...baseRenderCatalogue.boundCosmetics.groups].map(group => group.id));
  for (const id of ids) if (taken.has(id)) throw new Error(`Base pack already names group ${id}`);
  if (!sameProvenance(fleet.metadata.peStarterFleet, fleet.metadata.peAdvancedFleet)) throw new Error('Starter and advanced fleet tables come from different sources');
  if (!/^[a-f0-9]{40}$/.test(fleetSource)) throw new Error('Fleet source commit must be a full SHA');
  return { ...baseRenderCatalogue, rendererContractVersion: FLEET_CONTRACT_VERSION,
    fleetJourneys: { ...fleet, sourceCommit: fleetSource, basePack: { sourceCommit: baseManifest.sourceCommit, contentVersion: baseManifest.contentVersion } } };
}

/** Refuse ANY existing filesystem entry at `output` — a file, an EMPTY directory, a symlink (even dangling) — not
 *  just an output that already holds a manifest. Checked before any work and again at the publication boundary. */
export async function refuseExistingOutput(output) {
  try { await lstat(output); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output pack already exists');
}
/** Claim a FRESH, exclusively owned staging directory beside `output` (a unique new sibling created by mkdtemp; an
 *  existing directory or symlink at any predictable name is never reused, entered or deleted). Ownership exists only
 *  once this resolves; the caller cleans exactly this path and nothing else. */
export async function claimStage(output) {
  await mkdir(path.dirname(output), { recursive: true });
  return mkdtemp(`${output}.stage-`);
}
/** The staged path for a pack-relative file, refusing anything that would leave the owned stage. */
export function withinStage(stage, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error(`Path escapes the staging directory: ${relative}`);
  const target = path.resolve(stage, relative);
  if (!target.startsWith(path.resolve(stage) + path.sep)) throw new Error(`Path escapes the staging directory: ${relative}`);
  return target;
}

async function main() {
  const basePack = arg('--pack'), source = arg('--fleet-source'), output = arg('--out');
  const loaded = await loadSource(source);
  const baseManifest = await verifyPack(basePack);
  const baseRenderCatalogue = JSON.parse(await readFile(path.join(basePack, 'render-catalog.json'), 'utf8'));
  const sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publicRoot = path.join(source, 'apps/web/public');
  const meta = JSON.parse(await readFile(path.join(publicRoot, 'atlas/meta.json'), 'utf8'));
  const starterBytes = await readFile(path.join(publicRoot, 'atlas/pe_fleet_starter.manifest.json'));
  const advancedBytes = await readFile(path.join(publicRoot, 'atlas/pe_advanced_fleet.manifest.json'));
  const assets = new Map();
  for (const id of fleetGroupIds()) for (const ext of ['json', 'png']) assets.set(`atlas/${id}@1x.${ext}`, await readFile(path.join(publicRoot, 'atlas', `${id}@1x.${ext}`)));
  const sharp = createRequire(path.join(source, 'scripts/package.json'))('sharp');
  const fleet = await buildFleetCatalogue({ starterSidecar: JSON.parse(starterBytes.toString('utf8')), advancedSidecar: JSON.parse(advancedBytes.toString('utf8')), meta,
    parseStarterFleetMetadata: loaded.parseStarterFleetMetadata, parseAdvancedFleetMetadata: loaded.parseAdvancedFleetMetadata, atlasGroupFor: loaded.atlasGroupFor, assets,
    inspectPng: (bytes) => sharp(bytes, { limitInputPixels: 4096 * 4096, sequentialRead: true, failOn: 'warning' }).metadata() });
  const renderCatalogue = extendFleetCatalogue({ baseManifest, baseRenderCatalogue, fleet, fleetSource: sourceCommit });

  await refuseExistingOutput(output);
  let stage = null; // owned only once claimStage resolves; null again once published
  const files = [];
  const stageFile = async (relative, bytes, tier) => {
    const entry = { path: relative, sha256: sha256(bytes), size: Buffer.byteLength(bytes), tier };
    if (recordPackFile(files, entry) !== entry) return;
    const target = withinStage(stage, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  try {
    stage = await claimStage(output);
    for (const file of baseManifest.files) {
      if (file.path === 'render-catalog.json') continue;
      const from = path.join(basePack, file.path), to = withinStage(stage, file.path);
      await mkdir(path.dirname(to), { recursive: true });
      try { await link(from, to); } catch { await copyFile(from, to); }
      if ((await lstat(to)).size !== file.size) throw new Error(`Base file size changed: ${file.path}`);
      recordPackFile(files, { path: file.path, sha256: file.sha256, size: file.size, tier: file.tier });
    }
    await stageFile('render-catalog.json', serial(renderCatalogue), 'core');
    for (const [relative, bytes] of assets) await stageFile(relative, bytes, 'optional');
    await stageFile('atlas/pe_fleet_starter.manifest.json', starterBytes, 'optional');
    await stageFile('atlas/pe_advanced_fleet.manifest.json', advancedBytes, 'optional');
    assertServiceOptionalFiles(baseRenderCatalogue.phaseE, files);
    assertServiceOptionalFiles(baseRenderCatalogue.boundCosmetics, files);
    assertServiceOptionalFiles(fleet, files);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = { ...baseManifest, rendererContractVersion: FLEET_CONTRACT_VERSION, files };
    delete manifest.contentVersion;
    manifest.contentVersion = manifestVersion(manifest);
    await writeFile(withinStage(stage, 'manifest.json'), serial(manifest));
    await refuseExistingOutput(output); // again at the publication boundary
    await rename(stage, output); stage = null; // published: nothing left to clean
    await verifyPack(output);
    console.log(`Extended ${baseManifest.files.length} base files with ${files.length - baseManifest.files.length} fleet files; ` +
      `fleet source ${sourceCommit}; candidate ${manifest.contentVersion} (renderer ${FLEET_CONTRACT_VERSION}, NOT activated)`);
  } finally { if (stage) await rm(stage, { recursive: true, force: true }); } // ONLY the stage this run created
}

async function loadSource(source) {
  // The canonical web parsers and the shared grouping rule, loaded through the source's own TS loader
  // (extend-cosmetics-pack precedent): the same code the web client admits the authored tables with.
  const { pathToFileURL } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  if (!process.env.PKW_EXPORT_TS_LOADER) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(source, 'scripts/node_modules/tsx/dist/loader.mjs')).href,
      new URL(import.meta.url).pathname, ...args], { stdio: 'inherit', env: { ...process.env, PKW_EXPORT_TS_LOADER: '1' } });
    process.exit(result.status ?? 1);
  }
  const atlas = await import(pathToFileURL(path.join(source, 'packages/shared/src/atlas.ts')).href);
  const starter = await import(pathToFileURL(path.join(source, 'apps/web/src/game/world/fleetArt.ts')).href);
  const advanced = await import(pathToFileURL(path.join(source, 'apps/web/src/game/world/advancedFleetArt.ts')).href);
  return { atlasGroupFor: atlas.atlasGroupFor, parseStarterFleetMetadata: starter.parseStarterFleetMetadata, parseAdvancedFleetMetadata: advanced.parseAdvancedFleetMetadata };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => { console.error(error.message ?? error); process.exit(1); });
}
