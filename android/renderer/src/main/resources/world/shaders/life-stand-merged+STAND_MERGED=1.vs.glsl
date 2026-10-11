#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_VS 1
#define STAND_MERGED 1


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

uniform highp usampler2DArray uRmLattice;   // R8UI pages of lattice vertices (7 tiles apart): class + 1, 0 = unresolved
uniform highp usampler2DArray uRmRecords;   // RGBA16UI 98×98 per resident deed page
uniform highp usampler2D uRmPageTable;      // R16UI cols×rows: record layer + 1 (0 = not resident)
uniform ivec4 uRmLat;                       // page size, pages x, lattice width, lattice height

// RM-23 (fix pass): a vertex outside the realm grid is the open sea, encoded DEEP (class 0 + 1, no flags): "WILD until
// resolved" there put LIFE's scrub and rocks in one row just past every grid edge. No lattice yet (z 0): unresolved.
uint rmLatTexel(ivec2 v) {
  ivec2 l = ivec2(floor(vec2(v) / 7.0 + 0.5));
  if (l.x < 0 || l.y < 0 || l.x >= uRmLat.z || l.y >= uRmLat.w) return uRmLat.z > 0 ? 1u : 0u;
  ivec2 pg = l / uRmLat.x;
  return texelFetch(uRmLattice, ivec3(l - pg * uRmLat.x, pg.y * uRmLat.y + pg.x), 0).r;
}
uint rmLatClass(uint r) { uint c = r & 15u; return c == 0u ? 4u : (r & 128u) != 0u ? 12u : c - 1u; } // G12: bit 7 = clearing
uint mapClassAt(ivec2 v) { return rmLatClass(rmLatTexel(v)); }
uint mapFlagsAt(ivec2 v) { return (rmLatTexel(v) >> 4u) & 7u; }
bool pageResident(ivec2 deed) {
  if (deed.x < 0 || deed.y < 0 || deed.x >= uRmGrid.x || deed.y >= uRmGrid.y) return false;
  return texelFetch(uRmPageTable, deed, 0).r != 0u;
}
uvec4 tileRecord(ivec2 t) {
  ivec2 d = rmDeedOf(t);
  if (!pageResident(d)) return uvec4(0u);
  uint layer = texelFetch(uRmPageTable, d, 0).r - 1u;
  return texelFetch(uRmRecords, ivec3(t - d * RM_TILES, int(layer)), 0);
}
uint mapClassFine(ivec2 t) {
  uint r = rmLatTexel(t), c = rmLatClass(r);
  if ((r & 16u) == 0u || c == 11u || c == 12u) return c;             // no water within 14 t of the vertex; a plot's claim
  vec2 p = vec2(t), cl = rmCoastLake(rmLakeWarp(p));                 // the baked fields, read like rmClassCore reads them
  float coast = cl.x + uRmNoiseAmp.x * vnoise(t, uRmNoisePer.x, uRmNoiseSeed.x) + uRmNoiseAmp.w * vnoise(t, uRmCoast2.x, uint(uRmCoast2.y));
  if (coast < 0.0) return c <= 1u ? c : 1u;                           // SEA (DEEP where the lattice says so)
  float nz = vnoise(t, uRmNoisePer.y, uRmNoiseSeed.y); vec2 rv = rmRiver(p);
  if (min(cl.y + uRmNoiseAmp.y * nz, rv.x + min(uRmNoiseAmp.y, rv.y) * nz) < 0.0) return 2u; // WATER
  return c;
}
uint classAtTile(ivec2 t) {
  ivec2 d = rmDeedOf(t);
  if (pageResident(d)) return tileRecord(t).w & 15u;
  return mapClassFine(t);
}
float plotSdf(vec2 tile) { return rmPlotSdf(tile); }
bool walkable(ivec2 t) {
  uint c = classAtTile(t);
  if (c <= 2u || c == 7u || c == 8u) return false;
  return rmPlotSdf(vec2(t) + 0.5) > 1.0;
}


uniform highp usampler2D uLTable;
const int SPT = 6;                           // table texels per species
const float DEED_ART_F = 3136.0;
const float MIN_INK = 18816.0;               // MIN_SPRITE_PX (6) · DEED_ART: inkH · d must reach it
const float PLOT_CLEAR = 2.0;
const int LOOP_R = 96;                        // LOOP_RADIUS_TILES (3) · 32 art px
const int SNAP = 16;                          // WAYPOINT_SNAP

