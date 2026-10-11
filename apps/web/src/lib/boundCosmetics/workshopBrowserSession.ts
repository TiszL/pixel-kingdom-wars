import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../state/store';
import { ordinaryCraftingIdentity } from '../ordinaryCrafting/browser';
import { mutationGate } from '../mutationGate';
import { WorkshopJournalStore, type WorkshopCommandMode } from './workshopJournal';
import type { CosmeticWorkshopController, CosmeticWorkshopState } from './workshopControllerCore';
import type { WorkshopBrowserInput } from './workshopBrowser';

const EMPTY: CosmeticWorkshopState<never> = { loaded: false, busy: false, journal: null, view: null, review: null, error: null, notice: null };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useCosmeticWorkshopSession<V, C extends CosmeticWorkshopController<V>>(mode: WorkshopCommandMode, actionsEnabled: boolean,
  create: (store: WorkshopJournalStore, input: WorkshopBrowserInput) => C) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const gateOpen = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  const allowed = useRef(actionsEnabled); allowed.current = actionsEnabled;
  const [working, setWorking] = useState<object | null>(null);
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0 }, screen = useApp.getState().screen;
    const store = new WorkshopJournalStore(ordinaryCraftingIdentity(wallet), globalThis.indexedDB, mode); // Opens lazily after committed mount.
    const controller = create(store, { identity: store.identity,
      lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current, active: lifecycle.active && useApp.getState().screen === screen }) });
    const owner = {}; let pending = 0, refresh = false, closed = false;
    const closeIfIdle = () => queueMicrotask(() => { if (!lifecycle.active && !pending && !closed) { closed = true; void store.close().catch(() => undefined); } });
    const invoke = (action: (c: C) => Promise<void>) => {
      if (closed || !lifecycle.active || !lifecycle.visible) return;
      if (pending) { refresh = true; return; }
      pending++; setWorking(owner);
      void action(controller).catch(() => undefined).finally(() => {
        pending--;
        if (!pending && refresh && lifecycle.active && lifecycle.visible) { refresh = false; invoke(c => c.open(useApp.getState().selectedBaseId)); }
        else if (lifecycle.active) setWorking(previous => previous === owner ? null : previous);
        closeIfIdle();
      });
    };
    const observe = () => { if (!lifecycle.active || !lifecycle.visible || closed) return; if (pending) refresh = true; else invoke(c => c.open(useApp.getState().selectedBaseId)); };
    return { owner, controller, lifecycle, invoke, observe, closeIfIdle };
  }, [wallet, authed, mode, create]);
  const state: CosmeticWorkshopState<V> = useSyncExternalStore(owned?.controller.subscribe ?? emptySubscribe, owned?.controller.snapshot ?? emptySnapshot);
  useEffect(() => {
    if (!owned) return;
    owned.lifecycle.active = true; owned.lifecycle.visible = document.visibilityState !== 'hidden';
    const suspend = () => { owned.lifecycle.visible = false; owned.lifecycle.epoch++; owned.controller.dismiss(); };
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
  useEffect(() => {
    if (!owned) return;
    if (mode === 'wake') owned.controller.invalidateBaseView();
    else { owned.lifecycle.epoch++; owned.controller.dismiss(); }
    owned.observe();
  }, [owned, mode, baseId, baseEpoch]);
  useEffect(() => { if (owned) { owned.lifecycle.epoch++; owned.controller.dismiss(); owned.observe(); } }, [owned, actionsEnabled, gateOpen]);
  return { owned, state: { ...state, busy: state.busy || working === owned?.owner }, baseId,
    actionsAllowed: actionsEnabled && gateOpen, preferenceAllowed: gateOpen };
}
