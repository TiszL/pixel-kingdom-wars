import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createDetailCache, regionalDetailAt, REGIONAL_DETAILS } from './runtime/details.mjs';
import { createFantasyRenderer } from './runtime/renderer.mjs';
import { RAD } from './runtime/world.mjs';
import { fantasyTileAt, getFantasyTile } from '@shardkeep/shared/fantasyWorld';

const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
describe('globe scratch and marker caches preserve authoritative inputs',()=>{
 it('reuses coordinate output without changing exact regional sample indices or wrapped longitude',()=>{
  const out={};
  // Interior samples avoid exact pixel boundaries: the accepted floating-point
  // longitude wrap may sit one ULP below a mathematically integral boundary.
  for(const source of REGIONAL_DETAILS)for(const region of source.regions)for(const fraction of [.013,.267,.541,.991]){
   const lon=source.west+(source.east-source.west)*fraction,lat=source.south+(source.north-source.south)*fraction;
   const expected=regionalDetailAt(lon*RAD,lat*RAD,region);
   expect(regionalDetailAt((lon+360)*RAD,lat*RAD,region,out)).toBe(out);
   expect(out).toEqual(expected);
   expect(out.x).toBe(Math.floor(fraction*source.width));
   expect(out.y).toBe(Math.floor((1-fraction)*source.height));
  }
 });
 it('deduplicates pending regional loads, preserves independently owned colors and ignores late teardown',async()=>{
  const pending=new Map(),read=vi.fn(path=>new Promise(resolve=>pending.set(path,resolve))),invalidate=vi.fn(),onStatus=vi.fn();
  const cache=createDetailCache({read,invalidate,onStatus}),out=[];
  cache.beginFrame();
  for(let i=0;i<100;i++)expect(cache.regionColor(26*RAD,23*RAD,3,3,out)).toBeNull();
  expect(cache.regionColor(-115*RAD,38*RAD,4,3,out)).toBeNull();
  cache.finishFrame();expect(onStatus).toHaveBeenLastCalledWith({pending:true,error:null});
  expect(read.mock.calls.map(call=>call[0])).toEqual(['generated/heartlands-detail.png','generated/solana-detail.png']);
  const width=2048,height=1536,data=new Uint8ClampedArray(width*height*4),p=regionalDetailAt(26*RAD,23*RAD,3);
  data.set([21,101,151,255],(p.y*width+p.x)*4);pending.get('generated/heartlands-detail.png')({width,height,data});await flush();
  expect(cache.regionColor(26*RAD,23*RAD,3,3,out)).toBe(out);expect(out).toEqual([21,101,151]);
  const first=cache.regionColor(26*RAD,23*RAD,3,3),second=cache.regionColor(26*RAD,23*RAD,3,3);
  expect(first).not.toBe(second);expect(first).toEqual(second);
  cache.dispose();pending.get('generated/solana-detail.png')({width:2048,height:2048,data:new Uint8ClampedArray()});await flush();
  expect(cache.stats()).toEqual({regions:0,islands:0,pending:0});expect(invalidate).toHaveBeenCalledOnce();expect(onStatus).toHaveBeenCalledOnce();
 });
 it('reuses marker geography across camera frames and refreshes names/ownership when data changes',()=>{
  const ctx={createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),clearRect:()=>{},putImageData:()=>{},save:()=>{},restore:()=>{},beginPath:()=>{},stroke:()=>{},moveTo:()=>{},lineTo:()=>{}};
  const canvas=()=>({width:80,height:80,getContext:()=>ctx}),tile=fantasyTileAt(26,23),resolveTile=vi.fn(getFantasyTile);
  const renderer=createFantasyRenderer({canvas:canvas(),cloudCanvas:canvas(),effectCanvas:canvas(),read:()=>new Promise(()=>{}),resolveTile,invalidate:()=>{},onError:()=>{}});
  const markers=[{tileId:tile.tileId,name:'Original keeper',owned:false}];
  for(let step=0;step<8;step++)renderer.draw({lon:26+step*.01,lat:23,zoom:1},{worldMarkers:markers});
  expect(resolveTile).toHaveBeenCalledExactlyOnceWith(tile.tileId);
  expect(renderer.markerPositions()[0]).toMatchObject({name:'Original keeper',owned:false,realmId:'crownlands'});
  renderer.draw({lon:26,lat:23,zoom:1},{worldMarkers:[{...markers[0],name:'Updated keeper',owned:true}]});
  expect(resolveTile).toHaveBeenCalledTimes(2);expect(renderer.markerPositions()[0]).toMatchObject({name:'Updated keeper',owned:true});
  const marker=renderer.markerPositions()[0];expect(marker.parcelWidth).toBeGreaterThan(0);expect(marker.parcelHeight).toBeGreaterThan(0);
  expect(renderer.pick(marker.x,marker.y,{lon:tile.lon,lat:tile.lat,zoom:1}).tile?.tileId).toBe(tile.tileId);
  renderer.dispose();
 });
});

