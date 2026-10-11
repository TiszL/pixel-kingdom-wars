/** @vitest-environment happy-dom */
import { act } from 'react';
import { IDBFactory } from 'fake-indexeddb';
import { ReferralJournalStore } from '../lib/referrals/journal';
import { referralIdentity } from '../lib/referrals/browser';
import { clearStoredReferralCode } from '../lib/referral';
import { deferred } from '../lib/referrals/fixtures.test-support';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../state/store';

const SESSION_WALLET = 'RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR';
const CONNECTED_WALLET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const apiPost = vi.fn();
const apiPostRaw = vi.fn();
const signIn = vi.fn();
const pushLifecycle = vi.hoisted(() => ({ suspend: vi.fn() }));
let connected: string | null = CONNECTED_WALLET;

vi.mock('@solana/wallet-adapter-react', () => ({
  useConnection: () => ({ connection: null }),
  useWallet: () => ({ publicKey: connected ? { toBase58: () => connected } : null }),
}));
vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({}),
  useSolanaWallets: () => ({ wallets: [] }),
}));
vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ signIn, signingIn: false, error: null }),
}));
vi.mock('../auth/useSocialAuth', () => ({
  useSocialAuth: () => ({ signInWithSocial: vi.fn(), signingIn: false, error: null }),
}));
vi.mock('../auth/useSignOut', () => ({ useSignOut: () => vi.fn() }));
vi.mock('../auth/useWalletSessionFence', () => ({ useWalletSessionFence: () => undefined }));
vi.mock('../lib/pushSubscription', () => ({ suspendPushSession: pushLifecycle.suspend }));
vi.mock('../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, signMessage: null }),
}));
vi.mock('../auth/useEntry', () => ({
  usePayEntry: () => ({ reserve: vi.fn(), submit: vi.fn(), phase: 'idle', error: null, reservation: null }),
}));
vi.mock('./useFetch', () => ({ useFetch: () => ({ data: null, reload: vi.fn() }) }));
vi.mock('./useSolBalance', () => ({ useSolBalance: () => null }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      logout: async (before?: () => Promise<unknown>) => { await before?.(); return apiPost('/auth/logout'); },
      get: vi.fn(() => new Promise(() => undefined)),
      post: (...args: unknown[]) => apiPost(...args),
      postRaw: (...args: unknown[]) => apiPostRaw(...args),
    },
  };
});

import { bus } from '../lib/events';
import { AlphaGateScreen } from './Overlay';

async function mountGate(): Promise<{ host: HTMLDivElement; unmount: () => Promise<void> }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<AlphaGateScreen />));
  // let the mount-time Seeker probe resolve
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

