import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './pack.mjs';
import { APPLICATION_ID, STORE_CERT } from './release-policy.mjs';

/** A same-name delivery replacement must preserve the old signed bytes and the
 * receipts that identify them. Only the caller holding the shared release lock
 * may prepare/publish this record; the normal next-code policy still applies. */
export async function releaseFileWitness(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Release input is not a regular file: ${file}`);
    const digest = sha256(await handle.readFile());
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`Release input changed while reading: ${file}`);
    }
    const entry = await lstat(file);
    if (!entry.isFile() || entry.dev !== after.dev || entry.ino !== after.ino) throw new Error(`Release input replaced while reading: ${file}`);
    return { path: file, dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, sha256: digest };
  } finally { await handle.close(); }
}

async function matches(file, expected, sameInode = false) {
  const actual = await releaseFileWitness(file);
  if (actual.sha256 !== expected.sha256 || actual.size !== expected.size ||
      (sameInode && (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.mtimeMs !== expected.mtimeMs))) {
    throw new Error(`Release file differs from recorded evidence: ${file}`);
  }
  return actual;
}

export async function prepareCanonicalReplacement({ storeApk, priorApk, priorReceipt, archiveRoot, version, previousCode }) {
  if (archiveRoot !== path.join(path.dirname(path.dirname(storeApk)), 'archive')) throw new Error('Release archive must stay beside the canonical build directory');
  const original = await releaseFileWitness(storeApk);
  const immutableApk = await matches(priorApk, original);
  const immutableReceipt = await releaseFileWitness(priorReceipt);
  const receipt = JSON.parse(await readFile(priorReceipt, 'utf8'));
  await matches(priorReceipt, immutableReceipt, true);
  if (receipt.applicationId !== APPLICATION_ID || receipt.certificate !== STORE_CERT ||
      receipt.version !== version || receipt.versionCode !== previousCode || receipt.sha256 !== original.sha256 ||
      !/^[a-f0-9]{40}$/.test(receipt.nativeCommit ?? '')) {
    throw new Error('Previous same-version receipt does not identify the preserved signed APK');
  }
  const directory = path.join(archiveRoot, `${version}-code${previousCode}-${original.sha256}`);
  return {
    version, previousCode, previousNativeCommit: receipt.nativeCommit, original, immutableApk, immutableReceipt,
    archiveApk: path.join(directory, path.basename(storeApk)),
    archiveReceipt: path.join(directory, path.basename(priorReceipt)),
    relocationReceipt: path.join(directory, 'canonical-relocation.json'),
    publicationReceipt: path.join(directory, 'canonical-replacement.json'),
  };
}

async function ensureDirectory(directory) {
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Release archive directory is not regular: ${directory}`);
}

async function ensureCopy(source, destination, expected) {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await matches(destination, expected);
}

async function ensureJson(file, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await matches(file, { sha256: sha256(Buffer.from(bytes)), size: Buffer.byteLength(bytes) });
}

async function checkExistingJson(file, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  try { await matches(file, { sha256: sha256(Buffer.from(bytes)), size: Buffer.byteLength(bytes) }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Idempotent publication/recovery of ONE already-journalled replacement. This
 * never builds, signs, allocates a code, removes a journal or releases a lock.
 * An unexpected destination always requires investigation, never overwrite. */
export async function publishCanonicalReplacement(record, onStage = async () => {}) {
  const { replacement: old, storeApk, stagedApk, sha256: digest, transactionId, versionCode, nativeCommit } = record;
  if (!old || old.original.path !== storeApk || !/^[a-f0-9]{32}$/.test(transactionId) ||
      !/^[a-f0-9]{64}$/.test(digest) || versionCode !== old.previousCode + 1 || record.version !== old.version) {
    throw new Error('Invalid same-version replacement transaction');
  }
  const fresh = await releaseFileWitness(stagedApk);
  if (fresh.sha256 !== digest) throw new Error('Staged replacement hash differs from the release transaction');
  await matches(old.immutableApk.path, old.immutableApk, true);
  await matches(old.immutableReceipt.path, old.immutableReceipt, true);
  const current = await releaseFileWitness(storeApk);
  const alreadyPublished = current.sha256 === fresh.sha256 && current.size === fresh.size;
  if (!alreadyPublished) await matches(storeApk, old.original, true);

  const archiveRoot = path.join(path.dirname(path.dirname(storeApk)), 'archive');
  const archiveDirectory = path.join(archiveRoot, `${old.version}-code${old.previousCode}-${old.original.sha256}`);
  if (old.archiveApk !== path.join(archiveDirectory, path.basename(storeApk)) ||
      old.archiveReceipt !== path.join(archiveDirectory, path.basename(old.immutableReceipt.path)) ||
      old.relocationReceipt !== path.join(archiveDirectory, 'canonical-relocation.json') ||
      old.publicationReceipt !== path.join(archiveDirectory, 'canonical-replacement.json')) throw new Error('Replacement archive paths differ from the transaction identity');
  await ensureDirectory(archiveRoot);
  await ensureDirectory(archiveDirectory);
  const publication = {
    schemaVersion: 1, transactionId, status: 'canonical-published', version: old.version,
    versionCode, nativeCommit, sha256: digest, canonicalApk: storeApk,
    previousVersionCode: old.previousCode, previousSha256: old.original.sha256,
    archivedApk: old.archiveApk, relocationReceipt: old.relocationReceipt,
  };
  // Detect a conflicting earlier transaction before changing the delivery path.
  await checkExistingJson(old.publicationReceipt, publication);
  // Copy from the immutable original, so recovery after canonical promotion
  // never mistakes the new delivery for the previous artifact.
  await ensureCopy(old.immutableApk.path, old.archiveApk, old.original);
  await onStage('archive-apk');
  await ensureCopy(old.immutableReceipt.path, old.archiveReceipt, old.immutableReceipt);
  const relocation = {
    schemaVersion: 1, transactionId, version: old.version, versionCode: old.previousCode,
    nativeCommit: old.previousNativeCommit, sha256: old.original.sha256,
    originalDeliveryPath: storeApk, archivedApk: old.archiveApk,
    immutableApk: old.immutableApk.path, originalReceipt: old.immutableReceipt.path,
    originalReceiptSha256: old.immutableReceipt.sha256, archivedReceipt: old.archiveReceipt,
    note: 'Historical receipts remain unchanged. Their original delivery path is preserved here by hash.',
  };
  await ensureJson(old.relocationReceipt, relocation);
  await onStage('archive-complete');
  if (!alreadyPublished) {
    const next = `${storeApk}.next-${transactionId}`;
    await ensureCopy(stagedApk, next, fresh);
    await onStage('replacement-staged');
    await matches(old.archiveApk, old.original);
    await matches(old.archiveReceipt, old.immutableReceipt);
    await matches(old.immutableApk.path, old.immutableApk, true);
    await matches(old.immutableReceipt.path, old.immutableReceipt, true);
    await matches(storeApk, old.original, true);
    await matches(next, fresh);
    await checkExistingJson(old.publicationReceipt, publication);
    await checkExistingJson(old.relocationReceipt, relocation);
    await rename(next, storeApk);
    await onStage('canonical-published');
  }
  await matches(storeApk, fresh);
  await ensureJson(old.publicationReceipt, publication);
  await onStage('publication-complete');
}
