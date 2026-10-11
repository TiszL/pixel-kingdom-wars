/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: null, disconnect: vi.fn() }), useConnection: () => ({ connection: null }) }));
vi.mock('../../auth/useSignOut', () => ({ useSignOut: () => vi.fn() }));
vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, sendTransaction: null }) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() })); vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
import { ClansScreen } from './menu';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { baseA, clanId, directory, identity, intent, key, mine, receipt, status, target } from '../../lib/clans/fixtures.test-support';
import { clanIdentity } from '../../lib/clans/browser';
import { ClanJournalStore } from '../../lib/clans/journal';
let host: HTMLDivElement; let root: Root;
const until = async (assertion: () => void) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { assertion(); return; } catch (error) { if (attempt === 99) throw error; }
  }
};
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name);
const read = () => new ClanJournalStore(clanIdentity(identity.wallet)).read();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, action) => action({})) } });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(key); vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet, base: null, baseDirectory: directory(), selectedBaseId: baseA, baseSelectionEpoch: 0, entryPaid: true, screen: 'clans' });
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path.startsWith('/clans/v1/')) return status();
    if (path === '/me') return { wallet: identity.wallet, entryPaid: true }; if (path === '/bases') return directory();
    if (path === '/clans/mine') return { clan: { ...mine().clan, tag: 'ONE', inviteMode: 'open', inviteCode: null,
      roster: [{ wallet: identity.wallet, name: 'Leader', keepLevel: 3, trophies: 0, joinedAt: '2026-09-12T00:00:00Z' }] } };
    if (path === '/clans') return { clans: [] }; if (path.startsWith('/balances')) return { keep: '1', shards: '2', keepRate: 1 };
    throw new Error(path);
  });
  vi.spyOn(api, 'postRaw').mockResolvedValue(receipt()); vi.spyOn(api, 'post');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState({ authed: false, wallet: null }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('actual Clans screen integration', () => {
  it('current roster requires explicit original consent before one versioned leave; no legacy fallback', async () => {
    await act(async () => root.render(<ClansScreen />)); await until(() => expect(button('DISBAND CLAN')?.disabled).toBe(false));
    await act(async () => button('DISBAND CLAN')!.click()); await until(() => expect(button('CONFIRM LEAVE / DISBAND')?.disabled).toBe(false));
    expect(host.textContent).toContain(clanId); expect(host.textContent).toContain(baseA); expect(api.postRaw).not.toHaveBeenCalled();
    await act(async () => button('CONFIRM LEAVE / DISBAND')!.click()); await until(() => expect(button('FINISH REVIEW')?.disabled).toBe(false));
    expect(api.postRaw).toHaveBeenCalledExactlyOnceWith('/clans/v1/leave', intent().request, expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(api.post).not.toHaveBeenCalled(); expect(host.textContent).toContain('456 SHARDS');
  });
  it('a deedless player can recover/Finish historical proof without any owned roster or balance request', async () => {
    useApp.setState({ entryPaid: false }); const s = new ClanJournalStore(clanIdentity(identity.wallet)); await s.compareAndSet(0, (r) => ({ ...r, intent: intent() }));
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith('/clans/v1/')) return status(receipt()); if (path === '/me') return { wallet: identity.wallet, entryPaid: false };
      if (path === '/bases') return { ...directory(), bases: [] }; throw new Error(`owned request ${path}`);
    });
    await act(async () => root.render(<ClansScreen />)); await until(() => expect(button('FINISH REVIEW')?.disabled).toBe(false));
    expect(host.textContent).toContain('CLANS NEED LAND'); expect(host.textContent).toContain('unavailable in the current account directory');
    await act(async () => button('FINISH REVIEW')!.click()); await until(() => expect(host.textContent).toContain('Review finished'));
    expect(api.get).not.toHaveBeenCalledWith('/clans/mine'); expect(api.get).not.toHaveBeenCalledWith('/clans'); expect(api.postRaw).not.toHaveBeenCalled();
  });
  it('unsupported server keeps its current roster readable while mutation controls remain disabled', async () => {
    const get = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path) => { if (path.startsWith('/clans/v1/')) throw new ApiError(404, 'unsupported'); return get(path); });
    await act(async () => root.render(<ClansScreen />)); await until(() => expect(host.textContent).toContain('Management stays read-only'));
    expect(button('DISBAND CLAN')?.disabled).toBe(true); expect(host.textContent).toContain('Management stays read-only'); expect(api.postRaw).not.toHaveBeenCalled();
  });
  it('wallet replacement remounts roster and original command state without leaking saved old consent', async () => {
    const s = new ClanJournalStore(clanIdentity(identity.wallet)); await s.compareAndSet(0, (r) => ({ ...r, intent: intent() }));
    await act(async () => root.render(<ClansScreen />)); await until(() => expect(host.textContent).toContain('ORIGINAL CLAN'));
    await act(async () => useApp.setState({ entryPaid: false })); vi.mocked(api.get).mockImplementation(async (path) => path.startsWith('/clans/v1/') ? { ...status(), wallet: target } : {});
    await act(async () => useApp.setState({ wallet: target })); await until(() => expect(host.textContent, host.textContent ?? '').not.toContain('ORIGINAL CLAN'));
    expect((await read()).intent).toEqual(intent()); expect(api.postRaw).not.toHaveBeenCalled();
  });
});
