import {Buffer} from 'buffer';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {describe,it,expect,vi} from 'vitest';
import {RealmSaleController,type RealmSalePorts} from './controller';
import {RealmSaleJournalStore,type RealmSaleOperation} from './journal';
import {realmSaleBrowserFailureFixture} from './failure.test-support';
async function setup(){
 const f=await realmSaleBrowserFailureFixture(),factory=new IDBFactory(),identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:f.preparation.wallet};
 const store=new RealmSaleJournalStore(identity,factory,'realm-failure-controller',f.trust),request={idempotencyKey:f.preparation.idempotencyKey,spot:f.preparation.spot,realm:f.preparation.realm};
 let row=await store.compareAndSet(0,j=>({...j,operation:{request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
 const edit=async(patch:Partial<RealmSaleOperation>)=>{row=await store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,...patch}}));};
 await edit({prepareAttempted:true});await edit({preparation:f.preparation});await edit({signingStarted:true});await edit({signed:{wire:Buffer.from(f.wire.signedTransactionHex,'hex').toString('base64'),signature:f.wire.signature}});await edit({submitAttempted:true});
 const state={active:true,actions:false};let failure:unknown=f.failure;
 const envelope=()=>({wallet:identity.wallet,idempotencyKey:request.idempotencyKey,failure});
 const noEffect=vi.fn(async()=>{throw Error('No automatic external effect');});
 const ports:RealmSalePorts={capture:newAction=>()=>{if(!state.active||newAction&&!state.actions)throw Error('obsolete or paused');},lock:async(_key,run)=>run(),key:()=>crypto.randomUUID(),clock:()=>0,
  prepare:noEffect,currentReview:noEffect,sign:noEffect,submit:noEffect,
  getPreparation:async(_r,_g,retain)=>{const raw={wallet:identity.wallet,idempotencyKey:request.idempotencyKey,preparation:f.preparation};await retain(raw);return raw;},
  getSaved:async(_key,_g,retain)=>{const raw={wallet:identity.wallet,idempotencyKey:request.idempotencyKey,preparation:f.preparation,wire:f.wire,settlement:null};await retain(raw);return raw;},
  getFailure:vi.fn(async(_key,_guard,retain)=>{const raw=envelope();await retain(raw);return raw;}),
 };
 const controller=new RealmSaleController(store,ports);
 return {f,store,factory,identity,request,state,ports,controller,envelope,noEffect,setFailure:(raw:unknown)=>{failure=raw;},reopen:()=>new RealmSaleController(new RealmSaleJournalStore(identity,factory,'realm-failure-controller',f.trust),ports)};
}
describe('browser failed realm purchase recovery',()=>{
 it('recovers signed failed purchase using only original GETs while paused and archives only after a fresh GET',async()=>{
  const x=await setup();await x.controller.open();expect((await x.store.read()).operation?.failure?.value).toEqual(x.f.failure);expect(x.controller.snapshot().settlementHeld).toBe(true);expect(x.ports.getFailure).toHaveBeenCalledTimes(1);
  const restarted=x.reopen();await restarted.archiveFailed();expect(x.ports.getFailure).toHaveBeenCalledTimes(2);expect((await x.store.read()).operation).toBeNull();expect((await x.store.archived(x.request.idempotencyKey))?.operation?.signed?.signature).toBe(x.f.wire.signature);expect(x.noEffect).not.toHaveBeenCalled();
 });
 it('retains a valid late failure after logout and view dismissal before publication guards',async()=>{
  const x=await setup();x.ports.getFailure=vi.fn(async(_key,guard,retain)=>{x.state.active=false;x.controller.dismiss();const raw=x.envelope();await retain(raw);guard();return raw;});await x.controller.open();expect((await x.store.read()).operation?.failure?.value).toEqual(x.f.failure);expect(x.noEffect).not.toHaveBeenCalled();
 });
 it('records malformed positive failure before rejecting proof and keeps the hold after null recovery',async()=>{
  const x=await setup();x.setFailure({unexpected:true});await x.controller.open();expect((await x.store.read()).operation?.failureObserved).toBe(true);expect((await x.store.read()).operation?.failure).toBeUndefined();x.setFailure(null);const next=x.reopen();await next.check();await next.archiveFailed();expect(next.snapshot().settlementHeld).toBe(true);expect((await x.store.read()).operation).not.toBeNull();expect(x.noEffect).not.toHaveBeenCalled();
 });
 it('foreign actor/key evidence never becomes this purchase proof or hold',async()=>{
  const x=await setup();x.ports.getFailure=vi.fn(async(_key,_guard,retain)=>{const raw={...x.envelope(),wallet:x.f.preparation.terms.seller};await retain(raw);return raw;});await x.controller.open();expect((await x.store.read()).operation?.failureObserved).toBeUndefined();expect(x.store.settlementHeld()).toBe(false);
 });
 it.each(['null','changed','unavailable'])('fresh %s recovery cannot erase the bound failure or archive it',async kind=>{
  const x=await setup();await x.controller.open();if(kind==='unavailable')x.ports.getFailure=vi.fn(async()=>{throw Error('offline');});else x.setFailure(kind==='null'?null:{...x.f.failure,verifiedAt:'2026-09-27T00:00:00.000000Z'});
  await x.controller.archiveFailed();expect((await x.store.read()).operation?.failure?.value).toEqual(x.f.failure);expect(await x.store.archived(x.request.idempotencyKey)).toBeNull();expect(x.noEffect).not.toHaveBeenCalled();
 });
 it('a storage failure still shares its positive hold with a reopened controller',async()=>{
  const x=await setup();const put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw Error('disk full');});await x.controller.open();put.mockRestore();expect(x.store.settlementHeld()).toBe(true);x.setFailure(null);await x.reopen().archiveFailed();expect((await x.store.read()).operation).not.toBeNull();
 });
 it('requires unchanged durable revision across the fresh archival request',async()=>{
  const x=await setup();await x.controller.open();x.ports.getFailure=vi.fn(async(_key,_guard,retain)=>{const raw=x.envelope();await retain(raw);const row=await x.store.read();await x.store.compareAndSet(row.revision,j=>j);return raw;});await x.controller.archiveFailed();expect((await x.store.read()).operation).not.toBeNull();expect(await x.store.archived(x.request.idempotencyKey)).toBeNull();
 });
 it('dismiss during fresh archive GET preserves proof and prevents local clearing',async()=>{
  const x=await setup();await x.controller.open();x.ports.getFailure=vi.fn(async(_key,guard,retain)=>{const raw=x.envelope();await retain(raw);x.controller.dismiss();guard();return raw;});await x.controller.archiveFailed();expect((await x.store.read()).operation?.failure).toBeTruthy();
 });
 it('missing original saved wire never promotes the owner attestation into a complete proof',async()=>{
  const x=await setup();x.ports.getSaved=async(_key,_guard,retain)=>{const raw={wallet:x.identity.wallet,idempotencyKey:x.request.idempotencyKey,preparation:x.f.preparation,wire:null,settlement:null};await retain(raw);return raw;};await x.controller.open();expect((await x.store.read()).operation?.failureObserved).toBe(true);expect((await x.store.read()).operation?.failure).toBeUndefined();expect(x.noEffect).not.toHaveBeenCalled();
 });
});
