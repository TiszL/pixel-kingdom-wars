import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, readFile, readdir, rename, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { acquireReleaseLock } from './release-lock.mjs';

test('failure to write lock ownership cannot strand either release pipeline', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-lock-'));
  const lock = path.join(root, 'lock');
  try {
    await assert.rejects(acquireReleaseLock(lock, { transactionId: 'a' }, async (file) => { await writeFile(file, '{partial'); throw new Error('Disk failure'); }), /Disk failure/);
    await assert.rejects(access(lock));
    const release = await acquireReleaseLock(lock, { transactionId: 'b' });
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('a second client cannot take over an active lock or delete changed ownership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-lock-'));
  const lock = path.join(root, 'lock');
  try {
    const release = await acquireReleaseLock(lock, { transactionId: 'a' });
    await assert.rejects(acquireReleaseLock(lock, { transactionId: 'b' }));
    assert.equal(JSON.parse(await readFile(path.join(lock, 'owner.json'))).transactionId, 'a');
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ transactionId: 'recovered' }));
    await assert.rejects(release(), /ownership changed/);
    await access(lock);
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const failureDuringWrite of [false, true]) test(`concurrent replacement survives ${failureDuringWrite ? 'owner write failure' : 'normal cleanup'}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-lock-'));
  const lock = path.join(root, 'lock');
  const replaceBeforeMove = async (from, to) => {
    await rename(from, path.join(root, 'original'));
    await mkdir(from);
    await writeFile(path.join(from, 'owner.json'), JSON.stringify({ transactionId: 'other-client' }));
    await rename(from, to);
  };
  try {
    if (failureDuringWrite) await assert.rejects(acquireReleaseLock(lock, { transactionId: 'a' }, async () => { throw new Error('Disk failure'); }, replaceBeforeMove), /replacement retained/);
    else {
      const release = await acquireReleaseLock(lock, { transactionId: 'a' }, writeFile, replaceBeforeMove);
      await assert.rejects(release(), /replacement retained/);
    }
    const quarantined = (await readdir(root)).find((name) => name.startsWith('lock.cleanup-'));
    assert.equal(JSON.parse(await readFile(path.join(root, quarantined, 'owner.json'))).transactionId, 'other-client');
    await access(path.join(lock, 'native-recovery-required.json'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
