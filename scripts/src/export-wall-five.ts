/** Reproducible review exports from the same renderer used by Phaser and deeds.
 * Always writes a new directory. Frozen source packs and deployed output are
 * never export destinations; promotion remains the separate asset-pack process. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  COLLAPSE_DURATION, SHAPES, TIER_HEIGHTS, TILE, captureCollapse,
  composeCollapse, composeWall, drawWalls, type PixelSink, type WallGrid,
} from '@shardkeep/shared/wallRender';
import { WALL_FIVE_DIR } from './wall-five-pack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIRECTIONS = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]] as const;
interface Asset {
  path: string; tier: number; state: 'intact' | 'damaged' | 'collapse'; mask?: number;
  width: number; height: number; rows: number; columns: number; frameCells: number;
}
interface Inventory { masters: number; frameCells: number; assets: Asset[]; [key: string]: unknown }

async function validateDestination(destination: string): Promise<string> {
  if (!destination.trim()) throw new Error('An explicit new export directory is required');
  const target = path.resolve(destination);
  // Resolve the existing ancestry, including symlinked parents, before checking
  // protected roots. Requiring a fresh directory prevents overwriting any file.
  let ancestor = target;
  const missing: string[] = [];
  while (true) {
    try { await fs.lstat(ancestor); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor);
    }
  }
  if (missing.length === 0) throw new Error('Export directory already exists; choose a new destination');
  const canonical = path.join(await fs.realpath(ancestor), ...missing);
  if (canonical.split(path.sep).some(part => /^(?:assets-v[23]|wall-five-pack|public|dist|src|source)$/.test(part) || /(?:rework|handout)/i.test(part))) {
    throw new Error('Export destination is an immutable source or served output path');
  }
  // Any checkout is protected unless the output is explicitly in its ignored
  // review reports. This also covers sibling integration/recovery checkouts.
  for (let current = ancestor; ; current = path.dirname(current)) {
    try {
      await fs.lstat(path.join(current, '.git'));
      if (!canonical.startsWith(path.join(await fs.realpath(current), '.reports') + path.sep)) {
        throw new Error('Export inside a checkout must use its .reports directory');
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current === path.dirname(current)) break;
  }
  return canonical;
}

function neighborhood(tier: number, mask: number, damage = false, damageStage: 1 | 2 = 1): WallGrid {
  const grid = new Map([['0,0', { tier, damage, damageStage }]]);
  for (const [x, y, bit] of DIRECTIONS) if (mask & bit) grid.set(`${x},${y}`, { tier, damage, damageStage });
  return grid;
}

export async function exportWallFive(destination: string): Promise<Inventory> {
  const target = await validateDestination(destination);
  const accepted = JSON.parse(await fs.readFile(path.join(WALL_FIVE_DIR, 'family/manifest.json'), 'utf8')) as Inventory;
  if (accepted.masters !== 90 || accepted.frameCells !== 560 || accepted.assets.length !== 90) {
    throw new Error('Accepted wall inventory changed; review the export contract');
  }
  for (const asset of accepted.assets) {
    const expected = asset.state === 'intact'
      ? `t${asset.tier}/pieces/${SHAPES[asset.mask ?? -1]}.png`
      : `t${asset.tier}/${asset.state}.png`;
    if (asset.path !== expected || !/^t[1-5]\/(?:pieces\/[a-z_]+|damaged|collapse)\.png$/.test(asset.path)) {
      throw new Error('Accepted wall source paths changed; refusing export');
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(target);
  for (const asset of accepted.assets) {
    const height = TIER_HEIGHTS[asset.tier - 1]!;
    const cells: sharp.OverlayOptions[] = [];
    for (let row = 0; row < asset.rows; row++) {
      const mask = asset.mask ?? row;
      const grid = neighborhood(asset.tier, mask);
      const collapse = asset.state === 'collapse' ? captureCollapse(grid, 0, 0)! : null;
      for (let column = 0; column < asset.columns; column++) {
        const frame = collapse
          ? composeCollapse(collapse, column * COLLAPSE_DURATION / (asset.columns - 1))
          : composeWall(neighborhood(asset.tier, mask, asset.state === 'damaged', column === 1 ? 2 : 1), 0, 0)!;
        const png = await sharp(Buffer.from(frame.data), { raw: { width: frame.width, height: frame.height, channels: 4 } })
          .extract({ left: 0, top: frame.height - height, width: TILE, height }).png().toBuffer();
        cells.push({ input: png, left: column * TILE, top: row * height });
      }
    }
    const filename = path.join(target, asset.path);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await sharp({ create: { width: asset.width, height: asset.height, channels: 4, background: '#00000000' } })
      .composite(cells).png().toFile(filename);
  }

  // Keep the accepted ordered-pair and dense-fill specimen layout, while its
  // pixels come exclusively from the current typed world renderer.
  const width = 1800, height = 576, data = Buffer.alloc(width * height * 4);
  let dx = 0, dy = 0;
  const sink: PixelSink = {
    fillStyle: '#000000',
    fillRect(x, y, w, h) {
      const color = Number.parseInt(this.fillStyle.slice(1), 16);
      for (let oy = 0; oy < h; oy++) for (let ox = 0; ox < w; ox++) {
        const px = x + dx + ox, py = y + dy + oy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const i = (py * width + px) * 4;
        data[i] = color >>> 16 & 255; data[i + 1] = color >>> 8 & 255; data[i + 2] = color & 255; data[i + 3] = 255;
      }
    },
  };
  for (let a = 1; a <= 5; a++) for (let b = 1; b <= 5; b++) {
    const column = (a - 1) * 5 + b - 1;
    for (const [row, [nx, ny]] of DIRECTIONS.entries()) {
      dx = column * 72 + (nx < 0 ? 32 : 0); dy = row * 112 + 28 + (ny < 0 ? 32 : 0);
      drawWalls(sink, new Map([['0,0', { tier: a }], [`${nx},${ny}`, { tier: b }]]));
    }
  }
  for (let tier = 1; tier <= 5; tier++) {
    const grid = new Map<string, { tier: number }>();
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.set(`${x},${y}`, { tier });
    dx = (tier - 1) * 144; dy = 448 + 28;
    drawWalls(sink, grid);
  }
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(path.join(target, 'context-specimens.png'));
  const sourceHashes: Record<string, string> = {};
  for (const file of ['wallRender.ts', 'wallArt.ts', 'constants.ts']) {
    sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(ROOT, 'packages/shared/src', file))).digest('hex');
  }
  const manifest: Inventory = {
    ...accepted, version: 3, status: 'local-generated-review', renderer: '@shardkeep/shared/wallRender',
    rendererSha256: sourceHashes['wallRender.ts'], sourceHashes,
    rowOrder: SHAPES, tierCellHeights: TIER_HEIGHTS,
    notes: ['Generated with the same typed compositor used by Phaser and deed images.', 'Source packs and production assets are not modified; promotion requires the asset-pack integration process.'],
  };
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: pnpm --filter @shardkeep/scripts walls:export <new-output-directory>');
  const manifest = await exportWallFive(output);
  console.log(`Exported ${manifest.masters} wall PNGs / ${manifest.frameCells} cells and context specimens to ${path.resolve(output)}`);
}
