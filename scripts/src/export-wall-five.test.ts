import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportWallFive } from './export-wall-five.js';
import { WALL_FIVE_DIR } from './wall-five-pack.js';

let temporary: string;
beforeAll(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wall-five-export-')); });
afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

async function pixels(filename: string) { return sharp(await fs.readFile(filename)).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); }

describe('typed wall export matches accepted pixels without modifying masters', () => {
  it('regenerates all 90 sources / 560 cells and every context specimen from shared wallRender', async () => {
    const output = path.join(temporary, 'fresh');
    const manifest = await exportWallFive(output);
    const accepted = JSON.parse(await fs.readFile(path.join(WALL_FIVE_DIR, 'family/manifest.json'), 'utf8')) as { assets: Array<{ path: string }>; extras: unknown };
    expect(manifest.masters).toBe(90); expect(manifest.frameCells).toBe(560);
    expect(manifest.assets).toEqual(accepted.assets);
    expect(manifest.extras).toEqual(accepted.extras);
    expect(manifest.renderer).toBe('@shardkeep/shared/wallRender');
    for (const filename of [...accepted.assets.map(asset => asset.path), 'context-specimens.png']) {
      const source = await pixels(path.join(WALL_FIVE_DIR, 'family', filename));
      const generated = await pixels(path.join(output, filename));
      expect(generated.info, filename).toEqual(source.info);
      expect(createHash('sha256').update(generated.data).digest('hex'), filename).toBe(createHash('sha256').update(source.data).digest('hex'));
    }
    expect(JSON.parse(await fs.readFile(path.join(output, 'manifest.json'), 'utf8'))).toEqual(manifest);
    await expect(exportWallFive(output)).rejects.toThrow('already exists');
  }, 20_000);

  it('refuses source, public, and symlinked source destinations before creating output', async () => {
    await expect(exportWallFive('')).rejects.toThrow('explicit');
    await expect(exportWallFive(path.join(WALL_FIVE_DIR, 'new-export'))).rejects.toThrow('immutable');
    await expect(exportWallFive(path.join(temporary, 'public/new-export'))).rejects.toThrow('immutable');
    const alias = path.join(temporary, 'master-link');
    await fs.symlink(WALL_FIVE_DIR, alias);
    await expect(exportWallFive(path.join(alias, 'new-export'))).rejects.toThrow('immutable');
    await expect(fs.stat(path.join(WALL_FIVE_DIR, 'new-export'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
