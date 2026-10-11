/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../lib/events';
import { useApp } from '../state/store';
import { useMineStatus } from './useMineStatus';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { get }, ApiError: class extends Error {} }));

let root: Root;
let host: HTMLDivElement;
let status!: ReturnType<typeof useMineStatus>;
function Harness() {
  status = useMineStatus();
  return <span>{status.data?.mining.accrued ?? 'unavailable'}</span>;
}
const snapshot = (accrued: number) => ({ mining: { accrued } });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  useApp.setState({ wallet: 'owner', selectedBaseId: 'deed-a', baseSelectionEpoch: 0, base: null });
  get.mockReset().mockResolvedValue(snapshot(1));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  useApp.setState({ wallet: null, selectedBaseId: null, base: null });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('live authoritative Mine status', () => {
  it('refreshes open views, same-count building upgrades, and successful collection events', async () => {
    await act(async () => root.render(<Harness />));
    expect(host.textContent).toBe('1');
    get.mockResolvedValue(snapshot(2));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(host.textContent).toBe('2');
    await act(async () => useApp.setState({ base: { buildings: [{ id: 'mine', level: 1 }] } as never }));
    get.mockResolvedValue(snapshot(3));
    // The identity count is unchanged when an existing Mine finishes upgrading.
    await act(async () => useApp.setState({ base: { buildings: [{ id: 'mine', level: 2 }] } as never }));
    expect(host.textContent).toBe('3');
    get.mockResolvedValue(snapshot(0));
    await act(async () => bus.emit('base:refresh', undefined));
    expect(host.textContent).toBe('0');
  });

  it('pauses hidden polling and retries an unavailable snapshot on return', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    await act(async () => root.render(<Harness />));
    expect(status.data).toBeNull();
    expect(status.error).toBe('offline');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(get).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    get.mockResolvedValue(snapshot(7));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(host.textContent).toBe('7');
    await act(async () => root.unmount());
    const calls = get.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(get).toHaveBeenCalledTimes(calls);
  });

  it('hides old-deed data during a switch and ignores its late response', async () => {
    await act(async () => root.render(<Harness />));
    let finishOld!: (value: unknown) => void;
    get.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    await act(async () => status.reload());
    let finishNew!: (value: unknown) => void;
    get.mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    await act(async () => useApp.setState({ selectedBaseId: 'deed-b', baseSelectionEpoch: 1 }));
    expect(host.textContent).toBe('unavailable');
    expect(get).toHaveBeenLastCalledWith('/mine/status?baseId=deed-b');
    await act(async () => finishNew(snapshot(9)));
    await act(async () => finishOld(snapshot(99)));
    expect(host.textContent).toBe('9');
  });
});
