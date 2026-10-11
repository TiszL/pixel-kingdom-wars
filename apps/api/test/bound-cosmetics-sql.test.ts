/** Once-only account appearance custody; all external source facts are local
 * fixtures. This suite does not admit delivery, rendering, signing or launch. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,afterEach,beforeEach,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {boundCosmeticRecipe,BoundCosmeticRecipeIdSchema} from '@shardkeep/shared/phaseEBoundCosmetics';
import {BoundCosmeticAppearanceSchema} from '@shardkeep/shared/boundCosmeticApi';
import {ordinaryCraftingRecipe,ORDINARY_REFINED_INPUTS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {bases,baseSlots,buildings,builderJobs,craftingStocks} from '../src/db/schema';
import {startOrdinaryEquipment} from '../src/game/ordinaryEquipment';
import {startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {connectTestDb,createTestPlayer} from './helpers';
import {loadPhaseECosmeticsPack} from '../../../scripts/src/phase-e-cosmetics-pack';
import {blueprintId,boundCosmeticFixture,earnBoundBlueprint,cosmeticMaterials,cosmeticInsert,cosmeticStock,pendingOrdinary} from './fixtures/boundCosmetics';
const conn=connectTestDb(),db=conn.db;
const awning='craft_artisan_market_awning_t1_v1',wake='craft_aurora_wake_v1';
beforeEach(()=>{for(const name of ['MULTI_BASE_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(name,'true');});
afterEach(()=>vi.unstubAllEnvs());afterAll(()=>conn.sql.end());
const migration=readFileSync(new URL('../drizzle/0278_bound_cosmetics.sql',import.meta.url),'utf8');
const complete=(id:string,at:Date,connection=db)=>connection.execute(sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${id},${at.toISOString()}::timestamptz)`);

it('pins every shared recipe and admitted source identity without a caller readiness switch',async()=>{
 const pack=await loadPhaseECosmeticsPack();
 for(const id of BoundCosmeticRecipeIdSchema.options){
  const recipe=boundCosmeticRecipe(id,1);
  expect(migration).toContain(JSON.stringify(recipe));
  const [row]=await db.execute<{recipe:unknown;appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_recipe(${id}) recipe,public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
  expect(row!.recipe).toEqual(recipe);const appearance=BoundCosmeticAppearanceSchema.parse(row!.appearance),binding=pack.metadata.bindings[recipe.outputId]!;
  expect(appearance).toEqual({version:1,outputId:recipe.outputId,sourceId:binding.value.sourceId,sourceManifestSha256:binding.value.sourceManifestSha256,sourceIndexSha256:binding.value.sourceIndexSha256,bindingSha256:binding.sha256});
 }
 for(const item of Object.keys(ORDINARY_REFINED_INPUTS))expect(migration).toContain(JSON.stringify(ordinaryCraftingRecipe(`refine_${item}` as Parameters<typeof ordinaryCraftingRecipe>[0],1,1)));
 expect(await db.execute(sql`select public.shardkeep_bound_cosmetic_recipe('unadmitted') recipe,public.shardkeep_bound_cosmetic_appearance('unadmitted') appearance`)).toEqual([{recipe:null,appearance:null}]);
});

it.each([1,2])('earns one Blueprint from genuine completed refining version %i and keeps it with the original actor',async version=>{
 const f=await boundCosmeticFixture(db),source=await earnBoundBlueprint(f,version,false),buyer=await createTestPlayer(db);
 await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));});
 await db.execute(sql`insert into bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${f.wallet},${blueprintId},${source},${f.now.toISOString()}::timestamptz)`);
 await expect(db.execute(sql`insert into bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${buyer.wallet},${blueprintId},${source},${f.now.toISOString()}::timestamptz)`)).rejects.toThrow();
 await expect(db.execute(sql`insert into bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${f.wallet},${blueprintId},${source},${f.now.toISOString()}::timestamptz)`)).rejects.toThrow();
 expect(await db.execute(sql`select wallet,source_job_id from bound_cosmetic_blueprints where source_job_id=${source}`)).toEqual([{wallet:f.wallet,source_job_id:source}]);
});

it('pending refining and completion after the grant time cannot grant an early Blueprint',async()=>{
 const f=await boundCosmeticFixture(db),pending=await pendingOrdinary(f);
 await expect(db.execute(sql`insert into bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${f.wallet},${blueprintId},${pending.job.id},${f.now.toISOString()}::timestamptz)`)).rejects.toThrow();
 await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,pending.job.readyAt));
 await expect(db.execute(sql`insert into bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${f.wallet},${blueprintId},${pending.job.id},${f.now.toISOString()}::timestamptz)`)).rejects.toThrow();
 expect(await db.execute(sql`select * from bound_cosmetic_blueprints where wallet=${f.wallet}`)).toEqual([]);
});

it('completed non-refining work and bought refined stock do not substitute for original refining',async()=>{
 const f=await boundCosmeticFixture(db);
 for(const input of ordinaryCraftingRecipe('craft_navigation_kit',1,1).inputs)await db.insert(craftingStocks).values({baseId:f.baseId,itemId:input.itemId,available:BigInt(input.quantity)});
 const job=await pendingOrdinary(f,'craft_navigation_kit');f.now=job.job.readyAt;
 await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
 await expect(db.execute(sql`insert into bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${f.wallet},${blueprintId},${job.job.id},${f.now.toISOString()}::timestamptz)`)).rejects.toThrow();
 await cosmeticMaterials(f,awning);await expect(cosmeticInsert(f,awning)).rejects.toThrow();
});

it.each(BoundCosmeticRecipeIdSchema.options)('debits exact available refined inputs once for %s and records no economic reward',async id=>{
 const recipe=boundCosmeticRecipe(id,1),f=await boundCosmeticFixture(db,{level:recipe.requiredFacility.level});await earnBoundBlueprint(f);await cosmeticMaterials(f,id);
 const ledgerBefore=await db.execute(sql`select count(*)::text n from ledger_transactions`),before=await cosmeticStock(f),job=await cosmeticInsert(f,id);
 for(const input of recipe.inputs){const row=(await cosmeticStock(f)).find(s=>s.itemId===input.itemId)!;expect(row.available).toBe(0n);expect(row.pendingOutput).toBe(0n);}
 await expect(cosmeticInsert(f,id,{id:job.id,onConflict:true})).rejects.toThrow();
 await complete(job.id,job.readyAt);await expect(cosmeticInsert(f,id)).rejects.toThrow();
 expect(await db.execute(sql`select count(*)::text n from ledger_transactions`)).toEqual(ledgerBefore);
 expect(await db.execute(sql`select j.actor_wallet,j.output_id from bound_cosmetic_jobs j join bound_cosmetic_completions c on c.job_id=j.id where j.id=${job.id}`)).toEqual([{actor_wallet:f.wallet,output_id:recipe.outputId}]);
 for(const input of recipe.inputs)expect(before.find(s=>s.itemId===input.itemId)!.available).toBe(BigInt(input.quantity));
});

it('pending output cannot substitute for missing available material and outer rollback preserves all stock',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);const recipe=await cosmeticMaterials(f,awning);
 await db.update(craftingStocks).set({available:0n,pendingOutput:BigInt(recipe.inputs.at(-1)!.quantity)}).where(and(eq(craftingStocks.baseId,f.baseId),eq(craftingStocks.itemId,recipe.inputs.at(-1)!.itemId)));
 const before=await cosmeticStock(f);
 await expect(cosmeticInsert(f,awning)).rejects.toThrow();expect(await cosmeticStock(f)).toEqual(before);
 await cosmeticMaterials(f,awning);const funded=await cosmeticStock(f);
 await expect(db.transaction(async tx=>{await cosmeticInsert(f,awning,{db:tx});throw Error('outer rollback');})).rejects.toThrow('outer rollback');
 expect(await cosmeticStock(f)).toEqual(funded);expect(await db.execute(sql`select id from bound_cosmetic_jobs where actor_wallet=${f.wallet}`)).toEqual([]);
});

it('serializes account-wide duplicate outputs across bases before a second charge',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);await cosmeticMaterials(f,awning);
 const second=await boundCosmeticFixture(db,{wallet:f.wallet,slot:2});second.now=f.now;await cosmeticMaterials(second,awning);
 const attempts=await Promise.allSettled([cosmeticInsert(f,awning),cosmeticInsert(second,awning)]);
 expect(attempts.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(attempts.filter(v=>v.status==='rejected')).toHaveLength(1);
 const recipe=boundCosmeticRecipe(awning,1);
 for(const input of recipe.inputs){const remaining=[...await cosmeticStock(f),...await cosmeticStock(second)].filter(s=>s.itemId===input.itemId).reduce((n,s)=>n+s.available,0n);expect(remaining).toBe(BigInt(input.quantity));}
});

it('allows different account outputs on separate base Workshop slots',async()=>{
 const first=await boundCosmeticFixture(db);await earnBoundBlueprint(first);await cosmeticMaterials(first,awning);
 const second=await boundCosmeticFixture(db,{wallet:first.wallet,slot:2});second.now=first.now;await cosmeticMaterials(second,wake);
 const jobs=await Promise.all([cosmeticInsert(first,awning),cosmeticInsert(second,wake)]);
 expect(jobs.map(j=>j.recipe.outputId)).toEqual(['artisan_market_awning_t1','aurora_wake']);
});

it('a competing global UUID skipped by ON CONFLICT never consumes the losing actor materials',async()=>{
 const first=await boundCosmeticFixture(db),second=await boundCosmeticFixture(db);
 for(const f of [first,second]){await earnBoundBlueprint(f);await cosmeticMaterials(f,awning);}
 const id=randomUUID(),before=await cosmeticStock(second);
 let release!:()=>void,inserted!:()=>void,pidReady!:(pid:number)=>void;
 const held=new Promise<void>(resolve=>{inserted=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;}),pidSignal=new Promise<number>(resolve=>{pidReady=resolve;});
 const winner=db.transaction(async tx=>{await cosmeticInsert(first,awning,{db:tx,id});inserted();await finish;});
 await held;
 const loser=db.transaction(async tx=>{const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);pidReady(row!.pid);await cosmeticInsert(second,awning,{db:tx,id,onConflict:true});});
 try{
  const pid=await pidSignal;
  await vi.waitFor(async()=>{const [state]=await db.execute<{waiting:boolean}>(sql`select wait_event_type='Lock' waiting from pg_stat_activity where pid=${pid}`);expect(state?.waiting).toBe(true);},{timeout:2000,interval:20});
 }finally{release();await winner;}
 await loser;expect(await cosmeticStock(second)).toEqual(before);
 expect(await db.execute(sql`select actor_wallet from bound_cosmetic_jobs where id=${id}`)).toEqual([{actor_wallet:first.wallet}]);
});

it('rejects different appearances, recipe quantity, facility level and incomplete construction before charging',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);const recipe=await cosmeticMaterials(f,awning),before=await cosmeticStock(f);
 const [row]=await db.execute<{appearance:Record<string,unknown>}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
 for(const appearance of [{...row!.appearance,bindingSha256:'00'.repeat(32)},{...row!.appearance,ready:true},{...row!.appearance,sourceId:'auroraWake'}])await expect(cosmeticInsert(f,awning,{appearance})).rejects.toThrow();
 await expect(cosmeticInsert(f,awning,{recipe:{...recipe,quantity:1}})).rejects.toThrow();
 await db.update(buildings).set({level:0}).where(eq(buildings.id,f.market.id));await expect(cosmeticInsert(f,awning)).rejects.toThrow();
 await db.update(buildings).set({level:1}).where(eq(buildings.id,f.market.id));
 const [pending]=await db.insert(builderJobs).values({baseId:f.baseId,playerWallet:f.wallet,buildingId:f.market.id,kind:'build',startedAt:f.now,finishesAt:new Date(+f.now+1000)}).returning();
 await expect(cosmeticInsert(f,awning)).rejects.toThrow();await db.delete(builderJobs).where(eq(builderJobs.id,pending!.id));
 expect(await cosmeticStock(f)).toEqual(before);
});

it('shares one Workshop slot in both directions with ordinary and equipment writers',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);await cosmeticMaterials(f,awning);
 const pending=await pendingOrdinary(f);
 expect(await startOrdinaryCrafting(db,f.wallet,{id:pending.job.id,baseId:f.baseId,recipeId:pending.job.recipeId,recipeVersion:pending.job.recipeVersion,quantity:pending.job.quantity},f.authority,{clock:()=>f.now})).toEqual(pending);
 await expect(cosmeticInsert(f,awning)).rejects.toThrow();
 f.now=pending.job.readyAt;await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
 const accepted=await cosmeticInsert(f,awning);
 await expect(pendingOrdinary(f,'refine_crownsteel')).rejects.toThrow();
 const equipmentRequest={idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1} as const;
 for(const input of ordinaryEquipmentRecipe().inputs)await db.insert(craftingStocks).values({baseId:f.baseId,itemId:input.itemId,available:BigInt(input.quantity)}).onConflictDoUpdate({target:[craftingStocks.baseId,craftingStocks.itemId],set:{available:BigInt(input.quantity)}});
 await expect(startOrdinaryEquipment(db,f.wallet,equipmentRequest,f.authority,{clock:()=>f.now})).rejects.toThrow();
 await complete(accepted.id,accepted.readyAt);f.now=accepted.readyAt;
 const equipment=await startOrdinaryEquipment(db,f.wallet,equipmentRequest,f.authority,{clock:()=>f.now});
 expect((await startOrdinaryEquipment(db,f.wallet,equipmentRequest,f.authority,{clock:()=>f.now})).receipt).toEqual(equipment.receipt);
 await cosmeticMaterials(f,wake);await expect(cosmeticInsert(f,wake)).rejects.toThrow();
});

it('completes the original account obligation after transfer, pause and facility loss with no second debit',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);await cosmeticMaterials(f,awning);const job=await cosmeticInsert(f,awning),before=await cosmeticStock(f);
 await expect(complete(job.id,new Date(+job.readyAt-1))).rejects.toThrow();
 const buyer=await createTestPlayer(db);
 await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet,status:'inactive'}).where(eq(bases.id,f.baseId));await tx.update(buildings).set({level:0}).where(eq(buildings.baseId,f.baseId));});
 vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');
 await expect(db.transaction(async tx=>{await tx.execute(sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${job.id},${job.readyAt.toISOString()}::timestamptz)`);throw Error('completion rollback');})).rejects.toThrow('completion rollback');
 expect(await db.execute(sql`select * from bound_cosmetic_completions where job_id=${job.id}`)).toEqual([]);
 const attempts=await Promise.allSettled([complete(job.id,job.readyAt),complete(job.id,job.readyAt)]);expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);
 expect(await cosmeticStock(f)).toEqual(before);
 expect(await db.execute(sql`select j.actor_wallet from bound_cosmetic_jobs j join bound_cosmetic_completions c on c.job_id=j.id where j.id=${job.id}`)).toEqual([{actor_wallet:f.wallet}]);
});

it('automatic completion does not acquire a reverse player lock while holding its base',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);await cosmeticMaterials(f,awning);const job=await cosmeticInsert(f,awning);
 let release!:()=>void,locked!:()=>void;const held=new Promise<void>(resolve=>{locked=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
 const holder=db.transaction(async tx=>{await tx.execute(sql`select wallet from players where wallet=${f.wallet} for update`);locked();await finish;});
 await held;
 try{await db.transaction(async tx=>{await tx.execute(sql`set local lock_timeout='250ms'`);await tx.execute(sql`select id from bases where id=${f.baseId} for update`);await tx.execute(sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${job.id},${job.readyAt.toISOString()}::timestamptz)`);});}
 finally{release();await holder;}
});

it('private source history refuses edits, deletes, truncation and restricted reads or writes',async()=>{
 const f=await boundCosmeticFixture(db);await earnBoundBlueprint(f);await cosmeticMaterials(f,awning);const job=await cosmeticInsert(f,awning);await complete(job.id,job.readyAt);
 for(const table of ['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions']){
  const where=table==='bound_cosmetic_blueprints'?sql`wallet=${f.wallet}`:table==='bound_cosmetic_jobs'?sql`id=${job.id}`:sql`job_id=${job.id}`;
  const column=table==='bound_cosmetic_blueprints'?'granted_at':table==='bound_cosmetic_jobs'?'started_at':'completed_at';
  await expect(db.execute(sql`update ${sql.raw(table)} set ${sql.raw(column)}=${sql.raw(column)} where ${where}`)).rejects.toThrow();
  await expect(db.execute(sql`delete from ${sql.raw(table)} where ${where}`)).rejects.toThrow();await expect(db.execute(sql`truncate ${sql.raw(table)} cascade`)).rejects.toThrow();
 }
 await cosmeticMaterials(f,wake);await cosmeticInsert(f,wake);
 const role='bound_cosmetic_test_'+randomUUID().replaceAll('-','');
 await expect(db.transaction(async tx=>{
  await tx.execute(sql.raw(`create role ${role}`));
  for(const table of ['bound_cosmetic_blueprints','bound_cosmetic_jobs','bound_cosmetic_completions'])await expect(tx.transaction(async restricted=>{await restricted.execute(sql.raw(`set local role ${role}`));await restricted.execute(sql.raw(`select * from ${table}`));})).rejects.toThrow();
  await tx.execute(sql.raw(`grant insert on bound_cosmetic_completions to ${role}`));
  await expect(tx.transaction(async restricted=>{await restricted.execute(sql.raw(`set local role ${role}`));await restricted.execute(sql`insert into bound_cosmetic_completions(job_id,completed_at) values(${job.id},${job.readyAt.toISOString()}::timestamptz)`);})).rejects.toMatchObject({cause:{code:'42501',message:'BOUND_COSMETIC_OWNER'}});
  await tx.execute(sql.raw(`grant insert on ordinary_crafting_jobs to ${role}`));
  // The trigger can enforce the private queue without giving this role a
  // private SELECT grant; its existing caller permissions remain unchanged.
  await expect(tx.transaction(async restricted=>{await restricted.execute(sql.raw(`set local role ${role}`));await restricted.execute(sql`insert into ordinary_crafting_jobs(id,actor_wallet,base_id,recipe_id,recipe_version,quantity,recipe_snapshot,output_item_id,output_quantity,workshop_id,workshop_completed_job_id,started_at,ready_at) values(${randomUUID()},${f.wallet},${f.baseId},'invalid',1,1,'{}','invalid',1,${f.workshop.id},${f.workshop.jobId},${f.now.toISOString()}::timestamptz,${new Date(+f.now+1000).toISOString()}::timestamptz)`);})).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_WORKSHOP_BUSY'}});
  throw Error('rollback fixture role');
 })).rejects.toThrow('rollback fixture role');
});
