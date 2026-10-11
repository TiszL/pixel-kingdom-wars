/** Prepared facility/raw-stock fixtures; subsequent refining, C2 Blueprint,
 * cosmetic start/completion and preference use the actual private services. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {BoundCosmeticAppearanceSchema} from '@shardkeep/shared/boundCosmeticApi';
import type {Db} from '../../src/db/client';
import {readBoundCosmeticBlueprintEligibility} from '../../src/game/boundCosmeticBlueprint';
import {startBoundCosmetic,settleDueBoundCosmetics} from '../../src/game/boundCosmetics';
import {settleDueOrdinaryCrafting} from '../../src/game/ordinaryCrafting';
import {boundCosmeticFixture,cosmeticMaterials,pendingOrdinary} from './boundCosmetics';
import {cosmeticVisualDatabase} from './boundCosmeticVisualDatabase';

export async function prepareCosmeticVisualSchema(conn:ReturnType<typeof cosmeticVisualDatabase>){
 await conn.setup();
 for(const [name,table] of [['0280_bound_cosmetic_visuals','bound_cosmetic_preferences'],['0281_bound_cosmetic_visual_source','bound_cosmetic_charter_contract']] as const){
  const [installed]=await conn.sql`select to_regclass(${'public.'+table}) relation`;if(installed!.relation)continue;
  await conn.sql.begin(async tx=>{for(const statement of readFileSync(new URL(`../../drizzle/${name}.sql`,import.meta.url),'utf8').split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);});
 }
}
export async function completedCosmeticPresentation(db:Db){
 const f=await boundCosmeticFixture(db),source=await pendingOrdinary(f);f.now=source.job.readyAt;
 await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.baseId,f.now));
 const blueprint=await readBoundCosmeticBlueprintEligibility(db,f.wallet);
 if(blueprint.state!=='eligible'||blueprint.proof.jobId!==source.job.id)throw Error('Actual completed refining did not produce its C2 Blueprint source');
 const recipeId='craft_artisan_market_awning_t1_v1' as const,recipe=await cosmeticMaterials(f,recipeId);
 const [row]=await db.execute<{appearance:unknown}>(sql`select public.shardkeep_bound_cosmetic_appearance(${recipe.outputId}) appearance`);
 const appearance=BoundCosmeticAppearanceSchema.parse(row!.appearance),request={idempotencyKey:randomUUID(),baseId:f.baseId,recipeId,recipeVersion:1,appearanceBindingSha256:appearance.bindingSha256};
 const started=await startBoundCosmetic(db,f.wallet,request,f.authority,{clock:()=>f.now});
 if(started.status!=='accepted')throw Error('Expected actual accepted cosmetic receipt');
 f.now=new Date(started.receipt.readyAt);await db.transaction(tx=>settleDueBoundCosmetics(tx,f.baseId,f.now));
 return {...f,source,blueprint,request,started,appearance};
}
export type CosmeticPresentationFixture=Awaited<ReturnType<typeof completedCosmeticPresentation>>;
