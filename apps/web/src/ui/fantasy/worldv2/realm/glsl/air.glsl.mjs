// LIFE air shaders (plan §7 A10 birds + ground shadows, A11 ambience; GLSL ES 3.00 plain strings).
// JS reference: src/realm/scatter.js (flockSite/birdPose, particle). Needs "common", "classes", "life".
// Air sprites live in the p32 array (32×32 layers). Everything here is hidden under reduced motion.

/** Birds: flocks circling world-anchored sites; uShadow = 1 draws their ground shadows (multiply pass). */
export const BIRD_VS = `
#include "common"
#include "classes"
#include "life"
layout(location = 0) in vec2 aQ;
uniform ivec4 uWin;      // ix0, iy0, nx, stride (RM-20: a world-aligned thinned lattice, keep scaled to match)
uniform ivec4 uBird;     // pitchArt, jitterArt, salt, nSpecies
uniform int uRow;        // table row (T0 layer0,cum−1,-,onMask · T1 frames,frameMs,inkH,speed · T2 32,32,ax,ay · T3 fMin,fMax,alt,-)
uniform int uP16;        // flock presence per site (u16)
uniform float uKeep;
uniform float uSky;      // sky scale clamp(1100/d, 1, 3)
uniform int uShadow;
out vec2 vTex;
flat out int vLayer;
flat out float vFade;
void main() {
  if (uViewport.w > 0.5) { cullVertex(); return; }
  int id = gl_InstanceID, m = id & 7, si = id >> 3;   // FLOCK_MAX = 8 (bitwise: no integer division by a constant)
  ivec2 cell = ivec2(uWin.x, uWin.y) + ivec2(si % uWin.z, si / uWin.z) * max(1, uWin.w);
  uvec2 h = cellH(uBird.z, cell); uint h2 = cellH2(uBird.z, cell);
  if (int(h.y & 0xffffu) >= uP16) { cullVertex(); return; }
  ivec2 seat = cellSeat(cell, uBird.x, uBird.y, h);
  int s = pickSpecies(uRow, uBird.w, h.y >> 16u);
  if (s < 0) { cullVertex(); return; }
  uvec4 t0 = lt(s * SPT, uRow), t1 = lt(s * SPT + 1, uRow), t2 = lt(s * SPT + 2, uRow), t3 = lt(s * SPT + 3, uRow);
  if (t0.w != 0u && ((t0.w >> lifeClass(tileOf(seat))) & 1u) == 0u) { cullVertex(); return; }
  if (float((h.x ^ h2) & 0xffffu) >= uKeep * 65536.0) { cullVertex(); return; }
  int n = int(t3.x) + int(range16(h2 >> 16u, t3.y - t3.x + 1u));
  if (m >= n || float(t1.z) * uSky * uViewport.z < MIN_INK) { cullVertex(); return; }
  float radius = float(6u + range16((h.x ^ h2) >> 16u, 7u)) * 32.0, dir = ((h2 >> 20u) & 1u) == 1u ? 1.0 : -1.0;
  float speed = float(t1.w), w = speed / radius * dir;
  uint periodMs = uint(floor(6.2831853 * radius / speed * 1000.0 + 0.5));
  float tt = float(uClock.x % periodMs) / 1000.0;
  float th = float(h2 & 0xffffu) / 65536.0 * 6.2831853 + w * tt - float(m) * 0.22 * dir;
  float rr = radius * (1.0 - 0.06 * float(m));
  vec2 ground = vec2(seat) + vec2(cos(th) * rr, sin(th) * rr * 0.62);
  bool flip = -sin(th) * w < 0.0;
  float alt = float(t3.z) + 10.0 * float(m);
  int frame = int((uClock.x / max(t1.y, 1u) + uint(m)) % max(t1.x, 1u));
  // art px → CSS: the sprite and its altitude scale by the sky scale; the ground point does not
  float k = uSky, art2css = uCam.z / DEED_ART_F;
  vec2 g = deedToCss(floor(ground) / DEED_ART_F);
  vec2 lift = uShadow == 1 ? vec2(alt * 0.35, 0.0) * k * art2css : vec2(0.0, -alt * k * art2css);
  vec2 css = g + lift + (vec2(flip ? 1.0 - aQ.x : aQ.x, aQ.y) * 32.0 - vec2(float(t2.z), float(t2.w))) * k * art2css;
  gl_Position = cssToClip(css, 0.0);
  vTex = aQ * 32.0; vLayer = int(t0.x) + frame; vFade = 1.0;
  rehearsalCover();
}
`;

