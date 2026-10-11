// Realm-map BASES shaders (plan §6, §7; GLSL ES 3.00, plain strings for the native port). BASES lane.
// One instanced sprite program draws every base sprite from its size-class texture array: live keeps,
// marker icons, MAP mini-sprites (the plot impostor), TRUE decor/walls/plot edges, torch fire and smoke.
// Instances carry everything (no per-sprite tables), so one draw per array.
//
// Instance layout (16 floats):
//   iA = seatX, seatY (deed space), footY (deed, depth key), hash (0..1)
//   iQ = quad x0, y0, x1, y1 relative to the seat, in TILES (1 deed = 98 tiles)
//   iT = layer0, frames, frameMs, phase
//   iU = uMax, vMax (trimmed frame extent in the layer, 0..1), kind, flags
// kind: 0 TRUE decor (on where dissolve(h, uTrueW)), 1 MAP mini-sprite (on where !dissolve(h, uTrueW)),
//       2 live keep, 3 marker icon, 4 smoke puff (rises and fades), 5 always-on sprite.
// flags: 1 = filtered out (dimmed), 2 = yours.

export const SPRITE_VS = `
#include "common"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iQ;
layout(location = 3) in vec4 iT;
layout(location = 4) in vec4 iU;
uniform float uTrueW;   // MAP→TRUE dissolve weight: 0 at d ≤ 800, 1 at d ≥ 1100 (plan §2.3)
uniform float uMinPx;   // anti-speckle: sprites under this on-screen height (device px) are hidden (§2.3)
uniform vec2 uWind;     // smoke drift, tiles per rise
out vec2 vUV;
out float vFade;
flat out float vLayer;
flat out float vFlags;
void main() {
  float kind = iU.z;
  uint h = uint(iA.w * 65535.0);
  bool on = true;
  if (kind < 0.5) on = dissolve(h, uTrueW);
  else if (kind < 1.5) on = !dissolve(h, uTrueW);
  float k = uCam.z / 98.0;                              // CSS px per tile
  vec2 seat = iA.xy;
  vFade = 1.0;
  if (kind > 3.5 && kind < 4.5) {                       // smoke: rises 12 art px (0.375 t) over 2 s, drifts with the wind
    float t = uViewport.w > 0.5 ? 0.35 : fract((float(uClock.x) + iT.w * 2000.0) / 2000.0);
    seat += (vec2(uWind.x * t, -0.375 * t)) / 98.0;
    vFade = 1.0 - smoothstep(0.55, 1.0, t);
  }
  vec2 sc = deedToCss(seat);
  vec2 p0 = sc + iQ.xy * k, p1 = sc + iQ.zw * k;
  float hDev = (p1.y - p0.y) * uCam.w;
  // flags (iU.w): bit 0 dimmed (filter), bit 1 a structure mini, bit 2 a wall mini. Fix iteration 2 (QA 4, "L1 … L13
  // all read as the same pale square at d 300"): a building's MAP mini is never dropped as a speckle — it grows about
  // its seat to uMinPx (≤ 2×), so the level's towers and halls read; wall minis are never hidden (a ring, not a speck)
  float fl = iU.w;
  bool grow = kind > 0.5 && kind < 1.5 && mod(floor(fl / 2.0), 2.0) > 0.5, wallMini = kind > 0.5 && kind < 1.5 && fl > 3.5;
  if (grow && hDev < uMinPx) {
    float g = min(uMinPx / max(hDev, 1e-3), 2.0);
    p0 = sc + (p0 - sc) * g; p1 = sc + (p1 - sc) * g;
  } else if (kind < 1.5 && hDev < uMinPx && !wallMini) { // hashed ramp 2/3·min … min: a whole sprite appears, never a speckle
    float r = clamp((hDev - uMinPx * 0.66) / (uMinPx * 0.34), 0.0, 1.0);
    if (!dissolve(h * 2654435761u, r)) on = false;
  }
  float foot = deedToCss(vec2(iA.x, iA.z)).y;
  gl_Position = on ? cssToClip(mix(p0, p1, aCorner), spriteDepth(foot)) : vec4(2.0, 2.0, 2.0, 1.0);
  float frame = 0.0;
  if (iT.y > 1.5 && uViewport.w < 0.5) frame = mod(floor(float(uClock.x) / max(iT.z, 1.0)) + iT.w, iT.y);
  vLayer = iT.x + frame;
  vUV = aCorner * iU.xy;
  vFlags = iU.w;
}`;

