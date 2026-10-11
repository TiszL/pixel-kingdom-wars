import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureBasePanels, captureBaseSnapshotGuard, clearBaseSnapshot, commitBaseSnapshot, useApp, type BaseStateDto } from '../../state/store';
import { bus } from '../../lib/events';
import { EmptyTapGesture } from '../../game/input/emptyTap';

import { createBaseFeatureRegistry } from './featureRegistry';
const fixtureRegistry = createBaseFeatureRegistry(['building.info', 'account.profile', 'account.recovery', 'army.train'].map(id => ({ id, kind: id.startsWith('building') ? 'info' as const : id.startsWith('army') ? 'army' as const : 'account' as const, label: id, size: 'HALF' as const, readOnly: true, load: async () => ({ default: () => null }) })));
beforeEach(() => { configureBasePanels(fixtureRegistry, true); useApp.getState().setAuth('wallet-a'); useApp.getState().setScreen('base'); });
afterEach(() => useApp.getState().setAuth(null));

describe('base panels preserve the live world and current authority', () => {
  it('opens over base without changing selection or the scene route', () => {
    useApp.getState().select('b1');
    useApp.getState().openBasePanel({ kind: 'info', featureId: 'building.info', buildingId: 'b1' });
    expect(useApp.getState()).toMatchObject({ screen: 'base', selectedBuildingId: 'b1', basePanel: { kind: 'info', buildingId: 'b1' } });
  });
  it('atomically retires placement and old screen state when opening from another route', () => {
    useApp.getState().setScreen('map'); useApp.getState().setPlacing('wall');
    const seen: unknown[] = []; const stop = useApp.subscribe((s) => seen.push({ screen: s.screen, placing: s.placing, panel: s.basePanel }));
    useApp.getState().openBasePanel({ kind: 'account', featureId: 'account.profile' }); stop();
    expect(seen).toEqual([{ screen: 'base', placing: null, panel: { kind: 'account', featureId: 'account.profile' } }]);
  });
  it('retargets building information without retaining an unrelated obstacle identity', () => {
    useApp.getState().openBasePanel({ kind: 'info', featureId: 'building.info', buildingId: 'b1' });
    useApp.getState().select('b2');
    expect(useApp.getState().basePanel).toMatchObject({ kind: 'info', buildingId: 'b2' });
    useApp.getState().selectObstacle('o1');
    expect(useApp.getState().basePanel).toBeNull();
  });
  it('closes a building operation when its selected building changes', () => {
    useApp.getState().openBasePanel({ kind: 'army', featureId: 'army.train', buildingId: 'b1' });
    useApp.getState().select('b2'); expect(useApp.getState().basePanel).toBeNull();
  });
  it('keeps an unbound account recovery door through deselection', () => {
    const panel = { kind: 'account' as const, featureId: 'account.recovery' };
    useApp.getState().openBasePanel(panel); useApp.getState().select(null);
    expect(useApp.getState().basePanel).toEqual(panel);
  });
  it.each(['route', 'placement', 'wallet', 'base'] as const)('closes stale panels on %s change', (change) => {
    useApp.getState().setSelectedBaseId('base-a', false);
    useApp.getState().openBasePanel({ kind: 'army', featureId: 'army.train', buildingId: 'b1' });
    if (change === 'route') useApp.getState().setScreen('inventory');
    if (change === 'placement') useApp.getState().setPlacing('wall');
    if (change === 'wallet') useApp.getState().setAuth('wallet-b');
    if (change === 'base') useApp.getState().setSelectedBaseId('base-b', false);
    expect(useApp.getState().basePanel).toBeNull();
  });
  it('keeps the panel when the selected base identity has not changed', () => {
    useApp.getState().setSelectedBaseId('base-a', false);
    useApp.getState().openBasePanel({ kind: 'army', featureId: 'army.train', buildingId: 'b1' });
    useApp.getState().setSelectedBaseId('base-a', false);
    expect(useApp.getState().basePanel?.featureId).toBe('army.train');
  });
  it('closing an already closed panel does not notify scene subscribers', () => {
    const notify = vi.fn(); const stop = useApp.subscribe(notify);
    useApp.getState().closeBasePanel(); stop(); expect(notify).not.toHaveBeenCalled();
  });
});

describe('authoritative base snapshots retire stale panel custody', () => {
  const base: BaseStateDto = { player: { wallet: 'wallet-a', name: 'Keeper', keepLevel: 1, trophies: 0, league: 'bronze', builders: 1, expansions: 0 }, claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null, buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1 };
  it('clears the panel atomically when a guarded snapshot changes the selected base', () => {
    useApp.getState().setSelectedBaseId('base-a', false);
    useApp.getState().openBasePanel({ kind: 'account', featureId: 'account.recovery' });
    const guard = captureBaseSnapshotGuard();
    expect(commitBaseSnapshot(guard, 'base-b', base, { shards: '10', keep: '20', keepRate: 1 })).toBe(true);
    expect(useApp.getState().basePanel).toBeNull();
  });
  it('keeps a panel through same-base refresh but clears it with authority invalidation', () => {
    useApp.getState().setSelectedBaseId('base-a', false);
    useApp.getState().openBasePanel({ kind: 'account', featureId: 'account.recovery' });
    expect(commitBaseSnapshot(captureBaseSnapshotGuard(), 'base-a', base, { shards: '10', keep: '20', keepRate: 1 })).toBe(true);
    expect(useApp.getState().basePanel?.featureId).toBe('account.recovery');
    clearBaseSnapshot(false); expect(useApp.getState().basePanel).toBeNull();
  });
});
describe('empty-ground event belongs only to a complete stationary canvas gesture', () => {
  it('accepts a same-pointer empty release once', () => {
    const tap = new EmptyTapGesture(5); tap.begin(1, 10, 10, true);
    expect(tap.end(1, 11, 10, true)).toBe(true); expect(tap.end(1, 11, 10, true)).toBe(false);
  });
  it('does not reinterpret an out-and-back pan as a tap', () => {
    const tap = new EmptyTapGesture(5); tap.begin(1, 10, 10, true); tap.move(1, 30, 10);
    expect(tap.end(1, 10, 10, true)).toBe(false);
  });
  it('rejects object/placement/layout endpoints, foreign pointers and canceled/pinch gestures', () => {
    const tap = new EmptyTapGesture(5);
    tap.begin(1, 10, 10, false); expect(tap.end(1, 10, 10, true)).toBe(false);
    tap.begin(1, 10, 10, true); expect(tap.end(1, 10, 10, false)).toBe(false);
    tap.begin(1, 10, 10, true); expect(tap.end(2, 10, 10, true)).toBe(false);
    tap.begin(1, 10, 10, true); tap.cancel(); expect(tap.end(1, 10, 10, true)).toBe(false);
    tap.begin(1, 10, 10, true); expect(tap.end(1, 30, 10, true)).toBe(false);
  });
});

describe('opening a panel retires the existing scene placement owner', () => {
  it('ends an armed ghost once without changing normal panel opens', () => {
    const ended = vi.fn(); const off = bus.on('build:end', ended);
    try {
      useApp.getState().setScreen('build'); useApp.getState().setPlacing('wall');
      useApp.getState().openBasePanel({ kind: 'account', featureId: 'account.recovery' });
      expect(ended).toHaveBeenCalledTimes(1);
      expect(useApp.getState()).toMatchObject({ screen: 'base', placing: null });
      useApp.getState().openBasePanel({ kind: 'account', featureId: 'account.profile' });
      expect(ended).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });
});
