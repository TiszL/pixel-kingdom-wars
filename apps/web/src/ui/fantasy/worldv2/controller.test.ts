// The World v2 conductor's rules, with both engines faked (no GL in the test runner). Why each matters:
//   * kill switch: an explicit worldV2.enabled=false must put every web player back on the CPU globe without a
//     release, while a slow or missing answer must not (the build default stands);
//   * one engine awake (R5): the globe (≈118 MB) and a realm (≈107 MB) both drawing is what ran phones out of memory;
//   * dispose/restore: a phone that drops a context, or a world over the budget, must come back on the same realm and
//     camera instead of a black stage (native's lock-screen resume);
//   * Back order: a TWA Back must peel one layer at a time (island panel → dive → realm map → the host's chain),
//     never skip the realm map straight to the base;
//   * "My base" and every focus land on the deed with it selected (native 62ff4e1); a failed dive says so and a
//     cancelled one does not (native 0df4d71).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobeHandle, GlobeOptions, GlobeSnapshot } from './globe/globe.mjs';
import type { RealmViewHandle, RealmViewHost } from './realm/adapter';
import { WORLD_COPY } from './copy';
import {
  CONTEXT_RESTORE_WAIT_MS, MAX_GLOBE_REBUILDS, REALM_HOST_ZOOM, WORLD_V2_GPU_BUDGET_BYTES, createWorldController,
  type WorldController, type WorldEngines, type WorldEvents,
} from './controller';

const MB = 1024 * 1024;
const CROWN_TILE = 1234, FROST_TILE = 99;
const tiles: Record<number, { realmId: string; lon: number; lat: number }> = {
  [CROWN_TILE]: { realmId: 'crownlands', lon: 26, lat: 23 }, [FROST_TILE]: { realmId: 'frostveil', lon: -23, lat: 53 },
};

interface FakeCanvas { removed: boolean; lost: boolean; listeners: Map<string, () => void>; remove(): void; addEventListener(n: string, f: () => void): void; getContext(): unknown }
const fakeCanvas = (): FakeCanvas => {
  const c: FakeCanvas = { removed: false, lost: false, listeners: new Map(),
    remove() { c.removed = true; }, addEventListener(n, f) { c.listeners.set(n, f); },
    getContext: () => ({ getExtension: () => ({ loseContext() { c.lost = true; } }) }) };
  return c;
};

type FakeGlobe = GlobeHandle & { opts: GlobeOptions; canvas: FakeCanvas; bytes: number; disposed: boolean; asleepNow: boolean };
function fakeGlobe(canvas: FakeCanvas, opts: GlobeOptions): FakeGlobe {
  const g = {
    opts, canvas, bytes: 100 * MB, disposed: false, asleepNow: false,
    ready: Promise.resolve(), state: 'ready' as const, failure: null,
    get asleep() { return g.asleepNow; },
    get selection() { return { realmId: 'crownlands', islandId: null }; },
    resize: vi.fn(), setLayout: vi.fn(), setDivable: vi.fn(), setReducedMotion: vi.fn(), setNight: vi.fn(), setClouds: vi.fn(),
    selectRealm: vi.fn(() => true), selectIsland: vi.fn(() => true), deselect: vi.fn(), focusRealm: vi.fn(() => true),
    focusIsland: vi.fn(() => true), focusPoint: vi.fn(), zoomBy: vi.fn(), home: vi.fn(),
    view: () => ({ lon: 26, lat: 23, zoom: 1.4 }), setView: vi.fn(),
    diveInto: vi.fn((id: string) => { opts.on?.approach?.(id); return true; }),
    cancelDive: vi.fn(() => 'crownlands'),
    diveReady: vi.fn(), diveResult: vi.fn((ok: boolean) => { if (ok) g.asleepNow = true; }),
    leave: vi.fn(async () => { g.asleepNow = false; }), sleep: vi.fn(() => { g.asleepNow = true; }), wake: vi.fn(async () => { g.asleepNow = false; }),
    snapshot: vi.fn((): GlobeSnapshot => ({ t: [0.1, 0.2, 0.97], z: 0.62, realmId: 'crownlands', islandId: null })), restore: vi.fn(),
    labels: () => [], gpuBytes: () => g.bytes,
    stats: () => ({ state: 'ready', frames: 1, albedo: 1024, islands: true, phaseE: true, gpuBytes: g.bytes, view: { lon: 0, lat: 0, zoom: 1 }, alt: 1 }),
    dispose: vi.fn(() => { g.disposed = true; }),
  };
  return g as unknown as FakeGlobe;
}

