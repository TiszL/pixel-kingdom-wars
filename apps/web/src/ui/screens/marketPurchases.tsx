import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { explorerUrl } from '../../lib/cluster';
import { Btn, Card, COLORS as C } from '../primitives';
import { useFetch } from '../useFetch';
import { exactMarketSol } from './marketRecovery';

interface PendingPurchase {
  listingId: string; itemId: string; reference: string; priceLamports: string;
  buyerBaseId: string | null;
}
interface PendingPage { purchases: PendingPurchase[]; next: string | null }
interface Trade { listingId: string; itemId: string; role: 'bought' | 'sold'; priceLamports: string;
  buyerBaseId: string | null; txSignature: string; settledAt: string | null }
interface History { trades: Trade[]; hasMore: boolean }

/** Server-retained legacy references never become a fresh payable journal.
 * Opening this panel performs private reads only; CHECK reuses the exact old
 * listing/reference and has no wallet, reserve or transaction-signing dependency. */
export function MarketPurchases({ wallet, itemName, afterFinish }: {
  wallet: string; itemName(id: string): string; afterFinish(): void;
}): React.JSX.Element {
  const [after, setAfter] = useState<string | null>(null);
  const pending = useFetch<PendingPage>(() => api.get(`/market/purchases/pending${after ? `?after=${after}` : ''}`), [after]);
  const history = useFetch<History>(() => api.get('/market/trades'));
  const lock = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const check = async (purchase: PendingPurchase): Promise<void> => {
    if (lock.current || useApp.getState().wallet !== wallet) return;
    lock.current = true; setBusy(purchase.listingId); setMessage(null);
    try {
      const result = await api.postRaw<{ settled: boolean }>(`/market/purchases/${purchase.listingId}/check`, { reference: purchase.reference });
      if (!mounted.current || useApp.getState().wallet !== wallet) return;
      setMessage(result.settled ? 'Payment settled. The item was delivered to the original receiving inventory.'
        : 'The original payment is not finalized yet. Check again later; no new payment was requested.');
      if (result.settled) { pending.reload(); history.reload(); afterFinish(); }
    } catch (error) {
      if (mounted.current && useApp.getState().wallet === wallet) setMessage(`${error instanceof Error ? error.message : 'Payment check unavailable.'} Check the original payment again; no new payment was requested.`);
    } finally { lock.current = false; if (mounted.current) setBusy(null); }
  };
  return <section aria-label="Market purchases and history" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {pending.error && <Card><span>Saved purchases could not be loaded: {pending.error}</span><Btn variant="ghost" onClick={pending.reload}>RELOAD SAVED PURCHASES</Btn></Card>}
    {pending.data?.purchases.map((p) => <Card key={`${p.listingId}:${p.reference}`} style={{ padding: 10, gap: 6 }}>
      <strong style={{ color: C.goldHi }}>ORIGINAL PURCHASE · {itemName(p.itemId)}</strong>
      <span>{exactMarketSol(p.priceLamports)} SOL · Payment status needs checking</span>
      <span style={{ overflowWrap: 'anywhere' }}>Receiving inventory: {p.buyerBaseId ? `Base ${p.buyerBaseId}` : 'Wallet inventory'}</span>
      <details><summary>Original payment reference</summary><span style={{ overflowWrap: 'anywhere' }}>{p.reference}</span></details>
      <Btn disabled={busy !== null || pending.loading} onClick={() => { void check(p); }}>{busy === p.listingId ? 'CHECKING…' : 'CHECK ORIGINAL PAYMENT'}</Btn>
    </Card>)}
    {(after || pending.data?.next) && <div style={{ display: 'flex', gap: 8 }}>
      {after && <Btn variant="ghost" disabled={busy !== null} onClick={() => setAfter(null)}>FIRST SAVED PURCHASES</Btn>}
      {pending.data?.next && <Btn variant="ghost" disabled={busy !== null || pending.loading} onClick={() => setAfter(pending.data!.next)}>MORE SAVED PURCHASES</Btn>}
    </div>}
    {message && <p role="status" style={{ color: C.goldHi }}>{message}</p>}
    <details><summary style={{ color: C.goldHi }}>MY TRADE HISTORY</summary>
      {history.error ? <><p>Trade history unavailable: {history.error}</p><Btn variant="ghost" onClick={history.reload}>RELOAD HISTORY</Btn></>
        : history.loading && !history.data ? <p>Loading completed trades…</p>
          : history.data?.trades.length === 0 ? <p>No completed item trades.</p>
            : history.data?.trades.map((trade) => <Card key={trade.listingId} style={{ padding: 8, marginTop: 6, gap: 4 }}>
              <strong>{trade.role.toUpperCase()} · {itemName(trade.itemId)}</strong>
              <span>{exactMarketSol(trade.priceLamports)} SOL{trade.settledAt ? ` · ${new Date(trade.settledAt).toLocaleString()}` : ''}</span>
              <a href={explorerUrl('tx', trade.txSignature)} target="_blank" rel="noreferrer">VIEW TRANSACTION ↗</a>
            </Card>)}
      {history.data?.hasMore && <p>Showing the latest 50 completed trades.</p>}
    </details>
  </section>;
}
