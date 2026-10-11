// The web's bridge to the realm engine (chunk B). It replaces the concept's realmmap.js rm2 adapter (lines 140-184 at
// 8acdf059): the engine arrives through a normal lazy import (retried, like rm2's), and it is fed the host's LIVE data
// instead of the concept's demo feed:
//   * kingdoms = the host's `markers` (the /globe/fantasy/parcels viewport feed plus owned and inspected tiles), mapped
//     by tile id into the realm's deed grid; shields by the D-181 rule (domes.mjs); blank names by one rule;
//   * every tap goes to the host (onSelect): the host panel stays the only surface for scout, raid and choose land;
//   * pictures through the capped avatar queue (../avatars.ts);
//   * a dive that stalls for REALM_DIVE_STALL_MS fails loudly (the host shows REALM_DIVE_FAILED); a cancelled one is
//     silent (AbortError).
// No game number lives here: the grid and level cap come from @shardkeep/shared.
import { FANTASY_WORLD, STRUCTURES } from '@shardkeep/shared';
import { getFantasyTile } from '@shardkeep/shared/fantasyWorld';
import type { FantasyWorldMarker } from '../../types';
import { createAvatarQueue, defaultPortrait, type AvatarQueue } from '../avatars';
import { domeState } from './domes.mjs';
import type { RealmBase, RealmGrid, RealmHost, RealmMap, RealmPick, RealmMapStats } from './map.mjs';

/** Native 0df4d71: the dive watchdog fires only after readiness has made no progress for this long. */
export const REALM_DIVE_STALL_MS = 12_000;
/** Native 0df4d71's notice, shown by the host above the reopened realm panel. */
export const REALM_DIVE_FAILED = 'This realm map could not load — tap Enter map to retry';
const IMPORT_RETRY_MS = [0, 1_500, 4_000];

/** Native e26fa94: one naming rule for every tag and card. */
export function kingdomName(name: string | null | undefined, mine: boolean): string {
  const n = (name ?? '').trim();
  return n || (mine ? 'Your kingdom' : 'Keeper');
}

/** The deed cell of a fantasy tile inside a realm grid (0.5° cells; tile id = row × columns + column). */
export function tileToCell(tileId: number, grid: RealmGrid): { x: number; y: number } | null {
  if (!Number.isSafeInteger(tileId) || tileId < 0) return null;
  const x = (tileId % FANTASY_WORLD.columns) - grid.x0, y = Math.floor(tileId / FANTASY_WORLD.columns) - grid.y0;
  return x >= 0 && y >= 0 && x < grid.cols && y < grid.rows ? { x, y } : null;
}
export function cellToTile(x: number, y: number, grid: RealmGrid): number {
  return (y + grid.y0) * FANTASY_WORLD.columns + (x + grid.x0);
}

export interface RealmAvatar { url: string | null; name: string; mine: boolean }
export interface OwnShieldRead { tileId: number; shielded: boolean }
export interface WorldMarker extends FantasyWorldMarker { shielded?: boolean }

/**
 * The host's markers → the engine's kingdoms for one realm. Realm clusters (the globe's per-realm counts), tiles of
 * other realms and tiles outside the grid are left out; a tile listed twice (feed + owned + inspected) is one kingdom.
 */
export function markersToBases(realmId: string, grid: RealmGrid, markers: readonly WorldMarker[], own: OwnShieldRead | null = null): RealmBase[] {
  const maxLevel = STRUCTURES.keep.maxLevel, byTile = new Map<number, WorldMarker>();
  for (const m of markers) {
    if (m.cluster || !Number.isSafeInteger(m.tileId)) continue;
    const prev = byTile.get(m.tileId);
    if (!prev) { byTile.set(m.tileId, { ...m }); continue; }
    if (m.owned) prev.owned = true;
    if (!prev.name?.trim() && m.name?.trim()) prev.name = m.name;
    if (prev.keepLevel == null && m.keepLevel != null) prev.keepLevel = m.keepLevel;
    if (!prev.avatarUrl && m.avatarUrl) prev.avatarUrl = m.avatarUrl;
    if (m.shielded === true || prev.shielded === undefined) { if (m.shielded !== undefined) prev.shielded = m.shielded; }
  }
  const out: RealmBase[] = [];
  for (const m of byTile.values()) {
    if (getFantasyTile(m.tileId)?.realmId !== realmId) continue;
    const cell = tileToCell(m.tileId, grid); if (!cell) continue;
    const mine = m.owned === true, lv = m.keepLevel;
    const level = typeof lv === 'number' && Number.isInteger(lv) ? Math.min(maxLevel, Math.max(1, lv)) : 1;
    const name = kingdomName(m.name, mine);
    const avatar: RealmAvatar = { url: m.avatarUrl ?? null, name, mine };
    out.push({ id: m.tileId, x: cell.x, y: cell.y, level, name, avatar, mine, clan: null,
      shield: domeState(m.shielded, own && own.tileId === m.tileId ? own.shielded : undefined, mine),
      attackable: false }); // the server decides attacks: the host card's "You can attack" reads its actions, never this
  }
  return out.sort((a, b) => a.id - b.id);
}
const basesKey = (list: readonly RealmBase[]) => list.map(b => `${b.id}:${b.level}:${b.name}:${String(b.shield)}:${b.mine ? 1 : 0}:${(b.avatar as RealmAvatar).url ?? ''}`).join('|');

