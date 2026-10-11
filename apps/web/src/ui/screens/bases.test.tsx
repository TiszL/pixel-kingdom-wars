/** @vitest-environment happy-dom */
/** Multi-base handoff: fresh ownership resolves device-local selection, five
 * active slots remain capped, and future Earth reservation copy never becomes
 * a fake payable action before the server advertises the capability. */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  api, baseSelectorAvailable, resolveFreshBaseId, type BasesDto, type WalletBaseDto,
} from '../../lib/api';
import {
  reloadCurrentBaseSnapshot, selectBaseSnapshot,
} from '../../state/baseSnapshot';
import {
  captureBaseSnapshotGuard, clearBaseSnapshot, commitBaseSnapshot, useApp,
  type BalancesDto, type BaseStateDto,
} from '../../state/store';
import { BasesView } from './bases';

function base(index: number, status: 'active' | 'inactive' = 'active'): WalletBaseDto {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    deedAssetId: `deed-${index}-abcdefghijklmnopqrstuvwxyz`, status,
    keepLevel: index, builders: 2, expansions: 1, landPaidAt: '2026-08-12T00:00:00.000Z',
    slot: status === 'active' ? index as 1 | 2 | 3 | 4 | 5 : null,
    earthCell: 10_000 + index, countryA3: 'GEO',
  };
}

function directory(overrides: Partial<BasesDto> = {}): BasesDto {
  return {
    enabled: true, maxActive: 5, nextLandPurchaseKind: 'deed',
    capabilities: { baseScopedReads: true, baseScopedMutations: false, cellReservations: false },
    bases: [base(1), base(2)], ...overrides,
  };
}

function baseState(baseId: string, trophies: number): BaseStateDto {
  return {
    baseId,
    player: {
      wallet: 'wallet', name: 'Keeper', keepLevel: 1, trophies,
      league: 'bronze', builders: 1, expansions: 0,
    },
    claim: { min: 0, max: 1 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
    buildings: [], obstacles: [], army: [], heroes: [], jobs: [], freeBuilders: 1,
  };
}

function balances(shards: string): BalancesDto {
  return { shards, keep: '3507265', keepRate: 1 };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useApp.getState().setAuth(null);
});

