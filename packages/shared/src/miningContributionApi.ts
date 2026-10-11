/** D153.199 ordinary resource commitment. No client-selected epoch or price.
 * A reviewed UTC day is a stale-consent guard; the server chooses the epoch. */
import { z } from 'zod';
import { PHASE_E_MINING_CONTRIBUTION_V2 as POLICY, PHASE_E_MINING_CONTRIBUTION_V3 as POLICY_V3 } from './constants';
import { MINING_CONTRIBUTION_RESOURCE_IDS_V3, miningContributionResourceIds, MiningContributionLineSchema, MiningContributionResourceSchema,
  miningResourceUnitValue, valueMiningContribution } from './miningContribution';
import { RawResourceQuantitySchema, RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';

export const MiningContributionUuidSchema = z.uuid().regex(/^[0-9a-f-]+$/);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Timestamp = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const at = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
});
const maxValue = RAW_RESOURCE_STORAGE_MAX * MINING_CONTRIBUTION_RESOURCE_IDS_V3.reduce((sum, id) => sum + miningResourceUnitValue(id, POLICY_V3.version), 0n);
const Value = z.string().regex(/^(0|[1-9][0-9]{0,31})$/).refine(value => /^(0|[1-9][0-9]{0,31})$/.test(value) && BigInt(value) <= maxValue);
const basket = z.array(MiningContributionLineSchema).min(1).max(MINING_CONTRIBUTION_RESOURCE_IDS_V3.length)
  .refine(lines => new Set(lines.map(line => line.resourceId)).size === lines.length, 'Duplicate resource in mining basket');
export const MiningContributionRequestSchema = z.object({ idempotencyKey: MiningContributionUuidSchema,
  baseId: MiningContributionUuidSchema, policyVersion: z.union([z.literal(POLICY.version), z.literal(POLICY_V3.version)]), expectedDay: Day, lines: basket,
}).strict().refine(request => request.lines.every(line => (miningContributionResourceIds(request.policyVersion) as readonly string[]).includes(line.resourceId)), 'Mining basket differs from its immutable policy catalogue');
export type MiningContributionRequest = z.infer<typeof MiningContributionRequestSchema>;

const valuedLine = MiningContributionLineSchema.extend({ unitValue: Value, value: Value }).strict();
export const MiningContributionReceiptSchema = z.object({ id: MiningContributionUuidSchema, epochId: MiningContributionUuidSchema,
  wallet: Wallet, day: Day, request: MiningContributionRequestSchema,
  lines: z.array(valuedLine).min(1).max(MINING_CONTRIBUTION_RESOURCE_IDS_V3.length), totalValue: Value, createdAt: Timestamp,
}).strict().refine(receipt => {
  try {
  const valued = valueMiningContribution(receipt.request.lines, receipt.request.policyVersion);
  return receipt.id === receipt.request.idempotencyKey && receipt.day === receipt.request.expectedDay
    && receipt.createdAt.slice(0, 10) === receipt.day && receipt.totalValue === valued.totalValue
    && JSON.stringify(receipt.lines) === JSON.stringify(valued.lines);
  } catch { return false; }
}, 'Mining receipt differs from original contribution');
export type MiningContributionReceipt = z.infer<typeof MiningContributionReceiptSchema>;

const envelope = { wallet: Wallet, idempotencyKey: MiningContributionUuidSchema, serverNow: Timestamp };
export const MiningContributionEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ ...envelope, status: z.literal('unknown'), receipt: z.null(), settlement: z.null() }).strict(),
  z.object({ ...envelope, status: z.literal('accepted'), receipt: MiningContributionReceiptSchema,
    settlement: z.object({ outcome: z.enum(['consumed', 'returned']), settledAt: Timestamp }).strict().nullable() }).strict(),
]).refine(value => value.status === 'unknown' || value.wallet === value.receipt.wallet
  && value.idempotencyKey === value.receipt.id && (value.settlement === null
    || Date.parse(value.settlement.settledAt) >= Date.parse(value.receipt.createdAt)), 'Mining recovery identity or terminal time differs');
export type MiningContributionEnvelope = z.infer<typeof MiningContributionEnvelopeSchema>;

export const MiningContributionViewQuerySchema = z.object({ baseId: MiningContributionUuidSchema, catalogueVersion: z.literal('3').optional() }).strict();

export const MiningContributionViewSchema = z.object({ wallet: Wallet, baseId: MiningContributionUuidSchema,
  policyVersion: z.union([z.literal(POLICY.version), z.literal(POLICY_V3.version)]), day: Day, serverNow: Timestamp, acceptingContributions: z.boolean(),
  pool: z.enum(['free', 'deed']), dailyCapValue: Value.nullable(), committedValue: Value, remainingValue: Value.nullable(),
  developmentReady: z.boolean(),
  resources: z.array(z.object({ resourceId: MiningContributionResourceSchema, available: RawResourceQuantitySchema, unitValue: Value }).strict()),
  consistency: z.object({ windowDays: z.number().int().positive().safe(), bonusPerQualifiedDayBps: z.number().int().positive().safe(), maximumBonusBps: z.number().int().positive().safe() }).strict(),
}).strict().refine(view => {
  try {
  const ids = miningContributionResourceIds(view.policyVersion);
  const versionMaxValue = RAW_RESOURCE_STORAGE_MAX * ids.reduce((sum, id) => sum + miningResourceUnitValue(id, view.policyVersion), 0n);
  if (BigInt(view.committedValue) > versionMaxValue
    || view.dailyCapValue !== null && BigInt(view.dailyCapValue) > versionMaxValue
    || view.remainingValue !== null && BigInt(view.remainingValue) > versionMaxValue
    || view.serverNow.slice(0, 10) !== view.day || view.resources.length !== ids.length
    || ids.some(id => view.resources.filter(row => row.resourceId === id).length !== 1)
    || view.resources.some(row => !(ids as readonly string[]).includes(row.resourceId) || row.unitValue !== String(miningResourceUnitValue(row.resourceId, view.policyVersion)))
    || view.consistency.windowDays !== POLICY.consistencyWindowDays || view.consistency.bonusPerQualifiedDayBps !== POLICY.consistencyBonusPerDayBps
    || view.consistency.maximumBonusBps !== POLICY.consistencyWindowDays * POLICY.consistencyBonusPerDayBps) return false;
  if (view.pool === 'deed') return view.dailyCapValue === null && view.remainingValue === null;
  return view.dailyCapValue === String(POLICY.freeValuePerWalletDay) && view.remainingValue !== null
    && BigInt(view.remainingValue) === (BigInt(view.committedValue) >= BigInt(POLICY.freeValuePerWalletDay)
      ? 0n : BigInt(POLICY.freeValuePerWalletDay) - BigInt(view.committedValue));
  } catch { return false; }
}, 'Mining view has inconsistent policy, inventory or wallet allowance');
export type MiningContributionView = z.infer<typeof MiningContributionViewSchema>;

export function matchMiningContributionEnvelope(raw: unknown, wallet: string, original: MiningContributionRequest): MiningContributionEnvelope {
  const request = MiningContributionRequestSchema.parse(original), proof = MiningContributionEnvelopeSchema.parse(raw);
  if (proof.wallet !== wallet || proof.idempotencyKey !== request.idempotencyKey
    || proof.status === 'accepted' && JSON.stringify(proof.receipt.request) !== JSON.stringify(request)) throw Error('Mining receipt differs from original command');
  return proof;
}
