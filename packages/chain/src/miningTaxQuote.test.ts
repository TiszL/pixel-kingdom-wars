import {Keypair,Message} from '@solana/web3.js';
import {describe,expect,it} from 'vitest';
import {createMiningTaxSnapshotFixture} from './testFixtures/miningTaxSnapshot';
import {createMiningTaxQuoteReader,type MiningTaxQuoteRpc} from './miningTaxQuote';

const caps={maxFeeLamports:10_000n,maxRentLamports:100_000n,maxTotalLamports:110_000n};
async function fixture(){
 const f=await createMiningTaxSnapshotFixture();f.models.cursor.claimed_total=0n;await f.encode('cursor');
 const control={fee:5000 as number|null,rent:10_000,height:100,lastHeight:200,slot:2000,feeSlot:2000,blockhash:Keypair.generate().publicKey.toBase58(),afterFee:async()=>{}};
 const messages:string[]=[],rents:number[]=[],signals:AbortSignal[]=[];
 const rpc:MiningTaxQuoteRpc={...f.rpc,
  getLatestBlockhashAndContext:async()=>({context:{slot:control.slot},value:{blockhash:control.blockhash,lastValidBlockHeight:control.lastHeight}}),
  getFeeForMessage:async(message)=>{messages.push(Buffer.from(message.serialize()).toString('hex'));await control.afterFee();return {context:{slot:control.feeSlot},value:control.fee};},
  getMinimumBalanceForRentExemption:async(space)=>{rents.push(space);return control.rent;},getBlockHeight:async()=>control.height,
 };
 const connect=(s:AbortSignal)=>{signals.push(s);return rpc;};
 const read=createMiningTaxQuoteReader(connect,f.trust);
 return {f,control,rpc,read,connect,messages,rents,signals,input:{...f.request,caps:{...caps}}};
}
describe('finalized original KEEP tax quotes',()=>{
 it('quotes the original expired-term delta with exact finalized message costs and no signing authority',async()=>{
  const a=await fixture(),q=await a.read(a.input);
  expect(q.plan.expectedClaimBaseUnits).toBe(3n);expect(q.costs.totalLamports).toBe(5000n);
  expect(q.snapshot.chainClock.unixTimestamp).toBeGreaterThan(a.f.term.operatingEnd);
  expect(a.messages).toEqual(q.plan.transactions.map(t=>Buffer.from(t.messageBytes).toString('hex')));
  expect(q.blockhash).toBe(a.control.blockhash);expect(q.lastValidBlockHeight).toBe(200);
  expect(q.signingAuthorized).toBe(false);expect(q.broadcastAuthorized).toBe(false);
  expect(q.source.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);expect(Object.isFrozen(q)).toBe(true);
  const tx=q.plan.transactions[0]!,original=tx.messageBytes;tx.messageBytes.fill(0);expect(tx.messageBytes).toEqual(original);
  expect(Message.from(tx.messageBytes).accountKeys[0]!.toBase58()).toBe(a.f.wallet.toBase58());
 });
 it('charges exactly the missing-account roster and retains quote caps',async()=>{
  const a=await fixture();for(const k of ['pool','cursor','accrual','ata'] as const)a.f.store.delete(a.f.addresses[k].toBase58());
  const q=await a.read(a.input);expect(q.plan.transactions[0]!.expectedNewAccounts).toHaveLength(4);
  expect(q.costs.rentLamports).toBe(40_000n);expect(q.measurements[0]!.rents.map(r=>r.space)).toEqual(a.rents);
  expect(q.caps).toEqual(caps);expect(Object.isFrozen(q.measurements[0]!.rents)).toBe(true);
 });
 it.each(['fee-null','fee-negative','fee-unsafe','rent-negative','height-expired','height-unsafe','blockhash','block-context','fee-context','fee-cap','rent-cap','total-cap'] as const)('refuses incomplete or over-budget %s',async kind=>{
  const a=await fixture();
  if(kind==='fee-null')a.control.fee=null;if(kind==='fee-negative')a.control.fee=-1;if(kind==='fee-unsafe')a.control.fee=Number.MAX_SAFE_INTEGER+1;
  if(kind==='rent-negative'||kind==='rent-cap'){a.f.store.delete(a.f.addresses.ata.toBase58());if(kind==='rent-negative')a.control.rent=-1;else a.input.caps.maxRentLamports=1n;}
  if(kind==='height-expired')a.control.height=201;if(kind==='height-unsafe')a.control.height=NaN;if(kind==='blockhash')a.control.blockhash='bad';
  if(kind==='block-context')a.control.slot=1999;if(kind==='fee-context')a.control.feeSlot=1999;
  if(kind==='fee-cap')a.input.caps.maxFeeLamports=4999n;if(kind==='total-cap')a.input.caps.maxTotalLamports=4999n;
  await expect(a.read(a.input)).rejects.toThrow();
 });
 it.each(['claimed','paused','payer','ata-created','genesis','fee-bank-ahead'] as const)('rechecks original rights and solvency after asynchronous quote work: %s',async kind=>{
  const a=await fixture();const ata=a.f.store.get(a.f.addresses.ata.toBase58())!;if(kind==='ata-created')a.f.store.delete(a.f.addresses.ata.toBase58());
  a.control.afterFee=async()=>{
   if(kind==='claimed'){a.f.models.cursor.claimed_total=1n;await a.f.encode('cursor');}
   if(kind==='paused'){a.f.backing.model.flags=1;await a.f.config();}
   if(kind==='payer')a.f.store.get(a.f.wallet.toBase58())!.lamports=1;
   if(kind==='ata-created')a.f.store.set(a.f.addresses.ata.toBase58(),ata);
   if(kind==='genesis')a.rpc.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
   if(kind==='fee-bank-ahead')a.control.feeSlot=2001;
  };
  await expect(a.read(a.input)).rejects.toThrow();
 });
 it('copies caller identity/caps before awaiting and uses fresh solvent payer balance',async()=>{
  const a=await fixture();a.control.afterFee=async()=>{a.input.spot=21;a.input.caps.maxTotalLamports=0n;a.f.store.get(a.f.wallet.toBase58())!.lamports=6000;};
  const q=await a.read(a.input);expect(q.plan.spot).toBe(0);expect(q.caps).toEqual(caps);expect(q.plan.payerBalanceLamports).toBe(6000n);
 });
 it('refuses provider failure, unknown fields and invalid limits without creating authority',async()=>{
  const a=await fixture();await expect(a.read({...a.input,amount:1n} as never)).rejects.toMatchObject({code:'INPUT'});
  expect(()=>createMiningTaxQuoteReader(a.connect,a.f.trust,{maxPending:33})).toThrow();
  expect(()=>createMiningTaxQuoteReader(a.connect,a.f.trust,{timeoutMs:30_001})).toThrow();
  const r=createMiningTaxQuoteReader(()=>{throw Error('offline');},a.f.trust);await expect(r(a.input)).rejects.toMatchObject({code:'UNAVAILABLE'});
 });
 it('keeps the bounded slot occupied until a timed-out transport actually drains',async()=>{
  const a=await fixture();let release!:(v:{context:{slot:number};value:number})=>void,entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r;});a.rpc.getFeeForMessage=()=>{entered();return new Promise(r=>{release=r;});};
  const read=createMiningTaxQuoteReader(a.connect,a.f.trust,{timeoutMs:1000,maxPending:1});
  const first=read(a.input),failure=expect(first).rejects.toMatchObject({code:'TIMEOUT'});await started;await failure;
  expect(a.signals.every(s=>s.aborted)).toBe(true);await expect(read(a.input)).rejects.toMatchObject({code:'BUSY'});
  release({context:{slot:2000},value:5000});await new Promise(r=>setTimeout(r,0));
  a.rpc.getFeeForMessage=async()=>({context:{slot:2000},value:5000});expect((await read(a.input)).costs.feeLamports).toBe(5000n);
 });
});
