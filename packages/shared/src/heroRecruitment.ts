/** Accepted altar construction, preserving original consent and actual funding. */
import { z } from 'zod';
import { HEROES, HERO_KEYS, PLOT_GEOMETRY } from './constants';
import { plotBounds } from './plotGeometry';

const Uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const plot = plotBounds(PLOT_GEOMETRY.currentVersion);
const Tile = z.number().int().min(plot.min).max(plot.max - 1);
const Altar = z.enum(['heroaltar', 'siegestool']);
const isAmount = (v: string) => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const Amount = z.string().refine(isAmount);
export const HeroRecruitmentKeySchema = z.object({ key: Uuid }).strict();
export const HeroRecruitmentRequestSchema = z.object({
  idempotencyKey: Uuid, baseId: Uuid.nullable(), type: Altar, tx: Tile, ty: Tile,
  heroContractOnly: z.boolean(), maxCostKeep: Amount,
}).strict().refine(r => r.heroContractOnly ? r.maxCostKeep === '0' : r.maxCostKeep !== '0', 'invalid recruitment funding consent');
export type HeroRecruitmentRequest = z.infer<typeof HeroRecruitmentRequestSchema>;
export const HeroRecruitmentFundingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contract'), itemId: z.string(), itemUseId: Uuid, sourceBaseId: Uuid.nullable(), quantity: z.literal(1) }).strict(),
  z.object({ kind: z.literal('keep'), amount: Amount.refine(v => v !== '0'), ledgerTransactionId: Uuid }).strict(),
  // D-152: the same fee paid in Gems (1:1, so `maxCostKeep` consent still bounds it).
  z.object({ kind: z.literal('gems'), amount: Amount.refine(v => v !== '0'), ledgerTransactionId: Uuid }).strict(),
]);
export type HeroRecruitmentFunding = z.infer<typeof HeroRecruitmentFundingSchema>;
export const HeroRecruitmentReceiptSchema = z.object({
  version: z.literal(1), actor: Wallet, idempotencyKey: Uuid, request: HeroRecruitmentRequestSchema,
  hero: z.enum(HERO_KEYS),
  building: z.object({ id: Uuid, baseId: Uuid.nullable(), type: Altar, level: z.literal(1), tx: Tile, ty: Tile }).strict(),
  job: z.object({ id: Uuid, buildingId: Uuid, startedAt: z.iso.datetime(), finishesAt: z.iso.datetime() }).strict(),
  funding: HeroRecruitmentFundingSchema, createdAt: z.iso.datetime(),
}).strict().refine(r => {
  const request = r.request;
  if (r.idempotencyKey !== request.idempotencyKey || HEROES[r.hero].altar !== request.type
    || r.building.type !== request.type || r.building.baseId !== request.baseId
    || r.building.tx !== request.tx || r.building.ty !== request.ty
    || r.job.buildingId !== r.building.id || Date.parse(r.job.finishesAt) < Date.parse(r.job.startedAt)) return false;
  return r.funding.kind === 'contract'
    ? r.funding.itemId === HEROES[r.hero].recruitItemId
      && (r.funding.sourceBaseId === null || r.funding.sourceBaseId === request.baseId)
    : !request.heroContractOnly && isAmount(r.funding.amount) && isAmount(request.maxCostKeep)
      && BigInt(r.funding.amount) <= BigInt(request.maxCostKeep);
}, 'recruitment evidence disagrees with original consent');
export type HeroRecruitmentReceipt = z.infer<typeof HeroRecruitmentReceiptSchema>;
export const HeroRecruitmentStatusSchema = z.object({
  version: z.literal(1), wallet: Wallet, idempotencyKey: Uuid, enabled: z.boolean(), receipt: HeroRecruitmentReceiptSchema.nullable(),
}).strict().refine(r => !r.receipt || (r.receipt.actor === r.wallet && r.receipt.idempotencyKey === r.idempotencyKey), 'recruitment identity mismatch');
