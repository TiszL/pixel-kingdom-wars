/** Workshop v1 wire proofs. Kept off the shared barrel and first-paint graph. */
import { z } from 'zod';
import { FORGE_INGOT } from './constants';

export const WORKSHOP_FEATURE = { version: 1, receipts: 1, allowance: 1 } as const;
const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Day = Timestamp.refine(v => v.endsWith('T00:00:00.000Z'));
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveCount = Count.refine(v => v > 0);
const Key = z.string().min(8).max(128);
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Public keys encode exactly 32 bytes; this is a wire bound, not a game number.
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).refine(v => {
  let value = 0n;
  for (const character of v) { const digit = alphabet.indexOf(character); if (digit < 0) return false; value = value * 58n + BigInt(digit); }
  let bytes = 0; while (value > 0n) { bytes++; value >>= 8n; }
  return bytes + (v.match(/^1*/)?.[0].length ?? 0) === 32;
});
const isAmount = (v: string) => /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
const Amount = z.string().refine(isAmount, 'expected a positive PostgreSQL int64 amount');
export const WorkshopCapacityScopeSchema = z.enum(['free_wallet', 'deed_base']);
const HistoricalScope = WorkshopCapacityScopeSchema.nullable().optional().default(null);
const priced = (ingots: number, shards: string) => Number.isSafeInteger(ingots) && isAmount(shards)
  && BigInt(ingots) * BigInt(FORGE_INGOT.shardsPerIngot) === BigInt(shards);
const remaining = (cap: number, used: number[]) => {
  if (![cap, ...used].every(Number.isSafeInteger)) return -1n;
  const difference = BigInt(cap) - used.reduce((total, n) => total + BigInt(n), 0n);
  return difference > 0n ? difference : 0n;
};

/** Request bodies are strict; new clients always name their start base. A
 * collect's job is in the path and its base is derived by the server. */
export const WorkshopStartRequestSchema = z.object({ baseId: Uuid, idempotencyKey: Key, ingots: PositiveCount, recipeVersion: PositiveCount }).strict()
  .refine(r => Number.isSafeInteger(r.ingots) && BigInt(r.ingots) * BigInt(FORGE_INGOT.shardsPerIngot) <= 9_223_372_036_854_775_807n, 'refining amount exceeds storage bounds');
export const WorkshopCollectRequestSchema = z.object({ idempotencyKey: Key }).strict();
export type WorkshopStartRequest = z.infer<typeof WorkshopStartRequestSchema>;
export type WorkshopCollectRequest = z.infer<typeof WorkshopCollectRequestSchema>;

export const WorkshopAllowanceSchema = z.object({
  version: z.literal(1), scope: WorkshopCapacityScopeSchema, day: Day, resetsAt: Day, capacityUnits: PositiveCount,
  daily: z.object({ cap: Count, used: Count, remaining: Count }),
  holding: z.object({ held: Count, pending: Count, listed: z.literal(0), reserved: z.literal(0), cap: Count, remaining: Count }),
}).refine(a => {
  if (!Number.isFinite(Date.parse(a.day))) return false;
  const next = new Date(a.day); next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString() === a.resetsAt && Number.isSafeInteger(a.daily.remaining) && Number.isSafeInteger(a.holding.remaining)
    && BigInt(a.daily.remaining) === remaining(a.daily.cap, [a.daily.used])
    && BigInt(a.holding.remaining) === remaining(a.holding.cap, [a.holding.held, a.holding.pending]);
}, 'incoherent Workshop allowance day or remaining units');
export type WorkshopAllowance = z.infer<typeof WorkshopAllowanceSchema>;

export const WorkshopJobSchema = z.object({
  jobId: Uuid, ingots: PositiveCount, shards: Amount, recipeVersion: PositiveCount, workshopLevel: PositiveCount,
  capacityScopeAtStart: HistoricalScope, startedAt: Timestamp, readyAt: Timestamp, ready: z.boolean(), collectedAt: Timestamp.nullable(),
}).refine(j => priced(j.ingots, j.shards) && Date.parse(j.readyAt) >= Date.parse(j.startedAt)
  && (j.collectedAt === null || j.ready && Date.parse(j.collectedAt) >= Date.parse(j.readyAt)), 'incoherent Workshop job proof');
