/**
 * Wallet universal links + store links. Pure string building, no DOM, no state.
 *
 * A "browse" universal link is the only way an iOS player reaches a Solana dapp:
 * tapping it hands the target URL to the wallet app, which reopens the game in
 * its own browser, where an injected provider finally exists. Every character of
 * these URLs matters, so each rule below is pinned by a test in walletLinks.test.ts.
 */
import type { Platform } from './platform';

export type WalletKey = 'phantom' | 'solflare' | 'backpack';

/** Render order everywhere the three wallets are offered together. */
export const WALLET_KEYS = ['phantom', 'solflare', 'backpack'] as const;

export const WALLET_LABEL: Record<WalletKey, string> = {
  phantom: 'PHANTOM', solflare: 'SOLFLARE', backpack: 'BACKPACK',
};

/** Official Jupiter Wallet landing page. It routes Chromium players to the
 * verified extension listing without pinning a store id in our bundle. Jupiter
 * then registers through Wallet Standard like every other desktop adapter. */
export const JUPITER_WALLET_URL = 'https://jup.ag/wallet';

/**
 * Template strings ONLY:
 *  - `new URL(...).toString()` re-normalizes the encoded path segment and
 *    URLSearchParams encodes a space as '+', so both corrupt the target URL;
 *  - the version segment genuinely differs per wallet — Phantom has NO /v1,
 *    Solflare and Backpack do;
 *  - Phantom's host is phantom.com, not phantom.app: phantom.app serves no
 *    /.well-known/assetlinks.json, so on Android phantom.app/ul/* is not a
 *    verified App Link and opens in Chrome instead of in the wallet.
 */
const BROWSE: Record<WalletKey, (target: string, ref: string) => string> = {
  phantom: (t, r) => `https://phantom.com/ul/browse/${t}?ref=${r}`,
  solflare: (t, r) => `https://solflare.com/ul/v1/browse/${t}?ref=${r}`,
  backpack: (t, r) => `https://backpack.app/ul/v1/browse/${t}?ref=${r}`,
};

/**
 * ONE encodeURIComponent over the whole absolute target (scheme included), one
 * over the ref. Double-encoding is the failure everyone hits: the wallet decodes
 * once, lands on a percent-mangled URL and shows a blank page. `ref` is not
 * optional — all three wallets require it to attribute the open.
 */
export function browseLink(wallet: WalletKey, target: string, ref: string): string {
  return BROWSE[wallet](encodeURIComponent(target), encodeURIComponent(ref));
}

/**
 * Paired with EVERY deep link, because two of the three wallets dead-end when
 * the app is not installed: Solflare 302s to the right store, Phantom drops the
 * player on its homepage and Backpack shows a bare "Opening link…". Rendering
 * the install link before the tap is both cheaper and more honest than any
 * visibilitychange + setTimeout "app not installed?" heuristic.
 *
 * The Android package ids come from the wallets' own verified assetlinks.json.
 */
const STORE: Record<WalletKey, Record<Platform, string>> = {
  phantom: {
    ios: 'https://phantom.com/download',
    android: 'https://play.google.com/store/apps/details?id=app.phantom',
    desktop: 'https://phantom.com/download',
  },
  solflare: {
    ios: 'https://apps.apple.com/us/app/solflare/id1580902717',
    android: 'https://play.google.com/store/apps/details?id=com.solflare.mobile',
    desktop: 'https://solflare.com/download',
  },
  backpack: {
    ios: 'https://backpack.app/downloads',
    android: 'https://play.google.com/store/apps/details?id=app.backpack.mobile',
    desktop: 'https://backpack.app/downloads',
  },
};

export function storeLink(wallet: WalletKey, platform: Platform): string {
  return STORE[wallet][platform];
}
