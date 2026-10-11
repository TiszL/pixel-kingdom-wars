/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
import { useFeedbackPages } from './useFeedbackPages';
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ends: Array<() => Promise<void>> = [];
function View({ path }: { path: string }) { const p = useFeedbackPages<{ id: string; title: string }>('wallet', path); return <div>{p.data?.feedback.map(r => <span key={r.id}>{r.title}</span>)}<button onClick={p.more}>MORE</button><button onClick={p.reload}>RELOAD</button>{p.error}</div>; }
async function mount(path = '/tester/feedback/page') { useApp.setState({ wallet: 'wallet' }); const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); await act(async () => root.render(<View path={path} />)); ends.push(async () => { await act(async () => root.unmount()); host.remove(); }); return { host, render: async (path: string) => { await act(async () => root.render(<View path={path} />)); }, click: async (label: string) => { await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click()); } }; }
afterEach(async () => { for (const end of ends.splice(0)) await end(); get.mockReset(); });
it('traverses cursor pages once, deduplicates overlapping reports and retries failed continuation without dropping loaded rows', async () => {
  get.mockResolvedValueOnce({ feedback: [{ id: 'a', title: 'A' }], nextCursor: 'opaque/2' }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ feedback: [{ id: 'a', title: 'updated A' }, { id: 'b', title: 'B' }], nextCursor: null }); const v = await mount(); await v.click('MORE'); expect(v.host.textContent).toContain('A'); await v.click('MORE'); expect(get.mock.calls[1]?.[0]).toBe('/tester/feedback/page?cursor=opaque%2F2'); expect(get.mock.calls[2]?.[0]).toBe(get.mock.calls[1]?.[0]); expect(v.host.querySelectorAll('span')).toHaveLength(2); expect(v.host.textContent).toContain('updated A');
});
it('changing filters aborts an older page and never applies its late private rows', async () => {
  let done!: (x: unknown) => void; get.mockResolvedValueOnce({ feedback: [{ id: 'a', title: 'old filter' }], nextCursor: 'next' }).mockImplementationOnce(() => new Promise(r => { done = r; })).mockResolvedValueOnce({ feedback: [{ id: 'b', title: 'new filter' }], nextCursor: null }); const v = await mount('/admin/tester/feedback/page?status=new'); await v.click('MORE'); await v.render('/admin/tester/feedback/page?fixed=true'); expect(get.mock.calls[1]?.[1].signal.aborted).toBe(true); await act(async () => done({ feedback: [{ id: 'c', title: 'late secret' }], nextCursor: null })); expect(v.host.textContent).toContain('new filter'); expect(v.host.textContent).not.toContain('late secret'); expect(v.host.textContent).not.toContain('old filter');
});
it('wallet switch removes visible private rows and prevents additional page requests', async () => { get.mockResolvedValue({ feedback: [{ id: 'a', title: 'private report' }], nextCursor: 'next' }); const v = await mount(); await act(async () => useApp.setState({ wallet: 'other' })); expect(v.host.textContent).not.toContain('private report'); await v.click('MORE'); expect(get).toHaveBeenCalledTimes(1); });
