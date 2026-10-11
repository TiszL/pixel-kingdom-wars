// World v2 realm-map parcel feed (D-186; native WorldRealmFeed.kt at 7b5075b). The realm
// map reads its kingdoms from the SAME bounded parcel-viewport route as the globe
// (GET /globe/fantasy/parcels); no new server call exists (the occupancy feed is OQ-1).
// A realm-map camera can show a whole realm, far more than one read may cover, so a
// settled camera gets the D-042 rects of its visible box (8-cell quantum, ≤ 64×64 cells,
// split at the seam: fantasyViewportRects), only the GLOBE.parcelViewportMaxRequests
// nearest the centre, and the rest is disclosed as truncated, never drawn as a falsely
// complete realm. Type-only imports from ./data keep this module free of a cycle.
import { useEffect, useState } from 'react';
import { FANTASY_WORLD, GLOBE } from '@shardkeep/shared';
import type { FantasyRect, FantasyViewBounds } from './data';

export interface RealmFeedScope { rects: FantasyRect[]; truncated: boolean }

const DEGREES_PER_COLUMN = 360 / FANTASY_WORLD.columns, DEGREES_PER_ROW = 180 / FANTASY_WORLD.rows;

/** A realm-map window in catalog deed columns/rows (x may run past either edge, as
 *  Cinderfall wraps the seam) as the degree box the host's parcel reads take. */
export function realmWindowBounds(window: { x0: number; y0: number; x1: number; y1: number }): FantasyViewBounds {
  return { west: window.x0 * DEGREES_PER_COLUMN - 180, east: window.x1 * DEGREES_PER_COLUMN - 180,
    north: 90 - window.y0 * DEGREES_PER_ROW, south: 90 - window.y1 * DEGREES_PER_ROW };
}

/** The reads for one settled realm-map camera: `all` (the box's bounded rects) nearest
 *  the box centre first (the nearer way round the seam), at most
 *  GLOBE.parcelViewportMaxRequests of them, `truncated` when the box needed more. */
export function realmFeedScope(all: readonly FantasyRect[], bounds: FantasyViewBounds): RealmFeedScope {
  const columns = FANTASY_WORLD.columns;
  const cx = ((bounds.west + bounds.east) / 2 + 180) / DEGREES_PER_COLUMN, cy = (90 - (bounds.north + bounds.south) / 2) / DEGREES_PER_ROW;
  const distance = (r: FantasyRect): number => {
    let dx = (r.x0 + r.x1 + 1) / 2 - cx;
    dx -= Math.round(dx / columns) * columns;
    const dy = (r.y0 + r.y1 + 1) / 2 - cy;
    return dx * dx + dy * dy;
  };
  const nearest = [...all].sort((a, b) => distance(a) - distance(b) || a.y0 - b.y0 || a.x0 - b.x0);
  return { rects: nearest.slice(0, GLOBE.parcelViewportMaxRequests), truncated: all.length > GLOBE.parcelViewportMaxRequests };
}

/** `scope` once it has held still for GLOBE.parcelViewportDebounceMs, so a pan costs one
 *  read however many frames it spans. While a pan is in flight the last settled scope
 *  stays (its kingdoms stay drawn); with no scope there is nothing, and re-entry waits
 *  for a fresh settle rather than re-reading the old box. */
export function useSettledRealmScope(scope: RealmFeedScope | null): RealmFeedScope | null {
  const key = scope ? JSON.stringify(scope) : null;
  const [settled, setSettled] = useState<RealmFeedScope | null>(null);
  useEffect(() => {
    if (!scope) { setSettled(null); return undefined; }
    const timer = setTimeout(() => setSettled(scope), GLOBE.parcelViewportDebounceMs);
    return () => clearTimeout(timer);
    // The key carries the whole scope; a new object with the same reads must not restart the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return scope ? settled : null;
}
