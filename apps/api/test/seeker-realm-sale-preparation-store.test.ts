/** Unsigned quotes are durable consent records, never payment or current admission. */
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {describe,it,expect} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {realmSaleReceiptFixture} from '../../../packages/chain/src/testFixtures/seekerRealmSaleReceipt';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {getRealmSalePreparation,saveRealmSalePreparation,type RealmSalePreparation} from '../src/seeker/realmSalePreparationStore';
const migration=new URL('../drizzle/0182_seeker_realm_sale_preparations.sql',import.meta.url);
async function fixture(run:(f:{conn:ReturnType<typeof createDb>;url:URL;artifact:RealmSalePreparation})=>Promise<void>){
 const database=`realm_sale_prepare_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${database}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await admin.unsafe(`create database ${database}`);const conn=createDb(url.toString(),{max:4});
 try{
  for(const s of readFileSync(migration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  const f=await realmSaleReceiptFixture(),a=f.expected.args;
  const artifact:RealmSalePreparation={version:1,wallet:f.buyer.publicKey.toBase58(),idempotencyKey:randomUUID(),saleId:Buffer.from(a.saleId).toString('hex'),spot:a.spot,realm:a.realm,
   terms:{round:String(a.round),day:String(a.day),seller:a.seller.toBase58(),developer:a.developer.toBase58(),priorExpiry:String(a.priorExpiry),validAfter:String(a.validAfter),validUntil:String(a.validUntil)},
   source:{revision:'fixture-r1',genesisHash:new PublicKey(Buffer.alloc(32,9)).toBase58(),programId:f.expected.programId.toBase58(),programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:50,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:99,initialSlot:100,blockhashSlot:100,feeSlot:100,costSlot:100,admissionSlot:100},
   quote:{blockhash:f.expected.blockhash,lastValidBlockHeight:300,unixTimestamp:String(a.validAfter),needsAccess:true,needsQuota:true,quotaRemaining:10,
    messageHex:Buffer.from(f.plan.messageBytes).toString('hex'),messageSha256:f.plan.messageSha256,packetBytes:f.plan.packetBytes,
    rents:f.plan.expectedNewAccounts.map(r=>({address:r.address,space:r.space,minimumBalanceLamports:'1000000',existingLamports:'0',maxIncreaseLamports:'1000000'})),
    feeLamports:'5000',rentLamports:'3000000',paymentDebitLamports:String(f.plan.buyerNetPaymentLamports),requiredLamports:String(f.plan.buyerNetPaymentLamports+3005000n),payerLamports:'100000000'},
   state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false};
  await run({conn,url,artifact});
 }finally{await conn.sql.end();await admin.unsafe(`drop database ${database} with (force)`);await admin.end();}
}
describe('immutable actor-scoped realm sale preparation',()=>{
 it('recovers the exact original quote across reconnect without depending on current flags or RPC',async()=>fixture(async({conn,url,artifact:a})=>{
  const key={wallet:a.wallet,idempotencyKey:a.idempotencyKey};expect(await getRealmSalePreparation(conn.db,key)).toBeNull();expect(await saveRealmSalePreparation(conn.db,a)).toEqual(a);
  const second=createDb(url.toString());try{expect(await getRealmSalePreparation(second.db,key)).toEqual(a);}finally{await second.sql.end();}
  expect(await getRealmSalePreparation(conn.db,{...key,wallet:new PublicKey(Buffer.alloc(32,11)).toBase58()})).toBeNull();
 }));
 it('keeps one same-key winner under parallel retry and refuses reparenting the requested spot or realm',async()=>fixture(async({conn,artifact:a})=>{
  const [one,two]=await Promise.all([saveRealmSalePreparation(conn.db,a),saveRealmSalePreparation(conn.db,{...a,source:{...a.source,revision:'other-observation'}})]);expect(one).toEqual(two);
  // A directly inserted actor-key with altered request must not mask the original.
  await expect(saveRealmSalePreparation(conn.db,{...a,realm:1})).rejects.toMatchObject({code:expect.any(String)});
  expect(await conn.sql`select sale_id from seeker_realm_sale_preparations`).toHaveLength(1);
 }));
 it('rebuilds exact instructions and rejects forged recipients, costs, rents, packet and provenance order',async()=>fixture(async({conn,artifact:a})=>{
  const variants=[{...a,terms:{...a.terms,seller:a.wallet}},{...a,quote:{...a.quote,requiredLamports:'1'}},{...a,quote:{...a.quote,packetBytes:1233}},{...a,quote:{...a.quote,rents:[...a.quote.rents].reverse()}},{...a,source:{...a.source,admissionSlot:99}},{...a,quote:{...a.quote,unixTimestamp:a.terms.validUntil+'0'}},{...a,saleId:'00'.repeat(16)},{...a,wallet:'x'.repeat(10000)},{...a,currentSigningAuthorized:true}];
  for(const v of variants)await expect(saveRealmSalePreparation(conn.db,v as RealmSalePreparation)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(await conn.sql`select sale_id from seeker_realm_sale_preparations`).toHaveLength(0);
 }));
 it('audits recovery bytes even when a stored message hash was recomputed',async()=>fixture(async({conn,artifact:a})=>{
  const b=Buffer.from(a.quote.messageHex,'hex');b[b.length-1]=b[b.length-1]!^1;const bad={...a,quote:{...a.quote,messageHex:b.toString('hex'),messageSha256:createHash('sha256').update(b).digest('hex')}};
  await conn.sql`insert into seeker_realm_sale_preparations(artifact) values(${JSON.stringify(bad)}::jsonb)`;
  await expect(getRealmSalePreparation(conn.db,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('bounds SQL artifacts, derives identities and forbids mutation even with accidental broad grants',async()=>fixture(async({conn,artifact:a})=>{
  const role=`realm_prepare_${randomUUID().replaceAll('-','')}`;await conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select,insert on seeker_realm_sale_preparations to ${role}`);
  try{
   await conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await saveRealmSalePreparation(tx,a)).toEqual(a);});
   await conn.sql.unsafe(`grant all on seeker_realm_sale_preparations to ${role}`);
   for(const command of ['delete from seeker_realm_sale_preparations','update seeker_realm_sale_preparations set artifact=artifact','truncate seeker_realm_sale_preparations'])await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(command);})).rejects.toThrow('REALM_SALE_PREPARATION_IMMUTABLE');
   await expect(conn.sql`insert into seeker_realm_sale_preparations(wallet,artifact) values(${a.wallet},${JSON.stringify({...a,idempotencyKey:randomUUID()})}::jsonb)`).rejects.toThrow('REALM_SALE_PREPARATION_DERIVED');
   await expect(conn.sql`insert into seeker_realm_sale_preparations(artifact) values(${JSON.stringify({...a,extra:'x'.repeat(32769)})}::jsonb)`).rejects.toThrow('REALM_SALE_PREPARATION_INPUT');
  }finally{await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('survives repeated additive migration and prevents one on-chain sale ID being reassigned',async()=>fixture(async({conn,artifact:a})=>{
  await saveRealmSalePreparation(conn.db,a);for(let i=0;i<2;i++)for(const s of readFileSync(migration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  expect(await getRealmSalePreparation(conn.db,{wallet:a.wallet,idempotencyKey:a.idempotencyKey})).toEqual(a);
  await expect(saveRealmSalePreparation(conn.db,{...a,idempotencyKey:randomUUID()})).rejects.toThrow();
 }));
});
