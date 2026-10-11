// The flat painted globe for Web World v2 (lazy chunk A). One WebGL2 context on the host's canvas draws the pinned
// shared shaders (flat.glsl.js: 'globe-flat', 'globe-isles', 'globe-fx'; the same preprocessed bytes native locks) on the
// globe-v2 pack: sky, painted albedo, sea and shore, clouds, the D-166 realm selection, the 32 exploration islands with
// their animated features, and (phaseEIslands) the three Phase E islands. Camera, gestures, picking, labels, selection
// and the dive are ports of the concept (8acdf059 src/main.js) as native ports them (GlobeV2Renderer.kt). Not ported:
// the relief pipeline, deed-detail tiles, demo bases and the Google Fonts link. No React, no store, no API: the host
// hands in its chains, its pack URLs and its sha-verified island art, and gets events back.
import * as FLAT from './flat.glsl.js';
import { globeStages, COVER_VS, COVER_FS } from './glsl.mjs';
import { P, REALMS, PHASE_E, ISLE } from './pin.mjs';
import { RAD, altOf, clamp, cross, dirOf, dot, homeFrame, len, lonlatOf, mix, norm, smooth, sphereRadiusPx, sub, zOf, createCamera, fovY } from './camera.mjs';
import { createGestures, createApproach, createCoverClock } from './motion.mjs';
import { createPicking, decodeGeography, realmGeom } from './picking.mjs';
import { chainLayer, fieldTexels, fxPoints, phaseERecords, resamplePhaseE, PE } from './content.mjs';

const REALM_IDS = REALMS.map(r => r.id);
/** The host's zoom scale (FantasyView.zoom): the home frame is 1; ≥ 5 is a realm map, so the globe stays below it. */
export const HOST_ZOOM_MAX_GLOBE = 4.99;
const IDLE_AFTER_MS = 2500, WATER_MS = 50, SELECT_MS = 33, FX_STEP_MS = 125, PE_ROWS_PER_SLICE = 48;
const FACES = [0, 1, 2, 3, 4, 5];
const ISLE_FX = Array.from({ length: ISLE.MAX }, (_, i) => `uIsleFx[${i}]`);

/**
 * createGlobe(canvas, opts) → GlobeHandle. Throws when WebGL2 is unavailable (the host falls back to the CPU globe).
 * See globe.d.mts for the options, events and handle.
 */
