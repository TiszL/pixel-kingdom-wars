import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadGround, MAX_GROUND_DOWNLOAD_BYTES, VisibleTimeout } from './groundDownload';
import { BUILD } from '../../lib/version';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function finishTransfer<T>(pending: Promise<T>): Promise<T> {
  let value!: T, error: unknown, failed = false;
  const settled = pending.then(result => { value = result; }, reason => { failed = true; error = reason; });
  await vi.advanceTimersByTimeAsync(3_000); await settled;
  if (failed) throw error;
  return value;
}
const url = `/atlas/fantasy/ground-v2/crownlands.png?v=${BUILD.gitSha}`;
function interrupted(headers: Record<string, string> = { etag: '"one"', 'content-length': '4' }) {
  let pulled = false;
  return new Response(new ReadableStream({ pull(controller) {
    if (!pulled) { pulled = true; controller.enqueue(new Uint8Array([1, 2])); }
    else controller.error(new TypeError('network reset'));
  } }), { headers });
}
const done = (bytes: number[], headers: Record<string, string> = {}, status = 200) =>
  new Response(new Uint8Array(bytes), { status, headers });

describe('bounded terrain streaming', () => {
  it('publishes real unknown-length bytes before completion and marks the verified worker route', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(value) { controller = value; } })));
    vi.stubGlobal('fetch', fetcher);
    const report = vi.fn(), result = downloadGround(url, new AbortController().signal, report);
    controller.enqueue(new Uint8Array([1, 2]));
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith({ completed: 2, total: 0, loadAttempt: 1, loadReason: 'complete', loadProtocol: 'unknown' }));
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { 'x-pkw-ground-stream': BUILD.gitSha } }));
    controller.enqueue(new Uint8Array([3])); controller.close();
    expect([...await result]).toEqual([1, 2, 3]);
    // The worker may still be verifying its bounded clone for offline use.
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(false);
  });

  it('resumes one identity representation at its exact retained offset', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(interrupted()).mockResolvedValueOnce(
      done([3, 4], { etag: '"one"', 'content-range': 'bytes 2-3/4', 'content-length': '2' }, 206));
    vi.stubGlobal('fetch', fetcher);
    expect([...await finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))]).toEqual([1, 2, 3, 4]);
    expect(fetcher.mock.calls[1]![1].headers).toMatchObject({ Range: 'bytes=2-', 'If-Range': '"one"' });
  });

  it('discards a prefix when If-Range produces a complete200 replacement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(interrupted()).mockResolvedValueOnce(done([8, 9])));
    expect([...await finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))]).toEqual([8, 9]);
  });

  it.each([
    { etag: 'W/"weak"' }, { etag: '"one"', 'content-encoding': 'gzip' }, {},
  ])('uses a full retry when the representation cannot safely resume: %j', async headers => {
    const fetcher = vi.fn().mockResolvedValueOnce(interrupted(headers)).mockResolvedValueOnce(done([3, 4]));
    vi.stubGlobal('fetch', fetcher);
    expect([...await finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))]).toEqual([3, 4]);
    expect(fetcher.mock.calls[1]![1].headers.Range).toBeUndefined();
  });

  it.each([
    { etag: '"one"', 'content-range': 'bytes 1-2/4' },
    { etag: '"changed"', 'content-range': 'bytes 2-3/4' },
    { etag: '"one"', 'content-range': 'bytes 2-3/5' },
    { etag: '"one"', 'content-range': 'bytes 2-3/4', 'content-length': '3' },
    { etag: '"one"', 'content-range': 'bytes 2-3/4', 'content-type': 'multipart/byteranges' },
  ])('rejects inconsistent partial bodies and resets safely within the same three attempts: %j', async headers => {
    const fetcher = vi.fn().mockResolvedValueOnce(interrupted()).mockResolvedValueOnce(done([3, 4], headers, 206))
      .mockResolvedValueOnce(done([8, 9]));
    vi.stubGlobal('fetch', fetcher);
    expect([...await finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))]).toEqual([8, 9]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[2]![1].headers.Range).toBeUndefined();
  });

  it('restarts from zero after416 instead of treating an unverified prefix as complete', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(interrupted()).mockResolvedValueOnce(new Response(null, { status: 416 }))
      .mockResolvedValueOnce(done([5, 6]));
    vi.stubGlobal('fetch', fetcher);
    expect([...await finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))]).toEqual([5, 6]);
    expect(fetcher.mock.calls[2]![1].headers.Range).toBeUndefined();
  });

  it('rejects body bytes when the origin explicitly declared an empty representation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => done([1], { 'content-length': '0' })));
    await expect(finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))).rejects.toMatchObject({ reason: 'size' });
  });

  it('caps all automatic attempts, including repeated truncated bodies', async () => {
    const fetcher = vi.fn(async () => done([1], { 'content-length': '4' }));
    vi.stubGlobal('fetch', fetcher);
    await expect(finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))).rejects.toMatchObject({ reason: 'network' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('bounds header sizes and unknown-length bodies without allocating from the header', async () => {
    const fetcher = vi.fn(async () => done([1], { 'content-length': String(MAX_GROUND_DOWNLOAD_BYTES + 1) }));
    vi.stubGlobal('fetch', fetcher);
    await expect(finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))).rejects.toMatchObject({ reason: 'size' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(async () => new Response(new Uint8Array(MAX_GROUND_DOWNLOAD_BYTES + 1)));
    await expect(finishTransfer(downloadGround(url, new AbortController().signal, vi.fn()))).rejects.toMatchObject({ reason: 'size' });
  });

  it('keeps the base ceiling unchanged when a trusted globe caller uses its separate ceiling', async () => {
    const bytes = new Uint8Array(8_458_322);
    const fetcher = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', fetcher);
    await expect(downloadGround(url, new AbortController().signal, vi.fn())).rejects.toMatchObject({ reason: 'size' });
    expect((await downloadGround(url, new AbortController().signal, vi.fn(), { maxBytes: 12 * 1024 * 1024, cache: 'reload' })).length).toBe(bytes.length);
    expect(fetcher.mock.calls[1]).toEqual([url, expect.objectContaining({ cache: 'reload' })]);
  });

  it('does not count empty chunks as byte activity and cancels stalled readers on the third attempt', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(), controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { controllers.push(c); }, cancel })));
    vi.stubGlobal('fetch', fetcher);
    const result = downloadGround(url, new AbortController().signal, vi.fn());
    const rejected = expect(result).rejects.toMatchObject({ reason: 'idle-timeout' });
    await vi.advanceTimersByTimeAsync(19_000); controllers[0]!.enqueue(new Uint8Array());
    await vi.advanceTimersByTimeAsync(44_000); await rejected;
    expect(fetcher).toHaveBeenCalledTimes(3); expect(cancel).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('extends the idle deadline only on actual bytes while the shared episode remains external', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c; } }))));
    const result = downloadGround(url, new AbortController().signal, vi.fn());
    await vi.advanceTimersByTimeAsync(19_000); controller.enqueue(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(19_000); controller.enqueue(new Uint8Array([2])); controller.close();
    expect([...await result]).toEqual([1, 2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('abandonment cancels the reader and prevents retry or late completion', async () => {
    const cancel = vi.fn(), abort = new AbortController();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    vi.stubGlobal('fetch', fetcher);
    const result = downloadGround(url, abort.signal, vi.fn());
    await Promise.resolve(); abort.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalled();
  });

  it('waits for bounded visible backoff and cancels it when the last lease leaves', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController(), result = downloadGround(url, controller.signal, vi.fn());
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['http/1.1', 'h2', 'h3', '', 'private-protocol'])('reports only the current request protocol category: %s', async protocol => {
    vi.stubGlobal('fetch', vi.fn(async () => done([1])));
    const report = vi.fn();
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue([
      { startTime: -1, nextHopProtocol: 'h3' }, { startTime: 0, nextHopProtocol: protocol },
    ] as unknown as PerformanceEntry[]);
    await downloadGround(url, new AbortController().signal, report);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ loadProtocol:
      protocol === 'http/1.1' ? 'h1' : protocol === 'h2' || protocol === 'h3' ? protocol : 'unknown' }));
  });

  it('does not replenish the visible budget after a wall-clock correction', () => {
    const expired = vi.fn(), timer = new VisibleTimeout(20_000, expired);
    vi.advanceTimersByTime(15_000); vi.setSystemTime(Date.now() - 600_000);
    vi.advanceTimersByTime(5_000); expect(expired).toHaveBeenCalledTimes(1); timer.stop();
  });

  it('preserves consumed visible time through repeated background suspension', () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { hidden: false }); vi.stubGlobal('document', page);
    const expired = vi.fn(), timer = new VisibleTimeout(120_000, expired);
    vi.advanceTimersByTime(90_000); page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(600_000); expect(expired).not.toHaveBeenCalled();
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(29_999); expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(expired).toHaveBeenCalledTimes(1);
    timer.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
