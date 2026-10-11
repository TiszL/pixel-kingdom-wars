// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MapFeatureDestination } from '../../Overlay';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({
  enabled: true, state: { wallet: 'wallet-a', authed: true, selectedBaseId: 'base-a', baseSelectionEpoch: 4,
    screen: 'map', mapTab: 'world', baseDirectory: null, booted: true, setScreen: vi.fn() },
  listeners: new Set<() => void>(), backs: new Map<symbol, { callback: () => unknown; priority: number }>(),
  trials: [] as boolean[], fragments: [] as boolean[], cleanup: [] as string[], dismiss: vi.fn(),
}));
vi.mock('../../../state/store', () => ({ useApp: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state),
  { getState: () => fixture.state, subscribe: (fn: () => void) => { fixture.listeners.add(fn); return () => { fixture.listeners.delete(fn); }; } },
) }));
vi.mock('../../phaseE/webHold', () => ({ phaseEWebEnabled: () => fixture.enabled }));
vi.mock('../../../lib/divineTrials/useDivineTrials', () => ({ useDivineTrials: (actionsEnabled: boolean) => {
  fixture.trials.push(actionsEnabled);
  useEffect(() => () => { fixture.cleanup.push('trials'); }, []);
  return { state: { loaded: true, busy: false, journal: null, eventId: null, error: null, page: null }, run: vi.fn(), actionsAllowed: actionsEnabled };
} }));
vi.mock('../../../lib/divineFragments/useDivineFragments', () => ({ useDivineFragments: (actionsEnabled: boolean) => {
  fixture.fragments.push(actionsEnabled);
  useEffect(() => () => { fixture.cleanup.push('fragments'); }, []);
  return { state: { loaded: true, busy: false, journal: null, review: null, error: null, awards: null, terms: null, termsCursor: null, stock: null, policy: null },
    baseId: 'base-a', run: vi.fn(), refresh: vi.fn(), dismiss: fixture.dismiss, actionsAllowed: actionsEnabled };
} }));
vi.mock('../../../lib/divineTrials/battleSession', () => ({ beginDivineBattle: vi.fn() }));
// The real originals, EconomyPanel and ModalWrap remain in this test. Only the
// platform registry is probed; no history stack, controller, IDB or RPC starts.
vi.mock('../../../lib/mobileBackGuard', () => ({ useMobileBackHandler: (callback: () => unknown, enabled: boolean, priority: number) => {
  const latest = useRef(callback); latest.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const key = Symbol(); fixture.backs.set(key, { callback: () => latest.current(), priority });
    return () => { fixture.backs.delete(key); };
  }, [enabled, priority]);
} }));
vi.mock('../../../lib/gameViewport', () => ({ visibleParentInsets: () => ({ top: 0, bottom: 0 }), subscribeGameViewport: () => () => {} }));
// Only the visual header style is stubbed; the original dialog behavior stays real.
vi.mock('../../hudChrome', () => ({ hudStripStyle: () => ({}) }));
vi.mock('../../icons', () => ({ ICONS: {}, sprite: () => ({}), troopPortrait: () => '' }));
vi.mock('../../loading/GameLoading', () => ({ GameLoading: () => <div>Loading map</div> }));
vi.mock('../../scoutNavigation', () => ({ openScout: vi.fn() }));
vi.mock('../../RaidEntryCost', () => ({ RaidEntryCost: () => null }));
vi.mock('../../../lib/api', () => ({ api: {} }));
vi.mock('../../../lib/baseSelection', () => ({ selectedBasePath: vi.fn() }));
vi.mock('../../../lib/events', () => ({ bus: { on: vi.fn(), emit: vi.fn() } }));
vi.mock('../../useFetch', () => ({ useFetch: vi.fn() }));
vi.mock('../../screens/seeker', () => ({ PlayerName: () => null, SeekerBadge: () => null }));
vi.mock('../../layout', () => ({ MAPCHROME: {}, mapChrome: vi.fn(), hitSizeAt: vi.fn(), useSafeAreaInsets: vi.fn(), useWindowSize: vi.fn() }));
vi.mock('../../mapChromeUI', () => ({ MAP_DBL: {}, chromeDrifted: vi.fn(), chromePanGuard: vi.fn(), IconBtn: () => null,
  IconRail: () => null, MapSheet: () => null, MapTopBar: () => null, RegionPlate: () => null, UnderBar: () => null, ZoomRail: () => null }));
vi.mock('../../mapAtlas', () => ({ useMapAtlas: vi.fn() }));
vi.mock('../../mapTiles', () => ({ bakeTileField: vi.fn(), tileFrameIndex: vi.fn() }));
vi.mock('../../screens/mapTerrain', () => ({ CAMPAIGN_ACTS: [], WORLD_ZONES: [], campaignTerrain: vi.fn(), groundFrameAt: vi.fn(), spriteAt: vi.fn(), suppressTerrainOverlay: vi.fn(), terrainTransformAt: vi.fn(), worldTerrain: vi.fn() }));
vi.mock('../../screens/globe/globeView', () => ({ railRowsForWorld: vi.fn() }));
vi.mock('../../screens/globe/GlobeLayer', () => ({ GlobeLayer: ({ openSeq }: { openSeq: number }) => <input data-world="globe" data-open-seq={openSeq} defaultValue="home" /> }));
vi.mock('../../fantasy/FantasyWorldLayer', () => ({ FantasyWorldLayer: () => <input data-world="fantasy" defaultValue="home" /> }));

