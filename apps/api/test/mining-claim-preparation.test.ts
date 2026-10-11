import { randomUUID } from 'node:crypto';
import { Keypair,PublicKey,VersionedMessage } from '@solana/web3.js';
import { describe,it,expect,vi } from 'vitest';
import { PHASE_E_MINING_PUBLICATION as POLICY,PHASE_E_MINING_CLAIM_QUOTE } from '@shardkeep/shared';
import { createMiningClaimFixture } from '../../../packages/chain/src/testFixtures/miningClaim';
import type { MiningClaimSnapshotReader } from '@shardkeep/chain/mining-claim-snapshot';
import { projectMiningClaimEntitlements } from '../src/mining/claimEntitlement';
import { createMiningClaimPreparer,type MiningClaimQuoteReader } from '../src/mining/claimPreparation';
import { withMiningClaimEntitlementFixture,type MiningClaimEntitlementFixture } from './fixtures/miningClaimEntitlement';
async function currentBank(f:MiningClaimEntitlementFixture,wallet=f.wallet){
 const bank=await createMiningClaimFixture({wallet:new PublicKey(wallet),day:'2020-01-01'});
 for(let i=0;i<8;i++)bank.rows[i]={...f.backing.rows[i]!,data:Buffer.from(f.backing.rows[i]!.data)};
 const clock=bank.rows[7]!.data as Buffer;clock.writeBigUInt64LE(3000n);clock.writeBigInt64LE(BigInt(f.prepared.publication.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec+POLICY.claimDelaySec),32);
 function sync(){bank.rows[0]=f.chain.accounts[0]!;bank.rows[8]=f.chain.accounts[2]!;bank.rows[9]=f.chain.accounts[1]!;}
 sync();
 for(const [i,which] of [[1,0],[2,1]] as const){// Classic SPL amount is the u64 at byte64. Keep all other serialized fields.
  (bank.rows[i]!.data as Buffer).writeBigUInt64LE(BigInt(f.chain.tx.meta!.postTokenBalances![which]!.uiTokenAmount.amount),64);}
 let reads=0;const reader:MiningClaimSnapshotReader={getGenesisHash:async()=>f.identity.genesisHash,getSlot:async()=>3000,getMultipleAccountsInfoAndContext:async()=>{reads++;return {context:{slot:3000},value:bank.rows};}};
 return {...bank,reader,trust:f.chain.trusted,sync,clock:(at:bigint)=>clock.writeBigInt64LE(at,32),reads:()=>reads,
  async config(change:Record<string,unknown>){Object.assign(f.chain.models[0]!,change);await f.chain.encode(0);sync();},
  async allocation(change:Record<string,unknown>){Object.assign(f.chain.models[2]!,change);await f.chain.encode(2);sync();}};
}
async function fixture(run:(f:MiningClaimEntitlementFixture,b:Awaited<ReturnType<typeof currentBank>>)=>Promise<void>){return withMiningClaimEntitlementFixture(async f=>{await f.settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});await run(f,await currentBank(f));});}
const now=new Date('2020-01-02T02:00:00.000Z');
function quote(genesis:string){let reads=0;const fees:Uint8Array[]=[],rentSpaces:number[]=[];const reader:MiningClaimQuoteReader={
 getGenesisHash:async()=>{reads++;return genesis;},getSlot:async()=>3002,getBlockHeight:async()=>200,
 getLatestBlockhashAndContext:async()=>({context:{slot:3001},value:{blockhash:new PublicKey(Buffer.alloc(32,89)).toBase58(),lastValidBlockHeight:250}}),
 getFeeForMessage:async(message)=>{fees.push(message.serialize());return {context:{slot:3002},value:5000};},
 getMinimumBalanceForRentExemption:async space=>{rentSpaces.push(space);return space*10;}};
 return {reader,fees,rentSpaces,reads:()=>reads};}