int floorDiv(int a, int b) { return a >= 0 ? a / b : -((-a + b - 1) / b); } // b > 0 (GLSL % and / on negatives are undefined)
ivec2 tileOf(ivec2 art) { return ivec2(floorDiv(art.x, 32), floorDiv(art.y, 32)); }
uvec4 lt(int x, int row) { return texelFetch(uLTable, ivec2(x, row), 0); }
uint density(int row, uint cls) { return lt(int(cls) >> 2, row + 1)[int(cls) & 3]; }
// LIFE's class of tile t: SAMPLED baked classes only (fix iteration 2, orchestrator P0 decision). LIFE never inlines
// GROUND's §3.2 classifier (rmClassAt / classAtTile / walkable): each inlined copy cost SwiftShader tens of seconds of
// pipeline JIT (the SCATTER program with 3 copies had not linked after 240 s; with none it links and draws in 1.5 s),
// every LIFE shader holds 1–9 class reads, and a real GPU links these programs at load. So:
//  - uTrueCls (scatter.js trueClasses: d >= BANDS.pageResolve, from where GROUND keeps the view +-1 deed resident):
//    the deed's resident TRUE page record (GROUND's own rule in classAtTile's resident branch);
//  - otherwise the MAP lattice class (7-tile vertices): a pure function of the position, so clumps, map objects and
//    herds never depend on the camera's history or a context restore (the LRU keeps leftover pages below pageResolve).
// lifeClassSeat: the same rule, but below the TRUE records GROUND's sampled near-water class (mapClassFine: exact about
// water between lattice vertices, so a river narrower than the lattice keeps its trees off). It costs 10 fetches near
// water (1 elsewhere) and ~0.4–1.2 s of SwiftShader JIT per inlined copy, so it is read ONCE per placement, at the seat
// of a scatter instance, a stand and a herd; neighbourhood probes, walks, birds and ambience keep lifeClass (every read
// fine measured LIFE's JIT at 31 s against 11 s, lane-life.md). Both sides of SHELL's CLASSES_STUB define these lookups.
uniform int uTrueCls;
const int DEED_TILES = 98;                   // contracts.js TILES
uint lifeClass(ivec2 t) {
  if (uTrueCls != 0 && pageResident(ivec2(floorDiv(t.x, DEED_TILES), floorDiv(t.y, DEED_TILES)))) return tileRecord(t).w & 15u;
  return mapClassAt(t);
}
uint lifeClassSeat(ivec2 t) {
  if (uTrueCls != 0 && pageResident(ivec2(floorDiv(t.x, DEED_TILES), floorDiv(t.y, DEED_TILES)))) return tileRecord(t).w & 15u;
  return mapClassFine(t);
}
#ifdef REALM_VS
// SHELL's band rehearsal (contracts GPU_SAFE.rehearse v2, W1): the pipeline's fragment-side work is built at the first
// draw that SHADES fragments, and LIFE's instances go wherever the data puts them (or cull). While uRehearse is set,
// every vertex of the ONE rehearsal instance — culled or placed, after the whole real vertex path ran — covers the
// viewport at the near plane (so the view centre, i.e. SHELL's scissored box, whatever the depth buffer holds); the
// fragment shader then runs with the instance's real varyings and textures. Every real draw sets it to 0 (life.js).
uniform int uRehearse;
void rehearsalCover() { if (uRehearse != 0) { int v = gl_VertexID % 3; gl_Position = vec4(v == 1 ? 3.0 : -1.0, v == 2 ? 3.0 : -1.0, -1.0, 1.0); } }
void cullVertex() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); rehearsalCover(); }
#endif
// a 16-bit hash field → [0, n) by multiply-shift (scatter.js range16). Never "% constant": compilers
// mis-optimise constant-divisor modulo after a shift (SwiftShader: (u >> 16u) % 97u is wrong).
uint range16(uint h16, uint n) { return ((h16 & 0xffffu) * n) >> 16u; }
// lattice cell hashes of a stream (scatter.js cellHash): h = pcg2d, h2 = kitHash
uvec2 cellH(int salt, ivec2 c) { return pcg2d(uvec2(ivec2(c.x ^ salt, c.y ^ (salt * 7)))); }
uint cellH2(int salt, ivec2 c) { return kitHash(c.x ^ salt, c.y); }
// integer seat (art px) of lattice cell c (scatter.js cellSeat)
ivec2 cellSeat(ivec2 c, int pitch, int jitter, uvec2 h) {
  int off = (pitch - jitter) >> 1; uint J = uint(jitter + 1);
  return c * pitch + off + ivec2(int(range16(h.x, J)), int(range16(h.x >> 16u, J)));
}
// ---- rank windows (W1; scatter.js rankHash / slotXY / xySlot / cellRank / slotCell): a cell's 16-bit rank is its
// slot j in its world-aligned 4×4 block (a scrambled ordered-dither order) · 4096 + the block hash's top 12 bits. The
// MAP→TRUE dissolve and the §9 thinning keep ranks under a bound, and a rank window submits only slots j0…j0+m−1 of
// every block. Loop-free integer maths.
const int RANK_B = 4, RANK_STEP = 4096;
uint rankHash(int salt, ivec2 b) { return pcg2d(uvec2(ivec2(b.x ^ salt ^ 0x5a17, b.y ^ (salt * 7) ^ 0x3c6e))).x; }
ivec2 rankScramble(uint h) { return ivec2(int(h & 3u), int((h >> 4u) & 3u)); }
ivec2 slotXY(int j) {
  int a = j & 3, b = (j >> 2) & 3;
  return ivec2((((a ^ (a >> 1)) & 1) << 1) | ((b ^ (b >> 1)) & 1), ((a & 1) << 1) | (b & 1));
}
int xySlot(ivec2 l) {
  int a = ((((l.x >> 1) ^ (l.y >> 1)) & 1) << 1) | ((l.y >> 1) & 1), b = (((l.x ^ l.y) & 1) << 1) | (l.y & 1);
  return a | (b << 2);
}
int cellRank(int salt, ivec2 c) {
  ivec2 b = ivec2(floorDiv(c.x, RANK_B), floorDiv(c.y, RANK_B)); uint h = rankHash(salt, b);
  return xySlot((c - b * RANK_B) ^ rankScramble(h)) * RANK_STEP + int(h >> 20u);
}
ivec2 slotCell(int salt, ivec2 b, int j, out int rank) {
  uint h = rankHash(salt, b); rank = j * RANK_STEP + int(h >> 20u);
  return b * RANK_B + (slotXY(j) ^ rankScramble(h));
}
// first species whose cumulative weight covers pick16 (scatter.js pickSpecies, a linear scan): a lower-bound search of the
// non-decreasing cum − 1 column, the same index. Stage B: MAX_SPECIES 64 (Solana Reach ships 53 map objects) in ≤ 7 fetches;
// the literal bound caps the work whatever n holds (2^7 > MAX_SPECIES).
int pickSpecies(int row, int n, uint pick) {
  int lo = 0, hi = n;
  for (int i = 0; i < 7; i++) { if (lo >= hi) break; int mid = (lo + hi) >> 1; if (pick <= lt(mid * SPT, row).y) hi = mid; else lo = mid + 1; }
  return lo < n ? lo : -1;
}
// walkable class for a creature kind (scatter.js walkableFor): ground avoids water, roads and plots' classes
bool walkableFor(uint kind, uint cls) {
  if (kind == 1u) return cls == 1u || cls == 2u || cls == 3u;               // WATER, SEA, SHORE
  return !(cls <= 2u || cls == 10u || cls == 11u || cls == 12u);            // not DEEP/SEA/WATER/ROAD/TURF/RING
}
int snapArt(int v) { return floorDiv(v + SNAP / 2, SNAP) * SNAP; }         // Math.round(v / 16) · 16
// every half tile along the straight walk a→b is walkable (scatter.js segmentWalkable)
bool segmentWalkable(uint kind, ivec2 a, ivec2 b) {
  ivec2 dv = b - a; int n = max(1, (max(abs(dv.x), abs(dv.y)) + SNAP - 1) / SNAP);
  for (int k = 1; k < 16; k++) {
    if (k >= n) break;
    ivec2 q = a + ivec2(floorDiv(dv.x * k, n), floorDiv(dv.y * k, n));
    if (!walkableFor(kind, lifeClass(tileOf(q)))) return false;
  }
  return true;
}
// GPU-hang guard (fix iteration 2, P0): no data-driven loop in any LIFE shader (every loop has a literal bound;
// scatter.test checks the source). isqrtU had two uint while-loops: an overflowed dv.x·dv.x wrapped n, (r+1)² wrapped
// too, and the loop could spin ~2^32 times per vertex. Now: a waypoint step is clamped to ±DV_MAX art px (a herd step
// is ≤ 2·LOOP_R = 192 per axis, so the clamp never binds on real data), and isqrtU is a float sqrt with r ≤ 65535
// (no r² wrap) plus at most one guarded correction each way. For any uint n the float sqrt is within ~0.002 + a few
// ULP of √n, so this is exactly ⌊√n⌋ (scatter.test replays it against scatter.js isqrt over 0…2·DV_MAX² with the
// sqrt perturbed ±4 ULP, and on the whole uint range). The clamp also keeps dv·t < DV_MAX · travelMs(DV_MAX, 1)
// < 2^31 in pathPose5, so garbage in is bounded garbage out, never a spin.
const int DV_MAX = 1024;
ivec2 dvSane(ivec2 dv) { return clamp(dv, ivec2(-DV_MAX), ivec2(DV_MAX)); }
uint isqrtU(uint n) {
  if (n < 2u) return n;
  uint r = min(uint(sqrt(float(n))), 65535u);
  if (r * r > n) r--;
  if (r < 65535u && (r + 1u) * (r + 1u) <= n) r++;
  return r;
}
int travelMs(ivec2 dv, int speed) { ivec2 c = dvSane(dv); return int(isqrtU(uint(c.x * c.x + c.y * c.y)) * 1000u / uint(max(speed, 1))); }
int facingOf(ivec2 dv) { // row in [down, left, right, up] (realmKitSegmentFacing + realmKitFacingRow, 4 directions)
  if (abs(dv.x) >= abs(dv.y)) return dv.x < 0 ? 1 : 2;
  return dv.y < 0 ? 3 : 0;
}
// realmKitPathPose on a closed 5-point loop (cycle). out: pos (art px), facing row, dwelling.
void pathPose5(ivec2 p[5], int speed, int dwell, uint elapsed, bool still, out ivec2 pos, out int row, out bool dwelling) {
  ivec2 d0 = p[1] - p[0];
  pos = p[0]; row = facingOf(d0); dwelling = true;
  if (still) return;
  int T[4]; int period = 0;
  for (int i = 0; i < 4; i++) { T[i] = travelMs(p[i + 1] - p[i], speed); period += dwell + T[i]; }
  int t = period > 0 ? int(elapsed % uint(period)) : 0;
  for (int i = 0; i < 4; i++) {
    ivec2 dv = dvSane(p[i + 1] - p[i]);
    if (t < dwell) { pos = p[i]; row = facingOf(dv); dwelling = true; return; }
    t -= dwell;
    if (t < T[i]) { pos = p[i] + ivec2(floorDiv(dv.x * t, T[i]), floorDiv(dv.y * t, T[i])); row = facingOf(dv); dwelling = false; return; }
    t -= T[i];
  }
}
// ---- round 2: the stand field, clearing edges, species clusters (scatter.js "round 2" section) ----------
uniform ivec4 uField;    // stand-field salts: veg, rock, -, -
uniform ivec4 uCover;    // cover ramps: veg lo, veg k, rock lo, rock k  (k = 65536 / (hi − lo))
const int EDGE_FLAT_Q = 32; // STAND.edgeFlat (8) · 4 quarter tiles at full weight
const int EDGE_Q = 56;   // (STAND.edgeFlat + STAND.edgeTiles) · 4
const int EDGE_INV = 2730; // ⌊65536 / (STAND.edgeTiles · 4)⌋
uint fadeU8(uint t) { return (t * t * (768u - 2u * t)) >> 16u; }
uint vcell(int salt, int cx, int cy) { return pcg2d(uvec2(ivec2(cx ^ salt, cy ^ (salt * 7)))).x & 255u; }
uint valueU8(int salt, ivec2 p, int sh) {
  int m = (1 << sh) - 1; ivec2 c = p >> sh;
  uint fx = fadeU8(uint(((p.x & m) << 8) >> sh)), fy = fadeU8(uint(((p.y & m) << 8) >> sh));
  uint a = vcell(salt, c.x, c.y) * (256u - fx) + vcell(salt, c.x + 1, c.y) * fx;
  uint b = vcell(salt, c.x, c.y + 1) * (256u - fx) + vcell(salt, c.x + 1, c.y + 1) * fx;
  return (a * (256u - fy) + b * fy) >> 16u;
}
uint standField(int salt, ivec2 p) { return (valueU8(salt, p, 10) * 3u + valueU8(salt ^ 0x5bd1, p, 9)) >> 2u; }
int coverOf(uint V, int lo, int k) { return clamp(((int(V) - lo) * k) >> 8, 0, 256); }
int fieldCover(int f, ivec2 p) { return f == 1 ? coverOf(standField(uField.y, p), uCover.z, uCover.w) : coverOf(standField(uField.x, p), uCover.x, uCover.y); }
// −1 inside the clearance, 255 for EDGE_FLAT_Q quarter tiles beyond, then falling to 0 at EDGE_Q (scatter.js edgeWeight)
int edgeW(float sdf, float clear) { int e = int(floor(min(sdf - clear, 64.0) * 4.0)); return e < 0 ? -1 : e < EDGE_FLAT_Q ? 255 : e >= EDGE_Q ? 0 : ((EDGE_Q - e) * EDGE_INV) >> 8; }
uint modDensity(uint dens, int outK, int inK, int edgeK, int cov, int ew) {
  int m = outK + (((inK - outK) * cov) >> 8);
  m = max(m, ew > 0 ? (edgeK * ew) >> 8 : 0);
  return min(65535u, (dens * uint(m)) >> 8u);
}
uint clusterPick(int salt, ivec2 p) { return pcg2d(uvec2(ivec2((p.x >> 8) ^ (salt * 3), (p.y >> 8) ^ (salt * 5)))).x >> 16u; }

