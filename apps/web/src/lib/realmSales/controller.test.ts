import {createHash} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {describe,it,expect,vi} from 'vitest';
import {Keypair,Message,PublicKey,Transaction} from '@solana/web3.js';
import {Buffer} from 'buffer';
import bs58 from 'bs58';
import {RealmSalePreparationSchema} from '@shardkeep/shared/realmSalesApi';
import {createRealmSalePurchaseArgs} from '../../../../../packages/chain/src/seekerRealmSaleProtocol';
import {buildRealmSaleMessage} from '../../../../../packages/chain/src/seekerRealmSaleMessage';
import idl from '../../../../../packages/chain/src/idl/shardkeep_economy.json' with {type:'json'};
import {RealmSaleJournalStore,type RealmSaleStore,type RealmSaleOperation} from './journal';
import {RealmSaleController,type RealmSalePorts} from './controller';
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
  quote:{blockhash,lastValidBlockHeight:100,unixTimestamp:args.validAfter.toString(),needsAccess:access,needsQuota:quota,quotaRemaining:10,messageHex:Buffer.from(plan.messageBytes).toString('hex'),messageSha256:plan.messageSha256,packetBytes:plan.packetBytes,
   rents:plan.expectedNewAccounts.map(a=>({address:a.address,space:a.space,minimumBalanceLamports:'1000',existingLamports:'0',maxIncreaseLamports:'1000'})),feeLamports:fee.toString(),rentLamports:rent.toString(),paymentDebitLamports:plan.buyerNetPaymentLamports.toString(),requiredLamports:required.toString(),payerLamports:required.toString()},
  state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false});
 const trust={genesisHash:p.source.genesisHash,programId:p.source.programId,developer:p.terms.developer,reviewedProgramDataSha256:p.source.programDataSha256,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,revision:p.source.revision};
 return {preparation:p,signed:()=>{const tx=Transaction.populate(Message.from(Buffer.from(p.quote.messageHex,'hex')),[bs58.encode(new Uint8Array(64))]);tx.partialSign(signer);return {wire:tx.serialize().toString('base64'),signature:bs58.encode(tx.signature!)};}};
}

