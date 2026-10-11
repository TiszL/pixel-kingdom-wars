import { describe, expect, it } from 'vitest';
import { PHASE_E_ORDINARY_CRAFTING as P } from './constants';
import { ORDINARY_CRAFTING_ITEM_IDS, ordinaryCraftingRecipe } from './phaseEOrdinaryCrafting';
import { PHASE_E_RAW_RESOURCE_IDS, RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';
import { currentOrdinaryCraftingRecipes, matchOrdinaryCraftingEnvelope, OrdinaryCraftingEnvelopeSchema,
  OrdinaryCraftingRequestSchema, OrdinaryCraftingViewSchema, ProtectedCraftingStockSchema } from './ordinaryCraftingApi';
const wallet = '11111111111111111111111111111111';
const key = 'b6ea46e4-9c8d-4d55-ace9-f33c2676d2f3', baseId = 'c3712c3c-f044-4850-a554-bab3c92f7e40';
const request = { idempotencyKey: key, baseId, recipeId: 'refine_frostglass', recipeVersion: P.v1.recipeVersion, quantity: 1 };
const recipe = ordinaryCraftingRecipe('refine_frostglass', request.recipeVersion, request.quantity);
const startedAt = '2026-09-22T00:00:00.000Z', readyAt = new Date(Date.parse(startedAt) + recipe.durationSec * 1000).toISOString();
const accepted = () => ({ wallet, idempotencyKey: key, status: 'accepted', receipt: { wallet, request, jobId: key, recipe, startedAt, readyAt },
  completion: null, serverNow: startedAt });
const view = () => ({ wallet, baseId, features: { ordinaryCrafting: { version: 1, receipts: 1 } }, acceptingJobs: false,
  ...currentOrdinaryCraftingRecipes(), rawStock: PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '0', reserved: '0', total: '0' })),
  craftingStock: ORDINARY_CRAFTING_ITEM_IDS.map(itemId => ({ itemId, available: '0', pendingOutput: itemId === recipe.output.itemId ? recipe.output.quantity : '0' })),
  pendingJobs: [{ jobId: key, recipe, startedAt, readyAt }], serverNow: startedAt });

describe('ordinary HTTP proof and current inventory are separate contracts', () => {
  it('accepts only explicit canonical original scope, never client price or inferred base', () => {
    expect(OrdinaryCraftingRequestSchema.parse(request)).toEqual(request);
    for (const body of [{ ...request, baseId: undefined }, { ...request, baseId: baseId.toUpperCase() }, { ...request, durationSec: 1 },
      { ...request, quantity: 1.5 }, { ...request, quantity: 0 }, { ...request, idempotencyKey: 'replace-later' }])
      expect(OrdinaryCraftingRequestSchema.safeParse(body).success).toBe(false);
  });
  it('returns the exact frozen start before and after a separate completion arrives', () => {
    const original = OrdinaryCraftingEnvelopeSchema.parse(accepted());
    const done = OrdinaryCraftingEnvelopeSchema.parse({ ...accepted(), completion: { completedAt: readyAt }, serverNow: readyAt });
    expect(done.receipt).toEqual(original.receipt);
    expect(OrdinaryCraftingEnvelopeSchema.safeParse({ ...accepted(), completion: { completedAt: startedAt } }).success).toBe(false);
    expect(OrdinaryCraftingEnvelopeSchema.safeParse({ ...accepted(), completion: { completedAt: readyAt, custodyWallet: wallet } }).success).toBe(false);
  });
  it('binds accepted and unknown responses to the saved wallet, key, base and full body', () => {
    expect(matchOrdinaryCraftingEnvelope(accepted(), wallet, request).status).toBe('accepted');
    for (const original of [{ ...request, quantity: 2 }, { ...request, baseId: key }, { ...request, recipeVersion: 2 }])
      expect(() => matchOrdinaryCraftingEnvelope(accepted(), wallet, original)).toThrow();
    const unknown = { wallet, idempotencyKey: key, status: 'unknown', receipt: null, completion: null, serverNow: startedAt };
    expect(matchOrdinaryCraftingEnvelope(unknown, wallet, request).status).toBe('unknown');
    expect(() => matchOrdinaryCraftingEnvelope(unknown, wallet, { ...request, idempotencyKey: baseId })).toThrow();
    expect(OrdinaryCraftingEnvelopeSchema.safeParse({ ...unknown, completion: { completedAt: readyAt } }).success).toBe(false);
  });
  it('refuses repriced original recipes and deadline changes', () => {
    const proof = accepted();
    expect(OrdinaryCraftingEnvelopeSchema.safeParse({ ...proof, receipt: { ...proof.receipt, recipe: { ...recipe, output: { ...recipe.output, quantity: '2' } } } }).success).toBe(false);
    expect(OrdinaryCraftingEnvelopeSchema.safeParse({ ...proof, receipt: { ...proof.receipt, readyAt: startedAt } }).success).toBe(false);
  });
  it('keeps protected quantities exact through the signed-int64 boundary', () => {
    expect(ProtectedCraftingStockSchema.parse({ itemId: 'frostglass', available: (RAW_RESOURCE_STORAGE_MAX - 1n).toString(), pendingOutput: '1' }).pendingOutput).toBe('1');
    for (const available of ['01', '-1', '1.0', Number.MAX_SAFE_INTEGER, (RAW_RESOURCE_STORAGE_MAX + 1n).toString()])
      expect(ProtectedCraftingStockSchema.safeParse({ itemId: 'frostglass', available, pendingOutput: '0' }).success).toBe(false);
    expect(ProtectedCraftingStockSchema.safeParse({ itemId: 'frostglass', available: RAW_RESOURCE_STORAGE_MAX.toString(), pendingOutput: '1' }).success).toBe(false);
  });
  it('requires a complete identity inventory and conservation of every pending output', () => {
    expect(OrdinaryCraftingViewSchema.parse(view()).pendingJobs).toHaveLength(1);
    for (const change of [{ rawStock: [] }, { craftingStock: [] }, { pendingJobs: [] }, { serverNow: readyAt },
      { recipes: [] }, { pendingJobs: [...view().pendingJobs, ...view().pendingJobs] }])
      expect(OrdinaryCraftingViewSchema.safeParse({ ...view(), ...change }).success).toBe(false);
  });
});
