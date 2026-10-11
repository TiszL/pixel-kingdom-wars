import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { DEED_PX, OUT_DIR, buildFixtures, compareFixtures } from './world-fixtures.mjs';

// Why: until the web commits a pack manifest (GLOBE-NATIVE-PLAN §6.1), N1/N2 JVM tests run on these fixtures only. A
// fixture that is not what it claims (a "valid" pack with a bad hash, a "tampered" pack a loader would accept anyway,
// a PNG golden that disagrees with the web decoder) would make those tests pass for the wrong reason.
const DIR = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), OUT_DIR);
const sha256 = b => createHash('sha256').update(b).digest('hex');
const read = rel => fs.readFileSync(path.join(DIR, rel));
const index = JSON.parse(read('index.json'));

/** Reference decoder with the web loader's exact semantics (concepts/.../src/realm/loader.js decodePng at the pin). */
function decodePng(b) {
  let p = 8, w = 0, h = 0, depth = 0, ct = -1, plte = null, trns = null; const idat = [];
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), t = b.toString('latin1', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (t === 'IHDR') { w = b.readUInt32BE(p + 8); h = b.readUInt32BE(p + 12); depth = b[p + 16]; ct = b[p + 17]; }
    else if (t === 'PLTE') plte = d; else if (t === 'tRNS') trns = d; else if (t === 'IDAT') idat.push(d); else if (t === 'IEND') break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct], raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (ch * depth) >> 3), stride = Math.ceil((w * ch * depth) / 8), px = new Uint8Array(stride * h), filters = new Set();
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1, c = y * stride, u = c - stride; filters.add(f);
    for (let i = 0; i < stride; i++) {
      const x = raw[s + i], a = i >= bpp ? px[c + i - bpp] : 0, up = y ? px[u + i] : 0, ul = y && i >= bpp ? px[u + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + up; else if (f === 3) v = x + ((a + up) >> 1);
      else { const q = a + up - ul, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - ul); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : ul); }
      px[c + i] = v;
    }
  }
  const out = Buffer.alloc(w * h * 4), key = trns && (ct === 0 || ct === 2) ? (ct === 0 ? [trns[1]] : [trns[1], trns[3], trns[5]]) : null;
  for (let y = 0, k = 0; y < h; y++) for (let x = 0; x < w; x++, k += 4) {
    const r = y * stride;
    if (ct === 6) { const i = r + x * 4; out[k] = px[i]; out[k + 1] = px[i + 1]; out[k + 2] = px[i + 2]; out[k + 3] = px[i + 3]; }
    else if (ct === 2) { const i = r + x * 3; out[k] = px[i]; out[k + 1] = px[i + 1]; out[k + 2] = px[i + 2]; out[k + 3] = key && px[i] === key[0] && px[i + 1] === key[1] && px[i + 2] === key[2] ? 0 : 255; }
    else if (ct === 0) { const g = px[r + x]; out[k] = out[k + 1] = out[k + 2] = g; out[k + 3] = key && g === key[0] ? 0 : 255; }
    else if (ct === 4) { const i = r + x * 2; out[k] = out[k + 1] = out[k + 2] = px[i]; out[k + 3] = px[i + 1]; }
    else { const bit = x * depth, v = (px[r + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1); out[k] = plte[v * 3]; out[k + 1] = plte[v * 3 + 1]; out[k + 2] = plte[v * 3 + 2]; out[k + 3] = trns && v < trns.length ? trns[v] : 255; }
  }
  return { width: w, height: h, colorType: ct, depth, data: out, filters, idat: idat.length, btype: zlibBlockType(Buffer.concat(idat)) };
}
const zlibBlockType = z => (z[2] >> 1) & 3; // first deflate block header after the 2-byte zlib header

test('the committed fixtures are exactly what the generator produces (drift fails)', () => {
  const files = buildFixtures();
  assert.deepEqual(compareFixtures(DIR, files), []);
  assert.deepEqual(compareFixtures(DIR, buildFixtures()), [], 'generation is deterministic');
});