describe('magnified regional colors preserve geography and finite retry ownership',()=>{
 it('interpolates only magnified RGB into caller scratch while native-scale texels stay exact',async()=>{
  const source=REGIONAL_DETAILS[0],data=new Uint8ClampedArray(source.width*source.height*4);
  // Sample between four authored texel centres. The nearest index remains the
  // exact legacy floor for masks/picking, regardless of RGB interpolation.
  const at=(u,v)=>[(source.west+u/source.width*(source.east-source.west))*RAD,(source.north-v/source.height*(source.north-source.south))*RAD];
  for(const [x,y,r,g,b] of [[10,20,0,20,40],[11,20,100,120,140],[10,21,40,60,80],[11,21,140,160,180]])data.set([r,g,b,255],(y*source.width+x)*4);
  const read=vi.fn(async()=>({width:source.width,height:source.height,data})),cache=createDetailCache({read,invalidate:vi.fn()}),out=[];
  const [lon,lat]=at(10.75,20.75),legacy=regionalDetailAt(lon,lat,3);
  cache.regionColor(lon,lat,3,3,out);await flush();
  expect(cache.regionColor(lon,lat,3,1/source.filterScale,out)).toBe(out);expect(out).toEqual([0,20,40]);
  expect(cache.regionColor(lon,lat,3,2/source.filterScale,out)).toBe(out);
  for(let channel=0;channel<3;channel++)expect(out[channel]).toBeCloseTo(35+20*channel,7);
  cache.regionColor(lon,lat,3,1.5/source.filterScale,out);expect(out[0]).toBeCloseTo(17.5,7);
  expect(regionalDetailAt(lon,lat,3)).toEqual(legacy);
  for(let i=0;i<100;i++)expect(cache.regionColor(lon+i*1e-8,lat,3,30,out)).toBe(out);
  expect(read).toHaveBeenCalledOnce();expect(cache.stats()).toEqual({regions:1,islands:0,pending:0});cache.dispose();
 });
 it('clamps the authored RGB edges and preserves wrapped coordinates',async()=>{
  const source=REGIONAL_DETAILS[0],data=new Uint8ClampedArray(source.width*source.height*4);data.set([80,90,100,255],(source.height-1)*source.width*4);
  const cache=createDetailCache({read:async()=>({data}),invalidate:vi.fn()}),lon=(source.west+1e-8)*RAD,lat=(source.south+1e-8)*RAD;
  cache.regionColor(lon,lat,3,30);await flush();
  expect(cache.regionColor(lon,lat,3,30)).toEqual([80,90,100]);expect(cache.regionColor(lon+2*Math.PI,lat,3,30)).toEqual([80,90,100]);cache.dispose();
 });
 it('a retry replaces hung requests and cannot publish or clear a newer request from a stale settlement',async()=>{
  const requests=[],onStatus=vi.fn(),invalidate=vi.fn(),cache=createDetailCache({read:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),invalidate,onStatus});
  const sample=()=>{cache.beginFrame();cache.regionColor(26*RAD,23*RAD,3,3,[]);cache.finishFrame();};
  sample();cache.retry();sample();expect(requests).toHaveLength(2);
  requests[0].resolve({data:new Uint8ClampedArray()});await flush();
  expect(cache.stats()).toEqual({regions:0,islands:0,pending:1});sample();expect(requests).toHaveLength(2);
  const failure=Error('offline');requests[1].reject(failure);await flush();sample();expect(onStatus).toHaveBeenLastCalledWith({pending:false,error:failure});expect(requests).toHaveLength(2);
  cache.retry();sample();expect(requests).toHaveLength(3);expect(onStatus).toHaveBeenLastCalledWith({pending:true,error:null});const notifications=onStatus.mock.calls.length;cache.dispose();requests[2].reject(Error('late'));await flush();
  expect(onStatus).toHaveBeenCalledTimes(notifications);expect(cache.stats()).toEqual({regions:0,islands:0,pending:0});
 });
});

