// slice.test — why it matters (RM-GPU-1 stage B D1; D-167: no main-thread task over 50 ms). Every lane cut its load into
// steps of ≤ SLICE_MS, but each lane's sliced() started its OWN clock, so the rule held per sliced() call, not per task:
// map.mjs loadModules started GROUND, BASES, LIFE and the minimap in one task, pack reads that resolve at once continue in
// the task already running, and a job that ends hands straight to the next. The entry's first task was 28–32 ms of JS on
// performance cores and 51–84 ms on efficiency cores (qa/entry-stretch.mjs), inside the dive. slice.mjs is now the ONE
// clock every lane's steps read, checked before every step (the first one included), and loadModules starts one lane per
// task. Counted, not timed (the lanes' convention: GC or a loaded host only lengthens a real stretch): a virtual clock
// that advances only per modelled unit of work, and the yields counted where they are posted.
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createTaskClock, taskClock, SLICE_MS } from './slice.mjs';

// ---- the rule, on synthetic jobs ------------------------------------------------------------------------------------
// A fake event loop: post() queues a task; run() drains them one by one, letting microtasks settle after each, and
// records each task's length on the counted clock (every job step costs 1 ms).
function loop() {
  let t = 0; const q = [], tasks = [];
  const post = fn => q.push(fn);
  const settle = async () => { for (let i = 0; i < 50; i++) await null; };
  async function run(first) {
    let t0 = t; first(); await settle(); tasks.push(t - t0);
    while (q.length) { t0 = t; q.shift()(); await settle(); tasks.push(t - t0); }
    return tasks;
  }
  return { now: () => t, step: () => { t += 1; }, post, run, tasks };
}
// a lane's load as the lanes write it: n steps, each preceded by the clock check (shared = slice.mjs; own = the old
// per-call clock that started at the sliced() call)
async function job(L, clock, n, { shared }) {
  let t0 = L.now();
  for (let i = 0; i < n; i++) {
    if (shared ? clock.spent() : L.now() - t0 > clock.sliceMs) { await clock.yieldTask(); t0 = L.now(); }
    L.step();
  }
}
test('task clock: lanes started in one task shared its slice only once slice.mjs is one clock; one lane per task keeps each task in budget', async () => {
  const BOUND = 8 + 1; // SLICE_MS + one step
  // before stage B: three lanes' loads started in ONE task, each with its own clock → the first task holds three slices
  { const L = loop(), c = createTaskClock({ now: L.now, post: L.post, sliceMs: 8 });
    const tasks = await L.run(() => { for (let k = 0; k < 3; k++) Promise.resolve().then(() => job(L, c, 30, { shared: false })); });
    assert.ok(Math.max(...tasks) >= 3 * 8, `teeth: the old per-call clocks give a ${Math.max(...tasks)} ms first task`); }
  // the shared clock alone: a job starting in a spent task yields before its first step
  { const L = loop(), c = createTaskClock({ now: L.now, post: L.post, sliceMs: 8 });
    const tasks = await L.run(() => { c.mark(); for (let k = 0; k < 3; k++) Promise.resolve().then(() => job(L, c, 30, { shared: true })); });
    assert.ok(Math.max(...tasks) <= BOUND, `shared clock: the longest task is ${Math.max(...tasks)} ms (bound ${BOUND})`);
    assert.equal(tasks.reduce((a, b) => a + b, 0), 90, 'every step still ran'); }
  // loadModules' way: one lane per task (tasks()), and the shared clock
  { const L = loop(), c = createTaskClock({ now: L.now, post: L.post, sliceMs: 8 }), order = [];
    const tasks = await L.run(() => { const start = c.tasks(); for (let k = 0; k < 3; k++) start(() => { order.push(k); order.push(`t${L.tasks.length}`); return job(L, c, 30, { shared: true }); }); });
    assert.ok(Math.max(...tasks) <= BOUND, `one lane per task: the longest task is ${Math.max(...tasks)} ms`);
    assert.deepEqual(order.filter(x => typeof x === 'number'), [0, 1, 2], 'lanes start in order');
    const at = order.filter(x => typeof x === 'string'); assert.equal(new Set(at).size, 3, `each lane starts in its own task (${at})`); }
  // a clock that runs backwards (a test's counted clock swapped in) re-marks instead of reading as never spent
  { let t = 1000; const c = createTaskClock({ now: () => t, post: fn => fn(), sliceMs: 8 }); c.mark(); t = 5; assert.equal(c.spent(), false); t = 14; assert.equal(c.spent(), true); }
});

