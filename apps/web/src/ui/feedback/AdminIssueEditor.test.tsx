/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { ApiError } from '../../lib/api';
import Editor, { type AdminIssue } from './AdminIssueEditor';
const { get, post, patch } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: { get, postRaw: post, patch } }));
(globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;
const issue: AdminIssue = { id: 'draft-id', title: 'Approved title', summary: 'Approved summary', category: 'bug', status: 'open', workaround: null, fixedRelease: null, publishedAt: null, revision: 2, mergedInto: null };
const cleanups: Array<() => Promise<void>> = [];
async function mount(value: AdminIssue | null = null) {
    useApp.setState({ wallet: 'admin' });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host), saved = vi.fn();
    await act(async () => root.render(<Editor wallet="admin" issue={value} onBack={() => { }} onSaved={saved}/>));
    const end = async () => { await act(async () => root.unmount()); host.remove(); };
    cleanups.push(end);
    return { host, saved, close: async () => { cleanups.splice(cleanups.indexOf(end), 1); await end(); }, click: async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click()); }, fill: async (label: string, value: string) => { const el = host.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); } };
}
afterEach(async () => { for (const end of cleanups.splice(0))
    await end(); localStorage.clear(); get.mockReset(); post.mockReset(); patch.mockReset(); });
it('requires a fresh reviewed publication preview and excludes the private reason from it', async () => { post.mockResolvedValue({}); const view = await mount(); await view.fill('Issue title', 'Approved public title'); await view.fill('Issue summary', 'Approved public description'); await view.fill('Issue change reason', 'Private staff-only rationale'); await act(async () => view.host.querySelector<HTMLInputElement>('[aria-label="Publish curated issue"]')!.click()); await view.click('CONFIRM PUBLICATION'); expect(post).not.toHaveBeenCalled(); await view.click('PREVIEW CHANGES'); const preview = view.host.querySelector('[aria-label="Publication preview"]')!; expect(preview.textContent).toContain('Approved public description'); expect(preview.textContent).not.toContain('Private staff-only'); await view.fill('Issue summary', 'Changed after preview'); await view.click('CONFIRM PUBLICATION'); expect(post).not.toHaveBeenCalled(); await view.click('PREVIEW CHANGES'); await view.click('CONFIRM PUBLICATION'); expect(post.mock.calls[0]?.[1]).toMatchObject({ published: true, summary: 'Changed after preview', reason: 'Private staff-only rationale' }); expect(view.saved).toHaveBeenCalledOnce(); });
it('restores the exact uncertain create intent without automatically creating a second issue', async () => { post.mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({}); let view = await mount(); await view.fill('Issue title', 'New title'); await view.fill('Issue summary', 'New summary'); await view.fill('Issue change reason', 'Create draft.'); await view.click('PREVIEW CHANGES'); await view.click('SAVE PRIVATE DRAFT'); const body = post.mock.calls[0]?.[1]; await view.close(); view = await mount(); expect(post).toHaveBeenCalledTimes(1); await view.click('RETRY SAVED ISSUE EDIT'); expect(post.mock.calls[1]?.[1]).toEqual(body); });
it('refreshes renamed draft by ID after conflict, keeps proposed edits, and requires another preview', async () => { patch.mockRejectedValueOnce(new ApiError(409, 'changed', 'FEEDBACK_REVIEW_STALE')).mockResolvedValue({}); get.mockResolvedValue({ ...issue, title: 'Renamed elsewhere', revision: 8 }); const view = await mount(issue); await view.fill('Issue summary', 'My proposed change'); await view.fill('Issue change reason', 'Verified update.'); await view.click('PREVIEW CHANGES'); await view.click('SAVE PRIVATE DRAFT'); expect(get.mock.calls[0]?.[0]).toBe('/admin/tester/issues/draft-id'); expect(view.host.textContent).toContain('Renamed elsewhere'); expect(view.host.querySelector<HTMLTextAreaElement>('[aria-label="Issue summary"]')?.value).toBe('My proposed change'); await view.click('SAVE PRIVATE DRAFT'); expect(patch).toHaveBeenCalledTimes(1); await view.click('PREVIEW CHANGES'); await view.click('SAVE PRIVATE DRAFT'); expect(patch.mock.calls[1]?.[1].expectedRevision).toBe(8); });
it('aborts a pending edit after account switch and retains its exact recovery record', async () => { let done!: (value: unknown) => void; patch.mockImplementation(() => new Promise(r => { done = r; })); const view = await mount(issue); await view.fill('Issue change reason', 'Private edit'); await view.click('PREVIEW CHANGES'); await view.click('SAVE PRIVATE DRAFT'); await act(async () => useApp.setState({ wallet: 'other' })); expect(patch.mock.calls[0]?.[2].signal.aborted).toBe(true); await act(async () => done({})); expect(view.saved).not.toHaveBeenCalled(); expect(view.host.textContent).toContain('ACCOUNT CHANGED'); expect(localStorage.length).toBe(1); });
