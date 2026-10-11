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

uniform sampler2D uChart8;                 // 8 px/deed, mipped, linear
uniform highp sampler2DArray uChart16;     // 512² pages of the 16 px/deed chart, linear, no mips
uniform sampler2D uFieldsA;                // coast SDF for glints (nearest)
uniform ivec4 uC16Page[16];                // page index → layer + 1 (0 = not resident), 4 per ivec4
uniform ivec4 uC16Geo;                     // pages x, pages y, page px, on (0/1)
uniform vec3 uSeaFar;                      // the painting's open-sea colour (outside the grid, the frame and foreign fade)
uniform sampler2D uFar;                    // R8 linear: deeds from this realm's deeds × 16 (GA2-04)
uniform float uAlpha;
uniform vec4 uRhAt;                        // W1 G1, ground.rehearse only (0 otherwise): z > 0.5 → this fragment is deed point xy
out vec4 o;

// 1 for painted sea (blue clearly above red and green), 0 for land, snow or sand
float seaLike(vec3 c) { return smoothstep(0.02, 0.08, c.b - max(c.r, c.g)); }
int c16Layer(ivec2 pg) { int i = pg.y * uC16Geo.x + pg.x; if (i < 0 || i >= 64) return 0; return uC16Page[i >> 2][i & 3]; }
float coastAt(vec2 p) { // tiles; fieldsA texel centre at (i + 0.5)/8 deed (nearest here: glints only)
  ivec2 t = clamp(ivec2(floor(p * 8.0)), ivec2(0), textureSize(uFieldsA, 0) - 1);
  return (texelFetch(uFieldsA, t, 0).r * 255.0 - 128.0) * 2.0;
}
// GA2-04 (no chart frame): 1 = keep the painting, 0 = the open sea. Land painted beyond the foreign cut (rmForeignCut: a
// noisy 1.5…6.5 deeds from this realm) fades out; painted sea keeps 15 % of its texture only near the cut, so no ghost of a
// neighbour's land shows under the open sea (fix round 1 #9); within 3 deeds of the frame everything eases into the open
// sea. MAP applies the same rule and ground.js foreignSea makes the classes sea beyond the same cut.
float rmKeep(vec2 p, vec2 g, float sea) {
  float fd = texture(uFar, p / g).r * 16.0;
  vec2 e0 = min(p, g - p); if (fd <= 0.5 && min(e0.x, e0.y) >= 4.5) return 1.0; // most of the realm: no noise needed
  float cut = rmForeignCut(p), n = rmNoiseF(p * 4.0, 7, 0x4f1du) * 0.9 + rmNoiseF(p * 4.0, 3, 0x2a77u) * 0.35;
  float fw = smoothstep(cut - 0.45, cut + 0.45, fd) * mix(1.0, 0.85, sea * (1.0 - smoothstep(cut, cut + 1.0, fd))); // a coast, not a ghost
  float fe = 1.0 - smoothstep(0.0, 3.0, min(e0.x, e0.y) + n * 0.8);
  return (1.0 - fw) * (1.0 - fe);
}
void main() {
  vec2 p = uRhAt.z > 0.5 ? uRhAt.xy : fragDeed(), g = uGrid.xy;
  if (any(lessThan(p, vec2(0.0))) || any(greaterThanEqual(p, g))) { o = vec4(uSeaFar * cloudShade(p, 16.0), uAlpha); return; }
  vec3 col = texture(uChart8, p / g).rgb;
  if (uC16Geo.w > 0) {
    vec2 px = p * 16.0; ivec2 pg = ivec2(floor(px / float(uC16Geo.z)));
    int L = c16Layer(pg);
    if (L > 0) {
      vec2 lp = px - vec2(pg) * float(uC16Geo.z);
      col = textureLod(uChart16, vec3(lp / float(uC16Geo.z), float(L - 1)), 0.0).rgb;
    }
  }
  // sea glints on the painted sea (A1), per chart px
  float coast = coastAt(p);
  if (coast < -6.0 && uViewport.z > 6.0) col = mix(col, vec3(0.92, 0.97, 1.0), 0.55 * rmGlint(ivec2(floor(p * 16.0)), 0.004, uViewport.z / 16.0));
  // no deed lines at FAR (fix round 1 #11: the grid read as graph paper over the painting; MAP shows faint ones from d 150).
  // No other-realm veil either (owner 2026-09-26, Seeker, Crownlands at the FAR overview: "check crownland also have that
  // grey area on the edges, which sunscar had, fix it for all realms"): deeds the catalogue gives to another realm are
  // drawn as the realm art paints them, like MAP and TRUE. Only the soft foreign fade (rmKeep) eases far land into the sea.
  col = mix(uSeaFar, col, rmKeep(p, g, seaLike(col)));
  col *= cloudShade(p, 16.0);
  o = vec4(col, uAlpha);
}
