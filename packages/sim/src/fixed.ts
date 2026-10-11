/**
 * fixed.ts — integer spatial math. 1 tile = 256 units (ARCHITECTURE §6).
 *
 * Every position the sim stores is an integer count of 1/256-tile units, so
 * all arithmetic stays in the exact-integer range of IEEE doubles and replays
 * are bit-identical on every JS engine. No Math.sqrt for ORDERING decisions —
 * compare squared distances; isqrt is used only where a true distance feeds a
 * movement step, and it is an exact integer Newton iteration.
 */

export const UNITS_PER_TILE = 256;

/**
 * The eight compass directions as PRE-COMPUTED integer vectors, one tile long.
 * Used by Omega Shardstorm's radial crescents (8 fixed bearings).
 *
 * This is derived GEOMETRY, not a game number, so it lives here rather than in
 * constants.ts — and it is a TABLE rather than a trigonometric loop because the
 * transcendental builtins are banned in this package (banned-tokens test). 181 is
 * round(256/√2) = round(181.019), computed once, offline, by hand.
 */
export const COMPASS8: ReadonlyArray<readonly [number, number]> = [
  [UNITS_PER_TILE, 0], [181, 181], [0, UNITS_PER_TILE], [-181, 181],
  [-UNITS_PER_TILE, 0], [-181, -181], [0, -UNITS_PER_TILE], [181, -181],
];

/** Center of a tile, in units. */
export function tileCenter(tile: number): number {
  return tile * UNITS_PER_TILE + UNITS_PER_TILE / 2;
}

/** Which tile a unit coordinate falls in. */
export function unitToTile(u: number): number {
  return Math.floor(u / UNITS_PER_TILE);
}

/** Exact integer square root (floor). Newton's method on integers. */
export function isqrt(n: number): number {
  if (n < 0) throw new RangeError(`isqrt of negative: ${n}`);
  if (n < 2) return n;
  let x = n;
  let y = Math.floor((x + 1) / 2);
  while (y < x) {
    x = y;
    y = Math.floor((x + Math.floor(n / x)) / 2);
  }
  return x;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Distance (units, floored) from a point to an axis-aligned rect given in
 * tile coords [tx, ty, fw, fh]. 0 when the point is inside.
 */
export function distToRect(px: number, py: number, tx: number, ty: number, fw: number, fh: number): number {
  const x0 = tx * UNITS_PER_TILE;
  const y0 = ty * UNITS_PER_TILE;
  const x1 = (tx + fw) * UNITS_PER_TILE;
  const y1 = (ty + fh) * UNITS_PER_TILE;
  const cx = px < x0 ? x0 : px > x1 ? x1 : px;
  const cy = py < y0 ? y0 : py > y1 ? y1 : py;
  return isqrt(dist2(px, py, cx, cy));
}

/** Squared distance point→rect, for ordering without isqrt. */
export function dist2ToRect(px: number, py: number, tx: number, ty: number, fw: number, fh: number): number {
  const x0 = tx * UNITS_PER_TILE;
  const y0 = ty * UNITS_PER_TILE;
  const x1 = (tx + fw) * UNITS_PER_TILE;
  const y1 = (ty + fh) * UNITS_PER_TILE;
  const cx = px < x0 ? x0 : px > x1 ? x1 : px;
  const cy = py < y0 ? y0 : py > y1 ? y1 : py;
  return dist2(px, py, cx, cy);
}

/** Nearest point of the rect to (px,py), in units. */
export function closestPointOnRect(
  px: number, py: number, tx: number, ty: number, fw: number, fh: number,
): { x: number; y: number } {
  const x0 = tx * UNITS_PER_TILE;
  const y0 = ty * UNITS_PER_TILE;
  const x1 = (tx + fw) * UNITS_PER_TILE;
  const y1 = (ty + fh) * UNITS_PER_TILE;
  return {
    x: px < x0 ? x0 : px > x1 ? x1 : px,
    y: py < y0 ? y0 : py > y1 ? y1 : py,
  };
}
