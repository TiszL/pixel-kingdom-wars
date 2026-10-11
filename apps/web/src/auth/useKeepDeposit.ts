/**
 * KEEP deposit hook (owner 2026-07-19) — the inbound mirror of useSolPurchase.
 * Mint a 'keep_deposit' intent (the server returns the source/destination KEEP
 * ATAs + decimals + reference), build + sign an SPL TransferChecked from the
 * player's wallet to the hot wallet's KEEP ATA, then poll /deposits/:id/verify
 * until the server observes the finalized transfer and credits the play balance.
 */
import { PublicKey } from '@solana/web3.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { buildKeepDepositTx } from '../lib/chain';
import { useGameWallet } from './useGameWallet';
import { MAX_KEEP_DEPOSIT } from './keepDepositAmount';

const POLL_MS = 2_500;
type Phase = 'idle' | 'paying' | 'confirming';

interface Intent {
  id: string; reference: string; source: string; destination: string; mint: string; decimals: number;
}
interface DepositRow { id: string; status: 'pending' | 'finalized' | 'credited' | 'expired' | 'failed' }

export function useKeepDeposit(): {
  deposit: (wholeKeep: bigint, onDone?: () => void) => Promise<void>;
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
          setPhase('idle'); setError(`deposit ${d.status}`);
        }
      }).catch(() => { /* transient RPC/verify hiccup — keep polling */ });
    }, POLL_MS);
  }, []);

  const deposit = useCallback(async (wholeKeep: bigint, onDone?: () => void) => {
    if (!publicKey || !sendTransaction) { setError('link your wallet first'); return; }
    if (wholeKeep <= 0n || wholeKeep > MAX_KEEP_DEPOSIT) { setError('enter a valid whole KEEP amount'); return; }
    setError(null); setPhase('paying');
    try {
      const intent = await api.post<Intent>('/deposits', { kind: 'keep_deposit' });
      if (!Number.isInteger(intent.decimals) || intent.decimals < 0 || intent.decimals > 19) {
        throw new Error('deposit mint decimals are invalid');
      }
      const amountBaseUnits = wholeKeep * (10n ** BigInt(intent.decimals));
      const tx = buildKeepDepositTx({
        source: new PublicKey(intent.source),
        mint: new PublicKey(intent.mint),
        destination: new PublicKey(intent.destination),
        owner: publicKey,
        reference: new PublicKey(intent.reference),
        amountBaseUnits,
        decimals: intent.decimals,
      });
      const signature = await sendTransaction(tx);
      setPhase('confirming');
      poll(intent.id, onDone, signature);
    } catch (e) {
      setPhase('idle');
      setError(e instanceof Error ? e.message : 'deposit failed');
    }
  }, [publicKey, sendTransaction, poll]);

  return { deposit, phase, error };
}
