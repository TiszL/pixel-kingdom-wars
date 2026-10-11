import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { Readable } from 'node:stream';
import { APPLICATION_ID } from './release-policy.mjs';

// Backend M45 §1-§4. The API owns validation too; these checks stop a bad file
// before it is uploaded, because an uploaded object is never overwritten.
export const R2_KEYS = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'];
export const CHANNELS = ['tester', 'stable'];
export const MAX_APK_BYTES = 314572800;
export const APK_CONTENT_TYPE = 'application/vnd.android.package-archive';
export const APK_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const DEFAULT_REMOTE_EXEC = 'cd ~/shardkeep && docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml exec -T api';
const CLI = 'node --import tsx src/native/updateChannelCli.ts';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const hex = (length) => new RegExp(`^[a-f0-9]{${length}}$`);

/** Credentials come only from the env FILE, never process.env. Errors name keys, never values. */
export function parseR2Env(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !R2_KEYS.includes(match[1])) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const missing = R2_KEYS.filter((key) => !values[key]);
  if (missing.length) throw new Error(`R2 environment file is missing ${missing.join(', ')}`);
  return { endpoint: values.R2_ENDPOINT.replace(/\/$/, ''), accessKeyId: values.R2_ACCESS_KEY_ID,
    secretAccessKey: values.R2_SECRET_ACCESS_KEY, bucket: values.R2_BUCKET, publicBaseUrl: values.R2_PUBLIC_BASE_URL.replace(/\/$/, '') };
}

