/**
 * DEVNET PLAYTEST ONLY — client half of the in-game devnet SOL faucet (owner
 * 2026-08-22). Once a player is in their base, ask the server whether the
 * wallet is eligible; if so, request one grant automatically (once per session)
 * and poll until the worker reports it sent, toasting the arrival. `claim` is
 * also the manual CLAIM DEVNET SOL control (D-098) on the land screen and in
 * the welcome dialog; `refresh` re-reads status for its RETRY. Everything is
 * server-decided: eligibility, amounts, caps, cooldown instant. Remove with the
 * API module before mainnet; `SOLANA_CLUSTER !== 'devnet'` short-circuits it today.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { EVENTS, track } from '../lib/analytics';
import { api, ApiError } from '../lib/api';
import { SOLANA_CLUSTER } from '../lib/cluster';
import { bus } from '../lib/events';

export interface FaucetGrant {
  id: string; status: 'requested' | 'sent' | 'failed'; lamports: string;
  txSignature: string | null; error: string | null; requestedAt: string; sentAt: string | null;
}
export interface FaucetStatus {
  enabled: boolean; eligible: boolean;
  reason: 'ok' | 'disabled' | 'not_devnet' | 'pending' | 'balance_ok' | 'cap_reached' | 'cooldown' | 'no_player' | 'rpc_unavailable';
  balanceSol: number | null; grantSol: number; grantedSol: number; lifetimeCapSol: number; minBalanceSol: number;
  /** D-098: policy for DISPLAY only — the countdown target is computed by the
   * server (set while reason is 'cooldown'); the client never adds hours. */
  cooldownHours: number; nextEligibleAt: string | null;
  last: FaucetGrant | null;
}

export type FaucetPhase = 'idle' | 'checking' | 'funding' | 'funded' | 'failed' | 'unavailable';

const POLL_MS = 3_000;
const POLL_MAX = 20;
const SLOW_POLL_MS = 30_000;

/** Per-session memory so a base↔build screen remount never re-requests. */
const attempted = new Set<string>();
/** Grants requested in this session, and the ones already announced — the
 * arrival toast fires once per grant even across a remount. */
const requestedHere = new Set<string>();
const announced = new Set<string>();

