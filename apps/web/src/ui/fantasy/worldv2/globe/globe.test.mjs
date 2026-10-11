// createGlobe's host-facing behaviour on a recording stand-in for WebGL2 (no GPU: node has none, and a real-GPU browser
// hung this Mac on 2026-09-24). Pixels are proven by the SwiftShader captures; this pins the contract L6 builds on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGlobe } from './globe.mjs';
import { REALMS, PHASE_E } from './pin.mjs';
import { dirOf, lonlatOf, norm } from './camera.mjs';
import { ARCHIPELAGOS } from '../../runtime/world.mjs';
import { effectAnchors } from '../../runtime/island-effects.mjs';

function fakeGL(log) {
  let id = 0;
  return new Proxy({}, { get(_, k) {
    if (typeof k !== 'string') return undefined;
    if (/^[A-Z0-9_]+$/.test(k)) return k.length; // constants: any number
    if (k === 'getExtension') return () => null;
    if (k === 'getProgramParameter' || k === 'getShaderParameter') return () => true;
    if (k.startsWith('create') || k === 'getUniformLocation') return () => ({ id: ++id });
    return (...a) => { if (k.startsWith('draw')) log.push(k); if (k === 'texStorage3D' || k === 'texStorage2D') log.push(`${k}:${a.slice(2).join('x')}`); };
  } });
}
const SIZES = [[/a256-/, 256, 256], [/a1024-/, 1024, 1024], [/ssg512-|c512-/, 512, 512], [/phase-e\/sel-/, 40, 50], [/sel-/, 768, 384], [/island\.webp|isle\.webp/, 64, 64]];
function world({ webgl = true } = {}) {
  const gl = [], listeners = new Map(), raf = []; let now = 0;
  const canvas = { clientWidth: 390, clientHeight: 844, width: 0, height: 0, style: {},
    getContext: () => (webgl ? fakeGL(gl) : null), getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {},
    addEventListener: (n, f) => listeners.set(n, f), removeEventListener: n => listeners.delete(n) };
  globalThis.requestAnimationFrame = f => { raf.push(f); return raf.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Blob = class { constructor(parts) { this.parts = parts; } };
  globalThis.createImageBitmap = async blob => { const path = blob.parts[0].path, s = SIZES.find(([re]) => re.test(path)); return { width: s[1], height: s[2], close() { this.width = this.height = 0; } }; };
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; } getContext() { return { drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }; } };
  const fetched = [];
  globalThis.fetch = async url => { fetched.push(url); const path = url.replace('/pack/', '');
    if (path === 'globe-v2/globe-v2.json') { const body = new TextEncoder().encode(JSON.stringify({ selection: { phaseE: PHASE_E.map(s => ({ id: s.id, file: `phase-e/sel-${s.id}.png`, w: 40, h: 50, lon: s.lon, lat: s.lat, hu: 0.1, hv: 0.1 })) } }));
      return { ok: true, arrayBuffer: async () => body.buffer }; }
    const b = new ArrayBuffer(4); b.path = path; return { ok: true, arrayBuffer: async () => b }; };
  const land = { width: 1024, height: 1024, data: new Uint8ClampedArray(1024 * 1024 * 4).fill(1) };
  const events = [];
  const on = new Proxy({}, { get: (_, k) => (...a) => events.push([k, ...a]) });
  const flush = async (ms = 16, n = 1) => { for (let i = 0; i < n; i++) { for (let k = 0; k < 4; k++) await new Promise(r => setImmediate(r)); now += ms; const q = raf.splice(0); for (const f of q) f(now); } };
  const pointer = (type, x, y, pointerId = 1) => listeners.get(type)?.({ clientX: x, clientY: y, pointerId, preventDefault() {}, deltaY: 0 });
  const tapAt = async (x, y) => { pointer('pointerdown', x, y); await flush(16); pointer('pointerup', x, y); await flush(16); };
  const opts = extra => ({ chains: ARCHIPELAGOS, fileUrl: p => `/pack/${p}`, readIslandArt: async () => land, loadIslandEffects: async () => effectAnchors, on, now: () => now, ...extra });
  return { canvas, gl, listeners, events, flush, tapAt, pointer, opts, fetched, get now() { return now; } };
}
const named = (events, k) => events.filter(e => e[0] === k);
async function readyGlobe(w, extra) { const g = createGlobe(w.canvas, w.opts(extra)); for (let i = 0; i < 40 && !named(w.events, 'ready').length; i++) await w.flush(); return g; }
const screenOf = (g, lon, lat) => { const v = g.camera.computeView(390, 844); return g.camera.projectDir(dirOf(lon, lat)); };
async function settle(w, g, ms = 3000) { for (let t = 0; t < ms; t += 50) await w.flush(50); }