function seedSnapshot(wallet: string, baseId: string, shards: string, trophies = 167): void {
  useApp.getState().setAuth(wallet);
  expect(commitBaseSnapshot(
    captureBaseSnapshotGuard(), baseId, baseState(baseId, trophies), balances(shards),
  )).toBe(true);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('fresh device-local base selection', () => {
  it('accepts a saved ID only after a fresh active ownership response confirms it', () => {
    const fresh = directory();
    expect(resolveFreshBaseId(fresh, fresh.bases[1]!.id)).toBe(fresh.bases[1]!.id);
    expect(resolveFreshBaseId(fresh, 'stale-or-foreign')).toBeNull();
    expect(resolveFreshBaseId(directory({ bases: [base(1)] }), 'stale')).toBe(base(1).id);
    expect(baseSelectorAvailable(directory({ enabled: false }))).toBe(false);
    expect(baseSelectorAvailable(directory({ capabilities: {
      baseScopedReads: false, baseScopedMutations: false, cellReservations: false,
    } }))).toBe(false);
  });

  it('renders five active slots, inactive deeds, Earth identity and a read-only cutover', () => {
    const active = [1, 2, 3, 4, 5].map((index) => base(index));
    const extra = base(6, 'inactive');
    const html = renderToStaticMarkup(<BasesView
      directory={directory({ bases: [...active, extra] })} selectedBaseId={active[0]!.id}
      loading={false} busy={false} error={null} replaceBaseId={null} canClose
      onClose={vi.fn()} onRetry={vi.fn()} onOpen={vi.fn()} onReplace={vi.fn()} onActivate={vi.fn()}
      onBuyDeed={vi.fn()}
    />);
    expect(html).toContain('5 / 5');
    expect(html).toContain('INACTIVE DEEDS');
    expect(html).toContain('EARTH · 10006 · GEO');
    expect(html).toContain('ACTIVATION LOCKED');
    expect(html).toContain('SERVER CHOOSES AN AVAILABLE EARTH CELL SECURELY');
    expect(html).not.toMatch(/MOON|JUPITER|PAY|RESERVE NOW/);
  });

  it('exposes an additional deed checkout only after the server advertises cell reservations', () => {
    const html = renderToStaticMarkup(<BasesView
      directory={directory({ capabilities: {
        baseScopedReads: true, baseScopedMutations: false, cellReservations: true,
      } })}
      selectedBaseId={base(1).id} loading={false} busy={false} error={null}
      replaceBaseId={null} canClose onClose={vi.fn()} onRetry={vi.fn()} onOpen={vi.fn()}
      onReplace={vi.fn()} onActivate={vi.fn()} onBuyDeed={vi.fn()}
    />);
    expect(html).toContain('BUY ANOTHER LAND DEED');
    expect(html).toContain('BEFORE SIGNING');
  });

  it('keeps every interactive selector target at least 44px', () => {
    const css = readFileSync(`${process.cwd()}/src/ui/screens/bases.css`, 'utf8');
    expect(css).toContain('min-height: 44px');
  });

  it('switches base identity and deed SHARDS in one coherent store update', async () => {
    const oldId = base(1).id;
    const nextId = base(2).id;
    seedSnapshot('wallet-a', oldId, '366622');
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce(baseState(nextId, 0))
      .mockResolvedValueOnce(balances('0'));
    const observed: Array<{ id: string | null; baseId: string | null | undefined; shards: string | undefined }> = [];
    const unsubscribe = useApp.subscribe((state) => observed.push({
      id: state.selectedBaseId, baseId: state.base?.baseId, shards: state.balances?.shards,
    }));

    expect(await selectBaseSnapshot(nextId)).toBe(true);
    unsubscribe();

    expect(get).toHaveBeenNthCalledWith(1, `/base?baseId=${encodeURIComponent(nextId)}`);
    expect(get).toHaveBeenNthCalledWith(2, `/balances?baseId=${encodeURIComponent(nextId)}`);
    expect(observed).toEqual([
      { id: oldId, baseId: oldId, shards: '366622' },
      { id: nextId, baseId: nextId, shards: '0' },
    ]);
    expect(useApp.getState()).toMatchObject({
      selectedBaseId: nextId, base: { baseId: nextId }, balances: { shards: '0' },
    });
    expect(localStorage.getItem('skp_selected_base:wallet-a')).toBe(nextId);
  });

  it('keeps the complete prior deed snapshot when either target read fails or mismatches', async () => {
    const oldId = base(1).id;
    const nextId = base(2).id;
    const oldBase = baseState(oldId, 167);
    const oldBalances = balances('366622');
    seedSnapshot('wallet-a', oldId, oldBalances.shards);
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce(baseState(nextId, 0))
      .mockRejectedValueOnce(new Error('balance unavailable'));

    await expect(selectBaseSnapshot(nextId)).rejects.toThrow('balance unavailable');
    expect(useApp.getState()).toMatchObject({
      selectedBaseId: oldId, base: oldBase, balances: oldBalances,
    });

    get.mockReset()
      .mockResolvedValueOnce(baseState('00000000-0000-4000-8000-000000000999', 0))
      .mockResolvedValueOnce(balances('0'));
    await expect(selectBaseSnapshot(nextId)).rejects.toThrow('Server returned a different base');
    expect(useApp.getState()).toMatchObject({
      selectedBaseId: oldId, base: oldBase, balances: oldBalances,
    });
  });

  it('rejects an old deed refresh that finishes after a new deed snapshot commits', async () => {
    const oldId = base(1).id;
    const nextId = base(2).id;
    seedSnapshot('wallet-a', oldId, '366622');
    const oldBase = deferred<BaseStateDto>();
    const oldBalances = deferred<BalancesDto>();
    vi.spyOn(api, 'get')
      .mockImplementationOnce(() => oldBase.promise)
      .mockImplementationOnce(() => oldBalances.promise)
      .mockResolvedValueOnce(baseState(nextId, 0))
      .mockResolvedValueOnce(balances('0'));

    const staleRefresh = reloadCurrentBaseSnapshot();
    expect(await selectBaseSnapshot(nextId)).toBe(true);
    oldBase.resolve(baseState(oldId, 167));
    oldBalances.resolve(balances('366622'));

    expect(await staleRefresh).toBe(false);
    expect(useApp.getState()).toMatchObject({
      selectedBaseId: nextId, base: { baseId: nextId }, balances: { shards: '0' },
    });
  });

  it('lets the latest overlapping deed selection win even if the older read finishes last', async () => {
    const oldId = base(1).id;
    const middleId = base(2).id;
    const latestId = base(3).id;
    seedSnapshot('wallet-a', oldId, '366622');
    const middleBase = deferred<BaseStateDto>();
    const middleBalances = deferred<BalancesDto>();
    vi.spyOn(api, 'get')
      .mockImplementationOnce(() => middleBase.promise)
      .mockImplementationOnce(() => middleBalances.promise)
      .mockResolvedValueOnce(baseState(latestId, 3))
      .mockResolvedValueOnce(balances('300'));

    const olderSelection = selectBaseSnapshot(middleId);
    expect(await selectBaseSnapshot(latestId)).toBe(true);
    middleBase.resolve(baseState(middleId, 2));
    middleBalances.resolve(balances('200'));

    expect(await olderSelection).toBe(false);
    expect(useApp.getState()).toMatchObject({
      selectedBaseId: latestId, base: { baseId: latestId }, balances: { shards: '300' },
    });
  });

  it('discards a deed response after logout or wallet replacement', async () => {
    const oldId = base(1).id;
    const nextId = base(2).id;
    seedSnapshot('wallet-a', oldId, '366622');
    const nextBase = deferred<BaseStateDto>();
    const nextBalances = deferred<BalancesDto>();
    vi.spyOn(api, 'get')
      .mockImplementationOnce(() => nextBase.promise)
      .mockImplementationOnce(() => nextBalances.promise);

    const selection = selectBaseSnapshot(nextId);
    useApp.getState().setAuth('wallet-b');
    nextBase.resolve(baseState(nextId, 0));
    nextBalances.resolve(balances('0'));

    expect(await selection).toBe(false);
    expect(useApp.getState()).toMatchObject({
      wallet: 'wallet-b', selectedBaseId: null, base: null, balances: null,
    });
    expect(localStorage.getItem('skp_selected_base:wallet-b')).toBeNull();
  });

  it('commits fresh server state even when device preference storage is unavailable', async () => {
    const oldId = base(1).id;
    const nextId = base(2).id;
    seedSnapshot('wallet-a', oldId, '366622');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled');
    });
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(baseState(nextId, 0))
      .mockResolvedValueOnce(balances('0'));

    expect(await selectBaseSnapshot(nextId)).toBe(true);
    expect(useApp.getState()).toMatchObject({
      selectedBaseId: nextId, base: { baseId: nextId }, balances: { shards: '0' },
    });
  });

  it('clears identity, base and deed balance together when ownership becomes invalid', () => {
    const oldId = base(1).id;
    seedSnapshot('wallet-a', oldId, '366622');

    clearBaseSnapshot();

    expect(useApp.getState()).toMatchObject({ selectedBaseId: null, base: null, balances: null });
    expect(localStorage.getItem('skp_selected_base:wallet-a')).toBeNull();
  });
});
