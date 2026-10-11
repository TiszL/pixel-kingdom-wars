import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The realm kit leaves most overlay cells EMPTY (index −1) and draws that layer
// over the base (REALM-KIT-PLAN E-7). Phaser 4.1.0's TilemapGPULayer fragment
// shader never made an empty cell transparent: getTileTexelCoord answers texel
// (0, 0) for it and main() samples the tileset there anyway. getColorSamples
// flips y, the sheet is uploaded flipY with REPEAT wrap, so that sample is the
// sheet's BOTTOM-LEFT pixel, painted over every empty cell of every GPU layer.
// Crownlands/Frostveil/Sunscar only looked right because that pixel happened to
// be transparent; Cinderfall's sheet is packed to its last slot (511 of 512),
// the pixel is opaque ash, and 75% of the widest view became one flat colour
// hiding the road, court ring, cinder yard and lava river under it. Any rebuild
// or new realm that fills its sheet's last row breaks the same way. (CLAMP wrap
// is no cure: v = 1.0 then reads the top-left pixel, opaque in every sheet.)
// patches/phaser@4.1.0.patch discards an empty tile's fragment before any
// tileset sample. This reads the installed shader, not a copy of it.
const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve('phaser/package.json'));
const shader = require(join(phaserRoot, 'src/renderer/webgl/shaders/TilemapGPULayer-frag.js')) as string;

/** The body of `void main ()` in a TilemapGPULayer fragment source. */
function mainBody(source: string): string {
  const start = source.indexOf('void main ()');
  expect(start, 'fragment main').toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}', start));
}

describe('Phaser GPU tilemap draws an empty cell transparent, never a tileset pixel', () => {
  it('leaves main() on an empty tile before it samples the tileset', () => {
    const main = mainBody(shader);
    const read = main.indexOf('Tile tile = getLayerData(layerTexCoord);');
    const exit = main.search(/if \(tile\.empty\)\s*\{\s*discard;\s*\}/);
    const sample = main.indexOf('getFinalSamples(');
    expect(read, 'layer read').toBeGreaterThanOrEqual(0);
    expect(exit, 'empty-tile discard in main').toBeGreaterThan(read);
    expect(sample, 'tileset sample').toBeGreaterThan(exit);
  });

  it('ships the same empty-tile discard through the actual ESM and CommonJS exports', () => {
    // Vite imports dist/phaser.esm.js; patching the source module alone would leave the game broken.
    const read = "'    Tile tile = getLayerData(layerTexCoord);',", sample = "'    Samples samples = getFinalSamples(tile, layerTexCoord);',";
    for (const file of ['src/renderer/webgl/shaders/TilemapGPULayer-frag.js', 'dist/phaser.esm.js', 'dist/phaser.js']) {
      const source = readFileSync(join(phaserRoot, file), 'utf8');
      const from = source.indexOf(read), to = source.indexOf(sample, from);
      expect(from, `${file} layer read`).toBeGreaterThanOrEqual(0);
      expect(to, `${file} tileset sample`).toBeGreaterThan(from);
      expect(source.slice(from, to), file).toMatch(/'\s*if \(tile\.empty\)',\s*'\s*\{',\s*'\s*discard;',\s*'\s*\}',/);
    }
  });
});
