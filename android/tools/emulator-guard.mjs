// The only sanctioned emulator launcher for the native globe port (GLOBE-NATIVE-PLAN §8.1, D-168.3, RM-GPU-1).
// The owner's Mac GPU hung on WebGL on 2026-09-24, so no GL may ever reach it: the emulator renders on SwiftShader
// (CPU) only, runs one at a time under background QoS, and shares the web captures' CPU lock for its whole life.
//
//   node tools/emulator-guard.mjs create-avd               create pkw_native_globe_sw (SwiftShader config), once
//   node tools/emulator-guard.mjs check                    print what would be refused; launches nothing
//   node tools/emulator-guard.mjs run [--port N] -- <cmd>  lock, boot, assert SwiftShader, run <cmd>, kill own serial
//
// <cmd> runs with ANDROID_SERIAL set to this guard's own serial, under taskpolicy -b. A gradle <cmd> still takes the
// shared gradle lock itself (docs/LOCAL_TESTING.md). The guard never edits an existing AVD, never touches another
// emulator, and never kills anything it did not start. Below 4 GB free on the Mac's data volume it refuses: before the
// boot, again under the lock, and again after the boot, before <cmd> (the boot writes a 1.2–2 GB userdata overlay).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AVD = 'pkw_native_globe_sw';
export const SYSTEM_IMAGE = 'system-images;android-36;google_apis;arm64-v8a';
export const DEVICE = 'pixel_8';
export const AVD_GPU = Object.freeze({ 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'swiftshader_indirect' });
export const DEFAULT_PORT = 5580;
/** Guest userdata cap (MB): the emulator needs this + 2 GB free to boot, and the guest can never write more. */
export const DATA_PARTITION_MB = 4096;
/** The web captures' lock (concepts/globe3d-2026-09-23/qa/safe-browser.mjs): one SwiftShader job at a time, Mac-wide. */
export const LOCK_DIR = path.join(os.tmpdir(), 'realm-safe-browser.lock');
export const LOCK_MAX_WAITS = 1800;
export const BOOT_TIMEOUT_MS = 15 * 60_000;
export const EXIT = Object.freeze({ refused: 3, lockTimeout: 4, renderer: 5, boot: 6, disk: 7 });
/**
 * The lanes' disk rule (docs/LOCAL_TESTING.md): below 4 GB free nothing boots, installs or runs. The N1/N2 smoke's run 4
 * (2026-09-25) booted and installed at 3 GB free, after runs 2 and 3 had died at install with a broken package-service
 * pipe near 2 GB: the rule lived only in the script, so the guard now enforces it.
 */
export const MIN_FREE_BYTES = 4 * 1024 ** 3;

export class Refusal extends Error {
  constructor(message, code = EXIT.refused) { super(message); this.code = code; }
}

/** A refusal when the data volume has less than MIN_FREE_BYTES free, or null. Fails closed: an unreadable volume refuses. */
export function diskRefusal(freeBytes, when) {
  if (!Number.isFinite(freeBytes)) return new Refusal(`Free disk could not be read ${when}; the guard refuses (the 4 GB rule)`, EXIT.disk);
  if (freeBytes < MIN_FREE_BYTES) {
    return new Refusal(`Only ${(freeBytes / 1024 ** 3).toFixed(1)} GB free ${when}: below the 4 GB floor (docs/LOCAL_TESTING.md). `
      + `Stop, report, and free only outputs you created (a guard run's own userdata overlay included).`, EXIT.disk);
  }
  return null;
}

/** The exact launch: SwiftShader, no guest Vulkan, headless, cold, on this guard's own port, under background QoS. */
export function launchCommand({ emulator, port, platform }) {
  if (platform !== 'darwin') throw new Refusal('The guard runs the emulator under macOS taskpolicy -b; no other host is supported');
  if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2) throw new Refusal(`Port ${port} is not an even emulator console port in 5554-5682`);
  return {
    command: '/usr/sbin/taskpolicy',
    // -no-snapshot: a cold boot that never auto-saves. -no-snapshot-load alone still writes a RAM-sized quick-boot snapshot
    // on exit, on a disk the owner's Mac has little of. -no-boot-anim: less CPU on a machine the web captures share.
    // -partition-size: a 4 GB userdata cap. The AVD's 10 GB default makes the emulator refuse to boot below 12 GB free
    // (seen on the first guarded boot), and the cap also bounds what the guest can ever write to the Mac's disk.
    args: ['-b', emulator, '-avd', AVD, '-port', String(port), '-gpu', 'swiftshader_indirect', '-feature', '-Vulkan', '-no-window', '-no-snapshot', '-no-boot-anim',
      '-partition-size', String(DATA_PARTITION_MB)],
    serial: `emulator-${port}`,
  };
}

