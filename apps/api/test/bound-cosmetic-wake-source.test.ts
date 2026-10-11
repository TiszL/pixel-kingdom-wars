/** Private, prospective Wake source acceptance. Synthetic local chain/term
 * fixtures are not production admission or native/rendering evidence. */
import {randomUUID} from 'node:crypto';
import {cp,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {Keypair,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {vehicleBurnDatabase} from './fixtures/vehicleBurn';
import {createVehicleInstallations} from '../src/game/vehicleInstallations';
import {installStarterFleet} from '../src/game/starterFleet';
import {assertFreshLockedBaseAuthority} from '../src/game/baseOwnership';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {prefetchExpeditionTermReader} from '../src/game/expeditionTermReader';
import {dispatchAdvancedExpedition} from '../src/game/advancedExpeditionDispatch';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {settleDueAdvancedExpeditions} from '../src/game/advancedExpeditionReturns';
import {settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {startOrdinaryEquipment} from '../src/game/ordinaryEquipment';
import {settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {runMigrations} from '../src/db/migrate';
import {bootstrapSystemAccounts} from '../src/ledger';
import {ADMIN_DATABASE_URL} from './db-url';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {boundCosmeticFixture,earnBoundBlueprint,cosmeticMaterials,cosmeticInsert} from './fixtures/boundCosmetics';
import {BoundCosmeticWakePreferenceResponseSchema,BoundCosmeticWakeReadSchema} from '@shardkeep/shared/boundCosmeticWake';

const migrations=fileURLToPath(new URL('../drizzle',import.meta.url));
const baseUrl=new URL(ADMIN_DATABASE_URL);
if(!['localhost','127.0.0.1','[::1]'].includes(baseUrl.hostname))throw Error('Owned loopback Wake fixture required');
const name=`bound_wake_${randomUUID().replaceAll('-','')}_test`;baseUrl.pathname='/'+name;
const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}}),conn=createDb(baseUrl.toString(),{max:4});
const apply=async(tx:postgres.TransactionSql,body:string)=>{for(const statement of body.split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);};
let wakeSql:string,sourceSql:string,prior:Record<string,unknown>,legacy:string;
const sealedTables=['bound_cosmetic_return_contract','divine_fragment_bound_cosmetics_contract','bound_cosmetic_charter_contract','advanced_return_capability_seal','ordinary_equipment_starter_return_seal'];
async function seals(){const record:Record<string,unknown>={};for(const table of sealedTables)record[table]=await conn.sql.unsafe(`select * from public.${table}`);return record;}
const flags=()=>{for(const flag of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_CATALOG_ENABLED','ORDINARY_CRAFTING_ENABLED','PHASE_E_VEHICLES_ENABLED'])vi.stubEnv(flag,'true');};
beforeAll(async()=>{
 await admin.unsafe(`create database ${name}`);const folder=await mkdtemp(join(tmpdir(),'bound-wake-source-journal-'));
 try{await cp(migrations,folder,{recursive:true});const path=join(folder,'meta/_journal.json'),journal=JSON.parse(await readFile(path,'utf8')) as {entries:{tag:string}[]};
  const index=journal.entries.findIndex(e=>e.tag==='0281_bound_cosmetic_visual_source');if(index<0)throw Error('Missing accepted Wake predecessor');
  await writeFile(path,JSON.stringify({...journal,entries:journal.entries.slice(0,index+1)}));await runMigrations(conn.db,{migrationsFolder:folder});
 }finally{await rm(folder,{recursive:true,force:true});}
 await bootstrapSystemAccounts(conn.db);flags();
 const f=await createStarterExpeditionFixture(conn.db,{now:new Date(Date.now()-3*86400000)});legacy=(await f.dispatch()).id;
 prior=await seals();wakeSql=await readFile(join(migrations,'0282_bound_cosmetic_wake.sql'),'utf8');sourceSql=await readFile(join(migrations,'0283_bound_cosmetic_wake_source.sql'),'utf8');
 await conn.sql.begin(tx=>apply(tx,wakeSql));
},180000);
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
afterAll(async()=>{await conn.sql.end();await admin.unsafe(`drop database if exists ${name} with (force)`);await admin.end();});

it('refuses unexpected predecessor and new-source drift before accepting the exact successor',async()=>{
 for(const mutation of [
  'alter table ordinary_equipment_jobs disable trigger bound_cosmetic_workshop_guard',
  'alter function public.shardkeep_settle_due_equipment(uuid,timestamptz) security invoker',
  'alter table starter_expedition_returns disable trigger starter_return_insert_guard',
  'create trigger unexpected_wake_hook after insert on starter_expeditions for each row execute function public.shardkeep_bound_cosmetic_starter_wake_capture()',
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await apply(tx,sourceSql);})).rejects.toThrow('BOUND_COSMETIC_WAKE_PREDECESSOR');
 for(const mutation of [
  'alter table starter_expeditions disable trigger bound_cosmetic_starter_wake_capture',
  'alter table advanced_expeditions disable trigger bound_cosmetic_advanced_wake_capture',
  'alter function public.shardkeep_bound_cosmetic_starter_wake_capture() security invoker',
  'alter table bound_cosmetic_starter_wakes alter column visual drop not null',
  'grant select(selection_record) on bound_cosmetic_starter_wakes to public',
  'alter table bound_cosmetic_wake_preferences alter column enabled set default true',
  'create index unexpected_wake_index on bound_cosmetic_wake_preferences(revision)',
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);await apply(tx,sourceSql);})).rejects.toThrow('BOUND_COSMETIC_WAKE_PRIVATE_SOURCE');
 await conn.sql.begin(tx=>apply(tx,sourceSql));
 expect(await seals()).toEqual(prior);
 await conn.sql`select public.shardkeep_divine_fragment_source(),public.shardkeep_charter_retirement_source(),public.shardkeep_charter_tournament_source_check()`;
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_wake_sources_valid() wake,public.shardkeep_bound_cosmetic_visual_sources_valid() awning,public.shardkeep_bound_cosmetic_return_sources_valid() returns`)[0]).toEqual({wake:true,awning:true,returns:true});
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_starter_wake(${legacy}) visual`)[0]!.visual).toBeNull();
 expect(await conn.sql`select * from bound_cosmetic_starter_wakes where expedition_id=${legacy}`).toHaveLength(0);
},180000);

