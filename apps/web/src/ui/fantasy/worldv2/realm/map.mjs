// Realm map v2 (D-162/D-163/D-164): the integrator. Implements realmmap.js's public API so main.js
// needs no change (has / enter / active / select / realm.bases / leave), and composes the lane modules:
//   GROUND (ground.js) · LIFE (life.js) · BASES (bases.js, demo-bases.js)
// Lane modules come from the virtual module 'realm:lanes' that build-realm.mjs generates from the lane
// files that exist AND compile at build time, so a missing or half-edited lane file never breaks this
// bundle — its slot runs on a SHELL stub until it lands (plan §10.3). A lane that throws at runtime is
// disabled for the session and reported in stats().modules (Rule 12: fail loud, never silently).
//
// Frame order (plan §10.2): core.begin → ground/life/bases.update → ground.draw → life/bases 'shadow'
//   → clear depth → bases 'shieldBack' → life/bases 'sprite' → bases 'shieldFront' → life 'air',
//   bases 'fx' → minimap → DOM tags/labels.
// web port (patches.md P1): build-realm.mjs generated a virtual lanes module from the lane files that compiled;
// the web bundler code-splits these literal imports into the lane chunks that load at the dive.
const lanes = { ground: () => import('./ground.mjs'), life: () => import('./life.mjs'), bases: () => import('./bases.mjs') }, laneErrors = {};
import { BANDS, SELECT_D, MY_BASE_D, DEED_DEG, FLAG, KIND, DEED_PX, IDLE, GROUND_API, GPU_SAFE, plotRule, plotCentre, REALM_NAMES, UNITS } from './contracts.mjs';
import { createCore, qualityStep, groundScale, groundDiv, gpuRecord, rehearsalHeld, retryAt, govStep, bandLimit, governedPass } from './core.mjs';
import { createCamera, bindGestures, bands, restTarget, landing } from './camera.mjs';
import { openRealm, openShared, realmIndex } from './loader.mjs';
import { createMinimap } from './minimap.mjs';
import { taskClock } from './slice.mjs';

const q = new URLSearchParams(globalThis.location?.search ?? '');

