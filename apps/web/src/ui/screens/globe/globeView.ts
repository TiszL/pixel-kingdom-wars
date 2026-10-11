/**
 * PIXEL EARTH — every rule the globe band obeys, as pure functions.
 *
 * The canvas, the pointer handlers and the fetches live next door
 * (globeRaster.ts / PixelGlobe.tsx / GlobeLayer.tsx). What lives HERE is
 * everything that can be asserted without a browser: how a zoom scalar becomes
 * a band and a cross-fade, how a player count becomes a pin radius, how the
 * server's sector counts become drawable pins, and where the sun is at a given
 * UTC instant. Those are the four things that would otherwise only ever be
 * checked by looking at a screenshot.
 *
 * UNITS: `nav.lam0` / `nav.phi0` are RADIANS (they feed the projection hot path
 * in @shardkeep/shared, which is radians by contract); everything with a `Deg`
 * name or a `lon`/`lat` field is DEGREES, because that is what /globe returns.
 *
 * WHY THE NUMBERS BELOW ARE NOT IN packages/shared/src/constants.ts: they are
 * RENDER metrics, not game numbers — the same standing MAP-SCALE-PLAN:47 gives
 * map.tsx's TILE/ZOOM/PAD and layout.ts gives MAPCHROME. Nothing here is a cost,
 * a stat, a cap or a timer; change any of it and no rule and no server response
 * moves. The globe's genuinely tunable numbers (px, sector grid, zoom band
 * edges, caps, buckets) are GLOBE.* in constants.ts and are imported, never
 * redefined.
 */
import { GLOBE } from '@shardkeep/shared';
import {
  bandForZoom, DEG_TO_RAD, normalizeLon, normalizeRad,
  type GlobeCamera, type LonLat, type MapBand,
} from '@shardkeep/shared/globe';
import { MAPCHROME } from '../../layout';

/** The globe camera as the UI carries it: two angles and one zoom scalar.
 *  `zoom` is the SAME scalar `bandForZoom()` reads, so the band is derived and
 *  never stored — there is no second source of truth about which band is live. */
export interface GlobeNav {
  /** Centre longitude, RADIANS. */
  lam0: number;
  /** Centre latitude, RADIANS. */
  phi0: number;
  /** GLOBE.zoomMin … GLOBE.localZoom. */
  zoom: number;
}

