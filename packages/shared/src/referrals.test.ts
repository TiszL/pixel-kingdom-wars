import { describe, expect, it } from 'vitest';
import { ReferralStatusV1Schema, ReferralUseV1RequestSchema, ReferralUseV1ResponseSchema } from './referrals';
const wallet = '11111111111111111111111111111111';
const other = '22222222222222222222222222222222';
const relationship = { id: '00000000-0000-4000-8000-000000000001', refereeWallet: wallet, referrerWallet: other, createdAt: '2026-09-13T00:00:00.000Z' };
describe('referral recovery wire contract', () => {
  it('normalizes explicit v1 code consent and refuses caller-supplied target identity', () => {
    expect(ReferralUseV1RequestSchema.parse({ code: ' keep-ab234 ' })).toEqual({ code: 'KEEP-AB234' });
    expect(ReferralUseV1RequestSchema.safeParse({ code: 'KEEP-AB234', wallet: other }).success).toBe(false);
  });
  it('retains an unbound observation without introducing a success or failure claim', () => {
    expect(ReferralStatusV1Schema.parse({ version: 1, wallet, relationship: null }).relationship).toBeNull();
    expect(ReferralStatusV1Schema.safeParse({ version: 1, wallet: other, relationship }).success).toBe(false);
    expect(ReferralStatusV1Schema.safeParse({ version: 1, wallet, relationship: { ...relationship, referrerWallet: wallet } }).success).toBe(false);
  });
  it('keeps actual existing attribution distinct from the submitted code succeeding', () => {
    const result = { version: 1, wallet, submittedCode: 'KEEP-AB234', outcome: 'already_bound', relationship };
    expect(ReferralUseV1ResponseSchema.parse(result).outcome).toBe('already_bound');
    expect(ReferralUseV1ResponseSchema.safeParse({ ...result, wallet: other }).success).toBe(false);
    expect(ReferralUseV1ResponseSchema.safeParse({ ...result, relationship: { ...relationship, createdAt: 'yesterday' } }).success).toBe(false);
  });
});
