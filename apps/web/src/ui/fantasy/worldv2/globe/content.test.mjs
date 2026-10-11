// The globe's content transforms and state machines, which native pins with its own tests (GlobeContentTest,
// DiveCoverTimelineTest, GlobeApproachTest, GlobeGesturesTest). Why each matters is on its test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { halfBits, halfToFloat, fieldTexels, chainLayer, fxPoints, phaseEBox, phaseERecords, resamplePhaseE } from './content.mjs';
import { createApproach, createCoverClock, createGestures } from './motion.mjs';
import { createCamera } from './camera.mjs';
import { placeLabel, placeLabels } from './labels.mjs';
import { PHASE_E, P } from './pin.mjs';
import { effectAnchors } from '../../runtime/island-effects.mjs';
import { ARCHIPELAGOS } from '../../runtime/world.mjs';

test('selection fields decode as native: R16F bits = (R << 8) | G, G16F = B / 128', () => {
  // why: the outline's distance and rate are data, not colour; one wrong bit moves the realm rim
  for (const v of [0, 1, -1, 0.5, 25.9, -25.9, 1 / 128, 255 / 128, 65504]) assert.ok(Math.abs(halfToFloat(halfBits(v)) - v) <= Math.abs(v) * 1e-3, `half ${v}`);
  assert.equal(halfBits(1), 0x3c00); assert.equal(halfBits(-2), 0xc000); assert.equal(halfBits(1e-8), 0);
  const px = fieldTexels(new Uint8Array([0x4e, 0x7c, 128, 255, 0xce, 0x7c, 64, 255]), 2);
  assert.deepEqual([...px], [0x4e7c, halfBits(1), 0xce7c, halfBits(0.5)]);
  assert.ok(Math.abs(halfToFloat(0x4e7c) - 25.9375) < 1e-9);
});

test('a chain layer keeps only mask-land texels, premultiplied, box-halved; the land bits stay full size', () => {
  // why (RG-1): what is drawn is what is tapped; a sea texel of the art must never pick the island
  const size = 4, color = new Uint8Array(size * size * 4).fill(200), mask = new Uint8Array(size * size * 4);
  mask[0] = 1; mask[4] = 1; mask[(size + 0) * 4] = 1; mask[(size + 1) * 4] = 1; // the top-left 2×2 block is land
  mask[2 * 4] = 1; // one land texel of the next block
  const { land, layer, size: half } = chainLayer(color, mask, size, 2);
  assert.equal(half, 2); assert.equal(land.reduce((a, b) => a + b, 0), 5);
  assert.deepEqual([...layer.slice(0, 4)], [200, 200, 200, 255]);
  assert.deepEqual([...layer.slice(4, 8)], [50, 50, 50, 64]); // one of four: premultiplied quarter
  assert.deepEqual([...layer.slice(8)], new Array(8).fill(0));
});

test('island effect points follow the host sites: shore then features, legacy kinds and colours, 32 islands', () => {
  const fx = fxPoints(effectAnchors);
  assert.equal(effectAnchors.length, ARCHIPELAGOS.reduce((n, c) => n + c.islands.length, 0));
  assert.equal(fx.dirs.length, fx.count * 3); assert.equal(fx.colors.length, fx.count * 4);
  const kinds = new Set(), islands = new Set();
  for (let i = 0; i < fx.count; i++) { kinds.add(fx.info[i * 4]); islands.add(fx.info[i * 4 + 3]); }
  assert.ok(kinds.has(0) && [...kinds].every(k => k >= 0 && k <= 4));
  assert.ok(Math.max(...islands) < 32);
  const firstShore = [...Array(fx.count).keys()].find(i => fx.info[i * 4] === 0);
  assert.deepEqual([...fx.colors.slice(firstShore * 4, firstShore * 4 + 3)], [0xbb, 0xd8, 0xd1]);
  assert.throws(() => fxPoints([{ shore: [], features: [{ kind: 'lava', pixels: [] }] }]), /unknown island effect/);
});

test('Phase E boxes hold each art frame, and the instance records sit at native\'s coordinates', () => {
  // why (G3/RG-3): the islands must appear where native draws them (D-165 placement), not a web approximation
  const rec = phaseERecords();
  PHASE_E.forEach((s, i) => { const [rx, ry] = phaseEBox(s);
    assert.ok(rx > s.wDeg / 2 && ry > s.wDeg * s.aspect / 2 * 0.99, s.id);
    assert.deepEqual([rec[i * 8], rec[i * 8 + 1], rec[i * 8 + 4]], [Math.fround(s.lon), Math.fround(s.lat), i]); });
  // a solid art resamples to an opaque centre and transparent corners (outside the frame + margin)
  const s = PHASE_E[2], w = 64, h = Math.round(64 * s.aspect), art = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) art.set([200, 120, 40, 255], i * 4);
  const size = 32, out = resamplePhaseE(s, art, w, h, size, new Uint8Array(size * size * 4));
  const at = (x, y) => [...out.slice((y * size + x) * 4, (y * size + x) * 4 + 4)];
  assert.equal(at(16, 16)[3], 255); assert.equal(at(0, 0)[3], 0);
});

