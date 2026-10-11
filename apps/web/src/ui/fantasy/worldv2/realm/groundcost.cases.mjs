// groundcost.test — GROUND's GPU cost guards (P0, KNOWN_ISSUES RM-GPU-1).
// Why these matter: the realm map froze the owner's whole Mac (every GPU process) on the real Metal GPU, and no
// QA run may measure that GPU again. So the guard is static: (1) no ground shader can loop over data (every loop has a
// small literal bound), (2) every texel fetch in the ground shaders is counted by groundcost.mjs (a new one fails the
// site count until the model is updated), and (3) the model's worst case per pass and per frame stays under budget on
// the owner's retina and on a phone. The old per-pixel segment walk is modelled too: it fails the pass budget, which is
// the regression this file exists to stop. Run: scripts/node_modules/.bin/tsx --test concepts/globe3d-2026-09-23/src/realm/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as classes from './glsl/classes.glsl.mjs';
import * as resolve from './glsl/resolve.glsl.mjs';
import * as chart from './glsl/chart.glsl.mjs';
import * as mapground from './glsl/mapground.glsl.mjs';
import * as trueground from './glsl/trueground.glsl.mjs';
import * as water from './glsl/water.glsl.mjs';
import * as common from './glsl/common.glsl.mjs';
import { SITES, PASS, HELPER, PASS_BUDGET, FRAME_BUDGET, RESOLVE_BUDGET, ITERS, ITER_BUDGET, FRAME_ITER_BUDGET, DISPLAY_BUDGET,
  frameCost, resolveBudget, subTileFetches, pageFetches, planPages, pageDemand, recCapacity, REC_PAGES, RESOLVE, LATTICE_PASSES } from './groundcost.mjs';
import { DESPECKLE_PASSES, classConfig, CLASS_CFG } from './classify.mjs';
import { mapNoiseTable } from './ground.mjs';
import { GPU_SAFE } from './contracts.mjs';
import { groundScale, lru } from './core.mjs';

const FILES = { classes, resolve, chart, mapground, trueground, water };
const FETCH = /\b(texelFetch|texelFetchOffset|texture|textureOffset|textureLod|textureLodOffset|textureGrad|textureGradOffset|textureProj|textureProjLod)\s*\(/g;
/** fetch call sites per function body of one GLSL source → { name: n } (functions without fetches omitted) */
function sitesOf(src) {
  const re = /\b[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{/g, out = {}; let r;
  while ((r = re.exec(src))) {
    if (['if', 'for', 'while', 'else', 'return', 'switch'].includes(r[1])) continue;
    let i = re.lastIndex, depth = 1; while (depth && i < src.length) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    const n = (src.slice(re.lastIndex, i - 1).match(FETCH) || []).length; if (n) out[r[1]] = (out[r[1]] ?? 0) + n;
  }
  return out;
}
const sources = () => Object.entries(FILES).flatMap(([f, m]) => Object.entries(m).filter(([, v]) => typeof v === 'string').map(([k, v]) => [`${f}:${k}`, v]));

// ---- the call graph of one GROUND program (P0 (b), (e)) --------------------------------------------------------------
// includes as ground.mjs registers them (core.include); a program = its source with every #include resolved once
const INCLUDES = { common: common.COMMON, 'rm-fields': classes.RM_FIELDS, 'rm-shore': classes.RM_SHORE, 'rm-classify': classes.RM_CLASSIFY, 'rm-water': water.RM_WATER, classes: classes.CLASSES };
const withIncludes = (src, seen = new Set()) => src.replace(/^[ \t]*#include[ \t]+"([\w.-]+)"[ \t]*$/gm, (_, n) => {
  if (seen.has(n)) return ''; assert.ok(n in INCLUDES, `unknown #include "${n}"`); seen.add(n); return withIncludes(INCLUDES[n], seen); });
/** GROUND's programs (ground.mjs core.program calls; the -wmask QA variants compile the same sources). */
const PROGRAMS = { 'rm-raw': ['bake', resolve.RAW_FS], 'rm-legalise': ['bake', resolve.LEGALISE_FS], 'rm-despeckle': ['bake', resolve.DESPECKLE_FS],
  'rm-record': ['bake', resolve.RECORD_FS], 'rm-chart': ['display', chart.CHART_FS], 'rm-map': ['display', mapground.MAP_FS], 'rm-true': ['display', trueground.TRUE_FS],
  'rm-pure': ['bake', resolve.PURE_FS] };
const PASS_OF = { 'rm-raw': 'raw', 'rm-legalise': 'legalise', 'rm-despeckle': 'despeckle', 'rm-record': 'record', 'rm-chart': 'chart', 'rm-map': 'map', 'rm-true': 'true', 'rm-pure': 'pure' };
function fnTable(src) { // name → [body …] (overloads kept)
  const s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ''), fns = new Map(), re = /\b[A-Za-z_]\w*\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{/g; let r;
  while ((r = re.exec(s))) {
    if (['if', 'for', 'while', 'else', 'return', 'switch'].includes(r[1])) continue;
    let i = re.lastIndex, d = 1; while (d && i < s.length) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; }
    if (!fns.has(r[1])) fns.set(r[1], []); fns.get(r[1]).push(s.slice(re.lastIndex, i - 1)); re.lastIndex = i;
  }
  return fns;
}
const skipWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };
const closeParen = (s, i) => { for (let d = 0; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')' && --d === 0) return i + 1; } return i; };
function stmtEnd(s, i) { // end of the statement starting at i (a loop's body: block, nested loop / if-else, or one statement)
  i = skipWs(s, i);
  if (s[i] === '{') { for (let d = 0; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) return i + 1; } return i; }
  const kw = s.slice(i).match(/^(for|while|if)\b/);
  if (kw) { let j = stmtEnd(s, closeParen(s, i + kw[1].length)); if (kw[1] === 'if') { const k = skipWs(s, j); if (/^else\b/.test(s.slice(k))) j = stmtEnd(s, k + 4); } return j; }
  for (let d = 0; i < s.length; i++) { const c = s[i]; if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--; else if (c === ';' && d === 0) return i + 1; }
  return i;
}
const FETCH_FN = /^(texelFetch|texelFetchOffset|texture|textureOffset|textureLod|textureLodOffset|textureGrad|textureGradOffset|textureProj|textureProjLod)$/;
/**
 * Walk a program from main(): → { iters, fetches, calls: Map(name → times reached) }. Every call and loop counts once per
 * trip of each loop around it; both arms of every branch count (an upper bound, what a real GPU may execute).
 */
