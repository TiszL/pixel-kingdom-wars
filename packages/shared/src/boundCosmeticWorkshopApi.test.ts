import {describe,expect,it} from 'vitest';
import {BOUND_COSMETIC_AWNING_RECIPE_IDS,BoundCosmeticWorkshopViewSchema,BoundCosmeticPreferenceRequestSchema,BoundCosmeticPreferenceResponseSchema,BoundCosmeticWorkshopQueueSchema} from './boundCosmeticWorkshopApi';
import {boundCosmeticRecipe} from './phaseEBoundCosmetics';
import {ordinaryCraftingRecipe,ORDINARY_CRAFTING_ITEM_IDS_V2} from './phaseEOrdinaryCrafting';
const wallet='11111111111111111111111111111112',id='10000000-0000-4000-8000-000000000001',at='2035-01-01T00:00:00.000Z';
function view(){return {version:1,wallet,serverNow:at,acceptingJobs:false,applicationReady:false,blueprint:{state:'not-earned',proof:null},
 recipes:BOUND_COSMETIC_AWNING_RECIPE_IDS.map(recipeId=>{const recipe=boundCosmeticRecipe(recipeId,1);return {recipe,appearance:{version:1,outputId:recipe.outputId,sourceId:`artisan-market-t${recipe.outputId.slice(-1)}`,sourceManifestSha256:'a'.repeat(64),sourceIndexSha256:'b'.repeat(64),bindingSha256:'c'.repeat(64)}};}),originals:[],selectedBase:null};}
function available(){return {state:'available',baseId:id,craftingStock:ORDINARY_CRAFTING_ITEM_IDS_V2.map(itemId=>({itemId,available:'0',pendingOutput:'0'})),workshops:[],markets:[{buildingId:id,level:1,completedAt:at}],queue:[],preference:{enabled:false,revision:'0'},visual:{state:'available',visual:{version:1,marketAwnings:[]}}};}
describe('Awning Workshop closed wire',()=>{
 it('keeps missing selected authority distinct from empty authorized stock and refuses leaked extra inventory',()=>{
  expect(BoundCosmeticWorkshopViewSchema.parse(view()).selectedBase).toBeNull();
  const selectedBase={state:'unavailable',baseId:id,reason:'BASE_NOT_OWNED'};
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...view(),selectedBase}).success).toBe(true);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...view(),selectedBase:{...selectedBase,craftingStock:[]}}).success).toBe(false);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...view(),selectedBase:available()}).success).toBe(true);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...view(),selectedBase:{...available(),craftingStock:[]}}).success).toBe(false);
 });
 it('requires every canonical Awning recipe/binding and refuses Aurora, mismatched binding or unadmitted crafting',()=>{
  const valid=view();expect(BoundCosmeticWorkshopViewSchema.safeParse(valid).success).toBe(true);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...valid,acceptingJobs:true}).success).toBe(false);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...valid,recipes:valid.recipes.slice(1)}).success).toBe(false);
  const duplicate=view();duplicate.recipes[1]=duplicate.recipes[0]!;expect(BoundCosmeticWorkshopViewSchema.safeParse(duplicate).success).toBe(false);
  const mismatch=view();mismatch.recipes[0]!.appearance=mismatch.recipes[1]!.appearance;expect(BoundCosmeticWorkshopViewSchema.safeParse(mismatch).success).toBe(false);
  const aurora=view();aurora.recipes[0]!.recipe=boundCosmeticRecipe('craft_aurora_wake_v1',1);expect(BoundCosmeticWorkshopViewSchema.safeParse(aurora).success).toBe(false);
 });
 it('requires strict original queue recipes/deadlines and cannot present due work or foreign Market visuals as ready',()=>{
  const recipe=ordinaryCraftingRecipe('refine_frostglass',1,1),job={kind:'ordinary',jobId:id,recipe,startedAt:at,readyAt:new Date(Date.parse(at)+recipe.durationSec*1000).toISOString()};
  expect(BoundCosmeticWorkshopQueueSchema.safeParse(job).success).toBe(true);
  expect(BoundCosmeticWorkshopQueueSchema.safeParse({...job,recipe:{...recipe,quantity:999}}).success).toBe(false);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...view(),selectedBase:{...available(),queue:[job,job]}}).success).toBe(false);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...view(),serverNow:job.readyAt,selectedBase:{...available(),queue:[job]}}).success).toBe(false);
  const wrong={state:'available',visual:{version:1,marketAwnings:[{buildingId:id,appearance:view().recipes[1]!.appearance}]}};
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...view(),selectedBase:{...available(),visual:wrong}}).success).toBe(false);
 });
 it('rejects future Blueprint and original facts instead of granting early ownership',()=>{
  const valid=view(),recipe=valid.recipes[0]!.recipe,appearance=valid.recipes[0]!.appearance;
  const proof={blueprintId:recipe.blueprintId,jobId:id,baseId:id,actorWallet:wallet,completedAt:at};
  const readyAt=new Date(Date.parse(at)+recipe.durationSec*1000).toISOString();
  const original={version:1,wallet,idempotencyKey:id,serverNow:readyAt,status:'accepted',completion:{completedAt:readyAt},receipt:{
   wallet,jobId:id,request:{idempotencyKey:id,baseId:id,recipeId:recipe.recipeId,recipeVersion:recipe.recipeVersion,appearanceBindingSha256:appearance.bindingSha256},
   recipe,appearance,blueprint:proof,startedAt:at,readyAt}};
  const complete={...valid,serverNow:readyAt,blueprint:{state:'eligible',proof},originals:[original]};
  expect(BoundCosmeticWorkshopViewSchema.safeParse(complete).success).toBe(true);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...valid,blueprint:{state:'eligible',proof:{...proof,completedAt:readyAt}}}).success).toBe(false);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...complete,originals:[{...original,serverNow:at}]}).success).toBe(false);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...complete,serverNow:at}).success).toBe(false);
  expect(BoundCosmeticWorkshopViewSchema.safeParse({...complete,originals:[{...original,completion:null,serverNow:new Date(Date.parse(at)-1).toISOString()}]}).success).toBe(false);
 });
 it('preserves exact decimal revision identity and rejects numeric or overflow consent',()=>{
  expect(BoundCosmeticPreferenceRequestSchema.parse({baseId:id,enabled:true,expectedRevision:'0'}).expectedRevision).toBe('0');
  for(const expectedRevision of [0,'00','9223372036854775807','-1'])expect(BoundCosmeticPreferenceRequestSchema.safeParse({baseId:id,enabled:true,expectedRevision}).success).toBe(false);
  expect(BoundCosmeticPreferenceResponseSchema.safeParse({baseId:id,enabled:false,revision:'9223372036854775807',visual:{state:'unavailable',visual:null}}).success).toBe(true);
  expect(BoundCosmeticPreferenceResponseSchema.safeParse({baseId:id,enabled:true,revision:'0',visual:{state:'unavailable',visual:null}}).success).toBe(false);
 });
});