/** Emulators already running: every emulator-* adb serial, plus emulator/qemu processes adb may not list yet. */
export function otherEmulators({ adbDevices, processes, ownPid }) {
  const found = [];
  for (const line of adbDevices.split('\n')) {
    const m = line.match(/^(emulator-\d+)\s+\S+/);
    if (m) found.push(`adb ${m[1]}`);
  }
  for (const line of processes.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || +m[1] === ownPid) continue;
    const exe = m[2].split(/\s+/)[0];
    if (/(^|\/)qemu-system-[\w.-]+$/.test(exe) || /(^|\/)emulator\/emulator$/.test(exe) || /(^|\/)emulator$/.test(exe)) found.push(`pid ${m[1]} ${exe}`);
  }
  return found;
}

/**
 * Proof that the guest renders on SwiftShader and HWUI is not on Vulkan. Fails closed when a reading is missing.
 *
 * HWUI evidence is gfxinfo's `Pipeline=` line, or else an explicit GL `debug.hwui.renderer`. The first guarded boot
 * (API 36, 2026-09-25) answered `dumpsys gfxinfo com.android.systemui` with "Failure while dumping the app" and set
 * `debug.hwui.renderer=skiagl`, so the property alone must be able to prove GL. An empty property and no pipeline line
 * still refuse. SurfaceFlinger's own RenderEngine must not be on Vulkan either.
 */
export function rendererVerdict({ surfaceFlinger, hwuiRenderer, gfxinfo }) {
  const reasons = [];
  const gles = surfaceFlinger.match(/^\s*GLES:\s*(.+)$/m)?.[1]?.trim();
  if (!gles) reasons.push('dumpsys SurfaceFlinger printed no GLES renderer line');
  else if (!/swiftshader/i.test(gles)) reasons.push(`guest GLES renderer is not SwiftShader: ${gles}`);
  if (/^\s*(vulkan|graphite)_renderengine:\s*true\s*$/mi.test(surfaceFlinger)) reasons.push('SurfaceFlinger RenderEngine is on Vulkan/Graphite');
  const hwui = hwuiRenderer.trim();
  if (/vk|vulkan/i.test(hwui)) reasons.push(`debug.hwui.renderer is ${hwui}`);
  const gfxPipeline = gfxinfo.match(/Pipeline=([^\n]+)/)?.[1]?.trim();
  const pipeline = gfxPipeline ?? (/^(skiagl|opengl)$/i.test(hwui) ? `${hwui} (debug.hwui.renderer)` : undefined);
  if (!pipeline) reasons.push('dumpsys gfxinfo printed no HWUI pipeline and debug.hwui.renderer does not name GL');
  else if (gfxPipeline && (/vulkan/i.test(gfxPipeline) || !/opengl/i.test(gfxPipeline))) reasons.push(`HWUI pipeline is ${gfxPipeline}`);
  return { ok: reasons.length === 0, gles: gles ?? null, pipeline: pipeline ?? null, reasons };
}

