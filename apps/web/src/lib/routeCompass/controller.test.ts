import {IDBFactory} from 'fake-indexeddb';
import {describe,it,expect} from 'vitest';
import vector from '../../../../../packages/shared/testFixtures/ordinaryEquipment.json';
import lensVector from '../../../../../packages/shared/testFixtures/surveyLens.json';
import {REALM_IDS} from '@shardkeep/shared/baseVisual';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {applyEquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {CompassJournalStore,parseCompassCommand,matchCompassProof,same,type CompassProof} from './journal';
import {CompassController,type CompassPorts} from './controller';
const identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:vector.view.wallet},baseId=vector.request.baseId;
function craftCommand(){const c=parseCompassCommand({kind:'craft',request:vector.request,quote:vector.view.recipes[0]});if(c.kind!=='craft')throw Error('fixture');return c;}
const command=craftCommand();
const unknown={wallet:identity.wallet,idempotencyKey:command.request.idempotencyKey,serverNow:vector.view.serverNow,status:'unknown',receipt:null,completion:null};
function fixture(){const store=new CompassJournalStore(identity,new IDBFactory());let active=true,enabled=true,server:unknown=unknown,drop=false,late=false,refuse=false,changeQuote=false,posts=0;const methods:string[]=[];
 const ports:CompassPorts={key:()=>vector.request.idempotencyKey,capture:(fresh)=>{const guard=()=>{if(!active||fresh&&!enabled)throw Error('stale');};guard();return guard;},lock:async(_name,run)=>run(),read:async r=>{if(r.kind==='equipment')return {...lensVector.view,recipes:changeQuote?[]:lensVector.view.recipes};if(r.kind==='starter')return vector.starterView;throw Error('provider unavailable');},original:async(c,method,_first,guard,retain,refused)=>{guard();methods.push(method);if(method==='POST'){posts++;if(refuse){await refused({phase:'first_post',status:503,code:'PHASE_E_DISABLED'});throw Error('paused');}server=vector.envelope;if(drop)throw Error('lost reply');}const p=matchCompassProof(server,identity,c);if(p.status==='accepted')await retain(p);if(late)active=false;guard();return p;}};
 return {store,ports,c:new CompassController(store,ports),methods,posts:()=>posts,drop:()=>{drop=true;},late:()=>{late=true;},refuse:()=>{refuse=true;},pause:()=>{enabled=false;},changed:()=>{changeQuote=true;},server:(p:unknown)=>{server=p;}};
}
describe('Compass explicit consent and lost-response recovery',()=>{
 it('begin saves review without POST, confirm reads same key then marks attempt before one POST',async()=>{const f=fixture();await f.c.load(baseId);await f.c.begin(command);expect(f.posts()).toBe(0);expect(f.c.getSnapshot().journal?.operation?.attemptRevision).toBeNull();await f.c.recover(command.request.idempotencyKey,true);expect(f.methods).toEqual(['GET','POST']);expect((await f.store.read()).operation?.attemptRevision).toBeGreaterThan(0);expect((await f.store.read()).operation?.proof?.status).toBe('accepted');});
 it('lost successful POST survives restart and paused read-only recovery without second POST',async()=>{const f=fixture();await f.c.begin(command);f.drop();await expect(f.c.recover(command.request.idempotencyKey,true)).rejects.toThrow('lost');expect((await f.store.read()).operation?.attemptRevision).not.toBeNull();const restarted=new CompassController(f.store,f.ports);f.pause();await restarted.load();await restarted.recover(command.request.idempotencyKey);expect(f.posts()).toBe(1);expect((await f.store.read()).operation?.proof?.status).toBe('accepted');});
 it('retains validated late owned evidence while rejecting stale publication',async()=>{const f=fixture();await f.c.begin(command);f.server(vector.envelope);f.late();await expect(f.c.recover(command.request.idempotencyKey)).rejects.toThrow('stale');expect((await f.store.read()).operation?.proof?.status).toBe('accepted');expect(f.c.getSnapshot().journal?.operation?.proof).toBeNull();});
 it('unknown reads cannot erase known acceptance or cause a replacement POST',async()=>{const f=fixture();await f.c.begin(command);await f.c.recover(command.request.idempotencyKey,true);f.server(unknown);await expect(f.c.recover(command.request.idempotencyKey,true)).rejects.toThrow();expect((await f.store.read()).operation?.proof?.status).toBe('accepted');expect(f.posts()).toBe(1);});
 it('refuses new consent or changed current quotes and keeps the existing key',async()=>{const f=fixture();await f.c.begin(command);await expect(f.c.begin({...command,request:{...command.request,idempotencyKey:'00000000-0000-4000-8000-000000000099'}})).rejects.toThrow('Recover');f.changed();await expect(f.c.recover(command.request.idempotencyKey,true)).rejects.toThrow();expect(f.posts()).toBe(0);expect(same((await f.store.read()).operation?.command,command)).toBe(true);});
 it('can close unattempted or definitive refused intent only after fresh unknown evidence',async()=>{for(const refused of [false,true]){const f=fixture();await f.c.begin(command);if(refused){f.refuse();await expect(f.c.recover(command.request.idempotencyKey,true)).rejects.toThrow('paused');}await f.c.abandon(command.request.idempotencyKey);expect((await f.store.read()).operation).toBeNull();expect((await f.store.read()).archives[0]?.reason).toBe(refused?'refused':'unattempted');}});
 it('cannot close an ambiguous submitted command after absent server history',async()=>{const f=fixture();await f.c.begin(command);f.drop();await expect(f.c.recover(command.request.idempotencyKey,true)).rejects.toThrow();f.server(unknown);await expect(f.c.abandon(command.request.idempotencyKey)).rejects.toThrow('uncertain');expect((await f.store.read()).archives).toHaveLength(0);});
 it('preserves accepted original history when next review starts and recovers its completion',async()=>{const f=fixture();await f.c.begin(command);await f.c.recover(command.request.idempotencyKey,true);await f.c.begin({...command,request:{...command.request,idempotencyKey:'00000000-0000-4000-8000-000000000009'}});expect((await f.store.read()).archives).toHaveLength(1);const completed={...vector.envelope,serverNow:vector.envelope.receipt.readyAt,completion:{completedAt:vector.envelope.receipt.readyAt}};f.server(completed);await f.c.recover(command.request.idempotencyKey);expect((await f.store.read()).archives[0]!.operation.proof).toMatchObject({completion:completed.completion});});
 it('matches fitted starter/advanced historical quotes independent of JSON key order',()=>{for(const [kind,raw] of [['starter',vector.starterEnvelope],['advanced',vector.advancedEnvelope]] as const){const c=parseCompassCommand({kind,request:raw.receipt.request,quote:raw.receipt.route});expect(matchCompassProof(raw,identity,c).status).toBe('accepted');const changed=structuredClone(raw);changed.receipt.request.fitting.itemId='survey_lens';expect(()=>matchCompassProof(changed,identity,c)).toThrow();}});
});

