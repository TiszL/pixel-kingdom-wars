/** D153.192 strict fragment transport and original-command matching. Parsing
 * grants no earning, historical-term, destination, stock or crafting authority.
 * Crystal Fragments deliberately never enter the raw-resource enum or stock. */
import { z } from 'zod';
import { PHASE_E_DIVINE_FRAGMENTS as P, PHASE_E_POLICY } from './constants';
import { RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';
import { DIVINE_FRAGMENT_POLICY, divineFragmentWeekAt, divineFragmentSeekerShare, splitDivineFragmentAward, splitDivineClanFragmentAward, DIVINE_FRAGMENT_CLAN_SITE_GROSS } from './divineFragments';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const Wallet = z.string().min(32).max(44).refine(value => {
  if (value.length < 32 || value.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return false;
  let n = 0n; for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes = 0; while (n) { bytes++; n >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
});
const Id = z.uuid().regex(/^[0-9a-f-]+$/).refine(v => v !== '00000000-0000-0000-0000-000000000000');
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Amount = z.string().max(19).refine(v => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= RAW_RESOURCE_STORAGE_MAX);
const Carry = Amount.refine(v => /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) < BigInt(P.basisPoints));
const Iso = z.string().length(24).refine(v => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Spot = z.number().int().min(0).max(PHASE_E_POLICY.seekerIsland.totalSpots - 1);
const Winners = z.number().int().min(1).max(PHASE_E_POLICY.seekerIsland.totalSpots);
const version = z.literal(P.version), resourceId = z.literal(P.resourceId);
const guarded = (fn: () => boolean): boolean => { try { return fn(); } catch { return false; } };

export const DivineFragmentPolicySchema = z.object({
  version, resourceId, weeklyGross: z.literal(DIVINE_FRAGMENT_POLICY.weeklyGross), periodDays: z.literal(P.periodDays),
  individualGross: z.literal(DIVINE_FRAGMENT_POLICY.individualGross), clanGross: z.literal(DIVINE_FRAGMENT_POLICY.clanGross),
  salvageGross: z.literal(DIVINE_FRAGMENT_POLICY.salvageGross), individualSites: z.literal(P.individualSites),
  grossPerSite: z.literal(DIVINE_FRAGMENT_POLICY.grossPerSite), basisPoints: z.literal(P.basisPoints),
  playerBps: z.literal(P.playerBps), seekerBps: z.literal(P.seekerBps), developerBps: z.literal(P.developerBps),
}).strict();
const IndividualAward = z.object({
  version, resourceId, economicLineage: z.literal(P.economicLineage),
  domain: z.object({ genesisHash: Wallet, economyProgram: Wallet }).strict(),
  eventId: Id, wallet: Wallet,
  site: z.string().regex(/^divine-individual-\d{3}$/).refine(v => Number(v.slice(-3)) >= 1 && Number(v.slice(-3)) <= P.individualSites),
  weekStart: Iso, earnedAt: Iso, sourceHash: Hash, termId: Id, termHash: Hash,
  winnerCount: z.number().int().min(0).max(PHASE_E_POLICY.seekerIsland.totalSpots),
  poolDisposition: z.enum(['original_winning_spots', 'held_zero_winners']),
  gross: Amount, net: Amount, tax: Amount, carryBefore: Carry, carryAfter: Carry, settledAt: Iso,
}).strict();

const ClanAward = IndividualAward.extend({
  site: z.string().regex(/^divine-clan-\d{3}$/).refine(v => Number(v.slice(-3)) >= 1 && Number(v.slice(-3)) <= P.clanSites),
  clan: z.object({ clanId: Id, entryId: Id, rosterSize: z.number().int().min(1).max(P.clanRosterCap),
    rosterHash: Hash, siteGross: z.literal(String(DIVINE_FRAGMENT_CLAN_SITE_GROSS)),
    tournamentDomain: z.object({ genesisHash: Wallet, economyProgram: Wallet, craftProgram: Wallet, treasury: Wallet }).strict(),
  }).strict(),
}).strict().refine(v => guarded(() => {
  const split = splitDivineClanFragmentAward(v.clan.rosterSize, BigInt(v.carryBefore));
  return divineFragmentWeekAt(v.earnedAt) === v.weekStart && Date.parse(v.settledAt) >= Date.parse(v.earnedAt)
    && v.domain.genesisHash === v.clan.tournamentDomain.genesisHash && v.domain.economyProgram === v.clan.tournamentDomain.economyProgram
    && v.gross === String(split.gross) && v.net === String(split.net) && v.tax === String(split.tax)
    && v.carryAfter === String(split.nextCarry)
    && v.poolDisposition === (v.winnerCount === 0 ? 'held_zero_winners' : 'original_winning_spots');
}), 'Clan fragment award differs from original roster earning policy');
/** Old individual awards remain byte-identical and require no added discriminator. */
export const DivineFragmentAwardSchema = z.union([IndividualAward.refine(v => guarded(() => {
  const split = splitDivineFragmentAward(BigInt(v.carryBefore));
  return divineFragmentWeekAt(v.earnedAt) === v.weekStart && Date.parse(v.settledAt) >= Date.parse(v.earnedAt)
    && v.gross === String(split.gross) && v.net === String(split.net) && v.tax === String(split.tax)
    && v.carryAfter === String(split.nextCarry)
    && v.poolDisposition === (v.winnerCount === 0 ? 'held_zero_winners' : 'original_winning_spots');
}), 'Fragment award differs from original earning policy'), ClanAward]);

export const DivineFragmentDeliveryRequestSchema = z.object({ idempotencyKey: Id, baseId: Id }).strict();
export const DivineFragmentDeliveryReceiptSchema = DivineFragmentDeliveryRequestSchema.extend({
  version, resourceId, eventId: Id, wallet: Wallet, quantity: Amount, stockBefore: Amount, stockAfter: Amount, deliveredAt: Iso,
}).strict().refine(v => guarded(() => BigInt(v.quantity) > 0n && BigInt(v.stockBefore) + BigInt(v.quantity) === BigInt(v.stockAfter)), 'Fragment delivery stock does not conserve');
const AwardRow = z.object({ award: DivineFragmentAwardSchema, delivery: DivineFragmentDeliveryReceiptSchema.nullable() }).strict()
  .refine(v => v.delivery === null || v.delivery.wallet === v.award.wallet && v.delivery.eventId === v.award.eventId
    && v.delivery.quantity === v.award.net && Date.parse(v.delivery.deliveredAt) >= Date.parse(v.award.settledAt), 'Delivery differs from original award');
export const DivineFragmentEventViewSchema = z.object({ version, wallet: Wallet, eventId: Id, enrolled: z.boolean(), settled: z.boolean(),
  award: DivineFragmentAwardSchema.nullable(), delivery: DivineFragmentDeliveryReceiptSchema.nullable(),
}).strict().refine(v => (!v.settled || v.enrolled) && (v.settled || v.award === null && v.delivery === null)
  && (v.award === null ? v.delivery === null : v.award.wallet === v.wallet && v.award.eventId === v.eventId
    && AwardRow.safeParse({ award: v.award, delivery: v.delivery }).success), 'Event view differs from its original actor or settlement');
export const DivineFragmentStockViewSchema = z.object({ version, resourceId, wallet: Wallet, baseId: Id, available: Amount }).strict();
export const DivineFragmentPageQuerySchema = z.object({ cursor: Id.optional() }).strict();
export const DivineFragmentAwardsPageSchema = z.object({ version, wallet: Wallet, rows: z.array(AwardRow).max(P.pageSize), nextCursor: Id.nullable() }).strict()
  .refine(v => v.rows.every((row, i) => row.award.wallet === v.wallet && (i === 0 || v.rows[i - 1]!.award.eventId < row.award.eventId))
    && (v.nextCursor === null || v.nextCursor === v.rows.at(-1)?.award.eventId), 'Award page repeats or changes its original scope');

export const DivineFragmentSeekerClaimRequestSchema = z.object({ idempotencyKey: Id, baseId: Id, termId: Id, spotId: Spot }).strict();
export const DivineFragmentSeekerClaimReceiptSchema = DivineFragmentSeekerClaimRequestSchema.extend({
  version, resourceId, wallet: Wallet, termHash: Hash, winnerCount: Winners, poolTotal: Amount,
  previousTotal: Amount, cumulativeTotal: Amount, quantity: Amount, stockBefore: Amount, stockAfter: Amount, claimedAt: Iso,
}).strict().refine(v => guarded(() => {
  const share = divineFragmentSeekerShare(BigInt(v.poolTotal), v.winnerCount, BigInt(v.previousTotal));
  return share.quantity > 0n && v.cumulativeTotal === String(share.cumulativeTotal) && v.quantity === String(share.quantity)
    && BigInt(v.stockBefore) + share.quantity === BigInt(v.stockAfter);
}), 'Fragment claim differs from original cumulative spot rights');
export const DivineFragmentSeekerEntitlementSchema = z.object({ termId: Id, termHash: Hash, startsAt: Iso, endsAt: Iso,
  spotId: Spot, winnerCount: Winners, poolTotal: Amount, previousTotal: Amount, cumulativeTotal: Amount, claimable: Amount,
}).strict().refine(v => guarded(() => {
  const share = divineFragmentSeekerShare(BigInt(v.poolTotal), v.winnerCount, BigInt(v.previousTotal));
  return BigInt(v.poolTotal) > 0n && v.cumulativeTotal === String(share.cumulativeTotal) && v.claimable === String(share.quantity)
    && Date.parse(v.endsAt) - Date.parse(v.startsAt) === PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000;
}), 'Fragment entitlement differs from original cumulative spot rights');
/** One complete term per page. UUID cursor is browse position, never a permanent
 * completion watermark; refresh from the beginning to find newly retained terms. */
export const DivineFragmentClaimablePageSchema = z.object({ version, wallet: Wallet,
  rows: z.array(DivineFragmentSeekerEntitlementSchema).max(PHASE_E_POLICY.seekerIsland.totalSpots), nextCursor: Id.nullable(),
}).strict().refine(v => v.rows.every((row, i) => {
  const first = v.rows[0]!;
  return row.termId === first.termId && row.termHash === first.termHash && row.startsAt === first.startsAt
    && row.endsAt === first.endsAt && row.winnerCount === first.winnerCount && row.poolTotal === first.poolTotal
    && (i === 0 || v.rows[i - 1]!.spotId < row.spotId);
}) && (v.rows.length === 0 || v.rows.length <= v.rows[0]!.winnerCount)
  && (v.nextCursor === null || v.rows.length === 0 || v.nextCursor === v.rows[0]!.termId), 'Fragment terms page repeats or mixes source rights');

export const DivineFragmentDeliveryEnvelopeSchema = z.object({ version, wallet: Wallet, idempotencyKey: Id,
  receipt: DivineFragmentDeliveryReceiptSchema.nullable() }).strict()
  .refine(v => v.receipt === null || v.receipt.wallet === v.wallet && v.receipt.idempotencyKey === v.idempotencyKey, 'Foreign fragment delivery');
export const DivineFragmentSeekerClaimEnvelopeSchema = z.object({ version, wallet: Wallet, idempotencyKey: Id,
  receipt: DivineFragmentSeekerClaimReceiptSchema.nullable() }).strict()
  .refine(v => v.receipt === null || v.receipt.wallet === v.wallet && v.receipt.idempotencyKey === v.idempotencyKey, 'Foreign fragment claim');
/** Persist before POST; current base selection cannot rewrite original consent. */
export const DivineFragmentDeliveryConsentSchema = z.object({ version, wallet: Wallet, eventId: Id,
  request: DivineFragmentDeliveryRequestSchema, award: DivineFragmentAwardSchema }).strict()
  .refine(v => v.wallet === v.award.wallet && v.eventId === v.award.eventId, 'Foreign award consent');
/** A cumulative claim consent names an original spot and destination, not a
 * caller-selected quantity. The server computes its current cumulative due. */
export const DivineFragmentSeekerClaimConsentSchema = z.object({ version, wallet: Wallet, request: DivineFragmentSeekerClaimRequestSchema }).strict();

export type DivineFragmentPolicy = z.infer<typeof DivineFragmentPolicySchema>;
export type DivineFragmentAward = z.infer<typeof DivineFragmentAwardSchema>;
export type DivineFragmentDeliveryRequest = z.infer<typeof DivineFragmentDeliveryRequestSchema>;
export type DivineFragmentDeliveryReceipt = z.infer<typeof DivineFragmentDeliveryReceiptSchema>;
export type DivineFragmentEventView = z.infer<typeof DivineFragmentEventViewSchema>;
export type DivineFragmentStockView = z.infer<typeof DivineFragmentStockViewSchema>;
export type DivineFragmentAwardsPage = z.infer<typeof DivineFragmentAwardsPageSchema>;
export type DivineFragmentSeekerClaimRequest = z.infer<typeof DivineFragmentSeekerClaimRequestSchema>;
export type DivineFragmentSeekerClaimReceipt = z.infer<typeof DivineFragmentSeekerClaimReceiptSchema>;
export type DivineFragmentSeekerEntitlement = z.infer<typeof DivineFragmentSeekerEntitlementSchema>;
export type DivineFragmentClaimablePage = z.infer<typeof DivineFragmentClaimablePageSchema>;
export type DivineFragmentDeliveryEnvelope = z.infer<typeof DivineFragmentDeliveryEnvelopeSchema>;
export type DivineFragmentSeekerClaimEnvelope = z.infer<typeof DivineFragmentSeekerClaimEnvelopeSchema>;
export type DivineFragmentDeliveryConsent = z.infer<typeof DivineFragmentDeliveryConsentSchema>;
export type DivineFragmentSeekerClaimConsent = z.infer<typeof DivineFragmentSeekerClaimConsentSchema>;

export function matchDivineFragmentDeliveryReceipt(value: unknown, original: DivineFragmentDeliveryConsent): DivineFragmentDeliveryReceipt {
  const receipt = DivineFragmentDeliveryReceiptSchema.parse(value), consent = DivineFragmentDeliveryConsentSchema.parse(original);
  if (receipt.wallet !== consent.wallet || receipt.eventId !== consent.eventId || receipt.idempotencyKey !== consent.request.idempotencyKey
    || receipt.baseId !== consent.request.baseId || receipt.quantity !== consent.award.net || Date.parse(receipt.deliveredAt) < Date.parse(consent.award.settledAt))
    throw new Error('Fragment delivery differs from original consent');
  return receipt;
}
export function matchDivineFragmentSeekerClaimReceipt(value: unknown, original: DivineFragmentSeekerClaimConsent): DivineFragmentSeekerClaimReceipt {
  const receipt = DivineFragmentSeekerClaimReceiptSchema.parse(value), consent = DivineFragmentSeekerClaimConsentSchema.parse(original);
  if (receipt.wallet !== consent.wallet || receipt.idempotencyKey !== consent.request.idempotencyKey || receipt.baseId !== consent.request.baseId
    || receipt.termId !== consent.request.termId || receipt.spotId !== consent.request.spotId) throw new Error('Fragment claim differs from original consent');
  return receipt;
}
export function matchDivineFragmentEventView(value: unknown, wallet: string, eventId: string): DivineFragmentEventView {
  const view = DivineFragmentEventViewSchema.parse(value);
  if (view.wallet !== Wallet.parse(wallet) || view.eventId !== Id.parse(eventId)) throw new Error('Fragment event scope differs');
  return view;
}
export function matchDivineFragmentAwardsPage(value: unknown, wallet: string, cursor: string | null = null): DivineFragmentAwardsPage {
  const page = DivineFragmentAwardsPageSchema.parse(value), prior = cursor === null ? null : Id.parse(cursor);
  if (page.wallet !== Wallet.parse(wallet) || prior !== null && (page.rows.some(r => r.award.eventId <= prior)
    || page.nextCursor !== null && page.nextCursor <= prior)) throw new Error('Fragment award page scope differs');
  return page;
}
export function matchDivineFragmentClaimablePage(value: unknown, wallet: string, cursor: string | null = null): DivineFragmentClaimablePage {
  const page = DivineFragmentClaimablePageSchema.parse(value), prior = cursor === null ? null : Id.parse(cursor);
  if (page.wallet !== Wallet.parse(wallet) || prior !== null && (page.rows.some(r => r.termId <= prior)
    || page.nextCursor !== null && page.nextCursor <= prior)) throw new Error('Fragment claimable page scope differs');
  return page;
}
