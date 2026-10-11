// loader.mjs decodePng (plan §3.1, §11.1): the canvas decode fallback (iOS-class browsers without
// ImageBitmapOptions) must give the SAME pixels as createImageBitmap(premultiplyAlpha:'none'). A 2D canvas
// premultiplies, which zeroes the RGB of every alpha-0 texel; ground.png and decals.png keep shore / decal
// RGB there, so Gate A saw different shores on the fallback. PNGs therefore decode through this exact JS path.
import { PACK_ROOT } from './test-pack.support.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { decodePng, alphaRgbCount } from './loader.mjs';
const sharp = createRequire(new URL('../../../../../../../scripts/package.json', import.meta.url).pathname)('sharp');

function noise(w, h, ch, seed) { const d = Buffer.alloc(w * h * ch); let s = seed; for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s >>> 16) & 255; } return d; }
async function roundTrip(buf) { const im = await decodePng(new Uint8Array(buf)), ref = await sharp(buf).ensureAlpha().raw().toBuffer(); return { im, ref }; }

test('RGBA with RGB under alpha 0 keeps that RGB (the texels a canvas would zero)', async () => {
  const w = 37, h = 23, px = noise(w, h, 4, 3); for (let i = 3; i < px.length; i += 8) px[i] = 0; // every other texel transparent, RGB kept
  const buf = await sharp(px, { raw: { width: w, height: h, channels: 4 } }).png({ adaptiveFiltering: true }).toBuffer();
  const { im, ref } = await roundTrip(buf);
  assert.equal(im.width, w); assert.equal(im.height, h);
  assert.deepEqual(Buffer.from(im.data), ref);
  assert.ok(alphaRgbCount(im) > 100, 'alpha-0 texels still carry RGB');
});

