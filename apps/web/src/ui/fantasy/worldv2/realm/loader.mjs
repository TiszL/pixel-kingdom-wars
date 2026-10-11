// Realm pack loader (plan §4.1, §4.2, §3.1). One RealmPack per realm keeps every DECODED source it has
// handed out (ImageBitmap / ImageData / typed arrays / JSON), so a lost WebGL context is rebuilt from
// memory without a single refetch (§9). Decoding uses createImageBitmap(blob, {premultiplyAlpha:'none',
// colorSpaceConversion:'none'}) when the browser honours those options (core.features.bitmapOptions),
// otherwise the fallback: PNGs through the exact JS decoder below (DecompressionStream + unfilter), and other
// formats (webp) through <img> → 2D canvas → getImageData. A 2D canvas premultiplies, which zeroes the RGB of
// every alpha-0 texel (Gate A: ground.png keeps shore RGB under alpha 0, so the canvas path drew different
// shores), so PNGs never take it. `?decode=canvas` forces the fallback for QA; `?verify` also counts
// alpha-0 texels with RGB ≠ 0 per PNG (stats.alphaRgb) — data any premultiplying decoder would corrupt.
//
// Memory (Gate A PM-7): decoded images and pixel copies are dropped from the cache once unused for TRIM_MS
// (a context-loss rebuild re-decodes them from the kept compressed bytes: still zero network requests).
// cpuBytes() = compressed bytes + decoded images currently cached.
//
// realm.json (schema 1, written by PACK step 8) — the fields this loader relies on:
//   { schema: 1, id, grid: { cols, rows, x0, y0, deeds }, frame: {...},
//     files: { "<key>": { sha256, bytes, w?, h? } },              // key = file name in the realm dir
//     chart16?: { P: 16, tiles: [{ key, x, y, w, h }] } }        // x/y/w/h in chart16 px
// First-frame set: realm.json + chart8.webp + deeds.png (1 px/deed: 255 this realm, 96 other, 0 none).
// Until PACK's first pack exists, a legacy prototype pack (chart.json + chart.webp + deeds.png, e.g.
// pack/realm/crownlands) is adapted so the dev page and ?rm2 stay usable: meta.legacy = true.

import { SLICE_MS, taskClock } from './slice.mjs';

const now = () => (globalThis.performance ? performance.now() : Date.now());
const BITMAP_OPTS = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
const TRIM_MS = 8000;
const isPng = key => /\.png$/i.test(key);

// ---- exact PNG decode (8-bit and palette PNGs, non-interlaced; anything else → null) -------------------------
// Stage B (KNOWN_ISSUES RM-GPU-1 #7, D-167: no main-thread stall > 50 ms): every PNG pixel decode runs in a Worker
// (pngDecoder below), so the main thread only copies the bytes out and wraps the returned pixels: no long task and no
// yield hops. W1 fix pass 2 #5 had sliced the main-thread decode into ≤ SLICE_MS tasks (GROUND's G3 pattern; as one task
// it took 143–177 ms for spr.png / decor.png on the efficiency cores), but on a loaded host each yield costs a 10–300 ms
// hop, so one file could take seconds. The sliced decode stays as the fallback when no Worker can run (a CSP that blocks
// blob: workers, no DecompressionStream in the worker, a worker error): each row needs only the row above it.
// (stage B D1: SLICE_MS and the yields are the page's shared task clock, slice.js)
/**
 * PNG bytes → { width, height, data: Uint8ClampedArray RGBA }, or null. SELF-CONTAINED: the decode worker runs this
 * function's source text, so it may not refer to anything outside its own body (loader.test.mjs runs it in an empty vm
 * context). The row loops check clock() once per row and await pause() past sliceMs (the worker passes Infinity).
 */
