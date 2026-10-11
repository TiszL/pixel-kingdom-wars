/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { ApiError } from '../../lib/api';
import Control from './FeedbackRetentionControl';
const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), api: { postRaw: post } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ends: Array<() => Promise<void>> = [];
async function mount(kind: 'closure' | 'preservation' = 'closure') {
  useApp.setState({ wallet: 'admin' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), changed = vi.fn();
  await act(async () => root.render(<Control wallet="admin" reportId="report" revision={7} target={kind === 'closure' ? { kind, current: false } : { kind, current: false, attachmentId: 'image' }} disabled={false} onChanged={changed} />));
  const end = async () => { await act(async () => root.unmount()); host.remove(); }; ends.push(end);
  return { host, changed, refresh: async () => { await act(async () => root.render(<Control wallet="admin" reportId="report" revision={8} target={{ kind: 'closure', current: true }} disabled={false} onChanged={changed} />)); }, close: async () => { ends.splice(ends.indexOf(end), 1); await end(); }, click: async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)?.click()); }, reason: async () => { const el = host.querySelector('textarea')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, 'Verified reason'); el.dispatchEvent(new Event('input', { bubbles: true })); }); } };
}
afterEach(async () => { for (const end of ends.splice(0)) await end(); localStorage.clear(); post.mockReset(); });
it('requires explicit review and sends closure as a revision-bound public status change', async () => {
  post.mockResolvedValue({}); const v = await mount(); expect(v.host.textContent).toContain('SHARED WITH PLAYER'); await v.reason(); await v.click('CONFIRM: CLOSE PRIVATE THREAD'); expect(post).not.toHaveBeenCalled(); await v.click('REVIEW THREAD CLOSURE'); await v.click('CONFIRM: CLOSE PRIVATE THREAD'); expect(post.mock.calls[0]?.slice(0, 2)).toEqual(['/admin/tester/feedback/report/closure', { requestId: expect.any(String), expectedRevision: 7, reason: 'Verified reason', closed: true }]); expect(v.changed).toHaveBeenCalledOnce();
});
it('keeps preservation reason private and restores exact uncertain upload retention action after remount', async () => {
  post.mockRejectedValueOnce(new Error('lost')).mockResolvedValue({}); let v = await mount('preservation'); expect(v.host.textContent).toContain('PRIVATE STAFF HISTORY'); await v.reason(); await v.click('REVIEW PRESERVATION'); await v.click('CONFIRM: PRESERVE SCREENSHOT'); const body = post.mock.calls[0]?.[1]; expect(post.mock.calls[0]?.[0]).toBe('/admin/tester/feedback/report/screenshots/image/preservation'); expect(body).toMatchObject({ preserved: true, expectedRevision: 7 }); await v.close(); v = await mount('preservation'); expect(post).toHaveBeenCalledTimes(1); await v.click('RETRY SAVED RETENTION ACTION'); expect(post.mock.calls[1]?.[1]).toEqual(body); expect(localStorage.length).toBe(0);
});
it('a stale revision refreshes parent and requires review again without automatically retrying', async () => {
  post.mockRejectedValue(new ApiError(409, 'changed', 'FEEDBACK_REVIEW_STALE')); const v = await mount(); await v.reason(); await v.click('REVIEW THREAD CLOSURE'); await v.click('CONFIRM: CLOSE PRIVATE THREAD'); expect(v.changed).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(0); await v.click('CONFIRM: CLOSE PRIVATE THREAD'); expect(post).toHaveBeenCalledTimes(1);
});
it('account switch aborts and retains pending recovery without showing a late receipt', async () => {
  let done!: (v: unknown) => void; post.mockImplementation(() => new Promise(r => { done = r; })); const v = await mount(); await v.reason(); await v.click('REVIEW THREAD CLOSURE'); await v.click('CONFIRM: CLOSE PRIVATE THREAD'); await act(async () => useApp.setState({ wallet: 'other' })); expect(post.mock.calls[0]?.[2].signal.aborted).toBe(true); await act(async () => done({})); expect(v.changed).not.toHaveBeenCalled(); expect(localStorage.length).toBe(1); expect(v.host.textContent).toContain('ACCOUNT CHANGED');
});

it('requires fresh consent when a background refresh changes closure state after preview', async () => { const v = await mount(); await v.reason(); await v.click('REVIEW THREAD CLOSURE'); await v.refresh(); await v.click('CONFIRM: REOPEN PRIVATE THREAD'); expect(post).not.toHaveBeenCalled(); expect(v.host.textContent).toContain('current state changed'); });
