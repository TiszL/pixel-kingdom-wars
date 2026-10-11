#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, safeRelative } from './pack.mjs';
import { acquireReleaseLock } from './release-lock.mjs';
import { prepareCanonicalReplacement, publishCanonicalReplacement } from './release-replacement.mjs';
import { beginSigningTransaction, recordVerifiedSigning } from './release-transaction.mjs';
import { APPLICATION_ID, STORE_CERT, parseBadging, parseCertificate, assertNextCode, assertReadiness, assertOwnerTestReadiness, canonicalStoreFilename, assertCurrentCandidate, RELEASE_WORLD_CONTENT, assertReleaseWorldContent } from './release-policy.mjs';
import { apkObjectKey, assertChannelPreflight, assertPublishable, assertStableApproval, buildManifest, otherKnownEntries, parseR2Env, parseShowRows, readBackApk, readReceipt, remoteCommand, runRemote, runRemotePublish, sha256File, signerSha256FromApksigner, uploadApk, writeChannelManifest } from './update-channel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.PKW_DAPPSTORE_DIR ?? path.join(homedir(), 'Downloads/dappstore');
const sdk = process.env.ANDROID_HOME ?? path.join(homedir(), '.bubblewrap/android_sdk');
const java = process.env.JAVA_HOME ?? path.join(homedir(), '.bubblewrap/jdk/jdk-17.0.11+9/Contents/Home');
const webRoot = process.env.PKW_WEB_ROOT ?? path.join(homedir(), 'Desktop/SHARDKEEP');
const buildTools = path.join(sdk, 'build-tools/36.1.0');
const env = { PATH: `${java}/bin:/usr/bin:/bin:/usr/sbin`, JAVA_HOME: java, LANG: 'en_US.UTF-8' };
function run(file, args, extra = {}) {
  return execFileSync(file, args, { cwd: root, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, ...extra });
}
const inspect = (file) => ({ ...parseBadging(run(path.join(buildTools, 'aapt'), ['dump', 'badging', file])), path: file });
async function inventory() {
  const result = [];
  for (const directory of [path.join(store, 'build'), path.join(root, 'releases')]) {
    let names;
    try { names = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const name of names.filter((name) => name.endsWith('.apk')).sort()) {
      const entry = inspect(path.join(directory, name));
      if (entry.applicationId !== APPLICATION_ID) throw new Error(`Unexpected package in release inventory: ${name}`);
      parseCertificate(run(path.join(buildTools, 'apksigner'), ['verify', '--print-certs', entry.path]));
      result.push(entry);
    }
  }
  return result;
}
async function knownCodes(apks) {
  const codes = [...apks];
  for (const relative of ['mobile/twa.config.json', 'mobile/build/twa-manifest.json']) {
    let config;
    try { config = JSON.parse(await readFile(path.join(webRoot, relative), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT' && relative.includes('/build/')) continue; throw e; }
    const applicationId = relative.includes('/build/') ? config.packageId : config.applicationId;
    if (applicationId !== APPLICATION_ID || !Number.isSafeInteger(config.appVersionCode) || config.appVersionCode < 1) throw new Error('Legacy release configuration identity is invalid');
    codes.push({ versionCode: config.appVersionCode });
  }
  return codes;
}
async function verifyPinnedInputs() {
  const lock = JSON.parse(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8'));
  const pack = path.join(root, safeRelative(lock.sourcePack));
  run(process.execPath, [path.join(root, 'tools/sync-client-pack.mjs'), '--pack', pack, '--check']);
}
// CI builds with -PpkwWorldContent=absent-ci (no world bundle); a signed release never does (release-policy.mjs).
async function refuseWorldContentOptOut() {
  const files = [path.join(root, 'gradle.properties'), path.join(root, 'app/gradle.properties'),
    path.join(process.env.GRADLE_USER_HOME ?? path.join(homedir(), '.gradle'), 'gradle.properties')];
  const texts = [];
  for (const file of files) {
    try { texts.push({ file, text: await readFile(file, 'utf8') }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  assertReleaseWorldContent(process.env, texts);
}
const args = process.argv.slice(2);
// The legacy name remains an alias; readiness is evidence, never owner publication approval.
const mode = args[0] === 'verify-readiness' ? 'promote' : (args[0] ?? 'inspect');
const replaceExistingVersion = args.includes('--replace-existing-version');
if (replaceExistingVersion && mode !== 'owner-test-candidate') throw new Error('Same-version replacement is restricted to an explicit private owner-test candidate');
if (!['inspect', 'candidate', 'owner-test-candidate', 'promote', 'publish-channel', 'mark-published'].includes(mode)) throw new Error('Usage: node tools/release.mjs inspect | candidate|owner-test-candidate --version X.Y.Z --code N --evidence /absolute/report.json | verify-readiness --apk /absolute/candidate.apk --evidence /absolute/report.json | publish-channel --apk releases/<file>.apk --channel tester|stable [--owner-approved] [--mandatory] [--notes-url U] [--r2-env P] [--origin U] [--remote user@host] [--remote-exec C] [--expect-signer HEX] | mark-published --code N [--remote user@host] [--remote-exec C]');
const known = await inventory();
if (!known.length) throw new Error('No preserved signed store APK found');
if (mode === 'inspect') {
  console.log(JSON.stringify({ applicationId: APPLICATION_ID, signer: STORE_CERT,
    knownReleases: known.map(({ versionCode, versionName, path: artifact }) => ({ versionCode, versionName, artifact })),
    nextVersionCode: Math.max(...(await knownCodes(known)).map((a) => a.versionCode)) + 1,
    notice: 'Inspection only. No version reserved, secrets read, APK rebuilt, or store submission performed.' }, null, 2));
  process.exit(0);
}
const requiredArg = (name) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`); return args[index + 1]; };
const commit = run('/usr/bin/git', ['rev-parse', 'HEAD']).trim();
if (run('/usr/bin/git', ['status', '--porcelain']).trim()) throw new Error('Commit and review all native source before signing');
// Backend M45 §4: publish the exact signed file to the in-app update channel.
// Only the operator CLI on the API host writes channel rows; this tool never does.
if (mode === 'publish-channel' || mode === 'mark-published') {
  const option = (name) => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1]) throw new Error(`Missing ${name}`); return args[index + 1]; };
  const remote = option('--remote');
  const remoteExec = option('--remote-exec');
  if (mode === 'mark-published') {
    const code = Number(requiredArg('--code'));
    if (!Number.isSafeInteger(code) || code < 1) throw new Error('--code must be a positive integer');
    const remoteArgs = ['mark-published', '--code', String(code)];
    if (remote) console.log(await runRemote({ remote, remoteExec, args: remoteArgs }));
    else console.log(`Run on the API host:\n${remoteCommand({ remoteExec, args: remoteArgs }).text}`);
    process.exit(0);
  }
  const apk = await realpath(requiredArg('--apk'));
  assertChannelPreflight({ porcelain: run('/usr/bin/git', ['status', '--porcelain']), apk, releasesDir: path.join(await realpath(root), 'releases') });
  const channel = requiredArg('--channel');
  const origin = option('--origin') ?? 'https://play.pixelkingdomwars.com';
  if (!/^https:\/\/[^/\s]+$/.test(origin)) throw new Error('--origin must be an https origin without a path');
  const receipt = await readReceipt(apk);
  const digest = await sha256File(apk);
  const size = (await lstat(apk)).size;
  const identity = inspect(apk);
  assertStableApproval({ channel, approved: args.includes('--owner-approved') });
  const signer = signerSha256FromApksigner(run(path.join(buildTools, 'apksigner'), ['verify', '--print-certs', apk]));
  const manifest = buildManifest({ badging: identity, receipt, sha256: digest, size, signer, channel,
    mandatory: args.includes('--mandatory'), notesUrl: option('--notes-url') ?? null, createdBy: `tools/release.mjs@${hostname()}` });
  const remoteRows = remote ? parseShowRows(await runRemote({ remote, remoteExec, args: ['show'] })) : undefined;
  const others = await otherKnownEntries(known, { versionCode: identity.versionCode, sha256: digest });
  assertPublishable({ knownCodes: (await knownCodes(others)).map((entry) => entry.versionCode), remoteRows, code: identity.versionCode,
    sha256: digest, channel, signer, expectSigner: option('--expect-signer') ?? STORE_CERT });
  const r2 = parseR2Env(await readFile(option('--r2-env') ?? path.join(webRoot, '.env'), 'utf8'));
  const key = apkObjectKey(identity.versionCode, digest);
  const uploaded = await uploadApk({ r2, key, path: apk, sha256: digest, size });
  await readBackApk({ url: `${r2.endpoint}/${r2.bucket}/${key}`, expectedSha256: digest, expectedSize: size, signed: r2 });
  await readBackApk({ url: `${r2.publicBaseUrl}/${key}`, expectedSha256: digest, expectedSize: size });
  const manifestPath = `${apk.slice(0, -'.apk'.length)}.channel.json`;
  const written = await writeChannelManifest(manifestPath, manifest);
  console.log(`R2 object ${uploaded}: ${key}\nChannel manifest ${written}: ${manifestPath}`);
  if (remote) console.log(await runRemotePublish({ manifest, remote, remoteExec }));
  else console.log(`Run the operator CLI with the manifest on stdin:\n${remoteCommand({ remoteExec, stdinFile: manifestPath }).text}`);
  console.log(`Origin URL: ${origin}/${key}\nSHA-256: ${digest}`);
  process.exit(0);
}
const evidencePath = path.resolve(requiredArg('--evidence'));
const report = JSON.parse(await readFile(evidencePath, 'utf8'));
const ownerTest = mode === 'owner-test-candidate';
const pendingAcceptanceAtSigning = ownerTest ? assertOwnerTestReadiness(report, commit) : [];
if (!ownerTest) assertReadiness(report, commit, mode === 'candidate');
for (const gate of Object.values(report.gates)) {
  if (gate.status !== 'passed') continue;
  const relative = safeRelative(gate.evidence);
  const evidenceFile = path.resolve(path.dirname(evidencePath), relative);
  if (sha256(await readFile(evidenceFile)) !== gate.sha256) throw new Error('Acceptance evidence integrity failed');
}
if (mode === 'promote') {
  const apk = await realpath(requiredArg('--apk'));
  if (!apk.startsWith(path.join(await realpath(root), 'releases') + path.sep)) throw new Error('Candidate must be in this repository release directory');
  const receipt = JSON.parse(await readFile(`${apk}.json`, 'utf8'));
  const digest = sha256(await readFile(apk));
  if (receipt.nativeCommit !== commit || receipt.sha256 !== digest || report.apkSha256 !== digest) throw new Error('Upgrade evidence must identify this exact signed candidate');
  const identity = inspect(apk);
  if (identity.applicationId !== APPLICATION_ID || identity.versionCode !== receipt.versionCode) throw new Error('Candidate identity changed');
  parseCertificate(run(path.join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk]));
  const promotionLock = path.join(store, '.apk-release.lock');
  const promotionId = randomBytes(16).toString('hex');
  const releasePromotionLock = await acquireReleaseLock(promotionLock, { transactionId: promotionId,
    host: hostname(), pid: process.pid, root, copy: true, version: identity.versionName, versionCode: identity.versionCode });
  try {
    assertCurrentCandidate(await knownCodes(await inventory()), identity.versionCode);
    await writeFile(`${apk}.ready.json`, JSON.stringify({ ...receipt, status: 'ready-for-owner-review',
      publicationAuthorized: false, acceptanceSha256: sha256(await readFile(evidencePath)), verifiedAt: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
  } finally {
    await releasePromotionLock();
  }
  console.log(`Readiness verified for local artifact: ${apk}\nOwner installation and publication remain separate actions. Not submitted to any store.`);
  process.exit(0);
}
const version = requiredArg('--version');
const code = Number(requiredArg('--code'));
const storeFilename = canonicalStoreFilename(version);
assertNextCode(await knownCodes(known), code);
await verifyPinnedInputs();
await refuseWorldContentOptOut();
// Shared with the unchanged TWA pipeline. Never break another tool's lock.
const lock = path.join(store, '.apk-release.lock');
for (const marker of ['.apk-release-recovery.lock', '.apk-release-transaction.json', '.native-apk-release-transaction.json']) {
  try { await lstat(path.join(store, marker)); throw new Error('Resolve the existing TWA release transaction first'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
const transactionId = randomBytes(16).toString('hex');
const owner = { transactionId, host: hostname(), pid: process.pid, startedAt: new Date().toISOString(),
  version, versionCode: code, root, copy: true, client: 'android-native' };
const releaseLock = await acquireReleaseLock(lock, owner);
let secret;
let outputTransaction = false;
try {
  const lockedInventory = await inventory();
  assertNextCode(await knownCodes(lockedInventory), code);
  const canonicalApk = path.join(store, 'build', storeFilename);
  let replacement;
  if (replaceExistingVersion) {
    const prior = lockedInventory.find((entry) => entry.path === canonicalApk);
    if (!prior || prior.versionName !== version || prior.versionCode !== code - 1) {
      throw new Error('Same-version replacement requires the current highest-code canonical APK');
    }
    const priorApk = path.join(root, 'releases', `pixel-kingdom-wars-native-v${version}-code${prior.versionCode}.apk`);
    replacement = await prepareCanonicalReplacement({ storeApk: canonicalApk, priorApk,
      priorReceipt: `${priorApk}.json`, archiveRoot: path.join(store, 'archive'), version, previousCode: prior.versionCode });
  } else {
    // Same-name replacement is opt-in; ordinary releases never overwrite.
    try { await lstat(canonicalApk); throw new Error('Canonical APK already exists; choose a new version or explicitly preserve it with --replace-existing-version'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const keyFile = path.join(store, 'pkw-dappstore.keystore');
  const passwordFile = path.join(store, 'KEYSTORE-PASSWORD.txt');
  const storeRoot = await realpath(store);
  for (const file of [keyFile, passwordFile]) {
    if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink() ||
        !(await realpath(file)).startsWith(storeRoot + path.sep)) throw new Error('Signing inputs must be regular files in the external store directory');
  }
  // Gradle receives no signing credential. Read the credential only for direct signing tools.
  const gradleEnvironment = { ...process.env, JAVA_HOME: java, ANDROID_HOME: sdk };
  for (const key of Object.keys(gradleEnvironment)) if (/PASSWORD|SECRET|TOKEN|PRIVATE_KEY/i.test(key)) delete gradleEnvironment[key];
  run(path.join(root, 'gradlew'), ['--no-daemon', ':app:assembleRelease', '-PnativeRequireFirebase=true', RELEASE_WORLD_CONTENT, `-PnativeVersionCode=${code}`, `-PnativeVersionName=${version}`],
    { env: gradleEnvironment, stdio: 'inherit' });
  if (run('/usr/bin/git', ['rev-parse', 'HEAD']).trim() !== commit || run('/usr/bin/git', ['status', '--porcelain']).trim()) throw new Error('Native source changed during build');
  await verifyPinnedInputs();
  const matches = (await readFile(passwordFile, 'utf8')).split(/\r?\n/).map((line) => /^Password:\s*(\S+)$/.exec(line)).filter(Boolean);
  if (matches.length !== 1) throw new Error('External password file has an unsupported format');
  secret = matches[0][1];
  const signerEnv = { ...env, PKW_STORE_KEYSTORE_PASSWORD: secret };
  const keyInfo = run(path.join(java, 'bin/keytool'), ['-list', '-v', '-keystore', keyFile, '-alias', 'pkw',
    '-storepass:env', 'PKW_STORE_KEYSTORE_PASSWORD'], { env: signerEnv });
  const keyCert = /SHA256:\s*([A-Fa-f0-9:]+)/.exec(keyInfo)?.[1].replaceAll(':', '').toLowerCase();
  if (keyCert !== STORE_CERT) throw new Error('Keystore differs from the preserved listing certificate');
  const links = await fetch('https://play.pixelkingdomwars.com/.well-known/assetlinks.json', { signal: AbortSignal.timeout(15000) });
  if (!links.ok) throw new Error('Cannot verify live app identity');
  const statements = await links.json();
  if (!statements.some((s) => s.target?.package_name === APPLICATION_ID &&
    s.target?.sha256_cert_fingerprints?.some((f) => f.replaceAll(':', '').toLowerCase() === STORE_CERT))) throw new Error('Live Digital Asset Links certificate mismatch');
  const unsigned = path.join(root, 'app/build/outputs/apk/release/app-release-unsigned.apk');
  const signed = path.join(root, `app/build/outputs/apk/release/native-signed-${transactionId}.apk`);
  const transactionPath = path.join(store, '.native-apk-release-transaction.json');
  // apksigner may create signed bytes before returning an error. Fence that
  // uncertainty before invocation, not just after all APK audits succeed.
  outputTransaction = true;
  await beginSigningTransaction(transactionPath, { ...owner, phase: 'signing', nativeCommit: commit,
    stagedApk: signed, applicationId: APPLICATION_ID, certificate: STORE_CERT,
    evidenceSha256: sha256(await readFile(evidencePath)), ...(replacement ? { replacement } : {}) });
  run(path.join(buildTools, 'apksigner'), ['sign', '--ks', keyFile, '--ks-key-alias', 'pkw', '--ks-pass',
    'env:PKW_STORE_KEYSTORE_PASSWORD', '--key-pass', 'env:PKW_STORE_KEYSTORE_PASSWORD', '--out', signed, unsigned], { env: signerEnv });
  secret = undefined;
  const identity = inspect(signed);
  if (identity.applicationId !== APPLICATION_ID || identity.versionCode !== code || identity.versionName !== version) throw new Error('Signed APK identity mismatch');
  parseCertificate(run(path.join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', signed]));
  run(path.join(buildTools, 'zipalign'), ['-c', '-P', '16', '4', signed]);
  const manifest = run(path.join(buildTools, 'aapt'), ['dump', 'xmltree', signed, 'AndroidManifest.xml']);
  if (/androidbrowserhelper|trustedwebactivity|com\.google\.androidbrowserhelper/i.test(manifest)) throw new Error('Native release contains a TWA component');
  if (/android:debuggable.*0xffffffff/i.test(manifest)) throw new Error('Refusing debuggable store APK');
  const filename = `pixel-kingdom-wars-native-v${version}-code${code}.apk`;
  const checksum = sha256(await readFile(signed));
  await mkdir(path.join(root, 'releases'), { recursive: true });
  const receipt = { ...owner, nativeCommit: commit, status: ownerTest ? 'owner-test-candidate' : 'candidate',
    ...(ownerTest ? { purpose: 'private-owner-test', publicationAuthorized: false, pendingAcceptanceAtSigning } : {}),
    sourceCommit: JSON.parse(await readFile(path.join(root, 'client-pack.lock.json'), 'utf8')).sourceCommit,
    applicationId: APPLICATION_ID, certificate: STORE_CERT, sha256: checksum,
    evidenceSha256: sha256(await readFile(evidencePath)),
    ...(replacement ? { replacesCanonical: { versionCode: replacement.previousCode, sha256: replacement.original.sha256,
      archivedApk: replacement.archiveApk, relocationReceipt: replacement.relocationReceipt } } : {}) };
  const localApk = path.join(root, 'releases', filename);
  const storeApk = path.join(store, 'build', storeFilename);
  // Any interruption after this record retains the shared lock. Recovery must
  // verify hashes and finish these exact outputs before either pipeline advances.
  const outputRecord = { ...receipt, phase: 'verified-output', stagedApk: signed, localApk, storeApk,
    receiptPath: `${localApk}.json`, ...(replacement ? { replacement } : {}) };
  // Retain the lock even if journal creation fails partially. No second signer
  // may guess whether this already-signed code is available for reuse.
  outputTransaction = true;
  await recordVerifiedSigning(transactionPath, outputRecord);
  await writeFile(`${localApk}.json`, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  // Mirror the verified APK into the directory the legacy tool scans. Its code
  // guard now sees native releases too, without changing any TWA source/config.
  for (const destination of replacement ? [localApk] : [localApk, storeApk]) {
    await copyFile(signed, destination, fsConstants.COPYFILE_EXCL);
    if (sha256(await readFile(destination)) !== checksum) throw new Error('Release copy verification failed');
  }
  if (replacement) await publishCanonicalReplacement(outputRecord);
  await rm(transactionPath);
  outputTransaction = false;
  console.log(`Signed native ${ownerTest ? 'PRIVATE OWNER-TEST CANDIDATE' : 'CANDIDATE'}: ${path.join(root, 'releases', filename)}\nSHA-256: ${checksum}\n${ownerTest ? `Pending acceptance: ${pendingAcceptanceAtSigning.map(({ gate }) => gate).join(', ') || 'none recorded'}. Readiness has not been verified.\n` : ''}In-place upgrade acceptance and verify-readiness are still required. Not submitted to any store.`);
} finally {
  secret = undefined;
  if (!outputTransaction) await releaseLock();
  if (outputTransaction) console.error('Native release output is incomplete. Shared lock and .native-apk-release-transaction.json retained; verify and recover exact outputs before either pipeline runs.');
}