const plain={state:'available',visual:{version:1,wake:null}};
const unavailable={state:'unavailable',visual:null};
async function earned(wallet?:string){
 flags();const f=await boundCosmeticFixture(conn.db,{slot:2,...wallet?{wallet}:{}});f.now=new Date(Date.now()-3*86400000);
 // Historical local fixture facility proofs predate its actual refine/craft.
 await conn.sql`update builder_jobs set started_at=started_at-interval '20 years',finishes_at=finishes_at-interval '20 years',completed_at=completed_at-interval '20 years' where base_id=${f.baseId}`;
 await earnBoundBlueprint(f);await cosmeticMaterials(f,'craft_aurora_wake_v1');const job=await cosmeticInsert(f,'craft_aurora_wake_v1');
 return {...f,job};
}
const preference=async(wallet:string,enabled:boolean,expected:string,at:Date)=>{
 const [row]=await conn.sql`select public.shardkeep_bound_cosmetic_wake_preference(${wallet},${enabled},${expected}::bigint,${at.toISOString()}::timestamptz) response`;
 return BoundCosmeticWakePreferenceResponseSchema.parse(row!.response);
};
it('requires a completed authentic account Wake, permits free off and recovers only the exact applied CAS',async()=>{
 const f=await earned();
 await expect(preference(f.wallet,true,'0',f.now)).rejects.toThrow('BOUND_COSMETIC_WAKE_NOT_OWNED');
 const off=await preference(f.wallet,false,'0',f.now);expect(off).toEqual({enabled:false,revision:'1',visual:plain});
 await conn.sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${f.job.id},${f.job.readyAt.toISOString()})`;
 const enabled=await preference(f.wallet,true,'1',f.job.readyAt);expect(enabled.enabled).toBe(true);expect(enabled.revision).toBe('2');
 expect(enabled.visual.state==='available'&&enabled.visual.visual.wake?.outputId).toBe('aurora_wake');
 expect(await preference(f.wallet,true,'1',new Date(+f.job.readyAt+1000))).toEqual(enabled);
 await expect(preference(f.wallet,false,'1',new Date(+f.job.readyAt+1000))).rejects.toThrow('BOUND_COSMETIC_PREFERENCE_CHANGED');
 vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');expect(await preference(f.wallet,false,'2',new Date(+f.job.readyAt+1000))).toEqual({enabled:false,revision:'3',visual:plain});
 await expect(preference(f.wallet,true,'3',new Date(Date.now()+86400000))).rejects.toThrow('BOUND_COSMETIC_WAKE_PREFERENCE_INPUT');
 await expect(preference(f.wallet,false,'9223372036854775807',new Date())).rejects.toThrow('BOUND_COSMETIC_WAKE_PREFERENCE_INPUT');
 await expect(preference(f.wallet,false,'-1',new Date())).rejects.toThrow('BOUND_COSMETIC_WAKE_PREFERENCE_INPUT');
 const stranger=await createStarterExpeditionFixture(conn.db,{now:new Date(Date.now()-86400000)});
 expect((await preference(stranger.wallet,false,'0',stranger.now)).visual).toEqual(plain);
 await expect(preference(stranger.wallet,true,'1',stranger.now)).rejects.toThrow('BOUND_COSMETIC_WAKE_NOT_OWNED');
});

it('captures actor-owned selection once, preserves it through off, transfer and paused replay, and distinguishes default trips',async()=>{
 const f=await earned();await conn.sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${f.job.id},${f.job.readyAt.toISOString()})`;
 const enabled=await preference(f.wallet,true,'0',f.job.readyAt);
 const s=await createStarterExpeditionFixture(conn.db,{wallet:f.wallet,now:new Date(+f.job.readyAt+1000)}),trip=await s.dispatch();
 const [saved]=await conn.sql`select visual,selection_record from bound_cosmetic_starter_wakes where expedition_id=${trip.id}`;
 expect(BoundCosmeticWakeReadSchema.parse(saved!.visual)).toEqual(enabled.visual);
 expect(saved!.selection_record).toMatchObject({actorWallet:f.wallet,preferenceRevision:'1',jobId:f.job.id});
 await preference(f.wallet,false,'1',new Date(+s.now+1000));
 const buyer=Keypair.generate().publicKey.toBase58();await conn.sql`insert into players(wallet) values(${buyer})`;
 await conn.sql.begin(async tx=>{await tx`delete from base_slots where base_id=${s.baseId}`;await tx`update bases set owner_wallet=${buyer},status='inactive' where id=${s.baseId}`;});
 vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');expect(await s.dispatch()).toEqual(trip);
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_starter_wake(${trip.id}) visual`)[0]!.visual).toEqual(enabled.visual);
 expect((await conn.sql`select visual,selection_record from bound_cosmetic_starter_wakes where expedition_id=${trip.id}`)[0]).toEqual(saved);
 const fresh=await createStarterExpeditionFixture(conn.db,{now:new Date(Date.now()-86400000)}),plainTrip=await fresh.dispatch();
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_starter_wake(${plainTrip.id}) visual`)[0]!.visual).toEqual(plain);
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_starter_wake(${legacy}) visual`)[0]!.visual).toBeNull();
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_advanced_wake(${randomUUID()}) visual`)[0]!.visual).toBeNull();
});