test('no WebGL2: createGlobe throws, so the host keeps the CPU globe (G5)', () => {
  const w = world({ webgl: false });
  assert.throws(() => createGlobe(w.canvas, w.opts()), /WebGL2 unavailable/);
});

test('ready fires once the first frame is drawn; only world-pack files are fetched', async () => {
  const w = world(); const g = await readyGlobe(w);
  assert.equal(named(w.events, 'ready').length, 1);
  assert.equal(named(w.events, 'progress').at(-1)[1], 1);
  assert.ok(w.gl.includes('drawArrays'), 'the flat pass drew');
  assert.ok(w.fetched.every(u => u.startsWith('/pack/')), 'nothing but pack files (plan §2)');
  await settle(w, g, 500);
  assert.equal(g.stats().albedo, 1024, 'the 1024² albedo replaces the 256² one');
  assert.ok(g.stats().islands, 'the 32 exploration islands are drawn');
  assert.ok(w.gl.includes('drawArraysInstanced'));
  assert.ok(g.view().zoom < 5, 'the globe reports host zoom below 5');
  g.dispose();
});

test('a realm tap selects it and reports it; a space tap deselects', async () => {
  const w = world(); const g = await readyGlobe(w);
  const R = REALMS.find(r => r.id === 'crownlands'); g.camera.t = dirOf(R.lon, R.lat); await w.flush();
  const [x, y] = screenOf(g, 26, 23);
  await w.tapAt(x, y); await w.flush();
  assert.deepEqual(named(w.events, 'select').at(-1), ['select', 'crownlands', null]);
  assert.equal(named(w.events, 'pick').at(-1)[1].id, 'crownlands');
  await settle(w, g, 1200); await w.flush(400, 2); // past the double-tap window
  await w.tapAt(2, 2);
  assert.deepEqual(named(w.events, 'pick').at(-1)[1], { kind: 'space' });
  assert.deepEqual(named(w.events, 'select').at(-1), ['select', null, null]);
  g.dispose();
});

test('an exploration island tap hands the host its chain and island ids (RG-1)', async () => {
  const w = world(); const g = await readyGlobe(w); await settle(w, g, 300);
  const c = ARCHIPELAGOS.find(x => x.id === 'emberwake'), s = c.islands[2];
  g.focusIsland('emberwake', 'emberwake-3'); await settle(w, g, 2500);
  const [x, y] = screenOf(g, s.lon, s.lat);
  await w.tapAt(x, y);
  const p = named(w.events, 'pick').at(-1)[1];
  assert.equal(p.kind, 'explore'); assert.equal(p.chainId, 'emberwake'); assert.equal(p.islandId, 'emberwake-3');
  g.dispose();
});

test('EXPLORE focuses every one of the 32 exploration islands: the camera rests inside that island (G1, RG-1)', async () => {
  // The host's EXPLORE list sends `${chain.id}-${slot}` ids; a wrong slot parse falls back to the whole chain, whose
  // centre sits outside any one island, so a player tapping "Island 4" would be flown somewhere else.
  const w = world(); const g = await readyGlobe(w); await settle(w, g, 300);
  const ids = ARCHIPELAGOS.flatMap(c => c.islands.map((s, i) => ({ chainId: c.id, islandId: `${c.id}-${i + 1}`, s })));
  assert.equal(ids.length, 32, 'the host ARCHIPELAGOS carry 32 islands');
  for (const { chainId, islandId, s } of ids) {
    assert.equal(g.focusIsland(chainId, islandId), true, islandId);
    await settle(w, g, 2500);
    const { lon, lat } = lonlatOf(norm(g.camera.t));
    const dLon = ((lon - s.lon + 540) % 360) - 180, box = { lon: s.rx * 1.6, lat: s.ry * 1.6 };
    assert.ok(Math.abs(dLon) <= box.lon && Math.abs(lat - s.lat) <= box.lat,
      `${islandId}: camera target ${lon.toFixed(2)},${lat.toFixed(2)} is outside the island box ${s.lon}±${box.lon.toFixed(2)}, ${s.lat}±${box.lat.toFixed(2)}`);
    const p = screenOf(g, s.lon, s.lat);
    assert.ok(p && p[0] >= 0 && p[0] <= 390 && p[1] >= 0 && p[1] <= 844, `${islandId}: the island is on screen after the flight`);
  }
  g.dispose();
});

