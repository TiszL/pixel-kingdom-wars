import { useCallback, useEffect, useMemo, useState } from 'react';
import { GLOBE, WORLD } from '@shardkeep/shared';
import { FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, getFantasyTile, type FantasyTile } from '@shardkeep/shared/fantasyWorld';
import { api } from '../../lib/api';
import type { ParcelDetail } from '../screens/globe/parcelDetail';
import type { WarzoneStatusDto } from '../screens/warzoneStatus';
import type { FantasyView, FantasyWorldMarker } from './types';
import { realmFeedScope, useSettledRealmScope } from './realmFeed';

export interface FantasyOwnedTile extends FantasyWorldMarker {
  baseId: string; realmId: string; active: boolean; selected: boolean;
}
export interface FantasyGlobeData {
  worldId: typeof FANTASY_WORLD_ID; catalogHash: string; ready: boolean;
  realms: Array<{realmId:string;total:number;occupied:number;held:number;available:number;anchorTileId:number|null}>;
  warzone?: WarzoneStatusDto;
  me: {baseId:string|null;selectedTileId:number|null;ownedTiles:FantasyOwnedTile[]};
}
export interface FantasyParcelData {
  worldId: typeof FANTASY_WORLD_ID;
  tile: FantasyTile;
  availability: 'available'|'held'|'occupied'|'reserved';
  detail: Omit<ParcelDetail,'parcel'> | null;
}
export interface FantasyRect {x0:number;y0:number;x1:number;y1:number}
export interface FantasyViewportData {
  worldId:typeof FANTASY_WORLD_ID; scope:FantasyRect;
  markers:FantasyWorldMarker[]; matched:number; truncated:boolean;
}
export interface FantasyAuthority {key:string;wallet:string|null;baseId:string|null}
export function fantasyPath(path:string,baseId:string|null):string {
  return baseId?`${path}${path.includes('?')?'&':'?'}baseId=${encodeURIComponent(baseId)}`:path;
}

export function validateFantasyGlobe(data:FantasyGlobeData):FantasyGlobeData {
  if(data.worldId!==FANTASY_WORLD_ID||data.catalogHash!==FANTASY_CATALOG_HASH||!data.ready)throw Error('World catalog update required');
  if(!Array.isArray(data.realms)||!Array.isArray(data.me?.ownedTiles))throw Error('Invalid world directory');
  for(const owner of data.me.ownedTiles)if(!getFantasyTile(owner.tileId))throw Error('Unknown owned land address');
  return data;
}
export function validateFantasyParcel(data:FantasyParcelData,tileId:number):FantasyParcelData {
  const tile=getFantasyTile(tileId);
  if(!tile||data.worldId!==FANTASY_WORLD_ID||data.tile?.worldId!==FANTASY_WORLD_ID||data.tile.tileId!==tileId||data.tile.realmId!==tile.realmId||data.tile.allocation!==tile.allocation)throw Error('Parcel address mismatch');
  return data;
}
export function validateFantasyViewport(data:FantasyViewportData,rect:FantasyRect):FantasyViewportData {
  if(data.worldId!==FANTASY_WORLD_ID||!data.scope||Object.keys(rect).some(k=>data.scope[k as keyof FantasyRect]!==rect[k as keyof FantasyRect])||!Array.isArray(data.markers))throw Error('Globe parcel scope mismatch');
  const markers=data.markers.filter(marker=>{
    if(!getFantasyTile(marker.tileId)||typeof marker.name!=='string'||marker.name.length>160||!Number.isInteger(marker.keepLevel))return false;
    const x=marker.tileId%720,y=Math.floor(marker.tileId/720);
    return x>=rect.x0&&x<=rect.x1&&y>=rect.y0&&y<=rect.y1;
  }).map(marker=>({tileId:marker.tileId,name:marker.name,keepLevel:marker.keepLevel!,
    avatarUrl:typeof marker.avatarUrl==='string'&&/^\/api\/avatars\/[0-9a-f-]{36}\.webp$/.test(marker.avatarUrl)?marker.avatarUrl:null,
    // K-188/D-181: the server's effective shield. Kept only as a boolean and left absent
    // when the read did not carry it, so a dome or Shielded chip is never faked.
    ...(typeof marker.shielded==='boolean'?{shielded:marker.shielded}:{})}));
  return {...data,markers,matched:Math.max(markers.length,Number.isSafeInteger(data.matched)?data.matched:markers.length),truncated:data.truncated===true};
}

/** Visible ground box of a World v2 realm-map camera (D-186), in degrees. Longitudes are
 * continuous around the view (west below −180 or east above 180 across the seam). */
