/**
 * @vitest-environment happy-dom
 *
 * Privy owns the login modal. These tests pin the two lifecycle exits that the
 * hook must distinguish: closing unauthenticated unlocks retry, while successful
 * authentication remains pending until the embedded wallet completes SIWS.
 */
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface LoginCallbacks {
  onComplete?: () => void;
  onError?: (code: string) => void;
}

interface EmbeddedWallet {
  address: string;
  standardWallet: { isPrivyWallet: boolean };
  signMessage: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  ready: true,
  walletsReady: true,
  authenticated: false,
  gameAuthed: false,
  user: null as null | { id: string; linkedAccounts: Array<{type: string; chainType: string; connectorType: string}> },
  options: vi.fn(),
  getAccessToken: vi.fn(),
  getIdentityToken: vi.fn(),
  wallets: [] as EmbeddedWallet[],
  callbacks: null as LoginCallbacks | null,
  callbackHistory: [] as LoginCallbacks[],
  login: vi.fn(),
  createWallet: vi.fn(),
  get: vi.fn(),
  postRaw: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({ ready: h.ready, authenticated: h.authenticated, user: h.user }),
  getAccessToken: h.getAccessToken,
  getIdentityToken: h.getIdentityToken,
  useLogin: (callbacks: LoginCallbacks) => {
    h.callbacks = callbacks;
    h.callbackHistory.push(callbacks);
    return { login: h.login };
  },
}));

vi.mock('@privy-io/react-auth/solana', () => ({
  useWallets: () => ({ ready: h.walletsReady, wallets: h.wallets }),
  useCreateWallet: () => ({ createWallet: h.createWallet }),
}));

vi.mock('../lib/api', () => ({
  api: { get: (path: string) => path === '/auth/options' ? h.options() : h.get(path), postRaw: h.postRaw, postAuth: (path: string, body: unknown) => h.postRaw(path, body), waitForAuth: () => Promise.resolve() },
}));

vi.mock('../state/store', () => ({
  useApp: Object.assign((select: (state: { setAuth: typeof h.setAuth }) => unknown) =>
    select({ setAuth: h.setAuth }), { getState: () => ({ authed: h.gameAuthed }) }),
}));

import { useSocialAuth } from './useSocialAuth';
import { authCookies } from './authCookieCoordinator';
import { useLoginChallenge } from './loginChallenge';
import { LOGIN_AUTH } from '@shardkeep/shared';
import { WALLET_SIGNATURE_TIMEOUT_MS } from './walletSignature';

const roots: Root[] = [];

function Harness({ duplicateControls = false }: { duplicateControls?: boolean }): React.JSX.Element {
  const auth = useSocialAuth();
  return (
    <div>
      <button type="button" onClick={auth.signInWithSocial}>SIGN IN</button>
      {duplicateControls && (
        <button type="button" onClick={auth.signInWithSocial}>SIGN IN FROM SHEET</button>
      )}
      <output data-testid="signing">{String(auth.signingIn)}</output>
      <output data-testid="error">{auth.error ?? ''}</output>
    </div>
  );
}

async function render(root?: Root): Promise<Root> {
  const target = root ?? (() => {
    const host = document.createElement('div');
    document.body.append(host);
    const created = createRoot(host);
    roots.push(created);
    return created;
  })();
  await act(async () => {
    target.render(<StrictMode><Harness /></StrictMode>);
  });
  return target;
}

function signing(): string | null {
  return document.querySelector('[data-testid="signing"]')?.textContent ?? null;
}

