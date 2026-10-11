import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { WORLD_V2_PACK_ROOT } from '../ui/fantasy/worldv2/packUrl';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://play.pixelkingdomwars.com';

function sha(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function url(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return new URL(String(input), ORIGIN).href;
}

class SwCache {
  entries = new Map<string, Response>();
  added: string[] = [];
  puts: string[] = [];
  deletes: string[] = [];
  putBarrier: Promise<void> | null = null;
  deleteBarrier: Promise<void> | null = null;
  putError: Error | null = null;
  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(url(input))?.clone();
  }
  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.puts.push(url(input));
    await this.putBarrier;
    if (this.putError) throw this.putError;
    this.entries.set(url(input), response.clone());
  }
  async delete(input: RequestInfo | URL): Promise<boolean> {
    this.deletes.push(url(input));
    await this.deleteBarrier;
    return this.entries.delete(url(input));
  }
  async keys(): Promise<Request[]> { return [...this.entries.keys()].map((entry) => new Request(entry)); }
  async add(input: RequestInfo | URL): Promise<void> { this.added.push(url(input)); }
}

function harness(build = 'new', registrationQuery = '', sharedStores?: Map<string, SwCache>) {
  const listeners = new Map<string, (event: any) => void>();
  const stores = sharedStores ?? new Map<string, SwCache>();
  const deleted: string[] = [];
  const windows: Array<{ url: string; focus: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }> = [];
  const caches = {
    open: vi.fn(async (name: string) => {
      let cache = stores.get(name);
      if (!cache) { cache = new SwCache(); stores.set(name, cache); }
      return cache;
    }),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => { deleted.push(name); return stores.delete(name); }),
    match: vi.fn(async (input: RequestInfo | URL) => {
      for (const cache of stores.values()) {
        const hit = await cache.match(input);
        if (hit) return hit;
      }
      return undefined;
    }),
  };
  const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => new Response('network'));
  const digest = vi.fn(webcrypto.subtle.digest.bind(webcrypto.subtle));
  const self = {
    location: { href: `${ORIGIN}/sw.js?v=${build}${registrationQuery}`, origin: ORIGIN },
    addEventListener: (kind: string, handler: (event: any) => void) => listeners.set(kind, handler),
    clients: {
      get: vi.fn(async (_id: string) => ({ visibilityState: 'visible' })),
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => undefined),
    },
    registration: {
      showNotification: vi.fn(async () => undefined),
      getNotifications: vi.fn(async () => [] as Array<{ close: () => void }>),
      pushManager: {
        subscribe: vi.fn(async () => ({
          endpoint: 'https://push.example/new',
          unsubscribe: vi.fn(async () => true),
          toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'P', auth: 'A' } }),
        })),
      },
    },
    navigator: { userAgent: 'test-agent' },
    skipWaiting: vi.fn(async () => undefined),
  };
  runInNewContext(source, {
    self, caches, fetch: fetchMock, URL, Request, Response, Headers, Uint8Array,
    AbortController, setTimeout, clearTimeout, performance, crypto: { subtle: { digest } },
    Map, Set, Promise, Number, String, RegExp, Array, encodeURIComponent, atob, console,
  });
  return { listeners, stores, deleted, caches, fetchMock, self, windows, digest };
}

async function dispatchFetch(
  listeners: Map<string, (event: any) => void>,
  request: Request,
  clientId = '',
): Promise<Response | undefined> {
  let response: Promise<Response> | undefined;
  const background: Promise<unknown>[] = [];
  let dispatching = true;
  listeners.get('fetch')!({
    request, clientId,
    respondWith: (value: Promise<Response>) => { response = Promise.resolve(value); },
    waitUntil: (value: Promise<unknown>) => {
      if (!dispatching) throw new Error('waitUntil called after the fetch event dispatch');
      background.push(Promise.resolve(value));
    },
  });
  dispatching = false;
  const [result] = await Promise.all([response, Promise.all(background)]);
  return result;
}

