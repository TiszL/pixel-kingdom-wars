/**
 * THE PARCEL BAND'S DATA — every public deed marker under the camera.
 *
 * "1 deed = 1 parcel" was already true in the DATA before this file existed
 * (`plots.player_wallet` is UNIQUE and `transferBase` moves the plots row with the
 * deed); what was missing was anywhere a player could SEE it. This is the read that
 * makes the globe's deepest band possible.
 *
 * Current APIs answer `GET /globe/parcels` over bounded fine-grid rectangles.
 * Unlike the historical `GET /map` reuse below, that read is not scoped to one
 * adopted valley, so a pan cannot silently hide real opponents from adjacent
 * valleys. The old read remains only as a rolling-deploy fallback when the route
 * explicitly says it does not exist; a 5xx is a transient failure, not proof that
 * the server is old.
 *
 * WHY IT ALWAYS SENDS `valleyId`, INCLUDING FOR YOUR OWN VALLEY:
 *  - `getMapChunk` decides "is this mine?" from the roster it already loaded, so
 *    your own valley still answers with `isMe` on your marker — nothing is lost.
 *  - the no-valleyId path is the SIGNUP path (`ensurePlotAssigned`), and a camera
 *    drifting across the region band must never be able to mint a plot or take the
 *    newest valley's row lock.
 *  - with a `valleyId` the route is FREE (routes.ts `requireLandForOwnValley`), so
 *    a deedless player can look at the world without the buy-land sheet being
 *    raised over the board they were told they could look at.
 *
 * The roster carries only public profile identity: a chosen display name and an
 * opaque avatar URL. Wallet addresses remain absent from this deliberately narrow
 * wire shape.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { GLOBE, WORLD } from '@shardkeep/shared';
import {
  newProjected, normalizeLon, projectDeg, RAD_TO_DEG, unprojectDeg, type LonLat,
} from '@shardkeep/shared/globe';
import { ApiError, api } from '../../../lib/api';
import { selectedBasePath } from '../../../lib/baseSelection';
import { useApp } from '../../../state/store';
import { navCamera, radiusPx, type GlobeNav, type ParcelRow } from './globeView';

export interface ViewportParcelBounds {
  /** Inclusive fine-grid columns, always non-wrapping. Antimeridian views are
   * split before tiling so every request has one ordinary indexed row range. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ViewportParcelMarker {
  earthCell: number;
  name: string;
  avatarUrl: string | null;
  keepLevel: number;
}

interface ViewportParcelWireResponse {
  scope: unknown;
  markers: unknown[];
  /** THE MARKER CAP (D-097): the server orders the rect's qualifying bases by
   * distance from the request centre (`cx`/`cy`) and stops at
   * GLOBE.parcelViewportMaxMarkers. `truncated` says the cap bit; `matched` is
   * how many qualified before it. Both are how the chrome stays honest about a
   * 59,000-base planet instead of drawing the first page as if it were all. */
  truncated: boolean;
  matched: number;
}

export interface ViewportParcels {
  /** Current exact rows, or only safe overlap rows while a new scope settles.
   * `null` means no retained marker snapshot exists for this authority yet. */
  markers: readonly ViewportParcelMarker[] | null;
  /** True only when the current authority's complete requested scope has a
   * validated response. Intersection rows from older scopes leave this false. */
  exact: boolean;
  /** Only 404/405/501 set this. Callers may enable the one-valley compatibility
   * hook; network/429/5xx failures deliberately leave it false. */
  unsupported: boolean;
  /** The server's marker cap bit on at least one tile of this scope (D-097): the
   * rows are the NEAREST bases to the visible centre, not every base in view. */
  truncated: boolean;
  /** Qualifying bases in the scope before the cap, summed over its tiles; null
   * while only intersection rows from older scopes are on show. */
  matched: number | null;
}

/** Eight fine cells = 4°. The outward bucket is much smaller than the camera
 * footprint at the first parcel fetch band, while preventing a tiny settled pan
 * from spending another request. This is transport quantization, not game scale. */