describe('durable unsigned mining claim preparation',()=>{
 it('pins exact claimant messages, every missing account rent and each message fee from real entitlement/current chain evidence',async()=>fixture(async(f,b)=>{
  b.rows[12]=null;const q=quote(f.identity.genesisHash),service=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader}),idempotencyKey=randomUUID();
  const result=await service.prepare(f.wallet,{idempotencyKey});expect(result).toMatchObject({wallet:f.wallet,idempotencyKey,state:'prepared',needsAta:true,needsMinerRecords:true,quoteVersion:PHASE_E_MINING_CLAIM_QUOTE.version,currentSigningAuthorized:false,claimSubmissionAuthorized:false});
  expect(result.transactions).toHaveLength(1);expect(result.transactions[0]!.kind).toBe('combined');expect(q.rentSpaces).toHaveLength(3);
  expect(BigInt(result.totalLamports)).toBe(5000n+BigInt(q.rentSpaces.reduce((a,v)=>a+v*10,0)));
  const bytes=Buffer.from(result.transactions[0]!.messageHex,'hex'),message=VersionedMessage.deserialize(bytes);
  expect(Buffer.from(q.fees[0]!)).toEqual(bytes);expect(message.header.numRequiredSignatures).toBe(1);expect(message.staticAccountKeys[0]!.toBase58()).toBe(f.wallet);expect(result.transactions[0]!.packetBytes).toBe(65+bytes.length);
  expect(await service.get(f.wallet,idempotencyKey)).toEqual(result);expect(await service.get(f.buyer,idempotencyKey)).toBeNull();
 }));
 it('quotes no duplicate rent for permanent records and an existing ATA',async()=>fixture(async(f,b)=>{
  await b.records();const q=quote(f.identity.genesisHash),service=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader});
  const result=await service.prepare(f.wallet,{idempotencyKey:randomUUID()});expect(result.transactions.map(x=>x.kind)).toEqual(['claim']);expect(result.rentLamports).toBe('0');expect(q.rentSpaces).toEqual([]);
 }));
 it('recovers the same immutable expired preparation after a lost reply, pause and source outage',async()=>fixture(async(f,b)=>{
  const q=quote(f.identity.genesisHash),idempotencyKey=randomUUID(),first=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader});
  const receipt=await first.prepare(f.wallet,{idempotencyKey});vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const reboot=createMiningClaimPreparer(f.conn.db,{...b,now:()=>new Date(+now+PHASE_E_MINING_CLAIM_QUOTE.ttlSec*2000),quoteSource:()=>{throw Error('offline');}});
  expect(await reboot.get(f.wallet,idempotencyKey)).toEqual(receipt);expect(await reboot.prepare(f.wallet,{idempotencyKey})).toEqual(receipt);
  await expect(reboot.prepare(f.wallet,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'DISABLED'});
 }));
 it('copies blockhash declarations before a provider reuses its response during fee reads',async()=>fixture(async(f,b)=>{
  const q=quote(f.identity.genesisHash),block=await q.reader.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:3000});
  q.reader.getLatestBlockhashAndContext=async()=>block;const fee=q.reader.getFeeForMessage;
  q.reader.getFeeForMessage=async(...args)=>{block.context.slot=1;block.value.lastValidBlockHeight=999;block.value.blockhash=Keypair.generate().publicKey.toBase58();return fee(...args);};
  const result=await createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader}).prepare(f.wallet,{idempotencyKey:randomUUID()});
  expect(result.blockhashContextSlot).toBe(3001);expect(result.lastValidBlockHeight).toBe(250);expect(result.blockhash).toBe(new PublicKey(Buffer.alloc(32,89)).toBase58());
 }));
 it('retains one wallet/key artifact through simultaneous fresh service preparations',async()=>fixture(async(f,b)=>{
  const q=quote(f.identity.genesisHash),idempotencyKey=randomUUID(),options={...b,now:()=>now,quoteSource:()=>q.reader};
  const [a,c]=await Promise.all([createMiningClaimPreparer(f.conn.db,options).prepare(f.wallet,{idempotencyKey}),createMiningClaimPreparer(f.conn.db,options).prepare(f.wallet,{idempotencyKey})]);
  expect(a).toEqual(c);expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(1);
 }));
 it('refuses reward delay and absent payer evidence before asking for fee quotes',async()=>fixture(async(f,b)=>{
  const q=quote(f.identity.genesisHash),service=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader});
  b.clock(BigInt(f.prepared.publication.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec));
  await expect(service.prepare(f.wallet,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'CLAIM_NOT_READY'});
  b.clock(BigInt(f.prepared.publication.day)*BigInt(POLICY.daySec)+BigInt(POLICY.daySec+POLICY.claimDelaySec));b.rows[13]=null;
  await expect(service.prepare(f.wallet,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'SOL_BALANCE_UNAVAILABLE'});expect(q.reads()).toBe(0);
 }));
 it('refuses insufficient claimant SOL without persisting a preparation or inventing sponsored fees',async()=>fixture(async(f,b)=>{
  b.rows[13]={...b.rows[13]!,lamports:1};const q=quote(f.identity.genesisHash),service=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader});
  await expect(service.prepare(f.wallet,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'INSUFFICIENT_SOL'});expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(0);
 }));
 it('rejects fee absence, unsafe estimates, stale contexts, expired blockhash and wrong-chain providers',async()=>fixture(async(f,b)=>{
  const patches:Partial<MiningClaimQuoteReader>[]=[{getFeeForMessage:async()=>({context:{slot:3002},value:null})},{getFeeForMessage:async()=>({context:{slot:3002},value:Number.MAX_SAFE_INTEGER+1})},{getFeeForMessage:async()=>({context:{slot:2999},value:1})},{getMinimumBalanceForRentExemption:async()=>-1},{getBlockHeight:async()=>251},{getSlot:async()=>3001},{getGenesisHash:async()=>Keypair.generate().publicKey.toBase58()}];
  for(const patch of patches){const q=quote(f.identity.genesisHash);Object.assign(q.reader,patch);const service=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader});await expect(service.prepare(f.wallet,{idempotencyKey:randomUUID()})).rejects.toMatchObject({name:'MiningClaimPreparationError'});}
  expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(0);
 }));
 it('rechecks admission after fee reads and rejects request fields that could select another reward',async()=>fixture(async(f,b)=>{
  const q=quote(f.identity.genesisHash),service=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader});
  await expect(service.prepare(f.wallet,{idempotencyKey:randomUUID(),wallet:f.buyer})).rejects.toMatchObject({code:'INVALID_INPUT'});expect(q.reads()).toBe(0);
  q.reader.getFeeForMessage=async()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','false');return {context:{slot:3002},value:5000};};
  await expect(service.prepare(f.wallet,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'DISABLED'});expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(0);
 }));
 it('fences a timed-out quote and prevents a late response from creating an artifact',async()=>fixture(async(f,b)=>{
  const q=quote(f.identity.genesisHash);let resume!:(v:{context:{slot:number};value:number})=>void,calls=0;const delayed=new Promise<{context:{slot:number};value:number}>(r=>{resume=r;});q.reader.getFeeForMessage=()=>{calls++;return delayed;};
  const service=createMiningClaimPreparer(f.conn.db,{...b,now:()=>now,quoteSource:()=>q.reader,timeoutMs:100}),idempotencyKey=randomUUID();
  await expect(service.prepare(f.wallet,{idempotencyKey})).rejects.toMatchObject({code:'TIMEOUT'});expect(calls).toBe(1);
  await expect(service.prepare(f.wallet,{idempotencyKey})).rejects.toMatchObject({code:'TIMEOUT'});expect(calls).toBe(1);resume({context:{slot:3002},value:5000});
  await new Promise(resolve=>setTimeout(resolve,20));expect(await service.get(f.wallet,idempotencyKey)).toBeNull();expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(0);
 }));
});
