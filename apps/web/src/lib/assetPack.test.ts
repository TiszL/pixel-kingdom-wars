import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ASSET_PACK_CACHE, ASSET_PACK_DOWNLOAD_HEADER, AssetPackError, ensureAssetPack, isSolanaMobileAssetPackClient,
  validateAssetPackManifest, type AssetPackManifest,
} from './assetPack';

const ORIGIN = 'https://play.pixelkingdomwars.com';

function sha(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function mime(path: string): string {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  throw new Error(`test MIME missing: ${path}`);
}

function manifest(
  build: string,
  bodies: Record<string, string>,
  tiers: Partial<Record<string, 'core' | 'full'>> = {},
): AssetPackManifest {
  const files = Object.entries(bodies).map(([path, body]) => ({
    path, bytes: new TextEncoder().encode(body).byteLength, sha256: sha(body), contentType: mime(path),
    tier: tiers[path] ?? 'core' as const,
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const unique = new Map(files.map((file) => [file.sha256, file.bytes]));
  return { schema: 2, build, totalBytes: [...unique.values()].reduce((sum, bytes) => sum + bytes, 0), files };
}

function key(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return new URL(String(input), ORIGIN).href;
}

class MemoryCache {
  readonly entries = new Map<string, Response>();
  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(key(input))?.clone();
  }
  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(key(input), response.clone());
  }
  async delete(input: RequestInfo | URL): Promise<boolean> { return this.entries.delete(key(input)); }
  async keys(): Promise<Request[]> { return [...this.entries.keys()].map((url) => new Request(url)); }
}

class MemoryCaches {
  readonly cache = new MemoryCache();
  async open(name: string): Promise<Cache> {
    expect(name).toBe(ASSET_PACK_CACHE);
    return this.cache as unknown as Cache;
  }
}

function controllerFor(build: string): ServiceWorker {
  return {
    scriptURL: `${ORIGIN}/sw.js?v=${build}`,
    postMessage: vi.fn((message: unknown, transfer?: Transferable[]) => {
      const payload = message as { type?: string; build?: string };
      if (payload.type === 'asset-pack-inventory-flush') {
        (transfer?.[0] as MessagePort | undefined)?.postMessage({
          type: 'asset-pack-inventory-ready', build: payload.build,
        });
      }
      if (payload.type === 'asset-pack-committed') {
        (transfer?.[0] as MessagePort | undefined)?.postMessage({ type: 'asset-pack-ready', build: payload.build });
      }
    }),
  } as unknown as ServiceWorker;
}

function storage(overrides: Partial<StorageManager> = {}): Pick<StorageManager, 'estimate' | 'persist' | 'persisted'> {
  return {
    estimate: vi.fn(async () => ({ quota: 1024 * 1024 * 1024, usage: 0 })),
    persisted: vi.fn(async () => true),
    persist: vi.fn(async () => true),
    ...overrides,
  };
}

function server(manifests: Record<string, AssetPackManifest>, bodies: Record<string, string>) {
  const assetRequests: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), ORIGIN);
    if (url.pathname === '/asset-pack.json') {
      const build = url.searchParams.get('v')!;
      return new Response(JSON.stringify(manifests[build]), { headers: { 'content-type': 'application/json' } });
    }
    assetRequests.push(url.pathname);
    const body = bodies[url.pathname];
    return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, {
      headers: { 'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream' },
    });
  });
  return { fetchImpl, assetRequests };
}

describe('Solana Mobile client marker', () => {
  it('leaves ordinary browser tabs entirely on the on-demand path', () => {
    const values = new Map<string, string>();
    const local = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    expect(isSolanaMobileAssetPackClient('', local)).toBe(false);
    expect(values.size).toBe(0);
  });

  it('persists the APK start marker across internal navigation and reloads', () => {
    const values = new Map<string, string>();
    const local = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    expect(isSolanaMobileAssetPackClient('?client=solana-mobile', local)).toBe(true);
    expect(isSolanaMobileAssetPackClient('', local)).toBe(true);
  });
});

