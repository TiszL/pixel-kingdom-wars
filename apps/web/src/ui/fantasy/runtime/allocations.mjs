import {GENESIS_RUNS,SEEKER_RUNS} from './allocation-membership.mjs';
import {cellAt,STEP,COLS} from './tile-geometry.mjs';
export const GENESIS_CELLS=new Set(GENESIS_RUNS.flatMap(([a,b])=>Array.from({length:b-a+1},(_,i)=>a+i)));
export const SEEKER_CELLS=new Set(SEEKER_RUNS.flatMap(([a,b])=>Array.from({length:b-a+1},(_,i)=>a+i)));
export function allocationAt(lon,lat){const c=cellAt(lon,lat);return GENESIS_CELLS.has(c)?'genesis':SEEKER_CELLS.has(c)?'seeker':null;}
const perimeter=[];
for(const c of GENESIS_CELLS){const x=c%COLS,y=Math.floor(c/COLS),lon=-Math.PI+x*STEP,lat=Math.PI/2-y*STEP;
  for(const [n,a,b]of [[c-720,[lon,lat],[lon+STEP,lat]],[c+720,[lon,lat-STEP],[lon+STEP,lat-STEP]],[c-1,[lon,lat],[lon,lat-STEP]],[c+1,[lon+STEP,lat],[lon+STEP,lat-STEP]]])if(!GENESIS_CELLS.has(n))perimeter.push({from:{lon:a[0],lat:a[1]},to:{lon:b[0],lat:b[1]}});
}
export const SANCTUARY={id:'genesis-sanctuary',name:'Genesis Sanctuary',lon:-115,lat:38,count:2000,perimeter,landmark:{lon:-115,lat:38}};
export function allocationLabel(allocation){return allocation==='genesis'?'Genesis owner award allocation':allocation==='seeker'?'Reserved for Seeker owners':'Outside reserved allocation';}
