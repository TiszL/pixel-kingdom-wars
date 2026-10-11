import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureDeepLinkFromUrl, parseDeepLinkScreen, setPendingDeepLink, takePendingDeepLink,
  takePendingDeepLinkOnBaseEntry,
} from './deepLink';

// D-101: the push url is the one input a push service steers, so it may only
// pick between the explicit safe screens, it is consumed exactly once, and it never lingers
// in the address bar where a reload or a shared link would replay it.

afterEach(() => { vi.unstubAllGlobals(); takePendingDeepLink(); });

describe('parseDeepLinkScreen', () => {
  it('whitelists raidlog, mail, base and the multi-base directory only', () => {
    expect(parseDeepLinkScreen('raidlog')).toBe('raidlog');
    expect(parseDeepLinkScreen('mail')).toBe('mail');
    expect(parseDeepLinkScreen('base')).toBe('base');
    expect(parseDeepLinkScreen('bases')).toBe('bases');
    for (const bad of ['withdraw', 'admin', 'security', 'RAIDLOG', '', null, undefined, 42, ['mail']]) {
      expect(parseDeepLinkScreen(bad)).toBeNull();
    }
  });
});

describe('captureDeepLinkFromUrl', () => {
  it('stashes the screen once, strips only that param and keeps the rest of the URL', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://play.pixelkingdomwars.com/?client=solana-mobile&screen=raidlog' },
      history: { replaceState },
    });
    expect(captureDeepLinkFromUrl()).toBe('raidlog');
    expect(replaceState).toHaveBeenCalledWith(null, '', 'https://play.pixelkingdomwars.com/?client=solana-mobile');
    expect(takePendingDeepLink()).toBe('raidlog');
    expect(takePendingDeepLink()).toBeNull(); // applied exactly once
  });

  it('ignores an unknown screen and leaves the URL alone', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('window', {
      location: { href: 'https://play.pixelkingdomwars.com/?screen=withdraw' },
      history: { replaceState },
    });
    expect(captureDeepLinkFromUrl()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
    expect(takePendingDeepLink()).toBeNull();
  });

  it('never throws when window is unavailable', () => {
    vi.stubGlobal('window', undefined);
    expect(captureDeepLinkFromUrl()).toBeNull();
  });
});

describe('takePendingDeepLink', () => {
  it('reports base as nothing to do: the caller is already there', () => {
    setPendingDeepLink('base');
    expect(takePendingDeepLink()).toBeNull();
    setPendingDeepLink('mail');
    expect(takePendingDeepLink()).toBe('mail');
  });

  it('waits for authoritative base entry, routes once, and never interrupts battle', () => {
    setPendingDeepLink('bases');
    expect(takePendingDeepLinkOnBaseEntry({
      hydrated: true, wasHydrated: true, screen: 'battle', previousScreen: 'base',
    })).toBeNull();
    expect(takePendingDeepLinkOnBaseEntry({
      hydrated: true, wasHydrated: true, screen: 'base', previousScreen: 'battle',
    })).toBe('bases');
    expect(takePendingDeepLinkOnBaseEntry({
      hydrated: true, wasHydrated: true, screen: 'base', previousScreen: 'battle',
    })).toBeNull();
  });

  it('handles hydration that commits after the screen already says base', () => {
    setPendingDeepLink('mail');
    expect(takePendingDeepLinkOnBaseEntry({
      hydrated: false, wasHydrated: false, screen: 'base', previousScreen: 'loading',
    })).toBeNull();
    expect(takePendingDeepLinkOnBaseEntry({
      hydrated: true, wasHydrated: false, screen: 'base', previousScreen: 'base',
    })).toBe('mail');
  });
});
