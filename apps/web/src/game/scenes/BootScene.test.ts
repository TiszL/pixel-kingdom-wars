import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type Phaser from 'phaser';
import { ATLAS_PREFIXES } from '@shardkeep/shared';
import { bus } from '../../lib/events';
import { BUILD } from '../../lib/version';
import { useApp } from '../../state/store';

vi.mock('phaser', () => ({ default: { Scene: class {} } }));
const atlas = vi.hoisted(() => ({ stitchAtlas: vi.fn() }));
vi.mock('../world/atlasTexels', () => ({
  ...atlas, supportsLogicalAtlasUpscale: () => false, ART_PROFILE_REGISTRY_KEY: 'art-profile',
}));
import { BOOT_REQUEST_TIMEOUT_MS, BOOT_REQUEST_BATCH_BUDGET_MS, BOOT_ROUND_TIMEOUT_MS, BOOT_MIN_ROUND_BUDGET_MS, BootScene } from './BootScene';
import { EMPTY_MARKET_ART, MARKET_ART_REGISTRY_KEY } from '../world/marketArt';
import { EMPTY_STARTER_FLEET_ART, STARTER_FLEET_ART_REGISTRY_KEY } from '../world/fleetArt';
import { ADVANCED_FLEET_ART_REGISTRY_KEY, EMPTY_ADVANCED_FLEET_ART } from '../world/advancedFleetArt';

const ONE_REQUEST_BUDGET_MS = BOOT_MIN_ROUND_BUDGET_MS;

type Callback = (...args: unknown[]) => void;
function emitter() {
  const listeners = new Map<string, Array<{ fn: Callback; context?: unknown; once: boolean }>>();
  return {
    on(event: string, fn: Callback, context?: unknown) {
      const entries = listeners.get(event) ?? [];
      entries.push({ fn, context, once: false }); listeners.set(event, entries);
    },
    once(event: string, fn: Callback, context?: unknown) {
      const entries = listeners.get(event) ?? [];
      entries.push({ fn, context, once: true }); listeners.set(event, entries);
    },
    off(event: string, fn: Callback, context?: unknown) {
      listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry.fn !== fn || entry.context !== context));
    },
    emit(event: string, ...args: unknown[]) {
      const entries = [...(listeners.get(event) ?? [])];
      for (const entry of entries) {
        if (entry.once) listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== entry));
        entry.fn.apply(entry.context, args);
      }
    },
    listenerCount: (event: string) => listeners.get(event)?.length ?? 0,
  };
}
type Request = { key: string; url: string; xhrSettings: { timeout: number }; type: 'image' | 'json' };
type PendingFile = Request & { loader: unknown; xhrLoader: { readyState: number; status: number; abort: () => void; ontimeout: Callback | null; onabort: Callback | null }; resetXHR: () => void; data?: { src: string; onload: Callback | null; onerror: Callback | null; removeAttribute: () => void } };
function fixture(missing?: 'json' | 'image' | 'meta' | 'frames' | 'sprites') {
  // Fail the LAST atlas: validation must finish before touching any earlier art.
  const last = ATLAS_PREFIXES.at(-1)!;
  const scene = new BootScene(), events = emitter(), game = { isPaused: false, events: emitter() };
  const start = vi.fn(), images = new Set(ATLAS_PREFIXES.map(prefix => `${prefix}-img`));
  const metadata = new Map<string, unknown>(ATLAS_PREFIXES.map(prefix => [`${prefix}-json`, { textures: [{ frames: [] }] }]));
  metadata.set('sprite-meta', { sprites: {} });
  if (missing === 'image') images.delete(`${last}-img`);
  if (missing === 'json') metadata.delete(`${last}-json`);
  if (missing === 'frames') metadata.set(`${last}-json`, { textures: [{ frames: null }] });
  if (missing === 'meta') metadata.delete('sprite-meta');
  if (missing === 'sprites') metadata.set('sprite-meta', { sprites: null });
  const requested: Request[] = [], active = new Set<PendingFile>(), timers = new Set<ReturnType<typeof setTimeout>>();
  let requestBehavior: (file: PendingFile) => 'success' | 'timeout' | 'decode' | 'error' = () => 'timeout';
  const load = {
    ...emitter(), list: new Set<PendingFile>(), maxRetries: 2, maxParallelDownloads: 6, imageLoadType: 'HTMLImageElement', update: vi.fn(),
    image(key: string, url: string, xhrSettings: { timeout: number }) { queue({ key, url, xhrSettings, type: 'image' }); },
    json(config: Omit<Request, 'type'>) { queue({ ...config, type: 'json' }); },
    reset: vi.fn(() => { load.list.clear(); active.clear(); }),
    start: vi.fn(() => {
      const batch = [...load.list]; load.list.clear();
      if (!batch.length) { load.emit('complete'); return; }
      for (const file of batch) {
        active.add(file); file.xhrLoader.readyState = 1;
        const behavior = requestBehavior(file);
        if (behavior === 'decode') {
          file.xhrLoader.readyState = 4; file.xhrLoader.status = 200;
          file.data = { src: 'blob:stalled', onload: vi.fn(), onerror: vi.fn(), removeAttribute: vi.fn() };
          continue;
        }
        // Native timeout0 means no wall-clock timer; Boot's active budget owns
        // an unresponsive request. Network errors can still arrive offscreen.
        if (behavior === 'timeout' && file.xhrSettings.timeout === 0) continue;
        const timer = setTimeout(() => {
          timers.delete(timer); active.delete(file);
          if (behavior === 'success') {
            if (file.type === 'image') images.add(file.key);
            else metadata.set(file.key, file.key === 'sprite-meta' ? { sprites: {} } : { textures: [{ frames: [] }] });
          }
          if (behavior === 'error') load.emit('loaderror', file);
          file.loader = null;
          if (!active.size) load.emit('complete');
        }, behavior === 'success' || behavior === 'error' ? 50 : file.xhrSettings.timeout);
        timers.add(timer);
        file.xhrLoader.abort = vi.fn(() => { clearTimeout(timer); timers.delete(timer); active.delete(file); });
      }
    }),
  };
  function queue(request: Request): void {
    requested.push(request);
    load.list.add({ ...request, loader: load, resetXHR: vi.fn(), xhrLoader: { readyState: 0, status: 0, abort: vi.fn(), ontimeout: vi.fn(), onabort: vi.fn() } });
  }
  Object.assign(scene, {
    cache: { json: { exists: (key: string) => metadata.has(key), get: (key: string) => metadata.get(key), remove: (key: string) => metadata.delete(key) } },
    textures: { exists: (key: string) => images.has(key), get: () => ({ getSourceImage: () => ({}) }), remove: vi.fn() },
    events, game, load, registry: { set: vi.fn() }, scene: { start },
  });
  return { scene, start, load, events, game, images, metadata, requested, active, timers,
    behavior: (fn: typeof requestBehavior) => { requestBehavior = fn; },
    preload: () => { scene.preload(); load.once('complete', scene.create, scene); load.start(); },
  };
}

