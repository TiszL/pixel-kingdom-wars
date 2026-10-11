// Web port P8 (native 82c91fc + 560fe54; owner 2026-09-26 on Sunscar: "keep is displayed very ugly on current screen ...
// on this range only player profile picture and name should be visible, in efficient way"). Why each check matters:
//   * no keep icon, banners or towers draw in the MAP range: that was the rejected look;
//   * every kingdom keeps its dot there: a tag alone lets kingdoms vanish (at most 16 tags, overlaps dropped);
//   * the icon's tap rect stays, so a tap picks the kingdom exactly where it did before;
//   * a shielded kingdom keeps its D-181 dome;
//   * the tag sits on the dot, and gets its level back only when the live keep draws (d 200-280 hand-over).
// Without markers the concept's icon look is unchanged (the option is the web's, the engine default stays).
// D-191 (owner 2026-09-28, endorsing a player: "the sort keep level seems like not functioning, I still can see all the
// keeps"): a kingdom that fails the filter is HIDDEN — no dot, icon, keep, dome, tap rect or tag — never dimmed, because a
// dimmed keep reads as the filter doing nothing. Its deed stays an occupied plot (never open land); the selected kingdom
// always draws (its card is up on it); hidden kingdoms keep their static instance caches, so a filter change never
// rebuilds them. With or without the markers option: the hiding is the CPU draw list's, not a shader's.
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createBases, baseMode } from './bases.mjs';
import { BANDS, FLAG, UBO_VIEW } from './contracts.mjs';

const sharp = createRequire(new URL('../../../../../../../scripts/package.json', import.meta.url).pathname)('sharp');
const PACKS = PACK_ROOT + 'realm/';
const raw = new Map();
const decode = f => { if (!raw.has(f)) raw.set(f, sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => ({ width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) }))); return raw.get(f); };
const packOf = id => {
  const dir = PACKS + id + '/', meta = JSON.parse(readFileSync(dir + 'realm.json', 'utf8'));
  return { id, meta, first: { deeds: new Uint8Array(meta.grid.cols * meta.grid.rows) }, pixels: f => decode(dir + f), json: async f => JSON.parse(readFileSync(dir + f, 'utf8')),
    shared: { pixels: f => decode(PACKS + 'shared/' + f), json: async f => JSON.parse(readFileSync(PACKS + 'shared/' + f, 'utf8')) } };
};
// a GL stand-in with just what BASES touches (decor.cases.mjs fakeBasesCore, trimmed)
function fakeCore() {
  const C = { DEPTH_TEST: 1, BLEND: 2, LEQUAL: 3, ONE: 1, ONE_MINUS_SRC_ALPHA: 4, TRIANGLES: 4, ARRAY_BUFFER: 5, UNIFORM_BUFFER: 6, FLOAT: 7, DYNAMIC_DRAW: 8, STATIC_DRAW: 9, TEXTURE0: 100 };
  const bound = {}, noop = () => {};
  const gl = { ...C, enable: noop, disable: noop, depthFunc: noop, depthMask: noop, blendFunc: noop, createVertexArray: () => ({ attribs: {} }), bindVertexArray: noop, deleteVertexArray: noop,
    createBuffer: () => ({}), bindBuffer(t, b) { bound[t] = b; }, deleteBuffer: noop, bufferData: noop, bufferSubData: noop, bindBufferBase: noop, enableVertexAttribArray: noop,
    vertexAttribDivisor: noop, vertexAttribPointer: noop, activeTexture: noop, bindTexture: noop, useProgram: noop, uniform1i: noop, uniform1f: noop, uniform2f: noop, uniform3fv: noop, drawArraysInstanced: noop };
  const program = name => { const p = { name, state: 'ready', samplers: {}, get ready() { return true; }, use: () => p, bindView: () => { gl.bindBufferBase(C.UNIFORM_BUFFER, UBO_VIEW, null); return p; }, u: n => ({ n }), tex: () => p }; return p; };
  const tex = { array: (w, h, layers, format, o = {}) => ({ w, h, layers, format, levels: o.levels ?? 1 }), layer: noop, data: (w, h, format) => ({ w, h, format }), update: noop, free: noop };
  return { gl, program, tex, quadBuffer: {}, invalidate: noop, animating: noop, dpr: 2 };
}
async function loaded(markers) {
  const pack = packOf('frostveil'), bases = createBases(fakeCore(), null, { markers });
  await bases.load(pack, pack.shared);
  const { cols, rows } = pack.meta.grid, cx = Math.floor(cols / 2), cy = Math.floor(rows / 2);
  const list = [
    { id: 1, x: cx, y: cy, level: 5, name: 'Ar', avatar: null, shield: true, mine: true, attackable: false, clan: null },
    { id: 2, x: cx + 2, y: cy, level: 12, name: 'Bel', avatar: null, shield: true, mine: false, attackable: false, clan: null },
    { id: 3, x: cx - 2, y: cy + 1, level: 20, name: 'Cor', avatar: null, shield: false, mine: false, attackable: false, clan: null },
  ];
  bases.setBases(list); bases.setFilter(b => b.id !== 2); // Bel is filtered out
  return { bases, list, cx, cy, cols };
}
/** Flag byte of the base-state texture at deed (x, y): what GROUND reads to draw the plot. */
const flagsAt = (bases, cols, x, y) => bases.stateCpu[(y * cols + x) * 4 + 1];
const viewAt = (cx, cy, s, dpr = 2) => ({ x: cx + 0.5, y: cy + 0.5, s, d: s * dpr, dpr, W: 800, H: 600, band: 'map', ms: 0, pulseMs: 0, reducedMotion: true,
  rect: { x0: cx - 8, y0: cy - 6, x1: cx + 9, y1: cy + 7, fx0: cx - 8, fy0: cy - 6, fx1: cx + 9, fy1: cy + 7 } });