function walk(src) {
  const fns = fnTable(withIncludes(src)), memo = new Map();
  const cost = name => {
    if (memo.has(name)) return memo.get(name);
    let best = { iters: 0, fetches: 0, calls: new Map() };
    for (const b of fns.get(name)) {
      const loops = [...b.matchAll(/\bfor\s*\(([^;]*);([^;]*);([^)]*)\)/g)].map(m => {
        const init = m[1].match(/=\s*(-?\d+)\s*$/), cond = m[2].trim().match(/^\w+\s*(<=|<)\s*(-?\d+)$/);
        assert.ok(cond, `${name}: loop "${m[0]}" has no literal bound`);
        return { at: m.index, from: m.index + m[0].length, to: stmtEnd(b, closeParen(b, m.index + 3)), trip: +cond[2] - (init ? +init[1] : 0) + (cond[1] === '<=' ? 1 : 0) };
      });
      const mult = p => loops.reduce((k, L) => (p >= L.from && p < L.to ? k * L.trip : k), 1);
      const r = { iters: 0, fetches: 0, calls: new Map() };
      for (const L of loops) r.iters += L.trip * mult(L.at);
      for (const m of b.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        const n = m[1], k = mult(m.index);
        if (FETCH_FN.test(n)) { r.fetches += k; continue; }
        if (!fns.has(n) || n === name) continue;
        const c = cost(n); r.iters += c.iters * k; r.fetches += c.fetches * k;
        r.calls.set(n, (r.calls.get(n) ?? 0) + k); for (const [x, v] of c.calls) r.calls.set(x, (r.calls.get(x) ?? 0) + v * k);
      }
      if (r.iters + r.fetches > best.iters + best.fetches) best = r;
    }
    memo.set(name, best); return best;
  };
  assert.ok(fns.has('main'), 'a program has main()');
  return cost('main');
}

test('every texel fetch in the ground shaders is in the cost model (call sites re-counted from the source)', () => {
  const seen = {};
  for (const [key, src] of sources()) { const s = sitesOf(src); if (Object.keys(s).length) seen[key] = s; }
  assert.deepEqual(seen, JSON.parse(JSON.stringify(SITES)), 'a ground shader gained or lost a fetch: update groundcost.mjs SITES + PASS (and re-check the budgets)');
});

