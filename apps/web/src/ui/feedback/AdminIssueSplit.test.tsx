/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { ApiError } from '../../lib/api';
import Split from './AdminIssueSplit';
import type { AdminIssue } from './AdminIssueEditor';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), api: { get, postRaw: post } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const issue: AdminIssue = { id: 'source', title: 'Source', summary: 'Source public summary', category: 'bug', status: 'open', fixedRelease: null, workaround: null, publishedAt: null, revision: 2, mergedInto: null };
const report = (id: string, revision = 3) => ({ id, title: id, revision, issueId: issue.id });
const ends: Array<() => Promise<void>> = [];
async function mount() {
  useApp.setState({ wallet: 'admin' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<Split wallet="admin" issue={issue} onBack={() => {}} />));
  const end = async () => { await act(async () => root.unmount()); host.remove(); }; ends.push(end);
  return { host, close: async () => { ends.splice(ends.indexOf(end), 1); await end(); }, click: async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)?.click()); }, toggle: async (label: string) => { await act(async () => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!.click()); }, fill: async (label: string, value: string) => { const el = host.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); }); } };
}
async function prepare(v: Awaited<ReturnType<typeof mount>>) { await v.click('LOAD LINKED REPORTS'); await v.toggle('Split report chosen'); await v.fill('Split issue title', 'Distinct issue'); await v.fill('Split issue summary', 'Approved separate summary'); await v.fill('Split reason', 'Private staff evidence'); }
afterEach(async () => { for (const end of ends.splice(0)) await end(); localStorage.clear(); get.mockReset(); post.mockReset(); });
it('paginates actual linked reports, keeps explicit selections, and sends only the confirmed subset and approved target fields', async () => {
  get.mockResolvedValueOnce({ feedback: [report('chosen'), report('not-selected')], nextCursor: 'page2' }).mockResolvedValueOnce({ feedback: [report('later', 8), { ...report('foreign'), issueId: 'other' }], nextCursor: null }); post.mockResolvedValue({ targetIssueId: 'new', movedReportIds: ['chosen', 'later'], awardClaims: [{ reportId: 'chosen', points: 10 }] });
  const v = await mount(); expect(v.host.querySelector<HTMLTextAreaElement>('[aria-label="Split issue summary"]')?.value).toBe(''); await prepare(v); await v.click('MORE LINKED REPORTS'); expect(get.mock.calls[1]?.[0]).toBe('/admin/tester/feedback/page?issueId=source&cursor=page2'); expect(v.host.querySelector<HTMLInputElement>('[aria-label="Split report foreign"]')?.disabled).toBe(true); await v.toggle('Split report later'); await v.toggle('Publish split issue'); await v.click('CONFIRM SPLIT'); expect(post).not.toHaveBeenCalled(); await v.click('PREVIEW SPLIT'); expect(v.host.querySelector('[aria-label="Split preview"]')?.textContent).not.toContain('Private staff evidence'); await v.fill('Split issue summary', 'Reviewed changed summary'); await v.click('CONFIRM SPLIT'); expect(post).not.toHaveBeenCalled(); await v.click('PREVIEW SPLIT'); await v.click('CONFIRM SPLIT');
  expect(post.mock.calls[0]?.[0]).toBe('/admin/tester/issues/source/split'); expect(post.mock.calls[0]?.[1]).toEqual({ requestId: expect.any(String), expectedSourceRevision: 2, reason: 'Private staff evidence', reports: [{ id: 'chosen', expectedRevision: 3 }, { id: 'later', expectedRevision: 8 }], target: { title: 'Distinct issue', summary: 'Reviewed changed summary', category: 'bug', status: 'open', workaround: null, fixedRelease: null, published: true } }); expect(v.host.textContent).toContain('10 historical points retained');
});
it('restores the exact split after a lost reply and requires explicit retry', async () => {
  get.mockResolvedValue({ feedback: [report('chosen')], nextCursor: null }); post.mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ targetIssueId: 'new', movedReportIds: ['chosen'], awardClaims: [] }); let v = await mount(); await prepare(v); await v.click('PREVIEW SPLIT'); await v.click('CONFIRM SPLIT'); const body = post.mock.calls[0]?.[1]; await v.close(); v = await mount(); expect(post).toHaveBeenCalledTimes(1); await v.click('RETRY SAVED SPLIT'); expect(post.mock.calls[1]?.[1]).toEqual(body); expect(localStorage.length).toBe(0);
});
it('stale report revisions require fresh selection, while retaining the staff-written target', async () => {
  get.mockResolvedValueOnce({ feedback: [report('chosen')], nextCursor: null }).mockResolvedValueOnce({ ...issue, revision: 7 }).mockResolvedValueOnce({ feedback: [report('chosen', 11)], nextCursor: null }); post.mockRejectedValueOnce(new ApiError(409, 'Report changed', 'FEEDBACK_REVIEW_STALE')).mockResolvedValue({ targetIssueId: 'new', movedReportIds: ['chosen'], awardClaims: [] }); const v = await mount(); await prepare(v); await v.click('PREVIEW SPLIT'); await v.click('CONFIRM SPLIT'); expect(get.mock.calls[1]?.[0]).toBe('/admin/tester/issues/source'); expect(v.host.textContent).toContain('0 reports selected'); expect(v.host.querySelector<HTMLTextAreaElement>('[aria-label="Split issue title"]')?.value).toBe('Distinct issue'); await v.click('CONFIRM SPLIT'); expect(post).toHaveBeenCalledTimes(1); await v.click('LOAD LINKED REPORTS'); await v.toggle('Split report chosen'); await v.click('PREVIEW SPLIT'); await v.click('CONFIRM SPLIT'); expect(post.mock.calls[1]?.[1]).toMatchObject({ expectedSourceRevision: 7, reports: [{ id: 'chosen', expectedRevision: 11 }] });
});
it('does not render late private report pages after switching accounts', async () => {
  let done!: (value: unknown) => void; get.mockImplementation(() => new Promise(r => { done = r; })); const v = await mount(); await v.click('LOAD LINKED REPORTS'); await act(async () => useApp.setState({ wallet: 'other' })); expect(get.mock.calls[0]?.[1].signal.aborted).toBe(true); await act(async () => done({ feedback: [report('private-secret')], nextCursor: null })); expect(v.host.textContent).toContain('ACCOUNT CHANGED'); expect(v.host.textContent).not.toContain('private-secret'); expect(post).not.toHaveBeenCalled();
});
it('does not replace another tab’s pending split with this selection', async () => { get.mockResolvedValue({ feedback: [report('chosen')], nextCursor: null }); const v = await mount(); await prepare(v); await v.click('PREVIEW SPLIT'); localStorage.setItem('pkw:issue-split:v1:["admin","source"]', '{"requestId":"other-tab"}'); await v.click('CONFIRM SPLIT'); expect(post).not.toHaveBeenCalled(); expect(v.host.textContent).toContain('Saved split changed'); });
