/** @vitest-environment happy-dom */
import { GLOBE, WORLD } from '@shardkeep/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEG_TO_RAD, RAD_TO_DEG, unprojectDeg } from '@shardkeep/shared/globe';
import { ApiError, api } from '../../../lib/api';
import {
  exactViewportOmitsCell, prioritizeViewportMarkers, retainedSelectedViewportMarker, toRows, useValleyParcels,
  useViewportParcels, viewportMarkers, viewportResponseMatchesScope, visibleParcelBounds, visibleParcelCentre,
  type ValleyParcels, type ViewportParcelBounds, type ViewportParcelMarker,
  type ViewportParcels,
} from './parcels';
import { GLOBE_VIEW, navCamera, radiusPx } from './globeView';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const canonicalAvatar = '/api/avatars/123e4567-e89b-42d3-a456-426614174000.webp';

function expectBounded(rects: readonly ViewportParcelBounds[]): void {
  expect(rects.length).toBeLessThanOrEqual(GLOBE.parcelViewportMaxRequests);
  let total = 0;
  for (const rect of rects) {
    const width = rect.x1 - rect.x0 + 1;
    const height = rect.y1 - rect.y0 + 1;
    expect(rect.x0).toBeGreaterThanOrEqual(0);
    expect(rect.x1).toBeLessThan(GLOBE.fineCols);
    expect(rect.y0).toBeGreaterThanOrEqual(0);
    expect(rect.y1).toBeLessThan(GLOBE.fineRows);
    expect(width).toBeLessThanOrEqual(GLOBE.parcelViewportMaxSpanCells);
    expect(height).toBeLessThanOrEqual(GLOBE.parcelViewportMaxSpanCells);
    expect(width * height).toBeLessThanOrEqual(GLOBE.parcelViewportMaxCells);
    total += width * height;
  }
  expect(total).toBeLessThanOrEqual(
    GLOBE.parcelViewportMaxCells * GLOBE.parcelViewportMaxRequests,
  );
}

