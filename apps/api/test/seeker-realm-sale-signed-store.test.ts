/** Unsigned quotes are durable consent records, never payment or current admission. */
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {describe,it,expect} from 'vitest';
import {PublicKey,Transaction,Keypair} from '@solana/web3.js';
import {realmSaleReceiptFixture} from '../../../packages/chain/src/testFixtures/seekerRealmSaleReceipt';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {saveRealmSalePreparation,type RealmSalePreparation} from '../src/seeker/realmSalePreparationStore';
import {acceptRealmSaleSigned,getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
const signedMigration=new URL('../drizzle/0183_seeker_realm_sale_signed.sql',import.meta.url);
const migration=new URL('../drizzle/0182_seeker_realm_sale_preparations.sql',import.meta.url);
async function fixture(run:(f:{conn:ReturnType<typeof createDb>;url:URL;artifact:RealmSalePreparation;signedTransaction:Uint8Array;buyer:Keypair})=>Promise<void>){
 const database=`realm_sale_signed_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${database}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe fixture host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await admin.unsafe(`create database ${database}`);const conn=createDb(url.toString(),{max:4});
 try{
  for(const s of readFileSync(migration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  for(const s of readFileSync(signedMigration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  const f=await realmSaleReceiptFixture(),a=f.expected.args;
  const artifact:RealmSalePreparation={version:1,wallet:f.buyer.publicKey.toBase58(),idempotencyKey:randomUUID(),saleId:Buffer.from(a.saleId).toString('hex'),spot:a.spot,realm:a.realm,
   terms:{round:String(a.round),day:String(a.day),seller:a.seller.toBase58(),developer:a.developer.toBase58(),priorExpiry:String(a.priorExpiry),validAfter:String(a.validAfter),validUntil:String(a.validUntil)},
   source:{revision:'fixture-r1',genesisHash:new PublicKey(Buffer.alloc(32,9)).toBase58(),programId:f.expected.programId.toBase58(),programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:50,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:99,initialSlot:100,blockhashSlot:100,feeSlot:100,costSlot:100,admissionSlot:100},
   quote:{blockhash:f.expected.blockhash,lastValidBlockHeight:300,unixTimestamp:String(a.validAfter),needsAccess:true,needsQuota:true,quotaRemaining:10,
    messageHex:Buffer.from(f.plan.messageBytes).toString('hex'),messageSha256:f.plan.messageSha256,packetBytes:f.plan.packetBytes,
    rents:f.plan.expectedNewAccounts.map(r=>({address:r.address,space:r.space,minimumBalanceLamports:'1000000',existingLamports:'0',maxIncreaseLamports:'1000000'})),
    feeLamports:'5000',rentLamports:'3000000',paymentDebitLamports:String(f.plan.buyerNetPaymentLamports),requiredLamports:String(f.plan.buyerNetPaymentLamports+3005000n),payerLamports:'100000000'},
   state:'prepared',currentSigningAuthorized:false,submissionAuthorized:false};
  await run({conn,url,artifact,signedTransaction:f.expected.signedTransaction,buyer:f.buyer});
 }finally{await conn.sql.end();await admin.unsafe(`drop database ${database} with (force)`);await admin.end();}
}
const key=(a:RealmSalePreparation)=>({wallet:a.wallet,idempotencyKey:a.idempotencyKey});
describe('immutable buyer-signed realm sale journal',()=>{
 it('retains the original signed packet across reconnect, expiry and pause without any RPC or relay authority',async()=>fixture(async({conn,url,artifact:a,signedTransaction})=>{
  expect(await getRealmSaleSigned(conn.db,key(a))).toBeNull();await saveRealmSalePreparation(conn.db,a);
  expect(await getRealmSaleSigned(conn.db,key(a))).toEqual({preparation:a,wire:null});
  const saved=await acceptRealmSaleSigned(conn.db,{...key(a),signedTransaction});
  expect(saved).toMatchObject({...key(a),saleId:a.saleId,signedTransactionHex:Buffer.from(signedTransaction).toString('hex'),messageSha256:a.quote.messageSha256,currentSigningAuthorized:false,relayAuthorized:false});
  expect(saved.wireSha256).toBe(createHash('sha256').update(signedTransaction).digest('hex'));
  expect(saved.acceptedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  // Fixture intent expired years ago; recovery has neither a clock nor provider dependency.
  const second=createDb(url.toString());try{expect(await getRealmSaleSigned(second.db,key(a))).toEqual({preparation:a,wire:saved});expect(await acceptRealmSaleSigned(second.db,{...key(a),signedTransaction})).toEqual(saved);}finally{await second.sql.end();}
  expect(await getRealmSaleSigned(conn.db,{...key(a),wallet:Keypair.generate().publicKey.toBase58()})).toBeNull();
 }));
 it('rejects wrong actors, unknown keys and caller authority fields before retaining bytes',async()=>fixture(async({conn,artifact:a,signedTransaction})=>{
  await saveRealmSalePreparation(conn.db,a);
  for(const k of [{...key(a),wallet:Keypair.generate().publicKey.toBase58()},{...key(a),idempotencyKey:randomUUID()}])await expect(acceptRealmSaleSigned(conn.db,{...k,signedTransaction})).rejects.toMatchObject({code:'NOT_FOUND'});
  for(const input of [{...key(a),signedTransaction,relayAuthorized:true},{...key(a),wallet:'1'.repeat(10000),signedTransaction},{...key(a),idempotencyKey:a.idempotencyKey.toUpperCase(),signedTransaction},{...key(a),signedTransaction:new Uint8Array(1233)}])await expect(acceptRealmSaleSigned(conn.db,input)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(await conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(0);
 }));
 it('refuses altered message, invalid signature, extra signatures and noncanonical packets atomically',async()=>fixture(async({conn,artifact:a,signedTransaction,buyer})=>{
  await saveRealmSalePreparation(conn.db,a);const forged=Uint8Array.from(signedTransaction);forged[2]=forged[2]!^1;
  const changed=Transaction.from(signedTransaction);changed.recentBlockhash=Keypair.generate().publicKey.toBase58();changed.sign(buyer);
  const second=Buffer.concat([Buffer.from([2]),Buffer.from(signedTransaction).subarray(1,65),Buffer.alloc(64,9),Buffer.from(signedTransaction).subarray(65)]);
  const noncanonical=Buffer.concat([Buffer.from([0x81,0]),Buffer.from(signedTransaction).subarray(1)]);
  for(const wire of [forged,changed.serialize(),second,noncanonical,Buffer.concat([signedTransaction,Buffer.from([0])])])await expect(acceptRealmSaleSigned(conn.db,{...key(a),signedTransaction:wire})).rejects.toMatchObject({code:'INVALID_WIRE'});
  expect(await conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(0);
 }));
 it('copies the caller packet before awaiting storage and serializes parallel exact retry into one receipt',async()=>fixture(async({conn,artifact:a,signedTransaction})=>{
  await saveRealmSalePreparation(conn.db,a);const input=Uint8Array.from(signedTransaction),pending=acceptRealmSaleSigned(conn.db,{...key(a),signedTransaction:input});input.fill(0);
  const [one,two]=await Promise.all([pending,acceptRealmSaleSigned(conn.db,{...key(a),signedTransaction})]);expect(one).toEqual(two);expect(await conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(1);
 }));
 it('does not reassign a signature to another original sale even when adversarial SQL plants a matching message',async()=>fixture(async({conn,artifact:a,signedTransaction})=>{
  await saveRealmSalePreparation(conn.db,a);await acceptRealmSaleSigned(conn.db,{...key(a),signedTransaction});
  const planted={...a,idempotencyKey:randomUUID(),saleId:'08'.repeat(16)};
  await conn.sql`insert into seeker_realm_sale_preparations(artifact) values(${JSON.stringify(planted)}::jsonb)`;
  await expect(acceptRealmSaleSigned(conn.db,{...key(planted),signedTransaction})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await expect(conn.sql`insert into seeker_realm_sale_signed_wires(wallet,idempotency_key,signed_transaction) values(${a.wallet},${planted.idempotencyKey},${Buffer.from(signedTransaction)})`).rejects.toMatchObject({code:'23505'});
  expect(await conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(1);
 }));
 it('operates with minimal runtime grants and forbids replacing or removing the permanent first signature',async()=>fixture(async({conn,artifact:a,signedTransaction})=>{
  await saveRealmSalePreparation(conn.db,a);const role=`realm_signed_${randomUUID().replaceAll('-','')}`;
  await conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on seeker_realm_sale_preparations to ${role};grant select,insert on seeker_realm_sale_signed_wires to ${role}`);
  try{
   await conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect((await acceptRealmSaleSigned(tx,{...key(a),signedTransaction})).relayAuthorized).toBe(false);});
   await conn.sql.unsafe(`grant all on seeker_realm_sale_signed_wires to ${role}`);
   for(const command of ['delete from seeker_realm_sale_signed_wires','update seeker_realm_sale_signed_wires set signed_transaction=signed_transaction','truncate seeker_realm_sale_signed_wires'])await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(command);})).rejects.toThrow('REALM_SALE_SIGNED_IMMUTABLE');
   await expect(conn.sql`insert into seeker_realm_sale_signed_wires(wallet,idempotency_key,sale_id,signed_transaction) values(${a.wallet},${a.idempotencyKey},${a.saleId},${Buffer.from(signedTransaction)})`).rejects.toThrow('REALM_SALE_SIGNED_DERIVED');
  }finally{await conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('refuses SQL-only signature forgeries on read rather than granting recovery evidence',async()=>fixture(async({conn,artifact:a,signedTransaction})=>{
  await saveRealmSalePreparation(conn.db,a);const forged=Buffer.from(signedTransaction);forged[1]=forged[1]!^1;
  // PostgreSQL binds exact message/digests, not Ed25519. Every application read rechecks Ed25519.
  await conn.sql`insert into seeker_realm_sale_signed_wires(wallet,idempotency_key,signed_transaction) values(${a.wallet},${a.idempotencyKey},${forged})`;
  await expect(getRealmSaleSigned(conn.db,key(a))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await expect(acceptRealmSaleSigned(conn.db,{...key(a),signedTransaction})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('rejects orphan, oversized, unsigned and message-mismatched SQL packets and nondefault isolation',async()=>fixture(async({conn,artifact:a,signedTransaction})=>{
  await saveRealmSalePreparation(conn.db,a);
  await expect(conn.sql`insert into seeker_realm_sale_signed_wires(wallet,idempotency_key,signed_transaction) values(${a.wallet},${randomUUID()},${Buffer.from(signedTransaction)})`).rejects.toThrow('REALM_SALE_SIGNED_PREPARATION');
  const unsigned=Buffer.from(signedTransaction);unsigned.fill(0,1,65);const changed=Buffer.from(signedTransaction);changed[changed.length-1]=changed[changed.length-1]!^1;
  for(const wire of [Buffer.alloc(1233),unsigned,changed])await expect(conn.sql`insert into seeker_realm_sale_signed_wires(wallet,idempotency_key,signed_transaction) values(${a.wallet},${a.idempotencyKey},${wire})`).rejects.toThrow('REALM_SALE_SIGNED_');
  await expect(conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into seeker_realm_sale_signed_wires(wallet,idempotency_key,signed_transaction) values(${a.wallet},${a.idempotencyKey},${Buffer.from(signedTransaction)})`;})).rejects.toThrow('REALM_SALE_SIGNED_READ_COMMITTED');
  expect(await conn.sql`select * from seeker_realm_sale_signed_wires`).toHaveLength(0);
 }));
 it('migration retries preserve the same wire, parent bindings and signature identity',async()=>fixture(async({conn,artifact:a,signedTransaction})=>{
  await saveRealmSalePreparation(conn.db,a);const first=await acceptRealmSaleSigned(conn.db,{...key(a),signedTransaction});
  for(let i=0;i<2;i++)for(const s of readFileSync(signedMigration,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await conn.sql.unsafe(s);
  expect((await getRealmSaleSigned(conn.db,key(a)))?.wire).toEqual(first);
  const [row]=await conn.sql`select wallet,sale_id,idempotency_key,octet_length(signature) signature_bytes from seeker_realm_sale_signed_wires`;
  expect(row).toEqual({wallet:a.wallet,sale_id:a.saleId,idempotency_key:a.idempotencyKey,signature_bytes:64});
 }));
});
