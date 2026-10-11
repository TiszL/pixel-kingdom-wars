// GROUND lane — TRUE band ground (plan §3.5, §7 A2/A4): the realm kit's own ground, tile for tile as in game.
// Per fragment: the deed's resident record page → {base, overlay 1, overlay 2, meta}; the water loop under
// shore/open-water tiles (the pack's frames, hashed phases × its phaseStep); the base tile (A/B arrays); overlays pasted by the
// ground mask exactly like the kit builder (the paste class plus a 1-px rim, opaque texels only); decals;
// deep-sea tint and surf by the coast SDF, art-px quantised; cloud shadows. (RM-24, fix pass: no selection outline at TRUE: at
// d 1600 a deed is ~1,600 px, so one stray gold edge showed under the trees far from the kingdom. MAP's deed outline fades out
// with the MAP layer across the hand-over; at TRUE BASES' selection ring marks the kingdom.)
// Kit art above 1× only through sharp sampling; below 1× textureGrad over box mips.
// Units: 0 ground A · 1 ground B · 2 decals · 3 masks (4 per RGBA layer) · 4 records · 5 decal boxes · 6 page table ·
// 7 base state (rm-fields) · 8 fieldsA (rm-fields) · 9 line fields (rm-fields, unused here).
// Fix iteration 2 #4 ("polka-dot decals in a lattice"): a decal no longer sits at its tile's origin — it is shifted by a
// per-tile hash, in whole art px, anywhere its own transparent margin allows (uTgDecalBox), so it never leaves its tile
// (no neighbour lookups, never onto water, road or a kingdom) and rows and columns of decals do not line up.

export const TRUE_VS = `
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const TRUE_FS = `
#include "common"
#include "rm-fields"
#include "rm-water"
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
`;
