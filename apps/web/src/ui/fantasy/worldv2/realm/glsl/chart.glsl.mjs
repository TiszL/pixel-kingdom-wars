// GROUND lane — FAR band (plan §2.2): the painted ground-only chart in deed space (bilinear, mipped — the
// owner-liked overview), chart16 pages where resident (no deed lines: fix round 1 #11), sea glints and cloud
// shadows; no other-realm veil (owner 2026-09-26, see main). Units (contracts.UNITS.chart): 0 chart8 · 1 chart16
// pages · 2 deeds (still bound, no longer sampled) · 3 base state · 4 fieldsA. Drawn opaque when it is the bottom
// layer, or with uAlpha under a fade.

export const CHART_VS = `
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const CHART_FS = `
#include "common"
#include "rm-water"
uniform sampler2D uChart8;                 // 8 px/deed, mipped, linear
uniform highp sampler2DArray uChart16;     // 512² pages of the 16 px/deed chart, linear, no mips
uniform sampler2D uFieldsA;                // coast SDF for glints (nearest)
uniform ivec4 uC16Page[16];                // page index → layer + 1 (0 = not resident), 4 per ivec4
uniform ivec4 uC16Geo;                     // pages x, pages y, page px, on (0/1)
uniform vec3 uSeaFar;                      // the painting's open-sea colour (outside the grid, the frame and foreign fade)
uniform sampler2D uFar;                    // R8 linear: deeds from this realm's deeds × 16 (GA2-04)
uniform float uAlpha;
uniform vec4 uRhAt;                        // W1 G1, ground.rehearse only (0 otherwise): z > 0.5 → this fragment is deed point xy
out vec4 o;

// 1 for painted sea (blue clearly above red and green), 0 for land, snow or sand
float seaLike(vec3 c) { return smoothstep(0.02, 0.08, c.b - max(c.r, c.g)); }
int c16Layer(ivec2 pg) { int i = pg.y * uC16Geo.x + pg.x; if (i < 0 || i >= 64) return 0; return uC16Page[i >> 2][i & 3]; }
float coastAt(vec2 p) { // tiles; fieldsA texel centre at (i + 0.5)/8 deed (nearest here: glints only)
  ivec2 t = clamp(ivec2(floor(p * 8.0)), ivec2(0), textureSize(uFieldsA, 0) - 1);
  return (texelFetch(uFieldsA, t, 0).r * 255.0 - 128.0) * 2.0;
}
// GA2-04 (no chart frame): 1 = keep the painting, 0 = the open sea. Land painted beyond the foreign cut (rmForeignCut: a
// noisy 1.5…6.5 deeds from this realm) fades out; painted sea keeps 15 % of its texture only near the cut, so no ghost of a
// neighbour's land shows under the open sea (fix round 1 #9); within 3 deeds of the frame everything eases into the open
// sea. MAP applies the same rule and ground.js foreignSea makes the classes sea beyond the same cut.
float rmKeep(vec2 p, vec2 g, float sea) {
  float fd = texture(uFar, p / g).r * 16.0;
  vec2 e0 = min(p, g - p); if (fd <= 0.5 && min(e0.x, e0.y) >= 4.5) return 1.0; // most of the realm: no noise needed
  float cut = rmForeignCut(p), n = rmNoiseF(p * 4.0, 7, 0x4f1du) * 0.9 + rmNoiseF(p * 4.0, 3, 0x2a77u) * 0.35;
  float fw = smoothstep(cut - 0.45, cut + 0.45, fd) * mix(1.0, 0.85, sea * (1.0 - smoothstep(cut, cut + 1.0, fd))); // a coast, not a ghost
  float fe = 1.0 - smoothstep(0.0, 3.0, min(e0.x, e0.y) + n * 0.8);
  return (1.0 - fw) * (1.0 - fe);
}
void main() {
  vec2 p = uRhAt.z > 0.5 ? uRhAt.xy : fragDeed(), g = uGrid.xy;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, g))) { o = vec4(uSeaFar * cloudShade(p, 16.0), uAlpha); return; }
  vec3 col = texture(uChart8, p / g).rgb;
  if (uC16Geo.w > 0) {
    vec2 px = p * 16.0; ivec2 pg = ivec2(floor(px / float(uC16Geo.z)));
    int L = c16Layer(pg);
    if (L > 0) {
      vec2 lp = px - vec2(pg) * float(uC16Geo.z);
      col = textureLod(uChart16, vec3(lp / float(uC16Geo.z), float(L - 1)), 0.0).rgb;
    }
  }
  // sea glints on the painted sea (A1), per chart px
  float coast = coastAt(p);
  if (coast < -6.0 && uViewport.z > 6.0) col = mix(col, vec3(0.92, 0.97, 1.0), 0.55 * rmGlint(ivec2(floor(p * 16.0)), 0.004, uViewport.z / 16.0));
  // no deed lines at FAR (fix round 1 #11: the grid read as graph paper over the painting; MAP shows faint ones from d 150).
  // No other-realm veil either (owner 2026-09-26, Seeker, Crownlands at the FAR overview: "check crownland also have that
  // grey area on the edges, which sunscar had, fix it for all realms"): deeds the catalogue gives to another realm are
  // drawn as the realm art paints them, like MAP and TRUE. Only the soft foreign fade (rmKeep) eases far land into the sea.
  col = mix(uSeaFar, col, rmKeep(p, g, seaLike(col)));
  col *= cloudShade(p, 16.0);
  o = vec4(col, uAlpha);
}
`;
