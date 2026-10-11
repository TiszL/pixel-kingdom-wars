import {RAD,project} from './world.mjs';
import {allocationAt} from './allocations.mjs';
const BANKS=[[-120,42,9,4],[-110,36,8.5,3.8],[-117,32,8,3.6]];
const BW=64,BH=32;
// A complete connected silhouette is the fallback while authored banks load.
function fallbackBanks(){return BANKS.map(()=>{const data=new Uint8ClampedArray(BW*BH*4);for(let y=0;y<BH;y++)for(let x=0;x<BW;x++){
 const u=x/BW,v=y/BH,body=[ [.23,.58,.22,.27],[.42,.38,.23,.31],[.63,.46,.24,.29],[.79,.61,.19,.22],[.5,.65,.42,.2] ].some(([cx,cy,rx,ry])=>((u-cx)/rx)**2+((v-cy)/ry)**2<1);
 if(!body)continue;const color=v<.46?[255,242,249]:v<.66?[245,211,232]:[165,112,158],i=(y*BW+x)*4;data.set([...color,255],i);
 }return data;});}
const fallback=fallbackBanks();
export function cloudOpacity(radius,cssScale=1){return radius*.00872664626*Math.cos(38*RAD)*cssScale>=44?25:114;}
export function cloudSamples(time=0,motion=true,art=fallback){
 const phase=motion?time/16000:0,points=[];
 for(let n=0;n<BANKS.length;n++){
  const [lon,lat,width,height]=BANKS[n],pixels=art[n],drift=Math.sin(phase+n)*.55;
  for(let y=0;y<BH;y++)for(let x=0;x<BW;x++){
   const i=(y*BW+x)*4;if(pixels[i+3]<32)continue;
   const px=(lon+(x/BW-.5)*width+drift)*RAD,py=(lat+(.5-y/BH)*height+Math.sin(phase*.7+n)*.18)*RAD;
   if(allocationAt(px,py)!=='genesis')continue;
   points.push({lon:px,lat:py,strength:pixels[i+3]/255,color:[pixels[i],pixels[i+1],pixels[i+2]],step:width/BW});
  }
 }
 return points;
}
export function mountClouds({canvas,getCamera,getRadius,getCenter=()=>({x:canvas.width/2,y:canvas.height/2}),getCssScale=()=>1,read,getReducedMotion=()=>false,onError=()=>{}}){
  const ctx=canvas.getContext('2d'),media=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  let alive=true,requested=true,last=-Infinity,clock=null,elapsed=0,cachedKey='',samples=[],art=fallback,painted=false,frame=null;
  const canopyBound=Math.max(...BANKS.map(([lon,lat,width,height])=>Math.abs(lon+115)+width/2+.55+Math.abs(lat-38)+height/2+.18))*RAD;
  let banksReady=false,pendingBanks=null,bankGeneration=0;
  function loadBanks(){
    if(!alive||!read||banksReady)return Promise.resolve();
    if(pendingBanks)return pendingBanks;
    const generation=bankGeneration,promise=read('generated/cloud-banks.png').then(image=>{
      if(!alive||generation!==bankGeneration)return;
      if(image.width!==192||image.height!==64)throw Error('Cloud bank dimensions mismatch');
      art=[0,1,2].map(bank=>{const out=new Uint8ClampedArray(BW*BH*4);for(let y=0;y<BH;y++)out.set(image.data.subarray((y*192+bank*64)*4,(y*192+bank*64+64)*4),y*BW*4);return out;});
      banksReady=true;cachedKey='';
    }).finally(()=>{if(pendingBanks===promise)pendingBanks=null;});
    pendingBanks=promise;return promise;
  }
  void loadBanks().catch(error=>{if(alive&&bankGeneration===0)onError(error);});

  const reduced=()=>Boolean(media?.matches||getReducedMotion());
  function draw(time,force=false){
    if(!alive)return false;
    if(globalThis.document?.hidden){clock=null;return false;}
    if(clock!==null&&requested&&!reduced())elapsed+=Math.max(0,Math.min(time-clock,100));
    clock=time;
    const moving=requested&&!reduced(),key=moving?Math.floor(elapsed/50):'static';
    if(!force&&((!moving&&key===cachedKey)||time-last<50))return false;
    const cam=getCamera(),radius=getRadius(),origin=getCenter(),center=project(-115*RAD,38*RAD,cam),extent=radius*canopyBound+10;
    if(center.z+canopyBound<=.12||origin.x+center.x*radius+extent<0||origin.x+center.x*radius-extent>canvas.width||origin.y+center.y*radius+extent<0||origin.y+center.y*radius-extent>canvas.height){if(painted)ctx.clearRect(0,0,canvas.width,canvas.height);painted=false;return false;}
    last=time;
    if(key!==cachedKey){samples=cloudSamples(elapsed,moving,art);cachedKey=key;}
    const width=canvas.width,height=canvas.height;
    if(!frame||frame.width!==width||frame.height!==height)frame=ctx.createImageData(width,height);
    const data=frame.data,alpha=cloudOpacity(radius,getCssScale());
    data.fill(0);
    for(const layer of [0,1])for(const point of samples){
      const p=project(point.lon,point.lat,cam);if(p.z<=.12)continue;
      const cx=origin.x+p.x*radius,cy=origin.y+p.y*radius+(layer===0?2:-Math.min(9,3+radius/500)),size=Math.max(1,Math.ceil(radius*RAD*point.step));
      if(cx+size<0||cy+size<0||cx-size>=width||cy-size>=height)continue;
      for(let y=Math.max(0,Math.floor(cy-size/2));y<Math.min(height,Math.ceil(cy+size/2));y++)for(let x=Math.max(0,Math.floor(cx-size/2));x<Math.min(width,Math.ceil(cx+size/2));x++){
        if((x-origin.x)**2+(y-origin.y)**2>radius*radius)continue;
        const i=(y*width+x)*4,a=Math.round(alpha*point.strength*(layer===0?.28:1));if(a<=data[i+3])continue;
        const color=layer===0?[74,47,88]:point.color;
        data[i]=color[0];data[i+1]=color[1];data[i+2]=color[2];data[i+3]=a;
      }
    }
    // One opaque-alpha buffer caps overlapping wisps instead of accumulating opacity.
    ctx.putImageData(frame,0,0);painted=true;return true;
  }
  return {draw,retry(){const generation=++bankGeneration;pendingBanks=null;return loadBanks().catch(error=>{if(alive&&generation===bankGeneration)onError(error);throw error;});},dispose(){alive=false;art=[];samples=[];frame=null;ctx.clearRect(0,0,canvas.width,canvas.height);},setMotion(value){requested=Boolean(value);cachedKey='';},get motion(){return requested&&!reduced();}};
}
