/**
 * Dormant treasury buy-vend client (Phase 4, ONRAMP-WALLETS-PLAN §5). No UI
 * imports this hook while new intents are reserve-gated off; the API also
 * rejects them with KEEP_VEND_UNAVAILABLE. Retained for the eventual backed
 * implementation; historical payment recovery stays on the generic by-id
 * deposit routes. When enabled, it mints a 'keep_vend'
 * intent (server prices it and returns the liquidity destination — bootstrap
 * routes 100% of collected SOL there), sign a native SOL transfer, then poll
 * /deposits/:id/verify until the finalized payment credits the play balance.
 * BUY-ONLY by design — selling KEEP happens via withdrawal + DEX, never here.
 */
import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { withSelectedBase } from '../lib/baseSelection';
import { buildSolPaymentTx } from '../lib/chain';
import { useGameWallet } from './useGameWallet';

const POLL_MS = 2_500;
type Phase = 'idle' | 'paying' | 'confirming';

interface Intent { id: string; reference: string; destination: string; amountLamports: number; keepOut: number }
interface DepositRow { id: string; status: 'pending' | 'finalized' | 'credited' | 'expired' | 'failed' }

export function useKeepVend(): {
  buy: (wholeKeep: number, onDone?: () => void) => Promise<void>;
  phase: Phase;
  error: string | null;
} {
  const { publicKey, sendTransaction } = useGameWallet();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const poll = useCallback((depositId: string, onDone?: () => void, paymentSignature?: string) => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = setInterval(() => {
      const committed = paymentSignature
        ? api.postRaw(`/deposits/${depositId}/paid`, { signature: paymentSignature }).catch(() => null)
        : Promise.resolve(null);
      void committed.then(() => api.post<DepositRow>(`/deposits/${depositId}/verify`)).then((d) => {
        if (d.status === 'credited') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setPhase('idle'); onDone?.();
        } else if (d.status === 'expired' || d.status === 'failed') {
          if (pollTimer.current) clearInterval(pollTimer.current);
          setPhase('idle'); setError(`purchase ${d.status}`);
        }
      }).catch(() => { /* transient — keep polling */ });
    }, POLL_MS);
  }, []);

  const buy = useCallback(async (wholeKeep: number, onDone?: () => void) => {
    if (!publicKey || !sendTransaction) { setError('link your wallet first'); return; }
    if (!Number.isInteger(wholeKeep) || wholeKeep <= 0) { setError('enter a whole KEEP amount'); return; }
    setError(null); setPhase('paying');
    try {
      const intent = await api.post<Intent>('/deposits', withSelectedBase({ kind: 'keep_vend', keepOut: wholeKeep }));
      const tx = buildSolPaymentTx({
        from: publicKey,
        to: new PublicKey(intent.destination),
        lamports: BigInt(intent.amountLamports),
        reference: new PublicKey(intent.reference),
      });
      const signature = await sendTransaction(tx);
      setPhase('confirming');
      poll(intent.id, onDone, signature);
    } catch (e) {
      setPhase('idle');
      setError(e instanceof Error ? e.message : 'purchase failed');
    }
  }, [publicKey, sendTransaction, poll]);

  return { buy, phase, error };
}
