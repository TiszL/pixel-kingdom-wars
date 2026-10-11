import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {KeepEquipmentPurchaseSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {ApiError} from '../api';
import {KeepMarketController,type KeepMarketPorts} from './controller';
import {KeepMarketJournalStore,marketKey} from './journal';
import {prepareKeepEquipmentSigning,signKeepEquipment} from './signing';
import {keepMarketFixture} from './fixtures.testHelpers';

const stores:KeepMarketJournalStore[]=[];
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(stores.map(s=>s.close()));stores.length=0;vi.unstubAllGlobals();});
const missingFinality=()=>new ApiError(503,'Keep this purchase saved; payment recovery is held','KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE',{status:'held',fenceReleaseAuthorized:false,unpaidProven:false,broadcastAuthorized:false});
async function fixture(){
 const f=keepMarketFixture(),identity={origin:'http://localhost',api:'http://localhost/api',cluster:'devnet' as const,wallet:f.value.fill.buyerWallet},store=new KeepMarketJournalStore(identity,new IDBFactory());stores.push(store);
 const command={kind:'fill' as const,key:f.value.fill.id,request:{idempotencyKey:f.value.fill.id,listingId:f.value.fill.listingId,buyerBaseId:f.value.fill.buyerBaseId,quantity:f.value.fill.quantity}},key=marketKey(command);
 await store.begin(command);await store.retain(key,f.value);await store.startSigning(key);
 const wire=await signKeepEquipment(await prepareKeepEquipmentSigning(f.value,f.trust,identity.wallet),f.signer);
 await store.retainSigned(key,wire);
 const server=KeepEquipmentPurchaseSchema.parse({...f.value,status:'signed',wire:{...wire,recordedAt:f.value.preparation!.recordedAt}});await store.retain(key,server);
 const controls={error:missingFinality() as unknown,active:true,reviewHeld:false,expireAfterReview:false,staleAfterRecovery:false};
 const calls:string[]=[],guard=()=>{if(!controls.active)throw Error('view changed');};
 const ports:KeepMarketPorts={capture:()=>{guard();return guard;},key:()=>crypto.randomUUID(),lock:async(_key,run)=>run(),
  request:vi.fn(async(request,check,retain)=>{
   check();calls.push(request.action);
   if(request.action==='recover'){
    if(controls.staleAfterRecovery)controls.active=false;
    if(controls.error)throw controls.error;
    await retain(server);check();return server;
   }
   expect(request.action).toBe('deliver');expect(request.id).toBe(server.fill.id);
   const saved=(await store.read()).pending[0]!;expect(saved.wire).toEqual(wire);expect(KeepEquipmentPurchaseSchema.parse(saved.original).wire).toEqual(server.wire);
   await retain(server);check();return {purchase:server,status:'submitted',reason:null,broadcastAuthorized:false,fenceReleaseAuthorized:false};
  }),
  review:vi.fn(async(value,check)=>{check();calls.push('wallet-review');expect(value).toEqual(server);if(controls.reviewHeld)throw Error('independent review held');
   return {...f.value.preparation!.costs,assertFresh:()=>{check();if(controls.expireAfterReview)throw Error('current review expired');}};
  }),
  sign:vi.fn(async()=>{throw Error('A retained packet must never request another signature.');}),
 };
 const controller=new KeepMarketController(store,ports);controller.select(key);
 return {...f,controller,store,ports,controls,calls,server,wire,key};
}

it('the real missing-finality API error permits the first exact retained relay only after independent current review',async()=>{
 const f=await fixture();await f.controller.deliver();
 expect(f.calls).toEqual(['recover','wallet-review','deliver']);expect(f.ports.sign).not.toHaveBeenCalled();
 const saved=(await f.store.read()).pending[0]!;expect(saved.wire).toEqual(f.wire);expect(saved.observedComplete).toBe(false);expect(saved.signingStarted).toBe(true);
});

it.each([
 ['unauthenticated',new ApiError(401,'Sign in again','UNAUTHENTICATED')],
 ['unknown original',new ApiError(404,'Original not found','KEEP_EQUIPMENT_FILL_UNKNOWN')],
 ['wrong configuration',new ApiError(503,'Payment configuration held','KEEP_EQUIPMENT_PAYMENT_CONFIGURATION')],
 ['not retained',new ApiError(503,'Original not retained','KEEP_EQUIPMENT_PAYMENT_NOT_RETAINED')],
 ['server failure',new ApiError(500,'Server error','INTERNAL_ERROR')],
 ['network uncertainty',new ApiError(0,'Response timed out','ORIGINAL_RESPONSE_TIMEOUT')],
 ['untyped error',Object.assign(Error('untrusted shape'),{status:503,code:'KEEP_EQUIPMENT_PAYMENT_UNAVAILABLE'})],
] as const)('does not widen missing-finality recovery fallback to %s',async(_name,error)=>{
 const f=await fixture();f.controls.error=error;await expect(f.controller.deliver()).rejects.toThrow();
 expect(f.calls).toEqual(['recover']);expect(f.ports.review).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();expect((await f.store.read()).pending[0]!.wire).toEqual(f.wire);
});

it.each(['held','expired'] as const)('missing finality plus %s independent review cannot relay or release an original',async kind=>{
 const f=await fixture();f.controls.reviewHeld=kind==='held';f.controls.expireAfterReview=kind==='expired';
 await expect(f.controller.deliver()).rejects.toThrow(kind==='held'?'independent review held':'current review expired');
 expect(f.calls).toEqual(['recover','wallet-review']);const saved=(await f.store.read()).pending[0]!;expect(saved.wire).toEqual(f.wire);expect(saved.observedComplete).toBe(false);
});

it('a view change during the recover error blocks even the narrowly permitted original relay',async()=>{
 const f=await fixture();f.controls.staleAfterRecovery=true;await expect(f.controller.deliver()).rejects.toThrow('view changed');
 expect(f.calls).toEqual(['recover']);expect(f.ports.review).not.toHaveBeenCalled();expect((await f.store.read()).pending[0]!.wire).toEqual(f.wire);
});
