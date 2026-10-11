import {Buffer} from 'buffer';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {it,expect,vi} from 'vitest';
import {MiningTaxClaimContinuationEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import {MiningTaxClaimRecoveryEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import data from '../../../../../packages/shared/src/testFixtures/miningTaxClaimContinuationApi.json';
import {MiningTaxClaimJournalStore,type MiningTaxClaimOperation} from './journal';
import {MiningTaxClaimController,type MiningTaxClaimPorts} from './controller';
function fixture(){
 const envelope=MiningTaxClaimContinuationEnvelopeSchema.parse(structuredClone(data)),link=envelope.continuation!,p=link.parentPreparation,w=link.parentWire;
 const identity={origin:'https://game.test',api:'https://api.test',cluster:'devnet' as const,wallet:p.wallet},trust={genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,keepMint:p.identity.keepMint,reserveOwner:p.identity.reserveOwner,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256};
 const setup=MiningTaxClaimRecoveryEnvelopeSchema.parse({wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,status:'setup',preparation:p,wires:[w],settlement:link.parentSetup,serverNow:p.preparedAt});
 const signed={ordinal:0,wire:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256};
 const request={idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:p.caps},child={idempotencyKey:link.childPreparation.idempotencyKey,caps:link.childPreparation.caps},db=new IDBFactory(),store=new MiningTaxClaimJournalStore(identity,trust,db);
 const patch=async(change:Partial<MiningTaxClaimOperation>)=>{const r=await store.read();return store.compareAndSet(r.revision,s=>({...s,operation:{...s.operation!,...change}}));};
 const seed=async()=>{await store.compareAndSet(0,s=>({...s,operation:{request,prepareAttempted:false,preparation:null,transactions:[],observed:[],unattributedObserved:false,setup:null,settlement:null}}));await patch({prepareAttempted:true});await patch({preparation:p});await patch({transactions:[{ordinal:0,signingStarted:true,signed:null,submitAttempted:false}]});await patch({transactions:[{ordinal:0,signingStarted:true,signed,submitAttempted:false}]});await patch({transactions:[{ordinal:0,signingStarted:true,signed,submitAttempted:true}]});await store.observeSettlement((await store.read()).revision,p.idempotencyKey,0);await patch({setup});};
 let continued=false,epoch=0;
 const ports:MiningTaxClaimPorts={capture:()=>{const e=epoch;return()=>{if(e!==epoch)throw Error('account changed');};},lock:async(_name,run)=>run(),key:()=>child.idempotencyKey,clock:()=>0,prepare:vi.fn(),getPreparation:vi.fn(),currentReview:vi.fn(),sign:vi.fn(),submit:vi.fn(),getSaved:vi.fn(async()=>setup),getFailures:vi.fn(async()=>({recovery:setup,failures:[]})),
  prepareContinuation:vi.fn(async(parent,request,_guard,retain)=>{expect(parent).toBe(p.idempotencyKey);expect(request).toEqual(child);expect((await store.read()).operation!.continuation).toMatchObject({request:child,attempted:true});continued=true;await retain(envelope);return envelope;}),
  getContinuation:vi.fn(async()=>continued?envelope:{wallet:p.wallet,parentIdempotencyKey:p.idempotencyKey,status:'unknown',continuation:null,serverNow:p.preparedAt}),
 };
 const controller=new MiningTaxClaimController(store,ports,trust);
 return {envelope,p,setup,signed,request,child,identity,trust,db,store,ports,controller,seed,patch,retire:()=>epoch++,continued:()=>{continued=true;}};
}
it('persists fresh consent before one POST then explicitly adopts its child after fresh parent/link GETs',async()=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.prepareContinuation(f.child.caps);expect(f.controller.snapshot().error).toBeNull();const row=await f.store.read();expect(row.operation!.request).toEqual(f.request);expect(row.operation!.continuation!.envelope).toEqual(f.envelope);expect(f.ports.sign).not.toHaveBeenCalled();
 const reads=vi.mocked(f.ports.getSaved).mock.calls.length,links=vi.mocked(f.ports.getContinuation).mock.calls.length;await f.controller.activateContinuation();expect(f.controller.snapshot().error).toBeNull();const active=(await f.store.read()).operation!;expect(active.request).toEqual({...f.child,round:f.p.round,spot:f.p.spot});expect(active.preparation).toEqual(f.envelope.continuation!.childPreparation);expect(active.transactions).toEqual([]);expect(active.setup).toBeNull();expect(f.ports.getSaved).toHaveBeenCalledTimes(reads+1);expect(f.ports.getContinuation).toHaveBeenCalledTimes(links+1);
 const history=(await f.store.archived(f.p.idempotencyKey))!.operation!;expect(history.setup).toEqual(f.setup);expect(history.continuation!.envelope).toEqual(f.envelope);expect(history.settlement).toBeNull();expect(history.failure).toBeUndefined();expect(f.ports.prepareContinuation).toHaveBeenCalledOnce();expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.submit).not.toHaveBeenCalled();
},20000);
it.each(['lost reply','unknown'] as const)('recovers %s continuation by GET only and never reopens old signing',async mode=>{
 const f=fixture();await f.seed();const post=f.ports.prepareContinuation;f.ports.prepareContinuation=vi.fn(async(parent,request,guard,retain)=>{if(mode==='lost reply')await post(parent,request,guard,retain);throw Error('reply lost');});await f.controller.prepareContinuation(f.child.caps);await f.controller.prepareContinuation(f.child.caps);expect(f.ports.prepareContinuation).toHaveBeenCalledOnce();await f.controller.review(1);expect(f.ports.currentReview).not.toHaveBeenCalled();
 const reopened=new MiningTaxClaimController(new MiningTaxClaimJournalStore(f.identity,f.trust,f.db),f.ports,f.trust);await reopened.open();expect(f.ports.prepareContinuation).toHaveBeenCalledOnce();expect((await f.store.read()).operation!.continuation!.attempted).toBe(true);if(mode==='unknown'){await reopened.activateContinuation();expect((await f.store.read()).operation!.request).toEqual(f.request);}
},20000);
it.each(['started','failure','unknown','other key'] as const)('refuses continuation after %s evidence without POST',async mode=>{
 const f=fixture();await f.seed();if(mode==='started')await f.patch({transactions:[{ordinal:0,signingStarted:true,signed:f.signed,submitAttempted:true},{ordinal:1,signingStarted:true,signed:null,submitAttempted:false}]});if(mode==='failure')f.store.observeFailureKey(f.p.idempotencyKey);if(mode==='unknown')f.store.observeSettlementKey(f.p.idempotencyKey);if(mode==='other key')f.store.observeSettlementKey('ffffffff-ffff-4fff-8fff-ffffffffffff');await f.controller.prepareContinuation(f.child.caps);expect(f.ports.prepareContinuation).not.toHaveBeenCalled();
});
it.each(['changed link','unknown link','revision','session','late ordinal'] as const)('holds the predecessor when activation sees %s',async mode=>{
 const f=fixture();await f.seed();await f.controller.prepareContinuation(f.child.caps);f.ports.getContinuation=vi.fn(async()=>{const value=structuredClone(f.envelope);if(mode==='changed link')value.continuation!.childPreparation.source.snapshotSha256='ab'.repeat(32);if(mode==='unknown link'){value.status='unknown';value.continuation=null;}if(mode==='revision')await f.patch({observed:[0]});if(mode==='session')f.retire();if(mode==='late ordinal')f.store.observeSettlementKey(f.p.idempotencyKey,1);return value;});await f.controller.activateContinuation();expect((await f.store.read()).operation!.request).toEqual(f.request);expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
},20000);
it('atomically rolls back child adoption if predecessor archival cannot save',async()=>{
 const f=fixture();await f.seed();await f.controller.prepareContinuation(f.child.caps);const before=await f.store.read(),spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementationOnce(()=>{throw Error('storage full');});try{await f.controller.activateContinuation();}finally{spy.mockRestore();}expect(await f.store.read()).toEqual(before);expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
},20000);
it.each(['same','other'] as const)('rechecks %s-key evidence at the actual continuation POST boundary',async mode=>{
 const f=fixture();await f.seed();const post=f.ports.prepareContinuation,send=vi.fn(post);f.ports.prepareContinuation=vi.fn(async(parent,request,guard,retain)=>{f.store.observeSettlementKey(mode==='same'?f.p.idempotencyKey:'ffffffff-ffff-4fff-8fff-ffffffffffff');guard();return send(parent,request,guard,retain);});await f.controller.prepareContinuation(f.child.caps);expect(send).not.toHaveBeenCalled();expect((await f.store.read()).operation!.continuation!.attempted).toBe(true);
});
it.each(['same','other'] as const)('rechecks %s-key evidence after the child archive lookup before adoption writes',async mode=>{
 const f=fixture();await f.seed();await f.controller.prepareContinuation(f.child.caps);const get=IDBObjectStore.prototype.get;let injected=false;
 const spy=vi.spyOn(IDBObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,key:IDBValidKey|IDBKeyRange){const result=get.call(this,key);if(!injected&&key===JSON.stringify([f.identity,f.child.idempotencyKey])){injected=true;f.store.observeSettlementKey(mode==='same'?f.p.idempotencyKey:'ffffffff-ffff-4fff-8fff-ffffffffffff');}return result;});
 try{await f.controller.activateContinuation();}finally{spy.mockRestore();}expect(injected).toBe(true);expect((await f.store.read()).operation!.request).toEqual(f.request);expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
},20000);
it('owns explicit additional caps before suspended recovery can mutate the input',async()=>{
 const f=fixture();await f.seed();let release!:()=>void;const wait=new Promise<void>(r=>{release=r;}),caps={...f.child.caps};f.ports.getSaved=vi.fn(async()=>{await wait;return f.setup;});const work=f.controller.prepareContinuation(caps);await vi.waitFor(()=>expect(f.ports.getSaved).toHaveBeenCalled());caps.maxFeeLamports='9';release();await work;expect(f.controller.snapshot().error).toBeNull();expect((await f.store.read()).operation!.continuation!.request).toEqual(f.child);
},20000);
it('reserves historical child keys before any continuation POST',async()=>{
 const f=fixture();await f.seed();const db=await new Promise<IDBDatabase>((resolve,reject)=>{const q=f.db.open('pkw-mining-tax-v1',1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite');tx.objectStore('commands').put({history:'reserved'},JSON.stringify([f.identity,f.child.idempotencyKey]));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();await f.controller.prepareContinuation(f.child.caps);expect(f.ports.prepareContinuation).not.toHaveBeenCalled();
});
it('explicitly resumes only the same unsigned preparation after fresh GETs; reopening itself never POSTs',async()=>{
 const f=fixture();await f.seed();const post=f.ports.prepareContinuation;f.ports.prepareContinuation=vi.fn(async()=>{throw Error('NOT_EXPIRED');});await f.controller.prepareContinuation(f.child.caps);await f.controller.open();expect(f.ports.prepareContinuation).toHaveBeenCalledOnce();f.ports.prepareContinuation=vi.fn(post);await f.controller.resumeContinuation();expect(f.controller.snapshot().error).toBeNull();expect(f.ports.prepareContinuation).toHaveBeenCalledExactlyOnceWith(f.p.idempotencyKey,f.child,expect.any(Function),expect.any(Function));expect((await f.store.read()).operation!.continuation!.envelope).toEqual(f.envelope);expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.submit).not.toHaveBeenCalled();
},20000);
it('recovers an existing link instead of repeating its saved preparation POST',async()=>{
 const f=fixture();await f.seed();const post=f.ports.prepareContinuation;f.ports.prepareContinuation=vi.fn(async()=>{f.continued();throw Error('lost committed reply');});await f.controller.prepareContinuation(f.child.caps);f.ports.prepareContinuation=vi.fn(post);await f.controller.resumeContinuation();expect(f.ports.prepareContinuation).not.toHaveBeenCalled();expect((await f.store.read()).operation!.continuation!.envelope).toEqual(f.envelope);
},20000);
it.each(['revision','failure','claim custody','other key'] as const)('refuses saved preparation resume after fresh %s change',async mode=>{
 const f=fixture();await f.seed();f.ports.prepareContinuation=vi.fn(async()=>{throw Error('offline');});await f.controller.prepareContinuation(f.child.caps);f.ports.getContinuation=vi.fn(async()=>{if(mode==='revision')await f.patch({observed:[0]});if(mode==='failure')f.store.observeFailureKey(f.p.idempotencyKey);if(mode==='claim custody')f.store.observeSettlementKey(f.p.idempotencyKey,1);if(mode==='other key')f.store.observeSettlementKey('ffffffff-ffff-4fff-8fff-ffffffffffff');return {wallet:f.p.wallet,parentIdempotencyKey:f.p.idempotencyKey,status:'unknown',continuation:null,serverNow:f.p.preparedAt};});await f.controller.resumeContinuation();expect(f.ports.prepareContinuation).toHaveBeenCalledOnce();expect((await f.store.read()).operation!.request).toEqual(f.request);
},20000);
it('rechecks late positive evidence inside the resumed POST guard after durable revision advance',async()=>{
 const f=fixture();await f.seed();f.ports.prepareContinuation=vi.fn(async()=>{throw Error('offline');});await f.controller.prepareContinuation(f.child.caps);const send=vi.fn();f.ports.prepareContinuation=vi.fn(async(_parent,_request,guard)=>{f.store.observeSettlementKey(f.p.idempotencyKey,1);guard();send();return f.envelope;});await f.controller.resumeContinuation();expect(send).not.toHaveBeenCalled();expect((await f.store.read()).operation!.continuation!.envelope).toBeNull();
},20000);

it('explicitly resumes intent-only consent after restart before the attempt marker was saved',async()=>{
 const f=fixture();await f.seed();await f.patch({continuation:{request:f.child,attempted:false,envelope:null}});await f.store.close();
 const store=new MiningTaxClaimJournalStore(f.identity,f.trust,f.db);f.ports.prepareContinuation=vi.fn(async(_parent,_request,_guard,retain)=>{expect((await store.read()).operation!.continuation!.attempted).toBe(true);await retain(f.envelope);return f.envelope;});const reopened=new MiningTaxClaimController(store,f.ports,f.trust);await reopened.open();expect(f.ports.prepareContinuation).not.toHaveBeenCalled();await reopened.resumeContinuation();expect(reopened.snapshot().error).toBeNull();expect(f.ports.prepareContinuation).toHaveBeenCalledOnce();expect((await store.read()).operation!.continuation).toMatchObject({request:f.child,attempted:true,envelope:f.envelope});expect(f.ports.sign).not.toHaveBeenCalled();
},20000);

it.each(['unknown','old claim','queued after write'] as const)('keeps %s predecessor observations through child adoption and a cold browser heap',async mode=>{
 const f=fixture();await f.seed();await f.controller.prepareContinuation(f.child.caps);
 let restore=()=>{};
 if(mode==='queued after write'){const put=IDBObjectStore.prototype.put;const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){const result=put.call(this,value,key);if((value as {operation?:MiningTaxClaimOperation}).operation?.request.idempotencyKey===f.child.idempotencyKey)f.store.observeSettlementKey(f.p.idempotencyKey,1);return result;});restore=()=>spy.mockRestore();}
 try{await f.controller.activateContinuation();}finally{restore();}
 expect((await f.store.read()).operation!.request.idempotencyKey).toBe(f.child.idempotencyKey);
 if(mode!=='queued after write')f.store.observeSettlementKey(f.p.idempotencyKey,mode==='unknown'?undefined:1);
 await f.store.read();await f.store.close();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,{open:f.db.open.bind(f.db)} as IDBFactory);
 const row=await cold.read();expect(cold.otherSettlementHeld(f.child.idempotencyKey)).toBe(true);expect((await cold.archived(f.p.idempotencyKey))!.operation!.continuation!.envelope).toEqual(f.envelope);expect(cold.otherSettlementHeld(f.child.idempotencyKey)).toBe(true);
 await expect(cold.compareAndSet(row.revision,r=>({...r,operation:{...r.operation!,transactions:[{ordinal:0,signingStarted:true,signed:null,submitAttempted:false}]}}))).rejects.toThrow(/holds/);
},20000);
it('adopts a child at most once across competing journal instances',async()=>{
 const f=fixture();await f.seed();await f.controller.prepareContinuation(f.child.caps);const row=await f.store.read(),other=new MiningTaxClaimJournalStore(f.identity,f.trust,f.db);
 const results=await Promise.allSettled([f.store.activateContinuation(row.revision,f.envelope,f.setup),other.activateContinuation(row.revision,f.envelope,f.setup)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await other.read()).operation!.request.idempotencyKey).toBe(f.child.idempotencyKey);expect((await other.archived(f.p.idempotencyKey))!.operation!.setup).toEqual(f.setup);
},20000);
