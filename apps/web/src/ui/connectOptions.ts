/**
 * The connect sheet as DATA. Pure: no React, no DOM, no viewport.
 *
 * The bug this replaces was a one-liner (`setVisible(true)` → wallet-adapter's
 * modal), and its empty state was unreachable to reason about — you had to hold
 * an iPhone to discover it. Modelling the sheet as a function of device
 * capabilities means the invariant that matters ("every branch ends somewhere
 * useful — no case renders an empty list") is an assertion, not a hope.
 *
 * `ConnectInput` deliberately carries NO width, and Caps has none either, so a
 * narrow desktop window is byte-identical to a wide one by construction.
 */
import type { Caps } from '../lib/platform';
import {
  browseLink, JUPITER_WALLET_URL, storeLink, WALLET_KEYS, WALLET_LABEL, type WalletKey,
} from '../lib/walletLinks';

export type ConnectOption =
  /** a wallet-standard adapter that is present right now → select() + connect() */
  | { kind: 'adapter'; walletName: string; label: string; primary: boolean; sub?: string }
  /** Mobile Wallet Adapter → select('Mobile Wallet Adapter') + connect() */
  | { kind: 'mwa'; label: string; sub?: string }
  /** universal link into a wallet's in-app browser, with its install link */
  | { kind: 'deeplink'; wallet: WalletKey; label: string; href: string; installLabel: string; installHref: string }
  /** Privy social/email → embedded wallet (rendered by the caller's node) */
  | { kind: 'social'; label: string; sub?: string }
  | { kind: 'install'; label: string; href: string }
  | { kind: 'refresh'; label: string };

export interface SheetGroup {
  heading: string | null;
  options: ConnectOption[];
  /** rendered behind a disclosure — used for the fallback routes on a device
   *  that already has a working one */
  collapsed?: boolean;
  /** shown in C.danger above the group; a group with a danger line still has to
   *  carry real options, or it is a dead end with an explanation */
  danger?: string;
}

export interface SheetModel {
  title: string;
  note: string | null;
  groups: SheetGroup[];
}

export interface ConnectInput {
  caps: Caps;
  /** wallet-standard wallets ready to connect, already ordered (orderInjected) */
  injected: { name: string }[];
  /** the Mobile Wallet Adapter wallet is registered */
  hasMwa: boolean;
  privyEnabled: boolean;
  /** MWA reported that no wallet app answered (bus 'wallet:not-found') */
  mwaNotFound: boolean;
  /** absolute https URL a wallet browser should reopen */
  target: string;
  /** the `ref` every wallet universal link requires — our origin */
  ref: string;
}

const SOCIAL_LABEL = 'CONTINUE WITH GOOGLE / X / EMAIL';
const SOCIAL_SUB = 'A WALLET IS CREATED FOR YOU — NO SEED PHRASE';

/**
 * Installed before Loadable, then by name on mobile (the shipped behavior), or
 * by deliberate desktop support priority when requested. Stable on purpose:
 * wallets register asynchronously, so the same discovered set must always
 * settle into the same order regardless of announcement timing.
 */
export function orderInjected(
  wallets: { name: string; installed: boolean }[],
  preferDesktopWallets = false,
): { name: string }[] {
  return [...wallets]
    .sort((a, b) =>
      (Number(b.installed) - Number(a.installed)) ||
      (preferDesktopWallets ? walletPriority(a.name) - walletPriority(b.name) : 0) ||
      a.name.localeCompare(b.name))
    .map((w) => ({ name: w.name }));
}

/** Gold is an endorsement, not “first alphabetically”. Jupiter Extension is
 * recognized as a zero-SDK Wallet Standard wallet, but remains secondary until
 * a real extension proves SIWS + a devnet transaction end to end. */
const PREFERRED_WALLETS = ['phantom', 'solflare', 'backpack'] as const;

export function isJupiterExtension(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'jupiter' || normalized === 'jupiter wallet' || normalized === 'jupiter wallet extension';
}

function walletPriority(name: string): number {
  const normalized = walletDisplayName(name).trim().toLowerCase();
  const preferred = PREFERRED_WALLETS.indexOf(normalized as (typeof PREFERRED_WALLETS)[number]);
  if (preferred !== -1) return preferred;
  return isJupiterExtension(name) ? PREFERRED_WALLETS.length : PREFERRED_WALLETS.length + 1;
}

/** Adapter identity stays unique so WalletProvider cannot select Phantom's
 * Wallet Standard twin, while player-facing copy remains simply PHANTOM. */
export function walletDisplayName(name: string): string {
  return name.trim().toLowerCase() === 'phantom mobile' ? 'Phantom' : name;
}

