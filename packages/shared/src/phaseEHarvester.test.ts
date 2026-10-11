import { describe, expect, it } from 'vitest';
import { PHASE_E_HARVESTER as H } from './constants';
import { PHASE_E_RAW_RESOURCE_IDS, PHASE_E_RAW_RESOURCES } from './phaseEResources';
import { planHarvesterIntervalV1 as plan, type HarvesterIntervalV1 } from './phaseEHarvester';

const DAY = 86_400_000, STEP = H.v1.cadenceSec * 1_000;
const MIDNIGHT = Date.parse('2026-09-22T00:00:00Z');
const ZERO = [{ utcDayStartMs: MIDNIGHT, grossUnits: 0 }, { utcDayStartMs: MIDNIGHT + DAY, grossUnits: 0 }];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function interval(overrides: Partial<HarvesterIntervalV1> = {}): HarvesterIntervalV1 {
  return { policyVersion: H.v1.policyVersion, sourceId: id(1), originalWallet: '11111111111111111111111111111111',
    baseId: id(2), harvesterId: id(3), realmId: 'crownlands', admittedAtMs: MIDNIGHT,
    term: { id: id(4), hash: 'a'.repeat(64), startsAtMs: MIDNIGHT - DAY, endsAtMs: MIDNIGHT + 3 * DAY }, ...overrides };
}

