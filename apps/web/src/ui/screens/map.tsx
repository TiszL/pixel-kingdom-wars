import { MapFeatureHost, type MapFeatureHostProps } from '../pk/map/MapFeatureHost';
import { GameLoading } from '../loading/GameLoading';
import { openScout } from '../scoutNavigation';
import { RaidEntryCost } from '../RaidEntryCost';
/**
 * MAP screens — the MAPS handout's two hand-authored terrain maps rendered
 * over live server data.
 *
 * WORLD (PvP, "WORLD MAP (PvP).html"): the authored 12×20 valley (river/road/
 * bridge) centred on the server's WORLD grid, endless wilderness beyond it,
 * keeps standing ON terrain with level badge + nametag, shield/loot/own-flag
 * overlays, trophy-zone bands, HIDE SHIELDED filter, legend, zoom + home.
 * SCOUT/ATTACK/search/energy behaviours are unchanged — the map renders only
 * what GET /map returns (server-authoritative; no invented numbers).
 *
 * CAMPAIGN (PvE, "PVE MAP (Campaign).html"): the authored 12×22 coast→woods→
 * ashlands terrain with five twelve-stage acts, path dots, stars, pulsing NEXT
 * tag, progress bar and a stage sheet. Encounter names, positions, tactics,
 * mini-bosses and bosses come from the server's explicit 60-stage catalog;
 * progression and the first-3★ reward remain server-authoritative.
 *
 * Terrain data + generators live in mapTerrain.ts (pure, unit-tested).
 *
 * ── TWO REWRITES LIVE HERE (2026-08-09, WORLDMAP-GLOBE-PLAN P0 + P2) ────────
 *
 * P0 — LAYOUT AND GESTURES. Every control used to be independently absolutely
 * positioned with a bare literal (8/10/12/52/90/96/210, a fixed 216px banner, a
 * fixed 230px search box) and this was the ONLY screen in the app that used
 * neither ui/layout.ts nor `env(safe-area-inset-*)`. On a 375×812 phone they
 * collided: the region banner clipped behind the mode tabs, HIDE SHIELDED cut
 * in half at the right edge, the zoom rail's `+` pill at y −11 in the owner's
 * measured landscape window, the campaign stage sheet unclosable because its ✕
 * had been pushed above y=0. Both boards now consume ONE solved chrome
 * (`mapChrome()` + ui/mapChromeUI.tsx), so a control cannot be placed without a
 * slot, and the slots are asserted numerically in layout.test.ts.
 *
 * P2 — RENDER THE PAN, NOT REACT. `setCam` fired on every `pointermove` (not
 * per frame), re-reconciling ~1,450 elements per touch sample, while ~435 tile
 * `<img>` nodes re-laid-out and a zoom step re-rasterised 46 SVG masters
 * (~140 ms). Now: the camera lives in a REF during a gesture, ONE rAF writes
 * `style.transform` on the world layer and redraws the terrain, React state is
 * committed only on a quantised camera change (which is also what keys the
 * fetch), the terrain is ONE canvas blitted from the boot-loaded `map` atlas
 * (ui/mapAtlas.ts) with letters precomputed into a Uint16Array (ui/mapTiles.ts),
 * and silhouettes draw into that same canvas instead of ~400 more DOM nodes.
 */