export class RealmDiveError extends Error {
  readonly notice = REALM_DIVE_FAILED;
  constructor(readonly reason: string) { super(`realm dive failed: ${reason}`); this.name = 'RealmDiveError'; }
}

export interface RealmViewHost {
  /** Every tap: the tile id (a kingdom's or an open deed's), or null when the selection clears. */
  onSelect(tileId: number | null): void;
  panelOpen?(): boolean;
  focusOffset?(): [number, number];
  chromeRects?(): [number, number, number, number][];
  /** The player left the realm map (pinch-out below 0.7 × the fit, zoom-out at the fit): back to the globe. */
  onExit?(at: { lon: number; lat: number }): void;
}
export interface RealmViewOptions {
  canvas: HTMLCanvasElement;
  /** The label layer's root, over the canvas. */
  ui: HTMLElement;
  /** Where the world pack is served, ending in '/': /atlas/world-v2/<packVersion>/ (lane L2's packUrl). */
  packRoot: string;
  host: RealmViewHost;
  /** The HUD sheet module (lane L5), or null. */
  hud?: unknown;
  /** Test seams. */
  importEngine?: () => Promise<typeof import('./map.mjs')>;
  now?: () => number;
}
export interface RealmViewBounds { realmId: string; x0: number; y0: number; x1: number; y1: number }
export interface RealmViewHandle {
  readonly engine: RealmMap;
  has(realmId: string): boolean;
  prefetch(realmId: string): void;
  enter(realmId: string, lon: number, lat: number, sStart?: number, signal?: AbortSignal): Promise<void>;
  setMarkers(realmId: string, markers: readonly WorldMarker[], own?: OwnShieldRead | null): void;
  select(tileId: number | null, fly?: boolean): void;
  bounds(): RealmViewBounds | null;
  chromeChanged(): void;
  leave(): void;
  /** The page was hidden / shown while a realm map is up (map.mjs P13: a discarded tab is not a crash). */
  suspend(): void;
  resume(): void;
  /** Throw the engine away (map.mjs P11). notices: false keeps a GPU notice up (the host rebuilds the map at once). */
  dispose(o?: { notices?: boolean }): void;
  stats(): RealmMapStats;
}

async function importWithRetry(load: () => Promise<typeof import('./map.mjs')>): Promise<typeof import('./map.mjs')> {
  let err: unknown;
  for (const wait of IMPORT_RETRY_MS) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    try { return await load(); } catch (e) { err = e; console.warn('realm engine import failed', e); }
  }
  throw err;
}

