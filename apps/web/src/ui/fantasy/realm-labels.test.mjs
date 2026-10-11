import { describe, expect, it, vi } from 'vitest';
import { layoutRealmLabels, realmNavigationIndex } from './runtime/realm-labels.mjs';
import { RAD, REGIONS } from './runtime/world.mjs';
import { createFantasyRenderer } from './runtime/renderer.mjs';

const crown = REGIONS.find(realm => realm.id === 'crownlands');
const camera = { lon: crown.lon * RAD, lat: crown.lat * RAD, zoom: 1 };
const box = label => ({ left: label.x - label.width / 2, right: label.x + label.width / 2,
  top: label.y - label.height / 2, bottom: label.y + label.height / 2 });
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('realm labels yield to parcel touch targets', () => {
  it('applies exclusions to the renderer current camera without rasterizing the terrain again', () => {
    const ctx = { createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      clearRect: vi.fn(), putImageData: vi.fn() };
    const canvas = () => ({ width: 140, height: 200, getContext: () => ctx });
    const renderer = createFantasyRenderer({ canvas: canvas(), cloudCanvas: canvas(), effectCanvas: canvas(),
      read: () => new Promise(() => {}), resolveTile: () => null, invalidate: () => {}, onError: () => {} });
    renderer.draw({ lon: crown.lon, lat: crown.lat, zoom: 1 });
    const index = REGIONS.indexOf(crown), before = renderer.realmLabels()[index];
    const occupied = { left: 48, right: 92, top: 78, bottom: 122 };
    expect(overlaps(box(before), occupied)).toBe(true);
    const after = renderer.realmLabels({ exclude: [occupied] })[index];
    expect(after).not.toBeNull(); expect(overlaps(box(after), occupied)).toBe(false);
    expect(ctx.putImageData).toHaveBeenCalledOnce(); expect(renderer.stats().frames).toBe(1);
    renderer.dispose();
  });
  it.each([44, 72, 176])('moves Crownlands clear of a %dpx keep target without moving its geographic anchor', markerWidth => {
    const occupied = { left: 200 - markerWidth / 2, right: 200 + markerWidth / 2, top: 178, bottom: 222 };
    const options = { sizes: [{ width: 118, height: 28 }], selectedIndex: 0 };
    const [before] = layoutRealmLabels([crown], camera, 176, options);
    expect(overlaps(box(before), occupied)).toBe(true);
    const [after] = layoutRealmLabels([crown], camera, 176, { ...options, exclude: [occupied] });
    expect(after).not.toBeNull();
    expect(overlaps(box(after), occupied)).toBe(false);
    expect([after.anchorX, after.anchorY]).toEqual([before.anchorX, before.anchorY]);
    expect(layoutRealmLabels([crown], camera, 176, { ...options, exclude: [occupied] })[0]).toEqual(after);
  });

  it.each([[390, 844], [844, 320], [1440, 900]])('keeps all visible labels inside the clear HUD bounds at %d×%d', (width, height) => {
    const bounds = { left: 6, top: height * .3, right: width - 6, bottom: height - 64 };
    const x = width / 2, y = (bounds.top + bounds.bottom) / 2;
    const exclude = [{ left: x - 88, right: x + 88, top: y - 22, bottom: y + 22 }];
    const labels = layoutRealmLabels(REGIONS, camera, Math.min(width, height) * .44, {
      width, height, centerX: x, centerY: y, bounds, exclude,
      sizes: REGIONS.map(realm => ({ width: realm.name.length * 10 + 18, height: 32 })),
      selectedIndex: REGIONS.indexOf(crown),
    });
    const visible = labels.filter(Boolean).map(box);
    expect(visible.length).toBeGreaterThan(0);
    for (const b of visible) {
      expect(b.left).toBeGreaterThanOrEqual(bounds.left); expect(b.right).toBeLessThanOrEqual(bounds.right);
      expect(b.top).toBeGreaterThanOrEqual(bounds.top); expect(b.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(overlaps(b, exclude[0])).toBe(false);
      expect(visible.some(other => other !== b && overlaps(b, other))).toBe(false);
    }
  });

  it('hides a crowded label instead of covering a selected deed, without removing the realm from navigation', () => {
    const bounds = { left: 20, top: 175, right: 380, bottom: 225 };
    const exclude = [{ left: 112, right: 288, top: 178, bottom: 222 }];
    const labels = layoutRealmLabels([crown], camera, 176, { bounds, exclude, sizes: [{ width: 118, height: 28 }] });
    expect(labels).toEqual([null]);
    const crownIndex = REGIONS.indexOf(crown);
    expect(REGIONS[realmNavigationIndex(crownIndex - 1, 'ArrowRight', REGIONS.length)]).toBe(crown);
  });
});
