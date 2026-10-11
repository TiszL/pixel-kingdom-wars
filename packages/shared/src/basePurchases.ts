/** Versioned SOL-paid base improvements. Quotes and accepted funding survive deed transfer. */
import { z } from 'zod';
import { CAPS, STRUCTURES } from './constants';
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const PublicKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const isAmount = (v: string) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const Amount = z.string().refine(isAmount);
const SafeLamports = Amount.refine(v => isAmount(v) && BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
// PostgreSQL energy storage uses a signed int; this is a serialization bound, not a gameplay cap.
const EnergyQuantity = z.number().int().positive().max(2_147_483_647);
const identity = { idempotencyKey: Uuid, baseId: Uuid };
export const BasePurchaseKeySchema = z.object({ key: Uuid }).strict();
export const BasePurchaseRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...identity, kind: z.literal('energy') }).strict(),
  z.object({ ...identity, kind: z.literal('energy_pack') }).strict(),
  z.object({ ...identity, kind: z.literal('shield') }).strict(),
  z.object({ ...identity, kind: z.literal('warzone_shield') }).strict(),
  z.object({ ...identity, kind: z.literal('builder'), expectedBuilders: z.number().int().min(1).max(CAPS.buildersMax - 1) }).strict(),
  z.object({ ...identity, kind: z.literal('expansion'), expectedExpansions: z.number().int().min(0).max(CAPS.expansionsMax - 1) }).strict(),
  z.object({ ...identity, kind: z.literal('mine'), buildingId: Uuid, buildingType: z.enum(['mine', 'goldforge']),
    fromLevel: z.number().int().min(1).max(Math.max(STRUCTURES.mine.maxLevel, STRUCTURES.goldforge.maxLevel) - 1),
    toLevel: z.number().int().min(2).max(Math.max(STRUCTURES.mine.maxLevel, STRUCTURES.goldforge.maxLevel)), maxCostShards: Amount,
  }).strict().refine(r => r.toLevel === r.fromLevel + 1 && r.toLevel <= STRUCTURES[r.buildingType].maxLevel),
]);
export type BasePurchaseRequest = z.infer<typeof BasePurchaseRequestSchema>;
export const BasePurchaseNetworkSchema = z.object({
  cluster: z.enum(['devnet', 'mainnet-beta']), coreProgram: PublicKey, configPda: PublicKey,
  treasuryLiquidity: PublicKey, treasuryDev: PublicKey, treasuryOps: PublicKey,
  systemProgram: z.literal('11111111111111111111111111111111'),
}).strict();
export type BasePurchaseNetwork = z.infer<typeof BasePurchaseNetworkSchema>;
export const BasePurchaseEnergyQuerySchema = z.object({ kind: z.enum(['energy', 'energy_pack']) }).strict();
export const BasePurchaseShieldQuerySchema = z.object({ kind: z.enum(['shield', 'warzone_shield']) }).strict();
export const BasePurchaseRailSchema = z.discriminatedUnion('mode', [
  BasePurchaseNetworkSchema.extend({ mode: z.literal('buy_sink'), sinkKind: z.union([z.literal(8), z.literal(4), z.literal(3), z.literal(7)]), destination: z.null() }).strict(),
  BasePurchaseNetworkSchema.extend({ mode: z.literal('warzone_split'), sinkKind: z.literal(6), destination: PublicKey,
    directLamports: SafeLamports, splitLamports: SafeLamports }).strict(),
  BasePurchaseNetworkSchema.extend({ mode: z.literal('sol_transfer'), sinkKind: z.null(), destination: PublicKey }).strict(),
]);
export const BasePurchaseQuoteSchema = z.object({
  version: z.literal(1), depositId: Uuid, wallet: PublicKey, request: BasePurchaseRequestSchema,
  baseEpoch: z.object({ landPaidAt: Timestamp, deedAssetId: PublicKey.nullable() }).strict(),
  reference: PublicKey, amountLamports: SafeLamports, quotedCostShards: Amount.nullable(),
  energyQuantity: EnergyQuantity.optional(),
  rail: BasePurchaseRailSchema, createdAt: Timestamp, payableUntil: Timestamp, retryAt: Timestamp,
}).strict().refine(q => Date.parse(q.createdAt) < Date.parse(q.payableUntil) && Date.parse(q.payableUntil) < Date.parse(q.retryAt)
  && (q.request.kind === 'builder' || q.request.kind === 'shield'
    ? q.rail.mode === 'buy_sink' && q.rail.sinkKind === (q.request.kind === 'builder' ? 8 : 4)
    : q.request.kind === 'energy' || q.request.kind === 'energy_pack'
      ? q.rail.mode === 'buy_sink' && q.rail.sinkKind === (q.request.kind === 'energy' ? 3 : 7)
    : q.request.kind === 'warzone_shield' ? q.rail.mode === 'warzone_split' && q.rail.destination === q.rail.treasuryLiquidity
      && isAmount(q.rail.directLamports) && isAmount(q.rail.splitLamports) && isAmount(q.amountLamports)
      && BigInt(q.rail.directLamports) + BigInt(q.rail.splitLamports) === BigInt(q.amountLamports)
    : q.rail.mode === 'sol_transfer' && q.rail.destination === q.rail.treasuryLiquidity)
  && (q.request.kind === 'energy' || q.request.kind === 'energy_pack' ? q.energyQuantity !== undefined : q.energyQuantity === undefined)
  && (q.request.kind === 'mine' ? q.quotedCostShards !== null && isAmount(q.quotedCostShards) && isAmount(q.request.maxCostShards)
    && BigInt(q.quotedCostShards) <= BigInt(q.request.maxCostShards) : q.quotedCostShards === null));
