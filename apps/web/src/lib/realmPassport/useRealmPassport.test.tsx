// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api } from '../api';
import { useRealmPassport } from './useRealmPassport';
import { current, deferred, expeditions, firstPage, pageEnd, id, inclusions, otherWallet, unavailable, wallet } from './fixtures.test-support';
let root: Root, host: HTMLDivElement, live: ReturnType<typeof useRealmPassport>;
function Harness() { live = useRealmPassport(); return <p>{JSON.stringify(live.history.response)}</p>; }
const until = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); check(); });
const mount = async () => { await act(async () => root.render(<StrictMode><Harness /></StrictMode>)); };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); useApp.getState().setAuth(wallet, true); useApp.getState().setScreen('bases');
  vi.spyOn(api, 'getPrivate').mockImplementation(async path => path.includes('/current') ? current() as never : path.includes('/inclusions') ? inclusions() as never : expeditions(path.includes('advanced') ? 'advanced' : 'starter') as never);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null); });
it('appends only the next page; refresh replaces it from the beginning to find late returns', async () => {
  vi.mocked(api.getPrivate).mockImplementation(async path => path.includes('cursor=') ? expeditions('starter', [pageEnd + 1]) as never : firstPage() as never);
  await mount(); await until(() => expect(live.nextCursor).toBe(id(pageEnd)));
  await act(async () => { await live.more(); }); expect(host.textContent).toContain(id(pageEnd + 1)); expect(live.nextCursor).toBeNull();
  await act(async () => live.refresh()); await until(() => expect(live.nextCursor).toBe(id(pageEnd))); expect(host.textContent).not.toContain(id(pageEnd + 1));
});
it('changing expedition filter immediately clears old rows and excludes an old delayed page', async () => {
  const delayed = deferred<unknown>();
  vi.mocked(api.getPrivate).mockImplementation(path => path.includes('advanced') ? Promise.resolve(expeditions('advanced', [8])) as never : delayed.promise as never);
  await mount(); await act(async () => live.setSection('advanced')); await until(() => expect(host.textContent).toContain(id(8)));
  await act(async () => delayed.resolve(expeditions('starter', [1]))); expect(host.textContent).not.toContain(id(1)); expect(live.section).toBe('advanced');
});
it('account switch clears prior rows before a new reply and cannot reveal a delayed old actor response', async () => {
  await mount(); await until(() => expect(host.textContent).toContain(id(1)));
  const delayed = deferred<unknown>(); vi.mocked(api.getPrivate).mockReturnValue(delayed.promise);
  await act(async () => live.refresh()); await act(async () => useApp.getState().setAuth(otherWallet, true));
  expect(host.textContent).not.toContain(id(1)); await act(async () => delayed.resolve(expeditions())); expect(host.textContent).not.toContain(id(1));
});
it('cookie generation invalidation refuses late same-wallet data', async () => {
  const delayed = deferred<unknown>(); let valid = true;
  vi.spyOn(authCookies, 'current').mockImplementation(() => valid); vi.mocked(api.getPrivate).mockReturnValue(delayed.promise);
  await mount(); valid = false; await act(async () => delayed.resolve(expeditions())); expect(host.textContent).not.toContain(id(1));
});
it('current participation can be unavailable while published history remains available', async () => {
  vi.mocked(api.getPrivate).mockImplementation(async path => path.includes('/current') ? unavailable as never : path.includes('/inclusions') ? inclusions() as never : expeditions() as never);
  await mount(); await act(async () => live.setSection('mining'));
  await until(() => expect(live.current.response?.state).toBe('unavailable')); expect(live.history.response?.state).toBe('available');
});
it('a failed next page retains loaded rows and retries that cursor; an unavailable first page never becomes zero history', async () => {
  vi.mocked(api.getPrivate).mockImplementation(async path => { if (path.includes('cursor=')) throw Error('offline'); return firstPage() as never; });
  await mount(); await until(() => expect(live.nextCursor).toBe(id(pageEnd))); await act(async () => { await live.more(); });
  expect(live.history.error).toBeTruthy(); expect(host.textContent).toContain(id(1)); expect(live.nextCursor).toBe(id(pageEnd));
  vi.mocked(api.getPrivate).mockResolvedValue(expeditions('starter', [pageEnd + 1])); await act(async () => { await live.more(); }); expect(host.textContent).toContain(id(pageEnd + 1));
  vi.mocked(api.getPrivate).mockResolvedValue(unavailable); await act(async () => live.refresh());
  await until(() => expect(live.history.response?.state).toBe('unavailable')); expect(host.textContent).not.toContain(id(1));
});

it('does not combine pages from different mining chain identities', async () => {
  const first = inclusions(Array.from({ length: pageEnd }, (_, i) => String(i + 1)), String(pageEnd));
  const next = inclusions([String(pageEnd + 1)]); if (next.state === 'available') next.data.rows[0]!.genesisHash = otherWallet;
  vi.mocked(api.getPrivate).mockImplementation(async path => path.includes('/current') ? current() as never : path.includes('cursor=') ? next as never : path.includes('/inclusions') ? first as never : expeditions() as never);
  await mount(); await act(async () => live.setSection('mining')); await until(() => expect(live.nextCursor).toBe(String(pageEnd)));
  await act(async () => { await live.more(); }); expect(live.history.error).toContain('source changed');
  if (live.history.response?.state === 'available') expect(live.history.response.data.rows).toHaveLength(pageEnd);
});
