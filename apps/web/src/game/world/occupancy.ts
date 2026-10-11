/**
 * Walkable-tile occupancy for the OWN-BASE ambience layers (owner 2026-07-29:
 * "troops and heroes on base moving under buildings and walls, we should change
 * that — they should be above building or jump over wall or just avoid
 * overflowing on building").
 *
 * The bug was never depth: painter's order (depth = feet Y) is already correct
 * for a walker standing BELOW a structure's base line. It was that villagers,
 * garrison troops and the hero walked STRAIGHT THROUGH footprints — and a
 * walker inside a building is, by that same correct rule, painted underneath it.
 * So the fix is upstream of rendering: walkers never enter an occupied tile.
 *
 * Three rules cover it, deterministically and at zero per-frame allocation cost:
 *  1. every WAYPOINT is pulled out of a footprint before it is used (nearestFree);
 *  2. every LEG is pre-routed (route): a straight line when the ground is clear,
 *     otherwise a real path around the town — and a walker that cannot reach a
 *     stop at all picks another one instead of walking through the wall;
 *  3. every STEP is checked (advance), sliding along an axis rather than
 *     clipping a corner. That is the backstop: whatever the route missed, the
 *     step cannot enter a blocked tile.
 * Walls are just 1×1 blockers here — no hop. A hop needs an arc, a shadow and a
 * landing check to not look worse than the clipping it replaces, and routing
 * around reads fine at these speeds (owner's own "or just avoid overflowing").
 *
 * Deterministic by construction: no clock, no Math.random, no allocation in
 * advance() — the layers' seeded LCGs stay the only source of variation.
 */
import { AMBIENCE, plotBounds } from '@shardkeep/shared';

export interface OccRect { tx: number; ty: number; fw: number; fh: number }
export interface Pt { x: number; y: number }

export class Occupancy {
  private bounds = plotBounds();
  private blocked = new Uint8Array(this.size * this.size);
  private get size(): number { return this.bounds.max - this.bounds.min; }
  get minTile(): number { return this.bounds.min; }
  get maxTile(): number { return this.bounds.max; }
  /** Reused by advance(); callers consume it immediately and must not retain it. */
  private readonly advanced = { x: 0, y: 0, moved: false };
  /**
   * Bumped whenever the occupied set actually CHANGES. The layers put it in
   * their sync signature: waypoints are derived from occupancy, so a building
   * placed/moved/finished must recompute them — and nothing else may, or the
   * walkers would teleport home on every base:refresh (patrol.ts sync notes).
   */
  version = 0;

  /** @param T world px per tile (64). */
  constructor(private T: number) {}

  /** Replace the blocked set. Cheap enough to call on every refresh (900 B). */
  rebuild(rects: ReadonlyArray<OccRect>, plotVersion?: number): void {
    const bounds = plotBounds(plotVersion);
    const changedBounds = bounds.min !== this.bounds.min || bounds.max !== this.bounds.max;
    const N = bounds.max - bounds.min;
    const next = new Uint8Array(N * N);
    for (const r of rects) {
      for (let ty = Math.max(bounds.min, r.ty); ty < Math.min(bounds.max, r.ty + r.fh); ty++) {
        for (let tx = Math.max(bounds.min, r.tx); tx < Math.min(bounds.max, r.tx + r.fw); tx++) {
          next[(ty - bounds.min) * N + tx - bounds.min] = 1;
        }
      }
    }
    this.bounds = bounds;
    if (changedBounds) { this.blocked = next; this.version++; return; }
    for (let i = 0; i < next.length; i++) {
      if (next[i] !== this.blocked[i]) { this.blocked = next; this.version++; return; }
    }
  }

  /** Outside the plot counts as free: nothing is built there, and the walkers'
   *  own waypoints are already clamped to the plot. */
  tileFree(tx: number, ty: number): boolean {
    const { min, max } = this.bounds;
    if (tx < min || ty < min || tx >= max || ty >= max) return true;
    return this.blocked[(ty - min) * this.size + tx - min] === 0;
  }

  /** Is the tile under this FEET position free? Feet, not body: a tall sprite
   *  overlapping the building behind it is correct painter's order, not a clip. */
  free(x: number, y: number): boolean {
    return this.tileFree(Math.floor(x / this.T), Math.floor(y / this.T));
  }

