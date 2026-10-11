import { FEEDBACK_THREADS as LIMIT, type FeedbackThreadDto } from '@shardkeep/shared/feedback';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, COLORS as C } from '../primitives';
import AdminFeedbackModeration from './AdminFeedbackModeration';
import AdminFeedbackLegacyReview from './AdminFeedbackLegacyReview';
import AdminFeedbackStateAction from './AdminFeedbackStateAction';

type Status = 'reviewed' | 'accepted' | 'rejected' | 'duplicate';
type Verdict = 'unverified' | 'actionable' | 'not_actionable';
type Award = 'none' | 'first_actionable' | 'useful_evidence';
type Importance = 'low' | 'medium' | 'high' | 'critical';
interface Review { requestId: string; expectedRevision: number; status: Status; verdict: Verdict; award: Award; importance?: Importance; reason: string; verificationEvidence?: string; preparePrivateIssue?: boolean }
const statuses: Status[] = ['reviewed', 'accepted', 'rejected', 'duplicate'];
const verdicts: Verdict[] = ['unverified', 'actionable', 'not_actionable'];
const awards: Award[] = ['none', 'first_actionable', 'useful_evidence'];
const importanceLevels: Importance[] = ['low', 'medium', 'high', 'critical'];
const fieldStyle = { width: '100%', minWidth: 0, boxSizing: 'border-box' as const, minHeight: 44, font: 'inherit', fontSize: 17, padding: 8, background: C.surface, color: C.text };
/** Explicit policy-2 review only. Existing point totals are never inferred as
 * permission to grant another award; server revision and receipt remain final. */
