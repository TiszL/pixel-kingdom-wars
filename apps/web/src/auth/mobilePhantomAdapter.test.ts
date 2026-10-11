import {
  Keypair, PublicKey, SystemProgram, Transaction, type VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { InjectedPhantomProvider } from './injectedPhantom';
import {
  MOBILE_PHANTOM_WALLET_NAME,
  MobilePhantomAdapter,
  PHANTOM_INTERNAL_ERROR_MESSAGE,
  isPhantomInternalError,
  migrateMobilePhantomWalletStorage,
  mobilePhantomAdapters,
} from './mobilePhantomAdapter';

vi.mock('../lib/analytics', async (orig) => ({ ...(await orig<typeof import('../lib/analytics')>()), track: vi.fn() }));

function phantomInternalError(): Error {
  return Object.assign(new Error('Unexpected error'), { code: -32603 });
}

type AccountListener = (publicKey: unknown | null) => void;
type DisconnectListener = () => void;

class FakePhantomProvider implements InjectedPhantomProvider {
  readonly isPhantom = true;
  isConnected = false;
  publicKey: PublicKey | null = null;
  nextKey = Keypair.generate().publicKey;
  returnedKey: PublicKey | null = null;
  connectFailure: Error | null = null;
  /** Rejects exactly one connect() call, then behaves normally. */
  failNextConnect: Error | null = null;
  signer: Keypair | null = null;
  readonly disconnect = vi.fn();
  readonly connectCalls: Array<{ onlyIfTrusted?: boolean } | undefined> = [];
  readonly signMessageCalls: Array<{ message: Uint8Array; display: 'utf8' | 'hex' | undefined }> = [];
  readonly signTransactionCalls: Array<Transaction | VersionedTransaction> = [];
  readonly accountListeners = new Set<AccountListener>();
  readonly disconnectListeners = new Set<DisconnectListener>();
  connectGate: Promise<void> | null = null;

  async connect(options?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: PublicKey }> {
    this.connectCalls.push(options);
    if (this.failNextConnect) {
      const failure = this.failNextConnect;
      this.failNextConnect = null;
      throw failure;
    }
    if (this.connectFailure) throw this.connectFailure;
    if (this.connectGate) await this.connectGate;
    this.isConnected = true;
    this.publicKey = this.nextKey;
    return { publicKey: this.returnedKey ?? this.nextKey };
  }

  async signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<{ signature: Uint8Array; publicKey: PublicKey }> {
    this.signMessageCalls.push({ message, display });
    return { signature: new Uint8Array([4, 2]), publicKey: this.publicKey! };
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    this.signTransactionCalls.push(transaction);
    if (transaction instanceof Transaction && this.signer) transaction.partialSign(this.signer);
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

  accountChanged(publicKey: PublicKey | null): void {
    this.publicKey = publicKey;
    this.isConnected = publicKey !== null;
    for (const listener of this.accountListeners) listener(publicKey);
  }

  providerDisconnected(): void {
    this.publicKey = null;
    this.isConnected = false;
    for (const listener of this.disconnectListeners) listener();
  }
}

describe('MobilePhantomAdapter', () => {
  it('uses one confirmed provider account for connect and message signing', async () => {
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    const connects = vi.fn();
    adapter.on('connect', connects);

    await adapter.connect();
    expect(provider.connectCalls).toEqual([undefined]);
    expect(adapter.publicKey?.equals(provider.nextKey)).toBe(true);
    expect(connects).toHaveBeenCalledWith(provider.nextKey);

    const message = new Uint8Array([1, 2, 3]);
    await expect(adapter.signMessage(message)).resolves.toEqual(new Uint8Array([4, 2]));
    expect(provider.signMessageCalls).toEqual([{ message, display: 'utf8' }]);
  });

  it('makes concurrent callers await the same provider confirmation', async () => {
    const provider = new FakePhantomProvider();
    let release!: () => void;
    provider.connectGate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = new MobilePhantomAdapter(provider);
    let secondSettled = false;

    const first = adapter.connect();
    const second = adapter.connect().then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(provider.connectCalls).toEqual([undefined]);
    expect(secondSettled).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(adapter.publicKey?.equals(provider.nextKey)).toBe(true);
  });

  it('primes the raw provider promise in the tap stack and consumes it once from manual connect', async () => {
    const provider = new FakePhantomProvider();
    let release!: () => void;
    provider.connectGate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = new MobilePhantomAdapter(provider);

    adapter.primeConnectFromUserGesture();
    adapter.primeConnectFromUserGesture();
    expect(provider.connectCalls).toEqual([undefined]);

    const connected = adapter.connect();
    await Promise.resolve();
    expect(provider.connectCalls).toEqual([undefined]);

    release();
    await connected;
    expect(provider.connectCalls).toEqual([undefined]);
    expect(adapter.publicKey?.equals(provider.nextKey)).toBe(true);
  });

  it('handles an early primed rejection and allows a fresh manual retry', async () => {
    const provider = new FakePhantomProvider();
    provider.connectFailure = new Error('User rejected the request.');
    const adapter = new MobilePhantomAdapter(provider);
    const errors = vi.fn();
    adapter.on('error', errors);

    adapter.primeConnectFromUserGesture();
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
    await expect(adapter.connect()).rejects.toThrow('User rejected the request.');
    expect(errors).toHaveBeenCalledOnce();
    expect(provider.connectCalls).toEqual([undefined]);

    provider.connectFailure = null;
    adapter.primeConnectFromUserGesture();
    await expect(adapter.connect()).resolves.toBeUndefined();
    expect(provider.connectCalls).toEqual([undefined, undefined]);
    expect(adapter.publicKey?.equals(provider.nextKey)).toBe(true);
  });

  it('accepts Phantom\'s documented toBytes-only public-key shape', async () => {
    const provider = new FakePhantomProvider();
    const key = provider.nextKey;
    Object.defineProperty(provider, 'publicKey', {
      configurable: true,
      get: () => ({ toBytes: () => key.toBytes() }),
      set: () => undefined,
    });
    const adapter = new MobilePhantomAdapter(provider);
    await adapter.connect();
    expect(adapter.publicKey?.equals(key)).toBe(true);
  });

  it('uses onlyIfTrusted for remembered auto-connect and never revokes Phantom on cleanup', async () => {
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    await adapter.autoConnect();
    expect(provider.connectCalls).toEqual([{ onlyIfTrusted: true }]);
    expect(provider.accountListeners.size).toBe(1);

    await adapter.disconnect();
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(adapter.publicKey).toBeNull();
    expect(provider.accountListeners.size).toBe(0);
  });

  it('rehydrates an already-live provider without issuing a second connect', async () => {
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    await adapter.connect();
    await adapter.disconnect();
    expect(provider.isConnected).toBe(true);

    await adapter.connect();
    expect(provider.connectCalls).toEqual([undefined]);
    expect(adapter.publicKey?.equals(provider.nextKey)).toBe(true);
    expect(provider.accountListeners.size).toBe(1);
  });

  it('leaves the provider permission intact after a rejected trusted or manual connection', async () => {
    const provider = new FakePhantomProvider();
    provider.connectFailure = new Error('User rejected the request.');
    const adapter = new MobilePhantomAdapter(provider);

    await expect(adapter.autoConnect()).rejects.toThrow('User rejected the request.');
    await expect(adapter.connect()).rejects.toThrow('User rejected the request.');
    expect(provider.disconnect).not.toHaveBeenCalled();
    expect(adapter.publicKey).toBeNull();
  });

  it('fails closed when the response account and live provider account differ', async () => {
    const provider = new FakePhantomProvider();
    provider.returnedKey = Keypair.generate().publicKey;
    const adapter = new MobilePhantomAdapter(provider);
    await expect(adapter.connect()).rejects.toThrow('different account');
    expect(adapter.publicKey).toBeNull();
    expect(provider.disconnect).not.toHaveBeenCalled();
  });

  it('propagates account changes and disconnects so the session fence sees them', async () => {
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    const connects: string[] = [];
    const disconnect = vi.fn();
    adapter.on('connect', (key) => connects.push(key.toBase58()));
    adapter.on('disconnect', disconnect);
    await adapter.connect();

    const second = Keypair.generate().publicKey;
    provider.accountChanged(second);
    expect(adapter.publicKey?.equals(second)).toBe(true);
    expect(connects.at(-1)).toBe(second.toBase58());

    provider.accountChanged(null);
    expect(adapter.publicKey).toBeNull();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('refuses to sign after a missed provider account switch', async () => {
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    await adapter.connect();
    provider.publicKey = Keypair.generate().publicKey; // deliberately omit accountChanged

    await expect(adapter.signMessage(new Uint8Array([1]))).rejects.toThrow('account changed');
    await expect(adapter.signTransaction(new Transaction())).rejects.toThrow('account changed');
  });

  it('signs and broadcasts transactions through the app-selected Connection', async () => {
    const signer = Keypair.generate();
    const provider = new FakePhantomProvider();
    provider.nextKey = signer.publicKey;
    provider.signer = signer;
    const adapter = new MobilePhantomAdapter(provider);
    await adapter.connect();

    const transaction = new Transaction({
      feePayer: signer.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: signer.publicKey, lamports: 0 }));
    const sendRawTransaction = vi.fn().mockResolvedValue('test-signature');
    const connection = { sendRawTransaction } as never;
    await expect(adapter.sendTransaction(transaction, connection)).resolves.toBe('test-signature');
    expect(provider.signTransactionCalls).toEqual([transaction]);
    expect(sendRawTransaction).toHaveBeenCalledOnce();
  });
});

describe('MobilePhantomAdapter recovery', () => {
  it('retries a manual connect exactly once after Phantom\'s internal -32603 and never after a user rejection', async () => {
    // WHY: on the Seeker, the second Phantom account answered "Unexpected
    // error" from bridge state left by an account switch, not from the player
    // declining. One fresh request clears that state; a declined dialog must
    // NOT be re-prompted.
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    provider.failNextConnect = phantomInternalError();
    await adapter.connect();
    expect(provider.connectCalls).toEqual([undefined, undefined]);
    expect(adapter.publicKey?.equals(provider.nextKey)).toBe(true);

    const declined = new FakePhantomProvider();
    const declinedAdapter = new MobilePhantomAdapter(declined);
    declined.failNextConnect = new Error('User rejected the request.');
    await expect(declinedAdapter.connect()).rejects.toThrow('User rejected the request.');
    expect(declined.connectCalls).toEqual([undefined]);
  });

  it('never retries a remembered trusted auto-connect, and surfaces a second internal failure', async () => {
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    provider.failNextConnect = phantomInternalError();
    await expect(adapter.autoConnect()).rejects.toThrow('Unexpected error');
    expect(provider.connectCalls).toEqual([{ onlyIfTrusted: true }]);

    const twice = new FakePhantomProvider();
    const twiceAdapter = new MobilePhantomAdapter(twice);
    twice.connectFailure = phantomInternalError();
    await expect(twiceAdapter.connect()).rejects.toThrow('Unexpected error');
    expect(twice.connectCalls).toEqual([undefined, undefined]);
    expect(twiceAdapter.publicKey).toBeNull();
  });

  it('surfaces a stable internal-failure marker regardless of Phantom\'s -32603 text', async () => {
    // WHY: ConnectSheet keys the RELOAD action off connectError()'s copy, which
    // matches the marker — not whatever text Phantom attached to the code. The
    // raw provider text also never reaches the UI, telemetry or server logs.
    const provider = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(provider);
    provider.connectFailure = Object.assign(new Error('bridge session 7xKq…Z9 detached'), { code: -32603 });
    const errors: Error[] = [];
    adapter.on('error', (error) => errors.push(error));
    await expect(adapter.connect()).rejects.toThrow(PHANTOM_INTERNAL_ERROR_MESSAGE);
    expect(errors.map((error) => error.message)).toEqual([PHANTOM_INTERNAL_ERROR_MESSAGE]);
    expect(PHANTOM_INTERNAL_ERROR_MESSAGE).toMatch(/unexpected error/i);
    expect(provider.connectCalls).toEqual([undefined, undefined]);
  });

  it('addresses the live injected provider after Phantom re-injects, and moves its listeners there', async () => {
    // WHY: the adapter is created once at detection; Phantom's in-app browser
    // can replace window.phantom.solana after an account switch. A connect()
    // on the stale object is exactly the kind of call that answers -32603.
    const stale = new FakePhantomProvider();
    const fresh = new FakePhantomProvider();
    const adapter = new MobilePhantomAdapter(stale);
    const g = globalThis as { window?: unknown };
    const hadWindow = 'window' in g;
    const priorWindow = g.window;
    g.window = { phantom: { solana: fresh } };
    try {
      await adapter.connect();
      expect(stale.connectCalls).toEqual([]);
      expect(fresh.connectCalls).toEqual([undefined]);
      expect(adapter.publicKey?.equals(fresh.nextKey)).toBe(true);
      expect(fresh.accountListeners.size).toBe(1);
      expect(stale.accountListeners.size).toBe(0);
      await adapter.disconnect();
      expect(fresh.accountListeners.size).toBe(0);
    } finally {
      if (hadWindow) g.window = priorWindow; else delete g.window;
    }
  });

  it('classifies only Phantom\'s internal failure as retryable', () => {
    expect(isPhantomInternalError(phantomInternalError())).toBe(true);
    expect(isPhantomInternalError(Object.assign(new Error('anything at all'), { code: -32603 }))).toBe(true);
    expect(isPhantomInternalError(new Error('Unexpected error'))).toBe(true);
    expect(isPhantomInternalError(new Error('User rejected the request.'))).toBe(false);
    expect(isPhantomInternalError(Object.assign(new Error('x'), { code: 4001 }))).toBe(false);
    // An explicit non-internal code wins over a misleading message: a declined
    // dialog must never be re-prompted because Phantom worded it "Unexpected".
    expect(isPhantomInternalError(Object.assign(new Error('Unexpected error'), { code: 4001 }))).toBe(false);
  });
});

describe('mobile Phantom selection boot', () => {
  it('migrates only stale Standard Phantom storage before provider initialization', () => {
    const values = new Map([['walletName', JSON.stringify('Phantom')]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const provider = new FakePhantomProvider();
    migrateMobilePhantomWalletStorage('android', provider, storage);
    expect(JSON.parse(values.get('walletName')!)).toBe(MOBILE_PHANTOM_WALLET_NAME);

    values.set('walletName', JSON.stringify('Solflare'));
    migrateMobilePhantomWalletStorage('android', provider, storage);
    expect(JSON.parse(values.get('walletName')!)).toBe('Solflare');

    values.set('walletName', JSON.stringify('Phantom'));
    migrateMobilePhantomWalletStorage('desktop', provider, storage);
    expect(JSON.parse(values.get('walletName')!)).toBe('Phantom');

    values.set('walletName', JSON.stringify('Phantom'));
    migrateMobilePhantomWalletStorage('android', null, storage);
    expect(JSON.parse(values.get('walletName')!)).toBe(MOBILE_PHANTOM_WALLET_NAME);
  });

  it('cannot strand pre-React boot when a restricted WebView denies storage access', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const blockedWindow = Object.defineProperty({}, 'localStorage', {
      configurable: true,
      get: () => { throw new DOMException('Blocked', 'SecurityError'); },
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: blockedWindow });
    try {
      expect(() => migrateMobilePhantomWalletStorage('android', new FakePhantomProvider()))
        .not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('registers the unique adapter only for an injected provider on mobile', () => {
    const provider = new FakePhantomProvider();
    const android = mobilePhantomAdapters('android', provider);
    expect(android.map((adapter) => adapter.name))
      .toEqual([MOBILE_PHANTOM_WALLET_NAME]);
    expect(mobilePhantomAdapters('ios', provider)[0]).toBe(android[0]);
    expect(mobilePhantomAdapters('desktop', provider)).toEqual([]);
    expect(mobilePhantomAdapters('android', null)).toEqual([]);
  });
});
