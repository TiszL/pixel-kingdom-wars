// core.test — why it matters: (1) the timed idle policy (C10) is what keeps a living map from draining
// a phone lying on a table: full cadence ≤ 20 fps for 20 s, ≤ 8 fps to 60 s, then 0 fps (only a
// selection/shield pulse at ≤ 4 fps); nothing renders when nothing animates, the tab is hidden, or
// reduced motion is on. (2) Scatter, variants and water phases must hash exactly like the realm kit,
// or "Enter base" would show a different ground than the realm map at the same deed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleInterval, lru, bytesPerTexel, maxLevels, watchdog, groundScale, groundDiv, fullResPass, qualityStep, isColdFrame, rehearsalHeld, retryAt, gpuRecord, createCore, preprocessGLSL, govStep, governedPass, bandLimit } from './core.mjs';
import { PASS, frameCost, resolveBudget, DISPLAY_BUDGET, FRAME_BUDGET, FRAME_ITER_BUDGET, RESOLVE_BUDGET } from './groundcost.mjs';
import { kitHash, pcg2d, vnoise, bayer4, dissolve } from './glsl/common.glsl.mjs';
import { IDLE, GPU_SAFE, BANDS } from './contracts.mjs';

test('idle policy: full cadence capped at 20 fps for 20 s after input', () => {
  const r = idleInterval({ sinceInputMs: 5000, periods: [50] }); assert.equal(r.phase, 'full'); assert.equal(r.ms, 1000 / IDLE.fullCapFps);
  const c = idleInterval({ sinceInputMs: 5000, periods: [20] }); assert.equal(c.ms, 50, 'continuous animations never exceed 20 fps');
  const k = idleInterval({ sinceInputMs: 5000, periods: [160, 110], clockMs: 1000 }); assert.equal(k.ms, 110 - (1000 % 110), 'renders when the fastest clip changes frame');
});
test('idle policy: 20–60 s caps at 8 fps', () => {
  const r = idleInterval({ sinceInputMs: 30000, periods: [50, 83] }); assert.equal(r.phase, 'capped'); assert.equal(r.ms, 125);
  const slow = idleInterval({ sinceInputMs: 30000, periods: [260], clockMs: 0 }); assert.equal(slow.ms, 260, 'slower clips keep their own period');
});
test('idle policy: after 60 s rendering stops, except a selection/shield pulse at ≤ 4 fps', () => {
  assert.equal(idleInterval({ sinceInputMs: 61000, periods: [50, 83] }).ms, Infinity);
  const p = idleInterval({ sinceInputMs: 61000, periods: [50], pulsePeriods: [50] }); assert.equal(p.phase, 'frozen'); assert.equal(p.ms, 250);
});
test('idle policy: 0 fps when nothing animates, the tab is hidden, or reduced motion is on', () => {
  assert.equal(idleInterval({ sinceInputMs: 0, periods: [] }).ms, Infinity);
  assert.equal(idleInterval({ sinceInputMs: 0, periods: [50], hidden: true }).ms, Infinity);
  assert.equal(idleInterval({ sinceInputMs: 0, periods: [50], reducedMotion: true }).ms, Infinity);
});

test('kitHash is the realm kit realmKitTileHash, bit for bit (vectors from the kit at fc5c6ad1)', () => {
  const V = [[0, 0, 851924796], [1, 0, 1098065842], [0, 1, 221342572], [98, 49, 3897201139], [-34, -34, 4209988391], [12345, 6789, 2341365565], [-1, -1, 589792014], [2147483647, -2147483648, 105389196]];
  for (const [x, y, h] of V) assert.equal(kitHash(x, y), h, `kitHash(${x},${y})`);
});
test('pcg2d / vnoise / bayer4 / dissolve are deterministic and in range', () => {
  assert.deepEqual(pcg2d(1, 2), pcg2d(1, 2)); assert.notDeepEqual(pcg2d(1, 2), pcg2d(2, 1));
  for (const [x, y] of [[0, 0], [-7, 13], [1000, -999]]) { const n = vnoise(x, y, 20, 3); assert.ok(n >= -1 && n <= 1); assert.equal(n, vnoise(x, y, 20, 3)); }
  assert.ok(Math.abs(vnoise(0, 0, 20, 3) - vnoise(1, 0, 20, 3)) < 0.2, 'value noise is continuous at lattice scale');
  const seen = new Set(); for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) seen.add(bayer4(x, y)); assert.equal(seen.size, 16);
  assert.equal(dissolve(0x1234, 0), false); assert.equal(dissolve(0x1234, 1), true);
});

test('lru evicts the least recently used and calls onEvict', () => {
  const ev = []; const c = lru(2); c.put('a', 1, v => ev.push(v)); c.put('b', 2, v => ev.push(v)); c.get('a'); c.put('c', 3);
  assert.deepEqual(c.keys(), ['a', 'c']); assert.deepEqual(ev, [2]);
});
test('texel byte sizes feed gpuMB honestly', () => {
  assert.equal(bytesPerTexel('RGBA16UI'), 8); assert.equal(bytesPerTexel('R8UI'), 1); assert.equal(bytesPerTexel('RGB8'), 4, 'RGB8 is stored as 4 bytes');
  assert.equal(maxLevels(32, 32), 6);
});

// plotRule is the single plot-geometry source for GROUND (plot SDF), BASES (decor) and PACK (impostors).
// Why: the lens bound R + 12 ≤ 49 (plan §3.2) and "the plot never crosses a deed edge" both rest on it.
import { plotRule, decorCap, TILES, PLOT_CENTRE } from './contracts.mjs';
test('plotRule: claim from the PvE table, ring 4..9, plot inside its deed, walls per keep level', () => {
  const l1 = plotRule(1), l20 = plotRule(20);
  assert.deepEqual([l1.claim, l1.ring, l1.plotTiles, l1.wallTier, l1.wallRings], [14, 4, 22, 1, 0]);
  assert.deepEqual([l20.claim, l20.ring, l20.plotTiles, l20.wallTier, l20.wallRings], [26, 9, 44, 5, 3]);
  for (let L = 1; L <= 20; L++) { const p = plotRule(L); assert.ok(PLOT_CENTRE - p.plotTiles / 2 >= 0 && PLOT_CENTRE + p.plotTiles / 2 <= TILES, `L${L} plot leaves its deed`); }
  assert.equal(decorCap('archer', 1), 1, 'game cap binds at L1'); assert.equal(decorCap('archer', 20), 4, 'decor cap binds at L20');
  assert.equal(decorCap('mine', 5), 4, 'no build cap → decor cap'); assert.equal(decorCap('nonsense', 5), 0);
  assert.equal(decorCap('alchemylab', 1), 0, 'the alchemy lab is the runtime forge: none before the Keep L2 gate');
  assert.equal(decorCap('alchemylab', 2), 1);
});

// plotOffset (round 2, T3): the owner rejected plots "in a rigid lattice". Why each check matters:
// (1) every lane (GROUND lens/rim, BASES decor, LIFE scatter, SHELL fly/tags) draws the same plot only if the hash is
//     frozen — pinned vectors catch a silent change in JS or its GLSL twin's constants;
// (2) the lens rule (plan §3.2) keeps a plot's island and lens inside its own deed, so a neighbour never floods it;
// (3) offsets must actually break the lattice (spread, both signs, not all zero) yet stay whole tiles (TRUE grid);
// (4) a missing level would silently use L1's big room for an L20 kingdom and push its lens out of the deed.
import { plotOffset, plotRoom, plotHash, plotCentre, PLOT_OFFSET, LINES } from './contracts.mjs';
import { CLASS_CFG } from './classify.mjs';
test('plotOffset: frozen hash, whole tiles, inside the lens-safe room, breaks the lattice', () => {
  assert.equal(plotHash(0, 0), plotHash(0, 0)); assert.notEqual(plotHash(1, 0), plotHash(0, 1), 'x and y decorrelated');
  const V = [[0, 0, 1], [1, 0, 1], [0, 1, 20], [123, 77, 9], [150, 3, 14]];
  const pinned = V.map(([x, y, L]) => { const o = plotOffset(x, y, L); return [o.dx, o.dy]; });
  assert.deepEqual(pinned, PINNED_OFFSETS, 'plotOffset vectors changed: every lane (and the GLSL twin) must change with it');
  assert.equal(plotRoom(1), 28); assert.equal(plotRoom(20), 17); // fix iteration 2 (T3 lattice): lensMargin 6, rimGap 2
  const dxs = new Set(); let zero = 0, n = 0;
  for (let L = 1; L <= 20; L++) {
    const p = plotRule(L), room = plotRoom(L), half = p.claim / 2 + p.ring + PLOT_OFFSET.plotMargin;
    assert.ok(PLOT_CENTRE + room + half + PLOT_OFFSET.rimGap + PLOT_OFFSET.lensMargin <= TILES, `L${L}: lens leaves the deed`);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const o = plotOffset(x, y, L); n++;
      assert.ok(Number.isInteger(o.dx) && Number.isInteger(o.dy), 'whole tiles');
      assert.ok(Math.abs(o.dx) <= room && Math.abs(o.dy) <= room, `L${L} (${x},${y}) ${o.dx},${o.dy} > room ${room}`);
      if (o.dx === 0 && o.dy === 0) zero++;
      if (L === 1) dxs.add(o.dx);
    }
  }
  assert.ok(dxs.size >= 25 && Math.min(...dxs) === -28 && Math.max(...dxs) === 28, `L1 offsets spread over the room: ${[...dxs].sort((a, b) => a - b)}`);
  assert.ok(zero / n < 0.05, `too many centred plots (${zero}/${n}): the lattice would show`);
  const c = plotCentre(10, 20, 5), o = plotOffset(10, 20, 5);
  assert.ok(Math.abs(c.x - (10 + (PLOT_CENTRE + o.dx) / TILES)) < 1e-12 && Math.abs(c.y - (20 + (PLOT_CENTRE + o.dy) / TILES)) < 1e-12);
  assert.throws(() => plotOffset(1, 2), /level is required/);
  // GROUND's rim and lens must fit the same room (it builds the rim with axisMax − max(|dx|,|dy|)).
  assert.ok(CLASS_CFG.rim.gap <= PLOT_OFFSET.rimGap && CLASS_CFG.plotMargin <= PLOT_OFFSET.plotMargin && LINES.lensMargin === PLOT_OFFSET.lensMargin,
    'classify.mjs grew its rim gap / plot margin past PLOT_OFFSET: the offset room would push lenses out of their deeds');
});
const PINNED_OFFSETS = [[-3, -1], [-20, -22], [11, -4], [-18, 3], [-5, -21]];

