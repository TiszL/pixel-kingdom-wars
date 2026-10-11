// The World v2 conductor (D-186, PLAN §2 / §3 L6): one flat globe (chunk A) and one realm-map engine (chunk B) behind
// the frozen host contract. No React and no GL of its own: WorldV2.tsx hands it the engine factories and the DOM
// layers, and maps its events onto the host's props. It owns the rules the owner reviewed on native:
//   * exactly one GL engine is awake: the globe sleeps once a dive lands, the realm map stops when the globe wakes;
//   * the realm engine (chunk B) is imported and prefetched mid-approach, not at the tap (D-177, native 1e0668db);
//   * a resident estimate above WORLD_V2_GPU_BUDGET_BYTES fully disposes the sleeping engine, and a context that is
//     lost for longer than CONTEXT_RESTORE_WAIT_MS is rebuilt on a fresh canvas from its snapshot: the realm and the
//     camera come back (native's lock-screen resume, as a web behaviour); a globe that cannot be rebuilt falls back;
//   * Back: island panel, then a dive in flight, then realm map → globe; the host's own chain (priority 100) after;
//   * "My base" / search / a draft land on their deed with it selected (native 62ff4e1: selection follows the card);
//   * a dive that fails shows the retry notice above the reopened realm (native 0df4d71); a cancelled one is silent;
//   * zoom on the host scale: < 5 on the globe, >= 5 inside a realm map, and the realm camera's ground box.
// Types only from the engines: importing their code here would pull chunk B into chunk A.
import type { FantasyView } from '../types';
import type { FantasyViewBounds } from '../data';
import type { GlobeDive, GlobeHandle, GlobeLabelAnchor, GlobeLayout, GlobeOptions, GlobePick, GlobeSnapshot } from './globe/globe.mjs';
import type { OwnShieldRead, RealmViewBounds, RealmViewHandle, RealmViewHost, WorldMarker } from './realm/adapter';
import { WORLD_V2_SPECIAL_ISLANDS, type WorldV2SpecialIslandId } from './contract';
import { WORLD_COPY } from './copy';

const MB = 1024 * 1024;
/** R5: the globe (≈118 MB) and a realm (≈107 MB) resident together must stay under this estimate on a phone. */
export const WORLD_V2_GPU_BUDGET_BYTES = 256 * MB;
/** A lost context the browser has not restored within this long is rebuilt from its snapshot. */
export const CONTEXT_RESTORE_WAIT_MS = 3_000;
/** How often a realm map's camera box and the resident estimate are read. */
export const REALM_POLL_MS = 400;
/** A globe that has to be rebuilt more often than this in one visit is not coming back: CPU globe. */
export const MAX_GLOBE_REBUILDS = 2;
/** The host's zoom floor inside a realm map (its parcel feed switches on at 5). */
export const REALM_HOST_ZOOM = 5;
const DIVE_RETRY_MS = [0, 600, 1_600];

export type WorldMode = 'starting' | 'globe' | 'approach' | 'diving' | 'realm' | 'leaving' | 'failed' | 'stopped';

export interface WorldEngines {
  /** The shared runtime kill switch (worldV2Support.worldV2Capability): false = CPU globe, null = build default. */
  capability(): Promise<boolean | null>;
  createGlobe(canvas: HTMLCanvasElement, options: GlobeOptions): GlobeHandle;
  /** Chunk B: import the realm adapter and create its view. */
  createRealm(o: { canvas: HTMLCanvasElement; ui: HTMLElement; host: RealmViewHost }): Promise<RealmViewHandle>;
  globeOptions: Omit<GlobeOptions, 'on' | 'initial'>;
  /** A fresh canvas (or label root) appended to its layer. A disposed engine's canvas is removed, never reused:
   *  a context lost on purpose cannot be created again on the same element. */
  newCanvas(layer: 'globe' | 'realm'): HTMLCanvasElement;
  newRealmUi(): HTMLElement;
  /** Catalogue lookups (@shardkeep/shared/fantasyWorld). */
  tileRealm(tileId: number): { realmId: string; lon: number; lat: number } | null;
  realmAt(lon: number, lat: number): string | null;
  /** A realm window in catalogue deed columns/rows as the host's degree box (realmFeed.realmWindowBounds). */
  realmBounds(window: RealmViewBounds): FantasyViewBounds;
}