function setup(){
 const f=realmSaleSigningFixture(),p=f.preparation,factory=new IDBFactory(),identity={origin:'https://game.test',api:'https://game.test/api',cluster:'devnet' as const,wallet:p.wallet},store=new RealmSaleJournalStore(identity,factory);
 const state={current:true,elapsed:0,clock:BigInt(p.terms.validAfter),held:false};
 const envelope=()=>({wallet:p.wallet,idempotencyKey:p.idempotencyKey,preparation:p});
 const review=()=>({version:1,saleId:p.saleId,wallet:p.wallet,idempotencyKey:p.idempotencyKey,messageSha256:p.quote.messageSha256,sourceRevision:p.source.revision,snapshotHash:p.source.snapshotHash,quoteSlot:p.source.admissionSlot,unixTimestamp:state.clock.toString(),validUntil:p.terms.validUntil,feeSlot:p.source.admissionSlot,bracketSlot:p.source.admissionSlot,blockHeight:p.quote.lastValidBlockHeight,feeLamports:p.quote.feeLamports,rentLamports:p.quote.rentLamports,paymentDebitLamports:p.quote.paymentDebitLamports,requiredLamports:p.quote.requiredLamports,payerLamports:p.quote.payerLamports,quotaRemaining:p.quote.quotaRemaining,rents:p.quote.rents.map(r=>({address:r.address,lamports:r.maxIncreaseLamports})),admissionEligible:true,signingAuthorized:false,paymentAuthorized:false,submissionAuthorized:false,reservation:false});
 const serverWire=()=>{const signed=f.signed(),bytes=Buffer.from(signed.wire,'base64');return {wallet:p.wallet,idempotencyKey:p.idempotencyKey,saleId:p.saleId,signature:signed.signature,signedTransactionHex:bytes.toString('hex'),wireSha256:createHash('sha256').update(bytes).digest('hex'),messageSha256:p.quote.messageSha256,acceptedAt:'2026-09-25T00:00:00.000000Z',currentSigningAuthorized:false,relayAuthorized:false};};
 const ports:RealmSalePorts={getFailure:async key=>({wallet:identity.wallet,idempotencyKey:key,failure:null}),capture:()=>()=>{if(!state.current)throw Error('obsolete account');},lock:async(_name,run)=>run(),key:()=>p.idempotencyKey,clock:()=>state.elapsed,
  prepare:vi.fn(async(_request,_guard,retain)=>{expect((await store.read()).operation?.prepareAttempted).toBe(true);const value=envelope();await retain(value);return value;}),
  getPreparation:vi.fn(async(_request,_guard,retain)=>{const value=envelope();await retain(value);return value;}),getSaved:vi.fn(async(_key,_guard,retain)=>{const value={...envelope(),wire:null,settlement:state.held?{}:null};await retain(value);return value;}),
  currentReview:vi.fn(async()=>review()),sign:vi.fn(async()=>{expect((await store.read()).operation?.signingStarted).toBe(true);return f.signed();}),
  submit:vi.fn(async(_request,_guard,retain)=>{const op=(await store.read()).operation;expect(op?.submitAttempted&&op.signed).toBeTruthy();const value={wallet:p.wallet,idempotencyKey:p.idempotencyKey,wire:serverWire(),settlement:null,delivery:'held',reason:'DELIVERY_UNAVAILABLE'};await retain(value);return value;})};
 const controller=new RealmSaleController(store,ports);return {f,p,store,factory,identity,state,envelope,review,serverWire,ports,controller};
}
async function ready(f:ReturnType<typeof setup>){await f.controller.begin(0,0);await f.controller.review();}
describe('original realm sale headless controller',()=>{
 it('orders durable markers before prepare, wallet and submit and never replays POSTs',async()=>{
  const f=setup();await ready(f);expect(f.controller.snapshot().review).not.toBeNull();await f.controller.sign();await f.controller.submit();await f.controller.submit();await f.controller.open();expect(f.ports.prepare).toHaveBeenCalledTimes(1);expect(f.ports.sign).toHaveBeenCalledTimes(1);expect(f.ports.submit).toHaveBeenCalledTimes(1);expect((await f.store.read()).operation?.signed).toEqual(f.f.signed());
 });
 it('keeps lost preparation marker and recovers by GET without another POST or key',async()=>{
  const f=setup();f.ports.prepare=vi.fn(async()=>{throw Error('timeout');});await f.controller.begin(0,0);expect((await f.store.read()).operation?.prepareAttempted).toBe(true);await f.controller.open();expect((await f.store.read()).operation?.preparation).toEqual(f.p);await f.controller.begin(1,0);expect(f.ports.prepare).toHaveBeenCalledTimes(1);expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('never reaches external effects after storage failure',async()=>{
  const f=setup(),broken:RealmSaleStore={identity:f.identity,key:f.store.key,observeSettlementKey:k=>f.store.observeSettlementKey(k),observeFailureKey:k=>f.store.observeFailureKey(k),archiveFailure:(r,v)=>f.store.archiveFailure(r,v),settlementHeld:()=>f.store.settlementHeld(),read:()=>f.store.read(),archive:r=>f.store.archive(r),archived:k=>f.store.archived(k),compareAndSet:async()=>{throw Error('quota full');}};const c=new RealmSaleController(broken,f.ports);await c.begin(0,0);expect(f.ports.prepare).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('retains late valid preparation after logout before lifecycle rejection',async()=>{
  const f=setup();f.ports.prepare=vi.fn(async(_request,guard,retain)=>{f.state.current=false;await retain(f.envelope());guard();return f.envelope();});await f.controller.begin(0,0);expect((await f.store.read()).operation?.preparation).toEqual(f.p);expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('retains valid late signature after logout and dismiss without submitting',async()=>{
  const f=setup();await ready(f);f.ports.sign=vi.fn(async()=>{f.state.current=false;f.controller.dismiss();return f.f.signed();});await f.controller.sign();expect((await f.store.read()).operation?.signed).toEqual(f.f.signed());expect(f.ports.submit).not.toHaveBeenCalled();
 });
 it('never reopens wallet for a signing marker without bytes after an uncertain popup',async()=>{
  const f=setup();await ready(f);f.ports.sign=vi.fn(async()=>{throw Error('popup lost');});await f.controller.sign();await f.controller.review();await f.controller.sign();const other=new RealmSaleController(f.store,f.ports);await other.open();await other.review();await other.sign();expect(f.ports.sign).toHaveBeenCalledTimes(1);expect((await f.store.read()).operation?.signingStarted).toBe(true);
 });
 it('uses current review Clock rather than historical preparation Clock and expires with elapsed monotonic time',async()=>{
  const f=setup();await f.controller.begin(0,0);f.state.clock=BigInt(f.p.terms.validUntil)-1n;await f.controller.review();f.state.elapsed=1001;await f.controller.sign();expect(f.ports.sign).not.toHaveBeenCalled();expect(f.controller.snapshot().error).toMatch(/expir/i);
 });
 it('rechecks live review before wallet and refuses replaced consent',async()=>{
  const f=setup();await ready(f);f.ports.currentReview=vi.fn(async()=>({...f.review(),messageSha256:'00'.repeat(32)}));await f.controller.sign();expect(f.ports.sign).not.toHaveBeenCalled();expect((await f.store.read()).operation?.signingStarted).toBe(false);
 });
 it('refuses a changed preparation and does not erase positive local evidence on unknown GET',async()=>{
  const f=setup();await ready(f);f.ports.getPreparation=vi.fn(async(_r,_g,retain)=>{const value={...f.envelope(),preparation:null};await retain(value);return value;});await f.controller.open();expect((await f.store.read()).operation?.preparation).toEqual(f.p);expect(f.controller.snapshot().error).toBeTruthy();
 });
 it('recovers verified server wire only after original signing marker, compares prior bytes and holds unparsed settlement',async()=>{
  const f=setup();await ready(f);f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const value={...f.envelope(),wire:f.serverWire(),settlement:{unknown:'positive'}};await retain(value);return value;});await f.controller.open();expect((await f.store.read()).operation?.signed).toBeNull();
  const j=await f.store.read();await expect(f.store.compareAndSet(j.revision,o=>({...o,operation:{...o.operation!,signingStarted:true}}))).rejects.toThrow();
  const g=setup();await ready(g);const original=await g.store.read();await g.store.compareAndSet(original.revision,o=>({...o,operation:{...o.operation!,signingStarted:true}}));
  g.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const value={...g.envelope(),wire:g.serverWire(),settlement:{unknown:'positive'}};await retain(value);return value;});
  await g.controller.open();expect((await g.store.read()).operation?.signed).toEqual(g.f.signed());expect(g.controller.snapshot().settlementHeld).toBe(true);await g.controller.sign();await g.controller.submit();expect(g.ports.sign).not.toHaveBeenCalled();expect(g.ports.submit).not.toHaveBeenCalled();
 });
 it('allows only one concurrent intent writer under CAS even if adapter lock is bypassed',async()=>{
  const f=setup(),otherStore=new RealmSaleJournalStore(f.identity,f.factory),other=new RealmSaleController(otherStore,f.ports);await Promise.all([f.controller.begin(0,0),other.begin(0,0)]);expect(f.ports.prepare).toHaveBeenCalledTimes(1);expect((await f.store.read()).operation?.request).toEqual({idempotencyKey:f.p.idempotencyKey,spot:0,realm:0});
 });
 it.each(['sign','submit'] as const)('rechecks the %s attempt marker inside the final CAS after asynchronous review',async effect=>{
  const f=setup();await ready(f);if(effect==='submit')await f.controller.sign();
  f.ports.currentReview=vi.fn(async()=>{const j=await f.store.read();await f.store.compareAndSet(j.revision,row=>({...row,operation:{...row.operation!,[effect==='sign'?'signingStarted':'submitAttempted']:true}}));return f.review();});
  await f.controller[effect]();expect(effect==='sign'?f.ports.sign:f.ports.submit).not.toHaveBeenCalled();
 });

 it('holds matching-key unparsed settlement even when its accompanying wire is malformed',async()=>{
  const f=setup();await ready(f);f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const value={...f.envelope(),wire:{invalid:true},settlement:{unknown:'positive'}};await retain(value);return value;});await f.controller.open();expect(f.controller.snapshot().settlementHeld).toBe(true);expect((await f.store.read()).operation?.signed).toBeNull();expect(f.ports.sign).not.toHaveBeenCalled();
 });

 it('retains a positive settlement hold across reopen even if later recovery reports no settlement',async()=>{
  const f=setup();await ready(f);
  f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const value={...f.envelope(),wire:{invalid:true},settlement:{unknown:'positive'}};await retain(value);return value;});
  await f.controller.open();expect((await f.store.read()).operation).toMatchObject({settlementObserved:true});
  f.ports.getSaved=vi.fn(async(_key,_guard,retain)=>{const value={...f.envelope(),wire:null,settlement:null};await retain(value);return value;});
  const reopened=new RealmSaleController(new RealmSaleJournalStore(f.identity,f.factory),f.ports);
  await reopened.open();expect(reopened.snapshot().settlementHeld).toBe(true);
  await reopened.review();await reopened.sign();await reopened.submit();
  expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.submit).not.toHaveBeenCalled();
 });

});
