// Realm-map kingdom pictures (native 560fe54 + e26fa94, owner 2026-09-26: "every tag gets its picture").
//
// A realm map can put 1,024 kingdoms on screen; the avatar route allows 360 requests a minute per wallet. So:
//   * only the server's own same-origin `/api/avatars/<uuid>.webp` paths are fetched (the chat and data.ts rule);
//   * at most AVATAR_MAX_IN_FLIGHT requests run at once, the rest QUEUE (never dropped: a tag that asked once must
//     still get its picture), the most recently wanted first, and a request nobody has wanted for a while is dropped;
//   * a 404/410 or an unusable image is remembered for this visit only (clear() forgets it at the world's stop);
//     any other failure (network, 5xx, 429) is retried after a bounded backoff that honours Retry-After;
//   * decoded pictures live as object URLs in an LRU of AVATAR_CACHE_MAX; eviction revokes them.
// These are client network limits, not game numbers (constants.ts holds the server's buckets).

export const AVATAR_MAX_IN_FLIGHT = 4;
export const AVATAR_CACHE_MAX = 32;
/** A queued picture no tag has asked for in this long is dropped (the tag left the screen). */
export const AVATAR_QUEUE_STALE_MS = 5_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** The same shape data.ts accepts from the feed (apps/api fantasyGlobe avatar()). */
const AVATAR_PATH = /^\/api\/avatars\/[0-9a-f-]{36}\.webp$/;
export function isAvatarPath(path: unknown): path is string {
  return typeof path === 'string' && AVATAR_PATH.test(path);
}

export interface AvatarQueueOptions {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  /** Called when a picture arrives (the map redraws its tags). */
  onChange?: () => void;
  now?: () => number;
  /** Timer for the retry wake-up (tests inject a fake). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  maxInFlight?: number;
  cacheMax?: number;
}
export interface AvatarQueueStats { inFlight: number; queued: number; cached: number; missing: number; maxInFlightSeen: number; fetches: number }
export interface AvatarQueue {
  /** The picture's object URL when it is here; else null, and the path is queued (or waits out its backoff). */
  url(path: string | null | undefined): string | null;
  /** The world stopped: cancel everything, revoke every picture, forget the visit's 404s. */
  clear(): void;
  stats(): AvatarQueueStats;
}

export function createAvatarQueue(o: AvatarQueueOptions = {}): AvatarQueue {
  const fetchImpl = o.fetchImpl ?? ((url, init) => fetch(url, init));
  const createURL = o.createObjectURL ?? (b => URL.createObjectURL(b));
  const revokeURL = o.revokeObjectURL ?? (u => URL.revokeObjectURL(u));
  const now = o.now ?? (() => Date.now());
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const maxInFlight = o.maxInFlight ?? AVATAR_MAX_IN_FLIGHT, cacheMax = o.cacheMax ?? AVATAR_CACHE_MAX;
  const cache = new Map<string, string>();                   // path → object URL, oldest use first
  const missing = new Set<string>();                         // 404/410/not an image: this visit only
  const queued = new Map<string, number>();                  // path → last time a tag wanted it
  const retryAt = new Map<string, { at: number; n: number }>();
  const inFlight = new Map<string, AbortController>();
  let visit = 0, maxSeen = 0, fetches = 0;

  const evict = () => {
    while (cache.size > cacheMax) {
      const [oldest, u] = cache.entries().next().value as [string, string];
      cache.delete(oldest); revokeURL(u);
    }
  };
  const pump = () => {
    const t = now();
    for (const [p, at] of queued) if (t - at > AVATAR_QUEUE_STALE_MS) queued.delete(p);
    while (inFlight.size < maxInFlight && queued.size) {
      let best: string | null = null, bestAt = -Infinity;
      for (const [p, at] of queued) if (at > bestAt) { best = p; bestAt = at; }
      if (best === null) break;
      queued.delete(best); start(best);
    }
  };
  const fail = (path: string, retryAfterS: number | null) => {
    const prev = retryAt.get(path), n = prev ? prev.n + 1 : 0;
    const wait = retryAfterS !== null && retryAfterS > 0 ? Math.min(60_000, retryAfterS * 1000) : BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]!;
    retryAt.set(path, { at: now() + wait, n });
    const mine = visit; setTimer(() => { if (mine === visit) o.onChange?.(); }, wait); // an idle map redraws, so its tag asks again
  };
  function start(path: string) {
    const ac = new AbortController(), mine = visit;
    inFlight.set(path, ac); maxSeen = Math.max(maxSeen, inFlight.size); fetches++;
    void (async () => {
      try {
        const res = await fetchImpl(path, { credentials: 'same-origin', signal: ac.signal });
        if (mine !== visit) return;
        if (res.status === 404 || res.status === 410) { missing.add(path); return; }
        if (!res.ok) { const ra = Number(res.headers.get('retry-after')); fail(path, Number.isFinite(ra) ? ra : null); return; }
        const blob = await res.blob();
        if (mine !== visit) return;
        if (!/^image\//.test(blob.type || res.headers.get('content-type') || '')) { missing.add(path); return; }
        retryAt.delete(path);
        cache.set(path, createURL(blob)); evict();
        o.onChange?.();
      } catch {
        if (mine === visit && !ac.signal.aborted) fail(path, null);
      } finally {
        if (inFlight.get(path) === ac) inFlight.delete(path);
        if (mine === visit) pump();
      }
    })();
  }

  return {
    url(path) {
      if (!isAvatarPath(path)) return null;
      const hit = cache.get(path);
      if (hit !== undefined) { cache.delete(path); cache.set(path, hit); return hit; } // LRU: most recently shown last
      if (missing.has(path) || inFlight.has(path)) return null;
      const r = retryAt.get(path); if (r && now() < r.at) return null;
      queued.set(path, now()); pump();
      return null;
    },
    clear() {
      visit++;
      for (const ac of inFlight.values()) ac.abort();
      inFlight.clear(); queued.clear(); retryAt.clear(); missing.clear();
      for (const u of cache.values()) revokeURL(u);
      cache.clear();
    },
    stats: () => ({ inFlight: inFlight.size, queued: queued.size, cached: cache.size, missing: missing.size, maxInFlightSeen: maxSeen, fetches }),
  };
}

/** The picture a tag shows without its own: initials on a colour hashed from the name (never a broken image). */
export function defaultPortrait(name: string, mine: boolean): string {
  const words = name.trim().split(/[\s._-]+/u).filter(Boolean);
  const first = (w: string | undefined) => (w ? Array.from(w)[0] ?? '' : '');
  const text = (words.length >= 2 ? first(words[0]) + first(words[1]) : first(words[0])).toUpperCase() || '?';
  let h = 0x811c9dc5; for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  const bg = mine ? '#8a6a1c' : `hsl(${(h >>> 0) % 360} 46% 38%)`;
  const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${bg}"/>`
    + `<text x="16" y="21" font-family="monospace" font-size="14" fill="#fff" text-anchor="middle">${esc(text)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
