/** Actual restricted ordinary writers settle owner-admitted obligations only. */
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import {SIM_VERSION} from '@shardkeep/sim';
import {raids as raidRows} from '../src/db/schema';
import { sql } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { pvpAttackShardCostForKeepLevel } from '@shardkeep/shared';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import { advancedExpeditionPreview } from '@shardkeep/shared/phaseEAdvancedExpeditions';
import { ordinaryEquipmentRecipe } from '@shardkeep/shared/phaseEOrdinaryEquipment';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { vehicleBurnDatabase } from './fixtures/vehicleBurn';
import { createVehicleInstallations } from '../src/game/vehicleInstallations';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { prefetchExpeditionTermReader } from '../src/game/expeditionTermReader';
import { dispatchAdvancedExpedition } from '../src/game/advancedExpeditionDispatch';
import { readAdvancedExpeditionReturn, settleAdvancedExpeditionsAtBoundary, settleDueAdvancedExpeditions } from '../src/game/advancedExpeditionReturns';
import { assertFreshLockedBaseAuthority, registerOwnedDeed, transferStableBase, refreshBaseOwnership } from '../src/game/baseOwnership';
import { startOrdinaryEquipment } from '../src/game/ordinaryEquipment';
import { startOrdinaryCrafting, settleDueOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { createRaid, type RaidBaseAuthority } from '../src/game/raids';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { claimRect } from '../src/game/footprints';
import { executeBaseClaim } from '../src/game/baseClaimCommands';
import {createStarterExpeditionFixture} from './fixtures/starterExpeditions';
import {dispatchStarterExpedition} from '../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions} from '../src/game/starterExpeditionReturns';
import {starterExpeditionEnvelope} from '../src/game/starterExpeditionView';
import {getBaseState} from '../src/game/base';
import { ADMIN_DATABASE_URL } from './db-url';
const script=fileURLToPath(new URL('../../../infra/db/provision-runtime-roles.sh',import.meta.url));
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
async function fixture(run:(f:Awaited<ReturnType<typeof setup>>)=>Promise<void>){const f=await setup();try{await run(f);}finally{await f.close();}}
async function setup(){
 for(const flag of ['BASE_CLAIM_V1_ENABLED','MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','PHASE_E_VEHICLES_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(flag,'true');
 const owner=resourceClaimsDatabase();await owner.setup();const [clock]=await owner.sql`select clock_timestamp() now,current_database() name`;
 const at=new Date(+new Date(clock!.now)-3*86400000),url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+clock!.name;
 const suffix=randomUUID().replaceAll('-',''),role='ar_api_'+suffix,worker='ar_worker_'+suffix,password=randomBytes(32).toString('hex');
 const provision=()=>execFileSync('sh',[script],{encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,env:{PATH:process.env.PATH,PGHOST:url.hostname,PGPORT:url.port,PGDATABASE:String(clock!.name),PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),POSTGRES_USER:decodeURIComponent(url.username),POSTGRES_PASSWORD:decodeURIComponent(url.password),DB_ROLE_MODE:'isolated',SOLANA_CLUSTER:'devnet',API_DB_USER:role,API_DB_PASSWORD:password,WORKER_DB_USER:worker,WORKER_DB_PASSWORD:randomBytes(32).toString('hex')}});
 provision();const requestUrl=new URL(url);requestUrl.username=role;requestUrl.password=password;const request=createDb(requestUrl.toString(),{max:4});
 const bank=await createMiningTermFixture({day:at.toISOString().slice(0,10),genesisHash:Keypair.generate().publicKey,programId:Keypair.generate().publicKey});
 async function base(fund=true){
  const v=await vehicleBurnDatabase('survey_balloon',1,{}, {connection:owner,completedAt:new Date(+at-86400000)});v.finalizeBurn();await createVehicleInstallations(owner.db,{verifyBurn:v.reader.verify}).recover(v.actor,v.reservation.id);
  // Explicit synthetic historical placement, matching raid-advanced-presentation-source.
  // The berth was completed before at; retain every identity/proof byte and
  // restore origin triggers at this transaction's end, including on failure.
  await owner.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;
   await tx`update vehicle_activation_reservations set reserved_at=${at.toISOString()}::timestamptz where id=${v.reservation.id}`;
   await tx`update vehicle_burn_consumptions set recorded_at=${at.toISOString()}::timestamptz where reservation_id=${v.reservation.id}`;
   await tx`update advanced_vehicle_installations set installed_at=${at.toISOString()}::timestamptz where reservation_id=${v.reservation.id}`;
  });
  const claim=claimRect(0);await owner.sql`update buildings set tx=${claim.min},ty=${claim.min} where id=${v.berthId}`;
  for(const [type,x] of [['lodge',claim.min+3],['workshop',claim.min+10],['keep',claim.min+6]] as const){const id=randomUUID();await owner.sql`insert into buildings(id,player_wallet,base_id,type,tx,ty,level) values(${id},${v.actor},${v.baseId},${type},${x},${claim.min},${type==='keep'?5:1})`;await owner.sql`insert into builder_jobs(player_wallet,base_id,building_id,kind,started_at,finishes_at,completed_at) values(${v.actor},${v.baseId},${id},'build',${new Date(+at-172800000).toISOString()},${new Date(+at-86400000).toISOString()},${new Date(+at-86400000).toISOString()})`;}
  await owner.sql`update bases set keep_level=5 where id=${v.baseId}`;await owner.sql`update players set keep_level=5 where wallet=${v.actor}`;
  await owner.sql`insert into resource_stocks(base_id,resource_id,available) values(${v.baseId},'rough_prism',1000)`;
  if(fund)await rewardBaseShards(owner.db,v.baseId,BigInt(pvpAttackShardCostForKeepLevel(5)),'advanced.boundary.fixture',randomUUID());
  const authority={baseId:v.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
  async function depart(fitting?:{itemId:'route_compass';policyVersion:1}|{itemId:'survey_lens';policyVersion:1;resourceId:'frost_quartz'},when=at){
   vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(when);
   try{
    if(fitting){const recipe=ordinaryEquipmentRecipe(fitting.itemId==='survey_lens'?'craft_survey_lens':'craft_route_compass');for(const i of recipe.inputs)await owner.sql`insert into crafting_stocks(base_id,item_id,available) values(${v.baseId},${i.itemId},${i.quantity}) on conflict(base_id,item_id) do update set available=excluded.available`;
     const craftAt=new Date(+when-recipe.durationSec*1000),craft=await startOrdinaryEquipment(owner.db,v.actor,{idempotencyKey:randomUUID(),baseId:v.baseId,recipeId:recipe.recipeId,recipeVersion:1,quantity:1},authority,{clock:()=>craftAt});if(craft.status!=='accepted')throw Error('fixture craft');await owner.db.transaction(tx=>settleDueOrdinaryCrafting(tx,v.baseId,when));}
    bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+when/1000)),32);
    return await dispatchAdvancedExpedition(owner.db,v.actor,{id:randomUUID(),baseId:v.baseId,installationId:v.reservation.id,routeId:'coastal_survey',policyVersion:1,...fitting?{fitting}:{}},authority,{reader:await prefetchExpeditionTermReader(bank.connect,bank.policy),clock:()=>when});
   }finally{vi.useRealTimers();}
  }
  return {...v,depart,authority};
 }
 return {owner,request,role,worker,at,base,provision,async close(){await request.sql.end();await owner.sql.unsafe(`drop owned by ${role};drop owned by ${worker};drop role ${role};drop role ${worker}`);await owner.close();}};
}
const raidAuthority:RaidBaseAuthority=async(wallet,baseId,tx)=>{if(tx)await assertFreshLockedBaseAuthority(tx,wallet,baseId);};
const raidOptions=(a:{actor:string;baseId:string},d:{actor:string;baseId:string})=>({attackerBaseId:a.baseId,defenderBaseId:d.baseId,defenderWallet:d.actor,idempotencyKey:randomUUID(),authorizeAttackerBase:raidAuthority,authorizeDefenderBase:raidAuthority});
it('settles a real primary source under restricted outer commit and retains private table/trigger boundaries',()=>fixture(async f=>{
 const a=await f.base(),trip=await a.depart();vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');
 await expect(f.request.sql`select * from advanced_expeditions`).rejects.toMatchObject({code:'42501'});await expect(f.request.sql`select * from ordinary_equipment_reservations`).rejects.toMatchObject({code:'42501'});
 expect(await f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).toBe(1);
 const proof=await readAdvancedExpeditionReturn(f.owner.db,trip.id);expect(proof!.receipt.custodyWallet).toBe(a.actor);expect(proof!.entries.reduce((n,e)=>n+e.delta,0n)).toBe(0n);
 expect(await f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).toBe(0);
 await f.provision();expect(await f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).toBe(0);
}),120000);
it('ordinary PvP settles both real fitted sources exactly once at one locked cutoff',()=>fixture(async f=>{
 const a=await f.base(),d=await f.base(),ta=await a.depart({itemId:'route_compass',policyVersion:1}),td=await d.depart({itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'});
 const cutoff=new Date(Math.max(+ta.returnsAt,+td.returnsAt));vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');
 const options=raidOptions(a,d),raid=await createRaid(f.request.db,a.actor,options,cutoff);
 for(const t of [ta,td]){const proof=await readAdvancedExpeditionReturn(f.owner.db,t.id);expect(proof!.receipt.returnedAt).toEqual(cutoff);expect(proof!.receipt.completedTotal).toBe(1n);}
 expect(await f.owner.sql`select available,reserved from ordinary_equipment_stocks order by base_id`).toEqual([{available:'1',reserved:'0'},{available:'1',reserved:'0'}]);
 const secondary=await f.owner.sql`select e.bucket,e.delta from ordinary_equipment_secondary_entries e where expedition_id=${td.id} order by bucket`;expect(secondary).toHaveLength(3);expect(secondary.reduce((n,e)=>n+BigInt(e.delta),0n)).toBe(0n);
 expect((await createRaid(f.request.db,a.actor,options,cutoff)).id).toBe(raid.id);expect(await f.owner.sql`select * from advanced_expedition_returns`).toHaveLength(2);
}),120000);
it('a later ante rejection rolls back primary, Lens, use count, flight and equipment release before retry',()=>fixture(async f=>{
 const a=await f.base(false),d=await f.base(),trip=await a.depart({itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'}),options=raidOptions(a,d);
 await expect(createRaid(f.request.db,a.actor,options,trip.returnsAt)).rejects.toThrow();
 expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toBeNull();expect(await f.owner.sql`select * from advanced_expedition_inflight`).toHaveLength(1);
 expect(await f.owner.sql`select * from ordinary_equipment_secondary_returns`).toHaveLength(0);expect(await f.owner.sql`select * from ordinary_equipment_releases`).toHaveLength(0);
 expect(await f.owner.sql`select available,reserved from ordinary_equipment_stocks`).toEqual([{available:'0',reserved:'1'}]);
 await rewardBaseShards(f.owner.db,a.baseId,BigInt(pvpAttackShardCostForKeepLevel(5)),'advanced.boundary.retry',randomUUID());
 await createRaid(f.request.db,a.actor,options,trip.returnsAt);expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).not.toBeNull();
}),120000);
it.each(['direct','observer','native'] as const)('actual restricted %s custody boundary settles seller due trips while a future source follows the buyer',path=>fixture(async f=>{
 for(const due of [true,false]){
  const a=await f.base(),trip=await a.depart(),buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58();await f.owner.sql`insert into players(wallet) values(${buyer})`;
  expect((await registerOwnedDeed(f.owner.db,a.actor,deed)).id).toBe(a.baseId);
  const at=new Date(+trip.returnsAt-(due?0:1)),proof={owner:buyer,collection:Keypair.generate().publicKey.toBase58(),frozen:false,delegate:null,slot:101};
  if(path==='direct')await transferStableBase(f.request.db,a.baseId,a.actor,buyer,deed,{...proof,observedAtMs:+at},()=>at);
  else if(path==='observer')expect(await refreshBaseOwnership(f.request.db,a.baseId,async()=>proof,proof.collection,at,'advanced-return-test',()=>at)).toBe('mismatch');
  else await executeBaseClaim(f.request.db,{collection:proof.collection,ownerOf:async()=>proof,ownedDeeds:async()=>[deed]},buyer,{idempotencyKey:randomUUID(),baseId:a.baseId,deedAssetId:deed},()=>at);
  const saved=await readAdvancedExpeditionReturn(f.owner.db,trip.id);expect(saved?.receipt.custodyWallet??null).toBe(due?a.actor:null);
  expect((await f.owner.sql`select owner_wallet from bases where id=${a.baseId}`)[0]!.owner_wallet).toBe(buyer);
  if(!due){vi.stubEnv('PHASE_E_VEHICLES_ENABLED','false');const [later]=await f.owner.db.transaction(tx=>settleDueAdvancedExpeditions(tx,a.baseId,trip.returnsAt));expect(later!.receipt.custodyWallet).toBe(buyer);expect(later!.expedition.actorWallet).toBe(a.actor);vi.stubEnv('PHASE_E_VEHICLES_ENABLED','true');}
 }
}),120000);
it('rejects future cutoffs, missing base, isolation changes and unauthorized trigger/owner access',()=>fixture(async f=>{
 const a=await f.base(),trip=await a.depart(),future=new Date(Date.now()+86400000);
 await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,future))).rejects.toThrow();
 await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,randomUUID(),trip.returnsAt))).rejects.toThrow();
 await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt),{isolationLevel:'repeatable read'})).rejects.toThrow();
 expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toBeNull();
 for(const fn of ['shardkeep_advanced_expedition_complete','shardkeep_equipment_trip_proof_v2','shardkeep_advanced_return_fingerprint'])expect((await f.request.sql`select has_function_privilege(current_user,${fn+'()'},'EXECUTE') allowed`)[0]!.allowed).toBe(false);
 expect((await f.request.sql`select pg_has_role(current_user,(select relowner from pg_class where oid='advanced_expeditions'::regclass),'MEMBER') allowed`)[0]!.allowed).toBe(false);
 await expect(f.request.sql`create temp table fake_advanced (expedition_id uuid)`).rejects.toMatchObject({code:'42501'});
 await f.owner.sql`create table public.fake_advanced (expedition_id uuid)`;
 await f.owner.sql.unsafe(`grant trigger on public.fake_advanced to ${f.role}`);
 await expect(f.request.sql`create trigger equipment_trip_proof after insert on public.fake_advanced for each row execute function public.shardkeep_equipment_trip_proof_v2()`).rejects.toMatchObject({code:'42501'});
 const outsider='ar_out_'+randomUUID().replaceAll('-','');await f.owner.sql.unsafe(`create role ${outsider}`);
 try{expect((await f.owner.sql`select has_function_privilege(${outsider},'public.shardkeep_settle_advanced_returns(uuid,timestamptz)','EXECUTE') allowed`)[0]!.allowed).toBe(false);}finally{await f.owner.sql.unsafe(`drop role ${outsider}`);}
}),120000);
it.each(['primary','secondary'] as const)('rolls the complete Lens graph back on %s stock overflow',kind=>fixture(async f=>{
 const a=await f.base(),trip=await a.depart({itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'}),resource=kind==='primary'?trip.resourceId:'frost_quartz';
 await f.owner.sql`insert into resource_stocks(base_id,resource_id,available) values(${a.baseId},${resource},9223372036854775807) on conflict(base_id,resource_id) do update set available=excluded.available`;
 await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).rejects.toThrow();
 expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toBeNull();expect(await f.owner.sql`select * from ordinary_equipment_secondary_returns`).toHaveLength(0);expect(await f.owner.sql`select * from ordinary_equipment_releases`).toHaveLength(0);
 expect(await f.owner.sql`select available,reserved from ordinary_equipment_stocks`).toEqual([{available:'0',reserved:'1'}]);
 await f.owner.sql`update resource_stocks set available=0 where base_id=${a.baseId} and resource_id=${resource}`;
 expect(await f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).toBe(1);
}),120000);
it('rejects missing or contradictory original bindings without writing any part of the fitted return',()=>fixture(async f=>{
 const a=await f.base(),trip=await a.depart({itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'});
 const cases=[
  ['advanced_expedition_inflight','expedition_id',trip.id,`delete from advanced_expedition_inflight where expedition_id='${trip.id}'`],
  ['advanced_expedition_supplies','expedition_id',trip.id,`delete from advanced_expedition_supplies where expedition_id='${trip.id}'`],
  ['ordinary_equipment_reservations','expedition_id',trip.id,`delete from ordinary_equipment_reservations where expedition_id='${trip.id}'`],
  ['advanced_expeditions','id',trip.id,`update advanced_expeditions set home_evidence=jsonb_set(home_evidence,'{baseId}',to_jsonb('${randomUUID()}'::text)) where id='${trip.id}'`],
  ['advanced_expeditions','id',trip.id,`update advanced_expeditions set term_hash=repeat('0',64) where id='${trip.id}'`],
 ] as const;
 for(const [table,key,id,attack] of cases){
  const originals=await f.owner.sql.unsafe(`select row_to_json(t) value from ${table} t where ${key}='${id}'`);
  await f.owner.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx.unsafe(attack);});
  await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).rejects.toThrow();
  expect(await f.owner.sql`select * from advanced_expedition_returns`).toHaveLength(0);expect(await f.owner.sql`select * from ordinary_equipment_secondary_returns`).toHaveLength(0);expect(await f.owner.sql`select * from ordinary_equipment_releases`).toHaveLength(0);
  await f.owner.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx.unsafe(`delete from ${table} where ${key}='${id}'`);for(const row of originals)await tx.unsafe(`insert into ${table} select * from jsonb_populate_record(null::${table},$1::jsonb)`,[JSON.stringify(row.value)]);});
 }
 expect(await f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).toBe(1);
}),120000);
it('fails closed after disabled guards or leaked column grants and preserves originals on migration and provisioning replay',()=>fixture(async f=>{
 const a=await f.base(),trip=await a.depart(),migration=readFileSync(new URL('../drizzle/0256_advanced_return_capability.sql',import.meta.url),'utf8');
 // 0279 replaces the return capabilities and 0298 adds the crafting successor.
 // Replay the current journal; direct 0256 DDL is now a refused downgrade.
 const replay=()=>runMigrations(f.owner.db);
 const replayPredecessor=()=>f.owner.sql.begin(async tx=>{for(const part of migration.split('--> statement-breakpoint'))if(part.trim())await tx.unsafe(part);});
 const retainedSource=async()=>{
  const relations=await f.owner.sql`select c.relname from pg_class c join pg_attribute a on a.attrelid=c.oid
   where c.relnamespace='public'::regnamespace and c.relkind='r' and a.attname in ('record','source_sha256')
   and a.attnum>0 and not a.attisdropped and (right(c.relname,9)='_contract' or right(c.relname,5)='_seal') order by c.relname`;
  const seals:Record<string,unknown>={};
  for(const relation of relations)seals[relation.relname]=await f.owner.sql.unsafe(`select row_to_json(t)::text row from public.${relation.relname} t order by row_to_json(t)::text`);
  const functions=await f.owner.sql`select p.oid::regprocedure::text name,pg_get_functiondef(p.oid) definition from pg_proc p
   where p.pronamespace='public'::regnamespace and p.proname in ('shardkeep_advanced_expedition_complete','shardkeep_equipment_trip_proof_v2',
    'shardkeep_advanced_return_fingerprint','shardkeep_settle_advanced_returns','shardkeep_settle_due_equipment','shardkeep_equipment_idle',
    'shardkeep_starter_equipment_evidence','shardkeep_bound_cosmetic_return_sources_valid','shardkeep_divine_fragment_contract','shardkeep_crafting_runtime_sources_valid') order by name`;
  const journal=await f.owner.sql`select id,hash,created_at from drizzle.__drizzle_migrations order by created_at,id`;
  return {seals,functions,journal};
 };
 const retained=await retainedSource();
 const fingerprint=(await f.owner.sql`select shardkeep_advanced_return_fingerprint() hash`)[0]!.hash;
 await f.owner.sql`select public.shardkeep_divine_fragment_source()`;
 await f.owner.sql`alter table advanced_expedition_returns disable trigger advanced_expedition_returns_guard`;
 // With the current journal, the runner verifies history and applies no migration SQL.
 // Tamper detection below is proved by the settlement refusal and successor validator.
 await replay();
 // 2026-10-10: drizzle wraps the definer's refusal as DrizzleQueryError("Failed query: ..."), so the dd92d0f16 tamper
 // pin reads the Postgres exception from its cause, as the repo's other wrapped-refusal pins do.
 await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).rejects.toMatchObject({cause:{message:'ADVANCED_RETURN_SOURCE_CHANGED'}});await expect(replayPredecessor()).rejects.toThrow('ADVANCED_RETURN_SOURCE_CHANGED');
 expect((await f.owner.sql`select shardkeep_bound_cosmetic_return_sources_valid() ok`)[0]!.ok).toBe(false);
 await f.owner.sql`alter table advanced_expedition_returns enable trigger advanced_expedition_returns_guard`;
 await expect(replayPredecessor()).rejects.toThrow('ADVANCED_RETURN_SOURCE_CHANGED');
 expect(await retainedSource()).toEqual(retained);
 await f.owner.sql.unsafe(`grant select(expedition_id) on ordinary_equipment_releases to ${f.role}`);
 await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).rejects.toThrow();
 await f.provision();await replay();expect((await f.owner.sql`select shardkeep_advanced_return_fingerprint() hash`)[0]!.hash).toBe(fingerprint);
 expect(await retainedSource()).toEqual(retained);
 expect((await f.owner.sql`select shardkeep_bound_cosmetic_return_sources_valid() returns,shardkeep_crafting_runtime_sources_valid() crafting`)[0]).toEqual({returns:true,crafting:true});
 expect(await f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,a.baseId,trip.returnsAt))).toBe(1);
 const original=await readAdvancedExpeditionReturn(f.owner.db,trip.id);await replay();await f.provision();expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toEqual(original);
 expect(await retainedSource()).toEqual(retained);
 await f.owner.sql`select public.shardkeep_divine_fragment_source()`;
}),120000);
it('permits an empty ordinary raid but forbids a future cutoff for an accepted source that is not yet due',()=>fixture(async f=>{
 const a=await f.base(),d=await f.base();await createRaid(f.request.db,a.actor,raidOptions(a,d));
 const fresh=await f.base(),departedAt=new Date(Math.floor(Date.now()/1000)*1000),trip=await fresh.depart(undefined,departedAt);
 expect(+trip.returnsAt).toBeGreaterThan(Date.now());
 await expect(f.request.db.transaction(tx=>settleAdvancedExpeditionsAtBoundary(tx,fresh.baseId,trip.returnsAt))).rejects.toThrow();
 expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toBeNull();
}),120000);

