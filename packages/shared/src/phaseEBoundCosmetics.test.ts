/** The five candidate bound cosmetics must stay exactly the recorded D153 candidate:
 * changing any material, level or duration is a deliberate policy change that must
 * fail here. The finite model is recomputed from the ACCEPTED refining recipe, not
 * from a simulation. A bound record has no converter or tradable output. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PHASE_E_BOUND_COSMETICS as POLICY, PHASE_E_BUILDINGS, PHASE_E_ORDINARY_CRAFTING as CRAFTING, PHASE_E_ORDINARY_EQUIPMENT, PHASE_E_SURVEY_LENS, STRUCTURES } from './constants';
import { KEEP_MARKET_ITEM_IDS_V4, KeepEquipmentMarketItemSchema } from './keepEquipmentMarketApi';
import { MINING_CONTRIBUTION_RESOURCE_IDS_V3, MiningContributionResourceSchema } from './miningContribution';
import * as module from './phaseEBoundCosmetics';
import { BOUND_COSMETIC_BLUEPRINT_ID, BOUND_COSMETIC_FACILITY_TYPES, BOUND_COSMETIC_IDS, BOUND_COSMETIC_RECIPE_IDS, BOUND_COSMETIC_RECIPE_OUTPUTS,
  BoundCosmeticIdSchema, BoundCosmeticRecipeIdSchema, BoundCosmeticRecipeSnapshotSchema, boundCosmeticRecipe, type BoundCosmeticRecipeId } from './phaseEBoundCosmetics';
import { ORDINARY_CRAFTING_ITEM_IDS_V2, ORDINARY_REFINED_IDS, ordinaryCraftingRecipe, type OrdinaryRefinedId } from './phaseEOrdinaryCrafting';
import { PHASE_E_RAW_RESOURCE_IDS } from './phaseEResources';
import { BuildingType } from './types';

const V = POLICY.v1.recipeVersion;
const expected = {
  craft_artisan_market_awning_t1_v1: { outputId: 'artisan_market_awning_t1', facility: 'market', level: 1, durationSec: 300, inputs: [['heartwood_beams', '2'], ['thornsilk', '2'], ['crownsteel', '1']] },
  craft_artisan_market_awning_t2_v1: { outputId: 'artisan_market_awning_t2', facility: 'market', level: 6, durationSec: 600, inputs: [['heartwood_beams', '4'], ['thornsilk', '4'], ['crownsteel', '2']] },
  craft_artisan_market_awning_t3_v1: { outputId: 'artisan_market_awning_t3', facility: 'market', level: 11, durationSec: 900, inputs: [['heartwood_beams', '8'], ['thornsilk', '8'], ['crownsteel', '4']] },
  craft_artisan_market_awning_t4_v1: { outputId: 'artisan_market_awning_t4', facility: 'market', level: 16, durationSec: 1200, inputs: [['heartwood_beams', '16'], ['thornsilk', '16'], ['crownsteel', '8']] },
  craft_aurora_wake_v1: { outputId: 'aurora_wake', facility: 'lodge', level: 1, durationSec: 600, inputs: [['prismstone_lens', '4'], ['frostglass', '4'], ['thornsilk', '4']] },
} as const;
const units = (recipeId: BoundCosmeticRecipeId) => boundCosmeticRecipe(recipeId, V).inputs.reduce((n, i) => n + Number(i.quantity), 0);
/** Raw units and serial seconds to self-refine every input through the ACCEPTED refining recipe, honouring its batch cap. */
function refining(recipeId: BoundCosmeticRecipeId) {
  let raw = 0n, seconds = 0;
  for (const input of boundCosmeticRecipe(recipeId, V).inputs) {
    let remaining = Number(input.quantity);
    while (remaining > 0) {
      const batch = Math.min(remaining, CRAFTING.v1.maxBatch), job = ordinaryCraftingRecipe(`refine_${input.itemId}`, CRAFTING.v1.recipeVersion, batch);
      expect(job.output).toEqual({ itemId: input.itemId, quantity: String(batch) });
      raw += BigInt(job.inputs[0]!.quantity); seconds += job.durationSec; remaining -= batch;
    }
  }
  return { raw, seconds };
}

