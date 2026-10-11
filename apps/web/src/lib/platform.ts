/**
 * Device capabilities — the ONE place the connect flow asks "what can this
 * device actually do?".
 *
 * It exists because the wallet-adapter modal has no answer on iOS: there is no
 * injected wallet, MWA never registers, so the modal renders its empty state and
 * the player is stranded on the title screen. Choosing between an injected
 * extension, Mobile Wallet Adapter and a universal-link handoff needs device
 * facts, and those facts have to come from one place or they drift.
 *
 * Non-negotiable rules this module enforces by containing them:
 *  - `window.innerWidth` NEVER appears here. Width is a LAYOUT question: a
 *    380px-wide desktop window is still a desktop with an extension, and a
 *    landscape phone is still a phone. usePortrait() (ui/layout.ts) may size the
 *    connect sheet; nothing may let it choose the sheet's contents.
 *  - `any-pointer` is banned: a touchscreen laptop reports (pointer: fine) plus
 *    (any-pointer: coarse) and would be misread as a phone.
 *  - `navigator.userAgentData` is deliberately unused — it is undefined on every
 *    iOS browser and on Firefox, so it can only ever produce a false negative.
 *  - Wallet PRESENCE is not a capability and is not here. Wallet-standard
 *    wallets register asynchronously (AppReady), so presence must be read
 *    reactively from useWallet().wallets at render; snapshotting it once is the
 *    classic "Phantom registered 200ms late, sheet says no wallet" bug.
 *
 * detectCaps() is pure so every UA case is testable in node; `caps` is the one
 * snapshot the app reads, taken once at module load because device identity
 * cannot change mid-session (and a value that could would make the sheet
 * flicker between option sets).
 */
export type Platform = 'ios' | 'android' | 'desktop';

export interface Caps {
  platform: Platform;
  /** incl. iPadOS 13+, which reports a desktop Macintosh user agent */
  isIOS: boolean;
  isAndroid: boolean;
  /** the primary input is a finger: (pointer: coarse) AND (hover: none) */
  isTouchPrimary: boolean;
  /** launched as an app (TWA / installed PWA) rather than as a browser tab */
  isTwa: boolean;
  /** Seeker's Solana Mobile Web Shell — the one WebView MWA still registers in */
  isSolanaMobileShell: boolean;
  /** MWA and Privy both refuse to run outside a secure context */
  isSecureContext: boolean;
  /**
   * A wallet EXTENSION can exist here at all: a desktop Chromium or Gecko
   * browser. None of the three wallets ships a Safari build, so without this the
   * no-wallet desktop branch tells a Safari player to install one, hands them a
   * download page with nothing installable, and takes them straight back to the
   * same screen — a closed loop, and the only one left when Privy is off.
   * Engine tokens only: Brave, Edge, Opera and Arc all carry Chrome/ and must
   * stay on the true side. Always false on mobile, where an extension is not a
   * route the sheet ever offers.
   */
  canInstallExtension: boolean;
  /** the page sits on a public https origin, so a wallet app can fetch it back */
  canDeepLink: boolean;
  /**
   * Launched from the Home Screen as an installed app (iOS standalone or any
   * PWA display-mode). It matters for wallet choice: opening a wallet app from
   * here LEAVES the installed app and the player continues in the wallet's
   * browser — there is no way back into an iOS standalone PWA from another app.
   * So the sheet leads with the sign-in that never leaves (owner report
   * 2026-08-07: the game was installed to the Home Screen and every wallet
   * route stranded him in a different browser).
   */
  isStandalone: boolean;
}

/** Everything detectCaps() reads, so tests can hand it a device instead of one. */
export interface PlatformEnv {
  ua: string;
  maxTouchPoints: number;
  /** media-query matcher; must answer false when matchMedia is unavailable */
  matches: (query: string) => boolean;
  /** document.referrer — 'android-app://…' when launched as a TWA */
  referrer: string;
  isSecureContext: boolean;
  /** location.protocol / location.hostname */
  protocol: string;
  hostname: string;
  /** navigator.standalone — iOS Safari's ONLY signal that the page was launched
   *  from a Home Screen icon; iOS never matches (display-mode: standalone). */
  isIosStandalone: boolean;
}

