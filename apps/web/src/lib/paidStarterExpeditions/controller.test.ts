import {ApiError} from '../api';
import {IDBFactory} from 'fake-indexeddb';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PaidStarterExpeditionViewSchema} from '@shardkeep/shared/paidStarterExpeditionApi';
import {paidStarterRoutePreview} from '@shardkeep/shared/paidStarterExpeditions';
import {StarterExpeditionEnvelopeSchema} from '@shardkeep/shared/starterExpeditionApi';
import {StarterExpeditionController,type StarterExpeditionPorts} from '../starterExpedition/controller';
import {StarterExpeditionJournalStore,parseStarterExpeditionCommand,matchStarterExpeditionProof} from '../starterExpedition/journal';
import {id,identity as originalIdentity,view} from '../starterExpedition/fixtures.test-support';
import observation from './access.fixture.json';
const identity={...originalIdentity,wallet:observation.wallet},at=observation.finality.observedAt;
let store:StarterExpeditionJournalStore,controller:StarterExpeditionController,ports:StarterExpeditionPorts,current:ReturnType<typeof view>,selected:ReturnType<typeof paidView>,accepted:boolean,epoch:number;
function paidView(){return PaidStarterExpeditionViewSchema.parse({wallet:identity.wallet,baseId:id(1),realm:0,serverNow:at,authorization:'none',acceptingDepartures:true,
 route:paidStarterRoutePreview('paid_frostveil'),coverage:{status:'covered',expiresAt:observation.expiresAt,observedAt:at}});}
async function proof(){const c=(await store.read()).operation!.command,request=c.request;
 return StarterExpeditionEnvelopeSchema.parse({wallet:identity.wallet,idempotencyKey:request.idempotencyKey,serverNow:at,status:accepted?'accepted':'unknown',return:null,
 receipt:accepted?{wallet:identity.wallet,request,expeditionId:request.idempotencyKey,installationId:request.installationId,route:{...c.route,access:{kind:'paid_realm',policyVersion:1,observation}},departedAt:at,returnsAt:new Date(Date.parse(at)+c.route.durationSec*1000).toISOString(),termId:id(6),termHash:'ab'.repeat(32)}:null});}
