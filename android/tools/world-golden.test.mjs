import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KOTLIN_CONSTANTS, OUT_DIR, SUITES, compare, serialize } from './world-golden.mjs';

// Why: the native realm map ports the web engine's pure functions 1:1 (GLOBE-NATIVE-PLAN §7), and a port is only as
// good as the vectors it is tested against. These tests run without the web repo: they prove the committed vectors are
// the ones this generator produced at the locked pin (so a stale file cannot pass as current), and that the vectors
// themselves obey the rules the native code will be held to — a golden set that broke those rules would teach the port
// a bug. The re-generation against the real pin is the local gate step `node tools/world-golden.mjs --source … --check`.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'world-shaders.lock.json'), 'utf8'));
const load = s => JSON.parse(fs.readFileSync(path.join(ROOT, OUT_DIR, `${s}.json`), 'utf8'));
const num = v => (typeof v === 'string' ? Number(v) : v);

test('every suite is the output of this generator at the locked pin and the pinned pack manifest', () => {
  const generator = createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'tools/world-golden.mjs'))).digest('hex');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, OUT_DIR)).sort(), SUITES.map(s => `${s}.json`).sort());
  for (const s of SUITES) {
    const g = load(s);
    assert.equal(g.suite, s);
    assert.equal(g.pin, lock.source.commit, `${s}: a golden from another pin is not what the renderer draws`);
    assert.equal(g.generator, generator, `${s}: the generator changed since this file was written: re-run tools/world-golden.mjs`);
    if (['grid', 'deedmask', 'pick', 'cluster'].includes(s)) assert.equal(g.pack.manifestSha256, lock.contentManifest.sha256, `${s}: pack bytes from the pinned manifest`);
    assert.ok(g.count > 0, `${s} carries vectors`);
  }
  // the engine's presentation constants come from the same run: same pin, same generator, never a hand copy
  const kt = fs.readFileSync(path.join(ROOT, KOTLIN_CONSTANTS), 'utf8');
  assert.ok(kt.includes(`const val PIN: String = "${lock.source.commit}"`) && kt.includes(`Generator sha256 ${generator}.`), 'WorldEngineConstants.kt is this generator\'s output at the pin');
  assert.doesNotMatch(kt, /\b(TILES|DEED_ART|MAP_ART|WORLD_ORIGIN|CLAIM|WALL)\b/, 'no game number is emitted as a Kotlin constant');
});

test('contracts: every plot offset stays inside its deed room, for every sampled deed and level', () => {
  const c = load('contracts');
  assert.equal(c.deeds.length, 500);
  assert.equal(c.plotHash.length, 500);
  for (const h of c.plotHash) assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff, 'plotHash is a uint32 (GLSL twin)');
  for (let L = 1; L <= 20; L++) {
    const room = c.plotRoom[L - 1], o = c.plotOffset[L];
    assert.equal(o.length, 1000);
    for (const v of o) assert.ok(Number.isInteger(v) && Math.abs(v) <= room, `L${L}: |${v}| ≤ room ${room}: two plots never touch`);
  }
  assert.ok(c.plotRoom[0] > c.plotRoom[19], 'a bigger kingdom sits nearer its deed centre');
  assert.equal(c.constants.GPU_SAFE.severeNeed, 2, 'HangGuard is GPU_SAFE verbatim (N0 decision)');
});