const UNSUPPORTED_STATUSES = new Set([404, 405, 501]);
const STALE_SCOPE = Symbol('stale viewport parcel scope');
const OPAQUE_AVATAR_PATH = /^\/api\/avatars\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/;

function quantizedRange(lo: number, hi: number, max: number): [number, number] {
  const q0 = Math.max(
    0,
    Math.floor(lo / GLOBE.parcelViewportQuantumCells) * GLOBE.parcelViewportQuantumCells,
  );
  const q1 = Math.min(
    max,
    Math.ceil((hi + 1) / GLOBE.parcelViewportQuantumCells)
      * GLOBE.parcelViewportQuantumCells - 1,
  );
  return [q0, q1];
}

function tileRange(
  x0: number, x1: number, y0: number, y1: number,
): ViewportParcelBounds[] {
  const out: ViewportParcelBounds[] = [];
  for (let tx0 = x0; tx0 <= x1;) {
    const tx1 = Math.min(x1, tx0 + GLOBE.parcelViewportMaxSpanCells - 1);
    const width = tx1 - tx0 + 1;
    const maxHeight = Math.max(1, Math.min(
      GLOBE.parcelViewportMaxSpanCells,
      Math.floor(GLOBE.parcelViewportMaxCells / width),
    ));
    for (let ty0 = y0; ty0 <= y1;) {
      const ty1 = Math.min(y1, ty0 + maxHeight - 1);
      out.push({ x0: tx0, y0: ty0, x1: tx1, y1: ty1 });
      ty0 = ty1 + 1;
    }
    tx0 = tx1 + 1;
  }
  return out;
}

/**
 * The lon/lat window a camera rectangle shows, in DEGREES. `west`/`east` are
 * unwrapped around the centre meridian (so `east − west` is the true width and
 * either may lie outside ±180); a width of 360 means every longitude is visible.
 */
interface VisibleWindowDeg {
  north: number;
  south: number;
  west: number;
  east: number;
}

/** Perimeter samples per rectangle edge for `exactWindowDeg`. Sixteen keeps the
 * residual between samples far below one fine cell at every parcel-band zoom
 * (the window is ≤ ~32° tall there), and the cell of slack added below covers
 * what is left. 68 inverse projections per settled camera — nothing. */
const WINDOW_EDGE_SAMPLES = 16;

/**
 * THE EXACT VISIBLE WINDOW (D-097): what the rectangle actually shows.
 *
 * Every latitude/longitude extreme of a convex screen region on the near
 * hemisphere lies on its boundary — unless a pole is inside it, in which case
 * every longitude is visible and the window reaches that pole. So the boundary
 * is sampled through the same inverse projection the tap handler uses, and the
 * pole test is one forward projection. `null` when any sample falls off the
 * disc: the rectangle then reaches past the limb and the spherical-cap bound is
 * the honest answer.
 */
function exactWindowDeg(nav: GlobeNav, w: number, h: number): VisibleWindowDeg | null {
  const cam = navCamera(nav, w, h);
  const centreLon = nav.lam0 * RAD_TO_DEG;
  let north = -90;
  let south = 90;
  let dWest = 180;
  let dEast = -180;
  const at: LonLat = { lon: 0, lat: 0 };
  const sample = (sx: number, sy: number): boolean => {
    if (!unprojectDeg(sx, sy, cam, at)) return false;
    north = Math.max(north, at.lat);
    south = Math.min(south, at.lat);
    // Relative to the centre meridian, so a window straddling ±180° is one
    // interval rather than two disjoint ones that look 358° apart.
    const d = normalizeLon(at.lon - centreLon);
    dWest = Math.min(dWest, d);
    dEast = Math.max(dEast, d);
    return true;
  };
  for (let i = 0; i <= WINDOW_EDGE_SAMPLES; i++) {
    const t = i / WINDOW_EDGE_SAMPLES;
    if (!sample(t * w, 0) || !sample(t * w, h) || !sample(0, t * h) || !sample(w, t * h)) return null;
  }
  const pole = newProjected();
  for (const lat of [90, -90]) {
    projectDeg(0, lat, cam, pole);
    if (pole.visible && pole.x >= 0 && pole.x <= w && pole.y >= 0 && pole.y <= h) {
      if (lat > 0) north = 90; else south = -90;
      dWest = -180;
      dEast = 180;
    }
  }
  return { north, south, west: centreLon + dWest, east: centreLon + dEast };
}