describe('gesture raster refinement preserves logical geography',()=>{
 function fixture(width,height){
  let allocations=0;
  const canvases=[];
  const make=(w,h)=>{
   const canvas={width:w,height:h,ownerDocument:{createElement:()=>make(0,0)}};
   const context={createImageData:(width,height)=>{allocations++;return {width,height,data:new Uint8ClampedArray(width*height*4)};},
    putImageData:vi.fn(),drawImage:vi.fn(),clearRect:vi.fn(),save:()=>{},restore:()=>{},beginPath:()=>{},stroke:()=>{},moveTo:()=>{},lineTo:()=>{}};
   canvas.getContext=()=>context;canvases.push(canvas);return canvas;
  };
  const canvas=make(width,height),renderer=createFantasyRenderer({canvas,cloudCanvas:make(width,height),effectCanvas:make(width,height),read:()=>new Promise(()=>{}),resolveTile:getFantasyTile,invalidate:()=>{},onError:()=>{}});
  return {canvas,renderer,context:canvas.getContext(),allocations:()=>allocations,canvases};
 }
 it.each([[80,160],[271,588]])('refines to exact full pixels after motion without moving any parcel at %dx%d', (width,height)=>{
  const f=fixture(width,height),tile=fantasyTileAt(26.25,25.75),options={selectedTileId:tile.tileId,worldMarkers:[{tileId:tile.tileId,name:'Synthetic keeper',owned:true}]};
  for(const view of [{lon:tile.lon,lat:tile.lat,zoom:23.6},{lon:tile.lon+.5,lat:tile.lat+.3,zoom:64},{lon:179.9,lat:12,zoom:23.6}]){
   f.renderer.draw(view,options);
   const baseline=f.context.putImageData.mock.calls.at(-1)[0].data.slice(),markers=f.renderer.markerPositions();
   const points=[[0,0],[width/2,height/2],[width-1,height-1],[width/3,height/3]],picks=points.map(([x,y])=>f.renderer.pick(x,y,view));
   for(let n=0;n<8;n++)f.renderer.draw(view,{...options,interacting:true});
   const [motion,,,dw,dh]=f.context.drawImage.mock.calls.at(-1);
   expect([motion.width,motion.height,dw,dh]).toEqual([Math.ceil(width/2),Math.ceil(height/2),width,height]);
   expect(motion.width*motion.height).toBeLessThanOrEqual(Math.ceil(width*height*.26));
   expect([f.canvas.width,f.canvas.height]).toEqual([width,height]);
   expect(f.renderer.markerPositions()).toEqual(markers);
   expect(points.map(([x,y])=>f.renderer.pick(x,y,view))).toEqual(picks);
   f.renderer.draw(view,{...options,interacting:false});
   const settled=f.context.putImageData.mock.calls.at(-1)[0].data;
   expect(Buffer.compare(Buffer.from(settled.buffer,settled.byteOffset,settled.byteLength),Buffer.from(baseline.buffer))).toBe(0);
  }
  expect(f.allocations()).toBe(2); // One full frame and one reusable motion frame.
  f.renderer.dispose();
 });
 it('reuses buffers across center changes, replaces them only on resize and releases on teardown',()=>{
  const f=fixture(120,80),view={lon:26,lat:23,zoom:23.6};
  f.renderer.draw(view,{interacting:true});const first=f.context.drawImage.mock.calls.at(-1)[0];
  f.renderer.resize(120,80,42,35);f.renderer.draw(view,{interacting:true});
  expect(f.context.drawImage.mock.calls.at(-1)[0]).toBe(first);expect(f.allocations()).toBe(2);
  f.renderer.resize(100,140);f.renderer.draw(view,{interacting:true});const second=f.context.drawImage.mock.calls.at(-1)[0];
  expect(second).not.toBe(first);expect([first.width,first.height]).toEqual([0,0]);expect([second.width,second.height]).toEqual([50,70]);expect(f.allocations()).toBe(4);
  f.renderer.dispose();const paints=f.context.drawImage.mock.calls.length;
  expect([second.width,second.height]).toEqual([0,0]);
  f.renderer.draw(view,{interacting:true});expect(f.context.drawImage).toHaveBeenCalledTimes(paints);expect(f.allocations()).toBe(4);
 });
});

