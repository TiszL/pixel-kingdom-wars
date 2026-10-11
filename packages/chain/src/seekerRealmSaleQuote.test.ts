/** Synthetic finalized RPC fixtures exercise actual ABI/settlement verifiers;
 * no fixture is live finality or backend payment authorization. */
import { describe,expect,it } from 'vitest';
import { PublicKey,Message,PACKET_DATA_SIZE,SystemProgram } from '@solana/web3.js';
import { PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import { realmAccessPda,spotSalesQuotaPda } from './seekerRealmSaleProtocol';
import { createSeekerRealmSaleQuoteReader } from './seekerRealmSaleQuote';
import { realmSaleQuoteFixture } from './seekerRealmSaleQuote.fixture';
const P=PHASE_E_POLICY.seekerIsland,D=BigInt(PHASE_E_MINING_PUBLICATION.daySec);
const saleId=Buffer.alloc(16,8);
async function setup(){const f=await realmSaleQuoteFixture();const read=createSeekerRealmSaleQuoteReader(()=>f.rpc,{term:f.termPolicy,access:f.accessTrust,revision:'fixture-r1'});return {f,read};}
// 2026-10-10 (CI cluster F): every quote read verifies the finalized term against the
// real Anchor bytes, which derives ~1,670 PDAs per read (~0.6-0.9 s alone on a dev Mac,
// measured). Cases that read 2-4 times take up to ~1.9 s alone and crossed Vitest's
// default 5 s under the full parallel chain suite (reproduced locally, passes alone).
// The budget is explicit here rather than global so a real hang still fails per test.
describe('finalized atomic sale quote source',{timeout:30_000},()=>{
 it('derives current winner, price, day, prior coverage and one atomic unsigned message from verified sources',async()=>{
  const {f,read}=await setup();const q=await read({buyer:f.buyer,spot:0,realm:0},{saleId});
  expect(q.seller).toBe(f.seller.toBase58());expect(q.developer).toBe(f.developer.toBase58());expect(q.day).toBe(f.controls.now/D);
  expect(q.args.priceLamports).toBe(BigInt(P.permitPriceLamports));expect(q.paymentAuthorized).toBe(false);expect(q.admissionAuthorized).toBe(false);
  const msg=Message.from(q.messageBytes);expect(msg.header.numRequiredSignatures).toBe(1);expect(msg.accountKeys[0]).toEqual(f.buyer);
  expect(q.messageBytes.length+65).toBeLessThanOrEqual(PACKET_DATA_SIZE);expect(q.validUntil-q.validAfter).toBeLessThanOrEqual(BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec));
  expect(q.requiredLamports).toBe(q.feeLamports+q.rentLamports+q.paymentDebitLamports);expect(q.payerLamports).toBeGreaterThanOrEqual(q.requiredLamports);
 });
 it('refuses caller-supplied policy/recipient/round/price and zero sale IDs before RPC',async()=>{
  const {f,read}=await setup();for(const extra of ['seller','developer','round','priceLamports'])await expect(read({buyer:f.buyer,spot:0,realm:0,[extra]:1} as never,{saleId})).rejects.toMatchObject({code:'INPUT'});
  await expect(read({buyer:f.buyer,spot:0,realm:0},{saleId:Buffer.alloc(16)})).rejects.toMatchObject({code:'INPUT'});
 });
 it('does not invent a winner for an unsold spot',async()=>{const {f,read}=await setup();await expect(read({buyer:f.buyer,spot:P.totalSpots-1,realm:0},{saleId})).rejects.toMatchObject({code:'UNSOLD'});});
 it('refuses unavailable/null fee measurement and insufficient actual SOL',async()=>{
  const a=await setup();a.f.controls.fee=null;await expect(a.read({buyer:a.f.buyer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:'COST'});
  const b=await setup();b.f.controls.balance=1;await expect(b.read({buyer:b.f.buyer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:'INSUFFICIENT_SOL'});
 });
 it('binds source identity and returns defensive message bytes',async()=>{
  const {f,read}=await setup(),q=await read({buyer:f.buyer,spot:0,realm:0},{saleId}),bytes=q.messageBytes;bytes[0]=255;
  expect(q.messageBytes[0]).toBe(1);expect(q.source.revision).toBe('fixture-r1');expect(q.source.genesisHash).toBe(f.accessTrust.expectedGenesisHash);
  expect(q.source.programDataSha256).toBe(f.accessTrust.reviewedProgramDataSha256);expect(Object.isFrozen(q)).toBe(true);
 });
 it.each(['pause','quota','expiry','day','term','identity','payer'] as const)('rereads admission after async fee work: %s',async mutation=>{
  const {f,read}=await setup();f.controls.onFee=async()=>{
   if(mutation==='pause')f.models.authority.admission_paused=true;
   if(mutation==='quota')f.models.quota.sales=P.paidContractsPerSpotDayMax;
   if(mutation==='expiry')f.models.access.expires_at=f.controls.now+1n;
   if(mutation==='day')f.controls.now=(f.controls.now/D+1n)*D;
   if(mutation==='term')f.controls.now=f.models.term.operating_end;
   if(mutation==='identity')f.controls.genesisHash=new PublicKey(Buffer.alloc(32,29)).toBase58();
   if(mutation==='payer')f.controls.balance=1;
   await f.repack();
  };
  const codes={pause:'PAUSED',quota:'NO_QUOTA',expiry:'STALE',day:'STALE',term:'STALE',identity:'IDENTITY',payer:'INSUFFICIENT_SOL'};
  await expect(read({buyer:f.buyer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:codes[mutation]});
 });
 it('permits a fresh reduced quota balance while binding unchanged coverage and never exceeds100 RPC accounts',async()=>{
  const {f,read}=await setup();f.controls.onFee=async()=>{f.models.quota.sales=P.paidContractsPerSpotDayMax-1;await f.repack();};
  const q=await read({buyer:f.buyer,spot:0,realm:0},{saleId});expect(q.quotaRemaining).toBe(1);expect(f.reads.every(r=>r.length<=100)).toBe(true);expect(f.reads.some(r=>r.length===100)).toBe(true);
 });
 it('includes missing access and quota initialization atomically and exposes each exact rent cap',async()=>{
  const {f,read}=await setup();f.store.delete(f.addresses.access.toBase58());f.store.delete(f.addresses.quota.toBase58());
  const q=await read({buyer:f.buyer,spot:0,realm:0},{saleId});expect(Message.from(q.messageBytes).instructions).toHaveLength(3);expect(q.rents.map(r=>r.kind)).toEqual(['receipt','access','quota']);
  expect(q.rents.every(r=>r.existingLamports===0n&&r.minimumBalanceLamports===BigInt(f.controls.rent)&&r.lamports===BigInt(f.controls.rent))).toBe(true);
  expect(q.rentLamports).toBe(BigInt(f.controls.rent)*3n);expect(q.packetBytes).toBe(q.messageBytes.length+65);
 });
 it('refuses an account creation race requiring a different atomic message',async()=>{
  const {f,read}=await setup();f.store.delete(f.addresses.access.toBase58());f.controls.onFee=()=>f.repack();
  await expect(read({buyer:f.buyer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:'STALE'});
 });
 it.each(['buyer-seller','buyer-developer','all-equal'] as const)('uses aggregate role debit for %s without changing gross price',async alias=>{
  const {f,read}=await setup(),buyer=alias==='buyer-seller'?f.seller:f.developer,spot=alias==='all-equal'?1:0;
  f.store.get(buyer.toBase58())!.lamports=f.controls.balance;
  const q=await read({buyer,spot,realm:0},{saleId});expect(q.args.priceLamports).toBe(BigInt(P.permitPriceLamports));
  expect(q.paymentDebitLamports).toBe(alias==='all-equal'?0n:BigInt(P.permitPriceLamports)/2n);
 });
 it('clamps validity to the current UTC day and original term end',async()=>{
  for(const boundary of ['day','term']){
   const {f,read}=await setup();f.controls.now=boundary==='day'?(f.controls.now/D+1n)*D-10n:f.models.term.operating_end-10n;
   const q=await read({buyer:f.buyer,spot:0,realm:0},{saleId});expect(q.validUntil).toBe(boundary==='day'?(f.controls.now/D+1n)*D-1n:f.models.term.operating_end-1n);
  }
 });
 it.each(['fee','rent','height','context'] as const)('refuses unsafe, expired or regressing cost evidence: %s',async mutation=>{
  const {f,read}=await setup();if(mutation==='fee')f.controls.fee=Number.MAX_SAFE_INTEGER+1;if(mutation==='rent')f.controls.rent=-1;
  if(mutation==='height')f.controls.blockHeight=f.controls.lastValidBlockHeight+1;
  if(mutation==='context')f.rpc.getFeeForMessage=async()=>({context:{slot:f.controls.slot-1},value:5000});
  await expect(read({buyer:f.buyer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:'COST'});
 });
 it('rejects malformed quota, payer and immutable developer accounts',async()=>{
  for(const target of ['quota','payer','developer']){const {f,read}=await setup();const address=target==='quota'?f.addresses.quota:target==='payer'?f.buyer:f.developer;
   const row=f.store.get(address.toBase58())!;f.store.set(address.toBase58(),{...row,data:Buffer.from([1])});
   await expect(read({buyer:f.buyer,spot:0,realm:0},{saleId})).rejects.toThrow();
  }
 });
 it('treats only canonical empty System PDAs as init-needed and charges rent deficits',async()=>{
  const {f,read}=await setup();for(const address of [f.addresses.access,f.addresses.quota])f.store.set(address.toBase58(),{owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:1000,rentEpoch:0});
  const q=await read({buyer:f.buyer,spot:0,realm:0},{saleId});expect(Message.from(q.messageBytes).instructions).toHaveLength(3);
  for(const kind of ['access','quota']){const r=q.rents.find(r=>r.kind===kind)!;expect(r.existingLamports).toBe(1000n);expect(r.lamports).toBe(BigInt(f.controls.rent)-1000n);}
 });
 it('caps the whole operation and aborts hung cost reads without returning admission',async()=>{
  const f=await realmSaleQuoteFixture();f.rpc.getFeeForMessage=()=>new Promise(()=>{});
  const signals:AbortSignal[]=[];const read=createSeekerRealmSaleQuoteReader(signal=>{signals.push(signal);return f.rpc;},{term:f.termPolicy,access:f.accessTrust,revision:'fixture'},{deadlineMs:1000});
  await expect(read({buyer:f.buyer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:'DEADLINE'});expect(signals.every(s=>s.aborted)).toBe(true);
 });
 it('returns fresh argument keys/ID copies and binds the final Clock and message digest',async()=>{
  const {f,read}=await setup(),q=await read({buyer:f.buyer,spot:0,realm:0},{saleId});const a=q.args;a.saleId[0]=0;
  expect(q.args.saleId[0]).toBe(8);expect(q.args.seller).not.toBe(q.args.seller);expect(q.unixTimestamp).toBe(f.controls.now);expect(q.messageSha256).toMatch(/^[a-f0-9]{64}$/);
 });

 it('refuses contradictory duplicate-key rows in an aliased same-bank response',async()=>{
  const {f,read}=await setup();const get=f.rpc.getMultipleAccountsInfoAndContext.bind(f.rpc);
  f.rpc.getMultipleAccountsInfoAndContext=async(addresses,options)=>{const r=await get(addresses,options);const ids=addresses.map((a,i)=>a.equals(f.developer)?i:-1).filter(i=>i>=0);if(ids.length>1)r.value[ids.at(-1)!]!.lamports+=1;return r;};
  await expect(read({buyer:f.developer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:'ACCOUNTS'});
 });
 it('uses fresh prefunding after rent estimation to reduce the actual maximum debit',async()=>{
  const {f,read}=await setup();f.store.delete(f.addresses.access.toBase58());f.controls.onRent=async()=>{
   f.store.set(f.addresses.access.toBase58(),{owner:SystemProgram.programId,executable:false,data:Buffer.alloc(0),lamports:f.controls.rent,rentEpoch:0});
  };
  const q=await read({buyer:f.buyer,spot:0,realm:0},{saleId});const cap=q.rents.find(r=>r.kind==='access')!;expect(cap.existingLamports).toBe(BigInt(f.controls.rent));expect(cap.lamports).toBe(0n);
 });
 it('refuses missing provider and invalid trusted policy rather than inventing zero balances',async()=>{
  const f=await realmSaleQuoteFixture(),read=createSeekerRealmSaleQuoteReader(()=>{throw new Error('offline');},{term:f.termPolicy,access:f.accessTrust,revision:'r1'});
  await expect(read({buyer:f.buyer,spot:0,realm:0},{saleId})).rejects.toMatchObject({code:'TERM'});
  expect(()=>createSeekerRealmSaleQuoteReader(()=>f.rpc,{term:f.termPolicy,access:{...f.accessTrust,developer:PublicKey.default},revision:'r1'})).toThrow();
 });

});
