import { mutationGate } from '../mutationGate';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { createMiningContributionBrowserPorts, miningContributionIdentity } from './browser';
import { MiningContributionController, type MiningContributionState } from './controller';
import { MiningContributionJournalStore } from './journal';
import { MiningContributionViewSchema, type MiningContributionView } from '@shardkeep/shared/miningContributionApi';
type MiningContributionSnapshot = { view: MiningContributionView };
const EMPTY: MiningContributionState = { loaded: false, busy: false, journal: null, review: null, error: null };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useMiningContribution(actionsEnabled: boolean) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), baseId = useApp(s => s.selectedBaseId), baseEpoch = useApp(s => s.baseSelectionEpoch);
  const gateOpen = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  const actionsAllowed = actionsEnabled && gateOpen;
  const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
  const [working, setWorking] = useState<object | null>(null);
  const [remote, setRemote] = useState<{ owner: unknown; scope: ReturnType<typeof captureBaseSnapshotGuard>; snapshot: MiningContributionSnapshot | null; error: string | null }>({ owner: null, scope: captureBaseSnapshotGuard(), snapshot: null, error: null });
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0 }, screen = useApp.getState().screen;
    const store = new MiningContributionJournalStore(miningContributionIdentity(wallet));
    const ports = createMiningContributionBrowserPorts({ identity: store.identity, lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current, active: lifecycle.active && useApp.getState().screen === screen }) });
    const controller = new MiningContributionController(store, ports); let pending = 0, refresh = false, closed = false;
    const owner = {};
    const refreshView = async () => {
      const scope = captureBaseSnapshotGuard(), epoch = lifecycle.epoch, baseId = useApp.getState().selectedBaseId;
      const captured = ports.capture();
      const current = () => lifecycle.active && lifecycle.visible && epoch === lifecycle.epoch && isBaseSnapshotGuardCurrent(scope);
      const guard = () => { captured(); if (!current() || !baseId) throw new Error('Select your current kingdom to view mining stock.'); };
      try {
        guard(); const raw = await ports.get(`/mining/contributions?baseId=${encodeURIComponent(baseId!)}&catalogueVersion=3`, guard); guard();
        const view = MiningContributionViewSchema.parse(raw);
        if (view.wallet !== store.identity.wallet || view.baseId !== baseId) throw new Error('Mining stock belongs to another wallet or kingdom.');
        if (current()) setRemote({ owner, scope, snapshot: { view }, error: null });
      } catch (error) {
        if (current()) setRemote({ owner, scope, snapshot: null, error: error instanceof Error ? error.message : 'Mining stock could not be refreshed.' });
        throw error;
      }
    };
    const closeIfIdle = () => queueMicrotask(() => { if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store.close().catch(() => undefined); } });
    const invoke = (action: (c: MiningContributionController) => Promise<void>) => {
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
    run: (action: (c: MiningContributionController) => Promise<void>) => owned?.invoke(action), refresh: () => owned?.observe(),
    finish: () => owned?.invoke(c => c.finish()),
    dismiss: () => { if (owned) { owned.lifecycle.epoch++; owned.controller.dismiss(); owned.observe(); } } };
}
