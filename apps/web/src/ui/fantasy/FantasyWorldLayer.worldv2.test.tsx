/** @vitest-environment happy-dom */
// Renderer seam in FantasyWorldLayer (D-186): the lazy WorldV2 chunk only when the gate
// passes, the same props as the CPU globe plus three World v2 callbacks, and the CPU globe
// as the fallback. Why: World v2 is new GPU code on players' phones; whatever it does
// (fails to load, throws, reports it cannot run), the player must keep a working world
// with every money and combat path the host owns: choose land, scout, raid, open base.
// Round 3 (L8): while WorldV2 is live its HUD replaces the host's header, rail, tools and panel (fed through the
// `hud` prop); the host's chrome must come back unchanged the moment the CPU globe takes over (G5).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fantasyTileAt, type FantasyTile } from '@shardkeep/shared/fantasyWorld';
import type { BasesDto } from '../../lib/api';
import type { FantasyGlobeData, FantasyParcelData, FantasyOwnedTile } from './data';
import type { FantasyGlobeProps } from './FantasyGlobe';
import type { FantasyGlobeHandle, FantasyWorldMarker } from './types';

const state = vi.hoisted(() => ({
  available: false, imported: false, mode: 'record' as 'record' | 'crash' | 'stub',
  cpu: [] as FantasyGlobeProps[], v2: [] as Array<Record<string, unknown>>,
  data: null as FantasyGlobeData | null, parcel: null as FantasyParcelData | null, feed: null as FantasyWorldMarker[] | null,
  feedPending: false, feedError: null as Error | null,
  search: [] as Array<{ tileId: number; realmId: string; name: string; keepLevel: number; trophies: number }>,
  focusTile: vi.fn(), focusRealm: vi.fn(), focusIsland: vi.fn(), setView: vi.fn(), get: vi.fn(), openBase: vi.fn(), emit: vi.fn(),
}));
vi.mock('./data', () => ({
  useFantasyDirectory: () => ({ data: state.data, pending: false, error: null, retry: vi.fn() }),
  useFantasyParcel: () => ({ data: state.parcel, pending: false, error: null, retry: vi.fn() }),
  useFantasyViewport: () => ({ data: state.feed && { markers: state.feed, matched: state.feed.length, truncated: false }, pending: state.feedPending, error: state.feedError, retry: vi.fn() }),
  useFantasySearch: () => ({ data: state.search, pending: false, error: null, retry: vi.fn() }),
}));
vi.mock('./worldV2Support', () => ({ worldV2Available: () => state.available, worldV2Capability: async () => null, reportWorldV2Fallback: () => {} }));
vi.mock('./FantasyGlobe', async importOriginal => {
  const actual = await importOriginal<typeof import('./FantasyGlobe')>(), react = await import('react');
  return { ...actual, FantasyGlobe: react.forwardRef<FantasyGlobeHandle, FantasyGlobeProps>((props, ref) => {
    state.cpu.push(props);
    react.useEffect(() => props.onTerrainStatus?.({ ready: true, pending: false, error: null, retry: () => {} }), [props.onTerrainStatus]);
    react.useImperativeHandle(ref, () => ({ focusTile: state.focusTile, focusRealm: state.focusRealm, focusIsland: state.focusIsland,
      setView: state.setView, view: () => ({ lon: 26, lat: 23, zoom: 1 }), stats: () => null }));
    return null;
  }) };
});
vi.mock('./worldv2/WorldV2', async importOriginal => {
  state.imported = true;
  const actual = await importOriginal<typeof import('./worldv2/WorldV2')>(), react = await import('react');
  return { default: react.forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    if (state.mode === 'crash') throw new Error('chunk exploded');
    if (state.mode === 'stub') return react.createElement(actual.default as never, { ...props, ref } as never);
    state.v2.push(props);
    return null;
  }) };
});
vi.mock('../../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/api')>(), api: { get: state.get } }));
vi.mock('../../state/baseSnapshot', () => ({ selectBaseSnapshot: state.openBase }));
vi.mock('../../lib/events', () => ({ bus: { emit: state.emit } }));
// The real Back registry (round 3): the G5 test drives Android Back through createMobileBackGuard, so a World v2
// handler left registered after a fallback would be caught.
vi.mock('./FantasyShieldStatus', () => ({ FantasyShieldStatus: () => null }));
import { useApp } from '../../state/store';
import { createMobileBackGuard, type MobileBackWindow } from '../../lib/mobileBackGuard';
import { FantasyWorldLayer } from './FantasyWorldLayer';

