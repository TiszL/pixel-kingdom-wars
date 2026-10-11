// camera.test — why it matters: the realm map cross-fades between two crisp layers at three zoom
// bands. In motion that reads as a transition; at rest it reads as ghosting (plan §2.1, review M2).
// These tests pin that no resting camera — after a gesture, inertia, a wheel burst or a flight —
// ever sits inside a cross-fade, on a phone (dpr 2) or a desktop (dpr 1), and that the true-scale
// view rests pixel-exact (whole device px per art px, on the device-pixel grid).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bands, bandOf, restTarget, inRest, snapD, createCamera } from './camera.mjs';
import { BANDS, SELECT_D, MY_BASE_D, DEED_ART } from './contracts.mjs';

const PHONE = { W: 390, H: 844, dpr: 2 }, DESK = { W: 1280, H: 800, dpr: 1 };
function rig(vp = DESK, grid = [178, 131]) {
  let t = 0; const cam = createCamera({ now: () => t });
  cam.setViewport(vp.W, vp.H, vp.dpr); cam.setGrid(...grid); cam.set(grid[0] / 2, grid[1] / 2, 100);
  const run = (ms, dt = 16) => { const end = t + ms; while (t < end) { t += dt; cam.step(t); } };
  return { cam, run, get t() { return t; }, set t(v) { t = v; } };
}
const inside = d => BANDS.rest.some(([a, b]) => d > a + 1e-9 && d < b - 1e-9);

test('bands(d) switches band exactly at the §2.1 thresholds', () => {
  const cases = [[23.99, 'far'], [24, 'far-map'], [47.99, 'far-map'], [48, 'map'], [799.9, 'map'], [800, 'map-true'], [1099.9, 'map-true'], [1100, 'true'], [5000, 'true']];
  for (const [d, band] of cases) assert.equal(bands(d).band, band, `d=${d}`);
  assert.equal(bandOf(10), 'far');
});

test('layer weights: FAR fully on below 24, MAP fully on 48..800, TRUE fully on from 1100', () => {
  assert.deepEqual([bands(10).w.far, bands(10).w.map, bands(10).w.true], [1, 0, 0]);
  assert.deepEqual([bands(300).w.far, bands(300).w.map, bands(300).w.true], [0, 1, 0]);
  assert.deepEqual([bands(1100).w.far, bands(1100).w.map, bands(1100).w.true], [0, 0, 1]);
  const mid = bands(36).w; assert.ok(mid.far > 0 && mid.far < 1 && Math.abs(mid.far + mid.map - 1) < 1e-12, 'FAR→MAP is a cross-fade summing to 1');
  assert.equal(bands(199).w.decor, 0); assert.equal(bands(280).w.decor, 1); // impostor fade d 200→280
  assert.equal(bands(1099).w.creatures, 0); assert.equal(bands(1100).w.creatures, 1);
  assert.equal(bands(1999).w.sway, 0); assert.equal(bands(2000).w.sway, 1);
});

test('fadeWeight is exactly 0 or 1 at every band edge and outside the fades', () => {
  for (const d of [1, 10, 24, 48, 100, 199.99, 200, 280, 500, 800, 1100, 3136, 6272]) {
    const w = bands(d).fadeWeight; assert.ok(w === 0 || w === 1, `d=${d} fadeWeight=${w}`);
  }
  assert.ok(bands(36).fadeWeight > 0 && bands(36).fadeWeight < 1);
});

test('every rest target lies outside BANDS.rest (log sweep 1..20000, with and without bounds)', () => {
  for (let i = 0; i <= 4000; i++) {
    const d = Math.exp(Math.log(1) + (Math.log(20000) - Math.log(1)) * i / 4000);
    assert.ok(!inside(restTarget(d)), `restTarget(${d}) = ${restTarget(d)} is inside a fade`);
    assert.ok(!inside(restTarget(d, 30, 12544)), `bounded restTarget(${d}) inside a fade`);
  }
  for (const t of [SELECT_D, MY_BASE_D]) assert.ok(!inRest(t), `fly target ${t} sits in a fade`);
});

