import {
  BaseWalletAdapter,
  BaseMessageSignerWalletAdapter,
  WalletConnectionError,
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletPublicKeyError,
  WalletReadyState,
  WalletSignMessageError,
  WalletSignTransactionError,
  type WalletName,
} from '@solana/wallet-adapter-base';
import {
  PublicKey, type Transaction, type VersionedTransaction,
} from '@solana/web3.js';
import { useEffect, useMemo, useState } from 'react';
import { EVENTS, track } from '../lib/analytics';
import type { Platform } from '../lib/platform';
import { injectedPhantomProvider, type InjectedPhantomProvider } from './injectedPhantom';

export const MOBILE_PHANTOM_WALLET_NAME = 'Phantom Mobile' as WalletName<'Phantom Mobile'>;
export const WALLET_STORAGE_KEY = 'walletName';

const PHANTOM_DETECTION_INTERVAL_MS = 100;
const PHANTOM_DETECTION_TIMEOUT_MS = 3_000;
/** One bounded pause before the single retry of a Phantom-internal failure. */
const PHANTOM_INTERNAL_RETRY_DELAY_MS = 250;

const PHANTOM_ICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

type PhantomConnectResult = { publicKey?: unknown } | null | undefined;
type PhantomSignatureResult = { signature?: unknown; publicKey?: unknown } | Uint8Array;

function publicKeyOf(value: unknown): PublicKey | null {
  if (value == null) return null;
  try {
    if (value instanceof PublicKey) return value;
    if (typeof value === 'string' || value instanceof Uint8Array) return new PublicKey(value);
    if (typeof value === 'object' && 'toBase58' in value
      && typeof (value as { toBase58?: unknown }).toBase58 === 'function') {
      return new PublicKey((value as { toBase58(): string }).toBase58());
    }
    // Phantom's documented provider contract exposes publicKey through the
    // minimal Wallet Standard shape (`toBytes`) rather than promising web3.js's
    // `toBase58`. Do not reject the real mobile provider after confirmation.
    if (typeof value === 'object' && 'toBytes' in value
      && typeof (value as { toBytes?: unknown }).toBytes === 'function') {
      return new PublicKey((value as { toBytes(): Uint8Array }).toBytes());
    }
  } catch { /* malformed or non-Solana key */ }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/** Phantom's documented internal failure (-32603 "Unexpected error"). Its
 * in-app browser answers this from bridge state — typically after an account
 * switch or tab resume — not from anything the player chose, so it is the one
 * connect rejection worth retrying once. A user rejection is never retried:
 * when the provider names a numeric code, only -32603 qualifies; the message
 * is consulted only for a codeless error. */
export function isPhantomInternalError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return code === -32603;
  return /unexpected error/i.test(errorMessage(error));
}

/** Stable, provider-text-free message for a Phantom-internal failure that
 * survived the retry. connectOptions.connectError() keys its recovery copy
 * (and ConnectSheet its reload action) off this marker, never off whatever
 * text Phantom attached to the -32603. */
export const PHANTOM_INTERNAL_ERROR_MESSAGE = 'Unexpected error (Phantom -32603)';

type ConnectFailureReason = 'internal' | 'rejected' | 'not_ready' | 'account_mismatch' | 'other';

/** Fixed categories only — provider error text is untrusted and may carry an
 * address or other identifier, so it never leaves the device. */
function connectFailureReason(error: unknown): ConnectFailureReason {
  if (isPhantomInternalError(error)) return 'internal';
  const message = errorMessage(error);
  if (/reject|denied|cancell?ed|user closed/i.test(message)) return 'rejected';
  if (error instanceof WalletNotReadyError) return 'not_ready';
  if (/different account|did not expose the confirmed account/i.test(message)) return 'account_mismatch';
  return 'other';
}

/** Bounded diagnostic only: phase, booleans and a fixed failure category.
 * Never the account, signature, provider payload or provider error text
 * (analytics.ts privacy contract). */
function trackConnect(
  phase: 'primed' | 'rehydrated' | 'ok' | 'retry' | 'failed',
  diag: { manual: boolean; primed: boolean; live: boolean },
  error?: unknown,
): void {
  track(EVENTS.PHANTOM_MOBILE_CONNECT, {
    phase, ...diag,
    ...(error === undefined ? {} : { reason: connectFailureReason(error) }),
  });
}

