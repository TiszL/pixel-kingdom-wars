/** D153 delegated candidate: Architect Blueprint: Artisan Finishes and its five
 * bound cosmetic recipes (docs/phase-e/BOUND-COSMETICS-PROPOSAL.md). Subpath-only,
 * separate from ordinary crafting inventory, equipment, vehicles and any market or
 * currency writer. A bound record is an account appearance for its original actor:
 * never an inventory SKU, NFT, tradable, reward, price or gameplay credit. Numbers
 * live only in PHASE_E_BOUND_COSMETICS; this module holds identities and grammar. */
import { z } from 'zod';
import { PHASE_E_BOUND_COSMETICS as POLICY } from './constants';
import { ORDINARY_REFINED_IDS, type OrdinaryRefinedId } from './phaseEOrdinaryCrafting';
import { PositiveRawResourceQuantitySchema } from './phaseEResources';
import type { BuildingType } from './types';

export const BOUND_COSMETIC_BLUEPRINT_ID = POLICY.v1.blueprintId;
export const BOUND_COSMETIC_IDS = Object.freeze(['artisan_market_awning_t1', 'artisan_market_awning_t2', 'artisan_market_awning_t3',
  'artisan_market_awning_t4', 'aurora_wake'] as const);
export const BoundCosmeticIdSchema = z.enum(BOUND_COSMETIC_IDS);
export type BoundCosmeticId = z.infer<typeof BoundCosmeticIdSchema>;
export const BOUND_COSMETIC_RECIPE_IDS = Object.freeze(['craft_artisan_market_awning_t1_v1', 'craft_artisan_market_awning_t2_v1',
  'craft_artisan_market_awning_t3_v1', 'craft_artisan_market_awning_t4_v1', 'craft_aurora_wake_v1'] as const satisfies readonly (keyof typeof POLICY.v1.recipes)[]);
export const BoundCosmeticRecipeIdSchema = z.enum(BOUND_COSMETIC_RECIPE_IDS);
export type BoundCosmeticRecipeId = z.infer<typeof BoundCosmeticRecipeIdSchema>;
/** Exact recipe → appearance bindings. A bound output is never an ordinary item id. */
export const BOUND_COSMETIC_RECIPE_OUTPUTS = Object.freeze({
  craft_artisan_market_awning_t1_v1: 'artisan_market_awning_t1', craft_artisan_market_awning_t2_v1: 'artisan_market_awning_t2',
  craft_artisan_market_awning_t3_v1: 'artisan_market_awning_t3', craft_artisan_market_awning_t4_v1: 'artisan_market_awning_t4',
  craft_aurora_wake_v1: 'aurora_wake',
} as const satisfies Record<BoundCosmeticRecipeId, BoundCosmeticId>);
/** Canonical BuildingType ids of the per-recipe facility; the Workshop craft prerequisite is POLICY.v1.craftFacility. */
export const BOUND_COSMETIC_FACILITY_TYPES = Object.freeze(['market', 'lodge'] as const satisfies readonly `${BuildingType.Market | BuildingType.Lodge}`[]);

const RefinedInput = z.object({ itemId: z.enum(ORDINARY_REFINED_IDS), quantity: PositiveRawResourceQuantitySchema }).strict();
const Facility = z.object({ type: z.enum(BOUND_COSMETIC_FACILITY_TYPES), level: z.number().int().positive().safe() }).strict();
const snapshot = z.object({
  recipeId: BoundCosmeticRecipeIdSchema, recipeVersion: z.number().int().positive().safe(), outputId: BoundCosmeticIdSchema,
  quantity: z.literal(String(POLICY.v1.outputPerCraft)), durationSec: z.number().int().positive().safe(),
  inputs: z.array(RefinedInput).min(1), requiredFacility: Facility, blueprintId: z.literal(BOUND_COSMETIC_BLUEPRINT_ID),
}).strict();
export type BoundCosmeticRecipeSnapshot = z.infer<typeof snapshot>;

/** Explicit immutable version, not today's tuning; every call returns fresh frozen
 * values so no caller can mutate a later job through a catalogue reference. The
 * batch quantity is the canonical decimal string '1': one permanent bound record. */
export function boundCosmeticRecipe(recipeId: BoundCosmeticRecipeId, version: number): BoundCosmeticRecipeSnapshot {
  BoundCosmeticRecipeIdSchema.parse(recipeId);
  if (version !== POLICY.v1.recipeVersion) throw new Error('Unsupported bound cosmetic recipe version');
  const recipe = POLICY.v1.recipes[recipeId];
  const inputs = (Object.entries(recipe.inputs) as [OrdinaryRefinedId, number][])
    .map(([itemId, quantity]) => Object.freeze({ itemId, quantity: String(quantity) }));
  Object.freeze(inputs);
  return Object.freeze({ recipeId, recipeVersion: version, outputId: BOUND_COSMETIC_RECIPE_OUTPUTS[recipeId],
    quantity: String(POLICY.v1.outputPerCraft), durationSec: recipe.durationSec, inputs,
    requiredFacility: Object.freeze({ type: recipe.facility, level: recipe.facilityLevel }), blueprintId: BOUND_COSMETIC_BLUEPRINT_ID });
}
export const BoundCosmeticRecipeSnapshotSchema = snapshot.refine(value => {
  try {
    const expected = boundCosmeticRecipe(value.recipeId, value.recipeVersion);
    return value.outputId === expected.outputId && value.quantity === expected.quantity && value.durationSec === expected.durationSec
      && value.blueprintId === expected.blueprintId && value.requiredFacility.type === expected.requiredFacility.type
      && value.requiredFacility.level === expected.requiredFacility.level && value.inputs.length === expected.inputs.length
      && value.inputs.every((actual, i) => actual.itemId === expected.inputs[i]!.itemId && actual.quantity === expected.inputs[i]!.quantity);
  } catch { return false; }
}, 'Bound cosmetic receipt must match its immutable versioned recipe');