it('restricted ordinary crafting still starts with no gear job and refuses the shared Workshop while gear is pending',()=>fixture(async f=>{
 const a=await f.base(),command={id:randomUUID(),baseId:a.baseId,recipeId:'refine_prismstone_lens',recipeVersion:1,quantity:1};
 const accepted=await startOrdinaryCrafting(f.request.db,a.actor,command,a.authority,{clock:()=>f.at});expect(accepted.job.baseId).toBe(a.baseId);
 const b=await f.base(),recipe=ordinaryEquipmentRecipe();for(const input of recipe.inputs)await f.owner.sql`insert into crafting_stocks(base_id,item_id,available) values(${b.baseId},${input.itemId},${input.quantity})`;
 const gear=await startOrdinaryEquipment(f.owner.db,b.actor,{idempotencyKey:randomUUID(),baseId:b.baseId,recipeId:recipe.recipeId,recipeVersion:1,quantity:1},b.authority,{clock:()=>f.at});expect(gear.status).toBe('accepted');
 await expect(startOrdinaryCrafting(f.request.db,b.actor,{...command,id:randomUUID(),baseId:b.baseId},b.authority,{clock:()=>f.at})).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
 if(gear.status!=='accepted')throw Error('fixture gear');await f.request.db.transaction(tx=>settleDueOrdinaryCrafting(tx,b.baseId,new Date(gear.receipt.readyAt)));
 expect(await f.owner.sql`select available,reserved,pending_output from ordinary_equipment_stocks where base_id=${b.baseId}`).toEqual([{available:'1',reserved:'0',pending_output:'0'}]);
}),120000);

