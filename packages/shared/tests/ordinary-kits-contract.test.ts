import { describe, expect, it } from 'vitest';
import { PHASE_E_ORDINARY_CRAFTING, PHASE_E_ORDINARY_CRAFTING_V2, PHASE_E_MINING_CONTRIBUTION_V2, PHASE_E_MINING_CONTRIBUTION_V3 } from '../src/constants';
import { ORDINARY_CRAFTING_ITEM_IDS, ORDINARY_CRAFTING_ITEM_IDS_V2, ORDINARY_RECIPE_IDS, ORDINARY_RECIPE_IDS_V2,
  ordinaryCraftingRecipe, OrdinaryCraftingRecipeSnapshotSchema } from '../src/phaseEOrdinaryCrafting';
import { currentOrdinaryCraftingRecipes, OrdinaryCraftingViewSchema, OrdinaryCraftingViewQuerySchema,
  OrdinaryCraftingEnvelopeSchema, matchOrdinaryCraftingEnvelope } from '../src/ordinaryCraftingApi';
import { KEEP_MARKET_ITEM_IDS, KEEP_MARKET_CRAFTING_CATALOGUE_IDS, KEEP_MARKET_ITEM_IDS_V4, keepMarketCatalogueIds,
  KeepEquipmentStockViewSchema, KeepEquipmentStockQuerySchema, KeepEquipmentListingsQuerySchema,
  KeepEquipmentHistoryQuerySchema, KeepEquipmentMarketPolicySchema, keepMarketCategory } from '../src/keepEquipmentMarketApi';
import { PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT, PHASE_E_KEEP_EQUIPMENT_MARKET, PHASE_E_POLICY, TOKEN } from '../src/constants';
import { MINING_CONTRIBUTION_RESOURCE_IDS, MINING_CONTRIBUTION_RESOURCE_IDS_V3, miningContributionResourceIds,
  miningResourceUnitValue, valueMiningContribution } from '../src/miningContribution';
import { MiningContributionRequestSchema, MiningContributionViewSchema, MiningContributionEnvelopeSchema,
  MiningContributionViewQuerySchema, matchMiningContributionEnvelope } from '../src/miningContributionApi';
import { PHASE_E_RAW_RESOURCE_IDS, RAW_RESOURCE_STORAGE_MAX } from '../src/phaseEResources';

const wallet = '11111111111111111111111111111111';
const baseId = '00000000-0000-4000-8000-000000000001', id = '00000000-0000-4000-8000-000000000002';
const now = '2035-01-01T00:00:00.000Z';
const zero = (itemId: string) => ({ itemId, available: '0', pendingOutput: '0' });
function craftView(catalogueVersion: 1 | 2) {
  return { wallet, baseId, features: { ordinaryCrafting: { version: 1, receipts: 1 } }, acceptingJobs: true,
    ...currentOrdinaryCraftingRecipes(catalogueVersion),
    rawStock: PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '0', reserved: '0', total: '0' })),
    craftingStock: (catalogueVersion === 1 ? ORDINARY_CRAFTING_ITEM_IDS : ORDINARY_CRAFTING_ITEM_IDS_V2).map(zero),
    pendingJobs: [], serverNow: now, ...(catalogueVersion === 2 ? { catalogueVersion: 2, shardsAvailable: '25' } : {}) };
}
function miningView(policyVersion: 2 | 3) {
  return { wallet, baseId, policyVersion, day: now.slice(0, 10), serverNow: now, acceptingContributions: true,
    pool: 'free', dailyCapValue: '20000', committedValue: '3000', remainingValue: '17000', developmentReady: true,
    resources: miningContributionResourceIds(policyVersion).map(resourceId => ({ resourceId, available: '1', unitValue: String(miningResourceUnitValue(resourceId, policyVersion)) })),
    consistency: { windowDays: 14, bonusPerQualifiedDayBps: 200, maximumBonusBps: 2800 } };
}
const marketPolicy = KeepEquipmentMarketPolicySchema.parse({ version: PHASE_E_KEEP_EQUIPMENT_MARKET.policyVersion,
  decimals: TOKEN.decimals, minFillBaseUnits: PHASE_E_KEEP_EQUIPMENT_MARKET.minFillBaseUnits.toString(),
  sellerBps: PHASE_E_POLICY.taxes.keepMarket.sellerBps, basisPoints: PHASE_E_POLICY.basisPoints,
  reviewMaxAgeMs: PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT.reviewMaxAgeMs });
