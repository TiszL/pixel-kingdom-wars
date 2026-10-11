/** @vitest-environment happy-dom */
// The World v2 root's wiring onto the frozen host contract, with the two GL engines faked. Why: the host veil lifts
// only on a ready frame; the host's parcel feed needs zoom >= 5 and the realm camera's box inside a map; Back must
// be this world's only while it has a layer to peel (else the host's chain runs); an island is inert with its
// coming-soon panel (D-182, RG-3); the intent hint follows why the player opened WORLD, and a choose-land visit
// ends its choose mode when the dive lands (native 78b20d3).
// Round 3 (L8): the L5 HUD is the world's chrome while this root is live, fed only by the host's `hud` prop. Its
// buttons must reach the host's own actions (the money and combat paths stay the host's), and its tags must say only
// what the server said.
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRUCTURES } from '@shardkeep/shared';
import { fantasyTileAt } from '@shardkeep/shared/fantasyWorld';
import type { GlobeOptions } from './globe/globe.mjs';
import type { FantasyParcelData } from '../data';
import type { WorldV2Handle, WorldV2Hud, WorldV2Props } from './contract';

const fx = vi.hoisted(() => ({
  capability: null as boolean | null,
  globes: [] as Array<{ opts: GlobeOptions; api: Record<string, unknown> }>,
  realms: [] as Array<{ host: { onSelect(id: number | null): void }; enter: ReturnType<typeof import('vitest').vi.fn>; setMarkers: ReturnType<typeof import('vitest').vi.fn>; resolve(): void; reject(e: unknown): void }>,
  back: [] as Array<{ callback: () => boolean | void; enabled: boolean; priority: number }>,
  report: vi.fn(),
}));
vi.mock('./globe/globe.mjs', () => ({
  HOST_ZOOM_MAX_GLOBE: 4.99,
  createGlobe: (_canvas: HTMLCanvasElement, opts: GlobeOptions) => {
    const api = {
      ready: Promise.resolve(), state: 'ready', asleep: false, selection: { realmId: null, islandId: null },
      setLayout() {}, setReducedMotion() {}, selectIsland: () => true, deselect() {}, focusRealm: () => true, focusIsland: () => true, setView() {},
      view: () => ({ lon: 26, lat: 23, zoom: 1 }),
      diveInto: (id: string) => { opts.on?.approach?.(id); return true; }, cancelDive: () => null, diveReady() {}, diveResult() {},
      leave: async () => {}, sleep() {}, wake: async () => {},
      snapshot: () => ({ t: [0, 0, 1], z: 0.5, realmId: null, islandId: null }), gpuBytes: () => 0, dispose() {},
    };
    fx.globes.push({ opts, api });
    return api;
  },
}));
vi.mock('./realm/adapter', () => ({
  createRealmView: async (o: { host: { onSelect(id: number | null): void } }) => {
    const realm = {
      host: o.host, resolve: () => {}, reject: (_e: unknown) => {},
      engine: { cam: { x: 0, y: 0, d: 300, s: 1, sMin: () => 1 }, flyToD() {}, setFilter: vi.fn() },
      has: () => true, prefetch() {}, setMarkers: vi.fn(), select() {}, chromeChanged() {}, leave() {}, dispose() {},
      enter: vi.fn(() => new Promise<void>((resolve, reject) => { realm.resolve = resolve; realm.reject = reject; })),
      bounds: () => ({ realmId: 'crownlands', x0: 400, y0: 120, x1: 440, y1: 150 }),
      stats: () => ({ gpuMB: { realm: 1 } }),
    };
    fx.realms.push(realm as never);
    return realm;
  },
}));
vi.mock('../worldV2Support', () => ({ worldV2Capability: async () => fx.capability, reportWorldV2Fallback: fx.report }));
vi.mock('../../../lib/mobileBackGuard', async () => {
  const react = await import('react');
  return { useMobileBackHandler: (callback: () => boolean | void, enabled = true, priority = 100) => {
    const entry = react.useRef({ callback, enabled, priority });
    entry.current.callback = callback; entry.current.enabled = enabled; entry.current.priority = priority;
    react.useEffect(() => { fx.back.push(entry.current); }, []);
  } };
});
vi.mock('../art', () => ({ loadFantasyPixels: vi.fn() }));
import { useApp } from '../../../state/store';
import WorldV2 from './WorldV2';

