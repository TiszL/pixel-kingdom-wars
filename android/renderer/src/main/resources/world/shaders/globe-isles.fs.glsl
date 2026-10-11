#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp usampler2D;
precision highp usampler2DArray;
precision highp isampler2D;
#define REALM_FS 1


const float GLOBE_PI = 3.14159265359;
// one geography px of arc (pi/384): the unit of the selection fields
const float GEO_PX = 0.0081812;

// shared per-frame view (every globe program)
uniform vec4 uInvVP0, uInvVP1, uInvVP2, uInvVP3; // inverse view-projection, columns
uniform vec4 uEye;    // xyz: camera position (planet radius 1); w: radians per buffer px along a ray
uniform vec4 uSun;    // xyz: light direction; w: night (0/1)
uniform vec4 uClock;  // x: animation seconds (frozen at the idle freeze); y: cloud rotation (rad); z: cloud amount; w: altitude
uniform vec4 uSel;    // x: mode (0 none, 1 realm, 2 island); y: strength K (eased); z: seconds since the entrance; w: motion (0/1)
uniform vec4 uSelCol; // rgb: accent
uniform vec4 uSelC;   // xyz: selection frame centre; w: realm layer in uSelMap
uniform vec4 uSelE;   // xyz: frame east
uniform vec4 uSelN;   // xyz: frame north
uniform vec4 uSelIsle; // xy: island field window half extents (rad)
uniform highp sampler2DArray uSelMap;   // RG16F, one layer per realm (768x384, geoUV, S repeat)
uniform highp sampler2D uSelIsleMap;    // RG16F, the selected island's window (per-axis angles)