export async function createRealmView(o: RealmViewOptions): Promise<RealmViewHandle> {
  const mod = await importWithRetry(o.importEngine ?? (() => import('./map.mjs')));
  const now = o.now ?? (() => performance.now());
  let map: RealmMap | null = null;
  const avatars: AvatarQueue = createAvatarQueue({ onChange: () => map?.core.invalidate() });
  const avatarURL = (a: unknown) => {
    const r = a as RealmAvatar | null;
    return (r && avatars.url(r.url)) ?? defaultPortrait(r?.name ?? '', !!r?.mine);
  };
  let told: number | null | undefined; // the last tile the host was told about (the host echoes it back as selectedTileId)
  const tileOf = (b: RealmPick | null) => {
    const R = map?.realm; if (!b || !R) return null;
    return 'free' in b ? cellToTile(b.x, b.y, R.meta.grid) : b.id;
  };
  const host: RealmHost = {
    card: b => { const t = tileOf(b); if (t === told) return; told = t; o.host.onSelect(t); },
    cardOpen: () => o.host.panelOpen?.() ?? told != null,
    focusOffset: () => o.host.focusOffset?.() ?? [0, 0],
    chromeRects: () => o.host.chromeRects?.() ?? [],
  };
  map = mod.createRealmMap({ canvas: o.canvas, ui: o.ui, pack: o.packRoot, avatarURL, onExit: at => o.host.onExit?.(at),
    options: { hud: o.hud ?? null, host, markers: true, chart16: false } });
  const engine = map;
  // the host's latest markers per realm; applied once the realm is resident (its grid is in its realm.json, not the index)
  const pending = new Map<string, { markers: readonly WorldMarker[]; own: OwnShieldRead | null }>(), lastKey = new Map<string, string>();
  function apply(realmId: string) {
    const R = engine.realm, p = pending.get(realmId); if (!p || R?.id !== realmId) return;
    const list = markersToBases(realmId, R.meta.grid, p.markers, p.own), key = basesKey(list);
    if (lastKey.get(realmId) === key) return; // an unchanged feed poll never rebuilds the kingdoms' caches
    lastKey.set(realmId, key); engine.setBases(realmId, list);
  }

  const progress = (s: RealmMapStats) => `${s.bytesLoaded}|${Object.keys(s.enterTiming ?? {}).length}|${s.firstFrameMs > 0 ? 1 : 0}|${s.dive?.state}`;
  function enter(realmId: string, lon: number, lat: number, sStart = 18, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false, entered = false, last = '', lastAt = now();
      const finish = (e: Error | null) => {
        if (done) return; done = true; clearInterval(tick); signal?.removeEventListener('abort', onAbort);
        if (e) { engine.leave(); reject(e); } else resolve();
      };
      const onAbort = () => finish(new DOMException('the dive was cancelled', 'AbortError'));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort);
      const tick = setInterval(() => {
        let s: RealmMapStats; try { s = engine.stats(); } catch { return; }
        if (entered && s.firstFrameMs > 0) { finish(null); return; } // landed and the first ground frame is drawn
        const k = progress(s); if (k !== last) { last = k; lastAt = now(); return; }
        if (now() - lastAt >= REALM_DIVE_STALL_MS) finish(new RealmDiveError(`no progress for ${REALM_DIVE_STALL_MS / 1000} s (${k})`));
      }, 250);
      lastKey.delete(realmId); // a (re-)entered realm takes its kingdoms again
      engine.enter(realmId, lon, lat, sStart).then(() => { entered = true; apply(realmId); }, e => finish(new RealmDiveError(String((e as Error)?.message ?? e))));
    });
  }

  return {
    engine,
    has: id => engine.has(id),
    prefetch: id => engine.prefetch(id),
    enter,
    setMarkers(realmId, markers, own = null) { pending.set(realmId, { markers, own }); apply(realmId); },
    select(tileId, fly = false) {
      const R = engine.realm; told = tileId;
      if (tileId == null || !R) { if (engine.selected) engine.select(null); return; }
      const cur = tileOf(engine.selected); if (cur === tileId) return;
      const hit = R.bases.find(b => b.id === tileId);
      if (hit) { engine.select(hit, fly); return; }
      const cell = tileToCell(tileId, R.meta.grid);
      if (cell && getFantasyTile(tileId)?.realmId === R.id) engine.select({ free: true, x: cell.x, y: cell.y }, fly);
    },
    bounds() {
      const R = engine.realm, v = engine.lastView; if (!R || !v || !engine.active) return null;
      return { realmId: R.id, x0: R.x0 + v.rect.x0, y0: R.y0 + v.rect.y0, x1: R.x0 + v.rect.x1, y1: R.y0 + v.rect.y1 };
    },
    chromeChanged: () => engine.chromeChanged(),
    leave: () => engine.leave(),
    suspend: () => engine.suspend(),
    resume: () => engine.resume(),
    dispose(o) { engine.dispose(o); avatars.clear(); pending.clear(); lastKey.clear(); map = null; },
    stats: () => engine.stats(),
  };
}
