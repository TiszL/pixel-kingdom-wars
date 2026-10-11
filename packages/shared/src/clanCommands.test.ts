import { describe, expect, it } from 'vitest';
import { ClanCommandReceiptSchema, ClanCommandStatusSchema, ClanKickRequestSchema, ClanLeaveRequestSchema } from './clanCommands';
const id = '00000000-0000-4000-8000-000000000001';
const wallet = '11111111111111111111111111111111';
const other = '22222222222222222222222222222222';
const receipt = { version: 1, actor: wallet, idempotencyKey: id, kind: 'leave', clanId: id, baseId: null, target: null,
  state: 'disbanded', payoutShards: '0', ledgerTransactionId: null, refusalCode: null, createdAt: '2026-09-13T00:00:00.000Z' };
describe('clan command proof contract', () => {
  it('requires explicit original clan/base consent and forbids an injected actor', () => {
    expect(ClanLeaveRequestSchema.parse({ idempotencyKey: id, clanId: id, baseId: null }).baseId).toBeNull();
    expect(ClanLeaveRequestSchema.safeParse({ idempotencyKey: id, clanId: id }).success).toBe(false);
    expect(ClanKickRequestSchema.safeParse({ idempotencyKey: id, clanId: id, wallet: other, actor: wallet }).success).toBe(false);
    const upper = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    for (const field of ['idempotencyKey', 'clanId', 'baseId']) {
      expect(ClanLeaveRequestSchema.safeParse({ idempotencyKey: id, clanId: id, baseId: null, [field]: upper }).success).toBe(false);
    }
  });
  it('distinguishes exact zero payout from missing evidence, and never accepts invented positive money', () => {
    expect(ClanCommandReceiptSchema.parse(receipt).payoutShards).toBe('0');
    expect(ClanCommandReceiptSchema.safeParse({ ...receipt, payoutShards: '1' }).success).toBe(false);
    expect(ClanCommandReceiptSchema.parse({ ...receipt, payoutShards: '1', ledgerTransactionId: id }).payoutShards).toBe('1');
    expect(ClanCommandReceiptSchema.safeParse({ ...receipt, payoutShards: '9223372036854775808', ledgerTransactionId: id }).success).toBe(false);
    expect(ClanCommandReceiptSchema.safeParse({ ...receipt, payoutShards: '01', ledgerTransactionId: id }).success).toBe(false);
    expect(ClanCommandReceiptSchema.safeParse({ ...receipt, state: 'left', payoutShards: '1', ledgerTransactionId: id }).success).toBe(false);
  });
  it('refuses mismatched actions, payout proof and indefinite refusals', () => {
    expect(ClanCommandReceiptSchema.safeParse({ ...receipt, state: 'kicked', target: other }).success).toBe(false);
    expect(ClanCommandReceiptSchema.safeParse({ ...receipt, kind: 'kick', state: 'kicked', target: other, baseId: id }).success).toBe(false);
    expect(ClanCommandReceiptSchema.safeParse({ ...receipt, state: 'refused' }).success).toBe(false);
    expect(ClanCommandReceiptSchema.parse({ ...receipt, state: 'refused', refusalCode: 'CLAN_CHANGED' }).state).toBe('refused');
  });
  it('keeps missing receipts inconclusive and positive reads strictly actor/key scoped', () => {
    const status = { version: 1, wallet, idempotencyKey: id, receipt: null };
    expect(ClanCommandStatusSchema.parse(status).receipt).toBeNull();
    expect(ClanCommandStatusSchema.safeParse({ ...status, wallet: other, receipt }).success).toBe(false);
    expect(ClanCommandStatusSchema.safeParse({ ...status, receipt, idempotencyKey: '00000000-0000-4000-8000-000000000002' }).success).toBe(false);
  });
});
