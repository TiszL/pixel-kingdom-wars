#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_FS 1
#define RM_DBG_WMASK


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


#define RM_TILES 98
#define RM_FAR 1e4
#define RM_PAGE 99                    // baked line page: tile vertices 0…98 of a deed (classify.js BAKE.size)
uniform highp usampler2D uRmBase;     // RGBA8UI cols×rows: r kind, g flags, b claimTiles, a level (plan §6.1)
uniform sampler2D uRmFieldsA;         // RGB8 8 px/deed: coast SDF, lake SDF (128 + d/2 tiles), relief
// P0: R32UI line fields (ground.js linesTexture): 99² pages of packHalf2x16 pairs — river (sdf, amp) and land (track sdf,
// -) — uRmLinesGeo.x per row, then from row uRmLinesGeo.y three header words per deed: river page + 1 (bits 0–15) |
// downstream hint x, y (signed bytes, bits 16–31); land page + 1 (bits 0–15); the deed's G15 bridge (classify.js
// packBridge: angle in 1/65536 turns, length ½ t, half-width ¼ t; 0 = none)
uniform highp usampler2D uRmLineTex;
uniform ivec4 uRmLinesGeo;            // pages per row, first header row, texture width, -
uniform vec4 uRmBake;                 // what a deed without a page reads: cap (river / track sdf), river amp cap, -, -
uniform vec4 uRmPlot[21];             // per keep level: claim, ring, half, R
uniform ivec4 uRmGrid;                // cols, rows, -, 1 when any land bridge exists
uniform vec4 uRmFieldsPpd;            // ppdA, ppdBC, -, -
uniform ivec4 uRmCoast2;              // G10: fine coast octave period, seed (amp = uRmNoiseAmp.w)
uniform ivec4 uRmRoom4[6];            // G8: plot offset room per keep level (contracts.plotRoom), 4 per ivec4
// (P0 "classes-sampled": the noise and lake-warp terms the sampled near-water class needs live here, not in rm-classify)
uniform ivec4 uRmLakeWP;              // G14 lake warp: period, period2, seed, -
uniform vec4 uRmLakeW;                // G14 lake warp: amp, amp2, -, -
uniform vec4 uRmNoiseAmp;             // coast, inland, beach, coast octave 2 (G10)
uniform ivec4 uRmNoisePer;            // coast, inland, beach, parcel block
uniform uvec4 uRmNoiseSeed;           // coast, inland, beach, parcel salt