test('Enter map: prefetch at once, dive after the flight, clouds part, the globe sleeps; wake draws before resolving', async () => {
  const w = world(); const g = await readyGlobe(w);
  assert.equal(g.diveInto('sunscar'), true);
  assert.deepEqual(named(w.events, 'approach').at(-1), ['approach', 'sunscar'], 'D-177: the realm loads during the flight');
  await settle(w, g, 2500);
  const d = named(w.events, 'dive'); assert.equal(d.length, 1); assert.equal(d[0][1].realmId, 'sunscar'); assert.ok(d[0][1].sStart > 0);
  g.diveResult(true, 'sunscar'); await settle(w, g, 800);
  assert.equal(g.asleep, true, 'one engine awake (R5)');
  const draws = w.gl.length; await w.flush(50, 4); assert.equal(w.gl.length, draws, 'asleep: no frames');
  let woke = false; const p = g.leave({ realmId: 'sunscar', lon: 43, lat: -26 }).then(() => { woke = true; });
  await w.flush(); await p; assert.ok(woke && w.gl.length > draws, 'a frame is on the canvas before the host drops its snapshot');
  g.dispose();
});

// Review r2 (L9): the clouds part over up to 450 ms after a slow dive lands, and Back / the Globe exit are live at once.
// A leave inside that window must leave the globe awake: a globe put to sleep after the leave ignores every tap, focus
// and dive until the tab is hidden and shown again. Runs the real cover clock (motion.mjs), not a stand-in.
test('leaving while the clouds still part keeps the globe awake (the parting\'s sleep is cancelled)', async () => {
  const w = world(); const g = await readyGlobe(w);
  g.diveInto('sunscar'); await settle(w, g, 2500);
  assert.equal(named(w.events, 'dive').length, 1);
  await settle(w, g, 800); // a slow first visit: the clouds have risen under the cover
  g.diveResult(true, 'sunscar'); // parting starts; the controller is in 'realm' now
  await w.flush(16);
  const p = g.leave({ realmId: 'sunscar', lon: 43, lat: -26 }); await w.flush(16); await p;
  await settle(w, g, 1000); // past the whole parting
  assert.equal(g.asleep, false, 'the leave woke it and nothing put it back to sleep');
  const draws = w.gl.length; await w.flush(50, 4);
  assert.ok(w.gl.length > draws, 'it still draws');
  assert.equal(g.diveInto('frostveil'), true, 'and still dives');
  g.dispose();
});

test('a failed dive reopens the realm and blocks the auto-dive; Back cancels a committed dive', async () => {
  const w = world(); const g = await readyGlobe(w);
  g.diveInto('frostveil'); assert.equal(g.cancelDive(), 'frostveil');
  await settle(w, g, 2500); assert.equal(named(w.events, 'dive').length, 0, 'Back never pulls the player into the map');
  g.diveInto('elderwood'); await settle(w, g, 2500); assert.equal(named(w.events, 'dive').length, 1);
  g.diveResult(false, 'elderwood'); await settle(w, g, 1000);
  assert.equal(g.asleep, false); assert.equal(g.selection.realmId, 'elderwood');
  assert.equal(named(w.events, 'dive').length, 1, 'no retry every frame while parked low');
  g.dispose();
});

test('context loss restores content and keeps the camera and selection; dispose stops everything', async () => {
  const w = world(); const g = await readyGlobe(w);
  g.selectRealm('stormcairn'); await settle(w, g, 2000); const before = g.snapshot();
  w.listeners.get('webglcontextlost')({ preventDefault() {} });
  assert.equal(named(w.events, 'contextLost').length, 1);
  w.listeners.get('webglcontextrestored')({}); await settle(w, g, 400);
  assert.equal(g.state, 'ready'); assert.equal(g.stats().albedo, 1024);
  assert.deepEqual(g.snapshot().realmId, before.realmId);
  g.dispose(); assert.equal(w.listeners.size, 0, 'every listener removed');
  const n = w.gl.length; await w.flush(16, 3); assert.equal(w.gl.length, n);
});

test('Phase E islands: never picked while off (RG-3); with the option they load, name themselves and select', async () => {
  const off = world(); const g0 = await readyGlobe(off); await settle(off, g0, 300);
  const I = PHASE_E[0]; g0.camera.t = dirOf(I.lon, I.lat); await off.flush();
  let [x, y] = screenOf(g0, I.lon, I.lat); await off.tapAt(x, y);
  assert.notEqual(named(off.events, 'pick').at(-1)[1].kind, 'phase-e'); g0.dispose();

  const on = world(); const g = await readyGlobe(on, { phaseEIslands: true, phaseELayer: 64 });
  for (let i = 0; i < 200 && !named(on.events, 'phaseEIslands').length; i++) await on.flush(16);
  assert.deepEqual(named(on.events, 'phaseEIslands')[0][1], PHASE_E.map(s => s.id));
  g.camera.t = dirOf(I.lon, I.lat); await on.flush(); [x, y] = screenOf(g, I.lon, I.lat); await on.tapAt(x, y);
  assert.deepEqual(named(on.events, 'select').at(-1), ['select', null, 'seeker-island']);
  assert.ok(g.labels().some(l => l.id === 'seeker-island') || g.camera.view.alt <= 0.35);
  g.dispose();
});
