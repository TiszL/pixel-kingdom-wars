import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import type { UnpaidCommand } from './transport';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const wallet = '11111111111111111111111111111111', at = '2026-09-22T12:00:00.000Z';
const request = { idempotencyKey: id(1), baseId: id(2), berthId: id(3) };
const command = { kind: 'installation', request } as const;
const proof = { wallet, idempotencyKey: id(1), serverNow: at, status: 'accepted', receipt: { wallet, request,
  installation: { installationId: id(4), baseId: id(2), berthId: id(3), family: 'starter',
    completedBuildJobId: id(5), berthCompletedAt: at, installedAt: at }, acceptedAt: at } };
const typedError = { error: { code: 'PHASE_E_DISABLED', message: 'Paused' } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
// Real coordinator/browser adapter, with shared readers and exclusive writers.
function browserLocks() {
  type Job = { shared: boolean; start(): void; cancel(): void };
  const queue: Job[] = []; let readers = 0, writer = false;
  const pump = (): void => {
    while (queue.length && !writer) {
      const job = queue[0]!; if (!job.shared && readers) return;
      queue.shift(); job.start();
    }
  };
  return { request: <T,>(_name: string, options: { mode?: string; signal?: AbortSignal }, run: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const job: Job = { shared: options.mode === 'shared', start: () => {
        options.signal?.removeEventListener('abort', job.cancel);
        if (job.shared) readers++; else writer = true;
        Promise.resolve().then(run).then(resolve, reject).finally(() => {
          if (job.shared) readers--; else writer = false; pump();
        });
      }, cancel: () => {
        const at = queue.indexOf(job); if (at < 0) return;
        queue.splice(at, 1); reject(options.signal?.reason); pump();
      } };
      queue.push(job); options.signal?.addEventListener('abort', job.cancel, { once: true });
      if (options.signal?.aborted) job.cancel(); else pump();
    }) };
}
let locks: ReturnType<typeof browserLocks>;
beforeEach(() => { vi.resetModules(); locks = browserLocks(); vi.stubGlobal('navigator', { locks }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function setup() {
  const transport = await import('./transport');
  const callbacks = { retainAccepted: vi.fn(async () => undefined), retainRefusal: vi.fn(async () => undefined) };
  const options = { wallet, command, method: 'POST' as const, firstAttempt: true, isCurrent: () => true, ...callbacks };
  return { ...transport, options, ...callbacks };
}
function streamed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  return { response, write: (text: string) => controller.enqueue(new TextEncoder().encode(text)), close: () => controller.close() };
}

describe('unpaid original response ownership', () => {
  it('sends the exact original command once, without currency or recent-auth headers and without redirects', async () => {
    const fetch = vi.fn(async () => json(proof)); vi.stubGlobal('fetch', fetch);
    const { unpaidOriginal, options, retainAccepted, retainRefusal } = await setup();
    await expect(unpaidOriginal(options)).resolves.toEqual(proof);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url.endsWith('/starter-fleet/installations')).toBe(true);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'include', cache: 'no-store', body: JSON.stringify(request) });
    expect(Object.keys(init.headers!)).toEqual(['x-sim-version', 'content-type']);
    expect(retainAccepted).toHaveBeenCalledWith(proof); expect(retainRefusal).not.toHaveBeenCalled();
  });

  it.each([
    ['ordinary', { idempotencyKey: id(1), baseId: id(2), recipeId: 'old_recipe', recipeVersion: 1, quantity: 1 }, '/ordinary-crafting/jobs'],
    ['installation', request, '/starter-fleet/installations'],
    ['expedition', { idempotencyKey: id(1), baseId: id(2), installationId: id(3), routeId: 'common', routeVersion: 1, rewardVersion: 1 }, '/starter-expeditions'],
    ['harvester', { idempotencyKey: id(1), baseId: id(2), harvesterId: id(3), expectedSourceId: null, policyVersion: 1 }, '/harvesters/sources'],
  ])('derives only the %s original GET route and never records unknown as evidence', async (kind, request, path) => {
    const fetch = vi.fn(async (_url: string) => json({ wallet, idempotencyKey: id(1), serverNow: at, status: 'unknown',
      ...(kind === 'harvester' ? { originalReceipt: null, settlement: null } : { receipt: null }),
      ...(kind === 'ordinary' ? { completion: null } : kind === 'expedition' ? { return: null } : {}) }));
    vi.stubGlobal('fetch', fetch);
    const { unpaidOriginal, options, retainAccepted, retainRefusal } = await setup();
    await unpaidOriginal({ ...options, method: 'GET', firstAttempt: false, command: { kind, request } as UnpaidCommand });
    expect(fetch.mock.calls[0]?.[0]).toMatch(`${path}/by-key/${id(1)}`);
    expect(retainAccepted).not.toHaveBeenCalled(); expect(retainRefusal).not.toHaveBeenCalled();
  });

  it.each(['currency', 'recentAuthGrant', 'path', 'headers'])('rejects injected %s options before enqueue', async extra => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { unpaidOriginal, options } = await setup();
    await expect(unpaidOriginal({ ...options, [extra]: '/auth/verify?x=1' })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ ...request, currency: 'sol' }, { ...request, baseId: `${id(2)}?x=1` },
    { ...request, idempotencyKey: 'ABCDEF00-0000-4000-8000-000000000001' }])('rejects noncanonical/extra original fields', async request => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const { unpaidOriginal, options } = await setup();
    await expect(unpaidOriginal({ ...options, command: { kind: 'installation', request } })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'obsolete'] as const)('checks %s again at actual enqueue after a foreign auth lock', async reason => {
    const held = deferred<void>(), foreign = locks.request('pkw:auth-cookies:v1', {}, () => held.promise);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const { unpaidOriginal, options } = await setup();
    const abort = new AbortController(); let current = true;
    const pending = unpaidOriginal({ ...options, signal: abort.signal, isCurrent: () => current }).catch(error => error);
    await flush(); if (reason === 'cancel') abort.abort(); else current = false;
    held.resolve(); await foreign; expect(await pending).toBeInstanceOf(Error); expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels before headers without manufacturing evidence or retrying', async () => {
    const headers = deferred<Response>();
    const fetch = vi.fn((_url: string, _init: RequestInit) => headers.promise); vi.stubGlobal('fetch', fetch);
    const { unpaidOriginal, options, retainAccepted } = await setup(); const abort = new AbortController();
    const pending = unpaidOriginal({ ...options, signal: abort.signal }).catch(error => error);
    await flush(); abort.abort(); expect(await pending).toBe(abort.signal.reason);
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(true);
    headers.resolve(json(proof)); await flush(); expect(retainAccepted).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retains accepted GET recovery without a POST or current inventory callback', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => json(proof)); vi.stubGlobal('fetch', fetch);
    const { unpaidOriginal, options, retainAccepted } = await setup();
    await unpaidOriginal({ ...options, method: 'GET', firstAttempt: false });
    expect(retainAccepted).toHaveBeenCalledWith(proof); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'GET', body: null });
  });

  it('drains after headers despite cancellation, and holds its promise and cookie lock through durable persistence', async () => {
    const stream = streamed(), saved = deferred<void>();
    const fetch = vi.fn((_url: string, _init: RequestInit) => Promise.resolve(stream.response)); vi.stubGlobal('fetch', fetch);
    const { unpaidOriginal, options } = await setup(); const abort = new AbortController();
    const retainAccepted = vi.fn(() => saved.promise); let settled = false, writerStarted = false;
    const pending = unpaidOriginal({ ...options, signal: abort.signal, retainAccepted }).catch(error => error).finally(() => { settled = true; });
    await flush(); stream.write(JSON.stringify(proof).slice(0, 40)); abort.abort();
    const writer = locks.request('pkw:auth-cookies:v1', {}, async () => { writerStarted = true; });
    await flush(); expect(settled).toBe(false); expect(writerStarted).toBe(false);
    expect(fetch.mock.calls[0]![1].signal!.aborted).toBe(false);
    stream.write(JSON.stringify(proof).slice(40)); stream.close(); await flush();
    expect(retainAccepted).toHaveBeenCalledWith(proof); expect(settled).toBe(false); expect(writerStarted).toBe(false);
    saved.resolve(); expect(await pending).toBe(abort.signal.reason); await writer; expect(writerStarted).toBe(true);
  });

  it.each([true, false])('retains only a strict first refusal before retiring the view (first=%s)', async firstAttempt => {
    const stream = streamed(); vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.response.body, { status: 503 })));
    const { unpaidOriginal, options, retainRefusal } = await setup(); let current = true;
    const pending = unpaidOriginal({ ...options, firstAttempt, isCurrent: () => current }).catch(error => error);
    await flush(); current = false; stream.write(JSON.stringify(typedError)); stream.close();
    expect(await pending).toMatchObject({ message: 'Sign-in changed. Please try again.' });
    expect(retainRefusal).toHaveBeenCalledTimes(firstAttempt ? 1 : 0);
  });

  it('never navigates a retired session from a late strict 401', async () => {
    const stream = streamed(); vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.response.body, { status: 401 })));
    const { unpaidOriginal, options, retainRefusal } = await setup();
    const { setUnauthorizedHandler } = await import('../api'); const unauthorized = vi.fn(); setUnauthorizedHandler(unauthorized);
    let current = true; const pending = unpaidOriginal({ ...options, isCurrent: () => current }).catch(error => error);
    await flush(); current = false; stream.write(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Old session' } })); stream.close();
    expect(await pending).toMatchObject({ message: 'Sign-in changed. Please try again.' });
    expect(unauthorized).not.toHaveBeenCalled(); expect(retainRefusal).not.toHaveBeenCalled();
  });

  it('preserves acceptance before auth replacement and excludes login until the original write finishes', async () => {
    const stream = streamed(), saved = deferred<void>();
    const fetch = vi.fn((url: string) => Promise.resolve(url.endsWith('/auth/verify') ? json({ wallet: `${wallet}1`, entryPaid: true }) : stream.response));
    vi.stubGlobal('fetch', fetch); const { unpaidOriginal, options } = await setup();
    const { api } = await import('../api'); const retainAccepted = vi.fn(() => saved.promise);
    const pending = unpaidOriginal({ ...options, retainAccepted }).catch(error => error); await flush();
    const login = api.postAuth('/auth/verify', {}, () => true); await flush(); expect(fetch).toHaveBeenCalledTimes(1);
    stream.write(JSON.stringify(proof)); stream.close(); await flush(); expect(retainAccepted).toHaveBeenCalledWith(proof);
    expect(fetch).toHaveBeenCalledTimes(1); saved.resolve();
    expect(await pending).toMatchObject({ message: 'Sign-in changed. Please try again.' }); await login;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['body', 'headers'] as const)('ends a stalled %s at the independent deadline with no evidence', async stall => {
    vi.useFakeTimers(); const stream = streamed();
    const fetch = vi.fn(() => stall === 'body' ? Promise.resolve(stream.response) : new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetch); const { unpaidOriginal, options, retainAccepted } = await setup();
    const pending = unpaidOriginal(options).catch(error => error); await flush();
    if (stall === 'body') stream.write('{"wallet":');
    await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    expect(await pending).toMatchObject({ code: 'ORIGINAL_RESPONSE_TIMEOUT' }); expect(retainAccepted).not.toHaveBeenCalled();
    let free = false; await locks.request('pkw:auth-cookies:v1', {}, async () => { free = true; }); expect(free).toBe(true);
  });

  it.each(['accepted', 'refusal'] as const)('surfaces %s durable callback failure before cancellation and no navigation', async outcome => {
    const stream = streamed(), save = deferred<void>(), failed = new Error('durable storage failed');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream.response.body, { status: outcome === 'accepted' ? 200 : 503 })));
    const { unpaidOriginal, options } = await setup(); const { setUnauthorizedHandler } = await import('../api');
    const unauthorized = vi.fn(); setUnauthorizedHandler(unauthorized); const abort = new AbortController();
    const retain = vi.fn(async () => { await save.promise; throw failed; });
    const pending = unpaidOriginal({ ...options, signal: abort.signal, retainAccepted: retain, retainRefusal: retain }).catch(error => error);
    await flush(); stream.write(JSON.stringify(outcome === 'accepted' ? proof : typedError)); stream.close(); await flush();
    abort.abort(); save.resolve(); expect(await pending).toBe(failed); expect(unauthorized).not.toHaveBeenCalled();
  });

  it.each([
    [503, { error: { code: 'PHASE_E_DISABLED' } }], [503, { error: { code: 'PHASE_E_DISABLED', message: 9 } }],
    [503, { ...typedError, extra: true }], [503, { error: { ...typedError.error, extra: true } }],
    [409, typedError], [503, { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Conflict' } }],
  ])('does not retain malformed, mismatched or ambiguous errors (%s)', async (status, value) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(value, status))); const { unpaidOriginal, options, retainAccepted, retainRefusal } = await setup();
    await expect(unpaidOriginal(options)).rejects.toThrow(); expect(retainAccepted).not.toHaveBeenCalled(); expect(retainRefusal).not.toHaveBeenCalled();
  });

  it.each(['partial', 'oversized', 'mismatch', 'redirect'] as const)('rejects %s without evidence or a second fetch', async bad => {
    const response = bad === 'partial' ? new Response('{"wallet":') : bad === 'oversized' ? new Response(' '.repeat(1_048_577))
      : bad === 'redirect' ? new Response('', { status: 307, headers: { location: '/auth/verify' } }) : json({ ...proof, wallet: `${wallet}1` });
    const fetch = vi.fn(async () => response); vi.stubGlobal('fetch', fetch);
    const { unpaidOriginal, options, retainAccepted, retainRefusal } = await setup();
    await expect(unpaidOriginal(options)).rejects.toThrow(); expect(retainAccepted).not.toHaveBeenCalled(); expect(retainRefusal).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(1);
  });
});
