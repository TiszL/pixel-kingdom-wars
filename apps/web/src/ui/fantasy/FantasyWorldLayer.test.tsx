/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const transport=vi.hoisted(()=>({pending:false,ready:true,error:null as string|null,retry:vi.fn()}));

vi.mock('./data',()=>{
  const empty=()=>({data:null,pending:false,error:null,retry:vi.fn()});
  return {useFantasyDirectory:()=>({...empty(),pending:transport.pending}),useFantasyParcel:empty,useFantasyViewport:empty,useFantasySearch:empty};
});
vi.mock('./FantasyGlobe',async importOriginal=>{
  const actual=await importOriginal<typeof import('./FantasyGlobe')>();
  const {useEffect}=await import('react');
  return {...actual,FantasyGlobe:({onTerrainStatus}:{onTerrainStatus(status:unknown):void})=>{useEffect(()=>onTerrainStatus({pending:!transport.ready,ready:transport.ready,error:transport.error,retry:transport.retry}),[onTerrainStatus]);return null;}};
});
vi.mock('../../lib/mobileBackGuard',()=>({useMobileBackHandler:vi.fn()}));
import { FantasyWorldLayer } from './FantasyWorldLayer';

let root:Root,host:HTMLDivElement;
const observers:Array<{callback:ResizeObserverCallback;observe:ReturnType<typeof vi.fn>;disconnect:ReturnType<typeof vi.fn>}>=[];
beforeEach(()=>{
  (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  observers.length=0;
  transport.pending=false;transport.ready=true;transport.error=null;transport.retry.mockClear();
  vi.stubGlobal('ResizeObserver',class {
    observe=vi.fn();disconnect=vi.fn();unobserve=vi.fn();
    constructor(public callback:ResizeObserverCallback){observers.push(this);}
  });
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.restoreAllMocks();});

async function mountRail(){
  await act(async()=>root.render(<FantasyWorldLayer/>));
  const rail=host.querySelector<HTMLElement>('[aria-label="Realms"]')!;
  let width=1440;
  rail.style.paddingLeft='58px';rail.style.paddingRight='10px';
  Object.defineProperty(rail,'clientWidth',{configurable:true,get:()=>width});
  vi.spyOn(rail,'getBoundingClientRect').mockImplementation(()=>new DOMRect(20,48,width,70));
  for(const [index,node]of [...rail.querySelectorAll<HTMLElement>('[data-realm]')].entries()){
    vi.spyOn(node,'getBoundingClientRect').mockImplementation(()=>new DOMRect(20+58+index*140-rail.scrollLeft,54,135,54));
  }
  return {rail,resize:(value:number)=>{width=value;}};
}

describe('selected realm remains reachable after responsive layout changes',()=>{
  it('keeps Explore first in the HUD and opens all seven non-owned chains while loading stays in that HUD',async()=>{
    transport.pending=true;
    await act(async()=>root.render(<FantasyWorldLayer/>));
    const tools=host.querySelector('.fantasy-world-tools')!,explore=tools.firstElementChild as HTMLButtonElement;
    expect(explore.textContent).toBe('EXPLORE');
    expect(explore.classList.contains('fantasy-explore-trigger')).toBe(true);
    expect(tools.querySelector('[role="status"]')?.textContent).toContain('Loading your deeds');
    expect(host.querySelector('.fantasy-world-notice')).toBeNull();
    await act(async()=>explore.click());
    expect(explore.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.fantasy-explore-list>button')).toHaveLength(7);
    expect(host.querySelector('.fantasy-panel-content')?.textContent).toContain('cannot be owned');
    expect(host.querySelector('.fantasy-panel-content button:disabled')?.textContent).toBe('DISPATCH LOCKED');
  });
  it('reveals Solana after a desktop-to-phone container resize without scrolling the page',async()=>{
    const {rail,resize}=await mountRail(),solana=rail.querySelector<HTMLButtonElement>('[data-realm="seeker-reach"]')!;
    const pageScroll=vi.spyOn(window,'scrollTo'),documentScroll=document.documentElement.scrollTop;
    await act(async()=>solana.click());
    expect(rail.scrollLeft).toBe(0);
    const current=observers.at(-1)!;
    expect(current.observe).toHaveBeenCalledWith(rail);
    expect(current.observe).toHaveBeenCalledWith(solana);
    resize(390);
    act(()=>current.callback([],current as unknown as ResizeObserver));
    expect(solana.getBoundingClientRect().right).toBeLessThanOrEqual(rail.getBoundingClientRect().left+rail.clientWidth-10);
    expect(solana.getBoundingClientRect().left).toBeGreaterThanOrEqual(rail.getBoundingClientRect().left+58);
    expect(rail.scrollLeft).toBeGreaterThan(0);
    expect(solana.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.scrollTop).toBe(documentScroll);
    expect(pageScroll).not.toHaveBeenCalled();
    const before=rail.scrollLeft;
    resize(1440);act(()=>current.callback([],current as unknown as ResizeObserver));
    expect(rail.scrollLeft).toBe(before);
    await act(async()=>root.unmount());
    expect(current.disconnect).toHaveBeenCalledOnce();
    expect(observers.every(observer=>observer.disconnect.mock.calls.length===1)).toBe(true);
    root=createRoot(host);
  });

  it('supports window-resize fallback and keeps a newly selected left-hand realm inside its padding',async()=>{
    vi.stubGlobal('ResizeObserver',undefined);
    const {rail,resize}=await mountRail();
    await act(async()=>rail.querySelector<HTMLButtonElement>('[data-realm="seeker-reach"]')!.click());
    resize(390);act(()=>window.dispatchEvent(new Event('resize')));
    expect(rail.scrollLeft).toBeGreaterThan(0);
    const frost=rail.querySelector<HTMLButtonElement>('[data-realm="frostveil"]')!;
    await act(async()=>frost.click());
    expect(frost.getBoundingClientRect().left).toBeGreaterThanOrEqual(rail.getBoundingClientRect().left+58);
    expect(rail.scrollLeft).toBe(0);
    const detach=vi.spyOn(window,'removeEventListener');
    await act(async()=>root.unmount());
    expect(detach).toHaveBeenCalledWith('resize',expect.any(Function));
    root=createRoot(host);
  });
});

 describe('initial world loading boundary',()=>{
  it.each([null,'offline'])('keeps map controls inert and BASE usable while no map frame exists (%s)',async(error)=>{
    transport.ready=false;transport.error=error;
    await act(async()=>root.render(<FantasyWorldLayer/>));
    expect(host.querySelector('.fantasy-world')?.classList.contains('world-opening')).toBe(true);
    expect(host.querySelector('main')?.hasAttribute('inert')).toBe(true);
    expect(host.querySelector('[aria-label="Realms"]')?.hasAttribute('inert')).toBe(true);
    const back=host.querySelector('header button')!;
    expect(back.closest('[inert]')).toBeNull();
    expect(host.querySelector('.fantasy-world-loading')?.textContent).toContain(error?'Couldn’t open the world':'Opening the world');
    if(error){await act(async()=>(host.querySelector('.sk-game-loading-actions button') as HTMLButtonElement).click());expect(transport.retry).toHaveBeenCalledOnce();}
  });
 });