interface Deferred { resolve(): void; reject(e: unknown): void }
type FakeRealm = RealmViewHandle & { host: RealmViewHost; canvas: FakeCanvas; mb: number; entries: Deferred[]; cam: { x: number; y: number; d: number; s: number }; disposedBeforeLoss: boolean | null };
function fakeRealm(o: { canvas: FakeCanvas; host: RealmViewHost }): FakeRealm {
  const cam = { x: 40, y: 30, d: 300, s: 2, sMin: () => 1 };
  const r = {
    host: o.host, canvas: o.canvas, mb: 100, entries: [] as Deferred[], cam,
    engine: { cam, flyToD: vi.fn(), setFilter: vi.fn() },
    has: () => true, prefetch: vi.fn(),
    enter: vi.fn((_id: string, _lon: number, _lat: number, _s?: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
      r.entries.push({ resolve, reject });
      signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    })),
    setMarkers: vi.fn(), select: vi.fn(),
    bounds: () => ({ realmId: 'crownlands', x0: 400, y0: 120, x1: 440, y1: 150 }),
    chromeChanged: vi.fn(), leave: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
    // the engine's own dispose must run before its context is lost on purpose (map.mjs P11: that loss is not a GPU reset)
    disposedBeforeLoss: null as boolean | null,
    dispose: vi.fn(() => { if (r.disposedBeforeLoss === null) r.disposedBeforeLoss = !o.canvas.lost; }),
    stats: () => ({ gpuMB: { realm: r.mb } }),
  };
  return r as unknown as FakeRealm;
}

let globes: FakeGlobe[], realms: FakeRealm[], events: Record<string, unknown[][]>, capability: boolean | null;
let engines: WorldEngines, on: WorldEvents, ctl: WorldController;
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const calls = (name: string): unknown[][] => events[name] ?? [];
const last = (name: string): unknown => calls(name).at(-1)?.[0];

function build(selectedTileId: number | null = null): WorldController {
  ctl = createWorldController(engines, on, { view: { lon: 26, lat: 23, zoom: 1 }, markers: [], selectedTileId, reducedMotion: false });
  return ctl;
}
async function started(selectedTileId: number | null = null): Promise<FakeGlobe> {
  build(selectedTileId); await ctl.start(); return globes.at(-1)!;
}
/** Enter map on crownlands and land. */
async function landed(): Promise<{ globe: FakeGlobe; realm: FakeRealm }> {
  const globe = await started();
  ctl.setView({ lon: 26, lat: 23, zoom: 16 });
  await flush();
  globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
  await flush();
  const realm = realms.at(-1)!;
  realm.entries.at(-1)!.resolve();
  await flush();
  return { globe, realm };
}

