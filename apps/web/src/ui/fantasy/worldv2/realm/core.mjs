// Realm-map GL core (plan §3.1, §4.2, §7, §9, §10.2): WebGL2 context, program/#include system, the
// RealmView UBO, texture/upload/LRU utilities with a gpuMB allocator, the frame scheduler with the
// timed idle policy (C10), and context-loss handling.
//
// Context loss (§9): on webglcontextlost the scheduler stops; on webglcontextrestored core re-creates
// its own GL state (UBO, quad, program cache, allocator) and emits 'restored'. The integrator (map.js)
// then re-creates every module and re-runs its load(pack) — the loader keeps the decoded sources, so
// the rebuild never refetches. Modules therefore never need restore code of their own; they must only
// make create()+load() idempotent and keep no GL handles outside the objects core hands them.
import { PREAMBLE, COMMON } from './glsl/common.glsl.mjs';
import { IDLE, UBO_VIEW, GPU_SAFE, BANDS } from './contracts.mjs';
import { PASS, DISPLAY_BUDGET, RESOLVE_BUDGET } from './groundcost.mjs';
import { taskClock } from './slice.mjs';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * GPU watchdog (P0 RM-GPU-1) as a pure function. samples: the GPU cost of the latest STEADY frames in ms (timer-query
 * GPU time, or a fence-latency lower bound; cold frames never reach it, see isColdFrame). 'down' when `need` of the
 * last `window` exceed slowMs (the view cannot hold 20 fps on this GPU) or `severeNeed` reach severeMs (one stall is
 * a hiccup, two in a window are a GPU that cannot draw this view); 'up' when `good` (consecutive samples ≤ upMs) has
 * reached upAfter; else 'hold'.
 */
export function watchdog(samples, { slowMs = GPU_SAFE.slowMs, severeMs = GPU_SAFE.severeMs, window = GPU_SAFE.window, need = GPU_SAFE.need,
  severeNeed = GPU_SAFE.severeNeed, good = 0, upAfter = GPU_SAFE.upAfter } = {}) {
  const last = samples.slice(-window);
  if (last.filter(ms => ms >= severeMs).length >= severeNeed) return 'down';
  if (last.filter(ms => ms > slowMs).length >= need) return 'down';
  return good >= upAfter ? 'up' : 'hold';
}
/**
 * May the band rehearsal draw this frame (pure)? Not while any program still links in the background (the rehearsal
 * must not compete with link work, and the lane gate holds a linking lane's draws anyway). A FAILED link does not hold
 * it: its lane is disabled for the session, so waiting on it kept every other lane cold (SwiftShader, GROUND's rm-map
 * failing to compile left all of LIFE's programs to first-draw on the band change). sets: the lanes' program sets.
 */
export const rehearsalHeld = sets => sets.some(s => { for (const p of s) if (p.state === 'pending') return true; return false; });
/**
 * When a band-rehearsal hook that could not draw (falsy) is tried again (pure; W1 S2): retryMs × tries, capped at
 * retryMaxMs — never Infinity. P0 gave up after 4 tries, and BASES' hook, falsy until its art was in, then first-drew
 * its three programs on the band change in the product (10.7 + 6.6 s on SwiftShader). Readiness bounds it, not a count.
 */
export const retryAt = (tries, t, R = GPU_SAFE.rehearse) => t + Math.min(R.retryMaxMs, R.retryMs * Math.max(1, tries));

/**
 * Is a frame's GPU sample one-off work rather than the view's steady cost (pure)? d = what the frame did: firstDraws
 * (first draws of a (program, GL state): the driver builds that pipeline then), rehearsed (band-rehearsal draws: each
 * builds a pipeline the band change will not have to, W1 S6), links (background links that ended since the last frame),
 * uploadBytes. A small upload (a 2-byte page-table entry, a chart16 layer) is steady: counting every upload as cold made
 * the watchdog blind while TRUE pages stream (P0 fix pass #6).
 */
export const isColdFrame = ({ firstDraws = 0, rehearsed = 0, links = 0, uploadBytes = 0 }, coldUploadBytes = GPU_SAFE.coldUploadBytes) =>
  firstDraws > 0 || rehearsed > 0 || links > 0 || uploadBytes > coldUploadBytes;
/**
 * One GPU sample through the quality policy (pure; map.js keeps the state). s = { level, floor, samples, good, wentUp,
 * upLock }; eff(L) → { k, heavy } (what level L changes on this screen). Cold frames are ignored (P0 fix pass #3: a
 * first draw of rm-map may take > 1 s on Metal, and it used to drop the owner's first zoom-in into safe mode).
 * → { s: next state, act: null | 'down' | 'up' }. A level that changes nothing on this screen is skipped both ways; up
 * never passes the floor; once a step up has been followed by a step down, ups are locked for the session.
 */
export function qualityStep(s, ms, cold, eff, o = GPU_SAFE) {
  if (cold) return { s: { ...s, cold: (s.cold ?? 0) + 1 }, act: null };
  const samples = [...s.samples, ms].slice(-o.window), good = ms <= o.upMs ? s.good + 1 : 0, n = { ...s, samples, good };
  const same = (a, b) => { const A = eff(a), B = eff(b); return A.k === B.k && A.heavy === B.heavy; };
  const v = watchdog(samples, { ...o, good: s.level > s.floor && !s.upLock ? good : 0 });
  if (v === 'down' && s.level < 2) { let L = s.level + 1; while (L < 2 && same(L, s.level)) L++; return { s: { ...n, level: L, samples: [], good: 0, upLock: s.upLock || s.wentUp }, act: 'down' }; }
  if (v === 'up') { let L = s.level - 1; while (L > s.floor && same(L - 1, L)) L--; return { s: { ...n, level: L, samples: [], good: 0, wentUp: true }, act: 'up' }; }
  return { s: n, act: null };
}
const median = v => { if (!v.length) return 0; const a = v.slice().sort((x, y) => x - y); return a[a.length >> 1]; };
/**
 * Level-0 frame-rate governor for MAP rest (pure; stage B D2; the rule is contracts.js GPU_SAFE.gov). g = { on, samples:
 * [[t, ms] …], good, wentUp, lock, acts }; ms: a STEADY GPU sample (cold frames never reach it); t: its frame's submit time
 * (ms); mapRest: that frame drew the MAP pass alone at level 0 on a screen where n0 > 1 (anything else is not its cost and
 * is ignored). → { g: next state, act: null | 'on' | 'off' }. 'on' = MAP rest renders at n0; 'off' = full resolution again.
 */
export function govStep(g, ms, t, mapRest, o = GPU_SAFE.gov) {
  if (!mapRest) return { g, act: null };
  if (!g.on) {
    const samples = [...(g.samples ?? []), [t, ms]].filter(([ts]) => t - ts <= o.windowMs);
    if (samples.length >= o.minSamples && t - samples[0][0] >= o.windowMs * 0.8 && median(samples.map(x => x[1])) > o.ms)
      return { g: { ...g, on: true, samples: [], good: 0, lock: !!(g.lock || g.wentUp), acts: (g.acts ?? 0) + 1 }, act: 'on' };
    return { g: { ...g, samples }, act: null };
  }
  const good = ms <= o.upMs ? (g.good ?? 0) + 1 : 0;
  if (!g.lock && good >= o.upAfter) return { g: { ...g, on: false, good: 0, samples: [], wentUp: true, acts: (g.acts ?? 0) + 1 }, act: 'off' };
  return { g: { ...g, good }, act: null };
}
/** The pass groundDiv scales a frame for (stage B D2): while the governor is on, MAP rest at level 0 renders at n0, as a fade
 *  does; every other pass, level and state is unchanged (levels ≥ 1 are the watchdog's). */
export const governedPass = (pass, level, gov) => (gov && level === 0 && pass === 'map' ? null : pass);
/**
 * The band gate's limit (pure; W1 S2/S8): the highest d the camera may reach now. items: the rehearsal items still to do,
 * as { set, gating } (set 1 = the MAP set, 2 = TRUE; gating = its lane has loaded and it can draw); valve: the stall valve
 * opened this gate (a stuck hook must never lock the zoom); bypass: a QA set() jumped past it. A lane still loading never
 * closes the zoom (D-177 withdrew D-173's dive hold: the landing waits for nothing it does not draw); GROUND's mapReady hold
 * is the caller's (it is timed). → { lim, band, reason }
 */
export function bandLimit({ on = true, bypass = false, valve = false, items = [] } = {}) {
  if (bypass) return { lim: Infinity, band: null, reason: 'bypassed by a QA set()' };
  if (on && !valve) {
    if (items.some(it => it.set <= 1 && it.gating)) return { lim: BANDS.farEnd, band: 'map', reason: 'rehearsal' };
    if (items.some(it => it.set <= 2 && it.gating)) return { lim: BANDS.trueStart, band: 'true', reason: 'rehearsal' };
  }
  return { lim: Infinity, band: null, reason: null };
}
const divFor = (dpr, px) => Math.min(4, Math.max(1, Math.ceil(Math.max(dpr, 1e-3) / Math.max(px, 1e-3) - 1e-6)));
/**
 * The ground passes' render scale for a px-per-CSS-px cap (P0 fix pass #4): the largest INTEGER fraction 1/n of the
 * canvas that stays within groundPx px per CSS px, n ≤ 4, so the ground target is upscaled by an exact n× snap, never a
 * second resample of the pixel art (k 0.75 on a dpr-2 retina blurred the ground under crisp sprites). dpr 2, 1.5 → ½.
 */
