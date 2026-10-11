/**
 * Battle-camera geometry. The load-bearing property is the second suite: a tap
 * must land on the tile the player touched NO MATTER where the camera is
 * scrolled or how far it is zoomed. That is the classic raid bug, and it only
 * became reachable when the camera started moving at all.
 */
import { GRID, RAID_CAMERA, RAID_RULES } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { fitBattleCamera, tileAtWorld } from './battlecamera';

const T = 64;
const MARGIN = RAID_RULES.deployMarginTiles;
const FIELD_PX = (GRID.plotTiles + MARGIN * 2) * T;

/** A fresh centered claim on the 30-plot: 14 tiles, so 8..22. */
const FRESH = { claimMin: 8, claimMax: 22 };
/** A fully-expanded claim: 26 tiles, so 2..28. */
const MAXED = { claimMin: 2, claimMax: 28 };

const fit = (c: { claimMin: number; claimMax: number }, viewW: number, viewH: number) =>
  fitBattleCamera({ ...c, marginTiles: MARGIN, fieldSizePx: FIELD_PX, viewW, viewH, tilePx: T });

describe('fitBattleCamera', () => {
  it('enters near the frozen defender on a larger empty claim while retaining full-field navigation', () => {
    const common = { battlefieldVersion: 2 as const, claimMin: -10, claimMax: 40,
      marginTiles: MARGIN, fieldSizePx: 98 * T, viewW: 873, viewH: 393, tilePx: T,
      hudTopPx: 64, hudBottomPx: 64 };
    const emptyLandFit = fitBattleCamera(common);
    const defenderFit = fitBattleCamera({ ...common, defenderBounds: { minX: 5, minY: 6, maxX: 25, maxY: 26 } });
    expect(defenderFit.zoom).toBeGreaterThan(emptyLandFit.zoom);
    expect(defenderFit.zoomMin).toBe(emptyLandFit.zoomMin);
    expect(defenderFit.centerX).toBe(15 * T); expect(defenderFit.centerY).toBe(16 * T);
    expect(fitBattleCamera({ ...common, battlefieldVersion: 3 })).toEqual(fitBattleCamera(common));
    const historical = { ...common, battlefieldVersion: 1 as const };
    expect(fitBattleCamera({ ...historical, defenderBounds: { minX: 5, minY: 6, maxX: 25, maxY: 26 } }))
      .toEqual(fitBattleCamera(historical));
  });
  it('shows the WHOLE base on a 390px phone — the blocker', () => {
    // WHY: the scene used to hardcode zoom 0.5, which on a 390px viewport shows
    // 390/0.5 = 780px = 12 of the battlefield's 38 tile columns — less than the
    // 14-tile base itself, with no pan and no pinch to reach the rest.
    for (const claim of [FRESH, MAXED]) {
      const f = fit(claim, 390, 844);
      const visibleTilesX = 390 / f.zoom / T;
      expect(visibleTilesX).toBeGreaterThanOrEqual(claim.claimMax - claim.claimMin);
      expect(f.zoom).toBeLessThan(0.5); // strictly wider than the old hardcoded value
    }
  });

  it('keeps the base inside the SAFE rect, clear of the HUD and the tray', () => {
    // WHY: fitting against the raw viewport height puts the base under the
    // ~110px deploy tray, where the player cannot tap it.
    const safeH = 844 - RAID_CAMERA.hudTopPx - RAID_CAMERA.hudBottomPx;
    for (const claim of [FRESH, MAXED]) {
      const f = fit(claim, 390, 844);
      expect((claim.claimMax - claim.claimMin) * T * f.zoom).toBeLessThanOrEqual(safeH);
    }
  });

  it.each([[320, 740], [412, 892], [915, 412], [1280, 720], [2560, 1440]])(
    'keeps the northern deployment row and troop headroom visible at %s × %s', (w, h) => {
      // A base-only fit filled the safe height on desktop/landscape, so the
      // entire northern deployment row was behind the HUD. The owner's new
      // deployment request takes priority over the previous no-background fit.
      for (const claim of [FRESH, MAXED]) {
        const f = fit(claim, w!, h!);
        const safeShort = Math.min(w!, h! - RAID_CAMERA.hudTopPx - RAID_CAMERA.hudBottomPx);
        const corridor = (claim.claimMax - claim.claimMin + 2) * T
          + 2 * RAID_CAMERA.northHeadroomWorldPx;
        if (corridor * RAID_CAMERA.minZoom > safeShort) {
          // A very short viewport cannot fit at the retained readability floor;
          // the existing pan bounds still expose each edge without changing it.
          expect(f.zoom).toBe(RAID_CAMERA.minZoom);
          continue;
        }
        const top = h! / 2 + ((claim.claimMin - 1) * T
          - RAID_CAMERA.northHeadroomWorldPx - f.centerY) * f.zoom;
        const bottom = h! / 2 + ((claim.claimMax + 1) * T
          + RAID_CAMERA.northHeadroomWorldPx - f.centerY) * f.zoom;
        const left = w! / 2 + ((claim.claimMin - 1) * T
          - RAID_CAMERA.northHeadroomWorldPx - f.centerX) * f.zoom;
        const right = w! / 2 + ((claim.claimMax + 1) * T
          + RAID_CAMERA.northHeadroomWorldPx - f.centerX) * f.zoom;
        expect(top).toBeGreaterThanOrEqual(RAID_CAMERA.hudTopPx - 1e-6);
        expect(bottom).toBeLessThanOrEqual(h! - RAID_CAMERA.hudBottomPx + 1e-6);
        expect(left).toBeGreaterThanOrEqual(-1e-6);
        expect(right).toBeLessThanOrEqual(w! + 1e-6);
      }
    },
  );

  it('lets the player pinch out to the ENTIRE battlefield on any viewport', () => {
    for (const [w, h] of [[390, 844], [844, 390], [1280, 800]] as const) {
      const f = fit(MAXED, w, h);
      expect(FIELD_PX * f.zoomMin).toBeLessThanOrEqual(Math.min(w, h) + 0.001);
      expect(f.zoomMin).toBeGreaterThanOrEqual(RAID_CAMERA.minZoom);
      expect(f.zoomMin).toBeLessThanOrEqual(f.zoom);
    }
  });

  it('derives phone pull-back from the tappable safe rect, not covered chrome', () => {
    const f = fitBattleCamera({
      ...FRESH, marginTiles: MARGIN, fieldSizePx: FIELD_PX,
      viewW: 390, viewH: 844, tilePx: T, hudTopPx: 120, hudBottomPx: 180,
    });
    const safeShort = Math.min(390, 844 - 120 - 180);
    expect(FIELD_PX * f.zoomMin).toBeLessThanOrEqual(safeShort + 1e-6);
  });

  it('caps large-display framing without removing the deployment corridor', () => {
    expect(fit(FRESH, 3840, 2160).zoom).toBe(RAID_CAMERA.fitMaxZoom);
    expect(fit(FRESH, 1280, 720).zoom).toBeLessThan(RAID_CAMERA.fitMaxZoom);
  });

  it('centres on the CLAIM, not the plot — an off-centre claim still frames', () => {
    // WHY: the scene used to centerOn(world/2). Claim bounds are server-owned
    // and centered today, but deriving the centre from them is what keeps this
    // correct if that ever changes (the same derivation the rally point uses).
    const f = fit({ claimMin: 0, claimMax: 10 }, 390, 844);
    expect(f.centerX).toBe(5 * T);
    // Y is biased upward by the HUD/tray asymmetry so the base clears the tray.
    expect(f.centerY).toBeGreaterThan(f.centerX);
  });

  it('never returns a zoom outside the hard band', () => {
    for (const [w, h] of [[200, 200], [390, 844], [3840, 2160]] as const) {
      const f = fit(MAXED, w, h);
      expect(f.zoom).toBeGreaterThanOrEqual(RAID_CAMERA.minZoom);
      expect(f.zoom).toBeLessThanOrEqual(RAID_CAMERA.maxZoom);
    }
  });
});