describe('bounded verified atlas transport', () => {
  const build = '17c8ec1be39ca00389f3d87170cdafde9064d17f';
  const body = '0123456789';
  async function fixture(previous = false) {
    const h = harness(previous ? 'f'.repeat(40) : build);
    const file = { path: '/atlas/warefallback@1x.png', bytes: body.length, sha256: sha(body), contentType: 'image/png', tier: 'core' };
    const pack = await h.caches.open('pkw-asset-pack-v1');
    await pack.put(previous ? '/_pkw-pack/deployment-previous.json' : '/_pkw-pack/deployment-current.json',
      new Response(JSON.stringify({ schema: 2, build, files: [file] })));
    const request = new Request(`${ORIGIN}${file.path}?v=${build}`);
    const key = `${ORIGIN}/_pkw-pack/content/${file.sha256}`;
    return { h, pack, request, key };
  }

  it('ends stalled atlas headers so the existing boot retry can recover', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const { h, pack, request, key } = await fixture();
      h.fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
      let result: Response | undefined;
      const pending = dispatchFetch(h.listeners, request, 'page').then(r => { result = r; });
      await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(21_000);
      expect(result?.status).toBe(503);
      await pending;
      expect((h.fetchMock.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
      expect(await pack.match(key)).toBeUndefined();
      h.fetchMock.mockResolvedValueOnce(new Response(body));
      const recovered = await dispatchFetch(h.listeners, request, 'page');
      expect(await recovered?.text()).toBe(body);
      expect(h.fetchMock).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])('cancels a stalled body and never caches a partial atlas (previous=%s)', async previous => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const { h, pack, request, key } = await fixture(previous);
      const cancel = vi.fn();
      h.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('012')); }, cancel,
      })));
      let result: Response | undefined;
      const pending = dispatchFetch(h.listeners, request, 'page').then(r => { result = r; });
      await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(21_000);
      expect(result?.status).toBe(503); await pending;
      expect(cancel).toHaveBeenCalledOnce(); expect(await pack.match(key)).toBeUndefined();
      expect((h.fetchMock.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('keeps healthy chunk progress beyond20 seconds and verifies before exposing any bytes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const { h, pack, request, key } = await fixture();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      h.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
      let settled = false;
      const pending = dispatchFetch(h.listeners, request, 'page').then(r => { settled = true; return r; });
      await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
      for (const chunk of ['012', '345', '678', '9']) {
        await vi.advanceTimersByTimeAsync(8_000);
        expect(settled).toBe(false); stream.enqueue(new TextEncoder().encode(chunk));
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(await pack.match(key)).toBeUndefined(); stream.close();
      expect(await (await pending)?.text()).toBe(body);
      expect(await pack.match(key).then(r => r?.text())).toBe(body);
      expect((h.fetchMock.mock.calls[0]![0] as Request).signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('pauses a hidden controlled page and resumes only the remaining idle allowance', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const { h, request } = await fixture();
      let hidden = false;
      h.self.clients.get.mockImplementation(async () => ({ visibilityState: hidden ? 'hidden' : 'visible' }));
      h.fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
      let result: Response | undefined;
      const pending = dispatchFetch(h.listeners, request, 'page').then(r => { result = r; });
      await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(8_000); hidden = true;
      await vi.advanceTimersByTimeAsync(60_000); expect(result).toBeUndefined();
      hidden = false;
      await vi.advanceTimersByTimeAsync(10_000); expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(4_000); expect(result?.status).toBe(503); await pending;
      expect(h.fetchMock).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('does not mistake an unsampled worker suspension for stalled bytes or reset its prior idle time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const { h, request } = await fixture();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      h.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
      let settled = false;
      const pending = dispatchFetch(h.listeners, request, 'page').then(r => { settled = true; return r; });
      await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(8_000);
      const now = performance.now.bind(performance);
      clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 60_000);
      // No timer callbacks or hidden-client snapshots occurred during this gap.
      await vi.advanceTimersByTimeAsync(1_000); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(9_000); expect(settled).toBe(false);
      stream.enqueue(new TextEncoder().encode(body)); stream.close();
      expect(await (await pending)?.text()).toBe(body);
      expect(vi.getTimerCount()).toBe(0);

      // A gap does not grant a fresh20s allowance: prior idle remains charged.
      const next = await fixture();
      next.h.fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
      let result: Response | undefined;
      const stalled = dispatchFetch(next.h.listeners, next.request, 'page').then(r => { result = r; });
      await vi.waitFor(() => expect(next.h.fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(8_000);
      clock.mockImplementation(() => now() + 120_000);
      await vi.advanceTimersByTimeAsync(14_000);
      expect(result?.status).toBe(503); await stalled; expect(vi.getTimerCount()).toBe(0);
    } finally { clock?.mockRestore(); vi.useRealTimers(); }
  });

  it.each(['headers', 'body', 'digest'] as const)('honors request cancellation during%s without storage or late recovery', async phase => {
    const { h, pack, request, key } = await fixture();
    const abort = new AbortController(), cancel = vi.fn();
    let finishDigest!: (value: ArrayBuffer) => void;
    if (phase === 'headers') h.fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    else if (phase === 'body') h.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    else {
      h.fetchMock.mockResolvedValueOnce(new Response(body));
      h.digest.mockImplementationOnce(() => new Promise<ArrayBuffer>(resolve => { finishDigest = resolve; }));
    }
    const pending = dispatchFetch(h.listeners, new Request(request, { signal: abort.signal }), 'page');
    await vi.waitFor(() => expect(phase === 'digest' ? h.digest : h.fetchMock).toHaveBeenCalledTimes(1));
    abort.abort();
    expect((await pending)?.status).toBe(503);
    if (phase === 'body') expect(cancel).toHaveBeenCalledOnce();
    if (phase === 'digest') finishDigest(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    await Promise.resolve();
    expect(await pack.match(key)).toBeUndefined();
    expect((h.fetchMock.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
  });

  it('stops an oversized never-ending body at its exact manifest cap', async () => {
    const { h, pack, request, key } = await fixture(), cancel = vi.fn();
    h.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(body + 'overflow')); }, cancel,
    })));
    expect((await dispatchFetch(h.listeners, request, 'page'))?.status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce(); expect(h.digest).not.toHaveBeenCalled();
    expect(await pack.match(key)).toBeUndefined();
  });

  it('bounds an unavailable visibility lookup instead of hiding a stalled transport forever', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const { h, request } = await fixture();
      h.self.clients.get.mockImplementation(() => new Promise(() => {}));
      h.fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
      let result: Response | undefined;
      const pending = dispatchFetch(h.listeners, request, 'page').then(r => { result = r; });
      await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(22_000);
      expect(result?.status).toBe(503); await pending; expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([false, true])('preserves verified range handling and integrity for generic atlases (previous=%s)', async previous => {
    const { h, pack, request, key } = await fixture(previous);
    h.fetchMock.mockResolvedValueOnce(new Response(body));
    const response = await dispatchFetch(h.listeners, new Request(request, { headers: { range: 'bytes=2-5' } }), 'page');
    expect(response?.status).toBe(206); expect(await response?.text()).toBe('2345');
    expect((h.fetchMock.mock.calls[0]![0] as Request).headers.has('range')).toBe(false);
    expect(await pack.match(key).then(r => r?.text())).toBe(body);
    h.fetchMock.mockRejectedValue(new Error('offline'));
    expect(await dispatchFetch(h.listeners, request, 'page').then(r => r?.text())).toBe(body);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

});

describe('service-worker installed-pack contract', () => {
  it.each(['open', 'pointer match'] as const)('recovers a transient cache %s failure on the next bounded artwork attempt', async (failure) => {
    const build = '15f856f3871735dcdf28461c1027d31f08c08aee';
    const h = harness(build);
    const path = '/atlas/bld@1x.png', body = 'verified current atlas';
    const file = { path, bytes: body.length, sha256: sha(body), contentType: 'image/png', tier: 'core' };
    const pack = await h.caches.open('pkw-asset-pack-v1');
    await pack.put('/_pkw-pack/deployment-current.json', new Response(JSON.stringify({
      schema: 2, build, files: [file],
    })));
    const transient = new Error('temporary cache read failure');
    if (failure === 'open') h.caches.open.mockRejectedValueOnce(transient);
    else vi.spyOn(pack, 'match').mockRejectedValueOnce(transient);
    h.fetchMock.mockResolvedValue(new Response(body));
    const request = () => new Request(`${ORIGIN}${path}?v=${build}`);

    // Boot retries missing art once. A transient storage failure must not leave
    // that ordinary retry attached to a permanently rejected inventory promise.
    await expect(dispatchFetch(h.listeners, request())).rejects.toBe(transient);
    expect(h.fetchMock).not.toHaveBeenCalled();
    const recovered = await dispatchFetch(h.listeners, request());
    expect(recovered?.status).toBe(200);
    expect(await recovered?.text()).toBe(body);
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(h.digest).toHaveBeenCalledOnce();

    // Recovery still requires the retained generation's inventory; it cannot
    // turn an unrelated old client's request into unverified current artwork.
    const stale = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${path}?v=${'a'.repeat(40)}`));
    expect(stale?.status).toBe(503);
    expect(h.fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['/bases/base-a/raid-events', '/api/bases/base-a/raid-events'])('leaves %s on the live network', async (path) => {
    const h = harness();
    expect(await dispatchFetch(h.listeners, new Request(`${ORIGIN}${path}`))).toBeUndefined();
    expect(h.fetchMock).not.toHaveBeenCalled();
    expect(h.stores.size).toBe(0);
  });

  it('recovers new-page brand failures after worker takeover without relaxing old-page isolation', async () => {
    const old = harness('old');
    const paths = [
      '/brand/brand_title_bg_portrait.png', '/brand/brand_title_bg_landscape.png',
      '/brand/brand_logo_main.png',
    ];
    for (const path of paths) {
      const rejected = await dispatchFetch(old.listeners, new Request(`${ORIGIN}${path}?v=new`));
      expect(rejected?.status).toBe(503);
      expect(rejected?.headers.get('cache-control')).toBe('no-store');
    }
    expect(old.fetchMock).not.toHaveBeenCalled();

    const current = harness('new', '', old.stores);
    const body = 'new-build artwork';
    current.fetchMock.mockImplementation(async (input) => new Response(
      url(input!).includes('/asset-pack.json') ? JSON.stringify({
        schema: 1, build: 'new', files: paths.map((path) => ({
          path, bytes: body.length, sha256: sha(body), contentType: 'image/png',
        })),
      }) : body,
    ));
    for (const event of ['install', 'activate']) {
      let work: Promise<void> | undefined;
      current.listeners.get(event)!({ waitUntil: (pending: Promise<void>) => { work = pending; } });
      await work;
    }
    expect(current.self.clients.claim).toHaveBeenCalledTimes(1);
    for (const path of paths) {
      const recovered = await dispatchFetch(current.listeners, new Request(`${ORIGIN}${path}?v=new&imageRetry=1`));
      expect(recovered?.status).toBe(200);
      expect(await recovered?.text()).toBe(body);
      const retired = await dispatchFetch(current.listeners, new Request(`${ORIGIN}${path}?v=old&imageRetry=1`));
      expect(retired?.status).toBe(503);
    }
  });

  it('lets a new page and font load while the previous worker rejects Boot atlases until its new index arrives', async () => {
    // The deployed 879 and 594 worker programs are identical. Registration is
    // asynchronous: network-first HTML and an immutable font can reach App's
    // font-only canvas gate before the new worker publishes its pack index.
    const previousBuild = '879120cf75e04886cb276c8190616995608b1a47';
    const nextBuild = '59416b323df89a1f05e1d21a5b12ae49c48bd2a1';
    const previous = harness(previousBuild);
    const current = harness(nextBuild, '', previous.stores);
    const atlasPaths = [
      '/atlas/bld@1x.png', '/atlas/bld@1x.json',
      '/atlas/warefallback@1x.png', '/atlas/warefallback@1x.json',
    ];
    const body = 'verified next-build atlas';
    const manifest = {
      schema: 2, build: nextBuild, files: atlasPaths.map((path) => ({
        path, bytes: body.length, sha256: sha(body), tier: 'core',
        contentType: path.endsWith('.png') ? 'image/png' : 'application/json; charset=utf-8',
      })),
    };
    let deliverManifest!: (response: Response) => void;
    current.fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { deliverManifest = resolve; }));
    let installing: Promise<void> | undefined;
    current.listeners.get('install')!({ waitUntil: (pending: Promise<void>) => { installing = pending; } });

    previous.fetchMock.mockImplementation(async (input) => new Response('new-page-or-font', {
      headers: { 'content-type': url(input!).endsWith('.woff2') ? 'font/woff2' : 'text/html' },
    }));
    const navigation = new Request(`${ORIGIN}/`);
    Object.defineProperty(navigation, 'mode', { value: 'navigate' });
    expect(await dispatchFetch(previous.listeners, navigation).then((r) => r?.text())).toBe('new-page-or-font');
    expect(await dispatchFetch(previous.listeners, new Request(`${ORIGIN}/assets/font-next.woff2`))
      .then((r) => r?.text())).toBe('new-page-or-font');
    expect(previous.fetchMock).toHaveBeenCalledTimes(2);
    for (const path of atlasPaths) {
      const denied = await dispatchFetch(previous.listeners, new Request(`${ORIGIN}${path}?v=${nextBuild}`));
      expect(denied?.status).toBe(503);
      expect(await denied?.text()).toBe('Asset generation unavailable');
    }
    expect(previous.fetchMock).toHaveBeenCalledTimes(2); // origin artwork was never requested
    expect(current.self.clients.claim).not.toHaveBeenCalled();

    deliverManifest(new Response(JSON.stringify(manifest)));
    await installing;
    previous.fetchMock.mockImplementation(async () => new Response(body));
    // Sharing the validated index closes the window even before activation.
    // A failed negative lookup must not remain memoized in the old controller.
    expect(current.self.clients.claim).not.toHaveBeenCalled();
    for (const path of atlasPaths) {
      const recovered = await dispatchFetch(previous.listeners, new Request(`${ORIGIN}${path}?v=${nextBuild}`));
      expect(recovered?.status).toBe(200);
      expect(await recovered?.text()).toBe(body);
    }
  });

  async function atlasCache(build = 'new', path = '/atlas/ware_wall_1@1x.json') {
    const h = harness();
    const body = 'valid atlas bytes';
    const file = { path, bytes: body.length, sha256: sha(body), contentType: 'application/json; charset=utf-8' };
    const pack = await h.caches.open('pkw-asset-pack-v1');
    await pack.put('/_pkw-pack/deployment-current.json', new Response(JSON.stringify({
      schema: 1, build, files: [file],
    })));
    const key = `${ORIGIN}/_pkw-pack/content/${file.sha256}`;
    const request = new Request(`${ORIGIN}${path}?v=${build}`);
    const headers = { 'x-pkw-sha256': file.sha256, 'x-pkw-bytes': String(file.bytes) };
    return { h, body, file, pack, key, request, headers };
  }

  it.each(['', 'wrong atlas bytes'])('repairs corrupt atlas cache bytes %j despite matching saved headers', async (bad) => {
    const { h, body, pack, key, request, headers } = await atlasCache();
    await pack.put(key, new Response(bad, { headers }));
    await pack.put('/unrelated', new Response('keep me'));
    h.fetchMock.mockResolvedValue(new Response(body));
    const response = await dispatchFetch(h.listeners, request);
    expect(await response?.text()).toBe(body);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const recovered = h.fetchMock.mock.calls[0]![0] as Request;
    expect(recovered.url).toBe(request.url);
    expect(recovered.cache).toBe('reload');
    expect(pack.deletes).toEqual([key]);
    expect(await pack.match('/unrelated').then((r) => r?.text())).toBe('keep me');
    expect(await pack.match(key).then((r) => r?.text())).toBe(body);
    h.fetchMock.mockRejectedValue(new Error('offline'));
    expect(await dispatchFetch(h.listeners, request).then((r) => r?.text())).toBe(body);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['', 'wrong atlas bytes'])('refuses corrupt network atlas 200 %j and does not make it reusable', async (bad) => {
    const { h, pack, key, request } = await atlasCache();
    h.fetchMock.mockResolvedValue(new Response(bad));
    const response = await dispatchFetch(h.listeners, request);
    expect(response?.status).toBe(503);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(await pack.match(key)).toBeUndefined();
    expect(h.stores.get('pkw-shell-new')?.puts).toEqual([]);
  });

  it('evicts only a corrupt exact-build shell atlas and recovers it once', async () => {
    const { h, body, request } = await atlasCache();
    const shell = await h.caches.open('pkw-shell-new');
    await shell.put(request, new Response(''));
    await shell.put('/index.html', new Response('offline shell'));
    h.fetchMock.mockResolvedValue(new Response(body));
    expect(await dispatchFetch(h.listeners, request).then((r) => r?.text())).toBe(body);
    expect(shell.deletes).toEqual([request.url]);
    expect(await shell.match('/index.html').then((r) => r?.text())).toBe('offline shell');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never repairs a corrupt prior-generation atlas with current deployment bytes', async () => {
    const { h, pack, key, request, headers } = await atlasCache('old');
    await pack.put(key, new Response('', { headers }));
    const shell = await h.caches.open('pkw-shell-old');
    await shell.put(request, new Response(''));
    expect((await dispatchFetch(h.listeners, request))?.status).toBe(503);
    expect(pack.deletes).toEqual([key]);
    expect(shell.deletes).toEqual([request.url]);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('leaves an offline corrupt atlas unavailable without deleting another object', async () => {
    const { h, pack, key, request, headers } = await atlasCache();
    await pack.put(key, new Response('', { headers }));
    h.fetchMock.mockRejectedValue(new Error('offline'));
    // Transport failure is an explicit retryable response, still never cached.
    expect((await dispatchFetch(h.listeners, request))?.status).toBe(503);
    expect(pack.deletes).toEqual([key]);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates a complete recovered atlas once before serving and caching a range', async () => {
    const { h, body, pack, key, request, headers } = await atlasCache();
    await pack.put(key, new Response('', { headers }));
    h.fetchMock.mockResolvedValue(new Response(body));
    const ranged = new Request(request, { headers: { range: 'bytes=0-4' } });
    const response = await dispatchFetch(h.listeners, ranged);
    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe(body.slice(0, 5));
    expect((h.fetchMock.mock.calls[0]![0] as Request).headers.has('range')).toBe(false);
    expect(h.digest).toHaveBeenCalledTimes(1); // empty hit rejected by length; network hashed once
    expect(await pack.match(key).then((r) => r?.text())).toBe(body);
  });

  it('does not add body hashing to non-atlas cached assets', async () => {
    const { h, body, pack, key, request, headers } = await atlasCache('new', '/assets/large.json');
    await pack.put(key, new Response(body, { headers }));
    expect(await dispatchFetch(h.listeners, request).then((r) => r?.text())).toBe(body);
    expect(h.digest).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('indexes the current deployment during install without downloading asset bytes', async () => {
    const h = harness();
    const body = 'pixels';
    const manifest = {
      schema: 2, build: 'new', totalBytes: body.length,
      files: [{
        path: '/atlas/family.png', sha256: sha(body), bytes: body.length,
        contentType: 'image/png', tier: 'core',
      }],
    };
    h.fetchMock.mockImplementationOnce(async (input) => {
      expect(new URL(String(input), ORIGIN).pathname).toBe('/asset-pack.json');
      return new Response(JSON.stringify(manifest));
    });
    let installation: Promise<void> | undefined;
    h.listeners.get('install')!({ waitUntil: (work: Promise<void>) => { installation = work; } });
    await installation;
    const pack = h.stores.get('pkw-asset-pack-v1')!;
    expect(await pack.match(`${ORIGIN}/_pkw-pack/current.json`)).toBeUndefined();
    expect(await pack.match(`${ORIGIN}/_pkw-pack/deployment-current.json`).then((r) => r?.json()))
      .toEqual(manifest);
    expect([...pack.entries.keys()].filter((entry) => entry.includes('/content/'))).toHaveLength(0);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'legacy', 'CORE', ''])('rejects schema-2 files with invalid tier %s', async (tier) => {
    const h = harness();
    const body = 'pixels';
    h.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema: 2, build: 'new', totalBytes: body.length,
      files: [{
        path: '/atlas/family.png', sha256: sha(body), bytes: body.length,
        contentType: 'image/png', ...(tier === undefined ? {} : { tier }),
      }],
    })));
    let installation: Promise<void> | undefined;
    h.listeners.get('install')!({ waitUntil: (work: Promise<void>) => { installation = work; } });
    await installation;
    const pack = h.stores.get('pkw-asset-pack-v1');
    expect(await pack?.match(`${ORIGIN}/_pkw-pack/deployment-current.json`)).toBeUndefined();
  });

  it('accepts legacy schema 1 only without a tier during the rolling deploy', async () => {
    const h = harness();
    const body = 'legacy';
    h.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema: 1, build: 'new', totalBytes: body.length,
      files: [{
        path: '/atlas/family.png', sha256: sha(body), bytes: body.length,
        contentType: 'image/png', tier: 'full',
      }],
    })));
    let installation: Promise<void> | undefined;
    h.listeners.get('install')!({ waitUntil: (work: Promise<void>) => { installation = work; } });
    await installation;
    expect(await h.stores.get('pkw-asset-pack-v1')
      ?.match(`${ORIGIN}/_pkw-pack/deployment-current.json`)).toBeUndefined();
  });

  it('retains verified objects referenced only by the schema-2 core pointer', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const kept = sha('core bytes');
    const stale = sha('stale bytes');
    await pack.put(`${ORIGIN}/_pkw-pack/core.json`, new Response(JSON.stringify({
      schema: 2, build: 'new', totalBytes: 10,
      files: [{
        path: '/brand/core.png', sha256: kept, bytes: 10,
        contentType: 'image/png', tier: 'core',
      }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${kept}`, new Response('core bytes'));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${stale}`, new Response('stale bytes'));
    let activation: Promise<void> | undefined;
    h.listeners.get('activate')!({ waitUntil: (work: Promise<void>) => { activation = work; } });
    await activation;
    expect(await pack.match(`${ORIGIN}/_pkw-pack/content/${kept}`)).toBeDefined();
    expect(await pack.match(`${ORIGIN}/_pkw-pack/content/${stale}`)).toBeUndefined();
  });

  it('serves a verified schema-2 core pointer when deployment-index refresh was unavailable', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const body = 'offline-core';
    const hash = sha(body);
    await pack.put(`${ORIGIN}/_pkw-pack/core.json`, new Response(JSON.stringify({
      schema: 2, build: 'new', totalBytes: body.length,
      files: [{
        path: '/brand/core.png', sha256: hash, bytes: body.length,
        contentType: 'image/png', tier: 'core',
      }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${hash}`, new Response(body, {
      headers: { 'x-pkw-sha256': hash, 'x-pkw-bytes': String(body.length) },
    }));

    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/brand/core.png?v=new`));
    expect(await response?.text()).toBe(body);
    expect(response?.headers.get('content-type')).toBe('image/png');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('aborts a stale-query automatic update before mutating its old shell or taking control', async () => {
    const buildA = 'a'.repeat(40);
    const buildB = 'b'.repeat(40);
    const h = harness(buildA);
    const shell = await h.caches.open(`pkw-shell-${buildA}`) as unknown as SwCache;
    await shell.put('/index.html', new Response('build-a shell'));
    const body = 'build-b-generation';
    h.fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      schema: 1, build: buildB, totalBytes: body.length,
      files: [{
        path: '/atlas/family.png', sha256: sha(body), bytes: body.length, contentType: 'image/png',
      }],
    })));
    let installation: Promise<void> | undefined;

    h.listeners.get('install')!({ waitUntil: (work: Promise<void>) => { installation = work; } });

    await expect(installation).rejects.toThrow('stale service-worker registration');
    expect(shell.added).toHaveLength(0);
    expect(await shell.match('/index.html').then((response) => response?.text())).toBe('build-a shell');
    expect(h.self.skipWaiting).not.toHaveBeenCalled();
    expect(h.stores.has('pkw-asset-pack-v1')).toBe(false);
  });

  it('reuses a verified content hash under the current deployment path across shell releases', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const body = 'unchanged-family';
    const hash = sha(body);
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 2, build: 'new', files: [{
        path: '/atlas/family.png', sha256: hash, bytes: body.length,
        contentType: 'image/png', tier: 'full',
      }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${hash}`, new Response(body, {
      headers: { 'x-pkw-sha256': hash, 'x-pkw-bytes': String(body.length) },
    }));
    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/atlas/family.png?v=new`));
    expect(await response?.text()).toBe(body);
    expect(response?.headers.get('content-type')).toBe('image/png');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('routes current and already-open previous bundles to their own retained deployment bytes', async () => {
    const h = harness('new');
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const path = '/atlas/family.png';
    const oldBody = 'old-generation';
    const newBody = 'new-generation';
    const oldHash = sha(oldBody);
    const newHash = sha(newBody);
    const file = (body: string, hash: string) => ({
      path, sha256: hash, bytes: body.length, contentType: 'image/png',
    });
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [file(newBody, newHash)],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-previous.json`, new Response(JSON.stringify({
      schema: 1, build: 'old', files: [file(oldBody, oldHash)],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${oldHash}`, new Response(oldBody, {
      headers: { 'x-pkw-sha256': oldHash, 'x-pkw-bytes': String(oldBody.length) },
    }));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${newHash}`, new Response(newBody, {
      headers: { 'x-pkw-sha256': newHash, 'x-pkw-bytes': String(newBody.length) },
    }));

    const oldResponse = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${path}?v=old`));
    const newResponse = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${path}?v=new`));

    expect(await oldResponse?.text()).toBe(oldBody);
    expect(await newResponse?.text()).toBe(newBody);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed for an explicit unretained stable-asset version', async () => {
    const h = harness('new');
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const body = 'new-generation';
    const hash = sha(body);
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [{
        path: '/atlas/family.png', sha256: hash, bytes: body.length, contentType: 'image/png',
      }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${hash}`, new Response(body, {
      headers: { 'x-pkw-sha256': hash, 'x-pkw-bytes': String(body.length) },
    }));

    const response = await dispatchFetch(
      h.listeners,
      new Request(`${ORIGIN}/atlas/family.png?v=unrelated`),
    );

    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('Asset generation unavailable');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed for a tab two deployments stale after its pointer and shell retire', async () => {
    const preA = '0'.repeat(40);
    const buildA = 'a'.repeat(40);
    const buildB = 'b'.repeat(40);
    const h = harness(buildB);
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const path = '/atlas/family.png';
    const file = (body: string) => ({
      path, sha256: sha(body), bytes: body.length, contentType: 'image/png',
    });
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: buildB, files: [file('build-b-generation')],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-previous.json`, new Response(JSON.stringify({
      schema: 1, build: buildA, files: [file('build-a-generation')],
    })));
    const staleShell = await h.caches.open(`pkw-shell-${preA}`) as unknown as SwCache;
    await staleShell.put(`${ORIGIN}${path}?v=${preA}`, new Response('pre-a-generation'));
    let activation: Promise<void> | undefined;
    h.listeners.get('activate')!({ waitUntil: (work: Promise<void>) => { activation = work; } });
    await activation;

    const response = await dispatchFetch(
      h.listeners,
      new Request(`${ORIGIN}${path}?v=${preA}`),
    );

    expect(h.deleted).toContain(`pkw-shell-${preA}`);
    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('Asset generation unavailable');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/icons/icon-96.png?v=c0137365',
    '/icons/icon-192.png',
    `/assets/app-deadbeef.js?v=${'0'.repeat(40)}`,
  ])('keeps fixed-revision or immutable request %s on the online fallback', async (path) => {
    const h = harness('b'.repeat(40));

    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${path}`));

    expect(await response?.text()).toBe('network');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a build-versioned icon outside the retained pair', async () => {
    const h = harness('b'.repeat(40));

    const response = await dispatchFetch(
      h.listeners,
      new Request(`${ORIGIN}/icons/icon-192.png?v=${'0'.repeat(40)}`),
    );

    expect(response?.status).toBe(503);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('rejects current deployment bytes when recovering a retained previous release cache miss', async () => {
    const h = harness('new');
    const oldBuild = 'a'.repeat(40);
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const oldBody = 'old-generation';
    const oldHash = sha(oldBody);
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-previous.json`, new Response(JSON.stringify({
      schema: 1, build: oldBuild, files: [{
        path: '/atlas/family.png', sha256: oldHash, bytes: oldBody.length, contentType: 'image/png',
      }],
    })));
    h.fetchMock.mockResolvedValueOnce(new Response('current-generation'));

    const response = await dispatchFetch(
      h.listeners,
      new Request(`${ORIGIN}/atlas/family.png?v=${oldBuild}`),
    );

    expect(response?.status).toBe(503);
    expect(await response?.text()).toBe('Asset generation unavailable');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect((h.fetchMock.mock.calls[0]![0] as Request).url)
      .toBe(`${ORIGIN}/atlas/family.png?v=${oldBuild}`);
    expect(await pack.match(`${ORIGIN}/_pkw-pack/content/${oldHash}`)).toBeUndefined();
  });

  describe('retained immutable release recovery', () => {
    const previousBuild = 'a'.repeat(40);
    const currentBuild = 'b'.repeat(40);
    const assets = [
      ['/atlas/ware_wall_1@1x.png', 'image/png'],
      ['/atlas/ware_wall_1@1x.json', 'application/json; charset=utf-8'],
      ['/audio/theme.mp3', 'audio/mpeg'],
      ['/brand/title.png', 'image/png'],
      ['/icons/icon-192.png', 'image/png'],
    ] as const;

    async function previousAsset(path: string = assets[0][0], contentType: string = assets[0][1]) {
      const h = harness(currentBuild);
      const body = '0123456789';
      const file = { path, bytes: body.length, sha256: sha(body), contentType, tier: 'full' };
      const manifest = { schema: 2, build: previousBuild, files: [file] };
      const pack = await h.caches.open('pkw-asset-pack-v1');
      await pack.put('/_pkw-pack/deployment-previous.json', new Response(JSON.stringify(manifest)));
      const request = new Request(`${ORIGIN}${path}?v=${previousBuild}`);
      const key = `${ORIGIN}/_pkw-pack/content/${file.sha256}`;
      return { h, body, file, manifest, pack, request, key };
    }

    it.each(assets)('recovers a missing previous %s with its pinned SHA, then serves it offline', async (path, type) => {
      const { h, body, file, manifest, pack, request, key } = await previousAsset(path, type);
      h.fetchMock.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': 'text/html' } }));

      const recovered = await dispatchFetch(h.listeners, request);

      expect(recovered?.status).toBe(200);
      expect(await recovered?.text()).toBe(body);
      expect(recovered?.headers.get('content-type')).toBe(type);
      expect(h.digest).toHaveBeenCalledTimes(1);
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
      const fetched = h.fetchMock.mock.calls[0]![0] as Request;
      expect(fetched.url).toBe(request.url);
      expect(fetched.cache).toBe('reload');
      expect(fetched.redirect).toBe('error');
      expect(fetched.headers.has('range')).toBe(false);
      const cached = await pack.match(key);
      expect(cached?.headers.get('x-pkw-sha256')).toBe(file.sha256);
      expect(cached?.headers.get('x-pkw-bytes')).toBe(String(file.bytes));
      expect(await cached?.text()).toBe(body);
      expect(await pack.match('/_pkw-pack/deployment-previous.json').then((r) => r?.json())).toEqual(manifest);
      expect(await pack.match('/_pkw-pack/deployment-current.json')).toBeUndefined();
      expect(h.stores.get(`pkw-shell-${previousBuild}`)?.puts).toEqual([]);

      h.fetchMock.mockRejectedValue(new Error('offline'));
      expect(await dispatchFetch(h.listeners, request).then((r) => r?.text())).toBe(body);
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
      expect(h.digest).toHaveBeenCalledTimes(2);
    });

    it.each(['content', 'shell'] as const)('verifies retained audio %s bytes before returning a range', async (cacheKind) => {
      const { h, body, file, pack, request, key } = await previousAsset('/audio/theme.mp3', 'audio/mpeg');
      const cache = cacheKind === 'content' ? pack : await h.caches.open(`pkw-shell-${previousBuild}`);
      const cacheKey = cacheKind === 'content' ? key : request.url;
      await cache.put(cacheKey, new Response(body, {
        headers: { 'x-pkw-sha256': file.sha256, 'x-pkw-bytes': String(file.bytes) },
      }));
      h.fetchMock.mockRejectedValue(new Error('offline'));
      const response = await dispatchFetch(h.listeners, new Request(request, { headers: { range: 'bytes=2-5' } }));
      expect(response?.status).toBe(206);
      expect(response?.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(await response?.text()).toBe('2345');
      expect(h.digest).toHaveBeenCalledTimes(1);
      expect(h.fetchMock).not.toHaveBeenCalled();
    });

    it.each(['content', 'shell'] as const)('evicts corrupt previous audio %s bytes before exact-release recovery', async (cacheKind) => {
      const { h, body, file, pack, request, key } = await previousAsset('/audio/theme.mp3', 'audio/mpeg');
      const cache = cacheKind === 'content' ? pack : await h.caches.open(`pkw-shell-${previousBuild}`);
      const cacheKey = cacheKind === 'content' ? key : request.url;
      await cache.put(cacheKey, new Response('bad bytes!', {
        headers: { 'x-pkw-sha256': file.sha256, 'x-pkw-bytes': String(file.bytes) },
      }));
      await cache.put('/unrelated', new Response('keep me'));
      h.fetchMock.mockResolvedValueOnce(new Response(body));
      expect(await dispatchFetch(h.listeners, request).then((r) => r?.text())).toBe(body);
      expect(cache.deletes).toEqual([cacheKey]);
      expect(await cache.match('/unrelated').then((r) => r?.text())).toBe('keep me');
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
      expect(await pack.match(key).then((r) => r?.text())).toBe(body);
    });

    it.each(['missing pointer', 'different build', 'invalid hash', 'unlisted path', 'non-release build'] as const)(
      'never authorizes recovery or a path-only shell hit with %s', async (reason) => {
        const { h, body, file, pack, request, key } = await previousAsset();
        const build = reason === 'non-release build' ? 'old' : previousBuild;
        const rejected = new Request(request.url.replace(previousBuild, build));
        const shell = await h.caches.open(`pkw-shell-${build}`);
        await shell.put(rejected, new Response(body));
        if (reason === 'missing pointer') await pack.delete('/_pkw-pack/deployment-previous.json');
        else await pack.put('/_pkw-pack/deployment-previous.json', new Response(JSON.stringify({
          schema: 2, build: reason === 'different build' ? 'c'.repeat(40) : build,
          files: [{
            ...file,
            ...(reason === 'invalid hash' ? { sha256: 'invalid' } : {}),
            ...(reason === 'unlisted path' ? { path: '/atlas/other.png' } : {}),
          }],
        })));
        // A non-release identity may use verified cached bytes, but has no
        // immutable server snapshot from which a missing object can recover.
        if (reason === 'non-release build') await shell.delete(rejected);
        h.fetchMock.mockResolvedValue(new Response(body));
        const response = await dispatchFetch(h.listeners, rejected);
        expect(response?.status).toBe(503);
        expect(h.fetchMock).not.toHaveBeenCalled();
        expect(await pack.match(key)).toBeUndefined();
      },
    );

    it.each(['wrong generation', 'truncated', 'empty', 'partial', 'missing', 'opaque', 'offline', 'interrupted'] as const)(
      'refuses %s previous-release responses without caching them', async (failure) => {
        const { h, body, pack, request, key } = await previousAsset('/brand/title.png', 'image/png');
        if (failure === 'offline') h.fetchMock.mockRejectedValueOnce(new Error('offline'));
        else {
          const response = new Response(
            failure === 'wrong generation' ? 'abcdefghij' : failure === 'truncated' ? body.slice(0, -1) : failure === 'empty' ? '' : body,
            { status: failure === 'partial' ? 206 : failure === 'missing' ? 404 : 200 },
          );
          if (failure === 'opaque') Object.defineProperty(response, 'type', { value: 'opaque' });
          if (failure === 'interrupted') response.arrayBuffer = async () => { throw new Error('body interrupted'); };
          h.fetchMock.mockResolvedValueOnce(response);
        }
        const response = await dispatchFetch(h.listeners, new Request(request, { headers: { range: 'bytes=0-4' } }));
        expect(response?.status).toBe(503);
        expect(response?.headers.get('cache-control')).toBe('no-store');
        expect(h.fetchMock).toHaveBeenCalledTimes(1);
        expect(await pack.match(key)).toBeUndefined();
        expect(h.stores.get(`pkw-shell-${previousBuild}`)?.puts).toEqual([]);
      },
    );

    it.each([
      ['bytes=2-5', 206, '2345', 'bytes 2-5/10'],
      ['bytes=-3', 206, '789', 'bytes 7-9/10'],
      ['bytes=4-', 206, '456789', 'bytes 4-9/10'],
      ['bytes=8-99', 206, '89', 'bytes 8-9/10'],
      ['bytes=10-', 416, '', 'bytes */10'],
      ['bytes=7-2', 416, '', 'bytes */10'],
      ['bytes=-0', 416, '', 'bytes */10'],
      ['bytes=0-1,4-5', 200, '0123456789', null],
      ['not-a-range', 200, '0123456789', null],
    ] as const)('derives %s only from the verified complete previous object', async (range, status, expected, contentRange) => {
      const { h, body, pack, request, key } = await previousAsset('/audio/theme.mp3', 'audio/mpeg');
      h.fetchMock.mockResolvedValueOnce(new Response(body));
      const ranged = new Request(request, { headers: { range } });
      const response = await dispatchFetch(h.listeners, ranged);
      expect(response?.status).toBe(status);
      expect(response?.headers.get('content-range')).toBe(contentRange);
      expect(await response?.text()).toBe(expected);
      expect((h.fetchMock.mock.calls[0]![0] as Request).headers.has('range')).toBe(false);
      expect(h.digest).toHaveBeenCalledTimes(1);
      expect(await pack.match(key).then((r) => r?.text())).toBe(body);
      h.fetchMock.mockRejectedValue(new Error('offline'));
      const cached = await dispatchFetch(h.listeners, ranged);
      expect(cached?.status).toBe(status);
      expect(await cached?.text()).toBe(expected);
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['header', 'query', 'both'] as const)('does not let a pack download %s bypass previous-generation verification', async (bypass) => {
      const { h, pack, request, key } = await previousAsset();
      const bypassRequest = new Request(`${request.url}${bypass === 'header' ? '' : '&pack=1'}`, {
        headers: bypass === 'query' ? {} : { 'x-pkw-pack-download': currentBuild },
      });
      h.fetchMock.mockResolvedValueOnce(new Response('abcdefghij'));
      const response = await dispatchFetch(h.listeners, bypassRequest);
      expect(response?.status).toBe(503);
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
      expect(await pack.match(key)).toBeUndefined();
    });

    it('keeps an unpinned release unavailable even with both downloader bypasses', async () => {
      const h = harness(currentBuild);
      const response = await dispatchFetch(h.listeners, new Request(
        `${ORIGIN}/atlas/family.png?v=${previousBuild}&pack=1`,
        { headers: { 'x-pkw-pack-download': currentBuild } },
      ));
      expect(response?.status).toBe(503);
      expect(h.fetchMock).not.toHaveBeenCalled();
    });
  });

  it('keeps an old active shell on its previous hash inventory during takeover', async () => {
    const h = harness('old');
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const oldBody = 'old-generation';
    const oldHash = sha(oldBody);
    const file = {
      path: '/atlas/family.png', sha256: oldHash, bytes: oldBody.length, contentType: 'image/png',
    };
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [{ ...file, sha256: 'f'.repeat(64), bytes: 3 }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-previous.json`, new Response(JSON.stringify({
      schema: 1, build: 'old', files: [file],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${oldHash}`, new Response(oldBody, {
      headers: { 'x-pkw-sha256': oldHash, 'x-pkw-bytes': String(oldBody.length) },
    }));
    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/atlas/family.png?v=old`));
    expect(await response?.text()).toBe(oldBody);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('paints a network asset immediately and retains its verified SHA for the next request', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const body = 'fresh-family';
    const hash = sha(body);
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [{
        path: '/atlas/family.png', sha256: hash, bytes: body.length, contentType: 'image/png',
      }],
    })));
    h.fetchMock.mockResolvedValueOnce(new Response(body));
    const first = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/atlas/family.png?v=new`));
    expect(await first?.text()).toBe(body);
    const retained = await pack.match(`${ORIGIN}/_pkw-pack/content/${hash}`);
    expect(retained?.headers.get('x-pkw-sha256')).toBe(hash);
    expect(retained?.headers.get('x-pkw-bytes')).toBe(String(body.length));

    const second = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/atlas/family.png?v=new`));
    expect(await second?.text()).toBe(body);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves same-build pack downloads to the page, but never lets a mismatched header bypass hash storage', async () => {
    const h = harness('new');
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const body = 'first-launch-family';
    const hash = sha(body);
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [{
        path: '/atlas/family.png', sha256: hash, bytes: body.length, contentType: 'image/png',
      }],
    })));
    h.fetchMock.mockImplementation(async () => new Response(body));

    const owned = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/atlas/family.png?v=new`, {
      headers: { 'x-pkw-pack-download': 'new' },
    }));
    expect(await owned?.text()).toBe(body);
    expect(await pack.match(`${ORIGIN}/_pkw-pack/content/${hash}`)).toBeUndefined();

    const stale = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/atlas/family.png?v=new`, {
      headers: { 'x-pkw-pack-download': 'old' },
    }));
    expect(await stale?.text()).toBe(body);
    expect(await pack.match(`${ORIGIN}/_pkw-pack/content/${hash}`)).toBeDefined();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves an MP3 byte range from the verified full object without touching the network', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const hash = 'a'.repeat(64);
    await pack.put(`${ORIGIN}/_pkw-pack/current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [{
        path: '/audio/theme.mp3', sha256: hash, bytes: 10, contentType: 'audio/mpeg',
      }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${hash}`, new Response('0123456789', {
      headers: { 'content-type': 'audio/mpeg', 'x-pkw-sha256': hash, 'x-pkw-bytes': '10' },
    }));
    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/audio/theme.mp3?v=new`, {
      headers: { range: 'bytes=2-5' },
    }));
    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe('2345');
    expect(response?.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(response?.headers.get('content-length')).toBe('4');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it.each(['bytes=0-1,4-5', 'items=0-1', 'not-a-range'])(
    'falls through malformed or multi-range %s to the network instead of fabricating a cached response',
    async (range) => {
      const h = harness();
      const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
      const hash = 'c'.repeat(64);
      await pack.put(`${ORIGIN}/_pkw-pack/current.json`, new Response(JSON.stringify({
        schema: 1,
        build: 'new',
        files: [{ path: '/audio/theme.mp3', sha256: hash, bytes: 10, contentType: 'audio/mpeg' }],
      })));
      await pack.put(`${ORIGIN}/_pkw-pack/content/${hash}`, new Response('0123456789'));

      const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/audio/theme.mp3?v=new`, {
        headers: { range },
      }));

      expect(await response?.text()).toBe('network');
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('restores the manifest MIME for each logical path when different URLs share one content hash', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const hash = 'd'.repeat(64);
    await pack.put(`${ORIGIN}/_pkw-pack/current.json`, new Response(JSON.stringify({
      schema: 1,
      build: 'new',
      files: [
        { path: '/audio/shared.mp3', sha256: hash, bytes: 10, contentType: 'audio/mpeg' },
        { path: '/brand/shared.png', sha256: hash, bytes: 10, contentType: 'image/png' },
      ],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${hash}`, new Response('same bytes', {
      headers: {
        'content-type': 'application/octet-stream',
        'x-pkw-sha256': hash,
        'x-pkw-bytes': '10',
      },
    }));

    const audio = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/audio/shared.mp3?v=new`));
    const image = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/brand/shared.png?v=new`));

    expect(audio?.headers.get('content-type')).toBe('audio/mpeg');
    expect(image?.headers.get('content-type')).toBe('image/png');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('retains and serves the previous exact shell cache when its content object is absent', async () => {
    const h = harness('new');
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const path = '/atlas/family.png';
    const oldBody = 'old-shell-generation';
    const newBody = 'new-generation';
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [{
        path, sha256: sha(newBody), bytes: newBody.length, contentType: 'image/png',
      }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-previous.json`, new Response(JSON.stringify({
      schema: 1, build: 'old', files: [{
        path, sha256: sha(oldBody), bytes: oldBody.length, contentType: 'image/png',
      }],
    })));
    const oldShell = await h.caches.open('pkw-shell-old') as unknown as SwCache;
    await oldShell.put(`${ORIGIN}${path}?v=old`, new Response(oldBody));
    for (const name of ['pkw-shell-new', 'pkw-shell-stale', 'unrelated']) h.stores.set(name, new SwCache());
    h.stores.set('pkw-push-session-v1', new SwCache());
    let activation: Promise<void> | undefined;
    h.listeners.get('activate')!({ waitUntil: (work: Promise<void>) => { activation = work; } });
    await activation;

    expect(h.deleted).toContain('pkw-shell-stale');
    expect(h.deleted).not.toContain('pkw-asset-pack-v1');
    expect(h.deleted).not.toContain('pkw-push-session-v1');
    expect(h.deleted).not.toContain('pkw-shell-old');
    expect(h.deleted).not.toContain('pkw-shell-new');
    expect(h.deleted).not.toContain('unrelated');
    const response = await dispatchFetch(
      h.listeners,
      new Request(`${ORIGIN}${path}?v=old`),
    );
    expect(await response?.text()).toBe(oldBody);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('never intercepts same-origin API/auth or any cross-origin RPC/wallet request', async () => {
    const h = harness();
    expect(await dispatchFetch(h.listeners, new Request(`${ORIGIN}/api/base`))).toBeUndefined();
    expect(await dispatchFetch(h.listeners, new Request(`${ORIGIN}/auth/me`))).toBeUndefined();
    expect(await dispatchFetch(h.listeners, new Request(`${ORIGIN}/rpc`))).toBeUndefined();
    expect(await dispatchFetch(h.listeners, {
      method: 'GET', mode: 'navigate', url: `${ORIGIN}/api/base`, headers: new Headers(),
    } as Request)).toBeUndefined();
    expect(await dispatchFetch(h.listeners, new Request('https://api.devnet.solana.com/'))).toBeUndefined();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled repeat navigation and returns the cached shell after eight seconds', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const oldShell = await h.caches.open('pkw-shell-old') as unknown as SwCache;
      await oldShell.put('/index.html', new Response('old cached shell'));
      const shell = await h.caches.open('pkw-shell-new') as unknown as SwCache;
      await shell.put('/index.html', new Response('cached shell'));
      let aborted = false;
      h.fetchMock.mockImplementationOnce(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('navigation fetch did not receive an abort signal');
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        }, { once: true });
      }));

      const responsePromise = dispatchFetch(h.listeners, {
        method: 'GET', mode: 'navigate', url: `${ORIGIN}/`, headers: new Headers(),
      } as Request);
      await vi.advanceTimersByTimeAsync(8_000);
      const response = await responsePromise;

      expect(aborted).toBe(true);
      expect(await response?.text()).toBe('cached shell');
      expect(h.fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not impose the fallback timeout when no cached shell exists', async () => {
    const h = harness();
    const response = await dispatchFetch(h.listeners, {
      method: 'GET', mode: 'navigate', url: `${ORIGIN}/`, headers: new Headers(),
    } as Request);
    expect(await response?.text()).toBe('network');
    expect(h.fetchMock).toHaveBeenCalledWith(expect.anything());
  });

  it('still prefers and stores a fresh navigation when the network responds within the deadline', async () => {
    const h = harness();
    const shell = await h.caches.open('pkw-shell-new') as unknown as SwCache;
    await shell.put('/index.html', new Response('cached shell'));
    h.fetchMock.mockResolvedValueOnce(new Response('fresh shell', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));

    const response = await dispatchFetch(h.listeners, {
      method: 'GET', mode: 'navigate', url: `${ORIGIN}/`, headers: new Headers(),
    } as Request);

    expect(await response?.text()).toBe('fresh shell');
    expect(await (await shell.match('/index.html'))?.text()).toBe('fresh shell');
    expect(h.fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  it('keeps a valid navigation cache write in waitUntil without delaying the fresh response', async () => {
    const h = harness();
    const shell = await h.caches.open('pkw-shell-new') as unknown as SwCache;
    await shell.put('/index.html', new Response('cached shell'));
    let releasePut!: () => void;
    shell.putBarrier = new Promise<void>((resolve) => { releasePut = resolve; });
    h.fetchMock.mockResolvedValueOnce(new Response('fresh shell', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }));
    let responseWork: Promise<Response> | undefined;
    let lifetimeWork: Promise<unknown> | undefined;

    h.listeners.get('fetch')!({
      request: { method: 'GET', mode: 'navigate', url: `${ORIGIN}/`, headers: new Headers() } as Request,
      respondWith: (work: Promise<Response>) => { responseWork = Promise.resolve(work); },
      waitUntil: (work: Promise<unknown>) => { lifetimeWork = Promise.resolve(work); },
    });

    const response = await responseWork;
    expect(await response?.text()).toBe('fresh shell');
    expect(await shell.match('/index.html').then((cached) => cached?.text())).toBe('cached shell');
    expect(lifetimeWork).toBeDefined();
    releasePut();
    await lifetimeWork;
    expect(await shell.match('/index.html').then((cached) => cached?.text())).toBe('fresh shell');
  });

  it.each([
    ['an HTTP error', () => new Response('maintenance', {
      status: 503, headers: { 'content-type': 'text/html' },
    })],
    ['non-HTML', () => new Response('{"ok":true}', {
      headers: { 'content-type': 'application/json' },
    })],
    ['cross-origin HTML', () => {
      const response = new Response('foreign shell', { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(response, 'url', { value: 'https://example.invalid/index.html' });
      return response;
    }],
  ])('does not cache %s as the navigation shell', async (_label, fresh) => {
    const h = harness();
    const shell = await h.caches.open('pkw-shell-new') as unknown as SwCache;
    await shell.put('/index.html', new Response('cached shell'));
    h.fetchMock.mockResolvedValueOnce(fresh());

    await dispatchFetch(h.listeners, {
      method: 'GET', mode: 'navigate', url: `${ORIGIN}/`, headers: new Headers(),
    } as Request);

    expect(await shell.match('/index.html').then((cached) => cached?.text())).toBe('cached shell');
  });

  it('sends downloader transfers straight to the deploy and never duplicates them in the shell cache', async () => {
    const h = harness();
    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/atlas/world.png?pack=next`));
    expect(await response?.text()).toBe('network');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const shell = h.stores.get('pkw-shell-new');
    expect(shell?.entries.size ?? 0).toBe(0);
  });

  it('never paints a previous-build pack beneath a newly deployed shell', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const hash = 'b'.repeat(64);
    await pack.put(`${ORIGIN}/_pkw-pack/current.json`, new Response(JSON.stringify({
      schema: 1, build: 'old', files: [{
        path: '/brand/logo.png', sha256: hash, bytes: 10, contentType: 'image/png',
      }],
    })));
    await pack.put(`${ORIGIN}/_pkw-pack/content/${hash}`, new Response('deprecated'));
    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}/brand/logo.png?v=new`));
    expect(await response?.text()).toBe('network');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never puts a network 206 response into an on-demand shell cache', () => {
    expect(source).toContain("if (req.headers.has('range'))");
    expect(source).toContain('return fetch(req)');
    expect(source).toContain("if (res.status === 200 && res.type === 'basic')");
  });

  it('acknowledges the committed-index reset before Phaser may mount', () => {
    const h = harness();
    const port = { postMessage: vi.fn() };
    h.listeners.get('message')!({
      data: { type: 'asset-pack-committed', build: 'new' }, ports: [port],
    });
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'asset-pack-ready', build: 'new' });
  });

  it('does not acknowledge a commit from a page running a different build', () => {
    const h = harness();
    const port = { postMessage: vi.fn() };
    h.listeners.get('message')!({
      data: { type: 'asset-pack-committed', build: 'old' }, ports: [port],
    });
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('flushes pending runtime hash writes before the page inventories the pack', async () => {
    const h = harness();
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const body = 'boot-family';
    const hash = sha(body);
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({
      schema: 1, build: 'new', files: [{
        path: '/atlas/family.png', sha256: hash, bytes: body.length, contentType: 'image/png',
      }],
    })));
    let releaseWrite!: () => void;
    pack.putBarrier = new Promise<void>((resolve) => { releaseWrite = resolve; });
    h.fetchMock.mockResolvedValueOnce(new Response(body));

    let fetchResponse: Promise<Response> | undefined;
    let fetchLifetime: Promise<unknown> | undefined;
    h.listeners.get('fetch')!({
      request: new Request(`${ORIGIN}/atlas/family.png?v=new`),
      respondWith: (work: Promise<Response>) => { fetchResponse = Promise.resolve(work); },
      waitUntil: (work: Promise<unknown>) => { fetchLifetime = Promise.resolve(work); },
    });
    await fetchResponse;

    const port = { postMessage: vi.fn() };
    let flushLifetime: Promise<unknown> | undefined;
    h.listeners.get('message')!({
      data: { type: 'asset-pack-inventory-flush', build: 'new' },
      ports: [port],
      waitUntil: (work: Promise<unknown>) => { flushLifetime = Promise.resolve(work); },
    });
    await Promise.resolve();
    expect(port.postMessage).not.toHaveBeenCalled();
    releaseWrite();
    await fetchLifetime;
    await flushLifetime;
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'asset-pack-inventory-ready', build: 'new' });
    expect(await pack.match(`${ORIGIN}/_pkw-pack/content/${hash}`)).toBeDefined();
  });
});

describe('terrain streaming keeps generation and offline integrity', () => {
  const currentBuild = 'b'.repeat(40), previousBuild = 'a'.repeat(40);
  const path = '/atlas/fantasy/ground-v2/crownlands.png';
  const body = '0123456789';

  async function terrain(build = currentBuild, terrainPath = path) {
    const h = harness(currentBuild);
    const file = { path: terrainPath, bytes: body.length, sha256: sha(body), contentType: terrainPath.endsWith('.json') ? 'application/json; charset=utf-8' : terrainPath.endsWith('.webp') ? 'image/webp' : 'image/png', tier: 'full' };
    const pack = await h.caches.open('pkw-asset-pack-v1');
    const pointer = `/_pkw-pack/deployment-${build === currentBuild ? 'current' : 'previous'}.json`;
    await pack.put(pointer, new Response(JSON.stringify({ schema: 2, build, files: [file] })));
    const request = new Request(`${ORIGIN}${terrainPath}?v=${build}`, {
      headers: { 'x-pkw-ground-stream': build },
    });
    return { h, file, pack, pointer, request, key: `${ORIGIN}/_pkw-pack/content/${file.sha256}` };
  }

  function dispatch(h: ReturnType<typeof harness>, request: Request) {
    let response!: Promise<Response>, lifetime!: Promise<unknown>;
    let dispatching = true;
    h.listeners.get('fetch')!({
      request,
      respondWith: (work: Promise<Response>) => { response = Promise.resolve(work); },
      waitUntil: (work: Promise<unknown>) => {
        if (!dispatching) throw new Error('late waitUntil');
        lifetime = Promise.resolve(work);
      },
    });
    dispatching = false;
    return { response, lifetime };
  }

  it.each([currentBuild, previousBuild].flatMap(build => ['/atlas/fantasy/ground-v4/thornwake.webp', '/atlas/fantasy/ground-v4/seeker-reach.png', '/atlas/fantasy/ground-v3/crownlands.png', '/atlas/fantasy/ground-v2/frostveil.webp', '/atlas/fantasy/globe/realm-texture.png', '/atlas/fantasy/globe/generated/solana-detail.png', `/atlas/fantasy/layered-ground/${sha(body)}/manifest.json`, `/atlas/fantasy/layered-ground/assets/${sha(body)}.webp`, `/atlas/fantasy/layered-ground/assets/${sha(body)}.png`].map(terrainPath => [build, terrainPath] as const)))('streams exact generation %s terrain %s', async (build, terrainPath) => {
    const { h, request, pack, key } = await terrain(build, terrainPath);
    h.fetchMock.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': terrainPath.endsWith('.webp') ? 'image/webp' : 'image/png' } }));
    const work = dispatch(h, request);
    const response = await work.response;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    await work.lifetime;
    expect((h.fetchMock.mock.calls[0]![0] as Request).url).toBe(request.url);
    expect(await pack.match(key).then(value => value?.text())).toBe(body);
  });

  it.each([path, '/atlas/fantasy/globe/generated/heartlands-detail.png', `/atlas/fantasy/layered-ground/assets/${sha(body)}.webp`])('delivers %s progress before the body finishes while inventory waits for verified storage', async (terrainPath) => {
    const { h, pack, request, key } = await terrain(currentBuild, terrainPath);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    controller.enqueue(new TextEncoder().encode(body.slice(0, 3)));
    h.fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { etag: '"terrain"' } }));
    const work = dispatch(h, request);
    let lifetimeFinished = false;
    void work.lifetime.then(() => { lifetimeFinished = true; });
    try {
      const response = await Promise.race([
        work.response,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
      ]);
      expect(response, 'respondWith must not wait for terrain EOF').not.toBeNull();
      expect(response!.headers.get('etag')).toBe('"terrain"');
      expect(new TextDecoder().decode((await response!.body!.getReader().read()).value)).toBe('012');
      expect(lifetimeFinished).toBe(false);
      expect(await pack.match(key)).toBeUndefined();
      const port = { postMessage: vi.fn() };
      let flush!: Promise<unknown>;
      h.listeners.get('message')!({
        data: { type: 'asset-pack-inventory-flush', build: currentBuild }, ports: [port],
        waitUntil: (value: Promise<unknown>) => { flush = value; },
      });
      await Promise.resolve();
      expect(port.postMessage).not.toHaveBeenCalled();
      controller.enqueue(new TextEncoder().encode(body.slice(3)));
      controller.close();
      await work.lifetime;
      await flush;
      expect(port.postMessage).toHaveBeenCalledWith({ type: 'asset-pack-inventory-ready', build: currentBuild });
      expect(await pack.match(key).then((r) => r?.text())).toBe(body);
    } finally {
      try { controller.close(); } catch { /* already closed */ }
      await work.lifetime;
    }
  });

  it.each([currentBuild, previousBuild].flatMap(build => [path, '/atlas/fantasy/globe/generated/solana-detail.png'].map(terrainPath => [build, terrainPath] as const)))('forwards immutable generation %s %s and range validators without caching 206', async (build, terrainPath) => {
    const { h, request, pack, key } = await terrain(build, terrainPath);
    const abort = new AbortController();
    const ranged = new Request(request, {
      signal: abort.signal,
      headers: { ...Object.fromEntries(request.headers), range: 'bytes=3-', 'if-range': '"terrain"' },
    });
    h.fetchMock.mockResolvedValueOnce(new Response(body.slice(3), {
      status: 206, headers: { 'content-range': 'bytes 3-9/10', etag: '"terrain"' },
    }));
    const response = await dispatchFetch(h.listeners, ranged);
    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe(body.slice(3));
    const sent = h.fetchMock.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(request.url);
    expect(sent.headers.get('range')).toBe('bytes=3-');
    expect(sent.headers.get('if-range')).toBe('"terrain"');
    expect(sent.cache).toBe('reload');
    expect(sent.redirect).toBe('error');
    abort.abort();
    expect(sent.signal.aborted).toBe(true);
    expect(await pack.match(key)).toBeUndefined();
    expect(h.digest).not.toHaveBeenCalled();
  });

  it.each([currentBuild, previousBuild].flatMap((build) => ['content', 'shell'].map((kind) => [build, kind] as const)))(
    'returns complete verified %s %s offline bytes so a resumed prefix is safely reset', async (build, kind) => {
      const { h, file, pack, request, key } = await terrain(build);
      const cache = kind === 'content' ? pack : await h.caches.open(`pkw-shell-${build}`);
      await cache.put(kind === 'content' ? key : request.url, new Response(body, {
        headers: { 'x-pkw-sha256': file.sha256, 'x-pkw-bytes': String(file.bytes) },
      }));
      h.fetchMock.mockRejectedValue(new Error('offline'));
      const response = await dispatchFetch(h.listeners, new Request(request, {
        headers: { ...Object.fromEntries(request.headers), range: 'bytes=3-', 'if-range': '"old-etag"' },
      }));
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe(body);
      expect(response?.headers.has('content-range')).toBe(false);
      expect(h.fetchMock).not.toHaveBeenCalled();
      expect(h.digest).toHaveBeenCalledTimes(1);
    },
  );

  it.each([path, '/atlas/fantasy/globe/generated/heartlands-detail.png', `/atlas/fantasy/layered-ground/assets/${sha(body)}.webp`])('evicts corrupt cached %s, then retains only the verified streamed replacement', async (terrainPath) => {
    const { h, file, request, pack, key } = await terrain(previousBuild, terrainPath);
    await pack.put(key, new Response('abcdefghij', {
      headers: { 'x-pkw-sha256': file.sha256, 'x-pkw-bytes': String(file.bytes) },
    }));
    h.fetchMock.mockResolvedValueOnce(new Response(body));
    expect(await dispatchFetch(h.listeners, request).then((r) => r?.text())).toBe(body);
    expect(pack.deletes).toContain(key);
    expect(await pack.match(key).then((r) => r?.text())).toBe(body);
  });

  it.each(['wrong header', 'missing build', 'missing pointer', 'unlisted', 'nonterrain', 'installer', 'pack query', 'duplicate build', 'unlisted globe', 'nested globe', 'nonpng globe', 'layered hash mismatch', 'layered unhashed manifest', 'layered nested texture', 'unlisted layered'])(
    'does not let marked %s requests escape generation authorization', async (reason) => {
      const { h, file, pack, pointer, request } = await terrain();
      let target = new URL(request.url);
      const headers = new Headers(request.headers);
      if (reason === 'wrong header') headers.set('x-pkw-ground-stream', previousBuild);
      if (reason === 'missing build') target.search = '';
      if (reason === 'missing pointer') await pack.delete(pointer);
      if (reason === 'unlisted') target.pathname = '/atlas/fantasy/ground-v2/unknown.png';
      if (reason === 'nonterrain') {
        target.pathname = '/atlas/family.png';
        await pack.put(pointer, new Response(JSON.stringify({ schema: 2, build: currentBuild, files: [{ ...file, path: target.pathname }] })));
      }
      if (reason === 'unlisted globe') target.pathname = '/atlas/fantasy/globe/generated/unapproved.png';
      if (reason === 'nested globe' || reason === 'nonpng globe') {
        target.pathname = reason === 'nested globe' ? '/atlas/fantasy/globe/generated/nested/file.png' : '/atlas/fantasy/globe/realm-mask.json';
        await pack.put(pointer, new Response(JSON.stringify({ schema: 2, build: currentBuild, files: [{ ...file, path: target.pathname }] })));
      }
      if (reason === 'unlisted layered') target.pathname = `/atlas/fantasy/layered-ground/assets/${sha(body)}.webp`;
      if (reason.startsWith('layered ')) {
        target.pathname = reason === 'layered hash mismatch' ? `/atlas/fantasy/layered-ground/assets/${'c'.repeat(64)}.png`
          : reason === 'layered nested texture' ? `/atlas/fantasy/layered-ground/assets/nested/${sha(body)}.png`
            : '/atlas/fantasy/layered-ground/manifest.json';
        await pack.put(pointer, new Response(JSON.stringify({ schema: 2, build: currentBuild, files: [{ ...file, path: target.pathname,
          contentType: target.pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'image/png' }] })));
      }
      if (reason === 'installer') headers.set('x-pkw-pack-download', currentBuild);
      if (reason === 'pack query') target.searchParams.set('pack', '1');
      if (reason === 'duplicate build') target.searchParams.append('v', currentBuild);
      expect((await dispatchFetch(h.listeners, new Request(target, { headers })))?.status).toBe(503);
      expect(h.fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['truncated', 'oversized', 'wrong hash', 'aborted'])(
    'never stores a %s full response as an offline object', async (reason) => {
      const { h, pack, request, key } = await terrain();
      const abort = new AbortController();
      const data = reason === 'truncated' ? body.slice(1) : reason === 'oversized' ? body + 'extra' : reason === 'wrong hash' ? 'abcdefghij' : body;
      h.fetchMock.mockResolvedValueOnce(new Response(data));
      if (reason === 'aborted') abort.abort();
      const work = dispatch(h, new Request(request, { signal: abort.signal }));
      await work.response;
      await work.lifetime;
      expect(await pack.match(key)).toBeUndefined();
    },
  );

  it.each([path, `/atlas/fantasy/layered-ground/${sha(body)}/manifest.json`, `/atlas/fantasy/layered-ground/assets/${sha(body)}.webp`])('cancels the cache reader for %s on abort during a stalled body and drops bytes before hashing', async (terrainPath) => {
    const { h, pack, request, key } = await terrain(currentBuild, terrainPath);
    const abort = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    h.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; controller.enqueue(new TextEncoder().encode('012')); },
    })));
    const work = dispatch(h, new Request(request, { signal: abort.signal }));
    try {
      const response = await work.response;
      const reader = response.body!.getReader();
      await reader.read();
      abort.abort();
      await work.lifetime;
      expect(await pack.match(key)).toBeUndefined();
      expect(h.digest).not.toHaveBeenCalled();
      void reader.cancel();
    } finally { try { controller.close(); } catch { /* cancelled */ } }
  });

  it('does not publish after cancellation while digest verification is pending', async () => {
    const { h, pack, request, key } = await terrain();
    const abort = new AbortController();
    let finish!: (value: ArrayBuffer) => void;
    h.digest.mockImplementationOnce(() => new Promise<ArrayBuffer>((resolve) => { finish = resolve; }));
    h.fetchMock.mockResolvedValueOnce(new Response(body));
    const work = dispatch(h, new Request(request, { signal: abort.signal }));
    await work.response;
    await vi.waitFor(() => expect(finish).toBeDefined());
    abort.abort();
    finish(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    await work.lifetime;
    expect(await pack.match(key)).toBeUndefined();
  });

  it('releases the cache branch at the manifest byte cap without waiting for an oversized body EOF', async () => {
    const { h, pack, request, key } = await terrain();
    const cancel = vi.fn();
    h.fetchMock.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(body + 'overflow')); },
      cancel,
    })));
    const work = dispatch(h, request);
    const response = await work.response;
    await work.lifetime;
    expect(await pack.match(key)).toBeUndefined();
    expect(h.digest).not.toHaveBeenCalled();
    // A tee cancels its source once both consumers stop, not when only the
    // cache branch rejects. The page remains responsible for its own limit.
    await response.body!.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

// D-101 Web Push. The payload contract `{ kind, title, body, tag, url }` is the
// server's (apps/api notifications); these pin what the worker does with it.
describe('service-worker push contract', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function dispatchWorkerMessage(
    h: ReturnType<typeof harness>,
    type: string,
    fenceNonce = 'test-fence',
  ): Promise<unknown> {
    let work: Promise<unknown> | undefined;
    h.listeners.get('message')!({
      data: { type, fenceNonce },
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    return work ?? Promise.resolve();
  }

  async function seedActivePushSession(
    h: ReturnType<typeof harness>,
    fenceNonce = 'active-fence',
  ): Promise<void> {
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response(fenceNonce));
    await state.put(
      `${ORIGIN}/_pkw-push/session-resumed?fence=${encodeURIComponent(fenceNonce)}`,
      new Response(fenceNonce),
    );
  }

  function pushEvent(payload: unknown) {
    let work: Promise<unknown> | undefined;
    return {
      event: {
        data: payload === undefined ? null : { json: () => payload },
        waitUntil: (value: Promise<unknown>) => { work = value; },
      },
      done: () => work,
    };
  }

  it.each([
    ['raided', '/?screen=raidlog', true],
    ['mine_full', '/?screen=bases', false],
    ['build', '/?screen=base', false],
    ['training', '/?screen=base', false],
    ['mail', '/?screen=mail', false],
  ])('shows a %s push with the mapped options and an unversioned icon', async (kind, url, renotify) => {
    const h = harness();
    await seedActivePushSession(h);
    const { event, done } = pushEvent({ kind, title: `T ${kind}`, body: `B ${kind}`, tag: `pkw-${kind}-1`, url });
    h.listeners.get('push')!(event);
    await done();
    expect(h.self.registration.showNotification).toHaveBeenCalledWith(`T ${kind}`, {
      body: `B ${kind}`,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `pkw-${kind}-1`,
      renotify,
      data: { url, kind, pushSessionGeneration: 0 },
    });
  });

  it('tells an open page about a mail push so its unread badge can refresh', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const win = { url: `${ORIGIN}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    h.windows.push(win);
    const pushed = pushEvent({ kind: 'mail', title: 'NEW MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(pushed.event);
    await pushed.done();
    expect(win.postMessage).toHaveBeenCalledWith({ type: 'notification-received', kind: 'mail' });
  });

  it('never displays a prior wallet push after OFF or auth-session suspension', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response('1'));
    const pushed = pushEvent({
      kind: 'raided', title: 'YOUR BASE WAS RAIDED', body: 'Private outcome', url: '/?screen=raidlog',
    });

    h.listeners.get('push')!(pushed.event);
    await pushed.done();

    expect(h.self.registration.showNotification).not.toHaveBeenCalled();
    expect(h.self.clients.matchAll).not.toHaveBeenCalled();
  });

  it('persists a second worker-side fence when the page marker write failed', async () => {
    const h = harness();
    await dispatchWorkerMessage(h, 'push-session-suspended', 'cache-write-failed');
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    expect(await state.match(`${ORIGIN}/_pkw-push/session-suspended`).then((r) => r?.text()))
      .toBe('cache-write-failed');
    const pushed = pushEvent({
      kind: 'mail', title: 'PRIVATE MAIL', body: 'Prior wallet content', url: '/?screen=mail',
    });

    h.listeners.get('push')!(pushed.event);
    await pushed.done();

    expect(h.self.registration.showNotification).not.toHaveBeenCalled();
    expect(h.self.clients.matchAll).not.toHaveBeenCalled();
  });

  it('invalidates the old ACK before a failed replacement put, so a restart stays suspended', async () => {
    const stores = new Map<string, SwCache>();
    const h = harness('old-worker', '', stores);
    await seedActivePushSession(h, 'old-active');
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const oldAck = `${ORIGIN}/_pkw-push/session-resumed?fence=old-active`;
    state.putError = new Error('cache quota');
    await dispatchWorkerMessage(h, 'push-session-suspended', 'cache-unavailable');
    expect(await state.match(`${ORIGIN}/_pkw-push/session-suspended`).then((r) => r?.text()))
      .toBe('old-active');
    expect(await state.match(oldAck)).toBeUndefined();
    const pushed = pushEvent({
      kind: 'mail', title: 'PRIVATE MAIL', body: 'Prior wallet content', url: '/?screen=mail',
    });

    h.listeners.get('push')!(pushed.event);
    await pushed.done();

    expect(h.self.registration.showNotification).not.toHaveBeenCalled();
    expect(h.self.clients.matchAll).not.toHaveBeenCalled();

    // Worker memory is gone here. Only the shared Cache remains, with the old
    // marker deliberately left unacknowledged by the failed two-phase write.
    const restarted = harness('restarted-worker', '', stores);
    const afterRestart = pushEvent({
      kind: 'mail', title: 'PRIVATE MAIL', body: 'Prior wallet content', url: '/?screen=mail',
    });
    restarted.listeners.get('push')!(afterRestart.event);
    await afterRestart.done();
    expect(restarted.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it('treats a missing durable marker as suspended after a worker restart', async () => {
    const h = harness('empty-restart');
    const pushed = pushEvent({
      kind: 'mail', title: 'PRIVATE MAIL', body: 'Prior wallet content', url: '/?screen=mail',
    });
    h.listeners.get('push')!(pushed.event);
    await pushed.done();
    expect(h.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it('removes a push whose show crosses the synchronous logout/OFF generation', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const shown = {
      data: { pushSessionGeneration: 0 },
      close: vi.fn(),
    };
    const show = deferred<undefined>();
    h.self.registration.showNotification.mockImplementationOnce(async () => show.promise);
    // Suspension cleanup runs while showNotification is pending and sees
    // nothing; the push event's post-show generation check must close it.
    h.self.registration.getNotifications
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([shown]);
    const pushed = pushEvent({
      kind: 'raided', title: 'YOUR BASE WAS RAIDED', body: 'Private outcome',
      tag: 'raided', url: '/?screen=raidlog',
    });

    h.listeners.get('push')!(pushed.event);
    await vi.waitFor(() => expect(h.self.registration.showNotification).toHaveBeenCalledOnce());
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response('1'));
    await dispatchWorkerMessage(h, 'push-session-suspended');
    expect(h.self.registration.getNotifications).toHaveBeenCalledOnce();
    show.resolve(undefined);
    await pushed.done();

    expect(shown.close).toHaveBeenCalledOnce();
    expect(h.self.clients.matchAll).not.toHaveBeenCalled();
  });

  it('closes every visible notification after the durable OFF/logout fence lands', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response('1'));
    const notifications = [
      { close: vi.fn() },
      { close: vi.fn() },
      { close: vi.fn() },
    ];
    h.self.registration.getNotifications.mockResolvedValue(notifications);
    let work: Promise<unknown> | undefined;

    h.listeners.get('message')!({
      data: { type: 'push-session-suspended', fenceNonce: 'closed' },
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await work;

    expect(h.self.registration.getNotifications).toHaveBeenCalledOnce();
    for (const notification of notifications) expect(notification.close).toHaveBeenCalledOnce();
  });

  it('keeps resume fenced until delayed prior-wallet shade cleanup finishes', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    const resumedMarker = `${ORIGIN}/_pkw-push/session-resumed?fence=new-wallet-fence`;
    await state.put(marker, new Response('new-wallet-fence'));
    const oldShade = { close: vi.fn() };
    const cleanup = deferred<Array<typeof oldShade>>();
    h.self.registration.getNotifications.mockImplementationOnce(async () => cleanup.promise);

    const suspended = dispatchWorkerMessage(h, 'push-session-suspended', 'new-wallet-fence');
    await vi.waitFor(() => expect(h.self.registration.getNotifications).toHaveBeenCalledOnce());
    const resumed = dispatchWorkerMessage(h, 'push-session-resumed', 'new-wallet-fence');
    const crossing = pushEvent({ kind: 'mail', title: 'NEW WALLET MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(crossing.event);
    await crossing.done();
    expect(h.self.registration.showNotification).not.toHaveBeenCalled();
    expect(await state.match(resumedMarker)).toBeUndefined();

    cleanup.resolve([oldShade]);
    await Promise.all([suspended, resumed]);
    expect(oldShade.close).toHaveBeenCalledOnce();
    expect(await state.match(resumedMarker).then((r) => r?.text())).toBe('new-wallet-fence');
    const afterCleanup = pushEvent({ kind: 'mail', title: 'NEW WALLET MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(afterCleanup.event);
    await afterCleanup.done();
    expect(h.self.registration.showNotification).toHaveBeenCalledOnce();
    expect(h.self.registration.getNotifications).toHaveBeenCalledTimes(2);
  });

  it.each(['unsupported', 'rejected'])('keeps the durable fence when shade cleanup is %s', async (mode) => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    await state.put(marker, new Response('1'));
    if (mode === 'unsupported') {
      Object.assign(h.self.registration, { getNotifications: undefined });
    } else {
      h.self.registration.getNotifications.mockRejectedValue(new Error('platform unavailable'));
    }
    let work: Promise<unknown> | undefined;

    h.listeners.get('message')!({
      data: { type: 'push-session-suspended', fenceNonce: 'closed' },
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });

    await expect(work).resolves.toBeUndefined();
    expect(await state.match(marker)).toBeDefined();
  });

  it('does not acknowledge resume when any prior-wallet shade entry could not be closed', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    const ack = `${ORIGIN}/_pkw-push/session-resumed?fence=close-failed`;
    await state.put(marker, new Response('close-failed'));
    h.self.registration.getNotifications.mockResolvedValueOnce([{
      close: () => { throw new Error('platform refused close'); },
    }]);

    await dispatchWorkerMessage(h, 'push-session-resumed', 'close-failed');

    expect(await state.match(ack)).toBeUndefined();
    const pushed = pushEvent({ kind: 'mail', title: 'PRIVATE MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(pushed.event);
    await pushed.done();
    expect(h.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it('keeps a restarted worker fail-closed until durable resume matches the suspension generation', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    await state.put(marker, new Response('1'));

    // A stale tab may send resume after another tab logged out. Worker memory
    // starts fresh, so the Cache Storage marker must remain authoritative.
    await dispatchWorkerMessage(h, 'push-session-resumed', 'stale-fence');
    const fenced = pushEvent({ kind: 'mail', title: 'PRIVATE MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(fenced.event);
    await fenced.done();
    expect(h.self.registration.showNotification).not.toHaveBeenCalled();

    await dispatchWorkerMessage(h, 'push-session-resumed', '1');
    expect(await state.match(`${ORIGIN}/_pkw-push/session-resumed?fence=1`).then((r) => r?.text()))
      .toBe('1');
    const resumed = pushEvent({ kind: 'mail', title: 'NEW MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(resumed.event);
    await resumed.done();
    expect(h.self.registration.showNotification).toHaveBeenCalledOnce();
  });

  it('lets only a restarted worker acknowledge activation after it repeats shade cleanup', async () => {
    const stores = new Map<string, SwCache>();
    const oldWorker = harness('old-worker', '', stores);
    const state = await oldWorker.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    const resumedMarker = `${ORIGIN}/_pkw-push/session-resumed?fence=restart-fence`;
    const interruptedCleanup = deferred<Array<{ close: () => void }>>();
    oldWorker.self.registration.getNotifications
      .mockImplementationOnce(async () => interruptedCleanup.promise);

    // The first worker persists the fence but disappears before proving that
    // it cleared the prior wallet's notification shade.
    void dispatchWorkerMessage(oldWorker, 'push-session-suspended', 'restart-fence');
    await vi.waitFor(async () => {
      expect(await state.match(marker).then((r) => r?.text())).toBe('restart-fence');
    });
    expect(await state.match(resumedMarker)).toBeUndefined();

    const restarted = harness('restarted-worker', '', stores);
    const oldShade = { close: vi.fn() };
    const restartedCleanup = deferred<Array<typeof oldShade>>();
    restarted.self.registration.getNotifications
      .mockImplementationOnce(async () => restartedCleanup.promise);
    const resume = dispatchWorkerMessage(restarted, 'push-session-resumed', 'restart-fence');
    await vi.waitFor(() => expect(restarted.self.registration.getNotifications).toHaveBeenCalledOnce());

    const crossing = pushEvent({ kind: 'mail', title: 'PRIVATE MAIL', url: '/?screen=mail' });
    restarted.listeners.get('push')!(crossing.event);
    await crossing.done();
    expect(restarted.self.registration.showNotification).not.toHaveBeenCalled();
    expect(await state.match(resumedMarker)).toBeUndefined();

    restartedCleanup.resolve([oldShade]);
    await resume;
    expect(oldShade.close).toHaveBeenCalledOnce();
    expect(await state.match(resumedMarker).then((r) => r?.text())).toBe('restart-fence');

    const afterCleanup = pushEvent({ kind: 'mail', title: 'NEW WALLET MAIL', url: '/?screen=mail' });
    restarted.listeners.get('push')!(afterCleanup.event);
    await afterCleanup.done();
    expect(restarted.self.registration.showNotification).toHaveBeenCalledOnce();
  });

  it('garbage-collects prior activation acknowledgements after a successful resume', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    const currentFence = 'current-fence';
    await state.put(marker, new Response(currentFence));
    for (let index = 0; index < 12; index += 1) {
      await state.put(
        `${ORIGIN}/_pkw-push/session-resumed?fence=old-${index}`,
        new Response(`old-${index}`),
      );
    }

    await dispatchWorkerMessage(h, 'push-session-resumed', currentFence);

    const ackUrls = [...state.entries.keys()].filter((entry) => (
      new URL(entry).pathname === '/_pkw-push/session-resumed'
    ));
    expect(ackUrls).toEqual([
      `${ORIGIN}/_pkw-push/session-resumed?fence=${currentFence}`,
    ]);
  });

  it('never deletes a newer acknowledgement that appears after stale-ack GC starts', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    const oldAck = `${ORIGIN}/_pkw-push/session-resumed?fence=old-fence`;
    const newerAck = `${ORIGIN}/_pkw-push/session-resumed?fence=newer-fence`;
    await state.put(marker, new Response('stale-resume'));
    await state.put(oldAck, new Response('old-fence'));
    const deleting = deferred<void>();
    state.deleteBarrier = deleting.promise;

    const staleResume = dispatchWorkerMessage(h, 'push-session-resumed', 'stale-resume');
    await vi.waitFor(() => expect(state.deletes).toContain(oldAck));
    // Another worker generation commits after this generation's immutable
    // deletion snapshot. The pending GC may remove only the snapshotted key.
    await state.put(marker, new Response('newer-fence'));
    await state.put(newerAck, new Response('newer-fence'));
    deleting.resolve();
    await staleResume;

    expect(await state.match(newerAck).then((r) => r?.text())).toBe('newer-fence');
    expect(await state.match(`${ORIGIN}/_pkw-push/session-resumed?fence=stale-resume`))
      .toBeUndefined();
  });

  it('rejects a stale resume while a newer live suspension is still being persisted', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    const oldResumedMarker = `${ORIGIN}/_pkw-push/session-resumed?fence=old-fence`;
    const newResumedMarker = `${ORIGIN}/_pkw-push/session-resumed?fence=new-fence`;
    await state.put(marker, new Response('old-fence'));
    await state.put(oldResumedMarker, new Response('old-fence'));
    const persistNewFence = deferred<void>();
    state.putBarrier = persistNewFence.promise;

    // Suspension is deliberately posted before its durable Cache write. The
    // old marker/ack pair still looks active, but worker memory already owns
    // the newer nonce and must independently reject the stale resume.
    const suspended = dispatchWorkerMessage(h, 'push-session-suspended', 'new-fence');
    await vi.waitFor(() => expect(state.puts).toContain(marker));
    expect(await state.match(marker).then((r) => r?.text())).toBe('old-fence');
    const staleResume = dispatchWorkerMessage(h, 'push-session-resumed', 'old-fence');
    const crossing = pushEvent({ kind: 'mail', title: 'PRIVATE MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(crossing.event);
    await crossing.done();
    expect(h.self.registration.showNotification).not.toHaveBeenCalled();

    persistNewFence.resolve();
    await Promise.all([suspended, staleResume]);
    expect(await state.match(marker).then((r) => r?.text())).toBe('new-fence');
    await dispatchWorkerMessage(h, 'push-session-resumed', 'new-fence');
    expect(await state.match(newResumedMarker).then((r) => r?.text())).toBe('new-fence');
    const recovered = pushEvent({ kind: 'mail', title: 'NEW MAIL', url: '/?screen=mail' });
    h.listeners.get('push')!(recovered.event);
    await recovered.done();
    expect(h.self.registration.showNotification).toHaveBeenCalledOnce();
  });

  it('still shows a generic notification for a data-less or malformed push', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const bare = pushEvent(undefined);
    h.listeners.get('push')!(bare.event);
    await bare.done();
    expect(h.self.registration.showNotification).toHaveBeenLastCalledWith('Pixel Kingdom Wars', expect.objectContaining({
      tag: 'pkw-generic', renotify: false,
      data: { url: '/', kind: 'generic', pushSessionGeneration: 0 },
    }));
    // Neither an absolute origin nor URL's backslash-normalisation edge may
    // become the click target.
    for (const url of ['https://evil.example/', '/\\evil.example/?screen=mail']) {
      const hostile = pushEvent({ kind: 'mail', url, title: 'x' });
      h.listeners.get('push')!(hostile.event);
      await hostile.done();
      expect(h.self.registration.showNotification).toHaveBeenLastCalledWith('x', expect.objectContaining({
        data: { url: '/', kind: 'mail', pushSessionGeneration: 0 },
      }));
    }
  });

  function clickEvent(url: string) {
    let work: Promise<unknown> | undefined;
    const notification = { close: vi.fn(), data: { url } };
    return {
      event: { notification, waitUntil: (value: Promise<unknown>) => { work = value; } },
      notification,
      done: () => work,
    };
  }

  it('opens a new window at the push url when no game window exists', async () => {
    const h = harness();
    const { event, notification, done } = clickEvent('/?screen=raidlog');
    h.listeners.get('notificationclick')!(event);
    await done();
    expect(notification.close).toHaveBeenCalledOnce();
    expect(h.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(h.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/?screen=raidlog`);
  });

  it('focuses an existing window and hands it the screen instead of reloading it', async () => {
    const h = harness();
    const win = { url: `${ORIGIN}/`, focus: vi.fn(async () => undefined), postMessage: vi.fn() };
    h.windows.push(win);
    const { event, done } = clickEvent('/?screen=mail');
    h.listeners.get('notificationclick')!(event);
    await done();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.postMessage).toHaveBeenCalledWith({ type: 'open-screen', screen: 'mail' });
    expect(h.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('revalidates stored notification data at click time and never opens another origin', async () => {
    const h = harness();
    const { event, done } = clickEvent('/\\evil.example/?screen=mail');
    h.listeners.get('notificationclick')!(event);
    await done();
    expect(h.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  it('re-subscribes on pushsubscriptionchange and POSTs the replacement to the same-origin API', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const applicationServerKey = new Uint8Array([1, 2, 3]);
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: { endpoint: 'https://push.example/old', options: { applicationServerKey } },
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await work;
    expect(h.self.registration.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey });
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = h.fetchMock.mock.calls[0]!;
    expect(input).toBe('/api/notifications/subscribe');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({
      endpoint: 'https://push.example/new',
      keys: { p256dh: 'P', auth: 'A' },
      previousEndpoint: 'https://push.example/old',
      userAgent: 'test-agent',
    });
  });

  it('unsubscribes and retires a replacement when OFF lands during subscribe', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const replacement = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/crossed-subscribe',
      unsubscribe: vi.fn(async () => true),
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/crossed-subscribe',
        keys: { p256dh: 'P', auth: 'A' },
      }),
    };
    const subscribe = deferred<typeof replacement>();
    h.self.registration.pushManager.subscribe.mockImplementationOnce(async () => subscribe.promise);
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/old',
        options: { applicationServerKey: new Uint8Array([1, 2, 3]) },
      },
      newSubscription: null,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await vi.waitFor(() => expect(h.self.registration.pushManager.subscribe).toHaveBeenCalledOnce());
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response('1'));
    await dispatchWorkerMessage(h, 'push-session-suspended');
    subscribe.resolve(replacement);
    await work;

    expect(replacement.unsubscribe).toHaveBeenCalledOnce();
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.fetchMock).toHaveBeenCalledWith('/api/notifications/subscribe', expect.objectContaining({
      method: 'DELETE', cache: 'no-store', credentials: 'include',
      body: JSON.stringify({ endpoint: replacement.endpoint }),
    }));
  });

  it('compensates a rotation POST when OFF lands while the request is pending', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const replacement = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/crossed-post',
      unsubscribe: vi.fn(async () => true),
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/crossed-post',
        keys: { p256dh: 'P', auth: 'A' },
      }),
    };
    const post = deferred<Response>();
    h.fetchMock.mockImplementation(async (_input, init) => (
      init?.method === 'POST' ? post.promise : new Response(null, { status: 204 })
    ));
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: null,
      newSubscription: replacement,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledWith(
      '/api/notifications/subscribe', expect.objectContaining({ method: 'POST' }),
    ));
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response('1'));
    const suspended = dispatchWorkerMessage(h, 'push-session-suspended');
    post.resolve(new Response(null, { status: 204 }));
    await Promise.all([work, suspended]);

    expect(replacement.unsubscribe).toHaveBeenCalledOnce();
    expect(h.fetchMock).toHaveBeenCalledWith('/api/notifications/subscribe', expect.objectContaining({
      method: 'DELETE', credentials: 'include',
      body: JSON.stringify({ endpoint: replacement.endpoint }),
    }));
  });

  it('compensates when logout/OFF is messaged immediately after a successful rotation POST', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const replacement = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/after-post',
      unsubscribe: vi.fn(async () => true),
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/after-post',
        keys: { p256dh: 'P', auth: 'A' },
      }),
    };
    const post = deferred<Response>();
    h.fetchMock.mockImplementation(async (_input, init) => (
      init?.method === 'POST' ? post.promise : new Response(null, { status: 204 })
    ));
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: null,
      newSubscription: replacement,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledWith(
      '/api/notifications/subscribe', expect.objectContaining({ method: 'POST' }),
    ));
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response('1'));
    // Resolve first, then synchronously deliver the state message before the
    // rotation continuation can consume the successful response.
    post.resolve(new Response(null, { status: 204 }));
    const suspended = dispatchWorkerMessage(h, 'push-session-suspended');
    await Promise.all([work, suspended]);

    expect(replacement.unsubscribe).toHaveBeenCalledOnce();
    expect(h.fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']);
  });

  it.each(['returns false', 'rejects'])('keeps delivery durably fenced when a prior-wallet replacement unsubscribe %s', async (mode) => {
    const stores = new Map<string, SwCache>();
    const h = harness('rotation-worker', '', stores);
    await seedActivePushSession(h);
    const replacement = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/prior-wallet',
      unsubscribe: vi.fn(async () => {
        if (mode === 'rejects') throw new Error('push service offline');
        return false;
      }),
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/prior-wallet',
        keys: { p256dh: 'P', auth: 'A' },
      }),
    };
    const post = deferred<Response>();
    h.fetchMock.mockImplementation(async (_input, init) => (
      init?.method === 'POST'
        ? post.promise
        : Promise.reject(new Error('current wallet cannot retire prior wallet row'))
    ));
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: null,
      newSubscription: replacement,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledWith(
      '/api/notifications/subscribe', expect.objectContaining({ method: 'POST' }),
    ));

    // The server may still deliver prior-wallet bytes while ownership is
    // unresolved. The transaction fence must suppress them before the 409 is
    // known, even if neither browser nor API retirement will work afterward.
    const crossing = pushEvent({
      kind: 'mail', title: 'PRIOR WALLET MAIL', body: 'Private', url: '/?screen=mail',
    });
    h.listeners.get('push')!(crossing.event);
    await crossing.done();
    expect(h.self.registration.showNotification).not.toHaveBeenCalled();

    post.resolve(new Response(JSON.stringify({ code: 'PUSH_ENDPOINT_OWNED' }), { status: 409 }));
    await work;

    expect(replacement.unsubscribe).toHaveBeenCalledOnce();
    expect(h.fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']);
    expect(h.fetchMock).toHaveBeenLastCalledWith('/api/notifications/subscribe', expect.objectContaining({
      method: 'DELETE', cache: 'no-store', credentials: 'include',
      body: JSON.stringify({ endpoint: replacement.endpoint }),
    }));
    const state = stores.get('pkw-push-session-v1')!;
    const marker = await state.match(`${ORIGIN}/_pkw-push/session-suspended`);
    const fenceNonce = await marker?.text();
    expect(fenceNonce).toBeTruthy();
    expect(await state.match(
      `${ORIGIN}/_pkw-push/session-resumed?fence=${encodeURIComponent(fenceNonce!)}`,
    )).toBeUndefined();

    // A process restart cannot reopen the unresolved opaque capability.
    const restarted = harness('rotation-restarted', '', stores);
    const afterRestart = pushEvent({
      kind: 'mail', title: 'PRIOR WALLET MAIL', body: 'Private', url: '/?screen=mail',
    });
    restarted.listeners.get('push')!(afterRestart.event);
    await afterRestart.done();
    expect(restarted.self.registration.showNotification).not.toHaveBeenCalled();
  });

  it('uses a browser-supplied replacement without creating a second subscription', async () => {
    const h = harness();
    await seedActivePushSession(h);
    const next = {
      endpoint: 'https://push.example/browser-replacement',
      toJSON: () => ({
        endpoint: 'https://push.example/browser-replacement', keys: { p256dh: 'NP', auth: 'NA' },
      }),
    };
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: null,
      newSubscription: next,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await work;
    expect(h.self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(h.fetchMock).toHaveBeenCalledWith('/api/notifications/subscribe', expect.objectContaining({
      method: 'POST', credentials: 'include',
    }));
  });

  it('recovers the VAPID key from the API when the change event has no old subscription', async () => {
    const h = harness();
    await seedActivePushSession(h);
    h.fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: 'BAAA' })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: null,
      newSubscription: null,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await work;
    expect(h.fetchMock).toHaveBeenNthCalledWith(1, '/api/notifications/vapid', {
      cache: 'no-store', credentials: 'include',
    });
    const options = (h.self.registration.pushManager.subscribe.mock.calls as unknown[][])[0]![0] as {
      applicationServerKey: Uint8Array;
    };
    expect([...options.applicationServerKey]).toEqual([4, 0, 0]);
    expect(h.fetchMock).toHaveBeenNthCalledWith(2, '/api/notifications/subscribe', expect.objectContaining({
      method: 'POST', credentials: 'include',
    }));
  });

  it('never overwrites a cross-realm logout marker while fencing a rotation', async () => {
    const h = harness();
    await seedActivePushSession(h, 'active-before-logout');
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    const marker = `${ORIGIN}/_pkw-push/session-suspended`;
    const oldAck = `${ORIGIN}/_pkw-push/session-resumed?fence=active-before-logout`;
    const deleting = deferred<void>();
    state.deleteBarrier = deleting.promise;
    let work: Promise<unknown> | undefined;

    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: {
        endpoint: 'https://push.example/old',
        options: { applicationServerKey: new Uint8Array([1, 2, 3]) },
      },
      newSubscription: null,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await vi.waitFor(() => expect(state.deletes).toContain(oldAck));
    // Models another page whose live-worker message was lost: Cache Storage
    // alone must still be monotonic and win over this stale rotation.
    await state.put(marker, new Response('cross-realm-logout'));
    deleting.resolve();
    await work;

    expect(await state.match(marker).then((r) => r?.text())).toBe('cross-realm-logout');
    expect(h.self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('never resurrects a subscription while explicit OFF or auth-session suspension is durable', async () => {
    const h = harness();
    const state = await h.caches.open('pkw-push-session-v1') as unknown as SwCache;
    await state.put(`${ORIGIN}/_pkw-push/session-suspended`, new Response('1'));
    let work: Promise<unknown> | undefined;
    h.listeners.get('pushsubscriptionchange')!({
      oldSubscription: {
        endpoint: 'https://push.example/old',
        options: { applicationServerKey: new Uint8Array([1, 2, 3]) },
      },
      newSubscription: null,
      waitUntil: (value: Promise<unknown>) => { work = value; },
    });
    await work;
    expect(h.self.registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

it('loads a layered context through the real downloader and worker, then reopens from verified offline objects', async () => {
  const { EventEmitter } = await import('node:events');
  const { LayeredGround } = await import('../game/world/layeredGround');
  const catalogue = await import('@shardkeep/shared/layeredGroundCatalogue');
  const { BUILD } = await import('./version');
  const build = 'b'.repeat(40), originalBuild = BUILD.gitSha;
  const imageBytes = 'tile', imageHash = sha(imageBytes);
  const manifest = { schemaVersion: 1, groundRevision: 3, realmId: 'thornwake', status: 'accepted', tilePixels: 32,
    field: { x: -1088, y: -1088, width: 3136, height: 3136 }, protectedFrame: { x: -320, y: -320, width: 1600, height: 1600 },
    ground: { asset: 'ground', sampling: 'world' }, placements: [], assets: [{ id: 'ground',
      path: `atlas/fantasy/layered-ground/assets/${imageHash}.webp`, sha256: imageHash, size: imageBytes.length,
      width: 98, height: 98, frameWidth: 98, frameHeight: 98, frameCount: 1, frameDurationMs: 100,
      anchor: { x: 0, y: 0 }, reducedMotionFrame: 0 }] };
  const manifestBody = JSON.stringify(manifest), manifestHash = sha(manifestBody);
  const manifestPath = `atlas/fantasy/layered-ground/${manifestHash}/manifest.json`;
  const descriptor = vi.spyOn(catalogue, 'layeredGroundDescriptor').mockReturnValue({ realmId: 'thornwake',
    manifestPath, sha256: manifestHash, size: manifestBody.length });
  const bodies = new Map([['/' + manifestPath, manifestBody], ['/' + manifest.assets[0]!.path, imageBytes]]);
  const h = harness(build), pack = await h.caches.open('pkw-asset-pack-v1');
  const files = [...bodies].map(([path, body]) => ({ path, bytes: body.length, sha256: sha(body), tier: 'full',
    contentType: path.endsWith('.json') ? 'application/json; charset=utf-8' : 'image/webp' }));
  await pack.put('/_pkw-pack/deployment-current.json', new Response(JSON.stringify({ schema: 2, build, files })));
  const requests: Request[] = [];
  Object.assign(BUILD, { gitSha: build });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal('Image', class { naturalWidth = 98; naturalHeight = 98; decode = async () => {}; });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const request = new Request(new URL(input, ORIGIN), init); requests.push(request);
    return dispatchFetch(h.listeners, request);
  });
  h.fetchMock.mockImplementation(async input => {
    const body = bodies.get(new URL(url(input!)).pathname);
    return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
  });
  const host = { events: new EventEmitter(), textures: { addSpriteSheet: vi.fn(), remove: vi.fn() } };
  // The frozen context names its layered revision; a manifest of any other revision is refused.
  const layeredContext = { version: 1, realmId: 'thornwake', artVersion: 2, groundRevision: 3 } as const;
  try {
    const cold = await LayeredGround.prepareContext(host as never, layeredContext, 64, new AbortController().signal);
    cold.destroy();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    for (const file of files) expect(await pack.match(`${ORIGIN}/_pkw-pack/content/${file.sha256}`)).toBeDefined();
    h.fetchMock.mockRejectedValue(new TypeError('offline'));
    const warm = await LayeredGround.prepareContext(host as never, layeredContext, 64, new AbortController().signal);
    warm.destroy();
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      expect(new URL(request.url).search).toBe(`?v=${build}`);
      expect(request.headers.get('x-pkw-ground-stream')).toBe(build);
    }
    expect(host.textures.addSpriteSheet).toHaveBeenCalledTimes(2);
  } finally {
    Object.assign(BUILD, { gitSha: originalBuild }); descriptor.mockRestore(); vi.unstubAllGlobals();
  }
});

describe('world v2 pack (outside the inventory, on demand)', () => {
  // emit-asset-pack skips /atlas/world-v2/, so the deployment inventory never lists these files. sw.js is unchanged
  // for them: it must still serve them, and only the plain URL worldPackUrl() builds may reach them.
  const build = 'c'.repeat(40), previous = 'd'.repeat(40);
  const worldPath = '/atlas/world-v2/pm1-cb8faa56909faa31/globe-v2/a1024-0.webp';

  async function worldHarness() {
    const h = harness(build);
    const pack = await h.caches.open('pkw-asset-pack-v1') as unknown as SwCache;
    const listed = { path: '/atlas/meta.json', bytes: 2, sha256: sha('{}'), contentType: 'application/json; charset=utf-8', tier: 'core' };
    await pack.put(`${ORIGIN}/_pkw-pack/deployment-current.json`, new Response(JSON.stringify({ schema: 2, build, files: [listed] })));
    return { h, pack };
  }
  const basic = (body: string) => {
    const res = new Response(body, { headers: { 'content-type': 'image/webp' } });
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };

  it('serves the plain pack URL from the network once, then from the build cache, never as a pack object', async () => {
    const { h, pack } = await worldHarness();
    expect(WORLD_V2_PACK_ROOT + 'globe-v2/a1024-0.webp').toBe(worldPath);
    h.fetchMock.mockResolvedValueOnce(basic('globe face'));
    const first = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${worldPath}`));
    expect(first?.status).toBe(200);
    expect(await first?.text()).toBe('globe face');
    const second = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${worldPath}`));
    expect(await second?.text()).toBe('globe face');
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.stores.get(`pkw-shell-${build}`)?.entries.has(`${ORIGIN}${worldPath}`)).toBe(true);
    expect([...pack.entries.keys()].some(key => key.includes('/_pkw-pack/content/'))).toBe(false);
  });

  it('reports a pack file sent with x-pkw-ground-stream unavailable, so the world loader must never send it', async () => {
    const { h } = await worldHarness();
    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${worldPath}?v=${build}`, {
      headers: { 'x-pkw-ground-stream': build },
    }));
    expect(response?.status).toBe(503);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a build-versioned pack URL from an earlier build, which is why worldPackUrl adds no ?v', async () => {
    const { h } = await worldHarness();
    const response = await dispatchFetch(h.listeners, new Request(`${ORIGIN}${worldPath}?v=${previous}`));
    expect(response?.status).toBe(503);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});
