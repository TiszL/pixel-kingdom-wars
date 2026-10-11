/**
 * @vitest-environment happy-dom
 *
 * Phantom mobile publishes both its injected provider and a Wallet Standard
 * wallet. These tests deliberately mount both and fail if the Standard twin is
 * displayed, selected, auto-connected, or used to sign after confirmation.
 */
import {
  BaseWalletAdapter,
  WalletConnectionError,
  WalletReadyState,
  type Adapter,
  type WalletError,
  type WalletName,
} from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { Keypair, PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InjectedPhantomProvider } from '../auth/injectedPhantom';
import {
  MOBILE_PHANTOM_WALLET_NAME,
  MobilePhantomAdapter,
  migrateMobilePhantomWalletStorage,
  useDetectedMobilePhantomAdapters,
} from '../auth/mobilePhantomAdapter';
import { bus, walletErrorNotice } from '../lib/events';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    caps: {
      ...actual.caps,
      platform: 'android', isAndroid: true, isIOS: false,
      canDeepLink: true, isSecureContext: true,
    },
    playUrl: () => 'https://play.pixelkingdomwars.com/',
    playOrigin: () => 'https://play.pixelkingdomwars.com',
  };
});

import { ConnectSheet } from './ConnectSheet';

const RPC = 'https://api.devnet.solana.com';

type AccountListener = (publicKey: unknown | null) => void;
type DisconnectListener = () => void;

class DirectProvider implements InjectedPhantomProvider {
  readonly isPhantom = true;
  isConnected = false;
  publicKey: PublicKey | null = null;
  readonly key = Keypair.generate().publicKey;
  connectFailure: Error | null = null;
  failNextConnect: Error | null = null;
  userGestureActive = false;
  connectStartedInUserGesture = false;
  adapterConnectStartedInUserGesture = false;
  readonly connectOrder: string[] = [];
  readonly connectCalls: Array<{ onlyIfTrusted?: boolean } | undefined> = [];
  readonly signMessageCalls: Array<{ message: Uint8Array; display: 'utf8' | 'hex' | undefined }> = [];
  readonly accountListeners = new Set<AccountListener>();
  readonly disconnectListeners = new Set<DisconnectListener>();

  async connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }> {
    this.connectOrder.push('provider.connect');
    this.connectStartedInUserGesture ||= this.userGestureActive;
    this.connectCalls.push(options);
    if (this.failNextConnect) {
      const failure = this.failNextConnect;
      this.failNextConnect = null;
      throw failure;
    }
    if (this.connectFailure) throw this.connectFailure;
    this.publicKey = this.key;
    this.isConnected = true;
    return { publicKey: this.key };
  }

  async signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array; publicKey: PublicKey }> {
    this.signMessageCalls.push({ message, display });
    return { signature: new Uint8Array([7, 8]), publicKey: this.key };
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    return transaction;
  }

  on(event: 'accountChanged' | 'disconnect', listener: AccountListener | DisconnectListener): void {
    if (event === 'accountChanged') this.accountListeners.add(listener as AccountListener);
    else this.disconnectListeners.add(listener as DisconnectListener);
  }

  off(event: 'accountChanged' | 'disconnect', listener: AccountListener | DisconnectListener): void {
    if (event === 'accountChanged') this.accountListeners.delete(listener as AccountListener);
    else this.disconnectListeners.delete(listener as DisconnectListener);
  }
}

class ThrowingStandardPhantom extends BaseWalletAdapter {
  readonly name = 'Phantom' as WalletName;
  readonly url = 'https://phantom.com';
  readonly icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
  readonly readyState = WalletReadyState.Installed;
  readonly supportedTransactionVersions = null;
  public publicKey: PublicKey | null = null;
  public connecting = false;
  public connectCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls++;
    const error = new WalletConnectionError('Unexpected error');
    this.emit('error', error);
    throw error;
  }

  async disconnect(): Promise<void> {
    this.publicKey = null;
    this.emit('disconnect');
  }

  async sendTransaction(): Promise<never> { throw new Error('Standard Phantom must never sign'); }
}

