import { ASSET_PACK_TRANSFER } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetPackError, type AssetPackEnvironment, type AssetPackManifest } from '../lib/assetPack';
import { bus } from '../lib/events';
import {
  assetPackTransferBlocked, publishAssetPackGate, startAssetPackTransfer, useAssetPackGate,
} from './assetPackGate';
import { useApp } from './store';

// D-101 transfer discipline (M33 C1). The Seeker reports "heavy and a bit of
// freezing": a 200+ MB download that hashes every object on the main thread
// must never overlap BootScene's own atlas fetches or a raid's simulation
// playback, and React must not re-render the whole overlay on every chunk.

const PACK: AssetPackManifest = { schema: 2, build: 'build-a', totalBytes: 0, files: [] };

/** A fake installer: resolves when told to, rejects with `aborted` on signal. */
function installer() {
  const calls: AssetPackEnvironment[] = [];
  let finish: ((value: AssetPackManifest | null) => void) | null = null;
  let fail: ((cause: unknown) => void) | null = null;
  const ensure = vi.fn((environment: AssetPackEnvironment) => new Promise<AssetPackManifest | null>((resolve, reject) => {
    calls.push(environment);
    finish = resolve;
    fail = reject;
    environment.signal?.addEventListener('abort', () => reject(new AssetPackError('aborted', 'Game download cancelled')), { once: true });
  }));
  return {
    ensure, calls,
    progress: (environment: AssetPackEnvironment, downloadedBytes: number) => environment.onProgress?.({
      kind: 'downloading', totalBytes: 100, totalFiles: 2, downloadedBytes, downloadedFiles: 0,
    }),
    resolve: (value: AssetPackManifest | null) => finish?.(value),
    reject: (cause: unknown) => fail?.(cause),
  };
}

