/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import { api, ApiError } from '../lib/api';
import { AuthChangedError, AuthCoordinationError } from '../auth/authCookieCoordinatorCore';
import { beginBaseSelectionGuard, captureBaseSnapshotGuard, useApp, type BaseStateDto } from '../state/store';
import { publishAssetPackGate } from '../state/assetPackGate';
import { hydrateBaseSnapshot } from '../state/baseSnapshot';
import { bus } from '../lib/events';
import * as analytics from '../lib/analytics';
import { enterGame, LoadingScreen, TitleScreen } from './Overlay';

vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: null }),
  useWallet: () => ({}),
}));
vi.mock('@privy-io/react-auth', () => ({
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

const base: BaseStateDto = {
  baseId: 'base-a',
  player: { wallet: 'restore-wallet', name: 'Keeper', keepLevel: 1, trophies: 0,
    league: 'bronze', builders: 1, expansions: 0 },
  claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
  buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
};
let root: Root;
let host: HTMLDivElement;
let resolvePending: (value: unknown) => void;
let pending: Promise<unknown>;

beforeEach(() => {
  publishAssetPackGate({ kind: 'not-required' });
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(analytics, 'track').mockImplementation(() => undefined);
  vi.spyOn(analytics, 'captureError').mockImplementation(() => undefined);
  localStorage.clear();
  useApp.getState().setAuth(null);
  useApp.setState({ screen: 'loading', booted: true, raidTarget: null });
  pending = new Promise((resolve) => { resolvePending = resolve; });
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/me') return { wallet: 'restore-wallet', entryPaid: true };
    if (path === '/bases') return { enabled: false, bases: [] };
    if (path === '/base') return base;
    if (path === '/balances') return { shards: '42', keep: '10', keepRate: 1 };
    if (path === '/raids/pending') return pending;
    throw new Error(`unexpected GET ${path}`);
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  publishAssetPackGate({ kind: 'not-required' });
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
};
const mount = async (): Promise<void> => {
  await act(async () => root.render(<LoadingScreen />));
  await flush();
  expect(host.textContent).toContain('Opening your kingdom');
  expect(useApp.getState().base?.baseId).toBe('base-a');
};

describe('authenticated cold restore', () => {
  it('does not spend the base snapshot allowance while a phone suspends its hidden tab', async () => {
    let visible: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
    let finishBase!: (value: BaseStateDto) => void;
    let signal: AbortSignal | undefined;
    const waiting = new Promise<BaseStateDto>(resolve => { finishBase = resolve; });
    const real = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path, options) => {
      if (path === '/base') { signal = options?.signal; return waiting; }
      return real(path, options);
    });
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    await act(async () => { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(host.textContent).not.toContain('Couldn’t load your kingdom');
    expect(signal?.aborted).toBe(false);
    await act(async () => { visible = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    finishBase(base); resolvePending({ raids: [] }); await flush();
    expect(useApp.getState()).toMatchObject({ screen: 'base', base });
    expect(analytics.captureError).not.toHaveBeenCalled();
    expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === '/base')).toHaveLength(1);
  });

  it('starts hidden and retains exactly one foreground deadline across duplicate events and raid discovery', async () => {
    let visible: DocumentVisibilityState = 'hidden';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
    let finishBase!: (value: BaseStateDto) => void;
    let signal: AbortSignal | undefined;
    const waiting = new Promise<BaseStateDto>(resolve => { finishBase = resolve; });
    const real = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path, options) => {
      if (path === '/base') { signal = options?.signal; return waiting; }
      return real(path, options);
    });
    const visibility = async (state: DocumentVisibilityState): Promise<void> => {
      await act(async () => { visible = state; document.dispatchEvent(new Event('visibilitychange')); });
    };
    await act(async () => root.render(<LoadingScreen />)); await flush();
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(host.textContent).not.toContain('Couldn’t load your kingdom'); expect(signal?.aborted).toBe(false);
    await visibility('visible');
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    await visibility('visible'); // A duplicate event cannot grant another 15s.
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    finishBase(base); await flush();
    await visibility('hidden'); await visibility('hidden');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await visibility('visible');
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(signal?.aborted).toBe(false); expect(host.textContent).not.toContain('Couldn’t load your kingdom');
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(signal?.aborted).toBe(true);
    expect(analytics.captureError).toHaveBeenCalledExactlyOnceWith('error', expect.objectContaining({
      diagnostics: { restoreReason: 'timeout', restoreStage: 'raid_recovery' },
    }));
    resolvePending({ raids: [] }); await flush();
    expect(useApp.getState().screen).toBe('loading');
  });

  it.each(['logout', 'selection'] as const)('still rejects a late hidden base response after %s', async change => {
    let visible: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visible);
    let finishBase!: (value: BaseStateDto) => void;
    const waiting = new Promise<BaseStateDto>(resolve => { finishBase = resolve; });
    const real = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path, options) => path === '/base' ? waiting : real(path, options));
    await act(async () => root.render(<LoadingScreen />)); await flush();
    await act(async () => { visible = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    await act(async () => {
      if (change === 'logout') { useApp.getState().setAuth(null); useApp.getState().setScreen('title'); }
      else beginBaseSelectionGuard();
    });
    finishBase(base); await flush();
    expect(useApp.getState()).toMatchObject({ base: null, screen: change === 'logout' ? 'title' : 'loading' });
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path === '/raids/pending')).toBe(false);
    expect(host.querySelector('[data-restore-failure]')?.getAttribute('data-restore-failure')).toBe('changed');
  });

  it('removes the visibility deadline and aborts a pending hidden restore on unmount', async () => {
    const added = vi.spyOn(document, 'addEventListener'), removed = vi.spyOn(document, 'removeEventListener');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    let signal: AbortSignal | undefined;
    let finishBase!: (value: BaseStateDto) => void;
    const waiting = new Promise<BaseStateDto>(resolve => { finishBase = resolve; });
    const real = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path, options) => {
      if (path === '/base') { signal = options?.signal; return waiting; }
      return real(path, options);
    });
    await act(async () => root.render(<LoadingScreen />)); await flush();
    const listener = added.mock.calls.find(([type, callback]) => type === 'visibilitychange'
      && typeof callback === 'function' && callback.name === 'armHydrationDeadline')?.[1];
    expect(listener).toBeTypeOf('function');
    await act(async () => root.render(null));
    expect(removed).toHaveBeenCalledWith('visibilitychange', listener); expect(signal?.aborted).toBe(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    finishBase(base); await flush();
    expect(useApp.getState().base).toBeNull(); expect(analytics.captureError).not.toHaveBeenCalled();
  });

  it('keeps boot file counts indeterminate because decoded files do not measure network progress', async () => {
    useApp.setState({ booted: false });
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    const bar = (): Element | null => host.querySelector('[role="progressbar"]');
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    await act(async () => bus.emit('boot:progress', { completed: 9, total: 27, attempt: 1 }));
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    await act(async () => bus.emit('boot:progress', { completed: 18, total: 27, attempt: 2 }));
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    expect(host.textContent).toContain('Opening your kingdom');
  });

  it('shows measured pack bytes while downloading, then keeps preparation and account recovery indeterminate', async () => {
    useApp.setState({ booted: false });
    publishAssetPackGate({ kind: 'downloading', totalBytes: 1000, downloadedBytes: 125, totalFiles: 10, downloadedFiles: 1 });
    await act(async () => root.render(<LoadingScreen />)); await flush();
    const bar = (): Element | null => host.querySelector('[role="progressbar"]');
    expect(bar()?.getAttribute('aria-valuenow')).toBe('12');
    expect(host.textContent).toContain('Downloading · 12%');
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(bar()?.getAttribute('aria-valuenow')).toBe('12');
    await act(async () => publishAssetPackGate({ kind: 'preparing', totalBytes: 1000, cachedBytes: 800, totalFiles: 10, cachedFiles: 8 }));
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    expect(host.textContent).not.toContain('Downloading');
    await act(async () => {
      publishAssetPackGate({ kind: 'downloading', totalBytes: 1000, downloadedBytes: 1000, totalFiles: 10, downloadedFiles: 10 });
      useApp.setState({ booted: true });
    }); await flush();
    expect(useApp.getState().screen).toBe('loading'); // Original pending raid read still owns readiness.
    expect(bar()?.hasAttribute('aria-valuenow')).toBe(false);
    expect(host.textContent).not.toContain('100%');
    await act(async () => publishAssetPackGate({ kind: 'ready', totalBytes: 1000, totalFiles: 10 }));
    expect(useApp.getState().screen).toBe('loading');
    resolvePending({ raids: [] }); await flush();
    expect(useApp.getState().screen).toBe('base');
  });

  it('does not present a completed download as a completed account sync', async () => {
    await mount(); // Artwork is ready, but the saved raid lookup is still pending.
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-label')).toBe('Opening your kingdom');
    expect(bar?.hasAttribute('aria-valuenow')).toBe(false);
    expect(bar?.getAttribute('data-indeterminate')).toBe('true');
    expect(useApp.getState().screen).toBe('loading');
    resolvePending({ raids: [] }); await flush();
    expect(useApp.getState().screen).toBe('base');
  });

  it('waits for cold artwork boot before starting the bounded game sync', async () => {
    useApp.setState({ booted: false });
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(25_000));
    expect(host.textContent).not.toContain('Couldn’t load your kingdom');
    expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(['/me']);
    expect(useApp.getState()).toMatchObject({ authed: true, screen: 'loading', base: null });
    await act(async () => useApp.setState({ booted: true }));
    await flush();
    expect(host.textContent).toContain('Opening your kingdom');
    resolvePending({ raids: [] });
    await flush();
    expect(useApp.getState()).toMatchObject({ screen: 'base', base });
  });

  it.each(['logout', 'selection'] as const)('does not start stale hydration after %s during artwork boot', async (change) => {
    useApp.setState({ booted: false });
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    await act(async () => {
      if (change === 'logout') {
        useApp.getState().setAuth(null);
        useApp.getState().setScreen('title');
      } else beginBaseSelectionGuard();
      useApp.setState({ booted: true });
    });
    await flush();
    expect(vi.mocked(api.get).mock.calls.map(([path]) => path)).toEqual(['/me']);
    expect(useApp.getState()).toMatchObject({ screen: change === 'logout' ? 'title' : 'loading', base: null });
    expect(host.querySelector('[data-restore-failure]')?.getAttribute('data-restore-failure')).toBe('changed');
  });

  it('keeps request failures distinct from a timeout after the toast disappears', async () => {
    const real = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path, options) => path === '/bases'
      ? Promise.reject(new ApiError(503, 'unavailable', 'SERVICE_UNAVAILABLE')) : real(path, options));
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(host.textContent).toContain('Check your connection and try again');
    expect(host.querySelector('[data-restore-failure]')?.getAttribute('data-restore-failure')).toBe('request');
    expect(analytics.track).toHaveBeenCalledWith(analytics.EVENTS.AUTH_SESSION_PHASE, expect.objectContaining({
      operation: 'game', phase: 'retry', reason: 'request', stage: 'base_snapshot', status: 503, code: 'SERVICE_UNAVAILABLE',
    }));
    expect(analytics.captureError).toHaveBeenCalledWith('error', expect.objectContaining({ name: 'GameRestoreError',
      diagnostics: { restoreReason: 'request', restoreStage: 'base_snapshot', httpStatus: 503 },
    }));
  });

  it('retains a session after raid-discovery network failure and gives each manual retry a fresh bounded request', async () => {
    // A status-zero restore incident must expose recovery, not sign out or
    // skip authoritative raid discovery. An abandoned retry cannot win later.
    const real = vi.mocked(api.get).getMockImplementation()!;
    let rejectInterrupted!: (error: unknown) => void;
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    const signals: Array<AbortSignal | undefined> = [];
    vi.mocked(api.get).mockImplementation((path, options) => {
      if (path !== '/raids/pending') return real(path, options);
      signals.push(options?.signal);
      if (signals.length === 1) return Promise.reject(new ApiError(0, 'unavailable', 'NETWORK_UNAVAILABLE'));
      if (signals.length === 2) return interrupted;
      return Promise.resolve({ raids: [] });
    });
    const retry = async (): Promise<void> => {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'TRY AGAIN');
      expect(button).toBeTruthy();
      await act(async () => button!.click());
      await flush();
    };

    await act(async () => root.render(<LoadingScreen />));
    await flush();
    expect(host.textContent).toContain('Check your connection and try again');
    expect(host.querySelector('[data-restore-failure]')?.getAttribute('data-restore-failure')).toBe('request');
    expect(host.querySelector('[data-restore-stage]')?.getAttribute('data-restore-stage')).toBe('raid_recovery');
    expect(useApp.getState()).toMatchObject({ authed: true, wallet: 'restore-wallet', screen: 'loading', base });
    expect(analytics.captureError).toHaveBeenCalledExactlyOnceWith('error', expect.objectContaining({
      name: 'GameRestoreError', diagnostics: { restoreReason: 'request', restoreStage: 'raid_recovery', httpStatus: 0 },
    }));

    await retry();
    expect(signals).toHaveLength(2);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).not.toBe(signals[0]);
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(host.textContent).toContain('Opening your kingdom');
    expect(signals[1]?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(signals[1]?.aborted).toBe(true);
    expect(host.textContent).toContain('Loading took too long');

    await retry();
    expect(signals).toHaveLength(3);
    expect(signals[2]).not.toBe(signals[1]);
    expect(useApp.getState()).toMatchObject({ authed: true, wallet: 'restore-wallet', screen: 'base', base, raidTarget: null });
    expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === '/me')).toHaveLength(1);
    expect(analytics.captureError).toHaveBeenCalledTimes(2);
    rejectInterrupted(new ApiError(0, 'late unavailable', 'NETWORK_UNAVAILABLE'));
    await flush();
    expect(useApp.getState()).toMatchObject({ authed: true, screen: 'base', base, raidTarget: null });
    expect(analytics.captureError).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('accepts concurrent initial-base adoption only without a newer selection intent (intent: %s)', async (selectionIntent) => {
    let finishOlder!: (value: BaseStateDto) => void;
    const older = new Promise<BaseStateDto>(resolve => { finishOlder = resolve; });
    let baseReads = 0, balanceReads = 0;
    const freshBase = { ...base, freeBuilders: 2 };
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === '/me') return { wallet: 'restore-wallet', entryPaid: true };
      if (path === '/bases') return { enabled: true, maxActive: 5, nextLandPurchaseKind: 'deed',
        capabilities: { baseScopedReads: true, baseScopedMutations: true, cellReservations: true },
        bases: [{ id: 'base-a', status: 'active', slot: 1 }] };
      if (path === '/base?baseId=base-a') return ++baseReads === 1 ? older : freshBase;
      if (path === '/balances?baseId=base-a') return { shards: ++balanceReads === 1 ? '42' : '55', keep: '10', keepRate: 1 };
      if (path === '/raids/pending') return pending;
      throw new Error(`unexpected GET ${path}`);
    });
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    expect(baseReads).toBe(1);
    const originalGuard = captureBaseSnapshotGuard();
    if (selectionIntent) beginBaseSelectionGuard();
    await act(async () => { expect(await hydrateBaseSnapshot('base-a', selectionIntent ? captureBaseSnapshotGuard() : originalGuard)).toBe(true); });
    finishOlder(base);
    resolvePending({ raids: [] });
    await flush();
    expect(useApp.getState()).toMatchObject({ screen: selectionIntent ? 'loading' : 'base', selectedBaseId: 'base-a', base: freshBase,
      balances: { shards: '55' } });
    if (selectionIntent) expect(host.textContent).toContain('Couldn’t load your kingdom');
    else expect(host.textContent).not.toContain('Couldn’t load your kingdom');
  });

  it('enters the hydrated base when canonical raid discovery completes', async () => {
    await mount();
    resolvePending({ raids: [] });
    await flush();
    expect(useApp.getState()).toMatchObject({ screen: 'base', wallet: 'restore-wallet', base });
  });

  it('keeps a deadline through raid discovery, rejects late recovery, and allows a fresh retry', async () => {
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(host.textContent).toContain('Couldn’t load your kingdom');
    expect(host.textContent).toContain('Loading took too long');
    expect(host.querySelector('[data-restore-failure]')?.getAttribute('data-restore-failure')).toBe('timeout');
    expect(analytics.track).toHaveBeenCalledWith(analytics.EVENTS.AUTH_SESSION_PHASE, expect.objectContaining({
      operation: 'game', phase: 'retry', reason: 'timeout', stage: 'raid_recovery', elapsed_ms: 15_000,
    }));
    const oldResolve = resolvePending;
    pending = Promise.resolve({ raids: [] });
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('TRY AGAIN'))!;
    expect(retry).toBeTruthy();
    await act(async () => retry.click());
    await flush();
    expect(useApp.getState().screen).toBe('base');
    // The old response may arrive even after AbortSignal fired. It cannot
    // replace the successful retry with a raid or mutate its durable pointer.
    oldResolve({ raids: [{ id: 'late-raid', attackerBaseId: 'base-a',
      simVersion: SIM_VERSION, campaignStage: 1 }] });
    await flush();
    expect(useApp.getState()).toMatchObject({ screen: 'base', raidTarget: null, base });
  });

  it('offers retry when a base-selection intent invalidates recovery, without routing the old base', async () => {
    await mount();
    beginBaseSelectionGuard();
    resolvePending({ raids: [] });
    await flush();
    expect(useApp.getState().screen).toBe('loading');
    expect(host.textContent).toContain('Couldn’t load your kingdom');
  });

  it('never restores a late raid after logout', async () => {
    await mount();
    await act(async () => {
      useApp.getState().setAuth(null);
      useApp.getState().setScreen('title');
    });
    resolvePending({ raids: [{ id: 'late-raid', attackerBaseId: 'base-a',
      simVersion: SIM_VERSION, campaignStage: 1 }] });
    await flush();
    expect(useApp.getState()).toMatchObject({ screen: 'title', authed: false, wallet: null, base: null, raidTarget: null });
  });
});

