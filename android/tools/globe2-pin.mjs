// Globe v2 (N1) pin export for the native flat globe: presentation constants and golden vectors, taken from the web
// concept at a pinned commit of globe-realms (GLOBE-NATIVE-PLAN §4, §7; lane NG).
//
//   node tools/globe2-pin.mjs --source <SHARDKEEP-globe repo> [--pin <commit>]   write GlobeV2Pin.kt and the goldens
//   node tools/globe2-pin.mjs --source <SHARDKEEP-globe repo> --check            re-export the recorded pin; byte-compare
//
// Every byte comes from the pinned COMMIT (git archive), never from the working tree. The concept's camera is not a
// module (main.js drives the DOM), so its camera block, grab() and fitAlt() are cut out of main.js at the pin by their
// section markers and run in a sandbox with inert stand-ins for the page (heightAt = 0: the flat globe, D-164 exag 0):
// the goldens are the web implementation's own numbers. The per-frame dynamics inside main.js frame() (flight ease,
// inertia decay, zoom ease, selection fade) are read as literals by pattern; a pattern that stops matching fails the
// export instead of writing a stale number. Picking goldens: the concept's tap rule (land ? region : -1) and the
// exploration code on the frozen geography, at 5,000 seeded points, against the client pack's realm and surface masks
// (the same frozen geography native already ships), which are copied into test resources with their pack sha256.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PIN = '02e9da8414156b9e0000df1653de6273b196cca6';
export const CONCEPT = 'concepts/globe3d-2026-09-23';
const FROZEN = 'apps/web/src/ui/fantasy/runtime/geography/frozen-runs.mjs';
export const KT = 'renderer/src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/globe2/GlobeV2Pin.kt';
export const OUT = 'renderer/src/test/resources/world/globe2';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = b => createHash('sha256').update(b).digest('hex');
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 28 });
const json = v => Buffer.from(JSON.stringify(v, null, 1) + '\n');

// deterministic sample stream (mulberry32)
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r6 = v => Math.round(v * 1e12) / 1e12; // shortest-stable doubles for the JSON (the Kotlin tolerance is 1e-9 relative)

function resolvePin(repo, pin) {
  const full = git(repo, ['rev-parse', '--verify', '--quiet', `${pin}^{commit}`]).toString().trim();
  if (!/^[0-9a-f]{40}$/.test(full)) throw new Error(`${pin} is not a commit in ${repo}`);
  return full;
}
function slice(text, from, to) {
  const a = text.indexOf(from), b = text.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`main.js at the pin has no section ${from} … ${to}`);
  return text.slice(a, b);
}
function fnSource(text, name) {
  const at = text.indexOf(`function ${name}(`); if (at < 0) throw new Error(`main.js at the pin has no function ${name}`);
  let i = text.indexOf('{', at), depth = 0;
  for (; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1); }
  throw new Error(`unbalanced function ${name}`);
}
/** A literal number read from `re` (one capture group) in `text`; fails loudly when the pattern no longer matches. */
function lit(text, re, what) { const m = text.match(re); if (!m) throw new Error(`main.js at the pin: ${what} not found (${re})`); return +m[1]; }

