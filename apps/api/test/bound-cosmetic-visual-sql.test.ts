/** Actual immutable cosmetic completions, private preferences and prospective
 * raid presentation. Facilities/snapshots are explicit local fixture facts. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {STRUCTURES} from '@shardkeep/shared';
import {boundCosmeticRecipe,type BoundCosmeticRecipeId} from '@shardkeep/shared/phaseEBoundCosmetics';
import {BoundCosmeticBaseReadSchema,boundCosmeticAwningForCompletedLevel} from '@shardkeep/shared/boundCosmeticVisual';
import {bases,baseSlots,buildings,builderJobs,raids} from '../src/db/schema';
import {createTestPlayer} from './helpers';
import {cosmeticVisualDatabase} from './fixtures/boundCosmeticVisualDatabase';
import {boundCosmeticFixture,earnBoundBlueprint,cosmeticMaterials,cosmeticInsert,type BoundCosmeticFixture} from './fixtures/boundCosmetics';

const conn=cosmeticVisualDatabase(true),db=conn.db;
const awning='craft_artisan_market_awning_t1_v1' as const;
const empty={state:'available',visual:{version:1,marketAwnings:[]}};
const unavailable={state:'unavailable',visual:null};
let legacyId:string;
beforeEach(()=>{for(const key of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(key,'true');});
afterEach(()=>vi.unstubAllEnvs());afterAll(()=>conn.close());
beforeAll(async()=>{
 await conn.setup();const actor=await createTestPlayer(db);
 const [legacy]=await db.insert(raids).values({attackerWallet:actor.wallet,seed:1n,snapshot:{buildings:[]},armySnapshot:[],ordersDeadlineAt:new Date('2035-01-01')}).returning();legacyId=legacy!.id;
 for(const name of ['0280_bound_cosmetic_visuals','0281_bound_cosmetic_visual_source'])await conn.sql.begin(async tx=>{
  for(const statement of readFileSync(new URL(`../drizzle/${name}.sql`,import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);
 });
},180_000);
async function complete(f:BoundCosmeticFixture,id:BoundCosmeticRecipeId=awning){
 await cosmeticMaterials(f,id);const job=await cosmeticInsert(f,id);
 await db.execute(sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${job.id},${job.readyAt.toISOString()}::timestamptz)`);f.now=job.readyAt;return job;
}
async function ready(level=1){const f=await boundCosmeticFixture(db,{level});await earnBoundBlueprint(f);await complete(f);return f;}
async function preference(f:BoundCosmeticFixture,enabled:boolean,revision=1){
 if(revision===1)await db.execute(sql`insert into bound_cosmetic_preferences(wallet,base_id,awning_enabled,revision,updated_at) values(${f.wallet},${f.baseId},${enabled},1,clock_timestamp())`);
 else await db.execute(sql`update bound_cosmetic_preferences set awning_enabled=${enabled},revision=${revision},updated_at=clock_timestamp() where wallet=${f.wallet} and base_id=${f.baseId}`);
}
async function read(f:BoundCosmeticFixture){const [row]=await db.execute<{visual:unknown}>(sql`select public.shardkeep_bound_cosmetic_base_visual(${f.baseId}::uuid,${f.wallet}) visual`);return BoundCosmeticBaseReadSchema.parse(row!.visual);}
async function raid(f:BoundCosmeticFixture,snapshot?:unknown){
 const [row]=await db.insert(raids).values({attackerWallet:f.wallet,defenderWallet:f.wallet,defenderBaseId:f.baseId,seed:1n,
  snapshot:snapshot??{buildings:[{id:f.market.id,type:'market',level:1,tx:5,ty:2}]},armySnapshot:[],ordersDeadlineAt:f.now}).returning();return row!.id;
}
async function raidRead(id:string){const [row]=await db.execute<{visual:unknown}>(sql`select public.shardkeep_bound_cosmetic_raid_visual(${id}::uuid) visual`);return row!.visual;}

it('only a completed original-account Awning can enable; absence and off are verified empty',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);
 expect(await read(f)).toEqual(empty);await cosmeticMaterials(f,awning);const pending=await cosmeticInsert(f,awning);
 await expect(preference(f,true)).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_PREFERENCE_ENTITLEMENT'}});
 await db.execute(sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${pending.id},${pending.readyAt.toISOString()}::timestamptz)`);
 expect(await read(f)).toEqual(empty);await preference(f,true);
 expect(await read(f)).toMatchObject({state:'available',visual:{marketAwnings:[{buildingId:f.market.id,appearance:{outputId:'artisan_market_awning_t1'}}]}});
 await preference(f,false,2);expect(await read(f)).toEqual(empty);
});

it('matches every completed Market level to frozen shared tiers, never the next upgrade target',async()=>{
 const f=await ready(STRUCTURES.market.maxLevel);
 for(const id of ['craft_artisan_market_awning_t2_v1','craft_artisan_market_awning_t3_v1','craft_artisan_market_awning_t4_v1'] as const)await complete(f,id);
 await preference(f,true);
 const body=readFileSync(new URL('../drizzle/0280_bound_cosmetic_visuals.sql',import.meta.url),'utf8');expect(body).toContain(`b.level BETWEEN 1 AND ${STRUCTURES.market.maxLevel}`);
 for(let level=1;level<=STRUCTURES.market.maxLevel;level++){
  await db.update(buildings).set({level}).where(eq(buildings.id,f.market.id));
  expect(await read(f)).toMatchObject({visual:{marketAwnings:[{appearance:{outputId:boundCosmeticAwningForCompletedLevel(level)}}]}});
 }
 const level=boundCosmeticRecipe('craft_artisan_market_awning_t2_v1',1).requiredFacility.level-1;
 await db.update(buildings).set({level}).where(eq(buildings.id,f.market.id));
 await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:f.market.id,kind:'upgrade',startedAt:f.now,finishesAt:new Date(+f.now+1000)});
 expect(await read(f)).toMatchObject({visual:{marketAwnings:[{appearance:{outputId:'artisan_market_awning_t1'}}]}});
});

it('does not show a pending initial build or a completed tier for which this account has no entitlement',async()=>{
 const f=await ready();await preference(f,true);
 const [pending]=await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:f.market.id,kind:'build',startedAt:f.now,finishesAt:new Date(+f.now+1000)}).returning();
 expect(await read(f)).toEqual(empty);await db.delete(builderJobs).where(eq(builderJobs.id,pending!.id));
 await db.update(buildings).set({level:boundCosmeticRecipe('craft_artisan_market_awning_t2_v1',1).requiredFacility.level}).where(eq(buildings.id,f.market.id));
 expect(await read(f)).toEqual(empty);await expect(preference(f,true,2)).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_PREFERENCE_ENTITLEMENT'}});
});

it('retains the original account preference after transfer without gifting it or revealing it through stale ownership',async()=>{
 const f=await ready();await preference(f,true);const buyer=await createTestPlayer(db);
 await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet}).where(eq(bases.id,f.baseId));await tx.insert(baseSlots).values({wallet:buyer.wallet,baseId:f.baseId,slot:1});});
 expect(await read(f)).toEqual(unavailable);expect(await read({...f,wallet:buyer.wallet})).toEqual(empty);
 await expect(preference(f,false,2)).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_PREFERENCE_AUTHORITY'}});
 await expect(preference({...f,wallet:buyer.wallet},true)).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_PREFERENCE_ENTITLEMENT'}});
 expect(await db.execute(sql`select wallet,awning_enabled,revision::text revision from bound_cosmetic_preferences where base_id=${f.baseId}`)).toEqual([{wallet:f.wallet,awning_enabled:true,revision:'1'}]);
 const second=await boundCosmeticFixture(db,{wallet:f.wallet,slot:1});await preference(second,true);
 expect(await read(second)).toMatchObject({visual:{marketAwnings:[{buildingId:second.market.id}]}});
});

it('enforces initial and subsequent revisions, immutable identity and no deletion even for the storage owner',async()=>{
 const f=await ready();await preference(f,true);
 for(const query of [sql`update bound_cosmetic_preferences set revision=revision where base_id=${f.baseId}`,
  sql`update bound_cosmetic_preferences set base_id=${randomUUID()},revision=revision+1 where base_id=${f.baseId}`,
  sql`delete from bound_cosmetic_preferences where base_id=${f.baseId}`,sql`truncate bound_cosmetic_preferences`])await expect(db.execute(query)).rejects.toThrow();
 await preference(f,false,2);expect(await read(f)).toEqual(empty);
 const other=await boundCosmeticFixture(db);await expect(db.execute(sql`insert into bound_cosmetic_preferences(wallet,base_id,awning_enabled,revision,updated_at) values(${other.wallet},${other.baseId},false,2,clock_timestamp())`)).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_PREFERENCE_REVISION'}});
});

it('freezes prospective raid appearance through later toggles, tier changes, transfer and database reopen',async()=>{
 const f=await ready();await preference(f,true);const id=await raid(f),original=await raidRead(id);expect(original).toEqual(await read(f));
 await preference(f,false,2);await db.update(buildings).set({level:boundCosmeticRecipe('craft_artisan_market_awning_t2_v1',1).requiredFacility.level}).where(eq(buildings.id,f.market.id));
 const buyer=await createTestPlayer(db);await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));});
 expect(await raidRead(id)).toEqual(original);
 const reopened=conn.reopen();try{const [row]=await reopened.sql`select public.shardkeep_bound_cosmetic_raid_visual(${id}::uuid) visual`;expect(row!.visual).toEqual(original);}finally{await reopened.sql.end();}
});

it('intersects completed snapshot identity and level without decorating omitted or mismatched rows',async()=>{
 const f=await ready();await preference(f,true);
 for(const buildings of [[],[{id:randomUUID(),type:'market',level:1}],[{id:f.market.id,type:'market',level:6}],[{id:f.market.id,type:'market',level:1,underConstruction:true}]])expect(await raidRead(await raid(f,{buildings}))).toEqual(empty);
 const duplicate={id:f.market.id,type:'market',level:1};expect(await raidRead(await raid(f,{buildings:[duplicate,duplicate]}))).toEqual(unavailable);
});

it('preserves legacy absence and explicit unavailable without any backfill capability',async()=>{
 expect(await raidRead(legacyId)).toBeNull();
 const f=await ready();await preference(f,true);const id=await raid(f,{unavailable:true});
 expect(await raidRead(id)).toEqual(unavailable);
 await expect(db.execute(sql`insert into bound_cosmetic_raid_visuals(raid_id,visual) values(${legacyId},${JSON.stringify(empty)}::jsonb)`)).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_RAID_IMMUTABLE'}});
 await expect(db.execute(sql`select public.shardkeep_bound_cosmetic_raid_capture()`)).rejects.toThrow();
 expect(await raidRead(legacyId)).toBeNull();
});

it('refuses owner or accidentally granted direct sidecar mutations and rolls back capture with its raid',async()=>{
 const f=await ready();await preference(f,true);const id=await raid(f);
 for(const query of [sql`update bound_cosmetic_raid_visuals set visual=${JSON.stringify(empty)}::jsonb where raid_id=${id}`,
  sql`delete from bound_cosmetic_raid_visuals where raid_id=${id}`,sql`truncate bound_cosmetic_raid_visuals`])await expect(db.execute(query)).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_RAID_IMMUTABLE'}});
 const aborted=randomUUID();await expect(db.transaction(async tx=>{await tx.insert(raids).values({id:aborted,attackerWallet:f.wallet,defenderWallet:f.wallet,defenderBaseId:f.baseId,seed:1n,snapshot:{buildings:[]},armySnapshot:[],ordersDeadlineAt:f.now});throw Error('outer rollback');})).rejects.toThrow('outer rollback');
 expect(await raidRead(aborted)).toBeNull();
});

it('allows only public projections to a restricted request role and denies raw tables or private helpers',async()=>{
 const f=await ready();await preference(f,true);const id=await raid(f),expected=await raidRead(id),role=`cosmetic_visual_${randomUUID().replaceAll('-','')}`;
 await conn.sql.unsafe(`create role ${role} noinherit`);
 try{
  await conn.sql.unsafe(`grant usage on schema public to ${role}`);
  // The successor permits only standard runtime groups. Membership models a
  // request login; all raw tables remain private.
  await conn.sql.unsafe('DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname=\'shardkeep_api_runtime\') THEN CREATE ROLE shardkeep_api_runtime NOLOGIN;END IF;END $$');
  await conn.sql.unsafe(`grant shardkeep_api_runtime to ${role}`);
  await conn.sql.unsafe('grant execute on function public.shardkeep_bound_cosmetic_base_visual(uuid,text),public.shardkeep_bound_cosmetic_raid_visual(uuid) to shardkeep_api_runtime');
  await conn.sql.begin(async tx=>{await tx.unsafe(`set local session authorization ${role}`);await tx.unsafe(`set local role shardkeep_api_runtime`);
   expect((await tx`select public.shardkeep_bound_cosmetic_base_visual(${f.baseId}::uuid,${f.wallet}) visual`)[0]!.visual).toEqual(expected);
   expect((await tx`select public.shardkeep_bound_cosmetic_raid_visual(${id}::uuid) visual`)[0]!.visual).toEqual(expected);
  });
  for(const query of ['select * from bound_cosmetic_preferences','select * from bound_cosmetic_raid_visuals',`select public.shardkeep_bound_cosmetic_market_awnings('${f.baseId}','${f.wallet}')`])await expect(conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(query);})).rejects.toMatchObject({code:'42501'});
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(`grant insert on bound_cosmetic_raid_visuals to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`insert into bound_cosmetic_raid_visuals(raid_id,visual) values(${legacyId},${JSON.stringify(empty)}::jsonb)`;})).rejects.toThrow('BOUND_COSMETIC_RAID_IMMUTABLE');
  await expect(conn.sql.begin(async tx=>{await tx.unsafe(`grant insert on bound_cosmetic_preferences to ${role}`);await tx.unsafe(`set local role ${role}`);await tx`insert into bound_cosmetic_preferences(wallet,base_id,awning_enabled,revision,updated_at) values(${f.wallet},${f.baseId},false,1,clock_timestamp())`;})).rejects.toThrow('BOUND_COSMETIC_PREFERENCE_OWNER');
 }finally{await conn.sql.unsafe(`drop owned by ${role}`);await conn.sql.unsafe(`drop role ${role}`);}
});

it('fails current and retained projections closed when a pinned source changes, then recovers after rollback',async()=>{
 const f=await ready();await preference(f,true);const id=await raid(f),original=await read(f);
 await expect(db.transaction(async tx=>{
  await tx.execute(sql`alter function public.shardkeep_bound_cosmetic_market_awnings(uuid,text) immutable`);
  const [row]=await tx.execute<{current:unknown;frozen:unknown}>(sql`select public.shardkeep_bound_cosmetic_base_visual(${f.baseId}::uuid,${f.wallet}) current,public.shardkeep_bound_cosmetic_raid_visual(${id}::uuid) frozen`);
  expect(row).toEqual({current:unavailable,frozen:unavailable});throw Error('rollback source probe');
 })).rejects.toThrow('rollback source probe');
 expect(await read(f)).toEqual(original);expect(await raidRead(id)).toEqual(original);
});
