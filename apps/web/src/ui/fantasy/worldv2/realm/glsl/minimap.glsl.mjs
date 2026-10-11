// Minimap shaders (plan §8.1): a scissored pass in the main GL context (native parity).
// Pass 1 (fullscreen triangle, viewport = the minimap rect): chart8 (no other-realm veil: owner 2026-09-26), the
// main view's box (1 px white + 1 px dark), rounded-corner mask. Pass 2: instanced base points.
// Uniforms: uMini = the minimap's deed rect (x0, y0, x1, y1); uBox = the main view's deed rect;
// uPx = (rect w, rect h in device px, dpr, corner radius in device px); uOrigin = rect origin (device px).

export const MINI_VS = `layout(location = 0) in vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const MINI_FS = `
#include "common"
uniform sampler2D uChart;
uniform sampler2D uFar;                                      // R8 linear: deeds from this realm's deeds × 16
uniform vec3 uSea;                                           // the painting's open sea (its outer ring)
uniform vec4 uMini, uBox, uPx;
uniform vec2 uOrigin;
out vec4 o;
float boxEdge(vec2 px, vec4 r) { // device px distance to the rect outline (r in device px)
  vec2 c = (r.xy + r.zw) * 0.5, h = abs(r.zw - r.xy) * 0.5;
  vec2 d = abs(px - c) - h;
  return abs(max(d.x, d.y));
}
void main() {
  vec2 lp = gl_FragCoord.xy - uOrigin;                       // device px inside the minimap, y up
  vec2 uv = vec2(lp.x / uPx.x, 1.0 - lp.y / uPx.y);
  // rounded corners
  vec2 q = abs(lp - uPx.xy * 0.5) - (uPx.xy * 0.5 - uPx.w);
  if (length(max(q, 0.0)) > uPx.w) discard;
  vec2 p = mix(uMini.xy, uMini.zw, uv);                      // deed space
  vec3 col = uSea;
  if (all(greaterThanEqual(p, vec2(0.0))) && all(lessThan(p, uGrid.xy))) {
    // this realm's own land and sea only (QA GA2 #4): the painting fades into its open sea from 3 to 4 deeds off the
    // realm and within 3 deeds of the painting's frame. Another realm's deeds near it are drawn as the art paints them,
    // not veiled (owner 2026-09-26: "check crownland also have that grey area on the edges, which sunscar had, fix it for
    // all realms"), like the main map at every zoom.
    float fd = texture(uFar, p / uGrid.xy).r * 16.0;
    vec2 e0 = min(p, uGrid.xy - p);
    float keep = (1.0 - smoothstep(3.0, 4.0, fd)) * smoothstep(0.0, 3.0, min(e0.x, e0.y));
    col = mix(uSea, texture(uChart, p / uGrid.xy).rgb, keep);
  }
  // main view box in device px
  vec2 b0 = (uBox.xy - uMini.xy) / (uMini.zw - uMini.xy) * uPx.xy, b1 = (uBox.zw - uMini.xy) / (uMini.zw - uMini.xy) * uPx.xy;
  vec2 lpd = vec2(lp.x, uPx.y - lp.y);                        // y down, like b0/b1
  float e = boxEdge(lpd, vec4(b0, b1));
  if (e < uPx.z * 0.5 + 0.5) col = vec3(1.0);
  else if (e < uPx.z * 1.5 + 0.5) col = mix(col, vec3(0.0), 0.75);
  // frame
  float fr = min(min(lp.x, uPx.x - lp.x), min(lp.y, uPx.y - lp.y));
  if (fr < uPx.z) col = mix(col, vec3(0.35, 0.31, 0.45), 0.9);
  o = vec4(col, 1.0);
}`;

// Base points: one instanced quad per base. aB = (deed x + 0.5, deed y + 0.5, flags, 0).
// flags bit 1 mine · 2 filteredIn (only while a filter is active) · 4 attackable (attack filter on) · 8 selected
// uDot = other bases' dot size, uMine = your base's marker size (device px); uAlpha = (unfiltered dot alpha,
// 1 while a filter is active). Sizes are whole device px so dots stay crisp squares.
export const DOTS_VS = `
#include "common"
layout(location = 0) in vec2 aQ;
layout(location = 1) in vec4 aB;
uniform vec4 uMini, uPx;
uniform float uDot, uMine;
flat out uint vF;
flat out float vSz;
out vec2 vQ;
void main() {
  vec2 uv = (aB.xy - uMini.xy) / (uMini.zw - uMini.xy);
  uint f = uint(aB.z + 0.5);
  float sz = floor(((f & 8u) != 0u ? max(uMine + 4.0 * uPx.z, uDot * 2.6) : (f & 1u) != 0u ? uMine : uDot) + 0.5);
  vec2 px = floor(uv * uPx.xy - sz * 0.5 + 0.5) + aQ * sz;   // top-left on a device-pixel boundary: exactly sz × sz px
  vF = f; vQ = aQ - 0.5; vSz = sz;
  gl_Position = vec4(px.x / uPx.x * 2.0 - 1.0, 1.0 - px.y / uPx.y * 2.0, 0.0, 1.0);
}`;
export const DOTS_FS = `
#include "common"
uniform vec2 uAlpha;
flat in uint vF;
flat in float vSz;
in vec2 vQ;
out vec4 o;
void main() {
  bool mine = (vF & 1u) != 0u, inF = (vF & 2u) != 0u, atk = (vF & 4u) != 0u, sel = (vF & 8u) != 0u;
  float edge = (0.5 - max(abs(vQ.x), abs(vQ.y))) * vSz;       // device px to the dot's edge
  if (sel) {                                                   // pulsing ring, drawn last (on top of everything)
    float r = length(vQ) * 2.0, pulse = 0.5 + 0.5 * sin(float(uClock.y) * 0.006);
    if (r > 1.0 || (r < 0.62 && r > 0.34)) discard;
    o = vec4(mix(vec3(1.0, 0.86, 0.4), vec3(1.0), pulse * 0.4), 1.0); return;
  }
  if (mine) { o = vec4(edge < 1.0 ? vec3(0.12, 0.07, 0.02) : vec3(1.0, 0.82, 0.3), 1.0); return; } // gold, dark outline
  vec3 c = atk ? vec3(1.0, 0.36, 0.3) : vec3(0.95, 0.96, 1.0);
  bool rim = vSz >= 3.0 && edge < 1.0;                         // 1-device-px dark rim once dots are big enough
  float a = uAlpha.y > 0.5 ? (inF ? 0.9 : 0.15) : uAlpha.x;    // filter on: filtered-in solid, the rest dim
  o = vec4(rim ? vec3(0.06, 0.05, 0.1) : c, a);
}`;