async function pngCore(b, sliceMs, clock, pause) {
  if (typeof DecompressionStream === 'undefined' || b.length < 8 || b[0] !== 137 || b[1] !== 80 || b[2] !== 78 || b[3] !== 71) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), idat = [];
  let p = 8, w = 0, h = 0, depth = 0, ct = -1, lace = 0, plte = null, trns = null, n = 0;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]), d = b.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = b[p + 16]; ct = b[p + 17]; lace = b[p + 20]; }
    else if (t === 'PLTE') plte = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') { idat.push(d); n += len; } else if (t === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  if (!ch || lace || !w || !h || !(depth === 8 || (ct === 3 && [1, 2, 4].includes(depth)))) return null;
  const z = new Uint8Array(n); let o = 0; for (const d of idat) { z.set(d, o); o += d.length; }
  const raw = new Uint8Array(await new Response(new Blob([z]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil((w * ch * depth) / 8);
  if (raw.length < h * (stride + 1)) return null;
  // RGBA8 unfilters straight into the output (its rows are already RGBA): no expansion pass
  const out = new Uint8ClampedArray(w * h * 4), direct = ct === 6 && depth === 8, px = direct ? new Uint8Array(out.buffer) : new Uint8Array(stride * h);
  let t = clock();
  for (let y = 0; y < h; y++) { // unfilter (PNG spec §9)
    if (clock() - t > sliceMs) { await pause(); t = clock(); }
    const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1, c = y * stride, u = c - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[s + i], a = i >= bpp ? px[c + i - bpp] : 0, up = y ? px[u + i] : 0, ul = y && i >= bpp ? px[u + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + up; else if (f === 3) v = x + ((a + up) >> 1);
      else { const q = a + up - ul, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - ul); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul); }
      px[c + i] = v;
    }
  }
  const key = trns && (ct === 0 || ct === 2) ? (ct === 0 ? [trns[1]] : [trns[1], trns[3], trns[5]]) : null; // 8-bit colour key
  if (!direct) for (let y = 0, k = 0; y < h; y++) {
    if (clock() - t > sliceMs) { await pause(); t = clock(); }
    const r = y * stride;
    for (let x = 0; x < w; x++, k += 4) {
      if (ct === 6) { const i = r + x * 4; out[k] = px[i]; out[k + 1] = px[i + 1]; out[k + 2] = px[i + 2]; out[k + 3] = px[i + 3]; }
      else if (ct === 2) { const i = r + x * 3; out[k] = px[i]; out[k + 1] = px[i + 1]; out[k + 2] = px[i + 2]; out[k + 3] = key && px[i] === key[0] && px[i + 1] === key[1] && px[i + 2] === key[2] ? 0 : 255; }
      else if (ct === 0) { const g = px[r + x]; out[k] = out[k + 1] = out[k + 2] = g; out[k + 3] = key && g === key[0] ? 0 : 255; }
      else if (ct === 4) { const i = r + x * 2; out[k] = out[k + 1] = out[k + 2] = px[i]; out[k + 3] = px[i + 1]; }
      else { const bit = x * depth, v = (px[r + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1); out[k] = plte[v * 3]; out[k + 1] = plte[v * 3 + 1]; out[k + 2] = plte[v * 3 + 2]; out[k + 3] = trns && v < trns.length ? trns[v] : 255; }
    }
  }
  return { width: w, height: h, data: out };
}
const asImage = r => (r && typeof ImageData !== 'undefined' ? new ImageData(r.data, r.width, r.height) : r);
/**
 * PNG bytes → { width, height, data: Uint8ClampedArray RGBA } (an ImageData where available), or null — on THIS thread,
 * in slices (the fallback of pngDecoder). opts (tests): sliceMs, clock (ms), yieldTask.
 */
export async function decodePng(b, { sliceMs = SLICE_MS, clock = now, yieldTask: pause = null } = {}) {
  if (!pause) { await taskClock.ensure(); pause = taskClock.yieldTask; } // (the product: start in a task with room, yield on the shared clock)
  return asImage(await pngCore(b, sliceMs, clock, pause));
}
/**
 * Non-PNG image bytes (the webp paintings: chart8, chart16) → { width, height, data: RGBA }, or null where this thread has no
 * createImageBitmap / OffscreenCanvas 2D. The same calls as the main thread's pixelsOf(bitmap) path — a bitmap decoded with
 * premultiplyAlpha 'none' and no colour conversion, drawn into a 2D canvas, read back — so the same pixels. Stage B D4:
 * chart8's drawImage + getImageData (0.58–1.87 Mpx, 2.3–7.5 MB) ran on the main thread inside the entry's first task (the
 * minimap's sea colour, GROUND's palette); the decode worker runs it now. SELF-CONTAINED like pngCore (the worker runs its
 * source text).
 */
async function imgCore(b) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;
  const bmp = await createImageBitmap(new Blob([b]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d', { willReadFrequently: true }); if (!x) return null;
    x.drawImage(bmp, 0, 0); const im = x.getImageData(0, 0, bmp.width, bmp.height);
    return { width: im.width, height: im.height, data: im.data };
  } finally { bmp.close?.(); }
}
/** The decode worker's script: pngCore and imgCore plus a message loop. It says `ready` first, with whether it can inflate
 *  and whether it can decode other images (img: createImageBitmap + OffscreenCanvas; without them an image job answers null). */
export const pngWorkerSource = () => `'use strict';const pngCore=${pngCore};const imgCore=${imgCore};
self.onmessage=async e=>{const{id,b,img}=e.data;let r=null,err=null;try{r=img?await imgCore(b):await pngCore(b,Infinity,()=>0,null)}catch(x){err=String(x&&x.message||x)}
self.postMessage({id,r,err},r?[r.data.buffer]:[])};self.postMessage({ready:1,ds:typeof DecompressionStream!=='undefined',img:typeof createImageBitmap==='function'&&typeof OffscreenCanvas==='function'});`;
/**
 * The page's PNG decoder: decode(bytes) → Promise of what decodePng gives, decoded in ONE blob: Worker made at the first
 * call (the bytes are copied to it — the caller keeps its buffer for context-loss rebuilds — and the pixels come back
 * transferred). Anything that stops the worker (the constructor throws, e.g. a CSP; an error event; a worker with no
 * DecompressionStream) sends every pending and later decode to decodePng on this thread, once, for the page's lifetime;
 * a decode the worker failed alone is redone there too. stats = { worker, main, fallback } (fallback: why, or null).
 * WorkerImpl (tests): the Worker constructor.
 */
export function pngDecoder({ WorkerImpl = globalThis.Worker } = {}) {
  const stats = { worker: 0, main: 0, fallback: null, img: 0, imgNull: 0 }, jobs = new Map();
  let w = null, url = null, id = 0, dead = typeof WorkerImpl !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function';
  if (dead) stats.fallback = 'no Worker';
  const main = b => { stats.main++; return decodePng(b); };
  const revoke = () => { if (url) { URL.revokeObjectURL(url); url = null; } };
  function fail(why) {
    if (dead) return; dead = true; stats.fallback = why; revoke();
    try { w?.terminate(); } catch { /* gone */ }
    w = null; console.warn(`realm pack: PNG decode worker off (${why}); decoding on the main thread in slices`);
    const pending = [...jobs.values()]; jobs.clear();
    for (const j of pending) if (j.img) { stats.imgNull++; j.res(null); } else main(j.b).then(j.res, j.rej); // an image: the caller's own path
  }
  function start() {
    try { url = URL.createObjectURL(new Blob([pngWorkerSource()], { type: 'text/javascript' })); w = new WorkerImpl(url); }
    catch (e) { fail(`worker refused: ${e?.message || e}`); return; }
    w.onmessage = e => {
      taskClock.mark(); // a worker reply starts a task (stage B D1: the continuation's slices count from here)
      const m = e.data;
      if (m?.ready) { revoke(); if (!m.ds) fail('no DecompressionStream in the worker'); return; }
      const j = jobs.get(m?.id); if (!j) return; jobs.delete(m.id);
      if (j.img) { if (m.err || !m.r) { stats.imgNull++; if (m.err) console.warn(`realm pack: image decode worker failed a file (${m.err}); read on the main thread`); j.res(null); } else { stats.img++; j.res(asImage(m.r)); } return; }
      if (m.err) { console.warn(`realm pack: PNG decode worker failed a file (${m.err}); redone on the main thread`); main(j.b).then(j.res, j.rej); return; }
      stats.worker++; j.res(asImage(m.r));
    };
    w.onerror = e => { e?.preventDefault?.(); fail(`worker error: ${e?.message || 'script did not load'}`); };
  }
  const post = (b, img) => new Promise((res, rej) => {
    const k = ++id, copy = b.slice(); jobs.set(k, { b, res, rej, img });
    try { w.postMessage(img ? { id: k, b: copy, img: 1 } : { id: k, b: copy }, [copy.buffer]); } catch (e) { fail(`postMessage: ${e?.message || e}`); }
  });
  return {
    stats,
    decode(b) {
      if (!dead && !w) start();
      if (dead) return main(b);
      return post(b, false);
    },
    /** Non-PNG image bytes → RGBA pixels decoded in the worker, or null (no worker, or it cannot: the caller reads them itself). */
    decodeImage(b) {
      if (!dead && !w) start();
      if (dead) { stats.imgNull++; return Promise.resolve(null); }
      return post(b, true);
    },
  };
}
const png = pngDecoder();
/** Alpha-0 texels whose RGB is not 0: the data a premultiplying decoder (2D canvas) would lose. */
export function alphaRgbCount(im) { const d = im.data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] === 0 && (d[i - 3] | d[i - 2] | d[i - 1])) n++; return n; }
/** A rect of decoded pixels, copied row by row (never through a canvas). */
function cropPixels(im, r) {
  const W = im.width, out = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) { const o = ((r.y + y) * W + r.x) * 4; out.set(im.data.subarray(o, o + r.w * 4), y * r.w * 4); }
  return typeof ImageData !== 'undefined' ? new ImageData(out, r.w, r.h) : { width: r.w, height: r.h, data: out };
}