export const SPRITE_FS = `
#include "common"
uniform highp sampler2DArray uTex;
uniform vec2 uLayerSize;
uniform float uBlend;    // 1 = alpha-blended pass (smoke), 0 = alpha-tested
uniform float uShadeArt; // art px per deed for the cloud shade (3136 TRUE, 448 MAP), 0 = off
in vec2 vUV;
in float vFade;
flat in float vLayer;
flat in float vFlags;
out vec4 frag;
void main() {
  vec2 px = vUV * uLayerSize;
  vec2 fw = fwidth(px);
  vec2 sp = sharpUV(px);
  vec4 c = max(fw.x, fw.y) < 1.0
    ? textureLod(uTex, vec3(sp / uLayerSize, vLayer), 0.0)   // magnified: crisp texel snap
    : texture(uTex, vec3(vUV, vLayer));                        // minified: reducer-built mips
  if (uBlend > 0.5) {
    c.a *= vFade * 0.85;
    if (c.a < 0.02) discard;
    frag = vec4(c.rgb * c.a, c.a);
    return;
  }
  if (c.a < 0.5) discard;
  if (mod(vFlags, 2.0) > 0.5) { float l = dot(c.rgb, vec3(0.3, 0.59, 0.11)); c.rgb = mix(c.rgb, vec3(l), 0.55) * 0.6; }
  if (uShadeArt > 0.0) c.rgb *= cloudShade(fragDeed(), uShadeArt);
  frag = vec4(c.rgb, 1.0);
}`;

// Occupancy dots (FAR) with the known-shield halo, drawn flat on top (plan §2.2 FAR row, §6.5 FAR LOD).
// iA = x, y (deed centre), sizeCss, hash; iB = r, g, b, halo (1 = known shield); iC = alpha, ring, -, -
export const DOT_VS = `
#include "common"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iB;
layout(location = 3) in vec4 iC;
out vec2 vP;
flat out vec4 vCol;
flat out vec4 vX;
void main() {
  float pad = iB.w > 0.5 ? iA.z * 1.6 + 3.0 : iA.z * 0.5 + 1.0;
  vec2 c = floor(deedToCss(iA.xy) * uCam.w + 0.5) / uCam.w;   // centre on the device-pixel grid
  vP = (aCorner - 0.5) * 2.0 * pad;
  gl_Position = cssToClip(c + vP, 0.0);
  vCol = iB; vX = vec4(iA.z, iC.x, iC.y, 0.0);
}`;

export const DOT_FS = `
#include "common"
in vec2 vP;
flat in vec4 vCol;
flat in vec4 vX;
out vec4 frag;
void main() {
  float half_ = vX.x * 0.5, a = 0.0;
  vec3 col = vCol.rgb;
  vec2 q = abs(vP);
  if (max(q.x, q.y) <= half_) { a = vX.y; if (vX.x >= 3.5 && max(q.x, q.y) > half_ - 1.0 / uCam.w) col *= 0.5; }   // square dot; 1-device-px dark rim from 4 px
  if (vCol.a > 0.5) {                                                                                 // faint cyan halo (known shield)
    float r = length(vP), ring = half_ * 1.6 + 1.5;
    float hal = (1.0 - smoothstep(0.5, 1.1, abs(r - ring))) * 0.32 * (uViewport.w > 0.5 ? 1.0 : 0.8 + 0.2 * sin(float(uClock.y) * 0.0021));
    if (a < 0.01) { a = hal; col = vec3(0.5, 0.89, 1.0); }
  }
  if (a < 0.01) discard;
  frag = vec4(col * a, a);
}`;

// FX quads: additive glow discs (torches, braziers, campfires, lamps) and procedural keep pennants.
// iA = x, y (deed), footY (deed), hash; iB = w, h (tiles), kind (0 glow, 1 pennant), flicker/wave;
// iC = r, g, b, a
export const FX_VS = `
#include "common"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iB;
layout(location = 3) in vec4 iC;
out vec2 vP;
flat out vec4 vB;
flat out vec4 vC;
flat out float vH;
void main() {
  float k = uCam.z / 98.0;
  vec2 c = deedToCss(iA.xy);
  vec2 half_ = iB.xy * 0.5 * k;
  vec2 css = iB.z < 0.5 ? c + (aCorner - 0.5) * 2.0 * half_ : c + vec2(aCorner.x * iB.x, (aCorner.y - 1.0) * iB.y) * k;
  vP = iB.z < 0.5 ? (aCorner - 0.5) * 2.0 : aCorner;
  float foot = deedToCss(vec2(iA.x, iA.z)).y;
  gl_Position = cssToClip(css, spriteDepth(foot));
  vB = iB; vC = iC; vH = iA.w;
}`;