/**
 * A universal link hands the target URL to an app ON THE DEVICE, which then
 * fetches it over the public internet — so http, localhost and LAN addresses can
 * never work. Emitting one anyway produces a silent dead end on the phone rather
 * than an error, which is exactly the failure mode this whole change removes.
 */
export function isPublicHttps(protocol: string, hostname: string): boolean {
  return protocol === 'https:' && !/^(localhost$|127\.|0\.0\.0\.0$|\[?::1)/.test(hostname);
}

export function detectCaps(env: PlatformEnv): Caps {
  const ua = env.ua;
  const isAndroid = /Android/i.test(ua) && !/Windows Phone/i.test(ua);
  // iPadOS 13+ ships a desktop Safari UA on purpose. maxTouchPoints is the only
  // reliable tell left: a real Mac reports 0, an iPad reports 5.
  const isIpadOS = /Macintosh/.test(ua) && env.maxTouchPoints > 1;
  const isIOS = /iPhone|iPod|iPad/i.test(ua) || isIpadOS;
  const platform: Platform = isIOS ? 'ios' : isAndroid ? 'android' : 'desktop';
  return {
    platform,
    isIOS,
    isAndroid,
    isTouchPrimary: env.matches('(pointer: coarse)') && env.matches('(hover: none)'),
    isTwa: env.referrer.startsWith('android-app://') || env.matches('(display-mode: standalone)'),
    isSolanaMobileShell: /Solana Mobile Web Shell/i.test(ua),
    isSecureContext: env.isSecureContext,
    canInstallExtension: platform === 'desktop' && /Chrome\/|Chromium\/|Firefox\//.test(ua),
    canDeepLink: isPublicHttps(env.protocol, env.hostname),
    // iOS reports standalone ONLY via the legacy navigator flag; the media
    // query is the cross-browser half (Android/desktop installs).
    isStandalone: env.isIosStandalone || env.matches('(display-mode: standalone)'),
  };
}

function liveEnv(): PlatformEnv {
  // Node (unit tests) has no window. Falling back to "desktop, cannot deep link"
  // is the conservative branch: it can only ever hide a route that does not
  // exist in node anyway, never one a real device has.
  if (typeof window === 'undefined') {
    return {
      ua: '', maxTouchPoints: 0, matches: () => false, referrer: '',
      isSecureContext: false, protocol: '', hostname: '', isIosStandalone: false,
    };
  }
  return {
    ua: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    matches: (q) => window.matchMedia?.(q).matches ?? false,
    referrer: document.referrer,
    isSecureContext: window.isSecureContext,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    isIosStandalone: (navigator as { standalone?: boolean }).standalone === true,
  };
}

export const caps: Caps = detectCaps(liveEnv());

/**
 * Which client is signing in, for the playtest statistics split (D-103:
 * "separate solana mobile players onboarded vs normal players"). Read at CALL
 * time, not at module load: the installed shell marks itself either with
 * `?client=solana-mobile` on its start URL or with the localStorage marker the
 * asset-pack gate persists on first launch (lib/assetPack.ts), and that marker
 * can land after this module was evaluated. The Seeker web shell UA is the
 * third signal. The server records the value on the session; it is a label,
 * never an entitlement, so a spoofed value buys nothing.
 */
export function signInClient(): 'solana-mobile' | 'browser' {
  if (typeof window === 'undefined') return 'browser';
  if (caps.isSolanaMobileShell) return 'solana-mobile';
  if (new URLSearchParams(window.location.search).get('client') === 'solana-mobile') return 'solana-mobile';
  try {
    if (localStorage.getItem('pkw:solana-mobile-client') != null) return 'solana-mobile';
  } catch { /* storage blocked: a browser tab */ }
  return 'browser';
}

/** The absolute https URL a wallet's in-app browser should reopen. Read at call
 *  time (not at module load) so it is never captured before a redirect. */
export function playUrl(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}${window.location.pathname}`;
}

/** The `ref` every wallet universal link requires. */
export function playOrigin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}