describe('session discovery is distinct from signing out', () => {
  it.each([
    [new AuthCoordinationError('storage', 'private diagnostic'), 'Allow site data', 'storage'],
    [new AuthCoordinationError('browser', 'private diagnostic'), 'Update your browser', 'browser'],
    [new AuthChangedError(), 'Finish signing in in your other game window', 'changed'],
  ] as const)('gives actionable session recovery for %s without exposing raw errors', async (error, copy, reason) => {
    vi.mocked(api.get).mockRejectedValue(error);
    await act(async () => root.render(<LoadingScreen />)); await flush();
    expect(host.textContent).toContain(copy);
    expect(host.textContent).not.toContain('private diagnostic');
    expect(useApp.getState()).toMatchObject({ screen: 'loading', authed: false });
    expect(analytics.track).toHaveBeenCalledWith(analytics.EVENTS.AUTH_SESSION_PHASE,
      expect.objectContaining({ operation: 'session', phase: 'retry', reason }));
  });
  it.each([0, 503])('keeps an uncertain /me response (%s) on session retry', async (status) => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(status, 'unavailable'));
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    expect(host.textContent).toContain('Couldn’t load your kingdom');
    expect(host.textContent).toContain('TRY AGAIN');
    expect(useApp.getState().screen).toBe('loading');
  });
  it('only a definite unauthorized response reveals the signed-out title', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(401, 'expired'));
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    expect(useApp.getState().screen).toBe('title');
  });
  it('times out a slow /me without requesting a signature and retries the saved cookie', async () => {
    const real = vi.mocked(api.get).getMockImplementation()!;
    let old!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { old = resolve; }));
    await act(async () => root.render(<LoadingScreen />));
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(useApp.getState().screen).toBe('loading');
    expect(host.textContent).toContain('Couldn’t load your kingdom');
    pending = Promise.resolve({ raids: [] });
    vi.mocked(api.get).mockImplementation(real);
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('TRY AGAIN'))!;
    await act(async () => retry.click());
    await flush();
    expect(useApp.getState()).toMatchObject({ screen: 'base', wallet: 'restore-wallet' });
    old({ wallet: 'stale-wallet', entryPaid: false });
    await flush();
    expect(useApp.getState().wallet).toBe('restore-wallet');
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith('/auth/challenge'))).toBe(false);
  });
});