function marketView(catalogueVersion?: '2' | '3' | '4') {
  return { baseId, wallet, serverNow: now, policy: marketPolicy,
    ...(catalogueVersion ? { catalogueVersion: Number(catalogueVersion) } : {}),
    items: keepMarketCatalogueIds(catalogueVersion).map(itemId => ({ ...zero(itemId), reserved: '0', marketOutgoing: '0', marketIncoming: '0' })) };
}

describe('D153.208 ordinary kits: immutable historical recipes and real SHARDS ingredient', () => {
  it('keeps the v1 nine and old default discovery exact while v2 opts into eleven', () => {
    expect(PHASE_E_ORDINARY_CRAFTING.currentRecipeVersion).toBe(1);
    expect(ORDINARY_CRAFTING_ITEM_IDS).toHaveLength(9);
    expect(ORDINARY_RECIPE_IDS).toHaveLength(9);
    expect(ORDINARY_CRAFTING_ITEM_IDS_V2).toHaveLength(11);
    expect(currentOrdinaryCraftingRecipes()).toEqual(currentOrdinaryCraftingRecipes(1));
    expect(currentOrdinaryCraftingRecipes(2).recipeVersion).toBe(2);
    expect(currentOrdinaryCraftingRecipes(2).recipes).toHaveLength(11);
    for (const recipeId of ORDINARY_RECIPE_IDS) {
      const old = ordinaryCraftingRecipe(recipeId, 1, 10);
      expect(ordinaryCraftingRecipe(recipeId, 2, 10)).toEqual({ ...old, recipeVersion: 2 });
      expect(OrdinaryCraftingRecipeSnapshotSchema.parse(old)).toEqual(old);
    }
    expect(() => currentOrdinaryCraftingRecipes(3)).toThrow();
  });
  it.each([1, 10])('scales both kit inputs, output and time exactly for quantity %i', quantity => {
    const climate = ordinaryCraftingRecipe('craft_climate_kit', 2, quantity);
    expect(climate.inputs).toEqual([
      { kind: 'crafting', itemId: 'sunstone_blocks', quantity: String(quantity) },
      { kind: 'crafting', itemId: 'embercore', quantity: String(quantity) },
    ]);
    expect(climate.output).toEqual({ itemId: 'climate_kit', quantity: String(quantity) });
    expect(climate.durationSec).toBe(quantity * 120);
    const expedition = ordinaryCraftingRecipe('craft_expedition_kit', 2, quantity);
    expect(expedition.inputs).toEqual([
      { kind: 'crafting', itemId: 'heartwood_beams', quantity: String(quantity) },
      { kind: 'crafting', itemId: 'thornsilk', quantity: String(quantity) },
      { kind: 'shards', itemId: 'shards', quantity: String(quantity * 25) },
    ]);
    expect(expedition.output).toEqual({ itemId: 'expedition_kit', quantity: String(quantity) });
    expect(expedition.durationSec).toBe(quantity * 180);
    for (const recipe of [climate, expedition]) expect(OrdinaryCraftingRecipeSnapshotSchema.parse(recipe)).toEqual(recipe);
  });
  it('rejects kit backdating, missing/reclassified SHARDS and invalid batch bounds', () => {
    for (const recipeId of ['craft_climate_kit', 'craft_expedition_kit'] as const) {
      expect(() => ordinaryCraftingRecipe(recipeId, 1, 1)).toThrow();
      for (const quantity of [0, -1, 1.5, 11, Infinity]) expect(() => ordinaryCraftingRecipe(recipeId, 2, quantity)).toThrow();
    }
    const recipe = ordinaryCraftingRecipe('craft_expedition_kit', 2, 1);
    for (const inputs of [recipe.inputs.slice(0, 2), [...recipe.inputs.slice(0, 2), { kind: 'crafting', itemId: 'shards', quantity: '25' }],
      [...recipe.inputs.slice(0, 2), { kind: 'shards', itemId: 'shards', quantity: '24' }]]) {
      expect(OrdinaryCraftingRecipeSnapshotSchema.safeParse({ ...recipe, inputs }).success).toBe(false);
    }
    expect(PHASE_E_ORDINARY_CRAFTING_V2.maxBatch).toBe(10);
  });
  it('requires authoritative SHARDS and full inventory only on explicit catalogue2', () => {
    const old = craftView(1), current = craftView(2);
    expect(OrdinaryCraftingViewSchema.parse(old)).toEqual(old);
    expect(OrdinaryCraftingViewSchema.parse(current)).toEqual(current);
    for (const changed of [{ ...current, shardsAvailable: undefined }, { ...current, shardsAvailable: '01' },
      { ...current, craftingStock: old.craftingStock }, { ...old, shardsAvailable: '25' },
      { ...old, craftingStock: current.craftingStock }, { ...current, recipeVersion: 1 }])
      expect(OrdinaryCraftingViewSchema.safeParse(changed).success).toBe(false);
    expect(OrdinaryCraftingViewQuerySchema.parse({ baseId })).toEqual({ baseId });
    expect(OrdinaryCraftingViewQuerySchema.safeParse({ baseId, catalogueVersion: '2' }).success).toBe(true);
    expect(OrdinaryCraftingViewQuerySchema.safeParse({ baseId, catalogueVersion: '3' }).success).toBe(false);
  });
  it('preserves both accepted originals and refuses v1 discovery hiding any pending v2 job', () => {
    for (const version of [1, 2]) {
      const recipe = ordinaryCraftingRecipe('craft_navigation_kit', version, 1);
      const request = { idempotencyKey: id, baseId, recipeId: recipe.recipeId, recipeVersion: version, quantity: 1 };
      const pending = { jobId: id, recipe, startedAt: now, readyAt: '2035-01-01T00:02:00.000Z' };
      const envelope = { wallet, idempotencyKey: id, status: 'accepted', receipt: { wallet, request, ...pending }, completion: null, serverNow: now };
      expect(OrdinaryCraftingEnvelopeSchema.parse(envelope)).toEqual(envelope);
      expect(matchOrdinaryCraftingEnvelope(envelope, wallet, request)).toEqual(envelope);
      for (const catalogue of [1, 2] as const) {
        const view = { ...craftView(catalogue), pendingJobs: [pending], craftingStock: craftView(catalogue).craftingStock.map(row =>
          row.itemId === 'navigation_kit' ? { ...row, pendingOutput: '1' } : row) };
        expect(OrdinaryCraftingViewSchema.safeParse(view).success).toBe(catalogue === 2 || version === 1);
      }
    }
  });
});