import {
  CAMPAIGN, pvpAttackAllowed, pvpMinDefenderKeep, RAID_RULES, WORLD,
  type CampaignThreat, type CampaignTheme,
} from '@shardkeep/shared';
import {
  lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { api } from '../../lib/api';
import { selectedBasePath } from '../../lib/baseSelection';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';
import { troopPortrait } from '../icons';
import { useFetch } from '../useFetch';
import { PlayerName, SeekerBadge } from './seeker';
import {
  Btn, Chip, COLORS as C, fmtN, Icon, Panel9, Phead, Pill, PillSub, Sp, Sprite,
} from '../primitives';
import {
  hitSizeAt, MAPCHROME, mapChrome, useSafeAreaInsets, useWindowSize,
  type Insets, type MapChromeLayout,
} from '../layout';
import {
  chromeDrifted, chromePanGuard, IconBtn, IconRail, MAP_DBL, MapSheet, MapTopBar,
  RegionPlate, UnderBar, ZoomRail, type SheetState,
} from '../mapChromeUI';
import { useMapAtlas, type MapAtlas } from '../mapAtlas';
import { bakeTileField, tileFrameIndex, type TileField } from '../mapTiles';
import {
  CAMPAIGN_ACTS, campaignTerrain, groundFrameAt, spriteAt, suppressTerrainOverlay,
  terrainTransformAt, WORLD_ZONES, worldTerrain,
  type Terrain,
} from './mapTerrain';
// The globe's PURE view rules only — the flag and the rail-row count. The globe
// itself (canvas, raster, fine mask) is reached through a dynamic import at the
// bottom of this file so none of it enters the first-paint JS graph.
import { railRowsForWorld } from './globe/globeView';

const WarzoneDetails = lazy(() => import('./warzoneStatus')
  .then((module) => ({ default: module.WarzoneDetails })));

/** A keep the server decided is worth naming to you: your own, a revenge target,
 *  or one of the top WORLD.mapCandidateCap in-window candidates. */
interface PlayerMarker {
  kind: 'player'; x: number; y: number; wallet: string; name: string;
  /** Stable land identity; present when multi-base capability is active. */
  baseId?: string | undefined;
  keepLevel: number; trophies: number; shielded: boolean; surplusTease: boolean; isMe: boolean;
  /** Clan badge, null when unclanned. */
  clanTag: string | null;
  /** Verified Solana Mobile Seeker — badge beside the nametag. */
  seeker: boolean;
  /** Seen within WORLD.mapOnlineMin. */
  online: boolean;
  /** Raided within WORLD.mapBurningHours — renders scorched. */
  burning: boolean;
  /** Resolved a raid on YOU inside RAID_RULES.revengeLockHours. */
  revenge: boolean;
  /** SERVER truth for the raid gate — since D-099 the Keep-asymmetry rule
   *  (their Keep at least half yours), not a trophy window. The wire name is the
   *  API's for one release; it means "attackable". */
  inWindow: boolean;
}
/** Everyone else in the viewport — a shape on the terrain, deliberately anonymous
 *  (the server withholds wallet/name so /map is not a valley-wide wallet dump). */
interface SilhouetteMarker { kind: 'silhouette'; x: number; y: number; keepLevel: number; trophies: number }
interface PveMarker { kind: 'pve'; id: string; x: number; y: number; tier: number; cleared: boolean; bounty: number }
type Marker = PlayerMarker | SilhouetteMarker | PveMarker;
interface MapChunk {
  valleyId: string; valleyName: string; warzoneActive: boolean;
  markers: Marker[];
  /** WAR ROOM shortlist — wallets, ranked, already filtered to attackable. */
  recommended: Array<string | { wallet: string; baseId: string }>;
  /** SERVER truth for "you are looking at somebody else's valley" (owner
   *  decision, 2026-08-09). A visit payload contains silhouettes and the valley
   *  name and nothing else — no wallets, no names, no camp ids — so there is
   *  nothing to act on and the client offers nothing. */
  visiting: boolean;
}
interface MapRect { x0: number; y0: number; x1: number; y1: number }

/** Shared pulse (revenge badge on WORLD, "NEXT" tag on CAMPAIGN). */
const PULSE_CSS = '@keyframes skmapPulse{0%,100%{opacity:1}50%{opacity:.45}}';

/**
 * GET /map for the CURRENT viewport, refetched every WORLD.mapPollSec.
 *
 * Polling pauses while the tab is hidden — a backgrounded tab that keeps polling
 * forever is how 400 concurrent viewers quietly becomes 4,000. The rect is
 * quantised by the caller, so panning a tile or two reuses the in-flight result
 * instead of firing a request per frame; the server ETag turns an unchanged
 * valley into a ~200 B 304 on top of that.
 *
 * REQUEST SEQUENCING (2026-08-09): a fast pan fires several rects in a row and
 * responses are not ordered, so a slow early response could land AFTER a newer
 * one and snap the markers back to a viewport the player had already left. Each
 * load now supersedes the previous one through an AbortController and a stale
 * result is dropped on arrival. NOTE: this cancels the RESULT, not the socket —
 * transport-level cancellation needs `api.get(path, { signal })` in lib/api.ts,
 * which this change deliberately does not reach into.
 */
function useMapChunk(
  rect: MapRect | null, valleyId?: string | undefined, enabled = true,
): { data: MapChunk | null; error: string | null } {
  const selectedBaseId = useApp((s) => s.selectedBaseId);
  const [data, setData] = useState<MapChunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;
  const vidRef = useRef(valleyId);
  vidRef.current = valleyId;
  const ctlRef = useRef<AbortController | null>(null);
  // `enabled` is false for exactly one case: a DEEDLESS player looking at the
  // world with no visit selected. They own no parcel, so they live in no valley,
  // and `GET /map` with no valleyId answers 402 LAND_NOT_OWNED by design (the
  // own-valley read would otherwise have to assign them a plot). Firing it anyway
  // would raise the global buy-land sheet over a board they were told they could
  // look at. The VISIT read (`?valleyId=`) is free and still runs.
  const onRef = useRef(enabled);
  onRef.current = enabled;

  const load = useCallback(() => {
    if (!onRef.current) return;
    const r = rectRef.current;
    // `valleyId` is only ever appended when the globe descended into somebody
    // else's valley. With no visit the query string is byte-identical to what
    // this hook has always sent — which is what makes the flag-off path
    // unchanged rather than merely equivalent.
    const parts = [
      ...(r ? [`x0=${r.x0}`, `y0=${r.y0}`, `x1=${r.x1}`, `y1=${r.y1}`] : []),
      ...(vidRef.current ? [`valleyId=${encodeURIComponent(vidRef.current)}`] : []),
    ];
    const qs = parts.length ? `?${parts.join('&')}` : '';
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    void api.get<MapChunk>(selectedBasePath(`/map${qs}`))
      .then((d) => { if (!ctl.signal.aborted) { setData(d); setError(null); } })
      .catch((e: Error) => { if (!ctl.signal.aborted) setError(e.message); });
  }, []);

  // Refetch when the quantised rect changes (a real pan), not on every frame —
  // or when the valley under the camera changes (a globe descend).
  const key = `${rect ? `${rect.x0},${rect.y0},${rect.x1},${rect.y1}` : ''}`
    + `|${valleyId ?? ''}|${enabled}|${selectedBaseId ?? ''}`;
  useEffect(() => { load(); }, [key, load]);

  useEffect(() => {
    const tick = (): void => { if (document.visibilityState === 'visible') load(); };
    const h = window.setInterval(tick, WORLD.mapPollSec * 1000);
    document.addEventListener('visibilitychange', tick); // and catch up on return
    return () => { window.clearInterval(h); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  useEffect(() => () => ctlRef.current?.abort(), []);

  return { data, error };
}


interface CampaignStage {
  stage: number; act: number; tier: number; keepLevel: number;
  profile: 'OUTPOST' | 'BREACH' | 'FORTRESS';
  name: string; theme: CampaignTheme; tactic: string; threat: CampaignThreat;
  position: { c: number; r: number }; defenderHero: 'vex' | 'theodor' | null;
  recommendedArmyPoints: number; maxArmyPoints: number;
  bestStars: number; unlocked: boolean; firstThreeStarClaimed: boolean;
}

const toast = (msg: string): void => bus.emit('ui:toast', { msg });

// Map tile px at zoom 1 (unchanged from the flat map). Zoom range is the
// handout kit's, except min: the handout renders a 390px stage while we fill
// the whole window — 0.45 would mount ~5k tile imgs on a desktop viewport, so
// the floor is raised to keep the visible-tile budget sane.
const TILE = 46;
const ZOOM = { min: 0.7, max: 1.6, step: 0.15 };
/**
 * Fraction of ZOOM.min a pinch must ASK for, while the board is already sitting
 * at that floor, before it counts as "take me further out than this valley".
 *
 * The globe is literally the next zoom-out step past the local map, but the globe
 * layer is inert at the local band (it must be: the map underneath has to be
 * tappable), so a pinch-out started on the valley could never reach it and the
 * GLOBE button was the only way back. This is the over-scroll that closes the
 * loop. 0.7 ⇒ the fingers must come ~30% closer AFTER the board has bottomed out,
 * which no ordinary zoom-out gesture does by accident.
 */
const PULL_OUT_FRAC = 0.7;
/** Camera wander beyond the authored world, in tiles (handout W.pad). */
const PAD = 16;
/** Cumulative pointer travel (px) past which a gesture is a PAN, never a tap.
 *  ONE threshold for the whole map surface: the chrome buttons' drift guard
 *  (ui/mapChromeUI.tsx) reads the same constant, so a press the board would treat
 *  as a pan can never also fire the button it started on. */
const DRAG_PX = MAPCHROME.dragPx;
/** Two taps inside this window and this radius are a double-tap zoom. Centralised
 *  in ui/mapChromeUI.tsx beside the drift guard, for the same reason DRAG_PX is:
 *  the globe layer above this board reads the SAME pair, so the two halves of one
 *  screen cannot disagree about what a double-tap is. */
const DBL_MS = MAP_DBL.ms;
const DBL_PX = MAP_DBL.px;
/** How far the camera may move (tiles) before React is told. The fetch rect and
 *  the marker cull are the only React consumers of the camera, and both are
 *  already quantised, so committing per frame bought nothing but reconciliation. */
const PUB_Q = 2;
/** Marker cull margin (tiles): PUB_Q plus a tile, so a marker is mounted before
 *  it can scroll into view between two commits. */
const CULL = PUB_Q + 2;

// --- shared drag-pan + pinch/wheel/double-tap camera (both map modes) --------

interface Viewport { w: number; h: number }
interface CamState { x: number; y: number; z: number }
interface CamBounds { minC: number; maxC: number; minR: number; maxR: number }
interface MapCam {
  wrapRef: React.RefObject<HTMLDivElement | null>;
  /** The camera-transformed DOM layer. The rAF writes its `transform` DIRECTLY;
   *  React never renders that property, so a re-render cannot snap the camera
   *  back to a stale value mid-drag. */
  layerRef: React.RefObject<HTMLDivElement | null>;
  vp: Viewport;
  /** Quantised commit of the live camera — what React renders from. */
  pub: CamState | null;
  didDragRef: React.RefObject<boolean>;
  panProps: Pick<React.DOMAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'>;
  zoomBy(d: number): void;
  /** Centre the viewport on a world-tile coordinate (also seeds a null cam). */
  centerOn(cx: number, cy: number): void;
  /** Ask for a repaint (terrain source changed, e.g. new markers). */
  markDirty(): void;
}

/**
 * @param paint  called from the ONE rAF with the live camera — the terrain
 *               canvas painter. Held in a ref so a new closure per render does
 *               not restart anything.
 * @param onEmptyTap called when a tap lands on terrain rather than a marker
 *               (deselect / collapse the sheet).
 * @param onPullOut called ONCE per gesture when a pinch keeps pulling out after
 *               the board has bottomed out at ZOOM.min (see PULL_OUT_FRAC). The
 *               WORLD board wires this to the GLOBE button; CAMPAIGN passes
 *               nothing, because there is no globe above the campaign board.
 */
export function useMapCam(
  bounds: CamBounds,
  paint?: (cam: CamState, vp: Viewport) => void,
  onEmptyTap?: () => void,
  onPullOut?: (() => void) | undefined,
): MapCam {
  const wrapRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<Viewport>({ w: 0, h: 0 });
  const [vp, setVp] = useState<Viewport>({ w: 0, h: 0 });
  const camRef = useRef<CamState | null>(null);
  const [pub, setPub] = useState<CamState | null>(null);
  const boundsRef = useRef(bounds); boundsRef.current = bounds;
  const paintRef = useRef(paint); paintRef.current = paint;
  const emptyTapRef = useRef(onEmptyTap); emptyTapRef.current = onEmptyTap;
  const pullOutRef = useRef(onPullOut); pullOutRef.current = onPullOut;
  /** One pull-out per pinch: the condition stays true for every remaining move
   *  of the gesture, and firing it per frame would replay the tween forever. */
  const pulledRef = useRef(false);

  const clamp = useCallback((x: number, y: number, z: number): CamState => {
    const { w, h } = vpRef.current;
    const vwT = w / (TILE * z), vhT = h / (TILE * z);
    const { minC, maxC, minR, maxR } = boundsRef.current;
    const cx = maxC - minC <= vwT ? (minC + maxC) / 2 - vwT / 2 : Math.max(minC, Math.min(maxC - vwT, x));
    const cy = maxR - minR <= vhT ? (minR + maxR) / 2 - vhT / 2 : Math.max(minR, Math.min(maxR - vhT, y));
    return { x: cx, y: cy, z };
  }, []);

  // --- the ONE rAF ----------------------------------------------------------
  const frameRef = useRef(0);
  const markDirty = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const c = camRef.current;
      if (!c) return;
      const l = layerRef.current;
      if (l) l.style.transform = `scale(${c.z}) translate3d(${-c.x * TILE}px, ${-c.y * TILE}px, 0)`;
      paintRef.current?.(c, vpRef.current);
    });
  }, []);
  // The id MUST be zeroed, not just cancelled: refs survive React 19
  // StrictMode's simulated unmount/remount, so a leftover id made `markDirty`
  // return early FOREVER after the second mount — the camera never wrote its
  // transform and the terrain canvas never got its first paint (observed live).
  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  const publish = useCallback(() => {
    const c = camRef.current;
    if (!c) return;
    setPub((p) => (p && p.z === c.z
      && Math.floor(p.x / PUB_Q) === Math.floor(c.x / PUB_Q)
      && Math.floor(p.y / PUB_Q) === Math.floor(c.y / PUB_Q) ? p : { ...c }));
  }, []);
  // Continuous gestures (pinch, wheel) publish on a trailing edge instead of per
  // frame — the fetch rect only needs the resting camera.
  const pubTimer = useRef(0);
  const publishSoon = useCallback(() => {
    window.clearTimeout(pubTimer.current);
    pubTimer.current = window.setTimeout(publish, 140);
  }, [publish]);
  useEffect(() => () => window.clearTimeout(pubTimer.current), []);

  // --- viewport: ResizeObserver + orientationchange, never `resize` alone ----
  // `resize` alone measured a STALE viewport mid-rotation, so the clamp ran
  // against the previous orientation and the camera could sit outside its own
  // bounds (the bug game/world/camera.ts exists to fix for the canvas cameras).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const measure = (): void => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w === vpRef.current.w && h === vpRef.current.h) return;
      vpRef.current = { w, h };
      setVp({ w, h });
      const c = camRef.current;
      if (c) { camRef.current = clamp(c.x, c.y, c.z); publish(); }
      markDirty();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('orientationchange', measure);
    return () => { ro.disconnect(); window.removeEventListener('orientationchange', measure); };
  }, [clamp, markDirty, publish]);

  // --- zoom about a point ---------------------------------------------------
  const zoomAt = useCallback((px: number, py: number, z1: number) => {
    const c = camRef.current;
    if (!c) return;
    const z = Math.max(ZOOM.min, Math.min(ZOOM.max, z1));
    if (z === c.z) return;
    const wx = c.x + px / (TILE * c.z), wy = c.y + py / (TILE * c.z);
    camRef.current = clamp(wx - px / (TILE * z), wy - py / (TILE * z), z);
    markDirty();
  }, [clamp, markDirty]);

  const zoomBy = useCallback((d: number) => {
    const c = camRef.current;
    if (!c || vpRef.current.w === 0) return;
    zoomAt(vpRef.current.w / 2, vpRef.current.h / 2, c.z + d);
    publish();
  }, [zoomAt, publish]);

  const centerOn = useCallback((cx: number, cy: number) => {
    if (vpRef.current.w === 0) return;
    const z = camRef.current?.z ?? 1;
    camRef.current = clamp(cx - vpRef.current.w / (TILE * z) / 2, cy - vpRef.current.h / (TILE * z) / 2, z);
    publish();
    markDirty();
  }, [clamp, publish, markDirty]);

  // --- pointers: drag-pan (with capture), pinch, double-tap ------------------
  const ptsRef = useRef(new Map<number, { x: number; y: number }>());
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const didDragRef = useRef(false);
  const capturedRef = useRef(false);
  const pinchRef = useRef<{ d0: number; z0: number } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const resetTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const forgetPointer = useCallback((id: number): boolean => {
    if (!ptsRef.current.delete(id)) return false;
    const [a, b] = [...ptsRef.current.values()];
    pinchRef.current = a && b
      ? { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: camRef.current?.z ?? 1 } : null;
    return true;
  }, []);

  const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = wrapRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const spread = (): { d: number; mx: number; my: number } => {
    const [a, b] = [...ptsRef.current.values()];
    if (!a || !b) return { d: 0, mx: 0, my: 0 };
    const r = wrapRef.current?.getBoundingClientRect();
    return {
      d: Math.hypot(a.x - b.x, a.y - b.y),
      mx: (a.x + b.x) / 2 - (r?.left ?? 0), my: (a.y + b.y) / 2 - (r?.top ?? 0),
    };
  };

  const panProps: MapCam['panProps'] = {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      window.clearTimeout(resetTimer.current);
      ptsRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptsRef.current.size === 1) {
        originRef.current = { x: e.clientX, y: e.clientY };
        didDragRef.current = false;
        capturedRef.current = false;
        pulledRef.current = false;
      } else if (ptsRef.current.size === 2) {
        // A two-finger gesture is never a tap, and it is a pinch from the
        // moment the second finger lands (mirrors game/world/pinch.ts).
        didDragRef.current = true;
        pinchRef.current = { d0: spread().d, z0: camRef.current?.z ?? 1 };
      }
    },
    onPointerMove: (e) => {
      const prev = ptsRef.current.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      ptsRef.current.set(e.pointerId, cur);
      const c = camRef.current;
      if (!c) return;

      if (ptsRef.current.size >= 2) {
        const p = pinchRef.current;
        const s = spread();
        if (p && p.d0 > 0 && s.d > 0) {
          const want = p.z0 * (s.d / p.d0);
          zoomAt(s.mx, s.my, want);
          publishSoon();
          // PINCH OUT PAST THE FLOOR = leave the valley. `zoomAt` clamps to
          // ZOOM.min, so once the board has bottomed out the requested zoom is the
          // only thing that still records "the fingers are STILL closing" — which
          // is what makes the globe reachable by gesture instead of by the GLOBE
          // button alone.
          if (!pulledRef.current && pullOutRef.current
            && want < ZOOM.min * PULL_OUT_FRAC
            && (camRef.current?.z ?? 1) <= ZOOM.min) {
            pulledRef.current = true;
            pullOutRef.current();
          }
        }
        return;
      }

      // CUMULATIVE displacement from the pointerdown ORIGIN. The old flag used a
      // PER-EVENT delta, so a fast 10px flick counted as a drag and swallowed
      // its tap, while a slow 300px pan made of ≤6px steps never tripped and
      // opened whatever node the finger happened to lift over.
      const o = originRef.current;
      if (o && Math.abs(cur.x - o.x) + Math.abs(cur.y - o.y) > DRAG_PX) {
        didDragRef.current = true;
        // Capture only ONCE it is a pan: before that a child's click must still
        // reach the child. After it, the drag survives leaving the element —
        // which `onPointerLeave: dragRef = null` used to kill on every phone
        // drag that reached a screen edge.
        if (!capturedRef.current) {
          try { e.currentTarget.setPointerCapture(e.pointerId); capturedRef.current = true; } catch { /* gone */ }
        }
      }
      camRef.current = clamp(
        c.x - (cur.x - prev.x) / (TILE * c.z),
        c.y - (cur.y - prev.y) / (TILE * c.z),
        c.z,
      );
      markDirty();
    },
    onPointerUp: (e) => {
      if (!forgetPointer(e.pointerId)) return;
      if (capturedRef.current) {
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* gone */ }
      }
      if (ptsRef.current.size > 0) return;
      publish();
      const onTerrain = e.target === wrapRef.current
        || (e.target as HTMLElement | null)?.dataset?.mapsurface === '1';
      if (!didDragRef.current && onTerrain) {
        const p = local(e);
        const prev = lastTapRef.current;
        const now = performance.now();
        if (prev && now - prev.t < DBL_MS && Math.hypot(p.x - prev.x, p.y - prev.y) < DBL_PX) {
          lastTapRef.current = null;
          zoomAt(p.x, p.y, (camRef.current?.z ?? 1) + ZOOM.step * 2);
          publish();
        } else {
          lastTapRef.current = { t: now, x: p.x, y: p.y };
          emptyTapRef.current?.();
        }
      }
      originRef.current = null;
      capturedRef.current = false;
      // The React `click` that follows this pointerup must still see the flag —
      // it is what suppresses "a pan opened a node". Clear it on the next task,
      // and on the next pointerdown, so it can never go stale either way.
      resetTimer.current = window.setTimeout(() => { didDragRef.current = false; }, 0);
    },
    onPointerCancel: (e) => {
      if (!forgetPointer(e.pointerId)) return;
      didDragRef.current = true;
      originRef.current = null;
      capturedRef.current = false;
      publish();
    },
    onLostPointerCapture: (e) => {
      // An implicit child capture transfers to the board when a pan begins.
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) panProps.onPointerCancel?.(e);
    },
  };

  // A pointer released OUTSIDE the board must still be forgotten. Before the
  // drag threshold there is no pointer capture, so a press that ends off the
  // element (or is stolen by another element) delivers no pointerup here — and a
  // leftover id makes the NEXT single finger look like the second finger of a
  // pinch, which leaves the board zooming instead of panning until reload.
  useEffect(() => {
    const drop = (e: PointerEvent): void => {
      if (!forgetPointer(e.pointerId)) return;
      didDragRef.current = true;
      if (ptsRef.current.size === 0) { originRef.current = null; capturedRef.current = false; }
    };
    const suspend = (): void => {
      if (!ptsRef.current.size) return;
      ptsRef.current.clear(); pinchRef.current = null; originRef.current = null;
      capturedRef.current = false; didDragRef.current = true; lastTapRef.current = null;
      window.clearTimeout(resetTimer.current); window.clearTimeout(pubTimer.current);
      publish();
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
      ptsRef.current.clear(); pinchRef.current = null; originRef.current = null;
      capturedRef.current = false;
    };
  }, [forgetPointer, publish]);

  // Wheel/trackpad zoom at the cursor. Registered by hand, non-passive: React
  // attaches its delegated `wheel` listener passively, so an onWheel prop
  // cannot preventDefault and the page would zoom instead of the map.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const c = camRef.current;
      if (!c) return;
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, c.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      publishSoon();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt, publishSoon]);

  // Seed the layer transform once it exists, so the first paint is not at 0,0.
  useEffect(() => { if (pub) markDirty(); }, [pub, markDirty]);

  return { wrapRef, layerRef, vp, pub, didDragRef, panProps, zoomBy, centerOn, markDirty };
}

