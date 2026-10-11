/** Actual finalized burn -> private global consumption -> original stable destination. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {readFileSync} from 'node:fs';
import {deedOwnershipObservations,players} from '../src/db/schema';
import {registerOwnedDeed,transferStableBase} from '../src/game/baseOwnership';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
async function setup(){const f=await vehicleBurnDatabase();const signed=f.finalizeBurn(),proof=await f.reader.verify({reservationId:f.reservation.id});return {...f,signed,proof};}
// Historical migration/bootstrap work has its own bounded setup budget. Keep
// actual recovery/lock behavior under the original30-second test deadline.
let active:Awaited<ReturnType<typeof setup>>|undefined;
beforeEach(async()=>{active=await setup();},120_000);
afterEach(async()=>{vi.unstubAllEnvs();await active?.dispose();active=undefined;},120_000);
async function fixture(work:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){if(!active)throw Error('fixture not ready');await work(active);}
describe('initial advanced vehicle installation',()=>{
 it('atomically retains actual burn consumption and the original installation identity without posting money',async()=>fixture(async f=>{
  const before=await f.conn.sql`select to_jsonb(t)::text value from accounts t order by id`;
  await f.conn.sql.begin(async tx=>{await tx`insert into vehicle_burn_consumptions(reservation_id,proof) values(${f.reservation.id},${JSON.stringify(f.proof)}::jsonb)`;await tx`insert into advanced_vehicle_installations(reservation_id) values(${f.reservation.id})`;});
  expect(await f.conn.sql`select asset_id,reservation_id,wallet,signature from vehicle_burn_consumptions`).toEqual([{asset_id:f.identity.assetId,reservation_id:f.reservation.id,wallet:f.actor,signature:f.signed.signature}]);
  expect(await f.conn.sql`select base_id,berth_id,family,tier,installed_wallet from advanced_vehicle_installations`).toEqual([{base_id:f.baseId,berth_id:f.berthId,family:f.identity.family,tier:f.identity.tier,installed_wallet:f.actor}]);
  expect(await f.conn.sql`select to_jsonb(t)::text value from accounts t order by id`).toEqual(before);expect(await f.conn.sql`select * from ledger_transactions`).toHaveLength(0);
 }),30_000);
 it('verifies outside reservation locks and recovers a lost wire exactly once across concurrent requests',async()=>fixture(async f=>{
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations'),observer=f.conn.reopen();let calls=0,checking:Promise<unknown>|undefined;
  try{const service=createVehicleInstallations(f.conn.db,{verifyBurn:async input=>{calls++;checking??=observer.sql.begin(async tx=>{expect(await tx`select id from vehicle_activation_reservations where id=${f.reservation.id} for update nowait`).toHaveLength(1);});await checking;return f.reader.verify(input);}});
   const values=await Promise.all([service.recover(f.actor,f.reservation.id),service.recover(f.actor,f.reservation.id),service.recover(f.actor,f.reservation.id)]);expect(values[1]).toEqual(values[0]);expect(values[2]).toEqual(values[0]);expect(calls).toBeGreaterThan(0);
   expect(await observer.sql`select * from vehicle_burn_consumptions`).toHaveLength(1);expect(await observer.sql`select * from advanced_vehicle_installations`).toHaveLength(1);expect(await observer.sql`select * from ledger_transactions`).toHaveLength(0);
  }finally{await observer.sql.end();}
 }),30_000);
 it('completes prior irreversible intent while admission is paused and replays after restart without a provider',async()=>fixture(async f=>{
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations');vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
  const saved=await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id,f.signed.signedTransaction);f.setOnline(false);const reopened=f.conn.reopen();
  try{const offline=createVehicleInstallations(reopened.db);expect(await offline.recover(f.actor,f.reservation.id)).toEqual(saved);expect(await offline.recover(f.actor,f.reservation.id,f.signed.signedTransaction)).toEqual(saved);
   const wrong=Uint8Array.from(f.signed.signedTransaction);wrong[4]=wrong[4]!^1;await expect(offline.recover(f.actor,f.reservation.id,wrong)).rejects.toMatchObject({code:'VEHICLE_INSTALLATION_WIRE'});
  }finally{await reopened.sql.end();}
 }),30_000);
 it('rejects wrong actors before provider work and mismatched trusted-provider proof fields before any writes',async()=>fixture(async f=>{
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations'),verifyBurn=vi.fn(f.reader.verify),service=createVehicleInstallations(f.conn.db,{verifyBurn});
  await expect(service.recover(Keypair.generate().publicKey.toBase58(),f.reservation.id)).rejects.toThrow();expect(verifyBurn).not.toHaveBeenCalled();
  for(const patch of [{wallet:Keypair.generate().publicKey.toBase58()},{identity:{...f.identity,tier:4}},{preBurnOwner:Keypair.generate().publicKey.toBase58()},{finalityVerified:false},{originalMessageSha256:'0'.repeat(64)},{signedTransactionSha256:'0'.repeat(64)},{anchorSlot:99},{source:{...f.proof.source,genesisHash:Keypair.generate().publicKey.toBase58()}}]){
   const broken=createVehicleInstallations(f.conn.db,{verifyBurn:async()=>({...f.proof,...patch}) as typeof f.proof});await expect(broken.recover(f.actor,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_INSTALLATION_SOURCE'});
  }
  expect(await f.conn.sql`select * from vehicle_burn_consumptions`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_vehicle_installations`).toHaveLength(0);
 }),30_000);
 it('preserves the irreversible reservation and preparation on actual archival outage',async()=>fixture(async f=>{
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations');f.setOnline(false);
  await expect(createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_INSTALLATION_UNAVAILABLE'});
  expect(await f.conn.sql`select * from vehicle_burn_consumptions`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_vehicle_installations`).toHaveLength(0);expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(1);expect(await f.conn.sql`select * from vehicle_burn_preparations`).toHaveLength(1);
 }),30_000);
 it('forbids a committed partial consumption and rolls back both rows on a later failure',async()=>fixture(async f=>{
  await expect(f.conn.sql`insert into vehicle_burn_consumptions(reservation_id,proof) values(${f.reservation.id},${JSON.stringify(f.proof)}::jsonb)`).rejects.toThrow('VEHICLE_INSTALLATION_INCOMPLETE');
  await expect(f.conn.sql.begin(async tx=>{await tx`insert into vehicle_burn_consumptions(reservation_id,proof) values(${f.reservation.id},${JSON.stringify(f.proof)}::jsonb)`;await tx`insert into advanced_vehicle_installations(reservation_id) values(${f.reservation.id})`;throw Error('rollback');})).rejects.toThrow('rollback');
  expect(await f.conn.sql`select * from vehicle_burn_consumptions`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_vehicle_installations`).toHaveLength(0);
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations');await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 }),30_000);
 it('keeps the original stable destination after an actual deed transfer without substituting the buyer for the burn actor',async()=>fixture(async f=>{
  const mint=Keypair.generate().publicKey.toBase58(),buyer=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);
  await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:new Date(),status:'owned',source:'rpc-finalized',auditHash:randomUUID()});await f.conn.db.insert(players).values({wallet:buyer});
  await transferStableBase(f.conn.db,f.baseId,f.actor,buyer,mint,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:Date.now()});
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations'),service=createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify});await expect(service.recover(buyer,f.reservation.id)).rejects.toThrow();
  const saved=await service.recover(f.actor,f.reservation.id);expect(saved).toMatchObject({baseId:f.baseId,berthId:f.berthId,installedWallet:f.actor});expect((await f.conn.sql`select owner_wallet from bases where id=${f.baseId}`)[0]!.owner_wallet).toBe(buyer);
 }),30_000);
 it('prevents global asset/signature reuse and retains immutable history across migration repeats',async()=>fixture(async f=>{
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations');await createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
  await expect(f.conn.sql`insert into vehicle_burn_consumptions(reservation_id,proof) values(${f.reservation.id},${JSON.stringify(f.proof)}::jsonb)`).rejects.toMatchObject({code:'23505'});
  const constraints=await f.conn.sql`select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='vehicle_burn_consumptions'::regclass`;expect(constraints.map(c=>c.definition)).toContain('PRIMARY KEY (asset_id)');expect(constraints.map(c=>c.definition)).toContain('UNIQUE (signature)');
  const before=await f.conn.sql`select * from advanced_vehicle_installations`;for(const table of ['vehicle_burn_consumptions','advanced_vehicle_installations'])for(const command of [`update ${table} set reservation_id=reservation_id`,`delete from ${table}`,`truncate ${table} cascade`])await expect(f.conn.sql.unsafe(command)).rejects.toThrow();
  for(let n=0;n<2;n++)await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL('../drizzle/0207_vehicle_installations.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});expect(await f.conn.sql`select * from advanced_vehicle_installations`).toEqual(before);
 }),30_000);
 it('holds on independently locked build provenance without consuming the burn and retries after release',async()=>fixture(async f=>{
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations'),service=createVehicleInstallations(f.conn.db,{verifyBurn:f.reader.verify});
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r),writer=f.conn.sql.begin(async tx=>{await tx`select id from builder_jobs where id=${f.jobId} for update`;ready();await gate;});
  try{await started;await expect(service.recover(f.actor,f.reservation.id)).rejects.toMatchObject({code:'VEHICLE_INSTALLATION_BUSY'});expect(await f.conn.sql`select * from vehicle_burn_consumptions`).toHaveLength(0);expect(await f.conn.sql`select * from advanced_vehicle_installations`).toHaveLength(0);}finally{release();await writer;}
  expect(await service.recover(f.actor,f.reservation.id)).toMatchObject({baseId:f.baseId,berthId:f.berthId});
 }),30_000);
 it('requires top-level private ownership and rejects stale SQL isolation',async()=>fixture(async f=>{
  const {createVehicleInstallations}=await import('../src/game/vehicleInstallations');await expect(f.conn.db.transaction(async tx=>createVehicleInstallations(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_INSTALLATION_TOP_LEVEL'});
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select * from vehicle_activation_reservations`;await tx`insert into vehicle_burn_consumptions(reservation_id,proof) values(${f.reservation.id},${JSON.stringify(f.proof)}::jsonb)`;})).rejects.toThrow('VEHICLE_INSTALLATION_READ_COMMITTED');
 }),30_000);
 it('denies runtime fabrication despite accidental grants and rejects fake trigger attachment',async()=>fixture(async f=>{
  const role='vehicle_installation_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{const [database]=await f.conn.sql`select current_database() name`;await f.conn.sql.unsafe(`grant usage on schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
   await expect(runtime.sql`select * from vehicle_burn_consumptions`).rejects.toMatchObject({code:'42501'});await f.conn.sql.unsafe(`grant all on vehicle_burn_consumptions,advanced_vehicle_installations to ${role};grant execute on function shardkeep_vehicle_installation_guard() to ${role};grant create on schema public to ${role}`);
   await expect(runtime.sql`insert into vehicle_burn_consumptions(reservation_id,proof) values(${f.reservation.id},${JSON.stringify(f.proof)}::jsonb)`).rejects.toMatchObject({code:'42501'});await expect(runtime.sql`insert into advanced_vehicle_installations(reservation_id) values(${f.reservation.id})`).rejects.toMatchObject({code:'42501'});
   await runtime.sql.unsafe('create table fake_consumption(like vehicle_burn_consumptions including defaults);create trigger vehicle_burn_consumptions_guard before insert on fake_consumption for each row execute function public.shardkeep_vehicle_installation_guard()');await expect(runtime.sql`insert into fake_consumption(reservation_id,proof) values(${f.reservation.id},${JSON.stringify(f.proof)}::jsonb)`).rejects.toThrow('VEHICLE_INSTALLATION_TRIGGER');
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
});
