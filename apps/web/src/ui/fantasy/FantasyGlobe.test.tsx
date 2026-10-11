/** @vitest-environment happy-dom */
import { act, createRef, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fantasyTileAt } from '@shardkeep/shared/fantasyWorld';
import type { RealmLabelLayout } from './runtime/renderer.mjs';
import { createMobileBackGuard, registerMobileBackHandler, type MobileBackWindow } from '../../lib/mobileBackGuard';
const hooks=vi.hoisted(()=>({startRead:false,reportDetailStatus:vi.fn<(status:{pending:boolean;error:unknown|null})=>void>(),requestDetails:vi.fn<(path:string)=>Promise<FantasyPixels>>(),requestPixels:vi.fn<(path:string)=>Promise<FantasyPixels>>(),pick:vi.fn(),dispose:vi.fn(),realmLabels:vi.fn((_options?:RealmLabelLayout)=>[]),draw:vi.fn((_view?:unknown,_options?:{worldMarkers?:readonly FantasyWorldMarker[];interacting?:boolean})=>[]),animate:vi.fn(),read:vi.fn(),motion:vi.fn(),resize:vi.fn(),positions:vi.fn(),reportError:vi.fn(),retry:vi.fn(async()=>{})}));
vi.mock('./art',()=>({loadFantasyPixels:hooks.read}));
vi.mock('./runtime/renderer.mjs',async importOriginal=>{
 const actual=await importOriginal<typeof import('./runtime/renderer.mjs')>();
 return {...actual,createFantasyRenderer:({canvas,onError,read,readDetail,onDetailStatus}:{canvas:HTMLCanvasElement;onError(cause:unknown):void;read(path:string):Promise<FantasyPixels>;readDetail(path:string):Promise<FantasyPixels>;onDetailStatus(status:{pending:boolean;error:unknown|null}):void})=>{hooks.reportError.mockImplementation(onError);hooks.reportDetailStatus.mockImplementation(onDetailStatus);hooks.requestDetails.mockImplementation(readDetail);hooks.requestPixels.mockImplementation(read);const ready=hooks.startRead?read('realm-texture.png').then(()=>{}):Promise.resolve();void ready.catch(onError);return {ready,resize:(w:number,h:number,x:number,y:number)=>{canvas.width=w;canvas.height=h;hooks.resize(w,h,x,y);},draw:hooks.draw,realmLabels:hooks.realmLabels,pick:hooks.pick,markerPositions:hooks.positions,animate:hooks.animate,dispose:hooks.dispose,setCloudMotion:hooks.motion,stats:()=>null,retry:hooks.retry};}};
});
import type { FantasyPixels } from './art';
import { FantasyGlobe, type FantasyWorldMarker, type FantasyGlobeHandle } from './FantasyGlobe';
let host:HTMLDivElement,root:Root,frame:FrameRequestCallback|undefined;
async function paint(){await act(async()=>{const next=frame;frame=undefined;next?.(performance.now());});}
beforeEach(()=>{
 (globalThis as typeof globalThis &{IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 vi.stubGlobal('requestAnimationFrame',vi.fn((callback:FrameRequestCallback)=>{frame=callback;return 1;}));vi.stubGlobal('cancelAnimationFrame',vi.fn());
 hooks.startRead=false;
 hooks.draw.mockImplementation(()=>[]);hooks.realmLabels.mockImplementation(()=>[]);
 hooks.positions.mockImplementation(()=>{const markers=hooks.draw.mock.calls.at(-1)?.[1]?.worldMarkers??[];return markers.map((marker:FantasyWorldMarker,index:number)=>({...marker,x:200+index*100,y:200,z:1}));});
 hooks.pick.mockReturnValue({tile:fantasyTileAt(26,23),realmId:'crownlands',exploration:null});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.clearAllMocks();vi.restoreAllMocks();});
async function mount(reduceMotion=false){const control=createRef<FantasyGlobeHandle>(),onSelect=vi.fn(),onExplore=vi.fn();await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={reduceMotion} onSelect={onSelect} onExplore={onExplore} onRealmSelect={vi.fn()}/>));return {control,onSelect,onExplore,canvas:host.querySelector('canvas')!};}
const event=(kind:string,id=1,x=200,y=200)=>new PointerEvent(kind,{bubbles:true,pointerId:id,pointerType:'touch',clientX:x,clientY:y});
// Happy DOM does not implement the browser's pending pointer-capture override.
// hasPointerCapture reflects set/release immediately, before capture events fire.
function surfaceCapture(surface:HTMLDivElement){
 const captured=new Set<number>();
 surface.setPointerCapture=vi.fn(id=>{captured.add(id);});
 surface.hasPointerCapture=vi.fn(id=>captured.has(id));
 surface.releasePointerCapture=vi.fn(id=>{captured.delete(id);});
 return captured;
}
describe('native fantasy globe gestures',()=>{
 it.each([[390,844],[844,320]])('keeps selected parcel targets and measured label exclusions in the same coordinates at %dx%d',async(width,height)=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    return this.classList.contains('fantasy-controls')?new DOMRect(0,height-44,150,44):new DOMRect(0,0,width,height);
  });
  const measure=vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(118);
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(32);
  const tile=fantasyTileAt(26,23)!,other=fantasyTileAt(26.5,23)!,control=createRef<FantasyGlobeHandle>(),onRealmSelect=vi.fn();
  hooks.positions.mockImplementation(()=>[tile,other].map((t,index)=>({tileId:t.tileId,name:'Keeper',realmId:'crownlands',x:100+index,y:100,z:1})));
  await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={false} selectedTileId={tile.tileId} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={onRealmSelect}/>));
  await paint();
  const canvas=host.querySelector('canvas')!,marker=host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!;
  expect(marker.classList.contains('selected')).toBe(true);
  expect(marker.querySelector('.fantasy-owner-count')?.textContent).toBe('2');
  expect(marker.style.width).toBe('176px');expect(marker.style.height).toBe('44px');
  const options=hooks.realmLabels.mock.calls.at(-1)![0]!,x=Number.parseFloat(marker.style.left),y=Number.parseFloat(marker.style.top);
  expect(options.exclude).toEqual([{left:expect.closeTo((x-88)*canvas.width/width,5),right:expect.closeTo((x+88)*canvas.width/width,5),
    top:expect.closeTo((y-22)*canvas.height/height,5),bottom:expect.closeTo((y+22)*canvas.height/height,5)}]);
  expect(options.sizes?.[0]).toEqual({width:expect.closeTo(118*canvas.width/width,5),height:expect.closeTo(32*canvas.height/height,5)});
  // Hiding the map label does not disable the navigation rail's focus command.
  expect([...host.querySelectorAll<HTMLButtonElement>('.fantasy-realm-label')].every(node=>node.hidden)).toBe(true);
  measure.mockClear();act(()=>control.current!.focusRealm('crownlands'));await paint();
  expect(onRealmSelect).toHaveBeenCalledWith('crownlands');
  expect(measure).not.toHaveBeenCalled();
 });
 it.each([[844,320],[390,844],[1440,900]])('reclaims panel space immediately when collapsed at %dx%d',async(width,height)=>{
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    // Keep the old large panel rect even when closed: visibility is explicit,
    // not inferred from a stale ResizeObserver size or the toggle's width.
    if(this.classList.contains('fantasy-world-panel'))return width>760?new DOMRect(width-288,112,280,height-120):new DOMRect(0,height*.62,width,height*.38);
    if(this.classList.contains('fantasy-world-tools'))return new DOMRect(8,108,450,44);
    if(this.classList.contains('fantasy-controls'))return new DOMRect(8,height-58,150,34);
    return new DOMRect(0,0,width,height);
  });
  const control=createRef<FantasyGlobeHandle>(),onViewportChange=vi.fn();
  const render=async(panelOpen:boolean)=>act(async()=>root.render(<div className={`fantasy-world ${panelOpen?'':'panel-closed'}`}><div className="fantasy-world-tools"/><aside className="fantasy-world-panel"/><FantasyGlobe ref={control} panelOpen={panelOpen} reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onViewportChange={onViewportChange}/></div>));
  await render(true);
  const canvas=host.querySelector('canvas')!,open=onViewportChange.mock.calls.at(-1)![0];
  act(()=>control.current!.setView({lon:-17,lat:4,zoom:3}));
  const view=control.current!.view();
  await render(false);
  const closed=onViewportChange.mock.calls.at(-1)![0];
  expect(closed.centerX).toBe(closed.width/2);
  if(width>760)expect(closed.centerX).toBeGreaterThan(open.centerX);
  else expect(closed.centerY).toBeGreaterThan(open.centerY);
  expect(host.querySelector('canvas')).toBe(canvas);
  expect(control.current!.view()).toEqual(view);
  expect(hooks.dispose).not.toHaveBeenCalled();
  act(()=>canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  expect(hooks.pick.mock.calls.at(-1)?.slice(0,2)).toEqual([closed.centerX,closed.centerY]);
  await render(true);
  expect(onViewportChange.mock.calls.at(-1)![0]).toEqual(open);
  expect(control.current!.view()).toEqual(view);
 });
 it('fills rectangular screens and keeps pointer/keyboard focus outside the overlaid detail panel',async()=>{
  let width=1440,height=900;
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    if(this.classList.contains('fantasy-world-panel'))return width>760?new DOMRect(width-344,140,330,height-154):new DOMRect(0,height*.62,width,height*.38);
    if(this.classList.contains('fantasy-world-tools'))return new DOMRect(14,124,width>760?600:width-28,42);
    if(this.classList.contains('fantasy-controls'))return new DOMRect(14,height-70,150,40);
    return new DOMRect(0,0,width,height);
  });
  const onViewportChange=vi.fn(),onSelect=vi.fn();
  await act(async()=>root.render(<div className="fantasy-world"><div className="fantasy-world-tools"/><aside className="fantasy-world-panel"/><FantasyGlobe reduceMotion={false} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()} onViewportChange={onViewportChange}/></div>));
  const canvas=host.querySelector('canvas')!;
  const check=()=>{
    const current=onViewportChange.mock.calls.at(-1)![0];
    expect(canvas.width*canvas.height).toBeLessThanOrEqual(160000);
    expect(Math.abs(canvas.width/canvas.height-width/height)).toBeLessThan(.01);
    const x=current.centerX/current.width*width,y=current.centerY/current.height*height;
    if(width>760)expect(x).toBeLessThan(width-344);else expect(y).toBeLessThan(height*.62);
    expect(y).toBeGreaterThan(166);
    act(()=>canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
    expect(hooks.pick.mock.calls.at(-1)?.slice(0,2)).toEqual([current.centerX,current.centerY]);
    act(()=>{canvas.dispatchEvent(event('pointerdown',1,x,y));canvas.dispatchEvent(event('pointerup',1,x,y));});
    expect(hooks.pick.mock.calls.at(-1)?.[0]).toBeCloseTo(current.centerX);
    expect(hooks.pick.mock.calls.at(-1)?.[1]).toBeCloseTo(current.centerY);
  };
  check();width=390;height=844;act(()=>window.dispatchEvent(new Event('resize')));check();
  width=844;height=390;act(()=>window.dispatchEvent(new Event('resize')));check();
 });
 it('refits an automatically inspected island after layout changes but preserves subsequent manual zoom',async()=>{
  let width=844,height=390;
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    if(this.classList.contains('fantasy-world-panel'))return width>760?new DOMRect(width-288,112,280,height-120):new DOMRect(0,height*.62,width,height*.38);
    if(this.classList.contains('fantasy-world-tools'))return new DOMRect(8,108,450,44);
    if(this.classList.contains('fantasy-controls'))return new DOMRect(8,height-58,150,34);
    return new DOMRect(0,0,width,height);
  });
  const control=createRef<FantasyGlobeHandle>();
  await act(async()=>root.render(<div className="fantasy-world"><div className="fantasy-world-tools"/><aside className="fantasy-world-panel"/><FantasyGlobe ref={control} reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()}/></div>));
  act(()=>control.current?.focusIsland('lumenreef','lumenreef-4'));
  const landscape=control.current!.view().zoom;
  expect(landscape).toBeLessThan(30);
  width=390;height=844;act(()=>window.dispatchEvent(new Event('resize')));
  expect(control.current!.view().zoom).toBeGreaterThan(landscape);
  act(()=>host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
  const manual=control.current!.view().zoom;
  width=844;height=390;act(()=>window.dispatchEvent(new Event('resize')));
  expect(control.current!.view().zoom).toBe(manual);
 });
 it('reports terrain loading and retry to the fixed HUD while preserving real base icon markers',async()=>{
  const onTerrainStatus=vi.fn(),tile=fantasyTileAt(26,23)!;
  await act(async()=>root.render(<FantasyGlobe reduceMotion={false} markers={[{tileId:tile.tileId,name:'Real owner',keepLevel:3}]} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onTerrainStatus={onTerrainStatus}/>));
  expect(onTerrainStatus.mock.calls[0]?.[0].pending).toBe(true);
  expect(onTerrainStatus.mock.calls.at(-1)?.[0].pending).toBe(false);
  expect(host.querySelector('.fantasy-load')).toBeNull();
  await paint();
  expect(host.querySelector('.fantasy-owner-marker img')).not.toBeNull();
  act(()=>hooks.reportError(new Error('Offline')));
  const status=onTerrainStatus.mock.calls.at(-1)![0];
  expect(status.error).toBe('Offline');
  await act(async()=>status.retry());
  expect(hooks.retry).toHaveBeenCalledOnce();
  expect(onTerrainStatus.mock.calls.at(-1)?.[0]).toMatchObject({pending:false,error:null});
 });
 it('presents occupied groups as static keep counts and zooms without inspecting an arbitrary deed',async()=>{
  const tile=fantasyTileAt(26,23)!,onSelect=vi.fn(),onRealmSelect=vi.fn(),control=createRef<FantasyGlobeHandle>();
  await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={false} markers={[{tileId:tile.tileId,name:'12 deeds',cluster:{count:12,realmId:'crownlands'}}]} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={onRealmSelect}/>));
  await paint();
  const marker=host.querySelector<HTMLButtonElement>('.fantasy-owner-cluster')!;
  expect(marker.getAttribute('aria-label')).toBe('12 assigned deeds in Crownlands. Zoom to inspect bases.');
  expect(marker.querySelector('img')).not.toBeNull();
  expect(marker.querySelector('.fantasy-owner-count')?.textContent).toBe('12');
  expect(marker.querySelector('.fantasy-owner-name')).toBeNull();
  await act(async()=>marker.click());
  expect(onRealmSelect).toHaveBeenCalledWith('crownlands');
  expect(control.current!.view().zoom).toBeGreaterThan(5);
  expect(onSelect).not.toHaveBeenCalled();
 });
 it('keeps a real owner marker individually inspectable',async()=>{
  const tile=fantasyTileAt(26,23)!,onSelect=vi.fn();
  await act(async()=>root.render(<FantasyGlobe reduceMotion={false} markers={[{tileId:tile.tileId,name:'Real keeper',keepLevel:4}]} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));
  await paint();
  expect(host.querySelector('.fantasy-owner-cluster')).toBeNull();
  await act(async()=>host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!.click());
  expect(onSelect).toHaveBeenCalledWith(tile);
 });
 it('a marker-origin pinch owns the map and cannot inspect a deed through the ending click',async()=>{
  const tile=fantasyTileAt(26,23)!,onSelect=vi.fn(),control=createRef<FantasyGlobeHandle>();
  await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={false} markers={[{tileId:tile.tileId,name:'Real keeper'}]} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));
  await paint();
  const marker=host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!,canvas=host.querySelector('canvas')!;
  const surface=host.querySelector<HTMLDivElement>('.fantasy-globe')!,capture=vi.fn();surface.setPointerCapture=capture;
  act(()=>{marker.dispatchEvent(event('pointerdown',1,150));canvas.dispatchEvent(event('pointerdown',2,250));canvas.dispatchEvent(event('pointermove',2,350));canvas.dispatchEvent(event('pointerup',2,350));marker.dispatchEvent(event('pointerup',1,150));marker.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  expect(control.current!.view().zoom).toBe(2);expect(onSelect).not.toHaveBeenCalled();
 expect(capture.mock.calls).toEqual([[1],[2]]);
  // Keyboard activation still works after a gesture, without manufacturing a tap.
  act(()=>marker.click());expect(onSelect).toHaveBeenCalledWith(tile);
 });
 it.each(['canvas','marker'] as const)('keeps dragging at parcel zoom after implicit %s capture transfers to the stable surface',async(start)=>{
  const tile=fantasyTileAt(26,23)!,onSelect=vi.fn(),control=createRef<FantasyGlobeHandle>();
  await act(async()=>root.render(<FantasyGlobe ref={control} view={{lon:26,lat:23,zoom:23.6}} reduceMotion={false} markers={[{tileId:tile.tileId,name:'Real keeper'}]} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));await paint();
  const canvas=host.querySelector('canvas')!,surface=host.querySelector<HTMLDivElement>('.fantasy-globe')!;
  const target=start==='canvas'?canvas:host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!;
  surfaceCapture(surface);
  act(()=>{target.dispatchEvent(event('pointerdown',1,180));target.dispatchEvent(event('pointermove',1,220));});
  const first=control.current!.view();
  expect(surface.hasPointerCapture(1)).toBe(true);
  // Real touch browsers fire the old child's bubbling loss before the next
  // move goes to its new parent owner. This is a transfer, not an ended touch.
  act(()=>{target.dispatchEvent(event('lostpointercapture',1,220));surface.dispatchEvent(event('gotpointercapture',1,220));surface.dispatchEvent(event('pointermove',1,260));});
  const second=control.current!.view();
  expect(second.lon).toBeLessThan(first.lon);
  expect(second.zoom).toBe(23.6);
  act(()=>{surface.dispatchEvent(event('pointermove',1,300));surface.dispatchEvent(event('pointerup',1,300));surface.dispatchEvent(event('lostpointercapture',1,300));target.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  expect(control.current!.view().lon).toBeLessThan(second.lon);
  expect(onSelect).not.toHaveBeenCalled();
 });
 it.each(['canvas','marker'] as const)('keeps both contacts through implicit %s capture transfer and continues dragging after a pinch',async(start)=>{
  const tile=fantasyTileAt(26,23)!,onSelect=vi.fn(),control=createRef<FantasyGlobeHandle>();
  await act(async()=>root.render(<FantasyGlobe ref={control} view={{lon:26,lat:23,zoom:23.6}} reduceMotion={false} markers={[{tileId:tile.tileId,name:'Real keeper'}]} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));await paint();
  const canvas=host.querySelector('canvas')!,surface=host.querySelector<HTMLDivElement>('.fantasy-globe')!;
  const target=start==='canvas'?canvas:host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!;
  surfaceCapture(surface);
  act(()=>{target.dispatchEvent(event('pointerdown',1,150));canvas.dispatchEvent(event('pointerdown',2,250));
   target.dispatchEvent(event('lostpointercapture',1,150));surface.dispatchEvent(event('gotpointercapture',1,150));
   canvas.dispatchEvent(event('lostpointercapture',2,250));surface.dispatchEvent(event('gotpointercapture',2,250));
   surface.dispatchEvent(event('pointermove',2,350));});
  expect(control.current!.view().zoom).toBe(47.2);
  // The marker may disappear in the newly grouped layout while its contacts
  // remain captured by the stable surface.
  hooks.positions.mockReturnValue([]);await paint();
  const before=control.current!.view();
  act(()=>{surface.dispatchEvent(event('pointerup',2,350));surface.dispatchEvent(event('lostpointercapture',2,350));surface.dispatchEvent(event('pointermove',1,190));});
  expect(control.current!.view().lon).toBeLessThan(before.lon);
  act(()=>{surface.dispatchEvent(event('pointerup',1,190));surface.dispatchEvent(event('lostpointercapture',1,190));surface.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  expect(onSelect).not.toHaveBeenCalled();
 });
 it.each(['lostpointercapture','pointercancel'] as const)('a genuine surface %s ends the old gesture without stranding the next touch',async(kind)=>{
  const {canvas,onSelect,control}=await mount(),surface=host.querySelector<HTMLDivElement>('.fantasy-globe')!;
  const captured=surfaceCapture(surface);
  act(()=>{canvas.dispatchEvent(event('pointerdown',1,180));canvas.dispatchEvent(event('pointermove',1,220));canvas.dispatchEvent(event('lostpointercapture',1,220));});
  const before=control.current!.view();
  act(()=>{captured.delete(1);surface.dispatchEvent(event(kind,1,220));surface.dispatchEvent(event('pointermove',1,300));surface.dispatchEvent(event('pointerup',1,300));});
  expect(control.current!.view()).toEqual(before);expect(onSelect).not.toHaveBeenCalled();
  act(()=>{canvas.dispatchEvent(event('pointerdown',2));canvas.dispatchEvent(event('pointerup',2));});
  expect(onSelect).toHaveBeenCalledOnce();expect(control.current!.view().zoom).toBe(before.zoom);
 });
 it('dragging a marker does not inspect it, while an ordinary marker tap inspects once',async()=>{
  const tile=fantasyTileAt(26,23)!,onSelect=vi.fn(),control=createRef<FantasyGlobeHandle>();
  await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={false} markers={[{tileId:tile.tileId,name:'Real keeper'}]} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));await paint();
  const marker=host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!;
  act(()=>{marker.dispatchEvent(event('pointerdown',1,180));marker.dispatchEvent(event('pointermove',1,230));marker.dispatchEvent(event('pointerup',1,230));marker.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  expect(control.current!.view().lon).not.toBeCloseTo(26);expect(onSelect).not.toHaveBeenCalled();
  act(()=>{marker.dispatchEvent(event('pointerdown',2));marker.dispatchEvent(event('pointerup',2));marker.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(tile);
 });
 it('clusters overlapping real owners, keeps only the selected name, and expands without selecting an arbitrary member',async()=>{
  const tile=fantasyTileAt(26,23)!,other=fantasyTileAt(26.5,23)!,onSelect=vi.fn(),control=createRef<FantasyGlobeHandle>();
  const markers=[{tileId:tile.tileId,name:'Selected keeper'},{tileId:other.tileId,name:'Other keeper'}];
  hooks.positions.mockImplementation(()=>markers.map(marker=>({...marker,x:200,y:200,z:1})));
  await act(async()=>root.render(<FantasyGlobe ref={control} view={{lon:26,lat:23,zoom:40}} selectedTileId={tile.tileId} reduceMotion={false} markers={markers} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));await paint();
  expect(host.querySelectorAll('.fantasy-owner-marker')).toHaveLength(1);
  expect(host.querySelector('.fantasy-owner-name')?.textContent).toBe('Selected keeper');
  expect(host.querySelector('.fantasy-owner-count')?.textContent).toBe('2');
  act(()=>host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!.click());
  expect(control.current!.view().zoom).toBe(80);expect(onSelect).not.toHaveBeenCalled();
 });
 it('wheel zoom over a marker updates the camera immediately but publishes one settled viewport',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try{
   const tile=fantasyTileAt(26,23)!,onViewChange=vi.fn(),control=createRef<FantasyGlobeHandle>();
   await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={false} markers={[{tileId:tile.tileId,name:'Real keeper'}]} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onViewChange={onViewChange}/>));await paint();
   const marker=host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!;
   act(()=>{for(let i=0;i<20;i++)marker.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-10}));});
   expect(control.current!.view().zoom).toBeGreaterThan(1);expect(onViewChange).not.toHaveBeenCalled();
   act(()=>vi.advanceTimersByTime(120));expect(onViewChange).toHaveBeenCalledOnce();
  }finally{vi.useRealTimers();}
 });
 it('offers every overlapping deed at maximum zoom without trapping list scroll in the map',async()=>{
  const tile=fantasyTileAt(26,23)!,other=fantasyTileAt(26.5,23)!,onSelect=vi.fn(),control=createRef<FantasyGlobeHandle>();
  const markers=[{tileId:tile.tileId,name:'First keeper'},{tileId:other.tileId,name:'Second keeper'}];
  hooks.positions.mockImplementation(()=>markers.map(marker=>({...marker,x:200,y:200,z:1})));
  await act(async()=>root.render(<FantasyGlobe ref={control} view={{lon:26,lat:23,zoom:256}} reduceMotion={false} markers={markers} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));await paint();
  const marker=host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!;
  expect(marker.getAttribute('aria-label')).toContain('Choose a base.');
  act(()=>marker.click());
  const dialog=host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.closest('.fantasy-globe')).toBeNull();expect(dialog.querySelectorAll('li')).toHaveLength(2);
  expect(document.activeElement).toBe(dialog.querySelector('[aria-label="Close nearby deeds"]'));
  const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100});act(()=>dialog.dispatchEvent(wheel));
  expect(wheel.defaultPrevented).toBe(false);expect(control.current!.view().zoom).toBe(256);
  act(()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  expect(host.querySelector('[role="dialog"]')).toBeNull();expect(document.activeElement).toBe(host.querySelector('canvas'));
  act(()=>marker.click());act(()=>host.querySelectorAll<HTMLButtonElement>('[role="dialog"] li button')[1]!.click());
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(other);expect(host.querySelector('[role="dialog"]')).toBeNull();
 });
 it('Android Back closes nearby deeds before the world handler and releases ownership on unmount',async()=>{
  const tile=fantasyTileAt(26,23)!,other=fantasyTileAt(26.5,23)!,onSelect=vi.fn();
  const markers=[{tileId:tile.tileId,name:'First keeper'},{tileId:other.tileId,name:'Second keeper'}];
  hooks.positions.mockImplementation(()=>markers.map(marker=>({...marker,x:200,y:200,z:1})));
  await act(async()=>root.render(<FantasyGlobe view={{lon:26,lat:23,zoom:256}} reduceMotion={false} markers={markers} onSelect={onSelect} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));await paint();
  const marker=host.querySelector<HTMLButtonElement>('.fantasy-owner-marker')!;
  act(()=>marker.click());
  const target=new EventTarget();let historyState:unknown=null;
  const win:MobileBackWindow={
   location:{href:'https://play.pixelkingdomwars.com/?client=solana-mobile'},
   history:{get state(){return historyState;},pushState(value){historyState=value;},back(){historyState=null;target.dispatchEvent(new Event('popstate'));}},
   addEventListener:target.addEventListener.bind(target),removeEventListener:target.removeEventListener.bind(target),
   setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window),
  };
  const worldBack=vi.fn(),goToBase=vi.fn();
  // Register later than the dialog: priority must beat the world's mount order.
  const offWorld=registerMobileBackHandler(worldBack,100);
  const dispose=createMobileBackGuard({win,enabled:true,trustedActivation:()=>true,getScreen:()=>'world',goToBase,toast:vi.fn()});
  try{
   target.dispatchEvent(new Event('pointerdown'));
   act(()=>win.history.back());
   expect(host.querySelector('[role="dialog"]')).toBeNull();
   expect(document.activeElement).toBe(host.querySelector('canvas'));
   expect(worldBack).not.toHaveBeenCalled();expect(onSelect).not.toHaveBeenCalled();expect(goToBase).not.toHaveBeenCalled();
   act(()=>win.history.back());expect(worldBack).toHaveBeenCalledOnce();
   act(()=>marker.click());expect(host.querySelector('[role="dialog"]')).not.toBeNull();
   await act(async()=>root.render(null));
   act(()=>win.history.back());expect(worldBack).toHaveBeenCalledTimes(2);
  }finally{dispose();offWorld();}
 });
 it('pinching from zoom controls changes only the map gesture, while a later tap still works',async()=>{
  const {control,onSelect,canvas}=await mount(),button=host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!;
  act(()=>{button.dispatchEvent(event('pointerdown',1,150));canvas.dispatchEvent(event('pointerdown',2,250));canvas.dispatchEvent(event('pointermove',2,350));canvas.dispatchEvent(event('pointerup',2,350));button.dispatchEvent(event('pointerup',1,150));button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  expect(control.current!.view().zoom).toBe(2);expect(onSelect).not.toHaveBeenCalled();
  act(()=>{button.dispatchEvent(event('pointerdown',3));button.dispatchEvent(event('pointerup',3));button.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));});
  expect(control.current!.view().zoom).toBe(2.5);expect(onSelect).not.toHaveBeenCalled();
 });
 it('renders an automatic owner name only when the renderer reports a sufficiently large parcel',async()=>{
  const tile=fantasyTileAt(26,23)!,markers=[{tileId:tile.tileId,name:'Readable keeper'}];let parcelWidth=80;
  hooks.positions.mockImplementation(()=>markers.map(marker=>({...marker,x:200,y:200,z:1,parcelWidth,parcelHeight:80})));
  const control=createRef<FantasyGlobeHandle>();
  await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={false} markers={markers} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()}/>));await paint();
  expect(host.querySelector('.fantasy-owner-name')).toBeNull();
  parcelWidth=200;act(()=>control.current!.setView({lon:26,lat:23,zoom:128}));await paint();
  expect(host.querySelector('.fantasy-owner-name')?.textContent).toBe('Readable keeper');
 });
 it('a tap only selects the typed server catalogue tile',async()=>{const {canvas,onSelect}=await mount();act(()=>{canvas.dispatchEvent(event('pointerdown'));canvas.dispatchEvent(event('pointerup'));});expect(onSelect).toHaveBeenCalledOnce();expect(onSelect.mock.calls[0]![0]).toMatchObject({worldId:'fantasy-v1',realmId:'crownlands'});});
 it('cancellation and lost capture never inspect land',async()=>{const {canvas,onSelect}=await mount();act(()=>{canvas.dispatchEvent(event('pointerdown'));canvas.dispatchEvent(event('pointercancel'));canvas.dispatchEvent(event('pointerup'));});expect(onSelect).not.toHaveBeenCalled();});
 it('off-canvas release cannot turn the next finger into a phantom pinch',async()=>{const {canvas,onSelect,control}=await mount();act(()=>{canvas.dispatchEvent(event('pointerdown'));window.dispatchEvent(event('pointerup'));canvas.dispatchEvent(event('pointerdown',2));canvas.dispatchEvent(event('pointerup',2));});expect(onSelect).toHaveBeenCalledOnce();expect(control.current?.view().zoom).toBe(1);});
 it('a pinch changes zoom without selecting the underlying tile',async()=>{const {canvas,onSelect,control}=await mount();act(()=>{canvas.dispatchEvent(event('pointerdown',1,150));canvas.dispatchEvent(event('pointerdown',2,250));canvas.dispatchEvent(event('pointermove',2,350));canvas.dispatchEvent(event('pointerup',2,350));canvas.dispatchEvent(event('pointerup',1,150));});expect(control.current?.view().zoom).toBe(2);expect(onSelect).not.toHaveBeenCalled();});
 it('island inspection has a separate callback and never returns a deed',async()=>{const {canvas,onSelect,onExplore}=await mount();hooks.pick.mockReturnValue({tile:null,realmId:null,exploration:{chainId:'mintwake',islandId:'mintwake-1'}});act(()=>{canvas.dispatchEvent(event('pointerdown'));canvas.dispatchEvent(event('pointerup'));});expect(onSelect).not.toHaveBeenCalled();expect(onExplore).toHaveBeenCalledWith({chainId:'mintwake',islandId:'mintwake-1'});});
 it('keyboard inspection and imperative focus share the same geography',async()=>{const {canvas,onSelect,control}=await mount();act(()=>{control.current?.focusRealm('seeker-reach');canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});expect(control.current?.view().lon).toBeCloseTo(-115);expect(control.current?.view().lat).toBe(38);expect(hooks.pick.mock.calls.at(-1)?.slice(0,2)).toEqual([200,200]);expect(hooks.pick.mock.calls.at(-1)?.[2].lon).toBeCloseTo(-115);expect(onSelect).toHaveBeenCalledOnce();});
 it('keyboard selection uses the latest camera even before another raster frame',async()=>{const {canvas,control}=await mount();act(()=>{control.current?.setView({lon:-115,lat:38,zoom:16});canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});expect(hooks.pick.mock.calls.at(-1)?.[2]).toEqual(control.current?.view());expect(hooks.pick.mock.calls.at(-1)?.[2].zoom).toBe(16);});
 it('keeps browser zoom shortcuts available while the canvas is focused',async()=>{const {canvas,control}=await mount();const ctrl=new KeyboardEvent('keydown',{key:'+',ctrlKey:true,bubbles:true,cancelable:true}),meta=new KeyboardEvent('keydown',{key:'-',metaKey:true,bubbles:true,cancelable:true});act(()=>{canvas.dispatchEvent(ctrl);canvas.dispatchEvent(meta);});expect(control.current?.view().zoom).toBe(1);expect(ctrl.defaultPrevented).toBe(false);expect(meta.defaultPrevented).toBe(false);});
 it('cloud canvases cannot intercept input and reduced motion is reflected',async()=>{await mount(true);expect(host.querySelectorAll('canvas[aria-hidden="true"]')).toHaveLength(2);expect(host.querySelector('[aria-label="Cloud motion"]')?.getAttribute('aria-pressed')).toBe('false');});
 it('the cloud toggle reflects the operating system reduced-motion preference',async()=>{vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));await mount();expect(host.querySelector('[aria-label="Cloud motion"]')?.getAttribute('aria-pressed')).toBe('false');});
 it('unmount releases the renderer and animation frame',async()=>{await mount();await act(async()=>root.unmount());expect(hooks.dispose).toHaveBeenCalledOnce();expect(cancelAnimationFrame).toHaveBeenCalled();root=createRoot(host);});
});


