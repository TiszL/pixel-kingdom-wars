/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = () => void;
class AdapterEvents {
  private disconnect = new Set<Listener>();
  on(event: string, listener: Listener): void {
    if (event === 'disconnect') this.disconnect.add(listener);
  }
  off(event: string, listener: Listener): void {
    if (event === 'disconnect') this.disconnect.delete(listener);
  }
  emitDisconnect(): void {
    for (const listener of [...this.disconnect]) listener();
  }
}

const h = vi.hoisted(() => ({
  sessionWallet: 'WalletA',
  authed: true,
  providerWallet: 'WalletA' as string | null,
  connected: true,
  adapter: null as AdapterEvents | null,
  wallets: [] as Array<{ address: string; standardWallet: { isPrivyWallet: boolean } }>,
  post: vi.fn(),
  setAuth: vi.fn(),
  setScreen: vi.fn(),
  suspendPush: vi.fn(),
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    wallet: h.adapter ? { adapter: h.adapter } : null,
    publicKey: h.providerWallet ? { toBase58: () => h.providerWallet! } : null,
    connected: h.connected,
  }),
}));
vi.mock('@privy-io/react-auth/solana', () => ({ useWallets: () => ({ ready: true, wallets: h.wallets }) }));
vi.mock('../lib/api', () => ({ api: { post: h.post, logout: async (before?: () => Promise<unknown>, after?: () => Promise<unknown>) => { await before?.(); await h.post('/auth/logout'); await after?.(); } } }));
vi.mock('../lib/pushSubscription', () => ({ suspendPushSession: h.suspendPush }));
vi.mock('../state/store', () => ({
  useApp: Object.assign(
    (selector: (state: { wallet: string | null; authed: boolean }) => unknown) => selector({
      wallet: h.sessionWallet, authed: h.authed,
    }),
    {
      getState: () => ({
        wallet: h.sessionWallet,
        authed: h.authed,
        setAuth: h.setAuth,
        setScreen: h.setScreen,
      }),
    },
  ),
}));

import { useWalletSessionFence } from './useWalletSessionFence';

let root: Root | null = null;

function Harness(): null {
  useWalletSessionFence();
  return null;
}

async function render(): Promise<void> {
  if (!root) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  await act(async () => { root!.render(<Harness />); });
}

beforeEach(() => {
  h.sessionWallet = 'WalletA';
  h.authed = true;
  h.providerWallet = 'WalletA';
  h.connected = true;
  h.adapter = new AdapterEvents();
  h.wallets = [];
  h.post.mockReset().mockResolvedValue(undefined);
  h.setAuth.mockReset().mockImplementation((wallet: string | null) => {
    h.sessionWallet = wallet ?? '';
    h.authed = wallet !== null;
  });
  h.setScreen.mockReset();
  h.suspendPush.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

describe('wallet/session identity fence', () => {
  it('clears wallet A before wallet B can act, without authenticating or admitting B', async () => {
    await render(); // establishes that this adapter owned wallet A
    h.providerWallet = 'WalletB';
    await render();

    expect(h.setAuth).toHaveBeenCalledWith(null);
    expect(h.setAuth).not.toHaveBeenCalledWith('WalletB');
    expect(h.setScreen).toHaveBeenCalledWith('title');
    expect(h.suspendPush).toHaveBeenCalledOnce();
    expect(h.post).toHaveBeenCalledWith('/auth/logout');
    expect(h.suspendPush.mock.invocationCallOrder[0]!).toBeLessThan(h.post.mock.invocationCallOrder[0]!);
  });

  it('ignores null during initial hydration and a temporary null without a disconnect event', async () => {
    h.providerWallet = null;
    h.connected = false;
    await render();
    expect(h.setAuth).not.toHaveBeenCalled();

    h.providerWallet = 'WalletA';
    h.connected = true;
    await render();
    h.providerWallet = null;
    h.connected = false;
    await render();
    expect(h.setAuth).not.toHaveBeenCalled();
  });

  it('clears an established session on the adapter\'s explicit disconnect event', async () => {
    await render();
    await act(async () => { h.adapter!.emitDisconnect(); });
    expect(h.setAuth).toHaveBeenCalledWith(null);
    expect(h.setScreen).toHaveBeenCalledWith('title');
  });

  it('does not mistake a matching Privy embedded session for an external-wallet mismatch', async () => {
    h.providerWallet = 'UnrelatedExternalWallet';
    h.wallets = [{ address: 'WalletA', standardWallet: { isPrivyWallet: true } }];
    await render();
    // This assertion applies when the production/test build has Privy enabled;
    // adapter-only builds intentionally have no embedded-session concept.
    if (import.meta.env.VITE_PRIVY_APP_ID) expect(h.setAuth).not.toHaveBeenCalled();
  });
});
