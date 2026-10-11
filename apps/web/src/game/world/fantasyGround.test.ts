import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type Phaser from 'phaser';
import { BASE_GROUND_MOTION } from '@shardkeep/shared';
import { baseGroundArt, baseGroundTransport, type BaseVisualContext, DEFAULT_BASE_VISUAL, REALM_IDS, renderGroundPixels } from '@shardkeep/shared/baseVisual';
import { groundEnvironmentFeatures } from '@shardkeep/shared/groundEnvironment';
import { FantasyGroundMotion, GroundSourceCache, groundCoverageRect, groundPaintLayout, loadGroundPixels, revisionGroundMotes } from './fantasyGround';
import { SceneVisualGate } from './sceneVisualGate';

beforeEach(() => {
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
});
function finishPainting(scene: { events: EventEmitter }, ground: { diagnostics: { state: string; phase?: string } }) {
  for (let frame = 0; frame < 1000 && (ground.diagnostics.state === 'loading'
    || ground.diagnostics.phase === 'terrain'); frame++) scene.events.emit('update');
}
function groundDocument(onPaint: (image: ImageData) => void = () => {}) {
  return { addEventListener: vi.fn(), removeEventListener: vi.fn(), hidden: false,
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ putImageData: onPaint }) }) };
}

// The painted cache and sampler retain this exact historical revision after r3 activation.
const FROZEN_CLEARING_V1 = { version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: 1 } as const;
const pixels = { width: 320, height: 320, data: new Uint8Array(320 * 320 * 4) };
describe('ground source residency', () => {
  it('shares one finite active episode across leases even while bytes keep arriving', async () => {
    vi.useFakeTimers();
    let report!: Parameters<NonNullable<ConstructorParameters<typeof GroundSourceCache>[0]>>[2];
    const loader = vi.fn(async (_context, _signal, next) => { report = next; return new Promise<typeof pixels>(() => {}); });
    const cache = new GroundSourceCache(loader), a = cache.acquire(DEFAULT_BASE_VISUAL), b = cache.acquire(DEFAULT_BASE_VISUAL);
    const failure = expect(a.ready).rejects.toMatchObject({ reason: 'active-deadline' });
    expect(a.ready).toBe(b.ready);
    for (let i = 1; i <= 6; i++) {
      report?.({ phase: 'download', completed: i, total: 0, downloadMs: i * 19_000, verifyMs: 0, decodeMs: 0 });
      await vi.advanceTimersByTimeAsync(19_000);
    }
    await vi.advanceTimersByTimeAsync(6_000); await failure;
    expect(loader).toHaveBeenCalledTimes(1); expect(cache.size).toBe(0);
    a.release(); b.release(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds decode separately and closes a bitmap that arrives after its last lease left', async () => {
    vi.useFakeTimers();
    const hash = Uint8Array.from(baseGroundArt(DEFAULT_BASE_VISUAL).sources[DEFAULT_BASE_VISUAL.realmId].sha256.match(/../g)!, value => Number.parseInt(value, 16));
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => hash.buffer) } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]))));
    let finish!: (image: ImageBitmap) => void;
    const bitmap = vi.fn(() => new Promise<ImageBitmap>(resolve => { finish = resolve; }));
    vi.stubGlobal('createImageBitmap', bitmap);
    const cache = new GroundSourceCache(), lease = cache.acquire(DEFAULT_BASE_VISUAL);
    const rejected = expect(lease.ready).rejects.toMatchObject({ reason: 'idle-timeout' });
    await vi.advanceTimersByTimeAsync(0); expect(bitmap).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000); await rejected;
    const close = vi.fn(); finish({ width: 320, height: 320, close } as unknown as ImageBitmap);
    await vi.advanceTimersByTimeAsync(0); expect(close).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0); lease.release(); expect(vi.getTimerCount()).toBe(0);
  });

  it('never decodes a complete but corrupted response or retries failed integrity', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1]))), bitmap = vi.fn();
    vi.stubGlobal('fetch', fetcher); vi.stubGlobal('createImageBitmap', bitmap);
    vi.stubGlobal('crypto', { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } });
    await expect(loadGroundPixels(DEFAULT_BASE_VISUAL, new AbortController().signal)).rejects.toMatchObject({ reason: 'integrity' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(bitmap).not.toHaveBeenCalled();
  });
  it('downloads and verifies the WebP representation before decoding with its pinned MIME', async () => {
    const context: BaseVisualContext = { version: 1, realmId: 'frostveil', artVersion: 2 };
    const descriptor = baseGroundTransport(context);
    const bytes = readFileSync(new URL('../../../../../art/fantasy-ground-transport-v1/ground-v2/frostveil.webp', import.meta.url));
    const fetcher = vi.fn(async () => new Response(Uint8Array.from(bytes)));
    vi.stubGlobal('fetch', fetcher);
    const source = { width: 1536, height: 1536, data: new Uint8ClampedArray(1536 * 1536 * 4) };
    const close = vi.fn(), bitmap = vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe(descriptor.mime);
      expect(Buffer.from(await blob.arrayBuffer()).equals(bytes)).toBe(true);
      return { width: source.width, height: source.height, close };
    });
    vi.stubGlobal('createImageBitmap', bitmap);
    vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, createElement: () => ({
      width: 0, height: 0, getContext: () => ({ drawImage: vi.fn(), getImageData: () => source }),
    }) }));
    const result = await loadGroundPixels(context, new AbortController().signal);
    expect(result.data).toBe(source.data); expect(result.width).toBe(source.width); expect(result.height).toBe(source.height);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining(descriptor.path + '?v='), expect.any(Object));
    expect(bitmap).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });

  it.each(['corrupt', 'partial'])('never decodes %s WebP bytes or falls through to unverified PNG', async (failure) => {
    const context: BaseVisualContext = { version: 1, realmId: 'frostveil', artVersion: 2 };
    const original = readFileSync(new URL('../../../../../art/fantasy-ground-transport-v1/ground-v2/frostveil.webp', import.meta.url));
    const bytes = failure === 'partial' ? original.subarray(0, Math.floor(original.length / 2)) : Buffer.from(original);
    if (failure === 'corrupt') bytes[0] = bytes[0]! ^ 255;
    const fetcher = vi.fn(async () => new Response(Uint8Array.from(bytes))), bitmap = vi.fn();
    vi.stubGlobal('fetch', fetcher); vi.stubGlobal('createImageBitmap', bitmap);
    await expect(loadGroundPixels(context, new AbortController().signal)).rejects.toMatchObject({ reason: 'integrity' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(bitmap).not.toHaveBeenCalled();
  });

  it('pauses suspended transfers without keeping visibility listeners after abandonment', async () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', page);
    const remove = vi.spyOn(page, 'removeEventListener');
    let finish!: (source: typeof pixels) => void;
    let signal!: AbortSignal;
    const cache = new GroundSourceCache(async (_context, nextSignal) => {
      signal = nextSignal; return new Promise(resolve => { finish = resolve; });
    });
    const lease = cache.acquire(DEFAULT_BASE_VISUAL);
    vi.advanceTimersByTime(90_000);
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(90_000); expect(signal.aborted).toBe(false);
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(29_999); expect(signal.aborted).toBe(false);
    lease.release(); expect(signal.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    finish(pixels); await expect(lease.ready).rejects.toThrow();
  });

  it('enforces both the decoded byte ceiling and two idle entries while protecting active scenes', async () => {
    const size = baseGroundArt(FROZEN_CLEARING_V1).sourceSize;
    const loader = vi.fn(async (context) => {
      const width = baseGroundArt(context).sourceSize;
      return { width, height: width, data: new Uint8Array(width * width * 4) };
    });
    const cache = new GroundSourceCache(loader);
    const contexts = REALM_IDS.slice(0, 4).map(realmId => ({ version: 1, realmId, artVersion: 2 } as const));
    const leases = contexts.map(context => cache.acquire(context));
    await Promise.all(leases.map(lease => lease.ready));
    expect(size * size * 4 * 2).toBe(18 * 1024 * 1024);
    expect(cache.size).toBe(4); // leased sources never evict beneath active scenes
    leases[0]!.release(); leases[1]!.release(); leases[2]!.release();
    expect(cache.size).toBe(3); // oldest idle removed; two idle + one active
    const warm = cache.acquire(contexts[1]!); expect(warm.cached).toBe(true); await warm.ready; warm.release();
    leases[3]!.release(); expect(cache.size).toBe(2);
    const evicted = cache.acquire(contexts[2]!); expect(evicted.cached).toBe(false); await evicted.ready;
    expect(loader).toHaveBeenCalledTimes(5);
    cache.clearIdle(); expect(cache.size).toBe(1); // even explicit cleanup protects a lease
    evicted.release(); cache.clearIdle(); expect(cache.size).toBe(0);
    const oneSource = new GroundSourceCache(loader, 2, size * size * 4);
    const a = oneSource.acquire(contexts[0]!), b = oneSource.acquire(contexts[1]!);
    await Promise.all([a.ready, b.ready]); a.release(); b.release();
    expect(oneSource.size).toBe(1); oneSource.clearIdle();
  });

  it('an old failed lease cannot remove or abort the fresh retry for the same realm', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(pixels);
    const cache = new GroundSourceCache(loader), old = cache.acquire(DEFAULT_BASE_VISUAL);
    await expect(old.ready).rejects.toThrow('offline');
    const retry = cache.acquire(DEFAULT_BASE_VISUAL); await retry.ready;
    old.release(); expect(cache.size).toBe(1);
    const second = cache.acquire(DEFAULT_BASE_VISUAL); expect(second.cached).toBe(true);
    expect(await second.ready).toBe(pixels); expect(loader).toHaveBeenCalledTimes(2);
    retry.release(); second.release(); cache.clearIdle();
  });

  it('keeps older replay artwork resident beside the frozen corrected realm without crossing versions', async () => {
    const loader = vi.fn(async (context) => {
      const size = baseGroundArt(context).sourceSize;
      return { width: size, height: size, data: new Uint8Array(size * size * 4) };
    });
    const cache = new GroundSourceCache(loader);
    const historical = cache.acquire(DEFAULT_BASE_VISUAL), current = cache.acquire(FROZEN_CLEARING_V1);
    expect((await historical.ready).width).toBe(baseGroundArt(DEFAULT_BASE_VISUAL).sourceSize);
    expect((await current.ready).width).toBe(baseGroundArt(FROZEN_CLEARING_V1).sourceSize);
    expect(loader).toHaveBeenCalledTimes(2);
    historical.release(); current.release(); expect(cache.size).toBe(2);
    cache.clearIdle(); expect(cache.size).toBe(0);
  });

  it('keeps frozen v2 and corrected Crownlands sources separate in both cache acquisition orders', async () => {
    const frozen: BaseVisualContext = { version: 1, realmId: 'crownlands', artVersion: 2 };
    for (const contexts of [[frozen, FROZEN_CLEARING_V1], [FROZEN_CLEARING_V1, frozen]]) {
      const loader = vi.fn(async context => {
        const size = baseGroundArt(context).sourceSize;
        const data = new Uint8Array(size * size * 4); data[0] = context.groundRevision ?? 0;
        return { width: size, height: size, data };
      });
      const cache = new GroundSourceCache(loader);
      const leases = contexts.map(context => cache.acquire(context));
      const sources = await Promise.all(leases.map(lease => lease.ready));
      expect(sources.map(source => source.data[0])).toEqual(contexts.map(context => context.groundRevision ?? 0));
      expect(loader).toHaveBeenCalledTimes(2);
      leases.forEach(lease => lease.release()); cache.clearIdle();
    }
  });

  it('retries an unavailable source with a fresh lease rather than retaining the rejected transfer', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(pixels);
    const cache = new GroundSourceCache(loader);
    const failed = cache.acquire(DEFAULT_BASE_VISUAL);
    await expect(failed.ready).rejects.toThrow('offline'); failed.release();
    const retry = cache.acquire(DEFAULT_BASE_VISUAL);
    expect(await retry.ready).toBe(pixels);
    expect(loader).toHaveBeenCalledTimes(2);
    retry.release(); expect(cache.size).toBe(1);
    cache.clearIdle(); expect(cache.size).toBe(0);
  });

  it('shares one transfer and retains a bounded decoded source for warm returns', async () => {
    const loader = vi.fn(async () => pixels), cache = new GroundSourceCache(loader);
    const a = cache.acquire(DEFAULT_BASE_VISUAL), b = cache.acquire(DEFAULT_BASE_VISUAL);
    expect(await a.ready).toBe(await b.ready);
    expect(loader).toHaveBeenCalledTimes(1);
    a.release(); expect(cache.size).toBe(1);
    b.release(); b.release(); expect(cache.size).toBe(1);
    const warm = cache.acquire(DEFAULT_BASE_VISUAL);
    expect(warm.cached).toBe(true); expect(await warm.ready).toBe(pixels);
    expect(loader).toHaveBeenCalledTimes(1); warm.release();
    cache.clearIdle(); expect(cache.size).toBe(0);
  });
  it('aborts abandoned decode and refuses to populate a later scene with it', async () => {
    let finish!: (source: typeof pixels) => void;
    let signal!: AbortSignal;
    const cache = new GroundSourceCache(async (_context, currentSignal) => {
      signal = currentSignal;
      return new Promise(resolve => { finish = resolve; });
    });
    const lease = cache.acquire(DEFAULT_BASE_VISUAL);
    const rejected = expect(lease.ready).rejects.toThrow();
    lease.release(); expect(signal.aborted).toBe(true);
    finish(pixels); await rejected;
    expect(cache.size).toBe(0);
  });
  it('keeps defender and attacker themes separate instead of reusing a realm-blind key', async () => {
    const loader = vi.fn(async () => pixels), cache = new GroundSourceCache(loader);
    const a = cache.acquire(DEFAULT_BASE_VISUAL);
    const b = cache.acquire({ ...DEFAULT_BASE_VISUAL, realmId: 'frostveil' });
    await Promise.all([a.ready, b.ready]);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
    a.release(); b.release(); expect(cache.size).toBe(2);
    cache.clearIdle(); expect(cache.size).toBe(0);
  });
});

