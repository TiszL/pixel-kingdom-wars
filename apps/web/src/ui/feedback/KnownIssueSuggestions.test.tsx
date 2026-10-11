/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { FEEDBACK_ISSUES } from '@shardkeep/shared/feedback';
import { useApp } from '../../state/store';
import KnownIssueSuggestions from './KnownIssueSuggestions';
const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get, postRaw: post } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const issue = { id: 'published', title: 'Wall selection', summary: 'Published summary', category: 'bug', status: 'investigating', affectedPlayerCount: 2, workaround: 'Tap again', fixedRelease: null };
const cleanups: Array<() => Promise<void>> = [];
async function mount() {
  vi.useFakeTimers(); useApp.setState({ wallet: 'owner' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const escape = vi.fn();
  const render = async (query = '', category = 'bug') => { await act(async () => root.render(<KnownIssueSuggestions wallet="owner" query={query} category={category} onDifferent={escape} />)); };
  await render(); cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const tick = async () => { await act(async () => vi.advanceTimersByTimeAsync(FEEDBACK_ISSUES.searchDebounceMs)); };
  const click = async (label: string, twice = false) => { const button = [...host.querySelectorAll('button')].find(b => b.textContent === label)!; await act(async () => { button.click(); if (twice) button.click(); }); };
  return { host, render, tick, click, escape };
}
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); vi.useRealTimers(); get.mockReset(); post.mockReset(); });
it('debounces typing deterministically and passes only the newest query/category to the published search', async () => {
  get.mockResolvedValue({ issues: [issue] }); const view = await mount(); await view.render('wall'); await view.render('wall row','ux');
  await act(async () => vi.advanceTimersByTimeAsync(FEEDBACK_ISSUES.searchDebounceMs - 1)); expect(get).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(get).toHaveBeenCalledTimes(1);
  expect(get.mock.calls[0]?.[0]).toBe('/tester/issues?query=wall+row&category=ux');
});
it('ignores superseded search results and aborts the pending read when the account switches', async () => {
  let resolve!: (v: unknown) => void; get.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValueOnce({ issues: [{ ...issue, title: 'Newest issue' }] });
  const view = await mount(); await view.tick(); const signal = get.mock.calls[0]?.[1].signal;
  await view.render('newest'); await view.tick(); await act(async () => resolve({ issues: [issue] }));
  expect(signal.aborted).toBe(true); expect(view.host.textContent).toContain('Newest issue'); expect(view.host.textContent).not.toContain('Wall selection');
  await act(async () => useApp.setState({ wallet: 'other' })); expect(get.mock.calls[1]?.[1].signal.aborted).toBe(true);
});
it('confirms only by explicit click, prevents concurrent duplicate confirms and displays the authoritative count', async () => {
  get.mockResolvedValue({ issues: [issue] }); let done!: (value: unknown) => void; post.mockImplementation(() => new Promise(r => { done = r; }));
  const view = await mount(); await view.tick(); await view.click('Wall selection'); expect(post).not.toHaveBeenCalled();
  await view.click('I HAVE THIS TOO',true); expect(post).toHaveBeenCalledTimes(1); expect(post.mock.calls[0]?.slice(0,2)).toEqual(['/tester/issues/published/confirm',{}]);
  await act(async () => done({ ...issue, affectedPlayerCount: 3 })); expect(view.host.textContent).toContain('3 AFFECTED'); expect(view.host.textContent).toContain('CONFIRMED — THANK YOU');
  expect(view.host.textContent).toContain('earns no points');
});
it('always lets the player escape suggestions without confirming or creating any report', async () => {
  get.mockRejectedValue(new Error('Search offline')); const view = await mount(); await view.tick();
  await view.click('REPORT A DIFFERENT PROBLEM'); expect(view.escape).toHaveBeenCalledTimes(1); expect(post).not.toHaveBeenCalled();
  expect(view.host.textContent).toContain('SHOW KNOWN ISSUES');
});
