// Types for the realm engine's entry (map.mjs, the concept's realm/map.js at 8acdf059 plus patches.md). Only the surface
// adapter.ts uses is typed; the engine itself stays JavaScript, verbatim.

/** A kingdom as the engine draws it (deed cell x, y inside the realm grid). */
export interface RealmBase {
  id: number; x: number; y: number; level: number; name: string;
  avatar: unknown; shield: boolean | undefined; mine: boolean; attackable: boolean;
  clan: string | null; trophies?: number;
}
/** An open deed the player tapped (no kingdom on it). */
export interface RealmFreeDeed { free: true; x: number; y: number }
export type RealmPick = RealmBase | RealmFreeDeed;

export interface RealmGrid { cols: number; rows: number; x0: number; y0: number; deeds?: number }
export interface RealmResident {
  id: string; name: string; cols: number; rows: number; x0: number; y0: number;
  meta: { grid: RealmGrid; status?: string };
  bases: RealmBase[];
}
export interface RealmIndexEntry { id: string; status?: string; packVersion?: string }
export interface RealmView {
  x: number; y: number; s: number; d: number; dpr: number; W: number; H: number; band: string;
  rect: { x0: number; y0: number; x1: number; y1: number; fx0: number; fy0: number; fx1: number; fy1: number };
}
export interface RealmHost {
  card(b: RealmPick | null): void;
  cardOpen?(): boolean;
  focusOffset?(): [number, number];
  chromeRects?(): [number, number, number, number][];
}
export interface RealmMapOptions {
  hud?: unknown;
  host?: RealmHost | null;
  markers?: boolean;
  chart16?: boolean;
  [flag: string]: unknown;
}
export interface RealmMapStats {
  firstFrameMs: number; bytesLoaded: number; enterTiming: Record<string, number>; mapReadyMs: number;
  band: string; d: number; s: number; realm: string | null;
  dive: { state: 'leaving' | 'landed' | 'free'; landMs: number; d: number; fitD: number };
  modules: Record<string, string>;
  [k: string]: unknown;
}
export interface RealmCamera {
  x: number; y: number; s: number; d: number; dpr: number;
  sMin(): number; sFit(): number;
  deedToScreen(x: number, y: number): [number, number];
  screenToDeed(sx: number, sy: number): [number, number];
}
export interface RealmMap {
  readonly active: boolean;
  readonly cam: RealmCamera;
  readonly realm: RealmResident | null;
  readonly selected: RealmPick | null;
  readonly lastView: RealmView | null;
  readonly core: { invalidate(): void; input(): void };
  readonly ready: Promise<unknown>;
  has(id: string): boolean;
  realms(): RealmIndexEntry[];
  prefetch(id: string): void;
  enter(id: string, lon: number, lat: number, sStart?: number): Promise<void>;
  loaded(): Promise<unknown>;
  leave(): void;
  /** web port P13: the page was hidden / shown mid-visit (the crash marker is lifted while hidden). */
  suspend(): void;
  resume(): void;
  /** web port P11: throw the engine away: every listener, module, texture and pack released (notices: drop GPU notices). */
  dispose(o?: { notices?: boolean }): void;
  exit(o?: { at?: boolean }): void;
  select(b: RealmPick | null, fly?: boolean): void;
  step(dir: 1 | -1): void;
  myBase(): void;
  zoomBy(k: number): void;
  flyToD(x: number, y: number, d: number, ms?: number): void;
  setFilter(f: { kind?: RealmFilterKind; lvl?: [number, number] }): void;
  setBases(realmId: string, list: RealmBase[]): void;
  chromeChanged(): void;
  drawsBase(b: RealmBase, view: RealmView): boolean;
  stats(): RealmMapStats;
}
export function createRealmMap(o: {
  canvas: HTMLCanvasElement; ui: HTMLElement; pack: string;
  avatarURL?: (avatar: unknown) => string; onExit?: (at: { lon: number; lat: number }) => void; options?: RealmMapOptions;
}): RealmMap;
export const plotAt: (b: RealmPick) => { x: number; y: number };
/** The realm map's filter chips: the host HUD offers all / mine / unshielded; clan and attack are the engine's own chrome. */
export type RealmFilterKind = 'all' | 'mine' | 'clan' | 'attack' | 'unshielded';
export interface RealmFilterState { kind: RealmFilterKind; lvl: [number, number] }
/** D-191: level range first, then the chip ('unshielded' = shield bit explicitly false); a failing kingdom is hidden. */
export function filterPasses(f: RealmFilterState, b: RealmBase, myClan?: string | null): boolean;
