import {describe,it,expect} from 'vitest';
import {PHASE_E_POLICY,PHASE_E_FRAGMENT_MODEL} from './constants';
import {PHASE_E_VEHICLE_FAMILY_IDS} from './phaseEVehicles';
import {vehicleCraftRecipe,vehicleRecipeCanonical,PhaseEVehicleRecipeSnapshotSchema,VEHICLE_RECIPE_HASH_DOMAIN} from './phaseEVehicleRecipes';
describe('D153.211 immutable vehicle material recipes',()=>{
 it('binds all16 chosen identities to exact leaves, one output and progressively scarcer tiers',()=>{
  const recipes=PHASE_E_VEHICLE_FAMILY_IDS.flatMap(family=>[1,2,3,4].map(tier=>vehicleCraftRecipe(family,tier)));
  expect(recipes).toHaveLength(16);expect(new Set(recipes.map(vehicleRecipeCanonical)).size).toBe(16);
  for(const recipe of recipes){
   expect(recipe.outputQuantity).toBe(1);expect(recipe.inputs).toHaveLength(5);
   expect(new Set(recipe.inputs.map(v=>v.kind+':'+v.itemId)).size).toBe(5);
   expect(recipe.inputs.filter(v=>v.kind==='refined').reduce((n,v)=>n+BigInt(v.quantity),0n)).toBe([20n,60n,180n,540n][recipe.tier-1]);
   expect(recipe.inputs.find(v=>v.kind==='fragment')).toEqual({kind:'fragment',itemId:'crystal_fragment',quantity:['2','6','18','54'][recipe.tier-1]});
   expect(recipe.oddsBps).toBe([8000,6500,4500,2500][recipe.tier-1]);
   expect(recipe.inputs.some(v=>/assembly|kit|shards|keep|sol|gems/.test(v.itemId))).toBe(false);
  }
  expect(vehicleCraftRecipe('survey_balloon',1).inputs).toEqual([
   {kind:'fragment',itemId:'crystal_fragment',quantity:'2'},
   {kind:'refined',itemId:'crownsteel',quantity:'2'},
   {kind:'refined',itemId:'heartwood_beams',quantity:'8'},
   {kind:'refined',itemId:'prismstone_lens',quantity:'2'},
   {kind:'refined',itemId:'thornsilk',quantity:'8'},
  ]);
 });
 it('refuses altered odds, duplicate/omitted leaves, quantity tricks and authority fields',()=>{
  const recipe=vehicleCraftRecipe('survey_balloon',1);
  for(const changed of [
   {...recipe,oddsBps:10000},{...recipe,outputQuantity:2},{...recipe,feePaid:true},
   {...recipe,inputs:[...recipe.inputs,recipe.inputs[0]]},{...recipe,inputs:recipe.inputs.slice(1)},
   {...recipe,inputs:[...recipe.inputs].reverse()},
   ...['0','-1','02','2.0','2e0','2\n'].map(quantity=>({...recipe,inputs:recipe.inputs.map((v,i)=>i===0?{...v,quantity}:v)})),
  ])expect(PhaseEVehicleRecipeSnapshotSchema.safeParse(changed).success).toBe(false);
 });
 it('has no future-version fallback, starter recipe or coercion',()=>{
  for(const values of [['starter',1,1],['survey_balloon','1',1],['survey_balloon',0,1],['survey_balloon',5,1],['survey_balloon',1,2],['survey_balloon',1,'1']])
   expect(()=>vehicleCraftRecipe(...values as [unknown,unknown,unknown])).toThrow();
 });
 it('detaches immutable originals and canonicalizes object presentation without reordering charged leaves',()=>{
  const original=vehicleCraftRecipe('cargo_cutter',4),text=vehicleRecipeCanonical(original);
  expect(Object.isFrozen(original)&&Object.isFrozen(original.inputs)&&original.inputs.every(Object.isFrozen)).toBe(true);
  const reordered=Object.fromEntries(Object.entries(structuredClone(original)).reverse());
  expect(vehicleRecipeCanonical(reordered)).toBe(text);expect(VEHICLE_RECIPE_HASH_DOMAIN).toBe('SKVEHR01');
  expect(()=>{original.inputs[0]!.quantity='1';}).toThrow();expect(vehicleRecipeCanonical(vehicleCraftRecipe('cargo_cutter',4))).toBe(text);
 });
 it('does not redefine the locked application fee or promote unrelated proposed salvage rules',()=>{
  expect(PHASE_E_POLICY.craft.applicationFeeLamports).toBe(50_000_000);
  expect(Object.keys(vehicleCraftRecipe('expedition_barge',2)).sort()).toEqual(['family','inputs','oddsBps','outputQuantity','recipeVersion','tier']);
  expect(PHASE_E_FRAGMENT_MODEL.marketCreatesEligibility).toBe(false);
 });
});
