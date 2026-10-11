import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const PHASE_E_CURRENCY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../art/source/phase-e/currency');
const SIZES = [24, 32, 48, 64] as const;
export interface CurrencyIcon { id: string; png: Buffer }

/** D-153 selects existing candidate 0. Each chip is a native PixelLab render:
 * copy bytes, never resize a 64px inventory icon into a HUD currency glyph.
 * Preflight happens before the raster pipeline clears any generated output. */
export async function loadPhaseECurrency(root = PHASE_E_CURRENCY_DIR): Promise<CurrencyIcon[]> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as {
    schemaVersion: number; selectedCandidate: number; runtimeReady: boolean;
    items: Array<{ id: string; path: string; sha256: string; dimensions: number[]; nativeRaster: boolean }>;
  };
  if (manifest.schemaVersion !== 1 || manifest.selectedCandidate !== 0 || manifest.runtimeReady !== true
    || !Array.isArray(manifest.items) || manifest.items.length !== SIZES.length) {
    throw new Error('Phase E currency manifest is not the admitted four-size set');
  }
  return Promise.all(SIZES.map(async (size) => {
    const id = `gem-${size}`;
    const item = manifest.items.find((entry) => entry.id === id);
    const relative = size === 64 ? 'gem-64.png' : `chips/${id}.png`;
    if (!item || item.path !== relative || item.nativeRaster !== true
      || JSON.stringify(item.dimensions) !== JSON.stringify([size, size])) {
      throw new Error(`Phase E currency native-size contract changed: ${id}`);
    }
    const png = await fs.readFile(path.join(root, relative));
    if (createHash('sha256').update(png).digest('hex') !== item.sha256) {
      throw new Error(`Phase E currency source hash changed: ${id}`);
    }
    const meta = await sharp(png).metadata();
    if (meta.format !== 'png' || meta.width !== size || meta.height !== size || !meta.hasAlpha) {
      throw new Error(`Phase E currency PNG geometry changed: ${id}`);
    }
    return { id, png };
  }));
}

/** Standalone UI icons do not enter the Phaser atlas or change its sprite count. */
export async function emitPhaseECurrency(icons: CurrencyIcon[], output: string): Promise<void> {
  await fs.mkdir(output, { recursive: true });
  await Promise.all(icons.map(({ id, png }) => fs.writeFile(path.join(output, `${id}.png`), png)));
}
