/** Synthetic realm-kit authoring inputs for tests: flat-colour corner-Wang families in
 * the provider's sheet/metadata layout, a few props (one animated), a decal and a path
 * sprite, plus a small layout that exercises every rule. Never an art master; every
 * texel is generated here so a test can mutate one input and watch the builder object. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Kit, Layout } from './realm-kit.js';

const TILE = 32;
type Rgb = [number, number, number];
const COLOURS: Record<string, Rgb> = { turf: [110, 130, 60], meadow: [90, 110, 45], dirt: [150, 100, 60], water: [60, 110, 130], forest: [60, 45, 35], road: [120, 115, 110] };
const mix = (x: number, y: number, salt: number) => ((Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263) ^ salt) >>> 0) % 7 - 3;
export function synthTerrainTexel(terrain: string, x: number, y: number): Rgb {
  const c = COLOURS[terrain]!, n = mix(x, y, 0x9e37);
  return [c[0] + n, c[1] + n, c[2] + n];
}
async function png(width: number, height: number, texel: (x: number, y: number) => [number, number, number, number]): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(texel(x, y), (y * width + x) * 4);
  return sharp(data, { raw: { width, height, channels: 4 } }).png({ palette: false, compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
}
async function writeFamily(dir: string, lower: string, upper: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const tiles = [];
  for (let mask = 0; mask < 16; mask++) tiles.push({ id: `wang_${mask}`, name: `wang_${mask}`, corners: { NW: mask & 8 ? 'upper' : 'lower', NE: mask & 4 ? 'upper' : 'lower', SW: mask & 2 ? 'upper' : 'lower', SE: mask & 1 ? 'upper' : 'lower' },
    bounding_box: { x: (mask % 4) * TILE, y: Math.floor(mask / 4) * TILE, width: TILE, height: TILE }, original_position: { col: mask % 4, row: Math.floor(mask / 4) } });
  const sheet = await png(4 * TILE, 4 * TILE, (x, y) => {
    const mask = Math.floor(y / TILE) * 4 + Math.floor(x / TILE), u = x % TILE, v = y % TILE;
    const bit = v < TILE / 2 ? (u < TILE / 2 ? 8 : 4) : (u < TILE / 2 ? 2 : 1);
    return [...synthTerrainTexel(mask & bit ? upper : lower, u, v), 255];
  });
  await fs.writeFile(path.join(dir, 'sheet.png'), sheet);
  await fs.writeFile(path.join(dir, 'sheet.sha256'), createHash('sha256').update(sheet).digest('hex') + '\n');
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ format: 'tileset15', tile_size: { width: TILE, height: TILE }, tileset_data: { tiles } }));
}
async function writeProp(file: string, size: number, colour: Rgb, inkTop: number, inkBottom: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, await png(size, size, (x, y) => y >= inkTop && y < inkBottom && x >= size / 4 && x < size * 3 / 4 ? [...colour, 255] : [0, 0, 0, 0]));
}
export function synthKit(): Kit {
  return {
    schemaVersion: 1, realmId: 'thornwake', tilePixels: 32, paddingColor: '#6e823c',
    boundary: { kingdom: 'turf', wild: 'meadow', family: 'turf-meadow' },
    terrains: {
      turf: { label: 'turf', kind: 'ground', wild: false, inFrame: true, canonical: { family: 'turf-meadow', side: 'lower' } },
      meadow: { label: 'meadow', kind: 'ground', wild: true, inFrame: true, canonical: { family: 'meadow-dirt', side: 'upper' } },
      dirt: { label: 'dirt', kind: 'ground', wild: true, inFrame: true, canonical: { family: 'meadow-dirt', side: 'lower' }, fallback: 'meadow' },
      shade: { label: 'shade', kind: 'ground', wild: true, inFrame: true, derived: { from: 'meadow', value: 0.85, hue: 0, saturation: 1 }, fallback: 'meadow' },
      water: { label: 'water', kind: 'water', wild: true, inFrame: false, canonical: { family: 'meadow-water', side: 'lower' } },
      forest: { label: 'forest', kind: 'ground', wild: true, inFrame: false, canonical: { family: 'meadow-forest', side: 'upper' }, fallback: 'meadow' },
    },
    families: [
      { id: 'turf-meadow', lower: 'turf', upper: 'meadow', kind: 'wang16', source: 'sources/tilesets/turf-meadow' },
      { id: 'meadow-dirt', lower: 'dirt', upper: 'meadow', kind: 'wang16', source: 'sources/tilesets/meadow-dirt' },
      { id: 'meadow-water', lower: 'water', upper: 'meadow', kind: 'wang16', source: 'sources/tilesets/meadow-water' },
      { id: 'meadow-forest', lower: 'meadow', upper: 'forest', kind: 'wang16', source: 'sources/tilesets/meadow-forest' },
      { id: 'meadow-shade', lower: 'meadow', upper: 'shade', kind: 'tone' },
    ],
    variants: { turf: { transforms: ['identity', 'mirror-x'], jitter: 0.02 }, meadow: { transforms: ['identity', 'mirror-x', 'mirror-y', 'rotate-180'], jitter: 0.02 } },
    water: { canonical: 'water', frames: 4, frameDurationMs: 200, shiftPx: 8, highlightFraction: 0.15 },
    props: [
      { id: 'tree', source: 'sources/props/tree.png', kind: 'tall', footprint: [1, 1] },
      { id: 'rock', source: 'sources/props/rock.png', kind: 'low', footprint: [1, 1] },
      { id: 'pad', source: 'sources/props/pad.png', kind: 'decal', footprint: [1, 1] },
      { id: 'flag', source: 'sources/props/flag.png', kind: 'low', footprint: [1, 1], clip: { source: 'sources/anim/flag/frame_%d.png', frames: 3, frameDurationMs: 150 } },
      { id: 'tower', source: 'sources/props/tower.png', kind: 'tall', footprint: [3, 3] },
    ],
    decals: [{ id: 'dot', source: 'sources/decals/dot.png' }],
    sprites: [{ id: 'bird', sources: ['sources/fx/bird_0.png', 'sources/fx/bird_1.png'], frameDurationMs: 120 }],
    // D-173 creature paths: a four-facing, two-frame walker on 64-px canvases and a swimmer for the lake.
    creatures: [
      { id: 'hare', source: 'sources/creatures/hare/%s_%d.png', directions: 4, frames: 2, frameDurationMs: 120, speed: 40, kind: 'ground' },
      { id: 'duck', source: 'sources/creatures/duck/%s_%d.png', directions: 4, frames: 2, frameDurationMs: 150, speed: 24, kind: 'water' },
    ],
    obstacleSprites: { pine1: { intact: 'tree', remnant: 'rock' }, rock_s: { intact: 'rock', remnant: 'rock' } },
    palette: { ground: { turf: '#6e823c', meadow: '#5a6e2d', dirt: '#96643c', water: '#3c6e82', forest: '#3c2d23' }, accent: ['#1c1716'] },
  };
}
export function synthLayout(): Layout {
  return {
    schemaVersion: 1, seed: 7,
    ops: [
      { op: 'fill', terrain: 'meadow' },
      { op: 'blob', terrain: 'forest', cx: -24, cy: -24, rx: 8, ry: 7, jitter: 0.2 },
      { op: 'blob', terrain: 'water', cx: 52, cy: 52, rx: 8, ry: 7, jitter: 0.2 },
      { op: 'rect', terrain: 'dirt', x0: 50, y0: 20, x1: 56, y1: 24 },
      { op: 'rect', terrain: 'dirt', x0: 43, y0: 50, x1: 47, y1: 54 }, // meets the lake: dirt/water has no family, so dirt collapses to meadow there
      { op: 'blob', terrain: 'shade', cx: 10, cy: 10, rx: 4, ry: 3, jitter: 0.3, over: ['meadow'] },
      { op: 'path', terrain: 'dirt', points: [[-34, 0], [-20, 2]], width: 1, jitter: 0 },
      { op: 'ring', terrain: 'dirt', x0: 40, y0: -30, x1: 48, y1: -24, thickness: 1 },
    ],
    decals: [{ id: 'dots', region: 'field', terrains: ['meadow'], decals: [{ id: 'dot', weight: 1 }], density: 0.1 }],
    scatter: [
      { id: 'trees', region: 'exterior', terrains: ['forest'], props: [{ id: 'tree', weight: 3 }, { id: 'rock', weight: 1 }], density: 30, minGap: 1 },
      { id: 'pads', region: 'exterior', terrains: ['water'], props: [{ id: 'pad', weight: 1 }], density: 10, minGap: 1 },
      // E-6 amended: a grove lattice over the whole field, frame included; the builder keeps it off the legacy plot.
      { id: 'grove', region: 'field', terrains: ['meadow', 'shade'], props: [{ id: 'tree', weight: 2 }, { id: 'rock', weight: 1 }], density: 60, minGap: 1,
        grove: { spacing: 3, jitter: 0.3, clusterTiles: 12, clusterWeight: 0.7 } },
    ],
    place: [
      { prop: 'flag', tx: 20, ty: 46, on: ['meadow'] },
      { prop: 'tower', tx: -22, ty: 30, on: ['meadow'] },
    ],
    paths: [{ id: 'birds', sprite: 'bird', points: [[48, 46], [56, 50], [50, 56]], speed: 40 }],
    roam: [
      // Three hares on the exterior meadow (weights 1 → 3 of one species), five-vertex loops within 4 tiles, a 400 ms pause at each corner.
      { id: 'meadow_hares', region: 'exterior', terrains: ['meadow'], count: 3, radius: 4, vertices: 5, dwellMs: 400, creatures: [{ id: 'hare', weight: 1 }] },
      // Two ducks on the lake's open water.
      { id: 'lake_ducks', region: 'exterior', terrains: ['water'], count: 2, radius: 3, vertices: 4, dwellMs: 0, creatures: [{ id: 'duck', weight: 1 }] },
    ],
  };
}
/** The §2 ring-variant fixture (K-177 "road end"): a grey cobbled road terrain the kingdom's turf
 * meets through a DERIVED `turf-road` family (meadow-road with meadow → turf), layered above the
 * grasses, and a road two vertices wide from the field's south edge into the smallest kingdom
 * (row 20) so every reachable claim's south ring crosses pure road and both road-edge tiles. */
