// The web port's engine lifecycle (patches.md P11/P13), on a recording stand-in for WebGL2 and the page (node has no
// GPU, and a real-GPU browser hung this Mac on 2026-09-24). Each case names the regression it guards (review r2, L9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GPU_SAFE } from './contracts.mjs';
import { createRealmMap } from './map.mjs';
import { gpuRecord } from './core.mjs';
import { readFileSync } from 'node:fs';

/** Every listener the engine can add to the page, counted by target and type; the GPU crash record in localStorage. */
function page() {
  const live = new Map(), key = (target, type) => `${target}:${type}`;
  const bag = target => ({
    addEventListener(type, f) { const k = key(target, type); (live.get(k) ?? live.set(k, new Set()).get(k)).add(f); },
    removeEventListener(type, f) { live.get(key(target, type))?.delete(f); },
  });
  const store = new Map(), notice = { id: 'rm-gpu-notice', removed: false, remove() { notice.removed = true; } };
  const win = bag('window'), mq = bag('matchMedia'), observers = { live: 0 };
  Object.assign(globalThis, {
    addEventListener: win.addEventListener, removeEventListener: win.removeEventListener,
    document: { hidden: false, ...bag('document'), body: { dataset: {}, appendChild() {} }, getElementById: id => (id === notice.id && !notice.removed ? notice : null) },
    matchMedia: () => ({ matches: false, ...mq }),
    PerformanceObserver: class { observe() { observers.live++; } disconnect() { observers.live--; } },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    // the realm index answers; every pack file hangs: the engine stays inside loadRealm (realmLoading), as on a phone
    // whose first visit is still loading under the clouds
    fetch: async url => (/realm\/index\.json$/.test(url) ? { ok: true, json: async () => ({ schema: 1, realms: [{ id: 'sunscar' }] }) } : new Promise(() => {})),
  });
  const gl = new Proxy({ getParameter: () => 'Adreno (TM) 740', getExtension: () => null, isContextLost: () => false, getError: () => 0,
    getContextAttributes: () => ({ antialias: false }), getShaderParameter: () => true, getProgramParameter: () => true }, { get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return k.length * 131;
    return () => ({});
  } });
  const canvas = { ...bag('canvas'), getContext: () => gl, clientWidth: 390, clientHeight: 844, width: 390, height: 844, style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }), setPointerCapture() {}, releasePointerCapture() {} };
  const count = () => Object.fromEntries([...live].filter(([, s]) => s.size).map(([k, s]) => [k, s.size]));
  const lose = () => { for (const f of [...(live.get(key('canvas', 'webglcontextlost')) ?? [])]) f({ preventDefault() {} }); };
  const record = () => { const v = store.get(GPU_SAFE.storeKey); return v ? JSON.parse(v) : null; };
  return { canvas, count, lose, record, observers, notice, store };
}
const ui = () => ({ style: {}, appendChild() {}, querySelector: () => null });
const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const make = p => createRealmMap({ canvas: p.canvas, ui: ui(), pack: '/pack/', options: { host: {}, markers: true, chart16: false } });

// Review r2 #1: the controller force-loses a disposed realm's context. An engine that was only left (the old adapter
// dispose) and still loading read that loss as a GPU reset and stored a crash: every later realm visit, in this session
// and the next, started in safe mode. The first half proves the hazard is real on this stand-in; the second that a
// dispose makes the same loss a deliberate teardown.
test('P11: a context lost after dispose is a teardown, never a stored GPU reset (even mid-load)', async () => {
  const p = page();
  const old = make(p); old.enter('sunscar', 43, -26, 18).catch(() => {}); await ticks();
  old.leave(); p.lose();
  assert.equal(p.record()?.level, 2, 'control: leave() alone still stores the loss as a GPU reset');
  assert.equal(p.record()?.crashes, 1);

  const q = page();
  const map = make(q); const entered = map.enter('sunscar', 43, -26, 18); entered.catch(() => {}); await ticks();
  const before = q.record();
  map.dispose(); q.lose();
  assert.deepEqual(q.record(), before, 'no crash record, no safe mode on the next visit');
});