it('retains restricted fitted starter saved-key and not-yet-due base reads without exposing private gear stock',()=>fixture(async f=>{
 const a=await createStarterExpeditionFixture(f.owner.db,{now:f.at}),id=randomUUID(),recipe=ordinaryEquipmentRecipe('craft_survey_lens');
 await f.owner.sql`insert into buildings(id,base_id,player_wallet,type,tx,ty) values(${id},${a.baseId},${a.wallet},'workshop',9,2)`;
 await f.owner.sql`insert into builder_jobs(base_id,player_wallet,building_id,kind,started_at,finishes_at,completed_at) values(${a.baseId},${a.wallet},${id},'build',${new Date(+f.at-7200000).toISOString()},${new Date(+f.at-3600000).toISOString()},${new Date(+f.at-3600000).toISOString()})`;
 for(const i of recipe.inputs)await f.owner.sql`insert into crafting_stocks(base_id,item_id,available) values(${a.baseId},${i.itemId},${i.quantity})`;
 const craft=await startOrdinaryEquipment(f.owner.db,a.wallet,{idempotencyKey:randomUUID(),baseId:a.baseId,recipeId:recipe.recipeId,recipeVersion:1,quantity:1},a.authority,{clock:()=>f.at});if(craft.status!=='accepted')throw Error('fixture');const at=new Date(craft.receipt.readyAt);
 await f.owner.db.transaction(tx=>settleDueOrdinaryCrafting(tx,a.baseId,at));
 const route=starterRoutePreview('crownlands','coastal_survey');
 const trip=await dispatchStarterExpedition(f.owner.db,a.wallet,{...a.command,routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion,fitting:{itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'}},a.authority,{reader:a.reader,clock:()=>at});
 expect((await starterExpeditionEnvelope(f.request.db,a.wallet,trip.id)).status).toBe('accepted');expect((await starterExpeditionEnvelope(f.request.db,Keypair.generate().publicKey.toBase58(),trip.id)).status).toBe('unknown');
 const view=await getBaseState(f.request.db,a.wallet,at,a.baseId,a.authority.assertAuthority,()=>at);expect(view.starterExpeditions?.flight?.expeditionId).toBe(trip.id);
 await expect(f.request.sql`select * from ordinary_equipment_stocks`).rejects.toMatchObject({code:'42501'});
 // 0257 completes the private tail in the restricted caller's same transaction.
 expect(await f.request.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,trip.returnsAt))).toHaveLength(1);
 expect(await f.owner.db.transaction(tx=>settleDueStarterExpeditions(tx,a.baseId,trip.returnsAt))).toHaveLength(0);expect((await starterExpeditionEnvelope(f.request.db,a.wallet,trip.id)).return).not.toBeNull();
 await f.owner.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`delete from ordinary_equipment_releases where trip_kind='starter' and expedition_id=${trip.id}`;});
 await expect(starterExpeditionEnvelope(f.request.db,a.wallet,trip.id)).rejects.toThrow();
}),120000);

