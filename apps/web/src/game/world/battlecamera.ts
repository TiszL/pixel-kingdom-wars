/**
 * Battle camera geometry — the PURE half of the raid screen's camera (owner
 * 2026-07-29: "the raid is unplayable on a phone").
 *
 * BattleScene used to hardcode `setZoom(0.5)` and register no camera input at
 * all, so a 390px phone saw 12 of the battlefield's 38 tile columns with no way
 * to reach the rest. These helpers compute the framing and the tile a pointer
 * is over; BattleScene owns the Phaser wiring (pan/pinch/pills) and calls in
 * here so the arithmetic is unit-testable without a canvas.
 *
 * PRESENTATION ONLY — see RAID_CAMERA's header in constants.ts. Nothing here
 * decides whether a deploy is legal (RaidUI's deployValid is the one gate), so
 * no camera change can move a golden replay.
 */
import { RAID_CAMERA, type BattlefieldVersion } from '@shardkeep/shared';

export interface FitInput {
  battlefieldVersion?: BattlefieldVersion;
  /** Frozen occupied defender bounds; independent of unlocked empty land. */
  defenderBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Defender's CENTERED claim bounds from the raid snapshot (tiles). */
  claimMin: number;
  claimMax: number;
  /** Deploy margin in tiles around the plot (RAID_RULES.deployMarginTiles). */
  marginTiles: number;
  /** Whole battlefield rect in world px (camera bounds) — the pull-back target. */
  fieldSizePx: number;
  /** Camera viewport in screen px. */
  viewW: number;
  viewH: number;
  /** World px per tile. */
  tilePx: number;
  /** MEASURED HUD chrome in screen px. Omit to fall back to the RAID_CAMERA
   *  defaults; RaidUI measures the real elements and passes them, so a layout
   *  change can never leave the fit reserving the wrong space again. */
  hudTopPx?: number;
  hudBottomPx?: number;
  /** MEASURED chrome on the SIDES (landscape stands the navbar up as a rail on
   *  the right, 2026-08-02). Default 0 — portrait's answer, so nothing about the
   *  portrait framing moves. */
  hudLeftPx?: number;
  hudRightPx?: number;
}

