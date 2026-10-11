#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_FS 1



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


uniform vec4 uRmCfgA;   // coastK (G16 island smoothing), inlandK, force, -
uniform vec4 uRmRing;   // G13 clearing: extra, corner radius, value-noise amp, zig-zag amp
uniform ivec4 uRmRingP; // G13 clearing: value-noise period, zig-zag cell, seed, seed 2
uniform vec4 uRmRing2;  // G13 lobe amp · G12 apron min, apron amp, feather
uniform ivec4 uRmApronP; // G12 apron noise period, seed, -, -
uniform vec4 uRmBridge; // G15 bridges: smooth-max k, wobble amp, taper, -
uniform ivec4 uRmBridgeP; // G15 bridges: wobble period, seed, -, -
uniform vec4 uRmCfgB;   // deepT, beachW, hasShore, rockT
uniform vec4 uRmCfgE;   // rockWaterGap, rockPlotGap, roadInland, roadCoast
uniform vec4 uRmLines;       // riverHwMin, trackHwMin, riverNoiseK, lensMargin
uniform vec4 uRmIsle;        // G16 island: base margin, max corner radius, lobe amp, forcing slope outside
uniform vec4 uRmIsle2;       // G16 island: value-noise amp, amp2, zig-zag amp, shallows slope variation
uniform ivec4 uRmIsleP;      // G16 island: period, period2, zig-zag cell, seed
uniform vec4 uRmIsle3;       // G16 island: inland smooth-max k, shallows period, reach past the plot box (islandReach), -
uniform vec4 uRmIsle4;       // P0 fix pass #4: halo (t past the island where the forcing starts to plunge), its fade (t), depth