it('serializes concurrent owner collection and reversed ordinary raid participants without duplicate returns',()=>fixture(async f=>{
 const a=await f.base(),d=await f.base(),ta=await a.depart(),td=await d.depart(),cutoff=new Date(Math.max(+ta.returnsAt,+td.returnsAt));
 const results=await Promise.allSettled([f.owner.db.transaction(tx=>settleDueAdvancedExpeditions(tx,a.baseId,cutoff)),createRaid(f.request.db,a.actor,raidOptions(a,d),cutoff),createRaid(f.request.db,d.actor,raidOptions(d,a),cutoff)]);
 expect(results[0]!.status).toBe('fulfilled');expect(results.slice(1).some(r=>r.status==='fulfilled')).toBe(true);
 for(const r of results)if(r.status==='rejected')expect(String(r.reason)).not.toMatch(/deadlock|timeout/i);
 expect(await f.owner.sql`select * from advanced_expedition_returns`).toHaveLength(2);expect(await f.owner.sql`select * from advanced_expedition_inflight`).toHaveLength(0);
}),120000);
it('a return after raid creation preserves the earlier raid snapshot and reserved ante',()=>fixture(async f=>{
 const a=await f.base(),d=await f.base(),trip=await d.depart(),options=raidOptions(a,d),cutoff=new Date(+trip.returnsAt-1),raid=await createRaid(f.request.db,a.actor,options,cutoff);
 const before=await f.owner.sql`select row_to_json(r) value from raids r where id=${raid.id}`;expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toBeNull();
 await f.owner.db.transaction(tx=>settleDueAdvancedExpeditions(tx,d.baseId,trip.returnsAt));
 expect(await f.owner.sql`select row_to_json(r) value from raids r where id=${raid.id}`).toEqual(before);expect((await createRaid(f.request.db,a.actor,options,trip.returnsAt)).id).toBe(raid.id);
}),120000);
it('samples transfer time after a real base lock wait and settles the source that became due',()=>fixture(async f=>{
 const a=await f.base(),trip=await a.depart(),buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58();await f.owner.sql`insert into players(wallet) values(${buyer})`;await registerOwnedDeed(f.owner.db,a.actor,deed);
 const observed=new Date(+trip.returnsAt-1),clock=vi.fn(()=>observed);let release!:()=>void,ready!:()=>void,pid=0;
 const gate=new Promise<void>(r=>release=r),held=new Promise<void>(r=>ready=r),holder=f.owner.sql.begin(async tx=>{await tx`select id from bases where id=${a.baseId} for update`;pid=(await tx`select pg_backend_pid() pid`)[0]!.pid;ready();await gate;});
 let pending:Promise<unknown>|undefined;
 try{await held;pending=transferStableBase(f.request.db,a.baseId,a.actor,buyer,deed,{owner:buyer,collection:'test',frozen:false,delegate:null,slot:101,observedAtMs:+observed},clock);
  await expect.poll(async()=>(await f.owner.sql`select exists(select 1 from pg_stat_activity where ${pid}=any(pg_blocking_pids(pid))) waiting`)[0]!.waiting).toBe(true);
  expect(clock).not.toHaveBeenCalled();clock.mockImplementation(()=>trip.returnsAt);release();await pending;
  expect((await readAdvancedExpeditionReturn(f.owner.db,trip.id))!.receipt).toMatchObject({custodyWallet:a.actor,returnedAt:trip.returnsAt});
 }finally{release();await Promise.allSettled([holder,...pending?[pending]:[]]);}
}),120000);
it('rolls a failed native claim and full Lens return back while retaining independently finalized ownership loss',()=>fixture(async f=>{
 const a=await f.base(),trip=await a.depart({itemId:'survey_lens',policyVersion:1,resourceId:'frost_quartz'}),buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();await f.owner.sql`insert into players(wallet) values(${buyer})`;await registerOwnedDeed(f.owner.db,a.actor,deed);
 const request={idempotencyKey:randomUUID(),baseId:a.baseId,deedAssetId:deed},readers={collection,ownerOf:async()=>({owner:buyer,collection,frozen:false,delegate:null,slot:101}),ownedDeeds:async()=>[deed]},transaction=f.request.db.transaction.bind(f.request.db);
 const fail=vi.spyOn(f.request.db,'transaction').mockImplementation((work,config)=>transaction(async tx=>{const result=await work(tx),rows=await tx.execute(sql`select request_key from base_claim_commands where request_key=${request.idempotencyKey}`);if(rows.length)throw Error('fixture late claim rollback');return result;},config));
 try{await expect(executeBaseClaim(f.request.db,readers,buyer,request,()=>trip.returnsAt)).rejects.toThrow('fixture late claim rollback');}finally{fail.mockRestore();}
 expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toBeNull();expect(await f.owner.sql`select * from ordinary_equipment_secondary_returns`).toHaveLength(0);expect(await f.owner.sql`select * from ordinary_equipment_releases`).toHaveLength(0);expect(await f.owner.sql`select * from advanced_expedition_inflight`).toHaveLength(1);
 expect((await f.owner.sql`select owner,status from deed_ownership_observations where base_id=${a.baseId}`)[0]).toMatchObject({owner:buyer,status:'mismatch'});
 await executeBaseClaim(f.request.db,readers,buyer,request,()=>trip.returnsAt);expect((await readAdvancedExpeditionReturn(f.owner.db,trip.id))!.receipt.custodyWallet).toBe(a.actor);
}),120000);

