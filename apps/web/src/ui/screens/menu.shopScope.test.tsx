/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { ShopItemsTab } from './menu';
import { reloadBase } from '../sheets';
import type { ShopItemsDto } from './shopCatalog';
vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false }) }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn() }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
const data = (name: string): ShopItemsDto => ({ catalog: [{ id: 'item', name, kind: 'consumable',
  rarity: 'common', weight: 1, costKeep: 60, asset: 'ui_icon_swiftboots', desc: name,
  acquisition: { type: 'shop' }, maxOwned: 1, activation: { kind: 'troop', active: true } }], owned: [] });
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return { promise,resolve,reject }; };
let root: Root; let host: HTMLDivElement;
const buy = () => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('BUY'));
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  useApp.getState().setAuth('wallet-a'); useApp.getState().setSelectedBaseId('base-a');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(reloadBase).mockClear();
});
afterEach(async () => { await act(async()=>root.unmount()); host.remove(); vi.restoreAllMocks(); useApp.getState().setAuth(null); });
describe('Shop inventory belongs to the currently selected identity', () => {
  it('removes old base BUY controls after a failed switch and explicitly retries the current base', async () => {
    const next = deferred<ShopItemsDto>();
    const get = vi.spyOn(api,'get').mockResolvedValueOnce(data('BASE A STOCK')).mockImplementationOnce(()=>next.promise).mockResolvedValueOnce(data('BASE B STOCK'));
    await act(async()=>root.render(<ShopItemsTab/>)); expect(buy()).toBeDefined();
    await act(async()=>useApp.getState().setSelectedBaseId('base-b'));
    expect(host.textContent).not.toContain('BASE A STOCK'); expect(buy()).toBeUndefined();
    await act(async()=>next.reject(new Error('Base B unavailable')));
    expect(host.textContent).not.toContain('BASE A STOCK'); expect(buy()).toBeUndefined();
    expect(host.textContent).toContain('Base B unavailable');
    const retry=[...host.querySelectorAll('button')].find(b=>b.textContent==='RETRY')!;
    expect(retry).toBeDefined(); await act(async()=>retry.click());
    expect(get).toHaveBeenLastCalledWith('/items?baseId=base-b');
    expect(host.textContent).toContain('BASE B STOCK'); expect(buy()).toBeDefined();
  });
  it('cannot apply an old account response even when both accounts have no selected base', async () => {
    useApp.getState().setSelectedBaseId(null);
    const old = deferred<ShopItemsDto>();
    const get=vi.spyOn(api,'get').mockImplementationOnce(()=>old.promise).mockResolvedValueOnce(data('WALLET B STOCK'));
    await act(async()=>root.render(<ShopItemsTab/>));
    await act(async()=>useApp.getState().setAuth('wallet-b'));
    expect(get).toHaveBeenCalledTimes(2);
    await act(async()=>old.resolve(data('WALLET A STOCK')));
    expect(host.textContent).toContain('WALLET B STOCK'); expect(host.textContent).not.toContain('WALLET A STOCK');
  });
  it('does not refresh or announce another base when an old-base purchase response arrives late', async () => {
    vi.spyOn(api,'get').mockResolvedValueOnce(data('BASE A STOCK')).mockResolvedValueOnce(data('BASE B STOCK'));
    const purchase=deferred<unknown>(); const post=vi.spyOn(api,'post').mockImplementation(()=>purchase.promise);
    await act(async()=>root.render(<ShopItemsTab/>)); await act(async()=>buy()!.click());
    expect(post).toHaveBeenCalledWith('/items/buy',{itemId:'item',baseId:'base-a'});
    await act(async()=>useApp.getState().setSelectedBaseId('base-b'));
    await act(async()=>purchase.resolve({}));
    expect(reloadBase).not.toHaveBeenCalled(); expect(host.textContent).toContain('BASE B STOCK');
    expect(buy()?.disabled).toBe(false);
  });
});
