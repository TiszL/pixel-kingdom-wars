/**
 * PIXEL GLOBE — a plain React component on its own `<canvas>`, a SIBLING of the
 * map's DOM overlays. NOT a Phaser scene, deliberately: `'map'` stays out of
 * CANVAS_SCREENS (game/PhaserGame.tsx) so the base scene keeps sleeping under the
 * map, which is the entire reason map.tsx needs none of Overlay's tap-swallowing
 * workaround. Reversing that decision would mean retrofitting `className
 * ="interactive"` onto all fifteen map overlays.
 *
 * WHAT IT OWNS: the camera (in a ref), the ONE rAF, the gestures, and both draw
 * passes — the earth (globeRaster.ts) and the pins, which are drawn INTO the same
 * canvas rather than mounted as DOM. Pins are canvas-drawn because a spin moves
 * every one of them every frame: ~110 absolutely-positioned nodes re-laid-out per
 * frame is exactly the reconciliation cost P2 just removed from the local map.
 * HIT-TESTING IS TWO DIFFERENT QUESTIONS, and P3 split them. A sector or valley pin
 * is a MARKER ON the world, so it is hit-tested as one: projected centres in a ref,
 * nearest wins, and the same 44 px minimum every other control is held to
 * (`pinHitRadius`). A tile is the world ITSELF, so it is hit-tested as ground:
 * `unproject` → `cellAtDeg` names the one cell under the finger. That is why the
 * parcel layer is no longer in the pin hit list at all — a dozen overlapping circles
 * on a screen-space lattice have been replaced by the arithmetic of which cell
 * contains a point, which is also the only way to name the ~59,000 tiles nobody owns.
 *
 * WHAT IT DOES NOT OWN: data, chrome, and where a tap leads. Those are
 * GlobeLayer.tsx's, so this file can be reasoned about as "camera + pixels".
 *
 * GESTURE DISCIPLINE is agent A's, reused rather than reinvented (map.tsx
 * useMapCam): CUMULATIVE displacement from the pointerdown origin decides
 * drag-vs-tap (a per-event delta both swallowed fast flicks and let slow pans
 * fire taps), pointer capture is taken only ONCE it is a drag, and a window-level
 * pointerup drop keeps a pointer released off-element from turning the next
 * finger into a phantom pinch.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { LandMask } from '@shardkeep/shared/globe';
import { GLOBE, WORLD } from '@shardkeep/shared';
import {
  cellAtDeg, projectDeg, unprojectDeg, newProjected, type LonLat, type Projected,
} from '@shardkeep/shared/globe';
import { MAPCHROME } from '../../layout';
import { useMapAtlas } from '../../mapAtlas';
import { MAP_DBL } from '../../mapChromeUI';
import { COLORS as C } from '../../primitives';
import { createEarthRaster, type EarthStats } from './globeRaster';
import {
  bandKey, bandMix, clampGlobeBrowseZoom, clampNav, EARTH_TILES, GLOBE_VIEW, labelBudget, navCamera,
  pinHitRadius, quantiseNav, radiusPx, settleZoom, tileLabelled, tilePx,
  type BandMix, type GlobeNav,
} from './globeView';

/** A drawable, tappable place on the planet. */
export interface GlobePin {
  /** Stable internal identity for the tap callback. Player-visible land identity
   *  is always the frozen Earth cell carried separately below. */
  key: string;
  /** Which band drew it — decides its cross-fade opacity. `'valley'` is the
   *  REGION band's layer: since D-096 it draws 2° CLUSTERS of bases at their
   *  centroids, not valleys; the key predates them and is shared with `BandMix`. */
  layer: 'sector' | 'valley' | 'parcel';
  lon: number;
  lat: number;
  r: number;
  /** In-window targets here (GOLD RING). A highlight, never a filter. */
  ring: boolean;
  /** The viewer's own sector / parcel — pulses. */
  mine: boolean;
  /** A deed parcel owned by this wallet. All owned deeds stay gold; `mine` is
   *  reserved for the currently selected base so only one beacon pulses. */
  owned?: boolean | undefined;
  /** Stable base identity carried only by the private owned-deed overlay. */
  baseId?: string | undefined;
  /** Active-slot state for an owned deed. Inactive land remains visible and
   *  tappable, but is rendered in muted stone rather than active gold. */
  active?: boolean | undefined;
  /** Frozen `plots.earth_cell` for a deed tile. Never reconstructed from
   *  mutable generated geography. */
  cell?: number | undefined;
  /** Public keep level selects the same authored map_keep_t1..t5 silhouette
   *  the local valley already uses while a custom avatar is unavailable. */
  keepLevel?: number | undefined;
  /** Public profile image URL. Treated as opaque and loaded only for bounded,
   * on-canvas parcel markers, independently of the username label budget. */
  avatarUrl?: string | null | undefined;
  /** Precomputed public-name mark. Kept out of the paint loop so hundreds of
   * parcel pins do not trim/spread strings on every animation frame. */
  profileInitial?: string | undefined;
  /** The viewer's own deed beacon survives every globe band. Ordinary parcel
   *  overlays still appear only once their valley is opened. */
  persistent?: boolean | undefined;
  /**
   * Drawn under the pin, SUBJECT TO THE LABEL LADDER (GLOBE_VIEW.labelMax): valley
   * names from `valleyLabelZoom` up, a parcel's own name only once its tile is a
   * 44 px target, and never more than `labelMax` plates in one frame. Setting this
   * is a REQUEST, not a guarantee — 86,122 tiles means an ungated label is spam.
   */
  label?: string | undefined;
}

/**
 * WHERE A TAP LANDED, once no pin claimed it — a POINT AND THE CELL UNDER IT.
 *
 * This replaced nearest-pin resolution for the parcel layer (P3), and the reason is
 * that a cell is a correct answer where a circle was only a deterministic one: 491
 * parcel pins used to share a screen-space lattice whose pitch was ~12 px on a phone
 * while every one of them claimed the 22 px `pinHitRadius`, so a dozen hit circles
 * covered any point the finger landed on. A tile is the ground itself, so "which cell
 * contains this point" has exactly one answer at every zoom — and it can also name
 * the UNCLAIMED tiles, which have no pin at all and are most of the planet.
 *
 * `cols`/`rows` travel with the cell because cell ids are NOT comparable across
 * resolutions: the same integer is a different place on the 2° mask and the 0.5° one.
 * The receiver checks them rather than trusting that both sides agree about which
 * mask was in force.
 */
export interface GlobeTap {
  lon: number;
  lat: number;
  /** Packed `iy · cols + ix` in the mask named by `cols`/`rows`. */
  cell: number;
  cols: number;
  rows: number;
}

/** The imperative surface GlobeLayer drives: descend, recentre, zoom. */
export interface GlobeControl {
  nav(): GlobeNav;
  /** Has the player touched the camera yet (drag / pinch / wheel / zoom button)?
   *  GlobeLayer asks before it finishes an open animation that was still waiting on
   *  /globe: rotating to the player's own valley is a kindness while the camera is
   *  untouched and a yank the moment it is not. Tweens deliberately do NOT count —
   *  same rule the idle spin follows. */
  interacted(): boolean;
  /** Whether an imperative camera flight is still in progress. GlobeLayer uses
   *  this to hold an exact owned-deed focus across intermediate band commits and
   *  release it at arrival (or when a gesture cancels the flight). */
  tweening(): boolean;
  /** Eased rotate-and-zoom. The band cross-fade rides this, so a descend is one
   *  continuous camera move rather than a screen change. */
  tweenTo(lon: number, lat: number, zoom: number): void;
  zoomBy(dz: number): void;
  /** Jump with no animation (used once, to seed the camera on first open). */
  set(nav: Partial<GlobeNav>): void;
  /** `ticks` / `awake` exist so "the faded-out globe stopped consuming frames" is
   *  a measurement taken from the running app, not an argument. `tileCssPx` and
   *  `labels` exist for the same reason one band deeper: how big one 0.5° tile is on
   *  THIS board right now, and how many label plates the ladder actually let
   *  through — both read off the running app rather than eyeballed. */
  stats(): EarthStats & {
    fps: number; frameMs: number; ticks: number; awake: boolean;
    tileCssPx: number; labels: number;
  };
}

export interface PixelGlobeProps {
  /** Board size in CSS px. */
  vw: number;
  vh: number;
  /** The mask in force: coarse at the GLOBE band, fine once REGION is reached.
   *  Swapping it mid-flight is a repaint, never a remount — there is no loading
   *  state to freeze on because the coarse mask keeps drawing until the fine one
   *  has arrived. */
  mask: LandMask;
  pins: readonly GlobePin[];
  /** Exact selected Earth cell. Its grid dimensions travel with the id because
   * a packed cell number has no meaning without its resolution. */
  selectedCell: { cell: number; cols: number; rows: number } | null;
  /** prefers-reduced-motion / the app's REDUCE MOTION toggle: no idle spin. */
  reduceMotion: boolean;
  controlRef: React.RefObject<GlobeControl | null>;
  /**
   * The layer root. Its `opacity` and `pointerEvents` are written FROM THE rAF,
   * not from React — the band cross-fade has to move with the camera, and the
   * camera commits to React only on a gesture boundary. Same discipline the local
   * map uses for `style.transform` (P2): one property, one writer, no
   * reconciliation per frame. React must never set opacity on this node or the
   * two would fight for a frame on every commit.
   */
  layerRef: React.RefObject<HTMLDivElement | null>;
  /** Coarse camera commits for the chrome (NOT per frame): gesture end, tween
   *  end, and any band change. */
  onNav(nav: GlobeNav): void;
  onPinTap(pin: GlobePin): void;
  /**
   * A tap that hit no pin — carrying the CELL under the finger, not just the point.
   *
   * Still called `onEmptyTap` because that is what it means (no pin claimed it), but
   * it is no longer an empty answer: this is how a tile is selected, including the
   * unclaimed ones, and `null` only for a tap outside the disc entirely.
   */
  onEmptyTap(at: GlobeTap | null): void;
}

