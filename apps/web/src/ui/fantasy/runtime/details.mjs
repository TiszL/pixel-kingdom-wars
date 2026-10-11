import {ARCHIPELAGOS} from './world.mjs';
import {locateIsland,ISLAND_ATLAS} from './island-shapes.mjs';
import {sampleOceanColor} from './ocean-detail.mjs';
import {GEOGRAPHY_WIDTH} from './geography.mjs';

export const REGIONAL_DETAILS=Object.freeze([
  {id:'heartlands',regions:[0,1,2,3],west:-92,east:99,south:-63,north:83,width:2048,height:1536},
  {id:'solana',regions:[4],west:-142,east:-88,south:16,north:60,width:2048,height:2048},
  {id:'stormcairn',regions:[5],west:115,east:200,south:-22,north:65,width:1536,height:1536},
  {id:'thornwake',regions:[6],west:-170,east:-115,south:-46,north:12,width:1536,height:1536},
  {id:'cinderfall',regions:[7],west:-182,east:-123,south:-72,north:-41,width:2048,height:1152},
].map(source=>Object.freeze({...source,filterScale:GEOGRAPHY_WIDTH/360*Math.max((source.east-source.west)/source.width,(source.north-source.south)/source.height)})));
const RAD=Math.PI/180,TAU=Math.PI*2;
const SOURCE_BY_REGION=Array.from({length:8},(_,region)=>REGIONAL_DETAILS.find(source=>source.regions.includes(region)));
export function regionalDetailAt(lon,lat,region,out={},subpixel=false){
  const source=SOURCE_BY_REGION[region];if(!source)return null;
  let longitude=((lon+Math.PI)%TAU+TAU)%TAU/RAD-180;
  longitude+=Math.round(((source.west+source.east)/2-longitude)/360)*360;
  const latitude=lat/RAD;
  if(longitude<source.west||longitude>=source.east||latitude<source.south||latitude>=source.north)return null;
  out.source=source;
  const u=(longitude-source.west)/(source.east-source.west)*source.width,v=(source.north-latitude)/(source.north-source.south)*source.height;
  out.x=Math.min(source.width-1,Math.max(0,Math.floor(u)));
  out.y=Math.min(source.height-1,Math.max(0,Math.floor(v)));
  if(subpixel){out.u=Math.max(0,Math.min(source.width-1,u-.5));out.v=Math.max(0,Math.min(source.height-1,v-.5));}
  return out;
}

/** Each mounted globe owns its pixels. Closing/reopening the world cannot revive
 * a stale decode, and an island visit does not decode all seven atlases. */
export function createDetailCache({read,invalidate,onStatus=()=>{}}){
  const regions=new Map(),islands=new Map(),pending=new Map(),failed=new Map(),visible=new Set();
  let alive=true,clock=0,generation=0,collecting=false,lastPending=false,lastError=null;
  const requireVisible=key=>{if(collecting&&!visible.has(key))visible.add(key);};
  function finishFrame(){
    collecting=false;let pending=false,error=null;
    for(const key of visible){
      if(failed.has(key)){error??=failed.get(key);}
      else if(!regions.has(key)&&!islands.has(key))pending=true;
    }
    if(pending!==lastPending||error!==lastError){lastPending=pending;lastError=error;onStatus({pending,error});}
  }
  const regionalPoint={};
  function request(key,load,target,limit){
    if(!alive||target.has(key)||pending.has(key)||failed.has(key))return;
    const current=generation;
    const promise=load().then(value=>{
      if(!alive||current!==generation)return;
      if(target.size>=limit){const oldest=[...target].sort((a,b)=>a[1].used-b[1].used)[0];target.delete(oldest[0]);}
      target.set(key,{...value,used:++clock});invalidate();
    }).catch(error=>{if(alive&&current===generation){failed.set(key,error instanceof Error?error:Error('Terrain could not load'));invalidate();}}).finally(()=>{if(pending.get(key)===promise)pending.delete(key);});
    pending.set(key,promise);
  }
  function regionColor(lon,lat,region,footprint,out=[]){
    if(footprint<=.8)return null;
    const mix=Math.max(0,Math.min(1,footprint*(SOURCE_BY_REGION[region]?.filterScale??0)-1));
    const p=regionalDetailAt(lon,lat,region,regionalPoint,mix>0);if(!p)return null;
    requireVisible(p.source.id);
    const entry=regions.get(p.source.id);
    if(!entry){
      if(!pending.has(p.source.id)&&!failed.has(p.source.id)){
        // Capture the source before the shared coordinate scratch is reused.
        const source=p.source;request(source.id,()=>read(`generated/${source.id}-detail.png`),regions,5);
      }
      return null;
    }
    entry.used=++clock;const i=(p.y*p.source.width+p.x)*4;
    if(mix===0){out[0]=entry.data[i];out[1]=entry.data[i+1];out[2]=entry.data[i+2];return out;}
    // Only magnified RGB is interpolated. The frozen region/deed/coast masks,
    // legacy nearest indices and all picking remain unchanged. Reuse scratch.
    const x=Math.floor(p.u),y=Math.floor(p.v),fx=p.u-x,fy=p.v-y,w=p.source.width;
    const a=(y*w+x)*4,b=(y*w+Math.min(w-1,x+1))*4,c=(Math.min(p.source.height-1,y+1)*w+x)*4,d=c+b-a;
    for(let channel=0;channel<3;channel++){
      const top=entry.data[a+channel]*(1-fx)+entry.data[b+channel]*fx;
      const bottom=entry.data[c+channel]*(1-fx)+entry.data[d+channel]*fx;
      out[channel]=entry.data[i+channel]*(1-mix)+(top*(1-fy)+bottom*fy)*mix;
    }
    return out;
  }
  function island(lon,lat,coarseExploration=0){
    const p=locateIsland(lon,lat,ARCHIPELAGOS);
    if(!p)return coarseExploration?{visibleLand:false,deedEligible:false,region:-1,explorationId:null,featureId:null,color:sampleOceanColor(lon,lat)}:null;
    const chain=ARCHIPELAGOS[p.chainIndex],entry=islands.get(chain.id);
    requireVisible(chain.id);
    if(!entry){
      request(chain.id,async()=>{
        const [color,mask]=await Promise.all([read(`generated/${chain.id}-detail.png`),read(`generated/${chain.id}-detail-mask.png`)]);
        if(color.width!==ISLAND_ATLAS||color.height!==ISLAND_ATLAS||mask.width!==ISLAND_ATLAS||mask.height!==ISLAND_ATLAS)throw Error('Island detail dimensions mismatch');
        for(let i=0;i<mask.data.length;i+=4)if(mask.data[i]>1||mask.data[i+1]>chain.islands.length)throw Error('Island detail mask invalid');
        return {color:color.data,mask:mask.data};
      },islands,3);return null;
    }
    entry.used=++clock;const i=(p.atlasY*ISLAND_ATLAS+p.atlasX)*4;
    return {...p,visibleLand:entry.mask[i]===1,color:[entry.color[i],entry.color[i+1],entry.color[i+2]]};
  }
  // Only draw samples own the displayed status. Picking may request an island
  // before a repaint, but cannot add an offscreen dependency to that frame.
  return {beginFrame(){visible.clear();collecting=true;},finishFrame,regionColor,island,retry(){generation++;pending.clear();failed.clear();invalidate();},stats(){return {regions:regions.size,islands:islands.size,pending:pending.size};},dispose(){alive=false;regions.clear();islands.clear();pending.clear();failed.clear();visible.clear();collecting=false;}};
}
