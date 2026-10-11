// Realm maps — BASES (plan §6, §7, §10.2). BASES lane.
// Draws every claimed deed of the resident realm, at every band:
//   FAR   (s < 24)          occupancy dots (gold = yours), a faint cyan halo on known-shielded ones;
//   s 24→48                 dots switch to keep marker icons, per base (hashed), never blended;
//   MAP   (s ≥ 48, d < 200) marker mode: the half-size keep icon (28 CSS px) on its claim, shield ring look;
//   d 200→280 (no rest)     the icon switches (per base) to the live keep at true × kFit(L), inside its walls,
//                           and the plot impostor's mini-sprites appear (every decor instance, map-art density);
//   d 280→1100              the keep shrinks toward true size (on-screen size still grows), pennants, smoke,
//                           dome silhouettes from s ≥ 100;
//   d 800→1100              each mini-sprite dissolves (per instance) into its TRUE sprite at the same seat,
//                           walls and the plot edge dissolve in as GROUND's yard layer fades out;
//   TRUE  (d ≥ 1100)        game-v4 buildings, wall5 walls, the realm's kit dressing, torches, full shield domes.
// It draws no plot ground (GROUND does). Picking: keep rects → dome ground ellipse → (map.js) deed cell.
//
// Art sources, first that exists: PACK's shared/keeps.* + shared/decor.* and realm.json sprite rects
// (§4.1); else, in development only, raw read-only masters under `?baseart=<root>` (the BASES dev server
// serves art/game-v4, art/source/walls-five-tier and /kitart/<realm>/ from the pinned kit SHA). Anything
// missing is listed in stats().missing — never silently skipped.
import {
  composeBaseDecor, edgeSprites, edgeAutotileSprites, EDGE_ARMS, wallSprites, keepScale, seedOf, hash2, DECOR_ART, KIT_DRESSING, decorScaleOf,
  DECOR_LAYOUT, basePathsJob, settlePath, bridgePiece, bridgeSeats, KEEP_TIPS,
} from './decor.mjs';
import { classAt } from './classify.mjs';
import { BANDS, FLAG, KIND, TILES, ART, DEED_PX, PLOT_CENTRE, plotRule, plotOffset, KEEP_FOOTPRINT, UBO_VIEW } from './contracts.mjs';
import { pixelsOf } from './loader.mjs';
import { SPRITE_VS, SPRITE_FS, DOT_VS, DOT_FS, FX_VS, FX_FS, FIELD_VS, FIELD_FS } from './glsl/bases.glsl.mjs';
import { SHIELD_VS, SHIELD_FS } from './glsl/shield.glsl.mjs';
import { taskClock } from './slice.mjs';

const MAP_PX_PER_TILE = 448 / 98;           // map-art density (plan §3.3): 4.57 art px per tile
const CLASSES = [[16, 32], [32, 32], [32, 64], [48, 48], [64, 64], [64, 96], [96, 64], [96, 96], [128, 96], [128, 128]];
const MAX_LAYERS = 256, MINI = 16;
const SPECK_ROLES = new Set(['wildSmall', 'wildRock', 'fieldFill']);
const mipsOf = (w, h) => Math.floor(Math.log2(Math.min(w, h))) + 1;   // full chain down to one texel per side
// Stage B (RM-GPU-1 W1 lift step #4, D-167: no main-thread stall > 50 ms): the load runs in slices of ≤ SLICE_MS, GROUND's
// and LIFE's pattern (ground.js W1 G3, life.js sliced()): 8 ms on desktop, 4 ms under a coarse pointer (phones); a slice
// yields through a message-channel task. buildAtlases was ONE task of 1.7–2.5 s on every entry and context-loss rebuild
// (ink trims, mini reductions, bleed + mode mips + ~4.6k layer uploads a realm).
// (stage B D1: SLICE_MS and the yields are the page's ONE task clock, slice.js — shared with GROUND, LIFE and SHELL's loadModules)
const yieldTask = taskClock.yieldTask;
const SHIELD = Object.freeze({ mapCap: 40, trueCap: 8 });
const HERALDIC = [[0.78, 0.18, 0.2], [0.2, 0.45, 0.85], [0.2, 0.62, 0.34], [0.55, 0.3, 0.72], [0.9, 0.55, 0.15], [0.16, 0.6, 0.62], [0.85, 0.85, 0.82], [0.35, 0.22, 0.14]];
const GOLD = [1.0, 0.839, 0.42];
/** Marker-mode companions (fix iteration 2, QA critical 1: "210 identical keep icons in rows"): from L12 a kingdom's
 *  icon is flanked by 1–3 of its own defence towers (game-v4 art, the type per seed), so high-level neighbours differ. */
const ICON_TOWERS = Object.freeze(['archer/t4', 'magetower/t4', 'lasertower/t3', 'electrictower/t4', 'magetower/t3', 'lasertower/t4', 'archer/t3']);
/**
 * A kingdom's marker-mode look (fix iteration 2, QA critical 1): pure, per level and seed (tested).
 *   css    icon width in CSS px: grows with the level (L1 = the 28-px floor … L20 ≈ 1.34×), ±6 % per seed, ≥ keepMinCss;
 *   tips   the keep spires that fly its heraldic banner (one seeded spire; the two outer spires from L12);
 *   towers companion defence towers behind the keep: none below L12, 1 at L12–14, 2 at L15–17, 2–3 from L18;
 *   tower  their game-v4 art (per seed); first = the side (−1 W / +1 E) the first one stands on.
 */
export function iconLook(level, seed) {
  const L = Math.min(20, Math.max(1, Math.round(level) || 1)), h = k => hash2(seed >>> 0, k) / 4294967296, t = (L - 1) / 19;
  const towers = L < 12 ? 0 : L < 15 ? 1 : L < 18 ? 2 : 2 + (h(14) < 0.5 ? 0 : 1);
  return { css: BANDS.keepMinCss * Math.max(1, (1 + 0.34 * t) * (0.94 + 0.12 * h(11))), tips: L >= 12 ? [0, 3] : [hash2(seed >>> 0, 12) % 4],
    towers, tower: towers ? ICON_TOWERS[hash2(seed >>> 0, 15) % ICON_TOWERS.length] : null, first: h(16) < 0.5 ? -1 : 1 };
}
/**
 * Where a marker icon stands on its plot (fix pass, Stage B owner-bar critic #1, 2026-09-25). The icon used to stand with
 * its foot on the keep seat, 1 t below the plot centre, so at MAP d 80–150 the whole icon sat in the top half of its
 * clearing: "the keep icon at the top edge of its pad". In marker mode the icon's ink is now centred on the plot centre
 * (GROUND's clearing, claim tint and BASES' shield ring are all centred there). Toward the icon → live-keep switch it eases
 * back onto the seat, because the live keep stands on its seat inside its walls: centred up to d ICON_CENTRE_D[0], on the
 * seat from d ICON_CENTRE_D[1] = BANDS.impostor[0] (the first per-base switch), smoothstep in log d between.
 * inkMid = the icon ink's vertical middle relative to its anchor, in tiles (< 0: above it). Returns the plot-local y (t)
 * of the icon's anchor. Pure (tested).
 */
export const ICON_CENTRE_D = Object.freeze([150, BANDS.impostor[0]]);
export function iconAnchorY(d, inkMid) {
  const [a, b] = ICON_CENTRE_D, t = clamp(Math.log(d / a) / Math.log(b / a), 0, 1), w = 1 - t * t * (3 - 2 * t);
  const seat = KEEP_FOOTPRINT[1] / 2 + PLOT_CENTRE;
  return seat + w * (PLOT_CENTRE - inkMid - seat);
}
/** Realm accents (src/landmarks.js REALM_INFO .accent, read-only there): the globe lights each realm with its accent,
 *  so the shield dome's outer aura carries a breath of it (HUD-STYLE: accent is light, never a fill). */
const ACCENT = Object.freeze({ frostveil: '#8fe3ff', sunscar: '#ffbf4d', crownlands: '#ffd65c', stormcairn: '#9dbcff', cinderfall: '#ff8a4c',
  elderwood: '#86ec6c', thornwake: '#c6e65a', 'seeker-reach': '#c99dff' });   // Stage B: the three catch-up realms (landmarks.js REALM_INFO)
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** The kit's chimney-smoke sprite (Stage B: Solana Reach has no smoke_drift; its kit's vapour_drift rises instead). */
const smokeIdOf = realm => KIT_DRESSING[realm]?.smoke?.[0] ?? 'smoke_drift';

// ---- pixel-art reducers (mode-preserving, alpha-aware: plan §2.3 anti-mud, §4.3 step 7) ----------------
/** Reduce by a (possibly non-integer) factor f, mode-preserving and alpha-aware (plan §2.3, §4.3 step 7; the same
 *  rule as PACK's base-atlas modeResample): the source px whose centres fall in an output px vote in colour
 *  buckets (3 bits per channel, so one shading ramp votes together); the winning bucket's most frequent exact
 *  colour is written. Opaque when ≥ 50 % of the block is. Ties go to the first in scan order (no dark bias). */
export function reduceMode(px, w, h, f, ow = Math.max(1, Math.ceil(w / f)), oh = Math.max(1, Math.ceil(h / f)), darkW = 1) {
  const out = new Uint8Array(ow * oh * 4), buckets = new Map();
  for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) {
    const x0 = Math.max(0, Math.ceil(i * f - 0.5)), x1 = Math.min(w, Math.max(x0 + 1, Math.ceil((i + 1) * f - 0.5)));
    const y0 = Math.max(0, Math.ceil(j * f - 0.5)), y1 = Math.min(h, Math.max(y0 + 1, Math.ceil((j + 1) * f - 0.5)));
    let n = 0, op = 0; buckets.clear();
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      n++; const k = (y * w + x) * 4; if (px[k + 3] < 128) continue; op++;
      const b = ((px[k] >> 5) << 6) | ((px[k + 1] >> 5) << 3) | (px[k + 2] >> 5), c = (px[k] << 16) | (px[k + 1] << 8) | px[k + 2];
      const wt = darkW !== 1 && px[k] * 0.3 + px[k + 1] * 0.59 + px[k + 2] * 0.11 < 48 ? darkW : 1;   // outline ink votes less
      let e = buckets.get(b); if (!e) buckets.set(b, e = { n: 0, cols: new Map() }); e.n += wt; e.cols.set(c, (e.cols.get(c) ?? 0) + wt);
    }
    if (!n || op * 2 < n) continue;
    let win = null; for (const e of buckets.values()) if (!win || e.n > win.n) win = e;
    let best = 0, bn = -1; for (const [c, m] of win.cols) if (m > bn) { best = c; bn = m; }
    const o = (j * ow + i) * 4; out[o] = best >> 16; out[o + 1] = (best >> 8) & 255; out[o + 2] = best & 255; out[o + 3] = 255;
  }
  return { px: out, w: ow, h: oh };
}
/** Copy the colour of an opaque neighbour into transparent texels (alpha stays 0), so linear filtering and
 *  mips never pull black fringes into a sprite's silhouette. */
const NB_X = [1, -1, 0, 0], NB_Y = [0, 0, 1, -1];     // bleed's neighbour order: E, W, S, N (the first match wins)
function bleed(px, w, h, passes = 2) {
  for (let p = 0; p < passes; p++) {
    const src = px.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4; if (src[k + 3] >= 128 || (src[k] | src[k + 1] | src[k + 2])) continue;
      for (let d = 0; d < 4; d++) {                      // Stage B: no per-texel array allocations (it was the load's hot spot)
        const X = x + NB_X[d], Y = y + NB_Y[d]; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = (Y * w + X) * 4; if (src[q + 3] >= 128 || (p > 0 && (src[q] | src[q + 1] | src[q + 2]))) { px[k] = src[q]; px[k + 1] = src[q + 1]; px[k + 2] = src[q + 2]; break; }
      }
    }
  }
  return px;
}
/** The mip chain one level at a time (Stage B: the sliced load uploads each level as it is made, one step each). Each
 *  level is the previous level's bled texels mode-reduced 2×, then bled: the same bytes whether consumed lazily or not. */
