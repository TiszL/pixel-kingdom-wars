/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFantasyRead } from './data';

let root: Root, host: HTMLDivElement;
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
};
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
function Read({ scope, load, commits }: { scope: string | null; load: () => Promise<string>; commits: Array<string | null> }) {
  const value = useFantasyRead(scope, load, 1000);
  commits.push(value.data);
  return <output>{value.data ?? 'EMPTY'}</output>;
}
describe('private world reads follow the selected base identity', () => {
  it('removes the previous owner response during the first render of a new authority', async () => {
    const commits: Array<string | null> = [], second = deferred<string>();
    await act(async () => root.render(<Read scope="owner-a:base-a:1" load={() => Promise.resolve('PRIVATE A')} commits={commits} />));
    expect(host.textContent).toBe('PRIVATE A');
    const before = commits.length;
    await act(async () => root.render(<Read scope="owner-b:base-b:2" load={() => second.promise} commits={commits} />));
    expect(commits[before]).toBeNull();
    expect(host.textContent).toBe('EMPTY');
    await act(async () => second.resolve('PRIVATE B'));
    expect(host.textContent).toBe('PRIVATE B');
  });
  it('discards a delayed response after base switch or logout', async () => {
    const commits: Array<string | null> = [], old = deferred<string>();
    await act(async () => root.render(<Read scope="old-base" load={() => old.promise} commits={commits} />));
    await act(async () => root.render(<Read scope="new-base" load={() => Promise.resolve('NEW')} commits={commits} />));
    await act(async () => old.resolve('STALE PRIVATE OWNER'));
    expect(host.textContent).toBe('NEW');
    await act(async () => root.render(<Read scope={null} load={() => Promise.resolve('NO SESSION')} commits={commits} />));
    expect(host.textContent).toBe('EMPTY');
    expect(commits).not.toContain('STALE PRIVATE OWNER');
  });
  it('does not start hidden-tab polling and refreshes when the tab returns', async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const load = vi.fn(() => Promise.resolve('VISIBLE OWNER'));
    await act(async () => root.render(<Read scope="base-a" load={load} commits={[]} />));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(load).not.toHaveBeenCalled();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(load).toHaveBeenCalledOnce();
    expect(host.textContent).toBe('VISIBLE OWNER');
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(load).toHaveBeenCalledOnce();
  });
});

import { api } from '../../lib/api';
import { fantasyTileAt } from '@shardkeep/shared/fantasyWorld';
import { useFantasySearch } from './data';
function Search({ query }: { query: string }) {
 const response = useFantasySearch({ key: 'viewer:base:1', wallet: 'viewer', baseId: 'base' }, query);
 return <output>{response.data?.map(row => row.name).join(',') ?? 'EMPTY'}</output>;
}
it('owner search debounces typing, uses native addresses and retires the earlier query immediately', async () => {
 vi.useFakeTimers();
 const tile = fantasyTileAt(26, 23)!, old = deferred<{ results: Array<{ tileId: number; realmId: string; name: string; keepLevel: number; trophies: number; seeker: boolean }> }>();
 const request = vi.spyOn(api, 'get').mockImplementationOnce(() => old.promise as never).mockResolvedValue({ results: [{ tileId: tile.tileId, realmId: tile.realmId, name: 'NEW OWNER', keepLevel: 5, trophies: 10, seeker: false }] });
 await act(async () => root.render(<Search query="ol" />));
 await act(async () => vi.advanceTimersByTimeAsync(249)); expect(request).not.toHaveBeenCalled();
 await act(async () => vi.advanceTimersByTimeAsync(1)); expect(request).toHaveBeenCalledWith('/globe/fantasy/search?q=ol');
 await act(async () => root.render(<Search query="new" />));
 await act(async () => old.resolve({ results: [{ tileId: tile.tileId, realmId: tile.realmId, name: 'OLD OWNER', keepLevel: 5, trophies: 1, seeker: false }] }));
 expect(host.textContent).toBe('EMPTY');
 await act(async () => vi.advanceTimersByTimeAsync(250));
 expect(request).toHaveBeenLastCalledWith('/globe/fantasy/search?q=new'); expect(host.textContent).toBe('NEW OWNER');
});
