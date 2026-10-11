/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  wallet: 'ExternalWallet111111111111111111111111111' as string | null,
  signMessage: vi.fn(),
  get: vi.fn(),
  postRaw: vi.fn(),
  setAuth: vi.fn(),
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: h.wallet ? { toBase58: () => h.wallet! } : null,
    signMessage: h.signMessage,
  }),
}));

vi.mock('../lib/api', () => ({
  api: { get: h.get, postRaw: h.postRaw, postAuth: (path: string, body: unknown) => h.postRaw(path, body), waitForAuth: () => Promise.resolve() },
}));

vi.mock('../state/store', () => ({
  useApp: (select: (state: { setAuth: typeof h.setAuth }) => unknown) =>
    select({ setAuth: h.setAuth }),
}));

import { cancelNativeSignIn, useAuth } from './useAuth';
import { WALLET_SIGNATURE_TIMEOUT_MS } from './walletSignature';

let root: Root | null = null;

function Harness(): React.JSX.Element {
  const auth = useAuth();
  return (
    <div>
      <button type="button" onClick={() => void auth.signIn()}>SIGN IN</button>
      <output data-testid="signing">{String(auth.signingIn)}</output>
      <output data-testid="phase">{auth.phase}</output>
      <output data-testid="error">{auth.error ?? ''}</output>
    </div>
  );
}

beforeEach(async () => {
  vi.useRealTimers();
  h.wallet = 'ExternalWallet111111111111111111111111111';
  h.signMessage.mockReset();
  h.get.mockReset();
  h.postRaw.mockReset();
  h.setAuth.mockReset();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => { cancelNativeSignIn('logout'); root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

describe('useAuth wallet signature lifecycle', () => {
  it('completes challenge, signature and verification for a fresh external wallet', async () => {
    h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
    h.signMessage.mockResolvedValue(new Uint8Array([1, 2, 3]));
    h.postRaw.mockResolvedValue({
      wallet: 'ExternalWallet111111111111111111111111111', entryPaid: false,
    });

    const button = document.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('sign-in button missing');
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(h.signMessage).toHaveBeenCalledOnce();
    expect(h.postRaw).toHaveBeenCalledOnce();
    // D-103: the session is labelled by client so the public playtest
    // statistics can split Solana Mobile from browser sign-ins. A plain
    // happy-dom tab carries neither the shell UA nor the start-URL marker.
    expect(h.postRaw).toHaveBeenCalledWith('/auth/verify', {
      wallet: 'ExternalWallet111111111111111111111111111',
      nonce: 'auth-nonce',
      signature: 'Ldp',
      client: 'browser',
      // The persisted analytics device id rides along so the server can join
      // this device's pre-sign-in funnel to the wallet ($identify).
      deviceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(h.setAuth).toHaveBeenCalledWith(
      'ExternalWallet111111111111111111111111111', false,
    );
    expect(document.querySelector('[data-testid="signing"]')?.textContent).toBe('false');
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe('');
  });

  it('labels the session solana-mobile when the installed shell marked this device', async () => {
    // WHY: the statistics cohort "Solana Mobile" is first-sign-in-from-the-shell
    // OR Seeker-verified. The shell's start URL carries ?client=solana-mobile
    // and the asset-pack gate persists the marker, so a later sign-in without
    // the query string must still be attributed to the shell — read at call
    // time, not at module load.
    localStorage.setItem('pkw:solana-mobile-client', '1');
    try {
      h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
      h.signMessage.mockResolvedValue(new Uint8Array([1, 2, 3]));
      h.postRaw.mockResolvedValue({ wallet: 'ExternalWallet111111111111111111111111111', entryPaid: true });
      const button = document.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) throw new Error('sign-in button missing');
      await act(async () => {
        button.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(h.postRaw).toHaveBeenCalledWith('/auth/verify', expect.objectContaining({ client: 'solana-mobile' }));
    } finally {
      localStorage.removeItem('pkw:solana-mobile-client');
    }
  });

  it('keeps one existing approval pending after the soft wait and accepts its late success', async () => {
    vi.useFakeTimers();
    h.get.mockResolvedValue({ nonce: 'auth-nonce', message: 'Sign in to SHARDKEEP' });
    let approve!: (value: Uint8Array) => void;
    h.signMessage.mockReturnValue(new Promise((resolve) => { approve = resolve; }));
    h.postRaw.mockResolvedValue({ wallet: h.wallet, entryPaid: false });

    const button = document.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) throw new Error('sign-in button missing');
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(h.signMessage).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-testid="signing"]')?.textContent).toBe('true');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_SIGNATURE_TIMEOUT_MS);
    });
    expect(document.querySelector('[data-testid="signing"]')?.textContent).toBe('true');
    expect(document.querySelector('[data-testid="phase"]')?.textContent).toBe('waiting');
    await act(async () => { button.click(); });
    expect(h.signMessage).toHaveBeenCalledOnce();
    expect(h.postRaw).not.toHaveBeenCalled();
    expect(h.setAuth).not.toHaveBeenCalled();
    await act(async () => { approve(new Uint8Array([1, 2, 3])); });
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.setAuth).toHaveBeenCalledOnce();
  });
});


describe('native approval ownership across React and wallet changes', () => {
  it('coalesces duplicate taps and survives title remount without another signature', async () => {
    let approve!: (value: Uint8Array) => void;
    h.get.mockResolvedValue({ nonce: 'n', message: 'message' });
    h.signMessage.mockReturnValue(new Promise((resolve) => { approve = resolve; }));
    h.postRaw.mockResolvedValue({ wallet: h.wallet, entryPaid: false });
    await act(async () => { document.querySelector('button')!.click(); document.querySelector('button')!.click(); });
    await act(async () => root!.render(<Harness key="remounted" />));
    await act(async () => document.querySelector('button')!.click());
    expect(h.get).toHaveBeenCalledOnce();
    expect(h.signMessage).toHaveBeenCalledOnce();
    await act(async () => approve(new Uint8Array([1])));
    expect(h.postRaw).toHaveBeenCalledOnce();
    expect(h.setAuth).toHaveBeenCalledOnce();
  });
  it.each(['cancel', 'switch', 'disconnect', 'expiry'] as const)('does not authenticate an obsolete approval after %s', async (reason) => {
    let approve!: (value: Uint8Array) => void;
    h.get.mockResolvedValue({ nonce: 'n', message: 'message', expiresAt: reason === 'expiry' ? new Date(0).toISOString() : '2099-01-01T00:00:00Z' });
    h.signMessage.mockReturnValue(new Promise((resolve) => { approve = resolve; }));
    await act(async () => document.querySelector('button')!.click());
    if (reason === 'cancel') await act(async () => cancelNativeSignIn());
    if (reason === 'switch' || reason === 'disconnect') {
      h.wallet = reason === 'switch' ? 'AnotherWallet' : null;
      await act(async () => root!.render(<Harness />));
    }
    await act(async () => approve(new Uint8Array([1])));
    expect(h.postRaw).not.toHaveBeenCalled();
    expect(h.setAuth).not.toHaveBeenCalled();
  });
});