let root: Root;
let MapScreen: typeof import('../../screens/map').MapScreen;
const target = (featureId: MapFeatureDestination['featureId']): MapFeatureDestination =>
  ({ featureId, wallet: 'wallet-a', baseId: 'base-a', epoch: 4, generation: 1 });
async function draw(destination: MapFeatureDestination | null, onClose: () => void, actionsEnabled = true) {
  await act(async () => root.render(<MapScreen destination={destination} onClose={onClose} actionsEnabled={actionsEnabled} />));
  // The committed render can still be the null fallback for the real lazy screen.
  // Settle that import in a separate act before checking its modal and effects.
  await act(async () => { await vi.dynamicImportSettled(); });
}
beforeEach(async () => {
  vi.resetModules(); vi.stubEnv('VITE_FEATURE_FANTASY_WORLD', '0');
  fixture.enabled = true; fixture.listeners.clear(); fixture.backs.clear(); fixture.trials = []; fixture.fragments = []; fixture.cleanup = [];
  fixture.dismiss.mockClear(); fixture.state.screen = 'map'; fixture.state.mapTab = 'world';
  MapScreen = (await import('../../screens/map')).MapScreen;
  const node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllEnvs(); });

for (const id of ['map.divineTrials', 'map.divineFragments'] as const) {
  for (const closeBy of ['escape', 'backdrop', 'button', 'back'] as const) {
    test(`${id}: ${closeBy} path honors the original/held route and leaves the actual MapScreen world sibling intact`, async () => {
      const close = vi.fn(); await draw(null, close);
      const world = document.querySelector<HTMLInputElement>('[data-world]')!; world.value = 'panned'; world.focus();
      await draw(target(id), close);
      if (id === 'map.divineTrials') {
        // 188719c1: the old four Trial-dismissal cases now pin the held route.
        expect(close).toHaveBeenCalledTimes(1); expect(fixture.trials).toEqual([]);
        expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(fixture.backs.size).toBe(0);
        expect(document.querySelector('[data-world]')).toBe(world); expect(world.value).toBe('panned');
        expect(document.activeElement).toBe(world); return;
      }
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(fixture.backs.size).toBe(1); expect([...fixture.backs.values()][0]?.priority).toBe(300);
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(document.activeElement).toBe(dialog);
      act(() => {
        if (closeBy === 'escape') dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        if (closeBy === 'backdrop') dialog.parentElement!.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        if (closeBy === 'button') dialog.querySelector<HTMLButtonElement>(`[aria-label="Close ${dialog.getAttribute('aria-label')}"]`)!.click();
        if (closeBy === 'back') [...fixture.backs.values()][0]!.callback();
      });
      expect(close).toHaveBeenCalledTimes(1); expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(fixture.backs.size).toBe(0); expect(fixture.cleanup).toHaveLength(1);
      expect(document.querySelector('[data-world]')).toBe(world); expect(world.value).toBe('panned');
      expect(world.getAttribute('data-open-seq')).toBe('1'); expect(document.activeElement).toBe(world);
      if (id === 'map.divineFragments') expect(fixture.dismiss).toHaveBeenCalledTimes(1);
    });
  }
  test(`${id}: live capability honors the original/held route without resetting its owner`, async () => {
    const close = vi.fn(); await draw(target(id), close, true); const dialog = document.querySelector('[role="dialog"]');
    await draw(target(id), close, false);
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    await draw(target(id), close, true);
    expect(document.querySelector('[role="dialog"]')).toBe(dialog); expect(fixture.cleanup).toEqual([]);
    if (id === 'map.divineTrials') {
      expect(fixture.trials).toEqual([]); expect(dialog).toBeNull(); expect(close).toHaveBeenCalledTimes(1);
    } else {
      expect(fixture.fragments).toContain(false); expect(fixture.fragments.at(-1)).toBe(true);
    }
  });
}

test('R0 OFF retains the ordinary world and does not mount either original hook', async () => {
  fixture.enabled = false; await draw(target('map.divineFragments'), vi.fn());
  expect(document.querySelector('[data-world]')).not.toBeNull();
  expect(fixture.trials).toEqual([]); expect(fixture.fragments).toEqual([]); expect(fixture.backs.size).toBe(0);
});

test('the optional target leaves ordinary map callers unchanged', async () => {
  await act(async () => root.render(<MapScreen actionsEnabled={false} />));
  expect(document.querySelector('[data-world="globe"]')).not.toBeNull();
  expect(fixture.trials).toEqual([]); expect(fixture.fragments).toEqual([]);
});
test('the fantasy board also keeps its identity and local state while the original modal opens and closes', async () => {
  vi.stubEnv('VITE_FEATURE_FANTASY_WORLD', '1'); vi.resetModules();
  MapScreen = (await import('../../screens/map')).MapScreen;
  const close = vi.fn(); await draw(null, close);
  const world = document.querySelector<HTMLInputElement>('[data-world="fantasy"]')!;
  expect(world).not.toBeNull(); world.value = 'panned fantasy';
  await draw(target('map.divineFragments'), close);
  act(() => { document.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(close).toHaveBeenCalledTimes(1); expect(document.querySelector('[data-world]')).toBe(world);
  expect(world.value).toBe('panned fantasy');
});
