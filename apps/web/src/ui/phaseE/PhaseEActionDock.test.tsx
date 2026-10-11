/** @vitest-environment happy-dom */
import {act,useEffect,useRef,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createMobileBackGuard} from '../../lib/mobileBackGuard';
import {PhaseEActionDock,PhaseEActionGroup,PhaseEEntryButton} from './PhaseEActionDock';

let host:HTMLDivElement,root:Root;
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
const toggle=()=>host.querySelector<HTMLButtonElement>('[aria-controls="phase-e-actions"]')!;
const menu=()=>host.querySelector<HTMLDivElement>('#phase-e-actions')!;
const button=(label:string)=>[...host.querySelectorAll('button')].find(item=>item.textContent===label)!;

it('groups available actions and hides empty sections as discovery changes',async()=>{
 const view=(found:boolean)=><PhaseEActionDock>
  <PhaseEEntryButton>BASES</PhaseEEntryButton>
  <PhaseEActionGroup group="fleet">{found&&<PhaseEEntryButton>VEHICLES</PhaseEEntryButton>}</PhaseEActionGroup>
  <PhaseEActionGroup group="islands"><PhaseEEntryButton>KEEP TAX &amp; HISTORY</PhaseEEntryButton></PhaseEActionGroup>
 </PhaseEActionDock>;
 await act(async()=>root.render(view(false)));await settle();
 await act(async()=>toggle().click());
 const headings=()=>[...menu().querySelectorAll('section:not([hidden]) h2')].map(item=>item.textContent);
 expect(headings()).toEqual(['Kingdom & economy','Island rewards']);
 expect(button('KEEP TAX & HISTORY').closest('section')?.getAttribute('aria-labelledby')).toBe('phase-e-islands-heading');
 await act(async()=>root.render(view(true)));await settle();
 expect(headings()).toEqual(['Kingdom & economy','Fleet & travel','Island rewards']);
 expect(button('VEHICLES').style.minHeight).toBe('48px');
 await act(async()=>root.render(view(false)));await settle();
 expect(headings()).toEqual(['Kingdom & economy','Island rewards']);
});

it('hides the Kingdom opener when no activity is available',async()=>{
 await act(async()=>root.render(<PhaseEActionDock><PhaseEActionGroup group="clan">{null}</PhaseEActionGroup></PhaseEActionDock>));
 await settle();expect(host.querySelector('nav')?.hidden).toBe(true);
 await act(async()=>root.render(<PhaseEActionDock><PhaseEEntryButton>HISTORY</PhaseEEntryButton></PhaseEActionDock>));
 await settle();expect(host.querySelector('nav')?.hidden).toBe(false);
 await act(async()=>root.render(<PhaseEActionDock>{null}</PhaseEActionDock>));
 await settle();expect(host.querySelector('nav')?.hidden).toBe(true);
});

it('closes on launch while retaining recovery state and an unclipped dialog with a visible return focus',async()=>{
 const mounted=vi.fn(),retired=vi.fn();
 function Dialog({onClose,visits}:{onClose:()=>void;visits:number}){
  const close=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const opener=document.activeElement as HTMLElement;close.current?.focus();return()=>opener?.focus();},[]);
  return <div role="dialog" aria-label="Saved activity"><p>Original receipt / visit {visits}</p><button ref={close} onClick={onClose}>CLOSE HISTORY</button></div>;
 }
 function Recovery(){
  const [open,setOpen]=useState(false),[visits,setVisits]=useState(0);
  useEffect(()=>{mounted();return()=>{retired();};},[]);
  return <><PhaseEEntryButton onClick={()=>{setVisits(value=>value+1);setOpen(true);}}>SAVED HISTORY</PhaseEEntryButton>{open&&<Dialog visits={visits} onClose={()=>setOpen(false)}/>}</>;
 }
 await act(async()=>root.render(<PhaseEActionDock><PhaseEActionGroup group="clan"><Recovery/></PhaseEActionGroup></PhaseEActionDock>));await settle();
 await act(async()=>toggle().click());
 expect(document.activeElement).toBe(button('SAVED HISTORY'));
 await act(async()=>button('SAVED HISTORY').click());
 expect(toggle().getAttribute('aria-expanded')).toBe('false');expect(menu().hidden).toBe(true);
 const dialog=host.querySelector('[role="dialog"]')!;
 expect(dialog).not.toBeNull();expect(menu().contains(dialog)).toBe(false);
 expect(dialog.closest('[hidden]')).toBeNull();expect(dialog.textContent).toContain('visit 1');
 expect(document.activeElement).toBe(button('CLOSE HISTORY'));
 await act(async()=>button('CLOSE HISTORY').click());expect(document.activeElement).toBe(toggle());
 await act(async()=>toggle().click());await act(async()=>button('SAVED HISTORY').click());
 expect(host.querySelector('[role="dialog"]')?.textContent).toContain('visit 2');
 expect(mounted).toHaveBeenCalledTimes(1);expect(retired).not.toHaveBeenCalled();
});

it('lets Escape and Android Back return focus without launching an action',async()=>{
 const launch=vi.fn();
 await act(async()=>root.render(<PhaseEActionDock><PhaseEEntryButton onClick={launch}>HISTORY</PhaseEEntryButton></PhaseEActionDock>));await settle();
 await act(async()=>toggle().click());
 await act(async()=>button('HISTORY').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
 expect(menu().hidden).toBe(true);expect(document.activeElement).toBe(toggle());expect(launch).not.toHaveBeenCalled();
 const leave=vi.fn(),toast=vi.fn();
 const cleanup=createMobileBackGuard({win:window,enabled:true,trustedActivation:()=>true,getScreen:()=> 'bases',goToBase:leave,toast});
 try{
  window.dispatchEvent(new Event('pointerdown'));
  await act(async()=>toggle().click());
  await act(async()=>window.dispatchEvent(new PopStateEvent('popstate')));
  expect(menu().hidden).toBe(true);expect(document.activeElement).toBe(toggle());
  expect(leave).not.toHaveBeenCalled();expect(toast).not.toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();
 }finally{cleanup();}
});

it('preserves standalone building-door behavior and refuses disabled dock actions',async()=>{
 const launch=vi.fn();
 await act(async()=>root.render(<PhaseEEntryButton onClick={launch} style={{position:'absolute'}}>WORKSHOP</PhaseEEntryButton>));
 expect(button('WORKSHOP').style.position).toBe('absolute');
 await act(async()=>button('WORKSHOP').click());expect(launch).toHaveBeenCalledTimes(1);
 await act(async()=>root.render(<PhaseEActionDock><PhaseEEntryButton disabled onClick={launch}>PAUSED ACTION</PhaseEEntryButton><PhaseEEntryButton>SAVED HISTORY</PhaseEEntryButton></PhaseEActionDock>));await settle();
 await act(async()=>toggle().click());expect(document.activeElement).toBe(button('SAVED HISTORY'));
 await act(async()=>button('PAUSED ACTION').click());
 expect(toggle().getAttribute('aria-expanded')).toBe('true');expect(launch).toHaveBeenCalledTimes(1);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