  /** Sampled at a quarter tile — fine enough that no 1×1 wall is stepped over,
   *  and advance() catches whatever a corner clip slips past. */
  clearLine(ax: number, ay: number, bx: number, by: number): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (this.T / 4)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.free(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
    }
    return true;
  }

  /**
   * Pull a waypoint that landed on a footprint out to the nearest free tile,
   * keeping its sub-tile offset (a door stays a door, a ring point stays on its
   * ring). Searched in a fixed ring order so the same town always yields the
   * same stop list. null = buried too deep; the caller drops the waypoint.
   */
  nearestFree(p: Pt, maxTiles = AMBIENCE.walkerDetourSearchTiles): Pt | null {
    if (this.free(p.x, p.y)) return p;
    for (let r = 1; r <= maxTiles; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const q = { x: p.x + dx * this.T, y: p.y + dy * this.T };
          if (this.free(q.x, q.y)) return q;
        }
      }
    }
    return null;
  }

  /**
   * Waypoints for a leg from → to: the straight line when it is clear (the
   * common case, and free), otherwise a real path around whatever is in the
   * way — or null, meaning "you cannot walk there from here", which sends the
   * caller looking for another destination instead of marching through the
   * barracks.
   *
   * WHY a BFS and not the corner/lane heuristics this started as: a base is not
   * open ground with a few boxes on it. It is a WALLED town, and the reference
   * base this was verified on has a wall ring with no gate — from outside it,
   * exactly 4 of 41 building doors are reachable. Heuristics found 1 of them
   * and left Theodor standing on his altar forever, which is the same "the hero
   * is frozen" the layer already carries scar tissue for. A breadth-first walk
   * of a 30×30 grid is COMPLETE (it finds a path whenever one exists), it is a
   * few hundred integer ops on the rare non-straight leg, and it is less code
   * than the special cases it replaced.
   *
   * The tile path is then string-pulled back down to a handful of corners: walk
   * as far along it as clearLine allows, take that point, repeat. Without it the
   * walkers would step tile-by-tile in Manhattan zigzags; with it they cut the
   * diagonal and only turn where something actually blocks them.
   */
  route(fromX: number, fromY: number, to: Pt): Pt[] | null {
    if (this.clearLine(fromX, fromY, to.x, to.y)) return [to];
    const N = this.size, min = this.bounds.min;
    const sx = Math.floor(fromX / this.T) - min;
    const sy = Math.floor(fromY / this.T) - min;
    const gx = Math.floor(to.x / this.T) - min;
    const gy = Math.floor(to.y / this.T) - min;
    if (sx < 0 || sy < 0 || sx >= N || sy >= N || gx < 0 || gy < 0 || gx >= N || gy >= N) return null;
    const start = sy * N + sx;
    const goal = gy * N + gx;
    // -1 = unvisited; otherwise the tile we came from (start points at itself).
    const from = new Int32Array(N * N).fill(-1);
    // The start tile may itself be blocked (a building went up on the walker):
    // walking OUT is always allowed, so it seeds the search regardless.
    const queue = new Int32Array(N * N);
    let head = 0, tail = 0;
    queue[tail++] = start;
    from[start] = start;
    let found = false;
    while (head < tail && !found) {
      const cur = queue[head++]!;
      const cx = cur % N;
      const cy = (cur - cx) / N;
      // fixed neighbour order → the same town always yields the same path
      for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
        const ni = ny * N + nx;
        if (from[ni] !== -1 || this.blocked[ni] === 1) continue;
        from[ni] = cur;
        if (ni === goal) { found = true; break; }
        queue[tail++] = ni;
      }
    }
    if (!found) return null;
    // Tile path back to front, as world points at tile centres; the final
    // waypoint is the caller's exact target (a door sits on a tile EDGE).
    const pts: Pt[] = [to];
    for (let i = from[goal]!; i !== start; i = from[i]!) {
      const tx = i % N;
      pts.push({ x: (tx + min + 0.5) * this.T, y: ((i - tx) / N + min + 0.5) * this.T });
    }
    pts.reverse();
    // String-pull: keep only the points the walker cannot see past.
    const out: Pt[] = [];
    let cx = fromX, cy = fromY, i = 0;
    while (i < pts.length) {
      let take = i;
      for (let j = pts.length - 1; j > i; j--) {
        if (this.clearLine(cx, cy, pts[j]!.x, pts[j]!.y)) { take = j; break; }
      }
      const p = pts[take]!;
      out.push(p);
      cx = p.x; cy = p.y;
      i = take + 1;
    }
    return out;
  }

  /**
   * One frame of movement toward (tx,ty), never landing in a blocked tile.
   * Slides along the dominant axis when the diagonal is pinched (that is what
   * walking along a wall looks like); `moved: false` means genuinely boxed in,
   * and the caller stands a beat and re-routes instead of jittering.
   * A walker that is somehow ALREADY inside a footprint (a building went up on
   * top of it between refreshes) is allowed to walk out.
   */
  advance(x: number, y: number, tx: number, ty: number, step: number): { x: number; y: number; moved: boolean } {
    const dx = tx - x;
    const dy = ty - y;
    const d = Math.hypot(dx, dy);
    if (d <= step) return this.setAdvanced(tx, ty, true);
    const nx = x + (dx / d) * step;
    const ny = y + (dy / d) * step;
    if (this.free(nx, ny) || !this.free(x, y)) return this.setAdvanced(nx, ny, true);
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    const xFirst = Math.abs(dx) >= Math.abs(dy);
    for (let pass = 0; pass < 2; pass++) {
      const useX = pass === 0 ? xFirst : !xFirst;
      const cx = useX ? x + sx * step : x;
      const cy = useX ? y : y + sy * step;
      if ((useX ? sx : sy) !== 0 && this.free(cx, cy)) {
        return this.setAdvanced(cx, cy, true);
      }
    }
    return this.setAdvanced(x, y, false);
  }

  private setAdvanced(x: number, y: number, moved: boolean): typeof this.advanced {
    this.advanced.x = x;
    this.advanced.y = y;
    this.advanced.moved = moved;
    return this.advanced;
  }
}