// GPU safety (P0, KNOWN_ISSUES RM-GPU-1) — why it matters: the realm map froze the owner's whole Mac (Chrome AND the
// desktop apps). These pin the guards that must hold on real hardware, where no QA run may measure them:
// (1) the ground passes always render at an integer fraction of the canvas, never above the display budget per canvas px;
// (2) the watchdog lowers quality on sustained slow or repeatedly stalled STEADY GPU frames, never on a hiccup or on a
//     frame's one-off first-draw / rehearsal / link / upload work, and steps back up when the GPU proves fast;
// (3) a session that died inside the map, or lost its context, restarts in safe mode instead of re-running the hang.
// W1 S3 rewrote (1) (owner bar, high): P0 capped the ground at 1.5 px per CSS px everywhere, so the owner's retina drew
// TRUE at rest into a ½ target — soft pixel art under crisp sprites — although ONE pass at rest costs what the fade's
// two passes cost at ½. Now: full resolution when one cheap pass is drawn at rest, ½ only while two are drawn.
const SCREENS3 = [['retina 1280×800 dpr 2', 1280, 800, 2], ['desktop 1920×1080 dpr 2', 1920, 1080, 2], ['phone 390×844 dpr 3', 390, 844, 3]];
const canvasOf = (w, h, dpr) => { const r = Math.min(2, dpr); return [Math.round(w * r), Math.round(h * r)]; }; // core.resize caps dpr at 2
// the band states a ground frame can be in: the ONE pass drawn at rest (groundDiv's `pass`), or a cross-fade (null)
const STATES = [['FAR rest', 'chart', { chart: true }], ['FAR→MAP fade', null, { chart: true, map: true }], ['MAP rest', 'map', { map: true }],
  ['MAP rest, lattice missing', null, { chart: true, map: true }], ['MAP→TRUE fade', null, { map: true, true: true }], ['TRUE rest', 'true', { true: true }],
  ['TRUE rest, pages missing', null, { map: true, true: true }], ['all three (worst fade)', null, { chart: true, map: true, true: true }]];
