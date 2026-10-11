/**
 * Item-market buy (Lane B, owner 2026-07-24). Non-custodial SOL settlement:
 * reserve the listing (server returns the 95/5 split params), sign ONE payment
 * from the buyer's own wallet (seller + our fee treasury), then poll settle
 * until the server verifies the finalized payment and hands over the item.
 */
import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { withSelectedBase } from '../lib/baseSelection';
import { buildMarketBuyTx } from '../lib/chain';
import { useGameWallet } from './useGameWallet';

const POLL_MS = 2_500;
type Phase = 'idle' | 'reserving' | 'paying' | 'confirming';

interface ReserveDto {
  listingId: string; seller: string; feeTreasury: string; reference: string;
  sellerLamports: string; feeLamports: string;
}
interface SettleDto { settled: boolean; itemId?: string }

export function useMarketBuy(): {
  buy: (listingId: string, onDone?: () => void) => Promise<void>;
  phase: Phase;
  /** The listing currently mid-purchase, so a browse list can show progress on
   *  THAT row only instead of every BUY button at once. */
  listingId: string | null;
  error: string | null;
} {
  const { publicKey, sendTransaction } = useGameWallet();
  const [phase, setPhase] = useState<Phase>('idle');
  const [listingId, setListingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const poll = useCallback((listingId: string, onDone?: () => void) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(() => {
      void api.post<SettleDto>(`/market/listings/${listingId}/settle`).then((r) => {
        if (r.settled) {
          if (timer.current) clearInterval(timer.current);
          setPhase('idle'); setListingId(null); onDone?.();
        }
        // settled=false → payment not finalized yet, keep polling.
      }).catch((e: Error) => {
        // A terminal error (reservation expired / taken) stops the poll.
        if (timer.current) clearInterval(timer.current);
        setPhase('idle'); setListingId(null); setError(e.message);
      });
    }, POLL_MS);
  }, []);

  const buy = useCallback(async (listingId: string, onDone?: () => void) => {
    if (!publicKey || !sendTransaction) { setError('link your wallet first'); return; }
    setError(null); setListingId(listingId); setPhase('reserving');
    try {
      const r = await api.post<ReserveDto>(
        `/market/listings/${listingId}/reserve`, withSelectedBase({}),
      );
      // Anti-double-charge (security review 2026-07-24 #5): if a prior attempt
      // already paid this reservation (e.g. a reload mid-flow), settle now
      // instead of sending a second payment.
      const probe = await api.post<SettleDto>(`/market/listings/${listingId}/settle`).catch(() => ({ settled: false }));
      if (probe.settled) { setPhase('idle'); setListingId(null); onDone?.(); return; }
      setPhase('paying');
      const tx = buildMarketBuyTx({
        buyer: publicKey,
        seller: new PublicKey(r.seller),
        feeTreasury: new PublicKey(r.feeTreasury),
        sellerLamports: BigInt(r.sellerLamports),
        feeLamports: BigInt(r.feeLamports),
        reference: new PublicKey(r.reference),
      });
      const signature = await sendTransaction(tx);
      // Safeguard: register the broadcast signature so the reservation is locked
      // to us — a paid listing can never be reopened out from under us, even if
      // finalization lags. Best-effort: the reference-tagged verify at settle is
      // the fund-safety net regardless, so a failed commit still settles.
      await api.post(`/market/listings/${listingId}/paid`, { signature }).catch(() => { /* settle still works via the reference */ });
      setPhase('confirming');
      poll(listingId, onDone);
    } catch (e) {
      setPhase('idle'); setListingId(null);
      setError(e instanceof Error ? e.message : 'buy failed');
    }
  }, [publicKey, sendTransaction, poll]);

  return { buy, phase, listingId, error };
}
