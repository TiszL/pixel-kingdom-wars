/**
 * Precomputed terrain field for the map boards.
 *
 * THE COST THIS REMOVES: `spriteAt` is cheap per call but the boards called it
 * per tile PER POINTERMOVE, and for a water tile it fans out to five `genTile`
 * calls through `shoreAt` — on the water-heavy campaign grid that was ~870
 * extra `genTile` calls in every frame of a drag, for a result that cannot
 * change while the camera moves. The letters depend only on (terrain, land
 * override), so they are baked ONCE per valley into a flat typed array and the
 * pan becomes an index lookup.
 *
 * mapTerrain.ts stays the SINGLE source of tile letters — this file only calls
 * it — so mapTerrain.test.ts still pins what is actually drawn.
 */
import { spriteAt, type Terrain } from './screens/mapTerrain';

export interface TileField {
  /** WORLD-tile coordinate of the field's top-left cell. */
  x0: number; y0: number;
  cols: number; rows: number;
  /** Index into `frames`, row-major over cols×rows. */
  idx: Uint16Array;
  /** Deduplicated frame names — typically ~40 for a whole board. */
  frames: string[];
}

/**
 * Bake every tile the camera can reach into (idx, frames).
 *
 * `ox/oy` offset the AUTHORED grid inside the server's world grid (the world
 * board centres a 12×20 authored valley inside a 25×20 server grid), so the
 * field is addressed in world-tile coordinates while `spriteAt` and the `land`
 * override keys stay in authored-grid coordinates — exactly as before.
 */
export function bakeTileField(
  t: Terrain, ox: number, oy: number,
  x0: number, y0: number, cols: number, rows: number,
  land?: ReadonlySet<string>,
): TileField {
  const idx = new Uint16Array(Math.max(0, cols * rows));
  const frames: string[] = [];
  const seen = new Map<string, number>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const name = spriteAt(t, x0 + c - ox, y0 + r - oy, land);
      let i = seen.get(name);
      if (i === undefined) { i = frames.length; frames.push(name); seen.set(name, i); }
      idx[r * cols + c] = i;
    }
  }
  return { x0, y0, cols, rows, idx, frames };
}

/** Frame name at a WORLD-tile coordinate, or null outside the baked field.
 *  The camera is clamped inside the field, so null means "nothing to draw". */
export function tileFrameIndex(f: TileField, gx: number, gy: number): number {
  const c = gx - f.x0, r = gy - f.y0;
  if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return -1;
  return f.idx[r * f.cols + c]!;
}
