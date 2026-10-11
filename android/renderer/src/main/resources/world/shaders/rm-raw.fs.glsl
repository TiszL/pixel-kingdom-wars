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

uniform sampler2D uRmFieldsBC;        // RGB8 4 px/deed, two halves side by side (forest, field, rock | snow, ground2, special)
uniform vec4 uRmRag;     // fix iteration 2 #13 frayed claim border: amp (t), period, seed, - (amp 0 = off)
uniform vec4 uRmWarp;   // G11 class warp: amp, amp2, amp3, fine weight (0 on the MAP lattice)
uniform ivec4 uRmWarpP; // G11 class warp: period, period2, period3, seed
uniform vec4 uRmWarpZ;  // G11 class warp: zig-zag amp, zig-zag cell, -, -
uniform vec4 uRmCfgC;   // slopeT (<0 = off), slopeStep, snowT, fieldT
uniform vec4 uRmCfgD;   // forestT, specialT, g2T, riverNoiseReach
uniform ivec4 uRmParcel;     // min, max, -, -
float rmBC(vec2 t, int ch, bool second) {
  int hw = textureSize(uRmFieldsBC, 0).x / 2;
  return rmBilin(uRmFieldsBC, t, uRmFieldsPpd.y, ch, second ? hw : 0, hw) / 255.0;
}
// P0: all three channels of one fieldsBC half at t from the same four texels (rmBilin's arithmetic per channel)
vec3 rmBC3(vec2 t, bool second) {
  int w = textureSize(uRmFieldsBC, 0).x / 2, H = textureSize(uRmFieldsBC, 0).y, x0 = second ? w : 0;
  vec2 u = t * (uRmFieldsPpd.y / float(RM_TILES)) - 0.5;
  vec2 fl = floor(u); ivec2 i0 = ivec2(fl); vec2 f = u - fl;
  ivec2 a = clamp(i0, ivec2(0), ivec2(w - 1, H - 1)), b = clamp(i0 + 1, ivec2(0), ivec2(w - 1, H - 1));
  vec3 v00 = texelFetch(uRmFieldsBC, ivec2(x0 + a.x, a.y), 0).rgb, v10 = texelFetch(uRmFieldsBC, ivec2(x0 + b.x, a.y), 0).rgb;
  vec3 v01 = texelFetch(uRmFieldsBC, ivec2(x0 + a.x, b.y), 0).rgb, v11 = texelFetch(uRmFieldsBC, ivec2(x0 + b.x, b.y), 0).rgb;
  vec3 top = v00 + (v10 - v00) * f.x, bot = v01 + (v11 - v01) * f.x;
  return (top + (bot - top) * f.y) * 255.0 / 255.0;
}
// G11: the class lookup point of tile point p (classify.js classWarp)
vec2 rmClassWarp(vec2 p) {
  uint s = uint(uRmWarpP.w); float f = uRmWarp.w;
  int zc = int(uRmWarpZ.y);
  return p + vec2(uRmWarp.x * rmVN(p, uRmWarpP.x, s) + f * (uRmWarp.y * rmVN(p, uRmWarpP.y, s + 2u) + uRmWarp.z * rmVN(p, uRmWarpP.z, s + 5u) + uRmWarpZ.x * rmZNoise(p, zc, s + 7u)),
                  uRmWarp.x * rmVN(p, uRmWarpP.x, s + 1u) + f * (uRmWarp.y * rmVN(p, uRmWarpP.y, s + 3u) + uRmWarp.z * rmVN(p, uRmWarpP.z, s + 6u) + uRmWarpZ.x * rmZNoise(p, zc, s + 8u)));
}
// signed stroke distance (tiles) at q → (sdf, noise amp): kind 0 = rivers (bent round the plots on the CPU, G16), 1 = tracks.
// P0: sampled from the baked pages (the old per-deed segment loop is gone); ≥ cap reads cap.
vec2 rmStroke(int kind, vec2 q) { return kind == 0 ? rmRiver(q) : vec2(rmLand(q).x, uRmBake.y); }
float rmTrack(vec2 q) { return rmLand(q).x; }
// hashed-split parcel containing vertex v → (x0, y0, x1, y1)
ivec4 rmParcel(ivec2 v) {
  int B = uRmNoisePer.w, span = uRmParcel.y - uRmParcel.x + 1; int salt = int(uRmNoiseSeed.w);
  int bx = rmFloorDiv(v.x, B), by = rmFloorDiv(v.y, B);
  uint h = kitHash(bx ^ salt, by ^ (salt << 1));
  int s1 = uRmParcel.x + int((h >> 1u) % uint(span)), ox = bx * B, oy = by * B;
  int x0, x1, y0, y1;
  if ((h & 1u) != 0u) {
    bool left = v.x - ox < s1; x0 = left ? ox : ox + s1; x1 = left ? ox + s1 : ox + B;
    int s2 = uRmParcel.x + int(kitHash((bx * 2 + (left ? 0 : 1)) ^ salt, by ^ 0x51) % uint(span));
    bool top = v.y - oy < s2; y0 = top ? oy : oy + s2; y1 = top ? oy + s2 : oy + B;
  } else {
    bool top = v.y - oy < s1; y0 = top ? oy : oy + s1; y1 = top ? oy + s1 : oy + B;
    int s2 = uRmParcel.x + int(kitHash(bx ^ 0x51, (by * 2 + (top ? 0 : 1)) ^ salt) % uint(span));
    bool left = v.x - ox < s2; x0 = left ? ox : ox + s2; x1 = left ? ox + s2 : ox + B;
  }
  return ivec4(x0, y0, x1, y1);
}
uint rmDoneC(uint c, float plot) { return plot < 1.0 && c <= 2u ? 4u : c; }
// the GROUND class of tile vertex v (§3.2 step 5, plot rules first; G12: the ring flag says "plot ground, keep clear");
// also returns coast/inland for overlays, and (P0) the track, plot and bridge values the resolve's flags need.
// classify.js classDetail().ground / .ring
uint rmClassCore(ivec2 v, out float coastOut, out float inlandOut, out bool ring, out float trackOut, out float plotOut, out float bridgeOut) {
  vec2 p = vec2(v);
  ring = false;
  RmNb nb = rmNb(p);
  float plot = rmPlotSdfN(p, nb);
  vec2 cl2 = rmCoastLake(rmLakeWarp(p));                            // G14: warped shore and lake, one bilinear
  float coast0 = cl2.x + uRmNoiseAmp.x * vnoise(v, uRmNoisePer.x, uRmNoiseSeed.x) + uRmNoiseAmp.w * vnoise(v, uRmCoast2.x, uint(uRmCoast2.y));
  float isl = rmIsleForceN(p, nb);                                  // G16 the island, forced dry
  float coast = isl > -RM_FAR ? rmSmax(coast0, isl, uRmCfgA.x) : coast0;
  float inland = rmInlandV(cl2.y, rmRiver(p), vnoise(v, uRmNoisePer.y, uRmNoiseSeed.y), isl, plot);
  vec2 land = rmLand(p);                                            // P0: the baked track field
  float bf = rmBridgeN(p, nb);                                      // G15 land bridges
  if (bf > -RM_FAR) { coast = rmSmax(coast, bf, uRmBridge.x); inland = rmSmax(inland, bf, uRmBridge.x); }
  coastOut = coast; inlandOut = inland; trackOut = land.x; plotOut = plot; bridgeOut = bf;
  float track = land.x;
  ivec2 d = nb.d0; int L = nb.L[4];
  ivec2 l = ivec2(0); float hc = 0.0;
  if (L > 0) {
    l = v - d * RM_TILES - rmPlotOff(d, L); hc = uRmPlot[L].x * 0.5;
    if (float(l.x) >= 49.0 - hc && float(l.x) <= 49.0 + hc && float(l.y) >= 49.0 - hc && float(l.y) <= 49.0 + hc) return 11u; // TURF
    // the frayed claim border (classify.js claimRag): dry land within amp·max(0, noise) t of the claim box is TURF too
    vec2 re = max(max(vec2(49.0 - hc) - vec2(l), vec2(0.0)), vec2(l) - vec2(49.0 + hc));
    if (uRmRag.x > 0.0 && coast >= 0.0 && inland >= 0.0 && length(re) <= uRmRag.x * max(0.0, vnoise(v, int(uRmRag.y), uint(uRmRag.z)))) return 11u;
  }
  // G12/G13: the clearing (⊇ plot box + 1 t; dry land only outside it) is RING for LIFE, its ground stays the realm's;
  // the apron around the claim is RING ground, the feather beyond it keeps ground classes only
  bool feather = false;
  if (plot < uRmRing.x + uRmRing2.x + uRmRing.z + uRmRing.w + 1.0) {
    float cl = rmClearingN(p, nb);
    ring = plot < 1.0 || (cl < 0.0 && coast >= 0.0 && inland >= 0.0);
    if (ring && L > 0) {
      vec2 e = max(max(vec2(49.0 - hc) - vec2(l), vec2(0.0)), vec2(l) - vec2(49.0 + hc));
      float cd = length(e), aw = uRmRing2.y + uRmRing2.z * (0.5 + 0.5 * rmVN(p, uRmApronP.x, uint(uRmApronP.y)));
      if (cd < aw) return 12u;
      feather = cd < aw + uRmRing2.w;
    }
  }
  if (coast < -uRmCfgB.x) return rmDoneC(0u, plot);                 // DEEP
  if (coast < 0.0) return rmDoneC(1u, plot);                        // SEA
  if (inland < 0.0) return rmDoneC(2u, plot);                       // WATER
  if (uRmCfgB.z > 0.5 && coast < uRmCfgB.y + uRmNoiseAmp.z * vnoise(v, uRmNoisePer.z, uRmNoiseSeed.z)) return 3u; // SHORE
  vec2 pw = rmClassWarp(p);                                         // G11: land classes at the warped point
  vec3 bcA = rmBC3(pw, false);                                      // forest, field, rock at pw (P0: one bilinear)
  float rock = bcA.z;
  if (uRmCfgC.x >= 0.0) {
    float hs = uRmCfgC.y;
    float gx = rmBilin(uRmFieldsA, pw + vec2(hs, 0.0), uRmFieldsPpd.x, 2, 0, textureSize(uRmFieldsA, 0).x) - rmBilin(uRmFieldsA, pw - vec2(hs, 0.0), uRmFieldsPpd.x, 2, 0, textureSize(uRmFieldsA, 0).x);
    float gy = rmBilin(uRmFieldsA, pw + vec2(0.0, hs), uRmFieldsPpd.x, 2, 0, textureSize(uRmFieldsA, 0).x) - rmBilin(uRmFieldsA, pw - vec2(0.0, hs), uRmFieldsPpd.x, 2, 0, textureSize(uRmFieldsA, 0).x);
    if (length(vec2(gx, gy)) / 255.0 / (2.0 * hs) * float(RM_TILES) > uRmCfgC.x) rock = 1.0;
  }
  if (rock >= uRmCfgB.w && inland > uRmCfgE.x && coast > uRmCfgE.x && !feather) return rmBC3(pw, true).x >= uRmCfgC.z ? 8u : 7u; // SNOW / ROCK
  if (track < 0.0 && inland > uRmCfgE.z && coast > uRmCfgE.w) return 10u; // ROAD (up to the fence)
  ivec4 pc = rmParcel(ivec2(floor(pw + 0.5)));
  if (rmBC(vec2(float(pc.x + pc.z), float(pc.y + pc.w)) * 0.5, 1, false) >= uRmCfgC.w) return feather ? 4u : 6u; // FIELD
  if (bcA.x >= uRmCfgD.x) return feather ? 4u : 13u;               // FOREST
  vec3 bcB = rmBC3(pw, true);                                       // snow, ground2, special at pw
  if (bcB.z >= uRmCfgD.y) return feather ? 4u : 9u;                 // SPECIAL
  if (bcB.y >= uRmCfgD.z) return 5u;                                // GROUND2
  return 4u;                                                        // WILD
}
uint rmClassAtG(ivec2 v, out float coastOut, out float inlandOut, out bool ring) { float t, p, b; return rmClassCore(v, coastOut, inlandOut, ring, t, p, b); }
// the class of tile vertex v as LIFE, BASES and QC see it (classify.js classAt): RING across the clearing
uint rmClassAt(ivec2 v, out float coastOut, out float inlandOut) { bool r; uint g = rmClassAtG(v, coastOut, inlandOut, r); return r ? 12u : g; }
uniform ivec4 uRsOrigin; // x0, y0 (tile vertex of the region's first non-apron texel), step, apron
layout(location = 0) out uint oCls;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  ivec2 v = uRsOrigin.xy + (ij - uRsOrigin.w) * uRsOrigin.z;
  float c, w, track, plot, bridge; bool ring;
  uint cls = rmClassCore(v, c, w, ring, track, plot, bridge); // G12: the ground class; bit 7 = the plot's clearing
  uint fl = 0u;                                          // P0: the flags reuse the class's own track / plot / bridge values
  if (c < 14.0 || w < 14.0) fl |= 1u;
  if (plot < 30.0 || bridge > -8.0 || (c < 14.0 && plot < uRmIsle3.z + 5.0) || track < 10.0) fl |= 4u; // near a plot, a land bridge (G15), an islet's halo or a track
  oCls = cls | (fl << 4u) | (ring ? 128u : 0u);
#ifdef RM_DBG_RAWINLAND
  oCls = uint(clamp(w * 8.0 + 128.0, 0.0, 255.0));
#endif
#ifdef RM_DBG_RAWRIVER
  oCls = uint(clamp(rmRiver(vec2(v)).x * 8.0 + 128.0, 0.0, 255.0));
#endif
}
