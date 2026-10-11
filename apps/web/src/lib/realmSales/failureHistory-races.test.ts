import {Buffer} from 'buffer';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {describe,it,expect,vi} from 'vitest';
import {RealmSaleJournalStore,type RealmSaleOperation} from './journal';
import {realmSaleBrowserFailureFixture} from './failure.test-support';

// Separate facade identities model tabs with independent process WeakMaps but
// one IndexedDB backing database. A second fresh database would miss this race.
function tab(backing:IDBFactory):IDBFactory{return new Proxy(backing,{get(target,key){const value=Reflect.get(target,key,target) as unknown;return typeof value==='function'?value.bind(target):value;}});}
async function archivedFailure(){
 const f=await realmSaleBrowserFailureFixture(),backing=new IDBFactory(),identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:f.preparation.wallet};
 const a=new RealmSaleJournalStore(identity,tab(backing),'realm-failure-history-races',f.trust),b=new RealmSaleJournalStore(identity,tab(backing),'realm-failure-history-races',f.trust);
 const request={idempotencyKey:f.preparation.idempotencyKey,spot:f.preparation.spot,realm:f.preparation.realm};
 let row=await a.compareAndSet(0,j=>({...j,operation:{request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
 const edit=async(patch:Partial<RealmSaleOperation>)=>{row=await a.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,...patch}}));};
 await edit({prepareAttempted:true});await edit({preparation:f.preparation});await edit({signingStarted:true});
 await edit({signed:{wire:Buffer.from(f.wire.signedTransactionHex,'hex').toString('base64'),signature:f.wire.signature}});await edit({submitAttempted:true});
 a.observeFailureKey(request.idempotencyKey);await edit({failureObserved:true});await edit({failure:{wire:f.wire,value:f.failure}});
 const active=await a.archiveFailure(row.revision,{wallet:identity.wallet,idempotencyKey:request.idempotencyKey,failure:f.failure});
 const next={...request,idempotencyKey:'00000000-0000-4000-8000-000000000099'};
 const begin=()=>a.compareAndSet(active.revision,j=>({...j,operation:{request:next,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
 return {a,b,identity,request,next,begin};
}

describe('realm failure history observation races',()=>{
 it('checks another tab durable quarantine in the same transaction as a new original intent',async()=>{
  const x=await archivedFailure();expect((await x.a.read()).operation).toBeNull();expect(x.a.settlementHeld()).toBe(false);
  x.b.observeSettlementKey(x.request.idempotencyKey);expect((await x.b.archived(x.request.idempotencyKey))?.operation?.failure).toBeTruthy();
  // A still has the pre-observation read and cannot see B's memory latch.
  expect(x.a.settlementHeld()).toBe(false);await expect(x.begin()).rejects.toThrow();
  expect((await x.a.read()).operation).toBeNull();expect(x.a.settlementHeld()).toBe(true);
 });
 it('rechecks a late process hold after the asynchronous archived-key lookup',async()=>{
  const x=await archivedFailure(),get=IDBObjectStore.prototype.get,historyKey=JSON.stringify([x.identity,x.next.idempotencyKey]);let injected=false;
  const spy=vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,key){
   const result=get.call(this,key);
   if(key===historyKey)result.addEventListener('success',()=>{injected=true;x.a.observeSettlementKey(x.request.idempotencyKey);},{once:true});
   return result;
  });
  try{await expect(x.begin()).rejects.toThrow();expect(injected).toBe(true);}finally{spy.mockRestore();}
  expect((await x.a.read()).operation).toBeNull();expect(x.a.settlementHeld()).toBe(true);
 });
});
