#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_VS 1
#define RM_LAVA

layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
