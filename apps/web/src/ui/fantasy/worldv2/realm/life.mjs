// LIFE lane renderer (D-164; plan §2.2, §3.6, §7 A7–A11, A18): scatter (trees, scrub, rocks, crops, litter),
// features and landmarks with their twins, emitters (chimney smoke, spring steam), herds and creatures,
// birds with ground shadows, and realm ambience — all instanced from world-anchored lattices on the GPU.
//
// createLife(core, ground) → { load(pack), setBaseState(tex), update(view), draw(view, pass), rehearse(prog, view),
//   stats(), dispose() }
//   passes: 'shadow' (bird ground shadows, multiply), 'sprite' (y-sorted with bases through the depth buffer),
//   'air' (smoke puffs, particles, birds; above everything).
//   rehearse: SHELL's band rehearsal (contracts GPU_SAFE.rehearse) pre-draws each LIFE program once per pass state.
// Placement lives in scatter.js (the JS reference, unit-tested); this file only uploads what scatter.js
// compiles and plans. Sprite pixels come from the realm pack (realm.json `sprites` + `creatures`, see
// docs/realm-map/lane-life.md); a pack without them draws nothing and says so in stats().missing.
import { UNITS } from './contracts.mjs';
import { LIFE, SCATTER_VS, CREATURE_VS, STAND_VS, SPRITE_FS } from './glsl/sprites.glsl.mjs';
import { BIRD_VS, PARTICLE_VS, AIR_FS } from './glsl/air.glsl.mjs';
import { compileLife, lifeTable, planDraws, ambienceInk, STAND, MAX_SPECIES, GLOW } from './scatter.mjs';
import { taskClock } from './slice.mjs';

/** Sprite size classes (array layer sizes, art px); a frame goes into the smallest that holds it. */
const SIZE_CLASSES = [[32, 32], [64, 64], [96, 96], [160, 128]];
/** Twin layer sizes (map-art px): PACK's mapkit twins are ≤ 10–24 px (kit art reduced exactly 7×). */
const TWIN_CLASSES = [[16, 16], [32, 32], [64, 64], [128, 128]];
/** Array index no draw ever binds: species that exist only as map-scale art (map objects) carry it. */
const NO_ARRAY = 15;
const MAX_LAYERS = 256, SPT = 6, TABLE_W = MAX_SPECIES * SPT, PUFFS = 3, PUFF_LIFE_MS = 2600;
const norm = id => String(id).replace(/-/g, '_');
// W1 fix pass 2 (D-167: no main-thread stall > 50 ms): the load runs in slices of ≤ SLICE_MS, GROUND's pattern (ground.js
// W1 G3): 8 ms on desktop, 4 ms under a coarse pointer (phones); a slice yields through a message-channel task. It was ONE
// task of 520–744 ms on a desktop CPU (5 realms, real packs): sprite crops, stand clumps, bleed + mips + uploads, table.
// (stage B D1: SLICE_MS and the yields are the page's ONE task clock, slice.js — shared with GROUND, BASES and SHELL's loadModules)
const yieldTask = taskClock.yieldTask;

// ---- CPU pixel work: layer building, RGB bleed into transparent texels, mode-preserving 2× mips ----------
function copyFrame(img, sx, sy, w, h, LW, LH, ox, oy) {
  const out = new Uint8Array(LW * LH * 4), src = img.data, iw = img.width;
  for (let y = 0; y < h; y++) {
    const yy = sy + y; if (yy < 0 || yy >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const xx = sx + x; if (xx < 0 || xx >= iw) continue;
      const s = (yy * iw + xx) * 4, d = ((oy + y) * LW + ox + x) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3] >= 128 ? 255 : 0; // binary alpha (house style)
    }
  }
  return out;
}
/** Ink bounds of a layer: [top, bottom, left, right] or null. */
function inkRows(px, w, h) {
  let top = -1, bot = -1, lft = w, rgt = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]) { if (top < 0) top = y; bot = y; lft = Math.min(lft, x); rgt = Math.max(rgt, x); }
  return top < 0 ? null : [top, bot, lft, rgt];
}
/** Spread opaque RGB into transparent neighbours (2 passes) so linear filtering never pulls in black. */
function bleed(px, w, h) {
  for (let pass = 0; pass < 2; pass++) {
    const src = px.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4; if (src[i + 3]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = (yy * w + xx) * 4; if (!src[j + 3] && !(pass && src[j] | src[j + 1] | src[j + 2])) continue;
        px[i] = src[j]; px[i + 1] = src[j + 1]; px[i + 2] = src[j + 2]; break;
      }
    }
  }
  return px;
}
/** One 2× level: a pixel is opaque when ≥ 50 % of its block is. Its colour is the block's majority opaque
 * colour when one repeats; otherwise (all distinct, the common case in shaded art) the opaque colour
 * nearest the block's mean. Never an average (no new colours, no mud) and never "darkest wins" (which turns
 * every sprite into its outline after a few levels). The plan's mode-preserving pixel-art reducer. */
function reduce2(px, w, h) {
  const dw = Math.max(1, w >> 1), dh = Math.max(1, h >> 1), out = new Uint8Array(dw * dh * 4);
  const cs = [];
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    cs.length = 0; let n = 0, r = 0, g = 0, b = 0, or = 0, og = 0, ob = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const sx = Math.min(w - 1, 2 * x + i), sy = Math.min(h - 1, 2 * y + j), k = (sy * w + sx) * 4; n++;
      r += px[k]; g += px[k + 1]; b += px[k + 2];
      if (px[k + 3]) { cs.push(k); or += px[k]; og += px[k + 1]; ob += px[k + 2]; }
    }
    const d = (y * dw + x) * 4, op = cs.length;
    if (op && op * 2 >= n) {
      or /= op; og /= op; ob /= op;
      let best = cs[0], bc = 0, be = Infinity;
      for (const k of cs) {
        let c = 0; for (const q of cs) if (px[q] === px[k] && px[q + 1] === px[k + 1] && px[q + 2] === px[k + 2]) c++;
        const e = (px[k] - or) ** 2 + (px[k + 1] - og) ** 2 + (px[k + 2] - ob) ** 2;
        if (c > bc || (c === bc && e < be)) { best = k; bc = c; be = e; }
      }
      out[d] = px[best]; out[d + 1] = px[best + 1]; out[d + 2] = px[best + 2]; out[d + 3] = 255;
    } else { out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = 0; }
  }
  return { px: out, w: dw, h: dh };
}
/**
 * Kit art → map art (k = 7): the MAP-scale view of a kit sprite for stand clumps and near-black twins. Blocks are
 * aligned so the anchor lands on a block corner (a member's map seat is then exact); a block is opaque when
 * ≥ 40 % of it is; its colour is an existing pixel — the 55th luma percentile of the block's opaque pixels,
 * outline darks (< 20 % of the block's brightest) left out unless they are all there is. Never an average (no
 * mud), never the darkest (the 1-px outline turns a tree into a black blot at 1/7).
 */