// --- terrain canvas ----------------------------------------------------------

/** Silhouette keeps are drawn INTO the terrain canvas: up to ~380 of them can
 *  be in one response and each was two DOM nodes before. */
interface Silhouette { x: number; y: number; keepLevel: number }

/**
 * Build the rAF painter for a board.
 *
 * Draws in SCREEN space (the canvas is a sibling of the transformed layer, not a
 * child), so it is exact at any zoom and never needs re-anchoring: the cost is
 * redrawing ~350 tiles per frame during a pan, which is ~0.5 ms of blits from a
 * single decoded PNG — against the ~140 ms of SVG re-rasterisation one zoom step
 * used to cost.
 */
function useTerrainPainter(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  atlas: MapAtlas | null,
  terrain: Terrain,
  field: TileField | null,
  ox: number, oy: number,
  land: ReadonlySet<string> | undefined,
  silhouettes: Silhouette[],
): (cam: CamState, vp: Viewport) => void {
  // Frame rects for the baked letter table, resolved once per field.
  const rects = useMemo(
    () => (atlas && field ? field.frames.map((n) => atlas.frame(n)) : []),
    [atlas, field],
  );
  return useCallback((cam: CamState, vp: Viewport) => {
    const cv = canvasRef.current;
    if (!cv || vp.w === 0 || vp.h === 0) return;
    // Cap DPR at 2: beyond that the extra fill rate buys nothing on 32px-grid
    // pixel art and costs real milliseconds on a phone.
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const bw = Math.round(vp.w * dpr), bh = Math.round(vp.h * dpr);
    if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false; // pixel art, never blurred
    ctx.clearRect(0, 0, bw, bh);
    if (!atlas || !field) return;

    const tp = TILE * cam.z * dpr;
    const gx0 = Math.floor(cam.x), gy0 = Math.floor(cam.y);
    const cols = Math.ceil(vp.w / (TILE * cam.z)) + 2, rows = Math.ceil(vp.h / (TILE * cam.z)) + 2;
    const offX = -(cam.x - gx0) * tp, offY = -(cam.y - gy0) * tp;
    for (let r = 0; r < rows; r++) {
      const y0 = Math.round(offY + r * tp), y1 = Math.round(offY + (r + 1) * tp);
      for (let c = 0; c < cols; c++) {
        const i = tileFrameIndex(field, gx0 + c, gy0 + r);
        const worldX = gx0 + c, worldY = gy0 + r;
        // Outside the baked field (a viewport wider than the whole world, so the
        // clamp centres past the bake margin): ask the generator directly rather
        // than leave a hole. mapTerrain stays the single source either way.
        const frame = i >= 0
          ? field.frames[i]!
          : spriteAt(terrain, worldX - ox, worldY - oy, land);
        const f = i >= 0 ? rects[i] : atlas.frame(frame);
        if (!f) continue;
        const x0 = Math.round(offX + c * tp), x1 = Math.round(offX + (c + 1) * tp);
        const width = x1 - x0, height = y1 - y0;
        const drawFrame = (name: string, source: typeof f): void => {
          const transform = terrainTransformAt(name, worldX, worldY);
          if (transform === 0) {
            ctx.drawImage(atlas.sheet, source.x, source.y, source.w, source.h,
              x0, y0, width, height);
            return;
          }
          ctx.save();
          ctx.translate(x0 + width / 2, y0 + height / 2);
          ctx.rotate((transform & 3) * Math.PI / 2);
          if (transform >= 4) ctx.scale(-1, 1);
          ctx.drawImage(atlas.sheet, source.x, source.y, source.w, source.h,
            -width / 2, -height / 2, width, height);
          ctx.restore();
        };

        const ground = groundFrameAt(terrain, worldX - ox, worldY - oy, land);
        const groundRect = atlas.frame(ground);
        if (groundRect) drawFrame(ground, groundRect);
        if (frame !== ground && !suppressTerrainOverlay(frame)) drawFrame(frame, f);
      }
    }

    // Anonymous neighbours: grey, translucent, un-tappable — exactly what the
    // DOM version rendered (opacity .35 + grayscale(1)), minus the DOM.
    if (silhouettes.length) {
      const s = cam.z * dpr;
      ctx.globalAlpha = 0.35;
      for (const m of silhouettes) {
        const ax = (m.x * TILE + TILE / 2 - cam.x * TILE) * s;
        const ay = (m.y * TILE + TILE - cam.y * TILE) * s;
        if (ax < -60 * s || ay < -70 * s || ax > bw + 60 * s || ay > bh + 70 * s) continue;
        const f = atlas.frame(`map_keep_t${Math.min(5, Math.max(1, m.keepLevel))}`);
        if (!f) continue;
        ctx.drawImage(atlas.gray, f.x, f.y, f.w, f.h,
          Math.round(ax - 29 * s), Math.round(ay - 63 * s), Math.round(58 * s), Math.round(63 * s));
      }
      ctx.globalAlpha = 1;
    }
  }, [canvasRef, atlas, field, rects, terrain, ox, oy, land, silhouettes]);
}

/** Bake the whole reachable world once. ~48×56 tiles = 5.4 KB of Uint16. */
function useTileField(
  terrain: Terrain, ox: number, oy: number, land: ReadonlySet<string> | undefined,
): TileField {
  return useMemo(() => bakeTileField(
    terrain, ox, oy,
    ox - PAD - 2, oy - PAD - 2,
    terrain.cols + 2 * PAD + 4, terrain.rows + 2 * PAD + 4,
    land,
  ), [terrain, ox, oy, land]);
}

// --- small handout chrome pieces --------------------------------------------

