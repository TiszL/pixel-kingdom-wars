/**
 * Admin: rate tester feedback (owner 2026-08-21). Lazy panel inside the ADMIN
 * screen, the AdminChatPanel pattern. A rating sets importance/status and
 * REPLACES the bonus (never stacks); rejected/duplicate keep base points only.
 *
 * Owner 2026-09-07: New → Accepted → Fixed is a mutually exclusive displayed
 * lifecycle. Only Accepted reports can be marked Fixed; reopening returns to
 * Accepted. Existing reward totals and curated-issue state remain separate.
 *
 * Export (owner 2026-09-04): the admin picks which reports to export as plain
 * text; exported reports are stamped on the server and shown as EXPORTED, and
 * a NOT EXPORTED filter lists what still has to go out.
 *
 * Origin (owner 2026-09-18): every report shows whether it came from the Android
 * app or the web client, and ANDROID APP ONLY filters the list on the server.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { bus } from '../../lib/events';
import { Btn, Chip, COLORS as C } from '../primitives';
import { feedbackOrigin } from '@shardkeep/shared/feedback';
import { useFeedbackPages } from '../feedback/useFeedbackPages';
import FeedbackOriginBadge from '../feedback/FeedbackOriginBadge';
import { useApp } from '../../state/store';
import FeedbackThread from '../feedback/FeedbackThread';
import AdminFeedbackStateAction from '../feedback/AdminFeedbackStateAction';
import AdminIssueCatalogue from '../feedback/AdminIssueCatalogue';
import AdminFeedbackExports, { type ExportFilter } from '../feedback/AdminFeedbackExports';

type Status = 'new' | 'reviewed' | 'accepted' | 'rejected' | 'duplicate';
type Importance = 'low' | 'medium' | 'high' | 'critical';
type Filter = Status | 'fixed' | 'unexported' | 'android' | 'all';
export interface FeedbackRow {
  id: string; wallet: string; name: string; category: string; title: string; body: string;
  context: Record<string, unknown> | null; status: Status | 'fixed'; importance: Importance | null;
  basePoints: number; bonusPoints: number; points: number; adminNote: string | null;
  createdAt: string; reviewedAt: string | null;
  fixed?: boolean; fixedAt?: string | null; fixedRef?: string | null; exportedAt?: string | null;
  trashed?: boolean; trashedAt?: string | null;
  rewardPolicyVersion?: number; unread?: boolean; revision?: number; exported?: boolean; lastExportedRevision?: number;
}
const FILTERS: Array<{ key: Filter; label: string; query: string }> = [
  { key: 'new', label: 'NEW', query: '?status=new' },
  { key: 'reviewed', label: 'REVIEWED', query: '?status=reviewed' },
  { key: 'accepted', label: 'ACCEPTED', query: '?status=accepted' },
  { key: 'rejected', label: 'REJECTED', query: '?status=rejected' },
  { key: 'duplicate', label: 'DUPLICATE', query: '?status=duplicate' },
  { key: 'fixed', label: 'FIXED', query: '?fixed=true' },
  { key: 'unexported', label: 'NOT EXPORTED', query: '?exported=false' },
  { key: 'android', label: 'ANDROID APP ONLY', query: '?client=android-native' },
  { key: 'all', label: 'ALL', query: '' },
];

const isFixed = (r: FeedbackRow): boolean => r.fixed === true || r.status === 'fixed' || !!r.fixedAt;
const triageOf = (r: FeedbackRow): Status => (r.status === 'fixed' ? 'accepted' : r.status);
const stamp = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

/** The plain-text export: one block per report, newest first, readable in a
 *  chat or a document without any tool. Full wallets on purpose — this is the
 *  admin's own copy (the public board shortens them). */