export interface FitResult {
  /** Zoom to enter the raid at: the claim + deploy ring fitted between the HUD rows. */
  zoom: number;
  /** Floor the player may pinch out to — enough to hold the WHOLE field. */
  zoomMin: number;
  zoomMax: number;
  /** centerOn() target, already offset for the top HUD / bottom tray. */
  centerX: number;
  centerY: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Entry framing: fit the defender's claim plus a deploy ring into the screen
 * space BETWEEN the battle HUD and the deploy tray, then bias the centre so the
 * base is not hidden under either.
 *
 * The claim bounds come from the snapshot (server-authoritative) rather than
 * GRID, for the same reason BattleScene.isDeployable reads them — a claim
 * recomputed client-side is exactly what desynced the deploy zone before.
 */
export function fitBattleCamera(i: FitInput): FitResult {
  const defender = (i.battlefieldVersion === 2 || i.battlefieldVersion === 3) ? i.defenderBounds : undefined;
  const claimPx = Math.max(1, defender ? Math.max(defender.maxX - defender.minX, defender.maxY - defender.minY)
    : i.claimMax - i.claimMin) * i.tilePx;
  const spanPx =
    claimPx + (2 * i.marginTiles + 2 * RAID_CAMERA.fitPadTiles) * i.tilePx;
  // Fit against the SAFE rect: the HUD eats the top, the deploy tray the bottom.
  // MEASURED insets win over the constants. The constants mirror a React
  // layout, and a layout change (the tray growing to two rows) silently made
  // them 36px short — the fit reserved too little and the base slid under the
  // tray. RaidUI measures the real chrome and passes it; the constants are
  // only the pre-measurement default (verification 2026-07-29).
  const topInset = i.hudTopPx ?? RAID_CAMERA.hudTopPx;
  const bottomInset = i.hudBottomPx ?? RAID_CAMERA.hudBottomPx;
  // Landscape chrome eats WIDTH (the nav rail), and a fit that only knows about
  // top/bottom would frame the base straight under it. Same treatment, other axis.
  const leftInset = i.hudLeftPx ?? 0;
  const rightInset = i.hudRightPx ?? 0;
  const safeH = Math.max(1, i.viewH - topInset - bottomInset);
  const safeW = Math.max(1, i.viewW - leftInset - rightInset);
  const shortAxis = Math.min(safeW, safeH);
  // Pull-back belongs to the same SAFE rect as entry framing. Using the raw
  // viewport here made the tray/HUD cover the field edges at minimum zoom.
  const wholeFieldZoom = shortAxis / Math.max(1, i.fieldSizePx);
  const zoomMin = clamp(
    wholeFieldZoom,
    (i.battlefieldVersion === 2 || i.battlefieldVersion === 3)
      ? Math.min(RAID_CAMERA.minZoom, wholeFieldZoom) : RAID_CAMERA.minZoom,
    RAID_CAMERA.maxZoom,
  );
  // Three pulls, resolved in this order:
  //  · fitRing  — the ideal: base PLUS its whole deploy ring on screen.
  //  · noWaste  — but never zoom out past what the LONGER screen axis needs to
  //    span the whole field. Without this a 390×844 phone fitting 24 tiles
  //    across ends up showing 52 tiles vertically: the field floats in a sea of
  //    background and the base reads as a postage stamp.
  //  · deployFits — leave at least one complete deployment tile plus actor
  //    headroom outside every claim edge. Fitting only the base put its north
  //    edge against the HUD on desktop/landscape: visible-looking taps then
  //    failed the full-body guard and large troops could not be placed there.
  const fitRing = shortAxis / spanPx;
  const noWaste = Math.max(i.viewW, i.viewH) / Math.max(1, i.fieldSizePx);
  const deployFits = shortAxis / (claimPx + 2 * i.tilePx
    + 2 * RAID_CAMERA.northHeadroomWorldPx);
  const zoom = clamp(
    Math.min(Math.max(fitRing, noWaste), deployFits),
    zoomMin,
    Math.min(RAID_CAMERA.fitMaxZoom, RAID_CAMERA.maxZoom),
  );
  const centreX = (defender ? (defender.minX + defender.maxX) / 2 : (i.claimMin + i.claimMax) / 2) * i.tilePx;
  const centreY = (defender ? (defender.minY + defender.maxY) / 2 : (i.claimMin + i.claimMax) / 2) * i.tilePx;
  // Put the claim centre at the middle of the SAFE rect, not of the viewport:
  // camera centre is viewH/2, the safe centre is (viewH + top − bottom)/2, so the
  // look-at point shifts by (bottom − top)/2 in world units. The X bias is the
  // same statement about the side rail, and is exactly 0 in portrait.
  const centerY = centreY + (bottomInset - topInset) / (2 * zoom);
  const centerX = centreX + (rightInset - leftInset) / (2 * zoom);
  return { zoom, zoomMin, zoomMax: RAID_CAMERA.maxZoom, centerX, centerY };
}

/**
 * Tile under a WORLD point. The classic raid bug is tapping tile A and
 * deploying on tile B because the screen→world conversion forgot the camera's
 * scroll or zoom; BattleScene feeds this `camera.getWorldPoint(p.x, p.y)`, which
 * accounts for both, and this only floors it. Tiles are plot-relative and may be
 * negative inside the deploy margin — hence Math.floor, never a truncating `| 0`
 * (which rounds −0.4 to 0 and would land margin taps a tile inside the plot).
 */
export function tileAtWorld(worldX: number, worldY: number, tilePx: number): { tx: number; ty: number } {
  return { tx: Math.floor(worldX / tilePx), ty: Math.floor(worldY / tilePx) };
}
