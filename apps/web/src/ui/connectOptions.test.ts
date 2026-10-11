/**
 * The connect sheet's contract, case by case. The bug being fixed was a branch
 * that rendered an EMPTY list on iOS, so the load-bearing test here is the last
 * one: every reachable combination of device, wallet presence and Privy config
 * must produce at least one thing the player can actually do.
 *
 * The width tests exist because "narrow desktop window" is the case that tempts
 * every implementation into a media query, at which point a 380px browser window
 * starts offering mobile deep links that its OS cannot open.
 */
import { describe, expect, it } from 'vitest';
import { detectCaps, type Caps, type PlatformEnv } from '../lib/platform';
import {
  connectError, connectOptions, isJupiterExtension, orderInjected,
  type ConnectInput, type ConnectOption,
} from './connectOptions';

function capsFor(over: Partial<PlatformEnv>): Caps {
  return detectCaps({
    ua: '', maxTouchPoints: 0, matches: () => false, referrer: '',
    isSecureContext: true, protocol: 'https:', hostname: 'play.shardkeep.io',
    isIosStandalone: false,
    ...over,
  });
}
const touch = (q: string): boolean => q === '(pointer: coarse)' || q === '(hover: none)';

const DESKTOP = capsFor({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126' });
/** macOS Safari, maxTouchPoints 0 — a desktop where NO wallet extension exists. */
const DESKTOP_SAFARI = capsFor({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15' });
const UA_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari';
const IOS = capsFor({ ua: UA_IOS, maxTouchPoints: 5, matches: touch });
const ANDROID = capsFor({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile', maxTouchPoints: 5, matches: touch });
const ANDROID_DEV = capsFor({
  ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile', maxTouchPoints: 5, matches: touch,
  isSecureContext: false, protocol: 'http:', hostname: '192.168.1.20',
});

function input(over: Partial<ConnectInput>): ConnectInput {
  return {
    caps: DESKTOP, injected: [], hasMwa: false, privyEnabled: true, mwaNotFound: false,
    target: 'https://play.shardkeep.io/', ref: 'https://play.shardkeep.io',
    ...over,
  };
}
const all = (i: ConnectInput): ConnectOption[] => connectOptions(i).groups.flatMap((g) => g.options);
const kinds = (i: ConnectInput): string[] => all(i).map((o) => o.kind);

describe('case 1 — desktop with wallets installed', () => {
  const model = connectOptions(input({ caps: DESKTOP, injected: [{ name: 'Phantom' }, { name: 'Solflare' }] }));

  it('leads with a DETECTED group, one row per wallet, first one primary', () => {
    expect(model.note).toBeNull();
    expect(model.groups[0]?.heading).toBe('DETECTED');
    expect(model.groups[0]?.options).toEqual([
      { kind: 'adapter', walletName: 'Phantom', label: 'PHANTOM', primary: true },
      { kind: 'adapter', walletName: 'Solflare', label: 'SOLFLARE', primary: false },
    ]);
  });

  it('offers social + Phantom/Solflare/Jupiter installs underneath, and NO deep links (a desktop OS cannot open them)', () => {
    expect(model.groups[1]?.heading).toBe('NO WALLET YET?');
    expect(model.groups[1]?.options).toMatchObject([
      { kind: 'social' },
      { kind: 'install', label: 'GET PHANTOM' },
      { kind: 'install', label: 'GET SOLFLARE' },
      { kind: 'install', label: 'GET JUPITER EXTENSION', href: 'https://jup.ag/wallet' },
    ]);
    expect(kinds(input({ caps: DESKTOP, injected: [{ name: 'Phantom' }] }))).not.toContain('deeplink');
  });
});

describe('case 2 — desktop with no wallet', () => {
  const model = connectOptions(input({ caps: DESKTOP }));

  it('says so, then offers social, the three mobile-capable wallets, Jupiter Extension and a refresh', () => {
    expect(model.note).toBe('NO WALLET DETECTED IN THIS BROWSER');
    expect(kinds(input({ caps: DESKTOP }))).toEqual(['social', 'install', 'install', 'install', 'install', 'refresh']);
    expect(all(input({ caps: DESKTOP }))).toContainEqual({
      kind: 'install', label: 'GET JUPITER EXTENSION', href: 'https://jup.ag/wallet',
    });
  });

  it('keeps install + refresh when Privy is off — install → refresh → case 1 is still a real route', () => {
    const noPrivy = input({ caps: DESKTOP, privyEnabled: false });
    expect(kinds(noPrivy)).toEqual(['install', 'install', 'install', 'install', 'refresh']);
    expect(kinds(noPrivy)).not.toContain('social');
  });
});

describe('case 2b — desktop Safari, where the install links point at nothing installable', () => {
  it('names the browsers that DO run an extension, so the three GET rows stop being a closed loop', () => {
    const model = connectOptions(input({ caps: DESKTOP_SAFARI }));
    const install = model.groups.find((g) => g.heading === 'INSTALL A WALLET');
    expect(install?.danger).toBe('WALLET EXTENSIONS NEED CHROME, BRAVE, EDGE OR FIREFOX — OPEN THE GAME THERE');
    // ...and it is still a group with real options, never a bare explanation
    expect(install?.options.map((o) => o.kind)).toEqual(['install', 'install', 'install', 'install']);
  });

  it('still says it with Privy OFF — that build has no social row to rescue the branch', () => {
    const model = connectOptions(input({ caps: DESKTOP_SAFARI, privyEnabled: false }));
    expect(kinds(input({ caps: DESKTOP_SAFARI, privyEnabled: false }))).not.toContain('social');
    expect(model.groups.some((g) => g.danger != null)).toBe(true);
  });

  it('says nothing of the sort in Chrome — the warning is a browser fact, not decoration', () => {
    for (const g of connectOptions(input({ caps: DESKTOP })).groups) expect(g.danger).toBeUndefined();
    // and a Safari player who HAS a wallet (a future extension, or a Chromium
    // relaunch) is never lectured about the browser they are already using
    for (const g of connectOptions(input({ caps: DESKTOP_SAFARI, injected: [{ name: 'Phantom' }] })).groups) {
      expect(g.danger).toBeUndefined();
    }
  });
});

describe('case 3 — a narrow desktop window is still a desktop', () => {
  it('produces a byte-identical model whatever the viewport claims to be', () => {
    // The model cannot see width by construction: neither Caps nor ConnectInput
    // carries one. Mutating the global viewport must therefore change nothing.
    const i = input({ caps: DESKTOP, injected: [{ name: 'Phantom' }] });
    const wide = JSON.stringify(connectOptions(i));
    (globalThis as { innerWidth?: number }).innerWidth = 380;
    (globalThis as { innerHeight?: number }).innerHeight = 700;
    expect(JSON.stringify(connectOptions(i))).toBe(wide);
  });
});

describe('case 4 — Android Chrome with a wallet app', () => {
  const model = connectOptions(input({ caps: ANDROID, hasMwa: true }));

  it('leads with the MWA row', () => {
    expect(model.groups[0]?.options[0]).toEqual({
      kind: 'mwa', label: 'CONNECT WALLET APP', sub: 'OPENS YOUR SOLANA WALLET',
    });
  });

  it('ALWAYS renders the deep links underneath, expanded — MWA registers whether or not any wallet is installed', () => {
    const links = model.groups[1];
    expect(links?.heading).toBe('OR OPEN IN A WALLET APP');
    expect(links?.collapsed).toBeUndefined();
    expect(links?.options.map((o) => o.kind)).toEqual(['deeplink', 'deeplink', 'deeplink']);
  });

  it('pairs every deep link with a visible install link — Phantom and Backpack dead-end silently when missing', () => {
    for (const o of model.groups[1]?.options ?? []) {
      expect(o.kind).toBe('deeplink');
      if (o.kind !== 'deeplink') continue;
      expect(o.href).toContain('/ul/');
      expect(o.installHref).toContain('play.google.com');
    }
  });

  it('puts social last', () => {
    expect(kinds(input({ caps: ANDROID, hasMwa: true })).at(-1)).toBe('social');
  });
});

describe('case 5 — Android Chrome with no wallet app', () => {
  it('renders identically before the attempt (we cannot know until connect time)', () => {
    const before = connectOptions(input({ caps: ANDROID, hasMwa: true }));
    const after = connectOptions(input({ caps: ANDROID, hasMwa: true, mwaNotFound: true }));
    expect(after.groups).toEqual(before.groups);
  });

  it('answers a failed handoff with a note, not with the library\'s own dead-end modal', () => {
    const model = connectOptions(input({ caps: ANDROID, hasMwa: true, mwaNotFound: true }));
    expect(model.note).toBe('NO WALLET APP ANSWERED — INSTALL ONE, OR OPEN THE GAME IN A WALLET BELOW');
    // and the routes out are still on screen
    expect(kinds(input({ caps: ANDROID, hasMwa: true, mwaNotFound: true }))).toContain('deeplink');
  });
});

describe('iOS — the case that was a dead end', () => {
  const model = connectOptions(input({ caps: IOS }));

  it('never claims MWA or an extension: it offers the deep links, which are the only route', () => {
    expect(kinds(input({ caps: IOS }))).toEqual(['deeplink', 'deeplink', 'deeplink', 'social']);
    // The note must state the CONSEQUENCE (the wallet opens the game in its own
    // browser) before the tap. Saying only "cannot reach a wallet directly" left
    // the relocation as a surprise, which is what the owner hit on 2026-08-07.
    expect(model.note).toBe('IOS KEEPS WALLET APPS OUT OF SAFARI AND CHROME — YOUR WALLET OPENS THE GAME IN ITS OWN BROWSER');
    expect(model.groups[0]?.heading).toBe('OPEN IN A WALLET APP');
  });

  it('an installed Home Screen app is told the wallet route leaves it, and offered the one that does not', () => {
    // Nothing can re-enter an iOS standalone PWA from another app, so a player
    // who installed the game must know before tapping — and must see the
    // stay-here route. Privy off: no such route exists, so no such promise.
    const pwa = connectOptions(input({ caps: capsFor({ ua: UA_IOS, maxTouchPoints: 5, matches: touch, isIosStandalone: true }) }));
    expect(pwa.note).toBe('A WALLET APP WOULD TAKE YOU OUT OF THE INSTALLED GAME — SIGNING IN BELOW KEEPS YOU HERE');
    // and it LEADS — a note promising "keeps you here" above a row buried
    // under three wallet apps is a promise the layout breaks.
    expect(kinds(input({ caps: capsFor({ ua: UA_IOS, maxTouchPoints: 5, matches: touch, isIosStandalone: true }) }))[0]).toBe('social');
    // a browser tab on the same phone keeps the old order (nothing to evict)
    expect(kinds(input({ caps: IOS }))[0]).toBe('deeplink');
    const pwaNoPrivy = connectOptions(input({
      caps: capsFor({ ua: UA_IOS, maxTouchPoints: 5, matches: touch, isIosStandalone: true }), privyEnabled: false,
    }));
    expect(pwaNoPrivy.note).not.toContain('KEEPS YOU HERE');
    expect(pwaNoPrivy.groups.some((g) => g.options.length > 0)).toBe(true);
  });

  it('sends iOS installs to the App Store, not to Google Play', () => {
    for (const o of model.groups[0]?.options ?? []) {
      if (o.kind !== 'deeplink') continue;
      expect(o.installHref).not.toContain('play.google.com');
    }
  });

  it('still has three real routes with Privy off', () => {
    expect(kinds(input({ caps: IOS, privyEnabled: false }))).toEqual(['deeplink', 'deeplink', 'deeplink']);
  });
});

describe('inside a wallet\'s in-app browser (mobile + an injected provider)', () => {
  const model = connectOptions(input({ caps: IOS, injected: [{ name: 'Phantom' }], hasMwa: true }));

  it('leads with the self-labelled wallet — no per-wallet UA sniffing needed', () => {
    expect(model.groups[0]?.options[0]).toEqual({
      kind: 'adapter', walletName: 'Phantom', label: 'CONNECT PHANTOM', primary: true,
    });
  });

  it('keeps the deep links behind a collapsed disclosure — the Kiwi Browser false positive needs a way out', () => {
    const links = model.groups[1];
    expect(links?.heading).toBe('MORE WAYS TO CONNECT');
    expect(links?.collapsed).toBe(true);
    expect(links?.options).toHaveLength(3);
  });

  it('suppresses MWA because the injected wallet is already the correct in-browser connection', () => {
    expect(model.groups.flatMap((group) => group.options).map((option) => option.kind))
      .not.toContain('mwa');
  });

  it('does the same in Phantom\'s Android browser even when MWA registered globally', () => {
    const android = connectOptions(input({
      caps: ANDROID, injected: [{ name: 'Phantom' }], hasMwa: true,
    }));
    expect(android.groups[0]?.options[0]).toMatchObject({
      kind: 'adapter', walletName: 'Phantom', label: 'CONNECT PHANTOM',
    });
    expect(android.groups.flatMap((group) => group.options).some((option) => option.kind === 'mwa'))
      .toBe(false);
  });

  it('keeps the direct adapter identity internal while presenting CONNECT PHANTOM', () => {
    const direct = connectOptions(input({
      caps: ANDROID, injected: [{ name: 'Phantom Mobile' }], hasMwa: true,
    }));
    expect(direct.groups[0]?.options[0]).toEqual({
      kind: 'adapter', walletName: 'Phantom Mobile', label: 'CONNECT PHANTOM', primary: true,
    });
  });
});

describe('dev / LAN build — fail loud, never emit a link that dies on the phone', () => {
  const model = connectOptions(input({ caps: ANDROID_DEV, hasMwa: false }));

  it('says why instead of rendering an unreachable http deep link', () => {
    expect(model.groups[0]?.danger).toBe('DEEP LINKS NEED A PUBLIC HTTPS URL (DEV BUILD)');
    expect(kinds(input({ caps: ANDROID_DEV }))).not.toContain('deeplink');
  });

  it('still hands over the store links, so even the dev branch ends somewhere', () => {
    expect(model.groups[0]?.options.map((o) => o.kind)).toEqual(['install', 'install', 'install']);
  });
});

describe('the invariant: no branch may render an empty list', () => {
  it('offers at least one action for every device × wallet × Privy combination', () => {
    for (const caps of [DESKTOP, DESKTOP_SAFARI, IOS, ANDROID, ANDROID_DEV]) {
      for (const injected of [[], [{ name: 'Phantom' }]]) {
        for (const hasMwa of [false, true]) {
          for (const privyEnabled of [false, true]) {
            for (const mwaNotFound of [false, true]) {
              const i = input({ caps, injected, hasMwa, privyEnabled, mwaNotFound });
              const model = connectOptions(i);
              expect(all(i).length, JSON.stringify({ caps: caps.platform, injected, hasMwa, privyEnabled })).toBeGreaterThan(0);
              // and no group is a heading with nothing under it
              for (const g of model.groups) expect(g.options.length).toBeGreaterThan(0);
            }
          }
        }
      }
    }
  });
});

describe('orderInjected — deterministic discovery and deliberate priority', () => {
  it('sorts Installed before Loadable, then Phantom → Solflare → Backpack', () => {
    expect(orderInjected([
      { name: 'Solflare', installed: false },
      { name: 'Phantom', installed: false },
      { name: 'Backpack', installed: true },
    ])).toEqual([{ name: 'Backpack' }, { name: 'Phantom' }, { name: 'Solflare' }]);
  });

  it('settles to the same order for every asynchronous registration permutation', () => {
    const expected = [{ name: 'Phantom' }, { name: 'Solflare' }, { name: 'Backpack' }, { name: 'Jupiter Wallet' }, { name: 'MetaMask' }];
    const names = ['MetaMask', 'Jupiter Wallet', 'Backpack', 'Solflare', 'Phantom'];
    for (let shift = 0; shift < names.length; shift++) {
      const registrationOrder = [...names.slice(shift), ...names.slice(0, shift)];
      expect(orderInjected(
        registrationOrder.map((name) => ({ name, installed: true })), true,
      )).toEqual(expected);
    }
  });

  it('preserves unknown Wallet Standard wallets but never promotes them merely for being first or alone', () => {
    const injected = orderInjected([
      { name: 'Glow', installed: true },
      { name: 'MetaMask', installed: true },
    ]);
    const options = connectOptions(input({ injected })).groups[0]?.options ?? [];
    expect(options.map((option) => option.kind === 'adapter' ? option.walletName : null)).toEqual(['Glow', 'MetaMask']);
    expect(options.every((option) => option.kind !== 'adapter' || option.primary === false)).toBe(true);
  });

  it('gold-highlights the best supported wallet, never alphabetical MetaMask', () => {
    const permutations = [
      ['MetaMask', 'Solflare', 'Phantom'],
      ['Phantom', 'MetaMask', 'Solflare'],
      ['Solflare', 'Phantom', 'MetaMask'],
    ];
    for (const names of permutations) {
      const injected = orderInjected(names.map((name) => ({ name, installed: true })), true);
      const adapters = connectOptions(input({ injected })).groups[0]?.options.filter((o) => o.kind === 'adapter') ?? [];
      expect(adapters.map((o) => o.walletName)).toEqual(['Phantom', 'Solflare', 'MetaMask']);
      expect(adapters.filter((o) => o.primary).map((o) => o.walletName)).toEqual(['Phantom']);
    }

    const onlyMetaMask = connectOptions(input({ injected: [{ name: 'MetaMask' }] })).groups[0]?.options[0];
    expect(onlyMetaMask).toMatchObject({ kind: 'adapter', walletName: 'MetaMask', primary: false });
  });

  it('recognizes Jupiter Extension through Wallet Standard but keeps it secondary pending devnet proof', () => {
    expect(isJupiterExtension('Jupiter')).toBe(true);
    expect(isJupiterExtension('Jupiter Wallet')).toBe(true);
    expect(isJupiterExtension('Jupiter Wallet Extension')).toBe(true);
    expect(isJupiterExtension('MetaMask')).toBe(false);

    const injected = orderInjected([
      { name: 'MetaMask', installed: true },
      { name: 'Jupiter Wallet', installed: true },
    ], true);
    const adapters = connectOptions(input({ injected })).groups[0]?.options.filter((o) => o.kind === 'adapter') ?? [];
    expect(adapters).toEqual([
      {
        kind: 'adapter', walletName: 'Jupiter Wallet', label: 'JUPITER WALLET', primary: false,
        sub: 'JUPITER EXTENSION · WALLET STANDARD',
      },
      { kind: 'adapter', walletName: 'MetaMask', label: 'METAMASK', primary: false },
    ]);
    const installs = connectOptions(input({ injected })).groups[1]?.options ?? [];
    expect(installs).not.toContainEqual(expect.objectContaining({ label: 'GET JUPITER EXTENSION' }));
  });

  it('preserves the shipped mobile in-wallet ordering and first-row CTA', () => {
    const injected = orderInjected([
      { name: 'MetaMask', installed: true },
      { name: 'Jupiter Wallet', installed: true },
    ]); // mobile/default: installed then alphabetical, no desktop endorsement sort
    const mobile = connectOptions(input({ caps: ANDROID, injected, hasMwa: false }));
    const adapters = mobile.groups.flatMap((group) => group.options)
      .filter((option) => option.kind === 'adapter');
    expect(adapters.map((option) => option.walletName)).toEqual(['Jupiter Wallet', 'MetaMask']);
    expect(adapters.filter((option) => option.primary).map((option) => option.walletName))
      .toEqual(['Jupiter Wallet']);
  });
});

describe('connectError — a failed row explains itself and leaves the other routes usable', () => {
  it('reads a user rejection as a cancellation, not as an error to fix', () => {
    expect(connectError({ name: 'WalletConnectionError', message: 'User rejected the request.' }))
      .toBe('CONNECTION CANCELLED');
  });

  it('tells a locked extension what to do', () => {
    expect(connectError({ name: 'WalletNotReadyError', message: 'not ready' }))
      .toBe('OPEN THE EXTENSION AND UNLOCK IT, THEN TRY AGAIN');
  });

  it('turns Phantom\'s raw failure into accurate retry guidance', () => {
    expect(connectError({ walletName: 'Phantom', name: 'WalletConnectionError', message: 'Unexpected error' }))
      .toBe('PHANTOM CONNECTION DID NOT COMPLETE — TAP CONNECT AGAIN, OR RELOAD');
    expect(connectError({ walletName: 'Phantom Mobile', name: 'WalletConnectionError', message: 'Unexpected error' }))
      .toBe('PHANTOM CONNECTION DID NOT COMPLETE — TAP CONNECT AGAIN, OR RELOAD');
    expect(connectError({ walletName: 'Solflare', name: 'WalletConnectionError', message: 'Unexpected error' }))
      .toBe('UNEXPECTED ERROR');
  });

  it('never renders an empty line — an unlabelled failure looks like a frozen button', () => {
    expect(connectError({ name: 'Error', message: 'boom' })).toBe('BOOM');
    expect(connectError({})).toBe('CONNECTION FAILED');
  });
});
