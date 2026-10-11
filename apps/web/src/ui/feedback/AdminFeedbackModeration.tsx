import { FEEDBACK_ISSUES, FEEDBACK_THREADS, type FeedbackReportDto } from '@shardkeep/shared/feedback';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, COLORS as C } from '../primitives';
import AdminIssueEditor from './AdminIssueEditor';
interface Issue { id: string; title: string; revision: number; status: string; mergedInto: string | null; publishedAt: string | null }
type Intent = { kind: 'link'; body: { requestId: string; issueId: string; expectedIssueRevision: number; expectedReportRevision: number; reason: string } }
  | { kind: 'lock'; body: { requestId: string; locked: boolean; reason: string } };
const style = { width: '100%', minHeight: 44, font: 'inherit', fontSize: 17, boxSizing: 'border-box' as const, background: C.surface, color: C.text, padding: 8 };
/** Staff-only controls. Linking exposes no private report text; only a lock
 * reason is deliberately sent to the player's conversation by the server. */
export default function AdminFeedbackModeration({ wallet, report, disabled, onChanged, onPending }: {
  wallet: string; report: FeedbackReportDto; disabled: boolean; onChanged: () => void; onPending: (value: boolean) => void;
}): React.JSX.Element {
  const currentWallet = useApp(s => s.wallet), key = `pkw:feedback-moderation:v1:${JSON.stringify([wallet, report.id])}`;
  const [pending, setPending] = useState<Intent | null>(() => {
    try { const raw = localStorage.getItem(key); if (!raw) return null; const value = JSON.parse(raw) as Intent;
      if (!value || !['link','lock'].includes(value.kind) || !value.body || typeof value.body.requestId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.body.requestId)
        || value.body.requestId.length > FEEDBACK_THREADS.requestIdMaxLen || typeof value.body.reason !== 'string' || !value.body.reason.trim() || value.body.reason.length > FEEDBACK_THREADS.moderationReasonMaxLen
        || (value.kind === 'link' && (typeof value.body.issueId !== 'string' || !Number.isSafeInteger(value.body.expectedIssueRevision) || value.body.expectedIssueRevision < 1 || !Number.isSafeInteger(value.body.expectedReportRevision) || value.body.expectedReportRevision < 1))
        || (value.kind === 'lock' && typeof value.body.locked !== 'boolean')) throw new Error('Invalid saved moderation'); return value;
    } catch { return null; }
  });
  const [reason, setReason] = useState(pending?.body.reason ?? ''), [query, setQuery] = useState(''), [search, setSearch] = useState('');
  const [issues, setIssues] = useState<Issue[]>([]), [cursor, setCursor] = useState<string | null>(null), [choice, setChoice] = useState('');
  const [creating, setCreating] = useState(false), [showLink, setShowLink] = useState(!report.linkedIssue || !!report.linkedIssue.mergedInto || report.linkedIssue.status === 'merged');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const active = useRef(false), request = useRef(0), mutation = useRef<AbortController | null>(null), reads = useRef(new Set<AbortController>());
  useEffect(() => () => onPending(false), [onPending]);
  useEffect(() => { onPending(!!pending || busy || creating); }, [pending, busy, creating, onPending]);
  useEffect(() => {
    active.current = true; const abort = () => { mutation.current?.abort(); for (const c of reads.current) c.abort(); };
    const off = useApp.subscribe(s => { if (s.wallet !== wallet) abort(); });
    return () => { active.current = false; abort(); off(); };
  }, [wallet]);
  const load = useCallback(async (after?: string): Promise<void> => {
    if (useApp.getState().wallet !== wallet) return; const epoch = ++request.current, controller = new AbortController(); reads.current.add(controller); setLoading(true);
    if (!after) { setIssues([]); setChoice(''); setCursor(null); }
    try {
      const params = new URLSearchParams({ query: search, ...(after ? { cursor: after } : {}) });
      const result = await api.get<{ issues: Issue[]; nextCursor: string | null }>(`/admin/tester/issues?${params}`, { signal: controller.signal });
      if (!controller.signal.aborted && active.current && epoch === request.current && useApp.getState().wallet === wallet) {
        setIssues(old => after ? [...new Map([...old,...result.issues].map(i => [i.id,i])).values()] : result.issues); setCursor(result.nextCursor);
      }
    } catch (cause) { if (!controller.signal.aborted && active.current && epoch === request.current) setError(cause instanceof Error ? cause.message : 'Issue catalogue unavailable.'); }
    finally { reads.current.delete(controller); if (active.current && epoch === request.current) setLoading(false); }
  }, [search, wallet]);
  useEffect(() => { void load(); }, [load]);
  const selected = issues.find(i => i.id === choice);
  const save = async (kind: Intent['kind']): Promise<void> => {
    if (report.trashed || report.trashedAt || disabled || mutation.current || currentWallet !== wallet || (!pending && (!reason.trim() || (kind === 'link' && (!selected || selected.mergedInto || selected.status === 'merged' || !report.revision))))) return;
    const next: Intent = pending ?? (kind === 'link' ? { kind, body: { requestId: crypto.randomUUID(), issueId: selected!.id, expectedIssueRevision: selected!.revision, expectedReportRevision: report.revision!, reason: reason.trim() } }
      : { kind, body: { requestId: crypto.randomUUID(), locked: !report.locked, reason: reason.trim() } });
    try { const raw = localStorage.getItem(key); if (raw !== null && (!pending || raw !== JSON.stringify(pending))) throw new Error('Moderation changed in another tab. Reopen this report.');
      const saved = JSON.stringify(next); localStorage.setItem(key,saved); if(localStorage.getItem(key)!==saved)throw new Error('Moderation recovery needs working site storage.');
    } catch (cause) { setError(String(cause)); return; }
    setPending(next); setBusy(true); setError(null); const controller = new AbortController(); mutation.current = controller;
    try {
      await api.postRaw(`/admin/tester/feedback/${report.id}/${next.kind}`, next.body, { signal: controller.signal });
      if (controller.signal.aborted || !active.current || useApp.getState().wallet !== wallet) return;
      if(localStorage.getItem(key)!==JSON.stringify(next))throw new Error('Moderation changed. Reopen this report.');
      localStorage.removeItem(key); if(localStorage.getItem(key)!==null)throw new Error('Could not clear saved moderation receipt. Retry the same action.');
      setPending(null); if (next.kind === 'link') setShowLink(false); setNotice(next.kind==='link'?'CANONICAL ISSUE LINKED':'REPLY ACCESS UPDATED'); onChanged();
    } catch(cause) {
      if(controller.signal.aborted||!active.current)return;
      if(cause instanceof ApiError && [400,403,404,409,422].includes(cause.status)) {
        try { if(localStorage.getItem(key)!==JSON.stringify(next))throw new Error('Saved moderation changed. Reopen this report.'); localStorage.removeItem(key); if(localStorage.getItem(key)!==null)throw new Error('Could not update moderation recovery.'); setPending(null); }
        catch(storageCause){setError(String(storageCause));return;}
        void load(); onChanged(); setError(`${cause.message} Refresh complete when loading ends; review and confirm again.`);
      } else setError(cause instanceof Error?cause.message:'Action interrupted. Retry the same saved action.');
    } finally { mutation.current=null;if(active.current)setBusy(false); }
  };
  if(currentWallet!==wallet)return <div>ACCOUNT CHANGED — REOPEN FEEDBACK</div>;
  if (report.trashed || report.trashedAt) return <div>IN TRASH — RESTORE THE REPORT TO MAKE CHANGES.</div>;
  return <section aria-label="Issue linking and reply access" style={{display:'flex',flexDirection:'column',gap:8,minWidth:0}}>
    <strong>1. LINK AN ISSUE TO REWARD THIS REPORT</strong>
    <div>CANONICAL ISSUE: {report.linkedIssue?.title ?? 'NOT LINKED'}</div>
    {report.linkedIssue && <Btn variant="ghost" disabled={disabled || busy || !!pending} onClick={() => setShowLink(v => !v)}>{showLink ? 'HIDE ISSUE SEARCH' : 'CHANGE LINKED ISSUE'}</Btn>}
    {(showLink || pending?.kind === 'link') && <>
    <label>SEARCH STAFF ISSUE CATALOGUE<input aria-label="Staff issue search" value={query} maxLength={FEEDBACK_ISSUES.queryMaxLen} disabled={busy||!!pending} onChange={e=>setQuery(e.target.value)} style={style}/></label>
    <Btn variant="ghost" onClick={()=>{if(search===query)void load();else setSearch(query);}} disabled={busy||loading||!!pending}>SEARCH ISSUES</Btn>
    <select aria-label="Canonical issue" value={choice} onChange={e=>setChoice(e.target.value)} disabled={busy||loading||!!pending} style={style}><option value="">CHOOSE AN ISSUE</option>{issues.map(i=><option key={i.id} value={i.id} disabled={!!i.mergedInto||i.status==='merged'}>{i.title}{i.publishedAt?'':' · DRAFT'}</option>)}</select>
    {cursor&&<Btn onClick={()=>{void load(cursor);}} disabled={busy||loading||!!pending}>LOAD MORE ISSUES</Btn>}
    {loading&&<div role="status">LOADING ISSUES…</div>}
    <Btn variant="sec" disabled={disabled || busy || !!pending || creating} onClick={() => setCreating(true)}>CREATE PRIVATE ISSUE</Btn>
    {creating && <AdminIssueEditor wallet={wallet} issue={null} privateOnly creationScope={`report:${report.id}`} onBack={() => setCreating(false)} onSaved={receipt => {
      setCreating(false);
      setIssues(old => [{ id: receipt.issueId, revision: receipt.revision, title: receipt.fields.title, status: receipt.fields.status, publishedAt: receipt.publishedAt, mergedInto: null }, ...old.filter(i => i.id !== receipt.issueId)]);
      setChoice(receipt.issueId); setNotice('PRIVATE ISSUE CREATED — ADD A LINK REASON AND CONFIRM LINKING BELOW.');
    }} />}
    </>}
    <label>{pending?.kind==='lock'?'REASON SHARED WITH PLAYER':'REASON — LINK REASONS ARE PRIVATE; LOCK REASONS ARE SHARED WITH PLAYER'}<textarea aria-label="Moderation reason" value={reason} onChange={e=>setReason(e.target.value)} maxLength={FEEDBACK_THREADS.moderationReasonMaxLen} disabled={busy||!!pending} style={style}/></label>
    {pending?<Btn onClick={()=>{void save(pending.kind);}} disabled={busy||disabled}>RETRY SAVED MODERATION</Btn>:<>
      {showLink && <Btn onClick={()=>{void save('link');}} disabled={disabled||busy||loading||creating||!selected||!!selected.mergedInto||selected.status==='merged'||!reason.trim()}>LINK CANONICAL ISSUE</Btn>}
      <details><summary>ADVANCED: PLAYER REPLY ACCESS</summary><Btn onClick={()=>{void save('lock');}} disabled={disabled||busy||creating||!reason.trim()}>{report.locked?'UNLOCK REPLIES':'LOCK REPLIES'}</Btn></details>
    </>}
    {error&&<div role="alert">{error}</div>}{notice&&<div role="status">{notice}</div>}
  </section>;
}
