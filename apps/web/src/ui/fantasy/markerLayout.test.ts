import { describe, expect, it } from 'vitest';
import { fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { layoutWorldMarkers, type MarkerGroup, type ProjectedMarker } from './markerLayout';
const RAD=Math.PI/180;
const project=(lon:number,lat:number,cam:{lon:number;lat:number})=>({
 x:Math.cos(lat)*Math.sin(lon-cam.lon),
 y:Math.sin(lat)*Math.cos(cam.lat)-Math.cos(lat)*Math.cos(lon-cam.lon)*Math.sin(cam.lat),
});

const marker=(tileId:number,x:number,y:number,extra:Partial<ProjectedMarker>={}):ProjectedMarker=>({tileId,x,y,z:1,realmId:'crownlands',name:`Owner ${tileId}`,keepLevel:3,...extra});
function noOverlaps(groups:MarkerGroup[]){
  for(let i=0;i<groups.length;i++)for(const b of groups.slice(i+1)){
    const a=groups[i]!;
    expect(Math.abs(a.x-b.x)>=(a.width+b.width)/2||Math.abs(a.y-b.y)>=(a.height+b.height)/2).toBe(true);
  }
}
describe('screen-space deed clusters',()=>{
 it.each([[390,844],[844,390],[1440,900]])('keeps all dense migrated deeds represented without overlapping at %dx%d', (width,height)=>{
   const tiles=[...fantasyTiles('crownlands')].sort((a,b)=>(a.lon-26)**2+(a.lat-23)**2-((b.lon-26)**2+(b.lat-23)**2)||a.tileId-b.tileId).slice(0,75);
   for(const zoom of [5,10,20,40,80,160,256]){
     const points=tiles.map(tile=>{const p=project(tile.lon*RAD,tile.lat*RAD,{lon:26*RAD,lat:23*RAD});return marker(tile.tileId,width/2+p.x*176*zoom,height/2+p.y*176*zoom);});
     const bounds={left:6,top:90,right:width-6,bottom:height-60};
     const visible=points.filter(p=>p.x>=bounds.left&&p.x<=bounds.right&&p.y>=bounds.top&&p.y<=bounds.bottom);
     const groups=layoutWorldMarkers(points,bounds,tiles[0]!.tileId);
     noOverlaps(groups);expect(groups.reduce((n,g)=>n+g.count,0)).toBe(visible.length);
     for(const g of groups){expect(g.x-g.width/2).toBeGreaterThanOrEqual(bounds.left);expect(g.x+g.width/2).toBeLessThanOrEqual(bounds.right);expect(g.y-g.height/2).toBeGreaterThanOrEqual(bounds.top);expect(g.y+g.height/2).toBeLessThanOrEqual(bounds.bottom);}
   }
 });
 it('uses the selected real tile as a readable anchor and ignores server ordering',()=>{
   const points=[marker(3,100,100),marker(1,106,103,{owned:true}),marker(2,101,102,{name:'Selected keeper'})];
   const bounds={left:0,top:0,right:390,bottom:300};
   const groups=layoutWorldMarkers(points,bounds,2);
   expect(groups).toEqual(layoutWorldMarkers([...points].reverse(),bounds,2));
   expect(groups).toHaveLength(1);expect(groups[0]).toMatchObject({marker:{tileId:2,name:'Selected keeper'},count:3,selected:true,width:176,owned:true});
   const panned=layoutWorldMarkers(points.map(p=>({...p,x:p.x+2,y:p.y+2})),bounds,2);
   expect(panned[0]?.marker.tileId).toBe(2);expect(panned[0]?.x).toBe(groups[0]!.x+2);
 });
 it('does not double count owned tiles already included in a realm total',()=>{
   const groups=layoutWorldMarkers([marker(1,100,100,{cluster:{count:75,realmId:'crownlands'}}),marker(2,105,100,{owned:true})],{left:0,top:0,right:400,bottom:400},null);
   expect(groups).toHaveLength(1);expect(groups[0]?.count).toBe(75);
 });
 it('keeps distinct close-up native tile anchors inspectable and never moves source geography',()=>{
   const points=[marker(1,70,100),marker(2,150,100),marker(3,230,100)];const before=structuredClone(points);
   const groups=layoutWorldMarkers(points,{left:0,top:0,right:320,bottom:400},null);
   expect(groups).toHaveLength(3);expect(groups.map(g=>g.marker.tileId)).toEqual([1,2,3]);expect(groups.every(g=>g.count===1)).toBe(true);expect(points).toEqual(before);
 });
 it('shows automatic names only when the parcel and neighbouring touch targets have room',()=>{
   const bounds={left:0,top:0,right:800,bottom:400};
   const large={parcelWidth:220,parcelHeight:80};
   const groups=layoutWorldMarkers([marker(1,100,100,large),marker(2,300,100,{...large,parcelWidth:70}),marker(3,450,100,large),marker(4,530,100,large)],bounds,null);
   expect(groups.map(group=>group.showName)).toEqual([true,false,false,false]);
   expect(groups[0]?.width).toBe(176);noOverlaps(groups);
   expect(groups.flatMap(group=>group.members.map(member=>member.tileId))).toEqual([1,2,3,4]);
 });
 it('excludes rear-hemisphere and off-HUD points and deduplicates a repeated source tile',()=>{
   const groups=layoutWorldMarkers([marker(1,100,100),marker(1,100,100),marker(2,100,100,{z:-1}),marker(3,100,20)],{left:0,top:50,right:400,bottom:400},null);
   expect(groups).toHaveLength(1);expect(groups[0]?.count).toBe(1);
 });
});