test('ground shaders cannot spin the GPU: no while / do, every for loop has a literal bound of at most 16 iterations', () => {
  for (const [key, src] of sources()) {
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/\bwhile\s*\(/.test(code) && !/\bdo\s*\{/.test(code), `${key}: while / do loop`);
    for (const m of code.matchAll(/\bfor\s*\(([^;]*);([^;]*);([^)]*)\)/g)) {
      // the condition must compare against a literal and the step count up by one; a non-literal start (an inner loop
      // `b = a + 1` of an outer literal loop) only shortens the loop, so it counts from 0
      const init = m[1].match(/=\s*(-?\d+)\s*$/), cond = m[2].trim().match(/^\w+\s*(<=|<)\s*(-?\d+)$/), step = m[3].trim();
      assert.ok(/=/.test(m[1]) && cond && /^\w+\+\+$/.test(step), `${key}: loop "${m[0]}" has no literal bound (data-driven loops hung the GPU)`);
      assert.ok(init || /^\s*int\s+\w+\s*=\s*\w+\s*\+\s*\d+\s*$/.test(m[1]), `${key}: loop "${m[0]}" starts at an unbounded value`);
      const n = +cond[2] - (init ? +init[1] : 0) + (cond[1] === '<=' ? 1 : 0);
      assert.ok(n >= 0 && n <= 16, `${key}: loop "${m[0]}" runs ${n} times`);
    }
  }
  // the list-walking inputs are gone: rivers, tracks and bridges are sampled from baked pages
  for (const [key, src] of sources()) assert.ok(!/uRmSegs|rmSegTexel/.test(src), `${key} still reads the segment list`);
});

test('each ground pass stays within 64 fetches per fragment; the old per-pixel segment walk would not', () => {
  for (const [k, v] of Object.entries(PASS)) assert.ok(v <= PASS_BUDGET, `${k}: ${v} fetches per fragment`);
  // W1 G2: MAP 61 → 53 (the lattice purity bit: 4 corners + 4 warped corners instead of the 16-texel block)
  assert.equal(PASS.map, 53); assert.equal(PASS.raw, 60); assert.equal(PASS.true, 22); assert.equal(PASS.pure, 9);
  // before P0: rmInland and mpFlow each walked the deed's list (2 texels per segment, ≤ 50 segments after G14's resampling)
  // and the lattice/page resolve walked it for rivers and tracks; that is the pass this budget exists to refuse
  const oldMap = PASS.map - HELPER.rmRiverW - HELPER.rmLand - HELPER.rmBridgeN + 2 * 50 * 2 + 9 + 1, oldRaw = PASS.raw - HELPER.rmRiverW - HELPER.rmLand - HELPER.rmBridgeN + 2 * 50 * 2 + 9 + 2;
  assert.ok(oldMap > PASS_BUDGET && oldRaw > PASS_BUDGET, 'the model no longer tells the old segment walk from the baked pages');
});

// screens the owner uses: the retina Mac (1280×800 CSS at dpr 2), a dpr-3 phone (core caps the canvas at dpr 2), a
// 1080p desktop at dpr 2 and a dpr-1 laptop
const SCREENS = [['retina 1280×800 dpr 2', 1280, 800, 2], ['phone 390×844 dpr 3', 390, 844, 3], ['desktop 1920×1080 dpr 2', 1920, 1080, 2], ['laptop 1280×800 dpr 1', 1280, 800, 1]];
const canvas = (w, h, dpr) => { const r = Math.min(2, dpr); return [Math.round(w * r), Math.round(h * r)]; };

