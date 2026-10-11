import {Buffer} from 'buffer';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {describe,expect,it,vi} from 'vitest';
import {RealmSaleJournalStore,type RealmSaleJournal,type RealmSaleOperation} from './journal';
import {RealmSaleController,type RealmSalePorts} from './controller';
import {realmSaleSettlementFixture} from './settlement.test-support';

async function setup(){
 const f=await realmSaleSettlementFixture(),factory=new IDBFactory(),identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:f.preparation.wallet};
 const store=new RealmSaleJournalStore(identity,factory),request={idempotencyKey:f.preparation.idempotencyKey,spot:f.preparation.spot,realm:f.preparation.realm};
 const draft:RealmSaleOperation={request,prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false};
 let j=await store.compareAndSet(0,row=>({...row,operation:draft}));
 const edit=async(patch:Partial<RealmSaleOperation>)=>{j=await store.compareAndSet(j.revision,row=>({...row,operation:{...row.operation!,...patch}}));return j;};
 await edit({prepareAttempted:true});await edit({preparation:f.preparation});await edit({signingStarted:true});
 await edit({signed:{wire:Buffer.from(f.wire.signedTransactionHex,'hex').toString('base64'),signature:f.wire.signature}});
 return {f,factory,identity,store,draft,edit,current:()=>j};
}
async function settled(f:Awaited<ReturnType<typeof setup>>){await f.edit({settlementObserved:true});return f.edit({settlement:{wire:f.f.wire,value:f.f.settlement}});}
describe('settled realm purchase durable recovery and archival',()=>{
 it('requires the observed, cryptographically bound historical receipt before releasing an active purchase',async()=>{
  const f=await setup();await expect(f.store.archive(f.current().revision)).rejects.toThrow();
  await f.edit({settlementObserved:true});await expect(f.store.compareAndSet(f.current().revision,row=>{delete row.operation!.settlementObserved;return row;})).rejects.toThrow();
  await expect(f.store.archive(f.current().revision)).rejects.toThrow();
  await expect(f.edit({settlement:{wire:f.f.wire,value:{...f.f.settlement,purchase:{...f.f.settlement.purchase,expiresAt:'1'}}}})).rejects.toThrow();
  const original=await settled(f);await expect(f.store.compareAndSet(original.revision,row=>({...row,operation:null}))).rejects.toThrow();
  const next=await f.store.archive(original.revision);expect(next.operation).toBeNull();expect(next.lastArchivedKey).toBe(f.draft.request.idempotencyKey);
  expect(await f.store.archived(f.draft.request.idempotencyKey)).toEqual(original);
 });
 it('retains exact receipt and signed history through reopen and an explicit different-key purchase',async()=>{
  const f=await setup(),original=await settled(f);await f.store.archive(original.revision);await f.store.close();
  const reopened=new RealmSaleJournalStore(f.identity,f.factory);let j=await reopened.read();
  expect(await reopened.archived(f.draft.request.idempotencyKey)).toEqual(original);
  await expect(reopened.compareAndSet(j.revision,row=>({...row,operation:f.draft}))).rejects.toThrow(/reuse|archiv/i);
  j=await reopened.compareAndSet(j.revision,row=>({...row,operation:{...f.draft,request:{...f.draft.request,idempotencyKey:'10000000-0000-4000-8000-000000000001'}}}));
  expect(j.operation?.prepareAttempted).toBe(false);expect(await reopened.archived(f.draft.request.idempotencyKey)).toEqual(original);
  const foreign=new RealmSaleJournalStore({...f.identity,api:'https://other.test/api'},f.factory);expect(await foreign.archived(f.draft.request.idempotencyKey)).toBeNull();
 });
 it('cannot replace a saved settlement or reset its hold and history pointer',async()=>{
  const f=await setup(),j=await settled(f);
  for(const key of ['settlement','settlementObserved'] as const)await expect(f.store.compareAndSet(j.revision,row=>{delete row.operation![key];return row;})).rejects.toThrow();
  await expect(f.edit({settlement:{wire:f.f.wire,value:{...f.f.settlement,settledAt:'2026-09-25T00:01:00.000000Z'}}})).rejects.toThrow();
  const archived=await f.store.archive(j.revision);
  await expect(f.store.compareAndSet(archived.revision,row=>{delete row.lastArchivedKey;return row;})).rejects.toThrow();
 });
 it('allows only one concurrent archival CAS and preserves the exact original evidence',async()=>{
  const f=await setup(),j=await settled(f),other=new RealmSaleJournalStore(f.identity,f.factory);
  const results=await Promise.allSettled([f.store.archive(j.revision),other.archive(j.revision)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await f.store.archived(f.draft.request.idempotencyKey)).toEqual(j);
 });
 it('rejects reuse of an older key after a second archived purchase and preserves the history link',async()=>{
  const f=await setup(),first=await settled(f);let row=await f.store.archive(first.revision);
  // Key identity is server metadata, separate from the signed sale ID. Reuse
  // this synthetic receipt to exercise storage history, not another payment.
  const id='10000000-0000-4000-8000-000000000001',draft={...f.draft,request:{...f.draft.request,idempotencyKey:id}};
  row=await f.store.compareAndSet(row.revision,j=>({...j,operation:draft}));
  const updates:Partial<RealmSaleOperation>[]=[{prepareAttempted:true},{preparation:{...f.f.preparation,idempotencyKey:id}},{signingStarted:true},
   {signed:first.operation!.signed},{settlementObserved:true},{settlement:{wire:{...f.f.wire,idempotencyKey:id},value:{...f.f.settlement,idempotencyKey:id}}}];
  for(const patch of updates)row=await f.store.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,...patch}}));
  const second=row;row=await f.store.archive(row.revision);
  expect((await f.store.archived(id))?.lastArchivedKey).toBe(f.draft.request.idempotencyKey);
  await expect(f.store.compareAndSet(row.revision,j=>({...j,operation:f.draft}))).rejects.toThrow(/reuse/i);
  expect(await f.store.archived(id)).toEqual(second);expect(await f.store.archived(f.draft.request.idempotencyKey)).toEqual(first);
 });
 it('rolls back both history insertion and active release if the durable write fails',async()=>{
  const f=await setup(),j=await settled(f),put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('quota full','QuotaExceededError');});
  await expect(f.store.archive(j.revision)).rejects.toThrow('quota');put.mockRestore();
  expect(await f.store.read()).toEqual(j);expect(await f.store.archived(f.draft.request.idempotencyKey)).toBeNull();
  await f.store.archive(j.revision);expect(await f.store.archived(f.draft.request.idempotencyKey)).toEqual(j);
 });
 it('never verifies the same receipt against a different original signed message on reread',async()=>{
  const f=await setup(),j=await settled(f),reopened=new RealmSaleJournalStore(f.identity,f.factory);expect(await reopened.read()).toEqual(j);
  const altered=structuredClone(j) as RealmSaleJournal;altered.operation!.settlement!.wire.wireSha256='00'.repeat(32);
  await expect(reopened.compareAndSet(j.revision,()=>altered)).rejects.toThrow();expect(await f.store.read()).toEqual(j);
 });
 it('preserves verified late HTTP evidence before rejecting a changed view and recovers without another request',async()=>{
  const f=await setup();let active=true;
  const response={wallet:f.identity.wallet,idempotencyKey:f.draft.request.idempotencyKey,preparation:f.f.preparation,wire:f.f.wire,settlement:f.f.settlement};
  const unavailable=vi.fn(async()=>{throw Error('no new actions');});
  const ports:RealmSalePorts={getFailure:async key=>({wallet:f.identity.wallet,idempotencyKey:key,failure:null}),capture:()=>()=>{if(!active)throw Error('obsolete view');},lock:async(_key,run)=>run(),key:()=>crypto.randomUUID(),clock:()=>0,
   prepare:unavailable,currentReview:unavailable,sign:unavailable,submit:unavailable,
   getPreparation:async()=>({wallet:f.identity.wallet,idempotencyKey:f.draft.request.idempotencyKey,preparation:f.f.preparation}),
   getSaved:async(_key,guard,retain)=>{active=false;await retain(response);guard();return response;}};
  const c=new RealmSaleController(f.store,ports);await c.open();expect((await f.store.read()).operation?.settlement?.value).toEqual(f.f.settlement);
  active=true;ports.getPreparation=unavailable;ports.getSaved=unavailable;const reopened=new RealmSaleController(new RealmSaleJournalStore(f.identity,f.factory),ports);
  await reopened.open();expect(reopened.snapshot().error).toBeNull();expect(reopened.snapshot().journal?.operation?.settlement?.value).toEqual(f.f.settlement);
  expect(unavailable).not.toHaveBeenCalled();
 });
 it('releases a stale tab hold only after checking the original durable archive created by another tab',async()=>{
  const f=await setup(),j=await settled(f),unavailable=vi.fn(async()=>{throw Error('no server');});
  const ports:RealmSalePorts={getFailure:async key=>({wallet:f.identity.wallet,idempotencyKey:key,failure:null}),capture:()=>()=>undefined,lock:async(_key,run)=>run(),key:()=> '10000000-0000-4000-8000-000000000001',clock:()=>0,
   prepare:unavailable,getPreparation:unavailable,getSaved:unavailable,currentReview:unavailable,sign:unavailable,submit:unavailable};
  const stale=new RealmSaleController(f.store,ports);await stale.open();expect(stale.snapshot().settlementHeld).toBe(true);
  const other=new RealmSaleController(new RealmSaleJournalStore(f.identity,f.factory),ports);await other.open();await other.archive();
  await stale.open();expect(stale.snapshot().settlementHeld).toBe(false);expect(await f.store.archived(f.draft.request.idempotencyKey)).toEqual(j);
  await stale.begin(f.draft.request.spot,f.draft.request.realm);expect((await f.store.read()).operation?.request.idempotencyKey).toBe(ports.key());
  expect(unavailable).toHaveBeenCalledOnce();
 });
});
