import {IDBFactory} from 'fake-indexeddb';
import {it,expect,vi} from 'vitest';
import {RealmSaleController,type RealmSalePorts} from './controller';
import {RealmSaleJournalStore} from './journal';
import {realmSaleSettlementFixture} from './settlement.test-support';
async function setup(status=422,code='INSUFFICIENT_SOL'){
 const f=await realmSaleSettlementFixture(),p=f.preparation,identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:p.wallet},factory=new IDBFactory(),store=new RealmSaleJournalStore(identity,factory);
 const response={wallet:p.wallet,idempotencyKey:p.idempotencyKey,preparation:null};
 const ports:RealmSalePorts={getFailure:async key=>({wallet:identity.wallet,idempotencyKey:key,failure:null}),capture:()=>()=>undefined,lock:async(_key,run)=>run(),key:()=>p.idempotencyKey,clock:()=>0,
  prepare:vi.fn(async(_req,_guard,_retain,refusal)=>{await refusal({status,code});throw Error('declined');}),
  getPreparation:vi.fn(async(_req,_guard,retain)=>{await retain(response);return response;}),
  getSaved:vi.fn(async(_key,_guard,retain)=>{const saved={...response,wire:null,settlement:null};await retain(saved);return saved;}),
  currentReview:vi.fn(async()=>{throw Error('not admitted');}),sign:vi.fn(async()=>{throw Error('not signing');}),submit:vi.fn(async()=>{throw Error('not submitting');})};
 return {f,p,identity,factory,store,ports,controller:new RealmSaleController(store,ports)};
}
it.each([[400,'INVALID_INPUT'],[422,'INSUFFICIENT_SOL'],[503,'PHASE_E_DISABLED']])('archives only first prepare refusal %i/%s after both fresh absence checks and preserves its reserved key',async(status,code)=>{
 const f=await setup(status as number,code as string);await f.controller.begin(f.p.spot,f.p.realm);const original=await f.store.read();expect(original.operation?.prepareRefusal).toEqual({status,code});
 await expect(f.store.archive(original.revision)).rejects.toThrow();await f.controller.archiveRefusal();expect((await f.store.read()).operation).toBeNull();
 const archived=await f.store.archived(f.p.idempotencyKey);expect(archived?.operation?.refusalConfirmedAbsent).toBe(true);expect(archived?.operation?.request).toEqual(original.operation?.request);
 expect(f.ports.prepare).toHaveBeenCalledOnce();expect(f.ports.getPreparation).toHaveBeenCalledOnce();expect(f.ports.getSaved).toHaveBeenCalledOnce();expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.submit).not.toHaveBeenCalled();
 await f.controller.begin(f.p.spot,f.p.realm);expect((await f.store.read()).operation).toBeNull();expect(f.ports.prepare).toHaveBeenCalledOnce();
});
it.each(['REALM_SALE_NO_QUOTA','REALM_SALE_UNSOLD','REALM_SALE_REALM_UNAVAILABLE'])('holds %s when original preparation or positive settlement contradicts absence',async code=>{
 for(const kind of ['prepared','positive'] as const){
  const f=await setup(422,code);await f.controller.begin(f.p.spot,f.p.realm);
  expect((await f.store.read()).operation?.prepareRefusal).toEqual({status:422,code});
  if(kind==='prepared')f.ports.getPreparation=vi.fn(async(_request,_guard,retain)=>{const value={wallet:f.p.wallet,idempotencyKey:f.p.idempotencyKey,preparation:f.p};await retain(value);return value;});
  else f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const value={wallet:f.p.wallet,idempotencyKey:f.p.idempotencyKey,preparation:null,wire:null,settlement:{unknown:true}};await retain(value);return value;});
  await f.controller.archiveRefusal();expect((await f.store.read()).operation).not.toBeNull();expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
  expect(f.ports.prepare).toHaveBeenCalledOnce();expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.submit).not.toHaveBeenCalled();
 }
});
it.each([[503,'REALM_SALE_UNAVAILABLE'],[409,'REALM_SALE_REQUEST_CONFLICT'],[429,'RATE_LIMITED'],[401,'INVALID_INPUT'],[503,'INSUFFICIENT_SOL']])('does not release an unknown or mismatched refusal %i/%s',async(status,code)=>{
 const f=await setup(status as number,code as string);await f.controller.begin(f.p.spot,f.p.realm);await f.controller.archiveRefusal();expect((await f.store.read()).operation?.prepareAttempted).toBe(true);expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
});
it('retains declined intent across reopen and refuses unavailable, prepared or positive settlement recovery',async()=>{
 for(const kind of ['unavailable','prepared','positive'] as const){const f=await setup();await f.controller.begin(f.p.spot,f.p.realm);
  if(kind==='unavailable')f.ports.getSaved=vi.fn(async()=>{throw Error('offline');});
  if(kind==='prepared')f.ports.getPreparation=vi.fn(async(_request,_guard,retain)=>{const value={wallet:f.p.wallet,idempotencyKey:f.p.idempotencyKey,preparation:f.p};await retain(value);return value;});
  if(kind==='positive')f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const value={wallet:f.p.wallet,idempotencyKey:f.p.idempotencyKey,preparation:null,wire:null,settlement:{unknown:true}};await retain(value);return value;});
  const reopened=new RealmSaleController(new RealmSaleJournalStore(f.identity,f.factory),f.ports);await reopened.archiveRefusal();expect((await f.store.read()).operation).not.toBeNull();expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
  if(kind==='positive')expect((await f.store.read()).operation?.settlementObserved).toBe(true);
 }
});
it('never converts a timeout into refusal or starts a second preparation',async()=>{
 const f=await setup();f.ports.prepare=vi.fn(async()=>{throw Error('lost reply');});await f.controller.begin(f.p.spot,f.p.realm);await f.controller.archiveRefusal();await f.controller.begin(f.p.spot,f.p.realm);
 expect((await f.store.read()).operation?.prepareRefusal).toBeUndefined();expect(f.ports.prepare).toHaveBeenCalledOnce();expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
});

it('a failed durable positive hold blocks refusal archival and replacement across controllers and remounts',async()=>{
 const f=await setup();await f.controller.begin(f.p.spot,f.p.realm);
 vi.spyOn(f.store,'compareAndSet').mockRejectedValueOnce(Error('storage unavailable'));
 vi.mocked(f.ports.getSaved).mockImplementationOnce(async(_key,_guard,retain)=>{
  const raw={wallet:f.p.wallet,idempotencyKey:f.p.idempotencyKey,preparation:null,wire:null,settlement:{unknown:true}};await retain(raw);return raw;
 });
 await f.controller.check();expect(f.controller.snapshot().settlementHeld).toBe(true);expect((await f.store.read()).operation?.settlementObserved).toBeUndefined();
 const other=new RealmSaleController(new RealmSaleJournalStore(f.identity,f.factory),f.ports);await other.archiveRefusal();
 expect((await f.store.read()).operation?.request.idempotencyKey).toBe(f.p.idempotencyKey);expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
 f.ports.key=()=> 'ffffffff-ffff-4fff-8fff-ffffffffffff';await f.controller.begin(f.p.spot,f.p.realm);
 expect(f.controller.snapshot().settlementHeld).toBe(true);expect(f.ports.prepare).toHaveBeenCalledOnce();
 await f.store.close();const remounted=new RealmSaleController(new RealmSaleJournalStore(f.identity,f.factory),f.ports);await remounted.archiveRefusal();await remounted.begin(f.p.spot,f.p.realm);
 expect(remounted.snapshot().settlementHeld).toBe(true);expect(f.ports.prepare).toHaveBeenCalledOnce();
});
