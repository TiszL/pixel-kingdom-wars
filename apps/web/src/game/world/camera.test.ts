/**
 * Camera behaviour across an orientation flip (landscape became first-class
 * 2026-08-02). Two load-bearing properties: after the phone rotates the player is
 * still looking at what they were looking at — a raid lasts 60 seconds and
 * someone WILL rotate mid-fight — and they still cannot see past the skirted
 * world edge.
 *
 * The fake camera below reproduces Phaser 4.1's arithmetic (Camera.js preRender,
 * BaseCamera.js centerOn/clampX). Same trick battlecamera.test.ts uses for
 * getWorldPoint: it puts the whole resize → look-at chain under test instead of
 * only the half written here, and it is what lets the "without the fix" drift be
 * asserted rather than asserted about.
 */
import { BASE_CAMERA, GRID } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import {
  baseRenderBounds, baseZoomBand, fitBaseCamera, reframeAfterResize, ZOOM_MAX, ZOOM_MIN,
  type ResizedCamera,
} from './camera';

const T = 64;
const SKIRT = BASE_CAMERA.skirtTiles * T; // BaseScene
const WORLD = GRID.plotTiles * T;
const BOUNDS = WORLD + SKIRT * 2; // square camera bounds: plot + skirt
/** The Seeker both ways up (measured 2026-08-02). */
const PORT = { w: 412, h: 915 };
const LAND = { w: 915, h: 412 };
const band = (v: { w: number; h: number }, claimTiles: number = GRID.claimTiles) =>
  baseZoomBand(v.w, v.h, BOUNDS, claimTiles, T);

class FakeCamera implements ResizedCamera {
  scrollX = 0;
  scrollY = 0;
  zoom = 1;
  midPoint = { x: 0, y: 0 };
  worldView = { x: 0, y: 0, width: 0, height: 0 };

  constructor(public width: number, public height: number,
    public bounds = { x: -SKIRT, y: -SKIRT, width: BOUNDS, height: BOUNDS }) {}

  setZoom(z: number): void {
    this.zoom = z;
  }

  /** BaseCamera.centerOnX/Y: midPoint eagerly, scroll clamped to the bounds. */
  centerOn(x: number, y: number): void {
    this.midPoint = { x, y };
    this.scrollX = this.clampScroll(x - this.width * 0.5, this.width, this.bounds.x, this.bounds.width);
    this.scrollY = this.clampScroll(y - this.height * 0.5, this.height, this.bounds.y, this.bounds.height);
  }

  /** BaseCamera.clampX/clampY — one axis; identical on a square bounds rect. */
  private clampScroll(scroll: number, viewPx: number, origin: number, size: number): number {
    const display = viewPx / this.zoom;
    const lo = origin + (display - viewPx) / 2;
    const hi = Math.max(lo, lo + size - display);
    return scroll < lo ? lo : scroll > hi ? hi : scroll;
  }

  /** Camera.preRender: clamp scroll, then derive midPoint + worldView from it.
   *  midPoint is refreshed HERE and nowhere else, which is precisely why a resize
   *  handler can still read the PRE-resize centre out of it. */
  preRender(): void {
    this.scrollX = this.clampScroll(this.scrollX, this.width, this.bounds.x, this.bounds.width);
    this.scrollY = this.clampScroll(this.scrollY, this.height, this.bounds.y, this.bounds.height);
    this.midPoint = { x: this.scrollX + this.width / 2, y: this.scrollY + this.height / 2 };
    this.worldView = {
      x: this.midPoint.x - this.width / this.zoom / 2,
      y: this.midPoint.y - this.height / this.zoom / 2,
      width: this.width / this.zoom,
      height: this.height / this.zoom,
    };
  }

  /** What Phaser's CameraManager does on Scale.RESIZE — before any scene handler
   *  (it subscribes at scene boot), and it touches neither scroll nor zoom. */
  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }
}

/** A camera parked off-centre, as a player who has panned to their forge. */
const panned = (v: { w: number; h: number }, zoom = 1): FakeCamera => {
  const cam = new FakeCamera(v.w, v.h);
  cam.zoom = zoom;
  cam.centerOn(1200, 700);
  cam.preRender();
  return cam;
};

