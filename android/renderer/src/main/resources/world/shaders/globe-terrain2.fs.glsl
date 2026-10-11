#version 300 es
precision highp float;precision highp samplerCube;precision highp sampler2D;
in vec3 vDir;in vec3 vWorld;
uniform samplerCube uHeight,uAlbedo,uHint,uCloud;uniform highp sampler2DArray uDetail;uniform sampler2D uWA,uWB,uPaint0,uPaint1;
uniform vec4 uPC[2],uPE[2],uPN[2];uniform int uPR[2];uniform float uPaintK,uDetailK,uDetailScale;uniform vec3 uDetailMean[8];
uniform sampler2D uIslTex;uniform vec4 uIslC,uIslE,uIslN;uniform float uIslK;
uniform highp sampler2DArray uDet;uniform ivec4 uDetIds;uniform vec4 uDetC,uDetE,uDetN,uDetGeo;uniform float uDetK,uDetSharp;
uniform vec3 uCam,uSun;uniform float uExag,uTexel,uTime,uNight,uCloudRot,uCloudAmt,uZoom;out vec4 o;

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

float H(vec3 d){return texture(uHeight,d).r;}
vec3 rotY(vec3 p,float a){float c=cos(a),s=sin(a);return vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
float realmW(int r,vec2 uv){vec4 a=texture(uWA,uv),b=texture(uWB,uv);float W[8];W[0]=a.r;W[1]=a.g;W[2]=a.b;W[3]=a.a;W[4]=b.r;W[5]=b.g;W[6]=b.b;W[7]=b.a;return W[r];}
// Realm paintings: gnomonic frame coords (continuous across the frame edge, so their derivatives are valid
// everywhere) and a feather that takes the painting to 0 over the last ~3% of its frame. The old hard cut
// sampled inside a per-pixel branch: broken implicit derivatives picked a wrong mip on the frame's 2x2 quads
// and drew dashed lines across the ocean.
vec2 paintP(int k,vec3 d){return vec2(dot(d,uPE[k].xyz),dot(d,uPN[k].xyz))/max(dot(d,uPC[k].xyz),.05)/uPC[k].w;}
float paintF(int k,vec3 d,vec2 p){return dot(d,uPC[k].xyz)<.05?0.:1.-smoothstep(.965,.995,max(abs(p.x),abs(p.y)));}
vec3 tri(float layer,vec3 d,float K){vec3 w=pow(abs(d),vec3(10.));w/=(w.x+w.y+w.z);vec3 c=vec3(0.);
 if(w.x>.02)c+=texture(uDetail,vec3(d.zy*K,layer)).rgb*w.x;if(w.y>.02)c+=texture(uDetail,vec3(d.xz*K,layer)).rgb*w.y;if(w.z>.02)c+=texture(uDetail,vec3(d.xy*K,layer)).rgb*w.z;return c;}
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}
void main(){
 vec3 d=normalize(vDir);vec3 e1=normalize(cross(abs(d.y)<.99?vec3(0,1,0):vec3(1,0,0),d)),e2=cross(d,e1);
 float h=H(d),eps=uTexel;vec3 V=normalize(uCam-vWorld);
 vec3 alb=texture(uAlbedo,d).rgb;vec4 hint=texture(uHint,d);
 vec2 guv=geoUV(d);
 // UV gradients for the streamed paintings and island art, taken here in uniform control flow and passed to
 // textureGrad below (derivatives inside the per-pixel branches are undefined).
 vec2 pp0=paintP(0,d),pp1=paintP(1,d),uv0=vec2(pp0.x*.5+.5,.5-pp0.y*.5),uv1=vec2(pp1.x*.5+.5,.5-pp1.y*.5);
 vec4 gp0=vec4(dFdx(uv0),dFdy(uv0)),gp1=vec4(dFdx(uv1),dFdy(uv1));
 float dzI=dot(d,uIslC.xyz),zI=max(dzI,.05);vec2 qI=vec2(atan(dot(d,uIslE.xyz)/zI)/max(uIslE.w,1e-4),atan(dot(d,uIslN.xyz)/zI)/max(uIslN.w,1e-4));
 vec2 uvI=vec2(qI.x+.5,.5-qI.y);vec4 gI=vec4(dFdx(uvI),dFdy(uvI));
 if(uPaintK>0.){ // full-resolution realm painting near the camera
  // Each painting counts where its own realm's weight is (so overlapping frames resolve by realm); the
  // feather scales both its colour share and the coverage, so a frame edge fades into the cube albedo.
  float ws=0.,wf=0.;vec3 acc=vec3(0.);
  if(uPR[0]>=0){float w=realmW(uPR[0],guv)+.001,f=paintF(0,d,pp0);ws+=w;wf+=w*f;acc+=textureGrad(uPaint0,uv0,gp0.xy,gp0.zw).rgb*w*f;}
  if(uPR[1]>=0){float w=realmW(uPR[1],guv)+.001,f=paintF(1,d,pp1);ws+=w;wf+=w*f;acc+=textureGrad(uPaint1,uv1,gp1.xy,gp1.zw).rgb*w*f;}
  if(wf>1e-4)alb=mix(alb,acc/wf,uPaintK*smoothstep(.02,.2,ws)*(wf/ws));
 }
 if(uIslK>0.){float m=max(abs(qI.x),abs(qI.y));if(dzI>.9&&m<.5){vec4 ic=textureGrad(uIslTex,uvI,gI.xy,gI.zw);ic.a*=smoothstep(.5,.45,m); // feather the frame: art water reaching the edge drew straight lines
    alb=mix(alb,ic.rgb,ic.a*uIslK);}}
 // deed-level detail: 4 streamed core tiles of the realm's 3x re-render (gnomonic frame, padded cores)
 float detW=0.;vec2 detG=vec2(0.);
 if(uDetK>0.){float dz=max(dot(d,uDetC.xyz),.05);vec2 pp=vec2(dot(d,uDetE.xyz),dot(d,uDetN.xyz))/dz/uDetC.w;
  float NN=uDetGeo.x,T=uDetGeo.w;vec2 cell=vec2(pp.x*.5+.5,.5-pp.y*.5)*NN;
  vec2 tpx=cell*uDetGeo.y*T; // continuous texel coordinate (derivatives valid across tile seams)
  vec2 gx=dFdx(tpx),gy=dFdy(tpx),fw=max(abs(gx)+abs(gy),vec2(1e-5));
  ivec2 ti=ivec2(floor(cell));int id=ti.y*int(NN)+ti.x;int sl=-1;
  for(int i=0;i<4;i++)if(uDetIds[i]==id)sl=i;
  if(sl>=0&&dot(d,uDetC.xyz)>.2&&cell.x>=0.&&cell.y>=0.&&cell.x<NN&&cell.y<NN){
   vec2 tp=(uDetGeo.z+fract(cell)*uDetGeo.y)*T;
   if(uDetSharp>.5){vec2 sn=floor(tp+.5);tp=sn+clamp((tp-sn)/fw,-.5,.5);} // crisp texels when magnified, plain filtering when minified
   vec4 dc=textureGrad(uDet,vec3(tp/T,float(sl)),gx/T,gy/T);
   detW=dc.a*uDetK;alb=mix(alb,dc.rgb,detW);
   float lod=max(0.,log2(max(fw.x,fw.y)))+1.;float o=1.5*exp2(lod-1.);
   float lx=luma(textureLod(uDet,vec3((tp+vec2(o,0.))/T,float(sl)),lod).rgb)-luma(textureLod(uDet,vec3((tp-vec2(o,0.))/T,float(sl)),lod).rgb);
   float ly=luma(textureLod(uDet,vec3((tp-vec2(0.,o))/T,float(sl)),lod).rgb)-luma(textureLod(uDet,vec3((tp+vec2(0.,o))/T,float(sl)),lod).rgb);
   detG=vec2(lx,ly)*detW;}
 }
 vec3 n=d;vec3 col;float wet=0.;
 if(h<0.){ // sea: painted colour (surf + shallows near shore), gentle animated shimmer, no glare
  vec3 p=d*420.;float t=uTime*.5;float w1=vnoise(p+vec3(t,0.,t*.7)),w2=vnoise(p*2.1-vec3(t*.8,t*.3,0.));
  n=normalize(d+(e1*(w1-.5)+e2*(w2-.5))*.02);
  // surf shimmer only where the painting draws surf/shallows: the height also rises around unpainted
  // exploration islets in open sea, where the planar wave drew striped rings
  col=alb*(.94+.1*(w1*w2));float shore=smoothstep(-.0016,0.,h)*smoothstep(.2,.38,luma(alb));
  col+=vec3(.55,.8,.85)*shore*(.5+.5*sin(uTime*1.6+dot(d,vec3(600.,420.,510.))))*.12;wet=1.;
 }else{
  float hx=H(normalize(d+e1*eps))-H(normalize(d-e1*eps)),hy=H(normalize(d+e2*eps))-H(normalize(d-e2*eps));
  n=normalize(d-(e1*hx+e2*hy)*uExag/(2.*eps));col=alb;
  if(detW>0.)n=normalize(n-(uDetE.xyz*detG.x+uDetN.xyz*detG.y)*.9);
  float steep=smoothstep(.12,.32,1.-dot(n,d));
  if(steep>0.){float strata=.82+.18*sin(h*9000.+vnoise(d*900.)*3.);vec3 rock=mix(vec3(luma(alb)),alb,.45)*.62*strata;col=mix(col,rock,steep*.85);}
  if(uDetailK>0.){ // r4 realm tile as luminance micro-detail at the closest zoom
   vec4 a=texture(uWA,guv),b=texture(uWB,guv);float W[8];W[0]=a.r;W[1]=a.g;W[2]=a.b;W[3]=a.a;W[4]=b.r;W[5]=b.g;W[6]=b.b;W[7]=b.a;
   int i0=0;for(int i=1;i<8;i++)if(W[i]>W[i0])i0=i;
   vec3 dt=tri(float(i0),d,uDetailScale);float m=luma(dt)/max(.05,luma(uDetailMean[i0]));
   col=mix(col,clamp(col*mix(1.,clamp(m,.55,1.5),.9)*1.02,0.,1.),uDetailK*(1.-detW));
  }
 }
 float ndl=dot(n,uSun);float diff=.64+.36*clamp(ndl*1.3,-1.,1.);
 float shade=clamp(1.+(dot(n,uSun)-dot(d,uSun))*2.2,.62,1.22);
 float sd=uSelMode>.5?selSd(d):-99.; // selection outline distance (geo px, + inside); -99 = nothing selected
 float cloudSh=1.-texture(uCloud,rotY(d+uSun*.02,uCloudRot)).r*.3*uCloudAmt*(1.-.9*uSelK*smoothstep(-10.,4.,sd));
 float day=smoothstep(-.2,.25,dot(d,uSun));
 col*=mix(.9,1.,diff)*shade*cloudSh;
 float nightK=uNight*(1.-day);col*=1.-nightK*.72;
 // glows read from the painting: lava, crystals, gem water
 float pulse=.8+.2*sin(uTime*1.7+dot(d,vec3(90.,70.,40.)));
 col+=alb*hint.a*(.18+nightK*1.2)*pulse;
 if(uSelMode>.5&&uSelK>0.){ // selected realm: dim the rest, then a crisp shining rim with glow and a travelling shimmer
  float fw=max(selFw(d,sd),1e-3),dp=sd/fw; // dp: screen px from the outline, + inside
  vec3 q=d-uSelC*dot(d,uSelC);float sa=atan(dot(q,uSelE),dot(q,uSelN)),ang=abs(sa); // 0 = north of the realm centre
  float t=uSelT,mo=uSelMotion,K=uSelK;
  float prog=mo>.5?1.-pow(1.-clamp(t/.62,0.,1.),3.):1.,front=prog*3.46; // entrance: drawn from the top, both ways round
  float drawn=1.-smoothstep(front-.3,front,ang);
  float sf=(ang-front)/.09,pt=(t-.7)/.13; // (squares, not pow(): pow of a negative base is undefined in GLSL)
  float spark=mo*step(0.,t)*exp(-sf*sf)*(1.-smoothstep(.45,.7,t));
  float pulse=1.+mo*(.8*exp(-pt*pt)+.06*sin(t*2.3));
  float shim=mo*smoothstep(.6,1.1,t)*(pow(max(0.,.5+.5*cos(sa-t*1.05)),40.)+.55*pow(max(0.,.5+.5*cos(sa+3.1416-t*1.05)),40.));
  float outK=1.-smoothstep(-3.,.5,sd);
  col=mix(col,mix(vec3(luma(col)),col,.35)*vec3(.52,.56,.68),.58*K*outK); // others: dimmed + desaturated
  col*=1.+.08*K*(1.-outK);
  float rim=1.-smoothstep(1.,2.2,abs(dp-1.5)),key=1.-smoothstep(.5,1.4,abs(dp+.9));
  float outer=dp<0.?(exp(dp/9.)*.9+exp(dp/30.)*.35)*smoothstep(-25.,-12.,sd):0.,inner=dp>0.?exp(-dp/9.):0.;
  vec3 acc=uSelCol,hot=mix(acc,vec3(1.),.55);float vis=K*drawn;
  col*=1.-.55*key*vis;
  col=1.-(1.-col)*(1.-clamp(acc*(outer*.62+inner*.2)*vis*pulse,0.,1.)); // glow, screen-blended (never blows out)
  col=mix(col,hot,clamp(rim*vis*min(pulse,1.3),0.,1.));
  col=1.-(1.-col)*(1.-clamp(hot*(rim+outer*.45)*(vis*shim*1.2+K*spark*2.),0.,1.));
 }
 float fr=pow(1.-max(dot(d,V),0.),3.);col=mix(col,vec3(.5,.66,.95)*(.45+.55*day),fr*.35*(1.-smoothstep(.2,.02,uZoom)));
 o=vec4(col,1.);}