const original = useApp.getState();
let root: Root, host: HTMLDivElement, props: WorldV2Props, handle: { current: WorldV2Handle | null };
/** The host's feed with nothing read yet, and every action a spy. */
const hudFeed = (over: Partial<WorldV2Hud> = {}): WorldV2Hud => ({
  directory: null, parcel: { tileId: null, data: null, pending: false, failure: null, retry: vi.fn() }, ownTile: null, ownShield: null, busy: false,
  search: { query: '', setQuery: vi.fn(), results: null, pending: false, error: false, retry: vi.fn() }, explore: null,
  warzone: { active: false, open: false, panel: null }, cardExtras: null,
  actions: { scout: vi.fn(), raid: vi.fn(), chooseLand: vi.fn(), openBase: vi.fn(), manageDeed: vi.fn(), explore: vi.fn(), openCampaign: vi.fn(), back: vi.fn(), setWarzoneOpen: vi.fn() },
  ...over,
});
const settle = async (): Promise<void> => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
const mount = async (over: Partial<WorldV2Props> = {}): Promise<void> => {
  props = { view: { lon: 26, lat: 23, zoom: 1 }, markers: [], selectedTileId: null, selectedRealmId: 'crownlands', panelOpen: true, reduceMotion: false,
    onSelect: vi.fn(), onExplore: vi.fn(), onRealmSelect: vi.fn(), onViewChange: vi.fn(), onViewportChange: vi.fn(), onTerrainStatus: vi.fn(),
    onSpecialIsland: vi.fn(), onViewportBounds: vi.fn(), fallbackTo2D: vi.fn(), hud: hudFeed(), ...over };
  handle = { current: null };
  await act(async () => root.render(<WorldV2 ref={handle} {...props} />));
  await settle();
};
const globe = () => fx.globes.at(-1)!;
const back = () => fx.back.at(-1)!;
async function landInCrownlands(): Promise<void> {
  await act(async () => handle.current!.setView({ lon: 26, lat: 23, zoom: 16 }));
  await settle();
  await act(async () => globe().opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 }));
  await settle();
  await act(async () => fx.realms.at(-1)!.resolve());
  await settle();
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(fx, { capability: null, globes: [], realms: [], back: [] });
  fx.report.mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  useApp.setState({ ...original, worldIntent: null });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState(original, true); vi.restoreAllMocks(); });

