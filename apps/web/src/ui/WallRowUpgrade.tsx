import { wallFrameKey } from '@shardkeep/shared/wallArt';
import type { WallRowUpgradeQuote, WallRowUpgradeResult } from '@shardkeep/shared';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, api, idemKey } from '../lib/api';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent } from '../state/store';
import { reloadBase } from '../state/baseSnapshot';
import { Btn, COLORS as C, ModalWrap, Phead, Sprite } from './primitives';

/** The highlighted row is one explicit purchase. Failed transport retries the
 * same receipt; refreshed eligibility always needs another confirmation. */
export function WallRowUpgrade({ wallId }: { wallId: string }): React.JSX.Element {
  const [quote, setQuote] = useState<WallRowUpgradeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [retry, setRetry] = useState(false);
  const pending = useRef<{ quoteId: string; idempotencyKey: string } | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const scope = useRef(captureBaseSnapshotGuard());
  const current = (): boolean => mounted.current && isBaseSnapshotGuardCurrent(scope.current);
  const baseBody = scope.current.selectedBaseId ? { baseId: scope.current.selectedBaseId } : {};
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const finishWorking = (): void => { working.current = false; if (current()) setBusy(false); };
  const preview = async (): Promise<void> => {
    if (working.current || !current()) return;
    working.current = true; setBusy(true); setMessage('');
    try {
      const next = await api.postRaw<WallRowUpgradeQuote>(`/base/walls/${wallId}/upgrade-quote`, baseBody);
      if (current()) { setQuote(next); pending.current = null; setRetry(false); }
    } catch (error) { if (current()) setMessage((error as Error).message); }
    finally { finishWorking(); }
  };
  const purchase = async (): Promise<void> => {
    if (!quote || working.current || !current()) return;
    pending.current ??= { quoteId: quote.quoteId, idempotencyKey: idemKey() };
    working.current = true; setBusy(true); setMessage('');
    try {
      await api.postRaw<WallRowUpgradeResult>(`/base/walls/${wallId}/upgrade-row`, { ...baseBody, ...pending.current });
      if (!current()) return;
      await reloadBase();
      if (current()) { setQuote(null); pending.current = null; setRetry(false); setMessage('ROW UPGRADED'); }
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && ['WALL_ROW_QUOTE_CHANGED', 'WALL_ROW_FUNDS_CHANGED', 'WALL_ROW_UNAVAILABLE'].includes(error.code ?? '')) {
        const next = error.details?.quote as WallRowUpgradeQuote | undefined;
        if (next) setQuote(next);
        pending.current = null; setRetry(false);
      } else setRetry(true);
      setMessage((error as Error).message);
    } finally { finishWorking(); }
  };
  const eligible = quote?.walls.filter((wall) => wall.targetLevel !== null) ?? [];
  const groups = new Map<string, { label: string; count: number; cost: number; level: number; targetLevel: number | null }>();
  for (const wall of quote?.walls ?? []) {
    const label = wall.excluded === 'max_level' ? `LEVEL ${wall.level} · MAXED — UNCHANGED`
      : wall.excluded === 'keep_level' ? `LEVEL ${wall.level} · NEEDS KEEP ${wall.level + 1} — UNCHANGED`
        : wall.excluded === 'busy' ? `LEVEL ${wall.level} · BUSY — UNCHANGED` : `LEVEL ${wall.level} → ${wall.targetLevel}`;
    const group = groups.get(label) ?? { label, count: 0, cost: 0, level: wall.level, targetLevel: wall.targetLevel };
    group.count++; group.cost += wall.costShards; groups.set(label, group);
  }
  return <>
    <Btn disabled={busy} style={{ width: '100%', minHeight: 44 }} onClick={() => void preview()}>
      {busy ? 'CHECKING ROW…' : 'UPGRADE ROW…'}
    </Btn>
    {!quote && message && <div role="status" style={{ color: C.goldHi }}>{message}</div>}
    {quote && createPortal(<ModalWrap onBackdrop={() => { if (!busy) setQuote(null); }}>
      <div role="alertdialog" aria-modal="true" aria-label="Confirm wall row upgrade"
        style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 14px 14px', overflowWrap: 'anywhere' }}>
        <Phead title="UPGRADE WALL ROW" color={C.gold} center />
        <div>{eligible.length} OF {quote.walls.length} WALLS · ONE LEVEL EACH</div>
        {[...groups.values()].map((group) => <div key={group.label} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Sprite name={wallFrameKey(group.level, 'straight')} w={28} h={28} />
          {group.targetLevel !== null && <><span aria-hidden="true">→</span><Sprite name={wallFrameKey(group.targetLevel, 'straight')} w={28} h={28} /></>}
          {group.count} × {group.label}{group.cost > 0 ? ` · ${group.cost.toLocaleString()} SHARDS` : ''}
        </div>)}
        <div>TOTAL {quote.totalCostShards.toLocaleString()} SHARDS · BALANCE {quote.balanceShards}</div>
        {!quote.canAfford && <div role="status" style={{ color: C.danger }}>NOT ENOUGH SHARDS FOR THIS ROW</div>}
        {message && <div role="status" style={{ color: C.goldHi }}>{message}</div>}
        <Btn disabled={busy || !quote.canAfford || eligible.length === 0} style={{ minHeight: 44 }} onClick={() => void purchase()}>
          {busy ? 'UPGRADING…' : retry ? 'RETRY SAME UPGRADE' : `UPGRADE ${eligible.length} WALLS · ${quote.totalCostShards.toLocaleString()} SHARDS`}
        </Btn>
        <Btn variant="sec" disabled={busy} style={{ minHeight: 44 }} onClick={() => setQuote(null)}>CANCEL</Btn>
      </div>
    </ModalWrap>, document.body)}
  </>;
}