describe('scene-owned ground textures', () => {
  it('registers finished pixels once through installed Phaser without a CanvasTexture readback buffer', async () => {
    const { FantasyGround } = await import('./fantasyGround');
    const require = createRequire(import.meta.url), phaserRoot = dirname(require.resolve('phaser/package.json'));
    const Texture = require(join(phaserRoot, 'src/textures/Texture.js'));
    // TextureManager imports the whole renderer graph. Execute its actual small
    // registration method with the installed Texture/TextureSource constructors.
    const source = readFileSync(join(phaserRoot, 'src/textures/TextureManager.js'), 'utf8');
    const method = source.match(/create: function \(key, source, width, height\)\n    \{[\s\S]*?\n    \},/)?.[0];
    expect(method).toBeDefined();
    const native = runInNewContext(`({${method}})`, { Texture }) as {
      create(this: unknown, key: string, source: HTMLCanvasElement, width: number, height: number): Phaser.Textures.Texture | null;
    };
    class Canvas {
      width = 0; height = 0; painted?: ImageData;
      context = { putImageData: (image: ImageData) => { this.painted = image; },
        getImageData: vi.fn(() => { throw new Error('Unexpected full terrain readback'); }) };
      getContext() { return this.context; }
    }
    vi.stubGlobal('HTMLCanvasElement', Canvas);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const canvases: Canvas[] = [];
    vi.stubGlobal('document', { ...groundDocument(), createElement: () => {
      const canvas = new Canvas(); canvases.push(canvas); return canvas;
    } });
    const upload = vi.fn((canvas: Canvas) => {
      expect(canvas.painted?.data).toEqual(renderGroundPixels(pixels, DEFAULT_BASE_VISUAL, 64, 64));
      return { spectorMetadata: {} };
    });
    const renderer = { gl: {}, createCanvasTexture: upload, setTextureFilter: vi.fn(), deleteTexture: vi.fn() };
    const textures = { game: { renderer, config: { antialias: false } }, list: {} as Record<string, Phaser.Textures.Texture>,
      checkKey: (key: string) => !textures.list[key], exists: (key: string) => !!textures.list[key],
      create: native.create, removeKey: (key: string) => { delete textures.list[key]; },
      remove: (key: string) => textures.list[key]?.destroy() };
    const display = () => ({ setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setDisplaySize: vi.fn().mockReturnThis(), setFillStyle: vi.fn(), destroy: vi.fn() });
    const scene = { textures, events: new EventEmitter(), cameras: { main: { setBackgroundColor: vi.fn(), worldView: { x: 0, y: 0, width: 0, height: 0 } } },
      add: { rectangle: display, image: display, graphics: () => ({ setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn() }) } };
    const cache = new GroundSourceCache(async () => pixels, 0, 0);
    const ground = new FantasyGround(scene as never, 0, 2, 64, cache);
    try {
      ground.set(DEFAULT_BASE_VISUAL); await new Promise(resolve => setTimeout(resolve, 0)); finishPainting(scene, ground);
      expect(ground.diagnostics.state).toBe('ready'); expect(upload).toHaveBeenCalledTimes(1);
      expect(canvases).toHaveLength(1); expect(canvases[0]!.context.getImageData).not.toHaveBeenCalled();
      const texture = Object.values(textures.list)[0]!;
      for (const key of ['imageData', 'data', 'buffer', 'pixels']) expect(texture).not.toHaveProperty(key);
      expect(texture.source[0]!.image).toBe(canvases[0]); // retained source supports context restoration
      expect(texture.get('__BASE').width).toBe(64); expect(texture.source[0]!.scaleMode).toBe(1);
      ground.destroy();
      expect(renderer.deleteTexture).toHaveBeenCalledTimes(1); expect(Object.keys(textures.list)).toHaveLength(0);
      expect(texture.source).toHaveLength(0); expect(cache.size).toBe(0);
    } finally { ground.destroy(); }
  });

  it('cancels partially sampled terrain before a new defender can publish it or teardown can upload it', async () => {
    const { FantasyGround } = await import('./fantasyGround');
    let time = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time += 5);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', groundDocument());
    const display = () => ({ setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setDisplaySize: vi.fn().mockReturnThis(), setFillStyle: vi.fn(), destroy: vi.fn() });
    const textures = new Set<string>();
    const scene = { events: new EventEmitter(), cameras: { main: { setBackgroundColor: vi.fn(), worldView: { x: 0, y: 0, width: 0, height: 0 } } },
      add: { rectangle: display, image: display, graphics: () => ({ setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn() }) },
      textures: { exists: (key: string) => textures.has(key), remove: (key: string) => textures.delete(key),
        create: vi.fn((key: string) => {
          textures.add(key); return { add: vi.fn(), setFilter: vi.fn() };
        }) } };
    const cache = new GroundSourceCache(async () => pixels, 0, 0);
    const ground = new FantasyGround(scene as never, 0, 2, 64, cache);
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
      ground.set(DEFAULT_BASE_VISUAL); await flush();
      expect(ground.diagnostics.completed).toBe(8); expect(ground.diagnostics.total).toBe(64);
      expect(ground.diagnostics.state).toBe('loading'); expect(scene.textures.create).not.toHaveBeenCalled();
      ground.set({ ...DEFAULT_BASE_VISUAL, realmId: 'frostveil' }); await flush();
      expect(ground.diagnostics.completed).toBe(8); // abandoned Crownlands rows never carry over
      finishPainting(scene, ground);
      expect(ground.diagnostics.state).toBe('ready'); expect(scene.textures.create).toHaveBeenCalledTimes(1);
      ground.set(DEFAULT_BASE_VISUAL); await flush();
      ground.destroy();
      for (let frame = 0; frame < 100; frame++) scene.events.emit('update');
      expect(scene.textures.create).toHaveBeenCalledTimes(1);
      expect(textures.size).toBe(0); expect(cache.size).toBe(0);
      expect(scene.events.listenerCount('update')).toBe(0);
    } finally { ground.destroy(); clock.mockRestore(); }
  });

  it('keeps the battlefield crop and hides only registered skirt decor for ready v2 art, restoring fallback and v1', async () => {
    const { FantasyGround } = await import('./fantasyGround');
    const pending: Array<{ resolve: (value: typeof pixels) => void; reject: (error: Error) => void }> = [];
    const loader = vi.fn(async () => new Promise<typeof pixels>((resolve, reject) => pending.push({ resolve, reject })));
    const cache = new GroundSourceCache(loader, 0, 0);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', groundDocument());
    const display = () => ({ setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setDisplaySize: vi.fn().mockReturnThis(), setFillStyle: vi.fn(), destroy: vi.fn(),
      setTint: vi.fn(), setVisible: vi.fn() });
    const textures = new Set<string>();
    let painted: Uint8ClampedArray | undefined;
    vi.stubGlobal('document', groundDocument(image => { painted = image.data; }));
    const scene = {
      add: { rectangle: display, image: vi.fn(display), graphics: () => ({
        setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn(),
      }) },
      events: new EventEmitter(), cameras: { main: { setBackgroundColor: vi.fn(), worldView: { x: 0, y: 0, width: 0, height: 0 } } },
      textures: { exists: (key: string) => textures.has(key), remove: (key: string) => textures.delete(key),
        create: vi.fn((key: string) => {
          textures.add(key);
          return { add: vi.fn(), setFilter: vi.fn() };
        }) },
    };
    const skirt = display(), lateSkirt = display(), serverObstacle = display();
    const onLoading = vi.fn(() => {
      // Context invalidation must notify the visibility gate BEFORE old pixels
      // are removed, even when the caller runs outside a Phaser update.
      if (onLoading.mock.calls.length > 1) expect(textures.size).toBe(1);
    });
    const ground = new FantasyGround(scene as never, -14, 58, 64, cache, onLoading);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
      ground.styleDecor(skirt as never, 'dec_pine_1');
      ground.set(FROZEN_CLEARING_V1);
      expect(skirt.setVisible).toHaveBeenLastCalledWith(true);
      const art = baseGroundArt(FROZEN_CLEARING_V1), size = art.sourceSize;
      const sourceData = new Uint8Array(size * size * 4);
      const sample = Math.floor((-14 - art.worldOriginTiles) * size / art.worldTiles);
      sourceData.set([73, 131, 191, 255], (sample * size + sample) * 4);
      pending.shift()!.resolve({ width: size, height: size, data: sourceData });
      await flush(); finishPainting(scene, ground);
      expect(ground.diagnostics.state).toBe('ready');
      // V2 keeps the battle crop (58 tiles), not the full home's 98-tile GPU raster.
      expect(scene.textures.create).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), 58 * 32, 58 * 32);
      expect(ground.diagnostics.pixels).toBe((58 * 32) ** 2);
      // Cropping starts at the same world pixel as the shared whole-world/deed
      // sampler. Rescaling the complete painting into this crop would read 0.
      expect(Array.from(painted!.slice(0, 4))).toEqual([73, 131, 191, 255]);
      const portrait = { x: -896, y: -1536, width: 3712, height: 5312 };
      ground.setCoverage(portrait); finishPainting(scene, ground);
      expect(scene.textures.create).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), 1856, 2656);
      // Camera coverage must expose more of the same painting, never stretch
      // the previous crop. This exact world pixel moves down by ten tiles.
      expect(Array.from(painted!.slice(320 * 1856 * 4, 320 * 1856 * 4 + 4)))
        .toEqual([73, 131, 191, 255]);
      ground.setCoverage({ ...portrait });
      expect(scene.textures.create).toHaveBeenCalledTimes(2);
      const landscape = { x: -2240, y: -896, width: 6400, height: 3712 };
      ground.setCoverage(landscape); finishPainting(scene, ground);
      expect(scene.textures.create).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), 3136, 1856);
      expect(ground.diagnostics.pixels).toBe(3136 * 1856);
      expect(Array.from(painted!.slice(640 * 4, 640 * 4 + 4))).toEqual([73, 131, 191, 255]);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(textures.size).toBe(1);
      expect(cache.size).toBe(1);
      expect(scene.add.image).toHaveBeenCalledTimes(5); // two retired crops, main, left/right edge frames
      expect(skirt.setVisible).toHaveBeenLastCalledWith(false);
      ground.styleDecor(lateSkirt as never, 'dec_rock_s');
      expect(lateSkirt.setVisible).toHaveBeenLastCalledWith(false);
      ground.set({ version: 1, realmId: 'frostveil', artVersion: 2 });
      // Resize replacements retain the ready realm. Only an actual art-context
      // change covers the field before removing its old pixels.
      expect(onLoading).toHaveBeenCalledTimes(2);
      onLoading.mockImplementation(() => {}); // failure/recovery now legitimately has no old pixels
      for (const result of scene.add.image.mock.results) expect(result.value.destroy).toHaveBeenCalledTimes(1);
      expect(skirt.setVisible).toHaveBeenLastCalledWith(true);
      expect(lateSkirt.setVisible).toHaveBeenLastCalledWith(true);
      pending.shift()!.reject(new Error('offline'));
      await flush(); finishPainting(scene, ground);
      expect(ground.diagnostics.state).toBe('failed');
      expect(skirt.setVisible).toHaveBeenLastCalledWith(true);
      ground.set(DEFAULT_BASE_VISUAL);
      pending.shift()!.resolve(pixels);
      await flush(); finishPainting(scene, ground);
      expect(ground.diagnostics.state).toBe('ready');
      // Historical replay framing remains the original square even after a
      // prior V2 visit supplied wider camera coverage.
      expect(scene.textures.create).toHaveBeenLastCalledWith(expect.any(String), expect.any(Object), 1856, 1856);
      ground.setCoverage(portrait); finishPainting(scene, ground);
      expect(scene.textures.create).toHaveBeenCalledTimes(4);
      expect(skirt.setVisible).toHaveBeenLastCalledWith(true);
      expect(skirt.setTint).toHaveBeenLastCalledWith(0xffffff);
      expect(serverObstacle.setVisible).not.toHaveBeenCalled();
      expect(serverObstacle.setTint).not.toHaveBeenCalled();
      expect(serverObstacle.destroy).not.toHaveBeenCalled();
    } finally { ground.destroy(); warning.mockRestore(); }
    expect(skirt.destroy).not.toHaveBeenCalled();
    expect(textures.size).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('uses the latest resize during decode and recovers a failed repaint without leaking the source lease', async () => {
    const { FantasyGround } = await import('./fantasyGround');
    let finish!: (value: typeof pixels) => void;
    const loader = vi.fn(async () => new Promise<typeof pixels>(resolve => { finish = resolve; }));
    const cache = new GroundSourceCache(loader, 0, 0);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', groundDocument());
    const textures = new Set<string>();
    const display = () => ({ setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setDisplaySize: vi.fn().mockReturnThis(), setFillStyle: vi.fn(), destroy: vi.fn() });
    const scene = {
      add: { rectangle: display, image: display, graphics: () => ({ setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn() }) },
      events: new EventEmitter(), cameras: { main: { setBackgroundColor: vi.fn(), worldView: { x: 0, y: 0, width: 0, height: 0 } } },
      textures: { exists: (key: string) => textures.has(key), remove: (key: string) => textures.delete(key),
        create: vi.fn((key: string) => {
          textures.add(key);
          return { add: vi.fn(), setFilter: vi.fn() };
        }) },
    };
    const ground = new FantasyGround(scene as never, 0, 2, 64, cache);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const size = baseGroundArt(FROZEN_CLEARING_V1).sourceSize;
    const source = { width: size, height: size, data: new Uint8Array(size * size * 4) };
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
      ground.set(FROZEN_CLEARING_V1);
      ground.setCoverage({ x: 0, y: -64, width: 128, height: 256 });
      ground.setCoverage({ x: -64, y: 0, width: 256, height: 128 });
      finish(source); await flush(); finishPainting(scene, ground);
      expect(scene.textures.create).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.any(Object), 128, 64);
      scene.textures.create.mockImplementationOnce(() => { throw new Error('allocation failed'); });
      ground.setCoverage({ x: -128, y: 0, width: 320, height: 128 }); finishPainting(scene, ground);
      // An allocation failure during resize retains the correct visible realm
      // and its source lease; it must not turn an active raid into a reload.
      expect(ground.diagnostics.state).toBe('ready');
      expect(ground.diagnostics.error).toBe('allocation failed');
      expect(cache.size).toBe(1); expect(textures.size).toBe(1);
      ground.set(FROZEN_CLEARING_V1, true);
      finish(source); await flush(); finishPainting(scene, ground);
      expect(ground.diagnostics.state).toBe('ready');
      expect(ground.diagnostics.width).toBe(160);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(textures.size).toBe(1);
    } finally { ground.destroy(); warning.mockRestore(); }
    expect(cache.size).toBe(0); expect(textures.size).toBe(0);
  });

  it('repaints revision-only Crownlands changes in a reused scene and restores frozen v2 from its own lease', async () => {
    const { FantasyGround } = await import('./fantasyGround');
    const loader = vi.fn(async context => {
      const size = baseGroundArt(context).sourceSize;
      return { width: size, height: size, data: new Uint8Array(size * size * 4).fill(context.groundRevision ?? 0) };
    });
    const cache = new GroundSourceCache(loader);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    let painted: Uint8ClampedArray | undefined;
    vi.stubGlobal('document', groundDocument(image => { painted = image.data; }));
    const textures = new Set<string>();
    const display = () => ({ setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setDisplaySize: vi.fn().mockReturnThis(), setFillStyle: vi.fn(), destroy: vi.fn() });
    const scene = {
      add: { rectangle: display, image: display, graphics: () => ({ setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn() }) },
      events: new EventEmitter(), cameras: { main: { setBackgroundColor: vi.fn(), worldView: { x: 0, y: 0, width: 0, height: 0 } } },
      textures: { exists: (key: string) => textures.has(key), remove: (key: string) => textures.delete(key),
        create: vi.fn((key: string) => { textures.add(key); return { add: vi.fn(), setFilter: vi.fn() }; }) },
    };
    const ground = new FantasyGround(scene as never, 0, 2, 64, cache);
    const frozen: BaseVisualContext = { version: 1, realmId: 'crownlands', artVersion: 2 };
    try {
      for (const [index, context] of [frozen, FROZEN_CLEARING_V1, frozen].entries()) {
        ground.set(context); await new Promise(resolve => setTimeout(resolve, 0)); finishPainting(scene, ground);
        expect(ground.diagnostics.state).toBe('ready');
        expect(painted?.[0]).toBe(context.groundRevision ?? 0);
        expect(scene.textures.create).toHaveBeenCalledTimes(index + 1);
        expect(textures.size).toBe(1);
      }
      expect(loader).toHaveBeenCalledTimes(2);
    } finally { ground.destroy(); cache.clearIdle(); }
    expect(cache.size).toBe(0); expect(textures.size).toBe(0);
  });

  it('drops late old-realm painting and releases GPU textures when a reused scene leaves', async () => {
    const { FantasyGround } = await import('./fantasyGround');
    const pending = new Map<string, (value: typeof pixels) => void>();
    const cache = new GroundSourceCache(async context => new Promise(resolve => {
      pending.set(context.realmId, resolve);
    }), 0, 0);
    const windowEvents = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('window', windowEvents);
    vi.stubGlobal('document', groundDocument());
    const textures = new Set<string>();
    const display = () => ({ setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setDisplaySize: vi.fn().mockReturnThis(), setFillStyle: vi.fn(), destroy: vi.fn() });
    const backdrop = display(), image = display();
    const scene = {
      add: { rectangle: () => backdrop, image: vi.fn(() => image), graphics: () => ({
        setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn(),
      }) },
      events: new EventEmitter(),
      cameras: { main: { setBackgroundColor: vi.fn(), worldView: { x: 0, y: 0, width: 0, height: 0 } } },
      textures: {
        exists: (key: string) => textures.has(key), remove: vi.fn((key: string) => textures.delete(key)),
        create: vi.fn((key: string) => {
          textures.add(key);
          return { add: vi.fn(), setFilter: vi.fn() };
        }),
      },
    };
    const ground = new FantasyGround(scene as never, 0, 2, 64, cache);
    try {
      ground.set(DEFAULT_BASE_VISUAL);
      ground.set({ ...DEFAULT_BASE_VISUAL, realmId: 'frostveil' });
      pending.get('crownlands')!(pixels);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(scene.textures.create).not.toHaveBeenCalled();
      pending.get('frostveil')!(pixels);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(ground.diagnostics.state).toBe('ready');
      expect(scene.textures.create).toHaveBeenCalledTimes(1);
      ground.set({ ...DEFAULT_BASE_VISUAL, realmId: 'frostveil' });
      expect(scene.textures.create).toHaveBeenCalledTimes(1);
      ground.set(DEFAULT_BASE_VISUAL); // a second fetch is still decoding at full game teardown
      scene.events.emit('destroy'); ground.destroy();
      pending.get('crownlands')!(pixels);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(scene.textures.create).toHaveBeenCalledTimes(1);
      expect(scene.events.eventNames()).toEqual([]);
      expect(image.destroy).toHaveBeenCalledTimes(1);
      expect(backdrop.destroy).toHaveBeenCalledTimes(1);
      expect(textures.size).toBe(0);
      expect(cache.size).toBe(0);
      // The transfer owns automatic recovery. A page-level online listener must
      // not restart an exhausted shared episode after scene destruction.
      expect(windowEvents.addEventListener).not.toHaveBeenCalledWith('online', expect.any(Function));
    } finally { ground.destroy(); vi.unstubAllGlobals(); }
  });
});