describe('reframeAfterResize', () => {
  it('keeps the player looking at the same place through a rotation', () => {
    const cam = panned(PORT);
    cam.resize(LAND.w, LAND.h);
    reframeAfterResize(cam, band(LAND));
    cam.preRender();
    expect(cam.midPoint.x).toBeCloseTo(1200, 6);
    expect(cam.midPoint.y).toBeCloseTo(700, 6);
  });

  it('strands the view by half the size change when it is NOT called', () => {
    // WHY this test exists: it is the bug. Phaser re-derives the look-at point as
    // `scroll + viewport/2`, so a resize that leaves scroll alone slides the view
    // by (915−412)/2 = 251 world px — ~4 tiles, diagonally, mid-raid.
    const cam = panned(PORT);
    cam.resize(LAND.w, LAND.h);
    cam.preRender();
    expect(cam.midPoint.x).toBeCloseTo(1200 + (LAND.w - PORT.w) / 2, 6);
    expect(cam.midPoint.y).toBeCloseTo(700 + (LAND.h - PORT.h) / 2, 6);
  });

  it('never shows past the skirted world edge after a rotation', () => {
    // Pulled all the way back AND slammed into the north-west corner: the state
    // where a wider viewport is most likely to reveal the void beyond the grass.
    for (const [from, to] of [[PORT, LAND], [LAND, PORT]] as const) {
      const cam = new FakeCamera(from.w, from.h);
      cam.zoom = band(from).min;
      cam.centerOn(-9e4, -9e4);
      cam.preRender();
      cam.resize(to.w, to.h);
      reframeAfterResize(cam, band(to));
      cam.preRender();
      expect(cam.worldView.x).toBeGreaterThanOrEqual(-SKIRT - 1e-6);
      expect(cam.worldView.y).toBeGreaterThanOrEqual(-SKIRT - 1e-6);
      expect(cam.worldView.x + cam.worldView.width).toBeLessThanOrEqual(-SKIRT + BOUNDS + 1e-6);
      expect(cam.worldView.y + cam.worldView.height).toBeLessThanOrEqual(-SKIRT + BOUNDS + 1e-6);
    }
  });

  it('pulls a zoom the new viewport no longer allows back into the band', () => {
    const cam = panned(PORT, ZOOM_MIN);
    cam.resize(3840, 2160); // desktop window, where ZOOM_MIN would overshoot the world
    const desktopBand = baseZoomBand(3840, 2160, BOUNDS, GRID.claimTiles, T);
    reframeAfterResize(cam, desktopBand);
    expect(cam.zoom).toBe(desktopBand.min);
    expect(cam.zoom).toBeGreaterThan(ZOOM_MIN);
  });
});

describe('baseZoomBand', () => {
  it('fits the current claim plus breathing room on a narrow phone both ways up', () => {
    for (const v of [PORT, LAND]) {
      const result = band(v);
      const paddedClaimPx = (GRID.claimTiles + BASE_CAMERA.fitPadTiles * 2) * T;
      expect(result.min).toBeCloseTo(Math.min(v.w, v.h) / paddedClaimPx, 6);
      expect(paddedClaimPx * result.min).toBeLessThanOrEqual(Math.min(v.w, v.h) + 1e-6);
      expect(result.max).toBe(ZOOM_MAX);
    }
  });

  it('lowers the floor as the live claim expands instead of trapping outer walls off-screen', () => {
    const fresh = band(PORT, 14);
    const expanded = band(PORT, 26);
    expect(expanded.min).toBeLessThan(fresh.min);
    expect((26 + BASE_CAMERA.fitPadTiles * 2) * T * expanded.min)
      .toBeLessThanOrEqual(PORT.w + 1e-6);
  });

  it.each([
    [360, 800],
    [390, 844],
  ])('shows every tile of a max claim on a %ipx narrow phone', (w, h) => {
    const result = baseZoomBand(w, h, BOUNDS, 26, T);
    expect(26 * T * result.min).toBeLessThanOrEqual(w + 1e-6);
    expect(h / result.min).toBeLessThanOrEqual(BOUNDS + 1e-6);
  });

  it('raises the floor rather than letting a wide viewport see the void', () => {
    // A desktop's long axis can exceed the skirt at the hard floor; the live
    // floor rises instead of exposing flat background and pinning Phaser's pan.
    for (const [w, h] of [[1920, 1080], [2560, 1440], [3840, 2160]] as const) {
      const result = baseZoomBand(w, h, BOUNDS, GRID.claimTiles, T);
      expect(Math.max(w, h) / result.min).toBeLessThanOrEqual(BOUNDS + 1e-6);
      expect(result.min).toBeGreaterThan(ZOOM_MIN);
    }
  });

  it('never bands the floor above the ceiling', () => {
    const result = baseZoomBand(20000, 20000, BOUNDS, GRID.claimTiles, T);
    expect(result.min).toBeLessThanOrEqual(result.max);
    expect(result.min).toBe(ZOOM_MAX);
  });
});

