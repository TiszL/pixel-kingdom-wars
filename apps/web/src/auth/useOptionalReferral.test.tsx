/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, API_URL, ApiError } from '../lib/api';
import { bus } from '../lib/events';
import { clearStoredReferralCode, readStoredReferralCode } from '../lib/referral';
import { useApp } from '../state/store';
import { authCookies } from './authCookieCoordinator';
import { useOptionalReferral } from './useOptionalReferral';
import { identity, relationship, deferred, status } from '../lib/referrals/fixtures.test-support';
import { ReferralJournalStore } from '../lib/referrals/journal';
import { referralIdentity } from '../lib/referrals/browser';

function Probe(): React.JSX.Element { useOptionalReferral(); return <span>PLAYABLE</span>; }
let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, action) => action({})) } });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet }); clearStoredReferralCode(); localStorage.setItem('skp_ref', 'KEEP-CQRPF');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, 'get').mockRejectedValue(new ApiError(404, 'unsupported'));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ open: true }));
  vi.spyOn(api, 'post').mockResolvedValue({ referrer: relationship.referrerWallet }); vi.spyOn(api, 'postRaw'); vi.spyOn(bus, 'emit');
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); clearStoredReferralCode(); useApp.setState({ authed: false, wallet: null }); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const mount = () => act(async () => root.render(<StrictMode><Probe /></StrictMode>));
const focus = () => act(async () => window.dispatchEvent(new Event('focus')));
const until = async (assertion: () => void) => act(async () => vi.waitFor(assertion));
const read = () => new ReferralJournalStore(referralIdentity(identity.wallet)).read();
describe('optional referrals in open onboarding', () => {
  it('submits once across StrictMode on an unsupported server, saving the original code before POST', async () => {
    vi.mocked(api.post).mockImplementation(async () => { expect((await read()).code).toBe('KEEP-CQRPF'); return { referrer: relationship.referrerWallet }; });
    await mount(); await until(() => expect(readStoredReferralCode()).toBeNull()); expect(host.textContent).toBe('PLAYABLE');
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/referrals/use', { code: 'KEEP-CQRPF' }, { signal: expect.any(AbortSignal) });
    await focus(); expect(api.post).toHaveBeenCalledTimes(1);
  });
  it('probes authenticated v1 support and retains anonymous public CORS for legacy admission configuration', async () => {
    await mount(); await until(() => expect(readStoredReferralCode()).toBeNull());
    expect(api.get).toHaveBeenCalledExactlyOnceWith('/referrals/v1/status');
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${API_URL}/playtest/access`, { credentials: 'omit', signal: expect.any(AbortSignal) });
    expect(api.post).toHaveBeenCalledOnce();
  });
  it('never treats a failed public response body as permission to consume the code', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ open: true }, { status: 503 })); await mount();
    await until(() => expect(fetch).toHaveBeenCalledOnce()); expect(api.post).not.toHaveBeenCalled(); expect(readStoredReferralCode()).toBe('KEEP-CQRPF');
    await focus(); await until(() => expect(readStoredReferralCode()).toBeNull()); expect(api.post).toHaveBeenCalledOnce();
  });
  it('waits through sign-in and leaves closed access codes for AlphaGate', async () => {
    useApp.setState({ authed: false, wallet: null }); await mount(); expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(Response.json({ open: false })); await act(async () => useApp.setState({ authed: true, wallet: identity.wallet }));
    await until(() => expect(fetch).toHaveBeenCalledOnce()); expect(api.post).not.toHaveBeenCalled(); expect(readStoredReferralCode()).toBe('KEEP-CQRPF');
  });
  it('does no attribution work without a code', async () => {
    clearStoredReferralCode(); await mount(); expect(fetch).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled();
  });
  it('keeps a draft when access configuration is unavailable and permits a later first request', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Network unavailable')); await mount();
    await until(() => expect(bus.emit).toHaveBeenCalled()); expect(readStoredReferralCode()).toBe('KEEP-CQRPF'); expect((await read()).activated).toBe(false);
    await focus(); await until(() => expect(readStoredReferralCode()).toBeNull()); expect(api.post).toHaveBeenCalledOnce();
  });
  it('retains a lost legacy request and makes reconnect GET-only instead of automatically retrying', async () => {
    const pending = deferred<object>(); vi.mocked(api.post).mockReturnValueOnce(pending.promise); await mount();
    await until(() => expect(api.post).toHaveBeenCalledOnce()); await focus(); expect(api.post).toHaveBeenCalledOnce();
    await act(async () => pending.reject(new ApiError(0, 'Offline'))); await until(() => expect(bus.emit).toHaveBeenCalled());
    vi.mocked(api.get).mockResolvedValue(status()); await act(async () => window.dispatchEvent(new Event('online')));
    await until(() => expect(api.get).toHaveBeenCalledTimes(2)); expect(api.post).toHaveBeenCalledOnce(); expect(api.postRaw).not.toHaveBeenCalled();
    expect((await read()).code).toBe('KEEP-CQRPF'); expect(host.textContent).toBe('PLAYABLE');
  });
  it.each([404, 422])('keeps original legacy refusal %s because its unversioned error is not recovery proof', async (status) => {
    vi.mocked(api.post).mockRejectedValue(new ApiError(status, 'Invalid referral')); await mount();
    await until(() => expect(bus.emit).toHaveBeenCalled()); expect(readStoredReferralCode()).toBe('KEEP-CQRPF'); expect((await read()).code).toBe('KEEP-CQRPF');
    expect(host.textContent).toBe('PLAYABLE'); await focus(); await until(() => expect(api.get).toHaveBeenCalledTimes(2)); expect(api.post).toHaveBeenCalledOnce();
  });
  it('does not clear a newer captured code when an earlier request finishes', async () => {
    const pending = deferred<object>(); vi.mocked(api.post).mockReturnValueOnce(pending.promise); await mount();
    await until(() => expect(api.post).toHaveBeenCalledOnce()); localStorage.setItem('skp_ref', 'KEEP-ABCDE');
    await act(async () => pending.resolve({ referrer: relationship.referrerWallet })); await until(() => expect(api.post).toHaveBeenCalledOnce());
    expect(readStoredReferralCode()).toBe('KEEP-ABCDE'); expect((await read()).code).toBe('KEEP-CQRPF');
  });
  it('aborts old-session transport and keeps its exact durable code without applying a late response', async () => {
    const pending = deferred<object>(); vi.mocked(api.post).mockReturnValueOnce(pending.promise); await mount();
    await until(() => expect(api.post).toHaveBeenCalledOnce()); const signal = vi.mocked(api.post).mock.calls[0]![2]!.signal!;
    await act(async () => useApp.setState({ authed: false, wallet: null })); expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new ApiError(401, 'Old session'))); expect(readStoredReferralCode()).toBe('KEEP-CQRPF'); expect(bus.emit).not.toHaveBeenCalled();
    expect((await read()).legacy?.result).toBeNull();
  });
  it('supported v1 links require explicit Profile consent and never automatically POST on focus or online', async () => {
    vi.mocked(api.get).mockResolvedValue(status()); await mount(); await until(() => expect(bus.emit).toHaveBeenCalled());
    await focus(); await until(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(api.post).not.toHaveBeenCalled(); expect(api.postRaw).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(readStoredReferralCode()).toBe('KEEP-CQRPF'); expect((await read()).activated).toBe(false);
  });
  it('hiding during the support read fences an obsolete automatic legacy approval even after return', async () => {
    const pending = deferred<unknown>(); vi.mocked(api.get).mockReturnValue(pending.promise); await mount();
    await until(() => expect(api.get).toHaveBeenCalledOnce()); await act(async () => window.dispatchEvent(new Event('pagehide')));
    await act(async () => pending.reject(new ApiError(404, 'unsupported'))); expect(api.post).not.toHaveBeenCalled(); expect((await read()).activated).toBe(false);
  });
});
