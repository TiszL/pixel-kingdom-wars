/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import Action from './AdminFeedbackStateAction';
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), api: { postRaw: post } }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); localStorage.clear(); post.mockReset(); });
async function mount(kind: 'fixed' | 'trash' = 'fixed', current = false, status = 'accepted', quickFix = false) {
  useApp.setState({ wallet: 'admin' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const changed = vi.fn(), pendingChanged = vi.fn(); let revision = 7, disabled = false;
  const render = () => root.render(<Action wallet="admin" reportId="report" revision={revision} kind={kind} current={current} status={status} quickFix={quickFix} disabled={disabled} onPending={pendingChanged} onChanged={changed} />);
  await act(async () => render()); const close = async () => { await act(async () => root.unmount()); host.remove(); }; cleanup.push(close);
  return { host, changed, pendingChanged, disable: async (value: boolean) => { disabled = value; await act(async () => render()); }, close: async () => { cleanup.splice(cleanup.indexOf(close), 1); await close(); }, refresh: async () => { revision++; await act(async () => render()); },
    click: async (label: string) => { const b = [...host.querySelectorAll('button')].find(b => b.textContent === label); if (!b) throw Error(`Missing ${label}`); await act(async () => b.click()); },
    reason: async () => { const el = host.querySelector('textarea')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, 'Verified action'); el.dispatchEvent(new Event('input', { bubbles: true })); }); } };
}
it('requires review and submits Fixed separately from reward/triage fields', async () => {
  post.mockResolvedValue({}); const v = await mount(); await v.click('MARK FIXED'); await v.reason(); expect(post).not.toHaveBeenCalled();
  expect(v.host.textContent).toContain('SHARED WITH PLAYER'); await v.click('REVIEW: MARK FIXED'); expect(v.host.textContent).toContain('The report moves between Accepted and Fixed'); await v.click('CONFIRM: MARK FIXED');
  expect(post.mock.calls[0]?.slice(0, 2)).toEqual(['/admin/tester/feedback/report/fixed', { requestId: expect.any(String), expectedRevision: 7, fixed: true, reason: 'Verified action' }]); expect(v.changed).toHaveBeenCalledWith(true);
});
it('restores the exact uncertain trash intent after reload without automatically posting', async () => {
  post.mockRejectedValueOnce(Error('lost')).mockResolvedValue({}); let v = await mount('trash'); await v.click('MOVE TO TRASH'); await v.reason(); expect(v.host.textContent).toContain('PRIVATE ADMIN REASON'); await v.click('REVIEW: MOVE TO TRASH'); await v.click('CONFIRM: MOVE TO TRASH');
  const original = post.mock.calls[0]?.[1]; expect(original).toMatchObject({ trashed: true, expectedRevision: 7 }); await v.close(); v = await mount('trash'); expect(post).toHaveBeenCalledTimes(1); await v.click('RETRY SAVED REPORT ACTION'); expect(post.mock.calls[1]?.[1]).toEqual(original); expect(localStorage.length).toBe(0);
});
it('offers reversible restore and clearing Fixed without changing rewards or closure', async () => {
  post.mockResolvedValue({}); const v = await mount('trash', true); await v.click('RESTORE REPORT'); await v.reason(); await v.click('REVIEW: RESTORE REPORT'); expect(v.host.textContent).toContain('reply closure and rewards are retained'); await v.click('CONFIRM: RESTORE REPORT'); expect(post.mock.calls[0]?.[1]).toMatchObject({ trashed: false });
  const f = await mount('fixed', true, 'accepted'); await f.click('REOPEN AS ACCEPTED'); await f.reason(); await f.click('REVIEW: REOPEN AS ACCEPTED'); await f.click('CONFIRM: REOPEN AS ACCEPTED'); expect(post.mock.calls[1]?.[1]).toEqual({ requestId: expect.any(String), expectedRevision: 7, reason: 'Verified action', fixed: false });
});
it('requires fresh review after changed server state and a stale response, without automatic retry', async () => {
  const v = await mount(); await v.click('MARK FIXED'); await v.reason(); await v.click('REVIEW: MARK FIXED'); await v.refresh(); await v.click('CONFIRM: MARK FIXED'); expect(post).not.toHaveBeenCalled(); expect(v.host.textContent).toContain('Report changed');
  post.mockRejectedValue(new ApiError(409, 'stale report', 'FEEDBACK_REVIEW_STALE')); await v.click('REVIEW: MARK FIXED'); await v.click('CONFIRM: MARK FIXED'); expect(v.changed).toHaveBeenCalledWith(false); expect(localStorage.length).toBe(0); expect(post).toHaveBeenCalledOnce(); expect(v.host.textContent).not.toContain('CONFIRM: MARK FIXED');
});
it('blocks rejected/duplicate Fixed and fences a late result after wallet switch', async () => {
  for (const status of ['new', 'reviewed', 'rejected', 'duplicate']) { const view = await mount('fixed', false, status); expect(view.host.querySelector('button')!.disabled).toBe(true); expect(view.host.textContent).toContain('Accept this report'); await view.close(); }
  let done!: (value: unknown) => void; post.mockImplementation(() => new Promise(resolve => { done = resolve; })); const v = await mount('trash'); await v.click('MOVE TO TRASH'); await v.reason(); await v.click('REVIEW: MOVE TO TRASH'); await v.click('CONFIRM: MOVE TO TRASH'); await act(async () => useApp.setState({ wallet: 'other' })); expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true); await act(async () => done({})); expect(v.changed).not.toHaveBeenCalled(); expect(v.host.querySelector('button')).toBeNull(); expect(localStorage.length).toBe(1);
});

