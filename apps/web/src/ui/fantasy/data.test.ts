import { describe, expect, it } from 'vitest';
import { GLOBE } from '@shardkeep/shared';
import { FANTASY_CATALOG_HASH, getFantasyTile, fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { fantasyViewportRects, validateFantasyGlobe, validateFantasyParcel, validateFantasyViewport, fantasyPath } from './data';

it('includes every visible polar deed when the latitude extremum lies inside the portrait viewport',()=>{
 const viewport={width:271,height:588,centerX:135.5,centerY:235.2},rad=Math.PI/180;
 for(const longitude of [0,179,-179]){
  const view={lon:longitude,lat:80,zoom:5},rects=fantasyViewportRects(view,viewport);
  const radius=176*view.zoom*Math.min(viewport.width,viewport.height)/400,c=Math.cos(view.lat*rad),s=Math.sin(view.lat*rad);
  let visible=0;
  for(const tile of fantasyTiles()){
   const lat=tile.lat*rad,delta=(tile.lon-view.lon)*rad;
   const x=viewport.centerX+radius*Math.cos(lat)*Math.sin(delta);
   const y=viewport.centerY-radius*(Math.sin(lat)*c-Math.cos(lat)*Math.cos(delta)*s);
   const z=Math.sin(lat)*s+Math.cos(lat)*Math.cos(delta)*c;
   if(z<=0||x<0||x>=viewport.width||y<0||y>=viewport.height)continue;
   visible++;
   const col=tile.tileId%720,row=Math.floor(tile.tileId/720);
   expect(rects.some(r=>col>=r.x0&&col<=r.x1&&row>=r.y0&&row<=r.y1),`visible tile ${tile.tileId} at camera ${longitude}`).toBe(true);
  }
  expect(visible).toBeGreaterThan(212);
  expect(rects.every(r=>(r.x1-r.x0+1)*(r.y1-r.y0+1)<=4096)).toBe(true);
 }
});

it('owner reads cover the full rectangular camera including space beyond its safe focus center',()=>{
 for(const [width,height]of [[505,316],[271,588],[588,271]] as const)for(const lon of [26,179,-179]){
  const viewport={width,height,centerX:width*.38,centerY:height*.52},view={lon,lat:23,zoom:8};
  const rects=fantasyViewportRects(view,viewport),rad=Math.PI/180,radius=176*view.zoom*Math.min(width,height)/400;
  for(let iy=0;iy<=8;iy++)for(let ix=0;ix<=8;ix++){
   const x=(ix*width/8-viewport.centerX)/radius,y=(viewport.centerY-iy*height/8)/radius,z=Math.sqrt(1-x*x-y*y);
   if(!Number.isFinite(z))continue;
   const latitude=Math.asin(y*Math.cos(view.lat*rad)+z*Math.sin(view.lat*rad))/rad;
   const longitude=view.lon+Math.atan2(x,z*Math.cos(view.lat*rad)-y*Math.sin(view.lat*rad))/rad;
   const cellX=((Math.floor((longitude+180)*2)%720)+720)%720,cellY=Math.max(0,Math.min(359,Math.floor((90-latitude)*2)));
   expect(rects.some(r=>cellX>=r.x0&&cellX<=r.x1&&cellY>=r.y0&&cellY<=r.y1)).toBe(true);
  }
  expect(rects.every(r=>(r.x1-r.x0+1)*(r.y1-r.y0+1)<=4096)).toBe(true);
 }
});

const tile=[...fantasyTiles('crownlands')][300]!;
const directory={worldId:'fantasy-v1' as const,catalogHash:FANTASY_CATALOG_HASH,ready:true,realms:[],me:{baseId:null,selectedTileId:null,ownedTiles:[]}};
describe('fantasy transport identity and bounds',()=>{
 it('does not reinterpret an older world or catalog as this fantasy lattice',()=>{
  expect(validateFantasyGlobe(directory)).toBe(directory);
  expect(()=>validateFantasyGlobe({...directory,catalogHash:'old'})).toThrow('update required');
  expect(()=>validateFantasyGlobe({...directory,ready:false})).toThrow('update required');
 });
 it('rejects a parcel response for a different tile, realm or reserved allocation',()=>{
  const data={worldId:'fantasy-v1' as const,tile,availability:'available' as const,detail:null};
  expect(validateFantasyParcel(data,tile.tileId).tile).toEqual(tile);
  expect(()=>validateFantasyParcel(data,tile.tileId+1)).toThrow('address mismatch');
  expect(()=>validateFantasyParcel({...data,tile:{...tile,allocation:'genesis'}},tile.tileId)).toThrow('address mismatch');
 });
 it('keeps selected-base requests explicit while changing only the world route',()=>{
  expect(fantasyPath('/globe/fantasy','base / 1')).toBe('/globe/fantasy?baseId=base%20%2F%201');
  expect(fantasyPath('/globe/fantasy?x0=1','x')).toBe('/globe/fantasy?x0=1&baseId=x');
 });
 it('never fetches the whole world as individual owner markers',()=>{
  expect(fantasyViewportRects({lon:0,lat:0,zoom:1})).toEqual([]);
 });
 it.each([[-179,0], [179,0],[179,70],[-179,-70],[26,23],[-115,38]])('splits wrapped camera %i/%i into bounded disjoint reads',(lon,lat)=>{
  const rects=fantasyViewportRects({lon,lat,zoom:5}),seen=new Set<number>();
  expect(rects.length).toBeGreaterThan(0);
  for(const r of rects){
   expect(r.x0).toBeGreaterThanOrEqual(0);expect(r.x1).toBeLessThan(720);expect(r.y0).toBeGreaterThanOrEqual(0);expect(r.y1).toBeLessThan(360);
   expect((r.x1-r.x0+1)*(r.y1-r.y0+1)).toBeLessThanOrEqual(GLOBE.parcelViewportMaxCells);
   for(let y=r.y0;y<=r.y1;y++)for(let x=r.x0;x<=r.x1;x++){const id=y*720+x;expect(seen.has(id)).toBe(false);seen.add(id);}
  }
 });
 // K-188 (rewritten in place): D-181 `shielded` now survives as a boolean, because a dropped
 // dome shows a shielded rival as open to attack. Wallet, loot and off-route avatar URLs are
 // still stripped, and a non-boolean shield is dropped rather than guessed.
 it('refuses a mismatched viewport, keeps a boolean shield, and strips unapproved bulk fields and avatar URLs',()=>{
  const x=tile.tileId%720,y=Math.floor(tile.tileId/720),scope={x0:x,x1:x,y0:y,y1:y};
  const response={worldId:'fantasy-v1' as const,scope,matched:1,truncated:false,markers:[{tileId:tile.tileId,name:'Keeper',keepLevel:12,avatarUrl:'https://tracking.invalid/owner',shielded:true,wallet:'private-wallet',loot:'999'}]};
  const result=validateFantasyViewport(response,scope);
  expect(result.markers).toEqual([{tileId:tile.tileId,name:'Keeper',keepLevel:12,avatarUrl:null,shielded:true}]);
  const guessed=validateFantasyViewport({...response,markers:[{...response.markers[0]!,shielded:'yes' as unknown as boolean}]},scope);
  expect(guessed.markers[0]).not.toHaveProperty('shielded');
  expect(()=>validateFantasyViewport(response,{...scope,x1:x+1})).toThrow('scope mismatch');
 });
 it('shared catalogue rejects ocean even when its numeric cell is valid',()=>{
  expect(getFantasyTile(0)).toBeNull();
 });
});
