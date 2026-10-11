#!/usr/bin/env node
// Reads an owner-started session. No install, launch, input, logcat, counter reset or app mutation.
import { execFile } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { BUCKETS, requireStat, validateSelection, parseTimeStats, intervalStats,
  percentileBounds, parseHealth, installedIdentity } from './live-seeker-stats.mjs';

export function options(argv) {
  const allowed = ['serial', 'package', 'layer', 'apk', 'out', 'scenario', 'minutes', 'interval-seconds'];
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    requireStat(argv[i]?.startsWith('--') && allowed.includes(key) && !(key in result)
      && argv[i + 1] && !argv[i + 1].startsWith('--'), 'invalid-arguments');
    result[key] = argv[i + 1];
  }
  for (const key of allowed.slice(0, 6)) requireStat(result[key], 'missing-required-argument');
  requireStat(/^[A-Za-z0-9.:_-]{1,128}$/.test(result.serial), 'invalid-serial');
  validateSelection(result.package, result.layer);
  requireStat(['dense-base', 'battle', 'globe', 'mixed'].includes(result.scenario), 'invalid-scenario');
  result.minutes = Number(result.minutes ?? 30); result.interval = Number(result['interval-seconds'] ?? 30);
  requireStat(Number.isInteger(result.minutes) && result.minutes >= 1 && result.minutes <= 30
    && Number.isInteger(result.interval) && result.interval >= 10 && result.interval <= 60
    && result.minutes * 60 % result.interval === 0, 'invalid-duration');
  return result;
}
const execute = promisify(execFile);
export function shellReader(adb, serial) {
  return async (...args) => {
    try { return (await execute(adb, ['-s', serial, 'shell', ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    })).stdout; } catch { throw new Error('device-read-failed'); } // Never print serial, raw shell output or arguments.
  };
}
export async function hashOpenedArtifact(handle, maxBytes = 512 * 1024 * 1024) {
  const info = await handle.stat({ bigint: true });
  requireStat(info.isFile() && info.size > 0n && info.size <= BigInt(maxBytes), 'invalid-apk');
  const hash = createHash('sha256');
  let bytes = 0n;
  for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
    bytes += BigInt(chunk.length);
    requireStat(bytes <= BigInt(maxBytes), 'apk-size-limit');
    hash.update(chunk);
  }
  const after = await handle.stat({ bigint: true });
  requireStat(bytes === info.size && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => after[key] === info[key]), 'apk-changed');
  return hash.digest('hex');
}
async function fileHash(file) {
  const handle = await open(file, 'r');
  try { return await hashOpenedArtifact(handle); } finally { await handle.close(); }
}
export async function verifyArtifact(read, packageName, apkSha256) {
  const paths = (await read('pm', 'path', packageName)).trim().split('\n');
  requireStat(paths.length === 1 && /^package:\/data\/app\/[A-Za-z0-9_./+=~-]+\/base\.apk$/.test(paths[0]), 'split-or-missing-apk');
  const remotePath = paths[0].slice(8);
  requireStat(path.posix.normalize(remotePath) === remotePath, 'invalid-installed-apk-path');
  const remoteHash = (await read('sha256sum', remotePath)).trim().split(/\s+/)[0];
  requireStat(/^[a-f0-9]{64}$/.test(remoteHash) && remoteHash === apkSha256, 'installed-apk-mismatch');
  return installedIdentity(await read('dumpsys', 'package', packageName), packageName);
}
export async function collect(config, read, { now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), stopped = () => false,
  progress = () => {} } = {}) {
  const report = { schemaVersion: 1, scope: 'owner-started-live-single-layer-presentation-histograms',
    scenario: config.scenario, packageName: config.package, apkSha256: config.apkSha256,
    layerSha256: createHash('sha256').update(config.layer).digest('hex'),
    requestedSeconds: config.minutes * 60, intervalSeconds: config.interval,
    status: 'incomplete', acceptance: 'not-certified', bucketsMs: BUCKETS, windows: [], health: [] };
  try {
    report.identity = await verifyArtifact(read, config.package, config.apkSha256);
    const pid = (await read('pidof', config.package)).trim(); requireStat(/^\d+$/.test(pid), 'app-not-running');
    const health = async seconds => {
      // Serial reads bound total memory and never compete with another sample.
      const memory = await read('dumpsys', 'meminfo', config.package);
      const thermal = await read('dumpsys', 'thermalservice');
      const battery = await read('dumpsys', 'battery');
      report.health.push({ seconds, ...parseHealth(memory, thermal, battery) });
    };
    await health(0);
    let previous = parseTimeStats(await read('dumpsys', 'SurfaceFlinger', '--timestats', '-dump'), config.package, config.layer);
    const started = now(); let previousAt = started;
    const total = config.minutes * 60 / config.interval;
    for (let i = 1; i <= total; i++) {
      await sleep(Math.max(0, started + i * config.interval * 1000 - now()));
      requireStat(!stopped(), 'interrupted');
      requireStat((await read('pidof', config.package)).trim() === pid, 'app-process-changed');
      const next = parseTimeStats(await read('dumpsys', 'SurfaceFlinger', '--timestats', '-dump'), config.package, config.layer);
      const at = now(), seconds = (at - previousAt) / 1000;
      requireStat(Math.abs(seconds - config.interval) <= 5, 'sampling-gap');
      report.windows.push({ secondsFromStart: (at - started) / 1000, ...intervalStats(previous, next, seconds) });
      previous = next; previousAt = at;
      if (i === total || i % Math.max(1, Math.floor(60 / config.interval)) === 0) await health((at - started) / 1000);
      progress(i, total);
    }
    requireStat((await read('pidof', config.package)).trim() === pid, 'app-process-changed');
    report.identityAfter = await verifyArtifact(read, config.package, config.apkSha256);
    requireStat((await read('pidof', config.package)).trim() === pid, 'app-process-changed');
    requireStat(JSON.stringify(report.identity) === JSON.stringify(report.identityAfter), 'package-changed');
    const counts = BUCKETS.map((_, i) => report.windows.reduce((sum, window) => sum + window.counts[i], 0));
    report.summary = { p95: percentileBounds(counts, 0.95, 20), p99: percentileBounds(counts, 0.99, 33),
      measuredSeconds: report.windows.reduce((sum, window) => sum + window.seconds, 0),
      minimumWindowPresentedFps: Math.min(...report.windows.map(window => window.averagePresentedFps)),
      maximumPssKiB: Math.max(...report.health.map(sample => sample.totalPssKiB)),
      maximumThermalStatus: Math.max(...report.health.map(sample => sample.thermalStatus)) };
    report.status = 'complete';
  } catch (error) {
    // Only fixed local error codes can enter the artifact, never adb diagnostics.
    report.error = /^[a-z-]{1,64}$/.test(error?.message ?? '') ? error.message : 'collection-failed';
  }
  return report;
}
async function main() {
  const config = options(process.argv.slice(2));
  config.apkSha256 = await fileHash(path.resolve(config.apk));
  const destination = path.resolve(config.out);
  await mkdir(destination, { recursive: false, mode: 0o700 }); // Never overwrite a previous run.
  const adb = process.env.ADB ?? path.join(homedir(), '.bubblewrap/android_sdk/platform-tools/adb');
  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; });
  process.once('SIGTERM', () => { interrupted = true; });
  const report = await collect(config, shellReader(adb, config.serial), { stopped: () => interrupted,
    progress: (n, total) => console.log(`Timing window ${n}/${total} captured`) });
  const serialized = JSON.stringify(report, null, 2) + '\n';
  requireStat(Buffer.byteLength(serialized) <= 1024 * 1024, 'report-size-limit');
  await writeFile(path.join(destination, 'measurement.json'), serialized, { flag: 'wx', mode: 0o600 });
  console.log(`${report.status}; release acceptance remains unclassified`);
  process.exitCode = report.status === 'complete' ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Live collector setup failed; check documented prerequisites. No device diagnostic output was retained.'); process.exitCode = 1; });
}