describe('globe lazy detail recovery and opt-in CPU measurements',()=>{
 it.each(['resolve','reject'] as const)('a stale initial %s cannot finish a newer terrain retry',async(outcome)=>{
  hooks.startRead=true;
  let finishInitial!:(value:FantasyPixels)=>void,rejectInitial!:(cause:unknown)=>void,finishRetry!:()=>void;
  hooks.read.mockImplementationOnce(()=>new Promise((resolve,reject)=>{finishInitial=resolve;rejectInitial=reject;}));
  hooks.retry.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishRetry=resolve;}));
  const onTerrainStatus=vi.fn();
  await act(async()=>root.render(<FantasyGlobe reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onTerrainStatus={onTerrainStatus}/>));
  expect(onTerrainStatus.mock.calls.at(-1)![0].pending).toBe(true);
  act(()=>onTerrainStatus.mock.calls.at(-1)![0].retry());
  // The old read settles after replacement. No current pixel read masks the
  // bug: readiness itself must belong to the active retry generation.
  await act(async()=>{if(outcome==='resolve')finishInitial({width:1,height:1,data:new Uint8ClampedArray(4)});else rejectInitial(new DOMException('Canceled','AbortError'));});
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:true,error:null});
  await act(async()=>finishRetry());
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:false,error:null});
 });

 it('StrictMode replay does not strand pending reads from a canceled renderer lifetime',async()=>{
  hooks.startRead=true;const done:Array<()=>void>=[],onTerrainStatus=vi.fn();
  hooks.read.mockImplementation(()=>new Promise(resolve=>done.push(()=>resolve({width:1,height:1,data:new Uint8ClampedArray(4)}))));
  await act(async()=>root.render(<StrictMode><FantasyGlobe reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onTerrainStatus={onTerrainStatus}/></StrictMode>));
  expect(done).toHaveLength(2);expect(onTerrainStatus.mock.calls.at(-1)![0].pending).toBe(true);
  await act(async()=>{for(const resolve of done)resolve();});
  expect(onTerrainStatus.mock.calls.at(-1)![0].pending).toBe(false);
 });
 it('keeps required cloud artwork pending and cancels the prior generation on retry',async()=>{
  const requests:Array<{signal:AbortSignal;resolve:(value:FantasyPixels)=>void}>=[];
  hooks.read.mockImplementation((_path:string,signal:AbortSignal)=>new Promise(resolve=>requests.push({signal,resolve})));
  const onTerrainStatus=vi.fn();
  await act(async()=>root.render(<FantasyGlobe reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onTerrainStatus={onTerrainStatus}/>));
  expect(onTerrainStatus.mock.calls.at(-1)![0].pending).toBe(false);
  let old!:Promise<FantasyPixels>,current!:Promise<FantasyPixels>;
  act(()=>{old=hooks.requestPixels('generated/cloud-banks.png');});
  expect(onTerrainStatus.mock.calls.at(-1)![0].pending).toBe(true);
  act(()=>hooks.reportError(Error('Terrain preparation timed out')));
  expect(onTerrainStatus.mock.calls.at(-1)![0].error).toBe('Terrain preparation timed out');
  const retry=onTerrainStatus.mock.calls.at(-1)![0].retry;
  await act(async()=>retry());expect(requests[0]!.signal.aborted).toBe(true);
  act(()=>{current=hooks.requestPixels('generated/cloud-banks.png');});
  expect(requests[1]!.signal).not.toBe(requests[0]!.signal);
  const pixels={width:1,height:1,data:new Uint8ClampedArray(4)};
  await act(async()=>{requests[0]!.resolve(pixels);await old;});
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:true,error:null});
  await act(async()=>{requests[1]!.resolve(pixels);await current;});
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:false,error:null});
  await act(async()=>root.render(null));retry();expect(hooks.retry).toHaveBeenCalledOnce();
  expect(requests[1]!.signal.aborted).toBe(true);
 });
 it('ignores canceled reads but keeps global integrity failures when the visible details recover',async()=>{
  const onTerrainStatus=vi.fn();
  await act(async()=>root.render(<FantasyGlobe reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onTerrainStatus={onTerrainStatus}/>));
  act(()=>hooks.reportError(new DOMException('Canceled','AbortError')));
  expect(onTerrainStatus.mock.calls.at(-1)![0].error).toBeNull();
  act(()=>hooks.reportError(Error('Terrain integrity check failed')));
  act(()=>hooks.reportDetailStatus({pending:false,error:null}));
  await paint();expect(onTerrainStatus.mock.calls.at(-1)![0].error).toBe('Terrain integrity check failed');
 });
 it('uses current-frame detail status instead of all in-flight detail reads',async()=>{
  const requests:Array<{signal:AbortSignal;resolve:(value:FantasyPixels)=>void}>=[];
  hooks.read.mockImplementation((_path:string,signal:AbortSignal)=>new Promise(resolve=>requests.push({signal,resolve})));
  const onTerrainStatus=vi.fn();
  await act(async()=>root.render(<FantasyGlobe reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onTerrainStatus={onTerrainStatus}/>));
  let old!:Promise<FantasyPixels>;
  act(()=>{old=hooks.requestDetails('generated/stormcairn-detail.png');hooks.reportDetailStatus({pending:true,error:null});});
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:true,error:null});
  // The renderer moved to ready Crownlands while Stormcairn is still reading.
  act(()=>hooks.reportDetailStatus({pending:false,error:null}));
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:false,error:null});
  act(()=>hooks.reportDetailStatus({pending:false,error:Error('Stormcairn unavailable')}));
  expect(onTerrainStatus.mock.calls.at(-1)![0].error).toBe('Stormcairn unavailable');
  act(()=>hooks.reportDetailStatus({pending:false,error:null}));
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:false,error:null});
  act(()=>hooks.reportDetailStatus({pending:false,error:Error('Stormcairn unavailable')}));
  await act(async()=>onTerrainStatus.mock.calls.at(-1)![0].retry());
  expect(requests[0]!.signal.aborted).toBe(true);
  // Retry delegates ready/error ownership back to the next renderer frame.
  act(()=>hooks.reportDetailStatus({pending:true,error:null}));
  await act(async()=>{requests[0]!.resolve({width:1,height:1,data:new Uint8ClampedArray(4)});await old;});
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:true,error:null});
  act(()=>hooks.reportDetailStatus({pending:false,error:null}));
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({pending:false,error:null});
 });
 it('normal visits do not allocate or publish a globe diagnostics output',async()=>{
  await mount();await paint();expect(host.querySelector('[data-globe-diagnostics]')).toBeNull();
 });
 it('reports redraw CPU at most once per second without counting idle animation as rendered FPS',async()=>{
  const original=window.location.href;window.history.replaceState(null,'','?diag=1');
  let now=0,hidden=false;vi.spyOn(performance,'now').mockImplementation(()=>now);
  vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
  hooks.draw.mockImplementation(()=>{now+=4;return [];});hooks.animate.mockImplementation(()=>{now+=2;});
  try{
   const {canvas}=await mount();await paint();const output=host.querySelector('[data-globe-diagnostics]')!;
   expect(output.textContent).toBe('GLOBE CPU p95/p99 · draw 4.0/4.0ms · tick 6.0/6.0ms · last 1 redraws');
   act(()=>canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));await paint();
   expect(output.textContent).toContain('last 1 redraws');
   now+=1000;await paint();expect(output.textContent).toContain('last 2 redraws');
   now+=1000;await paint();expect(output.textContent).toContain('last 2 redraws');expect(output.textContent).not.toMatch(/FPS|60fps/i);
   hidden=true;act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(output.textContent).toBe('GLOBE CPU · paused');
   hidden=false;act(()=>document.dispatchEvent(new Event('visibilitychange')));await paint();expect(output.textContent).toContain('last 1 redraws');
  }finally{window.history.replaceState(null,'',original);}
 });
});