export function feedbackAsText(rows: readonly FeedbackRow[], exportedAt: Date): string {
  const lines: string[] = [
    `Pixel Kingdom Wars — tester feedback export`,
    `${rows.length} report${rows.length === 1 ? '' : 's'} · exported ${stamp(exportedAt.toISOString())} UTC`,
    '',
  ];
  for (const r of rows) {
    const ctx = r.context ? Object.entries(r.context).map(([k, v]) => `${k}=${String(v)}`).join(' · ') : '';
    const rating = [
      `status: ${isFixed(r) ? 'fixed' : r.status}`,
      r.importance ? `importance: ${r.importance}` : null,
      `points: ${r.points}`,
      r.fixedRef ? `fix reference: ${r.fixedRef}` : null,
      r.fixedAt ? `fixed at: ${stamp(r.fixedAt)} UTC` : null,
    ].filter((x): x is string => x !== null).join(' · ');
    lines.push(
      `## [${r.category.toUpperCase()}] ${r.title}`,
      `SOURCE: ${feedbackOrigin(r.context).label}`,
      `${r.name || 'KEEPER'} · ${r.wallet} · ${stamp(r.createdAt)} UTC`,
      rating,
      ...(ctx ? [`context: ${ctx}`] : []),
      ...(r.adminNote ? [`note to tester: ${r.adminNote}`] : []),
      '',
      r.body.trim(),
      '',
    );
  }
  return lines.join('\n');
}

