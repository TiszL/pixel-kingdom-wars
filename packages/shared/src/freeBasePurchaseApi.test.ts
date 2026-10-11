import { describe, expect, it } from 'vitest';
import { PHASE_E_FREE_BASE_POLICY, PHASE_E_POLICY } from './constants';
import { FreeBasePurchaseReceiptSchema, FreeBasePurchaseRequestSchema, FreeBasePurchaseViewSchema } from './freeBasePurchaseApi';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111';
const receipt = { version: 1, wallet, idempotencyKey: 'fixture-purchase', sourceBaseId: id(1), baseId: id(2),
  slot: 2, shardsCharged: String(PHASE_E_POLICY.bases.secondFreeBaseCostShards), debitTransactionId: id(3),
  development: { keepId: id(4), keepLevel: PHASE_E_FREE_BASE_POLICY.minKeepLevel,
    workshopId: id(5), workshopLevel: PHASE_E_FREE_BASE_POLICY.minWorkshopLevel,
    goldForgeId: id(6), goldForgeLevel: PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel }, acceptedAt: '2035-01-01T12:00:00.000Z' };
const view = { version: 1, wallet, enabled: true, sourceBaseId: id(1), receipt: null,
  terms: { policyVersion: 1, costShards: receipt.shardsCharged, minKeepLevel: PHASE_E_FREE_BASE_POLICY.minKeepLevel,
    minWorkshopLevel: PHASE_E_FREE_BASE_POLICY.minWorkshopLevel, minGoldForgeLevel: PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel,
    maxFreeBases: PHASE_E_POLICY.bases.freePerWalletMax, maxActiveBases: PHASE_E_POLICY.bases.activePerWalletMax },
  admission: { allowed: true, reason: 'ready' } };
describe('free base purchase wire boundaries', () => {
  it('accepts server terms and receipts, never caller prices or ownership', () => {
    expect(FreeBasePurchaseViewSchema.safeParse(view).success).toBe(true);
    expect(FreeBasePurchaseReceiptSchema.safeParse(receipt).success).toBe(true);
    const request = { sourceBaseId: id(1), idempotencyKey: 'fixture-purchase' };
    expect(FreeBasePurchaseRequestSchema.safeParse(request).success).toBe(true);
    for (const extra of [{ price: '1' }, { wallet }, { owner: true }]) {
      expect(FreeBasePurchaseRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
  });
  it('fails closed on corrupt, noncanonical and oversized amounts without throwing', () => {
    for (const value of ['', 'x', '-1', '0', '01', '1.5', '1e5', '9223372036854775808', '9'.repeat(10_000)]) {
      expect(FreeBasePurchaseReceiptSchema.safeParse({ ...receipt, shardsCharged: value }).success).toBe(false);
      expect(FreeBasePurchaseViewSchema.safeParse({ ...view, terms: { ...view.terms, costShards: value } }).success).toBe(false);
    }
  });
  it('refuses contradictory admission and foreign receipts but retains paused historical recovery', () => {
    for (const extra of [{ enabled: false }, { sourceBaseId: null }, { receipt }, { admission: { allowed: true, reason: 'disabled' } }]) {
      expect(FreeBasePurchaseViewSchema.safeParse({ ...view, ...extra }).success).toBe(false);
    }
    const paused = { ...view, enabled: false, receipt, admission: { allowed: false, reason: 'already-purchased' } };
    expect(FreeBasePurchaseViewSchema.safeParse(paused).success).toBe(true);
    expect(FreeBasePurchaseViewSchema.safeParse({ ...paused, receipt: { ...receipt, wallet: '22222222222222222222222222222222' } }).success).toBe(false);
    expect(FreeBasePurchaseReceiptSchema.safeParse({ ...receipt, baseId: receipt.sourceBaseId }).success).toBe(false);
  });
});