export interface FantasyViewBounds {west:number;east:number;south:number;north:number}
export interface FantasyViewport {width:number;height:number;centerX?:number;centerY?:number;bounds?:FantasyViewBounds|null}
const usableBounds=(b:FantasyViewBounds|null|undefined):b is FantasyViewBounds=>!!b&&[b.west,b.east,b.south,b.north].every(Number.isFinite)&&b.west<=b.east&&b.south<=b.north;

/** Same sphere inverse as the raster, sampled along the visible rectangle.
 * Split wrapping longitudes before issuing ordinary indexed, bounded reads.
 * A World v2 realm-map camera is not this sphere, so it passes its own visible box
 * (`bounds`) instead; the D-042 quantum, side and seam limits apply unchanged. */
export function fantasyViewportRects(view:FantasyView,viewport:FantasyViewport={width:400,height:400}):FantasyRect[] {
  if(view.zoom<5)return [];
  let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
  if(usableBounds(viewport.bounds)){({west,east}=viewport.bounds);south=Math.max(-90,viewport.bounds.south);north=Math.min(90,viewport.bounds.north);}
  else{
  const centerX=viewport.centerX??viewport.width/2,centerY=viewport.centerY??viewport.height/2;
  const rad=Math.PI/180,radius=176*view.zoom*Math.min(viewport.width,viewport.height)/400,c=Math.cos(view.lat*rad),s=Math.sin(view.lat*rad);
  for(let edge=0;edge<4;edge++)for(let n=0;n<=32;n++){
    const x=((edge<2?n*viewport.width/32:edge===2?0:viewport.width)-centerX)/radius;
    const y=-((edge>=2?n*viewport.height/32:edge===0?0:viewport.height)-centerY)/radius;
    const r2=x*x+y*y;if(r2>1)continue;
    const z=Math.sqrt(1-r2),lat=Math.asin(Math.max(-1,Math.min(1,y*c+z*s)))/rad,lon=view.lon+Math.atan2(x,z*c-y*s)/rad;
    west=Math.min(west,lon);east=Math.max(east,lon);south=Math.min(south,lat);north=Math.max(north,lat);
  }
  // Latitude reaches its extremum inside the viewport when a pole is visible.
  // Its cap spans every longitude; edge samples alone omit nearby deed rows.
  for(const pole of [1,-1]){
    const poleY=centerY-pole*radius*c;
    if(pole*s>0&&centerX>=0&&centerX<=viewport.width&&poleY>=0&&poleY<=viewport.height){
      if(pole>0)north=90;else south=-90;
      west=view.lon-180;east=view.lon+180;
    }
  }
  }
  if(!Number.isFinite(west))return [];
  const q=GLOBE.parcelViewportQuantumCells;
  const x0=Math.floor((Math.floor((west+180)*2)-2)/q)*q,x1=Math.ceil((Math.floor((east+180)*2)+3)/q)*q-1;
  const y0=Math.max(0,Math.floor((Math.floor((90-north)*2)-2)/q)*q),y1=Math.min(359,Math.ceil((Math.floor((90-south)*2)+3)/q)*q-1);
  const columns=new Set<number>();for(let x=x0;x<=Math.min(x1,x0+719);x++)columns.add((x%720+720)%720);
  const sorted=[...columns].sort((a,b)=>a-b),ranges:Array<[number,number]>=[];
  for(const x of sorted){const last=ranges.at(-1);if(last&&x===last[1]+1)last[1]=x;else ranges.push([x,x]);}
  const maxSide=Math.floor(Math.sqrt(GLOBE.parcelViewportMaxCells)),rects:FantasyRect[]=[];
  for(const [left,right]of ranges)for(let y=y0;y<=y1;y+=maxSide)for(let x=left;x<=right;x+=maxSide)rects.push({x0:x,y0:y,x1:Math.min(right,x+maxSide-1),y1:Math.min(y1,y+maxSide-1)});
  return rects;
}

/** An identity fence is checked during render, before effects can clear the
 * previous viewer's private response. Hidden tabs do not poll or launch reads. */
