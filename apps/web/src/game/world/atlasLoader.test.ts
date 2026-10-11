/**
 * The on-demand `trpdg_l<N>` loader.
 *
 * WHAT MAKES THIS WORTH TESTING: textures are game-global while requests belong
 * to scenes that can shut down at any point. The loader must share one fetch,
 * abort every unfinished response/body/decode on failure, and never expose a
 * Phaser staging texture that can arrive after its owner has gone away.
 */
import { ATLAS_PREFIXES, trpdgGroup } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admitOnDemandAtlasCandidates, ensureTroopLevelAtlases, ensureV2Atlases,
  isTroopLevelAtlasLoaded, isV2AtlasLoaded, onDemandAtlasState, releaseAtlasGroups,
  releaseAtlasReservations, releaseUnreferencedAtlases, releaseUnusedAtlases,
  retainAtlasGroups, ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS,
} from './atlasLoader';
import { ART_PROFILE_REGISTRY_KEY } from './atlasTexels';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  browserFakesInstalled = false;
});

/** Shape the asset pipeline emits (free-tex-packer): one texture, many frames. */
const packerJson = (group: string) => ({
  textures: [{ frames: [{ filename: `${group}_frame` }] }],
  meta: {},
});

/**
 * REAL packed dimensions, read off apps/web/public/atlas/*.json (2026-08-08), so
 * the reclaimed-VRAM arithmetic the eviction tests assert is the arithmetic the
 * shipped atlases produce and not a made-up number: RGBA, no mips, w*h*4.
 * A dragon tier alone is 28.1MB — the reason any of this exists.
 */
const ATLAS_PX: Record<string, [number, number]> = {
  [trpdgGroup(7)]: [1482, 1456], // 8.2MiB @2x
  v2trp_dragon_t2: [2656, 2772], // 28.1MiB
  v2trp_giant_t2: [2242, 2124], // 18.2MiB
  v2trp_bowman_t1: [1836, 1836], // 12.9MiB
  v2bld_cannon_t1: [1534, 1638], // 9.6MiB
  v2bld_mortar_t3: [1652, 1638], // 10.3MiB
  v2fx: [2034, 2012], // 15.6MiB
};
const bytesOf = (...groups: string[]): number =>
  groups.reduce((n, g) => {
    const [w, h] = ATLAS_PX[g] ?? [1, 1];
    return n + w * h * 4;
  }, 0);

/** A decoded image, as Phaser hands one to addAtlas — its size becomes the
 *  texture's source size, which is what the loader measures VRAM from. */
const fakeImage = (group: string): { width: number; height: number } => {
  const [width, height] = ATLAS_PX[group] ?? [1, 1];
  return { width, height };
};

/** Browser byte/decode stand-ins for the shared no-staging load path. */
function stubByteAtlas(group: string): {
  fetchMock: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
  jsonText: ReturnType<typeof vi.spyOn>;
  images: Array<{ src: string }>;
  signals: AbortSignal[];
} {
  const jsonBlob = new Blob([JSON.stringify(packerJson(group))]);
  const jsonText = vi.spyOn(jsonBlob, 'text');
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return {
      ok: true,
      blob: async () => String(input).includes('.json') ? jsonBlob : new Blob(['png']),
    } as Response;
  });
  const decode = vi.fn(async () => undefined);
  const [width, height] = ATLAS_PX[group] ?? [1, 1];
  const images: Array<{ src: string }> = [];
  class DecodedImage {
    src = '';
    width = width;
    height = height;
    naturalWidth = width;
    naturalHeight = height;
    decode = decode;
    constructor() { images.push(this); }
  }
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('Image', DecodedImage);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:atlas-test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  return { fetchMock, decode, jsonText, images, signals };
}

class FakeTextures {
  readonly entries = new Map<string, { width: number; height: number }>();
  /** Every addAtlas call, in order — double-registration shows up here. */
  readonly added: Array<{ key: string; frames: unknown }> = [];
  exists(key: string): boolean {
    return this.entries.has(key);
  }
  /** Real Phaser wraps the source image in a TextureSource carrying its pixel
   *  size; the eviction estimate reads that, so the fake must carry it too. */
  get(key: string): { getSourceImage: () => unknown; source: Array<{ width: number; height: number }> } {
    const img = this.entries.get(key);
    return {
      getSourceImage: () => img,
      source: img ? [{ width: img.width, height: img.height }] : [],
    };
  }
  addAtlas(key: string, img: unknown, data: { frames: unknown }): void {
    this.added.push({ key, frames: data.frames });
    this.entries.set(key, img as { width: number; height: number });
  }
  /** Real Phaser has this; retries use it to retire any legacy staging orphan. */
  remove(key: string): void {
    this.entries.delete(key);
  }
}

interface QueuedFile {
  key: string;
  type: 'image' | 'json';
}

class FakeSceneLoader {
  queued: QueuedFile[] = [];
  /** Files actually delivered — a second fetch of a level shows up here twice. */
  readonly delivered: string[] = [];
  starts = 0;
  private listeners: Array<{
    event: string;
    fn: (...args: unknown[]) => void;
    once: boolean;
  }> = [];

  constructor(
    private readonly textures: FakeTextures,
    private readonly jsonCache: Map<string, unknown>,
  ) {}

  /** URL each file was requested with — the @1x/@2x pin below reads these. */
  readonly urls = new Map<string, string>();

  once(event: string, fn: (...args: unknown[]) => void): void {
    this.listeners.push({ event, fn, once: true });
  }
  on(event: string, fn: (...args: unknown[]) => void): void {
    this.listeners.push({ event, fn, once: false });
  }
  off(event: string, fn: (...args: unknown[]) => void): void {
    this.listeners = this.listeners.filter((l) => l.event !== event || l.fn !== fn);
  }
  image(key: string, url?: string): void {
    if (url) this.urls.set(key, url);
    this.add({ key, type: 'image' });
  }
  json(key: string, url?: string): void {
    if (url) this.urls.set(key, url);
    this.add({ key, type: 'json' });
  }
  start(): void {
    this.starts++;
  }

