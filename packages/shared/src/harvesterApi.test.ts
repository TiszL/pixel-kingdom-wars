import { describe, expect, it } from 'vitest';
import { PHASE_E_HARVESTER } from './constants';
import { PHASE_E_RAW_RESOURCE_IDS, RAW_RESOURCE_STORAGE_MAX } from './phaseEResources';
import { HARVESTER_FEATURE, harvesterPolicyV1, HarvesterPolicySchema, HarvesterSourceEnvelopeSchema,
  HarvesterSourceReceiptSchema, HarvesterSourceRequestSchema, HarvesterViewSchema, matchHarvesterSourceEnvelope,
  type HarvesterEvent, type HarvesterSettlement } from './harvesterApi';

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111', at = '2026-09-22T12:00:00.000Z';
const terms = harvesterPolicyV1(), second = 1_000;
const after = (seconds: number) => new Date(Date.parse(at) + seconds * second).toISOString();
const request = { idempotencyKey: id(1), baseId: id(2), harvesterId: id(3), expectedSourceId: null,
  policyVersion: terms.policyVersion };
const summary = { sourceId: id(1), baseId: id(2), harvesterId: id(3), policyVersion: terms.policyVersion,
  realmId: 'crownlands' as const, resourceId: 'crown_iron_ore' as const, admittedAt: at, leaseExpiresAt: after(terms.maxLeaseSec) };
const source = { ...summary, completedBuildJobId: id(4), harvesterCompletedAt: at,
  term: { termId: id(5), termHash: 'ab'.repeat(32), startsAt: at, endsAt: after(terms.maxLeaseSec * 2) }, terms };
const receipt = { wallet, request, source };
function events(count: number, initialCarry = 0n, capped = false): HarvesterEvent[] {
  let carry = initialCarry;
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1, earnedAt = after(ordinal * terms.cadenceSec), before = carry;
    const gross = capped ? 0n : BigInt(terms.grossPerCadence), numerator = gross * BigInt(terms.islandPoolBps) + before;
    const tax = numerator / BigInt(terms.taxBasisPoints);
    carry = numerator % BigInt(terms.taxBasisPoints);
    return { sourceId: source.sourceId, ordinal, walletSequence: String(ordinal), resourceId: source.resourceId,
      policyVersion: terms.policyVersion, earnedAt, settledAt: earnedAt,
      utcDay: new Date(Math.floor(Date.parse(earnedAt) / (24 * 60 * 60 * second)) * (24 * 60 * 60 * second)).toISOString(),
      grossQuantity: String(gross), netQuantity: String(gross - tax), islandPoolQuantity: String(tax),
      taxPolicyVersion: terms.taxPolicyVersion, taxBasisPoints: terms.taxBasisPoints, islandPoolBps: terms.islandPoolBps,
      carryBefore: String(before), carryAfter: String(carry) };
  });
}
function proof(settlement: HarvesterSettlement = { events: [], closure: null, custodyStop: null }) {
  return { wallet, idempotencyKey: id(1), serverNow: after(terms.maxLeaseSec * 3), status: 'accepted' as const,
    originalReceipt: receipt, settlement };
}
const parse = (value: unknown) => HarvesterSourceEnvelopeSchema.safeParse(value).success;
const withEvents = (rows: HarvesterEvent[]) => proof({ events: rows, closure: null, custodyStop: null });

