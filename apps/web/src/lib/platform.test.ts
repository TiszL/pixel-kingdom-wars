/**
 * Device detection is what decides whether a player is offered an extension, a
 * Mobile Wallet Adapter handoff or a universal link — get it wrong and the
 * player gets a sheet full of routes their device cannot take. Each case below
 * pins a device that HAS burned this kind of code:
 *
 *  - iPadOS 13+ reports a Macintosh UA and is the single most common way "iOS"
 *    detection silently misses an iPad;
 *  - a touchscreen laptop is `pointer: fine` + `any-pointer: coarse`, so reading
 *    any-pointer turns every Surface into a phone;
 *  - Phantom's Android in-app browser is a WebView where MWA does NOT register
 *    but an injected provider does — the opposite of Android Chrome;
 *  - a dev/LAN build cannot deep-link at all, and emitting the link anyway dies
 *    silently on the phone instead of erroring.
 *
 * The last test is a source guard rather than a behaviour test on purpose: the
 * one rule that cannot be expressed as an assertion on detectCaps() is that
 * width must never enter the module in the first place.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectCaps, isPublicHttps, signInClient, type PlatformEnv } from './platform';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  phantomAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 Phantom/25.10.0',
  seeker: 'Mozilla/5.0 (Linux; Android 15; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 Solana Mobile Web Shell/1.0',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
};

const TOUCH = ['(pointer: coarse)', '(hover: none)'];

function env(over: Partial<PlatformEnv>): PlatformEnv {
  return {
    ua: UA.windows, maxTouchPoints: 0, matches: () => false, referrer: '',
    isSecureContext: true, protocol: 'https:', hostname: 'play.shardkeep.io',
    isIosStandalone: false,
    ...over,
  };
}
/** a real touch device: coarse pointer AND no hover */
const touch = (qs: string[] = TOUCH) => (q: string): boolean => qs.includes(q);

describe('platform classification', () => {
  it('classifies an iPhone as ios/touch', () => {
    const c = detectCaps(env({ ua: UA.iphone, maxTouchPoints: 5, matches: touch() }));
    expect(c.platform).toBe('ios');
    expect(c.isIOS).toBe(true);
    expect(c.isAndroid).toBe(false);
    expect(c.isTouchPrimary).toBe(true);
  });

  it('classifies iPadOS 13+ as ios despite its Macintosh UA (maxTouchPoints is the only tell)', () => {
    const ipad = detectCaps(env({ ua: UA.ipadOS, maxTouchPoints: 5, matches: touch() }));
    expect(ipad.platform).toBe('ios');
    expect(ipad.isIOS).toBe(true);
  });

  it('does NOT mistake a real Mac for an iPad — a Mac reports maxTouchPoints 0', () => {
    const mac = detectCaps(env({ ua: UA.mac, maxTouchPoints: 0 }));
    expect(mac.platform).toBe('desktop');
    expect(mac.isIOS).toBe(false);
  });

  it('classifies Android Chrome, and Phantom\'s Android WebView, as android', () => {
    expect(detectCaps(env({ ua: UA.androidChrome, maxTouchPoints: 5, matches: touch() })).platform).toBe('android');
    expect(detectCaps(env({ ua: UA.phantomAndroid, maxTouchPoints: 5, matches: touch() })).platform).toBe('android');
  });

  it('flags the Solana Mobile Web Shell (Seeker) — the one WebView MWA still registers in', () => {
    const c = detectCaps(env({ ua: UA.seeker, maxTouchPoints: 5, matches: touch() }));
    expect(c.isSolanaMobileShell).toBe(true);
    expect(c.platform).toBe('android');
    expect(detectCaps(env({ ua: UA.androidChrome })).isSolanaMobileShell).toBe(false);
  });

  it('classifies desktop Windows/Chrome as desktop', () => {
    expect(detectCaps(env({ ua: UA.windows })).platform).toBe('desktop');
  });
});

describe('isTouchPrimary needs BOTH signals — a touchscreen laptop is not a phone', () => {
  it('is false when the pointer is fine even though a coarse pointer also exists', () => {
    // The exact Surface/XPS profile: (pointer: fine) + (any-pointer: coarse).
    // any-pointer is never queried, so it cannot flip this.
    const c = detectCaps(env({ ua: UA.windows, maxTouchPoints: 10, matches: touch(['(any-pointer: coarse)']) }));
    expect(c.isTouchPrimary).toBe(false);
  });

  it('is false when hover exists (a phone never hovers)', () => {
    expect(detectCaps(env({ matches: touch(['(pointer: coarse)']) })).isTouchPrimary).toBe(false);
  });
});