it('rolls back a captured trip when its later fitting reservation fails, without leaving an appearance original',async()=>{
 flags();const f=await createStarterExpeditionFixture(conn.db,{now:new Date(Date.now()-86400000)});
 const route=starterRoutePreview('crownlands','coastal_survey'),command={...f.command,routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion,fitting:{itemId:'route_compass',policyVersion:1} as const};
 await expect(dispatchStarterExpedition(conn.db,f.wallet,command,f.authority,{reader:f.reader,clock:()=>f.now})).rejects.toThrow();
 expect(await conn.sql`select * from bound_cosmetic_starter_wakes where expedition_id=${command.id}`).toHaveLength(0);
 expect(await conn.sql`select * from starter_expeditions where id=${command.id}`).toHaveLength(0);
 const original=await f.dispatch();expect((await conn.sql`select public.shardkeep_bound_cosmetic_starter_wake(${original.id}) visual`)[0]!.visual).toEqual(plain);
});

it('keeps explicit unavailable capture and immutable selected originals across source corruption',async()=>{
 flags();const f=await createStarterExpeditionFixture(conn.db,{now:new Date(Date.now()-86400000)}),healthy=await f.dispatch();
 const before=(await conn.sql`select * from bound_cosmetic_starter_wakes where expedition_id=${healthy.id}`)[0];
 await expect(conn.sql.begin(async tx=>{
  await tx`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`;
  // A failed source is an error signal; consumers choose current fallback or original hold.
  await expect(tx.savepoint(async sp=>{await sp`select public.shardkeep_bound_cosmetic_starter_wake(${healthy.id}) visual`;})).rejects.toThrow('BOUND_COSMETIC_WAKE_SOURCE');
  expect((await tx`select public.shardkeep_bound_cosmetic_starter_wake(${legacy}) visual`)[0]!.visual).toBeNull();
  expect((await tx`select * from bound_cosmetic_starter_wakes where expedition_id=${healthy.id}`)[0]).toEqual(before);
  await tx`select public.shardkeep_bound_cosmetic_wake_preference(${f.wallet},false,0,clock_timestamp())`;
 })).rejects.toThrow('BOUND_COSMETIC_WAKE_SOURCE');
 const broken=await createStarterExpeditionFixture(conn.db,{now:new Date(Date.now()-86400000)});
 await conn.db.transaction(async tx=>{
  await tx.execute(sql`alter table bound_cosmetic_wake_preferences disable trigger bound_cosmetic_wake_preference_guard`);
  await dispatchStarterExpedition(tx,broken.wallet,broken.command,broken.authority,{reader:broken.reader,clock:()=>broken.now});
  await tx.execute(sql`alter table bound_cosmetic_wake_preferences enable trigger bound_cosmetic_wake_preference_guard`);
 });
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_starter_wake(${broken.command.id}) visual`)[0]!.visual).toEqual(unavailable);
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_wake_sources_valid() valid`)[0]!.valid).toBe(true);
});

