/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import Catalogue from './AdminIssueCatalogue';
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get } }));
vi.mock('./AdminIssueEditor', () => ({ default: () => null }));
(globalThis as unknown as {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;
const issue = { id: 'draft', title: 'Staff draft', summary: 'Curated content', status: 'open', publishedAt: null, revision: 3, mergedInto: null };
const cleanups: Array<() => Promise<void>> = [];
async function mount() { useApp.setState({ wallet: 'admin' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); await act(async () => root.render(<Catalogue wallet="admin" onBack={() => { }}/>)); cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); }); return { host, click: async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click()); } }; }
afterEach(async () => { for (const fn of cleanups.splice(0))
    await fn(); get.mockReset(); });
it('paginates the applied filter and keeps draft catalogue/history private', async () => { get.mockResolvedValueOnce({ issues: [issue], nextCursor: 'page2' }).mockResolvedValueOnce({ issues: [{ ...issue, id: 'other', title: 'Second draft' }], nextCursor: null }).mockResolvedValueOnce({ actions: [{ id: 'h1', action: 'create', reason: 'Private approval reason', admin: 'staff-wallet', createdAt: '2026-09-07T10:00:00Z' }], nextCursor: 'history2' }).mockResolvedValueOnce({ actions: [{ id: 'h2', action: 'update', reason: 'Earlier private reason', admin: 'staff-wallet', createdAt: '2026-09-06T10:00:00Z' }], nextCursor: null }); const view = await mount(); const search = view.host.querySelector<HTMLInputElement>('[aria-label="Search curated issues"]')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'not submitted'); search.dispatchEvent(new Event('input', { bubbles: true })); }); await view.click('LOAD MORE ISSUES'); expect(get.mock.calls[1]?.[0]).toBe('/admin/tester/issues?query=&cursor=page2'); await view.click('VIEW STAFF HISTORY'); expect(view.host.textContent).toContain('Private approval reason'); expect(view.host.textContent).toContain('STAFF: staff-wallet'); await view.click('LOAD EARLIER HISTORY'); expect(get.mock.calls[3]?.[0]).toBe('/admin/tester/issues/draft/history?cursor=history2'); expect(view.host.textContent).toContain('Earlier private reason'); expect(get.mock.calls.every(c => c[0].startsWith('/admin/'))).toBe(true); });
it('aborts staff reads on account switch and ignores a late private catalogue response', async () => { let done!: (value: unknown) => void; get.mockImplementation(() => new Promise(r => { done = r; })); const view = await mount(); await act(async () => useApp.setState({ wallet: 'other' })); expect(get.mock.calls[0]?.[1].signal.aborted).toBe(true); await act(async () => done({ issues: [issue], nextCursor: null })); expect(view.host.textContent).not.toContain('Staff draft'); expect(view.host.textContent).toContain('ACCOUNT CHANGED'); });