/** The mkdir lock of safe-browser.mjs, protocol for protocol: a pid file, stale owners reclaimed, 1 s polls. */
export async function acquireLock({ fsx = fs, lockDir = LOCK_DIR, pid = process.pid, alive = pidAlive, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log, maxWaits = LOCK_MAX_WAITS } = {}) {
  for (let waited = 0; ; waited++) {
    try { fsx.mkdirSync(lockDir); fsx.writeFileSync(path.join(lockDir, 'pid'), String(pid)); return; } catch {
      let owner = 0; try { owner = +fsx.readFileSync(path.join(lockDir, 'pid'), 'utf8'); } catch {}
      if (owner && !alive(owner)) { fsx.rmSync(lockDir, { recursive: true, force: true }); continue; }
      if (waited === 0) log('waiting for another capture to finish (one browser at a time)');
      if (waited > maxWaits) throw new Refusal('LOCK TIMEOUT', EXIT.lockTimeout);
      await sleep(1000);
    }
  }
}
export function releaseLock({ fsx = fs, lockDir = LOCK_DIR, pid = process.pid } = {}) {
  try { if (+fsx.readFileSync(path.join(lockDir, 'pid'), 'utf8') === pid) fsx.rmSync(lockDir, { recursive: true, force: true }); } catch {}
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

const iniValue = (text, key) => text.match(new RegExp(`^${key.replace(/\./g, '\\.')}\\s*=\\s*(.*)$`, 'm'))?.[1]?.trim();
/** Our AVD's config.ini must carry the SwiftShader keys; anything else is refused, never rewritten. */
export function avdConfigProblems(configText) {
  return Object.entries(AVD_GPU).filter(([k, v]) => iniValue(configText, k) !== v).map(([k, v]) => `${k} is ${iniValue(configText, k) ?? 'unset'}, needs ${v}`);
}

/**
 * Create pkw_native_globe_sw once. It never edits an existing AVD: if the name exists, its config is only checked.
 * The GPU keys are written into the config.ini that avdmanager has just created for this new AVD.
 */
export function createAvd({ sdk, avdHome, exec, fsx = fs }) {
  const ini = path.join(avdHome, `${AVD}.ini`), dir = path.join(avdHome, `${AVD}.avd`), config = path.join(dir, 'config.ini');
  if (fsx.existsSync(ini) || fsx.existsSync(dir)) {
    const problems = fsx.existsSync(config) ? avdConfigProblems(fsx.readFileSync(config, 'utf8')) : ['config.ini missing'];
    if (problems.length) throw new Refusal(`${AVD} exists with the wrong config (${problems.join('; ')}); it is not edited. Delete it by hand and re-create.`);
    return 'exists';
  }
  const image = path.join(sdk, ...SYSTEM_IMAGE.split(';'), 'system.img');
  if (!fsx.existsSync(image)) throw new Refusal(`System image ${SYSTEM_IMAGE} is not installed (${image})`);
  const avdmanager = path.join(sdk, 'cmdline-tools/latest/bin/avdmanager');
  const r = exec(avdmanager, ['create', 'avd', '-n', AVD, '-k', SYSTEM_IMAGE, '-d', DEVICE], { input: 'no\n' });
  if (r.status !== 0) throw new Refusal(`avdmanager failed: ${r.stderr || r.stdout}`);
  let text = fsx.readFileSync(config, 'utf8');
  for (const [k, v] of Object.entries(AVD_GPU)) text = iniValue(text, k) === undefined ? `${text.replace(/\n?$/, '\n')}${k}=${v}\n` : text.replace(new RegExp(`^${k.replace(/\./g, '\\.')}\\s*=.*$`, 'm'), `${k}=${v}`);
  fsx.writeFileSync(config, text);
  const problems = avdConfigProblems(fsx.readFileSync(config, 'utf8'));
  if (problems.length) throw new Refusal(`${AVD} config did not take: ${problems.join('; ')}`);
  return 'created';
}

/**
 * Lock → refuse on any other emulator → boot on SwiftShader → assert the renderer → run the command → kill own serial.
 * deps: { platform, sdk, avdHome, pid, exec(cmd, args, opts) → {status, stdout, stderr}, spawn(cmd, args, opts) →
 * { pid, exited: Promise<code>, kill(signal) }, portFree(port) → Promise<bool>, sleep, now, log, fsx, alive, lockDir, onSignal }
 */
export async function guardedRun({ port = DEFAULT_PORT, command, deps }) {
  const { platform, sdk, avdHome, exec, log = console.log } = deps;
  if (!command?.length) throw new Refusal('Nothing to run: pass -- <command>');
  const adb = path.join(sdk, 'platform-tools/adb'), emulator = path.join(sdk, 'emulator/emulator');
  const launch = launchCommand({ emulator, port, platform });
  const others = () => otherEmulators({ adbDevices: exec(adb, ['devices']).stdout ?? '', processes: exec('/bin/ps', ['-Ao', 'pid=,command=']).stdout ?? '', ownPid: deps.pid });
  const config = path.join(avdHome, `${AVD}.avd`, 'config.ini');
  if (!(deps.fsx ?? fs).existsSync(config)) throw new Refusal(`${AVD} does not exist: run create-avd first`);
  const bad = avdConfigProblems((deps.fsx ?? fs).readFileSync(config, 'utf8'));
  if (bad.length) throw new Refusal(`${AVD} config is not SwiftShader: ${bad.join('; ')}`);
  let running = others();
  if (running.length) throw new Refusal(`Another emulator is running (${running.join(', ')}); the guard runs one only and never touches it`);
  const disk = when => {
    let free = NaN; try { free = Number(deps.freeBytes()); } catch {}
    const refusal = diskRefusal(free, when); if (refusal) throw refusal;
    return free;
  };
  disk('before the boot');
  const lock = { fsx: deps.fsx, lockDir: deps.lockDir, pid: deps.pid, alive: deps.alive, sleep: deps.sleep, log };
  await acquireLock(lock);
  let child = null;
  const adbOwn = (...args) => exec(adb, ['-s', launch.serial, ...args]);
  const killOwn = async () => {
    if (!child) return;
    adbOwn('emu', 'kill');
    const done = await Promise.race([child.exited.then(() => true), deps.sleep(30_000).then(() => false)]);
    if (!done) child.kill('SIGKILL'); // the process this guard spawned, never any other
    child = null;
  };
  // A signal mid-run still kills this guard's own emulator and frees the lock (never leaves a SwiftShader job behind).
  deps.onSignal?.(async () => { await killOwn(); releaseLock(lock); });
  try {
    running = others(); // re-checked under the lock: something may have started while this guard waited
    if (running.length) throw new Refusal(`Another emulator is running (${running.join(', ')})`);
    for (const p of [port, port + 1]) if (!(await deps.portFree(p))) throw new Refusal(`Port ${p} is in use`);
    disk('before the boot (re-read under the lock)');
    log(`starting ${AVD} on ${launch.serial} (SwiftShader, background QoS)`);
    // The emulator's own output goes to a log in this guard's AVD directory: a boot failure must say why (fail loud).
    const emulatorLog = path.join(avdHome, `${AVD}.avd`, 'guard-emulator.log');
    child = deps.spawn(launch.command, launch.args, { stdio: 'ignore', log: emulatorLog });
    let exited = false; child.exited.then(() => { exited = true; });
    const start = deps.now();
    for (;;) {
      if (exited) throw new Refusal(`The emulator exited during boot; its output: ${emulatorLog}\n${logTail(deps.fsx ?? fs, emulatorLog)}`, EXIT.boot);
      if (deps.now() - start > BOOT_TIMEOUT_MS) throw new Refusal('The emulator did not finish booting', EXIT.boot);
      if ((adbOwn('shell', 'getprop', 'sys.boot_completed').stdout ?? '').trim() === '1') break;
      await deps.sleep(5000);
    }
    const readings = {
      surfaceFlinger: adbOwn('shell', 'dumpsys', 'SurfaceFlinger').stdout ?? '',
      hwuiRenderer: adbOwn('shell', 'getprop', 'debug.hwui.renderer').stdout ?? '',
      gfxinfo: adbOwn('shell', 'dumpsys', 'gfxinfo', 'com.android.systemui').stdout ?? '',
    };
    const verdict = rendererVerdict(readings);
    // What the guest said, kept next to the emulator log whatever the verdict: a refusal must be explainable.
    const readingsFile = path.join(avdHome, `${AVD}.avd`, 'guard-renderer.txt');
    try {
      (deps.fsx ?? fs).writeFileSync(readingsFile, [`verdict: ${JSON.stringify(verdict)}`,
        `GLES lines:\n${readings.surfaceFlinger.split('\n').filter(l => /GLES|RenderEngine|swiftshader/i.test(l)).slice(0, 20).join('\n')}`,
        `debug.hwui.renderer: '${readings.hwuiRenderer.trim()}'`,
        `gfxinfo com.android.systemui (first 80 lines):\n${readings.gfxinfo.split('\n').slice(0, 80).join('\n')}`].join('\n\n'));
    } catch {}
    if (!verdict.ok) throw new Refusal(`Renderer check failed: ${verdict.reasons.join('; ')} (readings: ${readingsFile})`, EXIT.renderer);
    log(`renderer ${verdict.gles}; HWUI ${verdict.pipeline}`);
    const free = disk('after the boot, before the command (the boot wrote its userdata overlay)');
    log(`free disk ${(free / 1024 ** 3).toFixed(1)} GB`);
    const [cmd, ...args] = command;
    const run = exec('/usr/sbin/taskpolicy', ['-b', cmd, ...args], { stdio: 'inherit', env: { ...process.env, ANDROID_SERIAL: launch.serial } });
    return run.status ?? 1;
  } finally {
    await killOwn();
    releaseLock(lock);
  }
}

function logTail(fsx, file, lines = 30) {
  try { return fsx.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n'); } catch { return '(no emulator output was recorded)'; }
}

function realDeps() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Refusal('Export ANDROID_HOME');
  return {
    platform: process.platform, sdk, pid: process.pid,
    avdHome: process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android/avd'),
    exec: (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...opts }); return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; },
    spawn: (cmd, args, { log, ...opts } = {}) => {
      const fd = log ? fs.openSync(log, 'w') : null;
      const c = spawn(cmd, args, fd === null ? opts : { ...opts, stdio: ['ignore', fd, fd] });
      if (fd !== null) fs.closeSync(fd); // the child holds its own copy
      return { pid: c.pid, exited: new Promise(r => c.once('exit', code => r(code))), kill: s => c.kill(s) };
    },
    portFree: port => new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); resolve(false); }); s.once('error', () => resolve(true)); }),
    sleep: ms => new Promise(r => setTimeout(r, ms)), now: () => Date.now(), log: console.log, fsx: fs, alive: pidAlive, lockDir: LOCK_DIR,
    // the data volume `df -g ~` reports (the userdata overlay lands under ~/.android/avd)
    freeBytes: () => { const st = fs.statfsSync(os.homedir()); return Number(st.bavail) * Number(st.bsize); },
    onSignal: cleanup => { const h = () => { cleanup().finally(() => process.exit(130)); }; process.once('SIGINT', h); process.once('SIGTERM', h); },
  };
}