export function reduceMap(src, k = 7) {
  const { img, x, y, w, h } = src, ax = Math.round(src.ax), ay = Math.round(src.ay), iw = img.width, D = img.data;
  const x0 = ax - k * Math.ceil(ax / k), y0 = ay - k * Math.ceil(ay / k);
  const ow = Math.ceil((w - x0) / k), oh = Math.ceil((h - y0) / k), out = new Uint8ClampedArray(ow * oh * 4);
  const luma = i => 0.3 * D[i] + 0.59 * D[i + 1] + 0.11 * D[i + 2];
  for (let by = 0; by < oh; by++) for (let bx = 0; bx < ow; bx++) {
    const cs = [];
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
      const sx = x0 + bx * k + i, sy = y0 + by * k + j;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const q = ((y + sy) * iw + x + sx) * 4;
      if (D[q + 3] >= 128) cs.push(q);
    }
    if (cs.length * 5 < k * k * 2) continue;
    const top = Math.max(...cs.map(luma)), body = cs.filter(q => luma(q) >= 0.2 * top), use = (body.length ? body : cs).sort((a, b) => luma(a) - luma(b) || a - b);
    const q = use[Math.floor(use.length * 0.55)], o = (by * ow + bx) * 4;
    out[o] = D[q]; out[o + 1] = D[q + 1]; out[o + 2] = D[q + 2]; out[o + 3] = 255;
  }
  return { img: { data: out, width: ow, height: oh }, x: 0, y: 0, w: ow, h: oh, ax: (ax - x0) / k, ay: (ay - y0) / k };
}
const meanLuma = s => { let n = 0, L = 0; for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const q = ((s.y + y) * s.img.width + s.x + x) * 4; if (s.img.data[q + 3] >= 128) { n++; L += 0.3 * s.img.data[q] + 0.59 * s.img.data[q + 1] + 0.11 * s.img.data[q + 2]; } } return n ? L / n : 0; };

// ---- pack adapter: realm.json `sprites` / `creatures` in the shapes PACK may write -------------------------
function rectList(section) {
  const r = section?.rects ?? section?.list ?? null;
  if (!r) return [];
  return Array.isArray(r) ? r.map(e => [norm(e.id ?? e.key), e]) : Object.entries(r).map(([k, e]) => [norm(k), e]);
}