export const GLOBE_VIEW = {
  /** Earth diameter at zoom 0 as a fraction of the board's SHORT side, so the
   *  whole planet is on screen in portrait AND landscape without a special case. */
  discFrac: 0.86,
  /** Screen scale per zoom band: R = R0 · zoomBase^zoom. 4 is chosen so that at
   *  GLOBE.regionZoom one 15° sector spans ~44% of the short side (a sector fills
   *  the screen when you descend into it) and at GLOBE.localZoom a single valley
   *  cell is larger than the viewport, which is exactly when the local map takes
   *  over. */
  zoomBase: 4,
  /** Cross-fade width in zoom units. A band change is a FADE, not a screen
   *  change: nothing unmounts, so there is never a loading state to freeze on. */
  fade: 0.4,
  /**
   * POINTER OWNERSHIP, WITH HYSTERESIS. Earth opacity at which the globe layer
   * TAKES pointer events, and the (lower) one at which it gives them back.
   *
   * It was one boolean at `earth > 0.5` — a hard edge at zoom 3.8 — and the layer's
   * `pointerEvents` is written from the rAF, so the instant a pinch crossed that
   * zoom the globe went `pointer-events: none` mid-stroke, hit-testing fell
   * through to the local map, and the gesture DIED half-way through. Two
   * thresholds mean the edge you cross going in is not the edge you cross coming
   * out, so a pinch that wobbles around the band edge cannot flip ownership back
   * and forth. (The latch in PixelGlobe is the other half: hysteresis narrows the
   * window, a latch closes it for the duration of a live gesture.)
   *
   * enter 0.62 / exit 0.34 ⇒ with `fade` 0.4 the flip zooms are 3.752 and 3.864:
   * ~0.11 zoom units of dead band, which is far more than one pinch sample and far
   * less than the fade itself. Same standing as `fade` above — a render metric, no
   * rule and no server response moves with it.
   */
  interactiveEnter: 0.62,
  interactiveExit: 0.34,
  /**
   * How often the day/night terminator advances, ms.
   *
   * `sunMs` used to be read as `Date.now()` inside the paint, and the paint only
   * runs when the camera moved — so a stationary globe's shadow was FROZEN, i.e.
   * the "live earth" was live only while you were dragging it. A low-frequency
   * tick makes it genuinely live without a 60 Hz main-thread wake: the real sun
   * moves 15°/h, so one minute is 0.25° — a fifth of one 2° coarse mask cell, and
   * sub-pixel on a 320px raster.
   */
  sunTickMs: 60_000,
  /** Pin radii in CSS px. Screen space, never scaled by zoom — a pin is a label
   *  on the world, not a thing sitting on it. */
  pinMin: 4,
  pinMax: 13,
  /** Radius gained per doubling of population (r = pinMin + log2(1+n)·pinStep).
   *  0.6 puts the pinMax clamp at ~32,000 players in one sector, so the scale
   *  still has headroom on a populated planet. It was 1.55, which saturated at 55
   *  players — on the devnet alpha the entire world drew as one fat blob. */
  pinStep: 0.6,
  /** Idle auto-spin in degrees per second, until the first interaction and never
   *  again (and never at all under prefers-reduced-motion). Motion is charm on
   *  arrival and nausea on every subsequent visit. */
  idleSpinDegSec: 3,
  /** Spin velocity retained per 16 ms after release. */
  inertiaDecay: 0.9,
  /** Below this velocity (rad/frame) the inertial spin is over. */
  inertiaStop: 0.0004,
  /** Camera latitude clamp, degrees: past this the pole fills the view and
   *  dragging stops making sense. */
  phiMaxDeg: 80,
  /**
   * WHERE A VALLEY OPENS INTO ITS PARCELS (P6, owner 2026-08-09: "1 deed = 1
   * parcel — does it read on the world UI?").
   *
   * The zoom at which the REGION band's valley pins have handed over to ONE PIN
   * PER OCCUPIED PARCEL in the valley under the camera. It sits INSIDE
   * `bandForZoom`'s region span on purpose: the shared derivation stays the one
   * source of truth about GLOBE / REGION / LOCAL, and `viewBand()` refines its
   * region answer rather than inventing a fourth band edge nothing else knows
   * about.
   *
   * 2.0 (D-096, was 2.6) is chosen so that (a) the parcel cross-fade [1.6, 2.0] is
   * clear of the REGION fade [0.6, 1] below it, (b) the parcel band [2.0, 3.6) is
   * 1.6 zoom units wide and ends before `settleZoom`'s forbidden fade band, so the
   * parcels are a real place to sit and read your neighbourhood — not a state the
   * settle can evict you from — and (c) names and avatars arrive AS SOON AS TILES
   * ARE LEGIBLE: at z2 a tile is 22.5 px on a 375 board and 44 px (`tileLabelled`)
   * on any board 733 px or wider, so a desktop reads names the moment the band
   * opens and a phone one pinch later. At 2.6 the owner saw "only Samuel is named"
   * — a zoom effect, not a privacy rule (there is no public-profile flag).
   */
  parcelZoom: 2.0,
  /** How far below the forbidden settle band [localZoom − fade, localZoom) the
   *  MY PARCEL flight is allowed to land. A landing inside that band would be
   *  evicted by `settleZoom` the instant it arrived. */
  parcelRestGap: 0.1,
  /** Parcel pin radius in CSS px at keep level 1 … and its ceiling. Smaller than
   *  a valley pin because ~491 of them share one patch of Earth. */
  parcelPinMin: 3,
  parcelPinMax: 7,
  /** Radius gained per keep level, so a maxed fortress reads bigger than a fresh
   *  keep without ever claiming a number the payload does not carry. */
  parcelPinStep: 0.45,
  /**
   * WHERE THE FINE (0.5°) MASK IS WORTH LOADING AND DRAWING — the EARTH TILES
   * answer, and it is a PERFORMANCE FLOOR rather than a taste. (P2, 2026-08-10)
   *
   * With the flag off this is `regionZoom − fade` = 0.6, which is what shipped —
   * and docs/EARTH-TILES-PLAN.md §4.3 measured that zoom to be inside the one
   * cliff the renderer has: below z1 a 0.5° cell is 0.55–1.11 raster px, 49,515
   * sub-pixel cells fight over ~12,700 disc pixels, and the frame measures
   * 2.5–3.3 ms on an M3 — 7–17 ms on a phone. A grid or a border down there is
   * moiré, and the colour is noise.
   *
   * 1.2 is where a fine cell becomes big enough to be a tile. MEASURED on a
   * 375×812 board (one 0.5° cell's height in raster px is 0.5546 · 4^zoom): z0.6
   * 1.27 px · z1.2 2.93 px · z1.218 3.00 px, which is `GRID_MIN_PX`. So the mask
   * lands a hair BEFORE the grid it feeds can be drawn — the same discipline as
   * fetching the mask before the fade needs it — and the band below keeps the
   * coarse mask with country FILLS plus coastlines and no grid. It is an EXIT
   * CRITERION for P2 (register R16), not a tuning knob; `globeView.test.ts` pins
   * both numbers together.
   */
  fineMaskZoom: 1.2,
  /**
   * THE LABEL BUDGET — the whole ladder, as three numbers. (P3, 2026-08-10)
   *
   * 86,122 tiles means label spam is the DEFAULT failure, and the shipped code was
   * already in it: `drawPins` plated every pin's label with no collision test and
   * no zoom gate while `GLOBE.valleysPerSectorCap` is 240, so a populated sector
   * could draw 240 plates on a 375 px board. docs/WORLDMAP-GLOBE-PLAN.md's own
   * "valley names at z > 2" was never implemented.
   *
   * `labelMax` is a HARD CAP on canvas label plates, counted across every layer in
   * one frame, so the worst case is a number rather than a hope. The ladder that
   * feeds it (EARTH-TILES-PLAN §4.2, D-096):
   *   z < 1     up to `labelMax` COUNTRY names, from the raster's own visible-area
   *             accumulator (the pass already walks the cells, so the centroid is
   *             free) — the only labels that exist down here;
   *   z 1 … 1.5 NO canvas labels at all. The country under the CROSSHAIR goes in
   *             the chrome, where it is unlimited in length and collision-free;
   *   z ≥ 1.5   cluster counts ("n BASES"), because by then a sector is a screenful
   *             and the counts are the answer to "where is anyone" (`valleyLabelZoom`);
   *   tile ≥ 44 px  parcel NAMES — every one on screen when the neighbourhood is
   *             sparse (`labelMaxSparse`, `labelBudget`), the hard cap when it is
   *             dense (`tileLabelled` solves to z 2.49 on a 375 board).
   */
  labelMax: 6,
  /**
   * THE SPARSE BUDGET (D-096): with at most this many parcel markers on screen,
   * every one of them may carry its name. 6 plates were the right ceiling for 491
   * parcels on a valley lattice; on a cell-honest planet with 41 bases a screen
   * usually holds a handful, and "only Samuel is named" was the cap biting on a
   * neighbourhood of four. Above this count the hard cap returns, so the worst case
   * is still a number. `labelBudget` is the one place the choice is made.
   */
  labelMaxSparse: 24,
  /** Where cluster counts are worth drawing (was 2, above the new `parcelZoom`;
   *  1.5 is where a sector is a screenful — see `tilePx`: 11.3 px tiles). Below it
   *  the crosshair says where you are. */
  valleyLabelZoom: 1.5,
  /** Tween length for a descend / recentre, ms. */
  tweenMs: 420,
  /** Tween length for the SETTLE (see `settleZoom`), ms. Deliberately much shorter
   *  than `tweenMs`: a settle is a correction to a resting state nobody asked for,
   *  not a journey, and it has to be over before the player wonders what happened. */
  settleMs: 160,
} as const;

