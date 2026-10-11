/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: null, disconnect: vi.fn() }), useConnection: () => ({ connection: null }) }));
vi.mock('../../auth/useSignOut', () => ({ useSignOut: () => vi.fn() }));
vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, sendTransaction: null }) }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
import { ProfileScreen } from './menu';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { identity, status, response, deferred } from '../../lib/referrals/fixtures.test-support';
let host: HTMLDivElement; let root: Root;
const until = async (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); assertion(); });
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name, _options, action) => action({})) } });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.setState({ authed: true, wallet: identity.wallet, base: null, baseDirectory: null, selectedBaseId: null, screen: 'profile' });
  localStorage.setItem('skp_ref', 'KEEP-ABCDE');
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/referrals/code') return { code: 'KEEP-CQRPF', bonusBps: 50 };
    if (path === '/referrals/v1/status') return status();
    if (path === '/me') return { wallet: identity.wallet, name: '', entryPaid: false, deedAssetId: null };
    if (path === '/tutorial') return { guideSkipped: false };
    if (path === '/tester/me') return { wallet: identity.wallet, name: null, points: 0, rank: null, milestonePoints: 0, feedbackPoints: 0, feedbackCount: 0,
      milestones: [], justEarned: [], referrals: { invited: 1, qualified: 0, activeToday: 0 } };
    throw new Error(path);
  });
  vi.spyOn(api, 'postRaw').mockResolvedValue(response()); vi.spyOn(api, 'post');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.removeItem('skp_ref'); useApp.setState({ authed: false, wallet: null }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Profile referral integration', () => {
  it('keeps the own shareable code and bonus beside optional entry for a deedless signed-in player', async () => {
    await act(async () => root.render(<ProfileScreen />)); await until(() => expect(button('REVIEW CODE')?.disabled).toBe(false));
    expect(host.querySelector('.copyable-all')?.textContent).toBe('KEEP-CQRPF'); expect(button('COPY CODE')).toBeDefined(); expect(button('SHARE LINK')).toBeDefined();
    expect(host.textContent).toContain('OPTIONAL REFERRAL'); expect(api.postRaw).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
  });
  it('requires explicit normalized confirmation in the actual Profile before one v1 submission', async () => {
    await act(async () => root.render(<ProfileScreen />)); await until(() => expect(button('REVIEW CODE')?.disabled).toBe(false));
    await act(async () => button('REVIEW CODE')!.click()); await until(() => expect(button('CONFIRM REFERRAL')?.disabled).toBe(false));
    expect(host.textContent).toContain('REVIEW · KEEP-ABCDE'); expect(api.postRaw).not.toHaveBeenCalled();
    await act(async () => button('CONFIRM REFERRAL')!.click()); await until(() => expect(host.textContent).toContain('Your referral attribution was applied.'));
    expect(api.postRaw).toHaveBeenCalledExactlyOnceWith('/referrals/v1/use', { code: 'KEEP-ABCDE' }); expect(api.post).not.toHaveBeenCalled();
  });
  it('changing wallet remounts local referral busy/notices while the original legacy request remains isolated', async () => {
    const pending = deferred<unknown>(); vi.mocked(api.get).mockImplementation(async (path) => {
      if (path === '/referrals/v1/status') throw new ApiError(404, 'unsupported');
      if (path === '/tester/me') return { wallet: useApp.getState().wallet, name: null, points: 0, rank: null, milestonePoints: 0, feedbackPoints: 0, feedbackCount: 0, milestones: [], justEarned: [] };
      return {};
    });
    vi.mocked(api.post).mockReturnValue(pending.promise); await act(async () => root.render(<ProfileScreen />));
    await until(() => expect(button('USE CODE')?.disabled).toBe(false)); await act(async () => button('USE CODE')!.click());
    await until(() => expect(api.post).toHaveBeenCalledOnce());
    await act(async () => useApp.setState({ wallet: '3'.repeat(32) }));
    await until(() => expect(button('USE CODE')?.disabled).toBe(false));
    await act(async () => pending.reject(new Error('original wallet response lost')));
    expect(host.textContent).not.toContain('original wallet response lost'); expect(api.post).toHaveBeenCalledOnce();
  });

});
