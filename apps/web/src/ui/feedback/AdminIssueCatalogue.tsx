import { FEEDBACK_ISSUES } from '@shardkeep/shared/feedback';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, Chip, COLORS as C } from '../primitives';
import Editor, { type AdminIssue } from './AdminIssueEditor';
import AdminIssueActions from './AdminIssueActions';
import AdminIssueSplit from './AdminIssueSplit';
interface History {
    id: string;
    action: string;
    reason: string;
    createdAt: string;
    admin: string;
    receipt: unknown;
}
export default function AdminIssueCatalogue({ wallet, onBack }: {
    wallet: string;
    onBack: () => void;
}): React.JSX.Element {
    const currentWallet = useApp(s => s.wallet), [query, setQuery] = useState(''), [published, setPublished] = useState(''), [issues, setIssues] = useState<AdminIssue[]>([]), [cursor, setCursor] = useState<string | null>(null);
    const [edit, setEdit] = useState<AdminIssue | null | undefined>(), [historyIssue, setHistoryIssue] = useState<AdminIssue | null>(null), [history, setHistory] = useState<History[]>([]), [historyCursor, setHistoryCursor] = useState<string | null>(null);
    const [splitIssue, setSplitIssue] = useState<AdminIssue | null>(null);
    const [actionIssue, setActionIssue] = useState<AdminIssue | null>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
    const epoch = useRef(0), controller = useRef<AbortController | null>(null), live = useRef(false);
    useEffect(() => { live.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet)
        controller.current?.abort(); }); return () => { live.current = false; controller.current?.abort(); off(); }; }, [wallet]);
    const filters = useRef({ query, published });
    filters.current = { query, published };
    const appliedFilters = useRef({ query, published });
    const load = useCallback(async (next?: string, forHistory?: AdminIssue): Promise<void> => {
        if (!next && !forHistory)
            appliedFilters.current = filters.current;
        const { query, published } = appliedFilters.current;
        if (useApp.getState().wallet !== wallet)
            return;
        controller.current?.abort();
        const ctrl = new AbortController();
        controller.current = ctrl;
        const request = ++epoch.current;
        setBusy(true);
        setError(null);
        try {
            if (forHistory) {
                const params = new URLSearchParams(next ? { cursor: next } : {});
                const result = await api.get<{
                    actions: History[];
                    nextCursor: string | null;
                }>(`/admin/tester/issues/${forHistory.id}/history?${params}`, { signal: ctrl.signal });
                if (ctrl.signal.aborted || request !== epoch.current || !live.current)
                    return;
                setHistory(old => next ? [...new Map([...old, ...result.actions].map(a => [a.id, a])).values()] : result.actions);
                setHistoryCursor(result.nextCursor);
                setHistoryIssue(forHistory);
            }
            else {
                const params = new URLSearchParams({ query, ...(published ? { published } : {}), ...(next ? { cursor: next } : {}) });
                const result = await api.get<{
                    issues: AdminIssue[];
                    nextCursor: string | null;
                }>(`/admin/tester/issues?${params}`, { signal: ctrl.signal });
                if (ctrl.signal.aborted || request !== epoch.current || !live.current)
                    return;
                setIssues(old => next ? [...new Map([...old, ...result.issues].map(i => [i.id, i])).values()] : result.issues);
                setCursor(result.nextCursor);
            }
        }
        catch (cause) {
            if (!ctrl.signal.aborted && live.current)
                setError(cause instanceof Error ? cause.message : 'Could not load staff issues.');
        }
        finally {
            if (live.current && request === epoch.current)
                setBusy(false);
        }
    }, [wallet]);
    useEffect(() => { void load(); }, [load]);
    if (currentWallet !== wallet)
        return <div>ACCOUNT CHANGED — REOPEN ISSUES</div>;
    if (splitIssue)
        return <AdminIssueSplit key={splitIssue.id} wallet={wallet} issue={splitIssue} onBack={() => { setSplitIssue(null); void load(); }} />;
    if (actionIssue)
        return <AdminIssueActions key={actionIssue.id} wallet={wallet} issue={actionIssue} onBack={() => { setActionIssue(null); void load(); }} />;
    if (edit !== undefined)
        return <Editor key={edit?.id ?? 'new'} wallet={wallet} issue={edit} onBack={() => setEdit(undefined)} onSaved={() => { setEdit(undefined); void load(); }}/>;
    return <section aria-label="Staff curated issues" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    <Btn variant="ghost" onClick={onBack}>BACK TO FEEDBACK</Btn><h3>CURATED ISSUES</h3>
    {historyIssue ? <>
      <Btn variant="ghost" onClick={() => { controller.current?.abort(); epoch.current++; setBusy(false); setHistoryIssue(null); }}>BACK TO ISSUE LIST</Btn><h4>{historyIssue.title} · PRIVATE STAFF HISTORY</h4>
      {history.map(action => <Chip key={action.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}><div>{action.action.toUpperCase()} · {action.createdAt.slice(0, 16).replace('T', ' ')} UTC</div><div style={{ fontSize: 14, overflowWrap: 'anywhere' }}>STAFF: {action.admin}</div><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{action.reason}</div></Chip>)}
      {historyCursor && <Btn disabled={busy} onClick={() => { void load(historyCursor, historyIssue); }}>LOAD EARLIER HISTORY</Btn>}
    </> : <>
      <input aria-label="Search curated issues" value={query} maxLength={FEEDBACK_ISSUES.queryMaxLen} onChange={e => setQuery(e.target.value)} style={{ font: 'inherit', minHeight: 44, width: '100%', boxSizing: 'border-box', background: C.surface, color: C.text }}/>
      <select aria-label="Issue publication filter" value={published} onChange={e => setPublished(e.target.value)} style={{ font: 'inherit', minHeight: 44 }}><option value="">ALL ISSUES</option><option value="false">DRAFTS</option><option value="true">PUBLISHED</option></select>
      <Btn disabled={busy} onClick={() => { void load(); }}>SEARCH CURATED ISSUES</Btn><Btn onClick={() => setEdit(null)}>CREATE CURATED ISSUE</Btn>
      {issues.map(issue => <Chip key={issue.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}><div>{issue.title} · {issue.status.toUpperCase()} · {issue.publishedAt ? 'PUBLISHED' : 'DRAFT'}</div>
        <Btn variant="ghost" disabled={!!issue.mergedInto || issue.status === 'merged'} onClick={() => setEdit(issue)}>EDIT ISSUE</Btn><Btn variant="ghost" disabled={!!issue.mergedInto || issue.status === 'merged'} onClick={() => setActionIssue(issue)}>MORE ISSUE ACTIONS</Btn><Btn variant="ghost" disabled={!!issue.mergedInto || issue.status === 'merged'} onClick={() => setSplitIssue(issue)}>SPLIT SELECTED REPORTS</Btn><Btn variant="ghost" disabled={busy} onClick={() => { setHistory([]); void load(undefined, issue); }}>VIEW STAFF HISTORY</Btn></Chip>)}
      {cursor && <Btn disabled={busy} onClick={() => { void load(cursor); }}>LOAD MORE ISSUES</Btn>}
    </>}
    {busy && <div role="status">LOADING…</div>}{error && <div role="alert">{error}<Btn onClick={() => { void load(undefined, historyIssue ?? undefined); }}>RETRY</Btn></div>}
  </section>;
}