export const groundScale = (dpr, groundPx) => 1 / divFor(dpr, groundPx);
/**
 * May this ground display pass, drawn ALONE at rest, render at full resolution (pure; W1 S3)? Yes when its worst-case
 * fetches plus a frame's resolve slices fit the display budget (groundcost.js): chart 5 and TRUE 22 do; MAP (61 on
 * 2026-09-25) does once GROUND's MAP pass is ≤ DISPLAY_BUDGET − RESOLVE_BUDGET = 58. perPass: groundcost PASS (tests).
 */
export const fullResPass = (pass, perPass = PASS) => pass != null && (perPass[pass] ?? Infinity) + RESOLVE_BUDGET <= DISPLAY_BUDGET;
/**
 * The ground divisor n (the ground target is the canvas / n) for one frame at quality level L (pure; W1 S3/S4; the
 * rule is contracts.js GPU_SAFE). pass: the ONE display pass drawn ('chart' | 'map' | 'true'), or null while two are
 * drawn (a cross-fade) or when unknown. Level 0 renders a lone cheap pass at full resolution (the owner's TRUE rest on
 * a dpr-2 retina was a ½ target: soft under crisp sprites) and a fade at n0; level 1 is n1 everywhere; level 2 one step
 * coarser than level 1, so each level that changes the view cuts the ground work ≥ 20 % on a dpr ≥ 1.5 screen.
 */
export function groundDiv(dpr, level, pass = null, perPass = PASS) {
  const n0 = divFor(dpr, GPU_SAFE.groundPx[0]), n1 = Math.max(n0, divFor(dpr, GPU_SAFE.groundPx[1]));
  if (level >= 2) return Math.min(4, n1 + 1);
  if (level === 1) return n1;
  return fullResPass(pass, perPass) ? 1 : n0;
}

/**
 * Crash memory (W1 S5; the rule is contracts.js GPU_SAFE), pure: each step takes the stored record (or null) and returns
 * the next one to store (null = remove). record = { level, reason, t, clean, crashes, crashBand, pending?, band?, hold? }.
 *   start(rec, now, param) → { level, reason, hold, rec } at page load (param = ?gpusafe: '0' clears, '1'/'2' force);
 *   enter(rec, now) marks a visit in progress (a freeze or crash leaves it behind); at(rec, band) keeps the band the visit
 *   is in beside it (0 FAR, 1 MAP, 2 TRUE: where a freeze happened); leave(rec, visit) = a clean leave, visit.steadyBand =
 *   the deepest band that had GPU_SAFE.crash.steady steady watchdog samples at the stored level (−1: none);
 *   loss(rec, now, reason, band) = a lost context in the map; tryAgain(rec) = the player's TRY AGAIN / FULL DETAIL.
 * A stored level is cleared after crash.clean × crashes clean visits (back-off), never by time: a machine that froze
 * yesterday freezes today. A visit is clean only when it drew steady frames in a band at or above the deepest one that froze
 * (W1 fix pass 2 #6: a few seconds at FAR proved nothing about a MAP freeze, and cleared it). The crash count survives
 * the clear, so the next crash needs more clean visits.
 */
const bandOr = (b, d) => (Number.isInteger(b) ? Math.min(2, Math.max(0, b)) : d);
export const gpuRecord = {
  start(rec, now, param = null) {
    if (param === '0') return { level: 0, reason: null, hold: false, rec: null };
    if (param === '1' || param === '2') return { level: +param, reason: 'forced by ?gpusafe', hold: false, rec };
    if (!rec) return { level: 0, reason: null, hold: false, rec: null };
    if (rec.pending) {
      const hold = (rec.level ?? 0) >= 2, reason = 'the last visit ended inside the realm map (a freeze or a crash)';
      const next = { level: 2, reason, t: now, clean: 0, crashes: (rec.crashes ?? 0) + 1, crashBand: Math.max(bandOr(rec.crashBand, 0), bandOr(rec.band, 1)) }; if (hold) next.hold = true;
      return { level: 2, reason, hold, rec: next };
    }
    if ((rec.level ?? 0) > 0) return { level: Math.min(2, rec.level), reason: rec.reason ?? 'an earlier graphics reset', hold: !!rec.hold, rec };
    return { level: 0, reason: null, hold: false, rec };
  },
  enter: (rec, now) => ({ ...(rec ?? {}), pending: now, band: 0 }), // a visit starts at FAR (map.js enter)
  at: (rec, band) => (rec?.pending ? { ...rec, band: bandOr(band, 0) } : rec),
  leave(rec, visit = null) {
    if (!rec) return null;
    const r = { ...rec }; delete r.pending; delete r.band;
    if (!((r.level ?? 0) > 0)) return r.crashes ? { crashes: r.crashes } : null;
    if ((visit?.steadyBand ?? -1) < bandOr(r.crashBand, 1)) return r; // not a clean visit: it never drew where it froze
    r.clean = (r.clean ?? 0) + 1;
    return r.clean >= GPU_SAFE.crash.clean * Math.max(1, r.crashes ?? 1) ? { crashes: r.crashes ?? 1 } : r;
  },
  loss: (rec, now, reason, band = 1) => ({ ...(rec ?? {}), level: 2, reason, t: now, clean: 0, crashes: (rec?.crashes ?? 0) + 1, crashBand: Math.max(bandOr(rec?.crashBand, 0), bandOr(band, 1)) }),
  // web port P13: a hidden page is not a visit in progress (Android may discard a hidden tab without a pagehide, and a
  // left-behind `pending` reads as a freeze); shown again, the same visit is marked again, in the band it was in
  hide(rec) { if (!rec?.pending) return rec ?? null; const r = { ...rec }; delete r.pending; delete r.band; return Object.keys(r).length ? r : null; },
  show: (rec, now, band) => gpuRecord.at(gpuRecord.enter(rec, now), band),
  tryAgain(rec) { if (!rec) return null; const r = { crashes: rec.crashes ?? 0 }; if (rec.pending) { r.pending = rec.pending; if (rec.band != null) r.band = rec.band; } return r.crashes || r.pending ? r : null; },
};
/**
 * The timed idle policy (plan §7) as a pure function. periods: active animation periods (ms) of what is
 * on screen; pulsePeriods: those of the pulse tags (selection, shield). Returns the wait before the next
 * frame ({ ms: Infinity } = render nothing until input) and the phase for stats().idlePhase.
 */
export function idleInterval({ sinceInputMs, periods = [], pulsePeriods = [], reducedMotion = false, hidden = false, clockMs = 0 }) {
  const phase = sinceInputMs < IDLE.fullMs ? 'full' : sinceInputMs < IDLE.freezeMs ? 'capped' : 'frozen';
  if (hidden || reducedMotion) return { ms: Infinity, phase };
  if (phase === 'frozen') {
    if (!pulsePeriods.length) return { ms: Infinity, phase };
    return { ms: Math.max(Math.min(...pulsePeriods), 1000 / IDLE.pulseFps), phase };
  }
  if (!periods.length) return { ms: Infinity, phase };
  const base = Math.max(1, Math.min(...periods)), cap = 1000 / (phase === 'full' ? IDLE.fullCapFps : IDLE.capFps);
  if (base < cap) return { ms: cap, phase };
  const toBoundary = base - (clockMs % base); // render when the fastest visible clip's frame index changes
  return { ms: Math.max(1, toBoundary), phase };
}

const BYTES = { R8: 1, R8UI: 1, R8I: 1, RG8: 2, RG8UI: 2, RGB8: 4, RGBA8: 4, SRGB8_ALPHA8: 4, RGBA8UI: 4, R16UI: 2, R16I: 2, R16F: 2,
  RG16UI: 4, RGBA16UI: 8, RGBA16F: 8, R32UI: 4, R32F: 4, RG32F: 8, RGBA32F: 16, DEPTH_COMPONENT24: 4, DEPTH24_STENCIL8: 4 };
const FORMAT_OF = { R8: 'RED', R8UI: 'RED_INTEGER', R8I: 'RED_INTEGER', RG8: 'RG', RG8UI: 'RG_INTEGER', RGB8: 'RGB', RGBA8: 'RGBA', SRGB8_ALPHA8: 'RGBA',
  RGBA8UI: 'RGBA_INTEGER', R16UI: 'RED_INTEGER', R16I: 'RED_INTEGER', RG16UI: 'RG_INTEGER', RGBA16UI: 'RGBA_INTEGER', R32UI: 'RED_INTEGER',
  R16F: 'RED', RGBA16F: 'RGBA', R32F: 'RED', RG32F: 'RG', RGBA32F: 'RGBA' };
const TYPE_OF = { R8: 'UNSIGNED_BYTE', R8UI: 'UNSIGNED_BYTE', R8I: 'BYTE', RG8: 'UNSIGNED_BYTE', RG8UI: 'UNSIGNED_BYTE', RGB8: 'UNSIGNED_BYTE', RGBA8: 'UNSIGNED_BYTE',
  SRGB8_ALPHA8: 'UNSIGNED_BYTE', RGBA8UI: 'UNSIGNED_BYTE', R16UI: 'UNSIGNED_SHORT', R16I: 'SHORT', RG16UI: 'UNSIGNED_SHORT', RGBA16UI: 'UNSIGNED_SHORT',
  R32UI: 'UNSIGNED_INT', R16F: 'HALF_FLOAT', RGBA16F: 'HALF_FLOAT', R32F: 'FLOAT', RG32F: 'FLOAT', RGBA32F: 'FLOAT' };
