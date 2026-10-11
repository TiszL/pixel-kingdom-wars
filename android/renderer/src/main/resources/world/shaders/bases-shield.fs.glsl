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

uniform float uPass;    // 0 back, 1 front
uniform float uDomeLod;     // 0 ring look, 1 silhouette, 2 full
uniform float uArtPx;   // art px per deed used for quantisation (3136 TRUE, 448 MAP)
uniform float uMode;    // 0 dome, 1 selection pulse
uniform vec3 uAccent;   // the realm's accent (globe HUD: accent is light): a breath of it in the aura and rune ring
in vec2 vP;
flat in vec4 vA;
flat in vec4 vB;
out vec4 frag;

const vec3 CYAN = vec3(0.498, 0.890, 1.0);   // #7fe3ff
const vec3 GOLD = vec3(1.0, 0.839, 0.420);   // #ffd66b
const float PI = 3.14159265;

// distance to the nearest hex-cell edge (0 on the edge, 0.5 at the centre) and the cell id
vec3 hexCell(vec2 q) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(q, s) - s * 0.5, b = mod(q - s * 0.5, s) - s * 0.5;
  vec2 h = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = floor(q - h + 0.5);
  vec2 ah = abs(h);
  float d = max(dot(ah, s * 0.5), ah.x);
  return vec3(0.5 - d, id);
}
// offset from the nearest hex-cell centre (cell units), the same lattice as hexCell
vec2 hexLocal(vec2 q) {
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(q, s) - s * 0.5, b = mod(q - s * 0.5, s) - s * 0.5;
  return dot(a, a) < dot(b, b) ? a : b;
}
// longitude / latitude (÷π) of the dome surface over point p (tiles, y up)
vec2 domeUV(vec2 p, float rx, float hC, float ryG) {
  vec2 e = vec2(p.x / rx, p.y >= 0.0 ? p.y / hC : p.y / ryG);
  float nz = sqrt(max(0.0, 1.0 - dot(e, e)));
  return vec2(atan(e.x, nz) / PI, asin(clamp(e.y, -1.0, 1.0)) / PI);
}
// iridescent sheen: a cool three-stop ramp cyan → violet → mint (never the warm half of the spectrum, which
// turns sickly green over sand and snow), by surface angle and time
vec3 iris(float t, vec3 base) {
  const vec3 VIOLET = vec3(0.66, 0.55, 1.0), MINT = vec3(0.55, 1.0, 0.86);
  float h = fract(t) * 3.0;
  return h < 1.0 ? mix(base, VIOLET, h) : h < 2.0 ? mix(VIOLET, MINT, h - 1.0) : mix(MINT, base, h - 2.0);
}