// ---- module generations ----------------------------------------------------------------------------------
// Each set of lane modules is one generation, bumped by a context loss or a realm change. A generation's
// modules get a core and packs that refuse work once it is stale: the next loader call rejects and the next
// core.tex / program call throws, with a `stale` error the lane guard swallows. So a load() still streaming
// when the context is lost can never upload into the restored context (Gate A PM-2: +30 MB, each lane
// finishing twice, GL_INVALID_OPERATION after a loss during the dive's upload burst).
function staleError() { const e = Error('stale realm-map module generation'); e.stale = true; return e; }
// progs (optional): a Set that collects every program the module creates, for the lane's link gate (P0 async compile)
function scopeCore(core, live, progs = null) {
  const guarded = (t, v) => (...a) => { if (!live()) throw staleError(); return v.apply(t, a); };
  const wrap = (obj, pass) => { const fns = new Map(); return new Proxy(obj, { get(t, k) {
    const v = t[k]; if (typeof v !== 'function') return v;
    let f = fns.get(k); if (!f) fns.set(k, f = pass.has(k) ? v.bind(t) : guarded(t, v)); return f; } }); };
  const tex = wrap(core.tex, new Set(['free'])); // freeing is always safe (a stale object is a no-op in core)
  const GUARD = new Set(['program', 'include', 'fbo', 'fullscreen']), fns = new Map();
  return new Proxy(core, { get(t, k) {
    if (k === 'tex') return tex;
    const v = t[k]; if (typeof v !== 'function') return v;
    let f = fns.get(k);
    if (!f) fns.set(k, f = k === 'program' && progs ? (...a) => { if (!live()) throw staleError(); const p = v.apply(t, a); progs.add(p); return p; } : GUARD.has(k) ? guarded(t, v) : v.bind(t));
    return f; } });
}
function scopePack(pk, live) {
  if (!pk) return pk; const fns = new Map();
  return new Proxy(pk, { get(t, k) {
    const v = t[k]; if (typeof v !== 'function') return v;
    let f = fns.get(k); if (!f) fns.set(k, f = (...a) => (live() ? v.apply(t, a) : Promise.reject(staleError()))); return f; } });
}
/** Encoded bytes of the realm engine's own JS (entry + chunks) the page has fetched (resource timing). */
function engineBytes() {
  try { return performance.getEntriesByType('resource').filter(e => /\/dist\/(live\/)?(realm-engine|realm-dev|realm-chunks\/)[^?#]*\.js/.test(e.name)).reduce((s, e) => s + (e.encodedBodySize || e.transferSize || 0), 0); } catch { return 0; }
}

// ---- stubs (used until the owning lane's module lands) ----------------------------------------------------
// "classes" include stub (plan §10.3): WILD everywhere until GROUND registers the real one.
const CLASSES_STUB = `
uint mapClassAt(ivec2 v) { return 4u; }
uint mapClassFine(ivec2 t) { return 4u; }
uint classAtTile(ivec2 t) { return 4u; }
bool pageResident(ivec2 deed) { return false; }
uvec4 tileRecord(ivec2 t) { return uvec4(0u); }
float plotSdf(vec2 tile) { return 1e4; }
bool walkable(ivec2 t) { return true; }
`;
// SHELL's stand-in ground: the painted chart in deed space, deed lines, occupancy dots (no other-realm veil: owner 2026-09-26).
const STUB_VS = `layout(location = 0) in vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
const STUB_FS = `
#include "common"
uniform sampler2D uChart;
uniform highp usampler2D uOcc;   // R8UI: 0 none/open, 1 base, 2 mine (+4 selected)
uniform highp usampler2D uDeeds; // R8UI: deeds.png value
out vec4 o;
void main() {
  vec2 p = fragDeed();
  vec2 g = uGrid.xy;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, g))) { o = vec4(0.05, 0.13, 0.27, 1.0); return; } // GROUND's chart band owns the real sea
  vec2 tsz = vec2(textureSize(uChart, 0));
  vec2 px = sharpUV(p / g * tsz);
  vec3 col = textureGrad(uChart, px / tsz, dFdx(p / g), dFdy(p / g)).rgb;
  ivec2 cell = ivec2(floor(p));
  uint dv = texelFetch(uDeeds, cell, 0).r;
  vec2 f = fract(p);
  float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * uViewport.z; // device px to the deed edge
  float lineA = smoothstep(16.0, 32.0, uViewport.z) * (1.0 - smoothstep(400.0, 800.0, uViewport.z)) * 0.18;
  if (dv > 200u) col = mix(col, vec3(1.0, 0.97, 0.86), (1.0 - smoothstep(0.4, 1.3, edge)) * lineA);
  uint occ = texelFetch(uOcc, cell, 0).r;
  if ((occ & 3u) != 0u) {
    float r = length(f - 0.5) * uCam.z;                // CSS px from the deed centre
    float rad = clamp(0.28 * uCam.z, 1.0, 7.0);
    vec3 tint = (occ & 3u) == 2u ? vec3(1.0, 0.8, 0.3) : vec3(0.93, 0.96, 1.0);
    col = mix(col, tint, (1.0 - smoothstep(rad - 1.0, rad, r)) * 0.92);
  }
  if ((occ & 4u) != 0u) col = mix(col, vec3(1.0, 0.86, 0.4), (1.0 - smoothstep(1.0, 2.5, edge)) * (0.75 + 0.25 * sin(float(uClock.y) * 0.004)));
  o = vec4(col, 1.0);
}`;
function stubGround(core) {
  const gl = core.gl; let prog, chart, deeds, occ, R;
  return {
    stub: true, ready: { map: false, true: false },
    async load(pack) {
      R = pack; prog = core.program('stub-ground', { vs: STUB_VS, fs: STUB_FS });
      chart = core.tex.shared(`${pack.id}:chart8`, () => core.tex.image(pack.first.chart8, { mips: true }));
      const { cols, rows } = pack.meta.grid;
      deeds = core.tex.shared(`${pack.id}:deeds`, () => core.tex.data(cols, rows, 'R8UI', null, null, pack.first.deeds));
      occ = core.tex.data(cols, rows, 'R8UI', null, null, new Uint8Array(cols * rows));
    },
    setOccupancy(arr) { if (occ) core.tex.update(occ, arr); },
    setBaseState() {},
    update() {},
    draw() {
      if (!prog) return;
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      prog.use(); prog.tex('uChart', 0, chart); prog.tex('uOcc', 1, occ); prog.tex('uDeeds', 2, deeds);
      core.fullscreen();
    },
    bindClasses(p, first) { return first; }, classState: () => null,
    stats: () => ({ stub: true }), dispose() {},
    get R() { return R; },
  };
}
/** Where a base's plot is drawn, in fractional deed units: the deed centre moved by plotOffset (visual only,
 *  round 2). Fly targets, card focus, tags and the minimap aim here; picking and selection stay per deed.
 *  An open deed (no level) is its deed centre. */
export const plotAt = b => (b.free || typeof b.level !== 'number' ? { x: b.x + 0.5, y: b.y + 0.5 } : plotCentre(b.x, b.y, b.level));
/**
 * Does kingdom b pass filter f ({ kind, lvl: [lo, hi] })? The keep-level range first, then the chip: 'mine' → yours,
 * 'unshielded' → its shield bit is explicitly false (D-191: a read that carries no shield key is unknown and never
 * passes — D-181 hidden, never faked), 'clan' / 'attack' for the engine's own chrome (myClan = your clan), else every
 * kingdom. A kingdom that fails is HIDDEN on the map (bases.mjs), not dimmed: players read a dimmed keep as the filter
 * doing nothing (owner 2026-09-28, D-191).
 */
export function filterPasses(f, b, myClan = null) {
  if (b.level < f.lvl[0] || b.level > f.lvl[1]) return false;
  switch (f.kind) {
    case 'mine': return b.mine;
    case 'clan': return !!b.clan && b.clan === myClan;
    case 'attack': return b.attackable;
    case 'unshielded': return b.shield === false;
    default: return true;
  }
}
const noLane = { stub: true, load: async () => {}, setBaseState() {}, update() {}, draw() {}, stats: () => ({ stub: true }), dispose() {} };

// web port (patches.md P3): the concept's demo population and its adoption of the globe's demo base are removed.
// Every kingdom comes from the host's live feeds through api.setBases(realmId, list) (worldv2/realm/adapter.ts).

// ---- GPU safety (P0, KNOWN_ISSUES RM-GPU-1) ----------------------------------------------------------------
// The realm map hung the owner's whole Mac GPU (2026-09-24). Three layers here, on top of GROUND's bounded loops:
// the ground passes render at ≤ GPU_SAFE.groundPx px per CSS px (core.lowres), a watchdog steps the quality down
// when frames cost > 50 ms of GPU time, and a lost context (or a session that died inside the map) restarts in safe
// mode — never the same view again in a loop; a second loss stops the realm map until the page is reloaded.
// localStorage[GPU_SAFE.storeKey] = core.gpuRecord's record: `pending` is set while a realm is on screen and cleared on a
// clean leave and pagehide, so a crash, a force-quit or a frozen machine leaves it behind (W1 S5: the stored level then
// holds for 2 × crashes clean visits, and a freeze even at level 2 holds the map until the player's TRY AGAIN).
// band → index: 0 FAR, 1 MAP (and the FAR→MAP fade), 2 TRUE (and the MAP→TRUE fade). The rehearsal's set 1 gates
// d > farEnd and set 2 d > trueStart; crash memory stores the index of the band a visit was in.
const BAND_SET = { far: 0, 'far-map': 1, map: 1, 'map-true': 2, true: 2 };
const gpuStore = {
  get() { try { return JSON.parse(localStorage.getItem(GPU_SAFE.storeKey) || 'null'); } catch { return null; } },
  set(v) { try { if (v) localStorage.setItem(GPU_SAFE.storeKey, JSON.stringify(v)); else localStorage.removeItem(GPU_SAFE.storeKey); } catch { /* storage off */ } },
};
/** A small HUD notice at the top of the page (outside #realmUI, so it survives the exit to the globe). */
function gpuNotice(text, { label = null, onClick = null, ms = 9000 } = {}) {
  if (typeof document === 'undefined') return;
  let t = document.getElementById('rm-gpu-notice');
  if (!t) {
    t = document.createElement('div'); t.id = 'rm-gpu-notice'; t.setAttribute('role', 'status');
    t.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 64px);transform:translateX(-50%);z-index:9999;display:flex;gap:12px;align-items:center;max-width:calc(100vw - 32px);box-sizing:border-box;padding:8px 8px 8px 14px;background:var(--sk-surface,#1a171e);border:2px solid var(--sk-gold,#e3ae3c);box-shadow:0 0 0 2px #0b0a10,0 6px 18px rgba(0,0,0,.5);color:var(--sk-text,#efe8d6);font:20px/1.1 var(--hud-font,VT323,monospace);letter-spacing:.03em';
    document.body.appendChild(t);
  }
  t.replaceChildren(Object.assign(document.createElement('span'), { textContent: text }));
  const btn = (txt, f, gold) => { const b = document.createElement('button'); b.textContent = txt; b.style.cssText = `flex:none;min-width:44px;min-height:44px;padding:0 12px;border:0;border-radius:0;background:${gold ? 'var(--sk-gold,#e3ae3c)' : 'transparent'};color:${gold ? '#1a171e' : 'inherit'};font:20px/1 var(--hud-font,VT323,monospace);cursor:pointer`; b.onclick = f; t.appendChild(b); };
  if (label && onClick) btn(label, () => { t.remove(); onClick(); }, true);
  btn('✕', () => t.remove(), false); t.lastChild.setAttribute('aria-label', 'Close');
  clearTimeout(gpuNotice.timer); if (ms) gpuNotice.timer = setTimeout(() => t.remove(), ms);
}
/** web port P11: take the notice down (the world that showed it is gone: its fixed banner must not sit over other screens). */
function clearGpuNotice() {
  clearTimeout(gpuNotice.timer); gpuNotice.timer = 0;
  if (typeof document !== 'undefined') document.getElementById('rm-gpu-notice')?.remove();
}

/**
 * createRealmMap({ canvas, ui, pack, keepImages /*ignored*\/, avatarURL, onExit, options })
 *   → { active, cam, realm, select(b, fly), step(dir), flyTo(x, y, s, ms), has(id), enter(id, lon, lat, sStart),
 *       setBases(realmId, list), leave(), stats(), realms(), ready }
 * web port options (patches.md): hud (the HUD sheet module, or null), host (ui.mjs host mode: the React HUD owns the
 * chrome and the card), markers (bases.mjs: MAP-range kingdoms as dots + tags, native 82c91fc/560fe54), chart16
 * (false: the pack ships no chart16 pages, the FAR chart stays chart8).
 */
export function createRealmMap({ canvas, ui: uiRoot, pack: packRoot = './pack/', avatarURL = () => '', onExit, options = {} }) {
  const opt = { decode: q.get('decode') || 'auto', verify: q.has('verify'), freeze: q.has('freeze') ? Number(q.get('freeze')) : null,
    rm: q.get('rm'), statsOverlay: q.has('stats'), gpx: q.has('gpx') ? Number(q.get('gpx')) : null, gpusafe: q.get('gpusafe'), gpuwd: q.get('gpuwd'), rehearse: q.get('rehearse'),
    marks: q.has('marks'), ...options };
  const core = createCore(canvas, { freezeMs: opt.freeze, marks: opt.marks });
  // web port P11/P13: disposed = api.dispose() ran (a deliberate teardown: its context loss is not a GPU reset);
  // suspended = the page is hidden mid-visit and the crash marker is lifted until it shows again
  let disposed = false, suspended = false;
  // GPU safety state (see gpuNotice/gpuRecord above). A software rasteriser (SwiftShader QA) cannot hang the GPU:
  // there the watchdog only measures (?gpuwd=1 makes it act) and the stored markers are neither read nor written.
  // floor: the lowest level the watchdog may step back up to (a stored crash or a lost context holds safe mode for the
  // session; the player's FULL DETAIL clears it); good / wentUp / upLock / cold: core.qualityStep's state (P0 fix pass #3)
  const Q = { level: 0, floor: 0, reason: null, changedAt: 0, steps: [], losses: 0, stopped: false, samples: [], good: 0, wentUp: false, upLock: false, cold: 0,
    act: opt.gpuwd === '1' || (!core.software && opt.gpuwd !== '0'), qaLoss: false, hold: false, dirtyVisit: false,
    // this visit's band and steady samples per band (crash memory's clean-visit evidence, W1 fix pass 2 #6); cold frames'
    // GPU ms (one-off first-use work: Gate B reads its size on a real GPU, fix pass 2 #2)
    visit: { band: 0, steady: [0, 0, 0] }, coldGpu: { n: 0, maxMs: 0, last: [] } };
  { const st = gpuRecord.start(core.software ? null : gpuStore.get(), Date.now(), opt.gpusafe); if (!core.software) gpuStore.set(st.rec);
    Q.hold = st.hold; if (st.level) { Q.level = Q.floor = st.level; Q.reason = st.reason; Q.steps.push({ level: st.level, reason: st.reason, atStart: true }); } }
  // the ground render scale for a frame (W1 S3/S4): pass = the ONE ground display pass drawn, null in a cross-fade
  let lastPass = null;
  // stage B D2: the level-0 frame-rate governor for MAP rest (core.govStep, contracts GPU_SAFE.gov). on = MAP rest renders
  // at n0 (½ on dpr 2, as in a fade); it acts only where the watchdog acts (a real GPU), a software rasteriser measures
  const G = { on: false, samples: [], good: 0, wentUp: false, lock: false, acts: 0, steps: [], gen: 0 }; // gen: frames drawn before a switch are not samples of the new k
  const govOn = () => G.on && Q.act;
  const kFor = (pass, L = Q.level) => (opt.gpx > 0 ? groundScale(core.dpr, opt.gpx) : 1 / groundDiv(core.dpr, L, governedPass(pass, L, govOn())));
  const effQ = L => ({ k: kFor(lastPass, L), heavy: GPU_SAFE.heavy[L] });
  // persist: a lost context stores level 2 as a crash (core.gpuRecord.loss: the next visits must not re-run the hang). A
  // watchdog step is not stored: it is re-measured within a few frames, and a slow-but-alive GPU is not a hazard.
  function setLevel(L, reason, { persist = false, floor = null } = {}) {
    L = Math.min(2, Math.max(0, L)); if (floor != null) Q.floor = Math.min(2, Math.max(0, floor));
    if (persist && !core.software) gpuStore.set(gpuRecord.loss(gpuStore.get(), Date.now(), reason, Q.visit.band));
    if (L === Q.level) return;
    Q.level = L; Q.reason = reason; Q.changedAt = performance.now(); Q.steps.push({ level: L, reason, t: Math.round(Q.changedAt) }); Q.samples.length = 0; Q.good = 0;
    if (!core.software && !persist && L === 0) gpuStore.set(gpuRecord.tryAgain(gpuStore.get())); // FULL DETAIL (keeps the crash count)
    core.invalidate();
  }
  // a visit in progress (enter), the band it is in (a freeze leaves it behind), and its end (leave, pagehide): a visit that
  // lost its context is not a clean one, nor is one that never drew GPU_SAFE.crash.steady steady frames in a band at or
  // above the band that froze (gpuRecord.leave)
  const steadyBand = () => { for (let b = 2; b >= 0; b--) if (Q.visit.steady[b] >= GPU_SAFE.crash.steady) return b; return -1; };
  const markPending = on => { if (on) Q.visit = { band: 0, steady: [0, 0, 0] }; if (core.software) return; const r = gpuStore.get();
    if (on) { Q.dirtyVisit = false; gpuStore.set(gpuRecord.enter(r, Date.now())); }
    else if (r?.pending) { if (Q.dirtyVisit) { delete r.pending; delete r.band; gpuStore.set(r); } else gpuStore.set(gpuRecord.leave(r, { steadyBand: steadyBand() })); } };
  const markBand = b => { if (b === Q.visit.band) return; Q.visit.band = b; if (core.software) return; const r = gpuStore.get(); if (r?.pending) gpuStore.set(gpuRecord.at(r, b)); };
  const onPageHide = () => markPending(false);
  globalThis.addEventListener?.('pagehide', onPageHide);
  // Only STEADY frames are samples (P0 fix pass #3/#6): a frame with a first draw, a link completion or a big upload (and
  // the frame after it) is one-off work — the owner's first zoom-in must not land in safe mode because rm-map's pipeline
  // took a second to build. Safe mode's notice therefore always rests on steady-frame evidence.
  core.on('gpu', (ms, method, t, cold, tag) => {
    if (!active || t < Q.changedAt) return; // frames submitted before a level change say nothing about the new level
    if (cold) { const c = Q.coldGpu; c.n++; c.maxMs = Math.max(c.maxMs, ms); c.last.push(Math.round(ms)); if (c.last.length > 8) c.last.shift(); }
    else Q.visit.steady[BAND_SET[lastView?.band] ?? 0]++;
    // stage B D2: the MAP-rest governor reads the steady samples of frames that drew MAP alone at level 0 (tag: that frame's
    // pass and level, core.frameTag) on a screen where n0 is a real cut (dpr > 1.5); anything else is not its cost
    if (!cold && tag && tag.gov === G.gen) {
      const { g, act } = govStep(G, ms, t, tag.pass === 'map' && tag.level === 0 && groundDiv(core.dpr, 0, null) > 1);
      Object.assign(G, g);
      if (act) { G.steps.push({ act, t: Math.round(t), ms: Math.round(ms), acting: Q.act }); if (G.steps.length > 6) G.steps.shift(); G.gen++; if (Q.act) core.invalidate(); }
    }
    if (!Q.act) { if (cold) Q.cold++; else { Q.samples.push(ms); if (Q.samples.length > GPU_SAFE.window) Q.samples.shift(); } return; } // measure only (SwiftShader)
    const seen = cold ? [] : [...Q.samples, ms].slice(-GPU_SAFE.window), { s, act } = qualityStep(Q, ms, cold, effQ);
    Object.assign(Q, { samples: s.samples, good: s.good, cold: s.cold ?? Q.cold, wentUp: s.wentUp, upLock: s.upLock });
    if (!act) return;
    setLevel(s.level, act === 'down' ? `slow GPU frames (${seen.map(v => Math.round(v)).join(', ')} ms)` : `steady GPU frames (${GPU_SAFE.upAfter} at ≤ ${GPU_SAFE.upMs} ms)`);
    if (act === 'down' && s.level >= 2) gpuNotice('Slow graphics: the map switched to safe mode (lower detail, no animation).');
  });
  if (opt.rm === '1') core.reducedMotion = true; else if (opt.rm === '0') core.reducedMotion = false;
  const gl = core.gl, cam = createCamera();
  const modStatus = {};
  let index = null, R = null, P = null, shared = null, active = false, selected = null, hovered = null;
  let ground = null, life = noLane, basesMod = null, minimap = null, ui = null, gen = 0, modGen = -1, modPack = null, modShared = null, realmLoading = false;
  // P0 async compile: each lane's programs (collected by its scoped core) and the painted overview that holds the ground
  // slot while GROUND's programs still link in the background
  let laneProgs = {}, overview = null;
  let keepMeta = null, enterTiming = {}, firstDrawMs = 0, bytesAtFirst = 0, packAtFirst = 0, engineAtFirst = 0, mapReadyMs = 0, enterT0 = 0, occArr = null, filterState = { kind: 'all', lvl: [1, 20] }, filtered = [], filteredSet = new Set();
  const indexReady = realmIndex(packRoot).then(ix => { index = ix; return ix; }).catch(e => { console.error('realm index', e); index = { realms: [] }; return index; });

  // ---- lane modules -----------------------------------------------------------------------------------
  async function laneModule(name) {
    const imp = lanes[name]; if (!imp) { modStatus[name] = `stub (${laneErrors[name] ?? 'not present'})`; return null; }
    try { const m = await imp(); modStatus[name] = 'loaded'; return m; } catch (e) { modStatus[name] = 'failed: ' + e.message; console.error(`realm lane ${name}`, e); return null; }
  }
  const guard = (name, obj) => { // a lane that throws is disabled, loudly, instead of killing the frame
    if (!obj || obj.stub) return obj;
    return new Proxy(obj, { get(t, k) { const v = t[k]; if (typeof v !== 'function') return v;
      if (k === 'rehearse') return (...a) => v.apply(t, a); // a failed rehearsal skips that program (map.js rehearse), never the lane
      return (...a) => { if (modStatus[name]?.startsWith('disabled')) return undefined; try { const r = v.apply(t, a); if (r?.catch) return r.catch(e => { disable(name, e); }); return r; } catch (e) { disable(name, e); return undefined; } }; } });
  };
  function disable(name, e) { if (e?.stale) return; modStatus[name] = 'disabled: ' + (e?.message || e); console.error(`realm lane ${name} disabled`, e); globalThis.document && (document.body.dataset.rmLaneErr = `${name}: ${e?.stack || e}`); }

  async function buildModules() {
    const my = ++gen, live = () => my === gen;
    const [G, L, B] = await Promise.all([laneModule('ground'), laneModule('life'), laneModule('bases')]);
    if (!live()) return false;
    const c = scopeCore(core, live);
    laneProgs = { ground: new Set(), life: new Set(), bases: new Set(), minimap: new Set() }; rhReset();
    const lc = name => scopeCore(core, live, laneProgs[name]);
    if (!G?.createGround) core.include('classes', CLASSES_STUB);
    try { ground = G?.createGround ? guard('ground', G.createGround(lc('ground'))) : stubGround(c); } catch (e) { disable('ground', e); ground = stubGround(c); core.include('classes', CLASSES_STUB); }
    overview = ground.stub ? null : stubGround(c); // the painted chart while GROUND links (never its occupancy dots)
    { const miss = GROUND_API.filter(k => !(k in ground)); if (miss.length) modStatus.groundApi = 'missing ' + miss.join(', '); else delete modStatus.groundApi; }
    try { life = L?.createLife ? guard('life', L.createLife(lc('life'), ground)) : noLane; } catch (e) { disable('life', e); life = noLane; }
    try { basesMod = B?.createBases ? guard('bases', B.createBases(lc('bases'), ground, { markers: !!opt.markers })) : null; } catch (e) { disable('bases', e); basesMod = null; }
    minimap = createMinimap(lc('minimap')); // its programs are collected for the band rehearsal (hidden at FAR)
    modPack = scopePack(P, live); modShared = scopePack(shared, live); modGen = my;
    return true;
  }
  /** true while one of the lane's programs still links in the background (a failed link disables the lane, loudly) */
  function linking(name) {
    const s = laneProgs[name]; if (!s) return false;
    for (const p of s) { if (p.failed) { if (!modStatus[name]?.startsWith('disabled')) disable(name, Error(p.error)); return true; } if (!p.ready) return true; }
    return false;
  }

  // ---- realm residency ---------------------------------------------------------------------------------
  async function decodePath() {
    if (opt.decode === 'canvas' || opt.decode === 'bitmap') return opt.decode;
    const f = await core.featuresReady; return f.bitmapOptions ? 'bitmap' : 'canvas';
  }
  // prefetch (plan §4.2 "prefetch begins at the tap"): the first-frame set, decoded, kept for enter()
  const prefetched = new Map();
  // D-177: the landing draws only the painted overview, the markers and the HUD, so the lanes' code must not queue behind
  // them: their chunks (and demo-bases') are fetched beside the first set at the tap (buildModules then finds them
  // imported). SwiftShader before: first set, then bases, then the lane imports, 24 s of the 137 s to the first frame.
  const warmLanes = () => { for (const n of ['ground', 'life', 'bases']) lanes[n]?.().catch(() => {}); }; // (laneModule reports a failure)
  async function openPack(id) {
    const decode = await decodePath();
    let p = prefetched.get(id); prefetched.delete(id);
    if (p) { try { const pk = await p; if (pk.stats.decodePath === decode) return noC16(pk); } catch { /* refetch below */ } }
    return noC16(await openRealm(packRoot, id, { decode, verify: opt.verify }));
  }
  // web port (patches.md P6): the shipped pack leaves the chart16 pages out (as native does); a realm.json that still lists
  // them would send GROUND after files that 404 on every FAR frame. chart16 false = the FAR chart draws chart8 alone.
  const noC16 = pk => { if (opt.chart16 === false && pk?.meta?.chart16) pk.meta.chart16 = null; return pk; };
  async function loadRealm(id) {
    realmLoading = true;
    try {
      if (P && P.id !== id) { gen++; for (const m of [ground, life, basesMod]) try { m?.dispose?.(); } catch (e) { console.error(e); } core.tex.freeAll(); P.release(); P = null; R = null; }
      const mark = k => { enterTiming[k] = Math.round(performance.now() - enterT0); };
      P = await openPack(id); mark('firstSet');
      if (disposed) { P.release(); P = null; return; } // web port P11: torn down while the pack loaded
      shared ??= openShared(packRoot, { decode: P.stats.decodePath, verify: opt.verify });
      const { cols, rows, x0, y0 } = P.meta.grid;
      const bases = hostBases.id === id ? hostBases.list : []; mark('bases');
      R = { id, meta: P.meta, cols, rows, x0, y0, bases, byCell: new Map(bases.map(b => [b.y * cols + b.x, b])), name: REALM_NAMES[id] ?? id };
      cam.setGrid(cols, rows);
      occArr = new Uint8Array(cols * rows);
      // modules last, so a context loss during the awaits above needs no rebuild of its own; a loss during
      // this await leaves the rebuild to 'restored'
      while (!core.lost && modGen !== gen) await buildModules();
      mark('modules');
      if (core.lost) return;
      loading = loadModules(); rebuilding = false;
    } finally { realmLoading = false; }
  }
  /**
   * Start every module's load without waiting (plan §4.2): each module draws only what it has (they guard on their own
   * ready state). MAP and TRUE data stream in behind the painted chart; never a blank frame (the painted overview holds the
   * ground slot until GROUND's load has started and its programs have linked). Resolves when everything has loaded.
   * Stage B D1 (D-167: no main-thread task > 50 ms): each lane starts at the head of its OWN task (slice.js taskClock.tasks()),
   * GROUND first, then its base state, the minimap, BASES and LIFE. They used to start in one task, so their synchronous
   * heads and first slices added up there (28–32 ms of JS on performance cores, 51–84 ms on efficiency cores); every
   * lane's slices now also share one task clock (slice.js taskClock), checked before each step.
   */
  let loading = null, groundStarted = false;
  function loadModules() {
    const t0 = performance.now(), step = x => rebuildLog.push(x + ' ' + Math.round(performance.now() - t0)), my = modGen;
    // a stale generation's continuation never touches the modules that replaced it
    const safe = (name, f) => Promise.resolve().then(f).catch(e => disable(name, e)).then(() => { if (my !== gen) throw staleError(); });
    overview?.load(modPack).catch(e => { if (!e?.stale) console.error('realm overview', e); }); // first: its tiny program is issued before GROUND's
    // band rehearsal: a settled lane's falsy hook means 'nothing to draw' (before, only 'not loaded yet'): retry it now. A
    // lane settling is progress for the stall valve.
    const settled = name => () => { if (my === modGen) { rh.settled[name] = true; rh.stall = 0; for (const [k, v] of rh.tries) if (v.lane === name) rh.tries.delete(k); core.invalidate(); } };
    const live = () => my === gen && !core.lost, go = f => () => { if (!live()) throw staleError(); return f(); };
    const inTask = taskClock.tasks(); // one lane per task, in this order (each start waits for the previous START, not its load)
    groundStarted = false;
    const g = inTask(() => { const p = safe('ground', go(() => ground.load(modPack))); groundStarted = true; ground.setOccupancy?.(occArr); core.invalidate(); return p; })
      .then(() => { step('ground'); if (ground.ready?.map && !linking('ground') && !mapReadyMs) mapReadyMs = performance.now() - enterT0; core.invalidate(); });
    g.then(settled('ground'), settled('ground'));
    inTask(() => { if (live()) pushBaseState(); }).catch(e => { if (!e?.stale) console.error('realm base state', e); }); // GROUND's base state from the list: a CPU pass over every deed, its own task
    inTask(go(() => minimap.load(modPack))).then(settled('minimap'), settled('minimap'));
    const b = basesMod ? inTask(() => safe('bases', go(() => basesMod.load(modPack, modShared)))).then(() => { basesMod.setBases(R.bases); pushBaseState(); applyFilter(); pushSelection(); step('bases'); }) : Promise.resolve();
    b.then(settled('bases'), settled('bases'));
    const l = inTask(() => safe('life', go(() => life.load(modPack, modShared)))).then(() => step('life')); // shared: the A11 fx pack (LIFE request 1)
    l.then(settled('life'), settled('life'));
    applyFilter(); pushSelection(); core.invalidate();
    return Promise.all([g, b, l]).then(() => { applyFilter(); pushSelection(); core.invalidate(); }, e => { if (!e?.stale) throw e; });
  }
  // context loss: core rebuilt its own state; re-create every module and re-load from the decoded cache.
  // No frame is drawn until that finishes (a module drawn before its load() would throw and be disabled).
  let rebuilding = false, rebuildLog = [];
  core.on('lost', () => { // every module generation goes stale now; its pending loads stop at their next loader/GL call
    if (disposed) return; // web port P11: the host dropped this engine and its context on purpose, not a GPU reset
    rebuilding = true; gen++;
    for (const m of [ground, life, basesMod, minimap]) try { m?.dispose?.(); } catch (e) { if (!e?.stale) console.error(e); }
    // GPU safety (P0): a loss while the map was drawing may be the browser resetting a hung GPU. Never redraw the same
    // view at the same cost: restore in safe mode; a second loss stops the realm map until a reload. (QA's plain
    // loseContext() is a forced restore test and keeps its level; loseContext({ hang: true }) takes this path.)
    if (Q.qaLoss) { Q.qaLoss = false; return; }
    if (!active && !realmLoading) return;
    // W1 S5: at level 2 there is no cheaper view to restore: restoring would run the same hang again, so stop now
    const wasSafe = Q.level >= 2; Q.losses++; Q.dirtyVisit = true;
    setLevel(2, 'the graphics context was lost (GPU reset)', { persist: true, floor: 2 });
    if (wasSafe || Q.losses >= GPU_SAFE.lossStop) Q.stopped = true;
  });
  core.on('restored', async () => {
    if (Q.stopped) { // stay dark: back to the globe, loudly
      if (active) exit({ at: true });
      gpuNotice(`Realm map paused: the graphics chip reset${Q.losses > 1 ? ' twice' : ' in safe mode'}. Reload the page to try again.`, { label: 'RELOAD', onClick: () => location.reload(), ms: 0 });
      return;
    }
    if (Q.losses && active) gpuNotice('Graphics reset: the map is in safe mode (lower detail, no animation).');
    if (!P || !R || realmLoading) { if (!realmLoading) rebuilding = false; return; } // loadRealm builds after its own awaits
    rebuilding = true; rebuildLog = ['start'];
    try { while (!core.lost && modGen !== gen) await buildModules(); if (core.lost) return; rebuildLog.push('modules'); loading = loadModules(); } catch (e) { rebuildLog.push('error ' + e.message); console.error('realm map: context rebuild', e); }
    rebuilding = false; ui?.refresh(); core.invalidate();
    try { await loading; rebuildLog.push('loaded'); } catch { /* reported by the lane guard */ }
  });

  // ---- bases: filters, selection, browse -----------------------------------------------------------------
  // web port (patches.md P3): the host's kingdoms for a realm ({ id, x, y, level, name, avatar, shield, mine, attackable });
  // set before enter() (they land with the realm) or at any time after (a feed refresh keeps the selection by id)
  let hostBases = { id: null, list: [] };
  function setBases(id, list) {
    hostBases = { id, list: Array.isArray(list) ? list : [] };
    if (!R || R.id !== id) return;
    const was = selected && !selected.free ? selected.id : null;
    R.bases = hostBases.list; R.byCell = new Map(R.bases.map(b => [b.y * R.cols + b.x, b]));
    if (was != null) selected = R.bases.find(b => b.id === was) ?? selected;
    occArr?.fill(0);
    if (!ground || modGen !== gen) return; // the modules being built take R.bases when their load starts (loadModules)
    basesMod?.setBases?.(R.bases); pushBaseState(); applyFilter(); pushSelection();
  }
  function passes(b) { return filterPasses(filterState, b, filterState.kind === 'clan' ? (R.bases.find(x => x.mine)?.clan ?? null) : null); }
  // GROUND learns plots from BASES' base-state texture (§6.1); until BASES ships one, from the list itself
  function pushBaseState() {
    if (basesMod?.stateTex) { ground.setBaseState?.(basesMod.stateTex, basesMod.geomVersion, basesMod.stateCpu ?? null); life.setBaseState?.(basesMod.stateTex); }
    else ground.setBases?.(R.bases);
  }
  function applyFilter() { // once per change (fixes the prototype's O(n²) per-frame filter)
    if (!R) return;
    filtered = R.bases.filter(passes); filteredSet = new Set(filtered);
    basesMod?.setFilter?.(passes);
    for (const b of R.bases) occArr[b.y * R.cols + b.x] = (b.mine ? 2 : 1) | (b === selected ? 4 : 0);
    ground.setOccupancy?.(occArr);
    minimap?.setBases(R.bases, filteredSet, selected, filterState.kind === 'attack', filterActive()); ui?.refresh(); core.invalidate();
  }
  function pushSelection() {
    if (!R) return;
    for (const b of R.bases) occArr[b.y * R.cols + b.x] = (b.mine ? 2 : 1) | (b === selected ? 4 : 0);
    ground.setOccupancy?.(occArr);
    basesMod?.select?.(selected && !selected.free ? selected.id : null);
    minimap?.setBases(R.bases, filteredSet, selected, filterState.kind === 'attack', filterActive());
    core.invalidate(); // frame() declares the 'select' pulse only while the selection is on screen
  }
  const filterActive = () => filterState.kind !== 'all' || filterState.lvl[0] > 1 || filterState.lvl[1] < 20;
  function select(b, fly = false) {
    selected = b || null; pushSelection(); ui?.card(selected); core.invalidate();
    if (!b) return;
    const d = cam.d, dT = fly || d < SELECT_D ? Math.max(d, SELECT_D) : restTarget(d), sT = dT / core.dpr;
    const [ox, oy] = ui?.focusOffset?.() ?? [0, 0], p = plotAt(b); // centre the plot in the part of the screen the card leaves free
    cam.flyToD(p.x + ox / sT, p.y + oy / sT, dT, fly || d < SELECT_D ? 700 : 500);
  }
  function step(dir) { // proximity walk inside the filtered list (the prototype's scoring)
    const L = filtered; if (!L.length) return;
    const cur = selected && !selected.free ? selected : null, ox = cur ? cur.x : cam.x, oy = cur ? cur.y : cam.y;
    let best = null, bd = Infinity;
    for (const b of L) { if (b === cur) continue; const dx = (b.x - ox) * dir; if (dx <= 0) continue; const s = Math.hypot(b.x - ox, b.y - oy) + Math.abs(b.y - oy) * 0.6; if (s < bd) { bd = s; best = b; } }
    if (!best) best = L.reduce((a, b) => ((dir > 0 ? b.x < a.x : b.x > a.x) ? b : a));
    select(best, true);
  }
  function pick(sx, sy) {
    const b = basesMod?.pick?.(sx, sy); if (b) return b;
    const [u, v] = cam.screenToDeed(sx, sy), x = Math.floor(u), y = Math.floor(v);
    if (x < 0 || y < 0 || x >= R.cols || y >= R.rows) return null;
    const hit = R.byCell.get(y * R.cols + x); if (hit) return hit;
    return P.first.deeds[y * R.cols + x] === DEED_PX.thisRealm ? { free: true, x, y } : null;
  }

  // ---- input ---------------------------------------------------------------------------------------------
  const unbindGestures = bindGestures(canvas, cam, {
    onInput: () => core.input(), onChange: () => core.invalidate(),
    onTap: (sx, sy) => {
      if (!R || leaving) return;
      const c = ui?.hitCluster(sx, sy); if (c) { cam.flyToD(c.x, c.y, Math.max(cam.d * 2.4, BANDS.mapStart), 600); core.input(); return; }
      const t = ui?.hitTag?.(sx, sy); if (t) { select(t); return; } // web port P7 (native 560fe54): a tag selects its kingdom
      select(pick(sx, sy));
    },
    onPinchOut: () => exit(), // below 0.7 × the whole-realm fit (D-177)
  });
  const onKey = e => {
    if (!active || leaving || e.target?.closest?.('input,textarea')) return;
    if (e.key === 'Escape' && !opt.host) { if (ui?.escape()) return; exit(); } // (P7: a host owns Back and Escape)
    if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1);
    if (e.key === '+' || e.key === '=') zoomBy(2.2); if (e.key === '-') zoomBy(1 / 2.2);
    core.input();
  };
  const onResize = () => active && core.invalidate();
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  // D-177: zooming out at the whole-realm view (the HUD's − button, the − key) goes back to the globe, like a pinch-out below
  // it; anywhere above it − zooms out (to the whole realm at most: flights rest at the fit)
  function zoomBy(k) { if (k < 1 && cam.d <= cam.sMin() * cam.dpr * 1.01) { exit(); return; } cam.flyToD(cam.x, cam.y, cam.d * k, 380); core.invalidate(); }
  function flyTo(x, y, s, ms = 700) { cam.flyTo(x, y, s, ms); core.input(); }
  function myBase() { const m = R?.bases.find(b => b.mine); if (!m) return; select(m); const p = plotAt(m), [ox, oy] = ui?.focusOffset?.() ?? [0, 0], sT = MY_BASE_D / core.dpr;
    cam.flyToD(p.x + ox / sT, p.y + oy / sT, MY_BASE_D, 900); core.input(); }

  // ---- entry and leave (D-177, owner 2026-09-26: "overview first, live"; withdraws D-173's MAP landing) --------------------
  // Enter map (and a pinch-in dive) lands in the painted chart at the globe's own scale with the kingdom markers, and STAYS
  // there until the player zooms: no hold, no flight to MAP, no zoom floor. The lanes load and rehearse behind the landing;
  // a zoom-in meets the band gates (the scale pill's "detail N%") only while its band is not ready. Leaving zooms out
  // RH.leaveMs through the FAR→MAP fade into the painted chart, then the globe fades in: the dive in reverse, with no black
  // frame (the realm canvas keeps its last frame while it fades). land: this visit's landing (ms since enter(), d).
  const land = { ms: 0, d: 0 };
  let leaving = null;

  // ---- band rehearsal v2 and band readiness (W1 S1/S2/S8; the lane contract is contracts.js GPU_SAFE.rehearse) --------
  // A pipeline — and the driver's per-state fragment work — is built at the first draw that shades fragments: the first
  // MAP frame blocked 14.6–18.7 s on SwiftShader, and the P0 rehearsal's zero-fragment draws left d 400 at 3.4–6.9 s.
  // Here every (program, target) of the bands is pre-drawn through its lane's hook (core.rehearse: real target, the view
  // centre in a small scissored box, ONE new (program, state) per frame), in order of need, once the painted overview is
  // on screen and GROUND's MAP data is in (the rehearsal never delays MAP ready), each lane after its load() settled.
  // The camera may not zoom past a band's gate edge until that band's set is rehearsed (bandGate), and a lane whose
  // pipelines for the current band are not built yet does not draw (laneHeld): a detail pops in a few frames late
  // instead of a stall. Input pauses the rehearsal unless the camera waits at a gate.
  const RH = GPU_SAFE.rehearse, rhOn = opt.rehearse !== '0';
  // done: program object → targets rehearsed (a program object lives as long as its context, so a re-entry or a realm with
  // the same shaders finds it built; new defines = a new object); doneKeys: this generation's, for stats and the cue
  const rh = { done: new WeakMap(), doneKeys: new Set(), tries: new Map(), nothing: new Set(), noHook: new Set(), failed: new Set(), settled: {}, last: null, wake: 0,
    stall: 0, lastT: 0, valve: null, items: [], built: 0, gate: { lim: Infinity, band: null, reason: null }, mapHoldT: 0 };
  function rhReset() { rh.doneKeys.clear(); rh.tries.clear(); rh.nothing.clear(); rh.noHook.clear(); rh.settled = {}; rh.items = []; rh.valve = null; rh.stall = 0; rh.mapHoldT = 0; }
  // every module that creates programs (a test keeps this list whole): the three lanes and SHELL's own minimap (core's blit
  // is added below whenever the level draws the ground into the ½ target)
  const REHEARSE_LANES = ['ground', 'life', 'bases', 'minimap'];
  const laneObj = n => (n === 'ground' ? ground : n === 'life' ? life : n === 'bases' ? basesMod : minimap);
  const setOf = name => (RH.trueSet.includes(name) ? 2 : 1);
  const itemKey = it => `${it.p.name}|${it.target}`;
  // may this item's hook run yet? GROUND's MAP / TRUE programs once its MAP / TRUE data is in (its load() streams on), every
  // other lane once its load() settled; SHELL's blit always
  const laneReady = it => it.n === 'core' || (it.n === 'ground' ? (it.set >= 2 ? !!ground.ready?.true : !!ground.ready?.map) || !!rh.settled.ground : !!rh.settled[it.n]);
  const gating = it => laneReady(it) && !rh.nothing.has(itemKey(it));
  function rehearsalItems() {
    const out = [], kLow = kFor(null), targets = kLow < 0.999 ? ['canvas', 'low'] : ['canvas'];
    for (const n of REHEARSE_LANES) {
      const lane = laneObj(n); if (!lane || lane.stub || modStatus[n]?.startsWith('disabled')) continue;
      const ps = [...(laneProgs[n] ?? [])].filter(p => p.state === 'ready' && !rh.failed.has(p.name)); if (!ps.length) continue;
      if (typeof lane.rehearse !== 'function') { if (ps.some(p => !p.drawn)) rh.noHook.add(n); continue; } // loud in stats().rehearsal.noHook
      for (const p of ps) for (const target of (n === 'ground' ? targets : ['canvas'])) {
        const it = { n, lane, p, target, k: target === 'low' ? kLow : 1, set: setOf(p.name) }; if (!rh.done.get(p)?.has(target)) out.push(it);
      }
    }
    const blit = core.blitProgram;
    if (targets.length > 1 && blit?.state === 'ready' && !rh.done.get(blit)?.has('canvas')) out.push({ n: 'core', lane: null, p: blit, target: 'canvas', k: kLow, set: 1 });
    const rank = it => it.set * 1000 + (RH.order.indexOf(it.p.name) + 1 || RH.order.length + 1);
    return out.sort((x, y) => rank(x) - rank(y));
  }
  /** Is lane n still waiting for pipelines the band set bs needs (W1 S2: it draws nothing until they are built)? */
  const laneHeld = (n, bs) => rhOn && !rh.bypass && rh.items.some(it => it.n === n && it.set <= bs && gating(it));
  // one pending wake, the EARLIEST asked for (a longer wake — the map-data hold's, an idle retry's — must never delay the
  // rehearsal's 32 ms gap: the first-come timer did, and the D-173 dive's hold then rehearsed at 4 items a second)
  function wakeIn(ms) {
    const at = performance.now() + Math.max(16, ms); if (rh.wake && rh.wakeAt <= at) return;
    clearTimeout(rh.wake); rh.wakeAt = at; rh.wake = setTimeout(() => { rh.wake = 0; if (active) core.invalidate(); }, at - performance.now());
  }
  /**
   * Band readiness (W1 S2/S8): the highest d the camera may reach now. The MAP gate (farEnd) holds while a MAP-set
   * item of a loaded lane is not rehearsed, then — only at the edge — while GROUND's mapReady(view) is false, for at most
   * mapReadyHoldMs; the TRUE gate (trueStart) holds for the TRUE set. A gate that makes no rehearsal progress for stallMs
   * while the rehearsal may run opens anyway (rh.valve, logged): a stuck hook must never lock the zoom.
   */
  function bandGate(view, t) {
    let { lim, band, reason } = bandLimit({ on: rhOn, bypass: !!rh.bypass, valve: !!rh.valve, items: rh.items.map(it => ({ set: it.set, gating: gating(it) })) });
    if (rh.bypass) { rh.gate = { lim, band, reason }; cam.limitD(lim); return; }
    // (a zoom-in from a resting view waits for GROUND's lattice mapReadyHoldMs at most; an open valve waits for nothing more)
    if (lim > BANDS.farEnd && typeof ground.mapReady === 'function' && !ground.stub && !linking('ground') && !rh.valve) {
      if (cam.d < BANDS.farEnd * 0.9) rh.mapHoldT = 0;
      else if (cam.d <= BANDS.farEnd * 1.001 && view && !ground.mapReady(view)) {
        rh.mapHoldT ||= t;
        if (t - rh.mapHoldT < RH.mapReadyHoldMs) { lim = BANDS.farEnd; band = 'map'; reason = 'map data'; wakeIn(RH.mapReadyHoldMs - (t - rh.mapHoldT)); }
      }
    }
    rh.gate = { lim, band, reason };
    cam.limitD(lim);
  }
  /** The rehearsed share (0..1) of the set the closed gate waits for: the cue in the scale pill. */
  function gateProgress() {
    if (rh.gate.lim === Infinity) return 1;
    const b = rh.gate.band === 'true' ? 2 : 1, doneN = [...rh.doneKeys].filter(k => setOf(k.split('|')[0]) <= b).length;
    const left = rh.items.filter(it => it.set <= b && gating(it)).length;
    return rh.gate.reason === 'map data' ? 0.99 : doneN / Math.max(1, doneN + left);
  }
  /** The stall valve: a gate that makes no progress for stallMs opens anyway (a stuck hook must never lock the zoom). */
  function stallTick(dt, t) {
    rh.stall += dt; if (rh.stall <= RH.stallMs || rh.valve) return;
    rh.valve = { band: rh.gate.band, t: Math.round(t), reason: rh.gate.reason, items: rh.items.filter(gating).map(itemKey).slice(0, 8) };
    console.warn('realm map: band gate opened without rehearsal progress', rh.valve);
  }
  /** One rehearsal step for this frame (called before the frame's clear, so its box is never seen). */
  function rehearse(view, moving, t) {
    const dt = Math.min(250, t - (rh.lastT || t)); rh.lastT = t;
    if (!rhOn || !firstDrawMs || rehearsalHeld(Object.values(laneProgs))) return;
    if (!ground.stub && !ground.ready?.map && !rh.settled.ground && !modStatus.ground?.startsWith('disabled')) return; // MAP data first
    const bs = BAND_SET[view.band] ?? 0, waiting = cam.pressing, idle = core.sinceInput() >= RH.idleMs && !moving;
    // (a lane may rehearse while it still loads — BASES builds its rehearsal data before its art; a falsy hook then only
    // backs off — but only a loaded lane's items gate a band)
    const runnable = rh.items.filter(it => (rh.tries.get(itemKey(it))?.next ?? 0) <= t);
    // a lane held in the current band, or a camera waiting at a gate, cannot wait for idle: the player is waiting on it
    const urgent = it => waiting || (it.set <= bs && gating(it));
    const it = runnable.find(x => idle || urgent(x));
    if (rh.gate.lim < Infinity && (idle || waiting)) stallTick(dt, t);
    // (a 'nothing' item never wakes an idle map — it is retried on frames drawn anyway: the idle policy's 0 fps holds)
    const live = rh.items.filter(x => !rh.nothing.has(itemKey(x)));
    if (!it) { if (live.length) { const next = Math.min(...live.map(x => rh.tries.get(itemKey(x))?.next ?? 0)); wakeIn(next > t ? next - t : RH.idleMs - core.sinceInput()); } return; }
    const key = itemKey(it); let hook = false, r = null;
    if (core.currentPhase !== 'band') core.phase('warm'); rh.ran = true; // long tasks of a rehearsal step are 'warm', not browsing
    try {
      core.tally('rehearse', () => { r = core.rehearse(() => { hook = it.n === 'core' ? core.rehearseBlit(it.k) : it.lane.rehearse(it.p, view, { target: it.target, k: it.k, box: RH.box }); },
        { target: it.target, k: it.k, ground: it.n === 'ground' || it.n === 'core' }); });
    } catch (e) { if (e?.stale) return; rh.failed.add(it.p.name); console.error(`realm lane ${it.n}: rehearse(${it.p.name}) failed; its first draw stays cold`, e); }
    const drew = !!hook && !!r?.drew;
    rh.last = { program: it.p.name, lane: it.n, target: it.target, drew, complete: !!r?.complete, fresh: r?.fresh ?? 0, band: view.band };
    if (!drew) { // nothing to draw now: never gating, tried again later without a count
      const tr = rh.tries.get(key) ?? { n: 0, next: 0, lane: it.n }; tr.n++; tr.next = retryAt(tr.n, t); rh.tries.set(key, tr);
      if (laneReady(it) && !rh.failed.has(it.p.name)) rh.nothing.add(key);
    } else {
      rh.nothing.delete(key); rh.tries.delete(key);
      if (r.fresh) { rh.built += r.fresh; rh.stall = 0; }
      if (r.complete) { let d = rh.done.get(it.p); if (!d) rh.done.set(it.p, d = new Set()); d.add(it.target); rh.doneKeys.add(key); rh.stall = 0; }
    }
    // the next state or program next frame; after the LAST one, one more frame so bandGate re-reads the gate (its items
    // were listed before this step: without it an idle map kept the gate and its cue closed until the next input)
    if (live.length > (r?.complete && drew ? 1 : 0) || (r?.complete && drew && rh.gate.lim < Infinity)) wakeIn(RH.gapMs);
  }

  // ---- frame -----------------------------------------------------------------------------------------------
  let lastView = null, lastDpr = 0;
  function makeView() {
    const c = core.clock(), b = bands(cam.d), r = cam.rect();
    return { x: cam.x, y: cam.y, s: cam.s, dpr: core.dpr, d: cam.d, W: core.W, H: core.H, ms: c.ms, pulseMs: c.pulseMs, frozen: c.frozen,
      w: b.w, band: b.band, fadeWeight: b.fadeWeight, rect: { x0: Math.max(0, Math.floor(r.x0)), y0: Math.max(0, Math.floor(r.y0)), x1: Math.min(R.cols, Math.ceil(r.x1)), y1: Math.min(R.rows, Math.ceil(r.y1)), fx0: r.x0, fy0: r.y0, fx1: r.x1, fy1: r.y1 },
      reducedMotion: core.reducedMotion || !GPU_SAFE.heavy[Q.level], safe: !GPU_SAFE.heavy[Q.level], grid: { cols: R.cols, rows: R.rows, x0: R.x0, y0: R.y0 },
      sel: selected ? [selected.x, selected.y] : null, hov: hovered ? [hovered.x, hovered.y] : null, moving: cam.moving, speed: cam.speed, core };
  }
  // Which ONE ground display pass this frame draws ('chart' | 'map' | 'true'), or null in a cross-fade (two passes): W1 S3
  // picks the ground scale from it. GROUND's passes(view) when it has one (exact, after update); else the band weights and
  // GROUND's ready flags, and a rest frame after a rest frame that drew two passes (lattice or pages still missing) stays null.
  let lastGroundDraws = 0, lastFade = true;
  function groundPass(view, held) {
    if (held) return lastFade = true, null; // the painted overview (its own chart pass) is not GROUND's cost model
    if (typeof ground.passes === 'function') { const p = ground.passes(view); if (p) { const on = ['chart', 'map', 'true'].filter(k => p[k]); lastFade = on.length !== 1; return lastFade ? null : on[0]; } }
    const w = view.w, fade = (w.far > 0 && w.far < 1) || (w.true > 0 && w.true < 1), was = lastFade; lastFade = fade;
    if (fade || (!was && lastGroundDraws > 1)) return null;
    return w.far >= 1 || !ground.ready?.map ? 'chart' : w.true >= 1 && ground.ready?.true ? 'true' : 'map';
  }
  function frame(t) {
    if (!active || !R || rebuilding) return false;
    core.resize(); cam.setViewport(core.W, core.H, core.dpr);
    if (core.dpr !== lastDpr) { lastDpr = core.dpr; }
    const T = core.tally;
    // band readiness before the camera moves this frame (W1 S2/S8): the zoom stops at a gate edge until its band is ready
    T('gate', () => { rh.items = rhOn ? rehearsalItems() : []; bandGate(lastView, t); });
    const moving = cam.step(t) || cam.moving;
    const view = makeView(); lastView = view; core.drawTag = view.band; markBand(BAND_SET[view.band] ?? 0);
    { const held = rh.gate.lim < Infinity && cam.pressing; view.gate = { held, band: rh.gate.band, progress: held ? gateProgress() : 1 }; }
    // the selection pulse keeps the scheduler alive only while the selected deed is on screen (D-164.5, C10)
    const sv = selected, r = view.rect, heavy = GPU_SAFE.heavy[Q.level];
    core.animating('select', heavy && sv && sv.x + 1 > r.fx0 && sv.x < r.fx1 && sv.y + 1 > r.fy0 && sv.y < r.fy1 ? 50 : 0);
    T('begin', () => core.begin(view)); // (the queued uploads run here: W1 S7 attribution)
    // P0 async compile: a lane whose programs still link in the background neither updates (GROUND's resolve passes
    // would bake from a skipped draw) nor draws; the painted overview holds the ground slot meanwhile. W1 S2: nor does a
    // lane whose pipelines for this band are not rehearsed yet (it loaded after the camera passed the gate)
    const bs = BAND_SET[view.band] ?? 0;
    // (stage B D1: GROUND's load starts in its own task after the entry's first frame could run: until then the painted overview)
    const gL = !groundStarted || linking('ground') || laneHeld('ground', bs), lL = linking('life') || laneHeld('life', bs), bL = linking('bases') || laneHeld('bases', bs);
    rehearse(view, moving, t); // before the clear: the rehearsal's box is never seen
    gl.clearColor(0.05, 0.13, 0.27, 1); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!gL) T('ground.update', () => ground.update(view)); if (!lL) T('life.update', () => life.update(view)); if (!bL) T('bases.update', () => basesMod?.update(view));
    // every lane pass is tallied (draws, instances, JS ms) into stats().layers / frameParts (fix iteration 2, QA GA2 #1:
    // 30k of 45k phone instances were unattributed); lanes cull to the view, so a pass's instances are its visible instances
    const pass = groundPass(view, gL), k = kFor(pass), d0 = core.drawsNow; lastPass = pass;
    core.frameTag = { pass, level: Q.level, gov: G.gen }; // handed back with this frame's GPU sample (the MAP-rest governor)
    T('ground', () => core.lowres(k, () => (gL ? overview : ground)?.draw(view))); // full resolution only for one cheap pass at rest (W1 S3)
    const groundDrew = core.drawsNow > d0; lastGroundDraws = core.drawsNow - d0;
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    if (!lL) T('life.shadow', () => life.draw(view, 'shadow')); if (!bL) T('bases.shadow', () => basesMod?.draw(view, 'shadow'));
    gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
    if (!bL) T('bases.shieldBack', () => basesMod?.draw(view, 'shieldBack'));
    if (!lL) T('life.sprite', () => life.draw(view, 'sprite')); if (!bL) T('bases.sprite', () => basesMod?.draw(view, 'sprite'));
    if (!bL) T('bases.shieldFront', () => basesMod?.draw(view, 'shieldFront'));
    if (heavy && !lL) T('life.air', () => life.draw(view, 'air')); if (!bL) T('bases.fx', () => basesMod?.draw(view, 'fx')); // air: optional (P0 safe mode)
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.depthMask(true);
    T('minimap', () => minimap.draw(view, ui?.miniRect()));
    T('ui', () => ui?.frame(view));
    // long-task phases (core.phase): load until MAP is ready, a band switch owns the next second, then browse
    if (b0 !== view.band) { if (b0) { core.phase('band'); bandT = t; } b0 = view.band; }
    const ph = core.currentPhase;
    const mapReady = ground.ready?.map && !gL; // MAP data in AND its programs linked
    if (ph === 'load' && mapReady) core.phase('browse'); else if (ph === 'band' && t - bandT > 1000) core.phase(mapReady ? 'browse' : 'load');
    else if (ph === 'warm' && !rh.ran) core.phase(mapReady ? 'browse' : 'load');
    rh.ran = false;
    if (!mapReadyMs && mapReady) mapReadyMs = performance.now() - enterT0;
    if (!firstDrawMs && groundDrew) { core.phase('load'); firstDrawMs = performance.now() - enterT0; enterTiming.frameCpu = Math.round(performance.now() - t); packAtFirst = P.stats.bytesLoaded + (shared?.stats.bytesLoaded ?? 0); engineAtFirst = engineBytes(); bytesAtFirst = packAtFirst + engineAtFirst; }
    return moving;
  }

  // ---- entry / exit ---------------------------------------------------------------------------------------
  let uiMod = null, b0 = null, bandT = 0, evictTimer = 0, evicted = false;
  // Leaving frees the realm's GPU textures after IDLE.evictMs (fix iteration 2, QA GA2 #2: the realm kept 101–104 MB
  // while the globe re-warmed, 179–199 MB combined on a phone). The loader keeps the decoded sources, so re-entry
  // rebuilds the modules and re-uploads them like a context restore — no refetch.
  function stopped() {
    active = false; core.stop(); ui?.hide(); core.phase('exit'); b0 = null; markPending(false);
    clearTimeout(evictTimer); evictTimer = setTimeout(() => { evictTimer = 0; core.phase('off'); if (!active && !realmLoading) evict(); }, IDLE.evictMs);
  }
  function evict() {
    if (!P || evicted) return; evicted = true; gen++;
    for (const m of [ground, life, basesMod, minimap]) try { m?.dispose?.(); } catch (e) { if (!e?.stale) console.error(e); }
    core.tex.freeAll(); core.shrink?.();
  }
  async function rewarm() { // after evict(): the same rebuild a context restore runs
    evicted = false; rebuilding = true;
    try { while (!core.lost && modGen !== gen) await buildModules(); if (!core.lost) loading = loadModules(); } finally { rebuilding = false; }
  }
  /** Back to the globe: the dive in reverse — the camera zooms out RH.leaveMs through the FAR→MAP fade into the painted
   *  chart (the HUD fades meanwhile), then onExit lets the globe cross-fade in over the realm's last frame.
   *  at: at once (a context that cannot draw the leave). */
  function exit({ at = false } = {}) {
    if (!active || leaving) return; const lon = -180 + (R.x0 + cam.x) * DEED_DEG, lat = 90 - (R.y0 + cam.y) * DEED_DEG;
    const done = () => { if (leaving) clearTimeout(leaving.timer); leaving = null; if (!active) return; stopped(); onExit?.({ lon, lat }); };
    if (at || core.lost || rebuilding || Q.stopped) { done(); return; }
    if (uiRoot?.style) uiRoot.style.opacity = '0';
    cam.flyToD(cam.x, cam.y, Math.min(cam.d, BANDS.farEnd * 0.9), RH.leaveMs, { raw: true }); core.input();
    leaving = { t0: performance.now(), timer: setTimeout(done, RH.leaveMs + 30) };
  }
  // A dynamic import that fails (a chunk this page's engine names is gone: a publish swap, a pruned dist) can
  // never succeed in this page again: reload it once (at most once a minute) instead of failing every tap.
  const isImportError = e => /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(String(e?.message ?? e));
  function reloadForUpdate(e) {
    let last = 0; try { last = Number(sessionStorage.getItem('rm-reload') || 0); } catch { /* storage off */ }
    if (Date.now() - last < 60000) return;
    try { sessionStorage.setItem('rm-reload', String(Date.now())); } catch { /* storage off */ }
    console.warn('realm map: the engine was updated, reloading', e); const h = document.getElementById('hint'); if (h) { h.textContent = 'Map updated — reloading…'; h.hidden = false; }
    setTimeout(() => location.reload(), 400);
  }
  async function enter(id, lon, lat, sStart = 18, opts = {}) {
    try { return await enterInner(id, lon, lat, sStart, opts); } catch (e) { if (isImportError(e)) reloadForUpdate(e); throw e; }
  }
  // web port P11: an enter still awaiting its pack when the host disposed the engine stops at its next step
  const gone = () => { if (disposed) { const e = Error('the realm map was disposed'); e.name = 'AbortError'; throw e; } };
  async function enterInner(id, lon, lat, sStart, opts) { // (P12: lon, lat and sStart are kept for the API; the landing is the fit)
    gone();
    if (Q.stopped) {
      gpuNotice('Realm map paused: the graphics chip reset. Reload the page to try again.', { label: 'RELOAD', onClick: () => location.reload(), ms: 0 });
      throw Error('realm map stopped after a GPU reset (reload to retry)');
    }
    if (Q.hold) { // W1 S5: the map froze this device even in safe mode last time: never re-run it without the player's choice
      gpuNotice('Realm map paused: it froze this device last time, even in safe mode.', { label: 'TRY AGAIN', ms: 0, onClick: () => {
        Q.hold = false; if (!core.software) { const r = gpuStore.get(); if (r) { delete r.hold; gpuStore.set(r); } }
        gpuNotice('Safe mode is on. Tap Enter map again.'); } });
      throw Error('realm map held after a freeze in safe mode (TRY AGAIN to retry)');
    }
    enterT0 = performance.now(); mapReadyMs = 0; firstDrawMs = 0; bytesAtFirst = 0; packAtFirst = 0; engineAtFirst = 0; enterTiming = {};
    clearTimeout(evictTimer); evictTimer = 0; core.phase('enter');
    warmLanes();
    await indexReady; gone();
    // ui.js + the shared HUD sheet load at the dive, beside the realm; a rejected import is forgotten, so the
    // next tap retries it (it used to be memoised: one failure and no realm map could open until a reload)
    // web port (patches.md P9): the HUD sheet is the host's (options.hud; null draws the labels unstyled by it)
    const uiP = (uiMod ??= Promise.all([import('./ui.mjs'), Promise.resolve(opt.hud ?? null)]).catch(e => { uiMod = null; throw e; })); uiP.catch(() => {});
    if (!R || R.id !== id) { selected = null; evicted = false; await loadRealm(id); }
    else if (evicted) { await rewarm(); enterTiming.rewarm = Math.round(performance.now() - enterT0); }
    gone();
    const [{ createUI }, hud] = await uiP; gone();
    shared.json('keeps.json').then(k => { keepMeta = k; }).catch(() => {});
    // card thumbnail: the shared realm-map keeps atlas icon (72×68 pixel art); the globe's keep PNGs only as a fallback
    ui ??= createUI(uiRoot, api, { avatarURL, hud, host: opt.host ?? null, keepThumb: L => { const k = keepMeta?.levels?.[L - 1]?.icon; return k ? { src: shared.root + keepMeta.atlas, x: k.x, y: k.y, w: k.w, h: k.h } : { src: `${packRoot}keeps/l${L}.png` }; } });
    ui.show(R); ui.card(null); selected = null; pushSelection();
    if (uiRoot?.style) uiRoot.style.opacity = ''; // (a leave faded the HUD)
    active = true; core.resize(); cam.setViewport(core.W, core.H, core.dpr);
    // The dive lands in the FAR band (the painted chart, where the globe's painting cross-fades into it). D-177: it RESTS
    // there until the player zooms (D-173's hold and flight to the MAP floor are withdrawn).
    // web port P12 (owner, native reference item 1: "land on the whole-realm overview"): the landing is the realm's centre
    // at the whole-realm fit (camera.mjs landing()). The concept landed at d = max(min(sStart × dpr, farEnd), fit × dpr),
    // a crop about 5× inside the fit (d ≈ 21 against a fit of 4.2–5.6), so lon, lat and sStart no longer place it.
    if (leaving) { clearTimeout(leaving.timer); leaving = null; }
    rh.stall = 0; rh.valve = null; rh.mapHoldT = 0; // a new visit: a valve a stuck hook opened last time gets a new chance
    const { x, y, d: d0 } = landing(cam); // (the concept's names: camera.cases.mjs pins this one placement verbatim)
    cam.set(x, y, d0 / core.dpr);
    land.ms = Math.round(performance.now() - enterT0); land.d = cam.d;
    suspended = false; markPending(true);
    if (Q.steps.at(-1)?.atStart && !Q.startNoticed) { Q.startNoticed = true;
      gpuNotice(`Safe graphics mode: ${Q.reason}.`, { label: 'FULL DETAIL', onClick: () => { Q.losses = 0; Q.upLock = false; Q.wentUp = false; setLevel(0, 'full detail chosen by the player', { floor: 0 }); } }); }
    core.input(); core.run(frame);
  }

  const api = {
    get active() { return active; }, get cam() { return cam; }, get realm() { return R; }, get core() { return core; },
    get selected() { return selected; }, get filter() { return filterState; }, get filtered() { return filtered; }, get filteredSet() { return filteredSet; },
    get lastView() { return lastView; }, get minimap() { return minimap; }, get hovered() { return hovered; },
    tagCandidates: view => basesMod?.tagCandidates?.(view) ?? null, plotAt,
    /** web port P8: does this kingdom draw as its base (keep) at this view? (the tag shows its level only then) */
    drawsBase: (b, view) => !!basesMod?.drawsBase?.(b, view),
    setBases,
    /** web port P7: the host's chrome moved: tags and counters re-measure it before the next frame. */
    chromeChanged: () => { ui?.chromeChanged?.(); core.invalidate(); },
    select, step, flyTo, flyToD: (x, y, d, ms) => { cam.flyToD(x, y, d, ms); core.input(); }, zoomBy, myBase, exit,
    setFilter(f) { filterState = { ...filterState, ...f }; applyFilter(); },
    has: id => !!index?.realms?.some(r => r.id === id),
    realms: () => index?.realms ?? [],
    ready: indexReady,
    enter,
    /** Fetch + decode a realm's first-frame set ahead of enter() (call at the tap / realm selection). */
    prefetch(id) {
      warmLanes();
      if (prefetched.has(id) || P?.id === id) return;
      const p = indexReady.then(async () => (api.has(id) ? openRealm(packRoot, id, { decode: await decodePath(), verify: opt.verify }) : null));
      p.catch(() => {}); prefetched.set(id, p);
    },
    /** Resolves when every module of the resident realm has finished loading. */
    loaded: () => loading ?? Promise.resolve(),
    leave() { if (leaving) { clearTimeout(leaving.timer); leaving = null; } if (active) stopped(); else { core.stop(); ui?.hide(); } },
    /** web port P13: the page was hidden mid-visit. Android can discard a hidden renderer without a pagehide, and the next
     *  visit would read the visit marker as a freeze: lift it while hidden (the visit's band evidence is kept), and set it
     *  again on resume(). A clean leave or a pagehide while hidden has nothing left to clear. */
    suspend() { if (!active || suspended || core.software) return; suspended = true; gpuStore.set(gpuRecord.hide(gpuStore.get())); },
    resume() { if (!suspended) return; suspended = false; if (!active || core.software) return; gpuStore.set(gpuRecord.show(gpuStore.get(), Date.now(), Q.visit.band)); },
    /** web port P11: throw the engine away. A clean leave first (the visit marker ends), then every module, texture, pack
     *  and decoded source is released, every page listener comes off, and the QA handle goes; the host drops the canvas and
     *  its context after this, and that loss is never read as a GPU reset. notices: false keeps a GPU notice up (the host
     *  rebuilds the realm map at once). */
    dispose({ notices = true } = {}) {
      if (disposed) return;
      api.leave(); disposed = true; suspended = false; realmLoading = false; gen++;
      clearTimeout(evictTimer); evictTimer = 0;
      for (const m of [ground, life, basesMod, minimap, overview]) try { m?.dispose?.(); } catch (e) { if (!e?.stale) console.error(e); }
      try { core.tex.freeAll(); } catch { /* context gone */ }
      P?.release(); P = null; R = null; shared?.release(); shared = null; modPack = modShared = null; prefetched.clear();
      ui?.dispose?.(); ui = null; unbindGestures?.();
      globalThis.removeEventListener?.('pagehide', onPageHide);
      removeEventListener('keydown', onKey); removeEventListener('resize', onResize);
      core.dispose();
      if (globalThis.__realm?.map === api) delete globalThis.__realm;
      if (notices) clearGpuNotice();
    },
    stats() {
      const c = core.stats(), g = ground?.stats?.() ?? {}, b = bands(cam.d);
      let globe = null; try { globe = globalThis.__globe?.gpuMB?.() ?? null; } catch { globe = null; }
      return { ...c, gpuMB: { realm: c.gpuMB, globe }, band: b.band, d: cam.d, s: cam.s, fadeWeight: b.fadeWeight,
        bytesLoaded: (P?.stats.bytesLoaded ?? 0) + (shared?.stats.bytesLoaded ?? 0), bytesBeforeFirstFrame: bytesAtFirst,
        packBytesBeforeFirstFrame: packAtFirst, engineBytes: engineAtFirst || engineBytes(),
        cpuMB: +(((P?.cpuBytes?.() ?? 0) + (shared?.cpuBytes?.() ?? 0)) / 1048576).toFixed(1), cpuTop: [...(P?.cpuTop?.() ?? []), ...(shared?.cpuTop?.(3) ?? []).map(([k, v]) => ['shared/' + k, v])], ui: ui?.stats?.() ?? null,
        firstFrameMs: firstDrawMs, firstSetMs: P?.stats.firstFrameMs ?? 0, enterTiming, mapReadyMs,
        pages: g.pages ?? null, latticePages: g.latticePages ?? null, mag: g.mag ?? null, decodePath: P?.stats.decodePath ?? null, png: P?.stats.png ? { ...P.stats.png } : null,
        legacyPack: !!P?.legacy, modules: { ...modStatus },
        laneLinks: Object.fromEntries(Object.entries(laneProgs).map(([k, s]) => [k, { programs: s.size, linking: [...s].filter(p => p.state === 'pending').map(p => p.name), failed: [...s].filter(p => p.failed).map(p => p.name) }])), ground: g, life: life.stats?.() ?? {}, bases: basesMod?.stats?.() ?? null,
        realm: R?.id ?? null, deeds: R?.meta.grid.deeds ?? null, bases_n: R?.bases.length ?? 0, rebuilding, rebuildLog,
        // D-177: the dive's landing (landMs: enter() to the camera placed, ms; d: the landing scale; fitD: the whole-realm view,
        // below 0.7 × which a pinch-out leaves). There is no hold and no floor any more (D-173's 'hold' / 'approach' states).
        dive: { state: leaving ? 'leaving' : active ? 'landed' : 'free', landMs: land.ms, d: land.d, fitD: cam.sMin() * cam.dpr },
        quality: { level: Q.level, floor: Q.floor, reason: Q.reason, pass: lastPass, groundScale: effQ(Q.level).k,
          groundScales: { rest: { chart: kFor('chart'), map: kFor('map'), true: kFor('true') }, fade: kFor(null) }, heavy: GPU_SAFE.heavy[Q.level],
          steps: Q.steps.slice(-6), losses: Q.losses, stopped: Q.stopped, hold: Q.hold, watchdogActs: Q.act, samples: Q.samples.slice(), coldSkipped: Q.cold, good: Q.good, upLock: Q.upLock,
          visit: { band: Q.visit.band, steady: Q.visit.steady.slice(), steadyBand: steadyBand() }, coldGpu: { n: Q.coldGpu.n, maxMs: Math.round(Q.coldGpu.maxMs), last: Q.coldGpu.last.slice() },
          // stage B D2: the MAP-rest governor (on: MAP rest at n0; acting: false = measure only, a software rasteriser)
          gov: { on: G.on, acting: Q.act, acts: G.acts, lock: G.lock, good: G.good, samples: G.samples.length, steps: G.steps.slice() } },
        // band rehearsal v2 (W1 S1/S2): queue = what is still to rehearse and not 'nothing' (the QA harness waits for it to
        // empty); done / nothing = (program|target) keys; stateMisses = real first uses of a state no rehearsal built
        rehearsal: { on: rhOn, noHook: [...rh.noHook], failed: [...rh.failed], last: rh.last, built: rh.built, settled: { ...rh.settled },
          queue: (rhOn ? rehearsalItems() : []).filter(it => !rh.nothing.has(itemKey(it))).map(itemKey), done: [...rh.doneKeys], nothing: [...rh.nothing],
          retrying: Object.fromEntries([...rh.tries].map(([k, v]) => [k, v.n])), stateMisses: c.programs.stateMisses, valve: rh.valve },
        gate: { lim: rh.gate.lim === Infinity ? null : rh.gate.lim, band: rh.gate.band, reason: rh.gate.reason, open: rh.gate.lim === Infinity, pressing: cam.pressing,
          bypass: !!rh.bypass, progress: +gateProgress().toFixed(2) } };
    },
    /**
     * QA targets for the §11.1 views → { x, y, base? } in deed space (a base's plot centre, plotAt):
     * 'centre' | 'mine' | 'densest' (most bases within 4 deeds) | 'shieldedWater' (shielded L9+ nearest
     * the coast) | 'riverMouth' (river end nearest the coast) | 'moat' (base whose deed centre is nearest a
     * river). Uses fieldsA.png / lines.json when the pack has them; null when it cannot answer.
     */
    async qaTarget(name) {
      if (!R) return null; const B = R.bases, at = b => b && { ...plotAt(b), base: b.id }; // a base target = its plot centre (plotOffset)
      if (name === 'centre') return { x: R.cols / 2, y: R.rows / 2 };
      if (name === 'mine') return at(B.find(b => b.mine));
      if (name === 'densest') { const g = new Map(); for (const b of B) { const k = (b.x >> 2) * 4096 + (b.y >> 2); g.set(k, (g.get(k) ?? 0) + 1); }
        let best = null, bn = -1; for (const b of B) { let n = 0; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) n += g.get(((b.x >> 2) + dx) * 4096 + (b.y >> 2) + dy) ?? 0; if (n > bn) { bn = n; best = b; } } return at(best); }
      const coastAt = await (async () => { try { const f = await P.pixels('fieldsA.png'), ppd = f.width / R.cols;
        return (x, y) => { const i = Math.min(f.height - 1, Math.max(0, Math.floor(y * ppd))) * f.width + Math.min(f.width - 1, Math.max(0, Math.floor(x * ppd))); return (f.data[i * 4] - 128) * 2; }; } catch { return null; } })();
      if (name === 'shieldedWater') { const c = B.filter(b => b.shield === true && b.level >= 9); if (!c.length) return null; if (!coastAt) return at(c[0]);
        return at(c.reduce((a, b) => (Math.abs(coastAt(b.x + 0.5, b.y + 0.5)) < Math.abs(coastAt(a.x + 0.5, a.y + 0.5)) ? b : a))); }
      let lines = null; try { lines = await P.json('lines.json'); } catch { return null; }
      const pts = r => Array.isArray(r.pts?.[0]) ? r.pts : Array.from({ length: (r.pts?.length ?? 0) / 2 }, (_, i) => [r.pts[i * 2], r.pts[i * 2 + 1]]);
      const rivers = (lines.rivers ?? []).map(pts).filter(p => p.length > 1), T = 98;
      if (name === 'riverMouth') { let best = null, bd = Infinity; for (const p of rivers) for (const e of [p[0], p[p.length - 1]]) { const d = coastAt ? Math.abs(coastAt(e[0] / T, e[1] / T)) : 0; if (d < bd) { bd = d; best = e; } } return best && { x: best[0] / T, y: best[1] / T }; }
      if (name === 'moat') { let best = null, bd = Infinity;
        for (const b of B) { const cx = b.x * T + 49, cy = b.y * T + 49;
          for (const p of rivers) for (let i = 1; i < p.length; i++) { const [ax, ay] = p[i - 1], [bx, by] = p[i], vx = bx - ax, vy = by - ay, t = Math.max(0, Math.min(1, ((cx - ax) * vx + (cy - ay) * vy) / (vx * vx + vy * vy || 1)));
            const d = Math.hypot(ax + vx * t - cx, ay + vy * t - cy); if (d < bd) { bd = d; best = b; } } }
        return best && bd < 6 ? at(best) : null; }
      return null;
    },
    /** QA hooks */
    set(v) {
      if (v.x != null || v.y != null || v.s != null || v.d != null) {
        const d = v.d ?? (v.s != null ? v.s * core.dpr : cam.d);
        // a QA jump past a closed band gate bypasses band readiness for the session (deterministic captures; the product
        // never calls set): the view it lands in is the cold one, as before the gate — measured honestly
        if (d > rh.gate.lim * 1.001) { rh.bypass = true; rh.gate = { lim: Infinity, band: null, reason: 'bypassed by a QA set()' }; cam.limitD(Infinity); }
        cam.set(v.x ?? cam.x, v.y ?? cam.y, v.d != null ? v.d / core.dpr : v.s ?? cam.s, { free: true });
      }
      core.invalidate();
    },
    /** QA: a plain loss is a restore test (level kept); { hang: true } simulates a GPU reset (safe mode, 2nd → stop). */
    loseContext: (o = {}) => { Q.qaLoss = !o.hang; return core.loseContext(); }, restoreContext: () => core.restoreContext(),
    /** QA: read every texture back (core.qaTouch; RM-GPU-1 first-visit attribution on a software rasteriser). */
    qaTouch: () => core.qaTouch(),
    /** QA / dev: set the GPU quality level (0 default, 1 slow, 2 safe); returns stats().quality. */
    quality(L) { if (L != null) { Q.stopped = false; setLevel(L, 'set by QA', { floor: L }); } return api.stats().quality; },
    bands: () => bands(cam.d), unit: UNITS, FLAG, KIND, plotRule,
  };
  globalThis.__realm = Object.assign(globalThis.__realm ?? {}, { map: api, stats: () => api.stats(), set: v => api.set(v),
    select: id => { const b = id === 'mine' ? R?.bases.find(x => x.mine) : R?.bases.find(x => String(x.id) === String(id)); api.select(b ?? null); return b; }, bands: () => api.bands() });
  return api;
}