describe('KEEP market catalogue4 never widens historical discovery', () => {
  it('preserves exact2/11/12 sets and explicitly adds both kits as items in catalogue4', () => {
    expect(KEEP_MARKET_CRAFTING_CATALOGUE_IDS).toHaveLength(11);
    expect(KEEP_MARKET_ITEM_IDS).toHaveLength(12);
    expect(KEEP_MARKET_ITEM_IDS_V4).toHaveLength(14);
    for (const [version, count] of [[undefined, 2], ['2', 11], ['3', 12], ['4', 14]] as const) {
      expect(keepMarketCatalogueIds(version)).toHaveLength(count);
      expect(KeepEquipmentStockViewSchema.safeParse(marketView(version)).success).toBe(true);
      expect(KeepEquipmentStockQuerySchema.safeParse({ baseId, ...(version ? { catalogueVersion: version } : {}) }).success).toBe(true);
    }
    for (const itemId of ['climate_kit', 'expedition_kit'] as const) {
      expect(keepMarketCategory(itemId)).toBe('items');
      for (const schema of [KeepEquipmentListingsQuerySchema, KeepEquipmentHistoryQuerySchema]) {
        for (const version of [undefined, '2', '3']) expect(schema.safeParse({ itemId, ...(version ? { catalogueVersion: version } : {}) }).success).toBe(false);
        expect(schema.safeParse({ itemId, catalogueVersion: '4', category: 'items' }).success).toBe(true);
        expect(schema.safeParse({ itemId, catalogueVersion: '4', category: 'resources' }).success).toBe(false);
      }
    }
  });
  it('refuses substituting a new kit into an old stock view or omitting one from catalogue4', () => {
    const old = marketView('3'); old.items[0]!.itemId = 'climate_kit';
    expect(KeepEquipmentStockViewSchema.safeParse(old).success).toBe(false);
    const current = marketView('4');
    expect(KeepEquipmentStockViewSchema.safeParse({ ...current, items: current.items.slice(1) }).success).toBe(false);
    expect(KeepEquipmentStockViewSchema.safeParse({ ...current, items: [...current.items.slice(1), current.items[1]] }).success).toBe(false);
  });
});

