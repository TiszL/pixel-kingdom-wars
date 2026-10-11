// GROUND lane — water, surf, glints, lava (plan §3.4 step 4, §3.5 water, §7 A1–A5). #include "rm-water"
// after "common". Every effect is quantised to the art px of the layer that calls it (artPx = art px per
// deed: 448 at MAP, 3136 at TRUE, 16 for the chart) so water reads as pixel art, never as a smooth ramp.
// Reduced motion: uViewport.w > 0.5 → static (frame 0, no drift).

export const RM_WATER = `
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
`;
