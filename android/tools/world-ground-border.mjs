// The GROUND border golden (lane NR, N3 fix pass; rewritten by NT for stage B): the realm-border deeds where a realm pack's
// own deeds.png and the frozen deed catalogue disagree, classified by the PINNED web code.
//
//   node tools/world-ground-border.mjs --source <SHARDKEEP-globe repo> [--pack <dir>]           write the suite
//   node tools/world-ground-border.mjs --source <SHARDKEEP-globe repo> [--pack <dir>] --check   regenerate, byte-compare
//
// Why (Rule 7, one source for both clients): GROUND's far field and the per-deed kinds come from a deeds mask. ground.js
// at the pin reads the pack's deeds.png (pack.first.deeds); native reads the catalogue mask (RealmOpen.deeds, server truth,
// GLOBE-PRODUCTION-PLAN §2.4.3). 2–18 deeds per realm differ.
//
// Stage B (205b6326, pack a6447a69 onward): PACK bakes GROUND's foreign-sea cap and tarn clip into fieldsA.png, from the
// PACK's deeds.png, and says so in realm.json (fields.fieldsA.baked, else the top-level fieldsA.baked: ground.js load()'s
// order). The unbaked file is not shipped (rawSha256 only), so no client can rebuild a catalogue-mask coast. Both clients
// honour the flag, so both load the baked bytes VERBATIM and class the border identically; the far field stays per mask.
// This suite pins that truth, each part with teeth:
//   (a) loading: the post-load fieldsA over every border deed ± 1 is the file byte for byte, with either mask (the loader
//       never re-runs a baked pass; packVsCatalog.coastTexels/lakeTexels/fieldDeeds/vertices are then 0, computed, not
//       assumed);
//   (b) the far field from the catalogue mask, bit for bit, and how many far deeds the pack mask moves (unchanged);
//   (c) every border vertex's class, ground class, ring flag and sampled wetness on the loaded fields;
//   (d) the teeth of (a): reRun = the cap run AGAIN over the baked bytes with the catalogue far field (what a loader that
//       ignored the flag would draw natively): the coast texels and border vertices it moves. The same re-run with the
//       pack's far field moves nothing (reRun.packCoastTexels: the cap is idempotent on its own output), which is why a
//       re-run is invisible on the web and not on native.
// The coast both clients draw is therefore the pack mask's, not the catalogue's, at the deeds reRun lists: that residual
// is a web/PACK ask (bake from the catalogue), recorded in KNOWN_ISSUES, never hidden here.
//
// The pack is read from --pack (default: the source's concepts/globe3d-2026-09-23/pack), every file checked byte for
// byte against the pinned pack manifest and refused otherwise. When the web checkout has rebuilt its pack past the pin,
// the bundled world content (app/src/main/assets/world, built from the pinned pack and verified) holds the same bytes.
// Output: renderer/src/test/resources/world/ground-border/border.json (sorted keys; doubles as IEEE-754 bit strings,
// crops gzip + base64, as tools/world-ground-golden.mjs).
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ENGINE, LOCK_FILE, SHARED, extractPinned, moduleLoader } from './world-shaders.mjs';
import { PACK_DIR, pinnedManifest } from './world-debug-content.mjs';
import { serialize } from './world-golden.mjs';

export const OUT_DIR = 'renderer/src/test/resources/world/ground-border';
export const OUT_FILE = 'border.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gz = bytes => zlib.gzipSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { level: 9, mtime: 0 }).toString('base64');
const HEXC = '0123456789abcdef';
const LATTICE_W = 720, LATTICE_H = 360;
const floorMod = (a, n) => ((a % n) + n) % n;
// GLOBE-PRODUCTION-PLAN §2.4.2 (as tools/world-golden.mjs tileOf): the catalogue tile of deed (dx, dy), −1 off the lattice
const tileOf = (g, dx, dy) => (dx < 0 || dy < 0 || dx >= g.cols || dy >= g.rows || g.y0 + dy < 0 || g.y0 + dy >= LATTICE_H ? -1 : (g.y0 + dy) * LATTICE_W + floorMod(g.x0 + dx, LATTICE_W));
/** Vertices per deed side (x = deed·TILES + OFF + STEP·i): 14 × 7 tiles covers a 98-tile deed. */
const SIDE = 14, STEP = 7, OFF = 3, MARGIN_DEEDS = 0; // the classifier reads ≤ ~25 t from a vertex (warps): ±1 deed holds it

