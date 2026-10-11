#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_FS 1


uniform highp usampler2D uPuSrc;
uniform ivec2 uPuShift;
uniform int uPuSlot[14];
layout(location = 0) out uint oCls;
void main() {
  ivec2 s = ivec2(gl_FragCoord.xy) + uPuShift;
  uint raw = texelFetch(uPuSrc, s, 0).r, c = raw & 15u;
  oCls = raw;
  if (c == 0u || c > 14u) return;
  int sl = uPuSlot[int(c) - 1];
  for (int k = 0; k < 9; k++) {
    if (k == 4) continue;
    uint n = texelFetch(uPuSrc, s + ivec2(k % 3 - 1, k / 3 - 1), 0).r & 15u;
    if (n == 0u || n > 14u || uPuSlot[int(n) - 1] != sl) return;
  }
  oCls = raw | 32u;
}
