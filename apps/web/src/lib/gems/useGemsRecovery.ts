import { mutationGate } from '../mutationGate';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp } from '../../state/store';
import { GemsController, type GemsState } from './controller';
import { GemsJournalStore } from './journal';
import { gemsIdentity, createGemsBrowserPorts, hydrateGemsDestination } from './browser';
const EMPTY: GemsState = { loaded: false, enabled: false, overview: null, busy: false, journal: null, review: null, error: null };
const emptySnapshot = (): GemsState => EMPTY;
const emptySubscribe = (): (() => void) => () => undefined;
export function useGemsRecovery(): { actionsAllowed: boolean; controller: GemsController | null; state: GemsState } {
  const wallet = useApp((s) => s.wallet); const authed = useApp((s) => s.authed);
  const base = useApp((s) => s.selectedBaseId); const selection = useApp((s) => s.baseSelectionEpoch);
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0, actionsEnabled: true };
    const store = new GemsJournalStore(gemsIdentity(wallet));
    const ports = createGemsBrowserPorts(store.identity, () => lifecycle, (intent, _receipt, guard) => hydrateGemsDestination(wallet, intent, guard));
    return { store, controller: new GemsController(store, ports), lifecycle };
  }, [wallet, authed]);
  const actionsAllowed = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  const controller = owned?.controller ?? null;
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.snapshot ?? emptySnapshot);
  useEffect(() => { owned?.controller.dismiss(); }, [owned, base, selection, actionsAllowed]);
  useEffect(() => {
    if (!owned) return;
    owned.lifecycle.active = true;
    const suspend = (): void => { owned.lifecycle.epoch++; owned.controller.dismiss(); };
    let waiting: (() => void) | null = null;
    const observe = (): void => {
      if (!owned.lifecycle.active || !owned.lifecycle.visible) return;
      if (!owned.controller.snapshot().busy) { void owned.controller.open(); return; }
      // StrictMode remount or foreground return may catch the previous view's
      // cancelled request finishing. Schedule one GET-only read after it exits.
      if (!waiting) waiting = owned.controller.subscribe(() => {
        if (owned.controller.snapshot().busy) return;
        waiting?.(); waiting = null; observe();
      });
    };
    const visibility = (): void => {
      owned.lifecycle.visible = document.visibilityState !== 'hidden';
      if (!owned.lifecycle.visible) suspend(); else observe();
    };
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend);
    window.addEventListener('pagehide', suspend); window.addEventListener('focus', observe); window.addEventListener('online', observe);
    observe();
    return () => {
      owned.lifecycle.active = false; waiting?.(); waiting = null; suspend();
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('freeze', suspend);
      window.removeEventListener('pagehide', suspend); window.removeEventListener('focus', observe); window.removeEventListener('online', observe);
      queueMicrotask(() => {
        if (owned.lifecycle.active) return;
        if (!owned.controller.snapshot().busy) { void owned.store.close().catch(() => undefined); return; }
        const stop = owned.controller.subscribe(() => {
          if (!owned.controller.snapshot().busy) { stop(); if (!owned.lifecycle.active) void owned.store.close().catch(() => undefined); }
        });
      });
    };
  }, [owned]);
  return { actionsAllowed, controller, state };
}
