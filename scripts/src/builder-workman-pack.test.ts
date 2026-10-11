import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATLAS_PREFIXES, atlasGroupFor, deviceAtlasScale } from '@shardkeep/shared';
import { BUILDER_WORKMAN_COUNTS, BUILDER_WORKMAN_DIR, loadBuilderWorkmanPack, type BuilderWorkmanPack } from './builder-workman-pack.js';
import { buildAtlasBytes, buildMeta, onDemandAtlasScale } from './rasterize.js';

let pack: BuilderWorkmanPack, temporary: string;
beforeAll(async () => { pack = await loadBuilderWorkmanPack(); temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'builder-preflight-')); });
afterAll(async () => { await fs.rm(temporary, { recursive: true, force: true }); });
async function copy(name: string): Promise<string> {
  const dir = path.join(temporary, name);
  await fs.cp(BUILDER_WORKMAN_DIR, dir, { recursive: true });
  return dir;
}
async function replaceSource(dir: string, file: string, bytes: Buffer): Promise<void> {
  await fs.writeFile(path.join(dir, file), bytes);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.files[file] = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('accepted builder workman export', () => {
  it('emits only the 120 occupied native cells with unique keys and a separate lazy atlas', () => {
    expect(BUILDER_WORKMAN_COUNTS).toEqual({ sheets: 1, clips: 3, frames: 120, padding: 16 });
    expect(pack.frames).toHaveLength(120);
    expect(new Set(pack.frames.map((f) => f.key)).size).toBe(120);
    for (const [state, count] of [['idle', 1], ['walk', 8], ['work', 6]] as const) {
      for (let direction = 0; direction < 8; direction++) {
        expect(pack.frames.filter((f) => f.state === state && f.direction === direction).map((f) => f.key))
          .toEqual(Array.from({ length: count }, (_, i) => `builder_${state}_d${direction}_f${i + 1}`));
      }
    }
    expect(pack.frames.every((f) => atlasGroupFor(f.key) === 'builder')).toBe(true);
    expect(ATLAS_PREFIXES).not.toContain('builder');
    expect(onDemandAtlasScale('builder')).toBe(1);
    for (const profile of ['full', 'constrained'] as const) expect(deviceAtlasScale('builder', profile)).toBe(1);
    expect(atlasGroupFor('v2_trp_tunneler_t1_walk_d0_f1')).toBe('v2trp_tunneler_t1_locomotion');
  });

  it('preserves every source pixel and maps horizontal idle facings once without cropping the hammer', async () => {
    const source = await fs.readFile(path.join(BUILDER_WORKMAN_DIR, 'Builder_Workman-Idle.png'));
    for (const frame of pack.frames) {
      const row = frame.state === 'idle' ? 0 : frame.direction + (frame.state === 'walk' ? 1 : 9);
      const col = frame.state === 'idle' ? frame.direction : frame.frame - 1;
      const expected = await sharp(source).extract({ left: col * 84, top: row * 84, width: 84, height: 84 }).ensureAlpha().raw().toBuffer();
      const actual = await sharp(frame.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([actual.info.width, actual.info.height]).toEqual([84, 84]);
      expect(actual.data.equals(expected), frame.key).toBe(true);
    }
  });

  it('publishes direction, timing and pixel anchors through the generic clip sidecar and exact residency table', () => {
    const atlasBytes = buildAtlasBytes([{ group: 'builder', scale: 1, width: 1000, height: 900, decodedBytes: 3_600_000 }]);
    const meta = buildMeta([], [], { manifest: { entries: [], breathStream: null }, frameKeys: [] }, atlasBytes, undefined, [], undefined, [], pack);
    expect(meta.atlases).toEqual(['builder']);
    expect(meta.atlasBytes).toEqual({ builder: 3_600_000 });
    expect(Object.keys(meta.builderClips)).toEqual(['builder_idle', 'builder_walk', 'builder_work']);
    for (const [state, frames, fps, loop] of [['idle', 1, 1, false], ['walk', 8, 10, true], ['work', 6, 8, true]] as const) {
      expect(meta.builderClips[`builder_${state}`]).toEqual({ frames, fps, loop, rows: 8,
        rowOrder: ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'], cellW: 84, cellH: 84, anchorPx: [42, 70] });
    }
    expect(Object.keys(meta.v2Clips)).toEqual([]);
    expect(() => buildAtlasBytes([{ group: 'builder', scale: 2, width: 2, height: 2, decodedBytes: 16 }])).toThrow('exactly one packed @1x');
  });

  it('rejects changed source PNG bytes before any generated files are touched', async () => {
    const dir = await copy('hash');
    await fs.appendFile(path.join(dir, 'Builder_Workman-Idle.png'), 'drift');
    await expect(loadBuilderWorkmanPack(dir)).rejects.toThrow('source hash changed: Builder_Workman-Idle.png');
  });

  it('rejects duplicate or reordered facing rows even when their local hash is updated', async () => {
    const dir = await copy('rows'), file = 'Builder_Workman-Idle.json';
    const layout = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    layout.spritesheet.rows[2].direction = 'south';
    await replaceSource(dir, file, Buffer.from(JSON.stringify(layout)));
    await expect(loadBuilderWorkmanPack(dir)).rejects.toThrow('invalid source row 2');
  });

  it('rejects occupied padding instead of silently discarding new art', async () => {
    const dir = await copy('padding'), file = 'Builder_Workman-Idle.png';
    const bytes = await sharp(path.join(dir, file)).composite([{ input: Buffer.from([1, 2, 3, 255]), raw: { width: 1, height: 1, channels: 4 }, left: 6 * 84, top: 9 * 84 }]).png().toBuffer();
    await replaceSource(dir, file, bytes);
    await expect(loadBuilderWorkmanPack(dir)).rejects.toThrow('nonempty padding at row 9 column 6');
  });

  it('rejects an empty declared facing instead of shipping an invisible worker', async () => {
    const dir = await copy('empty'), file = 'Builder_Workman-Idle.png';
    const raw = await sharp(path.join(dir, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < 84; y++) raw.data.fill(0, y * 672 * 4, (y * 672 + 84) * 4);
    await replaceSource(dir, file, await sharp(raw.data, { raw: { width: 672, height: 1428, channels: 4 } }).png().toBuffer());
    await expect(loadBuilderWorkmanPack(dir)).rejects.toThrow('empty or duplicate frame: builder_idle_d0_f1');
  });
});