describe('Harvester v1 original interval planning (not authority or issuance)', () => {
  it('pins delegated tuning and produces at most fifteen whole cadence completions', () => {
    expect(H.v1).toEqual({ policyVersion: 1, producingSourcesPerWallet: 1, grossPerWalletUtcDay: 15,
      grossPerCadence: 1, cadenceSec: 5760, maxLeaseSec: 86400,
      // Historical v1 receipts keep this lineage even after current tax tuning.
      taxPolicyVersion: 1, taxBasisPoints: 10000, islandPoolBps: 2000 });
    const result = plan(interval(), MIDNIGHT + 3 * DAY, ZERO);
    expect(result.events).toHaveLength(15);
    expect(result.events.map(e => e.ordinal)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(result.events.every(e => e.grossQuantity === '1' && e.resourceId === 'crown_iron_ore')).toBe(true);
    expect(result.events.at(-1)?.earnedAtMs).toBe(result.leaseExpiresAtMs);
  });
  it.each(PHASE_E_RAW_RESOURCE_IDS)('uses the original native resource for %s, never caller-selected output', resource => {
    const result = plan(interval({ realmId: PHASE_E_RAW_RESOURCES[resource].realmId }), MIDNIGHT + STEP, ZERO);
    expect(result.events.map(e => e.resourceId)).toEqual([resource]);
  });
  it('does not earn partial progress and includes the exact cadence cutoff', () => {
    expect(plan(interval(), MIDNIGHT, ZERO).events).toEqual([]);
    expect(plan(interval(), MIDNIGHT + STEP - 1, ZERO).events).toEqual([]);
    expect(plan(interval(), MIDNIGHT + STEP, ZERO).events.map(e => e.ordinal)).toEqual([1]);
  });
  it('refuses omitted potential earning days instead of inventing zero historical use', () => {
    expect(() => plan(interval(), MIDNIGHT + STEP, [])).toThrow('Missing authoritative daily allowance history');
    // First-day history cannot authorize the next-day unit at lease expiry.
    expect(() => plan(interval(), MIDNIGHT + DAY, [ZERO[0]!])).toThrow('Missing authoritative daily allowance history');
    expect(plan(interval(), MIDNIGHT + STEP - 1, []).events).toEqual([]);
    expect(plan(interval(), MIDNIGHT + STEP, [ZERO[0]!]).events.map(e => e.ordinal)).toEqual([1]);
  });
  it('never assigns a unit at the exclusive term end to the original winners', () => {
    const source = interval({ term: { ...interval().term, endsAtMs: MIDNIGHT + STEP } });
    const result = plan(source, MIDNIGHT + DAY, [ZERO[0]!]);
    expect(result.leaseExpiresAtMs).toBe(source.term.endsAtMs);
    expect(result.events).toEqual([]);
    source.term.endsAtMs++;
    const extended = plan(source, MIDNIGHT + DAY, [ZERO[0]!]);
    expect(extended.leaseExpiresAtMs).toBe(source.term.endsAtMs);
    expect(extended.events.map(e => e.ordinal)).toEqual([1]);
  });
  it('a late observation retains earned units without filling the expired or unknown-term gap', () => {
    const source = interval({ term: { ...interval().term, endsAtMs: MIDNIGHT + 2 * STEP } });
    const early = plan(source, MIDNIGHT + STEP, [ZERO[0]!]);
    const delayed = plan(source, MIDNIGHT + 50 * DAY, [ZERO[0]!]);
    expect(delayed.events).toEqual(early.events);
    expect(plan(interval(), MIDNIGHT + 50 * DAY, ZERO).events).toEqual(plan(interval(), MIDNIGHT + DAY, ZERO).events);
  });
  it('assigns a midnight completion to the next UTC day, not the admission day', () => {
    const source = interval({ admittedAtMs: MIDNIGHT + DAY - STEP });
    const result = plan(source, MIDNIGHT + DAY, [{ utcDayStartMs: MIDNIGHT, grossUnits: 15 }, ZERO[1]!]);
    expect(result.events).toMatchObject([{ ordinal: 1, earnedAtMs: MIDNIGHT + DAY, utcDayStartMs: MIDNIGHT + DAY }]);
    expect(plan(source, MIDNIGHT + DAY, [{ utcDayStartMs: MIDNIGHT + DAY, grossUnits: 15 }]).events).toEqual([]);
  });
  it('caps gross against prior wallet history and keeps ordinals when the next day resumes', () => {
    const source = interval({ admittedAtMs: MIDNIGHT + DAY / 2 });
    const result = plan(source, source.admittedAtMs + DAY, [{ utcDayStartMs: MIDNIGHT, grossUnits: 14 }, ZERO[1]!]);
    expect(result.events.map(e => e.ordinal)).toEqual([1, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(result.events.filter(e => e.utcDayStartMs === MIDNIGHT)).toHaveLength(1);
  });
  it('different bases and resources cannot turn shared usage into fresh same-day allowance', () => {
    const usage = [{ utcDayStartMs: MIDNIGHT, grossUnits: 15 }];
    for (const resource of PHASE_E_RAW_RESOURCE_IDS) {
      expect(plan(interval({ sourceId: id(5), baseId: id(6), realmId: PHASE_E_RAW_RESOURCES[resource].realmId }),
        MIDNIGHT + STEP, usage).events).toEqual([]);
    }
  });
  it('is deterministic and does not mutate or expose mutable caller data', () => {
    const source = interval(), usage = [{ utcDayStartMs: MIDNIGHT, grossUnits: 1 }, { ...ZERO[1]! }];
    const before = structuredClone({ source, usage }), result = plan(source, MIDNIGHT + DAY, usage);
    expect({ source, usage }).toEqual(before);
    expect(result).toEqual(plan(source, MIDNIGHT + DAY, usage));
    source.term.hash = 'b'.repeat(64); source.baseId = id(7); usage[0]!.grossUnits = 15;
    expect(result.interval.term.hash).toBe('a'.repeat(64));
    expect(result.interval.baseId).toBe(before.source.baseId);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.interval.term)).toBe(true);
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER, '1', null])('rejects malformed cutoff %s instead of coercing time', cutoff => {
    expect(() => plan(interval(), cutoff as number, ZERO)).toThrow();
  });
  it('rejects admission outside its genuine-term shape or overflowing lease, without asserting authenticity', () => {
    expect(() => plan(interval({ admittedAtMs: MIDNIGHT - DAY - 1 }), MIDNIGHT, ZERO)).toThrow();
    expect(() => plan(interval({ admittedAtMs: MIDNIGHT + 3 * DAY }), MIDNIGHT + 4 * DAY, ZERO)).toThrow();
    expect(() => plan(interval({ admittedAtMs: 8_640_000_000_000_000 - STEP,
      term: { ...interval().term, endsAtMs: 8_640_000_000_000_000 } }), 8_640_000_000_000_000, ZERO)).toThrow();
    expect(() => plan(interval(), MIDNIGHT - 1, ZERO)).toThrow();
  });
  it.each([-1, 16, 0.5, '1', NaN])('rejects malformed or impossible gross allowance %s', grossUnits => {
    expect(() => plan(interval(), MIDNIGHT + STEP, [{ utcDayStartMs: MIDNIGHT, grossUnits: grossUnits as number }])).toThrow();
  });
  it('rejects duplicate/non-midnight/unrelated day history rather than resetting or double-counting quota', () => {
    const day = { utcDayStartMs: MIDNIGHT, grossUnits: 1 };
    expect(() => plan(interval(), MIDNIGHT + STEP, [day, day])).toThrow();
    expect(() => plan(interval(), MIDNIGHT + STEP, [{ ...day, utcDayStartMs: MIDNIGHT + 1 }])).toThrow();
    expect(() => plan(interval(), MIDNIGHT + STEP, [{ ...day, utcDayStartMs: MIDNIGHT - DAY }])).toThrow();
    expect(() => plan(interval(), MIDNIGHT + STEP, [{ ...day, utcDayStartMs: MIDNIGHT + 2 * DAY }])).toThrow();
  });
  it('rejects unknown versions and extra fields pretending to grant yield or an independent resource cap', () => {
    expect(() => plan({ ...interval(), policyVersion: 2 } as never, MIDNIGHT + STEP, ZERO)).toThrow();
    expect(() => plan({ ...interval(), grossPerCadence: 100 } as never, MIDNIGHT + STEP, ZERO)).toThrow();
    expect(() => plan(interval(), MIDNIGHT + STEP, [{ utcDayStartMs: MIDNIGHT, grossUnits: 0, resourceId: 'crown_iron_ore' } as never])).toThrow();
  });
});
