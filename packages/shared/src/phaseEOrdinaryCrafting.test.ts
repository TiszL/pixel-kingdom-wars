import { describe, expect, it } from 'vitest';
import { PHASE_E_ORDINARY_CRAFTING as C } from './constants';
import { PHASE_E_RAW_RESOURCE_IDS } from './phaseEResources';
import { ORDINARY_REFINED_IDS, ORDINARY_REFINED_INPUTS, OrdinaryCraftingRecipeSnapshotSchema,
  ordinaryCraftingRecipe, type OrdinaryRecipeId } from './phaseEOrdinaryCrafting';

describe('D153.27 ordinary resource transformations, separate from Forge economics', () => {
  it('covers every accepted raw family exactly once without treating protected material as raw loot', () => {
    expect(Object.values(ORDINARY_REFINED_INPUTS).sort()).toEqual([...PHASE_E_RAW_RESOURCE_IDS].sort());
    for (const item of ORDINARY_REFINED_IDS) {
      const recipe = ordinaryCraftingRecipe(`refine_${item}`, C.v1.recipeVersion, 1);
      expect(recipe.inputs).toEqual([{ kind: 'raw', itemId: ORDINARY_REFINED_INPUTS[item], quantity: '10' }]);
      expect(recipe.output).toEqual({ itemId: item, quantity: '1' });
      expect(recipe.durationSec).toBe(60);
      expect(OrdinaryCraftingRecipeSnapshotSchema.parse(recipe)).toEqual(recipe);
    }
  });
  it('Navigation Kit consumes only its two accepted protected ingredient families with no currency or tax debit', () => {
    const recipe = ordinaryCraftingRecipe('craft_navigation_kit', C.v1.recipeVersion, 2);
    expect(recipe.inputs).toEqual([
      { kind: 'crafting', itemId: 'prismstone_lens', quantity: '2' },
      { kind: 'crafting', itemId: 'frostglass', quantity: '2' },
    ]);
    expect(recipe.output).toEqual({ itemId: 'navigation_kit', quantity: '2' });
    expect(recipe.durationSec).toBe(240);
  });
  it('caps irreversible work-in-progress per job and scales all cost/output/time together', () => {
    const recipe = ordinaryCraftingRecipe('refine_crownsteel', C.v1.recipeVersion, C.v1.maxBatch);
    expect(recipe.inputs[0]!.quantity).toBe('100'); expect(recipe.output.quantity).toBe('10');
    expect(recipe.durationSec).toBe(600);
    for (const quantity of [0, -1, 1.5, C.v1.maxBatch + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity])
      expect(() => ordinaryCraftingRecipe('refine_crownsteel', C.v1.recipeVersion, quantity)).toThrow();
  });
  it('rejects invented recipes and unimplemented versions rather than granting an output', () => {
    for (const id of ['forge_ingot', 'craft_expedition_kit', 'refine_crystal_fragment', 'refine_navigation_kit'])
      expect(() => ordinaryCraftingRecipe(id as OrdinaryRecipeId, C.v1.recipeVersion, 1)).toThrow();
    expect(() => ordinaryCraftingRecipe('craft_navigation_kit', C.v1.recipeVersion + 2, 1)).toThrow();
  });
  it('refuses forged original receipts that change input kind, quantity, destination, timer or schema', () => {
    const original = ordinaryCraftingRecipe('refine_frostglass', C.v1.recipeVersion, 1);
    for (const changed of [
      { ...original, inputs: [{ kind: 'crafting', itemId: 'frostglass', quantity: '10' }] },
      { ...original, inputs: [{ ...original.inputs[0], quantity: '1' }] },
      { ...original, inputs: [...original.inputs, original.inputs[0]] },
      { ...original, output: { itemId: 'navigation_kit', quantity: '1' } },
      { ...original, output: { ...original.output, quantity: '2' } },
      { ...original, durationSec: 1 }, { ...original, recipeVersion: 3 },
      { ...original, authority: true },
    ]) expect(OrdinaryCraftingRecipeSnapshotSchema.safeParse(changed).success).toBe(false);
  });
  it('returns independent frozen receipt values so a caller cannot reprice later jobs', () => {
    const first = ordinaryCraftingRecipe('craft_navigation_kit', C.v1.recipeVersion, 1);
    const second = ordinaryCraftingRecipe('craft_navigation_kit', C.v1.recipeVersion, 1);
    expect(second).toEqual(first); expect(second.inputs).not.toBe(first.inputs);
    for (const value of [first, first.inputs, ...first.inputs, first.output]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { first.inputs[0]!.quantity = '0'; }).toThrow();
    expect(second.inputs[0]!.quantity).toBe('1');
  });
});