/** The map surface's ONE drag threshold (ui/layout.ts MAPCHROME.dragPx) — the
 *  local board's pan gate and the chrome's drift guard read the same number. */
const DRAG_PX = MAPCHROME.dragPx;
/** …and the map surface's ONE double-tap window / radius (ui/mapChromeUI.tsx
 *  MAP_DBL), for the same reason: the local board and the globe are two halves of
 *  one screen and must not disagree about what a double-tap is. */
const DBL_MS = MAP_DBL.ms;
const DBL_PX = MAP_DBL.px;

/** The existing local-map keep art is the parcel silhouette vocabulary too. */
export function parcelKeepFrame(keepLevel: number | undefined): string | null {
  if (keepLevel === undefined || !Number.isFinite(keepLevel)) return null;
  const tier = Math.min(5, Math.max(1, Math.trunc(keepLevel)));
  return `map_keep_t${tier}`;
}

/**
 * Keep silhouettes remain subordinate to their 0.5° tile. The former tile-sized
 * fill reached 44×44 px at MY PARCEL zoom and turned every base into a white cube;
 * actual keep art needs only an 18–21 px frame to read on the same mobile viewport.
 */
export function parcelKeepWidthPx(pinRadius: number, tileCss: number): number {
  const safeRadius = Number.isFinite(pinRadius) && pinRadius > 0
    ? pinRadius : GLOBE_VIEW.parcelPinMin;
  const safeTile = Number.isFinite(tileCss) && tileCss > 0 ? tileCss : 0;
  // Atlas frames include transparent breathing room around the keep. A 12 px frame
  // left an L1 keep as a 6–8 px speck on a phone; 40% of the shared touch target is
  // still less than half a tile at MY PARCEL and leaves neighbouring cells clear.
  const desired = Math.max(MAPCHROME.tap * 0.4, safeRadius * 3);
  const tileCap = Math.max(GLOBE_VIEW.parcelPinMin * 2, safeTile * 0.42);
  return Math.min(MAPCHROME.tap / 2, desired, tileCap);
}

/** Derive the one-codepoint public profile mark while pins are assembled, never
 * in the canvas paint loop. */
export function publicProfileInitial(profileName: string | null | undefined): string | undefined {
  const name = profileName?.trim();
  if (!name) return undefined;
  const first = name.codePointAt(0);
  return first === undefined ? undefined : String.fromCodePoint(first).toUpperCase();
}

/** A deed whose custom image is absent or not ready still reads as a player profile
 * once its tile is a full touch target. A public name contributes its initial; an
 * intentionally unnamed deed gets a neutral `?`, never an invented identity.
 * Authored Keep art remains the compact fallback at shallower zooms. */
export function parcelFallbackProfileInitial(
  pin: Pick<GlobePin, 'layer' | 'profileInitial'>,
  tileCss: number,
): string | null {
  if (pin.layer !== 'parcel' || !tileLabelled(tileCss)) return null;
  return pin.profileInitial ?? '?';
}

export type ParcelProfileDrawMode = 'avatar' | 'badge' | 'keep' | 'none';

/** The actual parcel draw precedence, kept pure so loading/error never regresses
 * to a square while a decoded custom image still wins immediately when ready. */
export function parcelProfileDrawMode(
  layer: GlobePin['layer'],
  avatarReady: boolean,
  avatarVisible: boolean,
  badgeReady: boolean,
  keepReady: boolean,
): ParcelProfileDrawMode {
  if (layer !== 'parcel') return 'none';
  if (avatarReady && avatarVisible) return 'avatar';
  if (badgeReady) return 'badge';
  if (keepReady) return 'keep';
  return 'none';
}

/** Keep server/roster order stable, except for the exact selected parcel. Canvas
 * paint is back-to-front and the label queue is consumed in reverse, so putting
 * selection last makes both its profile body and its label the first priority. */
export function selectedParcelPaintOrder<T extends Pick<GlobePin, 'layer' | 'cell'>>(
  pins: readonly T[],
  selectedCell: number | null,
): readonly T[] {
  if (selectedCell === null) return pins;
  let found = false;
  let misplaced = false;
  for (const pin of pins) {
    const selected = pin.layer === 'parcel' && pin.cell === selectedCell;
    if (selected) found = true;
    else if (found) misplaced = true;
  }
  if (!found || !misplaced) return pins;
  const ordered: T[] = [];
  for (const pin of pins) {
    if (pin.layer !== 'parcel' || pin.cell !== selectedCell) ordered.push(pin);
  }
  for (const pin of pins) {
    if (pin.layer === 'parcel' && pin.cell === selectedCell) ordered.push(pin);
  }
  return ordered;
}

/** A selected geographic cell and its selected profile use the same contrast
 * contract: opaque ink outside, bright gold inside. Width derives from the
 * existing parcel presentation scale rather than introducing another metric. */
export function strokeSelectedOutline(
  ctx: Pick<CanvasRenderingContext2D, 'strokeStyle' | 'lineWidth' | 'stroke'>,
  dpr: number,
): void {
  const innerWidth = Math.max(dpr, Math.round(GLOBE_VIEW.parcelPinMin * dpr));
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = innerWidth + dpr;
  ctx.stroke();
  ctx.strokeStyle = C.goldHi;
  ctx.lineWidth = innerWidth;
  ctx.stroke();
}

/** Selection/mine first, then ringed/owned targets, then ordinary profiles. */
export function parcelAvatarPriority(
  pin: Pick<GlobePin, 'layer' | 'avatarUrl' | 'mine' | 'ring' | 'owned' | 'cell'>,
  selectedCell: number | null = null,
): number {
  if (pin.layer !== 'parcel' || !pin.avatarUrl) return -1;
  if (selectedCell !== null && pin.cell === selectedCell) return 4;
  if (pin.mine) return 3;
  if (pin.ring) return 2;
  if (pin.owned) return 1;
  return 0;
}

/** A cell crossing the globe limb is withheld instead of joining far-side
 * projected corners into a giant polygon across the visible hemisphere. */
export function selectedCellQuadVisible(
  corners: readonly Pick<Projected, 'visible'>[],
  offset = 0,
): boolean {
  return corners.length >= offset + 4
    && corners[offset]!.visible && corners[offset + 1]!.visible
    && corners[offset + 2]!.visible && corners[offset + 3]!.visible;
}

/** Exact geographic bounds for a packed selected cell, used by the canvas
 * highlight and unit-tested without a browser canvas. */
export function selectedCellBounds(selected: {
  cell: number; cols: number; rows: number;
}): { west: number; east: number; north: number; south: number } | null {
  if (!Number.isInteger(selected.cell) || !Number.isInteger(selected.cols)
    || !Number.isInteger(selected.rows) || selected.cols <= 0 || selected.rows <= 0
    || selected.cell < 0 || selected.cell >= selected.cols * selected.rows) return null;
  const ix = selected.cell % selected.cols;
  const iy = Math.floor(selected.cell / selected.cols);
  const dLon = 360 / selected.cols;
  const dLat = 180 / selected.rows;
  return {
    west: -180 + ix * dLon,
    east: -180 + (ix + 1) * dLon,
    north: 90 - iy * dLat,
    south: 90 - (iy + 1) * dLat,
  };
}

