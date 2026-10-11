import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { V2Clip } from './rasterize.js';

export const BUILDER_WORKMAN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/builder-workman');
/** Accepted PixelLab export: one native PNG, three clips, sixteen unused cells. */
export const BUILDER_WORKMAN_COUNTS = { sheets: 1, clips: 3, frames: 120, padding: 16 } as const;
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
const SOURCE_DIRECTIONS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
const CLIPS = { idle: { frames: 1, fps: 1, loop: false }, walk: { frames: 8, fps: 10, loop: true }, work: { frames: 6, fps: 8, loop: true } } as const;
const SOURCE_FILES = ['Builder_Workman-Idle.png', 'Builder_Workman-Idle.json', 'south.png', 'character-metadata.json'];
type State = keyof typeof CLIPS;
export interface BuilderWorkmanFrame { key: string; state: State; direction: number; frame: number; png: Buffer }
export interface BuilderWorkmanPack { frames: BuilderWorkmanFrame[]; clips: Record<string, V2Clip> }
interface LayoutRow { row: number; type: string; frame_count: number; directions?: string[]; direction?: string; animation?: string }
const fail = (message: string): never => { throw new Error(`builder preflight: ${message}`); };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Validate before the pipeline clears output. The horizontal idle export is
 * remapped to eight logical facing rows; authored padding is never a frame. */
export async function loadBuilderWorkmanPack(root = BUILDER_WORKMAN_DIR): Promise<BuilderWorkmanPack> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as {
    version: number; characterId: string; sheet: string; layout: string;
    cellW: number; cellH: number; anchorPx: number[]; sourceScale: number;
    frameIndexBase: number; directions: string[]; clips: typeof CLIPS; files: Record<string, string>;
  };
  if (manifest.version !== 1 || manifest.characterId !== '8ccaa9b2-6743-4522-b1af-ff9c53041de9'
    || manifest.sheet !== SOURCE_FILES[0] || manifest.layout !== SOURCE_FILES[1]
    || manifest.cellW !== 84 || manifest.cellH !== 84 || !same(manifest.anchorPx, [42, 70])
    || manifest.sourceScale !== 1 || manifest.frameIndexBase !== 0
    || !same(manifest.directions, DIRECTIONS) || !same(manifest.clips, CLIPS)
    || !same(Object.keys(manifest.files).sort(), [...SOURCE_FILES].sort())) fail('accepted manifest contract changed');
  const files = new Map<string, Buffer>();
  for (const name of SOURCE_FILES) {
    const bytes = await fs.readFile(path.join(root, name));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]) fail(`source hash changed: ${name}`);
    files.set(name, bytes);
  }
  const layout = JSON.parse(files.get(manifest.layout)!.toString('utf8')) as {
    character: { id: string }; spritesheet: { path: string; cell_size: { width: number; height: number };
      sheet_size: { width: number; height: number }; columns: number; rows: LayoutRow[] };
  };
  const sheet = layout.spritesheet;
  if (layout.character.id !== manifest.characterId || sheet.path !== manifest.sheet
    || !same(sheet.cell_size, { width: 84, height: 84 })
    || !same(sheet.sheet_size, { width: 672, height: 1428 }) || sheet.columns !== 8
    || sheet.rows.length !== 17) fail('sheet layout changed');
  for (let row = 0; row < 17; row++) {
    const entry = sheet.rows[row]!;
    if (entry.row !== row || (row === 0
      ? entry.type !== 'rotations' || entry.frame_count !== 8 || !same(entry.directions, SOURCE_DIRECTIONS)
      : entry.type !== 'animation' || entry.frame_count !== (row <= 8 ? 8 : 6)
        || entry.animation !== (row <= 8 ? 'builder_walk' : 'builder_work')
        || entry.direction !== SOURCE_DIRECTIONS[(row - 1) % 8])) fail(`invalid source row ${row}`);
  }
  const raw = await sharp(files.get(manifest.sheet)!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (raw.info.width !== 672 || raw.info.height !== 1428 || raw.info.channels !== 4) fail('PNG dimensions changed');
  const frames: BuilderWorkmanFrame[] = [], keys = new Set<string>();
  let padding = 0;
  for (let row = 0; row < 17; row++) for (let col = 0; col < 8; col++) {
    const cell = await sharp(raw.data, { raw: { width: 672, height: 1428, channels: 4 } })
      .extract({ left: col * 84, top: row * 84, width: 84, height: 84 }).raw().toBuffer();
    let occupied = false;
    for (let i = 3; i < cell.length; i += 4) if (cell[i] !== 0) { occupied = true; break; }
    if (row >= 9 && col >= 6) {
      if (occupied) fail(`nonempty padding at row ${row} column ${col}`);
      padding++;
      continue;
    }
    const state: State = row === 0 ? 'idle' : row <= 8 ? 'walk' : 'work';
    const direction = row === 0 ? col : (row - 1) % 8, frame = row === 0 ? 1 : col + 1;
    const key = `builder_${state}_d${direction}_f${frame}`;
    if (!occupied || keys.has(key)) fail(`empty or duplicate frame: ${key}`);
    keys.add(key);
    frames.push({ key, state, direction, frame, png: await sharp(cell, { raw: { width: 84, height: 84, channels: 4 } }).png().toBuffer() });
  }
  if (frames.length !== BUILDER_WORKMAN_COUNTS.frames || padding !== BUILDER_WORKMAN_COUNTS.padding) fail('cell count changed');
  return { frames, clips: Object.fromEntries(Object.entries(manifest.clips).map(([state, clip]) => [
    `builder_${state}`, { ...clip, rows: 8, rowOrder: [...manifest.directions], cellW: 84, cellH: 84, anchorPx: [42, 70] },
  ])) };
}
