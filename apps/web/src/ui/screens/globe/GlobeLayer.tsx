import { RaidEntryCost } from '../../RaidEntryCost';
/**
 * THE GLOBE BAND, wired up: data, chrome, and where a tap leads.
 *
 * This module is DYNAMICALLY IMPORTED by MapScreen when WORLD mounts, which keeps
 * it (and the fine earth mask it pulls in later) out of the first-paint JS graph
 * while the player is elsewhere — measured at 995 / 1000 KB
 * gzip, and scripts/size-check.mjs fails the build at 1001.
 *
 * ONE EXCEPTION, WORTH KNOWING BEFORE YOU MOVE CODE AROUND: `map.tsx` imports
 * `./globe/globeView` STATICALLY (for `railRowsForWorld`, which the campaign/map
 * chrome needs before anything is lazy-loaded), so globeView.ts IS in the
 * first-paint graph even though this file is not. Anything added there is paid for
 * by every player; anything added here is paid for only by one who taps GLOBE.
 *
 * The player-facing hierarchy is now simply WORLD → REGION → EARTH TILE. Internal
 * valley rows remain an allocation/cache detail, never a second world surface.
 * YOUR PARCEL is one `plots` row: the Earth tile a Land Deed owns, drawn directly
 * on this layer with every other claimed base.
 *
 * AND SINCE P4b, A PARCEL IS A REAL PLACE ON EARTH. It is still exactly the `plots`
 * row it always was — that lock does not move — but it additionally resolves, through
 * `parcelCell(valleys.site_id, plots.x, plots.y)`, to ONE claimable 0.5° Earth land
 * cell: a county, ~39 × 56 km, in a named country. Every pin is drawn at that cell's
 * centre, so a parcel cannot be in the ocean by construction. What is gone is the
 * screen-space lattice this file used to feed (`lon: parcelValley.lon` for all 491 of
 * them) and the six functions that propped it up.
 *
 * WHAT THE `VITE_FEATURE_EARTH_TILES` FLAG GATES, AND WHAT IT DOES NOT — say it once,
 * here, because it is the one place the P0-P4 guarantee is not absolute:
 *  - GATED: the rasteriser's tile pass (quads, country tint, borders, the 1 px grid,
 *    surf), the `wantFineMask` floor at z1.2, and the CANVAS label ladder. Flag off is
 *    the shipped silhouette globe and the shipped (un-gated) valley labels, byte for
 *    byte, and rollback is one env var.
 *  - NOT GATED: where a parcel IS. The six lattice functions are deleted, so there is
 *    no fiction left to fall back to, and a flag that chose between "each parcel on
 *    its own Earth cell" and "491 pins on one pixel" would be a switch between correct
 *    and broken rather than between new and shipped. A cell is geography, not a render
 *    mode: a pin at its true lat/lon is right on a silhouette planet too. The tile
 *    identity the chrome shows (country, tile id, degrees) comes with it, because the
 *    band needs the same country index to place a parcel honestly. This is a recorded
 *    deviation from EARTH-TILES-PLAN §6's "flag off is today's globe byte-for-byte",
 *    and it is deliberate.
 *
 * THE THREE OWNER DECISIONS THIS FILE IMPLEMENTS (locked 2026-08-09):
 *  1. HONEST AND BROWSABLE. Every populated sector is drawn, everywhere, at full
 *     strength; the ones holding a Keep you may attack (D-099: theirs at least
 *     half yours) get a GOLD RING. Reach is Keep level, not distance, so nothing
 *     is ever greyed out for being far away — the ring is the answer to "who can
 *     I fight", and the rest of the planet is still the world you live in.
 *  2. BOUNDED EXPLORING. Globe and sector reads remain aggregates. The deed band
 *     shows only public username + opaque avatar; selecting one `earthCell`
 *     resolves loot/shield/actions through the separately rate-limited detail
 *     endpoint, and scout/attack still revalidate through their own routes.
 *  3. THE GLOBE IS THE WORLD SURFACE (owner supersession 2026-08-20). There is no
 *     local valley descent; bases remain selectable Earth tiles on the globe.
 *
 * The globe is its own WORLD surface. The retired tactical board is not mounted
 * behind its lazy load or opening frames.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { GLOBE, WORLD } from '@shardkeep/shared';
import { GlobeBaseCounts } from './GlobeBaseCounts';
import { EARTH_COARSE } from '@shardkeep/shared/earthMask';
import {
  cellAtDeg, coarseCellOfFineCell, greatCircleKm, RAD_TO_DEG, sectorIdOf,
  type CountryIndex, type LandMask,
} from '@shardkeep/shared/globe';
import { api } from '../../../lib/api';
import { selectedBasePath } from '../../../lib/baseSelection';
import { bus } from '../../../lib/events';
import { useApp } from '../../../state/store';
import {
  MAPCHROME, mapChrome, useSafeAreaInsets, useWindowSize,
} from '../../layout';
import {
  chromePanGuard, IconBtn, MapSheet, MapTopBar, UnderBar, ZoomRail, type SheetState,
} from '../../mapChromeUI';
import { troopPortrait } from '../../icons';
import { Btn, COLORS as C, fmtN, Icon, Panel9, Phead, Pill, PillSub, Sp, Sprite } from '../../primitives';
import { WarzoneDetails } from '../warzoneStatus';
import {
  deedEarthCellLabel, deedHomeBeacon, deedOwnedBeacon, PixelGlobe, publicProfileInitial,
  type GlobeControl, type GlobePin, type GlobeTap,
} from './PixelGlobe';
import {
  deedFallbackImageUrl, deedImageUrl, nextParcelRuleRefreshMs, parcelActionBlockText,
  parcelShieldText, recoverDeedImage, useParcelDetail, type ParcelDetail, type ParcelScoutReport,
} from './parcelDetail';
import { countryIndexFor } from './globeRaster';
import {
  bandMix, earthChunks, EARTH_TILES, GLOBE_VIEW, parcelRadius, sectorPins, tileHomeZoom, tileLabelled, tilePx,
  type GlobeNav, type SectorCounts, type ViewBand,
} from './globeView';
import {
  exactViewportOmitsCell, prioritizeViewportMarkers, retainedSelectedViewportMarker, useValleyParcels,
  useViewportParcels, viewportContainsEarthCell, visibleParcelBounds, visibleParcelCentre,
  type ViewportParcelBounds, type ViewportParcelMarker, type ViewportParcels,
} from './parcels';
import {
  cellOwnership, degText, earthCellCentre, placeParcels, tileCountry,
  tileFacts, type CellOwnership, type CellState, type ParcelGridApi,
  type TileFacts,
} from './tiles';

// --- wire shapes (apps/api/src/game/globe.ts) --------------------------------

interface GlobeResponse {
  sectors: SectorCounts[];
  me: {
    sectorId: number | null;
    valleyId: string | null;
    parcel: { siteId: number; earthCell: number; x: number; y: number } | null;
    /** Every plotted deed owned by this wallet. `parcel` above remains the
     * selected Home; this collection must never change when bases are switched. */
    ownedParcels: GlobeOwnedParcel[];
    reachSectorIds: number[];
  };
}
export interface GlobeOwnedParcel {
  baseId: string;
  active: boolean;
  sectorId: number | null;
  valleyId: string;
  parcel: { siteId: number; earthCell: number; x: number; y: number };
  /** What the owner's own beacon shows (D-096) — viewer-private, and REQUIRED
   *  (D-097): the beacon draws exactly what the server says about the base,
   *  never a local guess from the directory or the current player's name. */
  name: string;
  avatarUrl: string | null;
  keepLevel: number;
}

/** Stable value dependency for ownership-sensitive globe reads. The directory is
 * refreshed immediately after a land purchase while this lazy layer stays mounted;
 * depending only on selected base otherwise leaves the new deed invisible until
 * the 60-second globe poll. Sorting prevents harmless response order from causing
 * extra reads. */
export function globeOwnershipFingerprint(directory: {
  bases: ReadonlyArray<{ id: string; status: string; earthCell: number | null }>;
} | null): string {
  if (!directory) return '-';
  return directory.bases
    .map((base) => `${base.id}:${base.status}:${base.earthCell ?? '-'}`)
    .sort()
    .join('|');
}
/** D-096 wire row: the bases inside one 2° coarse cell of this sector, on the
 *  counted base cell nearest their centroid. `id` is the coarse cell. */
interface SectorClusterWire {
  id: number; lon: number; lat: number; players: number; active?: number; warzone: boolean;
}
/** GET /globe/sector/:id (apps/api/src/game/globe.ts GlobeSectorResponse). Clusters
 *  only: the one-release `valleys` shape is gone (D-097) — deploy.sh drains
 *  traffic and every client reloads on the version change, so no mixed window
 *  exists in which an older server could answer this client. */
interface SectorResponse {
  id: number; name: string; clusters: SectorClusterWire[];
}

/**
 * ONE REGION-BAND PLACE as this layer draws it: an anonymous count of bases on
 * the cell the server chose from the ones they stand on. `id` is `c<coarseCell>`
 * — a string, so it can never be mistaken for a fine cell or a sector number.
 *
 * `active` IS ABSENT FOR EVERY PLACE BUT YOUR OWN — deliberately (apps/api/src/game/
 * globe.ts GlobeSectorCluster): a per-place online count anywhere on the planet is
 * an activity oracle, so the server simply does not emit one for a foreign place.
 * The type says `optional` because the WIRE says optional; declaring it `number`
 * was a type that lied, and the first formatter to trust it would render
 * "undefined" on somebody else's place.
 */
export interface SectorCluster {
  id: string;
  lon: number;
  lat: number;
  players: number;
  active?: number | undefined;
}

export interface SectorPlaces {
  id: number;
  name: string;
  clusters: SectorCluster[];
}

/**
 * The sector wire → the places this layer draws: cluster ids take their `c`
 * prefix, and an absent `active` STAYS absent (see `SectorCluster`). Pure, so the
 * presence-oracle rule is a test rather than a promise.
 */
export function normaliseSectorResponse(raw: SectorResponse): SectorPlaces {
  return {
    id: raw.id, name: raw.name,
    clusters: raw.clusters.map((c) => ({
      id: `c${c.id}`, lon: c.lon, lat: c.lat, players: c.players,
      ...(c.active !== undefined ? { active: c.active } : {}),
    })),
  };
}

/** One visible-tab request at a time. Failed one-shot chunk loads retry; polling
 * reads rearm after every settlement. Cleanup fences every late completion. */
export function startVisibleRetry<T>(
  load: () => Promise<T>,
  accept: (value: T) => void,
  intervalMs: number,
  repeatAfterSuccess: boolean,
  reject?: (error: unknown) => void,
): () => void {
  let live = true;
  let running = false;
  let done = false;
  let timer = 0;
  const schedule = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, intervalMs);
  };
  const run = (): void => {
    if (!live || running || done || document.visibilityState !== 'visible') return;
    running = true;
    void load()
      .then((value) => {
        if (!live) return;
        accept(value);
        if (!repeatAfterSuccess) done = true;
      })
      .catch((error: unknown) => { if (live) reject?.(error); })
      .finally(() => {
        running = false;
        if (live && !done && document.visibilityState === 'visible') schedule();
      });
  };
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible' || running || done) return;
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
}

/**
 * GET /globe, refetched every GLOBE.cacheSec and paused while the tab is hidden.
 *
 * The interval matches the server's snapshot TTL on purpose: polling faster than
 * the cache only buys 304s, and a backgrounded tab that keeps polling forever is
 * how 400 viewers quietly becomes 4,000 (the same rule useMapChunk follows).
 *
 * `pending` and `retry` exist because /globe CAN fail, and a failed planet used to
 * be indistinguishable from a dead button: the layer waited for data that was never
 * coming and the error it did produce was rendered inside a layer the camera had
 * left invisible. The player is now told which of the two it is, and can ask again
 * without reloading the app — `retry` re-runs the effect, so the poll interval is
 * rebuilt around the successful load rather than left ticking from the failure.
 */