beforeEach(() => {
  globes = []; realms = []; events = {}; capability = null;
  const record = (name: string) => (...args: unknown[]) => { (events[name] ??= []).push(args); };
  engines = {
    capability: async () => capability,
    createGlobe: (canvas, opts) => { const g = fakeGlobe(canvas as unknown as FakeCanvas, opts); globes.push(g); return g; },
    createRealm: async o => { const r = fakeRealm(o as unknown as { canvas: FakeCanvas; host: RealmViewHost }); realms.push(r); return r; },
    globeOptions: { chains: [], fileUrl: p => p },
    newCanvas: () => fakeCanvas() as unknown as HTMLCanvasElement,
    newRealmUi: () => ({ remove() {} }) as unknown as HTMLElement,
    tileRealm: id => tiles[id] ?? null,
    realmAt: (lon, lat) => (Math.abs(lon - 26) < 5 && Math.abs(lat - 23) < 5 ? 'crownlands' : Math.abs(lon + 23) < 5 ? 'frostveil' : null),
    realmBounds: w => ({ west: w.x0 / 2 - 180, east: w.x1 / 2 - 180, north: 90 - w.y0 / 2, south: 90 - w.y1 / 2 }),
  };
  on = {
    ready: record('ready'), fallback: record('fallback'), select: record('select'), realmSelect: record('realmSelect'),
    explore: record('explore'), island: record('island'), view: record('view'), bounds: record('bounds'), mode: record('mode'),
    notice: record('notice'), landed: record('landed'), labels: record('labels'),
    panelOpen: () => false, chromeRects: () => [],
  };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { ctl?.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('kill switch (runtime capability)', () => {
  it('an explicit worldV2.enabled=false falls back to the CPU globe before any GL engine exists', async () => {
    capability = false;
    build(); await ctl.start();
    expect(globes).toHaveLength(0);
    expect(last('fallback')).toMatch(/^capability-off/);
    expect(ctl.mode).toBe('failed');
  });

  it('a missing field or a timed-out read (null) keeps the build default: the globe starts', async () => {
    capability = null;
    await started();
    expect(globes).toHaveLength(1);
    expect(calls('fallback')).toHaveLength(0);
    expect(ctl.mode).toBe('globe');
  });

  it('a globe that cannot get WebGL2 hands the stage back with the reason', async () => {
    engines.createGlobe = () => { throw new Error('WebGL2 unavailable'); };
    build(); await ctl.start();
    expect(last('fallback')).toBe('globe: WebGL2 unavailable');
  });
});

describe('one GL engine awake', () => {
  it('prefetches chunk B mid-approach, sleeps the globe once the dive lands, and wakes it only as the realm stops', async () => {
    const globe = await started();
    expect(ctl.engines()).toEqual({ globe: 'awake', realm: 'none' });
    ctl.setView({ lon: 26, lat: 23, zoom: 16 }); // INSPECT LAND TILES
    await flush();
    expect(globe.diveInto).toHaveBeenCalledWith('crownlands');
    // the approach event fired with diveInto: the realm engine is imported and prefetching before the dive event
    expect(realms).toHaveLength(1);
    expect(realms[0]!.prefetch).toHaveBeenCalledWith('crownlands');
    expect(ctl.mode).toBe('approach');
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await flush();
    expect(ctl.mode).toBe('diving');
    expect(realms).toHaveLength(1); // the prefetched engine is the one that enters
    realms[0]!.entries[0]!.resolve();
    await flush();
    expect(ctl.mode).toBe('realm');
    expect(globe.diveResult).toHaveBeenCalledWith(true, 'crownlands');
    expect(ctl.engines()).toEqual({ globe: 'asleep', realm: 'active' });
    await ctl.exitRealm();
    expect(globe.leave).toHaveBeenCalledWith(expect.objectContaining({ realmId: 'crownlands' }));
    expect(realms[0]!.leave).toHaveBeenCalled();
    expect(ctl.engines()).toEqual({ globe: 'awake', realm: 'idle' });
  });

  it('reports the realm map on the host scale (zoom >= 5) with its ground box, and the globe again (< 5, no box) after', async () => {
    await landed();
    expect(last('landed')).toBe('crownlands');
    expect((last('view') as { zoom: number }).zoom).toBeGreaterThanOrEqual(REALM_HOST_ZOOM);
    expect(last('bounds')).toEqual({ west: 20, east: 40, north: 30, south: 15 });
    await ctl.exitRealm();
    expect(last('bounds')).toBeNull();
    expect((last('view') as { zoom: number }).zoom).toBeLessThan(REALM_HOST_ZOOM);
  });
});

describe('Back order', () => {
  it('island panel, then the dive in flight, then realm map -> globe; nothing left declines to the host chain', async () => {
    const globe = await started();
    globe.opts.on!.pick!({ kind: 'phase-e', id: 'seeker-island', lon: -83, lat: 32 });
    expect(last('island')).toBe('seeker-island');
    expect(ctl.backWanted()).toBe(true);
    expect(ctl.back()).toBe(true);
    expect(last('island')).toBeNull();

    ctl.setView({ lon: 26, lat: 23, zoom: 16 });
    await flush();
    expect(ctl.mode).toBe('approach');
    expect(ctl.back()).toBe(true); // Back during the approach flight cancels the dive
    expect(globe.cancelDive).toHaveBeenCalled();
    expect(ctl.mode).toBe('globe');

    ctl.setView({ lon: 26, lat: 23, zoom: 16 });
    await flush();
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await flush();
    expect(ctl.back()).toBe(true); // Back while the realm loads under the cover: cancelled, silently
    await flush();
    expect(globe.diveResult).toHaveBeenLastCalledWith(false, 'crownlands');
    expect(calls('notice').filter(c => c[0] !== null)).toHaveLength(0);
    expect(ctl.mode).toBe('globe');

    expect(ctl.backWanted()).toBe(false);
    expect(ctl.back()).toBe(false); // the host's own chain (query, panels, selection, base) takes it
  });

  it('inside a realm map an open card is the host\'s to close first, then Back leaves to the globe', async () => {
    await landed();
    ctl.setSelected(CROWN_TILE);
    expect(ctl.backWanted()).toBe(false);
    ctl.setSelected(null);
    expect(ctl.backWanted()).toBe(true);
    expect(ctl.back()).toBe(true);
    await flush();
    expect(ctl.mode).toBe('globe');
  });
});

describe('dispose and restore', () => {
  it('over the GPU budget the sleeping globe is fully disposed, then rebuilt from its snapshot (realm + camera) on leaving', async () => {
    vi.useFakeTimers();
    const { globe, realm } = await landed();
    realm.mb = (WORLD_V2_GPU_BUDGET_BYTES - globe.bytes) / MB + 1;
    await vi.advanceTimersByTimeAsync(500);
    expect(globe.dispose).toHaveBeenCalled();
    expect(globe.canvas.removed).toBe(true);
    expect(ctl.engines().globe).toBe('none');
    const exit = ctl.exitRealm();
    await vi.advanceTimersByTimeAsync(0); await exit;
    const rebuilt = globes.at(-1)!;
    expect(rebuilt).not.toBe(globe);
    expect(rebuilt.opts.initial).toEqual({ t: [0.1, 0.2, 0.97], z: 0.62, realmId: 'crownlands', islandId: null });
    expect(rebuilt.leave).toHaveBeenCalledWith(expect.objectContaining({ realmId: 'crownlands' }));
    expect(ctl.mode).toBe('globe');
  });

  it('a globe context the browser restores in time is kept; one it does not is rebuilt, and repeated losses fall back', async () => {
    vi.useFakeTimers();
    const globe = await started();
    globe.opts.on!.contextLost!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS / 2);
    globe.opts.on!.contextRestored!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS);
    expect(globes).toHaveLength(1);
    for (let n = 1; n <= MAX_GLOBE_REBUILDS; n++) {
      globes.at(-1)!.opts.on!.contextLost!();
      await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS);
      expect(globes).toHaveLength(n + 1);
      expect(globes.at(-1)!.opts.initial).toEqual(expect.objectContaining({ realmId: 'crownlands' }));
    }
    expect(calls('fallback')).toHaveLength(0);
    globes.at(-1)!.opts.on!.contextLost!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS);
    expect(last('fallback')).toBe('globe context lost');
  });

  it('a realm context lost for good comes back on the same realm and camera, after the tab is visible again', async () => {
    vi.useFakeTimers();
    const { realm } = await landed();
    await vi.advanceTimersByTimeAsync(500); // a camera tick records the restore point
    ctl.visibility(true);
    realm.canvas.listeners.get('webglcontextlost')!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS);
    expect(realms).toHaveLength(1); // nothing is rebuilt behind a hidden tab
    ctl.visibility(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(realm.dispose).toHaveBeenCalled();
    expect(realm.canvas.lost && realm.canvas.removed).toBe(true);
    const again = realms.at(-1)!;
    expect(again).not.toBe(realm);
    expect(again.enter).toHaveBeenCalledWith('crownlands', expect.any(Number), expect.any(Number), 18, expect.anything());
    again.entries[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(again.engine.flyToD).toHaveBeenCalledWith(40, 30, 300, 0);
    expect(ctl.mode).toBe('realm');
  });

  it('a realm rebuilt after a lost context keeps its GPU notice (it is not the world leaving)', async () => {
    vi.useFakeTimers();
    const { realm } = await landed();
    realm.canvas.listeners.get('webglcontextlost')!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS);
    expect(realm.dispose).toHaveBeenCalledWith({ notices: false });
  });

  // Review r2 (L9) #2: every way back to 'globe' must leave a globe that exists and is awake. A re-entry after a lost
  // realm context runs under a globe that slept when the first dive landed; a Back during a dive can find the globe
  // disposed by a rebuild. Either left the player on a frozen or blank stage.
  it('a failed re-entry after a lost realm context wakes the sleeping globe', async () => {
    vi.useFakeTimers();
    const { globe, realm } = await landed();
    await vi.advanceTimersByTimeAsync(500);
    expect(globe.asleep).toBe(true);
    realm.canvas.listeners.get('webglcontextlost')!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS);
    realms.at(-1)!.entries[0]!.reject(new Error('no progress for 12 s'));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctl.mode).toBe('globe');
    expect(ctl.engines().globe).toBe('awake');
    expect(last('notice')).toBe(WORLD_COPY.diveFailed);
  });

  it('Back during a dive whose globe was disposed by a rebuild brings a globe back, awake, on the dived realm', async () => {
    vi.useFakeTimers();
    const globe = await started();
    ctl.setView({ lon: 26, lat: 23, zoom: 16 });
    await vi.advanceTimersByTimeAsync(0);
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await vi.advanceTimersByTimeAsync(0);
    globe.opts.on!.contextLost!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS); // rebuildGlobe in 'diving' disposes it and waits
    expect(ctl.engines().globe).toBe('none');
    expect(ctl.back()).toBe(true);
    expect(ctl.mode).toBe('globe');
    expect(ctl.engines().globe).toBe('awake');
    expect(globes.at(-1)!.diveResult).toHaveBeenCalledWith(false, 'crownlands');
  });

  // Review r2 (L9) #4: Android discards a hidden renderer without a pagehide; the realm map's visit marker then reads as
  // a crash and the next visit starts in safe mode (or is held). A hidden realm map suspends it, and showing resumes it.
  it('hiding the page inside a realm map suspends the visit marker; showing it resumes', async () => {
    const { realm } = await landed();
    ctl.visibility(true);
    expect(realm.suspend).toHaveBeenCalledOnce();
    expect(realm.resume).not.toHaveBeenCalled();
    ctl.visibility(false);
    expect(realm.resume).toHaveBeenCalledOnce();
  });

  it('a realm context lost for good while the dive loads fails that dive with the notice, never a stuck cover', async () => {
    vi.useFakeTimers();
    const globe = await started();
    ctl.setView({ lon: 26, lat: 23, zoom: 16 });
    await vi.advanceTimersByTimeAsync(0);
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await vi.advanceTimersByTimeAsync(0);
    const realm = realms[0]!;
    realm.canvas.listeners.get('webglcontextlost')!();
    await vi.advanceTimersByTimeAsync(CONTEXT_RESTORE_WAIT_MS);
    expect(realm.dispose).toHaveBeenCalled();
    expect(globe.diveResult).toHaveBeenLastCalledWith(false, 'crownlands');
    expect(last('notice')).toBe(WORLD_COPY.diveFailed);
    expect(ctl.mode).toBe('globe');
  });

  it('stop releases both engines and their canvases', async () => {
    const { globe, realm } = await landed();
    ctl.stop();
    expect(globe.dispose).toHaveBeenCalled();
    expect(realm.dispose).toHaveBeenCalled();
    expect(realm.canvas.removed && globe.canvas.removed).toBe(true);
  });

  // Review r2 (L9) #1: the forced context loss used to reach an engine that still believed it was loading, and it stored
  // a GPU-reset crash record: every later visit started in safe mode. The engine's dispose must come first, and a world
  // that is leaving takes its GPU notices (a fixed banner outside React) down with it.
  it('leaving the map mid-dive disposes the realm engine before its context is lost, and takes its notices down', async () => {
    const globe = await started();
    ctl.setView({ lon: 26, lat: 23, zoom: 16 });
    await flush();
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await flush();
    const realm = realms[0]!; // still loading under the cover
    ctl.stop();
    expect(realm.dispose).toHaveBeenCalledWith({ notices: true });
    expect(realm.disposedBeforeLoss).toBe(true);
    expect(realm.canvas.lost && realm.canvas.removed).toBe(true);
  });

});

