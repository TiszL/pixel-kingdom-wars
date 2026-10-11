/** D153.27 deterministic ordinary recipes. Subpath-only, separate from legacy
 * items, Forge Ingot jobs, raw raid exposure and any currency or market writer. */
import { z } from 'zod';
import { PHASE_E_ORDINARY_CRAFTING as POLICY, PHASE_E_ORDINARY_CRAFTING_V2 as POLICY_V2 } from './constants';
import { PhaseERawResourceIdSchema, PositiveRawResourceQuantitySchema, type PhaseERawResourceId } from './phaseEResources';

export const ORDINARY_REFINED_IDS = ['frostglass', 'heartwood_beams', 'sunstone_blocks', 'crownsteel',
  'prismstone_lens', 'stormalloy', 'thornsilk', 'embercore'] as const;
export type OrdinaryRefinedId = typeof ORDINARY_REFINED_IDS[number];
export const ORDINARY_CRAFTING_ITEM_IDS = [...ORDINARY_REFINED_IDS, 'navigation_kit'] as const;
// These explicit historical sets must not widen installed-client discovery.
export const ORDINARY_CRAFTING_ITEM_IDS_V1 = ORDINARY_CRAFTING_ITEM_IDS;
export const ORDINARY_CRAFTING_ITEM_IDS_V2 = [...ORDINARY_CRAFTING_ITEM_IDS_V1, 'climate_kit', 'expedition_kit'] as const;
export const OrdinaryCraftingItemIdSchema = z.enum(ORDINARY_CRAFTING_ITEM_IDS_V2);
export type OrdinaryCraftingItemId = z.infer<typeof OrdinaryCraftingItemIdSchema>;
// Accepted identity pairs: native PHASE_E_DECISIONS.md@11504e2, resources table.
export const ORDINARY_REFINED_INPUTS = {
  frostglass: 'frost_quartz', heartwood_beams: 'heartwood_logs', sunstone_blocks: 'sunstone_rubble',
  crownsteel: 'crown_iron_ore', prismstone_lens: 'rough_prism', stormalloy: 'storm_ore',
  thornsilk: 'thorn_fibre', embercore: 'ember_nodules',
} as const satisfies Record<OrdinaryRefinedId, PhaseERawResourceId>;
export const ORDINARY_RECIPE_IDS = ['refine_frostglass', 'refine_heartwood_beams', 'refine_sunstone_blocks',
  'refine_crownsteel', 'refine_prismstone_lens', 'refine_stormalloy', 'refine_thornsilk', 'refine_embercore',
  'craft_navigation_kit'] as const;
export const ORDINARY_RECIPE_IDS_V1 = ORDINARY_RECIPE_IDS;
export const ORDINARY_RECIPE_IDS_V2 = [...ORDINARY_RECIPE_IDS_V1, 'craft_climate_kit', 'craft_expedition_kit'] as const;
export const OrdinaryRecipeIdSchema = z.enum(ORDINARY_RECIPE_IDS_V2);
export type OrdinaryRecipeId = z.infer<typeof OrdinaryRecipeIdSchema>;
const input = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('raw'), itemId: PhaseERawResourceIdSchema, quantity: PositiveRawResourceQuantitySchema }).strict(),
  z.object({ kind: z.literal('crafting'), itemId: OrdinaryCraftingItemIdSchema, quantity: PositiveRawResourceQuantitySchema }).strict(),
  z.object({ kind: z.literal('shards'), itemId: z.literal('shards'), quantity: PositiveRawResourceQuantitySchema }).strict(),
]);
const snapshot = z.object({ recipeVersion: z.number().int().positive().safe(), recipeId: OrdinaryRecipeIdSchema,
  quantity: z.number().int().positive().safe(), durationSec: z.number().int().positive().safe(),
  inputs: z.array(input).min(1),
  output: z.object({ itemId: OrdinaryCraftingItemIdSchema, quantity: PositiveRawResourceQuantitySchema }).strict(),
}).strict();
export type OrdinaryCraftingRecipeSnapshot = z.infer<typeof snapshot>;

/** Explicit immutable version, not today's tuning. Historical receipts can use
 * this after the current version changes; callers separately check new reviews. */
