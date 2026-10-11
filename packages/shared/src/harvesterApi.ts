/** D153.33 original Harvester consent/proofs and authorized current views.
 * Subpath only. Format validation is not source, facility or chain authority. */
import { z } from 'zod';
import { REALM_IDS } from './baseVisual';
import { PHASE_E_HARVESTER } from './constants';
import { PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES, PhaseERawResourceIdSchema,
  PositiveRawResourceQuantitySchema, RawResourceQuantitySchema, RawResourceStockSchema } from './phaseEResources';

const V1 = PHASE_E_HARVESTER.v1;
const SECOND_MS = 1_000, DAY_MS = 24 * 60 * 60 * SECOND_MS;
const MAX_EVENTS = Math.floor(V1.maxLeaseSec / V1.cadenceSec);
export const HARVESTER_FEATURE = { version: 1, receipts: 1 } as const;
export const HarvesterUuidSchema = z.uuid().regex(/^[0-9a-f-]+$/);
const Timestamp = z.iso.datetime().refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
const Wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Version = z.number().int().positive().max(2_147_483_647);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalQuantities = (values: string[]) => values.every(v => RawResourceQuantitySchema.safeParse(v).success);

export const HarvesterSourceRequestSchema = z.object({ idempotencyKey: HarvesterUuidSchema,
  baseId: HarvesterUuidSchema, harvesterId: HarvesterUuidSchema,
  expectedSourceId: HarvesterUuidSchema.nullable(), policyVersion: Version }).strict();
export type HarvesterSourceRequest = z.infer<typeof HarvesterSourceRequestSchema>;

/** Historical v1 remains independent of the mutable currentPolicyVersion. */
export const HarvesterPolicySchema = z.object({ policyVersion: z.literal(V1.policyVersion),
  producingSourcesPerWallet: z.literal(V1.producingSourcesPerWallet),
  grossPerWalletUtcDay: PositiveRawResourceQuantitySchema, grossPerCadence: PositiveRawResourceQuantitySchema,
  cadenceSec: z.literal(V1.cadenceSec), maxLeaseSec: z.literal(V1.maxLeaseSec),
  taxPolicyVersion: z.literal(V1.taxPolicyVersion), taxBasisPoints: z.literal(V1.taxBasisPoints),
  islandPoolBps: z.literal(V1.islandPoolBps),
}).strict().refine(v => v.grossPerWalletUtcDay === String(V1.grossPerWalletUtcDay)
  && v.grossPerCadence === String(V1.grossPerCadence), 'Frozen Harvester policy differs from its version');
export type HarvesterPolicy = z.infer<typeof HarvesterPolicySchema>;
export function harvesterPolicyV1(): HarvesterPolicy {
  return { ...V1, grossPerWalletUtcDay: String(V1.grossPerWalletUtcDay), grossPerCadence: String(V1.grossPerCadence) };
}

const sourceFields = { sourceId: HarvesterUuidSchema, baseId: HarvesterUuidSchema, harvesterId: HarvesterUuidSchema,
  policyVersion: Version, realmId: z.enum(REALM_IDS), resourceId: PhaseERawResourceIdSchema,
  admittedAt: Timestamp, leaseExpiresAt: Timestamp };
const summaryValid = (v: { realmId: string; resourceId: keyof typeof PHASE_E_RAW_RESOURCES; admittedAt: string; leaseExpiresAt: string }) =>
  PHASE_E_RAW_RESOURCES[v.resourceId].realmId === v.realmId && Date.parse(v.admittedAt) < Date.parse(v.leaseExpiresAt);
export const HarvesterSourceSummarySchema = z.object(sourceFields).strict().refine(summaryValid,
  'Harvester summary differs from its native resource or interval');
export type HarvesterSourceSummary = z.infer<typeof HarvesterSourceSummarySchema>;
const AcceptedSource = z.object({ ...sourceFields, completedBuildJobId: HarvesterUuidSchema,
  harvesterCompletedAt: Timestamp, term: z.object({ termId: HarvesterUuidSchema, termHash: Hash,
    startsAt: Timestamp, endsAt: Timestamp }).strict(), terms: HarvesterPolicySchema,
}).strict().refine(v => summaryValid(v) && v.policyVersion === v.terms.policyVersion
  && Date.parse(v.harvesterCompletedAt) <= Date.parse(v.admittedAt)
  && Date.parse(v.term.startsAt) <= Date.parse(v.admittedAt) && Date.parse(v.admittedAt) < Date.parse(v.term.endsAt)
  && Date.parse(v.leaseExpiresAt) === Math.min(Date.parse(v.admittedAt) + v.terms.maxLeaseSec * SECOND_MS, Date.parse(v.term.endsAt)),
'Harvester interval differs from its original completion, term or frozen lease');
export const HarvesterSourceReceiptSchema = z.object({ wallet: Wallet, request: HarvesterSourceRequestSchema,
  source: AcceptedSource }).strict().refine(v => v.source.sourceId === v.request.idempotencyKey
  && v.source.baseId === v.request.baseId && v.source.harvesterId === v.request.harvesterId
  && v.source.policyVersion === v.request.policyVersion && v.request.expectedSourceId !== v.source.sourceId,
'Harvester receipt differs from the original source command');
export type HarvesterSourceReceipt = z.infer<typeof HarvesterSourceReceiptSchema>;