function WalletProbe(): React.JSX.Element {
  const { connected, publicKey, signMessage } = useWallet();
  const [signature, setSignature] = useState('');
  return (
    <div>
      <output data-testid="wallet">{connected ? publicKey?.toBase58() : ''}</output>
      <output data-testid="signature">{signature}</output>
      <button type="button" disabled={!signMessage} onClick={() => {
        void signMessage?.(new Uint8Array([1, 2])).then((value) => setSignature([...value].join(',')));
      }}>SIGN PROBE</button>
    </div>
  );
}

function onProviderError(error: WalletError, adapter?: Adapter): void {
  bus.emit('wallet:error', walletErrorNotice(error, adapter?.name ?? null));
}

let root: Root | null = null;

async function mount(
  provider: DirectProvider,
  standard: ThrowingStandardPhantom,
  autoConnect = true,
): Promise<MobilePhantomAdapter> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const direct = new MobilePhantomAdapter(provider);
  const adapterConnect = direct.connect.bind(direct);
  vi.spyOn(direct, 'connect').mockImplementation(() => {
    provider.connectOrder.push('adapter.connect');
    provider.adapterConnectStartedInUserGesture ||= provider.userGestureActive;
    return adapterConnect();
  });
  await act(async () => {
    root!.render(
      <ConnectionProvider endpoint={RPC}>
        <WalletProvider wallets={[direct, standard]} autoConnect={autoConnect} onError={onProviderError}>
          <ConnectSheet onClose={() => undefined} />
          <WalletProbe />
        </WalletProvider>
      </ConnectionProvider>,
    );
  });
  return direct;
}

function LateInjectionHarness({ standard }: {
  standard: ThrowingStandardPhantom;
}): React.JSX.Element {
  const direct = useDetectedMobilePhantomAdapters('android');
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={[...direct, standard]} autoConnect onError={onProviderError}>
        <ConnectSheet onClose={() => undefined} />
        <WalletProbe />
      </WalletProvider>
    </ConnectionProvider>
  );
}

async function mountLateInjection(standard: ThrowingStandardPhantom): Promise<void> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<LateInjectionHarness standard={standard} />);
  });
}

function buttons(label: string): HTMLButtonElement[] {
  return [...document.body.querySelectorAll('button')]
    .filter((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement[];
}

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      assertion();
      return;
    } catch (error: unknown) {
      failure = error;
      await act(async () => { await Promise.resolve(); });
    }
  }
  throw failure;
}

beforeEach(() => {
  localStorage.clear();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  Reflect.deleteProperty(window, 'phantom');
  vi.useRealTimers();
});