function useGlobeData(): {
  data: GlobeResponse | null; error: string | null; pending: boolean; retry(): void;
} {
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const wallet = useApp((s) => s.wallet);
  const entryPaid = useApp((s) => s.entryPaid);
  const ownershipFingerprint = useApp((s) => globeOwnershipFingerprint(s.baseDirectory));
  const [data, setData] = useState<GlobeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const scopeRef = useRef({ selectedBaseId, wallet, entryPaid, ownershipFingerprint });
  useEffect(() => {
    // A wallet/base transition changes both the private `me` overlay and which
    // stable base owns the request. Never leave the previous account's home pin
    // visible while the replacement read is in flight. Manual retry and ordinary
    // poll failures retain the last good snapshot instead of blanking the planet.
    const prior = scopeRef.current;
    const scopeChanged = prior.selectedBaseId !== selectedBaseId
      || prior.wallet !== wallet
      || prior.entryPaid !== entryPaid
      || prior.ownershipFingerprint !== ownershipFingerprint;
    scopeRef.current = { selectedBaseId, wallet, entryPaid, ownershipFingerprint };
    if (scopeChanged) setData(null);
    setError(null);
    setPending(true);
    return startVisibleRetry(
      () => {
        setPending(true);
        return api.get<GlobeResponse>(selectedBasePath('/globe'));
      },
      (next) => { setData(next); setError(null); setPending(false); },
      GLOBE.cacheSec * 1_000,
      true,
      (failure) => {
        setError(failure instanceof Error ? failure.message : 'Globe unavailable');
        setPending(false);
      },
    );
  }, [attempt, selectedBaseId, wallet, entryPaid, ownershipFingerprint]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { data, error, pending, retry };
}

/** GET /globe/sector/:id for the selected sector. The response is capped at
 * GLOBE.valleysPerSectorCap server-side and refreshes on its cache cadence. */
function useSectorData(id: number | null): SectorPlaces | null {
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const wallet = useApp((s) => s.wallet);
  const entryPaid = useApp((s) => s.entryPaid);
  const ownershipFingerprint = useApp((s) => globeOwnershipFingerprint(s.baseDirectory));
  const [data, setData] = useState<SectorPlaces | null>(null);
  const cacheRef = useRef({
    scope: '',
    values: new Map<number, SectorPlaces>(),
  });
  const scopeMatches = cacheRef.current.scope
    === `${selectedBaseId ?? '-'}|${wallet ?? '-'}|${entryPaid ? 1 : 0}|${ownershipFingerprint}`;
  useEffect(() => {
    if (id === null) { setData(null); return undefined; }
    const scope = `${selectedBaseId ?? '-'}|${wallet ?? '-'}|${entryPaid ? 1 : 0}|${ownershipFingerprint}`;
    if (cacheRef.current.scope !== scope) {
      cacheRef.current = { scope, values: new Map() };
    }
    // Revisiting an exact sector after a band/pan round-trip should not erase its
    // valleys while the refresh is in flight. Scope changes clear the cache above,
    // preserving the viewer-relative `active` privacy rule.
    setData(cacheRef.current.values.get(id) ?? null);
    return startVisibleRetry(
      () => api.get<SectorResponse>(selectedBasePath(`/globe/sector/${id}`)),
      (raw) => {
        if (raw.id !== id) return;
        const next = normaliseSectorResponse(raw);
        cacheRef.current.values.set(id, next);
        setData(next);
      },
      GLOBE.cacheSec * 1_000,
      true,
    );
  }, [id, selectedBaseId, wallet, entryPaid, ownershipFingerprint]);
  if (!scopeMatches || id === null) return null;
  return data?.id === id ? data : cacheRef.current.values.get(id) ?? null;
}

/**
 * The fine (0.5°) mask, fetched the first time the REGION band is approached.
 *
 * A DYNAMIC import, and that is a budget requirement rather than a nicety: eager,
 * its ~32 KB of packed base64 would land in the entry chunk. Until it resolves the
 * coarse mask keeps drawing, so approaching the region band is never a stall and
 * never a blank frame.
 */
function useFineMask(want: boolean): LandMask | null {
  const [fine, setFine] = useState<LandMask | null>(null);
  useEffect(() => {
    if (!want || fine) return;
    return startVisibleRetry(
      () => import('@shardkeep/shared/earthMaskFine'),
      (module) => setFine(module.EARTH_FINE),
      WORLD.mapPollSec * 1_000,
      false,
    );
  }, [want, fine]);
  return fine;
}

/**
 * THE PARCEL GRID — `parcelCell(site_id, x, y)`, fetched when the parcel band opens.
 *
 * A DYNAMIC import for the same budget reason as the fine mask, and a harder one: the
 * module reaches BOTH the fine mask and the fine country index (it streams
 * `claimableCells` into patches of 491), so statically importing it here would put
 * ~40 KB of packed base64 into the globe chunk and, through `map.tsx`'s static
 * `globeView` import, put the module in a graph the first paint can see. Measured
 * first-paint delta with this shape: **0 KB** — it is absent from every counted chunk.
 *
 * Until it resolves there are no parcel pins, and that is the honest state: a parcel's
 * position IS its Earth cell now, so there is nothing provisional to draw in the
 * meantime. A transient chunk failure retries while this band is wanted and visible.
 */
function useParcelGrid(want: boolean): ParcelGridApi | null {
  const [grid, setGrid] = useState<ParcelGridApi | null>(null);
  useEffect(() => {
    if (!want || grid) return undefined;
    return startVisibleRetry(
      () => import('@shardkeep/shared/parcelGrid'),
      (module) => setGrid(module),
      WORLD.mapPollSec * 1_000,
      false,
    );
  }, [want, grid]);
  return grid;
}

/**
 * The COUNTRY INDEX for the mask in force — the same object the pixels were painted
 * from.
 *
 * It is loaded by the RASTERISER (`countryIndexFor` keys on the mask's dimensions,
 * dynamic-imports the matching generated module and refuses a resolution mismatch
 * rather than painting a lie), and this hook only subscribes to it. Two consumers,
 * one load: if the chrome imported the module itself, the tile inspector could name a
 * country the raster had not coloured yet, and after a data refresh the two could
 * disagree about what a tile is.
 *
 * `null` until it lands, and null forever if the chunk fails — the country line simply
 * does not appear, which is the same degradation as the silhouette that keeps drawing.
 */
function useCountryIndex(mask: LandMask, want: boolean): CountryIndex | null {
  const [idx, setIdx] = useState<CountryIndex | null>(null);
  useEffect(() => {
    if (!want) return undefined;
    let live = true;
    // The waiter fires when the module lands; the immediate call answers when it is
    // already in memory (the second mask, a remount, or the parcel grid having pulled
    // the same module in).
    const hit = countryIndexFor(mask, () => {
      const late = countryIndexFor(mask);
      if (live && late) setIdx(late);
    });
    setIdx(hit);
    return () => { live = false; };
  }, [mask, want]);
  // Dimensions are checked HERE as well as in the loader: `mask` can change under a
  // committed index (coarse → fine at z1.2), and a cell id read against the wrong
  // resolution is a different place entirely.
  return idx && idx.cols === mask.cols && idx.rows === mask.rows ? idx : null;
}

/**
 * `prefers-reduced-motion`, live.
 *
 * The store's REDUCE MOTION toggle is the app's own switch and reads only
 * localStorage, so an OS-level preference would otherwise be ignored — and the
 * idle spin is exactly the kind of unrequested motion that setting exists to stop.
 * Either one is enough to disable it.
 */
function usePrefersReducedMotion(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setOn(mq.matches);
    const h = (): void => setOn(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return on;
}

/**
 * THE FIVE TILE STATES, IN ONE PLACE — a word, an ink and a border, so the peek pill
 * and the inspector can never describe the same tile differently.
 *
 * `undefined` is its own answer, not a default: it means the parcel grid has not
 * loaded, so the tile's occupancy is genuinely unknown and the chrome says READING
 * rather than guessing FREE.
 */
function tileWord(state: CellState | undefined, claimable: boolean): string {
  if (!claimable) return 'NOT CLAIMABLE';
  switch (state) {
    case 'yours': return 'YOURS';
    case 'claimed': return 'CLAIMED';
    case 'free': return 'FREE';
    case 'unseated': return 'OUTSIDE ACTIVE PLAYABLE MAP';
    case 'elsewhere': return 'CHECK ON SELECTION';
    default: return 'READING…';
  }
}

function tileInk(state: CellState | undefined): string {
  return state === 'yours' ? C.goldHi : state === 'claimed' ? C.text : C.textDim;
}

/** First-land checkout already accepts an exact cell in every rollout mode.
 * Repeat purchases stay behind the server-advertised multi-base capability. */
export function earthCellChoiceEnabled(
  purchaseKind: 'entry' | 'deed' | null, additionalReservations: boolean,
): boolean {
  return purchaseKind === 'entry' || (purchaseKind === 'deed' && additionalReservations);
}

export type TilePurchaseState =
  | { kind: 'eligible'; label: 'CHOOSE THIS LAND' | 'CHECK & CHOOSE THIS LAND'; message: null }
  | { kind: 'checking' | 'blocked'; label: null; message: string };

/** One complete answer to “why can/can't I buy this tile?”. The former JSX only
 * omitted the CTA, making a claimed cell, an unseated island and a still-loading
 * roster look like the same broken button. Keep this pure because the absence of
 * a purchase action is player-facing game logic, not decoration. */
export function tilePurchaseState(
  claimable: boolean,
  ownership: CellOwnership | null,
  directoryLoaded: boolean,
  purchaseKind: 'entry' | 'deed' | null,
  additionalReservations: boolean,
): TilePurchaseState {
  if (!claimable) {
    return {
      kind: 'blocked', label: null,
      message: 'NOT PURCHASABLE · Only sovereign land can be deeded. Ocean and Antarctica are not for sale.',
    };
  }
  if (ownership === null) {
    return {
      kind: 'checking', label: null,
      message: 'CHECKING AVAILABILITY… Waiting for this tile’s map placement before offering a purchase.',
    };
  }
  if (ownership.state === 'yours') {
    return {
      kind: 'blocked', label: null,
      message: 'ALREADY YOURS · This land is already deeded to your wallet. Select its base beacon to manage it.',
    };
  }
  if (ownership.state === 'claimed') {
    return {
      kind: 'blocked', label: null,
      message: 'NOT FOR SALE · Another player already owns this deeded land.',
    };
  }
  if (ownership.state === 'unseated') {
    return {
      kind: 'blocked', label: null,
      message: 'NOT PURCHASABLE · This land cell is outside the active playable map.',
    };
  }
  if (!directoryLoaded) {
    return {
      kind: 'checking', label: null,
      message: 'CHECKING PURCHASE ACCESS… Loading your land-purchase entitlement.',
    };
  }
  if (!purchaseKind) {
    return {
      kind: 'blocked', label: null,
      message: 'PURCHASE UNAVAILABLE · The server did not offer a land-purchase rail for this wallet. Refresh and try again.',
    };
  }
  if (!earthCellChoiceEnabled(purchaseKind, additionalReservations)) {
    return {
      kind: 'blocked', label: null,
      message: 'ADDITIONAL LAND PURCHASES UNAVAILABLE · Exact-cell reservations are not enabled on this server.',
    };
  }
  return ownership.state === 'free'
    ? { kind: 'eligible', label: 'CHOOSE THIS LAND', message: null }
    : { kind: 'eligible', label: 'CHECK & CHOOSE THIS LAND', message: null };
}

/** Private wallet ownership outranks the one-valley public profile roster. A secondary
 * owned deed can legitimately look like `claimed` or `elsewhere` when the selected
 * base is elsewhere; that must never expose a buy action on the wallet's own cell. */
export function walletOwnedCellOwnership(
  cell: number | null,
  roster: CellOwnership | null,
  owned: readonly GlobeOwnedParcel[],
): CellOwnership | null {
  if (cell === null) return roster;
  const hit = owned.find((entry) => entry.parcel.earthCell === cell);
  return hit
    ? {
      state: 'yours', siteId: hit.parcel.siteId,
      x: hit.parcel.x, y: hit.parcel.y,
    }
    : roster;
}

/** The viewport endpoint is exhaustive only for public occupied deeds. An absent
 * marker stays `elsewhere` (not `free`): inactive foreign land is intentionally
 * private under D-040 and the reservation route must recheck it authoritatively. */
export function viewportCellOwnership(
  cell: number,
  grid: ParcelGridApi,
  markers: readonly ViewportParcelMarker[] | null,
): CellOwnership {
  const parcel = grid.parcelOf(cell);
  if (!parcel) return { state: 'unseated', siteId: null, x: null, y: null };
  return {
    state: markers?.some((marker) => marker.earthCell === cell) ? 'claimed' : 'elsewhere',
    siteId: parcel.siteId,
    x: parcel.x,
    y: parcel.y,
  };
}

export interface RetainedClaimedSelection {
  authority: string;
  cell: number;
}

/** Preserve claimed-detail eligibility across an unresolved/off-screen pan, but
 * revoke it when a completed current scope omits the cell or viewer authority
 * changes. The authority mismatch returns early so stale ownership from the prior
 * render cannot re-enable detail during the transition render. */
export function retainedClaimedSelection(
  prior: RetainedClaimedSelection | null,
  authority: string,
  selectedCell: number | null,
  ownership: CellOwnership | null,
  exactOmission: boolean,
): RetainedClaimedSelection | null {
  if (prior && prior.authority !== authority) return null;
  if (selectedCell === null || exactOmission) return null;
  if (ownership?.state === 'claimed') return { authority, cell: selectedCell };
  return prior?.cell === selectedCell ? prior : null;
}

/** Authenticated parcel bodies and actions require current land authority even
 * when a public marker (or private owned row) still proves the cell occupied. */
export function parcelDetailEnabled(
  entryPaid: boolean,
  selectedHomeCell: boolean,
  ownership: CellOwnership | null,
  retained: RetainedClaimedSelection | null,
  selectedCell: number | null,
): boolean {
  return entryPaid && (selectedHomeCell
    || ownership?.state === 'yours'
    || ownership?.state === 'claimed'
    || retained?.cell === selectedCell);
}

/** What the parcel band may claim about the bases in view: the viewport page's
 * own count — with the cap bit, so a capped page says "n+" rather than posing as
 * the whole window (D-097) — or the legacy one-valley roster's when the route
 * is unsupported. Never the world total. */
export function parcelScopeCount(
  viewport: Pick<ViewportParcels, 'markers' | 'truncated' | 'unsupported'>,
  legacyCount: number,
): { count: number | null; truncated: boolean } {
  if (viewport.unsupported) return { count: legacyCount, truncated: false };
  return { count: viewport.markers?.length ?? null, truncated: viewport.truncated };
}

/** The badge's one question: is a warzone live right now? Read from the globe's
 * own read — every sector carries the LIVE global window, stamped per request
 * (apps/api/src/game/globe.ts) — so the badge and the pins never disagree. */
export function globeWarzoneActive(sectors: ReadonlyArray<{ warzone: boolean }>): boolean {
  return sectors.some((s) => s.warzone);
}

// ---------------------------------------------------------------------------
// THE PEEK ROW — exactly three items, and they FIT (D-097, owner 2026-09-02)
//
// On a 390 px phone the resting sheet used to be a horizontally scrolling strip
// of up to nine pills plus a 176 px art plate, so the answer to "where am I and
// what is that" was usually off-screen to the right. It is now one context pill
// (EARTH / REGION / what is visible), one selection pill (your base, the tapped
// tile, or the region's name) and the expand caret — planned by the pure
// functions below from the strings that will actually be drawn, and MEASURED
// against the viewport in GlobeLayer.test.ts the way layout.ts's HUD_CHIP
// measures the top bar. Every transient state the row used to say with an extra
// pill (no planet, reading, finding your parcel, no parcel yet) is folded into
// one of the two pills instead, so nothing is ever a scroll away.
// ---------------------------------------------------------------------------

/** The peek pill as a measurable chip: VT323 is fixed-width, so a pill is a
 *  frame plus one advance per glyph (layout.ts HUD_CHIP is the same model for
 *  the top bar). Pill: 4 + 8 px padding, 2 px border each side; 18 px main, 14 px
 *  sub, 5 px gap between them; the caret is one 44 px control. Render metrics,
 *  not game numbers. */
export const PEEK_CHIP = { base: 16, mainCharW: 7.2, subCharW: 5.6, gap: 5, caret: MAPCHROME.tap } as const;

export type PeekTone = 'plain' | 'gold' | 'danger' | 'dim';

export interface PeekPill {
  main: string;
  sub: string | null;
  tone: PeekTone;
  /** Which span gives way when the pill is wider than its slot. The primary
   *  answer never does — a cell number or a coordinate cut short is a lie — so a
   *  pill whose main is the answer clamps its sub, and a pill whose main is an
   *  unbounded name (a country, a region) clamps that. */
  clamp: 'main' | 'sub';
  /** Gold border: the region holds a Keep the viewer may attack (D-099) — the
   *  same highlight the pin's ring gives, spending no width on a fourth item. */
  ring?: boolean;
  /** A pill that is also the one action its state needs. */
  action?: 'retry' | 'buy-land';
}

/** Rendered width of a peek pill, from the strings it will draw. */
export function peekPillW(pill: Pick<PeekPill, 'main' | 'sub'>): number {
  return PEEK_CHIP.base + pill.main.length * PEEK_CHIP.mainCharW
    + (pill.sub ? PEEK_CHIP.gap + pill.sub.length * PEEK_CHIP.subCharW : 0);
}

export interface PeekContextInput {
  view: ViewBand;
  /** /globe has answered. */
  loaded: boolean;
  error: string | null;
  pending: boolean;
  worldBases: number;
  /** The region under focus at the REGION band; null when none is. */
  region: { bases: number; inReach: boolean } | null;
  /** The parcel band's count (`parcelScopeCount`). */
  visible: { count: number | null; truncated: boolean };
}

/** THE CONTEXT PILL: what the world, the region or the window holds — or, until
 *  the planet has answered, that it has not (and how to ask again). */
export function globePeekContext(i: PeekContextInput): PeekPill {
  if (!i.loaded) {
    // The planet's own state comes first and is never a scroll away: a failure
    // the player had to scroll sideways to discover was barely better than the
    // silent no-op it replaced, and the pill IS the retry.
    if (i.error) {
      return {
        main: 'NO PLANET', sub: i.pending ? 'RETRYING…' : 'TAP TO RETRY',
        tone: 'danger', clamp: 'sub', action: 'retry',
      };
    }
    return { main: 'READING', sub: 'THE PLANET…', tone: 'dim', clamp: 'sub' };
  }
  if (i.view === 'parcel') {
    // An em dash until the window has answered — a hard 0 would claim an empty
    // window rather than an unknown one — and a "+" whenever the server's marker
    // cap bit: the drawn bases are the nearest, not all of them.
    const n = i.visible.count === null ? '—' : `${fmtN(i.visible.count)}${i.visible.truncated ? '+' : ''}`;
    return { main: n, sub: 'VISIBLE', tone: 'plain', clamp: 'sub' };
  }
  if (i.view === 'region' && i.region) {
    return {
      main: 'REGION', sub: `${fmtN(i.region.bases)} BASES`, tone: 'plain', clamp: 'sub',
      ring: i.region.inReach,
    };
  }
  return { main: 'EARTH', sub: `${fmtN(i.worldBases)} BASES`, tone: 'plain', clamp: 'sub' };
}

export interface PeekSelectionInput {
  view: ViewBand;
  home: HomeState;
  /** The tapped tile, identified, with its ownership word. */
  selected: { lon: number; lat: number; cell: number; state: CellState | undefined; claimable: boolean } | null;
  /** Owned bases in the window or in focus (`ownedViewportCue`), and the one
   *  cell when there is exactly one. */
  ownedCue: number;
  ownedCell: number | null;
  /** The region's name from the sector read, if it has answered. */
  region: string | null;
  /** The country under the crosshair — the label ladder's middle rung, which
   *  lives in the chrome because a 5–22 px tile cannot carry text. */
  country: string | null;
  /** Whether a tile is a full 44 px target at this zoom (`tileLabelled`). */
  aimLive: boolean;
}

/** THE SELECTION PILL: your base, the tile you tapped, or the name of where you
 *  are — with the MY PARCEL press's three answers taking the slot while they are
 *  live, because a press that is visibly doing nothing is the silent no-op it
 *  used to be. */
export function globePeekSelection(i: PeekSelectionInput): PeekPill {
  if (i.home === 'seeking') return { main: 'FINDING…', sub: 'YOUR PARCEL', tone: 'dim', clamp: 'sub' };
  if (i.home === 'noparcel') {
    return { main: 'NO PARCEL', sub: 'BUY LAND', tone: 'gold', clamp: 'sub', action: 'buy-land' };
  }
  if (i.home === 'unplaceable') return { main: 'PARCEL', sub: 'NOT ON THE MAP', tone: 'danger', clamp: 'sub' };
  if (i.selected) {
    if (i.selected.state === 'yours') {
      return { main: `CELL ${i.selected.cell}`, sub: 'YOUR BASE', tone: 'gold', clamp: 'sub' };
    }
    return {
      main: degText(i.selected.lon, i.selected.lat),
      sub: tileWord(i.selected.state, i.selected.claimable),
      tone: i.selected.state === 'claimed' ? 'plain' : 'dim',
      clamp: 'sub',
    };
  }
  if (i.view === 'parcel' && i.ownedCue > 0) {
    return i.ownedCue === 1 && i.ownedCell !== null
      ? { main: `CELL ${i.ownedCell}`, sub: 'YOUR BASE', tone: 'gold', clamp: 'sub' }
      : { main: String(i.ownedCue), sub: 'YOUR BASES', tone: 'gold', clamp: 'sub' };
  }
  if (i.view === 'globe') return { main: 'TAP A REGION', sub: null, tone: 'dim', clamp: 'main' };
  // A TILE IS 55 km ACROSS AND THAT IS THE POINT: below 44 px the honest cue is
  // that the finger is bigger than the county, and it rides the name rather
  // than costing a pill of its own.
  const sub = i.view === 'parcel' && !i.aimLive ? 'PINCH IN TO AIM' : i.country ? 'CROSSHAIR' : 'REGION';
  return { main: i.country ?? i.region ?? 'EARTH', sub, tone: 'plain', clamp: 'main' };
}

export interface PeekRowPlan {
  /** Content width between the band's side paddings. */
  inner: number;
  contextW: number;
  /** The selection pill's natural width, and the slot it is clamped into. */
  selectionW: number;
  selectionMaxW: number;
  /** Width the three items occupy, gaps included. Must be ≤ inner. */
  used: number;
  fits: boolean;
}

/** Solve the row for a viewport: the context pill and the caret are fixed, the
 *  selection pill takes what is left and clamps (`PeekPill.clamp`) inside it, so
 *  the row can never scroll — which is the whole point of three items. */
export function globePeekRow(vw: number, context: PeekPill, selection: PeekPill): PeekRowPlan {
  const inner = Math.max(0, vw - MAPCHROME.pad * 2);
  const contextW = peekPillW(context);
  const fixed = contextW + MAPCHROME.gap * 2 + PEEK_CHIP.caret;
  const selectionMaxW = Math.max(0, inner - fixed);
  const selectionW = peekPillW(selection);
  const used = fixed + Math.min(selectionW, selectionMaxW);
  return { inner, contextW, selectionW, selectionMaxW, used, fits: used <= inner };
}

export function ownedViewportCue(
  owned: readonly GlobeOwnedParcel[],
  bounds: readonly ViewportParcelBounds[],
  selectedCell: number | null,
): GlobeOwnedParcel[] {
  return owned.filter((entry) => entry.parcel.earthCell === selectedCell
    || viewportContainsEarthCell(entry.parcel.earthCell, bounds));
}

/** Selection changes presentation only. During the brief directory/globe handoff
 * where no stable selection is installed yet, the server-selected Home cell is the
 * compatibility fallback; once `selectedBaseId` exists it is the sole pulse owner. */
export function ownedParcelSelected(
  owned: GlobeOwnedParcel,
  selectedBaseId: string | null,
  selectedHomeCell: number | null,
): boolean {
  return selectedBaseId !== null
    ? owned.baseId === selectedBaseId
    : owned.parcel.earthCell === selectedHomeCell;
}

export interface ParcelClusterContext {
  id: string;
  lon: number;
  lat: number;
  /** The patch the wallet-private owned fallback owns — what the /map
   *  compatibility roster (`useValleyParcels`) needs. A public cluster never
   *  carries one: it spans patches. */
  siteId?: number | undefined;
}

/** Resolve the focused region-band place from the public capped cluster list,
 * falling back to the wallet-private owned deed (keyed by its valley id, the
 * /map compatibility roster's key). Unlimited ownership means one wallet can own
 * more places in a busy sector than the public cap can carry; exact beacon focus
 * must still have the stable site needed by that roster. */
export function parcelClusterContext(
  placeId: string | null,
  publicClusters: ReadonlyArray<ParcelClusterContext>,
  owned: readonly GlobeOwnedParcel[],
): ParcelClusterContext | null {
  if (!placeId) return null;
  const publicHit = publicClusters.find((cluster) => cluster.id === placeId);
  if (publicHit) return publicHit;
  const privateHit = owned.find((entry) => entry.valleyId === placeId);
  if (!privateHit) return null;
  const at = earthCellCentre(privateHit.parcel.earthCell);
  return at
    ? {
      id: privateHit.valleyId,
      siteId: privateHit.parcel.siteId,
      lon: at.lon,
      lat: at.lat,
    }
    : null;
}

/** One rail slot, with a truthful job for both kinds of player. While the private
 * globe overlay is still loading we retain MY PARCEL (and its visible seeking
 * state); once it proves there is no parcel, the same slot becomes the way into
 * exact-cell browsing instead of offering a Home destination that cannot exist. */
export function globeHomeControl(
  globeLoaded: boolean,
  hasParcel: boolean,
): { action: 'home' | 'choose-land'; label: 'MY PARCEL' | 'CHOOSE LAND' } {
  return globeLoaded && !hasParcel
    ? { action: 'choose-land', label: 'CHOOSE LAND' }
    : { action: 'home', label: 'MY PARCEL' };
}

/** Keep a deedless player's current populated region. Only an empty camera
 * context falls back to the busiest public region (stable id tie-break). */
export function chooseLandSector(
  sectors: readonly SectorCounts[],
  currentSectorId: number | null,
): SectorCounts | null {
  const current = sectors.find((sector) => (
    sector.id === currentSectorId && sector.valleys > 0
  ));
  if (current) return current;
  let target: SectorCounts | null = null;
  for (const candidate of sectors) {
    if (candidate.valleys === 0) continue;
    if (!target || candidate.players > target.players
      || (candidate.players === target.players && candidate.id < target.id)) target = candidate;
  }
  return target;
}

/** An empty world still contains every mapped Earth parcel. Read the existing
 * deterministic geography, independent of whether any valley/base exists yet.
 * Preserve an explicit chosen cell before looking for nearby selectable land. */
export function chooseLandGround(
  grid: { patchCount(): number; patchCells(siteId: number): Int32Array; parcelOf(cell: number): unknown },
  lon: number, lat: number, preferredCell: number | null,
): { cell: number; lon: number; lat: number } | null {
  if (preferredCell !== null && grid.parcelOf(preferredCell)) {
    const at = earthCellCentre(preferredCell);
    if (at) return { cell: preferredCell, ...at };
  }
  let target: { cell: number; lon: number; lat: number } | null = null;
  let nearest = Infinity;
  for (let siteId = 0; siteId < grid.patchCount(); siteId++) {
    for (const cell of grid.patchCells(siteId)) {
      const at = earthCellCentre(cell);
      if (!at) continue;
      const distance = greatCircleKm(lon, lat, at.lon, at.lat);
      if (distance < nearest) { nearest = distance; target = { cell, ...at }; }
    }
  }
  return target;
}

/**
 * WHAT THE MY PARCEL PRESS IS WAITING FOR, as a state the chrome can say out loud.
 *
 * `seeking` — the press has been accepted and the flight is waiting on data.
 * `noparcel` — /globe says this player owns no plot: there is nothing to fly to,
 *   and the honest answer is the one thing that changes it.
 * `unplaceable` — the server supplied an invalid frozen address, so the client
 *   refuses to invent a replacement location.
 */
type HomeState = 'off' | 'seeking' | 'noparcel' | 'unplaceable';

type HomeContextTransition =
  | { kind: 'switch-sector'; sectorId: number }
  | { kind: 'wait-for-cluster' }
  | { kind: 'select'; clusterId: string | null };

/**
 * Move between parcel contexts in an ORDERED transition.
 *
 * A sector change deliberately clears the old place and selected cell (the effect
 * beside those states below). Writing all three in one render therefore loses the
 * new place/cell when home is in another sector. The home intent now asks this
 * reducer for exactly one safe next step: switch sector, wait until that sector's
 * authoritative place list arrives, then select. Exported only so the ordering
 * invariant has a non-renderer regression test.
 *
 * `homeClusterId` is the cluster holding Home's cell, or null when nothing needs
 * to be waited for (the viewport band is camera-driven and needs no place to be
 * chosen). The wait is safe: the server admits the viewer's own clusters into
 * the capped list first (apps/api/src/game/globe.ts `admit`), so the home
 * cluster is in the list the moment the sector answers.
 */
export function homeContextTransition(
  homeSectorId: number | null,
  homeClusterId: string | null,
  activeSectorId: number | null,
  loadedSectorId: number | null,
  loadedClusterIds: readonly string[],
): HomeContextTransition {
  if (homeSectorId !== null && activeSectorId !== homeSectorId) {
    return { kind: 'switch-sector', sectorId: homeSectorId };
  }
  if (homeSectorId !== null && homeClusterId !== null
    && (loadedSectorId !== homeSectorId || !loadedClusterIds.includes(homeClusterId))) {
    return { kind: 'wait-for-cluster' };
  }
  return { kind: 'select', clusterId: homeClusterId };
}

/**
 * The public map context directly under the camera.
 *
 * Sector and cluster reads land on different turns. Returning the sector even when
 * its list is not loaded lets the caller start that request; returning the
 * nearest cluster only when the list belongs to that exact sector prevents an old
 * response from being adopted after a fast pan. Calling this again when the list
 * arrives is the missing half that makes ordinary zooming sufficient — no Home
 * press or second camera gesture is needed to reveal its bases.
 *
 * The adopted cluster is a focus, nothing more: the parcel band is drawn from the
 * camera's viewport.
 */
export function cameraBrowseContext(
  lon: number,
  lat: number,
  wantParcels: boolean,
  loadedSectorId: number | null,
  loadedClusters: ReadonlyArray<{ id: string; lon: number; lat: number }>,
): { sectorId: number; clusterId: string | null } {
  const sectorId = sectorIdOf(lon, lat);
  if (!wantParcels || loadedSectorId !== sectorId) return { sectorId, clusterId: null };
  let clusterId: string | null = null;
  let bestKm = Infinity;
  for (const cluster of loadedClusters) {
    const km = greatCircleKm(lon, lat, cluster.lon, cluster.lat);
    if (km < bestKm || (km === bestKm && (clusterId === null || cluster.id < clusterId))) {
      bestKm = km;
      clusterId = cluster.id;
    }
  }
  return { sectorId, clusterId };
}

export function stickyParcelCluster(
  current: string | null,
  nearest: string | null,
): string | null {
  return current ?? nearest;
}

/** The region-band cluster the viewer's Home cell belongs to, named from the deed
 *  cell alone (D-097): the id grammar is `c<coarseCell>`, the same integer math
 *  the server buckets by, so there is nothing to wait for before naming it. */
export function homeClusterIdFor(parcel: { earthCell: number } | null | undefined): string | null {
  return parcel ? `c${coarseCellOfFineCell(parcel.earthCell)}` : null;
}

export interface GlobeLayerProps {
  /**
   * Bumped every time the board's GLOBE button is pressed. A COUNTER, not a
   * boolean, because the layer is never unmounted: "open the globe" has to be an
   * event the layer can replay, and a boolean that is already true says nothing.
   */
  openSeq: number;
}

const ELLIPSIS: CSSProperties = {
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
};

/** One peek pill as `globePeekRow` planned it: the clamped span ellipsises inside
 *  `maxWidth`, the other never shrinks. Hook-free, like every chrome wrapper. */
function PeekPillView({ pill, maxWidth, onClick, ariaLabel }: {
  pill: PeekPill; maxWidth?: number | undefined;
  onClick?: (() => void) | undefined; ariaLabel?: string | undefined;
}): React.JSX.Element {
  const ink = pill.tone === 'gold' ? C.goldHi
    : pill.tone === 'danger' ? C.danger
      : pill.tone === 'dim' ? C.textDim : C.text;
  const accent = pill.ring || pill.tone === 'gold' ? C.gold
    : pill.tone === 'danger' ? C.danger : undefined;
  return (
    <Pill accent={accent} aria-label={ariaLabel} {...(onClick ? { onClick } : {})}
      style={{ flex: 'none', minWidth: 0, ...(maxWidth !== undefined ? { maxWidth } : {}) }}>
      <span style={{ color: ink, whiteSpace: 'nowrap', ...(pill.clamp === 'main' ? ELLIPSIS : { flex: 'none' }) }}>
        {pill.main}
      </span>
      {pill.sub && (
        <PillSub style={{ whiteSpace: 'nowrap', ...(pill.clamp === 'sub' ? ELLIPSIS : { flex: 'none' }) }}>
          {pill.sub}
        </PillSub>
      )}
    </Pill>
  );
}

function SelectedPlayerAvatar({ url, name }: { url: string | null; name: string }): React.JSX.Element {
  return (
    <div style={{
      position: 'relative', width: 46, height: 46, flex: 'none', overflow: 'hidden',
      border: `2px solid ${C.goldDp}`, background: C.ink,
    }}>
      <Sprite name={troopPortrait('highlander')} w={42} h={42}
        style={{ position: 'absolute', left: 0, top: 0 }} />
      {url && <img key={url} src={url} alt={`${name} avatar`} loading="lazy"
        onLoad={(event) => { event.currentTarget.hidden = false; }}
        onError={(event) => { event.currentTarget.hidden = true; }}
        style={{
          position: 'absolute', inset: 0, width: 42, height: 42,
          objectFit: 'cover', imageRendering: 'pixelated',
        }} />}
    </div>
  );
}

/** A selected deed is identity-bearing and fresh, so it may show the precise
 * protection deadline. The interval lives in this leaf: the planet canvas does
 * not re-render once per second merely to tick one label. */
function SelectedShieldStatus({ detail, onExpire }: {
  detail: Pick<ParcelDetail, 'shield' | 'shielded' | 'warzone'>;
  onExpire(): void;
}): React.JSX.Element {
  const deadline = detail.shield?.expiresAt ?? null;
  const remainingMs = Math.max(0, detail.shield?.remainingMs ?? 0);
  const fingerprint = `${deadline ?? ''}:${remainingMs}:${detail.shield?.active === true}:${detail.shield?.suppressedByWarzone === true}`;
  const anchorRef = useRef({ fingerprint: '', at: 0, serverNow: 0 });
  if (anchorRef.current.fingerprint !== fingerprint) {
    anchorRef.current = {
      fingerprint,
      at: performance.now(),
      serverNow: deadline ? Date.parse(deadline) - remainingMs : 0,
    };
  }
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!deadline || (!detail.shield.active && !detail.shield.suppressedByWarzone)) return undefined;
    const tick = (): void => {
      const next = Math.max(0, performance.now() - anchorRef.current.at);
      setElapsed(next);
    };
    if (remainingMs === 0) return undefined;
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline, detail.shield.active, detail.shield.suppressedByWarzone, fingerprint, remainingMs]);
  const ruleRefreshMs = nextParcelRuleRefreshMs(detail);
  const ruleBoundaryKey = `${detail.warzone.boundaryAt ?? ''}:${detail.warzone.remainingMs ?? ''}:${deadline ?? ''}:${remainingMs}`;
  const refreshedRuleBoundary = useRef<string | null>(null);
  useEffect(() => {
    if (ruleRefreshMs === null || refreshedRuleBoundary.current === ruleBoundaryKey) return undefined;
    if (ruleRefreshMs === 0) {
      refreshedRuleBoundary.current = ruleBoundaryKey;
      onExpire();
      return undefined;
    }
    const timer = window.setTimeout(() => {
      refreshedRuleBoundary.current = ruleBoundaryKey;
      onExpire();
    }, ruleRefreshMs + 250);
    return () => window.clearTimeout(timer);
  }, [onExpire, ruleBoundaryKey, ruleRefreshMs]);
  const protectedNow = detail.shield?.active ?? detail.shielded;
  const suppressed = detail.shield?.suppressedByWarzone === true;
  const now = anchorRef.current.serverNow + elapsed;
  return (
    <div role="status" style={{
      color: suppressed ? C.goldHi : protectedNow ? C.sky : C.success,
      fontSize: 14, marginTop: 3,
    }}>
      {parcelShieldText(detail.shield, detail.shielded, now)}
    </div>
  );
}