describe('required boot artwork', () => {
  beforeEach(() => {
    vi.useFakeTimers(); useApp.setState({ booted: false }); atlas.stitchAtlas.mockClear();
    const page = new EventTarget();
    Object.defineProperty(page, 'hidden', { configurable: true, get: () => false });
    vi.stubGlobal('document', page);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each(['json', 'image', 'meta', 'frames', 'sprites'] as const)(
    'retries missing/invalid %s once, then reports failure before partial stitching or entering the game', async (missing) => {
      const emit = vi.spyOn(bus, 'emit'), f = fixture(missing);
      expect(() => f.scene.create()).not.toThrow();
      expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
      await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS);
      expect(atlas.stitchAtlas).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(useApp.getState().booted).toBe(false);
      expect(emit).toHaveBeenCalledWith('boot:failed', expect.objectContaining({ files: expect.arrayContaining([expect.any(String)]) }));
      expect(emit).not.toHaveBeenCalledWith('boot:ready', undefined);
      expect(f.requested).toHaveLength(1); // initial create follows Phaser's first failed attempt
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('publishes optional builder metadata without adding its animation atlas to cold boot', () => {
    const f = fixture();
    const clips = { builder_walk: { frames: 8, rows: 8, cellW: 84, cellH: 84, anchorPx: [42, 70] } };
    f.metadata.set('sprite-meta', { sprites: {}, builderClips: clips });
    f.scene.create();
    expect(f.scene.registry.set).toHaveBeenCalledWith('builderClips', clips);
    expect(ATLAS_PREFIXES).not.toContain('builder');
    expect(f.requested).toEqual([]);
    const previous = fixture();
    previous.scene.create();
    expect(previous.scene.registry.set).toHaveBeenCalledWith('builderClips', {});
  });

  it('publishes the Phase E Market/Awning clip tables from the sidecar without adding their on-demand groups to cold boot', () => {
    const evidence = (name: string): unknown => JSON.parse(readFileSync(
      new URL(`../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/${name}`, import.meta.url), 'utf8',
    ));
    const f = fixture();
    f.metadata.set('sprite-meta', {
      sprites: {}, peMarket: evidence('pe_market.manifest.json'), peCosmetics: evidence('pe_cosmetics.manifest.json'),
    });
    f.scene.create();
    const table = (f.scene.registry.set as ReturnType<typeof vi.fn>).mock.calls
      .find(([key]) => key === MARKET_ART_REGISTRY_KEY)?.[1] as { clips: Record<string, unknown>; bindings: Record<string, unknown> };
    expect(Object.keys(table.clips)).toHaveLength(62);
    expect(Object.keys(table.bindings)).toHaveLength(5);
    expect(ATLAS_PREFIXES).not.toContain('pe_cosmetics');
    expect(ATLAS_PREFIXES.some((prefix) => prefix.startsWith('pe_market'))).toBe(false);
    expect(f.requested).toEqual([]);
    // A legacy sidecar (rolling deploy, stale local assets) still boots, with the empty table.
    const previous = fixture();
    previous.scene.create();
    expect(previous.scene.registry.set).toHaveBeenCalledWith(MARKET_ART_REGISTRY_KEY, EMPTY_MARKET_ART);
    // A defective table is refused into the same empty table, never a boot failure.
    const defective = fixture();
    defective.metadata.set('sprite-meta', { sprites: {}, peMarket: { schemaVersion: 2 }, peCosmetics: 'nope' });
    expect(() => defective.scene.create()).not.toThrow();
    expect(defective.scene.registry.set).toHaveBeenCalledWith(MARKET_ART_REGISTRY_KEY, EMPTY_MARKET_ART);
    expect(defective.start).toHaveBeenCalledWith('base');
  });

  it('publishes the ordinary Workshop/Lodge families into the same Market table (P5) and refuses a defective service table alone', () => {
    const evidence = (name: string): unknown => JSON.parse(readFileSync(
      new URL(`../../../../../docs/evidence/2026-09-30-bound-cosmetic-visuals/${name}`, import.meta.url), 'utf8',
    ));
    const service = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_service_buildings.manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const f = fixture();
    f.metadata.set('sprite-meta', {
      sprites: {}, peMarket: evidence('pe_market.manifest.json'), peCosmetics: evidence('pe_cosmetics.manifest.json'), peServiceBuildings: service,
    });
    f.scene.create();
    const table = (f.scene.registry.set as ReturnType<typeof vi.fn>).mock.calls
      .find(([key]) => key === MARKET_ART_REGISTRY_KEY)?.[1] as { clips: Record<string, unknown>; bindings: Record<string, unknown> };
    expect(Object.keys(table.clips)).toHaveLength(62 + 64);
    expect(Object.keys(table.bindings)).toHaveLength(5);
    expect(ATLAS_PREFIXES.some((prefix) => prefix.startsWith('pe_workshop') || prefix.startsWith('pe_lodge'))).toBe(false);
    expect(f.requested).toEqual([]);
    // A defective service table refuses only the two service families; the accepted Market/Awning art stays.
    const defective = fixture();
    defective.metadata.set('sprite-meta', {
      sprites: {}, peMarket: evidence('pe_market.manifest.json'), peCosmetics: evidence('pe_cosmetics.manifest.json'),
      peServiceBuildings: { ...service, families: ['workshop'] },
    });
    expect(() => defective.scene.create()).not.toThrow();
    const partial = (defective.scene.registry.set as ReturnType<typeof vi.fn>).mock.calls
      .find(([key]) => key === MARKET_ART_REGISTRY_KEY)?.[1] as { clips: Record<string, unknown> };
    expect(Object.keys(partial.clips)).toHaveLength(62);
    expect(defective.start).toHaveBeenCalledWith('base');
  });

  it('publishes the Phase E starter fleet table from the sidecar without adding its on-demand group to cold boot', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_fleet_starter.manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const { clips, tracks, ...identity } = manifest;
    const f = fixture();
    f.metadata.set('sprite-meta', { sprites: {}, peStarterFleet: identity, peClips: clips, peTracks: tracks });
    f.scene.create();
    const table = (f.scene.registry.set as ReturnType<typeof vi.fn>).mock.calls
      .find(([key]) => key === STARTER_FLEET_ART_REGISTRY_KEY)?.[1] as { atlas: string; clips: Record<string, unknown>; dockTranslation: number[] };
    expect(table.atlas).toBe('pe_fleet_starter');
    expect(Object.keys(table.clips)).toHaveLength(11);
    expect(table.dockTranslation).toEqual([0, -27]);
    expect(ATLAS_PREFIXES).not.toContain('pe_fleet_starter');
    expect(f.requested).toEqual([]);
    // A legacy sidecar (rolling deploy, stale local assets) still boots, with the empty table.
    const previous = fixture();
    previous.scene.create();
    expect(previous.scene.registry.set).toHaveBeenCalledWith(STARTER_FLEET_ART_REGISTRY_KEY, EMPTY_STARTER_FLEET_ART);
    // A defective table is refused into the same empty table, never a boot failure.
    const defective = fixture();
    defective.metadata.set('sprite-meta', { sprites: {}, peStarterFleet: { schemaVersion: 1, atlas: 'pe_fleet_starter' }, peClips: 'nope', peTracks: null });
    expect(() => defective.scene.create()).not.toThrow();
    expect(defective.scene.registry.set).toHaveBeenCalledWith(STARTER_FLEET_ART_REGISTRY_KEY, EMPTY_STARTER_FLEET_ART);
    expect(defective.start).toHaveBeenCalledWith('base');
  });

  it('publishes the Phase E advanced fleet table (P6a) from the sidecar without adding any of its twenty on-demand groups to cold boot', () => {
    const table = JSON.parse(readFileSync(new URL('../../../testFixtures/pe_advanced_fleet.manifest.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const f = fixture();
    f.metadata.set('sprite-meta', { sprites: {}, peAdvancedFleet: table });
    f.scene.create();
    const published = (f.scene.registry.set as ReturnType<typeof vi.fn>).mock.calls
      .find(([key]) => key === ADVANCED_FLEET_ART_REGISTRY_KEY)?.[1] as { clips: Record<string, unknown>; berths: Map<string, unknown>; vehicles: Map<string, unknown> };
    expect(Object.keys(published.clips)).toHaveLength(80);
    expect(published.berths.size).toBe(4);
    expect(published.vehicles.size).toBe(16);
    for (const group of table['atlases'] as string[]) expect(ATLAS_PREFIXES, group).not.toContain(group);
    expect(f.requested).toEqual([]);
    // Legacy and defective sidecars register the empty table and boot normally.
    const previous = fixture();
    previous.scene.create();
    expect(previous.scene.registry.set).toHaveBeenCalledWith(ADVANCED_FLEET_ART_REGISTRY_KEY, EMPTY_ADVANCED_FLEET_ART);
    const defective = fixture();
    defective.metadata.set('sprite-meta', { sprites: {}, peAdvancedFleet: { ...table, atlases: (table['atlases'] as string[]).slice(1) } });
    expect(() => defective.scene.create()).not.toThrow();
    expect(defective.scene.registry.set).toHaveBeenCalledWith(ADVANCED_FLEET_ART_REGISTRY_KEY, EMPTY_ADVANCED_FLEET_ART);
    expect(defective.start).toHaveBeenCalledWith('base');
  });

  it('allows a fresh healthy boot after the player reloads, without skipping artwork', async () => {
    const failed = fixture('json'); failed.scene.create();
    await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS);
    const healthy = fixture(); healthy.scene.create();
    expect(atlas.stitchAtlas).toHaveBeenCalledTimes(ATLAS_PREFIXES.length);
    expect(healthy.start).toHaveBeenCalledWith('base');
    expect(useApp.getState().booted).toBe(true);
  });

  it.each(['image', 'json', 'meta'] as const)('recovers a delayed %s request without redownloading valid art or changing its build identity', async missing => {
    const f = fixture(missing), emit = vi.spyOn(bus, 'emit');
    let attempt = 0; f.behavior(() => ++attempt === 1 ? 'timeout' : 'success'); f.preload();
    expect(f.load.maxRetries).toBe(0); expect(f.load.imageLoadType).toBe('XHR');
    await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS - 1);
    expect(f.start).not.toHaveBeenCalled(); expect(f.requested).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(51);
    expect(f.requested).toHaveLength(2);
    expect(f.requested[1]).toEqual(f.requested[0]);
    expect(f.requested[0]?.url).toContain(`?v=${BUILD.gitSha}`);
    expect(f.requested[0]?.xhrSettings.timeout).toBe(BOOT_REQUEST_TIMEOUT_MS);
    expect(atlas.stitchAtlas).toHaveBeenCalledTimes(ATLAS_PREFIXES.length);
    expect(f.start).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an unresponsive connection to two attempts and removes all recovery callbacks', async () => {
    const f = fixture('image'), emit = vi.spyOn(bus, 'emit'); f.preload();
    await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS * 2);
    expect(f.requested).toHaveLength(2);
    expect(emit.mock.calls.filter(([name]) => name === 'boot:failed')).toHaveLength(1);
    expect(f.start).not.toHaveBeenCalled();
    f.load.emit('complete'); f.events.emit('shutdown');
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS * 3);
    expect(f.requested).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps every successful file from a cold boot when the final atlas alone needs recovery', async () => {
    const f = fixture(), lastImage = `${ATLAS_PREFIXES.at(-1)!}-img`;
    f.images.clear(); f.metadata.clear();
    let failed = false;
    f.behavior(file => {
      if (file.key === lastImage && !failed) { failed = true; return 'timeout'; }
      return 'success';
    });
    f.preload();
    const initialCount = ATLAS_PREFIXES.length * 2 + 1;
    expect(f.requested).toHaveLength(initialCount);
    await vi.advanceTimersByTimeAsync(Math.max(BOOT_MIN_ROUND_BUDGET_MS, Math.ceil(initialCount / f.load.maxParallelDownloads) * BOOT_REQUEST_BATCH_BUDGET_MS + BOOT_ROUND_TIMEOUT_MS) + 50);
    expect(f.requested).toHaveLength(initialCount + 1);
    expect(f.requested.at(-1)?.key).toBe(lastImage);
    expect(atlas.stitchAtlas).toHaveBeenCalledTimes(ATLAS_PREFIXES.length);
    expect(f.start).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a stalled image decode and reuses the healthy staging textures on its one recovery attempt', async () => {
    const f = fixture('image'); let attempt = 0;
    f.behavior(() => ++attempt === 1 ? 'decode' : 'success'); f.preload();
    const file = [...f.active][0]!, decode = file.data!;
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS + 50);
    expect(file.xhrLoader.abort).toHaveBeenCalledOnce();
    expect(decode.onload).toBeNull(); expect(decode.onerror).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:stalled');
    expect(f.requested).toHaveLength(2); expect(f.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the native six-download queue intact while hidden, then drains all cold-boot files on resumed frames', async () => {
    // Android's loader starts six requests; the remaining files require scene
    // UPDATE events. Successful network replies alone cannot drain this queue.
    const require = createRequire(import.meta.url);
    const source = path.resolve(path.dirname(require.resolve('phaser')), '../src');
    const NativeLoader = require(path.join(source, 'loader/LoaderPlugin.js')) as typeof Phaser.Loader.LoaderPlugin;
    const NativeEvents = require(path.join(source, 'events/EventEmitter.js')) as typeof Phaser.Events.EventEmitter;
    const states = require(path.join(source, 'loader/const.js')) as { FILE_LOADING: number; FILE_COMPLETE: number };
    require(path.join(source, 'loader/filetypes/ImageFile.js'));
    require(path.join(source, 'loader/filetypes/JSONFile.js'));
    const f = fixture(), events = new NativeEvents(), emit = vi.spyOn(bus, 'emit');
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    f.images.clear(); f.metadata.clear();
    const game = { ...f.game, config: { loaderMaxParallelDownloads: 6 }, scene: {} };
    Object.assign(f.scene, { events, game, sys: { events, settings: { loader: {} },
      game, cache: f.scene.cache, textures: f.scene.textures } });
    const loader = new NativeLoader(f.scene);
    Object.assign(f.scene, { load: loader });
    events.emit('boot');
    f.scene.preload();
    const files = [...loader.list], requested: string[] = [], cached: string[] = [];
    for (const file of files) {
      // Replace transport/decode only; native slot scheduling, completion,
      // cache insertion and file destruction remain in the installed loader.
      file.load = () => { file.state = states.FILE_LOADING; requested.push(file.key); };
      file.onProcess = () => { file.state = states.FILE_COMPLETE; loader.fileProcessComplete(file); };
      file.addToCache = () => {
        cached.push(file.key);
        if (file.type === 'image') f.images.add(file.key);
        else f.metadata.set(file.key, file.key === 'sprite-meta' ? { sprites: {} } : { textures: [{ frames: [] }] });
      };
    }
    const completeInflight = () => { for (const file of [...loader.inflight]) loader.nextFile(file, true); };
    const reset = vi.spyOn(loader, 'reset');
    loader.once('complete', f.scene.create, f.scene); loader.start();
    expect(files).toHaveLength(ATLAS_PREFIXES.length * 2 + 1);
    expect(requested).toHaveLength(6);
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    game.isPaused = true; game.events.emit('pause');
    completeInflight();
    expect(cached).toHaveLength(6);
    expect(loader.list.size).toBe(files.length - 6);
    expect(loader.inflight.size).toBe(0);
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS * 3);
    expect(reset).not.toHaveBeenCalled();
    expect(requested).toHaveLength(6);
    expect(f.start).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    // Visibility can arrive before Phaser RESUME; neither event alone may
    // spend the watchdog while the other suspension condition remains true.
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    game.isPaused = false; game.events.emit('resume');
    expect(vi.getTimerCount()).toBe(1);
    for (let frame = 0; frame < files.length && loader.list.size; frame++) {
      events.emit('update'); completeInflight();
    }
    expect(requested).toHaveLength(files.length);
    expect(new Set(requested).size).toBe(files.length);
    expect(cached).toHaveLength(files.length);
    expect(f.start).toHaveBeenCalledExactlyOnceWith('base');
    expect(atlas.stitchAtlas).toHaveBeenCalledTimes(ATLAS_PREFIXES.length);
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(game.events.listenerCount('pause')).toBe(0);
    expect(game.events.listenerCount('resume')).toBe(0);
    expect(events.listenerCount('update')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    events.emit('destroy');
  });

  it('lets a progressing late PNG complete through the native foreground queue without spending its retry', async () => {
    // Six-slot native scheduling starts warefallback at18s, after three healthy
    // six-second batches. The former20s whole-round timeout aborted it after2s.
    const require = createRequire(import.meta.url);
    const source = path.resolve(path.dirname(require.resolve('phaser')), '../src');
    const NativeLoader = require(path.join(source, 'loader/LoaderPlugin.js')) as typeof Phaser.Loader.LoaderPlugin;
    const NativeEvents = require(path.join(source, 'events/EventEmitter.js')) as typeof Phaser.Events.EventEmitter;
    const states = require(path.join(source, 'loader/const.js')) as { FILE_LOADING: number; FILE_COMPLETE: number };
    require(path.join(source, 'loader/filetypes/ImageFile.js'));
    require(path.join(source, 'loader/filetypes/JSONFile.js'));
    const f = fixture(), events = new NativeEvents(), emit = vi.spyOn(bus, 'emit');
    f.images.clear(); f.metadata.clear();
    const game = { ...f.game, config: { loaderMaxParallelDownloads: 6 }, scene: {} };
    Object.assign(f.scene, { events, game, sys: { events, settings: { loader: {} },
      game, cache: f.scene.cache, textures: f.scene.textures } });
    const loader = new NativeLoader(f.scene), started = new Map<Phaser.Loader.File, number>();
    const aborted: Array<{ key: string; elapsed: number }> = [];
    Object.assign(f.scene, { load: loader }); events.emit('boot');
    loader.on('addfile', (_key: string, _type: string, _loader: unknown, file: Phaser.Loader.File) => {
      file.load = () => {
        file.state = states.FILE_LOADING; started.set(file, Date.now());
        const timer = setTimeout(() => loader.nextFile(file, true), 6_000);
        file.xhrLoader = { abort: () => {
          clearTimeout(timer); aborted.push({ key: file.key, elapsed: Date.now() - started.get(file)! });
        } } as XMLHttpRequest;
      };
      file.onProcess = () => { file.state = states.FILE_COMPLETE; loader.fileProcessComplete(file); };
      file.addToCache = () => {
        if (file.type === 'image') f.images.add(file.key);
        else f.metadata.set(file.key, file.key === 'sprite-meta' ? { sprites: {} } : { textures: [{ frames: [] }] });
      };
    });
    f.scene.preload(); loader.once('complete', f.scene.create, f.scene); loader.start();
    for (let batch = 0; batch < 3; batch++) {
      await vi.advanceTimersByTimeAsync(6_000); events.emit('update');
    }
    expect(started.size).toBe(24);
    const late = [...loader.inflight].find(file => file.key === 'warefallback-img')!;
    expect(late).toBeDefined(); expect(late.xhrSettings.timeout).toBe(BOOT_REQUEST_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(1_000);
    late.onProgress({ lengthComputable: true, loaded: 500_000, total: 2_880_461 } as ProgressEvent);
    await vi.advanceTimersByTimeAsync(999);
    expect(aborted).toEqual([]); expect(f.images.size + f.metadata.size).toBe(18);
    await vi.advanceTimersByTimeAsync(4_001); events.emit('update');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(aborted).toEqual([]);
    expect(started.size).toBe(ATLAS_PREFIXES.length * 2 + 1);
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(atlas.stitchAtlas).toHaveBeenCalledTimes(ATLAS_PREFIXES.length);
    expect(f.start).toHaveBeenCalledExactlyOnceWith('base');
    events.emit('destroy'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ delay: 16_000, hiddenMs: 0, cold: false }, { delay: 30_000, hiddenMs: 0, cold: false },
    { delay: 90_000, hiddenMs: 60_000, cold: false }, { delay: null, hiddenMs: 0, cold: false },
    { delay: 30_000, hiddenMs: 0, cold: true },
    { delay: 30_000, hiddenMs: 0, cold: false, streaming: true },
    { delay: null, hiddenMs: 0, cold: false, streaming: true },
    { delay: 75_000, hiddenMs: 0, cold: true, streaming: true, parallel: 32 },
    { delay: 75_000, hiddenMs: 0, cold: true, streaming: true, parallel: 6 },
    { delay: 75_000, hiddenMs: 0, cold: false, streaming: true, parallel: 32 },
    { delay: 75_000, hiddenMs: 0, cold: true, parallel: 32 }])('bounds a buffered or streaming response through actual Phaser XHR: %j', async ({ delay, hiddenMs, cold, streaming = false, parallel = 6 }) => {
    // A service worker holds its Response until the entire asset is verified.
    // The browser XHR stays OPENED with zero visible bytes throughout that wait.
    const require = createRequire(import.meta.url);
    const source = path.resolve(path.dirname(require.resolve('phaser')), '../src');
    const NativeLoader = require(path.join(source, 'loader/LoaderPlugin.js')) as typeof Phaser.Loader.LoaderPlugin;
    const NativeEvents = require(path.join(source, 'events/EventEmitter.js')) as typeof Phaser.Events.EventEmitter;
    const states = require(path.join(source, 'loader/const.js')) as { FILE_COMPLETE: number };
    require(path.join(source, 'loader/filetypes/ImageFile.js'));
    require(path.join(source, 'loader/filetypes/JSONFile.js'));
    const f = fixture('image'), events = new NativeEvents(), requests: string[] = [], aborted: string[] = [];
    const nativeFiles: Phaser.Loader.File[] = [];
    const emit = vi.spyOn(bus, 'emit'); let hidden = false;
    if (cold) { f.images.clear(); f.metadata.clear(); }
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    class BufferedXHR {
      readyState = 0; status = 0; timeout = 0; url = '';
      onload: ((event: { target: BufferedXHR }) => void) | null = null;
      ontimeout: ((event: { target: BufferedXHR }) => void) | null = null;
      onprogress: ((event: ProgressEvent) => void) | null = null;
      progressTimer?: ReturnType<typeof setInterval>;
      reader?: ReadableStreamDefaultReader<Uint8Array>;
      responseTimer?: ReturnType<typeof setTimeout>;
      timeoutTimer?: ReturnType<typeof setTimeout>;
      open(_method: string, url: string) { this.url = url; this.readyState = 1; }
      setRequestHeader() {}
      send() {
        requests.push(this.url);
        // A streaming body can expose increasing bytes without a computable
        // total. Native Phaser drops these events, but they are useful progress.
        if (streaming) {
          this.readyState = 3; this.status = 200;
          const chunks = new ReadableStream<Uint8Array>({ start: controller => {
            this.progressTimer = setInterval(() => controller.enqueue(new Uint8Array(10_000)), 7_000);
          } });
          this.reader = chunks.getReader();
          void (async () => {
            let loaded = 0;
            while (true) {
              const chunk = await this.reader!.read();
              if (chunk.done) break;
              loaded += chunk.value.byteLength;
              this.onprogress?.({ lengthComputable: false, loaded, total: 0 } as ProgressEvent);
            }
          })();
        }
        if (delay !== null) this.responseTimer = setTimeout(() => {
          clearTimeout(this.timeoutTimer); clearInterval(this.progressTimer); void this.reader?.cancel(); this.readyState = 4; this.status = 200;
          this.onload?.({ target: this });
        }, cold && !this.url.includes('/bld@2x.png') ? 1_000 : delay);
        if (this.timeout > 0) this.timeoutTimer = setTimeout(() => {
          clearTimeout(this.responseTimer); this.readyState = 4; this.ontimeout?.({ target: this });
        }, this.timeout);
      }
      abort() { clearTimeout(this.responseTimer); clearTimeout(this.timeoutTimer); clearInterval(this.progressTimer); void this.reader?.cancel(); aborted.push(this.url); }
    }
    vi.stubGlobal('XMLHttpRequest', BufferedXHR);
    const game = { ...f.game, config: { loaderMaxParallelDownloads: parallel }, scene: {} };
    Object.assign(f.scene, { events, game, sys: { events, settings: { loader: {} },
      game, cache: f.scene.cache, textures: f.scene.textures } });
    const loader = new NativeLoader(f.scene);
    Object.assign(f.scene, { load: loader }); events.emit('boot');
    loader.on('addfile', (_key: string, _type: string, _loader: unknown, file: Phaser.Loader.File) => {
      nativeFiles.push(file);
      // Keep installed File.load/XHRLoader/onLoad/onError and slot lifecycle;
      // only replace the eventual image decoder/cache with the existing fixture.
      file.onProcess = () => {
        if (streaming && (!cold || file.key === 'bld-img')) {
          expect(file.bytesLoaded).toBeGreaterThan(0);
          expect(file.bytesTotal).toBe(0); expect(file.percentComplete).toBe(-1);
        }
        file.state = states.FILE_COMPLETE; loader.fileProcessComplete(file);
      };
      file.addToCache = () => {
        if (file.type === 'image') f.images.add(file.key);
        else f.metadata.set(file.key, file.key === 'sprite-meta' ? { sprites: {} } : { textures: [{ frames: [] }] });
      };
    });
    f.scene.preload(); loader.once('complete', f.scene.create, f.scene); loader.start();
    const frames = cold ? setInterval(() => events.emit('update'), 250) : undefined;
    if (delay === null) {
      await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS);
      if (streaming) {
        const retired = nativeFiles[0]!, previous = retired.bytesLoaded;
        retired.onProgress({ lengthComputable: false, loaded: previous + 1, total: 0 } as ProgressEvent);
        expect(retired.bytesLoaded).toBe(previous); // old round cannot refresh this retry
      }
      await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS);
      expect(requests).toEqual(Array(2).fill(expect.stringContaining(`?v=${BUILD.gitSha}`)));
      expect(aborted).toHaveLength(2); expect(f.start).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledWith('boot:failed', expect.objectContaining({ diagnostics: expect.objectContaining({
        rounds: [1, 2].map(attempt => expect.objectContaining({ attempt, reason: 'active-deadline', activeMs: ONE_REQUEST_BUDGET_MS })),
      }) }));
    } else {
      if (hiddenMs) {
        await vi.advanceTimersByTimeAsync(10_000);
        hidden = true; document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(hiddenMs);
        expect(requests).toHaveLength(1); expect(aborted).toEqual([]);
        expect(f.start).not.toHaveBeenCalled();
        hidden = false; document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(delay - hiddenMs - 10_000);
      } else await vi.advanceTimersByTimeAsync(delay);
      expect(requests).toHaveLength(cold ? ATLAS_PREFIXES.length * 2 + 1 : 1);
      expect(new Set(requests).size).toBe(requests.length);
      expect(requests.every(url => url.endsWith(`?v=${BUILD.gitSha}`))).toBe(true);
      expect(aborted).toEqual([]);
      expect(f.start).toHaveBeenCalledExactlyOnceWith('base');
      expect(atlas.stitchAtlas).toHaveBeenCalledTimes(ATLAS_PREFIXES.length);
    }
    clearInterval(frames);
    events.emit('destroy'); expect(vi.getTimerCount()).toBe(0);
    for (const file of nativeFiles) {
      // A queued browser callback after cancellation/destruction must not touch
      // a destroyed native loader or the next round's useful-progress clock.
      expect(() => file.onProgress({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent)).not.toThrow();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defers an actual network failure while hidden, retaining the single recovery attempt', async () => {
    const f = fixture('image'), emit = vi.spyOn(bus, 'emit');
    let hidden = false, attempt = 0;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    f.behavior(() => ++attempt === 1 ? 'error' : 'success'); f.preload();
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS + BOOT_ROUND_TIMEOUT_MS * 3);
    expect(f.active.size).toBe(0);
    expect(f.requested).toHaveLength(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(atlas.stitchAtlas).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    expect(f.requested).toHaveLength(2);
    expect(f.requested[1]).toEqual(f.requested[0]);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.start).toHaveBeenCalledExactlyOnceWith('base');
    expect(f.game.events.listenerCount('pause')).toBe(0);
    expect(f.game.events.listenerCount('resume')).toBe(0);
    f.game.events.emit('resume'); document.dispatchEvent(new Event('visibilitychange'));
    expect(f.requested).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([6, 32])('caps each cold round at 120s despite nonstop byte progress with %s native slots', async parallel => {
    const f = fixture(), emit = vi.spyOn(bus, 'emit');
    f.images.clear(); f.metadata.clear(); f.load.maxParallelDownloads = parallel; f.behavior(() => 'decode'); f.preload();
    const count = ATLAS_PREFIXES.length * 2 + 1;
    const budget = BOOT_MIN_ROUND_BUDGET_MS;
    expect(budget).toBe(120_000);
    const progress = () => {
      for (const file of f.active) {
        const bytes = (file as PendingFile & { bytesLoaded?: number }).bytesLoaded ?? 0;
        Object.assign(file, { bytesLoaded: bytes + 1 }); f.load.emit('fileprogress', file);
      }
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let tick = 0; tick < 11; tick++) { await vi.advanceTimersByTimeAsync(10_000); progress(); }
      await vi.advanceTimersByTimeAsync(9_999); progress();
      expect(f.requested).toHaveLength(count * (attempt + 1));
      expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(f.requested).toHaveLength(count * 2);
    expect(emit.mock.calls.filter(([name]) => name === 'boot:failed')).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith('boot:failed', expect.objectContaining({
      diagnostics: { profile: 'full', rounds: [1, 2].map(attempt => expect.objectContaining({
        attempt, reason: 'active-deadline', activeMs: budget, budgetMs: budget,
        files: expect.arrayContaining([expect.objectContaining({ key: 'warefallback-img', kind: 'image' })]),
      })) },
    }));
    expect(f.start).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves remaining active and idle budgets through repeated background pauses', async () => {
    const f = fixture('image'); f.behavior(() => 'decode'); f.preload();
    const first = [...f.active][0]!;
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    for (let turn = 0; turn < 11; turn++) {
      await vi.advanceTimersByTimeAsync(10_000);
      Object.assign(first, { bytesLoaded: turn + 1 }); f.load.emit('fileprogress', first);
      hidden = true; document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.requested).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
      hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    }
    // Only ten seconds of the 120s active ceiling remain; the latest
    // progress must not turn each resume into another full round allowance.
    await vi.advanceTimersByTimeAsync(9_999); expect(f.requested).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.requested).toHaveLength(2);
    f.events.emit('destroy'); expect(vi.getTimerCount()).toBe(0);

    const idle = fixture('image'); idle.behavior(() => 'decode'); idle.preload();
    await vi.advanceTimersByTimeAsync(12_000);
    idle.game.isPaused = true; idle.game.events.emit('pause');
    await vi.advanceTimersByTimeAsync(60_000);
    idle.game.isPaused = false; idle.game.events.emit('resume');
    await vi.advanceTimersByTimeAsync(7_999); expect(idle.requested).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(idle.requested).toHaveLength(2);
    idle.events.emit('destroy'); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not renew idle time for duplicate byte-progress notifications', async () => {
    const f = fixture('image'); f.behavior(() => 'decode'); f.preload();
    const file = [...f.active][0]!;
    Object.assign(file, { bytesLoaded: 10 }); f.load.emit('fileprogress', file);
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS - 1);
    f.load.emit('fileprogress', file);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.requested).toHaveLength(2);
    f.events.emit('destroy'); expect(vi.getTimerCount()).toBe(0);
  });

  it('retains coarse pre-destruction file diagnostics without URLs or response bodies and removes diagnostic listeners', async () => {
    const f = fixture('image'), emit = vi.spyOn(bus, 'emit'); f.preload();
    const file = [...f.active][0]!;
    Object.assign(file, { state: 12, bytesLoaded: 90, bytesTotal: 100, url: 'https://private.invalid/secret' });
    Object.assign(file.xhrLoader, { status: 200, responseText: 'private-response-secret' });
    f.load.emit('load', file);
    Object.assign(file, { state: 16 }); // representative final process-error state
    f.load.emit('postprocess');
    Object.assign(file, { state: undefined, xhrLoader: undefined });
    await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS * 2);
    const payload = emit.mock.calls.find(([name]) => name === 'boot:failed')?.[1];
    expect(payload).toEqual(expect.objectContaining({ diagnostics: expect.objectContaining({
      rounds: expect.arrayContaining([expect.objectContaining({ files: [expect.objectContaining({
        key: `${ATLAS_PREFIXES.at(-1)!}-img`, kind: 'image', phase: 'processing',
        state: 16, status: 200, loadedBytes: 90, totalBytes: 100,
      })] })]),
    }) }));
    expect(JSON.stringify(payload)).not.toContain('private');
    for (const event of ['fileprogress', 'load', 'loaderror', 'filecomplete', 'postprocess']) {
      expect(f.load.listenerCount(event)).toBe(0);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['hidden', 'paused'] as const)('starts a fresh bounded decode watchdog after an initially %s boot resumes', async suspension => {
    const f = fixture('image'), emit = vi.spyOn(bus, 'emit');
    let hidden = suspension === 'hidden', attempt = 0;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    f.game.isPaused = suspension === 'paused';
    f.behavior(() => ++attempt === 1 ? 'decode' : 'success'); f.preload();
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS * 3);
    expect(f.load.reset).not.toHaveBeenCalled();
    expect(f.requested).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    hidden = false; f.game.isPaused = false;
    if (suspension === 'hidden') document.dispatchEvent(new Event('visibilitychange'));
    else f.game.events.emit('resume');
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS - 1);
    expect(f.requested).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(51);
    expect(f.requested).toHaveLength(2);
    expect(f.start).toHaveBeenCalledExactlyOnceWith('base');
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['shutdown', 'destroy'])('removes hidden deferred validation and pause listeners on %s', async lifecycle => {
    const f = fixture('image'), emit = vi.spyOn(bus, 'emit');
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const remove = vi.spyOn(document, 'removeEventListener');
    f.preload();
    hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(ONE_REQUEST_BUDGET_MS);
    expect(f.requested).toHaveLength(1);
    f.events.emit(lifecycle);
    expect(f.game.events.listenerCount('pause')).toBe(0);
    expect(f.game.events.listenerCount('resume')).toBe(0);
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    f.game.events.emit('resume'); f.load.emit('complete');
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS * 3);
    expect(f.requested).toHaveLength(1);
    expect(f.start).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(emit).not.toHaveBeenCalledWith('boot:ready', undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts shutdown work even when Phaser already cleared its loading queue; no late retry may boot', async () => {
    const f = fixture('image'), emit = vi.spyOn(bus, 'emit'); f.preload();
    const file = [...f.active][0]!;
    f.load.reset(); f.events.emit('shutdown');
    expect(file.xhrLoader.abort).toHaveBeenCalledOnce();
    expect(file.xhrLoader.ontimeout).toBeNull();
    f.load.emit('complete');
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS * 3);
    expect(f.requested).toHaveLength(1); expect(f.start).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('boot:ready', undefined);
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a direct scene destruction after the installed Phaser loader has destroyed its Sets', async () => {
    // Game.runDestroy calls SceneManager.destroy → Systems.destroy directly,
    // without a shutdown first. Use the installed loader and event emitter so
    // their listener order/nulling behavior cannot drift behind our fixture.
    const require = createRequire(import.meta.url);
    const source = path.resolve(path.dirname(require.resolve('phaser')), '../src');
    const NativeLoader = require(path.join(source, 'loader/LoaderPlugin.js')) as typeof Phaser.Loader.LoaderPlugin;
    const NativeEvents = require(path.join(source, 'events/EventEmitter.js')) as typeof Phaser.Events.EventEmitter;
    require(path.join(source, 'loader/filetypes/ImageFile.js'));
    require(path.join(source, 'loader/filetypes/JSONFile.js'));
    const f = fixture('image'), events = new NativeEvents(), emit = vi.spyOn(bus, 'emit');
    Object.assign(f.scene, { events, sys: { events, settings: { loader: {} },
      game: { config: {}, scene: {} }, cache: f.scene.cache, textures: f.scene.textures } });
    const loader = new NativeLoader(f.scene);
    Object.assign(f.scene, { load: loader });
    events.emit('boot'); // Phaser's destroy listener precedes Boot.preload's.
    f.scene.preload();
    const file = [...loader.list][0]!, abort = vi.fn();
    const decode = { src: 'blob:stalled', onload: vi.fn(), onerror: vi.fn(), removeAttribute: vi.fn() };
    Object.assign(file, { xhrLoader: { abort, onload: vi.fn(), onerror: vi.fn(), onprogress: vi.fn(), ontimeout: vi.fn(), onabort: vi.fn() }, data: decode });
    const reset = vi.spyOn(loader, 'reset');
    expect(() => events.emit('destroy')).not.toThrow();
    expect(loader.list).toBeNull();
    expect(reset).toHaveBeenCalledOnce(); // Loader.destroy's reset only.
    expect(abort).toHaveBeenCalledOnce();
    expect(decode.onload).toBeNull(); expect(decode.onerror).toBeNull();
    await vi.advanceTimersByTimeAsync(BOOT_ROUND_TIMEOUT_MS * 3);
    expect(f.start).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith('boot:ready', undefined);
    expect(emit).not.toHaveBeenCalledWith('boot:failed', expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });
});
