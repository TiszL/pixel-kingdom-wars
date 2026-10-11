import { describe, expect, it } from 'vitest';
import { battlefieldBounds } from './battlefield';
import { CAPS, GRID, PLOT_GEOMETRY } from './constants';
import { isInsidePlot, plotBounds, plotVersionForClaim, resolvePlotVersion } from './plotGeometry';

describe('versioned plot geometry', () => {
  it('preserves old snapshots and every existing centred claim coordinate', () => {
    expect(plotBounds()).toEqual({ min: 0, max: 30 });
    expect(plotBounds(1)).toEqual(plotBounds());
    const old = plotBounds(1); const next = plotBounds(2);
    expect(old.min + old.max).toBe(next.min + next.max);
    for (const size of CAPS.claimTilesByExpansion) {
      const min = (GRID.plotTiles - size) / 2;
      expect(isInsidePlot({ tx: min, ty: min, fw: size, fh: size }, 2)).toBe(true);
    }
  });
  it('admits all four corners of the new frame without granting land', () => {
    const { min, max } = plotBounds(PLOT_GEOMETRY.currentVersion);
    expect(max - min).toBe(50);
    for (const tx of [min, max - 1]) for (const ty of [min, max - 1]) {
      expect(isInsidePlot({ tx, ty, fw: 1, fh: 1 }, 2)).toBe(true);
    }
    expect(isInsidePlot({ tx: min, ty: min, fw: 50, fh: 50 }, 2)).toBe(true);
    expect(isInsidePlot({ tx: min - 1, ty: min, fw: 1, fh: 1 }, 2)).toBe(false);
    expect(isInsidePlot({ tx: min, ty: max, fw: 1, fh: 1 }, 2)).toBe(false);
    expect(isInsidePlot({ tx: max - 1, ty: min, fw: 2, fh: 1 }, 2)).toBe(false);
    expect(isInsidePlot({ tx: min, ty: min, fw: 0, fh: 1 }, 2)).toBe(false);
    expect(isInsidePlot({ tx: 0.5, ty: min, fw: 1, fh: 1 }, 2)).toBe(false);
  });
  it('does not grow the approved raid field with the home frame', () => {
    expect(battlefieldBounds(2)).toEqual({ min: -34, max: 64 });
    expect(GRID.plotTiles).toBe(30);
  });
  it('selects a live claim contract without relabelling historical coordinates', () => {
    for (const size of CAPS.claimTilesByExpansion) {
      const min = (GRID.plotTiles - size) / 2;
      expect(plotVersionForClaim({ min, max: min + size })).toBe(size <= GRID.plotTiles ? 1 : 2);
    }
    expect(plotVersionForClaim(plotBounds(1))).toBe(1);
    expect(plotVersionForClaim(plotBounds(2))).toBe(2);
    for (const claim of [{ min: -11, max: 40 }, { min: 0, max: 41 }, { min: 0.5, max: 30 }, { min: 15, max: 15 }]) {
      expect(() => plotVersionForClaim(claim)).toThrow();
    }
  });
  it('fails closed on unsupported or malformed versions', () => {
    for (const value of [0, -1, 3, 1.5, Number.NaN]) {
      expect(() => resolvePlotVersion(value)).toThrow('unsupported plot version');
      expect(() => isInsidePlot({ tx: 8, ty: 8, fw: 1, fh: 1 }, value)).toThrow();
    }
  });
});