export function GlobeLayer({ openSeq }: GlobeLayerProps): React.JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  const baseDirectory = useApp((s) => s.baseDirectory);
  const purchaseKind = baseDirectory?.nextLandPurchaseKind ?? null;
  const cellReservations = baseDirectory?.capabilities.cellReservations === true;
  const setLandPurchase = useApp((s) => s.setLandPurchase);
  const setMapTab = useApp((s) => s.setMapTab);
  const setRaidTarget = useApp((s) => s.setRaidTarget);
  const setScoutReport = useApp((s) => s.setScoutReport);
  const viewerWallet = useApp((s) => s.wallet);
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const entryPaid = useApp((s) => s.entryPaid);
  const reduceMotionPref = useApp((s) => s.reduceMotion);
  const reduceMotionOs = usePrefersReducedMotion();
  const reduceMotion = reduceMotionPref || reduceMotionOs;
  const layerRef = useRef<HTMLDivElement>(null);
  const ctl = useRef<GlobeControl | null>(null);

  const win = useWindowSize();
  const inset = useSafeAreaInsets();
  const box = { w: win.w - inset.left - inset.right, h: win.h - inset.top - inset.bottom };

  // The camera as REACT sees it: coarse commits only (gesture end, tween end, band
  // change). The live camera lives in PixelGlobe's ref and never re-renders this.
  const [nav, setNav] = useState<GlobeNav>({ lam0: 0, phi0: 0.35, zoom: GLOBE.zoomMin });
  const mix = bandMix(nav.zoom);

  const { data: globe, error, pending, retry } = useGlobeData();
  const ownedParcels = useMemo(
    () => globe?.me.ownedParcels ?? [],
    [globe],
  );
  const [sectorId, setSectorId] = useState<number | null>(null);
  const sector = useSectorData(sectorId);
  /**
   * WHICH GENERATED EARTH CHUNKS THIS CAMERA MAY FETCH — one predicate, in
   * globeView, so "flag off downloads nothing new" is a test and not a promise.
   *
   * It used to be three separate camera reads, and the GLOBE open animation seeds the
   * camera at `GLOBE.localZoom` before tweening out — so `wantParcels` committed true
   * for a frame and 13.1 KB gzip of `parcelGrid` + `earthCountriesFine` was fetched on
   * every globe open with the flag UNSET (adversarial pass D5, 2026-08-10).
   */
  const chunks = earthChunks(mix);
  const fine = useFineMask(chunks.fineMask);
  const mask = mix.wantFineMask && fine ? fine : EARTH_COARSE;
  const countries = useCountryIndex(mask, chunks.countryIndex);

  // --- the PARCEL band ------------------------------------------------------
  /** The region-band place in focus: tapped, or adopted from the camera. On a
   *  D-096 server it is a cluster and only a focus (the band draws the camera's
   *  viewport); on an older server it is the valley whose legacy roster is read. */
  const [parcelClusterId, setParcelClusterId] = useState<string | null>(null);
  /**
   * THE SELECTED TILE, as a FINE-mask cell id and nothing else.
   *
   * It was `{ x, y, mine }` — a plot coordinate, which could only ever name a tile
   * somebody already owned. A cell can name any of the ~61,900 claimable tiles, the
   * ~2,832 no valley seats, the sea and Antarctica, so "tap a tile and read what it
   * is" became possible the moment the selection stopped being a roster row. Ownership
   * is DERIVED from it (`cellOwnership`), never stored beside it, so the two can never
   * disagree.
   */
  const [selCell, setSelCell] = useState<number | null>(() => useApp.getState().landPurchase?.earthCell ?? null);
  const [ownedFocus, setOwnedFocus] = useState<GlobeOwnedParcel | null>(null);
  const ownedFocusRef = useRef<GlobeOwnedParcel | null>(null);
  const parcelBounds = useMemo(
    () => mix.wantParcels
      ? visibleParcelBounds(nav, { width: win.w, height: win.h })
      : [],
    [mix.wantParcels, nav.lam0, nav.phi0, nav.zoom, win.h, win.w],
  );
  /** The visible centre the server orders its capped page by (D-097). React's
   *  committed camera, like the bounds: it moves on gesture boundaries, never per
   *  frame, so it cannot spend a request a settle did not. */
  const viewportCentre = useMemo(
    () => (mix.wantParcels ? visibleParcelCentre(nav) : null),
    [mix.wantParcels, nav.lam0, nav.phi0],
  );
  const viewportParcels = useViewportParcels(parcelBounds, mix.wantParcels, viewportCentre);
  const viewportAuthority = `${selectedBaseId ?? '-'}|${viewerWallet ?? '-'}|${entryPaid ? 1 : 0}`;
  const selectedViewportMarkerRef = useRef<{
    authority: string; marker: ViewportParcelMarker;
  } | null>(null);
  const exactViewportOmittedSelection = exactViewportOmitsCell(
    viewportParcels,
    parcelBounds,
    selCell,
  );
  if (selectedViewportMarkerRef.current?.authority !== viewportAuthority
    || viewportParcels.unsupported) {
    selectedViewportMarkerRef.current = null;
  }
  const selectedViewportMarker = retainedSelectedViewportMarker(
    viewportParcels.markers,
    selectedViewportMarkerRef.current?.marker ?? null,
    selCell,
    exactViewportOmittedSelection,
  );
  if (selectedViewportMarker) {
    selectedViewportMarkerRef.current = {
      authority: viewportAuthority,
      marker: selectedViewportMarker,
    };
  } else {
    selectedViewportMarkerRef.current = null;
  }
  const retainedSelectedMarker = selectedViewportMarkerRef.current?.marker ?? null;
  const viewportMarkersForRender = useMemo(() => {
    const current = [...(viewportParcels.markers ?? [])];
    if (retainedSelectedMarker
      && !current.some((marker) => marker.earthCell === retainedSelectedMarker.earthCell)) {
      current.push(retainedSelectedMarker);
    }
    return current;
  }, [retainedSelectedMarker, viewportParcels.markers]);
  // Rolling deploy only: an explicit unsupported-route response activates the
  // former one-valley roster. A transient current-API failure must not silently
  // shrink the visible world to whichever valley happens to be nearest.
  const parcels = useValleyParcels(
    parcelClusterId,
    mix.wantParcels && viewportParcels.unsupported,
  );
  const grid = useParcelGrid(chunks.parcelGrid);
  // A new REGION invalidates only its focused place. The exact selected Earth cell
  // is independent of camera scope and must remain stable through a pan.
  useEffect(() => { setParcelClusterId(null); }, [sectorId]);
  /**
   * THE SECTOR'S CLUSTERS, EACH AT THE CENTROID OF THE BASES IT COUNTS (D-096).
   *
   * Display coordinates are consumed once and never inverted: a centroid is not an
   * identity, and the old client's inversion of a seated pin into a site id is what
   * once turned production site 0 into invalid site 43,456.
   */
  const clusters = useMemo(() => sector?.clusters ?? [], [sector]);
  const parcelCluster = useMemo(
    () => parcelClusterContext(parcelClusterId, clusters, ownedParcels),
    [ownedParcels, parcelClusterId, clusters],
  );
  /** Which patch of Earth a LEGACY valley-shaped place owns — persisted
   *  `valleys.site_id`; null for a D-096 cluster, which spans patches. */
  const parcelSiteId = parcelCluster?.siteId ?? null;
  /**
   * THE PARCELS, ON REAL GROUND. This is the line the owner rejected, replaced: every
   * pin used to be handed its VALLEY's lon/lat and then displaced on a screen-space
   * lattice, which is why they floated over the ocean. `null` while any input is still
   * loading, `[]` when Earth's patch stream cannot seat this valley at all — the
   * chrome tells those two apart and says which.
   */
  const placed = useMemo(
    () => (parcelSiteId !== null && grid && fine && parcels
      ? placeParcels(parcels.rows, parcelSiteId, grid, fine)
      : null),
    [parcelSiteId, grid, fine, parcels],
  );
  /** Read by `onNav`, which is deliberately identity-stable (it is a PixelGlobe
   *  prop and must not re-render the canvas on every sector load). The response id
   *  travels with the rows so a late sector cannot be adopted under a new camera. */
  const adoptRef = useRef<{
    sectorId: number | null;
    clusters: ReadonlyArray<{ id: string; lon: number; lat: number }>;
  }>({ sectorId: null, clusters: [] });
  adoptRef.current = { sectorId: sector?.id ?? null, clusters };

  const [sheet, setSheet] = useState<SheetState>('peek');
  const [sheetH, setSheetH] = useState<number>(MAPCHROME.peek);
  const [warzoneOpen, setWarzoneOpen] = useState(false);

  /** Where the viewer lives. Their frozen deed cell is available in the private
   *  `/globe` response before either sector or cluster lists load, so zooming can
   *  no longer make home disappear. The home sector's served position is the
   *  fallback for a deedless response; a home sector the planet served no pin
   *  for is unknown, never guessed from its geometric centre (D-097). */
  const homeAt = useMemo<{ lon: number; lat: number } | null>(() => {
    const parcel = EARTH_TILES ? globe?.me.parcel : null;
    const deed = parcel ? earthCellCentre(parcel.earthCell) : null;
    if (deed) return deed;
    if (globe?.me.sectorId === null || globe?.me.sectorId === undefined) return null;
    const pin = globe.sectors.find((s) => s.id === globe.me.sectorId);
    return pin ? { lon: pin.lon, lat: pin.lat } : null;
  }, [globe]);

  // --- open: pull OUT from the local map -----------------------------------
  // The button says GLOBE and the gesture it implies is zooming out, so that is
  // literally what happens: seed the camera at the local band over the viewer's
  // own valley, then tween to the whole planet. The local map fades away under it.
  const seqRef = useRef(0);
  /** The open animation started before /globe had said where the player lives, so
   *  it still owes them the rotation home. See the effect below. */
  const oweHomeRef = useRef(false);
  const openedRef = useRef(false);
  const beginOpen = useCallback(() => {
    if (openedRef.current || openSeq <= 0 || !ctl.current) return;
    openedRef.current = true;
    const at = homeAt ?? { lon: 0, lat: 20 };
    oweHomeRef.current = homeAt === null;
    ctl.current.set({ lam0: at.lon / RAD_TO_DEG, phi0: at.lat / RAD_TO_DEG, zoom: GLOBE.localZoom });
    ctl.current.tweenTo(at.lon, at.lat, GLOBE.zoomMin);
    setSheet('peek');
  }, [homeAt, openSeq]);
  useEffect(() => {
    if (openSeq === seqRef.current) return;
    seqRef.current = openSeq;
    // THE PRESS ALWAYS DOES SOMETHING. (fixed 2026-08-09)
    //
    // This used to `return` while `globe` was null — WITHOUT recording the seq — so a
    // GLOBE press during a /globe hiccup was a silent no-op forever: the layer mounts
    // at the local band (earth 0, `visibility: hidden`), nothing moved the camera off
    // it, and the only error message in the file was rendered INSIDE that invisible
    // layer. A dead button and no explanation.
    //
    // Now the pull-out is unconditional. When `homeAt` is known it starts over the
    // player's own valley exactly as before; when it is not, it starts over a neutral
    // hemisphere and `oweHomeRef` re-targets the tween the moment /globe answers —
    // which, on a healthy server, is inside the pull-out's own 420 ms, so the two
    // reads as one continuous move rather than a snap. If /globe never answers the
    // player still gets the planet, plus a visible, retryable error in the sheet.
    openedRef.current = false;
    beginOpen();
    // PixelGlobe installs its imperative handle in an effect after this parent
    // effect. One animation frame retries the same open event; without it the
    // new globe-first mount can stay invisible because optional chaining made
    // the only camera command a no-op.
    const frame = window.requestAnimationFrame(beginOpen);
    return () => window.cancelAnimationFrame(frame);
  }, [openSeq, beginOpen]);

  // The other half of that: finish the open once the planet finally arrives. Only
  // while the camera is still untouched — a player who has already started spinning
  // owns it, and yanking them home would be worse than not knowing where home is.
  // This is also what makes a RETRY recover without a reload: the pins appear (they
  // are derived from `globe`) and the camera lands where the player lives.
  useEffect(() => {
    if (!oweHomeRef.current || !homeAt || seqRef.current === 0) return;
    oweHomeRef.current = false;
    if (ctl.current?.interacted()) return;
    ctl.current?.tweenTo(homeAt.lon, homeAt.lat, GLOBE.zoomMin);
  }, [homeAt]);

  // --- pins ----------------------------------------------------------------
  const pins = useMemo<GlobePin[]>(() => {
    const out: GlobePin[] = [];
    if (globe) {
      for (const s of sectorPins(globe.sectors, globe.me.reachSectorIds, globe.me.sectorId)) {
        out.push({
          key: `s${s.id}`, layer: 'sector', lon: s.lon, lat: s.lat, r: s.r,
          ring: s.ring, mine: s.mine,
        });
      }
    }
    // THE REGION LAYER — one pin per CLUSTER, at the centroid of the bases it counts
    // (D-096). Tapping one zooms to that centroid, where the parcel band takes over
    // with the bases that are actually there.
    const homeCluster = homeClusterIdFor(globe?.me.parcel);
    for (const c of clusters) {
      out.push({
        key: c.id, layer: 'valley', lon: c.lon, lat: c.lat,
        r: Math.max(4, Math.min(11, 4 + Math.log2(1 + c.players) * 1.4)),
        // No ring at cluster level: reach is answered PER SECTOR by the server, and
        // ringing every cluster in a reachable sector would claim knowledge the
        // payload does not carry. `mine` is a client-side id comparison — the
        // response deliberately has no isMine field — and only inside the home
        // sector, because a straddling coarse cell shows up under its neighbour
        // with THAT sector's share of bases.
        ring: false,
        mine: sector?.id === globe?.me.sectorId && c.id === homeCluster,
        // This remains a navigation aggregate, not a named player place: a count of
        // bases on the ground the pin stands on. Selecting it zooms the same globe
        // toward those Earth cells.
        label: `${c.players} BASES`,
      });
    }
    // THE PARCEL LAYER — one pin per occupied plot, EACH ON ITS OWN EARTH CELL.
    //
    // `lon`/`lat` used to be the VALLEY's site for all ~491 of them, with PixelGlobe
    // spreading them on a screen-space lattice from the live camera. That is the
    // fiction the owner rejected and it is gone: `placeParcels` resolves each plot
    // through `parcelCell(site_id, x, y)` to one claimable 0.5° land cell and hands
    // over that cell's centre, so a pin cannot be in the water by construction.
    //
    // Public names are label REQUESTS, not guaranteed labels: PixelGlobe applies
    // the existing zoom, collision and per-frame budget before drawing any of them.
    const drewOwned = new Set<string>();
    let drewLegacyHome = false;
    for (const marker of prioritizeViewportMarkers(viewportMarkersForRender, selCell)) {
      const at = earthCellCentre(marker.earthCell);
      if (!at) continue;
      const owned = ownedParcels.find(
        (entry) => entry.parcel.earthCell === marker.earthCell,
      );
      const selected = owned
        ? ownedParcelSelected(owned, selectedBaseId, globe?.me.parcel?.earthCell ?? null)
        : false;
      if (owned) {
        drewOwned.add(owned.baseId);
        const beacon = deedOwnedBeacon(owned, at, selected);
        out.push({
          ...beacon,
          r: parcelRadius(marker.keepLevel),
          keepLevel: marker.keepLevel,
          label: marker.name || beacon.label,
          avatarUrl: marker.avatarUrl,
          profileInitial: publicProfileInitial(marker.name),
        });
        continue;
      }
      const persistent = marker.earthCell === globe?.me.parcel?.earthCell;
      drewLegacyHome ||= persistent;
      out.push({
        key: `p${marker.earthCell}`, layer: 'parcel',
        lon: at.lon, lat: at.lat,
        r: parcelRadius(marker.keepLevel), ring: persistent, mine: persistent,
        cell: marker.earthCell, keepLevel: marker.keepLevel, persistent,
        label: marker.name || (persistent
          ? deedEarthCellLabel('YOUR PARCEL', marker.earthCell)
          : undefined),
        avatarUrl: marker.avatarUrl,
        profileInitial: publicProfileInitial(marker.name),
      });
    }
    // Explicit old-API compatibility. This collection is null on every current
    // server, so the viewport and one-valley worlds can never be blended.
    for (const p of placed ?? []) {
      const owned = ownedParcels.find((entry) => entry.parcel.earthCell === p.cell);
      const selected = owned
        ? ownedParcelSelected(owned, selectedBaseId, globe?.me.parcel?.earthCell ?? null)
        : p.mine;
      if (owned) drewOwned.add(owned.baseId);
      if (owned) {
        const beacon = deedOwnedBeacon(owned, { lon: p.lon, lat: p.lat }, selected);
        out.push({
          ...beacon,
          r: p.r,
          keepLevel: p.keepLevel,
          label: p.name ?? beacon.label,
          avatarUrl: p.avatarUrl,
          profileInitial: publicProfileInitial(p.name),
        });
        continue;
      }
      const persistent = p.cell === globe?.me.parcel?.earthCell;
      drewLegacyHome ||= persistent;
      out.push({
        key: `p${p.x},${p.y}`, layer: 'parcel',
        lon: p.lon, lat: p.lat,
        r: p.r, ring: persistent || selected, mine: persistent || selected,
        cell: p.cell, keepLevel: p.keepLevel, persistent,
        label: p.name ?? (persistent || selected
          ? deedEarthCellLabel('YOUR PARCEL', p.cell)
          : undefined),
        avatarUrl: p.avatarUrl,
        profileInitial: publicProfileInitial(p.name),
      });
    }
    // Every private owned parcel is uncapped and independent of the selected-base
    // sector/valley roster. Draw all of them even while another valley is open (or
    // no roster has loaded), and at every globe zoom. This is the core multi-base
    // invariant: switching Home changes the pulse, never the set of visible deeds.
    if (EARTH_TILES) {
      for (const owned of ownedParcels) {
        if (drewOwned.has(owned.baseId)) continue;
        const at = earthCellCentre(owned.parcel.earthCell);
        if (!at) continue;
        const selected = ownedParcelSelected(
          owned, selectedBaseId, globe?.me.parcel?.earthCell ?? null,
        );
        // The beacon wears its owner's face from the private /globe overlay (D-096),
        // and only that (D-097): "?" is reached only by a served empty name.
        out.push(deedOwnedBeacon(owned, at, selected));
      }
    }
    // Rolling-version fallback: before `ownedParcels` exists, preserve the selected
    // Home beacon rather than making all private land disappear during deployment.
    const home = globe?.me.parcel;
    const homeAt = home ? earthCellCentre(home.earthCell) : null;
    if (EARTH_TILES && ownedParcels.length === 0 && home && homeAt && !drewLegacyHome) {
      out.push(deedHomeBeacon(home, homeAt));
    }
    return out;
  }, [globe, ownedParcels, placed, selCell, selectedBaseId, sector, clusters, viewportMarkersForRender]);

  // --- tile identity (P3) ---------------------------------------------------
  /** THE SELECTED TILE, fully identified: country, ISO codes, `GEO-0042`, degrees.
   *  One 86 k-cell pass per selection for the ordinal, never per frame. */
  const selTile = useMemo<TileFacts | null>(
    () => (selCell !== null && countries && mask.cols === GLOBE.fineCols
      ? tileFacts(mask, countries, selCell)
      : null),
    [selCell, countries, mask],
  );
  /** …and whether it is free / claimed / yours / unseated / elsewhere. The deed
   * roster carries public profile identity; actionable detail loads per cell. */
  const rosterOwn = useMemo<CellOwnership | null>(
    () => (selCell !== null && grid
      ? viewportParcels.unsupported
        ? cellOwnership(selCell, parcelSiteId, grid, parcels?.rows ?? null)
        : viewportCellOwnership(selCell, grid, viewportParcels.markers)
      : null),
    [selCell, grid, parcelSiteId, parcels, viewportParcels.markers, viewportParcels.unsupported],
  );
  const selOwn = useMemo<CellOwnership | null>(
    () => walletOwnedCellOwnership(selCell, rosterOwn, ownedParcels),
    [ownedParcels, rosterOwn, selCell],
  );
  /** Only an explicitly selected occupied cell opens the authenticated detail
   * route; free/unknown ground never triggers a probe. */
  const selectedHomeCell = EARTH_TILES
    && selCell !== null
    && selCell === globe?.me.parcel?.earthCell;
  // Once a selected public marker has been proven claimed, retain that fact while
  // a pan replaces the viewport scope. The cell itself remains selected and its
  // separately-authoritative detail must not blink off between public snapshots.
  const claimedSelectionRef = useRef<RetainedClaimedSelection | null>(null);
  claimedSelectionRef.current = retainedClaimedSelection(
    claimedSelectionRef.current,
    viewportAuthority,
    selCell,
    selOwn,
    exactViewportOmittedSelection,
  );
  const detailEnabled = parcelDetailEnabled(
    entryPaid,
    selectedHomeCell,
    selOwn,
    claimedSelectionRef.current,
    selCell,
  );
  const parcelDetail = useParcelDetail(selCell, detailEnabled, viewerWallet, selectedBaseId);
  const [parcelAction, setParcelAction] = useState<'scout' | null>(null);
  /**
   * THE COUNTRY UNDER THE CROSSHAIR — the label ladder's middle rung.
   *
   * Between z1 and z2 a tile is 5.6–22.5 px, which is too small to carry text and too
   * big to ignore, so the answer goes in the CHROME instead of on the canvas:
   * unlimited length, collision-free, accessible, and exactly one of them. Read from
   * React's committed camera, which is the right clock for a text row — it updates on
   * gesture boundaries rather than 60 times a second.
   */
  const crossCountry = useMemo(() => {
    if (!countries || mask.cols !== GLOBE.fineCols || !mix.wantFineMask) return null;
    const c = cellAtDeg(mask, nav.lam0 * RAD_TO_DEG, nav.phi0 * RAD_TO_DEG);
    const t = tileCountry(mask, countries, c.iy * mask.cols + c.ix);
    return t && t.id !== 0 ? t : null;
  }, [countries, mask, mix.wantFineMask, nav.lam0, nav.phi0]);

  // --- navigation ----------------------------------------------------------
  const onNav = useCallback((n: GlobeNav) => {
    setNav(n);
    const m = bandMix(n.zoom);
    // An exact owned-beacon flight crosses several bands, each of which commits
    // the camera. Ordinary nearest-cluster adoption must not replace an owned
    // target omitted from the capped public list halfway through that flight.
    const owned = ownedFocusRef.current;
    if (owned && m.band !== 'globe') {
      const at = earthCellCentre(owned.parcel.earthCell);
      if (at) {
        setSectorId(owned.sectorId ?? sectorIdOf(at.lon, at.lat));
        // The valley id is the legacy roster's key; on a D-096 server it names a
        // place the public list does not carry, which the private overlay resolves.
        setParcelClusterId(owned.valleyId);
        setSelCell(owned.parcel.earthCell);
      }
      // PixelGlobe clears its tween before publishing the arrival commit. A user
      // gesture also cancels it, so either path releases this navigation intent
      // instead of hijacking later pans.
      if (ctl.current?.tweening() === false) {
        ownedFocusRef.current = null;
        setOwnedFocus(null);
      }
      return;
    }
    // The camera owns browsing context once it enters a REGION. Unlike the old
    // null-only write, this also follows a completed pan into another sector.
    if (m.band !== 'globe') {
      const loaded = adoptRef.current;
      const next = cameraBrowseContext(
        n.lam0 * RAD_TO_DEG,
        n.phi0 * RAD_TO_DEG,
        m.wantParcels,
        loaded.sectorId,
        loaded.clusters,
      );
      setSectorId(next.sectorId);
      // Nearest-cluster adoption is sticky inside a sector. A pan must not churn an
      // explicitly opened/focused place (and its title context); a real sector
      // change is the one event whose effect clears it before the new
      // list-arrival effect adopts once.
      setParcelClusterId((current) => stickyParcelCluster(current, next.clusterId));
    }
  }, []);

  // Zoom can reach the parcel band before GET /globe/sector/:id returns. The
  // camera has already committed by then, so there may never be another onNav to
  // perform the cluster adoption. Re-run the same decision when that list lands.
  // The active-sector equality is what keeps a Home transition from borrowing the
  // old camera's place while it waits to fly to the player's parcel.
  useEffect(() => {
    if (!mix.wantParcels || parcelClusterId !== null) return;
    const next = cameraBrowseContext(
      nav.lam0 * RAD_TO_DEG,
      nav.phi0 * RAD_TO_DEG,
      true,
      sector?.id ?? null,
      clusters,
    );
    if (next.sectorId === sectorId && next.clusterId !== null) {
      setParcelClusterId(next.clusterId);
    }
  }, [mix.wantParcels, nav.lam0, nav.phi0, parcelClusterId, sector, sectorId, clusters]);

  /** Where a sector pin STANDS: the base cell the server served for it (D-096).
   *  Null for a sector the planet served no pin for: there is nowhere honest to
   *  fly (D-097), and every caller's id came from a served pin anyway. */
  const sectorAt = useCallback((id: number): { lon: number; lat: number } | null => {
    const pin = globe?.sectors.find((s) => s.id === id);
    return pin ? { lon: pin.lon, lat: pin.lat } : null;
  }, [globe]);

  const openSector = useCallback((id: number) => {
    ownedFocusRef.current = null;
    setOwnedFocus(null);
    setSectorId(id);
    setSheet('expanded');
    const c = sectorAt(id);
    if (c) ctl.current?.tweenTo(c.lon, c.lat, GLOBE.regionZoom);
  }, [sectorAt]);

  /** Tapping a cluster pin zooms to its centroid, where the parcel band takes over
   * with the bases standing there. A tile tap then selects that exact Earth place;
   * it never leaves the globe. */
  const openCluster = useCallback((c: { id: string; lon: number; lat: number }) => {
    ownedFocusRef.current = null;
    setOwnedFocus(null);
    setParcelClusterId(c.id);
    setSelCell(null);
    setSheet('peek');
    ctl.current?.tweenTo(c.lon, c.lat, GLOBE_VIEW.parcelZoom);
  }, []);

  /**
   * MY PARCEL — AND IT GOES TO THE PARCEL. (fixed 2026-08-10)
   *
   * Earlier builds left the globe for a shared 25×20 tactical board. The current
   * control stays on the globe and focuses the deed's exact Earth tile.
   *
   * The press is an INTENT rather than a guessed camera move. The private `/globe`
   * response carries the exact frozen cell, so neither a capped sector list nor a
   * generated cell reconstruction can make it vanish. Missing/invalid data is still
   * said aloud through HomeState instead of becoming a silent no-op.
   */
  const [home, setHome] = useState<{ seq: number; state: HomeState }>({ seq: 0, state: 'off' });
  const goHome = useCallback(() => {
    ownedFocusRef.current = null;
    setOwnedFocus(null);
    setSheet('peek');
    // A COUNTER, like `openSeq`: pressing MY PARCEL twice has to be two events, and
    // `state: 'seeking'` set twice in a row is not a change React would re-run on.
    setHome((h) => ({ seq: h.seq + 1, state: 'seeking' }));
  }, []);

  /** A deedless player's one rail action zooms into real selectable ground.
   * Prefer the populated region already under the camera; otherwise use the
   * busiest public region (stable id tie-break). The parcel-band tween and the
   * async roster-adoption effect do the rest, so no MY PARCEL press is involved. */
  const chooseLandSequence = useRef(0);
  useEffect(() => () => { chooseLandSequence.current++; }, []);
  const chooseLand = useCallback(() => {
    const sequence = ++chooseLandSequence.current;
    const preferredCell = selCell ?? useApp.getState().landPurchase?.earthCell ?? null;
    ownedFocusRef.current = null;
    setOwnedFocus(null);
    setHome((h) => ({ ...h, state: 'off' }));
    setSelCell(null);
    setSheet('expanded');
    const target = chooseLandSector(globe?.sectors ?? [], sectorId);
    if (!target) {
      // Populated-sector aggregates are empty before the first purchase. The
      // same lazy parcel mapping used by the renderer can still name real land.
      void import('@shardkeep/shared/parcelGrid').then((parcelGrid) => {
        const state = useApp.getState();
        if (sequence !== chooseLandSequence.current || state.wallet !== viewerWallet
          || state.screen !== 'map' || state.mapTab !== 'world') return;
        const ground = chooseLandGround(parcelGrid, nav.lam0 * RAD_TO_DEG, nav.phi0 * RAD_TO_DEG, preferredCell);
        if (!ground) { bus.emit('ui:toast', { msg: 'LAND MAP UNAVAILABLE — TAP CHOOSE LAND TO RETRY' }); return; }
        setSectorId(sectorIdOf(ground.lon, ground.lat));
        setSelCell(ground.cell);
        ctl.current?.tweenTo(ground.lon, ground.lat, GLOBE_VIEW.parcelZoom);
      }).catch(() => {
        if (sequence === chooseLandSequence.current && useApp.getState().wallet === viewerWallet) {
          bus.emit('ui:toast', { msg: 'LAND MAP COULD NOT LOAD — TAP CHOOSE LAND TO RETRY' });
        }
      });
      return;
    }
    setSectorId(target.id);
    // Land where the region's bases actually are, so the parcel band opens on
    // ground someone has claimed rather than on a sector's sea-bound centre.
    ctl.current?.tweenTo(target.lon, target.lat, GLOBE_VIEW.parcelZoom);
  }, [globe, sectorId, selCell, nav.lam0, nav.phi0, viewerWallet]);

  useEffect(() => {
    if (home.state !== 'seeking') return;
    // WHERE DOES THIS PLAYER LIVE? `/globe.me.parcel` now carries the exact frozen
    // cell. It is neither reconstructed through generated geography nor dependent
    // on the sector's capped valley list, so the flight completes as soon as this
    // private response arrives.
    if (!globe) return;
    if (!EARTH_TILES) {
      if (!homeAt) { setHome((h) => ({ ...h, state: 'unplaceable' })); return; }
      ctl.current?.tweenTo(homeAt.lon, homeAt.lat, tileHomeZoom(Math.min(win.w, win.h)));
      setHome((h) => ({ ...h, state: 'off' }));
      return;
    }
    const own = globe.me.parcel;
    if (!own) { setHome((h) => ({ ...h, state: 'noparcel' })); return; }
    const at = earthCellCentre(own.earthCell);
    if (!at) { setHome((h) => ({ ...h, state: 'unplaceable' })); return; }
    const transition = homeContextTransition(
      globe.me.sectorId,
      homeClusterIdFor(own),
      sectorId,
      sector?.id ?? null,
      clusters.map((c) => c.id),
    );
    if (transition.kind === 'switch-sector') {
      // Do not write the place or cell yet: the sector-change cleanup must first
      // discard the foreign context. This effect resumes once the new list loads.
      setSectorId(transition.sectorId);
      return;
    }
    if (transition.kind === 'wait-for-cluster') return;
    if (transition.clusterId) setParcelClusterId(transition.clusterId);
    ctl.current?.tweenTo(at.lon, at.lat, tileHomeZoom(Math.min(win.w, win.h)));
    setSelCell(own.earthCell);
    setSheet('expanded');
    setHome((h) => ({ ...h, state: 'off' }));
  }, [home, globe, homeAt, sectorId, sector, clusters, win.w, win.h]);

  /** A secondary owned beacon is an exact private address, not a public-roster
   * guess. Start the camera flight immediately, then install its sector/valley/cell
   * after the sector-change cleanup has discarded the old context. This makes an
   * inactive sixth deed just as findable as an active one without changing which
   * base is selected for gameplay. */
  const focusOwnedParcel = useCallback((owned: GlobeOwnedParcel) => {
    const at = earthCellCentre(owned.parcel.earthCell);
    if (!at) {
      bus.emit('ui:toast', { msg: 'THIS DEED HAS AN INVALID EARTH ADDRESS' });
      return;
    }
    setHome((h) => ({ ...h, state: 'off' }));
    ownedFocusRef.current = owned;
    setOwnedFocus(owned);
    setSectorId(owned.sectorId ?? sectorIdOf(at.lon, at.lat));
    setSheet('expanded');
    ctl.current?.tweenTo(at.lon, at.lat, tileHomeZoom(Math.min(win.w, win.h)));
  }, [win.h, win.w]);

  useEffect(() => {
    if (!ownedFocus) return;
    const at = earthCellCentre(ownedFocus.parcel.earthCell);
    if (!at) { setOwnedFocus(null); return; }
    const targetSector = ownedFocus.sectorId ?? sectorIdOf(at.lon, at.lat);
    if (sectorId !== targetSector) {
      setSectorId(targetSector);
      return;
    }
    setParcelClusterId(ownedFocus.valleyId);
    setSelCell(ownedFocus.parcel.earthCell);
    setSheet('expanded');
  }, [ownedFocus, sectorId]);

  const onPinTap = useCallback((pin: GlobePin) => {
    if (pin.layer === 'sector') { openSector(Number(pin.key.slice(1))); return; }
    // Ordinary parcels remain ground-hit tiles. The one exception is the persistent
    // home beacon: it is a 44 px navigation target at whole-Earth zoom and carries
    // the exact stored cell it should select. It still goes through goHome so a
    // beacon visible over a foreign valley cannot select against that valley's
    // roster before the authoritative home sector + valley context is installed.
    if (pin.layer === 'parcel') {
      if (pin.persistent && pin.cell !== undefined) {
        const owned = pin.baseId
          ? ownedParcels.find((entry) => entry.baseId === pin.baseId)
          : undefined;
        if (owned && !pin.mine) focusOwnedParcel(owned);
        else goHome();
      }
      return;
    }
    const c = clusters.find((x) => x.id === pin.key);
    if (c) openCluster(c);
  }, [focusOwnedParcel, goHome, openSector, openCluster, ownedParcels, clusters]);

  /**
   * A TAP THAT HIT NO PIN NOW SELECTS A TILE. (P3)
   *
   * The cell arrives already resolved (`unproject` → `cellAtDeg` in PixelGlobe) with
   * the dimensions of the mask it was read against, and those are CHECKED rather than
   * assumed: a cell id from the 2° coarse mask is a completely different place on the
   * 0.5° grid, so below `fineMaskZoom` a tap clears the selection instead of naming a
   * tile that does not exist. Tapping the selected tile again deselects, so the
   * inspector is always dismissible without hunting for the sea.
   */
  const onTap = useCallback((at: GlobeTap | null) => {
    ownedFocusRef.current = null;
    setOwnedFocus(null);
    if (!at || at.cols !== GLOBE.fineCols || at.rows !== GLOBE.fineRows) {
      // Nothing to name: this is the old `onEmptyTap`, and it still tidies the sheet.
      setSelCell(null);
      setSheet('peek');
      return;
    }
    const next = selCell === at.cell ? null : at.cell;
    setSelCell(next);
    // A claimed tile is a request for its inspector, so open the sheet immediately.
    // Tapping the same tile again remains the quick dismiss gesture.
    setSheet(next === null ? 'peek' : 'expanded');
  }, [selCell]);

  const scoutParcel = useCallback(() => {
    const target = parcelDetail.data;
    if (!target || !target.actions.scout.allowed || parcelAction !== null) return;
    setParcelAction('scout');
    const targetId = encodeURIComponent(target.base.id ?? target.player.wallet);
    void api.get<ParcelScoutReport>(selectedBasePath(`/map/scout/${targetId}`))
      .then((report) => {
        setScoutReport({
          name: report.name,
          keepLevel: report.keepLevel,
          trophies: report.trophies,
          previewSec: report.previewSec,
          returnScreen: 'map',
          attackTarget: { kind: 'pvp', wallet: target.player.wallet,
            ...(target.base.id ? { defenderBaseId: target.base.id } : {}), name: target.player.name },
          ...(!target.actions.attack.allowed ? { attackUnavailable: parcelActionBlockText(
            target.actions.attack.blockedBy, { keepReach: target.actions.attack.keepReach, shield: target.shield },
          ) ?? 'ATTACK UNAVAILABLE' } : {}),
        });
        setScreen('scout');
        bus.emit('battle:enter', { snapshot: report, visualContext: report.visualContext, scout: true });
      })
      .catch((e: Error) => bus.emit('ui:toast', { msg: e.message }))
      .finally(() => setParcelAction(null));
  }, [parcelAction, parcelDetail.data, selectedBaseId, setScoutReport, setScreen]);

  const attackParcel = useCallback(() => {
    const target = parcelDetail.data;
    if (!target || !target.actions.attack.allowed) return;
    setRaidTarget({
      kind: 'pvp',
      wallet: target.player.wallet,
      ...(target.base.id ? { defenderBaseId: target.base.id } : {}),
      name: target.player.name,
    });
    setScreen('battle');
  }, [parcelDetail.data, setRaidTarget, setScreen]);

  // DEV-only measurement hook: `__shardkeepGlobe.stats()` reports the raster's
  // per-frame cost, the cells it splatted and the observed fps, so "is it 60 fps
  // while spinning?" is a number read from the running app rather than a claim.
  // Same pattern state/store.ts and lib/events.ts use for their invariants.
  const dbg = {
    mask, pins, sectorId, nav, parcelClusterId, parcels, view: mix.view, home,
    parcelSiteId, placed, selTile, selOwn, crossCountry, grid, clusters, chunks,
    ownedParcels, parcelBounds, viewportParcels,
  };
  const dbgRef = useRef(dbg);
  dbgRef.current = dbg;
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') return undefined;
    const w = window as unknown as Record<string, unknown>;
    w['__shardkeepGlobe'] = {
      stats: () => ctl.current?.stats() ?? null,
      view: GLOBE_VIEW,
      // Which mask is live is the one thing a screenshot cannot tell you — 180×90
      // is the eager coarse mask, 720×360 the dynamically imported fine one.
      state: () => ({
        maskCols: dbgRef.current.mask.cols,
        maskRows: dbgRef.current.mask.rows,
        pins: dbgRef.current.pins.length,
        sectorId: dbgRef.current.sectorId,
        zoom: dbgRef.current.nav.zoom,
        liveNav: ctl.current?.nav() ?? null,
        // The parcel band, measurable rather than eyeballed: which place is in
        // focus, how many parcels came back, and whether the payload is a visit.
        view: dbgRef.current.view,
        parcelClusterId: dbgRef.current.parcelClusterId,
        parcels: dbgRef.current.parcels?.rows.length ?? 0,
        visiting: dbgRef.current.parcels?.visiting ?? null,
        viewportParcels: dbgRef.current.viewportParcels.markers?.length ?? null,
        viewportUnsupported: dbgRef.current.viewportParcels.unsupported,
        // THE MARKER CAP (D-097), measurable: whether the served page stopped at
        // the cap and how many bases qualified before it.
        viewportTruncated: dbgRef.current.viewportParcels.truncated,
        viewportMatched: dbgRef.current.viewportParcels.matched,
        viewportScope: dbgRef.current.parcelBounds,
        // The MY PARCEL flight, measurable rather than eyeballed: which plot is
        // the viewer's, which one a tap selected, and what the press is waiting on.
        myParcel: dbgRef.current.parcels?.rows.find((r) => r.mine) ?? null,
        ownedParcels: dbgRef.current.ownedParcels.map((entry) => ({
          baseId: entry.baseId, active: entry.active, valleyId: entry.valleyId,
          earthCell: entry.parcel.earthCell,
        })),
        home: dbgRef.current.home.state,
        // THE EARTH TILE BAND, measurable rather than eyeballed. This is what makes
        // "every parcel is on land, in a country" a number read off the running app
        // instead of a claim about a screenshot: the patch this valley owns, the cell
        // and country of every placed parcel, and the identity of the selected tile.
        earthTiles: EARTH_TILES,
        siteId: dbgRef.current.parcelSiteId,
        patches: dbgRef.current.grid?.patchCount() ?? null,
        capacity: dbgRef.current.grid?.parcelCapacity() ?? null,
        placed: dbgRef.current.placed?.length ?? null,
        placedCells: (dbgRef.current.placed ?? []).map(
          (q) => ({ x: q.x, y: q.y, cell: q.cell, lon: q.lon, lat: q.lat, mine: q.mine }),
        ),
        // THE REGION-BAND CLUSTERS (D-096): each at the served centroid of the bases
        // it counts. The client consumes the coordinates once; it never inverts a
        // display lon/lat into an identity.
        clusters: dbgRef.current.clusters.map((c) => ({
          id: c.id, lon: c.lon, lat: c.lat, players: c.players,
        })),
        // WHICH GENERATED CHUNKS THIS CAMERA AUTHORISED (D5). All three must read
        // false-for-tiles with VITE_FEATURE_EARTH_TILES unset, at every zoom.
        chunks: dbgRef.current.chunks,
        selTile: dbgRef.current.selTile,
        selOwn: dbgRef.current.selOwn,
        crosshair: dbgRef.current.crossCountry,
      }),
    };
    return () => { delete w['__shardkeepGlobe']; };
  }, []);

  // --- chrome --------------------------------------------------------------
  // The peek row talks about the WORLD, the geographic REGION, and the exact
  // Earth cells visible at parcel zoom. Internal allocation groups never title it.
  // Neither selection is ever cleared by zooming out — pulling back to admire the
  // planet should not lose what you were reading.
  const sel = mix.view !== 'region' || sectorId === null
    ? null
    : globe?.sectors.find((s) => s.id === sectorId) ?? null;
  const regionLabel = sector?.name ?? (sectorId === null ? null : `REGION ${sectorId}`);
  const title = mix.view === 'globe'
    ? 'EARTH'
    : mix.view === 'parcel'
      ? (regionLabel ?? crossCountry?.name ?? 'EARTH')
      : (regionLabel ?? 'EARTH');
  /** The selected-base marker from the bounded map roster (legacy/single-base
   * fallback), plus every private owned deed in the valley regardless of which
   * base supplied that roster. */
  const myParcel = useMemo(() => parcels?.rows.find((r) => r.mine) ?? null, [parcels]);
  const ownedHere = useMemo(
    () => ownedParcels.filter((entry) => entry.valleyId === parcelClusterId),
    [ownedParcels, parcelClusterId],
  );
  const ownedCue = useMemo(
    () => viewportParcels.unsupported
      ? ownedHere
      : ownedViewportCue(ownedParcels, parcelBounds, selCell),
    [ownedHere, ownedParcels, parcelBounds, selCell, viewportParcels.unsupported],
  );
  const visibleCount = parcelScopeCount(viewportParcels, parcels?.rows.length ?? 0);
  /**
   * ONE TILE'S SIZE AS THE CHROME SEES IT, from React's committed camera — and whether
   * it has reached the 44 px every other map control is held to.
   *
   * It is no longer a gate on whether a tap is ANSWERED (a tap resolves to the cell
   * under the finger at any zoom, which is the whole of the hit-testing change); it is
   * how the chrome tells the player whether their aim can be trusted, and it is the
   * same predicate the canvas uses to decide a tile may carry its own label.
   */
  const tileSize = tilePx(nav.zoom, Math.min(win.w, win.h));
  const tileAimLive = tileLabelled(tileSize);
  const selectedCell = useMemo(
    () => selCell === null ? null : {
      cell: selCell, cols: GLOBE.fineCols, rows: GLOBE.fineRows,
    },
    [selCell],
  );
  const selectedPurchase = useMemo(
    () => (selTile
      ? tilePurchaseState(
        selTile.claimable, selOwn, baseDirectory !== null, purchaseKind, cellReservations,
      )
      : null),
    [baseDirectory, cellReservations, purchaseKind, selOwn, selTile],
  );
  const selectedDeedFallback = useMemo(
    () => parcelDetail.data
      ? deedFallbackImageUrl(parcelDetail.data.player.wallet)
      : null,
    [parcelDetail.data],
  );
  const selectedDeedImage = useMemo(
    () => deedImageUrl(parcelDetail.data?.deed.metadata.image ?? '')
      ?? selectedDeedFallback,
    [parcelDetail.data?.deed.metadata.image, selectedDeedFallback],
  );
  const totals = useMemo(() => (globe?.sectors ?? []).reduce(
    (a, s) => ({ players: a.players + s.players, valleys: a.valleys + s.valleys, active: a.active + s.active }),
    { players: 0, valleys: 0, active: 0 },
  ), [globe]);
  const homeControl = globeHomeControl(globe !== null, globe?.me.parcel !== null && globe?.me.parcel !== undefined);
  const warzoneActive = globe ? globeWarzoneActive(globe.sectors) : false;
  // THE PEEK ROW, PLANNED FROM THE STRINGS IT WILL DRAW (D-097) — see the pure
  // functions above; GlobeLayer.test.ts measures the plan against a 390 px phone.
  const peekContext = globePeekContext({
    view: mix.view, loaded: globe !== null, error, pending, worldBases: totals.players,
    region: mix.view === 'region' && sectorId !== null
      ? { bases: sel?.players ?? 0, inReach: globe?.me.reachSectorIds.includes(sectorId) ?? false }
      : null,
    visible: visibleCount,
  });
  const peekSelection = globePeekSelection({
    view: mix.view, home: home.state,
    selected: selTile
      ? { lon: selTile.lon, lat: selTile.lat, cell: selTile.cell, state: selOwn?.state, claimable: selTile.claimable }
      : null,
    ownedCue: ownedCue.length,
    ownedCell: ownedCue.length === 1 ? ownedCue[0]!.parcel.earthCell : null,
    region: regionLabel, country: crossCountry?.name ?? null, aimLive: tileAimLive,
  });
  const peekRow = globePeekRow(box.w, peekContext, peekSelection);
  // NO RAIL (D-097): MY PARCEL rides the zoom rail's home slot and WARZONE is a
  // top-bar badge, so the globe asks the solver for zero rail rows and three zoom
  // buttons — the icon column that ate a 390 px phone's map is gone.
  const L = mapChrome(box.w, box.h, sheetH, 0, 3);

  return (
    <div
      ref={layerRef}
      className="interactive"
      // NO opacity / pointerEvents here: PixelGlobe's rAF owns both so the fade
      // tracks the camera (see its layerRef prop). `visibility` starts hidden so a
      // freshly mounted layer cannot flash over the local map before the first
      // frame decides where the camera is.
      style={{
        position: 'absolute', inset: 0, zIndex: 1500, visibility: 'hidden', overflow: 'hidden',
        // SPACE IS OPAQUE. The raster leaves everything outside the disc
        // transparent, and without a backdrop the valley terrain and the local
        // board's own rail showed THROUGH the sky (observed live). The backdrop
        // fades with the layer, so the cross-fade still dissolves into the map.
        background: '#0B0E14',
      }}>
      <PixelGlobe
        vw={win.w} vh={win.h} mask={mask} pins={pins} reduceMotion={reduceMotion}
        selectedCell={selectedCell}
        controlRef={ctl} layerRef={layerRef}
        onNav={onNav} onPinTap={onPinTap} onEmptyTap={onTap}
      />

      <MapTopBar
        L={L} inset={inset} mode="world" onMode={setMapTab} onBack={() => setScreen('base')}
        title={title}
        trailing={(
          <>
            {/* WARZONE IS A BADGE, AND ONLY WHILE ONE IS LIVE (D-097). The rail
                button it replaces sat on a 390 px phone whether or not there was a
                warzone to read about. Icon-only below MAPCHROME.labelMinW so the
                title keeps its width; the same 44 px chrome button, the same sheet. */}
            {warzoneActive && (
              <IconBtn glyph={<Icon name="shield" size={19} />} label="WARZONE" showLabel={L.showLabels}
                accent={C.danger} on={warzoneOpen} onClick={() => setWarzoneOpen(true)}
                style={{ height: '100%', flex: 'none' }} />
            )}
            <span aria-label={`World bases ${globe ? fmtN(totals.players) : 'loading'}`}
              style={{ display: 'flex', alignItems: 'center', gap: 3, flex: 'none', color: C.goldHi, fontSize: 14 }}>
              <Sprite name="ui_compass" w={14} h={14} />
              {globe ? fmtN(totals.players) : '—'}{L.showLabels && ' BASES'}
            </span>
          </>
        )}
      />

      {/* Ownership gets its own row so WARZONE cannot crowd it off a phone. */}
      <UnderBar L={L} inset={inset}>
        <GlobeBaseCounts directory={baseDirectory} onOpenBases={() => setScreen('bases')} />
      </UnderBar>

      {/* MY PARCEL RIDES THE ZOOM RAIL'S HOME SLOT (D-097): it flies to the deed's
          immutable Earth cell without leaving the globe — or, for a deedless
          player, into real selectable ground. One tap, never collapsed. */}
      {!warzoneOpen && <div data-tutorial-target={homeControl.action === 'choose-land' ? 'land-globe-cell' : undefined}><ZoomRail L={L} inset={inset} sheetH={sheetH} step={0.5}
        zoomBy={(d) => ctl.current?.zoomBy(d)}
        onHome={homeControl.action === 'home' ? goHome : chooseLand}
        homeLabel={homeControl.label}
        homeGlyph={homeControl.action === 'home' ? '⌂' : '⌖'} /></div>}

      {warzoneOpen && (
        <div className="interactive" {...chromePanGuard} style={{
          position: 'absolute', zIndex: 1650, display: 'flex', flexDirection: 'column',
          left: MAPCHROME.pad + inset.left, right: MAPCHROME.pad + inset.right,
          top: L.underBar.top + inset.top, bottom: MAPCHROME.pad + inset.bottom,
        }}>
          <Panel9 style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <Phead title="WARZONE" onClose={() => setWarzoneOpen(false)} />
            <WarzoneDetails onShop={() => setScreen('shop')} />
          </Panel9>
        </div>
      )}

      <MapSheet
        L={L} inset={inset} state={warzoneOpen ? 'hidden' : sheet}
        onCollapse={() => setSheet('peek')} onHeight={setSheetH}
        peek={(
          <>
            {/* EXACTLY THREE ITEMS (D-097): context · selection · caret. Every
                state the row used to add a pill for — no planet, reading, the MY
                PARCEL press's three answers, the crosshair country, the tile-size
                cue, IN REACH — is folded into the two pills by `globePeekContext`
                / `globePeekSelection`, so nothing is ever a scroll away on a
                phone, and the retry is the pill that reports the failure. */}
            <PeekPillView pill={peekContext}
              onClick={peekContext.action === 'retry' ? retry : undefined}
              ariaLabel={error ? `NO PLANET · ${error} · TAP TO RETRY` : undefined} />
            <PeekPillView pill={peekSelection} maxWidth={peekRow.selectionMaxW}
              onClick={peekSelection.action === 'buy-land'
                ? () => useApp.getState().setLandPrompt('browse')
                : undefined} />
            <IconBtn glyph={sheet === 'expanded' ? '▾' : '▴'}
              label={sheet === 'expanded' ? 'MINIMISE' : 'EXPAND'}
              onClick={() => setSheet(sheet === 'expanded' ? 'peek' : 'expanded')}
              style={{ flex: 'none', height: MAPCHROME.tap - 8 }} />
          </>
        )}>
        {sheet === 'expanded' && (
          <div style={{ padding: '8px 10px 12px' }}>
            {sectorId === null && (
              <div style={{ color: C.textFaint, fontSize: 16, padding: 6 }}>
                Spin the planet and tap a region. Gold rings mark regions holding
                keeps you may attack — your reach is Keep level, not distance,
                so every one of them is a real target.
              </div>
            )}
            {/* THE PARCEL BAND, EXPLAINED WHERE IT IS BEING LOOKED AT. This is the
                one place the three words are defined for the player, and it is the
                answer to "is my deed one piece of land?" — it is, and this is it. */}
            {/* EARTH TILES OFF ⇒ NO PARCEL PINS, SO SAY THAT INSTEAD. The Earth copy
                below promises a pin per parcel and a tappable tile, and with the flag
                off neither exists (the parcel grid is not downloaded at all — D5), so
                printing it would be the chrome describing a screen that is not there.
                The roster count and the way in still work, which is what this says. */}
            {mix.view === 'parcel' && !EARTH_TILES && (
              <div style={{
                color: C.textFaint, fontSize: 15, lineHeight: 1.35, padding: 6, marginBottom: 4,
              }}>
                Earth tiles are unavailable in this build. Reopen the game after updating
                to view each claimed base at its deeded location on the globe.
              </div>
            )}
            {mix.view === 'parcel' && EARTH_TILES && !viewportParcels.unsupported && (
              <div style={{
                color: C.textFaint, fontSize: 15, lineHeight: 1.35, padding: 6, marginBottom: 4,
              }}>
                {/* THE CAP, SAID OUT LOUD (D-097): a page that stopped at the server's
                    marker cap is the NEAREST bases, and the player is told so rather
                    than left to count. */}
                {viewportParcels.truncated ? (
                  <>
                    {viewportParcels.matched === null
                      ? 'More public bases stand in this window than are drawn'
                      : `This window holds ${fmtN(viewportParcels.matched)} public bases`}
                    ; the {fmtN(viewportParcels.markers?.length ?? 0)} nearest its centre are
                    drawn. Pinch in and the rest come into view.{' '}
                  </>
                ) : (
                  <>
                    Every public deed marker in the visible camera window is drawn at its frozen
                    Earth cell, including neighbouring regions.{' '}
                  </>
                )}
                Tap one occupied tile for its current owner profile; private shield, loot and
                actions remain behind that single selected-land read.
              </div>
            )}
            {mix.view === 'parcel' && EARTH_TILES && viewportParcels.unsupported && (
              <div style={{
                color: C.textFaint, fontSize: 15, lineHeight: 1.35, padding: 6, marginBottom: 4,
              }}>
                Every claimed base is shown on its immutable 0.5° Earth cell. Tap a
                tile to read its country and cell number. The server checks current
                ownership and purchase availability for the exact cell you select.{' '}
                {ownedHere.length > 0
                  ? <span style={{ color: C.goldHi }}>
                    Your wallet owns {ownedHere.length} {ownedHere.length === 1 ? 'base' : 'bases'} here;
                    every owned deed is ringed, including inactive land.
                  </span>
                  : myParcel
                    ? <span style={{ color: C.goldHi }}>Earth cell {myParcel.earthCell} is yours and ringed.</span>
                  : parcels?.visiting
                    ? 'You own no land in this area.'
                    : ''}
                {!tileAimLive && (
                  <>
                    {' '}One tile is {Math.round(tileSize)} px here and a fingertip is{' '}
                    {MAPCHROME.tap} — pinch in to aim at one, or press ⌂ MY PARCEL to fly
                    to yours.
                  </>
                )}
              </div>
            )}
            {/* MY PARCEL COULD NOT FINISH, and why — the same three answers as the
                peek pill, with room to explain the one that needs it. */}
            {home.state === 'noparcel' && (
              <div style={{ color: C.textFaint, fontSize: 15, lineHeight: 1.35, padding: 6 }}>
                You do not own a parcel yet, so there is nothing of yours on the
                planet — a base without land has no deeded Earth tile.
                Buying land is what puts you on the map.
              </div>
            )}
            {home.state === 'unplaceable' && (
              <div style={{ color: C.textFaint, fontSize: 15, lineHeight: 1.35, padding: 6 }}>
                Your saved Land Deed address is invalid in this build. The globe will
                not reconstruct or move deeded land to a plausible-looking tile.
              </div>
            )}
            {/* ═══ THE TILE INSPECTOR ═══ (P3)
                THE ANSWER TO "DOTS ARE NOT FUN". A tile is a real Earth land cell in a
                real country, and this is where it says so: the country and its ISO
                code, a tile id you can read out loud, the cell centre in degrees, and
                whether the ground is free, claimed or yours.

                The deed roster supplies public usernames/avatars. A separate authenticated,
                rate-limited request resolves loot, shield and actions for exactly one
                claimed tile after the player taps it. */}
            {selTile && (
              <div style={{
                border: `2px solid ${C.border}`, background: C.card, padding: '8px 10px',
                marginBottom: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ color: tileInk(selOwn?.state), fontSize: 18 }}>
                    {selTile.code || '— — —'}
                  </span>
                  <Sp />
                  <span style={{ color: tileInk(selOwn?.state), fontSize: 14 }}>
                    {tileWord(selOwn?.state, selTile.claimable)}
                  </span>
                </div>
                <div style={{ color: C.text, fontSize: 16, marginTop: 2 }}>
                  {selTile.claimable
                    ? <>{selTile.name}{selTile.iso2 ? <span style={{ color: C.textFaint }}> · {selTile.iso2}</span> : null}</>
                    : 'NO SOVEREIGN — open ocean, or Antarctica, which Natural Earth assigns to nobody'}
                </div>
                <div style={{ color: C.textFaint, fontSize: 14, marginTop: 2 }}>
                  {degText(selTile.lon, selTile.lat)} · CELL {selTile.cell} ·{' '}
                  {selTile.claimable ? '0.5° ≈ 39 × 56 km' : 'not claimable Earth'}
                </div>
                <div style={{ color: C.textFaint, fontSize: 15, lineHeight: 1.35, marginTop: 4 }}>
                  {selOwn?.state === 'yours'
                    ? <span style={{ color: C.goldHi }}>Yours, deeded to your wallet — one Land Deed, one parcel, one county on Earth.</span>
                    : selOwn?.state === 'claimed'
                      ? 'Claimed. Reading this Land Deed’s loot, shield and actions below.'
                      : selOwn?.state === 'free'
                        ? 'Free ground on the playable map: nobody owns it yet.'
                        : selOwn?.state === 'unseated'
                          ? 'Real land outside the active playable map, so it cannot be purchased.'
                          : selOwn?.state === 'elsewhere'
                            ? 'Select this Earth cell to let the server check its current availability.'
                            : selTile.claimable
                              ? 'Land with a sovereign. Availability is still loading.'
                              : ''}
                </div>
                {selectedPurchase?.kind === 'eligible' && (
                  <div data-tutorial-target="land-globe-confirm"><Btn
                    variant="gold"
                    fontSize={16}
                    style={{ width: '100%', minHeight: MAPCHROME.tap, marginTop: 8 }}
                    onClick={() => {
                      if (!purchaseKind) return;
                      // The API is still the conflict authority. `elsewhere`
                      // means this client does not hold a complete occupancy answer, so
                      // checkout rechecks it before creating a payable intent.
                      setLandPurchase({ kind: purchaseKind, earthCell: selTile.cell });
                      setScreen('entry');
                    }}
                  >
                    {selectedPurchase.label}
                  </Btn></div>
                )}
                {selectedPurchase && selectedPurchase.kind !== 'eligible' && (
                  <div
                    {...(selectedPurchase.kind === 'checking'
                      ? { role: 'status', 'aria-live': 'polite' as const }
                      : {})}
                    style={{
                      border: `2px solid ${C.border}`, background: C.surface,
                      color: selectedPurchase.kind === 'checking' ? C.textDim : C.textFaint,
                      fontSize: 15, lineHeight: 1.25, padding: '8px 10px', marginTop: 8,
                    }}
                  >
                    {selectedPurchase.message}
                  </div>
                )}
              </div>
            )}
            {detailEnabled && parcelDetail.pending && (
              <div role="status" aria-live="polite" style={{
                border: `2px solid ${C.border}`, background: C.card,
                color: C.textFaint, fontSize: 15, padding: '10px 12px', marginBottom: 8,
              }}>
                READING LAND DEED AND BASE…
              </div>
            )}
            {detailEnabled && parcelDetail.error && (
              <div role="alert" style={{
                border: `2px solid ${C.danger}`, background: C.card,
                color: C.danger, fontSize: 15, padding: '10px 12px', marginBottom: 8,
              }}>
                <div>PARCEL DETAILS UNAVAILABLE · {parcelDetail.error}</div>
                <Btn variant="sec" fontSize={15}
                  style={{ width: '100%', minHeight: MAPCHROME.tap, marginTop: 8 }}
                  onClick={parcelDetail.retry}>
                  TRY AGAIN
                </Btn>
              </div>
            )}
            {parcelDetail.data && (
              <div style={{
                border: `2px solid ${parcelDetail.data.shielded ? C.border : C.gold}`,
                background: C.card, padding: '10px 12px', marginBottom: 8,
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  {selectedDeedImage && (
                    <img
                      key={parcelDetail.data.parcel.earthCell}
                      src={selectedDeedImage}
                      alt={`${parcelDetail.data.deed.metadata.name} preview`}
                      loading="lazy"
                      onError={(event) => {
                        if (selectedDeedFallback) {
                          recoverDeedImage(event.currentTarget, selectedDeedFallback);
                        } else {
                          event.currentTarget.hidden = true;
                        }
                      }}
                      style={{
                        width: 82, height: 82, objectFit: 'cover', imageRendering: 'pixelated',
                        border: `2px solid ${C.border}`, background: C.ink, flex: 'none',
                      }}
                    />
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ color: C.goldHi, fontSize: 19, lineHeight: 1.1 }}>
                      {parcelDetail.data.deed.metadata.name}
                    </div>
                    <div style={{ color: C.textFaint, fontSize: 13, marginTop: 5 }}>OWNER PROFILE</div>
                    <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 5 }}>
                      <SelectedPlayerAvatar
                        url={parcelDetail.data.player.avatarUrl}
                        name={parcelDetail.data.player.name}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: C.text, fontSize: 17 }}>
                          {parcelDetail.data.player.clanTag ? `[${parcelDetail.data.player.clanTag}] ` : ''}
                          {parcelDetail.data.player.name}
                          {parcelDetail.data.player.seeker ? ' · SEEKER' : ''}
                        </div>
                        <div style={{ color: C.textFaint, fontSize: 14, marginTop: 3 }}>
                          KEEP {parcelDetail.data.player.keepLevel} · {fmtN(parcelDetail.data.player.trophies)} TROPHIES
                        </div>
                      </div>
                    </div>
                    <SelectedShieldStatus detail={parcelDetail.data} onExpire={parcelDetail.retry} />
                    <div style={{ color: C.textFaint, fontSize: 13, marginTop: 2 }}>
                      DEED {parcelDetail.data.deed.status.toUpperCase()}
                    </div>
                  </div>
                </div>

                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                  gap: 6, marginTop: 10,
                }}>
                  {[
                    ['STRUCTURES', parcelDetail.data.base.completedStructures],
                    ['DEFENSES', parcelDetail.data.base.defenses],
                    ['WALLS', parcelDetail.data.base.walls],
                    ['LAND', `${parcelDetail.data.base.landWidth} × ${parcelDetail.data.base.landWidth}`],
                  ].map(([label, value]) => (
                    <div key={label} style={{ border: `1px solid ${C.border}`, padding: '5px 7px' }}>
                      <span style={{ color: C.text, fontSize: 16 }}>{value}</span>{' '}
                      <span style={{ color: C.textFaint, fontSize: 12 }}>{label}</span>
                    </div>
                  ))}
                </div>

                <div style={{ color: C.goldHi, fontSize: 16, marginTop: 9 }}>
                  CURRENT ESTIMATED GROSS LOOT
                </div>
                {([
                  ['1★', parcelDetail.data.availableLootRanges.oneStar],
                  ['2★', parcelDetail.data.availableLootRanges.twoStars],
                  ['3★', parcelDetail.data.availableLootRanges.threeStars],
                ] as const).map(([stars, range]) => (
                  <div key={stars} style={{
                    display: 'flex', gap: 8, borderTop: `1px solid ${C.border}`,
                    padding: '3px 0', fontSize: 14,
                  }}>
                    <span style={{ color: C.gold }}>{stars}</span><Sp />
                    <span style={{ color: C.goldHi }}>
                      {fmtN(range.min)}–{fmtN(range.max)} SHARDS
                    </span>
                  </div>
                ))}
                <div style={{ color: C.textFaint, fontSize: 13, lineHeight: 1.25 }}>
                  Authoritative current gross ranges by stars, including eligible Mine and
                  protected-balance sources. These are not the defender’s raw balance; your
                  resolved payout depends on stars and the physical Mines and Vaults destroyed.
                </div>

                <div style={{ marginTop: 9 }}>
                  <div style={{ color: C.textFaint, fontSize: 13, marginBottom: 4 }}>LAND DEED TRAITS</div>
                  {parcelDetail.data.deed.metadata.attributes.map((trait) => (
                    <div key={trait.trait_type} style={{
                      display: 'flex', gap: 8, borderTop: `1px solid ${C.border}`,
                      padding: '4px 0', fontSize: 14,
                    }}>
                      <span style={{ color: C.textFaint }}>{trait.trait_type}</span>
                      <Sp />
                      <span style={{ color: C.text, textAlign: 'right' }}>{String(trait.value)}</span>
                    </div>
                  ))}
                  <div style={{ color: C.textFaint, fontSize: 12, marginTop: 5, overflowWrap: 'anywhere' }}>
                    {parcelDetail.data.deed.assetId
                      ? `NFT ${parcelDetail.data.deed.assetId}`
                      : `NFT ${parcelDetail.data.deed.status.toUpperCase()}`}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <Btn variant="sec" fontSize={17}
                    style={{ flex: 1, minHeight: MAPCHROME.tap }}
                    disabled={!parcelDetail.data.actions.scout.allowed || parcelAction !== null}
                    onClick={scoutParcel}>
                    {parcelAction === 'scout' ? 'SCOUTING…' : 'SCOUT'}
                  </Btn>
                  <Btn fontSize={17}
                    style={{ flex: 1, minHeight: MAPCHROME.tap }}
                    disabled={!parcelDetail.data.actions.attack.allowed || parcelAction !== null}
                    onClick={attackParcel}>
                    ATTACK
                  </Btn>
                </div>
                <RaidEntryCost />
                {(!parcelDetail.data.actions.scout.allowed || !parcelDetail.data.actions.attack.allowed) && (
                  <div role="status" style={{ color: C.textFaint, fontSize: 13, marginTop: 6 }}>
                    {!parcelDetail.data.actions.scout.allowed
                      ? `SCOUT · ${parcelActionBlockText(parcelDetail.data.actions.scout.blockedBy) ?? 'SERVER BLOCKED'}`
                      : 'SCOUT AVAILABLE'}
                    {' · '}
                    {/* The attack line carries the server's own numbers (D-099):
                        the Keep levels it compared and the shield clock it read. */}
                    {!parcelDetail.data.actions.attack.allowed
                      ? `ATTACK · ${parcelActionBlockText(parcelDetail.data.actions.attack.blockedBy, {
                        keepReach: parcelDetail.data.actions.attack.keepReach,
                        shield: parcelDetail.data.shield,
                      }) ?? 'SERVER BLOCKED'}`
                      : 'ATTACK AVAILABLE'}
                  </div>
                )}
              </div>
            )}
            {sectorId !== null && clusters.length === 0 && (
              <div style={{ color: C.textFaint, fontSize: 16, padding: 6 }}>
                {sector ? 'NOBODY LIVES HERE YET.' : 'READING THE REGION…'}
              </div>
            )}
            {sectorId !== null && (
              <div style={{ color: C.textFaint, fontSize: 14, marginTop: 4 }}>
                {/* Public profile identity is display-only; action authority stays
                    behind the exact selected parcel read. */}
                Each claimed globe tile can show its deed owner’s public name and avatar. Tap one
                to inspect that Land Deed and base; scout and attack are offered
                only when the server preview says they are currently eligible.
              </div>
            )}
          </div>
        )}
      </MapSheet>
    </div>
  );
}
