import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AVD, AVD_GPU, EXIT, LOCK_DIR, MIN_FREE_BYTES, Refusal, acquireLock, avdConfigProblems, createAvd, diskRefusal, guardedRun, launchCommand,
  otherEmulators, releaseLock, rendererVerdict,
} from './emulator-guard.mjs';

// Why these tests exist: on 2026-09-24 a WebGL page hung the owner's whole Mac through the real GPU (RM-GPU-1,
// D-168.3). The guard is the only sanctioned emulator launcher, so every refusal below is a hang it prevents. No test
// boots an emulator: adb, ps and the emulator process are fakes.

const SWIFTSHADER_SF = 'Display 0 HWC layers:\nGLES: Google (Google Inc.), Android Emulator OpenGL ES Translator (Google SwiftShader), OpenGL ES 3.0 (4.5.0 SwiftShader 4.0.0.1)\n';
const HOST_GPU_SF = 'GLES: Google (Apple), Android Emulator OpenGL ES Translator (Apple M3 Pro), OpenGL ES 3.0 (4.1 Metal - 89.3)\n';
const GFX_GL = '** Graphics info for pid 812 [com.android.systemui] **\nPipeline=Skia (OpenGL)\n';
const GFX_VK = '** Graphics info for pid 812 [com.android.systemui] **\nPipeline=Skia (Vulkan)\n';
const SDK = '/sdk', ADB = '/sdk/platform-tools/adb';

