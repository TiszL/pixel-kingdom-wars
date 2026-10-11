/**
 * Mobile Wallet Adapter registration (Seeker / Android Chrome / TWA).
 * wallet-standard-mobile ≥0.5.0 is REQUIRED — earlier versions break
 * silently under the Local Network Access browser permission
 * (research: solana-client-stack §2).
 */
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  registerMwa as register,
} from '@solana-mobile/wallet-standard-mobile';
import { SOLANA_CHAIN } from './cluster';
import { bus } from './events';
import { versionedPublicAsset } from './version';

let registered = false;

/** Wallets render this identity during authorization. Keep its icon on the same
 * build-bound public path as the PWA/TWA launcher, so a player never approves a
 * current game under the deprecated tower mark.
 *
 * `icon` MUST be a RELATIVE URI (resolved against `uri`) — the MWA spec
 * requires it and Seeker wallets REFUSE the whole authorize request otherwise
 * ("when specified, identity.icon must be a relative uri", live report
 * 2026-08-16). The absolute href this used to send broke CONNECT WALLET APP
 * on-device. Strip any leading slash so it stays relative even against a
 * `uri` with a path. */
export function mwaAppIdentity(origin: string): { name: string; uri: string; icon: string } {
  return {
    name: 'Pixel Kingdom Wars',
    uri: origin,
    icon: versionedPublicAsset('/icons/icon-192.png').replace(/^\//, ''),
  };
}

export function registerMwa(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  try {
    register({
      appIdentity: mwaAppIdentity(window.location.origin),
      authorizationCache: createDefaultAuthorizationCache(),
      chains: [SOLANA_CHAIN],
      chainSelector: createDefaultChainSelector(),
      // MWA registers on Android whether or not a wallet app is installed, so
      // "no wallet answered" is a normal outcome, not an edge case. The library
      // default opens its OWN unbranded modal pointing at solanamobile.com — a
      // second dead end. Route it to the connect sheet, which is already showing
      // the deep links and store links that actually resolve this.
      onWalletNotFound: () => {
        bus.emit('wallet:not-found', undefined);
        return Promise.resolve();
      },
    });
  } catch {
    // Desktop browsers without MWA support — injected wallets still work.
  }
}