const crown = fantasyTileAt(26, 23)!;
const originalState = useApp.getState();
let root: Root, host: HTMLDivElement, warn: ReturnType<typeof vi.spyOn>;

const directory = (): BasesDto => ({ enabled: true, worldId: 'fantasy-v1', maxActive: 5, nextLandPurchaseKind: 'entry',
  capabilities: { baseScopedReads: true, baseScopedMutations: true, cellReservations: true },
  bases: [{ id: 'starter', deedAssetId: null, status: 'active', keepLevel: 1, builders: 1, expansions: 0, landPaidAt: null, slot: 1, earthCell: null, countryA3: null }] });
const world = (ownedTiles: FantasyOwnedTile[] = []): FantasyGlobeData => ({ worldId: 'fantasy-v1', catalogHash: '', ready: true, realms: [],
  me: { baseId: 'starter', selectedTileId: null, ownedTiles } });
const available = (): FantasyParcelData => ({ worldId: 'fantasy-v1', tile: crown, availability: 'available', detail: null });
const rival = (): FantasyParcelData => ({ worldId: 'fantasy-v1', tile: crown, availability: 'occupied', detail: {
  player: { wallet: 'defender-wallet', name: 'REAL KEEPER', avatarUrl: null, clanTag: null, seeker: false, keepLevel: 4, trophies: 1200 },
  deed: { assetId: 'asset', status: 'minted', metadata: { name: 'Land Deed', symbol: 'DEED', description: 'A base', external_url: '/deed/asset.json', image: '/deed/defender.png', attributes: [] } },
  base: { id: 'defender-base', completedStructures: 22, defenses: 6, walls: 30, landWidth: 18 },
  shield: { active: false, source: null, expiresAt: null, remainingMs: 0, suppressedByWarzone: false },
  warzone: { active: false, boundaryAt: null, remainingMs: null }, shielded: false,
  actions: { scout: { allowed: true, blockedBy: null }, attack: { allowed: true, blockedBy: null } },
  availableLootRanges: { oneStar: { min: '100', max: '299' }, twoStars: { min: '250', max: '599' }, threeStars: { min: '500', max: '999' } },
} });

const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
const cpu = (): FantasyGlobeProps => state.cpu.at(-1)!;
const render = async (): Promise<void> => {
  await act(async () => root.render(<FantasyWorldLayer/>));
  // The lazy chunk (a transformed module on first load) resolves after some macrotasks:
  // wait until one renderer has rendered, bounded so a hang still fails the test.
  for (let tick = 0; tick < 200 && !state.cpu.length && !state.v2.length; tick++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};
const shape = (props: object): Record<string, string> =>
  Object.fromEntries(Object.entries(props).map(([key, value]) => [key, typeof value === 'function' ? 'function' : JSON.stringify(value)]));

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
  Object.assign(state, { available: false, mode: 'record', cpu: [], v2: [], data: world(), parcel: null, feed: null, feedPending: false, feedError: null, search: [] });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useApp.setState({ ...originalState, wallet: 'viewer', selectedBaseId: 'starter', entryPaid: false, baseDirectory: directory(), screen: 'map', mapTab: 'world', landPurchase: null, raidTarget: null });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useApp.setState(originalState, true); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks();
});