it('serializes account CAS contenders and refuses a stale inverse without advancing the exact retry',async()=>{
 flags();const f=await createStarterExpeditionFixture(conn.db,{now:new Date(Date.now()-86400000)});
 const replies=await Promise.all([preference(f.wallet,false,'0',f.now),preference(f.wallet,false,'0',f.now)]);
 expect(replies).toEqual([{enabled:false,revision:'1',visual:plain},{enabled:false,revision:'1',visual:plain}]);
 const attempts=await Promise.allSettled([preference(f.wallet,false,'1',f.now),preference(f.wallet,true,'0',f.now)]);
 expect(attempts[0]!.status).toBe('fulfilled');expect(attempts[1]!.status).toBe('rejected');
 expect((await conn.sql`select revision,enabled from bound_cosmetic_wake_preferences where wallet=${f.wallet}`)[0]).toEqual({revision:'2',enabled:false});
});

it('preserves accepted equipment, starter and authentic advanced return capability under the new source seal',async()=>{
 flags();const initial=new Date(Math.floor((Date.now()-3*86400000)/1000)*1000);
 const connection={...conn,reopen:()=>createDb(baseUrl.toString(),{max:4}),async setup(){},async close(){}};
 const f=await vehicleBurnDatabase('survey_balloon',1,{}, {connection,completedAt:new Date(+initial-3600000)});
 f.finalizeBurn();await createVehicleInstallations(conn.db,{verifyBurn:f.reader.verify}).recover(f.actor,f.reservation.id);
 const authority={baseId:f.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
 const secondBerth=randomUUID(),completed=new Date(+initial-3600000).toISOString(),started=new Date(+initial-7200000).toISOString();
 for(const [type,id,x] of [['workshop',randomUUID(),5],['lodge',randomUUID(),8],['berth',secondBerth,11]] as const){
  await conn.sql`insert into buildings(id,base_id,player_wallet,type,tx,ty) values(${id},${f.baseId},${f.actor},${type},${x},5)`;
  await conn.sql`insert into builder_jobs(base_id,player_wallet,building_id,kind,started_at,finishes_at,completed_at) values(${f.baseId},${f.actor},${id},'build',${started},${completed},${completed})`;
 }
 const starter=await installStarterFleet(conn.db,f.actor,secondBerth,authority);
 const ornament=await earned(f.actor);
 await conn.sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${ornament.job.id},${ornament.job.readyAt.toISOString()})`;
 const selected=await preference(f.actor,true,'0',ornament.job.readyAt);
 for(const i of ordinaryEquipmentRecipe().inputs)await conn.sql`insert into crafting_stocks(base_id,item_id,available) values(${f.baseId},${i.itemId},${i.quantity})`;
 await conn.sql`insert into resource_stocks(base_id,resource_id,available) values(${f.baseId},'rough_prism',1000)`;
 let now=initial;vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 const craft=await startOrdinaryEquipment(conn.db,f.actor,{idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1},authority,{clock:()=>now});
 if(craft.status!=='accepted')throw Error('Missing actual fixture craft');now=new Date(Math.max(Date.parse(craft.receipt.readyAt),+ornament.job.readyAt)+1000);vi.setSystemTime(now);
 await conn.db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,now));
 const bank=await createMiningTermFixture({day:initial.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 const reader=async()=>{bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+now/1000)),32);return prefetchExpeditionTermReader(bank.connect,bank.policy);};
 const fitting={itemId:'route_compass',policyVersion:1} as const,preview=starterRoutePreview('crownlands','coastal_survey');
 const first=await dispatchStarterExpedition(conn.db,f.actor,{id:randomUUID(),baseId:f.baseId,installationId:starter.installationId,routeId:preview.routeId,routeVersion:preview.routeCatalogueVersion,rewardVersion:preview.rewardTableVersion,fitting},authority,{reader:await reader(),clock:()=>now});
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_starter_wake(${first.id}) visual`)[0]!.visual).toEqual(selected.visual);
 await conn.db.transaction(tx=>settleDueStarterExpeditions(tx,f.baseId,first.returnsAt));now=first.returnsAt;vi.setSystemTime(now);
 const command={id:randomUUID(),baseId:f.baseId,installationId:f.reservation.id,routeId:'coastal_survey',policyVersion:1,fitting};
 const rolledBack={...command,id:randomUUID()};let capturedBeforeFailure=false;
 const lateAuthority={...authority,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{
  await assertFreshLockedBaseAuthority(...args);const [row]=await args[0].execute<{present:boolean}>(sql`select exists(select 1 from bound_cosmetic_advanced_wakes where expedition_id=${rolledBack.id}) present`);
  if(row!.present){capturedBeforeFailure=true;throw Error('Wake late advanced refusal');}
 }};
 await expect(dispatchAdvancedExpedition(conn.db,f.actor,rolledBack,lateAuthority,{reader:await reader(),clock:()=>now})).rejects.toThrow('Wake late advanced refusal');
 expect(capturedBeforeFailure).toBe(true);expect(await conn.sql`select * from bound_cosmetic_advanced_wakes where expedition_id=${rolledBack.id}`).toHaveLength(0);
 expect(await conn.sql`select * from advanced_expeditions where id=${rolledBack.id}`).toHaveLength(0);
 const second=await dispatchAdvancedExpedition(conn.db,f.actor,command,authority,{reader:await reader(),clock:()=>now});
 const [wake]=await conn.sql`select * from bound_cosmetic_advanced_wakes where expedition_id=${second.id}`;
 expect(wake!.visual).toEqual(selected.visual);expect(wake!.selection_record).toMatchObject({actorWallet:f.actor,preferenceRevision:'1',jobId:ornament.job.id});
 await preference(f.actor,false,'1',new Date(+now+1000));
 expect((await conn.sql`select public.shardkeep_bound_cosmetic_advanced_wake(${second.id}) visual`)[0]!.visual).toEqual(selected.visual);
 await expect(conn.db.transaction(async tx=>{await settleDueAdvancedExpeditions(tx,f.baseId,second.returnsAt);throw Error('Wake paired return rollback');})).rejects.toThrow('Wake paired return rollback');
 expect(await conn.sql`select * from advanced_expedition_returns where expedition_id=${second.id}`).toHaveLength(0);
 expect((await conn.sql`select * from bound_cosmetic_advanced_wakes where expedition_id=${second.id}`)[0]).toEqual(wake);
 const returned=await conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,second.returnsAt));expect(returned).toHaveLength(1);expect(returned[0]!.receipt.completedTotal).toBe(1n);
 expect(await conn.db.transaction(tx=>settleDueAdvancedExpeditions(tx,f.baseId,second.returnsAt))).toHaveLength(0);
 vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');expect(await dispatchAdvancedExpedition(conn.db,f.actor,command,authority)).toEqual(second);
 expect((await conn.sql`select available,reserved from ordinary_equipment_stocks where base_id=${f.baseId}`)[0]).toEqual({available:'1',reserved:'0'});
 expect(await conn.sql`select * from ordinary_equipment_releases where base_id=${f.baseId}`).toHaveLength(2);
 expect(await seals()).toEqual(prior);
},120000);