function harness(overrides: { hidden?: () => boolean; subscribeHidden?: (l: () => void) => () => void } = {}) {
  const fake = installer();
  const published: string[] = [];
  const visibility = { hidden: false, listeners: new Set<() => void>() };
  const stop = startAssetPackTransfer({
    build: 'build-a',
    ensure: fake.ensure,
    publish: (state) => { published.push(state.kind); publishAssetPackGate(state); },
    hidden: overrides.hidden ?? (() => visibility.hidden),
    subscribeHidden: overrides.subscribeHidden ?? ((listener) => {
      visibility.listeners.add(listener);
      return () => visibility.listeners.delete(listener);
    }),
    serviceWorker: undefined,
    reloadForBuildMismatch: () => false,
  });
  const setHidden = (hidden: boolean): void => {
    visibility.hidden = hidden;
    for (const listener of visibility.listeners) listener();
  };
  return { ...fake, published, stop, setHidden };
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ screen: 'loading', booted: false });
  useAssetPackGate.setState({ required: false, state: { kind: 'not-required' }, attempt: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('asset-pack transfer discipline (D-101)', () => {
  it('does not start before boot:ready, then starts once the scene is up', async () => {
    const h = harness();
    expect(h.ensure).not.toHaveBeenCalled();
    useApp.getState().setBooted(true);
    bus.emit('boot:ready', undefined);
    expect(h.ensure).toHaveBeenCalledOnce();
    expect(h.published).toEqual(['checking']);
    h.resolve(PACK);
    await vi.runAllTimersAsync();
    h.stop();
  });

  it('starts at once on a page whose scene already booted (RETRY after boot cannot miss the event)', () => {
    useApp.setState({ booted: true });
    const h = harness();
    expect(h.ensure).toHaveBeenCalledOnce();
    h.stop();
  });

  it('canvas gameplay never shares the main thread: entering battle aborts, an opaque screen resumes after resumeDelayMs', async () => {
    useApp.setState({ booted: true, screen: 'inventory' });
    const h = harness();
    const first = h.calls[0]!;
    expect(first.signal?.aborted).toBe(false);

    useApp.getState().setScreen('battle');
    expect(first.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs * 10);
    // Still in battle: nothing restarts, however long the raid takes.
    expect(h.ensure).toHaveBeenCalledOnce();

    useApp.getState().setScreen('inventory');
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs - 1);
    expect(h.ensure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.ensure).toHaveBeenCalledTimes(2);
    expect(h.calls[1]!.signal?.aborted).toBe(false);
    // The abort surfaced as `aborted` and was NOT published as an error.
    expect(h.published).not.toContain('error');
    h.stop();
  });

  it('treats scout previews like battles and a hidden tab like a busy screen', async () => {
    useApp.setState({ booted: true, screen: 'inventory' });
    const h = harness();
    useApp.getState().setScreen('scout');
    expect(h.calls[0]!.signal?.aborted).toBe(true);
    useApp.getState().setScreen('mail');
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs);
    expect(h.ensure).toHaveBeenCalledTimes(2);

    h.setHidden(true);
    expect(h.calls[1]!.signal?.aborted).toBe(true);
    // Coming back mid-delay and hiding again cancels the pending resume.
    h.setHidden(false);
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs / 2);
    h.setHidden(true);
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs * 2);
    expect(h.ensure).toHaveBeenCalledTimes(2);
    h.setHidden(false);
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs);
    expect(h.ensure).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it('waits out a battle that is already open when the scene boots', async () => {
    useApp.setState({ booted: false, screen: 'battle' });
    const h = harness();
    useApp.getState().setBooted(true);
    bus.emit('boot:ready', undefined);
    expect(h.ensure).not.toHaveBeenCalled();
    useApp.getState().setScreen('inventory');
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs);
    expect(h.ensure).toHaveBeenCalledOnce();
    h.stop();
  });

  it('publishes progress into the gate slice only, leaving the app store untouched', () => {
    useApp.setState({ booted: true, screen: 'inventory' });
    const appState = useApp.getState();
    const h = harness();
    h.progress(h.calls[0]!, 40);
    expect(useAssetPackGate.getState().state).toEqual({
      kind: 'downloading', totalBytes: 100, totalFiles: 2, downloadedBytes: 40, downloadedFiles: 0,
    });
    expect(useAssetPackGate.getState().required).toBe(true);
    // No app-store write happened: the overlay's own selectors see the same object.
    expect(useApp.getState()).toBe(appState);
    h.stop();
  });

  it('does not publish a stale attempt after a pause, and stops publishing after disposal', () => {
    useApp.setState({ booted: true, screen: 'inventory' });
    const h = harness();
    const first = h.calls[0]!;
    useApp.getState().setScreen('battle');
    h.progress(first, 10);
    expect(useAssetPackGate.getState().state.kind).toBe('checking');
    h.stop();
    h.progress(first, 20);
    expect(useAssetPackGate.getState().state.kind).toBe('checking');
  });

  it('hides pack UI (D-050) when worker control is deferred, and surfaces other failures as retryable errors', async () => {
    useApp.setState({ booted: true, screen: 'inventory' });
    const deferred = harness();
    deferred.resolve(null);
    await vi.runAllTimersAsync();
    expect(useAssetPackGate.getState()).toMatchObject({ required: false, state: { kind: 'not-required' } });
    deferred.stop();

    const failing = harness();
    failing.reject(new AssetPackError('quota', 'Not enough phone storage'));
    await vi.runAllTimersAsync();
    expect(useAssetPackGate.getState()).toMatchObject({
      required: true, state: { kind: 'error', code: 'quota', message: 'NOT ENOUGH PHONE STORAGE' },
    });
    // A terminal outcome is not restarted by later screen changes.
    useApp.getState().setScreen('battle');
    useApp.getState().setScreen('inventory');
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs);
    expect(failing.ensure).toHaveBeenCalledOnce();
    failing.stop();
  });

  it('RETRY bumps the attempt the App hook restarts on', () => {
    expect(useAssetPackGate.getState().attempt).toBe(0);
    useAssetPackGate.getState().retry();
    expect(useAssetPackGate.getState().attempt).toBe(1);
  });

  it('blocks every canvas-visible gameplay screen and lets opaque screens resume', () => {
    for (const screen of ['base', 'build', 'layout', 'battle', 'scout', 'map']) {
      expect(assetPackTransferBlocked(screen, false), screen).toBe(true);
    }
    for (const screen of ['title', 'mail', 'inventory', 'leaderboard']) {
      expect(assetPackTransferBlocked(screen, false), screen).toBe(false);
    }
    expect(assetPackTransferBlocked('inventory', true)).toBe(true);
  });

  it('pauses optional pack work throughout globe/campaign inspection, then resumes off the map', async () => {
    useApp.setState({ booted: true, screen: 'inventory' });
    const h = harness();
    useApp.getState().setScreen('map');
    expect(h.calls[0]!.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs * 5);
    expect(h.ensure).toHaveBeenCalledOnce();
    useApp.getState().setScreen('mail');
    await vi.advanceTimersByTimeAsync(ASSET_PACK_TRANSFER.resumeDelayMs);
    expect(h.ensure).toHaveBeenCalledTimes(2);
    h.stop();
  });
});