async function main(argv) {
  const [verb, ...rest] = argv, deps = realDeps();
  if (verb === 'create-avd') { console.log(`${AVD}: ${createAvd({ ...deps })}`); return 0; }
  if (verb === 'check') {
    const adb = path.join(deps.sdk, 'platform-tools/adb');
    const running = otherEmulators({ adbDevices: deps.exec(adb, ['devices']).stdout, processes: deps.exec('/bin/ps', ['-Ao', 'pid=,command=']).stdout, ownPid: deps.pid });
    const config = path.join(deps.avdHome, `${AVD}.avd`, 'config.ini');
    const avd = fs.existsSync(config) ? avdConfigProblems(fs.readFileSync(config, 'utf8')) : ['missing: run create-avd'];
    let holder = null; try { holder = +fs.readFileSync(path.join(LOCK_DIR, 'pid'), 'utf8'); } catch {}
    let free = NaN; try { free = deps.freeBytes(); } catch {}
    const low = diskRefusal(free, 'now');
    console.log(JSON.stringify({ otherEmulators: running, avd: avd.length ? avd : 'ok', lock: LOCK_DIR, lockHeldBy: holder && pidAlive(holder) ? holder : null,
      freeGB: Number.isFinite(free) ? +(free / 1024 ** 3).toFixed(1) : null, disk: low ? low.message : 'ok' }, null, 1));
    return running.length || avd.length ? EXIT.refused : low ? EXIT.disk : 0;
  }
  if (verb === 'run') {
    const sep = rest.indexOf('--'), opts = sep >= 0 ? rest.slice(0, sep) : rest, command = sep >= 0 ? rest.slice(sep + 1) : [];
    const i = opts.indexOf('--port'), port = i >= 0 ? +opts[i + 1] : DEFAULT_PORT;
    return guardedRun({ port, command, deps });
  }
  console.error('usage: emulator-guard.mjs create-avd | check | run [--port N] -- <command>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.message); process.exitCode = e.code ?? 1; });
}
