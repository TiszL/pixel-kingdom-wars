#version 300 es
in vec3 aPos;uniform mat4 uViewProj;uniform float uR;out vec3 vDir;
void main(){vDir=aPos;gl_Position=uViewProj*vec4(aPos*uR,1.);}