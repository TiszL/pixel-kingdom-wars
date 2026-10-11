import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PublicKey} from '@solana/web3.js';
import {verifyCharterTransferSignedWire} from '@shardkeep/chain/charter-transfer-wire';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {createCharterContributions} from '../src/db/charterContributions';
import {charterSalesWorkflowFixture,type SalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
import {postgresLeaf} from './fixtures/charterPermitInventory';
let f:SalesWorkflowFixture|undefined;
beforeEach(async()=>{f=undefined;f=await charterSalesWorkflowFixture();},120000);
afterEach(async()=>{const old=f;f=undefined;try{await old?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function prepared(){
 const c=f!,app=await c.open(),p=await c.prepared(app),saved=await c.store().read(c.buyer.wallet,p.state.id),wire=c.signed(p.state),store=createCharterContributions(c.db);
 const input=(index:number)=>({attemptId:saved.attempt!.id,messageSha256:p.state.preparation!.packet.messageSha256,signature:Buffer.from(wire.tx.signatures[index]!).toString('base64')});
 const verified=verifyCharterTransferSignedWire({intentBytes:wire.tx.message.serialize(),signedTransaction:wire.bytes,buyer:new PublicKey(c.buyer.wallet),seller:new PublicKey(c.birth.actor.wallet)});
 const record={signedTransactionHex:wire.bytes.toString('hex'),signature:verified.signature,wireSha256:verified.wireSha256,messageSha256:verified.messageSha256};
 return {c,store,input,wire,record,buyer:c.buyer.wallet,seller:c.birth.actor.wallet,id:p.state.id};
}
async function refusal(work:Promise<unknown>,message:string,code='P0001'){
 const error=await work.then(()=>{throw Error('Expected protected SQL refusal');},error=>error);expect(postgresLeaf(error)).toEqual({code,message});
}
it('refuses update, delete, truncate and forged attempt/wallet/message after a genuine retained signature',async()=>{
 const {c,store,input,buyer,seller,id}=await prepared();await store.retain(buyer,id,input(0));
 const before=await c.sql`select to_jsonb(c) row from charter_sale_contributions c`;
 for(const command of ['update charter_sale_contributions set message_sha256=message_sha256','delete from charter_sale_contributions','truncate charter_sale_contributions cascade']){
  await refusal(c.sql.begin(async tx=>{await tx`select set_config('shardkeep.charter_contribution_verified','true',true)`;await tx.unsafe(command);}),'CLAN_CHARTER_SALE_CONTRIBUTION_IMMUTABLE');
 }
 for(const [attempt,actor,hash] of [[randomUUID(),seller,input(1).messageSha256],[input(1).attemptId,PublicKey.unique().toBase58(),input(1).messageSha256],[input(1).attemptId,seller,'ab'.repeat(32)]]){
  await refusal(c.sql`insert into charter_sale_contributions(sale_id,attempt_id,actor_wallet,message_sha256,signature_bytes)
   values(${id},${attempt!},${actor!},${hash!},${Buffer.from(input(1).signature,'base64')})`,'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE');
 }
 expect(await c.sql`select to_jsonb(c) row from charter_sale_contributions c`).toEqual(before);
});
it('never commits a second detached consent without its complete wire, including after early constraint flush',async()=>{
 const {c,store,input,buyer,seller,id}=await prepared();await store.retain(buyer,id,input(0));
 for(const immediate of [false,true])await refusal(c.sql.begin(async tx=>{
  if(immediate)await tx`set constraints all immediate`;
  await tx`insert into charter_sale_contributions(sale_id,attempt_id,actor_wallet,message_sha256,signature_bytes)
   values(${id},${input(1).attemptId},${seller},${input(1).messageSha256},${Buffer.from(input(1).signature,'base64')})`;
 }),'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE');
 expect(await store.read(seller,id)).toHaveLength(1);expect((await c.store().read(buyer,id)).signed).toBeNull();
});
it('allows the real complete wire then second contribution with immediate constraints and preserves canonical buyer ordering',async()=>{
 const {c,store,input,buyer,seller,id,record}=await prepared();await store.retain(seller,id,input(1));
 await c.sql.begin(async tx=>{
  await tx`set constraints all immediate`;
  await tx`select public.shardkeep_charter_sale_wire(${buyer},${id}::uuid,${JSON.stringify(record)}::jsonb)`;
  await tx`insert into charter_sale_contributions(sale_id,attempt_id,actor_wallet,message_sha256,signature_bytes)
   values(${id},${input(0).attemptId},${buyer},${input(0).messageSha256},${Buffer.from(input(0).signature,'base64')})`;
 });
 expect(await store.read(buyer,id)).toEqual([{wallet:buyer,...input(0)},{wallet:seller,...input(1)}]);
 expect((await c.store().read(seller,id)).signed).toEqual(record);
});
it('checks a later wire against already retained consent after an early deferred flush',async()=>{
 const {c,store,input,buyer,seller,id,wire,record}=await prepared();await store.retain(seller,id,input(1));
 const changed=Buffer.from(wire.bytes);changed[66]=changed[66]!^1;
 const forged={...record,signedTransactionHex:changed.toString('hex'),wireSha256:createHash('sha256').update(changed).digest('hex')};
 await refusal(c.sql.begin(async tx=>{
  await tx`set constraints all immediate`;await tx`set constraints all deferred`;
  await tx`select public.shardkeep_charter_sale_wire(${buyer},${id}::uuid,${JSON.stringify(forged)}::jsonb)`;
 }),'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE');
 expect((await c.store().read(buyer,id)).signed).toBeNull();expect(await store.read(buyer,id)).toHaveLength(1);
});
it('checks mandatory mutation and deferred hooks before reading or accepting even one signature',async()=>{
 const {c,input,buyer,id}=await prepared();
 for(const [table,trigger] of [
  ['charter_sale_contributions','charter_sale_contributions_guard'],['charter_sale_contributions','charter_sale_contributions_no_truncate'],
  ['charter_sale_contributions','charter_sale_contributions_complete'],['charter_sale_wires','charter_sale_wires_contribution_guard'],
  ['charter_sale_wires','charter_sale_wires_contribution_complete'],['charter_sale_terminals','charter_sale_terminals_contribution_guard'],
  ['charter_sale_terminals','charter_sale_terminals_contribution_complete'],
 ])await refusal(c.sql.begin(async tx=>{
  await tx.unsafe(`alter table public.${table} disable trigger ${trigger}`);
  await tx`select public.shardkeep_charter_contributions_read(${buyer},${id}::uuid)`;
 }),'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE');
 await refusal(c.sql.begin(async tx=>{
  await tx`alter table charter_sale_contributions disable trigger charter_sale_contributions_complete`;
  await tx`insert into charter_sale_contributions(sale_id,attempt_id,actor_wallet,message_sha256,signature_bytes)
   values(${id},${input(0).attemptId},${buyer},${input(0).messageSha256},${Buffer.from(input(0).signature,'base64')})`;
 }),'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE');
 await refusal(c.sql.begin(async tx=>{
  await tx`drop trigger charter_sale_contributions_guard on charter_sale_contributions`;
  await tx`create trigger charter_sale_contributions_guard before insert or update or delete on charter_sale_contributions
   for each row when(false) execute function public.shardkeep_charter_contributions_guard()`;
  await tx`select public.shardkeep_charter_contributions_read(${buyer},${id}::uuid)`;
 }),'CLAN_CHARTER_SALE_CONTRIBUTION_SOURCE');
});
it('requires the actual owner at read committed even when a runtime role is granted function and table privileges',async()=>{
 const {c,store,input,buyer,id}=await prepared();await store.retain(buyer,id,input(0));
 await refusal(c.sql.begin('isolation level repeatable read',async tx=>{
  await tx`select public.shardkeep_charter_contributions_read(${buyer},${id}::uuid)`;
 }),'CLAN_CHARTER_SALE_READ_COMMITTED');
 const role='contribution_runtime_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await c.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await c.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};grant execute on all functions in schema public to ${role}`);
  const url=await c.ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(createCharterContributions(runtime.db).read(buyer,id)).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_OWNER'});
  await refusal(runtime.sql`insert into charter_sale_contributions(sale_id,attempt_id,actor_wallet,message_sha256,signature_bytes)
   values(${id},${input(0).attemptId},${buyer},${input(0).messageSha256},${Buffer.from(input(0).signature,'base64')})`,'CLAN_CHARTER_SALE_OWNER','42501');
 }finally{await runtime?.sql.end();await c.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
});
it('replays only its exact marked schema and refuses altered defaults, constraints, and foreign keys',async()=>{
 const {c,store,input,buyer,id}=await prepared();await store.retain(buyer,id,input(0));const before=await store.read(buyer,id);
 const statements=(await readFile(new URL('../drizzle/0233_charter_client_contributions.sql',import.meta.url),'utf8')).split('--> statement-breakpoint');
 await c.sql.begin(async tx=>{for(const statement of statements)if(statement.trim())await tx.unsafe(statement);});
 expect(await store.read(buyer,id)).toEqual(before);
 for(const command of [
  "alter table charter_sale_contributions alter column tx_key set default 'forged'",
  'alter table charter_sale_contributions drop constraint charter_sale_contributions_signature_bytes_check',
  'alter table charter_sale_contributions drop constraint charter_sale_contributions_attempt_id_fkey',
 ])await refusal(c.sql.begin(async tx=>{await tx.unsafe(command);for(const statement of statements)if(statement.trim())await tx.unsafe(statement);}), 'CLAN_CHARTER_SALE_CONTRIBUTION_SCHEMA');
 expect(await store.read(buyer,id)).toEqual(before);
});
it('independently verifies retained Ed25519 bytes instead of treating owner-written rows as wallet consent',async()=>{
 const {c,store,input,buyer,id}=await prepared();
 // SQL cannot verify Ed25519. Its owner boundary is deliberately not the
 // cryptographic trust boundary; an injected invalid row must fail the reader.
 await c.sql`insert into charter_sale_contributions(sale_id,attempt_id,actor_wallet,message_sha256,signature_bytes)
  values(${id},${input(0).attemptId},${buyer},${input(0).messageSha256},${Buffer.alloc(64,1)})`;
 await expect(store.read(buyer,id)).rejects.toMatchObject({code:'CLAN_CHARTER_SALE_HELD'});
 expect((await c.store().read(buyer,id)).signed).toBeNull();
});
