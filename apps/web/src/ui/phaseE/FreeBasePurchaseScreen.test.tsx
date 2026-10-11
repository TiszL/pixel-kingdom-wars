// @vitest-environment happy-dom
import { act,StrictMode } from 'react';
import { createRoot,type Root } from 'react-dom/client';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { api,ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { purchaseOriginal } from '../../lib/freeBasePurchase/transport';
import { FreeBasePurchaseJournalStore } from '../../lib/freeBasePurchase/journal';
import { freeBasePurchaseIdentity } from '../../lib/freeBasePurchase/browser';
import { identity,id,view,receipt } from '../../lib/freeBasePurchase/fixtures.test-support';
import { base,directory,funds } from '../../lib/workshop/snapshot.test-support';
import { FreeBasePurchaseScreen } from './FreeBasePurchaseScreen';
import { FreeBasePurchaseDoor } from './FreeBasePurchaseDoor';
vi.mock('../../lib/freeBasePurchase/transport',()=>({purchaseOriginal:vi.fn()}));
let root:Root,host:HTMLDivElement,accepted:boolean,current:ReturnType<typeof view>;
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
const click=async(label:string)=>{expect(button(label)?.disabled).toBe(false);await act(async()=>button(label)!.click());};
const saved=async()=>{const store=new FreeBasePurchaseJournalStore(freeBasePurchaseIdentity(identity.wallet));try{return await store.read();}finally{await store.close();}};
const posts=()=>vi.mocked(purchaseOriginal).mock.calls.filter(([v])=>v.method==='POST');
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());
 const held=new Set<string>();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(name:string,_o:unknown,run:(v:object|null)=>Promise<unknown>)=>{if(held.has(name))return run(null);held.add(name);try{return await run({});}finally{held.delete(name);}}}});
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'visible'});
 vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
 useApp.getState().setAuth(identity.wallet,true);useApp.getState().setScreen('free-base-purchase');useApp.getState().setSelectedBaseId(id(1),false);useApp.getState().setBase(base());
 accepted=false;current=view();
 vi.spyOn(api,'get').mockImplementation(async path=>{if(path==='/me')return {wallet:identity.wallet} as never;if(path==='/bases')return directory() as never;if(path.startsWith('/base?'))return base() as never;if(path.startsWith('/balances?'))return funds as never;if(path.startsWith('/bases/free-purchases'))return current as never;throw Error(path);});
 vi.mocked(purchaseOriginal).mockReset().mockImplementation(async input=>{input.isCurrent();if(input.method==='POST'){expect((await saved()).operation?.attemptRevision).not.toBeNull();accepted=true;}const p=accepted?{status:'accepted' as const,receipt:{...receipt(),...input.request}}:{status:'unknown' as const,receipt:null};await input.retain(p);input.isCurrent();return p;});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('StrictMode and foreground only read; explicit review names source and server cost',async()=>{
 await act(async()=>root.render(<StrictMode><FreeBasePurchaseScreen actionsEnabled /></StrictMode>));await until(()=>expect(button('REVIEW SECOND KINGDOM')?.disabled).toBe(false));
 await click('REVIEW SECOND KINGDOM');await until(()=>expect(button('CONFIRM PURCHASE')?.disabled).toBe(false));expect(posts()).toHaveLength(0);expect(host.textContent).toContain(BigInt(current.terms.costShards).toLocaleString('en-US'));expect(host.textContent).toContain(id(1));
 await click('CONFIRM PURCHASE');await until(()=>expect((host.textContent)).toContain('PURCHASE ACCEPTED'));await act(async()=>window.dispatchEvent(new Event('focus')));await until(()=>expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));expect(posts()).toHaveLength(1);
});
it('disabled discovery stays dark while saved uncertain recovery remains reachable',async()=>{
 current.enabled=false;current.admission={allowed:false,reason:'disabled'};await act(async()=>root.render(<FreeBasePurchaseDoor discover />));await until(()=>expect(vi.mocked(api.get)).toHaveBeenCalled());expect(host.querySelector('button')).toBeNull();
 const store=new FreeBasePurchaseJournalStore(freeBasePurchaseIdentity(identity.wallet));await store.compareAndSet(0,j=>({...j,operation:{command:{request:{sourceBaseId:id(1),idempotencyKey:id(2)},terms:current.terms},attemptRevision:null,proof:null,refusal:null}}));await store.close();
 await act(async()=>root.render(<FreeBasePurchaseDoor key="reload" discover />));await until(()=>expect(host.textContent).toContain('SAVED PURCHASE'));expect(posts()).toHaveLength(0);
});

it('shows historical server receipt while paused without a selected source or a new request',async()=>{
 current.enabled=false;current.admission={allowed:false,reason:'already-purchased'};current.receipt=receipt();current.sourceBaseId=null;
 useApp.getState().setSelectedBaseId(null,false);
 await act(async()=>root.render(<FreeBasePurchaseScreen actionsEnabled={false} />));await until(()=>expect(host.textContent).toContain('PURCHASE ACCEPTED'));
 expect(host.textContent).toContain(receipt().debitTransactionId);expect(posts()).toHaveLength(0);expect(button('REVIEW SECOND KINGDOM')?.disabled).toBe(true);
});

