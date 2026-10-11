import {Buffer} from 'buffer';
import {IDBFactory, IDBObjectStore} from 'fake-indexeddb';
import {expect, it, vi} from 'vitest';
import {MiningTaxClaimFailureEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimFailureApi';
import {MiningTaxClaimRecoveryEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';
import {MiningTaxClaimJournalStore, type MiningTaxClaimOperation} from './journal';
import {MiningTaxClaimController, type MiningTaxClaimPorts} from './controller';
// 2026-10-10 (CI cluster F): split-lifecycle cases re-verify the real signed prefix at every
// durable boundary, and every journal read re-derives the canonical messages; PDA derivation
// and base58 encoding dominate the CPU profile. Measured alone on a dev Mac: up to ~15 s
// (split setup). The shared 4-vCPU CI runner, with the package suites running concurrently,
// was >=4x slower and crossed the previous 20 s budget even on a ~4.6 s case. The budget is
// explicit per case (global timeouts unchanged) so a genuine hang still fails.
const SPLIT_LIFECYCLE_BUDGET_MS = 120_000;

function fixture(mode: 'claim'|'combined'|'split' = 'combined', ordinals = [0], setup = false) {
 const recovery = MiningTaxClaimRecoveryEnvelopeSchema.parse(structuredClone(fixtures[mode])), p = recovery.preparation!;
 recovery.status = setup ? 'setup' : 'signed'; recovery.settlement = setup ? MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.setup).settlement : null;
 const failures = ordinals.map(ordinal => {
  const wire = recovery.wires[ordinal]!;
  return {wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,ordinal,verifiedAt:'2020-01-01T00:00:00.000000Z',transactionFailed:true,claimFinalized:false,
   receipt:{version:1,wallet:p.wallet,idempotencyKey:p.idempotencyKey,claimId:p.claimId,round:p.round,spot:p.spot,ordinal,kind:wire.kind,signature:wire.signature,messageSha256:wire.messageSha256,signedTransactionSha256:wire.wireSha256,
    slot:Math.max(p.source.snapshotSlot,p.source.blockhashSlot)+1,blockTime:Number(p.snapshot.unixTimestamp),feeLamports:'18446744073709551615',rentLamports:'0',paidKeepBaseUnits:'0',outcome:'failed',finalityAuthenticated:true,paymentAuthorized:false,signingAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false,
    source:{trust:'trusted-finalized-rpc-reviewed-program',genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256,snapshotSha256:p.source.snapshotSha256,snapshotSlot:p.source.snapshotSlot,blockhashSlot:p.source.blockhashSlot,observedAccountSlot:Math.max(p.source.snapshotSlot,p.source.blockhashSlot)+2}}};
 });
 const envelope = MiningTaxClaimFailureEnvelopeSchema.parse({recovery, failures});
 const identity = {origin:'https://game.test',api:'https://api.test',cluster:'devnet' as const,wallet:p.wallet};
 const trust = {genesisHash:p.identity.genesisHash,programId:p.identity.programId,configAddress:p.identity.configAddress,keepMint:p.identity.keepMint,reserveOwner:p.identity.reserveOwner,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,reviewedProgramDataSha256:p.source.reviewedProgramDataSha256};
 const db = new IDBFactory(), store = new MiningTaxClaimJournalStore(identity,trust,db);
 const request = {idempotencyKey:p.idempotencyKey,round:p.round,spot:p.spot,caps:{...p.caps}};
 const wires = recovery.wires.map(w => ({ordinal:w.ordinal,wire:Buffer.from(w.signedTransactionHex,'hex').toString('base64'),signature:w.signature,messageSha256:w.messageSha256,wireSha256:w.wireSha256}));
 const patch = async (change: Partial<MiningTaxClaimOperation>) => {const row = await store.read();return store.compareAndSet(row.revision,r => ({...r,operation:{...r.operation!,...change}}));};
 const seed = async (custody = wires.map(w => w.ordinal), retainWires = true) => {
  await store.compareAndSet(0,r => ({...r,operation:{request,prepareAttempted:false,preparation:null,transactions:[],observed:[],unattributedObserved:false,setup:null,settlement:null}}));
  await patch({prepareAttempted:true});await patch({preparation:p});
  for(const ordinal of custody){const row=await store.read();await patch({transactions:[...row.operation!.transactions,{ordinal,signingStarted:true,signed:null,submitAttempted:false}]});
   if(retainWires){const row=await store.read();await patch({transactions:row.operation!.transactions.map(t=>t.ordinal===ordinal?{...t,signed:wires[ordinal]!}:t)});}}
 };
 let epoch=0;
 const ports: MiningTaxClaimPorts = {
  capture:()=>{const captured=epoch;return()=>{if(captured!==epoch)throw Error('account changed');};},lock:async(_name,run)=>run(),clock:()=>0,key:()=>p.idempotencyKey,
  prepare:vi.fn(),getPreparation:vi.fn(),getContinuation:vi.fn(),prepareContinuation:vi.fn(),currentReview:vi.fn(),sign:vi.fn(),submit:vi.fn(),
  getSaved:vi.fn(async(_key,guard,retain)=>{guard();await retain(envelope.recovery);return envelope.recovery;}),
  getFailures:vi.fn(async(_key,guard,retain)=>{guard();await retain(envelope);return envelope;}),
 };
 const controller=new MiningTaxClaimController(store,ports,trust);
 return {p,request,envelope,identity,trust,db,store,wires,seed,patch,ports,controller,retire:()=>{epoch++;}};
}

it.each(['claim','combined','split-both','split-setup'] as const)('retains and explicitly archives complete %s failed history after a fresh GET',async mode=>{
 const f=fixture(mode.startsWith('split')?'split':mode as 'claim'|'combined',mode==='split-both'?[0,1]:mode==='split-setup'?[1]:[0],mode==='split-setup');await f.seed();await f.controller.open();
 const before=await f.store.read();expect(before.operation!.failure).toEqual(f.envelope);expect(before.operation!.settlement).toBeNull();
 expect(f.ports.getFailures).toHaveBeenCalledOnce();await f.controller.archiveFailed();expect(f.controller.snapshot().error).toBeNull();expect(f.ports.getFailures).toHaveBeenCalledTimes(2);
 expect((await f.store.read()).operation).toBeNull();await f.store.close();const reopened=new MiningTaxClaimJournalStore(f.identity,f.trust,f.db),history=await reopened.archived(f.p.idempotencyKey);
 expect(history!.operation!.failure!.failures[0]!.receipt.feeLamports).toBe('18446744073709551615');expect(history!.operation!.transactions).toEqual(before.operation!.transactions);
 if(mode==='split-setup')expect(history!.operation!.setup!.settlement).toEqual(fixtures.setup.settlement);
 expect(f.ports.prepare).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.submit).not.toHaveBeenCalled();
 await expect(reopened.compareAndSet((await reopened.read()).revision,r=>({...r,operation:{...before.operation!,prepareAttempted:false,preparation:null,transactions:[],observed:[],setup:null,failure:null}}))).rejects.toThrow();
},SPLIT_LIFECYCLE_BUDGET_MS);
it.each([0,1])('keeps sparse split failure ordinal %s held without inventing the other outcome',async ordinal=>{
 const f=fixture('split',[ordinal]);f.envelope.recovery.wires=f.envelope.recovery.wires.filter(w=>w.ordinal===ordinal);await f.seed([ordinal]);await f.controller.open();await f.controller.archiveFailed();
 expect((await f.store.read()).operation!.failure!.failures).toHaveLength(1);expect(f.controller.snapshot().error).toMatch(/every|complete|outcome/i);expect(f.store.settlementHeld()).toBe(true);
 await f.controller.review(ordinal===0?1:0);expect(f.ports.currentReview).not.toHaveBeenCalled();
},SPLIT_LIFECYCLE_BUDGET_MS);
it('preserves existing immutable failures while adding a later second failed outcome',async()=>{
 const f=fixture('split',[0,1]);await f.seed();const last=f.envelope.failures.pop()!;await f.controller.open();const first=(await f.store.read()).operation!.failure!.failures[0];f.envelope.failures.push(last);await f.controller.check();
 expect((await f.store.read()).operation!.failure!.failures).toEqual([first,last]);await f.controller.archiveFailed();expect((await f.store.read()).operation).toBeNull();
},SPLIT_LIFECYCLE_BUDGET_MS);
it.each(['missing','changed','unavailable','session','revision'] as const)('fresh %s recovery cannot clear previously bound failed history',async mode=>{
 const f=fixture();await f.seed();await f.controller.open();const old=await f.store.read();
 f.ports.getFailures=vi.fn(async(_key,_guard,retain)=>{
  if(mode==='unavailable')throw Error('offline');
  const raw=structuredClone(f.envelope);if(mode==='missing')raw.failures=[];if(mode==='changed')raw.failures[0]!.receipt.feeLamports='1';
  if(mode==='session')f.retire();if(mode==='revision')await f.patch({observed:[0]});await retain(raw);return raw;
 });
 await f.controller.archiveFailed();expect((await f.store.read()).operation!.failure).toEqual(old.operation!.failure);expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();
});
it('retains exact nested custody and positive holds despite malformed outer failed recovery after account retirement',async()=>{
 const f=fixture();await f.seed([0],false);f.ports.getSaved=vi.fn(async()=>({...f.envelope.recovery,status:'prepared',wires:[]}));
 const raw={...f.envelope,failures:[{ordinal:0,unexpected:true}]};f.ports.getFailures=vi.fn(async(_key,_guard,retain)=>{f.retire();await retain(raw);return raw;});await f.controller.open();
 expect((await f.store.read()).operation!.transactions[0]!.signed).toEqual(f.wires[0]);expect((await f.store.read()).operation!.failure).toBeUndefined();expect(f.store.settlementHeld()).toBe(true);
});
it('rolls back history and active clear together when failed archival runs out of storage',async()=>{
 const f=fixture();await f.seed();await f.controller.open();const before=await f.store.read();const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw Error('storage full');});
 try{await f.controller.archiveFailed();}finally{spy.mockRestore();}expect(await f.store.read()).toEqual(before);expect(await f.store.archived(f.p.idempotencyKey)).toBeNull();expect(f.store.settlementHeld()).toBe(true);
});
it('requires the same revision and permits only one concurrent failed archive',async()=>{
 const f=fixture();await f.seed();await f.controller.open();const row=await f.store.read();const other=new MiningTaxClaimJournalStore(f.identity,f.trust,f.db);
 const results=await Promise.allSettled([f.store.archiveFailure(row.revision,f.envelope),other.archiveFailure(row.revision,f.envelope)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await other.archived(f.p.idempotencyKey))!.operation!.failure).toEqual(f.envelope);
});
it('never archives an unattributed observation even with all known failed outcomes',async()=>{
 const f=fixture();await f.seed();await f.controller.open();f.store.observeSettlementKey(f.p.idempotencyKey);await f.controller.archiveFailed();expect((await f.store.read()).operation).not.toBeNull();
});
it.each(['memory','durable','during verification'] as const)('holds an out-of-plan ordinal observed in %s before failed archival',async mode=>{
 const f=fixture();await f.seed();await f.controller.open();const row=await f.store.read();let restore=()=>{};
 if(mode==='memory')f.store.observeSettlementKey(f.p.idempotencyKey,1);
 else if(mode==='durable')await f.store.observeSettlement(row.revision,f.p.idempotencyKey,1);
 else {const digest=crypto.subtle.digest.bind(crypto.subtle),spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(a,b)=>{f.store.observeSettlementKey(f.p.idempotencyKey,1);return digest(a,b);});restore=()=>spy.mockRestore();}
 try{await f.controller.archiveFailed();}finally{restore();}expect((await f.store.read()).operation).not.toBeNull();expect(f.store.settlementHeld(f.p.idempotencyKey,1)).toBe(true);
});
it.each([undefined,1])('keeps a newly observed unknown or uncovered ordinal %s held after old failed history is reopened',async ordinal=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.archiveFailed();expect((await f.store.read()).operation).toBeNull();
 f.store.observeSettlementKey(f.p.idempotencyKey,ordinal);expect(await f.store.archived(f.p.idempotencyKey)).not.toBeNull();await f.store.read();expect(f.store.settlementHeld()).toBe(true);
});
it.each([undefined,1])('keeps ordinal %s arriving after archive writes were queued but before IDB completion',async ordinal=>{
 const f=fixture();await f.seed();await f.controller.open();const put=IDBObjectStore.prototype.put;
 const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){const result=put.call(this,value,key);if((value as {operation?:unknown}).operation===null)f.store.observeSettlementKey(f.p.idempotencyKey,ordinal);return result;});
 try{await f.controller.archiveFailed();}finally{spy.mockRestore();}expect(f.store.settlementHeld()).toBe(true);await f.store.read();expect(f.store.settlementHeld()).toBe(true);
});
it('persists a failure observation before rejecting a contradiction with setup, blocking the unsigned remainder after remount',async()=>{
 const f=fixture('split',[0]);await f.seed([0]);f.envelope.recovery.wires=f.envelope.recovery.wires.slice(0,1);
 const setup=MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.setup);setup.wires=setup.wires.slice(0,1);
 f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{await retain(setup);return setup;});await f.controller.open();
 const row=await f.store.read();expect(row.operation!.setup).not.toBeNull();expect(row.operation!.failure).toBeUndefined();expect(row.operation!.failureObserved).toBe(true);
 const reopened=new MiningTaxClaimJournalStore(f.identity,f.trust,f.db);expect((await reopened.read()).operation!.failureObserved).toBe(true);expect(reopened.settlementHeld(f.p.idempotencyKey,1)).toBe(true);
 await expect(reopened.compareAndSet(row.revision,r=>({...r,operation:{...r.operation!,transactions:[...r.operation!.transactions,{ordinal:1,signingStarted:true,signed:null,submitAttempted:false}]}}))).rejects.toThrow();
},SPLIT_LIFECYCLE_BUDGET_MS);
it('does not let prior successful payment erase a subsequently observed contradictory failure',async()=>{
 const f=fixture();await f.seed();f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const paid=MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.combined);await retain(paid);return paid;});await f.controller.open();
 expect((await f.store.read()).operation!.settlement).not.toBeNull();await f.controller.archive();expect((await f.store.read()).operation).not.toBeNull();expect(f.store.settlementHeld()).toBe(true);
});
it('preserves a new failure-specific hold when reopening previously archived payment',async()=>{
 const f=fixture();await f.seed();const paid=MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.combined);let row=await f.store.read();row=await f.store.observeSettlement(row.revision,f.p.idempotencyKey,0);await f.patch({settlement:paid});
 await f.store.archive((await f.store.read()).revision);f.store.observeFailureKey(f.p.idempotencyKey);await f.store.read();expect(f.store.settlementHeld()).toBe(true);
});
it('does not allow failure evidence to be removed, rewritten, or combined with conflicting success',async()=>{
 const f=fixture();await f.seed();await f.controller.open();const changed=structuredClone(f.envelope);changed.failures[0]!.receipt.feeLamports='1';
 for(const patch of [{failure:null},{failure:changed},{settlement:MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.combined)}])await expect(f.patch(patch)).rejects.toThrow();
});

