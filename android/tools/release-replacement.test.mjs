import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from './pack.mjs';
import { APPLICATION_ID, STORE_CERT, assertNextCode } from './release-policy.mjs';
import { acquireReleaseLock } from './release-lock.mjs';
import { prepareCanonicalReplacement, publishCanonicalReplacement } from './release-replacement.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-release-replacement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = path.join(root, 'dappstore'), releases = path.join(root, 'releases');
  await mkdir(path.join(store, 'build'), { recursive: true }); await mkdir(releases);
  const old = Buffer.from('preserved signed version0.5.8 code24');
  const fresh = Buffer.from('reviewed signed version0.5.8 code25');
  const storeApk = path.join(store, 'build', 'pixel-kingdom-wars-v0.5.8-dappstore.apk');
  const priorApk = path.join(releases, 'pixel-kingdom-wars-native-v0.5.8-code24.apk');
  const priorReceipt = `${priorApk}.json`, stagedApk = path.join(root, 'new-signed.apk');
  const receipt = { version: '0.5.8', versionCode: 24, applicationId: APPLICATION_ID,
    certificate: STORE_CERT, nativeCommit: 'a'.repeat(40), sha256: sha256(old), status: 'owner-test-candidate' };
  await writeFile(storeApk, old); await writeFile(priorApk, old);
  await writeFile(priorReceipt, JSON.stringify(receipt)); await writeFile(stagedApk, fresh);
  const input = { storeApk, priorApk, priorReceipt, archiveRoot: path.join(store, 'archive'), version: '0.5.8', previousCode: 24 };
  const replacement = await prepareCanonicalReplacement(input);
  const record = { replacement, storeApk, stagedApk, transactionId: 'b'.repeat(32),
    version: '0.5.8', versionCode: 25, nativeCommit: 'c'.repeat(40), sha256: sha256(fresh) };
  return { root, store, old, fresh, receipt, input, record, replacement, priorApk, priorReceipt, storeApk, stagedApk };
}

test('same visible version publishes the next code while preserving original bytes and receipts', async (t) => {
  const f = await fixture(t); const receiptBefore = await readFile(f.priorReceipt);
  await publishCanonicalReplacement(f.record);
  assert.deepEqual(await readFile(f.storeApk), f.fresh);
  assert.deepEqual(await readFile(f.priorApk), f.old);
  assert.deepEqual(await readFile(f.replacement.archiveApk), f.old);
  assert.deepEqual(await readFile(f.priorReceipt), receiptBefore);
  assert.deepEqual(await readFile(f.replacement.archiveReceipt), receiptBefore);
  const relocation = JSON.parse(await readFile(f.replacement.relocationReceipt));
  assert.equal(relocation.originalDeliveryPath, f.storeApk);
  assert.equal(relocation.sha256, sha256(f.old)); assert.equal(relocation.archivedApk, f.replacement.archiveApk);
  const publication = JSON.parse(await readFile(f.replacement.publicationReceipt));
  assert.equal(publication.versionCode, 25); assert.equal(publication.previousVersionCode, 24);
  assertNextCode([{ versionCode: 24 }, { versionCode: publication.versionCode }], 26);
  assert.throws(() => assertNextCode([{ versionCode: 25 }], 25));
});

for (const stage of ['archive-apk', 'archive-complete', 'replacement-staged', 'canonical-published', 'publication-complete']) {
  test(`interruption after ${stage} retains both generations and resumes only the journalled output`, async (t) => {
    const f = await fixture(t);
    const lock = path.join(f.store, '.apk-release.lock');
    const release = await acquireReleaseLock(lock, { transactionId: f.record.transactionId });
    const journal = path.join(f.store, '.native-apk-release-transaction.json');
    await writeFile(journal, JSON.stringify(f.record), { flag: 'wx' });
    await assert.rejects(publishCanonicalReplacement(f.record, async (reached) => {
      if (reached === stage) throw new Error('simulated process interruption');
    }), /simulated process interruption/);
    assert.ok((await lstat(lock)).isDirectory());
    assert.deepEqual(JSON.parse(await readFile(journal)), f.record);
    assert.deepEqual(await readFile(f.priorApk), f.old);
    assert.deepEqual(await readFile(f.replacement.archiveApk), f.old);
    assert.deepEqual(await readFile(f.storeApk), ['canonical-published', 'publication-complete'].includes(stage) ? f.fresh : f.old);
    await publishCanonicalReplacement(JSON.parse(await readFile(journal)));
    assert.deepEqual(await readFile(f.storeApk), f.fresh);
    const publicationBefore = await readFile(f.replacement.publicationReceipt);
    await publishCanonicalReplacement(f.record);
    assert.deepEqual(await readFile(f.replacement.publicationReceipt), publicationBefore);
    await rm(journal); await release();
  });
}

