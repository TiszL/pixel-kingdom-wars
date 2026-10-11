/** Security acceptance for normal-read collection. All earnings originate in
 * actual Core installations and signed Seeker dispatch fixtures. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {BASE_OWNERSHIP} from '@shardkeep/shared';
import {RAW_RESOURCE_STORAGE_MAX} from '@shardkeep/shared/phaseEResources';
import type {FastifyInstance} from 'fastify';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {vehicleServiceInstalledFixture} from './fixtures/vehicleServicePreparation';
import {vehicleServiceExpeditions} from './fixtures/vehicleService';
import {registerOwnedDeed,type FinalizedDeedReader} from '../src/game/baseOwnership';
import {deedOwnershipObservations,sessions} from '../src/db/schema';
import {createDb} from '../src/db/client';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {ADMIN_DATABASE_URL} from './db-url';
import {TEST_CONFIG} from './helpers';

let f:Awaited<ReturnType<typeof vehicleServiceInstalledFixture>>,trips:Awaited<ReturnType<typeof vehicleServiceExpeditions>>;
const apps:FastifyInstance[]=[];
beforeEach(async()=>{
 for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');vi.stubEnv('FREE_ONBOARDING','true');
 f=await vehicleServiceInstalledFixture();trips=await vehicleServiceExpeditions(f);
},120_000);
afterEach(async()=>{await Promise.all(apps.splice(0).map(app=>app.close()));vi.restoreAllMocks();vi.useRealTimers();vi.unstubAllEnvs();await f?.dispose();},120_000);
async function factory(){return (await import('../src/game/advancedExpeditionGameplay')).createAdvancedExpeditionGameplay;}
async function due(){const trip=await trips.depart();vi.setSystemTime(trip.returnsAt);return trip;}
async function snapshot(){
 const state:Record<string,unknown>={};
 for(const table of ['advanced_expeditions','advanced_expedition_inflight','advanced_expedition_returns','advanced_expedition_entries','advanced_expedition_supplies','resource_stock_operations','resource_stock_entries','resource_stocks','vehicle_service_applications','accounts'])state[table]=await f.conn.sql.unsafe(`select to_jsonb(t)::text row from ${table} t order by to_jsonb(t)::text`);
 return state;
}
async function session(){const [s]=await f.conn.db.insert(sessions).values({wallet:f.actor,expiresAt:new Date(Date.now()+SESSION_TTL_SEC*1000)}).returning();return {[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,f.actor,s!.id)};}
async function open(provider:{collectForBaseRead:(wallet:string,requestedBaseId?:string)=>Promise<string|null>}){
 const old=process.env.MULTI_BASE_ENABLED;vi.stubEnv('MULTI_BASE_ENABLED','false');
 try{const app=await buildApp(TEST_CONFIG,f.conn.db,{advancedExpeditionGameplay:provider});apps.push(app);await app.ready();return app;}finally{vi.stubEnv('MULTI_BASE_ENABLED',old);}
}

it('rechecks paid custody after a real player wait and retains constructor dependencies for the successful retry',async()=>{
 const trip=await due(),now=new Date(),mint=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();
 expect((await registerOwnedDeed(f.conn.db,f.actor,mint)).id).toBe(f.baseId);
 await f.conn.db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:mint,owner:f.actor,slot:100n,checkedAt:now,status:'owned',source:'rpc-finalized',auditHash:randomUUID()});
 const reader=vi.fn<FinalizedDeedReader>(async asset=>{expect(asset).toBe(mint);return {owner:f.actor,collection,frozen:false,delegate:null,slot:101};}),replacement=vi.fn<FinalizedDeedReader>(async()=>{throw Error('replacement source');});
 const deps={finalizedDeedReader:reader,deedCollection:collection},provider=(await factory())(f.conn.db,deps);deps.finalizedDeedReader=replacement;deps.deedCollection=Keypair.generate().publicKey.toBase58();
 const before=await snapshot(),blocker=f.conn.reopen();let signal!:()=>void,release!:()=>void,pid=0;
 const ready=new Promise<void>(r=>signal=r),gate=new Promise<void>(r=>release=r),holder=blocker.sql.begin(async tx=>{await tx`select wallet from players where wallet=${f.actor} for update`;pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;signal();await gate;});
 let pending:Promise<string|null>|undefined;
 try{
  await ready;pending=provider.collectForBaseRead(f.actor,f.baseId);void pending.catch(()=>undefined);
  await expect.poll(async()=>(await f.conn.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid)) and query like '%players%') waiting`)[0]!.waiting).toBe(true);
  vi.setSystemTime(new Date(+now+BASE_OWNERSHIP.mutationFreshnessMs+1));release();await expect(pending).rejects.toMatchObject({code:'DEED_AUTHORITY_UNAVAILABLE'});
 }finally{release();await holder;await pending?.catch(()=>undefined);await blocker.sql.end();}
 expect(reader).not.toHaveBeenCalled();expect(replacement).not.toHaveBeenCalled();expect(await snapshot()).toEqual(before);
 expect(await provider.collectForBaseRead(f.actor,f.baseId)).toBe(f.baseId);expect(reader).toHaveBeenCalledTimes(1);expect(replacement).not.toHaveBeenCalled();
 expect(await f.conn.sql`select completed_total from advanced_expedition_returns where expedition_id=${trip.id}`).toEqual([{completed_total:'1'}]);
},30_000);

it('rejects outer transactions and nonowner collection even for omitted empty-base requests and accidental ALL grants',async()=>{
 await due();const make=await factory(),before=await snapshot(),absent=Keypair.generate().publicKey.toBase58();
 await f.conn.db.transaction(async tx=>{expect(()=>Reflect.apply(make,undefined,[tx])).toThrow(expect.objectContaining({code:expect.stringMatching(/_TOP_LEVEL$/)}));});
 const role='advanced_lazy_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  const [database]=await f.conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  const provider=make(runtime.db);await expect(runtime.sql`select * from advanced_expeditions`).rejects.toMatchObject({code:'42501'});
  for(const grant of [false,true]){
   if(grant)await f.conn.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
   for(const action of [()=>provider.collectForBaseRead(f.actor,f.baseId),()=>provider.collectForBaseRead(f.actor),()=>provider.collectForBaseRead(absent)])await expect(action()).rejects.toMatchObject({code:expect.stringMatching(/_OWNER$/)});
  }
  expect(await snapshot()).toEqual(before);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
},30_000);

it('holds damaged original supply and stock overflow without any partial return, tax credit or completed use',async()=>{
 const trip=await due(),provider=(await factory())(f.conn.db),app=await open(provider),cookies=await session();
 const held=async()=>{const response=await app.inject({url:'/base?baseId='+f.baseId,cookies});expect(response.statusCode,response.body).toBe(503);expect(response.json().error.code).toBe('ADVANCED_COLLECTION_HELD');};
 const [entry]=await f.conn.sql`select to_jsonb(e) row from resource_stock_entries e join advanced_expedition_supplies s on s.consume_id=e.operation_id where s.expedition_id=${trip.id} and e.bucket='reserved' limit 1`;
 expect(entry).toBeDefined();const row=entry!.row as {operation_id:string;bucket:string};
 // Explicitly damage owner storage, restoring the exact immutable guard before
 // invoking normal collection. The remaining proof must not be accepted.
 await f.conn.sql.begin(async tx=>{await tx`alter table resource_stock_entries disable trigger resource_stock_entry_immutable`;await tx`delete from resource_stock_entries where operation_id=${row.operation_id} and bucket=${row.bucket}`;await tx`alter table resource_stock_entries enable trigger resource_stock_entry_immutable`;});
 const damaged=await snapshot();await held();expect(await snapshot()).toEqual(damaged);
 await f.conn.sql.begin(async tx=>{await tx`insert into resource_stock_entries select * from jsonb_populate_record(null::resource_stock_entries,${JSON.stringify(entry!.row)}::jsonb)`;await tx`set constraints resource_stock_entry_proof immediate`;});
 const [prior]=await f.conn.sql`select available,reserved from resource_stocks where base_id=${f.baseId} and resource_id=${trip.resourceId}`;
 await f.conn.sql`insert into resource_stocks(base_id,resource_id,available,reserved) values(${f.baseId},${trip.resourceId},${String(RAW_RESOURCE_STORAGE_MAX)},0) on conflict(base_id,resource_id) do update set available=excluded.available,reserved=0`;
 const full=await snapshot();await held();expect(await snapshot()).toEqual(full);
 await f.conn.sql`update resource_stocks set available=${prior?.available??'0'},reserved=${prior?.reserved??'0'} where base_id=${f.baseId} and resource_id=${trip.resourceId}`;
 expect(await provider.collectForBaseRead(f.actor,f.baseId)).toBe(f.baseId);
 expect(await f.conn.sql`select completed_total from advanced_expedition_returns where expedition_id=${trip.id}`).toEqual([{completed_total:'1'}]);
 expect((await f.conn.sql`select sum(delta)::text total from advanced_expedition_entries`)[0]!.total).toBe('0');
},30_000);

it('overrides an actual repeatable-read session default with the required READ COMMITTED collection',async()=>{
 const trip=await due(),[database]=await f.conn.sql`select current_database() name`;let connection:ReturnType<typeof f.conn.reopen>|undefined;
 await f.conn.sql`alter database ${f.conn.sql(String(database!.name))} set default_transaction_isolation to 'repeatable read'`;
 try{
  connection=f.conn.reopen();expect((await connection.sql`show transaction_isolation`)[0]!.transaction_isolation).toBe('repeatable read');
  const provider=(await factory())(connection.db);expect(await provider.collectForBaseRead(f.actor,f.baseId)).toBe(f.baseId);
  expect(await f.conn.sql`select completed_total from advanced_expedition_returns where expedition_id=${trip.id}`).toEqual([{completed_total:'1'}]);
  expect((await connection.sql`show transaction_isolation`)[0]!.transaction_isolation).toBe('repeatable read');
 }finally{await connection?.sql.end();await f.conn.sql`alter database ${f.conn.sql(String(database!.name))} reset default_transaction_isolation`;}
},30_000);

it('pins the collected base for the ordinary handler and captures its mounted method before a second slot appears',async()=>{
 const trip=await due(),actual=(await factory())(f.conn.db),second=randomUUID(),cookies=await session();let originalCalls=0;
 const provider={collectForBaseRead:async(wallet:string,requested?:string)=>{
  originalCalls++;expect(requested).toBeUndefined();const selected=await actual.collectForBaseRead(wallet,requested);expect(selected).toBe(f.baseId);
  // A real additional owned active base appears after collection, before the
  // original /base handler resolves its request. Only the pinned identity is safe.
  await f.conn.sql`insert into bases(id,owner_wallet) values(${second},${f.actor})`;await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.actor},2,${second})`;return selected;
 }};
 const app=await open(provider);
 const replacement=vi.fn(async()=>{throw Error('Replaced mount');});provider.collectForBaseRead=replacement;
 const response=await app.inject({url:'/base',cookies});expect(response.statusCode,response.body).toBe(200);expect(response.json().baseId).toBe(f.baseId);
 expect(originalCalls).toBe(1);expect(replacement).not.toHaveBeenCalled();expect(await f.conn.sql`select base_id from base_slots where wallet=${f.actor} and active`).toHaveLength(2);
 expect(await f.conn.sql`select completed_total from advanced_expedition_returns where expedition_id=${trip.id}`).toEqual([{completed_total:'1'}]);
 expect(await f.conn.sql`select id from advanced_expeditions where base_id=${second}`).toHaveLength(0);
},30_000);
