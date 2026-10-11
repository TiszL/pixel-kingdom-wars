// GROUND lane — resolve passes (plan §3.2 steps 5–6, §3.4 step 1, §3.5): fragment shaders writing integer
// targets. A region is resolved raw on an apron of 2 vertices, then legalised twice (Jacobi, 8-neighbour),
// each pass shrinking the apron by one — so a tiled resolve equals one big resolve (classify.test pins the
// JS twin). Plain strings for the native port.

/** Fullscreen triangle (core.fullscreen(): attribute 0 = clip xy). */
export const RESOLVE_VS = `
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/**
 * Raw classes: output texel (i, j) ↔ tile vertex origin + (ij − apron)·step. Needs rm-fields, rm-classify.
 * Texel = GROUND class (bits 0–3) | flags << 4: 1 near water (coast or inland < 14 t), 4 near a plot (< 30 t), a land
 * bridge, near water within an island's reach + 5 t of a plot (P0 fix pass #4: the shallows halo is drawn to its end, never
 * cut at a cell edge) or near a track (< 10 t; W1 G2: flag 2 now holds the PURE pass's purity bit, so the page stays R8UI)
 * | 128 the plot's clearing (G12: RING for LIFE, the ground draws the class). Cells whose four corners carry no flag skip those per-pixel overlays at MAP (a pixel
 * lies ≤ 9.9 t from every corner of its 7-t cell; the SDFs change ≤ 1.3 t per tile with their noise).
 */
export const RAW_FS = `
#include "common"
#include "rm-fields"
#include "rm-classify"
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
`;

/**
 * One despeckle pass (G7, TRUE pages; classify.js despeckle): target texel (i, j) reads source texel
 * (i, j) + 1 and its 4 neighbours (the source is 2 texels larger). Fill (uDsMode bit 1): a dry vertex with water
 * on both sides along x or y turns wet. Erode (bit 2): a water vertex with land on both sides along x or y
 * turns dry. The new class is the most frequent neighbour class of that wetness, first in the order L, R, U, D.
 * TURF/RING (11, 12) never flip; a water vertex touching them never erodes. Flag bits are kept.
 */
export const DESPECKLE_FS = `
uniform highp usampler2D uDsSrc;
uniform int uDsMode;
layout(location = 0) out uint oCls;
bool dsWet(uint c) { return c <= 2u; }
bool dsPlot(uint c) { return c == 11u || c == 12u; }
uint dsMajority(uint n[4], bool wet) {
  uint best = 99u; int bc = 0;
  for (int k = 0; k < 4; k++) {
    if (dsWet(n[k]) != wet) continue;
    int c = 0; for (int m = 0; m < 4; m++) if (n[m] == n[k]) c++;
    if (c > bc) { bc = c; best = n[k]; }
  }
  return best;
}
void main() {
  ivec2 s = ivec2(gl_FragCoord.xy) + 1;
  uint raw = texelFetch(uDsSrc, s, 0).r, c = raw & 15u;
  oCls = raw;
  if (dsPlot(c) || c > 13u) return;                                 // plots never flip
  uint r4[4] = uint[4](texelFetch(uDsSrc, s + ivec2(-1, 0), 0).r, texelFetch(uDsSrc, s + ivec2(1, 0), 0).r,
                       texelFetch(uDsSrc, s + ivec2(0, -1), 0).r, texelFetch(uDsSrc, s + ivec2(0, 1), 0).r);
  uint n[4] = uint[4](r4[0] & 15u, r4[1] & 15u, r4[2] & 15u, r4[3] & 15u);
  bool wx = dsWet(n[0]), wx1 = dsWet(n[1]), wy = dsWet(n[2]), wy1 = dsWet(n[3]);
  if ((raw & 128u) != 0u) { // G12: the plot's clearing only fills (a 1-vertex spit into water turns wet, losing its flag)
    if (!dsWet(c) && (uDsMode & 1) != 0 && ((wx && wx1) || (wy && wy1))) oCls = (raw & 0x70u) | dsMajority(n, true);
    return;
  }
  uint to = 99u;
  if (!dsWet(c)) {
    if ((uDsMode & 1) != 0 && ((wx && wx1) || (wy && wy1))) to = dsMajority(n, true);
    // mode 8 (MAP lattice, fix round 1): a 1-vertex-wide run of an upper terrain (not WILD, not ROAD) takes the class
    // across it — the pair's class when they agree, else WILD, else GROUND2, else the first (classify.js despeckle)
    else if ((uDsMode & 8) != 0 && c != 10u && c != 4u && ((n[0] != c && n[1] != c) || (n[2] != c && n[3] != c))) {
      int a = n[2] != c && n[3] != c ? 2 : 0;
      uint A = n[a], B = n[a + 1];
      bool oa = !dsWet(A) && !dsPlot(A) && (r4[a] & 128u) == 0u, ob = !dsWet(B) && !dsPlot(B) && (r4[a + 1] & 128u) == 0u;
      uint t = oa && ob ? ((A == B || A == 4u || (A == 5u && B != 4u)) ? A : B) : oa ? A : ob ? B : 99u;
      if (t != 99u && t != c) to = t;
    }
    // mode 4 (MAP lattice, GA2 speckle): an isolated dry vertex (no 4-neighbour of its class) takes the dry majority
    else if ((uDsMode & 4) != 0 && n[0] != c && n[1] != c && n[2] != c && n[3] != c) { uint m = dsMajority(n, false); if (m != 99u && !dsPlot(m)) to = m; }
  }
  else if ((uDsMode & 2) != 0 && ((!wx && !wx1) || (!wy && !wy1)) && !dsPlot(n[0]) && !dsPlot(n[1]) && !dsPlot(n[2]) && !dsPlot(n[3])) to = dsMajority(n, false);
  if (to != 99u) oCls = (raw & 0xF0u) | to;
}
`;

/**
 * One legalise pass. Target texel (i, j) reads source texel (i, j) + uLgShift and its 8 neighbours.
 * uLgTerr[c]: band terrain index of class c (0…15); uLgLegal[t]: bitmask of terrains legal next to t;
 * uLgFallback[c]: class to collapse to (−1 none); uLgRank[c]: §3.2 rule order (0 = highest priority).
 */
export const LEGALISE_FS = `
uniform highp usampler2D uLgSrc;
uniform ivec2 uLgShift;
uniform int uLgTerr[14];
uniform int uLgLegal[16];
uniform int uLgFallback[14];
uniform int uLgRank[14];
uniform int uLgPlusOne;             // 1 on the pass that writes a lattice page (class + 1; 0 = unresolved)
layout(location = 0) out uint oCls;
bool legalPair(int a, int b) { return a == b || ((uLgLegal[a] >> b) & 1) != 0; }
// 0: a collapses, 1: b collapses, −1: neither can (JS classify.victimOf)
int victim(int ca, int cb) {
  bool first = uLgRank[ca] <= uLgRank[cb];
  int fa = uLgFallback[ca], fb = uLgFallback[cb];
  if (first && fa >= 0) return 0;
  if (!first && fb >= 0) return 1;
  if (fa >= 0) return 0;
  if (fb >= 0) return 1;
  return -1;
}
void main() {
  ivec2 s = ivec2(gl_FragCoord.xy) + uLgShift;
  ivec2 sz = textureSize(uLgSrc, 0);
  uint raw = texelFetch(uLgSrc, s, 0).r, fl = raw & 0xF0u;
  int c = int(raw & 15u);
  if (c > 13) { oCls = raw; return; }
  uint plus = uint(uLgPlusOne);
  int t = uLgTerr[c];
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    ivec2 q = s + ivec2(i, j);
    if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
    int n = int(texelFetch(uLgSrc, q, 0).r & 15u);
    if (n > 13 || n == c || legalPair(t, uLgTerr[n])) continue;
    if (victim(c, n) == 0) { oCls = fl | (uint(uLgFallback[c]) + plus); return; }
  }
  oCls = fl | (uint(c) + plus);
}
`;

/**
 * MAP lattice purity (W1 follow-up G2, RM-GPU-1): the last pass of a lattice sub-tile, into the R8UI lattice page. Target
 * texel (i, j) reads source texel (i, j) + uPuShift (the final legalised classes, class + 1) and its 8 neighbours, and writes
 * the texel with bit 5 (flag 2) set when all nine vertices draw the same MAP slot (uPuSlot: class → slot, ground.js
 * mapTables). (RAW folds its old flag 2, a track within 10 t, into flag 4: the page stays R8UI, no memory grows.)
 * rm-map reads it in place of the 4×4 block of 16 lattice texels it fetched per pixel: a corner's corner-Wang colour needs
 * its 3×3 to be one slot, and a cell whose four corners are pure and of one slot lies in a one-slot 4×4 block (no warp).
 */
export const PURE_FS = `
uniform highp usampler2D uPuSrc;
uniform ivec2 uPuShift;
uniform int uPuSlot[14];
layout(location = 0) out uint oCls;
void main() {
  ivec2 s = ivec2(gl_FragCoord.xy) + uPuShift;
  uint raw = texelFetch(uPuSrc, s, 0).r, c = raw & 15u;
  oCls = raw;
  if (c == 0u || c > 14u) return;
  int sl = uPuSlot[int(c) - 1];
  for (int k = 0; k < 9; k++) {
    if (k == 4) continue;
    uint n = texelFetch(uPuSrc, s + ivec2(k % 3 - 1, k / 3 - 1), 0).r & 15u;
    if (n == 0u || n > 14u || uPuSlot[int(n) - 1] != sl) return;
  }
  oCls = raw | 32u;
}
`;

/**
 * TRUE record pass (plan §3.5): target 98×98 RGBA16UI, texel (i, j) = deed-local tile (i, j). Reads the
 * legalised vertex classes (99×99: the deed's vertices 0…98) and reproduces the kit builder's rules:
 *   one terrain → pure variant kitHash % n (kingdom tiles hash deed-local − 34), open water → the loop only;
 *   two → pairFamily at the mask of the family's OWN upper; ≥ 3 → the lowest two by layer via their family,
 *   each higher terrain pasted from its family with the lowest-layer terrain it pairs with (≤ 2 overlays).
 * Layer words: bits 0–13 = layer index (0 = none; ground arrays A/B hold layers 1…), bit 14 = paste the
 * family's UPPER texels (else its lower texels; overlays only), bit 15 = array B (index − 256 there).
 * A family slot stores masks 1…14 consecutively (masks 0/15 never occur on a mixed tile; PACK dedups them).
 * meta = class(4) | waterPhase(2) << 4 | waterUnder << 6 | decal(9) << 7 (decal 0 = none, else id + 1). The meta class
 * is what LIFE/BASES see (RING across the plot's clearing, G12); the layer words draw the ground class.
 */
export const RECORD_FS = `
#include "common"
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
`;