const isInt = f => /UI$|I$/.test(f);
const mipBytes = (w, h, levels) => { let b = 0; for (let l = 0; l < levels; l++) b += Math.max(1, w >> l) * Math.max(1, h >> l); return b; };
export const bytesPerTexel = f => BYTES[f] ?? 4;
export const maxLevels = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1;

/** Minimal LRU (Map insertion order). put() evicts the least recently used past n and calls its onEvict. */
export function lru(n) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const e = m.get(k); m.delete(k); m.set(k, e); return e.v; },
    has: k => m.has(k),
    put(k, v, onEvict) {
      if (m.has(k)) m.delete(k); m.set(k, { v, onEvict });
      while (m.size > n) { const [ok, oe] = m.entries().next().value; m.delete(ok); oe.onEvict?.(oe.v, ok); }
      return v;
    },
    delete(k) { const e = m.get(k); if (!e) return false; m.delete(k); e.onEvict?.(e.v, k); return true; },
    keys: () => [...m.keys()], get size() { return m.size; }, capacity: n,
    clear() { for (const [k, e] of m) e.onEvict?.(e.v, k); m.clear(); },
  };
}

/** A rect of an ImageData, copied row by row (a 2D canvas round trip would premultiply it). */
export function cropImageData(im, r) {
  const W = im.width, out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) { const o = ((r.y + y) * W + r.x) * 4; out.set(im.data.subarray(o, o + r.w * 4), y * r.w * 4); }
  return new ImageData(out, r.w, r.h);
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

/**
 * One shader stage exactly as core.program() hands it to the driver (pure; exported for the shader-size test):
 * PREAMBLE + REALM_VS/REALM_FS + the #defines + the source with every #include "name" resolved once (includes: Map).
 */
export function preprocessGLSL(src, { kind, defines = {}, includes, name = '?' }) {
  const resolve = (s, seen) => s.replace(/^[ \t]*#include[ \t]+"([\w.-]+)"[ \t]*$/gm, (_, n) => {
    if (seen.has(n)) return `// #include "${n}" (already included)`;
    if (!includes.has(n)) throw Error(`realm shader ${name}: unknown #include "${n}"`);
    seen.add(n); return resolve(includes.get(n), seen);
  });
  const body = src.replace(/^\s*#version[^\n]*\n/, '');
  const defs = Object.entries(defines || {}).map(([k, v]) => `#define ${k}${v === true ? '' : ' ' + v}`).join('\n');
  return PREAMBLE + `#define REALM_${kind} 1\n` + defs + '\n' + resolve(body, new Set());
}

/**
 * createCore(canvas, { now }) → Core (plan §10.2). See the file header for context loss.
 * Core.view is the View of the frame being drawn (set by begin(view)).
 */
