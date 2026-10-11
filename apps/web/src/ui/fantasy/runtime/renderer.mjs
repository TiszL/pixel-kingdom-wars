import {REGIONS,RAD,TAU,clamp,wrap,project,unproject,textureIndex,ARCHIPELAGOS} from './world.mjs';
import {frozenSurfaceAt,GEOGRAPHY_WIDTH as TW,GEOGRAPHY_HEIGHT as TH} from './geography.mjs';
import {cellAt,gridVisible,STEP} from './tile-geometry.mjs';
import {mountClouds} from './clouds.mjs';
import {mountIslandEffects} from './island-effects.mjs';
import {createDetailCache} from './details.mjs';
import {sampleOceanColor} from './ocean-detail.mjs';
import {drawSanctuary} from './sanctuary-render.mjs';
import {layoutRealmLabels} from './realm-labels.mjs';
import {locateIsland,islandPatchMask,ISLAND_EXTENT} from './island-shapes.mjs';
export {REGIONS,ARCHIPELAGOS};
export const SIZE=400;
/** Preserve the viewport aspect without increasing the accepted raster work budget. */
export function rasterSize(width,height){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return {width:SIZE,height:SIZE};
 const scale=Math.min(1,SIZE/Math.sqrt(width*height));
 return {width:Math.max(1,Math.floor(width*scale)),height:Math.max(1,Math.floor(height*scale))};
}

export function normalizedView(view){return {lon:wrap(view.lon*RAD)/RAD,lat:clamp(view.lat,-85,85),zoom:clamp(view.zoom,.8,256)};}
export function tileFocus(tile,cssScale=1){return {lon:tile.lon,lat:tile.lat,zoom:clamp(50/(176*STEP*Math.cos(tile.lat*RAD)*cssScale),16,256)};}
export function islandFocus(chainId,islandId,cssScale=1,available){
 const chain=ARCHIPELAGOS.find(a=>a.id===chainId);if(!chain)return null;
 const index=islandId?Number(islandId.slice(chain.id.length+1))-1:-1,site=chain.islands[index];
 if(!site)return {lon:chain.lon,lat:chain.lat,zoom:3};
 let zoom=clamp(280/(2*site.rx*RAD*Math.cos(site.lat*RAD)*176*cssScale),4,64);
 if(available){
  // The authored patch encloses every coastal pixel. Project its corners and
  // edge midpoints, including latitude curvature, into the actual clear view.
  const cam={lon:site.lon*RAD,lat:site.lat*RAD};let x=0,y=0;
  for(const dx of [-1,0,1])for(const dy of [-1,0,1]){
   const p=project((site.lon+dx*site.rx*ISLAND_EXTENT)*RAD,(site.lat+dy*site.ry*ISLAND_EXTENT)*RAD,cam);
   x=Math.max(x,Math.abs(p.x));y=Math.max(y,Math.abs(p.y));
  }
  zoom=Math.min(zoom,Math.max(1,available.width-32)/(2*x*176*cssScale),Math.max(1,available.height-32)/(2*y*176*cssScale));
 }
 return {lon:site.lon,lat:site.lat,zoom:clamp(zoom,.8,64)};
}

/** Same fixed raster and mapped sources as the approved standalone. Ownership
 * is injected from API data; pictures and island effects never grant a tile. */
