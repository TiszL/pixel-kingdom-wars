/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReferralRecovery } from './useReferralRecovery';
import { api, ApiError } from '../lib/api';
import { authCookies } from './authCookieCoordinator';
import { useApp } from '../state/store';
import { deferred, identity, relationship, response, status } from '../lib/referrals/fixtures.test-support';
import { referralIdentity } from '../lib/referrals/browser';
import { ReferralJournalStore } from '../lib/referrals/journal';

let host: HTMLDivElement; let root: Root; let current: ReturnType<typeof useReferralRecovery>;
function Probe() { current = useReferralRecovery(); return <span>{current.state.review ?? current.state.journal?.code ?? 'EMPTY'}</span>; }
const until = async (assertion: () => void) => act(async () => vi.waitFor(assertion));
const mount = () => act(async () => root.render(<StrictMode><Probe /></StrictMode>));
const read = () => new ReferralJournalStore(referralIdentity(identity.wallet)).read();
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, action) => action({})) } });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet }); vi.spyOn(api, 'get').mockResolvedValue(status());
  vi.spyOn(api, 'postRaw').mockResolvedValue(response()); vi.spyOn(api, 'post').mockResolvedValue({ referrer: relationship.referrerWallet });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState({ authed: false, wallet: null }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('account-owned referral screen lifetime', () => {
  it('StrictMode, focus, online and reopening are GET-only; explicit review then Back performs no mutation', async () => {
    await mount(); await until(() => expect(current.state.supported).toBe(true));
    await act(async () => current.controller!.review('KEEP-ABCDE')); expect(host.textContent).toBe('KEEP-ABCDE');
    await act(async () => current.controller!.dismiss()); await act(async () => window.dispatchEvent(new Event('focus')));
    await until(() => expect(current.state.busy).toBe(false)); await act(async () => window.dispatchEvent(new Event('online')));
    await until(() => expect(current.state.busy).toBe(false)); expect(api.postRaw).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });
  it.each(['pagehide', 'freeze', 'visibility'] as const)('%s invalidates a deferred confirmation before POST, including hide then return', async (event) => {
    await mount(); await until(() => expect(current.state.supported).toBe(true)); await act(async () => current.controller!.review('KEEP-ABCDE'));
    const pending = deferred<unknown>(); vi.mocked(api.get).mockReturnValueOnce(pending.promise); let action!: Promise<void>;
    await act(async () => { action = current.controller!.confirm(); }); await until(() => expect(current.state.busy).toBe(true));
    if (event === 'visibility') {
      const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
      hidden.mockReturnValue('visible'); await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    } else await act(async () => (event === 'freeze' ? document : window).dispatchEvent(new Event(event)));
    await act(async () => { pending.resolve(status()); await action; }); expect(api.postRaw).not.toHaveBeenCalled(); expect((await read()).code).toBeNull();
  });
  it('session removal retains an issued code and remount recovers positive attribution without POST', async () => {
    await mount(); await until(() => expect(current.state.supported).toBe(true)); await act(async () => current.controller!.review('KEEP-ABCDE'));
    const pending = deferred<unknown>(); vi.mocked(api.postRaw).mockReturnValueOnce(pending.promise); let action!: Promise<void>;
    await act(async () => { action = current.controller!.confirm(); }); await until(() => expect(api.postRaw).toHaveBeenCalledOnce());
    await act(async () => useApp.setState({ authed: false, wallet: null })); await act(async () => { pending.resolve(response()); await action; });
    expect((await read()).relationship).toBeNull(); vi.mocked(api.get).mockResolvedValue(status(true));
    await act(async () => useApp.setState({ authed: true, wallet: identity.wallet })); await until(() => expect(current.state.journal?.outcome).toBe('observed'));
    expect(api.postRaw).toHaveBeenCalledOnce();
  });
  it('failed old-server POST immediately exposes saved legacy recovery, then explicitly retries only the original route/code', async () => {
    vi.mocked(api.get).mockRejectedValue(new ApiError(404, 'unsupported')); await mount(); await until(() => expect(current.state.loaded && !current.state.busy).toBe(true));
    vi.mocked(api.post).mockRejectedValueOnce(new Error('lost')); await act(async () => expect(current.legacy('keep-abcde')).rejects.toThrow('lost'));
    expect(current.state.journal?.legacy?.code).toBe('KEEP-ABCDE'); vi.mocked(api.get).mockResolvedValue(status());
    await act(async () => current.controller!.open()); await act(async () => current.controller!.review('KEEP-CQRPF'));
    expect(api.postRaw).not.toHaveBeenCalled(); await act(async () => current.retryLegacy());
    expect(api.post).toHaveBeenCalledTimes(2); expect(vi.mocked(api.post).mock.calls[1]).toEqual(['/referrals/use', { code: 'KEEP-ABCDE' }]);
    expect(current.state.journal?.legacy?.result).toEqual({ referrer: relationship.referrerWallet });
  });
});
