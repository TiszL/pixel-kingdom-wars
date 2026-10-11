/** @vitest-environment happy-dom */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startVisibleRetry } from './GlobeLayer';

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('visible globe retry loop', () => {
  it('does not overlap polling, retains cadence after failure, and pauses hidden', async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const load = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }))
      .mockResolvedValue('sector');
    const accept = vi.fn();
    const stop = startVisibleRetry(load, accept, 1_000, true);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => { reject(new Error('temporary')); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenCalledWith('sector');

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(load).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(load).toHaveBeenCalledTimes(3);
    stop();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('retries a failed one-shot chunk then stops permanently after success', async () => {
    vi.useFakeTimers();
    const load = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('chunk fetch failed'))
      .mockResolvedValue('module');
    const accept = vi.fn();
    const stop = startVisibleRetry(load, accept, 1_000, false);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(accept).toHaveBeenCalledWith('module');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it('reports failure, fences stale cleanup, and never lets slow generations overlap', async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: string) => void;
    const oldLoad = vi.fn(() => new Promise<string>((resolve) => { resolveOld = resolve; }));
    const oldAccept = vi.fn();
    const oldReject = vi.fn();
    const stopOld = startVisibleRetry(oldLoad, oldAccept, 1_000, true, oldReject);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(oldLoad).toHaveBeenCalledTimes(1);

    // A manual retry/scope change retires this generation. Its slow response must
    // never overwrite newer globe truth after cleanup.
    stopOld();
    await act(async () => { resolveOld('stale planet'); await Promise.resolve(); });
    expect(oldAccept).not.toHaveBeenCalled();
    expect(oldReject).not.toHaveBeenCalled();

    const failure = new Error('temporary globe failure');
    const newLoad = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue('fresh planet');
    const newAccept = vi.fn();
    const newReject = vi.fn();
    const stopNew = startVisibleRetry(newLoad, newAccept, 1_000, true, newReject);
    await act(async () => { await Promise.resolve(); });
    expect(newReject).toHaveBeenCalledWith(failure);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(newLoad).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => { await Promise.resolve(); });
    expect(newLoad).toHaveBeenCalledTimes(2);
    expect(newAccept).toHaveBeenCalledWith('fresh planet');
    stopNew();
  });
});