function primaryWalletIndex(wallets: { name: string }[]): number {
  return wallets.findIndex((wallet) => walletPriority(wallet.name) < PREFERRED_WALLETS.length);
}

/** Phantom's own -32603 "Unexpected error" after the player already confirmed
 * (or before any dialog). The adapter retries once itself; this copy is the
 * second failure, so it names the two recoveries that are actually left. */
export const PHANTOM_INTERNAL_ERROR_COPY =
  'PHANTOM CONNECTION DID NOT COMPLETE — TAP CONNECT AGAIN, OR RELOAD';

/**
 * Copy for a failed connect. Shown inline under the row that failed — the sheet
 * stays open and every other route stays tappable, because a failure on one
 * wallet says nothing about the others.
 */
export function connectError(e: {
  walletName?: string | null | undefined;
  name?: string | undefined;
  message?: string | undefined;
}): string {
  const msg = e.message ?? '';
  if (/reject|denied|cancell?ed|user closed/i.test(msg)) return 'CONNECTION CANCELLED';
  if (e.name === 'WalletNotReadyError') return 'OPEN THE EXTENSION AND UNLOCK IT, THEN TRY AGAIN';
  if (walletDisplayName(e.walletName ?? '').trim().toLowerCase() === 'phantom' && /unexpected error/i.test(msg)) {
    return PHANTOM_INTERNAL_ERROR_COPY;
  }
  return msg ? msg.toUpperCase() : 'CONNECTION FAILED';
}

function storeOptions(i: ConnectInput): ConnectOption[] {
  return WALLET_KEYS.map((k) => ({
    kind: 'install' as const, label: `GET ${WALLET_LABEL[k]}`, href: storeLink(k, i.caps.platform),
  }));
}

function deeplinkOptions(i: ConnectInput): ConnectOption[] {
  return WALLET_KEYS.map((k) => ({
    kind: 'deeplink' as const,
    wallet: k,
    label: `OPEN IN ${WALLET_LABEL[k]}`,
    href: browseLink(k, i.target, i.ref),
    // Rendered permanently NEXT TO the row, before the tap: two of the three
    // wallets dead-end silently when they are not installed, so recovery after
    // the fact is not available to us.
    installLabel: `DON'T HAVE IT? GET ${WALLET_LABEL[k]}`,
    installHref: storeLink(k, i.caps.platform),
  }));
}

function socialGroup(i: ConnectInput, sub: boolean): SheetGroup[] {
  if (!i.privyEnabled) return [];
  return [{ heading: null, options: [{ kind: 'social', label: SOCIAL_LABEL, ...(sub ? { sub: SOCIAL_SUB } : {}) }] }];
}

