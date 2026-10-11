// The web globe's camera against the goldens native's GlobeCameraGoldenTest reads (goldens/camera.json: the concept's
// own camera cut from main.js at the pin by native tools/globe2-pin.mjs, the source GlobeV2Pin.kt is generated from).
// Why: the owner taps the same realm at the same pixel on web and native; a drift in the projection, the arcball or the
// framing would put a tap on the wrong realm or frame a selection off-screen on one platform only.
//   node --test src/ui/fantasy/worldv2/globe
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCamera, altOf, fovY, EASE, dirOf, homeFrame, sphereRadiusPx, zOf } from './camera.mjs';
import { P, PIN, REALMS, PHASE_E } from './pin.mjs';

const G = JSON.parse(readFileSync(new URL('./goldens/camera.json', import.meta.url), 'utf8'));
// the goldens are rounded to 1e-12 (r6); native checks 1e-9 relative, the web (same code) holds far tighter
const near = (a, b, what, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
const nearV = (a, b, what, eps) => { assert.equal(a.length, b.length, what); a.forEach((v, i) => near(v, b[i], `${what}[${i}]`, eps)); };

test('the goldens are the pinned export native generated GlobeV2Pin.kt from', () => {
  assert.equal(G.pin, PIN);
  assert.equal(G.suite, 'globe2-camera');
});

test('every presentation constant equals GlobeV2Pin.kt (goldens constants, 58 values)', () => {
  const C = G.constants;
  const map = { altMax: 'ALT_MAX', altMin: 'ALT_MIN', fovRad: 'FOV_RAD', altMinAtlas: 'ALT_MIN_ATLAS', fovPortraitCapDeg: 'FOV_PORTRAIT_CAP_DEG',
    startLon: 'START_LON', startLat: 'START_LAT', startZ: 'START_Z', nearMin: 'NEAR_MIN', nearK: 'NEAR_K', farPad: 'FAR_PAD', flightMs: 'FLIGHT_MS',
    flightPerRad: 'FLIGHT_PER_RAD', flightMaxMs: 'FLIGHT_MAX_MS', arcDiv: 'ARC_DIV', arcMax: 'ARC_MAX', dtMax: 'DT_MAX', inertiaDecay: 'INERTIA_DECAY',
    inertiaStop: 'INERTIA_STOP', zoomEase: 'ZOOM_EASE', diveAltK: 'DIVE_ALT_K', latMax: 'LAT_MAX', diveAlt: 'DIVE_ALT', selFadeS: 'SEL_FADE_S',
    lensEase: 'LENS_EASE', fxBusyMs: 'FX_BUSY_MS', cloudRotPerS: 'CLOUD_ROT_PER_S', cloudAlt0: 'CLOUD_ALT0', cloudAlt1: 'CLOUD_ALT1', sunT: 'SUN_T',
    sunEast: 'SUN_EAST', sunNorth: 'SUN_NORTH', nightSunT: 'NIGHT_SUN_T', nightSunEast: 'NIGHT_SUN_EAST', doubleTapMs: 'DOUBLE_TAP_MS',
    doubleTapPx: 'DOUBLE_TAP_PX', doubleTapDz: 'DOUBLE_TAP_DZ', doubleTapMs2: 'DOUBLE_TAP_MS2', slopPx: 'SLOP_PX', sampleMs: 'SAMPLE_MS',
    grabMax: 'GRAB_MAX', tapMs: 'TAP_MS', velMin: 'VEL_MIN', dprCap: 'DPR_CAP', entranceK: 'ENTRANCE_K', entranceLeadMs: 'ENTRANCE_LEAD_MS',
    focusPad: 'FOCUS_PAD', diveFlightMs: 'DIVE_FLIGHT_MS', diveFlightAlt: 'DIVE_FLIGHT_ALT', diveFarRad: 'DIVE_FAR_RAD',
    diveFailBlockMs: 'DIVE_FAIL_BLOCK_MS', leaveBlockMs: 'LEAVE_BLOCK_MS', labelAlt: 'LABEL_ALT', labelLimb: 'LABEL_LIMB', labelLift: 'LABEL_LIFT',
    realmFocusAlt: 'REALM_FOCUS_ALT', cloudShell: 'CLOUD_SHELL' };
  assert.deepEqual(Object.keys(C).sort(), Object.keys(map).sort(), 'the golden constant set changed: re-pin pin.mjs');
  for (const [k, name] of Object.entries(map)) assert.equal(P[name], C[k], `${name} (${k})`);
  assert.equal(Object.keys(P).length, Object.keys(map).length, 'pin.mjs carries a constant the goldens do not pin');
});

test('realms and Phase E islands keep GlobeV2Pin.kt ids, names, anchors and order (Solana Reach is seeker-reach)', () => {
  assert.deepEqual(REALMS.map(r => r.id), ['frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach', 'stormcairn', 'thornwake', 'cinderfall']);
  assert.equal(REALMS[4].name, 'Solana Reach');
  assert.deepEqual(PHASE_E.map(i => [i.id, i.lon, i.lat]), [['seeker-island', -83.25, 32.25], ['solana-island', -141, 38.25], ['divine-isle', 94, 4]]);
});

test('altitude, field of view and ease curves', () => {
  for (const [z, alt] of G.alts) near(altOf(z), alt, `altOf(${z})`);
  for (const [z, alt] of G.alts) near(zOf(alt), z, `zOf(${alt})`, 1e-8);
  for (const [W, H, f] of G.fovs) near(fovY(W, H), f, `fovY(${W}x${H})`);
  for (const [name, values] of G.eases) values.forEach((v, i) => near(EASE[name](i / 20), v, `EASE.${name}(${i / 20})`));
});

test('computeView, hitSphere and projectDir equal the goldens (24 views, 960 rays, 960 projections)', () => {
  let rays = 0, projections = 0;
  for (const c of G.cases) {
    const cam = createCamera(); cam.t = c.t.slice(); cam.z = c.z; cam.lens.x = c.lens[0]; cam.lens.y = c.lens[1];
    const v = cam.computeView(c.W, c.H);
    near(v.alt, c.alt, 'alt'); nearV(v.eye, c.eye, 'eye'); near(v.pxPerRad, c.pxPerRad, 'pxPerRad');
    nearV(Array.from(v.VP), c.VP, 'VP', 1e-7); nearV(Array.from(v.inv), c.inv, 'inv', 1e-7);
    nearV(v.right, c.right, 'right'); nearV(v.up, c.up, 'up');
    for (const [px, py, hit] of c.hits) { const h = cam.hitSphere(px, py); if (hit === null) assert.equal(h, null, `hit ${px},${py}`); else nearV(h, hit, `hit ${px},${py}`); rays++; }
    for (const [d, p] of c.projections) { const s = cam.projectDir(d); if (p === null) assert.equal(s, null, `project ${d}`); else nearV(s, p, `project ${d}`, 1e-7); projections++; }
  }
  assert.equal(rays, 960); assert.equal(projections, 960);
});

test('grab: the arcball step and the off-sphere pan equal the goldens (60 drags)', () => {
  for (const g of G.grabs) {
    const cam = createCamera(); cam.t = g.t0.slice(); cam.z = g.z; cam.computeView(g.W, g.H);
    const w = cam.grab(g.from, g.to);
    nearV(cam.t, g.t1, 't after grab');
    if (g.step === null) assert.equal(w, null); else nearV(w, g.step, 'step');
  }
});

test('minAltAt: the atlas floor, lower only near the Phase E art when that layer is on (418 points)', () => {
  const on = createCamera(); on.phaseE = true;
  const off = createCamera();
  for (const [d, alt] of G.minAlts) { near(on.minAltAt(d), alt, `minAltAt ${d}`); assert.equal(off.minAltAt(d), P.ALT_MIN_ATLAS, 'RG-3: no closer floor while the islands are off'); }
});

test('fitAlt frames a realm inside the free rect exactly as the concept (30 fits)', () => {
  for (const f of G.fits) {
    const cam = createCamera(); cam.zLo = f.zLo;
    near(cam.fitAlt(f.pts, f.c, f.hw, f.hh, f.lo, f.W, f.H), f.alt, `fit ${f.W}x${f.H}`);
  }
});

test('the home frame fits the whole globe under the header and its radius inverts', () => {
  for (const [W, H] of [[390, 844], [844, 390], [1280, 800]]) {
    const h = homeFrame(W, H, 84, []);
    const r = sphereRadiusPx(h.alt, W, H);
    assert.ok(h.cy - r >= 84 && h.cy + r <= H, `${W}x${H}: the globe sits between the header and the bottom`);
    assert.ok(r * 2 <= W, `${W}x${H}: the globe fits the width`);
  }
  // an obstacle beside the centre pushes the globe off it (the concept's tool column)
  const clear = homeFrame(390, 844, 84, []), blocked = homeFrame(390, 844, 84, [{ x0: 150, y0: 300, x1: 240, y1: 560 }]);
  assert.ok(blocked.alt > clear.alt, 'a blocked centre shrinks the globe');
  assert.deepEqual(dirOf(P.START_LON, P.START_LAT), createCamera().t);
});
