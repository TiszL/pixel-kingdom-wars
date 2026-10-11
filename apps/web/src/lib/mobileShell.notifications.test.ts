import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localCompletionFallbackEnabled, naturalCompletionToasts, PUSH_ENDPOINT_KEY, PUSH_FLAG_KEY,
} from './mobileShell';

// D-101: foreground feedback is derived only from an authoritative refresh
// that removes a deadline which has actually elapsed. Cancellation, speed-up,
// account/base changes and malformed dates must never impersonate completion.

const NOW = Date.parse('2026-09-03T10:00:00.000Z');
const due = '2026-09-03T09:59:59.000Z';
const future = '2026-09-03T10:05:00.000Z';

function snapshot(overrides: Partial<{
  baseId: string | null;
  wallet: string;
  jobs: Array<{ id: string; kind: string; finishesAt: string }>;
  trainingTroopCount: number;
  nextReadyAt: string | null;
}> = {}) {
  return {
    baseId: overrides.baseId ?? 'base-a',
    player: { wallet: overrides.wallet ?? 'wallet-a' },
    jobs: overrides.jobs ?? [],
    armyStatus: {
      trainingTroopCount: overrides.trainingTroopCount ?? 0,
      nextReadyAt: overrides.nextReadyAt ?? null,
    },
  };
}

describe('naturalCompletionToasts', () => {
  it('names each naturally completed builder job truthfully', () => {
    const previous = snapshot({ jobs: [
      { id: 'b', kind: 'build', finishesAt: due },
      { id: 'u', kind: 'upgrade', finishesAt: due },
      { id: 'r', kind: 'repair', finishesAt: due },
      { id: 'o', kind: 'clear_obstacle', finishesAt: due },
    ] });
    expect(naturalCompletionToasts(previous, snapshot(), NOW)).toEqual([
      'CONSTRUCTION COMPLETE — YOUR BUILDER IS FREE',
      'UPGRADE COMPLETE — YOUR BUILDER IS FREE',
      'REPAIR COMPLETE — YOUR BUILDER IS FREE',
      'OBSTACLE CLEARED — YOUR BUILDER IS FREE',
    ]);
  });

  it('does not call a cancellation, paid speed-up, unknown job or bad date natural', () => {
    const previous = snapshot({ jobs: [
      { id: 'cancelled', kind: 'build', finishesAt: future },
      { id: 'unknown', kind: 'future_kind', finishesAt: due },
      { id: 'bad', kind: 'upgrade', finishesAt: 'not-a-date' },
      { id: 'still-there', kind: 'build', finishesAt: due },
    ] });
    const next = snapshot({ jobs: [{ id: 'still-there', kind: 'build', finishesAt: due }] });
    expect(naturalCompletionToasts(previous, next, NOW)).toEqual([]);
  });

  it('toasts a due training completion only when the authoritative queue shrank', () => {
    const previous = snapshot({ trainingTroopCount: 3, nextReadyAt: due });
    expect(naturalCompletionToasts(
      previous,
      snapshot({ trainingTroopCount: 2, nextReadyAt: future }),
      NOW,
    )).toEqual(['TRAINING COMPLETE — TROOPS IN CAMP']);
    expect(naturalCompletionToasts(
      previous,
      snapshot({ trainingTroopCount: 3, nextReadyAt: due }),
      NOW,
    )).toEqual([]);
    expect(naturalCompletionToasts(
      snapshot({ trainingTroopCount: 3, nextReadyAt: future }),
      snapshot({ trainingTroopCount: 0, nextReadyAt: null }),
      NOW,
    )).toEqual([]); // FINISH ALL/cancellation has its own feedback
  });

  it('never leaks a prior base or wallet completion into the new identity', () => {
    const previous = snapshot({ jobs: [{ id: 'b', kind: 'build', finishesAt: due }] });
    expect(naturalCompletionToasts(previous, snapshot({ baseId: 'base-b' }), NOW)).toEqual([]);
    expect(naturalCompletionToasts(previous, snapshot({ wallet: 'wallet-b' }), NOW)).toEqual([]);
  });
});

describe('hidden-tab completion fallback', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires explicit opt-in even when OS permission remains granted', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal('Notification', { permission: 'granted' });

    expect(localCompletionFallbackEnabled()).toBe(false); // toggle OFF
    values.set(PUSH_FLAG_KEY, '1');
    expect(localCompletionFallbackEnabled()).toBe(true); // opted in, push unavailable
    values.set(PUSH_ENDPOINT_KEY, 'https://push.example/live');
    expect(localCompletionFallbackEnabled()).toBe(false); // server push owns it
  });
});