describe('isTwa — launched as an app rather than a tab', () => {
  it('reads the android-app:// referrer a TWA launch carries', () => {
    expect(detectCaps(env({ referrer: 'android-app://com.shardkeep.twa' })).isTwa).toBe(true);
  });
  it('reads display-mode: standalone for an installed PWA', () => {
    expect(detectCaps(env({ matches: touch(['(display-mode: standalone)']) })).isTwa).toBe(true);
  });
  it('is false for a plain browser tab, referrer or not', () => {
    expect(detectCaps(env({ referrer: 'https://google.com/' })).isTwa).toBe(false);
  });
});

describe('canDeepLink — a wallet app fetches the target over the PUBLIC internet', () => {
  it('accepts a public https origin', () => {
    expect(isPublicHttps('https:', 'play.shardkeep.io')).toBe(true);
  });

  it('rejects the dev/LAN origins whose deep links die silently on the phone', () => {
    expect(isPublicHttps('http:', 'play.shardkeep.io')).toBe(false); // http is never reachable as a universal link
    expect(isPublicHttps('https:', 'localhost')).toBe(false);
    expect(isPublicHttps('https:', '127.0.0.1')).toBe(false);
    expect(isPublicHttps('https:', '0.0.0.0')).toBe(false);
    expect(isPublicHttps('https:', '[::1]')).toBe(false);
  });

  it('does not reject a legitimate host that merely starts with a matching word', () => {
    expect(isPublicHttps('https:', 'localhost.shardkeep.io')).toBe(true);
  });

  it('surfaces on caps so the sheet can say so instead of emitting a dead link', () => {
    expect(detectCaps(env({ protocol: 'http:', hostname: '192.168.1.20' })).canDeepLink).toBe(false);
  });
});

describe('canInstallExtension — "GET PHANTOM" must not be the only route in a browser that cannot run it', () => {
  it('is false on desktop Safari: no Solana wallet ships a Safari build, so the download page is a closed loop', () => {
    // A Mac WITHOUT touch points — the iPadOS test above shares this UA, and the
    // two must not be confused: an iPad is mobile, this is the dead-end desktop.
    const c = detectCaps(env({ ua: UA.macSafari, maxTouchPoints: 0 }));
    expect(c.platform).toBe('desktop');
    expect(c.canInstallExtension).toBe(false);
  });

  it('is true wherever an extension really installs — Chromium (incl. Edge/Brave/Arc, which all carry Chrome/) and Gecko', () => {
    expect(detectCaps(env({ ua: UA.windows })).canInstallExtension).toBe(true);
    expect(detectCaps(env({ ua: UA.mac })).canInstallExtension).toBe(true);
    expect(detectCaps(env({ ua: UA.edge })).canInstallExtension).toBe(true);
    expect(detectCaps(env({ ua: UA.macFirefox })).canInstallExtension).toBe(true);
  });

  it('is false on mobile even in Chrome — an extension is not a route a phone can take', () => {
    expect(detectCaps(env({ ua: UA.androidChrome, maxTouchPoints: 5, matches: touch() })).canInstallExtension).toBe(false);
    expect(detectCaps(env({ ua: UA.iphone, maxTouchPoints: 5, matches: touch() })).canInstallExtension).toBe(false);
    // iPadOS ships the same UA as macSafari; maxTouchPoints keeps it mobile.
    expect(detectCaps(env({ ua: UA.ipadOS, maxTouchPoints: 5, matches: touch() })).canInstallExtension).toBe(false);
  });
});

describe('the module may never consult viewport width', () => {
  it('contains no width/height/any-pointer/userAgentData reference', () => {
    const src = readFileSync(new URL('./platform.ts', import.meta.url), 'utf8');
    // Comments talk about innerWidth by name (that is the rule being stated), so
    // strip them before asserting on the code itself.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/innerWidth|innerHeight|any-pointer|userAgentData/);
  });
});

describe('signInClient — the session label behind the Solana Mobile / browser statistics split (D-103)', () => {
  it('is browser in node, where there is no window to carry a shell marker', () => {
    // WHY: the label is read at call time from the start URL, the persisted
    // marker or the shell UA. With no window at all the only honest answer is
    // browser — never a guess, because the public cohort counts rest on it.
    expect(signInClient()).toBe('browser');
  });
});
