#!/usr/bin/env node
/** Operator test identity only. No caller-supplied wallet, key, cookie, JWT or origin. */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, createHash } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestVersion } from './pack.mjs';

export const ORIGIN = 'https://qa.pixelkingdomwars.com';
const PURPOSE = 'pkw-generated-candidate-operator-v1';
const LIMIT = 16384;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };
export function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`), out = '';
  while (value) { out = alphabet[Number(value % 58n)] + out; value /= 58n; }
  for (const byte of bytes) { if (byte) break; out = '1' + out; }
  return out;
}
async function outsideGit(directory) {
  check(path.isAbsolute(directory), 'Choose an absolute private directory outside repositories');
  for (let current = path.resolve(directory);;) {
    try { await access(path.join(current, '.git')); throw new Error('Private tester state cannot be inside a repository'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
async function privateDirectory(directory, create = false) {
  await outsideGit(directory);
  await outsideGit(path.join(await realpath(path.dirname(directory)), path.basename(directory)));
  if (create) await mkdir(directory, { mode: 0o700 });
  const info = await lstat(directory);
  await outsideGit(await realpath(directory));
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid(), 'Private tester directory must be owned by this user with mode0700');
}
async function privateJson(file) {
  const info = await lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid() && info.size <= LIMIT, 'Invalid private tester file');
  return JSON.parse(await readFile(file, 'utf8'));
}
export async function generate(directory) {
  await privateDirectory(directory, true); // Exclusive directory creation: never adopt an imported identity.
  const pair = generateKeyPairSync('ed25519');
  const wallet = base58(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  await writeFile(path.join(directory, 'operator.json'), JSON.stringify({ purpose: PURPOSE, wallet,
    generatedAt: new Date().toISOString(), privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) }) + '\n', { mode: 0o600, flag: 'wx' });
  return { wallet }; // The public key is needed for the isolated candidate allowlist.
}
export function expectation(value) {
  check(value && Object.keys(value).sort().join(',') === 'manifestFileSha256,nativeBuildSha,nativeVersionCode,packHash,simVersion,sourceCommit', 'Invalid candidate expectation fields');
  check(/^[a-f0-9]{40}$/.test(value.sourceCommit) && /^[a-f0-9]{40}$/.test(value.nativeBuildSha)
    && /^[a-f0-9]{64}$/.test(value.manifestFileSha256) && /^[a-f0-9]{64}$/.test(value.packHash) && value.simVersion === 15
    && Number.isSafeInteger(value.nativeVersionCode) && value.nativeVersionCode > 0, 'Invalid candidate expectation values');
  return value;
}
export function sessionCookie(headers, now = Date.now()) {
  const values = headers.filter(value => value.startsWith('shardkeep_session='));
  check(values.length === 1, 'Expected one full session cookie');
  const cookie = values[0], attrs = cookie.split(';').slice(1).map(value => value.trim());
  check(cookie.length <= 8192 && !/[\r\n]/.test(cookie) && /^shardkeep_session=[A-Za-z0-9._-]+;/.test(cookie)
    && attrs.some(value => /^Secure$/i.test(value)) && attrs.some(value => /^HttpOnly$/i.test(value))
    && attrs.filter(value => /^Path=/i.test(value)).length === 1 && attrs.some(value => /^Path=\/$/i.test(value))
    && !attrs.some(value => /^Domain=/i.test(value)), 'Unsafe session cookie attributes');
  check(cookieDeadline(cookie, now) > now, 'Session cookie has no future expiry');
  return cookie;
}
export function cookieDeadline(cookie, receivedAt) {
  const attrs = cookie.split(';').slice(1).map(value => value.trim());
  const ages = attrs.filter(value => /^Max-Age=/i.test(value));
  const expiries = attrs.filter(value => /^Expires=/i.test(value));
  check(ages.length <= 1 && expiries.length <= 1, 'Ambiguous cookie expiry');
  const deadline = ages.length ? (/^Max-Age=[1-9][0-9]*$/i.test(ages[0]) ? receivedAt + Number(ages[0].slice(8)) * 1000 : NaN)
    : expiries.length ? Date.parse(expiries[0].slice(8)) : NaN;
  check(Number.isSafeInteger(deadline) && deadline > receivedAt, 'Session cookie has no future expiry');
  return deadline;
}
async function request(fetcher, route, options = {}, maxBytes = LIMIT) {
  check(route.startsWith('/') && !route.startsWith('//'), 'Invalid candidate path');
  const response = await fetcher(ORIGIN + route, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', Origin: ORIGIN, ...options.headers } });
  check(response.status === 200, 'Candidate request did not succeed');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
    check(size <= maxBytes, 'Candidate response exceeds bound'); chunks.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  return { response, bytes: Buffer.concat(chunks) };
}
export async function login(directory, expected, fetcher = fetch) {
  await privateDirectory(directory); expectation(expected);
  const output = path.join(directory, 'candidate-session.json');
  try { await lstat(output); throw new Error('Consume or explicitly remove the prior private session file first'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const operator = await privateJson(path.join(directory, 'operator.json'));
  check(operator.purpose === PURPOSE && typeof operator.generatedAt === 'string', 'Not a generated operator identity');
  const key = createPrivateKey(operator.privateKey);
  check(key.asymmetricKeyType === 'ed25519', 'Not an Ed25519 operator');
  const wallet = base58(createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32));
  check(wallet === operator.wallet, 'Generated operator identity changed');
  const capabilities = async cookie => {
    const { bytes } = await request(fetcher, '/api/native/capabilities', { headers: cookie ? { Cookie: cookie.split(';')[0] } : {} });
    const cap = JSON.parse(bytes);
    check(cap.sourceCommit === expected.sourceCommit && cap.simVersion === expected.simVersion
      && Number.isSafeInteger(cap.minimumVersionCode) && cap.minimumVersionCode <= expected.nativeVersionCode
      && cap.contentManifestUrl === `${ORIGIN}/native-content/${expected.packHash}/manifest.json`
      && cap.presentation?.protocolVersions?.includes(2) && cap.presentation?.raidProtocolVersions?.includes(2)
      && (!cookie || cap.presentation.enabled === true), 'Candidate source/content/protocol is not the expected release');
  };
  await capabilities();
  const { bytes: manifest } = await request(fetcher, `/native-content/${expected.packHash}/manifest.json`, {}, 1024 * 1024);
  check(hash(manifest) === expected.manifestFileSha256, 'Candidate manifest bytes differ');
  const parsedManifest = JSON.parse(manifest);
  check(manifestVersion(parsedManifest) === expected.packHash && parsedManifest.contentVersion === expected.packHash
    && parsedManifest.sourceCommit === expected.sourceCommit && parsedManifest.simVersion === expected.simVersion, 'Candidate manifest identity differs');
  const { bytes: challengeBytes } = await request(fetcher, `/api/auth/challenge?wallet=${wallet}`);
  const challenge = JSON.parse(challengeBytes);
  check(typeof challenge.message === 'string' && challenge.message.length > 0 && challenge.message.length <= 8192
    && typeof challenge.nonce === 'string' && challenge.nonce.length <= 1024 && challenge.nonce.length > 0, 'Invalid challenge');
  const signature = base58(sign(null, Buffer.from(challenge.message, 'utf8'), key));
  const verified = await request(fetcher, '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet, nonce: challenge.nonce, signature, client: 'solana-mobile' }) });
  check(JSON.parse(verified.bytes).wallet === wallet, 'Verification returned another identity');
  const receivedAt = Date.now();
  const cookie = sessionCookie(verified.response.headers.getSetCookie(), receivedAt);
  const cookieExpiresAtMs = cookieDeadline(cookie, receivedAt);
  const me = await request(fetcher, '/api/me', { headers: { Cookie: cookie.split(';')[0] } });
  check(JSON.parse(me.bytes).wallet === wallet, 'Authenticated identity differs');
  await capabilities(cookie);
  const input = { purpose: PURPOSE, origin: ORIGIN, wallet, cookie, cookieExpiresAtMs, createdAtMs: Date.now(), expected };
  const bytes = JSON.stringify(input) + '\n'; check(Buffer.byteLength(bytes) <= LIMIT, 'Session input exceeds bound');
  await writeFile(output, bytes, { mode: 0o600, flag: 'wx' });
  return { authenticated: true, sessionFile: output }; // Never print the cookie or challenge.
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, expectationFile, ...extra] = process.argv.slice(2);
  try {
    check(extra.length === 0 && ((mode === 'generate' && !expectationFile) || (mode === 'login' && expectationFile)), 'Use generate <private-directory> or login <private-directory> <expectation.json>');
    const result = mode === 'generate' ? await generate(directory) : await login(directory, expectation(JSON.parse(await readFile(expectationFile, 'utf8'))));
    console.log(JSON.stringify(result));
  } catch { console.error('Candidate tester operation refused or failed. No credentials are printed; retain state for inspection.'); process.exitCode = 1; }
}