export type WorkshopJob = z.infer<typeof WorkshopJobSchema>;
export const WorkshopViewSchema = z.object({
  features: z.object({ workshop: z.object({ version: z.literal(1), receipts: z.literal(1), allowance: z.literal(1) }) }),
  acceptingJobs: z.boolean(), level: Count, recipeVersion: PositiveCount, shardsPerIngot: z.literal(FORGE_INGOT.shardsPerIngot),
  batch: z.object({ size: Count, max: PositiveCount }), secPerIngot: PositiveCount.nullable(),
  inventory: z.object({ baseId: Uuid, held: Count, pending: Count }), allowance: WorkshopAllowanceSchema,
  dailyRefineCap: Count, refinedToday: Count,
  holding: z.object({ held: Count, listed: z.literal(0), reserved: z.literal(0), inProgress: Count, cap: Count }),
  capacity: PositiveCount, jobs: z.array(WorkshopJobSchema), serverNow: Timestamp,
}).refine(v => {
  if (!Number.isFinite(Date.parse(v.serverNow))) return false;
  const now = Date.parse(v.serverNow), day = new Date(v.serverNow); day.setUTCHours(0, 0, 0, 0);
  return v.allowance.day === day.toISOString() && v.batch.size <= v.batch.max
    && (v.level === 0 ? v.batch.size === 0 && v.secPerIngot === null : v.batch.size > 0 && v.secPerIngot !== null)
    && v.capacity === v.allowance.capacityUnits && v.dailyRefineCap === v.allowance.daily.cap && v.holding.cap === v.allowance.holding.cap
    && v.inventory.held === v.holding.held && v.inventory.pending === v.holding.inProgress
    && (v.allowance.scope !== 'deed_base' || v.refinedToday === v.allowance.daily.used
      && v.inventory.held === v.allowance.holding.held && v.inventory.pending === v.allowance.holding.pending)
    && new Set(v.jobs.map(j => j.jobId)).size === v.jobs.length
    && v.jobs.every(j => Date.parse(j.startedAt) <= now && j.ready === (Date.parse(j.readyAt) <= now)
      && (j.collectedAt === null || Date.parse(j.collectedAt) <= now));
}, 'incoherent selected-base Workshop view');
export type WorkshopView = z.infer<typeof WorkshopViewSchema>;

/** Mutation acknowledgements are useful for display; by-key receipts prove the
 * original authenticated command after an acknowledgement is lost. */
export const WorkshopStartResultSchema = z.object({
  jobId: Uuid, baseId: Uuid, ingots: PositiveCount, shardsCharged: Amount, recipeVersion: PositiveCount,
  workshopLevel: PositiveCount, capacityScopeAtStart: HistoricalScope, startedAt: Timestamp, readyAt: Timestamp,
  receiptId: Uuid, duplicate: z.boolean(), serverNow: Timestamp,
}).refine(r => priced(r.ingots, r.shardsCharged) && Date.parse(r.startedAt) <= Date.parse(r.serverNow)
  && Date.parse(r.readyAt) >= Date.parse(r.startedAt), 'incoherent start acknowledgement');
export const WorkshopCollectResultSchema = z.object({ jobId: Uuid, baseId: Uuid, ingotsCredited: PositiveCount, held: Count,
  collectedAt: Timestamp, duplicate: z.boolean(), serverNow: Timestamp,
}).refine(r => Date.parse(r.collectedAt) <= Date.parse(r.serverNow), 'collection is newer than its response');
export type WorkshopStartResult = z.infer<typeof WorkshopStartResultSchema>;
export type WorkshopCollectResult = z.infer<typeof WorkshopCollectResultSchema>;

