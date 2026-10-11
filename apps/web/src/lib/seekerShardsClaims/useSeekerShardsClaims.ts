import { mutationGate } from '../mutationGate';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { createSeekerShardsClaimsBrowserPorts, seekerShardsClaimsIdentity } from './browser';
import { SeekerShardsClaimsController, type SeekerShardsClaimsState } from './controller';
import { SeekerShardsClaimsJournalStore } from './journal';
import { refreshSeekerShardsClaimsSnapshot, type SeekerShardsClaimsSnapshot } from './snapshot';
const EMPTY: SeekerShardsClaimsState = { loaded: false, busy: false, journal: null, view: null, review: null, error: null };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useSeekerShardsClaims(actionsEnabled: boolean) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const gateOpen = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  const actionsAllowed = actionsEnabled && gateOpen;
  const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
  const [working, setWorking] = useState<object | null>(null);
  const [remote, setRemote] = useState<{ owner: unknown; scope: ReturnType<typeof captureBaseSnapshotGuard>; snapshot: SeekerShardsClaimsSnapshot | null; error: string | null }>({ owner: null, scope: captureBaseSnapshotGuard(), snapshot: null, error: null });
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0 }, screen = useApp.getState().screen;
    const store = new SeekerShardsClaimsJournalStore(seekerShardsClaimsIdentity(wallet));
    const ports = createSeekerShardsClaimsBrowserPorts({ identity: store.identity, lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current, active: lifecycle.active && useApp.getState().screen === screen }) });
    const controller = new SeekerShardsClaimsController(store, ports); let pending = 0, refresh = false, closed = false;
    const owner = {};
    const refreshView = async (publicationGuard: () => void = () => undefined, originalBaseId?: string) => {
      const scope = captureBaseSnapshotGuard(), epoch = lifecycle.epoch;
      const current = () => lifecycle.active && lifecycle.visible && epoch === lifecycle.epoch && isBaseSnapshotGuardCurrent(scope);
      try { const snapshot = await refreshSeekerShardsClaimsSnapshot(store.identity, ports, publicationGuard, originalBaseId); if (current()) setRemote({ owner, scope, snapshot, error: null }); }
      catch (error) { if (current()) setRemote({ owner, scope, snapshot: null, error: error instanceof Error ? error.message : 'SHARDS claims refresh failed.' }); throw error; }
    };
    const closeIfIdle = () => queueMicrotask(() => { if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store.close().catch(() => undefined); } });
    const invoke = (action: (c: SeekerShardsClaimsController) => Promise<void>) => {
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
    return { owner, controller, lifecycle, invoke, observe, closeIfIdle, refreshView };
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
  const current = remote.owner === owned?.owner && isBaseSnapshotGuardCurrent(remote.scope);
  return { actionsAllowed, state: working === owned?.owner ? { ...state, busy: true } : state, snapshot: current ? remote.snapshot : null, refreshError: current ? remote.error : null,
    run: (action: (c: SeekerShardsClaimsController) => Promise<void>) => owned?.invoke(action), refresh: () => owned?.observe(),
    finish: () => owned?.invoke(c => c.finish(guard => owned.refreshView(guard, c.snapshot().journal?.operation?.command.request.baseId))),
    dismiss: () => { if (owned) { owned.lifecycle.epoch++; owned.controller.dismiss(); owned.observe(); } } };
}