describe('ConnectSheet Phantom mobile direct-provider integration', () => {
  it('renders one CONNECT PHANTOM and never calls the throwing Standard twin', async () => {
    const provider = new DirectProvider();
    const standard = new ThrowingStandardPhantom();
    const direct = await mount(provider, standard);
    expect(buttons('CONNECT PHANTOM')).toHaveLength(1);
    expect(buttons('CONNECT PHANTOM MOBILE')).toHaveLength(0);

    await act(async () => {
      provider.userGestureActive = true;
      buttons('CONNECT PHANTOM')[0]!.click();
      provider.userGestureActive = false;
    });
    await eventually(() => expect(document.querySelector('[data-testid="wallet"]')?.textContent)
      .toBe(provider.key.toBase58()));
    expect(provider.connectStartedInUserGesture).toBe(true);
    expect(provider.adapterConnectStartedInUserGesture).toBe(false);
    expect(provider.connectOrder).toEqual(['provider.connect', 'adapter.connect']);
    expect(provider.connectCalls).toEqual([undefined]);
    expect(direct.connect).toHaveBeenCalledOnce();
    expect(standard.connectCalls).toBe(0);

    await act(async () => { buttons('SIGN PROBE')[0]!.click(); });
    await eventually(() => expect(document.querySelector('[data-testid="signature"]')?.textContent).toBe('7,8'));
    expect(provider.signMessageCalls).toHaveLength(1);
    expect(provider.signMessageCalls[0]?.display).toBe('utf8');
    expect(standard.connectCalls).toBe(0);
  });

  it('migrates remembered Standard Phantom and trusted-auto-connects only the direct adapter', async () => {
    const provider = new DirectProvider();
    const standard = new ThrowingStandardPhantom();
    localStorage.setItem('walletName', JSON.stringify('Phantom'));
    migrateMobilePhantomWalletStorage('android', provider);
    await mount(provider, standard);

    await eventually(() => expect(document.querySelector('[data-testid="wallet"]')?.textContent)
      .toBe(provider.key.toBase58()));
    expect(provider.connectCalls).toEqual([{ onlyIfTrusted: true }]);
    expect(standard.connectCalls).toBe(0);
  });

  it('reports direct-provider cancellation and does not fall through to Standard Phantom', async () => {
    const provider = new DirectProvider();
    provider.connectFailure = new Error('User rejected the request.');
    const standard = new ThrowingStandardPhantom();
    await mount(provider, standard);

    await act(async () => { buttons('CONNECT PHANTOM')[0]!.click(); });
    await eventually(() => expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toBe('CONNECTION CANCELLED'));
    expect(standard.connectCalls).toBe(0);
    expect(buttons('CONNECT PHANTOM')[0]?.disabled).toBe(false);
  });

  it('reports an early primed rejection and retries with one provider call per tap', async () => {
    const provider = new DirectProvider();
    provider.failNextConnect = new Error('User rejected the request.');
    const standard = new ThrowingStandardPhantom();
    await mount(provider, standard);

    await act(async () => { buttons('CONNECT PHANTOM')[0]!.click(); });
    await eventually(() => expect(document.body.querySelector('[role="alert"]')?.textContent)
      .toBe('CONNECTION CANCELLED'));
    expect(provider.connectCalls).toEqual([undefined]);
    expect(standard.connectCalls).toBe(0);

    await act(async () => { buttons('CONNECT PHANTOM')[0]!.click(); });
    await eventually(() => expect(document.querySelector('[data-testid="wallet"]')?.textContent)
      .toBe(provider.key.toBase58()));
    expect(provider.connectCalls).toEqual([undefined, undefined]);
    expect(standard.connectCalls).toBe(0);
  });

  it('consumes the primed attempt when Phantom is already selected but disconnected', async () => {
    const provider = new DirectProvider();
    const standard = new ThrowingStandardPhantom();
    localStorage.setItem('walletName', JSON.stringify(MOBILE_PHANTOM_WALLET_NAME));
    const direct = await mount(provider, standard, false);

    expect(document.querySelector('[data-testid="wallet"]')?.textContent).toBe('');
    await act(async () => { buttons('CONNECT PHANTOM')[0]!.click(); });
    await eventually(() => expect(document.querySelector('[data-testid="wallet"]')?.textContent)
      .toBe(provider.key.toBase58()));
    expect(provider.connectCalls).toEqual([undefined]);
    expect(direct.connect).toHaveBeenCalledOnce();
    expect(standard.connectCalls).toBe(0);
  });

  it('reserves the Phantom row until a late injected provider replaces the Standard twin', async () => {
    vi.useFakeTimers();
    const provider = new DirectProvider();
    const standard = new ThrowingStandardPhantom();
    await mountLateInjection(standard);

    expect(buttons('CONNECT PHANTOM')).toHaveLength(0);
    Object.defineProperty(window, 'phantom', {
      configurable: true,
      value: { solana: provider },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(buttons('CONNECT PHANTOM')).toHaveLength(1);

    await act(async () => { buttons('CONNECT PHANTOM')[0]!.click(); });
    await eventually(() => expect(document.querySelector('[data-testid="wallet"]')?.textContent)
      .toBe(provider.key.toBase58()));
    expect(provider.connectCalls).toEqual([undefined]);
    expect(standard.connectCalls).toBe(0);
  });

  it('reveals the Standard Phantom fallback only after bounded late-injection detection', async () => {
    vi.useFakeTimers();
    const standard = new ThrowingStandardPhantom();
    await mountLateInjection(standard);

    expect(buttons('CONNECT PHANTOM')).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_999); });
    expect(buttons('CONNECT PHANTOM')).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(buttons('CONNECT PHANTOM')).toHaveLength(1);
    expect(standard.connectCalls).toBe(0);
  });

  it('cancels the bounded injection poll when the wallet tree unmounts', async () => {
    vi.useFakeTimers();
    const standard = new ThrowingStandardPhantom();
    await mountLateInjection(standard);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await act(async () => { root?.unmount(); });
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
