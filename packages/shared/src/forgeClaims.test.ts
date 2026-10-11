import { describe, expect, it } from 'vitest';
import { ForgeClaimReceiptSchema, ForgeClaimRequestSchema, ForgeClaimResultSchema, ForgeClaimStatusSchema } from './forgeClaims';
const key = '00000000-0000-4000-8000-000000000001';
const actor = '11111111111111111111111111111111';
const request = { idempotencyKey: key, baseId: null, day: null };
const result = { claimed: [{ day: '2026-09-01', keep: '17', ledgerTransactionId: key }], totalKeep: '17', remaining: 0 };
const receipt = { version: 1, actor, ...request, result, createdAt: '2026-09-13T00:00:00.000Z' };
describe('Forge claim command consent and exact payout', () => {
  it('requires explicit original wallet/base and one-day/all selector', () => {
    expect(ForgeClaimRequestSchema.parse(request)).toEqual(request);
    for (const input of [{ idempotencyKey: key }, { ...request, day: '2026-02-30' }, { ...request, baseId: 'other' },
      { ...request, idempotencyKey: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { ...request, amount: '17' }]) {
      expect(ForgeClaimRequestSchema.safeParse(input).success).toBe(false);
    }
  });
  it('cannot substitute rounded, negative, duplicate, unordered or inconsistent payouts', () => {
    expect(ForgeClaimResultSchema.parse(result)).toEqual(result);
    for (const input of [{ ...result, totalKeep: '18' }, { ...result, totalKeep: '1.7e1' }, { ...result, remaining: 0.1 },
      { ...result, claimed: [{ ...result.claimed[0]!, keep: '-17' }] }, { ...result, claimed: [result.claimed[0], result.claimed[0]], totalKeep: '34' },
      { ...result, claimed: [{ ...result.claimed[0]!, day: '2026-09-02' }, { ...result.claimed[0]!, ledgerTransactionId: '00000000-0000-4000-8000-000000000002' }], totalKeep: '34' }]) {
      expect(ForgeClaimResultSchema.safeParse(input).success).toBe(false);
    }
  });
  it('an empty completed command proves zero without pretending a missing key is completion', () => {
    const empty = { ...receipt, result: { claimed: [], totalKeep: '0', remaining: 0 } };
    expect(ForgeClaimReceiptSchema.parse(empty)).toEqual(empty);
    expect(ForgeClaimStatusSchema.parse({ version: 1, wallet: actor, idempotencyKey: key, enabled: false, receipt: null }).receipt).toBeNull();
  });
  it('binds single-day selectors and authenticated actor/key to historical receipts', () => {
    expect(ForgeClaimReceiptSchema.safeParse({ ...receipt, day: '2026-09-02' }).success).toBe(false);
    expect(ForgeClaimStatusSchema.safeParse({ version: 1, wallet: actor, idempotencyKey: '00000000-0000-4000-8000-000000000002', enabled: true, receipt }).success).toBe(false);
  });
});