describe('fitBaseCamera — measured base chrome', () => {
  const MAX = { min: 2, max: 28 };
  const screenPoint = (world: number, center: number, size: number, zoom: number): number =>
    size / 2 + (world - center) * zoom;

  it('keeps a max claim between portrait HUD and navbar on a 390×844 phone', () => {
    const insets = { top: 126, bottom: 92, left: 0, right: 0 };
    const f = fitBaseCamera(390, 844, BOUNDS, MAX, T, insets);
    const top = screenPoint(MAX.min * T, f.centerY, 844, f.zoom);
    const bottom = screenPoint(MAX.max * T, f.centerY, 844, f.zoom);
    expect(top).toBeGreaterThanOrEqual(insets.top);
    expect(bottom).toBeLessThanOrEqual(844 - insets.bottom);
    expect((MAX.max - MAX.min) * T * f.zoom).toBeLessThanOrEqual(390);
  });

  it('keeps a max claim left of the landscape rail on an 844×390 phone', () => {
    const insets = { top: 38, bottom: 0, left: 0, right: 76 };
    const f = fitBaseCamera(844, 390, BOUNDS, MAX, T, insets);
    const left = screenPoint(MAX.min * T, f.centerX, 844, f.zoom);
    const right = screenPoint(MAX.max * T, f.centerX, 844, f.zoom);
    const top = screenPoint(MAX.min * T, f.centerY, 390, f.zoom);
    expect(left).toBeGreaterThanOrEqual(insets.left);
    expect(right).toBeLessThanOrEqual(844 - insets.right);
    expect(top).toBeGreaterThanOrEqual(insets.top);
  });

  /**
   * REWRITTEN 2026-08-30 with `fitPadTiles` 1.5 → 4 (owner: the base "reads too
   * big"). This used to assert the whole PADDED box — claim plus the breathing
   * room — landed inside the Seeker's chrome, which was true only while the pad
   * was small enough for a 311-px-tall webview to hold it at a max claim. It no
   * longer is: at 34 padded tiles the fit falls under the zoom FLOOR, and the
   * floor wins, because showing the void outside the skirt is worse than a
   * thinner margin.
   *
   * The claim itself is what must always fit, and still does with real room to
   * spare — so that is what this pins now, plus the two invariants the padded
   * assertion was standing in for: the framing never exposes the void, and the
   * pad is honoured everywhere it CAN be. The floor case is asserted by name so
   * a future pad raise that quietly stops binding anywhere is visible.
   */
  it('fits a max claim with room inside the canonical 915×311 Seeker webview', () => {
    const insets = { top: 38, bottom: 0, left: 0, right: 76 };
    const f = fitBaseCamera(915, 311, BOUNDS, MAX, T, insets);
    const safeH = 311 - insets.top - insets.bottom;
    const top = screenPoint(MAX.min * T, f.centerY, 311, f.zoom);
    const bottom = screenPoint(MAX.max * T, f.centerY, 311, f.zoom);
    const left = screenPoint(MAX.min * T, f.centerX, 915, f.zoom);
    const right = screenPoint(MAX.max * T, f.centerX, 915, f.zoom);
    expect(left).toBeGreaterThanOrEqual(insets.left);
    expect(right).toBeLessThanOrEqual(915 - insets.right);
    expect(top).toBeGreaterThanOrEqual(insets.top);
    expect(bottom).toBeLessThanOrEqual(311 - insets.bottom);
    // Breathing room, not a hairline: the claim leaves at least a tile of the
    // safe height free even on the shortest webview the game supports.
    expect(bottom - top).toBeLessThanOrEqual(safeH - T * f.zoom);
    // Never the void, and here the skirt floor — not the padded fit — is what
    // decides the zoom.
    expect(915 / f.zoom).toBeLessThanOrEqual(BOUNDS);
    expect(f.zoom).toBeCloseTo(915 / BOUNDS, 6);
    expect(f.zoom).toBeGreaterThan(safeH / ((MAX.max - MAX.min + BASE_CAMERA.fitPadTiles * 2) * T));
  });

  /**
   * …and the pad DOES bind where the viewport can hold it, which is the case
   * the owner was looking at: a fresh 14-tile claim on an ordinary window. It
   * is the whole point of the number — the opening view is the claim plus a
   * margin on every side, not the claim pressed against the chrome.
   */
  it('opens a fresh claim with the full pad on every side', () => {
    const fresh = {
      min: (GRID.plotTiles - GRID.claimTiles) / 2,
      max: (GRID.plotTiles + GRID.claimTiles) / 2,
    };
    for (const [w, h] of [[1280, 900], [360, 800]] as const) {
      const f = fitBaseCamera(w, h, BOUNDS, fresh, T);
      const short = Math.min(w, h);
      // The short axis frames exactly claim + 2 × pad tiles.
      expect(short / (f.zoom * T))
        .toBeCloseTo(GRID.claimTiles + BASE_CAMERA.fitPadTiles * 2, 6);
      // …and that is strictly more world than the claim alone, on both axes.
      const claimPx = GRID.claimTiles * T * f.zoom;
      expect(claimPx).toBeLessThan(Math.min(w, h));
    }
  });
});


