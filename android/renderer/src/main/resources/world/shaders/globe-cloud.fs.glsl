#version 300 es
precision highp float;in vec3 vDir;uniform highp samplerCube uCloud;uniform vec3 uSun,uCam;uniform float uRot,uAmt,uNight,uPixel;out vec4 o;

#define PI 3.14159265359
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.zyx+31.32);return fract((p.x+p.y)*p.z);}
vec3 hash33(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
float vnoise(vec3 p){vec3 i=floor(p),f=fract(p);vec3 u=f*f*(3.-2.*f);
 return mix(mix(mix(hash13(i),hash13(i+vec3(1,0,0)),u.x),mix(hash13(i+vec3(0,1,0)),hash13(i+vec3(1,1,0)),u.x),u.y),
            mix(mix(hash13(i+vec3(0,0,1)),hash13(i+vec3(1,0,1)),u.x),mix(hash13(i+vec3(0,1,1)),hash13(i+vec3(1,1,1)),u.x),u.y),u.z);}
float fbm(vec3 p,int o){float a=.5,s=0.,n=0.;for(int i=0;i<8;i++){if(i>=o)break;s+=a*vnoise(p);n+=a;p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s/n;}
float ridged(vec3 p,int o){float a=.5,s=0.,n=0.,w=1.;for(int i=0;i<8;i++){if(i>=o)break;float r=1.-abs(vnoise(p)*2.-1.);r*=r;s+=a*r*w;w=clamp(r*1.6,0.,1.);n+=a;p=p*2.07+vec3(5.1,1.3,7.7);a*=.5;}return s/n;}
// Worley: x=F1, y=F2, z=cell hash
vec3 worley(vec3 p){vec3 i=floor(p),f=fract(p);float f1=9.,f2=9.,id=0.;
 for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec3 g=vec3(x,y,z);vec3 o=hash33(i+g);vec3 r=g+o-f;float d=dot(r,r);
  if(d<f1){f2=f1;f1=d;id=hash13(i+g+7.1);}else if(d<f2)f2=d;}
 return vec3(sqrt(f1),sqrt(f2),id);}
vec3 faceDir(int face,float s,float t){vec3 d;
 if(face==0)d=vec3(1.,-t,-s);else if(face==1)d=vec3(-1.,-t,s);else if(face==2)d=vec3(s,1.,t);
 else if(face==3)d=vec3(s,-1.,-t);else if(face==4)d=vec3(s,-t,1.);else d=vec3(-s,-t,-1.);return normalize(d);}

// Proposed Phase E island silhouettes (local coords u,v in [-1,1]).
float segDist(vec2 p,vec2 c,float r,float a0,float a1){vec2 q=p-c;float a=atan(q.y,q.x);
 float lo=min(a0,a1),hi=max(a0,a1);float aa=a;if(aa<lo)aa+=6.2831853;if(aa>hi&&aa-6.2831853>=lo)aa-=6.2831853;
 if(aa>=lo&&aa<=hi)return abs(length(q)-r);vec2 e0=c+r*vec2(cos(a0),sin(a0)),e1=c+r*vec2(cos(a1),sin(a1));return min(length(p-e0),length(p-e1));}
vec2 isleLocal(vec3 d,vec4 isle){float lon=degrees(atan(d.x,d.z)),lat=degrees(asin(clamp(d.y,-1.,1.)));float dx=mod(lon-isle.x+540.,360.)-180.;return vec2(dx/isle.z,(lat-isle.y)/isle.w);}
// Seeker: segmented S. returns >0 inside.
float seekerShape(vec2 p){float r=.44;
 float d1=segDist(p,vec2(0.,.44),r,radians(20.),radians(270.));   // upper arc through the LEFT side
 float d2=segDist(p,vec2(0.,-.44),r,radians(-160.),radians(90.)); // lower arc through the RIGHT side
 float d=min(d1,d2);
 float gaps=0.;for(int i=0;i<3;i++){vec2 g=i==0?vec2(-.42,.62):i==1?vec2(0.,0.):vec2(.42,-.62);gaps=max(gaps,smoothstep(.09,.04,length(p-g)));}
 return .21-d-gaps*.3;}
// Solana: three slanted terrace bars. x=shape (>0 inside), y=bar index 0..2
vec2 solanaShape(vec2 p){float best=-9.,idx=0.;for(int i=0;i<3;i++){float vk=.52-float(i)*.52;float sl=i==1?-.45:.45;
 float dv=.2-abs(p.y-vk);float du=.8-abs(p.x-(p.y-vk)*sl);float sh=min(dv,du*.5);if(sh>best){best=sh;idx=float(i);}}return vec2(best,idx);}
float solanaBase(vec2 p){return .92-length(p*vec2(.95,1.05));}
vec2 geoUV(vec3 d){float lon=atan(d.x,d.z);float lat=asin(clamp(d.y,-1.,1.));return vec2(lon/(2.*PI)+.5,.5-lat/PI);}


uniform highp sampler2D uSelMap;uniform float uSelMode,uSelK,uSelT,uSelMotion;uniform vec3 uSelCol,uSelC,uSelE,uSelN;uniform vec4 uSelIsle;
float selSd(vec3 d){if(uSelMode>1.5){float z=dot(d,uSelC);if(z<.2)return -25.9;vec2 a=vec2(atan(dot(d,uSelE),z),atan(dot(d,uSelN),z));
  vec2 o=max(abs(a)-uSelIsle.xy,0.);return max(texture(uSelMap,vec2(.5+.5*a.x/uSelIsle.x,.5-.5*a.y/uSelIsle.y)).r-length(o)/.0081812,-25.9);}
 return texture(uSelMap,geoUV(d)).r;}
float selFw(vec3 d,float s){const float h=.0081812; // one geography px of arc (pi/384)
 vec3 sx=dFdx(d),sy=dFdy(d);float lx=max(length(sx),1e-7),ly=max(length(sy),1e-7);vec3 ox=sx*(h/lx),oy=sy*(h/ly);
 if(uSelMode>1.5)return .635*(lx+ly)/h; // island fields are exact Euclidean distance (|grad| = 1): the rate is the pixel's own footprint, so the medial creases of a ragged coast never ripple the glow
 float gx=abs(selSd(normalize(d+ox))-s)+abs(s-selSd(normalize(d-ox))),gy=abs(selSd(normalize(d+oy))-s)+abs(s-selSd(normalize(d-oy)));
 return (gx*lx+gy*ly)/(2.*h);}

vec3 rotY(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
void main(){vec3 d=normalize(vDir);float c=texture(uCloud,rotY(d,uRot)).r;
 if(uPixel>.5)c=floor(c*4.+.5)/4.;
 float day=smoothstep(-.2,.3,dot(d,uSun));float l=mix(.25,1.,smoothstep(-.3,.6,dot(d,uSun)));
 vec3 col=mix(vec3(.55,.6,.75),vec3(1.),l)*mix(1.,.3,uNight*(1.-day));
 float clear=uSelMode>.5?uSelK*smoothstep(-10.,4.,selSd(d)):0.; // the selected realm clears its sky
 o=vec4(col,c*uAmt*.85*(1.-.9*clear));}