export const HarvesterEventSchema = z.object({ sourceId: HarvesterUuidSchema,
  ordinal: z.number().int().positive().max(MAX_EVENTS), walletSequence: PositiveRawResourceQuantitySchema,
  resourceId: PhaseERawResourceIdSchema, policyVersion: z.literal(V1.policyVersion),
  earnedAt: Timestamp, settledAt: Timestamp, utcDay: Timestamp,
  grossQuantity: RawResourceQuantitySchema, netQuantity: RawResourceQuantitySchema, islandPoolQuantity: RawResourceQuantitySchema,
  taxPolicyVersion: z.literal(V1.taxPolicyVersion), taxBasisPoints: z.literal(V1.taxBasisPoints), islandPoolBps: z.literal(V1.islandPoolBps),
  carryBefore: RawResourceQuantitySchema, carryAfter: RawResourceQuantitySchema,
}).strict().refine(v => {
  if (!canonicalQuantities([v.grossQuantity, v.netQuantity, v.islandPoolQuantity, v.carryBefore, v.carryAfter])) return false;
  const gross = BigInt(v.grossQuantity), before = BigInt(v.carryBefore), basis = BigInt(v.taxBasisPoints);
  const numerator = gross * BigInt(v.islandPoolBps) + before;
  return (gross === 0n || gross === BigInt(V1.grossPerCadence)) && before < basis
    && BigInt(v.islandPoolQuantity) === numerator / basis && BigInt(v.netQuantity) + BigInt(v.islandPoolQuantity) === gross
    && BigInt(v.carryAfter) === numerator % basis && Date.parse(v.settledAt) >= Date.parse(v.earnedAt)
    && Date.parse(v.utcDay) === Math.floor(Date.parse(v.earnedAt) / DAY_MS) * DAY_MS;
}, 'Harvester event differs from its conserved original allocation');
export type HarvesterEvent = z.infer<typeof HarvesterEventSchema>;
export const HarvesterClosureSchema = z.object({ sourceId: HarvesterUuidSchema,
  reason: z.enum(['replacement', 'custody_change', 'deactivation', 'facility_removed', 'realm_change', 'lease_expired']),
  cutoffAt: Timestamp, processedOrdinal: z.number().int().nonnegative().max(MAX_EVENTS) }).strict();
export const HarvesterCustodyStopSchema = z.object({ sourceId: HarvesterUuidSchema,
  cutoffAt: Timestamp, checkedAt: Timestamp, auditHash: Hash }).strict()
  .refine(v => Date.parse(v.checkedAt) <= Date.parse(v.cutoffAt), 'Custody observation follows its original cutoff');
export const HarvesterSettlementSchema = z.object({ events: z.array(HarvesterEventSchema).max(MAX_EVENTS),
  closure: HarvesterClosureSchema.nullable(), custodyStop: HarvesterCustodyStopSchema.nullable(),
}).strict().refine(v => v.events.every((e, i) => {
  const prior = v.events[i - 1];
  return e.ordinal === i + 1 && (!prior || canonicalQuantities([e.walletSequence, prior.walletSequence])
    && BigInt(e.walletSequence) > BigInt(prior.walletSequence) && e.sourceId === prior.sourceId
    && e.resourceId === prior.resourceId && e.carryBefore === prior.carryAfter);
}) && (v.closure === null || v.closure.processedOrdinal === v.events.length)
  && (v.closure === null || v.custodyStop === null || v.closure.reason === 'custody_change'
    && v.closure.cutoffAt === v.custodyStop.cutoffAt && v.closure.sourceId === v.custodyStop.sourceId),
'Harvester settlement differs from its ordered original frontier');
export type HarvesterSettlement = z.infer<typeof HarvesterSettlementSchema>;