test('the dive cover shows nothing on a fast dive, rises on a slow one and parts without a frozen frame', () => {
  // why (owner 2026-09-26): a waiting dive must never look frozen, and a normal dive must never flash clouds
  const c = createCoverClock();
  c.start(0); assert.equal(c.alpha(300), 0); c.ready(350); assert.equal(c.animating, false, 'ready before 400 ms: no clouds');
  c.start(1000); assert.equal(c.alpha(1550), 0.5); assert.equal(c.alpha(2000), 1);
  c.live(2000); assert.ok(c.alpha(2225) > 0.4 && c.alpha(2225) < 0.6); assert.equal(c.alpha(2500), 0); assert.equal(c.animating, false);
  c.start(0); c.alpha(600); c.reset(); assert.equal(c.alpha(700), 0, 'a leave never has clouds');
});

test('the approach hook fires once per realm on a low rest or an aiming pinch, never while spinning', () => {
  // why (D-NEXT): a prefetched dive lands in ~0.5 s; a cold one took 3–6 s
  const a = createApproach();
  assert.equal(a.step(0, 'sunscar', 0.5, 0.5, false, false, false, false), null);
  assert.equal(a.step(399, 'sunscar', 0.5, 0.5, false, false, false, false), null);
  assert.equal(a.step(400, 'sunscar', 0.5, 0.5, false, false, false, false), 'sunscar');
  assert.equal(a.step(900, 'sunscar', 0.5, 0.5, false, false, false, false), null, 'conflated');
  assert.equal(a.step(1000, 'frostveil', 0.9, 0.4, true, true, false, false), 'frostveil', 'a pinch aiming below 0.5');
  assert.equal(a.step(1100, 'elderwood', 0.5, 0.5, false, false, true, false), null, 'spinning');
  a.mark('crownlands'); assert.equal(a.step(2000, 'crownlands', 0.4, 0.4, true, true, false, false), null, 'Enter map already asked');
});

test('gestures: a still press taps, a drag past the slop grabs and flings, a pinch zooms', () => {
  const cam = createCamera(); cam.computeView(390, 844); const taps = [];
  const g = createGestures(cam, (x, y) => taps.push([x, y]));
  g.down(1, 195, 422, 0); g.up(1, 197, 423, 100); assert.deepEqual(taps, [[197, 423]]);
  const t0 = cam.t.slice(); g.down(1, 195, 422, 1000); g.move(1, 195 + P.SLOP_PX - 1, 422, 1010); assert.deepEqual(cam.t, t0, 'inside the slop nothing moves');
  for (let i = 1; i <= 5; i++) { g.move(1, 195 + 20 * i, 422, 1010 + 16 * i); cam.computeView(390, 844); }
  g.up(1, 295, 422, 1100); assert.notDeepEqual(cam.t, t0); assert.ok(cam.vel, 'a fling keeps spinning'); assert.equal(taps.length, 1);
  const z0 = cam.z; g.down(1, 150, 400, 2000); g.down(2, 250, 400, 2000); g.move(2, 300, 400, 2016); assert.ok(cam.z > z0, 'spreading fingers zoom in');
  g.up(2, 300, 400, 2030); g.up(1, 150, 400, 2040); assert.equal(taps.length, 1, 'a pinch is never a tap');
});

test('labels are nudged off the chrome and hidden where nothing fits', () => {
  assert.deepEqual(placeLabel([100, 100], 40, 10, [], 390, 844), [80, 95]);
  const p = placeLabel([100, 100], 40, 10, [{ x0: 70, y0: 90, x1: 130, y1: 104 }], 390, 844);
  assert.ok(p && (p[1] + 10 <= 86 || p[1] >= 108), 'moved off the rect');
  assert.equal(placeLabel([100, 100], 40, 10, [{ x0: 0, y0: 0, x1: 390, y1: 844 }], 390, 844), null);
  const placed = placeLabels([{ id: 'a', x: 100, y: 100 }, { id: 'b', x: 102, y: 101 }], () => [40, 10], [], 390, 844);
  assert.equal(placed.length, 2); assert.notDeepEqual([placed[0].left, placed[0].top], [placed[1].left, placed[1].top]);
});
