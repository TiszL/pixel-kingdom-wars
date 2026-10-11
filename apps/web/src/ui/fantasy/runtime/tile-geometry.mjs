import {RAD, TAU, clamp, wrap, project} from './world.mjs';

// Approved fantasy display lattice of GLOBE.fineCols/fineRows, not a new gameplay grid.
// Cell membership is supplied by the shared versioned fantasy catalog.
export const COLS=720, ROWS=360, STEP=TAU/COLS;
export function cellAt(lon,lat){
  const x=clamp(Math.floor((wrap(lon)+Math.PI)/STEP),0,COLS-1);
  const y=clamp(Math.floor((Math.PI/2-clamp(lat,-Math.PI/2,Math.PI/2))/STEP),0,ROWS-1);
  return y*COLS+x;
}
export function tileAt(lon,lat){
  const cell=cellAt(lon,lat),x=cell%COLS,y=Math.floor(cell/COLS);
  return {x,y,tileId:y*COLS+x,lon:-Math.PI+(x+.5)*STEP,lat:Math.PI/2-(y+.5)*STEP};
}
export function tilePixels(radius,lat,z=1){return radius*STEP*Math.max(0,Math.cos(lat))*Math.max(0,z);}
export function gridVisible(radius,lat,z=1){return tilePixels(radius,lat,z)>=3;}
// A coastal sliver can be visible inside an otherwise ocean-addressed cell.
// Such a tap still selects its realm, but cannot become a fictional deed parcel.
export function pickLand(lon,lat,sampleRegion,sampleSurface){
  const surface=sampleSurface?.(lon,lat);
  // The displayed close-up coastline owns selection. A coarse island pixel
  // must not open a mainland realm after that pixel resolves into visible sea.
  const region=surface?.visibleLand===false?-1:surface?.region??sampleRegion(lon,lat);
  // Exploration access never confers land ownership, even after future unlock.
  if(surface&&!surface.deedEligible)return {region,tile:null,explorationId:surface.explorationId??null};
  if(region<0)return {region,tile:null};
  const tile=tileAt(lon,lat),centre=sampleSurface?.(tile.lon,tile.lat);
  return {region,tile:(centre?centre.deedEligible:sampleRegion(tile.lon,tile.lat)>=0)?tile:null};
}
