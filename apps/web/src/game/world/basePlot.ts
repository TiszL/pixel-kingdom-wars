import { plotBounds, resolvePlotVersion } from '@shardkeep/shared';

/** A future plot must not silently enable present-day placement controls. */
export function supportedPlotVersion(version?: number): boolean {
  try { resolvePlotVersion(version); return true; } catch { return false; }
}

export function clampPlotPosition(tx: number, ty: number, fw: number, fh: number, version?: number): { tx: number; ty: number } {
  const { min, max } = plotBounds(version);
  return { tx: Math.max(min, Math.min(max - fw, tx)), ty: Math.max(min, Math.min(max - fh, ty)) };
}