it('marks an accepted report fixed in one click without changing rewards, closure or screenshots', async () => {
  post.mockResolvedValue({ revision: 8 }); const v = await mount('fixed', false, 'accepted', true);
  expect(post).not.toHaveBeenCalled(); expect(v.host.querySelector('details')?.open).toBe(false);
  await v.click('MARK FIXED');
  expect(post.mock.calls[0]?.slice(0, 2)).toEqual(['/admin/tester/feedback/report/fixed', {
    requestId: expect.any(String), expectedRevision: 7, fixed: true, reason: 'The team has marked this report as fixed.',
  }]);
  expect(v.changed).toHaveBeenCalledWith(true); expect(v.host.textContent).toContain('MARKED FIXED');
  expect(v.pendingChanged).toHaveBeenLastCalledWith(false);
});

it('sends one fixed request for rapid clicks and retains its exact recovery across a lost response and remount', async () => {
  let fail!: (cause: Error) => void; post.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue({ revision: 8 });
  let v = await mount('fixed', false, 'accepted', true);
  const button = [...v.host.querySelectorAll('button')].find(b => b.textContent === 'MARK FIXED')!;
  await act(async () => { button.click(); button.click(); }); expect(post).toHaveBeenCalledTimes(1);
  expect(v.pendingChanged).toHaveBeenLastCalledWith(true);
  const input = post.mock.calls[0]?.[1]; await act(async () => fail(Error('Lost response'))); await v.close();
  // The server may already project Fixed when the client did not receive its receipt.
  v = await mount('fixed', true, 'fixed', true); expect(post).toHaveBeenCalledTimes(1);
  await v.click('RETRY SAVED REPORT ACTION'); expect(post.mock.calls[1]?.[1]).toEqual(input);
  expect(localStorage.length).toBe(0); expect(v.changed).toHaveBeenCalledWith(true);
});

it('does not turn a stale one-click fixed request into automatic acceptance or retry', async () => {
  post.mockRejectedValueOnce(new ApiError(409, 'Report changed', 'FEEDBACK_REVIEW_STALE')).mockResolvedValue({ revision: 9 });
  const v = await mount('fixed', false, 'accepted', true); await v.click('MARK FIXED');
  expect(post).toHaveBeenCalledTimes(1); expect(v.changed).toHaveBeenCalledWith(false); expect(localStorage.length).toBe(0);
  await v.refresh(); await v.click('MARK FIXED');
  expect(post.mock.calls[1]?.[1].expectedRevision).toBe(8);
  expect(post.mock.calls[1]?.[1].requestId).not.toBe(post.mock.calls[0]?.[1].requestId);
});

it('blocks new one-click actions during other pending work without deadlocking an exact saved recovery', async () => {
  post.mockRejectedValueOnce(Error('Lost response')).mockResolvedValue({ revision: 8 });
  const v = await mount('fixed', false, 'accepted', true); await v.disable(true); await v.click('MARK FIXED'); expect(post).not.toHaveBeenCalled();
  await v.disable(false); await v.click('MARK FIXED'); const input = post.mock.calls[0]?.[1];
  await v.disable(true); await v.click('RETRY SAVED REPORT ACTION'); expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1]?.[1]).toEqual(input); expect(localStorage.length).toBe(0);
});

it('aborts one-click fixed on account changes and keeps the intent for the original admin', async () => {
  let done!: (value: unknown) => void; post.mockImplementation(() => new Promise(resolve => { done = resolve; }));
  const v = await mount('fixed', false, 'accepted', true); await v.click('MARK FIXED');
  await act(async () => useApp.setState({ wallet: 'other' })); expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true);
  await act(async () => done({ revision: 8 })); expect(v.changed).not.toHaveBeenCalled(); expect(v.host.querySelector('button')).toBeNull(); expect(localStorage.length).toBe(1);
});

it('keeps custom fix notes and references optional under the same action handler', async () => {
  post.mockResolvedValue({ revision: 8 }); const v = await mount('fixed', false, 'accepted', true); await v.reason();
  const input = v.host.querySelector<HTMLInputElement>('[aria-label="Report fix reference"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'release-123'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await v.click('REVIEW: MARK FIXED'); await v.click('CONFIRM: MARK FIXED');
  expect(post.mock.calls[0]?.[1]).toMatchObject({ fixed: true, reason: 'Verified action', fixedRef: 'release-123' }); expect(post).toHaveBeenCalledTimes(1);
});