test('web port P8 + D-191: in the MAP range a kingdom is its dot and its tag with its tap rect; a filtered-out kingdom is hidden, the selected one always draws', async () => {
  const { bases, cx, cy, cols } = await loaded(true), s = 60, v = viewAt(cx, cy, s); // d 120: past the icon switch, before the hand-over
  for (const b of [1, 2, 3]) assert.equal(baseMode(s, v.d, 0.99, 0.99), 'icon', 'the concept would draw an icon here');
  bases.update(v); let st = bases.stats();
  assert.equal(st.icons, 0, 'no keep icon art in the MAP range');
  // D-191: Bel fails the filter, so nothing of it draws — no dot, no dome, no tap rect, no tag anchor
  assert.equal(st.visible, 3, 'three kingdoms are in view'); assert.equal(st.hidden, 1, 'the filtered-out one is hidden');
  assert.equal(st.dots, 2, 'the filtered-in kingdoms keep their dots; the hidden one has none (not a dim one)');
  assert.equal(st.domes, 1, 'the filtered-in shielded kingdom gets its dome; a hidden kingdom never domes');
  let cand = bases.tagCandidates(v);
  assert.deepEqual(cand.map(c => c.base.id).sort(), [1, 3], 'no tag anchor for a hidden kingdom');
  const [hx, hy] = [(cx + 2 + 0.5 - v.x) * s + v.W / 2, (cy + 0.5 - v.y) * s + v.H / 2]; // Bel's deed centre, CSS px
  assert.equal(bases.pick(hx, hy), null, 'nothing to tap where the hidden kingdom stands (no rect, no dome ellipse)');
  // its deed is still an occupied plot on the ground (never open land): occupied set, filteredIn cleared
  assert.equal(flagsAt(bases, cols, cx + 2, cy) & (FLAG.occupied | FLAG.filteredIn), FLAG.occupied, 'the hidden kingdom stays an occupied plot in the state texture');
  assert.equal(flagsAt(bases, cols, cx, cy) & (FLAG.occupied | FLAG.filteredIn), FLAG.occupied | FLAG.filteredIn, 'a filtered-in kingdom carries filteredIn');
  const mine = cand.find(c => c.base.id === 1);
  const dotY = (cy + 0.5 - v.y) * s + v.H / 2; // the plot centre sits within half a deed of the deed centre
  assert.ok(mine && Math.abs(mine.sy - dotY) < s / 2 + 8, `the tag sits on the dot (tag ${mine?.sy.toFixed(1)}, dot row ${dotY.toFixed(1)})`);
  // the tap rect is the icon's, as before: its centre picks the kingdom
  const r = cand.find(c => c.base.id === 3); assert.equal(bases.pick(r.sx, r.sy + 12)?.id, 3, 'a tap where the icon stood picks the kingdom');
  // the selected kingdom always draws, filter or not: the card is up on it
  bases.select(2); bases.update(v); st = bases.stats();
  assert.equal(st.hidden, 0, 'a selected kingdom is never hidden'); assert.equal(st.dots, 3, 'its dot is back');
  assert.equal(st.domes, 2, 'and its dome'); assert.ok(bases.tagCandidates(v).some(c => c.base.id === 2), 'and its tag anchor');
  bases.select(null); bases.update(v); assert.equal(bases.stats().hidden, 1, 'deselected, it hides again');
  assert.equal(bases.drawsBase({ id: 1 }, v), false, 'no level on the tag before the hand-over');
  assert.equal(bases.drawsBase({ id: 1 }, viewAt(cx, cy, BANDS.impostor[1] / 2 + 1)), true, 'past d 280 every kingdom draws its keep: the tag gets its level');
});

test('D-191 without the markers option: the concept\'s icons draw for the filtered-in kingdoms only, none dimmed', async () => {
  const { bases, cx, cy } = await loaded(false), v = viewAt(cx, cy, 60);
  bases.update(v); const st = bases.stats();
  assert.equal(st.icons, 2, 'the concept\'s keep icons for the two filtered-in kingdoms'); assert.equal(st.dots, 0);
  assert.equal(st.hidden, 1, 'the filtered-out kingdom is hidden here too (the hiding is the draw list\'s, not the web option\'s)');
  assert.equal(st.domes, 1, 'the concept used to dome every shielded icon, filtered or not; a hidden kingdom never domes');
});

test('D-191: hidden kingdoms keep their static instance caches, so a filter change never rebuilds them', async () => {
  const { bases, cx, cy } = await loaded(true), v = viewAt(cx, cy, BANDS.impostor[1] / 2 + 10); // d ≈ 300: every kingdom draws its live keep
  bases.setFilter(null);
  // the caches build under the frame budget once the path network is in: pump frames until all three are built
  for (let i = 0; i < 200 && bases.stats().builds < 3; i++) bases.update({ ...v, ms: i * 16 });
  const st0 = bases.stats(); assert.equal(st0.builds, 3, 'one static cache per kingdom'); assert.equal(st0.keeps, 3);
  bases.setFilter(b => b.id !== 2); bases.update({ ...v, ms: 5000 });
  const st1 = bases.stats(); assert.equal(st1.keeps, 2, 'the hidden keep is gone'); assert.equal(st1.hidden, 1);
  bases.setFilter(null); bases.update({ ...v, ms: 6000 });
  const st2 = bases.stats(); assert.equal(st2.keeps, 3, 'back'); assert.equal(st2.builds, 3, 'no cache was rebuilt by hiding and showing');
});