it('detects exact hook, helper, shape and permission drift while keeping new rows and predecessor seals immutable',async()=>{
 for(const mutation of [
  'alter table starter_expeditions disable trigger bound_cosmetic_starter_wake_capture',
  'alter table advanced_expeditions disable trigger bound_cosmetic_advanced_wake_capture',
  'alter table ordinary_crafting_jobs disable trigger bound_cosmetic_workshop_guard',
  'alter function public.shardkeep_bound_cosmetic_wake_selection(text,timestamptz) security definer',
  'alter function public.shardkeep_bound_cosmetic_starter_wake(uuid) set search_path=pg_catalog,pg_temp,public',
  "create or replace function public.shardkeep_bound_cosmetic_advanced_wake_capture() returns trigger language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$begin return NULL;end$$",
  'grant select on bound_cosmetic_wake_preferences to public',
  'grant select(selection_record) on bound_cosmetic_starter_wakes to public',
  'grant execute on function public.shardkeep_bound_cosmetic_starter_wake(uuid) to public',
  'alter table bound_cosmetic_starter_wakes enable row level security',
  'alter table bound_cosmetic_advanced_wakes set unlogged',
  'alter table bound_cosmetic_advanced_wakes alter column visual drop not null',
 ])await expect(conn.sql.begin(async tx=>{await tx.unsafe(mutation);expect((await tx`select public.shardkeep_bound_cosmetic_wake_sources_valid() valid`)[0]!.valid).toBe(false);await tx`select public.shardkeep_divine_fragment_source()`;}),mutation).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
 for(const table of ['bound_cosmetic_starter_wakes','bound_cosmetic_advanced_wakes','bound_cosmetic_wake_contract']){
  for(const query of [`update ${table} set ${table.endsWith('contract')?'record=record':'visual=visual'}`,`delete from ${table}`,`truncate ${table}`])await expect(conn.sql.unsafe(query)).rejects.toThrow(/BOUND_COSMETIC_WAKE_(?:IMMUTABLE|SEAL_IMMUTABLE)/);
 }
 await expect(conn.sql`insert into bound_cosmetic_starter_wakes(expedition_id,visual,selection_record) values(${legacy},${JSON.stringify(plain)},'{}')`).rejects.toThrow('BOUND_COSMETIC_WAKE_IMMUTABLE');
 await expect(conn.sql`insert into bound_cosmetic_advanced_wakes select * from bound_cosmetic_advanced_wakes on conflict do nothing`).rejects.toThrow('BOUND_COSMETIC_WAKE_IMMUTABLE');
 await expect(conn.sql`insert into bound_cosmetic_wake_contract select * from bound_cosmetic_wake_contract on conflict do nothing`).rejects.toThrow('BOUND_COSMETIC_WAKE_SEAL_IMMUTABLE');
 for(const table of sealedTables.filter(t=>!t.endsWith('_seal')))await expect(conn.sql.unsafe(`update ${table} set record=record`)).rejects.toThrow();
 expect(await seals()).toEqual(prior);
});