// The scatter instance of lattice cell c in a group (scatter.js scatterInstance): seat, species, h2, class.
// B = (pitchArt, jitterArt, salt, nSpecies); C = (flags, table row, out | in<<12, edge | field<<12 | mod<<13 |
// cluster8<<16) — the round-2 density modulation and species clusters. False when culled.
bool scatterPick(ivec2 c, ivec4 B, ivec4 C, out ivec2 seat, out int s, out uint h2) {
  int row = C.y;
  uvec2 h = cellH(B.z, c); h2 = cellH2(B.z, c);
  seat = cellSeat(c, B.x, B.y, h); s = -1;
  ivec2 tile = tileOf(seat);
  uint cls = lifeClassSeat(tile);
  uint dens = density(row, cls);
  float sdf = 0.0; bool haveSdf = false;
  if ((C.w & 0x2000) != 0 && dens != 0u) {
    sdf = plotSdf(vec2(seat) / 32.0); haveSdf = true;
    dens = modDensity(dens, C.z & 4095, C.z >> 12, C.w & 4095, fieldCover((C.w >> 12) & 1, seat), edgeW(sdf, PLOT_CLEAR));
  }
  if ((h.y & 0xffffu) >= dens) return false;
  uint pick = h.y >> 16u;
  int cl = (C.w >> 16) & 255;
  if (cl > 0 && int(pcg2d(h).x & 255u) < cl) pick = clusterPick(B.z, seat);
  s = pickSpecies(row, B.w, pick);
  if (s < 0) return false;
  uvec4 t0 = lt(s * SPT, row);
  if ((C.x & 4) != 0 && t0.w != 0u && ((t0.w >> cls) & 1u) == 0u) { // map objects: two more picks (scatter.js scatterInstance)
    uint e = pcg2d(uvec2(h.y, h.x)).x;
    int s2 = pickSpecies(row, B.w, e >> 16u);
    uint w2 = s2 >= 0 ? lt(s2 * SPT, row).w : 0u;
    if (s2 < 0 || (w2 != 0u && ((w2 >> cls) & 1u) == 0u)) { s2 = pickSpecies(row, B.w, e & 0xffffu); w2 = s2 >= 0 ? lt(s2 * SPT, row).w : 0u; }
    if (s2 >= 0 && (w2 == 0u || ((w2 >> cls) & 1u) != 0u)) { s = s2; t0 = lt(s * SPT, row); }
  }
  uvec4 t1 = lt(s * SPT + 1, row);
  if (t0.w != 0u && ((t0.w >> cls) & 1u) == 0u) return false;
  int r = int(t1.w);
  if (r > 1) { // set pieces: the footprint corners stand on classes this group may use
    ivec2 k[4] = ivec2[4](ivec2(-r, -r), ivec2(r, -r), ivec2(-r, 0), ivec2(r, 0));
    for (int i = 0; i < 4; i++) {
      uint cc = lifeClass(tile + k[i]);
      if (t0.w != 0u ? ((t0.w >> cc) & 1u) == 0u : density(row, cc) == 0u) return false;  // species' classes, else the group's
    }
  }
  if (((t0.z >> 4u) & 1u) != 0u) { // coast need: open water within r + 3 tiles on one axis
    int q = r + 3; bool wet = false;
    ivec2 k[4] = ivec2[4](ivec2(q, 0), ivec2(-q, 0), ivec2(0, q), ivec2(0, -q));
    for (int i = 0; i < 4; i++) if (lifeClass(tile + k[i]) <= 2u) wet = true;
    if (!wet) return false;
  }
  return (haveSdf ? sdf : plotSdf(vec2(seat) / 32.0)) >= PLOT_CLEAR + float(r);
}
// ---- stands (scatter.js standSite / standMember). Table rows: row = species (SPT texels each), row+1 = per-mix
// class densities (mix k at texels 4k…4k+3), row+2+v = variant v: texel 0 (mix | members<<4 | field<<9 | sway<<10,
// R4, clumpLayer+1, clumpArray), 1 (clumpW | clumpH<<8, anchorX, anchorY, inkH) in map-art px (1 = 7 art px),
// 2+m (dx+32768, dy+32768, species, flip), 18 (footDy+32768).
uniform ivec4 uStand;    // pitchArt, jitterArt, salt, nVariants
uint mixDensity(int row, int mix, uint cls) { return lt(mix * 4 + (int(cls) >> 2), row + 1)[int(cls) & 3]; }
bool standSite(ivec2 c, int row, out ivec2 seat, out int v, out uint h2, out uvec4 hd, out float sdf) {
  uvec2 h = cellH(uStand.z, c); h2 = cellH2(uStand.z, c);
  seat = cellSeat(c, uStand.x, uStand.y, h);
  ivec2 tile = tileOf(seat);
  uint cls = lifeClassSeat(tile);
  uint e0 = pcg2d(h).x, nV = uint(uStand.w);                       // up to three picks (scatter.js standSite)
  v = int(range16(h.y >> 16u, nV)); hd = lt(0, row + 2 + v);
  if (mixDensity(row, int(hd.x & 15u), cls) == 0u) { v = int(range16(e0 & 0xffffu, nV)); hd = lt(0, row + 2 + v); }
  if (mixDensity(row, int(hd.x & 15u), cls) == 0u) { v = int(range16(e0 >> 16u, nV)); hd = lt(0, row + 2 + v); }
  int mix = int(hd.x & 15u);
  uint p = mixDensity(row, mix, cls);
  if (p == 0u) return false;
  sdf = plotSdf(vec2(seat) / 32.0);
  int ew = edgeW(sdf, PLOT_CLEAR + float(hd.y) * 0.25);
  if (ew < 0) return false;
  uint cov = ((hd.x >> 11u) & 1u) != 0u ? 256u : uint(fieldCover(int((hd.x >> 9u) & 1u), seat)); // a map-only canopy fills its class
  uint q = max((p * cov) >> 8u, (p * uint(ew)) >> 8u);
  if ((h.y & 0xffffu) >= q) return false;
  int R = (int(hd.y) + 3) >> 2, D = (R * 181) >> 8;             // whole tiles; the diagonal at R/√2
  ivec2 k[8] = ivec2[8](ivec2(R, 0), ivec2(-R, 0), ivec2(0, R), ivec2(0, -R), ivec2(D, D), ivec2(-D, D), ivec2(D, -D), ivec2(-D, -D));
  for (int i = 0; i < 8; i++) if (mixDensity(row, mix, lifeClass(tile + k[i])) == 0u) return false;
  return true;
}
#ifdef STAND_MERGED
// The merged clump of 2×2 stand block b (scatter.js mergedSite): its first stand in the order (0,0) (1,0) (0,1)
// (1,1) whose doubled clump (2R) clears every plot and stands on the mix's classes at 2R along both axes. Only the
// life-stand-merged program compiles it (P0 fix pass: its 4-trip loop over standSite was ~4/5 of STAND's JIT).
bool mergedSite(ivec2 b, int row, out ivec2 seat, out int v, out uint h2, out uvec4 hd) {
  float sdf;
  for (int i = 0; i < 4; i++) {
    if (!standSite(b * 2 + ivec2(i & 1, i >> 1), row, seat, v, h2, hd, sdf)) continue;
    int R2 = ((int(hd.y) + 3) >> 2) * 2, mix = int(hd.x & 15u);                  // STAND.merge = 2
    if (sdf < PLOT_CLEAR + float(R2)) continue;
    ivec2 t = tileOf(seat);
    if (mixDensity(row, mix, lifeClass(t + ivec2(R2, 0))) == 0u || mixDensity(row, mix, lifeClass(t - ivec2(R2, 0))) == 0u ||
        mixDensity(row, mix, lifeClass(t + ivec2(0, R2))) == 0u || mixDensity(row, mix, lifeClass(t - ivec2(0, R2))) == 0u) continue;
    return true;
  }
  return false;
}
#endif
// One herd member (scatter.js herdSite → herdMember → memberPose) on creature table row "row".
// cre = (pitchArt, jitterArt, salt, nSpecies). Returns false when the member is culled; the caller applies
// the anti-speckle rule. s = species, pos = feet (art px), frame = sheet frame (row·frames + walk).
bool herdMemberPose(ivec2 cell, int m, ivec4 cre, int row, float keep, uint clockMs, bool still, out int s, out ivec2 pos, out int frame) {
  s = -1; pos = ivec2(0); frame = 0;
  uvec2 h = cellH(cre.z, cell); uint h2 = cellH2(cre.z, cell);
  ivec2 seat = cellSeat(cell, cre.x, cre.y, h);
  uint cls = lifeClassSeat(tileOf(seat));
  if ((h.y & 0xffffu) >= density(row, cls)) return false;
  s = pickSpecies(row, cre.w, h.y >> 16u);
  if (s < 0) return false;
  uvec4 t0 = lt(s * SPT, row), t1 = lt(s * SPT + 1, row), t3 = lt(s * SPT + 3, row);
  uint kind = t0.z;
  if (((t0.w >> cls) & 1u) == 0u || !walkableFor(kind, cls)) return false;
  if (plotSdf(vec2(seat) / 32.0) < PLOT_CLEAR + 3.0 + 2.0) return false;
  if (float(h2 & 0xffffu) >= keep * 65536.0) return false;
  int n = int(t3.y) + int(range16(h2 >> 16u, t3.z - t3.y + 1u));
  if (m >= n) return false;
  uvec2 ab = pcg2d(uvec2(h2 ^ uint(m * 0x9e37), uint(cell.x * 31 + cell.y * 17 + m)));
  ivec2 home = m == 0 ? ivec2(snapArt(seat.x), snapArt(seat.y))
                      : ivec2(snapArt(seat.x + int(range16(ab.x, 97u)) - 48), snapArt(seat.y + int(range16(ab.x >> 16u, 97u)) - 48));
  if (!walkableFor(kind, lifeClass(tileOf(home)))) return false;
  uvec2 c12 = pcg2d(ab); uint c3 = pcg2d(uvec2(ab.y, ab.x)).x;
  uint hs[3] = uint[3](c12.x, c12.y, c3);
  ivec2 p[5]; p[0] = home; p[4] = home;
  uint span = uint(2 * LOOP_R + 1);
  ivec2 prev = home;
  for (int i = 0; i < 3; i++) {
    ivec2 q = ivec2(snapArt(home.x + int(range16(hs[i], span)) - LOOP_R), snapArt(home.y + int(range16(hs[i] >> 16u, span)) - LOOP_R));
    if (walkableFor(kind, lifeClass(tileOf(q))) && segmentWalkable(kind, prev, q) && segmentWalkable(kind, q, home)) prev = q;
    p[i + 1] = prev;
  }
  uint elapsed = clockMs + ((ab.y >> 8u) & 0xffffu);
  int facing; bool dwelling;
  pathPose5(p, int(t1.w), int(t3.x), elapsed, still, pos, facing, dwelling);
  int frames = int(t1.x);
  frame = facing * frames + (still || dwelling ? 0 : int((elapsed / max(t1.y, 1u)) % uint(frames)));
  return true;
}