test('time slicing: one frame resolves at most 6 fetches per canvas px of lattice and pages, and always makes progress', () => {
  for (const [name, cw, ch, dpr] of SCREENS) {
    const [w, h] = canvas(cw, ch, dpr);
    for (const far of [true, false]) {
      const b = resolveBudget(w * h, { far, despecklePasses: DESPECKLE_PASSES });
      assert.ok(b.subs >= 1 && b.pages >= 1, `${name}: a view must always complete`);
      const c = frameCost({ w, h, drawn: {}, subs: b.subs, pages: b.pages, despecklePasses: DESPECKLE_PASSES });
      // one sub-tile + one page is the floor (below it nothing would resolve); above it the slice must fit the budget
      const floor = (subTileFetches() + pageFetches(DESPECKLE_PASSES)) / (w * h);
      assert.ok(c.resolvePerPx <= Math.max(RESOLVE_BUDGET, floor) + 1e-9, `${name} ${far ? 'FAR' : 'MAP'}: ${c.resolvePerPx.toFixed(1)} per px`);
    }
  }
  // a phone resolves less per frame than the retina desktop (its GPU is the smaller one)
  const [pw, ph] = canvas(390, 844, 3), [rw, rh] = canvas(1280, 800, 2);
  const p = resolveBudget(pw * ph), r = resolveBudget(rw * rh);
  assert.ok(p.subs + p.pages < r.subs + r.pages, 'the phone slice is not smaller');
});

test('a whole frame (chart + MAP + TRUE in a fade, plus the resolve slices) stays within 96 fetches and 256 iterations per canvas px', () => {
  // k = 1: even with SHELL's ground resolution cap switched off (?gpx, or a future core without it) the frame is bounded
  for (const [name, cw, ch, dpr] of SCREENS) {
    const [w, h] = canvas(cw, ch, dpr), b = resolveBudget(w * h, { despecklePasses: DESPECKLE_PASSES });
    const c = frameCost({ w, h, drawn: { chart: true, map: true, true: true }, subs: b.subs, pages: b.pages, despecklePasses: DESPECKLE_PASSES });
    assert.ok(c.perPx <= FRAME_BUDGET, `${name}: ${c.perPx.toFixed(1)} fetches per px (${(c.fetches / 1e6).toFixed(0)} M)`);
    assert.ok(c.itersPerPx <= FRAME_ITER_BUDGET, `${name}: ${c.itersPerPx.toFixed(1)} loop iterations per px (${(c.iters / 1e6).toFixed(0)} M)`);
  }
});

// P0 (e): the owner's two screens, the retina Mac that hung (1280×800 CSS at dpr 2) and a dpr-3 phone, with SHELL's ground
// resolution cap at its best-quality level (GPU_SAFE.groundPx[0], core.lowres): the display passes of a fade frame — all
// three drawn — cost ≤ 64 fetches per canvas px. Why: that is the frame the owner's GPU choked on; the cap (fewer ground
// px) and the baked fields (fewer fetches per px) together are what bound it, so the test uses both, from the real modules.
test('owner screens with the ground cap: a fade frame\'s display passes cost ≤ 64 fetches per canvas px', () => {
  for (const [name, cw, ch, dpr] of SCREENS.slice(0, 2)) {
    const [w, h] = canvas(cw, ch, dpr), k = groundScale(Math.min(2, dpr), GPU_SAFE.groundPx[0]);
    assert.ok(k < 1, `${name}: the cap applies (k ${k})`);
    const c = frameCost({ w, h, k, drawn: { chart: true, map: true, true: true } });
    assert.ok(c.passesPerPx <= DISPLAY_BUDGET, `${name}: ${c.passesPerPx.toFixed(1)} display fetches per canvas px at k ${k.toFixed(2)}`);
    assert.ok(c.groundPx < w * h * 0.6, `${name}: the ground target is ${c.groundPx} of ${w * h} canvas px`);
    // without the cap the same frame would not fit: the cap is load-bearing, not decoration
    assert.ok(frameCost({ w, h, k: 1, drawn: { chart: true, map: true, true: true } }).passesPerPx > DISPLAY_BUDGET, `${name}: uncapped fits anyway`);
  }
});