it('admits only narrow future reader groups, refuses copied trigger authority and detects inherited sidecars',async()=>{
 const group='shardkeep_api_runtime';
 await expect(conn.sql.begin(async tx=>{
  if(!(await tx`select 1 from pg_roles where rolname=${group}`).length)await tx.unsafe(`create role ${group} nologin`);
  await tx.unsafe(`grant execute on function public.shardkeep_bound_cosmetic_starter_wake(uuid),public.shardkeep_bound_cosmetic_advanced_wake(uuid) to ${group}`);
  expect((await tx`select public.shardkeep_bound_cosmetic_wake_sources_valid() valid`)[0]!.valid).toBe(true);
  await tx.unsafe(`grant execute on function public.shardkeep_bound_cosmetic_starter_wake(uuid) to ${group} with grant option`);
  expect((await tx`select public.shardkeep_bound_cosmetic_wake_sources_valid() valid`)[0]!.valid).toBe(false);
  throw Error('rollback narrow reader grants');
 })).rejects.toThrow('rollback narrow reader grants');
 const login='wake_login_'+randomUUID().replaceAll('-',''),password=randomUUID();
 await conn.sql.unsafe(`create role ${login} login password '${password}' inherit nosuperuser nocreatedb nocreaterole`);
 if(!(await conn.sql`select 1 from pg_roles where rolname=${group}`).length)await conn.sql.unsafe(`create role ${group} nologin`);
 await conn.sql.unsafe(`grant usage on schema public to ${group}`);
 await conn.sql.unsafe(`grant execute on function public.shardkeep_bound_cosmetic_starter_wake(uuid),public.shardkeep_bound_cosmetic_advanced_wake(uuid) to ${group}`);
 await conn.sql.unsafe(`grant ${group} to ${login}`);
 const requestUrl=new URL(baseUrl);requestUrl.username=login;requestUrl.password=password;const request=createDb(requestUrl.toString());
 try{
  const [existing]=await conn.sql`select expedition_id,visual from bound_cosmetic_starter_wakes where visual->>'state'='available' limit 1`;
  expect((await request.sql`select public.shardkeep_bound_cosmetic_starter_wake(${existing!.expedition_id}) visual`)[0]!.visual).toEqual(existing!.visual);
  await expect(request.sql`select * from bound_cosmetic_starter_wakes`).rejects.toMatchObject({code:'42501'});
  await conn.sql.unsafe(`grant select(visual) on bound_cosmetic_starter_wakes to ${login}`);
  await expect(request.sql`select public.shardkeep_bound_cosmetic_starter_wake(${existing!.expedition_id}) visual`).rejects.toThrow('BOUND_COSMETIC_WAKE_SOURCE');
 }finally{await request.sql.end();await conn.sql.unsafe(`drop owned by ${login}`);await conn.sql.unsafe(`drop role ${login}`);}
 const role='wake_reader_'+randomUUID().replaceAll('-','');
 await expect(conn.sql.begin(async tx=>{
  await tx.unsafe(`create role ${role} noinherit`);await tx.unsafe(`grant usage on schema public to ${role}`);await tx.unsafe(`set local role ${role}`);
  await tx`select * from bound_cosmetic_starter_wakes`;
 })).rejects.toMatchObject({code:'42501'});
 await expect(conn.sql.begin(async tx=>{
  await tx`create table forged_wake(like bound_cosmetic_starter_wakes including defaults)`;
  await tx`create trigger bound_cosmetic_wake_guard before insert on forged_wake for each row execute function public.shardkeep_bound_cosmetic_wake_guard()`;
  await tx`insert into forged_wake values(${legacy},'{}','{}')`;
 })).rejects.toThrow('BOUND_COSMETIC_WAKE_IMMUTABLE');
 await expect(conn.sql.begin(async tx=>{
  await tx`create table forged_wake_parent(expedition_id uuid)`;
  await tx.unsafe(`create function public.forged_wake_backfill() returns trigger language plpgsql as $$declare s jsonb;begin
   select public.shardkeep_bound_cosmetic_wake_selection(actor_wallet,departed_at) into s from starter_expeditions where id=NEW.expedition_id;
   insert into bound_cosmetic_starter_wakes values(NEW.expedition_id,s->'visual',s);return NULL;end$$`);
  await tx`create trigger forged_wake_backfill after insert on forged_wake_parent for each row execute function public.forged_wake_backfill()`;
  await tx`insert into forged_wake_parent values(${legacy})`;
 })).rejects.toThrow('BOUND_COSMETIC_WAKE_IMMUTABLE');
 // PostgreSQL may retain relhassubclass after rollback; this is deliberately the
 // final probe in the disposable database, never a source repair/reseal.
 await expect(conn.sql.begin(async tx=>{await tx`create table forged_wake_child() inherits(public.bound_cosmetic_starter_wakes)`;await tx`select public.shardkeep_divine_fragment_source()`;})).rejects.toThrow('DIVINE_FRAGMENT_SOURCE');
});