// ---- the real lanes, started the way map.mjs loadModules starts them ----------------------------------------------------
// GROUND, the base state, the minimap, BASES and LIFE on a real pack (Cinderfall, every read decoded by sharp up front and
// cached: they resolve at once, as after the decode worker finished during the dive), a no-op GL core, and the counted
// clock of the lanes' own tests: each texture upload 0.3 ms, each image read 0.1 ms, nothing else. Every task (delivery to
// delivery) must hold ≤ SLICE_MS + one step. The costliest modelled step is GROUND's synchronous prefix or one layer's
// mip chain (≤ 12 uploads, 3.6 ms). Teeth (scratch mutations, lane-shell.md "Stage B fix pass"): any lane's sliced() back on
// its own per-call clock, or the lanes started in one task with those clocks, overshoots the bound.
const sharp = createRequire(new URL('../../../../../../../scripts/package.json', import.meta.url).pathname)('sharp');
const PACKS = PACK_ROOT + 'realm/';
async function packOf(dir, id, cost) {
  const meta = id ? JSON.parse(readFileSync(dir + 'realm.json', 'utf8')) : null, px = new Map();
  const miss = k => Object.assign(Error('404 ' + k), { status: 404 });
  const decoded = async k => { if (!px.has(k)) { if (!existsSync(dir + k)) throw miss(k); const { data, info } = await sharp(dir + k).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    px.set(k, { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), channels: 4 }); } return px.get(k); };
  const pixels = async k => { const p = await decoded(k); cost.read(); return p; };
  const json = async k => { if (!existsSync(dir + k)) throw miss(k); return JSON.parse(readFileSync(dir + k, 'utf8')); };
  return { id, root: dir, meta, legacy: false, pixels, json, decoded, bitmap: async k => { const p = await pixels(k); return { width: p.width, height: p.height, close() {} }; },
    bytes: async k => new Uint8Array(readFileSync(dir + k)), prefetch() {}, release() {}, stats: {} };
}
function noopCore(cost) {
  const K = { MAX_TEXTURE_SIZE: 0xd33, MAX_ARRAY_TEXTURE_LAYERS: 0x88ff };
  const gl = new Proxy({ drawingBufferWidth: 2560, drawingBufferHeight: 1600, canvas: { width: 2560, height: 1600 } }, { get(t, k) {
    if (k in t) return t[k];
    if (k === 'getParameter') return p => (p === K.MAX_TEXTURE_SIZE ? 8192 : p === K.MAX_ARRAY_TEXTURE_LAYERS ? 2048 : 0);
    if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return K[k] ?? k;
    if (/^create/.test(k)) return () => ({});
    if (k === 'isEnabled') return () => false;
    return () => {};
  } });
  const texture = (fmt, w = 1, h = 1, layers = 1) => { cost.upload(); return { t: {}, target: 1, format: fmt, w, h, layers, bytes: w * h * 4 * layers }; };
  const lru = n => { const m = new Map(); return { has: k => m.has(k), get: k => { const v = m.get(k); m.delete(k); m.set(k, v); return v; }, put(k, v, ev) { m.set(k, v); if (m.size > n) { const [o] = m.keys(); const ov = m.get(o); m.delete(o); ev?.(ov, o); } }, delete: k => m.delete(k), keys: () => m.keys(), get size() { return m.size; } }; };
  const shared = new Map();
  return { gl, quadBuffer: {}, quadVao: {}, dpr: 2, W: 1280, H: 800, include() {}, animating() {}, invalidate() {}, sinceInput: () => 1e9, stats: () => ({}),
    lowres: () => texture('RGBA8'), lru, fbo: () => ({}), fullscreen() {},
    program(name) { const p = { name, ready: true, state: 'ready', use: () => p, u: n => n, tex: () => p, bindView: () => p }; return p; },
    tex: { image: s => texture('RGBA8', s?.width ?? 1, s?.height ?? 1), data: (w, h, f) => texture(f, w, h), array: (w, h, n, f = 'RGBA8') => texture(f, w, h, n),
      layer() { cost.upload(); }, update() { cost.upload(); }, free() {}, queue: fn => fn(), shared: (k, make) => { if (!shared.has(k)) shared.set(k, make()); return shared.get(k); } } };
}
test('entry: GROUND, the base state, the minimap, BASES and LIFE started as loadModules does never hold a task past SLICE_MS + one step', { timeout: 180000 }, async () => {
  const REALM = 'cinderfall', SLICE = 8, STEP = 3.6;
  let vt = 0, last = 0, worst = 0, yields = 0, uploads = 0, reads = 0; const stretches = [];
  const trail = [], tr = k => { if (process.env.DBG) trail.push(`${k} ${(vt - last).toFixed(1)} ${new Error().stack.split('\n').slice(3, 6).map(x => x.trim()).join(' < ')}`); };
  const cost = { upload: () => { vt += 0.3; uploads++; tr('U'); }, read: () => { vt += 0.1; reads++; tr('R'); } };
  const dir = PACKS + REALM + '/', P = await packOf(dir, REALM, cost), S = await packOf(PACKS + 'shared/', null, cost), { cols, rows } = P.meta.grid;
  const dp = await P.decoded('deeds.png'), deeds = new Uint8Array(cols * rows); for (let i = 0; i < cols * rows; i++) deeds[i] = dp.data[i * 4];
  P.first = { chart8: { width: (await P.decoded('chart8.webp')).width, height: (await P.decoded('chart8.webp')).height, close() {} }, deeds, chartKey: 'chart8.webp' };
  for (const f of readdirSync(dir)) if (/\.(png|webp)$/.test(f) && !f.startsWith('chart16')) await P.decoded(f);
  for (const f of ['keeps.json', 'decor.json']) if (existsSync(PACKS + 'shared/' + f)) { const m = await S.json(f); await S.decoded(m.atlas ?? f.replace('.json', '.png')).catch(() => {}); }
  const [{ createGround }, { createLife }, { createBases }, { createMinimap }] = await Promise.all([import('./ground.mjs'), import('./life.mjs'), import('./bases.mjs'), import('./minimap.mjs')]);
  const core = noopCore(cost), g = createGround(core), life = createLife(core, g), bases = createBases(core, g), mini = createMinimap(core);
  const MC = globalThis.MessageChannel, now = performance.now;
  // a task is what runs between two deliveries (every task here starts at a message-channel delivery: each read resolves
  // at once, so a yield is the only way a lane gives the thread back); the stretch closes at the delivery, so a task that
  // ends without posting a yield (a load that finished) is not charged to the next task
  const close = () => { const t = vt - last; if (process.env.DBG && t > SLICE + STEP) console.log(trail.slice(-80).join('\n') + `\nTASK ${t.toFixed(1)}`); trail.length = 0; stretches.push(+t.toFixed(2)); worst = Math.max(worst, t); last = vt; };
  const accessor = o => { for (; o; o = Object.getPrototypeOf(o)) { const x = Object.getOwnPropertyDescriptor(o, 'onmessage'); if (x?.set) return x; } throw Error('no onmessage accessor'); };
  globalThis.MessageChannel = class extends MC { constructor() { super(); const p1 = this.port1, post = this.port2.postMessage.bind(this.port2), d = accessor(p1);
    Object.defineProperty(p1, 'onmessage', { configurable: true, get: () => d.get.call(p1), set: f => d.set.call(p1, f && (e => { close(); return f(e); })) });
    this.port2.postMessage = m => { yields++; post(m); }; } };
  performance.now = () => vt;
  try {
    taskClock.mark();
    const start = taskClock.tasks(); // map.mjs loadModules: one lane per task, in this order
    const runs = [start(() => g.load(P)), start(() => g.setBases?.([])), start(() => mini.load(P)), start(() => bases.load(P, S)), start(() => life.load(P, S))];
    await Promise.all(runs.map(p => p.then(x => x)));
  } finally { globalThis.MessageChannel = MC; performance.now = now; }
  worst = Math.max(worst, vt - last);
  assert.equal(g.ready.map, true, `GROUND loaded its MAP data (${g.stats().mapErr ?? ''})`);
  assert.equal(bases.stats().ready, true, `BASES loaded (${bases.stats().why})`);
  assert.equal(life.stats().ready ?? true, true, 'LIFE loaded');
  assert.ok(uploads > 1000 && vt > 300, `a realistic entry: ${uploads} uploads, ${reads} reads, ${vt.toFixed(0)} ms of modelled work`);
  assert.ok(worst <= SLICE + STEP + 1e-9, `a task held ${worst.toFixed(1)} ms of modelled work (bound ${SLICE} + ${STEP}); longest: ${stretches.sort((a, b) => b - a).slice(0, 5)}`);
  assert.ok(stretches.length >= yields - 1, `every delivered yield closed a task (${stretches.length} tasks, ${yields} yields)`);
  assert.ok(yields >= vt / (SLICE + STEP) * 0.9, `the entry yielded ${yields} times for ${vt.toFixed(0)} ms of modelled work`);
  for (const m of [g, life, bases]) m.dispose?.();
  assert.equal(SLICE_MS, 8, 'the counted bound is the desktop slice (no coarse pointer in the test)');
});

