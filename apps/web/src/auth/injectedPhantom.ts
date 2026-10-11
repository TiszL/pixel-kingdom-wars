import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import type { Platform } from '../lib/platform';

/** Phantom's documented injected provider. Phantom exposes this alongside its
 * Wallet Standard registration in its in-app browser. On mobile this provider
 * is the connection authority; mixing it with a second Wallet Standard connect
 * is what made a confirmed account selection fail with "Unexpected error". */
export interface InjectedPhantomProvider {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: unknown;
  connect(options?: { onlyIfTrusted?: boolean }): Promise<unknown>;
  signMessage(message: Uint8Array, display?: 'utf8' | 'hex'): Promise<unknown>;
  signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]>;
  on(event: 'accountChanged', listener: (publicKey: unknown | null) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  off?(event: 'accountChanged', listener: (publicKey: unknown | null) => void): unknown;
  off?(event: 'disconnect', listener: () => void): unknown;
  removeListener?(event: 'accountChanged', listener: (publicKey: unknown | null) => void): unknown;
  removeListener?(event: 'disconnect', listener: () => void): unknown;
}

interface PhantomWindow {
  phantom?: { solana?: InjectedPhantomProvider };
}

export function injectedPhantomProvider(
  source: PhantomWindow | undefined = typeof window === 'undefined'
    ? undefined
    : window as unknown as PhantomWindow,
): InjectedPhantomProvider | null {
  try {
    const provider = source?.phantom?.solana;
    return provider?.isPhantom === true
      && typeof provider.connect === 'function'
      && typeof provider.signMessage === 'function'
      && typeof provider.signTransaction === 'function'
      && typeof provider.on === 'function'
      ? provider
      : null;
  } catch {
    // A provider getter belongs to the wallet extension. Treat a throwing
    // getter exactly like an unavailable provider and let Wallet Standard try.
    return null;
  }
}

export function isMobileInjectedPhantom(
  platform: Platform,
  walletName: string | null | undefined,
  provider: InjectedPhantomProvider | null = injectedPhantomProvider(),
): boolean {
  const normalizedName = walletName?.trim().toLowerCase();
  return platform !== 'desktop'
    && (normalizedName === 'phantom' || normalizedName === 'phantom mobile')
    && provider !== null;
}