async function realmBorder(M, sharp, cat, pack) {
  const K = M.classify, DP = M.contracts.DEED_PX, T = M.contracts.TILES;
  const { id, meta } = pack, g = meta.grid, { cols, rows } = g, cfg = K.classConfig(meta.classes ?? {});
  const dp = await M.loader.decodePng(pack.files['deeds.png']);
  const packMask = new Uint8Array(cols * rows); for (let i = 0; i < packMask.length; i++) packMask[i] = dp.data[i * 4];
  const catMask = new Uint8Array(cols * rows);
  for (let dy = 0; dy < rows; dy++) for (let dx = 0; dx < cols; dx++) {
    const c = cat.get(tileOf(g, dx, dy)); catMask[dy * cols + dx] = c?.realmId === id ? DP.thisRealm : c ? DP.otherRealm : DP.none;
  }
  const maskDeeds = []; for (let k = 0; k < cols * rows; k++) if (packMask[k] !== catMask[k]) maskDeeds.push([k, packMask[k], catMask[k]]);
  // ground.js load() (stage B order, ground.js:292): the fields.fieldsA.baked key first, then the top-level fieldsA.baked
  const bakedFields = meta.fields?.fieldsA?.baked ?? null, bakedTop = meta.fieldsA?.baked ?? null;
  const baked = new Set(bakedFields ?? bakedTop ?? []);
  if (!baked.has('foreignSea') || !baked.has('clipTarns')) {
    throw new Error(`REFUSED: ${id}: realm.json does not bake foreignSea + clipTarns into fieldsA (${[...baked]}): this suite pins the baked-fields `
      + 'truth of stage B; a pack that stops baking needs the pre-stage-B suite back (git log tools/world-ground-border.mjs)');
  }
  const chartRaw = await sharp(pack.files['chart8.webp']).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const chart = { width: chartRaw.info.width, height: chartRaw.info.height, data: new Uint8Array(chartRaw.data), channels: 4 };
  const file = await M.loader.decodePng(pack.files['fieldsA.png']), pb = await M.loader.decodePng(pack.files['fieldsBC.png']);
  const W = file.width, ppd = W / cols;
  const img = () => ({ width: W, height: file.height, data: Uint8Array.from(file.data), channels: 4 });
  const cap = (A, far) => { const it = K.foreignSeaRows(A, far, cols, rows); let x; while (!(x = it.next()).done); return x.value; };
  // the load as ground.js runs it (each pass only when not baked: here neither runs), once per mask
  const load = mask => {
    const far = M.minimap.farDeeds(mask, cols, rows), A = img();
    return { far, A, foreignSea: baked.has('foreignSea') ? { baked: true } : cap(A, far), clipTarns: baked.has('clipTarns') ? { baked: true } : K.clipTarns(A, chart) };
  };
  const C = load(catMask), P = load(packMask);
  /** texels whose coast (R) / lake (G) differ between two images, and the deeds holding them */
  const diff = (X, Y) => {
    const deeds = new Set(); let r = 0, g = 0;
    for (let p = 0; p < W * file.height; p++) {
      const dr = X.data[p * 4] !== Y.data[p * 4], dg = X.data[p * 4 + 1] !== Y.data[p * 4 + 1];
      if (dr) r++; if (dg) g++;
      if (dr || dg) deeds.add(Math.floor(Math.floor(p / W) / ppd) * cols + Math.floor((p % W) / ppd));
    }
    return { r, g, deeds: [...deeds].sort((a, b) => a - b) };
  };
  const loadedVsFile = [diff(C.A, file), diff(P.A, file)];
  if (loadedVsFile.some(d => d.r || d.g)) throw new Error(`${id}: ground.js load() changed baked fieldsA bytes (${JSON.stringify(loadedVsFile.map(d => [d.r, d.g]))})`);
  const packVsCat = diff(C.A, P.A);
  let farDiff = 0; for (let i = 0; i < C.far.length; i++) if (C.far[i] !== P.far[i]) farDiff++;
  // (d) the teeth: the cap re-run over the baked bytes, with the catalogue's far field and with the pack's own
  const R = img(), reCap = cap(R, C.far), reRun = diff(R, file);
  const RP = img(); cap(RP, P.far); const rePack = diff(RP, file);
  const border = [...new Set([...maskDeeds.map(m => m[0]), ...packVsCat.deeds, ...reRun.deeds])].sort((a, b) => a - b);
  // classes at the border deeds: on the loaded fields (what both clients draw) and, for the teeth, on the re-run's
  const lines = K.prepareLines(pack.lines, { cols, rows }, cfg);
  const classesOn = A => {
    const fields = K.makeFields({ fieldsA: A, fieldsBC: { width: pb.width, height: pb.height, data: pb.data, channels: 4 } });
    const state = K.makeState(cols, rows, []);
    const st = { ...state, rivers: K.bendRivers(lines, state, cfg), bridges: K.plotBridges(fields, lines, state, cfg) };
    return border.map(k => {
      const out = {};
      for (const [name, c] of [['true', cfg], ['lattice', K.latticeCfg(cfg)]]) {
        let cls = '', ground = '', ring = '', wet = '';
        for (let j = 0; j < SIDE; j++) for (let i = 0; i < SIDE; i++) {
          const x = (k % cols) * T + OFF + STEP * i, y = Math.floor(k / cols) * T + OFF + STEP * j, d = K.classDetail(fields, lines, st, [x, y], c);
          cls += HEXC[d.cls]; ground += HEXC[d.ground]; ring += d.ring ? '1' : '0'; wet += K.sampledWet(fields, lines, st, [x, y], c);
        }
        out[name] = { cls, ground, ring, wet };
      }
      return out;
    });
  };
  const vertexDiff = (X, Y) => {
    let n = 0;
    X.forEach((d, i) => { for (const b of ['true', 'lattice']) for (let v = 0; v < SIDE * SIDE; v++) for (const f of ['cls', 'ground', 'ring', 'wet']) if (d[b][f][v] !== Y[i][b][f][v]) { n++; break; } });
    return n;
  };
  const onCat = classesOn(C.A), onPack = classesOn(P.A), onReRun = classesOn(R);
  // crops: every border deed ± (1 + MARGIN_DEEDS) deeds, overlapping boxes merged (FieldImage: one rect per texel)
  let rects = border.map(k => [k % cols - 1 - MARGIN_DEEDS, Math.floor(k / cols) - 1 - MARGIN_DEEDS, k % cols + 1 + MARGIN_DEEDS, Math.floor(k / cols) + 1 + MARGIN_DEEDS]);
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
      const [p, q] = [rects[a], rects[b]];
      if (p[0] <= q[2] + 1 && q[0] <= p[2] + 1 && p[1] <= q[3] + 1 && q[1] <= p[3] + 1) {
        rects[a] = [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[2], q[2]), Math.max(p[3], q[3])]; rects.splice(b, 1); merged = true; break outer;
      }
    }
  }
  rects = rects.map(([x0, y0, x1, y1]) => [Math.max(0, x0), Math.max(0, y0), Math.min(cols - 1, x1), Math.min(rows - 1, y1)]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const crop = (im, ppdI, [dx0, dy0, dx1, dy1], xOff = 0) => {
    const x0 = dx0 * ppdI, y0 = dy0 * ppdI, w = (dx1 - dx0 + 1) * ppdI, h = (dy1 - dy0 + 1) * ppdI, out = new Uint8Array(w * h * 4);
    for (let j = 0; j < h; j++) out.set(im.data.subarray(((y0 + j) * im.width + xOff + x0) * 4, ((y0 + j) * im.width + xOff + x0 + w) * 4), j * w * 4);
    return { x0: xOff + x0, y0, w, h, gz: gz(out) };
  };
  const farF32 = Buffer.from(Float32Array.from(C.far).buffer), farR8 = Uint8Array.from(C.far, v => Math.min(255, Math.round(v * 16)));
  return {
    realm: id, grid: [g.x0, g.y0, cols, rows],
    packDeedsSha256: sha256(pack.files['deeds.png']),
    catalogMask: gz(catMask),
    maskDeedsColumns: ['k', 'pack value', 'catalogue value'], maskDeeds,
    farCatalog: { float32Sha256: sha256(farF32), r8x16: gz(farR8) },
    fieldsA: { width: W, height: file.height, fileSha256: sha256(pack.files['fieldsA.png']), rawSha256: meta.fieldsA?.rawSha256 ?? null,
      baked: [...baked].sort(), bakedFields: bakedFields && [...bakedFields].sort(), bakedTop: bakedTop && [...bakedTop].sort(), crops: rects.map(q => crop(C.A, 8, q)) },
    fieldsBC: { width: pb.width, height: pb.height, crops: [...rects.map(q => crop(pb, 4, q, 0)), ...rects.map(q => crop(pb, 4, q, pb.width / 2))] },
    foreignSea: C.foreignSea, clipTarns: C.clipTarns,
    packVsCatalog: { maskDeeds: maskDeeds.length, farDeeds: farDiff, fieldDeeds: packVsCat.deeds, coastTexels: packVsCat.r, lakeTexels: packVsCat.g, vertices: vertexDiff(onCat, onPack) },
    reRun: { foreignSea: reCap, fieldDeeds: reRun.deeds, coastTexels: reRun.r, lakeTexels: reRun.g, vertices: vertexDiff(onCat, onReRun), packCoastTexels: rePack.r + rePack.g },
    border, vertices: onCat,
    count: border.length * SIDE * SIDE * 2,
  };
}

