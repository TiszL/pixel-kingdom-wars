/** Private custody test fixtures. Facility placement and raw quantities are
 * explicit fixture facts; Blueprint eligibility uses real refining receipts. */
import {randomUUID} from 'node:crypto';
import {BUILD_COSTS,BuildingType} from '@shardkeep/shared';
import {ordinaryCraftingRecipe,type OrdinaryRecipeId} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {boundCosmeticRecipe,type BoundCosmeticRecipeId} from '@shardkeep/shared/phaseEBoundCosmetics';
import {eq,sql} from 'drizzle-orm';
import type {Db,DbOrTx} from '../../src/db/client';
import {bases,baseSlots,buildings,builderJobs,craftingStocks,resourceStocks} from '../../src/db/schema';
import {startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../../src/game/ordinaryCrafting';
import {assertFreshLockedBaseAuthority} from '../../src/game/baseOwnership';
import {createTestPlayer} from '../helpers';

export const blueprintId='architect_blueprint_artisan_finishes_v1';
export async function boundCosmeticFixture(db:Db,options:{wallet?:string;slot?:number;level?:number}={}){
 const wallet=options.wallet??(await createTestPlayer(db)).wallet;
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active'}).returning();
 const baseId=base!.id,now=new Date('2035-01-01T01:00:00.000Z');
 await db.insert(baseSlots).values({wallet,baseId,slot:options.slot??1});
 async function facility(type:BuildingType.Workshop|BuildingType.Market|BuildingType.Lodge,x:number,level=1){
  const [building]=await db.insert(buildings).values({baseId,playerWallet:wallet,type,level,tx:x,ty:2}).returning();
  const completedAt=new Date(+now-1000);
  const [job]=await db.insert(builderJobs).values({baseId,playerWallet:wallet,buildingId:building!.id,kind:'build',
   startedAt:new Date(+completedAt-BUILD_COSTS[type].buildSec*1000),finishesAt:completedAt,completedAt}).returning();
  return {id:building!.id,jobId:job!.id};
 }
 const workshop=await facility(BuildingType.Workshop,2),market=await facility(BuildingType.Market,5,options.level??1),lodge=await facility(BuildingType.Lodge,8);
 const authority={baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
 return {db,wallet,baseId,now,workshop,market,lodge,authority};
}
export type BoundCosmeticFixture=Awaited<ReturnType<typeof boundCosmeticFixture>>;
export async function earnBoundBlueprint(f:BoundCosmeticFixture,version=1,grant=true){
 const recipeId='refine_heartwood_beams' as const,recipe=ordinaryCraftingRecipe(recipeId,version,1);
 const ingredient=recipe.inputs[0]!;
 await f.db.insert(resourceStocks).values({baseId:f.baseId,resourceId:ingredient.itemId,available:BigInt(ingredient.quantity)});
 const original=await startOrdinaryCrafting(f.db,f.wallet,{id:randomUUID(),baseId:f.baseId,recipeId,recipeVersion:version,quantity:1},f.authority,{clock:()=>f.now});
 f.now=original.job.readyAt;
 await f.db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
 if(grant)await f.db.execute(sql`insert into bound_cosmetic_blueprints(wallet,blueprint_id,source_job_id,granted_at) values(${f.wallet},${blueprintId},${original.job.id},${f.now.toISOString()}::timestamptz)`);
 return original.job.id;
}
export async function cosmeticMaterials(f:BoundCosmeticFixture,recipeId:BoundCosmeticRecipeId){
 const recipe=boundCosmeticRecipe(recipeId,1);
 for(const ingredient of recipe.inputs){
  await f.db.insert(craftingStocks).values({baseId:f.baseId,itemId:ingredient.itemId,available:BigInt(ingredient.quantity)})
   .onConflictDoUpdate({target:[craftingStocks.baseId,craftingStocks.itemId],set:{available:BigInt(ingredient.quantity)}});
 }
 return recipe;
}
export async function cosmeticInsert(f:BoundCosmeticFixture,recipeId:BoundCosmeticRecipeId,options:{db?:DbOrTx;id?:string;recipe?:unknown;appearance?:unknown;onConflict?:boolean}={}){
 const db=options.db??f.db,id=options.id??randomUUID(),recipe=boundCosmeticRecipe(recipeId,1),facility=recipe.requiredFacility.type==='market'?f.market:f.lodge;
 const [binding]=await db.execute<{appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
 const readyAt=new Date(+f.now+recipe.durationSec*1000);
 await db.execute(sql`insert into bound_cosmetic_jobs(id,actor_wallet,base_id,output_id,recipe_snapshot,appearance_snapshot,blueprint_id,workshop_id,workshop_completed_job_id,facility_id,facility_completed_job_id,started_at,ready_at)
 values(${id},${f.wallet},${f.baseId},${recipe.outputId},${JSON.stringify(options.recipe??recipe)}::jsonb,${JSON.stringify(options.appearance??binding!.appearance)}::jsonb,${blueprintId},${f.workshop.id},${f.workshop.jobId},${facility.id},${facility.jobId},${f.now.toISOString()}::timestamptz,${readyAt.toISOString()}::timestamptz)
 ${options.onConflict?sql`on conflict do nothing`:sql``}`);
 return {id,recipe,readyAt};
}
export const cosmeticStock=(f:BoundCosmeticFixture)=>f.db.select().from(craftingStocks).where(eq(craftingStocks.baseId,f.baseId));
export async function pendingOrdinary(f:BoundCosmeticFixture,recipeId:OrdinaryRecipeId='refine_frostglass'){
 const recipe=ordinaryCraftingRecipe(recipeId,1,1);
 for(const i of recipe.inputs)if(i.kind==='raw')await f.db.insert(resourceStocks).values({baseId:f.baseId,resourceId:i.itemId,available:BigInt(i.quantity)});
 return startOrdinaryCrafting(f.db,f.wallet,{id:randomUUID(),baseId:f.baseId,recipeId,recipeVersion:1,quantity:1},f.authority,{clock:()=>f.now});
}
