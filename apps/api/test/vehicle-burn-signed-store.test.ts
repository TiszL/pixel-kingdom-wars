/** Retention protects recovery of already signed consent; it grants no relay permission. */
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {Keypair} from '@solana/web3.js';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
const migration=new URL('../drizzle/0208_vehicle_burn_signed_wires.sql',import.meta.url);
async function apply(f:Awaited<ReturnType<typeof vehicleBurnDatabase>>){await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(migration,'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});}
let current:Awaited<ReturnType<typeof vehicleBurnDatabase>>;
beforeEach(async()=>{current=await vehicleBurnDatabase();if(existsSync(migration))await apply(current);},120_000);
afterEach(async()=>{await current?.dispose();},30_000);
async function fixture(work:(f:Awaited<ReturnType<typeof vehicleBurnDatabase>>)=>Promise<void>){await work(current);}
describe('vehicle signed burn retention',()=>{
 it('binds SQL retention to the original committed message',async()=>fixture(async f=>{
  const wire=f.finalizeBurn().signedTransaction;
  const [r]=await f.conn.sql`insert into vehicle_burn_signed_wires(reservation_id,signed_transaction) values(${f.reservation.id},${Buffer.from(wire)}) returning *`;
  expect(r).toMatchObject({reservation_id:f.reservation.id,wallet:f.actor,message_sha256:f.preparation.messageSha256});
 }),30_000);
 it('returns committed original bytes after restart and provider loss, without relay or release authority',async()=>fixture(async f=>{
  const {createVehicleBurnSignedStore}=await import('../src/game/vehicleBurnSignedStore');const store=createVehicleBurnSignedStore(f.conn.db),wire=f.finalizeBurn().signedTransaction;
  expect(await store.get(f.actor,f.reservation.id)).toBeNull();const saved=await store.accept(f.actor,f.reservation.id,wire),observer=f.conn.reopen();f.setOnline(false);
  try{expect(await observer.sql`select * from vehicle_burn_signed_wires`).toHaveLength(1);const resumed=createVehicleBurnSignedStore(observer.db);
   expect(await resumed.get(f.actor,f.reservation.id)).toEqual(saved);expect(await resumed.accept(f.actor,f.reservation.id,wire)).toEqual(saved);
   expect(saved).toMatchObject({signature:f.finalizeBurn().signature,messageSha256:f.preparation.messageSha256,signedTransactionHex:Buffer.from(wire).toString('hex'),relayAuthorized:false,installationAuthorized:false,reservationReleaseAuthorized:false});
  }finally{await observer.sql.end();}
 }),30_000);
 it('copies caller bytes before awaiting the owner lookup and retains one exact concurrent winner',async()=>fixture(async f=>{
  const {createVehicleBurnSignedStore}=await import('../src/game/vehicleBurnSignedStore'),store=createVehicleBurnSignedStore(f.conn.db),wire=f.finalizeBurn().signedTransaction,original=Buffer.from(wire).toString('hex');
  const pending=store.accept(f.actor,f.reservation.id,wire);wire.fill(0);const signed=f.finalizeBurn().signedTransaction;
  const [a,b]=await Promise.all([pending,store.accept(f.actor,f.reservation.id,signed)]);expect(a).toEqual(b);expect(a.signedTransactionHex).toBe(original);expect(await f.conn.sql`select * from vehicle_burn_signed_wires`).toHaveLength(1);
 }),30_000);
 it('rejects changed actor, signatures and messages before retention, including saved replay',async()=>fixture(async f=>{
  const {createVehicleBurnSignedStore}=await import('../src/game/vehicleBurnSignedStore'),store=createVehicleBurnSignedStore(f.conn.db),wire=f.finalizeBurn().signedTransaction;
  await expect(store.accept(Keypair.generate().publicKey.toBase58(),f.reservation.id,wire)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_ACTOR'});
  for(const offset of [1,wire.length-1]){const changed=Uint8Array.from(wire);changed[offset]=changed[offset]!^1;await expect(store.accept(f.actor,f.reservation.id,changed)).rejects.toMatchObject({code:'VEHICLE_SIGNED_WIRE'});}
  expect(await f.conn.sql`select * from vehicle_burn_signed_wires`).toHaveLength(0);await store.accept(f.actor,f.reservation.id,wire);
  const forged=Uint8Array.from(wire);forged[1]=forged[1]!^1;await expect(store.accept(f.actor,f.reservation.id,forged)).rejects.toMatchObject({code:'VEHICLE_SIGNED_WIRE'});
  await expect(store.get(Keypair.generate().publicKey.toBase58(),f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_PREPARATION_ACTOR'});
 }),30_000);
 it('reverifies Ed25519 on every read because private SQL cannot authenticate signatures',async()=>fixture(async f=>{
  const {createVehicleBurnSignedStore}=await import('../src/game/vehicleBurnSignedStore'),wire=f.finalizeBurn().signedTransaction;wire[1]=wire[1]!^1;
  await f.conn.sql`insert into vehicle_burn_signed_wires(reservation_id,signed_transaction) values(${f.reservation.id},${Buffer.from(wire)})`;
  await expect(createVehicleBurnSignedStore(f.conn.db).get(f.actor,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_SIGNED_SOURCE'});
 }),30_000);
 it('preserves immutable rows across repeated migration and refuses SQL substitution or stale isolation',async()=>fixture(async f=>{
  const {createVehicleBurnSignedStore}=await import('../src/game/vehicleBurnSignedStore'),store=createVehicleBurnSignedStore(f.conn.db),wire=f.finalizeBurn().signedTransaction;
  const changed=Uint8Array.from(wire);changed[changed.length-1]=changed[changed.length-1]!^1;await expect(f.conn.sql`insert into vehicle_burn_signed_wires(reservation_id,signed_transaction) values(${f.reservation.id},${Buffer.from(changed)})`).rejects.toThrow('VEHICLE_SIGNED_MESSAGE');
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select * from vehicle_burn_preparations`;await tx`insert into vehicle_burn_signed_wires(reservation_id,signed_transaction) values(${f.reservation.id},${Buffer.from(wire)})`;})).rejects.toThrow('VEHICLE_SIGNED_READ_COMMITTED');
  const saved=await store.accept(f.actor,f.reservation.id,wire);for(const q of ['update vehicle_burn_signed_wires set wallet=wallet','delete from vehicle_burn_signed_wires','truncate vehicle_burn_signed_wires'])await expect(f.conn.sql.unsafe(q)).rejects.toThrow('VEHICLE_SIGNED_IMMUTABLE');
  await apply(f);await apply(f);expect(await store.get(f.actor,f.reservation.id)).toEqual(saved);
 }),30_000);
 it('requires a top-level owner capability and rejects invalid sizes before SQL',async()=>fixture(async f=>{
  const {createVehicleBurnSignedStore}=await import('../src/game/vehicleBurnSignedStore');await expect(f.conn.db.transaction(async tx=>createVehicleBurnSignedStore(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_SIGNED_TOP_LEVEL'});
  for(const wire of [new Uint8Array(65),new Uint8Array(1233)])await expect(createVehicleBurnSignedStore(f.conn.db).accept(f.actor,f.reservation.id,wire)).rejects.toMatchObject({code:'VEHICLE_SIGNED_INPUT'});
  expect(await f.conn.sql`select * from vehicle_burn_signed_wires`).toHaveLength(0);
 }),30_000);
 it('denies LOGIN access, accidental write grants and fake trigger attachment',async()=>fixture(async f=>{
  const {createVehicleBurnSignedStore}=await import('../src/game/vehicleBurnSignedStore'),role='vehicle_signed_'+randomUUID().replaceAll('-',''),password=randomUUID(),wire=Buffer.from(f.finalizeBurn().signedTransaction);let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{const [database]=await f.conn.sql`select current_database() name`;await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
   await expect(runtime.sql`select * from vehicle_burn_signed_wires`).rejects.toMatchObject({code:'42501'});await expect(createVehicleBurnSignedStore(runtime.db).get(f.actor,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_SIGNED_OWNER'});
   await f.conn.sql.unsafe(`grant all on vehicle_burn_signed_wires to ${role};grant execute on function shardkeep_vehicle_signed_guard() to ${role};grant create on schema public to ${role}`);
   await expect(runtime.sql`insert into vehicle_burn_signed_wires(reservation_id,signed_transaction) values(${f.reservation.id},${wire})`).rejects.toMatchObject({code:'42501'});
   await runtime.sql.unsafe('create table fake_vehicle_signed(like vehicle_burn_signed_wires including defaults);create trigger vehicle_burn_signed_wires_guard before insert on fake_vehicle_signed for each row execute function public.shardkeep_vehicle_signed_guard()');
   await expect(runtime.sql`insert into fake_vehicle_signed(reservation_id,signed_transaction) values(${f.reservation.id},${wire})`).rejects.toThrow('VEHICLE_SIGNED_TRIGGER');
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
});
