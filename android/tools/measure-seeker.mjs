#!/usr/bin/env node
// Observe an already running DEBUG offline fixture. Never launches wallets or unlocks a device.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
const adb = process.env.ADB ?? path.join(homedir(), '.bubblewrap/android_sdk/platform-tools/adb');
const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error('Select the authorized Seeker with ANDROID_SERIAL');
const destination = path.resolve(process.argv[2] ?? '.reports/device/fixture-run');
await mkdir(path.dirname(destination), { recursive: true });
await mkdir(destination, { recursive: false });
const run = (...args) => execFileSync(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 });
const execute = promisify(execFile);
const runAsync = async (...args) => (await execute(adb, ['-s', serial, ...args], { encoding: 'utf8', timeout: 15000 })).stdout;
const pid = run('shell', 'pidof', 'gg.pixelkingdomwars.twa.debug').trim();
if (!/^\d+$/.test(pid)) throw new Error('Start the native debug offline fixture first');
const records = new Map();
const snapshots = [];
const pendingSnapshots = [];
const collectorStartedAt = new Date().toISOString();
const model = run('shell', 'getprop', 'ro.product.model').trim();
const android = run('shell', 'getprop', 'ro.build.version.release').trim();
const log = spawn(adb, ['-s', serial, 'logcat', '--pid=' + pid, '-v', 'raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
let buffer = '', finished = false;
async function finish(status) {
  if (finished) return;
  finished = true; clearTimeout(timeout); log.kill();
  await Promise.all(pendingSnapshots);
  await writeFile(path.join(destination, 'frames.json'), JSON.stringify({ schemaVersion: 1, status, collectorStartedAt,
    collectorCompletedAt: new Date().toISOString(), model, android, fixture: 'mixed_assault',
    timingNote: 'Logcat includes earlier reports from this same process; sum activeSeconds for renderer duration, not collector wall time.',
    scope: 'Debug repeating sparse canonical fixture; not production performance certification',
    records: [...records.values()], snapshots }, null, 2) + '\n');
  console.log(`${status}: ${records.size} minute reports captured at ${destination}`);
  process.exitCode = status === 'complete' ? 0 : 1;
}
const timeout = setTimeout(() => void finish('timeout'), 35 * 60 * 1000);
log.stdout.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n'); buffer = lines.pop();
  for (const line of lines) {
    if (finished) break;
    if (!line.startsWith('{"schemaVersion":1,"sequence":')) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    if (record.activeScene !== 'battle' || records.has(record.sequence)) continue;
    records.set(record.sequence, record);
    if (records.size === 1 || records.size % 5 === 0) {
      const snapshot = { sequence: record.sequence, observedAt: new Date().toISOString() };
      snapshots.push(snapshot);
      pendingSnapshots.push(Promise.all([
        runAsync('shell', 'dumpsys', 'meminfo', 'gg.pixelkingdomwars.twa.debug'),
        runAsync('shell', 'dumpsys', 'thermalservice'), runAsync('shell', 'dumpsys', 'battery'),
      ]).then(([memory, thermal, battery]) => Object.assign(snapshot, { memory, thermal, battery }))
        .catch(() => { snapshot.error = 'Device snapshot unavailable; frame records preserved'; }));
    }
    console.log(`Minute ${records.size}: p95 ${record.steady.p95Ms} ms; p99 ${record.steady.p99Ms} ms; ${record.averageFps} FPS`);
    if (records.size >= 30) void finish('complete');
  }
});
log.on('exit', () => { if (!finished) void finish('device-disconnected'); });
log.on('error', () => { if (!finished) void finish('adb-error'); });
process.on('SIGINT', () => void finish('interrupted'));
