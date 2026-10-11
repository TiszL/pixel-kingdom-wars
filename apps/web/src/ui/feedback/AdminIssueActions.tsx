import { FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn } from '../primitives';
import type { AdminIssue } from './AdminIssueEditor';
type Intent = { kind: 'merge' | 'reopen'; requestId: string; reason: string; source: AdminIssue; target: AdminIssue | null };
type Receipt = { movedReportIds?: string[]; awardClaims?: Array<{ reportId: string; issueId: string; points: number }>; awardConflicts?: Array<{ reportId: string; issueId: string; points: number }> };
export default function AdminIssueActions({ wallet, issue, onBack }: { wallet: string; issue: AdminIssue; onBack: () => void }): React.JSX.Element {
  const key = `pkw:issue-action:v1:${JSON.stringify([wallet, issue.id])}`, currentWallet = useApp(s => s.wallet);
  const [pending, setPending] = useState<Intent | null>(() => { try { const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Intent | null; return value && ['merge', 'reopen'].includes(value.kind) && typeof value.requestId === 'string' && /^[A-Za-z0-9_-]+$/.test(value.requestId) && value.requestId.length <= FEEDBACK_THREADS.requestIdMaxLen && typeof value.reason === 'string' && value.reason.trim() && value.reason.length <= FEEDBACK_THREADS.moderationReasonMaxLen && value.source?.id === issue.id && Number.isSafeInteger(value.source.revision) && value.source.revision > 0 && (value.kind === 'reopen' ? value.target === null : !!value.target?.id && Number.isSafeInteger(value.target.revision) && value.target.revision > 0) ? value : null; } catch { return null; } });
  const [source, setSource] = useState(pending?.source ?? issue), [kind, setKind] = useState<'merge' | 'reopen'>(pending?.kind ?? 'merge'), [target, setTarget] = useState<AdminIssue | null>(pending?.target ?? null), [reason, setReason] = useState(pending?.reason ?? '');
  const [query, setQuery] = useState(''), [choices, setChoices] = useState<AdminIssue[]>([]), [cursor, setCursor] = useState<string | null>(null), [preview, setPreview] = useState(!!pending), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null);
  const active = useRef(false), controller = useRef<AbortController | null>(null), appliedQuery = useRef('');
  useEffect(() => { active.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet) controller.current?.abort(); }); return () => { active.current = false; controller.current?.abort(); off(); }; }, [wallet]);
  const valid = (): boolean => active.current && useApp.getState().wallet === wallet;
  const search = async (next?: string): Promise<void> => {
    if (!valid() || controller.current || pending) return;
    if (!next) appliedQuery.current = query;
    const ctrl = new AbortController(); controller.current = ctrl; setBusy(true); setError(null);
    try { const result = await api.get<{ issues: AdminIssue[]; nextCursor: string | null }>(`/admin/tester/issues?${new URLSearchParams({ query: appliedQuery.current, ...(next ? { cursor: next } : {}) })}`, { signal: ctrl.signal }); if (!valid() || ctrl.signal.aborted) return; setChoices(old => next ? [...new Map([...old, ...result.issues].map(i => [i.id, i])).values()] : result.issues); setCursor(result.nextCursor); } catch (e) { if (valid() && !ctrl.signal.aborted) setError(String(e)); } finally { controller.current = null; if (valid()) setBusy(false); }
  };
  const allowed = !source.mergedInto && source.status !== 'merged' && !!reason.trim() && (kind === 'reopen' ? ['fixed', 'closed'].includes(source.status) : !!target && target.id !== source.id && !target.mergedInto && target.status !== 'merged' && (!source.publishedAt || !!target.publishedAt));
  const submit = async (): Promise<void> => {
    if (!valid() || controller.current || (!pending && (!preview || !allowed))) return;
    const intent = pending ?? { kind, requestId: crypto.randomUUID(), reason: reason.trim(), source, target: kind === 'merge' ? target : null };
    try { const saved = localStorage.getItem(key); if (saved !== null && (!pending || saved !== JSON.stringify(pending))) throw Error('Saved action changed. Reopen this issue before continuing.'); const raw = JSON.stringify(intent); localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw Error('Cannot save recovery. No action sent.'); } catch (e) { setError(String(e)); return; }
    setPending(intent); setBusy(true); setError(null); const ctrl = new AbortController(); controller.current = ctrl;
    try {
      const body = intent.kind === 'reopen' ? { requestId: intent.requestId, reason: intent.reason, expectedRevision: intent.source.revision } : { requestId: intent.requestId, reason: intent.reason, targetIssueId: intent.target!.id, expectedSourceRevision: intent.source.revision, expectedTargetRevision: intent.target!.revision };
      const result = await api.postRaw<Receipt>(`/admin/tester/issues/${issue.id}/${intent.kind}`, body, { signal: ctrl.signal }); if (!valid() || ctrl.signal.aborted) return;
      if (localStorage.getItem(key) !== JSON.stringify(intent)) throw Error('Saved action changed. Reopen to recover its receipt.'); localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('Could not clear receipt. Retry this action.'); setPending(null); setReceipt(result);
    } catch (e) {
      if (!valid() || ctrl.signal.aborted) return;
      if (e instanceof ApiError && [400, 403, 404, 409, 422].includes(e.status)) {
        if (localStorage.getItem(key) === JSON.stringify(intent)) { localStorage.removeItem(key); if (localStorage.getItem(key) === null) { setPending(null); setPreview(false); setTarget(null); setChoices([]); try { const latest = await api.get<AdminIssue>(`/admin/tester/issues/${issue.id}`, { signal: ctrl.signal }); if (valid() && !ctrl.signal.aborted) setSource(latest); } catch { if (valid()) setSource(old => ({ ...old, mergedInto: 'refresh-required' })); } } }
      }
      if (valid() && !ctrl.signal.aborted) setError(`${e instanceof Error ? e.message : 'Action failed.'} Review current issue and target before confirming again.`);
    } finally { controller.current = null; if (valid()) setBusy(false); }
  };
  if (currentWallet !== wallet) return <div>ACCOUNT CHANGED — REOPEN ISSUES</div>;
  return <section aria-label="Issue actions" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    <Btn variant="ghost" disabled={busy} onClick={onBack}>BACK TO ISSUES</Btn><h3>{source.title}</h3>
    {receipt ? <><div role="status">ISSUE ACTION SAVED</div>{receipt.movedReportIds && <div>{receipt.movedReportIds.length} reports moved.</div>}<div>Existing rewards and private thread closure are unchanged.</div>{!!receipt.awardConflicts?.length && <div role="alert">HISTORICAL REWARD CONFLICTS — review staff history. No points were removed.</div>}{(receipt.awardClaims ?? receipt.awardConflicts ?? []).map((claim, index) => <div key={index} style={{ overflowWrap: 'anywhere' }}>Report {claim.reportId}: {claim.points} points retained from issue {claim.issueId}.</div>)}</> : <>
      <label>Action<select aria-label="Issue action" value={kind} disabled={busy || !!pending} onChange={e => { setKind(e.target.value as 'merge' | 'reopen'); setPreview(false); }} style={{ minHeight: 44, width: '100%', font: 'inherit' }}><option value="merge">MERGE INTO ANOTHER ISSUE</option><option value="reopen" disabled={!['fixed', 'closed'].includes(source.status)}>REOPEN ISSUE</option></select></label>
      {kind === 'merge' && <><input aria-label="Find merge target" value={query} disabled={busy || !!pending} onChange={e => setQuery(e.target.value)} style={{ minHeight: 44, minWidth: 0, font: 'inherit' }}/><Btn disabled={busy || !!pending} onClick={() => { void search(); }}>FIND TARGET ISSUE</Btn>{choices.map(choice => <Btn key={choice.id} variant="ghost" disabled={busy || !!pending || choice.id === source.id || !!choice.mergedInto || choice.status === 'merged' || (!!source.publishedAt && !choice.publishedAt)} onClick={() => { setTarget(choice); setPreview(false); }}>{choice.title} · {choice.publishedAt ? 'PUBLISHED' : 'DRAFT'}</Btn>)}{cursor && <Btn disabled={busy || !!pending} onClick={() => { void search(cursor); }}>MORE TARGETS</Btn>}{target && <div>Target: {target.title} · revision {target.revision}<p style={{ whiteSpace: 'pre-wrap' }}>{target.summary}</p></div>}</>}
      <label>Private staff reason<textarea aria-label="Issue action reason" value={reason} disabled={busy || !!pending} maxLength={FEEDBACK_THREADS.moderationReasonMaxLen} onChange={e => { setReason(e.target.value); setPreview(false); }} style={{ width: '100%', boxSizing: 'border-box', minHeight: 88, font: 'inherit' }}/></label>
      <Btn disabled={busy || !!pending || !allowed} onClick={() => setPreview(true)}>PREVIEW ACTION</Btn>
      {preview && <div aria-label="Issue action preview">{kind === 'merge' ? `Merge ${source.title} into ${target?.title}. All linked reports and confirmations move to that issue.` : `Reopen ${source.title}. Its fixed release will be cleared; closed private threads stay closed.`}<p>No rewards will be paid again or removed. Existing award claims remain in staff history.</p><Btn disabled={busy} onClick={() => { void submit(); }}>{pending ? 'RETRY SAVED ACTION' : 'CONFIRM ISSUE ACTION'}</Btn></div>}
    </>}{error && <div role="alert">{error}</div>}
  </section>;
}