test('RGB, grey and palette(+tRNS) PNGs decode byte-equal to sharp, across every filter type', async () => {
  const w = 64, h = 40;
  const cases = [
    await sharp(noise(w, h, 3, 9), { raw: { width: w, height: h, channels: 3 } }).png({ adaptiveFiltering: true }).toBuffer(),
    await sharp(noise(w, h, 1, 5), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer(),
    await sharp(noise(w, h, 4, 11), { raw: { width: w, height: h, channels: 4 } }).png({ palette: true, colours: 16, dither: 0 }).toBuffer(),
  ];
  for (const buf of cases) { const { im, ref } = await roundTrip(buf); assert.ok(im, 'decoded'); assert.deepEqual(Buffer.from(im.data), ref); }
});

test('the real pack files decode exactly (every PNG a realm or the shared pack ships, where present)', async () => {
  const root = PACK_ROOT + 'realm/';
  let n = 0;
  for (const f of ['sunscar/ground.png', 'sunscar/decals.png', 'sunscar/fieldsA.png', 'sunscar/mapkit.png', 'shared/keeps.png']) {
    if (!existsSync(root + f)) continue; n++;
    const buf = readFileSync(root + f), { im, ref } = await roundTrip(buf);
    assert.deepEqual(Buffer.from(im.data), ref, f);
  }
  assert.ok(n > 0, 'no pack PNGs found to check');
});

// W1 fix pass 2 #5 (D-167: no main-thread stall > 50 ms by design on a mid phone). The unfilter and the RGBA expansion ran as
// ONE task after the inflate: 143 ms for frostveil spr.png and 177 ms for shared/decor.png on the efficiency cores, during
// entry and while the FAR map is interactive (every pixels() of a PNG, both decode paths). Now each row loop checks the
// clock once per row and yields a task past sliceMs. Counted, not timed (a loaded test machine only shortens a stretch):
// the fake clock advances 1 ms per read, i.e. one row = 1 ms, so a stretch between yields may hold sliceMs + 1 rows and
// every row must be checked. Teeth: the one-task decoder has one stretch of every row; a per-image check reads twice.
test('decodePng runs in short slices: every row is a step, no stretch between yields exceeds the budget plus one row', async () => {
  const w = 48, h = 180;
  const cases = [
    ['RGBA (unfiltered in place)', await sharp(noise(w, h, 4, 21), { raw: { width: w, height: h, channels: 4 } }).png({ adaptiveFiltering: true }).toBuffer(), 1],
    ['palette (unfilter + expansion)', await sharp(noise(w, h, 4, 23), { raw: { width: w, height: h, channels: 4 } }).png({ palette: true, colours: 16, dither: 0 }).toBuffer(), 2],
  ];
  for (const [name, buf, loops] of cases) {
    let ms = 0, reads = 0, run = 0, worst = 0, yields = 0;
    const clock = () => { reads++; run++; worst = Math.max(worst, run); return ++ms; };
    const im = await decodePng(new Uint8Array(buf), { sliceMs: 8, clock, yieldTask: async () => { yields++; run = 0; } });
    assert.deepEqual(Buffer.from(im.data), await sharp(buf).ensureAlpha().raw().toBuffer(), `${name}: the sliced decode is exact`);
    assert.ok(reads >= loops * h, `${name}: every row checks the clock (${reads} reads for ${loops} × ${h} rows)`);
    assert.ok(yields >= Math.floor((loops * h) / 9), `${name}: yielded ${yields} times for ${loops * h} rows`);
    assert.ok(worst <= 8 + 2, `${name}: a stretch held ${worst} rows`);
  }
});

// Stage B (KNOWN_ISSUES RM-GPU-1 #7, D-167): the product decodes PNG pixels in a Worker, so no decode is a main-thread
// task and none pays a yield hop per slice (on a loaded host each hop cost 10–300 ms: whole entries stalled). The fake
// Worker below runs the REAL worker script (pngWorkerSource) in an empty vm context — only self, DecompressionStream,
// Blob and Response — so the script must be self-contained exactly as a blob: worker needs it to be.
import vm from 'node:vm';
import { resolveObjectURL } from 'node:buffer';
import { createHash } from 'node:crypto';
import { pngDecoder, pngWorkerSource, openShared } from './loader.mjs';
function fakeWorker({ ds = true, loadError = false, jobError = false, ctorThrows = false, extra = {} } = {}) {
  const made = [];
  class FakeWorker {
    constructor(url) {
      if (ctorThrows) throw new Error('blob: workers blocked by CSP');
      made.push(this); this.queue = []; this.post = null; this.terminated = false;
      resolveObjectURL(url).text().then(src => {
        if (loadError) { this.onerror?.({ message: 'script did not load', preventDefault() {} }); return; }
        // messages cross as structured clones with their transfer lists honoured (a transferred buffer is detached)
        const self = { postMessage: (m, tr = []) => { const c = structuredClone(m, { transfer: tr }); if (!this.terminated) setImmediate(() => this.onmessage?.({ data: c })); } };
        const ctx = vm.createContext({ self, Blob, Response, ...(ds ? { DecompressionStream } : {}), ...extra });
        vm.runInContext(src, ctx);
        this.post = m => (jobError ? self.postMessage({ id: m.id, r: null, err: 'boom' }) : ctx.self.onmessage({ data: m }));
        for (const m of this.queue.splice(0)) this.post(m);
      });
    }
    postMessage(m, tr = []) { const c = structuredClone(m, { transfer: tr }); if (this.post) this.post(c); else this.queue.push(c); }
    terminate() { this.terminated = true; }
  }
  return { WorkerImpl: FakeWorker, made };
}
const digest = u8 => createHash('sha256').update(u8).digest('hex');
async function pngCases() {
  const root = PACK_ROOT + 'realm/', out = [];
  for (const f of ['shared/keeps.png', 'frostveil/deeds.png']) if (existsSync(root + f)) out.push([f, readFileSync(root + f)]);
  out.push(['palette', await sharp(noise(40, 30, 4, 31), { raw: { width: 40, height: 30, channels: 4 } }).png({ palette: true, colours: 16, dither: 0 }).toBuffer()]);
  out.push(['rgb', await sharp(noise(33, 17, 3, 37), { raw: { width: 33, height: 17, channels: 3 } }).png({ adaptiveFiltering: true }).toBuffer()]);
  return out;
}

test('PNG pixels decode in the worker, exact, and the caller keeps its bytes (no main-thread decode at all)', { timeout: 60000 }, async () => {
  assert.ok(!/\bSLICE_MS\b|\bnow\(\)|\binflate\(/.test(pngWorkerSource().split('self.onmessage')[0].replace(/^'use strict';const pngCore=/, '')), 'the worker core refers to nothing outside itself');
  const fw = fakeWorker(), dec = pngDecoder({ WorkerImpl: fw.WorkerImpl }), cases = await pngCases();
  for (const [name, buf] of cases) {
    const b = new Uint8Array(buf), before = digest(b), im = await dec.decode(b);
    assert.deepEqual(Buffer.from(im.data), await sharp(buf).ensureAlpha().raw().toBuffer(), `${name}: exact`);
    assert.equal(b.byteLength, buf.length, `${name}: the cached bytes are not transferred away (context-loss rebuilds re-decode them)`);
    assert.equal(digest(b), before, `${name}: bytes unchanged`);
  }
  assert.equal(dec.stats.worker, cases.length); assert.equal(dec.stats.main, 0, 'nothing decoded on the main thread');
  assert.equal(fw.made.length, 1, 'one worker for the page'); assert.equal(dec.stats.fallback, null);
});

test('when the worker cannot run, every decode (pending ones too) falls back to the sliced main-thread decode, exactly once', { timeout: 60000 }, async () => {
  const cases = (await pngCases()).slice(-2), ref = await Promise.all(cases.map(([, b]) => sharp(b).ensureAlpha().raw().toBuffer()));
  for (const [why, o] of [['ctor', { ctorThrows: true }], ['load', { loadError: true }], ['ds', { ds: false }]]) {
    const fw = fakeWorker(o), dec = pngDecoder({ WorkerImpl: fw.WorkerImpl });
    const ims = await Promise.all(cases.map(([, b]) => dec.decode(new Uint8Array(b)))); // sent before the failure is known
    ims.forEach((im, i) => assert.deepEqual(Buffer.from(im.data), ref[i], `${why}: exact on the fallback`));
    assert.equal(dec.stats.main, cases.length, `${why}: all on the main thread`); assert.equal(dec.stats.worker, 0);
    assert.ok(dec.stats.fallback, `${why}: the reason is recorded (${dec.stats.fallback})`);
    await dec.decode(new Uint8Array(cases[0][1])); assert.equal(fw.made.length, why === 'ctor' ? 0 : 1, `${why}: no second worker`);
  }
  // a file the worker fails alone is redone on the main thread; the worker stays on for the next one
  const fw = fakeWorker({ jobError: true }), dec = pngDecoder({ WorkerImpl: fw.WorkerImpl });
  const im = await dec.decode(new Uint8Array(cases[0][1]));
  assert.deepEqual(Buffer.from(im.data), ref[0]); assert.equal(dec.stats.main, 1); assert.equal(dec.stats.fallback, null);
});

test('a pack\'s pixels() go through the worker (the product path, not only the decoder)', { timeout: 60000 }, async () => {
  const root = PACK_ROOT;
  const fetchImpl = async url => { const f = root + url.replace(/^pack\//, ''); return existsSync(f) ? new Response(readFileSync(f)) : new Response(null, { status: 404 }); };
  const fw = fakeWorker(), pngDec = pngDecoder({ WorkerImpl: fw.WorkerImpl });
  // openShared and openRealm share makeSource; the shared pack needs no createImageBitmap first frame (Node has none)
  const pk = openShared('pack/', { decode: 'bitmap', fetchImpl, pngDec });
  const px = await pk.pixels('keeps.png');
  assert.deepEqual(Buffer.from(px.data), await sharp(readFileSync(root + 'realm/shared/keeps.png')).ensureAlpha().raw().toBuffer());
  assert.equal(pngDec.stats.worker, 1, 'keeps.png decoded in the worker'); assert.equal(pngDec.stats.main, 0);
  assert.equal(pk.stats.png, pngDec.stats, 'stats.png says where pixels were decoded');
});


// Stage B D4: chart8's pixels (0.58–1.87 Mpx, 2.3–7.5 MB) were read on the main thread inside the entry's first task — a
// drawImage + getImageData on a willReadFrequently canvas — for the minimap's sea colour and GROUND's palette. A webp's pixels
// now come from the decode worker (createImageBitmap + OffscreenCanvas there, the same calls and options as the main
// thread's pixelsOf). The worker context below has a minimal createImageBitmap / OffscreenCanvas (backed by sharp's decode of
// the same bytes) and nothing else, so the worker's imgCore must be self-contained and the product path must use it.
function imageWorkerGlobals(decoded) {
  const calls = { bitmap: 0, getImageData: 0, opts: null };
  class OffscreenCanvas { constructor(w, h) { this.width = w; this.height = h; } getContext(kind, o) { if (kind !== '2d') return null; calls.opts = o; const c = this;
    return { drawImage(b) { c.b = b; }, getImageData(x, y, w, h) { calls.getImageData++; return { width: w, height: h, data: new Uint8ClampedArray(c.b.px) }; } }; } }
  const createImageBitmap = async (blob, o) => { calls.bitmap++; calls.bmOpts = o; const d = decoded.get(digest(new Uint8Array(await blob.arrayBuffer()))); if (!d) throw Error('not an image');
    return { width: d.width, height: d.height, px: d.data, close() {} }; };
  return { calls, extra: { OffscreenCanvas, createImageBitmap } };
}
test('webp pixels (chart8) decode in the worker, not on the main thread; without worker image support the caller reads them', { timeout: 60000 }, async () => {
  const root = PACK_ROOT, id = ['cinderfall', 'frostveil', 'sunscar'].find(r => existsSync(`${root}realm/${r}/chart8.webp`));
  assert.ok(id, 'a realm pack with chart8.webp'); const file = `${root}realm/${id}/chart8.webp`, bytes = readFileSync(file);
  const ref = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = new Map([[digest(new Uint8Array(bytes)), { width: ref.info.width, height: ref.info.height, data: ref.data }]]);
  const { calls, extra } = imageWorkerGlobals(decoded), fw = fakeWorker({ extra }), pngDec = pngDecoder({ WorkerImpl: fw.WorkerImpl });
  // the product path: a realm's pixels('chart8.webp') in bitmap mode (Node has no createImageBitmap on this thread, so a
  // main-thread read would throw here)
  // (openShared and openRealm share makeSource; openRealm's first frame needs createImageBitmap on this thread, so the
  // shared pack's source serves the realm's chart8 here)
  const fetchImpl = async url => (url.endsWith('/chart8.webp') ? new Response(readFileSync(file)) : new Response(null, { status: 404 }));
  const pk = openShared('pack/', { decode: 'bitmap', fetchImpl, pngDec });
  const px = await pk.pixels('chart8.webp');
  assert.equal(px.width, ref.info.width); assert.deepEqual(Buffer.from(px.data), ref.data, 'the worker read the same pixels');
  assert.equal(pngDec.stats.img, 1, 'decoded by the worker'); assert.equal(calls.bitmap, 1); assert.equal(calls.getImageData, 1);
  assert.equal(JSON.stringify(calls.bmOpts), JSON.stringify({ premultiplyAlpha: 'none', colorSpaceConversion: 'none' }), 'the main thread\'s bitmap options (same pixels)'); // (a vm object: compared by value)
  assert.equal(calls.opts?.willReadFrequently, true);
  assert.equal(pngDec.stats.main, 0, 'no PNG fallback either');
  // a worker without createImageBitmap answers null (the caller's own path runs), and says so in its ready message
  // (an answer, not an error: imgCore refers to nothing outside itself — an outer name would throw in the worker)
  const fw2 = fakeWorker(), dec2 = pngDecoder({ WorkerImpl: fw2.WorkerImpl }), warn = console.warn, warned = [];
  console.warn = (...a) => warned.push(a.join(' '));
  try { assert.equal(await dec2.decodeImage(new Uint8Array(bytes)), null); } finally { console.warn = warn; }
  assert.equal(dec2.stats.imgNull, 1); assert.equal(dec2.stats.img, 0); assert.deepEqual(warned, [], 'the worker answered null without an error');
  assert.match(pngWorkerSource(), /img:typeof createImageBitmap==='function'&&typeof OffscreenCanvas==='function'/);
  // no Worker at all: null at once, never a throw
  const dec3 = pngDecoder({ WorkerImpl: undefined }); assert.equal(await dec3.decodeImage(new Uint8Array(bytes)), null);
});
