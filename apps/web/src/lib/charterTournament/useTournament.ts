import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {useConnection} from '@solana/wallet-adapter-react';
import { useGameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { createTournamentBrowserPorts, browserTournamentIdentity } from './browser';
import { TournamentController, type TournamentState } from './controller';
import { TournamentJournalStore } from './journal';
import type { TournamentSigningTrust } from './signing';

const EMPTY: TournamentState = { loaded: false, busy: false, archives: [], journal: null, events: null, event: null, participation: null, replay: null, reviewedMessage: null, error: null };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
export function useTournament(actionsEnabled: boolean, trust: TournamentSigningTrust | null = null) {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), screen = useApp(s => s.screen);
  const {connection}=useConnection();
  const signer = useGameWallet(), signerRef = useRef(signer); signerRef.current = signer;
  const gate = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot), actionsAllowed = actionsEnabled && gate && trust !== null && signer.publicKey?.toBase58() === wallet && typeof signer.signVersionedTransaction === 'function';
  const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
  const [working, setWorking] = useState<object | null>(null);
  const [ready, setReady] = useState<TournamentController | null>(null);
  // Construct the lifetime descriptor without opening storage during render.
  // StrictMode's effect replay reuses it before the deferred close can run.
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const owner = {};
    const lifecycle = { active: false, visible: document.visibilityState !== 'hidden', epoch: 0 };
    let store: TournamentJournalStore | null = null, controller: TournamentController | null = null;
    let pending = 0, refresh = false, closed = false;
    const closeIfIdle = () => queueMicrotask(() => {
      if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store?.close().catch(() => undefined); }
    });
    const invoke = (action: (c: TournamentController) => Promise<unknown>) => {
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
        store = new TournamentJournalStore(browserTournamentIdentity(wallet), globalThis.indexedDB, 'pkw-charter-tournament-v1');
        controller = new TournamentController(store, createTournamentBrowserPorts({ identity: store.identity, trust, connection,
          wallet: () => signerRef.current, lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current,
            active: lifecycle.active && useApp.getState().screen === screen }) }));
      }
      return controller;
    };
    return { owner, lifecycle, start, invoke, observe, closeIfIdle, current: () => controller };
  }, [wallet, authed, screen, connection, JSON.stringify(trust)]);
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
  useEffect(() => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } }, [owned, actionsAllowed]);
  return { state: working === owned?.owner ? { ...state, busy: true } : state, actionsAllowed, run: (action: (c: TournamentController) => Promise<unknown>) => owned?.invoke(action),
    dismiss: () => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } } };
}