test('restTarget picks the nearer edge in log d (zoom steps), and the reachable one when bounded', () => {
  assert.equal(restTarget(36), 48); // ln(36/24)=0.41 > ln(48/36)=0.29
  assert.equal(restTarget(30), 24);
  assert.equal(restTarget(900), 800);
  assert.equal(restTarget(1000), 1100);
  assert.equal(restTarget(230), 200);
  assert.equal(restTarget(270), 280);
  assert.equal(restTarget(30, 26), 48, 'nearer edge 24 is below the fit floor, so 48');
  assert.equal(restTarget(500), 500);
});

for (const [name, vp] of [['phone', PHONE], ['desktop', DESK]]) {
  test(`${name}: a gesture ending at d 900 or d 36 eases to the nearer band edge within 250 ms`, () => {
    for (const [d0, want] of [[900, 800], [36, 48], [1000, 1100], [230, 200]]) {
      const r = rig(vp); r.cam.set(80, 60, d0 / vp.dpr);
      r.cam.beginGesture(); r.cam.endGesture({ fx: vp.W / 2, fy: vp.H / 2 });
      const t0 = r.t; r.run(BANDS.restEaseMs, 5);
      assert.ok(Math.abs(r.cam.d - want) < 1e-9, `${d0} → ${r.cam.d}, want ${want}`);
      assert.ok(!r.cam.moving, 'settled'); assert.ok(r.t - t0 <= BANDS.restEaseMs + 5);
      const w = bands(r.cam.d).fadeWeight; assert.ok(w === 0 || w === 1, `fadeWeight ${w} at rest`);
    }
  });

  test(`${name}: the rest ease keeps the gesture focus point fixed`, () => {
    const r = rig(vp); r.cam.set(80, 60, 900 / vp.dpr); const fx = vp.W * 0.3, fy = vp.H * 0.7;
    const before = r.cam.screenToDeed(fx, fy); r.cam.beginGesture(); r.cam.endGesture({ fx, fy }); r.run(300, 5);
    const after = r.cam.screenToDeed(fx, fy);
    assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1]) < 1e-9);
  });

  test(`${name}: resting after random pinches never leaves fadeWeight between 0 and 1`, () => {
    const r = rig(vp); let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 300; i++) {
      r.cam.beginGesture(); r.cam.zoomAt(rnd() * vp.W, rnd() * vp.H, Math.exp((rnd() - 0.5) * 3)); r.cam.panBy((rnd() - 0.5) * 200, (rnd() - 0.5) * 200);
      r.cam.endGesture({ vx: (rnd() - 0.5) * 2, vy: (rnd() - 0.5) * 2 }); r.run(4000, 16);
      assert.ok(!r.cam.moving, 'settles');
      const w = bands(r.cam.d).fadeWeight; assert.ok(w === 0 || w === 1, `rest at d=${r.cam.d} fadeWeight=${w}`);
    }
  });

  test(`${name}: a wheel burst settles 160 ms after the last step, then eases out of a fade`, () => {
    const r = rig(vp); r.cam.set(80, 60, 700 / vp.dpr);
    r.cam.wheel(vp.W / 2, vp.H / 2, 900 / 700); // lands at d 900
    r.run(100, 5); assert.ok(Math.abs(r.cam.d - 900) < 1e-6, 'no settle during the burst');
    r.run(500, 5); assert.equal(r.cam.d, 800);
  });
}

test('fly targets in d land in the same band on phone and desktop', () => {
  for (const d of [SELECT_D, MY_BASE_D, 36, 950]) {
    const bandsSeen = [PHONE, DESK].map(vp => { const r = rig(vp); r.cam.flyToD(50, 40, d, 600); r.run(700); assert.ok(!r.cam.moving); return [r.cam.d, bands(r.cam.d).band]; });
    assert.equal(bandsSeen[0][0], bandsSeen[1][0], `d ${d}: phone ${bandsSeen[0][0]} vs desktop ${bandsSeen[1][0]}`);
    assert.equal(bandsSeen[0][1], bandsSeen[1][1]);
  }
  const r = rig(PHONE); r.cam.flyToD(50, 40, SELECT_D, 600); r.run(700); assert.equal(bands(r.cam.d).band, 'map');
  const q = rig(DESK); q.cam.flyToD(50, 40, MY_BASE_D, 600); q.run(700); assert.equal(bands(q.cam.d).band, 'true');
  const e = rig(DESK); e.cam.flyToD(50, 40, 850, 600); e.run(700); assert.equal(e.cam.d, 800, 'a fly target inside a fade is moved to the nearer edge');
});

