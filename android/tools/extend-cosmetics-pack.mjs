#!/usr/bin/env node
// Candidate contract 16: extend an existing renderer15 service pack with the
// bound-cosmetics (Artisan Market Awning) group from a generated web source.
//
//   node tools/extend-cosmetics-pack.mjs --pack client-packs/canonical-<sha>-sim18-r15 \
//     --cosmetics-source /path/to/SHARDKEEP --out client-packs/candidate-<sha>-sim18-r16-cosmetics
//
// The base pack's files are carried byte-identical (hard-linked when possible,
// copied otherwise) with their original pins; ONLY these are added:
//   atlas/pe_cosmetics@1x.json / .png            (optional tier, exact pins)
//   atlas/pe_cosmetics.manifest.json             (optional; the generated table verbatim)
//   render-catalog.json: rendererContractVersion 16 + `boundCosmetics` block
//   manifest.json: rendererContractVersion 16, new contentVersion
// Nothing is activated, pinned, published or written into client-pack.lock.json;
// the output is a candidate directory that must not already exist. The pack's
// service graph (peClips/peAppearances) and every other file stay as exported
// from the pack's own source commit; the extension records its own source.
import { mkdir, readFile, readdir, rename, rm, writeFile, link, copyFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { sha256, manifestVersion, recordPackFile, verifyPack } from './pack.mjs';
import { buildCosmeticCatalogue, assertServiceOptionalFiles } from './service-catalog.mjs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw new Error(`Missing ${name}`); return path.resolve(args[i + 1]); };

export const COSMETICS_CONTRACT_VERSION = 16;
const serial = (data) => JSON.stringify(data, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n';

/** Pure planning step (unit-tested): the extended render catalogue + manifest for a base pack. */
/** The admitted constants slice the extension carries VERBATIM from the cosmetics source:
 *  the bound-cosmetics table itself and the queue limit the shared Workshop API applies
 *  (`PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase`, the value boundCosmeticWorkshopApi.ts
 *  caps the queue with). No native literal ever stands in for either. */
export function cosmeticConstants(constants) {
  const table = constants.PHASE_E_BOUND_COSMETICS, queue = constants.PHASE_E_ORDINARY_CRAFTING?.v1?.maxConcurrentPerBase;
  if (!table || typeof table !== 'object' || table.currentRecipeVersion !== 1 || !table.v1?.recipes) throw new Error('PHASE_E_BOUND_COSMETICS is missing from the cosmetics source');
  for (const id of ['craft_artisan_market_awning_t1_v1', 'craft_artisan_market_awning_t2_v1', 'craft_artisan_market_awning_t3_v1', 'craft_artisan_market_awning_t4_v1']) {
    if (table.v1.recipes[id]?.facility !== 'market') throw new Error(`Awning recipe ${id} is not a Market recipe in the cosmetics source`);
  }
  if (!Number.isSafeInteger(queue) || queue < 1) throw new Error('PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase is missing from the cosmetics source');
  return { PHASE_E_BOUND_COSMETICS: structuredClone(table), queue: { maxConcurrentPerBase: queue, source: 'PHASE_E_ORDINARY_CRAFTING.v1.maxConcurrentPerBase' } };
}

export function extendCatalogue({ baseManifest, baseRenderCatalogue, cosmetics, cosmeticsSource, constants }) {
  if (baseManifest.rendererContractVersion !== 15 || baseRenderCatalogue.rendererContractVersion !== 15) throw new Error('Only a renderer15 service pack can be extended');
  if (!baseRenderCatalogue.phaseE || !Array.isArray(baseRenderCatalogue.phaseE.groups)) throw new Error('Base pack carries no service graph');
  if ('boundCosmetics' in baseRenderCatalogue) throw new Error('Base pack already carries bound cosmetics');
  if (baseRenderCatalogue.phaseE.groups.some((group) => group.id === 'pe_cosmetics')) throw new Error('Base service graph already names pe_cosmetics');
  if (!/^[a-f0-9]{40}$/.test(cosmeticsSource)) throw new Error('Cosmetics source commit must be a full SHA');
  if (!constants?.queue?.maxConcurrentPerBase || !constants.PHASE_E_BOUND_COSMETICS) throw new Error('Cosmetics constants slice is required');
  const renderCatalogue = { ...baseRenderCatalogue, rendererContractVersion: COSMETICS_CONTRACT_VERSION,
    boundCosmetics: { ...cosmetics, constants, sourceCommit: cosmeticsSource, basePack: { sourceCommit: baseManifest.sourceCommit, contentVersion: baseManifest.contentVersion } } };
  return renderCatalogue;
}

async function main() {
  const basePack = arg('--pack'), source = arg('--cosmetics-source'), output = arg('--out');
  const shared = await loadShared(source);
  const baseManifest = await verifyPack(basePack);
  const baseRenderCatalogue = JSON.parse(await readFile(path.join(basePack, 'render-catalog.json'), 'utf8'));
  const sourceCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publicRoot = path.join(source, 'apps/web/public');
  const meta = JSON.parse(await readFile(path.join(publicRoot, 'atlas/meta.json'), 'utf8'));
  const assets = new Map();
  for (const name of ['pe_cosmetics@1x.json', 'pe_cosmetics@1x.png']) assets.set(`atlas/${name}`, await readFile(path.join(publicRoot, 'atlas', name)));
  const sidecar = await readFile(path.join(publicRoot, 'atlas/pe_cosmetics.manifest.json'));
  if (JSON.stringify(JSON.parse(sidecar.toString('utf8'))) !== JSON.stringify(meta.peCosmetics)) throw new Error('pe_cosmetics.manifest.json differs from meta.peCosmetics');
  const sharp = createRequire(path.join(source, 'scripts/package.json'))('sharp');
  const cosmetics = await buildCosmeticCatalogue({ meta, atlasGroupFor: shared.atlasGroupFor, assets,
    inspectPng: (bytes) => sharp(bytes, { limitInputPixels: 4096 * 4096, sequentialRead: true, failOn: 'warning' }).metadata() });
  const renderCatalogue = extendCatalogue({ baseManifest, baseRenderCatalogue, cosmetics, cosmeticsSource: sourceCommit, constants: cosmeticConstants(shared.constants) });

  const stage = `${output}.stage-${process.pid}`;
  await mkdir(stage, { recursive: true });
  const files = [];
  const stageFile = async (relative, bytes, tier) => {
    const entry = { path: relative, sha256: sha256(bytes), size: Buffer.byteLength(bytes), tier };
    if (recordPackFile(files, entry) !== entry) return;
    await mkdir(path.dirname(path.join(stage, relative)), { recursive: true });
    await writeFile(path.join(stage, relative), bytes);
  };
  try {
    // Base files: identical bytes under identical pins (hard link, else copy), except the two rewritten metadata files.
    for (const file of baseManifest.files) {
      if (file.path === 'render-catalog.json') continue;
      const from = path.join(basePack, file.path), to = path.join(stage, file.path);
      await mkdir(path.dirname(to), { recursive: true });
      try { await link(from, to); } catch { await copyFile(from, to); }
      if ((await lstat(to)).size !== file.size) throw new Error(`Base file size changed: ${file.path}`);
      recordPackFile(files, { path: file.path, sha256: file.sha256, size: file.size, tier: file.tier });
    }
    await stageFile('render-catalog.json', serial(renderCatalogue), 'core');
    for (const [relative, bytes] of assets) await stageFile(relative, bytes, 'optional');
    await stageFile('atlas/pe_cosmetics.manifest.json', sidecar, 'optional');
    assertServiceOptionalFiles(baseRenderCatalogue.phaseE, files);
    assertServiceOptionalFiles(cosmetics, files);
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const manifest = { ...baseManifest, rendererContractVersion: COSMETICS_CONTRACT_VERSION, files };
    delete manifest.contentVersion;
    manifest.contentVersion = manifestVersion(manifest);
    await writeFile(path.join(stage, 'manifest.json'), serial(manifest));
    try { await readFile(path.join(output, 'manifest.json')); throw new Error('Output pack already exists'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await rename(stage, output);
    await verifyPack(output);
    console.log(`Extended ${baseManifest.files.length} base files with ${files.length - baseManifest.files.length} cosmetic files; ` +
      `cosmetics source ${sourceCommit}; candidate ${manifest.contentVersion} (renderer ${COSMETICS_CONTRACT_VERSION}, NOT activated)`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function loadShared(source) {
  // The shared grouping rule decides which packed group a cosmetic key belongs to
  // (the same rule the web packer used); loaded through the source's own TS loader.
  const { pathToFileURL } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  if (!process.env.PKW_EXPORT_TS_LOADER) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(source, 'scripts/node_modules/tsx/dist/loader.mjs')).href,
      new URL(import.meta.url).pathname, ...args], { stdio: 'inherit', env: { ...process.env, PKW_EXPORT_TS_LOADER: '1' } });
    process.exit(result.status ?? 1);
  }
  const atlas = await import(pathToFileURL(path.join(source, 'packages/shared/src/atlas.ts')).href);
  const constants = await import(pathToFileURL(path.join(source, 'packages/shared/src/constants.ts')).href);
  return { atlasGroupFor: atlas.atlasGroupFor, constants };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => { console.error(error.message ?? error); process.exit(1); });
}