// ---------------------------------------------------------------------------
// Feature flag — the whole "do not regress" guarantee
// ---------------------------------------------------------------------------

/**
 * `VITE_FEATURE_GLOBE`. Off unless explicitly enabled, and read through a pure
 * function so the flag's semantics are testable without a bundler: only '1' and
 * 'true' enable it, so a stray `VITE_FEATURE_GLOBE=0` or an empty string in a
 * deployed .env can never ship the globe by accident.
 */
export function globeFeature(raw: unknown): boolean {
  return raw === '1' || raw === 'true' || raw === true;
}

/**
 * `VITE_FEATURE_EARTH_TILES` — REAL EARTH LAND TILES (docs/EARTH-TILES-PLAN.md),
 * NESTED INSIDE `VITE_FEATURE_GLOBE`.
 *
 * Nested, not parallel: nothing this flag turns on is reachable unless the globe
 * layer is mounted, and the globe layer is mounted only under its own flag
 * (map.tsx). So "earth tiles off" is today's globe byte-for-byte and "globe off"
 * is today's board byte-for-byte, and the two guarantees compose instead of
 * needing a matrix. Same conservative parse as `globeFeature`, for the same
 * reason: a deployed `.env` carrying `=0` must never ship it by accident.
 */
export function earthTilesFeature(raw: unknown): boolean {
  return globeFeature(raw);
}

/**
 * The flag as the render path reads it.
 *
 * Read ONCE at module load rather than threaded through props, because the two
 * consumers are a `<canvas>` painter and a pure band function — neither of which
 * has a React owner that should be able to change the answer mid-session. The
 * pure functions all take it as a defaulted parameter so a test can assert BOTH
 * states without a bundler (which is the whole point of `globeFeature` living
 * here rather than in `import.meta.env` at the call site).
 */
export const EARTH_TILES: boolean = earthTilesFeature(import.meta.env['VITE_FEATURE_EARTH_TILES']);

/**
 * Rail rows the WORLD board asks the chrome solver for. Flag OFF must solve the
 * IDENTICAL chrome the board shipped before the globe existed — that is what
 * "byte-for-byte today's experience" means in layout terms, and it is asserted
 * in globeView.test.ts rather than eyeballed.
 *
 * THE GLOBE ADDS NO ROW (D-097, owner 2026-09-02). It used to add a fourth for
 * its own GLOBE / MY PARCEL / WARZONE toggles; on a 390 px phone that column
 * ate the map. The globe's chrome now asks the solver for NO rail at all
 * (GlobeLayer: MY PARCEL rides the zoom rail's home slot, WARZONE is a top-bar
 * badge), so the answer is the pre-globe three whether the flag is on or off.
 */