export const FX_FS = `
#include "common"
in vec2 vP;
flat in vec4 vB;
flat in vec4 vC;
flat in float vH;
out vec4 frag;
void main() {
  bool rm = uViewport.w > 0.5;
  if (vB.z < 0.5) {                                   // glow disc, quantised to 8 rings, flickering ±flicker
    float r = length(vP);
    if (r > 1.0) discard;
    float fl = rm ? 0.0 : vB.w * sin(float(uClock.x) * 0.019 + vH * 40.0) * sin(float(uClock.x) * 0.007 + vH * 13.0);
    float a = vC.a * (1.0 + fl) * pow(1.0 - floor(r * 8.0) / 8.0, 1.6);
    frag = vec4(vC.rgb * a, 0.0);                     // additive (ONE, ONE)
    return;
  }
  // pennant: a 5×3 art-px triangle on a 1-px pole tip, waving in 3 frames of 160 ms (plan §6.4)
  vec2 q = floor(vP * vec2(6.0, 4.0));                // 6 × 4 art px cell grid (pole column 0)
  float frame = rm ? 0.0 : mod(floor(float(uClock.x) / 160.0) + floor(vH * 3.0), 3.0);
  float x = q.x - 1.0, wave = x > 1.0 ? (frame == 1.0 ? 1.0 : frame == 2.0 ? -1.0 : 0.0) * step(3.0, x) : 0.0;
  float yTop = 0.0 + wave, rows = max(1.0, 3.0 - floor(x * 0.6));
  bool pole = q.x == 0.0;
  bool flag = x >= 0.0 && x < 5.0 && q.y >= yTop && q.y < yTop + rows;
  if (!pole && !flag) discard;
  vec3 col = pole ? vec3(0.22, 0.17, 0.12) : vC.rgb * (q.y == yTop + rows - 1.0 && rows > 1.0 ? 0.72 : 1.0);
  frag = vec4(col, 1.0);
}`;

// Tended ground under a kingdom's farmland (round 2, T3): field soil, pen / camp earth, the gate lanes (one cell
// per tile) and the paths joining neighbouring kingdoms (one capsule per path segment). Drawn in the 'shadow'
// pass, flat on the ground under every sprite. The SAME program draws MAP and TRUE (only the art-px grid
// differs: 448 or 3136 art px per deed), so the fields keep their shape and colour through the MAP→TRUE fade.
// Edges wobble on open sides (value noise in world tiles, so neighbouring cells agree), convex corners are
// rounded, a 1-art-px darker rim outlines every patch; fields get furrows at TRUE; paths lift to a lighter crown.
// iA = cells: cell rect x0, y0, x1, y1 (deed); segments: a.x, a.y, b.x, b.y (deed)
// iB = kind + 4·tint (kind 0 field, 1 pen/camp, 2 lane cell, 3 path segment), open-side mask (1 N, 2 E, 4 S, 8 W:
//      a set bit = the neighbour is the same ground; on a path segment: 0 dry, 1 ford span, 2 bridge span), seed
//      (0..1), alpha
// P0 (RM-GPU-1, fix iteration 2 rerun): this program reads NO terrain per pixel. Where a path meets water is decided
// once on the CPU (decor.settlePath over GROUND's classAt): the crossing span arrives flagged, a bridge span is left
// to the kit bridge sprite, a ford span gets stepping stones over its wet middle (settlePath puts the water 0.5–1 t
// inside each end). The old per-fragment classAtTile ran GROUND's full §3.2 classifier near every shore.
export const FIELD_VS = `
#include "common"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iB;
uniform float uPathHW;   // path half width (tiles)
out vec2 vT;             // world tiles
flat out vec4 vA;
flat out vec4 vB;
void main() {
  float kind = mod(iB.x, 4.0);
  vec2 deed;
  if (kind < 2.5) deed = mix(iA.xy, iA.zw, aCorner);
  else {
    vec2 a = iA.xy * 98.0, b = iA.zw * 98.0, d = b - a;
    float len = max(length(d), 1e-3), e = uPathHW + 0.8;
    vec2 t = d / len, n = vec2(-t.y, t.x), q = mix(vec2(-e), vec2(len + e, e), aCorner);
    deed = (a + t * q.x + n * q.y) / 98.0;
  }
  vT = deed * 98.0;
  gl_Position = cssToClip(deedToCss(deed), 0.0);
  vA = iA; vB = iB;
}`;

