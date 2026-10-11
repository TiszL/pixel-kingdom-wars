import { FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, COLORS as C } from '../primitives';

type Kind = 'fixed' | 'trash';
interface Intent { requestId: string; expectedRevision: number; value: boolean; reason: string; fixedRef?: string }
interface Props { wallet: string; reportId: string; revision: number; kind: Kind; current: boolean; status: string; disabled?: boolean; quickFix?: boolean; onPending?: (pending: boolean) => void; onChanged: (applied: boolean) => void }
/** Report state is independent of rewards, curated issue status and reply closure. */
export default function AdminFeedbackStateAction(props: Props): React.JSX.Element {
  return <Action key={JSON.stringify([props.wallet, props.reportId, props.kind])} {...props} />;
}
function Action({ wallet, reportId, revision, kind, current, status, disabled = false, quickFix = false, onPending, onChanged }: Props): React.JSX.Element {
  const account = useApp(s => s.wallet), key = `pkw:feedback-state:v1:${JSON.stringify([wallet, reportId, kind])}`;
  const [pending, setPending] = useState<Intent | null>(() => {
    try { const r = JSON.parse(localStorage.getItem(key) ?? 'null') as Intent | null;
      return r && typeof r.requestId === 'string' && /^[A-Za-z0-9_-]+$/.test(r.requestId) && r.requestId.length <= FEEDBACK_THREADS.requestIdMaxLen
        && Number.isSafeInteger(r.expectedRevision) && r.expectedRevision > 0 && typeof r.value === 'boolean' && typeof r.reason === 'string'
        && r.reason.trim() && r.reason.length <= FEEDBACK_THREADS.moderationReasonMaxLen && (r.fixedRef === undefined || (typeof r.fixedRef === 'string' && r.fixedRef.length <= FEEDBACK_THREADS.fixedRefMaxLen)) ? r : null;
    } catch { return null; }
  });
  const [open, setOpen] = useState(!!pending), [reason, setReason] = useState(pending?.reason ?? ''), [fixedRef, setFixedRef] = useState(pending?.fixedRef ?? '');
  const [preview, setPreview] = useState(!!pending), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reviewed = useRef<string | null>(null), ctrl = useRef<AbortController | null>(null), live = useRef(false);
  const consent = JSON.stringify([revision, current, status, reason.trim(), fixedRef.trim()]);
  useEffect(() => { live.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet) ctrl.current?.abort(); }); return () => { live.current = false; ctrl.current?.abort(); off(); }; }, [wallet]);
  useEffect(() => { onPending?.(!!pending || busy); }, [pending, busy, onPending]);
  useEffect(() => () => onPending?.(false), [onPending]);
  // A saved request already owns its immutable revision and payload. Other
  // pending controls may block new actions, but must not strand its receipt.
  const blocked = disabled && !pending;
  const desired = pending?.value ?? !current;
  const label = kind === 'fixed' ? desired ? 'MARK FIXED' : 'REOPEN AS ACCEPTED' : desired ? 'MOVE TO TRASH' : 'RESTORE REPORT';
  const fixedConflict = kind === 'fixed' && desired && !pending && status !== 'accepted';
  const save = async (quick = false): Promise<void> => {
    const oneClick = quick && quickFix && kind === 'fixed' && desired;
    if (blocked || fixedConflict || ctrl.current || account !== wallet || useApp.getState().wallet !== wallet || (!pending && ((!oneClick && (!preview || !reason.trim())) || !Number.isSafeInteger(revision) || revision < 1))) return;
    if (!pending && !oneClick && reviewed.current !== consent) { setPreview(false); setError('Report changed. Review this action again.'); return; }
    const intent = pending ?? { requestId: crypto.randomUUID(), expectedRevision: revision, value: desired, reason: oneClick ? 'The team has marked this report as fixed.' : reason.trim(), ...(!oneClick && kind === 'fixed' && desired && fixedRef.trim() ? { fixedRef: fixedRef.trim() } : {}) };
    try { const old = localStorage.getItem(key); if (old !== null && (!pending || old !== JSON.stringify(pending))) throw Error('Saved action changed. Reopen this report.'); const raw = JSON.stringify(intent); localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw Error('Recovery could not be saved. No action sent.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Recovery needs working site storage.'); return; }
    setPending(intent); setBusy(true); setError(null); setNotice(null); const controller = new AbortController(); ctrl.current = controller;
    try {
      await api.postRaw(`/admin/tester/feedback/${reportId}/${kind}`, { requestId: intent.requestId, expectedRevision: intent.expectedRevision, reason: intent.reason,
        ...(kind === 'fixed' ? { fixed: intent.value, ...(intent.fixedRef ? { fixedRef: intent.fixedRef } : {}) } : { trashed: intent.value }) }, { signal: controller.signal });
      if (!live.current || controller.signal.aborted || useApp.getState().wallet !== wallet) return;
      if (localStorage.getItem(key) !== JSON.stringify(intent)) throw Error('Saved action changed. Reopen to recover its result.');
      localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('Could not clear recovery. Retry the same action.');
      setPending(null); setPreview(false); setOpen(false); setReason(''); setFixedRef('');
      setNotice(kind === 'fixed' ? intent.value ? 'MARKED FIXED · Points, replies and screenshots retained.' : 'REOPENED AS ACCEPTED' : 'REPORT ACTION SAVED'); onChanged(true);
    } catch (cause) {
      if (!live.current || controller.signal.aborted) return;
      if (cause instanceof ApiError && [400,403,404,409,410,422].includes(cause.status)) {
        try { if (localStorage.getItem(key) !== JSON.stringify(intent)) throw Error('Saved action changed. Reopen this report.'); localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('Could not clear recovery. Reopen this report.'); setPending(null); setPreview(false); onChanged(false); }
        catch (storageCause) { setError(storageCause instanceof Error ? storageCause.message : 'Recovery needs working site storage.'); return; }
      }
      setError(cause instanceof Error ? `${cause.message} Review the current report before continuing.` : 'Action interrupted. Retry the saved action.');
    } finally { ctrl.current = null; if (live.current) setBusy(false); }
  };
  if (account !== wallet) return <></>;
  if (quickFix && !pending && !current && status !== 'accepted') return <></>;
  const form = <>
      <label>{kind === 'trash' ? 'PRIVATE ADMIN REASON' : 'REASON — SHARED WITH PLAYER'}<textarea aria-label={`${kind} reason`} value={reason} maxLength={FEEDBACK_THREADS.moderationReasonMaxLen} disabled={disabled || busy || !!pending}
        onChange={e => { setReason(e.target.value); setPreview(false); }} style={{ font: 'inherit', width: '100%', minHeight: 80, boxSizing: 'border-box', color: C.text, background: C.surface }} /></label>
      {kind === 'fixed' && desired && <label>FIX REFERENCE (OPTIONAL)<input aria-label="Report fix reference" value={fixedRef} maxLength={FEEDBACK_THREADS.fixedRefMaxLen} disabled={disabled || busy || !!pending}
        onChange={e => { setFixedRef(e.target.value); setPreview(false); }} style={{ font: 'inherit', minHeight: 44, width: '100%', boxSizing: 'border-box' }} /></label>}
      {!pending && <Btn disabled={disabled || busy || !reason.trim()} style={{ minHeight: 44 }} onClick={() => { reviewed.current = consent; setPreview(true); }}>REVIEW: {label}</Btn>}
      {preview && <><p>{kind === 'fixed' ? 'The report moves between Accepted and Fixed. Reopening returns it to Accepted. Points, replies and the linked issue stay unchanged; rewards are reviewed separately.' : desired ? 'Hide this report from the player and active lists. History, screenshots and rewards are retained. An admin can restore it.' : 'Return this report to active lists. Its history, Fixed state, reply closure and rewards are retained.'}</p>
        <Btn disabled={blocked || busy || fixedConflict} style={{ minHeight: 44 }} onClick={() => { void save(); }}>{pending ? 'RETRY SAVED REPORT ACTION' : `CONFIRM: ${label}`}</Btn></>}
  </>;
  return <section aria-label={`${kind} report action`} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    {quickFix && kind === 'fixed' && (desired || pending) ? <>
      <Btn disabled={blocked || busy || fixedConflict} fontSize={20} style={{ minHeight: 48, padding: '10px 8px 13px' }} onClick={() => { void save(true); }}>{busy ? 'SAVING…' : pending ? 'RETRY SAVED REPORT ACTION' : 'MARK FIXED'}</Btn>
      {pending ? <div>Confirmation was interrupted. Retry the same saved action to recover its result.</div> : <div style={{ fontSize: 16, color: C.textDim }}>Moves to Fixed. Points, replies and screenshots stay available.</div>}
    </> : !quickFix && <Btn variant="ghost" disabled={blocked || busy || fixedConflict} style={{ minHeight: 44 }} onClick={() => setOpen(v => !v)}>{label}</Btn>}
    {fixedConflict && <div>Accept this report before marking it Fixed.</div>}
    {quickFix ? !pending && <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary style={{ cursor: 'pointer', minHeight: 32 }}>{desired ? 'CUSTOM FIX NOTE / REFERENCE' : 'REOPEN REPORT'}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8 }}>{form}</div>
    </details> : open && form}
    {error && <div role="alert">{error}</div>}
    {notice && <div role="status">{notice}</div>}
  </section>;
}
