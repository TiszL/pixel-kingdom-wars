import { mutationGate } from '../mutationGate';
import { useConnection } from '@solana/wallet-adapter-react';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useGameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { createGemsBuyBrowserPorts, gemsBuyIdentity } from './browser';
import { GemsBuyController, type GemsBuyState } from './controller';
import { GemsBuyJournalStore } from './journal';

const EMPTY: GemsBuyState = { loaded: false, busy: false, journal: null, error: null, networkFee: null, reviewed: false };
const emptySnapshot = () => EMPTY;
const emptySubscribe = () => () => undefined;
export function useGemsBuyRecovery(): { actionsAllowed: boolean; state: GemsBuyState; run(action: (controller: GemsBuyController) => Promise<void>): void; dismiss(): void } {
  const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), { connection } = useConnection();
  const signer = useGameWallet(), signerRef = useRef(signer); signerRef.current = signer;
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0, actionsEnabled: true };
    const screen = useApp.getState().screen, store = new GemsBuyJournalStore(gemsBuyIdentity(wallet));
    const controller = new GemsBuyController(store, createGemsBuyBrowserPorts({ identity: store.identity, connection,
      wallet: () => signerRef.current, lifecycle: () => ({ ...lifecycle, active: lifecycle.active && useApp.getState().screen === screen }) }));
    let pending = 0, refresh = false, closed = false;
    const closeIfIdle = () => queueMicrotask(() => {
      if (!lifecycle.active && pending === 0 && !closed) { closed = true; void store.close().catch(() => undefined); }
    });
    const invoke = (action: (c: GemsBuyController) => Promise<void>): void => {
      if (closed) return;
      pending++;
      // Track the promise itself: an obsolete controller deliberately does not
      // publish a busy=false into another session, but its late signature still
      // needs this ORIGINAL database connection before cleanup can close it.
      void action(controller).finally(() => {
        pending--;
        if (pending === 0 && refresh && lifecycle.active && lifecycle.visible) { refresh = false; invoke(c => c.open()); }
        closeIfIdle();
      });
    };
    const observe = () => {
      if (!lifecycle.active || !lifecycle.visible || closed) return;
      if (pending) refresh = true; else invoke(c => c.open());
    };
    return { controller, lifecycle, invoke, observe, closeIfIdle };
  }, [wallet, authed, connection]);
  const actionsAllowed = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot);
  useEffect(() => { if (owned && !actionsAllowed) { owned.controller.dismiss(); owned.observe(); } }, [owned, actionsAllowed]);
  const controller = owned?.controller;
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.snapshot ?? emptySnapshot);
  useEffect(() => {
    if (!owned) return;
    owned.lifecycle.active = true;
    owned.lifecycle.visible = document.visibilityState !== 'hidden';
    const suspend = () => { owned.lifecycle.visible = false; owned.lifecycle.epoch++; owned.controller.dismiss(); };
    const resume = () => { owned.lifecycle.visible = document.visibilityState !== 'hidden'; owned.observe(); };
    const visibility = () => {
      owned.lifecycle.visible = document.visibilityState !== 'hidden';
      if (owned.lifecycle.visible) owned.observe(); else suspend();
    };
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
  return { actionsAllowed, state, run: action => owned?.invoke(action), dismiss: () => owned?.controller.dismiss() };
}
