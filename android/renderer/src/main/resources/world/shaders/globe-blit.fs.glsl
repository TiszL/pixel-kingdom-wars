#version 300 es
precision highp float;in vec2 vUv;uniform sampler2D uT;out vec4 o;void main(){o=texture(uT,vUv);}