export async function generate({ repo, root = ROOT, packDir }) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')), pin = lock.source.commit;
  const pinned = pinnedManifest(repo, lock), dir = packDir ?? path.join(repo, PACK_DIR);
  const byPath = new Map(pinned.manifest.files.map(f => [f.path, f]));
  const read = rel => { const f = byPath.get(rel), p = path.join(dir, rel), b = fs.existsSync(p) ? fs.readFileSync(p) : null;
    if (!f || !b || f.bytes !== b.length || f.sha256 !== sha256(b)) throw new Error(`REFUSED: ${p} is not the pinned pack's ${rel} byte for byte (pass --pack <dir with the pinned bytes>)`); return b; };
  const packs = pinned.manifest.realms.map(({ id }) => ({ id, meta: JSON.parse(read(`realm/${id}/realm.json`).toString('utf8')), lines: JSON.parse(read(`realm/${id}/lines.json`).toString('utf8')),
    files: Object.fromEntries(['deeds.png', 'fieldsA.png', 'fieldsBC.png', 'chart8.webp'].map(f => [f, new Uint8Array(read(`realm/${id}/${f}`))])) })).sort((a, b) => (a.id < b.id ? -1 : 1));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-ground-border-'));
  try {
    extractPinned(repo, pin, [ENGINE, ...SHARED], tmp);
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(tmp, 'packages/shared/node_modules'), 'dir');
    const load = await moduleLoader(repo), files = { classify: 'classify.js', contracts: 'contracts.js', loader: 'loader.js', minimap: 'minimap.js' };
    const entry = path.join(tmp, 'ground-border-entry.mjs');
    fs.writeFileSync(entry, Object.entries(files).map(([k, f]) => `export * as ${k} from ${JSON.stringify('./' + path.posix.join(ENGINE, f))};`).join('\n')
      + `\nexport * as world from './packages/shared/src/fantasyWorld.ts';\n`);
    const M = { ...(await load(entry)) };
    const cat = new Map(); for (const t of M.world.fantasyTiles()) cat.set(t.tileId, t);
    const sharp = createRequire(path.join(repo, 'scripts/package.json'))('sharp');
    const sources = Object.fromEntries([...Object.values(files).map(f => `${ENGINE}/${f}`), 'packages/shared/src/fantasyWorld.ts', 'packages/shared/src/data/fantasy-world-v1.json']
      .map(rel => [rel, sha256(fs.readFileSync(path.join(tmp, rel)))]));
    const realms = []; for (const p of packs) realms.push(await realmBorder(M, sharp, cat, p));
    const body = {
      schema: 1, suite: 'border', pin, generator: sha256(fs.readFileSync(SELF)), sources,
      pack: { manifestSha256: pinned.sha256, packVersion: pinned.manifest.packVersion },
      catalog: { membershipSha256: M.world.FANTASY_MEMBERSHIP_HASH, catalogHash: M.world.FANTASY_CATALOG_HASH },
      tolerance: 'exact: the catalogue mask, the far field (float32 bits), the post-load fieldsA bytes and every vertex class, ground class, ring flag and sampled wetness',
      note: 'Stage B: every realm.json bakes foreignSea + clipTarns into fieldsA (fields.fieldsA.baked, else fieldsA.baked), so ground.js load() runs neither '
        + 'and the loaded fieldsA is the file byte for byte, whichever mask (packVsCatalog: 0 texels, 0 vertices, computed). Per realm the border is the deeds '
        + 'where the pack mask and the catalogue differ (maskDeeds), plus the deeds a cap re-run with the catalogue far field would move (reRun.fieldDeeds); '
        + 'at each, 14 × 14 vertices (x = dx·98 + 3 + 7i, y = dy·98 + 3 + 7j, row-major) classified with the realm config (true) and latticeCfg (lattice) on '
        + 'the LOADED fields, no plots. fieldsA.crops = the loaded (= file) bytes over every border deed ± 1; fieldsBC.crops = left halves then right halves. '
        + 'reRun = classify.js foreignSeaRows run again over the baked bytes with the catalogue far field (a loader that ignores the flag): the coast texels, '
        + 'deeds and border vertices it moves (the teeth: honouring the flag is observable); reRun.packCoastTexels = the same re-run with the pack far field '
        + '(0: the cap is idempotent on its own output). The far field stays per mask (farCatalog vs packVsCatalog.farDeeds).',
      realms,
      count: realms.reduce((s, r) => s + r.count, 0),
    };
    return Buffer.from(serialize(body) + '\n');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = path.resolve(opt('--root') ?? ROOT), repo = opt('--source') ?? process.env.PKW_GLOBE_SOURCE;
  if (!repo) throw new Error('Pass --source <SHARDKEEP-globe repo> (or PKW_GLOBE_SOURCE)');
  const bytes = await generate({ repo: path.resolve(repo), root, packDir: opt('--pack') && path.resolve(opt('--pack')) });
  const out = path.join(root, OUT_DIR, OUT_FILE);
  if (argv.includes('--check')) {
    if (!fs.existsSync(out) || !fs.readFileSync(out).equals(bytes)) { console.error(`world ground border golden drift: ${path.relative(root, out)}`); return 1; }
    console.log('world ground border golden: no drift');
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  console.log(`world ground border golden: wrote ${bytes.length} bytes into ${path.relative(root, out)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