test('public flyTo(x, y, s) is converted to d (the same s means a different d per device, same band rule)', () => {
  const r = rig(PHONE); r.cam.flyTo(50, 40, 18, 400); r.run(500); assert.equal(r.cam.d, 48); // 18 CSS × dpr 2 = d 36, inside FAR→MAP → 48
});

for (const [name, vp] of [['phone', PHONE], ['desktop', DESK]]) {
  test(`${name}: pixel snap at d ≥ 3136 — whole device px per art px, on the device-pixel grid`, () => {
    for (const d0 of [3300, 5000, 7000, 9000]) {
      const r = rig(vp); const dMax = BANDS.sMax * vp.dpr; r.cam.set(80.123456, 60.654321, Math.min(d0, dMax) / vp.dpr);
      r.cam.beginGesture(); r.cam.endGesture({ fx: 100, fy: 200 }); r.run(300, 5);
      const m = r.cam.d / DEED_ART; assert.ok(Math.abs(m - Math.round(m)) < 1e-9, `d ${r.cam.d} not a whole multiple of ${DEED_ART}`);
      assert.ok(r.cam.d <= dMax + 1e-9);
      const gx = r.cam.x * r.cam.d - vp.W * vp.dpr / 2, gy = r.cam.y * r.cam.d - vp.H * vp.dpr / 2;
      assert.ok(Math.abs(gx - Math.round(gx)) < 1e-6 && Math.abs(gy - Math.round(gy)) < 1e-6, `camera off the device grid (${gx}, ${gy})`);
    }
    assert.equal(snapD(3000), 3000, 'below the snap threshold nothing snaps');
  });
}

test('pinch keeps the deed under the fingers fixed; pan moves by screen px / s', () => {
  const r = rig(DESK); const [u, v] = r.cam.screenToDeed(300, 200);
  r.cam.zoomAt(300, 200, 3.7); const [u2, v2] = r.cam.screenToDeed(300, 200);
  assert.ok(Math.abs(u - u2) < 1e-9 && Math.abs(v - v2) < 1e-9);
  const x0 = r.cam.x; r.cam.panBy(100, 0); assert.ok(Math.abs(r.cam.x - (x0 - 100 / r.cam.s)) < 1e-9);
});

test('inertia: a fling keeps moving, decays and stops, then the rest rule runs', () => {
  const r = rig(DESK); r.cam.set(80, 60, 36); // d 36: inside FAR→MAP
  r.cam.beginGesture(); r.cam.endGesture({ vx: 1.5, vy: 0 });
  const x0 = r.cam.x; r.run(50); assert.ok(r.cam.x < x0, 'fling pans (content follows the finger to the right)');
  assert.ok(Math.abs(r.cam.d - 36) < 1e-9, 'no settle while the fling is alive');
  r.run(3000); assert.ok(!r.cam.moving); assert.equal(r.cam.d, 48);
});

test('double-tap zoom ×2.4 about the tap point, then rest rule', () => {
  const r = rig(DESK); r.cam.set(80, 60, 100); const [u, v] = r.cam.screenToDeed(500, 300);
  r.cam.zoomAround(500, 300, 2.4, 320); r.run(400); assert.equal(r.cam.d, 280); // 240 is inside the impostor fade → 280
  const [u2, v2] = r.cam.screenToDeed(500, 300); assert.ok(Math.hypot(u2 - u, v2 - v) < 1e-9);
});

