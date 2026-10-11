/**
 * Valley roster cache (docs/MAP-SCALE-PLAN.md S2).
 *
 * GET /map used to be an N+1: one shields SELECT plus one getOrCreatePlayerAccount
 * (an INSERT … ON CONFLICT + SELECT — a WRITE on a read path) per marker, ~1,476
 * round trips for a full valley. The fix is two-part: set-based loading (world.ts)
 * and this cache, because the expensive half of a map open is VIEWER-AGNOSTIC —
 * every player looking at the same valley sees the same keeps, shields, clan tags
 * and scorch marks. Only the thin overlay (isMe / inWindow / revenge / ranking) is
 * per-viewer, so one roster load serves every viewer for WORLD.mapCacheSec.
 *
 * TYPE-ENFORCED PRIVACY: `ValleySnapshot` is the SHARED struct. Anything derived
 * from the viewer (`ViewerOverlay` in world.ts) must never be stored here — if it
 * were, one player would be served another player's revenge list. Keeping the
 * viewer fields off these types makes that a compile error rather than a review
 * catch.
 *
 * Deliberately IN-PROCESS, not Redis: Redis is workers-only today (jobs.ts, gated
 * on ENABLE_WORKERS) and there is no request-path Redis client, so adding one here
 * would mean the map 500s whenever Redis blinks. `ioredis` is already a dependency,
 * and the `getValleySnapshot(valleyId, warzoneActive, loader)` interface is shaped
 * so the swap (MAP-SCALE-PLAN L2, triggered by >1 API instance) is a one-file change.
 */
import { WORLD } from '@shardkeep/shared';

/** One player keep, as every viewer of the valley sees it. PUBLIC — no viewer state. */
export interface RosterRow {
  x: number;
  y: number;
  /** `plots.earth_cell` — the parcel's frozen deed address. It is public
   * location, never reconstructed from valley display coordinates. */
  earthCell: number;
  wallet: string;
  name: string;
  /** Opaque, same-origin image URL. It deliberately contains no wallet or R2
   * object key; bulk parcel markers may expose only name + avatar identity. */
  avatarUrl: string | null;
  keepLevel: number;
  trophies: number;
  shielded: boolean;
  /** Boolean tease only — GDD §3.4 never reveals the number. */
  surplusTease: boolean;
  clanTag: string | null;
  /** Verified Solana Mobile Seeker — renders the badge beside the nametag. */
  seeker: boolean;
  online: boolean;
  /** Raided within WORLD.mapBurningHours — renders scorched. */
  burning: boolean;
}

/** One PvE ruined keep. PUBLIC — no viewer state. */
export interface CampRow {
  id: string;
  x: number;
  y: number;
  tier: number;
  cleared: boolean;
  bounty: number;
}

/** Everything about a valley that does not depend on who is looking. */
export interface ValleySnapshot {
  valleyId: string;
  valleyName: string;
  players: RosterRow[];
  camps: CampRow[];
}

interface Entry { at: number; snap: ValleySnapshot }

const store = new Map<string, Entry>();
/** Loader invocations — proves "one roster query serves every viewer" in tests. */
let loads = 0;
/** Last expiry pass. The sweep is O(entries), so it runs at most once per TTL
 *  rather than on every miss. */
let lastSweepAt = 0;
/** Fences loaders that began before an authoritative invalidation. Without this,
 * a slow pre-commit roster SELECT can finish after post-commit eviction and put
 * the stale snapshot straight back into the cache. One process-wide generation
 * is deliberately enough: invalidating an unrelated valley may cost one extra
 * load, while per-valley generations would recreate the unbounded-map leak this
 * module exists to prevent. */
let invalidationGeneration = 0;

/**
 * BOUNDED LRU + EXPIRY SWEEP (WORLDMAP-GLOBE-PLAN P5, pulled forward because it
 * fails catastrophically rather than slowly).
 *
 * This store used to be an unbounded Map with no eviction at all: an expired
 * entry was only ever REPLACED, on the next read of that same valley. So the
 * cache held one full roster (≤500 players with names, clan tags and flags) for
 * every valley anyone had ever opened, forever — ~20 MB at 100 K players, ~200 MB
 * at 1 M, ~2 GB and OOM at 10 M. Nothing about it degraded gracefully; the API
 * container simply died, and the only symptom beforehand was memory growth.
 *
 * Both bounds are needed. The sweep reclaims valleys that stopped being viewed
 * (the actual leak); the LRU trim bounds the worst case where more valleys are
 * viewed inside one TTL than we are willing to hold. Map iterates in insertion
 * order and a hit re-inserts its key (see getValleySnapshot), so the front of the
 * iteration order is the least recently USED entry, not merely the oldest.
 */
