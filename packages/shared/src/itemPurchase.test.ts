import { describe, expect, it } from 'vitest';
import { ItemPurchaseConsentSchema, ItemPurchaseIntentSchema, ItemPurchaseProofSchema,
  itemPurchaseBody, itemPurchaseReceiptPath, matchItemPurchaseProof } from './itemPurchase';

const id = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const wallet = '11111111111111111111111111111111';
const request = { itemId: 'retired_shop_item', baseId: id, idempotencyKey: 'original-key', expectedCurrency: 'GEMS' as const,
  consent: { version: 1 as const, catalogRevision: 2, quantity: 1 as const, maxCostKeep: '100' } };
const proof = { version: 1 as const, status: 'accepted' as const, wallet, request, receiptId: other,
  acceptedAt: '2026-09-21T10:00:00.000Z', funding: { currency: 'GEMS' as const, amount: '90' },
  result: { itemId: request.itemId, quantity: 1 as const } };
describe('original shop purchase protocol', () => {
  it('recovers a removed catalogue item without repricing or inferring current stock', () => {
    expect(matchItemPurchaseProof(proof, wallet, request)).toEqual(proof);
    expect(itemPurchaseBody(request)).toEqual({ itemId: request.itemId, baseId: id, idempotencyKey: request.idempotencyKey, consent: request.consent });
    expect(itemPurchaseBody({ ...request, baseId: null })).not.toHaveProperty('baseId');
    expect(itemPurchaseReceiptPath({ itemId: request.itemId, baseId: id, idempotencyKey: request.idempotencyKey })).toContain(`baseId=${id}`);
    expect(itemPurchaseReceiptPath({ itemId: request.itemId, baseId: null, idempotencyKey: request.idempotencyKey })).not.toContain('baseId');
  });
  it.each([{ version: '1' }, { catalogRevision: '2' }, { catalogRevision: 0 }, { quantity: 2 },
    { maxCostKeep: '01' }, { maxCostKeep: '0' }, { maxCostKeep: 100 }, { maxCostKeep: '9223372036854775808' }, { extra: true }])(
    'rejects coercion, overflow and changed quantity %j', change => {
      expect(ItemPurchaseConsentSchema.safeParse({ ...request.consent, ...change }).success).toBe(false);
    });
  it.each([{ expectedCurrency: 'SKR' }, { baseId: '' }, { itemId: '../item' }, { idempotencyKey: 'short' }, { extra: true }])(
    'rejects invalid command scope %j', change => {
      expect(ItemPurchaseIntentSchema.safeParse({ ...request, ...change }).success).toBe(false);
    });
  it.each([{ funding: { currency: 'KEEP', amount: '90' } }, { funding: { currency: 'GEMS', amount: '101' } },
    { funding: { currency: 'GEMS', amount: '0' } }, { result: { itemId: 'other_item', quantity: 1 } },
    { result: { itemId: request.itemId, quantity: 2 } }, { acceptedAt: 'not-a-date' }])(
    'cannot prove a different debit or item grant %j', change => {
      expect(ItemPurchaseProofSchema.safeParse({ ...proof, ...change }).success).toBe(false);
    });
  it('binds wallet, original base/key/terms and unknown key', () => {
    expect(() => matchItemPurchaseProof(proof, '21111111111111111111111111111111', request)).toThrow();
    for (const change of [{ baseId: other }, { idempotencyKey: 'another-key' }, { consent: { ...request.consent, maxCostKeep: '101' } }])
      expect(() => matchItemPurchaseProof(proof, wallet, { ...request, ...change })).toThrow();
    expect(() => matchItemPurchaseProof({ version: 1, status: 'unknown', idempotencyKey: 'another-key' }, wallet, request)).toThrow();
  });
});
