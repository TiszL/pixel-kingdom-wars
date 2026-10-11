/** Cardinal topology and row selection, shared by gameplay and presentation.
 * The accepted wall family retains all 16 mask meanings and the outer-elbow
 * naming convention. Contextual pixels live only on the wallRender subpath;
 * these helpers must stay lightweight because the simulator reaches this file.
 */
import { wallFrameKey } from './wallArt';

export interface WallNeighbors {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
}

/** Family segment chosen from the neighborhood (tier appended by the caller). */
export type WallShape =
  | 'straight'
  | 'ns'
  | 'corner_nw'
  | 'corner_ne'
  | 'corner_sw'
  | 'corner_se'
  // 16-state family (wallfixcon handout, overnight 2026-07-26): the 10 masks
  // that previously substituted a piece with a missing arm now have dedicated
  // masters — no more grass gaps at junctions.
  | 'post'
  | 'end_n' | 'end_e' | 'end_s' | 'end_w'
  | 'tee_n' | 'tee_e' | 'tee_s' | 'tee_w'
  | 'cross';

/**
 * Canonical mask → piece table (wallfixcon/wall-autoconnect.js, ported verbatim;
 * mask = N|E|S|W with N=1 E=2 S=4 W=8). The six legacy mappings are UNCHANGED —
 * including the outer-elbow-quadrant corner naming (a piece with N+E neighbours
 * is the SOUTH-WEST-position elbow; fixed 2026-07-19, preserved by the handout).
 * The other ten masks now select their dedicated batch-11 masters instead of
 * falling back to straight/ns by count and dominant axis.
 */
const SHAPE_BY_MASK: readonly WallShape[] = [
  'post',      //  0  ····  isolated segment
  'end_n',     //  1  N···  run continues north, capped south
  'end_e',     //  2  ·E··  run continues east, capped west
  'corner_sw', //  3  NE··  legacy outer-elbow name
  'end_s',     //  4  ··S·  run continues south, capped north
  'ns',        //  5  N·S·  straight N–S band
  'corner_nw', //  6  ·ES·  legacy outer-elbow name
  'tee_e',     //  7  NES·  N–S run, branch east
  'end_w',     //  8  ···W  run continues west, capped east
  'corner_se', //  9  N··W  legacy outer-elbow name
  'straight',  // 10  ·E·W  straight E–W wall
  'tee_n',     // 11  NE·W  E–W run, branch north
  'corner_ne', // 12  ··SW  legacy outer-elbow name
  'tee_w',     // 13  N·SW  N–S run, branch west
  'tee_s',     // 14  ·ESW  E–W run, branch south
  'cross',     // 15  NESW  4-way junction
];

export function wallShape({ n, e, s, w }: WallNeighbors): WallShape {
  const mask = (n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0);
  return SHAPE_BY_MASK[mask]!;
}

/** Baseline key for portraits/uniform canonical cells; mixed-tier world walls
 * are composed with their eight neighbors by the render-only wallRender path. */
export function wallFrame(neighbors: WallNeighbors, level: number): string {
  return wallFrameKey(level, wallShape(neighbors));
}

/**
 * Build a "is there a wall at (tx,ty)" lookup from a list of wall placements,
 * then resolve every wall's frame. Returns id → sprite key.
 */
export function resolveWallFrames(
  walls: Array<{ id: string; tx: number; ty: number; tier: number }>,
): Map<string, string> {
  const occupied = new Set<string>();
  for (const wll of walls) occupied.add(`${wll.tx},${wll.ty}`);
  const has = (tx: number, ty: number): boolean => occupied.has(`${tx},${ty}`);

  const out = new Map<string, string>();
  for (const wll of walls) {
    out.set(
      wll.id,
      wallFrame(
        {
          n: has(wll.tx, wll.ty - 1),
          e: has(wll.tx + 1, wll.ty),
          s: has(wll.tx, wll.ty + 1),
          w: has(wll.tx - 1, wll.ty),
        },
        wll.tier,
      ),
    );
  }
  return out;
}

/** The existing row selection: the longest contiguous straight run through the
 * tapped wall, with horizontal winning ties. Shared by movement and purchase. */
export function wallRowThrough<T extends { id: string; tx: number; ty: number }>(
  walls: readonly T[], selectedId: string,
): T[] {
  const start = walls.find((wall) => wall.id === selectedId);
  if (!start) return [];
  const at = new Map(walls.map((wall) => [`${wall.tx},${wall.ty}`, wall]));
  const run = (dx: number, dy: number): T[] => {
    const out = [start];
    for (const sign of [1, -1]) {
      let tx = start.tx + sign * dx;
      let ty = start.ty + sign * dy;
      while (at.has(`${tx},${ty}`)) {
        out.push(at.get(`${tx},${ty}`)!); tx += sign * dx; ty += sign * dy;
      }
    }
    return out;
  };
  const horizontal = run(1, 0);
  const vertical = run(0, 1);
  return horizontal.length >= vertical.length ? horizontal : vertical;
}

export interface WallRowUpgradeQuote {
  baseId: string | null;
  selectedWallId: string;
  quoteId: string;
  keepLevel: number;
  walls: Array<{
    id: string; tx: number; ty: number; level: number;
    targetLevel: number | null; costShards: number;
    excluded: 'max_level' | 'keep_level' | 'busy' | null;
  }>;
  totalCostShards: number;
  balanceShards: string;
  canAfford: boolean;
}

export interface WallRowUpgradeResult {
  upgraded: Array<{ id: string; level: number }>;
  costShards: number;
  duplicate: boolean;
}