describe('verified asset-pack installation', () => {
  it('requires schema 2 tiers and at least one core file', () => {
    const pack = manifest('build-a', { '/assets/app.js': 'app' });
    expect(() => validateAssetPackManifest({ ...pack, schema: 1 }, 'build-a'))
      .toThrow(expect.objectContaining({ code: 'manifest' }));
    expect(() => validateAssetPackManifest({
      ...pack, files: pack.files.map(({ tier: _tier, ...file }) => file),
    }, 'build-a')).toThrow(expect.objectContaining({ code: 'manifest' }));
    expect(() => validateAssetPackManifest(manifest(
      'build-a', { '/audio/theme.mp3': 'music' }, { '/audio/theme.mp3': 'full' },
    ), 'build-a')).toThrow(expect.objectContaining({ code: 'manifest' }));
  });

  it('accepts the new lossless terrain representation only with its pinned WebP MIME', () => {
    const pack = manifest('build-a', { '/assets/app.js': 'app', '/atlas/fantasy/ground-v2/frostveil.webp': 'webp' },
      { '/atlas/fantasy/ground-v2/frostveil.webp': 'full' });
    expect(() => validateAssetPackManifest(pack, 'build-a')).not.toThrow();
    pack.files.find(file => file.path.endsWith('.webp'))!.contentType = 'image/png';
    expect(() => validateAssetPackManifest(pack, 'build-a')).toThrow(expect.objectContaining({ code: 'manifest' }));
  });

  it('rejects an allowed MIME when it does not match the logical file extension', () => {
    const pack = manifest('build-a', { '/audio/theme.mp3': 'music' });
    pack.files[0]!.contentType = 'image/png';
    expect(() => validateAssetPackManifest(pack, 'build-a')).toThrow(expect.objectContaining({ code: 'manifest' }));
  });

  it.each(['/atlas/world.png', '/atlas/fantasy/ground-v2/frostveil.webp'])('does not transfer %s or declare ready while an older worker controls the first-launch page', async (path) => {
    const bodies = { [path]: 'pixels' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const api = server({ 'build-a': pack }, bodies);
    const listeners = new Map<string, EventListener>();
    const waiting = { postMessage: vi.fn() };
    const registration = {
      waiting, installing: null,
      addEventListener: vi.fn(),
    } as unknown as ServiceWorkerRegistration;
    const worker = {
      controller: { scriptURL: `${ORIGIN}/sw.js?v=build-old`, postMessage: vi.fn() } as unknown as ServiceWorker | null,
      register: vi.fn(async () => registration),
      ready: Promise.resolve({} as ServiceWorkerRegistration),
      addEventListener: vi.fn((kind: string, listener: EventListener) => listeners.set(kind, listener)),
      removeEventListener: vi.fn((kind: string) => listeners.delete(kind)),
    };
    const phases: string[] = [];
    let settled = false;
    const installing = ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      serviceWorker: worker, requireController: true, controllerTimeoutMs: 5_000,
      onProgress: (progress) => phases.push(progress.kind),
    }).then((value) => { settled = true; return value; });
    await vi.waitFor(() => expect(listeners.has('controllerchange')).toBe(true));
    expect(settled).toBe(false);
    expect(phases).not.toContain('ready');
    expect(api.assetRequests).toHaveLength(0);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`)).toBeUndefined();
    worker.controller = controllerFor('build-a');
    listeners.get('controllerchange')!(new Event('controllerchange'));
    await installing;
    expect(phases.at(-1)).toBe('ready');
    expect(api.assetRequests).toHaveLength(1);
    expect(worker.register).toHaveBeenCalledWith('/sw.js?v=build-a', { scope: '/' });
    expect(waiting.postMessage).toHaveBeenCalledWith('skip-waiting');
  });

  it('continues in online mode when clients.claim cannot control the first page, then installs on a later retry', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const api = server({ 'build-a': pack }, bodies);
    const worker = {
      controller: null as ServiceWorker | null,
      register: vi.fn(async () => ({}) as ServiceWorkerRegistration),
      ready: Promise.resolve({} as ServiceWorkerRegistration),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const options = {
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      serviceWorker: worker, requireController: true, controllerTimeoutMs: 1,
    };
    await expect(ensureAssetPack(options)).resolves.toBeNull();
    expect(api.fetchImpl).not.toHaveBeenCalled();
    expect(api.assetRequests).toHaveLength(0);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`)).toBeUndefined();

    worker.controller = controllerFor('build-a');
    await expect(ensureAssetPack(options)).resolves.toEqual(pack);
    expect(api.assetRequests).toEqual(['/atlas/world.png']);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`).then((r) => r?.json())).toEqual(pack);
  });

  it('cancels a superseded React effect without waiting for worker control', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const api = server({ 'build-a': pack }, bodies);
    const controller = new AbortController();
    const worker = {
      controller: { scriptURL: `${ORIGIN}/sw.js?v=old` } as ServiceWorker,
      register: vi.fn(async () => ({ addEventListener: vi.fn() }) as unknown as ServiceWorkerRegistration),
      ready: new Promise<ServiceWorkerRegistration>(() => undefined),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const installing = ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
      serviceWorker: worker, requireController: true, controllerTimeoutMs: 5_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(worker.register).toHaveBeenCalled());
    controller.abort();
    await expect(installing).rejects.toMatchObject({ code: 'aborted' });
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  it('reopens a complete current-build pack offline with zero network requests', async () => {
    const bodies = { '/atlas/world.png': 'pixels', '/audio/theme.mp3': 'music' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const online = server({ 'build-a': pack }, bodies);
    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: online.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
    });
    const controller = controllerFor('build-a');
    const worker = {
      controller,
      register: vi.fn(async () => ({ addEventListener: vi.fn() }) as unknown as ServiceWorkerRegistration),
      ready: Promise.resolve({} as ServiceWorkerRegistration),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const offlineFetch = vi.fn(async (): Promise<Response> => { throw new Error('offline'); });
    const phases: string[] = [];
    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: offlineFetch,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      serviceWorker: worker, requireController: true,
      onProgress: (progress) => phases.push(progress.kind),
    })).resolves.toEqual(pack);
    expect(offlineFetch).not.toHaveBeenCalled();
    expect(phases).toEqual(['checking', 'preparing', 'ready']);
    expect(controller.postMessage).toHaveBeenCalledWith(
      { type: 'asset-pack-committed', build: 'build-a' },
      expect.any(Array),
    );
  });

  it('downloads with bounded concurrency, reports real bytes and commits only after every hash verifies', async () => {
    const bodies = { '/assets/app.js': 'javascript', '/atlas/world.png': 'pixels', '/audio/theme.mp3': 'music' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    let active = 0;
    let peak = 0;
    const progress: number[] = [];
    const base = server({ 'build-a': pack }, bodies);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), ORIGIN);
      if (url.pathname !== '/asset-pack.json') {
        active += 1; peak = Math.max(peak, active);
        await Promise.resolve();
        const response = await base.fetchImpl(input);
        active -= 1;
        return response;
      }
      return base.fetchImpl(input);
    });
    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl, cacheStorage: caches as unknown as CacheStorage,
      crypto, storage: storage(), concurrency: 2,
      onProgress: (p) => { if (p.kind === 'downloading') progress.push(p.downloadedBytes); },
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(progress.at(-1)).toBe(pack.totalBytes);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`).then((r) => r?.json())).toEqual(pack);
  });

  it('reuses canonical runtime URLs and delegates exactly one integrity write to the page', async () => {
    const bodies = { '/assets/app.js': 'javascript', '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), ORIGIN);
      if (url.pathname === '/asset-pack.json') return new Response(JSON.stringify(pack));
      calls.push({ url, init });
      return new Response(bodies[url.pathname as keyof typeof bodies]);
    });
    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
    });
    expect(calls.map(({ url }) => url.href)).toEqual([
      `${ORIGIN}/assets/app.js`, `${ORIGIN}/atlas/world.png?v=build-a`,
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({
        cache: 'force-cache', credentials: 'same-origin',
        headers: { [ASSET_PACK_DOWNLOAD_HEADER]: 'build-a' },
      });
    }
  });

  it('waits for current-worker runtime hashes before inventorying the pack', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const api = server({ 'build-a': pack }, bodies);
    let flushPort: MessagePort | undefined;
    const controller = {
      scriptURL: `${ORIGIN}/sw.js?v=build-a`,
      postMessage: vi.fn((message: unknown, transfer?: Transferable[]) => {
        const payload = message as { type?: string; build?: string };
        if (payload.type === 'asset-pack-inventory-flush') [flushPort] = transfer as MessagePort[];
        if (payload.type === 'asset-pack-committed') {
          (transfer?.[0] as MessagePort | undefined)?.postMessage({ type: 'asset-pack-ready', build: payload.build });
        }
      }),
    } as unknown as ServiceWorker;
    const worker = {
      controller,
      register: vi.fn(async () => ({ addEventListener: vi.fn() }) as unknown as ServiceWorkerRegistration),
      ready: Promise.resolve({} as ServiceWorkerRegistration),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const installing = ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
      serviceWorker: worker, requireController: true,
    });
    await vi.waitFor(() => expect(flushPort).toBeDefined());
    expect(api.fetchImpl).not.toHaveBeenCalled();
    flushPort!.postMessage({ type: 'asset-pack-inventory-ready', build: 'build-a' });
    await expect(installing).resolves.toEqual(pack);
  });

  it('does not refetch when a current-worker inventory snapshot takes longer than two seconds', async () => {
    vi.useFakeTimers();
    try {
      const bodies = { '/atlas/world.png': 'pixels' };
      const pack = manifest('build-a', bodies);
      const api = server({ 'build-a': pack }, bodies);
      let flushPort: MessagePort | undefined;
      const controller = {
        scriptURL: `${ORIGIN}/sw.js?v=build-a`,
        postMessage: vi.fn((message: unknown, transfer?: Transferable[]) => {
          const payload = message as { type?: string; build?: string };
          if (payload.type === 'asset-pack-inventory-flush') [flushPort] = transfer as MessagePort[];
          if (payload.type === 'asset-pack-committed') {
            (transfer?.[0] as MessagePort | undefined)?.postMessage({ type: 'asset-pack-ready', build: payload.build });
          }
        }),
      } as unknown as ServiceWorker;
      const worker = {
        controller,
        register: vi.fn(async () => ({ addEventListener: vi.fn() }) as unknown as ServiceWorkerRegistration),
        ready: Promise.resolve({} as ServiceWorkerRegistration),
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
      };
      const installing = ensureAssetPack({
        build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
        cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
        serviceWorker: worker, requireController: true,
      });
      await vi.waitFor(() => expect(flushPort).toBeDefined());
      await vi.advanceTimersByTimeAsync(2_001);
      expect(api.fetchImpl).not.toHaveBeenCalled();
      flushPort!.postMessage({ type: 'asset-pack-inventory-ready', build: 'build-a' });
      await expect(installing).resolves.toEqual(pack);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a pending worker inventory snapshot without starting a fetch', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const api = server({ 'build-a': pack }, bodies);
    const abort = new AbortController();
    let flushPort: MessagePort | undefined;
    const controller = {
      scriptURL: `${ORIGIN}/sw.js?v=build-a`,
      postMessage: vi.fn((message: unknown, transfer?: Transferable[]) => {
        const payload = message as { type?: string };
        if (payload.type === 'asset-pack-inventory-flush') [flushPort] = transfer as MessagePort[];
      }),
    } as unknown as ServiceWorker;
    const worker = {
      controller,
      register: vi.fn(async () => ({ addEventListener: vi.fn() }) as unknown as ServiceWorkerRegistration),
      ready: Promise.resolve({} as ServiceWorkerRegistration),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const installing = ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
      serviceWorker: worker, requireController: true, signal: abort.signal,
    });
    await vi.waitFor(() => expect(flushPort).toBeDefined());
    abort.abort();
    await expect(installing).rejects.toMatchObject({ code: 'aborted' });
    expect(api.fetchImpl).not.toHaveBeenCalled();
  });

  it('reloads once after corrupt HTTP-cache bytes and reports only verified progress', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const cacheModes: Array<RequestCache | undefined> = [];
    let attempt = 0;
    const progress: number[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input), ORIGIN);
      if (url.pathname === '/asset-pack.json') return new Response(JSON.stringify(pack));
      cacheModes.push(init?.cache);
      attempt += 1;
      return new Response(attempt === 1 ? 'pixals' : bodies['/atlas/world.png']);
    });
    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
      onProgress: (event) => {
        if (event.kind === 'downloading') progress.push(event.downloadedBytes);
      },
    })).resolves.toEqual(pack);
    expect(cacheModes).toEqual(['force-cache', 'reload']);
    expect(progress.at(-1)).toBe(pack.totalBytes);
    expect(Math.max(...progress)).toBeLessThanOrEqual(pack.totalBytes);
  });

  it('commits every core object before the first full-tier request begins', async () => {
    const bodies = { '/assets/app.js': 'core bytes', '/audio/theme.mp3': 'full bytes' };
    const pack = manifest('build-a', bodies, { '/audio/theme.mp3': 'full' });
    const caches = new MemoryCaches();
    let releaseCore!: (response: Response) => void;
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input), ORIGIN).pathname;
      if (path === '/asset-pack.json') return new Response(JSON.stringify(pack));
      requested.push(path);
      if (path === '/assets/app.js') {
        return new Promise<Response>((resolve) => { releaseCore = resolve; });
      }
      return new Response(bodies[path as keyof typeof bodies]);
    });

    const installing = ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(), concurrency: 6,
    });
    await vi.waitFor(() => expect(requested).toEqual(['/assets/app.js']));
    expect(requested).not.toContain('/audio/theme.mp3');
    releaseCore(new Response(bodies['/assets/app.js']));
    await vi.waitFor(() => expect(requested).toContain('/audio/theme.mp3'));
    const core = await caches.cache.match(`${ORIGIN}/_pkw-pack/core.json`).then((response) => response?.json());
    expect(core).toEqual({
      schema: 2, build: 'build-a', totalBytes: Buffer.byteLength(bodies['/assets/app.js']),
      files: [pack.files.find((file) => file.path === '/assets/app.js')],
    });
    await expect(installing).resolves.toEqual(pack);
  });

  it('keeps the atomic core pointer when the optional full tier fails', async () => {
    const bodies = { '/assets/app.js': 'core bytes', '/audio/theme.mp3': 'full bytes' };
    const pack = manifest('build-a', bodies, { '/audio/theme.mp3': 'full' });
    const caches = new MemoryCaches();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(String(input), ORIGIN).pathname;
      if (path === '/asset-pack.json') return new Response(JSON.stringify(pack));
      if (path === '/audio/theme.mp3') return new Response('offline', { status: 503 });
      return new Response(bodies[path as keyof typeof bodies]);
    });

    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(), concurrency: 3,
    })).rejects.toMatchObject({ code: 'network' });
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/core.json`)).toBeDefined();
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`)).toBeUndefined();
  });

  it('checks a large cache inventory with separate bounded concurrency', async () => {
    const bodies = Object.fromEntries(Array.from({ length: 8 }, (_, index) => (
      [`/atlas/family-${index}.png`, `pixels-${index}`]
    )));
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const online = server({ 'build-a': pack }, bodies);
    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: online.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
    });

    const originalMatch = caches.cache.match.bind(caches.cache);
    let active = 0;
    let peak = 0;
    vi.spyOn(caches.cache, 'match').mockImplementation(async (input) => {
      if (!key(input).includes('/_pkw-pack/content/')) return originalMatch(input);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const result = await originalMatch(input);
      active -= 1;
      return result;
    });
    const offline = vi.fn(async (): Promise<Response> => { throw new Error('must not fetch'); });
    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: offline,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      inventoryConcurrency: 3,
    });
    expect(peak).toBe(3);
    expect(offline).not.toHaveBeenCalled();
  });

  it('falls back from a non-finite inventory concurrency and repairs a missing committed object', async () => {
    const bodies = { '/atlas/world.png': 'pixels', '/audio/theme.mp3': 'music' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const initial = server({ 'build-a': pack }, bodies);
    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: initial.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
    });
    await caches.cache.delete(`${ORIGIN}/_pkw-pack/content/${sha(bodies['/audio/theme.mp3'])}`);

    const repair = server({ 'build-a': pack }, bodies);
    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: repair.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      inventoryConcurrency: Number.NaN,
    })).resolves.toEqual(pack);
    expect(repair.assetRequests).toEqual(['/audio/theme.mp3']);
  });

  it('falls back from a non-finite transfer concurrency and still commits every object', async () => {
    const bodies = { '/assets/app.js': 'javascript', '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const api = server({ 'build-a': pack }, bodies);

    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      concurrency: Number.NaN,
    })).resolves.toEqual(pack);
    expect(api.assetRequests).toEqual(['/assets/app.js', '/atlas/world.png']);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`).then((r) => r?.json()))
      .toEqual(pack);
  });

  it('throttles response-chunk progress while preserving monotonic bytes and an exact final snapshot', async () => {
    const chunkCount = 100;
    const chunks = Array.from({ length: chunkCount }, () => new Uint8Array([97]));
    const body = 'a'.repeat(chunkCount);
    const pack = manifest('build-a', { '/assets/app.js': body });
    let now = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input), ORIGIN);
      if (url.pathname === '/asset-pack.json') return new Response(JSON.stringify(pack));
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          now += 10;
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }));
    });
    const progress: Array<{ bytes: number; files: number }> = [];

    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
      concurrency: 1, progressNow: () => now,
      onProgress: (event) => {
        if (event.kind === 'downloading') {
          progress.push({ bytes: event.downloadedBytes, files: event.downloadedFiles });
        }
      },
    });

    expect(progress.length).toBeLessThan(10);
    expect(progress.map(({ bytes }) => bytes)).toEqual(
      [...progress.map(({ bytes }) => bytes)].sort((a, b) => a - b),
    );
    expect(progress.at(-1)).toEqual({ bytes: pack.totalBytes, files: pack.files.length });
  });

  it('forces final download progress even when the whole transfer finishes inside one publish interval', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const api = server({ 'build-a': pack }, bodies);
    const progress: Array<{ bytes: number; files: number }> = [];

    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
      progressNow: () => 0,
      onProgress: (event) => {
        if (event.kind === 'downloading') {
          progress.push({ bytes: event.downloadedBytes, files: event.downloadedFiles });
        }
      },
    });

    expect(progress).toEqual([
      { bytes: 0, files: 0 },
      { bytes: pack.totalBytes, files: pack.files.length },
    ]);
  });

  it('does not declare the pack ready until the current-build worker acknowledges its refreshed index', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const api = server({ 'build-a': pack }, bodies);
    let ackPort: MessagePort | undefined;
    const controller = {
      scriptURL: `${ORIGIN}/sw.js?v=build-a`,
      postMessage: vi.fn((message: unknown, transfer?: Transferable[]) => {
        const payload = message as { type?: string; build?: string };
        if (payload.type === 'asset-pack-inventory-flush') {
          (transfer?.[0] as MessagePort | undefined)?.postMessage({
            type: 'asset-pack-inventory-ready', build: payload.build,
          });
        } else {
          [ackPort] = transfer as MessagePort[];
        }
      }),
    } as unknown as ServiceWorker;
    const worker = {
      controller,
      register: vi.fn(async () => ({ addEventListener: vi.fn() }) as unknown as ServiceWorkerRegistration),
      ready: Promise.resolve({} as ServiceWorkerRegistration),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    };
    const phases: string[] = [];
    let settled = false;
    const installing = ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      serviceWorker: worker, requireController: true,
      onProgress: (progress) => phases.push(progress.kind),
    }).then((value) => { settled = true; return value; });

    await vi.waitFor(() => expect(ackPort).toBeDefined());
    expect(settled).toBe(false);
    expect(phases).not.toContain('ready');
    ackPort!.postMessage({ type: 'asset-pack-ready', build: 'build-a' });
    await expect(installing).resolves.toEqual(pack);
    expect(phases.at(-1)).toBe('ready');
  });

  it('downloads identical content once and reports physical content-addressed bytes', async () => {
    const bodies = { '/assets/a.svg': '<svg/>', '/assets/b.svg': '<svg/>' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const api = server({ 'build-a': pack }, bodies);
    expect(pack.totalBytes).toBe(Buffer.byteLength('<svg/>'));
    await ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
    });
    expect(api.assetRequests).toEqual(['/assets/a.svg']);
    expect([...caches.cache.entries.keys()].filter((entry) => entry.includes('/content/'))).toHaveLength(1);
  });

  it('reuses content hashes across builds, downloads only the delta, and retains one rollback manifest', async () => {
    const firstBodies = { '/atlas/shared.png': 'same', '/audio/theme.mp3': 'old' };
    const nextBodies = { '/atlas/shared.png': 'same', '/audio/theme.mp3': 'new' };
    const first = manifest('build-a', firstBodies);
    const next = manifest('build-b', nextBodies);
    const caches = new MemoryCaches();
    const firstApi = server({ 'build-a': first }, firstBodies);
    await ensureAssetPack({ build: 'build-a', origin: ORIGIN, fetch: firstApi.fetchImpl, cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage() });
    const nextApi = server({ 'build-b': next }, nextBodies);
    await ensureAssetPack({ build: 'build-b', origin: ORIGIN, fetch: nextApi.fetchImpl, cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage() });
    expect(nextApi.assetRequests).toEqual(['/audio/theme.mp3']);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/previous.json`).then((r) => r?.json())).toEqual(first);
    expect([...caches.cache.entries.keys()].filter((url) => url.includes('/content/'))).toHaveLength(3);

    const rollbackApi = server({ 'build-a': first }, firstBodies);
    await ensureAssetPack({ build: 'build-a', origin: ORIGIN, fetch: rollbackApi.fetchImpl, cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage() });
    expect(rollbackApi.assetRequests).toHaveLength(0);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`).then((r) => r?.json())).toEqual(first);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/previous.json`).then((r) => r?.json())).toEqual(next);
  });

  it('resumes missing-only after a failed attempt and never commits the partial manifest', async () => {
    const bodies = { '/assets/a.js': 'one', '/assets/b.js': 'two' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    let fail = true;
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input), ORIGIN);
      if (url.pathname === '/asset-pack.json') return new Response(JSON.stringify(pack));
      fetched.push(url.pathname);
      if (fail && url.pathname === '/assets/b.js') return new Response('no', { status: 503 });
      return new Response(bodies[url.pathname as keyof typeof bodies]);
    });
    await expect(ensureAssetPack({ build: 'build-a', origin: ORIGIN, fetch: fetchImpl, cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(), concurrency: 1 }))
      .rejects.toMatchObject({ code: 'network' });
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`)).toBeUndefined();
    fail = false;
    fetched.length = 0;
    await ensureAssetPack({ build: 'build-a', origin: ORIGIN, fetch: fetchImpl, cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(), concurrency: 1 });
    expect(fetched).toEqual(['/assets/b.js']);
  });

  it('rejects a wrong hash before the current pointer can move', async () => {
    const bodies = { '/atlas/world.png': 'real bytes' };
    const pack = manifest('build-a', bodies);
    pack.files[0]!.sha256 = '0'.repeat(64);
    const caches = new MemoryCaches();
    const api = server({ 'build-a': pack }, bodies);
    await expect(ensureAssetPack({ build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl, cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage() }))
      .rejects.toMatchObject({ code: 'integrity' });
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`)).toBeUndefined();
  });

  it('downloads and commits when a clean Chromium profile denies persistent storage', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    const api = server({ 'build-a': pack }, bodies);
    const persisted = vi.fn(async () => false);
    const persist = vi.fn(async () => false);
    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto,
      storage: storage({ persisted, persist }),
    })).resolves.toEqual(pack);
    expect(persisted).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(api.assetRequests).toEqual(['/atlas/world.png']);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`).then((r) => r?.json())).toEqual(pack);
  });

  it('downloads and commits when the optional persistence API throws', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const cases: Partial<StorageManager>[] = [
      { persisted: vi.fn(async () => { throw new Error('status API unavailable'); }) },
      {
        persisted: vi.fn(async () => false),
        persist: vi.fn(async () => { throw new Error('permission request rejected'); }),
      },
    ];
    for (const overrides of cases) {
      const caches = new MemoryCaches();
      const api = server({ 'build-a': pack }, bodies);
      await expect(ensureAssetPack({
        build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
        cacheStorage: caches as unknown as CacheStorage, crypto,
        storage: storage(overrides),
      })).resolves.toEqual(pack);
      expect(api.assetRequests).toEqual(['/atlas/world.png']);
      expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`).then((r) => r?.json())).toEqual(pack);
    }
  });

  it('fails before downloading when the verified pack cannot fit in quota', async () => {
    const bodies = { '/atlas/world.png': 'large enough' };
    const pack = manifest('build-a', bodies);
    const api = server({ 'build-a': pack }, bodies);

    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: api.fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto,
      storage: storage({ estimate: vi.fn(async () => ({ quota: 100, usage: 99 })) }),
    })).rejects.toMatchObject({ code: 'quota' });
    expect(api.assetRequests).toHaveLength(0);
  });

  it('times out a hung object as retryable network failure without committing a partial pack', async () => {
    const bodies = { '/atlas/world.png': 'pixels' };
    const pack = manifest('build-a', bodies);
    const caches = new MemoryCaches();
    let hang = true;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = new URL(String(input), ORIGIN);
      if (url.pathname === '/asset-pack.json') return new Response(JSON.stringify(pack));
      if (hang) return new Promise<Response>(() => undefined);
      return new Response(bodies[url.pathname as keyof typeof bodies]);
    });

    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      concurrency: 1, objectTimeoutMs: 5,
    })).rejects.toMatchObject({ code: 'network', message: 'Download timed out: /atlas/world.png' });
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`)).toBeUndefined();

    hang = false;
    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: caches as unknown as CacheStorage, crypto, storage: storage(),
      concurrency: 1, objectTimeoutMs: 1_000,
    })).resolves.toEqual(pack);
    expect(await caches.cache.match(`${ORIGIN}/_pkw-pack/current.json`).then((r) => r?.json())).toEqual(pack);
  });

  it('rejects a manifest from a different deploy rather than mixing builds', async () => {
    const pack = manifest('build-b', { '/assets/app.js': 'new' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(pack)));
    await expect(ensureAssetPack({
      build: 'build-a', origin: ORIGIN, fetch: fetchImpl,
      cacheStorage: new MemoryCaches() as unknown as CacheStorage, crypto, storage: storage(),
    })).rejects.toEqual(expect.objectContaining<Partial<AssetPackError>>({ code: 'build-mismatch' }));
  });
});
