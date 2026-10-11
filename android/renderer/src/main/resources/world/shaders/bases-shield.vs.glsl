#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_VS 1



layout(std140) uniform RealmView {
  vec4 uCam;
  vec4 uViewport;
  vec4 uGrid;
  vec4 uBand;
  vec4 uLod;
  vec4 uSel;
  uvec4 uClock;
};

// ---- screen ↔ deed space ------------------------------------------------------------------------
vec2 deedToCss(vec2 deed) { return (deed - uCam.xy) * uCam.z + uViewport.xy * 0.5; }
vec2 cssToDeed(vec2 css) { return uCam.xy + (css - uViewport.xy * 0.5) / uCam.z; }
vec4 cssToClip(vec2 css, float depth) { return vec4(css.x / uViewport.x * 2.0 - 1.0, 1.0 - css.y / uViewport.y * 2.0, depth, 1.0); }
#ifdef REALM_FS
// deed-space position of this fragment (gl_FragCoord is device px, origin bottom-left)
vec2 fragCss() { return vec2(gl_FragCoord.x, uViewport.y * uCam.w - gl_FragCoord.y) / uCam.w; }
vec2 fragDeed() { return cssToDeed(fragCss()); }
#endif

// ---- integer hashes (plan §3.1): kitHash is the kit's realmKitTileHash, verbatim ---------------------
uint kitHash(int tx, int ty) {
  uint h = uint(tx) * 0x27d4eb2du ^ uint(ty) * 0x165667b1u ^ 0x5bd1e995u;
  h ^= h >> 15u; h *= 0x2c1b3c6du; h ^= h >> 12u; h *= 0x297a2d39u; h ^= h >> 15u; return h;
}
uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v = v ^ (v >> 16u);
  return v;
}
float u01(uint h) { return float(h >> 8u) * (1.0 / 16777216.0); }
// value noise on an integer lattice: v in tiles (or any integer unit), period = feature size in the
// same unit, seed decorrelates layers. Returns −1..1. Bilinear with smoothstep weights, float maths only
// after the integer hash, so the JS twin (vnoiseJs) matches to float rounding.
float vnoise(ivec2 v, int period, uint seed) {
  ivec2 c = ivec2(floor(vec2(v) / float(period)));
  vec2 f = (vec2(v) - vec2(c) * float(period)) / float(period);
  f = f * f * (3.0 - 2.0 * f);
  float a = u01(pcg2d(uvec2(c) ^ uvec2(seed, seed * 7u)).x);
  float b = u01(pcg2d(uvec2(c + ivec2(1, 0)) ^ uvec2(seed, seed * 7u)).x);
  float cc = u01(pcg2d(uvec2(c + ivec2(0, 1)) ^ uvec2(seed, seed * 7u)).x);
  float d = u01(pcg2d(uvec2(c + ivec2(1, 1)) ^ uvec2(seed, seed * 7u)).x);
  return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y) * 2.0 - 1.0;
}
// 4×4 ordered-dither threshold in [0, 1)
float bayer4(ivec2 p) {
  int i = (p.x & 3) + ((p.y & 3) << 2);
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0;
}
#ifdef REALM_FS
// sharp sampling: texel-centre snap inside an fwidth window (crisp magnification, AA at texel edges).
// px = texel coordinate (texels, not uv); returns the snapped texel coordinate. Fragment stage only.
vec2 sharpUV(vec2 px) {
  vec2 fw = max(fwidth(px), vec2(1e-4));
  vec2 sn = floor(px + 0.5);
  return sn + clamp((px - sn) / fw, -0.5, 0.5);
}
#endif
// quantise a position to the centre of its art pixel (artPxPerUnit art px per unit of p)
vec2 quantise(vec2 p, float artPxPerUnit) { return (floor(p * artPxPerUnit) + 0.5) / artPxPerUnit; }
// y-sort depth for sprites (life and bases share it): lower on screen = nearer = smaller depth.
// footScreenY in CSS px; stays monotonic for feet up to one screen height off either edge.
float spriteDepth(float footScreenY) {
  float t = clamp((footScreenY + uViewport.y) / (3.0 * uViewport.y), 0.0, 1.0);
  return (1.0 - t) * 1.96 - 0.98;
}
// plot offset (round 2, contracts.js plotOffset): a claimed plot's centre is deed-local 49 + offset, whole
// tiles. room = contracts.plotRoom(level), uploaded by the caller (16 at L1 … 5 at L20). Integer maths only.
uint plotHash(ivec2 d) {
  uint h = uint(d.x) * 0x8da6b343u ^ uint(d.y) * 0xd8163841u ^ 0x6a09e667u;
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u; return h;
}
int plotAxis(uint v, int room) { int t = int(v) * 2 - 65535; int m = (abs(t) * room + 32767) / 65535; return t < 0 ? -m : m; }
ivec2 plotOffset(ivec2 deed, int room) { uint h = plotHash(deed); return ivec2(plotAxis(h & 0xffffu, room), plotAxis(h >> 16u, room)); }
// per-instance hashed switch (dissolve): true = this instance is on at weight w. Never an alpha blend.
bool dissolve(uint h, float w) { return float(h & 0xffffu) < w * 65536.0; }
// cloud shadow (A6): drifting value noise, never ordered-dithered. Returns a multiplier (1 − 0.10 inside).
// deed = deed-space position; artPx = art px per deed of the layer being shaded (16 chart, 448 map, 3136 true).
// Where one art px spans ≥ 2 device px the shape is a hard step per art pixel (pixel-art edge); below that
// it is a 1-device-px anti-aliased edge. (Gate A OB-1: a Bayer-dithered 0.84 rim on the art-px grid read as
// a dot screen over every MAP field and as checker-rimmed stains on the FAR painting.)
// The field equals the old 64-units-per-deed lattice (periods 6 and 2.34 deeds), sampled 64× finer.
// Off below d 300, fading in over d 300→600 (fix iteration 1): at FAR a cloud is 12–140 device px, a stain on
// the painting (its light is baked); across the MAP band the value-noise contour is a smooth round blob several
// deeds wide, which read as pale discs / fog stains around kingdoms (critic: Sunscar d 200, real GPU d 48), not
// as a cloud shadow. It only ever darkens (a multiplier ≤ 1).
float cloudShade(vec2 deed, float artPx) {
  if (uViewport.w > 1.5) return 1.0;                             // GPU safe mode (P0 RM-GPU-1): optional pass off
  float k = 0.10 * clamp((uViewport.z - 300.0) / 300.0, 0.0, 1.0);
  if (k <= 0.0) return 1.0;
  float t = uViewport.w > 0.5 ? 0.0 : float(uClock.x) * 0.001;
  bool artEdge = uViewport.z >= 2.0 * artPx;                    // device px per art px ≥ 2
  vec2 q = (artEdge ? quantise(deed, artPx) : deed) + vec2(0.02, 0.008) * t; // drift 0.02 deed/s
  ivec2 lat = ivec2(floor(q * 4096.0));                          // 4096 lattice units per deed
  float n = vnoise(lat, 24576, 17u) * 0.65 + vnoise(lat, 9600, 29u) * 0.35;
  // Close up one 6-deed lattice cell spans the whole screen, and the smooth-step contour inside a cell is a
  // long straight diagonal (GA2-18: a seam at 1:1). Finer octaves (0.35 deed from d 300; 0.09 + 0.03 deed from
  // d 1200) fade in with the zoom and roughen the edge into a cloud's; below that they are skipped (uniform branch).
  float o3 = clamp((uViewport.z - 300.0) / 300.0, 0.0, 1.0), o4 = clamp((uViewport.z - 1200.0) / 1200.0, 0.0, 1.0);
  if (o3 > 0.0) n += vnoise(lat, 1433, 41u) * 0.12 * o3;           // vnoise is −1..1: the mean (0) is kept
  if (o4 > 0.0) n += (vnoise(lat, 367, 53u) * 0.07 + vnoise(lat, 131, 67u) * 0.035) * o4; // wisps at 1:1
  float cover = step(0.30, n);
#ifdef REALM_FS
  float w = max(fwidth(n), 1e-5);                                // uniform control flow (artEdge is uniform)
  if (!artEdge) cover = clamp((n - 0.30) / w + 0.5, 0.0, 1.0);
#endif
  return 1.0 - k * cover;
}

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iB;
uniform float uMode;   // 0 dome, 1 selection pulse
out vec2 vP;           // tiles from the centre, y UP
flat out vec4 vA;
flat out vec4 vB;
void main() {
  float rx = iA.z, k = uCam.z / 98.0;
  vec2 lo = uMode > 0.5 ? vec2(-rx * 1.25, -rx * 0.75) : vec2(-rx - 1.5, -0.55 * rx - 1.5);
  vec2 hi = uMode > 0.5 ? vec2(rx * 1.25, rx * 0.75) : vec2(rx + 1.5, 0.8 * rx + 1.5);
  vP = mix(lo, hi, aCorner);
  vec2 css = deedToCss(iA.xy) + vec2(vP.x, -vP.y) * k;
  float foot = deedToCss(vec2(iA.x, iB.y)).y;
  gl_Position = cssToClip(css, spriteDepth(foot));
  vA = iA; vB = iB;
}