test('GPU safety: the ground renders at an integer fraction of the canvas; full resolution only for ONE cheap pass at rest', () => {
  for (const d of [1, 1.25, 1.5, 2, 2.625, 3]) {
    const dpr = Math.min(2, d);
    for (const L of [0, 1, 2]) for (const [, pass] of STATES) {
      const n = groundDiv(dpr, L, pass); assert.ok(Number.isInteger(n) && n >= 1 && n <= 4, `dpr ${d} L${L}: n ${n}`);
    }
    // a fade (two passes) at level 0 stays within 1.5 px per CSS px; the slow and safe levels within 1.0
    assert.ok(dpr / groundDiv(dpr, 0, null) <= 1.5 + 1e-9, `dpr ${d}: a level-0 fade renders ${dpr / groundDiv(dpr, 0, null)} px/CSS px`);
    for (const [, pass] of STATES) assert.ok(dpr / groundDiv(dpr, 1, pass) <= 1.0 + 1e-9 && dpr / groundDiv(dpr, 2, pass) <= 1.0 + 1e-9, `dpr ${d}: slow/safe over 1 px/CSS px`);
  }
  assert.equal(groundDiv(2, 0, 'true'), 1, "the owner's retina at TRUE rest: full resolution (was ½)");
  assert.equal(groundDiv(2, 0, 'chart'), 1, 'FAR rest (the chart alone): full resolution');
  assert.equal(groundDiv(2, 0, null), 2, 'a fade on dpr 2: an exact 2× snap (1.0 px/CSS px)');
  assert.equal(fullResPass('map'), PASS.map + RESOLVE_BUDGET <= DISPLAY_BUDGET, 'MAP goes full resolution exactly when its pass + a resolve slice fits');
  assert.equal(groundDiv(2, 0, 'map'), PASS.map <= 58 ? 1 : 2, `MAP rest on dpr 2 at PASS.map ${PASS.map} (full resolution needs ≤ 58)`);
  assert.equal(groundDiv(2, 0, 'map', { ...PASS, map: 58 }), 1, "once GROUND's MAP pass is ≤ 58 fetches, MAP at rest is full resolution too");
  assert.equal(groundDiv(2, 0, 'map', { ...PASS, map: 59 }), 2, 'at 59 it is not');
  assert.equal(groundDiv(1, 0, null), 1, 'a dpr-1 screen draws the ground straight to the canvas');
  assert.equal(groundScale(2, 1.5), 0.5, 'groundScale (GROUND\'s cost tests) keeps its meaning');
});
// W1 S3 — why: the per-band scale is only safe because every band state it allows stays under the P0 budgets on the owner's
// screens: display passes + resolve slices ≤ 64 fetches per canvas px, frame ≤ 96 fetches and 256 loop iterations. A rule
// that let a fade (two passes) run at full resolution, or MAP at rest before GROUND's G2 lands, fails here.
test('per-band ground scale: every band and fade stays under the budgets at 1280×800 and 1920×1080 dpr 2 and 390×844 dpr 3', () => {
  for (const [name, cw, ch, dpr] of SCREENS3) {
    const [w, h] = canvasOf(cw, ch, dpr), rb = resolveBudget(w * h);
    for (const L of [0, 1, 2]) for (const [st, pass, drawn] of STATES) {
      const k = 1 / groundDiv(Math.min(2, dpr), L, pass), c = frameCost({ w, h, k, drawn, ...rb });
      const at = `${name} L${L} ${st} (k ${k.toFixed(2)})`;
      assert.ok(c.perPx <= DISPLAY_BUDGET, `${at}: ${c.perPx.toFixed(1)} fetches per canvas px (display + resolve) > ${DISPLAY_BUDGET}`);
      assert.ok(c.perPx <= FRAME_BUDGET && c.itersPerPx <= FRAME_ITER_BUDGET, `${at}: ${c.perPx.toFixed(1)} fetches / ${c.itersPerPx.toFixed(1)} iterations per px`);
    }
    // the owner-bar case the rule exists for: TRUE at rest is full resolution, within half the display budget
    assert.equal(groundDiv(Math.min(2, dpr), 0, 'true'), 1, `${name}: TRUE rest is full resolution`);
    assert.ok(frameCost({ w, h, k: 1, drawn: { true: true }, ...rb }).perPx <= DISPLAY_BUDGET / 2, `${name}: TRUE rest at k 1`);
    // teeth: a fade at full resolution would not fit
    assert.ok(frameCost({ w, h, k: 1, drawn: { chart: true, map: true, true: true }, ...rb }).perPx > DISPLAY_BUDGET, `${name}: a full-resolution fade fits anyway`);
  }
});
// W1 S4 — why: P0's levels were groundScale(2, 1.5) = groundScale(2, 1.0) = ½, so on the owner's retina levels 0–2 drew the
// same ground: "safe mode" cut nothing but the animation. Every level the watchdog can step to must cut real work.
test('quality levels: on every dpr ≥ 1.5 screen each step the watchdog takes cuts the modelled ground frame cost ≥ 20 %', () => {
  for (const [name, cw, ch, dpr0] of [...SCREENS3, ['laptop 1440×900 dpr 1.5', 1440, 900, 1.5]]) {
    const dpr = Math.min(2, dpr0), [w, h] = canvasOf(cw, ch, dpr0), rb = resolveBudget(w * h);
    for (const [st, pass, drawn] of STATES) {
      const cost = L => frameCost({ w, h, k: 1 / groundDiv(dpr, L, pass), drawn, ...rb }).passesPerPx;
      const eff = L => ({ k: 1 / groundDiv(dpr, L, pass), heavy: GPU_SAFE.heavy[L] });
      for (let L = 0; L < 2; L++) {
        let N = L + 1; while (N < 2 && eff(N).k === eff(L).k && eff(N).heavy === eff(L).heavy) N++; // qualityStep skips a no-op level
        assert.ok(cost(N) <= 0.8 * cost(L), `${name} ${st}: level ${L} → ${N} cuts ${(100 * (1 - cost(N) / cost(L))).toFixed(0)} % (< 20 %)`);
      }
      assert.ok(cost(2) <= 0.8 * cost(1), `${name} ${st}: safe mode must cut ground work below level 1`);
    }
  }
  assert.equal(groundDiv(2, 2, null), 3, 'safe mode on the retina: a ⅓ target');
  assert.equal(groundDiv(1, 2, null), 2, 'safe mode on a dpr-1 laptop: ½ (a quarter of the fragments)');
  assert.deepEqual([...GPU_SAFE.heavy], [true, true, false], 'safe mode also drops air, clouds and animation');
});
// P0 fix pass #3/#6 rewrote this: one ≥ 250 ms frame used to step down at once, and cold frames counted from 1 s — so the
// first draw of rm-map (a ~60k-char shader whose pipeline Metal builds at that draw) could take the owner's first zoom-in
// to level 1 and then safe mode, with nothing ever stepping back up. Now: steady samples only, two stalls to step down.
test('GPU safety: the watchdog steps down on sustained or repeated severe steady cost, never on one hiccup; up when fast', () => {
  assert.equal(watchdog([12, 14, 70, 13, 12, 15]), 'hold', 'one slow frame is not a slow GPU');
  assert.equal(watchdog([60, 12, 70, 13, 80, 15]), 'down', '3 of the last 6 frames over 50 ms: this view cannot hold 20 fps');
  assert.equal(watchdog([12, 13, GPU_SAFE.severeMs]), 'hold', 'one stall is a hiccup (a GC, a compositor hitch)');
  assert.equal(watchdog([GPU_SAFE.severeMs, 13, GPU_SAFE.severeMs + 50]), 'down', 'two stalls in a window: act');
  assert.equal(watchdog([90, 90, 90, 12, 12, 12, 12, 12, 12]), 'hold', 'only the latest window counts');
  assert.equal(watchdog([]), 'hold');
  assert.equal(watchdog([5, 6], { good: GPU_SAFE.upAfter }), 'up'); assert.equal(watchdog([5, 6], { good: GPU_SAFE.upAfter - 1 }), 'hold');
  assert.ok(GPU_SAFE.slowMs <= 50 && GPU_SAFE.severeMs <= 250 && GPU_SAFE.severeNeed <= 2, 'thresholds loosened past the P0 bar (> 50 ms → step down)');
  assert.ok(GPU_SAFE.upMs * 4 <= GPU_SAFE.slowMs, 'a step up may cost 4× the ground fragments: only a GPU that fast at the lower level steps up');
});
test('GPU safety: a frame is cold for first draws, link completions and big uploads — never for a page-table entry', () => {
  assert.equal(isColdFrame({ uploadBytes: 2 }), false, 'resolvePage\'s 2-byte page-table update: steady (it made TRUE panning invisible to the watchdog)');
  assert.equal(isColdFrame({ uploadBytes: GPU_SAFE.coldUploadBytes }), false);
  assert.equal(isColdFrame({ uploadBytes: 4 << 20 }), true, 'a 4 MB atlas layer burst is one-off work');
  assert.equal(isColdFrame({ firstDraws: 1 }), true, 'a first draw builds a pipeline'); assert.equal(isColdFrame({ links: 1 }), true);
  assert.equal(isColdFrame({ rehearsed: 1 }), true, 'W1 S6: a band-rehearsal draw builds a pipeline the band change will not: never a sample');
  assert.equal(isColdFrame({}), false);
  assert.ok(GPU_SAFE.coldUploadBytes <= 256 * 1024, 'a threshold above 256 KB hides chart16 / page streaming again');
});
test('GPU safety: quality steps ignore cold frames, skip no-op levels, never rise above the floor, and never oscillate', () => {
  const dpr1 = L => ({ k: 1 / groundDiv(1, L, null), heavy: GPU_SAFE.heavy[L] }), dpr2 = L => ({ k: 1 / groundDiv(2, L, null), heavy: GPU_SAFE.heavy[L] });
  const dpr2rest = L => ({ k: 1 / groundDiv(2, L, 'true'), heavy: GPU_SAFE.heavy[L] });
  const S = (o = {}) => ({ level: 0, floor: 0, samples: [], good: 0, wentUp: false, upLock: false, cold: 0, ...o });
  const run = (s, list, eff, cold = false) => { const acts = []; for (const ms of list) { const r = qualityStep(s, ms, cold, eff); s = r.s; if (r.act) acts.push([r.act, s.level]); } return { s, acts }; };
  // the owner's first zoom-in: rm-map's first draw costs 17 s on SwiftShader (> 1 s likely on Metal): never a step
  const c = run(S(), [17000, 36000, 5000], dpr2, true);
  assert.deepEqual(c.acts, [], 'a cold first-draw frame must never lower the quality'); assert.equal(c.s.cold, 3);
  // two steady stalls: down, and in a dpr-2 fade level 1 is the same view as level 0 (both k ½) → straight to safe mode
  const d = run(S(), [300, 20, 300], dpr2);
  assert.deepEqual(d.acts, [['down', 2]]);
  // W1 S4: at TRUE rest on dpr 2 level 0 is full resolution, so level 1 (½) is a real step
  assert.deepEqual(run(S(), [300, 20, 300], dpr2rest).acts, [['down', 1]]);
  // dpr 1: level 1 changes nothing either; the safe level halves the ground (one divisor coarser than level 1)
  assert.deepEqual(run(S(), [300, 300], dpr1).acts, [['down', 2]]);
  // up: after upAfter fast steady samples, back to the lowest level that looks the same (dpr 2: level 0)
  const fast = Array(GPU_SAFE.upAfter).fill(5), u = run(S({ level: 2 }), fast, dpr2);
  assert.deepEqual(u.acts, [['up', 0]]);
  assert.deepEqual(run(S({ level: 2 }), fast.slice(1), dpr2).acts, [], 'one sample short: hold');
  assert.deepEqual(run(S({ level: 2 }), [...fast.slice(10), 40, ...fast.slice(0, 10)], dpr2).acts, [], 'a slow sample restarts the count');
  // a lost context (or a stored crash) sets the floor: however fast the frames, the session stays in safe mode
  assert.deepEqual(run(S({ level: 2, floor: 2 }), fast, dpr2).acts, []);
  // up, then down again: ups are locked for the session (no oscillation between a view the GPU cannot hold and one it can)
  const again = run(u.s, [300, 300], dpr2); assert.deepEqual(again.acts, [['down', 2]]); assert.equal(again.s.upLock, true);
  assert.deepEqual(run(again.s, fast, dpr2).acts, [], 'locked');
});
// W1 S5 rewrote this — why: P0's crash marker was forgotten after ONE clean visit (and expired after 24 h), so a machine
// that froze inside the map froze again on the visit after next. A freeze is remembered until clean visits prove the map
// safe (back-off: more after each crash), and a view that froze even in safe mode is never re-run without the player.
test('crash memory: a freeze persists level 2 until 2 × crashes clean visits; no time expiry; a freeze in safe mode holds', () => {
  const now = 1e12, DAY = 24 * 3600 * 1000, R = gpuRecord;
  assert.deepEqual(R.start(null, now), { level: 0, reason: null, hold: false, rec: null });
  // (a clean visit drew steady frames down to TRUE: W1 fix pass 2 #6 made that evidence part of 'clean', test below)
  const CLEAN = { steadyBand: 2 };
  // visit 1 freezes the machine inside the map: pending is left behind
  let rec = R.enter(null, now); assert.ok(rec.pending);
  let st = R.start(rec, now + 7 * DAY); // a week later: still a crash (no time expiry)
  assert.equal(st.level, 2, 'the last visit never left the map: safe mode'); assert.equal(st.hold, false); assert.equal(st.rec.crashes, 1);
  rec = st.rec;
  // visit 2 (clean) and a new page: still level 2
  rec = R.leave(R.enter(rec, now), CLEAN); st = R.start(rec, now + DAY); assert.equal(st.level, 2, 'one clean visit is not enough (P0 forgot the crash here)');
  // visit 3 (clean): cleared, the crash count kept for the back-off
  rec = R.leave(R.enter(rec, now), CLEAN); assert.deepEqual(rec, { crashes: 1 }); assert.equal(R.start(rec, now).level, 0, 'two clean visits clear it');
  // a second freeze: level 2 again, now 4 clean visits
  st = R.start(R.enter(rec, now), now); assert.equal(st.rec.crashes, 2); rec = st.rec;
  for (let i = 0; i < 3; i++) { rec = R.leave(R.enter(rec, now), CLEAN); assert.equal(R.start(rec, now).level, 2, `back-off: clean visit ${i + 1} of 4`); }
  rec = R.leave(R.enter(rec, now), CLEAN); assert.equal(R.start(rec, now).level, 0);
  // a freeze while the stored level was already 2: hold (the player must choose TRY AGAIN), never an automatic re-run
  const froze2 = R.start(R.enter({ level: 2, crashes: 1, clean: 0 }, now), now); assert.equal(froze2.level, 2); assert.equal(froze2.hold, true);
  assert.equal(R.start(froze2.rec, now).hold, true, 'the hold survives a reload');
  // a lost context stores level 2 as a crash; the player's FULL DETAIL keeps the crash count (and a visit in progress)
  const lost = R.loss({ crashes: 1, pending: now }, now, 'reset'); assert.equal(lost.level, 2); assert.equal(lost.crashes, 2);
  assert.deepEqual(R.tryAgain(lost), { crashes: 2, pending: now });
  assert.deepEqual(R.tryAgain(R.at(lost, 1)), { crashes: 2, pending: now, band: 1 }, 'TRY AGAIN keeps the visit in progress and its band');
  // ?gpusafe
  assert.equal(R.start(R.enter(null, now), now, '0').level, 0, '?gpusafe=0 clears it'); assert.equal(R.start(null, now, '0').rec, null);
  assert.equal(R.start(null, now, '2').level, 2, '?gpusafe=2 forces safe mode');
  assert.equal(GPU_SAFE.lossStop, 2, 'a second lost context stops the map: never the same hang in a loop');
  assert.equal(GPU_SAFE.storeMs, undefined, 'no time expiry: a freeze yesterday is the same hazard today');
});
// W1 fix pass 2 #6 (the gate critic) — why: P0/W1 counted ANY leave as a clean visit, so after a whole-machine freeze at MAP two
// short FAR visits (which never drew the band that froze) cleared the stored level and the next MAP visit ran at level 0
// again: the device was re-exposed after 2, 4, 6 … trivial visits. A visit now counts clean only if it drew
// GPU_SAFE.crash.steady steady watchdog samples in a band at or above the (deepest) band a crash happened in.
test('crash memory: only a visit that drew steady frames where it froze counts as clean', () => {
  const now = 1e12, R = gpuRecord, visits = (rec, n, visit) => { for (let i = 0; i < n; i++) rec = R.leave(R.enter(rec, now), visit); return rec; };
  assert.ok(GPU_SAFE.crash.steady >= GPU_SAFE.window, 'a clean visit is more than one watchdog window of steady frames');
  // a freeze at MAP: the visit's band is stored beside `pending`
  let rec = R.start(R.at(R.at(R.enter(null, now), 1), 1), now).rec; assert.equal(rec.crashBand, 1); assert.equal(rec.level, 2);
  rec = visits(rec, 10, { steadyBand: 0 }); assert.equal(R.start(rec, now).level, 2, 'ten FAR-only visits prove nothing about a MAP freeze');
  rec = visits(rec, 10, { steadyBand: -1 }); rec = visits(rec, 3); assert.equal(R.start(rec, now).level, 2, 'nor do visits with no steady frames');
  assert.equal(rec.clean, 0, 'and they are not counted toward the clear'); assert.equal(rec.pending, undefined, 'but they did leave cleanly');
  rec = visits(rec, 2, { steadyBand: 1 }); assert.deepEqual(rec, { crashes: 1 }, 'two steady MAP visits clear a MAP freeze');
  // a freeze at TRUE needs TRUE visits; a later crash at a lower band keeps the deeper band
  rec = R.start(R.at(R.enter(rec, now), 2), now).rec; assert.equal(rec.crashBand, 2);
  rec = visits(rec, 8, { steadyBand: 1 }); assert.equal(R.start(rec, now).level, 2, 'MAP visits do not clear a TRUE freeze');
  rec = R.loss(R.enter(rec, now), now, 'reset', 1); assert.equal(rec.crashBand, 2, 'the deepest band that froze is kept');
  rec = R.start(rec, now).rec; assert.equal(rec.crashBand, 2);
  // a freeze during entry (FAR, before any band change) is cleared by steady FAR visits
  const far = R.start(R.enter(null, now), now).rec; assert.equal(far.crashBand, 0);
  assert.deepEqual(visits(far, 2, { steadyBand: 0 }), { crashes: 1 });
  // an older record without a band: MAP is assumed
  assert.equal(R.start({ pending: now }, now).rec.crashBand, 1);
});
// W1 S5: a loss at level 2 cannot restore at a cheaper view, so it stops the map at once (map.mjs 'lost'); pinned at source
// level because the handler needs a live context. Why: restoring at level 2 re-ran the same view — the loop P0 allowed once.
test('crash memory: a lost context while already at level 2 stops the realm map instead of restoring the same view', async () => {
  const { readFileSync } = await import('node:fs'), src = readFileSync(new URL('./map.mjs', import.meta.url), 'utf8');
  const h = src.slice(src.indexOf("core.on('lost'"), src.indexOf("core.on('restored'"));
  assert.match(h, /const wasSafe = Q\.level >= 2/, 'the handler reads the level BEFORE it sets 2');
  assert.match(h, /if \(wasSafe \|\| Q\.losses >= GPU_SAFE\.lossStop\) Q\.stopped = true/, 'a loss at level 2 stops the map');
  assert.ok(h.indexOf('wasSafe') < h.indexOf('setLevel(2'), 'wasSafe must be read before setLevel(2) changes the level');
});

// Minimap (QA GA2 #4): the minimap is this realm's own land and sea. Why: Frostveil's minimap showed a blurred block of a
// neighbour realm and the painting's frame, so the overview disagreed with the main map (whose chart turns land beyond
// ~3.5 deeds of the realm into open sea). The keep field must reach 0 there and stay 1 on and next to the realm.
test('minimap: land far from this realm reads as open sea; the painting sea colour comes from its outer ring', async () => {
  const { farDeeds, ringSea } = await import('./minimap.mjs');
  const { DEED_PX } = await import('./contracts.mjs');
  const cols = 20, rows = 10, deeds = new Uint8Array(cols * rows); // own realm: x 2..6; a neighbour realm: x 12..19
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) deeds[y * cols + x] = x >= 2 && x <= 6 ? DEED_PX.thisRealm : x >= 12 ? DEED_PX.otherRealm : DEED_PX.none;
  const D = farDeeds(deeds, cols, rows), at = (x, y) => D[y * cols + x];
  assert.equal(at(4, 5), 0, 'own deed');
  assert.equal(at(8, 5), 2, 'two deeds off the realm: kept (the coast the main map shows)');
  assert.ok(at(12, 5) >= 4, 'the neighbour realm starts beyond the 4-deed keep: sea on the minimap');
  const W = 16, H = 16, img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let i = 0; i < W * H; i++) img.data.set([30, 70, 140, 255], i * 4);
  for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) img.data.set([200, 190, 120, 255], (y * W + x) * 4); // land inside
  const s = ringSea(img); assert.ok(Math.abs(s[2] - 140 / 255) < 1e-6 && Math.abs(s[0] - 30 / 255) < 1e-6, 'the ring sea, not the land');
});

