/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { ApiError } from '../../lib/api';
import type { FeedbackReportDto } from '@shardkeep/shared/feedback';
import Panel from './AdminFeedbackModeration';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', async (original) => ({ ...await original<typeof import('../../lib/api')>(), api: { get, postRaw: post } }));
(globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;
const issue = { id: 'issue', title: 'Draft issue', revision: 7, status: 'investigating', mergedInto: null, publishedAt: null };
const cleanups: Array<() => Promise<void>> = [];
async function mount() { useApp.setState({ wallet: 'admin' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), changed = vi.fn(); await act(async () => root.render(<Panel wallet="admin" report={{ id: 'report', revision: 4, locked: false, linkedIssue: null } as FeedbackReportDto} disabled={false} onChanged={changed} onPending={() => { }}/>)); const end = async () => { await act(async () => root.unmount()); host.remove(); }; cleanups.push(end); return { host, changed, close: async () => { cleanups.splice(cleanups.indexOf(end), 1); await end(); }, click: async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click()); }, fill: async (label: string, value: string) => { const el = host.querySelector(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }); } }; }
afterEach(async () => { for (const end of cleanups.splice(0))
    await end(); localStorage.clear(); get.mockReset(); post.mockReset(); });
it('links with exact report/issue revisions and retries the same lost receipt after remount', async () => { get.mockResolvedValue({ issues: [issue], nextCursor: null }); post.mockRejectedValueOnce(new Error('lost')).mockResolvedValue({}); let view = await mount(); await view.fill('Canonical issue', 'issue'); await view.fill('Moderation reason', 'Same verified defect.'); await view.click('LINK CANONICAL ISSUE'); const original = post.mock.calls[0]?.[1]; expect(original).toMatchObject({ expectedIssueRevision: 7, expectedReportRevision: 4, issueId: 'issue' }); await view.close(); view = await mount(); expect(post).toHaveBeenCalledTimes(1); await view.click('RETRY SAVED MODERATION'); expect(post.mock.calls[1]?.[1]).toEqual(original); });
it('refreshes stale catalogue and requires reconfirmation; lock explicitly sends its player-visible reason', async () => { get.mockResolvedValueOnce({ issues: [issue], nextCursor: 'next-page' }).mockResolvedValue({ issues: [{ ...issue, revision: 8 }], nextCursor: null }); post.mockRejectedValueOnce(new ApiError(409, 'changed', 'FEEDBACK_REVIEW_STALE')).mockResolvedValue({}); const view = await mount(); await view.click('LOAD MORE ISSUES'); expect(get.mock.calls[1]?.[0]).toContain('cursor=next-page'); await view.fill('Canonical issue', 'issue'); await view.fill('Moderation reason', 'Investigation in progress.'); await view.click('LINK CANONICAL ISSUE'); expect(post).toHaveBeenCalledTimes(1); expect(view.host.textContent).toContain('review and confirm again'); await view.click('LOCK REPLIES'); expect(post.mock.calls[1]?.[0]).toBe('/admin/tester/feedback/report/lock'); expect(post.mock.calls[1]?.[1]).toMatchObject({ locked: true, reason: 'Investigation in progress.' }); expect(view.host.textContent).toContain('LOCK REASONS ARE SHARED WITH PLAYER'); });

it('creates a private issue inline and requires deliberate linking using the returned issue revision', async () => {
  get.mockResolvedValue({ issues: [], nextCursor: null });
  post.mockImplementation((path: string, body: Record<string, unknown>) => Promise.resolve(path === '/admin/tester/issues'
    ? { issueId: 'created', revision: 1, publishedAt: null, fields: body } : {}));
  const view = await mount(); await view.click('CREATE PRIVATE ISSUE');
  expect(view.host.querySelector('[aria-label="Publish curated issue"]')).toBeNull();
  await view.fill('Issue title', 'Curated defect'); await view.fill('Issue summary', 'Staff description written here.');
  await view.fill('Issue change reason', 'Track verified defect privately.'); await view.click('PREVIEW CHANGES'); await view.click('SAVE PRIVATE DRAFT');
  expect(post).toHaveBeenCalledTimes(1);
  expect(post.mock.calls[0]?.[1]).toMatchObject({ published: false, title: 'Curated defect' });
  expect(view.host.querySelector<HTMLSelectElement>('[aria-label="Canonical issue"]')?.value).toBe('created');
  await view.fill('Moderation reason', 'This report demonstrates the defect.'); await view.click('LINK CANONICAL ISSUE');
  expect(post.mock.calls[1]?.[1]).toMatchObject({ issueId: 'created', expectedIssueRevision: 1, expectedReportRevision: 4 });
});
