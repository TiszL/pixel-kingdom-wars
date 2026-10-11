import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@shardkeep/sim';
import { api, setUnauthorizedHandler, setBaseSelectionInvalidHandler } from './api';

// A real shared/exclusive coordinator boundary. Holding this serial lock while
// reading an SSE body would leave logout queued forever.
vi.mock('../auth/authCookieCoordinator', async () => {
  const { AuthCookieCoordinator } = await import('../auth/authCookieCoordinatorCore');
  let revision = '';
  let dirty = false;
  let tail: Promise<unknown> = Promise.resolve();
  const lock = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  return { authCookies: new AuthCookieCoordinator({
    revision: () => revision, dirty: () => dirty,
    set: (next, value) => { revision = next; dirty = value; },
  }, lock) };
});

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => undefined);
  setBaseSelectionInvalidHandler(() => undefined);
});
const controller = (): AbortController => new AbortController();

describe('authenticated SSE handshake', () => {
  it('releases the cookie lock at headers and allows logout while the body remains open', async () => {
    const body = new ReadableStream<Uint8Array>();
    const fetch = vi.fn(async (url: string) => url.endsWith('/auth/logout')
      ? new Response('{}') : new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    vi.stubGlobal('fetch', fetch);
    const signal = controller().signal;
    const stream = await api.openStream('/bases/base-a/raid-events', { signal });
    expect(stream.body).toBe(body);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/bases/base-a/raid-events'), expect.objectContaining({
      credentials: 'include', cache: 'no-store', signal,
      headers: { accept: 'text/event-stream', 'x-sim-version': String(SIM_VERSION) },
    }));
    await api.logout();
    expect(fetch).toHaveBeenCalledTimes(2);
    await stream.body!.cancel();
  });

  it('also releases the lock before a stalled error body and fences its delayed 401 after logout', async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (value) => { writer = value; } });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/auth/logout')
      ? new Response('{}') : new Response(body, { status: 401 })));
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const stream = api.openStream('/bases/base-a/raid-events', { signal: controller().signal }).catch((error: unknown) => error);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await api.logout();
    writer.enqueue(new TextEncoder().encode('{"error":{"message":"Expired"}}'));
    writer.close();
    expect(await stream).toMatchObject({ message: 'Sign-in changed. Please try again.' });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('preserves typed current ownership failures and their global handler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 'DEED_OWNERSHIP_CHANGED', message: 'Ownership changed',
    } }), { status: 409 })));
    const changed = vi.fn();
    setBaseSelectionInvalidHandler(changed, () => 'wallet/base/epoch');
    await expect(api.openStream('/bases/base-a/raid-events', { signal: controller().signal })).rejects.toMatchObject({
      status: 409, code: 'DEED_OWNERSHIP_CHANGED',
    });
    expect(changed).toHaveBeenCalledExactlyOnceWith('DEED_OWNERSHIP_CHANGED');
  });

  it('does not apply an obsolete stream refusal to a newer wallet/base', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Expired"}}', { status: 401 })));
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    await expect(api.openStream('/bases/base-a/raid-events', { signal: controller().signal, isCurrent: () => false })).rejects.toThrow('Sign-in changed');
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it('rejects an HTML proxy fallback instead of treating it as live authority', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>proxy fallback</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(api.openStream('/bases/base-a/raid-events', { signal: controller().signal })).rejects.toMatchObject({ code: 'RAID_EVENTS_INVALID' });
  });

  it('does not let an obsolete fallback poll apply global errors before React effect cleanup', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Expired"}}', { status: 401 })));
    await expect(api.get('/bases/base-a/active-raid', { isCurrent: () => false })).rejects.toThrow('Sign-in changed');
    expect(unauthorized).not.toHaveBeenCalled();
  });
});
