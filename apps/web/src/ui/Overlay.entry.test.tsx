/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginBaseSelectionGuard, useApp, type BaseStateDto } from '../state/store';
import { api } from '../lib/api';
import { SIM_VERSION } from '@shardkeep/sim';
import { bus } from '../lib/events';
import { takePendingDeepLink } from '../lib/deepLink';
import { readRaidResumePointer, writeRaidResumePointer } from '../lib/raidResume';

vi.mock('@solana/wallet-adapter-react', () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => children,
  WalletProvider: ({ children }: { children: ReactNode }) => children,
  useConnection: () => ({ connection: null }),
  useWallet: () => ({}),
}));
vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => children,
  usePrivy: () => ({}),
  useSolanaWallets: () => ({ wallets: [] }),
}));
vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ signIn: vi.fn(), signingIn: false, error: null }),
}));
vi.mock('../auth/useSocialAuth', () => ({
  useSocialAuth: () => ({ signInWithSocial: vi.fn(), signingIn: false, error: null }),
}));
vi.mock('../auth/useSignOut', () => ({ useSignOut: () => vi.fn() }));
vi.mock('../auth/useWalletSessionFence', () => ({ useWalletSessionFence: () => undefined }));
vi.mock('../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, signMessage: null }),
}));
vi.mock('../auth/useEntry', () => ({
  usePayEntry: () => ({
    reserve: vi.fn(), submit: vi.fn(), phase: 'idle', error: null, reservation: null,
  }),
}));
vi.mock('./useFetch', () => ({
  useFetch: () => ({ data: null, reload: vi.fn() }),
}));
vi.mock('./useSolBalance', () => ({ useSolBalance: () => null }));
vi.mock('../auth/mobilePhantomAdapter', () => ({ useDetectedMobilePhantomAdapters: () => [] }));
vi.mock('../auth/useDevnetFaucet', () => ({
  useDevnetFaucet: () => ({ phase: 'idle', status: null }),
}));
vi.mock('../lib/mwa', () => ({ registerMwa: vi.fn() }));
vi.mock('../lib/audio', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/audio')>(),
  installAudioUnlock: vi.fn(), setMusicScreen: vi.fn(), playSfx: vi.fn(), stopAllLoops: vi.fn(),
}));
vi.mock('./UpdateGate', () => ({ UpdateGate: () => null }));
vi.mock('./raidSimulation', () => ({
  RaidSimulationService: class {
    // Routing must follow canonical settlement even when presentation has not
    // returned. The worker's computation/transport has its own contract suite.
    simulate() { return new Promise(() => undefined); }
    dispose() {}
  },
}));
vi.mock('./sheets', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sheets')>(),
  reloadBase: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./Overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Overlay')>();
  const { useApp: store } = await import('../state/store');
  const { RaidUI } = await import('./RaidUI');
  const { EntryScreen: Entry } = await import('./land/EntryScreen');
  return {
    ...actual,
    // Keep the real entry, recovery and raid/result controls; unrelated menus,
    // canvas, toasts and base panels are outside this routing seam. The land
    // screen is mounted exactly as Overlay mounts it: with the real enterGame
    // and the real faucet control injected.
    Overlay: () => {
      const screen = store((state) => state.screen);
      return <>
        {screen === 'entry' && (
          <Entry enterGame={actual.enterGame} FaucetControl={actual.DevnetSolClaim} faucetView={actual.devnetSolClaimView} />
        )}
        <RaidUI />
      </>;
    },
  };
});

import { raidRecoveryDestination } from './Overlay';
import { EntryScreen } from './land/EntryScreen';
import { App } from '../App';

afterEach(() => {
  vi.restoreAllMocks();
  useApp.getState().setAuth(null);
  useApp.setState({ screen: 'loading', mapTab: 'world', landPurchase: null, base: null });
  takePendingDeepLink();
});