float rmSmax(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
float rmSmin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
// zig-zag noise (classify.js znoise): two value noises whose lattice values alternate in sign by column / by row
float rmZm(ivec2 c, uint seed, uint k) { return 0.5 + 0.5 * u01(pcg2d(uvec2(c) ^ uvec2(seed, (seed * 7u) ^ k)).x); }
float rmZat(ivec2 c, uint seed) { float a = rmZm(c, seed, 0u), b = rmZm(c, seed, 0x55u); return ((c.x & 1) != 0 ? -a : a) + ((c.y & 1) != 0 ? -b : b); }
float rmZNoise(vec2 p, int cell, uint seed) {
  vec2 cf = floor(p / float(cell)); ivec2 c = ivec2(cf);
  vec2 f = (p - cf * float(cell)) / float(cell); f = f * f * (3.0 - 2.0 * f);
  return 0.5 * mix(mix(rmZat(c, seed), rmZat(c + ivec2(1, 0), seed), f.x), mix(rmZat(c + ivec2(0, 1), seed), rmZat(c + ivec2(1, 1), seed), f.x), f.y);
}
// distance from a rounded box's centre along the unit ray a (absolute components) to its boundary (classify.js rayBox)
float rmRayBox(vec2 a, float H, float c) {
  float t = min(a.x > 1e-6 ? H / a.x : 1e9, a.y > 1e-6 ? H / a.y : 1e9), C = H - c;
  if (t * a.x <= C || t * a.y <= C) return t;
  float s = (a.x + a.y) * C;
  return s + sqrt(max(0.0, s * s - 2.0 * C * C + c * c));
}
float rmU24(uint h) { return float(h >> 8u) / 16777216.0; }
// ---- G16: the island (classify.js islandSdf / islandForce): the plot box grown by an organic margin, over the 3×3 deeds.
// W1 G2: split into its shape (the 9-deed loop, RM_FAR when no plot is in reach) and its noise, so rm-map can pass the
// noise values it evaluates in one shared loop (mapground NZ); the classifier keeps rmIsleSdfN / rmIsleForceN as they were
float rmIsleShapeN(vec2 p, RmNb nb) {
  float s = RM_FAR;
  for (int k = 0; k < 9; k++) {
    int L = nb.L[k]; if (L == 0) continue; ivec2 d = rmNbDeed(nb, k);
    vec2 o = p - rmPlotC(d, L); float hf = uRmPlot[L].z;
    if (max(abs(o.x), abs(o.y)) - hf > uRmIsle3.z) continue;
    int seed = int(kitHash(d.x, d.y) & 0x7fffffffu) ^ uRmIsleP.w;
    float c = min(3.0 + (uRmIsle.y - 3.0) * rmU24(kitHash(5, seed)), hf), base = uRmIsle.x + 0.41421356 * (c - 3.0);
    float a2 = 0.5 + 0.5 * rmU24(kitHash(1, seed)), a3 = 0.2 + 0.4 * rmU24(kitHash(2, seed));
    float q2 = 6.28318530718 * rmU24(kitHash(3, seed)), q3 = 6.28318530718 * rmU24(kitHash(4, seed));
    float r = length(o); vec2 u = r > 1e-6 ? o / r : vec2(1.0, 0.0);
    float n = (a2 * (cos(q2) * (u.x * u.x - u.y * u.y) + sin(q2) * 2.0 * u.x * u.y) + a3 * (cos(q3) * (4.0 * u.x * u.x * u.x - 3.0 * u.x) + sin(q3) * (3.0 * u.y - 4.0 * u.y * u.y * u.y))) / (a2 + a3);
    s = min(s, rmRoundedBox(o, hf, c) - base - uRmIsle.z * (0.5 + 0.5 * n));
  }
  return s;
}
// the island SDF from its shape s and its noise: octaves n0 (uRmIsleP.x, seed w), n1 (uRmIsleP.y, w + 1), zig-zag z (w + 2)
float rmIsleSdfNz(float s, float n0, float n1, float z) {
  if (s >= RM_FAR) return s;
  s -= uRmIsle2.x * (0.5 + 0.5 * n0); s -= uRmIsle2.y * (0.5 + 0.5 * n1);
  return s - uRmIsle2.z * (0.5 + 0.5 * z);
}
// the island's forcing from its SDF s and the shallows noise nf (period uRmIsle3.y, seed w + 3; read only where s > 0)
float rmIsleForceS(float s, float nf) {
  if (s >= RM_FAR) return -RM_FAR;
  return s <= 0.0 ? -s : -s * uRmIsle.w * (1.0 + uRmIsle2.w * nf) - uRmIsle4.z * smoothstep(uRmIsle4.x, uRmIsle4.x + uRmIsle4.y, s);
}
float rmIsleSdfN(vec2 p, RmNb nb) {
  float s = rmIsleShapeN(p, nb);
  if (s >= RM_FAR) return s;
  uint sd = uint(uRmIsleP.w);
  for (int k = 0; k < 2; k++) s -= (k == 0 ? uRmIsle2.x : uRmIsle2.y) * (0.5 + 0.5 * rmVN(p, k == 0 ? uRmIsleP.x : uRmIsleP.y, sd + uint(k))); // (fix pass #1: one copy)
  return s - uRmIsle2.z * (0.5 + 0.5 * rmZNoise(p, uRmIsleP.z, sd + 2u));
}
float rmIsleForceN(vec2 p, RmNb nb) {
  float s = rmIsleSdfN(p, nb); if (s >= RM_FAR) return -RM_FAR;
  return s <= 0.0 ? -s : -s * uRmIsle.w * (1.0 + uRmIsle2.w * rmVN(p, int(uRmIsle3.y), uint(uRmIsleP.w) + 3u)) - uRmIsle4.z * smoothstep(uRmIsle4.x, uRmIsle4.x + uRmIsle4.y, s);
}
float rmIsleSdf(vec2 p) { return rmIsleSdfN(p, rmNb(p)); }
float rmIsleForce(vec2 p) { return rmIsleForceN(p, rmNb(p)); }
// inland water from its parts (classify.js classDetail): lake = the lake SDF at the warped point, rv = the river sample;
// lakes dried over the island (smooth-max), rivers bent clear of the plots, the plot box + force margin always;
// nz = the inland noise at p, isl = the island force, plot = the plot SDF
float rmInlandV(float lake, vec2 rv, float nz, float isl, float plot) {
  float wetL = lake + uRmNoiseAmp.y * nz;
  if (isl > -RM_FAR) wetL = rmSmax(wetL, isl, uRmIsle3.x);
  return rmSmax(min(wetL, rv.x + min(uRmNoiseAmp.y, rv.y) * nz), uRmCfgA.z - plot, uRmCfgA.y);
}
float rmInland(vec2 p, float nz, float isl, float plot) { return rmInlandV(rmLakeField(rmLakeWarp(p)), rmRiver(p), nz, isl, plot); }
// G13: the clearing's radius along unit ray u of the plot on deed d (classify.js clearingR): round base + 2θ/3θ lobes
float rmClearR(ivec2 d, vec2 u, float H) {
  int seed = int(kitHash(d.x, d.y) & 0x7fffffffu) ^ 0x3c1e;
  float a2 = 0.6 + 0.4 * rmU24(kitHash(1, seed)), a3 = 0.3 + 0.4 * rmU24(kitHash(2, seed));
  float q2 = 6.28318530718 * rmU24(kitHash(3, seed)), q3 = 6.28318530718 * rmU24(kitHash(4, seed));
  vec4 hv = vec4(u.x * u.x - u.y * u.y, 2.0 * u.x * u.y, 4.0 * u.x * u.x * u.x - 3.0 * u.x, 3.0 * u.y - 4.0 * u.y * u.y * u.y);
  float n = (a2 * (hv.x * cos(q2) + hv.y * sin(q2)) + a3 * (hv.z * cos(q3) + hv.w * sin(q3))) / (a2 + a3);
  return rmRayBox(abs(u), H, min(H, uRmRing.y)) + uRmRing2.x * (0.5 + 0.5 * n);
}
// G13: the organic clearing SDF at tile point t (classify.js clearingSdf), continuous (MAP evaluates it per art px).
// W1 G2: its shape (RM_FAR when no plot is in reach) and its noise (value noise n: uRmRingP.x / .z, zig-zag z: .y / .w)
float rmClearShapeN(vec2 t, RmNb nb) {
  float s = RM_FAR;
  for (int k = 0; k < 9; k++) {
    int L = nb.L[k]; if (L == 0) continue; ivec2 d = rmNbDeed(nb, k);
    vec2 o = t - rmPlotC(d, L); float r = length(o), H = uRmPlot[L].z + uRmRing.x;
    if (r > H * 1.41421356 + uRmRing2.x + uRmRing.z + uRmRing.w) continue;
    s = min(s, r - rmClearR(d, r > 1e-6 ? o / r : vec2(1.0, 0.0), H));
  }
  return s;
}
float rmClearingNz(float s, float n, float z) { return s >= RM_FAR ? s : s - uRmRing.z * (0.5 + 0.5 * n) - uRmRing.w * z; }
float rmClearingN(vec2 t, RmNb nb) {
  float s = rmClearShapeN(t, nb);
  if (s >= RM_FAR) return s;
  return s - uRmRing.z * (0.5 + 0.5 * rmVN(t, uRmRingP.x, uint(uRmRingP.z))) - uRmRing.w * rmZNoise(t, uRmRingP.y, uint(uRmRingP.w));
}
float rmClearing(vec2 t) { return rmClearingN(t, rmNb(t)); }
// G15: the land bridges' forcing at tile point p (classify.js bridgeForce, wobble included): a half-capsule from each plot
// centre of the 3×3 deeds toward its shore, read from one packed header word per plotted deed (P0: a literal 9-deed loop)
// (W1 G2: its shape, −RM_FAR when none, and its wobble n: value noise uRmBridgeP.x / .y)
float rmBridgeShapeN(vec2 p, RmNb nb) {
  if (uRmGrid.w <= 0) return -RM_FAR;
  float f = -RM_FAR;
  for (int k = 0; k < 9; k++) {
    int L = nb.L[k]; if (L == 0) continue;
    ivec2 d = rmNbDeed(nb, k); uint w = rmHdr(d, 2); if (w == 0u) continue;
    float an = float(w & 0xffffu) * (6.28318530718 / 65536.0), len = float((w >> 16u) & 255u) * 0.5, hw = float(w >> 24u) * 0.25;
    vec2 u = vec2(cos(an), sin(an)), a = rmPlotC(d, L);
    float along = dot(p - a, u), t = clamp(along / len, 0.0, 1.0);
    f = max(f, min(hw * (1.0 - uRmBridge.z * t) - length(p - (a + u * (t * len))), along - 0.25 * hw)); // half-capsule past the centre
  }
  return f;
}
float rmBridgeNz(float f, float n) { return f > -RM_FAR ? f + uRmBridge.y * n : f; }
float rmBridgeN(vec2 p, RmNb nb) {
  float f = rmBridgeShapeN(p, nb);
  return f > -RM_FAR ? f + uRmBridge.y * rmVN(p, uRmBridgeP.x, uint(uRmBridgeP.y)) : f;
}
float rmBridge(vec2 p) { return rmBridgeN(p, rmNb(p)); }


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

uniform highp sampler2DArray uMpKit;       // map atlas: 32² layers with mips
uniform highp sampler2DArray uMpMask;      // R = upper class, G = rim (same layers, nearest)
uniform highp usampler2DArray uMpLattice;  // class + 1 per lattice vertex (0 = unresolved)
uniform ivec4 uMpLat;                      // page size, pages x, lattice W, lattice H
uniform ivec4 uMpTerr4[4];                 // class → slot: 0 = WILD base (+ overlay), 1…5 = M1…M5
uniform ivec4 uMpFam[6];                   // slot → atlas layer of mask 0 (16 masks consecutive), has, pure-upper first, count
uniform ivec4 uMpOrder;                    // draw order of slots 1…5 (first four) …
uniform int uMpOrder5;                     // … and the fifth (0 = none)
uniform ivec2 uMpWild;                     // WILD pure: first layer, count
uniform ivec2 uMpField;                    // (unused since G9: the ring shows the clearing's ground, BASES plants it)
uniform int uMpObst;                       // G12: bit s = map slot s draws no ground class (the apron's feather clears it)
uniform int uMpClr;                        // G12: bit s = slot s is an obstacle over the realm's wild ground at TRUE (forest,
                                           // dunes…): the plot's clearing shows the wild ground there, as TRUE does
uniform ivec4 uMpWang[6];                  // slot → corner-Wang pure variants (realm.json map.atlas.pureWang): first, count
uniform sampler2D uMpPlots;                // plots.webp: yard layers per level (plot impostors, §6.2)
uniform vec4 uMpYard[21];                  // level → yard rect in plots.webp px (x, y, w, h)
uniform vec4 uMpYardT[21];                 // level → first deed-local tile (x, y), tiles, has
uniform float uMpYardW;                    // yard weight: 0 below d 200 → 1 at d 280
uniform vec4 uMpGrade;                     // tone weight (1 at d 24 → 0 at d 80, smoothstep in log d; W1 G5), has tone, alpha, lava
// P0 fix pass #2/#3 (fix iteration 2 #2's per-pixel chart16 grade mottled d 150–400 into a multi-hue tie-dye): PACK's
// tone map (4 px/deed, low-passed chart ÷ low-passed map colour, baked offline) is the grade — its luminance relief in
// full, its chroma clamped to a faint tint (uMpToneK), never over a clearing
uniform sampler2D uMpTone;                 // 4 px/deed, 128 = 1.0 (linear)
uniform vec2 uMpToneK;                     // luminance amplitude, chroma clamp (± per channel around the luminance)
uniform vec3 uMpFamK[6];                   // GA2-05: per map slot, painting mean ÷ map art mean
uniform float uMpFamW;                     // its weight (1 → 0 over d 48 → 1100, linear in log d)
uniform vec3 uMpPal[14];                   // shallow, sea, deep, foam, beach, inland water, bank, road, road edge,
                                           // turf, hedge, hedge dark, hedge light, wet edge
uniform vec4 uMpWall[6];                   // wall tier 1…5 colour (rgb), gem flag (a)
uniform vec4 uMpDeedLine;                  // alpha, south-track weight (1 → 0 over d 500 → 800), -, -
uniform highp usampler2DArray uMpRec;      // TRUE record pages: meta & 15 = the class of the tile's NW vertex
uniform highp usampler2D uMpPage;          // R16UI: record layer + 1 (0 = not resident)
uniform int uMpVtx;                        // 1: take the water line's sign from resident TRUE vertex classes
uniform sampler2D uMpFar;                  // R8 linear: deeds from this realm × 16 (GA2-04, the chart's foreign fade)
uniform vec3 uMpSeaFar;                    // the painting's open-sea colour
uniform vec2 uMpThin;                      // W1 G5: x = how far the uMpThinMask slots ease toward the wild ground (the TRUE
uniform int uMpThinMask;                   // hand-over: forest that TRUE draws as sparse sprites on sand), 0 below d 450
uniform ivec4 uMpNz[28];                   // W1 G2 noise slots (ground.js NZ): period, seed, group, - (see main)
uniform vec4 uMpGem;                       // Stage B gem sea (rm-water rmGem): lit share, drift x, y (art px/s), on (0 = off)
uniform vec3 uMpGemCol[2];                 // its two gems as colour ÷ the kit loop's mean (ground.js gemColours, T.gemK): × the
                                           // MAP water under it, so gems keep TRUE's gem-to-water contrast at every depth
uniform vec4 uRhAt;                        // W1 G1, ground.rehearse only (0 otherwise): z > 0.5 → this fragment is deed point
                                           // xy, with lattice-cell gradients w (0: magnified path, 1: minified)
out vec4 o;

int mpTerr(int c) { return uMpTerr4[c >> 2][c & 3]; }
uint latAt(ivec2 l) {
  l = clamp(l, ivec2(0), uMpLat.zw - 1);
  ivec2 pg = l / uMpLat.x;
  return texelFetch(uMpLattice, ivec3(l - pg * uMpLat.x, pg.y * uMpLat.y + pg.x), 0).r;
}
// the slot a lattice texel k draws in a warped cell (the P0 block rule): unresolved → the cell's own slot sb, a plot-ring
// vertex → the cell's non-plot slot rpS (G9), else its class's slot
int mpSlotW(uint k, int sb, int rpS) { int kc = int(k & 15u) - 1; return kc < 0 ? sb : (kc == 11 || kc == 12) && rpS >= 0 ? rpS : mpTerr(kc); }
// corner-Wang colour of lattice vertex v (texel k) for slot s (PACK wangRule): a hashed bit, forced to 0 unless all four
// cells around v are pure s — its 3×3 is one slot (bit 5, the PURE pass) and that slot is s — so every family/pure
// boundary is colour 0
int mpWangK(uint k, ivec2 v, int s) {
  if ((k & 32u) == 0u || int(k & 15u) == 0 || mpTerr(int(k & 15u) - 1) != s) return 0;
  return int(kitHash(v.x ^ 0x5a1, v.y ^ 0x2c3) & 1u);
}
// sample atlas layer at cell uv (0..1): sharp when magnified, trilinear over reducer mips when minified
vec4 kitAt(float layer, vec2 uv, vec2 gx, vec2 gy) {
  vec2 px = uv * 32.0;
  float mag = 1.0 / max(length(gx * 32.0), length(gy * 32.0));
  if (mag >= 1.0) return textureLod(uMpKit, vec3(sharpUV(px) / 32.0, layer), 0.0);
  return textureGrad(uMpKit, vec3(uv, layer), gx, gy);
}
bool maskAt(float layer, vec2 uv, vec2 gx, vec2 gy) {
  float lod = max(0.0, log2(max(length(gx * 32.0), length(gy * 32.0))));
  int lv = int(min(floor(lod + 0.5), 5.0));
  int s = 32 >> lv;
  ivec2 t = clamp(ivec2(floor(uv * float(s))), ivec2(0), ivec2(s - 1));
  vec2 m = texelFetch(uMpMask, ivec3(t, int(layer)), lv).rg;
  return m.r > 0.5 || m.g > 0.5;
}
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// a slot's seamless pure layer for a MIXED cell (fix round 1 organic edges): corner-Wang colour 0 (every corner of a mixed
// cell is colour 0 by the wang rule), else a hashed pure-upper variant, else the family's all-upper tile
float mpPureLayer(int s, ivec2 ci) {
  if (uMpWang[s].y > 0) return float(uMpWang[s].x);
  if (uMpFam[s].w > 0) return float(uMpFam[s].z) + float(kitHash(ci.x ^ 0x2f1, ci.y) % uint(uMpFam[s].w));
  return float(uMpFam[s].x + 15);
}
// A3 flow dashes (GA2-15): short light dashes drifting downstream along the river, in up to three lanes across a wide
// river, 1 art px thick; art px quantised, off with reduced motion. P0: no segment loop — the lane offset is the baked
// distance from the centre line (sdf + hw, hw from the noise cap amp = K·(hw − 0.5)), the direction the deed's downstream
// hint (the mean direction of its river segments in lines.json order, river header bits 16–31)
float mpFlow(vec2 q, float tpa, float dev, vec2 rv, uint w) {
  if (rmStill() || dev < 0.7 || rv.y >= uRmBake.y) return 0.0;
  vec2 dir = vec2(float(int((w >> 16u) & 255u) - 128), float(int((w >> 24u) & 255u) - 128));
  if (dot(dir, dir) < 1.0) return 0.0;
  dir = normalize(dir);
  float hw = max(rv.y / uRmLines.z + 0.5, uRmLines.x), across = max(rv.x + hw, 0.0);
  float lw = max(hw * 0.55, 0.8), lane = floor(across / lw + 0.5), ac = across - lane * lw;
  if (lane > 1.0 || across > hw - tpa) return 0.0;
  float s = dot(q, dir) - rmMs() * 0.0009 + u01(kitHash(int(lane) + 5, 0x7f3)) * 3.0;
  return step(0.8, fract(s / 3.4)) * step(abs(ac), tpa * 0.55);
}
// TRUE's class at tile vertex v (legalised + despeckled), −1 when its deed's page is not resident
int vtxCls(ivec2 v) {
  ivec2 d = rmDeedOf(v);
  if (d.x < 0 || d.y < 0 || d.x >= uRmGrid.x || d.y >= uRmGrid.y) return -1;
  uint pl = texelFetch(uMpPage, d, 0).r;
  if (pl == 0u) return -1;
  return int(texelFetch(uMpRec, ivec3(v - d * RM_TILES, int(pl) - 1), 0).w & 15u);
}

void main() {
  vec2 p = uRhAt.z > 0.5 ? uRhAt.xy : fragDeed(), g = uGrid.xy;
  float cs = cloudShade(p, 448.0);                      // (fix pass #1: one inlined copy for both exits — 5 value noises)
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, g))) { // the open sea beyond the grid, as the chart draws it
    o = vec4(uMpSeaFar * cs, uMpGrade.z); return;
  }
  vec2 t = p * 98.0;                                   // tiles
  // ---- 1. layered composite on the lattice
  vec2 cq = t / 7.0; ivec2 ci = ivec2(floor(cq)); vec2 uv = cq - vec2(ci);
  vec2 gx = dFdx(cq), gy = dFdy(cq);
  if (uRhAt.z > 0.5) { gx = vec2(uRhAt.w, 0.0); gy = vec2(0.0, uRhAt.w); }
  // W1 G2: the cell's four corners (texel = class + 1 | water 16 | purity 32 | plot or track 64 | clearing 128). P0 read the
  // whole 4×4 block (16 fetches, two dynamically indexed 16-entry arrays, four 3×3 loops) for what the purity bits now say
  uint kf0 = latAt(ci), kf1 = latAt(ci + ivec2(1, 0)), kf2 = latAt(ci + ivec2(0, 1)), kf3 = latAt(ci + ivec2(1, 1));
  uint fl = ((kf0 | kf1 | kf2 | kf3) >> 4u) & 5u;          // 1 water near, 4 plot or track near
  uint k0 = kf0 & 15u, k1 = kf1 & 15u, k2 = kf2 & 15u, k3 = kf3 & 15u;
  if (k0 == 0u || k1 == 0u || k2 == 0u || k3 == 0u) discard;
  int c0 = int(k0) - 1, c1 = int(k1) - 1, c2 = int(k2) - 1, c3 = int(k3) - 1;
  // one slot over the whole 4×4 block (every corner's 3×3 is its own slot, and the four agree): no warp, no boundary
  bool oneSlot = (kf0 & kf1 & kf2 & kf3 & 32u) != 0u && mpTerr(c0) == mpTerr(c1) && mpTerr(c1) == mpTerr(c2) && mpTerr(c2) == mpTerr(c3);
  // G9: the clearing is drawn per art px below (the same organic function TRUE resolves per vertex); the lattice's
  // coarse TURF/RING vertices (7 t apart: a pasted octagon at MAP) take the class of a non-plot corner of the cell
  if ((fl & 4u) != 0u) {
    int rp = c0 < 11 || c0 > 12 ? c0 : c1 < 11 || c1 > 12 ? c1 : c2 < 11 || c2 > 12 ? c2 : c3 < 11 || c3 > 12 ? c3 : -1;
    if (rp >= 0) { if (c0 == 11 || c0 == 12) c0 = rp; if (c1 == 11 || c1 == 12) c1 = rp; if (c2 == 11 || c2 == 12) c2 = rp; if (c3 == 11 || c3 == 12) c3 = rp; }
  }
  int s0 = mpTerr(c0), s1 = mpTerr(c1), s2 = mpTerr(c2), s3 = mpTerr(c3);
  int sP = s0 == s1 && s1 == s2 && s2 == s3 ? s0 : -1;   // this cell's own pure slot (its corner-Wang colours below)
  float wl = float(uMpWild.x) + float(kitHash(ci.x, ci.y) % uint(max(uMpWild.y, 1)));
  float lay = wl; int top = 0;                          // P0: the winning layer is sampled once, after the slot loop
  // fix iteration 2 #7/#12 (stair-stepped class edges at MAP): wherever the cell's 4×4 lattice block holds more than one
  // slot, the corner indicators are read at a DOMAIN-WARPED point of the block (±0.62 cell on a 14-t period, ±0.25 on 5 t,
  // faded in once a cell spans a few device px), so a class edge wanders across lattice cells instead of stepping along
  // them. Plot-ring vertices take the cell's non-plot class, as the corners do (G9).
  // (W1 G2: a block that is not one slot takes the warp; where P0 found its 16 slots equal after the G9 ring rule, the warped
  // corners read those same slots, so the ground is the same)
  int rpS = -1;
  if ((fl & 4u) != 0u) { int rpc = c0 < 11 || c0 > 12 ? c0 : c1 < 11 || c1 > 12 ? c1 : c2 < 11 || c2 > 12 ? c2 : c3 < 11 || c3 > 12 ? c3 : -1; rpS = rpc >= 0 ? mpTerr(rpc) : -1; }
  vec2 ta = quantise(p, 448.0) * 98.0, uq = clamp(ta / 7.0 - vec2(ci), 0.0, 1.0);
  float dpt = uViewport.z / 98.0;                       // device px per tile
  // ---- W1 G2: every value noise this art px needs, in ONE inlined copy (P0 inlined 14 value-noise and 3 zig-zag copies
  // at their call sites). Slot k: uMpNz[k] = period, seed, group (ground.js NZ); the value lands in component k & 3 of nz[k >> 2]
  // (named below). Group bits: 1 the class-edge warp and boundary (a block that is not one slot), 2 shore (water or plot
  // near), 4 water near, 8 an islet (water and plot near), 16 plot near, 32 this deed's claim, 64 the foreign fade / frame.
  // Slots 0–20 at the art px (ta), 21–24 at p × 4 (the foreign cut); zig-zag slots 25–27 at ta. The sums are P0's, term for
  // term in the same order, so the ground is the same.
  ivec2 d = ivec2(floor(p));
  uvec4 bs = texelFetch(uRmBase, d, 0);
  int L = (bs.g & 1u) != 0u ? int(min(bs.a, 20u)) : 0;
  bool nWater = (fl & 1u) != 0u, nPlot = (fl & 4u) != 0u, nTrack = nPlot; // (W1: one flag for plots and tracks)
  float fd = texture(uMpFar, p / g).r * 16.0; vec2 e2 = min(p, g - p);
  int need = (oneSlot ? 0 : 1) | (nWater || nPlot ? 2 : 0) | (nWater ? 4 : 0) | (nWater && nPlot ? 8 : 0) | (nPlot ? 16 : 0) | (L > 0 ? 32 : 0)
    | (fd > 0.5 || min(e2.x, e2.y) < 4.5 ? 64 : 0);
  vec4 nzA = vec4(0.0), nzB = vec4(0.0), nzC = vec4(0.0), nzD = vec4(0.0), nzE = vec4(0.0), nzF = vec4(0.0), nzG = vec4(0.0); vec3 nzZ = vec3(0.0);
  if (need != 0) {
    for (int j = 0; j < 2; j++) for (int i = 0; i < 16; i++) {
      int k = j * 16 + i;
      if (k > 24 || (uMpNz[k].z & need) == 0) continue;
      vec4 v = vec4(equal(ivec4(k & 3), ivec4(0, 1, 2, 3))) * rmVN(k < 21 ? ta : p * 4.0, uMpNz[k].x, uint(uMpNz[k].y));
      int r = k >> 2;
      if (r == 0) nzA += v; else if (r == 1) nzB += v; else if (r == 2) nzC += v; else if (r == 3) nzD += v; else if (r == 4) nzE += v; else if (r == 5) nzF += v; else nzG += v;
    }
    for (int k = 0; k < 3; k++) if ((uMpNz[25 + k].z & need) != 0) nzZ += vec3(equal(ivec3(k), ivec3(0, 1, 2))) * rmZNoise(ta, uMpNz[25 + k].x, uint(uMpNz[25 + k].y));
  }
  if (!oneSlot) {
    float fw = clamp((7.0 * dpt - 2.0) / 4.0, 0.0, 1.0);
    // the four octave/axis noises: x 0.62·n(14) + 0.25·n(5), y likewise (slots 0–3)
    vec2 wn = vec2(0.62 * nzA.x, 0.62 * nzA.y); wn.x += 0.25 * nzA.z; wn.y += 0.25 * nzA.w;
    vec2 wq = clamp(uq + fw * wn, vec2(-0.95), vec2(1.95));
    ivec2 wi = ivec2(floor(wq)), wc = ci + wi; int sb = s0;   // the warped cell: four texel fetches, no indexed array
    s0 = mpSlotW(latAt(wc), sb, rpS); s1 = mpSlotW(latAt(wc + ivec2(1, 0)), sb, rpS);
    s2 = mpSlotW(latAt(wc + ivec2(0, 1)), sb, rpS); s3 = mpSlotW(latAt(wc + ivec2(1, 1)), sb, rpS); uq = wq - vec2(wi);
  }
  // fix round 1 (#1/#6 "45° staircases"): inside a MIXED cell a slot covers the art px where the bilinear of its corner
  // indicators plus one shared boundary noise (value noise 11 t and 5 t + zig-zag cell 2 t, each faded in once its period
  // spans a few device px) exceeds 0.5 — organic, art-px stepped edges instead of the corner-Wang masks' 45° cuts
  float bn = 0.0;
  if (!(s0 == s1 && s1 == s2 && s2 == s3)) { // (slots 4, 5 and zig-zag 25; a warped cell with two slots lies in a mixed block)
    bn += 0.17 * clamp((11.0 * dpt - 3.0) / 3.0, 0.0, 1.0) * nzB.x;
    bn += 0.15 * clamp((5.0 * dpt - 3.0) / 3.0, 0.0, 1.0) * nzB.y;
    bn += 0.15 * clamp((4.0 * dpt - 3.0) / 3.0, 0.0, 1.0) * nzZ.x;
  }
  for (int k = 0; k < 5; k++) {
    int s = k < 4 ? uMpOrder[k] : uMpOrder5;
    if (s <= 0 || uMpFam[s].y == 0) continue;
    int m = (s0 == s ? 8 : 0) | (s1 == s ? 4 : 0) | (s2 == s ? 2 : 0) | (s3 == s ? 1 : 0);
    if (m == 0) continue;
    float w = m == 15 ? 1.0 : mix(mix(float(m >> 3), float((m >> 2) & 1), uq.x), mix(float((m >> 1) & 1), float(m & 1), uq.x), uq.y) + bn;
    if (w > 0.5) { lay = mpPureLayer(s, ci); top = s; }
  }
  // this cell's own pure slot keeps its seamless corner-Wang / hashed pure variants (GA2-09): no 7-tile repeat
  if (top > 0 && top == sP) {
    if (uMpWang[top].y > 0) lay = float(uMpWang[top].x + (mpWangK(kf0, ci, top) << 3 | mpWangK(kf1, ci + ivec2(1, 0), top) << 2 | mpWangK(kf2, ci + ivec2(0, 1), top) << 1 | mpWangK(kf3, ci + ivec2(1, 1), top)));
    else if (uMpFam[top].w > 0) lay = float(uMpFam[top].z) + float(kitHash(ci.x ^ 0x2f1, ci.y) % uint(uMpFam[top].w));
    else lay = float(uMpFam[top].x + 15);
  }
  vec3 wildCol = kitAt(wl, uv, gx, gy).rgb, col = top == 0 ? wildCol : kitAt(lay, uv, gx, gy).rgb;
  ivec2 apx = ivec2(floor(p * 448.0));                  // this art px
  // W1 G5 (the MAP→TRUE colour jump, Sunscar: dense dark MAP forest, sparse palms on bright sand at TRUE): toward the
  // hand-over an obstacle slot that TRUE draws on the wild ground eases toward that ground — a smooth mix, like the tone and
  // family grades (a per-art-px dissolve at the same share measured the same mean but read as salt-and-pepper speckle); ALU only
  if (uMpThin.x > 0.0 && ((uMpThinMask >> top) & 1) != 0) col = mix(col, wildCol, uMpThin.x);
