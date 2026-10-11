// Types of the Web World v2 flat globe (lazy chunk A). The React root (worldv2/WorldV2.tsx, lane L6) maps these events
// onto the frozen host contract (worldv2/contract.ts): taps → onSelect / onRealmSelect / onExplore / onSpecialIsland,
// ready → onTerrainStatus, view → onViewChange (host zoom < 5 on the globe), dive → the realm engine (chunk B).

/** Screen rect in CSS px. */
export interface GlobeRect { x0: number; y0: number; x1: number; y1: number }
/** The host view scale (FantasyView): the home frame is zoom 1; the globe always reports < 5. */
export interface GlobeHostView { lon: number; lat: number; zoom: number }
export interface GlobeLayout {
  /** The header's bottom edge (the home frame keeps the globe below it). */
  top?: number;
  /** Chrome the home frame keeps the globe clear of (tools, hint). */
  obstacles?: readonly GlobeRect[];
  /** What the realm panel or sheet leaves free while a selection is shown; null = the whole screen. */
  panelFree?: GlobeRect | null;
}
/** Decoded RGBA8 pixels (the host's sha-verified loadFantasyPixels). */
export interface GlobePixels { width: number; height: number; data: Uint8ClampedArray | Uint8Array }
/** The host's exploration chain model (runtime/world.mjs ARCHIPELAGOS / FANTASY_CHAINS). */
export interface GlobeChain { id: string; islands: ReadonlyArray<{ lon: number; lat: number; rx: number; ry: number }> }

export type GlobePick =
  | { kind: 'space' }
  | { kind: 'sea'; lon: number; lat: number }
  | { kind: 'realm'; index: number; id: string; deedEligible: boolean; lon: number; lat: number }
  /** islandId is the host's `${chainId}-${slot + 1}`, or null when only the chain was hit (far out, or art not live). */
  | { kind: 'explore'; chainId: string; islandId: string | null; lon: number; lat: number }
  | { kind: 'phase-e'; id: string; lon: number; lat: number };

export interface GlobeLabelAnchor { kind: 'realm' | 'island'; id: string; name: string; x: number; y: number }
export interface GlobeDive { realmId: string; lon: number; lat: number; /** CSS px per deed the realm map opens at. */ sStart: number }
export interface GlobeSnapshot { t: number[]; z: number; realmId: string | null; islandId: string | null }

export interface GlobeEvents {
  /** First frame drawn (the host lifts its veil). */
  ready?(): void;
  /** The globe cannot run (shader, content or GPU refusal): the host falls back to the CPU globe. */
  unavailable?(reason: string): void;
  /** A late part could not load ('albedo-1024', 'islands', 'island effects', 'phase-e islands', 'dive cover'); the
   *  globe keeps running without it. For the host's client log. */
  partUnavailable?(part: string, reason: string): void;
  progress?(fraction: number): void;
  /** Every tap (a Phase E tap also selects it; a realm tap also selects the realm; anything else deselects). */
  pick?(pick: GlobePick): void;
  /** The selection changed: a realm id, a Phase E island id, or neither. */
  select?(realmId: string | null, islandId: string | null): void;
  /** Dive into this realm's map now; answer with diveReady() / diveResult(). */
  dive?(dive: GlobeDive): void;
  /** D-NEXT/D-177 prefetch hook: a dive into this realm is coming (Enter map, a rest low over it, or a pinch aiming in). */
  approach?(realmId: string): void;
  /** Pushed past the zoom floor where no map opens: the realm id, a Phase E island id, or null over the sea. */
  noMap?(placeId: string | null): void;
  /** The camera settled (host scale). */
  view?(view: GlobeHostView): void;
  /** Realm (and live Phase E island) name anchors in CSS px, whenever the camera moved; empty below the label altitude. */
  labels?(anchors: GlobeLabelAnchor[]): void;
  interact?(): void;
  phaseEIslands?(ids: string[]): void;
  contextLost?(): void;
  contextRestored?(): void;
}