const GB = 1024 ** 3;
// freeGB: the successive free-disk readings in GB (the last repeats); a function stands for a reading that throws
function world({ adbDevices = 'List of devices attached\n', ps = '', surfaceFlinger = SWIFTSHADER_SF, hwui = '', gfxinfo = GFX_GL, bootAfter = 1, lockOwner = null, ownerAlive = true, commandStatus = 0, freeGB = [8] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-guard-test-'));
  const avdHome = path.join(tmp, 'avd'), lockDir = path.join(tmp, 'lock');
  fs.mkdirSync(path.join(avdHome, `${AVD}.avd`), { recursive: true });
  fs.writeFileSync(path.join(avdHome, `${AVD}.avd`, 'config.ini'), 'hw.gpu.enabled=yes\nhw.gpu.mode=swiftshader_indirect\n');
  if (lockOwner) { fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'pid'), String(lockOwner)); }
  const calls = [], spawned = [];
  let booted = false, polls = 0, resolveExit;
  const exec = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    if (cmd === ADB && args[0] === 'devices') return { status: 0, stdout: booted ? `${adbDevices}emulator-5580\tdevice\n` : adbDevices };
    if (cmd === '/bin/ps') return { status: 0, stdout: ps };
    if (cmd === ADB && args[0] === '-s') {
      const rest = args.slice(2).join(' ');
      if (rest === 'shell getprop sys.boot_completed') { polls++; booted = polls >= bootAfter; return { status: 0, stdout: booted ? '1\n' : '' }; }
      if (rest === 'shell dumpsys SurfaceFlinger') return { status: 0, stdout: surfaceFlinger };
      if (rest === 'shell getprop debug.hwui.renderer') return { status: 0, stdout: hwui };
      if (rest === 'shell dumpsys gfxinfo com.android.systemui') return { status: 0, stdout: gfxinfo };
      if (rest === 'emu kill') { resolveExit?.(0); return { status: 0, stdout: 'OK' }; }
    }
    if (cmd === '/usr/sbin/taskpolicy') return { status: commandStatus, stdout: '' };
    return { status: 1, stdout: '', stderr: `unexpected ${cmd} ${args.join(' ')}` };
  };
  const deps = {
    platform: 'darwin', sdk: SDK, avdHome, pid: 4242, exec, lockDir, log: () => {},
    spawn: (cmd, args) => { const exited = new Promise(r => { resolveExit = r; }); const child = { cmd, args, pid: 777, exited, killed: [], kill: s => { child.killed.push(s); resolveExit(137); } }; spawned.push(child); return child; },
    portFree: async () => true, sleep: async () => {}, now: () => 0, alive: pid => (pid === lockOwner ? ownerAlive : pid === 4242),
    freeBytes: () => { if (typeof freeGB === 'function') return freeGB(); const gb = freeGB.length > 1 ? freeGB.shift() : freeGB[0]; return gb * GB; },
  };
  return { deps, calls, spawned, lockDir, avdHome, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
const kills = calls => calls.filter(c => c.args.includes('kill'));
const commandRuns = calls => calls.filter(c => c.cmd === '/usr/sbin/taskpolicy');

test('the launch is SwiftShader-only, Vulkan-off, headless, cold, on its own port, under background QoS', () => {
  const { command, args, serial } = launchCommand({ emulator: '/sdk/emulator/emulator', port: 5580, platform: 'darwin' });
  assert.equal(command, '/usr/sbin/taskpolicy');
  assert.deepEqual(args, ['-b', '/sdk/emulator/emulator', '-avd', 'pkw_native_globe_sw', '-port', '5580', '-gpu', 'swiftshader_indirect',
    '-feature', '-Vulkan', '-no-window', '-no-snapshot', '-no-boot-anim', '-partition-size', '4096']);
  // -no-snapshot-load alone boots cold but still auto-saves a RAM-sized snapshot on exit (emulator -help); the Mac's disk
  // is nearly full, so the guard must never write one
  assert.ok(!args.includes('-no-snapshot-load') && !args.some(a => a === '-snapshot'), 'no snapshot is ever saved or loaded');
  // the AVD's 10 GB userdata default refuses to boot below 12 GB free and would let the guest fill the disk
  assert.ok(Number(args[args.indexOf('-partition-size') + 1]) <= 4096, 'the guest userdata is capped');
  assert.equal(serial, 'emulator-5580');
  // no other host has taskpolicy; an odd or out-of-range port would collide with another emulator's adb pair
  assert.throws(() => launchCommand({ emulator: 'e', port: 5580, platform: 'linux' }), Refusal);
  for (const port of [5581, 5552, 5684, NaN]) assert.throws(() => launchCommand({ emulator: 'e', port, platform: 'darwin' }), Refusal);
});

test('any other emulator is seen: adb serials and emulator or qemu processes adb does not list yet', () => {
  const ps = [
    '  101 /usr/bin/node tools/emulator-guard.mjs run -- ./gradlew', // a guard is node, not an emulator
    '  202 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -avd pkw_native_render',
    '  303 /sdk/emulator/emulator -avd pkw_native_api36',
    '  404 /usr/sbin/netsimd',
  ].join('\n');
  assert.deepEqual(otherEmulators({ adbDevices: 'List of devices attached\nemulator-5554\tdevice\nR58M1234\tdevice\n', processes: ps, ownPid: 1 }),
    ['adb emulator-5554', 'pid 202 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless', 'pid 303 /sdk/emulator/emulator']);
  assert.deepEqual(otherEmulators({ adbDevices: 'List of devices attached\n', processes: '  101 /usr/bin/node x\n', ownPid: 1 }), []);
});

test('refuses when another emulator is running: nothing spawned, nothing killed, lock untouched', async () => {
  for (const setup of [{ adbDevices: 'List of devices attached\nemulator-5554\tdevice\n' }, { ps: '  202 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd pkw_native_api36\n' }]) {
    const w = world(setup);
    try {
      await assert.rejects(guardedRun({ command: ['true'], deps: w.deps }), e => e instanceof Refusal && e.code === EXIT.refused && /Another emulator/.test(e.message));
      assert.equal(w.spawned.length, 0);
      assert.deepEqual(kills(w.calls), [], 'the guard never kills an emulator it did not start');
      assert.equal(fs.existsSync(w.lockDir), false);
    } finally { w.cleanup(); }
  }
});

test('refuses a renderer that is not SwiftShader and kills only its own serial before any install or test', async () => {
  for (const setup of [{ surfaceFlinger: HOST_GPU_SF }, { gfxinfo: GFX_VK }, { hwui: 'skiavk\n' }, { surfaceFlinger: 'no gles here\n' }, { gfxinfo: '' }]) {
    const w = world(setup);
    try {
      await assert.rejects(guardedRun({ command: ['./gradlew', 'connectedDebugAndroidTest'], deps: w.deps }), e => e.code === EXIT.renderer);
      assert.equal(w.spawned.length, 1);
      assert.deepEqual(kills(w.calls).map(c => c.args), [['-s', 'emulator-5580', 'emu', 'kill']]);
      assert.deepEqual(commandRuns(w.calls), [], 'the command (install/test) never ran');
      assert.equal(fs.existsSync(w.lockDir), false, 'the shared CPU lock is released');
    } finally { w.cleanup(); }
  }
});

test('the renderer verdict fails closed and names what it saw', () => {
  assert.equal(rendererVerdict({ surfaceFlinger: SWIFTSHADER_SF, hwuiRenderer: '', gfxinfo: GFX_GL }).ok, true);
  assert.equal(rendererVerdict({ surfaceFlinger: SWIFTSHADER_SF, hwuiRenderer: 'skiagl', gfxinfo: GFX_GL }).ok, true);
  const host = rendererVerdict({ surfaceFlinger: HOST_GPU_SF, hwuiRenderer: '', gfxinfo: GFX_GL });
  assert.equal(host.ok, false);
  assert.match(host.reasons[0], /Apple M3 Pro/);
  assert.equal(rendererVerdict({ surfaceFlinger: '', hwuiRenderer: '', gfxinfo: '' }).reasons.length, 2);
});

// Read on the first guarded boot (API 36 google_apis arm64, emulator 37.1.11, -gpu swiftshader_indirect -feature -Vulkan).
const API36_SF = ' ------------RE GLES (Ganesh)------------\nGLES: Google (Google Inc. (Google)), Android Emulator OpenGL ES Translator (ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver-5.0.0)), OpenGL ES 3.1 (OpenGL ES 3.1.0 (ANGLE 2.1.1 git hash: fbf66f49c7cc))\ngraphite_renderengine: false\nvulkan_renderengine: false\n';
const API36_GFX = 'Applications Graphics Acceleration Info:\n\n** Graphics info for pid 918 [com.android.systemui] **\nFailure while dumping the app: ProcessRecord{9612b86 918:com.android.systemui/u0a186}\n';

test('API 36: SwiftShader under ANGLE and an explicit skiagl HWUI pass although gfxinfo cannot dump', () => {
  const v = rendererVerdict({ surfaceFlinger: API36_SF, hwuiRenderer: 'skiagl\n', gfxinfo: API36_GFX });
  assert.equal(v.ok, true, v.reasons.join('; '));
  assert.match(v.pipeline, /skiagl \(debug\.hwui\.renderer\)/);
  // without an explicit GL property the failed dump proves nothing: refuse
  assert.equal(rendererVerdict({ surfaceFlinger: API36_SF, hwuiRenderer: '', gfxinfo: API36_GFX }).ok, false);
  assert.equal(rendererVerdict({ surfaceFlinger: API36_SF, hwuiRenderer: 'skiavk', gfxinfo: API36_GFX }).ok, false);
  // a gfxinfo pipeline, when printed, still wins over the property
  assert.equal(rendererVerdict({ surfaceFlinger: API36_SF, hwuiRenderer: 'skiagl', gfxinfo: GFX_VK }).ok, false);
  // SurfaceFlinger's own compositor on guest Vulkan is refused too
  assert.equal(rendererVerdict({ surfaceFlinger: API36_SF.replace('vulkan_renderengine: false', 'vulkan_renderengine: true'), hwuiRenderer: 'skiagl', gfxinfo: API36_GFX }).ok, false);
  // the ANGLE-on-host-GPU form is not SwiftShader
  assert.equal(rendererVerdict({ surfaceFlinger: API36_SF.replace(/SwiftShader[^)]*\)/g, 'Apple M3 Pro)'), hwuiRenderer: 'skiagl', gfxinfo: API36_GFX }).ok, false);
});