export function railRowsForWorld(_globeEnabled: boolean): number {
  return 3;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** Sphere radius in px for a zoom, on a board whose short side is `shortSide`. */
export function radiusPx(zoom: number, shortSide: number): number {
  return (shortSide * GLOBE_VIEW.discFrac) / 2 * GLOBE_VIEW.zoomBase ** zoom;
}

/** Normalise longitude, clamp latitude and zoom. The clamp is a function, not a
 *  convention, because three call sites move the camera (drag, tween, pinch). */
export function clampNav(nav: GlobeNav): GlobeNav {
  const phiMax = GLOBE_VIEW.phiMaxDeg * DEG_TO_RAD;
  return {
    lam0: normalizeRad(nav.lam0),
    phi0: Math.max(-phiMax, Math.min(phiMax, nav.phi0)),
    zoom: Math.max(GLOBE.zoomMin, Math.min(GLOBE.localZoom, nav.zoom)),
  };
}

/**
 * Deepest zoom reachable by an ordinary globe gesture. WORLD no longer keeps the
 * retired local valley mounted underneath this layer, so letting pinch/wheel/+ or
 * double-tap reach `localZoom` would fade the only world surface to zero and leave
 * a black board. The explicit ENTER action may still tween through this ceiling to
 * `localZoom`; only browsing input is capped here.
 */
export function globeBrowseZoomMax(): number {
  return GLOBE.localZoom - GLOBE_VIEW.fade - GLOBE_VIEW.parcelRestGap;
}

export function clampGlobeBrowseZoom(zoom: number): number {
  return Math.max(GLOBE.zoomMin, Math.min(globeBrowseZoomMax(), zoom));
}

/**
 * Quantise the camera to WHOLE RASTER PIXELS.
 *
 * One raster pixel subtends 1/R radians at the disc centre, so rounding the two
 * angles to that step makes the land splat land on the same pixel grid every
 * frame. Without it a slow spin re-samples the mask a fraction of a pixel at a
 * time and the coastlines SHIMMER — the single most obvious way to make pixel
 * art look broken.
 */
export function quantiseNav(nav: GlobeNav, R: number): GlobeNav {
  if (!(R > 0)) return nav;
  return {
    lam0: Math.round(nav.lam0 * R) / R,
    phi0: Math.round(nav.phi0 * R) / R,
    zoom: nav.zoom,
  };
}

/**
 * The projection camera for a viewport. `scale` converts CSS px to the target
 * raster's px (1 for the screen-space pin pass, GLOBE.px/vh for the earth
 * buffer), which is what keeps the two passes exactly aligned — the pins are
 * projected with the same camera as the continents, only scaled.
 */
export function navCamera(nav: GlobeNav, vw: number, vh: number, scale = 1): GlobeCamera {
  return {
    lam0: nav.lam0,
    phi0: nav.phi0,
    R: radiusPx(nav.zoom, Math.min(vw, vh)) * scale,
    cx: (vw / 2) * scale,
    cy: (vh / 2) * scale,
  };
}

// ---------------------------------------------------------------------------
// The LOD ladder as a cross-fade
// ---------------------------------------------------------------------------

/**
 * The LOD ladder as the UI reads it: `bandForZoom`'s three bands, with the region
 * band's deep half named. A REFINEMENT of the shared derivation, never a second
 * one — `viewBand` calls `bandForZoom` and only ever renames its `'region'`
 * answer, so there is still exactly one place that decides GLOBE / REGION / LOCAL.
 */
export type ViewBand = MapBand | 'parcel';

/** Which band the chrome should speak in: EARTH · REGION · VALLEY · the local map. */
export function viewBand(zoom: number): ViewBand {
  const band = bandForZoom(zoom);
  return band === 'region' && zoom >= GLOBE_VIEW.parcelZoom ? 'parcel' : band;
}

export interface BandMix {
  /** `bandForZoom` — the shared derivation, never a second one. */
  band: MapBand;
  /** `viewBand` — `band`, with the region band's parcel half named. */
  view: ViewBand;
  /** Opacity of the whole earth layer. 0 ⇒ the LOCAL map (today's WorldMap,
   *  untouched underneath) owns the board. */
  earth: number;
  /** Opacity of the sector pins (GLOBE band), the valley pins (REGION band) and
   *  the parcel pins (the region band's deep half). Consecutive layers are drawn
   *  during their overlap, which is what makes a descend read as one continuous
   *  zoom instead of three screens. */
  sectorPins: number;
  valleyPins: number;
  parcelPins: number;
  /** The earth layer takes pointer events only while it is substantially
   *  visible; below that the local map underneath must be tappable again. With
   *  HYSTERESIS (`interactiveEnter` / `interactiveExit`), so this is a function of
   *  the PREVIOUS answer as well as the zoom — see `bandMix`. */
  interactive: boolean;
  /** True once the REGION band's fine mask is worth having on screen. */
  wantFineMask: boolean;
  /** True once the parcels of the valley under the camera are worth FETCHING —
   *  the whole-valley roster read is ~500 markers, so it waits until the pins are
   *  about to be visible (the same discipline `wantFineMask` follows). */
  wantParcels: boolean;
}

const ramp = (v: number, from: number, to: number): number =>
  Math.max(0, Math.min(1, (v - from) / (to - from)));

/**
 * @param wasInteractive whether the globe layer currently OWNS pointer events.
 *   Passing it is what makes the threshold hysteretic instead of a hard edge that
 *   a pinch can straddle (see GLOBE_VIEW.interactiveEnter). Defaults to false, so
 *   a caller that only wants `band` / `earth` / `wantFineMask` — GlobeLayer's
 *   React copy of the camera, the tests — reads the same conservative answer the
 *   single threshold used to give at both ends of the ladder.
 * @param earthTiles `VITE_FEATURE_EARTH_TILES`. It moves ONE thing:
 *   `wantFineMask`, from `regionZoom − fade` (0.6) to `fineMaskZoom` (1.2). It is
 *   a parameter rather than a module read so the test can pin both answers, and it
 *   defaults to the live flag so the callers that only pass a zoom — GlobeLayer,
 *   PixelGlobe's rAF — need no edit and cannot disagree with the renderer.
 */
export function bandMix(zoom: number, wasInteractive = false, earthTiles = EARTH_TILES): BandMix {
  const { fade, interactiveEnter, interactiveExit, parcelZoom } = GLOBE_VIEW;
  const toLocal = ramp(zoom, GLOBE.localZoom - fade, GLOBE.localZoom);
  const toRegion = ramp(zoom, GLOBE.regionZoom - fade, GLOBE.regionZoom);
  // The parcel hand-over, over the same fade width as every other one. It used to
  // be `parcelSpread(zoom)`, exported so the screen-space lattice could share the
  // ramp with its own pitch; the lattice is gone (P4b) and an opacity ramp does not
  // need a name of its own.
  const toParcel = ramp(zoom, parcelZoom - fade, parcelZoom);
  const earth = 1 - toLocal;
  return {
    band: bandForZoom(zoom),
    view: viewBand(zoom),
    earth,
    // Sector pins fade out as valley pins fade in, and valley pins fade out as
    // the PARCEL tiles fade in — three layers, two hand-overs, one continuous
    // zoom. Every one of them also fades with the earth itself, so nothing is
    // left floating over the local map.
    sectorPins: (1 - toRegion) * earth,
    valleyPins: toRegion * (1 - toParcel) * earth,
    parcelPins: toParcel * earth,
    interactive: wasInteractive ? earth > interactiveExit : earth >= interactiveEnter,
    // The ONE band edge Earth tiles move, and the reason is in `fineMaskZoom`:
    // the tile renderer must not be handed sub-pixel cells.
    wantFineMask: zoom >= (earthTiles ? GLOBE_VIEW.fineMaskZoom : GLOBE.regionZoom - fade),
    wantParcels: zoom >= parcelZoom - fade,
  };
}

/** The generated Earth-data chunks the layer may `await import()`, per camera. */
export interface EarthChunks {
  /** `@shardkeep/shared/earthMaskFine` — ~5.3 KB gzip. SHIPPED TODAY at the region
   *  band, so it is NOT gated by the tiles flag: gating it would change flag-off
   *  behaviour in the other direction. */
  fineMask: boolean;
  /** `earthCountries` / `earthCountriesFine` — 1.39 / 6.71 KB gzip. */
  countryIndex: boolean;
  /** `@shardkeep/shared/parcelGrid`, which pulls the fine mask AND the fine
   *  country index in with it. */
  parcelGrid: boolean;
}

/**
 * WHICH EARTH CHUNKS MAY BE FETCHED — one predicate, so "flag off downloads
 * NOTHING new" is a test instead of a promise. (adversarial pass D5, 2026-08-10)
 *
 * THE BUG THIS EXISTS TO KILL. `useParcelGrid(mix.wantParcels)` and
 * `useCountryIndex(mask, EARTH_TILES || mix.wantParcels)` were keyed off the CAMERA
 * alone, and the GLOBE open animation seeds the camera at `GLOBE.localZoom` before
 * tweening out (GlobeLayer's open effect) — which is above `parcelZoom − fade`, so
 * `wantParcels` committed true for a frame and **13.1 KB gzip of `parcelGrid` +
 * `earthCountriesFine` was fetched on every globe open with
 * `VITE_FEATURE_EARTH_TILES` UNSET**. A feature flag that still downloads its
 * feature is not a rollback, and "flag off is today's globe byte for byte" was
 * false on the network tab, which is the one place it is easiest to check.
 *
 * The fine mask is deliberately NOT gated: it ships today at `regionZoom − fade`,
 * so withholding it under flag-off would be its own change to shipped behaviour.
 * The flag moves WHEN it is wanted (`wantFineMask`), never WHETHER.
 *
 * @param earthTiles defaulted to the live flag so callers cannot disagree with the
 *   renderer, and a parameter so the test can pin both answers without a bundler.
 */
export function earthChunks(mix: BandMix, earthTiles = EARTH_TILES): EarthChunks {
  return {
    fineMask: mix.wantFineMask,
    // The raster asks for the index itself whenever tiles are on (globeRaster's
    // `countryIndexFor`), so the chrome only ever SUBSCRIBES to a load the flag
    // already authorised. With the flag off nothing paints countries and nothing
    // names a tile, so nothing needs the table.
    countryIndex: earthTiles,
    parcelGrid: earthTiles && mix.wantParcels,
  };
}

// ---------------------------------------------------------------------------
// Tiles — the geometry of one 0.5° Earth cell on this board
// ---------------------------------------------------------------------------

/**
 * ONE TILE'S ON-SCREEN HEIGHT IN CSS px — the number the whole tile band is
 * measured in. (P3, 2026-08-10)
 *
 * A 0.5° cell subtends π/rows radians of latitude wherever it is, so its HEIGHT is
 * `R · π/rows` at every latitude and is the honest single measure of "how big is a
 * tile right now". Its WIDTH shrinks with cos φ (2.02× narrower at 60°, 5.90× at
 * 80° — measured, EARTH-TILES-PLAN §4.1), so height is also the GENEROUS one: a
 * tile is never a bigger target than this says.
 *
 * On a 375×812 board it is 1.407 · 4^zoom: z1 5.6 · z1.5 11.3 · z2 22.5 · z2.49
 * 44.0 · z2.6 51.7 · z3 90.1 px. Those are the numbers the label ladder and
 * `tileHomeZoom` are solved from rather than tuned against.
 *
 * THIS IS WHAT REPLACED `parcelStepPx`, and the difference is the whole of P4b: the
 * old pitch was a SCREEN-SPACE INVENTION (short side ÷ 31, then magnified 8× per
 * zoom unit) that had to grow faster than the planet under it to become tappable.
 * A tile's size is now a fact about the projection.
 */
export function tilePx(zoom: number, shortSide: number, rows: number = GLOBE.fineRows): number {
  return (radiusPx(zoom, shortSide) * Math.PI) / rows;
}

/**
 * IS A TILE BIG ENOUGH TO CARRY ITS OWN NAME — and, by the same number, to be a
 * tap target every other map control would recognise.
 *
 * One predicate, two jobs, deliberately: the label ladder's "the selected tile's
 * own label only at z ≥ 2.5" and the 44 px minimum are the SAME threshold on a
 * 375 px board (it solves to z 2.494), so writing them as two constants would let
 * them drift apart. Note that tile TAPS are not gated on it — a tap resolves to the
 * cell under the finger, which is a correct answer at any size, and that is what
 * retired the overlapping-hit-circle problem (`parcelsTappable` / `parcelHitRadius`).
 * What is gated is the promise that the tile you meant is the tile you got.
 */
export function tileLabelled(px: number): boolean {
  return px >= MAPCHROME.tap;
}

/**
 * HOW MANY LABEL PLATES THIS FRAME MAY DRAW (D-096).
 *
 * The hard cap (`labelMax`) unless the PARCEL layer is live with a sparse
 * neighbourhood on screen, in which case every marker may be named
 * (`labelMaxSparse`). Counted from parcel pins that actually projected onto the
 * canvas, so a dense sector at region zoom, or the country names below z1, never
 * unlocks the sparse budget — it is a budget for reading names, not for spam.
 */
export function labelBudget(visibleParcelPins: number, parcelBandLive: boolean): number {
  const { labelMax, labelMaxSparse } = GLOBE_VIEW;
  return parcelBandLive && visibleParcelPins <= labelMaxSparse ? labelMaxSparse : labelMax;
}

/**
 * THE ZOOM "MY PARCEL" FLIES TO: the shallowest zoom at which the player's own tile
 * is a full 44 px target, clamped into the parcel band.
 *
 * Solved rather than tuned, exactly as `parcelTapZoom` was before it — but from the
 * projection instead of from an invented pitch: `tilePx` is `tilePx(0) · zoomBase^z`,
 * so `z = log_zoomBase(tap / tilePx(0))`. Clamped never shallower than `parcelZoom`
 * (below it the band's own pins have not faded in) and never into the forbidden
 * settle band, which would evict the flight the moment it landed.
 *
 * The layout tests assert it lands between `parcelZoom` (2.0, on boards ≥ 733 px
 * where the clamp binds) and 2.62 (a 311 px short side) — the honest consequence of
 * a tile being a county: 44 px of screen is 39 × 56 km of Earth.
 */
export function tileHomeZoom(shortSide: number): number {
  const at0 = tilePx(0, shortSide);
  const need = MAPCHROME.tap / Math.max(1e-6, at0);
  // BIASED ONTO THE SATISFYING SIDE BY ONE PART IN A BILLION. The solve is exact in
  // the reals, but `exp(log(x))` lands a hair BELOW x, so on a 915×311 board — where
  // the answer is 2.6183 and not clamped — the tile came out 43.99999999999999 px and
  // `tileLabelled` said false about the very zoom this function exists to reach. A
  // flight that lands one ulp short of its own promise is worse than a nudge.
  const dz = need <= 1 ? 0 : Math.log(need) / Math.log(GLOBE_VIEW.zoomBase) + 1e-9;
  const top = GLOBE.localZoom - GLOBE_VIEW.fade - GLOBE_VIEW.parcelRestGap;
  return Math.max(GLOBE_VIEW.parcelZoom, Math.min(top, dz));
}

// ---------------------------------------------------------------------------
// Parcels — one pin per occupied plot in the valley under the camera (P6)
// ---------------------------------------------------------------------------

/**
 * ONE OCCUPIED PARCEL, as the parcel band is allowed to know it.
 *
 * Public profile identity is optional for rolling deploy compatibility. Wallets
 * never travel with this shape; the API may expose only the player's chosen
 * display name and opaque avatar URL.
 */
export interface ParcelRow {
  /** Plot coordinates inside the valley: `plots.(x, y)`, never reinterpreted. */
  x: number;
  y: number;
  /** Frozen `plots.earth_cell` address carried by the deed. Rendering consumes
   *  this stored identity and only validates it against the generated grid. */
  earthCell: number;
  keepLevel: number;
  name?: string | undefined;
  avatarUrl?: string | null | undefined;
  /** YOUR parcel — the one your Land Deed owns. Marked, never merely coloured. */
  mine: boolean;
}

export interface ParcelPin extends ParcelRow {
  r: number;
}

/** Radius from keep level, clamped: legible at L1, neighbourly at the cap. */
export function parcelRadius(keepLevel: number): number {
  const { parcelPinMin: lo, parcelPinMax: hi, parcelPinStep: step } = GLOBE_VIEW;
  return Math.min(hi, Math.max(lo, lo + Math.max(0, keepLevel - 1) * step));
}

/**
 * Occupied plots → drawable parcel pins.
 *
 * Draw order, and it is deliberate for the same reason `sectorPins`' is: small
 * keeps first so a maxed neighbour cannot bury a fresh one, and YOUR parcel last
 * so its marker is never occluded by the 490 that are not yours.
 */
export function parcelPins(rows: readonly ParcelRow[]): ParcelPin[] {
  const out = rows.map((p) => ({ ...p, r: parcelRadius(p.keepLevel) }));
  out.sort((a, b) => (a.mine ? 1 : 0) - (b.mine ? 1 : 0)
    || a.r - b.r
    || a.y - b.y
    || a.x - b.x);
  return out;
}

/**
 * THE BOUNDARIES REACT HAS TO BE TOLD ABOUT MID-GESTURE.
 *
 * The live camera lives in a ref and commits only on a gesture boundary, which is
 * what keeps a spin free of reconciliation — but three things React owns change
 * with the band: the chrome's words, which pins exist, and whether the parcel
 * roster has been FETCHED. A pinch that crosses a band edge and keeps going would
 * otherwise draw the deeper band with the shallower band's data until the fingers
 * stopped (`commitSoon` is 140 ms after the last sample).
 *
 * So the rAF commits whenever this key changes. It deliberately includes
 * `wantParcels` as well as `view`: the fetch trigger sits one fade width ABOVE the
 * parcel band, so the ~500-marker read (and the parcel-grid module that turns it
 * into Earth cells) is in flight while the pins are still fading in.
 */
export function bandKey(mix: BandMix): string {
  return `${mix.view}|${mix.wantParcels ? 1 : 0}`;
}

/**
 * The zoom at which pointer ownership flips, for the direction being travelled.
 *
 * Exported for the test rather than inlined there: the whole point of hysteresis
 * is that these two numbers are DIFFERENT and ordered, and re-deriving them in the
 * test from the same expression would assert nothing.
 */
export function interactiveFlipZoom(entering: boolean): number {
  const { fade, interactiveEnter, interactiveExit } = GLOBE_VIEW;
  // earth = 1 − (zoom − (localZoom − fade))/fade  ⇒  zoom = localZoom − earth·fade
  return GLOBE.localZoom - (entering ? interactiveEnter : interactiveExit) * fade;
}

/**
 * WHERE THE CAMERA IS ALLOWED TO COME TO REST. (fixed 2026-08-09)
 *
 * The cross-fade band `[localZoom − fade, localZoom)` is a place to travel
 * THROUGH, never a place to stop. A camera parked inside it means `earth` strictly
 * between 0 and 1, and every consequence of that is a bug, not a look: a frozen
 * part-opacity planet with its opaque backdrop dimming the local map, ghost pins
 * over valley terrain, two ghosted chrome sets fighting for the same slots — and
 * because the rAF sleeps when nothing is owed, NOTHING EVER RESOLVES IT. Release a
 * pinch or a wheel at zoom 3.8 and that was the screen until reload.
 *
 * So a gesture end does not merely commit the camera, it SETTLES it: this function
 * says which band edge the resting zoom belongs to, and PixelGlobe tweens there
 * (GLOBE_VIEW.settleMs) keeping the loop awake until it arrives. Outside the band
 * it is the identity, so ordinary zooming is untouched — including the whole
 * REGION band, which is a real place to sit and read a sector.
 *
 * The nearer edge wins, so the settle always agrees with the gesture that was
 * already in progress. A tie — or a float hair either side of one, which is all
 * the midpoint ever is once `4 − 0.4` is a double — settles to LOCAL: at the
 * midpoint `earth` is 0.5, below `interactiveEnter`, so the local map is ALREADY
 * the surface taking the taps, and handing it the board agrees with who owns the
 * pointer rather than contradicting it.
 */
export function settleZoom(zoom: number): number {
  const hi = GLOBE.localZoom;
  const lo = hi - GLOBE_VIEW.fade;
  // `!(zoom > lo)` rather than `zoom <= lo` so a NaN camera is returned untouched
  // instead of being snapped to an edge by accident.
  if (!(zoom > lo) || zoom >= hi) return zoom;
  return (hi - zoom) - (zoom - lo) > 1e-9 ? lo : hi;
}

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

/**
 * Radius from population, logarithmic and CLAMPED.
 *
 * Logarithmic because population is: one sector holding 40,000 players next to
 * one holding 12 must show both, and a linear radius would draw the second as a
 * sub-pixel dot. Clamped at both ends because a pin is a tap target (never
 * smaller than legible) and a label (never so large it eats its neighbours).
 */
export function pinRadius(players: number): number {
  const { pinMin, pinMax, pinStep } = GLOBE_VIEW;
  const r = pinMin + Math.log2(1 + Math.max(0, players)) * pinStep;
  return Math.min(pinMax, Math.max(pinMin, r));
}

/** Tap radius for a pin: a 4 px pin still has to be a 44 px target (MAPCHROME.tap
 *  — the same minimum every other map control is held to). */
export function pinHitRadius(r: number): number {
  return Math.max(MAPCHROME.tap / 2, r + 4);
}

/** What /globe returns per sector (apps/api/src/game/globe.ts GlobeSectorPin). */
export interface SectorCounts {
  id: number;
  valleys: number;
  players: number;
  active: number;
  /**
   * WHERE THE PIN DRAWS: the counted base cell nearest the centroid of the bases
   * this sector counts (D-096), in degrees. REQUIRED (D-097): a sector without
   * one is a server bug, not a placement rule — the one-release fallback to the
   * sector's geometric centre (186 of 288 are sea) is gone, and nothing on the
   * client invents a position the server did not serve.
   */
  lon: number;
  lat: number;
  warzone: boolean;
}

export interface SectorPin {
  id: number;
  lon: number;
  lat: number;
  valleys: number;
  players: number;
  active: number;
  r: number;
  /** In-window targets live here — the GOLD RING. A highlight, never a filter:
   *  every populated sector is on the globe whether you can fight there or not
   *  (owner decision 1, 2026-08-09 — reach is trophies, not distance). */
  ring: boolean;
  /** Your own sector — pulses. */
  mine: boolean;
}

/**
 * Server sector counts → drawable pins.
 *
 * A PIN STANDS ON THE BASES IT COUNTS (D-096): its position is the base cell the
 * server chose from those bases, never the sector's geometric centre — 186 of
 * the 288 centres are sea, and a yellow square in the Atlantic that zooms into
 * nothing is exactly the globe the owner rejected. There is no fallback any
 * more (D-097): the served position is consumed as-is.
 *
 * Ordering is the draw order, and it is deliberate: small pins first so a busy
 * neighbour cannot bury a quiet sector, and the viewer's own sector last so the
 * pulse is never occluded.
 */
export function sectorPins(
  sectors: readonly SectorCounts[],
  reachSectorIds: readonly number[] = [],
  mySectorId: number | null = null,
): SectorPin[] {
  const reach = new Set(reachSectorIds);
  const out = sectors.map((s) => ({
    id: s.id,
    lon: s.lon,
    lat: s.lat,
    valleys: s.valleys,
    players: s.players,
    active: s.active,
    r: pinRadius(s.players),
    ring: reach.has(s.id),
    mine: s.id === mySectorId,
  }));
  out.sort((a, b) => (a.mine ? 1 : 0) - (b.mine ? 1 : 0)
    || a.r - b.r
    || a.id - b.id);
  return out;
}

// ---------------------------------------------------------------------------
// Day / night terminator
// ---------------------------------------------------------------------------

/**
 * The subsolar point for a UTC instant — where it is local noon, right now.
 *
 * Declination is the standard cosine approximation (±0.5° of the true value,
 * which is a third of one coarse mask cell — invisible at 320 px) and longitude
 * ignores the equation of time (±4 min ⇒ ±1°, likewise invisible). What matters
 * is that it is DETERMINISTIC in the timestamp: the terminator is real, it moves
 * at 15°/h, and a fixed instant always produces the same shadow — which is what
 * the test pins.
 */
export function sunLonLat(msUtc: number): LonLat {
  const d = new Date(msUtc);
  const dayMs = 86_400_000;
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  // 1-based day of year, as the declination approximation expects.
  const n = Math.floor((msUtc - yearStart) / dayMs) + 1;
  const lat = -23.44 * Math.cos((2 * Math.PI * (n + 10)) / 365.24);
  const hours = (msUtc - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 3_600_000;
  // 12:00 UTC ⇒ the sun is over the prime meridian; it tracks west 15°/h.
  return { lon: normalizeLon(-(hours - 12) * 15), lat };
}

/** The sun as a unit vector in CAMERA space: east / north / out-of-screen. */
export interface SunVector { se: number; sn: number; so: number }

/**
 * Rotate the sun into the camera's frame.
 *
 * This is the whole terminator: a screen pixel at offset (dx, dy-up) with depth
 * `pz` is in daylight iff `dx·se + dy·sn + pz·so ≥ 0`. One dot product per
 * pixel, no trig, and it works for the ocean as well as the land — which is why
 * the shadow crosses the whole disc instead of only the continents.
 */
export function sunCameraVector(nav: GlobeNav, sun: LonLat): SunVector {
  const lam = sun.lon * DEG_TO_RAD;
  const phi = sun.lat * DEG_TO_RAD;
  const cosPhi = Math.cos(phi);
  // Sun direction in earth-centred XYZ (x through lon 0, z through the pole).
  const sx = cosPhi * Math.cos(lam);
  const sy = cosPhi * Math.sin(lam);
  const sz = Math.sin(phi);
  const sinL = Math.sin(nav.lam0);
  const cosL = Math.cos(nav.lam0);
  const sinP = Math.sin(nav.phi0);
  const cosP = Math.cos(nav.phi0);
  return {
    se: -sinL * sx + cosL * sy,
    sn: -sinP * cosL * sx - sinP * sinL * sy + cosP * sz,
    so: cosP * cosL * sx + cosP * sinL * sy + sinP * sz,
  };
}

// ---------------------------------------------------------------------------
// Terrain colour by latitude
// ---------------------------------------------------------------------------

/**
 * Latitude → tint band index (0 ice … 5 tropical).
 *
 * The mask says land or sea and nothing else, so without this the continents are
 * a silhouette. The band edges are climate-plausible rather than surveyed: the
 * point is that Greenland reads as ice and the Congo as jungle at 320 px, on a
 * value the per-row trig table already carries.
 */
export function latTintIndex(latDeg: number): number {
  const a = Math.abs(latDeg);
  if (a >= 72) return 0; // ice cap
  if (a >= 58) return 1; // tundra
  if (a >= 44) return 2; // boreal
  if (a >= 30) return 3; // temperate
  if (a >= 16) return 4; // arid / savanna
  return 5; // tropical
}

/** How many tint bands `latTintIndex` can return. */
export const TINT_BANDS = 6;