const Unknown = z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: Key });
export const WorkshopAcceptedStartReceiptSchema = z.object({
  version: z.literal(1), status: z.literal('accepted'), wallet: Wallet, baseId: Uuid, jobId: Uuid,
  ingots: PositiveCount, shardsCharged: Amount, recipeVersion: PositiveCount, workshopLevelAtStart: PositiveCount,
  capacityScopeAtStart: HistoricalScope, startedAt: Timestamp, readyAt: Timestamp, receiptId: Uuid, acceptedAt: Timestamp,
}).refine(r => priced(r.ingots, r.shardsCharged) && Date.parse(r.readyAt) >= Date.parse(r.startedAt), 'incoherent original refining debit');
export const WorkshopAcceptedCollectReceiptSchema = z.object({
  version: z.literal(1), status: z.literal('accepted'), wallet: Wallet, baseId: Uuid, jobId: Uuid,
  ingotsCredited: PositiveCount, collectedAt: Timestamp, receiptId: Uuid,
}).refine(r => r.receiptId === r.jobId, 'collection receipt must name its original job');
export const WorkshopStartReceiptSchema = z.discriminatedUnion('status', [Unknown, WorkshopAcceptedStartReceiptSchema]);
export const WorkshopCollectReceiptSchema = z.discriminatedUnion('status', [Unknown, WorkshopAcceptedCollectReceiptSchema]);
export type WorkshopStartReceipt = z.infer<typeof WorkshopStartReceiptSchema>;
export type WorkshopCollectReceipt = z.infer<typeof WorkshopCollectReceiptSchema>;
const Envelope = { wallet: Wallet, idempotencyKey: Key, status: z.enum(['unknown', 'accepted']), serverNow: Timestamp };
export const WorkshopStartEnvelopeSchema = z.object({ ...Envelope, receipt: WorkshopAcceptedStartReceiptSchema.nullable() }).refine(r =>
  r.status === 'unknown' ? r.receipt === null : r.receipt !== null && r.receipt.wallet === r.wallet
    && Date.parse(r.receipt.acceptedAt) <= Date.parse(r.serverNow) && Date.parse(r.receipt.startedAt) <= Date.parse(r.serverNow), 'start receipt identity/status mismatch');
export const WorkshopCollectEnvelopeSchema = z.object({ ...Envelope, receipt: WorkshopAcceptedCollectReceiptSchema.nullable() }).refine(r =>
  r.status === 'unknown' ? r.receipt === null : r.receipt !== null && r.receipt.wallet === r.wallet
    && Date.parse(r.receipt.collectedAt) <= Date.parse(r.serverNow), 'collect receipt identity/status mismatch');
export type WorkshopStartEnvelope = z.infer<typeof WorkshopStartEnvelopeSchema>;
export type WorkshopCollectEnvelope = z.infer<typeof WorkshopCollectEnvelopeSchema>;

/** Envelope keys are the only wire key on accepted receipts. Match saved
 * consent explicitly; a valid receipt for another base/key is never success. */
export function matchWorkshopStartEnvelope(raw: unknown, expected: { wallet: string; request: WorkshopStartRequest }): WorkshopStartEnvelope {
  const envelope = WorkshopStartEnvelopeSchema.parse(raw), request = WorkshopStartRequestSchema.parse(expected.request), receipt = envelope.receipt;
  if (envelope.wallet !== expected.wallet || envelope.idempotencyKey !== request.idempotencyKey
    || receipt && (receipt.baseId !== request.baseId || receipt.ingots !== request.ingots || receipt.recipeVersion !== request.recipeVersion)) throw new Error('Workshop start proof differs from the original request.');
  return envelope;
}
export function matchWorkshopCollectEnvelope(raw: unknown, expected: { wallet: string; baseId: string; jobId: string; request: WorkshopCollectRequest }): WorkshopCollectEnvelope {
  const envelope = WorkshopCollectEnvelopeSchema.parse(raw), request = WorkshopCollectRequestSchema.parse(expected.request), receipt = envelope.receipt;
  Uuid.parse(expected.baseId); Uuid.parse(expected.jobId);
  if (envelope.wallet !== expected.wallet || envelope.idempotencyKey !== request.idempotencyKey
    || receipt && (receipt.baseId !== expected.baseId || receipt.jobId !== expected.jobId)) throw new Error('Workshop collect proof differs from the original job.');
  return envelope;
}
