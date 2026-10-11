import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beginSigningTransaction, recordVerifiedSigning } from './release-transaction.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-signing-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.native-apk-release-transaction.json');
  const intent = { phase: 'signing', transactionId: 'a'.repeat(32), nativeCommit: 'b'.repeat(40), version: '0.5.8', versionCode: 25, stagedApk: path.join(root, 'signed.apk') };
  const output = { ...intent, phase: 'verified-output', sha256: 'c'.repeat(64) };
  return { file, intent, output };
}

test('uncertain signing leaves a durable intent which rejects another signer', async (t) => {
  const f = await fixture(t);
  await beginSigningTransaction(f.file, f.intent);
  assert.deepEqual(JSON.parse(await readFile(f.file)), f.intent);
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
  // Failure after the signer writes bytes must not erase the code/identity.
  await writeFile(f.intent.stagedApk, 'possibly signed bytes');
  await assert.rejects(beginSigningTransaction(f.file, { ...f.intent, transactionId: 'd'.repeat(32) }), /EEXIST/);
  assert.deepEqual(JSON.parse(await readFile(f.file)), f.intent);
});

test('verified publication retains the exact signing identity and output hash', async (t) => {
  const f = await fixture(t); await beginSigningTransaction(f.file, f.intent);
  await recordVerifiedSigning(f.file, f.output);
  assert.deepEqual(JSON.parse(await readFile(f.file)), f.output);
});

for (const change of [{ versionCode: 26 }, { nativeCommit: 'd'.repeat(40) }, { stagedApk: '/different.apk' }, { transactionId: 'd'.repeat(32) }, { sha256: 'invalid' }]) {
  test(`mismatched verified ${Object.keys(change)[0]} preserves signing intent`, async (t) => {
    const f = await fixture(t); await beginSigningTransaction(f.file, f.intent);
    await assert.rejects(recordVerifiedSigning(f.file, { ...f.output, ...change }), /differs/);
    assert.deepEqual(JSON.parse(await readFile(f.file)), f.intent);
  });
}

test('a conflicting transition file cannot discard the original intent', async (t) => {
  const f = await fixture(t); await beginSigningTransaction(f.file, f.intent);
  const transition = `${f.file}.verified-${f.output.transactionId}`;
  await writeFile(transition, 'other evidence');
  await assert.rejects(recordVerifiedSigning(f.file, f.output), /EEXIST/);
  assert.deepEqual(JSON.parse(await readFile(f.file)), f.intent);
  assert.equal(await readFile(transition, 'utf8'), 'other evidence');
});