/** Ambience particles (A11): one per lattice cell, alive lifeMs, Bayer-faded in and out. */
export const PARTICLE_VS = `
#include "common"
#include "classes"
#include "life"
layout(location = 0) in vec2 aQ;
uniform ivec4 uWin;      // ix0, iy0, nx, stride (RM-20, as BIRD_VS)
uniform ivec4 uAmb;      // pitchArt, jitterArt, salt, kind (0 wander, 1 fall, 2 spray)
uniform ivec4 uAmbB;     // lifeMs, alt, rise (0/1), density table row
uniform ivec4 uSpr;      // layer0, frames, frameMs, inkH
uniform ivec2 uAnchor;   // anchor in the 32×32 layer
uniform vec2 uWind;      // art px / s, × the emitter's windK
uniform float uKeep;
out vec2 vTex;
flat out int vLayer;
flat out float vFade;
void main() {
  if (uViewport.w > 0.5 || float(uSpr.w) * uViewport.z < MIN_INK) { cullVertex(); return; }
  int si = gl_InstanceID;
  ivec2 cell = ivec2(uWin.x, uWin.y) + ivec2(si % uWin.z, si / uWin.z) * max(1, uWin.w);
  uvec2 h = cellH(uAmb.z, cell); uint h2 = cellH2(uAmb.z, cell);
  ivec2 seat = cellSeat(cell, uAmb.x, uAmb.y, h);
  ivec2 tile = tileOf(seat);
  if ((h.y & 0xffffu) >= density(uAmbB.w, lifeClass(tile))) { cullVertex(); return; }
  if (float((h2 >> 8u) & 0xffffu) >= uKeep * 65536.0) { cullVertex(); return; }
  if (uAmb.w == 2) { // spray: a sea cell next to land
    bool land = false;
    ivec2 k[4] = ivec2[4](ivec2(2, 0), ivec2(-2, 0), ivec2(0, 2), ivec2(0, -2));
    for (int i = 0; i < 4; i++) if (lifeClass(tile + k[i]) > 2u) land = true;
    if (!land) { cullVertex(); return; }
  }
  uint life = uint(uAmbB.x), t = (uClock.x + range16(h2, life)) % life;
  float u = float(t) / float(life), drift = uAmb.w == 2 ? 0.0 : float(t) / 1000.0;
  vec2 p = vec2(seat) + uWind * drift;
  float alt = uAmb.w == 1 ? (uAmbB.z == 1 ? float(uAmbB.y) * u : float(uAmbB.y) * (1.0 - u)) : 0.0;
  int frame = int((uClock.x / uint(max(uSpr.z, 1)) + (h.y >> 16u)) % uint(max(uSpr.y, 1)));
  bool flip = ((h2 >> 20u) & 1u) == 1u;
  vec2 corner = floor(p) - vec2(0.0, floor(alt)) + vec2((flip ? 1.0 - aQ.x : aQ.x) * 32.0 - float(uAnchor.x), aQ.y * 32.0 - float(uAnchor.y));
  gl_Position = cssToClip(deedToCss(corner / DEED_ART_F), 0.0);
  vTex = aQ * 32.0; vLayer = uSpr.x + frame;
  vFade = min(1.0, min(u / 0.15, (1.0 - u) / 0.15));
  rehearsalCover();
}
`;

/** Air fragment: the p32 array, binary alpha, Bayer fade; uShadow = 1 writes the 2-level shadow tint. */
export const AIR_FS = `
#include "common"
uniform highp sampler2DArray uArr;
uniform int uShadow;
in vec2 vTex;
flat in int vLayer;
flat in float vFade;
out vec4 o;
void main() {
  vec2 size = vec2(textureSize(uArr, 0).xy);
  vec2 px = sharpUV(vTex);
  vec4 c = textureGrad(uArr, vec3(px / size, float(vLayer)), dFdx(vTex / size), dFdy(vTex / size));
  if (c.a < 0.5) discard;
  if (vFade < 1.0 && bayer4(ivec2(gl_FragCoord.xy)) >= vFade) discard;
  if (uShadow == 1) { o = vec4(vec3(0.74, 0.76, 0.82), 1.0); return; } // multiply: one art-px silhouette, one alpha level
  o = vec4(c.rgb * cloudShade(fragDeed(), 3136.0), 1.0);
}
`;