test('the fit floor: a resting camera never stays below the whole-realm fit', () => {
  const r = rig(PHONE); r.cam.set(80, 60, r.cam.sMin() * 0.75); r.cam.beginGesture(); r.cam.endGesture(); r.run(400);
  assert.ok(r.cam.s >= r.cam.sMin() - 1e-9);
});

// W1 S2 band readiness — why: a band change used to build its GPU pipelines at the first frame that drew them (MAP d 150
// blocked 14.6–18.7 s on SwiftShader). map.mjs now holds the zoom at a band's gate edge until its pipelines are rehearsed.
// The camera side must stop zooming in exactly there (pinch, wheel, double tap, flights), never pull a camera back,
// never block zooming out, rest outside every cross-fade, and resume a held flight when the gate opens — unless the
// player moved in the meantime. A gate that never opens would lock the zoom; one that leaks would stall the frame.
test('band gate: zoom-in stops at the limit (pinch, wheel, double tap, fly); zoom-out is free; a held flight resumes', () => {
  for (const vp of [DESK, PHONE]) {
    const r = rig(vp), { cam } = r, lim = BANDS.farEnd;
    cam.set(cam.cols / 2, cam.rows / 2, 12 / vp.dpr); cam.limitD(lim);
    cam.zoomAt(vp.W / 2, vp.H / 2, 8); assert.ok(Math.abs(cam.d - lim) < 1e-6, `pinch stops at d ${lim} (got ${cam.d})`); assert.ok(cam.pressing, 'pressing against the gate');
    cam.zoomAt(vp.W / 2, vp.H / 2, 0.5); assert.ok(cam.d < lim, 'zoom-out is never limited');
    cam.wheel(vp.W / 2, vp.H / 2, 20); r.run(600); assert.ok(cam.d <= lim + 1e-6 && !inside(cam.d), `a wheel burst rests at or below the edge (d ${cam.d})`);
    cam.zoomAround(vp.W / 2, vp.H / 2, 2.4, 300); r.run(500); assert.ok(cam.d <= lim + 1e-6, 'a double tap stops at the edge');
    // "Go to my base" from FAR while the gate is closed: land at the edge, then resume when it opens
    cam.set(cam.cols / 2, cam.rows / 2, 12 / vp.dpr); cam.flyToD(10, 10, MY_BASE_D, 700); r.run(900);
    assert.ok(Math.abs(cam.d - lim) < 1e-6 && cam.pressing, 'the flight waits at the gate edge'); r.t += 1000;
    assert.ok(cam.pressing, 'a held flight keeps the cue on while it waits');
    cam.limitD(Infinity); r.run(700); assert.ok(Math.abs(cam.d - MY_BASE_D) < 1e-6, `resumed to its target (d ${cam.d})`); assert.ok(!cam.pressing);
    // a gesture in the meantime cancels the resume
    cam.limitD(lim); cam.set(cam.cols / 2, cam.rows / 2, 12 / vp.dpr); cam.flyToD(10, 10, SELECT_D, 500); r.run(700);
    cam.beginGesture(); cam.panBy(5, 5); cam.endGesture(); r.run(400); cam.limitD(Infinity); r.run(700);
    assert.ok(cam.d <= lim + 1e-6, 'the player moved: no surprise flight afterwards');
    // a camera already past a lowered limit stays where it is (a lane that loaded late never yanks the view)
    cam.set(cam.cols / 2, cam.rows / 2, 300 / vp.dpr); cam.limitD(lim); cam.beginGesture(); cam.panBy(3, 0); cam.endGesture(); r.run(600);
    assert.ok(Math.abs(cam.d - 300) < 1e-6, `never pulled back (d ${cam.d})`);
    cam.zoomAt(vp.W / 2, vp.H / 2, 2); assert.ok(Math.abs(cam.d - 300) < 1e-6, 'but it cannot zoom further in either');
    cam.limitD(Infinity);
  }
});

