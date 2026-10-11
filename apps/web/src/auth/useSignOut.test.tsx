/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  platform: 'android' as 'android' | 'ios' | 'desktop',
  walletName: 'Phantom',
  disconnect: vi.fn(),
  logout: vi.fn(),
  post: vi.fn(),
  setAuth: vi.fn(),
  setScreen: vi.fn(),
  suspendPush: vi.fn(),
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    disconnect: h.disconnect,
    wallet: h.walletName ? { adapter: { name: h.walletName } } : null,
  }),
}));

vi.mock('@privy-io/react-auth', () => ({ usePrivy: () => ({ logout: h.logout }) }));
vi.mock('../lib/platform', () => ({ caps: { get platform() { return h.platform; } } }));
vi.mock('../lib/api', () => ({ api: { post: h.post, logout: async (before?: () => Promise<unknown>, after?: () => Promise<unknown>) => { await before?.(); await h.post('/auth/logout'); await after?.(); } } }));
vi.mock('../lib/pushSubscription', () => ({ suspendPushSession: h.suspendPush }));
vi.mock('../state/store', () => ({
  useApp: Object.assign(vi.fn(), {
    getState: () => ({ setAuth: h.setAuth, setScreen: h.setScreen }),
  }),
}));

import { useSignOut } from './useSignOut';

let root: Root | null = null;

function Harness(): React.JSX.Element {
  const signOut = useSignOut();
  return <button type="button" onClick={() => void signOut()}>SIGN OUT</button>;
}

async function renderAndSignOut(): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
  const button = document.querySelector('button');
  if (!(button instanceof HTMLButtonElement)) throw new Error('sign-out button missing');
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.platform = 'android';
  h.walletName = 'Phantom';
  h.disconnect.mockReset().mockResolvedValue(undefined);
  h.logout.mockReset().mockResolvedValue(undefined);
  h.post.mockReset().mockResolvedValue(undefined);
  h.setAuth.mockReset();
  h.setScreen.mockReset();
  h.suspendPush.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, 'phantom', {
    configurable: true,
    value: { solana: {
      isPhantom: true,
      isConnected: true,
      publicKey: {},
      connect: vi.fn(),
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
      on: vi.fn(),
    } },
  });
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'phantom');
});

describe('useSignOut wallet-provider lifecycle', () => {
  it('revokes the cookie only after the notification restart fence is durable', async () => {
    let releaseFence!: () => void;
    h.suspendPush.mockReturnValueOnce(new Promise<void>((resolve) => { releaseFence = resolve; }));

    await renderAndSignOut();
    expect(h.suspendPush).toHaveBeenCalledOnce();
    expect(h.post).not.toHaveBeenCalled();

    releaseFence();
    await vi.waitFor(() => expect(h.post).toHaveBeenCalledWith('/auth/logout'));
  });

  it('revokes and clears the game but preserves mobile injected Phantom', async () => {
    await renderAndSignOut();
    expect(h.post).toHaveBeenCalledWith('/auth/logout');
    expect(h.suspendPush).toHaveBeenCalledOnce();
    expect(h.suspendPush.mock.invocationCallOrder[0]!).toBeLessThan(h.post.mock.invocationCallOrder[0]!);
    expect(h.setAuth).toHaveBeenCalledWith(null);
    expect(h.setScreen).toHaveBeenCalledWith('title');
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it('locally disconnects the unique direct adapter so React is not left connected', async () => {
    h.walletName = 'Phantom Mobile';
    await renderAndSignOut();
    expect(h.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps the existing disconnect behavior for desktop Phantom and other wallets', async () => {
    h.platform = 'desktop';
    await renderAndSignOut();
    expect(h.disconnect).toHaveBeenCalledOnce();

    await act(async () => { root?.unmount(); });
    root = null;
    document.body.replaceChildren();
    h.disconnect.mockClear();
    h.platform = 'android';
    h.walletName = 'Solflare';
    await renderAndSignOut();
    expect(h.disconnect).toHaveBeenCalledOnce();
  });

  it('fails closed to the normal disconnect when Phantom legacy injection is absent', async () => {
    Reflect.deleteProperty(window, 'phantom');
    await renderAndSignOut();
    expect(h.disconnect).toHaveBeenCalledOnce();
  });
});