describe('FantasyWorldLayer World v2 seam', () => {
  // First on purpose: React.lazy caches its chunk, so "never fetched" is only observable before any test loads it.
  it('keeps the CPU globe, and never fetches the World v2 chunk, when the gate is closed', async () => {
    await render();
    expect(state.cpu.length).toBeGreaterThan(0);
    expect(state.v2).toHaveLength(0);
    expect(state.imported).toBe(false);
  });

  // Round 3 added the `hud` feed to the contract (the review's blocker: the L5 HUD was never mounted). The rule this
  // pins is unchanged: WorldV2 gets the CPU globe's props exactly, and only the named World v2 additions on top.
  it('gives WorldV2 exactly the CPU globe props plus the frozen-contract callbacks and the hud feed', async () => {
    await render();
    const before = cpu();
    await act(async () => root.unmount()); root = createRoot(host);
    state.available = true; state.cpu = [];
    await render();
    expect(state.cpu).toHaveLength(0);
    const props = state.v2.at(-1)!;
    const { onSpecialIsland, onViewportBounds, fallbackTo2D, hud, ...shared } = props;
    expect(shape(shared)).toEqual(shape(before));
    for (const hook of [onSpecialIsland, onViewportBounds, fallbackTo2D]) expect(typeof hook).toBe('function');
    expect(Object.keys(hud as object).sort()).toEqual(['actions', 'busy', 'cardExtras', 'directory', 'explore', 'ownShield', 'ownTile', 'parcel', 'search', 'warzone']);
    // The veil holds until the renderer reports a frame, exactly as for the CPU globe.
    expect(host.querySelector('.fantasy-world-loading')).not.toBeNull();
  });

  it('falls back to the CPU globe, veil held, when WorldV2 reports it cannot run', async () => {
    state.available = true;
    await render();
    expect(state.cpu).toHaveLength(0);
    await act(async () => (state.v2.at(-1)!.fallbackTo2D as (reason: string) => void)('context lost'));
    expect(state.cpu.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[worldv2]'), 'context lost');
  });

  // Rewritten when L6 replaced the L1a stub (which always fell back with 'stub'). The rule it pins is unchanged:
  // the real WorldV2, on a device that gives it no WebGL2 context (happy-dom has none), hands the stage straight
  // back to the CPU globe with its reason, and the veil lifts, so the player is never left with an empty world.
  it('the real WorldV2 hands the stage back to the CPU globe when it gets no WebGL2 context', async () => {
    state.available = true; state.mode = 'stub';
    await render();
    expect(state.cpu.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[worldv2]'), 'globe: WebGL2 unavailable');
    expect(host.querySelector('.fantasy-world-loading')).toBeNull();
  });

  it('if WorldV2 throws, the CPU globe takes over and every host action still works', async () => {
    state.available = true; state.mode = 'crash';
    state.data = world([{ tileId: crown.tileId, baseId: 'assigned-base', realmId: crown.realmId, name: 'My keep', keepLevel: 2, active: true, selected: false }]);
    state.search = [{ tileId: crown.tileId, realmId: crown.realmId, name: 'REAL KEEPER', keepLevel: 4, trophies: 1200 }];
    await render();
    expect(state.cpu.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[worldv2]'), expect.stringContaining('chunk exploded'));
    expect(host.querySelector('.fantasy-world-loading')).toBeNull();
    expect(host.querySelector('main')?.hasAttribute('inert')).toBe(false);

    // Navigation: realm rail, EXPLORE chains, owner search, My Parcel, inspect land.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-realm="frostveil"]')!.click());
    expect(state.focusRealm).toHaveBeenCalledWith('frostveil');
    await act(async () => button('EXPLORE').click());
    await act(async () => host.querySelector<HTMLButtonElement>('.fantasy-explore-list>button')!.click());
    expect(state.focusIsland).toHaveBeenCalled();
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(state.focusTile).toHaveBeenCalledWith(crown.tileId);
    state.focusTile.mockClear();
    await act(async () => button('MY PARCEL').click());
    expect(state.focusTile).toHaveBeenCalledWith(crown.tileId);
    await act(async () => button('‹ REALM OVERVIEW').click());
    await act(async () => button('INSPECT LAND TILES').click());
    expect(state.setView).toHaveBeenCalledWith(expect.objectContaining({ zoom: 16 }));

    // Open base (own deed), then the paid-land path: tap -> CHOOSE LAND -> landPurchase -> Entry.
    state.openBase.mockResolvedValue(true);
    await act(async () => cpu().onSelect(crown));
    await act(async () => button('OPEN THIS BASE').click());
    expect(state.openBase).toHaveBeenCalledWith('assigned-base');
    expect(useApp.getState().screen).toBe('base');
    state.data = world(); state.parcel = available(); useApp.setState({ screen: 'map' });
    await render();
    await act(async () => cpu().onSelect(crown as FantasyTile));
    expect(host.querySelector('[data-tutorial-target="land-globe-confirm"]')).not.toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="CHOOSE LAND"]')!.click());
    expect(useApp.getState().landPurchase?.landAddress).toEqual({ kind: 'fantasy', worldId: 'fantasy-v1', tileId: crown.tileId });
    expect(useApp.getState().screen).toBe('entry');

    // Scout and raid a rival through the host panel.
    state.parcel = rival(); useApp.setState({ screen: 'map' });
    await render();
    await act(async () => cpu().onSelect(crown));
    state.get.mockResolvedValue({ name: 'REAL KEEPER', keepLevel: 4, trophies: 1200, previewSec: 10 });
    await act(async () => button('SCOUT').click());
    expect(state.get).toHaveBeenCalledWith('/map/scout/defender-base?baseId=starter');
    expect(useApp.getState().screen).toBe('scout');
    expect(state.emit).toHaveBeenCalledWith('battle:enter', expect.objectContaining({ scout: true }));
    useApp.setState({ screen: 'map' });
    await render();
    await act(async () => button('RAID').click());
    expect(useApp.getState().raidTarget).toEqual(expect.objectContaining({ kind: 'pvp', wallet: 'defender-wallet', defenderBaseId: 'defender-base' }));
    expect(useApp.getState().screen).toBe('battle');

    // Header: CAMPAIGN and BASE.
    useApp.setState({ screen: 'map' });
    await render();
    await act(async () => button('CAMPAIGN').click());
    expect(useApp.getState().mapTab).toBe('campaign');
    await act(async () => button('‹ BASE').click());
    expect(useApp.getState().screen).toBe('base');
    // The broken renderer is never retried within the visit.
    expect(state.v2).toHaveLength(0);
  });
});

describe('World v2 HUD in place of the host chrome', () => {
  const chrome = () => ['.fantasy-world-top', '.fantasy-realm-rail', '.fantasy-world-tools', '.fantasy-world-panel'].map(sel => !!host.querySelector(sel));
  const hud = () => state.v2.at(-1)!.hud as import('./worldv2/contract').WorldV2Hud;

  // Why: the owner reviews the new HUD (tags, rail, Enter map); the old host chrome around the globe is two worlds at once.
  // The host header stays only under the opening veil (its BASE is the way out while the world loads).
  it('hides the host header, rail, tools and panel while WorldV2 is live, and restores them all on fallback', async () => {
    state.available = true;
    await render();
    expect(chrome()).toEqual([true, false, false, false]); // opening veil: BASE only
    await act(async () => (state.v2.at(-1)!.onTerrainStatus as (s: object) => void)({ ready: true, pending: false, error: null, retry: () => {} }));
    expect(chrome()).toEqual([false, false, false, false]);
    expect(host.querySelector('.fantasy-world-stage[data-tutorial-target="land-globe-cell"]')).not.toBeNull(); // the tutorial's stage stays
    await act(async () => (state.v2.at(-1)!.fallbackTo2D as (reason: string) => void)('context lost'));
    expect(state.cpu.length).toBeGreaterThan(0);
    expect(chrome()).toEqual([true, true, true, true]);
    expect(button('INSPECT LAND TILES')).toBeTruthy();
  });

  it('feeds the HUD from the host reads, and its actions are the host\'s own (money and combat paths unchanged)', async () => {
    state.available = true;
    state.data = world([{ tileId: crown.tileId, baseId: 'starter', realmId: crown.realmId, name: 'My keep', keepLevel: 2, active: true, selected: true }]);
    useApp.setState({ base: { baseId: 'starter', shield: { activeUntil: '', hoursLeft: 3, active: true } } as never });
    await render();
    expect(hud().ownShield).toEqual({ tileId: crown.tileId, shielded: true });
    useApp.setState({ base: { baseId: 'starter', shield: { activeUntil: '', hoursLeft: 3, active: true, suppressedByWarzone: true } } as never });
    await act(async () => {});
    expect(hud().ownShield).toEqual({ tileId: crown.tileId, shielded: false }); // a suppressed shield protects nothing: no dome

    // choose land: the host's own chooseLand writes landPurchase and opens Entry
    state.data = world(); state.parcel = available();
    await render();
    await act(async () => (state.v2.at(-1)!.onSelect as (t: FantasyTile) => void)(crown as FantasyTile));
    expect(hud().parcel).toEqual(expect.objectContaining({ tileId: crown.tileId, data: expect.objectContaining({ availability: 'available' }) }));
    await act(async () => hud().actions.chooseLand());
    expect(useApp.getState().landPurchase?.landAddress).toEqual({ kind: 'fantasy', worldId: 'fantasy-v1', tileId: crown.tileId });
    expect(useApp.getState().screen).toBe('entry');

    // scout and raid a rival through the host handlers
    state.parcel = rival(); useApp.setState({ screen: 'map' });
    await render();
    await act(async () => (state.v2.at(-1)!.onSelect as (t: FantasyTile) => void)(crown as FantasyTile));
    state.get.mockResolvedValue({ name: 'REAL KEEPER', keepLevel: 4, trophies: 1200, previewSec: 10 });
    await act(async () => { hud().actions.scout(); await Promise.resolve(); });
    expect(state.get).toHaveBeenCalledWith('/map/scout/defender-base?baseId=starter');
    expect(useApp.getState().screen).toBe('scout');
    useApp.setState({ screen: 'map' });
    await render();
    await act(async () => hud().actions.raid());
    expect(useApp.getState().raidTarget).toEqual(expect.objectContaining({ kind: 'pvp', wallet: 'defender-wallet', defenderBaseId: 'defender-base' }));
    expect(useApp.getState().screen).toBe('battle');
    useApp.setState({ screen: 'map' });
    await render();
    await act(async () => hud().actions.openCampaign());
    expect(useApp.getState().mapTab).toBe('campaign');
    await act(async () => hud().actions.back());
    expect(useApp.getState().screen).toBe('base');
  });
});

describe('G5: Back on the CPU-globe fallback, through the real mobile Back guard', () => {
  // Why: on a phone without WebGL2 (or after World v2 fails) the host's back chain is the player's only way out. A
  // World v2 handler (priority 110) left registered after the fallback would swallow Back on the CPU globe.
  it('peels the owner search, then the tile, then leaves to the base', async () => {
    const listeners = new Map<string, EventListener>();
    const win: MobileBackWindow = { location: { href: 'https://game.test/' },
      history: { state: null, pushState() {}, back() {} },
      addEventListener: (type, fn) => { listeners.set(type, fn); }, removeEventListener: type => { listeners.delete(type); },
      setTimeout: () => 0, clearTimeout: () => {} };
    const stop = createMobileBackGuard({ win, enabled: true, trustedActivation: () => true, getScreen: () => useApp.getState().screen,
      goToBase: () => useApp.getState().setScreen('base'), toast: () => {} });
    const pressBack = async (): Promise<void> => { await act(async () => listeners.get('popstate')!(new Event('popstate'))); };
    try {
      state.available = true; state.mode = 'stub'; // the real WorldV2 (no WebGL2 here) hands the stage to the CPU globe
      state.parcel = rival();
      await render();
      expect(state.cpu.length).toBeGreaterThan(0);
      listeners.get('pointerdown')!(new Event('pointerdown'));
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Find land owner"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'real');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(input.value).toBe('real');
      await pressBack();
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Find land owner"]')!.value).toBe('');
      await act(async () => cpu().onSelect(crown as FantasyTile));
      expect(host.textContent).toContain(`Tile ${crown.tileId}`);
      await pressBack();
      expect(host.textContent).not.toContain(`Tile ${crown.tileId}`);
      expect(useApp.getState().screen).toBe('map');
      await pressBack();
      expect(useApp.getState().screen).toBe('base');
    } finally { stop(); }
  });
});

describe('host markers keep the D-181 shield (K-188)', () => {
  // Why: the owned and inspected overlays used to rebuild the marker, so a shielded kingdom
  // lost its dome exactly when it was yours or on the card.
  it('an owned marker keeps the feed shield, and the inspected card can only add one', async () => {
    const other = { ...crown, tileId: crown.tileId + 1 };
    state.data = world([{ tileId: crown.tileId, baseId: 'assigned-base', realmId: crown.realmId, name: 'My keep', keepLevel: 2, active: true, selected: false }]);
    state.feed = [{ tileId: crown.tileId, name: 'My keep', keepLevel: 2, avatarUrl: null, shielded: true }, { tileId: other.tileId, name: 'REAL KEEPER', keepLevel: 4, avatarUrl: null, shielded: false }];
    await render();
    await act(async () => cpu().onViewChange!({ lon: 26, lat: 23, zoom: 8 }));
    const marker = (id: number) => cpu().markers!.find(m => m.tileId === id)!;
    expect(marker(crown.tileId)).toEqual(expect.objectContaining({ owned: true, shielded: true }));
    const shieldedRival = rival();
    state.parcel = { ...shieldedRival, tile: other, detail: { ...shieldedRival.detail!, shielded: true } };
    await act(async () => cpu().onSelect(other as FantasyTile));
    expect(marker(other.tileId)).toEqual(expect.objectContaining({ name: 'REAL KEEPER', shielded: true }));
  });
});

describe('K-211: a viewport re-read never empties the realm map handed to WorldV2', () => {
  // Why: under D-191 a kingdom missing from this list is hidden, and one without a shield key never passes Unshielded
  // (and takes the chip away). While a re-read was in flight the list collapsed to the own tiles, so every rival blinked
  // out mid-pan and, under Unshielded, the player's own kingdom too. Stale is fine until the next read lands (the tiles
  // are real); empty is not. The kept list is this viewer's only: another wallet must never be shown it.
  it('keeps the last settled list, shield bits included, through a pending and a failed read; a settled read replaces it', async () => {
    const east = crown.tileId + 1, west = crown.tileId + 2;
    state.available = true;
    state.data = world([{ tileId: crown.tileId, baseId: 'assigned-base', realmId: crown.realmId, name: 'My keep', keepLevel: 2, active: true, selected: false }]);
    state.feed = [{ tileId: crown.tileId, name: 'My keep', keepLevel: 2, avatarUrl: null, shielded: false },
      { tileId: east, name: 'EAST', keepLevel: 7, avatarUrl: null, shielded: false }, { tileId: west, name: 'WEST', keepLevel: 9, avatarUrl: null, shielded: true }];
    await render();
    const pan = async (lon: number): Promise<void> => {
      await act(async () => (state.v2.at(-1)!.onViewChange as (view: { lon: number; lat: number; zoom: number }) => void)({ lon, lat: 23, zoom: 8 }));
    };
    const lists = (from: number): string[][] => state.v2.slice(from).map(p => (p.markers as FantasyWorldMarker[]).map(m => `${m.tileId}:${String(m.shielded)}`).sort());
    await pan(26);
    const settled = [`${crown.tileId}:false`, `${east}:false`, `${west}:true`].sort();
    expect(lists(0).at(-1)).toEqual(settled);
    // A pan: the new box's read is in flight. Every list WorldV2 is handed meanwhile is the settled one, shields kept.
    state.feed = null; state.feedPending = true;
    let from = state.v2.length;
    await pan(26.3);
    expect(state.v2.length).toBeGreaterThan(from);
    for (const list of lists(from)) expect(list).toEqual(settled);
    // That read fails: the last good list stays.
    state.feedPending = false; state.feedError = new Error('World read failed');
    from = state.v2.length;
    await pan(26.4);
    expect(state.v2.length).toBeGreaterThan(from);
    for (const list of lists(from)) expect(list).toEqual(settled);
    // A settled read replaces it: a kingdom that left the box goes, a changed shield bit is taken.
    state.feedError = null; state.feed = [{ tileId: east, name: 'EAST', keepLevel: 7, avatarUrl: null, shielded: true }];
    await pan(26.5);
    expect(lists(0).at(-1)).toEqual([`${crown.tileId}:undefined`, `${east}:true`].sort());
    // Another viewer (the identity fence): the kept list is dropped, never shown to the next wallet.
    state.feed = null; state.feedPending = true;
    await act(async () => useApp.setState({ wallet: 'other-viewer' }));
    expect(lists(0).at(-1)).toEqual([`${crown.tileId}:undefined`]);
  });
});
