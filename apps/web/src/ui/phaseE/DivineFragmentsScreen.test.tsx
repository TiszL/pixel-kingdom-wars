/** @vitest-environment happy-dom */
import {IDBFactory} from 'fake-indexeddb';
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {api} from '../../lib/api';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {DivineFragmentsJournalStore} from '../../lib/divineFragments/journal';
import {divineFragmentsIdentity} from '../../lib/divineFragments/browser';
import {clanAward,id,identity,proof,read} from '../../lib/divineFragments/fixtures.test-support';
import {DivineFragmentsScreen} from './DivineFragmentsScreen';
let host:HTMLDivElement,root:Root,accepted:boolean,lose:boolean,visibility:DocumentVisibilityState;
const saved=async()=>{const store=new DivineFragmentsJournalStore(divineFragmentsIdentity(identity.wallet));try{return await store.read();}finally{await store.close();}};
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);
const until=(fn:()=>void|Promise<void>)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});await fn();});
const click=async(label:string)=>{expect(button(label)?.disabled).toBe(false);await act(async()=>button(label)!.click());};
const posts=()=>vi.mocked(fetch).mock.calls.filter(([,options])=>options?.method==='POST');
async function mount(enabled=true,strict=false){await act(async()=>root.render(strict?<StrictMode><DivineFragmentsScreen actionsEnabled={enabled} onClose={()=>undefined}/></StrictMode>:<DivineFragmentsScreen actionsEnabled={enabled} onClose={()=>undefined}/>));await until(()=>expect(button('REFRESH STOCK & HISTORY')?.disabled).toBe(false));}
async function review(){await click('AWARDS');await click('REVIEW DELIVERY');await until(()=>expect(button('CONFIRM FRAGMENT DELIVERY')?.disabled).toBe(false));}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());visibility='visible';Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visibility});
 const locks=new Set<string>();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(name:string,_options:unknown,run:(lock:object|null)=>Promise<unknown>)=>{if(locks.has(name))return run(null);locks.add(name);try{return await run({});}finally{locks.delete(name);}}}});
 vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
 useApp.getState().setAuth(identity.wallet,true);useApp.getState().setScreen('base');useApp.getState().setSelectedBaseId(id(1),false);accepted=false;lose=false;
 vi.spyOn(api,'getPrivate').mockImplementation(async path=>read(path) as never);
 vi.stubGlobal('fetch',vi.fn<typeof fetch>(async(_url,options)=>{const journal=await saved(),command=journal.operation?.command??journal.archives.at(-1)!.operation.command;
  if(options?.method==='POST'){expect(journal.operation?.attemptRevision).toBe(journal.revision);expect(JSON.parse(options.body as string)).toEqual(command.consent.request);accepted=true;if(lose)throw Error('lost acknowledgement');}
  const response=proof(command,accepted);return new Response(JSON.stringify(options?.method==='POST'?response.receipt:response),{status:200});}));
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(navigator,'locks');Reflect.deleteProperty(document,'visibilityState');useApp.getState().setAuth(null);});
it('actual hook/IndexedDB/transport in StrictMode saves review without POST and foreground retires consent',async()=>{const focus=vi.spyOn(HTMLElement.prototype,'focus'),scroll=vi.spyOn(HTMLElement.prototype,'scrollIntoView').mockImplementation(()=>undefined);await mount(true,true);expect(button('STOCK')?.getAttribute('aria-pressed')).toBe('true');await review();expect(button('AWARDS')?.getAttribute('aria-pressed')).toBe('true');expect(button('STOCK')?.getAttribute('aria-pressed')).toBe('false');expect(posts()).toHaveLength(0);expect((await saved()).operation?.command.consent.request.baseId).toBe(id(1));const reviewText=host.querySelector('[aria-label="Confirm fragment delivery"]')!.textContent;expect(reviewText).toContain(id(1));expect(reviewText).toContain('No SOL, KEEP, Gems or SHARDS payment');const reviewNode=host.querySelector('[aria-label="Confirm fragment delivery"]')!;expect(document.activeElement).toBe(reviewNode);expect(focus.mock.calls[focus.mock.contexts.lastIndexOf(reviewNode as HTMLElement)]).toEqual([{preventScroll:true}]);expect(scroll.mock.calls[scroll.mock.contexts.lastIndexOf(reviewNode as HTMLElement)]).toEqual([{block:'start'}]);await act(async()=>window.dispatchEvent(new Event('focus')));await until(()=>expect(button('CONFIRM FRAGMENT DELIVERY')).toBeUndefined());expect(posts()).toHaveLength(0);});
it('explicit confirmation retains receipt and archive never fabricates current stock',async()=>{await mount();await review();await click('CONFIRM FRAGMENT DELIVERY');await until(()=>expect(host.textContent).toContain('ORIGINAL DELIVERY RECEIVED'));expect(posts()).toHaveLength(1);expect((await saved()).operation?.proof?.receipt?.quantity).toBe('12');await click('ARCHIVE RECEIPT');await until(()=>expect((host.textContent??'')).not.toContain('ORIGINAL DELIVERY RECEIVED'));await click('HISTORY');expect(host.textContent).toContain('Original receipt retained');await click('STOCK');expect(host.querySelector('[aria-label="Current fragment stock"]')?.textContent).not.toContain('17');});
it('lost reply recovers after remount paused and changed base without another POST',async()=>{await mount();await review();lose=true;await click('CONFIRM FRAGMENT DELIVERY');await until(()=>expect(host.textContent).toContain('ORIGINAL OUTCOME UNKNOWN'));await act(async()=>root.render(null));await act(async()=>useApp.getState().setSelectedBaseId(id(9),false));await mount(false);await until(()=>expect(host.textContent).toContain('ORIGINAL DELIVERY RECEIVED'));expect(posts()).toHaveLength(1);expect((await saved()).operation?.command.consent.request.baseId).toBe(id(1));expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false);});
it('changed selection preserves saved original and prevents confirming into another kingdom',async()=>{await mount();await review();await act(async()=>useApp.getState().setSelectedBaseId(id(9),false));await until(()=>expect(button('CONFIRM FRAGMENT DELIVERY')).toBeUndefined());expect(posts()).toHaveLength(0);expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(true);expect((await saved()).operation?.command.consent.request.baseId).toBe(id(1));});
it('Seeker journey reviews typed fragment rights and sends no tax/source/amount fields',async()=>{await mount();await click('SEEKER RIGHTS');await click('REVIEW FRAGMENT CLAIM');await until(()=>expect(button('CONFIRM FRAGMENT DELIVERY')?.disabled).toBe(false));expect(host.querySelector('[aria-label="Confirm fragment delivery"]')!.textContent).toContain('untaxed pool claim');await click('CONFIRM FRAGMENT DELIVERY');await until(()=>expect(host.textContent).toContain('ORIGINAL DELIVERY RECEIVED'));const body=JSON.parse(posts()[0]![1]!.body as string);expect(Object.keys(body).sort()).toEqual(['baseId','idempotencyKey','spotId','termId']);expect((await saved()).operation?.proof?.receipt?.quantity).toBe('3');});
it('freeze retires original review and foreground recovery never posts',async()=>{await mount();await review();await act(async()=>document.dispatchEvent(new Event('freeze')));await until(()=>expect(button('CONFIRM FRAGMENT DELIVERY')).toBeUndefined());await act(async()=>document.dispatchEvent(new Event('resume')));await until(()=>expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));expect(posts()).toHaveLength(0);});