export function createGlobe(canvas, opts) {
  const on = opts.on ?? {};
  const emit = (name, ...a) => { try { on[name]?.(...a); } catch (e) { console.error('world globe listener', name, e); } };
  const clock = opts.now ?? (() => performance.now());
  const chains = opts.chains;
  if (!Array.isArray(chains) || chains.reduce((n, c) => n + c.islands.length, 0) > ISLE.MAX) throw Error('createGlobe: chains must be the host ARCHIPELAGOS (≤ 32 islands)');
  const attrs = { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  let gl = canvas.getContext('webgl2', attrs);
  if (!gl) throw Error('WebGL2 unavailable');

  const cam = createCamera();
  cam.reducedMotion = !!opts.reducedMotion;
  const geo = decodeGeography();
  // realm framing geometry: built on first use and warmed in idle time after the first frame (main.js realmGeo cache)
  const geoms = [], geomOf = r => (r >= 0 && r < REALM_IDS.length ? (geoms[r] ??= realmGeom(geo, r)) : null);
  const picking = createPicking({ geo, realmIds: REALM_IDS, chains });
  const approach = createApproach(), cover = createCoverClock();
  const gestures = createGestures(cam, (x, y, now) => tap(x, y, now));
  const phaseEWanted = !!opts.phaseEIslands;

  // ---------------------------------------------------------------- state
  let W = 1, H = 1, dpr = 1, layout = { top: 0, obstacles: [], panelFree: null };
  let divable = new Set(opts.divable ?? REALM_IDS);
  let night = !!opts.night, cloudsOn = opts.clouds !== false, reduced = !!opts.reducedMotion;
  let state = 'loading', failure = null, disposed = false, lost = false, asleep = false, gen = 0;
  let abort = new AbortController();
  const sel = { realm: -1, island: null, mode: 0, k: 0, kT: 0, t0: 0, col: [1, 1, 1], C: [0, 0, 1], E: [1, 0, 0], N: [0, 1, 0], layer: 0, isle: -1 };
  let diving = false, pendingDive = null, diveBlockUntil = 0, homeCy = 0, homeAt = null, lastNoMap = false;
  let lastT = NaN, lastMoveT = -Infinity, lastDrawT = 0, lastCamKey = '', wasMoving = false, rafId = 0, t0 = clock(), frames = 0;
  let lastTap = null, readyResolve, readyReject, wakeWaiters = [], settleTok = 0;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => {});

  // ---------------------------------------------------------------- GL resources (rebuilt after a context loss)
  let R = null; // { programs, vaos, textures, ... }
  const bytes = new Map(); // texture → estimated bytes (gpuBytes)
  function glInit() {
    const ext = gl.getExtension('KHR_parallel_shader_compile');
    const stages = globeStages();
    const compile = (vs, fs) => { const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s); gl.deleteShader(s); }
      gl.linkProgram(p); p.u = {}; return p; };
    const programs = { flat: compile(stages['globe-flat'].vs, stages['globe-flat'].fs), isles: compile(stages['globe-isles'].vs, stages['globe-isles'].fs),
      fx: compile(stages['globe-fx'].vs, stages['globe-fx'].fs), cover: compile(COVER_VS, COVER_FS) };
    const buf = data => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
    const ndc = buf(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1])), unit = buf(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]));
    const screen = gl.createVertexArray(); gl.bindVertexArray(screen); gl.bindBuffer(gl.ARRAY_BUFFER, ndc); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null);
    // a 1×1 RG16F field for uSelIsleMap while no island is outlined
    const dummy = tex(gl.TEXTURE_2D, gl.RG16F, 1, 1, 1, 1, gl.LINEAR, gl.CLAMP_TO_EDGE);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RG, gl.HALF_FLOAT, new Uint16Array([0, 0]));
    R = { ext, programs, ndc, unit, screen, dummy, buffers: [ndc, unit], albedo: null, albedoSize: 0, ssg: null, clouds: null, selection: null,
      isleArt: null, isleVao: null, fxVao: null, fxCount: 0, peArt: null, peVao: null, peFields: [null, null, null], peHalf: [] };
  }
  function linked(p) {
    if (R.ext && !gl.getProgramParameter(p, R.ext.COMPLETION_STATUS_KHR)) return null; // still compiling off-thread
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(`a globe program failed to build: ${gl.getProgramInfoLog(p)}`);
    return true;
  }
  const U = (p, n) => (n in p.u ? p.u[n] : (p.u[n] = gl.getUniformLocation(p, n)));
  /** An immutable texture (2D or 2D array) with a full or single mip chain; its bytes are tallied for gpuBytes(). */
  function tex(target, internal, w, h, layers, levels, minFilter, wrapS, wrapT = gl.CLAMP_TO_EDGE) {
    const t = gl.createTexture(); gl.bindTexture(target, t);
    if (target === gl.TEXTURE_2D_ARRAY) gl.texStorage3D(target, levels, internal, w, h, layers); else gl.texStorage2D(target, levels, internal, w, h);
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, minFilter); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrapS); gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrapT);
    const bpp = { [gl.RGBA8]: 4, [gl.RG8]: 2, [gl.R8]: 1, [gl.RG16F]: 4 }[internal] ?? 4;
    bytes.set(t, w * h * layers * bpp * (levels > 1 ? 4 / 3 : 1));
    return t;
  }
  const free = t => { if (t && gl) { gl.deleteTexture(t); bytes.delete(t); } };
  const fullLevels = size => Math.floor(Math.log2(size)) + 1;
  const unpack = () => { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); };
  /** Six decoded faces (+X −X +Y −Y +Z −Z, row 0 = t = −1) into a 6-layer mipmapped array (albedo RGBA8, ssg RG8, clouds R8). */
  function cubeArray(bitmaps, internal, format) {
    const size = bitmaps[0].width;
    for (const b of bitmaps) if (b.width !== size || b.height !== size) throw Error(`a globe cube face is ${b.width}x${b.height}, face 0 is ${size}²`);
    const t = tex(gl.TEXTURE_2D_ARRAY, internal, size, size, 6, fullLevels(size), gl.LINEAR_MIPMAP_LINEAR, gl.CLAMP_TO_EDGE); unpack();
    bitmaps.forEach((b, f) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, f, size, size, 1, format, gl.UNSIGNED_BYTE, b));
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY); return t;
  }

  // ---------------------------------------------------------------- content (fetch + decode; the pack is L2's)
  const url = p => opts.fileUrl(p);
  async function fileBytes(path, signal) {
    const r = await fetch(url(path), { signal, credentials: 'same-origin' });
    if (!r.ok) throw Error(`world pack ${path}: HTTP ${r.status}`);
    const b = await r.arrayBuffer(), want = opts.expectedSha256?.(path);
    if (want) { const got = [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(v => v.toString(16).padStart(2, '0')).join('');
      if (got !== want) throw Error(`world pack ${path} does not match its sha256`); }
    return b;
  }
  const bitmap = async (path, signal) => createImageBitmap(new Blob([await fileBytes(path, signal)]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  function pixelsOf(bm) { const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bm.width, bm.height) : Object.assign(document.createElement('canvas'), { width: bm.width, height: bm.height });
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0); return g.getImageData(0, 0, bm.width, bm.height).data; }
  let loaded = 0; const FIRST_FILES = 6 * 3 + REALM_IDS.length;
  const counted = p => p.then(v => { emit('progress', Math.min(0.99, ++loaded / FIRST_FILES)); return v; });

  /** The staged load of one context generation: first stage (a256, ssg, clouds, the 8 selection fields), then the
   *  1024² albedo, the exploration islands and (phaseEIslands) the Phase E islands. A late part that fails is
   *  reported and the globe keeps running without it. */
  async function load(g) {
    const signal = abort.signal, live = () => g === gen && !disposed && !lost;
    try {
      const [alb, ssg, cl, sels] = await Promise.all([
        Promise.all(FACES.map(f => counted(bitmap(`globe-v2/a256-${f}.webp`, signal)))),
        Promise.all(FACES.map(f => counted(bitmap(`globe-v2/ssg512-${f}.png`, signal)))),
        Promise.all(FACES.map(f => counted(bitmap(`baked/c512-${f}.webp`, signal)))),
        Promise.all(REALM_IDS.map(id => counted(bitmap(`globe-v2/sel-${id}.png`, signal).then(bm => { const px = pixelsOf(bm), w = bm.width, h = bm.height; bm.close?.(); return { w, h, px: fieldTexels(px, w * h) }; })))),
      ]);
      if (!live()) return;
      R.albedo = cubeArray(alb, gl.RGBA8, gl.RGBA); R.albedoSize = alb[0].width; R.ssg = cubeArray(ssg, gl.RG8, gl.RG); R.clouds = cubeArray(cl, gl.R8, gl.RED);
      for (const b of [...alb, ...ssg, ...cl]) b.close?.();
      const { w, h } = sels[0]; for (const s of sels) if (s.w !== w || s.h !== h) throw Error('the selection fields differ in size');
      R.selection = tex(gl.TEXTURE_2D_ARRAY, gl.RG16F, w, h, sels.length, 1, gl.LINEAR, gl.REPEAT); unpack();
      sels.forEach((s, r) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, r, w, h, 1, gl.RG, gl.HALF_FLOAT, s.px));
      state = 'linking'; invalidate();
    } catch (e) { if (live()) fail(reason(e)); return; }
    // late parts, in parallel; each fails alone
    late(g, 'albedo-1024', async () => { const faces = await Promise.all(FACES.map(f => bitmap(`globe-v2/a1024-${f}.webp`, signal))); if (!live()) return;
      const t = cubeArray(faces, gl.RGBA8, gl.RGBA), size = faces[0].width; faces.forEach(b => b.close?.()); free(R.albedo); R.albedo = t; R.albedoSize = size; invalidate(); });
    late(g, 'islands', () => loadIslands(g, signal));
    if (phaseEWanted) late(g, 'phase-e islands', () => loadPhaseE(g, signal));
  }
  function late(g, part, job) { job().catch(e => { if (g === gen && !disposed && e?.name !== 'AbortError') emit('partUnavailable', part, reason(e)); }); }

  async function loadIslands(g, signal) {
    const read = opts.readIslandArt; if (!read) return;
    const effects = (opts.loadIslandEffects ?? (() => import('../../runtime/island-effects.mjs').then(m => m.effectAnchors)))();
    const arts = await Promise.all(chains.map(c => Promise.all([read(`generated/${c.id}-detail.png`, signal), read(`generated/${c.id}-detail-mask.png`, signal)])));
    const built = [];
    for (const [k, [color, mask]] of arts.entries()) { // one chain per idle slice: never one long task after the first frame
      if (color.width !== ISLE.ATLAS || color.height !== ISLE.ATLAS || mask.width !== ISLE.ATLAS || mask.height !== ISLE.ATLAS) throw Error(`chain ${chains[k].id} atlas is not ${ISLE.ATLAS}²`);
      await idleSlice(); if (g !== gen || disposed) return; built.push(chainLayer(color.data, mask.data)); }
    let fx = null; try { fx = fxPoints(await effects); } catch (e) { emit('partUnavailable', 'island effects', reason(e)); }
    if (g !== gen || disposed || lost) return;
    const half = built[0].size, t = tex(gl.TEXTURE_2D_ARRAY, gl.RGBA8, half, half, built.length, fullLevels(half), gl.LINEAR_MIPMAP_LINEAR, gl.CLAMP_TO_EDGE); unpack();
    built.forEach((b, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, half, half, 1, gl.RGBA, gl.UNSIGNED_BYTE, b.layer));
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    // instances: (lon, lat, rx, ry), (chain layer, slot x, slot y, 0), host chain order
    const inst = []; chains.forEach((c, ci) => c.islands.forEach((s, slot) => inst.push(s.lon, s.lat, s.rx, s.ry, ci, slot % 3, Math.floor(slot / 3), 0)));
    R.isleArt = t; R.isleCell = ISLE.CELL / ISLE.DOWNSCALE; R.isleAtlas = half; R.isleCount = inst.length / 8; R.isleData = inst;
    R.isleVao = isleVao(new Float32Array(inst));
    if (fx && fx.count) {
      const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, R.unit); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      const b1 = mk(fx.dirs), b2 = mk(fx.info), b3 = mk(fx.colors);
      gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0); gl.vertexAttribDivisor(1, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, b2); gl.enableVertexAttribArray(2); gl.vertexAttribIPointer(2, 4, gl.INT, 16, 0); gl.vertexAttribDivisor(2, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, b3); gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 4, 0); gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null); R.fxVao = vao; R.fxCount = fx.count;
    }
    R.isleFx = new Float32Array(ISLE.MAX * 4);
    picking.lands = built.map(b => b.land); // what you see is what you tap (RG-1)
    invalidate();
  }
  function mk(data) { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); R.buffers.push(b); return b; }
  function isleVao(records) {
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, R.unit); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mk(records));
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16); gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null); return vao;
  }

  /** Phase E (D-172/D-182): per island its RG16F outline field and its art resampled into a LAYER² layer over its box,
   *  a slice of rows per idle frame so no long task stalls the page. On only with the phaseEIslands option (RG-3). */
  async function loadPhaseE(g, signal) {
    const meta = JSON.parse(new TextDecoder().decode(await fileBytes('globe-v2/globe-v2.json', signal)));
    const entries = PHASE_E.map(s => { const e = meta?.selection?.phaseE?.find(x => x.id === s.id);
      if (!e) throw Error(`globe-v2.json has no field for ${s.id}`);
      if (Math.abs(e.lon - s.lon) > 1e-9 || Math.abs(e.lat - s.lat) > 1e-9) throw Error(`the ${s.id} field is not at the pinned placement`);
      return e; });
    const fields = await Promise.all(entries.map(async e => { const bm = await bitmap(`globe-v2/${e.file}`, signal); const px = pixelsOf(bm);
      if (bm.width !== e.w || bm.height !== e.h) throw Error(`${e.file} is ${bm.width}x${bm.height}`); bm.close?.(); return { w: e.w, h: e.h, hu: e.hu, hv: e.hv, px: fieldTexels(px, e.w * e.h) }; }));
    const size = opts.phaseELayer ?? PE.LAYER, layers = [];
    for (const s of PHASE_E) { const bm = await bitmap(`${s.id}.webp`, signal), px = pixelsOf(bm), w = bm.width, h = bm.height; bm.close?.();
      const out = new Uint8Array(size * size * 4);
      for (let j = 0; j < size; j += PE_ROWS_PER_SLICE) { if (g !== gen || disposed) return; resamplePhaseE(s, px, w, h, size, out, j, Math.min(size, j + PE_ROWS_PER_SLICE)); await idleSlice(); }
      layers.push(out); }
    if (g !== gen || disposed || lost) return;
    const t = tex(gl.TEXTURE_2D_ARRAY, gl.RGBA8, size, size, layers.length, fullLevels(size), gl.LINEAR_MIPMAP_LINEAR, gl.CLAMP_TO_EDGE); unpack();
    layers.forEach((l, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, l));
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    R.peFields = fields.map(f => { const ft = tex(gl.TEXTURE_2D, gl.RG16F, f.w, f.h, 1, 1, gl.LINEAR, gl.CLAMP_TO_EDGE); unpack(); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.w, f.h, gl.RG, gl.HALF_FLOAT, f.px); return ft; });
    R.peHalf = fields.map(f => [f.hu, f.hv]);
    R.peArt = t; R.peSize = size; R.peVao = isleVao(phaseERecords());
    picking.phaseE = true; cam.phaseE = true; // drawn, picked and framed from now on (what you see is what you tap)
    emit('phaseEIslands', PHASE_E.map(s => s.id));
    invalidate();
  }
  function warmGeoms(r) { if (disposed || r >= REALM_IDS.length) return; idleSlice().then(() => { geomOf(r); warmGeoms(r + 1); }); }
  const idleSlice = () => new Promise(res => (globalThis.requestIdleCallback ? requestIdleCallback(() => res(), { timeout: 200 }) : setTimeout(res, 0)));

  function fail(why) {
    if (state === 'failed') return;
    state = 'failed'; failure = why; emit('unavailable', why); readyReject(Error(why));
  }
  const reason = e => (e && e.message) || String(e);

  // ---------------------------------------------------------------- layout, lens, home
  function freeRect() { const f = layout.panelFree; return panelOpen() && f ? f : { x0: 0, y0: 0, x1: W, y1: H }; }
  const panelOpen = () => (sel.realm >= 0 || sel.island != null) && !!layout.panelFree;
  function updateLens() { const f = freeRect(), open = panelOpen();
    cam.lens.tx = open ? ((f.x0 + f.x1) / 2 - W / 2) / (W / 2) : 0; cam.lens.ty = (H / 2 - (open ? (f.y0 + f.y1) / 2 : homeCy)) / (H / 2); }
  function applyHome(snap) { const h = homeFrame(W, H, layout.top ?? 0, layout.obstacles ?? []); cam.zLo = Math.min(0, zOf(h.alt)); homeCy = h.cy;
    if (snap) { cam.z = cam.zT = zOf(h.alt); homeAt = { z: cam.z, t: cam.t.slice() }; updateLens(); cam.lens.x = cam.lens.tx; cam.lens.y = cam.lens.ty; }
    return h; }
  const atHome = () => !!homeAt && !cam.anim && cam.z === homeAt.z && cam.zT === homeAt.z && cam.t.every((v, i) => v === homeAt.t[i]);
  function resize() {
    const w = canvas.clientWidth || canvas.width || 1, h = canvas.clientHeight || canvas.height || 1;
    dpr = Math.min(globalThis.devicePixelRatio || 1, P.DPR_CAP);
    const first = W === 1 && H === 1; W = w; H = h;
    canvas.width = Math.max(1, Math.round(w * dpr)); canvas.height = Math.max(1, Math.round(h * dpr));
    applyHome(first || atHome()); updateLens(); cam.computeView(W, H); invalidate();
  }

  // ---------------------------------------------------------------- selection (main.js selectRealm / selectIsland / deselect)
  const hexRGB = n => [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  function fxFrame(c) { const E = norm(cross([0, 1, 0], c)); sel.C = c; sel.E = E; sel.N = cross(c, E); }
  const entranceAt = (dur, now) => now + Math.max(0, dur * P.ENTRANCE_K - P.ENTRANCE_LEAD_MS);
  function focusOn(c, pts, minAlt, dur, now) { updateLens(); const f = freeRect(), pad = P.FOCUS_PAD;
    return cam.flyTo(c, zOf(cam.fitAlt(pts, c, Math.max(60, (f.x1 - f.x0) / 2 - pad), Math.max(60, (f.y1 - f.y0) / 2 - pad), minAlt, W, H)), now, dur); }
  function selectRealm(r, { fly = true, dur, quiet = false } = {}) {
    const now = clock(), g = geomOf(r); if (!g) return false;
    const fresh = !(sel.mode === 1 && sel.realm === r && sel.k > 0.01);
    sel.realm = r; sel.island = null; sel.mode = 1; sel.kT = 1; sel.layer = r; sel.col = hexRGB(REALMS[r].accent); fxFrame(g.c);
    const d = fly ? focusOn(g.c, g.pts, P.REALM_FOCUS_ALT, dur, now) : 0; if (fresh) sel.t0 = entranceAt(d, now);
    if (!quiet) emit('select', REALM_IDS[r], null); invalidate(); return true;
  }
  function selectIsland(id, { quiet = false } = {}) {
    const i = PHASE_E.findIndex(s => s.id === id); if (i < 0 || !picking.phaseE) return false;
    const now = clock(), I = PHASE_E[i], fresh = !(sel.mode === 2 && sel.island === id && sel.k > 0.01);
    sel.realm = -1; sel.island = id;
    const cl = Math.cos(I.lat * RAD), c = dirOf(I.lon, I.lat);
    const pts = Array.from({ length: 24 }, (_, a) => dirOf(I.lon + Math.cos(a / 24 * 2 * Math.PI) * I.rx * 1.7 / cl, I.lat + Math.sin(a / 24 * 2 * Math.PI) * I.ry * 1.7));
    const d = focusOn(c, pts, 0.2, undefined, now);
    if (!quiet) emit('select', null, id);
    if (fresh) { if (R?.peFields[i]) { sel.mode = 2; sel.kT = 1; sel.isle = i; sel.col = hexRGB(I.accent); fxFrame(c); sel.t0 = Math.max(entranceAt(d, now), now); } else sel.kT = 0; }
    invalidate(); return true;
  }
  function deselect({ quiet = false } = {}) {
    if (sel.realm < 0 && sel.island == null) return;
    sel.realm = -1; sel.island = null; sel.kT = 0; updateLens(); if (!quiet) emit('select', null, null); invalidate();
  }

  // ---------------------------------------------------------------- the dive (main.js diveInto / frame / enterRealm)
  function diveInto(id, { target } = {}) {
    const r = REALM_IDS.indexOf(id); if (r < 0 || !divable.has(id) || diving || asleep || state !== 'ready') return false;
    const now = clock(), c = target ?? geomOf(r).c; diving = true;
    const far = Math.acos(clamp(dot(norm(cam.t), c), -1, 1)) > P.DIVE_FAR_RAD;
    cam.flyTo(c, zOf(P.DIVE_FLIGHT_ALT), now, far ? undefined : P.DIVE_FLIGHT_MS, far ? 'inout' : 'in');
    pendingDive = r;
    approach.mark(id); emit('approach', id); // D-177: the realm's first set loads during the flight, not after it
    invalidate(); return true;
  }
  function cancelDive() {
    settleTok++; // a dive being undone never ends in a queued sleep
    if (!diving || pendingDive == null) return null;
    const r = pendingDive, now = clock(); diving = false; pendingDive = null; diveBlockUntil = now + P.LEAVE_BLOCK_MS;
    cam.anim = null; selectRealm(r, { fly: true }); return REALM_IDS[r];
  }
  function enterRealm(id, lon, lat, now) {
    diving = true; const v = cam.view, sStart = 0.5 * RAD * v.pxPerRad / v.alt; // the globe's own CSS px per deed
    cover.start(now); emit('dive', { realmId: id, lon, lat, sStart });
  }

  // ---------------------------------------------------------------- input
  function tap(x, y, now) {
    if (lastTap && now - lastTap[2] < P.DOUBLE_TAP_MS && Math.hypot(x - lastTap[0], y - lastTap[1]) < P.DOUBLE_TAP_PX) {
      const p = cam.hitSphere(x, y); if (p) cam.flyTo(p, clamp(cam.z + P.DOUBLE_TAP_DZ, 0, 1), now, P.DOUBLE_TAP_MS2); lastTap = null; return; }
    lastTap = [x, y, now];
    const hit = cam.hitSphere(x, y);
    if (!hit) { deselect(); emit('pick', { kind: 'space' }); return; }
    const { lon, lat } = lonlatOf(hit), v = cam.view, footprint = Math.PI / 384 * v.pxPerRad / len(sub(v.eye, hit)) * dpr;
    const pick = picking.pick(lon, lat, footprint);
    if (pick.kind === 'realm') selectRealm(pick.index);
    else if (pick.kind === 'phase-e') { selectIsland(pick.id); emit('pick', { ...pick, lon, lat }); return; }
    else deselect();
    emit('pick', { ...pick, lon, lat });
  }
  const pos = e => { const b = canvas.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };
  const listeners = [
    ['pointerdown', e => { if (!interactive()) return; canvas.setPointerCapture?.(e.pointerId); const [x, y] = pos(e); gestures.down(e.pointerId, x, y, clock()); emit('interact'); invalidate(); }],
    ['pointermove', e => { if (!interactive()) return; const [x, y] = pos(e); gestures.move(e.pointerId, x, y, clock()); invalidate(); }],
    ['pointerup', e => { const [x, y] = pos(e); gestures.up(e.pointerId, x, y, clock()); invalidate(); }],
    ['pointercancel', e => { gestures.up(e.pointerId, 0, 0, clock(), true); invalidate(); }],
    ['wheel', e => { if (!interactive()) return; e.preventDefault(); const [x, y] = pos(e); cam.anim = null; cam.zT = clamp(cam.zT - e.deltaY * 0.0011, cam.zLo, 1); cam.anchor = cam.hitSphere(x, y); invalidate(); }, { passive: false }],
    ['webglcontextlost', e => { e.preventDefault(); onLost(); }],
    ['webglcontextrestored', () => onRestored()],
  ];
  const interactive = () => state === 'ready' && !asleep && !disposed && !lost;
  for (const [n, f, o] of listeners) canvas.addEventListener(n, f, o);
  canvas.style.touchAction = 'none';

  // ---------------------------------------------------------------- frame
  function invalidate() { if (!rafId && !disposed && !asleep && !lost) rafId = requestAnimationFrame(frame); }
  function frame(nowRaf) {
    rafId = 0; if (disposed || asleep || lost) return;
    const now = clock();
    if (state === 'linking') {
      try { const p = R.programs; if (!(linked(p.flat) && linked(p.isles) && linked(p.fx))) { invalidate(); return; } try { if (!linked(p.cover)) { invalidate(); return; } } catch (e) { R.coverBroken = true; emit('partUnavailable', 'dive cover', reason(e)); } }
      catch (e) { fail(reason(e)); return; }
      state = 'ready';
    }
    if (state !== 'ready') return;
    const dt = Number.isNaN(lastT) ? 0 : Math.min(P.DT_MAX, (now - lastT) / 1000); lastT = now;
    cam.computeView(W, H); // this frame's gestures grabbed against the view they saw
    const { lon, lat } = lonlatOf(norm(cam.t)), here = picking.realmIdAt(lon, lat);
    const canDive = !!here && divable.has(here) && now > diveBlockUntil;
    const zMax = zOf(canDive ? P.ALT_MIN_ATLAS * P.DIVE_ALT_K : cam.minAltAt(cam.t));
    const pushed = cam.zT > zMax + 0.004 && !cam.anim && !diving;
    if (pushed && !lastNoMap) { const isle = picking.phaseE ? PHASE_E.find(I => ((((lon - I.lon + 540) % 360) - 180) * Math.cos(I.lat * RAD) / I.rx) ** 2 + ((lat - I.lat) / I.ry) ** 2 < 1) : null; emit('noMap', isle ? isle.id : here); }
    lastNoMap = pushed;
    let moving = cam.step(now, dt, zMax);
    if (sel.k !== sel.kT) { sel.k = clamp(sel.k + Math.sign(sel.kT - sel.k) * dt / P.SEL_FADE_S, 0, 1); if (sel.k === 0) sel.mode = 0; moving = true; }
    if (pendingDive != null && !cam.anim) { const r = pendingDive; pendingDive = null; const t = lonlatOf(norm(cam.t)); enterRealm(REALM_IDS[r], t.lon, t.lat, now); }
    else if (!cam.anim && !diving && cam.zT >= cam.z - 1e-3 && altOf(cam.z) < P.DIVE_ALT && canDive) {
      if (sel.realm >= 0 && REALM_IDS[sel.realm] !== here) deselect();
      enterRealm(here, lon, lat, now);
    }
    const v = cam.computeView(W, H);
    const motion = moving || gestures.active > 0 || !!cam.vel || !!cam.anim;
    if (motion) lastMoveT = now;
    const pre = approach.step(now, canDive ? here : null, altOf(cam.z), altOf(cam.zT), gestures.active >= 2, motion, !!cam.vel, !!cam.anim || diving);
    if (pre) emit('approach', pre);
    if (wasMoving && !motion) emit('view', hostView());
    wasMoving = motion;
    const camKey = v.eye.map(x => x.toFixed(5)).join() + cam.lens.x.toFixed(4) + cam.lens.y.toFixed(4) + W + 'x' + H + (sel.realm) + (sel.island ?? '');
    if (camKey !== lastCamKey) { lastCamKey = camKey; emit('labels', labels()); }
    // idle is light: after the camera rests IDLE_AFTER_MS only the water, cloud and selection motion runs, at 20 (30) fps;
    // with reduced motion a still globe draws nothing until something changes
    const fxBusy = sel.k !== sel.kT || (sel.mode > 0 && now - sel.t0 < P.FX_BUSY_MS);
    const animating = !reduced;
    const busy = motion || fxBusy || cover.animating || now - lastMoveT < IDLE_AFTER_MS;
    const due = busy || (animating && now - lastDrawT >= (sel.mode ? SELECT_MS : WATER_MS)) || frames === 0 || wakeWaiters.length > 0 || forceDraw;
    if (due) { draw(now); lastDrawT = now; frames++; forceDraw = false; for (const w of wakeWaiters.splice(0)) w(); }
    if (frames === 1 && !announced) { announced = true; emit('progress', 1); emit('ready'); readyResolve(); warmGeoms(0); }
    if (busy || animating) invalidate();
  }
  let forceDraw = false, announced = false;

  function sunDir(t) { const east = norm(cross([0, 1, 0], t)), north = cross(t, east);
    const s = night ? [t[0] * P.NIGHT_SUN_T + east[0] * P.NIGHT_SUN_EAST, t[1] * P.NIGHT_SUN_T + east[1] * P.NIGHT_SUN_EAST, t[2] * P.NIGHT_SUN_T + east[2] * P.NIGHT_SUN_EAST]
      : [t[0] * P.SUN_T + east[0] * P.SUN_EAST + north[0] * P.SUN_NORTH, t[1] * P.SUN_T + east[1] * P.SUN_EAST + north[1] * P.SUN_NORTH, t[2] * P.SUN_T + east[2] * P.SUN_EAST + north[2] * P.SUN_NORTH];
    return norm(s); }
  function common(p, v, fv) {
    const m = v.inv; gl.uniform4f(U(p, 'uInvVP0'), m[0], m[1], m[2], m[3]); gl.uniform4f(U(p, 'uInvVP1'), m[4], m[5], m[6], m[7]); gl.uniform4f(U(p, 'uInvVP2'), m[8], m[9], m[10], m[11]); gl.uniform4f(U(p, 'uInvVP3'), m[12], m[13], m[14], m[15]);
    gl.uniform4f(U(p, 'uEye'), v.eye[0], v.eye[1], v.eye[2], 1 / (v.pxPerRad * dpr));
    gl.uniform4f(U(p, 'uSun'), fv.sun[0], fv.sun[1], fv.sun[2], night ? 1 : 0);
    gl.uniform4f(U(p, 'uClock'), fv.seconds, fv.seconds * P.CLOUD_ROT_PER_S, fv.cloud, v.alt);
    const island = sel.mode === 2 && !!R.peFields[sel.isle], mode = sel.mode === 2 && !island ? 0 : sel.mode;
    gl.uniform4f(U(p, 'uSel'), mode > 0 && fv.selK > 0 ? mode : 0, fv.selK, fv.selSeconds, fv.selMotion);
    gl.uniform4f(U(p, 'uSelCol'), sel.col[0], sel.col[1], sel.col[2], 1);
    gl.uniform4f(U(p, 'uSelC'), sel.C[0], sel.C[1], sel.C[2], sel.layer); gl.uniform4f(U(p, 'uSelE'), sel.E[0], sel.E[1], sel.E[2], 0); gl.uniform4f(U(p, 'uSelN'), sel.N[0], sel.N[1], sel.N[2], 0);
    if (island) gl.uniform4f(U(p, 'uSelIsle'), R.peHalf[sel.isle][0], R.peHalf[sel.isle][1], 0, 0); else gl.uniform4f(U(p, 'uSelIsle'), 1, 1, 0, 0);
  }
  function bind(p, name, unit, target, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t); gl.uniform1i(U(p, name), unit); }
  function selSamplers(p) { bind(p, 'uCloud', 2, gl.TEXTURE_2D_ARRAY, R.clouds); bind(p, 'uSelMap', 3, gl.TEXTURE_2D_ARRAY, R.selection);
    bind(p, 'uSelIsleMap', 4, gl.TEXTURE_2D, sel.mode === 2 && R.peFields[sel.isle] ? R.peFields[sel.isle] : R.dummy); }
  function vp(p, v) { const m = v.VP; gl.uniform4f(U(p, 'uVP0'), m[0], m[1], m[2], m[3]); gl.uniform4f(U(p, 'uVP1'), m[4], m[5], m[6], m[7]); gl.uniform4f(U(p, 'uVP2'), m[8], m[9], m[10], m[11]); gl.uniform4f(U(p, 'uVP3'), m[12], m[13], m[14], m[15]); }

  /** The legacy visible() rule and feature size per exploration island (native ExplorationIslandLayer.frame). */
  function islandFx(v) {
    const e = norm(v.eye), fx = R.isleFx, d = R.isleData;
    for (let i = 0; i < R.isleCount; i++) {
      const lon = d[i * 8], lat = d[i * 8 + 1], rx = d[i * 8 + 2], ry = d[i * 8 + 3], p = dirOf(lon, lat), facing = dot(p, e);
      const pxPerRad = v.pxPerRad / len(sub(v.eye, p)), across = 2 * rx * RAD * Math.cos(lat * RAD) * pxPerRad * facing;
      const s = facing > 0.2 && across >= 48 ? cam.projectDir(p, 0) : null;
      const shown = !!s && s[0] > -30 && s[0] < W + 30 && s[1] > -30 && s[1] < H + 30;
      fx[i * 4] = Math.max(1, Math.round(pxPerRad * dpr * RAD * 2 * ISLE.EXTENT * Math.max(rx * Math.cos(lat * RAD), ry) / ISLE.CELL)); fx[i * 4 + 1] = shown ? 1 : 0;
    }
  }

  function draw(now) {
    const v = cam.view, motion = !reduced;
    const fv = { sun: sunDir(v.t), seconds: motion ? (now - t0) / 1000 : 0, cloud: cloudsOn ? smooth(P.CLOUD_ALT0, P.CLOUD_ALT1, v.alt) : 0,
      selK: sel.k * sel.k * (3 - 2 * sel.k), selSeconds: (now - sel.t0) / 1000, selMotion: motion ? 1 : 0 };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    const pf = R.programs.flat; gl.useProgram(pf); common(pf, v, fv);
    bind(pf, 'uAlbedo', 0, gl.TEXTURE_2D_ARRAY, R.albedo); bind(pf, 'uSsg', 1, gl.TEXTURE_2D_ARRAY, R.ssg); selSamplers(pf);
    gl.bindVertexArray(R.screen); gl.drawArrays(gl.TRIANGLES, 0, 6);
    const pi = R.programs.isles;
    if (R.isleVao || R.peVao) {
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.useProgram(pi); common(pi, v, fv); vp(pi, v); selSamplers(pi);
      if (R.isleVao) { gl.uniform4f(U(pi, 'uIsleGrid'), R.isleCell, R.isleAtlas, ISLE.EXTENT, 0); bind(pi, 'uIsleArt', 5, gl.TEXTURE_2D_ARRAY, R.isleArt);
        gl.bindVertexArray(R.isleVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, R.isleCount); }
      if (R.peVao) { gl.uniform4f(U(pi, 'uIsleGrid'), R.peSize, R.peSize, 1, 0); bind(pi, 'uIsleArt', 5, gl.TEXTURE_2D_ARRAY, R.peArt);
        gl.bindVertexArray(R.peVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, PHASE_E.length); }
      if (R.fxVao) { islandFx(v); const px = R.programs.fx; gl.useProgram(px); common(px, v, fv); vp(px, v); selSamplers(px);
        gl.uniform4f(U(px, 'uFx'), motion ? Math.floor((now - t0) / FX_STEP_MS) % 8 : 0, 0, canvas.width, canvas.height);
        for (let i = 0; i < R.isleCount; i++) gl.uniform4f(U(px, ISLE_FX[i]), R.isleFx[i * 4], R.isleFx[i * 4 + 1], 0, 0);
        gl.bindVertexArray(R.fxVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, R.fxCount); }
      gl.disable(gl.BLEND);
    }
    const a = cover.alpha(now);
    if (a > 0 && !R.coverBroken) { const pc = R.programs.cover; gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.useProgram(pc);
      bind(pc, 'uCloud', 2, gl.TEXTURE_2D_ARRAY, R.clouds); gl.uniform4f(U(pc, 'uCover'), a, reduced ? 0 : cover.seconds(now), canvas.width, canvas.height);
      gl.bindVertexArray(R.screen); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.disable(gl.BLEND); }
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------- labels (main.js updateLabels anchors; placement is the HUD's)
  function labels() {
    const v = cam.view, out = [];
    if (!v || v.alt <= P.LABEL_ALT) return out;
    const eL = len(v.eye), e = norm(v.eye);
    const add = (kind, id, name, lon, lat) => { const d = dirOf(lon, lat); if (dot(d, e) < 1 / eL + P.LABEL_LIMB) return; const s = cam.projectDir(d, P.LABEL_LIFT); if (s) out.push({ kind, id, name, x: s[0], y: s[1] }); };
    for (const r of REALMS) add('realm', r.id, r.name, r.lon, r.lat);
    if (picking.phaseE) for (const i of PHASE_E) add('island', i.id, i.name, i.lon, i.lat);
    return out;
  }

  // ---------------------------------------------------------------- host scale
  function hostView() { const v = cam.view ?? cam.computeView(W, H), home = homeFrame(W, H, layout.top ?? 0, layout.obstacles ?? []);
    const zoom = clamp(sphereRadiusPx(v.alt, W, H) / sphereRadiusPx(home.alt, W, H), 0.05, HOST_ZOOM_MAX_GLOBE);
    return { lon: v.lon, lat: v.lat, zoom }; }
  function altForZoom(zoom) { const home = homeFrame(W, H, layout.top ?? 0, layout.obstacles ?? []), f = H / 2 / Math.tan(fovY(W, H) / 2), r = sphereRadiusPx(home.alt, W, H) * zoom;
    return Math.sqrt(1 + (f / r) ** 2) - 1; }

  // ---------------------------------------------------------------- context loss, sleep, dispose
  function onLost() { lost = true; gen++; abort.abort(); abort = new AbortController(); if (rafId) cancelAnimationFrame(rafId); rafId = 0; R = null; bytes.clear(); gestures.cancelAll(); approach.reset(); cover.reset();
    picking.lands = null; picking.phaseE = false; cam.phaseE = false; emit('contextLost'); }
  function onRestored() { if (disposed) return; lost = false; state = 'loading'; loaded = 0; glInit(); load(++gen); emit('contextRestored'); invalidate(); }
  function releaseGL() {
    if (!R || !gl) return;
    for (const t of [...bytes.keys()]) gl.deleteTexture(t); bytes.clear();
    for (const p of Object.values(R.programs)) gl.deleteProgram(p);
    for (const b of R.buffers) gl.deleteBuffer(b);
    for (const a of [R.screen, R.isleVao, R.fxVao, R.peVao]) if (a) gl.deleteVertexArray(a);
    R = null;
  }

  // ---------------------------------------------------------------- start
  glInit(); resize(); load(++gen); invalidate();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null; ro?.observe(canvas);
  if (opts.initial) restore(opts.initial);

  function snapshot() { return { t: cam.t.slice(), z: cam.z, realmId: sel.realm >= 0 ? REALM_IDS[sel.realm] : null, islandId: sel.island }; }
  function restore(s) {
    if (s.t) { cam.t = norm(s.t); cam.z = cam.zT = clamp(s.z ?? cam.z, cam.zLo, 1); cam.anim = null; }
    else if (s.lon != null) { cam.t = dirOf(s.lon, s.lat); if (s.zoom != null) cam.z = cam.zT = zOf(altForZoom(s.zoom)); }
    if (s.realmId) { const r = REALM_IDS.indexOf(s.realmId); if (r >= 0) selectRealm(r, { fly: false, quiet: true }); }
    invalidate();
  }

  const api = {
    ready,
    get state() { return state; }, get failure() { return failure; }, get asleep() { return asleep; },
    resize,
    setLayout(l) { layout = { top: l.top ?? 0, obstacles: l.obstacles ?? [], panelFree: l.panelFree ?? null }; applyHome(atHome()); updateLens(); invalidate(); },
    setDivable(ids) { divable = new Set(ids); invalidate(); },
    setReducedMotion(b) { reduced = !!b; cam.reducedMotion = reduced; invalidate(); },
    setNight(b) { night = !!b; invalidate(); }, setClouds(b) { cloudsOn = !!b; invalidate(); },
    selectRealm(id, o) { const r = REALM_IDS.indexOf(id); return r >= 0 && selectRealm(r, o); },
    selectIsland(id) { return selectIsland(id); },
    deselect(o) { deselect(o); },
    get selection() { return { realmId: sel.realm >= 0 ? REALM_IDS[sel.realm] : null, islandId: sel.island }; },
    focusRealm(id) { const r = REALM_IDS.indexOf(id); return r >= 0 && selectRealm(r, { fly: true }); },
    focusIsland(chainId, islandId) {
      const c = chains.find(x => x.id === chainId); if (!c) return false;
      const k = islandId ? Number(islandId.slice(chainId.length + 1)) - 1 : -1, list = k >= 0 && c.islands[k] ? [c.islands[k]] : c.islands;
      const pts = list.flatMap(s => [-1, 1].flatMap(a => [dirOf(s.lon + a * s.rx * 1.6, s.lat), dirOf(s.lon, s.lat + a * s.ry * 1.6)]));
      const m = norm(list.reduce((acc, s) => acc.map((x, i) => x + dirOf(s.lon, s.lat)[i]), [0, 0, 0]));
      deselect({ quiet: true }); focusOn(m, pts, P.ALT_MIN_ATLAS, undefined, clock()); invalidate(); return true;
    },
    focusPoint(lon, lat, alt) { cam.flyTo(dirOf(lon, lat), zOf(clamp(alt ?? 0.9, P.ALT_MIN_ATLAS, P.ALT_MAX)), clock()); invalidate(); },
    zoomBy(dz) { cam.zT = clamp(cam.zT + dz, cam.zLo, 1); cam.anchor = null; invalidate(); },
    home() { deselect(); const h = applyHome(false); cam.flyTo(norm(cam.t), zOf(h.alt), clock()); updateLens(); invalidate(); },
    view: hostView,
    /** Fly to a host view. Host zooms ≥ 5 are realm-map views: the caller routes those to the realm engine; here the
     *  camera goes as close as the globe allows over (lon, lat). */
    setView(v, { instant = false } = {}) { const alt = Math.max(altForZoom(Math.min(v.zoom, HOST_ZOOM_MAX_GLOBE)), P.ALT_MIN_ATLAS), d = dirOf(v.lon, v.lat);
      if (instant) { cam.anim = null; cam.t = d; cam.z = cam.zT = zOf(alt); } else cam.flyTo(d, zOf(alt), clock()); invalidate(); },
    diveInto(id, o) { return diveInto(id, o); },
    cancelDive,
    /** The realm map is ready under the cover (its snapshot fade may start): the clouds stop rising. */
    diveReady() { cover.ready(clock()); invalidate(); },
    /** The host's answer to a dive event: ok = the realm map is live (the globe parts its clouds, then sleeps). */
    diveResult(ok, realmId) {
      const now = clock(), tok = ++settleTok; diving = false;
      // web port (L9): the parting's sleep is cancellable. A leave, wake or cancelled dive bumps settleTok, so a player who
      // leaves the realm map while the clouds still part is never left on a globe this loop put to sleep after the leave
      if (ok) { cover.live(now); const settle = () => { if (tok !== settleTok || disposed) return; if (cover.animating) { invalidate(); requestAnimationFrame(settle); } else api.sleep(); }; settle(); return; }
      cover.failed(now); diveBlockUntil = now + P.DIVE_FAIL_BLOCK_MS;
      if (altOf(cam.zT) < 0.34) { cam.anim = null; cam.zT = zOf(0.34); }
      const r = REALM_IDS.indexOf(realmId); if (r >= 0) selectRealm(r, { fly: true, dur: 600 }); invalidate();
    },
    /** The realm map closed (main.js leaveRealm): wake on the realm the map showed, framed as when it was selected. */
    leave({ realmId, lon, lat }) {
      settleTok++; asleep = false; diving = false; pendingDive = null; cover.reset(); const now = clock(); diveBlockUntil = now + P.LEAVE_BLOCK_MS;
      cam.anim = null; cam.vel = null; cam.anchor = null; const here = dirOf(lon, lat), r = realmId ? REALM_IDS.indexOf(realmId) : -1;
      if (sel.realm >= 0) {
        cam.t = here; selectRealm(r >= 0 ? r : sel.realm, { fly: true, quiet: true });
        const A = cam.anim, t = A ? A.t1 : here, z = A ? A.z1 : cam.z; cam.lens.x = cam.lens.tx; cam.lens.y = cam.lens.ty;
        cam.t = t.slice(); cam.z = cam.zT = Math.max(z, Math.min(z + 0.06, zOf(P.ALT_MIN_ATLAS))); cam.flyTo(t, z, now, 900, 'out');
        if (sel.t0 > now) sel.t0 = entranceAt(900, now);
      } else { cam.t = here; cam.z = cam.zT = zOf(0.7); cam.flyTo(here, zOf(0.9), now, 900, 'out'); }
      lastT = NaN; return api.wake();
    },
    sleep() { asleep = true; diving = false; pendingDive = null; approach.reset(); gestures.cancelAll(); if (rafId) cancelAnimationFrame(rafId); rafId = 0; },
    /** Wake from sleep; resolves once a globe frame is on the canvas (the host keeps its realm snapshot until then: the
     *  reverse fade never shows a black frame). */
    wake() { if (disposed) return Promise.reject(Error('disposed')); settleTok++; asleep = false; lastT = NaN; forceDraw = true;
      const p = new Promise(res => wakeWaiters.push(res)); ready.then(() => invalidate(), () => {}); invalidate(); return p; },
    snapshot, restore,
    labels,
    gpuBytes() { let s = 0; for (const b of bytes.values()) s += b; return Math.round(s); },
    stats() { return { state, frames, albedo: R?.albedoSize ?? 0, islands: !!R?.isleVao, phaseE: !!R?.peVao, gpuBytes: api.gpuBytes(), view: hostView(), alt: cam.view?.alt ?? altOf(cam.z) }; },
    dispose() {
      if (disposed) return; disposed = true; gen++; abort.abort(); if (rafId) cancelAnimationFrame(rafId); rafId = 0; ro?.disconnect();
      for (const [n, f, o] of listeners) canvas.removeEventListener(n, f, o);
      for (const w of wakeWaiters.splice(0)) w();
      if (!lost) releaseGL(); gl.getExtension('WEBGL_lose_context')?.loseContext(); gl = null;
    },
    /** Test hook: the camera (pure; see camera.mjs). */
    get camera() { return cam; },
  };
  return api;
}
