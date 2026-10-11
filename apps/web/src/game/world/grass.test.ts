/**
 * The 11×11 law is a frozen toroidal farthest-point plan: place 24 variant-2
 * accents and 24 variant-3 accents without cardinal same-variant neighbours,
 * then fill the other 73 cells with the quiet variant 1. This gives the field
 * blue-noise-like spacing without runtime randomness. These tests also reject
 * the old failure mode: a short diagonal translation reproducing every tile.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  addGrassField, GRASS_PERIOD, grassTransformAt, grassVariantAt,
} from './grass';

// Field extents: base = plot 30 + 10-tile skirt each side (BaseScene SKIRT/T),
// battle = plot 30 + 4-tile deploy margin each side (RAID_RULES).
const BASE_FIELD = { corner: -10, size: 50 };
const BATTLE_FIELD = { corner: -4, size: 38 };

describe('baked grass pattern', () => {
  it('keeps both accent variants evenly sparse without cardinal clumps', () => {
    const cells = Array.from({ length: GRASS_PERIOD }, (_, ty) =>
      Array.from({ length: GRASS_PERIOD }, (_, tx) => grassVariantAt(tx, ty)));
    const flat = cells.flat();
    expect(flat.filter((variant) => variant === 1)).toHaveLength(73);
    expect(flat.filter((variant) => variant === 2)).toHaveLength(24);
    expect(flat.filter((variant) => variant === 3)).toHaveLength(24);

    for (const accent of [2, 3]) {
      for (let ty = 0; ty < GRASS_PERIOD; ty++) {
        for (let tx = 0; tx < GRASS_PERIOD; tx++) {
          if (cells[ty]![tx] !== accent) continue;
          expect(cells[ty]![(tx + 1) % GRASS_PERIOD]).not.toBe(accent);
          expect(cells[(ty + 1) % GRASS_PERIOD]![tx]).not.toBe(accent);
        }
      }
    }
  });

  it('uses the whole 11-tile period and rejects every shorter diagonal repeat', () => {
    for (let ty = -10; ty < 40; ty++) {
      for (let tx = -10; tx < 40; tx++) {
        expect(grassVariantAt(tx + GRASS_PERIOD, ty)).toBe(grassVariantAt(tx, ty));
        expect(grassVariantAt(tx, ty + GRASS_PERIOD)).toBe(grassVariantAt(tx, ty));
      }
    }
    for (let shift = 1; shift < GRASS_PERIOD; shift++) {
      let changed = 0;
      for (let ty = 0; ty < GRASS_PERIOD; ty++) {
        for (let tx = 0; tx < GRASS_PERIOD; tx++) {
          if (grassVariantAt(tx, ty) !== grassVariantAt(tx + shift, ty + shift)) changed++;
        }
      }
      // The retired 5×5 linear law changed zero cells under a diagonal shift.
      // Requiring over half to change makes a visible stripe/repeat fail loudly.
      expect(changed).toBeGreaterThan(GRASS_PERIOD * GRASS_PERIOD / 2);
    }
  });

  it('uses all eight seam-safe presentations without a shorter diagonal repeat', () => {
    const transforms = Array.from({ length: GRASS_PERIOD }, (_, ty) =>
      Array.from({ length: GRASS_PERIOD }, (_, tx) => grassTransformAt(tx, ty)));
    expect(new Set(transforms.flat())).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));

    for (let ty = -10; ty < 40; ty++) {
      for (let tx = -10; tx < 40; tx++) {
        expect(grassTransformAt(tx + GRASS_PERIOD, ty)).toBe(grassTransformAt(tx, ty));
        expect(grassTransformAt(tx, ty + GRASS_PERIOD)).toBe(grassTransformAt(tx, ty));
      }
    }
    for (let shift = 1; shift < GRASS_PERIOD; shift++) {
      let changed = 0;
      for (let ty = 0; ty < GRASS_PERIOD; ty++) {
        for (let tx = 0; tx < GRASS_PERIOD; tx++) {
          if (grassTransformAt(tx, ty) !== grassTransformAt(tx + shift, ty + shift)) changed++;
        }
      }
      expect(changed).toBeGreaterThan(GRASS_PERIOD * GRASS_PERIOD / 2);
    }
  });

  it('phases one TileSprite so every field tile samples its world variant', () => {
    for (const { corner, size } of [BASE_FIELD, BATTLE_FIELD]) {
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const phase = ((corner % GRASS_PERIOD) + GRASS_PERIOD) % GRASS_PERIOD;
          expect(grassVariantAt(corner + i, corner + j))
            .toBe(grassVariantAt(phase + i, phase + j));
        }
      }
    }

    const setTilePosition = vi.fn().mockReturnThis();
    const setDepth = vi.fn().mockReturnThis();
    const sprite = {
      setOrigin: vi.fn().mockReturnThis(), setTilePosition, setDepth,
    };
    const tileSprite = vi.fn(() => sprite);
    const scene = {
      textures: { exists: vi.fn(() => true) },
      add: { tileSprite },
    };
    addGrassField(scene as never, BASE_FIELD.corner, BASE_FIELD.size, 64, 0);
    expect(tileSprite).toHaveBeenCalledOnce();
    expect(setTilePosition).toHaveBeenCalledWith(64, 64); // -10 ≡ 1 (mod 11)
  });
});