describe('ready battle coverage refresh', () => {
  async function fixture(corner = 0, tiles = 2) {
    const { FantasyGround } = await import('./fantasyGround');
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time += 5);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const painted: number[] = [];
    vi.stubGlobal('document', groundDocument(image => painted.push(image.data[0]!)));
    const motion = vi.spyOn(FantasyGroundMotion.prototype, 'set');
    const loader = vi.fn(async (context: BaseVisualContext) => {
      const size = baseGroundArt(context).sourceSize;
      return { width: size, height: size, data: new Uint8Array(size * size * 4).fill(context.groundRevision ?? 0) };
    });
    const cache = new GroundSourceCache(loader, 0, 0), textures = new Set<string>();
    const display = () => ({ setOrigin: vi.fn().mockReturnThis(), setDepth: vi.fn().mockReturnThis(),
      setDisplaySize: vi.fn().mockReturnThis(), setFillStyle: vi.fn(), destroy: vi.fn() });
    const scene = { events: new EventEmitter(), input: { enabled: true }, time: { paused: false }, tweens: { paused: false },
      cameras: { main: { visible: true, setBackgroundColor: vi.fn(), worldView: { x: 0, y: 0, width: 0, height: 0 } } },
      add: { rectangle: display, image: vi.fn(display), graphics: () => ({ setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn() }) },
      textures: { exists: (key: string) => textures.has(key), remove: (key: string) => textures.delete(key),
        create: vi.fn((key: string) => { textures.add(key); return { add: vi.fn(), setFilter: vi.fn() }; }) } };
    const gate = new SceneVisualGate(scene as never, 'battle', () => {});
    const loading = vi.fn(() => gate.loading());
    const ground = new FantasyGround(scene as never, corner, tiles, 64, cache, loading);
    scene.events.on('update', () => gate.update(ground.diagnostics, false));
    ground.set(FROZEN_CLEARING_V1);
    await new Promise(resolve => setTimeout(resolve, 0)); finishPainting(scene, ground);
    const visible = () => {
      expect(scene.cameras.main.visible).toBe(true); expect(scene.input.enabled).toBe(true);
      expect(scene.time.paused).toBe(false); expect(scene.tweens.paused).toBe(false);
    };
    visible();
    motion.mockClear();
    return { ground, gate, scene, loader, cache, textures, loading, visible, painted, motion, display,
      destroy: () => { ground.destroy(); gate.destroy(); cache.clearIdle(); } };
  }

  it('keeps a running battle visible and playable while only the latest resized crop prepares', async () => {
    const f = await fixture();
    try {
      const original = f.scene.add.image.mock.results[0]!.value;
      f.ground.setCoverage({ x: -64, y: -64, width: 256, height: 256 });
      f.scene.events.emit('update'); f.visible();
      expect(original.destroy).not.toHaveBeenCalled(); expect(f.textures.size).toBe(1);
      f.ground.setCoverage({ x: -128, y: -128, width: 384, height: 384 });
      f.scene.events.emit('update'); f.visible();
      f.ground.setCoverage({ x: 0, y: 0, width: 128, height: 128 });
      f.scene.events.emit('update'); f.visible();
      expect(f.ground.diagnostics.phase).toBe('ready');
      expect(f.scene.textures.create).toHaveBeenCalledTimes(1);
      f.ground.setCoverage({ x: -128, y: -128, width: 384, height: 384 });
      finishPainting(f.scene, f.ground); f.visible();
      expect(f.scene.textures.create).toHaveBeenCalledTimes(2);
      expect(f.ground.diagnostics.width).toBe(192); expect(f.ground.diagnostics.height).toBe(192);
      expect(original.destroy).toHaveBeenCalledTimes(1); expect(f.textures.size).toBe(1);
      expect(f.loading).toHaveBeenCalledTimes(1); expect(f.loader).toHaveBeenCalledTimes(1);
      expect(f.motion).not.toHaveBeenCalled();
    } finally { f.destroy(); }
  });

  it('changes only edge geometry when the same authored painting already covers the camera', async () => {
    const art = baseGroundArt(FROZEN_CLEARING_V1), f = await fixture(art.worldOriginTiles, art.worldTiles);
    try {
      const origin = art.worldOriginTiles * 64, size = art.worldTiles * 64;
      const original = f.scene.add.image.mock.results[0]!.value;
      for (const padding of [64, 128, 64, 192]) {
        f.ground.setCoverage({ x: origin - padding, y: origin, width: size + padding * 2, height: size });
        f.scene.events.emit('update'); f.visible();
        expect(f.ground.diagnostics.phase).toBe('ready');
      }
      expect(f.scene.textures.create).toHaveBeenCalledTimes(1);
      expect(original.destroy).not.toHaveBeenCalled(); expect(f.textures.size).toBe(1);
      expect(f.loading).toHaveBeenCalledTimes(1);
    } finally { f.destroy(); }
  });

  it('disposes a partial replacement after an edge allocation fails while retaining the playable texture', async () => {
    const f = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const original = f.scene.add.image.mock.results[0]!.value;
      const replacement = f.display(), edge = f.display();
      f.scene.add.image.mockReturnValueOnce(replacement).mockReturnValueOnce(edge)
        .mockImplementationOnce(() => { throw new Error('edge allocation failed'); });
      const wider = { x: -4096, y: 0, width: 8704, height: 128 };
      f.ground.setCoverage(wider); finishPainting(f.scene, f.ground); f.visible();
      expect(f.ground.diagnostics.error).toBe('edge allocation failed');
      expect(original.destroy).not.toHaveBeenCalled();
      expect(replacement.destroy).toHaveBeenCalledTimes(1); expect(edge.destroy).toHaveBeenCalledTimes(1);
      expect(f.textures.size).toBe(1); expect(f.cache.size).toBe(1);
      f.ground.setCoverage(wider); finishPainting(f.scene, f.ground); f.visible();
      expect(f.ground.diagnostics.error).toBe(''); expect(f.textures.size).toBe(1);
      expect(f.loader).toHaveBeenCalledTimes(1); expect(f.motion).not.toHaveBeenCalled();
    } finally { f.destroy(); warning.mockRestore(); }
    expect(f.textures.size).toBe(0); expect(f.cache.size).toBe(0);
  });

  it.each(['revision', 'destroy'] as const)('discards a pending resized crop on %s without publishing it later', async (next) => {
    const f = await fixture();
    try {
      f.ground.setCoverage({ x: -128, y: -128, width: 384, height: 384 });
      f.scene.events.emit('update'); f.visible();
      if (next === 'destroy') {
        f.ground.destroy();
        for (let i = 0; i < 100; i++) f.scene.events.emit('update');
        expect(f.scene.textures.create).toHaveBeenCalledTimes(1);
        expect(f.textures.size).toBe(0); expect(f.cache.size).toBe(0);
        expect(f.painted).toEqual([FROZEN_CLEARING_V1.groundRevision]);
      } else {
        // Real art identity changes still cover immediately, even if the realm name is unchanged.
        f.ground.set({ version: 1, realmId: 'crownlands', artVersion: 2 });
        expect(f.scene.cameras.main.visible).toBe(false); expect(f.scene.time.paused).toBe(true);
        expect(f.textures.size).toBe(0);
        await new Promise(resolve => setTimeout(resolve, 0)); finishPainting(f.scene, f.ground); f.visible();
        expect(f.scene.textures.create).toHaveBeenCalledTimes(2);
        expect(f.loader).toHaveBeenCalledTimes(2); expect(f.textures.size).toBe(1);
        expect(f.painted).toEqual([FROZEN_CLEARING_V1.groundRevision, 0]);
      }
    } finally { f.destroy(); }
  });
});

