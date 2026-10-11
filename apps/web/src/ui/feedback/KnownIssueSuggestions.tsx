import { FEEDBACK_ISSUES as LIMIT, type FeedbackPublishedIssueDto } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, Chip, COLORS as C } from '../primitives';

export default function KnownIssueSuggestions({ wallet, query, category, onDifferent, onEvidence }: {
  wallet: string; query: string; category: string; onDifferent: () => void; onEvidence?: (issue: FeedbackPublishedIssueDto) => void;
}): React.JSX.Element {
  const [issues, setIssues] = useState<FeedbackPublishedIssueDto[]>([]), [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [hidden, setHidden] = useState(false), [retry, setRetry] = useState(0);
  const epoch = useRef(0), live = useRef(false), mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    live.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet) mutation.current?.abort(); });
    return () => { live.current = false; mutation.current?.abort(); off(); };
  }, [wallet]);
  useEffect(() => {
    const request = ++epoch.current, controller = new AbortController();
    setIssues([]); setSelected(null); setLoading(true); setError(null);
    const off = useApp.subscribe(s => { if (s.wallet !== wallet) controller.abort(); });
    const timer = setTimeout(() => {
      const search = new URLSearchParams({ query: query.trim().slice(0, LIMIT.queryMaxLen), category });
      void api.get<{ issues: FeedbackPublishedIssueDto[] }>(`/tester/issues?${search}`, { signal: controller.signal }).then(result => {
        if (!controller.signal.aborted && epoch.current === request && useApp.getState().wallet === wallet) setIssues(result.issues);
      }).catch((cause: unknown) => { if (!controller.signal.aborted && epoch.current === request) setError(cause instanceof Error ? cause.message : 'Could not load known issues.'); })
        .finally(() => { if (!controller.signal.aborted && epoch.current === request) setLoading(false); });
    }, LIMIT.searchDebounceMs);
    return () => { clearTimeout(timer); controller.abort(); off(); };
  }, [wallet, query, category, retry]);
  const confirm = async (id: string): Promise<void> => {
    if (mutation.current || confirmed.includes(id) || useApp.getState().wallet !== wallet) return;
    const controller = new AbortController(); mutation.current = controller; setBusy(true); setError(null);
    try {
      const issue = await api.postRaw<FeedbackPublishedIssueDto>(`/tester/issues/${encodeURIComponent(id)}/confirm`, {}, { signal: controller.signal });
      if (controller.signal.aborted || !live.current || useApp.getState().wallet !== wallet) return;
      setConfirmed(old => [...old, id]); setIssues(old => old.map(row => row.id === id ? issue : row));
    } catch (cause) { if (!controller.signal.aborted && live.current) setError(cause instanceof Error ? cause.message : 'Could not confirm. Try again.'); }
    finally { mutation.current = null; if (live.current) setBusy(false); }
  };
  if (useApp.getState().wallet !== wallet) return <div>ACCOUNT CHANGED — REOPEN FEEDBACK</div>;
  return <section aria-label="Known issue suggestions" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    <div style={{ color: C.gold }}>KNOWN ISSUES</div>
    <div style={{ fontSize: 14, color: C.textDim }}>These summaries are published by the team. Confirming a match records that you are affected; it earns no points and publishes none of your private evidence.</div>
    {hidden ? <Btn variant="ghost" fontSize={16} onClick={() => setHidden(false)} style={{ minHeight: 44 }}>SHOW KNOWN ISSUES</Btn> : <>
      {loading && <div role="status">CHECKING KNOWN ISSUES…</div>}
      {!loading && !error && !issues.length && <div>No matching published issue. Continue with your report below.</div>}
      {issues.map(issue => <Chip key={issue.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, minWidth: 0 }}>
        <Btn variant="ghost" fontSize={16} onClick={() => setSelected(selected === issue.id ? null : issue.id)} style={{ minHeight: 44, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{issue.title}</Btn>
        {selected === issue.id && <>
          <div>{issue.status.replaceAll('_', ' ').toUpperCase()} · {issue.affectedPlayerCount} AFFECTED</div>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{issue.summary}</div>
          {issue.workaround && <div>WORKAROUND: {issue.workaround}</div>}
          {issue.fixedRelease && <div>FIXED IN: {issue.fixedRelease}</div>}
          <Btn disabled={busy || confirmed.includes(issue.id)} onClick={() => { void confirm(issue.id); }} style={{ minHeight: 44 }}>
            {confirmed.includes(issue.id) ? 'CONFIRMED — THANK YOU' : 'I HAVE THIS TOO'}
          </Btn>
          {onEvidence && <Btn variant="ghost" fontSize={16} onClick={() => onEvidence(issue)} style={{ minHeight: 44 }}>ADD PRIVATE EVIDENCE</Btn>}
        </>}
      </Chip>)}
      {error && <div role="alert">{error}<Btn variant="ghost" fontSize={16} onClick={() => setRetry(n => n + 1)} style={{ minHeight: 44 }}>RETRY KNOWN ISSUES</Btn></div>}
      <Btn variant="ghost" fontSize={16} onClick={() => { setHidden(true); onDifferent(); }} style={{ minHeight: 44 }}>REPORT A DIFFERENT PROBLEM</Btn>
    </>}
  </section>;
}
