import { describe, expect, it, vi } from 'vitest';
import { FANTASY_WORLD } from '@shardkeep/shared';
import { fantasyTiles } from '@shardkeep/shared/fantasyWorld';
import { REALM_DIVE_FAILED, REALM_DIVE_STALL_MS, RealmDiveError, cellToTile, createRealmView, kingdomName, markersToBases, tileToCell } from './adapter';
import type { RealmBase, RealmMap, RealmMapStats, RealmPick } from './map.mjs';

const [a, b] = [...fantasyTiles('sunscar')].slice(0, 2).map(t => t.tileId) as [number, number];
const other = fantasyTiles('frostveil').next().value!.tileId;
const col = (t: number) => t % FANTASY_WORLD.columns, row = (t: number) => Math.floor(t / FANTASY_WORLD.columns);
// a grid around the two Sunscar tiles that also holds the Frostveil one
const x0 = Math.min(col(a), col(b), col(other)) - 2, y0 = Math.min(row(a), row(b), row(other)) - 2;
const grid = { x0, y0, cols: Math.max(col(a), col(b), col(other)) - x0 + 3, rows: Math.max(row(a), row(b), row(other)) - y0 + 3 };

describe('host markers become realm-map kingdoms (live data, never demo)', () => {
  it('maps a tile id to its deed cell and back', () => {
    const c = tileToCell(a, grid)!; expect(cellToTile(c.x, c.y, grid)).toBe(a);
    expect(tileToCell(-1, grid)).toBeNull(); expect(tileToCell(1.5, grid)).toBeNull();
  });
  it('keeps only this realm\'s tiles, drops realm clusters, and merges a tile listed twice', () => {
    const list = markersToBases('sunscar', grid, [
      { tileId: a, name: '', keepLevel: 7, avatarUrl: null },
      { tileId: a, name: 'Ar', keepLevel: 7, owned: true, shielded: true },
      { tileId: b, name: '  ', keepLevel: 99, shielded: false },
      { tileId: other, name: 'Frost', keepLevel: 3 },
      { tileId: a, name: 'cluster', cluster: { count: 5, realmId: 'sunscar' } },
    ]);
    expect(list.map(x => x.id)).toEqual([a, b].sort((p, q) => p - q));
    const A = list.find(x => x.id === a)!, B = list.find(x => x.id === b)!;
    expect(A).toMatchObject({ name: 'Ar', mine: true, shield: true, level: 7, attackable: false });
    expect(B).toMatchObject({ name: 'Keeper', mine: false, shield: false, level: 20 }); // a blank rival; the level cap from constants
  });
  it('one naming rule: a blank own kingdom reads "Your kingdom", a blank rival "Keeper"', () => {
    expect(kingdomName('', true)).toBe('Your kingdom'); expect(kingdomName(null, false)).toBe('Keeper'); expect(kingdomName(' Zel ', false)).toBe('Zel');
  });
  it('D-181: the own base read can add a dome but never hides the feed\'s', () => {
    const [own] = markersToBases('sunscar', grid, [{ tileId: a, name: 'Me', owned: true, shielded: false }], { tileId: a, shielded: true });
    expect(own!.shield).toBe(true);
    const [rival] = markersToBases('sunscar', grid, [{ tileId: b, name: 'R', shielded: true }], { tileId: b, shielded: false });
    expect(rival!.shield).toBe(true);
  });
  it('D-191: a read without the shielded key is unknown (undefined), so the Unshielded chip never passes it', () => {
    // Why: the chip keeps only an explicit `shield: false`; a marker whose read dropped the key (K-188, an older server)
    // must not be offered as an open raid target.
    const [unknown] = markersToBases('sunscar', grid, [{ tileId: b, name: 'R' }]);
    expect(unknown!.shield).toBeUndefined();
    const [open] = markersToBases('sunscar', grid, [{ tileId: b, name: 'R', shielded: false }]);
    expect(open!.shield).toBe(false);
  });
});

function fakeEngine() {
  let stats: RealmMapStats = { firstFrameMs: 0, bytesLoaded: 0, enterTiming: {}, mapReadyMs: 0, band: 'far', d: 20, s: 10, realm: null, dive: { state: 'free', landMs: 0, d: 0, fitD: 0 }, modules: {} };
  let resolveEnter: () => void = () => {};
  const bases: RealmBase[] = [];
  const e = {
    active: true, selected: null as RealmPick | null, lastView: null, realm: null as unknown,
    core: { invalidate: vi.fn(), input: vi.fn() }, ready: Promise.resolve(),
    has: () => true, realms: () => [], prefetch: vi.fn(), loaded: () => Promise.resolve(),
    enter: vi.fn(() => new Promise<void>(r => { resolveEnter = r; })),
    leave: vi.fn(), dispose: vi.fn(), suspend: vi.fn(), resume: vi.fn(), exit: vi.fn(), step: vi.fn(), myBase: vi.fn(), zoomBy: vi.fn(), flyToD: vi.fn(), setFilter: vi.fn(),
    setBases: vi.fn((_: string, l: RealmBase[]) => { bases.splice(0, bases.length, ...l); }), chromeChanged: vi.fn(), drawsBase: () => false,
    select: vi.fn((p: RealmPick | null) => { e.selected = p; hostCard?.(p); }),
    stats: () => stats,
  };
  let hostCard: ((p: RealmPick | null) => void) | undefined;
  const made: { pack?: string; options?: Record<string, unknown>; onExit?: (at: { lon: number; lat: number }) => void }[] = [];
  const mod = { createRealmMap: (o: { pack?: string; options?: { host?: { card(p: RealmPick | null): void } } }) => { made.push(o as never); hostCard = p => o.options!.host!.card(p); return e as unknown as RealmMap; }, plotAt: () => ({ x: 0, y: 0 }) };
  return { e, mod, bases, made, land: () => resolveEnter(), setStats: (s: Partial<RealmMapStats>) => { stats = { ...stats, ...s }; } };
}

