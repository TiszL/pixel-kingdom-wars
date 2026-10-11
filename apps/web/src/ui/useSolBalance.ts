/** Live on-chain SOL balance for the signed-in wallet.
 *
 * Extracted from EntryScreen's inline poll (M23 a14) so the base HUD can show
 * the same number without a second ad-hoc implementation. The interval is the
 * caller's choice because the two consumers have different urgency: the paywall
 * polls fast (a fresh wallet must SEE funds arrive before PAY can work), while
 * the always-open HUD polls slowly to keep per-client RPC load bounded on the
 * shared VITE_SOLANA_RPC_URL endpoint. Reads pause while the tab is hidden and
 * refresh immediately when it becomes visible again.
 */
import { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';

export function useSolBalance(wallet: string | null, intervalMs: number): number | null {
  const { connection } = useConnection();
  const [snapshot, setSnapshot] = useState<{ wallet: string; sol: number } | null>(null);

  useEffect(() => {
    if (!wallet) { setSnapshot(null); return; }
    let live = true;
    const read = (skipWhenHidden: boolean): void => {
      // Only POLLS pause while hidden; the mount read always fires so a view
      // restored from the background is never permanently pill-less.
      if (skipWhenHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void connection.getBalance(new PublicKey(wallet))
        .then((lamports) => { if (live) setSnapshot({ wallet, sol: lamports / 1e9 }); })
        .catch(() => null); // transient RPC hiccup — next tick retries
    };
    read(false);
    const t = setInterval(() => read(true), intervalMs);
    const onVisible = (): void => { if (document.visibilityState === 'visible') read(false); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wallet, connection, intervalMs]);

  return snapshot?.wallet === wallet ? snapshot.sol : null;
}
