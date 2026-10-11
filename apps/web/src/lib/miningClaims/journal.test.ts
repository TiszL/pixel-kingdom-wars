import {IDBFactory} from 'fake-indexeddb';
import {describe,it,expect} from 'vitest';
import {MiningClaimJournalStore,parseMiningClaimIdentity,parseMiningClaimJournal,miningClaimPrepareRefusalDefinitive,type MiningClaimOperation,type MiningClaimJournal} from './journal';
import {miningClaimFixture} from './fixtures.test-support';

type Fixture=Awaited<ReturnType<typeof miningClaimFixture>>;
const draft=(f:Fixture):MiningClaimOperation=>({request:{idempotencyKey:f.preparation.idempotencyKey},prepareAttempted:false,prepareRefusal:null,refusalConfirmedAbsent:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false,claim:null});
async function edit(store:MiningClaimJournalStore,old:MiningClaimJournal,change:Partial<MiningClaimOperation>){return store.compareAndSet(old.revision,j=>({...j,operation:{...j.operation!,...change}}));}
async function prepared(store:MiningClaimJournalStore,f:Fixture){
 let j=await store.compareAndSet(0,old=>({...old,operation:draft(f)}));j=await edit(store,j,{prepareAttempted:true});return edit(store,j,{preparation:f.preparation});
}
async function signed(store:MiningClaimJournalStore,f:Fixture){let j=await prepared(store,f);j=await edit(store,j,{signingStarted:true});return edit(store,j,{signed:await f.signed()});}
describe('mining claim durable original journal',()=>{
 it('preserves unpaid failed evidence and full wire through archival without allowing terminal regression',async()=>{
  const f=miningClaimFixture(),factory=new IDBFactory(),store=new MiningClaimJournalStore(f.identity,factory);let j=await signed(store,f);
  j=await edit(store,j,{claim:f.claim('failed')});
  for(const claim of [f.claim('retained'),f.claim('settled'),{...f.claim('failed'),transactions:f.claim('failed').transactions.map(t=>({...t,settledAt:'2035-01-01T00:00:01.000Z'}))}])await expect(edit(store,j,{claim})).rejects.toThrow();
  await expect(edit(store,j,{submitAttempted:true})).rejects.toThrow();
  j=await store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}));
  expect((await new MiningClaimJournalStore(f.identity,factory).read()).archives[0]).toMatchObject({signed:f.signed(),claim:{state:'failed',settledBaseUnits:null}});
  await expect(store.compareAndSet(j.revision,old=>({...old,operation:draft(f)}))).rejects.toThrow('reused');
 });
 it('cannot start signing failed evidence and a paid ordinal never becomes failed',async()=>{
  const f=miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());let j=await prepared(store,f);
  j=await edit(store,j,{claim:f.claim('failed')});await expect(edit(store,j,{signingStarted:true})).rejects.toThrow();
  const paidStore=new MiningClaimJournalStore(f.identity,new IDBFactory());let paid=await prepared(paidStore,f);paid=await edit(paidStore,paid,{claim:f.claim('settled')});
  await expect(edit(paidStore,paid,{claim:f.claim('failed')})).rejects.toThrow();
 });
 it('keeps split failed ordinals immutable while a later signed claim advances and split failure stays unarchivable',async()=>{
  const f=miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory()),tx=f.preparation.transactions[0]!;
  f.preparation.transactions=[{...tx,kind:'setup'},{...tx,ordinal:1,kind:'claim',rentLamports:'0'}];f.preparation.fees.feeLamports='10000';f.preparation.fees.totalLamports='20000';
  let j=await prepared(store,f);const setup={...f.claim('failed').transactions[0]!,kind:'setup' as const},pending={ordinal:1,kind:'claim' as const,signature:null,landing:'pending' as const,settledBaseUnits:null,acceptedAt:null,settledAt:null};
  const failure={...f.claim('failed'),transactions:[setup,pending]};j=await edit(store,j,{claim:failure});
  await expect(store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}))).rejects.toThrow();
  const signature='1'.repeat(63)+'2',signedClaim={...pending,signature,acceptedAt:f.preparation.serverNow};
  j=await edit(store,j,{claim:{...failure,state:'retained',landing:'pending',signature,transactions:[setup,signedClaim]}});
  j=await edit(store,j,{claim:{...failure,state:'settled',landing:'finalized',signature,settledBaseUnits:'80',transactions:[setup,{...signedClaim,landing:'finalized',settledBaseUnits:'80',settledAt:f.preparation.serverNow}]}});
  expect(j.operation!.claim!.transactions[0]).toEqual(setup);expect(j.operation!.claim!.settledBaseUnits).toBe('80');
 });
 it('paid split claim accepts a later verified setup failure without changing its payment',async()=>{
  const f=miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory()),tx=f.preparation.transactions[0]!;
  f.preparation.transactions=[{...tx,kind:'setup'},{...tx,ordinal:1,kind:'claim',rentLamports:'0'}];f.preparation.fees.feeLamports='10000';f.preparation.fees.totalLamports='20000';
  let j=await prepared(store,f);const paid=f.claim('settled'),claim={...paid.transactions[0]!,ordinal:1,kind:'claim' as const};
  const setup={ordinal:0,kind:'setup' as const,signature:'1'.repeat(63)+'2',landing:'pending' as const,settledBaseUnits:null,acceptedAt:f.preparation.serverNow,settledAt:null};
  j=await edit(store,j,{claim:{...paid,transactions:[setup,claim]}});
  const result={...paid,transactions:[{...setup,landing:'failed' as const,settledAt:f.preparation.serverNow},claim]};j=await edit(store,j,{claim:result});
  j=await store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}));expect(j.archives[0]!.claim).toEqual(result);
 });
 it('owns identity and persists exact original preparation/signature across a new instance',async()=>{
  const f=await miningClaimFixture(),factory=new IDBFactory(),input={...f.identity},a=new MiningClaimJournalStore(input,factory);const j=await signed(a,f);
  input.wallet='11111111111111111111111111111111';expect(a.identity.wallet).toBe(f.identity.wallet);expect(Object.isFrozen(a.identity)).toBe(true);
  const b=new MiningClaimJournalStore(f.identity,factory);expect(await b.read()).toEqual(j);
  const read=await b.read();read.operation!.preparation!.fees.totalLamports='999';expect((await a.read()).operation!.preparation).toEqual(f.preparation);await a.close();await b.close();
 });
 it('isolates origin/API/cluster/wallet and serializes two independent CAS writers',async()=>{
  const f=await miningClaimFixture(),factory=new IDBFactory(),a=new MiningClaimJournalStore(f.identity,factory),b=new MiningClaimJournalStore(f.identity,factory);
  const results=await Promise.allSettled([a.compareAndSet(0,j=>({...j,operation:draft(f)})),b.compareAndSet(0,j=>({...j,operation:draft(f)}))]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  for(const patch of [{origin:'https://other.test'},{api:'https://other.test/api'},{cluster:'mainnet-beta' as const},{wallet:'So11111111111111111111111111111111111111112'}])expect((await new MiningClaimJournalStore({...f.identity,...patch},factory).read()).operation).toBeNull();
 });
 it('requires every irreversible marker before its external result and never clears uncertainty',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());let j=await store.compareAndSet(0,old=>({...old,operation:draft(f)}));
  await expect(edit(store,j,{prepareAttempted:true,preparation:f.preparation})).rejects.toThrow();await expect(edit(store,j,{preparation:f.preparation})).rejects.toThrow();
  j=await edit(store,j,{prepareAttempted:true});await expect(edit(store,j,{prepareAttempted:false})).rejects.toThrow();await expect(store.compareAndSet(j.revision,old=>({...old,operation:null}))).rejects.toThrow();
  j=await edit(store,j,{preparation:f.preparation});await expect(edit(store,j,{signingStarted:true,signed:await f.signed()})).rejects.toThrow();
  j=await edit(store,j,{signingStarted:true});await expect(edit(store,j,{signingStarted:false})).rejects.toThrow();j=await edit(store,j,{signed:await f.signed()});
  j=await edit(store,j,{submitAttempted:true});await expect(edit(store,j,{submitAttempted:false})).rejects.toThrow();expect((await store.read()).operation!.submitAttempted).toBe(true);
 });
 it('keeps original preparation terms while allowing only serverNow refresh',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());let j=await prepared(store,f);
  const refreshed={...f.preparation,serverNow:new Date(Date.parse(f.preparation.serverNow)+1000).toISOString()};j=await edit(store,j,{preparation:refreshed});expect(j.operation!.preparation).toEqual(f.preparation);
  for(const preparation of [null,{...f.preparation,expiresAt:new Date(Date.parse(f.preparation.expiresAt)+1000).toISOString()},{...f.preparation,root:'a'.repeat(64)}])await expect(edit(store,j,{preparation})).rejects.toThrow();
  await expect(edit(store,j,{request:{idempotencyKey:'00000000-0000-4000-8000-000000000099'}})).rejects.toThrow();
 });
 it('rejects forged signature bytes and protects every retained signature and final receipt',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());let j=await prepared(store,f);j=await edit(store,j,{signingStarted:true});
  const signature=await f.signed();await expect(edit(store,j,{signed:{...signature,wire:signature.wire.slice(0,-4)+'AAAA'}})).rejects.toThrow();j=await edit(store,j,{signed:signature});
  j=await edit(store,j,{claim:f.claim('retained')});await expect(edit(store,j,{signed:null})).rejects.toThrow();await expect(edit(store,j,{claim:f.claim('prepared')})).rejects.toThrow();
  j=await edit(store,j,{claim:f.claim('settled')});for(const claim of [null,f.claim('unknown'),f.claim('retained'),{...f.claim('settled'),settledBaseUnits:'1'}])await expect(edit(store,j,{claim})).rejects.toThrow();
  const changed=structuredClone(f.claim('settled'));changed.transactions[0]!.settledAt=new Date(Date.parse(changed.transactions[0]!.settledAt!)+1000).toISOString();await expect(edit(store,j,{claim:changed})).rejects.toThrow();
 });
 it('archives only the exact settled operation and never permits a previously used key',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());let j=await signed(store,f);
  await expect(store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}))).rejects.toThrow();j=await edit(store,j,{claim:f.claim('settled')});
  j=await store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}));expect(j.archives).toHaveLength(1);
  await expect(store.compareAndSet(j.revision,old=>({...old,operation:draft(f)}))).rejects.toThrow('reused');await expect(store.compareAndSet(j.revision,old=>({...old,archives:[]}))).rejects.toThrow();
  const replacement=structuredClone(j);replacement.archives[0]!.submitAttempted=true;await expect(store.compareAndSet(j.revision,()=>replacement)).rejects.toThrow();
 });
 it('retains own positive GET completion from another device without inventing local signing or POST markers',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());let j=await prepared(store,f);j=await edit(store,j,{claim:f.claim('settled')});
  expect(j.operation).toMatchObject({signingStarted:false,signed:null,submitAttempted:false});
  j=await store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}));
  const original=structuredClone(j.archives);j=await store.compareAndSet(j.revision,old=>({...old,archives:old.archives.map(op=>({...op,preparation:{...op.preparation!,serverNow:'2035-01-02T00:00:00.000Z'},claim:{...op.claim!,serverNow:'2035-01-02T00:00:00.000Z'}}))}));expect(j.archives).toEqual(original);
 });
 it('archives definitive original refusal only after separate confirmed absence, retaining the used key',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory()),refusal={status:422,code:'INSUFFICIENT_SOL'};let j=await store.compareAndSet(0,old=>({...old,operation:draft(f)}));
  await expect(edit(store,j,{prepareRefusal:refusal})).rejects.toThrow();j=await edit(store,j,{prepareAttempted:true});
  await expect(edit(store,j,{prepareRefusal:refusal,refusalConfirmedAbsent:true})).rejects.toThrow();j=await edit(store,j,{prepareRefusal:refusal});
  await expect(store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}))).rejects.toThrow();await expect(edit(store,j,{prepareRefusal:null})).rejects.toThrow();
  j=await edit(store,j,{refusalConfirmedAbsent:true});await expect(edit(store,j,{refusalConfirmedAbsent:false})).rejects.toThrow();j=await store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}));
  await expect(store.compareAndSet(j.revision,old=>({...old,operation:draft(f)}))).rejects.toThrow('reused');
  const next=draft(f);next.request.idempotencyKey='00000000-0000-4000-8000-000000000098';expect((await store.compareAndSet(j.revision,old=>({...old,operation:next}))).operation?.prepareAttempted).toBe(false);
 });
 it('keeps refusal evidence when later positive recovery wins, and refuses unknown first-post outcomes',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());let j=await store.compareAndSet(0,old=>({...old,operation:draft(f)}));j=await edit(store,j,{prepareAttempted:true});
  for(const prepareRefusal of [{status:503,code:'CLAIM_UNAVAILABLE'},{status:500,code:'PHASE_E_DISABLED'},{status:409,code:'INSUFFICIENT_SOL'}])await expect(edit(store,j,{prepareRefusal})).rejects.toThrow();
  j=await edit(store,j,{prepareRefusal:{status:422,code:'INSUFFICIENT_SOL'}});j=await edit(store,j,{refusalConfirmedAbsent:true});j=await edit(store,j,{preparation:f.preparation});
  expect(j.operation).toMatchObject({prepareRefusal:{status:422,code:'INSUFFICIENT_SOL'},refusalConfirmedAbsent:true});await expect(store.compareAndSet(j.revision,old=>({...old,operation:null,archives:[old.operation!]}))).rejects.toThrow();
  for(const [status,code] of [[400,'INVALID_INPUT'],[422,'INSUFFICIENT_SOL'],[409,'CLAIM_ROOT_PENDING'],[503,'PHASE_E_DISABLED']] as const)expect(miningClaimPrepareRefusalDefinitive(status,code)).toBe(true);
 });
 it('refuses malformed identity, unknown evidence and forged cross-wallet records without overwriting durable bytes',async()=>{
  const f=await miningClaimFixture(),store=new MiningClaimJournalStore(f.identity,new IDBFactory());const j=await prepared(store,f);
  for(const patch of [{origin:f.identity.origin+'/'},{api:f.identity.api+'/'},{api:'https://u:p@game.test/api'},{wallet:'bad'},{cluster:'testnet'}])expect(()=>parseMiningClaimIdentity({...f.identity,...patch})).toThrow();
  expect(()=>parseMiningClaimJournal({...j,identity:{...f.identity,wallet:'So11111111111111111111111111111111111111112'}},f.identity)).toThrow();
  await expect(edit(store,j,{claim:f.claim('unknown')})).rejects.toThrow();const foreign=structuredClone(f.preparation);foreign.wallet='So11111111111111111111111111111111111111112';await expect(edit(store,j,{preparation:foreign})).rejects.toThrow();expect(await store.read()).toEqual(j);
 });
 it('keeps corrupt saved bytes untouched and fails when durable storage is absent',async()=>{
  const f=await miningClaimFixture(),factory=new IDBFactory(),store=new MiningClaimJournalStore(f.identity,factory,'claim-corrupt');await store.read();
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open('claim-corrupt',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const corrupt={original:'do not delete'};
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite');tx.objectStore('commands').put(corrupt,store.key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  await expect(store.read()).rejects.toThrow();await expect(store.compareAndSet(0,j=>j)).rejects.toThrow();
  const retained=await new Promise<unknown>(resolve=>{const r=db.transaction('commands').objectStore('commands').get(store.key);r.onsuccess=()=>resolve(r.result);});expect(retained).toEqual(corrupt);db.close();await store.close();await expect(new MiningClaimJournalStore(f.identity,undefined).read()).rejects.toThrow('storage');
 });
});