// ---- no synchronous program linking (fix iteration 2 P0, orchestrator decision) -------------------------------------
// Why: asking a WebGL program for LINK_STATUS / COMPILE_STATUS (or a uniform location, which needs the link) before its
// background link has ended makes Chrome wait for the link on the main thread: minutes for a classifier program on
// SwiftShader, and a stalled Metal GPU on the owner's Mac. So core.program() only issues the work; the status is read
// once KHR_parallel_shader_compile says the link has ended; draws under an unlinked program are skipped (never queued
// behind the link); a failed link is reported, not thrown mid-frame.
function fakeGL({ parallel = true } = {}) {
  const log = [], KHR = { COMPLETION_STATUS_KHR: 0x91b1 }, C = { NO_ERROR: 0, INVALID_INDEX: 0xffffffff };
  let id = 0;
  const impl = {
    getError: () => 0, getParameter: () => 16, getExtension: n => (n === 'KHR_parallel_shader_compile' && parallel ? KHR : null),
    createProgram: () => ({ id: ++id, done: false, linkOk: true }), createShader: () => ({ id: ++id, ok: true }),
    getProgramParameter: (p, pn) => { log.push(pn === KHR.COMPLETION_STATUS_KHR ? ['completion', p.id] : ['status', p.id, p.done]); return pn === KHR.COMPLETION_STATUS_KHR ? p.done : p.linkOk; },
    getShaderParameter: (s) => { log.push(['shaderStatus', s.id]); return s.ok; },
    getUniformLocation: (p, n) => { log.push(['uniform', p.id, p.done]); return { n }; },
    getUniformBlockIndex: (p) => { log.push(['block', p.id, p.done]); return 0; },
    getShaderInfoLog: () => 'ERROR: 0:1: boom', getProgramInfoLog: () => 'link failed',
    drawArrays: (...a) => { log.push(['draw', ...a]); }, drawArraysInstanced: (...a) => { log.push(['draw', ...a]); },
    isContextLost: () => false, getContextAttributes: () => ({ antialias: false }),
    enable: c => { log.push(['enable', c]); }, disable: c => { log.push(['disable', c]); }, scissor: (...a) => { log.push(['scissor', ...a]); },
    viewport: (...a) => { log.push(['viewport', ...a]); },
  };
  const gl = new Proxy(impl, { get(t, k) {
    if (k in t) return t[k];
    if (typeof k === 'string' && /^[A-Z][A-Z0-9_]*$/.test(k)) return C[k] ?? k.length * 131;
    return () => ({});
  } });
  const canvas = { getContext: () => gl, addEventListener() {}, clientWidth: 64, clientHeight: 64, width: 64, height: 64 };
  return { gl, canvas, log, KHR };
}
// (t.mock.timers: core's background poll timer is fake, so a failing assertion that leaves a link pending fails the
// test instead of keeping the process alive)
test('programs link in the background: no status query before the link ends, draws skipped until then', (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  let t = 0; const { canvas, log } = fakeGL();
  const core = createCore(canvas, { now: () => t });
  const p = core.program('heavy', { vs: 'void main() { gl_Position = vec4(0.0); }', fs: 'out vec4 o; void main() { o = vec4(1.0); }' });
  const early = () => log.filter(e => (e[0] === 'status' || e[0] === 'uniform' || e[0] === 'block') && e[1] === p.p.id);
  assert.equal(p.ready, false); t += 20;
  p.use(); assert.equal(p.u('uX'), null, 'no uniform location while linking'); core.gl.drawArrays(4, 0, 3);
  assert.equal(log.filter(e => e[0] === 'draw').length, 0, 'the draw under an unlinked program is skipped, not queued');
  assert.equal(core.stats().programs.skippedDraws, 1);
  assert.deepEqual(early(), [], 'LINK_STATUS / uniform / block index were never asked before COMPLETION_STATUS_KHR');
  assert.ok(log.some(e => e[0] === 'completion' && e[1] === p.p.id), 'completion is what is polled');
  assert.deepEqual(core.stats().programs.waiting, { heavy: 20, 'rm-lowres-blit': 20 });
  p.p.done = true; t += 20;
  assert.equal(p.ready, true); assert.ok(early().every(e => e[2] === true), 'status queries only after the link ended');
  // the link ended mid-frame (after this frame's use()): no draw and no uniform under a program that is not bound
  core.gl.drawArrays(4, 0, 3); assert.equal(log.filter(e => e[0] === 'draw').length, 0, 'still skipped until the next use()');
  assert.equal(p.u('uX'), null, 'no location for the unbound program');
  p.use(); core.gl.drawArrays(4, 0, 3); assert.equal(log.filter(e => e[0] === 'draw').length, 1, 'drawn once linked');
  assert.deepEqual(p.u('uX'), { n: 'uX' }, 'locations once bound');
  assert.equal(core.stats().programs.linkMs.heavy, 40);
  for (const q of [core.program('rm-lowres-blit', {})]) { q.p.done = true; t += 20; assert.equal(q.ready, true); } // drain (stops the poll timer)
});
test('a failed background link is reported (not thrown mid-frame); without the extension the status query is deferred', (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  let t = 0; const { canvas } = fakeGL(), core = createCore(canvas, { now: () => t });
  const err = console.error; console.error = () => {};
  try {
    const p = core.program('broken', { vs: 'void main() {}', fs: 'void main() {}' });
    p.p.done = true; p.p.linkOk = false; p.sh[1].ok = false; t += 20;
    assert.doesNotThrow(() => p.ready); assert.equal(p.ready, false); assert.equal(p.failed, true);
    assert.match(p.error, /broken.*fs: ERROR: 0:1: boom/); assert.deepEqual(core.stats().programs.failed, ['broken']);
    const b = core.program('rm-lowres-blit', {}); b.p.done = true; t += 20; b.ready;
  } finally { console.error = err; }
  // no extension: every status query blocks (until that link and everything issued before it has run)
  let t2 = 0; const f = fakeGL({ parallel: false }), c2 = createCore(f.canvas, { now: () => t2 });
  const blit = c2.program('rm-lowres-blit', {}), q = c2.program('noext', { vs: 'void main() {}', fs: 'void main() {}' }); q.p.done = true;
  const asked = p => f.log.filter(e => e[0] === 'status' && e[1] === p.p.id).length;
  t2 = GPU_SAFE.noParallelDeferMs - 1; assert.equal(q.ready, false); assert.equal(blit.ready, false);
  assert.equal(asked(q) + asked(blit), 0, 'no blocking status query in the first frames');
  t2 = GPU_SAFE.noParallelDeferMs + 20; assert.equal(q.ready, false, 'asked in issue order: the older blit first');
  assert.equal(asked(q), 0);
  assert.equal(blit.ready, true); t2 += 20; assert.equal(q.ready, true);
  // a burst of slow (blocking) status queries stops at the slice and resumes 16 ms later, oldest first
  let t3 = 0; const g = fakeGL({ parallel: false }), c3 = createCore(g.canvas, { now: () => t3 });
  const P = [c3.program('rm-lowres-blit', {}), ...[1, 2, 3].map(i => c3.program('slow' + i, { vs: 'void main() {}', fs: 'void main() {}' }))];
  const inner = g.gl.getProgramParameter; // each LINK_STATUS answer takes the slice (the link was still running)
  Object.defineProperty(g.gl, 'getProgramParameter', { value: (p, pn) => { const r = inner(p, pn); if (pn !== 0x91b1) t3 += GPU_SAFE.noParallelSliceMs; return r; } });
  t3 = GPU_SAFE.noParallelDeferMs + 1;
  const pass = () => P.map(p => p.ready).filter(Boolean).length;
  assert.equal(pass(), 1, 'one slow blocking query, then quiet'); assert.equal(pass(), 1, 'still quiet within 16 ms');
  t3 += 17; assert.equal(pass(), 2); t3 += 17; assert.equal(pass(), 3); t3 += 17; assert.equal(pass(), 4);
});

