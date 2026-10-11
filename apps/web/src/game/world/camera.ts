/**
 * Camera behaviour across a VIEWPORT CHANGE — the canvas-free half of what both
 * scenes must do when the phone rotates (landscape became first-class
 * 2026-08-02). The raid's ENTRY framing lives in battlecamera.ts; this is only
 * the "the viewport just changed size" half, shared because the base camera and
 * the battle camera strand in exactly the same way.
 *
 * WHY a resize strands the view: Phaser stores camera scroll as
 * `centre − viewport/2` in SCREEN px and re-derives the look-at point from it on
 * every render (`midPoint = scrollX + width * 0.5`, Camera.js preRender).
 * Scale.RESIZE resizes the camera but touches neither scroll nor zoom — so the
 * world point under the screen centre slides by half the size change. A phone
 * going 412×915 → 915×412 jumps (915−412)/2 = 251 world px right and the same
 * distance up: ~4 tiles of a 30-tile base, mid-raid.
 */
import { BASE_CAMERA } from '@shardkeep/shared';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** The authored base-view zoom band (HANDOFF §5.2). Lives here rather than in
 *  pinch.ts — which consumes it as its default band — because pinch.ts imports
 *  Phaser, and everything in this module has to stay canvas-free to be testable. */
export const ZOOM_MIN = BASE_CAMERA.minZoom;
export const ZOOM_MAX = BASE_CAMERA.maxZoom;

export interface BaseCameraInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const NO_INSETS: BaseCameraInsets = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Zoom band for the BASE view at a given viewport and LIVE server claim. The
 * floor keeps the skirt filling the long axis and normally honours the authored
 * readability floor. On a narrow screen, the live claim fit may lower that
 * floor just enough to keep every outer wall reachable around the HUD.
 */
export function baseZoomBand(
  viewW: number,
  viewH: number,
  worldPx: number,
  claimTiles: number,
  tilePx: number,
  insets: BaseCameraInsets = NO_INSETS,
  extendedPlot = false,
): { min: number; max: number } {
  const safeW = Math.max(1, viewW - insets.left - insets.right);
  const safeH = Math.max(1, viewH - insets.top - insets.bottom);
  const holdsWorld = Math.max(viewW, viewH) / Math.max(1, worldPx);
  const claimWithPadPx = Math.max(1, claimTiles + BASE_CAMERA.fitPadTiles * 2) * tilePx;
  const fitsClaim = Math.min(safeW, safeH) / claimWithPadPx;
  return {
    // A 50-tile claim on a narrow viewport cannot honor the old absolute zoom
    // floor. Revisioned scenery extends its edge substrate instead of cropping
    // the player's outer buildings to satisfy a decorative world-size limit.
    min: extendedPlot ? Math.min(fitsClaim, ZOOM_MAX)
      : clamp(Math.max(holdsWorld, fitsClaim), BASE_CAMERA.absoluteMinZoom, ZOOM_MAX),
    max: ZOOM_MAX,
  };
}

/** Base-view framing inside the unobstructed React HUD rectangle. The zoom band
 * remains responsible for keeping the skirt under the full canvas; the fit and
 * centre use the smaller safe rectangle so outer walls do not sit underneath
 * the three-row portrait HUD, bottom navigation, or landscape rail. */
export function fitBaseCamera(
  viewW: number,
  viewH: number,
  worldPx: number,
  claim: { min: number; max: number },
  tilePx: number,
  insets: BaseCameraInsets = NO_INSETS,
  extendedPlot = false,
): { zoom: number; min: number; max: number; centerX: number; centerY: number } {
  const band = baseZoomBand(
    viewW, viewH, worldPx, claim.max - claim.min, tilePx, insets, extendedPlot,
  );
  const safeW = Math.max(1, viewW - insets.left - insets.right);
  const safeH = Math.max(1, viewH - insets.top - insets.bottom);
  const paddedClaimPx = Math.max(
    1, claim.max - claim.min + BASE_CAMERA.fitPadTiles * 2,
  ) * tilePx;
  const zoom = clamp(Math.min(safeW, safeH) / paddedClaimPx, band.min, band.max);
  const centre = ((claim.min + claim.max) / 2) * tilePx;
  return {
    zoom,
    min: band.min,
    max: band.max,
    // Camera centre is the viewport centre. Shifting the world look-at point by
    // half the opposing-inset difference puts `centre` at the SAFE centre.
    centerX: centre + (insets.right - insets.left) / (2 * zoom),
    centerY: centre + (insets.bottom - insets.top) / (2 * zoom),
  };
}

/** Fixed presentation bounds contain both the authored field and the inset-
 * adjusted fitted viewport. Derive them from the zoom floor, never a player's
 * current centre: deliberate pans stay bounded and cannot grow their own limits. */
export function baseRenderBounds(viewW: number, viewH: number, zoom: number, origin: number, size: number,
  insets: BaseCameraInsets = NO_INSETS): { x: number; y: number; width: number; height: number } {
  const centre = origin + size / 2;
  const centerX = centre + (insets.right - insets.left) / (2 * zoom);
  const centerY = centre + (insets.bottom - insets.top) / (2 * zoom);
  const x = Math.min(origin, centerX - viewW / zoom / 2);
  const y = Math.min(origin, centerY - viewH / zoom / 2);
  return { x, y, width: Math.max(origin + size, centerX + viewW / zoom / 2) - x,
    height: Math.max(origin + size, centerY + viewH / zoom / 2) - y };
}

/** The slice of Phaser's Camera a reframe touches. Declared structurally so the
 *  arithmetic can be exercised against a faithful fake instead of a real canvas. */
export interface ResizedCamera {
  readonly zoom: number;
  readonly midPoint: { x: number; y: number };
  setZoom(zoom: number): unknown;
  centerOn(x: number, y: number): unknown;
}

/**
 * Re-apply the look-at point after the viewport changed size, with the zoom
 * re-clamped into `band`.
 *
 * Call this from a Scale.RESIZE handler and nowhere else: `midPoint` is only
 * refreshed in preRender, so at that moment it still holds the PRE-resize centre
 * — precisely what the player was looking at. (Phaser's own CameraManager
 * subscribes to RESIZE at scene boot, so the camera has already been given its
 * new size when a scene handler runs; the stale midPoint is the last thing that
 * still remembers the old framing.)
 *
 * Zoom before centring: centerOn clamps the scroll against the camera bounds
 * using displayWidth (= viewport / zoom), so the clamp has to see the new zoom or
 * it pins the centre against the wrong edge.
 */
export function reframeAfterResize(cam: ResizedCamera, band: { min: number; max: number }): void {
  const { x, y } = cam.midPoint;
  cam.setZoom(clamp(cam.zoom, band.min, band.max));
  cam.centerOn(x, y);
}