describe('authenticated title entry', () => {
  it('retries only hydration after failure and shares a single in-flight entry', async () => {
    const real = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockRejectedValueOnce(new ApiError(503, 'unavailable'));
    useApp.getState().setAuth('restore-wallet', true);
    useApp.getState().setScreen('title');
    await act(async () => root.render(<TitleScreen />));
    await flush();
    expect(host.textContent).toContain('You are signed in.');
    expect(useApp.getState().authed).toBe(true);
    vi.mocked(api.get).mockImplementation(real);
    let one!: ReturnType<typeof enterGame>; let two!: ReturnType<typeof enterGame>;
    await act(async () => { one = enterGame(); two = enterGame(); });
    expect(one).toBe(two);
    expect(host.textContent).toContain('LOADING YOUR GAME');
    resolvePending({ raids: [] });
    await act(async () => { expect(await one).toEqual({ ok: true }); });
    expect(useApp.getState().screen).toBe('base');
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith('/auth/challenge'))).toBe(false);
  });
  it('keeps the same flight after hydration selects the wallet’s only base', async () => {
    useApp.getState().setAuth('restore-wallet', true);
    useApp.getState().setScreen('title');
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === '/bases') return { enabled: true, maxActive: 5, nextLandPurchaseKind: 'deed',
        capabilities: { baseScopedReads: true, baseScopedMutations: true, cellReservations: true },
        bases: [{ id: 'base-a', status: 'active', slot: 1 }] };
      if (path.startsWith('/base?')) return base;
      if (path.startsWith('/balances?')) return { shards: '42', keep: '10', keepRate: 1 };
      if (path.startsWith('/raids/pending')) return pending;
      throw new Error(`unexpected GET ${path}`);
    });
    const first = enterGame();
    await flush();
    expect(useApp.getState().selectedBaseId).toBe('base-a');
    expect(enterGame()).toBe(first);
    resolvePending({ raids: [] });
    await flush();
    expect(await first).toEqual({ ok: true });
    expect(vi.mocked(api.get).mock.calls.filter(([path]) => path === '/bases')).toHaveLength(1);
  });
  it('does not navigate from a directory response superseded by a base-selection intent', async () => {
    useApp.getState().setAuth('restore-wallet', true);
    useApp.setState({ screen: 'title', base });
    let directory!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { directory = resolve; }));
    const entry = enterGame();
    await flush();
    beginBaseSelectionGuard();
    directory({ enabled: false, bases: [] });
    await flush();
    expect(await entry).toEqual({ ok: false });
    expect(useApp.getState().screen).toBe('title');
  });
  it('returns failed entry after its deadline and ignores an old late raid response', async () => {
    useApp.getState().setAuth('restore-wallet', true);
    useApp.getState().setScreen('title');
    const entry = enterGame();
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(await entry).toEqual({ ok: false });
    expect(useApp.getState()).toMatchObject({ screen: 'title', authed: true });
    resolvePending({ raids: [] });
    await flush();
    expect(useApp.getState().screen).toBe('title');
  });
});

