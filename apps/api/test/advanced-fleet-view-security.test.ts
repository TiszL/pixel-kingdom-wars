/** Current-owner fleet boundary over actual Core installation/service fixtures.
 * Damaged immutable rows are explicit owner-storage corruption, not a role exploit. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {BASE_OWNERSHIP} from '@shardkeep/shared';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {vehicleServiceInstalledFixture,vehicleServiceConsentFixture} from './fixtures/vehicleServicePreparation';
import {createVehicleServiceApplications} from '../src/game/vehicleServiceApplications';
import {registerOwnedDeed,type FinalizedDeedReader} from '../src/game/baseOwnership';
import {deedOwnershipObservations} from '../src/db/schema';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';

let f:Awaited<ReturnType<typeof vehicleServiceInstalledFixture>>;
beforeEach(async()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');
 f=await vehicleServiceInstalledFixture();
},120_000);
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function factory(){return (await import('../src/game/advancedFleetView')).createAdvancedFleetView;}
async function view(){return (await factory())(f.conn.db);}
async function snapshot(){
 const state:Record<string,unknown>={};
 for(const table of ['vehicle_burn_consumptions','advanced_vehicle_installations','vehicle_service_intents','vehicle_service_burn_preparations','vehicle_service_consumptions','vehicle_service_applications','advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','resource_stocks','accounts'])state[table]=await f.conn.sql.unsafe(`select to_jsonb(t)::text row from ${table} t order by to_jsonb(t)::text`);
 return state;
}
async function service(){const s=await vehicleServiceConsentFixture(f),p=await s.preparations.prepare(f.actor,s.intent.id);s.finalizeService(p);return {...s,applications:createVehicleServiceApplications(f.conn.db,{verifyBurn:s.reader.verify})};}
async function withPlayerWait<T>(read:()=>Promise<T>,during:()=>Promise<void>):Promise<T>{
 const blocker=f.conn.reopen();let signal!:()=>void,release!:()=>void,pid=0;
 const ready=new Promise<void>(r=>signal=r),gate=new Promise<void>(r=>release=r);
 const holder=blocker.sql.begin(async tx=>{await tx`select wallet from players where wallet=${f.actor} for update`;pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;signal();await gate;});
 let pending:Promise<T>|undefined;
 try{
  await ready;pending=read();void pending.catch(()=>undefined);
  // This observes the actual second connection waiting on the canonical root,
  // not a timed sleep or a mocked database completion.
  await expect.poll(async()=>(await f.conn.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and query like '%players%') waiting`)[0]!.waiting).toBe(true);
  await during();release();return await pending;
 }finally{release();await holder;await pending?.catch(()=>undefined);await blocker.sql.end();}
}

it('holds committed initial and service half graphs instead of returning an empty or earlier fleet',async()=>{
 const provider=await view(),[saved]=await f.conn.sql`select to_jsonb(i) row from advanced_vehicle_installations i where reservation_id=${f.reservation.id}`;
 // Initial pair was genuinely finalized. Removing only its effect must not make
 // the consumed NFT and permanently occupied berth disappear from the snapshot.
 await f.conn.sql.begin(async tx=>{await tx`alter table advanced_vehicle_installations disable trigger advanced_vehicle_installations_guard`;await tx`delete from advanced_vehicle_installations where reservation_id=${f.reservation.id}`;await tx`alter table advanced_vehicle_installations enable trigger advanced_vehicle_installations_guard`;});
 try{const before=await snapshot();await expect(provider.read(f.actor,f.baseId)).rejects.toMatchObject({code:'ADVANCED_FLEET_HELD'});expect(await snapshot()).toEqual(before);}
 finally{await f.conn.sql.begin(async tx=>{await tx`alter table advanced_vehicle_installations disable trigger advanced_vehicle_installations_guard`;await tx`insert into advanced_vehicle_installations select * from jsonb_populate_record(null::advanced_vehicle_installations,${JSON.stringify(saved!.row)}::jsonb)`;await tx`set constraints advanced_vehicle_installations_complete immediate`;await tx`alter table advanced_vehicle_installations enable trigger advanced_vehicle_installations_guard`;});}
 expect((await provider.read(f.actor,f.baseId)).vehicles[0]!.tier).toBe(1);
 const s=await service();await s.applications.recover(f.actor,s.intent.id);
 expect((await provider.read(f.actor,f.baseId)).vehicles[0]!).toMatchObject({tier:2,revision:1,pendingService:false});
 await f.conn.sql.begin(async tx=>{await tx`alter table vehicle_service_applications disable trigger vehicle_service_applications_guard`;await tx`delete from vehicle_service_applications where intent_id=${s.intent.id}`;await tx`alter table vehicle_service_applications enable trigger vehicle_service_applications_guard`;});
 const before=await snapshot();await expect(provider.read(f.actor,f.baseId)).rejects.toMatchObject({code:'ADVANCED_FLEET_HELD'});expect(await snapshot()).toEqual(before);
 expect(await f.conn.sql`select tgname from pg_trigger where tgrelid in('public.advanced_vehicle_installations'::regclass,'public.vehicle_service_applications'::regclass) and tgenabled<>'O'`).toHaveLength(0);
},30_000);

it('refuses a paid deed proof that expires during an observed player lock wait without changing vehicle or stock state',async()=>{
 const now=new Date('2035-01-01T01:00:00.000Z');vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 const mint=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);
 await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:now,status:'owned',source:'rpc-finalized',auditHash:randomUUID()});
 const provider=await view(),before=await snapshot();
 await expect(withPlayerWait(()=>provider.read(f.actor,f.baseId),async()=>{vi.setSystemTime(new Date(+now+BASE_OWNERSHIP.mutationFreshnessMs+1));})).rejects.toMatchObject({code:'DEED_AUTHORITY_UNAVAILABLE'});
 expect(await snapshot()).toEqual(before);
},30_000);

it('reads a real service commit and the final pause flag after its player lock wait',async()=>{
 const s=await service(),provider=await view();expect((await provider.read(f.actor,f.baseId)).vehicles[0]!).toMatchObject({tier:1,revision:0,pendingService:true});
 let committed:Awaited<ReturnType<typeof snapshot>>|undefined;
 const result=await withPlayerWait(()=>provider.read(f.actor,f.baseId),async()=>{
  const receipt=await s.applications.recover(f.actor,s.intent.id);expect(receipt).toMatchObject({tierAfter:2,revisionAfter:1});
  vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');committed=await snapshot();
 });
 expect(result.acceptingNewActions).toBe(false);expect(result.vehicles).toEqual([expect.objectContaining({installationId:f.reservation.id,tier:2,revision:1,completedTotal:'0',allowanceStart:'0',away:false,pendingService:false})]);
 expect(await snapshot()).toEqual(committed);
},30_000);

it('holds a busy installation without waiting or returning partial fleet state, then retries after release',async()=>{
 const provider=await view(),before=await snapshot(),blocker=f.conn.reopen();let signal!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>signal=r),gate=new Promise<void>(r=>release=r);
 const holder=blocker.sql.begin(async tx=>{await tx`select reservation_id from advanced_vehicle_installations where reservation_id=${f.reservation.id} for update`;signal();await gate;});
 let pending:ReturnType<typeof provider.read>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await ready;pending=provider.read(f.actor,f.baseId);
  const result=await Promise.race([pending.then(value=>({value}),error=>({error})),new Promise<{timedOut:true}>(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),5000);})]);
  expect(result).toMatchObject({error:{code:'ADVANCED_FLEET_BUSY'}});expect(await snapshot()).toEqual(before);
 }finally{if(timer)clearTimeout(timer);release();await holder;await pending?.catch(()=>undefined);await blocker.sql.end();}
 expect((await provider.read(f.actor,f.baseId)).vehicles).toHaveLength(1);expect(await snapshot()).toEqual(before);
},30_000);

it('keeps current fleet capability owner-only despite accidental private grants and rejects outer transactions',async()=>{
 const make=await factory(),before=await snapshot();
 await f.conn.db.transaction(async tx=>{expect(()=>Reflect.apply(make,undefined,[tx])).toThrow(expect.objectContaining({code:'ADVANCED_FLEET_TOP_LEVEL'}));});
 const role='fleet_private_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  const [database]=await f.conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(runtime.sql`select * from advanced_vehicle_installations`).rejects.toMatchObject({code:'42501'});
  const provider=make(runtime.db);await expect(provider.read(f.actor,f.baseId)).rejects.toMatchObject({code:'ADVANCED_FLEET_OWNER'});
  await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  expect(await runtime.sql`select has_table_privilege(current_user,'advanced_vehicle_installations','SELECT') reads,current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_vehicle_installations'::regclass) owns`).toEqual([{reads:true,owns:false}]);
  await expect(provider.read(f.actor,f.baseId)).rejects.toMatchObject({code:'ADVANCED_FLEET_OWNER'});expect(await snapshot()).toEqual(before);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
},30_000);

it('retains its configured deed reader and collection instead of consulting later dependency replacements',async()=>{
 const mint=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);
 // This is the existing trusted finalized-deed callback boundary. It tests
 // capability capture, not live-chain verification or independent mint provenance.
 const reader=vi.fn<FinalizedDeedReader>(async asset=>{expect(asset).toBe(mint);return {owner:f.actor,collection,frozen:false,delegate:null,slot:100};}),replacement=vi.fn<FinalizedDeedReader>(async()=>{throw Error('replacement deed source');});
 const deps={finalizedDeedReader:reader,deedCollection:collection},provider=(await factory())(f.conn.db,deps),before=await snapshot();
 deps.finalizedDeedReader=replacement;deps.deedCollection=Keypair.generate().publicKey.toBase58();
 expect((await provider.read(f.actor,f.baseId)).vehicles[0]!.installationId).toBe(f.reservation.id);expect(reader).toHaveBeenCalledTimes(1);expect(replacement).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
},30_000);