export interface WorldEvents {
  ready(): void;
  fallback(reason: string): void;
  select(tileId: number | null): void;
  realmSelect(realmId: string): void;
  explore(destination: { chainId: string; islandId: string | null }): void;
  island(id: WorldV2SpecialIslandId | null): void;
  view(view: FantasyView): void;
  bounds(bounds: FantasyViewBounds | null): void;
  mode(mode: WorldMode): void;
  notice(text: string | null): void;
  /** A dive landed (native 78b20d3: a choose-land visit ends its choose mode here). */
  landed(realmId: string): void;
  labels(anchors: GlobeLabelAnchor[]): void;
  /** What the realm engine's host asks: is a card open, and where is the chrome. */
  panelOpen(): boolean;
  chromeRects(): [number, number, number, number][];
}

export interface WorldController {
  readonly mode: WorldMode;
  readonly island: WorldV2SpecialIslandId | null;
  readonly realmId: string | null;
  start(): Promise<void>;
  stop(): void;
  back(): boolean;
  /** Whether Back is this world's to handle right now (the host's handler runs otherwise). */
  backWanted(): boolean;
  focusRealm(realmId: string): void;
  focusTile(tileId: number): void;
  focusIsland(chainId: string, islandId?: string): void;
  setView(view: FantasyView): void;
  view(): FantasyView;
  exitRealm(): Promise<void>;
  openIsland(id: WorldV2SpecialIslandId): void;
  closeIsland(): void;
  selectInRealm(tileId: number): void;
  /** The host's markers, and the player's own /base shield read (D-181: it can only add a dome to their kingdom). */
  setMarkers(markers: readonly WorldMarker[], own?: OwnShieldRead | null): void;
  setSelected(tileId: number | null): void;
  setLayout(layout: GlobeLayout): void;
  setReducedMotion(reduced: boolean): void;
  /** D-191: a kingdom that fails the filter is hidden on the realm map; 'unshielded' keeps only an explicit shield: false. */
  setFilter(filter: { kind?: 'all' | 'mine' | 'unshielded'; lvl?: [number, number] }): void;
  visibility(hidden: boolean): void;
  /** The estimated resident GPU bytes of both engines. */
  gpuBytes(): number;
  /** Test/diagnostic view of which engines exist and which is awake. */
  engines(): { globe: 'none' | 'asleep' | 'awake'; realm: 'none' | 'idle' | 'active' };
}