describe('the realm view bridge', () => {
  const opts = (f: ReturnType<typeof fakeEngine>, onSelect = vi.fn(), now = () => Date.now()) => ({
    canvas: {} as HTMLCanvasElement, ui: {} as HTMLElement, packRoot: '/atlas/world-v2/pm1-cb8faa56909faa31/',
    host: { onSelect }, importEngine: () => Promise.resolve(f.mod as unknown as typeof import('./map.mjs')), now });

  it('a dive with no progress for 12 s fails loudly with the notice, and leaves the map', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeEngine(); let t = 0; const v = await createRealmView(opts(f, vi.fn(), () => t));
      const p = v.enter('sunscar', 0, 0); const caught = p.catch(e => e);
      for (let i = 0; i < 40; i++) { t += 250; await vi.advanceTimersByTimeAsync(250); } // 10 s: nothing yet
      f.setStats({ bytesLoaded: 1 }); // progress resets the watchdog
      for (let i = 0; i < 44; i++) { t += 250; await vi.advanceTimersByTimeAsync(250); } // 11 s after it: still alive
      expect(f.e.leave).not.toHaveBeenCalled();
      for (let i = 0; i < 8; i++) { t += 250; await vi.advanceTimersByTimeAsync(250); }
      const err = await caught; expect(err).toBeInstanceOf(RealmDiveError); expect((err as RealmDiveError).notice).toBe(REALM_DIVE_FAILED);
      expect(f.e.leave).toHaveBeenCalled(); expect(REALM_DIVE_STALL_MS).toBe(12_000);
    } finally { vi.useRealTimers(); }
  });

  it('a cancelled dive is silent (AbortError), and a landed dive resolves at its first ground frame', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeEngine(); const v = await createRealmView(opts(f));
      const ac = new AbortController(), p = v.enter('sunscar', 0, 0, 18, ac.signal).catch(e => e); ac.abort();
      expect(((await p) as DOMException).name).toBe('AbortError');
      const q = v.enter('sunscar', 0, 0); f.land(); f.setStats({ firstFrameMs: 40 });
      await vi.advanceTimersByTimeAsync(300); await expect(q).resolves.toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  // Why: without markers the MAP range shows the keep icons the owner rejected; without chart16 false every FAR frame asks
  // for chart16 pages the shipped pack leaves out (as native does).
  it('builds the engine with the web options: host card, markers, no chart16, the pack root', async () => {
    const f = fakeEngine(); await createRealmView(opts(f));
    expect(f.made[0]!.pack).toBe('/atlas/world-v2/pm1-cb8faa56909faa31/');
    expect(f.made[0]!.options).toMatchObject({ markers: true, chart16: false });
    expect(typeof (f.made[0]!.options!['host'] as { card?: unknown }).card).toBe('function');
  });

  it('every tap goes to the host once; the host echoing it back does not loop', async () => {
    const f = fakeEngine(), onSelect = vi.fn(); const v = await createRealmView(opts(f, onSelect));
    (f.e as { realm: unknown }).realm = { id: 'sunscar', meta: { grid }, bases: [], x0: grid.x0, y0: grid.y0, cols: grid.cols, rows: grid.rows, name: 'Sunscar' };
    const c = tileToCell(a, grid)!;
    f.e.select({ free: true, x: c.x, y: c.y }); // the player taps an open deed
    expect(onSelect).toHaveBeenLastCalledWith(a);
    v.select(a); // the host sets selectedTileId from it
    expect(f.e.select).toHaveBeenCalledTimes(1); expect(onSelect).toHaveBeenCalledTimes(1);
    v.select(null); expect(f.e.select).toHaveBeenLastCalledWith(null);
  });

  // Review r2 (L9): the view used to only leave the engine on dispose, so every WorldV2 mount orphaned a whole engine
  // (window listeners, pack bytes, decoded chart) for the page's life. Dispose must reach the engine's own dispose, and
  // the controller's notice choice must pass through; a hidden page must reach suspend/resume (a discarded tab is not
  // a crash); a pinch-out below 0.7 × the fit must reach the host's onExit, or it strands the player in the map.
  it('dispose throws the engine away, hide/show reach suspend/resume, and the pinch-out exit reaches the host', async () => {
    const f = fakeEngine(), onExit = vi.fn();
    const v = await createRealmView({ ...opts(f), host: { onSelect: vi.fn(), onExit } });
    f.made[0]!.onExit!({ lon: 26, lat: 23 });
    expect(onExit).toHaveBeenCalledWith({ lon: 26, lat: 23 });
    v.suspend(); v.resume();
    expect(f.e.suspend).toHaveBeenCalledOnce(); expect(f.e.resume).toHaveBeenCalledOnce();
    v.dispose({ notices: false });
    expect(f.e.dispose).toHaveBeenCalledWith({ notices: false });
  });
});