import {frozenSurfaceAt,GEOGRAPHY_WIDTH,GEOGRAPHY_HEIGHT} from './runtime/geography.mjs';
import {ARCHIPELAGOS} from './runtime/world.mjs';
import {ISLAND_ATLAS} from './runtime/island-shapes.mjs';

// Coarse pixels use the frozen membership oracle so these regressions exercise
// the real raster traversal, not a mocked list of supposedly visible regions.
function readyGeography(){
 const width=GEOGRAPHY_WIDTH,height=GEOGRAPHY_HEIGHT;
 const color={width,height,data:new Uint8ClampedArray(width*height*4)},regions={...color,data:color.data.slice()},surface={...color,data:color.data.slice()};
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*4,s=frozenSurfaceAt((x+.5)/width*Math.PI*2-Math.PI,Math.PI/2-(y+.5)/height*Math.PI);
  color.data.set([73,114,92,255],i);regions.data[i]=s.region+1;
  surface.data.set([Number(s.region>=0),Number(s.deedEligible),s.explorationIndex,255],i);
 }
 return new Map([['realm-texture.png',color],['realm-mask.png',regions],['surface-mask.png',surface],['generated/cloud-banks.png',{width:192,height:64,data:new Uint8ClampedArray(192*64*4)}]]);
}
function visibleDetailFixture(){
 const requests=new Map(),coarse=readyGeography(),onError=vi.fn(),onDetailStatus=vi.fn(),invalidate=vi.fn();
 const read=vi.fn(path=>coarse.has(path)?Promise.resolve(coarse.get(path)):new Promise((resolve,reject)=>{
  const list=requests.get(path)??[];list.push({resolve,reject});requests.set(path,list);
 }));
 const ctx={createImageData:(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}),clearRect:()=>{},putImageData:()=>{},save:()=>{},restore:()=>{},beginPath:()=>{},stroke:()=>{},moveTo:()=>{},lineTo:()=>{}};
 const canvas=()=>({width:844,height:320,getContext:()=>ctx});
 const renderer=createFantasyRenderer({canvas:canvas(),cloudCanvas:canvas(),effectCanvas:canvas(),read,resolveTile:getFantasyTile,invalidate,onError,onDetailStatus});
 return {renderer,requests,read,onError,onDetailStatus,invalidate};
}
const regionalPixels=id=>{
 const {width,height}=REGIONAL_DETAILS.find(source=>source.id===id);
 return {width,height,data:new Uint8ClampedArray(width*height*4).fill(99)};
};