// W1 S2 — why: the gate must clamp the camera BEFORE it moves in a frame (a limit applied after cam.step lets one frame of a
// pinch or flight cross the edge: the band change's first draw — the stall the gate exists to prevent — happens anyway),
// and a lane held for unbuilt pipelines must neither update nor draw. Pinned at source level (map.mjs needs a live context).
test('band gate: map.mjs limits the camera before it steps, and a held lane neither updates nor draws', async () => {
  const { readFileSync } = await import('node:fs'), src = readFileSync(new URL('./map.mjs', import.meta.url), 'utf8');
  const f = src.slice(src.indexOf('  function frame(t) {'), src.indexOf('  // ---- entry / exit'));
  assert.ok(f.indexOf('bandGate(') > 0 && f.indexOf('bandGate(') < f.indexOf('cam.step(t)'), 'bandGate runs before cam.step in frame()');
  for (const n of ['ground', 'life', 'bases']) assert.match(f, new RegExp(`linking\\('${n}'\\) \\|\\| laneHeld\\('${n}', bs\\)`), `${n}: held like a linking lane`);
  assert.ok(f.indexOf('rehearse(view, moving, t)') < f.indexOf('gl.clear('), 'the rehearsal runs before the frame\'s clear (its box is never seen)');
});

// W1 integrate — why: frame() lists the gate's items BEFORE the rehearsal step, so the step that completes the last item
// leaves the gate closed for that frame; an idle map (0 fps) then kept it closed — stats().gate.open false, the pill's
// 'detail 97%' — until the next input (SwiftShader smoke at 778b0661: TRUE gate lim 800 with an empty queue for 20 s).
// The completing step must wake one more frame while a gate is closed. Pinned at source level (map.mjs needs a live context).
test('band gate: the rehearsal step that completes the last item wakes one more frame to reopen a closed gate', async () => {
  const { readFileSync } = await import('node:fs'), src = readFileSync(new URL('./map.mjs', import.meta.url), 'utf8');
  const f = src.slice(src.indexOf('  function rehearse(view, moving, t) {'), src.indexOf('  // ---- frame ---'));
  assert.ok(f.length > 100, 'rehearse() found');
  assert.match(f, /\|\| \(r\?\.complete && drew && rh\.gate\.lim < Infinity\)\) wakeIn\(RH\.gapMs\)/, 'a completing step wakes a frame while the gate is closed');
});