export interface GlobeOptions {
  /** The host's exploration chains (7 chains, 32 islands) in its own order and ids. */
  chains: readonly GlobeChain[];
  /** URL of a world-pack file (`globe-v2/…`, `baked/…`, `<island>.webp`), e.g. /atlas/world-v2/<packVersion>/<path>. */
  fileUrl(path: string): string;
  /** The sha256 a manifest pins for a pack file; when given, a mismatch refuses the file. */
  expectedSha256?(path: string): string | undefined;
  /** The host's verified island art reader (`generated/<chain>-detail.png`, `…-detail-mask.png`). */
  readIslandArt?(path: string, signal?: AbortSignal): Promise<GlobePixels>;
  /** The islands' effect anchors (default: runtime/island-effects.mjs effectAnchors, loaded lazily). */
  loadIslandEffects?(): Promise<unknown[]>;
  /** D-172/D-182: draw, pick and frame Seeker, Solana and Divine (RG-3: off unless asked). */
  phaseEIslands?: boolean;
  /** The Phase E art layer size (default 1024, native PhaseEIslandLayer.LAYER); tests use a small one. */
  phaseELayer?: number;
  /** Realm ids whose map can open (default: all eight). */
  divable?: readonly string[];
  reducedMotion?: boolean;
  night?: boolean;
  clouds?: boolean;
  /** Start here: a snapshot() from before a dispose, or a host view. */
  initial?: GlobeSnapshot | { lon: number; lat: number; zoom?: number; realmId?: string };
  on?: GlobeEvents;
  /** Test clock. */
  now?(): number;
}

export interface GlobeHandle {
  readonly ready: Promise<void>;
  readonly state: 'loading' | 'linking' | 'ready' | 'failed';
  readonly failure: string | null;
  readonly asleep: boolean;
  readonly selection: { realmId: string | null; islandId: string | null };
  resize(): void;
  setLayout(layout: GlobeLayout): void;
  setDivable(realmIds: readonly string[]): void;
  setReducedMotion(reduced: boolean): void;
  setNight(night: boolean): void;
  setClouds(on: boolean): void;
  selectRealm(realmId: string, options?: { fly?: boolean; dur?: number; quiet?: boolean }): boolean;
  selectIsland(islandId: string): boolean;
  deselect(options?: { quiet?: boolean }): void;
  focusRealm(realmId: string): boolean;
  focusIsland(chainId: string, islandId?: string | null): boolean;
  focusPoint(lon: number, lat: number, alt?: number): void;
  zoomBy(dz: number): void;
  home(): void;
  view(): GlobeHostView;
  /** Host zooms ≥ 5 are realm-map views: route those to the realm engine; the globe clamps to its own closest view. */
  setView(view: GlobeHostView, options?: { instant?: boolean }): void;
  /** Enter map: fly to the realm (or target), then emit dive. False when the realm cannot be entered now. */
  diveInto(realmId: string, options?: { target?: number[] }): boolean;
  /** Back during the approach flight: withdraw the dive (the realm stays selected). The realm id, or null. */
  cancelDive(): string | null;
  diveReady(): void;
  diveResult(ok: boolean, realmId: string): void;
  /** The realm map closed: wake framed on it. Resolves once a globe frame is drawn. */
  leave(from: { realmId: string | null; lon: number; lat: number }): Promise<void>;
  sleep(): void;
  wake(): Promise<void>;
  snapshot(): GlobeSnapshot;
  restore(snapshot: GlobeSnapshot | { lon: number; lat: number; zoom?: number; realmId?: string }): void;
  labels(): GlobeLabelAnchor[];
  /** Estimated resident texture bytes. */
  gpuBytes(): number;
  stats(): { state: string; frames: number; albedo: number; islands: boolean; phaseE: boolean; gpuBytes: number; view: GlobeHostView; alt: number };
  dispose(): void;
}

export const HOST_ZOOM_MAX_GLOBE: number;
export function createGlobe(canvas: HTMLCanvasElement, options: GlobeOptions): GlobeHandle;
