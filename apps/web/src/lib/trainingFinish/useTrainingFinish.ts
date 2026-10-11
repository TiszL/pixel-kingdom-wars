import { readFreeFinish } from '../../ui/screens/trainingFreeFinish';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { createTrainingFinishBrowserPorts, trainingFinishIdentity, refreshTrainingFinishSnapshot } from './browser';
import { TrainingFinishController, type TrainingFinishState } from './controller';
import { TrainingFinishJournalStore } from './journal';

const EMPTY: TrainingFinishState = { loaded: false, busy: false, journal: null, review: null, error: null };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
type View = Awaited<ReturnType<typeof refreshTrainingFinishSnapshot>>;
// A closed Barracks, another build tab or navigation invalidates its payment dialog,
// even when React has not yet run this hook's navigation effect.
const navigation = () => {
  const s = useApp.getState();
  return JSON.stringify([s.screen, s.selectedBuildingId, s.buildCategory]);
};
function freeRecoveryClear(wallet: string): boolean {
  try { return readFreeFinish(wallet) === null; } catch { return false; }
}
export function useTrainingFinish(actionsEnabled: boolean) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const screen = useApp(s => s.screen), selectedBuilding = useApp(s => s.selectedBuildingId), buildCategory = useApp(s => s.buildCategory);
  const globalAllowed = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  const allowed = useRef(actionsEnabled); allowed.current = actionsEnabled;
  const [working, setWorking] = useState<object | null>(null);
  const [remote, setRemote] = useState<{ owner: unknown; scope: ReturnType<typeof captureBaseSnapshotGuard>; view: View; revision: number; error: string | null }>({ owner: null, scope: captureBaseSnapshotGuard(), view: null, revision: 0, error: null });
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0, navigation: navigation() };
    const store = new TrainingFinishJournalStore(trainingFinishIdentity(wallet));
    const ports = createTrainingFinishBrowserPorts({ identity: store.identity, lifecycle: () => ({ ...lifecycle,
      actionsEnabled: allowed.current && mutationGate.getSnapshot() && freeRecoveryClear(wallet), active: lifecycle.active && lifecycle.navigation === navigation() }) });
    const controller = new TrainingFinishController(store, ports), owner = {};
    let pending = 0, refresh = false, closed = false, revision = 0;
    const refreshView = async () => {
      const scope = captureBaseSnapshotGuard(), epoch = lifecycle.epoch;
      const current = () => lifecycle.active && lifecycle.visible && lifecycle.navigation === navigation() && epoch === lifecycle.epoch && isBaseSnapshotGuardCurrent(scope);
      try {
        const view = await refreshTrainingFinishSnapshot(store.identity, ports);
        if (current()) setRemote({ owner, scope, view, revision: ++revision, error: null });
      } catch (error) {
        if (current()) setRemote({ owner, scope, view: null, revision: ++revision, error: error instanceof Error ? error.message : 'Training state did not refresh.' });
      }
    };
    const closeIfIdle = () => queueMicrotask(() => {
      if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store.close().catch(() => undefined); }
    });
    const invoke = (action: (c: TrainingFinishController) => Promise<void>, readView = true) => {
      if (closed || !lifecycle.active || !lifecycle.visible) return;
      if (pending) { refresh = true; return; }
      pending++; setWorking(owner);
      // The request and its authoritative refresh share one slot. A focus read
      // cannot overwrite a newer action with an older training view or balance response.
      void action(controller).then(() => {
        if (lifecycle.active && lifecycle.visible && (readView || controller.snapshot().journal?.operation)) return refreshView();
      }).catch(() => undefined).finally(() => {
        pending--;
        if (!pending && refresh && lifecycle.active && lifecycle.visible) { refresh = false; invoke(c => c.open(), false); }
        else if (lifecycle.active) setWorking(previous => previous === owner ? null : previous);
        closeIfIdle();
      });
    };
    const observe = () => {
      if (!lifecycle.active || !lifecycle.visible || closed) return;
      if (pending) refresh = true; else invoke(c => c.open(), false);
    };
    return { owner, controller, lifecycle, invoke, observe, closeIfIdle };
  }, [wallet, authed]);
  const state = useSyncExternalStore(owned?.controller.subscribe ?? emptySubscribe, owned?.controller.snapshot ?? emptySnapshot);
  useEffect(() => {
    if (!owned) return;
    owned.lifecycle.active = true; owned.lifecycle.visible = document.visibilityState !== 'hidden';
    const suspend = () => { owned.lifecycle.visible = false; owned.lifecycle.epoch++; owned.controller.dismiss(); };
    const resume = () => { owned.lifecycle.visible = document.visibilityState !== 'hidden'; owned.observe(); };
    const visibility = () => document.visibilityState === 'hidden' ? suspend() : resume();
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend); document.addEventListener('resume', resume);
    window.addEventListener('pagehide', suspend); window.addEventListener('pageshow', resume); window.addEventListener('focus', resume); window.addEventListener('online', resume); window.addEventListener('storage', resume);
    owned.observe();
    return () => {
      owned.lifecycle.active = false; suspend();
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('freeze', suspend); document.removeEventListener('resume', resume);
      window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); window.removeEventListener('storage', resume);
      owned.closeIfIdle();
    };
  }, [owned]);
  useEffect(() => {
    if (owned) { owned.lifecycle.epoch++; owned.lifecycle.navigation = navigation(); owned.controller.dismiss(); owned.observe(); }
  }, [owned, baseId, baseEpoch, screen, selectedBuilding, buildCategory, actionsEnabled, globalAllowed]);
  const current = remote.owner === owned?.owner && isBaseSnapshotGuardCurrent(remote.scope);
  const busy = state.busy || working === owned?.owner;
  return { state: { ...state, busy }, snapshot: current && !busy ? remote.view : null, snapshotRevision: current ? remote.revision : 0,
    refreshError: current ? remote.error : null, actionsEnabled: actionsEnabled && globalAllowed && !!wallet && freeRecoveryClear(wallet),
    run: (action: (c: TrainingFinishController) => Promise<void>) => owned?.invoke(action), refresh: () => owned?.invoke(c => c.open()),
    dismiss: () => { owned?.controller.dismiss(); owned?.observe(); } };
}
