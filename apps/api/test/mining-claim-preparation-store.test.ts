import { createHash,randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair,PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { describe,it,expect,vi } from 'vitest';
import { PHASE_E_MINING_CLAIM_QUOTE as QUOTE } from '@shardkeep/shared';
import { buildMiningClaimMessages } from '@shardkeep/chain/mining-claim-message';
import { decodeMiningAllocationLeaf,decodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { createDb } from '../src/db/client';
import { projectMiningClaimEntitlements,createMiningClaimEntitlementReader } from '../src/mining/claimEntitlement';
import { getMiningClaimPreparation,saveMiningClaimPreparation,type MiningClaimPreparation } from '../src/mining/claimPreparationStore';
import { withMiningClaimEntitlementFixture } from './fixtures/miningClaimEntitlement';
async function fixture(run:(f:Parameters<Parameters<typeof withMiningClaimEntitlementFixture>[0]>[0],a:MiningClaimPreparation)=>Promise<void>){return withMiningClaimEntitlementFixture(async f=>{
 await f.settle();await projectMiningClaimEntitlements(f.conn.db,{epochId:f.epochId});const e=await createMiningClaimEntitlementReader(f.conn.db,f.identity)(f.wallet);if(e.kind!=='entitlement')throw Error('Missing fixture entitlement');
 const blockhash=Keypair.generate().publicKey.toBase58(),h=e.header;
 const plan=buildMiningClaimMessages({programId:new PublicKey(h.programId),keepMint:new PublicKey(h.keepMint),reserveOwner:new PublicKey(h.reserveOwner)},{wallet:new PublicKey(f.wallet),root:Buffer.from(h.root,'hex'),sequence:1n,day:BigInt(h.day),totalCumulative:BigInt(h.totalCumulative),leaf:decodeMiningAllocationLeaf(Buffer.from(e.leafHex,'hex')),proof:decodeMiningAllocationProof(Buffer.from(e.proofHex,'hex')),blockhash,needsAta:true,needsMinerRecords:true});
 const transactions=plan.transactions.map(t=>({kind:t.kind,messageHex:Buffer.from(t.messageBytes).toString('hex'),messageSha256:t.messageSha256,packetBytes:t.packetBytes,feeLamports:'5000',rentLamports:t.expectedNewAccounts.length?'1000':'0'}));
 const fee=transactions.reduce((n,t)=>n+BigInt(t.feeLamports),0n),rent=transactions.reduce((n,t)=>n+BigInt(t.rentLamports),0n),preparedAt='2026-09-25T12:00:00.000Z';
 await run(f,{claimId:randomUUID(),wallet:f.wallet,idempotencyKey:randomUUID(),header:h,leafHex:e.leafHex,proofHex:e.proofHex,needsAta:true,needsMinerRecords:true,quoteVersion:QUOTE.version,preparedAt,expiresAt:new Date(Date.parse(preparedAt)+QUOTE.ttlSec*1000).toISOString(),snapshotSlot:2100,blockhashContextSlot:2101,blockhash,lastValidBlockHeight:2300,payerBalanceLamports:'10000000',feeLamports:String(fee),rentLamports:String(rent),totalLamports:String(fee+rent),transactions,state:'prepared',currentSigningAuthorized:false,claimSubmissionAuthorized:false});
});}
describe('durable wallet claim preparation',()=>{
 it('recovers the original artifact after pause/reconnect without changing its quote or blockhash',async()=>fixture(async(f,a)=>{
  expect(await getMiningClaimPreparation(f.conn.db,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).toBeNull();const saved=await saveMiningClaimPreparation(f.conn.db,a);vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  f.chain.reader.getGenesisHash=async()=>{throw Error('offline');};expect(await saveMiningClaimPreparation(f.conn.db,{...a,claimId:randomUUID(),preparedAt:'2026-09-26T12:00:00.000Z',expiresAt:new Date(Date.parse('2026-09-26T12:00:00Z')+QUOTE.ttlSec*1000).toISOString()})).toEqual(saved);
  const c=createDb(f.url.toString());try{expect(await getMiningClaimPreparation(c.db,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).toEqual(saved);}finally{await c.sql.end();}
  expect(await getMiningClaimPreparation(f.conn.db,{wallet:f.buyer,idempotencyKey:a.idempotencyKey})).toBeNull();
 }));
 it('persists exactly one parallel same-key winner and keeps distinct keys independent',async()=>fixture(async(f,a)=>{
  const b={...a,claimId:randomUUID()};const [x,y]=await Promise.all([saveMiningClaimPreparation(f.conn.db,a),saveMiningClaimPreparation(f.conn.db,b)]);expect(x).toEqual(y);
  const second={...a,claimId:randomUUID(),idempotencyKey:randomUUID()};expect(await saveMiningClaimPreparation(f.conn.db,second)).toEqual(second);expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(2);
 }));
 it('rejects forged source/proof, canonical-message drift and unsafe quote arithmetic',async()=>fixture(async(f,a)=>{
  for(const bad of [{...a,header:{...a.header,root:'00'.repeat(32)}},{...a,wallet:f.buyer},{...a,wallet:'x'.repeat(10000)},{...a,blockhash:'0'.repeat(44)},{...a,leafHex:'02'+'00'.repeat(64)},{...a,totalLamports:'1'},{...a,expiresAt:a.preparedAt},{...a,feeLamports:'9'.repeat(10000)},{...a,transactions:a.transactions.map(t=>({...t,messageSha256:'00'.repeat(32)}))}])await expect(saveMiningClaimPreparation(f.conn.db,bad)).rejects.toMatchObject({code:expect.stringMatching(/INVALID_INPUT|SOURCE_CONFLICT/)});
  expect(await f.conn.sql`select claim_id from mining_claim_preparations`).toHaveLength(0);
 }));
 it('works with only runtime projection/preparation grants while SQL rejects source forgery and mutation',async()=>fixture(async(f,a)=>{
  const role=`claim_prepare_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on mining_claim_entitlement_headers,mining_claim_entitlement_leaves to ${role};grant select,insert on mining_claim_preparations to ${role}`);
  try{await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await saveMiningClaimPreparation(tx,a)).toEqual(a);expect(await getMiningClaimPreparation(tx,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).toEqual(a);});
   const bad={...a,claimId:randomUUID(),idempotencyKey:randomUUID(),header:{...a.header,sourceHash:'00'.repeat(32)}};
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_claim_preparations(artifact) values(${JSON.stringify(bad)}::jsonb)`;})).rejects.toThrow('MINING_CLAIM_PREPARATION_SOURCE');
   await f.conn.sql.unsafe(`grant all on mining_claim_preparations to ${role}`);
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`delete from mining_claim_preparations`;})).rejects.toThrow('MINING_CLAIM_PREPARATION_IMMUTABLE');
   await expect(f.conn.sql`update mining_claim_preparations set artifact=artifact`).rejects.toThrow('MINING_CLAIM_PREPARATION_IMMUTABLE');// Include dependent receipt tables so this tests the immutable trigger, not only PostgreSQL's FK restriction.
   await expect(f.conn.sql`truncate mining_claim_preparations cascade`).rejects.toThrow('MINING_CLAIM_PREPARATION_IMMUTABLE');
   expect(await getMiningClaimPreparation(f.conn.db,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).toEqual(a);
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('preserves exact receipts through repeat migration and rejects repeatable-read insert',async()=>fixture(async(f,a)=>{
  await saveMiningClaimPreparation(f.conn.db,a);const migration=readFileSync(new URL('../drizzle/0173_mining_claim_preparations.sql',import.meta.url),'utf8');for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const s of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(s);});expect(await getMiningClaimPreparation(f.conn.db,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).toEqual(a);
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_claim_preparations(artifact) values(${JSON.stringify({...a,claimId:randomUUID(),idempotencyKey:randomUUID()})}::jsonb)`;})).rejects.toThrow('MINING_CLAIM_PREPARATION_READ_COMMITTED');
 }));
 it('audits a saved self-consistent hash instead of returning a substituted unsigned message',async()=>fixture(async(f,a)=>{
  const bad={...a,transactions:a.transactions.map(t=>{const bytes=Buffer.from(t.messageHex,'hex');bytes[bytes.length-1]=bytes[bytes.length-1]!^1;return {...t,messageHex:bytes.toString('hex'),messageSha256:createHash('sha256').update(bytes).digest('hex')};})};
  // SQL retains the own immutable leaf and a bounded hashed artifact. The
  // recovery boundary must still rebuild its exact allowed instructions.
  await f.conn.sql`insert into mining_claim_preparations(artifact) values(${JSON.stringify(bad)}::jsonb)`;
  await expect(getMiningClaimPreparation(f.conn.db,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
});
