import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeInitialProfile } from './local-dev-profile.mjs';

test('retained Docker credentials block a new mismatched local profile', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-profile-'));
  try {
    await writeFile(path.join(root, 'docker.env'), 'retained');
    await assert.rejects(writeInitialProfile(root, { marker: 'new' }, 'different'), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(root, 'docker.env'), 'utf8'), 'retained');
    await assert.rejects(stat(path.join(root, 'config.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});

test('second exclusive-write failure preserves the existing config and rolls back only the new Docker file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-profile-'));
  try {
    await writeFile(path.join(root, 'config.json'), 'retained');
    await assert.rejects(writeInitialProfile(root, { marker: 'new' }, 'different'), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(root, 'config.json'), 'utf8'), 'retained');
    await assert.rejects(stat(path.join(root, 'docker.env')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true }); }
});