/**
 * The spherical-cap bound the exact window replaced, kept as its fallback for
 * a rectangle that reaches past the limb: the viewport is contained by a
 * screen-space circle whose radius is its half-diagonal, and the cap that circle
 * unprojects to has analytic latitude and longitude extrema. Never tighter than
 * the truth, which is all a fallback has to be.
 */
function capWindowDeg(nav: GlobeNav, w: number, h: number, r: number): VisibleWindowDeg {
  const cap = Math.asin(Math.min(1, Math.hypot(w, h) / (2 * r)));
  const north = Math.min(90, (nav.phi0 + cap) * RAD_TO_DEG);
  const south = Math.max(-90, (nav.phi0 - cap) * RAD_TO_DEG);
  const centreLon = nav.lam0 * RAD_TO_DEG;
  if (Math.abs(nav.phi0) + cap >= Math.PI / 2) {
    return { north, south, west: centreLon - 180, east: centreLon + 180 };
  }
  const halfLon = Math.asin(Math.min(1, Math.sin(cap) / Math.cos(nav.phi0))) * RAD_TO_DEG;
  return { north, south, west: centreLon - halfLon, east: centreLon + halfLon };
}

/** The visible centre in degrees — the camera's own centre, which the server
 * orders the capped marker page by (`cx`/`cy`, D-097). */
export function visibleParcelCentre(nav: GlobeNav): LonLat {
  return { lon: normalizeLon(nav.lam0 * RAD_TO_DEG), lat: nav.phi0 * RAD_TO_DEG };
}

/**
 * Fine-grid coverage for the committed camera: the EXACT visible window (D-097),
 * clamped to the D-042 span/quantum rules.
 *
 * It used to be the spherical cap around the rectangle's circumscribed circle,
 * which at parcel zoom asked for up to 4× the ground on screen and, near a
 * pole, the whole request budget. On a planet heading for 59,000 bases that
 * over-ask is what the marker cap would spend itself on. The window is now the
 * rectangle's own extent plus one fine cell of slack on every side (for the
 * perimeter sampling's residual, and so a base on the very edge is never
 * dropped); quantization then expands outward as before. Longitude is split at
 * ±180° before backend-limit tiling.
 */
