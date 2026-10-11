// LIFE + BASES tables and golden vectors for the native realm-map port (GLOBE-NATIVE-PLAN §7, N3 lane NL).
//
//   node tools/world-lifebases.mjs --source <SHARDKEEP-globe repo>           write the tables and the goldens
//   node tools/world-lifebases.mjs --source <SHARDKEEP-globe repo> --check   regenerate in memory and byte-compare (drift fails)
//
// Every value comes from the web modules at the shader pin (world-shaders.lock.json): scatter.js (LIFE placement),
// life.js (its layer sizes), decor.js (level decor, paths between kingdoms), bases.js (marker look, shield caps, the
// band-rehearsal data), demo-bases.js (the debug fallback population) and packages/shared wallConnect.ts, extracted with
// git archive and imported under Node. Game numbers are NOT written into the tables: the native port reads them from the
// constants catalogue (native CLAUDE.md). The goldens record the pinned values decor.js used, so a catalogue that drifted
// from the pin fails the parity test instead of hiding.
//
// Outputs:
//   main resources  …/realmmap/detail/life/life-tables.json, …/realmmap/detail/bases/decor-tables.json
//                   (presentation tables, key order = the web's insertion order: the runtime iterates some of them)
//   test resources  …/realmmap/detail/life/golden-*.json, …/realmmap/detail/bases/golden-*.json
//                   (sorted keys; big result sets carry a sha256 of a canonical projection plus a readable subset)
//
// Canonical projection (hash suites): a number that is an integer of magnitude < 2^53 is written in decimal (−0 → 0),
// any other number as 'x' + its 16 IEEE-754 hex digits; strings JSON-quoted; arrays '[a,b]'. The Kotlin tests build the
// same string, so a hash matches only when every double is bit-identical.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE, LOCK_FILE, SHARED, extractPinned, moduleLoader } from './world-shaders.mjs';
import { PACK_DIR, pinnedManifest } from './world-debug-content.mjs';
import { serialize } from './world-golden.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const PKG = 'gg/pixelkingdomwars/nativeclient/renderer/realmmap/detail';
export const LIFE_TABLES_OUT = `renderer/src/main/resources/${PKG}/life/life-tables.json`;
export const DECOR_TABLES_OUT = `renderer/src/main/resources/${PKG}/bases/decor-tables.json`;
export const LIFE_GOLDEN_DIR = `renderer/src/test/resources/${PKG}/life`;
export const BASES_GOLDEN_DIR = `renderer/src/test/resources/${PKG}/bases`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** The realms with LIFE tables and kit dressing: contracts.js REALMS_WITH_MAPS at the pin (stage B, D-170: all eight; it
 *  was a hand list of the first five), set by generate() before any suite runs. Order = the pin's (dx0 of the place suite). */
let MAP_REALMS = null;

