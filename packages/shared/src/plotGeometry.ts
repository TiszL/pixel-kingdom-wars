import { PLOT_GEOMETRY } from './constants';
import type { PlotGeometryVersion } from './types';

/** Unknown wire values cannot silently open placement or paid actions. */
export function resolvePlotVersion(value?: number): PlotGeometryVersion {
  if (value === undefined || value === PLOT_GEOMETRY.legacyVersion) return 1;
  if (value === PLOT_GEOMETRY.currentVersion) return 2;
  throw new RangeError(`unsupported plot version: ${value}`);
}

export function plotBounds(version?: number): { min: number; max: number } {
  return { ...PLOT_GEOMETRY.boundsByVersion[resolvePlotVersion(version)] };
}

/** Live claims select their coordinate contract without moving older layouts.
 * Archived snapshots must keep their recorded version instead of calling this. */
export function plotVersionForClaim(claim: { min: number; max: number }): PlotGeometryVersion {
  if (!Number.isInteger(claim.min) || !Number.isInteger(claim.max) || claim.max <= claim.min) {
    throw new RangeError('invalid plot claim');
  }
  for (const version of [PLOT_GEOMETRY.legacyVersion, PLOT_GEOMETRY.currentVersion]) {
    const bounds = plotBounds(version);
    if (claim.min >= bounds.min && claim.max <= bounds.max) return version;
  }
  throw new RangeError('claim exceeds supported plot geometry');
}

export function isInsidePlot(
  rect: { tx: number; ty: number; fw: number; fh: number }, version?: number,
): boolean {
  const { min, max } = plotBounds(version);
  return [rect.tx, rect.ty, rect.fw, rect.fh].every(Number.isInteger)
    && rect.fw > 0 && rect.fh > 0
    && rect.tx >= min && rect.ty >= min
    && rect.tx + rect.fw <= max && rect.ty + rect.fh <= max;
}