layout(location = 0) in vec2 aQ;
uniform ivec4 uWin;      // ix0, iy0, nx, stride (uMode 3: block coordinates; stride 2 thins them world-aligned); a rank window: bx0, by0, nbx
uniform ivec4 uRank;     // W1 rank window (scatter.js rankDraw): slots per block (0: plain), first slot, TRUE rank bound, this draw's upper rank bound
uniform int uRow;
uniform int uArray;
uniform int uMode;
uniform vec4 uSplit;     // STAND.splitFrom, STAND.splitFull, STAND.mergeFrom, S.mergeUntil (d)
out vec2 vTex;
flat out int vLayer;
flat out float vFade;
// own clump shows (scatter.js ownClump): over 6 px and switched in by its per-stand hashed hand-over
bool ownClump(uint inkH, uint h2, float d) {
  return float(inkH) * d >= MIN_INK && dissolve(h2 >> 16u, clamp((d - uSplit.x) / (uSplit.y - uSplit.x), 0.0, 1.0));
}
void main() {
  int id = gl_InstanceID, m = 0;
  ivec2 seat; int v; uint h2; uvec4 hd; float sdf;
  float d = uViewport.z, k = 7.0;
#ifdef STAND_MERGED
  // merged (uMode 3): the block's first stand whose doubled clump clears plots and stays on its mix's ground
  ivec2 cell = ivec2(uWin.x, uWin.y) + ivec2(id % uWin.z, id / uWin.z) * max(1, uWin.w);
  if (!mergedSite(cell, uRow, seat, v, h2, hd)) { cullVertex(); return; }
  k = 14.0; // STAND.merge (2) · 7 art px per map px
  bool tru = dissolve(h2, uBand.z);                 // merged blocks end before the TRUE fade (w.true = 0: never)
#else
  if (uMode == 0) { m = id & 15; id = id >> 4; }  // STAND.members = 16 (bitwise: no division by a constant)
  ivec2 cell; int rank;
  if (uRank.x > 0) { int bi = id / uRank.x; cell = slotCell(uStand.z, ivec2(uWin.x + bi % uWin.z, uWin.y + bi / uWin.z), uRank.y + id % uRank.x, rank); }
  else { cell = ivec2(uWin.x, uWin.y) + ivec2(id % uWin.z, id / uWin.z) * max(1, uWin.w); rank = cellRank(uStand.z, cell); }
  // members [0, uRank.w), own clumps [uRank.z, uRank.w): culled before the stand site's reads
  if (rank >= uRank.w || (uMode == 2 && rank < uRank.z)) { cullVertex(); return; }
  if (!standSite(cell, uRow, seat, v, h2, hd, sdf)) { cullVertex(); return; }
  bool tru = rank < uRank.z;                        // one switch per stand: its rank (W1)
#endif
  bool flip = ((h2 >> 16u) & 1u) == 1u;
  int vrow = uRow + 2 + v;
  vec2 corner, size; int layer; float footY;
#ifndef STAND_MERGED
  if (uMode == 0) {
    if (!tru || m >= int((hd.x >> 4u) & 31u) || ((hd.x >> 11u) & 1u) != 0u) { cullVertex(); return; } // map-only canopy: no TRUE members
    uvec4 mm = lt(2 + m, vrow);
    int dx = int(mm.x) - 32768;
    ivec2 pos = seat + ivec2(flip ? -dx : dx, int(mm.y) - 32768);
    if (mixDensity(uRow, int(hd.x & 15u), lifeClass(tileOf(pos))) == 0u || plotSdf(vec2(pos) / 32.0) < PLOT_CLEAR + 1.0) { cullVertex(); return; }
    int s = int(mm.z);
    uvec4 t0 = lt(s * SPT, uRow), t1 = lt(s * SPT + 1, uRow), t2 = lt(s * SPT + 2, uRow);
    if (int(t0.z & 15u) != uArray || float(t1.z) * d < MIN_INK) { cullVertex(); return; }
    bool mf = flip != (mm.w != 0u);
    size = vec2(t2.xy);
    corner = vec2(pos) + vec2(aQ.x * size.x - (mf ? size.x - float(t2.z) : float(t2.z)), aQ.y * size.y - float(t2.w));
    if (((hd.x >> 10u) & 1u) != 0u && uLod.z > 0.5 && uViewport.w < 0.5 && aQ.y < 0.5) { // A7 sway: top edge ±1 art px
      uint ph = (h2 >> 17u) ^ uint(m * 977);
      uint period = 3000u + range16(ph, 2001u);
      corner.x += floor(sin(float(uClock.x % period) / float(period) * 6.2831853 + float(ph & 0x7fffu)) + 0.5);
    }
    vTex = vec2(mf ? 1.0 - aQ.x : aQ.x, aQ.y) * size;
    layer = int(t0.x);
    footY = float(pos.y);
  } else
#endif
  { // a clump: the stand's own (uMode 2) or its block's merged one (uMode 3)
    if (tru || hd.z == 0u || int(hd.w) != uArray) { cullVertex(); return; }
    uvec4 hc = lt(1, vrow);
    bool own = ownClump(hc.w, h2, d);
    if (uMode == 2 ? !own : (own || d < uSplit.z || d >= uSplit.w || float(hc.w) * 2.0 * d < MIN_INK)) { cullVertex(); return; }
    size = vec2(float(hc.x & 255u), float(hc.x >> 8u));
    corner = vec2(seat) + vec2(aQ.x * size.x - (flip ? size.x - float(hc.y) : float(hc.y)), aQ.y * size.y - float(hc.z)) * k;
    vTex = vec2(flip ? 1.0 - aQ.x : aQ.x, aQ.y) * size;
    layer = int(hd.z) - 1;
    footY = float(seat.y) + float(int(lt(18, vrow).x) - 32768) * (k / 7.0);
  }
  gl_Position = cssToClip(deedToCss(corner / DEED_ART_F), spriteDepth(deedToCss(vec2(float(seat.x), footY) / DEED_ART_F).y));
  vLayer = layer; vFade = 1.0;
  rehearsalCover();
}
