// @vitest-environment happy-dom
import {webcrypto} from 'node:crypto';
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {DivineTrialEventSchema,DivineTrialEntrySchema,DivineTrialParticipantSchema,DivineTrialAttemptSchema,type DivineTrialEvent,type DivineTrialParticipant} from '@shardkeep/shared/divineTrialsApi';
import vector from '../../../../../packages/shared/src/testFixtures/divineTrialVectors.json';
import {useApp} from '../../state/store';
import {authCookies} from '../../auth/authCookieCoordinator';
import {DivineTrialJournalStore} from '../../lib/divineTrials/journal';
import {browserDivineIdentity} from '../../lib/divineTrials/browser';
import {requestDivineTrial} from '../../lib/divineTrials/transport';
import {beginDivineBattle} from '../../lib/divineTrials/battleSession';
import {DivineTrialScreen} from './DivineTrialScreen';
vi.mock('../../lib/divineTrials/transport',()=>({requestDivineTrial:vi.fn()}));
vi.mock('../../lib/divineTrials/battleSession',()=>({beginDivineBattle:vi.fn()}));
let host:HTMLDivElement,root:Root,event:DivineTrialEvent,participant:DivineTrialParticipant;
const wallet=vector.entry.wallet,baseId=vector.entry.baseId;
const button=(name:string)=>[...host.querySelectorAll('button')].find(n=>n.textContent?.trim()===name);
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
const click=async(name:string)=>{expect(button(name)?.disabled).toBe(false);await act(async()=>button(name)!.click());};
const store=()=>new DivineTrialJournalStore(browserDivineIdentity(wallet));
async function read(){const s=store();try{return await s.read();}finally{await s.close();}}
async function open(enabled=true){await act(async()=>root.render(<StrictMode><DivineTrialScreen actionsEnabled={enabled} onClose={()=>{}}/></StrictMode>));const name='WEEK OF '+event.entryStartsAt.slice(0,10)+' · '+(event.terminal?'RESULTS':'TRIAL');await until(()=>expect(button(name)?.disabled).toBe(false));await click(name);await until(()=>expect(button('CHECK ORIGINAL HISTORY')?.disabled).toBe(false));}
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('indexedDB',new IDBFactory());vi.stubGlobal('IDBKeyRange',IDBKeyRange);Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_n:string,_o:unknown,run:(v:object)=>Promise<unknown>)=>run({})}});vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
 useApp.getState().setAuth(wallet,true);useApp.getState().setSelectedBaseId(baseId,false);useApp.getState().setScreen('bases');useApp.setState({booted:false});event=DivineTrialEventSchema.parse(vector.event);participant=DivineTrialParticipantSchema.parse({version:1,eventId:event.id,wallet,entry:null,attempts:[],prize:null});
 vi.mocked(requestDivineTrial).mockReset().mockImplementation(async input=>{input.guard();const r=input.request;let result:Awaited<ReturnType<typeof requestDivineTrial>>;if(r.kind==='events')return {version:1 as const,events:[event],nextCursor:null};if(r.kind==='participant')result=participant;else if(r.kind==='entry'){expect((await read()).events[0]?.entryIntent).toEqual(r.body);participant.entry=DivineTrialEntrySchema.parse({...vector.entry,...r.body as object});result=participant.entry;}else if(r.kind==='prize'){expect((await read()).events[0]?.prizeIntent).toEqual(r.body);const claim={eventId:event.id,wallet,...r.body as {baseId:string},amounts:participant.prize!.amounts,claimedAt:event.playEndsAt};participant.prize={...participant.prize!,claim};result=claim;}else throw Error('Unexpected request');await input.retain(result);input.guard();return result;});vi.mocked(beginDivineBattle).mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('distinguishes qualification requirements from actual accepted Renown and saves entry before mutation',async()=>{
 await open();expect(host.textContent).toContain('Requires '+P.minRenown+' personally earned Renown');expect(host.textContent).not.toContain('Qualified entry saved');expect(vi.mocked(requestDivineTrial).mock.calls.every(([i])=>['events','participant'].includes(i.request.kind))).toBe(true);expect(host.querySelector('time')?.textContent).toContain('UTC');
 await click('ENTER WITH SELECTED KINGDOM');await until(()=>expect(host.textContent).toContain('Qualified entry saved'));expect((await read()).events[0]?.entry?.baseId).toBe(baseId);expect(button('ENTER WITH SELECTED KINGDOM')).toBeUndefined();expect(beginDivineBattle).not.toHaveBeenCalled();
});
it.each([false,true])('terminal results close fresh entry and attempts while keeping original history and funded prizes (entered=%s)',async entered=>{
 event=DivineTrialEventSchema.parse({...vector.event,terminal:vector.terminal});participant.entry=entered?DivineTrialEntrySchema.parse(vector.entry):null;participant.prize={amounts:event.budget,claim:null};await open();
 expect(host.textContent).toContain('Entry and new attempts are closed');expect(button('ENTER WITH SELECTED KINGDOM')).toBeUndefined();expect(button('START ATTEMPT AT SELECTED KINGDOM')).toBeUndefined();expect(button('CLAIM TO SELECTED KINGDOM')?.disabled).toBe(false);expect(button('CHECK ORIGINAL HISTORY')?.disabled).toBe(false);expect(vi.mocked(requestDivineTrial).mock.calls.every(([i])=>['events','participant'].includes(i.request.kind))).toBe(true);
});
it('does not treat failed participation lookup as eligibility and focuses the recoverable error',async()=>{
 const original=vi.mocked(requestDivineTrial).getMockImplementation()!;vi.mocked(requestDivineTrial).mockImplementation(input=>input.request.kind==='participant'?Promise.reject(Error('Original participation unavailable')):original(input));await open();expect(button('ENTER WITH SELECTED KINGDOM')).toBeUndefined();expect(button('START ATTEMPT AT SELECTED KINGDOM')).toBeUndefined();expect(host.textContent).toContain('Original participation has not been confirmed');expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));expect(button('CHECK ORIGINAL HISTORY')?.disabled).toBe(false);
});
it('retains an unanswered entry and unfinished attempt without offering replacement requests',async()=>{
 const s=store();await s.retainEvent(event);await s.intent(event.id,'entry',{baseId,idempotencyKey:vector.entry.idempotencyKey});await s.close();await open();expect(host.textContent).toContain('Entry outcome is unknown');expect(button('ENTER WITH SELECTED KINGDOM')).toBeUndefined();expect(button('RETRY EXACT SAVED REQUESTS')?.disabled).toBe(false);
 await act(async()=>root.render(null));participant.entry=DivineTrialEntrySchema.parse(vector.entry);participant.prize={amounts:event.budget,claim:null};const saved=store();await saved.retainEntry(event.id,participant.entry);await saved.intent(event.id,'attempt',{baseId,idempotencyKey:vector.plans[0]!.attempt.idempotencyKey});await saved.close();await open(false);expect(host.textContent).toContain('An original attempt is unfinished');expect(button('CLAIM TO SELECTED KINGDOM')?.disabled).toBe(true);expect(button('START ATTEMPT AT SELECTED KINGDOM')).toBeUndefined();expect(button('RETRY EXACT SAVED REQUESTS')?.disabled).toBe(false);expect(vi.mocked(requestDivineTrial).mock.calls.every(([i])=>['events','participant'].includes(i.request.kind))).toBe(true);
});
it('opens the exact admitted field only when the existing battle surface is ready, without creating another attempt',async()=>{
 participant.entry=DivineTrialEntrySchema.parse(vector.entry);participant.attempts=[DivineTrialAttemptSchema.parse({...vector.plans[0]!.attempt,status:'admitted',orders:null,result:null,completedAt:null})];await open();expect(button('OPEN TRIAL FIELD')?.disabled).toBe(true);expect(host.textContent).toContain('trial field is still loading');expect(button('START ATTEMPT AT SELECTED KINGDOM')).toBeUndefined();await act(async()=>useApp.setState({booted:true}));await click('OPEN TRIAL FIELD');expect(beginDivineBattle).toHaveBeenCalledWith({wallet,eventId:event.id,attemptId:participant.attempts[0]!.id});expect(vi.mocked(requestDivineTrial).mock.calls.every(([i])=>['events','participant'].includes(i.request.kind))).toBe(true);
});
it('keeps an unanswered prize at its original destination and retries that exact claim while paused after a kingdom switch',async()=>{
 event=DivineTrialEventSchema.parse({...vector.event,terminal:vector.terminal});participant.prize={amounts:event.budget,claim:null};const s=store();await s.retainEvent(event);await s.intent(event.id,'prize',{baseId});await s.close();useApp.getState().setSelectedBaseId(vector.entry.id,false);await open(false);
 const prize=host.querySelector('[aria-label="Your Divine prize"]')!;expect(prize.textContent).toContain('untaxed');expect(prize.textContent).toContain('Prize destination: Original kingdom · original saved destination.');expect(button('CLAIM TO SELECTED KINGDOM')).toBeUndefined();await click('RETRY EXACT SAVED REQUESTS');await until(()=>expect(prize.textContent).toContain('Claim confirmed'));expect((await read()).events[0]?.claim?.baseId).toBe(baseId);expect(vi.mocked(requestDivineTrial).mock.calls.filter(([i])=>i.request.kind==='prize').map(([i])=>i.request)).toEqual([{kind:'prize',eventId:event.id,body:{baseId}}]);
});
it('shows an empty discovery state and keeps keyboard close and opener focus in the existing game frame',async()=>{
 vi.mocked(requestDivineTrial).mockResolvedValue({version:1,events:[],nextCursor:null});const opener=document.createElement('button');document.body.append(opener);opener.focus();const close=vi.fn();await act(async()=>root.render(<DivineTrialScreen actionsEnabled={false} onClose={close}/>));await until(()=>expect(host.textContent).toContain('No funded trials were returned'));const dialog=host.querySelector('[role="dialog"]')!;expect(dialog.getAttribute('aria-label')).toBe('Divine individual trials');await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(close).toHaveBeenCalledOnce();await act(async()=>root.render(null));expect(document.activeElement).toBe(opener);opener.remove();
});
