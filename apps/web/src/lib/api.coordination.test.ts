import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Browser-lock semantics, with the real browser adapter, coordinator and API:
// readers overlap; an exclusive writer waits for every held response lock.
function browserLocks() {
  type Job = { shared: boolean; start(): void; cancel(): void };
  const queue: Job[] = [];
  let readers = 0; let writer = false;
  const pump = (): void => {
    while (queue.length && !writer) {
      const job = queue[0]!;
      if (!job.shared && readers) return;
      queue.shift(); job.start();
    }
  };
  return { request: <T,>(_name: string, options: { mode?: string; signal?: AbortSignal }, run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const job: Job = {
        shared: options.mode === 'shared',
        start: () => {
          options.signal?.removeEventListener('abort', job.cancel);
          if (job.shared) readers++; else writer = true;
          Promise.resolve().then(run).then(resolve, reject).finally(() => {
            if (job.shared) readers--; else writer = false;
            pump();
          });
        },
        cancel: () => {
          const index = queue.indexOf(job);
          if (index < 0) return;
          queue.splice(index, 1); reject(options.signal?.reason); pump();
        },
      };
      queue.push(job);
      options.signal?.addEventListener('abort', job.cancel, { once: true });
      if (options.signal?.aborted) job.cancel(); else pump();
    }) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
let locks: ReturnType<typeof browserLocks>;
beforeEach(() => { vi.resetModules(); locks = browserLocks(); vi.stubGlobal('navigator', { locks }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('session discovery with a stalled cookie-status response', () => {
  it('does not abort an in-flight cookie-status response or release its issuance fence on caller cancellation', async () => {
    const response = deferred<Response>();
    const fetch = vi.fn((_url: string, _options?: RequestInit) => response.promise); vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api');
    const controller = new AbortController(); let settled = false;
    const status = api.get('/auth/login/status', { signal: controller.signal }).finally(() => { settled = true; });
    await flush(); controller.abort(); await flush();
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeUndefined(); expect(settled).toBe(false);
    response.resolve(new Response('{"loginRequired":false}')); await status;
  });
  it('allows /me and an ordinary authenticated request while status retains its response lock', async () => {
    const status = deferred<Response>();
    const fetch = vi.fn((url: string, _options?: RequestInit) => url.endsWith('/auth/login/status') ? status.promise : Promise.resolve(new Response('{"wallet":"stable"}')));
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api');
    const pending = api.get('/auth/login/status'); await flush();
    await expect(api.get('/me')).resolves.toEqual({ wallet: 'stable' });
    await expect(api.postRaw('/tester/feedback', { requestId: 'same-report' })).resolves.toEqual({ wallet: 'stable' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, options]) => (options as RequestInit).credentials === 'include')).toBe(true);
    status.resolve(new Response('{"loginRequired":false}')); await pending;
  });

  it.each(['login', 'logout'] as const)('keeps %s excluded until status response delivery finishes', async (kind) => {
    const status = deferred<Response>();
    const fetch = vi.fn((url: string) => url.endsWith('/auth/login/status') ? status.promise
      : Promise.resolve(new Response('{"wallet":"new-wallet","entryPaid":true}')));
    vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api');
    const pending = api.get('/auth/login/status').catch((error: unknown) => error); await flush();
    const mutation = kind === 'login' ? api.postAuth('/auth/verify', {}, () => true) : api.logout();
    await flush(); expect(fetch).toHaveBeenCalledTimes(1);
    status.resolve(new Response('{"loginRequired":false}'));
    await pending; await mutation;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toContain(kind === 'login' ? '/auth/verify' : '/auth/logout');
  });

  it('cancels a queued bootstrap immediately and never dispatches it after an exclusive writer finishes', async () => {
    const held = deferred<void>();
    const foreignWriter = locks.request('pkw:auth-cookies:v1', {}, () => held.promise);
    const fetch = vi.fn(async () => new Response('{"wallet":"current"}')); vi.stubGlobal('fetch', fetch);
    const { api } = await import('./api');
    const controller = new AbortController();
    const cancelled = api.get('/me', { signal: controller.signal }).catch((error: unknown) => error);
    await flush(); controller.abort();
    expect(await cancelled).toBe(controller.signal.reason);
    const retry = api.get('/me'); await flush(); expect(fetch).not.toHaveBeenCalled();
    held.resolve(); await foreignWriter;
    await expect(retry).resolves.toEqual({ wallet: 'current' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('lets an explicit retry finish while a cancelled read is still delivering, without applying its late 401', async () => {
    const old = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(new Response('{"wallet":"current"}'));
    vi.stubGlobal('fetch', fetch);
    const { api, setUnauthorizedHandler } = await import('./api');
    const unauthorized = vi.fn(); setUnauthorizedHandler(unauthorized);
    const controller = new AbortController();
    const cancelled = api.get('/me', { signal: controller.signal }).catch((error: unknown) => error);
    await flush(); expect(fetch).toHaveBeenCalledTimes(1); controller.abort();
    expect(await cancelled).toBe(controller.signal.reason);
    await expect(api.get('/me')).resolves.toEqual({ wallet: 'current' });
    old.resolve(new Response('{"error":{"message":"old session"}}', { status: 401 })); await flush();
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('fences a delayed read error before global handlers when logout has claimed the next identity', async () => {
    const old = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/me') ? old.promise : Promise.resolve(new Response('{}'))));
    const { api, setUnauthorizedHandler } = await import('./api');
    const unauthorized = vi.fn(); setUnauthorizedHandler(unauthorized);
    const read = api.get('/me').catch((error: unknown) => error); await flush();
    const logout = api.logout(); await flush();
    old.resolve(new Response('{"error":{"message":"old session"}}', { status: 401 }));
    expect(await read).toMatchObject({ message: 'Sign-in changed. Please try again.' }); await logout;
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