float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
vec3 rotY(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
vec2 geoUV(vec3 d){float lon=atan(d.x,d.z);float lat=asin(clamp(d.y,-1.,1.));return vec2(lon/(2.*GLOBE_PI)+.5,.5-lat/GLOBE_PI);}

// Cube face of direction d as (u, v, layer) in a 6-layer array, and d(uv)/dx, d(uv)/dy from the direction's own
// screen derivatives (gx, gy): continuous across face edges, where differencing uv would pick the smallest mip.
// Face f, s and t as art-prep/globe-v2 and the concept's faceDir(): +X (-z,-y) -X (z,-y) +Y (x,z) -Y (x,-z)
// +Z (x,-y) -Z (-x,-y), each over |major|; u = (s+1)/2, v = (t+1)/2.
vec3 cubeUV(vec3 d,vec3 gx,vec3 gy,out vec4 g){
 vec3 a=abs(d);vec3 p,px,py;float face;
 if(a.x>=a.y&&a.x>=a.z){float s=d.x<0.?-1.:1.;face=d.x<0.?1.:0.;p=vec3(-s*d.z,-d.y,s*d.x);px=vec3(-s*gx.z,-gx.y,s*gx.x);py=vec3(-s*gy.z,-gy.y,s*gy.x);}
 else if(a.y>=a.z){float s=d.y<0.?-1.:1.;face=d.y<0.?3.:2.;p=vec3(d.x,s*d.z,s*d.y);px=vec3(gx.x,s*gx.z,s*gx.y);py=vec3(gy.x,s*gy.z,s*gy.y);}
 else{float s=d.z<0.?-1.:1.;face=d.z<0.?5.:4.;p=vec3(s*d.x,-d.y,s*d.z);px=vec3(s*gx.x,-gx.y,s*gx.z);py=vec3(s*gy.x,-gy.y,s*gy.z);}
 float m=max(p.z,1e-6);
 g=vec4(px.xy*m-p.xy*px.z,py.xy*m-p.xy*py.z)/(2.*m*m);
 return vec3(p.xy/m*.5+.5,face);}
vec4 cubeTex(highp sampler2DArray s,vec3 d,vec3 gx,vec3 gy){vec4 g;vec3 uvw=cubeUV(d,gx,gy,g);return textureGrad(s,uvw,g.xy,g.zw);}

// The view ray through this fragment: origin uEye.xyz, unit direction.
vec3 viewRay(vec2 ndc){mat4 inv=mat4(uInvVP0,uInvVP1,uInvVP2,uInvVP3);vec4 a=inv*vec4(ndc,-1.,1.),b=inv*vec4(ndc,1.,1.);return normalize(b.xyz/b.w-a.xyz/a.w);}

// Selection field at d: x = signed outline distance (geography px of arc, + inside, clamped ±25.9), y = its rate.
// Realms read their layer of uSelMap on the equirect grid; islands read their window in the art's tangent frame and
// keep falling with the angular overshoot beyond it (the concept's selSd).
vec2 selField(vec3 d){
 if(uSel.x>1.5){float z=dot(d,uSelC.xyz);if(z<.2)return vec2(-25.9,1.);
  vec2 a=vec2(atan(dot(d,uSelE.xyz),z),atan(dot(d,uSelN.xyz),z));vec2 ov=max(abs(a)-uSelIsle.xy,0.);
  vec2 f=textureLod(uSelIsleMap,vec2(.5+.5*a.x/uSelIsle.x,.5-.5*a.y/uSelIsle.y),0.).rg;return vec2(max(f.x-length(ov)/GEO_PX,-25.9),f.y);}
 return textureLod(uSelMap,vec3(geoUV(d),uSelC.w),0.).rg;}
// The outline distance's screen rate (the fwidth() it replaces): the stored rate times the pixel's footprint on the
// sphere, isotropic (LANE-NB.md: 0.635·G·(|dFdx d| + |dFdy d|)/h).
float selFw(vec2 f,vec3 gx,vec3 gy){return .635*max(f.y,.05)*(length(gx)+length(gy))/GEO_PX;}

// The concept's selection look (TERRAIN2_FS, D-166), verbatim but for selFw: others dimmed and desaturated, then a
// crisp shining rim with a keyline, a screen-blended glow, a draw-on entrance from the north both ways round, a
// landing pulse and a travelling shimmer. sd: outline distance; fw: its screen rate.
vec3 selLook(vec3 col,vec3 d,float sd,float fw){
 float dp=sd/max(fw,1e-3);
 vec3 q=d-uSelC.xyz*dot(d,uSelC.xyz);float sa=atan(dot(q,uSelE.xyz),dot(q,uSelN.xyz)),ang=abs(sa);
 float t=uSel.z,mo=uSel.w,K=uSel.y;
 float prog=mo>.5?1.-pow(1.-clamp(t/.62,0.,1.),3.):1.,front=prog*3.46;
 float drawn=1.-smoothstep(front-.3,front,ang);
 float sf=(ang-front)/.09,pt=(t-.7)/.13;
 float spark=mo*step(0.,t)*exp(-sf*sf)*(1.-smoothstep(.45,.7,t));
 float pulse=1.+mo*(.8*exp(-pt*pt)+.06*sin(t*2.3));
 float shim=mo*smoothstep(.6,1.1,t)*(pow(max(0.,.5+.5*cos(sa-t*1.05)),40.)+.55*pow(max(0.,.5+.5*cos(sa+3.1416-t*1.05)),40.));
 float outK=1.-smoothstep(-3.,.5,sd);
 col=mix(col,mix(vec3(luma(col)),col,.35)*vec3(.52,.56,.68),.58*K*outK);
 col*=1.+.08*K*(1.-outK);
 float rim=1.-smoothstep(1.,2.2,abs(dp-1.5)),key=1.-smoothstep(.5,1.4,abs(dp+.9));
 float outer=dp<0.?(exp(dp/9.)*.9+exp(dp/30.)*.35)*smoothstep(-25.,-12.,sd):0.,inner=dp>0.?exp(-dp/9.):0.;
 vec3 acc=uSelCol.rgb,hot=mix(acc,vec3(1.),.55);float vis=K*drawn;
 col*=1.-.55*key*vis;
 col=1.-(1.-col)*(1.-clamp(acc*(outer*.62+inner*.2)*vis*pulse,0.,1.));
 col=mix(col,hot,clamp(rim*vis*min(pulse,1.3),0.,1.));
 col=1.-(1.-col)*(1.-clamp(hot*(rim+outer*.45)*(vis*shim*1.2+K*spark*2.),0.,1.));
 return col;}

// Diffuse, cloud shadow and night dimming of the flat globe (TERRAIN2_FS with n = d: exag 0, so no slope shade).
vec3 litSurface(vec3 col,vec3 d,float cloudSh){
 float ndl=dot(d,uSun.xyz);float diff=.64+.36*clamp(ndl*1.3,-1.,1.);
 col*=mix(.9,1.,diff)*cloudSh;
 return col*(1.-uSun.w*(1.-smoothstep(-.2,.25,ndl))*.72);}
// The atmosphere haze at the limb, last (TERRAIN2_FS order: after the glow and the selection).
vec3 limbHaze(vec3 col,vec3 d,vec3 rd){
 float day=smoothstep(-.2,.25,dot(d,uSun.xyz));float fr=pow(1.-max(dot(d,-rd),0.),3.);
 return mix(col,vec3(.5,.66,.95)*(.45+.55*day),fr*.35*smoothstep(.02,.2,uClock.w));}

in vec2 vNdc;
flat in vec4 vIsle;
flat in vec4 vSlot;
uniform vec4 uIsleGrid;
uniform highp sampler2DArray uIsleArt; // RGBA8, one chain atlas per layer, alpha = land, mipmapped
uniform highp sampler2DArray uCloud;
out vec4 o;
void main(){
 vec3 ro=uEye.xyz,rd=viewRay(vNdc);
 float tca=-dot(ro,rd),d2=dot(ro,ro)-tca*tca;
 vec3 d=normalize(ro+rd*(tca-sqrt(max(1.-d2,0.))));
 vec2 deg=vec2(degrees(atan(d.x,d.z)),degrees(asin(clamp(d.y,-1.,1.))));
 vec2 local=vec2(mod(deg.x-vIsle.x+540.,360.)-180.,deg.y-vIsle.y)/vIsle.zw;
 // atlas texel coordinate, continuous (the legacy pass floored it to the cell)
 vec2 cell=(local/uIsleGrid.z*vec2(1.,-1.)+1.)*uIsleGrid.x*.5;
 vec2 tp=vSlot.yz*uIsleGrid.x+clamp(cell,vec2(.5),vec2(uIsleGrid.x-.5));
 vec2 tx=dFdx(tp),ty=dFdy(tp),fw=max(abs(tx)+abs(ty),vec2(1e-5));
 vec3 gdx=dFdx(d),gdy=dFdy(d),cgx=rotY(gdx,uClock.y),cgy=rotY(gdy,uClock.y);
 // every derivative is taken above, in uniform control flow; past the box test only the island's own box pays the
 // atlas read, and only its land pays the cloud shadow and the selection field (overlapping boxes cost one read each)
 if(d2>1.||tca<0.||abs(local.x)>=uIsleGrid.z||abs(local.y)>=uIsleGrid.z)discard;
 vec2 sn=floor(tp+.5);vec2 sp=sn+clamp((tp-sn)/fw,-.5,.5); // sharp: crisp texels when magnified
 vec4 a=textureGrad(uIsleArt,vec3(sp/uIsleGrid.y,vSlot.x),tx/uIsleGrid.y,ty/uIsleGrid.y);
 if(a.a<.02)discard;
 vec3 col=a.rgb/a.a;
 float sd=-99.;
 vec2 f=vec2(-99.,1.);
 if(uSel.x>.5){f=selField(d);sd=f.x;}
 float clear=uSel.x>.5?uSel.y*smoothstep(-10.,4.,sd):0.;
 float cloudSh=uClock.z>0.?1.-cubeTex(uCloud,rotY(d+uSun.xyz*.02,uClock.y),cgx,cgy).r*.3*uClock.z*(1.-.9*clear):1.;
 col=litSurface(col,d,cloudSh);
 if(uSel.x>.5&&uSel.y>0.)col=selLook(col,d,sd,selFw(f,gdx,gdy));
 o=vec4(limbHaze(col,d,rd),clamp(a.a,0.,1.));}
