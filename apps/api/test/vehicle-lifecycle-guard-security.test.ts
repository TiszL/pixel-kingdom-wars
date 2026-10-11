/** Old migration replay tests retain their original functions. These cases
 * exercise the versioned guards actually attached by0214, using a real LOGIN. */
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {vehicleServicePreparationFixture} from './fixtures/vehicleServicePreparation';

let f:Awaited<ReturnType<typeof vehicleServicePreparationFixture>>;
beforeEach(async()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');f=await vehicleServicePreparationFixture();},120_000);
afterEach(async()=>{vi.unstubAllEnvs();await f?.dispose();},120_000);
const guards=[
 {table:'advanced_expeditions',fn:'shardkeep_advanced_expedition_guard_v214',identityError:'ADVANCED_TRIGGER_IDENTITY',ownerError:'ADVANCED_OWNER'},
 {table:'vehicle_service_intents',fn:'shardkeep_vehicle_service_intent_guard_v214',identityError:'VEHICLE_SERVICE_TRIGGER',ownerError:'VEHICLE_SERVICE_OWNER'},
 {table:'vehicle_service_burn_preparations',fn:'shardkeep_vehicle_service_preparation_guard_v214',identityError:'VEHICLE_SERVICE_PREPARATION_TRIGGER',ownerError:'VEHICLE_SERVICE_PREPARATION_OWNER'},
] as const;

it.each(guards)('$table active versioned guard rejects accidental grants and a copied trigger',async({table,fn,identityError,ownerError})=>{
 const trigger=table+'_guard',before=await f.conn.sql`select to_jsonb(t) row from ${f.conn.sql(table)} t`;
 expect(await f.conn.sql`select p.proname,t.tgenabled from pg_trigger t join pg_proc p on p.oid=t.tgfoid
  where t.tgrelid=${'public.'+table}::regclass and t.tgname=${trigger}`).toEqual([{proname:fn,tgenabled:'O'}]);
 const role='lifecycle_guard_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await f.conn.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  const [database]=await f.conn.sql`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(runtime.sql`select * from ${runtime.sql(table)}`).rejects.toMatchObject({code:'42501'});
  await f.conn.sql.unsafe(`grant create,usage on schema public to ${role};grant all on ${table} to ${role};grant execute on function public.${fn}() to ${role}`);
  expect(await runtime.sql`select has_table_privilege(current_user,${table},'INSERT') writes,current_user::regrole::oid=(select relowner from pg_class where oid=${'public.'+table}::regclass) owns`).toEqual([{writes:true,owns:false}]);
  const field=table==='vehicle_service_burn_preparations'?'intent_id':'id',id=field==='intent_id'?f.intent.id:randomUUID();
  // BEFORE row authority must refuse even a malformed candidate; NOT NULL or
  // FK validation is not evidence of the active owner boundary.
  await expect(runtime.sql`insert into ${runtime.sql(table)}(${runtime.sql(field)}) values(${id})`).rejects.toMatchObject({code:'42501',message:ownerError});
  await runtime.sql`create table copied_lifecycle_guard(like ${runtime.sql(table)} including defaults)`;
  await runtime.sql`create trigger ${runtime.sql(trigger)} before insert on copied_lifecycle_guard for each row execute function public.${runtime.sql(fn)}()`;
  // The role now owns the fake table and has the genuine function's EXECUTE
  // grant. Exact table identity must still reject the copied stable trigger name.
  await expect(runtime.sql`insert into copied_lifecycle_guard(${runtime.sql(field)}) values(${id})`).rejects.toMatchObject({code:'P0001',message:identityError});
  expect(await runtime.sql`select * from copied_lifecycle_guard`).toHaveLength(0);
  expect(await f.conn.sql`select to_jsonb(t) row from ${f.conn.sql(table)} t`).toEqual(before);
  expect(await f.conn.sql`select * from vehicle_service_consumptions`).toHaveLength(0);expect(await f.conn.sql`select * from vehicle_service_applications`).toHaveLength(0);
 }finally{await runtime?.sql.end();await f.conn.sql.unsafe(`drop owned by ${role}`);await f.conn.sql.unsafe(`drop role ${role}`);}
},30_000);
