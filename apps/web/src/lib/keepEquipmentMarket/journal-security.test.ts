import {webcrypto} from 'node:crypto';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {KeepEquipmentPurchaseSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P} from '@shardkeep/shared';
import {KeepMarketJournalStore,marketKey,type KeepMarketJournal} from './journal';
import {prepareKeepEquipmentSigning,signKeepEquipment,verifyKeepEquipmentReceipt} from './signing';
import {keepMarketFixture} from './fixtures.testHelpers';

const opened=new Set<KeepMarketJournalStore>();
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
afterEach(async()=>{vi.restoreAllMocks();await Promise.all([...opened].map(s=>s.close().catch(()=>undefined)));opened.clear();vi.unstubAllGlobals();});
function track(store:KeepMarketJournalStore){opened.add(store);return store;}
async function fixture(){
 const f=keepMarketFixture(),factory=new IDBFactory(),identity={origin:'http://localhost',api:'http://localhost/api',cluster:'devnet' as const,wallet:f.value.fill.buyerWallet};
 const store=track(new KeepMarketJournalStore(identity,factory)),command={kind:'fill' as const,key:f.value.fill.id,request:{idempotencyKey:f.value.fill.id,listingId:f.value.fill.listingId,buyerBaseId:f.value.fill.buyerBaseId,quantity:f.value.fill.quantity}},key=marketKey(command);
 await store.begin(command);await store.retain(key,f.value);
 const prepared=await prepareKeepEquipmentSigning(f.value,f.trust,identity.wallet),wire=await signKeepEquipment(prepared,f.signer);
 const keys=f.unsigned().message.staticAccountKeys.map(k=>k.toBase58()),p=f.value.preparation!;
 const delivery=KeepEquipmentPurchaseSchema.parse({...f.value,status:'delivered',wire:{...wire,recordedAt:p.recordedAt},delivery:{fillId:f.value.fill.id,buyerBaseId:f.value.fill.buyerBaseId,itemId:f.value.fill.itemId,quantity:f.value.fill.quantity,deliveredAt:p.recordedAt,proof:{
  version:1,signature:wire.signature,reservationId:f.value.fill.id,buyer:f.value.fill.buyerWallet,seller:f.value.fill.sellerWallet,keepMint:p.expectedKeepMint,buyerAta:f.built.buyerAta,sellerAta:f.built.sellerAta,totalBaseUnits:'1000001',sellerBaseUnits:'900000',burnBaseUnits:'100001',slot:200,feeLamports:'5000',createsSellerAta:false,sellerAtaCreated:false,sellerAtaRentCapLamports:'0',sellerAtaRentLamports:'0',
  innerInstructionsSha256:'a'.repeat(64),messageSha256:p.messageSha256,resolvedKeys:keys,tokenBefore:['10000000','0'],tokenAfter:['8999999','900000'],lamportsBefore:keys.map(()=>10000000),lamportsAfter:keys.map((_,i)=>i===0?9995000:10000000),evidenceSha256:'b'.repeat(64),fenceReleaseAuthorized:false,unpaidProven:false,expectedGenesisHash:p.expectedGenesisHash,providerIds:p.providerIds,finalizedAgreement:true,
 }}});
 await verifyKeepEquipmentReceipt(delivery);
 return {...f,factory,identity,store,command,key,wire,delivery,reopen:()=>track(new KeepMarketJournalStore(identity,factory))};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function rewrite(f:Fixture,mutate:(row:KeepMarketJournal)=>void){
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const q=f.factory.open('pkw-keep-equipment-v1',1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite'),store=tx.objectStore('commands'),q=store.get(f.store.key);q.onsuccess=()=>{const row=q.result as KeepMarketJournal;mutate(row);store.put(row,f.store.key);};tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}

it('a signing marker is a one-shot claim, including after a restart or a stale other tab',async()=>{
 const f=await fixture(),other=f.reopen();await other.read();await f.store.startSigning(f.key);
 await expect(other.startSigning(f.key)).rejects.toThrow();
 await f.store.close();await expect(f.reopen().startSigning(f.key)).rejects.toThrow();
 expect((await other.read()).pending[0]!.signingStarted).toBe(true);
});

it('rejects a wallet handoff if the signing transaction aborts after put instead of resolving on request success',async()=>{
 const f=await fixture(),put=IDBObjectStore.prototype.put,handoff=vi.fn();
 const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){const request=put.apply(this,args);this.transaction.abort();return request;});
 expect(await f.store.startSigning(f.key).then(handoff).then(()=>false,()=>true)).toBe(true);expect(handoff).not.toHaveBeenCalled();spy.mockRestore();
 expect((await f.store.read()).pending[0]!.signingStarted).toBe(false);
});

it('a failed exact-wire save leaves the pre-wallet marker durable and cannot yield transport permission',async()=>{
 const f=await fixture();await f.store.startSigning(f.key);const transport=vi.fn();
 const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw Error('disk full');});
 await expect(f.store.retainSigned(f.key,f.wire).then(transport)).rejects.toThrow('disk full');expect(transport).not.toHaveBeenCalled();spy.mockRestore();
 const saved=(await f.reopen().read()).pending[0]!;expect(saved.signingStarted).toBe(true);expect(saved.wire).toBeNull();
 await expect(f.store.archive(f.key)).rejects.toThrow();
});

