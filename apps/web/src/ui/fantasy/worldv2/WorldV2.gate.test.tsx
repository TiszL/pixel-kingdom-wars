/** @vitest-environment happy-dom */
// The kill-switch matrix and the paid-land path, end to end through the real host (FantasyWorldLayer), the real gate
// (worldV2Support) and the real WorldV2 root, with only the GL engines, the network and the parcel reads faked.
// Why:
//   * flag off: production must not download the world chunk at all until the owner turns it on (first paint and
//     the TWA's data budget) — asserted on the dynamic import itself;
//   * no WebGL2, or a software rasteriser without ?worldv2=force: the CPU globe, without fetching the chunk;
//   * capability false: the shared D-180 switch sends the visit back to the CPU globe; no answer in time keeps the
//     build default (a slow API must never switch a working world off);
//   * choose land: tile -> CHOOSE LAND (the tutorial's land-globe-confirm anchor) -> landPurchase -> Entry is the
//     paid-land path (entryPaidAt = land ownership); World v2 must reach it exactly as the CPU globe does, with the
//     stage (land-globe-cell) around the World v2 canvas.
//   * round 3 (L8): the player reaches all of it through the World v2 HUD (the host's own chrome is hidden while
//     World v2 is live): RealmPanel's Enter map dives, the KingdomCard carries CHOOSE LAND's tutorial anchor, and its
//     "You can attack" tag is the server's actions.attack.allowed, never a guess.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fantasyTileAt, type FantasyTile } from '@shardkeep/shared/fantasyWorld';
import type { BasesDto } from '../../../lib/api';
import type { FantasyGlobeData, FantasyParcelData } from '../data';
import type { FantasyGlobeProps } from '../FantasyGlobe';
import type { GlobeOptions } from './globe/globe.mjs';

const fx = vi.hoisted(() => ({
  imported: false, cpu: 0, parcel: null as FantasyParcelData | null,
  get: vi.fn(), track: vi.fn(),
  globes: [] as GlobeOptions[], unavailable: false, realms: [] as Array<{ host: { onSelect(id: number | null): void }; resolve(): void }>,
}));
vi.mock('./WorldV2', async importOriginal => { fx.imported = true; return importOriginal(); });
vi.mock('../../../lib/api', async importOriginal => ({ ...await importOriginal<typeof import('../../../lib/api')>(), api: { get: fx.get } }));
vi.mock('../../../lib/analytics', () => ({ EVENTS: { WORLD_V2_FALLBACK: 'world_v2_fallback' }, track: fx.track }));
vi.mock('../data', async importOriginal => ({
  ...await importOriginal<typeof import('../data')>(),
  useFantasyDirectory: () => ({ data: world, pending: false, error: null, retry: vi.fn() }),
  useFantasyParcel: (_a: unknown, tileId: number | null) => ({ data: tileId === null ? null : fx.parcel, pending: false, error: null, retry: vi.fn() }),
  useFantasyViewport: () => ({ data: null, pending: false, error: null, retry: vi.fn() }),
  useFantasySearch: () => ({ data: [], pending: false, error: null, retry: vi.fn() }),
}));
vi.mock('../FantasyGlobe', async importOriginal => {
  const actual = await importOriginal<typeof import('../FantasyGlobe')>(), react = await import('react');
  return { ...actual, FantasyGlobe: react.forwardRef<unknown, FantasyGlobeProps>((props, ref) => {
    fx.cpu++;
    react.useEffect(() => props.onTerrainStatus?.({ ready: true, pending: false, error: null, retry: () => {} }), [props.onTerrainStatus]);
    react.useImperativeHandle(ref, () => ({ focusTile() {}, focusRealm() {}, focusIsland() {}, setView() {}, view: () => ({ lon: 26, lat: 23, zoom: 1 }), stats: () => null }));
    return react.createElement('div', { 'data-cpu-globe': '' });
  }) };
});
vi.mock('./globe/globe.mjs', () => ({
  HOST_ZOOM_MAX_GLOBE: 4.99,
  createGlobe: (_canvas: HTMLCanvasElement, opts: GlobeOptions) => {
    fx.globes.push(opts);
    queueMicrotask(() => (fx.unavailable ? opts.on?.unavailable?.('GPU gave up') : opts.on?.ready?.()));
    return { ready: Promise.resolve(), state: 'ready', asleep: false, selection: { realmId: null, islandId: null },
      setLayout() {}, setReducedMotion() {}, selectIsland: () => true, deselect() {}, focusRealm: () => true, focusIsland: () => true, setView() {},
      view: () => ({ lon: 26, lat: 23, zoom: 1 }), diveInto: (id: string) => { opts.on?.approach?.(id); return true; }, cancelDive: () => null,
      diveReady() {}, diveResult() {}, leave: async () => {}, sleep() {}, wake: async () => {},
      snapshot: () => ({ t: [0, 0, 1], z: 0.5, realmId: null, islandId: null }), gpuBytes: () => 0, dispose() {} };
  },
}));
vi.mock('./realm/adapter', () => ({
  createRealmView: async (o: { host: { onSelect(id: number | null): void } }) => {
    const realm = { host: o.host, resolve: () => {},
      engine: { cam: { x: 0, y: 0, d: 300, s: 1, sMin: () => 1 }, flyToD() {}, setFilter() {} },
      has: () => true, prefetch() {}, setMarkers() {}, select() {}, chromeChanged() {}, leave() {}, dispose() {},
      enter: () => new Promise<void>(resolve => { realm.resolve = resolve; }),
      bounds: () => ({ realmId: 'crownlands', x0: 400, y0: 120, x1: 440, y1: 150 }), stats: () => ({ gpuMB: { realm: 1 } }) };
    fx.realms.push(realm);
    return realm;
  },
}));
vi.mock('../art', () => ({ loadFantasyPixels: vi.fn() }));
vi.mock('../../../state/baseSnapshot', () => ({ selectBaseSnapshot: vi.fn() }));
vi.mock('../../../lib/events', () => ({ bus: { emit: vi.fn() } }));
vi.mock('../FantasyShieldStatus', () => ({ FantasyShieldStatus: () => null }));
import { useApp } from '../../../state/store';
import { resetWorldV2Probe } from '../worldV2Support';
import { FantasyWorldLayer } from '../FantasyWorldLayer';

