import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {describe,it,expect,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {createMiningClaimFailure,getMiningClaimFailure} from '../src/mining/claimFailure';
import {createMiningClaimSettlement} from '../src/mining/claimSettlement';
import {withMiningClaimSettlementFixture as fixture,type MiningClaimSettlementFixture} from './fixtures/miningClaimSettlement';
function failed(f:MiningClaimSettlementFixture){
 const meta=f.tx.meta!;return {...f.tx,meta:{...meta,err:{InstructionError:[f.tx.transaction.message.compiledInstructions.length-1,{Custom:6000}]},postBalances:meta.preBalances.map((n,i)=>i===0?n-meta.fee:n),postTokenBalances:structuredClone(meta.preTokenBalances!)}};
}
const key=(f:MiningClaimSettlementFixture)=>({wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0});
const source=(f:MiningClaimSettlementFixture)=>({reader:{...f.receiptReader,getTransaction:async()=>failed(f)},trust:f.trust});
describe('owner-verified failed mining claim recovery',()=>{
 it('retains exact failed wire without payment and recovers after pause and reconnect',async()=>fixture(async f=>{
  const k=key(f),record=await createMiningClaimFailure(f.conn.db,source(f))(k);
  expect(record).toMatchObject({...k,signature:f.signed.signature,claimFailed:true,receipt:{outcome:'failed',paymentAuthorized:false,slot:3004}});
  expect(record.receipt).not.toHaveProperty('paidKeepBaseUnits');expect(await f.conn.sql`select * from mining_claim_receipts`).toHaveLength(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const other=createDb(f.url.toString());try{expect(await getMiningClaimFailure(other.db,k)).toEqual(record);
   expect(await createMiningClaimFailure(other.db,{...source(f),reader:{...f.receiptReader,getTransaction:async()=>{throw Error('offline');}}})(k)).toEqual(record);
  }finally{await other.sql.end();}expect(await getMiningClaimFailure(f.conn.db,{...k,wallet:f.buyer})).toBeNull();
 }));
 it('requires a fresh observed blockhash before a failed message can be prepared again',async()=>fixture(async f=>{
  await createMiningClaimFailure(f.conn.db,source(f))(key(f));const idempotencyKey=randomUUID();
  f.quote.reader.getLatestBlockhashAndContext=async()=>({context:{slot:3003},value:{blockhash:f.preparedClaim.blockhash,lastValidBlockHeight:250}});
  f.quote.reader.getFeeForMessage=async()=>({context:{slot:3003},value:5000});f.quote.reader.getSlot=async()=>3003;
  await expect(f.claimService.prepare(f.wallet,{idempotencyKey})).rejects.toMatchObject({code:'CLAIM_BLOCKHASH_REUSED'});
  expect(await f.claimService.get(f.wallet,idempotencyKey)).toBeNull();
  const blockhash=Keypair.generate().publicKey.toBase58();f.quote.reader.getLatestBlockhashAndContext=async()=>({context:{slot:3003},value:{blockhash,lastValidBlockHeight:250}});
  const fresh=await f.claimService.prepare(f.wallet,{idempotencyKey:randomUUID()});expect(fresh.blockhash).toBe(blockhash);expect(fresh.claimId).not.toBe(f.preparedClaim.claimId);
  expect(await getMiningClaimFailure(f.conn.db,key(f))).not.toBeNull();expect(await f.conn.sql`select * from mining_claim_signed_wires`).toHaveLength(1);
 }));
 it('missing history, a successful transfer with an error flag and malformed failure evidence cannot close the claim',async()=>fixture(async f=>{
  const reader={...f.receiptReader,getTransaction:async()=>null as typeof f.tx|null},verify=createMiningClaimFailure(f.conn.db,{reader,trust:f.trust});
  await expect(verify(key(f))).rejects.toMatchObject({code:'RECEIPT_UNAVAILABLE'});
  reader.getTransaction=async()=>({...f.tx,meta:{...f.tx.meta!,err:{InstructionError:[0,'InvalidArgument']}}});
  await expect(verify(key(f))).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
  reader.getTransaction=async()=>({...failed(f),transaction:{...f.tx.transaction,signatures:[]}});
  await expect(verify(key(f))).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});expect(await getMiningClaimFailure(f.conn.db,key(f))).toBeNull();
 }));
 it('serializes opposing successful and failed terminal observations on the original signed row',async()=>fixture(async f=>{
  const results=await Promise.allSettled([createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.trust})(key(f)),createMiningClaimFailure(f.conn.db,source(f))(key(f))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const rows=await f.conn.sql`select claim_id from mining_claim_receipts union all select claim_id from mining_claim_failures`;expect(rows).toHaveLength(1);
  expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(1);
 }));
 it('blocks runtime forgery even with accidental grants, and leaves read-only paused recovery available',async()=>fixture(async f=>{
  const role=`claim_failure_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));await expect(createMiningClaimFailure(tx,source(f))(key(f))).rejects.toMatchObject({code:'OWNER_REQUIRED'});});
   const record=await createMiningClaimFailure(f.conn.db,source(f))(key(f));
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_claim_failures(claim_id,ordinal,receipt) values(${record.claimId},0,${JSON.stringify(record.receipt)}::jsonb)`;})).rejects.toThrow('MINING_CLAIM_FAILURE_OWNER_REQUIRED');
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await getMiningClaimFailure(tx,key(f))).toEqual(record);});
   await expect(f.conn.sql`update mining_claim_failures set receipt=receipt`).rejects.toThrow('MINING_CLAIM_FAILURE_IMMUTABLE');
   await expect(f.conn.sql`delete from mining_claim_failures`).rejects.toThrow('MINING_CLAIM_FAILURE_IMMUTABLE');
   await expect(f.conn.sql`truncate mining_claim_failures`).rejects.toThrow('MINING_CLAIM_FAILURE_IMMUTABLE');
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('does not commit after timeout and holds its unfinished reader until drain',async()=>fixture(async f=>{
  let resolve!:(v:typeof f.tx)=>void;const pending=new Promise<typeof f.tx>(r=>{resolve=r;});
  const reader={...f.receiptReader,getTransaction:()=>pending},verify=createMiningClaimFailure(f.conn.db,{reader,trust:f.trust,timeoutMs:30});
  await expect(verify(key(f))).rejects.toMatchObject({code:'TIMEOUT'});await expect(verify(key(f))).rejects.toMatchObject({code:'BUSY'});resolve(failed(f));
  await vi.waitFor(async()=>{expect(await getMiningClaimFailure(f.conn.db,key(f))).toBeNull();});
  reader.getTransaction=async()=>f.tx;await vi.waitFor(async()=>{await expect(verify(key(f))).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});});
  expect(await f.conn.sql`select * from mining_claim_failures`).toHaveLength(0);
 }));
 it('rejects prefilled metadata and wrong source, preserves history through migration replay and forbids weaker isolation',async()=>fixture(async f=>{
  const record=await createMiningClaimFailure(f.conn.db,source(f))(key(f));
  await expect(f.conn.sql`insert into mining_claim_failures(claim_id,ordinal,wallet,receipt) values(${record.claimId},0,${f.wallet},${JSON.stringify(record.receipt)}::jsonb)`).rejects.toThrow('MINING_CLAIM_FAILURE_DERIVED');
  await expect(f.conn.sql`insert into mining_claim_failures(claim_id,ordinal,receipt) values(${record.claimId},0,${JSON.stringify({...record.receipt,source:{...record.receipt.source,sourceHash:'0'.repeat(64)}})}::jsonb)`).rejects.toThrow('MINING_CLAIM_FAILURE_SOURCE');
  const migration=readFileSync(new URL('../drizzle/0176_mining_claim_failures.sql',import.meta.url),'utf8');for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const s of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(s);});
  expect(await getMiningClaimFailure(f.conn.db,key(f))).toEqual(record);
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_claim_failures(claim_id,ordinal,receipt) values(${record.claimId},0,${JSON.stringify(record.receipt)}::jsonb)`;})).rejects.toThrow('MINING_CLAIM_FAILURE_READ_COMMITTED');
 }));
});