export default function AdminFeedbackPanel(): React.JSX.Element {
  const wallet = useApp((state) => state.wallet);
  return wallet ? <AdminFeedbackSession key={wallet} wallet={wallet} /> : <div role="status">SIGN IN TO OPEN FEEDBACK</div>;
}
function AdminFeedbackSession({ wallet }: { wallet: string }): React.JSX.Element {
  const [exportsOpen, setExportsOpen] = useState(false);
  const [catalogue,setCatalogue] = useState(false);
  const [filter, setFilter] = useState<Filter>('new');
  const [trash, setTrash] = useState(false);
  const query = trash ? '?trashed=true' : FILTERS.find((f) => f.key === filter)?.query ?? '';
  const { data, error, loading, reload, more, nextCursor } = useFeedbackPages<FeedbackRow>(wallet, `/admin/tester/feedback/page${query}`, true);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [filter, trash]);
  const [exportText, setExportText] = useState<string | null>(null);
  const [exportLabel, setExportLabel] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  // Keep the reading queue stable when accepting a report removes it from New.
  // Only an explicit Load more appends IDs; a background refresh cannot skip one.
  const [queue, setQueue] = useState<{ ids: string[]; index: number } | null>(null);
  const [queueMore, setQueueMore] = useState(false);
  const opened = queue?.ids[queue.index] ?? null;
  const shown = data?.feedback ?? [];
  useEffect(() => {
    if (!queueMore || loading) return;
    setQueueMore(false);
    setQueue(old => old && ({ ...old, ids: [...new Set([...old.ids, ...shown.map(row => row.id)])] }));
  }, [queueMore, loading, shown]);
  const list = useRef<HTMLDivElement>(null), returnPosition = useRef<{ node: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!opened && returnPosition.current && !loading) {
      returnPosition.current.node.scrollTop = returnPosition.current.top;
      returnPosition.current = null;
    }
  }, [opened, loading]);
  const openReport = (id: string): void => {
    let node = list.current?.parentElement ?? null;
    while (node && !/(auto|scroll)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
    if (node) { returnPosition.current = { node, top: node.scrollTop }; node.scrollTop = 0; }
    setQueue({ ids: shown.map(row => row.id), index: shown.findIndex(row => row.id === id) });
  };
  const stepReport = (direction: number): void => {
    if (returnPosition.current) returnPosition.current.node.scrollTop = 0;
    setQueue(old => old && ({ ...old, index: Math.max(0, Math.min(old.ids.length - 1, old.index + direction)) }));
  };
  const allShownSelected = shown.length > 0 && shown.every(r => selected.has(r.id));

  const showExport = (label: string, text: string): void => {
    setExportLabel(label);
    setExportText(text);
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(text)
        .then(() => bus.emit('ui:toast', { msg: `${label} COPIED TO CLIPBOARD` }))
        .catch(() => bus.emit('ui:toast', { msg: `${label} READY BELOW — COPY IT FROM THE BOX` }));
    }
  };
  const exportAll = (): void => {
    void api.get<{ testers: unknown[]; exportedAt: string }>('/admin/tester/export')
      .then((r) => showExport('TESTER EXPORT', JSON.stringify(r, null, 2)))
      .catch((e: unknown) => setExportText(e instanceof ApiError ? e.message : 'export failed'));
  };
  const toggle = (id: string): void => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const exportFilter: ExportFilter = filter === 'all' ? {} : filter === 'unexported' ? { exported: false } : filter === 'android' ? { client: 'android-native' } : filter === 'fixed' ? { fixed: true } : { status: filter };
  if (exportsOpen) return <AdminFeedbackExports wallet={wallet} selectedIds={[...selected]} filter={exportFilter} filterLabel={FILTERS.find(f => f.key === filter)?.label ?? filter} onBack={() => { setExportsOpen(false); reload(); }} />;
  if (catalogue) return <AdminIssueCatalogue wallet={wallet} onBack={()=>setCatalogue(false)}/>;
  if (opened && queue) return <FeedbackThread wallet={wallet} mode="admin" reportId={opened}
    navigation={{ position: queue.index + 1, total: queue.ids.length,
      ...(queue.index > 0 ? { onPrevious: () => stepReport(-1) } : {}),
      ...(queue.index + 1 < queue.ids.length ? { onNext: () => stepReport(1) } : {}),
      ...(nextCursor ? { onMore: () => { if (!loading) { setQueueMore(true); more(); } } } : {}),
      loadingMore: loading, error }}
    onBack={() => { setQueue(null); setQueueMore(false); reload(); }} onChanged={reload}
    onTrashChanged={id => setSelected(old => { const next = new Set(old); next.delete(id); return next; })} />;
  return (
    <div ref={list} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div aria-label="Feedback filters" style={{ display: 'flex', gap: 6 }}>
        {FILTERS.filter(f => ['new', 'accepted', 'fixed'].includes(f.key)).map(f => <Btn key={f.key}
          variant={!trash && filter === f.key ? 'gold' : 'ghost'} fontSize={18} style={{ flex: 1, minHeight: 44 }}
          onClick={() => { setTrash(false); if (filter === f.key) reload(); else setFilter(f.key); }}>{f.label}</Btn>)}
      </div>
      <div style={{ color: C.textDim, fontSize: 16 }}>{trash ? 'TRASH' : FILTERS.find(f => f.key === filter)?.label} · {shown.length} loaded report{shown.length === 1 ? '' : 's'}</div>
      <details open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)}>
        <summary className="interactive" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', color: C.textDim }}>MORE TOOLS{selected.size ? ` · ${selected.size} SELECTED` : ''}</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}><Btn variant={!trash ? 'gold' : 'ghost'} onClick={() => setTrash(false)} style={{ minHeight: 44 }}>ACTIVE</Btn><Btn variant={trash ? 'gold' : 'ghost'} onClick={() => setTrash(true)} style={{ minHeight: 44 }}>TRASH</Btn></div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {FILTERS.filter(f => !['new', 'accepted', 'fixed'].includes(f.key)).map(f => <Btn key={f.key}
              variant={!trash && filter === f.key ? 'gold' : 'ghost'} fontSize={14} style={{ flex: 1, minWidth: 80, minHeight: 44 }}
              onClick={() => { setTrash(false); if (filter === f.key) reload(); else setFilter(f.key); }}>{f.label}</Btn>)}
          </div>
          <Btn variant="gold" fontSize={14} disabled={trash} onClick={() => setExportsOpen(true)}>PRIVATE EXPORTS ({selected.size} SELECTED)</Btn>
          <Btn variant="sec" fontSize={14} disabled={trash || shown.length === 0}
            onClick={() => setSelected(old => allShownSelected ? new Set() : new Set([...old, ...shown.map(r => r.id)]))}>
            {allShownSelected ? 'CLEAR SELECTION' : `SELECT ALL SHOWN (${shown.length})`}
          </Btn>
          <Btn variant="ghost" fontSize={14} onClick={exportAll}>EXPORT TESTERS (WALLETS + POINTS)</Btn>
          <Btn variant="ghost" fontSize={16} onClick={() => setCatalogue(true)} style={{ minHeight: 44 }}>CURATED ISSUES</Btn>
          {exportText && <textarea readOnly value={exportText} rows={10} aria-label={exportLabel || 'Export'}
            style={{ fontFamily: 'monospace', fontSize: 12, background: C.surface, color: C.text, border: `2px solid ${C.borderLt}`, padding: 8 }} />}
        </div>
      </details>
      {loading && !data && <div style={{ color: C.textFaint, fontSize: 16 }}>LOADING…</div>}
      {error && <div style={{ color: C.danger, fontSize: 15 }}>{error.toUpperCase()}</div>}
      {data && shown.length === 0 && <div style={{ color: C.textFaint, fontSize: 16 }}>NO {trash ? 'TRASHED' : FILTERS.find((f) => f.key === filter)?.label} FEEDBACK</div>}
      {shown.map((row) => (
        <FeedbackCard key={row.id} row={row} selectionVisible={toolsOpen} selected={selected.has(row.id)} onToggle={() => toggle(row.id)} onRated={reload} onStateChanged={(applied) => { if (applied) setSelected(old => { const next = new Set(old); next.delete(row.id); return next; }); reload(); }} onOpen={() => openReport(row.id)} />
      ))}
      {nextCursor && <Btn disabled={loading} onClick={more}>LOAD MORE REPORTS</Btn>}
    </div>
  );
}

