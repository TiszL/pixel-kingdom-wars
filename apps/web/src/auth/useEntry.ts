/** Land checkout: freeze the parcel, obtain explicit payment consent, then
 * reconcile that same intent across navigation, wallet switching and reloads. */
import { FANTASY_WORLD, LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import type { FantasyTile, LandAddress } from '@shardkeep/shared/fantasyWorld';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, SendTransactionError } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { isAlreadyPaidError } from '../lib/chain';
import { SOLANA_CLUSTER } from '../lib/cluster';
import { SUPPORT_EMAIL } from '../lib/support';
import { useApp } from '../state/store';
import { useGameWallet } from './useGameWallet';
import { prepareLandPayment } from './landPayment';

const POLL_MS = LAND_CHECKOUT_RECOVERY.pollMs;
export type LandPurchaseKind = 'entry' | 'deed';
export type EntryPhase = 'idle' | 'restoring' | 'reserving' | 'ready' | 'paying' | 'confirming' | 'credited' | 'failed';

export interface LandReservation {
  id: string;
  reference: string;
  kind: LandPurchaseKind;
  baseId: string;
  earthCell?: number;
  landAddress?: LandAddress;
  fantasyLocation?: FantasyTile;
  amountLamports: number;
  countryA3: string | null;
  countryName: string | null;
  /** Server deadlines; the client never extends a payable reservation. */
  serverNow?: string;
  /** Local monotonic receipt anchor; never sent to the server. */
  observedAt?: number;
  payableUntil?: string;
  retryAt?: string;
}
interface DepositRow extends Partial<LandReservation> {
  id: string;
  status: 'pending' | 'finalized' | 'credited' | 'expired' | 'failed';
  paymentSignature?: string | null;
}
interface IntentResponse extends Partial<DepositRow> { alreadyPaid?: boolean }
interface SavedPurchase { id: string; signature?: string; submitted?: boolean; attemptStartedAt?: number; attemptClock?: 'server' }
const savedKey = (wallet: string, kind: LandPurchaseKind): string => `shardkeep:land:${SOLANA_CLUSTER}:${wallet}:${kind}`;
function readSaved(key: string): SavedPurchase | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as SavedPurchase | null;
    return value && typeof value.id === 'string' ? value : null;
  } catch { return null; }
}
function save(key: string, value: SavedPurchase | null): void {
  try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); }
  catch { /* Storage can be unavailable; the server still owns every intent. */ }
}
/** Late callbacks may update only the intent they originally submitted. */
function saveMatching(key: string, id: string, value: SavedPurchase | null): void {
  if (readSaved(key)?.id === id) save(key, value);
}
export function landReservationIdentity(reservation: Pick<LandReservation, 'earthCell' | 'landAddress'>): string | null {
  const address = reservation.landAddress;
  if (address?.kind === 'fantasy') return reservation.earthCell === undefined && address.worldId === 'fantasy-v1'
    && Number.isSafeInteger(address.tileId) && address.tileId >= 0 && address.tileId < FANTASY_WORLD.columns * FANTASY_WORLD.rows
    ? `${address.worldId}:${address.tileId}` : null;
  if (address?.kind === 'legacy-earth' && reservation.earthCell !== undefined && address.earthCell !== reservation.earthCell) return null;
  const cell = address?.kind === 'legacy-earth' ? address.earthCell : reservation.earthCell;
  return Number.isSafeInteger(cell) && cell! >= 0 && cell! < FANTASY_WORLD.columns * FANTASY_WORLD.rows ? `earth:${cell}` : null;
}
function reservationFrom(intent: IntentResponse, kind: LandPurchaseKind): LandReservation {
  if (!intent.id || !intent.reference || !intent.baseId
    || (intent.kind !== undefined && intent.kind !== kind)
    || landReservationIdentity(intent) === null
    || !Number.isSafeInteger(intent.amountLamports) || intent.amountLamports! <= 0) {
    throw new Error('server did not return a complete land reservation');
  }
  return {
    id: intent.id, reference: intent.reference, kind, baseId: intent.baseId,
    ...(intent.earthCell !== undefined ? { earthCell: intent.earthCell } : {}),
    ...(intent.landAddress ? { landAddress: intent.landAddress } : {}),
    ...(intent.fantasyLocation ? { fantasyLocation: intent.fantasyLocation } : {}),
    amountLamports: intent.amountLamports!,
    countryA3: typeof intent.countryA3 === 'string' ? intent.countryA3 : null,
    countryName: typeof intent.countryName === 'string' ? intent.countryName : null,
    ...(intent.serverNow && Number.isFinite(Date.parse(intent.serverNow))
      ? { serverNow: intent.serverNow, observedAt: performance.now() } : {}),
    ...(intent.payableUntil ? { payableUntil: intent.payableUntil } : {}),
    ...(intent.retryAt ? { retryAt: intent.retryAt } : {}),
  };
}
/** Server deadline display and retry checks must not depend on device clock skew. */
function serverTime(reservation: LandReservation, observedNow = performance.now()): number | null {
  if (!reservation.serverNow || reservation.observedAt === undefined) return null;
  return Date.parse(reservation.serverNow) + Math.max(0, observedNow - reservation.observedAt);
}

