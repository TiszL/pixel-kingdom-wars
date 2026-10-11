/** Exact accepted wall stroke; current wall positions/ownership are not receipt evidence. */
import { z } from 'zod';
import { PLOT_GEOMETRY, WALL_BATCH } from './constants';
import { plotBounds } from './plotGeometry';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const plot = plotBounds(PLOT_GEOMETRY.currentVersion);
// Wire/receipt admission covers supported plots; the server still checks the
// selected base's actual unlocked claim before accepting a stroke or debit.
const Tile = z.number().int().min(plot.min).max(plot.max - 1);
const isAmount = (v: string) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
const Amount = z.string().refine(isAmount);
export const WallBatchKeySchema = z.object({ key: Uuid }).strict();
export const WallBatchRequestSchema = z.object({
  idempotencyKey: Uuid, baseId: Uuid.nullable(),
  tiles: z.array(z.object({ tx: Tile, ty: Tile }).strict()).min(1).max(WALL_BATCH.maxTiles),
  maxCostShards: Amount,
}).strict().refine(r => new Set(r.tiles.map(t => `${t.tx},${t.ty}`)).size === r.tiles.length, 'duplicate wall tiles');
export type WallBatchRequest = z.infer<typeof WallBatchRequestSchema>;
export const WallBatchReceiptSchema = z.object({
  version: z.literal(1), actor: Wallet, idempotencyKey: Uuid, request: WallBatchRequestSchema,
  receiptId: Uuid, acceptedAt: z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v),
  funding: z.object({ currency: z.literal('SHARDS'), amount: Amount }).strict(),
}).strict().refine(r => r.idempotencyKey === r.request.idempotencyKey
  && isAmount(r.funding.amount) && isAmount(r.request.maxCostShards)
  && BigInt(r.funding.amount) <= BigInt(r.request.maxCostShards), 'wall funding disagrees with consent');
export type WallBatchReceipt = z.infer<typeof WallBatchReceiptSchema>;
export const WallBatchStatusSchema = z.object({
  version: z.literal(1), wallet: Wallet, idempotencyKey: Uuid, enabled: z.boolean(), receipt: WallBatchReceiptSchema.nullable(),
}).strict().refine(r => !r.receipt || (r.receipt.actor === r.wallet && r.receipt.idempotencyKey === r.idempotencyKey), 'wall receipt identity mismatch');