async function clickSignIn(): Promise<void> {
  const button = document.querySelector('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('sign-in button missing');
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.ready = true;
  h.walletsReady = true;
  h.authenticated = false;
  h.gameAuthed = false;
  sessionStorage.clear();
  useLoginChallenge.getState().setWallet(null);
  h.user = null;
  h.options.mockReset().mockResolvedValue({ socialTokenLogin: false });
  h.getAccessToken.mockReset().mockResolvedValue('access-token');
  h.getIdentityToken.mockReset().mockResolvedValue('identity-token');
  h.wallets = [];
  h.callbacks = null;
  h.callbackHistory = [];
  h.login.mockReset();
  h.createWallet.mockReset();
  h.createWallet.mockResolvedValue({ wallet: { address: 'embedded-wallet' } });
  h.get.mockReset();
  h.postRaw.mockReset();
  h.setAuth.mockReset();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function wallet(
  address: string,
  isPrivyWallet: boolean,
  signMessage: ReturnType<typeof vi.fn>,
): EmbeddedWallet {
  return { address, standardWallet: { isPrivyWallet }, signMessage };
}

describe('useSocialAuth Privy lifecycle', () => {
  it('waits for Privy readiness instead of stranding an early title-screen click', async () => {
    h.ready = false;
    const root = await render();

    await clickSignIn();
    expect(signing()).toBe('true');
    expect(h.login).not.toHaveBeenCalled();

    h.ready = true;
    await render(root);
    expect(h.login).toHaveBeenCalledOnce();
    expect(signing()).toBe('true');
  });

  it('continues an early click when Privy finishes by restoring an existing session', async () => {
    const signMessage = vi.fn().mockResolvedValue({ signature: new Uint8Array([1, 2, 3]) });
    h.ready = false;
    h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
    h.postRaw.mockResolvedValue({ wallet: 'embedded-wallet', entryPaid: true });
    const root = await render();

    await clickSignIn();
    expect(signing()).toBe('true');
    expect(h.login).not.toHaveBeenCalled();

    h.ready = true;
    h.authenticated = true;
    h.wallets = [wallet('embedded-wallet', true, signMessage)];
    await render(root);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.login).not.toHaveBeenCalled();
    expect(h.createWallet).not.toHaveBeenCalled();
    expect(h.get).toHaveBeenCalledOnce();
    expect(signMessage).toHaveBeenCalledOnce();
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.setAuth).toHaveBeenCalledWith('embedded-wallet', true);
    expect(signing()).toBe('false');
  });

  it('resets after the unauthenticated login modal opens and closes, allowing retry', async () => {
    await render();
    expect(signing()).toBe('false');

    await clickSignIn();
    expect(h.login).toHaveBeenCalledOnce();
    expect(signing()).toBe('true');

    await act(async () => {
      h.callbacks?.onError?.('exited_auth_flow');
      await Promise.resolve();
    });
    expect(signing()).toBe('false');
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe('');

    await clickSignIn();
    expect(h.login).toHaveBeenCalledTimes(2);
    expect(signing()).toBe('true');
  });

  it('creates the missing signer for an authenticated legacy session, then completes SIWS', async () => {
    const signMessage = vi.fn().mockResolvedValue({ signature: new Uint8Array([1, 2, 3]) });
    h.authenticated = true;
    h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
    h.postRaw.mockResolvedValue({ wallet: 'embedded-wallet', entryPaid: false });
    const root = await render();

    await clickSignIn();
    expect(h.login).not.toHaveBeenCalled();
    expect(h.createWallet).toHaveBeenCalledOnce();
    expect(signing()).toBe('true');

    h.wallets = [wallet('embedded-wallet', true, signMessage)];
    await render(root);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.get).toHaveBeenCalledOnce();
    expect(signMessage).toHaveBeenCalledOnce();
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.setAuth).toHaveBeenCalledWith('embedded-wallet', false);
    expect(signing()).toBe('false');
  });

  it('waits for the Solana wallet inventory before deciding a signer is missing', async () => {
    const signMessage = vi.fn().mockResolvedValue({ signature: new Uint8Array([1, 2, 3]) });
    h.authenticated = true;
    h.walletsReady = false;
    h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
    h.postRaw.mockResolvedValue({ wallet: 'existing-embedded-wallet', entryPaid: true });
    const root = await render();

    await clickSignIn();
    expect(h.login).not.toHaveBeenCalled();
    expect(h.createWallet).not.toHaveBeenCalled();
    expect(signing()).toBe('true');

    h.walletsReady = true;
    h.wallets = [wallet('existing-embedded-wallet', true, signMessage)];
    await render(root);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.createWallet).not.toHaveBeenCalled();
    expect(h.get).toHaveBeenCalledOnce();
    expect(signMessage).toHaveBeenCalledOnce();
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.setAuth).toHaveBeenCalledWith('existing-embedded-wallet', true);
    expect(signing()).toBe('false');
  });

  it('continues a successful login into embedded-wallet SIWS exactly once', async () => {
    const signMessage = vi.fn().mockResolvedValue({ signature: new Uint8Array([1, 2, 3]) });
    const externalSignMessage = vi.fn();
    let releaseChallenge!: (value: { nonce: string; message: string }) => void;
    h.get.mockReturnValue(new Promise((resolve) => { releaseChallenge = resolve; }));
    h.postRaw.mockResolvedValue({ wallet: 'embedded-wallet', entryPaid: false });
    const root = await render();

    await clickSignIn();
    // The click-owned onComplete callback bridges Privy's successful provider
    // flow into SIWS; no second player click is allowed or required.
    expect(signing()).toBe('true');
    await act(async () => {
      h.callbacks?.onComplete?.();
      await Promise.resolve();
    });

    h.authenticated = true;
    // A linked/connected extension can appear first. It is never the identity
    // for this social-login flow, and an external-only intermediate render must
    // wait for Privy's guaranteed embedded signer instead of starting SIWS.
    h.wallets = [wallet('external-wallet', false, externalSignMessage)];
    await render(root);
    expect(h.get).not.toHaveBeenCalled();
    expect(h.createWallet).not.toHaveBeenCalled();
    expect(signing()).toBe('true');

    h.wallets = [
      wallet('external-wallet', false, externalSignMessage),
      wallet('embedded-wallet', true, signMessage),
    ];
    await render(root);
    expect(h.get).toHaveBeenCalledOnce();

    // A provider rerender can replace the wallet object while SIWS is in flight;
    // this must neither cancel the first attempt nor start a second one.
    h.wallets = [
      wallet('external-wallet', false, externalSignMessage),
      wallet('embedded-wallet', true, signMessage),
    ];
    await render(root);
    expect(h.get).toHaveBeenCalledOnce();

    await act(async () => {
      releaseChallenge({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(signMessage).toHaveBeenCalledOnce();
    expect(externalSignMessage).not.toHaveBeenCalled();
    expect(signMessage).toHaveBeenCalledWith({
      message: new TextEncoder().encode('Sign in to SHARDKEEP'),
    });
    expect(h.postRaw).toHaveBeenCalledOnce();
    // D-103: the social path labels the session exactly like useAuth.ts.
    expect(h.postRaw).toHaveBeenCalledWith('/auth/verify', {
      wallet: 'embedded-wallet',
      nonce: 'auth-nonce',
      signature: 'Ldp',
      client: 'browser',
      deviceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(h.setAuth).toHaveBeenCalledOnce();
    expect(h.setAuth).toHaveBeenCalledWith('embedded-wallet', false);
    expect(signing()).toBe('false');
  });

  it('lets the title and sheet views start only one shared attempt', async () => {
    const signMessage = vi.fn().mockResolvedValue({ signature: new Uint8Array([1, 2, 3]) });
    h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
    h.postRaw.mockResolvedValue({ wallet: 'embedded-wallet', entryPaid: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<StrictMode><Harness duplicateControls /></StrictMode>);
    });

    const controls = document.querySelectorAll('button');
    expect(controls).toHaveLength(2);
    await act(async () => {
      controls[0]!.click();
      controls[1]!.click();
      await Promise.resolve();
    });
    expect(h.login).toHaveBeenCalledOnce();
    await act(async () => {
      for (const callbacks of h.callbackHistory) callbacks.onComplete?.();
      await Promise.resolve();
    });

    h.authenticated = true;
    h.wallets = [wallet('embedded-wallet', true, signMessage)];
    await act(async () => {
      root.render(<StrictMode><Harness duplicateControls /></StrictMode>);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.get).toHaveBeenCalledOnce();
    expect(signMessage).toHaveBeenCalledOnce();
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.setAuth).toHaveBeenCalledOnce();
  });

  it('leaves SIGNING IN and permits retry when an embedded signature never settles', async () => {
    vi.useFakeTimers();
    const signMessage = vi.fn().mockReturnValue(new Promise(() => undefined));
    h.authenticated = true;
    h.wallets = [wallet('embedded-wallet', true, signMessage)];
    h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
    await render();

    await clickSignIn();
    await act(async () => { await Promise.resolve(); });
    expect(signMessage).toHaveBeenCalledOnce();
    expect(signing()).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_SIGNATURE_TIMEOUT_MS);
    });
    expect(signing()).toBe('false');
    expect(document.querySelector('[data-testid="error"]')?.textContent)
      .toMatch(/signature timed out/i);
    expect(h.postRaw).not.toHaveBeenCalled();
  });
});