const isSpecial = (id: string | null | undefined): id is WorldV2SpecialIslandId => (WORLD_V2_SPECIAL_ISLANDS as readonly string[]).includes(id ?? '');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';
const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;
function loseContext(canvas: HTMLCanvasElement | null): void {
  try { (canvas?.getContext('webgl2') as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
}

export function createWorldController(E: WorldEngines, on: WorldEvents, init: {
  view: FantasyView; markers: readonly WorldMarker[]; selectedTileId: number | null; reducedMotion: boolean;
}): WorldController {
  let mode: WorldMode = 'starting', stopped = false, readyOnce = false, hidden = false;
  let globe: GlobeHandle | null = null, globeCanvas: HTMLCanvasElement | null = null, globeGen = 0, rebuilds = 0;
  let snapshot: GlobeSnapshot | { lon: number; lat: number; zoom?: number; realmId?: string } = { lon: init.view.lon, lat: init.view.lat, zoom: init.view.zoom };
  let realm: RealmViewHandle | null = null, realmLoad: Promise<RealmViewHandle> | null = null;
  let realmCanvas: HTMLCanvasElement | null = null, realmUi: HTMLElement | null = null, realmGen = 0;
  let inRealm: string | null = null, diveRealm: string | null = null, dive: AbortController | null = null;
  let markers = init.markers, ownShield: OwnShieldRead | null = null, selected = init.selectedTileId, pendingSelect: number | null = null, reduced = init.reducedMotion;
  let layout: GlobeLayout = {}, island: WorldV2SpecialIslandId | null = null;
  let hostView: FantasyView = init.view, boundsKey = '', savedCam: { realmId: string; lon: number; lat: number; x: number; y: number; d: number } | null = null;
  let poll: ReturnType<typeof setInterval> | undefined, globeLost: ReturnType<typeof setTimeout> | undefined, realmLost: ReturnType<typeof setTimeout> | undefined;
  let rebuildWhenVisible = false, reenterWhenVisible = false;
  /** The host's last focus request while the globe is not built yet (it focuses drafts and owned land on open). */
  let queued: (() => void) | null = null;

  const setMode = (m: WorldMode): void => { if (mode === m) return; mode = m; on.mode(m); };
  function fail(reason: string): void {
    if (stopped || mode === 'failed') return;
    teardown(); setMode('failed'); on.fallback(reason);
  }

  // ------------------------------------------------------------------ globe
  function buildGlobe(initial: typeof snapshot): boolean {
    const canvas = E.newCanvas('globe'), gen = ++globeGen, live = (): boolean => gen === globeGen && !stopped;
    let g: GlobeHandle;
    try {
      g = E.createGlobe(canvas, { ...E.globeOptions, reducedMotion: reduced, initial, on: {
        ready: () => { if (!live()) return; if (!readyOnce) { readyOnce = true; on.ready(); } },
        unavailable: reason => { if (live()) fail(`globe: ${reason}`); },
        partUnavailable: (part, reason) => { if (live()) console.warn('[worldv2] globe part unavailable:', part, reason); },
        pick: p => { if (live()) picked(p); },
        select: (_realmId, islandId) => { if (live() && islandId === null && island) setIsland(null); },
        approach: realmId => { if (live()) prefetch(realmId); },
        dive: d => { if (live()) void enter(d); },
        noMap: placeId => { if (live() && isSpecial(placeId)) setIsland(placeId); },
        view: v => { if (live() && (mode === 'globe' || mode === 'approach')) { hostView = v; on.view(v); } },
        labels: a => { if (live() && (mode === 'globe' || mode === 'approach')) on.labels(a); },
        contextLost: () => { if (!live()) return; clearTimeout(globeLost); globeLost = setTimeout(() => { if (live()) rebuildGlobe('globe context lost'); }, CONTEXT_RESTORE_WAIT_MS); },
        contextRestored: () => { clearTimeout(globeLost); },
      } });
    } catch (e) { canvas.remove(); fail(`globe: ${message(e)}`); return false; }
    globe = g; globeCanvas = canvas; g.setLayout(layout);
    return true;
  }
  function disposeGlobe(): void {
    if (!globe) return;
    clearTimeout(globeLost);
    try { snapshot = globe.snapshot(); } catch { /* keep the last one */ }
    globeGen++; globe.dispose(); globeCanvas?.remove(); globe = null; globeCanvas = null;
  }
  /** An unrecoverable loss: rebuild on a fresh canvas from the snapshot (camera + selected realm). */
  function rebuildGlobe(reason: string): void {
    if (hidden) { rebuildWhenVisible = true; return; }
    if (++rebuilds > MAX_GLOBE_REBUILDS) { fail(reason); return; }
    disposeGlobe();
    if (mode === 'globe' || mode === 'approach') { setMode('globe'); buildGlobe(snapshot); }
    // inside a realm map the globe was asleep anyway: it is rebuilt when the player leaves
  }
  function picked(p: GlobePick): void {
    if (mode !== 'globe' && mode !== 'approach') return;
    switch (p.kind) {
      case 'realm': setIsland(null); on.realmSelect(p.id); return;
      case 'explore': setIsland(null); on.explore({ chainId: p.chainId, islandId: p.islandId }); return;
      case 'phase-e': if (isSpecial(p.id)) setIsland(p.id); return;
      default: setIsland(null); on.select(null);
    }
  }
  function setIsland(id: WorldV2SpecialIslandId | null): void {
    if (island === id) return;
    island = id; on.island(id);
  }
  /** Fly in and dive; retried while the globe is still loading or holds its post-leave block. */
  function diveTo(realmId: string, attempt = 0): void {
    if (stopped || mode === 'failed') return;
    if (mode !== 'globe') return;
    if (globe?.diveInto(realmId)) { diveRealm = realmId; setMode('approach'); return; }
    const wait = DIVE_RETRY_MS[attempt + 1];
    if (wait === undefined) return;
    const retry = (): void => { setTimeout(() => diveTo(realmId, attempt + 1), wait); };
    if (globe && globe.state !== 'ready' && globe.state !== 'failed') void globe.ready.then(() => diveTo(realmId, attempt + 1), () => {});
    else retry();
  }

  // ------------------------------------------------------------------ realm (chunk B)
  const realmHost: RealmViewHost = {
    onSelect: tileId => { if (!stopped && mode === 'realm') { selected = tileId; on.select(tileId); } },
    panelOpen: () => on.panelOpen(),
    chromeRects: () => on.chromeRects(),
    onExit: () => { void exitRealm(); },
  };
  function ensureRealm(): Promise<RealmViewHandle> {
    if (realm) return Promise.resolve(realm);
    if (realmLoad) return realmLoad;
    const canvas = E.newCanvas('realm'), ui = E.newRealmUi(), gen = ++realmGen;
    realmCanvas = canvas; realmUi = ui;
    canvas.addEventListener('webglcontextlost', () => {
      if (gen !== realmGen) return;
      clearTimeout(realmLost); realmLost = setTimeout(() => { if (gen === realmGen) realmContextGone(); }, CONTEXT_RESTORE_WAIT_MS);
    });
    canvas.addEventListener('webglcontextrestored', () => { if (gen === realmGen) clearTimeout(realmLost); });
    const load = E.createRealm({ canvas, ui, host: realmHost }).then(view => {
      if (stopped || gen !== realmGen) { view.dispose(); throw new DOMException('the world stopped', 'AbortError'); }
      realm = view; return view;
    }, (e: unknown) => {
      if (gen === realmGen) { realmLoad = null; canvas.remove(); ui.remove(); realmCanvas = null; realmUi = null; }
      throw e;
    });
    realmLoad = load;
    return load;
  }
  /** Throw the realm engine away. Its dispose runs BEFORE the context is lost on purpose: the engine then reads that loss
   *  as a deliberate teardown, never as a GPU reset that would put the player's later visits into safe mode.
   *  notices: whether its GPU notices come down too (the world is leaving), or stay (it is rebuilt at once). */
  function disposeRealm(notices = false): void {
    realmGen++; clearTimeout(realmLost);
    realm?.dispose({ notices }); loseContext(realmCanvas); realmCanvas?.remove(); realmUi?.remove();
    realm = null; realmLoad = null; realmCanvas = null; realmUi = null;
  }
  /** Every return to 'globe' goes through here: a globe exists (rebuilt from the snapshot if it was disposed) and is
   *  awake. A sleeping globe ignores taps, focus and dives, so the player would be stuck on a frozen frame. */
  function globeUp(): boolean {
    if (!globe && !buildGlobe(snapshot)) return false;
    if (globe?.asleep) void globe.wake().catch(() => {});
    return true;
  }
  function prefetch(realmId: string): void {
    ensureRealm().then(view => view.prefetch(realmId), (e: unknown) => { if (!isAbort(e)) console.warn('[worldv2] realm prefetch failed:', message(e)); });
  }
  function readCam(): typeof savedCam {
    const view = realm, id = inRealm; if (!view || !id) return null;
    try {
      const cam = view.engine.cam, b = view.bounds(); if (!b) return null;
      const box = E.realmBounds(b);
      return { realmId: id, lon: wrapLon((box.west + box.east) / 2), lat: (box.south + box.north) / 2, x: cam.x, y: cam.y, d: cam.d };
    } catch { return null; }
  }
  /** Land in a realm: from the globe's dive event, or re-entering after a lost realm context (restore). */
  async function enter(d: GlobeDive, restoreCam: typeof savedCam = null): Promise<void> {
    if (stopped || !(mode === 'globe' || mode === 'approach' || mode === 'diving')) return;
    setMode('diving'); setIsland(null); on.notice(null); diveRealm = d.realmId;
    dive?.abort(); const ctl = new AbortController(); dive = ctl;
    try {
      const view = await ensureRealm();
      if (ctl.signal.aborted) throw new DOMException('the dive was cancelled', 'AbortError');
      view.setMarkers(d.realmId, markers, ownShield);
      await view.enter(d.realmId, d.lon, d.lat, d.sStart, ctl.signal);
    } catch (e) {
      if (dive === ctl) dive = null;
      if (stopped || isAbort(e)) return; // cancelled (Back): silent, the globe already reopened the realm
      console.warn('[worldv2] realm dive failed:', message(e));
      if (!globeUp()) return;
      globe?.diveResult(false, d.realmId); diveRealm = null; setMode('globe');
      on.notice(WORLD_COPY.diveFailed); // native 0df4d71, above the reopened realm
      return;
    }
    if (dive !== ctl || stopped) return;
    dive = null; inRealm = d.realmId; diveRealm = null;
    const view = realm!;
    globe?.diveReady(); globe?.diveResult(true, d.realmId); // the clouds part, then the globe sleeps: one engine awake
    setMode('realm'); on.landed(d.realmId);
    if (restoreCam && restoreCam.realmId === d.realmId) { try { view.engine.flyToD(restoreCam.x, restoreCam.y, restoreCam.d, 0); } catch { /* the fit stays */ } }
    const target = pendingSelect ?? selected; pendingSelect = null;
    if (target !== null && E.tileRealm(target)?.realmId === d.realmId) { selected = target; view.select(target, restoreCam === null); }
    boundsKey = ''; tick();
    clearInterval(poll); poll = setInterval(tick, REALM_POLL_MS);
  }
  /** While a realm map is up: report its camera on the host scale, keep a restore point, keep the budget. */
  function tick(): void {
    if (mode !== 'realm' || !realm) return;
    const cam = readCam(); if (cam) savedCam = cam;
    const b = realm.bounds();
    if (b) {
      const key = `${b.realmId}:${b.x0.toFixed(2)}:${b.y0.toFixed(2)}:${b.x1.toFixed(2)}:${b.y1.toFixed(2)}`;
      if (key !== boundsKey) {
        boundsKey = key;
        const box = E.realmBounds(b), c = realm.engine.cam;
        let k = 1; try { const s0 = c.sMin(); if (s0 > 0) k = Math.max(1, c.s / s0); } catch { /* fit */ }
        hostView = { lon: wrapLon((box.west + box.east) / 2), lat: (box.south + box.north) / 2, zoom: REALM_HOST_ZOOM * k };
        on.bounds(box); on.view(hostView);
      }
    }
    if (globe && gpuBytes() > WORLD_V2_GPU_BUDGET_BYTES) disposeGlobe(); // R5: the sleeping globe goes first
  }
  function realmContextGone(): void {
    if (hidden) { reenterWhenVisible = true; return; }
    const cam = savedCam, wasRealm = mode === 'realm' ? inRealm : null, wasDiving = mode === 'diving' ? diveRealm : null;
    dive?.abort(); dive = null; clearInterval(poll);
    disposeRealm(); inRealm = null;
    if (wasRealm && cam && cam.realmId === wasRealm) { setMode('diving'); void enter({ realmId: wasRealm, lon: cam.lon, lat: cam.lat, sStart: 18 }, cam); return; }
    if (wasDiving) { // lost under the cover: the dive failed, and says so
      if (!globeUp()) return;
      globe?.diveResult(false, wasDiving); diveRealm = null; setMode('globe'); on.notice(WORLD_COPY.diveFailed); return;
    }
    if (wasRealm) void backToGlobe(null);
  }
  async function backToGlobe(from: { realmId: string | null; lon: number; lat: number } | null): Promise<void> {
    setMode('leaving'); clearInterval(poll);
    if (!globe && !buildGlobe(snapshot)) return;
    try { if (from) await globe!.leave(from); else await globe!.wake(); } catch { /* disposed under us */ }
    if (stopped || mode !== 'leaving') return;
    realm?.leave(); inRealm = null; boundsKey = '';
    setMode('globe'); on.bounds(null);
    hostView = globe?.view() ?? hostView; on.view(hostView);
    if (realm && gpuBytes() > WORLD_V2_GPU_BUDGET_BYTES) disposeRealm(); // the globe is back: an oversized idle realm goes
  }
  async function exitRealm(): Promise<void> {
    if (mode !== 'realm') return;
    const cam = readCam();
    await backToGlobe({ realmId: inRealm, lon: cam?.lon ?? hostView.lon, lat: cam?.lat ?? hostView.lat });
  }
  function cancelDive(): boolean {
    if (mode === 'approach') { globe?.cancelDive(); diveRealm = null; setMode('globe'); return true; }
    if (mode !== 'diving') return false;
    const id = diveRealm; dive?.abort(); dive = null; diveRealm = null;
    if (!globeUp()) return true; // (a globe that cannot be rebuilt has fallen back)
    if (id) globe?.diveResult(false, id);
    setMode('globe');
    return true;
  }
  /** Leave the realm map (if in one), then act on the globe. */
  function onGlobe(act: () => void): void {
    if (mode === 'starting') { queued = act; return; }
    if (mode === 'realm') { void exitRealm().then(() => { if (mode === 'globe') act(); }); return; }
    if (mode === 'approach' || mode === 'diving') cancelDive();
    act();
  }

  function teardown(): void {
    clearInterval(poll); clearTimeout(globeLost); clearTimeout(realmLost);
    dive?.abort(); dive = null;
    disposeGlobe(); disposeRealm(true);
  }
  function gpuBytes(): number {
    let bytes = 0;
    try { bytes += globe?.gpuBytes() ?? 0; } catch { /* lost */ }
    try { const s = realm?.stats() as { gpuMB?: { realm?: unknown } } | undefined, mb = s?.gpuMB?.realm; if (typeof mb === 'number') bytes += mb * MB; } catch { /* lost */ }
    return bytes;
  }

  return {
    get mode() { return mode; },
    get island() { return island; },
    get realmId() { return inRealm; },
    async start() {
      const cap = await E.capability();
      if (stopped) return;
      if (cap === false) { fail('capability-off: worldV2.enabled is false'); return; }
      if (!buildGlobe(snapshot)) return;
      setMode('globe');
      const act = queued; queued = null; act?.();
    },
    stop() { if (stopped) return; teardown(); stopped = true; setMode('stopped'); },
    back() {
      if (island) { setIsland(null); globe?.deselect({ quiet: true }); return true; }
      if (mode === 'approach' || mode === 'diving') return cancelDive();
      if (mode === 'realm') { void exitRealm(); return true; }
      return false;
    },
    backWanted() {
      return !!island || mode === 'approach' || mode === 'diving' || (mode === 'realm' && selected === null);
    },
    focusRealm(realmId) { setIsland(null); onGlobe(() => { globe?.focusRealm(realmId); }); },
    focusTile(tileId) {
      const t = E.tileRealm(tileId); if (!t) return;
      if (mode === 'realm' && inRealm === t.realmId && realm) { selected = tileId; realm.select(tileId, true); return; }
      pendingSelect = tileId;
      onGlobe(() => diveTo(t.realmId));
    },
    focusIsland(chainId, islandId) { setIsland(null); onGlobe(() => { globe?.focusIsland(chainId, islandId ?? null); }); },
    setView(view) {
      if (view.zoom >= REALM_HOST_ZOOM) {
        const realmId = E.realmAt(view.lon, view.lat) ?? snapshotRealm(); if (!realmId) return;
        if (mode === 'realm' && inRealm === realmId) return;
        onGlobe(() => diveTo(realmId));
        return;
      }
      onGlobe(() => { globe?.setView(view); });
    },
    view: () => (mode === 'globe' || mode === 'approach' ? globe?.view() ?? hostView : hostView),
    exitRealm,
    openIsland(id) { onGlobe(() => { globe?.selectIsland(id); setIsland(id); }); },
    closeIsland() { if (!island) return; setIsland(null); globe?.deselect({ quiet: true }); },
    selectInRealm(tileId) { if (mode === 'realm' && realm) { selected = tileId; realm.select(tileId, true); } },
    setMarkers(next, own = null) {
      markers = next; ownShield = own;
      const id = inRealm ?? diveRealm; if (realm && id) realm.setMarkers(id, next, own);
    },
    setSelected(tileId) {
      if (selected === tileId) return;
      selected = tileId;
      if (mode !== 'realm' || !realm) return;
      if (tileId === null) realm.select(null);
      else if (E.tileRealm(tileId)?.realmId === inRealm) realm.select(tileId);
    },
    setLayout(next) { layout = next; globe?.setLayout(next); try { realm?.chromeChanged(); } catch { /* not entered */ } },
    setReducedMotion(next) { reduced = next; globe?.setReducedMotion(next); },
    setFilter(filter) { try { realm?.engine.setFilter(filter); } catch { /* not entered */ } },
    visibility(isHidden) {
      hidden = isHidden;
      if (isHidden) {
        if (mode === 'globe') globe?.sleep();
        // a hidden realm map lifts its crash marker: Android may discard the tab without a pagehide (not a crash)
        if (mode === 'realm') { const cam = readCam(); if (cam) savedCam = cam; try { realm?.suspend(); } catch { /* lost */ } }
        return;
      }
      try { realm?.resume(); } catch { /* lost: a resume without a suspend is a no-op */ }
      if (rebuildWhenVisible) { rebuildWhenVisible = false; rebuildGlobe('globe context lost'); }
      if (reenterWhenVisible) { reenterWhenVisible = false; realmContextGone(); }
      if (mode === 'globe') { if (globe) void globe.wake().catch(() => {}); else buildGlobe(snapshot); }
    },
    gpuBytes,
    engines() {
      return { globe: !globe ? 'none' : globe.asleep ? 'asleep' : 'awake',
        realm: !realm ? 'none' : inRealm && (mode === 'realm' || mode === 'leaving') ? 'active' : 'idle' };
    },
  };
  function snapshotRealm(): string | null {
    const s = snapshot as { realmId?: string | null }; return globe?.selection.realmId ?? s.realmId ?? null;
  }
}