it('competing signed-save and server advancement cannot overwrite each other or erase an exact retained signature',async()=>{
 const f=await fixture(),other=f.reopen();await f.store.startSigning(f.key);
 const server={...f.value,status:'signed' as const,wire:{...f.wire,recordedAt:f.value.preparation!.recordedAt}};
 const outcomes=await Promise.allSettled([f.store.retainSigned(f.key,f.wire),other.retain(f.key,server)]);
 expect(outcomes.some(result=>result.status==='fulfilled')).toBe(true);
 const op=(await f.store.read()).pending[0]!;
 expect(op.signingStarted).toBe(true);expect(op.wire?.signature??KeepEquipmentPurchaseSchema.parse(op.original).wire?.signature).toBe(f.wire.signature);
 await f.store.retainSigned(f.key,f.wire);await f.store.retain(f.key,server);
 expect((await f.store.read()).pending[0]!.wire).toEqual(f.wire);
});

it.each(['before CAS','after put'] as const)('a late terminal observation %s prevents wallet handoff even when its own durable save fails',async when=>{
 const f=await fixture(),observer=f.reopen(),before=await f.store.read();vi.spyOn(observer,'read').mockResolvedValue(before);
 const get=IDBObjectStore.prototype.get,put=IDBObjectStore.prototype.put;let triggered=false,observed:Promise<unknown>|undefined;
 vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['get']>){
  const result=get.apply(this,args);
  if(when==='before CAS'&&this.transaction.mode==='readwrite'&&!triggered){triggered=true;observed=observer.retain(f.key,f.delivery);void observed.catch(()=>undefined);}
  return result;
 });
 vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
  const row=args[0] as KeepMarketJournal;if(row.pending?.some(op=>op.observedComplete))throw Error('terminal disk full');
  const result=put.apply(this,args);
  if(when==='after put'&&row.pending?.some(op=>op.signingStarted)&&!triggered){triggered=true;observed=observer.retain(f.key,f.delivery);void observed.catch(()=>undefined);}
  return result;
 });
 const handoff=vi.fn();await expect(f.store.startSigning(f.key).then(handoff)).rejects.toThrow();expect(handoff).not.toHaveBeenCalled();
 expect(triggered).toBe(true);await expect(observed).rejects.toThrow();vi.restoreAllMocks();
 await expect(f.reopen().startSigning(f.key)).rejects.toThrow();
});

it('a terminal held in memory cannot be forgotten by remount after an observed-completion write failure',async()=>{
 const f=await fixture();const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw Error('disk full');});
 await expect(f.store.retain(f.key,f.delivery)).rejects.toThrow('disk full');spy.mockRestore();
 const reopened=f.reopen();await expect(reopened.startSigning(f.key)).rejects.toThrow();await expect(reopened.archive(f.key)).rejects.toThrow();
 await reopened.retain(f.key,f.delivery);await reopened.archive(f.key);
 const archive=(await reopened.read()).archive;expect(archive).toHaveLength(1);expect(archive[0]!.observedComplete).toBe(true);
});

it('late prepared receipts cannot regress a signed or delivered original and archived IDs never restart',async()=>{
 const f=await fixture();await f.store.startSigning(f.key);await f.store.retainSigned(f.key,f.wire);await f.store.retain(f.key,f.delivery);
 await expect(f.store.retain(f.key,f.value)).rejects.toThrow();await f.store.archive(f.key);await f.store.begin(f.command);
 const saved=await f.reopen().read();expect(saved.pending).toEqual([]);expect(saved.archive).toHaveLength(1);expect(saved.archive[0]!.wire).toEqual(f.wire);
 await expect(f.store.startSigning(f.key)).rejects.toThrow();
});

it.each(['signature','wire hash','wire bytes'] as const)('checks genuine signatures again on restart after stored %s corruption',async kind=>{
 const f=await fixture();await f.store.startSigning(f.key);await f.store.retainSigned(f.key,f.wire);
 await rewrite(f,row=>{const wire=row.pending[0]!.wire!;if(kind==='signature')wire.signature='1'.repeat(64);if(kind==='wire hash')wire.wireSha256='0'.repeat(64);if(kind==='wire bytes')wire.signedTransactionHex=wire.signedTransactionHex.slice(0,-2)+'ff';});
 await expect(f.reopen().read()).rejects.toThrow();
});

it.each(['origin','api','cluster','wallet'] as const)('isolates %s scopes and rejects a copied journal under another identity',async field=>{
 const f=await fixture(),other={...f.identity,...field==='origin'?{origin:'https://elsewhere.example'}:field==='api'?{api:'http://localhost/other-api'}:field==='cluster'?{cluster:'mainnet-beta' as const}:{wallet:f.value.fill.sellerWallet}};
 const store=track(new KeepMarketJournalStore(other,f.factory));expect((await store.read()).pending).toEqual([]);
 await rewrite(f,row=>{row.identity=other;});await expect(f.store.read()).rejects.toThrow();
});

it('caller mutations cannot alter saved requests, receipts or signed bytes after save returns',async()=>{
 const f=await fixture();await f.store.startSigning(f.key);await f.store.retainSigned(f.key,f.wire);
 const before=await f.store.read();f.command.request.quantity='999';f.value.preparation!.messageHex='00';f.wire.signedTransactionHex='00';
 const returned=await f.store.read();returned.pending[0]!.command.request=null;returned.pending[0]!.wire!.signature='1'.repeat(64);
 expect(await f.reopen().read()).toEqual(before);
});

it('a full pending journal refuses new commands and never evicts unresolved signed originals',async()=>{
 const f=await fixture();await f.store.startSigning(f.key);await f.store.retainSigned(f.key,f.wire);
 for(let i=1;i<P.localPendingLimit;i++){const id=crypto.randomUUID();await f.store.begin({kind:'fill',key:id,request:null});}
 const before=await f.store.read();await expect(f.store.begin({kind:'fill',key:crypto.randomUUID(),request:null})).rejects.toThrow('full');
 expect(await f.reopen().read()).toEqual(before);expect(before.pending[0]!.wire).toEqual(f.wire);
});