it('defers advanced returns with an outgoing raid and settles seller custody after the existing transfer hold clears',()=>fixture(async f=>{
 const a=await f.base(),d=await f.base(),trip=await a.depart(),buyer=Keypair.generate().publicKey.toBase58(),deed=Keypair.generate().publicKey.toBase58(),collection=Keypair.generate().publicKey.toBase58();await f.owner.sql`insert into players(wallet) values(${buyer})`;await registerOwnedDeed(f.owner.db,a.actor,deed);
 const [raid]=await f.owner.db.insert(raidRows).values({idempotencyKey:randomUUID(),attackerWallet:a.actor,attackerBaseId:a.baseId,defenderWallet:d.actor,defenderBaseId:d.baseId,seed:1n,snapshot:{},armySnapshot:{},simVersion:SIM_VERSION,ordersDeadlineAt:new Date(+trip.returnsAt+60000)}).returning();
 const proof={owner:buyer,collection,frozen:false,delegate:null,slot:101};
 await expect(transferStableBase(f.request.db,a.baseId,a.actor,buyer,deed,{...proof,observedAtMs:+trip.returnsAt},()=>trip.returnsAt)).rejects.toMatchObject({code:'BASE_BUSY_ATTACKING'});
 expect(await refreshBaseOwnership(f.request.db,a.baseId,async()=>proof,collection,trip.returnsAt,'advanced-hold',()=>trip.returnsAt)).toBe('mismatch');expect(await readAdvancedExpeditionReturn(f.owner.db,trip.id)).toBeNull();
 await f.owner.sql`update raids set status='resolved',resolved_at=${trip.returnsAt.toISOString()} where id=${raid!.id}`;
 expect(await refreshBaseOwnership(f.request.db,a.baseId,async()=>proof,collection,trip.returnsAt,'advanced-hold',()=>trip.returnsAt)).toBe('mismatch');expect((await readAdvancedExpeditionReturn(f.owner.db,trip.id))!.receipt.custodyWallet).toBe(a.actor);
}),120000);

it('synthetic historical installations precede the fixture raid cutoff without changing identity',()=>fixture(async f=>{
 const a=await f.base();
 const [timeline]=await f.owner.sql`select r.id,c.reservation_id burn_id,i.reservation_id installation_id,
  r.reserved_at<=${f.at.toISOString()}::timestamptz reservation_ready,
  c.recorded_at<=${f.at.toISOString()}::timestamptz burn_ready,
  i.installed_at<=${f.at.toISOString()}::timestamptz installation_ready
  from vehicle_activation_reservations r join vehicle_burn_consumptions c on c.reservation_id=r.id
  join advanced_vehicle_installations i on i.reservation_id=r.id where r.id=${a.reservation.id}`;
 expect(timeline).toEqual({id:a.reservation.id,burn_id:a.reservation.id,installation_id:a.reservation.id,
  reservation_ready:true,burn_ready:true,installation_ready:true});
 expect((await f.owner.sql`show session_replication_role`)[0]!.session_replication_role).toBe('origin');
}),120000);