/** Only a positive pre-broadcast refusal permits another signature. A generic
 * timeout, AbortError or failed send acknowledgement may follow a successful
 * broadcast, especially for an embedded wallet. Reconcile those by reference. */
function paymentRefusedBeforeBroadcast(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false;
  if ('code' in cause && cause.code === 4001) return true;
  if (cause instanceof Error && /\buser (?:rejected|cancelled|canceled|declined)\b/i.test(cause.message)) return true;
  if (cause instanceof SendTransactionError && cause.message.startsWith('Simulation failed.')
    && /insufficient|not enough|custom program error: 0x1\b/i.test(cause.transactionError.message)) return true;
  // Wallet adapters preserve the original RPC/provider error under `error`.
  if ('error' in cause && cause.error !== cause && typeof cause.error === 'object' && cause.error !== null) {
    const nested = cause.error;
    if ('code' in nested && nested.code === 4001) return true;
    if (nested instanceof SendTransactionError && nested.message.startsWith('Simulation failed.')
      && /insufficient|not enough|custom program error: 0x1\b/i.test(nested.transactionError.message)) return true;
  }
  return false;
}

export function landPaymentError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '';
  if (/reject|cancel|declin/i.test(message)) return 'PAYMENT CANCELLED — YOUR LAND IS STILL RESERVED. TAP PAY WHEN READY.';
  if (/insufficient|not enough|0x1\b/i.test(message)) return 'NOT ENOUGH SOL — ADD FUNDS, INCLUDING THE NETWORK FEE, THEN TRY AGAIN.';
  if (/funding estimate unavailable/i.test(message)) return 'COULD NOT CHECK SOL AND FEES — YOUR LAND IS RESERVED. RETRY WHEN CONNECTED.';
  return cause instanceof ApiError ? cause.message : 'PAYMENT COULD NOT BE COMPLETED — CHECK YOUR WALLET AND TRY AGAIN.';
}