#ifdef RM_DBG_NOOVERLAY
  o = vec4(col, uMpGrade.z); return;
#endif
  // ---- 2. overlays at MAP art px
  vec2 tq = ta;                                         // art-px centre, in tiles
  float tpa = 98.0 / 448.0;                             // tiles per art px
  float dev = uViewport.z / 448.0;                      // device px per map art px
  RmNb nb = RmNb(d, int[9](0, 0, 0, 0, 0, 0, 0, 0, 0)); // (W1: a constructor, not a 9-trip loop)
  if (nPlot) nb = rmNb(tq);                            // P0: the 3×3 plot levels once, for every plot function below
  float plot = nPlot ? rmPlotSdfN(tq, nb) : RM_FAR;
  // P0: the baked track field; G15 land bridges from the plots' header words (a literal 9-deed loop)
  vec2 land = nTrack ? rmLand(tq) : vec2(RM_FAR, 0.0);
  float bf = nPlot ? rmBridgeNz(rmBridgeShapeN(tq, nb), nzE.y) : -RM_FAR; // (wobble: slot 17)
  float coast = RM_FAR, inland = RM_FAR, painted = RM_FAR; // painted: the painting's own water (unforced coast / lake SDF)
  vec2 rv = uRmBake.xy; uint rw = 0u;                   // the river sample (sdf, noise cap) and its header word (flow)
  // rmClassAt's own terms with continuous noise (P0: coast and lake from one bilinear). Near a plot too: a claim's cells
  // carry no water flag (the island forces them dry), yet the painting may paint sea there (the painting grade below)
  vec2 cl2 = vec2(RM_FAR); float coast0 = RM_FAR;
  if (nWater || nPlot) {
    cl2 = rmCoastLake(tq + vec2(uRmLakeW.x * nzB.z + uRmLakeW.y * nzC.x, uRmLakeW.x * nzB.w + uRmLakeW.y * nzC.y)); // rmLakeWarp (slots 6–9)
    coast0 = cl2.x + uRmNoiseAmp.x * nzC.z; coast0 += uRmNoiseAmp.w * nzC.w; // the two coast octaves (slots 10, 11)
    painted = min(coast0, cl2.y);
  }
  if (nWater) {
  // the water line TRUE draws: where the page is resident, the sign comes from its four corner vertex classes
  bool vtx = false; vec4 sv = vec4(0.0), iv = vec4(0.0); vec2 fv = vec2(0.0);
  if (uMpVtx == 1) {
    ivec2 T0 = ivec2(floor(tq)); fv = tq - vec2(T0);
    int c0 = vtxCls(T0), c1 = vtxCls(T0 + ivec2(1, 0)), c2 = vtxCls(T0 + ivec2(0, 1)), c3 = vtxCls(T0 + ivec2(1, 1));
    if (min(min(c0, c1), min(c2, c3)) >= 0) {
      vtx = true;
      sv = vec4(c0 <= 1 ? 1.0 : 0.0, c1 <= 1 ? 1.0 : 0.0, c2 <= 1 ? 1.0 : 0.0, c3 <= 1 ? 1.0 : 0.0);
      iv = vec4(c0 == 2 ? 1.0 : 0.0, c1 == 2 ? 1.0 : 0.0, c2 == 2 ? 1.0 : 0.0, c3 == 2 ? 1.0 : 0.0);
    }
  }
  // the G16 island forced dry, inland water (the expensive part: skipped on tiles whose four TRUE vertices hold no inland
  // water — there it is only a sign)
  float isl = nPlot ? rmIsleForceS(rmIsleSdfNz(rmIsleShapeN(tq, nb), nzD.z, nzD.w, nzZ.y), nzE.x) : -RM_FAR; // (slots 14–16, zig-zag 26)
  coast = isl > -RM_FAR ? rmSmax(coast0, isl, uRmCfgA.x) : coast0;
#ifndef RM_DBG_NOINLAND
  if (!vtx || dot(iv, vec4(1.0)) > 0.0) { rv = rmRiverW(tq, rw); inland = rmInlandV(cl2.y, rv, nzD.x, isl, plot); } // (slot 12)
#endif
  if (bf > -RM_FAR) { coast = rmSmax(coast, bf, uRmBridge.x); inland = rmSmax(inland, bf, uRmBridge.x); } // G15 (baked)
  if (vtx) {
    float sw = mix(mix(sv.x, sv.y, fv.x), mix(sv.z, sv.w, fv.x), fv.y), iw = mix(mix(iv.x, iv.y, fv.x), mix(iv.z, iv.w, fv.x), fv.y);
    coast = sw > 0.5 ? min(coast, -(sw - 0.5) * 2.0) : max(coast, (0.5 - sw) * 2.0);
    inland = iw > 0.5 && sw <= 0.5 ? min(inland, -(iw - 0.5) * 2.0) : max(inland, (0.5 - iw) * 2.0);
  }
  } // nWater
