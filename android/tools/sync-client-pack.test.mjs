import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manifestVersion, metadataPaths, sha256, verifyPack } from './pack.mjs';
import { syncClientPack, replaceOutputs } from './sync-client-pack.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pkw-sync-test-'));
  const root = path.join(directory, 'app');
  const pack = path.join(root, 'client-packs/test-pack');
  await mkdir(root); await mkdir(pack, { recursive: true });
  const names = [...Object.values(metadataPaths), 'fixtures/replay.json'].sort();
  const manifest = { schemaVersion: 1, sourceCommit: 'a'.repeat(40), simVersion: 14, ...metadataPaths,
    files: names.map((name) => ({ path: name, size: 2, sha256: sha256('{}'), tier: name.startsWith('fixtures/') ? 'optional' : 'core' })) };
  manifest.contentVersion = manifestVersion(manifest);
  for (const name of names) { await mkdir(path.dirname(path.join(pack, name)), { recursive: true }); await writeFile(path.join(pack, name), '{}'); }
  await writeFile(path.join(pack, 'manifest.json'), JSON.stringify(manifest));
  try { await run({ root, pack, manifest }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('outside-repository packs cannot create an unreleasable lock or mutate import outputs', async () => fixture(async ({ root, pack }) => {
  const outside = path.join(path.dirname(root), 'outside-pack');
  await rename(pack, outside);
  const before = await readdir(root);
  await assert.rejects(syncClientPack(root, outside), /Unsafe content path/);
  await assert.rejects(syncClientPack(root, outside, { check: true }), /Unsafe content path/);
  assert.deepEqual(await readdir(root), before);
  const alias = path.join(root, 'outside-link');
  await symlink(outside, alias);
  const withAlias = await readdir(root);
  await assert.rejects(syncClientPack(root, alias), /symlink rejected/);
  assert.deepEqual(await readdir(root), withAlias);
}));

test('unhashed schema-v1 metadata cannot redirect Kotlin generation or select optional input', async () => fixture(async ({ pack, manifest }) => {
  for (const [key, value] of [['kotlinModelsPath', '../secret.kt'], ['cataloguePath', 'contracts.json'], ['kotlinModelsPath', undefined]]) {
    await writeFile(path.join(pack, 'manifest.json'), JSON.stringify({ ...manifest, [key]: value }));
    await assert.rejects(verifyPack(pack), /Invalid .*Path/);
  }
  const changed = { ...manifest, files: manifest.files.map((file) => file.path === 'kotlin/NativeContracts.kt' ? { ...file, tier: 'optional' } : file) };
  changed.contentVersion = manifestVersion(changed);
  await writeFile(path.join(pack, 'manifest.json'), JSON.stringify(changed));
  await assert.rejects(verifyPack(pack), /Invalid kotlinModelsPath/);
}));

test('manifest and parent directory symlinks are rejected even when their target is inside the pack', async () => fixture(async ({ pack }) => {
  await rename(path.join(pack, 'manifest.json'), path.join(pack, 'real-manifest.json'));
  await symlink('real-manifest.json', path.join(pack, 'manifest.json'));
  await assert.rejects(verifyPack(pack), /symlink/);
  await rm(path.join(pack, 'manifest.json'));
  await rename(path.join(pack, 'real-manifest.json'), path.join(pack, 'manifest.json'));
  await rename(path.join(pack, 'atlas'), path.join(pack, 'actual-atlas'));
  await symlink('actual-atlas', path.join(pack, 'atlas'));
  await assert.rejects(verifyPack(pack), /symlink/);
}));

test('check catches generated code, fixture, manifest and extra bundled-file drift', async () => fixture(async ({ root, pack }) => {
  await syncClientPack(root, pack);
  await syncClientPack(root, pack, { check: true });
  for (const [relative, failure] of [
    ['network/src/main/kotlin/gg/pixelkingdomwars/nativeclient/generated/NativeContracts.kt', /Generated Kotlin drift/],
    ['app/src/debug/assets/native/fixtures/replay.json', /integrity/],
    ['app/src/main/assets/native/manifest.json', /manifest drift/],
    ['app/src/main/assets/native/unexpected.json', /file set drift/],
  ]) {
    await writeFile(path.join(root, relative), 'changed');
    await assert.rejects(syncClientPack(root, pack, { check: true }), failure);
    await syncClientPack(root, pack);
    await syncClientPack(root, pack, { check: true });
  }
}));

test('a failed multi-output commit restores assets and generated code together', async () => fixture(async ({ root }) => {
  const outputs = ['assets', 'generated'].map((name) => ({ destination: path.join(root, name), staged: path.join(root, `${name}.new`), backup: path.join(root, `${name}.backup`) }));
  for (const output of outputs) { await writeFile(output.destination, 'old'); await writeFile(output.staged, 'new'); }
  await assert.rejects(replaceOutputs(outputs, async (from, to) => {
    if (from === outputs[1].staged) throw new Error('disk failure');
    await rename(from, to);
  }), /disk failure/);
  for (const output of outputs) assert.equal(await readFile(output.destination, 'utf8'), 'old');
}));

test('unsafe destination, corrupt source and interrupted import cannot replace a pinned generation', async () => fixture(async ({ root, pack }) => {
  await syncClientPack(root, pack);
  const pinned = await readFile(path.join(root, 'client-pack.lock.json'), 'utf8');
  await writeFile(path.join(root, '.client-pack-import.lock'), 'interrupted');
  await assert.rejects(syncClientPack(root, pack), /active or interrupted/);
  assert.equal(await readFile(path.join(root, '.client-pack-import.lock'), 'utf8'), 'interrupted');
  await rm(path.join(root, '.client-pack-import.lock'));
  await writeFile(path.join(pack, 'catalogue.json'), 'corrupted');
  await assert.rejects(syncClientPack(root, pack), /integrity/);
  assert.equal(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8'), pinned);
  await writeFile(path.join(pack, 'catalogue.json'), '{}');
  const generated = path.join(root, 'network/src/main/kotlin/gg/pixelkingdomwars/nativeclient/generated');
  await rename(generated, `${generated}-real`); await symlink(`${generated}-real`, generated);
  await assert.rejects(syncClientPack(root, pack), /Output symlink/);
  assert.equal(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8'), pinned);
}));

test('the lock carries the exporter record of omitted dark Phase E buildings, and older packs keep their lock shape', async () => fixture(async ({ root, pack, manifest }) => {
  // The lock is the reviewed record of what a build bundles; an omission hidden in the unhashed manifest only
  // would let a pack silently drop buildings without the reviewer seeing it (phase-e-buildings.mjs).
  await syncClientPack(root, pack);
  assert.equal('phaseEBuildings' in JSON.parse(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8')), false);
  const recorded = { ...manifest, phaseEBuildings: 'omitted', phaseEOmittedTypes: ['workshop', 'berth'] };
  await writeFile(path.join(pack, 'manifest.json'), JSON.stringify(recorded));
  await syncClientPack(root, pack);
  const lock = JSON.parse(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8'));
  assert.deepEqual([lock.phaseEBuildings, lock.phaseEOmittedTypes], ['omitted', ['workshop', 'berth']]);
  await syncClientPack(root, pack, { check: true });
}));
