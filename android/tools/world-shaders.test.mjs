import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENGINE, GLOBE, KOTLIN_FILE, LANE_LISTS, LOCK_FILE, compareExport, exportShaders, inlineCost, loopViolations, readGlobe, readLaneLists, samplerCount, stageViolations,
  verifyCommitted, writeExport,
} from './world-shaders.mjs';

// Why: the native world renderer must draw the web engine's shaders byte for byte (GLOBE-NATIVE-PLAN §4, D-168.2), and
// no shader may reach a GPU that could hang it (RM-GPU-1). These tests run without the web repo: the committed
// provisional export is checked against its lock, the rules are checked with the web's own teeth cases, and the
// exporter is exercised on a throwaway git repo. The drift re-export against the real pin is the local gate step
// `node tools/world-shaders.mjs --source <SHARDKEEP-globe> --check` (the pin is on no remote, so CI cannot run it).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPS = { stageChars: 80000, inlinedChars: 128000, classifierDisplay: 0, classifierBake: 1 };

test('the committed export is the chosen pin: realm and globe stages in the renderer classpath, every stage hashed and inside the rules', () => {
  // Rewritten at the N1/N2 re-pin (was: "the committed export is the locked provisional pin"). The lead chose a pin for
  // rendering, so the stages now ship from renderer/src/main/resources; the rule that matters is unchanged: a pin that
  // reaches an APK is recorded with its reason, every stage is hashed, and every stage passes the GPU-safety rules.
  const { lock, index, problems } = verifyCommitted(ROOT);
  assert.deepEqual(problems, []);
  assert.equal(lock.provisional, false);
  assert.ok(lock.chosenReason.length > 40, 'a pin that renders records why it was chosen');
  assert.equal(lock.out, 'renderer/src/main/resources/world/shaders', 'the runtime copy is on the renderer classpath');
  assert.ok(!fs.existsSync(path.join(ROOT, 'renderer/src/test/resources/world/shaders')), 'one copy of the stages, never a stale second one');
  assert.match(lock.contentManifest?.sha256 ?? '', /^[0-9a-f]{64}$/, 'the pack manifest at the pin ties the content to it (plan §6.1)');
  const names = new Set(index.programs.map(p => p.name));
  for (const n of ['rm-raw', 'rm-map', 'rm-true', 'rm-chart', 'life-scatter', 'bases-sprite', 'bases-dot', 'minimap', 'minimap-dots', 'rm-lowres-blit'])
    assert.ok(names.has(n), `program ${n} exported`); // an export that silently read nothing would pass every check below
  // N3: every program the GROUND and LIFE + BASES lanes list is exported, Cinderfall's lava rm-map included (ground.js
  // passes rm-map its defines through a variable, so only the lane list names that variant), and the lock pins the lists
  const keys = new Set(index.programs.map(p => p.vs.path.replace(/\.vs\.glsl$/, '')));
  for (const l of readLaneLists(ROOT)) {
    assert.equal(lock.laneLists[l.path], l.sha256, `${l.path} is the list this export was made from`);
    for (const p of l.doc.programs) assert.ok(keys.has(p.key) && p.exported === true, `${l.path}: ${p.key} exported`);
  }
  assert.deepEqual(Object.keys(lock.laneLists).sort(), [...LANE_LISTS].sort());
  const lava = index.programs.find(p => p.vs.path === 'rm-map+RM_LAVA.vs.glsl');
  assert.deepEqual(lava?.defines, { RM_LAVA: true });
  assert.match(fs.readFileSync(path.join(ROOT, lock.out, lava.fs.path), 'utf8'), /^#define RM_LAVA$/m);
  const globe = new Map(index.globe.map(p => [p.name, p]));
  for (const n of ['globe-flat', 'globe-isles', 'globe-fx', 'globe-terrain2', 'globe-sky', 'globe-cloud', 'globe-blit'])
    assert.equal(globe.get(n)?.use, 'draw', `globe program ${n} exported for drawing`);
  assert.equal(globe.get('globe-flat').module, 'src/globe/flat.glsl.js', 'N1 draws the shared flat globe (plan §4.6)');
  assert.equal(globe.get('globe-terrain2').vsName, 'TERRAIN_VS');
  assert.equal(index.programs.find(p => p.name === 'rm-raw').bake, true);
  assert.equal(index.programs.find(p => p.name === 'rm-map').bake, false);
  const dir = path.join(ROOT, lock.out);
  for (const p of index.programs) for (const kind of ['vs', 'fs']) {
    const stage = fs.readFileSync(path.join(dir, p[kind].path), 'utf8');
    assert.ok(stage.startsWith('#version 300 es\nprecision highp float;\n'), `${p[kind].path} starts with the PREAMBLE`);
    assert.match(stage, new RegExp(`^#define REALM_${kind.toUpperCase()} 1$`, 'm'));
    assert.deepEqual(stageViolations(stage, { bake: p.bake, caps: lock.rules }), [], p[kind].path);
  }
  for (const p of index.globe) for (const kind of ['vs', 'fs']) {
    const stage = fs.readFileSync(path.join(dir, p[kind].path), 'utf8');
    assert.ok(stage.startsWith('#version 300 es\n'), p[kind].path);
    if (p.module.startsWith('src/globe/')) {
      assert.match(stage, new RegExp(`^#define REALM_${kind.toUpperCase()} 1$`, 'm'), `${p[kind].path}: the realm engine's preprocess`);
      assert.doesNotMatch(stage, /^[ \t]*#[ \t]*include\b/m, `${p[kind].path}: includes resolved`);
    }
    assert.doesNotMatch(stage, /\$\{/, `${p[kind].path}: every template interpolation was resolved`);
    assert.deepEqual(stageViolations(stage, { bake: false, caps: lock.rules }), [], p[kind].path);
  }
});

test('loop rule: the shapes that hung the GPU are rejected and the sanctioned bounded form passes (web teeth)', () => {
  const D = new Map([['MAX_SEGS', 8], ['BIG', 128]]);
  const t = body => loopViolations(`void main() { ${body} }`, D);
  assert.deepEqual(t('for (int k = 0; k < MAX_SEGS; k++) { if (k >= n) break; x += seg(k); }'), []);
  assert.deepEqual(t('for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) s += at(i, j);'), []);
  assert.equal(t('for (int k = 0; k < n; k++) x += seg(k);').length, 1, 'data-driven bound');
  assert.equal(t('for (int k = 0; k < min(n, 8); k++) x++;').length, 1, 'a call in the header');
  assert.equal(t('for (int k = 0; k < BIG; k++) x++;').length, 1, 'bound over 64');
  assert.equal(t('for (int k = 0; k < 8; k++) { k += 2; }').length, 1, 'body writes the loop variable');
  assert.equal(t('for (int k = 0; k < 8; k += n) x++;').length, 1, 'data-driven step');
  assert.equal(t('uint r = 0u; while (r * r < n) r++;').length, 1, 'while loop');
  assert.equal(t('do { r++; } while (r < 4);').length, 2, 'do-while');
});

test('budget rules: classifier copies are counted through wrappers; caps, samplers and #extension are enforced', () => {
  const head = '#version 300 es\nprecision highp float;\n#define REALM_FS 1\n';
  const classifier = 'uint rmClassCore(ivec2 v) { return uint(v.x); }\n';
  const twice = `${head}${classifier}uint cls(ivec2 v) { return rmClassCore(v); }\nout vec4 o; void main() { o = vec4(float(cls(ivec2(1)) + cls(ivec2(2)))); }\n`;
  assert.equal(inlineCost(twice, 'rmClassCore').n, 2, 'two classifier reads through a wrapper = two inlined copies');
  assert.ok(stageViolations(twice, { bake: true, caps: CAPS }).some(v => /2 classifier copies/.test(v)), 'a bake pass runs the classifier at most once');
  const carried = `${head}${classifier}out vec4 o; void main() { o = vec4(0.0); }\n`;
  assert.ok(stageViolations(carried, { bake: false, caps: CAPS }).some(v => /carries the classifier/.test(v)), 'display programs sample baked classes');
  assert.deepEqual(stageViolations(carried, { bake: true, caps: CAPS }), []);
  const samplers = n => `${head}uniform highp usampler2DArray uA[${n}];\nuniform sampler2D uB;\nout vec4 o; void main() { o = vec4(0.0); }\n`;
  assert.equal(samplerCount(samplers(15)), 16);
  assert.deepEqual(stageViolations(samplers(15), { bake: false, caps: CAPS }), []);
  assert.ok(stageViolations(samplers(16), { bake: false, caps: CAPS }).some(v => /17 samplers/.test(v)));
  assert.equal(samplerCount(`${head}#ifdef NOPE\nuniform sampler2D uDead;\n#endif\nout vec4 o; void main() { o = vec4(0.0); }\n`), 0, 'dead #ifdef branches declare nothing');
  assert.ok(stageViolations(`${head}#extension GL_EXT_foo : require\nout vec4 o; void main() { o = vec4(0.0); }\n`, { bake: false, caps: CAPS }).some(v => /#extension/.test(v)));
  const big = `${head}out vec4 o; void main() { o = vec4(0.0); }\n// ${'x'.repeat(CAPS.stageChars)}\n`;
  assert.ok(stageViolations(big, { bake: false, caps: CAPS }).some(v => /chars >/.test(v)), 'the per-stage size cap');
  assert.ok(stageViolations(`${head}out vec4 o; void main() { for (int k = 0; k < n; k++) o += vec4(1.0); }\n`, { bake: false, caps: CAPS }).length > 0);
});

// ---- the exporter on a throwaway repository ---------------------------------------------------------------------------
const FILES = {
  'package.json': '{ "type": "module" }\n',
  'glsl/common.glsl.js': "export const PREAMBLE = `#version 300 es\\nprecision highp float;\\n`;\nexport const COMMON = `float two() { return 2.0; }\\n`;\n",
  'contracts.js': 'export const GPU_SAFE = { shader: { stageChars: 80000, inlinedChars: 128000, classifierDisplay: 0, classifierBake: 1 } };\n',
  // the pin's own preprocess: the web's function plus a marker, so the test can prove the exporter called THIS one
  'core.js': `import { PREAMBLE, COMMON } from './glsl/common.glsl.js';
export function preprocessGLSL(src, { kind, defines = {}, includes, name = '?' }) {
  const resolve = (s, seen) => s.replace(/^[ \\t]*#include[ \\t]+"([\\w.-]+)"[ \\t]*$/gm, (_, n) => {
    if (seen.has(n)) return '// #include "' + n + '" (already included)';
    if (!includes.has(n)) throw Error('unknown #include ' + n);
    seen.add(n); return resolve(includes.get(n), seen);
  });
  const body = src.replace(/^\\s*#version[^\\n]*\\n/, '');
  const defs = Object.entries(defines || {}).map(([k, v]) => '#define ' + k + (v === true ? '' : ' ' + v)).join('\\n');
  return PREAMBLE + '#define REALM_' + kind + ' 1\\n' + defs + '\\n' + resolve(body, new Set()) + '// pinned-core\\n';
}
export function createCore() { const includes = new Map([['common', COMMON]]); return { includes }; }
`,
  'glsl/demo.glsl.js': "export const DEMO_VS = `#version 300 es\\nvoid main() { gl_Position = vec4(0.0); }\\n`;\n"
    + "export const DEMO_FS = `#version 300 es\\n#include \"common\"\\nout vec4 o; void main() { float s = 0.0; for (int k = 0; k < 8; k++) s += two(); o = vec4(s); }\\n`;\n",
  'demo.js': "import { DEMO_VS, DEMO_FS } from './glsl/demo.glsl.js';\n"
    + "export function create(core) { core.program('demo', { vs: DEMO_VS, fs: DEMO_FS }); core.program('demo', { vs: DEMO_VS, fs: DEMO_FS, defines: { FAST: true } }); }\n",
};
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'world-shaders-repo-'));
  const g = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' }).toString().trim();
  g('init', '-q');
  const write = (rel, text) => { const p = path.join(dir, ENGINE, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const commit = () => { g('add', '-A'); g('commit', '-q', '-m', 'x'); return g('rev-parse', 'HEAD'); };
  for (const [rel, text] of Object.entries(FILES)) write(rel, text);
  return { dir, write, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the exporter reads the pinned commit through the pin\'s own preprocessGLSL, never the working tree', async () => {
  const r = repo();
  try {
    const pin1 = r.commit();
    const a = await exportShaders({ repo: r.dir, pin: pin1 });
    assert.deepEqual([...a.files.keys()].sort(), ['demo+FAST.fs.glsl', 'demo+FAST.vs.glsl', 'demo.fs.glsl', 'demo.vs.glsl', 'index.json']);
    const fsStage = a.files.get('demo.fs.glsl').toString();
    assert.equal(fsStage, '#version 300 es\nprecision highp float;\n#define REALM_FS 1\n\nfloat two() { return 2.0; }\n\nout vec4 o; void main() { float s = 0.0; for (int k = 0; k < 8; k++) s += two(); o = vec4(s); }\n// pinned-core\n');
    assert.match(a.files.get('demo+FAST.fs.glsl').toString(), /^#define FAST$/m, 'program defines reach the stage');
    assert.equal(a.lock.source.commit, pin1);
    assert.equal(a.lock.provisional, true);
    assert.equal(a.lock.source.globe.status, 'absent-at-pin');
    // the web P0 workflow keeps committing: an uncommitted edit must not leak into the export ...
    r.write('glsl/demo.glsl.js', FILES['glsl/demo.glsl.js'].replace('2.0', '3.0').replace('s += two()', 's += 1.0'));
    const again = await exportShaders({ repo: r.dir, pin: pin1 });
    assert.ok(again.files.get('demo.fs.glsl').equals(a.files.get('demo.fs.glsl')));
    // ... while a new pin does change it
    const pin2 = r.commit();
    const b = await exportShaders({ repo: r.dir, pin: pin2 });
    assert.notEqual(b.lock.stages['demo.fs.glsl'], a.lock.stages['demo.fs.glsl']);
    assert.notEqual(b.lock.sources[`${ENGINE}/glsl/demo.glsl.js`], a.lock.sources[`${ENGINE}/glsl/demo.glsl.js`]);
  } finally { r.cleanup(); }
});

test('the exporter fails loudly on an unreadable program call, a rule break, or globe shaders it cannot read yet', async () => {
  const cases = [
    ['demo.js', FILES['demo.js'].replace("core.program('demo', { vs: DEMO_VS, fs: DEMO_FS });", "core.program('demo', pick());"), /cannot parse/],
    ['glsl/demo.glsl.js', FILES['glsl/demo.glsl.js'].replace('k < 8', 'k < n'), /Shader rules failed[\s\S]*bound is not a literal/],
    ['glsl/demo.glsl.js', FILES['glsl/demo.glsl.js'].replace('#include "common"', '#include "nope"'), /unknown #include nope/],
    [`../globe/flat.glsl.js`, 'export const FLAT_FS = ``;\n', new RegExp(`${GLOBE} has no module exporting GLOBE_PROGRAMS`)],
  ];
  for (const [rel, text, error] of cases) {
    const r = repo();
    try {
      r.write(rel, text);
      await assert.rejects(exportShaders({ repo: r.dir, pin: r.commit() }), error, rel);
    } finally { r.cleanup(); }
  }
});

test('the lane lists are merged: a listed define variant is exported only where the module sets it, and a list that disagrees with the pin fails', async () => {
  // Why: ground.js compiles Cinderfall's rm-map with RM_LAVA through a defines VARIABLE (gd.RM_LAVA = true), which the
  // call-site reader must treat as empty (it also carries ?gdbg debug switches). Only the lane's own list can name the
  // production variant; the exporter must still prove the pin sets it, and a lane list must never drift from the engine
  // silently (a new web program would otherwise never reach native, or a stale variant would ship).
  const VAR = FILES['demo.js'].replace('export function create(core) {', "export function create(core, id) {\n  const gd = {}; if (id === 'hot') gd.HOT = true;\n  core.program('demo-var', { vs: DEMO_VS, fs: DEMO_FS, defines: gd });");
  const entry = (key, name, defines = {}) => ({ key, name, vs: 'DEMO_VS', fs: 'DEMO_FS', defines, exported: true });
  const list = pin => ({ pin, programs: [entry('demo', 'demo'), entry('demo+FAST', 'demo', { FAST: true }), entry('demo-var', 'demo-var'), entry('demo-var+HOT', 'demo-var', { HOT: true })] });
  const lanes = doc => [{ path: 'tools/lane.json', sha256: 'f'.repeat(64), doc }];
  const r = repo();
  try {
    r.write('demo.js', VAR);
    const pin = r.commit();
    const a = await exportShaders({ repo: r.dir, pin, lanes: lanes(list(pin)) });
    assert.match(a.files.get('demo-var+HOT.fs.glsl').toString(), /^#define HOT$/m, 'the listed variant is exported with its define');
    assert.doesNotMatch(a.files.get('demo-var.fs.glsl').toString(), /#define HOT/, 'the base program stays define-free');
    const idx = JSON.parse(a.files.get('index.json'));
    assert.equal(idx.programs.find(p => p.vs.path === 'demo-var+HOT.vs.glsl').variant, 'demo.js gd.HOT (tools/lane.json)');
    assert.deepEqual(a.lock.laneLists, { 'tools/lane.json': 'f'.repeat(64) }, 'the lock pins the list the export read');
    const without = await exportShaders({ repo: r.dir, pin });
    assert.ok(!without.files.has('demo-var+HOT.fs.glsl'), 'without the list the variable-defines program exports define-free only');
    const bad = [
      [{ ...list(pin), pin: 'a'.repeat(40) }, /names pin a{40}/],
      [{ ...list(pin), programs: [...list(pin).programs.slice(0, 3), entry('demo-var+COLD', 'demo-var', { COLD: true })] }, /never sets gd\.COLD/],
      [{ ...list(pin), programs: list(pin).programs.map(p => (p.key === 'demo-var+HOT' ? { ...p, exported: false } : p)) }, /"exported" is not true/],
      [{ ...list(pin), programs: list(pin).programs.map(p => (p.key === 'demo' ? { ...p, fs: 'OTHER_FS' } : p)) }, /listed as DEMO_VS\/OTHER_FS, the pin compiles DEMO_VS\/DEMO_FS/],
      [{ ...list(pin), programs: list(pin).programs.filter(p => p.key !== 'demo+FAST') }, /program\('demo'\) \{"FAST":true\} is in no lane list/],
      [{ ...list(pin), programs: [...list(pin).programs, entry('gone', 'gone')] }, /no program\('gone'\) at the pin/],
      [{ ...list(pin), programs: [...list(pin).programs, entry('demo+SLOW', 'demo', { SLOW: true })] }, /has no program\(\) with variable defines/],
    ];
    for (const [doc, error] of bad) await assert.rejects(exportShaders({ repo: r.dir, pin, lanes: lanes(doc) }), error);
  } finally { r.cleanup(); }
});

test('verify sees a lane list edited after the export', async () => {
  const r = repo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-shaders-root-'));
  try {
    const pin = r.commit();
    fs.mkdirSync(path.join(root, 'tools'));
    const doc = { pin, programs: ['demo', 'demo+FAST'].map(key => ({ key, name: 'demo', vs: 'DEMO_VS', fs: 'DEMO_FS', defines: key.includes('FAST') ? { FAST: true } : {}, exported: true })) };
    fs.writeFileSync(path.join(root, 'tools/lane.json'), JSON.stringify(doc));
    const result = await exportShaders({ repo: r.dir, pin, lanes: readLaneLists(root, ['tools/lane.json']) });
    writeExport(root, 'renderer/src/test/resources/world/shaders', result);
    assert.deepEqual(verifyCommitted(root).problems, []);
    fs.writeFileSync(path.join(root, 'tools/lane.json'), JSON.stringify({ ...doc, note: 'edited' }));
    assert.deepEqual(verifyCommitted(root).problems, ['tools/lane.json changed since the export: re-run the exporter']);
  } finally { r.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a provisional export writes only into test resources, and the drift check sees every changed, extra or missing file', async () => {
  const r = repo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-shaders-root-'));
  try {
    const result = await exportShaders({ repo: r.dir, pin: r.commit() });
    assert.throws(() => writeExport(root, 'renderer/src/main/resources/world/shaders', result), /only into a src\/test\/resources/);
    assert.throws(() => writeExport(root, '../outside/src/test/resources/x', result), /outside the repository/);
    const out = 'renderer/src/test/resources/world/shaders';
    writeExport(root, out, result);
    assert.deepEqual(compareExport(root, out, result), []);
    assert.deepEqual(verifyCommitted(root).problems, []);
    const dir = path.join(root, out);
    fs.appendFileSync(path.join(dir, 'demo.fs.glsl'), '\n');
    fs.writeFileSync(path.join(dir, 'stray.glsl'), '');
    fs.rmSync(path.join(dir, 'demo+FAST.vs.glsl'));
    assert.deepEqual(compareExport(root, out, result).sort(), ['changed demo.fs.glsl', 'extra stray.glsl', 'missing demo+FAST.vs.glsl']);
    assert.deepEqual(verifyCommitted(root).problems.sort(), ['hash mismatch demo.fs.glsl', 'missing demo+FAST.vs.glsl', 'unlisted file stray.glsl']);
    fs.writeFileSync(path.join(root, LOCK_FILE), '{}\n');
    writeExport(root, out, result);
    assert.deepEqual(compareExport(root, out, result), [], 'a re-export restores the committed state exactly');
  } finally { r.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- the concept globe (src/shaders.js + main.js compile() calls) --------------------------------------------------------
const GLOBE_FILES = {
  '../shaders.js': [
    'export const COMMON = `',
    'float two(){return 2.;}',
    '`;',
    'export const FULLSCREEN_VS = `#version 300 es',
    'in vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}`;',
    'export const SKY_FS = `#version 300 es',
    'precision highp float;out vec4 o;',
    '${COMMON}',
    'void main(){o=vec4(two());}`;',
    '',
  ].join('\n'),
  '../main.js': [
    "import * as S from './shaders.js';",
    'function compile(vs, fs) { return [vs, fs]; }',
    'const HMW = 64, HMH = 32;',
    'const pSky = compile(S.FULLSCREEN_VS, S.SKY_FS);',
    'function readHeights() {',
    '  const p = compile(S.FULLSCREEN_VS, `#version 300 es',
    'precision highp float;out vec4 o;void main(){o=vec4(gl_FragCoord.xy/vec2(${HMW}.,${HMH}.),0.,1.);}`);',
    '}',
    'const pBlit = compile(S.FULLSCREEN_VS, `#version 300 es',
    'precision highp float;out vec4 o;void main(){o=vec4(1.);}`);',
    '',
  ].join('\n'),
};

test('a chosen pin exports the globe stages exactly as main.js hands them to compile(), and fails on a call it cannot read', async () => {
  const r = repo();
  try {
    for (const [rel, text] of Object.entries(GLOBE_FILES)) r.write(rel, text);
    const pin = r.commit();
    const a = await exportShaders({ repo: r.dir, pin, chosen: 'test pin chosen for rendering' });
    assert.equal(a.lock.provisional, false);
    assert.equal(a.lock.chosenReason, 'test pin chosen for rendering');
    assert.equal(a.lock.out, 'renderer/src/main/resources/world/shaders');
    const index = JSON.parse(a.files.get('index.json'));
    assert.deepEqual(index.globe.map(p => [p.name, p.site, p.use]), [['globe-blit', 'pBlit', 'draw'], ['globe-read-heights', 'readHeights()', 'draw'], ['globe-sky', 'S.SKY_FS', 'draw']]);
    // the module string after ${COMMON} resolved: what the browser compiles, byte for byte
    assert.equal(a.files.get('globe-sky.fs.glsl').toString(), '#version 300 es\nprecision highp float;out vec4 o;\n\nfloat two(){return 2.;}\n\nvoid main(){o=vec4(two());}');
    // an inline stage interpolating main.js numeric constants is cooked as the browser cooks it
    assert.match(a.files.get('globe-read-heights.fs.glsl').toString(), /vec2\(64\.,32\.\)/);
    assert.ok(a.lock.sources['concepts/globe3d-2026-09-23/src/shaders.js'] && a.lock.sources['concepts/globe3d-2026-09-23/src/main.js']);
    assert.equal(a.lock.contentManifest, null, 'no pack manifest at this pin');
    const provisional = await exportShaders({ repo: r.dir, pin });
    assert.equal(provisional.lock.provisional, true, 'without a recorded reason the pin stays provisional');
  } finally { r.cleanup(); }
  const broken = [
    ['../main.js', GLOBE_FILES['../main.js'].replace('${HMW}', '${W}'), /interpolates \$\{W\}/],
    ['../main.js', GLOBE_FILES['../main.js'].replace('compile(S.FULLSCREEN_VS, S.SKY_FS)', 'compile(pick(), S.SKY_FS)'), /no S.<NAME> vertex stage/],
    ['../main.js', GLOBE_FILES['../main.js'].replace('S.SKY_FS)', 'S.NOPE_FS)'), /names no string export/],
    ['../shaders.js', GLOBE_FILES['../shaders.js'].replace('void main(){o=vec4(two());}', 'void main(){float s=0.;for(int i=0;i<n;i++)s+=1.;o=vec4(s);}'), /Shader rules failed[\s\S]*globe-sky FS/],
  ];
  for (const [rel, text, error] of broken) {
    const b = repo();
    try {
      for (const [k, v] of Object.entries(GLOBE_FILES)) b.write(k, v);
      b.write(rel, text);
      await assert.rejects(exportShaders({ repo: b.dir, pin: b.commit(), chosen: 'x' }), error, rel);
    } finally { b.cleanup(); }
  }
  const noGlobe = repo();
  try { await assert.rejects(exportShaders({ repo: noGlobe.dir, pin: noGlobe.commit(), chosen: 'x' }), /exports the globe too/); } finally { noGlobe.cleanup(); }
});

test('readGlobe never guesses: a numeric constant bound twice to different values is not interpolated', () => {
  const S = { V: '#version 300 es\nvoid main(){}', F: '#version 300 es\nvoid main(){}' };
  const text = 'const N = 1;\nconst N = 2;\nconst pX = compile(S.V, `#version 300 es\nfloat k=${N}.;`);\n';
  assert.match(readGlobe(text, S).problems.join('\n'), /interpolates \$\{N\}/);
  assert.deepEqual([...readGlobe('const pA = compile(S.V, S.F);\n', S).programs.keys()], ['globe-f']);
});

test('a chosen export may live in main resources and replaces the previous provisional copy', async () => {
  const r = repo(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-shaders-root-'));
  try {
    for (const [rel, text] of Object.entries(GLOBE_FILES)) r.write(rel, text);
    const pin = r.commit();
    const provisional = await exportShaders({ repo: r.dir, pin });
    writeExport(root, 'renderer/src/test/resources/world/shaders', provisional);
    const chosen = await exportShaders({ repo: r.dir, pin, chosen: 'chosen' });
    assert.throws(() => writeExport(root, 'renderer/assets/world/shaders', chosen), /only into a src\/\{main,test\}\/resources/);
    assert.equal(provisional.kotlin, null, 'a provisional pin generates no Kotlin: nothing it exports reaches main');
    writeExport(root, chosen.lock.out, chosen);
    assert.ok(!fs.existsSync(path.join(root, 'renderer/src/test/resources/world/shaders')), 'the provisional copy is gone');
    assert.deepEqual(compareExport(root, chosen.lock.out, chosen), []);
    assert.deepEqual(verifyCommitted(root).problems, []);
    // the Kotlin table names every stage with its sha256, so a renderer can never load bytes the pin did not export
    const kt = fs.readFileSync(path.join(root, KOTLIN_FILE), 'utf8');
    for (const [rel, sha] of Object.entries(chosen.lock.stages)) assert.ok(kt.includes(`Stage("${rel}", "${sha}"`), rel);
    assert.match(kt, /"globe-sky" to Program\("globe-sky"/);
    assert.match(kt, /"demo\+FAST" to Program\("demo\+FAST", "demo", mapOf\("FAST" to ""\)/, 'a flag define maps to ""');
    fs.appendFileSync(path.join(root, KOTLIN_FILE), '// edited\n');
    assert.ok(compareExport(root, chosen.lock.out, chosen).includes(`changed ${KOTLIN_FILE}`));
    assert.ok(verifyCommitted(root).problems.includes(`${KOTLIN_FILE} is not the table of this index`));
    writeExport(root, chosen.lock.out, chosen);
    const lockPath = path.join(root, LOCK_FILE), lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    fs.writeFileSync(lockPath, JSON.stringify({ ...lock, chosenReason: ' ' }));
    assert.ok(verifyCommitted(root).problems.includes('a chosen pin records no chosenReason'));
  } finally { r.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a src/globe module is exported through the pin\'s own preprocessGLSL with its GLOBE_INCLUDES, and a malformed one fails', async () => {
  const flat = [
    'export const GLOBE_COMMON = `float half2(){return .5;}\n`;',
    'export const GLOBE_FLAT_VS = `#version 300 es\nin vec2 aPos;void main(){gl_Position=vec4(aPos,0.,1.);}\n`;',
    'export const GLOBE_FLAT_FS = `#version 300 es\n#include "globe-common"\nout vec4 o;void main(){o=vec4(half2());}\n`;',
    "export const GLOBE_PROGRAMS = [{ name: 'globe-flat', vs: 'GLOBE_FLAT_VS', fs: 'GLOBE_FLAT_FS' }];",
    "export const GLOBE_INCLUDES = { 'globe-common': 'GLOBE_COMMON' };",
    '',
  ].join('\n');
  const r = repo();
  try {
    for (const [rel, text] of Object.entries(GLOBE_FILES)) r.write(rel, text);
    r.write('../globe/flat.glsl.js', flat);
    const a = await exportShaders({ repo: r.dir, pin: r.commit(), chosen: 'flat' });
    assert.equal(a.files.get('globe-flat.fs.glsl').toString(), '#version 300 es\nprecision highp float;\n#define REALM_FS 1\n\nfloat half2(){return .5;}\n\nout vec4 o;void main(){o=vec4(half2());}\n// pinned-core\n');
    const index = JSON.parse(a.files.get('index.json'));
    assert.deepEqual(index.globe.map(p => [p.name, p.module]), [['globe-blit', 'src/shaders.js'], ['globe-flat', 'src/globe/flat.glsl.js'], ['globe-read-heights', 'src/shaders.js'], ['globe-sky', 'src/shaders.js']]);
    assert.ok(a.lock.sources['concepts/globe3d-2026-09-23/src/globe/flat.glsl.js']);
    assert.match(a.kotlin.toString(), /"globe-flat" to Program\("globe-flat", "globe-flat", emptyMap\(\), false, "draw"/);
  } finally { r.cleanup(); }
  for (const [text, error] of [
    [flat.replace("'GLOBE_COMMON' }", "'NOPE' }"), /include globe-common names NOPE/],
    [flat.replace("name: 'globe-flat'", "name: 'flat'"), /is not \{ name: 'globe-…', vs, fs \}/],
    [flat.replace("fs: 'GLOBE_FLAT_FS'", "fs: 'GLOBE_FLAT_FS2'"), /FS names GLOBE_FLAT_FS2/],
    [flat.replace('#include "globe-common"', '#include "missing"'), /unknown #include missing/],
  ]) {
    const b = repo();
    try {
      for (const [rel, t] of Object.entries(GLOBE_FILES)) b.write(rel, t);
      b.write('../globe/flat.glsl.js', text);
      await assert.rejects(exportShaders({ repo: b.dir, pin: b.commit(), chosen: 'x' }), error);
    } finally { b.cleanup(); }
  }
});
