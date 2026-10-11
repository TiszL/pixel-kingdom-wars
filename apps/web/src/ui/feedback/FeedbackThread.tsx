import { FEEDBACK_SCREENSHOTS, FEEDBACK_THREADS, type FeedbackActorMode, type FeedbackMessageDto, type FeedbackThreadDto, type FeedbackVisibility } from '@shardkeep/shared/feedback';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, Chip, COLORS as C, btnStyle } from '../primitives';
import FeedbackRetentionControl from './FeedbackRetentionControl';
import AdminFeedbackStateAction from './AdminFeedbackStateAction';
import FeedbackOriginBadge from './FeedbackOriginBadge';
import { FeedbackPrivateImage, FeedbackThreadScreenshots, type FeedbackUploadSlot } from './FeedbackThreadScreenshots';
const AdminFeedbackReview = lazy(() => import('./AdminFeedbackReview'));

export interface FeedbackThreadProps {
  wallet: string;
  mode: FeedbackActorMode;
  reportId: string;
  onBack: () => void;
  onTrashChanged?: (reportId: string) => void;
  onChanged?: () => void;
  navigation?: {
    position: number; total: number; onPrevious?: () => void; onNext?: () => void;
    onMore?: () => void; loadingMore?: boolean; error?: string | null;
  };
}

/** The caller supplies a viewportSafe ScrollPage. Identity changes remount all
 * private data and drafts; no report body is retained in the next account. */
export default function FeedbackThread(props: FeedbackThreadProps): React.JSX.Element {
  const currentWallet = useApp((s) => s.wallet);
  return currentWallet === props.wallet
    ? <ThreadSession key={`${props.wallet}:${props.mode}:${props.reportId}`} {...props} />
    : <div role="status">ACCOUNT CHANGED — OPEN YOUR REPORTS AGAIN</div>;
}

interface Intent { requestId: string; body: string; visibility: FeedbackVisibility; attachmentIds?: string[] }
type ThreadPage = { afterRevision: number } | { beforeRevision: number };
const errorText = (error: unknown): string => error instanceof Error ? error.message : 'Could not connect. Try again.';
interface SavedDraft { version: 1; wallet: string; mode: FeedbackActorMode; reportId: string; draft: string; intent?: Intent; attachmentIds?: string[]; localFilesPending?: number; uploadSlots?: FeedbackUploadSlot[] }
const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= FEEDBACK_SCREENSHOTS.maxPerMessage
  && new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
const slotsFor = (saved: SavedDraft | null | undefined): FeedbackUploadSlot[] => saved?.uploadSlots ?? (saved?.attachmentIds ?? []).map(id => ({ requestId: id, attachmentId: id }));
const storageError = 'Reply recovery could not be saved or verified. Keep your site data, allow browser storage, and retry.';
const draftKey = (wallet: string, mode: FeedbackActorMode, reportId: string, visibility: FeedbackVisibility): string =>
  `pkw:feedback-reply:v1:${JSON.stringify([wallet, mode, reportId, visibility])}`;
