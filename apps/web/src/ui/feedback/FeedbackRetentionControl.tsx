import { FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn } from '../primitives';
type Target = { kind: 'closure'; current: boolean } | { kind: 'preservation'; attachmentId: string; current: boolean };
interface Intent { requestId: string; expectedRevision: number; reason: string; value: boolean }
/** Explicit staff action; preservation never changes reporter-visible history. */
export default function FeedbackRetentionControl({ wallet, reportId, revision, target, disabled, onPending, onChanged }: { wallet: string; reportId: string; revision: number; target: Target; disabled: boolean; onPending?: (scope: string, pending: boolean) => void; onChanged: () => void }): React.JSX.Element {
  const account = useApp(s => s.wallet), scope = target.kind === 'closure' ? 'closure' : target.attachmentId;
  const key = `pkw:feedback-retention:v1:${JSON.stringify([wallet, reportId, scope])}`;
  const [pending, setPending] = useState<Intent | null>(() => { try { const p = JSON.parse(localStorage.getItem(key) ?? 'null') as Intent | null; return p && typeof p.requestId === 'string' && /^[A-Za-z0-9_-]+$/.test(p.requestId) && p.requestId.length <= FEEDBACK_THREADS.requestIdMaxLen && Number.isSafeInteger(p.expectedRevision) && p.expectedRevision > 0 && typeof p.value === 'boolean' && typeof p.reason === 'string' && p.reason.trim() && p.reason.length <= FEEDBACK_THREADS.moderationReasonMaxLen ? p : null; } catch { return null; } });
  const [reason, setReason] = useState(pending?.reason ?? ''), [preview, setPreview] = useState(!!pending), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const reviewed = useRef<string | null>(null);
  const consent = JSON.stringify([revision, target.kind, target.current, scope]);
  const live = useRef(false), ctrl = useRef<AbortController | null>(null);
  useEffect(() => { live.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet) ctrl.current?.abort(); }); return () => { live.current = false; ctrl.current?.abort(); off(); }; }, [wallet]);
  useEffect(() => { onPending?.(scope, !!pending || busy); }, [scope, pending, busy, onPending]);
  useEffect(() => () => onPending?.(scope, false), [scope, onPending]);
  // Recovery reuses an already frozen request; another pending control must
  // not prevent it from recovering the receipt that releases its own lock.
  const blocked = disabled && !pending;
  const save = async (): Promise<void> => {
    if (blocked || ctrl.current || useApp.getState().wallet !== wallet || (!pending && (!preview || !reason.trim() || !Number.isSafeInteger(revision) || revision < 1))) return;
    if (!pending && reviewed.current !== consent) { setPreview(false); setError('The current state changed. Review this action again.'); return; }
    const intent = pending ?? { requestId: crypto.randomUUID(), expectedRevision: revision, reason: reason.trim(), value: !target.current };
    try { const old = localStorage.getItem(key); if (old !== null && (!pending || old !== JSON.stringify(pending))) throw Error('Saved action changed. Reopen the report.'); const raw = JSON.stringify(intent); localStorage.setItem(key, raw); if (localStorage.getItem(key) !== raw) throw Error('Cannot save recovery. No action sent.'); } catch (e) { setError(String(e)); return; }
    setPending(intent); setBusy(true); setError(null); const controller = new AbortController(); ctrl.current = controller;
    try {
      const path = target.kind === 'closure' ? 'closure' : `screenshots/${target.attachmentId}/preservation`;
      await api.postRaw(`/admin/tester/feedback/${reportId}/${path}`, { requestId: intent.requestId, expectedRevision: intent.expectedRevision, reason: intent.reason, ...(target.kind === 'closure' ? { closed: intent.value } : { preserved: intent.value }) }, { signal: controller.signal });
      if (!live.current || controller.signal.aborted || useApp.getState().wallet !== wallet) return;
      if (localStorage.getItem(key) !== JSON.stringify(intent)) throw Error('Saved action changed. Reopen to recover its receipt.'); localStorage.removeItem(key); if (localStorage.getItem(key) !== null) throw Error('Could not clear recovery. Retry the same action.'); setPending(null); setPreview(false); setReason(''); setNotice('SAVED — REFRESHING CURRENT STATE'); onChanged();
    } catch (e) {
      if (!live.current || controller.signal.aborted) return;
      if (e instanceof ApiError && [400, 403, 404, 409, 410, 422].includes(e.status) && localStorage.getItem(key) === JSON.stringify(intent)) { localStorage.removeItem(key); if (localStorage.getItem(key) === null) { setPending(null); setPreview(false); onChanged(); } }
      setError(e instanceof Error ? e.message : 'Action interrupted. Retry the saved action.');
    } finally { ctrl.current = null; if (live.current) setBusy(false); }
  };
  if (account !== wallet) return <div>ACCOUNT CHANGED</div>;
  const desired = pending?.value ?? !target.current;
  const label = target.kind === 'closure' ? (desired ? 'CLOSE PRIVATE THREAD' : 'REOPEN PRIVATE THREAD') : (desired ? 'PRESERVE SCREENSHOT' : 'END SCREENSHOT PRESERVATION');
  return <details open={pending ? true : undefined} style={{ minWidth: 0 }}><summary style={{ minHeight: 44, cursor: 'pointer' }}>{target.kind === 'closure' ? `THREAD ${target.current ? 'CLOSED' : 'OPEN'} · CHANGE` : `SCREENSHOT ${target.current ? 'PRESERVED' : 'NORMAL RETENTION'} · CHANGE`}</summary>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label>{target.kind === 'closure' ? 'CLOSURE REASON — SHARED WITH PLAYER' : 'PRESERVATION REASON — PRIVATE STAFF HISTORY'}<textarea aria-label={`${target.kind} reason`} value={reason} maxLength={FEEDBACK_THREADS.moderationReasonMaxLen} disabled={disabled || busy || !!pending} onChange={e => { setReason(e.target.value); setPreview(false); }} style={{ minHeight: 88, width: '100%', boxSizing: 'border-box', font: 'inherit' }} /></label>
      {!pending && <Btn variant="ghost" disabled={disabled || busy || !reason.trim()} onClick={() => { reviewed.current = consent; setPreview(true); }}>REVIEW {target.kind === 'closure' ? 'THREAD CLOSURE' : 'PRESERVATION'}</Btn>}
      {preview && <><p>{target.kind === 'closure' ? 'This changes reply access and retention timing. Existing rewards and curated issue status stay unchanged; a separate reply lock remains in force.' : 'Preservation keeps this existing screenshot from normal cleanup. Ending preservation restores retention rules. Deleted images cannot be restored.'}</p><Btn disabled={blocked || busy} onClick={() => { void save(); }}>{pending ? 'RETRY SAVED RETENTION ACTION' : `CONFIRM: ${label}`}</Btn></>}
      {error && <div role="alert">{error}</div>}{notice && <div role="status">{notice}</div>}
    </div>
  </details>;
}