export function synthRoad(kit: Kit, layout: Layout): void {
  kit.terrains.turf!.layer = 1; kit.terrains.meadow!.layer = 1; kit.terrains.dirt!.layer = 2;
  kit.terrains.road = { label: 'road', kind: 'ground', wild: true, inFrame: true, canonical: { family: 'meadow-road', side: 'upper' }, fallback: 'meadow', layer: 3 };
  kit.families.push({ id: 'meadow-road', lower: 'meadow', upper: 'road', kind: 'wang16', source: 'sources/tilesets/meadow-road' },
    { id: 'turf-road', lower: 'turf', upper: 'road', kind: 'derived', from: 'meadow-road', replace: { meadow: 'turf' } });
  kit.palette.ground.road = '#78736e';
  kit.boundary.road = 'road';
  layout.ops.push({ op: 'path', terrain: 'road', points: [[15, 20], [15, 64]], width: 2, jitter: 0 });
}
/** Writes a complete synthetic realm directory and returns its path. */
export async function writeSyntheticRealm(root: string, realm = 'thornwake', kit: Kit = synthKit(), layout: Layout = synthLayout()): Promise<string> {
  const dir = path.join(root, 'art/realm-kit-v1', realm);
  await fs.mkdir(dir, { recursive: true });
  for (const f of kit.families) if (f.kind === 'wang16') await writeFamily(path.join(dir, f.source!), f.lower, f.upper);
  await writeProp(path.join(dir, 'sources/props/tree.png'), 64, [40, 90, 40], 4, 60);
  await writeProp(path.join(dir, 'sources/props/rock.png'), 64, [120, 120, 120], 40, 58);
  await writeProp(path.join(dir, 'sources/props/pad.png'), 64, [60, 140, 60], 52, 62);
  await writeProp(path.join(dir, 'sources/props/flag.png'), 64, [180, 40, 40], 8, 64);
  await writeProp(path.join(dir, 'sources/props/tower.png'), 96, [130, 130, 140], 2, 96);
  for (let k = 0; k < 3; k++) await writeProp(path.join(dir, `sources/anim/flag/frame_${k}.png`), 64, [180, 40 + k * 30, 40], 8, 64);
  await fs.mkdir(path.join(dir, 'sources/decals'), { recursive: true });
  await fs.writeFile(path.join(dir, 'sources/decals/dot.png'), await png(32, 32, (x, y) => (x - 16) ** 2 + (y - 16) ** 2 < 25 ? [230, 230, 200, 255] : [0, 0, 0, 0]));
  // Creature frames: one flat colour per facing (down, left, right, up), a brighter stripe per walk frame,
  // a 24×24 body seated on the bottom row (the README seat contract the builder checks).
  const facingRgb: Record<string, Rgb> = { down: [200, 120, 60], left: [60, 120, 200], right: [60, 200, 120], up: [200, 60, 200] };
  for (const species of ['hare', 'duck']) for (const [facing, rgb] of Object.entries(facingRgb)) for (let k = 0; k < 2; k++) {
    const tint: Rgb = species === 'duck' ? [rgb[0], rgb[1], 255] : rgb;
    await fs.mkdir(path.join(dir, 'sources/creatures', species), { recursive: true });
    await fs.writeFile(path.join(dir, 'sources/creatures', species, `${facing}_${k}.png`), await png(64, 64, (x, y) => y >= 40 - k * 2 && y < 64 - k * 2 && x >= 20 && x < 44 ? [...tint, 255] : [0, 0, 0, 0]));
  }
  await fs.mkdir(path.join(dir, 'sources/fx'), { recursive: true });
  for (let k = 0; k < 2; k++) await fs.writeFile(path.join(dir, `sources/fx/bird_${k}.png`), await png(32, 32, (x, y) => y >= 12 + k * 4 && y < 20 + k * 4 && x >= 8 && x < 24 ? [240, 240, 240, 255] : [0, 0, 0, 0]));
  await fs.writeFile(path.join(dir, 'kit.json'), JSON.stringify(kit, null, 2) + '\n');
  await fs.writeFile(path.join(dir, 'layout.json'), JSON.stringify(layout, null, 2) + '\n');
  return dir;
}