// Band rehearsal (P0 fix pass #1/#5). Why: a program's GPU pipeline is built at its FIRST DRAW, not at link — the first
// MAP frame blocked the main thread 17–36 s on SwiftShader, and Metal / Adreno / Mali do the same work there. The
// rehearsal draws each next-band program early, while the camera rests, so it must (a) count as that program's first
// draw (the band change then finds nothing cold), and (b) stay a 1×1 draw WHATEVER the lane does: a lane that disabled
// or moved the scissor would draw a full MAP pass at FAR — real per-pixel GPU cost, and a visible flash.
// W1 S1 rewrote this — why: P0's rehearsal drew every pipeline state into a 1×1 box at the canvas corner, which no lane's
// geometry covered: zero fragments, so the driver's per-state fragment work (SwiftShader's sampling routines; tile-based
// GPUs defer too) still landed on the band change (MAP d 400: 3.4–6.9 s with 0 new programs). Now the view centre lands
// in a small locked box, so a draw over it shades real fragments; and each call builds ONE new (program, state), so the
// rehearsal's cost is spread one pipeline per frame instead of stalling entry (S2: 2.8–8.6 s entry tasks).
test('band rehearsal v2: the view centre lands in a locked box, one new (program, state) per call, keyed by GL state', (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  let t = 0; const { canvas, log } = fakeGL(), core = createCore(canvas, { now: () => t }), gl = core.gl, B = GPU_SAFE.rehearse.box;
  const blit = core.program('rm-lowres-blit', {}), p = core.program('rm-map', { vs: 'void main() {}', fs: 'void main() {}' });
  blit.p.done = p.p.done = true; t += 20; assert.equal(blit.ready, true); assert.equal(p.ready, true);
  assert.deepEqual(core.stats().programs.cold.sort(), ['rm-lowres-blit', 'rm-map'], 'linked, never drawn: cold');
  core.drawTag = 'far'; log.length = 0;
  // the lane draws its two real states (opaque, then blended) and tries to move / lift the scissor
  const lane = () => { gl.disable(gl.SCISSOR_TEST); gl.scissor(0, 0, 4096, 4096); p.use(); gl.disable(gl.BLEND); gl.drawArrays(4, 0, 3);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.drawArrays(4, 0, 3); };
  const r1 = core.rehearse(lane, { target: 'canvas', ground: true });
  assert.deepEqual(r1, { drew: true, complete: false, fresh: 1 }, 'the first state is built, the second deferred to the next frame');
  const draws = log.filter(e => e[0] === 'draw').length; assert.equal(draws, 1, 'only one new pipeline per frame reaches the driver');
  assert.deepEqual(log.filter(e => e[0] === 'scissor'), [['scissor', 0, 0, B, B]], 'the lane could not move the box');
  const vp = log.filter(e => e[0] === 'viewport')[0];
  assert.ok(vp, 'core sets the viewport'); const [, vx, vy, vw, vh] = vp;
  assert.ok(vx + vw / 2 >= 0 && vx + vw / 2 <= B && vy + vh / 2 >= 0 && vy + vh / 2 <= B, `the view centre (${vx + vw / 2}, ${vy + vh / 2}) lies in the ${B}×${B} box`);
  assert.equal(vw, canvas.width, 'the real target\'s size: a draw keeps its real screen-space footprint');
  assert.ok(log.findIndex(e => e[0] === 'disable' && e[1] === gl.SCISSOR_TEST) > log.findIndex(e => e[0] === 'draw'), 'the lane could not lift the scissor; core lifts it after');
  assert.equal(core.stats().programs.firstDrawn['rm-map'], 'rehearsal@far');
  const r2 = core.rehearse(lane, { target: 'canvas', ground: true });
  assert.deepEqual(r2, { drew: true, complete: true, fresh: 1 }, 'next frame: the blended state; nothing left');
  assert.deepEqual(core.rehearse(lane, { target: 'canvas', ground: true }), { drew: true, complete: true, fresh: 0 }, 'idempotent: nothing new');
  // a band change that draws those two states finds them built: no first draw, no state miss
  const f0 = core.stats().programs.firstStates; core.drawTag = 'map'; p.use(); gl.disable(gl.BLEND); gl.drawArrays(4, 0, 3); gl.enable(gl.BLEND); gl.drawArrays(4, 0, 3);
  assert.equal(core.stats().programs.firstStates, f0, 'the band change draws warm (program, state)s only');
  // a state the rehearsal never built (additive blend) is a first draw AND a reported miss
  gl.blendFunc(gl.ONE, gl.ONE); gl.drawArrays(4, 0, 3);
  assert.equal(core.stats().programs.firstStates, f0 + 1, 'a new blend func is a new pipeline');
  assert.deepEqual(core.stats().programs.stateMisses, ['rm-map@map'], 'reported: the hook misses a state its real pass uses');
  // the target is part of the key: the same program into a colour-format FBO is a new pipeline
  const tx = core.tex.data(4, 4, 'RGBA8', null, null, null); core.fbo(tx); gl.drawArrays(4, 0, 3); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  assert.equal(core.stats().programs.firstStates, f0 + 2, 'another target format is another pipeline');
  log.length = 0; gl.scissor(1, 2, 3, 4); gl.disable(gl.SCISSOR_TEST);
  assert.deepEqual(log, [['scissor', 1, 2, 3, 4], ['disable', gl.SCISSOR_TEST]], 'outside a rehearsal the lanes\' own scissor calls pass through');
  assert.equal(core.rehearse(() => {}).drew, false, 'a lane that drew nothing: not rehearsed');
  assert.throws(() => core.rehearse(() => { throw Error('lane bug'); }));
  log.length = 0; gl.disable(gl.SCISSOR_TEST); assert.equal(log.length, 1, 'a throwing lane leaves no rehearsal behind (the scissor lock is released)');
});
// W1 S6 — why: the owner's first zoom-in is full of one-off work (rehearsal draws, first (program, state) draws, big
// uploads). If any of it became a watchdog sample, two ≥ 250 ms frames would drop the first visit into safe mode.
test('watchdog: rehearsal and cold frames never step the quality down; the same frames steady would', (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] });
  let t = 0; const { canvas } = fakeGL(), core = createCore(canvas, { now: () => t }), gl = core.gl;
  const p = core.program('life-scatter', { vs: 'void main() {}', fs: 'void main() {}' }); p.p.done = true; t += 20; assert.equal(p.ready, true);
  // through the real scheduler: each frame's GPU sample reaches 'gpu' listeners with core's cold flag (gpuEnd)
  const seen = [], rafs = []; core.on('gpu', (ms, m, at, cold) => seen.push(cold));
  const raf0 = globalThis.requestAnimationFrame, caf0 = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = f => { rafs.push(f); return rafs.length; }; globalThis.cancelAnimationFrame = () => {};
  try {
    const bodies = [() => core.rehearse(() => { p.use(); gl.drawArrays(4, 0, 3); }), () => { p.use(); gl.drawArrays(4, 0, 3); }, // rehearsed, then the frame after
      () => { p.use(); gl.enable(gl.BLEND); gl.drawArrays(4, 0, 3); }, () => { p.use(); gl.drawArrays(4, 0, 3); }, // first blended draw, then the frame after
      () => { p.use(); gl.drawArrays(4, 0, 3); }, () => { p.use(); gl.drawArrays(4, 0, 3); }, // steady
      () => core.rehearse(() => { p.use(); gl.drawArrays(4, 0, 3); }), // a rehearsal of an already built state: cold by the rehearsal alone
      () => { p.use(); gl.drawArrays(4, 0, 3); }, () => { p.use(); gl.drawArrays(4, 0, 3); }];
    let i = 0; core.run(() => { bodies[i](); return false; });
    for (i = 0; i < bodies.length; i++) { t += 16; rafs.shift()?.(t); core.invalidate(); }
    i = bodies.length - 1; t += 16; rafs.shift()?.(t); // polls the last frame's fence
  } finally { core.stop(); globalThis.requestAnimationFrame = raf0; globalThis.cancelAnimationFrame = caf0; }
  assert.deepEqual(seen.slice(0, 9), [true, true, true, true, false, false, true, true, false], 'rehearsal and first-state frames (and each frame after): cold; steady otherwise');
  let s = { level: 0, floor: 0, samples: [], good: 0, wentUp: false, upLock: false, cold: 0 };
  const eff = L => ({ k: 1 / groundDiv(2, L, 'true'), heavy: GPU_SAFE.heavy[L] });
  for (const ms of [4000, 9000, 2600, 700]) { const r = qualityStep(s, ms, true, eff); assert.equal(r.act, null, 'a cold frame is never a step'); s = r.s; }
  assert.equal(s.cold, 4); assert.equal(s.level, 0);
  const steady = [300, 20, 300].reduce((acc, ms) => { const r = qualityStep(acc.s, ms, false, eff); return { s: r.s, acts: [...acc.acts, r.act].filter(Boolean) }; }, { s, acts: [] });
  assert.deepEqual(steady.acts, ['down'], 'teeth: the same stalls on steady frames do step down');
});

// W1 S2 — why: P0 stopped retrying a falsy hook after 4 tries (1.5 + 3 + 4.5 + 6 s); in the product BASES' art took longer,
// so its three programs first-drew on the band change (10.7 + 6.6 s long tasks on SwiftShader). Retries never run out.
test('band rehearsal: a hook that cannot draw yet is retried with a capped back-off, never given up on', () => {
  const R = GPU_SAFE.rehearse;
  assert.equal(retryAt(1, 0), R.retryMs); assert.equal(retryAt(2, 0), 2 * R.retryMs);
  for (const n of [4, 5, 50, 1e6]) { const t = retryAt(n, 1000); assert.ok(Number.isFinite(t) && t - 1000 <= R.retryMaxMs, `try ${n}: next at +${t - 1000} ms`); }
  assert.equal(R.maxTries, undefined, 'no try count in the contract');
});
// Why: the rehearsal waits while programs link, but a FAILED link disables its lane for the session. Waiting on it kept
// every other lane cold (SwiftShader, 2026-09-24: GROUND's working-tree rm-map failed to compile and all six LIFE
// programs first-drew on the FAR→MAP change instead of at FAR).
test('band rehearsal: held while any program links, never by a failed (disabled) lane', () => {
  const P = state => ({ state }), lanes = (...st) => st.map(g => new Set(g.map(P)));
  assert.equal(rehearsalHeld(lanes(['ready', 'ready'], ['ready'])), false);
  assert.equal(rehearsalHeld(lanes(['ready', 'pending'], ['ready'])), true, 'a background link in any lane holds it');
  assert.equal(rehearsalHeld(lanes(['ready', 'failed'], ['ready'])), false, 'a failed link does not');
  assert.equal(rehearsalHeld([]), false);
});

// Why: only core.mjs may talk to a WebGL program object. A lane calling gl.getUniformLocation / getProgramParameter /
// useProgram … on prog.p would wait for the background link on the main thread (the stall this P0 removes) or draw
// with an unlinked program. Lanes go through prog.use() / prog.u() / prog.tex() / prog.ready.
test('no realm module outside core.mjs queries or binds a WebGL program directly', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const RAW = /\.(getUniformLocation|getProgramParameter|getAttribLocation|getShaderParameter|getUniformBlockIndex|getActiveUniform|getProgramInfoLog|getShaderInfoLog|getFragDataLocation|useProgram|linkProgram|compileShader|createProgram|uniformBlockBinding|bindAttribLocation)\s*\(/g;
  assert.equal([...'gl.getUniformLocation(p.p, "x"); gl.useProgram(null);'.matchAll(RAW)].length, 2, 'the scan sees a raw call');
  const dir = new URL('./', import.meta.url), bad = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs') && !/\.(test|cases|fixture|support)\.mjs$/.test(f) && f !== 'core.mjs')) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => { for (const m of line.replace(/\/\/.*$/, '').matchAll(RAW)) bad.push(`${f}:${i + 1} ${m[1]}`); });
  }
  assert.deepEqual(bad, [], 'raw program calls outside core.mjs');
});