describe('verified social-token login', () => {
  it('does not open a provider modal when sign-in changes while options are loading', async () => {
    let release!: (options: { socialTokenLogin: boolean }) => void;
    h.options.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    await render(); await clickSignIn();
    authCookies.begin(); // Another login/logout superseded this request.
    await act(async () => { release({ socialTokenLogin: true }); });
    expect(h.login).not.toHaveBeenCalled();
    expect(h.postRaw).not.toHaveBeenCalled();
    expect(signing()).toBe('false');
  });

  it('signs in without waiting for or invoking the MFA-locked embedded signer', async () => {
    h.options.mockResolvedValue({ socialTokenLogin: true });
    h.authenticated = true;
    h.walletsReady = false;
    h.user = { id: 'did:privy:alice', linkedAccounts: [{ type: 'wallet', chainType: 'solana', connectorType: 'embedded' }] };
    const sign = vi.fn();
    h.wallets = [wallet('embedded-wallet', true, sign)];
    h.postRaw.mockResolvedValue({ wallet: 'embedded-wallet', entryPaid: true });
    await render(); await clickSignIn();
    expect(h.get).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(h.createWallet).not.toHaveBeenCalled();
    expect(h.postRaw).toHaveBeenCalledWith('/auth/social', expect.objectContaining({ accessToken: 'access-token', identityToken: 'identity-token' }));
    expect(h.setAuth).toHaveBeenCalledWith('embedded-wallet', true);
  });

  it('provisions a missing embedded wallet but never falls back to signing after token rejection', async () => {
    h.options.mockResolvedValue({ socialTokenLogin: true });
    h.authenticated = true;
    h.user = { id: 'did:privy:new', linkedAccounts: [] };
    h.postRaw.mockRejectedValue(new Error('social identity invalid'));
    await render(); await clickSignIn();
    expect(h.createWallet).toHaveBeenCalledOnce();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.setAuth).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe('social identity invalid');
  });

  it('ignores token retrieval from an account switched during sign-in', async () => {
    h.options.mockResolvedValue({ socialTokenLogin: true });
    h.authenticated = true;
    h.user = { id: 'did:privy:old', linkedAccounts: [{ type: 'wallet', chainType: 'solana', connectorType: 'embedded' }] };
    let release!: (token: string) => void;
    h.getAccessToken.mockReturnValue(new Promise<string>((resolve) => { release = resolve; }));
    const root = await render(); await clickSignIn();
    h.user = { ...h.user, id: 'did:privy:new' };
    await render(root);
    await act(async () => { release('old-token'); });
    expect(h.postRaw).not.toHaveBeenCalled();
    expect(h.setAuth).not.toHaveBeenCalled();
  });
});


