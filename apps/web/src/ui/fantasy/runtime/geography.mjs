import {GEOGRAPHY_RUNS} from './geography/frozen-runs.mjs';

// Frozen display geography, independent of terrain art and procedural height.
// Pixel codes retain region + visible/deed/exploration surface channels together.
export const GEOGRAPHY_WIDTH=768,GEOGRAPHY_HEIGHT=384;
export const CONTINENTS=[
  {id:'heartlands',region:null,lon:26,lat:23},
  {id:'seeker-reach',region:4,lon:-115,lat:38},
  {id:'stormcairn',region:5,lon:157.3,lat:23.8},
  {id:'thornwake',region:6,lon:-142.2,lat:-17.8},
  {id:'cinderfall',region:7,lon:-152.4,lat:-57.3},
];
const pixels=new Uint16Array(GEOGRAPHY_WIDTH*GEOGRAPHY_HEIGHT);
let offset=0;for(const [length,code]of GEOGRAPHY_RUNS){pixels.fill(code,offset,offset+length);offset+=length;}
if(offset!==pixels.length)throw Error('Incomplete frozen geography');
const TAU=Math.PI*2,RAD=Math.PI/180;
export function geographyIndex(lon,lat){
  // Keep the existing renderer's operation order: exact boundary addresses
  // depend on its floating-point wrap, not an algebraic simplification.
  const wrapped=((lon+Math.PI)%TAU+TAU)%TAU-Math.PI;
  const x=((Math.floor((wrapped+Math.PI)/TAU*GEOGRAPHY_WIDTH)%GEOGRAPHY_WIDTH)+GEOGRAPHY_WIDTH)%GEOGRAPHY_WIDTH;
  const y=Math.max(0,Math.min(GEOGRAPHY_HEIGHT-1,Math.floor((Math.PI/2-lat)/Math.PI*GEOGRAPHY_HEIGHT)));
  return y*GEOGRAPHY_WIDTH+x;
}
export function frozenSurfaceAt(lon,lat){
  const code=pixels[geographyIndex(lon,lat)],explorationIndex=code>>6;
  return {region:(code&15)-1,visibleLand:!!(code&16),deedEligible:!!(code&32),explorationIndex};
}
export const frozenRegionAt=(lon,lat)=>frozenSurfaceAt(lon,lat).region;

// Analytic fallback has subpixel coastlines; a frozen sea pixel cannot rename a
// nearby analytic coastal sliver. Only the three verified offshore envelopes
// may change its legacy realm. Browser parcels always use frozenSurfaceAt.
export function offshoreRegionAt(lon,lat,legacyRegion){
  const frozen=frozenSurfaceAt(lon,lat);
  if(frozen.deedEligible)return frozen.region>=5?frozen.region:legacyRegion;
  const x=((lon/RAD+180)%360+360)%360-180,y=lat/RAD;
  if((x>115||x<-159)&&y>-22&&y<66)return 5;
  if(x>-171&&x<-114&&y>-44&&y<12)return 6;
  if((x<-122||x>177)&&y>-72&&y<-43)return 7;
  return legacyRegion;
}