function signatureOf(result: PhantomSignatureResult): Uint8Array | null {
  const value = result instanceof Uint8Array ? result : result?.signature;
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/** Replace only the stale Standard Phantom choice. Other remembered wallets
 * stay untouched, and the migration occurs in main.tsx before WalletProvider's
 * local-storage hook can issue a Standard auto-connect. */
export function migrateMobilePhantomWalletStorage(
  platform: Platform,
  provider: InjectedPhantomProvider | null = injectedPhantomProvider(),
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null,
): void {
  if (platform === 'desktop') return;
  // The provider may arrive after pre-React boot. Migrate the remembered name
  // now so WalletProvider cannot auto-connect the independently stateful
  // Standard Phantom twin during that bounded detection window.
  void provider;
  try {
    // A restricted WebView can throw SecurityError from the localStorage getter
    // itself. This runs before React, so even resolving the browser storage must
    // stay inside the fail-safe boundary or the native splash can become final.
    const target = storage === undefined
      ? (typeof window === 'undefined' ? null : window.localStorage)
      : storage;
    if (!target) return;
    const selected = JSON.parse(target.getItem(WALLET_STORAGE_KEY) ?? 'null');
    if (typeof selected === 'string' && selected.trim().toLowerCase() === 'phantom') {
      target.setItem(WALLET_STORAGE_KEY, JSON.stringify(MOBILE_PHANTOM_WALLET_NAME));
    }
  } catch { /* WalletProvider will safely ignore malformed storage itself. */ }
}

/** A non-connectable placeholder reserves Phantom's adapter name while its
 * documented mobile injection is still arriving. ConnectSheet uses the name to
 * suppress the independently stateful Standard twin, but filters this
 * NotDetected adapter from the visible rows. */
class DetectingMobilePhantomAdapter extends BaseWalletAdapter<'Phantom Mobile'> {
  readonly name = MOBILE_PHANTOM_WALLET_NAME;
  readonly url = 'https://phantom.com';
  readonly icon = PHANTOM_ICON;
  readonly readyState = WalletReadyState.NotDetected;
  readonly supportedTransactionVersions = null;
  public publicKey: PublicKey | null = null;
  public connecting = false;

  async connect(): Promise<void> { throw new WalletNotReadyError(); }
  async disconnect(): Promise<void> { /* nothing was connected */ }
  async sendTransaction(): Promise<never> { throw new WalletNotReadyError(); }
}

const DETECTING_MOBILE_PHANTOM_ADAPTER = new DetectingMobilePhantomAdapter();

type MobilePhantomDetection = {
  provider: InjectedPhantomProvider | null;
  pending: boolean;
};

/** Phantom's SDK can publish `window.phantom.solana` after the app's first
 * render. Poll at its documented cadence for one bounded window. During that
 * window the placeholder prevents the Standard twin from being offered; after
 * timeout other Wallet Standard wallets, including Phantom, remain available. */
export function useDetectedMobilePhantomAdapters(platform: Platform): BaseWalletAdapter[] {
  const [detection, setDetection] = useState<MobilePhantomDetection>(() => {
    const provider = platform === 'desktop' ? null : injectedPhantomProvider();
    return { provider, pending: platform !== 'desktop' && provider === null };
  });

  useEffect(() => {
    if (platform === 'desktop' || detection.provider || !detection.pending) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + PHANTOM_DETECTION_TIMEOUT_MS;

    const poll = (): void => {
      if (!live) return;
      const provider = injectedPhantomProvider();
      if (provider) {
        setDetection({ provider, pending: false });
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setDetection({ provider: null, pending: false });
        return;
      }
      timer = setTimeout(poll, Math.min(PHANTOM_DETECTION_INTERVAL_MS, remaining));
    };

    timer = setTimeout(poll, PHANTOM_DETECTION_INTERVAL_MS);
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [detection.pending, detection.provider, platform]);

  return useMemo(() => {
    if (platform === 'desktop') return [];
    if (detection.provider) return mobilePhantomAdapters(platform, detection.provider);
    return detection.pending ? [DETECTING_MOBILE_PHANTOM_ADAPTER] : [];
  }, [detection.pending, detection.provider, platform]);
}

/** One adapter for one provider: mobile Phantom never crosses from legacy
 * confirmation into a second Wallet Standard account store. `disconnect()` is
 * deliberately local; WalletProvider invokes it while cleaning up a rejected
 * trusted auto-connect, and revoking Phantom there poisons the next manual
 * attempt. Players can still revoke the dapp explicitly in Phantom settings. */
export class MobilePhantomAdapter extends BaseMessageSignerWalletAdapter<'Phantom Mobile'> {
  readonly name = MOBILE_PHANTOM_WALLET_NAME;
  readonly url = 'https://phantom.com';
  readonly icon = PHANTOM_ICON;
  readonly readyState = WalletReadyState.Installed;
  readonly supportedTransactionVersions = new Set<'legacy' | 0>(['legacy', 0]);
  public publicKey: PublicKey | null = null;
  public connecting = false;

  readonly #initialProvider: InjectedPhantomProvider;
  #listenedProvider: InjectedPhantomProvider | null = null;
  #pendingConnect: Promise<void> | null = null;
  #primedManualConnect: Promise<PhantomConnectResult> | null = null;

  constructor(provider: InjectedPhantomProvider) {
    super();
    this.#initialProvider = provider;
  }

  /** Phantom's in-app browser can re-inject `window.phantom.solana` after an
   * account switch or a tab resume. Every call addresses the live object, so a
   * reference captured at detection time cannot answer -32603 for a valid tap;
   * outside a browser (tests, late detection) the constructor provider stands. */
  get #provider(): InjectedPhantomProvider {
    return injectedPhantomProvider() ?? this.#initialProvider;
  }

  autoConnect(): Promise<void> {
    return this.#connect({ onlyIfTrusted: true });
  }

  /** Phantom's mobile browser requires connect() to begin in the original tap
   * stack. WalletProvider still owns adapter selection and connection state;
   * its later manual connect() consumes this exact provider promise. */
  primeConnectFromUserGesture(): void {
    if (this.#pendingConnect || this.#primedManualConnect) return;
    const provider = this.#provider;
    if (provider.isConnected === true && publicKeyOf(provider.publicKey)) return;
    trackConnect('primed', { manual: true, primed: true, live: false });

    let attempt: Promise<PhantomConnectResult>;
    try {
      attempt = provider.connect() as Promise<PhantomConnectResult>;
    } catch (cause: unknown) {
      // A non-conforming provider may throw before returning its promised
      // result. Preserve that failure for WalletProvider's normal error path.
      attempt = Promise.reject(cause);
    }
    this.#primedManualConnect = attempt;
    // The provider can reject before React commits the selected adapter. Keep
    // the original promise handled without replacing it; connect() will still
    // await and report this same rejection exactly once.
    void Promise.resolve(attempt).catch(() => undefined);
  }

  connect(): Promise<void> {
    return this.#connect(undefined);
  }

  async disconnect(): Promise<void> {
    this.#clearConnection(true);
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    try {
      const expected = this.#requireCurrentAccount();
      const result = await this.#provider.signMessage(message, 'utf8');
      const signature = signatureOf(result as PhantomSignatureResult);
      const returnedKey = result instanceof Uint8Array
        ? null
        : publicKeyOf((result as { publicKey?: unknown }).publicKey);
      if (!signature) throw new Error('Phantom returned an invalid message signature');
      if (returnedKey && !returnedKey.equals(expected)) {
        throw new Error('Phantom signed with a different account');
      }
      this.#requireCurrentAccount(expected);
      return signature;
    } catch (cause: unknown) {
      const error = cause instanceof WalletSignMessageError
        ? cause
        : new WalletSignMessageError(errorMessage(cause), cause);
      this.emit('error', error);
      throw error;
    }
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    try {
      const expected = this.#requireCurrentAccount();
      const signed = await this.#provider.signTransaction(transaction);
      this.#requireCurrentAccount(expected);
      return signed;
    } catch (cause: unknown) {
      const error = cause instanceof WalletSignTransactionError
        ? cause
        : new WalletSignTransactionError(errorMessage(cause), cause);
      this.emit('error', error);
      throw error;
    }
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
    if (!this.#provider.signAllTransactions) {
      const signed: T[] = [];
      for (const transaction of transactions) signed.push(await this.signTransaction(transaction));
      return signed;
    }
    try {
      const expected = this.#requireCurrentAccount();
      const signed = await this.#provider.signAllTransactions(transactions);
      this.#requireCurrentAccount(expected);
      return signed;
    } catch (cause: unknown) {
      const error = cause instanceof WalletSignTransactionError
        ? cause
        : new WalletSignTransactionError(errorMessage(cause), cause);
      this.emit('error', error);
      throw error;
    }
  }

  #connect(options: { onlyIfTrusted: true } | undefined): Promise<void> {
    if (this.#pendingConnect) return this.#pendingConnect;
    const attempt = this.#runConnect(options);
    this.#pendingConnect = attempt;
    const clear = (): void => {
      if (this.#pendingConnect === attempt) this.#pendingConnect = null;
    };
    // Attach both handlers immediately so a rejected wallet prompt never
    // becomes an unhandled derived promise. Callers still receive `attempt`.
    void attempt.then(clear, clear);
    return attempt;
  }

  async #runConnect(options: { onlyIfTrusted: true } | undefined): Promise<void> {
    this.connecting = true;
    // Only an explicit/manual connect may consume a gesture-primed attempt.
    // Remembered auto-connect remains a distinct onlyIfTrusted operation.
    const manual = options === undefined;
    const primed = manual ? this.#takePrimedManualConnect() : null;
    const provider = this.#provider;
    const diag = { manual, primed: primed !== null, live: provider.isConnected === true };
    try {
      // A local adapter detach intentionally leaves Phantom permission alive.
      // Re-selecting that exact live provider must hydrate React, not invoke a
      // redundant connect that can prompt or fail after the account was already
      // confirmed.
      const existing = provider.isConnected === true
        ? publicKeyOf(provider.publicKey)
        : null;
      if (existing && !primed) {
        this.publicKey = existing;
        this.#startListening();
        trackConnect('rehydrated', diag);
        this.emit('connect', existing);
        return;
      }
      let result: PhantomConnectResult;
      try {
        result = primed
          ? await primed
          : await provider.connect(options) as PhantomConnectResult;
      } catch (cause: unknown) {
        if (!manual || !isPhantomInternalError(cause)) throw cause;
        // One bounded retry against the live provider. The failed call either
        // never opened Phantom's dialog or the player already confirmed it; a
        // fresh request is what clears the bridge state that answered -32603.
        trackConnect('retry', diag, cause);
        await new Promise<void>((resolve) => setTimeout(resolve, PHANTOM_INTERNAL_RETRY_DELAY_MS));
        result = await this.#provider.connect() as PhantomConnectResult;
      }
      const current = this.#provider;
      const live = publicKeyOf(current.publicKey);
      const returned = publicKeyOf(result?.publicKey);
      if (!live || current.isConnected === false) {
        throw new Error('Phantom did not expose the confirmed account');
      }
      if (returned && !returned.equals(live)) {
        throw new Error('Phantom returned a different account than its live provider');
      }
      this.publicKey = live;
      this.#startListening();
      trackConnect('ok', diag);
      this.emit('connect', live);
    } catch (cause: unknown) {
      this.publicKey = null;
      trackConnect('failed', diag, cause);
      const error = cause instanceof WalletConnectionError
        ? cause
        : new WalletConnectionError(
          isPhantomInternalError(cause) ? PHANTOM_INTERNAL_ERROR_MESSAGE : errorMessage(cause),
          cause,
        );
      this.emit('error', error);
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  #takePrimedManualConnect(): Promise<PhantomConnectResult> | null {
    const attempt = this.#primedManualConnect;
    this.#primedManualConnect = null;
    return attempt;
  }

  #requireCurrentAccount(expected: PublicKey | null = this.publicKey): PublicKey {
    if (!expected) throw new WalletNotConnectedError();
    const live = publicKeyOf(this.#provider.publicKey);
    if (!live || this.#provider.isConnected === false) throw new WalletNotConnectedError();
    if (!live.equals(expected)) throw new WalletPublicKeyError('Phantom account changed before signing');
    return expected;
  }

  #clearConnection(stopListening = false): void {
    if (stopListening) this.#stopListening();
    if (!this.publicKey) return;
    this.publicKey = null;
    this.emit('disconnect');
  }

  /** Listeners follow the live provider: a re-injected object would otherwise
   * report account switches to nobody while the stale one stays subscribed. */
  #startListening(): void {
    const provider = this.#provider;
    if (this.#listenedProvider === provider) return;
    this.#stopListening();
    provider.on('accountChanged', this.#onAccountChanged);
    provider.on('disconnect', this.#onProviderDisconnect);
    this.#listenedProvider = provider;
  }

  #stopListening(): void {
    const provider = this.#listenedProvider;
    if (!provider) return;
    if (provider.off) {
      provider.off('accountChanged', this.#onAccountChanged);
      provider.off('disconnect', this.#onProviderDisconnect);
    } else {
      provider.removeListener?.('accountChanged', this.#onAccountChanged);
      provider.removeListener?.('disconnect', this.#onProviderDisconnect);
    }
    this.#listenedProvider = null;
  }

  #onAccountChanged = (value: unknown | null): void => {
    const next = publicKeyOf(value);
    if (!next) {
      this.#clearConnection(true);
      return;
    }
    if (this.publicKey?.equals(next)) return;
    this.publicKey = next;
    this.emit('connect', next);
  };

  #onProviderDisconnect = (): void => {
    this.#clearConnection(true);
  };
}

export function mobilePhantomAdapters(
  platform: Platform,
  provider: InjectedPhantomProvider | null = injectedPhantomProvider(),
): MobilePhantomAdapter[] {
  if (platform === 'desktop' || !provider) return [];
  let adapter = ADAPTERS_BY_PROVIDER.get(provider);
  if (!adapter) {
    adapter = new MobilePhantomAdapter(provider);
    ADAPTERS_BY_PROVIDER.set(provider, adapter);
  }
  return [adapter];
}

/** React StrictMode may evaluate initializers twice. Reuse by provider so the
 * discarded development render cannot leave duplicate account listeners. */
const ADAPTERS_BY_PROVIDER = new WeakMap<InjectedPhantomProvider, MobilePhantomAdapter>();
