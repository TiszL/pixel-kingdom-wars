#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_FS 1


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
