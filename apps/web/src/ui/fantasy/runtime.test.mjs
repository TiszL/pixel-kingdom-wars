import { describe, expect, it, vi } from 'vitest';
import { createDetailCache, regionalDetailAt, REGIONAL_DETAILS } from './runtime/details.mjs';
import { cloudSamples, cloudOpacity } from './runtime/clouds.mjs';
import { allocationAt } from './runtime/allocations.mjs';
import { ARCHIPELAGOS, RAD } from './runtime/world.mjs';
import { locateIsland } from './runtime/island-shapes.mjs';

const pixels = (width, height, color = [19, 111, 137, 255]) => {
 const data = new Uint8ClampedArray(width * height * 4);
 for (let i = 0; i < data.length; i += 4) data.set(color, i);
 return { width, height, data };
};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('approved geographic detail stays shared by color and picking', () => {
 it('uses mapped artwork for every realm, including unwrapped eastern/southwestern longitudes', () => {
  for (const source of REGIONAL_DETAILS) for (const region of source.regions) {
   const lon = (source.west + source.east) / 2, lat = (source.south + source.north) / 2;
   const a = regionalDetailAt(lon * RAD, lat * RAD, region);
   const b = regionalDetailAt((lon + 360) * RAD, lat * RAD, region);
   expect(a.source.id).toBe(source.id); expect(a).toEqual(b);
   expect(Math.abs(a.x - source.width / 2)).toBeLessThanOrEqual(1);
   expect(Math.abs(a.y - source.height / 2)).toBeLessThanOrEqual(1);
  }
 });
 it('deduplicates regional requests, samples decoded detail and prevents a stale decode after teardown', async () => {
  let finish;
  const read = vi.fn(() => new Promise(yes => { finish = yes; })), invalidate = vi.fn(), onStatus = vi.fn();
  const cache = createDetailCache({ read, invalidate, onStatus });
  cache.beginFrame();
  expect(cache.regionColor(26 * RAD, 23 * RAD, 3, 3)).toBeNull();
  expect(cache.regionColor(26 * RAD, 23 * RAD, 3, 3)).toBeNull();
  expect(read).toHaveBeenCalledOnce();
  cache.finishFrame();expect(onStatus).toHaveBeenLastCalledWith({pending:true,error:null});
  finish(pixels(2048, 1536)); await flush();
  expect(cache.regionColor(26 * RAD, 23 * RAD, 3, 3)).toEqual([19, 111, 137]);
  expect(cache.stats().regions).toBe(1);
  cache.regionColor(-115 * RAD, 38 * RAD, 4, 3);
  cache.dispose(); finish(pixels(2048, 2048)); await flush();
  expect(cache.stats().regions).toBe(0); expect(onStatus).toHaveBeenCalledOnce();
 });
 it('all 32 detailed islands expose inspection identities while permanently refusing deed eligibility', () => {
  const features = new Set();
  for (const chain of ARCHIPELAGOS) for (const island of chain.islands) {
   const location = locateIsland(island.lon * RAD, island.lat * RAD, ARCHIPELAGOS);
   expect(location).not.toBeNull(); expect(location.deedEligible).toBe(false);
   expect(location.explorationId).toBe(chain.id); expect(location.featureId).toBeTruthy();
   features.add(location.featureId);
  }
  expect(features.size).toBe(32);
 });
 it('cloud opacity is capped, fades at parcel zoom, and every animated bank remains within Genesis allocation', () => {
  expect(cloudOpacity(176, 1)).toBeLessThanOrEqual(Math.floor(255 * .45));
  expect(cloudOpacity(176 * 64, 1)).toBeLessThanOrEqual(Math.floor(255 * .1));
  for (const time of [0, 8000, 16000, 24000, 32000]) {
   const points = cloudSamples(time, true); expect(points.length).toBeGreaterThan(0);
   for (const point of points) expect(allocationAt(point.lon, point.lat)).toBe('genesis');
  }
  expect(cloudSamples(8000, false)).toEqual(cloudSamples(0, false));
 });
});