function settlementMatches(receipt: HarvesterSourceReceipt, settlement: HarvesterSettlement, serverNow: string): boolean {
  const s = receipt.source, admitted = Date.parse(s.admittedAt), end = Date.parse(s.term.endsAt), lease = Date.parse(s.leaseExpiresAt);
  const { closure, custodyStop } = settlement, now = Date.parse(serverNow);
  if (admitted > now || closure && (closure.sourceId !== s.sourceId || Date.parse(closure.cutoffAt) < admitted
    || Date.parse(closure.cutoffAt) > now || closure.reason === 'lease_expired' && Date.parse(closure.cutoffAt) < lease)
    || custodyStop && (custodyStop.sourceId !== s.sourceId || Date.parse(custodyStop.cutoffAt) < admitted
      || Date.parse(custodyStop.cutoffAt) > now)) return false;
  if (!settlement.events.every(e => e.sourceId === s.sourceId && e.resourceId === s.resourceId
    && e.policyVersion === s.policyVersion && e.taxPolicyVersion === s.terms.taxPolicyVersion
    && e.taxBasisPoints === s.terms.taxBasisPoints && e.islandPoolBps === s.terms.islandPoolBps
    && Date.parse(e.earnedAt) === admitted + e.ordinal * s.terms.cadenceSec * SECOND_MS
    && Date.parse(e.earnedAt) <= lease && Date.parse(e.earnedAt) < end && Date.parse(e.settledAt) <= now
    && (custodyStop === null || Date.parse(e.earnedAt) <= Date.parse(custodyStop.cutoffAt)))) return false;
  if (closure) {
    let complete = 0;
    for (let ordinal = 1; ordinal <= MAX_EVENTS; ordinal++) {
      const earned = admitted + ordinal * s.terms.cadenceSec * SECOND_MS;
      if (earned > Date.parse(closure.cutoffAt) || earned > lease || earned >= end) break;
      complete = ordinal;
    }
    if (closure.processedOrdinal !== complete) return false;
  }
  return true;
}
const envelopeFields = { wallet: Wallet, idempotencyKey: HarvesterUuidSchema, serverNow: Timestamp };
export const HarvesterSourceEnvelopeSchema = z.discriminatedUnion('status', [
  z.object({ ...envelopeFields, status: z.literal('unknown'), originalReceipt: z.null(), settlement: z.null() }).strict(),
  z.object({ ...envelopeFields, status: z.literal('accepted'), originalReceipt: HarvesterSourceReceiptSchema,
    settlement: HarvesterSettlementSchema }).strict(),
]).refine(v => v.status === 'unknown' || v.wallet === v.originalReceipt.wallet
  && v.idempotencyKey === v.originalReceipt.request.idempotencyKey && settlementMatches(v.originalReceipt, v.settlement, v.serverNow),
'Harvester envelope differs from its original actor, source or settlement');
export type HarvesterSourceEnvelope = z.infer<typeof HarvesterSourceEnvelopeSchema>;
export function matchHarvesterSourceEnvelope(raw: unknown, wallet: string, original: HarvesterSourceRequest): HarvesterSourceEnvelope {
  const request = HarvesterSourceRequestSchema.parse(original), proof = HarvesterSourceEnvelopeSchema.parse(raw);
  if (proof.wallet !== wallet || proof.idempotencyKey !== request.idempotencyKey
    || proof.status === 'accepted' && JSON.stringify(proof.originalReceipt.request) !== JSON.stringify(request))
    throw new Error('Harvester proof differs from original command');
  return proof;
}

export const HarvesterViewSchema = z.object({ wallet: Wallet, baseId: HarvesterUuidSchema, serverNow: Timestamp,
  features: z.object({ harvesters: z.object({ version: z.literal(1), receipts: z.literal(1) }).strict() }).strict(),
  acceptingSelections: z.boolean(), home: z.object({ source: z.enum(['free_assignment', 'deed_location', 'free_policy_preview']),
    version: Version, realmId: z.enum(REALM_IDS) }).strict().nullable(),
  facilities: z.array(z.object({ baseId: HarvesterUuidSchema, harvesterId: HarvesterUuidSchema,
    completedBuildJobId: HarvesterUuidSchema, harvesterCompletedAt: Timestamp }).strict()),
  source: HarvesterSourceSummarySchema.nullable(), walletSource: HarvesterSourceSummarySchema.nullable(),
  policy: HarvesterPolicySchema, rawStock: z.array(RawResourceStockSchema),
}).strict().refine(v => v.rawStock.length === PHASE_E_RAW_RESOURCE_IDS.length
  && PHASE_E_RAW_RESOURCE_IDS.every(id => v.rawStock.filter(row => row.resourceId === id).length === 1)
  && new Set(v.facilities.map(f => f.harvesterId)).size === v.facilities.length
  && new Set(v.facilities.map(f => f.completedBuildJobId)).size === v.facilities.length
  && v.facilities.every(f => f.baseId === v.baseId && Date.parse(f.harvesterCompletedAt) <= Date.parse(v.serverNow))
  && (v.walletSource === null || Date.parse(v.walletSource.admittedAt) <= Date.parse(v.serverNow))
  && JSON.stringify(v.source) === JSON.stringify(v.walletSource?.baseId === v.baseId ? v.walletSource : null),
'Current Harvester view must describe one complete authorized base snapshot');
export type HarvesterView = z.infer<typeof HarvesterViewSchema>;
