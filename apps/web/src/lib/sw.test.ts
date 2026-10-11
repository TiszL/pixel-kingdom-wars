/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./version', () => ({ BUILD: { gitSha: 'current-build' } }));
const previousWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
const register = vi.fn();

beforeEach(() => {
  vi.resetModules();
  register.mockReset().mockResolvedValue({});
  vi.stubEnv('DEV', false);
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (previousWorker) Object.defineProperty(navigator, 'serviceWorker', previousWorker);
  else Reflect.deleteProperty(navigator, 'serviceWorker');
});

function workerContainer(build: string | null = 'previous-build'): EventTarget & { controller: ServiceWorker | null; register: typeof register } {
  const worker = Object.assign(new EventTarget(), {
    controller: build === null ? null : { scriptURL: `${location.origin}/sw.js?v=${build}` } as ServiceWorker,
    register,
  });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
  return worker;
}

describe('canvas boot during a service-worker update', () => {
  it.each(['current-build', null])('keeps %s control available without waiting for an optional full pack', async (build) => {
    const worker = workerContainer(build);
    const listen = vi.spyOn(worker, 'addEventListener');
    const { gameWorkerBootBlocked, waitForGameWorker } = await import('./sw');
    const publish = vi.fn();
    expect(gameWorkerBootBlocked()).toBe(false);
    const dispose = waitForGameWorker(publish);
    expect(publish).toHaveBeenCalledExactlyOnceWith('ready');
    expect(listen).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    dispose();
  });

  it('keeps development and unsupported browsers available', async () => {
    workerContainer();
    const { gameWorkerBootBlocked, waitForGameWorker } = await import('./sw');
    vi.stubEnv('DEV', true);
    expect(gameWorkerBootBlocked()).toBe(false);
    const publish = vi.fn();
    waitForGameWorker(publish)();
    vi.stubEnv('DEV', false);
    Reflect.deleteProperty(navigator, 'serviceWorker');
    expect(gameWorkerBootBlocked()).toBe(false);
    waitForGameWorker(publish)();
    expect(publish.mock.calls).toEqual([['ready'], ['ready']]);
    expect(register).not.toHaveBeenCalled();
  });

  it('keeps the shell available when a sandbox denies the service-worker getter', async () => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: () => {
      throw new DOMException('Access denied', 'SecurityError');
    } });
    const { gameWorkerBootBlocked, waitForGameWorker, registerServiceWorker } = await import('./sw');
    expect(gameWorkerBootBlocked()).toBe(false);
    const publish = vi.fn();
    waitForGameWorker(publish)();
    expect(publish).toHaveBeenCalledExactlyOnceWith('ready');
    await expect(registerServiceWorker()).resolves.toBe(false);
  });

  it('blocks synchronously under an old worker and releases only on exact-build takeover', async () => {
    vi.useFakeTimers();
    const worker = workerContainer();
    const remove = vi.spyOn(worker, 'removeEventListener');
    const { gameWorkerBootBlocked, waitForGameWorker } = await import('./sw');
    expect(gameWorkerBootBlocked()).toBe(true);
    const publish = vi.fn();
    waitForGameWorker(publish);
    expect(publish.mock.calls).toEqual([['waiting']]);
    worker.controller = { scriptURL: `${location.origin}/sw.js?v=another-build` } as ServiceWorker;
    worker.dispatchEvent(new Event('controllerchange'));
    expect(publish.mock.calls).toEqual([['waiting']]);
    worker.controller = { scriptURL: `${location.origin}/sw.js?v=current-build` } as ServiceWorker;
    worker.dispatchEvent(new Event('controllerchange'));
    expect(publish.mock.calls).toEqual([['waiting'], ['ready']]);
    expect(remove).toHaveBeenCalledExactlyOnceWith('controllerchange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    // A subsequent deploy must never tear down a running canvas/raid.
    worker.controller = { scriptURL: `${location.origin}/sw.js?v=next-build` } as ServiceWorker;
    worker.dispatchEvent(new Event('controllerchange'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('exposes a bounded retry after ten seconds but recovers automatically on late takeover', async () => {
    vi.useFakeTimers();
    const worker = workerContainer();
    const { waitForGameWorker } = await import('./sw');
    const publish = vi.fn();
    waitForGameWorker(publish);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(publish.mock.calls).toEqual([['waiting']]);
    await vi.advanceTimersByTimeAsync(1);
    expect(publish.mock.calls).toEqual([['waiting'], ['error']]);
    expect(vi.getTimerCount()).toBe(0);
    worker.controller = { scriptURL: `${location.origin}/sw.js?v=current-build` } as ServiceWorker;
    worker.dispatchEvent(new Event('controllerchange'));
    expect(publish.mock.calls).toEqual([['waiting'], ['error'], ['ready']]);
  });

  it('makes registration failure recoverable without weakening the controller check', async () => {
    vi.useFakeTimers();
    const worker = workerContainer();
    register.mockRejectedValueOnce(new Error('offline'));
    const { waitForGameWorker } = await import('./sw');
    const publish = vi.fn();
    waitForGameWorker(publish);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish.mock.calls).toEqual([['waiting'], ['error']]);
    expect(vi.getTimerCount()).toBe(0);
    worker.controller = { scriptURL: `${location.origin}/sw.js?v=current-build` } as ServiceWorker;
    worker.dispatchEvent(new Event('controllerchange'));
    expect(publish).toHaveBeenLastCalledWith('ready');
  });

  it('re-registers on explicit retry even if registration resolved before installation failed', async () => {
    vi.useFakeTimers();
    workerContainer();
    const { registerServiceWorker, waitForGameWorker } = await import('./sw');
    await registerServiceWorker();
    const publish = vi.fn();
    const dispose = waitForGameWorker(publish);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(register).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith('error');
    dispose();
    const stopRetry = waitForGameWorker(publish, true);
    expect(register).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith('waiting');
    stopRetry();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows pinned direct network fetches if the old controller is removed', async () => {
    const worker = workerContainer();
    const { waitForGameWorker } = await import('./sw');
    const publish = vi.fn();
    waitForGameWorker(publish);
    worker.controller = null;
    worker.dispatchEvent(new Event('controllerchange'));
    expect(publish.mock.calls).toEqual([['waiting'], ['ready']]);
  });

  it('cleans up an abandoned wait and ignores its late registration rejection', async () => {
    vi.useFakeTimers();
    const worker = workerContainer();
    const remove = vi.spyOn(worker, 'removeEventListener');
    let rejectRegistration!: (cause: Error) => void;
    register.mockReturnValueOnce(new Promise((_, reject) => { rejectRegistration = reject; }));
    const { waitForGameWorker } = await import('./sw');
    const publish = vi.fn();
    const dispose = waitForGameWorker(publish);
    dispose();
    rejectRegistration(new Error('late failure'));
    worker.controller = null;
    worker.dispatchEvent(new Event('controllerchange'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(publish.mock.calls).toEqual([['waiting']]);
    expect(remove).toHaveBeenCalledExactlyOnceWith('controllerchange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a synchronous registration exception without breaking the app shell', async () => {
    workerContainer();
    register.mockImplementationOnce(() => { throw new Error('registration unavailable'); });
    const { waitForGameWorker } = await import('./sw');
    const publish = vi.fn();
    const dispose = waitForGameWorker(publish);
    await Promise.resolve();
    expect(publish.mock.calls).toEqual([['waiting'], ['error']]);
    dispose();
  });
});

describe('production service-worker registration', () => {
  it('starts before window.load and coalesces pending and successful callers', async () => {
    const { registerServiceWorker } = await import('./sw');
    const listener = vi.spyOn(window, 'addEventListener');
    registerServiceWorker();
    registerServiceWorker();
    expect(register).toHaveBeenCalledExactlyOnceWith('/sw.js?v=current-build', { scope: '/' });
    expect(listener).not.toHaveBeenCalledWith('load', expect.any(Function));
    await Promise.resolve();
    registerServiceWorker();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('also registers when the caller arrives after window.load', async () => {
    window.dispatchEvent(new Event('load'));
    const { registerServiceWorker } = await import('./sw');
    registerServiceWorker();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('lets image/connectivity recovery retry a rejected registration', async () => {
    register.mockRejectedValueOnce(new Error('offline'));
    const { registerServiceWorker } = await import('./sw');
    registerServiceWorker();
    await Promise.resolve();
    await Promise.resolve();
    registerServiceWorker();
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('never registers against a development server', async () => {
    vi.stubEnv('DEV', true);
    const { registerServiceWorker } = await import('./sw');
    registerServiceWorker();
    expect(register).not.toHaveBeenCalled();
  });

  it('keeps login available in a browser without service-worker support', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    const { registerServiceWorker } = await import('./sw');
    expect(registerServiceWorker).not.toThrow();
    expect(register).not.toHaveBeenCalled();
  });
});
