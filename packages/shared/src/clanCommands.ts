/** Immutable management receipts. Subpath-only; no clan growth or tuning changes. */
import { z } from 'zod';

// PostgreSQL serializes UUIDs in lowercase. Reject aliases before any command so
// the persisted consent and a later byte-for-byte recovery comparison agree.
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Key = Uuid;
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Shards = z.string().refine((v) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n);
export const ClanCommandKeySchema = z.object({ key: Key }).strict();
export const ClanLeaveRequestSchema = z.object({
  idempotencyKey: Key, clanId: Uuid, baseId: Uuid.nullable(),
}).strict();
export const ClanKickRequestSchema = z.object({
  idempotencyKey: Key, clanId: Uuid, wallet: Wallet,
}).strict();
export const ClanCommandRefusalSchema = z.enum([
  'CLAN_CHANGED', 'CLAN_LEADER_NOT_ALONE', 'CLAN_NOT_LEADER', 'CLAN_SELF_KICK', 'CLAN_TARGET_ABSENT',
]);
export type ClanCommandRefusal = z.infer<typeof ClanCommandRefusalSchema>;
export type ClanLeaveRequest = z.infer<typeof ClanLeaveRequestSchema>;
export type ClanKickRequest = z.infer<typeof ClanKickRequestSchema>;

export const ClanCommandReceiptSchema = z.object({
  version: z.literal(1), actor: Wallet, idempotencyKey: Key,
  kind: z.enum(['leave', 'kick']), clanId: Uuid, baseId: Uuid.nullable(), target: Wallet.nullable(),
  state: z.enum(['left', 'disbanded', 'kicked', 'refused']),
  payoutShards: Shards, ledgerTransactionId: Uuid.nullable(),
  refusalCode: ClanCommandRefusalSchema.nullable(), createdAt: z.iso.datetime(),
}).strict().refine((r) => (r.kind === 'leave' ? r.target === null && r.state !== 'kicked'
  : r.baseId === null && r.target !== null && (r.state === 'kicked' || r.state === 'refused'))
  && (r.state === 'refused') === (r.refusalCode !== null)
  && (r.state === 'disbanded' ? (r.payoutShards !== '0') === (r.ledgerTransactionId !== null)
    : r.payoutShards === '0' && r.ledgerTransactionId === null), 'invalid clan command outcome');
export type ClanCommandReceipt = z.infer<typeof ClanCommandReceiptSchema>;
export const ClanCommandStatusSchema = z.object({
  version: z.literal(1), wallet: Wallet, idempotencyKey: Key, receipt: ClanCommandReceiptSchema.nullable(),
}).strict().refine((s) => s.receipt === null
  || (s.receipt.actor === s.wallet && s.receipt.idempotencyKey === s.idempotencyKey), 'receipt identity mismatch');
