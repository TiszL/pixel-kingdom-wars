import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {describe,expect,it,vi} from 'vitest';
import {RealmSaleJournalStore,parseRealmSaleIdentity,parseRealmSaleJournal,type RealmSaleJournal,type RealmSaleOperation} from './journal';
import {Keypair,Message,PublicKey,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {RealmSalePreparationSchema} from '@shardkeep/shared/realmSalesApi';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {createRealmSalePurchaseArgs} from '../../../../../packages/chain/src/seekerRealmSaleProtocol';
import {buildRealmSaleMessage} from '../../../../../packages/chain/src/seekerRealmSaleMessage';
import idl from '../../../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
const key=(n:number)=>Keypair.fromSeed(Buffer.alloc(32,n));
function realmSaleSigningFixture(access=false,quota=false,alias='none'){
 const signer=key(1),other=key(2),dev=key(3),seller=alias==='buyer-seller'||alias==='all'?signer.publicKey:other.publicKey;
 const developer=alias==='buyer-dev'||alias==='all'?signer.publicKey:alias==='seller-dev'?seller:dev.publicKey;
 const args=createRealmSalePurchaseArgs({saleId:Buffer.alloc(16,5),spot:0,realm:0,round:0n,day:100n,seller,developer,priorExpiry:0n,validAfter:8_640_000n,validUntil:8_640_600n});
 const blockhash=key(4).publicKey.toBase58(),plan=buildRealmSaleMessage(new PublicKey(idl.address),{wallet:signer.publicKey,args,blockhash,needsAccess:access,needsQuota:quota});
 const rent=BigInt(plan.expectedNewAccounts.length)*1000n,fee=5000n,required=rent+fee+plan.buyerNetPaymentLamports;
 const p=RealmSalePreparationSchema.parse({version:1,wallet:signer.publicKey.toBase58(),idempotencyKey:'00000000-0000-4000-8000-000000000001',saleId:Buffer.from(args.saleId).toString('hex'),spot:0,realm:0,
  terms:{round:'0',day:'100',seller:seller.toBase58(),developer:developer.toBase58(),priorExpiry:'0',validAfter:args.validAfter.toString(),validUntil:args.validUntil.toString()},
  source:{revision:'test-r1',genesisHash:key(6).publicKey.toBase58(),programId:idl.address,programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:1,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:2,initialSlot:2,blockhashSlot:2,feeSlot:2,costSlot:2,admissionSlot:2},
  quote:{blockhash,lastValidBlockHeight:100,unixTimestamp:args.validAfter.toString(),needsAccess:access,needsQuota:quota,quotaRemaining:PHASE_E_POLICY.seekerIsland.paidContractsPerSpotDayMax,messageHex:Buffer.from(plan.messageBytes).toString('hex'),messageSha256:plan.messageSha256,packetBytes:plan.packetBytes,
   rents:plan.expectedNewAccounts.map(a=>({address:a.address,space:a.space,minimumBalanceLamports:'1000',existingLamports:'0',maxIncreaseLamports:'1000'})),feeLamports:fee.toString(),rentLamports:rent.toString(),paymentDebitLamports:plan.buyerNetPaymentLamports.toString(),requiredLamports:required.toString(),payerLamports:required.toString()},
  state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
 return {preparation:p,signed:()=>{const tx=Transaction.populate(Message.from(Buffer.from(p.quote.messageHex,'hex')),[bs58.encode(new Uint8Array(64))]);tx.partialSign(signer);return {wire:tx.serialize().toString('base64'),signature:bs58.encode(tx.signature!)};}};
}

type Fixture=ReturnType<typeof realmSaleSigningFixture>;
const identity=(f:Fixture)=>({origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:f.preparation.wallet});
const draft=(f:Fixture):RealmSaleOperation=>({request:{idempotencyKey:f.preparation.idempotencyKey,spot:f.preparation.spot,realm:f.preparation.realm},prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false});
async function edit(store:RealmSaleJournalStore,old:RealmSaleJournal,change:Partial<RealmSaleOperation>){return store.compareAndSet(old.revision,j=>({...j,operation:{...j.operation!,...change}}));}
async function prepared(store:RealmSaleJournalStore,f:Fixture){let j=await store.compareAndSet(0,old=>({...old,operation:draft(f)}));j=await edit(store,j,{prepareAttempted:true});return edit(store,j,{preparation:f.preparation});}
async function signed(store:RealmSaleJournalStore,f:Fixture){let j=await prepared(store,f);j=await edit(store,j,{signingStarted:true});return edit(store,j,{signed:await f.signed()});}
async function open(factory:IDBFactory,name:string){return new Promise<IDBDatabase>((resolve,reject)=>{const r=factory.open(name,1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function rawPut(db:IDBDatabase,key:string,value:unknown){return new Promise<void>((resolve,reject)=>{const tx=db.transaction('commands','readwrite');tx.objectStore('commands').put(value,key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});}
async function rawGet(db:IDBDatabase,key:string){return new Promise<unknown>((resolve,reject)=>{const r=db.transaction('commands').objectStore('commands').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
describe('durable realm sale original journal',()=>{
 it('refuses an original operation at revision zero',async()=>{
  const f=realmSaleSigningFixture();await expect(parseRealmSaleJournal({version:1,identity:identity(f),revision:0,operation:draft(f)},identity(f))).rejects.toThrow();
 });
 it('keeps exact request, preparation and cryptographically checked signed bytes across reconnect',async()=>{
  const f=realmSaleSigningFixture(),factory=new IDBFactory(),input=identity(f),store=new RealmSaleJournalStore(input,factory);let j=await signed(store,f);j=await edit(store,j,{submitAttempted:true});
  input.wallet='11111111111111111111111111111111';expect(store.identity.wallet).toBe(f.preparation.wallet);expect(Object.isFrozen(store.identity)).toBe(true);
  const next=new RealmSaleJournalStore(identity(f),factory);expect(await next.read()).toEqual(j);const read=await next.read();read.operation!.preparation!.terms.seller='11111111111111111111111111111111';expect((await store.read()).operation!.preparation).toEqual(f.preparation);await store.close();await next.close();
 });
 it('scopes recovery to all four identity fields and allows exactly one concurrent CAS writer',async()=>{
  const f=realmSaleSigningFixture(),factory=new IDBFactory(),a=new RealmSaleJournalStore(identity(f),factory),b=new RealmSaleJournalStore(identity(f),factory),up=vi.fn((j:RealmSaleJournal)=>({...j,operation:draft(f)}));
  const results=await Promise.allSettled([a.compareAndSet(0,up),b.compareAndSet(0,up)]);expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);expect(up).toHaveBeenCalledTimes(2);
  for(const patch of [{origin:'https://other.test'},{api:'https://other.test/api'},{cluster:'mainnet-beta' as const},{wallet:'So11111111111111111111111111111111111111112'}])expect((await new RealmSaleJournalStore({...identity(f),...patch},factory).read()).operation).toBeNull();
 });
 it('persists each irreversible marker before its external result and cannot clear or reset them',async()=>{
  const f=realmSaleSigningFixture(),store=new RealmSaleJournalStore(identity(f),new IDBFactory());
  for(const patch of [{prepareAttempted:true},{prepareAttempted:true,preparation:f.preparation}])await expect(store.compareAndSet(0,j=>({...j,operation:{...draft(f),...patch}}))).rejects.toThrow();
  let j=await store.compareAndSet(0,old=>({...old,operation:draft(f)}));await expect(edit(store,j,{prepareAttempted:true,preparation:f.preparation})).rejects.toThrow();j=await edit(store,j,{prepareAttempted:true});
  await expect(edit(store,j,{prepareAttempted:false})).rejects.toThrow();await expect(store.compareAndSet(j.revision,old=>({...old,operation:null}))).rejects.toThrow();
  j=await edit(store,j,{preparation:f.preparation});await expect(edit(store,j,{signingStarted:true,signed:await f.signed()})).rejects.toThrow();j=await edit(store,j,{signingStarted:true});
  await expect(edit(store,j,{signingStarted:false})).rejects.toThrow();await expect(edit(store,j,{signed:await f.signed(),submitAttempted:true})).rejects.toThrow();j=await edit(store,j,{signed:await f.signed()});j=await edit(store,j,{submitAttempted:true});await expect(edit(store,j,{submitAttempted:false})).rejects.toThrow();
 });
 it('cannot replace nested commercial terms, request, actor or original signed wire',async()=>{
  const f=realmSaleSigningFixture(),store=new RealmSaleJournalStore(identity(f),new IDBFactory());let j=await signed(store,f);
  for(const patch of [{preparation:null},{preparation:{...f.preparation,terms:{...f.preparation.terms,seller:f.preparation.wallet}}},{preparation:{...f.preparation,source:{...f.preparation.source,revision:'replacement'}}},{request:{...j.operation!.request,spot:j.operation!.request.spot+1}},{signed:null},{signed:{...j.operation!.signed!,signature:'1'.repeat(64)}}])await expect(edit(store,j,patch)).rejects.toThrow();
  await expect(parseRealmSaleJournal({...j,identity:{...identity(f),wallet:'So11111111111111111111111111111111111111112'}},identity(f))).rejects.toThrow();expect(await store.read()).toEqual(j);
 });
 it('refuses forged wire bytes, extra signed fields and oversized wire before signature decoding',async()=>{
  const f=realmSaleSigningFixture(),store=new RealmSaleJournalStore(identity(f),new IDBFactory());let j=await prepared(store,f);j=await edit(store,j,{signingStarted:true});const s=await f.signed(),forged=Buffer.from(s.wire,'base64');forged[1]=forged[1]!^1;
  for(const signed of [{...s,wire:forged.toString('base64')},{...s,wire:'A'.repeat(2000)},{...s,relayAuthorized:true}])await expect(edit(store,j,{signed})).rejects.toThrow();expect((await store.read()).operation!.signed).toBeNull();
 });
 it('owns updater output before async validation and persists a late valid wallet response without view state',async()=>{
  const f=realmSaleSigningFixture(),store=new RealmSaleJournalStore(identity(f),new IDBFactory());let j=await prepared(store,f);j=await edit(store,j,{signingStarted:true});const op={...j.operation!,signed:await f.signed()};
  const original=structuredClone(op),call=store.compareAndSet(j.revision,old=>{queueMicrotask(()=>{op.request.spot+=1;op.signed!.signature='1'.repeat(64);});return {...old,operation:op};});
  expect((await call).operation).toEqual(original);
 });
 it('does crypto outside transactions then rejects intervening CAS without rerunning updater',async()=>{
  const f=realmSaleSigningFixture(),factory=new IDBFactory(),store=new RealmSaleJournalStore(identity(f),factory),other=new RealmSaleJournalStore(identity(f),factory);let j=await prepared(store,f);j=await edit(store,j,{signingStarted:true});const s=await f.signed(),actual=crypto.subtle.digest.bind(crypto.subtle);
  let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await blocked;return actual(...args);});const up=vi.fn((old:RealmSaleJournal)=>({...old,operation:{...old.operation!,signed:s}}));const pending=store.compareAndSet(j.revision,up);
  await started;const newer=await other.compareAndSet(j.revision,old=>old);release();await expect(pending).rejects.toThrow('Another tab');spy.mockRestore();expect(up).toHaveBeenCalledTimes(1);expect(await store.read()).toEqual(newer);
 });
 it('compares raw evidence as well as revision after async verification',async()=>{
  const f=realmSaleSigningFixture(),factory=new IDBFactory(),name='realm-raw-cas',store=new RealmSaleJournalStore(identity(f),factory,name);let j=await prepared(store,f);j=await edit(store,j,{signingStarted:true});const s=await f.signed(),db=await open(factory,name),actual=crypto.subtle.digest.bind(crypto.subtle);
  let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});const spy=vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{entered();await blocked;return actual(...args);});const pending=edit(store,j,{signed:s});await started;
  const corrupt={...j,extra:'same revision but altered evidence'};await rawPut(db,store.key,corrupt);release();await expect(pending).rejects.toThrow('Another tab');spy.mockRestore();expect(await rawGet(db,store.key)).toEqual(corrupt);db.close();
 });
 it('preserves corrupt payloads and fails storage open/write failures without false progress',async()=>{
  const f=realmSaleSigningFixture(),factory=new IDBFactory(),name='realm-corrupt',store=new RealmSaleJournalStore(identity(f),factory,name);await store.read();const db=await open(factory,name),corrupt={original:'do not delete'};await rawPut(db,store.key,corrupt);await expect(store.read()).rejects.toThrow();await expect(store.compareAndSet(0,j=>j)).rejects.toThrow();expect(await rawGet(db,store.key)).toEqual(corrupt);db.close();await store.close();
  await expect(new RealmSaleJournalStore(identity(f),undefined).read()).rejects.toThrow('storage');
  const writeStore=new RealmSaleJournalStore(identity(f),new IDBFactory());await writeStore.read();const probe=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('quota full','QuotaExceededError');});await expect(writeStore.compareAndSet(0,j=>({...j,operation:draft(f)}))).rejects.toThrow('quota');probe.mockRestore();expect((await writeStore.read()).revision).toBe(0);
 });
 it('rejects malformed identity, overflow revisions and unknown operation fields',async()=>{
  const f=realmSaleSigningFixture(),store=new RealmSaleJournalStore(identity(f),new IDBFactory());for(const patch of [{origin:'https://game.test/'},{api:'https://game.test/api/'},{api:'https://u:p@game.test/api'},{wallet:'bad'},{cluster:'testnet'}])expect(()=>parseRealmSaleIdentity({...identity(f),...patch})).toThrow();
  for(const revision of [-1,1.5,Number.MAX_SAFE_INTEGER+1])await expect(store.compareAndSet(revision,j=>j)).rejects.toThrow();await expect(store.compareAndSet(0,j=>({...j,operation:{...draft(f),archives:[]}}))).rejects.toThrow();
 });
});