// ---- D-177 (owner 2026-09-26, "overview first, live"; withdraws D-173's MAP zoom floor and landing) ------------------------
// Why: under D-173 nothing rested below the MAP start and zoom-out "goes to globe too early from map" (a pinch below d 33.6
// left). The lowest rest is the whole-realm fit again (the pre-D-173 rule): FAR views rest where they are aimed, a pinch-out
// that ends above 0.7 × the fit stays in the realm and rests on it, only a pinch below 0.7 × the fit is the exit (bindGestures'
// exitCheck reads sMin), and only the raw leave flight goes below the fit, into the painted chart.
test('D-177 no MAP floor: the lowest rest is the whole-realm fit; FAR rests where aimed; the exit is below 0.7 × the fit', () => {
  for (const vp of [PHONE, DESK]) {
    const r = rig(vp), { cam } = r, fitD = cam.sFit() * vp.dpr, exits = () => cam.s < cam.sMin() * 0.7;
    assert.equal(cam.sMin(), cam.sFit(), 'sMin is the whole-realm fit'); assert.ok(fitD < BANDS.farEnd, `${vp.W}: the fit (d ${fitD.toFixed(1)}) is a FAR view`);
    assert.equal(cam.setFloorD, undefined, 'no zoom floor to set');
    // a flight aimed into FAR (the revisit D-173 raised to d 48) rests where it is aimed
    cam.flyToD(cam.x, cam.y, 21, 300); r.run(400); assert.ok(Math.abs(cam.d - 21) < 1e-6, `${vp.W}: a FAR flight rests at d 21 (d ${cam.d})`);
    // from MAP, a pinch out to d 30 (D-173 left for the globe below 33.6) stays in the realm and rests in FAR (d 24)
    cam.set(cam.x, cam.y, 150 / vp.dpr); cam.beginGesture(); cam.zoomAt(vp.W / 2, vp.H / 2, 30 / 150);
    assert.ok(!exits(), `${vp.W}: a pinch to d 30 is not the exit`); cam.endGesture(); r.run(400);
    assert.ok(Math.abs(cam.d - BANDS.farEnd) < 1e-6, `${vp.W}: it rests at the FAR edge, not at MAP (d ${cam.d})`);
    // a pinch out that ends between 0.7 × fit and the fit is not the exit either: it rests on the whole realm
    cam.beginGesture(); cam.zoomAt(vp.W / 2, vp.H / 2, fitD * 0.8 / cam.d); assert.ok(!exits(), 'a pinch to 0.8 × the fit is not the exit');
    cam.endGesture(); r.run(400); assert.ok(Math.abs(cam.d - fitD) < 1e-6, `${vp.W}: rests on the whole realm (d ${cam.d}, fit ${fitD})`);
    // a wheel burst or a flight aimed below the fit rests on it
    cam.flyToD(cam.x, cam.y, 1, 300); r.run(400); assert.ok(Math.abs(cam.d - fitD) < 1e-6, 'a flight aimed below the fit rests on it');
    // a deep pinch below 0.7 × the fit reads as the exit gesture (undershooting at most to 0.6 × the fit)
    cam.beginGesture(); cam.zoomAt(vp.W / 2, vp.H / 2, 0.05); assert.ok(exits(), 'a pinch below 0.7 × the fit is the exit');
    assert.ok(cam.d >= fitD * 0.6 - 1e-9, 'a gesture undershoots at most to 0.6 × the fit'); cam.endGesture(); r.run(400);
    // the raw leave flight (map.mjs exit) is the only way below the fit: into the painted chart before the globe fades in
    cam.flyToD(cam.x, cam.y, fitD * 0.5, 300, { raw: true }); r.run(400); assert.ok(Math.abs(cam.d - fitD * 0.5) < 1e-6, `the leave flight goes below the fit (d ${cam.d})`);
    assert.equal(bands(cam.d).w.map, 0, 'it ends in the painted chart');
  }
});
// D-177: Enter map lands at the globe's own scale in the painted chart (photo 1, "very good") and STAYS there until the player
// zooms: the owner's photo 2 was the D-173 dive zooming to MAP by itself. Frame loop as map.mjs runs it (gate → limitD → step)
// with the lanes loading and the MAP and TRUE sets rehearsing behind the landing: the camera never moves, never shows a MAP
// weight, and the scale pill's cue stays off (not pressing). Then the + button (map.mjs zoomBy: a flight to d × 2.2) waits at
// the FAR edge while the MAP set is still rehearsing (the "detail N%" cue) and reaches MAP by itself once it is ready.
test('D-177 landing: the camera stays at the landing scale while the lanes load; a zoom-in waits at the gate, then reaches MAP', async () => {
  const { bandLimit } = await import('./core.mjs');
  for (const [vp, sStart] of [[PHONE, 21.6], [DESK, 10.8], [DESK, 30]]) {
    let t = 0; const cam = createCamera({ now: () => t }); cam.setViewport(vp.W, vp.H, vp.dpr); cam.setGrid(178, 131);
    const d0 = Math.max(Math.min(sStart * vp.dpr, BANDS.farEnd), cam.sMin() * vp.dpr); cam.set(89, 65, d0 / vp.dpr); // map.mjs enterInner
    const p0 = [cam.d, cam.x, cam.y], at = { loaded: 1500, mapDone: 6000, trueDone: 9000 };
    assert.ok(Math.abs(p0[0] - d0) < 1e-9 && bandOf(d0) !== 'map', `${vp.W} sStart ${sStart}: lands in the chart at d ${d0}`);
    const gate = () => cam.limitD(bandLimit({ items: [{ set: 1, gating: t >= at.loaded && t < at.mapDone }, { set: 2, gating: t >= at.loaded && t < at.trueDone }] }).lim);
    for (; t < 10000; t += 16) {
      gate(); cam.step(t);
      assert.ok(cam.d === p0[0] && cam.x === p0[1] && cam.y === p0[2] && !cam.moving, `${vp.W} sStart ${sStart}: the camera moved by itself at ${t} ms (d ${cam.d})`);
      assert.equal(bands(cam.d).w.map, 0, 'no MAP weight at the landing'); assert.ok(!cam.pressing, 'no gate cue while the player does not zoom');
    }
    // the player zooms in (a flight to MAP d 150) while the MAP set is rehearsing again (a lane reloaded): the flight holds
    // at the FAR edge with the cue, then resumes to MAP by itself when the gate opens
    at.mapDone = 13000; gate(); const t0 = t; cam.flyToD(cam.x, cam.y, 150, 700); // (the gate closed a frame before the tap)
    for (; t < t0 + 900; t += 16) { gate(); cam.step(t); }
    assert.ok(Math.abs(cam.d - BANDS.farEnd) < 1e-6 && cam.pressing, `${vp.W}: waits at the FAR edge with the cue (d ${cam.d})`);
    for (; t < 14000; t += 16) { gate(); cam.step(t); }
    assert.ok(bands(cam.d).w.map > 0 && bandOf(cam.d) === 'map' && !cam.moving, `${vp.W}: reached MAP once the gate opened (d ${cam.d})`);
  }
});
// D-177, source pin (map.mjs needs a live context): enterInner places the camera once (cam.set at the landing d) and starts no
// flight, hold or floor; the frame loop has no dive step; no zoom floor is left anywhere in map.mjs.
test('D-177 landing: map.mjs enterInner places the camera once and schedules no flight, hold or floor (source pin)', async () => {
  const { readFileSync } = await import('node:fs'), src = readFileSync(new URL('./map.mjs', import.meta.url), 'utf8');
  const e = src.slice(src.indexOf('  async function enterInner('), src.indexOf('  const api = {'));
  assert.ok(e.length > 200, 'enterInner found'); assert.match(e, /cam\.set\(x, y, d0 \/ core\.dpr\);/, 'the landing is one placement');
  for (const bad of ['flyToD(', 'flyTo(', 'startDive', 'limitD(', 'settle(']) assert.ok(!e.includes(bad), `enterInner must not call ${bad}`);
  const f = src.slice(src.indexOf('  function frame(t) {'), src.indexOf('  // ---- entry / exit'));
  assert.ok(f.length > 200 && !/diveStep|dive\./.test(f), 'the frame loop has no dive step');
  assert.ok(!/floorD|setFloorD/.test(src), 'no zoom floor in map.mjs');
  assert.match(src, /function zoomBy\(k\) \{ if \(k < 1 && cam\.d <= cam\.sMin\(\) \* cam\.dpr \* 1\.01\) \{ exit\(\); return; \}/, 'the − button leaves only at the whole-realm view');
});

// Stage B fix pass: map.mjs keeps ONE pending wake and it must be the earliest asked for. A longer wake (the map-data hold's
// mapReadyHoldMs, an idle retry) asked in the same frame as the rehearsal's 32 ms gap must not win: a first-come timer let
// the D-173 dive's 250 ms tick win, and its hold then rehearsed 4 items a second instead of one per frame. Pinned at source
// level (map.mjs needs a live context).
test('band gate: wakeIn keeps the earliest wake (a longer hold wake never delays the rehearsal gap)', async () => {
  const { readFileSync } = await import('node:fs'), src = readFileSync(new URL('./map.mjs', import.meta.url), 'utf8');
  const f = src.slice(src.indexOf('  function wakeIn(ms) {'), src.indexOf('\n  }\n', src.indexOf('  function wakeIn(ms) {')));
  assert.ok(f.length > 20, 'wakeIn found');
  assert.match(f, /if \(rh\.wake && rh\.wakeAt <= at\) return;/, 'a pending earlier wake stands');
  assert.match(f, /clearTimeout\(rh\.wake\)/, 'a later pending wake is replaced');
  const g = src.slice(src.indexOf('  function bandGate(view, t) {'), src.indexOf('  /** The rehearsed share'));
  assert.ok(g.indexOf('wakeIn(RH.mapReadyHoldMs') > 0, 'the map-data hold wakes the map when it expires (the longer wake in the same frame)');
});
