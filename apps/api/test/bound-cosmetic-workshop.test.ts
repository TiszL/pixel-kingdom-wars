/** Unmounted owner provider, actual earned source and custody; placements,
 * opening stocks and finalized observation rows are declared local fixtures. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {beforeAll,afterAll,beforeEach,afterEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {BASE_OWNERSHIP} from '@shardkeep/shared';
import {BoundCosmeticAppearanceSchema} from '@shardkeep/shared/boundCosmeticApi';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {createDb} from '../src/db/client';
import {bases,baseSlots,craftingStocks,deedOwnershipObservations} from '../src/db/schema';
import {createBoundCosmeticWorkshop} from '../src/game/boundCosmeticWorkshop';
import {settleDueOrdinaryCrafting,startOrdinaryCrafting} from '../src/game/ordinaryCrafting';
import {observationHash} from '../src/game/baseOwnership';
import {startOrdinaryEquipment} from '../src/game/ordinaryEquipment';
import {cosmeticVisualDatabase} from './fixtures/boundCosmeticVisualDatabase';
import {boundCosmeticFixture,cosmeticMaterials,cosmeticStock,pendingOrdinary} from './fixtures/boundCosmetics';
import {createTestPlayer} from './helpers';
import {ADMIN_DATABASE_URL} from './db-url';
const conn=cosmeticVisualDatabase(),db=conn.db;
beforeAll(()=>conn.setup(),180000);afterAll(()=>conn.close());
beforeEach(()=>{for(const name of ['MULTI_BASE_ENABLED','PHASE_E_CATALOG_ENABLED','PHASE_E_BUILDINGS_ENABLED','ORDINARY_CRAFTING_ENABLED'])vi.stubEnv(name,'true');});afterEach(()=>vi.unstubAllEnvs());
async function prepared(settleSource=true){
 const f=await boundCosmeticFixture(db),at=new Date(Date.now()-86400000),shift=+at-+f.now;
 // These are newly inserted facility fixtures, before any immutable job uses them.
 await db.execute(sql`update builder_jobs set started_at=started_at+${shift}*interval '1 millisecond',finishes_at=finishes_at+${shift}*interval '1 millisecond',completed_at=completed_at+${shift}*interval '1 millisecond' where base_id=${f.baseId}`);
 f.now=at;const source=await pendingOrdinary(f);f.now=source.job.readyAt;if(settleSource)await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
 const recipe=await cosmeticMaterials(f,'craft_artisan_market_awning_t1_v1');
 const [row]=await db.execute<{appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
 const appearance=BoundCosmeticAppearanceSchema.parse(row!.appearance),request={idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:recipe.recipeId,recipeVersion:recipe.recipeVersion,appearanceBindingSha256:appearance.bindingSha256};
 const provider=createBoundCosmeticWorkshop(db,{awningApplicationReady:true,clock:()=>f.now});return {f,provider,request,source,appearance};
}
it('composes actual Blueprint, canonical recipes, protected stock, original craft, completion and free preference',async()=>{
 const {f,provider,request,source,appearance}=await prepared(false),initial=await provider.view(f.wallet,f.baseId);
 expect(initial.blueprint).toMatchObject({state:'eligible',proof:{jobId:source.job.id,actorWallet:f.wallet}});expect(initial.recipes).toHaveLength(4);expect(initial.originals).toEqual([]);
 expect(initial.selectedBase).toMatchObject({state:'available',workshops:[{buildingId:f.workshop.id}],markets:[{buildingId:f.market.id}],queue:[],preference:{enabled:false,revision:'0'}});
 const started=await provider.start(f.wallet,request);if(started.status!=='accepted')throw Error('Expected actual original');
 const pending=await provider.view(f.wallet,f.baseId);expect(pending.selectedBase).toMatchObject({queue:[{kind:'cosmetic',jobId:request.idempotencyKey}]});
 f.now=new Date(started.receipt.readyAt);const completed=await provider.view(f.wallet,f.baseId);expect(completed.originals[0]!.completion).toEqual({completedAt:f.now.toISOString()});
 const choice=await provider.preference(f.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'0'});
 expect(choice).toMatchObject({revision:'1',visual:{state:'available',visual:{marketAwnings:[{buildingId:f.market.id,appearance}]}}});
 expect(await provider.preference(f.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'0'})).toEqual(choice);
 await expect(provider.preference(f.wallet,{baseId:f.baseId,enabled:false,expectedRevision:'0'})).rejects.toMatchObject({code:'BOUND_COSMETIC_PREFERENCE_CHANGED'});
});
it('default application hold and pause deny new starts/equip-on but allow original completion, retry and equip-off',async()=>{
 const {f,provider,request}=await prepared(),held=createBoundCosmeticWorkshop(db,{awningApplicationReady:false,clock:()=>f.now});
 expect((await createBoundCosmeticWorkshop(db).view(f.wallet)).applicationReady).toBe(false);
 await expect(held.start(f.wallet,request)).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 const started=await provider.start(f.wallet,request);if(started.status!=='accepted')throw Error('Expected original');f.now=new Date(started.receipt.readyAt);await provider.read(f.wallet,request.idempotencyKey);
 await provider.preference(f.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'0'});vi.stubEnv('PHASE_E_CATALOG_ENABLED','false');vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');
 expect((await held.view(f.wallet,f.baseId)).acceptingJobs).toBe(false);expect((await held.start(f.wallet,request)).receipt).toEqual(started.receipt);
 await expect(held.preference(f.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'1'})).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 expect((await held.preference(f.wallet,{baseId:f.baseId,enabled:false,expectedRevision:'1'})).revision).toBe('2');
 await expect(provider.start(f.wallet,{...request,idempotencyKey:randomUUID(),recipeId:'craft_aurora_wake_v1'})).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 await expect(held.start(f.wallet,{...request,baseId:randomUUID()})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
});
it('recovers the original account after transfer and does not expose another account inventory or original',async()=>{
 const {f,provider,request}=await prepared(),accepted=await provider.start(f.wallet,request);if(accepted.status!=='accepted')throw Error('Expected original');
 const buyer=await createTestPlayer(db);await db.transaction(async tx=>{await tx.delete(baseSlots).where(eq(baseSlots.baseId,f.baseId));await tx.update(bases).set({ownerWallet:buyer.wallet}).where(eq(bases.id,f.baseId));await tx.insert(baseSlots).values({wallet:buyer.wallet,baseId:f.baseId,slot:1});});
 f.now=new Date(accepted.receipt.readyAt);const original=await provider.read(f.wallet,request.idempotencyKey);expect(original.completion).not.toBeNull();
 expect((await provider.start(f.wallet,request)).receipt).toEqual(accepted.receipt);
 const view=await provider.view(f.wallet,f.baseId);expect(view.originals).toHaveLength(1);expect(view.selectedBase).toEqual({state:'unavailable',baseId:f.baseId,reason:'BASE_NOT_OWNED'});
 expect((await provider.read(buyer.wallet,request.idempotencyKey)).status).toBe('unknown');expect((await provider.view(buyer.wallet)).originals).toEqual([]);
 await expect(provider.preference(buyer.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'0'})).rejects.toMatchObject({cause:{message:'BOUND_COSMETIC_PREFERENCE_ENTITLEMENT'}});
});
it('reports the shared ordinary, equipment and cosmetic queue and privately frees a due slot before foreground locks',async()=>{
 const {f,provider,request}=await prepared(),ordinary=await pendingOrdinary(f,'refine_crownsteel');
 expect((await provider.view(f.wallet,f.baseId)).selectedBase).toMatchObject({queue:[{kind:'ordinary',jobId:ordinary.job.id}]});
 await expect(provider.start(f.wallet,request)).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
 f.now=ordinary.job.readyAt;await provider.view(f.wallet,f.baseId);
 for(const input of ordinaryEquipmentRecipe().inputs)await db.insert(craftingStocks).values({baseId:f.baseId,itemId:input.itemId,available:BigInt(input.quantity)}).onConflictDoUpdate({target:[craftingStocks.baseId,craftingStocks.itemId],set:{available:BigInt(input.quantity)}});
 const equipment=await startOrdinaryEquipment(db,f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1},f.authority,{clock:()=>f.now});
 if(equipment.status!=='accepted')throw Error('Expected equipment');expect((await provider.view(f.wallet,f.baseId)).selectedBase).toMatchObject({queue:[{kind:'equipment',jobId:equipment.receipt.jobId}]});
 f.now=new Date(equipment.receipt.readyAt);await provider.view(f.wallet,f.baseId);await cosmeticMaterials(f,'craft_artisan_market_awning_t1_v1');
 const cosmetic=await provider.start(f.wallet,request);if(cosmetic.status!=='accepted')throw Error('Expected cosmetic');
 const beforeBusy=await cosmeticStock(f);
 await expect(pendingOrdinary(f,'refine_embercore')).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
 await expect(startOrdinaryEquipment(db,f.wallet,{idempotencyKey:randomUUID(),baseId:f.baseId,recipeId:'craft_route_compass',recipeVersion:1,quantity:1},f.authority,{clock:()=>f.now})).rejects.toMatchObject({code:'ORDINARY_CRAFTING_BUSY'});
 expect(await cosmeticStock(f)).toEqual(beforeBusy);f.now=new Date(cosmetic.receipt.readyAt);
 vi.stubEnv('ORDINARY_CRAFTING_ENABLED','false');expect(await provider.collectForBaseRead(f.wallet,f.baseId)).toBe(f.baseId);
 expect((await provider.read(f.wallet,request.idempotencyKey)).completion).not.toBeNull();vi.stubEnv('ORDINARY_CRAFTING_ENABLED','true');
 expect((await startOrdinaryCrafting(db,f.wallet,{id:randomUUID(),baseId:f.baseId,recipeId:'refine_embercore',recipeVersion:1,quantity:1},f.authority,{clock:()=>f.now})).job.recipeId).toBe('refine_embercore');
});
it('keeps unavailable finalized authority out of base status and rolls back when the final locked proof expires',async()=>{
 const {f,provider,request}=await prepared(),asset=Keypair.generate().publicKey.toBase58(),before=await cosmeticStock(f);
 await db.update(bases).set({deedAssetId:asset,deedMintAssetId:asset}).where(eq(bases.id,f.baseId));
 expect((await provider.view(f.wallet,f.baseId)).selectedBase).toEqual({state:'unavailable',baseId:f.baseId,reason:'DEED_AUTHORITY_UNAVAILABLE'});
 await expect(provider.start(f.wallet,request)).rejects.toMatchObject({code:'DEED_AUTHORITY_UNAVAILABLE'});
 await db.insert(deedOwnershipObservations).values({baseId:f.baseId,assetId:asset,owner:f.wallet,slot:100n,status:'owned',checkedAt:f.now,source:'fixture',auditHash:observationHash(asset,f.wallet,'owned',100n,f.now)});
 let calls=0;const expiring=createBoundCosmeticWorkshop(db,{awningApplicationReady:true,clock:()=>new Date(+f.now+(++calls>=5?BASE_OWNERSHIP.mutationFreshnessMs+1:0))});
 await expect(expiring.start(f.wallet,request)).rejects.toMatchObject({code:'DEED_AUTHORITY_UNAVAILABLE'});
 expect(await cosmeticStock(f)).toEqual(before);expect((await provider.read(f.wallet,request.idempotencyKey)).status).toBe('unknown');
 expect(await db.execute(sql`select * from bound_cosmetic_blueprints where wallet=${f.wallet}`)).toEqual([]);
});
it('does not disguise a changed source as unavailable selected-base authority',async()=>{
 const {f,provider}=await prepared();await conn.sql`alter function public.shardkeep_bound_cosmetic_market_awnings(uuid,text) immutable`;
 try{await expect(provider.view(f.wallet,f.baseId)).rejects.toThrow('BOUND_COSMETIC_WORKSHOP_SOURCE');}
 finally{await conn.sql`alter function public.shardkeep_bound_cosmetic_market_awnings(uuid,text) stable`;}
 expect((await provider.view(f.wallet)).blueprint.state).toBe('eligible');
});
it('refuses every closed capability on a real non-owner login before any private state is exposed',async()=>{
 const {f,request}=await prepared(),role='cosmetic_workshop_'+randomUUID().replaceAll('-',''),password=randomUUID(),[current]=await conn.sql`select current_database() name`;
 const url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+current!.name;url.username=role;url.password=password;
 await conn.sql.unsafe(`create role ${role} login password '${password}'`);const restricted=createDb(url.toString(),{max:1});
 try{
  const provider=createBoundCosmeticWorkshop(restricted.db,{awningApplicationReady:true});
  for(const call of [()=>provider.view(f.wallet),()=>provider.read(f.wallet,request.idempotencyKey),()=>provider.start(f.wallet,request),()=>provider.preference(f.wallet,{baseId:f.baseId,enabled:false,expectedRevision:'0'}),()=>provider.collectForBaseRead(f.wallet,f.baseId)])await expect(call()).rejects.toMatchObject({code:'BOUND_COSMETIC_OWNER'});
 }finally{await restricted.sql.end();await conn.sql.unsafe(`drop owned by ${role}`);await conn.sql.unsafe(`drop role ${role}`);}
});
it('checks actual application admission again after material writes and rolls back when the renderer becomes unavailable',async()=>{
 const {f,request}=await prepared(),before=await cosmeticStock(f);let checks=0;
 const provider=createBoundCosmeticWorkshop(db,{clock:()=>f.now,awningApplicationReady:appearances=>{
  expect(appearances).toHaveLength(4);expect(appearances.find(a=>a.outputId==='artisan_market_awning_t1')!.bindingSha256).toBe(request.appearanceBindingSha256);
  return ++checks<3;
 }});
 await expect(provider.start(f.wallet,request)).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 expect(checks).toBe(3);expect(await cosmeticStock(f)).toEqual(before);
 expect((await provider.read(f.wallet,request.idempotencyKey)).status).toBe('unknown');
 expect(await db.execute(sql`select * from bound_cosmetic_blueprints where wallet=${f.wallet}`)).toEqual([]);
});
it('dynamic renderer failure keeps original completion and free off while refusing fresh crafting and on',async()=>{
 const {f,request}=await prepared();let ready=true;
 const provider=createBoundCosmeticWorkshop(db,{clock:()=>f.now,awningApplicationReady:()=>{if(!ready)throw Error('Packed artwork is unavailable');return true;}});
 const start=await provider.start(f.wallet,request);if(start.status!=='accepted')throw Error('Expected original');
 f.now=new Date(start.receipt.readyAt);await provider.read(f.wallet,request.idempotencyKey);
 await provider.preference(f.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'0'});ready=false;
 const view=await provider.view(f.wallet,f.baseId);expect(view.applicationReady).toBe(false);expect(view.acceptingJobs).toBe(false);
 expect(view.originals[0]!.completion).not.toBeNull();expect((await provider.start(f.wallet,request)).receipt).toEqual(start.receipt);
 await expect(provider.start(f.wallet,{...request,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 await expect(provider.preference(f.wallet,{baseId:f.baseId,enabled:true,expectedRevision:'1'})).rejects.toMatchObject({code:'BOUND_COSMETIC_APPLICATION_UNAVAILABLE'});
 expect(await provider.preference(f.wallet,{baseId:f.baseId,enabled:false,expectedRevision:'1'})).toMatchObject({enabled:false,revision:'2'});
});