test('camera: at rest the fade weight is exactly 0 or 1, rest targets never rest inside a no-rest band, traces end at rest', () => {
  const c = load('camera'), rest = c.constants?.rest ?? [[24, 48], [200, 280], [800, 1100]];
  const inRest = d => rest.some(([a, b]) => d > a && d < b);
  for (const row of c.bands) {
    const [d, snapped, inside, , fade, target] = row.map(num);
    assert.equal(inside === 1, inRest(snapped), `d ${d}: inRest reads the edge-snapped d`);
    // N2 gate: a resting camera is never mid-fade (plan §9 N2 "fade weight ∈ {0, 1} at rest")
    if (!inside) assert.ok(fade === 0 || fade === 1, `d ${d}: fade ${fade} at a resting d`);
    assert.ok(!inRest(target), `restTarget(${d}) = ${target} rests outside every no-rest band`);
  }
  for (const [d, lo, hi, t] of c.rest.map(r => r.map(num))) if (t >= lo && t <= hi) assert.ok(!inRest(t), `restTarget(${d}, ${lo}, ${hi})`);
  assert.ok(c.traces.length >= 20);
  for (const tr of c.traces) {
    assert.equal(tr.ops.length, tr.states.length);
    const [, , s, moving, goal] = tr.states[tr.states.length - 1], dpr = tr.viewport[2];
    if (/rest band|snap|settle|double-tap/.test(tr.name)) {
      assert.equal(moving, 0, `${tr.name}: settled`); assert.equal(goal, null, tr.name);
      assert.ok(!inRest(s * dpr * (1 + 1e-12)) || !inRest(s * dpr * (1 - 1e-12)), `${tr.name}: rests at d ${s * dpr}, never inside a fade`);
    }
    if (/pixel-snap/.test(tr.name)) assert.ok(Math.abs((s * dpr) / 3136 - Math.round((s * dpr) / 3136)) < 1e-9, `${tr.name}: whole device px per art px`);
  }
});

test('grid: every sampled catalog tile round-trips, the Cinderfall wrap is covered, and no other realm\'s tile is this realm\'s', () => {
  const g = load('grid'), W = g.lattice[0];
  const tileOf = (gr, dx, dy) => (gr.y0 + dy) * W + ((((gr.x0 + dx) % W) + W) % W);
  assert.equal(g.realms.length, 8, 'all eight realms');
  for (const r of g.realms) {
    for (const [t, dx, dy] of r.catalogTiles) if (dx >= 0) assert.equal(tileOf(r.grid, dx, dy), t, `${r.id} ${t}`);
    for (const [dx, dy, t] of r.forward) if (dx >= 0 && dy >= 0 && dx < r.grid.cols && dy < r.grid.rows) assert.equal(tileOf(r.grid, dx, dy), t);
    for (const [, , , realm] of r.otherRealmSample) assert.notEqual(realm, r.id);
  }
  const cinder = g.realms.find(r => r.id === 'cinderfall');
  assert.ok(cinder.grid.x0 < 0, 'Cinderfall crosses the antimeridian');
  assert.ok(cinder.catalogTiles.some(([t, dx]) => t % W >= W + cinder.grid.x0 && dx >= 0 && dx < -cinder.grid.x0), 'a wrapped Cinderfall tile is sampled');
});

test('deed masks: every mismatch is listed and the counts add up (the grid is never bent to fit a pack)', () => {
  const m = load('deedmask');
  assert.equal(m.realms.length, 8);
  for (const r of m.realms) {
    assert.equal(r.mismatch.length, r.mismatchCount);
    assert.equal(r.counts.packThis + r.counts.packOther + r.counts.packNone + r.counts.packOtherValue, r.cols * r.rows);
    for (const [, , , pack, want] of r.mismatch) assert.notEqual(pack, want);
  }
});

test('pick: a hit is a base on its own deed or an open deed, inside the grid', () => {
  const p = load('pick'), grid = new Map(load('grid').realms.map(r => [r.id, r.grid]));
  for (const c of p.cases) {
    const g = grid.get(c.realm), bases = p.bases[c.realm];
    assert.equal(c.hits.length % 4, 0);
    for (let k = 0; k < c.hits.length; k += 4) {
      const [i, dx, dy, id] = c.hits.slice(k, k + 4);
      assert.ok(i >= 0 && i < c.points.nx * c.points.ny && dx >= 0 && dy >= 0 && dx < g.cols && dy < g.rows);
      if (id >= 0) assert.deepEqual(bases[id].slice(0, 2), [dx, dy], `${c.realm} ${c.view}: base ${id} sits on the picked deed`);
    }
  }
  const ids = p.cases.flatMap(c => c.hits.filter((_, k) => k % 4 === 3));
  assert.ok(ids.some(id => id >= 0) && ids.some(id => id === -1), 'both kinds of hit are exercised');
});