const crown = fantasyTileAt(26, 23)!;
const world: FantasyGlobeData = { worldId: 'fantasy-v1', catalogHash: '', ready: true, realms: [], me: { baseId: 'starter', selectedTileId: null, ownedTiles: [] } };
const directory = (): BasesDto => ({ enabled: true, worldId: 'fantasy-v1', maxActive: 5, nextLandPurchaseKind: 'entry',
  capabilities: { baseScopedReads: true, baseScopedMutations: true, cellReservations: true },
  bases: [{ id: 'starter', deedAssetId: null, status: 'active', keepLevel: 1, builders: 1, expansions: 0, landPaidAt: null, slot: 1, earthCell: null, countryA3: null }] });
const available = (): FantasyParcelData => ({ worldId: 'fantasy-v1', tile: crown as FantasyTile, availability: 'available', detail: null });

const original = useApp.getState();
let root: Root, host: HTMLDivElement;
/** The device's WebGL2 answer: null (none), or a renderer string. */
function device(renderer: string | null): void {
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const node = create(tag);
    if (tag === 'canvas') Object.defineProperty(node, 'getContext', { value: () => (renderer === null ? null : {
      RENDERER: 0x1f01, getParameter: (n: number) => (n === 0x9246 ? renderer : 'WebKit WebGL'),
      getExtension: (name: string) => (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : name === 'WEBGL_lose_context' ? { loseContext() {} } : null) }) });
    return node;
  }) as typeof document.createElement);
}
const settle = async (ms = 0): Promise<void> => { await act(async () => { await new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
async function render(): Promise<void> {
  await act(async () => root.render(<FantasyWorldLayer />));
  for (let tick = 0; tick < 200 && !fx.cpu && !host.querySelector('.wv2-root'); tick++) await settle(5);
  await settle();
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetWorldV2Probe();
  Object.assign(fx, { cpu: 0, parcel: null, globes: [], realms: [], unavailable: false });
  fx.get.mockReset(); fx.track.mockReset();
  fx.get.mockResolvedValue({ protocolVersion: 1, worldV2: { enabled: true } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  useApp.setState({ ...original, wallet: 'viewer', selectedBaseId: 'starter', entryPaid: false, baseDirectory: directory(), screen: 'map', mapTab: 'world', landPurchase: null, worldIntent: 'choose-land' });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  useApp.setState(original, true); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('World v2 kill-switch matrix (through the host)', () => {
  // These three run first on purpose: React.lazy caches the chunk, so "never imported" is only observable before
  // any test loads it.
  it('flag off: the CPU globe, and the world chunk is never imported, the GPU never probed, the capability never read', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '0');
    device('Adreno (TM) 740');
    await render();
    expect(fx.cpu).toBeGreaterThan(0);
    expect(fx.imported).toBe(false);
    expect(fx.get).not.toHaveBeenCalled();
  });

  it('flag on without WebGL2: the CPU globe without fetching the chunk, and the reason is logged', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    device(null);
    await render();
    expect(fx.cpu).toBeGreaterThan(0);
    expect(fx.imported).toBe(false);
    expect(fx.track).toHaveBeenCalledWith('world_v2_fallback', { reason: expect.stringMatching(/^no-webgl2/) });
  });

  it('flag on, SwiftShader without ?worldv2=force: the CPU globe without fetching the chunk', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    device('Google SwiftShader');
    await render();
    expect(fx.cpu).toBeGreaterThan(0);
    expect(fx.imported).toBe(false);
  });

  it('capability false: World v2 hands the visit to the CPU globe, and later visits skip the chunk', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    device('Adreno (TM) 740');
    fx.get.mockResolvedValue({ protocolVersion: 1, worldV2: { enabled: false } });
    await render();
    for (let tick = 0; tick < 100 && !fx.cpu; tick++) await settle(5);
    expect(fx.cpu).toBeGreaterThan(0);
    expect(fx.globes).toHaveLength(0);
    expect(fx.track).toHaveBeenCalledWith('world_v2_fallback', { reason: expect.stringMatching(/^capability-off/) });
    await act(async () => root.unmount()); root = createRoot(host); fx.cpu = 0;
    await render();
    expect(fx.cpu).toBeGreaterThan(0);
    expect(host.querySelector('.wv2-root')).toBeNull();
  });

  it('no capability answer within the timeout: the build default (World v2) stands', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    device('Adreno (TM) 740');
    fx.get.mockReturnValue(new Promise(() => {}));
    await render();
    expect(host.querySelector('.wv2-root')).not.toBeNull();
    expect(fx.globes).toHaveLength(0); // waiting on the switch, not guessing
    await settle(3_100);
    expect(fx.globes).toHaveLength(1);
    expect(fx.cpu).toBe(0);
  }, 10_000);
});

