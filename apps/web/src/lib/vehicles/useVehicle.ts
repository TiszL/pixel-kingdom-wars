import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {useConnection} from '@solana/wallet-adapter-react';
import { useGameWallet } from '../../auth/useGameWallet';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { createVehicleBrowserPorts, browserVehicleIdentity } from './browser';
import { VehicleController, type VehicleState } from './controller';
import { VehicleJournalStore } from './journal';
import type { VehicleSigningTrust } from './signing';

const EMPTY: VehicleState = {loaded:false,busy:false,journal:null,activity:null,assets:null,fleet:null,routes:null,selected:null,reviewed:null,error:null};
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useVehicle(actionsEnabled: boolean, trust: VehicleSigningTrust | null = null) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), screen = useApp(s => s.screen);
  const {connection}=useConnection();
  const signer = useGameWallet(), signerRef = useRef(signer); signerRef.current = signer;
  const gate = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot), actionsAllowed = actionsEnabled && gate;
  const signingAllowed = actionsAllowed && trust !== null && signer.publicKey?.toBase58() === wallet && typeof signer.signVersionedTransaction === 'function';
  const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
  const [working, setWorking] = useState<object | null>(null);
  const [ready, setReady] = useState<VehicleController | null>(null);
  // Construct the lifetime descriptor without opening storage during render.
  // StrictMode's effect replay reuses it before the deferred close can run.
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const owner = {};
    const lifecycle = { active: false, visible: document.visibilityState !== 'hidden', epoch: 0 };
    let store: VehicleJournalStore | null = null, controller: VehicleController | null = null;
    let pending = 0, refresh = false, closed = false;
    const closeIfIdle = () => queueMicrotask(() => {
      if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store?.close().catch(() => undefined); }
    });
    const invoke = (action: (c: VehicleController) => Promise<unknown>) => {
      if (!controller || closed || !lifecycle.active || !lifecycle.visible) return;
      if (pending) { refresh = true; return; }
      pending++; setWorking(owner);
      void Promise.resolve().then(()=>action(controller!)).catch(() => undefined).finally(() => {
        pending--;
        if (!pending && refresh && lifecycle.active && lifecycle.visible) { refresh = false; invoke(c => c.load()); }
        else if (lifecycle.active) setWorking(previous => previous === owner ? null : previous);
        closeIfIdle();
      });
    };
    const observe = () => { if (!lifecycle.active || !lifecycle.visible || closed) return; if (pending) refresh = true; else invoke(c => c.load()); };
    const start = () => {
      lifecycle.active = true; lifecycle.visible = document.visibilityState !== 'hidden';
      if (!controller) {
        store = new VehicleJournalStore(browserVehicleIdentity(wallet), globalThis.indexedDB, 'pkw-vehicles-v1');
        controller = new VehicleController(store, createVehicleBrowserPorts({ identity: store.identity, trust, connection,
          wallet: () => signerRef.current, lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current,
            active: lifecycle.active && useApp.getState().screen === screen }) }));
      }
      return controller;
    };
    // Read-only view of this original owner. The predicate is a synchronous,
    // side-effect-free host identity check; only literal true is accepted.
    const readAuthority = (isCurrentPanel: () => boolean) => {
      try { if (isCurrentPanel() !== true) return null; } catch { return null; }
      const app = useApp.getState();
      if (!controller || closed || pending !== 0 || !lifecycle.active || !lifecycle.visible
        || document.visibilityState === 'hidden' || !app.authed || app.wallet !== wallet
        || app.screen !== screen || allowed.current !== true || mutationGate.getSnapshot() !== true) return null;
      const liveState = controller.getSnapshot();
      if (!liveState.loaded || liveState.busy) return null;
      // No signing/trust/chain attestation is implied by actionsAllowed.
      return Object.freeze({ state: liveState as Readonly<VehicleState>, lifecycleEpoch: lifecycle.epoch, actionsAllowed: true as const });
    };
    return { owner, lifecycle, start, invoke, observe, closeIfIdle, current: () => controller, readAuthority };
  }, [wallet, authed, screen, connection, JSON.stringify(trust)]);
  // A connection/trust render can replace the descriptor before effect cleanup.
  // A retained accessor must not attest the prior descriptor in that window.
  const authorityOwner = useRef(owned); authorityOwner.current = owned;
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
  useEffect(() => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } }, [owned, actionsAllowed, signingAllowed]);
  const authorityScope = captureBaseSnapshotGuard();
  return { state: working === owned?.owner ? { ...state, busy: true } : state, actionsAllowed, signingAllowed,
    // Optional typing preserves legacy mocks. Consumers must use truthy optional
    // access and recheck the same owner/lifecycle epoch at the action boundary.
    ...({ readAuthority: (isCurrentPanel: () => boolean = () => false) => {
      const current = () => !!owned && authorityOwner.current === owned && actionsEnabled === true && isBaseSnapshotGuardCurrent(authorityScope);
      if (!current()) return null;
      const authority = owned!.readAuthority(isCurrentPanel);
      return current() ? authority : null;
    } } as { readonly readAuthority?: (isCurrentPanel?: () => boolean) => Readonly<{ state: Readonly<VehicleState>; lifecycleEpoch: number; actionsAllowed: true }> | null }),
    run: (action: (c: VehicleController) => Promise<unknown>) => owned?.invoke(action),
    dismiss: () => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } } };
}
