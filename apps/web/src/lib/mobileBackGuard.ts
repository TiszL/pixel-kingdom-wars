/**
 * Android Back guard for the installed Solana-Mobile TWA (D-102).
 *
 * A TWA exposes Android's edge gesture as browser Back. CSS cannot cancel it,
 * and Chromium ignores history entries created before a trusted activation.
 * We therefore add exactly one same-URL sentinel after the first real pointer
 * or key event. Popping it delegates to the top in-game handler, then replaces
 * the forward sentinel rather than growing the history stack.
 */
import { MOBILE_BACK } from '@shardkeep/shared';
import { useEffect, useRef } from 'react';
import { bus } from './events';
import { isSolanaMobileClient } from './mobileShell';
import { caps } from './platform';
import { useApp } from '../state/store';

const STATE_KEY = '__pkwMobileBack';
const STATE_VALUE = 1;

export type MobileBackHandler = () => boolean | void;

interface RegisteredHandler {
  priority: number;
  sequence: number;
  callback: MobileBackHandler;
}

const handlers = new Map<symbol, RegisteredHandler>();
let handlerSequence = 0;

/** Register one mounted in-game surface. Returning false declines ownership;
 * void/true means the surface performed its normal Back action. */
export function registerMobileBackHandler(
  callback: MobileBackHandler,
  priority = 100,
): () => void {
  const id = Symbol('mobile-back-handler');
  handlers.set(id, { priority, sequence: ++handlerSequence, callback });
  return () => { handlers.delete(id); };
}

/** React wrapper whose registration stays mounted while its callback observes
 * current local state. Mobile Back and the desktop Escape bridge share it. */
export function useMobileBackHandler(
  callback: MobileBackHandler,
  enabled = true,
  priority = 100,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  useEffect(() => {
    if (!enabled) return undefined;
    return registerMobileBackHandler(() => callbackRef.current(), priority);
  }, [enabled, priority]);
}

function topHandler(): MobileBackHandler | null {
  let selected: RegisteredHandler | null = null;
  for (const candidate of handlers.values()) {
    if (!selected || candidate.priority > selected.priority
      || (candidate.priority === selected.priority && candidate.sequence > selected.sequence)) {
      selected = candidate;
    }
  }
  return selected?.callback ?? null;
}

/** One host-level Escape listener uses the same priority/sequence owner as
 * Android Back. Local handlers can consume Escape before it reaches here. */
export function installOverlayEscapeBridge(win: Window): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.repeat) return;
    const handler = topHandler();
    if (!handler || handler() === false) return;
    event.preventDefault();
    event.stopPropagation();
  };
  win.addEventListener('keydown', onKeyDown);
  return () => win.removeEventListener('keydown', onKeyDown);
}

export interface MobileBackHistory {
  readonly state: unknown;
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  back(): void;
}

export interface MobileBackWindow {
  readonly location: { href: string };
  readonly history: MobileBackHistory;
  addEventListener(type: 'pointerdown' | 'keydown' | 'popstate', listener: EventListener): void;
  removeEventListener(type: 'pointerdown' | 'keydown' | 'popstate', listener: EventListener): void;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(id: number): void;
}

export interface MobileBackGuardOptions {
  win: MobileBackWindow;
  enabled: boolean;
  now?: () => number;
  /** Browser events must be trusted. Tests inject an explicit predicate. */
  trustedActivation?: (event: Event) => boolean;
  getScreen: () => string;
  goToBase: () => void;
  toast: (message: string) => void;
  getHandler?: () => MobileBackHandler | null;
}

function hasSentinel(state: unknown): boolean {
  return !!state && typeof state === 'object'
    && (state as Record<string, unknown>)[STATE_KEY] === STATE_VALUE;
}

function stateWithSentinel(state: unknown): Record<string, unknown> {
  const base = state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown> : {};
  return { ...base, [STATE_KEY]: STATE_VALUE };
}

/** Low-level controller exported for deterministic history tests. */
export function createMobileBackGuard(options: MobileBackGuardOptions): () => void {
  if (!options.enabled) return () => undefined;
  const now = options.now ?? Date.now;
  const trusted = options.trustedActivation ?? ((event: Event) => event.isTrusted);
  let activated = hasSentinel(options.win.history.state);
  let bypassNextPop = false;
  let exitReadyUntil = 0;
  let exitTimer: number | null = null;

  const clearExitReady = (): void => {
    exitReadyUntil = 0;
    if (exitTimer !== null) options.win.clearTimeout(exitTimer);
    exitTimer = null;
  };

  const armSentinel = (): void => {
    if (!activated || hasSentinel(options.win.history.state)) return;
    try {
      options.win.history.pushState(
        stateWithSentinel(options.win.history.state), '', options.win.location.href,
      );
    } catch {
      // A denied history mutation means this browser cannot be guarded. The
      // game remains usable and Android retains its native Back behavior.
    }
  };

  const onActivation: EventListener = (event): void => {
    if (!trusted(event)) return;
    // At the root of a TWA history.back() may minimize without a popstate.
    // A later trusted interaction starts a new guarded interaction cycle;
    // otherwise that stale bypass would swallow the next real Back forever.
    bypassNextPop = false;
    if (exitReadyUntil > 0) clearExitReady();
    activated = true;
    armSentinel();
  };

  const leaveTwa = (): void => {
    clearExitReady();
    // The pop following history.back() passes through untouched so the second
    // Android Back reaches the host task/minimizes the installed TWA.
    bypassNextPop = true;
    options.win.history.back();
  };

  const onPopState: EventListener = (): void => {
    if (bypassNextPop) {
      bypassNextPop = false;
      return;
    }
    if (!activated) return;

    const handler = options.getHandler?.() ?? topHandler();
    if (handler && handler() !== false) {
      clearExitReady();
      armSentinel();
      return;
    }

    const screen = options.getScreen();
    if (screen === 'base') {
      const timestamp = now();
      if (exitReadyUntil > timestamp) {
        leaveTwa();
        return;
      }
      exitReadyUntil = timestamp + MOBILE_BACK.exitConfirmMs;
      options.toast('BACK AGAIN TO EXIT');
      armSentinel();
      exitTimer = options.win.setTimeout(clearExitReady, MOBILE_BACK.exitConfirmMs);
      return;
    }

    // Title/auth/entry carry no hydrated game state. Every in-game screen gets
    // a safe base fallback if its own mounted surface failed to register.
    if (screen === 'loading' || screen === 'title' || screen === 'entry' || screen === 'alphagate') {
      leaveTwa();
      return;
    }
    options.goToBase();
    clearExitReady();
    armSentinel();
  };

  options.win.addEventListener('pointerdown', onActivation);
  options.win.addEventListener('keydown', onActivation);
  options.win.addEventListener('popstate', onPopState);
  // BFCache may restore a page whose activated sentinel is already current.
  armSentinel();

  return () => {
    options.win.removeEventListener('pointerdown', onActivation);
    options.win.removeEventListener('keydown', onActivation);
    options.win.removeEventListener('popstate', onPopState);
    clearExitReady();
  };
}

/** Solana marker + Android installed-app capability leaves normal tabs and
 * non-Android PWAs entirely untouched. */
export function installMobileBackGuard(): () => void {
  const enabled = caps.isAndroid && caps.isTwa && (() => {
    try { return isSolanaMobileClient(); } catch { return false; }
  })();
  return createMobileBackGuard({
    win: window as unknown as MobileBackWindow,
    enabled,
    getScreen: () => useApp.getState().screen,
    goToBase: () => useApp.getState().setScreen('base'),
    toast: (msg) => bus.emit('ui:toast', { msg }),
  });
}