const buttons = (host: HTMLElement, text: string): HTMLButtonElement[] =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes(text));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, action) => action({})) } });
  clearStoredReferralCode();
  apiPost.mockReset();
  apiPostRaw.mockReset();
  signIn.mockReset();
  pushLifecycle.suspend.mockReset().mockResolvedValue(undefined);
  connected = CONNECTED_WALLET;
  // Restore-path shape: /me 403'd before setAuth ever ran, so the store knows
  // no session; only the probe can name the wallet the server actually gated.
  useApp.setState({ screen: 'alphagate', wallet: null, authed: false });
  apiPostRaw.mockImplementation((path: string) => {
    if (path === '/alpha/seeker') {
      return Promise.resolve({ admitted: false, seeker: { linked: false }, wallet: SESSION_WALLET });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
  apiPost.mockResolvedValue({});
});

afterEach(() => {
  clearStoredReferralCode(); vi.unstubAllGlobals();
  useApp.setState({ screen: 'loading', wallet: null, authed: false });
});

describe('closed-alpha gate wallet identity', () => {
  it('names the SESSION wallet the server gated, never the auto-connected adapter key', async () => {
    // WHY: on a phone whose wallet app auto-connects, the adapter key can be a
    // different, fully admitted account. Showing it here made the owner's own
    // admin wallet look gated when a stale test-wallet session was refused.
    const { host, unmount } = await mountGate();
    expect(host.textContent).toContain(`SIGNED IN AS ${SESSION_WALLET}`);
    expect(host.textContent).not.toContain(`SIGNED IN AS ${CONNECTED_WALLET}`);
    await unmount();
  });

  it('offers one-tap sign-in with the connected wallet when it differs from the session', async () => {
    const { host, unmount } = await mountGate();
    const [button] = buttons(host, 'SIGN IN WITH AAAA…AAAA');
    expect(button).toBeTruthy();

    signIn.mockImplementation(async () => {
      useApp.getState().setAuth(CONNECTED_WALLET, true);
    });
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Order matters: the stale session must be revoked BEFORE SIWS mints the
    // new one, or the new cookie would be clobbered by the logout.
    expect(apiPost).toHaveBeenCalledWith('/auth/logout');
    expect(pushLifecycle.suspend).toHaveBeenCalledOnce();
    expect(pushLifecycle.suspend.mock.invocationCallOrder[0]!).toBeLessThan(apiPost.mock.invocationCallOrder[0]!);
    expect(signIn).toHaveBeenCalledOnce();
    expect(apiPost.mock.invocationCallOrder[0]!).toBeLessThan(signIn.mock.invocationCallOrder[0]!);
    expect(useApp.getState().wallet).toBe(CONNECTED_WALLET);
    await unmount();
  });

  it('leaves the gate for the title screen with a toast when the connected-wallet sign-in does not complete', async () => {
    // WHY: useAuth.signIn() resolves (not rejects) when the player declines the
    // signature. The stale session is already revoked by then, so the gate no
    // longer describes anything true; the title screen's plain SIGN IN is the
    // retry, and the toast says why the player is back there.
    const { host, unmount } = await mountGate();
    const toasts: string[] = [];
    const off = bus.on('ui:toast', (t) => { toasts.push(t.msg); });
    signIn.mockImplementation(async () => { /* declined: no setAuth */ });
    const [button] = buttons(host, 'SIGN IN WITH AAAA…AAAA');
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(apiPost).toHaveBeenCalledWith('/auth/logout');
    expect(signIn).toHaveBeenCalledOnce();
    expect(useApp.getState().authed).toBe(false);
    expect(useApp.getState().screen).toBe('title');
    expect(toasts).toContain('SIGN-IN DID NOT COMPLETE — TAP SIGN IN TO RETRY');
    off();
    await unmount();
  });

  it('keeps the replacement wallet unsigned and reports failed logout on the title screen', async () => {
    const { host, unmount } = await mountGate();
    const toasts: string[] = [];
    const off = bus.on('ui:toast', (t) => { toasts.push(t.msg); });
    apiPost.mockRejectedValue(new Error('Unable to reach the game server'));
    const [button] = buttons(host, 'SIGN IN WITH AAAA…AAAA');
    await act(async () => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(signIn).not.toHaveBeenCalled();
    expect(useApp.getState().authed).toBe(false);
    expect(useApp.getState().screen).toBe('title');
    expect(toasts).toContain('Unable to reach the game server');
    off(); await unmount();
  });

  it('shows no switch action when the connected wallet IS the gated session wallet', async () => {
    connected = SESSION_WALLET;
    const { host, unmount } = await mountGate();
    expect(host.textContent).toContain(`SIGNED IN AS ${SESSION_WALLET}`);
    expect(buttons(host, 'SIGN IN WITH')).toHaveLength(0);
    await unmount();
  });

  it('shows no switch action for a session without a connected adapter (social / embedded wallet)', async () => {
    connected = null;
    const { host, unmount } = await mountGate();
    expect(host.textContent).toContain(`SIGNED IN AS ${SESSION_WALLET}`);
    expect(buttons(host, 'SIGN IN WITH')).toHaveLength(0);
    await unmount();
  });
});

const alphaSaved = () => new ReferralJournalStore(referralIdentity(SESSION_WALLET));
const inputCode = async (host: HTMLElement, value: string): Promise<void> => {
  const input = host.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const until = async (assertion: () => void) => vi.waitFor(async () => { await act(async () => { await Promise.resolve(); }); assertion(); });
describe('closed-alpha referral recovery', () => {
  it('already-admitted probe never starts a closed-alpha referral command from a captured link', async () => {
    localStorage.setItem('skp_ref', 'KEEP-ABCDE'); apiPostRaw.mockResolvedValue({ admitted: true, seeker: { linked: false }, wallet: SESSION_WALLET });
    const { host, unmount } = await mountGate(); await until(() => expect(useApp.getState().authed).toBe(true));
    expect(apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral')).toHaveLength(0); expect((await alphaSaved().read()).activated).toBe(false);
    expect(host.textContent).toContain('JOIN THE PLAYTEST'); await unmount();
  });
  it('fences both automatic and manual referral paths after a saved v1 intent while admin invites keep their route', async () => {
    const s = alphaSaved(); await s.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE' }));
    localStorage.setItem('skp_ref', 'KEEP-CQRPF'); const { host, unmount } = await mountGate();
    await until(() => expect(host.textContent).toContain('saved referral'));
    await inputCode(host, 'KEEP-CQRPF'); await act(async () => buttons(host, 'ENTER THE PLAYTEST')[0]!.click());
    await until(() => expect(buttons(host, 'ENTER THE PLAYTEST')[0]?.disabled).toBe(false));
    expect(apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral')).toHaveLength(0);
    apiPostRaw.mockImplementation(async (path: string) => { if (path === '/alpha/redeem') return { ok: true, wallet: SESSION_WALLET }; throw new Error(path); });
    await inputCode(host, 'ADMIN-INVITE'); await act(async () => buttons(host, 'ENTER THE PLAYTEST')[0]!.click());
    expect(apiPostRaw).toHaveBeenCalledWith('/alpha/redeem', { code: 'ADMIN-INVITE' }); await unmount();
  });
  it('does not use the connected adapter as identity while the authenticated account probe is unresolved', async () => {
    const pending = deferred<unknown>(); apiPostRaw.mockReturnValue(pending.promise); const { host, unmount } = await mountGate();
    await inputCode(host, 'KEEP-ABCDE'); await act(async () => buttons(host, 'ENTER THE PLAYTEST')[0]!.click());
    await until(() => expect(host.textContent).toContain('SIGNED-IN ACCOUNT'));
    expect(apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral')).toHaveLength(0); await unmount();
    pending.resolve({ admitted: false, seeker: { linked: false }, wallet: SESSION_WALLET });
  });
  it('saves a lost admission before POST and restores GET-only; explicit retry retains the original code and route', async () => {
    localStorage.setItem('skp_ref', 'KEEP-ABCDE');
    apiPostRaw.mockImplementation(async (path: string, body: { code?: string }) => {
      if (path === '/alpha/seeker') return { admitted: false, seeker: { linked: false }, wallet: SESSION_WALLET };
      expect(path).toBe('/alpha/referral'); expect(body.code).toBe('KEEP-ABCDE');
      expect((await alphaSaved().read()).legacy).toEqual({ route: '/alpha/referral', code: 'KEEP-ABCDE', result: null }); throw new Error('lost admission');
    });
    const first = await mountGate(); await until(() => expect(first.host.querySelector('input')?.value).toBe('KEEP-ABCDE')); await first.unmount();
    const before = apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral').length; expect(before).toBe(1);
    const second = await mountGate(); await until(() => expect(second.host.textContent).toContain('RETRY THIS SAME CODE EXPLICITLY'));
    expect(apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral')).toHaveLength(before);
    await inputCode(second.host, 'KEEP-CQRPF'); await act(async () => buttons(second.host, 'ENTER THE PLAYTEST')[0]!.click());
    expect(apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral')).toHaveLength(before);
    await inputCode(second.host, 'KEEP-ABCDE');
    apiPostRaw.mockResolvedValue({ ok: true, wallet: SESSION_WALLET }); await act(async () => buttons(second.host, 'ENTER THE PLAYTEST')[0]!.click());
    await until(() => expect((useApp.getState()).authed).toBe(true));
    expect(apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral')).toHaveLength(before + 1);
    expect((await alphaSaved().read()).legacy?.result).toEqual({ ok: true, wallet: SESSION_WALLET }); await second.unmount();
  });
  it('a positive attribution record alone never admits a player or hides unresolved alpha recovery', async () => {
    const s = alphaSaved(); await s.compareAndSet(0, (r) => ({ ...r, activated: true, code: 'KEEP-ABCDE',
      legacy: { route: '/alpha/referral', code: 'KEEP-ABCDE', result: null }, outcome: 'observed', relationship: {
        id: '00000000-0000-4000-8000-000000000001', refereeWallet: SESSION_WALLET, referrerWallet: CONNECTED_WALLET, createdAt: '2026-09-13T00:00:00.000Z',
      } }));
    const { host, unmount } = await mountGate(); await until(() => expect(host.textContent).toContain('RETRY THIS SAME CODE EXPLICITLY'));
    expect(useApp.getState().authed).toBe(false); expect(apiPostRaw.mock.calls.filter((c) => c[0] === '/alpha/referral')).toHaveLength(0); await unmount();
  });
});