describe('loading wallpaper', () => {
  it('shows the bright loading key art for the current orientation instead of the dimmed title art', async () => {
    // WHY: owner 2026-09-24 — the loading screen was too dark. It must use the
    // bright loading wallpaper at a light filter, and pick the file matching
    // the viewport so neither phone nor desktop crops the wrong composition.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    const backdrop = (): HTMLImageElement => host.querySelector('img')!;
    expect(backdrop().getAttribute('src')).toContain('/brand/brand_loading_bg_landscape.png');
    // BrandImage applies the caller's style (and so the filter) to its frame.
    expect(host.querySelector('[data-brand-state]')?.getAttribute('style')).toMatch(/filter: brightness\(0?\.9\)/);

    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(backdrop().getAttribute('src')).toContain('/brand/brand_loading_bg_portrait.png');
    expect(host.innerHTML).not.toContain('brand_title_bg_');
  });

  it('warms the title backdrop for the current orientation while loading shows different art', async () => {
    // WHY: loading and title now use different pictures. A signed-out player
    // goes straight from loading to the title, which would otherwise paint the
    // flat fill while its backdrop downloads cold.
    const warmed: string[] = [];
    vi.stubGlobal('Image', class { set src(value: string) { warmed.push(value); } });
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(720);
    await act(async () => root.render(<LoadingScreen />));
    await flush();
    // Tip sprites also load through Image; only the brand art matters here.
    const brand = (): string[] => warmed.filter((src) => src.includes('/brand/'));
    expect(brand()).toEqual([expect.stringContaining('/brand/brand_title_bg_landscape.png')]);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(844);
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(brand().at(-1)).toContain('/brand/brand_title_bg_portrait.png');
  });
});