export const FIELD_FS = `
#include "common"
uniform vec3 uSoil[3];      // field soil, pen / camp earth, road
uniform highp sampler2DArray uRoad;   // the realm kit's road tiles (ROAD terrain pure layers), 32 art px per tile
uniform float uRoadN;       // layers in uRoad (0 = none: flat uSoil[2])
uniform float uArtPx;       // art px per deed (448 MAP, 3136 TRUE)
uniform float uPathHW;
uniform float uFade;        // the whole layer fades in over the impostor band (d 150→250)
in vec2 vT;
flat in vec4 vA;
flat in vec4 vB;
out vec4 frag;
float fh(vec2 p) { return u01(pcg2d(uvec2(ivec2(floor(p)) + 65536)).x); }
float vn1(float x, float s) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(u01(pcg2d(uvec2(uint(int(i) + 65536), uint(s * 977.0))).x), u01(pcg2d(uvec2(uint(int(i) + 65537), uint(s * 977.0))).x), f); }
void main() {
  float apt = uArtPx / 98.0;                               // art px per tile
  vec2 T = (floor(vT * apt) + 0.5) / apt;                  // every fragment of one art px agrees (pixel art)
  float px = 1.0 / apt, dev = 98.0 / (uCam.z * uCam.w), rim = max(px, dev);
  float kind = mod(vB.x, 4.0), tint = floor(vB.x / 4.0), seed = vB.z;
  float edge, across = 0.0;
  bool stone = false;
  int m = int(vB.y + 0.5);
  if (kind < 2.5 && m >= 16) {                             // a concave-corner fillet (bases.js): quad widened 0.5 t
    vec2 l = T - (vA.xy * 98.0 + 0.5);                     // 0..1 = the empty cell beside the corner
    float amp = kind > 1.5 ? 0.12 : 0.2, r = 0.42, e = rim * 1.5;
    // the neighbours' own wobbling insets at this point (the same noise the cells use), so the arc meets them tangentially
    float iSn = 0.04 + amp * vn1(T.x * 0.9, 2.0 + seed), iNs = 0.04 + amp * vn1(T.x * 0.9, 1.0 + seed);
    float iWe = 0.04 + amp * vn1(T.y * 0.9, 3.0 + seed), iEw = 0.04 + amp * vn1(T.y * 0.9, 4.0 + seed);
    edge = -1.0;
    if ((m & 16) != 0) { vec2 cc = vec2(1.0 + iWe - r, -iSn + r); if (l.x > cc.x && l.x <= 1.0 + iWe + e && l.y < cc.y && l.y >= -iSn - e) edge = max(edge, length(l - cc) - r); }
    if ((m & 32) != 0) { vec2 cc = vec2(1.0 + iWe - r, 1.0 + iNs - r); if (l.x > cc.x && l.x <= 1.0 + iWe + e && l.y > cc.y && l.y <= 1.0 + iNs + e) edge = max(edge, length(l - cc) - r); }
    if ((m & 64) != 0) { vec2 cc = vec2(-iEw + r, 1.0 + iNs - r); if (l.x < cc.x && l.x >= -iEw - e && l.y > cc.y && l.y <= 1.0 + iNs + e) edge = max(edge, length(l - cc) - r); }
    if ((m & 128) != 0) { vec2 cc = vec2(-iEw + r, -iSn + r); if (l.x < cc.x && l.x >= -iEw - e && l.y < cc.y && l.y >= -iSn - e) edge = max(edge, length(l - cc) - r); }
  } else if (kind < 2.5) {
    vec2 c0 = vA.xy * 98.0, l = T - c0;                    // 0..1 inside the cell
    bool oN = (m & 1) != 0, oE = (m & 2) != 0, oS = (m & 4) != 0, oW = (m & 8) != 0;
    float amp = kind > 1.5 ? 0.12 : 0.2;
    float iN = 0.04 + amp * vn1(T.x * 0.9, 1.0 + seed), iS = 0.04 + amp * vn1(T.x * 0.9, 2.0 + seed);
    float iW = 0.04 + amp * vn1(T.y * 0.9, 3.0 + seed), iE = 0.04 + amp * vn1(T.y * 0.9, 4.0 + seed);
    edge = 9.0;
    if (!oN) edge = min(edge, l.y - iN);
    if (!oS) edge = min(edge, 1.0 - l.y - iS);
    if (!oW) edge = min(edge, l.x - iW);
    if (!oE) edge = min(edge, 1.0 - l.x - iE);
    float r = 0.42;                                         // convex corners are round
    if (!oN && !oW) { vec2 cc = vec2(iW + r, iN + r); if (l.x < cc.x && l.y < cc.y) edge = min(edge, r - length(l - cc)); }
    if (!oN && !oE) { vec2 cc = vec2(1.0 - iE - r, iN + r); if (l.x > cc.x && l.y < cc.y) edge = min(edge, r - length(l - cc)); }
    if (!oS && !oW) { vec2 cc = vec2(iW + r, 1.0 - iS - r); if (l.x < cc.x && l.y > cc.y) edge = min(edge, r - length(l - cc)); }
    if (!oS && !oE) { vec2 cc = vec2(1.0 - iE - r, 1.0 - iS - r); if (l.x > cc.x && l.y > cc.y) edge = min(edge, r - length(l - cc)); }
  } else {
    vec2 a = vA.xy * 98.0, b = vA.zw * 98.0, d = b - a;
    float len = max(length(d), 1e-3);
    vec2 t = d / len, n = vec2(-t.y, t.x);
    float al = dot(T - a, t);
    across = dot(T - a, n);
    float dist = al < 0.0 ? length(T - a) : al > len ? length(T - b) : abs(across);
    vec2 w = T;                                             // wobble in world tiles: the joins of two segments agree
    float hw = uPathHW * (0.82 + 0.36 * vn1(w.x * 0.37 + w.y * 0.23, 7.0));
    edge = hw - dist;
    if (vB.y > 1.5) discard;                                // a bridge span: the kit bridge sprite covers it bank to bank
    if (vB.y > 0.5 && al > 0.5 && al < len - 0.5) {         // a ford span's wet middle: stepping stones only
      float u = (fract(al / 0.8) - 0.5) * 0.8, sd = length(vec2(u / 0.26, across / 0.34));
      if (sd > 1.0) discard;
      stone = true; edge = (1.0 - sd) * 0.3;
    }
  }
  if (edge < 0.0) discard;
  vec3 col = stone ? vec3(0.6, 0.58, 0.54) : kind < 0.5 ? uSoil[0] : kind < 1.5 ? uSoil[1] : uSoil[2];
  bool kitRoad = kind > 1.5 && !stone && uRoadN > 0.5;
  if (kitRoad) {                                            // lanes + paths: the kit's own road tile, one variant per tile
    float li = floor(u01(pcg2d(uvec2(ivec2(floor(T)) + 131072)).x) * uRoadN);
    col = textureGrad(uRoad, vec3(fract(T), min(li, uRoadN - 1.0)), dFdx(vT), dFdy(vT)).rgb;   // mips: the true mean at MAP
  }
  col *= kind < 0.5 ? 0.9 + 0.06 * tint : 1.0;              // each field its own shade of tilled earth
  float s = fh(T * apt + seed * 131.0);
  if (!kitRoad) { if (s < 0.07) col *= 0.84; else if (s > 0.94) col *= 1.1; }  // grit (the kit tile has its own)
  bool trueArt = apt > 16.0;
  if (kind < 0.5 && trueArt && fract(T.y * apt / 6.0) < 0.34) col *= 0.8;          // furrows every 6 art px
  if (kind > 2.5 && !kitRoad) { float c = abs(across) / max(uPathHW, 1e-3); col *= c < 0.35 ? 1.06 : 1.0; if (trueArt && abs(c - 0.55) < 0.12) col *= 0.9; }
  if (edge < rim) col *= kitRoad ? 0.86 : 0.74;             // 1-art-px darker rim (a soft kerb on a kit road)
  col *= cloudShade(T / 98.0, uArtPx);
  float al = vB.w * uFade;
  frag = vec4(col * al, al);
}`;