export function useFantasyRead<T>(key:string|null,load:(isCurrent:()=>boolean)=>Promise<T>,pollMs:number) {
  const [attempt,setAttempt]=useState(0);
  const [state,setState]=useState<{key:string|null;data:T|null;error:Error|null;pending:boolean}>({key:null,data:null,error:null,pending:false});
  useEffect(()=>{
    if(key===null)return undefined;
    let alive=true,running=false,timer:ReturnType<typeof setTimeout>|undefined;
    const run=():void=>{
      if(!alive||running||document.hidden)return;
      running=true;
      setState(old=>({key,data:old.key===key?old.data:null,error:null,pending:old.key!==key||old.data===null}));
      void load(()=>alive).then(data=>{if(alive)setState({key,data,error:null,pending:false});})
        .catch((cause:unknown)=>{if(alive)setState(old=>({key,data:old.key===key?old.data:null,error:cause instanceof Error?cause:new Error('World read failed'),pending:false}));})
        .finally(()=>{running=false;if(alive)timer=setTimeout(run,pollMs);});
    };
    const visible=():void=>{if(!document.hidden){clearTimeout(timer);run();}};
    run();document.addEventListener('visibilitychange',visible);
    return()=>{alive=false;clearTimeout(timer);document.removeEventListener('visibilitychange',visible);};
    // The key includes all request arguments; fresh closures follow that key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[key,attempt,pollMs]);
  const retry=useCallback(()=>setAttempt(n=>n+1),[]);
  return state.key===key&&key!==null?{...state,retry}:{key,data:null,error:null,pending:key!==null,retry};
}
export function useFantasyDirectory(authority:FantasyAuthority){
  return useFantasyRead(authority.wallet?`${authority.key}:world`:null,async()=>validateFantasyGlobe(await api.get<FantasyGlobeData>(fantasyPath('/globe/fantasy',authority.baseId))),GLOBE.cacheSec*1000);
}
export function useFantasyParcel(authority:FantasyAuthority,tileId:number|null){
  return useFantasyRead(authority.wallet&&tileId!==null?`${authority.key}:tile:${tileId}`:null,async()=>validateFantasyParcel(await api.get<FantasyParcelData>(fantasyPath(`/globe/fantasy/parcels/${tileId}`,authority.baseId)),tileId!),Math.min(GLOBE.cacheSec,WORLD.mapPollSec)*1000);
}
export function useFantasyViewport(authority:FantasyAuthority,view:FantasyView,enabled:boolean,viewport:FantasyViewport={width:400,height:400}){
  const {width,height}=viewport,centerX=viewport.centerX??width/2,centerY=viewport.centerY??height/2;
  const box=usableBounds(viewport.bounds)?viewport.bounds:null,{west,east,south,north}=box??{west:NaN,east:NaN,south:NaN,north:NaN};
  const bounds=useMemo(()=>Number.isNaN(west)?null:{west,east,south,north},[west,east,south,north]);
  const rects=useMemo(()=>fantasyViewportRects(view,{width,height,centerX,centerY,bounds}),[view,width,height,centerX,centerY,bounds]);
  // A realm-map box can hold a whole realm: settled, nearest-first and capped (realmFeed.ts).
  const realm=useSettledRealmScope(useMemo(()=>bounds&&rects.length?realmFeedScope(rects,bounds):null,[rects,bounds]));
  const reads=bounds?realm?.rects??[]:rects,cut=bounds?realm?.truncated??false:false;
  const scope=JSON.stringify(reads);
  return useFantasyRead(authority.wallet&&enabled&&reads.length?`${authority.key}:viewport:${scope}${cut?':cut':''}`:null,async(isCurrent)=>{
    const merged=new Map<number,FantasyWorldMarker>();let matched=0,truncated=cut;
    for(const rect of reads){
      if(!isCurrent())throw Error('World viewport changed');
      const params=new URLSearchParams({...Object.fromEntries(Object.entries(rect).map(([k,v])=>[k,String(v)])),cx:view.lon.toFixed(3),cy:view.lat.toFixed(3)});
      const data=validateFantasyViewport(await api.get<FantasyViewportData>(fantasyPath(`/globe/fantasy/parcels?${params}`,authority.baseId)),rect);
      for(const marker of data.markers)merged.set(marker.tileId,marker);
      matched+=data.matched;truncated ||= data.truncated;
    }
    return {markers:[...merged.values()],matched,truncated};
  },WORLD.mapPollSec*1000);
}

export interface FantasySearchResult extends FantasyWorldMarker {
  realmId:string; trophies:number; seeker:boolean;
}
export function useFantasySearch(authority:FantasyAuthority,query:string){
  const term=query.trim(),[debounced,setDebounced]=useState('');
  useEffect(()=>{const timer=setTimeout(()=>setDebounced(term),250);return()=>clearTimeout(timer);},[term]);
  return useFantasyRead(authority.wallet&&term.length>=2&&term===debounced?`${authority.key}:search:${term}`:null,async()=>{
    const data=await api.get<{results:FantasySearchResult[]}>(`/globe/fantasy/search?q=${encodeURIComponent(term)}`);
    if(!Array.isArray(data.results))throw Error('Invalid owner search');
    return data.results.filter(result=>{const tile=getFantasyTile(result.tileId);return tile&&tile.realmId===result.realmId&&typeof result.name==='string'&&Number.isInteger(result.keepLevel)&&Number.isInteger(result.trophies);});
  },WORLD.mapPollSec*1000);
}
