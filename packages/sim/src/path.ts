/**
 * path.ts — keg-runner wall selection (GDD §3.2: "sprints to the wall segment
 * that opens the army's shortest path to a building").
 *
 * Contract: Dijkstra over the plot tile grid where a free tile costs 1 and a
 * tile holding a live wall costs SIM_PATHING.wallCost (so paths only cross
 * walls when unavoidable, and prefer crossing the cheapest number of walls).
 * The goal set is every tile adjacent to (or under) the nearest non-wall
 * building. The keg target is the FIRST wall tile along the cheapest path; ties
 * break on lower tile index (y * size + x) so the choice is deterministic.
 *
 * Grid indexes are local to the frozen plot: the caller converts world tiles
 * (including plotVersion 2's signed coordinates) at its boundary. Stable local
 * index ordering preserves the historical tie-break rule.
 */

import { SIM_PATHING } from '@shardkeep/shared';

/** The one wall price the simulator knows (packages/shared/src/constants.ts,
 *  D-099) — re-exported so sim.ts reads the field's own threshold, never a
 *  second literal. */
export const WALL_COST: number = SIM_PATHING.wallCost;

export interface PathGrid {
  size: number; // plot tiles per side
  /** wallIndex[tileIdx] = building array index of a LIVE wall, or -1. */
  wallIndex: Int32Array;
}

export interface KegPathResult {
  /** Building-array index of the wall to detonate, or -1 if no wall blocks the path. */
  wallBuildingIndex: number;
  /** Path tiles from start to goal (inclusive), as tile indexes. */
  path: number[];
}

/**
 * Cheapest-cost field from EVERY tile to the nearest goal tile (cost 1 per free
 * tile, WALL_COST per live wall). `field[i] < WALL_COST` therefore means "tile i
 * can reach a goal without crossing a single wall" — which is exactly the
 * question "is there a way in?".
 *
 * Binary-heap Dijkstra, O(n log n): even the legacy grid is 900 cells, so the O(n²)
 * scan used by kegPath (810k ops) is far too slow to rebuild whenever a wall
 * falls. This runs in ~9k. Fully deterministic: integer costs, fixed N,W,E,S
 * neighbour order, and ties broken on lower tile index inside the heap.
 */
export function costField(grid: PathGrid, goals: Iterable<number>): Int32Array {
  const n = grid.size * grid.size;
  const INF = 0x7fffffff;
  const dist = new Int32Array(n).fill(INF);
  // Binary min-heap of tile indexes keyed on dist, ties → lower index.
  const heap: number[] = [];
  const less = (a: number, b: number): boolean =>
    dist[a] !== dist[b] ? dist[a]! < dist[b]! : a < b;
  const push = (v: number): void => {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };

  for (const g of goals) {
    if (g < 0 || g >= n) continue;
    if (dist[g] !== 0) { dist[g] = 0; push(g); }
  }
  const done = new Uint8Array(n);
  while (heap.length > 0) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    const ux = u % grid.size;
    const uy = (u - ux) / grid.size;
    const neigh = [
      uy > 0 ? u - grid.size : -1,
      ux > 0 ? u - 1 : -1,
      ux < grid.size - 1 ? u + 1 : -1,
      uy < grid.size - 1 ? u + grid.size : -1,
    ];
    for (const v of neigh) {
      if (v < 0 || done[v]) continue;
      // Cost is paid to ENTER v, so a goal tile behind a wall still reports the
      // wall's cost to anyone outside it.
      const nd = dist[u]! + (grid.wallIndex[v]! >= 0 ? WALL_COST : 1);
      if (nd < dist[v]!) { dist[v] = nd; push(v); }
    }
  }
  return dist;
}

/**
 * Cheapest path from start tile to any goal tile; returns the first wall on it.
 * goals: set of tile indexes considered "arrived".
 */
export function kegPath(grid: PathGrid, startIdx: number, goals: Set<number>): KegPathResult {
  const n = grid.size * grid.size;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[startIdx] = 0;

  for (;;) {
    // O(n) extract-min; lower indexes win equal costs, preserving replay ties.
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u === -1) break;
    done[u] = 1;
    if (goals.has(u)) {
      // Reconstruct, find first wall tile.
      const path: number[] = [];
      for (let v = u; v !== -1; v = prev[v]!) path.push(v);
      path.reverse();
      for (const idx of path) {
        const w = grid.wallIndex[idx]!;
        if (w >= 0) return { wallBuildingIndex: w, path };
      }
      return { wallBuildingIndex: -1, path };
    }
    const ux = u % grid.size;
    const uy = Math.floor(u / grid.size);
    // 4-neighborhood, fixed order N,W,E,S for determinism.
    const neigh = [
      uy > 0 ? u - grid.size : -1,
      ux > 0 ? u - 1 : -1,
      ux < grid.size - 1 ? u + 1 : -1,
      uy < grid.size - 1 ? u + grid.size : -1,
    ];
    for (const v of neigh) {
      if (v < 0 || done[v]) continue;
      const cost = grid.wallIndex[v]! >= 0 ? WALL_COST : 1;
      const nd = dist[u]! + cost;
      if (nd < dist[v]!) {
        dist[v] = nd;
        prev[v] = u;
      }
    }
  }
  return { wallBuildingIndex: -1, path: [] };
}
