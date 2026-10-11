#!/usr/bin/env node
// Q12: additive vehicle policy bridge; no art, renderer, contracts or base-policy rewrite.
import {mkdir, mkdtemp, readFile, writeFile, copyFile, rename, rm, lstat} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {sha256, manifestVersion, verifyPack, regularFile} from './pack.mjs';
import {assertJsonCarriable, CATALOGUE_CONSTANT_ALLOWLIST} from './constants-catalog.mjs';

export const VEHICLE_KEYS = Object.freeze(['PHASE_E_PAID_STARTER_ROUTES', 'PHASE_E_VEHICLES',
  'PHASE_E_ADVANCED_EXPEDITIONS', 'PHASE_E_VEHICLE_CLIENT', 'PHASE_E_ORDINARY_ROUTES']);
export const serial = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';

export function extendConstantsCatalogue(base, constants) {
  if (!base || !base.constants || Array.isArray(base.constants)) throw new Error('Catalogue constants missing');
  const additions = {};
  for (const key of VEHICLE_KEYS) {
    if (!Object.hasOwn(constants, key)) throw new Error(`Missing source constant ${key}`);
    assertJsonCarriable(constants[key], key);
    const value = JSON.parse(serial(constants[key]));
    if (Object.hasOwn(base.constants, key) && serial(base.constants[key]) !== serial(value))
      throw new Error(`Conflicting existing constant ${key}`);
    additions[key] = value;
  }
  return {...base, constants: {...base.constants, ...additions}};
}

export function compareExistingConstants(base, source) {
  return CATALOGUE_CONSTANT_ALLOWLIST.filter(key => Object.hasOwn(base.constants, key)).map(key => {
    // Historical HEROES functions were omitted by the original exporter as well.
    const before = serial(base.constants[key]);
    const after = Object.hasOwn(source, key) ? serial(source[key]) : null;
    return {key, equal: before === after, base_sha256: sha256(before),
      source_sha256: after === null ? null : sha256(after)};
  });
}

async function absent(output) {
  try { await lstat(output); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output pack already exists');
}

export async function extendConstantsPack({basePack, output, constants, constantsSource, expectedBaseManifest}) {
  if (!/^[a-f0-9]{40}$/.test(constantsSource) || !/^[a-f0-9]{64}$/.test(expectedBaseManifest))
    throw new Error('Exact source and base pins required');
  await absent(output);
  const manifestBytes = await readFile(await regularFile(basePack, 'manifest.json'));
  if (sha256(manifestBytes) !== expectedBaseManifest) throw new Error('Base manifest pin mismatch');
  const manifest = await verifyPack(basePack);
  if (manifest.simVersion !== 18 || manifest.rendererContractVersion !== 17) throw new Error('Expected SIM18 renderer17');
  const base = JSON.parse(await readFile(path.join(basePack, 'catalogue.json'), 'utf8'));
  const catalogue = extendConstantsCatalogue(base, constants);
  const render = JSON.parse(await readFile(path.join(basePack, 'render-catalog.json'), 'utf8'));
  if (render.rendererContractVersion !== 17 || !render.phaseE || !render.boundCosmetics || !render.fleetJourneys)
    throw new Error('Existing service, Wake and fleet sections required');
  const bytes = serial(catalogue);
  const files = manifest.files.map(file => file.path === 'catalogue.json'
    ? {...file, sha256: sha256(bytes), size: Buffer.byteLength(bytes)} : {...file});
  const extended = {...manifest, files, constantsExtension: {
    baseManifestSha256: expectedBaseManifest, constantsSource, keys: [...VEHICLE_KEYS]}};
  extended.contentVersion = manifestVersion(extended);
  await mkdir(path.dirname(output), {recursive: true});
  let stage = await mkdtemp(output + '.stage-');
  try {
    for (const file of manifest.files) {
      const target = path.join(stage, file.path);
      await mkdir(path.dirname(target), {recursive: true});
      if (file.path === 'catalogue.json') await writeFile(target, bytes);
      else await copyFile(await regularFile(basePack, file.path), target);
    }
    await writeFile(path.join(stage, 'manifest.json'), serial(extended));
    await verifyPack(stage);
    // Recheck immutable base identity at publication; the staged files were independently verified.
    if (sha256(await readFile(path.join(basePack, 'manifest.json'))) !== expectedBaseManifest)
      throw new Error('Base manifest changed during extension');
    await absent(output);
    await rename(stage, output); stage = null;
    return {baseManifestSha256: expectedBaseManifest, constantsSource,
      manifestSha256: sha256(serial(extended)), catalogueSha256: sha256(bytes),
      contentVersion: extended.contentVersion, unchangedFiles: files.length - 1,
      addedKeys: VEHICLE_KEYS.filter(key => !Object.hasOwn(base.constants, key)),
      existingConstants: compareExistingConstants(base, constants)};
  } finally { if (stage) await rm(stage, {recursive: true, force: true}); }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = name => {const i=args.indexOf(name);if(i<0 || !args[i+1]) throw new Error(`Missing ${name}`);return args[i+1];};
  const source=path.resolve(arg('--constants-source'));
  const expected=arg('--constants-commit');
  const git=(...argv)=>execFileSync('git',['-C',source,...argv],{encoding:'utf8'}).trim();
  if (git('rev-parse','HEAD') !== expected || git('status','--porcelain','--untracked-files=no'))
    throw new Error('Constants source must match the clean pinned commit');
  if (!process.env.PKW_EXPORT_TS_LOADER) {
    const child=spawnSync(process.execPath,['--import',pathToFileURL(path.join(source,'scripts/node_modules/tsx/dist/loader.mjs')).href,
      new URL(import.meta.url).pathname,...args],{stdio:'inherit',env:{...process.env,PKW_EXPORT_TS_LOADER:'1'}});
    process.exit(child.status ?? 1);
  }
  const constants=await import(pathToFileURL(path.join(source,'packages/shared/src/constants.ts')).href);
  const result=await extendConstantsPack({basePack:path.resolve(arg('--pack')),output:path.resolve(arg('--out')),
    constants,constantsSource:expected,expectedBaseManifest:arg('--base-manifest-sha256')});
  console.log(JSON.stringify(result,null,2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