function mobileModel(i: ConnectInput): SheetModel {
  const groups: SheetGroup[] = [];

  // A mobile browser cannot have an injected Solana provider unless it IS a
  // wallet's in-app browser — no per-wallet UA sniffing needed, and the adapter
  // self-labels so the button can say CONNECT PHANTOM rather than guess.
  const inWalletBrowser = i.injected.length > 0;
  if (inWalletBrowser) {
    groups.push({
      heading: null,
      options: i.injected.map((w, n) => ({
        kind: 'adapter' as const,
        walletName: w.name,
        label: `CONNECT ${walletDisplayName(w.name).toUpperCase()}`,
        primary: n === 0,
      })),
    });
  }

  // An injected adapter on mobile means we are already inside a wallet's
  // browser. Starting MWA there hands the request back out to Android and can
  // produce a second, unrelated wallet chooser; connect the injected wallet
  // directly instead. Deep links remain below as the recovery route for the
  // known Kiwi/extension false-positive.
  if (i.hasMwa && !inWalletBrowser) {
    groups.push({
      heading: null,
      options: [{ kind: 'mwa', label: 'CONNECT WALLET APP', sub: 'OPENS YOUR SOLANA WALLET' }],
    });
  }

  // ALWAYS present on mobile. MWA registration does not check whether any wallet
  // app is installed, so the MWA row above can still fail at connect time; and
  // the in-wallet-browser guess has one known false positive (Kiwi Browser on
  // Android, which runs Chrome extensions). Either way this group is the way out.
  const heading = inWalletBrowser ? 'MORE WAYS TO CONNECT' : i.hasMwa ? 'OR OPEN IN A WALLET APP' : 'OPEN IN A WALLET APP';
  if (i.caps.canDeepLink) {
    groups.push({ heading, options: deeplinkOptions(i), ...(inWalletBrowser ? { collapsed: true } : {}) });
  } else {
    // Dev/LAN build. Fail loud rather than emit a http://localhost deep link
    // that dies silently on the phone — but still hand over the store links, so
    // even this branch ends somewhere.
    groups.push({
      heading, options: storeOptions(i), danger: 'DEEP LINKS NEED A PUBLIC HTTPS URL (DEV BUILD)',
    });
  }

  // Social sits last everywhere EXCEPT an installed iOS Home Screen app, where
  // it is the only route that does not evict the player from the app they
  // installed — so there it leads, and the note above it says why.
  const social = socialGroup(i, !inWalletBrowser && !i.hasMwa);
  if (i.caps.isIOS && i.caps.isStandalone && !inWalletBrowser) groups.unshift(...social);
  else groups.push(...social);

  let note: string | null = null;
  if (i.mwaNotFound) note = 'NO WALLET APP ANSWERED — INSTALL ONE, OR OPEN THE GAME IN A WALLET BELOW';
  else if (i.caps.isAndroid && !i.caps.isSecureContext) note = 'WALLET APPS NEED HTTPS';
  // iOS, no injected provider. Say WHY before the tap, because the wallet-app
  // route genuinely relocates the player and a surprise relocation is the exact
  // thing the owner reported. Apple gives a wallet app no way to hand control
  // back to the browser tab it was called from, so every Solana dapp on iOS
  // ends up here; from an installed Home Screen app it is worse still (nothing
  // can re-enter an iOS standalone PWA), so there we lead with staying put.
  else if (i.caps.isIOS && !inWalletBrowser) {
    note = i.caps.isStandalone && i.privyEnabled
      ? 'A WALLET APP WOULD TAKE YOU OUT OF THE INSTALLED GAME — SIGNING IN BELOW KEEPS YOU HERE'
      : 'IOS KEEPS WALLET APPS OUT OF SAFARI AND CHROME — YOUR WALLET OPENS THE GAME IN ITS OWN BROWSER';
  }

  return { title: 'CONNECT A WALLET', note, groups };
}

function desktopModel(i: ConnectInput): SheetModel {
  if (i.injected.length > 0) {
    const tail: ConnectOption[] = [];
    const primary = primaryWalletIndex(i.injected);
    if (i.privyEnabled) tail.push({ kind: 'social', label: SOCIAL_LABEL });
    tail.push({ kind: 'install', label: 'GET PHANTOM', href: storeLink('phantom', 'desktop') });
    tail.push({ kind: 'install', label: 'GET SOLFLARE', href: storeLink('solflare', 'desktop') });
    if (!i.injected.some((wallet) => isJupiterExtension(wallet.name))) {
      tail.push({ kind: 'install', label: 'GET JUPITER EXTENSION', href: JUPITER_WALLET_URL });
    }
    return {
      title: 'CONNECT A WALLET',
      note: null,
      groups: [
        {
          heading: 'DETECTED',
          options: i.injected.map((w, n) => ({
            kind: 'adapter' as const,
            walletName: w.name,
            label: walletDisplayName(w.name).toUpperCase(),
            primary: n === primary,
            ...(isJupiterExtension(w.name) ? { sub: 'JUPITER EXTENSION · WALLET STANDARD' } : {}),
          })),
        },
        { heading: 'NO WALLET YET?', options: tail },
      ],
    };
  }
  return {
    title: 'CONNECT A WALLET',
    note: 'NO WALLET DETECTED IN THIS BROWSER',
    groups: [
      ...socialGroup(i, true),
      {
        heading: 'INSTALL A WALLET',
        options: [
          ...storeOptions(i),
          { kind: 'install', label: 'GET JUPITER EXTENSION', href: JUPITER_WALLET_URL },
        ],
        // Safari (and any other non-Chromium, non-Gecko desktop browser) has no
        // wallet extension to install, so without this line the three GET rows
        // are a closed loop: download page → nothing installable → back here.
        // Naming the browsers that DO work is the route out, and it is the only
        // one this branch has when Privy is off.
        ...(i.caps.canInstallExtension
          ? {}
          : { danger: 'WALLET EXTENSIONS NEED CHROME, BRAVE, EDGE OR FIREFOX — OPEN THE GAME THERE' }),
      },
      // Most extensions register without a reload, but this button removes the
      // "I installed it and nothing happened" dead end — install → refresh →
      // the DETECTED case.
      { heading: null, options: [{ kind: 'refresh', label: 'INSTALLED IT? REFRESH' }] },
    ],
  };
}

export function connectOptions(i: ConnectInput): SheetModel {
  return i.caps.platform === 'desktop' ? desktopModel(i) : mobileModel(i);
}