function readDraft(wallet: string, mode: FeedbackActorMode, reportId: string, visibility: FeedbackVisibility): SavedDraft {
  const empty: SavedDraft = { version: 1, wallet, mode, reportId, draft: '' };
  try {
    const raw = localStorage.getItem(draftKey(wallet, mode, reportId, visibility));
    if (raw === null) return empty;
    const saved = JSON.parse(raw) as SavedDraft;
    const intent = saved?.intent;
    if (saved?.version !== 1 || saved.wallet !== wallet || saved.mode !== mode || saved.reportId !== reportId
      || (saved.attachmentIds !== undefined && !validIds(saved.attachmentIds))
      || (saved.localFilesPending !== undefined && (!Number.isInteger(saved.localFilesPending) || saved.localFilesPending < 0 || saved.localFilesPending > FEEDBACK_SCREENSHOTS.maxPerMessage))
      || (saved.uploadSlots !== undefined && (!Array.isArray(saved.uploadSlots) || saved.uploadSlots.length > FEEDBACK_SCREENSHOTS.maxPerMessage
        || new Set(saved.uploadSlots.map(s => s?.requestId)).size !== saved.uploadSlots.length
        || saved.uploadSlots.some(s => !s || typeof s.requestId !== 'string' || s.requestId.length > FEEDBACK_THREADS.requestIdMaxLen || !/^[A-Za-z0-9_-]+$/.test(s.requestId) || (s.attachmentId !== undefined && !validIds([s.attachmentId])))
        || JSON.stringify(saved.uploadSlots.flatMap(s => s.attachmentId ? [s.attachmentId] : [])) !== JSON.stringify(saved.attachmentIds ?? [])
        || saved.uploadSlots.filter(s => !s.attachmentId).length !== (saved.localFilesPending ?? 0)))
      || typeof saved.draft !== 'string' || saved.draft.length > FEEDBACK_THREADS.replyMaxLen
      || (intent !== undefined && (!intent || typeof intent.requestId !== 'string'
        || !/^[A-Za-z0-9_-]+$/.test(intent.requestId) || intent.requestId.length > FEEDBACK_THREADS.requestIdMaxLen
        || intent.visibility !== visibility || typeof intent.body !== 'string'
        || (intent.attachmentIds !== undefined && !validIds(intent.attachmentIds))
        || (!intent.body.trim() && !intent.attachmentIds?.length)
        || JSON.stringify(intent.attachmentIds ?? []) !== JSON.stringify(saved.attachmentIds ?? [])
        || intent.body !== saved.draft.trim() || intent.body.length > FEEDBACK_THREADS.replyMaxLen))) throw new Error(storageError);
    return saved;
  } catch { throw new Error(storageError); }
}
function saveDraft(saved: SavedDraft, visibility: FeedbackVisibility): void {
  try {
    const key = draftKey(saved.wallet, saved.mode, saved.reportId, visibility);
    const raw = JSON.stringify(saved);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw) throw new Error(storageError);
  } catch { throw new Error(storageError); }
}
function sameIntent(a: Intent | undefined, b: Intent): boolean {
  return !!a && a.requestId === b.requestId && a.body === b.body && a.visibility === b.visibility
    && JSON.stringify(a.attachmentIds ?? []) === JSON.stringify(b.attachmentIds ?? []);
}
/** Preserve another tab's replacement draft; only clear the exact acknowledged
 * request. A failed storage operation leaves the original retry recoverable. */
function resolveDraft(wallet: string, mode: FeedbackActorMode, reportId: string, intent: Intent, accepted: boolean): SavedDraft {
  const saved = readDraft(wallet, mode, reportId, intent.visibility);
  if (!sameIntent(saved.intent, intent)) throw new Error('Reply draft changed in another tab. Reopen this thread to recover it.');
  const next: SavedDraft = { version: 1, wallet, mode, reportId, draft: accepted ? '' : saved.draft,
    attachmentIds: accepted ? [] : saved.attachmentIds ?? [], localFilesPending: accepted ? 0 : saved.localFilesPending ?? 0, uploadSlots: accepted ? [] : slotsFor(saved) };
  saveDraft(next, intent.visibility); return next;
}

