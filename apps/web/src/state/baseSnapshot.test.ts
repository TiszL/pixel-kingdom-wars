/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../lib/api';
import { captureBaseBalanceCommit, hydrateBaseSnapshot, reloadBase, reloadCurrentBaseSnapshot, selectBaseSnapshot } from './baseSnapshot';
import { bus } from '../lib/events';
import {
  captureBaseSnapshotGuard, useApp, type BalancesDto, type BaseStateDto,
} from './store';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function baseState(): BaseStateDto {
  return {
    player: {
      wallet: 'wallet-a', name: 'Keeper', keepLevel: 1, trophies: 0,
      league: 'bronze', builders: 1, expansions: 0,
    },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  useApp.getState().setAuth(null);
});

describe('authenticated base hydration cancellation', () => {
  it('propagates one abort signal and refuses a transport response that resolves after timeout', async () => {
    useApp.getState().setAuth('wallet-a');
    const guard = captureBaseSnapshotGuard();
    const base = deferred<BaseStateDto>();
    const balances = deferred<BalancesDto>();
    const get = vi.spyOn(api, 'get')
      .mockImplementationOnce(() => base.promise)
      .mockImplementationOnce(() => balances.promise);
    const controller = new AbortController();

    const hydration = hydrateBaseSnapshot(null, guard, controller.signal);
    expect(get).toHaveBeenNthCalledWith(1, '/base', { signal: controller.signal });
    expect(get).toHaveBeenNthCalledWith(2, '/balances', { signal: controller.signal });

    controller.abort();
    base.resolve(baseState());
    balances.resolve({ shards: '10', keep: '20', keepRate: 1 });

    await expect(hydration).rejects.toMatchObject({ name: 'AbortError' });
    expect(useApp.getState()).toMatchObject({
      wallet: 'wallet-a', authed: true, base: null, balances: null,
    });
  });
});


describe('same-base refresh ordering', () => {
  it('a delayed receipt balance cannot overwrite a newer complete snapshot', async () => {
    useApp.getState().setAuth('wallet-a');
    const commitReceiptBalance = captureBaseBalanceCommit(null);
    vi.spyOn(api, 'get').mockResolvedValueOnce(baseState())
      .mockResolvedValueOnce({ shards: '80', keep: '50', keepRate: 1 });
    expect(await reloadCurrentBaseSnapshot()).toBe(true);
    expect(commitReceiptBalance({ shards: '100', keep: '40', keepRate: 1 })).toBe(false);
    expect(useApp.getState().balances).toEqual({ shards: '80', keep: '50', keepRate: 1 });
  });

  it.each(['account', 'base', 'base-return'] as const)('a receipt balance captured before a %s change cannot publish into the new selection', change => {
    useApp.getState().setAuth('wallet-a'); useApp.getState().setSelectedBaseId('base-a');
    const commitReceiptBalance = captureBaseBalanceCommit('base-a');
    if (change === 'account') useApp.getState().setAuth('wallet-b');
    else { useApp.getState().setSelectedBaseId('base-b'); if (change === 'base-return') useApp.getState().setSelectedBaseId('base-a'); }
    useApp.getState().setBalances({ shards: '900', keep: '999', keepRate: 1 });
    expect(commitReceiptBalance({ shards: '100', keep: '40', keepRate: 1 })).toBe(false);
    expect(useApp.getState().balances?.keep).toBe('999');
  });

  it('an unselected deed receipt cannot publish or cancel a current base read', async () => {
    useApp.getState().setAuth('wallet-a'); useApp.getState().setSelectedBaseId('base-a');
    const pending = deferred<BaseStateDto>();
    vi.spyOn(api, 'get').mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ shards: '10', keep: '20', keepRate: 1 });
    const current = reloadCurrentBaseSnapshot();
    expect(captureBaseBalanceCommit('base-b')({ shards: '90', keep: '99', keepRate: 1 })).toBe(false);
    pending.resolve({ ...baseState(), baseId: 'base-a' });
    expect(await current).toBe(true); expect(useApp.getState().balances?.keep).toBe('20');
  });

  it('cannot redraw pre-upgrade tiers and balance after a newer purchase snapshot commits', async () => {
    useApp.getState().setAuth('wallet-a');
    const oldBase = deferred<BaseStateDto>();
    const oldBalance = deferred<BalancesDto>();
    vi.spyOn(api, 'get')
      .mockImplementationOnce(() => oldBase.promise)
      .mockImplementationOnce(() => oldBalance.promise)
      .mockResolvedValueOnce({ ...baseState(), buildings: [{ id: 'wall', type: 'wall', level: 2, tx: 1, ty: 1, underConstruction: false }] })
      .mockResolvedValueOnce({ shards: '80', keep: '0', keepRate: 1 });
    const old = reloadCurrentBaseSnapshot();
    expect(await reloadCurrentBaseSnapshot()).toBe(true);
    oldBase.resolve({ ...baseState(), buildings: [{ id: 'wall', type: 'wall', level: 1, tx: 1, ty: 1, underConstruction: false }] });
    oldBalance.resolve({ shards: '100', keep: '0', keepRate: 1 });
    expect(await old).toBe(false);
    expect(useApp.getState().base?.buildings[0]?.level).toBe(2);
    expect(useApp.getState().balances?.shards).toBe('80');
  });

  it('a background refresh of A cannot defeat an explicit in-flight selection of B', async () => {
    useApp.getState().setAuth('wallet-a');
    useApp.getState().setSelectedBaseId('base-a');
    const target = deferred<BaseStateDto>();
    vi.spyOn(api, 'get').mockImplementationOnce(() => target.promise)
      .mockResolvedValueOnce({ shards: '20', keep: '0', keepRate: 1 })
      .mockResolvedValueOnce({ ...baseState(), baseId: 'base-a' })
      .mockResolvedValueOnce({ shards: '10', keep: '0', keepRate: 1 });
    const selection = selectBaseSnapshot('base-b');
    expect(await reloadCurrentBaseSnapshot()).toBe(true);
    target.resolve({ ...baseState(), baseId: 'base-b' });
    expect(await selection).toBe(true);
    expect(useApp.getState().selectedBaseId).toBe('base-b');
    expect(useApp.getState().balances?.shards).toBe('20');
  });

  it('does not let a stale identity start a newer read and cancel current hydration', async () => {
    useApp.getState().setAuth('wallet-old');
    const stale = captureBaseSnapshotGuard();
    useApp.getState().setAuth('wallet-a');
    const pending = deferred<BaseStateDto>();
    const get = vi.spyOn(api, 'get').mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ shards: '10', keep: '0', keepRate: 1 });
    const current = reloadCurrentBaseSnapshot();
    expect(await hydrateBaseSnapshot(null, stale)).toBe(false);
    pending.resolve(baseState());
    expect(await current).toBe(true);
    expect(get).toHaveBeenCalledTimes(2);
  });
});