type AvatarEntry = {
  image: HTMLImageElement;
  state: 'queued' | 'loading' | 'ready' | 'error';
  touched: number;
  retryAt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

export interface ParcelAvatarPool {
  /** Replace queued priority with the current ordered visible page. In-flight
   * reads finish; stale work that has not started cannot delay a newly selected
   * parcel after a pan. */
  prioritize(urls: readonly string[]): void;
  request(url: string): boolean;
  ready(url: string): HTMLImageElement | null;
  dispose(): void;
}

/** Visible-only, deduplicated image queue. The label budget is also the network
 * concurrency budget, so opening a full valley never starts hundreds of images. */
export function createParcelAvatarPool(
  changed: () => void,
  makeImage: () => HTMLImageElement = () => new Image(),
  maxConcurrent: number = GLOBE_VIEW.labelMax,
  maxEntries: number = GLOBE_VIEW.labelMax * GLOBE_VIEW.labelMax,
): ParcelAvatarPool {
  const entries = new Map<string, AvatarEntry>();
  const queue: string[] = [];
  let active = 0;
  let clock = 0;
  let stopped = false;
  const pump = (): void => {
    while (!stopped && active < maxConcurrent && queue.length > 0) {
      const url = queue.shift()!;
      const entry = entries.get(url);
      if (!entry || entry.state !== 'queued') continue;
      entry.state = 'loading';
      active++;
      entry.image.decoding = 'async';
      entry.image.referrerPolicy = 'no-referrer';
      entry.image.onload = () => {
        active--;
        if (!stopped) { entry.state = 'ready'; changed(); pump(); }
      };
      entry.image.onerror = () => {
        active--;
        if (!stopped) {
          entry.state = 'error';
          entry.retryAt = Date.now() + WORLD.mapPollSec * 1_000;
          entry.retryTimer = globalThis.setTimeout(() => {
            entry.retryTimer = null;
            if (!stopped && entries.get(url) === entry && entry.state === 'error') changed();
          }, WORLD.mapPollSec * 1_000);
          changed();
          pump();
        }
      };
      entry.image.src = url;
    }
  };
  return {
    prioritize(urls) {
      const desired = new Set(urls);
      // A queued image has no network request yet, so dropping it is exact and
      // prevents an old viewport consuming several later concurrency waves.
      for (const [url, entry] of entries) {
        if (entry.state !== 'queued' || desired.has(url)) continue;
        entries.delete(url);
      }
      // If the current page plus old in-flight requests would exceed the cache,
      // retire offscreen completed/error entries first. Loading requests are
      // intentionally not cancelled; browser cancellation is not deterministic.
      const missing = urls.reduce((count, url) => count + (entries.has(url) ? 0 : 1), 0);
      let overflow = Math.max(0, entries.size + missing - maxEntries);
      if (overflow > 0) {
        const stale = [...entries].filter(([url, entry]) =>
          !desired.has(url) && entry.state !== 'loading' && entry.state !== 'queued')
          .sort((a, b) => a[1].touched - b[1].touched);
        for (const [url, entry] of stale) {
          if (overflow <= 0) break;
          if (entry.retryTimer !== null) globalThis.clearTimeout(entry.retryTimer);
          entry.image.onload = null;
          entry.image.onerror = null;
          entries.delete(url);
          overflow--;
        }
      }
      queue.splice(0, queue.length, ...urls.filter((url) => entries.get(url)?.state === 'queued'));
    },
    request(url) {
      const prior = entries.get(url);
      if (prior) {
        prior.touched = ++clock;
        if (prior.state !== 'error' || Date.now() < prior.retryAt) return false;
        if (prior.retryTimer !== null) globalThis.clearTimeout(prior.retryTimer);
        prior.image.onload = null;
        prior.image.onerror = null;
        entries.delete(url);
      }
      if (entries.size >= maxEntries) {
        let oldest: [string, AvatarEntry] | null = null;
        for (const item of entries) {
          if (item[1].state === 'loading' || item[1].state === 'queued') continue;
          if (!oldest || item[1].touched < oldest[1].touched) oldest = item;
        }
        if (!oldest) return false;
        if (oldest[1].retryTimer !== null) globalThis.clearTimeout(oldest[1].retryTimer);
        oldest[1].image.onload = null;
        oldest[1].image.onerror = null;
        entries.delete(oldest[0]);
      }
      entries.set(url, {
        image: makeImage(), state: 'queued', touched: ++clock, retryAt: 0, retryTimer: null,
      });
      queue.push(url);
      pump();
      return true;
    },
    ready(url) {
      const entry = entries.get(url);
      if (!entry || entry.state !== 'ready') return null;
      entry.touched = ++clock;
      return entry.image;
    },
    dispose() {
      stopped = true;
      queue.length = 0;
      for (const entry of entries.values()) {
        if (entry.retryTimer !== null) globalThis.clearTimeout(entry.retryTimer);
        entry.image.onload = null;
        entry.image.onerror = null;
      }
      entries.clear();
    },
  };
}

export interface VisibleParcelAvatar {
  pin: GlobePin;
  x: number;
  y: number;
  radius: number;
}

/** Admit the bounded on-canvas page independently of canvas label collisions. */
export function requestVisibleParcelAvatars(
  pool: Pick<ParcelAvatarPool, 'request'> & Partial<Pick<ParcelAvatarPool, 'prioritize'>>,
  candidates: VisibleParcelAvatar[],
  selectedCell: number | null,
  viewport: { width: number; height: number },
): void {
  const visible = candidates.filter(({ x, y, radius }) =>
    x + radius >= 0 && x - radius <= viewport.width
    && y + radius >= 0 && y - radius <= viewport.height);
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  visible.sort((a, b) => {
    const priority = parcelAvatarPriority(b.pin, selectedCell)
      - parcelAvatarPriority(a.pin, selectedCell);
    if (priority !== 0) return priority;
    return (a.x - cx) ** 2 + (a.y - cy) ** 2
      - ((b.x - cx) ** 2 + (b.y - cy) ** 2);
  });
  const requestCap = GLOBE_VIEW.labelMax * GLOBE_VIEW.labelMax;
  const page = visible.slice(0, requestCap);
  const urls = page.flatMap(({ pin }) => pin.avatarUrl ? [pin.avatarUrl] : []);
  pool.prioritize?.(urls);
  for (const { pin } of page) {
    const url = pin.avatarUrl;
    if (url) pool.request(url);
  }
}

/** Layer opacity, kept pure so the home-beacon invariant is asserted directly. */
export function globePinAlpha(
  pin: Pick<GlobePin, 'layer' | 'persistent'>, mix: BandMix,
): number {
  if (pin.persistent) return mix.earth;
  return pin.layer === 'sector'
    ? mix.sectorPins
    : pin.layer === 'valley' ? mix.valleyPins : mix.parcelPins;
}

/** The single public address grammar for owned land on the globe. Allocation
 * coordinates remain available to legacy requests, but never identify a deed. */
export function deedEarthCellLabel(prefix: string, earthCell: number): string {
  return `${prefix} · EARTH CELL ${earthCell}`;
}

/** Build the one uncapped home marker from the private persisted address. */
export function deedHomeBeacon(
  parcel: { earthCell: number; x: number; y: number },
  at: { lon: number; lat: number },
): GlobePin {
  return {
    key: `home-${parcel.earthCell}`,
    layer: 'parcel',
    lon: at.lon,
    lat: at.lat,
    r: GLOBE_VIEW.parcelPinMax,
    ring: true,
    mine: true,
    cell: parcel.earthCell,
    persistent: true,
    label: deedEarthCellLabel('YOUR PARCEL', parcel.earthCell),
  };
}

/**
 * Build one persistent marker for every plotted base owned by the wallet.
 * Selection is deliberately separate from ownership: switching bases changes
 * which marker pulses, never which deeds exist on the globe.
 *
 * THE BEACON WEARS ITS OWNER'S FACE (D-096). `/globe` `me.ownedParcels` carries the
 * owner's name, avatar URL and this base's keep level (viewer-private), so the
 * beacon draws them itself instead of waiting for the public parcel page to happen
 * to include the same cell — which is why the owner used to see "?" on their own
 * base. The served row is the ONLY source (D-097): the one-release override from
 * the base directory and the current player's name is gone, so the beacon can
 * never disagree with the server about whose base it is. "?" is reached only when
 * the served name is genuinely empty.
 */
export function deedOwnedBeacon(
  owned: {
    baseId: string;
    active: boolean;
    parcel: { earthCell: number; x: number; y: number };
    name: string;
    avatarUrl: string | null;
    keepLevel: number;
  },
  at: { lon: number; lat: number },
  selected: boolean,
): GlobePin {
  const name = owned.name.trim() || undefined;
  return {
    key: `owned-${owned.baseId}`,
    layer: 'parcel',
    lon: at.lon,
    lat: at.lat,
    r: GLOBE_VIEW.parcelPinMax,
    ring: true,
    mine: selected,
    owned: true,
    baseId: owned.baseId,
    active: owned.active,
    cell: owned.parcel.earthCell,
    persistent: true,
    keepLevel: owned.keepLevel,
    avatarUrl: owned.avatarUrl,
    profileInitial: publicProfileInitial(name),
    // A named owner is labelled by name, like every other parcel on the band; the
    // cell address remains the label for an unnamed deed so the beacon still says
    // whose it is and where.
    label: name ?? deedEarthCellLabel(
      selected ? 'SELECTED BASE' : owned.active ? 'YOUR BASE' : 'YOUR INACTIVE BASE',
      owned.parcel.earthCell,
    ),
  };
}

export const PixelGlobe = memo(function PixelGlobe({
  vw, vh, mask, pins, selectedCell, reduceMotion, controlRef, layerRef,
  onNav, onPinTap, onEmptyTap,
}: PixelGlobeProps): React.JSX.Element {
  const cvRef = useRef<HTMLCanvasElement>(null);
  // Reuse the map atlas already fetched by BootScene/local-map React. It carries
  // the five authored keep silhouettes, so this adds no icon root or dependency.
  const mapAtlas = useMapAtlas();
  const paintPins = useMemo(
    () => selectedParcelPaintOrder(pins, selectedCell?.cell ?? null),
    [pins, selectedCell?.cell],
  );

  // --- live state, none of it React ----------------------------------------
  // MOUNTS AT THE LOCAL BAND, i.e. fully faded OUT. The layer is created the
  // moment the GLOBE button is pressed but the camera does not know where the
  // player lives until /globe answers, so a globe seeded at zoomMin would paint
  // one frame of the WRONG hemisphere and then jump. Starting invisible means the
  // first thing anyone sees is the pull-out from their own valley.
  const navRef = useRef<GlobeNav>({ lam0: 0, phi0: 0.35, zoom: GLOBE.localZoom });
  const velRef = useRef({ lam: 0, phi: 0 });
  /** `ms` is per-tween: a descend is GLOBE_VIEW.tweenMs, a SETTLE is the much
   *  shorter GLOBE_VIEW.settleMs (it corrects a resting state nobody asked for). */
  const tweenRef = useRef<{ from: GlobeNav; to: GlobeNav; t0: number; ms: number } | null>(null);
  const interactedRef = useRef(false);
  const dirtyRef = useRef(true);
  const frameRef = useRef(0);
  const sizeRef = useRef({ vw, vh });
  sizeRef.current = { vw, vh };
  const maskRef = useRef(mask);
  maskRef.current = mask;
  const pinsRef = useRef(paintPins);
  pinsRef.current = paintPins;
  const selectedCellRef = useRef(selectedCell);
  selectedCellRef.current = selectedCell;
  const mapAtlasRef = useRef(mapAtlas);
  mapAtlasRef.current = mapAtlas;
  const rmRef = useRef(reduceMotion);
  rmRef.current = reduceMotion;
  const cbRef = useRef({ onNav, onPinTap, onEmptyTap });
  cbRef.current = { onNav, onPinTap, onEmptyTap };
  /** Projected pin centres in CSS px, refreshed every paint — the hit list. */
  const hitsRef = useRef<Array<{ pin: GlobePin; x: number; y: number; r: number }>>([]);
  const fpsRef = useRef({ frames: 0, since: 0, fps: 0, frameMs: 0, ticks: 0, awake: true });
  /** The tile band as last drawn: one 0.5° cell's height in CSS px, and how many
   *  label plates the ladder let through. Written by the paint, read by `stats()`,
   *  so both are measurements rather than claims. */
  const tileRef = useRef({ px: 0, labels: 0 });
  /** Label plate boxes (device px, 4 numbers each) and the queued pin labels — both
   *  reused every frame, because the pin pass allocates nothing. */
  const boxRef = useRef<number[]>([]);
  const labelQRef = useRef<Array<{ pin: GlobePin; x: number; y: number; r: number; a: number }>>([]);
  /** Reused visible-avatar priority queue. Only its bounded first page is asked
   * from the pool, so a 491-base valley cannot turn one frame into 491 requests. */
  const avatarQRef = useRef<VisibleParcelAvatar[]>([]);
  const selectedProjRef = useRef([
    newProjected(), newProjected(), newProjected(), newProjected(), newProjected(),
  ]);
  /**
   * A pointer is DOWN on this layer, so it owns pointer events no matter what the
   * band says. THE LATCH: `pointerEvents` is written from the rAF, so without this
   * a pinch that crosses a band edge had the surface pulled out from under it
   * mid-stroke — hit-testing fell through to the local map and the gesture died.
   * Hysteresis narrows that window; only a latch closes it.
   */
  const heldRef = useRef(false);
  /** Previous pointer-ownership answer — the other input to the hysteresis. */
  const interactiveRef = useRef(false);
  /**
   * The instant the terminator is drawn for. Advanced by a LOW-FREQUENCY tick, not
   * read from the clock inside the paint: the paint only runs when the camera moved,
   * so `Date.now()` in there meant a stationary globe's day/night line never moved
   * at all. See GLOBE_VIEW.sunTickMs.
   */
  const sunRef = useRef(Date.now());

  /** Ask for a repaint. Also WAKES the loop, which is what makes sleeping safe:
   *  every path that changes what is on screen goes through here. */
  const wakeRef = useRef<() => void>(() => {});
  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    wakeRef.current();
  }, []);

  /**
   * The earth raster, and it is handed `markDirty` for ONE reason: the EARTH TILES
   * country index is a DYNAMIC import, so it lands one or two frames after the mask
   * it belongs to, and this loop sleeps the moment nothing is owed. Without the
   * wake, a player who opened the globe and then did not touch it would keep
   * looking at the silhouette until their next gesture — the same class of bug as
   * the frozen terminator `sunRef` exists to fix. `markDirty` is identity-stable,
   * so the raster still lives for the lifetime of the component.
   */
  const raster = useMemo(() => createEarthRaster(markDirty), [markDirty]);
  const avatarPool = useMemo(() => createParcelAvatarPool(markDirty), [markDirty]);
  useEffect(() => () => avatarPool.dispose(), [avatarPool]);

  const commit = useCallback(() => {
    cbRef.current.onNav({ ...navRef.current });
  }, []);

  /**
   * SETTLE — THE CAMERA MAY NOT COME TO REST INSIDE THE CROSS-FADE. (fixed 2026-08-09)
   *
   * Nothing used to do this, and the consequence was the worst state the globe could
   * reach: release a pinch or a wheel anywhere in [localZoom − fade, localZoom) and
   * the RESTING picture was `earth` strictly between 0 and 1 — a frozen
   * part-opacity planet, its opaque space backdrop dimming the valley underneath,
   * ghost pins over the terrain and a second, ghosted set of chrome in the same
   * slots as the board's. Permanently: the loop sleeps once nothing is owed, so no
   * later frame existed to resolve it and reload was the only way out.
   *
   * So every gesture boundary asks `settleZoom` which band the camera actually
   * belongs to and tweens there, keeping the loop awake (a live tween is "owed")
   * until it lands. Outside the fade band it is a no-op, so ordinary zooming — and
   * the whole REGION band, which is a real place to sit and read a sector — is
   * untouched. Idempotent by construction, which is what stops the tween that ends
   * on an edge from settling forever.
   *
   * It also zeroes the inertial spin: a settle that a leftover spin kept overwriting
   * would never finish, and a gesture that ended inside the fade band was a pinch,
   * which carries no spin anyway (the second finger's pointerdown calls stopMotion).
   */
  const settle = useCallback((): boolean => {
    const cur = navRef.current;
    const z = settleZoom(cur.zoom);
    if (z === cur.zoom) return false;
    velRef.current = { lam: 0, phi: 0 };
    tweenRef.current = {
      from: { ...cur }, to: clampNav({ ...cur, zoom: z }),
      t0: performance.now(), ms: GLOBE_VIEW.settleMs,
    };
    // markDirty, not a bare dirty flag: the loop may already be asleep, and an
    // unwoken settle is exactly the frozen half-planet this function exists to stop.
    markDirty();
    return true;
  }, [markDirty]);

  const commitTimer = useRef(0);
  const commitSoon = useCallback(() => {
    window.clearTimeout(commitTimer.current);
    // The debounced end of a wheel / rail-button / pinch zoom IS a gesture boundary,
    // so it settles as well as commits — that is the path a wheel released mid-fade
    // takes, and it used to be the one that stranded the layer.
    commitTimer.current = window.setTimeout(() => { commit(); settle(); }, 140);
  }, [commit, settle]);
  useEffect(() => () => window.clearTimeout(commitTimer.current), []);

  // --- the ONE rAF, WHICH SLEEPS -------------------------------------------
  //
  // It used to re-arm unconditionally, and the layer is deliberately never
  // unmounted (map.tsx: the band change has to be a cross-fade over a live local
  // map, so there is nothing to show a loading state). One GLOBE tap therefore
  // left TWO rAF loops running on the map screen for the rest of the session — a
  // 60 Hz main-thread wake that stops the browser idling, on top of the local
  // map's own loop and its 20 s poll, forever, with nothing on screen to show for
  // it.
  //
  // So the loop now stops when there is provably nothing to do — nothing tweening,
  // no inertia, no idle spin owed, nothing dirty, no finger down — and every path
  // that changes the picture goes through `markDirty`, which wakes it. That is the
  // invariant to preserve when touching this file: NO WRITE TO A REF THAT AFFECTS
  // THE PICTURE WITHOUT A markDirty.
  useEffect(() => {
    let last = performance.now();
    let raf = 0;
    let stopped = false;
    const schedule = (): void => {
      if (raf || stopped) return;
      // A wake after a SLEEP must not integrate the whole idle gap as one frame:
      // `last` is stale by however long we were asleep, and dt drives the inertial
      // and idle spins. Re-arming a running loop must NOT touch it, or dt would
      // always read ~0 and both spins would stall.
      if (!fpsRef.current.awake) last = performance.now();
      raf = requestAnimationFrame(tick);
      frameRef.current = raf;
      fpsRef.current.awake = true;
    };
    const tick = (now: number): void => {
      raf = 0;
      frameRef.current = 0;
      fpsRef.current.ticks++;
      const dt = Math.min(64, now - last);
      last = now;
      const { vw: w, vh: h } = sizeRef.current;
      if (w <= 0 || h <= 0) { schedule(); return; }

      const before = navRef.current;
      let nav = before;
      const mixBefore = bandMix(before.zoom);
      const bandBefore = mixBefore.band;
      const keyBefore = bandKey(mixBefore);

      // 1. tween (a descend / recentre) wins over everything.
      const tw = tweenRef.current;
      if (tw) {
        const p = Math.min(1, (now - tw.t0) / tw.ms);
        // easeInOutQuad — a descend that decelerates reads as arriving somewhere.
        const e = p < 0.5 ? 2 * p * p : 1 - 2 * (1 - p) * (1 - p);
        const dLam = ((tw.to.lam0 - tw.from.lam0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        nav = {
          lam0: tw.from.lam0 + dLam * e,
          phi0: tw.from.phi0 + (tw.to.phi0 - tw.from.phi0) * e,
          zoom: tw.from.zoom + (tw.to.zoom - tw.from.zoom) * e,
        };
        // A tween can END inside the fade band — `zoom + 1` from a double-tap at 2.9
        // lands on 3.9 — so its completion is a gesture boundary like any other and
        // has to settle. `settle` is idempotent, so a tween that finished on an edge
        // (every descend and every recentre) starts nothing.
        //
        // PUBLISH THE CAMERA THE TWEEN LANDED ON, NOT THE ONE BEFORE IT. (2026-08-10)
        // `commit` and `settle` both read `navRef`, which is not written until below,
        // so a tween end used to publish the PREVIOUS frame's camera: one frame stale
        // at 60 Hz and invisible, but a whole flight stale whenever a tween completes
        // in a single tick (a background tab, one very long frame). The chrome then
        // described a camera nobody was looking at — after a MY PARCEL flight it
        // still said PINCH IN TO PICK A PARCEL while parcel taps were already live —
        // and `settle` decided which band to rest in from the zoom the flight started
        // at.
        if (p >= 1) {
          tweenRef.current = null;
          navRef.current = clampNav(nav);
          nav = navRef.current;
          commit();
          settle();
        }
        dirtyRef.current = true;
      } else if (velRef.current.lam !== 0 || velRef.current.phi !== 0) {
        // 2. inertial spin after a release.
        const v = velRef.current;
        const k = GLOBE_VIEW.inertiaDecay ** (dt / 16);
        v.lam *= k;
        v.phi *= k;
        if (Math.abs(v.lam) < GLOBE_VIEW.inertiaStop && Math.abs(v.phi) < GLOBE_VIEW.inertiaStop) {
          v.lam = 0; v.phi = 0;
          commit();
          // The spin is over ⇒ this is where the camera actually comes to rest, so
          // it is the last place a stranded zoom can still be caught.
          settle();
        } else {
          nav = { lam0: before.lam0 + v.lam * (dt / 16), phi0: before.phi0 + v.phi * (dt / 16), zoom: before.zoom };
          dirtyRef.current = true;
        }
      } else if (!interactedRef.current && !rmRef.current && bandBefore === 'globe') {
        // 3. idle spin — arrival charm only. One interaction ends it for good, and
        //    prefers-reduced-motion never starts it.
        nav = { ...before, lam0: before.lam0 + GLOBE_VIEW.idleSpinDegSec * (Math.PI / 180) * (dt / 1000) };
        dirtyRef.current = true;
      }

      if (nav !== before) navRef.current = clampNav(nav);
      // A stationary globe does ZERO work: no draw, no allocation, no GC.
      if (dirtyRef.current) {
        dirtyRef.current = false;
        paint(now);

        const f = fpsRef.current;
        f.frames++;
        if (now - f.since >= 1000) {
          f.fps = (f.frames * 1000) / (now - f.since);
          f.frames = 0;
          f.since = now;
        }
        // A BAND CHANGE IS A COMMIT, and "band" here is the fine-grained one
        // (`bandKey`): the chrome's words, the pin list and the parcel fetch all
        // hang off it, so a pinch that sails through an edge must not keep drawing
        // the deeper band with the shallower band's data.
        if (bandKey(bandMix(navRef.current.zoom)) !== keyBefore) commit();
      }

      // Anything still owed a frame? A tween, an inertial spin, the arrival spin,
      // a repaint asked for since this frame started, or a finger on the layer.
      // Note the idle-spin term reads the LIVE band: once the camera has left the
      // globe band there is no spin owed, which is what lets a faded-out globe stop
      // entirely instead of idling at 60 Hz behind the local map.
      const owed = tweenRef.current !== null
        || velRef.current.lam !== 0 || velRef.current.phi !== 0
        || dirtyRef.current
        || heldRef.current
        || (!interactedRef.current && !rmRef.current
          && bandMix(navRef.current.zoom).band === 'globe');
      if (owed) { schedule(); return; }
      // ASLEEP. `markDirty` (props, sun tick, gestures, the imperative control) is
      // the only way back, and every one of those calls it.
      fpsRef.current.awake = false;
      fpsRef.current.fps = 0;
      fpsRef.current.frames = 0;
    };

    function paint(now: number): void {
      const cv = cvRef.current;
      const { vw: w, vh: h } = sizeRef.current;
      if (!cv) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const t0 = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, bw, bh);

      // Quantise to whole RASTER pixels so the coastlines do not shimmer as the
      // planet turns. Done here, not in the gesture, so inertia and the idle spin
      // are quantised too.
      const R = radiusPx(navRef.current.zoom, Math.min(w, h));
      const nav = quantiseNav(navRef.current, (R * GLOBE.px) / Math.max(1, h));
      const mix = bandMix(nav.zoom, interactiveRef.current);
      interactiveRef.current = mix.interactive;

      // THE LATCH. While a finger is down this layer keeps the pointer surface
      // whatever the band says: a pinch crossing a band edge used to have
      // `pointer-events` set to none from underneath it, at which point hit-testing
      // fell through to the local map and the gesture died mid-stroke. Pinch never
      // takes pointer capture (capture is single-finger-drag only), so the latch is
      // the only thing that can hold it — and `visibility` has to be latched too,
      // for exactly the same reason.
      const held = heldRef.current;
      const layer = layerRef.current;
      if (layer) {
        layer.style.opacity = String(Math.round(mix.earth * 100) / 100);
        layer.style.pointerEvents = held || mix.interactive ? 'auto' : 'none';
        layer.style.visibility = !held && mix.earth <= 0.002 ? 'hidden' : 'visible';
      }

      if (mix.earth > 0.002) {
        // sunRef, never Date.now(): the paint runs only when something moved, so
        // reading the clock here froze the terminator on a stationary globe.
        raster.draw(ctx, {
          vw: w, vh: h, dpr, nav, mask: maskRef.current, sunMs: sunRef.current, alpha: mix.earth,
          // Read from the module, not from a prop: nothing above this component
          // should be able to change which planet is being drawn mid-session, and
          // GlobeLayer (which owns the props) is a later phase's file.
          tiles: EARTH_TILES,
        });
      }
      drawPins(ctx, nav, w, h, dpr, mix, now);
      fpsRef.current.frameMs = performance.now() - t0;
    }

    /**
     * Pins and labels, in SCREEN space at device resolution — sharp text over chunky
     * pixels, and zero DOM. Also refreshes the CSS-px hit list.
     *
     * THE LABEL LADDER LIVES HERE, not in React, and that is deliberate: React sees
     * the camera only at gesture boundaries, so a zoom-gated label decided upstream
     * would appear a beat late (or, mid-pinch, not at all). The ladder is
     * `GLOBE_VIEW.labelMax` plates per frame, in priority order, with a rejection
     * test — see the plate helper.
     */
    function drawPins(
      ctx: CanvasRenderingContext2D, nav: GlobeNav,
      w: number, h: number, dpr: number,
      mix: BandMix, now: number,
    ): void {
      const { sectorPins: aSector, valleyPins: aValley, parcelPins: aParcel } = mix;
      const list = pinsRef.current;
      const hits = hitsRef.current;
      hits.length = 0;
      // ONE 0.5° TILE'S HEIGHT IN CSS px — the number the whole ladder is measured
      // in, and the one `stats()` reports so the band can be checked from the running
      // app. Computed before the early return because the country names below z1
      // exist with no pins at all.
      const tileCss = tilePx(nav.zoom, Math.min(w, h));
      const boxes = boxRef.current;
      boxes.length = 0;
      const fs = Math.round(12 * dpr);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `${fs}px VT323, monospace`;

      // Selection is ground, not a marker: draw its exact geographic quad even
      // when the parcel has no avatar, the atlas is late, or detail is pending.
      const selected = selectedCellRef.current;
      const bounds = selected ? selectedCellBounds(selected) : null;
      if (bounds && mix.earth > 0.01) {
        const cam = navCamera(nav, w, h, dpr);
        const projected = selectedProjRef.current;
        const centre = projected[0]!;
        projectDeg((bounds.west + bounds.east) / 2, (bounds.north + bounds.south) / 2, cam, centre);
        if (centre.visible) {
          projectDeg(bounds.west, bounds.north, cam, projected[1]);
          projectDeg(bounds.east, bounds.north, cam, projected[2]);
          projectDeg(bounds.east, bounds.south, cam, projected[3]);
          projectDeg(bounds.west, bounds.south, cam, projected[4]);
          if (selectedCellQuadVisible(projected, 1)) {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(projected[1]!.x, projected[1]!.y);
            for (let i = 2; i < projected.length; i++) ctx.lineTo(projected[i]!.x, projected[i]!.y);
            ctx.closePath();
            ctx.globalAlpha = mix.earth * 0.34;
            ctx.fillStyle = C.gold;
            ctx.fill();
            ctx.globalAlpha = mix.earth;
            strokeSelectedOutline(ctx, dpr);
            ctx.restore();
          }
        }
      }

      /**
       * ONE LABEL PLATE, and the two rules that keep 86,122 tiles from becoming a
       * field of text.
       *
       * `collide` false is the SHIPPED path, byte for byte: with EARTH TILES off
       * every label is drawn exactly as it was, un-gated and un-capped, because that
       * is what the flag guarantees. With the flag on, a plate is refused if the
       * budget is spent or if it would overlap one already placed — which is why the
       * callers draw in PRIORITY order (biggest country first, own pin first), so the
       * label that loses a collision is always the less important one.
       */
      // The plate budget for THIS frame. The hard cap until the pin pass has counted
      // how many parcel markers actually landed on the canvas; `labelBudget` then
      // decides whether a sparse neighbourhood may name every one of them (D-096).
      let budget: number = GLOBE_VIEW.labelMax;
      const plate = (
        text: string, x: number, top: number, alpha: number, colour: string, collide: boolean,
      ): boolean => {
        const tw = ctx.measureText(text).width;
        const x0 = x - tw / 2 - 3 * dpr;
        const x1 = x + tw / 2 + 3 * dpr;
        const y1 = top + fs + 2 * dpr;
        if (collide) {
          if (boxes.length >= budget * 4) return false;
          for (let i = 0; i < boxes.length; i += 4) {
            if (x0 < boxes[i + 2]! && x1 > boxes[i]! && top < boxes[i + 3]! && y1 > boxes[i + 1]!) return false;
          }
          boxes.push(x0, top, x1, y1);
        }
        ctx.globalAlpha = alpha * 0.85;
        ctx.fillStyle = 'rgba(26,23,30,.86)';
        ctx.fillRect(x0, top, x1 - x0, y1 - top);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = colour;
        ctx.fillText(text, x, top);
        return true;
      };

      // --- COUNTRY NAMES, the only labels below z1 ---------------------------
      // They fade on `sectorPins`, i.e. exactly with the GLOBE band's own layer, so
      // they are gone by the time the fine mask arrives and the chrome takes over the
      // job (the crosshair country). Anchors come from the raster's own pass, in
      // raster px, biggest visible first — so the budget spends itself on the
      // countries that actually fill the disc.
      if (EARTH_TILES && aSector > 0.01) {
        const k = (h / GLOBE.px) * dpr;
        for (const c of raster.labels) {
          plate(c.name.toUpperCase(), Math.round(c.x * k), Math.round(c.y * k - fs / 2),
            aSector, C.text, true);
        }
      }

      const persistentLive = mix.earth > 0.01 && list.some((pin) => pin.persistent === true);
      if (list.length === 0
        || (aSector <= 0.01 && aValley <= 0.01 && aParcel <= 0.01 && !persistentLive)) {
        ctx.restore();
        tileRef.current = { px: tileCss, labels: boxes.length / 4 };
        return;
      }
      const cam = navCamera(nav, w, h, dpr);
      const p = newProjected();
      // 1.1 s pulse, the same period the map's revenge badge and NEXT tag use.
      const pulse = 0.55 + 0.45 * Math.abs(1 - ((now % 1100) / 550));
      const q = labelQRef.current;
      q.length = 0;
      const avatarQ = avatarQRef.current;
      avatarQ.length = 0;
      /** Parcel markers that landed on the canvas this frame — the sparse-budget input. */
      let parcelsOnCanvas = 0;
      for (const pin of list) {
        const a = globePinAlpha(pin, mix);
        if (a <= 0.01) continue;
        // EVERY PIN IS DRAWN WHERE IT ACTUALLY IS. A parcel used to be handed its
        // VALLEY's lon/lat and displaced on a screen-space lattice; it now carries the
        // centre of its own Earth cell (P4b), so this loop has one case, not two.
        projectDeg(pin.lon, pin.lat, cam, p);
        if (!p.visible) continue;
        let r = Math.max(1, Math.round(pin.r * dpr));
        const x = Math.round(p.x);
        const y = Math.round(p.y);
        if (pin.layer === 'parcel' && aParcel > 0.01
          && x >= 0 && x <= w * dpr && y >= 0 && y <= h * dpr) parcelsOnCanvas++;
        const isSelectedParcel = selected !== null
          && pin.layer === 'parcel' && pin.cell === selected.cell;
        if (aParcel > 0.01 && parcelAvatarPriority(pin, selected?.cell ?? null) >= 0) {
          const avatarRadius = Math.max(
            r,
            Math.ceil(parcelKeepWidthPx(pin.r, tileCss) * dpr / 2),
          );
          avatarQ.push({ pin, x, y, radius: avatarRadius });
        }
        ctx.globalAlpha = a;
        const keepKey = pin.layer === 'parcel' ? parcelKeepFrame(pin.keepLevel) : null;
        const atlas = mapAtlasRef.current;
        const frame = keepKey ? atlas?.frame(keepKey) ?? null : null;
        const avatar = pin.avatarUrl ? avatarPool.ready(pin.avatarUrl) : null;
        const profileInitial = parcelFallbackProfileInitial(pin, tileCss);
        // The authored Keep is the stable fallback at every band. Custom avatars
        // load only in the detailed parcel band, independently of label collisions.
        const drawKeep = frame !== null && atlas !== null;
        // Readiness, not URL presence, chooses the fallback. A custom image may be
        // loading or retrying; that deed remains a profile badge instead of
        // reverting to the square Keep silhouette until the decoded image is ready.
        const fallbackMark = !avatar
          ? profileInitial
            ?? (pin.layer === 'parcel' && pin.persistent && !drawKeep ? '?' : null)
          : null;
        const profileMode = parcelProfileDrawMode(
          pin.layer,
          avatar !== null,
          !pin.persistent || aParcel > 0.01,
          fallbackMark !== null,
          drawKeep,
        );
        if (profileMode === 'avatar' && avatar) {
          const dw = Math.max(1, Math.round(parcelKeepWidthPx(pin.r, tileCss) * dpr));
          r = Math.ceil(dw / 2);
          const sw = avatar.naturalWidth || avatar.width;
          const sh = avatar.naturalHeight || avatar.height;
          const side = Math.max(1, Math.min(sw, sh));
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.clip();
          ctx.imageSmoothingEnabled = true;
          ctx.globalAlpha = a;
          ctx.drawImage(avatar, (sw - side) / 2, (sh - side) / 2, side, side,
            x - r, y - r, r * 2, r * 2);
          ctx.restore();
          ctx.globalAlpha = a;
          ctx.strokeStyle = pin.mine || pin.owned ? C.goldHi : C.textDim;
          ctx.lineWidth = Math.max(1, Math.round(2 * dpr));
          ctx.beginPath();
          ctx.arc(x, y, r + dpr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.imageSmoothingEnabled = false;
        } else if (profileMode === 'badge' && fallbackMark) {
          const dw = Math.max(1, Math.round(parcelKeepWidthPx(pin.r, tileCss) * dpr));
          r = Math.ceil(dw / 2);
          ctx.save();
          ctx.globalAlpha = a;
          ctx.fillStyle = C.ink;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = pin.mine || pin.owned ? C.goldHi : C.textDim;
          ctx.lineWidth = Math.max(1, Math.round(2 * dpr));
          ctx.stroke();
          ctx.fillStyle = pin.mine || pin.owned ? C.goldHi : C.text;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = `${Math.max(8, Math.round(dw * 0.72))}px VT323, monospace`;
          ctx.fillText(fallbackMark, x, y + Math.round(dpr * 0.25));
          ctx.restore();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.font = `${fs}px VT323, monospace`;
          ctx.globalAlpha = a;
        } else if (profileMode === 'keep' && frame && atlas) {
          const dw = Math.max(1, Math.round(parcelKeepWidthPx(pin.r, tileCss) * dpr));
          const dh = Math.max(1, Math.round(dw * frame.h / frame.w));
          r = Math.ceil(Math.max(dw, dh) / 2);
          ctx.globalAlpha = a * (pin.mine ? 1 : pin.owned ? 0.84 : 0.68);
          ctx.drawImage(pin.owned ? atlas.sheet : atlas.gray,
            frame.x, frame.y, frame.w, frame.h,
            Math.round(x - dw / 2), Math.round(y - dh / 2), dw, dh);
          ctx.globalAlpha = a;
        } else if (pin.layer !== 'parcel') {
          // Sector/valley pins retain the shipped square language. Parcels wait
          // for the retryable authored atlas instead of flashing the obsolete
          // generic square during loading or a transient atlas failure.
          ctx.fillStyle = C.ink;
          ctx.fillRect(x - r - 1, y - r - 1, r * 2 + 2, r * 2 + 2);
          ctx.fillStyle = pin.mine
            ? C.goldHi
            : pin.owned ? (pin.active === false ? C.stoneDark : C.gold)
              : pin.ring ? C.gold : C.textDim;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
        if (pin.ring || pin.mine || isSelectedParcel) {
          // THE GOLD RING: "there are targets in your window here". Owner
          // decision 1 — reach is a highlight, so it is drawn ON TOP of a
          // fully-visible planet, never used to dim the rest of it.
          ctx.globalAlpha = a * (pin.mine ? pulse : 1);
          const ringColour = pin.mine
            ? C.goldHi
            : pin.owned && pin.active === false ? C.stoneDark : C.gold;
          const ringWidth = Math.max(1, Math.round(2 * dpr));
          const g = Math.round(3 * dpr);
          if (pin.layer === 'parcel') {
            ctx.beginPath();
            ctx.arc(x, y, r + g, 0, Math.PI * 2);
            if (isSelectedParcel) strokeSelectedOutline(ctx, dpr);
            else {
              ctx.strokeStyle = ringColour;
              ctx.lineWidth = ringWidth;
              ctx.stroke();
            }
          } else {
            ctx.strokeStyle = ringColour;
            ctx.lineWidth = ringWidth;
            ctx.strokeRect(x - r - g, y - r - g, (r + g) * 2, (r + g) * 2);
          }
          ctx.globalAlpha = a;
        }
        if (pin.label) {
          // FLAG OFF: drawn inline, un-gated, exactly as it shipped. FLAG ON: queued,
          // so the labels are drawn after every body (a later pin can no longer
          // half-cover an earlier label) and in reverse — `pins` is ordered
          // small-first / mine-last, so reverse is most-important-first, which is the
          // order the budget has to be spent in. `paintPins` explicitly moves the
          // selected exact-cell profile last, so its label is always first here.
          if (EARTH_TILES) q.push({ pin, x, y, r, a });
          else plate(pin.label, x, y + r + Math.round(4 * dpr), a,
            pin.mine ? C.goldHi : pin.owned ? C.gold : C.text, false);
        }
        // THE HIT LIST IS PINS ONLY. A parcel is resolved by the CELL under the
        // finger (`onPointerUp` → `unproject` → `cellAtDeg`), which is both correct at
        // every zoom and the only way to name a tile nobody owns.
        if (pin.layer !== 'parcel' || pin.persistent) {
          hits.push({ pin, x: x / dpr, y: y / dpr, r: pinHitRadius(pin.r) });
        }
      }
      if (EARTH_TILES) {
        // Names as soon as tiles are legible (D-096): a sparse neighbourhood may
        // label every parcel on screen; a dense one keeps the hard cap.
        budget = labelBudget(parcelsOnCanvas, aParcel > 0.01);
        for (let i = q.length - 1; i >= 0; i--) {
          const e = q[i]!;
          // THE ZOOM GATE, per layer: a cluster count once a sector is a screenful
          // (`valleyLabelZoom` — WORLDMAP-GLOBE-PLAN.md:115's intent, implemented at
          // last), and a parcel's own name only once its TILE is a 44 px target, i.e.
          // once there is room under it for one. Below those the chrome says it.
          const ok = e.pin.layer === 'valley'
            ? nav.zoom >= GLOBE_VIEW.valleyLabelZoom
            : e.pin.layer === 'parcel' ? tileLabelled(tileCss) : true;
          if (!ok) continue;
          plate(e.pin.label!, e.x, e.y + e.r + Math.round(4 * dpr), e.a,
            e.pin.mine ? C.goldHi : e.pin.owned ? C.gold : C.text, true);
        }
      }
      requestVisibleParcelAvatars(
        avatarPool, avatarQ, selected?.cell ?? null, { width: w * dpr, height: h * dpr },
      );
      ctx.restore();
      tileRef.current = { px: tileCss, labels: boxes.length / 4 };
    }

    wakeRef.current = schedule;
    schedule();
    return () => {
      stopped = true;
      wakeRef.current = () => {};
      if (raf) cancelAnimationFrame(raf);
      // Zeroed, not merely cancelled: refs survive React 19 StrictMode's simulated
      // unmount/remount and a leftover id would strand the next loop (the exact
      // bug that left the local map's terrain canvas blank on second mount).
      raf = 0;
      frameRef.current = 0;
    };
  }, [avatarPool, commit, raster, layerRef, settle]);

  /**
   * THE SUN, on its own slow clock.
   *
   * A minute is plenty (see GLOBE_VIEW.sunTickMs) and it costs one repaint, so the
   * terminator is genuinely live — it advances while you sit and look at the planet
   * — without the 60 Hz wake that "live" used to imply. The tick is skipped while
   * the layer is faded out: there is nothing to repaint under the local map, and
   * `markDirty` on the next wake picks up the current instant anyway.
   */
  useEffect(() => {
    const h = window.setInterval(() => {
      sunRef.current = Date.now();
      if (bandMix(navRef.current.zoom).earth > 0.002) markDirty();
    }, GLOBE_VIEW.sunTickMs);
    return () => window.clearInterval(h);
  }, [markDirty]);

  // Any prop that changes what is drawn must ask for a repaint — the dirty flag
  // is what makes a stationary globe free, so it has to be set from outside too.
  useEffect(markDirty, [markDirty, pins, selectedCell, mask, mapAtlas, vw, vh]);

  // --- imperative control ---------------------------------------------------
  useEffect(() => {
    controlRef.current = {
      nav: () => ({ ...navRef.current }),
      interacted: () => interactedRef.current,
      tweening: () => tweenRef.current !== null,
      tweenTo: (lon, lat, zoom) => {
        // Deliberately does NOT count as an interaction: the FIRST tween is the
        // pull-out from the player's own valley, and if that ended the idle spin
        // the spin would never happen at all. The gesture handlers are what retire
        // it (pointerdown / wheel / zoomBy), which is the actual rule: motion is
        // charm on arrival and nausea on every subsequent visit.
        velRef.current = { lam: 0, phi: 0 };
        tweenRef.current = {
          from: { ...navRef.current },
          to: clampNav({ lam0: lon * (Math.PI / 180), phi0: lat * (Math.PI / 180), zoom }),
          t0: performance.now(),
          ms: GLOBE_VIEW.tweenMs,
        };
        // markDirty, never a bare `dirtyRef = true`: the loop sleeps when nothing is
        // owed, so a camera move that did not wake it would simply never be drawn.
        markDirty();
      },
      zoomBy: (dz) => {
        interactedRef.current = true;
        // An explicit zoom press cancels whatever tween is in flight (a descend, a
        // recentre, a settle): without this the next frame's tween would overwrite
        // the zoom that was just asked for and the button would look dead.
        tweenRef.current = null;
        navRef.current = clampNav({
          ...navRef.current,
          zoom: clampGlobeBrowseZoom(navRef.current.zoom + dz),
        });
        markDirty();
        // …and `commitSoon` is what settles it: a 0.5 step from 3.4 lands on 3.9,
        // inside the cross-fade, which is not a resting state.
        commitSoon();
      },
      set: (n) => {
        navRef.current = clampNav({ ...navRef.current, ...n });
        markDirty();
      },
      stats: () => ({
        ...raster.stats,
        fps: fpsRef.current.fps,
        frameMs: fpsRef.current.frameMs,
        // The two numbers that make "the faded-out globe stopped consuming frames"
        // measurable from the running app instead of argued about: `ticks` is every
        // rAF callback since mount, `awake` is whether one is still scheduled.
        ticks: fpsRef.current.ticks,
        awake: fpsRef.current.awake,
        tileCssPx: tileRef.current.px,
        labels: tileRef.current.labels,
      }),
    };
    return () => { controlRef.current = null; };
  }, [controlRef, commitSoon, raster, markDirty]);

  // --- gestures -------------------------------------------------------------
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const origin = useRef<{ x: number; y: number } | null>(null);
  const didDrag = useRef(false);
  const captured = useRef(false);
  const pinch = useRef<{ d0: number; z0: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const forgetPointer = useCallback((id: number): boolean => {
    if (!pts.current.delete(id)) return false;
    const [a, b] = [...pts.current.values()];
    // The remaining pair owns a new distance baseline at the current zoom.
    pinch.current = a && b ? { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: navRef.current.zoom } : null;
    return true;
  }, []);

  const localPt = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = cvRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const spread = (): number => {
    const [a, b] = [...pts.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };
  const stopMotion = (): void => {
    const interruptedTween = tweenRef.current !== null;
    interactedRef.current = true;
    velRef.current = { lam: 0, phi: 0 };
    tweenRef.current = null;
    // The opening pull-out starts at localZoom, where this globe is deliberately
    // invisible. A first touch used to cancel that tween at z4 and strand a black
    // board because the retired local map is no longer mounted underneath. Any
    // user interruption owns a BROWSE camera, so publish it on the deepest fully
    // visible browse surface before the gesture continues.
    const browseZoom = clampGlobeBrowseZoom(navRef.current.zoom);
    if (browseZoom !== navRef.current.zoom) {
      navRef.current = clampNav({ ...navRef.current, zoom: browseZoom });
    }
    if (interruptedTween) commit();
  };

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // LATCH the pointer surface for the whole gesture, and wake the loop: a
    // sleeping globe must answer the first finger, and a pinch that crosses a band
    // edge must not have the surface taken away from it half-way through.
    heldRef.current = true;
    stopMotion();
    markDirty();
    if (pts.current.size === 1) {
      origin.current = { x: e.clientX, y: e.clientY };
      didDrag.current = false;
      captured.current = false;
    } else if (pts.current.size === 2) {
      didDrag.current = true;
      pinch.current = { d0: spread(), z0: navRef.current.zoom };
    }
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    const prev = pts.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pts.current.set(e.pointerId, cur);
    const { vw: w, vh: h } = sizeRef.current;
    const nav = navRef.current;

    if (pts.current.size >= 2) {
      const p = pinch.current;
      const d = spread();
      if (p && p.d0 > 0 && d > 0) {
        // Pinch is a BAND change: the zoom scalar is logarithmic in screen scale,
        // so a 4× pinch is exactly one band (mirrors game/world/pinch.ts, whose
        // engage-on-second-finger semantics this copies).
        // ANCHORED ON THE DISC CENTRE, not the pinch midpoint. Keeping an
        // off-centre point fixed on a SPHERE means solving for a rotation as well
        // as a scale, and the approximations look worse than centre-zoom does;
        // double-tap rotates the tapped point to the centre first, which is the
        // gesture that actually expresses "look closer at THAT".
        const dz = Math.log(d / p.d0) / Math.log(GLOBE_VIEW.zoomBase);
        navRef.current = clampNav({ ...nav, zoom: clampGlobeBrowseZoom(p.z0 + dz) });
        markDirty();
        commitSoon();
      }
      return;
    }

    const o = origin.current;
    if (o && Math.abs(cur.x - o.x) + Math.abs(cur.y - o.y) > DRAG_PX) {
      didDrag.current = true;
      if (!captured.current) {
        try { e.currentTarget.setPointerCapture(e.pointerId); captured.current = true; } catch { /* gone */ }
      }
    }
    const R = radiusPx(nav.zoom, Math.min(w, h));
    // Δpx → Δangle scaled by 1/R. The cos φ₀ divisor keeps the ground speed under
    // the finger roughly constant away from the equator; it is floored so that a
    // drag near the ±80° clamp cannot become an uncontrollable spin.
    const dLam = -(cur.x - prev.x) / (R * Math.max(0.25, Math.cos(nav.phi0)));
    const dPhi = (cur.y - prev.y) / R;
    navRef.current = clampNav({ lam0: nav.lam0 + dLam, phi0: nav.phi0 + dPhi, zoom: nav.zoom });
    velRef.current = { lam: dLam, phi: dPhi };
    markDirty();
  };

  const onPointerUp = (e: React.PointerEvent): void => {
    if (!forgetPointer(e.pointerId)) return;
    if (captured.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
    }
    if (pts.current.size > 0) return;
    // Last finger up: the latch is released here, and only here, so the band the
    // gesture LANDED on decides who owns pointers next. One more paint settles the
    // layer into that state.
    heldRef.current = false;
    markDirty();
    const wasDrag = didDrag.current;
    origin.current = null;
    captured.current = false;
    // THE GESTURE IS OVER, SO THE CAMERA MUST COME TO REST IN ONE BAND OR THE OTHER.
    // This is the release that used to strand a pinch mid-cross-fade as a frozen
    // half-opacity Earth over a darkened map. A tap handler below may replace this
    // settle with a descend; that descend's own end settles again.
    settle();
    if (wasDrag) { commit(); return; }
    velRef.current = { lam: 0, phi: 0 };

    const p = localPt(e);
    // NEAREST pin wins, not the first one drawn. Sector and valley pins keep the
    // 44 px minimum target (`pinHitRadius`) and may overlap each other, so
    // first-match would hand a tap to whichever happened to be earliest in the
    // list. Scanned in reverse so that on an exact tie the DEEPER band's pin (drawn
    // later) wins, which is the layer the player is looking at.
    //
    // PARCELS ARE NOT IN THIS LIST ANY MORE (P3). They are ground, not markers, so
    // they are resolved below by the cell under the finger — which is why the
    // overlapping-hit-circle problem is not solved here but ABOLISHED.
    let hit: { pin: GlobePin; x: number; y: number; r: number } | null = null;
    let bestD = Infinity;
    const hits = hitsRef.current;
    for (let i = hits.length - 1; i >= 0; i--) {
      const hh = hits[i]!;
      const d = Math.hypot(p.x - hh.x, p.y - hh.y);
      if (d <= hh.r && d < bestD) { bestD = d; hit = hh; }
    }
    if (hit) { lastTap.current = null; cbRef.current.onPinTap(hit.pin); return; }

    const prevTap = lastTap.current;
    const now = performance.now();
    const { vw: w, vh: h } = sizeRef.current;
    const at = unprojectDeg(p.x, p.y, navCamera(navRef.current, w, h));
    if (prevTap && now - prevTap.t < DBL_MS && Math.hypot(p.x - prevTap.x, p.y - prevTap.y) < DBL_PX) {
      lastTap.current = null;
      // Double-tap = rotate that point to the centre and go one band deeper. The
      // zoom cluster is a convenience (it may be NULL at short viewports), so
      // every zoom has to be reachable by gesture.
      if (at) controlRef.current?.tweenTo(
        at.lon, at.lat, clampGlobeBrowseZoom(navRef.current.zoom + 1),
      );
      return;
    }
    lastTap.current = { t: now, x: p.x, y: p.y };
    // THE TAP RESOLVES TO A CELL, and this is the whole of P3's hit-testing change:
    // `unproject` gave the point under the finger already, and `cellAtDeg` is the
    // mask's own inverse — four lines of arithmetic, no list, no radius, no
    // nearest-wins. It answers for occupied and unoccupied ground alike, which is why
    // "tap a tile and read what it is" can exist at all. The mask's dimensions travel
    // with the cell because a cell id means nothing without them.
    cbRef.current.onEmptyTap(at ? tapCell(at) : null);
  };

  /** The point under the finger → the cell containing it, in the mask in force. */
  const tapCell = (at: LonLat): GlobeTap => {
    const m = maskRef.current;
    const c = cellAtDeg(m, at.lon, at.lat);
    return { lon: at.lon, lat: at.lat, cell: c.iy * m.cols + c.ix, cols: m.cols, rows: m.rows };
  };

  const onPointerCancel = (e: React.PointerEvent): void => {
    if (!forgetPointer(e.pointerId)) return;
    didDrag.current = true;
    origin.current = null;
    captured.current = false;
    if (pts.current.size === 0) { heldRef.current = false; markDirty(); settle(); }
  };

  // A pointer released OFF the canvas must still be forgotten, or the next single
  // finger reads as the second finger of a pinch and the globe zooms instead of
  // spinning until reload (the same hole agent A closed on the local map).
  useEffect(() => {
    const drop = (e: PointerEvent): void => {
      if (!forgetPointer(e.pointerId)) return;
      didDrag.current = true;
      if (pts.current.size === 0) {
        origin.current = null;
        captured.current = false;
        // A pointer released off-element must also drop the latch, or the layer
        // would keep the pointer surface over a local map it can no longer see.
        heldRef.current = false;
        markDirty();
        // A pinch released off-element ends the gesture just as much as one released
        // on it, so it settles too — otherwise the one way to strand the layer would
        // be to lift a finger past the edge of the canvas.
        settle();
      }
    };
    const suspend = (): void => {
      if (!pts.current.size) return;
      pts.current.clear(); pinch.current = null; origin.current = null;
      captured.current = false; didDrag.current = true; lastTap.current = null;
      heldRef.current = false; velRef.current = { lam: 0, phi: 0 };
      window.clearTimeout(commitTimer.current);
      markDirty(); settle(); commit();
    };
    const visibility = (): void => { if (document.hidden) suspend(); };
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
    window.addEventListener('blur', suspend);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', drop);
      window.removeEventListener('blur', suspend);
      document.removeEventListener('visibilitychange', visibility);
      pts.current.clear(); pinch.current = null; origin.current = null;
      captured.current = false; heldRef.current = false;
    };
  }, [markDirty, settle, commit, forgetPointer]);

  // Wheel/trackpad zoom, registered by hand and non-passive: React's delegated
  // wheel listener is passive, so an onWheel prop cannot preventDefault and the
  // PAGE would zoom instead of the planet.
  useEffect(() => {
    const el = cvRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      stopMotion();
      const dz = Math.max(-0.5, Math.min(0.5, -e.deltaY * 0.0022));
      navRef.current = clampNav({
        ...navRef.current,
        zoom: clampGlobeBrowseZoom(navRef.current.zoom + dz),
      });
      markDirty();
      commitSoon();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commitSoon, markDirty]);

  return (
    <canvas
      ref={cvRef}
      className="interactive"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) onPointerCancel(e);
      }}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        imageRendering: 'pixelated', touchAction: 'none', cursor: 'grab',
        userSelect: 'none', WebkitUserSelect: 'none',
      }}
    />
  );
});