  /** Phaser drops a file whose key is already cached or already queued. */
  private add(file: QueuedFile): void {
    const cached =
      file.type === 'image' ? this.textures.exists(file.key) : this.jsonCache.has(file.key);
    if (cached) return;
    if (this.queued.some((q) => q.key === file.key && q.type === file.type)) return;
    this.queued.push(file);
  }

  /**
   * Run the batch to completion. Files listed in `fail` error; COMPLETE still
   * fires, exactly as Phaser does — a failed file is counted, not fatal.
   */
  settle(fail: string[] = []): void {
    this.settleFiles(this.queued.map((file) => file.key), fail);
  }

  /** Deliver only named files. Anything else remains in the shared batch, so
   * global COMPLETE deliberately does not fire. */
  settleFiles(keys: string[], fail: string[] = []): void {
    const wanted = new Set(keys);
    const delivered = this.queued.filter((file) => wanted.has(file.key));
    this.queued = this.queued.filter((file) => !wanted.has(file.key));
    for (const f of delivered) {
      if (fail.includes(f.key)) {
        this.emit('loaderror', f);
        continue;
      }
      this.delivered.push(f.key);
      if (f.type === 'image') {
        this.textures.entries.set(f.key, fakeImage(f.key.slice(0, -'-img'.length)));
      }
      else this.jsonCache.set(f.key, packerJson(f.key.slice(0, -'-json'.length)));
      this.emit(`filecomplete-${f.type}-${f.key}`);
    }
    if (this.queued.length === 0) this.emit('complete');
  }

  private emit(event: string, ...args: unknown[]): void {
    const fire = this.listeners.filter((listener) => listener.event === event);
    this.listeners = this.listeners.filter((listener) =>
      listener.event !== event || !listener.once);
    for (const listener of fire) listener.fn(...args);
  }
}

