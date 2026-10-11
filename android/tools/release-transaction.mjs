import { open, readFile, rename } from 'node:fs/promises';

async function exclusiveRecord(file, record) {
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

/** Must complete before invoking apksigner. An uncertain invocation must not
 * permit code reuse or a second signing attempt; the lock/journal need recovery. */
export async function beginSigningTransaction(file, intent) {
  if (intent.phase !== 'signing' || !/^[a-f0-9]{32}$/.test(intent.transactionId) ||
      !/^[a-f0-9]{40}$/.test(intent.nativeCommit) || !Number.isSafeInteger(intent.versionCode) || intent.versionCode < 1) {
    throw new Error('Invalid native signing intent');
  }
  await exclusiveRecord(file, intent);
}

/** Atomic journal transition keeps the original signing intent if preparing
 * verified output fails. Never interpret another transaction as this signer. */
export async function recordVerifiedSigning(file, output) {
  const originalBytes = await readFile(file, 'utf8');
  const original = JSON.parse(originalBytes);
  if (original.phase !== 'signing' || output.phase !== 'verified-output' ||
      ['transactionId', 'nativeCommit', 'version', 'versionCode', 'stagedApk'].some((key) => original[key] !== output[key]) ||
      !/^[a-f0-9]{64}$/.test(output.sha256 ?? '')) throw new Error('Verified output differs from its native signing intent');
  const next = `${file}.verified-${output.transactionId}`;
  await exclusiveRecord(next, output);
  if (await readFile(file, 'utf8') !== originalBytes) throw new Error('Native signing intent changed before journal transition');
  await rename(next, file);
}
