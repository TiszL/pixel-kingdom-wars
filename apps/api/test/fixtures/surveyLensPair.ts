/** D189 paired client fixture: existing installed capacity is R1 input;
 * the added Frostglass is earned on actual common trips and refined by real jobs. */
import {randomUUID} from 'node:crypto';
import {PHASE_E_SURVEY_LENS,PHASE_E_ORDINARY_CRAFTING} from '@shardkeep/shared';
import {PHASE_E_RAW_RESOURCE_IDS} from '@shardkeep/shared/phaseEResources';
import {starterRoutePreview} from '@shardkeep/shared/phaseEExpeditions';
import {ordinaryCraftingRecipe} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {ordinaryEquipmentRecipe} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {ordinaryEquipmentPairFixture} from './ordinaryEquipmentPair';
import {assertFreshLockedBaseAuthority} from '../../src/game/baseOwnership';
import {prefetchExpeditionTermReader} from '../../src/game/expeditionTermReader';
import {dispatchStarterExpedition} from '../../src/game/starterExpeditionDispatch';
import {settleDueStarterExpeditions} from '../../src/game/starterExpeditionReturns';
import {startOrdinaryCrafting,settleDueOrdinaryCrafting} from '../../src/game/ordinaryCrafting';
import {buildApp} from '../../src/app';
import {TEST_CONFIG} from '../helpers';
export async function surveyLensPairFixture(){
 const f=await ordinaryEquipmentPairFixture(),db=f.f.conn.db;
 try{
  const recipe=ordinaryEquipmentRecipe('craft_survey_lens'),input=recipe.inputs.find(i=>i.itemId==='frostglass')!;
  const refining=ordinaryCraftingRecipe('refine_frostglass',PHASE_E_ORDINARY_CRAFTING.currentRecipeVersion,Number(input.quantity));
  const raw=refining.inputs.find(i=>i.kind==='raw')!,route=starterRoutePreview('crownlands','common_frostveil');
  const authority={baseId:f.config.baseId,assertAuthority:async(...args:Parameters<typeof assertFreshLockedBaseAuthority>)=>{await assertFreshLockedBaseAuthority(...args);}};
  let earned=0n;
  while(earned<BigInt(raw.quantity)){
   const term=f.termProvider();if(!term)throw Error('Explicit term fixture missing');
   const reader=await prefetchExpeditionTermReader(term.connect,term.policy);
   const trip=await dispatchStarterExpedition(db,f.config.wallet,{id:randomUUID(),baseId:f.config.baseId,installationId:f.config.starterInstallationId,routeId:route.routeId,routeVersion:route.routeCatalogueVersion,rewardVersion:route.rewardTableVersion},authority,{reader});
   f.advanceTo(trip.returnsAt);await db.transaction(tx=>settleDueStarterExpeditions(tx,f.config.baseId,trip.returnsAt));earned+=trip.net;
  }
  const job=await startOrdinaryCrafting(db,f.config.wallet,{id:randomUUID(),baseId:f.config.baseId,recipeId:refining.recipeId,recipeVersion:refining.recipeVersion,quantity:refining.quantity},authority);
  f.advanceTo(job.job.readyAt);await db.transaction(tx=>settleDueOrdinaryCrafting(tx,f.config.baseId,job.job.readyAt));
  // Select a different common material using actual server previews; the fixed
  // fixture realm is not an authority for either expedition's original resource.
  const old=process.env['MULTI_BASE_ENABLED'];process.env['MULTI_BASE_ENABLED']='false';
  const app=await (async()=>{try{return await buildApp({...TEST_CONFIG,PLAYTEST_OPEN:'true'},db,f.providers());}finally{process.env['MULTI_BASE_ENABLED']=old;}})();
  let lensResourceId:typeof PHASE_E_RAW_RESOURCE_IDS[number];
  try{
   await app.ready();const starter=await app.inject({method:'GET',url:`/starter-expeditions?baseId=${f.config.baseId}`,cookies:f.cookies});
   const advanced=await app.inject({method:'GET',url:`/vehicles/client/routes?baseId=${f.config.baseId}&policyVersion=2`,cookies:f.cookies});
   if(starter.statusCode!==200||advanced.statusCode!==200)throw Error('Fixture preview authority unavailable');
   const primary=[starter.json().routes.find((r:{routeId:string})=>r.routeId==='coastal_survey').resourceId,advanced.json().items.find((i:{installationId:string})=>i.installationId===f.config.installationId).previews.find((r:{routeId:string})=>r.routeId===f.config.routeId).resourceId];
   const selected=PHASE_E_RAW_RESOURCE_IDS.find(id=>!primary.includes(id));if(!selected)throw Error('No distinct common resource');lensResourceId=selected;
  }finally{await app.close();}
  return {...f,config:{...f.config,recipe,lensResourceId,policy:{...f.config.policy,surveyLens:PHASE_E_SURVEY_LENS}}};
 }catch(error){await f.dispose();throw error;}
}
export type SurveyLensPairFixture=Awaited<ReturnType<typeof surveyLensPairFixture>>;
