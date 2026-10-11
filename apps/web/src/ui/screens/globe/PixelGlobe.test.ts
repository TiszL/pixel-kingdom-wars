import { readFileSync } from 'node:fs';
import { GLOBE, WORLD } from '@shardkeep/shared';
import { MAPCHROME } from '../../layout';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createParcelAvatarPool, deedEarthCellLabel, deedHomeBeacon, deedOwnedBeacon, globePinAlpha,
  parcelFallbackProfileInitial, parcelProfileDrawMode, publicProfileInitial,
  parcelAvatarPriority, parcelKeepFrame, parcelKeepWidthPx, selectedCellBounds,
  selectedCellQuadVisible, requestVisibleParcelAvatars, selectedParcelPaintOrder,
  strokeSelectedOutline,
} from './PixelGlobe';
import { bandMix, GLOBE_VIEW, globeBrowseZoomMax } from './globeView';
import { COLORS as C } from '../../primitives';

afterEach(() => vi.useRealTimers());

describe('deed keep silhouettes', () => {
  it('queues visible parcel avatars without requiring a label and prioritises selection', () => {
    const ordinary = {
      key: 'ordinary', layer: 'parcel' as const, lon: 0, lat: 0, r: 4,
      avatarUrl: '/ordinary.webp', mine: false, ring: false, cell: 41,
    };
    const selected = {
      key: 'selected', layer: 'parcel' as const, lon: 0, lat: 0, r: 4,
      avatarUrl: '/selected.webp', mine: false, ring: false, cell: 42,
    };
    const noAvatar = {
      layer: 'parcel' as const, avatarUrl: null, mine: false, ring: false, cell: 43,
    };
    // Neither avatar has a label: network admission follows visible profile art,
    // not the six-label collision budget that previously hid most avatars.
    expect(parcelAvatarPriority(ordinary, 42)).toBe(0);
    expect(parcelAvatarPriority(noAvatar, 42)).toBe(-1);
    const request = vi.fn((_url: string): boolean => true);
    requestVisibleParcelAvatars({ request }, [
      { pin: ordinary, x: 80, y: 80, radius: 10 },
      { pin: selected, x: 90, y: 90, radius: 10 },
    ], 42, { width: 200, height: 200 });
    expect(request.mock.calls.map(([url]) => url))
      .toEqual(['/selected.webp', '/ordinary.webp']);
  });

  it('spends the bounded avatar page on on-canvas profiles nearest the view, not offscreen roster order', () => {
    const pin = (key: string) => ({
      key, layer: 'parcel' as const, lon: 0, lat: 0, r: 4,
      avatarUrl: `/${key}.webp`, mine: false, ring: false, cell: Number(key.slice(1)),
    });
    const offscreen = Array.from({ length: 40 }, (_, i) => ({
      pin: pin(`o${i}`), x: -200 - i, y: 100, radius: 10,
    }));
    const onscreen = Array.from({ length: 40 }, (_, i) => ({
      pin: pin(`v${i}`), x: 100 + i, y: 100, radius: 10,
    }));
    const request = vi.fn((_url: string): boolean => true);

    requestVisibleParcelAvatars(
      { request }, [...offscreen, ...onscreen], null, { width: 400, height: 200 },
    );

    expect(request).toHaveBeenCalledTimes(GLOBE_VIEW.labelMax ** 2);
    expect(request.mock.calls.every(([url]) => String(url).startsWith('/v'))).toBe(true);
    expect(request.mock.calls[0]?.[0]).toBe('/v39.webp');
  });

  it('derives the exact quad for a selected packed cell', () => {
    expect(selectedCellBounds({ cell: 721, cols: 720, rows: 360 })).toEqual({
      west: -179.5, east: -179, north: 89.5, south: 89,
    });
    expect(selectedCellBounds({ cell: -1, cols: 720, rows: 360 })).toBeNull();
  });

  it('paints the selected profile last so its reverse-consumed label wins the budget', () => {
    const pins = [
      { key: 'ordinary-a', layer: 'parcel' as const, cell: 40 },
      { key: 'selected', layer: 'parcel' as const, cell: 42 },
      { key: 'ordinary-b', layer: 'parcel' as const, cell: 41 },
    ];
    const ordered = selectedParcelPaintOrder(pins, 42);

    expect(ordered.map((pin) => pin.key))
      .toEqual(['ordinary-a', 'ordinary-b', 'selected']);
    expect([...ordered].reverse()[0]?.key).toBe('selected');
    expect(selectedParcelPaintOrder(ordered, 42)).toBe(ordered);
  });

  it('outlines selected cells and profiles with ink outside bright gold', () => {
    const strokes: Array<{ colour: string; width: number }> = [];
    const ctx = {
      strokeStyle: '',
      lineWidth: 0,
      stroke() {
        strokes.push({ colour: String(this.strokeStyle), width: this.lineWidth });
      },
    };

    strokeSelectedOutline(ctx, 2);

    expect(strokes).toEqual([
      { colour: C.ink, width: GLOBE_VIEW.parcelPinMin * 2 + 2 },
      { colour: C.goldHi, width: GLOBE_VIEW.parcelPinMin * 2 },
    ]);
  });

  it('withholds a limb-crossing selection unless every quad corner is visible', () => {
    expect(selectedCellQuadVisible([
      { visible: true }, { visible: true }, { visible: true }, { visible: true },
    ])).toBe(true);
    expect(selectedCellQuadVisible([
      { visible: true }, { visible: true }, { visible: false }, { visible: true },
    ])).toBe(false);
  });

  it('deduplicates and bounds avatar loads while authored keeps remain the fallback', () => {
    const images: HTMLImageElement[] = [];
    const started: string[] = [];
    const changed = vi.fn();
    const pool = createParcelAvatarPool(changed, () => {
      const image = {} as HTMLImageElement;
      Object.defineProperty(image, 'src', { set: (url: string) => started.push(url) });
      images.push(image);
      return image;
    }, 2, 4);

    expect(pool.request('/a.webp')).toBe(true);
    expect(pool.request('/a.webp')).toBe(false);
    expect(pool.request('/b.webp')).toBe(true);
    expect(pool.request('/c.webp')).toBe(true);
    expect(started).toEqual(['/a.webp', '/b.webp']);
    expect(pool.ready('/a.webp')).toBeNull();

    images[0]!.onload?.(new Event('load'));
    expect(started).toEqual(['/a.webp', '/b.webp', '/c.webp']);
    expect(pool.ready('/a.webp')).toBe(images[0]);
    images[2]!.onerror?.(new Event('error'));
    expect(pool.ready('/c.webp')).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
    pool.dispose();
  });

  it('retries one transient avatar failure only after the shared map interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T12:00:00.000Z'));
    const images: HTMLImageElement[] = [];
    const started: string[] = [];
    const changed = vi.fn();
    const pool = createParcelAvatarPool(changed, () => {
      const image = {} as HTMLImageElement;
      Object.defineProperty(image, 'src', { set: (url: string) => started.push(url) });
      images.push(image);
      return image;
    });

    expect(pool.request('/avatar.webp')).toBe(true);
    images[0]!.onerror?.(new Event('error'));
    expect(pool.request('/avatar.webp')).toBe(false);
    await vi.advanceTimersByTimeAsync(WORLD.mapPollSec * 1_000 - 1);
    expect(pool.request('/avatar.webp')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(pool.request('/avatar.webp')).toBe(true);
    expect(started).toEqual(['/avatar.webp', '/avatar.webp']);
    images[1]!.onload?.(new Event('load'));
    expect(pool.ready('/avatar.webp')).toBe(images[1]);
    pool.dispose();
  });

  it('drops stale queued work after a pan and starts the newly selected avatar next', () => {
    const images: HTMLImageElement[] = [];
    const started: string[] = [];
    const pool = createParcelAvatarPool(vi.fn(), () => {
      const image = {} as HTMLImageElement;
      Object.defineProperty(image, 'src', { set: (url: string) => started.push(url) });
      images.push(image);
      return image;
    }, 1, 4);

    pool.prioritize(['/old-0.webp', '/old-1.webp', '/old-2.webp', '/old-3.webp']);
    for (let i = 0; i < 4; i++) pool.request(`/old-${i}.webp`);
    expect(started).toEqual(['/old-0.webp']);

    pool.prioritize(['/selected.webp', '/new-1.webp']);
    pool.request('/selected.webp');
    pool.request('/new-1.webp');
    images[0]!.onload?.(new Event('load'));

    expect(started).toEqual(['/old-0.webp', '/selected.webp']);
    expect(started).not.toContain('/old-1.webp');
    pool.dispose();
  });

  it('resolves every public keep level to an authored local-map silhouette', () => {
    expect(parcelKeepFrame(1)).toBe('map_keep_t1');
    expect(parcelKeepFrame(3)).toBe('map_keep_t3');
    expect(parcelKeepFrame(20)).toBe('map_keep_t5');
    expect(parcelKeepFrame(-4)).toBe('map_keep_t1');
    expect(parcelKeepFrame(undefined)).toBeNull();

    // This is the real generated atlas, not a mocked registry: a renamed or
    // missing frame would otherwise silently return the fallback square in prod.
    const atlas = JSON.parse(readFileSync(
      new URL('../../../../public/atlas/map@2x.json', import.meta.url), 'utf8',
    )) as { textures: Array<{ frames: Array<{ filename: string }> }> };
    const names = new Set(atlas.textures[0]?.frames.map((f) => f.filename));
    for (let level = 1; level <= 5; level++) {
      expect(names.has(parcelKeepFrame(level)!)).toBe(true);
    }
  });

  it('bounds real keep art below half a touch target', () => {
    expect(parcelKeepWidthPx(3, 44)).toBeCloseTo(MAPCHROME.tap * 0.4);
    expect(parcelKeepWidthPx(7, 44)).toBeCloseTo(18.48);
    expect(parcelKeepWidthPx(7, 1000)).toBe(21);
    expect(parcelKeepWidthPx(999, 1000)).toBe(MAPCHROME.tap / 2);
  });

  it('renders a named foreign deed as a profile badge at readable scale without inventing an upload', () => {
    const foreign = {
      layer: 'parcel' as const, profileInitial: publicProfileInitial('SHARDLORD_42'),
    };
    expect(parcelFallbackProfileInitial(foreign, MAPCHROME.tap - 1)).toBeNull();
    expect(parcelFallbackProfileInitial(foreign, MAPCHROME.tap)).toBe('S');
    // This precomputed initial remains under a loading or retrying custom image;
    // the draw-mode assertion below pins that the decoded image wins when ready.
    expect(parcelFallbackProfileInitial(foreign, MAPCHROME.tap))
      .toBe('S');
    expect(parcelFallbackProfileInitial({ ...foreign, profileInitial: undefined }, MAPCHROME.tap))
      .toBe('?');
    expect(publicProfileInitial(' 🧙 Mage')).toBe('🧙');
  });

  it('draws a badge while an avatar loads or fails, then the decoded image wins', () => {
    expect(parcelProfileDrawMode('parcel', false, true, true, true)).toBe('badge');
    expect(parcelProfileDrawMode('parcel', true, true, true, true)).toBe('avatar');
    expect(parcelProfileDrawMode('parcel', true, false, false, true)).toBe('keep');
    expect(parcelProfileDrawMode('valley', true, true, true, true)).toBe('none');
  });

  it('keeps only the persistent home deed visible at whole-Earth zoom', () => {

    const home = { layer: 'parcel' as const, persistent: true };
    const neighbour = { layer: 'parcel' as const, persistent: false };
    expect(globePinAlpha(home, bandMix(GLOBE.zoomMin))).toBe(1);
    expect(globePinAlpha(neighbour, bandMix(GLOBE.zoomMin))).toBe(0);
    expect(globePinAlpha(home, bandMix(GLOBE.regionZoom))).toBe(1);
    expect(globePinAlpha(home, bandMix(GLOBE_VIEW.parcelZoom))).toBe(1);
    // It fades only when the whole globe yields to the mounted local map.
    expect(globePinAlpha(home, bandMix(GLOBE.localZoom))).toBe(0);
  });

  it('builds home from the server cell without replacing it with coordinates', () => {
    const beacon = deedHomeBeacon(
      { earthCell: 33132, x: 7, y: 9 },
      { lon: -173.75, lat: 66.75 },
    );
    expect(beacon).toMatchObject({
      key: 'home-33132', layer: 'parcel', cell: 33132,
      lon: -173.75, lat: 66.75, mine: true, persistent: true,
      label: 'YOUR PARCEL · EARTH CELL 33132',
    });
    expect(deedEarthCellLabel('YOUR BASE', 33132)).toBe('YOUR BASE · EARTH CELL 33132');
    expect(beacon.label).not.toMatch(/7\s*,\s*9/);
  });

  it('keeps active and inactive owned bases persistent while only selection pulses', () => {
    // Unnamed on purpose: an unnamed deed is labelled by its address, which is
    // what these assertions read.
    const secondary = deedOwnedBeacon({
      baseId: 'georgia', active: false,
      parcel: { earthCell: 33132, x: 7, y: 9 }, name: '', avatarUrl: null, keepLevel: 1,
    }, { lon: 44.8, lat: 41.7 }, false);
    const selected = deedOwnedBeacon({
      baseId: 'main', active: true,
      parcel: { earthCell: 120, x: 1, y: 2 }, name: '', avatarUrl: null, keepLevel: 1,
    }, { lon: -73.9, lat: 40.7 }, true);

    // WHY: switching to main used to make the newly acquired Georgia deed vanish.
    // Persistence belongs to wallet ownership; pulsing belongs to base selection.
    expect(secondary).toMatchObject({
      key: 'owned-georgia', baseId: 'georgia', active: false,
      owned: true, persistent: true, mine: false, cell: 33132,
      label: 'YOUR INACTIVE BASE · EARTH CELL 33132',
    });
    expect(selected).toMatchObject({
      key: 'owned-main', owned: true, persistent: true, mine: true,
      label: 'SELECTED BASE · EARTH CELL 120',
    });
    expect(globePinAlpha(secondary, bandMix(GLOBE.zoomMin))).toBe(1);
    expect(globePinAlpha(selected, bandMix(GLOBE.zoomMin))).toBe(1);
    // The one-deed Ashfall case stays a private persistent beacon while the
    // public roster unloads/reloads across REGION → PARCEL → REGION.
    expect(globePinAlpha(selected, bandMix(GLOBE.regionZoom))).toBe(1);
    expect(globePinAlpha(selected, bandMix(globeBrowseZoomMax()))).toBe(1);
    expect(globePinAlpha(selected, bandMix(GLOBE.regionZoom))).toBe(1);
  });

  it('wears its owner’s face from the served row and nothing else — "?" only for an empty name (D-097)', () => {
    // WHY: the owner's own base read "?" because the beacon carried no name,
    // avatar or keep level and only borrowed them when the public parcel page
    // happened to include the same cell. /globe me.ownedParcels carries all three
    // (D-096), and the beacon draws them without waiting for anyone else's roster.
    const served = deedOwnedBeacon({
      baseId: 'ashfall', active: true,
      parcel: { earthCell: 28852, x: 13, y: 5 },
      name: 'TORQUEOND', avatarUrl: '/api/avatars/g1.webp', keepLevel: 4,
    }, { lon: 40, lat: 50 }, true);
    expect(served).toMatchObject({
      persistent: true, cell: 28852, keepLevel: 4, avatarUrl: '/api/avatars/g1.webp',
      profileInitial: 'T', label: 'TORQUEOND',
    });
    expect(parcelFallbackProfileInitial(served, MAPCHROME.tap)).toBe('T');
    expect(served.label).not.toContain('?');

    // There is no local override left (D-097): the one-release fallback to the
    // base directory's keep level and the current player's name is gone, so the
    // beacon can never disagree with the server about whose base it is. The
    // function takes the served row, the position and the selection — nothing
    // else — and what it draws is exactly what was served.
    expect(deedOwnedBeacon.length).toBe(3);
    expect(publicProfileInitial('TORQUEOND')).toBe(served.profileInitial);

    // Only a deed whose owner has NO name at all falls back to the neutral mark —
    // and even then the beacon still says whose it is and where.
    const unnamed = deedOwnedBeacon({
      baseId: 'ashfall', active: true,
      parcel: { earthCell: 120, x: 13, y: 5 }, name: '', avatarUrl: null, keepLevel: 1,
    }, { lon: 40, lat: 50 }, true);
    expect(parcelFallbackProfileInitial(unnamed, MAPCHROME.tap)).toBe('?');
    expect(unnamed.label).toBe('SELECTED BASE · EARTH CELL 120');
  });
});