beforeEach(()=>{
 store=new StarterExpeditionJournalStore(identity,new IDBFactory());current=view();current.wallet=identity.wallet;current.serverNow=at;current.lodgeCompletedAt=at;current.installation!.installedAt=at;current.installation!.berthCompletedAt=at;
 selected=paidView();accepted=false;epoch=0;
 ports={get:vi.fn(async(path,guard)=>{guard();return path.includes('/paid-route?')?selected:current;}),getProof:vi.fn(async(_request,guard,retain)=>{guard();const raw=await proof();await retain(raw);guard();return raw;}),
 post:vi.fn(async(request,guard,retain)=>{guard();const saved=await store.read();expect(saved.operation?.command.request).toEqual(request);expect(saved.operation?.attemptRevision).toBe(saved.revision);accepted=true;const raw=await proof();await retain(raw);return raw;}),capture:()=>{const captured=epoch;return()=>{if(captured!==epoch)throw Error('Session changed');};},lock:async(_name,work)=>work(),key:()=>id(2)};
 controller=new StarterExpeditionController(store,ports);
});
const begin=()=>controller.beginPaidDeparture(id(1),0);
describe('paid starter durable consent',()=>{
 it('saves economics without a fake observation, fresh-checks both views and retains the actual accepted proof',async()=>{
  await begin();expect(controller.snapshot().error).toBeNull();expect(ports.post).not.toHaveBeenCalled();const c=(await store.read()).operation!.command;expect(c.route).toEqual(selected.route);expect(()=>parseStarterExpeditionCommand({...c,route:{...c.route,access:{kind:'paid_realm',policyVersion:1,observation}}})).toThrow();expect('access' in c.route && c.route.access).not.toHaveProperty('observation');
  await controller.confirm();expect(controller.snapshot().error).toBeNull();expect(ports.post).toHaveBeenCalledOnce();expect((await store.read()).operation?.proof?.status).toBe('accepted');expect(current.routes).toHaveLength(11);
 });
 it.each(['paused','unavailable','expired','realm','wallet','base','lodge','vehicle','flight'] as const)('refuses %s selected or facility authority before saving a draft or POST',async kind=>{
  if(kind==='paused')selected.acceptingDepartures=false;else if(kind==='unavailable')selected.coverage={status:'unavailable'};else if(kind==='expired')selected.coverage={status:'blocked',reason:'EXPIRED'};else if(kind==='realm')selected.realm=1;else if(kind==='wallet')selected.wallet=originalIdentity.wallet;else if(kind==='base')selected.baseId=id(9);else if(kind==='lodge')current.lodgeCompletedAt=null;else if(kind==='vehicle')current.installation=null;
  else {await begin();await controller.confirm();const p=(await store.read()).operation!.proof;if(p?.status!=='accepted')throw Error('fixture');const {wallet:_,request:__,...flight}=p.receipt;current.flight=flight;store=new StarterExpeditionJournalStore(identity,new IDBFactory());controller=new StarterExpeditionController(store,ports);vi.mocked(ports.post).mockClear();}
  await begin();expect(controller.snapshot().error).not.toBeNull();expect((await store.read()).operation).toBeNull();expect(ports.post).not.toHaveBeenCalled();
 });
 it('keeps any attempted ambiguity GET-only through fresh controller, explicit review and confirm',async()=>{
  ports.post=vi.fn(async()=>{throw Error('Lost unknown response');});await begin();await controller.confirm();const original=await store.read();controller=new StarterExpeditionController(store,ports);await controller.open();await controller.reviewCommand();await controller.confirm();await controller.beginPaidDeparture(id(1),0);expect(ports.post).toHaveBeenCalledOnce();expect(await store.read()).toEqual(original);
 });
 it.each([['EXPEDITION_ACCESS_NO_COVERAGE',409],['EXPEDITION_ACCESS_EXPIRED',409],['EXPEDITION_ACCESS_UNAVAILABLE',503]] as const)('archives exact first refusal %s only after original GET absence',async(code,status)=>{
  ports.post=vi.fn(async(_request,_guard,_retain,observe)=>{const error=new ApiError(status,'Original paid departure refused',code);await observe(error);throw error;});await begin();await controller.confirm();
  expect((await store.read()).operation?.refusal).toEqual({phase:'first_post',status,code});const key=(await store.read()).operation!.command.request.idempotencyKey;
  await controller.open();expect((await store.read()).operation).not.toBeNull();await controller.archiveRefusal();expect(controller.snapshot().error).toBeNull();expect((await store.read()).operation).toBeNull();expect((await store.read()).archives[0]?.operation.command.request.idempotencyKey).toBe(key);expect(ports.post).toHaveBeenCalledOnce();
 });
 it('preserves old saved economics and binds actual proof wallet/realm/full quantities instead of applying current tuning',async()=>{
  await begin();const original=(await store.read()).operation!.command,old=parseStarterExpeditionCommand({...original,route:{...original.route,grossQuantity:'103',netQuantity:'98',islandPoolQuantity:'5'}});
  expect(old.route.grossQuantity).toBe('103');accepted=true;const raw=await proof();if(raw.status!=='accepted')throw Error('fixture');
  expect(()=>matchStarterExpeditionProof({...raw,receipt:{...raw.receipt,route:{...raw.receipt.route,grossQuantity:'26',netQuantity:'21'}}},identity,original)).toThrow();
  expect(()=>matchStarterExpeditionProof({...raw,receipt:{...raw.receipt,route:{...raw.receipt.route,access:{kind:'paid_realm',policyVersion:1,observation:{...observation,wallet:originalIdentity.wallet}}}}},identity,original)).toThrow();
 });
 it('invalidates review on selected coverage changes without rewriting the immutable original request',async()=>{
  await begin();const original=(await store.read()).operation!.command;selected.coverage={status:'blocked',reason:'EXPIRED'};await controller.confirm();expect(ports.post).not.toHaveBeenCalled();expect((await store.read()).operation!.command).toEqual(original);expect(controller.snapshot().review).toBeNull();
 });
 it('does not persist or POST after an account-generation change during selected GET',async()=>{
  ports.get=vi.fn(async path=>{if(path.includes('/paid-route?'))epoch++;return path.includes('/paid-route?')?selected:current;});await begin();expect((await store.read()).operation).toBeNull();expect(ports.post).not.toHaveBeenCalled();
 });
});