export function usePayEntry(kind: LandPurchaseKind = 'entry', onDone?: (reservation: LandReservation) => void): {
  reserve(selection?: number | { kind: 'fantasy'; worldId: 'fantasy-v1'; tileId?: number }): Promise<void>;
  submit(): Promise<void>;
  retryPayment(): Promise<void>;
  canRetryEntry: boolean;
  retryEntryInSec: number | null;
  reservationRetryInSec: number | null;
  phase: EntryPhase;
  error: string | null;
  reservation: LandReservation | null;
  paymentSignature: string | null;
  isEmbedded: boolean;
} {
  const { publicKey, sendTransaction, isEmbedded } = useGameWallet();
  const { connection } = useConnection();
  const wallet = useApp((s) => s.wallet);
  const signerRef = useRef({ publicKey, sendTransaction });
  signerRef.current = { publicKey, sendTransaction };
  const key = wallet ? savedKey(wallet, kind) : null;
  const [phase, setPhase] = useState<EntryPhase>(() => key && readSaved(key) ? 'restoring' : 'idle');
  const [error, setError] = useState<string | null>(null);
  const [reservation, setReservation] = useState<LandReservation | null>(null);
  const [paymentSignature, setPaymentSignature] = useState<string | null>(null);
  const [attemptStartedAt, setAttemptStartedAt] = useState<number | null>(null);
  const [recoveryNow, setRecoveryNow] = useState(() => performance.now());
  const [retrying, setRetrying] = useState(false);
  const retryInFlight = useRef(false);
  const phaseRef = useRef(phase);
  const reservationRef = useRef(reservation);
  const generation = useRef(0);
  const identity = useRef(key);
  // Invalidate even before the effect runs: an old response cannot credit the
  // newly selected wallet during the render/effect gap.
  if (identity.current !== key) { identity.current = key; generation.current++; }
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  reservationRef.current = reservation;
  const terminalIntent = useRef<string | null>(null);
  const attemptSequence = useRef(0);
  const pollSequence = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const walletFallback = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearWalletFallback = useCallback(() => {
    if (walletFallback.current) clearTimeout(walletFallback.current);
    walletFallback.current = null;
  }, []);
  const bounded = useCallback(async <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    requests.current.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
          timer = setTimeout(() => controller.abort(new Error('Land status request timed out')), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      requests.current.delete(controller);
      if (!controller.signal.aborted) controller.abort();
    }
  }, []);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const setState = useCallback((next: EntryPhase) => { phaseRef.current = next; setPhase(next); }, []);
  const stopPolling = useCallback(() => {
    pollSequence.current++;
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);
  const current = useCallback((epoch: number) => generation.current === epoch
    && useApp.getState().wallet === wallet, [wallet]);

  const applyTerminal = useCallback((deposit: DepositRow, prepared: LandReservation): boolean => {
    if (terminalIntent.current === prepared.id) return true;
    if (deposit.status === 'credited') {
      terminalIntent.current = prepared.id; clearWalletFallback();
      stopPolling(); setError(null); setState('credited');
      // Keep entry recovery until the next successful visit. A deed completion
      // leaves checkout, so retiring its hint allows buying another later.
      if (key && kind === 'deed') saveMatching(key, prepared.id, null);
      if (prepared.kind === 'entry') useApp.getState().setEntryPaid(true);
      onDoneRef.current?.(prepared);
    } else if (deposit.status === 'expired') {
      terminalIntent.current = prepared.id; clearWalletFallback();
      stopPolling(); if (key) saveMatching(key, prepared.id, null);
      setReservation(null); reservationRef.current = null; setState('idle');
      setError('NO PAYMENT WAS CONFIRMED FOR THIS RESERVATION — CHOOSE YOUR LAND AGAIN, THEN PAY ON THE CORRECT NETWORK.');
    } else if (deposit.status === 'failed') {
      terminalIntent.current = prepared.id; clearWalletFallback();
      stopPolling(); setState('failed');
      setError(`payment was seen but land could not be granted — email ${SUPPORT_EMAIL}`);
    } else return false;
    return true;
  }, [clearWalletFallback, key, kind, setState, stopPolling]);

  const poll = useCallback((prepared: LandReservation, signature?: string) => {
    if (terminalIntent.current === prepared.id || reservationRef.current?.id !== prepared.id) return;
    const epoch = generation.current;
    stopPolling();
    const sequence = pollSequence.current;
    const active = () => current(epoch) && pollSequence.current === sequence;
    let checking = false;
    setState('confirming'); setPaymentSignature(signature ?? null);
    const check = async (): Promise<void> => {
      if (checking || !active()) return;
      checking = true;
      // An acknowledgement is useful but must never delay reference recovery.
      const paid = signature
        ? bounded((signal) => api.postRaw(`/deposits/${prepared.id}/paid`, { signature }, { signal })).catch(() => null)
        : Promise.resolve(null);
      try {
        // An unrecorded signature must not prevent the reference scan. The
        // wallet can return before the server's confirmed RPC has caught up.
        const deposit = await bounded((signal) => api.post<DepositRow>(`/deposits/${prepared.id}/verify`, undefined, { signal }));
        if (active()) applyTerminal(deposit, prepared);
      } catch { /* A transient read never discards a submitted payment. */ }
      finally { await paid; checking = false; }
    };
    pollTimer.current = setInterval(() => { void check(); }, POLL_MS);
    void check();
  }, [applyTerminal, bounded, current, setState, stopPolling]);

  const adopt = useCallback((deposit: IntentResponse, saved?: SavedPurchase): void => {
    const prepared = reservationFrom(deposit, kind);
    setReservation(prepared); reservationRef.current = prepared;
    const remembered = saved ?? (key ? readSaved(key) : null);
    const prior = remembered?.id === prepared.id ? remembered : null;
    const signature = deposit.paymentSignature ?? prior?.signature;
    const pendingSubmission = Boolean(signature || prior?.submitted);
    const observedNow = performance.now();
    const serverNow = serverTime(prepared, observedNow);
    const elapsed = serverNow !== null && prior?.attemptClock === 'server'
      && typeof prior.attemptStartedAt === 'number' && Number.isFinite(prior.attemptStartedAt)
      && prior.attemptStartedAt <= serverNow
      ? Math.min(LAND_CHECKOUT_RECOVERY.firstEntryRetryMs, serverNow - prior.attemptStartedAt) : 0;
    const started = pendingSubmission ? observedNow - elapsed : null;
    setAttemptStartedAt(started); setRecoveryNow(observedNow);
    if (key) save(key, { id: prepared.id, ...(signature ? { signature } : {}),
      ...(prior?.submitted ? { submitted: true } : {}),
      ...(started !== null && serverNow !== null ? { attemptStartedAt: serverNow - elapsed, attemptClock: 'server' as const } : {}) });
    if (deposit.status && applyTerminal(deposit as DepositRow, prepared)) return;
    if (signature || prior?.submitted || (prepared.payableUntil && (serverTime(prepared) ?? Date.now()) >= Date.parse(prepared.payableUntil))) poll(prepared, signature);
    else setState('ready');
  }, [applyTerminal, key, kind, poll, setState]);

  useEffect(() => {
    const epoch = ++generation.current;
    terminalIntent.current = null;
    attemptSequence.current++;
    retryInFlight.current = false; setRetrying(false); setAttemptStartedAt(null);
    setRecoveryNow(performance.now());
    setReservation(null); reservationRef.current = null; setPaymentSignature(null); setError(null);
    const saved = key ? readSaved(key) : null;
    setState(saved ? 'restoring' : 'idle');
    let retry: ReturnType<typeof setTimeout> | undefined;
    const restore = async (): Promise<void> => {
      if (!saved || !current(epoch)) return;
      try {
        const [me, deposit] = await Promise.all([
          bounded((signal) => api.get<{ wallet: string; entryPaid: boolean }>('/me', { signal })),
          bounded((signal) => api.get<DepositRow>(`/deposits/${saved.id}`, { signal })),
        ]);
        if (!current(epoch) || me.wallet !== wallet) return;
        // /me can already know about a credit performed by the background
        // worker or another intent. Never invite that wallet to pay entry again.
        if (kind === 'entry' && me.entryPaid) {
          setState('credited'); useApp.getState().setEntryPaid(true); return;
        }
        // Re-read authoritative quote fields; storage is only a recovery hint.
        adopt(deposit, saved);
      } catch (cause) {
        if (!current(epoch)) return;
        if (cause instanceof ApiError && cause.status === 404) {
          if (key) saveMatching(key, saved.id, null); setState('idle');
          setError('RESERVATION NOT FOUND — CHOOSE YOUR LAND AGAIN.');
        } else {
          setError('RECONNECTING TO YOUR RESERVED LAND…');
          retry = setTimeout(() => { void restore(); }, POLL_MS);
        }
      }
    };
    void restore();
    return () => {
      generation.current++; if (retry) clearTimeout(retry); stopPolling(); clearWalletFallback();
      for (const request of requests.current) request.abort();
    };
  }, [adopt, bounded, clearWalletFallback, current, key, kind, setState, stopPolling, wallet]);

  const reserve = useCallback(async (selection?: number | { kind: 'fantasy'; worldId: 'fantasy-v1'; tileId?: number }) => {
    const address = typeof selection === 'object' ? { landAddress: selection }
      : typeof selection === 'number' ? { earthCell: selection }
      : import.meta.env.VITE_FEATURE_FANTASY_WORLD === '1' ? { landAddress: { kind: 'fantasy', worldId: 'fantasy-v1' } } : {};
    if (!wallet || !['idle', 'ready'].includes(phaseRef.current)) return;
    const epoch = generation.current;
    setError(null); setState('reserving');
    try {
      const intent = await bounded((signal) => api.postRaw<IntentResponse>('/deposits', { kind, ...address }, { signal }));
      if (!current(epoch)) return;
      if (kind === 'entry' && intent.alreadyPaid) {
        setState('credited'); useApp.getState().setEntryPaid(true); return;
      }
      adopt(intent);
    } catch (cause) {
      if (!current(epoch)) return;
      if (cause instanceof ApiError && ['RESERVATION_MISMATCH', 'PAYMENT_WINDOW_CLOSING'].includes(cause.code ?? '')
        && typeof cause.details?.depositId === 'string') {
        if (key) {
          const prior = readSaved(key);
          save(key, prior?.id === cause.details.depositId ? prior : { id: cause.details.depositId });
        }
        try {
          const depositId = cause.details.depositId;
          const deposit = await bounded((signal) => api.get<DepositRow>(`/deposits/${depositId}`, { signal }));
          if (!current(epoch)) return;
          adopt(deposit);
          setError(cause.code === 'RESERVATION_MISMATCH'
            ? `RESUMED YOUR RESERVED LAND ${landReservationIdentity(deposit)}.` : 'PAYMENT WINDOW CLOSED — CHECKING BEFORE RELEASING YOUR RESERVATION.');
          return;
        } catch { if (!current(epoch)) return; }
      }
      setState('idle');
      if (cause instanceof ApiError && cause.code === 'ENTRY_REQUIRED') {
        useApp.getState().setLandPurchase({ kind: 'entry', earthCell: null });
        setError('this wallet needs its FIRST land — switched to the entry purchase, tap again'); return;
      }
      setError(cause instanceof Error ? cause.message : 'could not reserve land');
    }
  }, [adopt, bounded, current, key, kind, setState, wallet]);

  const submit = useCallback(async () => {
    let prepared = reservationRef.current;
    if (!prepared || phaseRef.current !== 'ready') return;
    const preparedId = prepared.id;
    if (!publicKey || publicKey.toBase58() !== wallet || !sendTransaction) { setError('connect the same wallet first'); return; }
    const epoch = generation.current;
    const attempt = ++attemptSequence.current;
    const activeAttempt = () => current(epoch) && attemptSequence.current === attempt
      && reservationRef.current?.id === preparedId && terminalIntent.current !== preparedId;
    setError(null); setState('paying');
    const previous = key ? readSaved(key) : null;
    const previousSubmission = previous?.id === prepared.id && Boolean(previous.submitted || previous.signature);
    // A monotonic clock can pause during OS sleep. Re-read server authority
    // immediately before every wallet request, including ordinary deed PAY.
    try {
      const [me, deposit] = await Promise.all([
        bounded((signal) => api.get<{ wallet: string; entryPaid: boolean }>('/me', { signal })),
        bounded((signal) => api.get<DepositRow>(`/deposits/${preparedId}`, { signal })),
      ]);
      if (!activeAttempt()) return;
      if (me.wallet !== wallet) throw new Error('Wallet session changed');
      if (kind === 'entry' && me.entryPaid) { applyTerminal({ id: prepared.id, status: 'credited' }, prepared); return; }
      if (deposit.id !== prepared.id || deposit.kind !== kind) throw new Error('Land reservation changed');
      if (applyTerminal(deposit, prepared)) return;
      const fresh = reservationFrom(deposit, kind);
      if (fresh.reference !== prepared.reference || fresh.baseId !== prepared.baseId
        || landReservationIdentity(fresh) !== landReservationIdentity(prepared) || fresh.amountLamports !== prepared.amountLamports) {
        throw new Error('The reserved parcel changed');
      }
      // Another device can have confirmed this reference while this tab was
      // reviewing. Resume its known payment instead of signing a second one.
      if (deposit.paymentSignature) { adopt(deposit); return; }
      setReservation(fresh); reservationRef.current = fresh; prepared = fresh;
      if (deposit.status !== 'pending' || !fresh.payableUntil
        || !Number.isFinite(Date.parse(fresh.payableUntil))
        || (serverTime(fresh) ?? Date.now()) >= Date.parse(fresh.payableUntil)) {
        poll(fresh, previous?.signature);
        setError('PAYMENT WINDOW CLOSED — CHECKING BEFORE RELEASING YOUR RESERVATION.');
        return;
      }
    } catch {
      if (!activeAttempt()) return;
      if (previousSubmission) poll(prepared, previous?.signature);
      else setState('ready');
      setError('COULD NOT CONFIRM YOUR RESERVED LAND — NO NEW PAYMENT WAS REQUESTED. TRY AGAIN WHEN CONNECTED.');
      return;
    }
    let sendStarted = false;
    try {
      const signer = signerRef.current;
      if (!signer.publicKey || signer.publicKey.toBase58() !== wallet || !signer.sendTransaction) {
        throw new Error('Connect the same wallet before paying');
      }
      const reference = new PublicKey(prepared.reference);
      const { transaction: tx, estimate } = await bounded(() => prepareLandPayment(connection, signer.publicKey!, reference, prepared));
      if (!activeAttempt()) return;
      if (estimate.balanceLamports < estimate.requiredLamports) throw new Error('Insufficient SOL including network fee and account rent');
      if (signerRef.current.publicKey?.toBase58() !== wallet) throw new Error('Connect the same wallet before paying');
      // Persist before opening an external wallet, which may evict this tab.
      const startedAt = performance.now();
      const serverStartedAt = serverTime(prepared, startedAt);
      setAttemptStartedAt(startedAt); setRecoveryNow(startedAt);
      if (key) {
        const prior = readSaved(key);
        save(key, { id: prepared.id, submitted: true,
          ...(serverStartedAt !== null ? { attemptStartedAt: serverStartedAt, attemptClock: 'server' as const } : {}),
          ...(prior?.id === prepared.id && prior.signature ? { signature: prior.signature } : {}) });
      }
      sendStarted = true;
      walletFallback.current = setTimeout(() => {
        walletFallback.current = null;
        if (!activeAttempt()) return;
        poll(prepared);
        setError('WALLET RESPONSE IS DELAYED — CHECKING THE SAVED PAYMENT. DO NOT SEND ANOTHER PAYMENT.');
      }, LAND_CHECKOUT_RECOVERY.walletResponseGraceMs);
      const signature = await signer.sendTransaction(tx);
      // Preserve the old wallet's signature even if the user switched accounts.
      if (key) {
        const prior = readSaved(key);
        // A late signature may recover an exited page, but may not replace the
        // newer attempt's signature or restart its one-minute grace period.
        if (prior?.id === prepared.id && (attemptSequence.current === attempt || !prior.signature)) {
          save(key, { ...prior, signature, submitted: true });
        }
      }
      if (activeAttempt()) {
        clearWalletFallback(); poll(prepared, signature);
      }
    } catch (cause) {
      if (!activeAttempt()) return;
      clearWalletFallback();
      if (isAlreadyPaidError(cause)) { poll(prepared); return; }
      if (!sendStarted || paymentRefusedBeforeBroadcast(cause)) {
        if (previousSubmission) {
          poll(prepared, previous?.signature);
          setError(`${landPaymentError(cause)} YOUR ORIGINAL PAYMENT CHECK CONTINUES.`);
          return;
        }
        stopPolling();
        if (key) saveMatching(key, prepared.id, { id: prepared.id });
        setState('ready'); setError(landPaymentError(cause));
        return;
      }
      // buy_sink is repeatable: a new blockhash could pay twice for this one
      // intent. Keep its durable submitted marker through reload/account
      // switching until the server proves credit, failure or verified expiry.
      poll(prepared);
      setError('WALLET RESPONSE WAS INTERRUPTED — CHECKING YOUR PAYMENT BEFORE ANOTHER ATTEMPT.');
    }
  }, [adopt, applyTerminal, bounded, clearWalletFallback, connection, current, key, kind, poll, publicKey, sendTransaction, setState, stopPolling, wallet]);

  useEffect(() => {
    if (!['ready', 'paying', 'confirming'].includes(phase)) return;
    setRecoveryNow(performance.now());
    const timer = setInterval(() => setRecoveryNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, [kind, phase]);

  const retryEntryInSec = kind === 'entry' && attemptStartedAt !== null
    ? Math.max(0, Math.ceil((attemptStartedAt + LAND_CHECKOUT_RECOVERY.firstEntryRetryMs - recoveryNow) / 1000)) : null;
  const observedServerNow = reservation ? serverTime(reservation, recoveryNow) : null;
  const reservationRetryInSec = observedServerNow !== null && reservation?.retryAt
    ? Math.max(0, Math.ceil((Date.parse(reservation.retryAt) - observedServerNow) / 1000)) : null;
  const canRetryEntry = kind === 'entry' && phase === 'confirming' && !retrying
    && Boolean(publicKey && publicKey.toBase58() === wallet && sendTransaction)
    && retryEntryInSec === 0 && reservation !== null && terminalIntent.current !== reservation.id
    && observedServerNow !== null && Boolean(reservation.payableUntil && observedServerNow < Date.parse(reservation.payableUntil));

  const retryPayment = useCallback(async (): Promise<void> => {
    const prepared = reservationRef.current;
    // The countdown authorizes only another explicit check/signature for this
    // one-time entry instruction. It never expires or replaces an intent.
    if (kind !== 'entry' || !prepared || phaseRef.current !== 'confirming' || retryInFlight.current
      || !publicKey || publicKey.toBase58() !== wallet || !sendTransaction
      || attemptStartedAt === null || performance.now() < attemptStartedAt + LAND_CHECKOUT_RECOVERY.firstEntryRetryMs
      || !prepared.payableUntil || serverTime(prepared) === null || serverTime(prepared)! >= Date.parse(prepared.payableUntil)
      || terminalIntent.current === prepared.id) return;
    const epoch = generation.current;
    const sequence = ++attemptSequence.current;
    const active = () => current(epoch) && attemptSequence.current === sequence
      && reservationRef.current?.id === prepared.id && terminalIntent.current !== prepared.id;
    retryInFlight.current = true; setRetrying(true); clearWalletFallback(); stopPolling(); setError(null);
    try {
      const [me, deposit] = await Promise.all([
        bounded((signal) => api.get<{ wallet: string; entryPaid: boolean }>('/me', { signal })),
        bounded((signal) => api.post<DepositRow>(`/deposits/${prepared.id}/verify`, undefined, { signal })),
      ]);
      if (!active()) return;
      if (me.wallet !== wallet) throw new Error('Wallet session changed');
      if (me.entryPaid) { applyTerminal({ id: prepared.id, status: 'credited' }, prepared); return; }
      if (deposit.id !== prepared.id || deposit.kind !== 'entry') throw new Error('Land reservation changed');
      if (applyTerminal(deposit, prepared)) return;
      const fresh = reservationFrom(deposit, 'entry');
      if (fresh.reference !== prepared.reference || fresh.baseId !== prepared.baseId
        || landReservationIdentity(fresh) !== landReservationIdentity(prepared) || fresh.amountLamports !== prepared.amountLamports) {
        throw new Error('The reserved parcel changed');
      }
      // Another device can have confirmed this reference while this tab was
      // reviewing. Resume its known payment instead of signing a second one.
      if (deposit.paymentSignature) { adopt(deposit); return; }
      setReservation(fresh); reservationRef.current = fresh;
      if (deposit.status !== 'pending' || !fresh.payableUntil || serverTime(fresh) === null || serverTime(fresh)! >= Date.parse(fresh.payableUntil)) {
        throw new Error('The payment window changed — continuing to check your saved payment.');
      }
      const signer = signerRef.current;
      if (!signer.publicKey || signer.publicKey.toBase58() !== wallet || !signer.sendTransaction) {
        throw new Error('Connect the same wallet before retrying');
      }
      setState('ready');
      // The player's explicit RETRY is the consent. submit synchronously sets
      // paying, so repeated clicks cannot start another signature request.
      void submit();
    } catch {
      if (active()) {
        poll(prepared, key ? readSaved(key)?.signature : undefined);
        setError('COULD NOT CONFIRM A SAFE RETRY — STILL CHECKING YOUR SAVED PAYMENT.');
      }
    } finally {
      if (current(epoch)) { retryInFlight.current = false; setRetrying(false); }
    }
  }, [adopt, applyTerminal, attemptStartedAt, bounded, clearWalletFallback, connection, current, key, kind, poll, publicKey, sendTransaction, setState, stopPolling, submit, wallet]);

  return { reserve, submit, retryPayment, canRetryEntry, retryEntryInSec, reservationRetryInSec, phase, error, reservation, paymentSignature, isEmbedded };
}