void main() {
  bool rm = uViewport.w > 0.5;
  float tA = rm ? 0.0 : float(uClock.x) * 0.001;   // animation clock (s), frozen in the idle freeze
  float tP = rm ? 0.0 : float(uClock.y) * 0.001;   // pulse clock (s), keeps running for selection/shield pulses
  float rx = vA.z, apt = uArtPx / 98.0;             // art px per tile
  vec2 p = vP;
  if (uArtPx > 0.0) p = (floor(p * apt) + 0.5) / apt;   // pixel-art: every fragment of an art px agrees
  float px = 1.0 / apt;                                   // one art px in tiles
  float dev = 98.0 / (uCam.z * uCam.w);                   // one device px in tiles
  float line = max(px, dev);                              // strokes never thinner than a device pixel
  bool mine = mod(vB.x, 2.0) > 0.5, sel = mod(floor(vB.x / 2.0), 2.0) > 0.5;
  vec3 base = CYAN, accent = mine ? mix(CYAN, GOLD, 0.7) : vec3(0.85, 0.98, 1.0);   // yours: gold edge and runes

  if (uMode > 0.5) {                                      // selection pulse: art-px ellipse ring at the keep seat
    float R = vB.z, ph = rm ? 0.0 : fract(tP / 2.0);
    float e = length(vec2(p.x / R, p.y / (R * 0.55)));
    float w = max(1.5 * px, 1.5 * dev) / (R * 0.55);
    float ring0 = step(abs(e - 1.0), w), ring1 = step(abs(e - (1.0 + ph * 0.35)), w) * (1.0 - ph);
    float a = max(ring0 * 0.85, ring1 * 0.7);
    if (a < 0.01) discard;
    frag = vec4(GOLD * a, a);
    return;
  }

  float ryG = 0.55 * rx, hC = 0.8 * rx;
  vec2 e = vec2(p.x / rx, p.y >= 0.0 ? p.y / hC : p.y / ryG);
  float r2 = dot(e, e);
  float g = length(vec2(p.x / rx, p.y / ryG));            // ground-ellipse radius (1 on the contact line)
  float contactW = max(1.6 * px, 1.5 * dev) / ryG;
  float contact = 1.0 - smoothstep(0.0, contactW, abs(g - 1.0));
  float pulse = rm ? 0.75 : 0.62 + 0.38 * sin(tP * 2.0944);   // 3 s
  float inside = step(r2, 1.0);
  float rr = sqrt(r2), auraW = max(3.0 * px, 3.0 * dev) / max(1.0, hC);
  float aura = (uDomeLod > 0.5 && rr > 1.0) ? floor((1.0 - clamp((rr - 1.0) / auraW, 0.0, 1.0)) * 4.0) / 4.0 : 0.0;  // stepped: pixel art
  if (inside < 0.5 && contact < 0.01 && aura < 0.01) discard;
  float breath = rm ? 1.0 : 0.86 + 0.14 * sin(tP * 2.0944);   // 3 s soft pulse

  float nz = sqrt(max(0.0, 1.0 - r2));
  float fres = pow(1.0 - nz, 2.2);
  float edgeW = max(1.2 * px, 1.2 * dev) / max(1.0, hC);
  bool edge = inside > 0.5 && sqrt(r2) > 1.0 - edgeW * 1.3;
  vec3 col = vec3(0.0); float a = 0.0;

  // ---- ring look (MAP marker mode): everything under the sprites, so the keep marker stays readable ----
  if (uDomeLod < 0.5) {
    if (uPass > 0.5) discard;
    if (inside > 0.5) { a = 0.12; col = base * 0.12; float ra = fres * 0.7; col += base * ra; a += ra * 0.7; }
    if (edge) {                                           // rim light: bright where the house light (upper left) meets the glass
      float lit = 0.5 + 0.5 * dot(normalize(e + vec2(1e-5)), normalize(vec2(-0.62, 0.78)));
      col += mix(base, vec3(1.0), 0.2 + 0.45 * lit) * (0.5 + 0.35 * lit); a += 0.3 + 0.25 * lit;
    }
    float ca = contact * 0.45 * pulse; col += base * ca; a = max(a, ca * 0.5);
    if (a < 0.004) discard;
    frag = vec4(col, min(a, 0.9));
    return;
  }
  // ---- back shell (under the sprites) ----
  if (uPass < 0.5) {
    vec3 auraC = mix(base, uAccent, 0.35);
    if (aura > 0.0) { float aa = aura * 0.3 * breath; col += auraC * aa; a += aa * 0.5; }   // the aura around the bubble
    // a ring of runes on the ground just inside the contact line, turning slowly (a magic circle under the dome)
    // fix iteration 1 (QA: "white rectangular blocks"): 1-art-px strokes that follow the ellipse — two guide lines,
    // radial ticks, short arcs and dots — never filled glyph blocks
    float rg0 = 0.86, rg1 = 0.95, rgm = (rg0 + rg1) * 0.5;
    float wg = max(0.6 * px, 0.6 * dev) / ryG;               // half an art px across the ring, in g units
    if (g > rg0 - 2.0 * wg && g < rg1 + 2.0 * wg) {
      float ang = atan(p.y / ryG, p.x / rx) / (2.0 * PI) + 0.5 + (rm ? 0.0 : tA * 0.012);
      float cells = floor(18.0 + rx * 0.6), ci = floor(ang * cells), cu = fract(ang * cells);
      float wu = max(0.6 * px, 0.6 * dev) / (2.0 * PI * 0.78 * rx) * cells;   // half an art px along the ring, in cells
      uint bits = pcg2d(uvec2(uint(ci) + 311u, uint(vA.w * 65535.0))).x;
      float inBand = step(rg0, g) * step(g, rg1);
      float guide = max(step(abs(g - rg0), wg), step(abs(g - rg1), wg));
      float tick = float(bits & 1u) * step(abs(cu - 0.5), wu) * inBand;
      float arc = float((bits >> 1u) & 1u) * step(abs(g - rgm), wg) * step(0.22, cu) * step(cu, 0.78);
      float dotm = float((bits >> 2u) & 1u) * step(abs(cu - 0.2), wu * 1.5) * step(abs(g - rgm), wg * 1.5);
      float on = max(guide * 0.55, max(tick, max(arc, dotm)));
      float tw = rm ? 0.7 : 0.55 + 0.45 * sin(tP * 1.3 + float(ci) * 0.9);
      float ra = on * 0.34 * tw * (uDomeLod > 1.5 ? 1.0 : 0.7);
      col += mix(auraC, vec3(1.0), 0.25) * ra; a += ra * 0.5;
    }
    if (inside > 0.5) { a = max(a, 0.08); col += base * 0.08; }
    if (g < 1.0) { float gl = smoothstep(0.35, 1.0, g) * 0.10 * breath; col += base * gl; a += gl * 0.4; }   // light pooled on the ground
    if (uDomeLod > 0.5 && inside > 0.5) {
      // the far wall's lattice seen through the bubble: mirrored longitude, dimmer, slower
      vec3 nn = vec3(-e.x, e.y, -nz);
      vec2 uv = vec2(atan(nn.x, -nn.z) / PI, asin(clamp(nn.y, -1.0, 1.0)) / PI);
      vec3 hx = hexCell(uv * vec2(9.0, 7.0) + vec2(0.0, tA * 0.05 * 7.0));
      float line = 1.0 - smoothstep(0.0, 0.06, hx.x);
      a += line * 0.07; col += base * line * 0.07;
    }
    float ca = contact * 0.35 * pulse;                    // ground contact ring (additive)
    col += base * ca * 1.2;
    a = max(a, ca * 0.4);
    if (a < 0.004) discard;
    frag = vec4(col, a);
    return;
  }

  // ---- front shell (over the sprites) ----
  if (inside < 0.5) discard;
  float lon = atan(e.x, nz), lat = asin(clamp(e.y, -1.0, 1.0));
  float spin = sel && !rm ? tA * 0.12 : 0.0;
  vec3 sheen = iris(lon * 0.16 + lat * 0.11 + tA * 0.04, base);
  float rimA = pow(fres, 1.5) * 0.6 * breath * (sel ? 1.5 : 1.0);
  col += sheen * rimA; a += rimA * 0.9;                    // a cyan tint (not additive light), so it reads blue on sand and snow
  a += 0.05; col += vec3(0.30, 0.62, 0.85) * 0.05;          // a faint blue veil over what stands inside
  if (edge) {
    // the 1-art-px rim light (round 2 fix 2: was one flat near-white line): the lit upper-left arc is bright and
    // takes the accent (gold on yours), the far side falls back to the glass cyan, and a short glint runs round the
    // rim every ~8 s (stepped, pixel art) — a live magical edge, not an outline
    float lit = 0.5 + 0.5 * dot(normalize(e + vec2(1e-5)), normalize(vec2(-0.62, 0.78)));
    float run = rm ? 0.0 : floor(pow(max(0.0, cos(atan(e.y, e.x) - tP * 0.8 - vA.w * 6.2832)), 40.0) * 3.0) / 3.0;
    col += mix(base, accent, 0.3 + 0.7 * lit) * (0.5 + 0.45 * lit) + vec3(1.0) * run * 0.45;
    a += 0.38 + 0.32 * lit + run * 0.2;
  }
  // a band of light rising from the ground to the crown every 3.5 s (the shield "breathing" energy upward)
  float lat01 = clamp(e.y, 0.0, 1.0), wph = rm ? 0.4 : fract(tP / 3.5);
  float wave = exp(-pow((lat01 - wph) / 0.07, 2.0)) * (1.0 - wph * 0.6) * step(0.0, e.y);
  float wa = floor(wave * 3.0) / 3.0 * 0.15;                 // stepped: pixel art
  col += mix(base, vec3(1.0), 0.5) * wa * (0.4 + fres); a += wa * 0.5;
  // glass highlight (fix iteration 1: was a filled white blob): two thin arcs just inside the outline on the upper
  // left, where the house light comes from, concentric with the dome so they read as light on curved glass
  float up = dot(normalize(e + vec2(1e-5)), normalize(vec2(-0.62, 0.78)));
  float wr = max(0.65 * px, 0.6 * dev) / max(1.0, hC);
  float hl = step(abs(rr - 0.86), wr) * smoothstep(0.78, 0.95, up) * 0.34 + step(abs(rr - 0.78), wr * 0.8) * smoothstep(0.92, 0.985, up) * 0.2;
  col += vec3(0.9, 0.97, 1.0) * hl; a += hl * 0.5;
  if (uDomeLod > 0.5) {
    vec2 uv = vec2(lon / PI + spin, lat / PI);
    vec3 hx = hexCell(uv * vec2(9.0, 7.0) + vec2(0.0, -tA * 0.05 * 7.0));   // scrolls upward, 0.05 cycles/s
    float line = 1.0 - smoothstep(0.0, 0.055, hx.x);
    float cellH = u01(pcg2d(uvec2(ivec2(hx.yz) + 4096) ^ uvec2(uint(vA.w * 65535.0))).x);
    float rune = 0.0;
    if (cellH > 0.86) {  // a few cells carry a rune sigil: broken rings drawn 1 art px thick ON the glass (so they curve
                         // with the dome), riding the lattice and twinkling — never the old filled 3×3 glyph blocks
      vec2 q = uv * vec2(9.0, 7.0) + vec2(0.0, -tA * 0.05 * 7.0), hl2 = hexLocal(q);
      vec2 du = (domeUV(p + vec2(px, 0.0), rx, hC, ryG) - domeUV(p, rx, hC, ryG)) * vec2(9.0, 7.0);
      vec2 dv = (domeUV(p + vec2(0.0, px), rx, hC, ryG) - domeUV(p, rx, hC, ryG)) * vec2(9.0, 7.0);
      float w = max(0.55 * max(length(du), length(dv)), 0.008), rq = length(hl2);   // half an art px, in cell units
      uint bits = pcg2d(uvec2(ivec2(hx.yz) + 77)).y;
      int sec = int(floor((atan(hl2.y, hl2.x) / (2.0 * PI) + 0.5) * 6.0)) % 6;
      float outer = float((bits >> uint(sec)) & 1u) * step(abs(rq - 0.3), w);
      float inner = float((bits >> uint(6 + sec % 3)) & 1u) * step(abs(rq - 0.16), w);
      float bar = float((bits >> 9u) & 1u) * step(abs(hl2.x), w) * step(rq, 0.3);
      rune = max(outer, max(inner * 0.8, bar * 0.7)) * (rm ? 0.6 : 0.5 + 0.5 * sin(tA * 2.3 + cellH * 40.0));
    }
    float lt = line * (0.10 + 0.32 * fres) * breath, ru = rune * 0.32 * breath;   // lattice brightest toward the rim; runes glow
    col += mix(base, vec3(1.0), 0.25) * lt + mix(base, accent, 0.6) * ru; a += lt * 0.85 + ru * 0.5;
  }
  if (uDomeLod > 1.5 && !rm) {
    float band = dot(vec2(e.x, e.y), normalize(vec2(1.0, 0.65))) - (fract(tA / 4.0) * 3.2 - 1.6);   // sweep every 4 s
    float sw = exp(-pow(band / 0.11, 2.0)) * 0.25;
    col += mix(vec3(1.0), base, 0.4) * sw; a += sw * 0.6;
    for (int i = 0; i < 8; i++) {                          // motes: 1–2 art px, rising and hash-seeded
      uvec2 hh = pcg2d(uvec2(uint(i) * 97u + 11u, uint(vA.w * 65535.0)));
      float per = 3.0 + u01(hh.x) * 3.0, ph = fract(tA / per + u01(hh.y));
      vec2 m = vec2((u01(hh.x ^ 0x5bd1e995u) - 0.5) * 1.5 * rx, -ryG * 0.4 + ph * (hC * 0.95));
      float sz = (i < 3 ? 2.0 : 1.0) * px;
      vec2 dm = abs(p - m);
      if (max(dm.x, dm.y) < sz * 0.5 + 1e-4) { float ma = (1.0 - ph) * 0.85; col += vec3(1.0) * ma; a += ma * 0.6; }
    }
  }
  a = min(a, 0.92);
  if (a < 0.004) discard;
  frag = vec4(col, a);
}