const lens={itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'} as const;
const paidRealm=REALM_IDS.indexOf('elderwood');
const paidView=()=>({wallet:identity.wallet,baseId,realm:paidRealm,serverNow:vector.view.serverNow,authorization:'none',acceptingDepartures:true,
 route:applyEquipmentFitting(paidStarterRoutePreview('paid_elderwood'),lens),coverage:{status:'blocked',reason:'NO_COVERAGE'}});
describe('Survey Lens paid destination previews',()=>{
 it('refuses primary-equals-secondary cargo before requesting a server preview',async()=>{
  const f=fixture(),reads:unknown[]=[];f.ports.read=async request=>{reads.push(request);return paidView();};f.c.chooseFitting(lens);
  await expect(f.c.paid(baseId,REALM_IDS.indexOf('frostveil'))).rejects.toThrow('different primary cargo');
  expect(reads).toEqual([]);expect(f.c.getSnapshot().paid).toBeNull();expect((await f.store.read()).operation).toBeNull();
 });
 it('validates an admitted compatible quote and clears it before a failed replacement without altering saved consent',async()=>{
  const f=fixture();await f.c.begin(command);const saved=await f.store.read();f.c.chooseFitting(lens);
  f.ports.read=async()=>paidView();await f.c.paid(baseId,paidRealm);expect(f.c.getSnapshot().paid).toEqual(paidView());
  f.ports.read=async()=>{expect(f.c.getSnapshot().paid).toBeNull();throw Error('Destination preview unavailable');};
  await expect(f.c.paid(baseId,paidRealm)).rejects.toThrow('Destination preview unavailable');
  expect(f.c.getSnapshot()).toMatchObject({paid:null,error:'Destination preview unavailable'});expect(await f.store.read()).toEqual(saved);expect(f.posts()).toBe(0);
 });
 it('changing paid destination during original confirmation preserves receipt persistence and publication',async()=>{
  const f=fixture();await f.c.begin(command);
  let started!:()=>void,release!:()=>void;const posting=new Promise<void>(resolve=>{started=resolve;}),response=new Promise<void>(resolve=>{release=resolve;});
  const original=f.ports.original;f.ports.original=async(...args)=>{if(args[1]==='POST'){started();await response;}return original(...args);};
  const pending=f.c.recover(command.request.idempotencyKey,true);await posting;f.c.clearPaidPreview();release();await pending;
  expect(f.posts()).toBe(1);expect((await f.store.read()).operation?.command).toEqual(command);
  expect((await f.store.read()).operation?.proof?.status).toBe('accepted');
  expect(f.c.getSnapshot().journal?.operation?.proof?.status).toBe('accepted');expect(f.c.getSnapshot().error).toBeNull();
 });
 it.each(['success','failure'] as const)('destination changes suppress an obsolete %s without changing the saved original',async outcome=>{
  const f=fixture();await f.c.begin(command);const saved=await f.store.read();f.c.chooseFitting(lens);
  let started!:()=>void,release!:()=>void;const reading=new Promise<void>(resolve=>{started=resolve;}),response=new Promise<void>(resolve=>{release=resolve;});
  f.ports.read=async()=>{started();await response;if(outcome==='failure')throw Error('Old destination unavailable');return paidView();};
  const pending=f.c.paid(baseId,paidRealm).catch(error=>error);await reading;f.c.clearPaidPreview();release();
  expect(await pending).toBeInstanceOf(Error);expect(f.c.getSnapshot()).toMatchObject({paid:null,error:null,busy:false});
  expect(await f.store.read()).toEqual(saved);expect(f.posts()).toBe(0);
 });
});
