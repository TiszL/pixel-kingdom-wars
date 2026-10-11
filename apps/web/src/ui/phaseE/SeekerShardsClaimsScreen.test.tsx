/** @vitest-environment happy-dom */
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {api} from '../../lib/api';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {SeekerShardsClaimsJournalStore} from '../../lib/seekerShardsClaims/journal';
import {seekerShardsClaimsIdentity} from '../../lib/seekerShardsClaims/browser';
import {seekerShardsClaimOriginal} from '../../lib/seekerShardsClaims/transport';
import {id,identity,view,receipt,command} from '../../lib/seekerShardsClaims/fixtures.test-support';
import {base,directory,funds} from '../../lib/workshop/snapshot.test-support';
import {SeekerShardsClaimsScreen} from './SeekerShardsClaimsScreen';
import {SeekerShardsClaimsEntry} from './SeekerShardsClaimsEntry';
vi.mock('../../lib/seekerShardsClaims/transport',()=>({seekerShardsClaimOriginal:vi.fn()}));
let host:HTMLDivElement,root:Root,accepted:boolean,current:ReturnType<typeof view>;
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===text);
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
const click=async(text:string)=>{expect(button(text)?.disabled).toBe(false);await act(async()=>button(text)!.click());};
async function saved(){const s=new SeekerShardsClaimsJournalStore(seekerShardsClaimsIdentity(identity.wallet));try{return await s.read();}finally{await s.close();}}
const posts=()=>vi.mocked(seekerShardsClaimOriginal).mock.calls.filter(([x])=>x.method==='POST');
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
 const held=new Set<string>();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(name:string,_o:unknown,run:(lock:object|null)=>Promise<unknown>)=>{if(held.has(name))return run(null);held.add(name);try{return await run({});}finally{held.delete(name);}}}});
 vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);accepted=false;current=view();useApp.getState().setAuth(identity.wallet,true);useApp.getState().setSelectedBaseId(id(1),false);useApp.getState().setScreen('bases');
 vi.spyOn(api,'getPrivate').mockImplementation(async(path)=>{if(path==='/me')return {wallet:identity.wallet} as never;if(path==='/bases')return directory() as never;if(path.startsWith('/base?'))return base() as never;if(path.startsWith('/balances?'))return {...funds,shards:accepted?'70010':'70000'} as never;return current as never;});
 vi.mocked(seekerShardsClaimOriginal).mockReset().mockImplementation(async input=>{input.isCurrent();if(input.method==='POST'){expect((await saved()).operation?.attemptRevision).not.toBeNull();accepted=true;}const proof={wallet:identity.wallet,receipt:accepted?{...receipt(),...input.request,id:input.request.idempotencyKey}:null};await input.retain(proof);input.isCurrent();return proof;});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('StrictMode mount and focus are GET-only; explicit review and confirm retain one receipt and refresh current SHARDS balance',async()=>{
 await act(async()=>root.render(<StrictMode><SeekerShardsClaimsScreen actionsEnabled onClose={()=>undefined}/></StrictMode>));await until(()=>expect(button('REVIEW SHARDS CLAIM')?.disabled).toBe(false));expect(posts()).toHaveLength(0);
 await act(async()=>window.dispatchEvent(new Event('focus')));await until(()=>expect(button('REVIEW SHARDS CLAIM')?.disabled).toBe(false));expect(posts()).toHaveLength(0);
 await click('REVIEW SHARDS CLAIM');await until(()=>expect(button('CONFIRM SHARDS CLAIM')?.disabled).toBe(false));expect(posts()).toHaveLength(0);await click('CONFIRM SHARDS CLAIM');await until(()=>expect(host.textContent).toContain('Delivered: 10 SHARDS'));expect(posts()).toHaveLength(1);
 await until(()=>expect(host.textContent).toContain('70,010'));await click('REFRESH BALANCE & SAVE RECEIPT');await until(()=>expect(host.textContent).toContain('SHARDS claim history (1)'));expect((await saved()).operation).toBeNull();expect(posts()).toHaveLength(1);
});
it('a restarted attempted command remains GET-only and accepted history is recoverable while paused',async()=>{
 const s=new SeekerShardsClaimsJournalStore(seekerShardsClaimsIdentity(identity.wallet));let j=await s.compareAndSet(0,o=>({...o,operation:{command,attemptRevision:null,proof:null}}));await s.compareAndSet(j.revision,o=>({...o,operation:{...o.operation!,attemptRevision:o.revision+1}}));await s.close();accepted=true;current.claimsEnabled=false;
 await act(async()=>root.render(<SeekerShardsClaimsScreen actionsEnabled={false} onClose={()=>undefined}/>));await until(()=>expect(host.textContent).toContain('Delivered: 10 SHARDS'));expect(host.textContent).toContain('New claims are paused');expect(button('CONFIRM SHARDS CLAIM')).toBeUndefined();await click('CHECK ORIGINAL RECEIPT');expect(posts()).toHaveLength(0);
});
it('base ABA cancels a saved review without selecting another destination or sending',async()=>{await act(async()=>root.render(<SeekerShardsClaimsScreen actionsEnabled onClose={()=>undefined}/>));await until(()=>expect(button('REVIEW SHARDS CLAIM')?.disabled).toBe(false));await click('REVIEW SHARDS CLAIM');await until(()=>expect(button('CONFIRM SHARDS CLAIM')?.disabled).toBe(false));await act(async()=>{useApp.getState().setSelectedBaseId(id(9),false);useApp.getState().setSelectedBaseId(id(1),false);});await until(()=>expect(button('CONFIRM SHARDS CLAIM')).toBeUndefined());expect((await saved()).operation?.command.request.baseId).toBe(id(1));expect(posts()).toHaveLength(0);});
it('unknown original stays visible after restart and never offers a second submit',async()=>{const s=new SeekerShardsClaimsJournalStore(seekerShardsClaimsIdentity(identity.wallet));let j=await s.compareAndSet(0,o=>({...o,operation:{command,attemptRevision:null,proof:null}}));await s.compareAndSet(j.revision,o=>({...o,operation:{...o.operation!,attemptRevision:o.revision+1}}));await s.close();await act(async()=>root.render(<SeekerShardsClaimsScreen actionsEnabled onClose={()=>undefined}/>));await until(()=>expect(host.textContent).toContain('The outcome is still unknown'));expect(button('REVIEW SAVED CLAIM')).toBeUndefined();expect(button('ARCHIVE UNUSED DRAFT')).toBeUndefined();/* Receipt text can arrive before its authoritative balance refresh finishes. */await until(()=>expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));await click('CHECK ORIGINAL RECEIPT');expect(posts()).toHaveLength(0);});
it('storage failure leaves a recovery entry and blocks all mutation',async()=>{vi.stubGlobal('indexedDB',undefined);current={...current,claimsEnabled:false,rows:[]};await act(async()=>root.render(<SeekerShardsClaimsEntry actionsEnabled/>));await until(()=>expect(button('SHARDS SHARES & HISTORY')).toBeDefined());await click('SHARDS SHARES & HISTORY');await until(()=>expect(host.querySelector('[role="alert"]')?.textContent).toContain('storage'));expect(posts()).toHaveLength(0);});
it('dialog supports keyboard close and returns focus to its opener',async()=>{const opener=document.createElement('button');document.body.append(opener);opener.focus();const close=vi.fn();await act(async()=>root.render(<SeekerShardsClaimsScreen actionsEnabled onClose={close}/>));await until(()=>expect(host.querySelector('[role="dialog"]')).toBe(document.activeElement));const dialog=host.querySelector('[role="dialog"]')!;await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(close).toHaveBeenCalledOnce();await act(async()=>root.render(null));expect(document.activeElement).toBe(opener);opener.remove();});
it('paused discovery exposes empty pages with continuation so earlier winning rights stay reachable',async()=>{current={...current,claimsEnabled:false,rows:[],nextCursor:id(1)};await act(async()=>root.render(<SeekerShardsClaimsEntry actionsEnabled={false}/>));await until(()=>expect(button('SEEKER SHARDS SHARES')).toBeDefined());await click('SEEKER SHARDS SHARES');await until(()=>expect(button('NEXT TERMS')?.disabled).toBe(false));expect(host.textContent).toContain('No earned shares on this page');expect(posts()).toHaveLength(0);});