interface PendingAtlasFile extends QueuedFile {
  resolve: (response: Response) => void;
  reject: (cause: Error) => void;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

const blobGroups = new WeakMap<Blob, string>();
let browserFakesInstalled = false;

function installBrowserDecodeFakes(): void {
  if (browserFakesInstalled) return;
  browserFakesInstalled = true;
  class DecodedImage {
    private value = '';
    width = 1;
    height = 1;
    naturalWidth = 1;
    naturalHeight = 1;
    set src(value: string) {
      this.value = value;
      const group = value.startsWith('blob:atlas-test:')
        ? value.slice('blob:atlas-test:'.length)
        : '';
      const [width, height] = ATLAS_PX[group] ?? [1, 1];
      this.width = this.naturalWidth = width;
      this.height = this.naturalHeight = height;
    }
    get src(): string { return this.value; }
    async decode(): Promise<void> { /* decoded immediately */ }
  }
  vi.stubGlobal('Image', DecodedImage);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) =>
    `blob:atlas-test:${blob instanceof Blob ? blobGroups.get(blob) ?? '' : ''}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
}

/** Deterministic stand-in for the abortable browser fetch pipeline. */
class FakeAtlasNetwork {
  readonly queued: PendingAtlasFile[] = [];
  readonly delivered: string[] = [];
  readonly urls = new Map<string, string>();
  starts = 0;

  readonly fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const match = url.match(/\/atlas\/(.+)@(1x|2x)\.(png|json)\?v=/);
    if (!match) return Promise.reject(new Error(`unexpected atlas URL ${url}`));
    const group = match[1]!;
    const type = match[3] === 'png' ? 'image' : 'json';
    const key = `${group}-${type === 'image' ? 'img' : 'json'}`;
    this.urls.set(key, url);
    this.starts++;
    return new Promise<Response>((resolve, reject) => {
      const file: PendingAtlasFile = {
        key, type, resolve, reject, signal: init?.signal ?? undefined,
      };
      file.onAbort = () => {
        const index = this.queued.indexOf(file);
        if (index >= 0) this.queued.splice(index, 1);
        reject(new Error(`${key} aborted`));
      };
      file.signal?.addEventListener('abort', file.onAbort, { once: true });
      this.queued.push(file);
    });
  };

  settle(fail: string[] = []): void {
    this.settleFiles(this.queued.map((file) => file.key), fail);
  }

  settleFiles(keys: string[], fail: string[] = []): void {
    const wanted = new Set(keys);
    for (const file of [...this.queued]) {
      if (!wanted.has(file.key)) continue;
      this.queued.splice(this.queued.indexOf(file), 1);
      if (file.onAbort) file.signal?.removeEventListener('abort', file.onAbort);
      const group = file.key.slice(0, file.type === 'image' ? -4 : -5);
      if (!fail.includes(file.key)) this.delivered.push(file.key);
      file.resolve({
        ok: !fail.includes(file.key),
        blob: async () => {
          const blob = new Blob([
            file.type === 'json' ? JSON.stringify(packerJson(group)) : 'png',
          ]);
          if (file.type === 'image') blobGroups.set(blob, group);
          return blob;
        },
      } as Response);
    }
  }
}

/**
 * The scene's own event emitter — only 'shutdown' matters here. Phaser RESETS a
 * stopped scene's loader (queue cleared, listeners dropped), so a batch still
 * downloading at that moment never reaches COMPLETE; `shutdown()` below models
 * exactly that, and NOT firing the loader afterwards is the point.
 */
class FakeEvents {
  private listeners: Array<{ event: string; fn: () => void }> = [];
  once(event: string, fn: () => void): void {
    this.listeners.push({ event, fn });
  }
  off(event: string, fn: () => void): void {
    this.listeners = this.listeners.filter((l) => !(l.event === event && l.fn === fn));
  }
  emit(event: string): void {
    const fire = this.listeners.filter((l) => l.event === event);
    this.listeners = this.listeners.filter((l) => l.event !== event);
    for (const l of fire) l.fn();
  }
}

/** One sprite on a scene's display list — all the eviction sweep reads is which
 *  texture it draws with. `list` models a Container's children (v2 breath). */
interface FakeChild { texture?: { key: string }; list?: FakeChild[] }

interface Harness {
  scene: Phaser.Scene;
  loader: FakeAtlasNetwork;
  sceneLoader: FakeSceneLoader;
  textures: FakeTextures;
  events: FakeEvents;
  /** This scene's display list — push a child to make a group "live on screen". */
  children: FakeChild[];
  /** Every scene of this game, as Phaser's SceneManager exposes them. */
  scenes: Phaser.Scene[];
}

/** JSON caches are per game, like the TextureManager they are paired with. */
const jsonCaches = new WeakMap<FakeTextures, Map<string, unknown>>();
const atlasNetworks = new WeakMap<FakeTextures, FakeAtlasNetwork>();

/** A scene — or, given one, a second scene of the SAME game (base + battle). */
function harness(sameGameAs?: Harness): Harness {
  const textures = sameGameAs ? sameGameAs.textures : new FakeTextures();
  const jsonCache = jsonCaches.get(textures) ?? new Map<string, unknown>();
  jsonCaches.set(textures, jsonCache);
  const loader = atlasNetworks.get(textures) ?? new FakeAtlasNetwork();
  atlasNetworks.set(textures, loader);
  const sceneLoader = new FakeSceneLoader(textures, jsonCache);
  installBrowserDecodeFakes();
  vi.stubGlobal('fetch', loader.fetch);
  const events = new FakeEvents();
  const children: FakeChild[] = [];
  const scenes: Phaser.Scene[] = sameGameAs ? sameGameAs.scenes : [];
  const scene = {
    textures,
    children: { list: children },
    game: { scene: { scenes } },
    events: {
      once: events.once.bind(events),
      off: events.off.bind(events),
    },
    load: {
      once: sceneLoader.once.bind(sceneLoader),
      on: sceneLoader.on.bind(sceneLoader),
      off: sceneLoader.off.bind(sceneLoader),
      image: sceneLoader.image.bind(sceneLoader),
      json: sceneLoader.json.bind(sceneLoader),
      start: sceneLoader.start.bind(sceneLoader),
    },
    cache: {
      json: {
        get: (key: string) => jsonCache.get(key),
        remove: (key: string) => { jsonCache.delete(key); },
      },
    },
  } as never as Phaser.Scene;
  scenes.push(scene);
  return { scene, loader, sceneLoader, textures, events, children, scenes };
}

const IMG = `${trpdgGroup(7)}-img`;
const JSON_KEY = `${trpdgGroup(7)}-json`;

describe('ensureTroopLevelAtlases', () => {
  it('registers the packer frames as an atlas once the batch completes', async () => {
    const { scene, loader, textures } = harness();
    const done = ensureTroopLevelAtlases(scene, [7]);
    expect(loader.queued.map((f) => f.key)).toEqual([IMG, JSON_KEY]);
    loader.settle();
    await done;

    // Frames must be unwrapped from textures[0]: handing Phaser the raw packer
    // file registers an atlas with no frames, and every dragon renders blank.
    expect(textures.added).toEqual([
      { key: 'trpdg_l7', frames: [{ filename: 'trpdg_l7_frame' }] },
    ]);
    expect(isTroopLevelAtlasLoaded(scene, 7)).toBe(true);
  });

  it('shares ONE load between concurrent callers for the same level', async () => {
    const { scene, loader, textures } = harness();
    const a = ensureTroopLevelAtlases(scene, [7]);
    const b = ensureTroopLevelAtlases(scene, [7]);
    loader.settle();
    await Promise.all([a, b]);

    // Without one-promise-per-level both callers fetch and register the same
    // large texture independently.
    expect(textures.added.map((t) => t.key)).toEqual(['trpdg_l7']);
    expect(loader.delivered).toEqual([IMG, JSON_KEY]);
  });

  it('fetches @1x for a constrained WebGL session and keeps Canvas on @2x', async () => {
    const webgl = harness();
    (webgl.scene.game as unknown as { renderer: { gl: object } }).renderer = { gl: {} };
    (webgl.scene as unknown as { registry: { get: (key: string) => unknown } }).registry = {
      get: (key) => key === ART_PROFILE_REGISTRY_KEY ? 'constrained' : undefined,
    };
    const webglLoad = ensureTroopLevelAtlases(webgl.scene, [7]);
    expect(webgl.loader.urls.get(IMG)).toMatch(/@1x\.png\?v=/);
    webgl.events.emit('shutdown');
    await expect(webglLoad).rejects.toThrow('shut down');

    const canvas = harness();
    (canvas.scene as unknown as { registry: { get: (key: string) => unknown } }).registry = {
      get: (key) => key === ART_PROFILE_REGISTRY_KEY ? 'constrained' : undefined,
    };
    const canvasLoad = ensureTroopLevelAtlases(canvas.scene, [7]);
    expect(canvas.loader.urls.get(IMG)).toMatch(/@2x\.png\?v=/);
    canvas.events.emit('shutdown');
    await expect(canvasLoad).rejects.toThrow('shut down');
  });

  it('de-duplicates a level repeated inside one request', () => {
    const { scene, loader } = harness();
    void ensureTroopLevelAtlases(scene, [7, 7, 7]);
    expect(loader.queued).toHaveLength(2);
  });

  it('never fetches a level that is already registered', async () => {
    const { scene, loader, textures } = harness();
    const first = ensureTroopLevelAtlases(scene, [7]);
    loader.settle();
    await first;
    const startsAfterFirst = loader.starts;

    const second = ensureTroopLevelAtlases(scene, [7]);

    // Checked BEFORE awaiting: touching the network at all is the observable
    // regression when the live TextureManager is already authoritative.
    expect(loader.starts).toBe(startsAfterFirst);
    await second;
    expect(loader.delivered).toEqual([IMG, JSON_KEY]);
    expect(textures.added).toHaveLength(1);
  });

  it('waits for every level in a multi-level request', async () => {
    const { scene, loader, textures } = harness();
    const done = ensureTroopLevelAtlases(scene, [5, 7]);
    expect(loader.queued.map((f) => f.key)).toEqual([
      'trpdg_l5-img', 'trpdg_l5-json', IMG, JSON_KEY,
    ]);
    loader.settle();
    await done;
    expect(textures.added.map((t) => t.key)).toEqual(['trpdg_l5', 'trpdg_l7']);
  });

  it('shares a load across two scenes of the same game', async () => {
    const base = harness();
    const battle = harness(base);
    const a = ensureTroopLevelAtlases(base.scene, [7]);
    const b = ensureTroopLevelAtlases(battle.scene, [7]);

    // Textures are game-global, so the second scene must ride the first fetch
    // rather than pull another 8.6MB through its own separate loader.
    expect(base.loader).toBe(battle.loader);
    expect(base.loader.queued).toHaveLength(2);
    expect(base.loader.starts).toBe(2);
    base.loader.settle();
    await Promise.all([a, b]);
    expect(base.textures.added.map((t) => t.key)).toEqual(['trpdg_l7']);
  });
});

describe('ensureTroopLevelAtlases failure', () => {
  it('REJECTS rather than hanging when the image never arrives', async () => {
    const { scene, loader, textures } = harness();
    const a = ensureTroopLevelAtlases(scene, [7]);
    const b = ensureTroopLevelAtlases(scene, [7]);
    loader.settle([IMG]);

    // Both waiters, not just the one that started it: a raid gated on this
    // would otherwise sit on an empty battlefield forever.
    await expect(a).rejects.toThrow('trpdg_l7');
    await expect(b).rejects.toThrow('trpdg_l7');
    expect(textures.added).toHaveLength(0);
    expect(isTroopLevelAtlasLoaded(scene, 7)).toBe(false);
  });

  it('REJECTS when the frame JSON never arrives', async () => {
    const { scene, loader, textures } = harness();
    const done = ensureTroopLevelAtlases(scene, [7]);
    loader.settle([JSON_KEY]);

    // The image alone would register an atlas with zero frames: a key that
    // exists and draws nothing. Failing loudly is the only way that surfaces.
    await expect(done).rejects.toThrow('trpdg_l7');
    expect(textures.added).toHaveLength(0);
  });

  it('REJECTS when the scene is stopped mid-download, and lets the next one retry', async () => {
    // Retreating during deploy must reject and clear the shared in-flight entry;
    // otherwise every later raid inherits the same dead promise all session.
    const first = harness();
    const abandoned = ensureTroopLevelAtlases(first.scene, [7]);
    first.events.emit('shutdown');
    await expect(abandoned).rejects.toThrow('trpdg_l7');

    // A new scene of the same game (textures are game-global) must start over.
    const next = harness(first);
    const retry = ensureTroopLevelAtlases(next.scene, [7]);
    expect(next.loader.queued.map((f) => f.key)).toEqual([IMG, JSON_KEY]);
    next.loader.settle();
    await retry;
    expect(next.textures.added.map((t) => t.key)).toEqual(['trpdg_l7']);
  });

  it('does not register after scene shutdown', () => {
    // Shutdown is terminal even if the transport harness is asked to settle afterward.
    const { scene, loader, textures, events } = harness();
    const abandoned = ensureTroopLevelAtlases(scene, [7]);
    void abandoned.catch(() => undefined); // handled; the assertion is below
    events.emit('shutdown');
    loader.settle();
    expect(textures.added).toEqual([]);
  });

  it('lets a failed level be retried', async () => {
    const { scene, loader, textures } = harness();
    const failed = ensureTroopLevelAtlases(scene, [7]);
    loader.settle([IMG, JSON_KEY]);
    await expect(failed).rejects.toThrow();

    const retry = ensureTroopLevelAtlases(scene, [7]);
    loader.settle();
    await retry;

    // An in-flight entry that is never cleared hands the retry the old
    // rejection, and that level can never load again for the whole session.
    expect(textures.added.map((t) => t.key)).toEqual(['trpdg_l7']);
  });
});

/**
 * Rework-v2 groups (Phase D) ride the SAME funnel — one in-flight promise per
 * group, texture state as the authority — with one difference that matters:
 * the v2 pack is packed @1x ONLY (native pixel size; an @2x set would blow
 * the 4096² cap), so a request built with the trpdg's @2x template would 404
 * into a batch that "completes" and a group that can never draw. The URL is
 * therefore pinned, not just the key.
 */
describe('ensureV2Atlases', () => {
  it('fetches a v2 group at @1x while trpdg levels stay @2x', async () => {
    const { scene, loader } = harness();
    const done = ensureV2Atlases(scene, ['v2trp_giant_t2', 'v2fx']);
    void ensureTroopLevelAtlases(scene, [7]);
    expect(loader.urls.get('v2trp_giant_t2-img')).toMatch(/^\/atlas\/v2trp_giant_t2@1x\.png\?v=/);
    expect(loader.urls.get('v2trp_giant_t2-json')).toMatch(/@1x\.json\?v=/);
    expect(loader.urls.get('v2fx-img')).toMatch(/@1x\.png\?v=/);
    expect(loader.urls.get(IMG)).toMatch(/@2x\.png\?v=/);
    loader.settle();
    await done;
    expect(isV2AtlasLoaded(scene, 'v2trp_giant_t2')).toBe(true);
    expect(isV2AtlasLoaded(scene, 'v2fx')).toBe(true);
  });

  it('shares ONE load between concurrent callers for the same group', async () => {
    const { scene, loader, textures } = harness();
    const a = ensureV2Atlases(scene, ['v2bld_cannon_t1']);
    const b = ensureV2Atlases(scene, ['v2bld_cannon_t1']);
    loader.settle();
    await Promise.all([a, b]);
    expect(textures.added.map((t) => t.key)).toEqual(['v2bld_cannon_t1']);
    expect(loader.delivered).toEqual(['v2bld_cannon_t1-img', 'v2bld_cannon_t1-json']);
  });

  it.each(['image', 'json'] as const)(
    'retires a partial Phaser %s staging half before a deferred byte-path retry',
    async (partial) => {
      const group = 'v2trp_dragon_t2'; // a large staging texture would be ~28 MiB
      const firstHarness = harness();
      const { scene, sceneLoader, textures, events } = firstHarness;
      const key = `${group}-${partial === 'image' ? 'img' : 'json'}`;
      if (partial === 'image') sceneLoader.image(key); else sceneLoader.json(key);
      sceneLoader.start();
      sceneLoader.settleFiles([key]);
      expect(
        partial === 'image'
          ? textures.exists(`${group}-img`)
          : scene.cache.json.get(`${group}-json`) !== undefined,
      ).toBe(true);

      events.emit('shutdown');
      const retry = harness(firstHarness);
      stubByteAtlas(group);
      await ensureV2Atlases(retry.scene, [group], { beforeTextureInsert: async () => undefined });
      expect(textures.added.map((entry) => entry.key)).toEqual([group]);
      expect(textures.exists(`${group}-img`)).toBe(false);
      expect(scene.cache.json.get(`${group}-json`)).toBeUndefined();
    },
  );

  it('keeps even the first TextureManager insertion out of an active interaction', async () => {
    const { scene, loader, textures } = harness();
    const { fetchMock, decode, jsonText } = stubByteAtlas('v2bld_cannon_t1');
    let release!: () => void;
    const idle = new Promise<void>((resolve) => { release = resolve; });
    const beforeTextureInsert = vi.fn(() => idle);
    const done = ensureV2Atlases(scene, ['v2bld_cannon_t1'], { beforeTextureInsert });

    await vi.waitFor(() => expect(beforeTextureInsert).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(loader.queued).toEqual([]); // no Phaser `<group>-img` staging texture
    expect(jsonText).toHaveBeenCalledOnce(); // text is inert until parsed after the gate
    expect(decode).not.toHaveBeenCalled();
    expect([...textures.entries.keys()]).toEqual([]); // zero TextureManager/GPU insertions mid-pan

    release();
    await done;
    expect(jsonText).toHaveBeenCalledOnce();
    expect(decode).toHaveBeenCalledOnce();
    expect(textures.added.map((entry) => entry.key)).toEqual(['v2bld_cannon_t1']);
  });

  it('rechecks interaction-idle after decode before the first texture insertion', async () => {
    const { scene, textures } = harness();
    const { decode } = stubByteAtlas('v2bld_cannon_t1');
    let finishDecode!: () => void;
    decode.mockImplementation(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    let endNewPan!: () => void;
    const newPan = new Promise<void>((resolve) => { endNewPan = resolve; });
    const beforeTextureInsert = vi.fn()
      .mockResolvedValueOnce(undefined) // bytes arrived while idle: decode may start
      .mockReturnValueOnce(newPan); // a finger landed before decode completed
    const done = ensureV2Atlases(scene, ['v2bld_cannon_t1'], { beforeTextureInsert });

    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    finishDecode();
    await vi.waitFor(() => expect(beforeTextureInsert).toHaveBeenCalledTimes(2));
    expect(textures.added).toEqual([]);

    endNewPan();
    await done;
    expect(textures.added.map((entry) => entry.key)).toEqual(['v2bld_cannon_t1']);
  });

  it('rechecks interaction-idle after inert JSON text finishes arriving', async () => {
    const { scene, textures } = harness();
    const { decode, jsonText } = stubByteAtlas('v2bld_cannon_t1');
    let finishText!: () => void;
    jsonText.mockImplementation(() => new Promise<string>((resolve) => {
      finishText = () => resolve(JSON.stringify(packerJson('v2bld_cannon_t1')));
    }));
    let endGesture!: () => void;
    const gestureIdle = new Promise<void>((resolve) => { endGesture = resolve; });
    const beforeTextureInsert = vi.fn(() => gestureIdle);
    const done = ensureV2Atlases(scene, ['v2bld_cannon_t1'], { beforeTextureInsert });

    await vi.waitFor(() => expect(jsonText).toHaveBeenCalledOnce());
    expect(beforeTextureInsert).not.toHaveBeenCalled();
    finishText(); // a touch began while text() was pending; the fresh gate must see it
    await vi.waitFor(() => expect(beforeTextureInsert).toHaveBeenCalledOnce());
    expect(decode).not.toHaveBeenCalled();
    expect(textures.added).toEqual([]);

    endGesture();
    await done;
    expect(decode).toHaveBeenCalledOnce();
    expect(textures.added.map((entry) => entry.key)).toEqual(['v2bld_cannon_t1']);
  });

  it('aborts the sibling byte transfer when the parallel request fails', async () => {
    const { scene } = harness();
    let pngAborted = false;
    let pngSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('.json')) return Promise.reject(new Error('json network failed'));
      pngSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        pngSignal?.addEventListener('abort', () => {
          pngAborted = true;
          reject(new Error('png aborted'));
        }, { once: true });
      });
    }));

    const done = ensureV2Atlases(scene, ['v2bld_cannon_t1'], {
      beforeTextureInsert: async () => undefined,
    });
    await expect(done).rejects.toThrow('json network failed');
    expect(pngSignal?.aborted).toBe(true);
    expect(pngAborted).toBe(true);
  });

  it('aborts a pending PNG immediately when the JSON response is HTTP non-ok', async () => {
    const { scene } = harness();
    let pngSignal: AbortSignal | undefined;
    let pngAborted = false;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('.json')) {
        return Promise.resolve({ ok: false } as Response);
      }
      pngSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        pngSignal?.addEventListener('abort', () => {
          pngAborted = true;
          reject(new Error('png aborted'));
        }, { once: true });
      });
    }));

    await expect(ensureV2Atlases(scene, ['v2trp_dragon_t2'])).rejects.toThrow('failed to load');
    expect(pngSignal?.aborted).toBe(true);
    expect(pngAborted).toBe(true);
  });

  it('aborts a pending PNG body when the JSON body fails', async () => {
    const { scene } = harness();
    let pngBodyAborted = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error('atlas fetch must be abortable');
      if (String(input).includes('.json')) {
        return {
          ok: true,
          blob: async (): Promise<Blob> => { throw new Error('json body failed'); },
        } as unknown as Response;
      }
      return {
        ok: true,
        blob: () => new Promise<Blob>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            pngBodyAborted = true;
            reject(new Error('png body aborted'));
          }, { once: true });
        }),
      } as Response;
    }));

    await expect(ensureV2Atlases(scene, ['v2trp_dragon_t2'])).rejects.toThrow('json body failed');
    expect(pngBodyAborted).toBe(true);
  });

  it('aborts both pending byte transfers when the requesting scene shuts down', async () => {
    const { scene, events } = harness();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error('atlas fetch must be abortable');
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
      });
    }));

    const done = ensureV2Atlases(scene, ['v2bld_cannon_t1'], {
      beforeTextureInsert: async () => undefined,
    });
    const rejected = expect(done).rejects.toThrow('scene shut down');
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    events.emit('shutdown');
    await rejected;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it.each(['shutdown', 'timeout'] as const)(
    'cannot materialize late response bodies after %s',
    async (outcome) => {
      if (outcome === 'timeout') vi.useFakeTimers();
      try {
        const group = 'v2trp_dragon_t2';
        const { scene, events, textures } = harness();
        const bodyResolvers = new Map<'image' | 'json', (blob: Blob) => void>();
        const signals: AbortSignal[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const type = String(input).includes('.json') ? 'json' : 'image';
          if (init?.signal) signals.push(init.signal);
          return {
            ok: true,
            blob: () => new Promise<Blob>((resolve) => { bodyResolvers.set(type, resolve); }),
          } as Response;
        }));
        const done = ensureV2Atlases(scene, [group]);
        const rejected = expect(done).rejects.toThrow(
          outcome === 'shutdown' ? 'scene shut down' : 'timed out',
        );
        await vi.waitFor(() => expect(bodyResolvers.size).toBe(2));

        if (outcome === 'shutdown') events.emit('shutdown');
        else await vi.advanceTimersByTimeAsync(ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS);
        await rejected;
        expect(signals).toHaveLength(2);
        expect(signals.every((signal) => signal.aborted)).toBe(true);

        bodyResolvers.get('image')!(new Blob(['png']));
        bodyResolvers.get('json')!(new Blob([JSON.stringify(packerJson(group))]));
        await Promise.resolve();
        await Promise.resolve();
        expect(textures.exists(`${group}-img`)).toBe(false);
        expect(scene.cache.json.get(`${group}-json`)).toBeUndefined();
        expect(textures.exists(group)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('cancels a stalled decoder and revokes its blob URL on timeout', async () => {
    vi.useFakeTimers();
    try {
      const { scene } = harness();
      const { decode, images, signals } = stubByteAtlas('v2bld_cannon_t1');
      decode.mockImplementation(() => new Promise<void>(() => undefined));
      const done = ensureV2Atlases(scene, ['v2bld_cannon_t1'], {
        beforeTextureInsert: async () => undefined,
      });
      const rejected = expect(done).rejects.toThrow('timed out during decode');
      await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS);
      await rejected;
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(images[0]?.src).toBe('');
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:atlas-test');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not make an immediate BattleScene caller inherit BaseScene interaction deferral', async () => {
    const base = harness();
    const battle = harness(base); // same game-global TextureManager
    stubByteAtlas('v2bld_cannon_t1');
    let releaseBase!: () => void;
    const baseIdle = new Promise<void>((resolve) => { releaseBase = resolve; });
    const beforeTextureInsert = vi.fn(() => baseIdle);
    const baseDone = ensureV2Atlases(base.scene, ['v2bld_cannon_t1'], {
      beforeTextureInsert,
    });

    await vi.waitFor(() => expect(beforeTextureInsert).toHaveBeenCalledOnce());
    expect(base.textures.added).toEqual([]);

    // Battle's two-argument call is latency-sensitive and must adopt the
    // already-arrived shared bytes without waiting for a base finger.
    const battleDone = ensureV2Atlases(battle.scene, ['v2bld_cannon_t1']);
    await Promise.all([baseDone, battleDone]);
    expect(base.textures.added.map((entry) => entry.key)).toEqual(['v2bld_cannon_t1']);

    releaseBase(); // a late gate resolution is inert; the atlas stitches once
    await Promise.resolve();
    expect(base.textures.added).toHaveLength(1);
  });

  it('settles a group when its PNG and JSON finish even while an unrelated shared-loader file hangs', async () => {
    const { scene, loader, sceneLoader } = harness();
    sceneLoader.image('unrelated-slow-image', '/unrelated.png');
    sceneLoader.start();
    const done = ensureV2Atlases(scene, ['v2bld_cannon_t1']);

    loader.settleFiles(['v2bld_cannon_t1-img', 'v2bld_cannon_t1-json']);
    await done;

    expect(isV2AtlasLoaded(scene, 'v2bld_cannon_t1')).toBe(true);
    expect(sceneLoader.queued).toEqual([{ key: 'unrelated-slow-image', type: 'image' }]);
  });

  it('rejects a stalled group after the bounded per-group timeout', async () => {
    vi.useFakeTimers();
    try {
      const { scene } = harness();
      const stalled = ensureV2Atlases(scene, ['v2bld_cannon_t1']);
      const rejected = expect(stalled).rejects.toThrow('v2bld_cannon_t1 timed out');

      await vi.advanceTimersByTimeAsync(ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ALL-OR-NOTHING, and it is load-bearing. `launchV2Projectile` returns false
   * when the shared `v2fx` group is missing, but rich-controller callers do not
   * check it because a v2 controller is not supposed
   * to be able to exist without v2fx. For TROOPS that gate is an explicit
   * conjunction in BattleScene (unit tier atlas AND V2FX_ATLAS registered). For
   * DEFENCES there is no such check: `adoptV2Defenses` runs on this promise
   * RESOLVING, and v2fx is simply one more group in the same request. So the
   * resolution is the gate — a batch where the tower's art landed and v2fx did
   * not must REJECT, or every cannon in that raid adopts the v2 controller and
   * then fires shots with no projectile, no muzzle flash and no impact, silently.
   */
  it('a v2 SET is all-or-nothing: v2fx failing rejects even though the tower group landed', async () => {
    const { scene, loader, textures } = harness();
    const both = ensureV2Atlases(scene, ['v2bld_cannon_t1', 'v2fx']);
    loader.settle(['v2fx-img']); // the tower's two files arrive; v2fx's image 404s
    await expect(both).rejects.toThrow('v2fx');
    // The half that DID arrive is registered (textures are game-global and the
    // fetch is per group) — which is exactly why the promise, not the texture
    // state, has to be what gates the adopt pass.
    expect(textures.added.map((t) => t.key)).toEqual(['v2bld_cannon_t1']);
    expect(isV2AtlasLoaded(scene, 'v2bld_cannon_t1')).toBe(true);
    expect(isV2AtlasLoaded(scene, 'v2fx')).toBe(false);
  });

  it('REJECTS rather than hanging when a file never arrives, and can be retried', async () => {
    const { scene, loader, textures } = harness();
    const failed = ensureV2Atlases(scene, ['v2fx']);
    loader.settle(['v2fx-img']);
    await expect(failed).rejects.toThrow('v2fx');
    expect(isV2AtlasLoaded(scene, 'v2fx')).toBe(false);

    const retry = ensureV2Atlases(scene, ['v2fx']);
    loader.settle();
    await retry;
    expect(textures.added.map((t) => t.key)).toEqual(['v2fx']);
  });
});

describe('global on-demand budget reservations', () => {
  it('prevents two scene loaders from spending the same in-flight capacity', () => {
    const base = harness();
    const battle = harness(base); // shared TextureManager, like the real game
    const sizes = { baseTroop: 70, battleTroop: 40 };

    expect(admitOnDemandAtlasCandidates(
      base.scene, sizes, [{ id: 'base', groups: ['baseTroop'] }], 96,
    )).toEqual(new Set(['base']));
    expect(admitOnDemandAtlasCandidates(
      battle.scene, sizes, [{ id: 'battle', groups: ['battleTroop'] }], 96,
    )).toEqual(new Set());
  });

  it('releases a failed shared dependency so a later raid can use the full budget', () => {
    const first = harness();
    const next = harness(first);
    const sizes = { v2fx: 70, firstBody: 20, nextBody: 80 };

    expect(admitOnDemandAtlasCandidates(
      first.scene, sizes, [{ id: 'first', groups: ['v2fx', 'firstBody'] }], 96,
    )).toEqual(new Set(['first']));
    releaseAtlasReservations(first.scene, ['v2fx', 'firstBody']);

    expect(admitOnDemandAtlasCandidates(
      next.scene, sizes, [{ id: 'next', groups: ['nextBody'] }], 96,
    )).toEqual(new Set(['next']));
  });
});

describe('boot vs on-demand split', () => {
  it('boots the reworked defences eagerly and no per-level troop atlas', () => {
    // BootScene's preload loops ATLAS_PREFIXES, so this list IS the eager set.
    // blddef holds live base-view buildings and must be in it; a trpdg group
    // slipping in would put 8.6MB per level back on the boot path.
    expect(ATLAS_PREFIXES).toContain('blddef');
    for (const p of ATLAS_PREFIXES) expect(p.startsWith('trpdg_')).toBe(false);
  });

  it('never registers a staging texture or JSON cache copy', async () => {
    // A Phaser `<group>-img` staging texture plus addAtlas's TextureSource keeps
    // the image on the GPU twice. The byte pipeline must expose only the final
    // atlas, including for immediate Battle/troop callers.
    const h = harness();
    const done = ensureTroopLevelAtlases(h.scene, [7]);
    h.loader.settle();
    await done;
    expect(h.textures.exists(trpdgGroup(7)), 'the atlas itself survives').toBe(true);
    expect(h.textures.exists(IMG), 'staging texture released').toBe(false);
    expect(isTroopLevelAtlasLoaded(h.scene, 7), 'still counts as loaded').toBe(true);
  });
});

/**
 * BOUNDED RESIDENCY (releaseUnusedAtlases).
 *
 * WHY THIS IS A REAL BUG AND NOT HOUSEKEEPING. Loading on demand bounds one
 * battle; it bounded nothing about a session, because the TextureManager is
 * game-global and no group was ever removed from it. Raid a t1 base, then a t2,
 * then a t4 and the resident set only grows: all 17 v2 groups plus all 20 trpdg
 * levels is ~440MiB of live RGBA textures (ATLAS_PX above — a dragon tier alone
 * is 28.1MiB). The client ships as an Android TWA, so that is a WebView on a
 * 3–4GB phone losing its WebGL context or being OOM-killed, and the failure is
 * a black canvas with no error attributable to art at all.
 *
 * WHAT THESE PIN is the safety half, which is where a sweep like this goes
 * wrong: evicting a group whose sprites are still on screen replaces them with
 * Phaser's missing-texture placeholder SILENTLY, and evicting a boot group would
 * break the base view permanently. Hence liveness read off the display lists,
 * and a candidate set that only ever contains what this module itself loaded.
 */
describe('on-demand atlas eviction', () => {
  const spyInfo = () => vi.spyOn(console, 'info').mockImplementation(() => undefined);
  let info: ReturnType<typeof spyInfo>;
  beforeEach(() => { info = spyInfo(); }); // keeps the field log out of the run
  afterEach(() => { vi.restoreAllMocks(); });

  /** Register `groups` + trpdg `levels` on demand through the real loader. */
  async function loadInto(h: Harness, groups: string[], levels: number[] = []): Promise<void> {
    const done = Promise.all([
      ensureV2Atlases(h.scene, groups),
      ensureTroopLevelAtlases(h.scene, levels),
    ]);
    h.loader.settle();
    await done;
  }

  it('evicts what no surviving scene draws, and reports the reclaimed bytes', async () => {
    const base = harness();
    const battle = harness(base);
    await loadInto(battle, ['v2trp_dragon_t2', 'v2fx'], [7]);

    const freed = releaseUnusedAtlases(battle.scene);

    // 28.1 + 5.8 + 8.2 = 42.1MiB handed back at the end of ONE raid — the whole
    // difference between a session that survives and one that gets killed.
    expect(freed).toBe(bytesOf('v2trp_dragon_t2', 'v2fx', trpdgGroup(7)));
    expect(isV2AtlasLoaded(battle.scene, 'v2trp_dragon_t2')).toBe(false);
    expect(isV2AtlasLoaded(battle.scene, 'v2fx')).toBe(false);
    // Textures are game-global: the base's manager is the same one.
    expect(isTroopLevelAtlasLoaded(base.scene, 7)).toBe(false);
    // Observable in the field or it may as well not be happening.
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain('51.9MiB');
    expect(String(info.mock.calls[0]?.[0])).toContain('v2trp_dragon_t2');
  });

  it('never evicts a group a surviving scene still has sprites for', async () => {
    const base = harness();
    const battle = harness(base);
    await loadInto(battle, ['v2trp_giant_t2', 'v2bld_cannon_t1', 'v2fx'], [7]);
    // BaseScene only SLEEPS for a raid — its garrison giant and its levelled
    // dragon are still on its display list, and taking their atlas would blank
    // them the instant the player lands back home, with no error anywhere.
    base.children.push({ texture: { key: 'v2trp_giant_t2' } });
    base.children.push({ texture: { key: trpdgGroup(7) } });
    // A Container keeps its children OFF the scene's own list (the v2 breath
    // stream is one, built from v2fx frames), so the walk must recurse.
    base.children.push({ list: [{ texture: { key: 'v2fx' } }] });

    const freed = releaseUnusedAtlases(battle.scene);

    expect(isV2AtlasLoaded(base.scene, 'v2trp_giant_t2'), 'live sprite').toBe(true);
    expect(isTroopLevelAtlasLoaded(base.scene, 7), 'live sprite').toBe(true);
    expect(isV2AtlasLoaded(base.scene, 'v2fx'), 'live inside a container').toBe(true);
    // ...and the raid-only defender tier nothing draws any more still goes.
    expect(isV2AtlasLoaded(base.scene, 'v2bld_cannon_t1')).toBe(false);
    expect(freed).toBe(bytesOf('v2bld_cannon_t1'));
  });

  it('can sweep an idle patrol while preserving art the same base still draws', async () => {
    const base = harness();
    await loadInto(base, ['v2trp_bowman_t1', 'v2bld_cannon_t1']);
    base.children.push({ texture: { key: 'v2bld_cannon_t1' } });

    const freed = releaseUnreferencedAtlases(base.scene);

    expect(freed).toBe(bytesOf('v2trp_bowman_t1'));
    expect(isV2AtlasLoaded(base.scene, 'v2trp_bowman_t1')).toBe(false);
    expect(isV2AtlasLoaded(base.scene, 'v2bld_cannon_t1')).toBe(true);
    expect(onDemandAtlasState(base.scene)).toEqual({
      bytes: bytesOf('v2bld_cannon_t1'),
      groups: new Set(['v2bld_cannon_t1']),
    });
  });

  it('targeted late-load cleanup omits shared controller dependencies', async () => {
    const battle = harness();
    await loadInto(battle, ['v2trp_bowman_t1', 'v2fx']);

    expect(releaseAtlasGroups(battle.scene, ['v2trp_bowman_t1']))
      .toBe(bytesOf('v2trp_bowman_t1'));
    expect(isV2AtlasLoaded(battle.scene, 'v2trp_bowman_t1')).toBe(false);
    expect(isV2AtlasLoaded(battle.scene, 'v2fx'), 'future shots still need it').toBe(true);
  });

  it('leases a controller dependency across idle sweeps until explicit release', async () => {
    const battle = harness();
    await loadInto(battle, ['v2fx']);
    const release = retainAtlasGroups(battle.scene, ['v2fx']);
    expect(releaseUnreferencedAtlases(battle.scene)).toBe(0);
    expect(isV2AtlasLoaded(battle.scene, 'v2fx')).toBe(true);
    release();
    expect(releaseUnreferencedAtlases(battle.scene)).toBe(bytesOf('v2fx'));
  });

  it("ignores the CLOSING scene's own sprites — they die with it", async () => {
    const base = harness();
    const battle = harness(base);
    await loadInto(battle, ['v2trp_dragon_t2']);
    battle.children.push({ texture: { key: 'v2trp_dragon_t2' } });

    // Whether Phaser's DisplayList plugin has cleared itself before or after our
    // SHUTDOWN listener runs is an ordering detail. If the closing scene counted
    // as live, a battle that ended with troops on the field would reclaim
    // NOTHING — the leak back in full, with the mechanism apparently in place.
    expect(releaseUnusedAtlases(battle.scene)).toBe(bytesOf('v2trp_dragon_t2'));
  });

  it('never touches the eager boot groups, even with nothing on screen', async () => {
    const battle = harness();
    // BootScene registers these itself (its ATLAS_PREFIXES loop) — they never
    // pass through this module, so they are not candidates BY CONSTRUCTION
    // rather than by a name filter someone has to remember to update. Evicting
    // one would break the base view for the rest of the session: nothing ever
    // re-requests a boot group.
    for (const p of ATLAS_PREFIXES) battle.textures.entries.set(p, fakeImage(p));
    await loadInto(battle, ['v2fx']);

    expect(releaseUnusedAtlases(battle.scene)).toBe(bytesOf('v2fx'));
    for (const p of ATLAS_PREFIXES) expect(battle.textures.exists(p), p).toBe(true);
  });

  it('re-loads an evicted group cleanly', async () => {
    const battle = harness();
    await loadInto(battle, ['v2bld_mortar_t3']);
    releaseUnusedAtlases(battle.scene);

    // Eviction has to leave NO residue. The staging keys are already gone
    // (stitch drops them), so both files must queue again — a surviving cached
    // `-img` key would be dropped by Phaser as a duplicate and the promise would
    // wait forever on a COMPLETE nobody fires: the group could never come back.
    const again = ensureV2Atlases(battle.scene, ['v2bld_mortar_t3']);
    expect(battle.loader.queued.map((f) => f.key))
      .toEqual(['v2bld_mortar_t3-img', 'v2bld_mortar_t3-json']);
    battle.loader.settle();
    await again;

    expect(isV2AtlasLoaded(battle.scene, 'v2bld_mortar_t3')).toBe(true);
    expect(battle.textures.added.map((t) => t.key))
      .toEqual(['v2bld_mortar_t3', 'v2bld_mortar_t3']);
    // And it is a candidate again — the re-load must re-enter the resident set,
    // or the second raid's art becomes permanently un-evictable.
    expect(releaseUnusedAtlases(battle.scene)).toBe(bytesOf('v2bld_mortar_t3'));
  });

  it('is a silent no-op when there is nothing to reclaim', async () => {
    const battle = harness();
    await loadInto(battle, ['v2fx']);
    releaseUnusedAtlases(battle.scene);
    info.mockClear();

    // Every scene shutdown calls this; a base view that never raided must not
    // log, and a second sweep must not double-count what it already took.
    expect(releaseUnusedAtlases(battle.scene)).toBe(0);
    expect(info).not.toHaveBeenCalled();
  });
});
