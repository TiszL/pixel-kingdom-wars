/**
 * Pay-per-action SOL purchases (v3): the one client flow for every repeatable
 * on-chain SOL sink — raid energy, shield extension, extra builders, land
 * expansions. Mirrors usePayEntry: mint a deposit intent (server gives a fresh
 * reference), build + sign the shardkeep-core tx through the connected wallet,
 * then poll POST /deposits/:id/verify until the server credits the FINALIZED
 * payment and applies the in-game grant (no background worker required —
 * incident 2026-07-18).
 *
 * energy/shield/builder pay via buy_sink(kind, server-checked price); expansion
 * remains a direct liquidity transfer at the server-priced current index.
 */
import { RAID_ENERGY, SHIELD, WARZONE } from '@shardkeep/shared';
import { PublicKey, type Transaction } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { withSelectedBase } from '../lib/baseSelection';
import {
  buildBuySinkTx,
  buildSolPaymentTx,
  buildWarzoneShieldTx,
  isAlreadyPaidError,
} from '../lib/chain';
import { useGameWallet } from './useGameWallet';

const POLL_MS = 2_500;

export type PurchaseKind = 'builder' | 'expansion' | 'energy' | 'energy_pack' | 'shield' | 'mine' | 'warzone_shield';
type Phase = 'idle' | 'paying' | 'confirming';

/** Per-call options. `buildingId` + `amountLamports` target a specific paid
 *  building upgrade (kind 'mine' = Mine L5+ / Gold Forge L2+ since D-057; the
 *  SOL price varies by target level, so the caller supplies it from
 *  upgradeSolLamports — the server re-prices it authoritatively). */
interface PurchaseOpts {
  buildingId?: string;
  amountLamports?: bigint;
  onDone?: () => void;
}

interface DepositRow { id: string; status: 'pending' | 'finalized' | 'credited' | 'expired' | 'failed' }
// A mine-upgrade intent also carries the liquidity `destination` + the next-level
// SOL `amountLamports` (owner 2026-07-20 — mine SOL routes 100% to liquidity).
interface Intent { id?: string; reference?: string; destination?: string; amountLamports?: number }

/** Lamport price the client sends for a buy_sink; the server re-checks it. */
const SINK_PRICE: Record<'energy' | 'energy_pack' | 'shield', bigint> = {
  energy: BigInt(RAID_ENERGY.solLamportsPerEnergy),
  energy_pack: BigInt(RAID_ENERGY.packLamports), // 6 at 0.015 each — the value buy
  shield: BigInt(SHIELD.extendCostSolLamports),
};

export function useSolPurchase(): {
  purchase: (kind: PurchaseKind, opts?: PurchaseOpts) => Promise<void>;
  phase: Phase;
  error: string | null;
} {
  const { publicKey, sendTransaction } = useGameWallet();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const poll = useCallback((depositId: string, onDone?: () => void, paymentSignature?: string) => {
    setPhase('confirming');
    pollTimer.current = setInterval(() => {
      const committed = paymentSignature
        ? api.postRaw(`/deposits/${depositId}/paid`, { signature: paymentSignature }).catch(() => null)
        : Promise.resolve(null);
      void committed.then(() => api.post<DepositRow>(`/deposits/${depositId}/verify`)).then((d) => {
        if (d.status === 'credited') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setPhase('idle');
          onDone?.();
        } else if (d.status === 'expired') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setPhase('idle');
          setError('payment intent expired — try again');
        } else if (d.status === 'failed') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setPhase('idle');
          setError('payment received but the action could not be applied — it has been flagged for resolution');
        }
      }).catch(() => { /* transient poll failure — next tick retries */ });
    }, POLL_MS);
  }, []);

  const purchase = useCallback(async (kind: PurchaseKind, opts?: PurchaseOpts) => {
    if (!publicKey || !sendTransaction) { setError('connect a wallet first'); return; }
    setError(null);
    setPhase('paying');
    let depositId: string | null = null;
    try {
      const intent = await api.post<Intent>('/deposits', withSelectedBase(
        kind === 'mine' ? { kind, buildingId: opts?.buildingId } : { kind },
      ));
      if (!intent.id || !intent.reference) { setPhase('idle'); setError('could not start payment'); return; }
      depositId = intent.id;
      const ref = new PublicKey(intent.reference);
      let tx: Transaction;
      if (kind === 'builder') {
        if (intent.amountLamports === undefined) {
          setPhase('idle'); setError('payment price missing'); return;
        }
        tx = buildBuySinkTx(publicKey, ref, 'builder', BigInt(intent.amountLamports));
      }
      else if (kind === 'mine' || kind === 'expansion') {
        // Mine upgrades AND land expansions pay SOL 100% to the liquidity wallet
        // (owner 2026-07-20) — a direct transfer like mine builds, NOT buy_sink /
        // buy_expansion. The intent carries the liquidity destination + the
        // server-priced amount (per-index / next-level).
        const lamports = intent.amountLamports ?? (opts?.amountLamports !== undefined ? Number(opts.amountLamports) : undefined);
        if (!intent.destination || lamports === undefined) {
          setPhase('idle'); setError('payment price/destination missing'); return;
        }
        tx = buildSolPaymentTx({ from: publicKey, to: new PublicKey(intent.destination), lamports: BigInt(lamports), reference: ref });
      } else if (kind === 'warzone_shield') {
        // #49: ONE tx, TWO legs — 50% direct to liquidity + 50% via buy_sink(40/35/25).
        const direct = (BigInt(WARZONE.shieldCostSolLamports) * BigInt(WARZONE.shieldLiquidityDirectBps)) / 10_000n;
        const split = BigInt(WARZONE.shieldCostSolLamports) - direct;
        tx = buildWarzoneShieldTx({ wallet: publicKey, reference: ref, directLamports: direct, splitLamports: split });
      } else tx = buildBuySinkTx(publicKey, ref, kind, SINK_PRICE[kind]);
      const signature = await sendTransaction(tx);
      poll(intent.id, opts?.onDone, signature);
    } catch (e) {
      // A builder/expansion PDA-order race or an already-processed tx still
      // finalizes on-chain; let the watcher pick it up by reference.
      if (depositId && isAlreadyPaidError(e)) { poll(depositId, opts?.onDone); return; }
      setPhase('idle');
      setError(e instanceof Error ? e.message : 'payment failed');
    }
  }, [publicKey, sendTransaction, poll]);

  return { purchase, phase, error };
}
