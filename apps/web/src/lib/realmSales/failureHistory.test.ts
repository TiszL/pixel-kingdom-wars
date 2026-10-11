import {Buffer} from 'buffer';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {describe,it,expect,vi} from 'vitest';
import {RealmSaleJournalStore,type RealmSaleOperation} from './journal';
import {realmSaleBrowserFailureFixture} from './failure.test-support';
async function setup(){
 const f=await realmSaleBrowserFailureFixture(),factory=new IDBFactory(),identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:f.preparation.wallet};
 const store=new RealmSaleJournalStore(identity,factory,'realm-failure-history',f.trust),request={idempotencyKey:f.preparation.idempotencyKey,spot:f.preparation.spot,realm:f.preparation.realm};
 let row=await store.compareAndSet(0,j=>({...j,operation:{request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
 const edit=async(patch:Partial<RealmSaleOperation>)=>{row=await store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,...patch}}));return row;};
 await edit({prepareAttempted:true});await edit({preparation:f.preparation});await edit({signingStarted:true});await edit({signed:{wire:Buffer.from(f.wire.signedTransactionHex,'hex').toString('base64'),signature:f.wire.signature}});await edit({submitAttempted:true});
 const retain=async()=>{store.observeFailureKey(request.idempotencyKey);await edit({failureObserved:true});return edit({failure:{wire:f.wire,value:f.failure}});};
 return {f,factory,identity,store,request,edit,retain,reopen:()=>new RealmSaleJournalStore(identity,factory,'realm-failure-history',f.trust)};
}
const fresh=(x:Awaited<ReturnType<typeof setup>>)=>({wallet:x.identity.wallet,idempotencyKey:x.request.idempotencyKey,failure:x.f.failure});
async function cold(x:Awaited<ReturnType<typeof setup>>){
 const open=(factory:IDBFactory)=>new Promise<IDBDatabase>((resolve,reject)=>{const q=factory.open('realm-failure-history',1);q.onupgradeneeded=()=>q.result.createObjectStore('commands');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 const old=await open(x.factory),entries=await new Promise<[IDBValidKey,unknown][]>((resolve,reject)=>{const tx=old.transaction('commands'),q=tx.objectStore('commands').openCursor(),rows:[IDBValidKey,unknown][]=[];q.onsuccess=()=>{const c=q.result;if(c){rows.push([c.key,c.value]);c.continue();}};tx.oncomplete=()=>resolve(rows);tx.onerror=()=>reject(tx.error);});old.close();
 const factory=new IDBFactory(),db=await open(factory);await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite');for(const [key,row]of entries)tx.objectStore('commands').put(row,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();return new RealmSaleJournalStore(x.identity,factory,'realm-failure-history',x.f.trust);
}
describe('durable failed realm purchase history',()=>{
 it('keeps bound failure and exact consent/wire after close and reopen, then atomically keeps history',async()=>{
  const x=await setup(),row=await x.retain();await x.store.close();const reopened=x.reopen();expect(await reopened.read()).toEqual(row);expect(reopened.settlementHeld()).toBe(true);
  const next=await reopened.archiveFailure(row.revision,fresh(x));expect(next.operation).toBeNull();expect(next.lastArchivedKey).toBe(x.request.idempotencyKey);expect(await reopened.archived(x.request.idempotencyKey)).toEqual(row);expect(reopened.settlementHeld()).toBe(false);
 });
 it('requires durable observed failure and the original signed purchase before proof',async()=>{
  const x=await setup();await expect(x.edit({failure:{wire:x.f.wire,value:x.f.failure}})).rejects.toThrow();await x.retain();const row=await x.store.read();
  await expect(x.store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,signed:null}}))).rejects.toThrow();
 });
 it('never clears an unparsed failure and never loses its hold after another response or remount',async()=>{
  const x=await setup();x.store.observeFailureKey(x.request.idempotencyKey);const row=await x.edit({failureObserved:true});await expect(x.store.archiveFailure(row.revision,fresh(x))).rejects.toThrow();
  const next=x.reopen();expect((await next.read()).operation?.failureObserved).toBe(true);expect(next.settlementHeld()).toBe(true);await expect(x.store.compareAndSet(row.revision,j=>{delete j.operation!.failureObserved;return j;})).rejects.toThrow();
 });
 it('does not let failed storage erase a positive failure across store instances',async()=>{
  const x=await setup();x.store.observeFailureKey(x.request.idempotencyKey);const put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw Error('disk full');});
  await expect(x.edit({failureObserved:true})).rejects.toThrow();put.mockRestore();const next=x.reopen();expect(next.settlementHeld()).toBe(true);const row=await next.read();await expect(next.archiveFailure(row.revision,fresh(x))).rejects.toThrow();
 });
 it('preserves immutable failure, rejects forged evidence and independently changed trust on cold read',async()=>{
  const x=await setup();await x.edit({failureObserved:true});const forged=structuredClone(x.f.failure);forged.receipt.signature='1'.repeat(64);await expect(x.edit({failure:{wire:x.f.wire,value:forged}})).rejects.toThrow();await x.retain();
  await expect(x.store.compareAndSet((await x.store.read()).revision,j=>{delete j.operation!.failure;return j;})).rejects.toThrow();const changed=structuredClone(x.f.failure);changed.verifiedAt='2026-09-27T01:00:00Z';await expect(x.edit({failure:{wire:x.f.wire,value:changed}})).rejects.toThrow();
  const noTrust=new RealmSaleJournalStore(x.identity,x.factory,'realm-failure-history');await expect(noTrust.read()).rejects.toThrow();
  const wrongTrust=new RealmSaleJournalStore(x.identity,x.factory,'realm-failure-history',{...x.f.trust,revision:'other'});await expect(wrongTrust.read()).rejects.toThrow();
 });
 it('refuses both success/failure outcomes and retains contradictory observation instead of archiving',async()=>{
  const x=await setup();await x.retain();await x.edit({settlementObserved:true});const row=await x.store.read();await expect(x.store.archiveFailure(row.revision,fresh(x))).rejects.toThrow();
 });
 it('a positive success observation arriving after failed proof parsing blocks atomic archival',async()=>{
  const x=await setup(),row=await x.retain(),digest=crypto.subtle.digest.bind(crypto.subtle);let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{entered();await blocked;return digest(...args);});const pending=x.store.archiveFailure(row.revision,fresh(x));await started;x.store.observeSettlementKey(x.request.idempotencyKey);release();await expect(pending).rejects.toThrow();spy.mockRestore();expect((await x.store.read()).operation?.failure).toBeTruthy();
 });
 it('transaction failure keeps the active original and leaves no partial failed archive',async()=>{
  const x=await setup(),row=await x.retain();const add=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementationOnce(()=>{throw Error('quota full');});await expect(x.store.archiveFailure(row.revision,fresh(x))).rejects.toThrow();add.mockRestore();expect(await x.store.read()).toEqual(row);expect(await x.store.archived(x.request.idempotencyKey)).toBeNull();
 });
 it('rejects stale archival revision and prevents reuse of every archived failed key',async()=>{
  const x=await setup(),row=await x.retain();await x.store.compareAndSet(row.revision,j=>j);await expect(x.store.archiveFailure(row.revision,fresh(x))).rejects.toThrow();const live=await x.store.read(),next=await x.store.archiveFailure(live.revision,fresh(x));
  await expect(x.store.compareAndSet(next.revision,j=>({...j,operation:{request:x.request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}))).rejects.toThrow();
 });
 it('copies independent trust at construction before external code can replace historical pins',async()=>{
  const x=await setup();x.f.trust.programId=x.f.preparation.wallet;await x.retain();expect((await x.store.read()).operation?.failure).toBeTruthy();
 });
 it('requires a fresh matching non-null failure response instead of the generic success archive',async()=>{
  const x=await setup(),row=await x.retain();await expect(x.store.archive(row.revision)).rejects.toThrow();
  for(const raw of [{...fresh(x),failure:null},{...fresh(x),idempotencyKey:'00000000-0000-4000-8000-000000000099'},{...fresh(x),failure:{...x.f.failure,verifiedAt:'2026-09-27T00:00:00Z'}}])await expect(x.store.archiveFailure(row.revision,raw)).rejects.toThrow();expect(await x.store.read()).toEqual(row);
 });
 it('keeps failure holds in a cold process with no shared in-memory latch',async()=>{
  const x=await setup();await x.retain();const next=await cold(x);expect((await next.read()).operation?.failure).toBeTruthy();expect(next.settlementHeld()).toBe(true);
 });
 it('durably quarantines a contradiction arriving after archival writes were queued',async()=>{
  const x=await setup(),row=await x.retain(),put=IDBObjectStore.prototype.put;let injected=false;
  const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){const result=put.call(this,value,key);if(!injected&&key===x.store.key&&value.operation===null){injected=true;x.store.observeSettlementKey(x.request.idempotencyKey);}return result;});
  await x.store.archiveFailure(row.revision,fresh(x));spy.mockRestore();expect(injected).toBe(true);expect(x.store.settlementHeld()).toBe(true);const next=await cold(x);await next.read();expect(next.settlementHeld()).toBe(true);expect((await next.archived(x.request.idempotencyKey))?.operation?.failure).toBeTruthy();
 });
 it('retains a later historical contradiction through cold restart without rewriting the receipt',async()=>{
  const x=await setup(),row=await x.retain();await x.store.archiveFailure(row.revision,fresh(x));x.store.observeSettlementKey(x.request.idempotencyKey);await x.store.read();const next=await cold(x);await next.read();expect(next.settlementHeld()).toBe(true);expect(await next.archived(x.request.idempotencyKey)).toEqual(row);
 });

});
