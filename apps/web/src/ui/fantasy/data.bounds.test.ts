// fantasyViewportRects with a camera's own visible box (ported from 02e9da84, D-160; used by
// the World v2 realm map, D-186). That camera is not the CPU sphere, so the orthographic
// estimate would miss its ground. Everything the server relies on (D-042: overview
// gate, 8-cell quantum, ≤4096-cell rects, split at the seam) must be unchanged.
import { describe, expect, it } from 'vitest';
import { GLOBE } from '@shardkeep/shared';
import { fantasyViewportRects, type FantasyRect, type FantasyViewBounds } from './data';

const viewport = { width: 390, height: 844 };
const covers = (rects: FantasyRect[], col: number, row: number): boolean => rects.some(r => col >= r.x0 && col <= r.x1 && row >= r.y0 && row <= r.y1);
const cellsOf = (b: FantasyViewBounds): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let lat = b.south; lat <= b.north; lat += 0.25) for (let lon = b.west; lon <= b.east; lon += 0.25) {
    out.push([((Math.floor((lon + 180) * 2) % 720) + 720) % 720, Math.max(0, Math.min(359, Math.floor((90 - lat) * 2)))]);
  }
  return out;
};
const withinLimits = (rects: FantasyRect[]): void => {
  const q = GLOBE.parcelViewportQuantumCells, side = Math.floor(Math.sqrt(GLOBE.parcelViewportMaxCells));
  for (const r of rects) {
    expect((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)).toBeLessThanOrEqual(GLOBE.parcelViewportMaxCells);
    expect(r.x1 - r.x0 + 1).toBeLessThanOrEqual(side);
    expect(r.x0 >= 0 && r.x1 <= 719 && r.y0 >= 0 && r.y1 <= 359).toBe(true);
    expect(r.y0 % q).toBe(0);
  }
};

describe('fantasyViewportRects with a visible-box override', () => {
  it('reads every cell of the box the 3D camera shows, within the D-042 limits', () => {
    const bounds = { west: 10, east: 34, south: -5, north: 12 }, rects = fantasyViewportRects({ lon: 22, lat: 3, zoom: 8 }, { ...viewport, bounds });
    for (const [col, row] of cellsOf(bounds)) expect(covers(rects, col, row), `${col},${row}`).toBe(true);
    withinLimits(rects);
    // The box, not the orthographic disc estimate: nothing far outside it is requested.
    const xs = rects.flatMap(r => [r.x0, r.x1]), ys = rects.flatMap(r => [r.y0, r.y1]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual((10 + 180) * 2 - 2 - GLOBE.parcelViewportQuantumCells);
    expect(Math.max(...xs)).toBeLessThanOrEqual((34 + 180) * 2 + 3 + GLOBE.parcelViewportQuantumCells);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual((90 - 12) * 2 - 2 - GLOBE.parcelViewportQuantumCells);
    expect(Math.max(...ys)).toBeLessThanOrEqual((90 + 5) * 2 + 3 + GLOBE.parcelViewportQuantumCells);
  });

  it('keeps the overview gate: below zoom 5 the layer shows realm totals and reads no parcels', () => {
    expect(fantasyViewportRects({ lon: 22, lat: 3, zoom: 4.9 }, { ...viewport, bounds: { west: 10, east: 34, south: -5, north: 12 } })).toEqual([]);
  });

  it('splits a box that crosses the antimeridian into ordinary indexed ranges', () => {
    const bounds = { west: 170, east: 195, south: 0, north: 20 }, rects = fantasyViewportRects({ lon: 180, lat: 10, zoom: 9 }, { ...viewport, bounds });
    for (const [col, row] of cellsOf(bounds)) expect(covers(rects, col, row)).toBe(true);
    expect(rects.some(r => r.x0 === 0)).toBe(true);
    expect(rects.some(r => r.x1 === 719)).toBe(true);
    withinLimits(rects);
  });

  it('reads every longitude when a pole is on screen', () => {
    const rects = fantasyViewportRects({ lon: 10, lat: 84, zoom: 7 }, { ...viewport, bounds: { west: -170, east: 190, south: 70, north: 90 } });
    for (let col = 0; col < 720; col += 7) expect(covers(rects, col, 0)).toBe(true);
    withinLimits(rects);
  });

  it('falls back to the orthographic estimate when the box is missing or unusable', () => {
    const view = { lon: 26, lat: 23, zoom: 8 }, plain = fantasyViewportRects(view, viewport);
    expect(plain.length).toBeGreaterThan(0);
    for (const bounds of [null, { west: Number.NaN, east: 1, south: 0, north: 1 }, { west: 5, east: 1, south: 0, north: 1 }, { west: 0, east: 1, south: 3, north: 1 }]) {
      expect(fantasyViewportRects(view, { ...viewport, bounds })).toEqual(plain);
    }
  });
});