describe('bounded visible fine-grid scopes', () => {
  it.each([
    ['phone portrait', { width: 390, height: 844 }],
    ['canonical mobile landscape', { width: 915, height: 311 }],
  ])('covers the complete readable %s camera with at most two valid requests', (_name, viewport) => {
    const rects = visibleParcelBounds({
      lam0: 0.4, phi0: 0.35, zoom: GLOBE_VIEW.parcelZoom,
    }, viewport);
    expectBounded(rects);
    expect(rects.length).toBeGreaterThan(0);
    expect(rects.length).toBeLessThanOrEqual(2);
  });

  it('splits an antimeridian camera into ordinary non-wrapping requests', () => {
    const rects = visibleParcelBounds({
      lam0: 179 * Math.PI / 180, phi0: 0, zoom: GLOBE_VIEW.parcelZoom,
    }, { width: 390, height: 844 });
    expectBounded(rects);
    expect(rects.some((rect) => rect.x0 === 0)).toBe(true);
    expect(rects.some((rect) => rect.x1 === GLOBE.fineCols - 1)).toBe(true);
    expect(rects.every((rect) => rect.x0 <= rect.x1)).toBe(true);
  });

  it('caps the polar preload and keeps the camera-centre tile first', () => {
    // At the ±80° clamp longitudes converge, so even the exact window (D-097)
    // spans more columns than the D-042 request budget can tile at the first
    // fetch band — the budget binds, nearest-first, and the tile under the camera
    // is always the first one asked for.
    const nav = {
      lam0: 0,
      phi0: GLOBE_VIEW.phiMaxDeg * Math.PI / 180,
      zoom: GLOBE_VIEW.parcelZoom - GLOBE_VIEW.fade,
    };
    const rects = visibleParcelBounds(nav, { width: 915, height: 311 });
    expectBounded(rects);
    expect(rects).toHaveLength(GLOBE.parcelViewportMaxRequests);
    const centreX = GLOBE.fineCols / 2;
    const centreY = Math.floor(
      (90 - GLOBE_VIEW.phiMaxDeg) / (180 / GLOBE.fineRows),
    );
    expect(rects[0]!.x0).toBeLessThanOrEqual(centreX);
    expect(rects[0]!.x1).toBeGreaterThanOrEqual(centreX);
    expect(rects[0]!.y0).toBeLessThanOrEqual(centreY);
    expect(rects[0]!.y1).toBeGreaterThanOrEqual(centreY);
  });

  it('requests the EXACT visible window, not the circumscribing cap (D-097)', () => {
    // WHY: the spherical cap around the rectangle's half-diagonal asked for up to
    // 4× the ground on screen. On a planet heading for 59,000 bases that over-ask
    // is exactly what the server's marker cap would spend itself on, and the
    // nearest-first page would then be nearest to a centre of ground nobody can
    // see. The bounds must enclose every edge of the window — checked through the
    // same inverse projection the tap handler uses — and stop within one quantum
    // plus the one cell of slack of it.
    const nav = { lam0: 0.4, phi0: 0.35, zoom: GLOBE_VIEW.parcelZoom };
    const viewport = { width: 390, height: 844 };
    const rects = visibleParcelBounds(nav, viewport);
    expectBounded(rects);
    const cam = navCamera(nav, viewport.width, viewport.height);
    const dLon = 360 / GLOBE.fineCols;
    const dLat = 180 / GLOBE.fineRows;
    const cellOf = (lon: number, lat: number): { x: number; y: number } => ({
      x: Math.floor((lon + 180) / dLon), y: Math.floor((90 - lat) / dLat),
    });
    const edge: Array<[number, number]> = [];
    for (let t = 0; t <= 1; t += 0.05) {
      edge.push([t * viewport.width, 0], [t * viewport.width, viewport.height],
        [0, t * viewport.height], [viewport.width, t * viewport.height]);
    }
    const cells = edge.map(([x, y]) => {
      const p = unprojectDeg(x, y, cam);
      expect(p).not.toBeNull();
      return cellOf(p!.lon, p!.lat);
    });
    for (const c of cells) {
      expect(rects.some((r) => c.x >= r.x0 && c.x <= r.x1 && c.y >= r.y0 && c.y <= r.y1)).toBe(true);
    }
    const slack = GLOBE.parcelViewportQuantumCells + 1;
    expect(Math.min(...rects.map((r) => r.x0))).toBeGreaterThanOrEqual(Math.min(...cells.map((c) => c.x)) - slack);
    expect(Math.max(...rects.map((r) => r.x1))).toBeLessThanOrEqual(Math.max(...cells.map((c) => c.x)) + slack);
    expect(Math.min(...rects.map((r) => r.y0))).toBeGreaterThanOrEqual(Math.min(...cells.map((c) => c.y)) - slack);
    expect(Math.max(...rects.map((r) => r.y1))).toBeLessThanOrEqual(Math.max(...cells.map((c) => c.y)) + slack);
    // …and it is materially narrower than the cap it replaced: a portrait window
    // is far taller than wide, so the circumscribing circle over-asked mostly in
    // longitude (here ~2.4×), and that is the axis the exact window wins back.
    const r = radiusPx(nav.zoom, Math.min(viewport.width, viewport.height));
    const cap = Math.asin(Math.hypot(viewport.width, viewport.height) / (2 * r));
    const halfLon = Math.asin(Math.sin(cap) / Math.cos(nav.phi0)) * RAD_TO_DEG;
    const capCols = Math.ceil((2 * halfLon) / dLon);
    const capRows = Math.ceil((2 * cap * RAD_TO_DEG) / dLat);
    const askedCols = Math.max(...rects.map((q) => q.x1)) - Math.min(...rects.map((q) => q.x0)) + 1;
    const askedRows = Math.max(...rects.map((q) => q.y1)) - Math.min(...rects.map((q) => q.y0)) + 1;
    expect(askedCols).toBeLessThan(capCols * 0.8);
    expect(askedRows).toBeLessThanOrEqual(capRows + GLOBE.parcelViewportQuantumCells);
  });

  it('falls back to the spherical cap when the rectangle reaches past the limb', () => {
    // Below the parcel band the whole disc can sit inside the window; a corner
    // in space has no cell, and the honest bound is then the cap the exact
    // window replaced — never tighter than the truth.
    const rects = visibleParcelBounds({ lam0: 0, phi0: 0.2, zoom: GLOBE.zoomMin }, { width: 390, height: 844 });
    expectBounded(rects);
    expect(rects.length).toBeGreaterThan(0);
  });

  it('names the visible centre in degrees, normalised, for the server’s nearest-first cap', () => {
    expect(visibleParcelCentre({ lam0: 190 * DEG_TO_RAD, phi0: 0.35, zoom: 2 }))
      .toEqual({ lon: expect.closeTo(-170, 6), lat: expect.closeTo(0.35 * RAD_TO_DEG, 6) });
  });
});

