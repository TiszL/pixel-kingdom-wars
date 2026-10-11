/**
 * @vitest-environment happy-dom
 *
 * Behaviour-level coverage for the real wallet-adapter provider seam. The
 * reducer tests pin the small state machine; these mount WalletProvider itself
 * so a second component-owned connect(), a missed provider error, or unstable
 * late-registration reconciliation fails as a player-visible regression.
 */
import {
  BaseWalletAdapter,
  WalletConnectionError,
  WalletReadyState,
  type Adapter,
  type WalletError,
  type WalletName,
} from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus, walletErrorNotice } from '../lib/events';
import { ConnectSheet } from './ConnectSheet';

const TEST_KEY = new PublicKey('11111111111111111111111111111111');
const RPC = 'https://api.devnet.solana.com';

class ControlledAdapter extends BaseWalletAdapter {
  readonly name: WalletName;
  readonly url = 'https://example.test/wallet';
  readonly icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
  readonly readyState = WalletReadyState.Installed;
  readonly supportedTransactionVersions = null;
  public publicKey: PublicKey | null = null;
  public connecting = false;
  public connectCalls = 0;

  private resolveAttempt: (() => void) | null = null;
  private rejectAttempt: ((error: Error) => void) | null = null;

  constructor(name: string) {
    super();
    this.name = name as WalletName;
  }

  connect(): Promise<void> {
    if (this.connected || this.connecting) return Promise.resolve();
    this.connectCalls++;
    this.connecting = true;
    return new Promise<void>((resolve, reject) => {
      this.resolveAttempt = resolve;
      this.rejectAttempt = reject;
    });
  }

  async disconnect(): Promise<void> {
    this.publicKey = null;
    this.connecting = false;
    this.emit('disconnect');
  }

  async sendTransaction(): Promise<never> {
    throw new Error('not used by connect-sheet tests');
  }

  rejectConnect(message = 'User rejected the request.'): void {
    if (!this.rejectAttempt) throw new Error(`${this.name} has no pending connect()`);
    const reject = this.rejectAttempt;
    this.clearAttempt();
    const error = new WalletConnectionError(message);
    // Real adapters emit the WalletError and reject the same attempt. The
    // provider forwards the event to App.onWalletError, then owns the rejection.
    this.emit('error', error);
    reject(error);
  }

  resolveConnect(): void {
    if (!this.resolveAttempt) throw new Error(`${this.name} has no pending connect()`);
    const resolve = this.resolveAttempt;
    this.clearAttempt();
    this.publicKey = TEST_KEY;
    this.emit('connect', TEST_KEY);
    resolve();
  }

  /** Settle a failed assertion without emitting UI events after unmount. */
  settleForCleanup(): void {
    const resolve = this.resolveAttempt;
    this.clearAttempt();
    resolve?.();
  }

  private clearAttempt(): void {
    this.connecting = false;
    this.resolveAttempt = null;
    this.rejectAttempt = null;
  }
}

function onProviderError(error: WalletError, adapter?: Adapter): void {
  bus.emit('wallet:error', walletErrorNotice(error, adapter?.name ?? null));
}

interface MountedSheet {
  close: ReturnType<typeof vi.fn>;
  rerender(adapters: Adapter[]): Promise<void>;
}

const roots: Root[] = [];
const adaptersForCleanup: ControlledAdapter[] = [];

function tree(adapters: Adapter[], close: () => void): React.JSX.Element {
  return (
    <StrictMode>
      <ConnectionProvider endpoint={RPC}>
        <WalletProvider wallets={adapters} autoConnect onError={onProviderError}>
          <ConnectSheet onClose={close} />
        </WalletProvider>
      </ConnectionProvider>
    </StrictMode>
  );
}

async function mountSheet(adapters: ControlledAdapter[]): Promise<MountedSheet> {
  adaptersForCleanup.push(...adapters);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const close = vi.fn();
  await act(async () => { root.render(tree(adapters, close)); });
  return {
    close,
    rerender: async (next) => {
      for (const adapter of next) {
        if (adapter instanceof ControlledAdapter && !adaptersForCleanup.includes(adapter)) {
          adaptersForCleanup.push(adapter);
        }
      }
      await act(async () => { root.render(tree(next, close)); });
    },
  };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const adapter of adaptersForCleanup.splice(0)) adapter.settleForCleanup();
    await Promise.resolve();
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  localStorage.clear();
});