#ifdef RM_DBG_WMASK
  o = vec4(coast < 0.0 || inland < 0.0 ? 1.0 : 0.0, 0.0, 0.0, 1.0); return; // QA: the MAP water line (ground.debug().probeWater)
#endif
  // fix iteration 2 #9/#15: the MAP sea and lakes are procedural depth terraces from d 48 (never the magnified painting):
  // the Bayer dither between terraces runs on a power-of-two coarsening of the art px that covers ≥ 1 device px, and the
  // terraces widen at low zoom (≥ 30 device px to full depth) so they read at every scale
  float dq = exp2(max(0.0, ceil(log2(1.0 / max(dev, 1e-3))))); ivec2 dpx = ivec2(floor(p * 448.0 / dq)); float ddev = dev * dq;
  float depthT = max(max(uRmCfgB.x, 4.0), 30.0 * 98.0 / uViewport.z);
  if (coast < 0.0) {
    col = rmSeaColour(coast, dpx, uMpPal[0], uMpPal[1], uMpPal[2], depthT, ddev);
    int gm = coast < -1.0 ? rmGem(dpx, dq, uMpGem) : 0;
    if (rmSurf(coast, apx, tpa, dev) > 0.5) col = uMpPal[3];
    else if (gm > 0) col = mix(col, min(col * uMpGemCol[gm - 1], vec3(1.0)), 0.75);               // Stage B gem sea
    else if (coast < -4.0 && rmGlint(apx, 0.003, dev) > 0.5) col = mix(col, vec3(0.95, 0.98, 1.0), 0.6);
  } else if (inland < 0.0) {
    float dep = -inland; // G16: round an island the forcing's noise-varied slope sets the shallows (never a constant ring)
#ifdef RM_LAVA
    if (uMpGrade.w > 0.5) col = rmLava(-dep, tq, dev, uMpPal[5]); else  // (fix pass #1: compiled for the lava realm only)
#endif
    {
      // crisp depth terraces (dithered only when the art px is visible), never a smooth ramp
      col = mix(uMpPal[5], uMpPal[1], rmDepthStep(clamp(dep / 6.0, 0.0, 1.0) * 2.0, dpx, ddev) * 0.25);
      int gm = inland < -tpa ? rmGem(dpx, dq, uMpGem) : 0;                                         // Stage B: its crystal rivers
      if (gm > 0) col = mix(col, min(col * uMpGemCol[gm - 1], vec3(1.0)), 0.75);
      else if (rmGlint(apx, 0.006, dev) > 0.5) col = mix(col, vec3(0.9, 0.97, 1.0), 0.45);
      else if (inland < -tpa && mpFlow(tq, tpa, dev, rv, rw) > 0.5) col = mix(col, vec3(0.88, 0.96, 1.0), 0.4); // A3 flow
      if (inland > -tpa) col = mix(col, uMpPal[3], 0.35);          // lighter lip at the water edge
    }
  } else {
    if (nWater && uRmCfgB.z > 0.5 && coast < uRmCfgB.y + uRmNoiseAmp.z * nzD.y) col = mix(col, uMpPal[4], 0.85); // (slot 13)
    if (coast < tpa * 1.5 || inland < tpa * 1.2) col = mix(col, uMpPal[6], 0.55);   // 1-art-px dark bank line
    else if (coast < 0.9) col = mix(col, uMpPal[13], 0.5);                           // wet edge
    float track = nTrack ? land.x : RM_FAR;
    if (track < 0.0 && inland > uRmCfgE.z && coast > uRmCfgE.w) col = track > -tpa ? uMpPal[8] : uMpPal[7];
  }
  // ---- G12/G13 the plot's clearing (§6.2, GA2-08, fix round 1 #8): the same organic function TRUE resolves per vertex,
  // per art px here. The realm's ground stays; the clearing only removes obstacles that stand on the wild ground at TRUE
  // (forest, dunes…: uMpClr) and, in the apron's feather, any non-ground art (uMpObst). A ragged 1-art-px fringe.
  bool dryHere = coast >= 0.0 && inland >= 0.0, cleared = false;
  if (nPlot) {
    bool inBox = plot < 1.0;
    float cl = inBox || dryHere ? rmClearingNz(rmClearShapeN(tq, nb), nzE.z, nzZ.z) : RM_FAR; // (slot 18, zig-zag 27)
    bool ring = inBox || (cl < 0.0 && dryHere), clear = ring && ((uMpClr >> top) & 1) != 0;
    if (ring && L > 0 && !clear) { // the apron around this deed's claim, and its feather
      vec2 lc = tq - vec2(d) * 98.0 - vec2(rmPlotOff(d, L)); float hc = uRmPlot[L].x * 0.5;
      float cd = length(max(max(vec2(49.0 - hc) - lc, vec2(0.0)), lc - vec2(49.0 + hc)));
      float aw = uRmRing2.y + uRmRing2.z * (0.5 + 0.5 * nzE.w); // (slot 19)
      clear = cd < aw || (cd < aw + uRmRing2.w && ((uMpObst >> top) & 1) != 0);
    }
    if (clear) { col = wildCol; top = 0; cleared = true; }   // graded as the WILD ground it now is (no tone: fix pass #3)
    else if (!ring && dryHere && cl < tpa * 1.6 && ((uMpClr >> top) & 1) != 0 && u01(kitHash(apx.x ^ 0x6c1, apx.y)) < 0.5) col = mix(col, wildCol, 0.6);
  }
  // ---- plot (§6.2): the claim's organic tint and BASES' impostor yard. G8: the plot sits at its hashed
  // offset inside the deed (contracts.plotOffset); the ring itself is the clearing's ground (BASES plants the fields)
  if (L > 0) {
    ivec2 po = rmPlotOff(d, L);
    vec2 lt = tq - vec2(d) * 98.0 - vec2(po), dc = lt - 49.0, ad = abs(dc);   // plot-local: the plot centre is 49
    float hc = uRmPlot[L].x * 0.5, ring = uRmPlot[L].y, hp = hc + ring;
    float cheb = max(ad.x, ad.y);
    if (cheb < hp) {
      if (cheb <= hc + 2.2) { // the claim and its frayed border (classify.js claimRag); BASES' impostor yard from d 200
        // fix iteration 2 #11/#13: no pasted pale pad and no square wall outline at rest (the rigid-lattice look): the claim
        // is a subtle, organic shift of the realm's own ground toward its turf, frayed like TRUE's claim border
        float fray = cheb - hc - 2.2 * max(0.0, nzF.x), k = 1.0 - smoothstep(-1.5, 0.5, fray); // (slot 20)
        if (dryHere) col = mix(col, mix(col, uMpPal[9], 0.35) * (0.95 + 0.05 * u01(kitHash(apx.x, apx.y))), 0.8 * k);
        // plot impostor yard (d ≥ 200): kingdom turf + wall5 rings, offline from composeBaseDecor (PACK step 7)
        if (uMpYardW > 0.0 && uMpYardT[L].w > 0.5) {
          vec4 R = uMpYard[L], TT = uMpYardT[L];
          vec2 u = (lt - TT.xy) / TT.z;
          if (all(greaterThanEqual(u, vec2(0.0))) && all(lessThan(u, vec2(1.0)))) {
            vec2 px = R.xy + u * R.zw, ts = vec2(textureSize(uMpPlots, 0));
            float fp = max(length(dFdx(px)), length(dFdy(px)));
            vec4 yc = fp < 1.0 ? textureLod(uMpPlots, sharpUV(px) / ts, 0.0) : textureLod(uMpPlots, px / ts, 0.0);
            if (yc.a > 0.5) col = mix(col, yc.rgb, uMpYardW);
          }
        }
      }
      // (fix round 1 #8: no fence/frame line at MAP — BASES' sprites draw the kingdom; only the selection outlines a deed)
    }
  }
  // ---- deed lines, selection. No other-realm veil at MAP (owner 2026-09-26, Seeker, Sunscar MAP: "grey overlay is
  // visible on current screen on realm map and it looks ugly"): it greyed deeds the catalogue gives to another realm
  // (base state kind 2) that the realm art paints as this realm's land, with hard straight per-deed edges. TRUE never
  // veiled them, so MAP now draws them as the art paints them too; since the owner's Crownlands FAR follow-up the same
  // day, the FAR chart, the minimap and the stand-in ground do not veil them either (every zoom).
  vec2 f = fract(p);
  float edgeDev = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * uViewport.z;
  if (bs.r == 1u) col = mix(col, vec3(1.0, 0.97, 0.88), (1.0 - smoothstep(0.35, 1.2, edgeDev)) * uMpDeedLine.x);
  if (all(equal(d, ivec2(uSel.xy)))) {
    float pulse = 0.8 + 0.2 * sin(float(uClock.y) * 0.00314);
    col = mix(col, vec3(1.0, 0.84, 0.36), (1.0 - smoothstep(1.0, 2.2, edgeDev)) * pulse);
  }
  // GA2-04: the chart's foreign fade (rmKeep there): beyond ~3.5 deeds of the realm the classes are already sea (ground.js
  // foreignSea caps the coast SDF); this eases their colours into the chart's open sea, and the frame band into it
  // (rmForeignCut: its four octaves at p × 4 are slots 21–24; the fade's two are the same noises as its last two)
  float cn = 1.5 * nzF.y; cn += 0.8 * nzF.z; cn += 0.9 * nzF.w; cn += 0.35 * nzG.x;
  float cut = fd > 0.5 ? clamp(3.5 - cn, 1.5, 6.5) : 9.0, foreign = smoothstep(cut - 1.5, cut, fd);
  if ((need & 64) != 0) { // (the noise only where it can matter: most of the realm skips it)
    float n = nzF.w * 0.9; n += nzG.x * 0.35;
    float fw = smoothstep(cut - 0.45, cut + 0.45, fd) * (coast < 0.0 ? 0.85 : 1.0);
    float fe = 1.0 - smoothstep(0.0, 3.0, min(e2.x, e2.y) + n * 0.8);
    col = mix(uMpSeaFar, col, (1.0 - fw) * (1.0 - fe));
  }
  col *= cs;
  // GA2-05: the family grade (ground only; water keeps its own palette), then the spatial tone relative to it, so at
  // d 48 the product is the full chart tone (FAR match) and the drift afterwards is spread over the whole MAP band
  bool wetPx = coast < 0.0 || inland < 0.0;
  vec3 fk = wetPx ? vec3(1.0) : mix(vec3(1.0), uMpFamK[top], uMpFamW);
  col = col * fk;
  // P0 fix pass #1–#3: the chart tone (PACK's baked low-pass painting ÷ map colour), relative to the family grade, so at
  // d 48 the product is the chart's local shading (FAR match); luminance relief in full, chroma clamped to a faint tint
  // (the painting's hues were the tie-dye), faded out by d 80 (W1 G5; was d 200). Land only (water keeps its terraces), not over foreign land
  // made sea, not over a clearing (it shows wild ground where the painting has forest: the mint glow), and eased off near
  // water — the painting's own too (G16 islets, headlands, bridges: sand graded by the sea read lilac)
  if (uMpGrade.y > 0.5 && uMpGrade.x > 0.0 && !wetPx && !cleared) {
    vec3 r = texture(uMpTone, p / g).rgb * (255.0 / 128.0) / max(fk, vec3(0.05));
    float Y = max(lum(r), 0.05);
    vec3 tn = (1.0 + (Y - 1.0) * uMpToneK.x) * clamp(r / Y, vec3(1.0 - uMpToneK.y), vec3(1.0 + uMpToneK.y));
    float nearW = smoothstep(0.5, 4.0, min(min(coast, inland), painted));
    col = col * mix(vec3(1.0), tn, uMpGrade.x * (1.0 - foreign) * nearW);
  }
  col = clamp(col, 0.0, 1.0);
  o = vec4(col, uMpGrade.z);
}