export function createFantasyRenderer({canvas,cloudCanvas,effectCanvas,read,readDetail=read,resolveTile,invalidate,onError,onDetailStatus,getReducedMotion=()=>false}){
 const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('Canvas globe unavailable');
 const cam={lon:26*RAD,lat:23*RAD,zoom:1},texture=new Uint8Array(TW*TH*3),regionMap=new Int8Array(TW*TH),deedMap=new Uint8Array(TW*TH),explorationMap=new Uint8Array(TW*TH);
 let alive=true,ready=false,cssScale=1,selectedCell=-1,markers=[],lastView={lon:26,lat:23,zoom:1},selectedRealm='crownlands',frames=0,frameMs=0;
 let owned=new Set(),occupied=new Set(),markerSource=null;
 const regionSample=[],oceanSample=[];
 for(let y=0;y<TH;y++)for(let x=0;x<TW;x++){
   const i=y*TW+x,s=frozenSurfaceAt((x+.5)/TW*TAU-Math.PI,Math.PI/2-(y+.5)/TH*Math.PI);
   regionMap[i]=s.region;deedMap[i]=Number(s.deedEligible);explorationMap[i]=s.explorationIndex;
   texture.set(s.region<0?[27,53,76]:REGIONS[s.region].palette[1],i*3);
 }
 let width=canvas.width||SIZE,height=canvas.height||SIZE,frame=ctx.createImageData(width,height),bytes=frame.data,cellPixels=new Int32Array(width*height),gridPixels=new Uint8Array(width*height);
 let motionRaster=null,motionUnavailable=false;
 function releaseMotionRaster(){if(motionRaster){motionRaster.canvas.width=0;motionRaster.canvas.height=0;motionRaster=null;}}
 function getMotionRaster(){
   if(motionRaster)return motionRaster;
   if(motionUnavailable)return null;
   const target=canvas.ownerDocument?.createElement('canvas'),context=target?.getContext('2d',{alpha:false});
   if(!target||!context||typeof ctx.drawImage!=='function'){motionUnavailable=true;return null;}
   target.width=Math.max(1,Math.ceil(width/2));target.height=Math.max(1,Math.ceil(height/2));
   motionRaster={canvas:target,ctx:context,frame:context.createImageData(target.width,target.height),cells:new Int32Array(target.width*target.height),grid:new Uint8Array(target.width*target.height)};
   return motionRaster;
 }
 let centerX=width/2,centerY=height/2;
 const tileEligibility=new Int8Array(720*360);
 const islandAreas=islandPatchMask(TW,TH,ARCHIPELAGOS);
 const detail=createDetailCache({read:readDetail,invalidate,onStatus:onDetailStatus});
 const baseRadius=()=>176*Math.min(width,height)/SIZE,radius=()=>baseRadius()*cam.zoom;
 const getCenter=()=>({x:centerX,y:centerY});
 const clouds=mountClouds({canvas:cloudCanvas,getCamera:()=>cam,getRadius:radius,getCenter,getCssScale:()=>cssScale,read,getReducedMotion,onError});
 const effects=mountIslandEffects({canvas:effectCanvas,getCamera:()=>cam,getRadius:radius,getCenter,getCssScale:()=>cssScale,getReducedMotion});
 async function load(){
   const [color,regions,surface]=await Promise.all([read('realm-texture.png'),read('realm-mask.png'),read('surface-mask.png')]);
   if(!alive)return;
   for(const image of [color,regions,surface])if(image.width!==TW||image.height!==TH)throw Error('Terrain projection mismatch');
   // Compare the entire triplet before publishing even one new terrain pixel.
   for(let i=0;i<TW*TH;i++){
     const r=regions.data[i*4],v=surface.data[i*4],d=surface.data[i*4+1],e=surface.data[i*4+2];
     if(r!==regionMap[i]+1||Boolean(v)!==(regionMap[i]>=0)||d!==deedMap[i]||e!==explorationMap[i])throw Error('Terrain membership mismatch');
   }
   for(let i=0;i<TW*TH;i++)texture.set(color.data.subarray(i*4,i*4+3),i*3);
   ready=true;invalidate();
 }
 const initialReady=load();initialReady.catch(error=>{if(alive)onError(error);});
 function resize(nextWidth,nextHeight,nextCenterX=nextWidth/2,nextCenterY=nextHeight/2){
   const changed=nextWidth!==width||nextHeight!==height;
   if(!changed&&nextCenterX===centerX&&nextCenterY===centerY)return;
   width=nextWidth;height=nextHeight;centerX=nextCenterX;centerY=nextCenterY;
   if(changed){for(const target of [canvas,cloudCanvas,effectCanvas]){target.width=width;target.height=height;}
   frame=ctx.createImageData(width,height);bytes=frame.data;cellPixels=new Int32Array(width*height);gridPixels=new Uint8Array(width*height);releaseMotionRaster();}
   invalidate();
 }
 function surfaceAt(lon,lat,zoom=cam.zoom){
   const i=textureIndex(lon,lat,TW,TH),fine=ready&&islandAreas[i]&&baseRadius()*zoom*TAU/TW>1.5?detail.island(lon,lat,explorationMap[i]):null;
   if(fine)return {...fine,region:fine.visibleLand?fine.region:-1,deedEligible:false,explorationId:fine.visibleLand?fine.explorationId:null};
   return {visibleLand:regionMap[i]>=0,deedEligible:!!deedMap[i],explorationId:ARCHIPELAGOS[explorationMap[i]-1]?.id??null,region:regionMap[i]};
 }
 function pick(x,y,view){
   const current=view?normalizedView(view):lastView,pickingCamera={lon:current.lon*RAD,lat:current.lat*RAD},R=baseRadius()*current.zoom;
   const p=unproject((Math.floor(x)-centerX)/R,(Math.floor(y)-centerY)/R,pickingCamera);if(!p)return {tile:null,realmId:null,exploration:null};
   const s=surfaceAt(p.lon,p.lat,current.zoom);
   if(!s.visibleLand)return {tile:null,realmId:null,exploration:null};
   if(s.explorationId){const island=locateIsland(p.lon,p.lat,ARCHIPELAGOS);return {tile:null,realmId:null,exploration:{chainId:s.explorationId,islandId:island?.featureId??null}};}
   const tile=s.deedEligible?resolveTile(cellAt(p.lon,p.lat)):null;
   return {tile,realmId:REGIONS[s.region]?.id??null,exploration:null};
 }
 function draw(view,{selectedTileId=null,worldMarkers=[],realmId='crownlands',scale=1,interacting=false}={}){
   if(!alive)return;
   const start=performance.now();lastView=normalizedView(view);cam.lon=lastView.lon*RAD;cam.lat=lastView.lat*RAD;cam.zoom=lastView.zoom;cssScale=scale;
   selectedCell=selectedTileId??-1;selectedRealm=realmId;
   if(markerSource!==worldMarkers){
     markerSource=worldMarkers;
     markers=worldMarkers.flatMap(m=>{const tile=resolveTile(m.tileId);return tile?[{...m,realmId:tile.realmId,lon:tile.lon*RAD,lat:tile.lat*RAD}]:[];});
     owned=new Set(markers.filter(m=>m.owned).map(m=>m.tileId));occupied=new Set(markers.map(m=>m.tileId));
   }
   const R=radius(),c0=Math.cos(cam.lat),s0=Math.sin(cam.lat),showGrid=R*STEP>=3,footprint=R*TAU/TW;
   // Only sampling density changes during a gesture. The visible canvas,
   // projection, marker coordinates and authoritative picking stay unchanged.
   // Retain both buffers so repeated gestures do not allocate frame-sized data.
   const motion=interacting?getMotionRaster():null,output=motion?.frame??frame;
   const rw=motion?.canvas.width??width,rh=motion?.canvas.height??height,sx=width/rw,sy=height/rh,pixels=motion?.frame.data??bytes,cells=motion?.cells??cellPixels,grid=motion?.grid??gridPixels;
   cells.fill(-1);grid.fill(0);detail.beginFrame();
   for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){
     const px=(x+.5)*sx-.5,py=(y+.5)*sy-.5;
     const i=(y*rw+x)*4,nx=(px-centerX)/R,ny=(centerY-py)/R,r2=nx*nx+ny*ny;let r=11,g=14,b=20;
     if(r2<=1){
       const z=Math.sqrt(1-r2),lat=Math.asin(clamp(ny*c0+z*s0,-1,1)),lon=cam.lon+Math.atan2(nx,z*c0-ny*s0),index=textureIndex(lon,lat,TW,TH),idx=index*3,sun=nx*-.38+ny*.44+z*.79,light=sun>.23?1:sun>-.12?.72:.4;
       const fine=ready&&islandAreas[index]&&footprint>1.5?detail.island(lon,lat,explorationMap[index]):null;
       const regional=ready&&!fine&&regionMap[index]>=0&&!explorationMap[index]?detail.regionColor(lon,lat,regionMap[index],footprint,regionSample):null,blend=regional?clamp((footprint-.8)/.7,0,1):0;
       r=(fine?fine.color[0]:texture[idx]*(1-blend)+(regional?.[0]??0)*blend)*light;g=(fine?fine.color[1]:texture[idx+1]*(1-blend)+(regional?.[1]??0)*blend)*light;b=(fine?fine.color[2]:texture[idx+2]*(1-blend)+(regional?.[2]??0)*blend)*light;
       if((fine?!fine.visibleLand:regionMap[index]<0)&&cam.zoom>1){const ocean=sampleOceanColor(lon,lat,oceanSample),mix=clamp((cam.zoom-1)/2,0,1);r=r*(1-mix)+ocean[0]*light*mix;g=g*(1-mix)+ocean[1]*light*mix;b=b*(1-mix)+ocean[2]*light*mix;}
       if(z<.11){r=r*.55+38;g=g*.65+43;b=b*.7+45;}
       if(showGrid&&!fine&&deedMap[index]){
         const cell=cellAt(lon,lat);
         if(!tileEligibility[cell])tileEligibility[cell]=resolveTile(cell)?1:-1;
         if(tileEligibility[cell]>0){cells[y*rw+x]=cell;grid[y*rw+x]=gridVisible(R,lat,z)?1:0;}
         if(cell===selectedCell||owned.has(cell)||occupied.has(cell)){
           const tint=cell===selectedCell?[244,215,123]:owned.has(cell)?[227,174,60]:[121,191,191],amount=cell===selectedCell?.4:.2;
           r=r*(1-amount)+tint[0]*amount;g=g*(1-amount)+tint[1]*amount;b=b*(1-amount)+tint[2]*amount;
         }
       }
     }else if(r2<1.023){r=42;g=76;b=75;}else if(r2<1.055&&((Math.floor(px)+Math.floor(py))&1)===0){r=21;g=42;b=37;}
     pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;pixels[i+3]=255;
   }
   detail.finishFrame();
   if(showGrid)for(let y=1;y<rh;y++)for(let x=1;x<rw;x++){
     const k=y*rw+x,cell=cells[k];if(cell<0||!grid[k])continue;const left=cells[k-1],up=cells[k-rw];
     if((left>=0&&left!==cell)||(up>=0&&up!==cell)){
       const strong=cell===selectedCell||left===selectedCell||up===selectedCell,gold=strong||owned.has(cell)||owned.has(left)||owned.has(up),color=gold?[244,215,123]:[36,47,42],a=strong?.95:gold?.7:.42,i=k*4;
       for(let ch=0;ch<3;ch++)pixels[i+ch]=pixels[i+ch]*(1-a)+color[ch]*a;
     }
   }
   if(motion){
     motion.ctx.putImageData(output,0,0);
     const smoothing=ctx.imageSmoothingEnabled;ctx.imageSmoothingEnabled=false;
     ctx.drawImage(motion.canvas,0,0,width,height);ctx.imageSmoothingEnabled=smoothing;
   }else ctx.putImageData(frame,0,0);
   drawSanctuary(ctx,cam,R,centerX,centerY);frames++;frameMs=performance.now()-start;
 }
 /** Overlay layout runs after keep grouping, without redrawing the terrain.
  * Bounds, sizes and exclusions use the same raster coordinates as projection. */
 function realmLabels(options={}){
   return layoutRealmLabels(REGIONS,cam,radius(),{width,height,centerX,centerY,selectedIndex:REGIONS.findIndex(r=>r.id===selectedRealm),...options,sizes:options.sizes??REGIONS.map(r=>({width:(r.name.length*7+18)/cssScale,height:28/cssScale}))});
 }
 function markerPositions(){
   const R=radius();
   return markers.flatMap(m=>{
     const p=project(m.lon,m.lat,cam),x=centerX+p.x*R,y=centerY+p.y*R;
     if(p.z<=.15||x<=0||x>=width||y<=0||y>=height)return [];
     const west=project(m.lon-STEP/2,m.lat,cam),east=project(m.lon+STEP/2,m.lat,cam);
     const north=project(m.lon,m.lat+STEP/2,cam),south=project(m.lon,m.lat-STEP/2,cam);
     return [{...m,x,y,z:p.z,parcelWidth:Math.abs(east.x-west.x)*R,parcelHeight:Math.abs(north.y-south.y)*R}];
   });
 }
 return {ready:initialReady,resize,draw,realmLabels,pick,markerPositions,surfaceAt,animate(time,force=false){if(alive){clouds.draw(time,force);effects.draw(time,force);}},setCloudMotion(value){clouds.setMotion(value);},retry(){detail.retry();return Promise.all([load(),clouds.retry()]).then(()=>{});},stats(){return {frames,frameMs,ready,view:lastView,...detail.stats()};},dispose(){alive=false;releaseMotionRaster();clouds.dispose();detail.dispose();ctx.clearRect(0,0,width,height);effectCanvas.getContext('2d')?.clearRect(0,0,width,height);}};
}