it('game review separates current source funds from frozen charge and closes without sending',async()=>{
 await act(async()=>root.render(<FreeBasePurchaseScreen />));await until(()=>expect(button('REVIEW SECOND KINGDOM')?.disabled).toBe(false));
 expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Second kingdom');
 expect(host.querySelector('[aria-label="Selected source funds"]')?.textContent).toContain(BigInt(funds.shards).toLocaleString('en-US'));
 expect(host.querySelector('[aria-label="Current purchase availability"] details')?.hasAttribute('open')).toBe(false);
 await click('REVIEW SECOND KINGDOM');await until(()=>expect(button('CONFIRM PURCHASE')?.disabled).toBe(false));
 const original=(await saved()).operation!.command,review=host.querySelector('[aria-label="Confirm purchase"]')!;
 expect(document.activeElement).toBe(review);expect(review.textContent).toContain(BigInt(original.terms.costShards).toLocaleString('en-US'));
 expect(review.querySelector('details')?.open).toBe(false);expect(review.textContent).toContain(original.request.sourceBaseId);
 await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="Close Second kingdom"]')!.click());
 await until(()=>expect(useApp.getState().screen).toBe('bases'));expect((await saved()).operation!.command).toEqual(original);expect(posts()).toHaveLength(0);
});

it.each([
 ['development-required','Complete the required Keep'],['insufficient-shards','enough available SHARDS'],['full-roster','No active kingdom slot'],
] as const)('server %s refusal has a readable next step and no fresh purchase',async(reason,copy)=>{
 current.admission={allowed:false,reason};await act(async()=>root.render(<FreeBasePurchaseScreen />));await until(()=>expect(host.textContent).toContain(copy));
 expect(button('REVIEW SECOND KINGDOM')?.disabled).toBe(true);expect(posts()).toHaveLength(0);
});

it('historical receipt charge stays separate from a different current price and unknown source balance',async()=>{
 current.terms.costShards='999999';current.receipt=receipt();current.enabled=false;current.admission={allowed:false,reason:'already-purchased'};current.sourceBaseId=null;
 useApp.getState().setSelectedBaseId(null,false);await act(async()=>root.render(<FreeBasePurchaseScreen actionsEnabled={false} />));
 await until(()=>expect(host.querySelector('[aria-label="Original purchase result"]')).not.toBeNull());
 expect(host.querySelector('[aria-label="Current purchase availability"] .sk-economy-hero')?.textContent).toContain('999,999');
 expect(host.querySelector('[aria-label="Original purchase result"]')?.textContent).toContain('100,000');
 expect(host.querySelector('[aria-label="Selected source funds"]')?.textContent).toContain('Unavailable');
 expect(host.querySelector('[aria-label="Historical purchase receipt"] details')?.hasAttribute('open')).toBe(false);
 expect(posts()).toHaveLength(0);
});

it('lost purchase acknowledgement stays uncertain until paused receipt recovery confirms the original result',async()=>{
 const send=vi.mocked(purchaseOriginal).getMockImplementation()!;
 vi.mocked(purchaseOriginal).mockImplementation(async input=>{if(input.method==='POST'){accepted=true;throw Error('Purchase reply lost');}return send(input);});
 await act(async()=>root.render(<FreeBasePurchaseScreen />));await until(()=>expect(button('REVIEW SECOND KINGDOM')?.disabled).toBe(false));
 await click('REVIEW SECOND KINGDOM');await until(()=>expect(button('CONFIRM PURCHASE')?.disabled).toBe(false));await click('CONFIRM PURCHASE');
 await until(()=>expect(host.textContent).toContain('ORIGINAL OUTCOME UNKNOWN'));
 expect(host.querySelector('[aria-label="Original purchase result"]')).toBeNull();expect(posts()).toHaveLength(1);
 const original=(await saved()).operation!.command;await act(async()=>root.render(null));
 current.enabled=false;current.admission={allowed:false,reason:'disabled'};await act(async()=>root.render(<FreeBasePurchaseScreen actionsEnabled={false} />));
 await until(()=>expect(host.textContent).toContain('PURCHASE ACCEPTED'));
 expect((await saved()).operation!.command).toEqual(original);expect(posts()).toHaveLength(1);
 expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false);expect(button('CONFIRM PURCHASE')).toBeUndefined();
});

it('declined original is labelled declined and retains safe receipt recovery',async()=>{
 vi.mocked(purchaseOriginal).mockImplementation(async input=>{input.isCurrent();if(input.method==='POST'){
  await input.refusal({status:409,code:'FREE_BASE_SOURCE_RESERVED'});throw new ApiError(409,'Source reserved','FREE_BASE_SOURCE_RESERVED');}
  return {status:'unknown',receipt:null};});
 await act(async()=>root.render(<FreeBasePurchaseScreen />));await until(()=>expect(button('REVIEW SECOND KINGDOM')?.disabled).toBe(false));
 await click('REVIEW SECOND KINGDOM');await until(()=>expect(button('CONFIRM PURCHASE')?.disabled).toBe(false));await click('CONFIRM PURCHASE');
 await until(()=>expect(host.textContent).toContain('ORIGINAL REQUEST DECLINED'));
 expect(host.querySelector('[aria-label="Original purchase result"]')).toBeNull();
 expect(button('ARCHIVE DECLINED REQUEST')?.disabled).toBe(false);expect(button('REVIEW ORIGINAL REQUEST')).toBeUndefined();
 expect(posts()).toHaveLength(1);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
