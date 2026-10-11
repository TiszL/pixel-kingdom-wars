/** D-153.124: private owner attestations reserve capacity, never prove a mint or authorize a burn. */
import {readFileSync} from 'node:fs';
import {createDb,type Db} from '../src/db/client';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {ADMIN_DATABASE_URL} from './db-url';
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {describe,expect,it} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
const key=()=>Keypair.generate().publicKey.toBase58();
async function setup(){
 const conn=resourceClaimsDatabase();await conn.setup();const wallet=key(),base=randomUUID(),berth=randomUUID(),job=randomUUID(),asset=key(),collection=key();
 await conn.sql`insert into players(wallet) values(${wallet})`;await conn.sql`insert into bases(id,owner_wallet) values(${base},${wallet})`;await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${base})`;
 await conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berth},${wallet},${base},'berth',2,2)`;
 await conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${job},${wallet},${base},${berth},'build',now()-interval '2 hours',now()-interval '1 hour',now()-interval '1 hour')`;
 const register=()=>conn.sql`insert into vehicle_mint_registry(asset_id,collection,family,tier,owner_attestation) values(${asset},${collection},'survey_balloon',1,'{"fixture":"owner assertion only"}')`;
 const reserve=(idempotency=randomUUID())=>conn.sql`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${wallet},${idempotency},${asset},${base},${berth}) returning *`;
 const starter=()=>conn.sql`insert into fleet_installations(base_id,berth_id,family,installed_wallet,completed_build_job_id,berth_completed_at) select ${base},${berth},'starter',${wallet},${job},completed_at from builder_jobs where id=${job}`;
 return {conn,wallet,base,berth,job,asset,collection,register,reserve,starter};
}
async function fixture(work:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await work(f);}finally{await f.conn.close();}}
describe('private advanced vehicle reservations',()=>{
 it('derives permanent original identity from the private registry and actual completed berth',async()=>fixture(async f=>{
  await f.register();const [r]=await f.reserve();expect(r).toMatchObject({wallet:f.wallet,asset_id:f.asset,base_id:f.base,berth_id:f.berth,family:'survey_balloon',tier:1,completed_build_job_id:f.job});
  expect(await f.conn.sql`select * from fleet_installations`).toHaveLength(0);
 }),30_000);
 it('serializes starter versus advanced occupancy and refuses either sequential direction',async()=>fixture(async f=>{
  await f.register();const results=await Promise.allSettled([f.reserve(),f.starter()]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const [counts]=await f.conn.sql`select (select count(*) from vehicle_activation_reservations)+(select count(*) from fleet_installations) n`;expect(Number(counts!.n)).toBe(1);
  await expect(f.reserve()).rejects.toThrow();await expect(f.starter()).rejects.toThrow();
 }),30_000);
 it('allows one winner across concurrent same-family assets on different berths',async()=>fixture(async f=>{
  await f.register();const asset=key(),berth=randomUUID(),job=randomUUID();
  await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berth},${f.wallet},${f.base},'berth',4,4)`;
  await f.conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) select ${job},player_wallet,base_id,${berth},kind,started_at,finishes_at,completed_at from builder_jobs where id=${f.job}`;
  await f.conn.sql`insert into vehicle_mint_registry(asset_id,collection,family,tier,owner_attestation) values(${asset},${f.collection},'survey_balloon',4,'{}')`;
  const results=await Promise.allSettled([f.reserve(),f.conn.sql`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${f.wallet},${randomUUID()},${asset},${f.base},${berth})`]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(1);
 }),30_000);
 it('reserves the same asset globally only once even across bases',async()=>fixture(async f=>{
  await f.register();const base=randomUUID(),berth=randomUUID(),job=randomUUID();await f.conn.sql`insert into bases(id,owner_wallet) values(${base},${f.wallet})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},2,${base})`;
  await f.conn.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty) values(${berth},${f.wallet},${base},'berth',4,4)`;await f.conn.sql`insert into builder_jobs(id,player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) select ${job},player_wallet,${base},${berth},kind,started_at,finishes_at,completed_at from builder_jobs where id=${f.job}`;
  const results=await Promise.allSettled([f.reserve(),f.conn.sql`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${f.wallet},${randomUUID()},${f.asset},${base},${berth})`]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(1);
 }),30_000);
 it('rejects forged derived fields and missing or unfinished original build proof',async()=>fixture(async f=>{
  await f.register();await expect(f.conn.sql`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id,family,tier) values(${f.wallet},${randomUUID()},${f.asset},${f.base},${f.berth},'cargo_cutter',4)`).rejects.toThrow('VEHICLE_DERIVED_FIELDS');
  await f.conn.sql`update builder_jobs set completed_at=null where id=${f.job}`;await expect(f.reserve()).rejects.toThrow('VEHICLE_BERTH_UNAVAILABLE');expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(0);
 }),30_000);
 it('protects original berth and build identity but permits legitimate moves and level upgrades',async()=>fixture(async f=>{
  await f.register();await f.reserve();await f.conn.sql`update buildings set tx=tx+1,level=level+1 where id=${f.berth}`;
  for(const command of [`update buildings set type='camp' where id='${f.berth}'`,`update buildings set base_id=null where id='${f.berth}'`,`update buildings set level=0 where id='${f.berth}'`,`delete from buildings where id='${f.berth}'`,`update builder_jobs set completed_at=null where id='${f.job}'`,`update builder_jobs set finishes_at=finishes_at+interval '1 second' where id='${f.job}'`,`delete from builder_jobs where id='${f.job}'`])await expect(f.conn.sql.unsafe(command)).rejects.toThrow();
  await expect(f.conn.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at) values(${f.wallet},${f.base},${f.berth},'build',now(),now())`).rejects.toThrow('VEHICLE_PROVENANCE_RESERVED');
  expect((await f.conn.sql`select completed_build_job_id from vehicle_activation_reservations`)[0]!.completed_build_job_id).toBe(f.job);
 }),30_000);
 it('holds stale isolation and real locked build provenance, then succeeds after release',async()=>fixture(async f=>{
  await f.register();await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select count(*) from players`;await tx`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${f.wallet},${randomUUID()},${f.asset},${f.base},${f.berth})`;})).rejects.toThrow('VEHICLE_READ_COMMITTED_REQUIRED');
  let ready!:()=>void,release!:()=>void;const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r),writer=f.conn.sql.begin(async tx=>{await tx`select id from builder_jobs where id=${f.job} for update`;ready();await gate;});
  try{await started;await expect(f.reserve()).rejects.toMatchObject({code:'55P03'});expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(0);}finally{release();await writer;}await f.reserve();
 }),30_000);
 it('refuses a stale provenance writer whose snapshot predates the committed reservation',async()=>fixture(async f=>{
  await f.register();await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{
   expect(await tx`select * from vehicle_activation_reservations`).toHaveLength(0);
   await f.reserve();await tx`update builder_jobs set completed_at=completed_at+interval '1 second' where id=${f.job}`;
  })).rejects.toThrow('VEHICLE_READ_COMMITTED_REQUIRED');
  const [proof]=await f.conn.sql`select j.completed_at=r.berth_completed_at same from builder_jobs j join vehicle_activation_reservations r on r.completed_build_job_id=j.id`;expect(proof!.same).toBe(true);
 }),30_000);
 it('retains both immutable tables through raw repeat and refuses update, delete and truncate',async()=>fixture(async f=>{
  await f.register();await f.reserve();const before=await f.conn.sql`select * from vehicle_activation_reservations`;
  for(const table of ['vehicle_mint_registry','vehicle_activation_reservations'])for(const command of [`update ${table} set asset_id=asset_id`,`delete from ${table}`,`truncate ${table} cascade`])await expect(f.conn.sql.unsafe(command)).rejects.toThrow();
  for(let n=0;n<2;n++)for(const tag of ['0204_vehicle_activation_reservations','0205_vehicle_activation_guards'])await f.conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});expect(await f.conn.sql`select * from vehicle_activation_reservations`).toEqual(before);
 }),30_000);
 it('keeps private tables inaccessible to an old runtime LOGIN and rejects accidental grants and forged triggers',async()=>fixture(async f=>{
  const role='vehicle_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{const [database]=await f.conn.sql`select current_database() name`;await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant select,insert,update on players,bases,base_slots,buildings,builder_jobs,fleet_installations to ${role};grant usage,select on all sequences in schema public to ${role}`);const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
   await expect(runtime.sql`select * from vehicle_activation_reservations`).rejects.toMatchObject({code:'42501'});
   await runtime.sql`insert into fleet_installations(base_id,berth_id,family,installed_wallet,completed_build_job_id,berth_completed_at) select ${f.base},${f.berth},'starter',${f.wallet},${f.job},completed_at from builder_jobs where id=${f.job}`;
   await f.register();await f.conn.sql.unsafe(`grant all on vehicle_mint_registry,vehicle_activation_reservations to ${role};grant execute on all functions in schema public to ${role};grant create on schema public to ${role}`);
   await expect(runtime.sql`insert into vehicle_mint_registry(asset_id,collection,family,tier,owner_attestation) values(${f.asset},${f.collection},'survey_balloon',1,'{}')`).rejects.toMatchObject({code:'42501'});
   await expect(runtime.sql`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${f.wallet},${randomUUID()},${f.asset},${f.base},${f.berth})`).rejects.toMatchObject({code:'42501'});
   await runtime.sql.unsafe('create table fake_starter (like fleet_installations including defaults);create trigger vehicle_starter_exclusion before insert on fake_starter for each row execute function public.shardkeep_vehicle_starter_exclusion()');
   await expect(runtime.sql`insert into fake_starter(base_id,berth_id,family,installed_wallet,completed_build_job_id,berth_completed_at) values(${f.base},${f.berth},'starter',${f.wallet},${f.job},now())`).rejects.toThrow('VEHICLE_TRIGGER_IDENTITY');
   await runtime.sql.unsafe('create table fake_vehicle (like vehicle_mint_registry including defaults);create trigger fake_vehicle_guard before insert on fake_vehicle for each row execute function public.shardkeep_vehicle_private_guard()');
   await expect(runtime.sql`insert into fake_vehicle(asset_id,collection,family,tier,owner_attestation) values(${f.asset},${f.collection},'survey_balloon',1,'{}')`).rejects.toThrow('VEHICLE_TRIGGER_IDENTITY');
  }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }),30_000);
 it('commits before returning, replays exact requests, and rejects idempotency changes and outer transactions',async()=>fixture(async f=>{
  const {createVehicleActivationReservations}=await import('../src/game/vehicleActivationReservations');const service=createVehicleActivationReservations(f.conn.db);
  expect(Object.keys(service).sort()).toEqual(['get','getByKey','register','reserve']);await service.register({assetId:f.asset,collection:f.collection,family:'survey_balloon',tier:1},{fixture:'owner assertion only'});
  const input={wallet:f.wallet,assetId:f.asset,berthId:f.berth,idempotencyKey:randomUUID()},authority={baseId:f.base,assertAuthority:async(tx:Parameters<typeof assertFreshLockedBaseAuthority>[0],wallet:string,id:string)=>{await assertFreshLockedBaseAuthority(tx,wallet,id);}};
  const saved=await service.reserve(input,authority);expect(await service.reserve(input,authority)).toEqual(saved);expect(await service.get(saved.id)).toEqual(saved);
  const reopened=f.conn.reopen();try{expect(await reopened.sql`select id from vehicle_activation_reservations where id=${saved.id}`).toHaveLength(1);}finally{await reopened.sql.end();}
  await expect(service.reserve({...input,berthId:randomUUID()},authority)).rejects.toMatchObject({code:'VEHICLE_IDEMPOTENCY_CONFLICT'});
  await expect(f.conn.db.transaction(async tx=>createVehicleActivationReservations(tx as unknown as Db))).rejects.toMatchObject({code:'VEHICLE_TOP_LEVEL_REQUIRED'});
 }),30_000);
 it('rolls back failed authority and raw transactions without inventing a reservation',async()=>fixture(async f=>{
  const {createVehicleActivationReservations}=await import('../src/game/vehicleActivationReservations');const service=createVehicleActivationReservations(f.conn.db);await f.register();
  await expect(service.reserve({wallet:f.wallet,assetId:f.asset,berthId:f.berth,idempotencyKey:randomUUID()},{baseId:f.base,assertAuthority:async()=>{throw Error('authority unavailable');}})).rejects.toThrow('authority unavailable');
  await expect(f.conn.sql.begin(async tx=>{await tx`insert into vehicle_activation_reservations(wallet,idempotency_key,asset_id,base_id,berth_id) values(${f.wallet},${randomUUID()},${f.asset},${f.base},${f.berth})`;throw Error('rollback');})).rejects.toThrow('rollback');expect(await f.conn.sql`select * from vehicle_activation_reservations`).toHaveLength(0);
 }),30_000);
});
