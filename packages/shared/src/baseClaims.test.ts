import { describe, expect, it } from 'vitest';
import { BaseClaimCancellationSchema, BaseClaimCandidateSchema, BaseClaimReceiptSchema, BaseClaimRequestSchema, BaseClaimStatusSchema } from './baseClaims';
const actor = '11111111111111111111111111111111';
const other = 'So11111111111111111111111111111111111111112';
const key = 'c0252e68-ed32-4bda-8540-af05f1788998';
const request = { idempotencyKey: key, baseId: 'e7c24242-daad-489f-91b0-b19a8c0133df', deedAssetId: other };
const receipt = { version: 1, actor, idempotencyKey: key, request, outcome: 'claimed', active: false,
  transferId: 'e2b893f1-3cc8-4bce-8b69-ab39a5dd1338', fromWallet: other,
  ownership: { owner: actor, collection: other, slot: '12345' }, createdAt: '2034-08-01T00:00:00.000Z' };
describe('exact deed claim consent and historical outcome', () => {
  it('does not accept a body with a missing target, uppercase key or client-supplied actor', () => {
    expect(BaseClaimRequestSchema.parse(request)).toEqual(request);
    for (const invalid of [{ idempotencyKey: key }, { ...request, idempotencyKey: key.toUpperCase() }, { ...request, actor }]) {
      expect(BaseClaimRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('distinguishes an inactive accepted transfer from freshly verified already-owned state', () => {
    expect(BaseClaimReceiptSchema.parse(receipt)).toEqual(receipt);
    const owned = { ...receipt, outcome: 'already_owned', transferId: null, fromWallet: null };
    expect(BaseClaimReceiptSchema.parse(owned)).toEqual(owned);
    for (const invalid of [{ ...receipt, transferId: null }, { ...receipt, fromWallet: actor },
      { ...owned, transferId: receipt.transferId }, { ...receipt, request: { ...request, idempotencyKey: request.baseId } },
      { ...receipt, ownership: { ...receipt.ownership, owner: other } }]) {
      expect(BaseClaimReceiptSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('requires safe canonical finalized slots, never floating point or malformed evidence', () => {
    for (const slot of ['-1', '01', '1e3', '9007199254740992', 'x', '']) {
      expect(BaseClaimReceiptSchema.safeParse({ ...receipt, ownership: { ...receipt.ownership, slot } }).success).toBe(false);
    }
  });
  it('status binds original actor and key even when the capability is now disabled', () => {
    const status = { version: 1, wallet: actor, idempotencyKey: key, enabled: false, receipt };
    expect(BaseClaimStatusSchema.parse(status)).toEqual(status);
    for (const invalid of [{ ...status, wallet: other }, { ...status, idempotencyKey: request.baseId }]) {
      expect(BaseClaimStatusSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('unknown reads and a proved cancellation remain distinct contracts', () => {
    expect(BaseClaimStatusSchema.parse({ version: 1, wallet: actor, idempotencyKey: key, enabled: true, receipt: null }).receipt).toBeNull();
    const ack = { version: 1, wallet: actor, idempotencyKey: key, cancelled: true, receipt: null };
    expect(BaseClaimCancellationSchema.parse(ack)).toEqual(ack);
    expect(BaseClaimCancellationSchema.parse({ ...ack, cancelled: false, receipt }).receipt).toEqual(receipt);
    for (const invalid of [{ ...ack, cancelled: false }, { ...ack, receipt }, { ...ack, cancelled: false, receipt, wallet: other }]) {
      expect(BaseClaimCancellationSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('only an enabled eligible candidate can start exact consent', () => {
    const candidate = { version: 1, wallet: actor, enabled: true, candidate: { baseId: request.baseId, deedAssetId: other }, reason: 'ok' };
    expect(BaseClaimCandidateSchema.parse(candidate)).toEqual(candidate);
    for (const invalid of [{ ...candidate, enabled: false }, { ...candidate, reason: 'none' }, { ...candidate, candidate: null }]) {
      expect(BaseClaimCandidateSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