async function fetchOk(url, fetchImpl) {
  const r = await fetchImpl(url);
  if (!r.ok) { const e = Error(`${r.status} ${url}`); e.status = r.status; throw e; }
  return r;
}
async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function canvas2d(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return [c, c.getContext('2d', { willReadFrequently: true })];
}
/** <img> decode drawn into a 2D canvas; returns the canvas (drawable and uploadable, like an ImageBitmap). */
async function decodeCanvas(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const im = new Image(); im.decoding = 'async'; im.src = url; await im.decode();
    const [c, x] = canvas2d(im.naturalWidth, im.naturalHeight); x.drawImage(im, 0, 0);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
/** RGBA pixels of a decoded source (ImageBitmap / canvas / ImageData). */
export function pixelsOf(src) {
  if (src instanceof ImageData || (src.data && src.width)) return src;
  const [, x] = canvas2d(src.width, src.height); x.drawImage(src, 0, 0);
  return x.getImageData(0, 0, src.width, src.height);
}

/**
 * Pack index: pack/realm/index.json ({ schema, realms: [{ id, packVersion, kitCommit, status }] }).
 * Falls back to legacy prototype packs (status 'legacy') so has() works before PACK's index exists.
 */
export async function realmIndex(packRoot, { fetchImpl = fetch, legacyIds = ['crownlands'] } = {}) {
  try { return await (await fetchOk(`${packRoot}realm/index.json`, fetchImpl)).json(); } catch { /* fall through */ }
  const realms = [];
  for (const id of legacyIds) { try { await fetchOk(`${packRoot}realm/${id}/chart.json`, fetchImpl); realms.push({ id, status: 'legacy' }); } catch { /* none */ } }
  return { schema: 1, realms, synthesized: true };
}

function makeSource(root, { decode, verify, fetchImpl, files = {}, stats, pngDec = png }) {
  stats.png = pngDec.stats; // where this page's PNG pixels were decoded (worker / main thread, and why not the worker)
  const cache = new Map(); // key → Promise of the decoded source ('b:' bytes are kept for context-loss rebuilds)
  const size = new Map(), used = new Map(); // key → bytes held once resolved; key → last use (ms)
  let trimTimer = 0;
  const sizeOf = v => (v?.byteLength ?? (v?.width ? v.width * v.height * 4 : 0));
  function trim(maxAge = TRIM_MS) { // drop decoded images / pixel copies unused for maxAge (never 'b:' or 'j:')
    const t = now();
    for (const k of [...cache.keys()]) if ((k.startsWith('i:') || k.startsWith('p:')) && size.has(k) && t - (used.get(k) ?? 0) >= maxAge) { cache.delete(k); size.delete(k); used.delete(k); }
  }
  function scheduleTrim() { if (trimTimer || typeof setTimeout === 'undefined') return; trimTimer = setTimeout(() => { trimTimer = 0; trim(); if ([...cache.keys()].some(k => k[0] === 'i' || k[0] === 'p')) scheduleTrim(); }, TRIM_MS); }
  const raw = async key => {
    const t0 = now(); const buf = await (await fetchOk(root + key, fetchImpl)).arrayBuffer();
    taskClock.mark(); // an I/O continuation starts a task (stage B D1)
    stats.bytesLoaded += buf.byteLength; stats.files++; stats.fetchMs += now() - t0;
    if (verify && files[key]?.sha256) {
      const got = await sha256Hex(buf); if (got !== files[key].sha256) { stats.shaMismatch.push(key); console.error(`realm pack sha256 mismatch: ${root}${key}`); }
    }
    return buf;
  };
  // a 404 stays cached (a missing file is permanent for this pack; recovery never re-asks the network);
  // other failures are dropped so a later call retries
  const once = (k, f) => {
    used.set(k, now());
    if (!cache.has(k)) { const p = f(); cache.set(k, p); p.then(v => { if (cache.get(k) === p) size.set(k, sizeOf(v)); if (k[0] !== 'b' && k[0] !== 'j') scheduleTrim(); }, e => { if (e?.status !== 404) { cache.delete(k); used.delete(k); } }); }
    return cache.get(k);
  };
  // exact RGBA of a PNG (bytes → JS decode), or null when the decoder cannot take it
  const exactPng = key => (isPng(key) ? src.bytes(key).then(b => pngDec.decode(b)).then(im => {
    if (im && verify) { const n = alphaRgbCount(im); if (n) { stats.alphaRgb[key] = n; console.warn(`realm pack: ${root}${key} has ${n} alpha-0 texels with RGB ≠ 0 (a premultiplying decoder would lose them)`); } }
    return im; }) : Promise.resolve(null));
  // other images' pixels (the webp paintings) decoded in the worker (stage B D4), or null: then pixelsOf on this thread
  const workerImg = key => (!isPng(key) && pngDec.decodeImage ? src.bytes(key).then(b => pngDec.decodeImage(b)) : Promise.resolve(null));
  const src = {
    /** Raw file bytes. */
    bytes: key => once('b:' + key, async () => new Uint8Array(await raw(key))),
    json: key => once('j:' + key, async () => JSON.parse(new TextDecoder().decode(await src.bytes(key)))),
    /**
     * Decoded image; rect crops it. Bitmap path: an ImageBitmap. Canvas path: an ImageData for PNGs (exact RGBA,
     * the data files and alpha art) and a 2D canvas for other formats (the webp paintings: drawable, like a bitmap).
     */
    bitmap(key, rect = null) {
      const full = once('i:' + key, async () => {
        const bytes = await src.bytes(key); const t0 = now();
        let out = null;
        if (decode === 'canvas') out = (await exactPng(key)) ?? await decodeCanvas(new Blob([bytes]));
        else out = await createImageBitmap(new Blob([bytes]), BITMAP_OPTS);
        stats.decodeMs += now() - t0; return out;
      });
      if (!rect) return full;
      return once(`i:${key}@${rect.x},${rect.y},${rect.w},${rect.h}`, async () => {
        const im = await full;
        if (decode === 'canvas') { if (im.data) return cropPixels(im, rect); const [c, x] = canvas2d(rect.w, rect.h); x.drawImage(im, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h); return c; }
        return createImageBitmap(im, rect.x, rect.y, rect.w, rect.h, BITMAP_OPTS);
      });
    },
    /**
     * RGBA pixel data (ImageData) for CPU-side use (deeds, JS reference fields, sprite tables). The same on
     * both decode paths: PNGs through the exact JS decoder; other formats from the decoded image.
     */
    pixels: key => (decode === 'canvas' && isPng(key) ? src.bitmap(key).then(b => (b.data ? b : pixelsOf(b)))
      : once('p:' + key, async () => (decode === 'bitmap' ? await (isPng(key) ? exactPng(key) : workerImg(key)) : null) ?? pixelsOf(await src.bitmap(key)))),
    /** Start fetching keys now (network only; decoding happens on first use). */
    prefetch(keys) { for (const k of keys) src.bytes(k).catch(() => {}); },
    /** Drop decoded sources (a realm leaving residency). */
    release() { for (const [k, p] of cache) if (k.startsWith('i:')) p.then(b => b.close?.()).catch(() => {}); cache.clear(); size.clear(); used.clear(); clearTimeout(trimTimer); trimTimer = 0; },
    cached: () => [...cache.keys()],
    /** Bytes the cache holds now: compressed files + decoded images / pixel copies (stats().cpuMB). */
    cpuBytes: () => [...size.values()].reduce((a, b) => a + b, 0),
    /** The largest cached entries, [key, MB] (QA / stats overlay). */
    cpuTop: (n = 8) => [...size].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, +(v / 1048576).toFixed(2)]),
    /** Drop decoded sources unused for maxAge ms (default TRIM_MS; 0 = all). Runs by itself after loads settle. */
    trim,
  };
  return src;
}