test('cluster: the counters account for every base on screen, stay ≤ 40 and inside the safe box', () => {
  const c = load('cluster');
  for (const k of c.cases) {
    assert.equal(k.list.reduce((s, x) => s + x[0], 0), k.onScreen, `${k.realm} ${k.viewport} ${k.view}: count sum = bases on screen`);
    assert.ok(k.list.length <= 40);
    for (const [, px, py, w] of k.list) assert.ok(px - w / 2 >= k.box[0] - 1e-9 && px + w / 2 <= k.box[2] + 1e-9 && py - 14 >= k.box[1] - 1e-9 && py + 14 <= k.box[3] + 1e-9);
  }
  assert.ok(c.cases.some(k => k.list.length > 1));
});

test('gpurecord: crash memory never clears by time or by visits that never drew where it froze; TRY AGAIN keeps the count', () => {
  // Why (W1 S5, W1 fix pass 2 #6): a device that froze in the realm map must start the next visit in safe mode, and a
  // few seconds at FAR must not clear a MAP freeze. The native HangRecord port is tested against these calls, so they
  // must themselves obey the rule; a golden that let a FAR visit clear a MAP crash would teach the port the old bug.
  const g = load('gpurecord'), bandOr = (b, d) => (Number.isInteger(b) ? Math.min(2, Math.max(0, b)) : d);
  let calls = 0, unclean = 0, pendingStarts = 0;
  for (const { name, calls: cs } of g.traces) for (const { op, rec, args, out } of cs) {
    calls++;
    const param = op === 'start' ? args[1] : null, next = op === 'start' ? out.rec : out;
    if (param !== '0') assert.ok((next?.crashes ?? 0) >= (rec?.crashes ?? 0), `${name}: ${op} never lowers the crash count`);
    if (op === 'start' && param == null && rec?.pending) { pendingStarts++; assert.equal(out.level, 2, `${name}: a visit left pending starts safe`); }
    if (op === 'start' && param == null && (rec?.level ?? 0) > 0) assert.ok(out.level > 0, `${name}: no time expiry at start`);
    if (op === 'leave' && (rec?.level ?? 0) > 0 && (args[0]?.steadyBand ?? -1) < bandOr(rec.crashBand, 1)) {
      unclean++;
      const want = { ...rec }; delete want.pending; delete want.band;
      assert.deepEqual(out, want, `${name}: a visit without steady frames at the crash band counts nothing`);
    }
    if (op === 'tryAgain' && out) assert.equal(out.crashes, rec.crashes ?? 0, `${name}: TRY AGAIN keeps the crash count`);
  }
  assert.ok(unclean >= 4 && pendingStarts >= 5, 'the suite exercises unclean visits and pending starts');
  for (const { steady, band } of g.steadyBand) assert.equal(band, steady.some(n => n >= g.crash.steady) ? Math.max(...steady.map((n, i) => (n >= g.crash.steady ? i : -1))) : -1);
  assert.deepEqual([g.bandSet.far, g.bandSet['far-map'], g.bandSet.map, g.bandSet['map-true'], g.bandSet.true], [0, 1, 1, 2, 2]);
  assert.equal(g.count, calls + g.steadyBand.length);
});