describe('background refresh after a completed action', () => {
  const unavailable = () => new ApiError(503, 'deed ownership unavailable or changed', 'DEED_AUTHORITY_UNAVAILABLE');
  const ready = () => {
    useApp.getState().setAuth('wallet-a');
    useApp.getState().setSelectedBaseId('base-a');
  };
  const snapshot = () => ({ ...baseState(), baseId: 'base-a' });
  const balances = { shards: '25', keep: '20', keepRate: 1 };

  it('recovers a transient ownership refusal with GETs without rejecting or replaying an action', async () => {
    vi.useFakeTimers(); ready();
    const post = vi.spyOn(api, 'post');
    const toast = vi.spyOn(bus, 'emit');
    const get = vi.spyOn(api, 'get').mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(balances).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(balances);
    const refresh = reloadBase({ background: true });
    await vi.advanceTimersByTimeAsync(500);
    await expect(refresh).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(4);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/base?baseId=base-a', '/balances?baseId=base-a',
      '/base?baseId=base-a', '/balances?baseId=base-a',
    ]);
    expect(get).toHaveBeenCalledWith('/base?baseId=base-a', expect.objectContaining({
      signal: expect.any(AbortSignal), deferAuthorityUnavailable: true, isCurrent: expect.any(Function),
    }));
    expect(post).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith('base:refresh', undefined);
    expect(useApp.getState()).toMatchObject({ selectedBaseId: 'base-a', base: snapshot(), balances });
  });

  it('ends repeated refusals with one refresh notice and preserves the last coherent snapshot', async () => {
    vi.useFakeTimers(); ready();
    useApp.setState({ base: snapshot(), balances });
    const before = useApp.getState();
    const toast = vi.spyOn(bus, 'emit');
    const get = vi.spyOn(api, 'get').mockRejectedValue(unavailable());
    const refresh = reloadBase({ background: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(refresh).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(6);
    expect(toast).toHaveBeenCalledExactlyOnceWith('ui:toast', { msg: expect.stringContaining('BASE UPDATE DELAYED') });
    expect(useApp.getState()).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces repeated background requests while the same selection is recovering', async () => {
    vi.useFakeTimers(); ready();
    const get = vi.spyOn(api, 'get').mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce(balances).mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(balances);
    const first = reloadBase({ background: true });
    const second = reloadBase({ background: true });
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);
    expect(get).toHaveBeenCalledTimes(4);
  });

  it('reads again after a second completed action and never publishes the known stale in-flight snapshot', async () => {
    ready();
    const firstBase = deferred<BaseStateDto>();
    const firstBalance = deferred<BalancesDto>();
    const old = { ...snapshot(), freeBuilders: 1 };
    const latest = { ...snapshot(), freeBuilders: 2 };
    const newestBalances = { ...balances, keep: '10' };
    useApp.setState({ base: { ...snapshot(), freeBuilders: 0 }, balances });
    const publishedBuilders: number[] = [];
    const stop = useApp.subscribe((state) => { publishedBuilders.push(state.base?.freeBuilders ?? -1); });
    const post = vi.spyOn(api, 'post');
    const get = vi.spyOn(api, 'get')
      .mockImplementationOnce(() => firstBase.promise).mockImplementationOnce(() => firstBalance.promise)
      .mockResolvedValueOnce(latest).mockResolvedValueOnce(newestBalances);
    try {
      // Another training/Forge completion can happen before the first GET
      // returns. Every callback still needs a snapshot taken after its action.
      const firstAction = reloadBase({ background: true });
      const secondAction = reloadBase({ background: true });
      const duplicateRefresh = reloadBase({ background: true });
      expect(get).toHaveBeenCalledTimes(2); // No overlapping reads.
      firstBase.resolve(old); firstBalance.resolve(balances);
      await Promise.all([firstAction, secondAction, duplicateRefresh]);
      expect(get).toHaveBeenCalledTimes(4); // One trailing pair coalesces the two notifications.
      expect(useApp.getState()).toMatchObject({ base: latest, balances: newestBalances });
      expect(publishedBuilders).not.toContain(1);
      expect(post).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it('does not lose a completed action queued while the prior refresh promise is settling', async () => {
    ready();
    const finished = deferred<void>();
    const latest = { ...snapshot(), freeBuilders: 2 };
    const get = vi.spyOn(api, 'get').mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(balances)
      .mockResolvedValueOnce(latest).mockResolvedValueOnce(balances);
    let notify = true;
    const stop = bus.on('base:refresh', () => {
      if (!notify) return;
      notify = false;
      queueMicrotask(() => { void reloadBase({ background: true }).then(() => finished.resolve()); });
    });
    try {
      await Promise.all([reloadBase({ background: true }), finished.promise]);
      expect(get).toHaveBeenCalledTimes(4);
      expect(useApp.getState().base?.freeBuilders).toBe(2);
    } finally { stop(); }
  });

  it.each(['wallet', 'base', 'logout'])('cancels queued retries after a %s change', async (change) => {
    vi.useFakeTimers(); ready();
    const toast = vi.spyOn(bus, 'emit');
    const get = vi.spyOn(api, 'get').mockRejectedValue(unavailable());
    const refresh = reloadBase({ background: true });
    await vi.advanceTimersByTimeAsync(0);
    if (change === 'base') useApp.getState().setSelectedBaseId('base-b');
    else useApp.getState().setAuth(change === 'logout' ? null : 'wallet-b');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(refresh).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an in-flight read on selection changes and ignores a transport resolving late', async () => {
    ready();
    const pending = deferred<BaseStateDto>();
    const get = vi.spyOn(api, 'get').mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(balances);
    const toast = vi.spyOn(bus, 'emit');
    const refresh = reloadBase({ background: true });
    const signal = get.mock.calls[0]?.[1]?.signal;
    useApp.getState().setSelectedBaseId('base-b');
    expect(signal?.aborted).toBe(true);
    pending.resolve(snapshot());
    await expect(refresh).resolves.toBeUndefined();
    expect(useApp.getState()).toMatchObject({ selectedBaseId: 'base-b', base: null });
    expect(toast).not.toHaveBeenCalled();
  });

  it('cancels a dirty trailing refresh when the selected base changes', async () => {
    ready();
    const pending = deferred<BaseStateDto>();
    const get = vi.spyOn(api, 'get').mockImplementationOnce(() => pending.promise).mockResolvedValueOnce(balances);
    const toast = vi.spyOn(bus, 'emit');
    const first = reloadBase({ background: true });
    const trailing = reloadBase({ background: true });
    useApp.getState().setSelectedBaseId('base-b');
    pending.resolve(snapshot());
    await expect(Promise.all([first, trailing])).resolves.toEqual([undefined, undefined]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();
    expect(useApp.getState()).toMatchObject({ selectedBaseId: 'base-b', base: null });
  });

  it('bounds a hung background read without altering the completed action or last state', async () => {
    vi.useFakeTimers(); ready();
    const toast = vi.spyOn(bus, 'emit');
    vi.spyOn(api, 'get').mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));
    const refresh = reloadBase({ background: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(refresh).resolves.toBeUndefined();
    expect(toast).toHaveBeenCalledExactlyOnceWith('ui:toast', { msg: expect.stringContaining('BASE UPDATE DELAYED') });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry unrelated server failures', async () => {
    ready();
    const get = vi.spyOn(api, 'get').mockRejectedValue(new ApiError(500, 'server failed'));
    await expect(reloadBase({ background: true })).resolves.toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('preserves awaited reconciliation failures so callers cannot mistake them for completion', async () => {
    ready();
    const error = unavailable();
    const get = vi.spyOn(api, 'get').mockRejectedValue(error);
    await expect(reloadBase()).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.every((call) => call.length === 1)).toBe(true);
  });
});