/**
 * openRealm(packRoot, id, opts) → RealmPack (plan §10.2):
 *   { id, root, meta, legacy, first: { chart8, deeds: Uint8Array /*cols·rows, 255|96|0*\/ },
 *     bitmap(key, rect?), json(key), bytes(key), pixels(key), prefetch(keys), release(), stats }
 * opts: { decode: 'bitmap'|'canvas', verify: boolean, fetchImpl }.
 */
export async function openRealm(packRoot, id, { decode = 'bitmap', verify = false, fetchImpl = fetch, pngDec } = {}) {
  const root = `${packRoot}realm/${id}/`, t0 = now();
  const stats = { bytesLoaded: 0, files: 0, fetchMs: 0, decodeMs: 0, firstFrameMs: 0, decodePath: decode, shaMismatch: [], alphaRgb: {} };
  let meta, legacy = false;
  try { meta = await (await fetchOk(root + 'realm.json', fetchImpl)).json(); }
  catch (e) {
    if (e.status !== 404) throw e;
    const c = await (await fetchOk(root + 'chart.json', fetchImpl)).json(); legacy = true;
    meta = { schema: 0, legacy: true, id, grid: { cols: c.cols, rows: c.rows, x0: c.x0, y0: c.y0, deeds: c.deeds }, frame: c.frame, files: {} };
  }
  const src = makeSource(root, { decode, verify, fetchImpl, files: meta.files ?? {}, stats, pngDec });
  const chartKey = legacy ? 'chart.webp' : 'chart8.webp';
  const [chart8, deedPx] = await Promise.all([src.bitmap(chartKey), src.pixels('deeds.png')]);
  const { cols, rows } = meta.grid, deeds = new Uint8Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) deeds[i] = deedPx.data[i * 4];
  stats.firstFrameMs = now() - t0;
  return { id, root, meta, legacy, first: { chart8, deeds, chartKey }, ...src, stats };
}

/** The shared realm-map pack (pack/realm/shared/: keeps, decor, fx) with the same cache semantics. */
export function openShared(packRoot, { decode = 'bitmap', verify = false, fetchImpl = fetch, pngDec } = {}) {
  const stats = { bytesLoaded: 0, files: 0, fetchMs: 0, decodeMs: 0, decodePath: decode, shaMismatch: [], alphaRgb: {} };
  return { root: `${packRoot}realm/shared/`, ...makeSource(`${packRoot}realm/shared/`, { decode, verify, fetchImpl, stats, pngDec }), stats };
}