test('a changed canonical destination is never replaced even if its archive was prepared', async (t) => {
  const f = await fixture(t); const stranger = Buffer.from('another release took this path');
  await assert.rejects(publishCanonicalReplacement(f.record, async (stage) => {
    if (stage === 'replacement-staged') await writeFile(f.storeApk, stranger);
  }), /differs from recorded evidence/);
  assert.deepEqual(await readFile(f.storeApk), stranger);
  assert.deepEqual(await readFile(f.replacement.archiveApk), f.old);
});

for (const member of ['archiveApk', 'archiveReceipt', 'relocationReceipt', 'publicationReceipt']) {
  test(`a conflicting ${member} blocks publication without overwriting it`, async (t) => {
    const f = await fixture(t);
    await mkdir(path.dirname(f.replacement.archiveApk), { recursive: true });
    await writeFile(f.replacement[member], 'unrelated evidence');
    await assert.rejects(publishCanonicalReplacement(f.record), /differs from recorded evidence/);
    assert.equal(await readFile(f.replacement[member], 'utf8'), 'unrelated evidence');
    assert.deepEqual(await readFile(f.storeApk), f.old);
  });
}

test('corrupt archival evidence blocks recovery after canonical publication', async (t) => {
  const f = await fixture(t);
  await publishCanonicalReplacement(f.record);
  await writeFile(f.replacement.archiveApk, 'damaged archive');
  await assert.rejects(publishCanonicalReplacement(f.record), /differs from recorded evidence/);
  assert.deepEqual(await readFile(f.storeApk), f.fresh);
  assert.deepEqual(await readFile(f.priorApk), f.old);
});

test('staged or immutable input changes fail closed', async (t) => {
  const f = await fixture(t);
  await writeFile(f.stagedApk, 'wrong staged APK');
  await assert.rejects(publishCanonicalReplacement(f.record), /Staged replacement hash/);
  await writeFile(f.stagedApk, f.fresh);
  await writeFile(f.priorReceipt, 'altered receipt');
  await assert.rejects(publishCanonicalReplacement(f.record), /differs from recorded evidence/);
  assert.deepEqual(await readFile(f.storeApk), f.old);
});

test('the original signed receipt must identify this exact version, code and signer', async (t) => {
  const f = await fixture(t);
  for (const change of [{ versionCode: 23 }, { version: '0.5.7' }, { certificate: '0'.repeat(64) }, { sha256: '0'.repeat(64) }]) {
    await writeFile(f.priorReceipt, JSON.stringify({ ...f.receipt, ...change }));
    await assert.rejects(prepareCanonicalReplacement(f.input), /Previous same-version receipt/);
  }
});

test('archive symlinks cannot redirect preserved release evidence', async (t) => {
  const f = await fixture(t); const elsewhere = path.join(f.root, 'elsewhere');
  await mkdir(elsewhere); await symlink(elsewhere, f.input.archiveRoot);
  await assert.rejects(publishCanonicalReplacement(f.record), /archive directory is not regular/);
  assert.deepEqual(await readFile(f.storeApk), f.old);
});

test('canonical symlink replacement is rejected without changing its target', async (t) => {
  const f = await fixture(t); const elsewhere = path.join(f.root, 'elsewhere.apk');
  await writeFile(elsewhere, f.old); await rm(f.storeApk); await symlink(elsewhere, f.storeApk);
  await assert.rejects(publishCanonicalReplacement(f.record));
  assert.ok((await lstat(f.storeApk)).isSymbolicLink()); assert.deepEqual(await readFile(elsewhere), f.old);
});

test('replacement still rejects reused codes and redirected archive paths', async (t) => {
  const f = await fixture(t);
  await assert.rejects(publishCanonicalReplacement({ ...f.record, versionCode: 24 }), /Invalid same-version/);
  await assert.rejects(publishCanonicalReplacement({ ...f.record, replacement: { ...f.replacement, archiveApk: path.join(f.root, 'outside.apk') } }), /archive paths differ/);
  assert.deepEqual(await readFile(f.storeApk), f.old);
});