test('holds the web captures\' lock for the emulator\'s whole life and waits while a live capture holds it', async () => {
  assert.equal(LOCK_DIR, path.join(os.tmpdir(), 'realm-safe-browser.lock'), 'the same directory safe-browser.mjs locks');
  const held = world({ lockOwner: 999, ownerAlive: true });
  try {
    await assert.rejects(guardedRun({ command: ['true'], deps: held.deps }), e => e.code === EXIT.lockTimeout);
    assert.equal(held.spawned.length, 0, 'no emulator while a SwiftShader capture runs');
    assert.equal(fs.readFileSync(path.join(held.lockDir, 'pid'), 'utf8'), '999', 'another owner\'s lock is never removed');
  } finally { held.cleanup(); }
  const stale = world({ lockOwner: 999, ownerAlive: false });
  try {
    let lockedWhileRunning = null;
    const exec = stale.deps.exec;
    stale.deps.exec = (cmd, args, opts) => { if (cmd === '/usr/sbin/taskpolicy') lockedWhileRunning = fs.readFileSync(path.join(stale.lockDir, 'pid'), 'utf8'); return exec(cmd, args, opts); };
    assert.equal(await guardedRun({ command: ['./gradlew', 'connectedDebugAndroidTest'], deps: stale.deps }), 0);
    assert.equal(lockedWhileRunning, '4242', 'a dead owner\'s lock is reclaimed and held while the command runs');
    assert.equal(fs.existsSync(stale.lockDir), false);
  } finally { stale.cleanup(); }
});