// W1 G2 (owner bar: full-resolution ground at rest on dpr ≥ 2, SHELL's per-band k): at MAP rest SHELL draws the ground at
// k = 1 on the owner's retina and on a dpr-2/3 phone, so the MAP pass PLUS that frame's resolve slices must fit the display
// budget on their own (the critic measured 65.4 per canvas px against 64 with P0's 61-fetch MAP). Why: over budget, SHELL
// has to keep the MAP band at half resolution, the blurred pixel art the owner-bar critic flagged.
test('MAP at rest at full resolution (k 1) on the retina and on phones: MAP + resolve slices ≤ 64 fetches per canvas px', () => {
  const screens = [['retina 1280×800 dpr 2', 1280, 800, 2], ['phone 390×844 dpr 3', 390, 844, 3], ['phone 390×844 dpr 2', 390, 844, 2], ['desktop 1920×1080 dpr 2', 1920, 1080, 2]];
  const at = (map, [, cw, ch, dpr]) => { const [w, h] = canvas(cw, ch, dpr), b = resolveBudget(w * h, { despecklePasses: DESPECKLE_PASSES });
    const c = frameCost({ w, h, k: 1, drawn: { map: true }, subs: b.subs, pages: b.pages, despecklePasses: DESPECKLE_PASSES });
    return c.passesPerPx * map / PASS.map + c.resolvePerPx; };
  for (const s of screens) assert.ok(at(PASS.map, s) <= DISPLAY_BUDGET, `${s[0]}: MAP at k 1 = ${at(PASS.map, s).toFixed(1)} per canvas px`);
  assert.ok(PASS.map + RESOLVE_BUDGET <= DISPLAY_BUDGET, 'MAP + a full resolve slice must fit on any screen');
  // teeth: P0's 16-texel lattice block (8 more fetches) does not fit on the retina (the critic's 65.4)
  assert.ok(at(PASS.map + 8, screens[0]) > DISPLAY_BUDGET, 'the model no longer tells the P0 block from the purity bit');
  // the resolve geometry: one apron vertex per pass after the raw one, or the tiles would show seams
  assert.equal(RESOLVE.apron, LATTICE_PASSES.length);
});

// P0 orchestrator decision: LIFE / BASES read classes per vertex (up to 9 reads per sprite); the sampled read must stay a few
// fetches, never the classifier's 60 (which is what made LIFE's programs take minutes to link on SwiftShader).
test('a sampled class read (classes include) costs at most 12 fetches; the classifier it replaced cost 60', () => {
  assert.equal(HELPER.classAtTile, 11); assert.ok(HELPER.classAtTile <= 12);
  assert.equal(HELPER.mapClassAt, 1); assert.equal(PASS.raw, HELPER.rmClassCore);
  assert.ok(HELPER.rmClassCore >= 5 * HELPER.classAtTile, 'the classifier stays in the resolve passes, where its cost is paid once per vertex');
});

