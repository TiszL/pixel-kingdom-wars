#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_FS 1


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