// Why (P0 fix pass #1): a program the band rehearsal never sees keeps its first draw — its pipeline build — on the band
// change. SwiftShader showed SHELL's own minimap (hidden at FAR) doing exactly that at FAR→MAP once LIFE's programs were
// rehearsed. So every module that creates programs must be in map.mjs REHEARSE_LANES (core.mjs's blit and map.mjs's stub
// ground draw from the first FAR frame), and the minimap has its hook; the lanes' hooks are theirs (stats().rehearsal
// .noHook names a lane without one, and the P0 gate's firstDrawsDelta 0 fails it).
test('band rehearsal reaches every module that creates programs; the minimap rehearses both of its programs', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('./', import.meta.url), src = f => readFileSync(new URL(f, dir), 'utf8');
  const lanes = JSON.parse(src('map.mjs').match(/const REHEARSE_LANES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const makers = readdirSync(dir).filter(f => f.endsWith('.mjs') && !/\.(test|cases|fixture|support)\.mjs$/.test(f) && !['core.mjs', 'map.mjs'].includes(f) && /\bprogram\(\s*'/.test(src(f))).map(f => f.slice(0, -4)).sort();
  assert.ok(makers.includes('minimap') && makers.includes('ground'), 'the scan sees program-creating modules');
  assert.deepEqual(makers.filter(m => !lanes.includes(m)), [], 'modules whose programs the band rehearsal never draws');
  const mini = src('minimap.mjs'), hook = mini.slice(mini.indexOf('    rehearse(prog)'), mini.indexOf('\n    },', mini.indexOf('    rehearse(prog)')));
  assert.ok(hook.length > 0, 'the minimap has a rehearse hook');
  for (const p of ['pChart', 'pDots']) assert.match(hook, new RegExp(`${p}\\.use\\(\\)`), `the minimap hook draws ${p}`);
  assert.match(hook, /drawArraysInstanced\([^)]*,\s*1\)/, 'the dots rehearse ONE instance');
});

// Why (W1 integrate, GROUND's requests): the rehearsal builds programs in GPU_SAFE.rehearse.order within a band set; one
// missing from `order` silently drops to the END of its set (GROUND's W1 rm-pure bake, which the FAR pre-resolve runs,
// would be built after the minimap). And SHELL treats GROUND's rehearse / mapReady / passes as optional (the stub ground
// has none), so a real GROUND that loses one would degrade quietly — GROUND_API lists them, so map.mjs reports it
// (stats().modules.groundApi). A new program or a renamed hook fails here, not as a first-draw stall on a band change.
test('every lane program has an explicit rehearsal order; GROUND_API names every hook SHELL calls on GROUND', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { GROUND_API } = await import('./contracts.mjs'), { createGround } = await import('./ground.mjs');
  const dir = new URL('./', import.meta.url), R = GPU_SAFE.rehearse;
  const names = readdirSync(dir).filter(f => f.endsWith('.mjs') && !/\.(test|cases|fixture|support)\.mjs$/.test(f) && f !== 'map.mjs')
    .flatMap(f => [...readFileSync(new URL(f, dir), 'utf8').matchAll(/\bprogram\(\s*'([a-z0-9-]+)'/g)].map(m => m[1]));
  assert.ok(names.includes('rm-pure') && names.includes('bases-sprite') && names.includes('rm-lowres-blit'), 'the scan sees every lane');
  assert.deepEqual(names.filter(n => !n.endsWith('-wmask') && !R.order.includes(n)), [], 'programs with no place in GPU_SAFE.rehearse.order');
  assert.deepEqual(R.trueSet.filter(n => !R.order.includes(n)), [], 'the TRUE set is ordered too');
  assert.ok(R.order.indexOf('rm-pure') === R.order.indexOf('rm-legalise') + 1, 'rm-pure right after rm-legalise (GROUND W1)');
  const g = createGround({ gl: {}, include() {} });
  for (const k of ['rehearse', 'mapReady', 'passes']) assert.ok(GROUND_API.includes(k), `GROUND_API lists ${k}`);
  assert.deepEqual(GROUND_API.filter(k => !(k in g)), [], 'GROUND_API members the real GROUND lacks');
  assert.equal(typeof g.passes, 'function'); assert.equal(typeof g.mapReady, 'function'); assert.equal(typeof g.rehearse, 'function');
});

// Why (W1 fix pass 2 #4, the gate critic): a TRUE-set program is rehearsed only for the TRUE gate (d 800), and the MAP gate
// (d 24) opens once the MAP set is built. A TRUE-set program that a lane can draw below d 800 is therefore first-drawn
// mid-MAP with no rehearsal, by any zoom or by a flight the gate held and then resumed (selection flies to d 700, 'my base'
// to d 1400). rm-record (GROUND's TRUE-page resolve, from d 600) and life-creature (LIFE's MAP herds, from d 348–495 by
// pack) were such programs. Rule: a program's gate edge must be at or below the lowest d its lane can draw it.
test('rehearsal sets: no program is gated above the lowest d its lane can draw it', async () => {
  const { readFileSync } = await import('node:fs'), { BANDS } = await import('./contracts.mjs'), R = GPU_SAFE.rehearse;
  const gateEdge = n => (R.trueSet.includes(n) ? BANDS.trueStart : BANDS.farEnd); // map.mjs bandGate: set 2 at trueStart, else farEnd
  // the lowest d each lane can draw a program; every other one draws from the MAP start or at FAR (the MAP gate bounds it)
  const lowestD = {
    'rm-true': BANDS.trueStart, 'rm-true-wmask': BANDS.trueStart, // GROUND: the TRUE pass only where w.true > 0
    'rm-record': BANDS.pageResolve, // GROUND pageWork → resolvePage from d ≥ BANDS.pageResolve
    'life-creature': BANDS.herds, // LIFE: herds from dOn = max(BANDS.herds, minVisibleD(maxInkH)) ≥ BANDS.herds
  };
  const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.match(src('./ground.mjs'), /view\.d < BANDS\.pageResolve\) return 0/, 'GROUND still resolves TRUE pages from pageResolve (else update lowestD)');
  assert.match(src('./scatter.mjs'), /Math\.max\(BANDS\.herds, minVisibleD/, 'LIFE still draws herds from BANDS.herds (else update lowestD)');
  for (const n of R.order) {
    const lo = lowestD[n] ?? BANDS.farEnd;
    assert.ok(gateEdge(n) <= Math.max(lo, BANDS.farEnd), `${n} is gated at d ${gateEdge(n)} but its lane draws it from d ${lo}`);
  }
  assert.ok(R.trueSet.length && R.trueSet.every(n => (lowestD[n] ?? 0) >= BANDS.trueStart), 'the TRUE set holds only TRUE-band programs');
});

// ---- shader budget (fix iteration 2 P0) ------------------------------------------------------------------------------
// Why: LIFE measured a scatter program that had not linked after 240 s on SwiftShader, because GROUND's §3.2 classifier
// was inlined into it several times. The decision: display programs only SAMPLE baked classes; the classifier runs in
// GROUND's bake (resolve) passes, at most once per program. This pins every program the engine can create — as the
// driver receives it (preprocessGLSL) — to that rule and to a size cap, so a regression fails here, not on a GPU.
// Nothing is hand-listed: the programs, their shader sources and the #include registry are read from the engine's own
// modules (every core.program('name', { vs, fs, defines }) and core.include('name', SRC) call, the identifiers resolved
// through that file's imports of glsl/*.glsl.js or its own template consts), so a lane that adds an include or a program
// is budgeted automatically, and a call this reader cannot parse fails loudly instead of escaping the budget.
function glslFunctions(src) { // name → bodies, after #ifdef/#ifndef/#else/#endif and comments
  const defd = new Set(), keep = [], on = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*#\s*(ifdef|ifndef|else|endif|define|undef|if|elif)\b\s*(\w+)?/), live = on.every(Boolean);
    if (!m) { if (live) keep.push(line); continue; }
    if (m[1] === 'ifdef') on.push(defd.has(m[2])); else if (m[1] === 'ifndef') on.push(!defd.has(m[2]));
    else if (m[1] === 'else') on.push(!on.pop()); else if (m[1] === 'endif') on.pop();
    else if (m[1] === 'if' || m[1] === 'elif') throw Error('the budget test reads #ifdef/#ifndef only: ' + line);
    else if (live && m[1] === 'define') defd.add(m[2]); else if (live && m[1] === 'undef') defd.delete(m[2]);
  }
  const s = keep.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''), fns = new Map(), re = /\b(\w+)\s+(\w+)\s*\(([^()]*)\)\s*\{/y;
  for (let i = 0, depth = 0; i < s.length;) {
    if (depth === 0) { re.lastIndex = i; const m = re.exec(s); if (m && !['if', 'for', 'while', 'switch', 'return', 'else'].includes(m[2])) {
      let j = re.lastIndex, d = 1; while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
      if (!fns.has(m[2])) fns.set(m[2], []); fns.get(m[2]).push(s.slice(re.lastIndex, j - 1)); i = j; continue; } }
    if (s[i] === '{') depth++; else if (s[i] === '}') depth--; i++;
  }
  return fns;
}
/** What main() costs once every reachable call is inlined: copies of `target` and the inlined size (chars, spaces folded). */
function inlineCost(src, target) {
  const fns = glslFunctions(src), memo = new Map();
  const walk = f => { if (memo.has(f)) return memo.get(f); memo.set(f, { n: 0, chars: 0 }); let best = { n: 0, chars: 0 };
    for (const body of fns.get(f)) { const r = { n: f === target ? 1 : 0, chars: body.replace(/\s+/g, ' ').length };
      if (f !== target) for (const m of body.matchAll(/\b(\w+)\s*\(/g)) if (fns.has(m[1]) && m[1] !== f) { const c = walk(m[1]); r.n += c.n; r.chars += c.chars; }
      if (r.n > best.n || (r.n === best.n && r.chars > best.chars)) best = r; }
    memo.set(f, best); return best; };
  return fns.has('main') ? walk('main') : { n: 0, chars: 0 };
}

// The engine's GLSL as its modules hand it to core: every glsl/*.glsl.js string export, every inline GLSL template const
// in a realm module, the #include registry and every program. Read from the sources, never from a hand list.
const IS_GLSL = /\b(?:void|float|u?int|bool|[iu]?vec[234]|mat[234])\s+\w+\s*\([^)]*\)\s*\{/; // a GLSL function definition
let engineGLSLMemo = null;
async function engineGLSL() {
  if (engineGLSLMemo) return engineGLSLMemo;
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('./', import.meta.url), gdir = new URL('./glsl/', import.meta.url);
  const modules = new Map(); // 'x.glsl.js' → its exports
  for (const f of readdirSync(gdir).filter(f => f.endsWith('.glsl.mjs')).sort()) modules.set(f, await import(new URL(f, gdir).href));
  const strings = []; // { where, src } — every GLSL string of the engine
  for (const [f, m] of modules) for (const [k, v] of Object.entries(m)) if (typeof v === 'string') strings.push({ where: `glsl/${f} ${k}`, src: v });
  const includes = new Map(), fallbacks = new Map(), programs = new Map(), problems = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs') && !/\.(test|cases|fixture|support)\.mjs$/.test(f)).sort()) {
    const text = readFileSync(new URL(f, dir), 'utf8'), ids = new Map();
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/glsl\/([\w.-]+\.glsl\.mjs)'/g)) {
      for (const part of m[1].split(',').map(s => s.trim()).filter(Boolean)) { const [a, b = a] = part.split(/\s+as\s+/); ids.set(b.trim(), { mod: m[2], name: a.trim() }); }
    }
    for (const m of text.matchAll(/const\s+(\w+)\s*=\s*`([^`]*)`/g)) {
      if (!IS_GLSL.test(m[2])) continue;
      if (m[2].includes('${')) { problems.push(`${f} ${m[1]}: inline GLSL with a \${} interpolation (move it to glsl/*.glsl.js)`); continue; }
      ids.set(m[1], { local: m[2] }); strings.push({ where: `${f} ${m[1]}`, src: m[2] });
    }
    const val = id => { const r = ids.get(id); if (!r) return null; if (r.local !== undefined) return r.local; const v = modules.get(r.mod)?.[r.name]; return typeof v === 'string' ? v : null; };
    const seed = text.match(/const includes = new Map\(\[([^;]*)\]\)/); // core.mjs's built-in includes ("common")
    if (seed) for (const m of seed[1].matchAll(/\[\s*'([\w.-]+)'\s*,\s*(\w+)\s*\]/g)) { const v = val(m[2]); if (v == null) problems.push(`${f}: include ${m[1]} = ${m[2]} unresolved`); else includes.set(m[1], v); }
    for (const m of text.matchAll(/\binclude\(\s*'([\w.-]+)'\s*,\s*(\w+)\s*\)/g)) {
      const v = val(m[2]); if (v == null) { problems.push(`${f}: include('${m[1]}', ${m[2]}) unresolved`); continue; }
      // map.mjs registers stand-ins (CLASSES_STUB) only when a lane module is missing: the lane's own source wins
      (f === 'map.mjs' ? fallbacks : includes).set(m[1], v);
    }
    const calls = [...text.matchAll(/\bprogram\(\s*'/g)].length; let parsed = 0;
    for (const m of text.matchAll(/\bprogram\(\s*'([\w-]+)'\s*,\s*\{\s*vs:\s*(\w+)\s*,\s*fs:\s*(\w+)\s*(?:,\s*defines:\s*(\{[^{}]*\}|\w+)\s*)?\}\s*\)/g)) {
      parsed++;
      const vs = val(m[2]), fs = val(m[3]);
      if (vs == null || fs == null) { problems.push(`${f}: program('${m[1]}') sources ${m[2]}/${m[3]} unresolved`); continue; }
      // a defines identifier (ground.mjs rd / gd) holds ?gdbg debug switches: empty in production
      const defines = {}; if (m[4]?.startsWith('{')) for (const d of m[4].matchAll(/(\w+)\s*:\s*(true|-?\d+(?:\.\d+)?)/g)) defines[d[1]] = d[2] === 'true' ? true : d[2];
      const bake = ids.get(m[3])?.mod === 'resolve.glsl.mjs'; // GROUND's bake (resolve) passes live in glsl/resolve.glsl.mjs
      const key = m[1] + '|' + JSON.stringify(defines);
      if (programs.has(key)) problems.push(`${f}: program ${key} defined twice`); else programs.set(key, { name: m[1], file: f, vs, fs, defines, bake });
    }
    if (parsed !== calls) problems.push(`${f}: ${calls - parsed} program() call(s) this reader cannot parse — use program('name', { vs: ID, fs: ID[, defines] })`);
  }
  for (const [k, v] of fallbacks) if (!includes.has(k)) includes.set(k, v);
  return (engineGLSLMemo = { modules, strings, includes, programs, problems });
}

test('shader budget: display programs never inline the classifier; bake passes at most once; every stage under the caps', async () => {
  const { includes, programs, problems } = await engineGLSL();
  assert.deepEqual(problems, [], 'the engine sources the budget reads');
  // the reader found the engine (a regex that silently matched nothing would pass everything below)
  for (const n of ['rm-raw', 'rm-map', 'rm-true', 'life-scatter', 'bases-sprite', 'minimap', 'stub-ground', 'rm-lowres-blit'])
    assert.ok([...programs.values()].some(p => p.name === n), `program ${n} found`);
  for (const n of ['common', 'classes', 'rm-classify', 'life']) assert.ok(includes.has(n), `include ${n} registered`);
  const cap = GPU_SAFE.shader, over = [];
  for (const { name, vs, fs, defines, bake } of programs.values()) {
    for (const [k, src] of [['VS', vs], ['FS', fs]]) {
      let g; try { g = preprocessGLSL(src, { kind: k, defines, includes, name }); } catch (e) { over.push(`${name} ${k}: ${e.message}`); continue; }
      const c = inlineCost(g, 'rmClassCore'), allowed = bake ? cap.classifierBake : cap.classifierDisplay;
      if (c.n > allowed) over.push(`${name} ${k}: ${c.n} classifier copies (allowed ${allowed}${bake ? ', bake pass' : ', display program'})`);
      // integrate: a display program must not even carry the classifier's text (an unused #include "rm-classify" still
      // costs the driver's front end a parse of ~all of §3.2 at every link, and is one call away from a copy)
      if (!bake && glslFunctions(g).has('rmClassCore')) over.push(`${name} ${k}: carries the classifier (#include "rm-classify") — display programs sample baked classes`);
      if (g.length > cap.stageChars) over.push(`${name} ${k}: ${g.length} chars > ${cap.stageChars}`);
      if (c.chars > cap.inlinedChars) over.push(`${name} ${k}: ${c.chars} inlined chars > ${cap.inlinedChars}`);
    }
  }
  assert.deepEqual(over, [], 'shader budget');
  // teeth: the counter sees through wrappers (a display program calling the classifier twice through a helper = 2
  // copies), and the raw resolve really runs it (a renamed classifier would make every count above a vacuous 0)
  const probe = preprocessGLSL(`#include "common"\n#include "rm-fields"\n#include "rm-classify"
uint cls(ivec2 v) { float c, w, t, p, b; bool r; return rmClassCore(v, c, w, r, t, p, b); }
out vec4 o; void main() { o = vec4(float(cls(ivec2(1)) + cls(ivec2(2)))); }`, { kind: 'FS', includes, name: 'probe' });
  assert.equal(inlineCost(probe, 'rmClassCore').n, 2, 'two classifier reads through a wrapper = two inlined copies');
  const idle = preprocessGLSL(`#include "common"\n#include "rm-fields"\n#include "rm-classify"\nout vec4 o; void main() { o = vec4(0.0); }`, { kind: 'FS', includes, name: 'idle' });
  assert.ok(inlineCost(idle, 'rmClassCore').n === 0 && glslFunctions(idle).has('rmClassCore'), 'an unused rm-classify include is still seen as carried');
  const raw = [...programs.values()].find(p => p.name === 'rm-raw');
  assert.equal(inlineCost(preprocessGLSL(raw.fs, { kind: 'FS', includes, name: 'rm-raw' }), 'rmClassCore').n, 1, 'the raw resolve runs the classifier exactly once');
  assert.ok(raw.bake, 'rm-raw is classified as a bake pass');
});

// ---- every shader loop has a constant bound (P0 RM-GPU-1, all lanes) ------------------------------------------------
// Why: the owner's Mac GPU hung on per-pixel loops whose trip count came from data (deed segment lists, an overflowed
// uint while-loop). A loop whose bound is a literal (or a #define of one) ≤ 64, with a plain increment and a loop
// variable the body never writes, can never run away on garbage input. LIFE's and BASES' own loop tests stay; this one
// covers every GLSL string of the engine (glsl/*.glsl.js exports + inline shaders in any realm module), so a new
// data-driven loop fails here whichever lane writes it. `if (k >= n) break;` inside a constant loop is the allowed way
// to run fewer iterations.
const LOOP_MAX = 64;
function loopViolations(src, defs) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''), out = [];
  if (/\bwhile\b/.test(s)) out.push('while loop');
  if (/\bdo\s*\{/.test(s)) out.push('do loop');
  const heads = [...s.matchAll(/\bfor\s*\(([^;()]*);([^;()]*);([^;()]*)\)/g)], all = [...s.matchAll(/\bfor\s*\(/g)].length;
  if (heads.length !== all) out.push(`${all - heads.length} loop header(s) with a call or nested parentheses`);
  for (const h of heads) {
    const text = h[0].replace(/\s+/g, ' '), v = h[1].match(/^\s*(?:int|uint)\s+(\w+)\s*=/)?.[1];
    if (!v) { out.push(`${text}: no int loop variable`); continue; }
    const c = h[2].match(new RegExp(`^\\s*${v}\\s*(<=?)\\s*(\\w+)\\s*$`));
    const bound = !c ? NaN : /^\d+u?$/.test(c[2]) ? parseInt(c[2], 10) : defs.has(c[2]) ? defs.get(c[2]) : NaN;
    if (!c || !Number.isFinite(bound)) out.push(`${text}: bound is not a literal or #define constant`);
    else if (bound > LOOP_MAX) out.push(`${text}: bound ${bound} > ${LOOP_MAX}`);
    if (!new RegExp(`^\\s*(?:${v}\\s*\\+\\+|\\+\\+\\s*${v}|${v}\\s*\\+=\\s*[1-9]\\d*u?)\\s*$`).test(h[3])) out.push(`${text}: step is not ${v}++ / ${v} += literal`);
    // the body: a { } block, or one statement (nested for / if headers included) up to its ';' or closing '}'
    let i = h.index + h[0].length, p = 0; while (/\s/.test(s[i])) i++;
    const start = i;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') p++; else if (ch === ')') p--;
      else if (ch === '{' && p === 0) { let d = 1; i++; while (i < s.length && d) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; } break; }
      else if (ch === ';' && p === 0) { i++; break; }
    }
    const body = s.slice(start, i);
    if (new RegExp(`\\b${v}\\s*(?:[-+*/%]?=(?!=)|\\+\\+|--)|(?:\\+\\+|--)\\s*${v}\\b`).test(body)) out.push(`${text}: the body writes ${v}`);
  }
  return out;
}
test('every shader loop in every lane has a literal (or #define) bound ≤ 64; no while / do loops', async () => {
  const { strings, problems } = await engineGLSL();
  assert.deepEqual(problems, [], 'the engine sources the loop test reads');
  assert.ok(strings.length >= 40, `the engine's GLSL strings were found (${strings.length})`);
  for (const w of ['glsl/mapground.glsl.mjs MAP_FS', 'glsl/sprites.glsl.mjs LIFE', 'glsl/classes.glsl.mjs RM_CLASSIFY', 'map.mjs STUB_FS', 'core.mjs BLIT_FS'])
    assert.ok(strings.some(s => s.where === w), `${w} is scanned`);
  const defs = new Map(); // every #define NAME <int> of the engine (a bound may come from an include)
  for (const { src } of strings) for (const m of src.matchAll(/^[ \t]*#define[ \t]+(\w+)[ \t]+(\d+)u?[ \t]*$/gm)) defs.set(m[1], Math.max(defs.get(m[1]) ?? 0, +m[2]));
  const bad = strings.flatMap(({ where, src }) => loopViolations(src, defs).map(v => `${where}: ${v}`));
  assert.deepEqual(bad, [], 'unbounded or data-driven shader loops');
  // teeth: the checker rejects exactly the loop shapes that hung the GPU, and accepts the sanctioned bounded form
  const D = new Map([['MAX_SEGS', 8], ['BIG', 128]]);
  const t = body => loopViolations(`void main() { ${body} }`, D);
  assert.deepEqual(t('for (int k = 0; k < MAX_SEGS; k++) { if (k >= n) break; x += seg(k); }'), []);
  assert.deepEqual(t('for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) s += at(i, j);'), []);
  assert.equal(t('for (int k = 0; k < n; k++) x += seg(k);').length, 1, 'data-driven bound');
  assert.equal(t('for (int k = 0; k < min(n, 8); k++) x++;').length, 1, 'a call in the header');
  assert.equal(t('for (int k = 0; k < BIG; k++) x++;').length, 1, 'bound over 64');
  assert.equal(t('for (int k = 0; k < 8; k++) { k += 2; }').length, 1, 'body writes the loop variable');
  assert.equal(t('for (int k = 0; k < 8; k += n) x++;').length, 1, 'data-driven step');
  assert.equal(t('uint r = 0u; while (r * r < n) r++;').length, 1, 'while loop');
  assert.equal(t('do { r++; } while (r < 4);').length, 2, 'do-while');
});

// Stage B (RM-GPU-1 first-visit attribution): core.qaTouch() is the wrapper-free way QA makes a software rasteriser's
// texture memory resident before a band change. It must read EVERY texel of every tracked texture (a missed layer or mip
// level leaves pages cold and the A/B reads as "touch does not help"), pick a readable format per kind, and leave the
// framebuffer binding as it found it (the next frame draws into it).
test('qaTouch reads every texel of every layer and level, with a readable type, and restores the framebuffer', (tc) => {
  tc.mock.timers.enable({ apis: ['setTimeout'] }); // (core's timers must not keep the test process alive)
  const { gl, canvas } = fakeGL(), reads = [], attach = [];
  let bound = 'prev';
  const impl = { readPixels: (x, y, w, h, fmt, type) => reads.push({ x, y, w, h, fmt, type, at: attach.at(-1) }),
    framebufferTextureLayer: (t, a, tex, level, layer) => attach.push(`${tex.id}:L${level}:z${layer}`),
    framebufferTexture2D: (t, a, tt, tex, level) => attach.push(`${tex.id}:L${level}:z0`),
    checkFramebufferStatus: () => 'complete', bindFramebuffer: (t, f) => { bound = f; },
    getParameter: p => (p === 'FRAMEBUFFER_BINDING' ? 'prev' : 16), createTexture: (() => { let n = 0; return () => ({ id: ++n }); })() };
  const g2 = new Proxy(impl, { get(t, k) { if (k in t) return t[k]; if (k === 'FRAMEBUFFER_COMPLETE') return 'complete'; if (k === 'FRAMEBUFFER_BINDING') return 'FRAMEBUFFER_BINDING'; return gl[k]; } });
  const core = createCore({ ...canvas, getContext: () => g2 }, { now: () => 0 });
  const arr = core.tex.array(300, 20, 3, 'RGBA16UI', { levels: 2 }), img = core.tex.data(8, 4, 'R8', null, null, new Uint8Array(32));
  const out = core.qaTouch();
  const texels = k => reads.filter(r => r.at?.startsWith(k)).reduce((a, r) => a + r.w * r.h, 0);
  assert.equal(texels(`${arr.t.id}:L0:`), 300 * 20 * 3, 'array level 0, all layers'); assert.equal(texels(`${arr.t.id}:L1:`), 150 * 10 * 3, 'array level 1');
  assert.equal(texels(`${img.t.id}:L0:`), 32, 'the 2D texture');
  assert.ok(reads.filter(r => r.at?.startsWith(`${arr.t.id}:`)).every(r => r.fmt === g2.RGBA_INTEGER && r.type === g2.UNSIGNED_INT), 'integer textures read as RGBA_INTEGER / UNSIGNED_INT');
  assert.ok(reads.every(r => r.w * r.h <= 65536 || r.h === 1), 'strips of ≤ 64k texels');
  assert.equal(bound, 'prev', 'the framebuffer binding is restored');
  assert.deepEqual(out.map(o => [o.format, o.layers, o.levels, o.bad]), [['RGBA16UI', 3, 2, 0], ['R8', 1, 1, 0]]);
});

// ---- stage B D2: the level-0 frame-rate governor for MAP rest ------------------------------------------------------------
// Why: W1 made MAP full resolution at rest (the owner-bar fix for the k ½ softness), 3.0–3.3× the fade frame's ground work,
// and the watchdog steps down only below ~20 fps (slowMs 50). Between 20 and 60 fps nothing traded it back: a phone that
// could hold 60 fps at ½ sat at 25–40 fps at full resolution. The governor drops MAP rest to n0 when the median steady GPU
// frame stays over GPU_SAFE.gov.ms for ~1 s, returns only after a long fast run, and never oscillates.
test('governor: MAP rest drops to n0 on a sustained median over 20 ms, never on one slow frame, returns once, then locks', () => {
  const G = GPU_SAFE.gov, run = (g, ms, n, { t0 = 0, dt = 16.7, rest = true } = {}) => {
    const acts = []; let t = t0;
    for (let i = 0; i < n; i++) { t += dt; const r = govStep(g, typeof ms === 'function' ? ms(i) : ms, t, rest); g = r.g; if (r.act) acts.push([r.act, i]); }
    return { g, acts, t };
  };
  const s0 = { on: false, samples: [], good: 0, wentUp: false, lock: false, acts: 0 };
  // fast frames: nothing
  assert.deepEqual(run(s0, 12, 200).acts, []);
  // one 400 ms hitch among fast frames: the median holds (the watchdog's severe rule is for hitches, not this)
  assert.deepEqual(run(s0, i => (i === 30 ? 400 : 12), 200).acts, []);
  // 18 ms (55 fps): under the threshold, nothing
  assert.deepEqual(run(s0, 18, 200).acts, []);
  // 30 ms (33 fps) sustained: on after ~1 s of samples (the window must span 0.8 × windowMs), not on the first frames
  const a = run(s0, 30, 200); assert.equal(a.acts.length, 1); assert.equal(a.acts[0][0], 'on');
  assert.ok(a.acts[0][1] * 16.7 >= G.windowMs * 0.8 - 17 && a.acts[0][1] * 16.7 <= G.windowMs + 17, `on after ${(a.acts[0][1] * 16.7).toFixed(0)} ms`);
  // a frame that is not MAP rest at level 0 (a fade, TRUE, level ≥ 1) is not the governor's evidence: ignored
  assert.deepEqual(run(s0, 30, 200, { rest: false }).acts, []);
  // on: it returns after upAfter consecutive fast samples (≤ upMs), and a slow one restarts the count
  const on = a.g; assert.equal(on.on, true);
  assert.deepEqual(run(on, 5, G.upAfter - 1).acts, [], 'not before upAfter');
  assert.deepEqual(run(on, i => (i === G.upAfter - 2 ? 9 : 5), G.upAfter).acts, [], 'a slow sample restarts the count');
  const back = run(on, 5, G.upAfter, { t0: a.t }); assert.deepEqual(back.acts.map(x => x[0]), ['off']); assert.equal(back.g.wentUp, true);
  // no oscillation: a drop after a return locks n0 for the session (qualityStep's rule)
  const again = run(back.g, 30, 200, { t0: back.t }); assert.deepEqual(again.acts.map(x => x[0]), ['on']); assert.equal(again.g.lock, true);
  assert.deepEqual(run(again.g, 3, 5 * G.upAfter, { t0: again.t }).acts, [], 'locked: never returns');
  // the switch it drives: MAP rest at level 0 renders at n0 (½ on dpr 2) only while on; nothing else changes
  assert.equal(groundDiv(2, 0, governedPass('map', 0, false)), 1, 'full resolution at MAP rest when off');
  assert.equal(groundDiv(2, 0, governedPass('map', 0, true)), 2, 'n0 (½) when on');
  for (const [pass, L] of [['true', 0], ['chart', 0], [null, 0], ['map', 1], ['map', 2]]) assert.equal(governedPass(pass, L, true), pass, `${pass} at level ${L} is not the governor's`);
});
// Stage B D2 ceiling: the frame SHELL SUSTAINS at MAP rest once the governor has stepped in, in millions of texel fetches per
// frame (and loop iterations), per device class. The engine caps dpr at 2. PROVISIONAL (device-unverified; Gate B replaces
// them with stats().quality.coldGpu and steady frame reads): each ceiling is the cost of the FAR→MAP fade frame at that
// class (chart + MAP at n0), the frame every dive already draws; the governed rest frame must never cost more. Teeth: the
// ungoverned full-resolution rest frame is ~3× over every ceiling, so a governor that stops cutting fails here.
const GOV_CEIL_M = { 'phone 390×844 dpr 3→2': [390, 844, 3, 28, 55], 'laptop 1280×800 dpr 2': [1280, 800, 2, 80, 155], 'desktop 1920×1080 dpr 2': [1920, 1080, 2, 140, 255] };
test('governor ceiling: the MAP rest frame SHELL sustains stays under an absolute per-device-class ceiling (M fetches / M iterations per frame)', async () => {
  const { DESPECKLE_PASSES } = await import('./classify.mjs');
  for (const [name, [cw, ch, dpr0, ceilF, ceilI]] of Object.entries(GOV_CEIL_M)) {
    const dpr = Math.min(2, dpr0), w = Math.round(cw * dpr), h = Math.round(ch * dpr), b = resolveBudget(w * h, { despecklePasses: DESPECKLE_PASSES });
    const cost = gov => frameCost({ w, h, k: 1 / groundDiv(dpr, 0, governedPass('map', 0, gov)), drawn: { map: true }, subs: b.subs, pages: b.pages, despecklePasses: DESPECKLE_PASSES });
    const g = cost(true), full = cost(false), fade = frameCost({ w, h, k: 1 / groundDiv(dpr, 0, null), drawn: { chart: true, map: true }, subs: b.subs, pages: b.pages, despecklePasses: DESPECKLE_PASSES });
    assert.ok(g.fetches / 1e6 <= ceilF, `${name}: governed MAP rest ${(g.fetches / 1e6).toFixed(1)} M fetches > ${ceilF} M`);
    assert.ok(g.iters / 1e6 <= ceilI, `${name}: governed MAP rest ${(g.iters / 1e6).toFixed(1)} M iterations > ${ceilI} M`);
    assert.ok(g.fetches <= fade.fetches, `${name}: the governed rest frame costs more than the fade frame`);
    assert.ok(full.fetches / 1e6 > 2.5 * ceilF, `${name}: full-resolution rest (${(full.fetches / 1e6).toFixed(0)} M) is not what the governor cuts`);
  }
});

// ---- D-177 (owner 2026-09-26, "overview first, live"; withdraws D-173's dive hold) -------------------------------------------
// Why: the D-173 dive held the painted chart until every lane had loaded and the MAP set was rehearsed, then zoomed to MAP by
// itself; the owner saw a 5 s wait and an auto zoom he did not ask for. The landing now waits for nothing it does not draw:
// a lane still loading never closes the zoom (its items gate only once loaded), and only a loaded band set holds a zoom-in at
// its gate edge (the "detail N%" cue). A hold that came back (a 'loading' reason, or any hold with no gating item) fails here.
test('bandLimit (D-177): no dive hold; only a loaded, unrehearsed band set gates, at its edge; a valve, a QA bypass or ?rehearse=0 open it', () => {
  const items = s => [{ set: 1, gating: s.map }, { set: 2, gating: s.true }];
  for (const legacy of [{}, { dive: true, lanesIn: false }]) { // (D-173's dive arguments must not hold anything any more)
    assert.equal(bandLimit({ ...legacy, items: [] }).lim, Infinity, 'lanes still loading, nothing gating: the zoom is open');
    assert.notEqual(bandLimit({ ...legacy, items: [] }).reason, 'loading', 'no loading hold');
    assert.equal(bandLimit({ ...legacy, items: items({ map: false, true: false }) }).lim, Infinity, 'items not gating yet (their lane still loads): open');
  }
  assert.equal(bandLimit({ items: items({ map: true, true: false }) }).lim, BANDS.farEnd, 'MAP set left: a zoom-in holds at the FAR edge');
  assert.equal(bandLimit({ items: items({ map: true, true: false }) }).reason, 'rehearsal');
  assert.equal(bandLimit({ items: items({ map: false, true: true }) }).lim, BANDS.trueStart, 'TRUE set left: MAP open');
  assert.equal(bandLimit({ items: items({ map: false, true: false }) }).lim, Infinity);
  assert.equal(bandLimit({ valve: true, items: items({ map: true, true: true }) }).lim, Infinity, 'the stall valve opens it');
  assert.equal(bandLimit({ bypass: true, items: items({ map: true, true: true }) }).lim, Infinity, 'a QA set() bypasses it');
  assert.equal(bandLimit({ on: false, items: items({ map: true, true: true }) }).lim, Infinity, '?rehearse=0: no gate');
});