async function liveInCrownlands(): Promise<void> {
  vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
  device('Adreno (TM) 740');
  await render();
  await settle();
  expect(fx.cpu).toBe(0);
  await act(async () => host.querySelector<HTMLButtonElement>('[data-dest="realm:crownlands"]')!.click());
  await act(async () => button('Enter map').click());
  await settle();
  await act(async () => fx.globes[0]!.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 }));
  await settle();
  await act(async () => fx.realms[0]!.resolve());
  await settle();
}

describe('choose land through World v2 (the paid-land path)', () => {
  // Rewritten in round 3: the path used the host panel's INSPECT LAND TILES and CHOOSE THIS LAND, which the host now
  // hides while World v2 is live. The rule is unchanged (the tile, the tutorial's CHOOSE LAND anchor, landPurchase,
  // Entry); the player now reaches it through the HUD: rail -> RealmPanel Enter map -> tile -> KingdomCard.
  it('tile on the realm map -> CHOOSE LAND (tutorial anchor) -> landPurchase written -> Entry', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    device('Adreno (TM) 740');
    fx.parcel = available();
    await render();
    await settle();
    expect(fx.cpu).toBe(0);
    // the tutorial's stage anchor is the section around the World v2 canvas
    const stage = host.querySelector('[data-tutorial-target="land-globe-cell"]')!;
    expect(stage.querySelector('.wv2-root')).not.toBeNull();
    expect(host.querySelector('.fantasy-world-loading')).toBeNull(); // the globe's ready frame lifted the veil
    expect(host.querySelector('.fantasy-world-panel')).toBeNull(); // the host's panel is hidden: the HUD is the chrome
    await act(async () => host.querySelector<HTMLButtonElement>('[data-dest="realm:crownlands"]')!.click());
    expect(button('Choose land here')).toBeTruthy(); // choose mode leads...
    await act(async () => button('Enter map').click()); // ...and Enter map stays (owner, code 31b)
    await settle();
    await act(async () => fx.globes[0]!.on!.dive!({ realmId: 'crownlands', lon: 26, lat: 23, sStart: 18 }));
    await settle();
    await act(async () => fx.realms[0]!.resolve());
    await settle();
    expect(useApp.getState().worldIntent).toBeNull(); // choose mode ends when the dive lands (native 78b20d3)
    await act(async () => fx.realms[0]!.host.onSelect(crown.tileId));
    const confirm = host.querySelector<HTMLButtonElement>('[data-tutorial-target="land-globe-confirm"]');
    expect(confirm).not.toBeNull();
    expect(stage.contains(confirm)).toBe(true);
    await act(async () => confirm!.click());
    expect(useApp.getState().landPurchase?.landAddress).toEqual({ kind: 'fantasy', worldId: 'fantasy-v1', tileId: crown.tileId });
    expect(useApp.getState().screen).toBe('entry');
  });
});