function* mipLevels(px, w, h, levels) {
  let p = { px: bleed(px, w, h), w, h };
  yield p;
  for (let l = 1; l < levels; l++) { const r = reduceMode(p.px, p.w, p.h, 2, Math.max(1, p.w >> 1), Math.max(1, p.h >> 1)); r.px = bleed(r.px, r.w, r.h); p = r; yield p; }
}

// ---- pure helpers (unit-tested in decor.test.mjs) ----------------------------------------------------------
/** How a base draws at camera (s CSS px/deed, d device px/deed): 'dot' (FAR), 'icon' (marker mode) or 'keep'
 *  (live keep + impostor). The dot→icon (s 24→48) and icon→keep (d 200→280) switches are PER BASE, by its own
 *  hashes hIcon/hKeep in [0,1): a whole base switches at once, never an alpha blend (plan §2.1). */
export function baseMode(s, d, hIcon, hKeep) {
  const iconW = clamp((s - BANDS.uiDots) / (BANDS.uiIcons - BANDS.uiDots), 0, 1);
  if (!(s >= BANDS.uiIcons || hIcon < iconW)) return 'dot';
  const keepW = clamp((d - BANDS.impostor[0]) / (BANDS.impostor[1] - BANDS.impostor[0]), 0, 1);
  return d >= BANDS.impostor[1] || hKeep < keepW ? 'keep' : 'icon';
}
/** Tap order (plan §6.6): the keep/icon rect nearest the viewer (largest seat y) under the point, else the
 *  first shield dome whose ground ellipse holds it, else null (map.js then falls back to the deed cell). */
export function pickBase(keepRects, domeHits, sx, sy) {
  let best = null;
  for (const r of keepRects) if (sx >= r.x0 && sx <= r.x1 && sy >= r.y0 && sy <= r.y1 && (!best || r.depth > best.depth)) best = r;
  if (best) return best.b;
  for (const h of domeHits) { const u = (sx - h.sx) / h.rx, v = (sy - h.sy) / h.ry; if (u * u + v * v <= 1) return h.b; }
  return null;
}
/** Shield dome caps (plan §6.5): ≤ 40 on screen at MAP, ≤ 8 at TRUE (lod 2); yours first, then the nearest. */
export function capShields(list, lod) {
  const out = [...list].sort((a, c) => ((c.b.mine ? 1 : 0) - (a.b.mine ? 1 : 0)) || (a.dist - c.dist));
  out.length = Math.min(out.length, lod === 2 ? SHIELD.trueCap : SHIELD.mapCap);
  return out;
}
/** workMs (P0 fix pass, RM-GPU-1 gate: JS frame p95 57–66 ms at MAP d 400 / TRUE, over D-167's 50 ms main-thread bar):
 *  ONE per-frame CPU budget for BASES' band-change work — the kingdom path network (basePathsJob, 230–290 ms in one
 *  frame before), per-base decor caches (composeBaseDecor: 1–6 ms each, ≤ 14 ms on efficiency cores; 6 a frame before)
 *  and settling links over terrain (5 ms on top before). A frame spends at most this plus one unit (frameWork). */
export const BASES_LIMITS = Object.freeze({ shield: SHIELD, minPx: 6, mini: 16, workMs: 4 });
/** One frame's CPU work budget: begin() at the frame's start; more() is true for the frame's first unit (so queued work
 *  always progresses, even when the frame's other work already used the budget), then only while the clock is within
 *  ms of begin(); spend() marks a unit done. Pure (injectable clock; unit-tested). */
export function frameWork(ms, now = () => performance.now()) {
  const w = { end: 0, used: false,
    begin() { w.end = now() + ms; w.used = false; return w; },
    more() { return !w.used || now() < w.end; },
    spend() { w.used = true; } };
  return w;
}

/**
 * The GL state of every BASES draw, as [program, depth test (LEQUAL), depth writes, blend: null | 'over' (ONE,
 * ONE_MINUS_SRC_ALPHA) | 'add' (ONE, ONE)]. draw() sets its state only through this table, and the band rehearsal
 * draws every entry (RM-GPU-1 W1 B1). So each pipeline a band change needs is already built at FAR.
 */
export const BASES_GL = Object.freeze({
  field: Object.freeze(['field', false, false, 'over']),        // 'shadow' pass: tended ground, lanes, paths, under every sprite
  shieldBack: Object.freeze(['shield', false, false, 'over']),  // dome back shell + the selection pulse, under the sprites
  shieldFront: Object.freeze(['shield', true, false, 'over']),  // front shell, depth-tested at the claim's south edge
  sprite: Object.freeze(['sprite', true, true, null]),          // minis, icons, keeps, TRUE decor (alpha-tested)
  smoke: Object.freeze(['sprite', true, false, 'over']),
  pennant: Object.freeze(['fx', true, true, null]),
  glow: Object.freeze(['fx', true, false, 'add']),
  dot: Object.freeze(['dot', false, false, 'over']),            // FAR occupancy dots, flat on top
});
/**
 * Band rehearsal data (RM-GPU-1 W1 B1). A rehearsal draw must SHADE a fragment. A draw that covers no pixel leaves
 * the driver's per-fragment work to the band change, for example SwiftShader's sampling routines (P0 gate 2, d 400
 * attribution). SHELL may bind the canvas under a 1×1 scissor or a small target of its own, so each draw covers the
 * WHOLE viewport. It does not depend on the camera, and it needs no art:
 *   view  the RealmView UBO (std140, bound at contracts UBO_VIEW) for the rehearsal only. Deed (0, 0) is the centre
 *         of a 1×1 CSS-px viewport and one tile is 1 CSS px, so cssToClip maps css [0, 1]² onto the whole bound
 *         viewport. d = 3136 (TRUE), so cloudShade runs in full; motion is on.
 *   inst  one instance per program in its vertex layout (two for sprite). Each covers at least css [−0.5, 1.5]² at
 *         the nearest sprite depth (foot one deed south), on pixels its fragment shader keeps:
 *         - sprite: kind 5 (always on), UV extent 0.25 (the magnified textureLod path) and 65536 (the minified
 *           texture() path) on any viewport up to 65536 device px;
 *         - fx: a glow disc 4 t across;
 *         - dot: a 4-px dot with the known-shield halo;
 *         - shield: a dome, rx 2 t, yours;
 *         - field: a lane cell 3.9 t across, open on every side, painted from the kit road array.
 *   tex   placeholders for the samplers (sprite uTex, field uRoad), the same type as the real arrays: 2 layers of
 *         2×2 RGBA8 in a 2D array with its mip chain, linear filtering, opaque white.
 */
export const REHEARSAL = Object.freeze({
  view: Object.freeze([0, 0, 98, 1, 1, 1, 3136, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, -1, -1, -1, -1]),   // + uClock uvec4 0
  attribs: Object.freeze({ sprite: 4, fx: 3, dot: 3, shield: 2, field: 2 }),
  inst: Object.freeze({
    sprite: Object.freeze([0, 0, 1, 0.5, -1, -1, 1, 1, 0, 1, 0, 0, 0.25, 0.25, 5, 0, 0, 0, 1, 0.5, -1, -1, 1, 1, 0, 1, 0, 0, 65536, 65536, 5, 0]),
    fx: Object.freeze([0, 0, 1, 0.5, 4, 4, 0, 0.5, 1, 1, 1, 1]),
    dot: Object.freeze([0, 0, 4, 0.5, 1, 1, 1, 1, 1, 0, 0, 0]),
    shield: Object.freeze([0, 0, 2, 0.5, 1, 1, 2, 0]),
    field: Object.freeze([-0.02, -0.02, 0.02, 0.02, 2, 15, 0.5, 1]),
  }),
  tex: Object.freeze({ w: 2, h: 2, layers: 2, levels: 2, format: 'RGBA8', filter: 'linear' }),
});

// ---- small helpers ---------------------------------------------------------------------------------------
async function limitAll(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
async function fetchPixels(url) {
  const r = await fetch(url); if (!r.ok) throw Error(`${url}: HTTP ${r.status}`);
  const blob = await r.blob();
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const img = pixelsOf(bmp); bmp.close?.(); return img;
}
function crop(img, x, y, w, h) {
  const out = new Uint8Array(w * h * 4), W = img.width, src = img.data;
  for (let j = 0; j < h; j++) { const sy = y + j; if (sy < 0 || sy >= img.height) continue;
    for (let i = 0; i < w; i++) { const sx = x + i; if (sx < 0 || sx >= W) continue; const s = (sy * W + sx) * 4, d = (j * w + i) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3]; } }
  return out;
}
const inkBox = (frames, w, h) => {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const px of frames) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] >= 128) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
};

/**
 * createBases(core, ground) → { load(pack, shared), setBases(list), setFilter(pred), select(id|null), hover(id|null),
 *   stateTex, geomVersion, update(view), draw(view, pass), rehearse(prog, view), pick(sx, sy), tagCandidates(view), stats(), dispose() }
 */