function FeedbackCard({ row, selectionVisible, selected, onToggle, onRated, onOpen, onStateChanged }: {
  row: FeedbackRow; selectionVisible: boolean; selected: boolean; onToggle: () => void; onRated: () => void; onOpen: () => void; onStateChanged: (applied: boolean) => void;
}): React.JSX.Element {
  const wallet = useApp(s => s.wallet);
  const trashed = !!(row.trashed || row.trashedAt);
  const ctx = row.context ? Object.entries(row.context).map(([k, v]) => `${k}=${String(v)}`).join(' · ') : '';
  return (
    <Chip style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, ...(selected ? { outline: `2px solid ${C.goldHi}` } : {}) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flex: 1, minWidth: 0 }}>
          {selectionVisible && <input type="checkbox" disabled={trashed} checked={selected} onChange={onToggle} aria-label={`Select "${row.title}" for export`} style={{ marginTop: 3 }} />}
          <span style={{ color: C.text, fontSize: 18, overflowWrap: 'anywhere' }}>{row.title}</span>
        </div>
        <span style={{ color: C.goldHi, fontSize: 15, flex: 'none' }}>+{row.points}</span>
      </div>
      <div style={{ color: C.textFaint, fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-all' }}>
        {row.name || 'KEEPER'} · {row.category.toUpperCase()} · {row.createdAt.slice(0, 10)}
      </div>
      <FeedbackOriginBadge context={row.context} />
      {!isFixed(row) && <div data-testid="report-status">{row.status.toUpperCase()}</div>}
      {(isFixed(row) || row.exported === true || (row.exported === undefined && row.exportedAt)) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {isFixed(row) && (
            <span data-testid="fixed-badge" style={{ color: C.goldHi, fontSize: 12, border: `1px solid ${C.goldHi}`, padding: '2px 6px' }}>
              FIXED{row.fixedAt ? ` ${row.fixedAt.slice(0, 10)}` : ''}{row.fixedRef ? ` · ${row.fixedRef}` : ''}
            </span>
          )}
          {(row.exported === true || (row.exported === undefined && row.exportedAt)) && (
            <span data-testid="exported-badge" style={{ color: C.textFaint, fontSize: 12, border: `1px solid ${C.borderLt}`, padding: '2px 6px' }}>
              EXPORTED{row.lastExportedRevision ? ` THROUGH REVISION ${row.lastExportedRevision}` : row.exportedAt ? ` ${stamp(row.exportedAt)}` : ''}
            </span>
          )}
        </div>
      )}
      <div style={{ color: C.textDim, fontSize: 14, lineHeight: 1.35, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{row.body}</div>
      {row.unread === true && <div>UNREAD THREAD UPDATES</div>}
      <Btn fontSize={18} style={{ minHeight: 44 }} onClick={onOpen}>OPEN REPORT</Btn>
      {trashed && <div>IN TRASH — READ ONLY</div>}
      <details><summary className="interactive" style={{ cursor: 'pointer', color: C.textDim, minHeight: 44, display: 'flex', alignItems: 'center' }}>REPORT DETAILS & ACTIONS</summary>
      <div style={{ color: C.textFaint, fontSize: 13, overflowWrap: 'anywhere' }}>{row.wallet} · {stamp(row.createdAt)} UTC</div>
      {ctx && <div style={{ color: C.textFaint, fontSize: 13, overflowWrap: 'anywhere' }}>{ctx}</div>}
      {wallet && row.revision && <AdminFeedbackStateAction wallet={wallet} reportId={row.id} revision={row.revision} kind="trash" current={trashed} status={triageOf(row)} disabled={false} onChanged={onStateChanged} />}
      {!trashed && wallet && row.revision && <AdminFeedbackStateAction wallet={wallet} reportId={row.id} revision={row.revision} kind="fixed" current={isFixed(row)} status={triageOf(row)} disabled={false} onChanged={onRated} />}
      </details>
    </Chip>
  );
}
