/** Unsigned quotes are durable consent records, never payment or current admission. */
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {describe,it,expect,vi} from 'vitest';
import {PublicKey,Keypair} from '@solana/web3.js';
import {realmSaleFinalityFixture} from '../../../packages/chain/src/testFixtures/seekerRealmSaleFinality';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {saveRealmSalePreparation,type RealmSalePreparation} from '../src/seeker/realmSalePreparationStore';
import {acceptRealmSaleSigned,getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
import {createRealmSaleSettlement,getRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
const settlementMigration=new URL('../drizzle/0184_seeker_realm_sale_receipts.sql',import.meta.url);
const signedMigration=new URL('../drizzle/0183_seeker_realm_sale_signed.sql',import.meta.url);
const migration=new URL('../drizzle/0182_seeker_realm_sale_preparations.sql',import.meta.url);
async function fixture(run:(f:{conn:ReturnType<typeof createDb>;url:URL;artifact:RealmSalePreparation;signedTransaction:Uint8Array;buyer:Keypair;chain:Awaited<ReturnType<typeof realmSaleFinalityFixture>>})=>Promise<void>,quotedFeeLamports=5000n){
 const database=`realm_sale_settle_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${database}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await admin.unsafe(`create database ${database}`);const conn=createDb(url.toString(),{max:4});
 try{
  for(const s of readFileSync(migration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  for(const s of readFileSync(signedMigration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  for(const s of readFileSync(settlementMigration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  const f=await realmSaleFinalityFixture(),a=f.expected.args;
  const artifact:RealmSalePreparation={version:1,wallet:f.buyer.publicKey.toBase58(),idempotencyKey:randomUUID(),saleId:Buffer.from(a.saleId).toString('hex'),spot:a.spot,realm:a.realm,
   terms:{round:String(a.round),day:String(a.day),seller:a.seller.toBase58(),developer:a.developer.toBase58(),priorExpiry:String(a.priorExpiry),validAfter:String(a.validAfter),validUntil:String(a.validUntil)},
   source:{revision:'fixture-r1',genesisHash:f.trust.expectedGenesisHash,programId:f.expected.programId.toBase58(),programDataSha256:f.trust.reviewedProgramDataSha256,reviewedDeploymentSlot:f.trust.reviewedDeploymentSlot,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:99,initialSlot:100,blockhashSlot:100,feeSlot:100,costSlot:100,admissionSlot:100},
   quote:{blockhash:f.expected.blockhash,lastValidBlockHeight:300,unixTimestamp:String(a.validAfter),needsAccess:true,needsQuota:true,quotaRemaining:10,
    messageHex:Buffer.from(f.plan.messageBytes).toString('hex'),messageSha256:f.plan.messageSha256,packetBytes:f.plan.packetBytes,
    rents:f.plan.expectedNewAccounts.map(r=>({address:r.address,space:r.space,minimumBalanceLamports:'1000000',existingLamports:'0',maxIncreaseLamports:'1000000'})),
    feeLamports:String(quotedFeeLamports),rentLamports:'3000000',paymentDebitLamports:String(f.plan.buyerNetPaymentLamports),requiredLamports:String(f.plan.buyerNetPaymentLamports+3000000n+quotedFeeLamports),payerLamports:'100000000'},
   state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false};
  await saveRealmSalePreparation(conn.db,artifact);await acceptRealmSaleSigned(conn.db,{wallet:artifact.wallet,idempotencyKey:artifact.idempotencyKey,signedTransaction:f.expected.signedTransaction});
  await run({conn,url,artifact,signedTransaction:f.expected.signedTransaction,buyer:f.buyer,chain:f});
 }finally{await conn.sql.end();await admin.unsafe(`drop database ${database} with (force)`);await admin.end();}
}
const key=(a:RealmSalePreparation)=>({wallet:a.wallet,idempotencyKey:a.idempotencyKey});
describe('owner-verified immutable realm sale success',()=>{
 it('persists and recovers a lower actual fee within the original approved maximum',async()=>fixture(async({conn,url,artifact:a,chain:f})=>{
  const settle=createRealmSaleSettlement(conn.db,{connect:()=>f.rpc,trust:f.trust}),saved=await settle(key(a));
  expect(a.quote.feeLamports).toBe('6000');expect(saved.receipt.feeLamports).toBe('5000');
  expect(BigInt(saved.receipt.actualRentLamports)+BigInt(saved.receipt.feeLamports)+BigInt(saved.receipt.buyerNetPaymentLamports)).toBeLessThan(BigInt(a.quote.requiredLamports));
  const second=createDb(url.toString());try{expect(await getRealmSaleSettlement(second.db,key(a))).toEqual(saved);}finally{await second.sql.end();}
  expect((await getRealmSaleSigned(conn.db,key(a)))?.wire?.messageSha256).toBe(a.quote.messageSha256);
  await expect(conn.sql`insert into seeker_realm_sale_receipts(wallet,idempotency_key,receipt) values(${a.wallet},${a.idempotencyKey},${JSON.stringify({...saved.receipt,feeLamports:'6001'})}::jsonb)`).rejects.toThrow('REALM_SALE_RECEIPT_PAYMENT');
  // Even owner-corrupted historical JSON cannot exceed the approved fee cap.
  await conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update seeker_realm_sale_receipts set receipt=${JSON.stringify({...saved.receipt,feeLamports:'6001'})}::jsonb`;});
  await expect(getRealmSaleSettlement(conn.db,key(a))).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
 },6000n));

 it('joins actual signed journal, finalized transaction and same-bank receipt, then recovers without RPC after expiry or pause',async()=>fixture(async({conn,url,artifact:a,chain:f})=>{
  expect(await getRealmSaleSettlement(conn.db,key(a))).toBeNull();const connect=vi.fn(()=>f.rpc);
  const settle=createRealmSaleSettlement(conn.db,{connect,trust:f.trust});const saved=await settle(key(a));
  expect(saved).toMatchObject({...key(a),saleId:a.saleId,signature:f.signature,purchaseFinalized:true,admissionAuthorized:false,relayAuthorized:false,signingAuthorized:false});
  expect(saved.receipt.receiptAccountHex).toBe(f.receipt.data.toString('hex'));expect(saved.purchase.expiresAt).toBe(String(f.model.expires_at));
  expect(saved.receipt.source.accounts[5]!.dataSha256).toBe(createHash('sha256').update(f.receipt.data).digest('hex'));
  const second=createDb(url.toString());try{const down=vi.fn(()=>{throw Error('provider unavailable');});expect(await createRealmSaleSettlement(second.db,{connect:down,trust:f.trust})(key(a))).toEqual(saved);expect(down).not.toHaveBeenCalled();}finally{await second.sql.end();}
  expect(await getRealmSaleSettlement(conn.db,{...key(a),wallet:Keypair.generate().publicKey.toBase58()})).toBeNull();
  expect(await settle(key(a))).toEqual(saved);expect(connect).toHaveBeenCalledTimes(1);
 }));
 it('binds copied reviewed deployment policy to original preparation before RPC',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  for(const patch of [{expectedGenesisHash:Keypair.generate().publicKey.toBase58()},{reviewedDeploymentSlot:f.trust.reviewedDeploymentSlot+1},{reviewedProgramDataSha256:'ee'.repeat(32)},{developer:Keypair.generate().publicKey}]){
   const connect=vi.fn(()=>f.rpc);await expect(createRealmSaleSettlement(conn.db,{connect,trust:{...f.trust,...patch}})(key(a))).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});expect(connect).not.toHaveBeenCalled();
  }
  const trust={...f.trust},settle=createRealmSaleSettlement(conn.db,{connect:()=>f.rpc,trust});trust.reviewedProgramDataSha256='ee'.repeat(32);expect((await settle(key(a))).purchaseFinalized).toBe(true);
 }));
 it('keeps missing, failed, forged-recipient, wrong-genesis and malformed transaction observations nonterminal',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  for(const rpc of [{...f.rpc,getTransaction:async()=>null},{...f.rpc,getTransaction:async()=>({...f.transaction,meta:{...f.transaction.meta!,err:{InstructionError:[0,'Custom']}}})},{...f.rpc,getGenesisHash:async()=>Keypair.generate().publicKey.toBase58()},{...f.rpc,getTransaction:async()=>({...f.transaction,transaction:{...f.transaction.transaction,signatures:['bad']}})}])await expect(createRealmSaleSettlement(conn.db,{connect:()=>rpc as typeof f.rpc,trust:f.trust})(key(a))).rejects.toMatchObject({code:expect.stringMatching(/^RECEIPT_(UNAVAILABLE|CONFLICT)$/),journalReleaseAuthorized:false});
  f.bank.rows[5]=await f.reencode({seller:Keypair.generate().publicKey});await expect(createRealmSaleSettlement(conn.db,{connect:()=>f.rpc,trust:f.trust})(key(a))).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
  expect(await conn.sql`select * from seeker_realm_sale_receipts`).toHaveLength(0);
 }));
 it('requires an original signed actor/key and rejects caller authority fields',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  const connect=vi.fn(()=>f.rpc),settle=createRealmSaleSettlement(conn.db,{connect,trust:f.trust});
  for(const k of [{...key(a),wallet:Keypair.generate().publicKey.toBase58()},{...key(a),idempotencyKey:randomUUID()}])await expect(settle(k)).rejects.toMatchObject({code:'NOT_SIGNED'});
  await expect(settle({...key(a),finalityVerified:true} as unknown as ReturnType<typeof key>)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(connect).not.toHaveBeenCalled();
 }));
 it('permits runtime recovery only and an accidental INSERT grant cannot create a success',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  const role=`realm_settle_${randomUUID().replaceAll('-','')}`;await conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on seeker_realm_sale_preparations,seeker_realm_sale_signed_wires,seeker_realm_sale_receipts to ${role};grant insert on seeker_realm_sale_receipts to ${role}`);
  try{
   const connect=vi.fn(()=>f.rpc);await expect(conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));await createRealmSaleSettlement(tx as unknown as typeof conn.db,{connect,trust:f.trust})(key(a));})).rejects.toMatchObject({code:'OWNER_REQUIRED'});expect(connect).not.toHaveBeenCalled();
   await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into seeker_realm_sale_receipts(wallet,idempotency_key,receipt) values(${a.wallet},${a.idempotencyKey},'{}')`;})).rejects.toThrow('REALM_SALE_RECEIPT_OWNER_REQUIRED');
   const saved=await createRealmSaleSettlement(conn.db,{connect:()=>f.rpc,trust:f.trust})(key(a));
   await conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await getRealmSaleSettlement(tx,key(a))).toEqual(saved);});
  }finally{await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('refuses forged owner JSON and never promotes persisted true flags into proof',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  const proof=await createRealmSaleSettlement(conn.db,{connect:()=>f.rpc,trust:f.trust})(key(a));
  for(const receipt of [{...proof.receipt,signature:'bad'},{...proof.receipt,receiptAccountHex:'00'.repeat(294)},{...proof.receipt,originalMessageSha256:'ef'.repeat(32)},{...proof.receipt,finalityVerified:true}])await expect(conn.sql`insert into seeker_realm_sale_receipts(wallet,idempotency_key,receipt) values(${a.wallet},${a.idempotencyKey},${JSON.stringify(receipt)}::jsonb)`).rejects.toThrow('REALM_SALE_RECEIPT_');
  await conn.sql`set session_replication_role=replica`;try{await conn.sql`update seeker_realm_sale_receipts set receipt=${JSON.stringify({...proof.receipt,receiptAccountHex:'00'.repeat(294)})}::jsonb`;}finally{await conn.sql`set session_replication_role=origin`;}
  await expect(getRealmSaleSettlement(conn.db,key(a))).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
 }));
 it('bounds pending work and timeout never writes late after ignored transport cancellation',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  let release!:(value:typeof f.transaction)=>void;const rpc={...f.rpc,getTransaction:()=>new Promise<typeof f.transaction>(r=>{release=r;})};const settle=createRealmSaleSettlement(conn.db,{connect:()=>rpc,trust:f.trust,timeoutMs:40});
  await expect(settle(key(a))).rejects.toMatchObject({code:'TIMEOUT',journalReleaseAuthorized:false});
  await expect(settle(key(a))).rejects.toMatchObject({code:'BUSY'});release(f.transaction);await new Promise(r=>setTimeout(r,30));expect(await getRealmSaleSettlement(conn.db,key(a))).toBeNull();
 }));
 it('rolls back receipt INSERT when the deadline expires during the database write',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  await conn.sql.unsafe("create function test_receipt_delay() returns trigger language plpgsql as $$begin perform pg_sleep(0.2);return NEW;end$$;create trigger z_test_delay before insert on seeker_realm_sale_receipts for each row execute function test_receipt_delay()");
  await expect(createRealmSaleSettlement(conn.db,{connect:()=>f.rpc,trust:f.trust,timeoutMs:100})(key(a))).rejects.toMatchObject({code:'TIMEOUT'});
  await new Promise(r=>setTimeout(r,250));expect(await getRealmSaleSettlement(conn.db,key(a))).toBeNull();
 }));
 it('preserves one success under concurrent factories, restart and repeated migration while forbidding mutation',async()=>fixture(async({conn,artifact:a,chain:f})=>{
  const make=()=>createRealmSaleSettlement(conn.db,{connect:()=>f.rpc,trust:f.trust});const [one,two]=await Promise.all([make()(key(a)),make()(key(a))]);expect(one).toEqual(two);
  for(let i=0;i<2;i++)for(const s of readFileSync(settlementMigration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  expect(await getRealmSaleSettlement(conn.db,key(a))).toEqual(one);
  for(const command of ['delete from seeker_realm_sale_receipts','update seeker_realm_sale_receipts set receipt=receipt','truncate seeker_realm_sale_receipts'])await expect(conn.sql.unsafe(command)).rejects.toThrow('REALM_SALE_RECEIPT_IMMUTABLE');
 }));
});