// Exact accepted all-island scan retained only as an independent test oracle.
// The production index must never turn an ocean patch into an expedition hit.
import { COASTLINES } from './runtime/generated/island-coastlines.mjs';
import { ISLAND_CELL, ISLAND_EXTENT } from './runtime/island-shapes.mjs';
const wrap = n => ((n + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
function originalIslandAt(lon, lat) {
 let number = 0;
 for (let chainIndex = 0; chainIndex < ARCHIPELAGOS.length; chainIndex++) {
  const chain = ARCHIPELAGOS[chainIndex];
  for (let index = 0; index < chain.islands.length; index++, number++) {
   const island = chain.islands[index], dx = wrap(lon - island.lon * RAD) / RAD / island.rx, dy = (lat / RAD - island.lat) / island.ry;
   if (Math.abs(dx) >= ISLAND_EXTENT || Math.abs(dy) >= ISLAND_EXTENT) continue;
   const u = Math.floor((dx / ISLAND_EXTENT + 1) * ISLAND_CELL / 2), v = Math.floor((1 - dy / ISLAND_EXTENT) * ISLAND_CELL / 2);
   return { number, u, v, land: COASTLINES[number][v].some(([a, b]) => u >= a && u <= b) };
  }
 }
 return null;
}
it('indexed picking exactly matches every global degree and every authored coast row, including wrapped copies', () => {
 const check = (lon, lat) => {
  const expected = originalIslandAt(lon * RAD, lat * RAD), actual = locateIsland(lon * RAD, lat * RAD, ARCHIPELAGOS);
  if (expected === null) { if (actual !== null) throw Error(`Unexpected island at ${lon},${lat}`); }
  else if (!actual || actual.number !== expected.number || actual.u !== expected.u || actual.v !== expected.v || actual.visibleLand !== expected.land) throw Error(`Changed authored island at ${lon},${lat}`);
 };
 for (let lat = -89.5; lat < 90; lat++) for (let lon = -179.5; lon < 180; lon++) check(lon, lat);
 for (const chain of ARCHIPELAGOS) for (const island of chain.islands) for (let row = 0; row < ISLAND_CELL; row++) {
  const lat = island.lat + (1 - (row + .5) / ISLAND_CELL * 2) * ISLAND_EXTENT * island.ry;
  for (const column of [0, 40, 80, 120, 160, 200, 240, 280, 319]) {
   const lon = island.lon + ((column + .5) / ISLAND_CELL * 2 - 1) * ISLAND_EXTENT * island.rx;
   check(lon, lat); check(lon + 360, lat);
  }
 }
// This exhaustive ~249k-point identity audit is not a speed benchmark. Keep
// every sample while allowing shared CI CPUs to complete the independent oracle.
}, 20_000);

import { islandPatchMask } from './runtime/island-shapes.mjs';
import { geographyIndex } from './runtime/geography.mjs';
it('coarse island culling includes every fine patch pixel and its wrapped copy', () => {
 const mask = islandPatchMask(768, 384, ARCHIPELAGOS);
 for (const chain of ARCHIPELAGOS) for (const island of chain.islands) for (let row = 0; row <= 320; row += 4) for (let column = 0; column <= 320; column += 4) {
  const lon = (island.lon + (column / 320 * 2 - 1) * ISLAND_EXTENT * island.rx) * RAD;
  const lat = (island.lat + (1 - row / 320 * 2) * ISLAND_EXTENT * island.ry) * RAD;
  if(mask[geographyIndex(lon, lat)]!==1||mask[geographyIndex(lon+Math.PI*2,lat)]!==1)throw Error(`Culled authored island patch at ${lon},${lat}`);
 }
});

import { mountClouds } from './runtime/clouds.mjs';
it('cloud rendering avoids far-hemisphere frame allocation and clears its previous canopy once', () => {
 const ctx = { createImageData: vi.fn((w,h)=>({data:new Uint8ClampedArray(w*h*4)})), clearRect:vi.fn(),putImageData:vi.fn() };
 const canvas={width:400,height:400,getContext:()=>ctx};
 let cam={lon:26*RAD,lat:23*RAD};
 const clouds=mountClouds({canvas,getCamera:()=>cam,getRadius:()=>176});
 clouds.draw(0,true);expect(ctx.createImageData).not.toHaveBeenCalled();
 cam={lon:-115*RAD,lat:38*RAD};clouds.draw(100,true);expect(ctx.putImageData).toHaveBeenCalledOnce();
 clouds.draw(110);expect(ctx.putImageData).toHaveBeenCalledOnce();
 cam={lon:26*RAD,lat:23*RAD};clouds.draw(200,true);expect(ctx.clearRect).toHaveBeenCalledOnce();
 clouds.draw(300,true);expect(ctx.clearRect).toHaveBeenCalledOnce();expect(ctx.createImageData).toHaveBeenCalledOnce();
 clouds.dispose();
});

import { createFantasyRenderer, tileFocus, islandFocus, normalizedView, rasterSize } from './runtime/renderer.mjs';
import { fantasyTiles, getFantasyTile, fantasyTileAt } from '@shardkeep/shared/fantasyWorld';
import { project } from './runtime/world.mjs';
it('automatic island focus fits every authored coast below the HUD and clear of panels, including short landscape',()=>{
 let inspected=0;
 for(const [width,height,clearWidth,clearHeight]of [[1440,900,1096,650],[390,844,390,230],[844,390,556,172]]){
  const scale=Math.min(width,height)/400;let number=0;
  for(const chain of ARCHIPELAGOS)for(const [index,site]of chain.islands.entries()){
   const view=islandFocus(chain.id,`${chain.id}-${index+1}`,scale,{width:clearWidth,height:clearHeight});
   const cam={lon:view.lon*RAD,lat:view.lat*RAD},radius=176*view.zoom*scale;
   for(const [row,spans]of COASTLINES[number++].entries())for(const [a,b]of spans)for(const col of [a,b+1])for(const v of [row,row+1]){
    const lon=(site.lon+(col/ISLAND_CELL*2-1)*ISLAND_EXTENT*site.rx)*RAD;
    const lat=(site.lat+(1-v/ISLAND_CELL*2)*ISLAND_EXTENT*site.ry)*RAD;
    const p=project(lon,lat,cam),x=clearWidth/2+p.x*radius,y=clearHeight/2+p.y*radius;
    if(x<16||x>clearWidth-16||y<16||y>clearHeight-16)throw Error(`Clipped ${chain.id}-${index+1} coast at ${width}×${height}: ${x},${y}`);
    inspected++;
   }
   if(width===844&&chain.id==='lumenreef'&&index===3)expect(view.zoom).toBeLessThan(30);
  }
 }
 expect(inspected).toBeGreaterThan(10000);
});
it('rectangular rendering, markers and native pixel picking share the safe camera center within the raster budget',()=>{
 const context={createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),clearRect:()=>{},putImageData:vi.fn(),save:()=>{},restore:()=>{},beginPath:()=>{},stroke:()=>{},moveTo:()=>{},lineTo:()=>{}};
 const canvas=()=>({width:400,height:400,getContext:()=>context});
 const terrain=canvas(),clouds=canvas(),effects=canvas(),tile=fantasyTileAt(26,23);
 const renderer=createFantasyRenderer({canvas:terrain,cloudCanvas:clouds,effectCanvas:effects,read:()=>new Promise(()=>{}),resolveTile:getFantasyTile,invalidate:()=>{},onError:()=>{}});
 for(const [cssWidth,cssHeight]of [[1440,900],[390,844],[844,390]]){
  const size=rasterSize(cssWidth,cssHeight),x=size.width*.38,y=size.height*.52;
  expect(size.width*size.height).toBeLessThanOrEqual(160000);
  expect(Math.abs(size.width/size.height-cssWidth/cssHeight)).toBeLessThan(.01);
  renderer.resize(size.width,size.height,x,y);
  const view={lon:tile.lon,lat:tile.lat,zoom:20};
  renderer.draw(view,{worldMarkers:[{tileId:tile.tileId,name:'persisted test owner'}]});
  const frame=context.putImageData.mock.calls.at(-1)[0];
  expect([frame.width,frame.height]).toEqual([size.width,size.height]);
  expect([clouds.width,clouds.height,effects.width,effects.height]).toEqual([size.width,size.height,size.width,size.height]);
  const marker=renderer.markerPositions()[0];expect(marker.x).toBeCloseTo(x);expect(marker.y).toBeCloseTo(y);
  expect(renderer.pick(marker.x,marker.y,view).tile?.tileId).toBe(tile.tileId);
  // Every subpixel inside the same enlarged native pixel picks its painted surface.
  expect(renderer.pick(Math.floor(x)+.1,Math.floor(y)+.1,view)).toEqual(renderer.pick(Math.floor(x)+.9,Math.floor(y)+.9,view));
 }
 renderer.dispose();
});
it('a northern deed reaches a phone touch target and inspects the same tile before repaint', () => {
 const north = [...fantasyTiles('frostveil')].reduce((a,b)=>a.lat>b.lat?a:b);
 const scale = 320/400, view = normalizedView(tileFocus(north, scale));
 expect(view.zoom).toBeLessThanOrEqual(256); expect(view.lat).toBe(north.lat);
 const cam={lon:view.lon*RAD,lat:view.lat*RAD};
 const left=project((north.lon-.25)*RAD,north.lat*RAD,cam),right=project((north.lon+.25)*RAD,north.lat*RAD,cam);
 expect((right.x-left.x)*176*view.zoom*scale).toBeGreaterThanOrEqual(44);
 const context={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),clearRect:()=>{}};
 const canvas=()=>({width:400,height:400,getContext:()=>context});
 const renderer=createFantasyRenderer({canvas:canvas(),cloudCanvas:canvas(),effectCanvas:canvas(),read:()=>new Promise(()=>{}),resolveTile:getFantasyTile,invalidate:()=>{},onError:()=>{}});
 // No draw() has run: a same-frame keyboard focus must still inspect its new camera.
 expect(renderer.pick(200,200,view).tile?.tileId).toBe(north.tileId);
 const crown=fantasyTileAt(26,23),crownView=tileFocus(crown,scale);
 expect(renderer.pick(200,200,crownView).tile?.tileId).toBe(crown.tileId);
 expect(normalizedView({lon:26,lat:23,zoom:1}).zoom).toBe(1);
 renderer.dispose();
});

it('terrain retry restores the authored cloud atlas after a transient download failure', async () => {
 const read=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(pixels(192,64,[23,45,67,255])),onError=vi.fn();
 const ctx={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),clearRect:()=>{},putImageData:vi.fn()};
 const clouds=mountClouds({canvas:{width:400,height:400,getContext:()=>ctx},getCamera:()=>({lon:-115*RAD,lat:38*RAD}),getRadius:()=>176,read,onError});
 await flush();await flush();expect(onError).toHaveBeenCalledOnce();
 await clouds.retry();expect(read).toHaveBeenCalledTimes(2);
 clouds.draw(100,true);
 const data=ctx.putImageData.mock.calls.at(-1)[0].data;
 let authored=false;for(let i=0;i<data.length;i+=4)if(data[i]===23&&data[i+1]===45&&data[i+2]===67&&data[i+3]>0){authored=true;break;}
 expect(authored).toBe(true);
 await clouds.retry();expect(read).toHaveBeenCalledTimes(2);
 clouds.dispose();
});
