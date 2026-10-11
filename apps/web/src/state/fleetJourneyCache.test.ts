/** @vitest-environment happy-dom */
/** Direct cache callers (including Hero hydration) must not retain one-shot
 * server callbacks or make them available to later screens. */
import { afterEach, describe, expect, it } from 'vitest';
import { captureBaseSnapshotGuard, commitBaseSnapshot, useApp, type BaseStateDto } from './store';
const balances = { shards: '10', keep: '20', keepRate: 1 };
const callbacks = { version: 1 as const, events: [{ version: 1 as const, kind: 'return' as const,
  baseId: '00000000-0000-4000-8000-000000000001', berthId: '00000000-0000-4000-8000-000000000002',
  installationId: '00000000-0000-4000-8000-000000000003', expeditionId: '00000000-0000-4000-8000-000000000004',
  returnId: '00000000-0000-4000-8000-000000000005', at: '2026-10-01T03:52:08.000Z',
  vehicle: { family: 'starter' as const }, wake: { state: 'legacy' as const, visual: null },
}] };
function base(): BaseStateDto {
  return { baseId: '00000000-0000-4000-8000-000000000001',
    player: { wallet: 'wallet-a', name: 'Keeper', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1 };
}
afterEach(() => useApp.getState().setAuth(null));
describe('fleet journey transient cache boundary', () => {
  it('strips callbacks from direct commits without mutating the HTTP response or copying already-clean snapshots', () => {
    useApp.getState().setAuth('wallet-a');
    const clean = base(), raw = { ...clean, fleetJourneyEvents: callbacks };
    expect(commitBaseSnapshot(captureBaseSnapshotGuard(), clean.baseId!, raw, balances)).toBe(true);
    expect(useApp.getState().base).toEqual(clean); expect(useApp.getState().base).not.toHaveProperty('fleetJourneyEvents');
    expect(raw.fleetJourneyEvents).toBe(callbacks);
    expect(commitBaseSnapshot(captureBaseSnapshotGuard(), clean.baseId!, clean, balances)).toBe(true);
    expect(useApp.getState().base).toBe(clean);
    const malformed = { ...clean, fleetJourneyEvents: 'untrusted malformed sibling' } as unknown as BaseStateDto;
    expect(commitBaseSnapshot(captureBaseSnapshotGuard(), clean.baseId!, malformed, balances)).toBe(true);
    expect(useApp.getState().base).toEqual(clean); expect(useApp.getState().base).not.toHaveProperty('fleetJourneyEvents');
  });
  it('keeps the direct setter and null clearing free of cached one-shot callbacks', () => {
    const clean = base(), raw = { ...clean, fleetJourneyEvents: callbacks };
    useApp.getState().setBase(raw); expect(useApp.getState().base).toEqual(clean);
    expect(raw).toHaveProperty('fleetJourneyEvents');
    useApp.getState().setBase(clean); expect(useApp.getState().base).toBe(clean);
    useApp.getState().setBase(null); expect(useApp.getState().base).toBeNull();
  });
  it('preserves the existing auth and selection fence when a stale direct caller has callbacks', () => {
    useApp.getState().setAuth('wallet-a'); const guard = captureBaseSnapshotGuard();
    useApp.getState().setAuth('wallet-b');
    expect(commitBaseSnapshot(guard, base().baseId!, { ...base(), fleetJourneyEvents: { version: 1, events: [] } }, balances)).toBe(false);
    expect(useApp.getState().base).toBeNull();
  });
});
