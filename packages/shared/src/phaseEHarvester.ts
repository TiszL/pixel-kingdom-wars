/** D153.28 deterministic NEW-event planning only. No RPC, wall clock, authority,
 * persistent allowance, tax carry or stock writer. Never recover historical
 * receipts by replanning against today's usage/catalogue. A server must first
 * recover original receipts, serialize the original wallet, settle its old
 * source and supply prior finalized allocations EXCLUDING this interval.
 * Hash/identity shape validation does not verify genuine term or facility proof. */
import { z } from 'zod';
import { REALM_IDS } from './baseVisual';
import { PHASE_E_HARVESTER } from './constants';
import { PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES } from './phaseEResources';

const POLICY = PHASE_E_HARVESTER.v1;
const SECOND_MS = 1_000, UTC_DAY_MS = 24 * 60 * 60 * SECOND_MS;
// JavaScript Date's exact finite range; this is a representation bound, not
// an earning duration. No Date.now/new Date() without an explicit input.
const DATE_MAX_MS = 8_640_000_000_000_000;
const DateMs = z.number().int().nonnegative().max(DATE_MAX_MS).safe();
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const utcDay = (at: number) => Math.floor(at / UTC_DAY_MS) * UTC_DAY_MS;

export const HarvesterIntervalV1Schema = z.object({
  policyVersion: z.literal(POLICY.policyVersion),
  sourceId: uuid,
  originalWallet: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  baseId: uuid,
  harvesterId: uuid,
  realmId: z.enum(REALM_IDS),
  admittedAtMs: DateMs,
  term: z.object({ id: uuid, hash: z.string().regex(/^[0-9a-f]{64}$/),
    startsAtMs: DateMs, endsAtMs: DateMs }).strict(),
}).strict().refine(value => value.term.startsAtMs <= value.admittedAtMs
  && value.admittedAtMs < value.term.endsAtMs, 'Admission must be inside its original half-open term')
  .refine(value => value.admittedAtMs <= DATE_MAX_MS - POLICY.maxLeaseSec * SECOND_MS,
    'Lease end exceeds exact Date range');
export type HarvesterIntervalV1 = z.infer<typeof HarvesterIntervalV1Schema>;

/** Aggregate for ALL resources/bases of the original wallet and policy version,
 * not current inventory or current ownership. Every day with a potential earned
 * event through cutoff needs an explicit row, including authoritative zero use.
 * Whether supplied history is authentic/complete belongs to the locked DB caller. */
export const HarvesterDayUsageSchema = z.object({
  utcDayStartMs: DateMs.refine(value => value === utcDay(value), 'Expected UTC midnight'),
  grossUnits: z.number().int().nonnegative().max(POLICY.grossPerWalletUtcDay).safe(),
}).strict();
export type HarvesterDayUsage = z.infer<typeof HarvesterDayUsageSchema>;

export function planHarvesterIntervalV1(input: HarvesterIntervalV1, cutoffMs: number,
  priorWalletUsage: readonly HarvesterDayUsage[]) {
  const interval = HarvesterIntervalV1Schema.parse(input);
  const cutoff = DateMs.parse(cutoffMs);
  if (cutoff < interval.admittedAtMs) throw new Error('Cutoff precedes original admission');
  const leaseExpiresAtMs = Math.min(interval.admittedAtMs + POLICY.maxLeaseSec * SECOND_MS, interval.term.endsAtMs);
  // A bounded lease intersects at most this many UTC days, including a unit
  // completing exactly at lease expiry on the following midnight.
  const maxDays = Math.ceil(POLICY.maxLeaseSec * SECOND_MS / UTC_DAY_MS) + 1;
  const usage = z.array(HarvesterDayUsageSchema).max(maxDays).parse(priorWalletUsage);
  const byDay = new Map<number, number>();
  for (const day of usage) {
    if (byDay.has(day.utcDayStartMs)) throw new Error('Duplicate daily allowance history');
    if (day.utcDayStartMs < utcDay(interval.admittedAtMs) || day.utcDayStartMs > utcDay(leaseExpiresAtMs))
      throw new Error('Daily allowance history is outside original lease');
    byDay.set(day.utcDayStartMs, day.grossUnits);
  }
  const resourceId = PHASE_E_RAW_RESOURCE_IDS.find(id => PHASE_E_RAW_RESOURCES[id].realmId === interval.realmId);
  if (!resourceId) throw new Error('Original realm has no native raw resource');
  const events: Readonly<{ sourceId: string; ordinal: number; earnedAtMs: number; utcDayStartMs: number;
    policyVersion: typeof POLICY.policyVersion; resourceId: typeof resourceId; grossQuantity: string }>[] = [];
  const maximum = Math.floor(POLICY.maxLeaseSec / POLICY.cadenceSec);
  for (let ordinal = 1; ordinal <= maximum; ordinal++) {
    const earnedAtMs = interval.admittedAtMs + ordinal * POLICY.cadenceSec * SECOND_MS;
    // Term end is exclusive. Lease expiry and the supplied settlement cutoff
    // include a whole unit completing at that exact instant. A late cutoff never
    // authorizes a later interval or erases units already earned before expiry.
    if (earnedAtMs >= interval.term.endsAtMs || earnedAtMs > leaseExpiresAtMs || earnedAtMs > cutoff) break;
    const day = utcDay(earnedAtMs), used = byDay.get(day);
    if (used === undefined) throw new Error('Missing authoritative daily allowance history');
    if (used + POLICY.grossPerCadence > POLICY.grossPerWalletUtcDay) continue;
    byDay.set(day, used + POLICY.grossPerCadence);
    // Never renumber after daily-cap filtering: sourceId+ordinal is a stable
    // candidate identity for a future immutable source receipt, not a receipt.
    events.push(Object.freeze({ sourceId: interval.sourceId, ordinal, earnedAtMs, utcDayStartMs: day,
      policyVersion: POLICY.policyVersion, resourceId, grossQuantity: String(POLICY.grossPerCadence) }));
  }
  return Object.freeze({ interval: Object.freeze({ ...interval, term: Object.freeze(interval.term) }),
    leaseExpiresAtMs, events: Object.freeze(events) });
}