int rmFloorDiv(int a, int b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }
ivec2 rmDeedOf(ivec2 v) { return ivec2(rmFloorDiv(v.x, RM_TILES), rmFloorDiv(v.y, RM_TILES)); }
// level of the claimed plot on deed d (0 = none / out of grid)
int rmPlotLevel(ivec2 d) {
  if (d.x < 0 || d.y < 0 || d.x >= uRmGrid.x || d.y >= uRmGrid.y) return 0;
  uvec4 b = texelFetch(uRmBase, d, 0);
  if ((b.g & 1u) == 0u) return 0;
  return int(min(b.a, 20u));
}
float rmRoundedBox(vec2 p, float half_, float r) {
  vec2 q = abs(p) - vec2(half_ - r);
  return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
// G8: a plot's whole-tile offset from its deed centre (contracts.plotOffset) and its centre in tiles
ivec2 rmPlotOff(ivec2 d, int L) { return plotOffset(d, uRmRoom4[L >> 2][L & 3]); }
vec2 rmPlotC(ivec2 d, int L) { return vec2(d) * float(RM_TILES) + 49.0 + vec2(rmPlotOff(d, L)); }
// P0: the plot levels of the 3×3 deeds around tile point t, fetched once and shared by every plot function (k = (j + 1)·3
// + i + 1, the old loops' order)
struct RmNb { ivec2 d0; int L[9]; };
RmNb rmNb(vec2 t) {
  RmNb n; n.d0 = ivec2(floor(t / float(RM_TILES)));
  for (int k = 0; k < 9; k++) n.L[k] = rmPlotLevel(n.d0 + ivec2(k % 3 - 1, k / 3 - 1));
  return n;
}
ivec2 rmNbDeed(RmNb n, int k) { return n.d0 + ivec2(k % 3 - 1, k / 3 - 1); }
// rounded-box SDF (tiles, < 0 inside) of every claimed plot in the 3×3 deed neighbourhood of tile point t
float rmPlotSdfN(vec2 t, RmNb n) {
  float s = RM_FAR;
  for (int k = 0; k < 9; k++) { int L = n.L[k]; if (L == 0) continue; s = min(s, rmRoundedBox(t - rmPlotC(rmNbDeed(n, k), L), uRmPlot[L].z, 3.0)); }
  return s;
}
float rmPlotSdf(vec2 t) { return rmPlotSdfN(t, rmNb(t)); }
// manual bilinear of one channel of an 8-bit field (texel i centre at deed (i + 0.5)/ppd), value 0..255
float rmBilin(sampler2D s, vec2 t, float ppd, int ch, int x0, int w) {
  vec2 u = t * (ppd / float(RM_TILES)) - 0.5;
  vec2 fl = floor(u); ivec2 i0 = ivec2(fl); vec2 f = u - fl;
  int H = textureSize(s, 0).y;
  ivec2 a = clamp(i0, ivec2(0), ivec2(w - 1, H - 1)), b = clamp(i0 + 1, ivec2(0), ivec2(w - 1, H - 1));
  float v00 = texelFetch(s, ivec2(x0 + a.x, a.y), 0)[ch], v10 = texelFetch(s, ivec2(x0 + b.x, a.y), 0)[ch];
  float v01 = texelFetch(s, ivec2(x0 + a.x, b.y), 0)[ch], v11 = texelFetch(s, ivec2(x0 + b.x, b.y), 0)[ch];
  float top = v00 + (v10 - v00) * f.x, bot = v01 + (v11 - v01) * f.x;
  return (top + (bot - top) * f.y) * 255.0;
}
float rmCoastField(vec2 t) { return (rmBilin(uRmFieldsA, t, uRmFieldsPpd.x, 0, 0, textureSize(uRmFieldsA, 0).x) - 128.0) * 2.0; }
float rmLakeField(vec2 t) { return (rmBilin(uRmFieldsA, t, uRmFieldsPpd.x, 1, 0, textureSize(uRmFieldsA, 0).x) - 128.0) * 2.0; }
// P0: coast (x) and lake (y) SDFs at one point from the same four fieldsA texels (rmBilin's arithmetic per channel)
vec2 rmCoastLake(vec2 t) {
  vec2 u = t * (uRmFieldsPpd.x / float(RM_TILES)) - 0.5;
  vec2 fl = floor(u); ivec2 i0 = ivec2(fl); vec2 f = u - fl;
  ivec2 sz = textureSize(uRmFieldsA, 0);
  ivec2 a = clamp(i0, ivec2(0), sz - 1), b = clamp(i0 + 1, ivec2(0), sz - 1);
  vec2 v00 = texelFetch(uRmFieldsA, a, 0).rg, v10 = texelFetch(uRmFieldsA, ivec2(b.x, a.y), 0).rg;
  vec2 v01 = texelFetch(uRmFieldsA, ivec2(a.x, b.y), 0).rg, v11 = texelFetch(uRmFieldsA, b, 0).rg;
  vec2 top = v00 + (v10 - v00) * f.x, bot = v01 + (v11 - v01) * f.x;
  return ((top + (bot - top) * f.y) * 255.0 - 128.0) * 2.0;
}
// ---- P0: the baked line fields (see uRmLineTex) ----
uint rmHdr(ivec2 d, int w) {
  if (d.x < 0 || d.y < 0 || d.x >= uRmGrid.x || d.y >= uRmGrid.y) return 0u;
  int i = (d.y * uRmGrid.x + d.x) * 3 + w, W = uRmLinesGeo.z;
  return texelFetch(uRmLineTex, ivec2(i % W, uRmLinesGeo.y + i / W), 0).r;
}
vec2 rmPageAt(int pg, ivec2 l) { return unpackHalf2x16(texelFetch(uRmLineTex, ivec2(pg % uRmLinesGeo.x, pg / uRmLinesGeo.x) * RM_PAGE + l, 0).r); }
// the baked pair of page pg (deed d) at tile point q: the vertex itself at integer points, else the bilinear of its four
vec2 rmPageSample(int pg, ivec2 d, vec2 q) {
  vec2 l = q - vec2(d) * float(RM_TILES); ivec2 i = min(ivec2(floor(l)), ivec2(RM_TILES - 1)); vec2 f = l - vec2(i);
  vec2 a = rmPageAt(pg, i);
  if (f.x == 0.0 && f.y == 0.0) return a;
  return mix(mix(a, rmPageAt(pg, i + ivec2(1, 0)), f.x), mix(rmPageAt(pg, i + ivec2(0, 1)), rmPageAt(pg, i + ivec2(1, 1)), f.x), f.y);
}
// rivers at tile point q → (sdf, noise cap); w = the deed's river header word (downstream hint for the flow dashes)
vec2 rmRiverW(vec2 q, out uint w) {
  ivec2 d = ivec2(floor(q / float(RM_TILES))); w = rmHdr(d, 0);
  int pg = int(w & 0xffffu) - 1;
  return pg < 0 ? uRmBake.xy : rmPageSample(pg, d, q);
}
vec2 rmRiver(vec2 q) { uint w; return rmRiverW(q, w); }
// tracks at tile point q → (track sdf, -)
vec2 rmLand(vec2 q) {
  ivec2 d = ivec2(floor(q / float(RM_TILES)));
  int pg = int(rmHdr(d, 1) & 0xffffu) - 1;
  return pg < 0 ? vec2(uRmBake.x, 0.0) : rmPageSample(pg, d, q);
}
// value noise at a float point (classify.js vnoise with float input; = common vnoise at integer points), [−1, 1]
float rmVN(vec2 p, int period, uint seed) {
  vec2 cf = floor(p / float(period)); ivec2 c = ivec2(cf);
  vec2 f = (p - cf * float(period)) / float(period); f = f * f * (3.0 - 2.0 * f);
  uvec2 s = uvec2(seed, seed * 7u);
  float a = u01(pcg2d(uvec2(c) ^ s).x), b = u01(pcg2d(uvec2(c + ivec2(1, 0)) ^ s).x);
  float cc = u01(pcg2d(uvec2(c + ivec2(0, 1)) ^ s).x), d = u01(pcg2d(uvec2(c + ivec2(1, 1)) ^ s).x);
  return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y) * 2.0 - 1.0;
}
// G14: the lake lookup point of source point q (classify.js waterWarp)
// (P0 fix pass #1: the four noises as one literal loop — one inlined copy, x = W.x·n(P.x, s) + W.y·n(P.y, s + 2) and y
// likewise with s + 1 / s + 3, summed in the same order)
vec2 rmLakeWarp(vec2 q) {
  uint s = uint(uRmLakeWP.z); vec2 w = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    float n = (k < 2 ? uRmLakeW.x : uRmLakeW.y) * rmVN(q, k < 2 ? uRmLakeWP.x : uRmLakeWP.y, s + uint(k));
    if ((k & 1) == 0) w.x += n; else w.y += n;
  }
  return q + w;
}


