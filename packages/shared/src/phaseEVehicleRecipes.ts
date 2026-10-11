/** Immutable D153.211 vehicle leaf recipes. Data only: no fee payment, held
 * inventory, output identity, licence, randomness or mint authority is implied.
 * Subpath only; this catalogue must never enter the shared first-paint barrel. */
import { z } from 'zod';
import { PHASE_E_VEHICLE_RECIPES as R, PHASE_E_POLICY } from './constants';
import { PhaseEVehicleFamilySchema, PhaseEVehicleTierSchema } from './phaseEVehicles';

export const VEHICLE_RECIPE_HASH_DOMAIN = 'SKVEHR01';
const request = z.object({ family: PhaseEVehicleFamilySchema, tier: PhaseEVehicleTierSchema,
 recipeVersion: z.literal(R.recipeVersion) }).strict();
const line = z.object({ kind: z.enum(['refined', 'fragment']), itemId: z.string().regex(/^[a-z][a-z0-9_]*$/),
 quantity: z.string().regex(/^[1-9][0-9]*$/) }).strict();
const shape = request.extend({ outputQuantity: z.literal(R.outputQuantity), oddsBps: z.number().int().min(0).max(PHASE_E_POLICY.basisPoints),
 inputs: z.array(line).min(1) }).strict();
export type PhaseEVehicleRecipeSnapshot = z.infer<typeof shape>;
function freeze<T>(value:T):T { if(value&&typeof value==='object'){for(const v of Object.values(value))freeze(v);Object.freeze(value);}return value; }
function build(family:z.infer<typeof PhaseEVehicleFamilySchema>,tier:z.infer<typeof PhaseEVehicleTierSchema>):PhaseEVehicleRecipeSnapshot {
 const policy=R.tiers[tier];
 const inputs:PhaseEVehicleRecipeSnapshot['inputs']=Object.entries(R.refined[family]).map(([itemId,quantity])=>({kind:'refined',itemId,quantity:String(quantity*policy.materialMultiplier)}));
 inputs.push({kind:'fragment',itemId:'crystal_fragment',quantity:String(policy.crystalFragments)});
 inputs.sort((a,b)=>{const x=`${a.kind}:${a.itemId}`,y=`${b.kind}:${b.itemId}`;return x<y?-1:x>y?1:0;});
 return {recipeVersion:R.recipeVersion,family,tier,outputQuantity:R.outputQuantity,oddsBps:policy.oddsBps,inputs};
}
function canonical(value:PhaseEVehicleRecipeSnapshot):string {
 return JSON.stringify({recipeVersion:value.recipeVersion,family:value.family,tier:value.tier,outputQuantity:value.outputQuantity,
  oddsBps:value.oddsBps,inputs:value.inputs.map(v=>({kind:v.kind,itemId:v.itemId,quantity:v.quantity}))});
}
export const PhaseEVehicleRecipeSnapshotSchema=shape.refine(v=>canonical(v)===canonical(build(v.family,v.tier)),
 'Vehicle recipe differs from its immutable family/tier catalogue');
export function vehicleCraftRecipe(family:unknown,tier:unknown,recipeVersion:unknown=R.recipeVersion):PhaseEVehicleRecipeSnapshot {
 const v=request.parse({family,tier,recipeVersion});return freeze(build(v.family,v.tier));
}
/** Callers hash this exact UTF-8 text after VEHICLE_RECIPE_HASH_DOMAIN. Every
 * retained field and ordered leaf participates; display labels never do. */
export function vehicleRecipeCanonical(value:unknown):string { return canonical(PhaseEVehicleRecipeSnapshotSchema.parse(value)); }