describe('D153 delegated bound cosmetics: exact frozen candidate recipes', () => {
  it('binds exactly the five candidate recipes to their appearances, materials, facilities and durations', () => {
    expect(BOUND_COSMETIC_RECIPE_IDS).toEqual(Object.keys(expected)); expect(Object.keys(POLICY.v1.recipes)).toEqual([...BOUND_COSMETIC_RECIPE_IDS]);
    expect(BOUND_COSMETIC_IDS).toEqual(BOUND_COSMETIC_RECIPE_IDS.map(id => BOUND_COSMETIC_RECIPE_OUTPUTS[id]));
    expect(BOUND_COSMETIC_BLUEPRINT_ID).toBe('architect_blueprint_artisan_finishes_v1'); expect(POLICY.currentRecipeVersion).toBe(V); expect(V).toBe(1);
    for (const recipeId of BOUND_COSMETIC_RECIPE_IDS) {
      const e = expected[recipeId], recipe = boundCosmeticRecipe(recipeId, V);
      expect(recipe).toEqual({ recipeId, recipeVersion: 1, outputId: e.outputId, quantity: '1', durationSec: e.durationSec,
        inputs: e.inputs.map(([itemId, quantity]) => ({ itemId, quantity })), requiredFacility: { type: e.facility, level: e.level }, blueprintId: BOUND_COSMETIC_BLUEPRINT_ID });
      expect(BoundCosmeticRecipeSnapshotSchema.parse(recipe)).toEqual(recipe);
      expect(BoundCosmeticIdSchema.parse(recipe.outputId)).toBe(e.outputId); expect(BoundCosmeticRecipeIdSchema.parse(recipeId)).toBe(recipeId);
    }
    expect(POLICY.v1.blueprint).toEqual({ qualifyingCompletedRefiningJobs: 1, minimumOutputsPerJob: 1 }); expect(POLICY.v1.outputPerCraft).toBe(1);
  });
  it('consumes only existing refined materials that the accepted refine_* recipes produce, and never names an inventory, raw or currency id', () => {
    for (const recipeId of BOUND_COSMETIC_RECIPE_IDS) for (const input of boundCosmeticRecipe(recipeId, V).inputs) {
      expect(ORDINARY_REFINED_IDS).toContain(input.itemId);
      expect(ordinaryCraftingRecipe(`refine_${input.itemId as OrdinaryRefinedId}`, CRAFTING.v1.recipeVersion, 1).output.itemId).toBe(input.itemId);
      expect(Object.keys(input)).toEqual(['itemId', 'quantity']); expect(input.quantity).toMatch(/^[1-9][0-9]*$/);
    }
    for (const outputId of BOUND_COSMETIC_IDS) {
      expect(ORDINARY_CRAFTING_ITEM_IDS_V2 as readonly string[]).not.toContain(outputId);
      expect(PHASE_E_RAW_RESOURCE_IDS as readonly string[]).not.toContain(outputId);
      expect(BoundCosmeticIdSchema.safeParse(outputId).success).toBe(true);
    }
    for (const bad of ['shards', 'forge_ingot', 'crystal_fragment', 'navigation_kit', 'heartwood_beams', 'artisan_market_awning_t5', 'route_compass'])
      expect(BoundCosmeticIdSchema.safeParse(bad).success).toBe(false);
  });
  it('returns fresh frozen snapshots that callers cannot mutate into later jobs', () => {
    const a = boundCosmeticRecipe('craft_aurora_wake_v1', V), b = boundCosmeticRecipe('craft_aurora_wake_v1', V);
    expect(a).toEqual(b); expect(a).not.toBe(b); expect(a.inputs).not.toBe(b.inputs); expect(a.inputs[0]).not.toBe(b.inputs[0]); expect(a.requiredFacility).not.toBe(b.requiredFacility);
    for (const target of [a, a.inputs, a.inputs[0]!, a.requiredFacility, BOUND_COSMETIC_RECIPE_OUTPUTS, BOUND_COSMETIC_IDS, BOUND_COSMETIC_RECIPE_IDS, BOUND_COSMETIC_FACILITY_TYPES]) expect(Object.isFrozen(target)).toBe(true);
    expect(() => { (BOUND_COSMETIC_RECIPE_OUTPUTS as Record<string, string>).craft_aurora_wake_v1 = 'artisan_market_awning_t1'; }).toThrow(TypeError);
    expect(() => { (a as { durationSec: number }).durationSec = 1; }).toThrow(TypeError);
    expect(() => { (a.inputs as { quantity: string }[])[0]!.quantity = '999'; }).toThrow(TypeError);
    expect(() => { (a.inputs as unknown as unknown[]).push({ itemId: 'crownsteel', quantity: '1' }); }).toThrow(TypeError);
    expect(() => { (a.requiredFacility as { level: number }).level = 0; }).toThrow(TypeError);
    expect(boundCosmetic(a.recipeId)).toEqual(a);
    function boundCosmetic(id: BoundCosmeticRecipeId) { return boundCosmeticRecipe(id, V); }
  });
  it('rejects unknown versions, unknown recipes, extra fields, bad numeric kinds and mismatched terms', () => {
    for (const version of [0, 2, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1' as never, undefined as never])
      expect(() => boundCosmeticRecipe('craft_aurora_wake_v1', version)).toThrow();
    for (const recipe of ['craft_navigation_kit', 'refine_thornsilk', 'craft_aurora_wake_v2', '', 'CRAFT_AURORA_WAKE_V1'])
      expect(() => boundCosmeticRecipe(recipe as never, V)).toThrow();
    const good = boundCosmeticRecipe('craft_artisan_market_awning_t2_v1', V), t1 = boundCosmeticRecipe('craft_artisan_market_awning_t1_v1', V);
    const wrong: unknown[] = [
      { ...good, price: '0' }, { ...good, reward: 1 }, { ...good, quantity: 1 }, { ...good, quantity: '2' }, { ...good, quantity: '01' }, { ...good, recipeVersion: 2 }, { ...good, recipeVersion: '1' },
      { ...good, durationSec: 601 }, { ...good, durationSec: '600' }, { ...good, outputId: 'artisan_market_awning_t1' }, { ...good, outputId: 'aurora_wake' },
      { ...good, blueprintId: 'architect_blueprint_artisan_finishes_v2' }, { ...good, requiredFacility: { type: 'market', level: 5 } },
      { ...good, requiredFacility: { type: 'lodge', level: 6 } }, { ...good, requiredFacility: { type: 'workshop', level: 6 } }, { ...good, requiredFacility: { type: 'market', level: 6, extra: 1 } },
      { ...good, inputs: [...good.inputs].reverse() }, { ...good, inputs: good.inputs.slice(1) }, { ...good, inputs: [...good.inputs, { itemId: 'crownsteel', quantity: '1' }] },
      // Same quantities, different materials: the two 4-unit lines swapped, a duplicated line, and a same-quantity substitution.
      { ...good, inputs: [good.inputs[1]!, good.inputs[0]!, good.inputs[2]!] }, { ...good, inputs: [good.inputs[0]!, good.inputs[0]!, good.inputs[2]!] },
      { ...good, inputs: good.inputs.map((i, n) => n === 2 ? { ...i, itemId: 'stormalloy' } : i) }, { ...good, inputs: good.inputs.map((i, n) => n === 0 ? { ...i, itemId: 'thornsilk' } : i) },
      // A higher level and a string level are not the recorded threshold either.
      { ...good, requiredFacility: { type: 'market', level: 7 } }, { ...good, requiredFacility: { type: 'market', level: '6' } },
      { ...good, inputs: good.inputs.map((i, n) => n === 0 ? { ...i, quantity: '04' } : i) }, { ...good, inputs: good.inputs.map((i, n) => n === 0 ? { ...i, quantity: 4 } : i) },
      { ...good, inputs: good.inputs.map((i, n) => n === 0 ? { ...i, quantity: '0' } : i) }, { ...good, inputs: good.inputs.map((i, n) => n === 0 ? { ...i, quantity: '5' } : i) },
      { ...good, inputs: good.inputs.map((i, n) => n === 0 ? { ...i, kind: 'crafting' } : i) }, { ...good, inputs: good.inputs.map((i, n) => n === 0 ? { ...i, itemId: 'heartwood_logs' } : i) },
      { ...good, inputs: t1.inputs }, { ...t1, recipeId: good.recipeId }, { ...good, recipeId: 'craft_navigation_kit' }, {},
    ];
    for (const value of wrong) expect(BoundCosmeticRecipeSnapshotSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    expect(BoundCosmeticRecipeSnapshotSchema.safeParse(JSON.parse(JSON.stringify(good))).success).toBe(true);
  });
  it('recomputes the candidate raw-equivalent and serial-time comparisons from the accepted refining recipe, with the doubling tiers', () => {
    const rows = BOUND_COSMETIC_RECIPE_IDS.map(recipeId => { const r = refining(recipeId), craft = boundCosmeticRecipe(recipeId, V).durationSec; return [recipeId, units(recipeId), r.raw, r.seconds, r.seconds + craft] as const; });
    expect(rows).toEqual([
      ['craft_artisan_market_awning_t1_v1', 5, 50n, 300, 600], ['craft_artisan_market_awning_t2_v1', 10, 100n, 600, 1200],
      ['craft_artisan_market_awning_t3_v1', 20, 200n, 1200, 2100], ['craft_artisan_market_awning_t4_v1', 40, 400n, 2400, 3600],
      ['craft_aurora_wake_v1', 12, 120n, 720, 1320],
    ]);
    // The proposal's minute figures (10/20/35/60 and 22) and its 10 raw per refined unit follow from the accepted recipe, not from a tuning of their own.
    expect(rows.map(r => r[4] / 60)).toEqual([10, 20, 35, 60, 22]); expect(CRAFTING.v1.refining).toMatchObject({ rawPerOutput: 10, secondsPerOutput: 60 });
    for (let tier = 1; tier < 4; tier++) {
      const lower = boundCosmeticRecipe(`craft_artisan_market_awning_t${tier}_v1` as BoundCosmeticRecipeId, V), higher = boundCosmeticRecipe(`craft_artisan_market_awning_t${tier + 1}_v1` as BoundCosmeticRecipeId, V);
      expect(higher.inputs.map(i => i.itemId)).toEqual(lower.inputs.map(i => i.itemId));
      expect(higher.inputs.map(i => Number(i.quantity))).toEqual(lower.inputs.map(i => Number(i.quantity) * 2));
      expect(higher.durationSec).toBe(lower.durationSec + 300); expect(higher.requiredFacility.level).toBe(lower.requiredFacility.level + 5);
      expect(higher.inputs.map(i => i.itemId)).not.toContain(lower.outputId); // lower tiers are never ingredients
    }
    const compass = PHASE_E_ORDINARY_EQUIPMENT.recipe, lens = PHASE_E_SURVEY_LENS.recipe;
    expect(compass.prismstoneLens + compass.crownsteel).toBe(4); expect(lens.prismstoneLens + lens.frostglass).toBe(4);
    expect(units('craft_artisan_market_awning_t1_v1')).toBe(5); expect(boundCosmeticRecipe('craft_artisan_market_awning_t1_v1', V).durationSec).toBe(compass.durationSec);
    expect(boundCosmeticRecipe('craft_aurora_wake_v1', V).durationSec).toBe(600); expect(units('craft_aurora_wake_v1')).toBe(12);
  });
  it('grants no resource, score, currency or tradable output: a bound record has no converter', () => {
    for (const recipeId of BOUND_COSMETIC_RECIPE_IDS) {
      const recipe = boundCosmeticRecipe(recipeId, V), text = JSON.stringify(recipe).toLowerCase();
      expect(Object.keys(recipe).sort()).toEqual(['blueprintId', 'durationSec', 'inputs', 'outputId', 'quantity', 'recipeId', 'recipeVersion', 'requiredFacility'].sort());
      expect(recipe.quantity).toBe('1');
      for (const word of ['price', 'reward', 'tax', 'shards', 'keep', 'gems', 'sol', 'xp', 'renown', 'score', 'mint', 'nft', 'sell', 'trade', 'raw', 'output.quantity'])
        expect(text, word).not.toContain(`"${word}`);
    }
    // Every export is an identity, a schema or the one recipe reader; nothing converts, values or transfers a bound record.
    expect(Object.keys(module).sort()).toEqual(['BOUND_COSMETIC_BLUEPRINT_ID', 'BOUND_COSMETIC_FACILITY_TYPES', 'BOUND_COSMETIC_IDS', 'BOUND_COSMETIC_RECIPE_IDS', 'BOUND_COSMETIC_RECIPE_OUTPUTS',
      'BoundCosmeticIdSchema', 'BoundCosmeticRecipeIdSchema', 'BoundCosmeticRecipeSnapshotSchema', 'boundCosmeticRecipe'].sort());
    expect(Object.values(module).filter(v => typeof v === 'function' && !('parse' in (v as object)))).toHaveLength(1);
    // The REAL converters refuse every bound id: the mining score basket (the only resource→score path) and the KEEP market listing (the only tradable path).
    for (const id of [...BOUND_COSMETIC_IDS, BOUND_COSMETIC_BLUEPRINT_ID]) {
      expect(MiningContributionResourceSchema.safeParse(id).success, id).toBe(false); expect(MINING_CONTRIBUTION_RESOURCE_IDS_V3 as readonly string[]).not.toContain(id);
      expect(KeepEquipmentMarketItemSchema.safeParse(id).success, id).toBe(false); expect(KEEP_MARKET_ITEM_IDS_V4 as readonly string[]).not.toContain(id);
    }
  });
  it('uses canonical BuildingType facilities, Workshop as the craft prerequisite, and Awning levels that are the floors of the existing Market visual tiers', () => {
    expect(BOUND_COSMETIC_FACILITY_TYPES).toEqual([BuildingType.Market, BuildingType.Lodge]); expect(POLICY.v1.craftFacility).toBe(BuildingType.Workshop);
    expect(PHASE_E_BUILDINGS.serviceTypes as readonly string[]).toEqual(expect.arrayContaining([...BOUND_COSMETIC_FACILITY_TYPES, POLICY.v1.craftFacility]));
    // Four five-level visual tiers span the existing Market progression; each Awning unlocks at its tier's floor and never at a queued upgrade target.
    const awnings = BOUND_COSMETIC_IDS.filter(id => id !== 'aurora_wake'), tierSpan = STRUCTURES.market.maxLevel / PHASE_E_BUILDINGS.visualTiers;
    expect(awnings).toHaveLength(PHASE_E_BUILDINGS.visualTiers); expect(tierSpan).toBe(5);
    for (const recipeId of BOUND_COSMETIC_RECIPE_IDS) {
      const recipe = boundCosmeticRecipe(recipeId, V);
      if (recipe.outputId === 'aurora_wake') { expect(recipe.requiredFacility).toEqual({ type: BuildingType.Lodge, level: 1 }); continue; }
      const tier = awnings.indexOf(recipe.outputId) + 1;
      expect(recipe.requiredFacility).toEqual({ type: BuildingType.Market, level: (tier - 1) * tierSpan + 1 });
      expect(recipe.requiredFacility.level).toBeLessThanOrEqual(STRUCTURES.market.maxLevel);
    }
    expect(boundCosmeticRecipe('craft_aurora_wake_v1', V).requiredFacility.level).toBeLessThanOrEqual(STRUCTURES.lodge.maxLevel);
  });
  it('requires an explicit subpath import instead of expanding the shared barrel', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(manifest.exports['./phaseEBoundCosmetics']).toBe('./src/phaseEBoundCosmetics.ts');
    expect(readFileSync(new URL('./index.ts', import.meta.url), 'utf8')).not.toMatch(/phaseEBoundCosmetics/);
  });
});