// map.mjs cannot load in Node (its lanes come from the build's virtual module), so the entry test above starts the lanes the
// way loadModules does; this pins that loadModules really does it: one taskClock.tasks() starter, and every lane's load
// (GROUND, the minimap, BASES, LIFE) plus the base-state pass started through it, never in the entry's own task.
test('map.mjs loadModules starts each lane at the head of its own task (taskClock.tasks)', () => {
  const src = readFileSync(new URL('./map.mjs', import.meta.url), 'utf8');
  const at = src.indexOf('function loadModules()'), body = src.slice(at, src.indexOf('\n  }\n', at));
  assert.ok(at > 0 && /const inTask = taskClock\.tasks\(\)/.test(body), 'loadModules makes one taskClock.tasks() starter');
  for (const [lane, re] of [['ground', /inTask\([^\n]*ground\.load\(/], ['base state', /inTask\([^\n]*pushBaseState\(\)/], ['minimap', /inTask\([^\n]*minimap\.load\(/],
    ['bases', /inTask\([^\n]*basesMod\.load\(/], ['life', /inTask\([^\n]*life\.load\(/]])
    assert.match(body, re, `${lane} starts through inTask`);
  assert.doesNotMatch(body.replace(/inTask\([^\n]*/g, ''), /\b(ground|minimap|life|basesMod)\.load\(/, 'no lane load starts outside inTask');
});