describe('fitBattleCamera — landscape moves chrome onto the SIDE', () => {
  const fitWith = (o: Partial<Parameters<typeof fitBattleCamera>[0]>) =>
    fitBattleCamera({
      ...FRESH, marginTiles: MARGIN, fieldSizePx: FIELD_PX, viewW: 390, viewH: 844, tilePx: T, ...o,
    });
  /** Where a world x/y lands on screen: the camera shows centerX at viewW/2. */
  const screenX = (worldX: number, f: ReturnType<typeof fitBattleCamera>, viewW: number) =>
    viewW / 2 + (worldX - f.centerX) * f.zoom;
  const screenY = (worldY: number, f: ReturnType<typeof fitBattleCamera>, viewH: number) =>
    viewH / 2 + (worldY - f.centerY) * f.zoom;

  it('is byte-identical to the portrait fit when there is no side chrome', () => {
    // PORTRAIT MUST NOT REGRESS: side insets default to 0, and 0 has to mean
    // "exactly what this returned before the sides existed".
    expect(fitWith({ hudLeftPx: 0, hudRightPx: 0 })).toEqual(fitWith({}));
  });

  it('frames the base clear of a landscape nav RAIL on the right', () => {
    // WHY: landscape stands the navbar up as a rail on the right edge (ui/layout
    // CHROME.rail), so the usable width is viewW − rail. Fitting and centring
    // against the RAW viewport parks the base half under the rail, where it can
    // be seen but not tapped — the raid equivalent of the bug the top/bottom
    // insets already fixed for the deploy tray.
    const RAIL = 76;
    const view = { w: 915, h: 412 };
    const f = fitWith({ viewW: view.w, viewH: view.h, hudTopPx: 40, hudBottomPx: 96, hudRightPx: RAIL });
    const left = screenX(FRESH.claimMin * T, f, view.w);
    const right = screenX(FRESH.claimMax * T, f, view.w);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(view.w - RAIL);
    // and it is CENTRED in what is left, not merely squeezed inside it
    expect((left + right) / 2).toBeCloseTo((view.w - RAIL) / 2, 6);
    // the vertical bias still holds at the same time (the base fills the safe
    // height exactly here, hence the float slack on the two edge assertions)
    const top = screenY(FRESH.claimMin * T, f, view.h);
    const bottom = screenY(FRESH.claimMax * T, f, view.h);
    expect((top + bottom) / 2).toBeCloseTo(40 + (view.h - 40 - 96) / 2, 6);
    expect(top).toBeGreaterThanOrEqual(40 - 1e-6);
    expect(bottom).toBeLessThanOrEqual(view.h - 96 + 1e-6);
  });

  it('fits the base to the safe WIDTH when the rail is what makes it scarce', () => {
    // A rail wide enough to make width the binding axis must shrink the framing,
    // not just shift it — otherwise the base overflows the rail it was moved off.
    const view = { w: 700, h: 900 };
    const f = fitWith({ viewW: view.w, viewH: view.h, hudTopPx: 0, hudBottomPx: 0, hudRightPx: 400 });
    expect((FRESH.claimMax - FRESH.claimMin) * T * f.zoom).toBeLessThanOrEqual(view.w - 400);
  });
});

