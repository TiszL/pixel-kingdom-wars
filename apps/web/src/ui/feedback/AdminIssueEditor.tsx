import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { Btn, COLORS as C } from '../primitives';
export interface CuratedFields {
    title: string;
    summary: string;
    category: string;
    status: 'open' | 'investigating' | 'planned' | 'fixed' | 'closed';
    workaround: string | null;
    fixedRelease: string | null;
    published: boolean;
}
export interface AdminIssue extends Omit<CuratedFields, 'published' | 'status'> {
    id: string;
    revision: number;
    publishedAt: string | null;
    status: string;
    mergedInto: string | null;
}
interface Intent {
    requestId: string;
    reason: string;
    fields: CuratedFields;
    expectedRevision?: number;
}
export interface IssueSaveReceipt { issueId: string; revision: number; publishedAt: string | null; fields: CuratedFields }
const defaults: CuratedFields = { title: '', summary: '', category: 'bug', status: 'open', workaround: null, fixedRelease: null, published: false };
const fieldStyle = { width: '100%', minWidth: 0, minHeight: 44, font: 'inherit', fontSize: 17, padding: 8, boxSizing: 'border-box' as const, background: C.surface, color: C.text };
export default function AdminIssueEditor({ wallet, issue, onBack, onSaved, privateOnly = false, creationScope = 'new' }: {
    wallet: string;
    issue: AdminIssue | null;
    onBack: () => void;
    onSaved: (receipt: IssueSaveReceipt) => void;
    privateOnly?: boolean;
    creationScope?: string;
}): React.JSX.Element {
    const currentWallet = useApp(s => s.wallet), key = `pkw:issue-curation:v1:${JSON.stringify([wallet, issue?.id ?? creationScope])}`;
    const [pending, setPending] = useState<Intent | null>(() => { try {
        const raw = localStorage.getItem(key);
        if (!raw)
            return null;
        const saved = JSON.parse(raw) as Intent;
        if (!saved || !saved.fields || typeof saved.fields.title !== 'string' || !saved.fields.title.trim() || saved.fields.title.length > TESTER_PROGRAM.feedback.titleMaxLen || typeof saved.fields.summary !== 'string' || !saved.fields.summary.trim() || saved.fields.summary.length > TESTER_PROGRAM.feedback.bodyMaxLen || !(TESTER_PROGRAM.feedback.categories as readonly string[]).includes(saved.fields.category) || !['open', 'investigating', 'planned', 'fixed', 'closed'].includes(saved.fields.status) || typeof saved.fields.published !== 'boolean' || (saved.fields.workaround !== null && (typeof saved.fields.workaround !== 'string' || saved.fields.workaround.length > TESTER_PROGRAM.feedback.bodyMaxLen)) || (saved.fields.fixedRelease !== null && (typeof saved.fields.fixedRelease !== 'string' || saved.fields.fixedRelease.length > TESTER_PROGRAM.feedback.titleMaxLen)) || (saved.expectedRevision !== undefined && (!Number.isSafeInteger(saved.expectedRevision) || saved.expectedRevision < 1)) || typeof saved.requestId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(saved.requestId) || saved.requestId.length > FEEDBACK_THREADS.requestIdMaxLen || typeof saved.reason !== 'string' || !saved.reason.trim() || saved.reason.length > FEEDBACK_THREADS.moderationReasonMaxLen)
            throw Error('invalid');
        return saved;
    }
    catch {
        return null;
    } });
    const [current, setCurrent] = useState(issue), [fields, setFields] = useState<CuratedFields>(pending?.fields ?? (issue ? { title: issue.title, summary: issue.summary, category: issue.category, status: issue.status as CuratedFields['status'], workaround: issue.workaround, fixedRelease: issue.fixedRelease, published: !!issue.publishedAt } : defaults));
    const [reason, setReason] = useState(pending?.reason ?? ''), [preview, setPreview] = useState(!!pending), [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState<string | null>(null);
    const [refreshBlocked, setRefreshBlocked] = useState(false);
    const active = useRef(false), mutation = useRef<AbortController | null>(null);
    useEffect(() => { active.current = true; const off = useApp.subscribe(s => { if (s.wallet !== wallet)
        mutation.current?.abort(); }); return () => { active.current = false; mutation.current?.abort(); off(); }; }, [wallet]);
    const edit = <K extends keyof CuratedFields>(name: K, value: CuratedFields[K]): void => { setFields(old => ({ ...old, [name]: value })); setPreview(false); };
    const save = async (): Promise<void> => {
        if (mutation.current || currentWallet !== wallet || refreshing || refreshBlocked || (!pending && (!preview || !fields.title.trim() || !fields.summary.trim() || !reason.trim() || current?.mergedInto || current?.status === 'merged')))
            return;
        const input: Intent = pending ?? { requestId: crypto.randomUUID(), reason: reason.trim(), fields: { ...fields, title: fields.title.trim(), summary: fields.summary.trim(), workaround: fields.workaround?.trim() || null, fixedRelease: fields.fixedRelease?.trim() || null }, ...(current ? { expectedRevision: current.revision } : {}) };
        try {
            const old = localStorage.getItem(key);
            if (old !== null && (!pending || old !== JSON.stringify(pending)))
                throw Error('Saved issue edit changed. Reopen this issue.');
            const raw = JSON.stringify(input);
            localStorage.setItem(key, raw);
            if (localStorage.getItem(key) !== raw)
                throw Error('Issue recovery could not be saved.');
        }
        catch (cause) {
            setError(String(cause));
            return;
        }
        setPending(input);
        setBusy(true);
        setError(null);
        const controller = new AbortController();
        mutation.current = controller;
        try {
            if (privateOnly && input.fields.published) throw Error('This saved edit publishes an issue. Open the issue catalogue to review it.');
            const body = { ...input.fields, requestId: input.requestId, reason: input.reason, ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}) };
            const receipt = current
                ? await api.patch<IssueSaveReceipt>(`/admin/tester/issues/${current.id}`, body, { signal: controller.signal })
                : await api.postRaw<IssueSaveReceipt>('/admin/tester/issues', body, { signal: controller.signal });
            if (controller.signal.aborted || !active.current || useApp.getState().wallet !== wallet)
                return;
            if (localStorage.getItem(key) !== JSON.stringify(input))
                throw Error('Saved issue edit changed. Reopen before continuing.');
            localStorage.removeItem(key);
            if (localStorage.getItem(key) !== null)
                throw Error('Could not clear accepted edit. Retry the same edit.');
            setPending(null);
            onSaved(receipt);
        }
        catch (cause) {
            if (controller.signal.aborted || !active.current)
                return;
            if (cause instanceof ApiError && [400, 403, 404, 409, 422].includes(cause.status)) {
                try {
                    if (localStorage.getItem(key) !== JSON.stringify(input))
                        throw Error('Saved issue edit changed. Reopen before continuing.');
                    localStorage.removeItem(key);
                    if (localStorage.getItem(key) !== null)
                        throw Error('Could not update issue recovery.');
                    setPending(null);
                    setPreview(false);
                    if (current) {
                        setRefreshing(true);
                        setRefreshBlocked(true);
                        const latest = await api.get<AdminIssue>(`/admin/tester/issues/${current.id}`, { signal: controller.signal });
                        if (controller.signal.aborted || !active.current)
                            return;
                        setCurrent(latest);
                        setRefreshBlocked(false);
                    }
                }
                catch (refreshCause) {
                    setError(`Review could not be refreshed: ${String(refreshCause)}. Close and reopen the issue.`);
                    return;
                }
                finally {
                    if (active.current)
                        setRefreshing(false);
                }
                setError(`${cause.message} Current issue refreshed; compare its content below, preview your proposed changes and confirm again.`);
            }
            else
                setError(cause instanceof Error ? cause.message : 'Save interrupted. Retry the same saved edit.');
        }
        finally {
            mutation.current = null;
            if (active.current)
                setBusy(false);
        }
    };
    if (currentWallet !== wallet)
        return <div>ACCOUNT CHANGED — REOPEN ISSUES</div>;
    return <section aria-label="Curated issue editor" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    <Btn variant="ghost" onClick={onBack}>{privateOnly ? 'BACK TO REVIEW' : 'BACK TO ISSUES'}</Btn><h3>{current ? 'EDIT CURATED ISSUE' : privateOnly ? 'CREATE PRIVATE ISSUE' : 'NEW CURATED ISSUE'}</h3>
    <div>{privateOnly ? 'Create a private issue for this report. Publishing is a separate action in the issue catalogue.' : 'Write approved public text yourself.'} Private report text is never copied into this form.</div>
    {current && <details><summary>CURRENT SERVER CONTENT · REVISION {current.revision}</summary><div>{current.title}</div><div style={{ whiteSpace: 'pre-wrap' }}>{current.summary}</div><div>{current.status} · {current.publishedAt ? 'PUBLISHED' : 'DRAFT'}</div><div>{current.workaround}</div><div>{current.fixedRelease}</div></details>}
    {(privateOnly ? ['title', 'summary'] as const : ['title', 'summary', 'workaround', 'fixedRelease'] as const).map(name => <label key={name}>{privateOnly ? name.toUpperCase() : name === 'fixedRelease' ? 'PUBLIC FIX RELEASE' : `PUBLIC ${name.toUpperCase()}`}<textarea aria-label={`Issue ${name}`} value={fields[name] ?? ''} disabled={busy || !!pending} onChange={e => edit(name, e.target.value)} maxLength={name === 'title' || name === 'fixedRelease' ? TESTER_PROGRAM.feedback.titleMaxLen : TESTER_PROGRAM.feedback.bodyMaxLen} style={fieldStyle}/></label>)}
    <label>CATEGORY<select aria-label="Issue category" value={fields.category} disabled={busy || !!pending} onChange={e => edit('category', e.target.value)} style={fieldStyle}>{TESTER_PROGRAM.feedback.categories.map(c => <option key={c} value={c}>{c.toUpperCase()}</option>)}</select></label>
    <label>STATUS<select aria-label="Issue status" value={fields.status} disabled={busy || !!pending} onChange={e => edit('status', e.target.value as CuratedFields['status'])} style={fieldStyle}>{(['open', 'investigating', 'planned', 'fixed', 'closed'] as const).map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}</select></label>
    {!privateOnly && <label style={{ minHeight: 44 }}><input type="checkbox" aria-label="Publish curated issue" checked={fields.published} disabled={busy || !!pending} onChange={e => edit('published', e.target.checked)}/> PUBLISH THESE FIELDS TO PLAYERS</label>}
    <label>CHANGE REASON — PRIVATE STAFF HISTORY<textarea aria-label="Issue change reason" value={reason} disabled={busy || !!pending} onChange={e => { setReason(e.target.value); setPreview(false); }} maxLength={FEEDBACK_THREADS.moderationReasonMaxLen} style={fieldStyle}/></label>
    {!pending && <Btn variant="ghost" onClick={() => setPreview(true)} disabled={!fields.title.trim() || !fields.summary.trim() || !reason.trim()}>PREVIEW CHANGES</Btn>}
    {preview && <div aria-label="Publication preview" style={{ border: `2px solid ${C.gold}`, padding: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><strong>{fields.published ? 'PUBLICATION PREVIEW' : 'PRIVATE DRAFT PREVIEW'}</strong><h3>{fields.title}</h3><div>{fields.category} · {fields.status}</div><div>{fields.summary}</div>{fields.workaround && <div>WORKAROUND: {fields.workaround}</div>}{fields.fixedRelease && <div>FIXED IN: {fields.fixedRelease}</div>}</div>}
    {error && <div role="alert">{error}</div>}
    <Btn onClick={() => { void save(); }} disabled={busy || refreshing || refreshBlocked || (!pending && (!preview || !!current?.mergedInto || current?.status === 'merged'))}>{pending ? 'RETRY SAVED ISSUE EDIT' : fields.published ? 'CONFIRM PUBLICATION' : 'SAVE PRIVATE DRAFT'}</Btn>
  </section>;
}
