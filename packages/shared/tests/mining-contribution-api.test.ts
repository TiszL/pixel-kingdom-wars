import { describe, expect, it } from 'vitest';
import { MiningContributionEnvelopeSchema, MiningContributionRequestSchema, MiningContributionViewSchema, matchMiningContributionEnvelope } from '../src/miningContributionApi';
import { MINING_CONTRIBUTION_RESOURCE_IDS, miningResourceUnitValue, valueMiningContribution } from '../src/miningContribution';

const wallet = '11111111111111111111111111111111';
const key = '00000000-0000-4000-8000-000000000001', base = '00000000-0000-4000-8000-000000000002';
const request = { idempotencyKey: key, baseId: base, policyVersion: 2 as const, expectedDay: '2020-01-01',
  lines: [{ resourceId: 'shards' as const, quantity: '1200' }, { resourceId: 'frostglass' as const, quantity: '2' }] };
function envelope() {
  const value = valueMiningContribution(request.lines, 2);
  return { wallet, idempotencyKey: key, serverNow: '2020-01-03T00:00:00.000Z', status: 'accepted' as const,
    receipt: { id: key, epochId: '00000000-0000-4000-8000-000000000003', wallet, day: request.expectedDay,
      request: structuredClone(request), lines: value.lines.map(line => ({ ...line })), totalValue: value.totalValue,
      createdAt: '2020-01-01T12:00:00.000Z' }, settlement: { outcome: 'returned' as const, settledAt: '2020-01-02T12:00:00.000Z' } };
}
function view() {
  return { wallet, baseId: base, policyVersion: 2 as const, day: '2020-01-01', serverNow: '2020-01-01T12:00:00.000Z',
    acceptingContributions: true, pool: 'free' as const, dailyCapValue: '20000', committedValue: '3200', remainingValue: '16800', developmentReady: true,
    resources: MINING_CONTRIBUTION_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '3', unitValue: String(miningResourceUnitValue(resourceId, 2)) })),
    consistency: { windowDays: 14, bonusPerQualifiedDayBps: 200, maximumBonusBps: 2800 } };
}
describe('resource commitment consent and immutable recovery transport', () => {
  it('recovers exact original consent after midnight without repricing or treating return as a fresh contribution', () => {
    const proof = envelope();
    expect(matchMiningContributionEnvelope(proof, wallet, request)).toEqual(proof);
    expect(() => matchMiningContributionEnvelope(proof, wallet, { ...request, expectedDay: '2020-01-02' })).toThrow();
    expect(() => matchMiningContributionEnvelope(proof, wallet, { ...request, lines: [{ resourceId: 'shards', quantity: '3200' }] })).toThrow();
  });
  it('rejects client prices, arbitrary epoch ids and unknown policy versions', () => {
    expect(MiningContributionRequestSchema.safeParse({ ...request, epochId: key }).success).toBe(false);
    expect(MiningContributionRequestSchema.safeParse({ ...request, totalValue: '1' }).success).toBe(false);
    expect(MiningContributionRequestSchema.safeParse({ ...request, policyVersion: 1 }).success).toBe(false);
  });
  it('rejects altered line value, duplicate line, identity and impossible terminal time', () => {
    const price = envelope(); price.receipt.lines[0]!.value = '999999';
    expect(MiningContributionEnvelopeSchema.safeParse(price).success).toBe(false);
    const duplicate = envelope(); duplicate.receipt.lines.push(duplicate.receipt.lines[0]!);
    expect(MiningContributionEnvelopeSchema.safeParse(duplicate).success).toBe(false);
    const identity = envelope(); identity.idempotencyKey = base;
    expect(MiningContributionEnvelopeSchema.safeParse(identity).success).toBe(false);
    const time = envelope(); time.settlement.settledAt = '2019-12-31T00:00:00.000Z';
    expect(MiningContributionEnvelopeSchema.safeParse(time).success).toBe(false);
  });
  it('represents the wallet-wide free allowance and an uncapped deed view explicitly', () => {
    expect(MiningContributionViewSchema.safeParse(view()).success).toBe(true);
    expect(MiningContributionViewSchema.safeParse({ ...view(), pool: 'deed', dailyCapValue: null, remainingValue: null }).success).toBe(true);
    expect(MiningContributionViewSchema.safeParse({ ...view(), pool: 'deed' }).success).toBe(false);
    expect(MiningContributionViewSchema.safeParse({ ...view(), remainingValue: '20000' }).success).toBe(false);
    expect(MiningContributionViewSchema.safeParse({ ...view(), resources: view().resources.slice(1) }).success).toBe(false);
  });
  it('rejects a review from another UTC day or a price/consistency catalogue mismatch', () => {
    expect(MiningContributionViewSchema.safeParse({ ...view(), day: '2020-01-02' }).success).toBe(false);
    const price = view(); price.resources[0]!.unitValue = '100000';
    expect(MiningContributionViewSchema.safeParse(price).success).toBe(false);
    const bonus = view(); bonus.consistency.maximumBonusBps = 3000;
    expect(MiningContributionViewSchema.safeParse(bonus).success).toBe(false);
  });
});
