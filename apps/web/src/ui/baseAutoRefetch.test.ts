import { WARZONE } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { baseAutoRefetchDelay } from './baseAutoRefetch';

describe('baseAutoRefetchDelay', () => {
  const now = Date.parse('2026-08-13T09:00:00.000Z');

  it('refreshes at the first hero recovery deadline', () => {
    expect(baseAutoRefetchDelay({
      jobs: [], shield: null,
      heroes: [{
        hero: 'theodor', available: false,
        recoveryUntil: '2026-08-13T09:01:00.000Z',
      }],
    }, now)).toBe(61_500);
  });

  it('retries an elapsed unavailable hero but not a server-confirmed ready hero', () => {
    const hero = {
      hero: 'vex' as const, recoveryUntil: '2026-08-13T08:59:00.000Z', available: false,
    };
    expect(baseAutoRefetchDelay({
      jobs: [], shield: null, heroes: [hero],
    }, now)).toBe(2_000);
    expect(baseAutoRefetchDelay({
      jobs: [], shield: null, heroes: [{ ...hero, available: true }],
    }, now)).toBeNull();
  });

  it('refreshes at the next base-wide troop completion and retries only while it remains queued', () => {
    const armyStatus = {
      readyTroopCount: 3,
      readyPts: 6,
      campCapacityPts: 20,
      trainingTroopCount: 2,
      trainingPts: 4,
      barracksQueuePts: 10,
      nextReadyAt: '2026-08-13T09:01:00.000Z',
      allReadyAt: '2026-08-13T09:02:00.000Z',
    };
    const base = { jobs: [], shield: null, heroes: [], armyStatus };

    expect(baseAutoRefetchDelay(base, now)).toBe(61_500);
    expect(baseAutoRefetchDelay(base, Date.parse(armyStatus.nextReadyAt))).toBe(2_000);
    expect(baseAutoRefetchDelay({
      ...base,
      armyStatus: {
        ...armyStatus,
        trainingTroopCount: 0,
        trainingPts: 0,
        nextReadyAt: null,
        allReadyAt: null,
      },
    }, Date.parse(armyStatus.nextReadyAt))).toBeNull();
  });

  it('polls before a later scheduled start because runtime mode can change first', () => {
    const boundaryAt = '2026-08-13T09:05:00.000Z';
    const base = {
      jobs: [], heroes: [],
      shield: { activeUntil: '2026-08-15T09:00:00.000Z', hoursLeft: 48, active: true },
      warzone: { active: false, boundaryAt, remainingMs: 300_000 },
    };
    expect(baseAutoRefetchDelay(base, now)).toBe(WARZONE.currentPhasePollSec * 1_000);
    expect(baseAutoRefetchDelay(base, Date.parse(boundaryAt))).toBe(2_000);
  });

  it('polls before a later active end because an admin can turn the mode off', () => {
    const boundaryAt = '2026-08-13T10:00:00.000Z';
    const base = {
      jobs: [], heroes: [],
      shield: {
        activeUntil: '2026-08-15T09:00:00.000Z', hoursLeft: 48, active: false,
        suppressedByWarzone: true,
      },
      warzone: { active: true, boundaryAt, remainingMs: 3_600_000 },
    };
    expect(baseAutoRefetchDelay(base, now)).toBe(WARZONE.currentPhasePollSec * 1_000);
    expect(baseAutoRefetchDelay(base, Date.parse(boundaryAt))).toBe(2_000);
  });

  it('low-frequency polls current phase when an unannounced start has no boundary', () => {
    const base = {
      jobs: [], heroes: [], shield: null,
      warzone: { active: false, boundaryAt: null, remainingMs: null },
    };
    expect(baseAutoRefetchDelay(base, now)).toBe(WARZONE.currentPhasePollSec * 1_000);

    // The current-phase check must not delay an unrelated, earlier game clock.
    expect(baseAutoRefetchDelay({
      ...base,
      heroes: [{
        hero: 'vex' as const, available: false,
        recoveryUntil: new Date(now + 10_000).toISOString(),
      }],
    }, now)).toBe(11_500);
  });

  it('lets an earlier disclosed boundary win over the current-phase heartbeat', () => {
    expect(baseAutoRefetchDelay({
      jobs: [], heroes: [], shield: null,
      warzone: {
        active: false,
        boundaryAt: new Date(now + 30_000).toISOString(),
        remainingMs: 30_000,
      },
    }, now)).toBe(31_500);
  });
});