describe('tileAtWorld — a deploy must land on the tile you tapped', () => {
  /** What BattleScene does: camera.getWorldPoint, then floor to a tile. This
   *  reproduces getWorldPoint's arithmetic so the whole screen→tile chain is
   *  under test, not just the flooring half. */
  const tapped = (screenX: number, screenY: number, scrollX: number, scrollY: number, zoom: number) =>
    tileAtWorld(scrollX + screenX / zoom, scrollY + screenY / zoom, T);

  it('is unaffected by how far the camera has been panned or zoomed', () => {
    // Aim at the centre of tile (17, 9) from four very different cameras.
    const target = { tx: 17, ty: 9 };
    const worldX = (target.tx + 0.5) * T;
    const worldY = (target.ty + 0.5) * T;
    for (const zoom of [0.16, 0.34, 0.5, 1.2]) {
      for (const [scrollX, scrollY] of [[0, 0], [-256, -256], [640, 1280]] as const) {
        const screenX = (worldX - scrollX) * zoom;
        const screenY = (worldY - scrollY) * zoom;
        expect(tapped(screenX, screenY, scrollX, scrollY, zoom)).toEqual(target);
      }
    }
  });

  it('resolves NEGATIVE margin tiles instead of rounding them into the plot', () => {
    // WHY: the deploy margin runs to tile -4, and a truncating `| 0` maps
    // world −0.4 tiles to 0 — a tap in the margin would deploy inside the plot.
    expect(tileAtWorld(-1, -1, T)).toEqual({ tx: -1, ty: -1 });
    expect(tileAtWorld(-MARGIN * T, -MARGIN * T, T)).toEqual({ tx: -MARGIN, ty: -MARGIN });
    expect(tileAtWorld(-0.5 * T, 0, T)).toEqual({ tx: -1, ty: 0 });
  });

  it('puts tile boundaries where the grid draws them', () => {
    expect(tileAtWorld(0, 0, T)).toEqual({ tx: 0, ty: 0 });
    expect(tileAtWorld(T - 0.01, T - 0.01, T)).toEqual({ tx: 0, ty: 0 });
    expect(tileAtWorld(T, T, T)).toEqual({ tx: 1, ty: 1 });
  });
});
