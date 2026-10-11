import { describe, expect, it } from 'vitest';
import {
  GRASS_COLORS, GRASS_PERIOD_CELLS, GRASS_TILE_BACKGROUND, GRASS_TILE_SVG,
  grassCellCssSize, grassSpeckle,
} from './grassWellLogic';

describe('Android drawGrassWell presentation pattern', () => {
  it('preserves the sampled native grass and bottom-band colours', () => {
    expect(GRASS_COLORS).toEqual({ face: '#3F6A35', light: '#4D7B3F', dark: '#345A2C', band: '#2C4C25' });
  });

  it('pins native low-byte hash cells at both colour thresholds', () => {
    // Native hashes on row zero: 0, 19, 20, 35 and 36 respectively.
    expect(grassSpeckle(0, 0)).toBe('light');
    expect(grassSpeckle(47, 0)).toBe('light');
    expect(grassSpeckle(36, 0)).toBe('dark');
    expect(grassSpeckle(127, 0)).toBe('dark');
    expect(grassSpeckle(116, 0)).toBeNull();
  });

  it('includes the native y hash instead of repeating the first row', () => {
    expect(grassSpeckle(0, 1)).toBeNull();
    expect(grassSpeckle(7, 0)).toBeNull();
    expect(grassSpeckle(7, 1)).toBe('dark');
    expect(grassSpeckle(252, 1)).toBe('light');
  });

  it('tiles at exactly 256 cells on each axis without changing boundary cells', () => {
    expect(GRASS_PERIOD_CELLS).toBe(256);
    for (const [x, y] of [[0, 0], [7, 1], [47, 0], [36, 0], [255, 255]]) {
      expect(grassSpeckle(x! + 256, y!)).toBe(grassSpeckle(x!, y!));
      expect(grassSpeckle(x!, y! + 256)).toBe(grassSpeckle(x!, y!));
    }
    expect(grassSpeckle(256, 0)).toBe('light');
    expect(grassSpeckle(0, 256)).toBe('light');
  });

  it('keeps the native sparse accent coverage on every sampled row', () => {
    for (const y of [0, 1, 127, 255]) {
      const cells = Array.from({ length: 256 }, (_, x) => grassSpeckle(x, y));
      expect(cells.filter((cell) => cell === 'light')).toHaveLength(20);
      expect(cells.filter((cell) => cell === 'dark')).toHaveLength(16);
      expect(cells.filter((cell) => cell == null)).toHaveLength(220);
    }
  });

  it('rounds cells to whole device pixels as Android does at fractional density', () => {
    expect(grassCellCssSize(1)).toBe(2);
    expect(grassCellCssSize(2)).toBe(2);
    expect(grassCellCssSize(3)).toBe(2);
    expect(grassCellCssSize(1.25)).toBe(2.4);
    expect(grassCellCssSize(0.75)).toBeCloseTo(8 / 3);
    expect(grassCellCssSize(0)).toBe(2);
  });

  it('uses one bounded pixel tile with exactly the native light and dark coverage', () => {
    expect(GRASS_TILE_SVG).toContain('viewBox="0 0 256 256"');
    expect(GRASS_TILE_SVG).toContain('shape-rendering="crispEdges"');
    expect(GRASS_TILE_SVG).toContain('fill="#3F6A35"');
    const paths = [...GRASS_TILE_SVG.matchAll(/<path fill="([^"]+)" d="([^"]*)"\/>/g)];
    expect(paths).toHaveLength(2);
    expect(paths[0]![1]).toBe('#4D7B3F');
    expect(paths[1]![1]).toBe('#345A2C');
    expect(paths[0]![2]!.match(/M/g)).toHaveLength(5120);
    expect(paths[1]![2]!.match(/M/g)).toHaveLength(4096);
    expect(paths[0]![2]).toContain('M0 0h1v1h-1z');
    expect(paths[1]![2]).toContain('M3 0h1v1h-1z');
  });

  it('embeds the static tile directly without an image fetch or animation', () => {
    expect(GRASS_TILE_BACKGROUND).toBe(`url("data:image/svg+xml,${encodeURIComponent(GRASS_TILE_SVG)}")`);
    expect(GRASS_TILE_SVG).not.toMatch(/<(?:image|script|animate)\b|href=/);
  });
});
