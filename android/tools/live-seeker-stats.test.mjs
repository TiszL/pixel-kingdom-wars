import assert from 'node:assert/strict';
import test from 'node:test';
import { BUCKETS, parseTimeStats, intervalStats, percentileBounds, parseHealth, installedIdentity } from './live-seeker-stats.mjs';
import { options, collect, verifyArtifact, hashOpenedArtifact } from './measure-live-seeker.mjs';

const pkg = 'gg.pixelkingdomwars.twa.debug';
const layer = `SurfaceView[${pkg}/gg.pixelkingdomwars.nativeclient.MainActivity]@0(BLAST)#123`;
const digest = 'a'.repeat(64);
const distribution = (bucket = 17, frames = 600) => BUCKETS.map(n => n === bucket ? frames : 0);
// AOSP TimeStatsHelper text shape, including its global histogram and layer sections.
function dump({ end = 100, frames = 600, bucket = 17, name = layer, start = 1, dropped = 0 } = {}) {
  return `SurfaceFlinger TimeStats:\nLegacy stats are as follows:\nstatsStart = ${start}\nstatsEnd = ${end}\ntotalFrames = 9999\npresentToPresent histogram is as below:\n0ms=0\ndisplayRefreshRate = 60 fps\nlayerName = ${name}\npackageName = ${pkg}\ntotalFrames = ${frames}\ndroppedFrames = ${dropped}\npresent2present histogram is as below:\n${BUCKETS.map((n, i) => `${n}ms=${distribution(bucket, frames)[i]}`).join(' ')}\n`;
}
const packageDump = `Packages:\n  Package [${pkg}] (123):\n    versionCode=13 minSdk=28 targetSdk=36\n    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]\n`;
const health = ['TOTAL PSS: 123456 TOTAL RSS: 200000', 'IsStatusOverride: false\nThermal Status: 0\nHAL Ready: true', 'level: 80\nscale: 100\ntemperature: 320'];
const config = { package: pkg, layer, apkSha256: digest, scenario: 'battle', minutes: 1, interval: 10 };