describe('minimal viewport marker protocol', () => {
  const bounds = { x0: 8, y0: 16, x1: 15, y1: 23 };
  const inside = 18 * GLOBE.fineCols + 10;

  it('accepts only exact echoed scope and canonical same-origin avatar generations', () => {
    const response = {
      scope: bounds,
      truncated: false,
      matched: 4,
      markers: [
        {
          earthCell: inside, name: 'KEEPER', avatarUrl: canonicalAvatar, keepLevel: 4,
          shielded: true, wallet: 'must-not-project',
        },
        { earthCell: inside + 1, name: 'EXTERNAL', avatarUrl: 'https://evil.test/a.webp', keepLevel: 3 },
        { earthCell: inside + 2, name: 'RAW', avatarUrl: '/bucket/wallet/hash.webp', keepLevel: 3 },
        { earthCell: 1, name: 'OUTSIDE', avatarUrl: null, keepLevel: 2 },
      ],
    };
    expect(viewportResponseMatchesScope(response, bounds)).toBe(true);
    expect(viewportResponseMatchesScope({ ...response, scope: { ...bounds, x1: 16 } }, bounds)).toBe(false);
    expect(viewportMarkers(response, bounds)).toEqual([
      { earthCell: inside, name: 'KEEPER', avatarUrl: canonicalAvatar, keepLevel: 4 },
      { earthCell: inside + 1, name: 'EXTERNAL', avatarUrl: null, keepLevel: 3 },
      { earthCell: inside + 2, name: 'RAW', avatarUrl: null, keepLevel: 3 },
    ]);
  });

  it('moves only the current selection to the top and never carries the prior selection', () => {
    const a = { earthCell: inside, name: 'A', avatarUrl: null, keepLevel: 1 };
    const b = { earthCell: inside + 1, name: 'B', avatarUrl: null, keepLevel: 1 };
    expect(prioritizeViewportMarkers([b, a], a.earthCell).at(-1)).toBe(a);
    expect(retainedSelectedViewportMarker([a], null, a.earthCell)).toBe(a);
    expect(retainedSelectedViewportMarker(null, a, b.earthCell)).toBeNull();
  });

  it('revokes a selected profile only after a settled scope omits its in-view cell', () => {
    const selected = { earthCell: inside, name: 'A', avatarUrl: null, keepLevel: 1 };
    const unresolved: ViewportParcels = {
      markers: [], exact: false, unsupported: false, truncated: false, matched: null,
    };
    const settled: ViewportParcels = {
      markers: [], exact: true, unsupported: false, truncated: false, matched: 0,
    };
    expect(exactViewportOmitsCell(unresolved, [bounds], selected.earthCell)).toBe(false);
    expect(exactViewportOmitsCell(settled, [bounds], selected.earthCell)).toBe(true);
    expect(retainedSelectedViewportMarker([], selected, selected.earthCell, true)).toBeNull();
    expect(retainedSelectedViewportMarker([], selected, selected.earthCell, false)).toBe(selected);
    const offScope = {
      x0: bounds.x1 + 1, y0: bounds.y0,
      x1: bounds.x1 + GLOBE.parcelViewportQuantumCells, y1: bounds.y1,
    };
    expect(exactViewportOmitsCell(settled, [offScope], selected.earthCell)).toBe(false);
  });
});

