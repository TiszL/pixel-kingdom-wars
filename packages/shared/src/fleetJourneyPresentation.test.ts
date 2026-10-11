import { describe, expect, it } from 'vitest';
import { FleetJourneyEventSchema, fleetJourneyEventKey, matchFleetJourneyEventBatch } from './fleetJourneyPresentation';

const baseId = '00000000-0000-4000-8000-000000000001';
const departure = {
  version: 1 as const, kind: 'departure' as const, baseId,
  berthId: '00000000-0000-4000-8000-000000000002',
  installationId: '00000000-0000-4000-8000-000000000003',
  expeditionId: '00000000-0000-4000-8000-000000000004',
  at: '2026-10-01T03:52:08.000Z', vehicle: { family: 'starter' as const },
  wake: { state: 'legacy' as const, visual: null },
};

describe('transient journey presentation contract', () => {
  it('keeps historical absence, actual Off and unavailable Wake distinct', () => {
    const wakes = [departure.wake, { state: 'unavailable', visual: null },
      { state: 'available', visual: { version: 1, wake: null } }];
    expect(wakes.map(wake => FleetJourneyEventSchema.parse({ ...departure, wake }).wake))
      .toEqual(wakes);
    expect(FleetJourneyEventSchema.safeParse({ ...departure, wake: undefined }).success).toBe(false);
  });

  it('requires the actual return identity and separates it from departure deduplication', () => {
    expect(FleetJourneyEventSchema.safeParse({ ...departure, kind: 'return' }).success).toBe(false);
    const returnId = '00000000-0000-4000-8000-000000000005';
    const returned = FleetJourneyEventSchema.parse({ ...departure, kind: 'return', returnId });
    expect(fleetJourneyEventKey(returned)).not.toBe(fleetJourneyEventKey(departure));
    expect(FleetJourneyEventSchema.safeParse({ ...departure, returnId }).success).toBe(false);
  });

  it('rejects private actor data and impossible family/tier combinations', () => {
    expect(FleetJourneyEventSchema.safeParse({ ...departure, actorWallet: 'private' }).success).toBe(false);
    expect(FleetJourneyEventSchema.safeParse({ ...departure, vehicle: { family: 'starter', tier: 1 } }).success).toBe(false);
    expect(FleetJourneyEventSchema.safeParse({ ...departure, vehicle: { family: 'survey_balloon' } }).success).toBe(false);
    expect(FleetJourneyEventSchema.parse({ ...departure, vehicle: { family: 'survey_balloon', tier: 1 } }).vehicle)
      .toEqual({ family: 'survey_balloon', tier: 1 });
  });

  it('refuses duplicate or foreign-base callbacks instead of replaying them in the current scene', () => {
    expect(() => matchFleetJourneyEventBatch({ version: 1, events: [departure, departure] }, baseId)).toThrow();
    expect(() => matchFleetJourneyEventBatch({ version: 1, events: [departure] },
      '00000000-0000-4000-8000-000000000006')).toThrow();
    expect(matchFleetJourneyEventBatch({ version: 1, events: [departure] }, baseId).events).toEqual([departure]);
    const advanced = { ...departure, vehicle: { family: 'survey_balloon', tier: 1 } };
    expect(matchFleetJourneyEventBatch({ version: 1, events: [departure, advanced] }, baseId).events).toHaveLength(2);
  });
});