// A new facade shares the database but has no entry in the process WeakMap.
const coldStorage = (db: IDBFactory): IDBFactory => ({open:db.open.bind(db)} as IDBFactory);
it.each(['failure','unknown','outside'] as const)('keeps post-archive %s observations across a fresh browser heap',async mode=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.archiveFailed();
 if(mode==='failure'){
  // A failure tag is covered by failed history; use paid history for a contradiction.
  const g=fixture();await g.seed();await g.store.observeSettlement((await g.store.read()).revision,g.p.idempotencyKey,0);await g.patch({settlement:MiningTaxClaimRecoveryEnvelopeSchema.parse(fixtures.combined)});await g.store.archive((await g.store.read()).revision);
  g.store.observeFailureKey(g.p.idempotencyKey);await g.store.read();await g.store.close();const cold=new MiningTaxClaimJournalStore(g.identity,g.trust,coldStorage(g.db));await cold.read();expect(cold.settlementHeld()).toBe(true);expect((await cold.archived(g.p.idempotencyKey))!.operation!.failure).toBeUndefined();expect(cold.settlementHeld()).toBe(true);return;
 }
 f.store.observeSettlementKey(f.p.idempotencyKey,mode==='unknown'?undefined:1);await f.store.read();await f.store.close();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await cold.read();expect(cold.settlementHeld()).toBe(true);expect((await cold.archived(f.p.idempotencyKey))!.operation!.failure).toEqual(f.envelope);expect(cold.settlementHeld()).toBe(true);
});
it('preserves a post-write observation durably when archive completion races its save',async()=>{
 const f=fixture();await f.seed();await f.controller.open();const put=IDBObjectStore.prototype.put;
 const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){const result=put.call(this,value,key);if((value as {operation?:unknown}).operation===null)f.store.observeSettlementKey(f.p.idempotencyKey,1);return result;});
 try{await f.controller.archiveFailed();}finally{spy.mockRestore();}await f.store.read();await f.store.close();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await cold.read();expect(cold.settlementHeld()).toBe(true);
});
it('clears only covered durable observations after complete failed archival',async()=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.archiveFailed();await f.store.close();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await cold.read();expect(cold.settlementHeld()).toBe(false);expect((await cold.archived(f.p.idempotencyKey))!.operation!.failure).toEqual(f.envelope);
});
it('refuses a direct new-intent CAS after cold restart without a preliminary read',async()=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.archiveFailed();f.store.observeSettlementKey(f.p.idempotencyKey);const row=await f.store.read();await f.store.close();
 const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await expect(cold.compareAndSet(row.revision,r=>({...r,operation:{request:{...f.request,idempotencyKey:'ffffffff-ffff-4fff-8fff-ffffffffffff'},prepareAttempted:false,preparation:null,transactions:[],observed:[],unattributedObserved:false,setup:null,settlement:null}}))).rejects.toThrow(/holds/);
});
it('surfaces sidecar storage failure without releasing the in-process hold or changing history',async()=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.archiveFailed();f.store.observeSettlementKey(f.p.idempotencyKey);const put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw Error('storage full');});
 try{await expect(f.store.read()).rejects.toThrow(/storage full/);}finally{put.mockRestore();}expect(f.store.settlementHeld()).toBe(true);await f.store.read();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await cold.read();expect(cold.settlementHeld()).toBe(true);expect((await cold.archived(f.p.idempotencyKey))!.operation!.failure).toEqual(f.envelope);
});
it('drains a new tag arriving after the sidecar write before returning recovery',async()=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.archiveFailed();f.store.observeSettlementKey(f.p.idempotencyKey,0);const put=IDBObjectStore.prototype.put;let injected=false;
 const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){const result=put.call(this,value,key);if(!injected&&typeof key==='string'&&key.includes('archived-observations')){injected=true;f.store.observeSettlementKey(f.p.idempotencyKey);}return result;});
 try{await f.store.read();}finally{spy.mockRestore();}expect(injected).toBe(true);await f.store.close();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await cold.read();expect(cold.settlementHeld()).toBe(true);
});
it('persists the post-archive hold before a corrupt archived proof fails to rebind',async()=>{
 const f=fixture();await f.seed();await f.controller.open();await f.controller.archiveFailed();const row=await f.store.read();
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const q=f.db.open('pkw-mining-tax-v1',1);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite');tx.objectStore('commands').put({corrupt:true},JSON.stringify([f.identity,f.p.idempotencyKey]));tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
 f.store.observeFailureKey(f.p.idempotencyKey);await expect(f.store.read()).rejects.toThrow();await f.store.close();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await expect(cold.compareAndSet(row.revision,r=>({...r,operation:{request:{...f.request,idempotencyKey:'ffffffff-ffff-4fff-8fff-ffffffffffff'},prepareAttempted:false,preparation:null,transactions:[],observed:[],unattributedObserved:false,setup:null,settlement:null}}))).rejects.toThrow(/holds/);
});
it.each([false,true])('archive completion itself persists late evidence before a cold restart, retired=%s',async retire=>{
 const f=fixture();await f.seed();await f.controller.open();const row=await f.store.read(),put=IDBObjectStore.prototype.put;
 const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value:unknown,key?:IDBValidKey){const result=put.call(this,value,key);if((value as {operation?:unknown}).operation===null){f.store.observeSettlementKey(f.p.idempotencyKey);if(retire)f.retire();}return result;});
 try{if(retire)await f.controller.archiveFailed();else await f.store.archiveFailure(row.revision,f.envelope);}finally{spy.mockRestore();}
 await f.store.close();const cold=new MiningTaxClaimJournalStore(f.identity,f.trust,coldStorage(f.db));await cold.read();expect(cold.settlementHeld()).toBe(true);
});