describe('notification destination composed with entry and an active raid', () => {
  it.each([
    ['base', 'launch URL'], ['bases', 'launch URL'],
    ['base', 'worker message'], ['bases', 'worker message'],
  ] as const)('holds %s from %s until the canonical raid result is dismissed', async (destination, source) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const wallet = 'recovery-wallet';
    const baseId = 'base-notification';
    const raidId = 'raid-notification';
    const worker = new EventTarget();
    const addListener = vi.spyOn(worker, 'addEventListener');
    const removeListener = vi.spyOn(worker, 'removeEventListener');
    const previousWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
    const previousUrl = window.location.href;
    const originalSetScreen = useApp.getState().setScreen;
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
    // Keep the unrelated font/canvas branch pending; App aborts its timer on
    // unmount. No font network, wallet transport or actual push service is used.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    window.history.replaceState(null, '', source === 'launch URL' ? `/?screen=${destination}` : '/');
    let resolved = false;
    const snapshot = { keepLevel: 1, surplusShards: 17, claimMin: 4, claimMax: 18,
      buildings: [{ id: 'keep', type: 'keep', level: 1, tx: 8, ty: 8 }] };
    const armySnapshot = { counts: { highlander: 1 }, levels: { highlander: 1 }, heroes: [] };
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    const battleEndsAt = new Date(Date.parse(startedAt) + 90_000).toISOString();
    const result = { stars: 1, destructionPct: 52, keepDestroyed: false, lootShards: 17, attackerTrophyDelta: 3 };
    const replay = { snapshot, armySnapshot, simVersion: SIM_VERSION, events: [], result };
    const view = () => ({
      protocolVersion: 2,
      status: resolved ? 'resolved' : 'pending_orders',
      startedAt, battleEndsAt, streamClosedAt: null,
      snapshot, armySnapshot, seed: 7, simVersion: SIM_VERSION,
      lastSequence: 0, commands: [{ sequence: 0, clientCommandId: 'accepted-first-unit',
        serverOffsetMs: 0, kind: 'deploy', payload: { troop: 'highlander', tx: 0, ty: 0 } }], hasMore: false,
      clock: { protocolVersion: 2, revision: 1, rate: 1, anchorWallAt: startedAt,
        anchorSimMs: 0, serverNow: new Date().toISOString(), simNowMs: resolved ? 90_000 : 1_000,
        battleEndsAt, durationMs: 90_000 },
    });
    const get = vi.spyOn(api, 'get').mockImplementation(async (path) => {
      if (path === '/bases') return { enabled: false, bases: [] };
      if (path === '/base') return recoveryBase(baseId);
      if (path === '/balances') return { shards: '42', keep: '10', keepRate: 1 };
      if (path.startsWith(`/raids/${raidId}/live`)) return view();
      if (path === `/raids/pending/${raidId}`) return { raid: null };
      if (path === `/battles/participated/${raidId}/replay` && !resolved) {
        throw Object.assign(new Error('Not yet resolved'), { status: 409 });
      }
      if (path === `/bases/${baseId}/battles/${raidId}/replay`
        || path === `/battles/participated/${raidId}/replay`) return replay;
      throw new Error(`unexpected GET ${path}`);
    });
    const post = vi.spyOn(api, 'post');
    const postRaw = vi.spyOn(api, 'postRaw');
    useApp.getState().setAuth(wallet);
    useApp.setState({ screen: 'entry', raidTarget: null, base: null });
    writeRaidResumePointer(localStorage, {
      version: 1, wallet, baseId, raidId, mode: 'live', role: 'defender', phase: 'playing',
      target: { replayBaseId: baseId }, clock: { revision: 1, rate: 1 }, inFlightSpeed: null,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const screens: string[] = [];
    const unsubscribe = useApp.subscribe((state, previous) => {
      if (state.screen !== previous.screen) screens.push(state.screen);
    });
    const flush = async (): Promise<void> => {
      await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
    };
    try {
      await act(async () => root.render(<App />));
      await act(async () => useApp.getState().setEntryPaid(true));
      await flush();
      expect(useApp.getState()).toMatchObject({ screen: 'battle', base: { baseId },
        raidTarget: { kind: 'live', raidId, replayBaseId: baseId } });
      expect(screens, 'entry must never visit the notification destination before recovery').toEqual(['battle']);
      expect(host.textContent).not.toContain('ATTACKER IS PREPARING');
      expect(readRaidResumePointer(localStorage, wallet, baseId)?.phase).toBe('playing');
      if (source === 'worker message') {
        await act(async () => worker.dispatchEvent(new MessageEvent('message', {
          data: { type: 'open-screen', screen: destination },
        })));
      } else {
        expect(new URL(window.location.href).searchParams.has('screen')).toBe(false);
      }
      // Hydration updates and a provisional renderer completion do not consume
      // a queued shade tap or substitute for the server's terminal decision.
      await act(async () => {
        useApp.getState().setBase(recoveryBase(baseId));
        bus.emit('battle:done', undefined);
      });
      expect(useApp.getState().screen).toBe('battle');
      expect(readRaidResumePointer(localStorage, wallet, baseId)?.raidId).toBe(raidId);
      expect(host.textContent).not.toContain('LIVE BATTLE SETTLED');
      resolved = true;
      await act(async () => vi.advanceTimersByTimeAsync(1_001));
      await flush();
      expect(get).toHaveBeenCalledWith(`/bases/${baseId}/battles/${raidId}/replay`);
      await act(async () => bus.emit('battle:done', undefined));
      await flush();
      expect(host.textContent).toContain('LIVE BATTLE SETTLED');
      expect(host.textContent).toContain('52%');
      expect(useApp.getState().screen).toBe('battle');
      const back = [...host.querySelectorAll('button')].find((button) => button.textContent === 'CLOSE');
      expect(back).toBeTruthy();
      await act(async () => back!.click());
      expect(useApp.getState().screen).toBe(destination);
      expect(useApp.getState().raidTarget).toBeNull();
      expect(readRaidResumePointer(localStorage, wallet, baseId)).toBeNull();
      expect(takePendingDeepLink(), 'the destination is consumed once').toBeNull();
      // Once consumed, another base entry is ordinary navigation, not a replay
      // of the notification. Even BASE itself must not receive a second write.
      const setScreen = vi.spyOn(useApp.getState(), 'setScreen');
      await act(async () => { setScreen('mail'); setScreen('base'); });
      expect(useApp.getState().screen).toBe('base');
      expect(setScreen.mock.calls.map(([screen]) => screen)).toEqual(['mail', 'base']);
      expect(post).not.toHaveBeenCalled();
      expect(postRaw).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      unsubscribe();
      // Zustand copies actions into successive state objects; restoring a spy
      // on the old object alone would leave its copied function in the store.
      useApp.setState({ setScreen: originalSetScreen });
      host.remove();
      const onMessage = addListener.mock.calls.find(([event]) => event === 'message')?.[1];
      expect(removeListener).toHaveBeenCalledWith('message', onMessage);
      localStorage.clear();
      window.history.replaceState(null, '', previousUrl);
      if (previousWorker) Object.defineProperty(navigator, 'serviceWorker', previousWorker);
      else Reflect.deleteProperty(navigator, 'serviceWorker');
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('land onboarding globe entry', () => {
  it('overrides a sticky Campaign tab before opening the map', async () => {
    useApp.setState({ screen: 'entry', mapTab: 'campaign', landPurchase: null, base: null });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => root.render(
      <EntryScreen enterGame={vi.fn()} FaucetControl={() => null} faucetView={() => null} />,
    ));

    const choose = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('CHOOSE YOUR LAND ON THE GLOBE'));
    expect(choose).toBeTruthy();

    await act(async () => choose!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(useApp.getState()).toMatchObject({ screen: 'map', mapTab: 'world' });

    await act(async () => root.unmount());
  });
});

function recoveryBase(baseId: string): BaseStateDto {
  return {
    baseId,
    player: { wallet: 'recovery-wallet', name: 'Keeper', keepLevel: 1, trophies: 0,
      league: 'bronze', builders: 1, expansions: 0 },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
  };
}

describe('sole-raid cross-base recovery', () => {
  const pending = { id: 'raid-b', attackerBaseId: 'base-b', simVersion: SIM_VERSION, campaignStage: 1 };
  const balances = { shards: '42', keep: '10', keepRate: 1 };
  function prepare(): void {
    useApp.getState().setAuth('recovery-wallet');
    useApp.setState({ selectedBaseId: 'base-a', base: recoveryBase('base-a'),
      balances: { shards: '1', keep: '10', keepRate: 1 }, raidTarget: null });
  }

  it('single-flights discovery and atomically hydrates the raid deed before navigation', async () => {
    prepare();
    let completeBalances!: (value: unknown) => void;
    const get = vi.spyOn(api, 'get').mockImplementation(async (path) => {
      if (path === '/raids/pending') return { raids: [pending] };
      if (path === '/base?baseId=base-b') return recoveryBase('base-b');
      if (path === '/balances?baseId=base-b') return new Promise((resolve) => { completeBalances = resolve; });
      throw new Error(`unexpected ${path}`);
    });
    const runs = [raidRecoveryDestination(), raidRecoveryDestination(), raidRecoveryDestination()];
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(useApp.getState()).toMatchObject({ selectedBaseId: 'base-a', base: { baseId: 'base-a' }, raidTarget: null });
    completeBalances(balances);
    const results = await Promise.all(runs);
    expect(results).toEqual([results[0], results[0], results[0]]);
    expect(results[0]).toMatchObject({ screen: 'battle', guard: { selectedBaseId: 'base-b' } });
    expect(useApp.getState()).toMatchObject({ selectedBaseId: 'base-b', base: { baseId: 'base-b' }, balances,
      raidTarget: { kind: 'campaign', raidId: 'raid-b', stage: 1 } });
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/raids/pending', '/base?baseId=base-b', '/balances?baseId=base-b',
    ]);
  });

  it.each(['logout', 'new-selection'] as const)('ignores recovery overtaken by %s while reading a deed', async (interruption) => {
    prepare();
    let completeBase!: (value: unknown) => void;
    vi.spyOn(api, 'get').mockImplementation(async (path) => {
      if (path === '/raids/pending') return { raids: [pending] };
      if (path === '/base?baseId=base-b') return new Promise((resolve) => { completeBase = resolve; });
      if (path === '/balances?baseId=base-b') return balances;
      throw new Error(`unexpected ${path}`);
    });
    const run = raidRecoveryDestination();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    if (interruption === 'logout') useApp.getState().setAuth(null);
    else beginBaseSelectionGuard();
    completeBase(recoveryBase('base-b'));
    expect(await run).toBeNull();
    expect(useApp.getState().raidTarget).toBeNull();
    expect(useApp.getState().selectedBaseId).not.toBe('base-b');
  });
});