describe('mining policy3 changes catalogue without manufacturing value or free allowance', () => {
  it('preserves every policy2 value and all allowance/consistency fields exactly', () => {
    expect(MINING_CONTRIBUTION_RESOURCE_IDS).toHaveLength(20);
    expect(MINING_CONTRIBUTION_RESOURCE_IDS_V3).toHaveLength(22);
    expect(PHASE_E_MINING_CONTRIBUTION_V3).toEqual({ ...PHASE_E_MINING_CONTRIBUTION_V2, version: 3 });
    for (const resource of MINING_CONTRIBUTION_RESOURCE_IDS) expect(miningResourceUnitValue(resource, 3)).toBe(miningResourceUnitValue(resource, 2));
    expect(valueMiningContribution(MINING_CONTRIBUTION_RESOURCE_IDS.map(resourceId => ({ resourceId, quantity: '1' })), 2).totalValue).toBe('30801');
    expect(miningResourceUnitValue('climate_kit', 3)).toBe(2000n);
    expect(miningResourceUnitValue('expedition_kit', 3)).toBe(2025n);
    expect(() => miningResourceUnitValue('climate_kit', 2)).toThrow();
    expect(() => miningResourceUnitValue('expedition_kit', 2)).toThrow();
    expect(() => miningContributionResourceIds(4)).toThrow();
  });
  it.each([1, 10])('preserves exact consumed ingredient value for every v2 recipe, batch %i', quantity => {
    for (const id of ORDINARY_RECIPE_IDS_V2) {
      const recipe = ordinaryCraftingRecipe(id, 2, quantity);
      const before = valueMiningContribution(recipe.inputs.map(row => ({ resourceId: row.itemId, quantity: row.quantity })), 3);
      const after = valueMiningContribution([{ resourceId: recipe.output.itemId, quantity: recipe.output.quantity }], 3);
      expect(after.totalValue, id).toBe(before.totalValue);
    }
  });
  it('binds kit originals to policy3 and recovers policy2 without repricing', () => {
    for (const policyVersion of [2, 3] as const) {
      const request = { idempotencyKey: id, baseId, policyVersion, expectedDay: now.slice(0, 10),
        lines: [{ resourceId: policyVersion === 2 ? 'navigation_kit' as const : 'expedition_kit' as const, quantity: '1' }] };
      const value = valueMiningContribution(request.lines, policyVersion);
      const receipt = { id, epochId: baseId, wallet, day: request.expectedDay, request, lines: value.lines, totalValue: value.totalValue, createdAt: now };
      const proof = { wallet, idempotencyKey: id, status: 'accepted', receipt, settlement: null, serverNow: now };
      expect(MiningContributionEnvelopeSchema.parse(proof)).toEqual(proof);
      expect(matchMiningContributionEnvelope(proof, wallet, request)).toEqual(proof);
      if (policyVersion === 3) {
        expect(MiningContributionRequestSchema.safeParse({ ...request, policyVersion: 2 }).success).toBe(false);
        expect(MiningContributionEnvelopeSchema.safeParse({ ...proof, receipt: { ...receipt, request: { ...request, policyVersion: 2 } } }).success).toBe(false);
      }
    }
  });
  it('requires exactly the selected day policy catalogue, canonical values and unchanged shared allowance', () => {
    for (const version of [2, 3] as const) {
      const view = miningView(version);
      expect(MiningContributionViewSchema.parse(view)).toEqual(view);
      expect(MiningContributionViewSchema.safeParse({ ...view, policyVersion: version === 2 ? 3 : 2 }).success).toBe(false);
      expect(MiningContributionViewSchema.safeParse({ ...view, remainingValue: '20000' }).success).toBe(false);
      for (const committedValue of ['abc', '-1', '01', '1.5'])
        expect(MiningContributionViewSchema.safeParse({ ...view, committedValue }).success).toBe(false);
      expect(MiningContributionViewSchema.safeParse({ ...view, pool: 'deed', dailyCapValue: null, remainingValue: null }).success).toBe(true);
    }
    const bound = RAW_RESOURCE_STORAGE_MAX * 30801n;
    expect(MiningContributionViewSchema.safeParse({ ...miningView(2), pool: 'deed', dailyCapValue: null, remainingValue: null, committedValue: String(bound + 1n) }).success).toBe(false);
    expect(MiningContributionViewQuerySchema.safeParse({ baseId, catalogueVersion: '3' }).success).toBe(true);
    expect(MiningContributionViewQuerySchema.safeParse({ baseId, catalogueVersion: '4' }).success).toBe(false);
  });
});
