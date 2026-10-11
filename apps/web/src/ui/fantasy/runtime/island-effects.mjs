import {ARCHIPELAGOS,RAD,project} from './world.mjs';
import {COASTLINES} from './generated/island-coastlines.mjs';
import {ISLAND_FEATURES} from './generated/island-features.mjs';
import {ISLAND_CELL,ISLAND_EXTENT,locateIsland} from './island-shapes.mjs';
const sites=ARCHIPELAGOS.flatMap(a=>a.islands.map((island,i)=>({...island,group:a.id,index:i})));
export const effectAnchors=sites.map((s,number)=>{
 const at=(u,v)=>({lon:(s.lon+((u+.5)/ISLAND_CELL*2-1)*ISLAND_EXTENT*s.rx)*RAD,lat:(s.lat+(1-(v+.5)/ISLAND_CELL*2)*ISLAND_EXTENT*s.ry)*RAD});
 const shore=[];
 for(const v of [64,104,144,184,224,264])for(const [a,b]of COASTLINES[number][v]){if(b-a<5)continue;for(const [u,out]of [[a,a-1],[b,b+1]]){const p=at(u,v),o=at(out,v);if(!locateIsland(o.lon,o.lat,ARCHIPELAGOS)?.visibleLand)shore.push({...p,outside:o});}}
 const features=(ISLAND_FEATURES[number]??[]).map(feature=>({...feature,group:s.group,pixels:feature.pixels.map(([u,v])=>({...at(u,v),u,v}))}));
 return {shore,features};
});
export function visibleEffectSites(cam,radius,cssScale=1,width=400,height=400,center={x:width/2,y:height/2}){return sites.map(s=>({...s,p:project(s.lon*RAD,s.lat*RAD,cam)})).filter(s=>s.p.z>.2&&2*s.rx*RAD*Math.cos(s.lat*RAD)*radius*cssScale*s.p.z>=48&&s.p.x*radius+center.x>-30&&s.p.x*radius+center.x<width+30&&s.p.y*radius+center.y>-30&&s.p.y*radius+center.y<height+30);}
// Animate authored feature pixels in place: source-art silhouettes remain the
// clipping mask, so falling water, vents and spores never leak into the ocean.
export function featureFrame(feature,phase){
 const frame=((phase%8)+8)%8,pulse=[.25,.4,.6,.85,.95,.75,.55,.35][frame];
 const colors={fall:'#d4f2ed',beacon:feature.tint??(feature.group==='aurora'?'#d9ecff':'#fff0bd'),vent:'#ffc18a',spore:'#d6e9bb'};
 const active=feature.pixels.filter(p=>{
  if(feature.kind==='beacon')return true;
  if(feature.kind==='fall')return ((p.v-frame*2)%12+12)%12<3;
  if(feature.kind==='vent')return (p.v+frame*2)%10<4;
  return (p.u*3+p.v+frame)%11<2;
 });
 return active.map(p=>({...p,color:colors[feature.kind],alpha:feature.kind==='beacon'?pulse:feature.kind==='vent'?.6:.75}));
}
export function mountIslandEffects({canvas,getCamera,getRadius,getCenter=()=>({x:canvas.width/2,y:canvas.height/2}),getCssScale=()=>1,getReducedMotion=()=>false}){
  const ctx=canvas.getContext('2d'),media=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let last=-Infinity,previous='',requested=true,clock=null,elapsed=0;
  function draw(time,force=false){
    if(globalThis.document?.hidden){clock=null;return false;}
    const motion=requested&&!media?.matches&&!getReducedMotion();
    if(clock!==null&&motion)elapsed+=Math.max(0,Math.min(time-clock,125));clock=time;
    const key=motion?Math.floor(elapsed/125):'static';
    if(!force&&(time-last<125||key===previous))return false;
    last=time;previous=key;ctx.clearRect(0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=false;
    const radius=getRadius(),cam=getCamera(),center=getCenter(),phase=motion?Math.floor(elapsed/125)%8:0;
    for(const s of visibleEffectSites(cam,radius,getCssScale(),canvas.width,canvas.height,center)){
      const anchors=effectAnchors[sites.findIndex(site=>site.group===s.group&&site.index===s.index)];
      const pix=(point,color,w=2,h=1,alpha=1)=>{const p=project(point.lon,point.lat,cam);if(p.z<=.2)return;const x=Math.round(center.x+p.x*radius),y=Math.round(center.y+p.y*radius);ctx.fillStyle=color;ctx.globalAlpha=alpha;ctx.fillRect(x,y,w,h);ctx.globalAlpha=1;};
      // Cache the authored mask's exact left/right shoreline, not an ellipse.
      anchors.shore.forEach((point,n)=>{if((n+phase)%3!==0)pix(point,'#bbd8d1',2,1);});
      const pixel=Math.max(1,Math.round(radius*RAD*2*ISLAND_EXTENT*Math.max(s.rx*Math.cos(s.lat*RAD),s.ry)/ISLAND_CELL));
      for(const feature of anchors.features)for(const point of featureFrame(feature,phase))pix(point,point.color,pixel,pixel,point.alpha);
    }
    return true;
  }
  return {draw,setMotion(value){requested=Boolean(value);previous='';},get motion(){return requested&&!media?.matches&&!getReducedMotion();}};
}