describe('rectangular terrain coverage', () => {
  it('rounds outwards so fractional camera edges reveal complete ground tiles', () => {
    expect(groundCoverageRect(-14, 58, 64, { x: -900.1, y: -1408.1, width: 3800.2, height: 5000.2 }))
      .toEqual({ x: -960, y: -1472, width: 3904, height: 5120 });
    expect(groundCoverageRect(-14, 58, 64)).toEqual({ x: -896, y: -896, width: 3712, height: 3712 });
  });

  it('rejects invalid view coverage instead of allocating an unbounded texture', () => {
    expect(() => groundCoverageRect(-14, 58, 64, { x: 0, y: 0, width: Infinity, height: 200 })).toThrow('Invalid ground coverage');
    expect(() => groundCoverageRect(-14, 58, 64, { x: 0, y: 0, width: 0, height: 200 })).toThrow('Invalid ground coverage');
  });

  it.each([
    { x: -896, y: -1536, width: 3712, height: 5312 }, // 412×892 phone
    { x: -3648, y: -1088, width: 9216, height: 4480 }, // 1280×400 minimum zoom
    { x: -1088, y: -3648, width: 4480, height: 9216 }, // rotated extreme viewport
    { x: -4096, y: -4096, width: 10240, height: 10240 }, // all eight edge frames
  ])('covers every pixel with one bounded raster plus edge frames: %j', (coverage) => {
    const { paint, extensions } = groundPaintLayout(coverage, FROZEN_CLEARING_V1, 64);
    expect(paint.width / 2).toBeLessThanOrEqual(3136);
    expect(paint.height / 2).toBeLessThanOrEqual(3136);
    expect(extensions.length).toBeLessThanOrEqual(8);
    const rectangles = [paint, ...extensions.map(e => e.bounds)];
    expect(rectangles.reduce((sum, r) => sum + r.width * r.height, 0)).toBe(coverage.width * coverage.height);
    for (const [i, rect] of rectangles.entries()) {
      expect(rect.x).toBeGreaterThanOrEqual(coverage.x);
      expect(rect.y).toBeGreaterThanOrEqual(coverage.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(coverage.x + coverage.width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(coverage.y + coverage.height);
      for (const other of rectangles.slice(i + 1)) {
        const overlapW = Math.min(rect.x + rect.width, other.x + other.width) - Math.max(rect.x, other.x);
        const overlapH = Math.min(rect.y + rect.height, other.y + other.height) - Math.max(rect.y, other.y);
        expect(overlapW <= 0 || overlapH <= 0, 'no overlap may conceal an uncovered strip').toBe(true);
      }
    }
    if (extensions.length === 0) expect(paint).toEqual(coverage);
  });

  it('edge frames reproduce the shared world sampler instead of stretching terrain features', () => {
    const art = baseGroundArt(FROZEN_CLEARING_V1), size = art.sourceSize;
    const source = { width: size, height: size, data: new Uint8Array(size * size * 4) };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      source.data.set([x % 256, y % 256, 83, 255], (y * size + x) * 4);
    }
    const { paint, extensions } = groundPaintLayout({ x: -4096, y: -4096, width: 10240, height: 10240 }, FROZEN_CLEARING_V1, 64);
    expect(extensions).toHaveLength(8);
    for (const { bounds, source: frame } of extensions) {
      const worldSample = renderGroundPixels(source, FROZEN_CLEARING_V1, 1, 1,
        (bounds.x + bounds.width / 2) / 2, (bounds.y + bounds.height / 2) / 2);
      const frameSample = renderGroundPixels(source, FROZEN_CLEARING_V1, 1, 1,
        paint.x / 2 + frame.x + Math.floor(frame.width / 2), paint.y / 2 + frame.y + Math.floor(frame.height / 2));
      expect(frameSample).toEqual(worldSample);
    }
  });
});


function motionScene() {
  const documentEvents = new EventTarget();
  const doc = Object.assign(documentEvents, { hidden: false });
  const media = Object.assign(new EventTarget(), { matches: false });
  const removeDocument = vi.spyOn(doc, 'removeEventListener');
  const removeMedia = vi.spyOn(media, 'removeEventListener');
  let profile = false;
  vi.stubGlobal('window', { matchMedia: () => media });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('localStorage', { getItem: () => profile ? '1' : '0' });
  const graphics = { setDepth: vi.fn().mockReturnThis(), clear: vi.fn(), destroy: vi.fn(),
    fillStyle: vi.fn(), lineStyle: vi.fn(), fillRect: vi.fn(), fillCircle: vi.fn(),
    fillEllipse: vi.fn(), strokeEllipse: vi.fn(), fillTriangle: vi.fn(), lineBetween: vi.fn() };
  const events = new EventEmitter();
  const view = { x: -2176, y: -2176, width: 6272, height: 6272,
    get right() { return this.x + this.width; }, get bottom() { return this.y + this.height; } };
  const camera = { worldView: view, zoom: 1 };
  const scene = { add: { graphics: () => graphics }, events, cameras: { main: camera } };
  const motion = new FantasyGroundMotion(scene as never, 64);
  return { motion, graphics, events, view, camera, doc, media, removeDocument, removeMedia,
    setProfile: (value: boolean) => { profile = value; } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// Frozen v2 colour-classifier guarantees remain independent of the current art revision.
const LEGACY_MOTION_VISUAL: BaseVisualContext = { version: 1, realmId: 'crownlands', artVersion: 2 };
const legacyMotionVisual = (realmId: BaseVisualContext['realmId']): BaseVisualContext => ({ version: 1, realmId, artVersion: 2 });

describe('authored revision2 realm motion', () => {
  it.each(REALM_IDS)('registers %s features in source coordinates, before ambient culling, without marks in the building square', realmId => {
    const context: BaseVisualContext = { version: 1, realmId, artVersion: 2, groundRevision: 2 };
    const features = groundEnvironmentFeatures(context)!;
    const art = baseGroundArt(context);
    const ambient = [{ x: 100, y: 100, seed: 900 }, { x: -100, y: 50, seed: 901 }];
    for (const tilePx of [32, 64]) {
      const points = revisionGroundMotes(context, tilePx, ambient)!;
      expect(points).toHaveLength(features.length + 1);
      features.forEach((seat, index) => {
        expect(points[index]!.x).toBeCloseTo((art.worldOriginTiles + seat.x / art.sourceSize * art.worldTiles) * tilePx, 9);
        expect(points[index]!.y).toBeCloseTo((art.worldOriginTiles + seat.y / art.sourceSize * art.worldTiles) * tilePx, 9);
        expect(points[index]).toMatchObject({ feature: seat.kind, seed: seat.seed });
        expect(points[index]!.width).toBeCloseTo(seat.width / art.sourceSize * art.worldTiles * tilePx, 9);
        expect(points[index]!.height).toBeCloseTo(seat.height / art.sourceSize * art.worldTiles * tilePx, 9);
      });
      expect(points.at(-1)).toEqual(ambient[1]);
    }
    expect(revisionGroundMotes(legacyMotionVisual(realmId), 64, ambient)).toBeUndefined();
  });
  it('never samples new terrain RGB and culls authored accents from an actor-only center view', () => {
    const env = motionScene();
    try {
      const context: BaseVisualContext = { version: 1, realmId: 'thornwake', artVersion: 2, groundRevision: 2 };
      const data = new Proxy(new Uint8Array(), { get() { throw Error('revision2 must not classify source colors'); } });
      env.motion.set(context, { width: 1536, height: 1536, data });
      expect(env.motion.diagnostics.featurePoints).toBe(groundEnvironmentFeatures(context)!.length);
      env.events.emit('update', 0);
      expect(env.motion.diagnostics.visiblePoints).toBeLessThanOrEqual(BASE_GROUND_MOTION.maxVisiblePoints);
      expect(env.graphics.lineBetween).toHaveBeenCalled();
      env.view.x = 500; env.view.y = 500; env.view.width = 200; env.view.height = 200;
      env.events.emit('update', BASE_GROUND_MOTION.frameMs);
      expect(env.motion.diagnostics.visiblePoints).toBe(0);
    } finally { env.motion.destroy(); }
  });
  it('animates every authored feature with bounded primitives and respects hidden and reduced-motion pause', () => {
    const env = motionScene();
    try {
      for (const realmId of REALM_IDS) {
        env.motion.set({ version: 1, realmId, artVersion: 2, groundRevision: 2 });
        env.events.emit('update', 0);
        expect(env.motion.diagnostics.featurePoints).toBe(groundEnvironmentFeatures({ version: 1, realmId, artVersion: 2, groundRevision: 2 })!.length);
        expect(env.motion.diagnostics.visiblePoints).toBeLessThanOrEqual(BASE_GROUND_MOTION.maxVisiblePoints);
      }
      const redraws = env.motion.diagnostics.redraws;
      env.doc.hidden = true; env.doc.dispatchEvent(new Event('visibilitychange'));
      env.events.emit('update', 1_000_000);
      expect(env.motion.diagnostics.redraws).toBe(redraws);
      env.doc.hidden = false; env.media.matches = true; env.media.dispatchEvent(new Event('change'));
      env.events.emit('update', 2_000_000);
      expect(env.motion.diagnostics.redraws).toBe(redraws);
      expect(env.motion.diagnostics.paused).toBe(true);
      env.media.matches = false; env.media.dispatchEvent(new Event('change'));
      env.events.emit('update', 2_000_001);
      expect(env.motion.diagnostics.redraws).toBe(redraws + 1);
    } finally { env.motion.destroy(); }
  });
});

describe('world-anchored realm motion', () => {
  it.each([0.18, 0.35])('keeps every realm visible at phone fit zoom %s with bounded primitives', (zoom) => {
    const env = motionScene(); env.camera.zoom = zoom;
    try {
      for (const realmId of REALM_IDS) {
        for (const method of ['fillRect', 'fillCircle', 'fillEllipse', 'lineStyle'] as const) env.graphics[method].mockClear();
        env.motion.set(legacyMotionVisual(realmId)); env.events.emit('update', 0);
        const shortEdges = [
          ...env.graphics.fillRect.mock.calls.map((call) => Math.min(call[2], call[3]) * zoom),
          ...env.graphics.fillEllipse.mock.calls.map((call) => Math.min(call[2], call[3]) * zoom),
          ...env.graphics.fillCircle.mock.calls.map((call) => call[2] * 2 * zoom),
        ];
        const strokes = env.graphics.lineStyle.mock.calls.map((call) => call[0] * zoom);
        expect(shortEdges.length + strokes.length, realmId).toBeGreaterThan(0);
        for (const edge of shortEdges) expect(edge, realmId).toBeGreaterThanOrEqual(BASE_GROUND_MOTION.minAmbientScreenPx);
        for (const stroke of strokes) expect(stroke, realmId).toBeGreaterThanOrEqual(BASE_GROUND_MOTION.minStrokeScreenPx);
        expect(env.motion.diagnostics.visiblePoints).toBeLessThanOrEqual(BASE_GROUND_MOTION.maxVisiblePoints);
      }
    } finally { env.motion.destroy(); }
  });

  it('moves ambient leaves by visible pixels at fit zoom without resampling the painting', () => {
    const env = motionScene(); env.camera.zoom = 0.18;
    try {
      env.motion.set(LEGACY_MOTION_VISUAL);
      const positions: number[] = [];
      for (let frame = 0; frame < 50; frame++) {
        env.graphics.fillEllipse.mockClear();
        env.events.emit('update', frame * BASE_GROUND_MOTION.frameMs);
        positions.push(env.graphics.fillEllipse.mock.calls[0]![0] * env.camera.zoom);
      }
      expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(BASE_GROUND_MOTION.minDriftScreenPx);
      expect(env.motion.diagnostics.cachedPoints).toBeGreaterThan(BASE_GROUND_MOTION.maxVisiblePoints);
    } finally { env.motion.destroy(); }
  });

  it('does not turn the accepted blue pines, slate, violet soil or dry ash into terrain features', () => {
    const env = motionScene();
    const size = baseGroundArt(LEGACY_MOTION_VISUAL).sourceSize;
    const cases = [
      { realmId: 'frostveil', rgb: [96, 120, 148] },
      { realmId: 'stormcairn', rgb: [108, 124, 132] },
      { realmId: 'seeker-reach', rgb: [124, 99, 138] },
      { realmId: 'cinderfall', rgb: [144, 100, 64] },
    ] as const;
    try {
      for (const { realmId, rgb } of cases) {
        const data = new Uint8Array(size * size * 4);
        for (let at = 0; at < data.length; at += 4) data.set([...rgb, 255], at);
        env.motion.set(legacyMotionVisual(realmId), { width: size, height: size, data });
        expect(env.motion.diagnostics.featurePoints).toBe(0);
      }
    } finally { env.motion.destroy(); }
  });

  it('anchors ripples to painted water and keeps dry ground free of water highlights', () => {
    const env = motionScene();
    const size = baseGroundArt(LEGACY_MOTION_VISUAL).sourceSize;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const at = (y * size + x) * 4;
        data.set(x < size / 2 ? [55, 150, 185, 255] : [160, 130, 80, 255], at);
      }
    }
    try {
      env.motion.set(LEGACY_MOTION_VISUAL, { width: size, height: size, data });
      env.events.emit('update', 0);
      expect(env.motion.diagnostics.featurePoints).toBeGreaterThan(0);
      expect(env.motion.diagnostics.featurePoints).toBeLessThan(env.motion.diagnostics.cachedPoints);
      const art = baseGroundArt(LEGACY_MOTION_VISUAL);
      const waterEdge = (art.worldOriginTiles + art.worldTiles / 2) * 64;
      expect(env.graphics.strokeEllipse).toHaveBeenCalled();
      for (const [x] of env.graphics.strokeEllipse.mock.calls) expect(x).toBeLessThan(waterEdge);
      env.graphics.strokeEllipse.mockClear();
      env.view.x = waterEdge + 128; env.view.y = 0; env.view.width = 1000; env.view.height = 1000;
      env.events.emit('update', BASE_GROUND_MOTION.frameMs);
      expect(env.graphics.strokeEllipse).not.toHaveBeenCalled();
    } finally { env.motion.destroy(); }
  });

  it('adds ice, crystal and vent detail only when the decoded realm painting supports it', () => {
    const env = motionScene();
    const cases = [
      { realmId: 'frostveil', rgb: [180, 210, 230], method: env.graphics.lineBetween },
      { realmId: 'seeker-reach', rgb: [95, 200, 170], method: env.graphics.fillTriangle },
      { realmId: 'cinderfall', rgb: [156, 145, 131], method: env.graphics.fillEllipse },
    ] as const;
    const size = baseGroundArt(LEGACY_MOTION_VISUAL).sourceSize;
    try {
      for (const test of cases) {
        const data = new Uint8Array(size * size * 4);
        const [r, g, b] = test.rgb;
        for (let at = 0; at < data.length; at += 4) data.set([r, g, b, 255], at);
        env.motion.set(legacyMotionVisual(test.realmId), { width: size, height: size, data });
        env.events.emit('update', 0);
        expect(env.motion.diagnostics.featurePoints).toBeGreaterThan(0);
        expect(test.method).toHaveBeenCalled();
      }
    } finally { env.motion.destroy(); }
  });

  it('bounds redraw frequency and visible marks without allocating another terrain texture', () => {
    const env = motionScene();
    try {
      env.motion.set(LEGACY_MOTION_VISUAL);
      env.events.emit('update', 0);
      expect(env.graphics.setDepth).toHaveBeenCalledWith(0.5);
      expect(env.motion.diagnostics.visiblePoints).toBe(BASE_GROUND_MOTION.maxVisiblePoints);
      expect(env.motion.diagnostics.cachedPoints).toBeGreaterThan(BASE_GROUND_MOTION.maxVisiblePoints);
      for (let time = 1; time < BASE_GROUND_MOTION.frameMs; time++) env.events.emit('update', time);
      expect(env.motion.diagnostics.redraws).toBe(1);
      env.view.x = 0; env.view.y = 0; env.view.width = 300; env.view.height = 300;
      env.events.emit('update', BASE_GROUND_MOTION.frameMs);
      expect(env.motion.diagnostics.visiblePoints).toBeLessThan(10);
      env.view.x = 100_000;
      env.events.emit('update', BASE_GROUND_MOTION.frameMs * 2);
      expect(env.motion.diagnostics.visiblePoints).toBe(0);
      expect(env.motion.diagnostics.redraws).toBe(3);
    } finally { env.motion.destroy(); }
  });

  it('pauses for profile, OS, hidden tabs and sleeping scenes without catch-up bursts', () => {
    const env = motionScene();
    const frame = BASE_GROUND_MOTION.frameMs;
    try {
      env.motion.set(legacyMotionVisual('frostveil'));
      env.events.emit('update', 0);
      env.setProfile(true);
      env.events.emit('update', frame);
      expect(env.motion.diagnostics.paused).toBe(true);
      env.setProfile(false);
      env.events.emit('update', frame * 2);
      expect(env.motion.diagnostics.redraws).toBe(2);
      env.media.matches = true; env.media.dispatchEvent(new Event('change'));
      expect(env.motion.diagnostics.paused).toBe(true);
      env.events.emit('update', frame * 3);
      env.media.matches = false; env.media.dispatchEvent(new Event('change'));
      env.doc.hidden = true; env.doc.dispatchEvent(new Event('visibilitychange'));
      env.events.emit('update', frame * 4);
      expect(env.motion.diagnostics.redraws).toBe(2);
      env.doc.hidden = false; env.doc.dispatchEvent(new Event('visibilitychange'));
      env.events.emit('update', frame * 5);
      env.events.emit('sleep');
      expect(env.motion.diagnostics.paused).toBe(true);
      env.events.emit('update', frame * 6);
      env.events.emit('wake');
      env.events.emit('update', 1_000_000);
      expect(env.motion.diagnostics.redraws).toBe(4);
      env.events.emit('pause'); env.events.emit('update', 2_000_000);
      expect(env.motion.diagnostics.redraws).toBe(4);
      env.events.emit('resume'); env.events.emit('update', 2_000_001);
      expect(env.motion.diagnostics.redraws).toBe(5);
    } finally { env.motion.destroy(); }
  });

  it('uses restrained realm-specific marks while preserving motionless historical art', () => {
    const env = motionScene();
    try {
      env.motion.set(DEFAULT_BASE_VISUAL); env.events.emit('update', 0);
      expect(env.motion.diagnostics.cachedPoints).toBe(0);
      for (const realmId of REALM_IDS) {
        env.motion.set(legacyMotionVisual(realmId));
        env.events.emit('update', 0);
        expect(env.motion.diagnostics.visiblePoints).toBeLessThanOrEqual(BASE_GROUND_MOTION.maxVisiblePoints);
      }
      expect(env.motion.diagnostics.redraws).toBe(REALM_IDS.length);
      expect(env.graphics.lineBetween).toHaveBeenCalled();
      expect(env.graphics.fillEllipse).toHaveBeenCalled();
      expect(env.graphics.fillCircle).toHaveBeenCalled();
      env.motion.set(null);
      expect(env.motion.diagnostics.paused).toBe(true);
      expect(env.motion.diagnostics.cachedPoints).toBe(0);
    } finally { env.motion.destroy(); }
    env.motion.destroy();
    expect(env.events.eventNames()).toEqual([]);
    expect(env.removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(env.removeMedia).toHaveBeenCalledWith('change', expect.any(Function));
    expect(env.graphics.destroy).toHaveBeenCalledTimes(1);
  });
});