export function createCore(canvas, { now = () => performance.now(), freezeMs = null, marks = false } = {}) {
  const attrs = { antialias: false, alpha: false, depth: true, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  const gl = canvas.getContext('webgl2', attrs);
  if (!gl) throw Error('WebGL2 unavailable');
  const loseExt = gl.getExtension('WEBGL_lose_context');
  const listeners = { lost: new Set(), restored: new Set(), gpu: new Set(), program: new Set() };
  const emit = (ev, ...a) => { for (const f of listeners[ev]) try { f(...a); } catch (e) { console.error(e); } };
  const includes = new Map([['common', COMMON]]);
  const stats = { frames: 0, draws: 0, instances: 0, drawsLast: 0, instancesLast: 0, intervals: [], cpu: [], contextLosses: 0,
    uploadedBytes: 0, uploadsLast: 0, longTasks: 0, longTaskMaxMs: 0, idlePhase: 'full', gpuBytes: 0, skippedDraws: 0, firstDraws: 0, firstStates: 0, links: 0, rehearsed: 0,
    rehearsalDeferred: 0, stateMisses: [] };
  let caps, features, programs, ubo, uboData, uboF, uboU, quadVao, quadBuf, triVao, fbos, allocs, sharedTex, subRectOk, tq;
  let lost = false, epoch = 0, staleWarned = false;
  // GPU safety (P0): frames in flight (timer query and/or fence), the low-resolution ground target and its blit
  const gpuPend = [], gpuSamples = []; let lowT = null, blitProg = null, gpuPoll = 0, lowK = 1, lastCold = false, linksSeen = 0, uploadsSeen = 0, rehSeen = 0;
  // band rehearsal (P0 fix pass, v2 W1 S1): while `rehearsing`, the scissor box core set cannot be moved or disabled by a
  // lane, and at most ONE new (program, state) is drawn per rehearse() call (rhCall.fresh; later new states are skipped and
  // counted in rhCall.deferred, so the caller comes back next frame). drawTag (map.js: the band being drawn) labels each
  // program's first draw in stats().programs.firstDrawn
  let rehearsing = false, drawTag = '', rhCall = null, frameTag = null;
  let renderer = '';
  try { const dbg = gl.getExtension('WEBGL_debug_renderer_info'); renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || ''); } catch { /* masked */ }
  const software = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(renderer);
  // a texture object from before a context restore belongs to the dead context: every use is a no-op (and
  // warns once) instead of a GL_INVALID_OPERATION in the new one
  const stale = o => { if (!o || o.epoch === undefined || o.epoch === epoch) return false; if (!staleWarned) { staleWarned = true; console.warn('realm core: ignored a texture from a lost WebGL context'); } return true; };

  // ---- GL state shadow (W1 S1): the pipeline-relevant state of each draw, keyed per program ----
  // A driver builds a pipeline per (program, blend, depth, colour mask, cull, target format): the P0 attribution found
  // real first uses of states the rehearsal had never drawn. The wrappers below keep a shadow of that state (no GL query)
  // so every draw is keyed (program, stateKey) — a first draw of a new key is cold, and the rehearsal builds one per frame.
  const gs = { blend: false, cull: false, depth: false, bf: 0, df: 0, dm: 1, cm: 15, fb: 0 };
  const bfIds = new Map(), fbIds = new Map([['canvas', 0]]), fbKind = new WeakMap();
  const idOf = (m, k, base) => { let v = m.get(k); if (v === undefined) m.set(k, v = m.size + base); return v; };
  const stateKey = () => (((gs.fb * 64 + (gs.blend ? 1 + gs.bf : 0)) * 2 + (gs.cull ? 1 : 0)) * 32 + (gs.depth ? 16 + ((gs.df & 7) << 1) + gs.dm : 0)) * 16 + gs.cm;
  const shadowCap = (cap, on) => { if (cap === gl.BLEND) gs.blend = on; else if (cap === gl.DEPTH_TEST) gs.depth = on; else if (cap === gl.CULL_FACE) gs.cull = on; };
  const rawEnable = gl.enable.bind(gl), rawBlendFunc = gl.blendFunc.bind(gl), rawBlendSep = gl.blendFuncSeparate?.bind(gl), rawDepthFunc = gl.depthFunc.bind(gl);
  const rawDepthMask = gl.depthMask.bind(gl), rawColorMask = gl.colorMask.bind(gl), rawBindFb = gl.bindFramebuffer.bind(gl);
  gl.enable = cap => { shadowCap(cap, true); rawEnable(cap); };
  gl.blendFunc = (a, b) => { gs.bf = idOf(bfIds, `${a},${b},${a},${b}`, 1); rawBlendFunc(a, b); };
  if (rawBlendSep) gl.blendFuncSeparate = (a, b, c, d) => { gs.bf = idOf(bfIds, `${a},${b},${c},${d}`, 1); rawBlendSep(a, b, c, d); };
  gl.depthFunc = f => { gs.df = f - gl.NEVER; rawDepthFunc(f); };
  gl.depthMask = m => { gs.dm = m ? 1 : 0; rawDepthMask(m); };
  gl.colorMask = (r, g, b, a) => { gs.cm = (r ? 8 : 0) | (g ? 4 : 0) | (b ? 2 : 0) | (a ? 1 : 0); rawColorMask(r, g, b, a); };
  gl.bindFramebuffer = (t, f) => { if (t !== gl.READ_FRAMEBUFFER) gs.fb = f ? idOf(fbIds, fbKind.get(f) ?? 'fbo', 0) : 0; rawBindFb(t, f); };
  const resetShadow = () => Object.assign(gs, { blend: false, cull: false, depth: false, bf: 0, df: gl.LESS - gl.NEVER, dm: 1, cm: 15, fb: 0 });
  function stateMiss(p) { const k = `${p.name}@${drawTag || '?'}`; if (!stats.stateMisses.includes(k) && stats.stateMisses.length < 32) stats.stateMisses.push(k); }

  // ---- draw-call accounting (wraps this context's draw entry points once) ----
  // a draw under a program whose background link has not ended is skipped (never waits for the link; see program())
  // (cur.bound is the state use() saw: a link that ends later in the same frame never turns a skipped use() into a
  // draw with no program bound)
  const wrap = (name, inst) => { const f = gl[name].bind(gl); gl[name] = (...a) => {
    if (cur && !cur.bound) { stats.skippedDraws++; return undefined; }
    if (cur) {
      const k = stateKey();
      if (!cur.states.has(k)) { // a first draw of this (program, state): the driver builds its pipeline now
        if (rehearsing) { if (rhCall.fresh >= 1) { rhCall.deferred++; stats.rehearsalDeferred++; return undefined; } rhCall.fresh++; }
        else if (cur.rehearsed) stateMiss(cur); // the rehearsal saw this program but never built this state
        cur.states.add(k); stats.firstStates++;
        if (!cur.drawn) { cur.drawn = true; cur.firstIn = (rehearsing ? 'rehearsal@' : '') + drawTag; stats.firstDraws++; }
      }
      if (rehearsing) cur.rehearsed = true;
    }
    if (rehearsing) { stats.rehearsed++; rhCall.draws++; }
    stats.draws++; stats.instances += inst(a); return f(...a); }; };
  wrap('drawArrays', () => 1); wrap('drawElements', () => 1);
  wrap('drawArraysInstanced', a => a[3]); wrap('drawElementsInstanced', a => a[4]);
  const rawScissor = gl.scissor.bind(gl), rawDisable = gl.disable.bind(gl); // a rehearsal's scissor box holds whatever the lane calls
  gl.disable = cap => { if (rehearsing && cap === gl.SCISSOR_TEST) return; shadowCap(cap, false); rawDisable(cap); };
  gl.scissor = (...a) => { if (!rehearsing) rawScissor(...a); };

  function initGL() {
    caps = { maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
      maxUnits: Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)),
      maxUbo: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE) };
    programs = new Map(); fbos = new Map(); allocs = new Set(); sharedTex = new Map(); stats.gpuBytes = 0; epoch++; resetShadow();
    ubo = gl.createBuffer(); uboData = new ArrayBuffer(112); uboF = new Float32Array(uboData); uboU = new Uint32Array(uboData);
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferData(gl.UNIFORM_BUFFER, 112, gl.DYNAMIC_DRAW); gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_VIEW, ubo);
    // a unit quad (0..1, two triangles, attribute 0) for instanced sprites, and a fullscreen triangle
    const q = quadBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, q); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), gl.STATIC_DRAW);
    quadVao = gl.createVertexArray(); gl.bindVertexArray(quadVao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const t = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, t); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    triVao = gl.createVertexArray(); gl.bindVertexArray(triVao); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    features = { ...testFeatures(), bitmapOptions: features?.bitmapOptions ?? null };
    tq = gl.getExtension('EXT_disjoint_timer_query_webgl2'); gpuPend.length = 0; lowT = null; blitProg = null;
    pexec = gl.getExtension('KHR_parallel_shader_compile'); pending.clear(); clearTimeout(pollT); pollT = 0; cur = null;
    blitProg = program('rm-lowres-blit', { vs: BLIT_VS, fs: BLIT_FS }); // prewarmed: links long before the first lowres frame
  }
  // integer formats (R8UI, RGBA16UI from typed arrays; renderable), and sub-rect uploads from a TexImageSource
  function testFeatures() {
    const f = { intUpload: false, intRender: false, subRect: false };
    while (gl.getError()) { /* drain */ }
    try {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, 2, 2, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 4]));
      const t2 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, 1, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array([1, 2, 3, 40000]));
      f.intUpload = gl.getError() === gl.NO_ERROR;
      const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const ok8 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t2, 0);
      f.intRender = ok8 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      // sub-rect: upload pixel (1,0) of a 2×1 ImageData into a 1×1 RGBA8 texture, read it back
      if (typeof ImageData !== 'undefined') {
        const t3 = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t3); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new ImageData(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1));
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t3, 0);
        const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        f.subRect = px[0] === 0 && px[1] === 255; gl.deleteTexture(t3);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(t); gl.deleteTexture(t2);
    } catch (e) { console.warn('realm core feature test', e); }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4); while (gl.getError()) { /* drain */ }
    subRectOk = f.subRect; return f;
  }
  // ImageBitmapOptions honoured? (premultiplyAlpha:'none' must keep RGB of a half-transparent pixel)
  const featuresReady = (async () => {
    await null; // initGL (end of createCore) creates `features`: never touch it synchronously (no createImageBitmap → no await below)
    let ok = false;
    try {
      if (typeof createImageBitmap === 'function' && typeof ImageData !== 'undefined') {
        const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray([200, 100, 50, 128]), 1, 1), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        if (!lost) {
          const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
          const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
          const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          ok = Math.abs(px[0] - 200) <= 2 && Math.abs(px[1] - 100) <= 2 && Math.abs(px[3] - 128) <= 2;
          gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(t);
        }
        bmp.close?.();
      }
    } catch { ok = false; }
    features.bitmapOptions = ok; return features;
  })();

  // ---- programs ----
  const stage = (src, defines, name, kind) => preprocessGLSL(src, { kind, defines, includes, name });
  // Programs link in the background (fix iteration 2 P0, orchestrator decision: no synchronous program linking).
  // program() issues compile + link and returns at once; nothing asks for COMPILE_STATUS / LINK_STATUS (or a uniform
  // location or block index, which wait for the link too) until KHR_parallel_shader_compile's COMPLETION_STATUS_KHR
  // says the link has ended. Until then prog.ready is false: use() binds no program, u() is null (uniform calls are
  // no-ops) and every draw issued under it is skipped (counted in stats().programs.skippedDraws). Lanes are gated by
  // map.js (a lane draws only once all its programs are ready; the painted overview holds the ground slot). A link
  // that fails is reported (prog.error, console, stats) instead of throwing mid-frame. Without the extension the
  // first status query blocks until the link ends: it is deferred GPU_SAFE.noParallelDeferMs past the issue.
  // Without the extension (SwiftShader, some older drivers) a status query blocks until that link AND every command
  // issued before it has run, so the fallback asks in issue order (oldest pending first: each wait covers one link),
  // and once blocking queries have held the main thread GPU_SAFE.noParallelSliceMs in one burst it stays quiet for
  // 16 ms: a burst of 20 links costs a series of short waits spread over frames, not one long task.
  const pending = new Set(); let pollT = 0, cur = null, pexec = null, nxQuiet = -1e9, nxSpent = 0, nxLast = -1e9;
  function settle(prog) {
    if (prog.state !== 'pending') return prog.state === 'ready';
    if (lost || prog.epoch !== epoch) return false;
    const t = now(); if (t - prog.polled < 16) return false;
    if (!pexec && (t - prog.t0 < GPU_SAFE.noParallelDeferMs || t < nxQuiet || pending.values().next().value !== prog)) return false;
    prog.polled = t;
    if (pexec && !gl.getProgramParameter(prog.p, pexec.COMPLETION_STATUS_KHR)) return false;
    pending.delete(prog); prog.ms = Math.round(t - prog.t0); stats.links++;
    const linked = gl.getProgramParameter(prog.p, gl.LINK_STATUS);
    if (!pexec) { const t1 = now(); nxSpent = (t - nxLast < 16 ? nxSpent : 0) + (t1 - t); nxLast = t1; if (nxSpent >= GPU_SAFE.noParallelSliceMs) { nxQuiet = t1 + 16; nxSpent = 0; } }
    if (!linked) {
      if (gl.isContextLost()) return false;
      const logs = prog.sh.map((s, i) => (gl.getShaderParameter(s, gl.COMPILE_STATUS) ? '' : `${i ? 'fs' : 'vs'}: ${gl.getShaderInfoLog(s)}`)).filter(Boolean);
      prog.state = 'failed'; prog.error = `realm program ${prog.name}: ${logs.join(' ') || gl.getProgramInfoLog(prog.p)}`;
      console.error(prog.error); for (const [i, s] of prog.src.entries()) console.error(`[realm shader ${prog.name} ${i ? 'fs' : 'vs'}]\n` + s.split('\n').map((l, k) => `${k + 1}: ${l}`).join('\n'));
      emit('program', prog); return false;
    }
    const bi = gl.getUniformBlockIndex(prog.p, 'RealmView'); if (bi !== gl.INVALID_INDEX) gl.uniformBlockBinding(prog.p, bi, UBO_VIEW);
    for (const s of prog.sh) { gl.detachShader(prog.p, s); gl.deleteShader(s); } prog.sh = []; prog.src = null;
    prog.state = 'ready'; emit('program', prog); invalidate(); return true;
  }
  function pollPrograms() { pollT = 0; if (lost) return; for (const p of [...pending]) settle(p); if (pending.size) pollT = setTimeout(pollPrograms, GPU_SAFE.pollMs); }
  function program(name, { vs, fs, defines } = {}) {
    const key = name + '|' + JSON.stringify(defines || {});
    if (programs.has(key)) return programs.get(key);
    const src = [stage(vs, defines, name, 'VS'), stage(fs, defines, name, 'FS')];
    const p = gl.createProgram(), sh = [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].map((type, i) => { const s = gl.createShader(type); gl.shaderSource(s, src[i]); gl.compileShader(s); gl.attachShader(p, s); return s; });
    gl.linkProgram(p);
    const locs = new Map();
    const prog = {
      name, p, sh, src, state: 'pending', error: null, t0: now(), polled: -1e9, ms: 0, drawn: false, bound: false, epoch, states: new Set(), rehearsed: false,
      /** true once the background link has ended successfully (polls COMPLETION_STATUS_KHR, never blocks) */
      get ready() { return settle(prog); },
      get failed() { return prog.state === 'failed'; },
      u(n) { if (prog.state !== 'ready' || (cur === prog && !prog.bound)) return null; if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n)); return locs.get(n); },
      use() { cur = prog; prog.bound = settle(prog); gl.useProgram(prog.bound ? p : null); return prog; },
      bindView() { gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_VIEW, ubo); return prog; },
      /** bind a core texture object to a unit and point sampler `n` at it */
      tex(n, unit, t) { if (stale(t)) t = null; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(t?.target ?? gl.TEXTURE_2D, t?.t ?? null); gl.uniform1i(prog.u(n), unit); return prog; },
    };
    programs.set(key, prog); pending.add(prog);
    if (!pollT) pollT = setTimeout(pollPrograms, GPU_SAFE.pollMs);
    return prog;
  }

  // ---- textures (allocator tracks bytes → gpuMB) ----
  let uidN = 0;
  const track = o => { o.uid = ++uidN; o.epoch = epoch; allocs.add(o); stats.gpuBytes += o.bytes; return o; };
  function params(target, { filter = 'linear', mips = false, wrap = 'clamp', int = false } = {}) {
    const near = int || filter === 'nearest';
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, near ? (mips && !int ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST) : mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, near ? gl.NEAREST : gl.LINEAR);
    const w = wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, w); gl.texParameteri(target, gl.TEXTURE_WRAP_T, w);
  }
  const srcSize = src => [src.width ?? src.w, src.height ?? src.h];
  // Every upload binds on a reserved scratch unit (the last one; programs use 0–13), so creating or
  // updating a texture in the middle of a program's bindings never replaces what an active unit holds
  // (that turned a usampler's R8UI binding into RGBA8 → GL_INVALID_OPERATION, a missing ground frame).
  const scratch = () => gl.activeTexture(gl.TEXTURE0 + caps.maxUnits - 1);
  const tex = {
    /** 2D RGBA8 texture from an ImageBitmap / ImageData / canvas / img. opts: { mips, filter, wrap } */
    image(src, opts = {}) {
      const [w, h] = srcSize(src), t = gl.createTexture(); scratch(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
      if (opts.mips) gl.generateMipmap(gl.TEXTURE_2D);
      params(gl.TEXTURE_2D, opts); stats.uploadedBytes += w * h * 4;
      return track({ t, target: gl.TEXTURE_2D, w, h, layers: 1, levels: opts.mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1, format: 'RGBA8', bytes: w * h * 4 * (opts.mips ? 4 / 3 : 1) });
    },
    /** 2D texture from a typed array (e.g. R8UI deeds, RGBA8UI base state). fmt/type default from internalFmt. */
    data(w, h, internalFmt, fmt, type, arr, opts = {}) {
      const t = gl.createTexture(); scratch(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl[internalFmt], w, h, 0, gl[fmt ?? FORMAT_OF[internalFmt]], gl[type ?? TYPE_OF[internalFmt]], arr ?? null);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      params(gl.TEXTURE_2D, { ...opts, int: isInt(internalFmt) }); stats.uploadedBytes += arr?.byteLength ?? 0;
      return track({ t, target: gl.TEXTURE_2D, w, h, layers: 1, format: internalFmt, bytes: w * h * bytesPerTexel(internalFmt) });
    },
    /** Re-upload all or a rect of a 2D data texture from a typed array covering that rect. */
    update(o, arr, rect = null) {
      if (stale(o)) return;
      const r = rect ?? { x: 0, y: 0, w: o.w, h: o.h };
      scratch(); gl.bindTexture(o.target, o.t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(o.target, 0, r.x, r.y, r.w, r.h, gl[FORMAT_OF[o.format] ?? 'RGBA'], gl[TYPE_OF[o.format] ?? 'UNSIGNED_BYTE'], arr);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4); stats.uploadedBytes += arr.byteLength;
    },
    /** Immutable TEXTURE_2D_ARRAY (texStorage3D). opts: { levels, filter, wrap } */
    array(w, h, layers, internalFmt = 'RGBA8', opts = {}) {
      const levels = opts.levels ?? 1, t = gl.createTexture(); scratch(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl[internalFmt], w, h, layers);
      params(gl.TEXTURE_2D_ARRAY, { ...opts, mips: levels > 1, int: isInt(internalFmt) });
      return track({ t, target: gl.TEXTURE_2D_ARRAY, w, h, layers, levels, format: internalFmt, bytes: mipBytes(w, h, levels) * layers * bytesPerTexel(internalFmt) });
    },
    /**
     * Upload into layer i of an array texture. src: TexImageSource (ImageBitmap/ImageData/canvas) or
     * { data: TypedArray, w, h }. rect: { x, y, w, h } crop of the source (TexImageSource via
     * UNPACK_SKIP_*, or a 2D-canvas slice where the driver lacks sub-rect uploads). level: mip level.
     */
    layer(o, i, src, rect = null, level = 0) {
      if (stale(o)) return;
      scratch(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, o.t);
      const fmt = gl[FORMAT_OF[o.format] ?? 'RGBA'], type = gl[TYPE_OF[o.format] ?? 'UNSIGNED_BYTE'];
      if (src && src.data && !(src instanceof ImageData)) {
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, i, src.w, src.h, 1, fmt, type, src.data);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4); stats.uploadedBytes += src.data.byteLength; return;
      }
      const [sw, sh] = srcSize(src), r = rect ?? { x: 0, y: 0, w: sw, h: sh };
      if (rect && typeof ImageData !== 'undefined' && src instanceof ImageData) { // ImageData (canvas decode path): crop in JS, exact
        // (Chrome rejects UNPACK_SKIP_* sub-rects of an ImageData for small mip levels: INVALID_VALUE on the
        // 2×2 / 1×1 mapkit mips, which then stayed empty on the canvas path only)
        const c = cropImageData(src, r); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, i, r.w, r.h, 1, fmt, type, new Uint8Array(c.data.buffer));
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      } else if (rect && !subRectOk) { // no sub-rect uploads from a TexImageSource: slice it through a 2D canvas
        { const c = document.createElement('canvas'); c.width = r.w; c.height = r.h; const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); src = x.getImageData(0, 0, r.w, r.h); } // premultiplies: RGB under alpha 0 is lost
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, i, r.w, r.h, 1, fmt, type, src);
      } else {
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rect ? sw : 0);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, level, 0, 0, i, r.w, r.h, 1, fmt, type, src);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0); gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      }
      stats.uploadedBytes += r.w * r.h * bytesPerTexel(o.format);
    },
    /** Defer an upload to the next frames' budget (≤ 4 MB per frame on phones, 8 MB on desktop). */
    queue(fn, bytes = 0) { queue.push({ fn, bytes }); invalidate(); },
    free(o) { if (!o || !allocs.has(o)) return; allocs.delete(o); stats.gpuBytes -= o.bytes; for (const [k, f] of fbos) if (k.startsWith(o.uid + ':')) { gl.deleteFramebuffer(f); fbos.delete(k); } gl.deleteTexture(o.t); },
    /**
     * One texture per key across modules (e.g. `${pack.id}:chart8` used by GROUND's chart band and the
     * minimap): the first caller's make() creates it, later callers get the same object. Reset on
     * context restore with everything else.
     */
    shared(key, make) { let o = sharedTex.get(key); if (!o || !allocs.has(o)) { o = make(); sharedTex.set(key, o); } return o; },
    /**
     * 1×1 (×1 layer) placeholder for a sampler that has nothing to show yet. An unbound sampler reads
     * unit 0, and a usampler over a float texture is GL_INVALID_OPERATION: bind a dummy of the right kind.
     * kind: 'float' | 'uint' | 'int'; array: TEXTURE_2D_ARRAY when true.
     */
    dummy(kind = 'float', array = false) {
      const k = `dummy:${kind}:${array}`, fmt = kind === 'uint' ? 'R8UI' : kind === 'int' ? 'R8I' : 'RGBA8';
      return tex.shared(k, () => array ? tex.array(1, 1, 1, fmt, { filter: 'nearest' }) : tex.data(1, 1, fmt, null, null, null, { filter: 'nearest' }));
    },
    /** Free every tracked texture (a realm leaving GPU residency; plan §4.2 "only one realm is GPU-resident"). */
    freeAll() { for (const o of [...allocs]) tex.free(o); sharedTex.clear(); },
    /** Mark a module-created GL resource (e.g. a renderbuffer) in the allocator. */
    account(bytes) { const o = { bytes, t: null }; return track(o); },
  };
  /** A framebuffer with texture o (layer for arrays) as COLOR_ATTACHMENT0; cached. */
  function fbo(o, layer = 0, level = 0) {
    if (stale(o)) return null;
    const k = `${o.uid}:${layer}:${level}`; let f = fbos.get(k);
    if (!f) {
      f = gl.createFramebuffer(); fbKind.set(f, o.format); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      if (o.target === gl.TEXTURE_2D_ARRAY) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, o.t, level, layer);
      else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o.t, level);
      fbos.set(k, f);
    } else gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    return f;
  }

  // ---- size ----
  let W = 1, H = 1, dpr = 1;
  const fbBytes = () => (gl.drawingBufferWidth || 0) * (gl.drawingBufferHeight || 0) * (4 + 4) * Math.max(1, gl.getContextAttributes?.()?.antialias ? 4 : 1);
  function resize() {
    const cw = canvas.clientWidth || canvas.width || 1, ch = canvas.clientHeight || canvas.height || 1, r = Math.min(2, globalThis.devicePixelRatio || 1);
    const dw = Math.max(1, Math.round(cw * r)), dh = Math.max(1, Math.round(ch * r));
    const changed = dw !== canvas.width || dh !== canvas.height || r !== dpr;
    if (dw !== canvas.width) canvas.width = dw; if (dh !== canvas.height) canvas.height = dh;
    dpr = r; W = dw / r; H = dh / r; // W·dpr is exactly the device width (pixel snap relies on it)
    if (changed) invalidate(); return changed;
  }

  // ---- frame scheduler (timed idle policy, plan §7) ----
  const queue = [];
  const anim = new Map(); // tag → periodMs
  let frameFn = null, raf = 0, timer = 0, dirty = true, running = false, lastInput = now(), lastTick = 0, lastBusy = false;
  let animMs = 0, pulseMs = 0, lastClockT = now(), frozen = false, reducedMotion = false, hidden = typeof document !== 'undefined' && document.hidden;
  const budget = () => (globalThis.matchMedia?.('(pointer: coarse)').matches ? 4 : 8) * 1048576;
  function advanceClock(t) {
    const dt = Math.max(0, t - lastClockT); lastClockT = t;
    const phase = t - lastInput < IDLE.freezeMs ? 'live' : 'frozen';
    frozen = phase === 'frozen'; if (!frozen) animMs += dt; pulseMs += dt;
  }
  function tick(t) {
    raf = 0; if (lost || !running || !frameFn) return;
    taskClock.mark(); // a frame is a task start (stage B D1: the lanes' slices share one task clock)
    const t0 = now(); advanceClock(t0);
    if (lastBusy && lastTick) { stats.intervals.push(t0 - lastTick); if (stats.intervals.length > 240) stats.intervals.shift(); }
    lastTick = t0; dirty = false; stats.draws = 0; stats.instances = 0; stats.uploadsLast = 0; layersCur = {}; partsCur = {};
    pollGpu();
    let busy = false; const gq = gpuBegin();
    try { busy = !!frameFn(t0); } catch (e) { console.error('realm frame', e); globalThis.document && (document.body.dataset.rmFrameErr = String(e.stack || e)); }
    gpuEnd(gq, stats.draws > 0);
    stats.frames++; stats.drawsLast = stats.draws; stats.instancesLast = stats.instances; layersLast = layersCur;
    const cpu = now() - t0; stats.cpu.push(cpu); if (stats.cpu.length > 240) stats.cpu.shift();
    partsCur.frame = cpu; partsRing.push(partsCur); if (partsRing.length > 120) partsRing.shift();
    if (marks) try { performance.measure('rm:frame', { start: t0, end: t0 + cpu }); } catch { /* unsupported */ }
    lastBusy = busy || dirty || queue.length > 0;
    schedule();
  }
  function schedule() {
    if (raf || lost || !running) return;
    if (lastBusy) { raf = requestAnimationFrame(tick); return; }
    const periods = [], pulses = [];
    for (const [tag, p] of anim) { if (!(p > 0)) continue; periods.push(p); if (IDLE.pulseTags.includes(tag)) pulses.push(p); }
    const { ms, phase } = idleInterval({ sinceInputMs: now() - lastInput, periods, pulsePeriods: pulses, reducedMotion, hidden, clockMs: animMs });
    stats.idlePhase = phase;
    clearTimeout(timer); timer = 0;
    if (ms === Infinity) return; // 0 fps until input or invalidate()
    timer = setTimeout(() => { timer = 0; if (!raf && running && !lost) raf = requestAnimationFrame(tick); }, ms);
  }
  function invalidate() { dirty = true; if (!running || lost) return; if (timer) { clearTimeout(timer); timer = 0; } if (!raf) raf = requestAnimationFrame(tick); }
  // web port P11: every page-level listener is named, so core.dispose() can remove it (an engine per visit must not leak)
  const onVisibility = () => { hidden = document.hidden; if (!hidden) invalidate(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'), onMotion = e => { reducedMotion = e.matches; invalidate(); };
  if (mq) { reducedMotion = mq.matches; mq.addEventListener?.('change', onMotion); }
  // Long tasks (fix iteration 2, QA GA2 #11): counted ONLY while the realm map owns the page, bucketed by the phase the
  // owner set with core.phase() (enter, load, browse, band, exit); the globe's own load and anything after 'off' is not
  // the realm map's and is ignored. Attribution uses the entry's startTime against the phase timeline.
  const phases = [], ltBy = {};
  const phaseAt = t => { for (let i = phases.length - 1; i >= 0; i--) if (phases[i].t <= t) return phases[i].name; return 'off'; };
  let longTasks = null;
  try { longTasks = new PerformanceObserver(l => { for (const e of l.getEntries()) { const ph = phaseAt(e.startTime); if (ph === 'off') continue;
    stats.longTasks++; stats.longTaskMaxMs = Math.max(stats.longTaskMaxMs, e.duration);
    const b = (ltBy[ph] ??= { n: 0, maxMs: 0, totalMs: 0 }); b.n++; b.maxMs = Math.max(b.maxMs, Math.round(e.duration)); b.totalMs += Math.round(e.duration); } }); longTasks.observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
  // per-layer draw/instance tally of the last frame (fix iteration 2, QA GA2 #1): { 'life.sprite': [draws, instances], … }
  let layersCur = {}, layersLast = {};
  // JS time per tallied frame part (W1 S7): a ring of the last 120 frames' { part: ms }, so a slow frame's JS work is told
  // apart from the software rasteriser's wait (whatever the parts do not cover). ?marks also emits performance.measure()s.
  let partsCur = {}; const partsRing = [];

  // ---- GPU frame cost (P0 RM-GPU-1 watchdog input) ----
  // With EXT_disjoint_timer_query_webgl2 each frame's GPU time is measured exactly (TIME_ELAPSED around frameFn).
  // Always, an occlusion query (ANY_SAMPLES_PASSED_CONSERVATIVE) around the frame acts as a non-blocking fence: its
  // result becomes available once the GPU has finished the frame, and WebGL only updates that flag between tasks, so
  // polling it never stalls (a fenceSync + getSyncParameter is a synchronous round trip to the GPU process in Chrome).
  // Without the timer, the LOWER BOUND of the frame's GPU latency is the last poll that still saw it unfinished, minus
  // the submit time: a main-thread stall only delays the polls, it never inflates the bound, so JS long tasks (decode,
  // module build) are not mistaken for a slow GPU. Results reach 'gpu' listeners as (ms, method, submitT, cold). Polled at every
  // tick and, while frames are in flight and nothing is scheduled, every 16 ms.
  function gpuBegin() {
    if (lost) return null;
    const o = { t: 0, seen: 0, q: null, a: null, f0: stats.firstStates, cold: false, tag: null };
    try { if (tq) { o.q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, o.q); } } catch { o.q = null; }
    try { o.a = gl.createQuery(); gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, o.a); } catch { o.a = null; }
    return o;
  }
  function gpuEnd(o, drew) {
    if (lost || !o) return;
    try { if (o.q) gl.endQuery(tq.TIME_ELAPSED_EXT); if (o.a) gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE); } catch { /* ignore */ }
    // a cold frame drew a program for the first time (the driver builds its pipeline then), saw a background link end,
    // or uploaded more than GPU_SAFE.coldUploadBytes — or follows one (its latency waits for that work): one-off work,
    // never the view's steady cost. Small uploads (page-table entries) stay steady (P0 fix pass #6).
    // (links and uploads count since the previous frame ended: a module's load uploads between frames too)
    const own = isColdFrame({ firstDraws: stats.firstStates - o.f0, rehearsed: stats.rehearsed - rehSeen, links: stats.links - linksSeen, uploadBytes: stats.uploadedBytes - uploadsSeen });
    linksSeen = stats.links; uploadsSeen = stats.uploadedBytes; rehSeen = stats.rehearsed; o.cold = own || lastCold; lastCold = own; o.tag = frameTag; frameTag = null;
    if (!drew || !o.a) { drop(o); return; }
    o.t = now(); gpuPend.push(o);
    while (gpuPend.length > 8) drop(gpuPend.shift());
    armPoll();
  }
  function drop(o) { try { if (o.q) gl.deleteQuery(o.q); if (o.a) gl.deleteQuery(o.a); } catch { /* lost */ } }
  function armPoll() { if (!gpuPoll && gpuPend.length) gpuPoll = setTimeout(() => { gpuPoll = 0; pollGpu(); armPoll(); }, 16); }
  function sample(ms, method, o) { gpuSamples.push(Math.round(ms * 10) / 10); if (gpuSamples.length > 120) gpuSamples.shift(); stats.gpuMethod = method; emit('gpu', ms, method, o.t, o.cold, o.tag); }
  function pollGpu() {
    if (lost) { gpuPend.length = 0; return; }
    const t = now(); let disjoint = false;
    try { disjoint = !!(tq && gl.getParameter(tq.GPU_DISJOINT_EXT)); } catch { /* ignore */ }
    while (gpuPend.length) {
      const p = gpuPend[0];
      try {
        if (!gl.getQueryParameter(p.a, gl.QUERY_RESULT_AVAILABLE)) { p.seen = t; break; } // still on the GPU
        if (p.q && !gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE) && t - p.t < 1000) break; // the timer lags
        if (p.q && gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE) && !disjoint) sample(gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6, 'timer', p);
        else sample(p.seen ? p.seen - p.t : 0, 'latency', p);
      } catch { /* a lost context */ }
      drop(gpuPend.shift());
    }
  }

  // ---- ground render resolution (P0 RM-GPU-1) ----
  // lowres(k, fn): fn draws the full-screen ground passes into a k× target (k < 1), which is then scaled up to the
  // canvas with sharp-bilinear sampling (texel-centre snap in a one-device-px window, like sharpUV: crisp pixel-art
  // edges, no shimmer at 4:3). Only uCam.w (px per CSS px) changes for fn, so fragCss/fragDeed map the smaller
  // target onto the same deed space; uViewport.z (d) keeps its meaning for every LOD threshold. k ≥ 1: fn draws
  // straight to the canvas, byte-identical to before.
  const BLIT_VS = `layout(location = 0) in vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const BLIT_FS = `