test('explicit selection is required and unknown/repeated/dangerous arguments refuse', () => {
  const args = ['--serial', 'PRIVATE_SERIAL', '--package', pkg, '--layer', layer, '--apk', '/artifact.apk', '--out', '/report', '--scenario', 'battle'];
  assert.equal(options(args).minutes, 30);
  for (const tail of [['--clear', 'true'], ['--minutes', '31'], ['--serial', 'again'], ['--interval-seconds', '0']]) {
    assert.throws(() => options([...args, ...tail]));
  }
  assert.throws(() => options(args.slice(2)), /missing-required/);
  assert.throws(() => options(args.map(v => v === layer ? 'SurfaceView[other/private]' : v)), /layer-package/);
});
test('selected layer excludes global/unrelated counts and requires an exact unambiguous match', () => {
  assert.equal(parseTimeStats(dump(), pkg, layer).frames, 600);
  assert.throws(() => parseTimeStats(dump({ name: layer + '-other' }), pkg, layer), /missing-layer/);
  assert.throws(() => parseTimeStats(dump() + dump().slice(dump().indexOf('layerName')), pkg, layer), /ambiguous-layer/);
  assert.throws(() => parseTimeStats(dump().replace(`packageName = ${pkg}`, 'packageName = other'), pkg, layer), /layer-package/);
  assert.throws(() => parseTimeStats('Permission Denial: PRIVATE_VALUE', pkg, layer), /missing-layer/);
});
test('unknown/truncated/duplicate buckets cannot silently become perfect frame timing', () => {
  for (const text of [dump().replace('17ms=600', '17ms=-1'), dump().replace('34ms=0', '35ms=0'),
    dump().replace('17ms=600', ''), dump().replace('17ms=600', '17ms=600 17ms=600'),
    dump().replace('present2present', 'renderEngineTiming'), dump({ start: 0 })]) {
    assert.throws(() => parseTimeStats(text, pkg, layer));
  }
});
test('p95 bucket20 and p99 bucket33 cannot falsely prove exact release limits', () => {
  assert.deepEqual(percentileBounds(distribution(20), 0.95, 20), {
    bucketMs: 20, lowerInclusiveMs: 20, upperExclusiveMs: 21, limitMs: 20, verdict: 'inconclusive',
  });
  assert.equal(percentileBounds(distribution(33), 0.99, 33).verdict, 'inconclusive');
  assert.equal(percentileBounds(distribution(19), 0.95, 20).verdict, 'within-bound');
  assert.equal(percentileBounds(distribution(21), 0.95, 20).verdict, 'exceeds-bound');
  assert.equal(percentileBounds(distribution(1000), 0.99, 33).upperExclusiveMs, null);
  assert.throws(() => percentileBounds(distribution(17, 0), 0.95, 20), /no-new-frames/);
});
test('only counters after baseline count; reset, clock jump, gaps and missing/dropped frames refuse', () => {
  const before = parseTimeStats(dump(), pkg, layer);
  const after = parseTimeStats(dump({ end: 110, frames: 1200 }), pkg, layer);
  const result = intervalStats(before, after, 10);
  assert.equal(result.frames, 600); assert.equal(result.samples, 600); assert.equal(result.averagePresentedFps, 60);
  for (const invalid of [{ ...after, start: 2 }, { ...after, end: 99 }, { ...after, end: 150 },
    { ...after, counts: before.counts, frames: before.frames }, { ...after, frames: 1300 },
    { ...after, dropped: 1 }, { ...after, counts: distribution(17, 500) }]) {
    assert.throws(() => intervalStats(before, invalid, 10));
  }
  assert.throws(() => intervalStats(before, after, 100), /sampling-gap/);
});
test('thermal override/missing HAL and absent memory are not healthy readings', () => {
  assert.deepEqual(parseHealth(...health), { totalPssKiB: 123456, thermalStatus: 0, batteryTemperatureC: 32, batteryPercent: 80 });
  for (const values of [['', health[1], health[2]], [health[0], health[1].replace('Override: false', 'Override: true'), health[2]],
    [health[0], health[1].replace('Ready: true', 'Ready: false'), health[2]], [health[0], health[1], 'temperature: 320']]) {
    assert.throws(() => parseHealth(...values), /health/);
  }
});
test('installed package must be explicitly non-debuggable with unambiguous metadata', () => {
  assert.deepEqual(installedIdentity(packageDump, pkg), { packageName: pkg, versionCode: 13, debuggable: false });
  assert.throws(() => installedIdentity(packageDump.replace('HAS_CODE', 'HAS_CODE DEBUGGABLE'), pkg));
  assert.throws(() => installedIdentity(packageDump.replace('flags=', 'unknown='), pkg));
  assert.throws(() => installedIdentity(packageDump + '\nversionCode=14', pkg));
});
function harness({ mutate = () => {}, slow = false } = {}) {
  let clock = 0, snapshots = 0, pidReads = 0;
  const commands = [];
  const read = async (...args) => {
    commands.push(args); const command = args.join(' ');
    let result;
    if (args[0] === 'pm') result = 'package:/data/app/~~PRIVATE_PATH==/gg.pixelkingdomwars.twa.debug-install==/base.apk';
    else if (args[0] === 'sha256sum') result = `${digest} /data/app/~~PRIVATE_PATH==/gg.pixelkingdomwars.twa.debug-install==/base.apk`;
    else if (args[0] === 'pidof') { pidReads++; result = '1234'; }
    else if (args[1] === 'package') result = packageDump;
    else if (args[1] === 'SurfaceFlinger') result = dump({ end: 100 + snapshots * 10, frames: 600 * ++snapshots, bucket: slow ? 50 : 17 });
    else if (args[1] === 'meminfo') result = health[0] + '\nPRIVATE_MEMORY_TEXT';
    else if (args[1] === 'thermalservice') result = health[1] + '\nPRIVATE_THERMAL_TEXT';
    else if (args[1] === 'battery') result = health[2] + '\nPRIVATE_BATTERY_TEXT';
    else throw new Error('unexpected-command');
    return mutate({ command, result, snapshots, pidReads }) ?? result;
  };
  return { read, commands, runtime: { now: () => clock, sleep: async ms => { clock += ms; } } };
}
test('read-only live run binds exact artifact, emits anonymous numbers and never certifies release', async () => {
  const h = harness(); const report = await collect(config, h.read, h.runtime);
  assert.equal(report.status, 'complete'); assert.equal(report.acceptance, 'not-certified');
  assert.equal(report.windows.length, 6); assert.equal(report.summary.measuredSeconds, 60);
  assert.equal(report.summary.p95.verdict, 'within-bound');
  const json = JSON.stringify(report);
  for (const privateValue of ['PRIVATE_', layer, '"pid":', 'serial']) assert.equal(json.includes(privateValue), false);
  assert.ok(h.commands.every(args => ['pm', 'sha256sum', 'pidof', 'dumpsys'].includes(args[0])));
  assert.ok(h.commands.every(args => !args.some(arg => /^(?:-clear|-enable|-disable|logcat|install|start|input|force-stop)$/.test(arg))));
});
test('remote APK paths reject traversal and shell metacharacters before any hash command', async () => {
  for (const remote of ['/data/app/../../private/base.apk', '/data/app/private/../base.apk',
    '/data/app/private;echo_SECRET/base.apk', '/data/app/$(echo_SECRET)/base.apk', '/data/app/private space/base.apk']) {
    const calls = [];
    await assert.rejects(verifyArtifact(async (...args) => { calls.push(args); return `package:${remote}`; }, pkg, digest));
    assert.deepEqual(calls, [['pm', 'path', pkg]]);
  }
});
test('opened artifact hashing bounds actual streamed bytes and rejects changes to the same handle', async () => {
  const metadata = { dev: 1n, ino: 2n, size: 3n, mtimeNs: 4n, ctimeNs: 5n, isFile: () => true };
  function handle(chunks, changed = {}) {
    let reads = 0;
    return { stat: async () => ({ ...metadata, ...(reads++ ? changed : {}) }),
      createReadStream: async function* () { for (const chunk of chunks) yield Buffer.from(chunk); } };
  }
  assert.equal((await hashOpenedArtifact(handle(['abc']), 4)).length, 64);
  await assert.rejects(hashOpenedArtifact(handle(['abc', 'def']), 4), /apk-size-limit/);
  await assert.rejects(hashOpenedArtifact(handle(['abc']), 2), /invalid-apk/);
  await assert.rejects(hashOpenedArtifact(handle(['ab']), 4), /apk-changed/);
  for (const changed of [{ size: 4n }, { mtimeNs: 6n }, { ctimeNs: 7n }, { ino: 8n }]) {
    await assert.rejects(hashOpenedArtifact(handle(['abc'], changed), 4), /apk-changed/);
  }
});
test('restart during the last sample or final APK verification cannot complete collection', async () => {
  for (const phase of ['last-sample', 'last-health', 'verification']) {
    let restarted = false, hashReads = 0;
    const h = harness({ mutate: ({ command, result, snapshots }) => {
      if (phase === 'last-sample' && command.includes('SurfaceFlinger') && snapshots === 7) restarted = true;
      if (phase === 'last-health' && command.includes('battery') && snapshots === 7) restarted = true;
      if (command.startsWith('sha256sum')) { hashReads++; if (phase === 'verification' && hashReads === 2) restarted = true; }
      return command.startsWith('pidof') && restarted ? '9876' : result;
    } });
    const report = await collect(config, h.read, h.runtime);
    assert.equal(report.status, 'incomplete'); assert.equal(report.error, 'app-process-changed');
    assert.equal(report.summary, undefined); assert.equal(report.acceptance, 'not-certified');
  }
});
test('complete collection can contain failed timing: exit completion is never performance acceptance', async () => {
  const h = harness({ slow: true }); const report = await collect(config, h.read, h.runtime);
  assert.equal(report.status, 'complete'); assert.equal(report.summary.p95.verdict, 'exceeds-bound');
  assert.equal(report.acceptance, 'not-certified');
});
test('artifact mismatch/splits and process replacement stop without exposing diagnostic strings', async () => {
  for (const mutate of [({ command }) => command.startsWith('sha256sum') ? 'b'.repeat(64) : undefined,
    ({ command, result }) => command.startsWith('pm ') ? `${result}\npackage:/data/app/split.apk` : undefined,
    ({ command, pidReads }) => command.startsWith('pidof') && pidReads > 1 ? '9876' : undefined]) {
    const h = harness({ mutate }); const report = await collect(config, h.read, h.runtime);
    assert.equal(report.status, 'incomplete'); assert.equal(report.summary, undefined);
    assert.equal(report.acceptance, 'not-certified'); assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  }
});
test('interrupt, slow sampling, unavailable counters and command failure preserve honest incomplete evidence', async () => {
  for (const kind of ['interrupt', 'gap', 'missing', 'command']) {
    const h = harness({ mutate: ({ command, snapshots }) => {
      if (kind === 'missing' && command.includes('SurfaceFlinger') && snapshots > 1) return 'unsupported';
      if (kind === 'command' && command.includes('SurfaceFlinger')) throw new Error('PRIVATE_SERIAL auth=PRIVATE_SECRET');
    } });
    if (kind === 'interrupt') h.runtime.stopped = () => true;
    if (kind === 'gap') { let time = 0; h.runtime.now = () => time; h.runtime.sleep = async () => { time += 90000; }; }
    const report = await collect(config, h.read, h.runtime);
    assert.equal(report.status, 'incomplete'); assert.equal(report.summary, undefined);
    assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  }
});
