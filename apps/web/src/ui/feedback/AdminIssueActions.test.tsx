/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { ApiError } from '../../lib/api';
import Actions from './AdminIssueActions';
import type { AdminIssue } from './AdminIssueEditor';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), api: { get, postRaw: post } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const issue: AdminIssue = { id: 'source', title: 'Source', summary: 'Approved source', category: 'bug', status: 'fixed', fixedRelease: 'release', workaround: null, publishedAt: '2026-09-07', revision: 2, mergedInto: null };
const target: AdminIssue = { ...issue, id: 'target', title: 'Target', status: 'open', revision: 5 };
const ends: Array<() => Promise<void>> = [];
async function mount() {
  useApp.setState({ wallet: 'admin' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<Actions wallet="admin" issue={issue} onBack={() => {}} />));
  const end = async () => { await act(async () => root.unmount()); host.remove(); }; ends.push(end);
  return { host, close: async () => { ends.splice(ends.indexOf(end), 1); await end(); }, click: async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)?.click()); }, reason: async (value: string) => { const el = host.querySelector('textarea')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); }, reopen: async () => { const el = host.querySelector('select')!; await act(async () => { el.value = 'reopen'; el.dispatchEvent(new Event('change', { bubbles: true })); }); } };
}
afterEach(async () => { for (const end of ends.splice(0)) await end(); localStorage.clear(); get.mockReset(); post.mockReset(); });
it('requires reviewed target/reason, prohibits public-to-draft merge, and preserves reward conflict evidence', async () => {
  get.mockResolvedValue({ issues: [issue, { ...target, id: 'draft', title: 'Private', publishedAt: null }, target], nextCursor: null });
  post.mockResolvedValue({ movedReportIds: ['r1'], awardClaims: [{ reportId: 'r1', issueId: 'source', points: 20 }], awardConflicts: [{ reportId: 'r1', issueId: 'source', points: 20 }] });
  const v = await mount(); await v.click('FIND TARGET ISSUE'); expect([...v.host.querySelectorAll('button')].find(b => b.textContent === 'Private · DRAFT')?.disabled).toBe(true);
  await v.click('Target · PUBLISHED'); await v.reason('Same cause.'); await v.click('PREVIEW ACTION'); expect(v.host.querySelector('[aria-label="Issue action preview"]')?.textContent).not.toContain('Same cause.');
  await v.reason('Changed rationale.'); await v.click('CONFIRM ISSUE ACTION'); expect(post).not.toHaveBeenCalled(); await v.click('PREVIEW ACTION'); await v.click('CONFIRM ISSUE ACTION');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ expectedSourceRevision: 2, expectedTargetRevision: 5, targetIssueId: 'target', reason: 'Changed rationale.' }); expect(v.host.textContent).toContain('HISTORICAL REWARD CONFLICTS'); expect(v.host.textContent).toContain('20 points retained');
});
it('recovers exact uncertain reopen after remount without automatically replaying', async () => {
  post.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValue({}); let v = await mount(); await v.reopen(); await v.reason('Recurrence.'); await v.click('PREVIEW ACTION'); expect(v.host.textContent).toContain('closed private threads stay closed'); await v.click('CONFIRM ISSUE ACTION'); const body = post.mock.calls[0]?.[1]; await v.close(); v = await mount(); expect(post).toHaveBeenCalledTimes(1); await v.click('RETRY SAVED ACTION'); expect(post.mock.calls[1]?.[1]).toEqual(body); expect(localStorage.length).toBe(0);
});
it('refreshes stale source and requires a newly selected target and preview', async () => {
  get.mockResolvedValueOnce({ issues: [target], nextCursor: null }).mockResolvedValueOnce({ ...issue, revision: 9 }).mockResolvedValueOnce({ issues: [{ ...target, revision: 10 }], nextCursor: null }); post.mockRejectedValueOnce(new ApiError(409, 'Changed', 'FEEDBACK_REVIEW_STALE')).mockResolvedValue({});
  const v = await mount(); await v.click('FIND TARGET ISSUE'); await v.click('Target · PUBLISHED'); await v.reason('Same cause.'); await v.click('PREVIEW ACTION'); await v.click('CONFIRM ISSUE ACTION'); expect(get.mock.calls[1]?.[0]).toBe('/admin/tester/issues/source'); await v.click('CONFIRM ISSUE ACTION'); expect(post).toHaveBeenCalledTimes(1); await v.click('FIND TARGET ISSUE'); await v.click('Target · PUBLISHED'); await v.click('PREVIEW ACTION'); await v.click('CONFIRM ISSUE ACTION'); expect(post.mock.calls[1]?.[1]).toMatchObject({ expectedSourceRevision: 9, expectedTargetRevision: 10 });
});
it('does not submit another tab’s saved operation', async () => { const v = await mount(); await v.reopen(); await v.reason('Recurrence.'); await v.click('PREVIEW ACTION'); localStorage.setItem('pkw:issue-action:v1:["admin","source"]', '{"requestId":"different"}'); await v.click('CONFIRM ISSUE ACTION'); expect(post).not.toHaveBeenCalled(); expect(v.host.textContent).toContain('Saved action changed'); });
it('aborts on account switch, keeps unresolved intent and hides private receipt', async () => {
  let done!: (value: unknown) => void; post.mockImplementation(() => new Promise(r => { done = r; })); const v = await mount(); await v.reopen(); await v.reason('Recurrence.'); await v.click('PREVIEW ACTION'); await v.click('CONFIRM ISSUE ACTION'); await act(async () => useApp.setState({ wallet: 'other' })); expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true); await act(async () => done({ awardClaims: [{ reportId: 'secret', issueId: 'source', points: 20 }] })); expect(v.host.textContent).toContain('ACCOUNT CHANGED'); expect(v.host.textContent).not.toContain('secret'); expect(localStorage.length).toBe(1);
});