// continuous twin of common's vnoise(ivec2, int, uint): identical at integer p (so per-pixel coasts agree
// with the resolved lattice classes), bilinear with smoothstep weights in between.
float rmNoiseF(vec2 p, int period, uint seed) {
  vec2 cf = floor(p / float(period));
  ivec2 c = ivec2(cf);
  vec2 f = (p - cf * float(period)) / float(period);
  f = f * f * (3.0 - 2.0 * f);
  uvec2 s = uvec2(seed, seed * 7u);
  float a = u01(pcg2d(uvec2(c) ^ s).x), b = u01(pcg2d(uvec2(c + ivec2(1, 0)) ^ s).x);
  float cc = u01(pcg2d(uvec2(c + ivec2(0, 1)) ^ s).x), d = u01(pcg2d(uvec2(c + ivec2(1, 1)) ^ s).x);
  return mix(mix(a, b, f.x), mix(cc, d, f.x), f.y) * 2.0 - 1.0;
}
// GA2-04 / fix round 1 #9: where this realm's chart hands over to the open sea — the cut distance (deeds from the realm's
// own deeds) wanders 1.5…6.5 deeds on 12-, 5-, 1.75- and 0.75-deed scales, so the foreign-land-is-sea coast is never a
// ruled chamfer line. ground.js foreignSea (the classes) evaluates the same function on the CPU.
float rmForeignCut(vec2 p) {
  vec2 q = p * 4.0; float n = 0.0;
  for (int k = 0; k < 4; k++) // (P0 fix pass #1: one inlined noise, the same octaves summed in the same order)
    n += (k == 0 ? 1.5 : k == 1 ? 0.8 : k == 2 ? 0.9 : 0.35) * rmNoiseF(q, k == 0 ? 48 : k == 1 ? 20 : k == 2 ? 7 : 3, k == 0 ? 0x6f13u : k == 1 ? 0x1d27u : k == 2 ? 0x4f1du : 0x2a77u);
  return clamp(3.5 - n, 1.5, 6.5);
}
bool rmStill() { return uViewport.w > 0.5; }
float rmMs() { return rmStill() ? 0.0 : float(uClock.x); }