describe('landing, selection and failures', () => {
  it('"My base" (focusTile) dives into the tile\'s realm and lands with that deed selected', async () => {
    const globe = await started();
    ctl.focusTile(CROWN_TILE);
    await flush();
    expect(globe.diveInto).toHaveBeenCalledWith('crownlands');
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await flush();
    realms[0]!.entries[0]!.resolve();
    await flush();
    expect(realms[0]!.select).toHaveBeenCalledWith(CROWN_TILE, true);
    // already in its realm: selected in place, no new dive
    ctl.focusTile(CROWN_TILE);
    expect(globe.diveInto).toHaveBeenCalledTimes(1);
  });

  it('a focus requested before the globe exists (host draft on open) is applied once it does', async () => {
    build();
    ctl.focusTile(CROWN_TILE);
    await ctl.start();
    await flush();
    expect(globes[0]!.diveInto).toHaveBeenCalledWith('crownlands');
  });

  it('the realm map\'s selection follows the host card (native 62ff4e1)', async () => {
    const { realm } = await landed();
    ctl.setSelected(CROWN_TILE);
    expect(realm.select).toHaveBeenLastCalledWith(CROWN_TILE);
    ctl.setSelected(null);
    expect(realm.select).toHaveBeenLastCalledWith(null);
    ctl.setSelected(FROST_TILE); // another realm's deed never marks this map
    expect(realm.select).toHaveBeenLastCalledWith(null);
  });

  // Review r2 (L9) #7: the realm engine's pinch-out below 0.7 × the fit (and − at the fit) calls host.onExit. Without the
  // controller's wiring the player is stranded in the realm map with every test green.
  it('the realm map\'s own exit (pinch-out) returns to the globe, awake', async () => {
    const { globe, realm } = await landed();
    expect(ctl.engines()).toEqual({ globe: 'asleep', realm: 'active' });
    realm.host.onExit!({ lon: 26, lat: 23 });
    await flush();
    expect(ctl.mode).toBe('globe');
    expect(globe.leave).toHaveBeenCalledWith(expect.objectContaining({ realmId: 'crownlands' }));
    expect(ctl.engines()).toEqual({ globe: 'awake', realm: 'idle' });
  });

  it('every realm-map tap reaches the host as onSelect', async () => {
    const { realm } = await landed();
    realm.host.onSelect(CROWN_TILE);
    realm.host.onSelect(null);
    expect(calls('select').map(c => c[0])).toEqual([CROWN_TILE, null]);
  });

  it('a dive that fails reopens the realm with the retry notice; the next dive clears it', async () => {
    const globe = await started();
    ctl.setView({ lon: 26, lat: 23, zoom: 16 });
    await flush();
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await flush();
    realms[0]!.entries[0]!.reject(new Error('no progress for 12 s'));
    await flush();
    expect(globe.diveResult).toHaveBeenCalledWith(false, 'crownlands');
    expect(last('notice')).toBe(WORLD_COPY.diveFailed);
    expect(ctl.mode).toBe('globe');
    globe.opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 });
    await flush();
    expect(last('notice')).toBeNull();
  });

  it('GENESIS SANCTUARY (zoom 3.8) stays on the globe; a Phase E tap opens the coming-soon panel, never a map', async () => {
    const globe = await started();
    ctl.setView({ lon: -115, lat: 38, zoom: 3.8 });
    expect(globe.setView).toHaveBeenCalledWith({ lon: -115, lat: 38, zoom: 3.8 });
    expect(globe.diveInto).not.toHaveBeenCalled();
    globe.opts.on!.pick!({ kind: 'phase-e', id: 'divine-isle', lon: 94, lat: 4 });
    expect(last('island')).toBe('divine-isle');
    expect(globe.diveInto).not.toHaveBeenCalled();
    globe.opts.on!.pick!({ kind: 'realm', index: 3, id: 'crownlands', deedEligible: true, lon: 26, lat: 23 });
    expect(last('realmSelect')).toBe('crownlands');
    expect(last('island')).toBeNull();
    globe.opts.on!.pick!({ kind: 'explore', chainId: 'emberreach', islandId: 'emberreach-2', lon: 0, lat: 0 });
    expect(last('explore')).toEqual({ chainId: 'emberreach', islandId: 'emberreach-2' });
  });
});