describe('extended HOME inset framing survives the real camera clamp', () => {
  it.each([
    [1080, 2400, { top: 84, bottom: 72, left: 0, right: 0 }],
    [2400, 1080, { top: 180, bottom: 24, left: 0, right: 72 }],
    [2400, 1080, { top: 300, bottom: 100, left: 84, right: 0 }],
    [1080, 1080, { top: 210, bottom: 140, left: 0, right: 0 }],
  ])('keeps all 50 tiles and their pad inside the safe square at %s × %s', (w, h, insets) => {
    const claim = { min: -10, max: 40 };
    const frame = fitBaseCamera(w, h, BOUNDS, claim, T, insets, true);
    const bounds = baseRenderBounds(w, h, frame.min, -SKIRT, BOUNDS, insets);
    const camera = new FakeCamera(w, h, bounds);
    camera.setZoom(frame.zoom);
    camera.centerOn(frame.centerX, frame.centerY);
    camera.preRender();
    expect(camera.midPoint.x).toBeCloseTo(frame.centerX, 5);
    expect(camera.midPoint.y).toBeCloseTo(frame.centerY, 5);
    const screen = (world: number, center: number, size: number): number => size / 2 + (world - center) * frame.zoom;
    for (const [axis, size, near, far] of [
      ['x', w, insets.left, insets.right], ['y', h, insets.top, insets.bottom],
    ] as const) {
      expect(screen((claim.min - BASE_CAMERA.fitPadTiles) * T, camera.midPoint[axis], size)).toBeGreaterThanOrEqual(near - 1e-6);
      expect(screen((claim.max + BASE_CAMERA.fitPadTiles) * T, camera.midPoint[axis], size)).toBeLessThanOrEqual(size - far + 1e-6);
    }
    camera.setZoom(Math.min(frame.max, frame.zoom * 2));
    camera.centerOn(frame.centerX + 50, frame.centerY + 50);
    camera.preRender();
    expect(camera.midPoint.x).toBeCloseTo(frame.centerX + 50, 5);
    expect(camera.midPoint.y).toBeCloseTo(frame.centerY + 50, 5);
    camera.centerOn(1e8, -1e8);
    camera.preRender();
    expect(camera.worldView.x + camera.worldView.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-6);
    expect(camera.worldView.y).toBeGreaterThanOrEqual(bounds.y - 1e-6);
  });
});