describe('ConnectSheet + WalletProvider desktop integration', () => {
  it('serializes a remembered MetaMask auto-connect before a new Phantom selection', async () => {
    localStorage.setItem('walletName', JSON.stringify('MetaMask'));
    const metaMask = new ControlledAdapter('MetaMask');
    const phantom = new ControlledAdapter('Phantom');
    await mountSheet([metaMask, phantom]);

    // The provider owns the remembered silent attempt. With no sheet `pending`
    // row yet, its `connecting` state must still lock every adapter choice.
    expect(metaMask.connectCalls).toBe(1);
    expect(button('METAMASK').disabled).toBe(true);
    expect(button('PHANTOM').disabled).toBe(true);
    await click(button('PHANTOM'));
    expect(phantom.connectCalls).toBe(0);

    await act(async () => {
      metaMask.rejectConnect('Remembered authorization expired.');
      await Promise.resolve();
    });

    expect(button('METAMASK').disabled).toBe(false);
    expect(button('PHANTOM').disabled).toBe(false);
    // Background auto-connect errors have no player-chosen row to blame.
    expect(document.body.querySelector('[role="alert"]')).toBeNull();

    await click(button('PHANTOM'));
    expect(metaMask.connectCalls).toBe(1);
    expect(phantom.connectCalls).toBe(1);
    await act(async () => {
      phantom.resolveConnect();
      await Promise.resolve();
    });
  });

  it('one click makes one provider-owned attempt, locks every row, and retries after inline rejection', async () => {
    const phantom = new ControlledAdapter('Phantom');
    const solflare = new ControlledAdapter('Solflare');
    const view = await mountSheet([phantom, solflare]);
    const phantomRow = button('PHANTOM');
    const solflareRow = button('SOLFLARE');

    await click(phantomRow);

    expect(phantom.connectCalls).toBe(1);
    expect(solflare.connectCalls).toBe(0);
    expect(phantomRow.textContent).toBe('CONNECTING…');
    expect(phantomRow.disabled).toBe(true);
    expect(solflareRow.disabled).toBe(true);

    // A disabled sibling cannot start a competing adapter while Phantom's
    // provider-owned promise is still open, and rerenders cannot duplicate it.
    await click(solflareRow);
    await view.rerender([phantom, solflare]);
    expect(phantom.connectCalls).toBe(1);
    expect(solflare.connectCalls).toBe(0);

    await act(async () => {
      phantom.rejectConnect();
      await Promise.resolve();
    });

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('CONNECTION CANCELLED');
    expect(button('PHANTOM').disabled).toBe(false);
    expect(button('SOLFLARE').disabled).toBe(false);

    await click(button('PHANTOM'));
    expect(phantom.connectCalls).toBe(2);
    expect(solflare.connectCalls).toBe(0);

    await act(async () => {
      phantom.resolveConnect();
      await Promise.resolve();
    });
    expect(view.close).toHaveBeenCalled();
  });

  it('late preferred-wallet registration preserves the focused row and its adapter identity', async () => {
    const metaMask = new ControlledAdapter('MetaMask');
    const phantom = new ControlledAdapter('Phantom');
    const view = await mountSheet([metaMask]);
    const originalMetaMaskRow = button('METAMASK');
    originalMetaMaskRow.focus();
    expect(document.activeElement).toBe(originalMetaMaskRow);

    // Wallet Standard registration changes the provider's adapter list after
    // mount. Desktop preference inserts Phantom ahead of the existing row.
    await view.rerender([metaMask, phantom]);

    expect(button('METAMASK')).toBe(originalMetaMaskRow);
    expect(document.activeElement).toBe(originalMetaMaskRow);
    expect([...document.body.querySelectorAll('button')].map((item) => item.textContent?.trim()))
      .toEqual(expect.arrayContaining(['PHANTOM', 'METAMASK', 'CLOSE']));

    await click(originalMetaMaskRow);
    expect(metaMask.connectCalls).toBe(1);
    expect(phantom.connectCalls).toBe(0);

    await act(async () => {
      metaMask.resolveConnect();
      await Promise.resolve();
    });
  });
});
