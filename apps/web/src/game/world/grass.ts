/**
 * Baked grass field. The old linear 5×5 law repeated on every short diagonal,
 * making the ground read as a stamped pattern. This fixed 11×11 toroidal mask
 * was produced by deterministic farthest-point placement: 24 cells of each
 * accent variant are spaced first, then variant 1 fills the remaining 73 cells.
 * There is no runtime randomness and grass.test.ts pins the distribution,
 * spacing, period and field alignment.
 *
 * Phaser 4 does no camera culling, so the mask is still baked once into one
 * CanvasTexture and each scene draws exactly ONE TileSprite instead of thousands
 * of per-tile Images. The TileSprite's texture phase aligns that shared bake to
 * its world-space corner; unlike the former diagonal-invariant formula, the new
 * irregular mask deliberately changes under a diagonal shift.
 */
import type Phaser from 'phaser';
import { frameTexelRect } from './atlasTexels';

export const GRASS_PERIOD = 11;

const GRASS_MASK = [
  '12121131121',
  '21113211313',
  '11311111211',
  '32121123132',
  '11131311211',
  '13213132113',
  '21111213131',
  '11231311213',
  '13112121121',
  '11211131132',
  '31131212111',
] as const;

const positiveMod = (value: number, modulus: number): number =>
  ((value % modulus) + modulus) % modulus;

/** Grass variant (1|2|3 → tile_grass_N frame) at a world tile coordinate. */
export function grassVariantAt(tx: number, ty: number): number {
  const x = positiveMod(tx, GRASS_PERIOD);
  const y = positiveMod(ty, GRASS_PERIOD);
  return GRASS_MASK[y]!.charCodeAt(x) - 48;
}

/**
 * Dihedral transform (quarter-turn 0..3, plus optional horizontal flip) for
 * each baked world tile. The old renderer repeated every master at exactly the
 * same orientation, so even an irregular variant mask still exposed each
 * sprite's internal motif. Keeping this transform toroidal with the same
 * 11-tile period preserves the single-CanvasTexture architecture while giving
 * the seam-locked square terrain eight deterministic presentations.
 */
export function grassTransformAt(tx: number, ty: number): number {
  const x = positiveMod(tx, GRASS_PERIOD);
  const y = positiveMod(ty, GRASS_PERIOD);
  return (x * 31 + y * 17 + x * y * 7) & 7;
}

const KEY = 'grass-baked-11';

/**
 * Add the full grass field as ONE TileSprite at `depth` (origin at diagonal
 * tile (cornerTile, cornerTile)), baking the 11×11 pattern into a shared
 * CanvasTexture on first use. The tile_grass_* frames are native 64×64 and
 * untrimmed (tile@2x.json), so the stamps land pixel-identical to the old
 * per-tile Images' setDisplaySize(T, T). The texture is game-global — the
 * battle scene reuses the base scene's bake across its scene restarts.
 */
export function addGrassField(
  scene: Phaser.Scene,
  cornerTile: number,
  sizeTiles: number,
  tilePx: number,
  depth: number,
): void {
  if (!scene.textures.exists(KEY)) {
    // A plain CanvasTexture, NOT a DynamicTexture. In Phaser 4.1's rewritten
    // renderer, DynamicTexture.stamp() and .draw() silently paint NOTHING — the
    // texture stays fully transparent, no error, no warning — which shipped as
    // "we removed the land texture" (owner, 2026-07-31): the TileSprite was
    // present, visible and correctly sized, sampling an empty texture, and the
    // flat green underneath read as intentional art direction. Verified live in
    // the running game: runtime stamp() and draw() calls both no-oped, while
    // this canvas path rendered correctly — including the part that was in real
    // doubt, a WebGL TileSprite repeating a non-power-of-two (704px) texture.
    const ct = scene.textures.createCanvas(
      KEY, GRASS_PERIOD * tilePx, GRASS_PERIOD * tilePx,
    );
    const atlas = scene.textures.get('tile');
    const src = atlas.getSourceImage() as CanvasImageSource;
    const ctx = ct?.getContext();
    if (ct && ctx) {
      for (let j = 0; j < GRASS_PERIOD; j++) {
        for (let i = 0; i < GRASS_PERIOD; i++) {
          const f = atlas.get(`tile_grass_${grassVariantAt(i, j)}`);
          const texel = frameTexelRect(atlas, f);
          const transform = grassTransformAt(i, j);
          const quarterTurns = transform & 3;
          const flipX = transform >= 4;
          // Rotate/flip around the cell centre. Frames are square, native,
          // untrimmed and share a one-pixel neutral edge, so all eight
          // presentations remain pixel-sharp and join without a tile seam.
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          ctx.translate((i + 0.5) * tilePx, (j + 0.5) * tilePx);
          ctx.rotate(quarterTurns * Math.PI / 2);
          if (flipX) ctx.scale(-1, 1);
          ctx.drawImage(src, texel.x, texel.y, texel.w, texel.h,
            -tilePx / 2, -tilePx / 2, tilePx, tilePx);
          ctx.restore();
        }
      }
      ct.refresh(); // upload the canvas to the GPU once
    }
  }
  const phasePx = positiveMod(cornerTile, GRASS_PERIOD) * tilePx;
  scene.add
    .tileSprite(
      cornerTile * tilePx,
      cornerTile * tilePx,
      sizeTiles * tilePx,
      sizeTiles * tilePx,
      KEY,
    )
    .setOrigin(0, 0)
    .setTilePosition(phasePx, phasePx)
    .setDepth(depth);
}