function ThreadSession({ wallet, mode, reportId, onBack, onChanged, onTrashChanged, navigation }: FeedbackThreadProps): React.JSX.Element {
  const path = `/${mode === 'admin' ? 'admin/tester' : 'tester'}/feedback/${encodeURIComponent(reportId)}`;
  const [thread, setThread] = useState<FeedbackThreadDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewPending, setReviewPending] = useState(false), [trashPending, setTrashPending] = useState(false);
  const [retentionPending, setRetentionPending] = useState<ReadonlySet<string>>(new Set());
  const retentionChanged = useCallback((scope: string, pending: boolean): void => {
    setRetentionPending(old => {
      if (old.has(scope) === pending) return old;
      const next = new Set(old); if (pending) next.add(scope); else next.delete(scope); return next;
    });
  }, []);
  const adminActionPending = reviewPending || trashPending || retentionPending.size > 0;
  const [recovered] = useState(() => {
    try { return { reporter: readDraft(wallet, mode, reportId, 'reporter'),
      admin: mode === 'admin' ? readDraft(wallet, mode, reportId, 'admin') : null, error: null }; }
    catch (cause) { return { reporter: null, admin: null, error: errorText(cause) }; }
  });
  const [error, setError] = useState<string | null>(recovered.error);
  const [notice, setNotice] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<FeedbackVisibility>(recovered.admin?.intent && !recovered.reporter?.intent ? 'admin' : 'reporter');
  const [drafts, setDrafts] = useState({ reporter: recovered.reporter?.draft ?? '', admin: recovered.admin?.draft ?? '' });
  const [intents, setIntents] = useState<Record<FeedbackVisibility, Intent | undefined>>({ reporter: recovered.reporter?.intent, admin: recovered.admin?.intent });
  const [screenshots, setScreenshots] = useState<Record<FeedbackVisibility, { ids: string[]; local: number; slots: FeedbackUploadSlot[] }>>({
    reporter: { ids: recovered.reporter?.attachmentIds ?? [], local: recovered.reporter?.localFilesPending ?? 0, slots: slotsFor(recovered.reporter) },
    admin: { ids: recovered.admin?.attachmentIds ?? [], local: recovered.admin?.localFilesPending ?? 0, slots: slotsFor(recovered.admin) },
  });
  const displayed = useRef({ reporter: recovered.reporter, admin: recovered.admin });
  const writeOwnDraft = (next: SavedDraft, target: FeedbackVisibility): void => {
    const saved = readDraft(wallet, mode, reportId, target);
    const shown = displayed.current[target] ?? { version: 1, wallet, mode, reportId, draft: '' };
    if (JSON.stringify(saved) !== JSON.stringify(shown)) throw new Error('Reply draft changed in another tab. Close and reopen this thread to review it before sending.');
    saveDraft(next, target); displayed.current[target] = next;
  };
  const [imageBusy, setImageBusy] = useState(false);
  const live = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const readRequest = useRef(0);
  const mutation = useRef(false);
  const section = useRef<HTMLElement>(null);
  const review = useRef<HTMLDivElement>(null);
  const replyField = useRef<HTMLTextAreaElement>(null);
  const messages = useRef<HTMLDivElement>(null);
  const newestVisible = useRef<HTMLDivElement>(null);
  const initialPosition = useRef(false);
  const readAttempts = useRef(new Set<number>());
  const anchor = useRef<{ node: HTMLElement; top: number; scroller: HTMLElement } | null>(null);
  const isCurrent = useCallback(() => live.current && useApp.getState().wallet === wallet, [wallet]);
  const controller = (): AbortController => {
    const next = new AbortController(); controllers.current.add(next); return next;
  };
  const load = useCallback(async (page?: ThreadPage): Promise<void> => {
    if (!isCurrent()) return;
    const request = ++readRequest.current;
    const ctrl = new AbortController(); controllers.current.add(ctrl);
    setLoading(true); setError((old) => old === storageError ? old : null);
    try {
      const query = page ? `?${'afterRevision' in page ? `afterRevision=${page.afterRevision}` : `beforeRevision=${page.beforeRevision}`}` : '';
      const next = await api.get<FeedbackThreadDto>(`${path}/thread${query}`, { signal: ctrl.signal });
      if (!isCurrent() || ctrl.signal.aborted || request !== readRequest.current) return;
      setThread((old) => {
        if (!page || !old) return next;
        return { ...next,
          messages: [...new Map([...old.messages, ...next.messages].map((m) => [m.id, m])).values()].sort((a, b) => a.revision - b.revision),
          readRevision: Math.max(old.readRevision, next.readRevision),
          ...('beforeRevision' in page
            ? { nextRevision: old.nextRevision, hasMore: old.hasMore || next.latestRevision > old.nextRevision }
            : { oldestRevision: old.oldestRevision, hasEarlier: old.hasEarlier }),
        };
      });
    } catch (cause) {
      if (isCurrent() && !ctrl.signal.aborted && request === readRequest.current) { anchor.current = null; setError(errorText(cause)); }
    } finally {
      controllers.current.delete(ctrl);
      if (isCurrent() && request === readRequest.current) setLoading(false);
    }
  }, [isCurrent, path]);
  useEffect(() => {
    live.current = true;
    const abort = (): void => { for (const ctrl of controllers.current) ctrl.abort(); };
    const unsubscribe = useApp.subscribe((state) => { if (state.wallet !== wallet) abort(); });
    void load();
    return () => { live.current = false; readRequest.current++; abort(); unsubscribe(); };
  }, [load, wallet]);
  useLayoutEffect(() => {
    if (mode !== 'admin') return;
    let scroller = section.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (scroller) scroller.scrollTop = 0;
  }, [mode]);
  useLayoutEffect(() => {
    if (!thread) return;
    const previous = anchor.current;
    if (previous) {
      previous.scroller.scrollTop += previous.node.getBoundingClientRect().top - previous.top;
      anchor.current = null;
    } else if (!initialPosition.current) {
      initialPosition.current = true;
      if (mode === 'reporter') newestVisible.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [thread, mode]);
  const earlier = (): void => {
    if (!thread || loading || busy) return;
    let scroller = messages.current?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const node = messages.current?.firstElementChild as HTMLElement | null;
    if (scroller && node) anchor.current = { node, top: node.getBoundingClientRect().top, scroller };
    void load({ beforeRevision: thread.oldestRevision });
  };

  const editDraft = (draft: string): void => {
    if (!isCurrent()) return;
    try {
      const saved = readDraft(wallet, mode, reportId, visibility);
      if (saved.intent) {
        throw new Error('Reply draft changed in another tab. Close and reopen this thread to review it before sending.');
      }
      writeOwnDraft({ ...saved, draft }, visibility);
      setDrafts((old) => ({ ...old, [visibility]: draft }));
    } catch (cause) { setError(errorText(cause)); }
  };

  const editScreenshots = (target: FeedbackVisibility, slots: FeedbackUploadSlot[]): void => {
    if (!isCurrent()) throw new Error('Account changed. Reopen your reports.');
    const saved = readDraft(wallet, mode, reportId, target);
    if (saved.intent) throw new Error('Retry your saved reply before changing its screenshots.');
    const ids = slots.flatMap(s => s.attachmentId ? [s.attachmentId] : []), local = slots.filter(s => !s.attachmentId).length;
    writeOwnDraft({ ...saved, attachmentIds: ids, localFilesPending: local, uploadSlots: slots }, target);
    setScreenshots((old) => ({ ...old, [target]: { ids, local, slots } }));
  };

  const send = async (): Promise<void> => {
    if (!isCurrent() || mutation.current || adminActionPending || imageBusy || !thread || thread.report.trashed || thread.report.trashedAt || screenshots[visibility].local > 0) return;
    const body = drafts[visibility].trim();
    if ((!body && !screenshots[visibility].ids.length) || (!intents[visibility] && mode === 'reporter' && (thread.report.closed || thread.report.locked))) return;
    let intent: Intent;
    try {
      const saved = readDraft(wallet, mode, reportId, visibility);
      if (saved.intent && !sameIntent(intents[visibility], saved.intent)) {
        throw new Error('Reply draft changed in another tab. Close and reopen this thread to review it before sending.');
      }
      intent = saved.intent ?? intents[visibility] ?? { requestId: crypto.randomUUID(), body, visibility,
        ...(saved.attachmentIds?.length ? { attachmentIds: saved.attachmentIds } : {}) };
      writeOwnDraft({ ...saved, draft: intent.body, intent }, visibility);
    } catch (cause) { setError(errorText(cause)); return; }
    mutation.current = true; setBusy(true); setError(null); setNotice(null);
    setIntents((old) => ({ ...old, [visibility]: intent }));
    const ctrl = controller();
    try {
      await api.postRaw<FeedbackMessageDto>(`${path}/replies`, intent, { signal: ctrl.signal });
      if (!isCurrent() || ctrl.signal.aborted) return;
      displayed.current[visibility] = resolveDraft(wallet, mode, reportId, intent, true);
      setIntents((old) => ({ ...old, [visibility]: undefined }));
      setDrafts((old) => ({ ...old, [visibility]: '' }));
      setScreenshots((old) => ({ ...old, [visibility]: { ids: [], local: 0, slots: [] } }));
      setNotice(visibility === 'admin' ? 'PRIVATE NOTE SAVED' : 'REPLY SENT');
      onChanged?.();
      // Fetch from our loaded boundary, not the receipt's revision: another
      // device may have posted intervening replies which must stay reachable.
      await load({ afterRevision: thread.nextRevision });
    } catch (cause) {
      if (!isCurrent() || ctrl.signal.aborted) return;
      const rejected = cause instanceof ApiError && [400, 403, 404, 409, 413, 422].includes(cause.status);
      if (rejected) {
        try { displayed.current[visibility] = resolveDraft(wallet, mode, reportId, intent, false); }
        catch (storageCause) { setError(errorText(storageCause)); return; }
        setIntents((old) => ({ ...old, [visibility]: undefined }));
      }
      setError(rejected ? errorText(cause) : `${errorText(cause)} Retry sends the same reply safely.`);
    } finally {
      controllers.current.delete(ctrl); mutation.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  const markRead = useCallback(async (): Promise<void> => {
    if (!isCurrent() || mutation.current || !thread) return;
    mutation.current = true; setBusy(true); setError(null);
    const ctrl = new AbortController(); controllers.current.add(ctrl);
    // Standard conversation semantics: viewing the newest loaded message reads
    // through that point, while newer messages still on the server stay unread.
    const revision = Math.max(1, thread.nextRevision);
    try {
      const result = await api.postRaw<{ readRevision: number }>(`${path}/read`, { revision }, { signal: ctrl.signal });
      if (!isCurrent() || ctrl.signal.aborted) return;
      setThread((old) => old && ({ ...old, readRevision: result.readRevision,
        unread: old.unread && result.readRevision < old.latestRevision }));
      onChanged?.();
    } catch (cause) {
      if (isCurrent() && !ctrl.signal.aborted) setError(errorText(cause));
    } finally {
      controllers.current.delete(ctrl); mutation.current = false;
      if (isCurrent()) setBusy(false);
    }
  }, [isCurrent, onChanged, path, thread]);
  useEffect(() => {
    const node = newestVisible.current;
    if (!node || !thread?.unread || loading || busy || typeof IntersectionObserver === 'undefined') return undefined;
    const revision = Math.max(1, thread.nextRevision);
    if (thread.readRevision >= revision || readAttempts.current.has(revision)) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (document.visibilityState === 'hidden' || !isCurrent() || mutation.current || readAttempts.current.has(revision)) return;
      if (entries.some((entry) => entry.target === node && entry.isIntersecting && entry.intersectionRatio >= 1)) {
        readAttempts.current.add(revision); void markRead();
      }
    }, { threshold: 1 });
    observer.observe(node);
    const foreground = (): void => {
      if (document.visibilityState !== 'hidden') { observer.unobserve(node); observer.observe(node); }
    };
    document.addEventListener('visibilitychange', foreground);
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', foreground); };
  }, [busy, isCurrent, loading, markRead, thread]);
  const trashed = !!(thread?.report.trashed || thread?.report.trashedAt);
  const locked = mode === 'reporter' && !!(thread?.report.locked || thread?.report.closed);
  const pending = !!intents[visibility];
  return <section ref={section} aria-label="Private feedback thread" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, overflowWrap: 'anywhere' }}>
    <div data-testid="feedback-thread-navigation" style={{ display: 'flex', flexDirection: 'column', gap: 4, position: 'sticky', top: 0, zIndex: 2, background: C.panel, paddingBottom: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      <Btn variant="ghost" fontSize={18} onClick={onBack} style={{ minHeight: 44, padding: '8px 10px' }}>BACK TO REPORTS</Btn>
      {(mode === 'reporter' || !thread) && <Btn variant="ghost" fontSize={18} onClick={() => { void load(thread ? { afterRevision: thread.nextRevision } : undefined); }} disabled={loading || busy}
        style={{ minHeight: 44, padding: '8px 10px' }}>REFRESH</Btn>}
      </div>
      {mode === 'admin' && navigation && <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', gap: 6, alignItems: 'center', width: '100%' }}>
        <Btn variant="ghost" fontSize={16} disabled={!navigation.onPrevious || busy || imageBusy} onClick={() => navigation.onPrevious?.()} style={{ minHeight: 40, minWidth: 56, padding: '6px 8px' }}>PREV</Btn>
        <span style={{ fontSize: 15, color: C.textDim, textAlign: 'center' }}>{navigation.position} / {navigation.total} LOADED</span>
        <Btn variant="sec" fontSize={16} disabled={(!navigation.onNext && (!navigation.onMore || navigation.loadingMore)) || busy || imageBusy}
          onClick={() => { if (navigation.onNext) navigation.onNext(); else navigation.onMore?.(); }} style={{ minHeight: 40, minWidth: 56, padding: '6px 8px' }}>{!navigation.onNext && navigation.onMore ? 'MORE' : 'NEXT'}</Btn>
      </div>}
      {mode === 'admin' && thread && !trashed && <div style={{ display: 'flex', gap: 6 }}>
        {thread.report.revision && <Btn variant="ghost" fontSize={16} onClick={() => review.current?.scrollIntoView?.({ block: 'center' })} style={{ flex: 1, minHeight: 40, padding: '6px 8px' }}>REVIEW</Btn>}
        <Btn variant="ghost" fontSize={16} disabled={busy || imageBusy} onClick={() => { setVisibility('reporter'); replyField.current?.scrollIntoView?.({ block: 'center' }); replyField.current?.focus({ preventScroll: true }); }} style={{ flex: 1, minHeight: 40, padding: '6px 8px' }}>REPLY</Btn>
      </div>}
    </div>
    {navigation?.error && <div role="alert">{navigation.error}</div>}
    {mode === 'reporter' && <div>Only you and the support team can see this report, replies and screenshots.</div>}
    {loading && <div role="status">LOADING REPORT…</div>}
    {error && <div role="alert" style={{ color: C.danger }}>{error}</div>}
    {notice && <div role="status" style={{ color: C.goldHi }}>{notice}</div>}
    {thread && <>
      <Chip style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <h3 style={{ margin: 0 }}>{thread.report.title}</h3>
        {mode === 'admin' && <FeedbackOriginBadge context={thread.report.context} />}
        <div>{thread.report.fixedAt ? 'FIXED' : thread.report.status.toUpperCase()} · {thread.report.points} POINTS</div>
        {thread.report.fixedRef && <div>FIX: {thread.report.fixedRef}</div>}
        <div style={{ whiteSpace: 'pre-wrap' }}>{thread.report.body}</div>
        {thread.report.adminNote && <div>TEAM NOTE: {thread.report.adminNote}</div>}
      </Chip>
      {mode === 'admin' && !trashed && thread.report.revision && <div ref={review}><Suspense fallback={<div role="status">LOADING REVIEW & REWARD…</div>}><AdminFeedbackReview wallet={wallet} reportId={reportId} revision={thread.report.revision} disabled={busy || loading || imageBusy || trashPending || retentionPending.size > 0 || !!intents.admin || !!intents.reporter} onPending={setReviewPending} onChanged={() => { void load(); onChanged?.(); }} /></Suspense></div>}
      {thread.hasEarlier && <Btn onClick={earlier} disabled={loading || busy} style={{ minHeight: 44 }}>LOAD EARLIER REPLIES</Btn>}
      <div ref={messages} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {thread.messages.filter((message) => mode === 'admin' || message.visibility === 'reporter').map((message) => <Chip key={message.id}
        style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
        <div style={{ color: C.gold }}>{message.visibility === 'admin' ? 'INTERNAL NOTE — TEAM ONLY' : message.authorRole === 'admin' ? 'TEAM' : 'PLAYER'} · {message.createdAt.slice(0, 16).replace('T', ' ')} UTC</div>
        <div style={{ whiteSpace: 'pre-wrap' }}>{message.body}</div>
        {message.attachments?.map((attachment) => <div key={attachment.id}><FeedbackPrivateImage path={path} wallet={wallet} attachment={attachment} />{mode === 'admin' && !trashed && thread.report.revision && !attachment.expired && typeof attachment.preserved === 'boolean' && <details><summary className="interactive" style={{ minHeight: 44, cursor: 'pointer' }}>SCREENSHOT RETENTION</summary><FeedbackRetentionControl wallet={wallet} reportId={reportId} revision={thread.report.revision} target={{ kind: 'preservation', attachmentId: attachment.id, current: attachment.preserved }} disabled={busy || loading || adminActionPending || !!intents.admin || !!intents.reporter} onPending={retentionChanged} onChanged={() => { void load(); onChanged?.(); }} /></details>}</div>)}
      </Chip>)}
      </div>
      <div ref={newestVisible} data-testid="feedback-read-boundary" style={{ height: 1 }} />
      {thread.hasMore && <Btn onClick={() => { void load({ afterRevision: thread.nextRevision }); }} disabled={loading || busy} style={{ minHeight: 44 }}>LOAD NEWER REPLIES</Btn>}
      {thread.unread && <div>
        <span>UNREAD UPDATES{thread.hasMore ? ' — MORE REPLIES TO LOAD' : ''}</span>
        <Btn onClick={() => { void markRead(); }} disabled={busy || loading} style={{ minHeight: 44 }}>MARK LOADED AS READ</Btn>
      </div>}
      {locked && <div role="status">{thread.report.closed ? 'THIS THREAD IS CLOSED' : 'REPLIES ARE LOCKED'} — YOU CAN STILL READ YOUR REPORT.</div>}
      {trashed && <div role="status">IN TRASH — READ ONLY. Restore this report to make changes.</div>}
      {!trashed && (!locked || pending) && <>
        {mode === 'admin' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="interactive" aria-pressed={visibility === 'reporter'} onClick={() => setVisibility('reporter')}
            disabled={busy || imageBusy} style={{ ...btnStyle(visibility === 'reporter' ? 'gold' : 'ghost', 16, busy), minHeight: 44 }}>REPLY TO PLAYER</button>
          <button type="button" className="interactive" aria-pressed={visibility === 'admin'} onClick={() => setVisibility('admin')}
            disabled={busy || imageBusy} style={{ ...btnStyle(visibility === 'admin' ? 'gold' : 'ghost', 16, busy), minHeight: 44 }}>INTERNAL NOTE</button>
        </div>}
        {pending && <div role="status">SAVED REPLY AWAITS CONFIRMATION — RETRY THE SAME REPLY TO RECOVER ITS RESULT.</div>}
        <label>{visibility === 'admin' ? 'PRIVATE NOTE — ONLY THE TEAM CAN READ THIS' : 'REPLY — VISIBLE TO THE PLAYER AND TEAM'}
          <textarea ref={replyField} className="interactive" aria-label={visibility === 'admin' ? 'Internal note' : 'Reply'} rows={4}
            value={drafts[visibility]} disabled={busy || adminActionPending || pending} maxLength={FEEDBACK_THREADS.replyMaxLen}
            onChange={(event) => editDraft(event.target.value)}
            style={{ display: 'block', boxSizing: 'border-box', width: '100%', minWidth: 0, fontFamily: 'inherit', fontSize: 17, padding: 10,
              background: C.surface, color: C.text, border: `2px solid ${C.borderLt}`, resize: 'vertical' }} />
        </label>
        {(mode === 'admin' ? ['reporter', 'admin'] as const : ['reporter'] as const).map((target) => <div key={target} style={{ display: target === visibility ? 'block' : 'none' }}>
          <FeedbackThreadScreenshots path={path} wallet={wallet} scopeKey={`${wallet}:${mode}:${reportId}:${target}`}
            ids={screenshots[target].ids} slots={screenshots[target].slots} disabled={busy || adminActionPending || !!intents[target]}
            onChange={(slots) => editScreenshots(target, slots)} onBusy={setImageBusy} />
        </div>)}
        <Btn variant="gold" onClick={() => { void send(); }} disabled={busy || adminActionPending || imageBusy || screenshots[visibility].local > 0 || (!drafts[visibility].trim() && !screenshots[visibility].ids.length)} style={{ minHeight: 44 }}>
          {busy ? 'SAVING…' : pending ? 'RETRY SAME REPLY' : visibility === 'admin' ? 'SAVE PRIVATE NOTE' : 'SEND REPLY'}
        </Btn>
      </>}
      {mode === 'admin' && <details open={trashed}><summary className="interactive" style={{ minHeight: 44, cursor: 'pointer' }}>REPORT DETAILS & ACTIONS</summary>
        <Btn variant="ghost" fontSize={18} onClick={() => { void load(thread ? { afterRevision: thread.nextRevision } : undefined); }} disabled={loading || busy} style={{ minHeight: 44 }}>REFRESH</Btn>
        {thread.report.revision && <AdminFeedbackStateAction wallet={wallet} reportId={reportId} revision={thread.report.revision} kind="trash" current={trashed} status={thread.report.status} disabled={busy || loading || imageBusy || reviewPending || retentionPending.size > 0 || !!intents.admin || !!intents.reporter} onPending={setTrashPending} onChanged={(applied) => { onChanged?.(); if (applied) { onTrashChanged?.(reportId); onBack(); } else void load(); }} />}
        {!trashed && thread.report.revision && <FeedbackRetentionControl wallet={wallet} reportId={reportId} revision={thread.report.revision} target={{ kind: 'closure', current: thread.report.closed }} disabled={busy || loading || adminActionPending || !!intents.admin || !!intents.reporter} onPending={retentionChanged} onChanged={() => { void load({ afterRevision: thread.nextRevision }); onChanged?.(); }} />}
      </details>}
    </>}
  </section>;
}