export function createLife(core, ground) {
  const gl = core.gl;
  core.include('life', LIFE);
  let L = null, arrays = [], table = null, progs = null, info = null, plan = null, missing = [], ready = false, why = 'not loaded', darkTwins = [];
  let loadGen = 0; // a dispose or a newer load bumps it: the sliced load in flight stops at its next step
  const st = { draws: 0, submitted: 0, slices: 0, loadMs: 0 };
  const freeGpu = () => { for (const a of arrays) core.tex.free(a.tex); core.tex.free(table); arrays = []; table = null; };

  /** Run a load generator in ≤ SLICE_MS slices (GROUND's sliced(), ground.js). A step that yields a promise (a pack read)
   * gets its value back, or its rejection thrown in. → { value }, or null when a dispose or a newer load superseded it
   * (the generator is closed). An awaited read does not restart the slice clock: a read that resolves at once never
   * released the main thread. */
  async function sliced(job, my) {
    let send, err = null;
    for (;;) { // (stage B D1: the shared task clock, checked before EVERY step — a job started in a spent task yields at once)
      if (my !== loadGen) { job.return(); return null; }
      if (taskClock.spent()) { await yieldTask(); st.slices++; if (my !== loadGen) { job.return(); return null; } }
      const r = err ? job.throw(err) : job.next(send); send = undefined; err = null;
      if (r.done) return { value: r.value };
      if (typeof r.value?.then === 'function') { try { send = await r.value; } catch (e) { err = e ?? Error('pack read failed'); } }
    }
  }

  function addArray(key, LW, LH) {
    const a = { key, LW, LH, frames: [], tex: null };
    arrays.push(a); return arrays.length - 1;
  }
  /** Put frames into the array of their size class (a new one when full); returns {arr, layer0, LW, LH, ox, oy}. */
  function place(key, fw, fh, count, classes = SIZE_CLASSES) {
    const sc = classes.findIndex(([W, H]) => fw <= W && fh <= H);
    if (sc < 0) return null;
    const [LW, LH] = classes[sc];
    let ai = arrays.findIndex(a => a.key === key + sc && a.frames.length + count <= MAX_LAYERS);
    if (ai < 0) ai = addArray(key + sc, LW, LH);
    const a = arrays[ai], layer0 = a.frames.length;
    return { arr: ai, layer0, LW, LH, ox: Math.floor((LW - fw) / 2), oy: LH - fh, a };
  }

  /** Ids that draw on the air layer (birds, ambience, emitter puffs): they go to the 32×32 air array. */
  const airIds = t => new Set([...(t.birds?.species ?? []).map(s => s[0]), ...(t.ambience ?? []).map(a => a.id),
    ...t.groups.flatMap(g => g.species.map(s => s[2]?.emit?.fx).filter(Boolean))].map(norm));
  /** The pack's sprite, creature, twin, map-object and shared fx frames into layers (a generator for sliced(): it yields
   * each pack read and after each frame). */
  function* readSprites(pack, air, shared) {
    const meta = pack.meta, S = meta.sprites, C = meta.creatures;
    const sprites = new Map(), creatures = new Map();
    if (S?.atlas) {
      const img = yield pack.pixels(S.atlas);
      for (const [id, r] of rectList(S)) {
        const w = r.w, h = r.h, n = Math.max(1, r.frames ?? 1), dx = r.dx ?? w;
        const slot = place(air.has(id) ? 'air' : 'spr', w, h, n);
        if (!slot) { missing.push(`${id} (${w}×${h} too large)`); continue; }
        let top = 1e9, bot = -1, wide = 0;
        for (let f = 0; f < n; f++) {
          const fr = r.frameRects?.[f] ?? { x: r.x + f * dx, y: r.y };
          const px = copyFrame(img, fr.x, fr.y, w, h, slot.LW, slot.LH, slot.ox, slot.oy);
          const ink = inkRows(px, slot.LW, slot.LH); if (ink) { top = Math.min(top, ink[0]); bot = Math.max(bot, ink[1]); wide = Math.max(wide, ink[3] - ink[2] + 1); }
          slot.a.frames.push(px); yield;
        }
        // the anti-speckle measure: ink height; for things on the air layer (a bird is a wingspan) the larger extent
        const inkH = bot >= 0 ? bot - top + 1 : 0;
        const f0 = r.frameRects?.[0] ?? { x: r.x, y: r.y };
        sprites.set(id, { inkH: air.has(id) ? Math.max(inkH, wide) : inkH, w, h, ax: r.ax ?? w / 2, ay: r.ay ?? h, frames: n, frameMs: r.frameMs ?? r.ms ?? 120,
          arr: slot.arr, layer0: slot.layer0, LW: slot.LW, LH: slot.LH, lax: (r.ax ?? w / 2) + slot.ox, lay: (r.ay ?? h) + slot.oy,
          src: { img, x: f0.x, y: f0.y, w, h, ax: r.ax ?? w / 2, ay: r.ay ?? h } });
      }
    }
    if (C?.atlas) {
      const img = yield pack.pixels(C.atlas);
      for (const c of C.list ?? []) {
        const id = norm(c.id), fw = c.fw ?? 64, fh = c.fh ?? 64, dirs = c.directions ?? 4, fr = c.frames ?? 6, n = dirs * fr;
        const slot = place('cre', fw, fh, n);
        if (!slot) { missing.push(`${id} (creature sheet too large)`); continue; }
        let top = 1e9, bot = -1;
        for (let f = 0; f < n; f++) {
          const px = copyFrame(img, c.x + f * fw, c.y, fw, fh, slot.LW, slot.LH, slot.ox, slot.oy);
          const ink = inkRows(px, slot.LW, slot.LH); if (ink) { top = Math.min(top, ink[0]); bot = Math.max(bot, ink[1]); }
          slot.a.frames.push(px); yield;
        }
        creatures.set(id, { inkH: bot >= 0 ? bot - top + 1 : 0, frames: fr, frameMs: c.frameMs ?? 120, speed: c.speed ?? 20, dwellMs: c.dwellMs ?? 1500,
          directions: dirs, kind: c.kind === 'water' ? 'water' : 'ground', arr: slot.arr, layer0: slot.layer0, LW: slot.LW, LH: slot.LH,
          lax: (c.ax ?? fw / 2) + slot.ox, lay: (c.ay ?? fh) + slot.oy });
      }
    }
    // PACK's reducer-built map-scale twins (mapkit.png, map-art px): drawn at MAP in place of minified kit art
    const T = meta.map?.twins, file = meta.map?.atlas?.file;
    if (T && file) {
      const img = yield pack.pixels(file);
      for (const [id, r0] of rectList({ rects: T })) {
        const sp = sprites.get(id); if (!sp) continue;
        // a PACK twin far darker than its kit sprite seen at 1/7 is the "black grove" defect (Gate A2 GA2-02): use LIFE's reduction
        let r = r0, from = img;
        const mine = sp.src ? reduceMap(sp.src) : null, pk = { img, x: r0.x, y: r0.y, w: r0.w, h: r0.h };
        if (mine && meanLuma(pk) < 0.7 * meanLuma(mine)) { r = { x: 0, y: 0, w: mine.w, h: mine.h, ax: mine.ax, ay: mine.ay }; from = mine.img; darkTwins.push(id); }
        const slot = place('tw', r.w, r.h, 1, TWIN_CLASSES);
        if (!slot) { missing.push(`${id} twin (${r.w}×${r.h} too large)`); continue; }
        slot.a.frames.push(copyFrame(from, r.x, r.y, r.w, r.h, slot.LW, slot.LH, slot.ox, slot.oy));
        sp.twin = { arr: slot.arr, layer: slot.layer0, LW: slot.LW, LH: slot.LH, lax: Math.round((r.ax ?? r.w / 2) + slot.ox), lay: Math.round((r.ay ?? r.h) + slot.oy) };
        yield;
      }
    }
    // map objects (peaks, hills, crags, realm specials): map-scale art only, drawn by the twin pass at true size
    const O = meta.map?.objects;
    if (O && file) {
      const img = yield pack.pixels(file);
      for (const [id, r] of rectList({ rects: O })) {
        const slot = place('tw', r.w, r.h, 1, TWIN_CLASSES);
        if (!slot) { missing.push(`${id} map object (${r.w}×${r.h} too large)`); continue; }
        const px = copyFrame(img, r.x, r.y, r.w, r.h, slot.LW, slot.LH, slot.ox, slot.oy), ink = inkRows(px, slot.LW, slot.LH);
        slot.a.frames.push(px); yield;
        sprites.set(id, { inkH: (ink ? ink[1] - ink[0] + 1 : r.h) * 7, w: r.w * 7, h: r.h * 7, ax: 0, ay: 0, frames: 1, frameMs: 1000, arr: NO_ARRAY, layer0: 0, LW: 0, LH: 0, lax: 0, lay: 0,
          twin: { arr: slot.arr, layer: slot.layer0, LW: slot.LW, LH: slot.LH, lax: Math.round((r.ax ?? r.w / 2) + slot.ox), lay: Math.round((r.ay ?? r.h) + slot.oy), ox: slot.ox, oy: slot.oy } });
      }
    }
    // the shared ambient fx pack (pack/realm/shared/fx.png + fx.json, plan §4.1/§5.3): leaves, petals, pollen, motes, spray
    if (shared) {
      const fx = yield shared.json('fx.json').catch(() => null);
      if (fx?.atlas) {
        const img = yield shared.pixels(fx.atlas);
        for (const [id, r] of rectList({ rects: fx.sprites ?? fx.rects })) {
          const n = Math.max(1, r.frames ?? 1), slot = place('air', r.w, r.h, n);
          if (!slot) { missing.push(`${id} (shared fx ${r.w}×${r.h} too large)`); continue; }
          let top = 1e9, bot = -1, wide = 0;
          for (let f = 0; f < n; f++) {
            const px = copyFrame(img, r.x + f * (r.dx ?? r.w), r.y, r.w, r.h, slot.LW, slot.LH, slot.ox, slot.oy);
            const ink = inkRows(px, slot.LW, slot.LH); if (ink) { top = Math.min(top, ink[0]); bot = Math.max(bot, ink[1]); wide = Math.max(wide, ink[3] - ink[2] + 1); }
            slot.a.frames.push(px); yield;
          }
          sprites.set(id, { inkH: Math.max(bot >= 0 ? bot - top + 1 : 0, wide), w: r.w, h: r.h, ax: r.ax ?? r.w / 2, ay: r.ay ?? r.h / 2, frames: n, frameMs: r.frameMs ?? 160,
            arr: slot.arr, layer0: slot.layer0, LW: slot.LW, LH: slot.LH, lax: (r.ax ?? r.w / 2) + slot.ox, lay: (r.ay ?? r.h / 2) + slot.oy });
        }
      }
    }
    return { sprites, creatures };
  }

  /** One MAP clump per stand variant: its members' kit sprites seen at map scale (reduceMap, 1 px = 7 art px)
   * laid out exactly where the TRUE members stand, painter-ordered, binary alpha. A generator for sliced(): it yields after
   * each member (a first reduceMap of a 160×128 sprite is the step's cost) and each clump. */
  function* composeStands() {
    const S = L.stands; if (!S) return;
    for (const V of S.variants) {
      const parts = [];
      for (const m of V.members) {
        const sp = S.species[m.s].sp, t = sp.src ? (sp.map7 ??= reduceMap(sp.src)) : null;
        if (!t) { if (!missing.includes(`${S.species[m.s].id} (stand clump art)`)) missing.push(`${S.species[m.s].id} (stand clump art)`); continue; }
        const x0 = Math.round(m.dx / 7) - (m.flip ? t.w - t.ax : t.ax), y0 = Math.round(m.dy / 7) - t.ay;
        parts.push({ t, x0, y0, flip: m.flip });
        yield;
      }
      if (!parts.length) continue;
      const minX = Math.min(...parts.map(p => p.x0)), minY = Math.min(...parts.map(p => p.y0));
      const w = Math.max(...parts.map(p => p.x0 + p.t.w)) - minX, h = Math.max(...parts.map(p => p.y0 + p.t.h)) - minY;
      const slot = place('tw', w, h, 1, TWIN_CLASSES);
      if (!slot) { missing.push(`stand clump ${w}×${h} too large`); continue; }
      const px = new Uint8Array(slot.LW * slot.LH * 4);
      for (const p of parts) {
        const { t } = p, iw = t.img.width;
        for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
          const si = ((t.y + y) * iw + t.x + x) * 4;
          if (t.img.data[si + 3] < 128) continue;
          const dx = slot.ox + p.x0 - minX + (p.flip ? t.w - 1 - x : x), dy = slot.oy + p.y0 - minY + y, di = (dy * slot.LW + dx) * 4;
          px[di] = t.img.data[si]; px[di + 1] = t.img.data[si + 1]; px[di + 2] = t.img.data[si + 2]; px[di + 3] = 255;
        }
      }
      slot.a.frames.push(px);
      V.clump = { arr: slot.arr, layer: slot.layer0, LW: slot.LW, LH: slot.LH, lax: slot.ox - minX, lay: slot.oy - minY };
      yield;
    }
  }

  /** Every frame: RGB bleed, then its mode-preserving 2× chain down to 1×1, each level uploaded as it is reduced. A generator
   * for sliced() (W1 fix pass 2): it yields after the bleed and after each level, so a step holds at most one upload. */
  function* uploadArrays() {
    for (const a of arrays) {
      if (!a.frames.length) continue;
      const levels = Math.floor(Math.log2(Math.max(a.LW, a.LH))) + 1; // = the 2× chain's length down to 1×1
      a.tex = core.tex.array(a.LW, a.LH, a.frames.length, 'RGBA8', { levels, filter: 'linear' });
      // pick ONE reducer-built level (never blend two: an inter-level blend is exactly the mud the reducer avoids)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, a.tex.t); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_NEAREST);
      for (let i = 0; i < a.frames.length; i++) {
        let m = { px: bleed(a.frames[i], a.LW, a.LH), w: a.LW, h: a.LH }; a.frames[i] = null;
        yield;
        for (let l = 0; l < levels; l++) {
          core.tex.layer(a.tex, i, { data: m.px, w: m.w, h: m.h }, null, l);
          if (l + 1 < levels) m = reduce2(m.px, m.w, m.h);
          yield;
        }
      }
      a.layers = a.frames.length; a.frames = null; // pixels live on the GPU; the loader keeps the atlas for context loss
    }
  }

  /** The species/density table (RGBA16UI): 2 rows per scatter group, creatures, birds, each ambience emitter. */
  function buildTable() {
    const rows = [];
    const row = () => { const r = new Uint16Array(TABLE_W * 4); rows.push(r); return rows.length - 1; };
    const put = (r, x, v) => { if (x >= TABLE_W) throw Error(`LIFE table row overflow at texel ${x}`); for (let c = 0; c < 4; c++) rows[r][x * 4 + c] = Math.max(0, Math.min(65535, Math.round(v[c] ?? 0))); };
    const dens = (r, arr) => { for (let c = 0; c < arr.length; c++) rows[r][c] = arr[c]; };
    for (const g of L.groups) {
      g.row = row(); row(); dens(g.row + 1, g.density);
      g.species.forEach((s, i) => {
        const sp = s.sp, fx = s.emit ? info.sprites.get(norm(s.emit.fx)) : null, tw = g.twin ? sp.twin : null;
        // Stage B: a map object's lens glow (scatter.js GLOW): T4 = its anchor in the twin layer (map px), radius, period
        const glow = g.mapOnly && s.glow && tw ? [s.glow[0] + (tw.ox ?? 0), s.glow[1] + (tw.oy ?? 0), GLOW.radiusMap, GLOW.periodMs] : null;
        const flags = (s.coast ? 1 : 0) | (fx ? 2 : 0) | (glow ? 4 : 0);
        put(g.row, i * SPT, [sp.layer0, s.cum - 1, sp.arr | (flags << 4), s.on]);
        put(g.row, i * SPT + 1, [sp.frames, sp.frameMs, sp.inkH, s.footR]);
        put(g.row, i * SPT + 2, [sp.LW, sp.LH, sp.lax, sp.lay]);
        put(g.row, i * SPT + 3, [0, fx ? fx.layer0 + 1 : 0, (s.emit?.dx ?? 0) + 32768, (s.emit?.dy ?? 0) + 32768]);
        put(g.row, i * SPT + 4, glow ?? [fx?.frames ?? 0, fx?.frameMs ?? 0, s.emit?.rise ?? 0, fx?.inkH ?? 0]);
        put(g.row, i * SPT + 5, tw ? [(tw.arr << 9) | (tw.layer + 1), tw.LW | (tw.LH << 8), tw.lax, tw.lay] : [0, 0, 0, 0]);
        if (tw) g.hasTwins = true;
        if (fx) g.hasEmit = true;
        if (glow) g.hasGlow = true;
      });
    }
    const S = L.stands;
    if (S) { // row = species, row+1 = mix class densities, row+2+v = variants (glsl/sprites.glsl.js "stands")
      S.row = row(); row();
      S.species.forEach((s, i) => {
        const sp = s.sp;
        put(S.row, i * SPT, [sp.layer0, 0, sp.arr, 0]);
        put(S.row, i * SPT + 1, [sp.frames, sp.frameMs, sp.inkH, 1]);
        put(S.row, i * SPT + 2, [sp.LW, sp.LH, sp.lax, sp.lay]);
      });
      S.mixes.forEach((mx, k) => { for (let c = 0; c < mx.density.length; c++) rows[S.row + 1][(k * 4 + (c >> 2)) * 4 + (c & 3)] = mx.density[c]; });
      S.variants.forEach(V => {
        const r = row(), mx = S.mixes[V.mix], cl = V.clump;
        put(r, 0, [V.mix | (V.members.length << 4) | (mx.field.id << 9) | ((mx.sway ? 1 : 0) << 10) | ((mx.mapOnly ? 1 : 0) << 11), V.R4, cl ? cl.layer + 1 : 0, cl ? cl.arr : 0]);
        put(r, 1, cl ? [cl.LW | (cl.LH << 8), cl.lax, cl.lay, V.inkH] : [0, 0, 0, V.inkH]);
        V.members.forEach((m, i) => put(r, 2 + i, [m.dx + 32768, m.dy + 32768, m.s, m.flip]));
        put(r, 18, [V.footDy + 32768, 0, 0, 0]);
      });
    }
    const c = L.creatures;
    if (c?.species.length) {
      c.row = row(); row(); dens(c.row + 1, c.density);
      c.species.forEach((s, i) => {
        const sh = s.sh;
        put(c.row, i * SPT, [sh.layer0, s.cum - 1, sh.kind === 'water' ? 1 : 0, s.on]);
        put(c.row, i * SPT + 1, [sh.frames, sh.frameMs, sh.inkH, sh.speed]);
        put(c.row, i * SPT + 2, [sh.LW, sh.LH, sh.lax, sh.lay]);
        put(c.row, i * SPT + 3, [sh.dwellMs, s.herdMin, s.herdMax, sh.directions]);
      });
    }
    const b = L.birds;
    if (b?.species.length) {
      b.row = row(); row();
      b.species.forEach((s, i) => {
        const sp = s.sp;
        put(b.row, i * SPT, [sp.layer0, s.cum - 1, 0, s.on]);
        put(b.row, i * SPT + 1, [sp.frames, sp.frameMs, sp.inkH, s.speed]);
        put(b.row, i * SPT + 2, [32, 32, sp.lax, sp.lay]);
        put(b.row, i * SPT + 3, [s.fMin, s.fMax, s.alt, 0]);
      });
    }
    for (const a of L.ambience) { a.row = row(); row(); dens(a.row + 1, a.density); }
    const data = new Uint16Array(TABLE_W * 4 * rows.length);
    rows.forEach((r, i) => data.set(r, i * TABLE_W * 4));
    table = core.tex.data(TABLE_W, rows.length, 'RGBA16UI', null, null, data);
  }

  /** How many instanced draws submit each window (scatter.js submittedTotal counts them against the §9 budget, RM-20):
   * the draw loops below, per group / stand / birds. The fake-GL test holds the two equal frame by frame. */
  function submitCounts() {
    const has = (a, k) => a != null && !!arrays[a]?.tex && arrays[a].key.startsWith(k), air = airArray() >= 0;
    const kitArrays = ss => new Set(ss.map(s => s.sp.arr).filter(a => has(a, 'spr'))).size;
    for (const g of L.groups) g.submit = { kit: kitArrays(g.species), kitMap: g.twin ? kitArrays(g.species.filter(s => !s.sp.twin)) : 0,
      twin: g.hasTwins ? new Set(g.species.map(s => s.sp.twin?.arr).filter(a => has(a, 'tw'))).size : 0, puffs: g.hasEmit && air ? PUFFS : 0 };
    const S = L.stands;
    if (S) S.submit = { members: new Set(S.species.map(s => s.sp.arr).filter(a => !!arrays[a]?.tex)).size,
      clumps: new Set(S.variants.filter(V => V.clump).map(V => V.clump.arr).filter(a => !!arrays[a]?.tex)).size };
    if (L.birds) L.birds.submit = air ? 2 : 0; // the shadow pass and the air pass
  }

  function programs() {
    return {
      scatter: core.program('life-scatter', { vs: SCATTER_VS, fs: SPRITE_FS, defines: { LIFE_GLOW: 1 } }), // Stage B: map-object lens glows (only this VS writes vGlow)
      creature: core.program('life-creature', { vs: CREATURE_VS, fs: SPRITE_FS, defines: {} }),
      stand: core.program('life-stand', { vs: STAND_VS, fs: SPRITE_FS, defines: {} }),
      standMerged: core.program('life-stand-merged', { vs: STAND_VS, fs: SPRITE_FS, defines: { STAND_MERGED: 1 } }), // uMode 3 only (P0 fix pass)
      bird: core.program('life-bird', { vs: BIRD_VS, fs: AIR_FS, defines: {} }),
      particle: core.program('life-particle', { vs: PARTICLE_VS, fs: AIR_FS, defines: {} }),
    };
  }

  const airArray = () => arrays.findIndex(a => a.key === 'air0');
  let rehearsing = false; // a band rehearsal draws ONE instance of each real draw (SHELL's contract)
  function quads(n) { gl.bindVertexArray(core.quadVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, rehearsing ? 1 : n); st.draws++; st.submitted += n; }
  function bindCommon(p, arrIdx) {
    p.use().bindView();
    gl.uniform1i(p.u('uRehearse'), rehearsing ? 1 : 0); // every real draw clears it (a program keeps its uniforms)
    p.tex('uArr', 0, arrays[arrIdx].tex);
    p.tex('uLTable', 1, table);
    ground?.bindClasses?.(p, UNITS.classesFirst);
    const F = L.fields; // the round-2 stand field (scatterPick modulation, stands)
    gl.uniform4i(p.u('uField'), F.veg.salt, F.rock.salt, 0, 0); gl.uniform4i(p.u('uCover'), F.veg.lo, F.veg.k, F.rock.lo, F.rock.k);
    gl.uniform1i(p.u('uTrueCls'), plan.trueClasses ? 1 : 0); // GLSL lifeClass: TRUE records only where GROUND guarantees them
  }

  // ---- scatter: one instanced draw per array, the groups that own species in it concatenated -------------
  function drawScatter(view, mode) {
    const P = progs.scatter, air = airArray(), keyed = k => arrays.map((a, i) => i).filter(i => arrays[i].tex && arrays[i].key.startsWith(k));
    const targets = mode === 0 ? keyed('spr') : mode === 2 ? keyed('tw') : (air >= 0 ? [air] : []);
    // mode 0 while the TRUE weight is 0 (plan.trueOn false): only a twin group's species WITHOUT a map twin can draw kit
    // art (as its twin); an array holding none of them would submit instances that all cull (RM-20)
    const kitNow = (g, s) => plan.trueOn !== false || (g.twin && !s.sp.twin);
    const owns = (pg, ai) => mode === 0 ? pg.g.species.some(s => s.sp.arr === ai && kitNow(pg.g, s)) : mode === 2 ? pg.g.hasTwins && pg.g.species.some(s => s.sp.twin?.arr === ai) : pg.g.hasEmit;
    const range = pg => (mode === 2 ? pg.tw : pg.kit); // W1: the kit range (kit art, puffs) or the twin range, plain or rank window
    for (const ai of targets) {
      const list = plan.groups.filter(pg => range(pg)?.count > 0 && owns(pg, ai)).slice(0, 8);
      if (!list.length) continue;
      const A = new Int32Array(32), B = new Int32Array(32), C = new Int32Array(32), R = new Int32Array(32);
      let start = 0;
      list.forEach((pg, i) => {
        const r = range(pg), rl = r.rl;
        A.set(rl ? [rl.bx0, rl.by0, rl.nbx, start] : [pg.ix0, pg.iy0, pg.nx, start], i * 4);
        R.set([rl ? rl.m : 0, rl ? rl.j0 : 0, mode === 2 ? r.lo : pg.truHi ?? 0, r.hi], i * 4); // the twin range starts at the TRUE bound
        B.set([pg.g.pitchArt, pg.g.jitterArt, pg.g.salt, pg.g.species.length], i * 4);
        const M = pg.g.mod;
        C.set([(pg.g.twin ? 1 : 0) | (pg.g.sway ? 2 : 0) | (pg.g.mapOnly ? 4 : 0) | ((pg.stride ?? 1) << 8), pg.g.row, M ? M.out | (M.inn << 12) : 0,
          (M ? M.edge | (M.id << 12) | (1 << 13) : 0) | (pg.g.cluster8 << 16)], i * 4);
        start += r.count;
      });
      bindCommon(P, ai);
      gl.uniform4iv(P.u('uGrp'), A); gl.uniform4iv(P.u('uGrpB'), B); gl.uniform4iv(P.u('uGrpC'), C); gl.uniform4iv(P.u('uGrpR'), R);
      gl.uniform1i(P.u('uNG'), list.length); gl.uniform1i(P.u('uArray'), ai); gl.uniform1i(P.u('uMode'), mode);
      gl.uniform1i(P.u('uPuffs'), PUFFS); gl.uniform1ui(P.u('uPuffLife'), PUFF_LIFE_MS); gl.uniform2f(P.u('uWind'), L.wind[0], L.wind[1]); gl.uniform1f(P.u('uArtPerDeed'), mode === 2 ? 448 : 3136);
      const n = mode === 1 ? start * PUFFS : start;
      quads(n);
    }
  }
  /** Stands: mode 0 the members (one draw per kit array they use), mode 2 each stand's own MAP clump, mode 3 the
   * merged clumps of 2×2 stand blocks at low MAP (both per twin array). Members and own clumps draw their rank ranges
   * (W1: plain or rank window, planDraws' mem / clu); merged blocks their plain (strided) window. */
  function drawStands(mode) {
    const ps = plan.stands, S = L.stands;
    if (!ps || S?.row == null) return;
    const n = mode === 0 ? ps.members : mode === 2 ? ps.clumps : ps.merged;
    if (!n) return;
    const r = mode === 0 ? ps.mem : mode === 2 ? ps.clu : null, rl = r?.rl;
    const win = mode === 3 ? ps.mergedWin : rl ? { ix0: rl.bx0, iy0: rl.by0, nx: rl.nbx, stride: 1 } : ps;
    const used = new Set(mode === 0 ? S.species.map(s => s.sp.arr) : S.variants.filter(V => V.clump).map(V => V.clump.arr));
    const P = mode === 3 ? progs.standMerged : progs.stand;
    for (const ai of used) {
      if (!arrays[ai]?.tex) continue;
      bindCommon(P, ai);
      gl.uniform4i(P.u('uWin'), win.ix0, win.iy0, win.nx, win.stride ?? 1);
      gl.uniform4i(P.u('uRank'), rl ? rl.m : 0, rl ? rl.j0 : 0, mode === 2 ? r.lo : ps.truHi ?? 0, r ? r.hi : 65536); // own clumps start at the TRUE bound
      gl.uniform4i(P.u('uStand'), S.pitchArt, S.jitterArt, S.salt, S.variants.length);
      gl.uniform1i(P.u('uRow'), S.row); gl.uniform1i(P.u('uArray'), ai); gl.uniform1i(P.u('uMode'), mode);
      gl.uniform4f(P.u('uSplit'), STAND.splitFrom, STAND.splitFull, STAND.mergeFrom, S.mergeUntil);
      gl.uniform1f(P.u('uArtPerDeed'), mode === 2 ? 448 : mode === 3 ? 224 : 3136);
      quads(n);
    }
  }
  function drawCreatures() {
    const pc = plan.creatures, c = L.creatures;
    if (!pc || !pc.count || c.row == null) return;
    const ai = c.species[0].sh.arr, P = progs.creature;
    bindCommon(P, ai);
    gl.uniform4i(P.u('uWin'), pc.ix0, pc.iy0, pc.nx, pc.stride ?? 1);
    gl.uniform4i(P.u('uCre'), c.pitchArt, c.jitterArt, c.salt, c.species.length);
    gl.uniform1i(P.u('uRow'), c.row); gl.uniform1f(P.u('uKeep'), pc.keep); gl.uniform1f(P.u('uArtPerDeed'), 3136);
    quads(pc.count);
  }
  function drawBirds(shadow) {
    const pb = plan.birds, b = L.birds, air = airArray();
    if (!pb || !pb.count || b.row == null || air < 0) return;
    const P = progs.bird;
    bindCommon(P, air);
    gl.uniform4i(P.u('uWin'), pb.ix0, pb.iy0, pb.nx, pb.stride ?? 1);
    gl.uniform4i(P.u('uBird'), b.pitchArt, b.jitterArt, b.salt, b.species.length);
    gl.uniform1i(P.u('uRow'), b.row); gl.uniform1i(P.u('uP16'), b.p16); gl.uniform1f(P.u('uKeep'), pb.keep);
    gl.uniform1f(P.u('uSky'), pb.scale); gl.uniform1i(P.u('uShadow'), shadow ? 1 : 0);
    quads(pb.count);
  }
  function drawParticles() {
    const air = airArray(); if (air < 0) return;
    const P = progs.particle;
    for (const e of plan.ambience) {
      if (!e.count) continue;
      const a = e.a, sp = a.sp;
      bindCommon(P, air);
      gl.uniform4i(P.u('uWin'), e.ix0, e.iy0, e.nx, e.stride ?? 1);
      gl.uniform4i(P.u('uAmb'), a.pitchArt, a.jitterArt, a.salt, a.kind === 'fall' ? 1 : a.kind === 'spray' ? 2 : 0);
      gl.uniform4i(P.u('uAmbB'), a.lifeMs, a.alt ?? 0, a.rise ? 1 : 0, a.row);
      gl.uniform4i(P.u('uSpr'), sp.layer0, sp.frames, sp.frameMs, ambienceInk(a));
      gl.uniform2i(P.u('uAnchor'), sp.lax, sp.lay);
      const k = a.windK ?? 1; gl.uniform2f(P.u('uWind'), L.wind[0] * k, L.wind[1] * k);
      gl.uniform1f(P.u('uKeep'), e.keep); gl.uniform1i(P.u('uShadow'), 0);
      quads(e.count);
    }
  }

  /** A pass's GL state around fn (draw and rehearse share it, so a rehearsal builds exactly the real pipeline). */
  function inPass(pass, fn) {
    const depthOn = gl.isEnabled(gl.DEPTH_TEST);
    if (pass === 'shadow') { gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.DST_COLOR, gl.ZERO); }
    else if (pass === 'sprite') { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); gl.disable(gl.BLEND); }
    else { gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); }
    fn();
    if (pass === 'shadow') { gl.disable(gl.BLEND); gl.depthMask(true); }
    if (pass !== 'sprite' && depthOn) gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
  const PASSES = {
    shadow: () => drawBirds(true),
    sprite: view => { drawScatter(view, 0); if (view.d < 1100) drawScatter(view, 2); drawStands(0); drawStands(2); drawStands(3); drawCreatures(); },
    air: () => { drawScatter(null, 1); drawParticles(); drawBirds(false); },
  };
  /**
   * Band rehearsal (RM-GPU-1 P0 fix pass; contract v2, W1): each program's draws in each pass state its real passes use,
   * as [pass, draw]. rehearse() runs them against a plan of one 1-cell window per stream at the cell under the camera,
   * whole rank ranges (the kit draws TRUE, the twin and clump draws not), so every draw is the real code path (program,
   * VAO, samplers, uniforms, blend and depth state) with ONE instance; uRehearse makes that instance cover the view centre.
   */
  const REHEARSE = {
    scatter: [['sprite', () => { drawScatter(null, 0); drawScatter(null, 2); }], ['air', () => drawScatter(null, 1)]],
    stand: [['sprite', () => { drawStands(0); drawStands(2); }]],
    standMerged: [['sprite', () => drawStands(3)]],
    creature: [['sprite', drawCreatures]],
    bird: [['shadow', () => drawBirds(true)], ['air', () => drawBirds(false)]],
    particle: [['air', drawParticles]],
  };
  function rehearsalPlan(view) {
    const cx = (view?.x ?? 0) * 3136, cy = (view?.y ?? 0) * 3136; // the camera point (art px)
    const one = pitch => ({ ix0: Math.floor(cx / pitch), iy0: Math.floor(cy / pitch), nx: 1, ny: 1, stride: 1 }), all = { lo: 0, hi: 65536, rl: null, count: 1 };
    const S = L.stands;
    return { trueClasses: false, trueOn: true, total: 0, groups: L.groups.map(g => ({ g, ...one(g.pitchArt), count: 1, kit: all, tw: all, truHi: 65536, keepHi: 65536 })),
      stands: S ? { ...one(S.pitchArt), sites: 1, members: 1, clumps: 1, merged: 1, mergedWin: one(2 * S.pitchArt), mem: all, clu: all, truHi: 65536, keepHi: 65536 } : undefined,
      creatures: L.creatures?.species.length ? { ...one(L.creatures.pitchArt), count: 1, keep: 0 } : undefined,
      birds: L.birds?.species.length ? { ...one(L.birds.pitchArt), count: 1, keep: 0, scale: 1 } : undefined,
      ambience: L.ambience.map(a => ({ a, ...one(a.pitchArt), count: 1, keep: 0 })) };
  }

  /** Which clocks this view needs (core's timed idle policy renders only as often as they tick). */
  function declareAnimations(view) {
    const rm = view.reducedMotion, on = (tag, ms) => core.animating(tag, rm ? 0 : ms);
    const clips = plan.groups.filter(pg => pg.count).flatMap(pg => pg.g.species.filter(s => s.sp.frames > 1).map(s => s.sp.frameMs));
    on('life-clips', clips.length ? Math.min(...clips) : 0);
    on('life-creatures', plan.creatures?.count ? Math.min(...L.creatures.species.map(s => s.sh.frameMs)) : 0);
    on('life-air', plan.birds?.count || plan.ambience.some(e => e.count) || plan.groups.some(pg => pg.count && pg.g.hasEmit) ? 50 : 0);
    on('life-glow', plan.groups.some(pg => pg.count && pg.g.hasGlow) ? 100 : 0); // Stage B: beacon lenses pulse (GLOW.periodMs)
    on('life-sway', view.d >= 2000 && (plan.groups.some(pg => pg.count && pg.g.sway) || (plan.stands?.members && L.stands.mixes.some(m => m.sway))) ? 100 : 0);
  }

  return {
    /** pack = the realm pack; shared = the shared realm-map pack (optional; brings the shared ambient fx). */
    async load(pack, shared = null) {
      const my = ++loadGen, t0 = performance.now(); // a load in flight stops at its next step; what it uploaded is freed here
      freeGpu(); ready = false; missing = []; plan = null; darkTwins = []; st.slices = 0; st.loadMs = 0;
      const table0 = lifeTable(pack.id ?? pack.meta?.id, pack.meta);
      if (!table0) { why = `no LIFE table for ${pack.id}`; return; }
      // W1 fix pass 2: one generator in ≤ SLICE_MS slices (it was one 520–744 ms task after the last pack read)
      const done = await sliced((function* () {
        info = yield* readSprites(pack, airIds(table0), shared);
        if (!info.sprites.size && !info.creatures.size) { why = 'pack has no realm.json sprites/creatures'; return false; }
        L = compileLife(pack.id ?? pack.meta.id, table0, { sprite: id => info.sprites.get(norm(id)) ?? null, creature: id => info.creatures.get(norm(id)) ?? null });
        yield;
        missing.push(...L.missing);
        L.bounds = { x0: 0, y0: 0, x1: pack.meta.grid.cols * 3136, y1: pack.meta.grid.rows * 3136 };
        yield* composeStands();
        if (Array.isArray(pack.meta.wind?.artPxPerSec)) L.wind = pack.meta.wind.artPxPerSec; // PACK's realm wind wins over the table default
        yield* uploadArrays();
        buildTable(); submitCounts();
        yield;
        progs = programs();
        return true;
      })(), my);
      if (!done?.value || my !== loadGen) return; // superseded (dispose / a newer load), or a pack without LIFE art (why says so)
      st.loadMs = Math.round(performance.now() - t0);
      ready = true; why = 'ok';
    },
    setBaseState() { /* plots reach the shaders through GROUND's classes include (plotSdf) */ },
    update(view) {
      if (!ready) return;
      plan = planDraws(L, { x: view.x, y: view.y, d: view.d, W: view.W, H: view.H, dpr: view.dpr, rm: view.reducedMotion, bounds: L.bounds });
      declareAnimations(view);
    },
    draw(view, pass) {
      if (!ready || !plan) return;
      st.draws = 0; st.submitted = 0;
      if (pass === 'shadow' && !plan.birds?.count) return;
      if (PASSES[pass]) inPass(pass, () => PASSES[pass](view));
    },
    /**
     * SHELL's band rehearsal hook (contracts GPU_SAFE.rehearse v2): draw LIFE program `prog` once per pass state its real
     * passes use, one instance each, covering the view centre (the caller holds the scissored box and restores its
     * state; it may call again for states its core deferred: idempotent). Truthy when it drew; falsy while the pack is not
     * loaded, the program is not linked, or this pack gives it nothing to draw. No uploads, no viewport change.
     */
    rehearse(prog, view) {
      if (!ready || !prog?.ready) return false;
      const k = progs && Object.keys(progs).find(n => progs[n] === prog), steps = k && REHEARSE[k];
      if (!steps) return false;
      const keep = plan, n0 = st.draws; plan = rehearsalPlan(view); rehearsing = true;
      try { for (const [pass, fn] of steps) inPass(pass, fn); } finally { plan = keep; rehearsing = false; }
      return st.draws > n0;
    },
    stats() {
      if (!ready) return { ready, why, missing };
      const gpu = arrays.reduce((s, a) => s + (a.tex?.bytes ?? 0), 0) + (table?.bytes ?? 0);
      return { ready, why, missing, gpuMB: gpu / 1048576, arrays: arrays.map(a => `${a.key} ${a.LW}×${a.LH}×${a.layers ?? 0}`),
        submitted: plan?.total ?? 0, groups: Object.fromEntries((plan?.groups ?? []).map(pg => [pg.g.id, pg.count])),
        creatures: plan?.creatures ? { count: plan.creatures.count, keep: +plan.creatures.keep.toFixed(3) } : null,
        birds: plan?.birds ? { count: plan.birds.count, keep: +plan.birds.keep.toFixed(3), sky: plan.birds.scale } : null,
        stands: L.stands ? { variants: L.stands.variants.length, clumps: L.stands.variants.filter(V => V.clump).length, sites: plan?.stands?.sites ?? 0,
          members: plan?.stands?.members ?? 0, clumpDraws: plan?.stands?.clumps ?? 0, merged: plan?.stands?.merged ?? 0, mergedStride: plan?.stands?.mergedWin?.stride ?? 0 } : null,
        // thinned lattices: world-aligned strides (map objects, merged blocks, keep-capped streams) id → stride, and the
        // §9 ceiling's rank thinning (W1) id → kept fraction; tau = the fitted thinning per tier, model = the bound total
        strides: Object.fromEntries([...(plan?.groups ?? []).filter(pg => pg.count).map(pg => [pg.g.id, pg.stride]), ['merged', plan?.stands?.mergedWin?.stride], ['creatures', plan?.creatures?.stride],
          ['birds', plan?.birds?.stride], ...(plan?.ambience ?? []).map(e => [e.a.id, e.stride])].filter(([, v]) => v > 1)), cap: plan?.cap ?? 0,
        keep: Object.fromEntries([...(plan?.groups ?? []).filter(pg => pg.count || pg.tw?.count).map(pg => [pg.g.id, pg.keep]), ['stands', plan?.stands?.keep]]
          .filter(([, v]) => v != null && v < 1).map(([k, v]) => [k, +v.toFixed(4)])), thin: plan?.thin ?? null,
        particles: (plan?.ambience ?? []).map(e => `${e.a.id}:${e.count}@${e.keep.toFixed(2)}`),
        twins: L.groups.some(g => g.hasTwins) ? 'mapkit twins (PACK, reducer 7×)' : 'kit sprite + reducer mips (no mapkit twins in pack)',
        darkTwinsReplaced: darkTwins.slice(), load: { ms: st.loadMs, slices: st.slices } }; // W1 fix pass 2: the sliced load's wall time, yields
    },
    /** QA/parity probes: the compiled tables and the species table texture (read-only use). */
    debug: () => ({ L, table, arrays: arrays.map(a => ({ key: a.key, LW: a.LW, LH: a.LH, layers: a.layers })) }),
    dispose() { loadGen++; freeGpu(); ready = false; },
  };
}