export default function AdminFeedbackReview({ wallet, reportId, revision, disabled = false, onPending, onChanged }: {
  wallet: string; reportId: string; revision?: number; disabled?: boolean; onPending?: (pending: boolean) => void; onChanged: () => void;
}): React.JSX.Element {
  const currentWallet = useApp(s => s.wallet);
  const key = `pkw:feedback-review:v1:${JSON.stringify([wallet, reportId])}`;
  const [pending, setPending] = useState<Review | null>(() => {
    try { const raw = localStorage.getItem(key); if (!raw) return null; const r = JSON.parse(raw) as Review;
      if (!r || !statuses.includes(r.status) || !verdicts.includes(r.verdict) || !awards.includes(r.award) || typeof r.requestId !== 'string'
        || !/^[A-Za-z0-9_-]+$/.test(r.requestId) || r.requestId.length > LIMIT.requestIdMaxLen || !Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 1
        || (r.preparePrivateIssue !== undefined && typeof r.preparePrivateIssue !== 'boolean')
        || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > LIMIT.moderationReasonMaxLen
        || (r.importance !== undefined && !importanceLevels.includes(r.importance)) || (r.verificationEvidence !== undefined && (typeof r.verificationEvidence !== 'string' || r.verificationEvidence.length > LIMIT.moderationReasonMaxLen))) throw new Error('Invalid saved review');
      return r;
    } catch { return null; }
  });
  const [thread, setThread] = useState<FeedbackThreadDto | null>(null), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [readReady, setReadReady] = useState(false);
  const [status, setStatus] = useState<Status>(pending?.status ?? 'reviewed'), [verdict, setVerdict] = useState<Verdict>(pending?.verdict ?? 'unverified');
  const [award, setAward] = useState<Award>(pending?.award ?? 'none'), [importance, setImportance] = useState<Importance | ''>(pending?.importance ?? 'medium');
  const [reason, setReason] = useState(pending?.reason ?? ''), [evidence, setEvidence] = useState(pending?.verificationEvidence ?? '');
  const [moderationPending, setModerationPending] = useState(false);
  const [fixedPending, setFixedPending] = useState(false), [legacyPending, setLegacyPending] = useState(false);
  const [busy, setBusy] = useState(false), [revisionLoad, setRevisionLoad] = useState(0);
  const active = useRef(false), mutation = useRef<AbortController | null>(null);
  const initialized = useRef(!!pending);
  useEffect(() => { onPending?.(!!pending || busy || moderationPending || fixedPending || legacyPending); }, [pending, busy, moderationPending, fixedPending, legacyPending, onPending]);
  useEffect(() => () => onPending?.(false), [onPending]);
  useEffect(() => {
    active.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet) mutation.current?.abort(); });
    return () => { active.current = false; mutation.current?.abort(); off(); };
  }, [wallet]);
  useEffect(() => {
    if (currentWallet !== wallet) return undefined;
    const controller = new AbortController(); setReadReady(false);
    const off = useApp.subscribe(s => { if (s.wallet !== wallet) controller.abort(); });
    void api.get<FeedbackThreadDto>(`/admin/tester/feedback/${reportId}/thread`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted && useApp.getState().wallet === wallet) {
        setThread(value);
        setReadReady(true);
        if (!initialized.current) {
          initialized.current = true;
          setStatus(statuses.includes(value.report.status as Status) ? value.report.status as Status : value.report.status === 'fixed' ? 'accepted' : 'reviewed');
          setVerdict(value.report.verificationVerdict ?? 'unverified');
          setImportance(importanceLevels.includes(value.report.importance as Importance) ? value.report.importance as Importance : 'medium');
        }
      }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not refresh review.'); });
    return () => { controller.abort(); off(); };
  }, [wallet, currentWallet, reportId, revision, revisionLoad]);
  const linkedIssueId = thread?.report.linkedIssue && thread.report.linkedIssue.status !== 'merged' && !thread.report.linkedIssue.mergedInto ? thread.report.linkedIssue.id : null;
  const trashed = !!(thread?.report.trashed || thread?.report.trashedAt);
  const fixed = !!thread?.report.fixedAt || thread?.report.status === 'fixed';
  const reviewStatus = fixed ? 'accepted' : status;
  const fixedConflict = fixed && (reviewStatus === 'rejected' || reviewStatus === 'duplicate');
  const awardInvalid = award !== 'none' && (!linkedIssueId || verdict !== 'actionable' || !importance || !evidence.trim() || reviewStatus === 'rejected' || (award === 'first_actionable' && reviewStatus !== 'accepted'));
  const preview = (level: Importance, reward: Award = award): { total: number; delta: number } | null => {
    const report = thread?.report;
    if (!report || report.basePoints === undefined || report.bonusPoints === undefined) return null;
    const total = reward === 'none' ? report.points :
      (reward === 'first_actionable' ? Math.max(report.basePoints, TESTER_PROGRAM.feedback.basePoints) : report.basePoints)
      + Math.max(report.bonusPoints, TESTER_PROGRAM.feedback.importanceBonus[level]);
    return { total, delta: total - report.points };
  };
  const estimate = importance ? preview(importance) : null;
  const frozen = disabled || busy || !!pending || fixedPending || !readReady;
  const quickImportance = importance || 'medium';
  const quickEstimate = preview(quickImportance, 'first_actionable');
  const quickBlocked = !!thread?.report.linkedIssue && !linkedIssueId;
  const alreadyAccepted = thread?.report.status === 'accepted' || fixed;
  const quickLabel = `${alreadyAccepted ? 'AWARD' : 'ACCEPT & AWARD'} +${quickEstimate?.delta ?? '—'} POINTS`;
  const save = async (quick?: 'reward' | 'accept' | 'duplicate' | 'reject'): Promise<void> => {
    if (disabled || trashed || mutation.current || moderationPending || fixedPending || useApp.getState().wallet !== wallet || (!pending && (!readReady || !thread?.report.revision))) return;
    if (!pending && !quick && (!reason.trim() || awardInvalid || fixedConflict)) return;
    if (!pending && quick === 'reward' && (quickBlocked || !quickEstimate || (alreadyAccepted && quickEstimate.delta === 0))) return;
    if (!pending && fixed && quick && quick !== 'reward') return;
    const input: Review = pending ?? (quick ? {
      requestId: crypto.randomUUID(), expectedRevision: thread!.report.revision!,
      status: quick === 'reject' ? 'rejected' : quick === 'duplicate' ? 'duplicate' : 'accepted',
      verdict: quick === 'reward' ? 'actionable' : quick === 'reject' ? 'not_actionable' : thread?.report.verificationVerdict ?? 'unverified',
      award: quick === 'reward' ? 'first_actionable' : 'none',
      reason: quick === 'reward' ? 'Admin accepted this report as actionable using quick review.'
        : quick === 'accept' ? 'Admin accepted this report without additional points.'
        : quick === 'duplicate' ? 'Admin marked this report as a duplicate.' : 'Admin rejected this report after review.',
      ...(quick === 'reward' ? { importance: quickImportance, preparePrivateIssue: true,
        verificationEvidence: 'Admin reviewed this report and accepted it as actionable using quick review.' } : {}),
    } : { requestId: crypto.randomUUID(), expectedRevision: thread!.report.revision!, status: reviewStatus, verdict, award, reason: reason.trim(),
      ...(importance ? { importance } : {}), ...(evidence.trim() ? { verificationEvidence: evidence.trim() } : {}) });
    try {
      const old = localStorage.getItem(key);
      if (old !== null && (!pending || old !== JSON.stringify(pending))) throw new Error('Saved review changed. Close and reopen this panel to review it.');
      const raw = JSON.stringify(input); localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw new Error('Review recovery could not be saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Review recovery needs working site storage.'); return; }
    setPending(input); setBusy(true); setError(null); setNotice(null); const controller = new AbortController(); mutation.current = controller;
    try {
      const receipt = await api.postRaw<{ points: number; delta: number }>(`/admin/tester/feedback/${reportId}/review`, input, { signal: controller.signal });
      if (controller.signal.aborted || !active.current || useApp.getState().wallet !== wallet) return;
      if (localStorage.getItem(key) !== JSON.stringify(input)) throw new Error('Saved review changed. Reopen before continuing.');
      localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw new Error('Could not clear accepted review receipt. Retry the same review.');
      setPending(null); setAward('none'); setNotice(`REVIEW SAVED · ${receipt.points} TOTAL POINTS · ${receipt.delta} ADDED`); setRevisionLoad(n => n + 1); onChanged();
    } catch (cause) {
      if (controller.signal.aborted || !active.current) return;
      if (cause instanceof ApiError && [400, 403, 404, 409, 422].includes(cause.status)) {
        try {
          if (localStorage.getItem(key) !== JSON.stringify(input)) throw new Error('Saved review changed. Reopen before continuing.');
          localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw new Error('Could not update saved review. Retry after restoring site storage.');
          setPending(null);
        } catch (storageCause) { setError(storageCause instanceof Error ? storageCause.message : 'Review recovery needs working site storage.'); return; }
        setRevisionLoad(n => n + 1);
        setError(cause.code === 'FEEDBACK_REVIEW_STALE' ? 'Report changed. Refreshed its revision; review your choices and confirm again.' : `${cause.message} Review your choices before confirming again.`);
      } else setError(cause instanceof Error ? cause.message : 'Review interrupted. Retry the same saved review.');
    } finally { mutation.current = null; if (active.current) setBusy(false); }
  };
  if (currentWallet !== wallet) return <div>ACCOUNT CHANGED — REOPEN FEEDBACK</div>;
  if (trashed) return <div>IN TRASH — RESTORE THE REPORT TO REVIEW IT.</div>;
  if (thread?.report.rewardPolicyVersion === 1) return <><AdminFeedbackLegacyReview wallet={wallet} report={thread.report} disabled={disabled || (!readReady && !legacyPending)} onPending={setLegacyPending} onChanged={() => { setRevisionLoad(n => n + 1); onChanged(); }} />{!readReady && <div role="status">{error ?? 'REFRESHING CURRENT REVIEW…'} <Btn onClick={() => setRevisionLoad(n => n + 1)}>REFRESH</Btn></div>}</>;
  const quickReward = <>
    <Btn disabled={frozen || moderationPending || !thread || quickBlocked || !quickEstimate || (alreadyAccepted && quickEstimate.delta === 0)} onClick={() => { void save('reward'); }} fontSize={20} style={{ minHeight: 48, padding: '10px 8px 13px' }}>
      {alreadyAccepted && quickEstimate?.delta === 0 ? 'POINTS AWARDED' : quickLabel}
    </Btn>
    <div style={{ fontSize: 16, color: C.textDim }}>{quickImportance.toUpperCase()} reward{quickEstimate ? ` · ${quickEstimate.total} total points` : ''}. {alreadyAccepted ? 'Existing rewards and daily limits are preserved.' : 'One click saves acceptance and points.'}</div>
  </>;
  return <section aria-label="Review & reward" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, border: `2px solid ${C.gold}`, padding: 12 }}>
    <h3 style={{ margin: 0 }}>REVIEW & REWARD</h3>
    <div>{fixed ? 'FIXED' : thread?.report.status?.toUpperCase() ?? 'LOADING'} · {thread?.report.points ?? '—'} POINTS ALREADY AWARDED</div>
    {thread?.report.revision && <AdminFeedbackStateAction wallet={wallet} reportId={reportId} revision={thread.report.revision} kind="fixed" current={fixed} status={thread.report.status} quickFix disabled={disabled || busy || !!pending || moderationPending || (!readReady && !fixedPending)} onPending={setFixedPending} onChanged={() => { setRevisionLoad(n => n + 1); onChanged(); }} />}
    {error && <div role="alert">{error}</div>}{notice && <div role="status">{notice}</div>}
    {!readReady && (thread || error) && <div>CURRENT REVIEW UNAVAILABLE… <Btn onClick={() => setRevisionLoad(n => n + 1)}>REFRESH</Btn></div>}
    {pending ? <>
      <div>Confirmation was interrupted. Retry safely with the same saved decision.</div>
      <Btn disabled={disabled || busy || moderationPending || fixedPending} onClick={() => { void save(); }}>RETRY SAVED REVIEW</Btn>
    </> : <>
      {!alreadyAccepted && quickReward}
      {thread && !quickEstimate && <div role="status">Reward totals are unavailable. <Btn variant="ghost" onClick={() => setRevisionLoad(n => n + 1)}>REFRESH REWARD</Btn></div>}
      {quickBlocked && <div role="status">This issue was merged. Choose its current issue in Review options before awarding.</div>}
    </>}
    {moderationPending && !pending && <div role="status">An issue change is pending. Open Review options to finish or recover it before awarding points.</div>}
    <details>
      <summary style={{ cursor: 'pointer', minHeight: 32 }}>REVIEW OPTIONS</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
        {alreadyAccepted && !pending && quickReward}
        <label>IMPORTANCE<select aria-label="Reward importance" disabled={frozen} value={importance} onChange={e => setImportance(e.target.value as Importance)} style={fieldStyle}>{importanceLevels.map(i => { const p = preview(i, 'first_actionable'); return <option key={i} value={i}>{i.toUpperCase()}{p ? ` · +${p.delta} POINTS · ${p.total} TOTAL` : ''}</option>; })}</select></label>
        <div>Acceptance records your review as actionable. An unlinked report gets a private issue automatically. Existing points and reward limits are preserved.</div>
        {!fixed && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Btn variant="sec" disabled={frozen || moderationPending || !thread} onClick={() => { void save('accept'); }}>ACCEPT WITHOUT POINTS</Btn>
          <Btn variant="ghost" disabled={frozen || moderationPending || !thread} onClick={() => { void save('duplicate'); }}>DUPLICATE</Btn>
          <Btn variant="ghost" disabled={frozen || moderationPending || !thread} onClick={() => { void save('reject'); }}>REJECT</Btn>
        </div>}
        {thread && <AdminFeedbackModeration wallet={wallet} report={thread.report} disabled={frozen} onChanged={() => { setRevisionLoad(n => n + 1); onChanged(); }} onPending={setModerationPending} />}
        <details><summary>CUSTOM REVIEW & PRIVATE NOTES</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
            {fixed ? <div>REPORT STATUS: FIXED — reopen as Accepted to change status.</div> : <label>STATUS<select aria-label="Review status" disabled={frozen} value={status} onChange={e => setStatus(e.target.value as Status)} style={fieldStyle}>{statuses.map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}</select></label>}
            <label>VERDICT<select aria-label="Verification verdict" disabled={frozen} value={verdict} onChange={e => setVerdict(e.target.value as Verdict)} style={fieldStyle}>{verdicts.map(v => <option key={v} value={v}>{v.replaceAll('_',' ').toUpperCase()}</option>)}</select></label>
            <label>REWARD<select aria-label="Explicit reward" disabled={frozen} value={award} onChange={e => setAward(e.target.value as Award)} style={fieldStyle}>{awards.map(a => <option key={a} value={a} disabled={a !== 'none' && !linkedIssueId}>{a === 'none' ? 'NO AWARD — KEEP EXISTING POINTS' : a === 'first_actionable' ? 'FIRST VERIFIED ACTIONABLE REPORT' : 'USEFUL ADDITIONAL EVIDENCE'}</option>)}</select></label>
            {!linkedIssueId && <div>Link a verified canonical issue before awarding points in a custom review.</div>}
            {award !== 'none' && <>
              {estimate && <div role="status">EXPECTED REWARD: +{estimate.delta} POINTS · {estimate.total} TOTAL.</div>}
              <label>VERIFICATION NOTES — PRIVATE<textarea aria-label="Verification evidence" disabled={frozen} value={evidence} onChange={e => setEvidence(e.target.value)} maxLength={LIMIT.moderationReasonMaxLen} style={fieldStyle} /></label>
            </>}
            <label>REVIEW REASON — PRIVATE<textarea aria-label="Review reason" disabled={frozen} value={reason} onChange={e => setReason(e.target.value)} maxLength={LIMIT.moderationReasonMaxLen} style={fieldStyle} /></label>
            {awardInvalid && <div>A custom award needs a linked issue, actionable verdict, importance and verification notes.</div>}
            <Btn onClick={() => { void save(); }} disabled={frozen || moderationPending || !thread?.report.revision || !reason.trim() || awardInvalid || fixedConflict}>SAVE CUSTOM REVIEW</Btn>
          </div>
        </details>
      </div>
    </details>
  </section>;
}
