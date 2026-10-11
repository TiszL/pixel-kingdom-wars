// Realm-map SHIELD DOME (plan §6.5, A16; D-164.5 "magical beautiful transparent shields with cool
// animations"). GLSL ES 3.00, plain strings. BASES lane.
//
// A 3/4-view hemisphere over the claim: ground ellipse rx = S/2 + 2 t, ry = 0.55·rx; crown 0.8·rx above
// the centre. Drawn twice per shielded base:
//   back  (before sprites; they cover it): interior tint, the far wall's dim rune lattice, the ground
//         contact ring — so keeps and walls read as standing INSIDE the bubble;
//   front (after sprites, depth = the claim's south edge, so trees south of it still occlude it):
//         iridescent Fresnel rim with a 1-art-px bright edge, hex/rune lattice scrolling upward, the
//         diagonal shimmer sweep, rising motes and a light veil over what is inside.
// LOD (uDomeLod): 0 ring look (tint + rim + contact ring), 1 dome silhouette (+ lattice, no motes),
// 2 full dome (TRUE; + sweep + motes), pixel-quantised to art-px centres so it reads as pixel art.
// A selection pulse on the ground (uMode 1) shares the program: an art-px ellipse ring at the keep seat.
//
// Instance: iA = cx, cy (deed, the claim centre), rx (tiles), seed (0..1)
//           iB = flags (1 yours, 2 selected), footY (deed: the claim's south edge), ringRx (tiles), -
export const SHIELD_VS = `
#include "common"
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 iA;
layout(location = 2) in vec4 iB;
uniform float uMode;   // 0 dome, 1 selection pulse
out vec2 vP;           // tiles from the centre, y UP
flat out vec4 vA;
flat out vec4 vB;
void main() {
  float rx = iA.z, k = uCam.z / 98.0;
  vec2 lo = uMode > 0.5 ? vec2(-rx * 1.25, -rx * 0.75) : vec2(-rx - 1.5, -0.55 * rx - 1.5);
  vec2 hi = uMode > 0.5 ? vec2(rx * 1.25, rx * 0.75) : vec2(rx + 1.5, 0.8 * rx + 1.5);
  vP = mix(lo, hi, aCorner);
  vec2 css = deedToCss(iA.xy) + vec2(vP.x, -vP.y) * k;
  float foot = deedToCss(vec2(iA.x, iB.y)).y;
  gl_Position = cssToClip(css, spriteDepth(foot));
  vA = iA; vB = iB;
}`;

export const SHIELD_FS = `
#include "common"
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
}`;
