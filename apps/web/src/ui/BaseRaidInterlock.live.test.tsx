/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { useApp } from '../state/store';
import { useActiveBaseRaid } from './BaseRaidInterlock';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, get: vi.fn(), openStream: vi.fn() } };
});
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
const originalOnline = Object.getOwnPropertyDescriptor(navigator, 'onLine');
let root: Root;
let host: HTMLDivElement;
const live = { raidId: 'raid-a', state: 'live' };
let streams: Array<{
  writer: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal; cancel: ReturnType<typeof vi.fn>;
}>;
function Probe(): React.JSX.Element {
  const baseId = useApp((s) => s.selectedBaseId);
  const enabled = useApp((s) => s.authed);
  const raid = useActiveBaseRaid(baseId, enabled);
  return <span>{raid === undefined ? 'unknown' : raid === null ? 'free' : `${raid.raidId}/${raid.state}`}</span>;
}
const flush = async (): Promise<void> => {
  await act(async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); });
};
const mount = async (): Promise<void> => { await act(async () => root.render(<Probe />)); await flush(); };
const emit = async (index: number, activeRaid: unknown, baseId = 'base-a'): Promise<void> => {
  await act(async () => streams[index]!.writer.enqueue(new TextEncoder().encode(
    `event: snapshot\ndata: ${JSON.stringify({ baseId, activeRaid })}\n\n`,
  )));
  await flush();
};
const tick = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const lifecycle = async (name: string, visible = true, online = true): Promise<void> => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
  await act(async () => { (name === 'visibilitychange' ? document : window).dispatchEvent(new Event(name)); });
  await flush();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useApp.setState({ wallet: 'wallet-a', authed: true, selectedBaseId: 'base-a', baseSelectionEpoch: 1 });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  streams = [];
  vi.mocked(api.get).mockReset().mockRejectedValue(new Error('unavailable'));
  vi.mocked(api.openStream).mockReset().mockImplementation(async (_path, { signal }) => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start: (value) => { writer = value; }, cancel });
    streams.push({ writer, signal, cancel });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const [target, key, descriptor] of [[document, 'visibilityState', originalVisibility], [navigator, 'onLine', originalOnline]] as const) {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
});

describe('selected-base streaming authority', () => {
  it('stays unknown until the initial snapshot and stops two-second HTTP polling while healthy', async () => {
    await mount();
    expect(host.textContent).toBe('unknown');
    await emit(0, null);
    expect(host.textContent).toBe('free');
    for (let i = 0; i < 3; i++) {
      await tick(15_000);
      await act(async () => streams[0]!.writer.enqueue(new TextEncoder().encode(': heartbeat\n\n')));
    }
    expect(api.get).not.toHaveBeenCalled();
    expect(api.openStream).toHaveBeenCalledTimes(1);
  });

  it('preserves a known lock through disconnect and read failure until a fresh reconnect snapshot', async () => {
    await mount();
    await emit(0, live);
    await act(async () => streams[0]!.writer.close());
    await flush();
    expect(host.textContent).toBe('raid-a/live');
    expect(api.get).toHaveBeenCalledTimes(1);
    await tick(1_000);
    expect(streams).toHaveLength(2);
    expect(host.textContent).toBe('raid-a/live');
    await emit(1, null);
    expect(host.textContent).toBe('free');
  });

  it('makes an old unlocked result unknown on loss and rejects a malformed reconnect frame', async () => {
    await mount();
    await emit(0, null);
    await act(async () => streams[0]!.writer.close());
    await flush();
    expect(host.textContent).toBe('unknown');
    await tick(1_000);
    await emit(1, null, 'other-base');
    expect(host.textContent).toBe('unknown');
  });

  it('bounds a silent stream and switches to canonical fallback without losing the lock', async () => {
    await mount();
    await emit(0, live);
    await tick(30_000);
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(host.textContent).toBe('raid-a/live');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps fallback single-flight when streaming is disabled and a status request is slow', async () => {
    vi.mocked(api.openStream).mockRejectedValue(new ApiError(404, 'Disabled', 'RAID_EVENTS_DISABLED'));
    let answer!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await mount();
    await tick(8_000);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.openStream).toHaveBeenCalledTimes(1);
    answer({ activeRaid: live });
    await flush();
    expect(host.textContent).toBe('raid-a/live');
    await tick(2_000);
    expect(api.get).toHaveBeenCalledTimes(2);
    answer({ activeRaid: null });
    await flush();
  });

  it('discards an in-flight fallback result once streaming has supplied newer authority', async () => {
    let answer!: (value: unknown) => void;
    vi.mocked(api.get).mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    await mount();
    await tick(2_000);
    await emit(0, live);
    answer({ activeRaid: null });
    await flush();
    expect(host.textContent).toBe('raid-a/live');
    await tick(2_000);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it.each(['wallet', 'base', 'epoch'])('aborts the prior stream and rejects old state on a %s change', async (kind) => {
    await mount();
    await emit(0, null);
    await act(async () => useApp.setState(kind === 'wallet' ? { wallet: 'wallet-b' }
      : kind === 'base' ? { selectedBaseId: 'base-b' } : { baseSelectionEpoch: 2 }));
    await flush();
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(host.textContent).toBe('unknown');
    expect(streams).toHaveLength(2);
    await emit(1, live, kind === 'base' ? 'base-b' : 'base-a');
    expect(host.textContent).toBe('raid-a/live');
  });

  it('aborts on hidden/offline/logout, resumes with a fresh snapshot, and leaves no timers on unmount', async () => {
    await mount();
    await emit(0, null);
    await lifecycle('visibilitychange', false);
    expect(streams[0]!.signal.aborted).toBe(true);
    expect(host.textContent).toBe('unknown');
    await tick(60_000);
    expect(streams).toHaveLength(1);
    await lifecycle('visibilitychange');
    expect(streams).toHaveLength(2);
    await emit(1, live);
    await lifecycle('offline', true, false);
    expect(streams[1]!.signal.aborted).toBe(true);
    expect(host.textContent).toBe('raid-a/live');
    await lifecycle('online');
    expect(streams).toHaveLength(3);
    await act(async () => useApp.getState().setAuth(null));
    await flush();
    expect(streams[2]!.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