// Art-px effects (dither, glints, broken foam) only while an art px covers ≥ 1 device px: below that they
// alias into moiré/speckle, so they blend smoothly instead (the rubric's no-speckle rule). dev = device px
// per art px of the calling layer.
float rmArtOn(float dev) { return clamp((dev - 0.9) / 0.3, 0.0, 1.0); }
vec3 rmSeaStep(float s, vec3 shallow, vec3 sea, vec3 deep) {
  return s < 1.0 ? mix(shallow, mix(shallow, sea, 0.6), s) : s < 2.0 ? mix(mix(shallow, sea, 0.6), sea, s - 1.0) : mix(sea, deep, clamp(s - 2.0, 0.0, 1.0));
}
// Depth step 0…3: crisp terraces; a 4×4 Bayer dither between terraces only when the art px is visible.
// (P0 fix pass #1: the 4×4 Bayer value by bit arithmetic, = common's bayer4 table 8(x0^y0) + 4y0 + 2(x1^y1) + y1 — no
// local array, which compiles a 16-entry table per inlined copy)
float rmBayer4(ivec2 p) { ivec2 b0 = p & 1, b1 = (p >> 1) & 1; return (float(8 * (b0.x ^ b0.y) + 4 * b0.y + 2 * (b1.x ^ b1.y) + b1.y) + 0.5) / 16.0; }
float rmDepthStep(float k, ivec2 artPx, float dev) {
  float d = rmArtOn(dev) > 0.5 ? rmBayer4(artPx) - 0.5 : 0.0;
  return clamp(floor(k + 0.5 + d), 0.0, 3.0);
}
// sea colour by depth: 4 palette steps between shallow and deep. coast < 0 in tiles; depthT = tiles to full depth.
vec3 rmSeaColour(float coast, ivec2 artPx, vec3 shallow, vec3 sea, vec3 deep, float depthT, float dev) {
  return rmSeaStep(rmDepthStep(clamp(-coast / depthT, 0.0, 1.0) * 3.0, artPx, dev), shallow, sea, deep);
}
// surf foam (A2): a band 0…−1.5 t off the coast that breathes on a 4 s period in 1-art-px steps.
// Returns foam coverage 0/1 at this art px. tilesPerArtPx converts the band to art px.
float rmSurf(float coast, ivec2 artPx, float tilesPerArtPx, float dev) {
  if (coast >= 0.0 || coast < -2.2) return 0.0;
  float t = rmMs() * 0.00025;                                   // 4 s period
  float pulse = floor((0.5 + 0.5 * sin(t * 6.2831853)) * 3.0);   // 0..3 art-px steps
  float w = 0.9 + pulse * tilesPerArtPx;                         // band width in tiles
  float edge = -coast;
  float n = u01(pcg2d(uvec2(artPx) ^ uvec2(0x51f0u, 0x7ab3u)).x);
  if (edge < w * 0.55) return 1.0;                              // the breaking line
  if (edge < w && n < mix(0.7, 0.45, rmArtOn(dev))) return 1.0; // broken foam behind it (solid when sub-px)
  return 0.0;
}
// sea glints (A1): a sparse 2-frame blink on a 600 ms clock, per art px.
float rmGlint(ivec2 artPx, float density, float dev) {
  if (rmStill() || dev < 0.9) return 0.0;
  uint f = uint(rmMs() / 600.0);
  uvec2 h = pcg2d(uvec2(artPx) ^ uvec2(f * 0x9e37u, 0x3c6fu));
  return u01(h.x) < density ? 1.0 : 0.0;
}
// Stage B, Solana Reach's gem sea at MAP (its water is the realm's "one thing to remember"; TRUE draws the kit's 16-frame gem
// loop, drifting [2,-2] kit px a frame): sparse gem sparkles, one per lit cell of a grid of ≥ 1 device px (cell = the art px
// coarsened by dq, as the depth dither), hashed per cell of the DRIFTED grid, so the whole field moves on both axes with the
// kit's drift and is random, never rows. g = (lit share, drift x, drift y in art px/s, on). → 0 none, else colour 1 or 2.
// ALU only: no fetch, no loop (groundcost). Cell and shift are taken mod 65536 (the hash input stays ≥ 0 and the field is an
// exact translation over time; it repeats 65536 cells apart, beyond any realm at dq 1).
int rmGem(ivec2 cell, float dq, vec4 g) {
  if (g.w < 0.5 || g.x <= 0.0) return 0;
  vec2 sh = mod(floor(g.yz * (rmMs() * 0.001) / dq), 65536.0);
  uvec2 h = pcg2d(uvec2((cell - ivec2(sh)) & ivec2(0xffff)) ^ uvec2(0x6e57u, 0x2a1bu));
  return u01(h.x) < g.x ? 1 + int(h.y & 1u) : 0;
}
// flow dashes (A3) along a stroke: s = arc coordinate (tiles), 0.5 t/s drift, 1 art px wide dashes
float rmFlowDash(float along, float across, float tilesPerArtPx) {
  float s = along - rmMs() * 0.0005;
  float dash = step(0.72, fract(s / 3.0));
  return dash * step(abs(across), tilesPerArtPx * 0.75);
}
// lava (A5, Cinderfall MAP): crisp heat bands by depth into the flow — a dark crust lip, red, orange, then a
// yellow core broken into slowly drifting crust plates — whose edges wobble with an art-px-quantised flow noise,
// and a 2.4 s brightness pulse. No ordered dither: at MAP (≈1–2 device px per art px) a Bayer pattern over the
// whole flow read as a crosshatch (Gate A). tArt = the art-px centre in tiles; inland < 0 inside the flow.
// kit = the realm's kit lava colour (realm.json palette.water), so the MAP flow continues into TRUE's kit lava.
vec3 rmLava(float inland, vec2 tArt, float dev, vec3 kit) {
  vec2 drift = vec2(0.0, -rmMs() * 0.0003);                          // 0.3 t/s northward, like the kit loop
  float n = rmNoiseF(tArt + drift, 5, 0x6a3du), m = rmNoiseF(tArt + drift * 1.6, 7, 0x1e77u);
  float k = -inland + 0.55 * n;
  vec3 glow = mix(kit, vec3(1.0, 0.72, 0.28), 0.5);
  vec3 c = k < 0.45 ? kit * 0.3 : k < 1.3 ? kit * 0.78 : k < 2.4 ? kit : glow;
  // cooling crust plates on the core, only once an art px is visible (smaller they speckle, the rubric's rule); they grow
  // from nothing at 1 device px per art px to full size at 2.2 (fix round 1 #3: a pop at d ≈ 470 cost ΔE 11 on the lava)
  if (k >= 2.9 && m > 1.0 - 0.6 * clamp((dev - 1.0) / 1.2, 0.0, 1.0)) c = kit;
  float pulse = rmStill() ? 0.0 : sin(rmMs() * 0.0026);
  return c * (1.0 + 0.06 * pulse * step(1.3, k));
}

