import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const WALL_FIVE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/walls-five-tier');
export const WALL_FIVE_SHAPES = ['post', 'end_n', 'end_e', 'corner_sw', 'end_s', 'ns', 'corner_nw', 'tee_e', 'end_w', 'corner_se', 'straight', 'tee_n', 'corner_ne', 'tee_w', 'tee_s', 'cross'] as const;
const HEIGHTS = [44, 48, 52, 56, 60] as const;
type State = 'intact' | 'damaged' | 'collapse';
interface SourceCell {
  path: string; tier: number; state: State; mask?: number;
  width: number; height: number; rows: number; columns: number; frameCells: number;
  anchor: number[]; cell?: number[];
}
export interface WallFiveFrame {
  key: string; family: string; tier: number; shape: string; state: State;
  frame: number; width: number; height: number; png: Buffer;
}
const fail = (message: string): never => { throw new Error(`wall5 preflight: ${message}`); };
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Decode and validate the complete accepted source before generated outputs can
 * be wiped. Frames remain @1x; every renderer applies the same bottom seat. */
export async function loadWallFivePack(root = WALL_FIVE_DIR): Promise<WallFiveFrame[]> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'family/manifest.json'), 'utf8')) as {
    masters: number; frameCells: number; tileSpacing: number; anchor: number[];
    rowOrder: string[]; tierCellHeights: number[]; rendererSha256: string; assets: SourceCell[];
  };
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'provenance.json'), 'utf8')) as { sha256: Record<string, string> };
  if (manifest.masters !== 90 || manifest.frameCells !== 560 || manifest.assets.length !== 90
    || manifest.tileSpacing !== 32 || JSON.stringify(manifest.anchor) !== '[0.5,1]'
    || JSON.stringify(manifest.rowOrder) !== JSON.stringify(WALL_FIVE_SHAPES)
    || JSON.stringify(manifest.tierCellHeights) !== JSON.stringify(HEIGHTS)) fail('accepted manifest contract changed');
  const renderer = await fs.readFile(path.join(root, 'source/walls.mjs'));
  if (sha(renderer) !== manifest.rendererSha256) fail('renderer provenance does not match accepted family');
  for (const name of ['family/manifest.json', 'source/walls.mjs', 'source/export-family.mjs']) {
    if (sha(await fs.readFile(path.join(root, name))) !== provenance.sha256[name]) fail(`source hash changed: ${name}`);
  }
  const frames: WallFiveFrame[] = [], paths = new Set<string>(), keys = new Set<string>();
  for (const entry of manifest.assets) {
    const height = HEIGHTS[entry.tier - 1] ?? fail(`invalid tier: ${entry.tier}`), columns = entry.state === 'intact' ? 1 : entry.state === 'damaged' ? 2 : entry.state === 'collapse' ? 4 : 0;
    const shape = WALL_FIVE_SHAPES[entry.mask ?? -1];
    const expectedPath = entry.state === 'intact' ? `t${entry.tier}/pieces/${shape}.png` : `t${entry.tier}/${entry.state}.png`;
    if (!Number.isInteger(entry.tier) || !height || !columns || (entry.state === 'intact' && !shape)
      || entry.path !== expectedPath || paths.has(entry.path) || entry.width !== 32 * columns || entry.height !== height * (entry.state === 'intact' ? 1 : 16)
      || (entry.state !== 'intact' && JSON.stringify(entry.cell) !== JSON.stringify([32, height]))
      || entry.columns !== columns || entry.rows !== (entry.state === 'intact' ? 1 : 16)
      || entry.frameCells !== entry.rows * columns || JSON.stringify(entry.anchor) !== '[0.5,1]') fail(`invalid source cell: ${entry.path}`);
    paths.add(entry.path);
    const png = await fs.readFile(path.join(root, 'family', entry.path));
    if (sha(png) !== provenance.sha256[`family/${entry.path}`]) fail(`PNG hash changed: ${entry.path}`);
    const raw = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (raw.info.width !== entry.width || raw.info.height !== entry.height) fail(`sheet dimensions: ${entry.path}`);
    for (let row = 0; row < entry.rows; row++) for (let col = 0; col < columns; col++) {
      const piece = entry.state === 'intact' ? shape! : WALL_FIVE_SHAPES[row]!;
      const family = `wall5_t${entry.tier}_${piece}_${entry.state}`, key = `${family}_f${col + 1}`;
      if (keys.has(key)) fail(`duplicate frame ${key}`);
      keys.add(key);
      const cell = await sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: 4 } })
        .extract({ left: col * 32, top: row * height, width: 32, height }).raw().toBuffer();
      let opaque = 0;
      for (let i = 3; i < cell.length; i += 4) {
        if (cell[i] !== 0 && cell[i] !== 255) fail(`non-binary alpha: ${key}`);
        opaque += Number(cell[i] === 255);
      }
      if (!opaque) fail(`empty frame: ${key}`);
      frames.push({ key, family, tier: entry.tier, shape: piece, state: entry.state, frame: col + 1,
        width: 32, height, png: await sharp(cell, { raw: { width: 32, height, channels: 4 } }).png().toBuffer() });
    }
  }
  if (frames.length !== 560) fail(`expected 560 frames, found ${frames.length}`);
  return frames;
}
