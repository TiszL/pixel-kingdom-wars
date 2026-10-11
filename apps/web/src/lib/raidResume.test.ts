import { describe, expect, it } from 'vitest';
import {
  choosePendingRaidRecovery, clearRaidResumePointer,
  installRaidRecoveryLifecycle, reconcileRaidResume, reconcileRaidResumeSingleFlight,
  readRaidResumePointer,
  RAID_RESUME_STORAGE_VERSION,
  writeRaidResumePointer,
  type RaidResumePointer,
} from './raidResume';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function pointer(overrides: Partial<RaidResumePointer> = {}): RaidResumePointer {
  return {
    version: RAID_RESUME_STORAGE_VERSION,
    wallet: 'wallet/A',
    baseId: 'base:1',
    raidId: 'raid-1',
    mode: 'pvp',
    role: 'attacker',
    phase: 'playing',
    target: { defenderBaseId: 'base-2' },
    clock: { revision: 3, rate: 2 },
    inFlightSpeed: null,
    ...overrides,
  };
}

describe('raid resume pointer', () => {
  it('round-trips only the small wallet/base-scoped canonical pointer', () => {
    const storage = memoryStorage();
    const value = pointer({
      inFlightSpeed: { clientCommandId: 'speed-4', expectedClockRevision: 3, rate: 1 },
    });
    writeRaidResumePointer(storage, value);

    expect(readRaidResumePointer(storage, 'wallet/A', 'base:1')).toEqual(value);
    expect(readRaidResumePointer(storage, 'wallet/B', 'base:1')).toBeNull();
    expect(storage.length).toBe(1);
    expect(storage.getItem(storage.key(0)!)).not.toContain('snapshot');
  });

  it('rejects and removes malformed or extra state instead of trusting it', () => {
    const storage = memoryStorage();
    writeRaidResumePointer(storage, pointer());
    const key = storage.key(0)!;
    storage.setItem(key, JSON.stringify({ ...pointer(), snapshot: { private: true } }));

    expect(readRaidResumePointer(storage, 'wallet/A', 'base:1')).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('rejects identity mismatches even when a value is copied under another key', () => {
    const storage = memoryStorage();
    writeRaidResumePointer(storage, pointer());
    const raw = storage.getItem(storage.key(0)!)!;
    writeRaidResumePointer(storage, pointer({ wallet: 'wallet/B' }));
    const walletBKey = storage.key(1)!;
    storage.setItem(walletBKey, raw);

    expect(readRaidResumePointer(storage, 'wallet/B', 'base:1')).toBeNull();
  });

  it('lets a terminal callback clear only its own raid', () => {
    const storage = memoryStorage();
    writeRaidResumePointer(storage, pointer({ raidId: 'raid-new' }));

    expect(clearRaidResumePointer(storage, 'wallet/A', 'base:1', 'raid-old')).toBe(false);
    expect(readRaidResumePointer(storage, 'wallet/A', 'base:1')?.raidId).toBe('raid-new');
    expect(clearRaidResumePointer(storage, 'wallet/A', 'base:1', 'raid-new')).toBe(true);
    expect(readRaidResumePointer(storage, 'wallet/A', 'base:1')).toBeNull();
  });

  it('fails open when device storage is unavailable', () => {
    const denied = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(() => writeRaidResumePointer(denied, pointer())).not.toThrow();
    expect(readRaidResumePointer(denied, 'wallet/A', 'base:1')).toBeNull();
    expect(clearRaidResumePointer(denied, 'wallet/A', 'base:1', 'raid-1')).toBe(false);
  });

  it('auto-resumes the sole current-SIM march even when another deed is selected', () => {
    const current = { id: 'current', attackerBaseId: 'base:1', simVersion: 13 };
    const otherDeed = { id: 'other-deed', attackerBaseId: 'base:2', simVersion: 13 };
    const oldSim = { id: 'old-sim', attackerBaseId: 'base:1', simVersion: 12 };
    expect(choosePendingRaidRecovery([current, otherDeed, oldSim], 'base:1', 13))
      .toEqual({ kind: 'history', raidIds: ['current', 'other-deed'] });
    expect(choosePendingRaidRecovery([otherDeed, oldSim], 'base:1', 13))
      .toEqual({ kind: 'resume', raid: otherDeed });
    expect(choosePendingRaidRecovery([current, oldSim], 'base:1', 13))
      .toEqual({ kind: 'resume', raid: current });
  });

  it('routes ambiguous canonical marches to history instead of guessing', () => {
    expect(choosePendingRaidRecovery([
      { id: 'raid-a', attackerBaseId: 'base:1', simVersion: 13 },
      { id: 'raid-b', attackerBaseId: 'base:1', simVersion: 13 },
    ], 'base:1', 13)).toEqual({ kind: 'history', raidIds: ['raid-a', 'raid-b'] });
  });

  it('lets an active authoritative stream outrank a stale terminal replay', async () => {
    const storage = memoryStorage();
    writeRaidResumePointer(storage, pointer());
    const pending = { id: 'raid-1', attackerBaseId: 'base:1', simVersion: 13 };
    const client = { get: async <T>(path: string): Promise<T> => {
      if (path.includes('/live?')) return { status: 'pending_orders' } as T;
      if (path.includes('/pending/')) return { raid: pending } as T;
      return { result: { stars: 3 } } as T;
    } };

    await expect(reconcileRaidResume({ client, storage, wallet: 'wallet/A', baseId: 'base:1', simVersion: 13 }))
      .resolves.toMatchObject({ kind: 'resume', raid: pending });
  });

  it('opens a canonical settled verdict without storing or replaying history locally', async () => {
    const storage = memoryStorage();
    writeRaidResumePointer(storage, pointer());
    const result = {
      stars: 2, destructionPct: 73, keepDestroyed: true,
      lootShards: 42, attackerTrophyDelta: 7,
    };
    const client = { get: async <T>(path: string): Promise<T> => {
      if (path.includes('/replay')) return { result } as T;
      throw Object.assign(new Error('not found'), { status: 404 });
    } };

    await expect(reconcileRaidResume({ client, storage, wallet: 'wallet/A', baseId: 'base:1', simVersion: 13 }))
      .resolves.toMatchObject({ kind: 'result', target: { result, resumeTerminal: true } });
    expect(readRaidResumePointer(storage, 'wallet/A', 'base:1')?.raidId).toBe('raid-1');
  });

  it('falls through from an absent stale pointer to wallet-wide pending recovery', async () => {
    const storage = memoryStorage();
    writeRaidResumePointer(storage, pointer({ raidId: 'stale' }));
    const current = { id: 'current', attackerBaseId: 'base:1', simVersion: 13 };
    const client = { get: async <T>(path: string): Promise<T> => {
      if (path === '/raids/pending') return { raids: [current] } as T;
      throw Object.assign(new Error('not found'), { status: 404 });
    } };
    await expect(reconcileRaidResume({ client, storage, wallet: 'wallet/A', baseId: 'base:1', simVersion: 13 }))
      .resolves.toMatchObject({ kind: 'resume', raid: current });
  });

  it('carries the exact in-flight speed id into resumed navigation', async () => {
    const storage = memoryStorage();
    const inFlightSpeed = { clientCommandId: 'speed-lost', expectedClockRevision: 3, rate: 1 as const };
    writeRaidResumePointer(storage, pointer({ inFlightSpeed }));
    const pending = { id: 'raid-1', attackerBaseId: 'base:1', simVersion: 13 };
    const client = { get: async <T>(path: string): Promise<T> => {
      if (path.includes('/live?')) return { status: 'pending_orders' } as T;
      if (path.includes('/pending/')) return { raid: pending } as T;
      throw Object.assign(new Error('not found'), { status: 404 });
    } };
    await expect(reconcileRaidResume({ client, storage, wallet: 'wallet/A', baseId: 'base:1', simVersion: 13 }))
      .resolves.toMatchObject({ kind: 'resume', target: { inFlightSpeed } });
  });

  it('recovers a sole other-deed raid with its own unresolved speed request', async () => {
    const storage = memoryStorage();
    const inFlightSpeed = { clientCommandId: 'speed-other-deed', expectedClockRevision: 2, rate: 2 as const };
    writeRaidResumePointer(storage, pointer({ baseId: 'base:2', inFlightSpeed }));
    const pending = { id: 'raid-1', attackerBaseId: 'base:2', simVersion: 13 };
    const client = { get: async <T>(): Promise<T> => ({ raids: [pending] } as T) };
    await expect(reconcileRaidResume({ client, storage, wallet: 'wallet/A', baseId: 'base:1', simVersion: 13 }))
      .resolves.toMatchObject({ kind: 'resume', raid: pending, target: { inFlightSpeed } });
  });

  it('coalesces simultaneous lifecycle probes for one wallet/base identity', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = async () => { runs++; await gate; return { kind: 'none' as const }; };
    const first = reconcileRaidResumeSingleFlight('wallet:base', run);
    const second = reconcileRaidResumeSingleFlight('wallet:base', run);
    expect(second).toBe(first);
    expect(runs).toBe(1);
    release();
    await first;
  });

  it('reconciles pageshow, online, and only visible visibility changes', () => {
    const winListeners = new Map<string, EventListener>();
    const docListeners = new Map<string, EventListener>();
    let visibilityState: DocumentVisibilityState = 'hidden';
    let runs = 0;
    const cleanup = installRaidRecoveryLifecycle({
      win: {
        addEventListener: (type: 'pageshow' | 'online', listener: EventListener) => {
          winListeners.set(type, listener);
        },
        removeEventListener: (type: 'pageshow' | 'online') => { winListeners.delete(type); },
      },
      doc: {
        addEventListener: (type: 'visibilitychange', listener: EventListener) => {
          docListeners.set(type, listener);
        },
        removeEventListener: (type: 'visibilitychange') => { docListeners.delete(type); },
        get visibilityState() { return visibilityState; },
      },
      reconcile: () => { runs++; },
    });
    winListeners.get('pageshow')!(new Event('pageshow'));
    winListeners.get('online')!(new Event('online'));
    docListeners.get('visibilitychange')!(new Event('visibilitychange'));
    visibilityState = 'visible';
    docListeners.get('visibilitychange')!(new Event('visibilitychange'));
    expect(runs).toBe(3);
    cleanup();
    expect(winListeners.size + docListeners.size).toBe(0);
  });
});
