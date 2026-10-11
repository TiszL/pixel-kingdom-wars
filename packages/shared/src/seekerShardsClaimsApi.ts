/** Original-term SHARDS tax rights and exact ledger receipt recovery. Subpath
 * only. Parsing is a consistency check, never source/payout/current-base authority.
 * Raw-resource claims keep their separate shardsIncluded:false contract. */
import { z } from 'zod';
import { PHASE_E_POLICY } from './constants';
import { RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function address(value: string): boolean {
 if (value.length < 32 || value.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
 let n = 0n; for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
 let bytes = 0; while (n) { bytes++; n >>= 8n; }
 return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
function quantity(value: string): bigint | null {
 if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) return null;
 const n = BigInt(value); return n <= RAW_RESOURCE_STORAGE_MAX ? n : null;
}
const Wallet = z.string().max(44).refine(address), Id = z.string().uuid().transform(v => v.toLowerCase());
const Hash = z.string().regex(/^[0-9a-f]{64}$/), Amount = z.string().max(19).refine(v => quantity(v) !== null);
const Iso = z.string().length(24).refine(v => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Spot = z.number().int().min(0).max(PHASE_E_POLICY.seekerIsland.totalSpots - 1);
const Winners = z.number().int().min(1).max(PHASE_E_POLICY.seekerIsland.totalSpots);
const issue = (ctx: z.RefinementCtx, message: string) => ctx.addIssue({ code: 'custom', message });
export const SeekerShardsClaimRequestSchema = z.object({ idempotencyKey: Id, baseId: Id, termId: Id,
 spotId: Spot }).strict();
export const SeekerShardsClaimReceiptSchema = SeekerShardsClaimRequestSchema.extend({
 id: Id, wallet: Wallet, termHash: Hash, winnerCount: Winners, poolTotal: Amount, previousTotal: Amount,
 cumulativeTotal: Amount, quantity: Amount, balanceBefore: Amount, balanceAfter: Amount, claimedAt: Iso, currency: z.literal('SHARDS'), ledgerTransactionId: Id,
}).strict().superRefine((v, ctx) => {
 const values = [v.poolTotal, v.previousTotal, v.cumulativeTotal, v.quantity, v.balanceBefore, v.balanceAfter].map(quantity);
 if (values.some(n => n === null) || !Number.isInteger(v.winnerCount) || v.winnerCount < 1) return;
 const [pool, previous, cumulative, paid, before, after] = values as bigint[];
 if (v.id !== v.idempotencyKey || paid! <= 0n || previous! + paid! !== cumulative || before! + paid! !== after
  || pool! / BigInt(v.winnerCount) !== cumulative) issue(ctx, 'inconsistent original SHARDS claim');
});
export const SeekerShardsClaimEnvelopeSchema = z.object({ wallet: Wallet, receipt: SeekerShardsClaimReceiptSchema.nullable() }).strict()
 .superRefine((v, ctx) => { if (v.receipt && v.receipt.wallet !== v.wallet) issue(ctx, 'receipt recipient differs'); });
export const SeekerShardsEntitlementQuerySchema = z.object({ cursor: Id.optional() }).strict();
const Row = z.object({ termId: Id, termHash: Hash, startsAt: Iso, endsAt: Iso, spotId: Spot,
 winnerCount: Winners, poolTotal: Amount, cumulativeTotal: Amount,
 claimedTotal: Amount, dueQuantity: Amount }).strict().superRefine((v, ctx) => {
 if (Date.parse(v.endsAt) - Date.parse(v.startsAt) !== PHASE_E_POLICY.seekerIsland.operatingTermSec * 1000) issue(ctx, 'invalid original term interval');
 const values = [v.poolTotal, v.cumulativeTotal, v.claimedTotal, v.dueQuantity].map(quantity);
 if (values.some(n => n === null) || !Number.isInteger(v.winnerCount) || v.winnerCount < 1) return;
 const [pool, cumulative, claimed, due] = values as bigint[];
 if (pool === 0n || pool! / BigInt(v.winnerCount) !== cumulative || claimed! > cumulative! || cumulative! - claimed! !== due)
  issue(ctx, 'inconsistent remaining SHARDS rights');
});
/** UUID order is a browse position, not a permanent completion watermark.
 * Refresh from null to discover newly retained terms earlier in UUID order.
 * Empty pages may still have nextCursor. No destination base is required. */
export const SeekerShardsEntitlementViewSchema = z.object({ version: z.literal(1), wallet: Wallet, claimsEnabled: z.boolean(),
 currency: z.literal('SHARDS'), status: z.enum(['available', 'unavailable']), reason: z.enum(['SOURCE_BOUNDS', 'SOURCE_INTEGRITY']).nullable(),
 cursor: Id.nullable(), nextCursor: Id.nullable(), rows: z.array(Row).max(PHASE_E_POLICY.seekerIsland.totalSpots),
}).strict().superRefine((v, ctx) => {
 if (v.status === 'unavailable') {
  if (v.reason === null || v.rows.length !== 0 || v.nextCursor !== null) issue(ctx, 'unavailable source has no amounts or continuation');
  return;
 }
 if (v.reason !== null || v.nextCursor !== null && v.cursor !== null && v.nextCursor <= v.cursor) issue(ctx, 'invalid page continuation');
 const first = v.rows[0];
 for (let i = 0; i < v.rows.length; i++) {
  const row = v.rows[i]!, prev = v.rows[i - 1];
  if (first && (row.termId !== first.termId || row.termHash !== first.termHash || row.startsAt !== first.startsAt
   || row.endsAt !== first.endsAt || row.winnerCount !== first.winnerCount || row.poolTotal !== first.poolTotal
   || row.cumulativeTotal !== first.cumulativeTotal)) issue(ctx, 'page contains inconsistent original terms');
  if (v.cursor !== null && row.termId <= v.cursor || v.nextCursor !== null && row.termId > v.nextCursor) issue(ctx, 'row is outside its page');
  if (prev && (row.spotId <= prev.spotId)) issue(ctx, 'rows must be unique and ordered');
 }
});
export type SeekerShardsClaimRequest = z.infer<typeof SeekerShardsClaimRequestSchema>;
export type SeekerShardsClaimReceipt = z.infer<typeof SeekerShardsClaimReceiptSchema>;
export type SeekerShardsClaimEnvelope = z.infer<typeof SeekerShardsClaimEnvelopeSchema>;
export type SeekerShardsEntitlementView = z.infer<typeof SeekerShardsEntitlementViewSchema>;

export function matchSeekerShardsClaimReceipt(value: unknown, wallet: string, request: SeekerShardsClaimRequest): SeekerShardsClaimReceipt {
 const receipt = SeekerShardsClaimReceiptSchema.parse(value), expected = SeekerShardsClaimRequestSchema.parse(request);
 if (receipt.wallet !== Wallet.parse(wallet) || receipt.idempotencyKey !== expected.idempotencyKey || receipt.baseId !== expected.baseId
  || receipt.termId !== expected.termId || receipt.spotId !== expected.spotId) throw new Error('SHARDS claim receipt does not match its request');
 return receipt;
}
export function matchSeekerShardsClaimEnvelope(value: unknown, wallet: string, request?: SeekerShardsClaimRequest): SeekerShardsClaimEnvelope {
 const envelope = SeekerShardsClaimEnvelopeSchema.parse(value);
 if (envelope.wallet !== Wallet.parse(wallet)) throw new Error('SHARDS claim envelope recipient differs');
 if (envelope.receipt && request) matchSeekerShardsClaimReceipt(envelope.receipt, wallet, request);
 return envelope;
}
export function matchSeekerShardsEntitlementView(value: unknown, wallet: string, cursor: string | null = null): SeekerShardsEntitlementView {
 const view = SeekerShardsEntitlementViewSchema.parse(value);
 if (view.wallet !== Wallet.parse(wallet) || view.cursor !== (cursor === null ? null : Id.parse(cursor))) throw new Error('SHARDS entitlement page scope differs');
 return view;
}
