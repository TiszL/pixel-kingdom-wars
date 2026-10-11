/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import { RAID_RULES } from '@shardkeep/shared';
import frozenRaid from './__fixtures__/stage100-frozen-raid.json';
import { fmtT } from './primitives';
import { bus } from '../lib/events';
import { useApp } from '../state/store';
import { readRaidResumePointer, writeRaidResumePointer } from '../lib/raidResume';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), postRaw: vi.fn(),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const T0 = Date.parse('2026-09-04T12:00:00.000Z');
const result = {
  stars: 1, destructionPct: 50, keepDestroyed: false,
  lootShards: 100, attackerTrophyDelta: 5,
};

describe('cold terminal replay reconstruction', () => {
  const wallet = 'cold-replay-wallet';
  const baseId = 'cold-replay-base';
  const raidId = 'cold-replay-raid';
  const path = `/battles/participated/${raidId}/replay`;
  const snapshot = { keepLevel: 1, surplusShards: 100,
    buildings: [{ id: 'defender-keep', type: 'keep', level: 1, tx: 8, ty: 8 }] };
  const bundle = { snapshot, armySnapshot: { counts: { highlander: 1 }, levels: { highlander: 2 }, heroLevels: { vex: 3 } },
    visualContext: { version: 1 as const, realmId: 'frostveil' as const, artVersion: 1 as const },
    events: [{ t: 0, e: 'deploy' }, { t: 100, e: 'destroyed' }], simVersion: SIM_VERSION, result };
  let host: HTMLDivElement;
  let root: Root;
  let off: Array<() => void>;
  let entered: unknown[];
  let played: Array<{ terminal?: boolean; events: unknown[] }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset().mockResolvedValue(bundle);
    mocks.post.mockReset(); mocks.postRaw.mockReset();
    useApp.getState().setAuth(wallet);
    useApp.setState({ screen: 'battle', selectedBaseId: baseId,
      raidTarget: { kind: 'replay', raidId, replayPath: path, replayBaseId: baseId, result, resumeTerminal: true } });
    writeRaidResumePointer(localStorage, { version: 1, wallet, baseId, raidId,
      mode: 'pvp', role: 'attacker', phase: 'playing', target: {},
      clock: { revision: 1, rate: 1 }, inFlightSpeed: null });
    entered = []; played = [];
    off = [bus.on('battle:enter', (payload) => entered.push(payload)),
      bus.on('battle:play', (payload) => played.push(payload))];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    for (const dispose of off) dispose();
    host.remove();
    localStorage.clear();
    useApp.getState().setAuth(null);
    useApp.setState({ screen: 'base', raidTarget: null });
    vi.useRealTimers();
  });
  const mount = async (): Promise<void> => {
    await act(async () => root.render(<RaidUI />));
    await flush();
  };
  const advance = async (ms: number): Promise<void> => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };

  it('loads the defender field, silently seeks it, and retains the pointer until actual terminal display', async () => {
    let resolve!: (value: typeof bundle) => void;
    mocks.get.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount();
    expect(mocks.get).toHaveBeenCalledWith(path);
    expect(host.textContent).toContain('RESTORING RAID RESULT');
    expect(host.textContent).not.toContain('REPLAY ENDED');
    await act(async () => bus.emit('battle:done', undefined)); // stale prior field is not this result
    expect(readRaidResumePointer(localStorage, wallet, baseId)).not.toBeNull();
    resolve(bundle);
    await flush();
    expect(entered).toEqual([{ snapshot, visualContext: bundle.visualContext, armyCounts: { highlander: 1 },
      armyLevels: { highlander: 2 }, heroLevels: { vex: 3 } }]);
    expect(played).toEqual([]);
    await advance(80);
    expect(played).toEqual([{ events: bundle.events, simVersion: SIM_VERSION, terminal: true }]);
    expect(readRaidResumePointer(localStorage, wallet, baseId)).not.toBeNull();
    expect(host.textContent).not.toContain('REPLAY ENDED');
    // BattleScene owns this acknowledgment after its (possibly async) art gate
    // and silent terminal seek, not merely after receipt of the API result.
    await act(async () => bus.emit('battle:done', undefined));
    expect(host.textContent).toContain('REPLAY ENDED · 50% · 1★');
    expect(readRaidResumePointer(localStorage, wallet, baseId)).toBeNull();
    await advance(25_000);
    expect(useApp.getState().screen).toBe('battle');
    expect(host.textContent).toContain('↻ WATCH AGAIN');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });

  it('forwards archived accepted hero gear even when victory prevented that hero deploy event', async () => {
    mocks.get.mockResolvedValue({ ...bundle,
      orders: { heroDeploys: [{ hero: 'theodor', tx: -1, ty: 0, tMs: 80_000 }] },
      armySnapshot: { ...bundle.armySnapshot, heroLoadouts: frozenRaid.army.heroLoadouts },
    });
    await mount();
    await advance(80);
    expect(played).toEqual([{ events: bundle.events, simVersion: SIM_VERSION, terminal: true,
      heroLoadouts: frozenRaid.army.heroLoadouts }]);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('returns HOME and loads the selected owned base even when a scene cleanup throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { reloadBase } = await import('../state/baseSnapshot');
    const actualLoader = await vi.importActual<typeof import('../state/baseSnapshot')>('../state/baseSnapshot');
    vi.mocked(reloadBase).mockImplementationOnce(actualLoader.reloadBase);
    const ownBase = { baseId, player: { wallet, name: 'Own base', keepLevel: 1 },
      buildings: [{ id: 'own-keep', type: 'keep', level: 1, tx: 8, ty: 8 }],
      obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1 };
    mocks.get.mockImplementation(async (requested: string) => {
      if (requested === path) return bundle;
      if (requested.startsWith('/balances')) return { shards: '20', keep: '0' };
      return ownBase;
    });
    off.push(bus.on('battle:exit', () => { throw new Error('injected broken effect destructor'); }));
    await mount();
    await advance(80);
    await act(async () => bus.emit('battle:done', undefined));
    const close = [...host.querySelectorAll<HTMLElement>('[role="button"],button')]
      .find((node) => node.textContent === 'CLOSE');
    expect(close).toBeDefined();
    await act(async () => close!.click());
    await flush();
    expect(useApp.getState().screen).toBe('base');
    expect(useApp.getState().raidTarget).toBeNull();
    expect(useApp.getState().base?.baseId).toBe(baseId);
    expect(useApp.getState().base?.buildings[0]?.id).toBe('own-keep');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postRaw).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith('Scene cleanup failed: raid-ui-exit', expect.any(Error));
    logged.mockRestore();
  });

  it.each(['screen', 'base', 'wallet', 'target'] as const)('ignores a canonical response overtaken by a new %s', async (change) => {
    let resolve!: (value: typeof bundle) => void;
    mocks.get.mockImplementation(() => new Promise((done) => { resolve = done; }));
    await mount();
    await act(async () => {
      if (change === 'screen') useApp.getState().setScreen('base');
      if (change === 'base') useApp.getState().setSelectedBaseId('another-base', false);
      if (change === 'wallet') useApp.getState().setAuth('another-wallet');
      if (change === 'target') useApp.getState().setRaidTarget({ kind: 'replay', raidId: 'another-replay', result });
    });
    resolve(bundle);
    await flush();
    await advance(100);
    expect(entered).toEqual([]);
    expect(played).toEqual([]);
    expect(readRaidResumePointer(localStorage, wallet, baseId)).not.toBeNull();
  });

  it('cancels a delayed terminal play after the selected base changes', async () => {
    await mount();
    expect(entered).toHaveLength(1);
    await act(async () => useApp.getState().setSelectedBaseId('another-base', false));
    await advance(100);
    expect(played).toEqual([]);
    expect(readRaidResumePointer(localStorage, wallet, baseId)).not.toBeNull();
  });

  it('reconstructs an archived SIM result from its saved events without requiring the current live SIM', async () => {
    const archived = { ...bundle, simVersion: SIM_VERSION - 1 };
    mocks.get.mockResolvedValue(archived);
    await mount();
    await advance(80);
    expect(entered).toHaveLength(1);
    expect(played).toEqual([{ events: archived.events, simVersion: archived.simVersion, terminal: true }]);
    await act(async () => bus.emit('battle:done', undefined));
    expect(host.textContent).toContain('REPLAY ENDED');
    expect(readRaidResumePointer(localStorage, wallet, baseId)).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });

  it('retains recovery after a failed canonical read and permits an explicit retry', async () => {
    mocks.get.mockRejectedValueOnce(new Error('network unavailable'));
    await mount();
    expect(host.textContent).toContain('NETWORK UNAVAILABLE');
    expect(readRaidResumePointer(localStorage, wallet, baseId)).not.toBeNull();
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'RETRY');
    await act(async () => retry!.click());
    await flush();
    await advance(80);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(played.at(-1)?.terminal).toBe(true);
    await act(async () => bus.emit('battle:done', undefined));
    expect(host.textContent).toContain('REPLAY ENDED');
  });

  it('WATCH AGAIN uses ordinary 1x playback and local 2x without repeating terminal hydration or writing', async () => {
    await mount();
    await advance(80);
    await act(async () => bus.emit('battle:done', undefined));
    const watch = [...host.querySelectorAll('button')].find((button) => button.textContent === '↻ WATCH AGAIN');
    await act(async () => watch!.click());
    await flush();
    await advance(80);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(played).toEqual([
      { events: bundle.events, simVersion: SIM_VERSION, terminal: true },
      { events: bundle.events, simVersion: SIM_VERSION },
    ]);
    const rate = [...host.querySelectorAll<HTMLElement>('[role="button"]')].find((element) => element.textContent === '1×');
    expect(rate).toBeDefined();
    await act(async () => rate!.click());
    expect(host.textContent).toContain('2×');
    await advance(1_000);
    expect(host.textContent).not.toContain('REPLAY ENDED');
    expect(useApp.getState().screen).toBe('battle');
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'scene callback'] as const)('CLOSE during the WATCH AGAIN %s cannot reopen the old replay', async (waitingAt) => {
    await mount();
    await advance(80);
    await act(async () => bus.emit('battle:done', undefined));
    let resolve!: (value: typeof bundle) => void;
    mocks.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const watch = [...host.querySelectorAll('button')].find((button) => button.textContent === '↻ WATCH AGAIN');
    await act(async () => watch!.click());
    if (waitingAt === 'scene callback') {
      resolve(bundle);
      await flush();
      expect(entered).toHaveLength(2);
    }
    const close = [...host.querySelectorAll<HTMLElement>('button, [role="button"]')].find((button) => button.textContent === 'CLOSE');
    expect(close).toBeDefined();
    await act(async () => close!.click());
    expect(useApp.getState().screen).toBe('base');
    if (waitingAt === 'fetch') resolve(bundle);
    await flush();
    await advance(200);
    expect(entered).toHaveLength(waitingAt === 'fetch' ? 1 : 2);
    expect(played).toHaveLength(1);
    expect(useApp.getState().screen).toBe('base');
    expect(useApp.getState().raidTarget).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });
});
vi.mock('../auth/useSolPurchase', () => ({
  useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }),
}));
vi.mock('../state/baseSnapshot', () => ({ reloadBase: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/audio', () => ({ playSfx: vi.fn(), stopAllLoops: vi.fn() }));
vi.mock('../lib/juice', () => ({ haptic: vi.fn() }));

import { RaidUI } from './RaidUI';

async function flush(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

describe('completed replay local clock', () => {
  let host: HTMLDivElement;
  let root: Root;
  let restoreInsets: () => void;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let insets: Array<{ top: number; bottom: number }>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    mocks.get.mockReset(); mocks.post.mockReset(); mocks.postRaw.mockReset();
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(): void { /* initial publish is synchronous in RaidUI */ }
      unobserve(): void { /* no-op */ }
      disconnect(): void { /* no-op */ }
    } as typeof ResizeObserver;
    insets = [];
    restoreInsets = bus.on('battle:insets', (value) => insets.push({
      top: value.top, bottom: value.bottom,
    }));
    useApp.setState({
      screen: 'base',
      raidTarget: null,
      baseDirectory: null,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<RaidUI />));
    await flush();
    await act(async () => useApp.setState({
      screen: 'battle',
      raidTarget: { kind: 'replay', raidId: 'replay-1', result },
    }));
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreInsets();
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
    else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    host.remove();
    useApp.setState({ screen: 'base', raidTarget: null });
    vi.useRealTimers();
  });

  it('starts at 1x, rebases to 2x locally, and advances HUD progress without writes', async () => {
    expect(insets.length, 'base→replay mount publishes HUD-safe camera bounds').toBeGreaterThan(0);
    await act(async () => bus.emit('battle:play', {
      events: [{ t: 20, e: 'destroyed' }], simVersion: SIM_VERSION,
    }));
    await flush();
    const ratePill = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((node) => node.textContent === '1×');
    expect(ratePill).toBeDefined();

    await act(async () => ratePill!.click());
    expect(host.textContent).toContain('2×');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });

    await act(async () => (host.querySelector('[aria-label="Battle details"]') as HTMLElement).click());
    expect(host.textContent).toContain('+100');
    expect((host.querySelector('[aria-label="Battle details panel"]') as HTMLElement).style.position).toBe('absolute');
    expect((host.querySelector('[aria-label="Battle details panel"]') as HTMLElement).style.overflowY).toBe('auto');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[aria-label="Battle details panel"]')).toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });

  it('advances the timer through quiet replay ticks without a phase or rate change', async () => {
    await act(async () => bus.emit('battle:play', {
      events: [{ t: 100, e: 'destroyed' }], simVersion: SIM_VERSION,
    }));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250); });
    expect(host.textContent).toContain('1×');
    expect(host.textContent).toContain(`0:01 / ${fmtT(RAID_RULES.battleDurationSec)}`);
    expect(host.querySelector('[aria-label^="Battle timer:"]')?.getAttribute('aria-label')).toContain('elapsed / maximum');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(host.textContent).toContain(`0:02 / ${fmtT(RAID_RULES.battleDurationSec)}`);
    expect(mocks.postRaw).not.toHaveBeenCalled();
  });

  it('remeasures current DOM for a late scene request and removes the responder on exit', async () => {
    const close = [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(node => node.textContent === 'CLOSE');
    const hud = close!.parentElement!.parentElement!;
    const bounds = vi.spyOn(hud, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 123));
    try {
      const before = insets.length;
      await act(async () => bus.emit('battle:insetsRequest', undefined));
      expect(insets).toHaveLength(before + 1);
      expect(insets.at(-1)?.top).toBe(123);
      bounds.mockReturnValue(new DOMRect(0, 0, 390, 148));
      await act(async () => bus.emit('battle:insetsRequest', undefined));
      expect(insets.at(-1)?.top, 'request replays a fresh measurement, not an earlier viewport cache').toBe(148);
      await act(async () => useApp.getState().setScreen('base'));
      const exited = insets.length;
      await act(async () => bus.emit('battle:insetsRequest', undefined));
      expect(insets, 'the old screen must not respond to a later scene').toHaveLength(exited);
    } finally { bounds.mockRestore(); }
  });

  it('WATCH AGAIN preserves archived SIM event playback from an ordinary Raid Log entry', async () => {
    const archived = { snapshot: { buildings: [] }, simVersion: SIM_VERSION - 1,
      events: [{ t: 100, e: 'destroyed' }] };
    mocks.get.mockResolvedValue(archived);
    const played: unknown[] = [];
    const off = bus.on('battle:play', (payload) => played.push(payload));
    try {
      await act(async () => bus.emit('battle:done', undefined));
      const watch = [...host.querySelectorAll('button')].find((button) => button.textContent === '↻ WATCH AGAIN');
      expect(watch).toBeDefined();
      await act(async () => watch!.click());
      await flush();
      await act(async () => { await vi.advanceTimersByTimeAsync(80); });
      expect(played).toEqual([{ events: archived.events, simVersion: archived.simVersion }]);
      expect(host.textContent).toContain('1×');
      expect(host.textContent).not.toContain('REPLAY ENDED');
      expect(useApp.getState().raidTarget?.resumeTerminal).toBeUndefined();
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.postRaw).not.toHaveBeenCalled();
    } finally { off(); }
  });
});
