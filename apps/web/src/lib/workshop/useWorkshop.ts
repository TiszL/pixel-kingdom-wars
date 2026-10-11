import { mutationGate } from '../mutationGate';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { createWorkshopBrowserPorts, workshopIdentity } from './browser';
import { WorkshopController, type WorkshopState } from './controller';
import { WorkshopJournalStore } from './journal';
import { refreshWorkshopSnapshot, type WorkshopSnapshot } from './snapshot';
const EMPTY: WorkshopState = { loaded: false, busy: false, journal: null, review: null, error: null };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useWorkshop(actionsEnabled: boolean) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const gateOpen = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  const actionsAllowed = actionsEnabled && gateOpen;
  const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
  const [working, setWorking] = useState<object | null>(null);
  const [remote, setRemote] = useState<{ owner: unknown; scope: ReturnType<typeof captureBaseSnapshotGuard>; snapshot: WorkshopSnapshot | null; error: string | null }>({ owner: null, scope: captureBaseSnapshotGuard(), snapshot: null, error: null });
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0 }, screen = useApp.getState().screen;
    const store = new WorkshopJournalStore(workshopIdentity(wallet));
    const ports = createWorkshopBrowserPorts({ identity: store.identity, lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current, active: lifecycle.active && useApp.getState().screen === screen }) });
    const controller = new WorkshopController(store, ports); let pending = 0, refresh = false, closed = false;
    const owner = {};
    const refreshView = async () => {
      const scope = captureBaseSnapshotGuard(), epoch = lifecycle.epoch;
      const current = () => lifecycle.active && lifecycle.visible && epoch === lifecycle.epoch && isBaseSnapshotGuardCurrent(scope);
      try { const snapshot = await refreshWorkshopSnapshot(store.identity, ports); if (current()) setRemote({ owner, scope, snapshot, error: null }); }
      catch (error) { if (current()) setRemote({ owner, scope, snapshot: null, error: error instanceof Error ? error.message : 'Workshop refresh failed.' }); }
    };
    const closeIfIdle = () => queueMicrotask(() => { if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store.close().catch(() => undefined); } });
    const invoke = (action: (c: WorkshopController) => Promise<void>) => {
      if (closed || !lifecycle.active || !lifecycle.visible) return;
      // The operation includes its authoritative refresh: a foreground read or
      // second click cannot race its older stock response into a newer action.
      if (pending) { refresh = true; return; }
      pending++; setWorking(owner);
      void action(controller).then(() => { if (lifecycle.active && lifecycle.visible) return refreshView(); }).catch(() => undefined).finally(() => {
        pending--; if (!pending && refresh && lifecycle.active && lifecycle.visible) { refresh = false; invoke(c => c.open()); }
        else if (lifecycle.active) setWorking(previous => previous === owner ? null : previous);
        closeIfIdle();
      });
    };
    const observe = () => { if (!lifecycle.active || !lifecycle.visible || closed) return; if (pending) refresh = true; else invoke(c => c.open()); };
    // Read-only live authority for a mounted panel. The supplied predicate must
    // compare current host identity synchronously; it must perform no requests.
    const readAuthority = (isCurrentPanel: () => boolean) => {
      const app = useApp.getState();
      if (closed || pending !== 0 || !lifecycle.active || !lifecycle.visible
        || document.visibilityState === 'hidden' || !app.authed || app.wallet !== wallet
        || app.screen !== screen || !allowed.current || !mutationGate.getSnapshot()) return null;
      try { if (isCurrentPanel() !== true) return null; } catch { return null; }
      const liveState = controller.snapshot();
      if (!liveState.loaded || liveState.busy) return null;
      return Object.freeze({ state: liveState as Readonly<WorkshopState>, lifecycleEpoch: lifecycle.epoch, actionsAllowed: true as const });
    };
    return { owner, controller, lifecycle, invoke, observe, closeIfIdle, readAuthority };
  }, [wallet, authed]);
  const state = useSyncExternalStore(owned?.controller.subscribe ?? emptySubscribe, owned?.controller.snapshot ?? emptySnapshot);
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
      window.removeEventListener('pagehide', suspend); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); owned.closeIfIdle();
    };
  }, [owned]);
  useEffect(() => { if (owned) { owned.lifecycle.epoch++; owned.controller.dismiss(); owned.observe(); } }, [owned, baseId, baseEpoch, actionsAllowed]);
  const authorityScope = captureBaseSnapshotGuard();
  const current = remote.owner === owned?.owner && isBaseSnapshotGuardCurrent(remote.scope);
  return { actionsAllowed, state: working === owned?.owner ? { ...state, busy: true } : state, snapshot: current ? remote.snapshot : null, refreshError: current ? remote.error : null,
    // Public accessor on the existing exported hook; absence of a host binding
    // fails closed. Captured scope is only a stale-generation fence, not authority.
    ...({ readAuthority: (isCurrentPanel: () => boolean = () => false) => {
      if (!owned || !actionsEnabled || !isBaseSnapshotGuardCurrent(authorityScope)) return null;
      return owned.readAuthority(isCurrentPanel);
    } } as { readonly readAuthority?: (isCurrentPanel?: () => boolean) => Readonly<{ state: Readonly<WorkshopState>; lifecycleEpoch: number; actionsAllowed: true }> | null }),
    run: (action: (c: WorkshopController) => Promise<void>) => owned?.invoke(action), refresh: () => owned?.observe(),
    dismiss: () => { owned?.controller.dismiss(); owned?.observe(); } };
}