export function visibleParcelBounds(
  nav: GlobeNav,
  viewport: { width: number; height: number },
): ViewportParcelBounds[] {
  if (!(viewport.width > 0) || !(viewport.height > 0)) return [];
  const r = radiusPx(nav.zoom, Math.min(viewport.width, viewport.height));
  if (!(r > 0)) return [];
  const win = exactWindowDeg(nav, viewport.width, viewport.height)
    ?? capWindowDeg(nav, viewport.width, viewport.height, r);
  const dLat = 180 / GLOBE.fineRows;
  const dLon = 360 / GLOBE.fineCols;
  const rawY0 = Math.max(0, Math.floor((90 - win.north) / dLat) - 1);
  const rawY1 = Math.min(GLOBE.fineRows - 1, Math.ceil((90 - win.south) / dLat));
  const [y0, y1] = quantizedRange(rawY0, rawY1, GLOBE.fineRows - 1);

  const lonRanges: Array<[number, number]> = [];
  // One cell of slack each side; a window that then wraps is every column.
  const width = win.east - win.west + 2 * dLon;
  if (width >= 360) {
    lonRanges.push([0, GLOBE.fineCols - 1]);
  } else {
    // Rebase so the western edge sits in [−180, 180); the eastern edge may then
    // cross +180 and is split there, which is the only wrap left to handle.
    const shift = Math.floor((win.west - dLon + 180) / 360) * 360;
    const west = win.west - dLon - shift;
    const east = win.east + dLon - shift;
    const range = (lo: number, hi: number): [number, number] => quantizedRange(
      Math.max(0, Math.floor((lo + 180) / dLon)),
      Math.min(GLOBE.fineCols - 1, Math.ceil((hi + 180) / dLon) - 1),
      GLOBE.fineCols - 1,
    );
    if (east >= 180) {
      lonRanges.push(range(west, 180), range(-180, east - 360));
    } else {
      lonRanges.push(range(west, east));
    }
  }

  const centreLon = nav.lam0 * RAD_TO_DEG;
  const centreLat = nav.phi0 * RAD_TO_DEG;
  const cellLonDeg = 360 / GLOBE.fineCols;
  const cellLatDeg = 180 / GLOBE.fineRows;
  const distanceSq = (rect: ViewportParcelBounds): number => {
    const lon = -180 + ((rect.x0 + rect.x1 + 1) / 2) * cellLonDeg;
    const lat = 90 - ((rect.y0 + rect.y1 + 1) / 2) * cellLatDeg;
    const lonDelta = ((((lon - centreLon + 180) % 360) + 360) % 360) - 180;
    // Camera-nearest ordering only ranks bounded fetch tiles. Equirectangular
    // distance with cos(latitude) is monotonic enough here and avoids sorting by
    // a tactical/player field or importing another hot-path projection.
    return (lonDelta * Math.cos(centreLat / RAD_TO_DEG)) ** 2 + (lat - centreLat) ** 2;
  };
  return lonRanges
    .flatMap(([x0, x1]) => tileRange(x0, x1, y0, y1))
    .sort((a, b) => distanceSq(a) - distanceSq(b)
      || a.y0 - b.y0 || a.x0 - b.x0)
    .slice(0, GLOBE.parcelViewportMaxRequests);
}

export function viewportBoundsKey(bounds: readonly ViewportParcelBounds[]): string {
  return bounds.map((r) => `${r.x0},${r.y0},${r.x1},${r.y1}`).join(';');
}

function markerInside(
  marker: Pick<ViewportParcelMarker, 'earthCell'>,
  bounds: ViewportParcelBounds,
): boolean {
  const x = marker.earthCell % GLOBE.fineCols;
  const y = Math.floor(marker.earthCell / GLOBE.fineCols);
  return x >= bounds.x0 && x <= bounds.x1 && y >= bounds.y0 && y <= bounds.y1;
}

export function viewportResponseMatchesScope(
  response: Pick<ViewportParcelWireResponse, 'scope'>,
  bounds: ViewportParcelBounds,
): boolean {
  if (!response.scope || typeof response.scope !== 'object') return false;
  const scope = response.scope as Record<string, unknown>;
  return scope['x0'] === bounds.x0 && scope['y0'] === bounds.y0
    && scope['x1'] === bounds.x1 && scope['y1'] === bounds.y1;
}

function markerInsideAny(
  marker: ViewportParcelMarker,
  bounds: readonly ViewportParcelBounds[],
): boolean {
  return viewportContainsEarthCell(marker.earthCell, bounds);
}

export function viewportContainsEarthCell(
  earthCell: number,
  bounds: readonly ViewportParcelBounds[],
): boolean {
  if (!Number.isInteger(earthCell) || earthCell < 0
    || earthCell >= GLOBE.fineCols * GLOBE.fineRows) return false;
  return bounds.some((rect) => markerInside({ earthCell }, rect));
}

/** Runtime projection keeps the additive route minimal even if a future API row
 * accidentally acquires tactical fields. Invalid/out-of-scope rows fail closed. */
