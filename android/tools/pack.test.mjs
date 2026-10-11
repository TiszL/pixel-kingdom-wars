import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, safeRelative, manifestVersion, verifyPack, recordPackFile } from './pack.mjs';

test('download names cannot escape content roots', () => {
  for (const value of ['../secret', '/secret', 'a/../secret', 'a\\secret', 'a//secret', 'https:secret', '.']) {
    assert.throws(() => safeRelative(value));
  }
  assert.equal(safeRelative('atlas/bld@1x.json'), 'atlas/bld@1x.json');
});
test('a corrupted or redirected pack never replaces installed content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pkw-pack-'));
  try {
    await mkdir(path.join(dir, 'atlas'));
    await mkdir(path.join(dir, 'kotlin'));
    const names = ['atlas/meta.json', 'catalogue.json', 'contracts.json', 'kotlin/NativeContracts.kt', 'render-catalog.json'];
    for (const name of names) await writeFile(path.join(dir, name), '{}');
    const manifest = { schemaVersion: 1, sourceCommit: 'a'.repeat(40), simVersion: 14,
      cataloguePath: 'catalogue.json', renderCataloguePath: 'render-catalog.json',
      atlasMetadataPath: 'atlas/meta.json', contractPath: 'contracts.json',
      kotlinModelsPath: 'kotlin/NativeContracts.kt',
      files: names.map((p) => ({ path: p, sha256: sha256('{}'), size: 2, tier: 'core' })),
    };
    manifest.contentVersion = manifestVersion(manifest);
    await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    await verifyPack(dir);
    await writeFile(path.join(dir, 'catalogue.json'), '{"tampered":true}');
    await assert.rejects(verifyPack(dir), /integrity/);
    await rm(path.join(dir, 'catalogue.json'));
    await symlink(path.join(dir, 'contracts.json'), path.join(dir, 'catalogue.json'));
    await assert.rejects(verifyPack(dir), /regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sections publishing the same immutable path keep one manifest entry, and differing bytes fail the export', () => {
  const files = [];
  const clip = { path: 'atlas/fantasy/layered-ground/assets/aa.webp', sha256: sha256('clip'), size: 4, tier: 'optional' };
  assert.equal(recordPackFile(files, clip), clip);
  // The revision 4 section re-publishes a clip the revision 3 section already staged, as core.
  const again = { ...clip, tier: 'core' };
  assert.equal(recordPackFile(files, again), clip);
  assert.deepEqual(files, [{ ...clip, tier: 'core' }]);
  assert.throws(() => recordPackFile(files, { ...clip, sha256: sha256('other') }), /Conflicting bytes/);
  assert.equal(files.length, 1);
});
