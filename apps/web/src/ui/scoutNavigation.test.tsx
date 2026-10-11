/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unsupportedGroundRevision } from '@shardkeep/shared/baseVisual';
import { bus } from '../lib/events';
import { useApp } from '../state/store';
const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api', async (original) => ({ ...await original<typeof import('../lib/api')>(), api: { get: mocks.get } }));
import { openScout } from './scoutNavigation';
import { ScoutHud } from './ScoutHud';
import { RaidLogScreen } from './screens/raidlog';

describe('explicit raid scouting navigation', () => {
  let root: Root;
  let host: HTMLDivElement;
  const target = { kind: 'pvp' as const, wallet: 'opponent', defenderBaseId: 'opponent-base', name: 'OPPONENT' };
  const snapshot = { name: 'OPPONENT', keepLevel: 5, trophies: 20, previewSec: 60, buildings: [] };
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useApp.setState({ screen: 'raidlog', wallet: 'local-test', base: null, selectedBaseId: 'owned-base',
      baseDirectory: null, raidTarget: null, scoutReport: null });
    mocks.get.mockReset().mockResolvedValue(snapshot);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  it('keeps the exact opponent base and returns to history when preview closes', async () => {
    await openScout(target, 'raidlog');
    expect(mocks.get).toHaveBeenCalledWith('/map/scout/opponent-base?baseId=owned-base');
    expect(useApp.getState().scoutReport).toMatchObject({ returnScreen: 'raidlog', attackTarget: target });
    await act(async () => root.render(<ScoutHud />));
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CLOSE'))!.click());
    expect(useApp.getState().screen).toBe('raidlog');
    expect(useApp.getState().scoutReport).toBeNull();
    expect(useApp.getState().raidTarget).toBeNull();
  });

  it('starts only the chosen target through normal raid creation after explicit ATTACK', async () => {
    await openScout(target, 'raidlog');
    const exit = vi.fn(); const off = bus.on('battle:exit', exit);
    try {
      await act(async () => root.render(<ScoutHud />));
      await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('ATTACK'))!.click());
      expect(useApp.getState().screen).toBe('battle');
      expect(useApp.getState().raidTarget).toEqual(target);
      expect(useApp.getState().scoutReport).toBeNull();
      expect(exit).toHaveBeenCalledOnce();
    } finally { off(); }
  });

  it('preserves map eligibility while allowing read-only scouting', async () => {
    useApp.getState().setScreen('map');
    await openScout(target, 'map', 'SHIELDED — CANNOT BE RAIDED');
    await act(async () => root.render(<ScoutHud />));
    const attack = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('ATTACK'))!;
    expect(attack.disabled).toBe(true);
    await act(async () => attack.click());
    expect(useApp.getState().screen).toBe('scout');
    expect(useApp.getState().raidTarget).toBeNull();
  });
  it('measures scout chrome without reserving a nonexistent combat troop tray', async () => {
    await openScout(target, 'raidlog');
    const emit = vi.fn(); const off = bus.on('battle:insets', emit);
    try {
      await act(async () => root.render(<ScoutHud />));
      const hud = host.firstElementChild as HTMLElement;
      vi.spyOn(hud, 'getBoundingClientRect').mockReturnValue({ bottom: 72, top: 8, height: 64 } as DOMRect);
      bus.emit('battle:insetsRequest', undefined);
      expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ top: 72, bottom: 0 }));
      await act(async () => root.render(null)); emit.mockClear();
      bus.emit('battle:insetsRequest', undefined); expect(emit).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it.each(['screen', 'wallet', 'selectedBaseId', 'baseSelectionEpoch'] as const)('ignores a scout response after %s changes', async (field) => {
    let complete!: (value: typeof snapshot) => void;
    mocks.get.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = openScout(target, 'raidlog');
    if (field === 'screen') useApp.getState().setScreen('base');
    else if (field === 'baseSelectionEpoch') useApp.setState({ baseSelectionEpoch: useApp.getState().baseSelectionEpoch + 1 });
    else useApp.setState({ [field]: 'replacement' });
    complete(snapshot); await pending;
    expect(useApp.getState().scoutReport).toBeNull();
  });

  it('hands a newer ground revision to the scene unresolved, so the reload prompt still fires', async () => {
    // WHY: SceneGround.set is the one detector for art newer than this bundle (the "old realms"
    // prompt). Resolving the context here first dropped revision 6 to the frozen fallback, so a
    // stale tab scouting a newer base painted old ground and never asked for a reload.
    const visualContext = { version: 1, realmId: 'frostveil', artVersion: 2, groundRevision: 6 };
    mocks.get.mockResolvedValue({ ...snapshot, visualContext });
    const enter = vi.fn(); const off = bus.on('battle:enter', enter);
    try {
      await openScout(target, 'raidlog');
      expect(enter).toHaveBeenCalledOnce();
      const payload = enter.mock.calls[0]![0] as { visualContext?: unknown; scout?: boolean };
      expect(payload).toMatchObject({ scout: true, visualContext });
      expect(unsupportedGroundRevision(payload.visualContext)).toBe(6);
    } finally { off(); }
  });

  it('closes battle history directly to the base rather than Settings', async () => {
    mocks.get.mockResolvedValue({ raids: [] });
    await act(async () => root.render(<RaidLogScreen />));
    await act(async () => (host.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
    expect(useApp.getState().screen).toBe('base');
  });
});