describe('WorldV2 on the host contract', () => {
  it('holds the host veil until the globe draws, then reports ready', async () => {
    await mount();
    expect(props.onTerrainStatus).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false, pending: true }));
    await act(async () => globe().opts.on!.ready!());
    expect(props.onTerrainStatus).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true, pending: false, error: null }));
    expect(props.fallbackTo2D).not.toHaveBeenCalled();
  });

  it('capability false: logged, handed back to the CPU globe, and no GL engine built', async () => {
    fx.capability = false;
    await mount();
    expect(fx.globes).toHaveLength(0);
    expect(props.fallbackTo2D).toHaveBeenCalledWith(expect.stringMatching(/^capability-off/));
    expect(fx.report).toHaveBeenCalledWith(expect.stringMatching(/^capability-off/));
  });

  it('a Phase E island opens its coming-soon panel (disabled map) and tells the host; never a map', async () => {
    await mount();
    await act(async () => globe().opts.on!.pick!({ kind: 'phase-e', id: 'seeker-island', lon: -83, lat: 32 }));
    expect(props.onSpecialIsland).toHaveBeenCalledWith('seeker-island');
    expect(host.textContent).toContain('ISLAND · COMING SOON');
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Island map: coming soon"]')!.disabled).toBe(true);
    expect(fx.realms).toHaveLength(0);
    expect(back().enabled).toBe(true);
    await act(async () => { back().callback(); });
    expect(host.textContent).not.toContain('ISLAND · COMING SOON');
  });

  it('inside a realm map: zoom >= 5, the camera box, the realm chrome, taps to onSelect; Back (above 100) returns to the globe', async () => {
    await mount();
    expect(back().priority).toBeGreaterThan(100);
    expect(back().enabled).toBe(false); // nothing of ours to peel: the host's chain runs
    await landInCrownlands();
    expect(props.onViewChange).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: expect.any(Number) }));
    expect((vi.mocked(props.onViewChange!).mock.calls.at(-1)![0]).zoom).toBeGreaterThanOrEqual(5);
    expect(props.onViewportBounds).toHaveBeenLastCalledWith({ west: 20, east: 40, north: 30, south: 15 });
    expect(host.querySelector('button[aria-label="Back to globe"]')).not.toBeNull();
    const tileId = fantasyTileAt(26, 23)!.tileId;
    await act(async () => fx.realms.at(-1)!.host.onSelect(tileId));
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ tileId }));
    expect(back().enabled).toBe(true);
    await act(async () => { back().callback(); });
    await settle();
    expect(props.onViewportBounds).toHaveBeenLastCalledWith(null);
    expect(host.querySelector('button[aria-label="Back to globe"]')).toBeNull();
  });

  // Rewritten in round 3 (review minor, StrictMode): the intent used to be cleared by this root's effect cleanup,
  // which React's StrictMode also runs on its simulated unmount, so local dev never showed the hint. The rule is
  // unchanged: the intent lives for one visit to the world. The visit now ends in the store, when the screen or the
  // tab leaves the world, and an unmount on its own (StrictMode, a remount) keeps it.
  it('shows why WORLD was opened, ends choose-land when the dive lands, and forgets the intent when the visit ends', async () => {
    useApp.setState({ screen: 'map', mapTab: 'world', worldIntent: 'find-rival' });
    await mount();
    expect(host.textContent).toContain('Choose a realm to find a rival');
    await act(async () => useApp.setState({ worldIntent: 'choose-land' }));
    expect(host.textContent).toContain('Choose a realm for your land');
    await landInCrownlands();
    expect(useApp.getState().worldIntent).toBeNull();
    await act(async () => useApp.setState({ worldIntent: 'view-deeds' }));
    await act(async () => root.unmount()); root = createRoot(host);
    expect(useApp.getState().worldIntent).toBe('view-deeds'); // an unmount is not the end of the visit
    await act(async () => useApp.getState().setMapTab('campaign'));
    expect(useApp.getState().worldIntent).toBeNull();
    useApp.setState({ mapTab: 'world', worldIntent: 'find-rival' });
    await act(async () => useApp.getState().setScreen('base'));
    expect(useApp.getState().worldIntent).toBeNull();
  });

  it('StrictMode (local dev) keeps the intent through its double mount, so the hint shows', async () => {
    useApp.setState({ screen: 'map', mapTab: 'world', worldIntent: 'find-rival' });
    props = { view: { lon: 26, lat: 23, zoom: 1 }, markers: [], selectedTileId: null, selectedRealmId: 'crownlands', panelOpen: true, reduceMotion: false,
      onSelect: vi.fn(), onExplore: vi.fn(), onRealmSelect: vi.fn(), onViewChange: vi.fn(), onViewportChange: vi.fn(), onTerrainStatus: vi.fn(),
      onSpecialIsland: vi.fn(), onViewportBounds: vi.fn(), fallbackTo2D: vi.fn(), hud: hudFeed() };
    await act(async () => root.render(<StrictMode><WorldV2 {...props} /></StrictMode>));
    await settle();
    expect(useApp.getState().worldIntent).toBe('find-rival');
    expect(host.textContent).toContain('Choose a realm to find a rival');
  });

  it('"Your realms are marked": in the view-deeds visit, the realms holding your deeds are marked on the globe', async () => {
    useApp.setState({ worldIntent: 'view-deeds' });
    // a laid-out stage (happy-dom lays nothing out): 800×600, no chrome in the way
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const w = this.classList.contains('wv2-root') ? 800 : 0, h = w ? 600 : 0;
      return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
    });
    const mine = fantasyTileAt(26, 23)!;
    await mount({ markers: [{ tileId: mine.tileId, name: 'My keep', owned: true }] });
    await act(async () => globe().opts.on!.labels!([
      { kind: 'realm', id: 'crownlands', name: 'Crownlands', x: 200, y: 300 }, { kind: 'realm', id: 'frostveil', name: 'Frostveil', x: 600, y: 300 }]));
    expect(host.textContent).toContain('Your realms are marked');
    expect(host.querySelector('.wv2-label.is-mine')?.getAttribute('aria-label')).toBe('Crownlands, your bases');
    expect(host.querySelectorAll('.wv2-label.is-mine')).toHaveLength(1);
  });

  it('a failed dive shows the retry notice on the globe', async () => {
    await mount();
    await act(async () => handle.current!.setView({ lon: 26, lat: 23, zoom: 16 }));
    await settle();
    await act(async () => globe().opts.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 }));
    await settle();
    await act(async () => fx.realms.at(-1)!.reject(new Error('stalled')));
    await settle();
    expect(host.textContent).toContain('This realm map could not load — tap Enter map to retry');
  });

  it('D-181: the player\'s own /base shield reaches the realm map with the feed, so their dome never waits on the feed', async () => {
    const mine = fantasyTileAt(26, 23)!;
    const markers = [{ tileId: mine.tileId, name: 'My keep', owned: true }]; // the feed has not carried `shielded` yet
    await mount({ markers, hud: hudFeed({ ownShield: { tileId: mine.tileId, shielded: true } }) });
    await landInCrownlands();
    expect(fx.realms.at(-1)!.setMarkers).toHaveBeenCalledWith('crownlands', markers, { tileId: mine.tileId, shielded: true });
    // the shield drops on /base: the next feed carries the new own read
    await act(async () => root.render(<WorldV2 ref={handle} {...props} hud={hudFeed({ ownShield: { tileId: mine.tileId, shielded: false } })} />));
    expect(fx.realms.at(-1)!.setMarkers).toHaveBeenLastCalledWith('crownlands', markers, { tileId: mine.tileId, shielded: false });
  });

  it('D-191: the Unshielded chip sends kind "unshielded" (never the old "shield") and the level range to the engine', async () => {
    // Why: the engine hides every kingdom that fails this filter, so the kind the host sends is what the player sees.
    const mine = fantasyTileAt(26, 23)!;
    await mount({ markers: [{ tileId: mine.tileId, name: 'My keep', owned: true, shielded: true }] }); // the feed carries the key: the chip is offered
    await landInCrownlands();
    const engine = (fx.realms.at(-1) as unknown as { engine: { setFilter: ReturnType<typeof vi.fn> } }).engine;
    expect(host.querySelector('.wv2-realm-chrome [aria-label="Shielded"]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('.wv2-realm-chrome [aria-label="Unshielded"]')!.click());
    expect(engine.setFilter).toHaveBeenLastCalledWith({ kind: 'unshielded', lvl: [1, STRUCTURES.keep.maxLevel] });
    expect(engine.setFilter.mock.calls.some(c => c[0]?.kind === 'shield')).toBe(false);
  });

  it('D-191: when a read stops carrying the shield key, the Unshielded filter lets go: the engine gets "all" and All is pressed', async () => {
    // Why: the chip disappears with the key (D-181), but a predicate left behind it would keep hiding every kingdom
    // (a missing key never passes) behind a chip the player can no longer see or release.
    const mine = fantasyTileAt(26, 23)!;
    await mount({ markers: [{ tileId: mine.tileId, name: 'My keep', owned: true, shielded: false }] });
    await landInCrownlands();
    const engine = (fx.realms.at(-1) as unknown as { engine: { setFilter: ReturnType<typeof vi.fn> } }).engine;
    const chip = (label: string) => host.querySelector<HTMLButtonElement>(`.wv2-realm-chrome [aria-label="${label}"]`);
    await act(async () => chip('Unshielded')!.click());
    expect(engine.setFilter).toHaveBeenLastCalledWith({ kind: 'unshielded', lvl: [1, STRUCTURES.keep.maxLevel] });
    await act(async () => root.render(<WorldV2 ref={handle} {...props} markers={[{ tileId: mine.tileId, name: 'My keep', owned: true }]} />));
    expect(chip('Unshielded')).toBeNull();
    expect(engine.setFilter).toHaveBeenLastCalledWith({ kind: 'all', lvl: [1, STRUCTURES.keep.maxLevel] });
    expect(chip('All')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('D-191: a trip through the globe (realm clusters, no shield key) keeps the Unshielded filter for the next realm map', async () => {
    // Why: the release above is for a realm map whose read lost the key; the globe's markers are realm clusters by
    // design, so releasing there would silently drop a raider's filter every time they hop realms.
    const mine = fantasyTileAt(26, 23)!;
    const keyed = [{ tileId: mine.tileId, name: 'My keep', owned: true, shielded: false }];
    await mount({ markers: keyed });
    await landInCrownlands();
    await act(async () => host.querySelector<HTMLButtonElement>('.wv2-realm-chrome [aria-label="Unshielded"]')!.click());
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to globe"]')!.click());
    await settle();
    expect(host.querySelector<HTMLElement>('.wv2-root')!.dataset.mode).not.toBe('realm');
    await act(async () => root.render(<WorldV2 ref={handle} {...props} markers={[{ tileId: mine.tileId, name: '1 deeds', cluster: { count: 1, realmId: mine.realmId } }]} />));
    await act(async () => root.render(<WorldV2 ref={handle} {...props} markers={keyed} />));
    await landInCrownlands();
    const engine = (fx.realms.at(-1) as unknown as { engine: { setFilter: ReturnType<typeof vi.fn> } }).engine;
    expect(host.querySelector('.wv2-realm-chrome [aria-label="Unshielded"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(engine.setFilter).toHaveBeenLastCalledWith({ kind: 'unshielded', lvl: [1, STRUCTURES.keep.maxLevel] });
  });
});

const crownTile = fantasyTileAt(26, 23)!;
const rivalParcel = (attack: boolean, shield: Partial<{ active: boolean; suppressedByWarzone: boolean }> = {}): FantasyParcelData => ({
  worldId: 'fantasy-v1', tile: crownTile, availability: 'occupied', detail: {
    player: { wallet: 'defender-wallet', name: 'REAL KEEPER', avatarUrl: null, clanTag: null, seeker: false, keepLevel: 4, trophies: 1200 },
    deed: { assetId: 'asset', status: 'minted', metadata: { name: 'Land Deed', symbol: 'DEED', description: 'A base', external_url: '/deed/asset.json', image: '/deed/defender.png', attributes: [] } },
    base: { id: 'defender-base', completedStructures: 22, defenses: 6, walls: 30, landWidth: 18 },
    shield: { active: false, source: null, expiresAt: null, remainingMs: 0, suppressedByWarzone: false, ...shield },
    warzone: { active: false, boundaryAt: null, remainingMs: null }, shielded: shield.active === true,
    actions: { scout: { allowed: true, blockedBy: null }, attack: attack ? { allowed: true, blockedBy: null } : { allowed: false, blockedBy: 'shield' } },
    availableLootRanges: { oneStar: { min: '100', max: '299' }, twoStars: { min: '250', max: '599' }, threeStars: { min: '500', max: '999' } },
  } } as FantasyParcelData);
const buttonNamed = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text);

describe('the World v2 HUD (L5) mounted on the host feed', () => {
  it('header and rail: BASE and CAMPAIGN call the host; 8 realms + 3 island chips + "Find a keeper…"; an island chip opens its panel', async () => {
    await mount();
    expect(host.querySelector('.wv2-header h1')!.textContent).toBe('WORLD MAPShattered Realms');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back to base"]')!.click());
    await act(async () => buttonNamed('CAMPAIGN')!.click());
    expect(props.hud.actions.back).toHaveBeenCalledOnce();
    expect(props.hud.actions.openCampaign).toHaveBeenCalledOnce();
    const dests = [...host.querySelectorAll<HTMLButtonElement>('.wv2-rail [data-dest]')];
    expect(dests.map(d => d.dataset.dest)).toEqual([
      'realm:frostveil', 'realm:elderwood', 'realm:sunscar', 'realm:crownlands', 'realm:seeker-reach', 'realm:stormcairn', 'realm:thornwake', 'realm:cinderfall',
      'island:seeker-island', 'island:solana-island', 'island:divine-isle']);
    expect(host.querySelector('.wv2-rail [aria-label="Find a keeper"]')).not.toBeNull();
    expect(host.querySelector('.fantasy-world-tools')).toBeNull(); // nothing of the host's old chrome in the world
    await act(async () => host.querySelector<HTMLButtonElement>('[data-dest="island:divine-isle"]')!.click());
    expect(props.onSpecialIsland).toHaveBeenCalledWith('divine-isle');
    expect(host.textContent).toContain('ISLAND · COMING SOON');
    expect(host.querySelector('.wv2-panel h2')!.textContent).toBe('Divine Isle');
  });

  it('"Find a keeper…" searches through the host and a pick selects and flies to that kingdom', async () => {
    const results = [{ tileId: crownTile.tileId, realmId: crownTile.realmId, name: 'REAL KEEPER', keepLevel: 4, trophies: 1200, seeker: false }];
    await mount({ hud: hudFeed({ search: { query: 'real', setQuery: vi.fn(), results, pending: false, error: false, retry: vi.fn() } }) });
    const diveInto = vi.spyOn(globe().api as { diveInto(id: string): boolean }, 'diveInto');
    await act(async () => host.querySelector<HTMLButtonElement>('.wv2-rail .wv2-row')!.click());
    expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ tileId: crownTile.tileId }));
    expect(diveInto).toHaveBeenCalledWith('crownlands');
  });

  it('a realm panel offers Enter map in every mode, choose-land included, and Enter map dives (setView 16)', async () => {
    useApp.setState({ worldIntent: 'choose-land' });
    await mount({ hud: hudFeed({ directory: { worldId: 'fantasy-v1', catalogHash: '', ready: true,
      realms: [{ realmId: 'sunscar', total: 900, occupied: 12, held: 0, available: 888, anchorTileId: null }],
      me: { baseId: null, selectedTileId: null, ownedTiles: [] } } }) });
    expect(host.querySelector('.wv2-panel')).toBeNull(); // no panel until the player picks a realm
    await act(async () => host.querySelector<HTMLButtonElement>('[data-dest="realm:sunscar"]')!.click());
    expect(props.onRealmSelect).toHaveBeenCalledWith('sunscar');
    expect(host.querySelector('.wv2-header h1')!.textContent).toBe('WORLD MAPSunscar');
    expect(host.querySelector('.wv2-stats')!.textContent).toContain('888');
    expect(buttonNamed('Choose land here')).toBeTruthy();
    const diveInto = vi.spyOn(globe().api as { diveInto(id: string): boolean }, 'diveInto');
    await act(async () => buttonNamed('Enter map')!.click());
    await settle();
    expect(diveInto).toHaveBeenCalledWith('sunscar');
  });

  it('"You can attack" shows exactly when the server allows the raid, and the card\'s actions are the host\'s', async () => {
    const read = (data: FantasyParcelData) => ({ tileId: crownTile.tileId, data, pending: false, failure: null, retry: vi.fn() });
    await mount({ selectedTileId: crownTile.tileId, hud: hudFeed({ parcel: read(rivalParcel(true)) }) });
    expect(host.querySelector('.wv2-tags')!.textContent).toBe('You can attack');
    await act(async () => buttonNamed('Scout')!.click());
    await act(async () => buttonNamed('Raid')!.click());
    expect(props.hud.actions.scout).toHaveBeenCalledOnce();
    expect(props.hud.actions.raid).toHaveBeenCalledOnce();
    await act(async () => root.render(<WorldV2 ref={handle} {...props} hud={hudFeed({ parcel: read(rivalParcel(false, { active: true })) })} />));
    expect(host.querySelector('.wv2-tags')!.textContent).toBe('Shielded');
    expect(buttonNamed('Raid')!.disabled).toBe(true);
    await act(async () => root.render(<WorldV2 ref={handle} {...props} hud={hudFeed({ parcel: read(rivalParcel(false, { active: true, suppressedByWarzone: true })) })} />));
    expect(host.querySelector('.wv2-tags')!.textContent).toBe('Shield suppressed');
  });

  it('your own deed reads "Your base" and opens through the host; open land chooses through the host at the tutorial anchor', async () => {
    const own = { tileId: crownTile.tileId, baseId: 'my-base', realmId: crownTile.realmId, name: 'My keep', keepLevel: 2, active: true, selected: true };
    await mount({ selectedTileId: crownTile.tileId, hud: hudFeed({ ownTile: own,
      parcel: { tileId: crownTile.tileId, data: { worldId: 'fantasy-v1', tile: crownTile, availability: 'occupied', detail: null }, pending: false, failure: null, retry: vi.fn() } }) });
    expect(host.querySelector('.wv2-tags')!.textContent).toBe('Your base');
    await act(async () => buttonNamed('Open base')!.click());
    expect(props.hud.actions.openBase).toHaveBeenCalledWith('my-base');
    const open = hudFeed({ parcel: { tileId: crownTile.tileId, data: { worldId: 'fantasy-v1', tile: crownTile, availability: 'available', detail: null }, pending: false, failure: null, retry: vi.fn() } });
    await act(async () => root.render(<WorldV2 ref={handle} {...props} hud={open} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-tutorial-target="land-globe-confirm"]')!.click());
    expect(open.actions.chooseLand).toHaveBeenCalledOnce();
  });
});
