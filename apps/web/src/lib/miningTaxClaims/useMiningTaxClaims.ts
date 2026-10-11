import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useGameWallet } from '../../auth/useGameWallet';
import { useApp } from '../../state/store';
import { mutationGate } from '../mutationGate';
import { createMiningTaxClaimBrowserPorts, miningTaxClaimIdentity } from './browser';
import { MiningTaxClaimController, type MiningTaxClaimState } from './controller';
import { MiningTaxClaimJournalStore, type MiningTaxClaimJournal } from './journal';
import type { MiningTaxClaimSigningTrust } from './signing';

const EMPTY: MiningTaxClaimState = { loaded: false, busy: false, journal: null, review: null, settlementHeld: false, error: null };
const UNVERIFIABLE: MiningTaxClaimState = { ...EMPTY, loaded: true, settlementHeld: true,
 error: 'Independent deployment pins are unavailable. Saved records are kept; verification and recovery need the original reviewed pins.' };
const emptySnapshot = () => EMPTY, emptySubscribe = () => () => undefined;
const samePins = (a: MiningTaxClaimSigningTrust | null, b: MiningTaxClaimSigningTrust | null) => a !== null && b !== null
 && (['genesisHash', 'programId', 'configAddress', 'keepMint', 'reserveOwner', 'reviewedDeploymentSlot', 'reviewedProgramDataSha256'] as const).every(k => a[k] === b[k]);

/** Recovery pins are independently configured historical trust, never values
 * taken from a response or saved preparation. Missing pins never clear storage. */
export function useMiningTaxClaims(actionsEnabled: boolean, trust: MiningTaxClaimSigningTrust | null = null, recoveryTrust: MiningTaxClaimSigningTrust | null = trust) {
 const wallet = useApp(s => s.wallet), authed = useApp(s => s.authed), screen = useApp(s => s.screen);
 const signer = useGameWallet(), signerRef = useRef(signer); signerRef.current = signer;
 const gate = useSyncExternalStore(mutationGate.subscribe, mutationGate.getSnapshot), verificationTrust = recoveryTrust ?? trust;
 const actionsAllowed = actionsEnabled && gate && samePins(trust, verificationTrust) && signer.publicKey?.toBase58() === wallet && typeof signer.signTransaction === 'function';
 const allowed = useRef(actionsAllowed); allowed.current = actionsAllowed;
 const [working, setWorking] = useState<object | null>(null), [ready, setReady] = useState<MiningTaxClaimController | null>(null);
 const [historyState, setHistory] = useState<{ owner: object; row: MiningTaxClaimJournal | null; error: string | null } | null>(null);
 const owned = useMemo(() => {
  if (!wallet || !authed || !verificationTrust) return null;
  const owner = {}, pins = Object.freeze({ ...verificationTrust });
  const lifecycle = { active: false, visible: document.visibilityState !== 'hidden', epoch: 0 };
  let store: MiningTaxClaimJournalStore | null = null, controller: MiningTaxClaimController | null = null;
  let ports: ReturnType<typeof createMiningTaxClaimBrowserPorts> | null = null;
  let pending = false, refresh = false, closed = false;
  const closeIfIdle = () => queueMicrotask(() => {
   if (!lifecycle.active && !pending && !closed) { closed = true; void store?.close().catch(() => undefined); }
  });
  const perform = (action: () => Promise<void>) => {
   if (!controller || closed || !lifecycle.active || !lifecycle.visible) return;
   if (pending) { refresh = true; return; }
   pending = true; setWorking(owner);
   void action().catch(() => undefined).finally(() => {
    pending = false;
    if (refresh && lifecycle.active && lifecycle.visible) { refresh = false; perform(() => controller!.open()); }
    else if (lifecycle.active) setWorking(previous => previous === owner ? null : previous);
    closeIfIdle();
   });
  };
  const invoke = (action: (c: MiningTaxClaimController) => Promise<void>) => perform(() => action(controller!));
  const observe = () => invoke(c => c.open());
  const start = () => {
   lifecycle.active = true; lifecycle.visible = document.visibilityState !== 'hidden';
   if (!controller) {
    store = new MiningTaxClaimJournalStore(miningTaxClaimIdentity(wallet), pins);
    ports = createMiningTaxClaimBrowserPorts({ identity: store.identity, trust, wallet: () => signerRef.current,
     lifecycle: () => ({ ...lifecycle, actionsEnabled: allowed.current, active: lifecycle.active && useApp.getState().screen === screen }) });
    controller = new MiningTaxClaimController(store, ports, pins);
   }
   return controller;
  };
  const openHistory = (key: string) => perform(async () => {
   const guard = ports!.capture(false);
   setHistory({ owner, row: null, error: null });
   try { const row = await store!.archived(key); guard(); if (!row) throw Error('Saved tax history is unavailable.'); setHistory({ owner, row, error: null }); }
   catch (error) { try { guard(); setHistory({ owner, row: null, error: error instanceof Error ? error.message : 'Saved tax history is unavailable.' }); } catch { /* Retired historical view. */ } }
  });
  return { owner, lifecycle, start, invoke, observe, openHistory, closeIfIdle, current: () => controller };
 }, [wallet, authed, screen, trust?.genesisHash, trust?.programId, trust?.configAddress, trust?.keepMint, trust?.reserveOwner, trust?.reviewedDeploymentSlot, trust?.reviewedProgramDataSha256,
  verificationTrust?.genesisHash, verificationTrust?.programId, verificationTrust?.configAddress, verificationTrust?.keepMint, verificationTrust?.reserveOwner, verificationTrust?.reviewedDeploymentSlot, verificationTrust?.reviewedProgramDataSha256]);
 const controller = ready === owned?.current() ? ready : null;
 const snapshot = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.snapshot ?? emptySnapshot);
 const state = !verificationTrust ? UNVERIFIABLE : working === owned?.owner ? { ...snapshot, busy: true } : snapshot;
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
 const history = historyState?.owner === owned?.owner ? historyState : null;
 return {
  state, actionsAllowed, history: history?.row ?? null, historyError: history?.error ?? null,
  run: (action: (c: MiningTaxClaimController) => Promise<void>) => owned?.invoke(action),
  held: (ordinal: number) => {
   const op = state.journal?.operation;
   return !controller || !op || !!op.failure || !!op.failureObserved || !!op.continuation || !!op.continuationObserved || op.unattributedObserved || op.observed.some(o => o >= ordinal || o < ordinal && !op.setup)
    || controller.store.otherSettlementHeld(op.request.idempotencyKey) || controller.store.settlementHeld(op.request.idempotencyKey, ordinal);
  },
  openHistory: (key: string) => owned?.openHistory(key),
  dismiss: () => { if (owned) { owned.lifecycle.epoch++; owned.current()?.dismiss(); owned.observe(); } },
 };
}