test('the happy path runs the command on its own serial under taskpolicy, then kills only that serial', async () => {
  const w = world({ bootAfter: 3, commandStatus: 7 });
  try {
    assert.equal(await guardedRun({ command: ['./gradlew', 'connectedDebugAndroidTest'], deps: w.deps }), 7, 'the command status is the exit status');
    const [spawnedChild] = w.spawned;
    assert.equal(spawnedChild.args[spawnedChild.args.indexOf('-gpu') + 1], 'swiftshader_indirect');
    const [run] = commandRuns(w.calls);
    assert.deepEqual(run.args, ['-b', './gradlew', 'connectedDebugAndroidTest']);
    assert.equal(run.env.ANDROID_SERIAL, 'emulator-5580');
    const order = w.calls.map(c => c.args.slice(2).join(' '));
    assert.ok(order.indexOf('shell dumpsys SurfaceFlinger') < w.calls.indexOf(run), 'the renderer is asserted before the command');
    assert.deepEqual(kills(w.calls).map(c => c.args), [['-s', 'emulator-5580', 'emu', 'kill']]);
    assert.deepEqual(spawnedChild.killed, [], 'a clean emu kill needs no signal');
  } finally { w.cleanup(); }
});

test('lock release only ever removes this process\'s own lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-guard-lock-')), lockDir = path.join(dir, 'l');
  try {
    fs.mkdirSync(lockDir); fs.writeFileSync(path.join(lockDir, 'pid'), '999');
    releaseLock({ lockDir, pid: 4242 });
    assert.equal(fs.existsSync(lockDir), true);
    releaseLock({ lockDir, pid: 999 });
    assert.equal(fs.existsSync(lockDir), false);
    await acquireLock({ lockDir, pid: 5, alive: () => true, sleep: async () => {}, log: () => {} });
    assert.equal(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), '5', 'the pid file names the holder, as safe-browser.mjs reads it');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the AVD is created once with the SwiftShader keys; an existing AVD is never edited', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emulator-guard-avd-')), sdk = path.join(tmp, 'sdk'), avdHome = path.join(tmp, 'avd');
  try {
    const image = path.join(sdk, 'system-images/android-36/google_apis/arm64-v8a');
    const calls = [];
    const exec = (cmd, args) => { calls.push([cmd, ...args]); fs.mkdirSync(path.join(avdHome, `${AVD}.avd`), { recursive: true });
      fs.writeFileSync(path.join(avdHome, `${AVD}.ini`), 'target=android-36\n');
      fs.writeFileSync(path.join(avdHome, `${AVD}.avd`, 'config.ini'), 'hw.gpu.enabled=no\nhw.gpu.mode=auto\nhw.lcd.width=1080\n'); return { status: 0 }; };
    assert.throws(() => createAvd({ sdk, avdHome, exec }), /not installed/);
    fs.mkdirSync(image, { recursive: true }); fs.writeFileSync(path.join(image, 'system.img'), '');
    assert.equal(createAvd({ sdk, avdHome, exec }), 'created');
    assert.deepEqual(calls, [[path.join(sdk, 'cmdline-tools/latest/bin/avdmanager'), 'create', 'avd', '-n', AVD, '-k', 'system-images;android-36;google_apis;arm64-v8a', '-d', 'pixel_8']]);
    const config = fs.readFileSync(path.join(avdHome, `${AVD}.avd`, 'config.ini'), 'utf8');
    assert.deepEqual(avdConfigProblems(config), []);
    assert.match(config, /hw\.lcd\.width=1080/, 'the rest of the new config is kept');
    assert.equal(createAvd({ sdk, avdHome, exec }), 'exists');
    assert.equal(calls.length, 1, 'an existing AVD is not re-created');
    const wrong = 'hw.gpu.enabled=yes\nhw.gpu.mode=host\n';
    fs.writeFileSync(path.join(avdHome, `${AVD}.avd`, 'config.ini'), wrong);
    assert.throws(() => createAvd({ sdk, avdHome, exec }), /not edited/);
    assert.equal(fs.readFileSync(path.join(avdHome, `${AVD}.avd`, 'config.ini'), 'utf8'), wrong, 'a wrong config is refused, never rewritten');
    assert.deepEqual(Object.entries(AVD_GPU), [['hw.gpu.enabled', 'yes'], ['hw.gpu.mode', 'swiftshader_indirect']]);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a guard run refuses an AVD whose config is not SwiftShader', async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.avdHome, `${AVD}.avd`, 'config.ini'), 'hw.gpu.enabled=yes\nhw.gpu.mode=host\n');
    await assert.rejects(guardedRun({ command: ['true'], deps: w.deps }), /not SwiftShader/);
    assert.equal(w.spawned.length, 0);
  } finally { w.cleanup(); }
});