describe('temporary interaction sampling always refines the latest view',()=>{
 it.each(['pointerup','pointercancel','lostpointercapture'])('a pan uses motion frames and restores full quality after %s',async(kind)=>{
  const control=createRef<FantasyGlobeHandle>(),onViewChange=vi.fn();
  await act(async()=>root.render(<FantasyGlobe ref={control} view={{lon:26,lat:23,zoom:23.6}} reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onViewChange={onViewChange}/>));
  await paint();const canvas=host.querySelector('canvas')!,surface=host.querySelector<HTMLDivElement>('.fantasy-globe')!;surfaceCapture(surface);
  act(()=>{canvas.dispatchEvent(event('pointerdown',1,100,100));canvas.dispatchEvent(event('pointermove',1,150,140));});await paint();
  expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(true);expect(onViewChange).not.toHaveBeenCalled();
  act(()=>surface.dispatchEvent(event('pointermove',1,180,160)));await paint();const latest=control.current!.view();
  act(()=>{if(kind==='lostpointercapture')surface.releasePointerCapture(1);surface.dispatchEvent(event(kind,1,180,160));});await paint();
  expect(hooks.draw.mock.calls.at(-1)?.[0]).toEqual(latest);expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(false);expect(onViewChange).toHaveBeenCalledOnce();
  const draws=hooks.draw.mock.calls.length;await paint();expect(hooks.draw).toHaveBeenCalledTimes(draws);
 });
 it('pinch and wheel bursts coalesce and refine without publishing every movement',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try{
   const onViewChange=vi.fn(),control=createRef<FantasyGlobeHandle>();
   await act(async()=>root.render(<FantasyGlobe ref={control} reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onViewChange={onViewChange}/>));
   const canvas=host.querySelector('canvas')!,surface=host.querySelector<HTMLDivElement>('.fantasy-globe')!;
   act(()=>{canvas.dispatchEvent(event('pointerdown',1,150));canvas.dispatchEvent(event('pointerdown',2,250));canvas.dispatchEvent(event('pointermove',2,300));canvas.dispatchEvent(event('pointermove',2,350));});await paint();
   expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(true);expect(onViewChange).not.toHaveBeenCalled();
   act(()=>{surface.dispatchEvent(event('pointerup',2,350));surface.dispatchEvent(event('pointerup',1,150));});await paint();
   expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(false);expect(onViewChange).toHaveBeenCalledOnce();onViewChange.mockClear();
   act(()=>{for(let i=0;i<8;i++)surface.dispatchEvent(new WheelEvent('wheel',{deltaY:-10,bubbles:true,cancelable:true}));});await paint();
   const latest=control.current!.view();expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(true);expect(onViewChange).not.toHaveBeenCalled();
   act(()=>vi.advanceTimersByTime(120));await paint();
   expect(hooks.draw.mock.calls.at(-1)?.[0]).toEqual(latest);expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(false);expect(onViewChange).toHaveBeenCalledOnce();
  }finally{vi.useRealTimers();}
 });
 it('backgrounding cancels the active gesture and resumes with one complete current frame',async()=>{
  let hidden=false;vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
  const {canvas,control}=await mount();
  act(()=>{canvas.dispatchEvent(event('pointerdown',1,100));canvas.dispatchEvent(event('pointermove',1,150));});await paint();const latest=control.current!.view();
  expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(true);
  hidden=true;act(()=>document.dispatchEvent(new Event('visibilitychange')));const count=hooks.draw.mock.calls.length;await paint();expect(hooks.draw).toHaveBeenCalledTimes(count);
  hidden=false;act(()=>document.dispatchEvent(new Event('visibilitychange')));await paint();
  expect(hooks.draw.mock.calls.at(-1)?.[0]).toEqual(latest);expect(hooks.draw.mock.calls.at(-1)?.[1]?.interacting).toBe(false);
  act(()=>canvas.dispatchEvent(event('pointermove',1,350)));expect(control.current!.view()).toEqual(latest);
 });
 it.each([['hidden',1],['hidden',2],['blur',1],['blur',2]] as const)('forgets %s with %i stationary contacts so a fresh finger pans without zooming or selecting',async(kind,count)=>{
  let hidden=false;vi.spyOn(document,'hidden','get').mockImplementation(()=>hidden);
  const {canvas,control,onSelect}=await mount();
  // Interrupt before the drag threshold: render-motion state is still idle,
  // but both contacts belong to the abandoned gesture even if no up arrives.
  act(()=>{canvas.dispatchEvent(event('pointerdown',1,100));if(count===2)canvas.dispatchEvent(event('pointerdown',2,200));});
  act(()=>{if(kind==='hidden'){hidden=true;document.dispatchEvent(new Event('visibilitychange'));hidden=false;document.dispatchEvent(new Event('visibilitychange'));}else window.dispatchEvent(new Event('blur'));});
  const before=control.current!.view();
  act(()=>{canvas.dispatchEvent(event('pointerdown',9,300));canvas.dispatchEvent(event('pointermove',9,360));});
  const panned=control.current!.view();expect(panned.zoom).toBe(before.zoom);expect(panned.lon).not.toBe(before.lon);
  act(()=>{canvas.dispatchEvent(event('pointerup',1,100));canvas.dispatchEvent(event('pointercancel',2,200));canvas.dispatchEvent(event('pointermove',9,390));});
  expect(control.current!.view().zoom).toBe(before.zoom);expect(control.current!.view().lon).not.toBe(panned.lon);
  act(()=>canvas.dispatchEvent(event('pointerup',9,390)));expect(onSelect).not.toHaveBeenCalled();
 });
 it.each([['pointerup',1],['pointerup',3],['pointercancel',1],['pointercancel',3],['lostpointercapture',1],['lostpointercapture',3]] as const)('rebases the two remaining fingers after %s of contact %i',async(kind,id)=>{
  const {canvas,control,onSelect}=await mount(),surface=host.querySelector<HTMLDivElement>('.fantasy-globe')!;
  surfaceCapture(surface);
  act(()=>{canvas.dispatchEvent(event('pointerdown',1,100));canvas.dispatchEvent(event('pointerdown',2,200));surface.dispatchEvent(event('pointermove',2,250));canvas.dispatchEvent(event('pointerdown',3,350));});
  const zoom=control.current!.view().zoom;
  // Removing an original member changes the selected pair. Its new distance
  // must start at the current zoom, then keep responding without lifting both.
  const moving=id===1?3:2,x=id===1?350:250;
  act(()=>{surface.releasePointerCapture(id);surface.dispatchEvent(event(kind,id,id===1?100:350));surface.dispatchEvent(event('pointermove',moving,x));});
  expect(control.current!.view().zoom).toBe(zoom);
  act(()=>surface.dispatchEvent(event('pointermove',moving,x-10)));
  expect(control.current!.view().zoom).toBeLessThan(zoom);expect(onSelect).not.toHaveBeenCalled();
 });
});

 it('waits for the first drawn core map, then keeps it usable during optional detail reads and failure',async()=>{
  const onTerrainStatus=vi.fn();
  await act(async()=>root.render(<FantasyGlobe reduceMotion={false} onSelect={vi.fn()} onExplore={vi.fn()} onRealmSelect={vi.fn()} onTerrainStatus={onTerrainStatus}/>));
  expect(onTerrainStatus.mock.calls.at(-1)![0].ready).toBe(false);
  expect(host.querySelector('.fantasy-globe')?.hasAttribute('inert')).toBe(true);
  await paint();
  expect(hooks.draw).toHaveBeenCalled();
  expect(onTerrainStatus.mock.calls.at(-1)![0].ready).toBe(true);
  expect(host.querySelector('.fantasy-globe')?.hasAttribute('inert')).toBe(false);
  act(()=>hooks.reportDetailStatus({pending:true,error:null}));
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({ready:true,pending:true});
  act(()=>hooks.reportDetailStatus({pending:false,error:Error('offline')}));
  expect(onTerrainStatus.mock.calls.at(-1)![0]).toMatchObject({ready:true,error:'offline'});
  expect(host.querySelector('.fantasy-globe')?.hasAttribute('inert')).toBe(false);
 });
