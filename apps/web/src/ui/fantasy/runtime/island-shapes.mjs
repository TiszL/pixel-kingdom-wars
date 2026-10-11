import {COASTLINES} from './generated/island-coastlines.mjs';
// Authored island coastlines share one quantized coordinate system for
// coarse baking, close-up colors and exploration picking.
export const ISLAND_CELL=320, ISLAND_ATLAS=1024, ISLAND_EXTENT=1.12;
const RAD=Math.PI/180,TAU=Math.PI*2;
const wrap=n=>((n+Math.PI)%TAU+TAU)%TAU-Math.PI;
// Conservative 5° bins remove the all-island scan from every sphere pixel.
// Exact wrapping, source coordinates and authored row tests remain unchanged.
const indexes=new WeakMap();
function islandIndex(chains){
  let index=indexes.get(chains);if(index)return index;
  index=new Map();let number=0;
  for(let chainIndex=0;chainIndex<chains.length;chainIndex++){
    const chain=chains[chainIndex];
    for(let slot=0;slot<chain.islands.length;slot++,number++){
      const island=chain.islands[slot],entry={chain,chainIndex,index:slot,number,island};
      const left=Math.floor((island.lon-island.rx*ISLAND_EXTENT+180)/5)-1,right=Math.floor((island.lon+island.rx*ISLAND_EXTENT+180)/5)+1;
      const bottom=Math.floor((island.lat-island.ry*ISLAND_EXTENT+90)/5)-1,top=Math.floor((island.lat+island.ry*ISLAND_EXTENT+90)/5)+1;
      for(let y=Math.max(0,bottom);y<=Math.min(35,top);y++)for(let x=left;x<=right;x++){
        const key=y*72+(x%72+72)%72,list=index.get(key);if(list)list.push(entry);else index.set(key,[entry]);
      }
    }
  }
  indexes.set(chains,index);return index;
}
export function locateIsland(lon,lat,chains){
  const longitude=wrap(lon)/RAD,latitude=lat/RAD;
  const key=Math.min(35,Math.max(0,Math.floor((latitude+90)/5)))*72+Math.min(71,Math.max(0,Math.floor((longitude+180)/5)));
  const candidates=islandIndex(chains).get(key);if(!candidates)return null;
  for(const {chain,chainIndex,index,number,island}of candidates){
    const dx=wrap(lon-island.lon*RAD)/RAD/island.rx,dy=(lat/RAD-island.lat)/island.ry;
    if(Math.abs(dx)>=ISLAND_EXTENT||Math.abs(dy)>=ISLAND_EXTENT)continue;
    const u=Math.floor((dx/ISLAND_EXTENT+1)*ISLAND_CELL/2),v=Math.floor((1-dy/ISLAND_EXTENT)*ISLAND_CELL/2);
    const depth=COASTLINES[number][v].some(([a,b])=>u>=a&&u<=b)?.4:-.1;
    return {chainIndex,index,number,u,v,atlasX:index%3*ISLAND_CELL+u,atlasY:Math.floor(index/3)*ISLAND_CELL+v,visibleLand:depth>=0,deedEligible:false,region:depth>=0?chain.region:-1,explorationId:depth>=0?chain.id:null,featureId:depth>=0?`${chain.id}-${index+1}`:null,depth};
  }
  return null;
}

/** Conservative coarse-pixel coverage of authored patch rectangles. A one-pixel
 * border includes both sides of every floating-point coast/longitude boundary. */
export function islandPatchMask(width,height,chains){
  const pixels=new Uint8Array(width*height);
  for(const chain of chains)for(const island of chain.islands){
    const x0=Math.floor((island.lon-island.rx*ISLAND_EXTENT+180)/360*width)-1,x1=Math.floor((island.lon+island.rx*ISLAND_EXTENT+180)/360*width)+1;
    const y0=Math.floor((90-island.lat-island.ry*ISLAND_EXTENT)/180*height)-1,y1=Math.floor((90-island.lat+island.ry*ISLAND_EXTENT)/180*height)+1;
    for(let y=Math.max(0,y0);y<=Math.min(height-1,y1);y++)for(let x=x0;x<=x1;x++)pixels[y*width+(x%width+width)%width]=1;
  }
  return pixels;
}
