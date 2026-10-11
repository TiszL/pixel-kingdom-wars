/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/audio', () => ({ playSfx: vi.fn() })); vi.mock('../lib/juice', () => ({ haptic: vi.fn() }));
vi.mock('../auth/useSolPurchase', () => ({ useSolPurchase: () => ({ purchase: vi.fn(), phase: 'idle', error: null }) }));
import { api, ApiError } from '../lib/api';
import { playSfx } from '../lib/audio';
import { authCookies } from '../auth/authCookieCoordinator';
import { useApp } from '../state/store';
import { bus } from '../lib/events';
import { HeroRecruitmentJournalStore } from '../lib/heroRecruitment/journal';
import { heroRecruitmentIdentity } from '../lib/heroRecruitment/browser';
import { base, baseA, baseB, deferred, directory, identity, intent, items, key, legacyAck, read, receipt, status, target } from '../lib/heroRecruitment/fixtures.test-support';
import { BuildTray } from './sheets';
let host: HTMLDivElement, root: Root;
const until = async (check: () => void) => act(async () => vi.waitFor(check));
const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find(b => b.textContent === text)!;
const click = (text: string) => act(async () => button(text).click());
const saved = () => new HeroRecruitmentJournalStore(heroRecruitmentIdentity(identity.wallet)).read();
const mount = async (actionsEnabled = true) => { await act(async () => root.render(<StrictMode><BuildTray actionsEnabled={actionsEnabled} /></StrictMode>)); };
const review = async () => {
  await act(async () => bus.emit('build:spot', { tx: 10, ty: 10, valid: true }));
  await until(() => expect(button('REVIEW PLACEMENT')?.disabled).toBe(false)); await click('REVIEW PLACEMENT');
  await until(() => expect(button('CONFIRM HERO PLACEMENT')?.disabled).toBe(false));
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, action) => action({})) } });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(key); vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  vi.spyOn(api, 'get').mockImplementation(read as typeof api.get); vi.spyOn(api, 'postRaw').mockResolvedValue(receipt()); vi.spyOn(api, 'post').mockResolvedValue({});
  useApp.setState({ authed: true, wallet: identity.wallet, screen: 'build', placing: 'heroaltar', buildCategory: 'her', base: base(), selectedBaseId: baseA, baseSelectionEpoch: 0, entryPaid: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState({ authed: false, wallet: null, base: null, screen: 'base', placing: null }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('actual Build Tray durable Hero control', () => {
  it('reviews exact tile/contract-only consent and shows durable acceptance without declaring the Hero ready', async () => {
    await mount(); await review(); expect(host.textContent).toContain('tile 10, 10'); expect(host.textContent).toContain(baseA);
    expect(host.textContent).toContain('No Gems or KEEP authorized'); expect(api.postRaw).not.toHaveBeenCalled(); await click('CONFIRM HERO PLACEMENT');
    await until(() => expect(button('FINISH REVIEW')?.disabled).toBe(false));
    expect((await saved()).receipt).toEqual(receipt()); expect(host.textContent).toContain('Acceptance does not mean the Hero is ready');
    expect(api.postRaw).toHaveBeenCalledExactlyOnceWith('/heroes/recruit/v1', intent().request, expect.any(Object)); expect(api.post).not.toHaveBeenCalled();
    expect(playSfx).toHaveBeenCalledWith('sfx_place_thump'); expect(useApp.getState().placing).toBeNull();
  });
  it.each(['GEMS', 'KEEP'] as const)('reviews %s and saves that currency before POST and authoritative funding proof', async currency => {
    const funds = { keep: '1000000', shards: '1000', keepRate: 1, gems: currency === 'GEMS' ? '1000000' : '0',
      features: { gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 } } };
    vi.mocked(api.get).mockImplementation(async path => path.startsWith('/items') ? items(0) as never : path.startsWith('/balances') ? funds as never : await read(path) as never);
    const paid = receipt(baseA, false); if (paid.funding.kind !== 'contract') paid.funding.kind = currency === 'GEMS' ? 'gems' : 'keep';
    vi.mocked(api.postRaw).mockImplementation(async () => { expect((await saved()).intent?.expectedCurrency).toBe(currency); return paid as never; });
    await mount(); await review(); expect(host.textContent).toContain(`${paid.request.maxCostKeep} ${currency}. No other currency`);
    await click('CONFIRM HERO PLACEMENT'); await until(() => expect(button('FINISH REVIEW')?.disabled).toBe(false));
    expect(api.postRaw).toHaveBeenCalledExactlyOnceWith('/heroes/recruit/v1', paid.request, expect.objectContaining({ expectedCurrency: currency, isCurrent: expect.any(Function) }));
    expect((await saved()).receipt).toEqual(paid); expect(host.textContent).toContain(`${paid.request.maxCostKeep} ${currency} paid.`);
  });
  it('a first exact-currency refusal is durably visible and releases placement without inventing a receipt', async () => {
    vi.mocked(api.get).mockImplementation(async path => path.startsWith('/items') ? items(0) as never : path.startsWith('/balances') ? {
      keep: '1000000', gems: '1000000', shards: '1000', keepRate: 1,
      features: { gameCurrency: { version: 1, exactSpendCurrency: 1 }, gems: { version: 1, receipts: 1 } },
    } as never : await read(path) as never);
    vi.mocked(api.postRaw).mockRejectedValue(new ApiError(409, 'Review again', 'CURRENCY_CONSENT_CHANGED', { expectedCurrency: 'GEMS' }));
    await mount(); await review(); await click('CONFIRM HERO PLACEMENT');
    await until(() => expect(host.textContent).toContain('NOTHING WAS SPENT'));
    expect(await saved()).toMatchObject({ refusal: 'CURRENCY_CONSENT_CHANGED', finished: true, receipt: null });
    expect(button('RETRY SAME HERO PLACEMENT')).toBeUndefined();
    expect(playSfx).not.toHaveBeenCalledWith('sfx_place_thump');
  });
  it('lost v1 reply survives remount and changed selected base; foreground GET finds acceptance silently', async () => {
    vi.mocked(api.postRaw).mockRejectedValue(new Error('lost')); await mount(); await review(); await click('CONFIRM HERO PLACEMENT');
    await until(() => expect(host.textContent).toContain('unconfirmed')); expect((await saved()).intent).toEqual(intent());
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => useApp.setState({ selectedBaseId: baseB, base: base(baseB), baseSelectionEpoch: 1, screen: 'base' }));
    await mount();
    await until(() => expect(button('REVIEW HERO PLACEMENT')).toBeTruthy());
    vi.mocked(api.get).mockImplementation(async path => path.startsWith('/heroes/recruit/v1/') ? status(receipt()) as never : await read(path) as never);
    await act(async () => window.dispatchEvent(new Event('focus'))); await click('REVIEW HERO PLACEMENT');
    await until(() => expect(button('FINISH REVIEW')?.disabled).toBe(false)); expect(useApp.getState().base?.baseId).toBe(baseB);
    expect(api.postRaw).toHaveBeenCalledOnce(); expect(playSfx).not.toHaveBeenCalledWith('sfx_place_thump');
  });
  it('legacy server preserves a fresh exact placement with honest limitation copy and no v1 fallback', async () => {
    vi.mocked(api.get).mockImplementation(async path => { if (path.startsWith('/heroes/recruit/v1/')) throw new ApiError(404, 'old server'); return read(path) as never; });
    vi.mocked(api.postRaw).mockResolvedValue(legacyAck()); await mount(); await review(); expect(host.textContent).toContain('no saved Hero receipts'); await click('CONFIRM HERO PLACEMENT');
    await until(() => expect(button('FINISH REVIEW')?.disabled).toBe(false)); expect(api.postRaw).toHaveBeenCalledExactlyOnceWith('/base/buildings', intent('legacy').legacyBody, expect.any(Object));
    expect((await saved()).legacyAcceptance?.building).toEqual(receipt().building); expect((await saved()).receipt).toBeNull();
  });
  it('legacy unknown offers only account refresh and remains unresolved after server upgrade', async () => {
    vi.mocked(api.get).mockImplementation(async path => path.startsWith('/heroes/recruit/v1/') ? status(null, false) as never : await read(path) as never);
    vi.mocked(api.postRaw).mockRejectedValue(new Error('lost')); await mount(); await review(); await click('CONFIRM HERO PLACEMENT');
    await until(() => expect(host.textContent).toContain('Legacy payment retry is unavailable'));
    vi.mocked(api.get).mockImplementation(read as typeof api.get); await act(async () => window.dispatchEvent(new Event('online')));
    await until(() => expect(button('CHECK HERO STATUS')?.disabled).toBe(false)); expect(button('RETRY SAME HERO PLACEMENT')).toBeUndefined();
    expect(button('FINISH REVIEW')).toBeUndefined(); expect(api.postRaw).toHaveBeenCalledOnce(); expect((await saved()).finished).toBe(false);
  });
  it('historical acceptance remains reachable while construction is gated and original deed is gone', async () => {
    const store = new HeroRecruitmentJournalStore(heroRecruitmentIdentity(identity.wallet)); await store.compareAndSet(0, r => ({ ...r, intent: intent() }));
    vi.mocked(api.get).mockImplementation(async path => {
      if (path.startsWith('/heroes/recruit/v1/')) return status(receipt(), false) as never;
      if (path === '/bases') return { ...directory(), bases: [] } as never; if (path === '/me') return { wallet: identity.wallet, entryPaid: false } as never;
      throw new Error('original deed unavailable');
    });
    await mount(false); await until(() => expect(button('FINISH REVIEW')?.disabled).toBe(false));
    expect(host.textContent).toContain('Original base: unavailable'); await click('FINISH REVIEW'); expect((await saved()).finished).toBe(true); expect(api.postRaw).not.toHaveBeenCalled();
  });
  it('an unresolved Hero does not prevent ordinary construction or replace its original intent', async () => {
    const store = new HeroRecruitmentJournalStore(heroRecruitmentIdentity(identity.wallet)); await store.compareAndSet(0, r => ({ ...r, intent: intent('legacy') }));
    useApp.setState({ placing: 'camp', buildCategory: 'bld' }); await mount();
    await act(async () => bus.emit('build:spot', { tx: 12, ty: 12, valid: true }));
    await until(() => expect(button('✓ PLACE')?.disabled).toBe(false)); await click('✓ PLACE');
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/base/buildings', { type: 'camp', tx: 12, ty: 12, baseId: baseA });
    expect((await saved()).intent).toEqual(intent('legacy')); expect(api.postRaw).not.toHaveBeenCalled();
  });
  it.each(['pagehide', 'freeze', 'base', 'wallet', 'screen'])('%s during final preflight cancels the pending approval without POST', async change => {
    await mount(); await review(); const pending = deferred<unknown>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise);
    await click('CONFIRM HERO PLACEMENT');
    if (change === 'base') await act(async () => useApp.setState({ selectedBaseId: baseB, baseSelectionEpoch: 1 }));
    else if (change === 'wallet') await act(async () => useApp.setState({ wallet: target }));
    else if (change === 'screen') await act(async () => useApp.setState({ screen: 'base' }));
    else await act(async () => (change === 'freeze' ? document : window).dispatchEvent(new Event(change)));
    await act(async () => pending.resolve(status())); await until(() => expect(api.postRaw).not.toHaveBeenCalled()); expect((await saved()).intent).toBeNull();
  });
});
