import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_THREADS, type FeedbackReportDto } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, COLORS as C } from '../primitives';
import AdminFeedbackStateAction from './AdminFeedbackStateAction';

type Importance = keyof typeof TESTER_PROGRAM.feedback.importanceBonus;
const levels: Importance[] = ['low', 'medium', 'high', 'critical'];
const states = ['new', 'reviewed', 'accepted', 'duplicate', 'rejected'];
const style = { width: '100%', minWidth: 0, minHeight: 44, boxSizing: 'border-box' as const, font: 'inherit', fontSize: 17, padding: 8, background: C.surface, color: C.text };

/** Historical ratings deliberately retain their existing replacement contract.
 * The policy-2 award endpoint must never be used to reinterpret these points. */
export default function AdminFeedbackLegacyReview({ wallet, report, disabled, onPending, onChanged }: {
  wallet: string; report: FeedbackReportDto; disabled: boolean; onPending?: (pending: boolean) => void; onChanged: () => void;
}): React.JSX.Element {
  const [status, setStatus] = useState(report.status === 'fixed' ? 'accepted' : report.status);
  const [importance, setImportance] = useState<Importance | ''>(report.importance as Importance ?? '');
  const [note, setNote] = useState(report.adminNote ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [fixedPending, setFixedPending] = useState(false);
  const currentWallet = useApp(s => s.wallet), controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setStatus(report.status === 'fixed' ? 'accepted' : report.status);
    setImportance(report.importance as Importance ?? ''); setNote(report.adminNote ?? '');
  }, [report.id, report.revision, report.status, report.importance, report.adminNote]);
  useEffect(() => { const off = useApp.subscribe(s => { if (s.wallet !== wallet) controller.current?.abort(); }); return () => { controller.current?.abort(); off(); }; }, [wallet]);
  useEffect(() => { onPending?.(busy || fixedPending); }, [busy, fixedPending, onPending]);
  useEffect(() => () => onPending?.(false), [onPending]);
  const total = (level: Importance | ''): number => (report.basePoints ?? report.points) +
    (level && status !== 'rejected' && status !== 'duplicate' ? TESTER_PROGRAM.feedback.importanceBonus[level] : 0);
  const quickImportance = (report.importance as Importance | null) ?? 'medium';
  const quickTotal = (report.basePoints ?? report.points) + TESTER_PROGRAM.feedback.importanceBonus[quickImportance];
  const accepted = report.status === 'accepted' || report.status === 'fixed' || !!report.fixedAt;
  const frozen = disabled || busy || fixedPending;
  const save = async (quick = false): Promise<void> => {
    if (disabled || fixedPending || controller.current || useApp.getState().wallet !== wallet) return;
    const ctrl = new AbortController(); controller.current = ctrl; setBusy(true); setError(null);
    try {
      const receipt = await api.postRaw<{ points: number }>(`/admin/tester/feedback/${report.id}/rate`, { status: quick ? 'accepted' : status, ...((quick ? quickImportance : importance) ? { importance: quick ? quickImportance : importance } : {}), note: quick ? report.adminNote ?? '' : note }, { signal: ctrl.signal });
      if (ctrl.signal.aborted || useApp.getState().wallet !== wallet) return;
      setNotice(`RATING SAVED · ${receipt.points} TOTAL POINTS`); onChanged();
    } catch (cause) { if (!ctrl.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not save rating. Refresh before trying again.'); }
    finally { if (!ctrl.signal.aborted) setBusy(false); controller.current = null; }
  };
  if (currentWallet !== wallet) return <div>ACCOUNT CHANGED — REOPEN FEEDBACK</div>;
  const quickReward = <Btn disabled={frozen || quickTotal < report.points || (accepted && quickTotal === report.points)} onClick={() => { void save(true); }} fontSize={20} style={{ minHeight: 48, padding: '10px 8px 13px' }}>
    {quickTotal < report.points ? 'EXISTING REWARD IS HIGHER' : accepted && quickTotal === report.points ? 'POINTS AWARDED' : `${accepted ? 'AWARD' : 'ACCEPT & AWARD'} +${quickTotal - report.points} POINTS`}
  </Btn>;
  return <section aria-label="Review & reward" style={{ display: 'flex', flexDirection: 'column', gap: 10, border: `2px solid ${C.gold}`, padding: 12 }}>
    <h3 style={{ margin: 0 }}>REVIEW & REWARD</h3>
    <div>{report.fixedAt || report.status === 'fixed' ? 'FIXED' : report.status.toUpperCase()} · {report.points} POINTS ALREADY AWARDED</div>
    {report.revision && <AdminFeedbackStateAction wallet={wallet} reportId={report.id} revision={report.revision} kind="fixed" current={!!report.fixedAt || report.status === 'fixed'} status={report.status} quickFix disabled={disabled || busy} onPending={setFixedPending} onChanged={onChanged} />}
    {error && <div role="alert">{error}</div>}{notice && <div role="status">{notice}</div>}
    {!accepted && quickReward}
    <details><summary>REVIEW OPTIONS · HISTORICAL RATING</summary>
    {accepted && quickReward}
    <div>This report uses the original rating rules. Changing importance replaces its bonus. Duplicate and rejected reports keep their original base points.</div>
    {report.fixedAt || report.status === 'fixed' ? <div>FIXED — reopen as Accepted to change status.</div> : <label>STATUS<select aria-label="Historical review status" value={status} disabled={frozen} onChange={e => setStatus(e.target.value)} style={style}>{states.map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}</select></label>}
    <label>IMPORTANCE<select aria-label="Historical reward importance" value={importance} disabled={frozen} onChange={e => setImportance(e.target.value as Importance)} style={style}><option value="">UNRATED</option>{levels.map(i => <option key={i} value={i}>{i.toUpperCase()} · {total(i) - report.points >= 0 ? '+' : ''}{total(i) - report.points} POINTS · {total(i)} TOTAL</option>)}</select></label>
    <label>NOTE TO PLAYER<textarea aria-label="Admin note" value={note} disabled={frozen} maxLength={FEEDBACK_THREADS.moderationReasonMaxLen} onChange={e => setNote(e.target.value)} style={style} /></label>
    <div>AFTER SAVING: {total(importance)} TOTAL POINTS</div>
    <Btn disabled={frozen} onClick={() => { void save(); }}>SAVE HISTORICAL RATING</Btn>
    </details>
  </section>;
}
