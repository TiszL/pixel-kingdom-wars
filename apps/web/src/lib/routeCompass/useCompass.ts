import type {EquipmentFitting} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { createCompassBrowserPorts, browserCompassIdentity } from './browser';
import { CompassController, EMPTY } from './controller';
import { CompassJournalStore } from './journal';

const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useCompass(actionsEnabled: boolean) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), screen = useApp(s => s.screen), selection = useApp(s => s.baseSelectionEpoch);
  const gate = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot), actionsAllowed = actionsEnabled && gate;
  const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
  const [working, setWorking] = useState<object | null>(null);
  const [ready, setReady] = useState<CompassController | null>(null);
  // Construct the lifetime descriptor without opening storage during render.
  // StrictMode's effect replay reuses it before the deferred close can run.
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const owner = {};
    const lifecycle = { active: false, visible: document.visibilityState !== 'hidden', epoch: 0 };
    let store: CompassJournalStore | null = null, controller: CompassController | null = null;
    let pending = 0, refresh = false, closed = false;
    const closeIfIdle = () => queueMicrotask(() => {
      if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store?.close().catch(() => undefined); }
    });
    const invoke = (action: (c: CompassController) => Promise<unknown>) => {
      if (!controller || closed || !lifecycle.active || !lifecycle.visible) return;
      if (pending) { refresh = true; return; }
      pending++; setWorking(owner);
      void Promise.resolve().then(()=>action(controller!)).catch(() => undefined).finally(() => {
        pending--;
        if (!pending && refresh && lifecycle.active && lifecycle.visible) { refresh = false; invoke(c => c.load(useApp.getState().selectedBaseId??undefined)); }
        else if (lifecycle.active) setWorking(previous => previous === owner ? null : previous);
        closeIfIdle();
      });
    };
    const observe = () => { if (!lifecycle.active || !lifecycle.visible || closed) return; if (pending) refresh = true; else invoke(c => c.load(useApp.getState().selectedBaseId??undefined)); };
    const start = () => {
      lifecycle.active = true; lifecycle.visible = document.visibilityState !== 'hidden';
      if (!controller) {
        store = new CompassJournalStore(browserCompassIdentity(wallet), globalThis.indexedDB, 'pkw-route-compass-v1');
        controller = new CompassController(store, createCompassBrowserPorts({ identity: store.identity, lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current,
            active: lifecycle.active && useApp.getState().screen === screen }) }));
      }
      return controller;
    };
    return { owner, lifecycle, start, invoke, observe, closeIfIdle, current: () => controller };
  }, [wallet, authed, screen]);
  const controller = ready === owned?.current() ? ready : null;
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.getSnapshot ?? emptySnapshot);
  useEffect(() => {
    if (!owned) return;
    const current = owned.start(); setReady(current);
    const suspend = () => { owned.lifecycle.visible = false; owned.lifecycle.epoch++; current.dismiss(); };
    const resume = () => { owned.lifecycle.visible = document.visibilityState !== 'hidden'; owned.observe(); };
    const visibility = () => document.visibilityState === 'hidden' ? suspend() : resume();
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend); document.addEventListener('resume', resume);
    window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume); window.addEventListener('focus', resume); window.addEventListener('online', resume);
    owned.observe();
    return () => {
      owned.lifecycle.active = false; suspend();
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('freeze', suspend); document.removeEventListener('resume', resume);
      window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); window.removeEventListener('online', resume);
      owned.closeIfIdle();
    };
  }, [owned]);
  useEffect(() => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } }, [owned, actionsAllowed, selection]);
  return { state: working === owned?.owner ? { ...state, busy: true } : state, actionsAllowed, run: (action: (c: CompassController) => Promise<unknown>) => owned?.invoke(action),
    clearPaidPreview: () => owned?.current()?.clearPaidPreview(),
    chooseFitting: (fitting: EquipmentFitting) => { owned?.current()?.chooseFitting(fitting); owned?.observe(); },
    dismiss: () => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } } };
}