function serveClan(getAward=()=>clanAward(3,8000n)){
 vi.mocked(api.getPrivate).mockImplementation(async path=>{
  const award=getAward();if(path.startsWith('/divine-fragments/awards'))return {version:1,wallet:identity.wallet,rows:[{award,delivery:null}],nextCursor:null} as never;
  if(path.startsWith('/divine-fragments/events/'))return {version:1,wallet:identity.wallet,eventId:award.eventId,enrolled:true,settled:true,award,delivery:null} as never;
  return read(path) as never;
 });
}
it('clan award review explains the frozen roster share and server allocation before any delivery POST',async()=>{
 const award=clanAward(3,8000n);serveClan(()=>award);await mount();await review();
 const reviewPanel=host.querySelector('[aria-label="Confirm fragment delivery"]')!;
 expect(reviewPanel.textContent).toContain('Clan occupation award');expect(reviewPanel.textContent).toContain('Site 001');
 expect(reviewPanel.textContent).toContain('Later membership or leadership changes do not redirect it');
 const values=[...reviewPanel.querySelectorAll('dt')];
 for(const [label,value] of [['Original roster',`${award.clan.rosterSize} members`],['Site gross allowance',`${award.clan.siteGross} fragments`],['Your gross roster share',`${award.gross} fragments`],['Your protected stock',`${award.net} fragments`],['Original Seeker pool',`${award.tax} fragments`]]){
  expect(values.find(dt=>dt.textContent===label)?.nextElementSibling?.textContent).toBe(value);
 }
 const details=[...reviewPanel.querySelectorAll('details')];expect(details.every(d=>!d.open)).toBe(true);
 const awardDetails=details.find(d=>d.querySelector('summary')?.textContent==='Original award details')!;
 expect(awardDetails.textContent).toContain(award.clan.rosterHash);
 expect(awardDetails.querySelector('[aria-label="Original clan roster share"]')?.textContent).toContain('divided equally among that roster, rounded down');
 expect(details.find(d=>d.querySelector('summary')?.textContent==='Confirm receiving kingdom')?.textContent).toContain(id(1));
 const primary=reviewPanel.cloneNode(true) as HTMLElement;primary.querySelectorAll('details').forEach(d=>d.remove());
 expect(primary.textContent).not.toContain(award.clan.clanId);expect(primary.textContent).not.toContain(id(1));
 expect(primary.textContent).toContain(`Original roster: ${award.clan.rosterSize} members`);
 expect(primary.textContent).not.toContain('Site gross allowance');expect(primary.textContent).not.toContain('Later membership');
 expect(primary.querySelector('[aria-label="Original fragment allocation"]')?.querySelectorAll('dd')).toHaveLength(3);
 expect(primary.textContent).toContain('Delivery is untaxed');
 const command=(await saved()).operation!.command;expect(command.kind==='delivery'&&command.consent.award).toEqual(award);
 await act(async()=>awardDetails.querySelector('summary')!.click());expect(awardDetails.open).toBe(true);
 await act(async()=>awardDetails.querySelector('summary')!.click());expect(awardDetails.open).toBe(false);
 expect((await saved()).operation!.command).toEqual(command);expect(posts()).toHaveLength(0);
 await click('CONFIRM FRAGMENT DELIVERY');await until(()=>expect(host.textContent).toContain('ORIGINAL DELIVERY RECEIVED'));
 expect((await saved()).operation?.proof?.receipt?.quantity).toBe(award.net);expect(Object.keys(JSON.parse(posts()[0]![1]!.body as string)).sort()).toEqual(['baseId','idempotencyKey']);
});
it('clan receipt survives a lost reply, paused remount and changed kingdom with roster history intact',async()=>{
 const award=clanAward();serveClan(()=>award);await mount();await review();lose=true;await click('CONFIRM FRAGMENT DELIVERY');
 await until(()=>expect(host.textContent).toContain('ORIGINAL OUTCOME UNKNOWN'));await act(async()=>root.render(null));
 await act(async()=>useApp.getState().setSelectedBaseId(id(9),false));await mount(false);await until(()=>expect(host.textContent).toContain('ORIGINAL DELIVERY RECEIVED'));
 await click('ARCHIVE RECEIPT');await until(async()=>expect((await saved()).archives).toHaveLength(1));await click('HISTORY');
 const history=host.querySelector('[aria-label="Fragment recovery history"]')!;expect(history.textContent).toContain('Clan occupation award');expect(history.textContent).toContain(award.clan.rosterHash);
 await click('CHECK SAVED RECEIPT');await until(()=>expect(button('CHECK SAVED RECEIPT')?.disabled).toBe(false));
 expect(posts()).toHaveLength(1);expect((await saved()).archives[0]?.operation.command.consent.request.baseId).toBe(id(1));
});
it('a new clan roster proof cannot silently replace the original explicit delivery review',async()=>{
 let award=clanAward();serveClan(()=>award);await mount();await review();const original=(await saved()).operation!.command;
 award={...award,clan:{...award.clan,rosterHash:'d'.repeat(64)}};await click('CONFIRM FRAGMENT DELIVERY');
 await until(()=>expect(host.textContent).toContain('source changed'));expect(posts()).toHaveLength(0);expect((await saved()).operation?.command).toEqual(original);
});