test('camera D-173: once landed nothing rests below the floor, the leave ends in the chart, the dive never enters MAP before its gate opens', () => {
  // Why (owner 2026-09-25, D-173): the realm map never rests zoomed out as a flat image. The native camera replays these
  // traces, so they must show the rule: every floor script and every dive ends at rest ON the floor (BANDS.mapStart), the
  // raw leave ends in the painted chart (below farEnd), and a dive held at the chart edge draws no MAP-band frame until
  // the gate lifts (the P0 class: an unrehearsed first MAP frame froze SwiftShader for 17-36 s).
  const c = load('camera'), B = load('contracts').constants.BANDS, RH = load('contracts').constants.GPU_SAFE.rehearse;
  const d173 = c.traces.filter(t => t.name.includes('D-173'));
  assert.equal(d173.length, 8 * 4, '8 D-173 scripts per viewport');
  for (const t of d173) {
    const dpr = t.viewport[2], last = t.states.at(-1), dEnd = last[2] * dpr;
    assert.equal(last[3], 0, `${t.name}: ends at rest`);
    if (/leave/.test(t.name)) {
      assert.ok(Math.abs(dEnd - B.farEnd * 0.9) < 1e-9, `${t.name}: the leave ends at farEnd × 0.9 (d ${dEnd})`);
      assert.ok(t.ops.some(o => o[1] === 'flyToDRaw' && o[5] === RH.leaveMs), `${t.name}: over GPU_SAFE.rehearse.leaveMs`);
    } else assert.ok(Math.abs(dEnd - B.mapStart) < 1e-9, `${t.name}: rests on the floor (d ${dEnd})`);
    if (/dive/.test(t.name)) {
      const open = t.ops.findIndex(o => o[1] === 'limitD' && o[2] === 'Infinity');
      assert.ok(open > 0, `${t.name}: the gate opens`);
      const entry = t.ops.findIndex(o => o[1] === 'set'); // before it the camera holds createCamera's default s (not a frame)
      for (let i = entry; i < open; i++) assert.ok(t.states[i][2] * dpr <= B.farEnd * (1 + 1e-9), `${t.name}: op ${i} is past farEnd before the gate opened`);
      assert.ok(t.ops.some(o => o[1] === 'flyToD' && o[4] === B.mapStart && o[5] === RH.diveMs), `${t.name}: flies diveMs to the floor`);
    }
  }
});

test('bandlimit: the dive holds at farEnd while lanes load; a gating MAP item holds farEnd, a TRUE item trueStart; bypass, valve and off never hold', () => {
  // Why (stage B D5, D-173 + W1 S2): the camera may not zoom past a band edge whose pipelines are not built. The native dive
  // readiness is held to these vectors, so the vectors must encode that rule, whatever the item order.
  const g = load('bandlimit'), B = load('contracts').constants.BANDS, lim = v => (v === 'Infinity' ? Infinity : v);
  assert.equal(g.rows.length, 2 ** 5 * g.itemSets.length);
  for (const [on, bypass, valve, dive, lanesIn, i, l, band, reason] of g.rows) {
    const items = g.itemSets[i], map = items.some(([s, gt]) => s <= 1 && gt), tru = items.some(([s, gt]) => s <= 2 && gt);
    const want = bypass ? Infinity : !on || valve ? Infinity : dive && !lanesIn ? B.farEnd : map ? B.farEnd : tru ? B.trueStart : Infinity;
    assert.equal(lim(l), want, JSON.stringify([on, bypass, valve, dive, lanesIn, i]));
    if (want === Infinity) assert.equal(band, null); else assert.equal(band, want === B.farEnd ? 'map' : 'true');
    if (!bypass && on && !valve && dive && !lanesIn) assert.equal(reason, 'loading');
  }
  for (const [l, band] of g.defaults) { assert.equal(lim(l), Infinity); assert.equal(band, null); }
});

test('serialization is canonical and the drift check sees every changed, extra or missing suite', () => {
  assert.equal(serialize({ b: [1, 2], a: { d: Infinity, c: 0.1 } }), '{\n "a": {\n  "c": 0.1,\n  "d": "Infinity"\n },\n "b": [1,2]\n}');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-golden-'));
  try {
    const files = new Map([['contracts.json', Buffer.from('a\n')], ['camera.json', Buffer.from('b\n')]]);
    const dir = path.join(root, OUT_DIR); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'contracts.json'), 'a\n'); fs.writeFileSync(path.join(dir, 'stray.json'), '');
    assert.deepEqual(compare(root, files).sort(), ['extra stray.json', 'missing camera.json']);
    fs.writeFileSync(path.join(dir, 'contracts.json'), 'x\n');
    assert.ok(compare(root, files).includes('changed contracts.json'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