it('paused unavailable history remains reachable without implying a zero balance',async()=>{current={...current,claimsEnabled:false,status:'unavailable',reason:'SOURCE_INTEGRITY',rows:[],nextCursor:null};await act(async()=>root.render(<SeekerShardsClaimsEntry actionsEnabled={false}/>));await until(()=>expect(button('SEEKER SHARDS SHARES')).toBeDefined());await click('SEEKER SHARDS SHARES');await until(()=>expect(host.textContent).toContain('unavailable'));expect(posts()).toHaveLength(0);});

it('keeps large cumulative totals exact while reviewing only the remaining SHARDS and focusing consent',async()=>{
 current.rows[0]={...current.rows[0]!,poolTotal:'18014398509481986',cumulativeTotal:'9007199254740993',claimedTotal:'9007199254740000',dueQuantity:'993'};await act(async()=>root.render(<SeekerShardsClaimsScreen actionsEnabled onClose={()=>undefined}/>));await until(()=>expect(button('REVIEW SHARDS CLAIM')?.disabled).toBe(false));
 expect(host.textContent).toContain('9,007,199,254,740,993 SHARDS');expect(host.textContent).toContain('2026');await click('REVIEW SHARDS CLAIM');await until(()=>expect(button('CONFIRM SHARDS CLAIM')?.disabled).toBe(false));const review=host.querySelector<HTMLElement>('[aria-label="Confirm SHARDS claim"]')!;
 expect(document.activeElement).toBe(review);expect(review.textContent).toContain('Collect 993 SHARDS');expect(review.textContent).toContain('9,007,199,254,740,000 already claimed');expect(posts()).toHaveLength(0);
});
it('preserves the original destination and recoverable claim when the selected kingdom changes',async()=>{
 await act(async()=>root.render(<SeekerShardsClaimsScreen actionsEnabled onClose={()=>undefined}/>));await until(()=>expect(button('REVIEW SHARDS CLAIM')?.disabled).toBe(false));await click('REVIEW SHARDS CLAIM');await until(()=>expect(button('CONFIRM SHARDS CLAIM')?.disabled).toBe(false));
 await act(async()=>useApp.getState().setSelectedBaseId(id(9),false));await until(()=>expect(button('CONFIRM SHARDS CLAIM')).toBeUndefined());expect(host.textContent).toContain('Spot 1 · Original kingdom');expect(host.textContent).toContain('Its destination stays fixed');expect(button('REVIEW SAVED CLAIM')?.disabled).toBe(true);expect((await saved()).operation?.command.request.baseId).toBe(id(1));expect(posts()).toHaveLength(0);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