test('PNG goldens decode, with the web loader\'s semantics, to their committed RGBA, and cover every decoder path', () => {
  const colorTypes = new Set(), filters = new Set(), btypes = new Set();
  let splitIdat = false, keptRgbUnderAlpha0 = 0;
  for (const g of index.png) {
    const im = decodePng(read(g.png)), want = read(g.rgba);
    assert.equal(im.width, g.width); assert.equal(im.height, g.height);
    assert.ok(im.data.equals(want), `${g.name} decodes to its golden`);
    colorTypes.add(`${im.colorType}/${im.depth}`); for (const f of im.filters) filters.add(f); btypes.add(im.btype);
    if (im.idat > 1) splitIdat = true;
    for (let i = 3; i < want.length; i += 4) if (want[i] === 0 && (want[i - 3] | want[i - 2] | want[i - 1])) keptRgbUnderAlpha0++;
  }
  assert.deepEqual([...colorTypes].sort(), ['0/8', '2/8', '3/4', '4/8', '6/8']);
  assert.deepEqual([...filters].sort(), [0, 1, 2, 3, 4], 'all five PNG row filters');
  assert.deepEqual([...btypes].sort(), [0, 1], 'stored and fixed-Huffman deflate blocks');
  assert.ok(splitIdat, 'an image split over several IDAT chunks');
  assert.ok(keptRgbUnderAlpha0 > 0, 'alpha-0 texels that keep RGB: what a premultiplying decoder would destroy');
});

function packFiles(name) {
  const root = `packs/${name}`, list = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(DIR, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else list.push(p.slice(root.length + 1)); } };
  walk(root);
  return { root, list: list.sort(), get: rel => read(`${root}/${rel}`) };
}
/** Every check an installer and RealmLoader must make, as problems (empty = the pack is valid). */
function packProblems(name) {
  const pk = packFiles(name), problems = [], manifest = JSON.parse(pk.get('manifest.json'));
  const listed = new Set(manifest.files.map(f => f.path));
  for (const f of manifest.files) if (sha256(pk.get(f.path)) !== f.sha256 || pk.get(f.path).length !== f.size) problems.push(`manifest ${f.path}`);
  for (const rel of pk.list) if (rel !== 'manifest.json' && !listed.has(rel)) problems.push(`unlisted ${rel}`);
  for (const r of JSON.parse(pk.get('realm/index.json')).realms) {
    const realm = JSON.parse(pk.get(`realm/${r.id}/realm.json`));
    for (const [file, meta] of Object.entries(realm.files)) if (sha256(pk.get(`realm/${r.id}/${file}`)) !== meta.sha256) problems.push(`realm.json ${r.id}/${file}`);
    const deeds = decodePng(pk.get(`realm/${r.id}/${realm.deeds.file}`)), chart = decodePng(pk.get(`realm/${r.id}/${realm.chart8.file}`));
    if (deeds.width !== realm.grid.cols || deeds.height !== realm.grid.rows) problems.push(`deeds size ${r.id}`);
    const ppd = realm.chart8.pxPerDeed;
    if (chart.width !== realm.chart8.w || chart.height !== realm.chart8.h || chart.width !== realm.grid.cols * ppd || chart.height !== realm.grid.rows * ppd) problems.push(`chart8 size ${r.id}`);
    let own = 0; for (let i = 0; i < deeds.data.length; i += 4) { const v = deeds.data[i]; if (![DEED_PX.thisRealm, DEED_PX.otherRealm, DEED_PX.none].includes(v)) problems.push(`deed value ${v}`); if (v === DEED_PX.thisRealm) own++; }
    if (own !== realm.grid.deeds || own !== r.deeds) problems.push(`deed count ${r.id}: mask ${own}, grid ${realm.grid.deeds}`);
    for (const f of realm.first) if (!pk.list.includes(`realm/${r.id}/${f}`)) problems.push(`first-frame file ${r.id}/${f}`);
  }
  return problems;
}

test('the overview pack is valid in every way a loader checks, and includes a realm west of the dateline', () => {
  assert.deepEqual(packProblems('overview'), []);
  const entry = index.packs.find(p => p.name === 'overview');
  assert.equal(entry.valid, true);
  assert.equal(entry.manifestSha256, sha256(read('packs/overview/manifest.json')), 'the manifest sha a lock would pin');
  const wrap = JSON.parse(read('packs/overview/realm/wrap/realm.json'));
  assert.ok(wrap.grid.x0 < 0, 'the Cinderfall case: the pack grid starts west of the dateline');
});

test('each negative pack fails for exactly its declared defect, so a refusal test cannot pass for another reason', () => {
  const own = JSON.parse(read('packs/tampered/realm/alpha/realm.json')).grid.deeds;
  // one deed flipped in a still-valid PNG: both hash checks catch it (and the flipped deed shows in the count)
  assert.deepEqual(packProblems('tampered'), ['manifest realm/alpha/deeds.png', 'realm.json alpha/deeds.png', `deed count alpha: mask ${own + 1}, grid ${own}`]);
  const declared = JSON.parse(read('packs/miscounted/realm/wrap/realm.json')).grid.deeds;
  assert.deepEqual(packProblems('miscounted'), [`deed count wrap: mask ${declared - 1}, grid ${declared}`], 'hashes agree; only the grid count is wrong');
  for (const name of ['tampered', 'miscounted']) assert.equal(index.packs.find(p => p.name === name).valid, false);
});