function Legend({ title, rows, onClose, inset }: {
  title: string; rows: Array<[string, string, string]>; onClose(): void; inset: Insets;
}): React.JSX.Element {
  return (
    // THE PAN GUARD, same as every wrapper in ui/mapChromeUI.tsx. The legend is a
    // DESCENDANT of the board root, which carries `panProps`, so scrolling this list
    // used to pan the valley behind it — and the drift half of the guard is what stops
    // that scroll from also counting as the tap-to-close (a flick would close the
    // legend the moment the finger lifted).
    <div className="interactive" {...chromePanGuard}
      onClick={(e) => { if (!chromeDrifted(e.currentTarget)) onClose(); }}
      style={{
        position: 'absolute', inset: 0, zIndex: 1300, background: 'rgba(15,13,19,.94)',
        paddingTop: 16 + inset.top, paddingBottom: 16 + inset.bottom,
        paddingLeft: 16 + inset.left, paddingRight: 16 + inset.right,
        overflowY: 'auto', cursor: 'pointer',
      }}>
      <div style={{ color: C.gold, fontSize: 22, letterSpacing: '2px', marginBottom: 8 }}>
        {title} <span style={{ color: C.textFaint, fontSize: 15 }}>— tap anywhere to close</span>
      </div>
      {rows.map(([img, t, d]) => (
        <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: `1px solid ${C.card}` }}>
          <Sprite name={img} w={38} h={38} style={{ objectFit: 'contain', flex: 'none' }} />
          <div style={{ fontSize: 16, color: C.textDim }}>
            <b style={{ color: C.text, display: 'block', letterSpacing: '1px' }}>{t}</b>{d}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Error panel — now ABOVE the chrome it overlaps. Both boards used to paint
 *  theirs with no zIndex at all, i.e. beneath every z-1000 control. */
function ErrPanel({ msg, inset }: { msg: string; inset: Insets }): React.JSX.Element {
  return (
    <Panel9 style={{
      position: 'absolute', left: 16 + inset.left, right: 16 + inset.right, top: '40%', zIndex: 1400,
    }}>
      <div style={{ padding: 14, color: C.danger }}>{msg}</div>
    </Panel9>
  );
}

/** The pan surface never fires a tap after a drag; this is the one gate. */
const useTapGate = (mapCam: MapCam): ((fn: () => void) => () => void) => useCallback(
  (fn: () => void) => () => { if (!mapCam.didDragRef.current) fn(); },
  [mapCam.didDragRef],
);

// ============================================================================
// WORLD (PvP)
// ============================================================================

/** Memoised so a camera commit (every PUB_Q tiles of pan) re-renders the marker
 *  list without re-rendering each marker's sprite stack. */
const KeepNode = memo(function KeepNode({ m, isSel, myClanTag }: {
  m: PlayerMarker; isSel: boolean; myClanTag: string | null;
}): React.JSX.Element {
  const t = Math.min(5, Math.max(1, m.keepLevel));
  return (
    <>
      {/* scorch: raided inside WORLD.mapBurningHours — somebody already found them */}
      {m.burning && <Sprite name="map_ash" w={46} h={46} style={{ position: 'absolute', left: -23, top: -24, opacity: 0.7 }} />}
      {m.isMe && <Sprite name="map_own" w={69} h={69} style={{ position: 'absolute', left: -35, top: -60, opacity: 0.9 }} />}
      <Sprite name={`map_keep_t${t}`} w={58} h={63}
        style={{ position: 'absolute', left: -29, top: -63, ...(m.inWindow || m.isMe ? {} : { opacity: 0.6 }) }} />
      {m.isMe && <Sprite name="map_flag_player" w={26} h={35} style={{ position: 'absolute', left: 10, top: -85 }} />}
      {m.shielded && <Sprite name="map_shield" w={55} h={55} style={{ position: 'absolute', left: -27, top: -59, opacity: 0.88 }} />}
      {/* gold-surplus glint (GDD §3.4 withholds the number — bag only, no figure) */}
      {!m.isMe && m.surplusTease && !m.shielded && <Sprite name="map_loot" w={22} h={22} style={{ position: 'absolute', left: -39, top: -33 }} />}
      {/* they hit you inside RAID_RULES.revengeLockHours — pulses so it reads across the valley */}
      {m.revenge && (
        <Sprite name="map_revenge" w={28} h={28}
          style={{ position: 'absolute', left: 14, top: -34, animation: 'skmapPulse 1.1s steps(6,end) infinite' }} />
      )}
      {isSel && <Sprite name="map_marker_select" w={46} h={46} style={{ position: 'absolute', left: -23, top: -46 }} />}
      <span style={{
        position: 'absolute', left: -33, top: -22, background: C.ink, border: `2px solid ${C.gold}`,
        color: C.goldHi, fontSize: 12, lineHeight: 1, padding: '1px 4px', letterSpacing: '1px',
      }}>L{m.keepLevel}</span>
      <span style={{
        position: 'absolute', left: 0, top: 4, transform: 'translateX(-50%)', whiteSpace: 'nowrap',
        background: 'rgba(26,23,30,.86)', border: `1px solid ${isSel ? C.gold : C.border}`,
        color: m.isMe ? C.goldHi : C.textDim, fontSize: 13, padding: '0 5px', letterSpacing: '1px',
        display: 'flex', alignItems: 'center', gap: 4, maxWidth: 150, overflow: 'hidden',
      }}>
        {/* lit window: seen inside WORLD.mapOnlineMin */}
        {m.online && <i style={{ width: 6, height: 6, background: C.success, display: 'inline-block', flex: 'none' }} />}
        {m.clanTag && (
          <b style={{ color: myClanTag && m.clanTag === myClanTag ? C.goldHi : C.textFaint, fontSize: 12 }}>[{m.clanTag}]</b>
        )}
        {m.seeker && <SeekerBadge size={11} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.isMe ? `★ ${m.name}` : m.name}</span>
      </span>
    </>
  );
});

/**
 * @param onGlobe   present ONLY when VITE_FEATURE_GLOBE is on: adds the GLOBE
 *                  button to the chrome rail (never a floating button — a control
 *                  without a slot is how this screen got into trouble). Absent ⇒
 *                  the board solves and renders exactly as it did before the
 *                  globe existed, which is the whole do-not-regress guarantee.
 * @param visitValleyId  a foreign valley the globe descended into. The server
 *                  answers with silhouettes and the valley name only, so this
 *                  board becomes read-only by virtue of the payload rather than
 *                  by hiding buttons.
 */
function WorldMap({ onGlobe, visitValleyId, onExitVisit }: {
  onGlobe?: (() => void) | undefined;
  visitValleyId?: string | undefined;
  onExitVisit?: (() => void) | undefined;
} = {}): React.JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  const setMapTab = useApp((s) => s.setMapTab);
  const setRaidTarget = useApp((s) => s.setRaidTarget);
  // Raid energy (server-authoritative, GDD §3.3): the App's "MARCH · 2H" faked a
  // march timer; the real cost is raid energy (free raids left / daily ceiling).
  const energy = useApp((s) => s.base?.energy ?? null);
  const myTrophies = useApp((s) => s.base?.player.trophies ?? null);
  const myKeepLevel = useApp((s) => s.base?.player.keepLevel ?? null);
  const [sel, setSel] = useState<PlayerMarker | PveMarker | null>(null);
  const [sheet, setSheet] = useState<SheetState>('peek');
  const [sheetH, setSheetH] = useState<number>(MAPCHROME.peek);
  const [hideShielded, setHideShielded] = useState(false);
  const [legend, setLegend] = useState(false);
  const [warRoom, setWarRoom] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Array<{ wallet: string; name: string; seeker: boolean; keepLevel: number; trophies: number }> | null>(null);
  const searchCtl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setFound(null); return undefined; }
    const h = setTimeout(() => {
      // Same sequencing rule as /map: a slower earlier keystroke must never
      // overwrite a newer result list.
      searchCtl.current?.abort();
      const ctl = new AbortController();
      searchCtl.current = ctl;
      void api.get<{ results: typeof found }>(`/map/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => { if (!ctl.signal.aborted) setFound(r.results); })
        .catch(() => { if (!ctl.signal.aborted) setFound(null); });
    }, 250); // debounce — the endpoint is cheap but keystrokes are cheaper
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => () => searchCtl.current?.abort(), []);

  const win = useWindowSize();
  const inset = useSafeAreaInsets();
  const box = { w: win.w - inset.left - inset.right, h: win.h - inset.top - inset.bottom };

  // Markers carry the SERVER's answer (`inWindow`). A SEARCH HIT carries no
  // marker, so its attackability comes from the SAME shared predicate the server
  // applies (pvpAttackAllowed, D-099) — never a second rule of the client's own —
  // so the panel never offers a march the server is certain to 422. Server truth
  // wins regardless when ATTACK is pressed; this only suppresses a guaranteed-
  // losing tap. A null Keep (base not loaded yet) means "don't pre-emptively block".
  const keepAllows = (targetKeep: number): boolean =>
    myKeepLevel === null || pvpAttackAllowed(myKeepLevel, targetKeep);

  // The authored valley is 12 tiles wide; the server world is WORLD.gridCols.
  // Centre the authored grid so markers mostly stand inside it, with the
  // handout's endless frontier (foothills→peaks) filling the rest.
  const OX = Math.floor((WORLD.gridCols - worldTerrain.cols) / 2);
  const OY = Math.floor((WORLD.gridRows - worldTerrain.rows) / 2);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [chunk, setChunk] = useState<MapChunk | null>(null);
  const markers = useMemo(() => chunk?.markers ?? [], [chunk]);

  // A tile occupied by a base is always land (never open water) — the terrain
  // generator honours this via the land-override set (mapTerrain.genTile).
  // Silhouettes count: an anonymous keep must not stand in the sea either.
  const landSet = useMemo(
    () => new Set(markers.map((m) => `${m.x - OX},${m.y - OY}`)),
    [markers, OX, OY],
  );
  const field = useTileField(worldTerrain, OX, OY, landSet);
  const atlas = useMapAtlas();
  const silhouettes = useMemo<Silhouette[]>(
    () => markers.flatMap((m) => (m.kind === 'silhouette'
      ? [{ x: m.x, y: m.y, keepLevel: m.keepLevel }] : [])),
    [markers],
  );
  const paint = useTerrainPainter(canvasRef, atlas, worldTerrain, field, OX, OY, landSet, silhouettes);

  const onEmptyTap = useCallback(() => { setSel(null); setSheet('peek'); setSearchOpen(false); }, []);
  const mapCam = useMapCam({
    minC: OX - PAD, maxC: OX + worldTerrain.cols + PAD,
    minR: OY - PAD, maxR: OY + worldTerrain.rows + PAD,
    // PINCH OUT = GO TO THE GLOBE. Same route as the GLOBE button (which is what
    // `onGlobe` is), so the gesture and the control cannot diverge; absent with
    // the flag off, and then the pinch just bottoms out as it always did.
  }, paint, onEmptyTap, onGlobe);
  const { pub, vp } = mapCam;
  useEffect(() => { mapCam.markDirty(); }, [paint, mapCam]);

  // Ask the server for the tiles actually on screen, quantised so a small pan
  // reuses the last response (the fetch keys off these four numbers). Null until
  // the camera exists — that first call asks for the whole valley so we have a
  // marker to centre on.
  const rect = useMemo<MapRect | null>(() => {
    if (!pub || vp.w === 0) return null;
    const tp = TILE * pub.z;
    const q2 = 4; // quantise step, tiles — a render/network detail, not a game rule
    const snapLo = (v: number): number => Math.max(0, Math.floor((v - 2) / q2) * q2);
    return {
      x0: snapLo(pub.x),
      y0: snapLo(pub.y),
      x1: Math.min(WORLD.gridCols - 1, Math.ceil((pub.x + vp.w / tp + 2) / q2) * q2),
      y1: Math.min(WORLD.gridRows - 1, Math.ceil((pub.y + vp.h / tp + 2) / q2) * q2),
    };
  }, [pub, vp.w, vp.h]);
  // LOOK-ONLY WORLD (free onboarding, LOCKED 2026-08-09): a deedless player has
  // no parcel and therefore no valley of their own, so the board they open is a
  // preview — the globe is the thing to use, and descending into a valley is the
  // free visitor read. Server-derived: `entryPaid` is the server's land answer,
  // and with FREE_ONBOARDING off no deedless player ever reaches this screen.
  const previewOnly = !useApp((s) => s.entryPaid) && visitValleyId === undefined;
  const { data, error } = useMapChunk(rect, visitValleyId, !previewOnly);
  useEffect(() => { if (data) setChunk(data); }, [data]);
  // Descending into another valley must not leave the previous valley's markers
  // on screen while the first response is in flight — those keeps are not here.
  useEffect(() => { setChunk(null); setSel(null); }, [visitValleyId]);
  const visiting = chunk?.visiting === true;

  // The server always ships your own keep in full, even when it is off-viewport.
  const me = useMemo(() => markers.find((m): m is PlayerMarker => m.kind === 'player' && m.isMe), [markers]);
  useEffect(() => {
    if (pub || !chunk || vp.w === 0) return;
    mapCam.centerOn((me?.x ?? markers[0]?.x ?? WORLD.gridCols / 2) + 0.5, (me?.y ?? markers[0]?.y ?? WORLD.gridRows / 2) + 0.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunk, vp, pub]);

  const shown = useCallback(
    (m: Marker): boolean => !(hideShielded && m.kind === 'player' && !m.isMe && m.shielded),
    [hideShielded],
  );
  // TARGETS now means what it says: keeps the SERVER says you may actually march
  // on right now — not "rows that happened to be in the response".
  const targetCount = useMemo(() => markers
    .filter((m) => m.kind === 'player' && !m.isMe && m.inWindow && !m.shielded && shown(m)).length,
  [markers, shown]);
  // Own-clan tags render gold. Taken from your own marker so the map needs no
  // extra request to know which clan is "ours".
  const myClanTag = me?.clanTag ?? null;

  const byWallet = useMemo(() => {
    const m = new Map<string, PlayerMarker>();
    for (const k2 of markers) if (k2.kind === 'player') m.set(k2.wallet, k2);
    return m;
  }, [markers]);
  const byBaseId = useMemo(() => {
    const m = new Map<string, PlayerMarker>();
    for (const marker of markers) {
      if (marker.kind === 'player' && marker.baseId) m.set(marker.baseId, marker);
    }
    return m;
  }, [markers]);
  const recommended = useMemo(
    () => (chunk?.recommended ?? []).flatMap((target) => typeof target === 'string'
      ? byWallet.get(target) ?? []
      : byBaseId.get(target.baseId) ?? []),
    [chunk, byBaseId, byWallet],
  );

  const tapMarker = useCallback((m: PlayerMarker | PveMarker): void => {
    if (mapCam.didDragRef.current) return;
    setSel(m);
    setSheet('expanded');
  }, [mapCam.didDragRef]);
  const runScout = (m: PlayerMarker): void => {
    void openScout({ kind: 'pvp', wallet: m.wallet, defenderBaseId: m.baseId, name: m.name }, 'map',
      m.isMe ? 'YOUR BASE' : m.shielded ? 'SHIELDED — CANNOT BE RAIDED'
        : !m.inWindow ? 'THEIR KEEP IS TOO FAR BELOW YOURS' : undefined);
  };
  const attack = (m: PlayerMarker | PveMarker): void => {
    if (m.kind === 'pve') {
      setRaidTarget({ kind: 'pve', campId: m.id, name: `RUINED KEEP T${m.tier}` });
    } else {
      setRaidTarget({
        kind: 'pvp', wallet: m.wallet, defenderBaseId: m.baseId, name: m.name,
      });
    }
    setScreen('battle');
  };

  // Chrome: 3 rail toggles (4 with the globe), 2–3 zoom buttons, and whatever the
  // sheet published. With the flag off `railRowsForWorld(false)` is 3 — the exact
  // solve this board shipped before the globe (asserted in globeView.test.ts).
  const L = mapChrome(box.w, box.h, warRoom || legend ? 0 : sheetH,
    railRowsForWorld(!!onGlobe), me ? 3 : 2);
  const hitPx = hitSizeAt(pub?.z ?? 1);

  return (
    <div ref={mapCam.wrapRef} className="interactive" {...mapCam.panProps}
      style={{
        position: 'absolute', inset: 0, background: C.pine, overflow: 'hidden',
        touchAction: 'none', overscrollBehavior: 'none', userSelect: 'none',
        WebkitUserSelect: 'none', cursor: 'grab',
      }}>
      <style>{PULSE_CSS}</style>
      <canvas ref={canvasRef} data-mapsurface="1"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', imageRendering: 'pixelated' }} />
      <div ref={mapCam.layerRef} className="map-world" data-mapsurface="1"
        style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', willChange: 'transform' }}>
        {/* trophy-zone bands (decorative names — the server does not band the
            valley). Labels only from z 1 up: at min zoom they printed across the
            terrain and over the player's own nametag for no legibility gain. */}
        {WORLD_ZONES.map((zn) => (
          <div key={zn.name} style={{ pointerEvents: 'none' }}>
            <div style={{
              position: 'absolute', left: 0, top: (zn.row + OY) * TILE, width: WORLD.gridCols * TILE, height: 2, zIndex: 59,
              background: 'repeating-linear-gradient(90deg,rgba(227,174,60,.55) 0 8px,transparent 8px 16px)',
            }} />
            {(pub?.z ?? 1) >= 1 && (
              <div style={{
                position: 'absolute', left: 0, top: (zn.row + OY) * TILE + 4, width: WORLD.gridCols * TILE, zIndex: 60,
                padding: '2px 10px', display: 'flex', justifyContent: 'center',
                // CENTRED, and the fade is symmetric. Left-anchored on a band as
                // wide as the whole grid, the label sat at world x=0 — i.e. off
                // the left edge of every phone viewport, which is how it was
                // reported as "cut off at the left edge".
                background: 'linear-gradient(90deg,rgba(26,23,30,0),rgba(26,23,30,.85) 35%,rgba(26,23,30,.85) 65%,rgba(26,23,30,0))',
                color: C.text, fontSize: 15, letterSpacing: '2px',
              }}>{zn.name}</div>
            )}
          </div>
        ))}
        {pub && markers.map((m) => {
          if (m.kind === 'silhouette') return null; // drawn into the canvas
          if (!shown(m)) return null;
          if (m.x < pub.x - CULL || m.y < pub.y - CULL
            || m.x > pub.x + vp.w / (TILE * pub.z) + CULL
            || m.y > pub.y + vp.h / (TILE * pub.z) + CULL) return null;
          const isSel = sel !== null && (sel.kind === 'pve'
            ? m.kind === 'pve' && sel.id === m.id
            : m.kind === 'player' && sel.wallet === m.wallet);
          // Bottom-centre anchor: the keep STANDS on its tile (handout layout).
          const ax = m.x * TILE + TILE / 2, ay = m.y * TILE + TILE;
          if (m.kind === 'pve') {
            return (
              <span key={m.id} className="interactive" onClick={() => tapMarker(m)}
                style={{ position: 'absolute', left: ax, top: ay, zIndex: 400 + m.y, cursor: 'pointer', opacity: m.cleared ? 0.6 : 1 }}>
                {/* Zoom-invariant 44px hit rect: the sprite is 46px at z 1 but
                    only 32px at min zoom, under every touch-target minimum. */}
                <i style={{ position: 'absolute', left: -hitPx / 2, top: -hitPx / 2 - 16, width: hitPx, height: hitPx }} />
                <Sprite name="map_marker_ruins" w={46} h={46} style={{ position: 'absolute', left: -23, top: -46 }} />
                {isSel && <Sprite name="map_marker_select" w={46} h={46} style={{ position: 'absolute', left: -23, top: -46 }} />}
                <span style={{
                  position: 'absolute', left: 0, top: 4, transform: 'translateX(-50%)', whiteSpace: 'nowrap',
                  background: 'rgba(26,23,30,.86)', border: `1px solid ${C.border}`, color: C.textDim, fontSize: 13, padding: '0 5px',
                }}>RUINS T{m.tier}</span>
              </span>
            );
          }
          return (
            <span key={m.wallet} className="interactive" onClick={() => tapMarker(m)}
              style={{ position: 'absolute', left: ax, top: ay, zIndex: 400 + m.y, cursor: 'pointer' }}>
              <i style={{ position: 'absolute', left: -hitPx / 2, top: -hitPx / 2 - 22, width: hitPx, height: hitPx }} />
              <KeepNode m={m} isSel={isSel} myClanTag={myClanTag} />
            </span>
          );
        })}
      </div>

      <MapTopBar
        L={L} inset={inset} mode="world" onMode={setMapTab} onBack={() => setScreen('base')}
        title={`${visiting ? 'VISITING · ' : ''}${(chunk?.valleyName ?? 'REGION').toUpperCase()}`}
        trailing={(
          <>
            <IconBtn glyph={<Icon name="scout" size={21} />} label="SEARCH" on={searchOpen}
              onClick={() => { setSearchOpen((v) => !v); if (searchOpen) { setQ(''); setFound(null); } }}
              style={{ height: '100%', flex: 'none' }} />
            {myTrophies !== null && (
              <Pill style={{ alignSelf: 'center', flex: 'none', border: 'none' }}>
                <Icon name="trophy" size={18} />{fmtN(myTrophies)}
              </Pill>
            )}
          </>
        )}
      />

      {/* SEARCH — a full-width row UNDER the bar, width derived from the
          viewport. It used to be a fixed 230px box at top:52 that intersected
          the retired banner sprite and bled across the map. */}
      {searchOpen && (
        <UnderBar L={L} inset={inset}>
          <input autoFocus className="interactive" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="SEARCH NAME OR WALLET"
            onKeyDown={(e) => { if (e.key === 'Escape') { setSearchOpen(false); setQ(''); setFound(null); } }}
            style={{
              width: '100%', boxSizing: 'border-box', height: MAPCHROME.tap, flex: 'none',
              // 16px floor: iOS Safari zooms into a smaller text field and stays zoomed (2026-09-17).
              fontFamily: 'inherit', fontSize: 16, background: C.surface, color: C.text,
              border: `2px solid ${C.border}`, padding: '0 8px',
            }} />
          {found && (
            <div style={{
              width: '100%', boxSizing: 'border-box', background: C.card, border: `2px solid ${C.border}`,
              borderTop: 'none', maxHeight: L.searchMax, overflowY: 'auto',
            }}>
              {found.length === 0 && <div style={{ padding: 6, fontSize: 14, color: C.textFaint }}>NO MATCHES</div>}
              {found.map((r) => (
                <div key={r.wallet} className="interactive"
                  onClick={() => {
                    // A search hit behaves like tapping their marker: scout/attack
                    // panel. A search result carries no map state, so inWindow falls
                    // back to the shared Keep predicate — the server still has the
                    // last word when ATTACK is actually pressed.
                    setSel({
                      kind: 'player', x: 0, y: 0, wallet: r.wallet, name: r.name, seeker: r.seeker,
                      keepLevel: r.keepLevel, trophies: r.trophies, shielded: false, surplusTease: false, isMe: false,
                      clanTag: null, online: false, burning: false, revenge: false,
                      inWindow: keepAllows(r.keepLevel),
                    });
                    setSheet('expanded'); setSearchOpen(false); setQ(''); setFound(null);
                  }}
                  style={{ minHeight: MAPCHROME.tap, padding: '5px 8px', fontSize: 14, color: C.text, cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <PlayerName name={r.name} wallet={r.wallet} seeker={r.seeker} size={12} style={{ flex: 1 }} />
                  <span style={{ color: C.textFaint }}>K{r.keepLevel}</span>
                  <span style={{ color: C.goldHi, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Icon name="trophy" size={15} />{r.trophies}
                  </span>
                </div>
              ))}
            </div>
          )}
        </UnderBar>
      )}

      {/* rail: war room + filter + legend (handout right rail), now 44×44 icons
          that cannot run off the right edge (HIDE SHIELDED was cut in half). */}
      <IconRail L={L} inset={inset}>
        {/* GLOBE — the way back out after an explicit valley descent. WORLD now
            enters the globe first; this button remains for the mounted local view. */}
        {onGlobe && (
          <IconBtn glyph={<Sprite name="ui_compass" w={22} h={22} />} label="GLOBE" showLabel={L.showLabels} onClick={onGlobe}
            style={{ width: L.portrait ? L.rail.width : undefined, height: MAPCHROME.tap }} />
        )}
        <IconBtn glyph={<Icon name="shield" size={21} />} label="WARZONE" showLabel={L.showLabels}
          accent={recommended.some((r) => r.revenge) ? C.danger : undefined}
          onClick={() => setWarRoom(true)}
          style={{ width: L.portrait ? L.rail.width : undefined, height: MAPCHROME.tap }} />
        <IconBtn glyph="◇" label="HIDE SHIELDED" showLabel={L.showLabels} on={hideShielded}
          onClick={() => setHideShielded((v) => !v)}
          style={{ width: L.portrait ? L.rail.width : undefined, height: MAPCHROME.tap }} />
        <IconBtn glyph="?" label="LEGEND" showLabel={L.showLabels} onClick={() => setLegend(true)}
          style={{ width: L.portrait ? L.rail.width : undefined, height: MAPCHROME.tap }} />
      </IconRail>
      {/* A full-screen overlay owns the board while it is open — the zoomer would
          only sit unreachable beneath it. */}
      {!warRoom && !legend && (
        <ZoomRail L={L} inset={inset} sheetH={sheetH} step={ZOOM.step}
          zoomBy={mapCam.zoomBy} onHome={me ? () => mapCam.centerOn(me.x + 0.5, me.y - 0.8) : undefined} />
      )}

      {error && <ErrPanel msg={error} inset={inset} />}

      {legend && (
        <Legend title="MAP LEGEND" inset={inset} onClose={() => setLegend(false)} rows={[
          ['map_own', 'YOUR PARCEL', 'Your keep on the one plot your Land Deed owns. Gold ring + banner, always visible, never a target.'],
          ['map_keep_t3', 'ENEMY KEEP', 'Marker size and gold trim scale with Keep level (T1–T5). The L-badge is the exact level.'],
          ['map_shield', 'SHIELDED', 'Blue bubble. Cannot be attacked until the shield drops.'],
          ['map_loot', 'GOLD SURPLUS', 'This keep is sitting on a surplus. Scout it to see the layout — exact loot is never shown.'],
          ['map_revenge', 'REVENGE', `They raided you in the last ${RAID_RULES.revengeLockHours}h. The Keep rule still applies — a revenge target too far below you says so.`],
          ['map_ash', 'SCORCHED', `Raided in the last ${WORLD.mapBurningHours}h. Somebody already emptied this one.`],
          ['map_keep_t2', 'UNKNOWN KEEP', 'Grey and unnamed: their Keep is too far below yours or they are beyond the top targets, so there is nothing to do with it.'],
          ['map_marker_ruins', 'RUINED KEEP', 'PvE bandits. Free to raid — no energy cost, shield safe.'],
          ['map_road_cross', 'ROADS', 'Cosmetic. Roads connect settlements and make the valley readable at low zoom.'],
          ['map_mtn_peak', 'THE FRONTIER', 'Mountains fence the valley. Every base in your valley lives inside them.'],
        ]} />
      )}

      {/* WAR ROOM — the server's ranking, made tappable. Browsing ~500 markers is
          a chore; this is the shortlist the map already computed. */}
      {warRoom && (
        // WRAPPED, not restyled: `Panel9` is shared with every other screen and takes
        // no pointer props, so the guard lives on a wrapper here — the war room is a
        // DESCENDANT of the board root, which carries `panProps`, and dragging its
        // scrollable list panned the valley behind the panel. Every wrapper in
        // ui/mapChromeUI.tsx already spreads this; the two surfaces map.tsx places
        // itself (this and the legend) were the only ones left out.
        <div className="interactive" {...chromePanGuard} style={{
          position: 'absolute', zIndex: 1250, display: 'flex', flexDirection: 'column',
          left: MAPCHROME.pad + inset.left, right: MAPCHROME.pad + inset.right,
          top: L.underBar.top + inset.top, bottom: MAPCHROME.pad + inset.bottom,
        }}>
          <Panel9 style={{
            flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column',
          }}>
            <Phead title="WARZONE" onClose={() => setWarRoom(false)}
              right={<Pill style={{ border: 'none' }}><Icon name="trophy" size={18} />{myTrophies === null ? '—' : fmtN(myTrophies)}</Pill>} />
            <div style={{ overflowY: 'auto', minHeight: 0, padding: '6px 10px 10px' }}>
              <Suspense fallback={<div role="status" style={{ color: C.textFaint, padding: 10 }}>READING WARZONE STATUS…</div>}>
                <WarzoneDetails onShop={() => setScreen('shop')} />
              </Suspense>
              <div style={{ color: C.goldHi, fontSize: 17, margin: '7px 0' }}>ATTACKABLE KEEPS</div>
              {recommended.length === 0 && (
                <div style={{ color: C.textFaint, fontSize: 16, padding: 10 }}>
                  {/* The restriction, stated (D-099): a bare "no keeps" reads as a
                      quiet server when it is a rule the player can act on. */}
                  No keeps you may attack right now{myKeepLevel === null
                    ? ''
                    : ` — a target needs a Keep of L${pvpMinDefenderKeep(myKeepLevel)} or more`}.
                  Pan the map, or raid a RUINED KEEP.
                </div>
              )}
              {recommended.map((r) => (
                <Chip key={r.wallet} onClick={() => {
                  mapCam.centerOn(r.x + 0.5, r.y - 0.8);
                  setSel(r); setSheet('expanded'); setWarRoom(false);
                }} style={{ marginBottom: 6, width: '100%', minHeight: MAPCHROME.tap, boxSizing: 'border-box' }}>
                  <Sprite name={`map_keep_t${Math.min(5, Math.max(1, r.keepLevel))}`} w={26} h={28} />
                  <span style={{ color: C.text, fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.clanTag && <b style={{ color: C.textFaint, fontSize: 13 }}>[{r.clanTag}] </b>}
                    {r.name || `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}`}
                  </span>
                  {r.revenge && <span style={{ color: C.danger, fontSize: 14 }}>REVENGE</span>}
                  {r.surplusTease && <Sprite name="map_loot" w={18} h={18} />}
                  {r.burning && <span style={{ color: C.textFaint, fontSize: 14 }}>SCORCHED</span>}
                  {r.online && <i style={{ width: 6, height: 6, background: C.success, display: 'inline-block' }} />}
                  <Sp />
                  <span style={{ color: C.textFaint, fontSize: 14 }}>L{r.keepLevel}</span>
                  <span style={{ color: C.goldHi, fontSize: 15, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Icon name="trophy" size={15} />{fmtN(r.trophies)}
                  </span>
                </Chip>
              ))}
            </div>
          </Panel9>
        </div>
      )}

      {/* THE SHEET — one component, three states. The status pills below used to
          float at bottom:12 and were buried under the z-1100 target sheet even
          when it was minimised; they live in the peek band now, so they are
          always readable. */}
      <MapSheet
        L={L} inset={inset} state={warRoom || legend ? 'hidden' : sheet}
        onCollapse={() => setSheet('peek')} onHeight={setSheetH}
        peek={sel ? (
          <>
            <IconBtn glyph="✕" label="CLOSE" onClick={() => { setSel(null); setSheet('peek'); }}
              style={{ flex: 'none', height: MAPCHROME.tap - 8 }} />
            <span style={{
              flex: '1 1 0', minWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: C.gold, fontSize: 17, letterSpacing: '1px',
            }}>
              {sel.kind === 'player'
                ? `${sel.clanTag ? `[${sel.clanTag}] ` : ''}${sel.name} · L${sel.keepLevel}`
                : `RUINED KEEP T${sel.tier} · BANDITS`}
            </span>
            {sel.kind === 'player' && (
              <Pill style={{ flex: 'none', border: 'none' }}><Icon name="trophy" size={18} />{fmtN(sel.trophies)}</Pill>
            )}
            <IconBtn glyph={sheet === 'expanded' ? '▾' : '▴'} label={sheet === 'expanded' ? 'MINIMISE' : 'EXPAND'}
              onClick={() => setSheet(sheet === 'expanded' ? 'peek' : 'expanded')}
              style={{ flex: 'none', height: MAPCHROME.tap - 8 }} />
          </>
        ) : (
          <>
            {/* The retired 216×54 top-bar banner, in its new home. */}
            <RegionPlate title={(previewOnly ? 'THE WORLD' : (chunk?.valleyName ?? 'REGION')).toUpperCase()}
              sub={previewOnly ? 'LOOK ONLY · NO PARCEL YET'
                : visiting ? 'VISITING · READ-ONLY'
                : chunk?.warzoneActive ? 'REGION · WARZONE' : 'REGION · PvP'} />
            {/* A VISIT is shapes and a name: the payload carries no wallets, no
                names and no camp ids, so there is nothing to raid and nothing to
                scout. Say so, and offer the way back. */}
            {previewOnly ? (
              /* No parcel means no row in any valley roster — there is literally
                 nothing of this player's on this board and nothing here they may
                 aim at. Say that, and offer the one thing that changes it. */
              <Pill style={{ flex: 'none' }} accent={C.goldDp}
                onClick={() => useApp.getState().setLandPrompt('browse')}>
                <Icon name="sol" size={16} /><PillSub>BUY LAND TO JOIN THE WORLD</PillSub>
              </Pill>
            ) : visiting ? (
              <>
                <Pill style={{ flex: 'none' }}><PillSub>SHAPES ONLY · NOBODY IS NAMED</PillSub></Pill>
                {onExitVisit && (
                  /* Home is YOUR PARCEL — the valley is the neighbourhood, the
                     parcel is the land. Same word the globe's rail uses. */
                  <IconBtn glyph="⌂" label="MY PARCEL" showLabel onClick={onExitVisit}
                    style={{ flex: 'none', height: MAPCHROME.tap - 8 }} />
                )}
              </>
            ) : (
              <>
                {energy && <Pill style={{ flex: 'none' }}><Icon name="energy" size={16} />{energy.free}/{energy.max}<PillSub>FREE RAIDS</PillSub></Pill>}
                <Pill style={{ flex: 'none' }}>{targetCount}<PillSub>TARGETS</PillSub></Pill>
              </>
            )}
          </>
        )}>
        {sel && sheet === 'expanded' && (sel.kind === 'player' ? (
          <>
            {/* App L856: GARRISON SIGHTED · EST. LOOT + shard tease. The /map
                marker only exposes surplusTease:boolean (GDD §3.4 deliberately
                withholds the number), so we render the App's "· EST. LOOT"
                framing without a fabricated figure. */}
            <div style={{ display: 'flex', gap: 8, padding: '8px 12px', alignItems: 'center', color: C.textFaint, fontSize: 17, flexWrap: 'wrap' }}>
              <Sprite name={troopPortrait('turrider')} w={40} h={40} />
              <span style={sel.revenge ? { color: C.danger } : undefined}>
                {/* `inWindow` is the SERVER's answer to the same Keep predicate
                    the raid gate uses (D-099). A revenge target outside it says
                    so plainly — with the two levels — rather than pretending the
                    tap will work. */}
                {sel.shielded ? 'SHIELDED — CANNOT BE RAIDED'
                  // WHERE YOUR LAND IS, where you already look at it. `x,y` is
                  // `plots.(x, y)` — the parcel the deed owns — and it is already
                  // in this marker, so saying it costs a template string.
                  : sel.isMe ? `YOUR BASE · PARCEL ${sel.x},${sel.y}`
                  : !sel.inWindow
                    ? `${sel.revenge ? 'REVENGE — ' : ''}THEIR KEEP IS TOO FAR BELOW YOURS`
                      + (myKeepLevel === null ? '' : ` (L${sel.keepLevel} vs your L${myKeepLevel})`)
                  : sel.revenge ? 'REVENGE — THEY RAIDED YOU'
                  : 'GARRISON SIGHTED'}
              </span>
              {sel.seeker && <SeekerBadge size={15} />}
              {sel.burning && <span style={{ color: C.textFaint, fontSize: 15 }}>· RECENTLY RAIDED</span>}
              {sel.online && <span style={{ color: C.success, fontSize: 15 }}>· ONLINE</span>}
              {!sel.shielded && sel.inWindow && sel.surplusTease && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.goldHi }}>
                  · EST. LOOT <Icon name="shard" size={16} />
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, padding: '0 12px 12px' }}>
              {/* SCOUT is ungated server-side (D-099: world.ts scoutBase rejects
                  only self and the other land tier — never a shield, never the
                  Keep rule), so it stays live on a shielded or out-of-reach base. */}
              <Btn variant="sec" style={{ flex: 1, minHeight: MAPCHROME.tap }} disabled={sel.isMe} onClick={() => runScout(sel)}>
                <Icon name="scout" size={22} />SCOUT
              </Btn>
              {/* App L861: MARCH · 2H — the real cost is raid energy, so we show
                  free raids left / daily ceiling from server base.energy. */}
              <Btn style={{ flex: 1, minHeight: MAPCHROME.tap }} disabled={sel.shielded || sel.isMe || !sel.inWindow}
                onClick={() => attack(sel)}>
                <Icon name="attack" size={22} />ATTACK{energy ? ` · ${energy.free}/${energy.max}` : ''}
              </Btn>
            </div>
            <div style={{ padding: '0 12px 12px' }}><RaidEntryCost /></div>
          </>
        ) : sel.kind === 'pve' ? (
          <div style={{ padding: '8px 12px 12px' }}>
            {/* App L858: RUINED KEEP · BANDITS, NO ENERGY COST - SHIELD SAFE,
                FREE · BOUNTY {bounty}. PvE is free (no raid energy spent —
                world.ts), so MARCH stays unlabelled below. */}
            <Chip onClick={() => attack(sel)} style={{ marginBottom: 8, minHeight: MAPCHROME.tap, boxSizing: 'border-box' }}>
              <Sprite name="map_marker_ruins" w={28} h={28} />
              <span style={{ color: C.textDim, fontSize: 16 }}>{sel.cleared ? 'CLEARED · RESPAWNS DAILY' : 'NO ENERGY COST · SHIELD SAFE'}</span>
              <Sp />
              <span style={{ color: C.success, fontSize: 15 }}>FREE · BOUNTY {sel.bounty}</span>
            </Chip>
            <Btn style={{ width: '100%', minHeight: MAPCHROME.tap }} disabled={sel.cleared} onClick={() => attack(sel)}>
              <Icon name="attack" size={22} />MARCH
            </Btn>
          </div>
        ) : null)}
      </MapSheet>
    </div>
  );
}

// ============================================================================
// CAMPAIGN (PvE)
// ============================================================================

type StageState = 'done' | 'open' | 'locked';
interface StageView {
  srv: CampaignStage; c: number; r: number; name: string; state: StageState;
  boss: boolean; miniBoss: boolean;
}

function CampaignMap(): React.JSX.Element {
  const selectedBaseId = useApp((state) => state.selectedBaseId);
  const { data, reload, error } = useFetch<{ stages: CampaignStage[] }>(
    () => api.get(selectedBasePath('/campaign')),
    [selectedBaseId],
  );
  const setScreen = useApp((s) => s.setScreen);
  const setMapTab = useApp((s) => s.setMapTab);
  const setRaidTarget = useApp((s) => s.setRaidTarget);
  useEffect(() => { reload(); /* fresh stars after every battle */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [sel, setSel] = useState<number | null>(null); // stage number
  const [sheet, setSheet] = useState<SheetState>('peek');
  const [sheetH, setSheetH] = useState<number>(MAPCHROME.peek);
  const [legend, setLegend] = useState(false);
  const [activeAct, setActiveAct] = useState(1);
  const initialActChosen = useRef(false);

  const win = useWindowSize();
  const inset = useSafeAreaInsets();
  const box = { w: win.w - inset.left - inset.right, h: win.h - inset.top - inset.bottom };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const field = useTileField(campaignTerrain, 0, 0, undefined);
  const atlas = useMapAtlas();
  const noSil = useMemo<Silhouette[]>(() => [], []);
  const paint = useTerrainPainter(canvasRef, atlas, campaignTerrain, field, 0, 0, undefined, noSil);

  const onEmptyTap = useCallback(() => { setSel(null); setSheet('peek'); }, []);
  const mapCam = useMapCam({
    minC: -PAD, maxC: campaignTerrain.cols + PAD,
    minR: -PAD, maxR: campaignTerrain.rows + PAD,
  }, paint, onEmptyTap);
  const { pub, vp } = mapCam;
  useEffect(() => { mapCam.markDirty(); }, [paint, mapCam]);

  // Server rows own both encounter identity and progression. The client only
  // paints the authored terrain underneath them.
  const allStages: StageView[] = useMemo(() => {
    return (data?.stages ?? []).map((srv) => {
      const state: StageState = srv.bestStars > 0 ? 'done' : srv.unlocked ? 'open' : 'locked';
      return {
        srv, c: srv.position.c, r: srv.position.r, name: srv.name, state,
        boss: srv.threat === 'boss', miniBoss: srv.threat === 'mini_boss',
      };
    });
  }, [data]);
  const stages = useMemo(() => allStages.filter((s) => s.srv.act === activeAct), [allStages, activeAct]);
  const next = allStages.find((s) => s.state === 'open');
  const totStars = allStages.reduce((a, s) => a + s.srv.bestStars, 0);
  const cleared = allStages.filter((s) => s.state === 'done').length;
  // Server count once loaded; constants count during the loading flash — one
  // source for label, pill AND bar so they can never disagree (review note).
  const stageCount = allStages.length || CAMPAIGN.totalStages;
  const maxStars = stageCount * 3;
  const maxTier = 20;

  useEffect(() => {
    const frontier = next ?? allStages.at(-1);
    if (!frontier || initialActChosen.current) return;
    initialActChosen.current = true;
    setActiveAct(frontier.srv.act);
  }, [next, allStages]);

  useEffect(() => {
    if (pub || vp.w === 0 || stages.length === 0) return;
    const target = (next?.srv.act === activeAct ? next : undefined) ?? stages[0]!;
    mapCam.centerOn(target.c + 0.5, target.r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, pub, stages, activeAct]);

  // SELECT ONLY. This used to centreOn BEFORE setting sel, so the tapped node
  // jumped to the middle of the screen and a second tap at the same point hit a
  // DIFFERENT stage. Recentring is now an explicit act (⌂ / ACT tab / NEXT).
  const pickStage = useCallback((n: number): void => {
    if (!allStages.some((x) => x.srv.stage === n)) return;
    setSel(n);
    setSheet('expanded');
  }, [allStages]);
  const attack = (s: StageView): void => {
    toast('MARCHING…');
    setRaidTarget({ kind: 'campaign', stage: s.srv.stage, name: `STAGE ${s.srv.stage} · ${s.name}` });
    setScreen('battle');
  };
  const tapNode = useTapGate(mapCam);

  const selStage = sel === null ? null : allStages.find((s) => s.srv.stage === sel) ?? null;
  const nodeFrame = (s: StageView): string =>
    s.state === 'done' ? 'map_node_done' : s.state === 'locked' ? 'map_node_locked'
      : s.boss || s.miniBoss ? 'map_node_boss' : 'map_node_open';

  const L = mapChrome(box.w, box.h, legend ? 0 : sheetH, 2, next ? 3 : 2);
  const hitPx = hitSizeAt(pub?.z ?? 1);

  return (
    <div ref={mapCam.wrapRef} className="interactive" {...mapCam.panProps}
      style={{
        position: 'absolute', inset: 0, background: C.pine, overflow: 'hidden',
        touchAction: 'none', overscrollBehavior: 'none', userSelect: 'none',
        WebkitUserSelect: 'none', cursor: 'grab',
      }}>
      <style>{PULSE_CSS}</style>
      <canvas ref={canvasRef} data-mapsurface="1"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', imageRendering: 'pixelated' }} />
      <div ref={mapCam.layerRef} className="map-world" data-mapsurface="1"
        style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', willChange: 'transform' }}>
        {/* act divider lines + bands (labels from z 1 up — see WORLD_ZONES) */}
        {CAMPAIGN_ACTS.filter((a) => a.act === activeAct).map((a) => (
          <div key={a.act} style={{ pointerEvents: 'none' }}>
            <div style={{
              position: 'absolute', left: 0, top: a.row * TILE + TILE - 2, width: campaignTerrain.cols * TILE, height: 2, zIndex: 59,
              background: 'repeating-linear-gradient(90deg,rgba(227,174,60,.55) 0 8px,transparent 8px 16px)',
            }} />
            {(pub?.z ?? 1) >= 1 && (
              <div style={{
                position: 'absolute', left: 0, top: a.row * TILE + TILE + 4, width: campaignTerrain.cols * TILE, zIndex: 60,
                padding: '3px 12px', display: 'flex', justifyContent: 'center', gap: 6, whiteSpace: 'nowrap',
                // Centred for the same reason as WORLD_ZONES above.
                background: 'linear-gradient(90deg,rgba(26,23,30,0),rgba(26,23,30,.9) 30%,rgba(26,23,30,.9) 70%,rgba(26,23,30,0))',
                fontSize: 16, letterSpacing: '2px', color: a.color,
              }}>
                ACT {a.act} · {a.name} <span style={{ color: C.gold, fontSize: 12, letterSpacing: '1px' }}>{a.sub}</span>
              </div>
            )}
          </div>
        ))}
        {/* path dots between consecutive stages (lit once the NEXT stage is unlocked) */}
        {stages.slice(0, -1).map((a, i) => {
          const b = stages[i + 1]!;
          const ax = a.c * TILE + TILE / 2, ay = a.r * TILE + TILE / 2;
          const bx = b.c * TILE + TILE / 2, by = b.r * TILE + TILE / 2;
          const lit = b.srv.unlocked;
          return Array.from({ length: 4 }, (_, t) => {
            const p = (t + 1) / 5, x = ax + (bx - ax) * p, y = ay + (by - ay) * p;
            return <Sprite key={`p${a.srv.stage}-${t}`} name={lit ? 'map_path_dot' : 'map_path_dot_off'} w={10} h={10}
              style={{ position: 'absolute', left: x - 5, top: y - 5, zIndex: 300 }} />;
          });
        })}
        {/* stage nodes */}
        {stages.map((s) => {
          const size = s.boss ? 55 : s.miniBoss ? 49 : 43;
          const x = s.c * TILE + TILE / 2, y = s.r * TILE + TILE / 2;
          const isNext = next?.srv.stage === s.srv.stage;
          return (
            <span key={s.srv.stage} className="interactive" onClick={tapNode(() => pickStage(s.srv.stage))}
              style={{ position: 'absolute', left: x, top: y, zIndex: 400 + s.r, cursor: 'pointer' }}>
              {/* THE hit rect. The old node was a 0×0 span whose hit box was the
                  union of its children INSIDE the scale(z) layer, so an ordinary
                  43px node measured 43 × 0.7 = 30px on screen at min zoom. This
                  is sized in layer units so it is always 44px on screen. */}
              <i style={{ position: 'absolute', left: -hitPx / 2, top: -hitPx / 2, width: hitPx, height: hitPx }} />
              <Sprite name={nodeFrame(s)} w={size} h={size} style={{ position: 'absolute', left: -size / 2, top: -size / 2 }} />
              {s.state !== 'locked' && (
                <span style={{
                  position: 'absolute', left: size / 2 - 10, top: -size / 2 - 3, background: C.ink, border: `2px solid ${C.gold}`,
                  color: C.goldHi, fontSize: 12, lineHeight: 1, padding: '1px 4px', letterSpacing: '1px',
                }}>{s.srv.stage}</span>
              )}
              {s.srv.unlocked && (
                <span style={{ position: 'absolute', left: -17, top: size / 2 - 3, display: 'flex', gap: 1 }}>
                  {[0, 1, 2].map((i) => (
                    <Sprite key={i} name={i < s.srv.bestStars ? 'map_star_on' : 'map_star_off'} w={10} h={10} />
                  ))}
                </span>
              )}
              {isNext && (
                <span style={{
                  position: 'absolute', left: 0, top: size / 2 + 12, transform: 'translateX(-50%)', whiteSpace: 'nowrap',
                  background: 'rgba(26,23,30,.86)', border: `1px solid ${C.gold}`, color: C.goldHi, fontSize: 12,
                  padding: '0 5px', letterSpacing: '1px', animation: 'skmapPulse 1.1s steps(6,end) infinite',
                }}>▶ NEXT</span>
              )}
            </span>
          );
        })}
      </div>

      <MapTopBar
        L={L} inset={inset} mode="campaign" onMode={setMapTab} onBack={() => setScreen('base')}
        title={`SINGLE PLAYER · ${stageCount} STAGES`}
        trailing={(
          <Pill style={{ alignSelf: 'center', flex: 'none', border: 'none' }}>
            <Sprite name="map_star_on" w={16} h={16} />{totStars}<PillSub>/{maxStars}</PillSub>
          </Pill>
        )}
      />

      {/* ACT tabs — a horizontally SCROLLING strip under the bar (the .hud-strip
          pattern). As three absolutely-positioned pills in the right rail they
          overlapped each other over the map and clipped at the left edge. */}
      <UnderBar L={L} inset={inset} scroll>
        {CAMPAIGN_ACTS.map((a) => {
          const first = allStages.find((s) => s.srv.act === a.act);
          return (
            <IconBtn key={a.act} glyph="" label={`ACT ${a.act}`} showLabel
              onClick={() => {
                setActiveAct(a.act);
                setSel(null);
                if (first) mapCam.centerOn(first.c + 0.5, first.r);
              }}
              style={{ flex: 'none', height: MAPCHROME.tap }} />
          );
        })}
      </UnderBar>

      <IconRail L={L} inset={inset}>
        <IconBtn glyph="▶" label="NEXT STAGE" showLabel={L.showLabels}
          onClick={() => { if (next) {
            setActiveAct(next.srv.act);
            pickStage(next.srv.stage);
            mapCam.centerOn(next.c + 0.5, next.r - 0.6);
          } }}
          style={{ width: L.portrait ? L.rail.width : undefined, height: MAPCHROME.tap }} />
        <IconBtn glyph="?" label="LEGEND" showLabel={L.showLabels} onClick={() => setLegend(true)}
          style={{ width: L.portrait ? L.rail.width : undefined, height: MAPCHROME.tap }} />
      </IconRail>
      {!legend && (
        <ZoomRail L={L} inset={inset} sheetH={sheetH} step={ZOOM.step}
          zoomBy={mapCam.zoomBy} onHome={next ? () => mapCam.centerOn(next.c + 0.5, next.r - 0.6) : undefined} />
      )}

      {error && <ErrPanel msg={error} inset={inset} />}

      {legend && (
        <Legend title="CAMPAIGN LEGEND" inset={inset} onClose={() => setLegend(false)} rows={[
          ['map_node_done', 'CLEARED', 'Green tick + gold ring. Stars under the node show your best run (max 3).'],
          ['map_node_open', 'AVAILABLE', 'Crossed blades. Playable now — the pulsing "NEXT" tag marks your current stage.'],
          ['map_node_locked', 'LOCKED', 'Clear the previous stage to open it. The path dots between nodes go dark while locked.'],
          ['map_node_boss', 'BOSS STAGE', 'End of an act. A bigger base and a one-time first-3★ reward.'],
          ['map_star_on', 'STARS', `1★ = ${RAID_RULES.oneStarDestructionPct}% destruction · 2★ = Keep destroyed · 3★ = ${RAID_RULES.threeStarDestructionPct}%. Replays can only add stars, never remove them.`],
          ['map_ash', 'ACT TERRAIN', 'Bandit coast → drowned wood → ashlands → gloam march → shard wastes.'],
        ]} />
      )}

      <MapSheet
        L={L} inset={inset} state={legend ? 'hidden' : sheet}
        onCollapse={() => setSheet('peek')} onHeight={setSheetH}
        peek={selStage ? (
          <>
            <IconBtn glyph="✕" label="CLOSE" onClick={() => { setSel(null); setSheet('peek'); }}
              style={{ flex: 'none', height: MAPCHROME.tap - 8 }} />
            <span style={{
              flex: '1 1 0', minWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: C.gold, fontSize: 17, letterSpacing: '1px',
            }}>
              {selStage.state === 'locked'
                ? `STAGE ${selStage.srv.stage} · LOCKED`
                : `${selStage.boss ? '☠ ' : ''}STAGE ${selStage.srv.stage} · ${selStage.name}`}
            </span>
            <span style={{ display: 'flex', gap: 2, flex: 'none' }}>
              {[0, 1, 2].map((i) => (
                <Sprite key={i} name={i < selStage.srv.bestStars ? 'map_star_on' : 'map_star_off'} w={20} h={20} />
              ))}
            </span>
            <IconBtn glyph={sheet === 'expanded' ? '▾' : '▴'} label={sheet === 'expanded' ? 'MINIMISE' : 'EXPAND'}
              onClick={() => setSheet(sheet === 'expanded' ? 'peek' : 'expanded')}
              style={{ flex: 'none', height: MAPCHROME.tap - 8 }} />
          </>
        ) : (
          <>
            <RegionPlate title="CAMPAIGN" sub={`${cleared}/${stageCount} CLEARED`} />
            <Pill style={{ flex: 'none' }}>
              <Sprite name="map_star_on" w={16} h={16} />{totStars}<PillSub>/{maxStars} ★</PillSub>
            </Pill>
            <Pill style={{ flex: 'none' }}>
              <span style={{ width: 60, height: 8, background: C.card, border: `1px solid ${C.border}`, display: 'inline-block' }}>
                <i style={{ display: 'block', height: '100%', background: C.gold, width: `${maxStars ? (totStars / maxStars) * 100 : 0}%` }} />
              </span>
              <PillSub>PROGRESS</PillSub>
            </Pill>
            <Pill style={{ flex: 'none' }}><PillSub>FREE · YOUR BASE IS NEVER AT RISK</PillSub></Pill>
          </>
        )}>
        <div data-onboarding-caption-slot="campaign" style={{ padding: '0 10px' }} />
        {selStage && sheet === 'expanded' && (selStage.state === 'locked' ? (
          <div style={{ padding: '10px 12px 12px' }}>
            <div style={{ color: C.textFaint, fontSize: 16, marginBottom: 8 }}>
              Clear <span style={{ color: C.gold }}>STAGE {selStage.srv.stage - 1}</span> to open this one.
              Stages unlock in order; stars can be improved by replaying.
            </div>
            <Btn variant="sec" style={{ width: '100%', minHeight: MAPCHROME.tap }} onClick={() => pickStage(selStage.srv.stage - 1)}>
              ◀ GO TO STAGE {selStage.srv.stage - 1}
            </Btn>
          </div>
        ) : (
          <div style={{ padding: '10px 12px 12px' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 15, letterSpacing: '1px', color: C.textDim }}>DIFFICULTY</span>
              {/* Keep band comes from the server-generated campaign stage. */}
              <span style={{ fontSize: 18 }}>
                {Array.from({ length: maxTier }, (_, i) => (
                  <span key={i} style={{ color: i < selStage.srv.tier ? C.danger : C.border }}>☠</span>
                ))}
              </span>
              <Chip style={{ padding: '2px 8px' }}><span style={{ color: C.textFaint, fontSize: 14 }}>KEEP</span><b style={{ color: C.goldHi }}>{selStage.srv.keepLevel}</b></Chip>
              <Chip style={{ padding: '2px 8px' }}><span style={{ color: C.textFaint, fontSize: 14 }}>REC.</span><b style={{ color: C.goldHi }}>{selStage.srv.recommendedArmyPoints} PTS</b></Chip>
            </div>
            {/* first-3★ reward — the real shared constant, marked claimed once paid */}
            <Chip style={{ marginBottom: 8 }}>
              <span style={{ color: C.textDim, fontSize: 15 }}>FIRST 3★ REWARD</span>
              <Icon name="shard" size={16} />
              <b style={{ color: selStage.srv.firstThreeStarClaimed ? C.textFaint : C.success }}>
                {fmtN(CAMPAIGN.firstThreeStarShardsByKeep[selStage.srv.keepLevel - 1] ?? 0)}
              </b>
              <Sp />
              {selStage.srv.firstThreeStarClaimed && <span style={{ color: C.textFaint, fontSize: 14 }}>CLAIMED</span>}
            </Chip>
            {(selStage.boss || selStage.miniBoss) && (
              <Chip style={{ marginBottom: 8 }}>
                <span style={{ color: C.danger, fontSize: 15 }}>
                  {selStage.boss ? 'BOSS BASE' : 'MINI-BOSS BASE'}
                </span>
                <span style={{ color: C.textDim, fontSize: 15 }}>
                  {selStage.srv.defenderHero
                    ? `${selStage.srv.defenderHero.toUpperCase()} GARRISONED`
                    : selStage.srv.tactic.toUpperCase()}
                </span>
              </Chip>
            )}
            <div style={{ color: C.textDim, fontSize: 14, marginBottom: 8 }}>
              {selStage.srv.tactic.toUpperCase()}
            </div>
            <div data-tutorial-target="campaign-attack">
              <Btn style={{ width: '100%', marginBottom: 6, minHeight: MAPCHROME.tap }} onClick={() => attack(selStage)}>
                <Icon name="attack" size={22} />{selStage.state === 'done' ? 'REPLAY' : 'ATTACK'}
              </Btn>
            </div>
            <div style={{ color: C.textFaint, fontSize: 14 }}>
              {selStage.state === 'done'
                ? 'Already cleared — the 3★ reward is one-time, stars can still be improved.'
                : 'Retries are free. First 3★ pays a one-time shard reward.'}
            </div>
          </div>
        ))}
      </MapSheet>
    </div>
  );
}

// ============================================================================

/** WORLD always mounts the globe. The dynamic import keeps its rasteriser and
 * fine Earth data outside first paint while the player is on another screen. */
const GlobeLayer = lazy(() => import('./globe/GlobeLayer').then((m) => ({ default: m.GlobeLayer })));
const FantasyWorldLayer = lazy(() => import('../fantasy/FantasyWorldLayer').then((m) => ({ default: m.FantasyWorldLayer })));
const FantasyCampaign = lazy(() => import('../fantasy/FantasyCampaign').then((m) => ({ default: m.FantasyCampaign })));
const FANTASY_WORLD_ENABLED = import.meta.env.VITE_FEATURE_FANTASY_WORLD === '1';

export function MapScreen({ destination, onClose, actionsEnabled }: MapFeatureHostProps): React.JSX.Element {
  // MAPS split (E2/E3): WORLD = the deed globe; CAMPAIGN = the PvE stage map.
  // The tab lives in the STORE (2026-08-09), not here: the RAID chooser deep
  // links straight to CAMPAIGN, which local mount state could not express.
  // The BASE + WORLD | CAMPAIGN controls moved INTO each board's top bar (the
  // one 44px chrome row), which is what stopped them clipping the region banner
  // and the campaign title behind themselves.
  const mode = useApp((s) => s.mapTab);
  const leave = useApp((s) => s.setScreen);
  const fallback = <div className="sk-game-loading-shell"><button className="sk-game-loading-back" onClick={() => leave('base')}>‹ BASE</button><GameLoading title={mode === 'campaign' ? 'Opening the campaign…' : 'Opening the world…'} /></div>;

  return (
    <div className="interactive" style={{
      position: 'absolute', inset: 0, overflow: 'hidden', background: '#0B0E14',
    }}>
      {mode === 'campaign' ? (FANTASY_WORLD_ENABLED ? <Suspense fallback={fallback}><FantasyCampaign /></Suspense> : <CampaignMap />) : null}
      {mode === 'world' && (
        <Suspense fallback={fallback}>
          {FANTASY_WORLD_ENABLED ? <FantasyWorldLayer /> : <GlobeLayer openSeq={1} />}
        </Suspense>
      )}
      <MapFeatureHost destination={destination} onClose={onClose} actionsEnabled={actionsEnabled} />
    </div>
  );
}