// P0 orchestrator decision (LIFE measured minutes-long SwiftShader links of classifier-inlining programs): the §3.2
// classifier runs only in the resolve passes, once per program; every display shader and the "classes" include only
// sample (plus shoreline arithmetic at MAP). Why: a real GPU links every program at load, and each inlined classifier
// copy is the heaviest code any realm shader compiles. Checked on the CALL GRAPH from main() (what the compiler builds),
// not on include lines alone: a class rule moved into a shared include would pass an include check and fail this one.
test('the classifier is inlined only by the lattice/page resolve (once); display shaders and "classes" never reach it', () => {
  const inc = src => [...src.matchAll(/#include\s+"([\w.-]+)"/g)].map(m => m[1]);
  const withClassifier = sources().filter(([, src]) => inc(src).includes('rm-classify')).map(([k]) => k);
  assert.deepEqual(withClassifier, ['resolve:RAW_FS'], 'only the RAW resolve includes rm-classify');
  // the classifier = every function rm-classify defines (rmClassCore, rmClassAt*, rmStroke, rmParcel, rmBC*, rmClassWarp …)
  const RULES = [...fnTable(classes.RM_CLASSIFY.replace(/^[ \t]*#include[^\n]*$/gm, '')).keys()];
  assert.ok(RULES.includes('rmClassCore') && RULES.includes('rmStroke') && RULES.length >= 8, `rm-classify defines the rules (${RULES})`);
  for (const [name, [kind, src]] of Object.entries(PROGRAMS)) {
    const reached = [...walk(src).calls.keys()].filter(n => RULES.includes(n));
    if (name === 'rm-raw') assert.equal(walk(src).calls.get('rmClassCore'), 1, 'the raw resolve runs the classifier exactly once per vertex');
    else assert.deepEqual(reached, [], `${name} (${kind}) reaches the classifier`);
  }
  // "classes" (what LIFE and BASES compile): a probe calling every lookup reaches no rule and no loop over data
  const probe = '#include "common"\n#include "classes"\nvoid main() { ivec2 t = ivec2(1); uint a = mapClassAt(t) + mapFlagsAt(t) + mapClassFine(t) + classAtTile(t);'
    + ' bool r = pageResident(t) && walkable(t); uvec4 q = tileRecord(t); float d = plotSdf(vec2(t)); }';
  const w = walk(probe);
  assert.deepEqual([...w.calls.keys()].filter(n => RULES.includes(n)), [], '"classes" reaches the classifier');
  assert.ok(!inc(classes.CLASSES).includes('rm-shore') && !inc(classes.CLASSES).includes('rm-classify'), '"classes" is sampled lookups only');
  // teeth: the same walk sees a classifier call routed through a wrapper
  const bad = '#include "common"\n#include "rm-fields"\n#include "rm-classify"\nuint wrap(ivec2 v) { float c, w; return rmClassAt(v, c, w); }\nvoid main() { uint a = wrap(ivec2(1)) + wrap(ivec2(2)); }';
  assert.equal(walk(bad).calls.get('rmClassCore'), 2, 'two wrapped classifier reads = two inlined copies');
});

// P0 (e) "texel fetches + loop iterations per pixel": fetches are PASS (the worst path); loop iterations are ITERS, which
// this test re-derives from the GLSL call graph. Why: a loop that is literal-bounded can still multiply (a 16-trip loop
// around a 9-trip helper is 144 iterations per pixel); a new loop or call must move the model, and the model the budget.
test('loop iterations per fragment: the model equals the call-graph walk of every ground program, each under 160', () => {
  const seen = Object.fromEntries(Object.entries(PROGRAMS).map(([name, [, src]]) => [PASS_OF[name], walk(src).iters]));
  assert.deepEqual(seen, { ...ITERS }, 'a ground shader gained or lost loop iterations: update groundcost.mjs ITERS (and re-check the budgets)');
  for (const [k, v] of Object.entries(ITERS)) assert.ok(v <= ITER_BUDGET, `${k}: ${v} iterations per fragment`);
});

// P0 fix pass #1: rm-map's GPU pipeline is the heaviest build of the MAP band change (SwiftShader first draw 5.4–9 s; the
// first MAP d 150 frame 19–36 s). Attribution on SwiftShader (lane-ground.md): the value noises are ≈ 2 s of ≈ 5.5 s — a
// compiler that inlines every call and keeps loops (SwiftShader's JIT) builds one copy per call SITE, so groups of noises
// now run in literal loops (one copy each, the same sums). Why it matters: ANGLE builds that pipeline at the program's
// first draw, synchronously, on every device, and each noise copy is ~four hashes of integer code. This pins the count:
// a new noise call site must be deliberate. (Straight-line row vectors for the lattice block measured 0.6 s SLOWER than
// its compact loops — inlined copies, not loops or local arrays, are what costs.)
function inlinedCopies(src) { // name → inlined copies reachable from main(): each call site once, never per loop trip
  const fns = fnTable(withIncludes(src)), memo = new Map();
  const copies = name => {
    if (memo.has(name)) return memo.get(name);
    const out = new Map();
    for (const b of fns.get(name)) for (const m of b.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const n = m[1]; if (!fns.has(n) || n === name) continue;
      out.set(n, (out.get(n) ?? 0) + 1); for (const [x, v] of copies(n)) out.set(x, (out.get(x) ?? 0) + v);
    }
    memo.set(name, out); return out;
  };
  return copies('main');
}
const NOISE = ['rmVN', 'rmNoiseF', 'vnoise', 'rmZNoise'];
const noiseCopies = src => { const c = inlinedCopies(src); return NOISE.reduce((a, n) => a + (c.get(n) ?? 0), 0); };
test('rm-map compiles one shared value-noise copy (P0: 14 + 3 zig-zag at their call sites, 42 before): every noise is a bank slot', () => {
  const n = noiseCopies(mapground.MAP_FS), c = inlinedCopies(mapground.MAP_FS);
  // W1 G2: the art-px noises (and the foreign fade's) run in ONE rmVN copy, the zig-zags in one rmZNoise copy; what is left
  // is cloudShade's five (common, SHELL) and the lava realm's two (compiled for Cinderfall only)
  assert.equal(c.get('rmVN'), 1, 'rmVN is inlined once (the bank)'); assert.equal(c.get('rmZNoise'), 1, 'rmZNoise is inlined once');
  assert.ok(n <= 9, `rm-map inlines ${n} value-noise copies`);
  for (const f of ['rmLakeWarp', 'rmForeignCut', 'rmIsleSdfN', 'rmClearingN', 'rmBridgeN']) assert.ok(!c.has(f), `${f} is inlined again: its noises belong in the bank`);
  for (const f of ['rmIsleShapeN', 'rmClearShapeN', 'rmBridgeShapeN', 'cloudShade']) assert.ok(c.get(f) >= 1, `${f} is still reached`);
  // the same noises: each slot carries the period and seed its P0 call site passed (the classifier's coast, lake-warp, inland
  // and beach noises must stay the classifier's, or the MAP water line leaves the lattice and TRUE's), in the shader's size
  const cfg = classConfig({}), t = mapNoiseTable(cfg), slot = k => [t[k * 4], t[k * 4 + 1] >>> 0, t[k * 4 + 2]], I = CLASS_CFG.island;
  assert.equal(t.length, 28 * 4); assert.match(mapground.MAP_FS, /uniform ivec4 uMpNz\[28\]/);
  assert.deepEqual(slot(10), [cfg.coastNoise.period, cfg.coastNoise.seed >>> 0, 2], 'coast octave');
  assert.deepEqual(slot(11), [cfg.coastNoise2.period, cfg.coastNoise2.seed >>> 0, 2], 'fine coast octave');
  assert.deepEqual(slot(12), [cfg.inlandNoise.period, cfg.inlandNoise.seed >>> 0, 4], 'inland');
  assert.deepEqual(slot(13), [cfg.beachNoise.period, cfg.beachNoise.seed >>> 0, 4], 'beach');
  for (let k = 0; k < 4; k++) assert.deepEqual(slot(6 + k), [k < 2 ? cfg.lakeWarp.period : cfg.lakeWarp.period2, (cfg.lakeWarp.seed + k) >>> 0, 2], `lake warp ${k}`);
  assert.deepEqual([slot(14), slot(15), slot(16), slot(26)], [[I.period, I.seed >>> 0, 8], [I.period2, (I.seed + 1) >>> 0, 8], [Math.trunc(I.shallowPeriod), (I.seed + 3) >>> 0, 8], [I.zigCell, (I.seed + 2) >>> 0, 8]], 'islet');
  assert.deepEqual([slot(18), slot(27), slot(19), slot(17)], [[cfg.clearing.period, cfg.clearing.seed >>> 0, 16], [cfg.clearing.period2, cfg.clearing.seed2 >>> 0, 16],
    [cfg.apron.period, cfg.apron.seed >>> 0, 16], [cfg.bridge.wobPeriod, cfg.bridge.seed >>> 0, 16]], 'clearing, apron, bridge');
  // the shader's own constants, read back from P0's source (git show 5a61e02a): the warp, edge, fray and foreign noises
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20, 21, 22, 23, 24, 25].map(slot), [[14, 0x7a13, 1], [14, 0x19c5, 1], [5, 0x4e2b, 1], [5, 0x6d07, 1], [11, 0x61b3, 1], [5, 0x2f71, 1],
    [5, 0x6e21, 32], [48, 0x6f13, 64], [20, 0x1d27, 64], [7, 0x4f1d, 64], [3, 0x2a77, 64], [2, 0x5d19, 1]]);
  // teeth: the pre-fix-pass groups written out (four lake-warp noises, four foreign-cut octaves) count as eight copies
  const old = '#include "common"\n#include "rm-fields"\n#include "rm-water"\nvoid main() { vec2 q = gl_FragCoord.xy; float a = rmVN(q, 5, 1u) + rmVN(q, 7, 2u) + rmVN(q, 5, 3u) + rmVN(q, 7, 4u)'
    + ' + rmNoiseF(q, 48, 5u) + rmNoiseF(q, 20, 6u) + rmNoiseF(q, 7, 7u) + rmNoiseF(q, 3, 8u); }';
  assert.equal(noiseCopies(old), 8, 'the counter sees each written-out noise as a copy');
});

// P0 fix pass #6/#7: GROUND's page caches (TRUE record pages, 48 → screen-sized; chart16 pages, 16) against what a view
// wants. Why it matters: with the old loop, a view that wanted more pages than the cache held touched every visible
// resident, then loaded a missing one by evicting the oldest — a visible page — every frame: the map never idled
// (missing > 0 invalidates), uploaded a page table / composed a 1 MB chart16 page per frame on the main thread, and the
// evicted deeds shimmered between TRUE and MAP (chart16 and chart8). Modelled with core's own LRU and ground.mjs's order.
function simulate(demand, cap, planned, frames = 40) {
  const L = lru(cap), want = Array.from({ length: demand }, (_, i) => [i, Math.hypot((i % 11) - 5, Math.floor(i / 11) - 4) + i * 1e-6]);
  const loads = [], evictedKept = [];
  for (let f = 0; f < frames; f++) {
    let fetch;
    if (planned) {
      const plan = planPages(want, cap, k => L.has(k), 4); fetch = plan.fetch;
      for (let i = plan.keep.length - 1; i >= 0; i--) if (L.has(plan.keep[i])) L.get(plan.keep[i]);
      for (const k of fetch) L.put(k, 1, (v, key) => { if (plan.keep.includes(key)) evictedKept.push(key); });
    } else { // the pre-fix-pass pageWork / c16Want: touch every wanted resident, load the missing nearest-first
      const miss = [];
      for (const [k, d] of want) if (L.has(k)) L.get(k); else miss.push([k, d]);
      fetch = miss.sort((a, b) => a[1] - b[1]).slice(0, 4).map(e => e[0]);
      for (const k of fetch) L.put(k, 1);
    }
    loads.push(fetch.length);
  }
  return { loads, evictedKept, lastLoads: loads.slice(-10).reduce((a, b) => a + b, 0), total: loads.reduce((a, b) => a + b, 0) };
}
test('page caches: the nearest pages up to capacity are kept, a static view settles (no churn, no evicted visible page)', () => {
  for (const [demand, cap] of [[63, 48], [96, 48], [70, 48], [32, 16], [20, 16], [12, 16], [48, 48]]) {
    const r = simulate(demand, cap, true);
    assert.deepEqual(r.evictedKept, [], `${demand} wanted / ${cap}: a kept page was evicted`);
    assert.equal(r.lastLoads, 0, `${demand} wanted / ${cap}: a static view keeps loading (never idles)`);
    assert.equal(r.total, Math.min(demand, cap), `${demand} wanted / ${cap}: each kept page loads exactly once`);
  }
  // teeth: the old loop churns forever as soon as the view wants more than the cache holds
  assert.ok(simulate(63, 48, false).lastLoads > 0 && simulate(20, 16, false).lastLoads > 0, 'the old loop settles: the model lost the defect');
  assert.equal(simulate(40, 48, false).lastLoads, 0, 'within capacity the old loop settled too (the defect is demand > capacity)');
});

test('TRUE record cache: sized from the screen, it holds a d-600 view plus its margin on every reference screen', () => {
  // pageWork's deed span per axis for a view W device px wide at d: floor(x0) − 1 … floor(x0 + W/d) + 1, at any offset x0
  const span = (W, d, x0) => Math.floor(x0 + W / d) + 1 - (Math.floor(x0) - 1) + 1;
  // device px: the owner's 1280×800 retina, MacBook Pro 14 (1512×982), 1080p and 1440p at dpr 2, a dpr-3 phone
  const SCR = [[2560, 1600, 48], [3024, 1964, 63], [3840, 2160, 70], [5120, 2880, 96], [1170, 2532, 40]];
  for (const [w, h, critic] of SCR) {
    const d = 600, need = pageDemand(w, h, d);
    assert.equal(need, critic, `${w}×${h}: demand ${need} (the critic measured ${critic})`);
    let worst = 0; for (let i = 0; i < 64; i++) { const x0 = i / 64 * 7.3, y0 = i / 64 * 5.1; worst = Math.max(worst, span(w, d, x0) * span(h, d, y0)); }
    assert.ok(worst <= need, `${w}×${h}: a view spans ${worst} deeds, more than the demand bound ${need}`);
    assert.ok(recCapacity(w, h, d) >= need, `${w}×${h}: capacity ${recCapacity(w, h, d)} < demand ${need}`);
    assert.ok(recCapacity(w, h, d) <= REC_PAGES.max && recCapacity(w, h, d) * 98 * 98 * 8 <= 12.5 * 1048576, 'the cache stays ≤ 12.5 MB');
  }
  assert.equal(recCapacity(2560, 1600, 600), 48, 'the owner\'s retina keeps the old 48 layers (no extra memory)');
});