uniform highp sampler2DArray uTgA;
uniform highp sampler2DArray uTgB;
uniform highp sampler2DArray uTgDecal;
uniform sampler2D uTgDecalBox;             // decal i → opaque bbox (min x, min y, max x, max y) in art px / 255
uniform highp sampler2DArray uTgMask;      // layer g → mask layer g >> 2, channel g & 3 (1 = family upper)
uniform highp usampler2DArray uTgRec;
uniform highp usampler2D uTgPage;          // R16UI: record layer + 1
uniform ivec4 uTgWater;                    // sea loop (DEEP/SEA): first layer, frames, frame ms, phase step
uniform ivec4 uTgWater2;                   // inland loop (WATER; Cinderfall's lava): first layer, frames, frame ms, phase step
uniform vec3 uTgPal[4];                    // deep tint, foam, - (RM-24: was the selection gold), -
uniform vec4 uTgOpt;                       // alpha, debug pages, depth tiles, gem highlight luma (0 = tint every texel)
uniform vec4 uRhAt;                        // W1 G1, ground.rehearse only (0 otherwise): z > 0.5 → this fragment is deed point
                                           // xy, with tile gradients w (0: magnified path, 1: minified)
out vec4 o;

vec4 layerAt(int g, vec2 f, vec2 gx, vec2 gy) {
  vec2 px = f * 32.0;
  float fp = max(length(gx * 32.0), length(gy * 32.0));      // texels per screen px
  bool b = g >= 256; float L = float(b ? g - 256 : g);
  if (fp <= 1.0) { vec3 uvl = vec3(sharpUV(px) / 32.0, L); return b ? textureLod(uTgB, uvl, 0.0) : textureLod(uTgA, uvl, 0.0); }
  return b ? textureGrad(uTgB, vec3(f, L), gx, gy) : textureGrad(uTgA, vec3(f, L), gx, gy);
}
float maskAt(int g, ivec2 t) { return texelFetch(uTgMask, ivec3(clamp(t, ivec2(0), ivec2(31)), g >> 2), 0)[g & 3]; }
// the builder's paste rule: texels of the wanted class, plus a 1-px rim around them, opaque only
bool pasteAt(int g, bool upper, ivec2 t) {
  float want = upper ? 1.0 : 0.0;
  if (abs(maskAt(g, t) - want) < 0.5) return true;
  for (int k = 0; k < 4; k++) {
    ivec2 q = t + (k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1));
    if (q.x < 0 || q.y < 0 || q.x > 31 || q.y > 31) continue;
    if (abs(maskAt(g, q) - want) < 0.5) return true;
  }
  return false;
}
void main() {
  vec2 p = uRhAt.z > 0.5 ? uRhAt.xy : fragDeed(), g = uGrid.xy;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, g))) discard;
  vec2 tt = p * 98.0; ivec2 T = ivec2(floor(tt)); ivec2 d = ivec2(floor(p));
  uint pl = texelFetch(uTgPage, d, 0).r;
  if (pl == 0u) discard;
  ivec2 l = clamp(T - d * 98, ivec2(0), ivec2(97));
  uvec4 rec = texelFetch(uTgRec, ivec3(l, int(pl) - 1), 0);
  vec2 f = tt - vec2(T), gx = dFdx(tt), gy = dFdy(tt);
  if (uRhAt.z > 0.5) { gx = vec2(uRhAt.w, 0.0); gy = vec2(0.0, uRhAt.w); }
  ivec2 tex = clamp(ivec2(floor(f * 32.0)), ivec2(0), ivec2(31));
  ivec2 apx = T * 32 + tex;                                     // absolute art px
  vec4 col = vec4(0.0);
  bool wet = ((rec.w >> 6u) & 1u) != 0u;
  vec2 ap = vec2(apx) / 32.0 + 0.5 / 32.0;                      // art-px centre, tiles
  float coast = rmCoastField(rmLakeWarp(ap)) + uRmNoiseAmp.x * rmNoiseF(ap, uRmNoisePer.x, uRmNoiseSeed.x) + uRmNoiseAmp.w * rmNoiseF(ap, uRmCoast2.x, uint(uRmCoast2.y)); // the MAP coast, unforced
  if (wet) {
    // GA2-03: the loop by the wet class — WATER inland (the NW vertex class; a shore tile away from the sea counts as
    // inland), else the sea loop
    int cl = int(rec.w & 15u); bool inl = cl == 2 || (cl > 2 && coast > 1.0);
    ivec4 wl = inl ? uTgWater2 : uTgWater;
    // Stage B: the record's phase (0…3) steps the loop by its pack phaseStep (realm.json true.waterByClass.<cls>.phaseStep:
    // 2 for the 8-frame loops, 4 for Solana Reach's 16-frame gem loop, so each open-water phase shows its own gem rows);
    // 0 = the pre-Stage-B step 2 (a caller that still passes 0 in .w, e.g. a pinned native port, draws as before)
    int phase = int((rec.w >> 4u) & 3u) * (wl.w > 0 ? wl.w : 2);
    int fr = rmStill() ? 0 : (int(rmMs() / float(max(wl.z, 1))) + phase) % max(wl.y, 1);
    col = layerAt(wl.x + fr, f, gx, gy);
    float step_ = rmDepthStep(clamp(-coast / max(uTgOpt.z, 1.0), 0.0, 1.0) * 3.0, apx, uViewport.z / 3136.0) / 3.0;
    // fix pass #5: a gem-sea realm's loop highlights (luma over uTgOpt.w) keep their colour under the depth tint (ALU only)
    float hk = uTgOpt.w > 0.0 ? 1.0 - smoothstep(uTgOpt.w, uTgOpt.w + 0.15, dot(col.rgb, vec3(0.299, 0.587, 0.114))) : 1.0;
    col.rgb = mix(col.rgb, col.rgb * uTgPal[0], step_ * hk);
  }
  bool waterPx = wet;                                           // QA: is the kit water loop what shows here?
  if ((rec.x & 0x3fffu) != 0u) {
    vec4 b = layerAt(int(rec.x & 0x3fffu), f, gx, gy);
    if (b.a > 0.5) { col = b; waterPx = false; }
  }
  for (int k = 0; k < 2; k++) {
    uint w = k == 0 ? rec.y : rec.z;
    int gL = int(w & 0x3fffu); if (gL == 0) continue;
    bool upper = (w & 0x4000u) != 0u;
    if (!pasteAt(gL, upper, tex)) continue;
    vec4 c = layerAt(gL, f, gx, gy);
    if (c.a > 0.5) { col = c; waterPx = false; }
  }
  uint decal = rec.w >> 7u;
  if (decal > 0u) {
    vec4 bb = texelFetch(uTgDecalBox, ivec2(int(decal) - 1, 0), 0) * 255.0;
    uvec2 jh = pcg2d(uvec2(T) ^ uvec2(0x4d1fu, 0x01b7u));
    vec2 lo = -bb.xy, room = max(bb.xy + 31.0 - bb.zw + 1.0, vec2(1.0));  // shifts keeping [min, max] inside 0…31
    vec2 j = floor(lo + vec2(u01(jh.x), u01(jh.y)) * room);
    vec2 dp = f * 32.0 - j;
    if (all(greaterThanEqual(dp, vec2(0.0))) && all(lessThan(dp, vec2(32.0)))) {
      vec4 dc = textureLod(uTgDecal, vec3(sharpUV(dp) / 32.0, float(decal - 1u)), 0.0);
      if (dc.a > 0.5) col = dc;
    }
  }
  if (wet && col.a < 0.5) col = vec4(uTgPal[0], 1.0);
#ifdef RM_DBG_WMASK
  o = vec4(waterPx ? 1.0 : 0.0, 0.0, 0.0, 1.0); return; // QA: TRUE's visible water (ground.debug().probeWater)
#endif
  // surf (A2): foam texels 0.5–1.5 t off the coast, art-px quantised, breathing
  if (wet && coast < 0.0 && rmSurf(coast + 0.5, apx, 1.0 / 32.0, uViewport.z / 3136.0) > 0.5) col.rgb = mix(col.rgb, uTgPal[1], 0.85);
  if (uTgOpt.y > 0.5 && (l.x == 0 || l.y == 0)) col.rgb = mix(col.rgb, vec3(1.0, 0.0, 1.0), 0.6); // ?debugPages
  col.rgb *= cloudShade(p, 3136.0);
  o = vec4(col.rgb, uTgOpt.x);
}
