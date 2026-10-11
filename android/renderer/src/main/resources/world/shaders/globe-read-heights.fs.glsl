#version 300 es
precision highp float;uniform highp samplerCube uHeight;out vec4 o;
void main(){vec2 uv=gl_FragCoord.xy/vec2(1024.,512.);float lon=(uv.x-.5)*6.2831853,lat=(.5-uv.y)*3.14159265;
 vec3 d=vec3(cos(lat)*sin(lon),sin(lat),cos(lat)*cos(lon));float h=max(textureLod(uHeight,d,0.).r,0.);
 float t=clamp(h/.06,0.,1.)*65535.;o=vec4(floor(t/256.)/255.,mod(t,256.)/255.,0.,1.);}