export function createBases(core, ground, { markers = false } = {}) {
  // web port (patches.md P8; native 82c91fc + 560fe54, owner 2026-09-26 "on this range only player profile picture and name
  // should be visible"): markers = in the MAP range, until its own hand-over to the live keep (baseMode 'keep', d 200–280),
  // a kingdom is its occupancy dot and its HUD tag: no keep icon, banners or towers. The icon's tap rect, the selection
  // ring (on the dot) and the D-181 dome stay.
  // D-191 (owner 2026-09-28, a player's "the sort keep level seems like not functioning"): a kingdom that fails the
  // filter is HIDDEN, not dimmed — no dot, icon, keep, mini, emitter, dome or tag (update() skips it, so nothing here
  // or in a shader draws it); its deed stays an occupied plot through the base-state texture (FLAG.occupied without
  // FLAG.filteredIn), never open land. The one exception is the selected kingdom (its card is up), which always draws.
  const gl = core.gl;
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const devArt = q.get('baseart');                    // dev only: root URL of the raw read-only masters
  let realmId = null, pack = null, cols = 0, rows = 0, deeds = null;
  let bases = [], byId = new Map(), filterPred = null, selectedId = null, hoveredId = null;
  let stateData = null, stateTex = null, geomVersion = 0, ready = false, why = 'not loaded';
  const missing = new Set(), catalog = new Map(), arrays = [];
  let miniArr = null, iconArr = null, progs = null, dotBuf = null, fxBuf = null, shieldBuf = null, fieldBuf = null, rh = null;
  let soilRGB = null, accentRGB = null, paths = { segments: [], sides: new Map(), links: [] }, pathsDirty = true;
  // P0 fix pass: the path network builds as a job (basePathsJob + link bucketing) under the frame budget, from the first
  // frame after load (FAR) so it is usually done before MAP needs it; per-base decor waits for it (lanes follow links)
  let pathsJob = null;
  let loadGen = 0, loading = false;                      // Stage B: the sliced load's generation; loading = its art is not in yet
  const work = frameWork(BASES_LIMITS.workMs);
  let roadTex = null, roadN = 0, linksOf = new Map();   // the realm kit's road tiles (lanes + paths at TRUE); base id → link ids
  // paths settle over terrain lazily, per link, when a link first reaches the view (classAt costs ~40 µs a tile next
  // to kingdoms in SwiftShader and a realm has thousands of links; under the frame budget): linkBuckets deed → link ids; settled[i] undefined = not yet, null = dropped
  let linkBuckets = new Map(), settled = [], linkStamp = new Int32Array(0), frameNo = 0, clsAt = null, clsMemo = new Map(), terrainPending = false;
  const instCache = new Map();                           // base id → static per-base instance lists
  // hidden: kingdoms in view the filter hid this frame (D-191); builds: static instance caches built so far (a filter
  // change must not rebuild them: hidden kingdoms keep theirs)
  const st = { visible: 0, hidden: 0, keeps: 0, minis: 0, trues: 0, domes: 0, dots: 0, icons: 0, fx: 0, builds: 0, loadMs: 0, gpuMB: 0, source: 'none', layers: 0, slices: 0, sliceMaxMs: 0, unitMaxMs: 0 };
  let frameLists = null, lastView = null, keepRects = [], domeHits = [];
  const updWin = [];                                     // P0 (D-167 50 ms bar): the last 240 update() times, ms → stats().updateMsP95

  // ================================ art loading =============================================================
  /** A sprite entry: frames (RGBA Uint8Array, cell-sized), the cell size, anchor, scale (tiles per px). A generator for
   *  sliced() (Stage B): it yields each pack read (the slicer awaits it and sends the value back, or throws its error in)
   *  and one step per sprite crop. */
  function* gatherSources(shared) {
    const want = new Map();                               // key → { cell:[w,h], frames, rows, anchor, scale, kind }
    const G = DECOR_ART.game;
    for (const [key, a] of Object.entries(G)) {
      const fam = key.split('/')[0];
      want.set(key, { cell: [a[0], a[1]], frames: a[7], anchor: [a[2], a[1]], scale: decorScaleOf(fam), src: 'game' });
    }
    for (let t = 1; t <= 5; t++) for (const p of ['post', 'straight', 'ns', 'corner_ne', 'corner_nw', 'corner_se', 'corner_sw', 'cross', 'end_e', 'end_n', 'end_s', 'end_w', 'tee_e', 'tee_n', 'tee_s', 'tee_w'])
      want.set(`wall5/t${t}/${p}`, { cell: [32, DECOR_ART.wallCellH[t - 1]], frames: 1, anchor: [16, DECOR_ART.wallCellH[t - 1]], scale: 1 / ART, src: 'wall' });
    want.set('fx/fire', { cell: DECOR_ART.fire.cell, frames: 3, anchor: [8, 24], scale: 1 / ART, src: 'fx', noMini: true });
    const dress = KIT_DRESSING[realmId], kitIds = new Set(), smokeId = smokeIdOf(realmId);
    for (const v of Object.values(dress)) for (const id of (Array.isArray(v) ? v : Object.values(v))) kitIds.add(id);
    kitIds.add(smokeId);
    for (const id of kitIds) {
      const a = DECOR_ART.kit[realmId]?.[id];
      const creature = id.startsWith('creature:');
      want.set(`kit:${id}`, { cell: a ? [a[0], a[1]] : [32, 32], frames: a ? (creature ? 1 : a[8]) : 3, anchor: a ? [a[0] / 2, a[1]] : [16, 32], scale: 1 / ART, src: creature ? 'creature' : id === smokeId ? 'kitfx' : 'kit', id, noMini: id === smokeId });
    }
    // 1) PACK atlases. shared/keeps.json: levels[] (w = frame width); shared/decor.json: sprites{key} where w is
    //    the strip width for multi-frame sprites (frames laid left→right); realm.json sprites.rects / creatures.
    const got = new Map();
    const frameW = r => (r.frames > 1 && r.ink && r.w / r.frames >= r.ink[2] ? r.w / r.frames : r.w);
    const takeStrip = (key, img, r) => {
      const e = want.get(key); if (!e) return;
      const n = Math.max(1, r.frames ?? 1), fw = frameW(r), fr = [];
      for (let f = 0; f < n; f++) fr.push(crop(img, r.x + f * fw, r.y, fw, r.h));
      got.set(key, { ...e, cell: [fw, r.h], frames: fr, anchor: r.anchor ?? [r.ax ?? fw / 2, r.ay ?? r.h] });
    };
    let packed = false;
    if (shared) {
      try { const m = yield shared.json('keeps.json'), img = yield shared.pixels(m.atlas ?? 'keeps.png');
        for (const l of m.levels ?? []) { takeStrip(`keep/l${l.level}`, img, { ...l, w: l.w * (l.frames ?? 1) }); yield; }
        packed = true; } catch { /* not built yet */ }
      try { const m = yield shared.json('decor.json'), img = yield shared.pixels(m.atlas ?? 'decor.png');
        for (const [key, r] of Object.entries(m.sprites ?? {})) { takeStrip(key, img, r); yield; }
        packed = true; } catch { /* not built yet */ }
    }
    const S = pack.meta?.sprites, C = pack.meta?.creatures;
    if (S?.atlas && S.rects) try {
      const img = yield pack.pixels(S.atlas);
      for (const [id0, r] of Object.entries(S.rects)) {
        const id = id0.replace(/-/g, '_'), key = `kit:${id}`, e = want.get(key); if (!e) continue;
        const n = Math.max(1, r.frames ?? 1), dx = r.dx ?? r.w, fr = [];
        for (let f = 0; f < n; f++) fr.push(crop(img, r.x + f * dx, r.y, r.w, r.h));
        got.set(key, { ...e, cell: [r.w, r.h], frames: fr, anchor: [r.ax ?? r.w / 2, r.ay ?? r.h] }); yield;
      }
      packed = true;
    } catch (err) { missing.add('realm sprite atlas: ' + err.message); }
    if (C?.atlas && C.list) try {
      const img = yield pack.pixels(C.atlas);
      for (const c of C.list) {
        const key = `kit:creature:${c.id.replace(/-/g, '_')}`, e = want.get(key); if (!e) continue;
        got.set(key, { ...e, cell: [c.fw ?? 64, c.fh ?? 64], frames: [crop(img, c.x, c.y, c.fw ?? 64, c.fh ?? 64)], anchor: [c.ax ?? (c.fw ?? 64) / 2, c.ay ?? (c.fh ?? 64)] }); yield;
      }
    } catch (err) { missing.add('realm creature atlas: ' + err.message); }
    // 2) dev: raw read-only masters
    const need = [...want.entries()].filter(([k]) => !got.has(k));
    if (need.length && devArt != null) {
      let kit = null;
      try { kit = yield fetch(`${devArt}kitart/${realmId}/kit.json`).then(r => r.json()); } catch (err) { missing.add('dev kit.json: ' + err.message); }
      yield limitAll(need, 12, async ([key, e]) => {   // dev only: raw masters, cropped as they arrive
        try {
          const urls = rawUrls(key, e, kit); if (!urls) { missing.add(key); return; }
          const imgs = await Promise.all(urls.map(fetchPixels)), fr = [];
          if (e.src === 'game') for (let f = 0; f < e.frames; f++) fr.push(crop(imgs[0], f * e.cell[0], 0, e.cell[0], e.cell[1]));
          else for (const im of imgs) fr.push(crop(im, 0, 0, e.cell[0], e.cell[1]));
          if (e.src === 'kit') seatFrames(fr, e.cell[0], e.cell[1]);   // raw kit props are not all seated (Crownlands)
          got.set(key, { ...e, frames: fr });
        } catch (err) { missing.add(`${key} (${err.message})`); }
      });
      st.source = packed ? 'pack+dev-raw' : 'dev-raw';
    } else st.source = packed ? 'pack' : 'none';
    for (const [k] of want) if (!got.has(k)) missing.add(k);
    // ART's plot-edge autotile (realm.json.edges.pieces, in the realm's sprite atlas): 16 pieces by arm mask
    const E = pack.meta?.edges;
    if (E?.pieces) try {
      const img = yield pack.pixels(E.atlas ?? S?.atlas);
      for (const name of EDGE_ARMS) { const r = E.pieces[name]; if (!r) { missing.add(`edge:${name}`); continue; }
        got.set(`edge:${name}`, { cell: [r.w, r.h], frames: [crop(img, r.x, r.y, r.w, r.h)], anchor: [r.w / 2, r.h], scale: 1 / ART, src: 'edge' }); yield; }
      st.edges = 'autotile';
    } catch (err) { missing.add('edge autotile: ' + err.message); }
    else st.edges = 'kit pieces';
    // MAP mini-sprites: PACK's plots.webp (realm.json.plots.minis, anchor in mini px) when present, else the runtime reducer
    const P = pack.meta?.plots;
    if (P?.minis && P.file) try {
      const img = yield pack.pixels(P.file);
      for (const [key, m] of Object.entries(P.minis)) { const e = got.get(key); if (e) { e.packMini = { px: crop(img, m.x, m.y, m.w, m.h), w: m.w, h: m.h, ax: m.anchor[0], ay: m.anchor[1], per: m.scale }; yield; } }
      st.minis_src = 'plots.webp';
    } catch (err) { missing.add('plots.webp: ' + err.message); }
    return got;
  }
  /** Fix iteration 2 (QA 3, "roads are flat charcoal or grey vector strokes"): the lanes and the paths between kingdoms
   *  are painted with the realm kit's OWN road tiles (realm.json true.terrains, the terrain classToTerrain.ROAD maps
   *  to: its pure layers in the TRUE ground atlas — the same art GROUND lays for a ROAD tile), one hashed variant per
   *  tile, mip-mapped so MAP shows their true mean and TRUE the art px. Missing → the flat palette.road colour.
   *  Stage B: a realm whose kit joins its yards with a worn track of another terrain paints them with that terrain
   *  (DECOR_LAYOUT.track: Solana Reach's crystaldust). A generator for sliced(): one step per mip level upload. */
  function* loadRoadTiles(p) {
    const T = p.meta?.true, tid = DECOR_LAYOUT.track[realmId] ?? T?.classToTerrain?.ROAD, road = T?.terrains?.find(t => t.id === tid), L = road?.pureLayers ?? [];
    if (!L.length || !T.atlas?.file) { missing.add(`road tiles (no ${tid} terrain pure layers)`); return; }
    try {
      const img = yield p.pixels(T.atlas.file), cell = T.atlas.cell ?? 32, ac = T.atlas.cols ?? Math.floor(img.width / cell), lv = mipsOf(cell, cell);
      roadTex = core.tex.array(cell, cell, L.length, 'RGBA8', { levels: lv, filter: 'linear' });
      for (let i = 0; i < L.length; i++) {
        let l = 0;
        for (const m of mipLevels(crop(img, (L[i] % ac) * cell, Math.floor(L[i] / ac) * cell, cell, cell), cell, cell, lv)) { core.tex.layer(roadTex, i, { data: m.px, w: m.w, h: m.h }, null, l++); yield; }
      }
      roadN = L.length;
    } catch (err) { missing.add('road tiles: ' + err.message); roadTex = null; roadN = 0; }
  }
  function rawUrls(key, e, kit) {
    const R = devArt;
    if (e.src === 'game') { const [fam, v] = key.split('/'); return [`${R}art/game-v4/buildings/${fam}/${v === 'base' ? 'base' : v + '/idle'}.png`]; }
    if (e.src === 'wall') { const [, t, p] = key.split('/'); return [`${R}art/source/walls-five-tier/family/${t}/pieces/${p}.png`]; }
    if (e.src === 'fx') return [1, 2, 3].map(i => `${R}art/game-v4/fx/legacy-fx_fire_f${i}.png`);
    if (!kit) return null;
    const K = `${R}kitart/${realmId}/`;
    if (e.src === 'creature') { const c = kit.creatures.find(c => c.id === e.id.slice(9)); return c ? [K + c.source.replace('%s', 'down').replace('%d', '0')] : null; }
    if (e.src === 'kitfx') { const s = kit.sprites.find(s => s.id === e.id); return s ? s.sources.slice(0, 3).map(p => K + p) : null; }
    const p = kit.props.find(p => p.id === e.id); if (!p) return null;
    if (p.clip && e.frames > 1) return Array.from({ length: p.clip.frames }, (_, i) => K + p.clip.source.replace('%d', i));
    return [K + p.source];
  }
  /** Seat raw kit props like the kit builder: move the ink bottom onto the cell bottom (same shift for every frame). */
  function seatFrames(frames, w, h) {
    const box = inkBox([frames[0]], w, h); if (!box || box[3] === h) return;
    const dy = h - box[3];
    for (const px of frames) { px.copyWithin(dy * w * 4, 0, (h - dy) * w * 4); px.fill(0, 0, dy * w * 4); }
  }

  /** Trim every sprite to its ink, pack frames into size-class arrays, reduce mini-sprites and keep icons. A generator
   *  for sliced() (Stage B, W1 lift step #4): one step per sprite, then one per mip level upload, so a step holds at
   *  most one sprite's trim and mini or one level's reduce + bleed + upload. The texels, their order and the catalog
   *  are the same bytes as the one-task build (test: sliced and unsliced loads upload identical arrays). */
  function* buildAtlases(got) {
    const alloc = new Map();                             // "LWxLH" → [{LW, LH, frames:[], idx}]
    const place = (tw, th, n) => {
      const [LW, LH] = CLASSES.find(([W, H]) => tw <= W && th <= H) ?? [];
      if (!LW) return null;
      const k = LW + 'x' + LH; let list = alloc.get(k); if (!list) alloc.set(k, list = []);
      let a = list.find(a => a.frames.length + n <= MAX_LAYERS);
      if (!a) { a = { LW, LH, frames: [], idx: arrays.length }; arrays.push(a); list.push(a); }
      return a;
    };
    const minis = [], icons = [];
    for (const [key, e] of got) {
      const [w, h] = e.cell, box = inkBox(e.frames, w, h);
      if (!box) { missing.add(key + ' (empty)'); continue; }
      const x0 = Math.max(0, box[0] - 1), y0 = Math.max(0, box[1] - 1), x1 = Math.min(w, box[2] + 1), y1 = Math.min(h, box[3] + 1), tw = x1 - x0, th = y1 - y0;
      const a = place(tw, th, e.frames.length);
      if (!a) { missing.add(`${key} (${tw}×${th} too large)`); continue; }
      const layer0 = a.frames.length;
      for (const px of e.frames) { const t = new Uint8Array(a.LW * a.LH * 4); for (let y = 0; y < th; y++) t.set(px.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + tw) * 4), y * a.LW * 4); a.frames.push(t); }
      const ent = { key, arr: a.idx, layer0, frames: e.frames.length, LW: a.LW, LH: a.LH, ox: x0, oy: y0, tw, th, anchor: e.anchor, scale: e.scale, cell: e.cell };
      catalog.set(key, ent);
      if (!e.noMini && !key.startsWith('keep/')) {       // the MAP LOD at map-art density (PACK's plots.webp, or its runtime twin)
        let r, ax, ay, k;
        if (e.packMini) { r = e.packMini; ax = r.ax; ay = r.ay; k = e.scale / r.per; }
        // MAP LOD at map-art density; the 1-px outline ink votes at 0.35 so a 7× mini keeps its body colour and does
        // not collapse into a near-black speck (Gate A: minis worst near-black 34.6 %)
        else { const f = 1 / (e.scale * MAP_PX_PER_TILE); r = reduceMode(e.frames[0], w, h, f, undefined, undefined, 0.35); ax = e.anchor[0] / f; ay = e.anchor[1] / f; k = e.scale * f; }
        const mb = inkBox([r.px], r.w, r.h);
        if (mb && mb[2] - mb[0] <= MINI && mb[3] - mb[1] <= MINI) { ent.mini = { idx: minis.length, ox: mb[0], oy: mb[1], w: mb[2] - mb[0], h: mb[3] - mb[1], k, ax, ay }; minis.push({ r, mb }); }
        else missing.add(key + ' (mini)');
      }
      if (key.startsWith('keep/')) {                     // half-size pixel-art marker icon (plan §2.1 marker mode)
        const r = reduceMode(e.frames[0], w, h, 2), ib = inkBox([r.px], r.w, r.h);
        ent.icon = { idx: icons.length, ox: ib[0], oy: ib[1], w: ib[2] - ib[0], h: ib[3] - ib[1], ax: e.anchor[0] / 2, ay: e.anchor[1] / 2 };
        icons.push({ r, ib });
      }
      yield;
    }
    // upload
    for (const a of arrays) {
      const levels = mipsOf(a.LW, a.LH);
      a.tex = core.tex.array(a.LW, a.LH, a.frames.length, 'RGBA8', { levels, filter: 'linear' });
      for (let i = 0; i < a.frames.length; i++) {
        let l = 0;
        for (const m of mipLevels(a.frames[i], a.LW, a.LH, levels)) { core.tex.layer(a.tex, i, { data: m.px, w: m.w, h: m.h }, null, l++); yield; }
        a.frames[i] = null;                              // uploaded: its CPU copy can go
      }
      st.layers += a.frames.length; a.frames = null;
    }
    // minis and icons: the array is made (and owned, so a dispose mid-load frees it) before its layers are filled
    const small = (n, S) => ({ tex: core.tex.array(S, S, Math.max(1, n), 'RGBA8', { levels: mipsOf(S, S), filter: 'linear' }), LW: S, LH: S, idx: -1 });
    function* fillSmall(arr, list, get) {
      const S = arr.LW;
      for (let i = 0; i < list.length; i++) {
        const m = list[i], [x0, y0, x1, y1] = get(m), t = new Uint8Array(S * S * 4);
        for (let y = 0; y < y1 - y0; y++) t.set(m.r.px.subarray(((y0 + y) * m.r.w + x0) * 4, ((y0 + y) * m.r.w + x1) * 4), y * S * 4);
        let l = 0;
        for (const mm of mipLevels(t, S, S, mipsOf(S, S))) core.tex.layer(arr.tex, i, { data: mm.px, w: mm.w, h: mm.h }, null, l++);
        yield;                                           // a 16² or 72² mini/icon: its whole chain is one step
      }
    }
    miniArr = small(minis.length, MINI); yield* fillSmall(miniArr, minis, m => m.mb);
    iconArr = small(icons.length, 72); yield* fillSmall(iconArr, icons, m => m.ib);
  }

  // ================================ programs and buffers =====================================================
  function makeVao(attribs) {
    const vao = gl.createVertexArray(), buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, core.quadBuffer); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const stride = attribs * 16;
    for (let i = 0; i < attribs; i++) { gl.enableVertexAttribArray(1 + i); gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, stride, i * 16); gl.vertexAttribDivisor(1 + i, 1); }
    gl.bindVertexArray(null);
    return { vao, buf, n: 0, floats: attribs * 4 };
  }
  function upload(b, data, n) { gl.bindBuffer(gl.ARRAY_BUFFER, b.buf); gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, n * b.floats), gl.DYNAMIC_DRAW); b.n = n; }
  /** The band rehearsal's own resources (REHEARSAL), made once per load right after the programs, before any art
   *  loads. It uploads 112 B of view, ≤ 128 B of instances and 40 B of placeholder texels, so the hook itself uploads nothing. */
  function makeRehearsal() {
    const ubo = gl.createBuffer(), v = new Float32Array(28); v.set(REHEARSAL.view);   // 7 × vec4 (the last: uClock, uint 0)
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferData(gl.UNIFORM_BUFFER, v, gl.STATIC_DRAW); gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    const T = REHEARSAL.tex, tex = core.tex.array(T.w, T.h, T.layers, T.format, { levels: T.levels, filter: T.filter });
    for (let i = 0; i < T.layers; i++) for (let l = 0; l < T.levels; l++) {
      const w = Math.max(1, T.w >> l), h = Math.max(1, T.h >> l);
      core.tex.layer(tex, i, { data: new Uint8Array(w * h * 4).fill(255), w, h }, null, l);
    }
    const vao = {};
    for (const [name, f] of Object.entries(REHEARSAL.inst)) { const b = vao[name] = makeVao(REHEARSAL.attribs[name]); upload(b, Float32Array.from(f), f.length / b.floats); }
    rh = { ubo, tex, vao, drawn: {}, real: {} };
  }
  function freeRehearsal() {
    if (!rh) return;
    for (const b of Object.values(rh.vao)) { gl.deleteVertexArray(b.vao); gl.deleteBuffer(b.buf); }
    gl.deleteBuffer(rh.ubo); core.tex.free(rh.tex); rh = null;
  }
  let windX = 0.12;

  // ================================ public: load / data =====================================================
  /** Run a load generator in ≤ SLICE_MS slices (LIFE's sliced(), life.js; GROUND's G3). A step that yields a promise (a
   *  pack read) gets its value back, or its rejection thrown in. → { value }, or null when a dispose or a newer load
   *  superseded it (the generator is closed). An awaited read does not restart the slice clock. */
  async function sliced(job, my) {
    let seg = performance.now(), send, err = null;
    const held = () => { const d = performance.now() - seg; if (d > st.sliceMaxMs) st.sliceMaxMs = +d.toFixed(2); };   // stats: the longest run
    for (;;) { // (stage B D1: the shared task clock, checked before EVERY step — a job started in a spent task yields at once)
      if (my !== loadGen) { job.return(); return null; }
      if (taskClock.spent()) { held(); await yieldTask(); seg = performance.now(); st.slices++; if (my !== loadGen) { job.return(); return null; } }
      const u0 = performance.now(), r = err ? job.throw(err) : job.next(send), du = performance.now() - u0; send = undefined; err = null;
      if (du > st.unitMaxMs) st.unitMaxMs = +du.toFixed(2);   // the slowest single step (QA: work vs preemption)
      if (r.done) { held(); return { value: r.value }; }
      if (typeof r.value?.then === 'function') { held(); try { send = await r.value; } catch (e) { err = e ?? Error('pack read failed'); } seg = performance.now(); }
    }
  }
  async function load(p, shared) {
    const t0 = performance.now();
    dispose(); const my = ++loadGen; pack = p; realmId = p.id; ready = false; why = 'loading'; st.slices = 0; st.sliceMaxMs = 0; st.unitMaxMs = 0;
    ({ cols, rows } = p.meta.grid);
    const w = p.meta?.wind?.artPxPerSec; windX = w ? clamp(w[0] / 16, -0.3, 0.3) : 0.12;   // tiles of drift per 2 s rise
    const dp = p.first.deeds, stride = dp.length >= cols * rows * 4 ? 4 : 1;
    deeds = new Uint8Array(cols * rows); for (let i = 0; i < cols * rows; i++) deeds[i] = dp[i * stride];
    stateData = new Uint8Array(cols * rows * 4);
    stateTex = core.tex.data(cols, rows, 'RGBA8UI', null, null, stateData);
    progs = {
      sprite: core.program('bases-sprite', { vs: SPRITE_VS, fs: SPRITE_FS }),
      dot: core.program('bases-dot', { vs: DOT_VS, fs: DOT_FS }),
      fx: core.program('bases-fx', { vs: FX_VS, fs: FX_FS }),
      shield: core.program('bases-shield', { vs: SHIELD_VS, fs: SHIELD_FS }),
      field: core.program('bases-field', { vs: FIELD_VS, fs: FIELD_FS }),
    };
    makeRehearsal();   // before any await: the band rehearsal runs at FAR while the art is still loading (W1 B1)
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255), soil = DECOR_LAYOUT.soil[realmId];
    const track = DECOR_LAYOUT.track[realmId], path = (track && p.meta?.palette?.kit?.ground?.[track]) ?? p.meta?.palette?.road ?? soil?.path;
    soilRGB = soil ? [...hex(soil.field), ...hex(soil.pen), ...hex(path)] : null;
    const acc = ACCENT[realmId]; accentRGB = acc ? hex(acc) : [0.5, 0.89, 1.0];
    if (!KIT_DRESSING[realmId]) { why = `no kit dressing for ${realmId}`; return; }
    // Stage B (W1 lift step #4): art reads, crops, atlases and road tiles as ONE generator in ≤ SLICE_MS slices. While
    // it runs, the sampling programs' rehearsal draws placeholders and asks to be called again (rehearse()).
    loading = true;
    try {
      const done = await sliced((function* () { const got = yield* gatherSources(shared); yield* buildAtlases(got); yield* loadRoadTiles(p); })(), my);
      if (!done || my !== loadGen) return;               // superseded: the dispose that did it freed what the load made
    } finally { if (my === loadGen) loading = false; }
    for (const a of [...arrays, miniArr, iconArr]) a.vao = makeVao(4);
    dotBuf = makeVao(3); fxBuf = makeVao(3); shieldBuf = makeVao(2); fieldBuf = makeVao(2);
    pathsDirty = true; pathsJob = null;
    frameLists = null; instCache.clear();
    ready = true; why = missing.size ? `ready (${missing.size} missing)` : 'ready';
    st.loadMs = Math.round(performance.now() - t0);
    writeState(); core.invalidate();
  }
  function setBases(list) {
    bases = list ?? []; byId = new Map(bases.map(b => [String(b.id), b])); instCache.clear(); geomVersion++; pathsDirty = true; writeState();
  }
  /** The paths between neighbouring kingdoms (decor.basePathsJob), as a job under the frame budget (P0 fix pass): the
   *  network, then each link bucketed under every deed its bounding box touches (a frame only visits the links in view). */
  function startPaths() {
    pathsDirty = false;
    pathsJob = { gen: basePathsJob(bases), res: null, i: 0, buckets: new Map(), linksOf: new Map(), ms: 0, slices: 0, sliceMaxMs: 0 };
  }
  function pumpPaths() {
    const J = pathsJob, t0 = performance.now();
    while (pathsJob === J && work.more()) {
      work.spend();
      const u0 = performance.now(), ph = !J.res ? 'net' : J.i < J.res.links.length ? 'bucket' : 'finish';
      if (!J.res) { const r = J.gen.next(); if (r.done) J.res = r.value; }
      else if (J.i < J.res.links.length) bucketLink(J, J.i++);
      else finishPaths(J);
      const du = performance.now() - u0; if (du > (J.unit?.ms ?? 0)) J.unit = { ms: +du.toFixed(2), ph };   // the slowest single unit (QA: work vs preemption)
    }
    const dt = performance.now() - t0; J.ms += dt; J.slices++; J.sliceMaxMs = Math.max(J.sliceMaxMs, dt);
    st.pathsJob = { done: pathsJob !== J, ms: +J.ms.toFixed(1), slices: J.slices, sliceMaxMs: +J.sliceMaxMs.toFixed(2), unitMax: J.unit ?? null };
    st.pathsMs = Math.round(J.ms);
  }
  function bucketLink(J, i) {
    const l = J.res.links[i];
    for (const id of [l.a, l.b]) { let v = J.linksOf.get(id); if (!v) J.linksOf.set(id, v = []); v.push(i); }
    const xs = l.pts.map(p => p[0]), ys = l.pts.map(p => p[1]);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.floor(Math.max(...ys)); y++) for (let x = Math.floor(Math.min(...xs)); x <= Math.floor(Math.max(...xs)); x++) {
      const k = y * 65536 + x; let b = J.buckets.get(k); if (!b) J.buckets.set(k, b = []); b.push(i);
    }
  }
  function finishPaths(J) {
    const prevSides = paths.sides;
    pathsJob = null; paths = J.res; linkBuckets = J.buckets; linksOf = J.linksOf;
    linkStamp = new Int32Array(paths.links.length);
    st.paths = paths.segments.length; st.links = paths.links.length;
    settleOver();
    // the per-base caches depend on the laned sides only: keep them when a rebuild left the sides alone
    const same = prevSides.size === paths.sides.size && [...paths.sides].every(([id, sd]) => { const o = prevSides.get(id); return o && o.size === sd.size && [...sd].every(x => o.has(x)); });
    if (!same) instCache.clear();
    lastKey = ''; core.invalidate();
  }
  /** Terrain for settling links: GROUND's CPU class fields (the same classAt the lattice resolves) over this module's
   *  base state, with GROUND's own bent rivers and land bridges for it (P0 fix pass: without them classify recomputed
   *  both for the whole realm inside the first settle, a 225–280 ms frame). Until GROUND has them, links wait. */
  function settleOver() {
    const D = terrainInputs();
    clsMemo = new Map(); settled = new Array(paths.links.length);
    const cstate = { cols, rows, data: stateData, ...(D?.rivers ? { rivers: D.rivers } : {}), ...(D?.bridges ? { bridges: D.bridges } : {}) };   // ONE state object: classify caches its plot index per state
    clsAt = D && stateData ? (x, y) => { const k = y * 1e6 + x; let c = clsMemo.get(k); if (c === undefined) { c = classAt(D.fields, D.lines, cstate, [x, y], D.cfg); clsMemo.set(k, c); } return c; } : null;
    terrainPending = !clsAt;                               // GROUND not ready: no paths yet, they settle when it lands
    st.terrain = D ? { rivers: !!D.rivers, bridges: !!D.bridges, polys: D.lines?.polys?.length ?? 0 } : null;
    st.linksSettled = 0; st.linksDropped = 0; st.bridges = 0; st.crossings = [];
  }
  /** GROUND's class inputs once its rivers are bent and bridges built for the current base state (debug() lists
   *  mapTables right after both; a formal classState() is trusted as complete), else null. */
  function terrainInputs() {
    const D = classInputs();
    if (!D?.fields) return null;
    if ('mapTables' in D && !D.mapTables) return null;
    return D;
  }
  /** GROUND's CPU class inputs: the formal contracts.GROUND_API classState() (fix iteration 2), else the older debug(). */
  const classInputs = () => ground?.classState?.() ?? ground?.debug?.() ?? null;
  /** One link over terrain → { inst: Float32Array path cells (8 floats each), bridges: [{key, tx, ty, z}] } or null.
   *  Only called once GROUND's class fields are in (clsAt): the path shader reads no terrain per pixel (P0), so an
   *  unsettled link is never drawn — it would run straight over water. */
  function settleLink(i) {
    const l = paths.links[i];
    const hasBridge = !!(bridgePiece(realmId, 'ew') && bridgePiece(realmId, 'ns'));
    const t0 = performance.now(), m0 = clsMemo.size, r = settlePath(l.pts, clsAt, { bridge: hasBridge });
    const dt = performance.now() - t0;
    if (dt > (st.settleMaxMs ?? 0)) st.settleMax = { ms: +dt.toFixed(1), tiles: clsMemo.size - m0, nth: st.linksSettled };   // a slow settle: its class reads (misses)
    st.linksSettled++; st.settleMs = +((st.settleMs ?? 0) + dt).toFixed(1); st.settleMaxMs = +Math.max(st.settleMaxMs ?? 0, dt).toFixed(1); st.clsTiles = clsMemo.size;
    if (!r) { st.linksDropped++; dropSides(i); return null; }
    const bridges = [];
    for (const cr of r.crossings) if ((st.crossings ??= []).length < 4) st.crossings.push({ kind: cr.kind, x: +((cr.from[0] + cr.to[0]) / 2 / TILES).toFixed(3), y: +((cr.from[1] + cr.to[1]) / 2 / TILES).toFixed(3) });   // QA targets
    for (const cr of r.crossings) if (cr.kind === 'bridge') {
      const piece = bridgePiece(realmId, cr.axis);
      for (const seat of bridgeSeats(cr, piece)) bridges.push({ key: piece.key, anchor: piece.anchor, scale: piece.scale, x: seat.tx / TILES, y: seat.ty / TILES, z: seat.z / TILES });
      st.bridges++;
    }
    return { inst: Float32Array.from(r.segments.flatMap(sg => [sg.a[0], sg.a[1], sg.b[0], sg.b[1], 3, sg.bridge ? 2 : sg.ford ? 1 : 0, l.seed, 1])), bridges };
  }
  /** A link dropped over terrain (open water, too wide to bridge) takes its lanes with it (fix iteration 2, QA 3: "some
   *  stubs end in open grass"): each end's side stays laned only while another live link leaves by it; the base's
   *  cached decor is rebuilt without that lane. Unsettled links count as live (they settle as they reach the view). */
  function dropSides(i) {
    const l = paths.links[i];
    for (const [id, sd] of [[l.a, l.sa], [l.b, l.sb]]) {
      const live = (linksOf.get(id) ?? []).some(j => j !== i && settled[j] !== null && (paths.links[j].a === id ? paths.links[j].sa : paths.links[j].sb) === sd);
      if (live || !paths.sides.get(id)?.delete(sd)) continue;
      const b = byId.get(id); if (b) instCache.delete(b.id);
      sidesChanged = true;
    }
  }
  function setFilter(pred) { filterPred = pred ?? null; writeState(); }
  function select(id) { selectedId = id == null ? null : String(id); writeState(); }
  function hover(id) { hoveredId = id == null ? null : String(id); writeState(); }
  const passes = b => !filterPred || filterPred(b);
  /** Base-state texture (plan §6.1): r kind, g flags, b claim tiles, a level. */
  function writeState() {
    if (!stateData || !deeds) return;
    const mine = bases.find(b => b.mine);
    for (let i = 0; i < cols * rows; i++) {
      const v = deeds[i], k = i * 4;
      stateData[k] = v >= DEED_PX.thisRealm - 55 ? KIND.open : v >= DEED_PX.otherRealm - 40 && v > 0 ? KIND.otherRealm : KIND.none;
      stateData[k + 1] = 0; stateData[k + 2] = 0; stateData[k + 3] = 0;
    }
    for (const b of bases) {
      const k = (b.y * cols + b.x) * 4; if (b.x < 0 || b.y < 0 || b.x >= cols || b.y >= rows) continue;
      let f = FLAG.occupied;
      if (b.mine) f |= FLAG.mine; if (b.shield === true) f |= FLAG.shield; if (b.attackable) f |= FLAG.attackable;
      if (passes(b)) f |= FLAG.filteredIn; if (String(b.id) === selectedId) f |= FLAG.selected;
      if (mine && b.clan && b.clan === mine.clan) f |= FLAG.clan; if (String(b.id) === hoveredId) f |= FLAG.hovered;
      stateData[k + 1] = f; stateData[k + 2] = plotRule(b.level).claim; stateData[k + 3] = b.level;
    }
    if (stateTex) core.tex.update(stateTex, stateData);
    stateVersion++;
    ground?.setBaseState?.(stateTex, geomVersion, stateData);   // the CPU bytes let GROUND re-resolve only changed deeds
    frameLists = null; core.invalidate();
  }

  // ================================ per-base static instances =================================================
  const hash01 = (a, b) => hash2(a, b) / 4294967296;
  /** Everything about a base that does not depend on the camera, as ready-to-copy Float32Arrays (16 floats per
   *  instance): TRUE sprites per texture array, MAP mini-sprites, plus its emitters. Cached per base. */
  function baseStatic(b) {
    let c = instCache.get(b.id);
    if (c && c.level === b.level) return c;
    st.builds++;
    const linked = paths.sides.get(String(b.id)) ?? new Set();   // a lane leaves by every side a path to a neighbour takes
    const seed = seedOf(b.id), decor = composeBaseDecor({ level: b.level, realmId, seed, gates: [...linked] });
    const o = plotOffset(b.x, b.y, b.level), ox = o.dx, oy = o.dy;   // T3: the plot sits off its deed centre (visual only)
    const trues = new Map(), mini = [];
    c = { level: b.level, decor, trueByArr: new Map(), mini: null, smoke: [], glow: [], keepEm: [], ground: null, ox, oy };
    let i = 0;
    // TRUE: every decor sprite, wall and plot-edge piece. MAP minis: decor sprites only — walls are the yard
    // layer and the edge is GROUND's procedural line at MAP (plan §6.2).
    const edgeList = catalog.has('edge:post') ? edgeAutotileSprites(decor) : edgeSprites(decor);
    for (const s of [...decor.sprites, ...wallSprites(decor), ...edgeList]) {
      const cat = catalog.get(s.key), h = hash01(seed, i++);
      if (!cat) continue;
      const k = s.scale, qx0 = (cat.ox - s.anchor[0]) * k, qy0 = (cat.oy - s.anchor[1]) * k;
      let l = trues.get(cat.arr); if (!l) trues.set(cat.arr, l = []);
      l.push(b.x + (s.tx + ox) / TILES, b.y + (s.ty + oy) / TILES, b.y + (s.z + oy) / TILES, h, qx0, qy0, qx0 + cat.tw * k, qy0 + cat.th * k,
        cat.layer0, s.clip ? cat.frames : 1, s.clip?.ms ?? 0, s.phase ?? 0, cat.tw / cat.LW, cat.th / cat.LH, 0, 0);
      // MAP minis: hedges and fences too (the patches read the same at MAP); not the small wild scatter, rocks and
      // field filler — at 4.6 art px per tile they are single dark specks (they dissolve in as TRUE sprites instead).
      // Fix iteration 2 (QA 4): walls too (the level's wall rings read at MAP and dissolve into the TRUE walls in
      // place), flagged never-hidden; buildings flagged to grow to the 6-px floor instead of vanishing.
      if (cat.mini && !SPECK_ROLES.has(s.role)) {
        const m = cat.mini, mk = m.k, mx = (m.ox - m.ax) * mk, my = (m.oy - m.ay) * mk, flag = s.kind === 'wall' ? 4 : s.kind === 'building' ? 2 : 0;
        mini.push(b.x + (s.tx + ox) / TILES, b.y + (s.ty + oy) / TILES, b.y + (s.z + oy) / TILES, h, mx, my, mx + m.w * mk, my + m.h * mk,
          m.idx, 1, 0, 0, m.w / MINI, m.h / MINI, 1, flag);
      }
    }
    for (const [ai, l] of trues) c.trueByArr.set(ai, Float32Array.from(l));
    c.mini = Float32Array.from(mini);
    const smoke = catalog.get('kit:' + smokeIdOf(realmId));
    for (const e of decor.emitters) {
      if (e.kind === 'glow') c.glow.push({ x: b.x + (e.tx + ox) / TILES, y: b.y + (e.ty + oy) / TILES, foot: b.y + (e.ty + oy + 0.6) / TILES, r: e.r, a: e.a, h: hash01(seed, i++) });
      else if (e.kind === 'smoke' && smoke) (e.attach === 'keep' ? c.keepEm : c.smoke).push({ ...e, ...(e.attach === 'keep' ? {} : { tx: e.tx + ox, ty: e.ty + oy }), h: hash01(seed, i++) });
      else if (e.kind === 'pennant') c.keepEm.push({ ...e, h: hash01(seed, i++) });
    }
    // tended ground: field soil, pen / camp earth, and the gate lanes that lead somewhere (south always; any side
    // a path to a neighbour leaves from). One cell instance per tile; the mask marks same-ground neighbours.
    const cells = new Map(), put = (x, y, k, t, soft = false) => cells.set(y * TILES + x, [x, y, k, t, soft]);
    for (const cells of Object.values(decor.lanes)) for (const [x, y] of cells) put(x, y, 2, 0);   // the linked sides' lanes
    // soft = an open field or the camp/farmyard earth: its concave corners are filleted (below); hedged fields and pens
    // keep the tile outline their hedge/fence loop follows
    for (const g of decor.ground) put(g.x, g.y, g.k, g.t, (g.k === 0 && !decor.patches[g.p]?.hedged) || (g.k === 1 && g.t === 1));
    // fix iteration 2 (T3, "stair-step patches"): every concave corner of a soft patch gets a fillet in the empty cell
    // beside it (mask bits 16 NE, 32 SE, 64 SW, 128 NW: the two same-patch neighbours meeting there), so a staircase of
    // tiles reads as one smooth organic outline at TRUE; the fillet quad is widened 0.5 t to reach the neighbours' insets
    const fil = new Map(), soft = kk => cells.get(kk)?.[4] ? cells.get(kk) : null;
    for (const [key, [x, y, k, t, sf]] of cells) {
      if (!sf) continue;
      for (const e of [key - TILES, key + 1, key + TILES, key - 1]) {
        if (cells.has(e) || fil.has(e)) continue;
        const ex = e % TILES, ey = (e / TILES) | 0, at = kk => { const c2 = soft(kk); return c2 && c2[2] === k && c2[3] === t; };
        const m = (at(e - TILES) && at(e + 1) ? 16 : 0) | (at(e + TILES) && at(e + 1) ? 32 : 0) | (at(e + TILES) && at(e - 1) ? 64 : 0) | (at(e - TILES) && at(e - 1) ? 128 : 0);
        if (m) fil.set(e, [ex, ey, k, t, m]);
      }
    }
    const gc = new Float32Array((cells.size + fil.size) * 8), sd = hash01(seed, 77), wd = 0.5 / TILES; let n = 0;
    for (const [key, [x, y, k, t]] of cells) {
      const same = kk => cells.get(kk)?.[2] === k, m = (same(key - TILES) ? 1 : 0) | (same(key + 1) ? 2 : 0) | (same(key + TILES) ? 4 : 0) | (same(key - 1) ? 8 : 0);
      const x0 = b.x + (x + ox) / TILES, y0 = b.y + (y + oy) / TILES;
      gc.set([x0, y0, x0 + 1 / TILES, y0 + 1 / TILES, k + 4 * t, m, sd, 1], n); n += 8;
    }
    for (const [x, y, k, t, m] of fil.values()) {        // after the cells: a fillet covers its neighbours' rim at the corner
      const x0 = b.x + (x + ox) / TILES, y0 = b.y + (y + oy) / TILES;
      gc.set([x0 - wd, y0 - wd, x0 + 1 / TILES + wd, y0 + 1 / TILES + wd, k + 4 * t, m, sd, 1], n); n += 8;
    }
    c.ground = gc;
    instCache.set(b.id, c); return c;
  }
  // ================================ per-frame lists ============================================================
  /** A growable Float32Array list reused across frames (no per-frame garbage). */
  const FL = () => ({ f: new Float32Array(4096), n: 0,
    grow(m) { if (this.n + m > this.f.length) { const g = new Float32Array(Math.max(this.f.length * 2, this.n + m)); g.set(this.f.subarray(0, this.n)); this.f = g; } },
    add(arr) { this.grow(arr.length); this.f.set(arr, this.n); this.n += arr.length; },
    push(...v) { this.grow(v.length); for (let i = 0; i < v.length; i++) this.f[this.n++] = v[i]; } });
  const lists = { dots: FL(), mini: FL(), icons: FL(), fx: FL(), glow: FL(), sprites: new Map(), smoke: new Map(), select: FL(), shield: FL(), ground: FL() };
  const listOf = (map, k) => { let l = map.get(k); if (!l) map.set(k, l = FL()); return l; };
  let stateVersion = 0, lastKey = '', sidesChanged = false;
  const colorOf = b => (b.mine ? GOLD : HERALDIC[hash2(seedOf(b.id), 99) % HERALDIC.length]);
  function update(view) {
    const tU = performance.now();
    try { updateInner(view); } finally { updWin.push(performance.now() - tU); if (updWin.length > 240) updWin.shift(); }
  }
  function updateInner(view) {
    lastView = view;
    if (!ready || !bases.length) { keepRects = []; domeHits = []; frameLists = null; return; }
    const s = view.s, d = view.d, dpr = view.dpr, pathBand = d >= BANDS.impostor[0] - 50;
    work.begin();                                          // P0: paths job + decor caches + link settles share ONE budget
    if (pathsDirty) startPaths();                          // from FAR on, sliced (it used to be one 230–290 ms frame at d 150)
    if (pathsJob) { pumpPaths(); if (pathsJob && pathBand) core.invalidate(); }   // needed now: keep frames coming until done
    if (terrainPending && !pathsJob && terrainInputs()) { settleOver(); lastKey = ''; }   // GROUND's terrain arrived (the network itself does not depend on it)
    const key = `${view.x.toFixed(6)},${view.y.toFixed(6)},${s.toFixed(5)},${dpr},${view.W},${view.H},${stateVersion},${view.reducedMotion}`;
    if (key === lastKey && frameLists) return;           // idle animation frames: only the clock moved
    lastKey = key;
    const t0 = performance.now();
    const trueW = clamp((d - BANDS.trueStart) / (BANDS.trueFull - BANDS.trueStart), 0, 1);
    const r = view.rect, pad = 1;
    const vis = bases.filter(b => b.x >= r.x0 - pad && b.x < r.x1 + pad && b.y >= r.y0 - pad && b.y < r.y1 + pad);
    st.visible = vis.length;
    for (const l of [lists.dots, lists.mini, lists.icons, lists.fx, lists.glow, lists.select, lists.shield, lists.ground, ...lists.sprites.values(), ...lists.smoke.values()]) l.n = 0;
    const shields = [];
    keepRects = []; domeHits = [];
    const k = s / TILES;                                   // CSS px per tile
    const toCss = (x, y) => [(x - view.x) * s + view.W / 2, (y - view.y) * s + view.H / 2];
    const modeOf = b => baseMode(s, d, hash01(seedOf(b.id), 7), hash01(seedOf(b.id), 8));
    const shieldLod = d >= BANDS.trueFull ? 2 : s >= BANDS.domeSilhouette ? 1 : 0;
    const seatY = KEEP_FOOTPRINT[1] / 2 + PLOT_CENTRE;       // 50: the keep footprint's south edge (deed-local)
    let nKeep = 0, nIcon = 0, keepVis = false, nMini = 0, nTrue = 0, pending = false, buildMs = 0, hidden = 0;
    const lanesKnown = !pathsJob && !pathsDirty;            // a base's decor lanes follow its links: build it once they exist
    for (const b of vis) {
      const sel = String(b.id) === selectedId;
      if (!sel && !passes(b)) { hidden++; continue; }       // D-191: a filtered-out kingdom is hidden, not dimmed; the selected one always draws
      const o = plotOffset(b.x, b.y, b.level);             // T3: every plot at its hashed offset (visual only)
      const cx = b.x + (PLOT_CENTRE + o.dx) / TILES, cy = b.y + (seatY + o.dy) / TILES, pcx = cx, pcy = b.y + (PLOT_CENTRE + o.dy) / TILES;
      const mode = modeOf(b);
      if (mode === 'dot') {                                 // FAR: occupancy dot (+ halo)
        const size = b.mine ? clamp(s * 0.45, 4, 6) : clamp(s * 0.25, 2, 4);   // CSS px: a quiet grain at the far overview
        const c = b.mine ? GOLD : [0.96, 0.95, 0.9];
        lists.dots.push(pcx, pcy, size, 0, c[0], c[1], c[2], b.shield === true ? 1 : 0, b.mine ? 1 : 0.85, 0, 0, 0);
        continue;
      }
      const L0 = b.level, cat = catalog.get(`keep/l${L0}`);
      if (!cat) continue;
      const live = mode === 'keep';
      let footY = cy;                                       // the drawn keep's foot: the seat, or the marker icon's anchor
      if (!live && markers) {                               // web port P8: the dot and the icon's tap rect, no icon art
        const sd = seedOf(b.id), ic = cat.icon, look = iconLook(L0, sd), css = look.css, kk = css / ic.w / k;
        const qx0 = (ic.ox - ic.ax) * kk, qy0 = (ic.oy - ic.ay) * kk, iy = b.y + (iconAnchorY(d, qy0 + ic.h * kk / 2) + o.dy) / TILES;
        const size = b.mine ? clamp(s * 0.45, 4, 6) : clamp(s * 0.25, 2, 4), c = b.mine ? GOLD : [0.96, 0.95, 0.9];
        lists.dots.push(pcx, pcy, size, 0, c[0], c[1], c[2], b.shield === true ? 1 : 0, b.mine ? 1 : 0.85, 0, 0, 0);
        const [sx, sy] = toCss(cx, iy), [, dy] = toCss(pcx, pcy);
        keepRects.push({ b, x0: sx + qx0 * k, x1: sx + (qx0 + ic.w * kk) * k, y0: sy + qy0 * k, y1: sy + (qy0 + ic.h * kk) * k, depth: iy, tagY: dy - size - 2 });
        footY = pcy;
      } else if (!live) {                                   // marker icon: ≥ 28 CSS px wide (by level + seed), centred on its plot
        const sd = seedOf(b.id), ic = cat.icon, look = iconLook(L0, sd), css = look.css, kk = css / ic.w / k;   // tiles per icon px
        const qx0 = (ic.ox - ic.ax) * kk, qy0 = (ic.oy - ic.ay) * kk;
        const cy = footY = b.y + (iconAnchorY(d, qy0 + ic.h * kk / 2) + o.dy) / TILES;   // fix pass: the icon group's anchor (iconAnchorY)
        lists.icons.push(cx, cy, cy, hash01(sd, 3), qx0, qy0, qx0 + ic.w * kk, qy0 + ic.h * kk, ic.idx, 1, 0, 0, ic.w / 72, ic.h / 72, 3, 0);
        const [sx, sy] = toCss(cx, cy); keepRects.push({ b, x0: sx + qx0 * k, x1: sx + (qx0 + ic.w * kk) * k, y0: sy + qy0 * k, y1: sy + (qy0 + ic.h * kk) * k, depth: cy });
        nIcon++;
        // heraldic banners on the icon's spires (the base's own colour, gold for yours): one on a seeded spire, two from L12
        const tips = KEEP_TIPS[L0 - 1], col = colorOf(b), pw = Math.max(6, css * 0.26) / k, ph = pw * 4 / 6;
        for (const ti of look.tips) {
          const [tx, ty] = tips[ti];
          lists.fx.push(cx + (tx / 2 - ic.ax) * kk / TILES, cy + (ty / 2 - ic.ay) * kk / TILES, cy + 0.0002 / TILES, hash01(sd, 13 + ti), pw, ph, 1, 0, col[0], col[1], col[2], 1);
        }
        // L12+: flanking defence towers behind the keep — count by level, type, side, height and set-back by seed
        const nT = look.towers, tc = nT ? catalog.get(look.tower) : null;
        if (tc) {
          const icW = ic.w * kk, icH = ic.h * kk, first = look.first;
          for (let j = 0; j < nT; j++) {
            // the keep icon's ink spans its whole width: a tower stands clear of it (0.56–0.7 of the icon width out), a
            // third one rises behind the keep's centre; heights 0.58–0.78 of the icon (the keep stays the tallest)
            const kt = icH * (j === 2 ? 0.7 : 0.58 + 0.2 * hash01(sd, 17 + j)) / tc.th;
            const dx = j === 2 ? (hash01(sd, 20) - 0.5) * icW * 0.3 : (j === 0 ? first : -first) * icW * (0.56 + 0.14 * hash01(sd, 18 + j));
            const dy = j === 2 ? -icH * 0.45 : -icH * (0.04 + 0.1 * hash01(sd, 19 + j)), x = cx + dx / TILES, y = cy + dy / TILES;   // seats in deeds
            const tq0 = (tc.ox - tc.anchor[0]) * kt, tq1 = (tc.oy - tc.anchor[1]) * kt;
            listOf(lists.sprites, tc.arr).push(x, y, y, hash01(sd, 21 + j), tq0, tq1, tq0 + tc.tw * kt, tq1 + tc.th * kt, tc.layer0, 1, 0, 0, tc.tw / tc.LW, tc.th / tc.LH, 3, 0);
          }
        }
      } else {                                              // live keep at true × keepScale (plan §6.7)
        const sc = keepScale(L0, d), kk = cat.scale * sc, qx0 = (cat.ox - cat.anchor[0]) * kk, qy0 = (cat.oy - cat.anchor[1]) * kk;
        listOf(lists.sprites, cat.arr).push(cx, cy, cy, hash01(seedOf(b.id), 4), qx0, qy0, qx0 + cat.tw * kk, qy0 + cat.th * kk, cat.layer0, cat.frames, 83, hash2(seedOf(b.id), 5) % 3, cat.tw / cat.LW, cat.th / cat.LH, 2, 0);
        const [sx, sy] = toCss(cx, cy); keepRects.push({ b, x0: sx + qx0 * k, x1: sx + (qx0 + cat.tw * kk) * k, y0: sy + qy0 * k, y1: sy + (qy0 + cat.th * kk) * k, depth: cy });
        nKeep++; keepVis = true;
        const cached = instCache.get(b.id), fresh = cached && cached.level === b.level;
        // new caches under the frame budget; a base still waiting keeps its keep, dome and selection ring meanwhile
        if (!fresh && !(lanesKnown && work.more())) pending = true;
        else {
          if (!fresh) work.spend();
          const tB = performance.now(), st0 = baseStatic(b); buildMs += performance.now() - tB;
          if (trueW < 1) { lists.mini.add(st0.mini); nMini += st0.mini.length / 16; }
          if (trueW > 0) for (const [ai, f] of st0.trueByArr) { listOf(lists.sprites, ai).add(f); nTrue += f.length / 16; }
          const keepPx = cat.tw * kk * k * dpr;               // keep-attached emitters scale about the keep seat
          for (const e of st0.keepEm) {
            const ex = cx + (e.tx - PLOT_CENTRE) * sc / TILES, ey = cy + (e.ty - seatY) * sc / TILES;
            if (e.kind === 'pennant' && keepPx >= 20) {
              const pw = Math.max(6 * cat.scale * sc, 5 / k / dpr), ph = pw * 4 / 6, col = colorOf(b);
              lists.fx.push(ex, ey, cy + 0.0001 / TILES, e.h, pw, ph, 1, 0, col[0], col[1], col[2], 1);
            } else if (e.kind === 'smoke' && s >= BANDS.smoke) pushSmoke(ex, ey, cy, e.h);
          }
          if (s >= BANDS.smoke) for (const e of st0.smoke) pushSmoke(b.x + e.tx / TILES, b.y + e.ty / TILES, b.y + (e.ty + 1) / TILES, e.h);
          if (trueW > 0) for (const g of st0.glow) lists.glow.push(g.x, g.y, g.foot, g.h, g.r * 2, g.r * 2, 0, 0.05, 1.0, 0.72, 0.35, g.a * trueW);
          lists.ground.add(st0.ground);
        }
      }
      if (b.shield === true) {                              // D-181 dome (a hidden kingdom never gets here, D-191)
        const S = plotRule(L0).claim, rx = S / 2 + 2;
        shields.push({ b, dist: Math.hypot(pcx - view.x, pcy - view.y), inst: [pcx, pcy, rx, hash01(seedOf(b.id), 6), (b.mine ? 1 : 0) | (sel ? 2 : 0), pcy + (S / 2) / TILES, 0, 0] });
        const [sx, sy] = toCss(pcx, pcy); domeHits.push({ b, sx, sy, rx: rx * k, ry: rx * 0.55 * k });
      }
      if (sel && s >= BANDS.uiDots) {
        const R = markers && !live ? 0.6 : (cat.tw * cat.scale * (live ? keepScale(L0, d) : 1)) * 0.75 + 0.6; // P8: ring the dot
        lists.select.push(cx, footY, R, 0, 2, footY, R, 0);
      }
    }
    // paths between kingdoms: from the impostor band on, culled to the view
    if (d >= BANDS.impostor[0] - 50 && linkBuckets.size && clsAt) {   // no terrain yet: no paths (they settle when it lands)
      frameNo++;
      for (let y = Math.floor(r.y0) - 1; y <= Math.floor(r.y1) + 1; y++) for (let x = Math.floor(r.x0) - 1; x <= Math.floor(r.x1) + 1; x++) {
        for (const i of linkBuckets.get(y * 65536 + x) ?? []) {
          if (linkStamp[i] === frameNo) continue;
          linkStamp[i] = frameNo;
          if (settled[i] === undefined) { if (!work.more()) { pending = true; continue; } work.spend(); settled[i] = settleLink(i); }
          const P = settled[i]; if (!P) continue;
          lists.ground.add(P.inst);
          for (const br of P.bridges) {                   // the crossing's kit bridge pieces: TRUE sprite + MAP mini, like decor
            const cat = catalog.get(br.key); if (!cat) continue;
            const kk = br.scale, qx0 = (cat.ox - br.anchor[0]) * kk, qy0 = (cat.oy - br.anchor[1]) * kk, h = hash01(i, br.x * 977 + br.y);
            if (trueW > 0) listOf(lists.sprites, cat.arr).push(br.x, br.y, br.z, h, qx0, qy0, qx0 + cat.tw * kk, qy0 + cat.th * kk, cat.layer0, 1, 0, 0, cat.tw / cat.LW, cat.th / cat.LH, 0, 0);
            if (trueW < 1 && cat.mini) { const m = cat.mini, mk = m.k, mx = (m.ox - m.ax) * mk, my = (m.oy - m.ay) * mk;
              lists.mini.push(br.x, br.y, br.z, h, mx, my, mx + m.w * mk, my + m.h * mk, m.idx, 1, 0, 0, m.w / MINI, m.h / MINI, 1, 0); }
          }
        }
      }
    }
    // shield caps (plan §6.5): ≤ 40 on screen at MAP, ≤ 8 at TRUE — yours first, then the nearest to the view centre
    if (sidesChanged) { sidesChanged = false; pending = true; }   // a dropped link changed some bases' lanes: redraw them
    const shown = capShields(shields, shieldLod);
    for (const sh of shown) lists.shield.push(...sh.inst);
    st.groundCells = lists.ground.n / 8; st.fx = lists.fx.n / 12; st.domes = shown.length; st.keeps = nKeep; st.icons = nIcon; st.dots = lists.dots.n / 12; st.minis = nMini; st.trues = nTrue; st.hidden = hidden;
    frameLists = { trueW, shieldLod, keepVis, groundFade: clamp((d - (BANDS.impostor[0] - 50)) / 100, 0, 1) };
    if (pending) { lastKey = ''; core.invalidate(); }       // finish the remaining bases on the next frames
    st.updateMs = +(performance.now() - t0).toFixed(2); st.buildFrameMaxMs = +Math.max(st.buildFrameMaxMs ?? 0, buildMs).toFixed(1);
    // idle scheduler: what animates on screen (plan §7 cadence)
    core.animating('bases', keepVis && !view.reducedMotion ? 83 : 0);
    core.animating('shield', shown.length && !view.reducedMotion ? 50 : 0);
  }
  function pushSmoke(x, y, foot, h) {
    const cat = catalog.get('kit:' + smokeIdOf(realmId)); if (!cat) return;
    const kk = cat.scale, qx0 = (cat.ox - cat.anchor[0]) * kk, qy0 = (cat.oy - cat.anchor[1]) * kk, l = listOf(lists.smoke, cat.arr);
    for (let i = 0; i < 2; i++) l.push(x, y, foot, h, qx0, qy0, qx0 + cat.tw * kk, qy0 + cat.th * kk, cat.layer0, cat.frames, 260, (h * 7 + i * 0.5) % 1, cat.tw / cat.LW, cat.th / cat.LH, 4, 0);
  }

  // ================================ draw =======================================================================
  /** Set the GL state of BASES draw kind k (BASES_GL: the one table draw() and the band rehearsal share). */
  function glState(k) {
    const [, test, mask, blend] = BASES_GL[k];
    if (test) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); } else gl.disable(gl.DEPTH_TEST);
    gl.depthMask(mask);
    if (!blend) gl.disable(gl.BLEND); else { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, blend === 'add' ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA); }
  }
  /** The state the other lanes' passes expect after a BASES pass. */
  function restoreGL() { gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST); }
  function drawList(entries, { blend = false, shade = 0 } = {}) {
    const p = progs.sprite.use().bindView();
    gl.uniform1f(p.u('uTrueW'), frameLists.trueW); gl.uniform1f(p.u('uMinPx'), 6); gl.uniform2f(p.u('uWind'), windX, 0);
    gl.uniform1f(p.u('uBlend'), blend ? 1 : 0); gl.uniform1f(p.u('uShadeArt'), shade);
    for (const [a, l] of entries) {
      if (!l.n || !a?.tex) continue;
      upload(a.vao, l.f, l.n / 16);
      p.tex('uTex', 0, a.tex); gl.uniform2f(p.u('uLayerSize'), a.LW, a.LH);
      gl.bindVertexArray(a.vao.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, a.vao.n);
    }
    gl.bindVertexArray(null);
  }
  function drawInst(buf, l, perInst) { if (!l.n) return; upload(buf, l.f, l.n / perInst); gl.bindVertexArray(buf.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, buf.n); gl.bindVertexArray(null); }
  function draw(view, pass) {
    if (!ready || !frameLists) return;
    const F = frameLists;
    if (pass === 'shadow') {                              // tended ground: flat on the terrain, under every sprite
      if (!lists.ground.n || !soilRGB || F.groundFade <= 0) return;
      const p = progs.field.use().bindView();             // P0: no GROUND class textures here — the program reads no terrain
      gl.uniform3fv(p.u('uSoil'), soilRGB); gl.uniform1f(p.u('uArtPx'), view.d >= BANDS.trueStart ? 3136 : 448);
      p.tex('uRoad', 0, roadTex); gl.uniform1f(p.u('uRoadN'), roadN);
      gl.uniform1f(p.u('uPathHW'), 1.0); gl.uniform1f(p.u('uFade'), F.groundFade);
      glState('field');
      drawInst(fieldBuf, lists.ground, 8);
      restoreGL();
      return;
    }
    if (pass === 'shieldBack' || pass === 'shieldFront') {
      if (pass === 'shieldBack' && lists.select.n) drawShield(lists.select, 1, 0, 0);
      if (lists.shield.n) drawShield(lists.shield, 0, pass === 'shieldBack' ? 0 : 1, F.shieldLod);
      return;
    }
    if (pass === 'sprite') {
      glState('sprite');
      const shade = view.d >= BANDS.trueStart ? 3136 : 448;
      drawList([[miniArr, lists.mini]], { shade });
      drawList([[iconArr, lists.icons]]);
      drawList([...lists.sprites].map(([ai, l]) => [arrays[ai], l]), { shade });
      return;
    }
    if (pass === 'fx') {
      if (lists.smoke.size) { glState('smoke'); drawList([...lists.smoke].map(([ai, l]) => [arrays[ai], l]), { blend: true }); }
      if (lists.fx.n || lists.glow.n) {
        progs.fx.use().bindView();
        if (lists.fx.n) { glState('pennant'); drawInst(fxBuf, lists.fx, 12); }
        if (lists.glow.n) { glState('glow'); drawInst(fxBuf, lists.glow, 12); }
      }
      if (lists.dots.n) {
        progs.dot.use().bindView();
        glState('dot');
        drawInst(dotBuf, lists.dots, 12);
      }
      restoreGL();
    }
  }
  function drawShield(l, mode, passFront, lod) {
    const p = progs.shield.use().bindView();
    gl.uniform1f(p.u('uMode'), mode); gl.uniform1f(p.u('uPass'), passFront); gl.uniform1f(p.u('uDomeLod'), lod);
    gl.uniform1f(p.u('uArtPx'), (lastView?.d ?? 0) >= BANDS.trueStart ? 3136 : 448);
    gl.uniform3fv(p.u('uAccent'), accentRGB ?? [0.5, 0.89, 1.0]);
    glState(passFront ? 'shieldFront' : 'shieldBack');
    drawInst(shieldBuf, l, 8);
    restoreGL();
  }

  // ================================ band rehearsal (SHELL's hook, contracts GPU_SAFE.rehearse) ===============
  /** Draw BASES program `prog` once per GL state its real passes use (every BASES_GL entry of that program), so a band
   *  change finds its pipelines built. The first draw builds them: the first MAP frame blocked 17–36 s on SwiftShader.
   *  SHELL has bound the pass's target under a 1×1 scissor.
   *  W1 B1: this needs no art, so it runs at FAR from load. Before, it returned false until the sprite art was in, and in
   *  the product SHELL gave up after 4 tries: bases-sprite, -shield and -fx built at MAP d 150 (10.7 + 6.6 s long tasks).
   *  Each draw also SHADES the bound pixels: REHEARSAL's own view UBO and instances cover the whole viewport, and
   *  placeholder arrays of the real type sit on the samplers. The draws use only resources made at load, with no
   *  uploads here. The frame's view UBO is bound back afterwards, and every uniform set here is set again by draw().
   *  Stage B (real-texture pass): the sampling programs (sprite uTex, field uRoad) draw on the placeholders while the art
   *  loads and return false, so SHELL calls again (it retries a loading lane's falsy hook without a count, and at once
   *  when the load settles). Once the art is in they draw on every REAL array their passes sample: each sprite atlas,
   *  the minis and icons, and the road tiles. So the first real draw at a band change meets no new texture on its
   *  sampler (the W1 B1 open item: SwiftShader's first real sprite draws stayed 0.2–1.3 s after a placeholder-only
   *  rehearsal). Idempotent, no uploads; programs without samplers are complete on the first call. */
  function rehearse(prog) {
    const name = progs && rh ? Object.keys(progs).find(k => progs[k] === prog) : null;
    if (!name || !prog.ready) return false;
    const p = prog.use(), T = REHEARSAL.tex, b = rh.vao[name];
    // what each sampler is bound to: the real arrays once loaded, else the placeholder (a realm without art keeps it)
    const real = !loading && ready, texs = name === 'sprite' ? (real ? [...arrays, miniArr, iconArr].filter(a => a?.tex) : [])
      : name === 'field' ? (real && roadTex ? [{ tex: roadTex, n: roadN }] : []) : [null];
    const binds = texs.length ? texs : [{ tex: rh.tex, LW: T.w, LH: T.h, n: T.layers }];
    gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_VIEW, rh.ubo);
    let n = 0;
    try {
      if (name === 'sprite') {
        gl.uniform1f(p.u('uTrueW'), 1); gl.uniform1f(p.u('uMinPx'), 0); gl.uniform2f(p.u('uWind'), 0, 0); gl.uniform1f(p.u('uShadeArt'), 3136);
      } else if (name === 'field') {
        gl.uniform1f(p.u('uArtPx'), 3136); gl.uniform1f(p.u('uPathHW'), 1); gl.uniform1f(p.u('uFade'), 1);
      } else if (name === 'shield') {
        gl.uniform1f(p.u('uMode'), 0); gl.uniform1f(p.u('uDomeLod'), 2); gl.uniform1f(p.u('uArtPx'), 3136); gl.uniform3fv(p.u('uAccent'), accentRGB ?? [0.5, 0.89, 1.0]);
      }
      gl.bindVertexArray(b.vao);
      for (const t of binds) {
        if (name === 'sprite') { p.tex('uTex', 0, t.tex); gl.uniform2f(p.u('uLayerSize'), t.LW, t.LH); }
        if (name === 'field') { p.tex('uRoad', 0, t.tex); gl.uniform1f(p.u('uRoadN'), t.n); }
        for (const [k, s] of Object.entries(BASES_GL)) {
          if (s[0] !== name) continue;
          glState(k);
          if (name === 'sprite') gl.uniform1f(p.u('uBlend'), k === 'smoke' ? 1 : 0);
          if (name === 'shield') gl.uniform1f(p.u('uPass'), k === 'shieldFront' ? 1 : 0);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, b.n); n++;
        }
      }
    } finally { gl.bindVertexArray(null); prog.bindView(); }   // the frame's RealmView back on UBO_VIEW
    rh.drawn[name] = n; rh.real[name] = texs.length > 0 && texs[0] !== null;
    return n > 0 && !(loading && (name === 'sprite' || name === 'field'));   // a sampler on placeholders: come back
  }

  // ================================ picking and tags ============================================================
  /** Tap order (plan §6.6): keep rects (topmost = nearest the viewer), then the dome's ground ellipse. CSS px. */
  function pick(sx, sy) { return pickBase(keepRects, domeHits, sx, sy); }
  /** Tag anchors (plan §6.6): the top of the drawn keep/icon; priority selected > mine > filtered-in > level > centre. */
  function tagCandidates(view) {
    const out = [];
    for (const r of keepRects) {
      const b = r.b, sx = (r.x0 + r.x1) / 2, sy = r.tagY ?? r.y0 - 2; // (P8: a marker's tag sits on its dot)
      const pr = (String(b.id) === selectedId ? 1e9 : 0) + (b.mine ? 1e8 : 0) + (passes(b) ? 1e6 : 0) + b.level * 1e3 - Math.hypot(sx - view.W / 2, sy - view.H / 2);
      out.push({ base: b, sx, sy, priority: pr });
    }
    return out;
  }

  function dispose() {
    loadGen++; loading = false;                          // a load in flight stops at its next step (sliced)
    for (const a of arrays) if (a.tex) core.tex.free(a.tex);
    if (miniArr?.tex) core.tex.free(miniArr.tex); if (iconArr?.tex) core.tex.free(iconArr.tex);
    if (stateTex) core.tex.free(stateTex);
    if (roadTex) core.tex.free(roadTex); roadTex = null; roadN = 0;
    freeRehearsal();
    arrays.length = 0; catalog.clear(); instCache.clear(); missing.clear(); miniArr = iconArr = null; stateTex = null; ready = false; frameLists = null; pathsJob = null;
  }
  function stats() {
    const bytes = [...arrays, miniArr, iconArr].filter(Boolean).reduce((s, a) => s + (a.tex?.bytes ?? 0), 0);
    const perArr = [...lists.sprites].filter(([, l]) => l.n).map(([ai, l]) => `${ai}:${arrays[ai]?.LW}x${arrays[ai]?.LH}:${l.n / 16}`);
    const w = [...updWin].sort((a, c) => a - c), pc = f => (w.length ? +w[Math.min(w.length - 1, Math.floor(f * w.length))].toFixed(2) : 0);
    return { ready, why, ...st, updateMsP50: pc(0.5), updateMsP95: pc(0.95), updateMsMax: w.length ? +w[w.length - 1].toFixed(2) : 0, updates: w.length,
      gpuMB: +(bytes / 1048576).toFixed(2), arrays: arrays.length, sprites: catalog.size, perArr, missing: [...missing].slice(0, 40), missingCount: missing.size, geomVersion,
      rehearsed: rh ? { ...rh.drawn } : null,   // band rehearsal: draws per program (W1 B1: all five at FAR, art or not)
      rehearsedReal: rh ? { ...rh.real } : null };   // Stage B: true = that program last rehearsed on its real arrays
  }
  /** web port P8: does b draw as its live keep at this view (the hand-over baseMode decides per kingdom)? */
  const drawsBase = (b, view) => baseMode(view.s, view.d, hash01(seedOf(b.id), 7), hash01(seedOf(b.id), 8)) === 'keep';
  return {
    load, setBases, setFilter, select, hover, update, draw, rehearse, pick, tagCandidates, stats, dispose, drawsBase,
    get stateTex() { return stateTex; }, get stateCpu() { return stateData; }, get geomVersion() { return geomVersion; }, get ready() { return ready; },
  };
}
