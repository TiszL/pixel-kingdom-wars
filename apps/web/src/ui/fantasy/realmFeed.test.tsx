/** @vitest-environment happy-dom */
// The World v2 realm-map parcel feed (D-186). A realm-map camera can show a whole realm,
// so its reads are bounded twice over. Why: the server refuses a rect above
// GLOBE.parcelViewportMaxCells (4,096 cells), and GET /globe/fantasy/parcels allows a
// wallet 120 reads a minute, so more than GLOBE.parcelViewportMaxRequests (4) reads per
// settled pan would blank the map mid-session for an honest player. What the cap leaves
// out is disclosed (`truncated`), never drawn as a complete realm. The goldens are
// native's (WorldHudFlowTest, 7b5075b), so both clients read the same kingdoms.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBE } from '@shardkeep/shared';
import { fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import type { FantasyRect, FantasyViewBounds, FantasyViewportData } from './data';
import { realmFeedScope, realmWindowBounds } from './realmFeed';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/api')>(), api }));
import { fantasyViewportRects, useFantasyViewport } from './data';

const REALM_VIEW = { lon: 0, lat: 0, zoom: 8 };
const plan = (window: { x0: number; y0: number; x1: number; y1: number }) => {
  const bounds = realmWindowBounds(window);
  return realmFeedScope(fantasyViewportRects(REALM_VIEW, { width: 390, height: 844, bounds }), bounds);
};
const bounded = (rects: FantasyRect[]): void => {
  expect(rects.length).toBeLessThanOrEqual(GLOBE.parcelViewportMaxRequests);
  for (const r of rects) {
    expect((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)).toBeLessThanOrEqual(GLOBE.parcelViewportMaxCells);
    expect(r.x1 - r.x0 + 1).toBeLessThanOrEqual(64);
    expect(r.y1 - r.y0 + 1).toBeLessThanOrEqual(64);
    expect(r.x0 % GLOBE.parcelViewportQuantumCells).toBe(0);
    expect(r.y0 % GLOBE.parcelViewportQuantumCells).toBe(0);
  }
};

describe('realm feed plan (native WorldRealmFeed parity)', () => {
  it('grows the window 2-3 deeds and snaps to the 8-cell quantum in one read', () => {
    const scope = plan({ x0: 100.2, y0: 50.5, x1: 140.8, y1: 90.1 });
    expect(scope).toEqual({ rects: [{ x0: 96, y0: 48, x1: 143, y1: 95 }], truncated: false });
  });

  it('reads a window across the dateline on both sides, never as one impossible rect', () => {
    const scope = plan({ x0: -12, y0: 300, x1: 9, y1: 330 });
    expect(new Set(scope.rects.map(r => JSON.stringify(r)))).toEqual(new Set([
      JSON.stringify({ x0: 0, y0: 296, x1: 15, y1: 335 }), JSON.stringify({ x0: 704, y0: 296, x1: 719, y1: 335 })]));
    expect(scope.truncated).toBe(false);
  });

  it('reads only the four rects nearest the centre of a whole-realm view and discloses the rest', () => {
    const scope = plan({ x0: 0, y0: 0, x1: 300, y1: 200 });
    expect(scope.truncated).toBe(true);
    expect(scope.rects).toHaveLength(4);
    expect(scope.rects[0]).toEqual({ x0: 128, y0: 64, x1: 191, y1: 127 });
  });

  it('never plans more than 4 reads or a rect above 4,096 cells, for any window size or place', () => {
    for (const [w, h] of [[8, 8], [40, 90], [64, 64], [65, 65], [200, 120], [719, 359]] as const)
      for (const x0 of [-30, 0, 333, 700]) for (const y0 of [0, 150, 300]) bounded(plan({ x0, y0, x1: x0 + w, y1: y0 + h }).rects);
  });

  it('keeps the overview gate: a camera below zoom 5 plans no reads at all', () => {
    const bounds: FantasyViewBounds = realmWindowBounds({ x0: 100, y0: 50, x1: 140, y1: 90 });
    expect(fantasyViewportRects({ ...REALM_VIEW, zoom: 4.9 }, { width: 390, height: 844, bounds })).toEqual([]);
  });
});

let root: Root, host: HTMLDivElement;
const authority = { key: 'viewer:starter:1', wallet: 'viewer', baseId: 'starter' };
const reply = (path: string, markers: FantasyViewportData['markers'] = [], truncated = false): FantasyViewportData => {
  const q = new URLSearchParams(path.split('?')[1]);
  const scope = { x0: Number(q.get('x0')), y0: Number(q.get('y0')), x1: Number(q.get('x1')), y1: Number(q.get('y1')) };
  return { worldId: 'fantasy-v1', scope, markers, matched: markers.length, truncated };
};
let latest: ReturnType<typeof useFantasyViewport> | null = null;
function Feed({ bounds }: { bounds: FantasyViewBounds | null }) {
  latest = useFantasyViewport(authority, REALM_VIEW, true, { width: 390, height: 844, bounds });
  return null;
}
const show = async (bounds: FantasyViewBounds | null): Promise<void> => { await act(async () => root.render(<Feed bounds={bounds}/>)); };
const wait = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  api.get.mockReset(); api.get.mockImplementation(async (path: string) => reply(path)); latest = null;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe('realm feed reads (useFantasyViewport with a realm-map box)', () => {
  it('waits for the camera to settle: a pan across many boxes costs one bounded read', async () => {
    for (let step = 0; step < 12; step++) { await show(realmWindowBounds({ x0: 100 + step * 9, y0: 60, x1: 180 + step * 9, y1: 130 })); await wait(GLOBE.parcelViewportDebounceMs - 50); }
    expect(api.get).not.toHaveBeenCalled();
    await wait(GLOBE.parcelViewportDebounceMs);
    const reads = api.get.mock.calls.map(([path]) => path as string);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(GLOBE.parcelViewportMaxRequests);
    for (const path of reads) {
      const { scope } = reply(path);
      expect((scope.x1 - scope.x0 + 1) * (scope.y1 - scope.y0 + 1)).toBeLessThanOrEqual(GLOBE.parcelViewportMaxCells);
      expect(path).toContain('baseId=starter');
    }
  });

  it('asks nearest-first and flags a whole-realm view as truncated even when every read is complete', async () => {
    await show(realmWindowBounds({ x0: 0, y0: 0, x1: 300, y1: 200 }));
    await wait(GLOBE.parcelViewportDebounceMs);
    expect(api.get).toHaveBeenCalledTimes(GLOBE.parcelViewportMaxRequests);
    expect(reply(api.get.mock.calls[0]![0] as string).scope).toEqual({ x0: 128, y0: 64, x1: 191, y1: 127 });
    expect(latest?.data?.truncated).toBe(true);
  });

  it('keeps the shield from each read (K-188) and passes a server-side cut through', async () => {
    api.get.mockImplementation(async (path: string) => {
      const { scope } = reply(path);
      const inside = [...fantasyTiles()].filter(t => t.tileId % 720 >= scope.x0 && t.tileId % 720 <= scope.x1
        && Math.floor(t.tileId / 720) >= scope.y0 && Math.floor(t.tileId / 720) <= scope.y1).slice(0, 2);
      return reply(path, inside.map((t, i) => ({ tileId: t.tileId, name: 'Keeper', keepLevel: 3, avatarUrl: null, shielded: i === 0 })), true);
    });
    await show(realmWindowBounds({ x0: 400, y0: 120, x1: 430, y1: 150 }));
    await wait(GLOBE.parcelViewportDebounceMs);
    expect(api.get).toHaveBeenCalledOnce();
    expect(latest?.data?.truncated).toBe(true);
    expect(latest?.data?.markers.map(m => m.shielded)).toEqual([true, false]);
  });

  it('keeps the last settled kingdoms drawn during a pan, and a re-entry never re-reads the old box', async () => {
    const first = realmWindowBounds({ x0: 100.2, y0: 50.5, x1: 140.8, y1: 90.1 });
    await show(first); await wait(GLOBE.parcelViewportDebounceMs);
    expect(latest?.data).not.toBeNull();
    await show(realmWindowBounds({ x0: 300, y0: 50, x1: 340, y1: 90 }));
    expect(latest?.data).not.toBeNull();
    await show(null); await show(first);
    api.get.mockClear();
    await wait(GLOBE.parcelViewportDebounceMs - 1);
    expect(api.get).not.toHaveBeenCalled();
    await wait(1);
    expect(api.get).toHaveBeenCalledOnce();
  });
});
