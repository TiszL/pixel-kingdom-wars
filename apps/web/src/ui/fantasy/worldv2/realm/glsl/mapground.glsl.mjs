// GROUND lane — MAP band ground (plan §3.4, §3.7, §6.2, §7). One fullscreen pass:
//  1. layered composite over the resolved lattice (vertices 7 tiles apart): WILD pure (hashed variant), then each
//     non-WILD map terrain present, in layerOrder, where the bilinear of its corner indicators (read at a domain-
//     warped point of the cell's 4×4 block: organic edges across cells) plus a boundary noise exceeds 0.5;
//  2. overlays quantised to MAP art px (448 per deed): sea / lake depth terraces (Bayer at ≥ 1 device px), surf,
//     glints, beach / wet edge, rivers (bank line, flow dashes), Cinderfall lava, tracks, the plot's clearing and
//     its claim tint (frayed, no pad, no wall outline), BASES' impostor yard, deed lines, selection, cloud shadows,
//     the family grade and the chart tone grade (P0 fix pass #1–#3: one fetch of the baked tone texture, luminance relief
//     and a low-chroma tint only, never over a cleared clearing; W1 G5: easing out over the FAR→MAP blend, gone by d 80).
// Magnification: sharp sampling (texel-centre snap in an fwidth window); minification: textureGrad over
// the reducer-built mips. A lattice texel of 0 = not resolved yet → discard (the chart underneath shows).
// Water line (Gate A fix): coast and inland are rmClassAt's own terms (same headland over the G6 rim, same lens,
// continuous twins of its vertex noise), and wherever the deed's TRUE page is resident (d ≥ 600) their SIGN comes
// from TRUE's legalised, despeckled vertex classes (bilinear of the four corner vertices of the tile, > 0.5 = wet),
// so across the MAP→TRUE fade the coast, lakes, rivers and moats resolve in place. Depth colours keep the
// continuous values.
// Units: 0 atlas · 1 masks · 2 lattice · 3 fieldsA · 4 fieldsBC · 5 line fields · 7 tone · 8 base state · 9 plots ·
// 10 TRUE records · 11 page table · 12 far field.
// P0 (RM-GPU-1, the real-GPU hang): every loop has a compile-time bound and no per-pixel work walks a list — the river,
// track and bridge fields are sampled from GROUND's baked pages; the lattice block, the plot neighbourhood, the coast/lake
// bilinear and the river sample are each fetched once per pixel (groundcost.js counts the worst case per path).
// P0 fix pass #1 (rm-map is the heaviest pipeline build of the MAP band change; SwiftShader attribution: value noise
// ≈ 2 s of ≈ 5.5 s, the water overlay ≈ 2 s, the lattice block ≈ 1 s): every group of value noises of one kind is a
// literal loop (one inlined copy, the same sums in the same order), the lava branch compiles only for the lava realm
// (RM_LAVA), and the painting grade is the baked tone texture (one fetch) instead of a per-pixel chart16 page lookup.
// (Straight-line row vectors in place of the lattice block's local arrays measured SLOWER — every inlined fetch and
// slot rule is compiled 16 times; the block keeps its compact loops.)

export const MAP_VS = `
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const MAP_FS = `
#include "common"
#include "rm-fields"
#include "rm-shore"
#include "rm-water"
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
`;
