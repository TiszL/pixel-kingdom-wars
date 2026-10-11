#!/usr/bin/env node
import { mkdir, readFile, readdir, lstat, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifyPack, sha256, safeRelative, regularFile, verifiedBytes } from './pack.mjs';

const json = (value) => JSON.stringify(value, null, 2) + '\n';
const generatedPath = 'network/src/main/kotlin/gg/pixelkingdomwars/nativeclient/generated/NativeContracts.kt';
const mainPath = 'app/src/main/assets/native';
const fixturePath = 'app/src/debug/assets/native/fixtures';
const lockPath = 'client-pack.lock.json';

async function safeDestination(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Output symlink rejected: ${relative}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}

async function treeFiles(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Output symlink rejected: ${relative}`);
    if (entry.isDirectory()) result.push(...await treeFiles(root, relative));
    else if (entry.isFile()) result.push(relative);
    else throw new Error(`Unsupported output file: ${relative}`);
  }
  return result.sort();
}

/** A failed rename rolls back every output. The transaction marker/backup is retained if rollback
 * itself fails; interruption is reported by the exclusive lock rather than accepted by --check. */
export async function replaceOutputs(outputs, move = rename) {
  const changed = [];
  try {
    for (const output of outputs) {
      const state = { ...output, previous: false, installed: false };
      changed.push(state);
      try { await move(output.destination, output.backup); state.previous = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await move(output.staged, output.destination); state.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const state of changed.reverse()) {
      try {
        if (state.installed) await rm(state.destination, { recursive: true, force: true });
        if (state.previous) await rename(state.backup, state.destination);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Import rollback failed; retain transaction directory and recover its backups');
    throw error;
  }
}

export async function syncClientPack(rootDirectory, sourceDirectory, { check = false } = {}) {
  const root = await realpath(rootDirectory);
  // Release verification resolves sourcePack inside this repository. Reject an incompatible
  // external source before creating even the import lock, and reject symlink aliases too.
  const requestedRelative = safeRelative(path.relative(path.resolve(rootDirectory), path.resolve(sourceDirectory)));
  const source = await realpath(await safeDestination(root, requestedRelative));
  const sourcePack = safeRelative(path.relative(root, source));
  const importLock = path.join(root, '.client-pack-import.lock');
  let handle;
  try { handle = await open(importLock, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Pack import is active or interrupted: inspect .client-pack-import.lock and its transaction before recovery'); throw error; }
  const transaction = path.join(root, `.client-pack-transaction-${randomUUID()}`);
  let retainRecovery = false;
  try {
    await handle.writeFile(json({ pid: process.pid, transaction }));
    await handle.sync();
    const manifest = await verifyPack(source);
    const core = manifest.files.filter((file) => file.tier === 'core');
    const fixtures = manifest.files.filter((file) => file.path.startsWith('fixtures/'));
    const kotlin = manifest.files.find((file) => file.path === manifest.kotlinModelsPath);
    const pinned = json({ schemaVersion: 1, sourceCommit: manifest.sourceCommit, simVersion: manifest.simVersion,
      contentVersion: manifest.contentVersion,
      // Reviewed record of dark Phase E buildings the exporter left out (phase-e-buildings.mjs); absent for older packs.
      ...(manifest.phaseEBuildings === undefined ? {} : { phaseEBuildings: manifest.phaseEBuildings, phaseEOmittedTypes: manifest.phaseEOmittedTypes }),
      sourcePack, coreFiles: core.length });
    for (const relative of [mainPath, generatedPath, fixturePath, lockPath]) await safeDestination(root, relative);
    if (check) {
      if (await readFile(path.join(root, lockPath), 'utf8') !== pinned) throw new Error('Client pack lock drift: import the reviewed pack');
      const bundled = path.join(root, mainPath);
      const expected = [...core.map((file) => file.path), 'manifest.json'].sort();
      if (JSON.stringify(await treeFiles(bundled)) !== JSON.stringify(expected)) throw new Error('Bundled file set drift');
      if (await readFile(await regularFile(bundled, 'manifest.json'), 'utf8') !== json(manifest)) throw new Error('Bundled manifest drift');
      for (const file of core) await verifiedBytes(bundled, file);
      if (sha256(await readFile(await regularFile(root, generatedPath))) !== kotlin.sha256) throw new Error('Generated Kotlin drift');
      const fixtureRoot = path.join(root, fixturePath);
      if (JSON.stringify(await treeFiles(fixtureRoot)) !== JSON.stringify(fixtures.map((file) => file.path.slice('fixtures/'.length)).sort())) throw new Error('Debug fixture file set drift');
      for (const file of fixtures) await verifiedBytes(fixtureRoot, { ...file, path: file.path.slice('fixtures/'.length) });
      return manifest;
    }
    await mkdir(transaction);
    const main = path.join(transaction, 'main');
    const debug = path.join(transaction, 'fixtures');
    await mkdir(main); await mkdir(debug);
    for (const file of core) {
      const target = path.join(main, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await verifiedBytes(source, file));
    }
    await writeFile(path.join(main, 'manifest.json'), json(manifest));
    await writeFile(path.join(transaction, 'models'), await verifiedBytes(source, kotlin));
    for (const file of fixtures) {
      const target = path.join(debug, file.path.slice('fixtures/'.length));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await verifiedBytes(source, file));
    }
    await writeFile(path.join(transaction, 'lock'), pinned);
    const outputs = [[mainPath, 'main'], [generatedPath, 'models'], [fixturePath, 'fixtures'], [lockPath, 'lock']].map(([relative, name]) => ({
      destination: path.join(root, relative), staged: path.join(transaction, name), backup: path.join(transaction, `${name}.previous`),
    }));
    for (const output of outputs) await mkdir(path.dirname(output.destination), { recursive: true });
    await writeFile(path.join(transaction, 'outputs.json'), json(outputs));
    try { await replaceOutputs(outputs); }
    catch (error) { retainRecovery = error instanceof AggregateError; throw error; }
    return manifest;
  } finally {
    await handle.close();
    if (!retainRecovery) { await rm(transaction, { recursive: true, force: true }); await rm(importLock, { force: true }); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--pack');
  if (index < 0 || !args[index + 1] || args.some((arg, i) => i !== index + 1 && !['--pack', '--check'].includes(arg))) {
    throw new Error('Usage: node tools/sync-client-pack.mjs --pack /absolute/pack [--check]');
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = await syncClientPack(root, path.resolve(args[index + 1]), { check: args.includes('--check') });
  console.log(`${args.includes('--check') ? 'Verified' : 'Imported'} pinned pack ${manifest.contentVersion}`);
}