function evict(nowMs: number, maxEntries: number, ttlMs: number): void {
  if (nowMs - lastSweepAt >= ttlMs) {
    lastSweepAt = nowMs;
    for (const [k, e] of store) if (nowMs - e.at >= ttlMs || nowMs < e.at) store.delete(k);
  }
  while (store.size > maxEntries) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Test seam: run the bounds directly, so the LRU is pinned by BEHAVIOUR (what
 *  gets dropped and when) instead of by whatever the production cap happens to be. */
export function sweepMapCache(
  nowMs: number, maxEntries: number = WORLD.mapCacheMaxValleys, ttlSec: number = WORLD.mapCacheSec,
): void {
  evict(nowMs, maxEntries, ttlSec * 1000);
}

/** Test seam: current entry count. */
export function mapCacheSize(): number { return store.size; }

const keyOf = (valleyId: string, warzoneActive: boolean): string =>
  `${valleyId}:${warzoneActive ? 1 : 0}`;

/**
 * Would a read of this valley be served from memory RIGHT NOW?
 *
 * This is the /map rate limiter's cost oracle (routes.ts MAP_RATE_LIMITS), not a
 * cache-stats helper. A read-only visit is cheap or expensive depending on exactly
 * one thing — whether the roster has to be loaded — so the limiter asks that
 * question instead of guessing from the URL, which is what lets CONTINUING to look
 * at a valley (poll + pan, a cache hit) have a different budget from OPENING a new
 * one (a ≤500-row load + an LRU slot).
 *
 * Both warzone keys are probed because the limiter runs at `onRequest`, before
 * getGameConfig, so it cannot know which key the read will use; either one means the
 * roster is in memory. The TTL is honoured on purpose: an expired entry costs a full
 * load, which is the thing being metered. That also makes the bound exact — one cold
 * read per valley per mapCacheSec, because the miss repopulates the cache.
 */
export function isValleyWarm(valleyId: string, nowMs: number = Date.now()): boolean {
  for (const warzoneActive of [false, true]) {
    const hit = store.get(keyOf(valleyId, warzoneActive));
    if (hit && nowMs - hit.at < WORLD.mapCacheSec * 1000 && nowMs >= hit.at) return true;
  }
  return false;
}

/**
 * Cached valley snapshot. `warzoneActive` is part of the KEY, not a passenger:
 * isWarzoneActive flips shield visibility globally, so a purge starting inside the
 * TTL would otherwise serve up to mapCacheSec of markers claiming bases are
 * shielded that the raid gate will happily let you attack.
 */
export async function getValleySnapshot(
  valleyId: string,
  warzoneActive: boolean,
  loader: () => Promise<ValleySnapshot>,
  nowMs: number = Date.now(),
): Promise<ValleySnapshot> {
  const key = keyOf(valleyId, warzoneActive);
  const hit = store.get(key);
  if (hit && nowMs - hit.at < WORLD.mapCacheSec * 1000 && nowMs >= hit.at) {
    // Re-insert so insertion order == recency of USE, which is what makes the
    // trim in evict() an LRU rather than a FIFO.
    store.delete(key);
    store.set(key, hit);
    return hit.snap;
  }
  loads++;
  const loadGeneration = invalidationGeneration;
  const snap = await loader();
  if (loadGeneration === invalidationGeneration) {
    store.set(key, { at: nowMs, snap });
    evict(nowMs, WORLD.mapCacheMaxValleys, WORLD.mapCacheSec * 1000);
  }
  return snap;
}

/** Drop a valley's entries (both warzone keys). Called when the valley's roster
 *  provably changed — a new keep must not wait out the TTL to appear. */
export function invalidateValley(valleyId: string): void {
  invalidationGeneration++;
  store.delete(keyOf(valleyId, false));
  store.delete(keyOf(valleyId, true));
}

/** Test seam: total loader invocations since process start / last reset. */
export function mapCacheLoads(): number { return loads; }

/** Test seam: empty the cache and zero the counter. */
export function resetMapCache(): void {
  invalidationGeneration++;
  store.clear();
  loads = 0;
  lastSweepAt = 0;
}
