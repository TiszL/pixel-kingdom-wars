/**
 * `?screen=` deep link (D-101). A push notification opens the game at
 * `/?screen=raidlog|mail|base|bases`; the service worker sends the same screen as a
 * `{ type: 'open-screen', screen }` message when a window already exists.
 *
 * The target is held here until the base is hydrated and applied exactly once
 * at the setScreen('base') point — a menu screen over an unhydrated store is
 * a blank page. The whitelist is the whole security model: the URL is the one
 * input a push service controls, and it may only choose between these screens.
 */
const DEEP_LINK_SCREENS = ['raidlog', 'mail', 'base', 'bases'] as const;
export type DeepLinkScreen = (typeof DEEP_LINK_SCREENS)[number];

let pending: DeepLinkScreen | null = null;

export function parseDeepLinkScreen(value: unknown): DeepLinkScreen | null {
  return typeof value === 'string' && (DEEP_LINK_SCREENS as readonly string[]).includes(value)
    ? value as DeepLinkScreen : null;
}

/** Stash `?screen=` from the launch URL and strip it, so a reload or a shared
 * link does not reopen the raid log forever. Storage-free; boot never waits. */
export function captureDeepLinkFromUrl(): DeepLinkScreen | null {
  try {
    const url = new URL(window.location.href);
    const screen = parseDeepLinkScreen(url.searchParams.get('screen'));
    if (!screen) return null;
    pending = screen;
    url.searchParams.delete('screen');
    window.history.replaceState(null, '', url.toString());
    return screen;
  } catch { return null; }
}

export function setPendingDeepLink(screen: DeepLinkScreen): void {
  pending = screen;
}

/** Consume the pending target. Returns `null` for 'base' too: the caller is
 * already at the base, and a second setScreen would clear its selection. */
export function takePendingDeepLink(): Exclude<DeepLinkScreen, 'base'> | null {
  const screen = pending;
  pending = null;
  return screen && screen !== 'base' ? screen : null;
}

/** Consume only at the single safe routing seam: an authoritative base exists
 * and navigation has just entered it. This also handles the rare inverse order
 * (screen became `base` before hydration committed) without consuming while a
 * loading/title/battle screen is still responsible for the player. */
export function takePendingDeepLinkOnBaseEntry(state: {
  hydrated: boolean;
  wasHydrated: boolean;
  screen: string;
  previousScreen: string;
}): Exclude<DeepLinkScreen, 'base'> | null {
  if (!state.hydrated || state.screen !== 'base'
    || (state.wasHydrated && state.previousScreen === 'base')) return null;
  return takePendingDeepLink();
}