// Review r2 #3: every engine used to keep its window, document and matchMedia listeners (and through them its packs and
// decoded chart) for the page's life: one orphaned engine per WorldV2 mount on the phones R5 is about.
test('P11: dispose removes every listener the engine added, stops the observer and drops the QA handle', async () => {
  const p = page();
  const map = make(p); map.enter('sunscar', 43, -26, 18).catch(() => {}); await ticks();
  const added = p.count();
  for (const k of ['window:pagehide', 'window:keydown', 'window:resize', 'document:visibilitychange', 'matchMedia:change', 'canvas:webglcontextlost', 'canvas:pointerdown'])
    assert.ok(added[k] > 0, `the engine listens to ${k} (the count below is not vacuous)`);
  assert.equal(p.observers.live, 1);
  assert.equal(globalThis.__realm?.map, map);
  map.dispose();
  assert.deepEqual(p.count(), {}, 'every listener added is removed');
  assert.equal(p.observers.live, 0, 'the long-task observer is disconnected');
  assert.equal(globalThis.__realm, undefined, 'the QA handle no longer pins the engine');
  assert.equal(p.notice.removed, true, 'a GPU notice does not outlive the world that showed it');
  await assert.rejects(map.enter('sunscar', 43, -26, 18), { name: 'AbortError' }, 'a disposed engine never enters again');
});

test('P11: dispose({ notices: false }) keeps a GPU notice up (the host rebuilds the realm map at once)', async () => {
  const p = page();
  make(p).dispose({ notices: false });
  assert.equal(p.notice.removed, false);
});

// Review r2 #4: `pending` (a visit inside the map) is what makes the next visit start in safe mode, or be held. Android
// can discard a hidden tab without a pagehide, so a hidden realm map must not look like a visit in progress; showing it
// marks the same visit again, in the band it was in (a freeze after that is still caught).
test('P13: a hidden realm map is not a visit in progress; shown again, it is', async () => {
  const visit = gpuRecord.at(gpuRecord.enter({ crashes: 1 }, 5), 1);
  assert.equal(gpuRecord.start(visit, 9).level, 2, 'control: a discarded tab with the marker up reads as a crash');
  const hidden = gpuRecord.hide(visit);
  assert.deepEqual(hidden, { crashes: 1 });
  assert.deepEqual(gpuRecord.start(hidden, 9), { level: 0, reason: null, hold: false, rec: hidden }, 'discarded while hidden: no safe mode');
  assert.equal(gpuRecord.hide(gpuRecord.enter(null, 5)), null, 'nothing else stored: the record goes');
  assert.deepEqual(gpuRecord.show(hidden, 7, 1), { crashes: 1, pending: 7, band: 1 }, 'shown: marked again in its band');
  assert.equal(gpuRecord.start(gpuRecord.show(hidden, 7, 1), 9).level, 2, 'a freeze after showing is still caught');
  // the engine's hooks are these steps, and only while a realm is on screen (a clean leave already cleared the marker)
  const p = page(), map = make(p); await ticks();
  p.store.set(GPU_SAFE.storeKey, JSON.stringify(visit));
  map.suspend(); map.resume();
  assert.deepEqual(p.record(), visit, 'not on screen: suspend and resume leave the record alone');
  map.dispose();
  const src = readFileSync(new URL('./map.mjs', import.meta.url), 'utf8');
  assert.match(src, /suspend\(\) \{ if \(!active \|\| suspended \|\| core\.software\) return; suspended = true; gpuStore\.set\(gpuRecord\.hide\(gpuStore\.get\(\)\)\); \}/);
  assert.match(src, /resume\(\) \{[^\n]*gpuStore\.set\(gpuRecord\.show\(gpuStore\.get\(\), Date\.now\(\), Q\.visit\.band\)\); \}/);
});