export function apkObjectKey(code, sha256) {
  // Production Caddy proxies only ^/native/releases/[0-9]{1,6}-[0-9a-f]{64}\.apk$.
  if (!Number.isSafeInteger(code) || code < 1 || code > 999999 || !hex(64).test(sha256 ?? '')) throw new Error('Invalid channel APK identity');
  return `native/releases/${code}-${sha256}.apk`;
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function readReceipt(apk) {
  try { return JSON.parse(await readFile(`${apk}.json`, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') throw new Error('Missing signing receipt for channel APK'); throw e; }
}

/** One signer only: the client compares a single running signer to the offer. */
export function signerSha256FromApksigner(text) {
  const matches = [...text.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([A-Fa-f0-9:]+)$/gm)];
  if (matches.length !== 1) throw new Error('Channel APK must have exactly one signer');
  const signer = matches[0][1].replaceAll(':', '').toLowerCase();
  if (!hex(64).test(signer)) throw new Error('Cannot read the APK signer SHA-256');
  return signer;
}

export function signV4({ method, url, headers = {}, payloadHash, accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date() }) {
  const target = new URL(url);
  if (target.search) throw new Error('Signed R2 requests carry no query string');
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const signed = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const canonical = { ...signed, host: target.host };
  const names = Object.keys(canonical).sort();
  const request = [method, target.pathname, '', ...names.map((name) => `${name}:${canonical[name]}`), '', names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(request).digest('hex')].join('\n');
  let key = `AWS4${secretAccessKey}`;
  for (const part of [day, region, service, 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...signed, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const signedFetch = (fetchImpl, r2, url, method, headers, payloadHash, init = {}) => fetchImpl(url, { method, ...init,
  headers: signV4({ method, url, headers, payloadHash, accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey }) });

/** HEAD proves the served length; a full streamed GET proves the served bytes. */
export async function readBackApk({ url, expectedSha256, expectedSize, fetchImpl = fetch, signed }) {
  const request = (method) => signed ? signedFetch(fetchImpl, signed, url, method, {}, EMPTY_SHA256) : fetchImpl(url, { method });
  const head = await request('HEAD');
  if (!head.ok) throw new Error(`Read-back HEAD failed with HTTP ${head.status}: ${url}`);
  if (head.headers.get('content-length') !== String(expectedSize)) throw new Error(`Read-back size mismatch: ${url}`);
  const response = await request('GET');
  if (!response.ok || !response.body) throw new Error(`Read-back GET failed with HTTP ${response.status}: ${url}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) { hash.update(chunk); size += chunk.length; }
  if (size !== expectedSize) throw new Error(`Read-back size mismatch: ${url}`);
  if (hash.digest('hex') !== expectedSha256) throw new Error(`Read-back sha256 mismatch: ${url}`);
  return { sha256: expectedSha256, size };
}

/** Never overwrites: 412 is success only when the occupying object is these exact bytes. */
export async function uploadApk({ r2, key, path, sha256, size, fetchImpl = fetch }) {
  const url = `${r2.endpoint}/${r2.bucket}/${key}`;
  const response = await signedFetch(fetchImpl, r2, url, 'PUT', { 'content-type': APK_CONTENT_TYPE, 'cache-control': APK_CACHE_CONTROL,
    'if-none-match': '*', 'content-length': size }, sha256, { body: Readable.toWeb(createReadStream(path)), duplex: 'half' });
  if (response.status === 412) {
    try { await readBackApk({ url, expectedSha256: sha256, expectedSize: size, fetchImpl, signed: r2 }); }
    catch { throw new Error(`A different object already occupies ${key}; refusing to publish`); }
    return 'exists';
  }
  if (!response.ok) throw new Error(`R2 upload failed with HTTP ${response.status}`);
  return 'uploaded';
}

/** The CLI manifest of M45 §2, in its exact key order. */
export function buildManifest({ badging, receipt, sha256, size, signer, channel, mandatory = false, notesUrl = null, createdBy }) {
  if (badging.applicationId !== APPLICATION_ID) throw new Error('Channel APK package differs from the store listing');
  if (!receipt || receipt.sha256 !== sha256 || receipt.versionCode !== badging.versionCode) throw new Error('Signing receipt does not identify this exact APK');
  // sourceCommit is the NATIVE commit that was signed, not the receipt's client-pack sourceCommit.
  if (!hex(40).test(receipt.nativeCommit ?? '')) throw new Error('Signing receipt has no native commit');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(badging.versionName)) throw new Error('Channel versionName must be numeric major.minor.patch');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_APK_BYTES) throw new Error('Channel APK size is outside 1..300 MiB');
  if (!hex(64).test(sha256 ?? '') || !hex(64).test(signer ?? '')) throw new Error('Channel digests must be lowercase SHA-256 hex');
  if (!CHANNELS.includes(channel)) throw new Error('Channel must be tester or stable');
  if (typeof mandatory !== 'boolean') throw new Error('mandatory must be boolean');
  if (notesUrl !== null && !/^https:\/\/[^\s]+$/.test(notesUrl)) throw new Error('notesUrl must be an https URL');
  if (typeof createdBy !== 'string' || !createdBy.trim()) throw new Error('createdBy is required');
  return { versionCode: badging.versionCode, versionName: badging.versionName, sourceCommit: receipt.nativeCommit, sha256,
    sizeBytes: size, signerSha256: signer, channel, mandatory, notesUrl, createdBy };
}

/** Refused before the file is read: only committed source and in-repo signed release files publish. */
export function assertChannelPreflight({ porcelain, apk, releasesDir }) {
  if (porcelain.trim()) throw new Error('Commit and review all native source before publishing');
  if (!apk.startsWith(releasesDir + sep) || !apk.endsWith('.apk')) throw new Error('Channel APK must be in this repository release directory');
}

/** Stable is what every player is offered. The owner's written go for stable is a chat gate the tool cannot
 * read, so the operator states it explicitly; tester needs nothing beyond the signed receipt. */
export function assertStableApproval({ channel, approved }) {
  if (channel !== 'stable') return;
  if (approved !== true) throw new Error('Stable channel requires --owner-approved, passed only after the owner\'s written go for stable');
}

/** The file being published is already in local inventory (releases/ and its store mirror). Only an entry
 * with the same code AND the same bytes is this file; any other file keeps its code in the comparison. */
export async function otherKnownEntries(known, { versionCode, sha256 }, hashFile = sha256File) {
  const others = [];
  for (const entry of known) if (entry.versionCode !== versionCode || await hashFile(entry.path) !== sha256) others.push(entry);
  return others;
}

/** Rows are never deleted, so every refusal here protects an immutable public record. */
export function assertPublishable({ knownCodes, remoteRows, code, sha256, channel, signer, expectSigner }) {
  if (!CHANNELS.includes(channel)) throw new Error('Channel must be tester or stable');
  if (signer !== expectSigner) throw new Error('APK signer does not match the expected update signer');
  const rows = remoteRows ?? [];
  const latest = rows.reduce((best, row) => (!best || row.versionCode > best.versionCode ? row : best), undefined);
  if (latest && latest.signerSha256 !== signer) throw new Error('APK signer differs from the latest channel release');
  const same = rows.find((row) => row.versionCode === code);
  if (same) {
    if (same.sha256 !== sha256) throw new Error(`Channel code ${code} is already published with different bytes`);
    if (same.channel === 'stable' && channel === 'tester') throw new Error('A stable release cannot move back to tester');
    if (same.channel === 'tester' && channel === 'stable') return { promotion: true };
    throw new Error(`Channel code ${code} is already published on ${same.channel}`);
  }
  const maximum = Math.max(0, ...knownCodes, ...rows.map((row) => row.versionCode));
  if (!Number.isSafeInteger(code) || code <= maximum) throw new Error(`Channel versionCode must be greater than ${maximum}`);
  return { promotion: false };
}

/** Remote `show` output: the backend prints listNativeUpdates() as a bare JSON array of
 * NativeUpdateOffer objects (M45 §1 wire shape, keyed latestVersionCode). Mapped to the
 * { versionCode, sha256, signerSha256, channel } rows assertPublishable compares. */
export function parseShowRows(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Remote show did not print channel rows as JSON'); }
  if (!Array.isArray(value) || value.some((row) => !Number.isSafeInteger(row?.latestVersionCode) || row.latestVersionCode < 1 ||
      !hex(64).test(row.sha256 ?? '') || !hex(64).test(row.signerSha256 ?? '') || !CHANNELS.includes(row.channel))) {
    throw new Error('Remote show did not print channel rows as JSON');
  }
  return value.map((row) => ({ versionCode: row.latestVersionCode, sha256: row.sha256, signerSha256: row.signerSha256, channel: row.channel }));
}

/** Idempotent: an equal manifest is reused; only a tester->stable promotion of the same file may replace it. */
export async function writeChannelManifest(file, manifest) {
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o644 }); return 'written'; }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  const existing = JSON.parse(await readFile(file, 'utf8'));
  if (JSON.stringify(existing, null, 2) + '\n' === bytes) return 'reused';
  const changed = Object.keys({ ...existing, ...manifest }).filter((key) => existing[key] !== manifest[key]);
  if (existing.channel !== 'tester' || manifest.channel !== 'stable' ||
      changed.some((key) => !['channel', 'mandatory', 'createdBy'].includes(key)) || (existing.mandatory && !manifest.mandatory)) {
    throw new Error(`Existing channel manifest differs: ${file}`);
  }
  const next = `${file}.promote-${process.pid}`;
  const handle = await open(next, 'wx', 0o644);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(next, file);
  return 'promoted';
}

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

export function remoteCommand({ remote, remoteExec = DEFAULT_REMOTE_EXEC, args = ['publish', '--manifest', '-'], stdinFile }) {
  // ssh treats a leading '-' as an option; a quote would break the printed command.
  if ((remote !== undefined && !/^[A-Za-z0-9._@-]+$/.test(remote)) || remote?.startsWith('-')) throw new Error('Invalid --remote');
  if (remoteExec.includes("'")) throw new Error('--remote-exec must not contain single quotes');
  const command = `${remoteExec} ${CLI} ${args.join(' ')}`;
  // The printed stdin path is quoted: a checkout path may contain spaces.
  const text = `ssh ${remote ?? '<user@host>'} '${command}'${stdinFile === undefined ? '' : ` < ${shellQuote(stdinFile)}`}`;
  return { file: 'ssh', args: [remote, command], command, text };
}

export function runRemote({ remote, remoteExec, args, input = '', spawnImpl = spawn }) {
  if (!remote) throw new Error('Missing --remote');
  const { file, args: argv } = remoteCommand({ remote, remoteExec, args });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/PASSWORD|SECRET|TOKEN|PRIVATE_KEY/i.test(key)) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(file, argv, { stdio: ['pipe', 'pipe', 'inherit'], env });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`Remote update-channel ${args?.[0] ?? 'publish'} exited with ${code}`)));
    child.stdin.end(input);
  });
}

export const runRemotePublish = ({ manifest, remote, remoteExec, spawnImpl }) =>
  runRemote({ remote, remoteExec, input: JSON.stringify(manifest) + '\n', spawnImpl });