describe('current raster dependencies own detail loading and recovery',()=>{
 it('leaves ready Crownlands usable when an overview Stormcairn read later fails offscreen, then exposes the failure on revisit',async()=>{
  const f=visibleDetailFixture();await f.renderer.ready;
  f.renderer.draw({lon:26,lat:23,zoom:1});
  expect(f.requests.has('generated/heartlands-detail.png')).toBe(true);
  expect(f.requests.has('generated/stormcairn-detail.png')).toBe(true);
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:true,error:null});
  f.renderer.draw({lon:26,lat:23,zoom:55.5});
  f.requests.get('generated/heartlands-detail.png')[0].resolve(regionalPixels('heartlands'));await flush();
  f.renderer.draw({lon:26,lat:23,zoom:55.5});
  expect(f.renderer.stats().pending).toBeGreaterThan(0);
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:false,error:null});
  const reports=f.onDetailStatus.mock.calls.length,failure=Error('Terrain unavailable 503');
  f.requests.get('generated/stormcairn-detail.png')[0].reject(failure);await flush();
  for(let i=0;i<3;i++)f.renderer.draw({lon:26,lat:23,zoom:55.5});
  expect(f.onError).not.toHaveBeenCalled();expect(f.onDetailStatus).toHaveBeenCalledTimes(reports);
  f.renderer.draw({lon:157.3,lat:23.8,zoom:55.5});
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:false,error:failure});
  expect(f.requests.get('generated/stormcairn-detail.png')).toHaveLength(1);
  f.renderer.draw({lon:26,lat:23,zoom:55.5});
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:false,error:null});
  f.renderer.draw({lon:157.3,lat:23.8,zoom:55.5});
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:false,error:failure});
  await f.renderer.retry();f.renderer.draw({lon:157.3,lat:23.8,zoom:55.5});
  expect(f.requests.get('generated/stormcairn-detail.png')).toHaveLength(2);
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:true,error:null});
  f.requests.get('generated/stormcairn-detail.png')[1].resolve(regionalPixels('stormcairn'));await flush();
  f.renderer.draw({lon:157.3,lat:23.8,zoom:55.5});
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:false,error:null});f.renderer.dispose();
 });
 it('reports a visible regional failure without retrying it on every draw and drops detail requirements below detail zoom',async()=>{
  const f=visibleDetailFixture();await f.renderer.ready;
  f.renderer.draw({lon:26,lat:23,zoom:55.5});
  const failure=Error('Terrain integrity check failed');f.requests.get('generated/heartlands-detail.png')[0].reject(failure);await flush();
  f.renderer.draw({lon:26,lat:23,zoom:55.5});
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:false,error:failure});
  const reports=f.onDetailStatus.mock.calls.length;
  for(let i=0;i<3;i++)f.renderer.draw({lon:26,lat:23,zoom:55.5});
  expect(f.requests.get('generated/heartlands-detail.png')).toHaveLength(1);expect(f.onDetailStatus).toHaveBeenCalledTimes(reports);
  // 80px raster at overview never samples detail, even above that continent.
  f.renderer.resize(80,80);f.renderer.draw({lon:26,lat:23,zoom:1});
  expect(f.onDetailStatus).toHaveBeenLastCalledWith({pending:false,error:null});f.renderer.dispose();
 });
 it('keeps coarse and cloud failures global rather than hiding them as offscreen details',async()=>{
  const onError=vi.fn(),ctx={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),clearRect:()=>{}},canvas=()=>({width:80,height:80,getContext:()=>ctx});
  const coarseFailure=Error('Terrain membership unavailable'),cloudFailure=Error('Cloud atlas invalid');
  const renderer=createFantasyRenderer({canvas:canvas(),cloudCanvas:canvas(),effectCanvas:canvas(),read:path=>Promise.reject(path==='generated/cloud-banks.png'?cloudFailure:coarseFailure),resolveTile:getFantasyTile,invalidate:()=>{},onError});
  await expect(renderer.ready).rejects.toBe(coarseFailure);await flush();
  expect(onError).toHaveBeenCalledWith(coarseFailure);expect(onError).toHaveBeenCalledWith(cloudFailure);renderer.dispose();
 });
 it('tracks island color and mask as one visible dependency without allowing offscreen picking to hold status',async()=>{
  const requests=new Map(),onStatus=vi.fn(),cache=createDetailCache({read:path=>new Promise((resolve,reject)=>requests.set(path,{resolve,reject})),invalidate:vi.fn(),onStatus});
  const chain=ARCHIPELAGOS[0],site=chain.islands[0];
  const drawIsland=()=>{cache.beginFrame();cache.island(site.lon*RAD,site.lat*RAD);cache.finishFrame();};
  drawIsland();expect(onStatus).toHaveBeenLastCalledWith({pending:true,error:null});
  cache.beginFrame();cache.finishFrame();expect(onStatus).toHaveBeenLastCalledWith({pending:false,error:null});
  cache.island(site.lon*RAD,site.lat*RAD); // Picking outside the draw frame.
  const reports=onStatus.mock.calls.length,failure=Error('Island mask failed');
  requests.get(`generated/${chain.id}-detail-mask.png`).reject(failure);await flush();
  cache.beginFrame();cache.finishFrame();expect(onStatus).toHaveBeenCalledTimes(reports);
  drawIsland();expect(onStatus).toHaveBeenLastCalledWith({pending:false,error:failure});
  const oldColor=requests.get(`generated/${chain.id}-detail.png`);
  cache.retry();drawIsland();expect(onStatus).toHaveBeenLastCalledWith({pending:true,error:null});
  oldColor.resolve({width:ISLAND_ATLAS,height:ISLAND_ATLAS,data:new Uint8ClampedArray(ISLAND_ATLAS*ISLAND_ATLAS*4)});await flush();
  expect(cache.stats()).toEqual({regions:0,islands:0,pending:1});
  const mask={width:ISLAND_ATLAS,height:ISLAND_ATLAS,data:new Uint8ClampedArray(ISLAND_ATLAS*ISLAND_ATLAS*4)};
  requests.get(`generated/${chain.id}-detail-mask.png`).resolve(mask);requests.get(`generated/${chain.id}-detail.png`).resolve(mask);await flush();await flush();
  drawIsland();expect(onStatus).toHaveBeenLastCalledWith({pending:false,error:null});cache.dispose();
 });
});
