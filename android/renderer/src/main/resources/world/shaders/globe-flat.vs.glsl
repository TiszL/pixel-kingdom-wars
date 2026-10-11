#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_VS 1

layout(location=0) in vec2 aPos;
out vec2 vNdc;
void main(){vNdc=aPos;gl_Position=vec4(aPos,0.,1.);}