describe('the World v2 HUD through the real host', () => {
  const rival = (attack: boolean): FantasyParcelData => ({ worldId: 'fantasy-v1', tile: crown as FantasyTile, availability: 'occupied', detail: {
    player: { wallet: 'defender-wallet', name: 'REAL KEEPER', avatarUrl: null, clanTag: null, seeker: false, keepLevel: 4, trophies: 1200 },
    deed: { assetId: 'asset', status: 'minted', metadata: { name: 'Land Deed', symbol: 'DEED', description: 'A base', external_url: '/deed/asset.json', image: '/deed/defender.png', attributes: [] } },
    base: { id: 'defender-base', completedStructures: 22, defenses: 6, walls: 30, landWidth: 18 },
    shield: { active: false, source: null, expiresAt: null, remainingMs: 0, suppressedByWarzone: false },
    warzone: { active: false, boundaryAt: null, remainingMs: null }, shielded: false,
    actions: { scout: { allowed: true, blockedBy: null }, attack: attack ? { allowed: true, blockedBy: null } : { allowed: false, blockedBy: 'keep_reach', keepReach: { min: 1, max: 3 } } },
    availableLootRanges: { oneStar: { min: '100', max: '299' }, twoStars: { min: '250', max: '599' }, threeStars: { min: '500', max: '999' } },
  } } as FantasyParcelData);

  // Why (review blocker, owner code 31): "You can attack" is the server's word. Shown for a raid the server refuses,
  // it sends the player into a failed attack; hidden when allowed, it hides the rival the owner asked to surface.
  it('"You can attack" iff the parcel read allows the raid; RAID and SCOUT go through the host', async () => {
    useApp.setState({ worldIntent: null });
    fx.parcel = rival(true);
    await liveInCrownlands();
    await act(async () => fx.realms[0]!.host.onSelect(crown.tileId));
    expect(host.querySelector('.wv2-card .wv2-tags')!.textContent).toBe('You can attack');
    fx.get.mockResolvedValue({ name: 'REAL KEEPER', keepLevel: 4, trophies: 1200, previewSec: 10 });
    await act(async () => { button('Scout').click(); for (let i = 0; i < 4; i++) await Promise.resolve(); });
    expect(fx.get).toHaveBeenCalledWith('/map/scout/defender-base?baseId=starter');
    expect(useApp.getState().screen).toBe('scout');
    useApp.setState({ screen: 'map' });
    await act(async () => button('Raid').click());
    expect(useApp.getState().raidTarget).toEqual(expect.objectContaining({ kind: 'pvp', wallet: 'defender-wallet', defenderBaseId: 'defender-base' }));
    expect(useApp.getState().screen).toBe('battle');
  });

  it('no tag and a disabled RAID, with the host\'s reason, when the server refuses the raid', async () => {
    useApp.setState({ worldIntent: null });
    fx.parcel = rival(false);
    await liveInCrownlands();
    await act(async () => fx.realms[0]!.host.onSelect(crown.tileId));
    expect(host.querySelector('.wv2-card .wv2-tags')).toBeNull();
    expect(button('Raid').disabled).toBe(true);
    expect(host.querySelector('.wv2-card')!.textContent).toMatch(/keep/i);
  });

  it('a World v2 failure after the HUD was live brings back the whole host chrome on the CPU globe', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    device('Adreno (TM) 740');
    fx.unavailable = true;
    await render();
    for (let tick = 0; tick < 100 && !fx.cpu; tick++) await settle(5);
    expect(fx.cpu).toBeGreaterThan(0);
    expect(host.querySelector('.wv2-root')).toBeNull();
    for (const sel of ['.fantasy-world-top', '.fantasy-realm-rail', '.fantasy-world-tools', '.fantasy-world-panel']) expect(host.querySelector(sel)).not.toBeNull();
    expect(button('INSPECT LAND TILES')).toBeTruthy();
  });
});
