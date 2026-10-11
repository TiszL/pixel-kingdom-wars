/**
 * Android BuildingArt.kt drawGrassWell's fixed pixel speckle. These are presentation colours,
 * pixel sizes and hash constants, never game balance values. No random source, clock or image fetch.
 */
export const GRASS_COLORS = {
  face: '#3F6A35',
  light: '#4D7B3F',
  dark: '#345A2C',
  band: '#2C4C25',
} as const;

/** Only the low byte survives the native hash, so both cell coordinates repeat every 256 cells. */
export const GRASS_PERIOD_CELLS = 256;
export type GrassSpeckle = 'light' | 'dark' | null;

/** Integer cell coordinates; Math.imul preserves Kotlin Int multiplication before the XOR and low-byte mask. */
export function grassSpeckle(gx: number, gy: number): GrassSpeckle {
  const hash = (Math.imul(gx, 73856093) ^ Math.imul(gy, 19349663)) & 0xFF;
  if (hash < 20) return 'light';
  if (hash < 36) return 'dark';
  return null;
}

/** Native round(2 * density).coerceAtLeast(2), expressed in CSS pixels at the supplied device density. */
export function grassCellCssSize(dpr: number): number {
  const density = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(2, Math.round(2 * density)) / density;
}

function createGrassTileSvg(): string {
  const light: string[] = [];
  const dark: string[] = [];
  for (let gy = 0; gy < GRASS_PERIOD_CELLS; gy++) {
    for (let gx = 0; gx < GRASS_PERIOD_CELLS; gx++) {
      const tone = grassSpeckle(gx, gy);
      if (tone == null) continue;
      (tone === 'light' ? light : dark).push(`M${gx} ${gy}h1v1h-1z`);
    }
  }
  // One cell = one SVG unit. CSS scales the tile to the rounded native cell size, without stretching to the well.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" shape-rendering="crispEdges">`
    + `<rect width="256" height="256" fill="${GRASS_COLORS.face}"/>`
    + `<path fill="${GRASS_COLORS.light}" d="${light.join('')}"/>`
    + `<path fill="${GRASS_COLORS.dark}" d="${dark.join('')}"/></svg>`;
}

/** Generated once when this lazy presentation module loads; two paths, with no per-instance SVG DOM or paint loop. */
export const GRASS_TILE_SVG = createGrassTileSvg();
export const GRASS_TILE_BACKGROUND = `url("data:image/svg+xml,${encodeURIComponent(GRASS_TILE_SVG)}")`;
