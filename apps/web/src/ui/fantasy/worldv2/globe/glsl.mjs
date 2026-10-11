// The realm engine's GLSL preamble and preprocessor, verbatim from the pinned concept (02e9da84:
// concepts/globe3d-2026-09-23/src/realm/glsl/common.glsl.js PREAMBLE and src/realm/core.js preprocessGLSL). The globe
// chunk carries its own copy so it never loads the realm engine: native's exporter runs flat.glsl.js through exactly
// this function, and stages.test.mjs pins every preprocessed stage to native's world-shaders.lock.json sha256 (R14:
// web and native draw the same bytes).
import * as FLAT from './flat.glsl.js';

export const PREAMBLE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
`;

/** PREAMBLE + REALM_VS/REALM_FS + the #defines + the source with every #include "name" resolved once (includes: Map). */
export function preprocessGLSL(src, { kind, defines = {}, includes, name = '?' }) {
  const resolve = (s, seen) => s.replace(/^[ \t]*#include[ \t]+"([\w.-]+)"[ \t]*$/gm, (_, n) => {
    if (seen.has(n)) return `// #include "${n}" (already included)`;
    if (!includes.has(n)) throw Error(`realm shader ${name}: unknown #include "${n}"`);
    seen.add(n); return resolve(includes.get(n), seen);
  });
  const body = src.replace(/^\s*#version[^\n]*\n/, '');
  const defs = Object.entries(defines || {}).map(([k, v]) => `#define ${k}${v === true ? '' : ' ' + v}`).join('\n');
  return PREAMBLE + `#define REALM_${kind} 1\n` + defs + '\n' + resolve(body, new Set());
}

const INCLUDES = new Map(Object.entries(FLAT.GLOBE_INCLUDES).map(([k, id]) => [k, FLAT[id]]));

/** The globe's three programs as native exports them: name → { vs, fs } preprocessed stages. */
export function globeStages() {
  const out = {};
  for (const p of FLAT.GLOBE_PROGRAMS) out[p.name] = {
    vs: preprocessGLSL(FLAT[p.vs], { kind: 'VS', defines: {}, includes: INCLUDES, name: p.name }),
    fs: preprocessGLSL(FLAT[p.fs], { kind: 'FS', defines: {}, includes: INCLUDES, name: p.name }),
  };
  return out;
}

// The dive's cloud cover (native GlobeDiveCover, owner 2026-09-26: "clouds covering the screen between the globe and
// the map … to mitigate the feeling of a freeze"). Native builds it on the realm engine's rm-lowres-blit stages; the
// globe chunk never loads the realm engine, so its full-screen stages are written here with native's BODY verbatim.
// It samples the globe's resident c512 cloud array (R8, six faces) in screen space. uCover = (amount, drift seconds,
// buffer width, buffer height).
export const COVER_BODY = 'uniform highp sampler2DArray uCloud;\nuniform vec4 uCover;\nout vec4 o;\n' +
  'float cloudAt(vec2 p, float face) { vec2 m = abs(fract(p * 0.5) * 2.0 - 1.0); return texture(uCloud, vec3(m, face)).r; }\n' +
  'void main() {\n' +
  '  vec2 p = gl_FragCoord.xy / max(uCover.z, uCover.w);\n' +
  '  float t = uCover.y;\n' +
  '  float n = cloudAt(p * 1.1 + vec2(t * 0.020, t * 0.006), 0.0) * 0.65 + cloudAt(p * 2.3 - vec2(t * 0.011, 0.0), 3.0) * 0.35;\n' +
  '  float th = mix(1.12, -0.32, uCover.x);\n' +
  '  float a = smoothstep(th - 0.14, th + 0.14, n);\n' +
  '  vec3 c = mix(vec3(0.72, 0.78, 0.88), vec3(0.97, 0.98, 1.0), clamp(n * 1.2, 0.0, 1.0));\n' +
  '  o = vec4(c, a);\n' +
  '}\n';
export const COVER_VS = PREAMBLE + 'layout(location=0) in vec2 aPos;\nvoid main(){gl_Position=vec4(aPos,0.,1.);}\n';
export const COVER_FS = PREAMBLE + COVER_BODY;
