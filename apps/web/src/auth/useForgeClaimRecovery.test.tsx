/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useForgeClaimRecovery } from './useForgeClaimRecovery';
import { api } from '../lib/api';
import { authCookies } from './authCookieCoordinator';
import { useApp } from '../state/store';
import { baseA, baseB, deferred, directory, identity, key, receipt, status, target } from '../lib/forgeClaims/fixtures.test-support';
import { forgeClaimIdentity } from '../lib/forgeClaims/browser';
import { ForgeClaimJournalStore } from '../lib/forgeClaims/journal';
let host: HTMLDivElement; let root: Root; let current: ReturnType<typeof useForgeClaimRecovery>;
function Probe() { current = useForgeClaimRecovery(); return <span>{current.state.review?.request.idempotencyKey ?? current.state.journal?.intent?.request.idempotencyKey ?? 'EMPTY'}</span>; }
const until = async (assertion: () => void) => act(async () => vi.waitFor(assertion));
const mount = () => act(async () => root.render(<StrictMode><Probe /></StrictMode>));
const read = async () => { let saved!: Awaited<ReturnType<ForgeClaimJournalStore['read']>>; await act(async () => { saved = await new ForgeClaimJournalStore(forgeClaimIdentity(identity.wallet)).read(); }); return saved; };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, action) => action({})) } });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(key); vi.spyOn(authCookies, 'assertSession').mockReturnValue('session');
  vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet, selectedBaseId: baseA, baseSelectionEpoch: 0, entryPaid: true });
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path.startsWith('/forge/claims/v1/')) return status(); if (path === '/me') return { wallet: identity.wallet, entryPaid: true };
    if (path === '/bases') return directory();
    return { keep: '1', shards: '2', keepRate: 1 };
  });
  vi.spyOn(api, 'postRaw').mockResolvedValue(receipt());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState({ authed: false, wallet: null }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('visible Forge ownership and automatic history', () => {
  it('StrictMode, focus, online and reopen are GET-only and Back discards only unsent consent', async () => {
    await mount(); await until(() => expect(current.state.supported).toBe(true));
    await act(async () => current.controller!.review({ baseId: baseA, day: null })); expect(host.textContent).toBe(key);
    await act(async () => current.controller!.dismiss()); await act(async () => window.dispatchEvent(new Event('focus')));
    await until(() => expect(current.state.busy).toBe(false)); await act(async () => window.dispatchEvent(new Event('online')));
    await until(() => expect(current.state.busy).toBe(false)); expect(api.postRaw).not.toHaveBeenCalled();
  });
  it.each(['pagehide', 'freeze', 'visibility', 'base'] as const)('%s invalidates deferred confirmation before any POST', async (event) => {
    await mount(); await until(() => expect(current.state.supported).toBe(true)); await act(async () => current.controller!.review({ baseId: baseA, day: null }));
    const pending = deferred<unknown>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise); let action!: Promise<void>;
    await act(async () => { action = current.controller!.confirm(); }); await until(() => expect(current.state.busy).toBe(true));
    if (event === 'base') await act(async () => useApp.setState({ selectedBaseId: baseB, baseSelectionEpoch: 1 }));
    else if (event === 'visibility') {
      const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      hidden.mockReturnValue('visible'); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    } else await act(async () => (event === 'freeze' ? document : window).dispatchEvent(new Event(event)));
    await act(async () => { pending.resolve(status()); await action; }); await until(() => expect(current.state.busy).toBe(false)); expect(api.postRaw).not.toHaveBeenCalled(); expect((await read()).intent).toBeNull();
  });
  it('a different wallet never inherits a late result; original account remount uses GET-only recovery', async () => {
    await mount(); await until(() => expect(current.state.supported).toBe(true)); await act(async () => current.controller!.review({ baseId: baseA, day: null }));
    const pending = deferred<unknown>(); vi.mocked(api.postRaw).mockReturnValueOnce(pending.promise); let action!: Promise<void>;
    await act(async () => { action = current.controller!.confirm(); }); await until(() => expect(api.postRaw).toHaveBeenCalledOnce());
    await act(async () => useApp.setState({ wallet: target })); await act(async () => { pending.resolve(receipt()); await action; }); await until(() => expect(current.state.busy).toBe(false));
    expect((await read()).receipt).toBeNull(); expect(host.textContent).toBe('EMPTY');
    vi.mocked(api.get).mockImplementation(async (path) => {
      if (path.startsWith('/forge/claims/v1/')) return status(receipt()); if (path === '/me') return { wallet: identity.wallet, entryPaid: false };
      if (path === '/bases') return { ...directory(), bases: [] }; throw new Error('land-owned route should not run');
    });
    await act(async () => useApp.setState({ wallet: identity.wallet, entryPaid: false })); await until(() => { expect(current.state.journal?.hydrated?.walletKeep).toBe('unavailable'); expect(current.state.busy).toBe(false); });
    await act(async () => current.controller!.finish()); expect(api.postRaw).toHaveBeenCalledOnce(); expect(current.state.journal?.finished).toBe(true);
  });
});