export function useDevnetFaucet(wallet: string | null, active: boolean): {
  phase: FaucetPhase; status: FaucetStatus | null; claim: () => void; refresh: () => void;
} {
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [phase, setPhase] = useState<FaucetPhase>('idle');
  // Mirror of `phase` that a stale `claim` closure can read: the CLAIM button
  // (D-098) may be tapped from any screen, and two taps must not queue twice.
  const phaseRef = useRef<FaucetPhase>('idle');
  phaseRef.current = phase;
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polls = useRef(0);
  const scope = useRef({ wallet, active, mounted: true });
  if (scope.current.wallet !== wallet || scope.current.active !== active) scope.current = { wallet, active, mounted: true };
  useEffect(() => {
    const mounted = scope.current;
    mounted.mounted = true;
    setStatus(null); setPhase('idle'); phaseRef.current = 'idle';
    return () => { mounted.mounted = false; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [wallet, active]);

  const announce = useCallback((s: FaucetStatus) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setPhase('funded');
    const id = s.last?.id ?? '';
    if (announced.has(id)) return;
    announced.add(id);
    bus.emit('ui:toast', { msg: `+${s.grantSol} DEVNET SOL ARRIVED — YOU CAN CLAIM LAND NOW` });
    track(EVENTS.DEVNET_FAUCET_FUNDED);
  }, []);

  const pollUntilSettled = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    polls.current = 0;
    const owner = scope.current;
    const live = () => owner.mounted && scope.current === owner;
    const schedule = (): void => {
      if (!live()) return;
      // A delayed worker is still allowed to fulfil this same request. Keep
      // polling at a lower rate after the fast minute; never request a second grant.
      if (polls.current >= POLL_MAX) setPhase('unavailable');
      pollTimer.current = setTimeout(tick, polls.current < POLL_MAX ? POLL_MS : SLOW_POLL_MS);
    };
    const tick = (): void => {
      if (!live()) return;
      polls.current += 1;
      void api.get<FaucetStatus>('/devnet-faucet/status').then((s) => {
        if (!live()) return;
        setStatus(s);
        const last = s.last;
        if (last?.status === 'sent') { announce(s); return; }
        if (last?.status === 'failed') {
          setPhase('failed');
          track(EVENTS.DEVNET_FAUCET_FAILED, { error: (last.error ?? '').slice(0, 60) });
          return;
        }
        schedule();
      }).catch(schedule);
    };
    pollTimer.current = setTimeout(tick, POLL_MS);
  }, []);

  const refresh = useCallback(() => {
    if (!wallet || SOLANA_CLUSTER !== 'devnet') return;
    const owner = scope.current;
    void api.get<FaucetStatus>('/devnet-faucet/status').then((s) => {
      if (!owner.mounted || scope.current !== owner) return;
      setStatus(s);
      if (s.last?.status === 'sent' && requestedHere.has(s.last.id)) { announce(s); return; }
      // RETRY (D-098): a stale failure clears once the server answers again —
      // the reason then drives the control; an in-flight grant found here
      // resumes its polling.
      if (phaseRef.current !== 'failed' && phaseRef.current !== 'unavailable') return;
      if (s.last?.status === 'requested') { setPhase('funding'); pollUntilSettled(); } else setPhase('idle');
    }).catch(() => null);
  }, [wallet, pollUntilSettled, announce]);

  const claim = useCallback(() => {
    if (!wallet || SOLANA_CLUSTER !== 'devnet') return;
    if (phaseRef.current === 'funding') return; // a grant is already in flight
    const owner = scope.current;
    phaseRef.current = 'funding';
    setPhase('funding');
    track(EVENTS.DEVNET_FAUCET_CLAIM);
    void api.postRaw<{ grant: FaucetGrant; status: FaucetStatus }>('/devnet-faucet/claim', {})
      .then((r) => { if (!owner.mounted || scope.current !== owner) return; requestedHere.add(r.grant.id); setStatus(r.status); pollUntilSettled(); })
      .catch((e: unknown) => {
        if (!owner.mounted || scope.current !== owner) return;
        // Not eligible (already funded / capped / cooldown) is a normal answer,
        // not a failure; only a real error shows the fallback.
        if (e instanceof ApiError && e.code === 'FAUCET_NOT_ELIGIBLE') {
          // Not eligible usually means "already funded"; a lost race with an
          // in-flight grant means "pending" — resume polling that one.
          void api.get<FaucetStatus>('/devnet-faucet/status').then((s) => {
            if (!owner.mounted || scope.current !== owner) return;
            setStatus(s);
            if (s.last?.status === 'requested') { requestedHere.add(s.last.id); setPhase('funding'); pollUntilSettled(); } else setPhase('idle');
          }).catch(() => { if (owner.mounted && scope.current === owner) setPhase('idle'); });
          return;
        }
        setPhase('failed');
      });
  }, [wallet, pollUntilSettled, refresh]);

  // Automatic first grant: once per wallet per session, only while in the base.
  useEffect(() => {
    if (!active || !wallet || SOLANA_CLUSTER !== 'devnet') return;
    const owner = scope.current;
    if (attempted.has(wallet)) {
      // Remount (base ↔ build ↔ back): resume a pending grant's polling and
      // announce an arrival that happened while we were away — once.
      void api.get<FaucetStatus>('/devnet-faucet/status').then((s) => {
        if (!owner.mounted || scope.current !== owner) return;
        setStatus(s);
        const last = s.last;
        if (last?.status === 'requested') { setPhase('funding'); pollUntilSettled(); return; }
        if (last?.status === 'sent' && requestedHere.has(last.id)) { announce(s); return; }
        if (last?.status === 'failed' && requestedHere.has(last.id)) { setPhase('failed'); return; }
        setPhase('idle');
      }).catch(() => null);
      return;
    }
    attempted.add(wallet);
    setPhase('checking');
    void api.get<FaucetStatus>('/devnet-faucet/status').then((s) => {
      if (!owner.mounted || scope.current !== owner) return;
      setStatus(s);
      if (!s.enabled) { setPhase('unavailable'); return; }
      if (s.last?.status === 'requested') { requestedHere.add(s.last.id); setPhase('funding'); pollUntilSettled(); return; }
      if (s.eligible) { claim(); return; }
      setPhase('idle');
    }).catch(() => { if (owner.mounted && scope.current === owner) setPhase('unavailable'); });
  }, [active, wallet, claim, refresh, pollUntilSettled, announce]);

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  return { phase, status, claim, refresh };
}