#include "common"
uniform sampler2D uLow;
uniform float uK;
out vec4 o;
void main() { vec2 ts = vec2(textureSize(uLow, 0)); o = vec4(texture(uLow, sharpUV(gl_FragCoord.xy * uK) / ts).rgb, 1.0); }`;
  // the k× ground target, (re)allocated to the canvas size
  function lowTarget(k) {
    const w = Math.max(1, Math.ceil(canvas.width * k)), h = Math.max(1, Math.ceil(canvas.height * k));
    if (!lowT || !allocs.has(lowT) || lowT.w !== w || lowT.h !== h) { if (lowT) tex.free(lowT); lowT = tex.data(w, h, 'RGBA8', null, null, null, { filter: 'linear' }); }
    return lowT;
  }
  const setDpr = v => { uboF[3] = v; gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 12, uboF, 3, 1); };
  // (W1 S3: a rest frame at k 1 keeps the ½ target: the next fade reuses it, and it was allocated on dpr 2 all along)
  function lowres(k, fn) {
    lowK = k >= 0.999 ? 1 : k;
    if (lowK === 1) return fn();
    const { w, h } = lowTarget(k);
    if (!blitProg?.ready) { lowK = 1; return fn(); } // (the blit links in the background at init; a failed one never scales)
    const dpr0 = uboF[3];
    fbo(lowT); gl.viewport(0, 0, w, h); gl.clear(gl.COLOR_BUFFER_BIT); setDpr(dpr0 * k);
    try { return fn(); } finally {
      setDpr(dpr0); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
      blitProg.use(); blitProg.tex('uLow', 0, lowT); gl.uniform1f(blitProg.u('uK'), k); core.fullscreen();
    }
  }

  // ---- band rehearsal (P0 fix pass #1/#5, v2 W1 S1; the lane contract is contracts.js GPU_SAFE.rehearse) ----
  // rehearse(fn, { target, k }) runs fn with its pass's real target bound — target 'low': the k× ground target lowres()
  // draws into (UBO dpr × k, as lowres sets it), 'canvas': the canvas; depth off for the ground (ground: true), on (LEQUAL,
  // writes on) for the sprite passes — and the viewport placed so the VIEW CENTRE (clip-space origin) lands in the box ×
  // box px square at the target's origin, with SCISSOR_TEST locked to that square: a draw that covers the view centre
  // shades ≤ box² real fragments (the P0 version's 1×1 box at the corner shaded none, so the driver's fragment work still
  // landed on the band change). At most one NEW (program, state) is drawn per call; the rest are skipped. map.js calls it
  // before the frame's clear, so the square is never seen. Everything fn may have changed that the next pass does not set
  // itself is reset afterwards. → { drew: any draw submitted, complete: no new state was skipped, fresh: new states built }
  function rehearse(fn, { target = 'canvas', k = 1, ground = false } = {}) {
    if (lost) return { drew: false, complete: false, fresh: 0 };
    const B = GPU_SAFE.rehearse.box, dpr0 = uboF[3]; let w = canvas.width, h = canvas.height, scaled = false;
    if (target === 'low' && k < 0.999 && blitProg?.ready) { const t = lowTarget(k); fbo(t); w = t.w; h = t.h; setDpr(dpr0 * k); scaled = true; }
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(Math.round((B - w) / 2), Math.round((B - h) / 2), w, h);
    if (ground) gl.disable(gl.DEPTH_TEST); else { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); }
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); rawScissor(0, 0, B, B); rehearsing = true; rhCall = { fresh: 0, deferred: 0, draws: 0 };
    const c = rhCall;
    try { fn(); } finally {
      rehearsing = false; rhCall = null; if (scaled) setDpr(dpr0);
      gl.bindVertexArray(null); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
      rawDisable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
      gl.depthMask(true); gl.colorMask(true, true, true, true);
    }
    return { drew: c.draws > 0, complete: c.deferred === 0, fresh: c.fresh };
  }
  /** SHELL's own rehearse hook: the ground upscale blit (canvas, depth and blend off), sampling the k× ground target. */
  function rehearseBlit(k) {
    if (!blitProg?.ready || k >= 0.999) return false;
    lowTarget(k); blitProg.use(); blitProg.tex('uLow', 0, lowT); gl.uniform1f(blitProg.u('uK'), k); core.fullscreen(); return true;
  }

  // ---- context loss ----
  const onLost = e => {
    e.preventDefault(); lost = true; stats.contextLosses++; cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); timer = 0; queue.length = 0;
    clearTimeout(pollT); pollT = 0; pending.clear(); cur = null; emit('lost');
  };
  const onRestored = () => {
    lost = false; initGL(); emit('restored'); invalidate();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  initGL();

  // ---- per-frame UBO ----
  function begin(view) {
    core.view = view;
    // uploads within budget (the first job always runs, so a big one cannot starve)
    let used = 0; const b = budget();
    while (queue.length && (used === 0 || used + queue[0].bytes <= b)) { const j = queue.shift(); used += j.bytes || 1; try { j.fn(); } catch (e) { console.error('realm upload', e); } }
    stats.uploadsLast = used;
    const f = uboF, u = uboU, w = view.w ?? {};
    f[0] = view.x; f[1] = view.y; f[2] = view.s; f[3] = view.dpr;
    f[4] = view.W; f[5] = view.H; f[6] = view.d; f[7] = view.safe ? 2 : view.reducedMotion ? 1 : 0; // 2 = GPU safe mode (still + no cloud shade)
    f[8] = view.grid?.cols ?? 0; f[9] = view.grid?.rows ?? 0; f[10] = view.grid?.x0 ?? 0; f[11] = view.grid?.y0 ?? 0;
    f[12] = w.far ?? 0; f[13] = w.map ?? 0; f[14] = w.true ?? 0; f[15] = w.twins ?? 0;
    f[16] = w.decor ?? 0; f[17] = w.creatures ?? 0; f[18] = w.sway ?? 0; f[19] = view.fadeWeight ?? 0;
    f[20] = view.sel?.[0] ?? -1; f[21] = view.sel?.[1] ?? -1; f[22] = view.hov?.[0] ?? -1; f[23] = view.hov?.[1] ?? -1;
    u[24] = view.ms >>> 0; u[25] = view.pulseMs >>> 0; u[26] = view.frozen ? 1 : 0; u[27] = stats.frames >>> 0;
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, uboData); gl.bindBufferBase(gl.UNIFORM_BUFFER, UBO_VIEW, ubo);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
  }

  const core = {
    gl, canvas, get caps() { return caps; }, get features() { return features; }, featuresReady,
    get W() { return W; }, get H() { return H; }, get dpr() { return dpr; }, resize,
    get lost() { return lost; },
    /** Draw calls submitted so far in the frame being drawn (map.js: did a pass draw anything?). */
    get drawsNow() { return stats.draws; },
    program, include(name, src) { includes.set(name, src); }, tex, lru, fbo, begin, lowres, rehearse, rehearseBlit,
    /** The ground upscale blit program (SHELL's own; map.js rehearses it with the ground's ½ target). */
    get blitProgram() { return blitProg; },
    /** The label (map.js: the band) of the frame being drawn; a program's first draw records it (stats().programs.firstDrawn). */
    get drawTag() { return drawTag; }, set drawTag(v) { drawTag = String(v ?? ''); },
    /** What the frame being drawn was (map.js: its ground pass and level), handed back with its GPU sample ('gpu' listeners' 6th argument). */
    set frameTag(v) { frameTag = v ?? null; },
    /** Programs whose background link ended successfully and that were never drawn (their pipeline is still cold). */
    coldPrograms() { return [...programs.values()].filter(p => p.state === 'ready' && !p.drawn); },
    /** The WebGL renderer string (unmasked where allowed) and whether it is a software rasteriser (SwiftShader). */
    renderer, software,
    /** Draw the fullscreen triangle (attribute 0 = clip-space xy). */
    fullscreen() { gl.bindVertexArray(triVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null); },
    /** The shared unit-quad VAO (attribute 0 = 0..1 corner, 6 vertices) — bind, add your instance attributes via your own VAO if needed. */
    get quadVao() { return quadVao; },
    /** The unit-quad vertex buffer (vec2 0..1 × 6) for modules building their own instanced VAO. */
    get quadBuffer() { return quadBuf; },
    view: null,
    // scheduler
    run(fn) { frameFn = fn; running = true; invalidate(); },
    stop() { running = false; cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); timer = 0; },
    /** web port P11: the engine is being thrown away. Stops the scheduler, removes every listener core added (document,
     *  matchMedia, the long-task observer, the canvas) and counts as lost from now on, so no later load or frame runs on it;
     *  no 'lost' is emitted: a deliberate teardown is not a GPU reset. */
    dispose() {
      core.stop(); frameFn = null; lost = true; clearTimeout(pollT); pollT = 0; queue.length = 0; pending.clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      mq?.removeEventListener?.('change', onMotion);
      try { longTasks?.disconnect(); } catch { /* unsupported */ }
      canvas.removeEventListener?.('webglcontextlost', onLost); canvas.removeEventListener?.('webglcontextrestored', onRestored);
      for (const set of Object.values(listeners)) set.clear();
    },
    get running() { return running; },
    invalidate,
    /** User input happened: leaves any idle phase (and resumes a frozen clock). */
    input() { lastInput = now(); if (frozen) { frozen = false; lastClockT = now(); } invalidate(); },
    /** Declare that something on screen animates with this frame period (ms); 0 = stopped. Tags: see IDLE.pulseTags. */
    animating(tag, periodMs) { if (periodMs > 0) anim.set(tag, periodMs); else anim.delete(tag); },
    get reducedMotion() { return reducedMotion; }, set reducedMotion(v) { reducedMotion = !!v; invalidate(); },
    /** Animation clock (ms) — frozen after the idle freeze; `freezeMs` pins it for captures. */
    clock() { const t = now(); advanceClock(t); return freezeMs != null ? { ms: freezeMs, pulseMs: freezeMs, frozen: false } : { ms: Math.floor(animMs), pulseMs: Math.floor(pulseMs), frozen }; },
    sinceInput: () => now() - lastInput,
    on(ev, f) { listeners[ev].add(f); return () => listeners[ev].delete(f); },
    /** Drop the default framebuffer to 1×1 while the realm map is closed (the next resize() restores it). */
    shrink() { canvas.width = 1; canvas.height = 1; },
    /** Mark the realm map's phase for long-task attribution ('off' = not the realm map's time). */
    phase(name) { if (phases.at(-1)?.name === name) return; phases.push({ t: now(), name }); if (phases.length > 256) phases.splice(0, phases.length - 256); },
    get currentPhase() { return phases.at(-1)?.name ?? 'off'; },
    /** Run fn and add the draw calls and instances it submitted to this frame's tally under `name`. */
    tally(name, fn) {
      const d0 = stats.draws, i0 = stats.instances, t0 = now();
      try { return fn(); } finally {
        const t1 = now(), o = (layersCur[name] ??= [0, 0]); o[0] += stats.draws - d0; o[1] += stats.instances - i0; partsCur[name] = (partsCur[name] ?? 0) + (t1 - t0);
        if (marks) try { performance.measure('rm:' + name, { start: t0, end: t1 }); } catch { /* User Timing L3 unsupported */ }
      }
    },
    /** QA: force a context loss / restore through WEBGL_lose_context. */
    loseContext() { loseExt?.loseContext(); return !!loseExt; },
    /**
     * QA only (RM-GPU-1 first-visit attribution, stage B; qa/w1-firstvisit.mjs): read every texel of every tracked texture
     * back — every layer and level, in ≤ 64k-texel strips — through a scratch framebuffer, with no sampling and no pipeline.
     * A software rasteriser then holds all of its texture memory resident again (the host may have compressed or swapped
     * it). Uses core's own registry, so no GL wrapper is needed (GROUND's wrapper run drew nothing). Never called by the
     * product: a readback drains the GPU pipe. → [{ format, w, h, layers, levels, bad, ms }] (bad: incomplete attachments).
     */
    qaTouch() {
      const out = [], f = gl.createFramebuffer(), prev = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      rawBindFb(gl.FRAMEBUFFER, f);
      for (const o of allocs) {
        if (!o.t) continue; const t0 = now(), lv = o.levels ?? 1, n = o.layers ?? 1; let bad = 0;
        const int = /UI$/.test(o.format), sint = !int && /\dI$/.test(o.format), flt = /F$/.test(o.format);
        for (let L = 0; L < lv; L++) {
          const w = Math.max(1, o.w >> L), h = Math.max(1, o.h >> L), rows = Math.max(1, Math.floor(65536 / w)), len = w * rows * 4;
          const buf = int ? new Uint32Array(len) : sint ? new Int32Array(len) : flt ? new Float32Array(len) : new Uint8Array(len);
          for (let z = 0; z < n; z++) {
            if (o.target === gl.TEXTURE_2D_ARRAY) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, o.t, L, z);
            else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, o.t, L);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { bad++; continue; }
            for (let y = 0; y < h; y += rows) gl.readPixels(0, y, w, Math.min(rows, h - y), int || sint ? gl.RGBA_INTEGER : gl.RGBA, int ? gl.UNSIGNED_INT : sint ? gl.INT : flt ? gl.FLOAT : gl.UNSIGNED_BYTE, buf);
          }
        }
        out.push({ format: o.format, w: o.w, h: o.h, layers: n, levels: lv, bad, ms: Math.round(now() - t0) });
      }
      rawBindFb(gl.FRAMEBUFFER, prev); gl.deleteFramebuffer(f);
      while (gl.getError()) { /* drain what an unreadable attachment raised */ }
      return out;
    },
    restoreContext() { loseExt?.restoreContext(); return !!loseExt; }, // (getExtension returns null once lost: cached at start)
    stats() {
      const iv = stats.intervals, cpu = stats.cpu, p50 = pct(iv, 0.5), p95 = pct(iv, 0.95);
      return { fps: { p50: p50 ? 1000 / p50 : 0, p95FrameMs: p95 }, frameMs: pct(cpu, 0.5), frameMsP95: pct(cpu, 0.95),
        // gpuMB includes the default framebuffer (fix iteration 1: the plan's memory table budgets it, ~10 MB on a
        // dpr-2 phone): RGBA8 colour + 24-bit depth (stored as 32) per device px, no MSAA (antialias: false)
        drawCalls: stats.drawsLast, instances: stats.instancesLast, gpuMB: (stats.gpuBytes + fbBytes()) / 1048576, texMB: stats.gpuBytes / 1048576, fbMB: fbBytes() / 1048576, frames: stats.frames,
        longTasks: stats.longTasks, longTaskMaxMs: stats.longTaskMaxMs, longTaskPhases: structuredClone(ltBy), phase: phases.at(-1)?.name ?? 'off',
        layers: structuredClone(layersLast), idlePhase: stats.idlePhase, contextLosses: stats.contextLosses,
        uploadedMB: stats.uploadedBytes / 1048576, uploadLastMB: stats.uploadsLast / 1048576, pendingUploads: queue.length,
        animating: Object.fromEntries(anim), features, caps,
        // background program links (P0): linkMs = issue → observed end (poll granularity GPU_SAFE.pollMs), waiting = still linking
        programs: { total: programs.size, pending: pending.size, parallel: !!pexec, skippedDraws: stats.skippedDraws, firstDraws: stats.firstDraws,
          failed: [...programs.values()].filter(p => p.state === 'failed').map(p => p.name),
          linkMs: Object.fromEntries([...programs.values()].filter(p => p.state === 'ready').map(p => [p.name, p.ms])),
          waiting: Object.fromEntries([...pending].map(p => [p.name, Math.round(now() - p.t0)])),
          // band rehearsal: cold = linked but never drawn (a first draw ahead); firstDrawn = where each first draw happened
          cold: core.coldPrograms().map(p => p.name), rehearsedDraws: stats.rehearsed,
          firstDrawn: Object.fromEntries([...programs.values()].filter(p => p.drawn).map(p => [p.name, p.firstIn])),
          // W1 S1: first draws per (program, GL state); states per program; real first uses of a state the rehearsal never built
          firstStates: stats.firstStates, states: Object.fromEntries([...programs.values()].filter(p => p.states.size).map(p => [p.name, p.states.size])),
          stateMisses: stats.stateMisses.slice(), rehearsalDeferred: stats.rehearsalDeferred },
        // W1 S7: JS ms per frame part over the last 120 frames (p50 / p95 / max); `frame` = the whole frame's JS
        frameParts: (() => { const out = {}, keys = new Set(partsRing.flatMap(o => Object.keys(o)));
          for (const k of keys) { const v = partsRing.map(o => o[k] ?? 0); out[k] = { p50: +pct(v, 0.5).toFixed(2), p95: +pct(v, 0.95).toFixed(2), max: +Math.max(...v).toFixed(2) }; }
          return out; })(),
        gpu: { method: stats.gpuMethod ?? (tq ? 'timer' : 'latency'), timerExt: !!tq, last: gpuSamples.slice(-12), p50: pct(gpuSamples, 0.5), p95: pct(gpuSamples, 0.95),
          max: gpuSamples.length ? Math.max(...gpuSamples) : 0, n: gpuSamples.length, groundScale: lowK, lowresPx: lowT ? [lowT.w, lowT.h] : null, software, renderer } };
    },
  };
  return core;
}