export function ordinaryCraftingRecipe(recipeId: OrdinaryRecipeId, version: number, quantity: number): OrdinaryCraftingRecipeSnapshot {
  OrdinaryRecipeIdSchema.parse(recipeId);
  const policy = version === POLICY.v1.recipeVersion ? POLICY.v1 : version === POLICY_V2.recipeVersion ? POLICY_V2 : null;
  if (!policy || version === POLICY.v1.recipeVersion && !(ORDINARY_RECIPE_IDS_V1 as readonly string[]).includes(recipeId))
    throw new Error('Unsupported ordinary recipe version');
  z.number().int().positive().max(policy.maxBatch).parse(quantity);
  const count = BigInt(quantity);
  let inputs: OrdinaryCraftingRecipeSnapshot['inputs'], output: OrdinaryCraftingRecipeSnapshot['output'], durationSec: number;
  if (recipeId === 'craft_navigation_kit') {
    const recipe = policy.navigationKit;
    inputs = [
      { kind: 'crafting', itemId: 'prismstone_lens', quantity: (count * BigInt(recipe.prismstoneLensPerOutput)).toString() },
      { kind: 'crafting', itemId: 'frostglass', quantity: (count * BigInt(recipe.frostglassPerOutput)).toString() },
    ];
    output = { itemId: 'navigation_kit', quantity: (count * BigInt(recipe.outputPerBatch)).toString() };
    durationSec = quantity * recipe.secondsPerOutput;
  } else if (recipeId === 'craft_climate_kit') {
    const recipe = POLICY_V2.climateKit;
    inputs = [
      { kind: 'crafting', itemId: 'sunstone_blocks', quantity: (count * BigInt(recipe.sunstoneBlocksPerOutput)).toString() },
      { kind: 'crafting', itemId: 'embercore', quantity: (count * BigInt(recipe.embercorePerOutput)).toString() },
    ];
    output = { itemId: 'climate_kit', quantity: (count * BigInt(recipe.outputPerBatch)).toString() };
    durationSec = quantity * recipe.secondsPerOutput;
  } else if (recipeId === 'craft_expedition_kit') {
    const recipe = POLICY_V2.expeditionKit;
    inputs = [
      { kind: 'crafting', itemId: 'heartwood_beams', quantity: (count * BigInt(recipe.heartwoodBeamsPerOutput)).toString() },
      { kind: 'crafting', itemId: 'thornsilk', quantity: (count * BigInt(recipe.thornsilkPerOutput)).toString() },
      { kind: 'shards', itemId: 'shards', quantity: (count * BigInt(recipe.shardsPerOutput)).toString() },
    ];
    output = { itemId: 'expedition_kit', quantity: (count * BigInt(recipe.outputPerBatch)).toString() };
    durationSec = quantity * recipe.secondsPerOutput;
  } else {
    const itemId = recipeId.slice('refine_'.length) as OrdinaryRefinedId;
    inputs = [{ kind: 'raw', itemId: ORDINARY_REFINED_INPUTS[itemId], quantity: (count * BigInt(policy.refining.rawPerOutput)).toString() }];
    output = { itemId, quantity: (count * BigInt(policy.refining.outputPerBatch)).toString() };
    durationSec = quantity * policy.refining.secondsPerOutput;
  }
  // Fresh detached values prevent callers mutating later jobs through a catalogue reference.
  inputs.forEach(Object.freeze); Object.freeze(inputs); Object.freeze(output);
  return Object.freeze({ recipeVersion: version, recipeId, quantity, durationSec, inputs, output });
}
export const OrdinaryCraftingRecipeSnapshotSchema = snapshot.refine(value => {
  try {
    const expected = ordinaryCraftingRecipe(value.recipeId, value.recipeVersion, value.quantity);
    return value.durationSec === expected.durationSec
      && value.output.itemId === expected.output.itemId && value.output.quantity === expected.output.quantity
      && value.inputs.length === expected.inputs.length && value.inputs.every((actual, i) => {
        const original = expected.inputs[i]!;
        return actual.kind === original.kind && actual.itemId === original.itemId && actual.quantity === original.quantity;
      });
  } catch { return false; }
}, 'Ordinary receipt must match its immutable versioned recipe');
