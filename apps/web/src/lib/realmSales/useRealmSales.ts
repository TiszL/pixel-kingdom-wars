import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useGameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { createRealmSaleBrowserPorts, realmSaleIdentity } from './browser';
import { RealmSaleController, type RealmSaleState } from './controller';
import { RealmSaleJournalStore } from './journal';
import type { RealmSaleSigningTrust } from './signing';
import type { RealmSaleFailureTrust } from './failure';

const EMPTY: RealmSaleState = { loaded: false, busy: false, journal: null, review: null, settlementHeld: false, error: null };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useRealmSales(actionsEnabled: boolean, trust: RealmSaleSigningTrust | null = null, failureTrust: RealmSaleFailureTrust | null = null) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), screen = useApp(s => s.screen);
  const signer = useGameWallet(), signerRef = useRef(signer); signerRef.current = signer;
  const gate = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot), actionsAllowed = actionsEnabled && gate && trust !== null && signer.publicKey?.toBase58() === wallet && typeof signer.signTransaction === 'function';
  const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
  const [working, setWorking] = useState<object | null>(null);
  const [ready, setReady] = useState<RealmSaleController | null>(null);
  // Construct the lifetime descriptor without opening storage during render.
  // StrictMode's effect replay reuses it before the deferred close can run.
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const owner = {};
    const lifecycle = { active: false, visible: document.visibilityState !== 'hidden', epoch: 0 };
    let store: RealmSaleJournalStore | null = null, controller: RealmSaleController | null = null;
    let pending = 0, refresh = false, closed = false;
    const closeIfIdle = () => queueMicrotask(() => {
      if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store?.close().catch(() => undefined); }
    });
    const invoke = (action: (c: RealmSaleController) => Promise<void>) => {
      if (!controller || closed || !lifecycle.active || !lifecycle.visible) return;
      if (pending) { refresh = true; return; }
      pending++; setWorking(owner);
      void action(controller).catch(() => undefined).finally(() => {
        pending--;
        if (!pending && refresh && lifecycle.active && lifecycle.visible) { refresh = false; invoke(c => c.open()); }
        else if (lifecycle.active) setWorking(previous => previous === owner ? null : previous);
        closeIfIdle();
      });
    };
    const observe = () => { if (!lifecycle.active || !lifecycle.visible || closed) return; if (pending) refresh = true; else invoke(c => c.open()); };
    const start = () => {
      lifecycle.active = true; lifecycle.visible = document.visibilityState !== 'hidden';
      if (!controller) {
        store = new RealmSaleJournalStore(realmSaleIdentity(wallet), globalThis.indexedDB, 'pkw-realm-sale-v1', failureTrust);
        controller = new RealmSaleController(store, createRealmSaleBrowserPorts({ identity: store.identity, trust,
          wallet: () => signerRef.current, lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current,
            active: lifecycle.active && useApp.getState().screen === screen }) }));
      }
      return controller;
    };
    return { owner, lifecycle, start, invoke, observe, closeIfIdle, current: () => controller };
  }, [wallet, authed, screen, trust?.genesisHash, trust?.programId, trust?.developer, trust?.reviewedProgramDataSha256, trust?.reviewedDeploymentSlot, trust?.revision, failureTrust?.genesisHash, failureTrust?.programId, failureTrust?.developer, failureTrust?.reviewedProgramDataSha256, failureTrust?.reviewedDeploymentSlot, failureTrust?.revision, failureTrust?.upgradeAuthority]);
  const controller = ready === owned?.current() ? ready : null;
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.snapshot ?? emptySnapshot);
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
  useEffect(() => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } }, [owned, actionsAllowed]);
  return { state: working === owned?.owner ? { ...state, busy: true } : state, actionsAllowed, run: (action: (c: RealmSaleController) => Promise<void>) => owned?.invoke(action),
    dismiss: () => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } } };
}