describe('viewport parcel request lifecycle', () => {
  const a: ViewportParcelBounds[] = [{ x0: 0, y0: 0, x1: 15, y1: 7 }];
  const b: ViewportParcelBounds[] = [{ x0: 8, y0: 0, x1: 23, y1: 7 }];
  const disjoint: ViewportParcelBounds[] = [{ x0: 40, y0: 0, x1: 55, y1: 7 }];
  const marker = (x: number, name: string): ViewportParcelMarker => ({
    earthCell: x, name, avatarUrl: null, keepLevel: 1,
  });
  const response = (scope: ViewportParcelBounds, markers: ViewportParcelMarker[]) => ({
    scope, markers, truncated: false, matched: markers.length,
  });
  const empty: ViewportParcels = {
    markers: null, exact: false, unsupported: false, truncated: false, matched: null,
  };

  it('sends the visible centre as cx/cy and publishes the cap bit and the qualifying count (D-097)', async () => {
    // WHY: the server orders a rect's bases by distance from (cx, cy) before its
    // marker cap, so the page is the NEAREST bases to what the player is looking
    // at; and the chrome can only say "n+ VISIBLE" if the cap bit and the count
    // before it travel back with the rows.
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({ ...response(a[0]!, [marker(2, 'A')]), truncated: true, matched: 1_500 });
    let latest: ViewportParcels = empty;
    function Probe(): null {
      latest = useViewportParcels(a, true, { lon: -0.1234, lat: 51.5 });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    expect(String(get.mock.calls[0]?.[0])).toContain('x0=0&y0=0&x1=15&y1=7&cx=-0.123&cy=51.500');
    expect(latest).toMatchObject({ exact: true, truncated: true, matched: 1_500 });
    expect(latest.markers).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('publishes a fresh exact omission so selected eligibility can be revoked', async () => {
    vi.useFakeTimers();
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(response(a[0]!, [marker(2, 'A')]))
      .mockResolvedValueOnce(response(a[0]!, []));
    let latest: ViewportParcels = empty;
    function Probe(): null { latest = useViewportParcels(a, true); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    expect(latest).toMatchObject({ exact: true, markers: [marker(2, 'A')] });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD.mapPollSec * 1_000);
    });
    expect(latest).toMatchObject({ exact: true, markers: [] });
    expect(exactViewportOmitsCell(latest, a, 2)).toBe(true);
    await act(async () => root.unmount());
  });

  it('retains overlap, settles B atomically, and restores cached A immediately', async () => {
    vi.useFakeTimers();
    let resolveB!: (value: ReturnType<typeof response>) => void;
    vi.spyOn(api, 'get')
      .mockResolvedValueOnce(response(a[0]!, [marker(2, 'A ONLY'), marker(10, 'OVERLAP')]))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
    let latest: ViewportParcels = empty;
    function Probe({ bounds }: { bounds: ViewportParcelBounds[] }): null {
      latest = useViewportParcels(bounds, true);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe bounds={a} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    expect(latest.markers?.map((item) => item.name)).toEqual(['A ONLY', 'OVERLAP']);

    await act(async () => root.render(<Probe bounds={b} />));
    expect(latest.markers?.map((item) => item.name)).toEqual(['OVERLAP']);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    expect(latest.markers?.map((item) => item.name)).toEqual(['OVERLAP']);
    await act(async () => {
      resolveB(response(b[0]!, [marker(10, 'OVERLAP FRESH'), marker(20, 'B ONLY')]));
      await Promise.resolve();
    });
    expect(latest.markers?.map((item) => item.name)).toEqual(['OVERLAP FRESH', 'B ONLY']);

    await act(async () => root.render(<Probe bounds={a} />));
    expect(latest.markers?.map((item) => item.name)).toEqual(['A ONLY', 'OVERLAP']);
    await act(async () => root.render(<Probe bounds={disjoint} />));
    expect(latest.markers).toEqual([]);
    await act(async () => root.unmount());
  });

  it('serializes a superseding camera scope behind the request on the wire', async () => {
    vi.useFakeTimers();
    let resolveA!: (value: ReturnType<typeof response>) => void;
    const get = vi.spyOn(api, 'get')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce(response(b[0]!, [marker(20, 'B')]));
    let latest: ViewportParcels = empty;
    function Probe({ bounds }: { bounds: ViewportParcelBounds[] }): null {
      latest = useViewportParcels(bounds, true);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe bounds={a} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    await act(async () => root.render(<Probe bounds={b} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveA(response(a[0]!, [marker(2, 'STALE A')]));
      await Promise.resolve();
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(latest.markers?.map((item) => item.name)).toEqual(['B']);
    await act(async () => root.unmount());
  });

  it.each([
    [404, true], [405, true], [501, true], [500, false],
  ])('uses legacy fallback only for explicit unsupported status %i', async (status, unsupported) => {
    vi.useFakeTimers();
    vi.spyOn(api, 'get').mockRejectedValueOnce(new ApiError(status, 'read failed'));
    let latest: ViewportParcels = empty;
    function Probe(): null { latest = useViewportParcels(a, true); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    expect(latest.unsupported).toBe(unsupported);
    await act(async () => root.unmount());
  });

  it('polls one-at-a-time only while the tab is visible', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'get').mockResolvedValue(response(a[0]!, [marker(2, 'A')]));
    function Probe(): null { useViewportParcels(a, true); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBE.parcelViewportDebounceMs);
    });
    expect(get).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORLD.mapPollSec * 2_000);
    });
    expect(get).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});

describe('public deed parcel roster', () => {
  it('accepts old anonymous markers and preserves only optional public identity', () => {
    expect(toRows({
      valleyId: 'v', valleyName: 'VALLEY', visiting: true,
      markers: [
        { kind: 'silhouette', x: 1, y: 2, earthCell: 10, keepLevel: 3 },
        {
          kind: 'player', x: 3, y: 4, earthCell: 11, keepLevel: 4,
          name: 'THEODOR', avatarUrl: '/api/avatars/theodor.webp',
        },
        { kind: 'pve', x: 5, y: 6, earthCell: 12 },
        { kind: 'player', x: 7, y: 8 },
      ],
    })).toEqual([
      { x: 1, y: 2, earthCell: 10, keepLevel: 3, mine: false, name: undefined, avatarUrl: undefined },
      {
        x: 3, y: 4, earthCell: 11, keepLevel: 4, mine: false,
        name: 'THEODOR', avatarUrl: '/api/avatars/theodor.webp',
      },
    ]);
  });

  it('never overlaps, retries a transient failure, and pauses while hidden', async () => {
    vi.useFakeTimers();
    let rejectFirst!: (error: Error) => void;
    const get = vi.spyOn(api, 'get')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue({
        valleyId: 'v', valleyName: 'VALLEY', visiting: true,
        markers: [{ kind: 'player', x: 1, y: 2, earthCell: 10, name: 'KEEPER' }],
      });
    let latest: ValleyParcels | null = null;
    function Probe(): null { latest = useValleyParcels('v', true); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe />));
    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0]?.[0])).toContain('parcelBand=1');

    await act(async () => { await vi.advanceTimersByTimeAsync(WORLD.mapPollSec * 3_000); });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => { rejectFirst(new Error('temporary')); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(WORLD.mapPollSec * 1_000); });
    expect(get).toHaveBeenCalledTimes(2);
    expect((latest as unknown as ValleyParcels).rows[0]).toMatchObject({
      name: 'KEEPER', earthCell: 10,
    });

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { await vi.advanceTimersByTimeAsync(WORLD.mapPollSec * 2_000); });
    expect(get).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(get).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
  });

  it('retains the exact last-good foreign profiles across a zoom-band round trip', async () => {
    const get = vi.spyOn(api, 'get')
      .mockResolvedValueOnce({
        valleyId: 'foreign', valleyName: 'FOREIGN', visiting: true,
        markers: [{
          kind: 'player', x: 4, y: 5, earthCell: 12, name: 'SHARDLORD', avatarUrl: null,
        }],
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    let latest: ValleyParcels | null = null;
    function Probe({ want }: { want: boolean }): null {
      latest = useValleyParcels('foreign', want);
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(<Probe want />));
    await act(async () => { await Promise.resolve(); });
    expect((latest as unknown as ValleyParcels).rows[0]?.name).toBe('SHARDLORD');

    await act(async () => root.render(<Probe want={false} />));
    await act(async () => root.render(<Probe want />));
    expect(get).toHaveBeenCalledTimes(2);
    // The second refresh is deliberately unresolved. Crossing the fetch band must
    // not turn known deed land back into an empty board in the meantime.
    expect((latest as unknown as ValleyParcels).rows[0]?.name).toBe('SHARDLORD');
    await act(async () => root.unmount());
  });
});