describe('explicit OAuth redirect continuation', () => {
  const providerReturned = (): void => {
    h.authenticated = true;
    h.user = { id: 'did:privy:returned', linkedAccounts: [{
      type: 'wallet', chainType: 'solana', connectorType: 'embedded',
    }] };
    h.postRaw.mockResolvedValue({ wallet: 'embedded-wallet', entryPaid: true });
  };
  const leaveDocument = async (root: Root): Promise<void> => {
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    document.body.replaceChildren();
  };
  it('continues once after the requested OAuth flow remounts, without a second click or signature', async () => {
    h.options.mockResolvedValue({ socialTokenLogin: true });
    const beforeRedirect = await render();
    await clickSignIn();
    expect(h.login).toHaveBeenCalledOnce();
    await leaveDocument(beforeRedirect);
    providerReturned();
    h.walletsReady = false; // MFA-locked signer restoration is not a login prerequisite.
    const returned = await render();
    await render(returned);
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.postRaw.mock.calls[0]?.[0]).toBe('/auth/social');
    expect(h.get).not.toHaveBeenCalled();
    expect(h.setAuth).toHaveBeenCalledWith('embedded-wallet', true);
  });

  it.each(['cancel', 'another-login', 'expired', 'game-session', 'limited-session'] as const)(
    'does not resume an OAuth intent after %s', async (reason) => {
      h.options.mockResolvedValue({ socialTokenLogin: true });
      const beforeRedirect = await render();
      await clickSignIn();
      if (reason === 'cancel') await act(async () => h.callbacks?.onError?.('exited_auth_flow'));
      if (reason === 'another-login') authCookies.begin(); // Includes explicit logout and identity invalidation.
      if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LOGIN_AUTH.pendingTtlSec * 1_000 + 1);
      if (reason === 'game-session') h.gameAuthed = true;
      if (reason === 'limited-session') useLoginChallenge.getState().setWallet('protected-wallet');
      await leaveDocument(beforeRedirect);
      providerReturned();
      await render();
      expect(h.postRaw).not.toHaveBeenCalled();
      expect(h.setAuth).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    },
  );

  it('does not sign in merely because Privy restores an authenticated account', async () => {
    h.options.mockResolvedValue({ socialTokenLogin: true });
    providerReturned();
    await render();
    expect(h.options).not.toHaveBeenCalled();
    expect(h.postRaw).not.toHaveBeenCalled();
  });
});