describe('Harvester original public command and settlement wire contract', () => {
  it('accepts strict original consent and rejects client authority or noncanonical scalars', () => {
    expect(HarvesterSourceRequestSchema.parse(request)).toEqual(request);
    for (const patch of [{ expectedSourceId: undefined }, { expectedSourceId: '' }, { policyVersion: '1' },
      { policyVersion: 0 }, { policyVersion: 1.5 }, { policyVersion: 2_147_483_648 },
      { idempotencyKey: id(1).toUpperCase() }, { baseId: 'invalid' }, { wallet }, { cutoffAt: at }, { home: {} }])
      expect(HarvesterSourceRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  });
  it('keeps v1 terms frozen instead of accepting changed cap, cadence or tax', () => {
    expect(HarvesterPolicySchema.parse(terms)).toEqual({ ...PHASE_E_HARVESTER.v1,
      grossPerWalletUtcDay: String(PHASE_E_HARVESTER.v1.grossPerWalletUtcDay), grossPerCadence: String(PHASE_E_HARVESTER.v1.grossPerCadence) });
    for (const patch of [{ policyVersion: terms.policyVersion + 1 }, { cadenceSec: terms.cadenceSec + 1 },
      { grossPerWalletUtcDay: String(BigInt(terms.grossPerWalletUtcDay) + 1n) }, { grossPerCadence: '01' },
      { maxLeaseSec: terms.maxLeaseSec + 1 }, { islandPoolBps: terms.islandPoolBps + 1 }])
      expect(HarvesterPolicySchema.safeParse({ ...terms, ...patch }).success).toBe(false);
  });
  it('matches the full reviewed body, including expected head, before accepting recovery', () => {
    expect(matchHarvesterSourceEnvelope(proof(), wallet, request)).toEqual(proof());
    for (const patch of [{ idempotencyKey: id(8) }, { baseId: id(8) }, { harvesterId: id(8) },
      { expectedSourceId: id(8) }, { policyVersion: terms.policyVersion + 1 }])
      expect(() => matchHarvesterSourceEnvelope(proof(), wallet, { ...request, ...patch })).toThrow();
    expect(() => matchHarvesterSourceEnvelope(proof(), `${wallet}1`, request)).toThrow();
    expect(parse({ ...proof(), wallet: `${wallet}1` })).toBe(false);
    expect(parse({ ...proof(), idempotencyKey: id(8) })).toBe(false);
  });
  it('unknown is not an accepted original or a current inventory snapshot', () => {
    const unknown = { ...proof(), status: 'unknown', originalReceipt: null, settlement: null };
    expect(parse(unknown)).toBe(true);
    expect(parse({ ...unknown, settlement: proof().settlement })).toBe(false);
    expect(parse({ ...proof(), settlement: null })).toBe(false);
    expect(parse({ ...proof(), rawStock: [] })).toBe(false);
    expect(parse({ ...proof(), originalReceipt: { ...receipt, homeEvidence: {} } })).toBe(false);
    expect(parse({ ...proof(), originalReceipt: { ...receipt, source: { ...source, winners: [] } } })).toBe(false);
  });
  it('binds original facility, native resource, term and exact bounded lease', () => {
    expect(HarvesterSourceReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const patch of [{ sourceId: id(8) }, { baseId: id(8) }, { harvesterId: id(8) },
      { policyVersion: terms.policyVersion + 1 }, { completedBuildJobId: '' }, { harvesterCompletedAt: after(1) },
      { realmId: 'frostveil' }, { leaseExpiresAt: after(terms.maxLeaseSec - 1) },
      { term: { ...source.term, startsAt: after(1) } }, { term: { ...source.term, endsAt: at } }])
      expect(HarvesterSourceReceiptSchema.safeParse({ ...receipt, source: { ...source, ...patch } }).success).toBe(false);
    expect(HarvesterSourceReceiptSchema.safeParse({ ...receipt, request: { ...request, expectedSourceId: id(1) } }).success).toBe(false);
    const shorter = after(terms.cadenceSec * 2);
    expect(HarvesterSourceReceiptSchema.safeParse({ ...receipt, source: { ...source, leaseExpiresAt: shorter,
      term: { ...source.term, endsAt: shorter } } }).success).toBe(true);
  });
  it('accepts capped zero candidates and tax-only units without fabricating spendable stock', () => {
    expect(parse(withEvents(events(2, 0n, true)))).toBe(true);
    const taxOnly = events(1, BigInt(terms.taxBasisPoints) - BigInt(terms.islandPoolBps));
    expect(taxOnly[0]!.netQuantity).toBe('0');
    expect(parse(withEvents(taxOnly))).toBe(true);
  });
  it('requires canonical conserved amounts, UTC earning day and exact cadence identities', () => {
    const original = events(1)[0]!;
    for (const patch of [{ grossQuantity: '01' }, { netQuantity: '-1' }, { carryBefore: 'invalid' },
      { walletSequence: String(RAW_RESOURCE_STORAGE_MAX + 1n) }, { walletSequence: '0' },
      { netQuantity: String(BigInt(original.netQuantity) + 1n) }, { carryAfter: String(BigInt(original.carryAfter) + 1n) },
      { carryBefore: String(terms.taxBasisPoints) }, { settledAt: at }, { utcDay: original.earnedAt },
      { earnedAt: after(terms.cadenceSec - 1) }, { ordinal: 2 }, { sourceId: id(8) }, { resourceId: 'frost_quartz' as const }])
      expect(parse(withEvents([{ ...original, ...patch }]))).toBe(false);
    expect(parse({ ...withEvents([original]), serverNow: at })).toBe(false);
  });
  it('rejects missing or reordered ordinals, duplicated wallet order and broken carry continuity', () => {
    const rows = events(3);
    expect(parse(withEvents(rows))).toBe(true);
    expect(parse(withEvents([rows[0]!, rows[2]!]))).toBe(false);
    expect(parse(withEvents([rows[1]!, rows[0]!, rows[2]!]))).toBe(false);
    expect(parse(withEvents([rows[0]!, { ...rows[1]!, walletSequence: rows[0]!.walletSequence }]))).toBe(false);
    const secondWithOtherCarry = { ...events(1)[0]!, ordinal: 2, walletSequence: '2', earnedAt: rows[1]!.earnedAt,
      settledAt: rows[1]!.settledAt, utcDay: rows[1]!.utcDay };
    expect(parse(withEvents([rows[0]!, secondWithOtherCarry]))).toBe(false);
  });
  it('proves the full closed frontier and keeps term end exclusive while lease expiry is inclusive', () => {
    const maximum = Math.floor(terms.maxLeaseSec / terms.cadenceSec), rows = events(maximum);
    const closure = { sourceId: source.sourceId, reason: 'lease_expired' as const, cutoffAt: source.leaseExpiresAt, processedOrdinal: maximum };
    expect(parse(proof({ events: rows, closure, custodyStop: null }))).toBe(true);
    expect(parse(proof({ events: rows.slice(0, -1), closure, custodyStop: null }))).toBe(false);
    expect(parse(proof({ events: [], closure: { ...closure, cutoffAt: at, processedOrdinal: 0 }, custodyStop: null }))).toBe(false);
    expect(parse(proof({ events: rows, closure: { ...closure, sourceId: id(8) }, custodyStop: null }))).toBe(false);
    const termEnd = after(terms.cadenceSec * 2), shortened = { ...receipt, source: { ...source, leaseExpiresAt: termEnd, term: { ...source.term, endsAt: termEnd } } };
    expect(parse({ ...withEvents(events(1)), originalReceipt: shortened })).toBe(true);
    expect(parse({ ...withEvents(events(2)), originalReceipt: shortened })).toBe(false);
    expect(parse(withEvents(events(maximum + 1)))).toBe(false);
  });
  it('preserves the first custody cutoff while permitting later settlement of its owed units', () => {
    const custodyStop = { sourceId: source.sourceId, cutoffAt: after(terms.cadenceSec), checkedAt: at, auditHash: 'ab'.repeat(32) };
    const closure = { sourceId: source.sourceId, reason: 'custody_change' as const, cutoffAt: custodyStop.cutoffAt, processedOrdinal: 1 };
    const rows = events(1).map(e => ({ ...e, settledAt: after(terms.maxLeaseSec * 2) }));
    expect(parse(proof({ events: rows, closure, custodyStop }))).toBe(true);
    expect(parse(proof({ events: rows, closure: null, custodyStop }))).toBe(true);
    expect(parse(proof({ events: events(2), closure: null, custodyStop }))).toBe(false);
    for (const patch of [{ cutoffAt: after(terms.cadenceSec + 1) }, { reason: 'replacement' as const }])
      expect(parse(proof({ events: rows, closure: { ...closure, ...patch }, custodyStop }))).toBe(false);
    expect(parse(proof({ events: rows, closure, custodyStop: { ...custodyStop, checkedAt: after(terms.cadenceSec + 1) } }))).toBe(false);
  });
  it('keeps an expired selected head visible while current stock remains an independent complete projection', () => {
    const view = { wallet, baseId: source.baseId, serverNow: after(terms.maxLeaseSec * 3),
      features: { harvesters: HARVESTER_FEATURE }, acceptingSelections: false,
      home: { source: 'free_policy_preview', version: 1, realmId: 'crownlands' },
      facilities: [{ baseId: source.baseId, harvesterId: source.harvesterId, completedBuildJobId: source.completedBuildJobId,
        harvesterCompletedAt: source.harvesterCompletedAt }], source: summary, walletSource: summary, policy: terms,
      rawStock: PHASE_E_RAW_RESOURCE_IDS.map(resourceId => ({ resourceId, available: '0', reserved: '0', total: '0' })) };
    expect(HarvesterViewSchema.safeParse(view).success).toBe(true);
    for (const patch of [{ rawStock: view.rawStock.slice(1) }, { rawStock: [...view.rawStock.slice(1), view.rawStock[1]] },
      { source: null }, { walletSource: null }, { facilities: [...view.facilities, ...view.facilities] },
      { facilities: [{ ...view.facilities[0], baseId: id(8) }] }, { facilities: [{ ...view.facilities[0], harvesterCompletedAt: after(terms.maxLeaseSec * 4) }] }])
      expect(HarvesterViewSchema.safeParse({ ...view, ...patch }).success).toBe(false);
    expect(HarvesterViewSchema.safeParse({ ...view, source: null, walletSource: { ...summary, baseId: id(8) } }).success).toBe(true);
    expect(HarvesterViewSchema.safeParse({ ...view, source: null, walletSource: null, facilities: [], home: null }).success).toBe(true);
  });
});
