import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type Phaser from 'phaser';
import { describe, expect, it } from 'vitest';

// The realm kit animates its water through TilemapGPULayer tile animations
// (REALM-KIT-PLAN E-7). Phaser 4.1.0 wrote each animated tile's ANIMATION
// ORDINAL into the layer data texture while the GPU shader reads that value as
// a TEXEL index (duration at n, frame offset at n + 1) over records two texels
// wide — so every animation after the first resolved through another record's
// frame offset and drew arbitrary tiles (the river rendered as shore fragments).
// patches/phaser@4.1.0.patch stores the texel index (2n). This test drives the
// installed Tileset, not a copy of it.
const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve('phaser/package.json'));
const Tileset = require(join(phaserRoot, 'src/tilemaps/Tileset.js')) as typeof Phaser.Tilemaps.Tileset;

function tilesetWithAnimations(count: number) {
  const tileset = new Tileset('kit', 0, 32, 32, 0, 0, {}, {}, { x: 0, y: 0 });
  tileset.updateTileData(256, 32); // 8 local tiles on one row
  const data = tileset.tileData as Record<number, unknown>;
  for (let n = 0; n < count; n++) {
    const first = n * 2; // animations at local indices 0, 2, 4…; each loops two frames
    data[first] = { animation: [{ tileid: first, duration: 100, startTime: 0 }, { tileid: first + 1, duration: 100, startTime: 100 }], animationDuration: 200 };
  }
  let texels: Uint32Array | undefined;
  const renderer = { createUint8ArrayTexture: (u8: Uint8Array) => { texels = new Uint32Array(u8.buffer); return { destroy() {} }; } };
  const map = tileset.getAnimationDataIndexMap(renderer as never) as Map<number, number>;
  return { map, texels: texels! };
}

describe('Phaser GPU tilemap animation records resolve every animated tile, not only the first', () => {
  it('maps the n-th animated tile to the texel where its own duration record starts', () => {
    const { map, texels } = tilesetWithAnimations(3);
    for (const [tile, texel] of map) {
      // The shader reads duration at `texel` and the frame-pair offset at `texel + 1`.
      expect(texels[texel], `tile ${tile} duration`).toBe(200);
      const frames = texels[texel + 1]!;
      expect(texels[frames], `tile ${tile} first frame duration`).toBe(100);
      expect(texels[frames + 1], `tile ${tile} first frame id`).toBe(tile);
      expect(texels[frames + 3], `tile ${tile} second frame id`).toBe(tile + 1);
    }
    expect([...map.values()]).toEqual([0, 2, 4]);
  });

  it('ships the same corrected index through the actual ESM and CommonJS exports', () => {
    for (const file of ['src/tilemaps/Tileset.js', 'dist/phaser.esm.js', 'dist/phaser.js']) {
      const source = readFileSync(join(phaserRoot, file), 'utf8');
      expect(source, file).toContain('indexToAnimMap.set(i, animations.length * 2);');
      expect(source, file).not.toContain('indexToAnimMap.set(i, animations.length);');
    }
  });
});