export type BasePurchaseQuote = z.infer<typeof BasePurchaseQuoteSchema>;
export const BasePurchaseReceiptSchema = z.object({
  version: z.literal(1), depositId: Uuid, acceptedAt: Timestamp, txSignature: Signature, amountLamports: SafeLamports,
  energy: z.object({ quantity: EnergyQuantity }).strict().optional(),
  shield: z.object({ granted: z.boolean(), expiresAt: Timestamp.nullable() }).strict().optional(),
  shards: z.object({ receiptId: Uuid, currency: z.literal('SHARDS'), amount: Amount }).strict().nullable(),
}).strict();
export const BasePurchaseStateSchema = z.object({
  quote: BasePurchaseQuoteSchema, status: z.enum(['pending', 'credited', 'expired', 'failed']),
  paymentSignature: Signature.nullable(), txSignature: Signature.nullable(), amount: Amount.nullable(), finalizedAt: Timestamp.nullable(),
  receipt: BasePurchaseReceiptSchema.nullable(),
}).strict().refine(s => s.status === 'credited' ? s.receipt !== null && s.receipt.depositId === s.quote.depositId
  && s.receipt.txSignature === s.txSignature && s.receipt.acceptedAt === s.finalizedAt && s.receipt.amountLamports === s.quote.amountLamports
  && (s.paymentSignature === null || s.paymentSignature === s.txSignature)
  && (s.quote.request.kind === 'energy' || s.quote.request.kind === 'energy_pack'
    ? s.receipt.energy?.quantity === s.quote.energyQuantity : s.receipt.energy === undefined)
  && (s.quote.request.kind === 'shield' || s.quote.request.kind === 'warzone_shield'
    ? s.receipt.shield !== undefined && (!s.receipt.shield.granted || s.receipt.shield.expiresAt !== null
      && Date.parse(s.receipt.shield.expiresAt) > Date.parse(s.receipt.acceptedAt))
      && (s.quote.request.kind !== 'warzone_shield' || s.receipt.shield.granted) : s.receipt.shield === undefined)
  && s.amount === s.quote.amountLamports && (s.quote.request.kind === 'mine'
    ? s.receipt.shards !== null && isAmount(s.receipt.shards.amount) && isAmount(s.quote.request.maxCostShards)
      && BigInt(s.receipt.shards.amount) <= BigInt(s.quote.request.maxCostShards) : s.receipt.shards === null)
  : s.receipt === null && (s.status === 'failed'
    ? s.txSignature !== null && s.amount !== null && s.finalizedAt !== null
      && (s.paymentSignature === null || s.paymentSignature === s.txSignature)
    : s.txSignature === null && s.amount === null && s.finalizedAt === null
      && (s.status !== 'expired' || s.paymentSignature === null)));
export const BasePurchaseStatusSchema = z.object({
  version: z.literal(1), wallet: PublicKey, idempotencyKey: Uuid, enabled: z.boolean(), serverNow: Timestamp,
  purchase: BasePurchaseStateSchema.nullable(),
}).strict().refine(s => !s.purchase || s.purchase.quote.wallet === s.wallet && s.purchase.quote.request.idempotencyKey === s.idempotencyKey);
export type BasePurchaseStatus = z.infer<typeof BasePurchaseStatusSchema>;

/** Cancels only a command with no quote; a quoted payment is returned unchanged. */
export const BasePurchaseCancellationSchema = z.object({
  version: z.literal(1), wallet: PublicKey, idempotencyKey: Uuid, cancelled: z.boolean(),
  purchase: BasePurchaseStateSchema.nullable(),
}).strict().refine(s => s.cancelled ? s.purchase === null : s.purchase !== null
  && s.purchase.quote.wallet === s.wallet && s.purchase.quote.request.idempotencyKey === s.idempotencyKey);
export type BasePurchaseCancellation = z.infer<typeof BasePurchaseCancellationSchema>;