test('an emulator that dies during boot is reported with its own output, and the lock is freed', async () => {
  // The first guarded boot (2026-09-25) exited silently: the guard discarded the emulator's output. A failed boot must
  // say why, from a log inside the guard's own AVD directory, and must still free the shared lock.
  const w = world({ bootAfter: 1e9 });
  try {
    let spawnOpts = null;
    w.deps.spawn = (cmd, args, opts) => { spawnOpts = opts; return { pid: 777, exited: Promise.resolve(1), kill: () => {} }; };
    const log = path.join(w.avdHome, `${AVD}.avd`, 'guard-emulator.log');
    fs.writeFileSync(log, 'INFO | boot\nFATAL | Hypervisor.framework unavailable\n');
    await assert.rejects(guardedRun({ command: ['true'], deps: w.deps }),
      e => e.code === EXIT.boot && e.message.includes(log) && /Hypervisor\.framework unavailable/.test(e.message));
    assert.equal(spawnOpts?.log, log, 'the emulator output goes to the guard AVD directory, nowhere else');
    assert.equal(commandRuns(w.calls).length, 0, 'nothing runs on an emulator that did not boot');
    assert.equal(fs.existsSync(w.lockDir), false, 'the shared SwiftShader lock is released');
  } finally { w.cleanup(); }
});

test('below 4 GB free the guard never boots: nothing spawned, no lock taken, exit code disk', async () => {
  // Why: every guarded boot writes a 1.2–2 GB userdata overlay; near 2 GB free the N1/N2 smoke's installs died with a
  // broken package-service pipe (runs 2 and 3), and run 4 went on at 3 GB. The lanes' rule is "below 4 GB, stop".
  const w = world({ freeGB: [3.9] });
  try {
    await assert.rejects(guardedRun({ command: ['true'], deps: w.deps }), e => e instanceof Refusal && e.code === EXIT.disk && /3\.9 GB free before the boot/.test(e.message));
    assert.equal(w.spawned.length, 0, 'no emulator started');
    assert.equal(fs.existsSync(w.lockDir), false, 'the shared lock was never taken');
    assert.equal(commandRuns(w.calls).length, 0);
  } finally { w.cleanup(); }
});

test('the boot\'s own overlay taking the Mac below 4 GB stops the run before the command, kills only its serial, frees the lock', async () => {
  // run 4 of the N1/N2 smoke: 3 GB free right after the boot, then an install. The command must not start.
  const w = world({ freeGB: [6, 6, 3] });
  try {
    await assert.rejects(guardedRun({ command: ['./smoke.sh'], deps: w.deps }), e => e.code === EXIT.disk && /3\.0 GB free after the boot/.test(e.message));
    assert.equal(w.spawned.length, 1, 'the boot happened');
    assert.equal(commandRuns(w.calls).length, 0, 'the command (install, smoke) never ran');
    assert.deepEqual(kills(w.calls).map(c => c.args), [['-s', 'emulator-5580', 'emu', 'kill']], 'only its own serial is killed');
    assert.equal(fs.existsSync(w.lockDir), false, 'the lock is freed');
  } finally { w.cleanup(); }
});

test('the disk floor fails closed: an unreadable volume refuses, exactly 4 GB passes', async () => {
  assert.equal(diskRefusal(MIN_FREE_BYTES, 'now'), null);
  assert.equal(diskRefusal(MIN_FREE_BYTES - 1, 'now').code, EXIT.disk);
  assert.equal(diskRefusal(NaN, 'now').code, EXIT.disk);
  const w = world({ freeGB: () => { throw new Error('statfs failed'); } });
  try {
    await assert.rejects(guardedRun({ command: ['true'], deps: w.deps }), e => e.code === EXIT.disk && /could not be read/.test(e.message));
    assert.equal(w.spawned.length, 0);
  } finally { w.cleanup(); }
});