export function viewportMarkers(
  response: ViewportParcelWireResponse,
  bounds: ViewportParcelBounds,
): ViewportParcelMarker[] {
  const out: ViewportParcelMarker[] = [];
  for (const value of response.markers) {
    if (!value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    if (!Number.isInteger(row['earthCell']) || typeof row['name'] !== 'string'
      || !Number.isInteger(row['keepLevel']) || (row['keepLevel'] as number) < 1
      || !(row['avatarUrl'] === null || typeof row['avatarUrl'] === 'string')) continue;
    const avatarUrl = typeof row['avatarUrl'] === 'string'
      && OPAQUE_AVATAR_PATH.test(row['avatarUrl'])
      ? row['avatarUrl']
      : null;
    const marker: ViewportParcelMarker = {
      earthCell: row['earthCell'] as number,
      name: row['name'] as string,
      avatarUrl,
      keepLevel: row['keepLevel'] as number,
    };
    if (marker.earthCell < 0 || marker.earthCell >= GLOBE.fineCols * GLOBE.fineRows
      || !markerInside(marker, bounds)) continue;
    out.push(marker);
  }
  return out;
}

/** Stable cell order prevents a changing SQL plan from changing marker overlap;
 * the selected cell is drawn last so it retains visual priority through pans. */
export function prioritizeViewportMarkers(
  markers: readonly ViewportParcelMarker[], selectedCell: number | null,
): ViewportParcelMarker[] {
  return [...markers].sort((a, b) => {
    const aSelected = a.earthCell === selectedCell;
    const bSelected = b.earthCell === selectedCell;
    return aSelected === bSelected ? a.earthCell - b.earthCell : aSelected ? 1 : -1;
  });
}

/** Retain only the marker for the cell that is still selected. A rapid A→B
 * selection cannot carry A's body while B's scope is unresolved. */
export function retainedSelectedViewportMarker(
  markers: readonly ViewportParcelMarker[] | null,
  prior: ViewportParcelMarker | null,
  selectedCell: number | null,
  exactOmission = false,
): ViewportParcelMarker | null {
  if (selectedCell === null || exactOmission) return null;
  return markers?.find((marker) => marker.earthCell === selectedCell)
    ?? (prior?.earthCell === selectedCell ? prior : null);
}

/** A completed scope is authoritative about eligible public markers inside it.
 * An omitted selected cell may bridge an unresolved pan or stay available while
 * off-screen, but it must not survive a fresh in-scope eligibility revocation. */
export function exactViewportOmitsCell(
  viewport: ViewportParcels,
  bounds: readonly ViewportParcelBounds[],
  earthCell: number | null,
): boolean {
  return earthCell !== null
    && viewport.exact
    && viewportContainsEarthCell(earthCell, bounds)
    && !viewport.markers?.some((marker) => marker.earthCell === earthCell);
}

interface ViewportRequestScope {
  authority: string;
  key: string;
  bounds: readonly ViewportParcelBounds[];
  /** The visible centre the server orders the capped page by. Deliberately NOT
   * part of `key`: the bounds are quantized so a small settled pan does not
   * spend a request, and a centre that re-keyed every pan would undo exactly
   * that. The next request the bounds or the poll do spend carries the centre
   * of the moment. */
  centre: LonLat | null;
}

/**
 * Bounded public parcel polling for the committed camera viewport.
 *
 * Settled camera scopes debounce, but transport never overlaps: a newer scope
 * queues behind the request already on the wire and supersedes any remaining old
 * tiles as soon as that request settles. Multi-tile scopes publish atomically, so
 * an antimeridian or high-latitude view never renders a truthful half beside an
 * unknown half. Last-good data is returned only when its full authority + bounds
 * key matches the current request.
 *
 * @param centre the visible centre in degrees (`visibleParcelCentre`), sent as
 *   `cx`/`cy` so the server's marker cap keeps the NEAREST bases (D-097).
 */
export function useViewportParcels(
  bounds: readonly ViewportParcelBounds[] | null,
  want: boolean,
  centre: LonLat | null = null,
): ViewportParcels {
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const wallet = useApp((s) => s.wallet);
  const entryPaid = useApp((s) => s.entryPaid);
  const authority = `${selectedBaseId ?? '-'}|${wallet ?? '-'}|${entryPaid ? 1 : 0}`;
  const boundsKey = useMemo(() => viewportBoundsKey(bounds ?? []), [bounds]);
  const scope = want && bounds && bounds.length > 0
    ? { authority, key: `${authority}|${boundsKey}`, bounds, centre }
    : null;
  const desiredRef = useRef<ViewportRequestScope | null>(scope);
  desiredRef.current = scope;
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const cacheRef = useRef(new Map<string, {
    authority: string;
    bounds: readonly ViewportParcelBounds[];
    markers: ViewportParcelMarker[];
    truncated: boolean;
    matched: number;
  }>());
  const cacheAuthorityRef = useRef(authority);
  if (cacheAuthorityRef.current !== authority) {
    // Render-time fence: effects are one commit too late for an account switch.
    // These are minimal public DTOs, but viewer scope still never crosses wallets.
    cacheRef.current.clear();
    cacheAuthorityRef.current = authority;
  }
  const [, publishCache] = useState(0);
  const [unsupportedAuthority, setUnsupportedAuthority] = useState<string | null>(null);
  const unsupportedRef = useRef<string | null>(unsupportedAuthority);
  unsupportedRef.current = unsupportedAuthority;
  const aliveRef = useRef(false);
  const runningRef = useRef(false);
  const queuedRef = useRef(false);
  const debounceRef = useRef(0);
  const pollRef = useRef(0);
  const launchRef = useRef<() => void>(() => {});

  const schedulePoll = (): void => {
    window.clearTimeout(pollRef.current);
    pollRef.current = window.setTimeout(
      () => launchRef.current(),
      WORLD.mapPollSec * 1_000,
    );
  };

  launchRef.current = () => {
    const target = desiredRef.current;
    if (!aliveRef.current || !target || document.visibilityState !== 'visible'
      || unsupportedRef.current === target.authority) return;
    if (runningRef.current) {
      queuedRef.current = true;
      return;
    }
    runningRef.current = true;
    const load = async (): Promise<{
      markers: ViewportParcelMarker[]; truncated: boolean; matched: number;
    }> => {
      const merged = new Map<number, ViewportParcelMarker>();
      let truncated = false;
      let matched = 0;
      // Three decimals of a degree is ~100 m — far inside one 0.5° cell, and a
      // stable string for a URL that a proxy or the server may key a cache on.
      const centre = target.centre
        ? `&cx=${target.centre.lon.toFixed(3)}&cy=${target.centre.lat.toFixed(3)}`
        : '';
      for (const rect of target.bounds) {
        if (desiredRef.current?.key !== target.key) throw STALE_SCOPE;
        const qs = `x0=${rect.x0}&y0=${rect.y0}&x1=${rect.x1}&y1=${rect.y1}${centre}`;
        const response = await api.get<ViewportParcelWireResponse>(
          selectedBasePath(`/globe/parcels?${qs}`),
        );
        if (desiredRef.current?.key !== target.key) throw STALE_SCOPE;
        if (!response || !Array.isArray(response.markers)) {
          throw new Error('Invalid globe parcel response');
        }
        if (!viewportResponseMatchesScope(response, rect)) {
          throw new Error('Globe parcel scope mismatch');
        }
        const inRect = viewportMarkers(response, rect);
        for (const marker of inRect) merged.set(marker.earthCell, marker);
        // Tiles are disjoint, so the qualifying counts add. A response without
        // a usable count is taken at its own row count — never more than it
        // proved — and only an explicit `true` says the cap bit.
        truncated ||= response.truncated === true;
        matched += Number.isFinite(response.matched) ? response.matched : inRect.length;
      }
      return {
        markers: [...merged.values()].sort((a, b) => a.earthCell - b.earthCell),
        truncated,
        matched,
      };
    };

    void load()
      .then(({ markers, truncated, matched }) => {
        if (!aliveRef.current || authorityRef.current !== target.authority) return;
        setUnsupportedAuthority(null);
        const cache = cacheRef.current;
        cache.delete(target.key);
        cache.set(target.key, {
          authority: target.authority,
          bounds: target.bounds,
          markers,
          truncated,
          matched,
        });
        while (cache.size > GLOBE.parcelViewportCacheScopes) {
          cache.delete(cache.keys().next().value!);
        }
        publishCache((version) => version + 1);
      })
      .catch((error: unknown) => {
        if (!aliveRef.current || error === STALE_SCOPE
          || authorityRef.current !== target.authority) return;
        if (error instanceof ApiError && UNSUPPORTED_STATUSES.has(error.status)) {
          unsupportedRef.current = target.authority;
          setUnsupportedAuthority(target.authority);
        }
        // Every other failure retains this exact scope's last-good markers. It
        // neither activates the legacy route nor publishes a partially loaded tile.
      })
      .finally(() => {
        runningRef.current = false;
        if (!aliveRef.current) return;
        if (queuedRef.current) {
          queuedRef.current = false;
          launchRef.current();
        } else if (desiredRef.current && unsupportedRef.current !== authorityRef.current) {
          schedulePoll();
        }
      });
  };

  useEffect(() => {
    aliveRef.current = true;
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(pollRef.current);
      launchRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      aliveRef.current = false;
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(pollRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const requestKey = `${scope?.key ?? ''}|${want ? 1 : 0}`;
  useEffect(() => {
    window.clearTimeout(debounceRef.current);
    window.clearTimeout(pollRef.current);
    if (!scope || unsupportedRef.current === scope.authority) return;
    debounceRef.current = window.setTimeout(
      () => launchRef.current(),
      GLOBE.parcelViewportDebounceMs,
    );
  }, [requestKey]);

  const unsupported = unsupportedAuthority === authority;
  let retained: ViewportParcelMarker[] | null = null;
  let exact = false;
  let truncated = false;
  let matched: number | null = null;
  if (scope !== null) {
    const exactEntry = cacheRef.current.get(scope.key);
    if (exactEntry?.authority === authority) {
      exact = true;
      retained = exactEntry.markers;
      truncated = exactEntry.truncated;
      matched = exactEntry.matched;
    } else {
      // Quantized A→overlapping B keeps only the intersection until B settles.
      // Newest scopes win duplicate cells; disjoint scopes truthfully yield [].
      const merged = new Map<number, ViewportParcelMarker>();
      const cached = [...cacheRef.current.values()].reverse();
      for (const entry of cached) {
        if (entry.authority !== authority) continue;
        for (const marker of entry.markers) {
          if (markerInsideAny(marker, scope.bounds) && !merged.has(marker.earthCell)) {
            merged.set(marker.earthCell, marker);
            // A capped page's overlap is still a capped page: the "+" must not
            // vanish for the settle interval and reappear. The count itself is
            // unknown for the intersection, so it stays null.
            truncated ||= entry.truncated;
          }
        }
      }
      if (cached.length > 0) {
        retained = [...merged.values()].sort((a, b) => a.earthCell - b.earthCell);
      }
    }
  }
  return {
    markers: unsupported ? null : retained,
    exact: !unsupported && exact,
    unsupported,
    truncated: !unsupported && truncated,
    matched: unsupported ? null : matched,
  };
}

/**
 * `GET /map`, narrowed to what a parcel pin needs.
 *
 * Deliberately NOT the full `MapChunk` shape from map.tsx: this band renders
 * foreign valleys, and a type that could hold a wallet is a type a future edit
 * could render one from. `keepLevel` is optional because PVE camp markers have no
 * keep level — and camps are not parcels, so they are dropped below.
 */
interface ParcelWireMarker {
  kind: 'player' | 'silhouette' | 'pve';
  x: number;
  y: number;
  /** Present on every deed plot and absent on non-deeded PvE camps. */
  earthCell?: number;
  keepLevel?: number;
  /** Present (and true) on exactly one marker of your own valley. */
  isMe?: boolean;
  name?: string;
  avatarUrl?: string | null;
}
interface ParcelWireChunk {
  valleyId: string;
  valleyName: string;
  markers: ParcelWireMarker[];
  /** SERVER truth: you are looking at somebody else's valley. */
  visiting: boolean;
}

export interface ValleyParcels {
  valleyId: string;
  valleyName: string;
  /** SERVER truth for "this is not your valley" — the client never guesses it by
   *  comparing ids, because the read-only contract is the server's to state. */
  visiting: boolean;
  rows: ParcelRow[];
}

/** Camps hold grid tiles but are not deeded land, so they are not parcels. */
export function toRows(chunk: ParcelWireChunk): ParcelRow[] {
  const rows: ParcelRow[] = [];
  for (const m of chunk.markers) {
    if (m.kind === 'pve') continue;
    // A marker without its frozen address is not safe to place on Earth. Fail
    // closed during a rolling API/web mismatch rather than reconstructing a deed
    // address from mutable generated geography.
    if (!Number.isInteger(m.earthCell)) continue;
    rows.push({
      x: m.x, y: m.y, earthCell: m.earthCell!,
      keepLevel: m.keepLevel ?? 1, mine: m.isMe === true,
      name: m.name,
      avatarUrl: m.avatarUrl,
    });
  }
  return rows;
}

/**
 * The parcels of ONE valley, refreshed while the document is visible.
 *
 * `want` is the band gate — see `BandMix.wantParcels`: the read is ~500 markers,
 * so it must not fire while the player is merely browsing the region band. Polls
 * never overlap, pause in background tabs, and retain the last good roster across
 * a transient failure.
 */
export function useValleyParcels(valleyId: string | null, want: boolean): ValleyParcels | null {
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const wallet = useApp((s) => s.wallet);
  const entryPaid = useApp((s) => s.entryPaid);
  const [data, setData] = useState<ValleyParcels | null>(null);
  const scopeRef = useRef({ selectedBaseId, wallet, entryPaid });
  const scopeMatches = scopeRef.current.selectedBaseId === selectedBaseId
    && scopeRef.current.wallet === wallet && scopeRef.current.entryPaid === entryPaid;
  useEffect(() => {
    if (!valleyId || !want) return undefined;
    // Band changes are presentation only. Keep the exact valley's last-good public
    // roster while the player pinches out and back in, and across a transient read
    // failure. Authentication/base scope changes still clear it immediately so no
    // prior account's viewer-relative `isMe` bit can survive a session transition.
    const priorScope = scopeRef.current;
    const scopeChanged = priorScope.selectedBaseId !== selectedBaseId
      || priorScope.wallet !== wallet || priorScope.entryPaid !== entryPaid;
    scopeRef.current = { selectedBaseId, wallet, entryPaid };
    setData((prior) => scopeChanged || (prior !== null && prior.valleyId !== valleyId)
      ? null : prior);
    let live = true;
    let running = false;
    let timer = 0;
    const qs = `x0=0&y0=0&x1=${WORLD.gridCols - 1}&y1=${WORLD.gridRows - 1}`
      + `&valleyId=${encodeURIComponent(valleyId)}&parcelBand=1`;
    const schedule = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, WORLD.mapPollSec * 1_000);
    };
    const run = (): void => {
      if (!live || running) return;
      if (document.visibilityState === 'hidden') { schedule(); return; }
      running = true;
      void api.get<ParcelWireChunk>(selectedBasePath(`/map?${qs}`))
        .then((c) => {
          if (!live) return;
          setData({
            valleyId: c.valleyId, valleyName: c.valleyName, visiting: c.visiting, rows: toRows(c),
          });
        })
        .catch(() => {})
        .finally(() => {
          running = false;
          if (live) schedule();
        });
    };
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible' || running) return;
      window.clearTimeout(timer);
      run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    run();
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [valleyId, want, selectedBaseId, wallet, entryPaid]);
  return scopeMatches && data && data.valleyId === valleyId ? data : null;
}