export async function exportPin({ repo, pin, pack }) {
  const commit = resolvePin(repo, pin);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'globe2-pin-'));
  try {
    const files = [`${CONCEPT}/src/geo.js`, `${CONCEPT}/src/landmarks.js`, `${CONCEPT}/src/main.js`, `${CONCEPT}/src/bases.js`, FROZEN];
    execFileSync('tar', ['-x', '-C', tmp], { input: git(repo, ['archive', '--format=tar', commit, '--', ...files]), maxBuffer: 1 << 28 });
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}\n');
    const src = path.join(tmp, CONCEPT, 'src');
    const geo = await import(pathToFileURL(path.join(src, 'geo.js')).href);
    const land = await import(pathToFileURL(path.join(src, 'landmarks.js')).href);
    const mainText = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
    const basesText = fs.readFileSync(path.join(src, 'bases.js'), 'utf8');
    const sources = Object.fromEntries(files.map(f => [f, sha256(fs.readFileSync(path.join(tmp, f)))]));

    // ---- the concept camera, cut out of main.js and run as the page runs it --------------------------------------
    const math = slice(mainText, '// ---------- math ----------', '// ---------- settings ----------');
    const camera = slice(mainText, '// ---------- camera ----------', '// ---------- input ----------');
    const dirOfSrc = basesText.match(/export const dirOf = [^\n]*;/)?.[0]?.replace('export ', '');
    if (!dirOfSrc) throw new Error('bases.js at the pin has no dirOf');
    const page = { W: 390, H: 844 };
    const ctx = vm.createContext({ Math, Float32Array, Float64Array, Array, Number, performance: { now: () => 0 }, matchMedia: () => ({ matches: false }),
      ISLAND_ART: geo.ISLAND_ART, state: { exag: 0 }, heightAt: () => 0,
      get innerWidth() { return page.W; }, get innerHeight() { return page.H; }, canvas: { get clientWidth() { return page.W; }, get clientHeight() { return page.H; } } });
    vm.runInContext(`const RAD = Math.PI / 180;\n${dirOfSrc}\n${math}\n${camera}\n${fnSource(mainText, 'grab')}\n${fnSource(mainText, 'fitAlt')}
      globalThis.__cam = { altOf, zOf, fovY, computeView, projectDir, hitSphere, rayAt, grab, fitAlt, minAltAt, flyTo, EASE, cam, lens, dirOf, lonlatOf, norm,
        setView: v => { view = v; }, setZLo: z => { zLo = z; }, K: { ALT_MAX, ALT_MIN, FOV, TILT_MAX, ALT_MIN_ATLAS } };`, ctx);
    const C = ctx.__cam;
    const f32 = a => Array.from(a, v => r6(v));
    const cases = [];
    const rand = rng(0x51ab1e);
    const sizes = [[390, 844], [844, 390], [914, 2034], [873, 1942], [800, 1780], [1200, 800]];
    for (let k = 0; k < 24; k++) {
      const [W, H] = sizes[k % sizes.length]; page.W = W; page.H = H;
      const lon = -180 + rand() * 360, lat = -80 + rand() * 160, z = k % 6 === 0 ? -0.2 : rand(), lx = k % 4 === 0 ? 0 : (rand() - 0.5) * 0.8, ly = k % 4 === 0 ? 0 : (rand() - 0.5) * 0.8;
      C.cam.t = C.dirOf(lon, lat); C.cam.z = z; C.lens.x = lx; C.lens.y = ly;
      const v = C.computeView(W, H); C.setView(v);
      const hits = [];
      for (let i = 0; i < 40; i++) { const px = rand() * W, py = rand() * H, h = C.hitSphere(px, py); hits.push([r6(px), r6(py), h ? h.map(r6) : null]); }
      const projections = [];
      for (let i = 0; i < 40; i++) { const d = C.dirOf(-180 + rand() * 360, -89 + rand() * 178), p = C.projectDir(d); projections.push([d.map(r6), p ? p.map(r6) : null]); }
      cases.push({ W, H, t: C.cam.t.map(r6), z: r6(z), lens: [r6(lx), r6(ly)], alt: r6(v.alt), eye: v.eye.map(r6), VP: f32(v.VP), inv: f32(v.inv),
        pxPerRad: r6(v.pxPerRad), right: v.right.map(r6), up: v.up.map(r6), hits, projections });
    }
    // grab (arcball ≤ 0.3 rad a step, off-sphere pan) from a fixed view per case
    const grabs = [];
    for (let k = 0; k < 60; k++) {
      const [W, H] = sizes[k % sizes.length]; page.W = W; page.H = H;
      C.cam.t = C.dirOf(-180 + rand() * 360, -70 + rand() * 140); C.cam.z = rand(); C.lens.x = 0; C.lens.y = 0;
      const t0 = C.cam.t.slice(), v = C.computeView(W, H); C.setView(v);
      const from = [rand() * W, rand() * H], to = [from[0] + (rand() - 0.5) * W * 0.3, from[1] + (rand() - 0.5) * H * 0.3];
      const w = C.grab(from, to);
      grabs.push({ W, H, t0: t0.map(r6), z: r6(C.cam.z), from: from.map(r6), to: to.map(r6), t1: C.cam.t.map(r6), step: w ? w.map(r6) : null }); // (not "w": libGDX JsonValue keys match case-insensitively, "W" is taken)
    }
    const alts = []; for (let i = 0; i <= 40; i++) { const z = -0.5 + i * 0.0375; alts.push([r6(z), r6(C.altOf(z))]); }
    const fovs = sizes.concat([[1080, 2400], [2400, 1080], [500, 500]]).map(([W, H]) => [W, H, r6(C.fovY(W, H))]);
    const minAlts = []; for (let i = 0; i < 400; i++) { const d = C.dirOf(-180 + rand() * 360, -80 + rand() * 160); minAlts.push([d.map(r6), r6(C.minAltAt(d))]); }
    // also every Phase E art centre and its rim, where minAltAt eases
    for (const A of geo.ISLAND_ART) for (const f of [0, 0.3, 0.45, 0.6, 0.9, 1.2]) { const d = C.dirOf(A.lon + f * A.wDeg, A.lat); minAlts.push([d.map(r6), r6(C.minAltAt(d))]); }
    const fits = [];
    for (let k = 0; k < 30; k++) {
      const [W, H] = sizes[k % sizes.length]; page.W = W; page.H = H; C.setZLo(k % 3 === 0 ? -0.3 : 0);
      const lon = -180 + rand() * 360, lat = -60 + rand() * 120, c = C.dirOf(lon, lat), r = 2 + rand() * 30, pts = [];
      for (let i = 0; i < 24; i++) pts.push(C.dirOf(lon + Math.cos(i / 24 * 2 * Math.PI) * r / Math.cos(lat * Math.PI / 180), lat + Math.sin(i / 24 * 2 * Math.PI) * r * 0.6));
      const hw = 60 + rand() * W / 2, hh = 60 + rand() * H / 2, lo = k % 2 ? 0.2 : 0.3;
      fits.push({ W, H, zLo: k % 3 === 0 ? -0.3 : 0, c: c.map(r6), pts: pts.map(p => p.map(r6)), hw: r6(hw), hh: r6(hh), lo, alt: r6(C.fitAlt(pts, c, hw, hh, lo)) });
    }
    C.setZLo(0);
    const eases = ['inout', 'out', 'in'].map(e => [e, Array.from({ length: 21 }, (_, i) => r6(C.EASE[e](i / 20)))]);

    // ---- per-frame literals of frame(), tap() and the pointer handlers (read, never retyped) ---------------------
    const frameSrc = fnSource(mainText, 'frame'), tapSrc = fnSource(mainText, 'tap');
    const K = {
      altMax: C.K.ALT_MAX, altMin: C.K.ALT_MIN, fovRad: C.K.FOV, altMinAtlas: C.K.ALT_MIN_ATLAS,
      fovPortraitCapDeg: lit(camera, /Math\.tan\((\d+) \* RAD\), Math\.tan\(FOV \/ 2\)/, 'portrait fov cap'),
      startLon: lit(camera, /const cam = \{ t: dirOf\((-?[\d.]+), -?[\d.]+\)/, 'start lon'), startLat: lit(camera, /const cam = \{ t: dirOf\(-?[\d.]+, (-?[\d.]+)\)/, 'start lat'),
      startZ: lit(camera, /const cam = \{[^}]*z: ([\d.]+)/, 'start z'),
      nearMin: lit(camera, /const near = Math\.max\(([\d.]+), alt \* [\d.]+\)/, 'near min'), nearK: lit(camera, /const near = Math\.max\([\d.]+, alt \* ([\d.]+)\)/, 'near k'),
      farPad: lit(camera, /far = len\(eye\) \+ ([\d.]+)/, 'far pad'),
      flightMs: lit(camera, /clamp\((\d+) \+ ang \* \d+, \d+, \d+\)/, 'flight base'), flightPerRad: lit(camera, /clamp\(\d+ \+ ang \* (\d+), \d+, \d+\)/, 'flight per rad'),
      flightMaxMs: lit(camera, /clamp\(\d+ \+ ang \* \d+, \d+, (\d+)\)/, 'flight max'), arcDiv: lit(camera, /arc: clamp\(ang \/ ([\d.]+), 0, [\d.]+\)/, 'arc div'),
      arcMax: lit(camera, /arc: clamp\(ang \/ [\d.]+, 0, ([\d.]+)\)/, 'arc max'),
      dtMax: lit(frameSrc, /const dt = Math\.min\(([\d.]+), \(now - lastT\)/, 'dt clamp'),
      inertiaDecay: lit(frameSrc, /Math\.exp\(-dt \* ([\d.]+)\)\); if \(len\(cam\.vel\) < [\d.]+\) cam\.vel = null/, 'inertia decay'),
      inertiaStop: lit(frameSrc, /if \(len\(cam\.vel\) < ([\d.]+)\) cam\.vel = null/, 'inertia stop'),
      zoomEase: lit(frameSrc, /mix\(cam\.z, cam\.zT, 1 - Math\.exp\(-dt \* (\d+)\)\)/, 'zoom ease'),
      diveAltK: lit(frameSrc, /ALT_MIN_ATLAS \* ([\d.]+) : minAltAt/, 'dive floor k'),
      latMax: lit(frameSrc, /if \(Math\.abs\(lat\) > (\d+)\)/, 'lat clamp'),
      diveAlt: lit(frameSrc, /altOf\(cam\.z\) < ([\d.]+) && now > diveBlockUntil/, 'dive altitude'),
      selFadeS: lit(frameSrc, /dt \/ ([\d.]+), 0, 1\); if \(selFx\.k === 0\)/, 'selection fade'),
      lensEase: lit(frameSrc, /const e = 1 - Math\.exp\(-dt \* (\d+)\); lens\.x/, 'lens ease'),
      fxBusyMs: lit(frameSrc, /now - selFx\.t0 < (\d+)/, 'selection busy'),
      cloudRotPerS: lit(frameSrc, /'uCloudRot'\), time \* ([\d.]+)\)/, 'cloud rotation'),
      cloudAlt0: lit(frameSrc, /'uCloudAmt'\), state\.clouds \? smooth\(([\d.]+), [\d.]+, view\.alt\)/, 'cloud fade start'),
      cloudAlt1: lit(frameSrc, /'uCloudAmt'\), state\.clouds \? smooth\([\d.]+, ([\d.]+), view\.alt\)/, 'cloud fade end'),
      sunT: lit(frameSrc, /norm\(add\(add\(mulS\(t, ([\d.]+)\), mulS\(east, -[\d.]+\)\), mulS\(north, [\d.]+\)\)\)/, 'sun t'),
      sunEast: -lit(frameSrc, /mulS\(east, -([\d.]+)\)\), mulS\(north/, 'sun east'),
      sunNorth: lit(frameSrc, /mulS\(east, -[\d.]+\)\), mulS\(north, ([\d.]+)\)\)\)/, 'sun north'),
      nightSunT: lit(frameSrc, /state\.night \? norm\(add\(mulS\(t, ([\d.]+)\), mulS\(east, [\d.]+\)\)\)/, 'night sun t'),
      nightSunEast: lit(frameSrc, /state\.night \? norm\(add\(mulS\(t, [\d.]+\), mulS\(east, ([\d.]+)\)\)\)/, 'night sun east'),
      doubleTapMs: lit(tapSrc, /now - lastTap\[2\] < (\d+)/, 'double tap ms'), doubleTapPx: lit(tapSrc, /lastTap\[1\]\) < (\d+)\)/, 'double tap px'),
      doubleTapDz: lit(tapSrc, /clamp\(cam\.z \+ ([\d.]+), 0, 1\), \d+\)/, 'double tap dz'), doubleTapMs2: lit(tapSrc, /clamp\(cam\.z \+ [\d.]+, 0, 1\), (\d+)\)/, 'double tap flight'),
      slopPx: lit(mainText, /Math\.hypot\(cur\[0\] - downAt\[0\], cur\[1\] - downAt\[1\]\) < (\d+)\) return/, 'drag slop'),
      sampleMs: lit(mainText, /now - samples\[0\]\[0\] > (\d+)\) samples\.shift/, 'inertia samples'),
      grabMax: lit(mainText, /Math\.min\(Math\.atan2\(s, dot\(p1, p0\)\), ([\d.]+)\)/, 'grab max'),
      tapMs: lit(mainText, /performance\.now\(\) - downAt\[2\] < (\d+)\) tap/, 'tap ms'),
      velMin: lit(mainText, /if \(len\(cam\.vel\) < ([\d.]+)\) cam\.vel = null; \} \}/, 'fling minimum'),
      dprCap: lit(mainText, /dprCap: (\d+)/, 'dpr cap'),
      entranceK: lit(mainText, /Math\.max\(0, dur \* ([\d.]+) - \d+\)/, 'entrance k'), entranceLeadMs: lit(mainText, /Math\.max\(0, dur \* [\d.]+ - (\d+)\)/, 'entrance lead'),
      focusPad: lit(mainText, /const f = freeRect\(\), pad = (\d+);/, 'focus pad'),
      diveFlightMs: lit(mainText, /flyTo\(target, zOf\(0\.5\), far \? undefined : (\d+), far \? 'inout' : 'in'\)/, 'dive flight'),
      diveFlightAlt: lit(mainText, /flyTo\(target, zOf\(([\d.]+)\), far \? undefined/, 'dive flight alt'),
      diveFarRad: lit(mainText, /dot\(norm\(cam\.t\), target\), -1, 1\)\) > ([\d.]+);/, 'dive far'),
      diveFailBlockMs: lit(mainText, /diveBlockUntil = performance\.now\(\) \+ (\d+); \/\/ never retry/, 'dive fail block'),
      leaveBlockMs: lit(mainText, /diveBlockUntil = performance\.now\(\) \+ (\d+); diving = false;\n/, 'leave block'),
      labelAlt: lit(mainText, /rects = view\.alt > ([\d.]+) \? uiRects\(\)/, 'label altitude'),
      labelLimb: lit(mainText, /< 1 \/ eL \+ ([\d.]+)\) return; \/\/ foreshortened/, 'label limb'),
      labelLift: lit(mainText, /const s = projectDir\(dd, ([\d.]+)\); if \(!s\) return;/, 'label lift'),
      realmFocusAlt: lit(mainText, /focusOn\(g\.c, g\.pts, ([\d.]+), opts\.dur\)/, 'realm focus floor'),
      cloudShell: lit(frameSrc, /'uR'\), ([\d.]+)\)/, 'cloud shell radius'),
    };
    for (const [k, v] of Object.entries(K)) if (!Number.isFinite(v)) throw new Error(`constant ${k} is not a number`);

    // ---- realms (geo.js REALMS + landmarks REALM_INFO accents) and the Phase E set (flag-gated, RG-3) ------------
    const hex = h => { if (!/^#[0-9a-fA-F]{6}$/.test(h ?? '')) throw new Error(`accent ${h}`); return parseInt(h.slice(1), 16); };
    const realms = geo.REALMS.map(r => ({ id: r.id, name: r.name, lon: r.lon, lat: r.lat, accent: hex(land.REALM_INFO[r.id]?.accent) }));
    const phaseE = [...geo.NEW_ISLANDS, geo.DIVINE].map(i => {
      const art = geo.ISLAND_ART.find(a => a.id === i.id);
      return { id: i.id, name: i.name, lon: i.lon, lat: i.lat, rx: i.rx, ry: i.ry, accent: hex(land.ISLAND_INFO[i.id]?.accent), wDeg: art.wDeg, aspect: art.aspect };
    });

    // ---- picking goldens on the frozen geography ------------------------------------------------------------------
    const codes = geo.decodeGeography();
    const pickRand = rng(0x9e1c7);
    const picks = [];
    for (let i = 0; i < 5000; i++) {
      const lon = -180 + pickRand() * 360, lat = -90 + pickRand() * 180, gi = geo.geoIndex(lon, lat), c = codes[gi];
      picks.push([r6(lon), r6(lat), (c & 16) ? (c & 15) - 1 : -1, c >> 6]);
    }
    // the realm outlines' framing geometry (main.js realmGeom: main landmass, bbox centre in its tangent plane)
    const fields = geo.buildFields(codes);
    const geomSrc = `const RAD = Math.PI / 180;\n${dirOfSrc}\n${math}\nconst GW = ${geo.GW}, GH = ${geo.GH};\n${mainText.match(/const geoDir = [^\n]*\n/)[0]}${mainText.match(/const inRealm = [^\n]*\n/)[0]}const realmGeo = new Map();\n${fnSource(mainText, 'realmGeom')}\nglobalThis.__geom = realmGeom;`;
    const gctx = vm.createContext({ Math, Int32Array, Float64Array, Array, Set, Map, fields });
    vm.runInContext(geomSrc, gctx);
    const geoms = geo.REALMS.map((r, i) => { const g = gctx.__geom(i); return { id: r.id, c: g.c.map(r6), pts: g.pts.length, ptsHead: g.pts.slice(0, 12).map(p => p.map(r6)), ptsSum: g.pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map(r6) }; });

    // ---- the client pack's copies of the frozen geography (legacy masks): picked from on the device ------------
    const masks = {};
    for (const name of ['realm-mask.png', 'surface-mask.png']) {
      const file = path.join(pack, 'atlas/fantasy/globe', name);
      masks[name] = fs.readFileSync(file);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'atlas/fantasy/globe/manifest.json'), 'utf8'));
    for (const [name, bytes] of Object.entries(masks)) {
      const want = manifest.files.find(f => f.path === name)?.sha256;
      if (want !== sha256(bytes)) throw new Error(`${name}: the client pack copy does not match its manifest`);
    }

    // ---- the shared flat-globe stages, preprocessed by the pin's own realm core (test copies for the uniform checks;
    // the runtime stages are NT's WorldShaders export) ---------------------------------------------------------------
    const shaderFiles = await globeStages(repo, commit);

    // ---- the exploration islands as the client pack's render catalogue places them (native's own data, RG-1) -----
    const catalog = JSON.parse(fs.readFileSync(path.join(pack, 'render-catalog.json'), 'utf8'));
    const pres = (catalog.fantasy ?? catalog).presentation;
    const islands = { shape: pres.islands, chains: pres.chains.map(c => ({ id: c.id, islands: c.islands.map(i => ({ lon: i.lon, lat: i.lat, rx: i.rx, ry: i.ry })) })),
      regions: pres.regions.map(r => r.id), effectsPath: pres.effectsPath };
    if (JSON.stringify(islands.regions) !== JSON.stringify(geo.REALMS.map(r => r.id))) throw new Error('the render catalogue regions are not in geo.js REALMS order');

    const header = { pin: commit, generator: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), sources };
    const out = new Map();
    out.set(`${OUT}/camera.json`, json({ ...header, suite: 'globe2-camera', epsilon: 1e-9, constants: K, alts, fovs, cases, grabs, minAlts, fits, eases }));
    out.set(`${OUT}/picking.json`, json({ ...header, suite: 'globe2-picking', geography: { width: geo.GW, height: geo.GH }, masks: Object.fromEntries(Object.entries(masks).map(([k, v]) => [k, sha256(v)])), regionIds: geo.REALMS.map(r => r.id), picks, geoms }));
    for (const [k, v] of Object.entries(masks)) out.set(`${OUT}/${k}`, v);
    out.set(`${OUT}/islands.json`, json({ ...header, suite: 'globe2-islands', pack: path.relative(ROOT, pack), ...islands }));
    for (const [k, v] of shaderFiles) out.set(`${OUT}/shaders/${k}`, v);
    out.set(KT, Buffer.from(kotlin({ commit, K, realms, phaseE, geo })));
    return out;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** The pin's src/globe programs through the pin's own core.js preprocessGLSL (as NT's exporter does for the realm). */
async function globeStages(repo, commit) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'globe2-stages-'));
  try {
    const want = [`${CONCEPT}/src/realm`, `${CONCEPT}/src/globe`, 'packages/shared/package.json', 'packages/shared/src'];
    execFileSync('tar', ['-x', '-C', tmp], { input: git(repo, ['archive', '--format=tar', commit, '--', ...want]), maxBuffer: 1 << 28 });
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(tmp, 'packages/shared/node_modules'), 'dir');
    const tsx = path.join(repo, 'scripts/node_modules/tsx/dist/esm/api/index.mjs');
    const load = fs.existsSync(tsx) ? (await import(pathToFileURL(tsx).href)).tsImport : null;
    const imp = async f => { const m = load ? await load(pathToFileURL(f).href, import.meta.url) : await import(pathToFileURL(f).href); return m.GLOBE_PROGRAMS || m.preprocessGLSL ? m : m.default; };
    const core = await imp(path.join(tmp, CONCEPT, 'src/realm/core.js'));
    const G = await imp(path.join(tmp, CONCEPT, 'src/globe/flat.glsl.js'));
    const includes = new Map(Object.entries(G.GLOBE_INCLUDES).map(([k, id]) => [k, G[id]]));
    const files = new Map();
    for (const p of G.GLOBE_PROGRAMS) for (const [kind, id] of [['VS', p.vs], ['FS', p.fs]]) {
      files.set(`${p.name}.${kind.toLowerCase()}.glsl`, Buffer.from(core.preprocessGLSL(G[id], { kind, includes, name: p.name }), 'utf8'));
    }
    return files;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function kotlin({ commit, K, realms, phaseE, geo }) {
  const d = v => { const s = String(v); return /[.eE]/.test(s) ? s : s + '.0'; };
  const consts = Object.entries(K).map(([k, v]) => `    const val ${k.replace(/[A-Z]/g, c => '_' + c).toUpperCase()}: Double = ${d(v)}`).join('\n');
  const realmRows = realms.map(r => `        GlobeRealmSpec("${r.id}", "${r.name}", ${d(r.lon)}, ${d(r.lat)}, 0x${r.accent.toString(16).padStart(6, '0')}),`).join('\n');
  const phaseRows = phaseE.map(i => `        GlobeIslandSpec("${i.id}", "${i.name}", ${d(i.lon)}, ${d(i.lat)}, ${d(i.rx)}, ${d(i.ry)}, 0x${i.accent.toString(16).padStart(6, '0')}, ${d(i.wDeg)}, ${d(i.aspect)}),`).join('\n');
  return `// GENERATED by tools/globe2-pin.mjs from globe-realms ${commit}. Do not edit: re-run the tool.
// Presentation constants of the concept globe (src/main.js camera block, frame(), tap(), the pointer handlers; src/geo.js
// REALMS / NEW_ISLANDS / DIVINE / ISLAND_ART; src/landmarks.js accents). No game numbers. Drift:
// \`node tools/globe2-pin.mjs --source <globe repo> --check\`.
package gg.pixelkingdomwars.nativeclient.renderer.globe2

/** A realm on the globe: server id, display name, label anchor (degrees), accent (0xRRGGBB). */
class GlobeRealmSpec(val id: String, val name: String, val lon: Double, val lat: Double, val accent: Int)

/** A Phase E island (RG-3: used only when the Phase E layer is on). rx, ry: tap footprint (degrees of arc). */
class GlobeIslandSpec(val id: String, val name: String, val lon: Double, val lat: Double, val rx: Double, val ry: Double,
                      val accent: Int, val wDeg: Double, val aspect: Double)

object GlobeV2Pin {
    const val PIN: String = "${commit}"
    const val GEO_W: Int = ${geo.GW}
    const val GEO_H: Int = ${geo.GH}
${consts}

    /** geo.js REALMS order: the frozen geography's region index. */
    val REALMS: List<GlobeRealmSpec> = listOf(
${realmRows}
    )

    /** Seeker, Solana, Divine (geo.js NEW_ISLANDS + DIVINE, ISLAND_ART frames). Inert unless the Phase E flag is on. */
    val PHASE_E: List<GlobeIslandSpec> = listOf(
${phaseRows}
    )
}
`;
}

async function main() {
  const args = process.argv.slice(2), arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const repo = arg('--source') ?? process.env.PKW_GLOBE_SOURCE;
  if (!repo) throw new Error('Pass --source <SHARDKEEP-globe repo> (or PKW_GLOBE_SOURCE)');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'client-pack.lock.json'), 'utf8'));
  const pack = arg('--pack') ?? path.join(ROOT, lock.sourcePack);
  const check = args.includes('--check');
  const out = await exportPin({ repo, pin: check ? PIN : (arg('--pin') ?? PIN), pack });
  const drift = [];
  for (const [rel, bytes] of out) {
    const file = path.join(ROOT, rel);
    if (check) { if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) drift.push(rel); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  if (check && drift.length) { console.error(`globe2 pin drift:\n  ${drift.join('\n  ')}`); process.exit(1); }
  console.log(check ? `no drift (${out.size} files, pin ${PIN.slice(0, 8)})` : `wrote ${out.size} files (pin ${PIN.slice(0, 8)})`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exit(1); });
