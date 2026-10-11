import { describe, expect, it } from 'vitest';
import { plotBounds } from '@shardkeep/shared';
import { clampPlotPosition, supportedPlotVersion } from './basePlot';
import { Occupancy } from './occupancy';
import { fitBaseCamera } from './camera';

describe('versioned home plot', () => {
  it('keeps historical clamps and admits every corner of the explicit signed plot', () => {
    expect(clampPlotPosition(-10, 39, 1, 1)).toEqual({ tx: 0, ty: 29 });
    const { min, max } = plotBounds(2);
    for (const tx of [min, max - 3]) for (const ty of [min, max - 3]) {
      expect(clampPlotPosition(tx, ty, 3, 3, 2)).toEqual({ tx, ty });
    }
    expect(clampPlotPosition(-100, 100, 3, 3, 2)).toEqual({ tx: min, ty: max - 3 });
    expect(supportedPlotVersion(3)).toBe(false);
    expect(() => clampPlotPosition(0, 0, 1, 1, 3)).toThrow('unsupported plot version');
  });
  it('routes camp actors around signed-coordinate walls without aliasing cells', () => {
    const occupancy = new Occupancy(64);
    occupancy.rebuild([{ tx: -8, ty: -8, fw: 1, fh: 3 }, { tx: 39, ty: 39, fw: 1, fh: 1 }], 2);
    expect(occupancy.tileFree(-8, -7)).toBe(false);
    expect(occupancy.tileFree(39, 39)).toBe(false);
    expect(occupancy.tileFree(2, 2)).toBe(true);
    const route = occupancy.route(-9.5 * 64, -7.5 * 64, { x: -6.5 * 64, y: -7.5 * 64 });
    expect(route).not.toBeNull();
    let point = { x: -9.5 * 64, y: -7.5 * 64 };
    for (const target of route!) {
      expect(occupancy.clearLine(point.x, point.y, target.x, target.y)).toBe(true);
      point = target;
    }
    const version = occupancy.version;
    occupancy.rebuild([], 1);
    expect(occupancy.version).toBeGreaterThan(version);
    expect(occupancy.tileFree(-8, -7)).toBe(true);
  });
  it('frames a centered 50 tile claim without shifting old building coordinates', () => {
    const claim = plotBounds(2);
    for (const [w, h] of [[390, 844], [844, 390]]) {
      const frame = fitBaseCamera(w!, h!, 98 * 64, claim, 64, undefined, true);
      expect(frame.centerX).toBe(15 * 64); expect(frame.centerY).toBe(15 * 64);
      expect(50 * 64 * frame.zoom).toBeLessThanOrEqual(Math.min(w!, h!));
    }
  });
});
