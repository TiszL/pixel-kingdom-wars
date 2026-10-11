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

uniform highp usampler2D uTrV;      // 99×99 R8UI legalised vertex classes of this deed
uniform ivec2 uTrDeed;              // deed x, y
uniform ivec4 uTrClaim;             // claim x0, y0, x1, y1 (deed-local vertices, closed, G8 offset); x0 −1 = no plot
uniform int uTrTerr[14];            // class → true terrain index 0…15 (15 = unused)
uniform int uTrLayer[16];           // terrain → composite order (kit.json layer, scaled to ints)
uniform ivec4 uTrPure[16];          // terrain → first pure layer word, variant count, kind (1 = water), -
uniform ivec4 uTrPair4[64];         // terrain a·16 + b → family slot, −1 = none (symmetric), 4 per ivec4
uniform ivec4 uTrFam[48];           // family slot → layer word of mask 1, upper terrain, lower terrain, -
uniform int uTrWaterPhases;         // open-water phases (4)
uniform int uTrDecal[14];           // class → decal group + 1 (0 none)
uniform ivec4 uTrDecalGroup[8];     // group → density ×10000, first decal id, count, -
uniform ivec2 uTrDecalSalt[8];      // group → (imul(salt+1, 0x9e37) ^ 0x5a5a, imul(salt+1, 0x7f4a) ^ 0x3c3c), mixed on the CPU
layout(location = 0) out uvec4 oRec;

int pairAt(int a, int b) { int i = a * 16 + b; return uTrPair4[i >> 2][i & 3]; }
uint famTile(int slot, int c[4]) {
  int up = uTrFam[slot].y;
  int m = (c[0] == up ? 8 : 0) | (c[1] == up ? 4 : 0) | (c[2] == up ? 2 : 0) | (c[3] == up ? 1 : 0);
  return uint(uTrFam[slot].x + m - 1);
}
void main() {
  ivec2 l = ivec2(gl_FragCoord.xy);
  ivec2 T = uTrDeed * 98 + l;
  int cls[4] = int[4](int(texelFetch(uTrV, l, 0).r & 15u), int(texelFetch(uTrV, l + ivec2(1, 0), 0).r & 15u),
                      int(texelFetch(uTrV, l + ivec2(0, 1), 0).r & 15u), int(texelFetch(uTrV, l + ivec2(1, 1), 0).r & 15u));
  int c[4];
  for (int k = 0; k < 4; k++) c[k] = uTrTerr[min(cls[k], 13)];
  bool kingdom = uTrClaim.x >= 0 && l.x >= uTrClaim.x && l.y >= uTrClaim.y && l.x + 1 <= uTrClaim.z && l.y + 1 <= uTrClaim.w;
  int d[4] = int[4](c[0], 99, 99, 99); int n = 1;
  for (int k = 1; k < 4; k++) { bool seen = false; for (int m = 0; m < 4; m++) if (m < n && d[m] == c[k]) seen = true; if (!seen) { d[n] = c[k]; n++; } }
  for (int a = 0; a < 3; a++) for (int b = a + 1; b < 4; b++)
    if (b < n && (uTrLayer[d[b]] < uTrLayer[d[a]] || (uTrLayer[d[b]] == uTrLayer[d[a]] && d[b] < d[a]))) { int s = d[a]; d[a] = d[b]; d[b] = s; }
  bool wet = false;
  for (int k = 0; k < 4; k++) if (k < n && uTrPure[d[k]].z == 1) wet = true;
  uint base = 0u, o1 = 0u, o2 = 0u;
  if (n == 1) {
    ivec4 P = uTrPure[d[0]];
    if (P.z != 1) { ivec2 hk = kingdom ? l - 34 : T; base = uint(P.x) + kitHash(hk.x, hk.y) % uint(max(P.y, 1)); }
  } else {
    int f = pairAt(d[0], d[1]);
    base = f >= 0 ? famTile(f, c) : uint(uTrPure[d[0]].x); // f < 0 only if legalise failed (QC counts it)
    for (int k = 2; k < 4; k++) {
      if (k >= n) break;
      int t = d[k], g = -1;
      for (int m = 0; m < 3; m++) if (m < k && g < 0 && uTrLayer[d[m]] < uTrLayer[t]) g = pairAt(d[m], t);
      if (g < 0) continue;
      uint w = famTile(g, c) | (uTrFam[g].y == t ? 0x4000u : 0u);
      if (o1 == 0u) o1 = w; else o2 = w;
    }
  }
  uint meta = (texelFetch(uTrV, l, 0).r & 128u) != 0u ? 12u : uint(min(cls[0], 15)) & 15u; // G12: RING for LIFE in the clearing
  if (wet) {
    meta |= 1u << 6;
    if (n == 1) meta |= (kitHash(T.x ^ 0x77, T.y ^ 0x99) % uint(max(uTrWaterPhases, 1)) & 3u) << 4;
  }
  if (n == 1 && !wet && !kingdom) {
    int g = uTrDecal[min(cls[0], 13)] - 1;
    if (g >= 0) {
      ivec4 G = uTrDecalGroup[g];
      ivec2 S = uTrDecalSalt[g];
      uint h = kitHash(T.x ^ S.x, T.y ^ S.y);
      // fix iteration 2 #4: decals gather in clusters with bare ground between (never an even sprinkle): the group's
      // density × 2.2·smoothstep(0.35, 0.85, u) of a 9-t value noise u (mean ≈ 1, zero on ~30 % of the ground)
      float u = 0.5 + 0.5 * vnoise(T, 9, uint(S.x) ^ 0x2c9bu);
      int dens = int(float(G.x) * 2.2 * smoothstep(0.35, 0.85, u));
      if (int(h % 10000u) < dens) meta |= uint(G.y + int(((h >> 16u) % 10000u) * uint(G.z) / 10000u) + 1) << 7;
    }
  }
  oRec = uvec4(base, o1, o2, meta);
}