// ---- canonical projection ---------------------------------------------------------------------------------------------
const f64 = new Float64Array(1), u8 = new Uint8Array(f64.buffer);
export function canonNum(v) {
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 53) return String(v === 0 ? 0 : v);
  f64[0] = v; let s = 'x';
  for (let i = 7; i >= 0; i--) s += u8[i].toString(16).padStart(2, '0');
  return s;
}
export function canon(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return canonNum(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return '[' + Array.from(v, canon).join(',') + ']';
  throw new Error(`canon: unsupported ${typeof v}`);
}
const hashOf = v => sha256(canon(v));

// ---- insertion-order JSON (the tables) -----------------------------------------------------------------------------------
function ordered(v, ind = '') {
  if (v instanceof Set) v = [...v];
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  const i2 = ind + ' ';
  if (Array.isArray(v)) {
    if (v.every(x => x === null || typeof x !== 'object')) return '[' + v.map(x => JSON.stringify(x)).join(',') + ']';
    return '[\n' + v.map(x => i2 + ordered(x, i2)).join(',\n') + '\n' + ind + ']';
  }
  const keys = Object.keys(v).filter(k => v[k] !== undefined);
  if (!keys.length) return '{}';
  return '{\n' + keys.map(k => `${i2}${JSON.stringify(k)}: ${ordered(v[k], i2)}`).join(',\n') + '\n' + ind + '}';
}

// ---- private constants: the statement's own text, evaluated (never retyped) -----------------------------------------------
export function privateConst(src, name, scope = {}) {
  const lines = src.split('\n'), at = lines.findIndex(l => new RegExp(`^const (?:[^;]*,\\s*)?${name}\\s*=`).test(l));
  if (at < 0) throw new Error(`private constant ${name} not found`);
  let stmt = '', depth = 0;
  for (let i = at; i < lines.length; i++) {
    stmt += lines[i] + '\n';
    for (const c of lines[i].replace(/'[^']*'|"[^"]*"/g, '')) { if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; }
    if (depth === 0 && /;\s*(\/\/.*)?$/.test(lines[i])) break;
  }
  const keys = Object.keys(scope);
  const value = new Function(...keys, `${stmt}\nreturn ${name};`)(...keys.map(k => scope[k]));
  return value instanceof Set ? [...value] : value;
}

// ---- deterministic samples ----------------------------------------------------------------------------------------------
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** The synthetic terrain every LIFE/paths golden uses (the Kotlin tests build the same): 8-tile class blocks from
 *  kitHash, and a plot SDF over fixed boxes (only −, abs, max, min: exact in both). */
export const ENV_NOTE = 'classAt(tx, ty) = kitHash((tx >> 3) ^ 81, (ty >> 3) ^ 47) mod 14 (uint32); '
  + 'plotSdf(x, y) = min over plots [px, py, half] of max(|x − px|, |y − py|) − half (tiles; +1e9 with no plot)';
function envOf(common, plots) {
  return {
    classAt: (tx, ty) => common.kitHash((tx >> 3) ^ 81, (ty >> 3) ^ 47) % 14,
    plotSdf: (x, y) => { let m = 1e9; for (const [px, py, h] of plots) m = Math.min(m, Math.max(Math.abs(x - px), Math.abs(y - py)) - h); return m; },
  };
}
/** Plots for a window around deed (dx0, dy0): a 3×3 block of deeds, every other one claimed. */
function plotsNear(dx0, dy0) {
  const out = [];
  for (let j = -1; j <= 2; j++) for (let i = -1; i <= 2; i++) if (((i + j) & 1) === 0) out.push([(dx0 + i) * 98 + 49 + ((i * 7 + j * 3) % 11), (dy0 + j) * 98 + 49 + ((i * 5 - j * 4) % 9), 14 + ((i + 2 * j) & 7)]);
  return out;
}

// ---- LIFE: lookups built from the pinned pack (stub values the Kotlin test rebuilds from the golden) ---------------------
function lifeStubs(meta, fx) {
  const S = meta.sprites?.rects ?? {}, sprites = [], creatures = [], norm = id => String(id).replace(/-/g, '_');
  for (const [id, r] of Object.entries(S)) sprites.push([norm(id), r.ink?.length === 4 ? r.ink[3] - r.ink[1] : r.h, r.w, r.h, r.ax ?? r.w / 2, r.ay ?? r.h, Math.max(1, r.frames ?? 1), r.frameMs ?? r.ms ?? 120]);
  for (const [id, r] of Object.entries(meta.map?.objects ?? {})) sprites.push([norm(id), r.h * 7, r.w * 7, r.h * 7, 0, 0, 1, 1000]);
  for (const [id, r] of Object.entries(fx?.sprites ?? fx?.rects ?? {})) sprites.push([norm(id), Math.max(r.h, r.w), r.w, r.h, r.ax ?? r.w / 2, r.ay ?? r.h / 2, Math.max(1, r.frames ?? 1), r.frameMs ?? 160]);
  for (const c of meta.creatures?.list ?? []) creatures.push([norm(c.id), (c.fh ?? 64) - 20, c.frames ?? 6, c.frameMs ?? 120, c.speed ?? 20, c.dwellMs ?? 1500, c.directions ?? 4, c.kind === 'water' ? 'water' : 'ground']);
  // lifeTable's meta: landmark kinds and map-object roles, in the pack's own order
  const landmarks = Object.entries(S).filter(([, r]) => r.kind === 'landmark').map(([id]) => id);
  const objects = Object.entries(meta.map?.objects ?? {}).map(([id, r]) => [id, r.role ?? null]);
  return { sprites, creatures, landmarks, objects };
}
function lookupOf(stubs) {
  const sp = new Map(stubs.sprites.map(([id, inkH, w, h, ax, ay, frames, frameMs]) => [id, { inkH, w, h, ax, ay, frames, frameMs }]));
  const cr = new Map(stubs.creatures.map(([id, inkH, frames, frameMs, speed, dwellMs, directions, kind]) => [id, { inkH, frames, frameMs, speed, dwellMs, directions, kind }]));
  const norm = id => String(id).replace(/-/g, '_');
  return { sprite: id => sp.get(norm(id)) ?? null, creature: id => cr.get(norm(id)) ?? null };
}
const metaOf = stubs => ({ sprites: { rects: Object.fromEntries(stubs.landmarks.map(id => [id, { kind: 'landmark' }])) },
  map: { objects: Object.fromEntries(stubs.objects.map(([id, role]) => [id, role == null ? {} : { role }])) } });

const projSpecies = s => [s.id, s.w, s.on, s.coast ? 1 : 0, s.emit ? [s.emit.fx, s.emit.dx ?? 0, s.emit.dy ?? 0, s.emit.rise ?? 0, s.emit.puffs ?? 0] : null, s.cum, s.footR,
  s.glow ?? null]; // stage B: a map object's lens glow anchor [x, y] in its map canvas (scatter.js lifeTable, table.glow)
const projMod = m => (m ? [m.id, m.salt, m.lo, m.k, m.out, m.inn, m.edge] : null);
function projCompiled(L) {
  return {
    realm: L.realm, wind: L.wind, missing: L.missing,
    fields: [[L.fields.veg.id, L.fields.veg.salt, L.fields.veg.lo, L.fields.veg.k], [L.fields.rock.id, L.fields.rock.salt, L.fields.rock.lo, L.fields.rock.k]],
    groups: L.groups.map(g => ({ id: g.id, kind: g.kind, salt: g.salt, pitch: g.pitch, pitchArt: g.pitchArt, jitterArt: g.jitterArt, density: g.density,
      species: g.species.map(projSpecies), missing: g.missing, flags: [g.twin, g.sway, g.mapOnly, g.trueOnly].map(b => (b ? 1 : 0)), mod: projMod(g.mod), cluster8: g.cluster8,
      maxInkH: g.maxInkH, minInkH: g.minInkH === Infinity ? 'Infinity' : g.minInkH, maxExtent: g.maxExtent })),
    stands: L.stands ? { salt: L.stands.salt, pitch: L.stands.pitch, pitchArt: L.stands.pitchArt, jitterArt: L.stands.jitterArt, species: L.stands.species.map(s => s.id),
      mixes: L.stands.mixes.map(m => [m.id, m.index, m.field.id, m.density, m.sway ? 1 : 0, m.mapOnly ? 1 : 0]),
      variants: L.stands.variants.map(v => [v.mix, v.R4, v.inkH, v.footDy, v.members.map(m => [m.dx, m.dy, m.s, m.flip])]), missing: L.stands.missing,
      maxInkH: L.stands.maxInkH, minInkH: L.stands.minInkH, mergeUntil: L.stands.mergeUntil, memberInkMin: L.stands.memberInkMin } : null,
    creatures: L.creatures ? { salt: L.creatures.salt, pitch: L.creatures.pitch, pitchArt: L.creatures.pitchArt, jitterArt: L.creatures.jitterArt, density: L.creatures.density,
      species: L.creatures.species.map(s => [s.id, s.w, s.herdMin, s.herdMax, s.on, s.cum]), missing: L.creatures.missing, maxInkH: L.creatures.maxInkH } : null,
    birds: L.birds ? { salt: L.birds.salt, pitch: L.birds.pitch, pitchArt: L.birds.pitchArt, jitterArt: L.birds.jitterArt, p16: L.birds.p16,
      species: L.birds.species.map(s => [s.id, s.w, s.fMin, s.fMax, s.on, s.speed, s.alt, s.cum]) } : null,
    ambience: L.ambience.map(a => [a.id, a.kind, a.salt, a.pitchArt, a.jitterArt, a.density, a.lifeMs, a.alt ?? null, a.windK ?? null, a.rise ? 1 : 0, a.minD ?? null, a.shared ? 1 : 0]),
  };
}

function lifeCompileSuite(M, packs) {
  const S = M.scatter, realms = {};
  for (const id of MAP_REALMS) {
    const p = packs.get(id), stubs = lifeStubs(p.meta, p.fx), look = lookupOf(stubs), meta = metaOf(stubs);
    const table = S.lifeTable(id, meta), L = S.compileLife(id, table, look);
    realms[id] = { stubs, compiled: projCompiled(L), canopy: S.withCanopy(table).mixes.map(m => m.id) };
  }
  return { tolerance: 'exact', note: 'stubs.sprites rows [id, inkH, w, h, ax, ay, frames, frameMs]; stubs.creatures rows [id, inkH, frames, frameMs, speed, dwellMs, directions, kind]; '
    + 'lifeTable meta = { sprites.rects: landmarks → {kind: landmark}, map.objects: [id, role] }', realms };
}

function compiledFor(M, packs, id) {
  const S = M.scatter, p = packs.get(id), stubs = lifeStubs(p.meta, p.fx);
  return S.compileLife(id, S.lifeTable(id, metaOf(stubs)), lookupOf(stubs));
}

function lifePlaceSuite(M, packs) {
  const S = M.scatter, C = M.common, realms = {};
  for (const id of MAP_REALMS) {
    const L = compiledFor(M, packs, id), dx0 = 11 + MAP_REALMS.indexOf(id) * 3, dy0 = 9, plots = plotsNear(dx0, dy0), env = envOf(C, plots);
    const art = 3136, rect = (w, h) => ({ x0: dx0 * art, y0: dy0 * art, x1: dx0 * art + w, y1: dy0 * art + h });
    const cellsOf = (pitchArt, r) => { const win = S.latticeWindow(pitchArt, r, 0); const out = []; for (let j = 0; j < win.ny; j++) for (let i = 0; i < win.nx; i++) out.push([win.ix0 + i, win.iy0 + j]); return out; };
    const groups = L.groups.map(g => {
      const rowsSmall = [], all = [];
      const small = rect(1568, 1568), big = rect(3 * art, 3 * art);
      for (const [ix, iy] of cellsOf(g.pitchArt, big)) {
        const r = S.scatterInstance(g, ix, iy, env), row = r ? [ix, iy, r.x, r.y, r.cls, r.species, r.flip, r.phase, r.h2, r.rank] : [ix, iy];
        all.push(row);
        if (ix * g.pitchArt < small.x1 && iy * g.pitchArt < small.y1 && ix * g.pitchArt >= small.x0 && iy * g.pitchArt >= small.y0 && r) rowsSmall.push(row);
      }
      const found = all.filter(r => r.length > 2).slice(0, 40).map(r => ({ ix: r[0], iy: r[1], species: r[5], h2: r[8], rank: r[9] }));
      const lods = found.map(f => [0.7, 30, 60, 200, 260, 300, 400, 800, 900, 1000, 1100, 3000].map(d => {
        const w = S.bandWeights(d); return [S.instanceLod(g, f, d, w.true, w.twins), S.instanceLod(g, f, d, w.true, w.twins, 0.37)];
      }));
      const sway = found.slice(0, 12).map(f => [0, 999, 123456, 7654321].map(ms => [S.swayArt({ h2: f.h2, phase: (f.h2 >>> 17) & 0x7fff }, ms, 2500, false), S.clipFrame({ phase: (f.h2 >>> 17) & 0x7fff }, ms, 8, 110, false)]));
      return { id: g.id, cells: all.length, hash: hashOf(all), rows: rowsSmall, lods, sway };
    });
    const St = L.stands, stands = St ? (() => {
      const sites = [], members = [], merged = [];
      for (const [ix, iy] of cellsOf(St.pitchArt, rect(3 * art, 3 * art))) {
        const s = S.standSite(St, ix, iy, env);
        sites.push(s ? [ix, iy, s.x, s.y, s.cls, s.v, s.mix, s.flip, s.h2, s.sdf, s.rank] : [ix, iy]);
        if (s && members.length < 400) for (let m = 0; m < 16; m++) { const mm = S.standMember(St, s, m, env); members.push(mm ? [ix, iy, m, mm.x, mm.y, mm.species, mm.flip] : [ix, iy, m]); }
      }
      for (let by = Math.floor(dy0 * 98 / 16) - 1; by < Math.floor(dy0 * 98 / 16) + 19; by++) for (let bx = Math.floor(dx0 * 98 / 16) - 1; bx < Math.floor(dx0 * 98 / 16) + 19; bx++) {
        const s = S.mergedSite(St, bx, by, env); merged.push(s ? [bx, by, s.x, s.y, s.v] : [bx, by]);
      }
      const lodSites = sites.filter(r => r.length > 2).slice(0, 30).map(r => ({ ix: r[0], iy: r[1], x: r[2], y: r[3], v: r[5], h2: r[8], rank: r[10] }));
      const lods = lodSites.map(s => [30, 60, 150, 180, 210, 400, 800, 950, 1100].map(d => { const w = S.bandWeights(d); return [S.standLod(St, s, d, w.true), S.standLod(St, s, d, w.true, 0.5), S.mergedLod(St, s, d)]; }));
      const sway = lodSites.slice(0, 6).map(s => [0, 1, 7, 15].map(m => S.standSwayArt(s, m, 4321, 2600, false)));
      return { sites: hashOf(sites), siteCount: sites.filter(r => r.length > 2).length, members: hashOf(members), memberRows: members.slice(0, 160), merged: hashOf(merged), mergedRows: merged.filter(r => r.length > 2).slice(0, 40), lods, sway };
    })() : null;
    const Cr = L.creatures, creatures = Cr?.species.length ? (() => {
      const sites = [], members = [];
      for (const [ix, iy] of cellsOf(Cr.pitchArt, rect(4 * art, 4 * art))) {
        const s = S.herdSite(Cr, ix, iy, env);
        sites.push(s ? [ix, iy, s.x, s.y, s.cls, s.species, s.n, s.h2] : [ix, iy]);
        if (s) for (let m = 0; m < 4; m++) {
          const mb = S.herdMember(Cr, s, m, env);
          if (!mb) { members.push([ix, iy, m]); continue; }
          const poses = [0, 1234, 98765, 5555555].map(ms => { const p = S.memberPose(mb, ms, false); return [p.x, p.y, FACING(p.facing), p.dwelling ? 1 : 0, S.poseFrame(p, ms, Cr.species[mb.species].sh.frames, Cr.species[mb.species].sh.frameMs, Cr.species[mb.species].sh.directions)]; });
          members.push([ix, iy, m, mb.phase, mb.path.points.map(p => [p.x, p.y]), poses]);
        }
      }
      return { sites: hashOf(sites), siteCount: sites.filter(r => r.length > 2).length, members: hashOf(members), memberRows: members.slice(0, 60) };
    })() : null;
    const B = L.birds, birds = B?.species.length ? (() => {
      const rows = [];
      for (let iy = Math.floor(dy0 * art / B.pitchArt) - 2; iy < Math.floor(dy0 * art / B.pitchArt) + 30; iy++) for (let ix = Math.floor(dx0 * art / B.pitchArt) - 2; ix < Math.floor(dx0 * art / B.pitchArt) + 30; ix++) {
        const f = S.flockSite(B, ix, iy, env);
        if (!f) { rows.push([ix, iy]); continue; }
        rows.push([ix, iy, f.x, f.y, f.species, f.n, f.radius, f.dir, f.h2, f.rank, [0, 777, 123456].flatMap(ms => [0, 1, f.n - 1].map(m => { const p = S.birdPose(B, f, m, ms); return [p.x, p.y, p.alt, p.flip, p.frame]; }))]);
      }
      return { hash: hashOf(rows), rows: rows.filter(r => r.length > 2).slice(0, 30) };
    })() : null;
    const ambience = L.ambience.map(a => {
      const rows = [];
      for (const [ix, iy] of cellsOf(a.pitchArt, rect(art, art))) for (const ms of [0, 1500, 123457]) {
        const p = S.particle(a, ix, iy, ms, env, L.wind);
        rows.push(p ? [ix, iy, ms, p.x, p.y, p.alt, p.frame, p.fade, p.flip] : [ix, iy, ms]);
      }
      return { id: a.id, hash: hashOf(rows), rows: rows.filter(r => r.length > 3).slice(0, 20), ink: S.ambienceInk(a) };
    });
    realms[id] = { dx0, dy0, plots, groups, stands, creatures, birds, ambience };
  }
  // rank windows and the stand field, realm-free
  const ranks = [];
  for (const salt of [0, 1, 4242, 65535]) for (let iy = -9; iy < 9; iy += 3) for (let ix = -9; ix < 9; ix += 2) { const seat = S.cellSeat({ pitchArt: 56, jitterArt: 47 }, ix, iy, C.pcg2d(ix >>> 0, iy >>> 0)[0]); ranks.push([salt, ix, iy, S.cellRank(salt, ix, iy), seat.x, seat.y]); }
  const slots = []; for (const salt of [3, 999]) for (let by = -2; by < 2; by++) for (let bx = -2; bx < 2; bx++) for (let j = 0; j < 16; j++) slots.push([salt, bx, by, j, ...S.slotCell(salt, bx, by, j)]);
  const draws = [];
  for (const win of [{ ix0: -5, iy0: 3, nx: 17, ny: 9 }, { ix0: 100, iy0: 200, nx: 64, ny: 48 }, { ix0: -1, iy0: -1, nx: 1, ny: 1 }])
    for (const [lo, hi] of [[0, 65536], [0, 0], [0, 12000], [5000, 30000], [30000, 65536], [65535, 65536], [0, 1], [4096, 8192]]) { const r = S.rankDraw(win, lo, hi); draws.push([win.ix0, win.iy0, win.nx, win.ny, lo, hi, r.lo, r.hi, r.count, r.rl ? [r.rl.bx0, r.rl.by0, r.rl.nbx, r.rl.nby, r.rl.j0, r.rl.m] : null]); }
  const field = []; for (const salt of [7, 51234]) for (let y = -300; y < 3000; y += 97) for (let x = -500; x < 5000; x += 211) field.push([salt, x, y, S.valueU8(salt, x, y, 10), S.standField(salt, x, y)]);
  const edges = []; for (let sdf = -3; sdf < 24; sdf += 0.37) edges.push([sdf, S.edgeWeight(sdf, 2), S.edgeWeight(sdf, 4.75)]);
  const mods = []; for (const dens of [0, 1, 5000, 65535]) for (const cover of [0, 100, 256]) for (const edge of [-1, 0, 128, 255]) mods.push([dens, cover, edge, S.modDensity(dens, { out: 179, inn: 614, edge: 768 }, cover, edge)]);
  const hashes = []; for (let i = 0; i < 64; i++) { const a = (i * 2654435761) | 0, b = (i * 40503 - 77777) | 0; hashes.push([a, b, C.kitHash(a, b), ...C.pcg2d(a >>> 0, b >>> 0), S.salt16(`realm:${i}`), S.range16(C.kitHash(a, b), 97)]); }
  const misc = { skyScale: [1, 100, 367, 1100, 5000].map(d => S.skyScale(d)), bigEnough: [[1, 20000], [6, 3136], [5, 3136], [48, 392]].map(([i, d]) => S.bigEnough(i, d) ? 1 : 0),
    minVisibleD: [1, 6, 48, 99].map(i => S.minVisibleD(i)), keepFraction: [[40, 20], [40, 400]].map(([c, e]) => S.keepFraction(c, e)),
    mapKeep: [1, 10, 100, 1000, 10000].map(b => S.mapKeep(b)), thinFactor: [[0, 1, 0.5], [0, 3, 0.5], [1, 3, 0.5], [2, 3, 0.5], [0, 4, 0.9]].map(([p, n, f]) => S.thinFactor(p, n, f)),
    splitWeight: [100, 150, 180, 210, 300].map(d => S.splitWeight(d)), fadeU8: [0, 1, 64, 128, 200, 255].map(S.fadeU8), coverOf: [[100, 104, 1724], [200, 104, 1724], [150, 104, 1724]].map(([v, lo, k]) => S.coverOf(v, lo, k)),
    isqrt: [0, 1, 2, 3, 4, 15, 16, 17, 1e6, 123456789].map(S.isqrt), trueClasses: [599, 600].map(d => (S.trueClasses(d) ? 1 : 0)),
    bandWeights: [0.5, 23, 24, 30, 48, 100, 250, 300, 350, 799, 800, 900, 1100, 1100.0000001, 4000].map(d => { const w = S.bandWeights(d); return [d, w.true, w.twins]; }),
    submittedCap: [[390, 844], [600, 900], [601, 900], [1920, 1080]].map(([W, H]) => S.submittedCap({ W, H })),
    // stage B (69fb02c2): the lens glow's strength, SCATTER_VS's CPU twin; rows [h2, ms, rm, periodMs | null (GLOW.periodMs), glowPulse]
    glowPulse: [0, 1, 0x7fff, 0x20000, 0x7fff0000, 0xffffffff, 2654435761, 123456789].flatMap(h2 => [0, 1, 599, 1200, 2399, 2400, 123457, 4294967295, 9e15]
      .flatMap(ms => [[h2, ms, 0, null, S.glowPulse(h2, ms, false)], [h2, ms, 1, null, S.glowPulse(h2, ms, true)], [h2, ms, 0, 1000, S.glowPulse(h2, ms, false, 1000)]])) };
  return { tolerance: 'exact (hash = sha256 of the canonical projection, see tools/world-lifebases.mjs)', env: ENV_NOTE,
    rowNote: 'scatter rows [ix, iy, x, y, cls, species, flip, phase, h2, rank] ([ix, iy] = none); stands sites [ix, iy, x, y, cls, v, mix, flip, h2, sdf, rank]; '
      + 'members [ix, iy, m, x, y, species, flip]; merged [bx, by, x, y, v]; herd sites [ix, iy, x, y, cls, species, n, h2]; herd members [ix, iy, m, phase, points, poses[ms 0,1234,98765,5555555] = [x, y, facing(0 down 1 left 2 right 3 up), dwelling, frame]]; '
      + 'birds [ix, iy, x, y, species, n, radius, dir, h2, rank, poses (ms 0,777,123456 × m 0,1,n−1) [x, y, alt, flip, frame]]; particles [ix, iy, ms, x, y, alt, frame, fade, flip]',
    realms, ranks, slots, draws, field, edges, mods, hashes, misc };
}
const FACING = f => ['down', 'left', 'right', 'up'].indexOf(f);

// planDraws: the §9 ceiling, rank windows and every stream, per realm × view
export const PLAN_VIEWPORTS = [['seeker-2.625', 1200 / 2.625, 2670 / 2.625, 2], ['seeker-2.75-land', 2670 / 2.75, 1200 / 2.75, 2], ['phone-390-dpr3', 390, 844, 2], ['desktop', 1920, 1080, 2], ['desktop-dpr1', 1440, 900, 1]];
export const PLAN_D = [20, 24, 30, 48, 55, 60, 100, 150, 180, 200, 210, 240, 250, 280, 300, 330, 350, 400, 599, 600, 700, 799, 800, 820, 900, 1000, 1099, 1100, 1300, 1800, 2000, 2600, 3136, 4704, 6272];
const projRange = r => (r ? [r.lo, r.hi, r.count, r.rl ? [r.rl.bx0, r.rl.by0, r.rl.nbx, r.rl.nby, r.rl.j0, r.rl.m] : null] : null);
const projWin = e => [e.ix0, e.iy0, e.nx, e.ny, e.stride ?? 1];
function projPlan(p) {
  return {
    total: p.total, cap: p.cap ?? null, trueOn: p.trueOn === undefined ? null : p.trueOn ? 1 : 0, trueClasses: p.trueClasses ? 1 : 0,
    tau: p.thin?.tau ?? null, model: p.thin?.model ?? null,
    groups: p.groups.map(pg => [pg.g.id, projWin(pg), pg.keep, pg.kitK, pg.twK, pg.truHi ?? null, pg.keepHi ?? null, pg.twinHi ?? null, projRange(pg.kit), projRange(pg.tw), pg.count]),
    stands: p.stands ? [projWin(p.stands), p.stands.sites, p.stands.keep, p.stands.truHi, p.stands.keepHi, projRange(p.stands.mem), projRange(p.stands.clu), p.stands.members, p.stands.clumps, p.stands.merged,
      p.stands.mergedWin ? projWin(p.stands.mergedWin) : null] : null,
    creatures: p.creatures ? [projWin(p.creatures), p.creatures.count, p.creatures.keep, p.creatures.cap] : null,
    birds: p.birds ? [projWin(p.birds), p.birds.count, p.birds.keep, p.birds.scale] : null,
    ambience: p.ambience.map(e => [e.a.id, projWin(e), e.count, e.keep]),
  };
}
/** The hashed form of projPlan: the DISCRETE values in a fixed field order (objects → arrays), every float that V8's
 *  Math.pow reaches (the §9 thinning: keep fractions, tau, the model; birds' sky scale) replaced by null. V8's pow is not
 *  fdlibm (1 ulp apart on ~4 % of inputs, measured against Java StrictMath), so those floats are compared separately with
 *  a relative tolerance (`floats`), while windows, rank bounds and counts stay exact. */
const projFlat = p => [p.total, p.cap, p.trueOn, p.trueClasses, null, null,
  p.groups.map(g => [g[0], g[1], null, ...g.slice(3)]), p.stands ? [p.stands[0], p.stands[1], null, ...p.stands.slice(3)] : null,
  p.creatures ? [p.creatures[0], p.creatures[1], null, p.creatures[3]] : null, p.birds ? [p.birds[0], p.birds[1], null, null] : null,
  p.ambience.map(e => [e[0], e[1], e[2], null])];
const planFloats = p => [...(p.tau ?? []), ...(p.model == null ? [] : [p.model]), ...p.groups.map(g => g[2]), ...(p.stands ? [p.stands[2]] : []),
  ...(p.creatures ? [p.creatures[2]] : []), ...(p.birds ? [p.birds[2], p.birds[3]] : []), ...p.ambience.map(e => e[3])];
function lifePlanSuite(M, packs) {
  const S = M.scatter, realms = {};
  // life.js `submitCounts` shapes (arrays per stream): with them the multiplicities differ, so both paths are pinned
  const SUBMIT = { kit: 2, kitMap: 1, twin: 1, puffs: 3 };
  for (const id of MAP_REALMS) {
    const views = [];
    for (const withSubmit of [false, true]) {
      const L = compiledFor(M, packs, id);
      if (withSubmit) { for (const g of L.groups) g.submit = { ...SUBMIT, twin: g.twin ? 1 : 0, puffs: g.species.some(s => s.emit) ? 3 : 0 }; if (L.stands) L.stands.submit = { members: 3, clumps: 1 }; if (L.birds) L.birds.submit = 2; }
      const cols = packs.get(id).meta.grid.cols, rows = packs.get(id).meta.grid.rows;
      L.bounds = { x0: 0, y0: 0, x1: cols * 3136, y1: rows * 3136 };
      for (const [vp, W, H, dpr] of PLAN_VIEWPORTS) for (const d of PLAN_D) for (const [x, y, rm] of [[cols * 0.43, rows * 0.51, false], [0.2, rows - 0.3, false], [cols * 0.6 + 0.37, rows * 0.3 + 0.11, true]]) {
        const p = S.planDraws(L, { x, y, d, W, H, dpr, rm, bounds: L.bounds }), proj = projPlan(p);
        // every view by hash; the readable projection for one viewport at the first pan (both submit shapes)
        views.push([withSubmit ? 1 : 0, vp, d, x, y, rm ? 1 : 0, W, H, dpr, p.total, hashOf(projFlat(proj)), planFloats(proj), vp === 'seeker-2.625' && x === cols * 0.43 ? proj : null]);
      }
    }
    realms[id] = { cols: packs.get(id).meta.grid.cols, rows: packs.get(id).meta.grid.rows, views };
  }
  return { tolerance: 'discrete exact; pow-derived floats relative 1e-12 (V8 Math.pow is not fdlibm)', submitStub: SUBMIT, note: 'submit = 1: groups carry {kit 2, kitMap 1, twin (1 twin groups), puffs (3 with an emitter)}, stands {members 3, clumps 1}, birds 2 (life.js submitCounts shapes). '
    + 'views rows [submit, viewport, d, x, y, rm, W, H, dpr, total, hash, floats, projection | null]; hash = canonical sha256 of the discrete projection '
    + '[total, cap, trueOn, trueClasses, null, null, groups, stands, creatures, birds, ambience] with every pow-derived float nulled; floats = [tau…, model, '
    + 'group keeps…, stands keep, creatures keep, birds keep, birds scale, ambience keeps…] (present ones), compared with a relative tolerance; '
    + 'groups rows [id, [ix0,iy0,nx,ny,stride], keep, kitK, twK, truHi, keepHi, twinHi, kit [lo,hi,count,rl], tw, count]; stands [win, sites, keep, truHi, keepHi, mem, clu, members, clumps, merged, mergedWin]; '
    + 'creatures [win, count, keep, cap]; birds [win, count, keep, scale]; ambience [id, win, count, keep]', realms };
}

// ---- LIFE pixel work (life.js private functions are exported only as reduceMap; the rest are replicated from the pinned
// text by evaluating their source, never retyped) ---------------------------------------------------------------------------
function lifePrivateFns(src) {
  const grab = name => { const i = src.indexOf(`function ${name}(`); if (i < 0) throw new Error(`life.js: no function ${name}`); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error(name); };
  const body = ['copyFrame', 'inkRows', 'bleed', 'reduce2'].map(grab).join('\n');
  return new Function(`${body}\nreturn { copyFrame, inkRows, bleed, reduce2 };`)();
}
function synthImage(w, h, seed) {
  const r = rng(seed), data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, inside = ((x - w / 2) ** 2) / ((w / 2.2) ** 2) + ((y - h * 0.6) ** 2) / ((h / 2.6) ** 2) < 1;
    const pal = [[30, 20, 15], [70, 110, 40], [90, 140, 50], [120, 170, 70], [200, 190, 120], [10, 10, 10]][Math.floor(r() * 6)];
    data[i] = pal[0]; data[i + 1] = pal[1]; data[i + 2] = pal[2]; data[i + 3] = inside ? (r() < 0.9 ? 255 : 90) : (r() < 0.05 ? 200 : Math.floor(r() * 100));
  }
  return { data, width: w, height: h };
}
function lifePixelsSuite(M, lifeSrc) {
  const F = lifePrivateFns(lifeSrc), out = [];
  for (const [w, h, seed, LW, LH] of [[16, 20, 1, 32, 32], [40, 60, 2, 64, 64], [64, 64, 3, 64, 64], [150, 120, 4, 160, 128], [7, 5, 5, 16, 16]]) {
    const img = synthImage(w + 6, h + 4, seed), ox = Math.floor((LW - w) / 2), oy = LH - h;
    const px = F.copyFrame(img, 3, 2, w, h, LW, LH, ox, oy), ink = F.inkRows(px, LW, LH), bl = F.bleed(px.slice(), LW, LH);
    const chain = []; let m = { px: bl, w: LW, h: LH }; for (let l = 0; l < 8 && (m.w > 1 || m.h > 1); l++) { m = F.reduce2(m.px, m.w, m.h); chain.push([m.w, m.h, sha256(Buffer.from(m.px))]); }
    const map = M.life.reduceMap({ img, x: 3, y: 2, w, h, ax: w / 2, ay: h });
    out.push({ w, h, seed, LW, LH, image: sha256(Buffer.from(img.data)), frame: sha256(Buffer.from(px)), ink, bleed: sha256(Buffer.from(bl)), chain,
      reduceMap: [map.w, map.h, map.ax, map.ay, sha256(Buffer.from(map.img.data))] });
  }
  return { tolerance: 'exact', note: 'synthImage(w+6, h+4, seed) (mulberry32 palette, see generator); copyFrame(img, 3, 2, w, h, LW, LH, (LW−w)>>1, LH−h); chain = reduce2 levels', cases: out };
}

// ---- LIFE table texels: the pinned life.js load() on a fake core over the real pack ----------------------------------------
/**
 * createLife(fakeCore).load(pack, shared) runs as in the browser (its sprite packing, twins, map objects, stands, buildTable)
 * over the pinned pack's sprite / creature / map atlases and the shared fx (PNG: the pinned loader.js decodePng is exact).
 * The fake core records the one RGBA16UI table upload: its sha256 (little-endian uint16) pins every texel, the glow rows
 * (flag bit 4 in T0.z >> 4, T4 = [anchor x, anchor y, GLOW.radiusMap, GLOW.periodMs]) are written out readable.
 */
async function lifeTableSuite(M, repo, read, SPT) {
  const realms = {}, sharedFx = JSON.parse(read('realm/shared/fx.json').toString('utf8'));
  const decode = async (rel, sharp) => { const b = new Uint8Array(read(rel)); if (rel.endsWith('.png')) return M.loader.decodePng(b, { sliceMs: 1e9 });
    const r = await sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { width: r.info.width, height: r.info.height, data: new Uint8Array(r.data) }; };
  const sharp = createRequire(path.join(repo, 'scripts/package.json'))('sharp');
  const TX = { TEXTURE_2D_ARRAY: 0x8c1a, TEXTURE_MIN_FILTER: 0x2801, LINEAR_MIPMAP_NEAREST: 0x2701 };
  for (const id of MAP_REALMS) {
    const meta = JSON.parse(read(`realm/${id}/realm.json`).toString('utf8'));
    let upload = null;
    const gl = { ...TX, bindTexture() {}, texParameteri() {}, bindVertexArray() {}, drawArraysInstanced() {} };
    const core = { gl, include() {}, program: name => ({ name, ready: true }), animating() {}, quadVao: null,
      tex: { array: (w, h, n) => ({ t: {}, w, h, layers: n, bytes: 0 }), layer() {}, free() {},
        data: (w, h, fmt, a, b, data) => { if (fmt === 'RGBA16UI') upload = { w, h, data: Uint16Array.from(data) }; return { t: {}, w, h, bytes: 0 }; } } };
    const life = M.life.createLife(core, null);
    const pack = { id, meta, pixels: k => decode(`realm/${id}/${k}`, sharp), json: async k => { throw Object.assign(new Error('404 ' + k), { status: 404 }); } };
    const shared = { json: async k => { if (k === 'fx.json') return sharedFx; throw Object.assign(new Error('404 ' + k), { status: 404 }); }, pixels: k => decode(`realm/shared/${k}`, sharp) };
    await life.load(pack, shared);
    const st = life.stats(), dbg = life.debug();
    if (!st.ready || !upload) throw new Error(`${id}: life.js load did not build its table (${st.why})`);
    const { L } = dbg, W = upload.w, texel = (r, x) => Array.from(upload.data.subarray((r * W + x) * 4, (r * W + x) * 4 + 4));
    const glow = [];
    for (const g of L.groups) g.species.forEach((sp, i) => { const t0 = texel(g.row, i * SPT); if ((t0[2] >> 4) & 4) glow.push([g.id, g.row, i, sp.id, t0, texel(g.row, i * SPT + 4), texel(g.row, i * SPT + 5)]); });
    const bytes = Buffer.from(upload.data.buffer, upload.data.byteOffset, upload.data.byteLength);
    realms[id] = { tableW: W, rows: upload.h, sha256: sha256(bytes), groups: L.groups.map(g => [g.id, g.row, g.species.length, g.hasGlow ? 1 : 0, g.hasTwins ? 1 : 0, g.hasEmit ? 1 : 0]),
      glow, missing: [...st.missing].sort(), darkTwinsReplaced: [...(st.darkTwinsReplaced ?? [])].sort(), arrays: dbg.arrays.map(a => [a.key, a.LW, a.LH, a.layers ?? 0]) };
  }
  return { tolerance: 'exact', note: 'per realm: the life.js species/density table (RGBA16UI, tableW × rows texels) as uploaded, sha256 over its uint16 little-endian bytes; '
    + 'groups rows [id, table row, species, hasGlow, hasTwins, hasEmit]; glow rows [group, row, species index, species id, T0, T4, T5] for every species with flag bit 4 '
    + '(T0.z >> 4 & 4): T4 = [glow x + twin ox, glow y + twin oy, GLOW.radiusMap, GLOW.periodMs]; arrays [key, LW, LH, layers]', realms };
}

// ---- DECOR --------------------------------------------------------------------------------------------------------------
const projSprite = s => [s.key, s.atlas, s.kind, s.role ?? null, s.fam ?? null, s.fx, s.fy, s.fp, s.tx, s.ty, s.z, s.anchor, s.scale, s.cell, s.ink, s.rows, s.clip ? [s.clip.frames, s.clip.ms] : null, s.flipX ? 1 : 0, s.phase];
function projDecor(D, M) {
  const G = D.geometry;
  return [D.level, D.realmId, D.formation, D.seed,
    [G.S, G.A, G.B, G.ring, G.P0, G.P1, G.o0, G.o1, G.doubled ? 1 : 0, G.wIn, G.wInHi, G.citadel, G.court, G.wallRings, G.wallTier, G.lanes, G.keep],
    [D.claim.x0, D.claim.y0, D.claim.x1, D.claim.y1, D.claim.S], [D.plot.x0, D.plot.y0, D.plot.x1, D.plot.y1, D.plot.ring],
    [D.keep.key, D.keep.tx, D.keep.ty, D.keep.z, D.keep.anchor, D.keep.scale, D.keep.cell, D.keep.ink, D.keep.fp, D.keep.fx, D.keep.fy],
    D.walls.map(w => [w.tier, w.x, w.y, w.piece, w.ring]),
    D.sprites.map(projSprite),
    D.emitters.map(e => [e.kind, e.attach ?? null, e.tx, e.ty, e.dx, e.dy, e.r ?? null, e.a ?? null]),
    D.omitted, D.edges.map(e => [e.style, e.x, e.y, e.piece, e.mask, e.loop]),
    D.ground.map(g => [g.x, g.y, g.k, g.t, g.p]),
    ['N', 'S', 'W', 'E'].map(s => D.lanes[s] ?? null), ['N', 'S', 'W', 'E'].map(s => D.laneEnds[s] ?? null), D.gates,
    D.patches.map(p => [p.kind, p.seg, p.cells, p.crop ?? null, p.hedged === undefined ? null : p.hedged ? 1 : 0]),
    M.decor.edgeSprites(D).map(projSprite), M.decor.edgeAutotileSprites(D).map(projSprite), M.decor.wallSprites(D).map(projSprite)];
}
export const DECOR_SEEDS = [0, 1, 2, 3, 99, 7331, 123456789, 0xdeadbeef];
export const DECOR_GATES = [[], ['S'], ['N', 'E'], ['N', 'S', 'W', 'E']];
function decorSuite(M, pinnedGame) {
  const D = M.decor, results = [], full = [];
  for (const realm of MAP_REALMS) for (let L = 1; L <= 20; L++) for (const seed of DECOR_SEEDS) for (const gates of DECOR_GATES) {
    let v;
    try { v = projDecor(D.composeBaseDecor({ level: L, realmId: realm, seed, gates }), M); } catch (e) { v = ['throw', String(e.message)]; }
    results.push([realm, L, seed, gates.join(''), hashOf(v), v[0] === 'throw' ? v[1] : v[9].length]);
    if (seed === 1 && gates.join('') === 'S' && ((realm === 'crownlands' && [1, 9, 20].includes(L)) || (realm === 'cinderfall' && L === 13))) full.push({ realm, level: L, seed, gates, projection: v });
  }
  const geometry = Array.from({ length: 20 }, (_, i) => { const g = D.plotGeometry(i + 1); return [g.level, g.S, g.A, g.B, g.ring, g.P0, g.P1, g.o0, g.o1, g.doubled ? 1 : 0, g.wIn, g.wInHi, g.citadel, g.court, g.wallRings, g.wallTier]; });
  const keep = Array.from({ length: 20 }, (_, i) => { const L = i + 1, e = D.keepExtents(L), r = D.keepInkRect(L, 1.5);
    return [L, D.kFit(L), [e.left, e.right, e.up, e.down, e.w, e.h], [r.x0, r.x1, r.y0, r.y1], [100, 200, 280, 281, 400, 799, 1000, 1099, 1100, 3000].map(d => D.keepScale(L, d)), D.decorBand(L)]; });
  const ladder = []; for (let L = 1; L <= 20; L++) for (const seed of [0, 5, 77, 123456, 0xffffffff]) ladder.push([L, seed, D.fieldCount(L, seed), D.ringWants(L, seed), D.mainGate(seed)]);
  const hashes = []; for (let i = 0; i < 40; i++) { const a = (i * 2246822519) | 0, b = (i * 3266489917 + 12345) | 0; hashes.push([a, b, D.hash2(a, b)]); }
  const seeds = [0, 1, 7331, -5, 3.7, 2 ** 31, 'abc', 'kingdom-42', '', '1234', 'Ünïcode'].map(id => [typeof id === 'number' ? id : `s:${id}`, D.seedOf(id)]);
  const caps = {}; for (const fam of ['archer', 'cannon', 'mortar', 'airdefence', 'electrictower', 'magetower', 'lasertower', 'dragonnest', 'vault', 'camp', 'barracks', 'mine', 'goldforge', 'clanhall', 'heroaltar', 'siegestool', 'alchemylab'])
    caps[fam] = Array.from({ length: 20 }, (_, i) => [D.decorCountCap(fam, i + 1), M.contracts.decorCap(fam, i + 1)]);
  const scales = Object.fromEntries(['keep', 'archer', 'cannon', 'mortar', 'airdefence', 'electrictower', 'magetower', 'lasertower', 'dragonnest', 'vault', 'mine', 'barracks', 'camp', 'clanhall', 'alchemylab', 'goldforge', 'heroaltar', 'siegestool']
    .map(f => [f, [D.decorScaleOf(f), D.decorFootprintOf(f)]]));
  return { tolerance: 'exact (hash = sha256 of the canonical projection of composeBaseDecor + edgeSprites + edgeAutotileSprites + wallSprites)', pinnedGame,
    columns: 'results rows [realm, level, seed, gates, hash, sprite count | throw message]', seeds: DECOR_SEEDS, gates: DECOR_GATES, results, full, geometry, keep, ladder, hashes, seedOf: seeds, caps, scales };
}

// ---- BASES (pure parts) and PATHS ----------------------------------------------------------------------------------------
function basesSuite(M) {
  const B = M.bases, out = {};
  const grid = []; for (const s of [10, 23.9, 24, 30, 36, 47.9, 48, 60]) for (const d of [20, 199, 200, 230, 279.9, 280, 900]) for (const [a, b] of [[0, 0], [0.3, 0.7], [0.99, 0.01], [0.5, 0.5]]) grid.push([s, d, a, b, B.baseMode(s, d, a, b)]);
  out.baseMode = grid;
  out.iconLook = []; for (let L = 1; L <= 20; L++) for (const seed of [0, 1, 99, 4000000000, 123456]) { const k = B.iconLook(L, seed); out.iconLook.push([L, seed, k.css, k.tips, k.towers, k.tower, k.first]); }
  const r = rng(99), list = Array.from({ length: 70 }, (_, i) => ({ b: { id: i, mine: i === 13 || i === 50 }, dist: Math.floor(r() * 40) / 4 }));
  out.capShields = [0, 1, 2].map(lod => B.capShields(list, lod).map(e => e.b.id));
  const rects = Array.from({ length: 30 }, (_, i) => ({ b: { id: i }, x0: (i % 6) * 40, x1: (i % 6) * 40 + 60, y0: Math.floor(i / 6) * 30, y1: Math.floor(i / 6) * 30 + 50, depth: (i * 37) % 11 }));
  const domes = Array.from({ length: 8 }, (_, i) => ({ b: { id: 100 + i }, sx: 300 + i * 25, sy: 200 + (i % 3) * 20, rx: 30, ry: 16 }));
  out.pickBase = []; for (let y = -5; y < 260; y += 13) for (let x = -5; x < 520; x += 17) { const p = B.pickBase(rects, domes, x, y); out.pickBase.push(p ? p.id : -1); }
  let t = 0; const w = B.frameWork(4, () => t), trace = [];
  w.begin(); for (let i = 0; i < 12; i++) { trace.push(w.more() ? 1 : 0); if (i % 3 === 0) w.spend(); t += 1.1; }
  out.frameWork = trace;
  // stage B (090b3428): the marker icon's anchor (plot-local y, tiles) by d and the icon ink's vertical middle (tiles, < 0 above)
  out.iconCentreD = [...B.ICON_CENTRE_D];
  out.iconAnchorY = [];
  for (const d of [20, 48, 100, 149.9, 150, 150.0000001, 160, 175, 190, 199.9, 200, 200.1, 280, 1100]) for (const inkMid of [0, -0.25, -0.5, -0.8, -1.3, 0.2]) out.iconAnchorY.push([d, inkMid, B.iconAnchorY(d, inkMid)]);
  // reduceMode (exported) over the synthetic images, the MAP mini factor and the icon's 2×
  out.reduceMode = [];
  for (const [w0, h0, seed] of [[64, 64, 11], [96, 88, 12], [144, 136, 13], [32, 48, 14]]) {
    const img = synthImage(w0, h0, seed), px = new Uint8Array(img.data);
    for (const [f, dark] of [[2, 1], [7, 0.35], [1 / (0.03125 * 448 / 98), 0.35], [1 / (0.075 * 448 / 98), 1], [3.3, 1]]) {
      const res = B.reduceMode(px, w0, h0, f, undefined, undefined, dark);
      out.reduceMode.push([w0, h0, seed, f, dark, res.w, res.h, sha256(Buffer.from(res.px))]);
    }
  }
  return { tolerance: 'exact', note: 'capShields: 70 entries {id i, mine i∈{13,50}, dist floor(mulberry32(99)·40)/4}; pickBase: rects/domes of the generator, points x −5..519 step 17, y −5..259 step 13; '
    + 'frameWork(4 ms) on a fake clock +1.1 ms per call, spend on every 3rd; reduceMode rows [w, h, seed, f, darkW, ow, oh, sha256]; iconAnchorY rows [d, inkMid, iconAnchorY(d, inkMid)] '
    + '(log/pow: relative 1e-12)', ...out };
}

async function demoAndPathsSuites(M, packs) {
  const demo = {}, paths = {};
  for (const [id, p] of [...packs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const bases = M.demo_bases.demoBases(p.meta, p.deeds);
    const proj = bases.map(b => [b.id, b.x, b.y, b.level, b.name, b.avatar, b.trophies, b.clan, b.mine ? 1 : 0, b.shield ? 1 : 0, b.attackable ? 1 : 0]);
    const ladder = M.demo_bases.ladderBases(bases.map(b => ({ ...b })), p.meta, p.deeds).map(b => [b.id, b.x, b.y, b.level, b.shield ? 1 : 0, b.attackable ? 1 : 0]);
    // the pinned pack's deeds mask (R channel, run-length [value, count, …]) so the parity test needs no gitignored bundle
    const rle = []; for (let i = 0; i < p.meta.grid.cols * p.meta.grid.rows; i++) { const v = p.deeds[i * 4]; if (rle.length && rle[rle.length - 2] === v) rle[rle.length - 1]++; else rle.push(v, 1); }
    demo[id] = { cols: p.meta.grid.cols, rows: p.meta.grid.rows, deedsRle: rle, count: bases.length, hash: hashOf(proj), first: proj.slice(0, 25), last: proj.slice(-5), ladder: hashOf(ladder), ladderCount: ladder.length };
    if (!MAP_REALMS.includes(id)) continue;
    const net = M.decor.basePaths(bases);
    const links = net.links.map(l => [l.a, l.b, l.sa, l.sb, l.pts, l.seed]), sides = [...net.sides].map(([k, s]) => [k, [...s]]);
    const env = envOf(M.common, []), wet = (x, y) => env.classAt(x, y);
    const settled = [];
    for (const l of net.links.slice(0, 400)) for (const bridge of [true, false]) {
      const r = M.decor.settlePath(l.pts, wet, { bridge });
      settled.push(r ? [r.segments.map(s => [s.a, s.b, s.ford ? 1 : 0, s.bridge ? 1 : 0]), r.crossings.map(c => [c.axis, c.kind, c.from, c.to])] : null);
    }
    const bridges = [];
    for (const axis of ['ew', 'ns']) {
      const piece = M.decor.bridgePiece(id, axis);
      bridges.push(piece ? [axis, piece.key, piece.fp, piece.anchor, piece.ink, piece.scale, [{ axis, from: [100.5, 40.25], to: [106.5, 40.25] }, { axis, from: [80, 12.5], to: [80, 21] }, { axis, from: [3, 3], to: [3, 3] }]
        .map(cr => M.decor.bridgeSeats({ ...cr, axis }, piece).map(s => [s.tx, s.ty, s.z]))] : [axis, null]);
    }
    paths[id] = { bases: bases.length, segments: net.segments.length, links: links.length, network: hashOf([net.segments.map(s => [s.a, s.b, s.seed]), links, sides]),
      firstLinks: links.slice(0, 6), settled: hashOf(settled), settledDropped: settled.filter(s => s === null).length, settledFirst: settled.slice(0, 4), bridges };
  }
  return { demo, paths };
}

// ---- the pack bytes (checked against the pinned manifest) -----------------------------------------------------------------
function packRead(repo, pinned) {
  const byPath = new Map(pinned.manifest.files.map(f => [f.path, f]));
  return rel => {
    const f = byPath.get(rel), b = fs.readFileSync(path.join(repo, PACK_DIR, rel));
    if (!f || f.bytes !== b.length || f.sha256 !== sha256(b)) throw new Error(`REFUSED: ${rel} is not the pinned pack byte for byte`);
    return b;
  };
}
async function loadPacks(repo, pinned, M) {
  const read = packRead(repo, pinned);
  const fx = JSON.parse(read('realm/shared/fx.json').toString('utf8')), out = new Map();
  for (const { id } of pinned.manifest.realms) {
    const meta = JSON.parse(read(`realm/${id}/realm.json`).toString('utf8'));
    const png = await M.loader.decodePng(new Uint8Array(read(`realm/${id}/deeds.png`)), { sliceMs: 1e9 });
    out.set(id, { meta, fx, deeds: png.data ?? png.rgba ?? png });
  }
  return out;
}

// ---- tables ----------------------------------------------------------------------------------------------------------------
function lifeTables(M, src, header) {
  const S = M.scatter, C = M.contracts;
  const life = src['life.js'], scatter = src['scatter.js'];
  const constants = {
    MIN_SPRITE_PX: S.MIN_SPRITE_PX, LIFE_CAPS: S.LIFE_CAPS, PHONE_CSS_MAX: S.PHONE_CSS_MAX, THIN_MAX: S.THIN_MAX, THIN_ORDER: S.THIN_ORDER, SWAY: S.SWAY,
    PLOT_CLEAR: S.PLOT_CLEAR, MAX_SPECIES: S.MAX_SPECIES, FACINGS: S.FACINGS, HERD_MAX: S.HERD_MAX, LOOP_RADIUS_TILES: S.LOOP_RADIUS_TILES, WAYPOINT_SNAP: S.WAYPOINT_SNAP,
    FLOCK_MAX: S.FLOCK_MAX, RANK_N: S.RANK_N, STAND: S.STAND, THIN_SPREAD: S.THIN_SPREAD, THIN_EPS: S.THIN_EPS, MAPOBJ_ROLES: S.MAPOBJ_ROLES,
    // stage B: the map-object lens glow (life.js T4 row, flag 4) and the rare-fall weight lifeTable applies through `mapobjs`
    GLOW: S.GLOW, FALL: privateConst(scatter, 'FALL'),
    STAND_MARGIN: privateConst(scatter, 'STAND_MARGIN', { ART: C.ART }),
    CLASS: C.CLASS,
    // contracts.js geometry at the pin: ART and TILES are game numbers (GRID.tilePx, BASE_GROUND_WORLD_GEOMETRY.worldTiles) the
    // native port reads from the catalogue; these copies only let the loader refuse a catalogue that disagrees with the pin
    pinnedGeometry: { ART: C.ART, TILES: C.TILES, DEED_ART: C.DEED_ART, CELL: C.CELL, MAP_ART: C.MAP_ART },
    SIZE_CLASSES: privateConst(life, 'SIZE_CLASSES'), TWIN_CLASSES: privateConst(life, 'TWIN_CLASSES'), NO_ARRAY: privateConst(life, 'NO_ARRAY'),
    MAX_LAYERS: privateConst(life, 'MAX_LAYERS', { MAX_SPECIES: S.MAX_SPECIES }), SPT: privateConst(life, 'SPT', { MAX_SPECIES: S.MAX_SPECIES }),
    PUFFS: privateConst(life, 'PUFFS', { MAX_SPECIES: S.MAX_SPECIES }), PUFF_LIFE_MS: privateConst(life, 'PUFF_LIFE_MS', { MAX_SPECIES: S.MAX_SPECIES }),
  };
  return Buffer.from(ordered({ ...header, kind: 'pkw-life-tables', constants, tables: S.LIFE_TABLES }) + '\n');
}
function decorTables(M, src, header) {
  const D = M.decor, B = M.bases, Dm = M.demo_bases, decor = src['decor.js'], bases = src['bases.js'], demo = src['demo-bases.js'];
  const shapes = Array.from({ length: 16 }, (_, m) => M.wc.wallShape({ n: !!(m & 1), e: !!(m & 2), s: !!(m & 4), w: !!(m & 8) }));
  return Buffer.from(ordered({
    ...header, kind: 'pkw-decor-tables',
    note: 'Presentation tables only. Game numbers (footprints, source scales, build caps, wall rings, claims) come from the constants catalogue.',
    decor: {
      DECOR_LAYOUT: D.DECOR_LAYOUT, GAME_ART: D.DECOR_ART.game, KIT_ART: D.DECOR_ART.kit, WALL_CELL_H: D.DECOR_ART.wallCellH, FIRE: D.DECOR_ART.fire,
      KEEP_TIPS: D.KEEP_TIPS, KIT_DRESSING: D.KIT_DRESSING, FLAT_CROPS: [...D.FLAT_CROPS], DECALS: [...D.DECALS], EDGE_ARMS: D.EDGE_ARMS, GATE_SIDES: D.GATE_SIDES,
      PATHS: D.PATHS, PATH_TERRAIN: D.PATH_TERRAIN, POLE_ROLES: privateConst(decor, 'POLE_ROLES'), RUNTIME: privateConst(decor, 'RUNTIME'), WALL_SHAPE_BY_MASK: shapes,
      // contracts.js presentation rules decor.js reads (the game caps they are combined with come from the catalogue)
      DECOR_CAP: M.contracts.DECOR_CAP, BUILD_KEY: M.contracts.BUILD_KEY, KEEP_FIT: M.contracts.KEEP_FIT, REALMS_WITH_MAPS: M.contracts.REALMS_WITH_MAPS,
    },
    bases: {
      MAP_PX_PER_TILE: privateConst(bases, 'MAP_PX_PER_TILE'), CLASSES: privateConst(bases, 'CLASSES'), MAX_LAYERS: privateConst(bases, 'MAX_LAYERS'), MINI: privateConst(bases, 'MINI'),
      SPECK_ROLES: privateConst(bases, 'SPECK_ROLES'), SHIELD: privateConst(bases, 'SHIELD'), HERALDIC: privateConst(bases, 'HERALDIC'), GOLD: privateConst(bases, 'GOLD'),
      ICON_TOWERS: privateConst(bases, 'ICON_TOWERS'), ACCENT: privateConst(bases, 'ACCENT'), BASES_GL: B.BASES_GL, REHEARSAL: B.REHEARSAL, BASES_LIMITS: B.BASES_LIMITS,
      ICON_CENTRE_D: B.ICON_CENTRE_D, // stage B (090b3428): the MAP marker icon is centred on its plot up to [0], on the keep seat from [1]
    },
    demo: { DEMO: Dm.DEMO, SYL: privateConst(demo, 'SYL'), CLANS: Dm.CLANS },
  }) + '\n');
}

/** The game numbers decor.js read at the pin (for the parity test's catalogue check; never shipped). */
function pinnedGame(K) {
  const fams = ['archertower', 'cannon', 'mortar', 'airdefence', 'electrictower', 'magetower', 'lasertower', 'dragonnest', 'vault', 'camp', 'barracks', 'mine', 'goldforge', 'clanhall', 'heroaltar', 'siegestool', 'forge', 'keep'];
  return {
    claimTilesByKeep: K.CAMPAIGN.claimTilesByKeep, wallRingsByKeep: K.CAMPAIGN_LAYOUT.wallRingsByKeep, outerWallInset: K.CAMPAIGN_LAYOUT.outerWallInset,
    worldTiles: K.BASE_GROUND_WORLD_GEOMETRY.worldTiles, tilePx: K.GRID.tilePx, maxMinesByKeep: K.MINING.MAX_MINES_BY_KEEP,
    buildCountCapByKeep: K.BUILD_COUNT_CAP_BY_KEEP, buildingSourceScale: { cannon: K.ART_V2.buildingSourceScale.cannon, mortar: K.ART_V2.buildingSourceScale.mortar },
    footprints: Object.fromEntries(fams.map(f => [f, (K.DEFENSES[f] ?? K.STRUCTURES[f])?.footprint ?? null])),
    presentation: Object.fromEntries(fams.map(f => [f, K.WARE_WORLD_PRESENTATION[f] ? [K.WARE_WORLD_PRESENTATION[f].sourceScale ?? null, K.WARE_WORLD_PRESENTATION[f].offsetGamePx ?? null] : null])),
    wallCapForKeepLevel: Array.from({ length: 20 }, (_, i) => K.wallCapForKeepLevel(i + 1)),
  };
}

// ---- driver -------------------------------------------------------------------------------------------------------------
export async function generate({ repo, root = ROOT }) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8')), pin = lock.source.commit;
  const pinned = pinnedManifest(repo, lock);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-lifebases-'));
  try {
    extractPinned(repo, pin, [ENGINE, ...SHARED], tmp);
    const deps = path.join(repo, 'packages/shared/node_modules');
    if (fs.existsSync(deps)) fs.symlinkSync(deps, path.join(tmp, 'packages/shared/node_modules'), 'dir');
    const load = await moduleLoader(repo), dir = path.join(tmp, ENGINE);
    const files = { contracts: 'contracts.js', scatter: 'scatter.js', decor: 'decor.js', bases: 'bases.js', life: 'life.js', demo_bases: 'demo-bases.js', camera: 'camera.js', loader: 'loader.js' };
    const entry = path.join(tmp, 'lifebases-entry.mjs');
    fs.writeFileSync(entry, Object.entries(files).map(([k, f]) => `export * as ${k} from ${JSON.stringify('./' + path.posix.join(ENGINE, f))};`).join('\n')
      + `\nexport * as common from ${JSON.stringify('./' + path.posix.join(ENGINE, 'glsl/common.glsl.js'))};`
      + `\nexport * as wc from './packages/shared/src/wallConnect.ts';\nexport * as K from './packages/shared/src/constants.ts';\n`);
    const M = { ...(await load(entry)) };
    MAP_REALMS = [...M.contracts.REALMS_WITH_MAPS];
    const src = Object.fromEntries(['life.js', 'scatter.js', 'decor.js', 'bases.js', 'demo-bases.js'].map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const sources = Object.fromEntries([...Object.values(files), 'glsl/common.glsl.js'].map(f => [`${ENGINE}/${f}`, sha256(fs.readFileSync(path.join(dir, f)))]));
    for (const f of ['constants.ts', 'wallConnect.ts']) sources[`packages/shared/src/${f}`] = sha256(fs.readFileSync(path.join(tmp, 'packages/shared/src', f)));
    const generator = sha256(fs.readFileSync(SELF));
    const header = { schema: 1, pin, generator, sources };
    const packs = await loadPacks(repo, pinned, M);
    const out = new Map();
    out.set(LIFE_TABLES_OUT, lifeTables(M, src, header));
    out.set(DECOR_TABLES_OUT, decorTables(M, src, header));
    const golden = (dir0, suite, body, extra = {}) => out.set(`${dir0}/golden-${suite}.json`,
      Buffer.from(serialize({ ...header, suite, ...extra, ...body }) + '\n'));
    const packInfo = { pack: { manifestSha256: pinned.sha256, packVersion: pinned.manifest.packVersion } };
    golden(LIFE_GOLDEN_DIR, 'compile', lifeCompileSuite(M, packs), packInfo);
    golden(LIFE_GOLDEN_DIR, 'place', lifePlaceSuite(M, packs), packInfo);
    golden(LIFE_GOLDEN_DIR, 'plan', lifePlanSuite(M, packs), packInfo);
    golden(LIFE_GOLDEN_DIR, 'pixels', lifePixelsSuite(M, src['life.js']));
    golden(LIFE_GOLDEN_DIR, 'table', await lifeTableSuite(M, repo, packRead(repo, pinned), privateConst(src['life.js'], 'SPT', { MAX_SPECIES: M.scatter.MAX_SPECIES })), packInfo);
    golden(BASES_GOLDEN_DIR, 'decor', decorSuite(M, pinnedGame(M.K)));
    golden(BASES_GOLDEN_DIR, 'bases', basesSuite(M));
    const { demo, paths } = await demoAndPathsSuites(M, packs);
    golden(BASES_GOLDEN_DIR, 'demo', { tolerance: 'exact', note: 'rows [id, x, y, level, name, avatar, trophies, clan, mine, shield, attackable]; ladder rows [id, x, y, level, shield, attackable]', realms: demo }, packInfo);
    golden(BASES_GOLDEN_DIR, 'paths', { tolerance: 'exact', env: ENV_NOTE, note: 'basePaths over the demo bases; settlePath over the first 400 links (bridge true, false) with classAt of env (no plots)', realms: paths }, packInfo);
    return out;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function compare(root, files) {
  const drift = [];
  for (const [rel, bytes] of files) { const p = path.join(root, rel); if (!fs.existsSync(p)) drift.push(`missing ${rel}`); else if (!fs.readFileSync(p).equals(bytes)) drift.push(`changed ${rel}`); }
  for (const d of [LIFE_GOLDEN_DIR, BASES_GOLDEN_DIR]) {
    const abs = path.join(root, d);
    if (fs.existsSync(abs)) for (const f of fs.readdirSync(abs)) if (f.startsWith('golden-') && !files.has(`${d}/${f}`)) drift.push(`extra ${d}/${f}`);
  }
  return drift;
}

async function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = path.resolve(opt('--root') ?? ROOT), repo = opt('--source') ?? process.env.PKW_GLOBE_SOURCE;
  if (!repo) throw new Error('Pass --source <SHARDKEEP-globe repo> (or PKW_GLOBE_SOURCE)');
  const files = await generate({ repo: path.resolve(repo), root });
  if (argv.includes('--check')) {
    const drift = compare(root, files);
    if (drift.length) { console.error(`world life/bases drift:\n  ${drift.join('\n  ')}`); return 1; }
    console.log(`world life/bases: no drift (${files.size} files)`);
    return 0;
  }
  let bytes = 0;
  for (const [rel, b] of files) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); bytes += b.length; }
  console.log(`world life/bases: wrote ${files.size} files (${bytes} bytes)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
