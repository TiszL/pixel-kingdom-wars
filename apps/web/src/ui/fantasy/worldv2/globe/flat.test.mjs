// Rules for the shared flat-globe shader (GLOBE-NATIVE-PLAN §4.5, §4.6). No GL: string rules, the preprocessor the
// native exporter uses, and the cube addressing against the concept's own faceDir() (the builder's face layout).
// Ported from the concept (02e9da84 src/globe/flat.test.mjs) unchanged but for the preprocessor's home: the web globe
// chunk carries the realm engine's preprocessGLSL in glsl.mjs (stages.test.mjs pins it to native's lock).
//   node --test src/ui/fantasy/worldv2/globe
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ns from './flat.glsl.js';
import * as coreNs from './glsl.mjs';

// (tsx, which the realm tests need for packages/shared, may hand an ES module back as a CommonJS namespace)
const G = ns.GLOBE_PROGRAMS ? ns : ns.default;
const { preprocessGLSL } = coreNs.preprocessGLSL ? coreNs : coreNs.default;

const includes = new Map(Object.entries(G.GLOBE_INCLUDES).map(([k, v]) => [k, G[v]]));
const stages = () => G.GLOBE_PROGRAMS.flatMap(p => [['VS', p.vs], ['FS', p.fs]].map(([kind, id]) =>
  ({ name: `${p.name} ${kind}`, kind, src: preprocessGLSL(G[id], { kind, includes, name: p.name }) })));
const code = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');

test('every program names two exported stages and every #include resolves', () => {
  for (const p of G.GLOBE_PROGRAMS) for (const id of [p.vs, p.fs]) assert.equal(typeof G[id], 'string', `${p.name}: ${id}`);
  for (const s of stages()) {
    assert.ok(s.src.startsWith('#version 300 es\n'), `${s.name}: the preamble's #version comes first`);
    assert.ok(!/#include/.test(code(s.src).replace(/\/\/ #include[^\n]*/g, '')), `${s.name}: unresolved #include`);
  }
});

test('stages follow the web and native string rules (plan §4.5)', () => {
  for (const s of stages()) {
    const c = code(s.src);
    assert.ok(!c.includes('${'), `${s.name}: JS interpolation`);
    assert.ok(!/#extension/.test(c), `${s.name}: #extension`);
    assert.ok(!/\bwhile\b|\bdo\s*\{/.test(c), `${s.name}: while/do loop`);
    for (const m of c.matchAll(/for\s*\(([^;]*);([^;]*);([^)]*)\)/g)) {
      assert.match(m[1], /^\s*int\s+\w+\s*=\s*-?\d+\s*$/, `${s.name}: loop variable ${m[1]}`);
      const bound = m[2].match(/<\s*(\d+)\s*$/);
      assert.ok(bound && +bound[1] <= 64, `${s.name}: loop bound ${m[2]}`);
      assert.match(m[3], /^\s*\w+\s*\+\+\s*$/, `${s.name}: loop step ${m[3]}`);
    }
    const samplers = [...c.matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?[iu]?sampler\w+\s+([\w\s,]+);/g)].reduce((n, m) => n + m[1].split(',').length, 0);
    assert.ok(samplers <= 16, `${s.name}: ${samplers} samplers`);
    assert.ok(s.src.length <= 80000, `${s.name}: ${s.src.length} characters`);
  }
});

test('uniforms are vec4, float, int or samplers only (the native GL surface sets nothing else)', () => {
  for (const s of stages()) for (const m of code(s.src).matchAll(/uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?(\w+)\s+[^;]+;/g)) {
    if (/^(std140|layout)$/.test(m[1])) continue;
    assert.ok(/^(vec4|float|int|[iu]?sampler\w+)$/.test(m[1]), `${s.name}: uniform type ${m[1]}`);
  }
});

test('no smoothstep with reversed literal edges (undefined in GLSL; write 1.-smoothstep instead)', () => {
  for (const s of stages()) for (const m of code(s.src).matchAll(/smoothstep\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,/g)) {
    assert.ok(+m[1] < +m[2], `${s.name}: smoothstep(${m[1]},${m[2]},…)`);
  }
});

test('the fetch table stays within the globe budget of 12 per canvas px (plan §1.2)', () => {
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  assert.ok(sum(G.GLOBE_FETCHES.flat) + sum(G.GLOBE_FETCHES.isles) + sum(G.GLOBE_FETCHES.fx) <= 12);
  // one texture call per fetch the table counts (cubeTex and selField are one call each)
  const fs = code(G.GLOBE_FLAT_FS);
  assert.equal((fs.match(/cubeTex\(/g) ?? []).length, sum(G.GLOBE_FETCHES.flat) - G.GLOBE_FETCHES.flat.selection);
});

// JS twin of cubeUV (the face and s, t it picks), checked against the concept's faceDir(): the builder writes face f,
// texel (s, t) at faceDir(f, s, t), so a direction must come back to the same face and coordinates.
function faceDir(face, s, t) {
  const d = face === 0 ? [1, -t, -s] : face === 1 ? [-1, -t, s] : face === 2 ? [s, 1, t] : face === 3 ? [s, -1, -t] : face === 4 ? [s, -t, 1] : [-s, -t, -1];
  const l = Math.hypot(...d); return d.map(v => v / l);
}
function cubeUV([x, y, z]) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let p, face;
  if (ax >= ay && ax >= az) { const s = x < 0 ? -1 : 1; face = x < 0 ? 1 : 0; p = [-s * z, -y, s * x]; }
  else if (ay >= az) { const s = y < 0 ? -1 : 1; face = y < 0 ? 3 : 2; p = [x, s * z, s * y]; }
  else { const s = z < 0 ? -1 : 1; face = z < 0 ? 5 : 4; p = [s * x, -y, s * z]; }
  return { face, s: p[0] / p[2], t: p[1] / p[2] };
}

test('cube addressing returns faceDir(f, s, t) to (f, s, t) on every face (the builder layout)', () => {
  let n = 0;
  for (let f = 0; f < 6; f++) for (let i = 0; i < 41; i++) for (let j = 0; j < 41; j++) {
    const s = -0.975 + i * 0.04875, t = -0.975 + j * 0.04875, r = cubeUV(faceDir(f, s, t));
    assert.equal(r.face, f); assert.ok(Math.abs(r.s - s) < 1e-12 && Math.abs(r.t - t) < 1e-12, `face ${f} (${s}, ${t})`); n++;
  }
  assert.equal(n, 6 * 41 * 41);
  // and the GLSL is the same rule, line for line
  const fs = code(G.GLOBE_COMMON);
  for (const rule of ['p=vec3(-s*d.z,-d.y,s*d.x)', 'p=vec3(d.x,s*d.z,s*d.y)', 'p=vec3(s*d.x,-d.y,s*d.z)']) assert.ok(fs.includes(rule), rule);
});
