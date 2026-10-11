/** @vitest-environment happy-dom */
import { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp, type BaseStateDto } from '../state/store';
import { bus } from '../lib/events';
import { api } from '../lib/api';
import { Overlay, type MapFeatureDestination, type MapFeatureId } from './Overlay';

vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: null }), useWallet: () => ({}) }));
vi.mock('@privy-io/react-auth', () => ({ usePrivy: () => ({}), useSolanaWallets: () => ({ wallets: [] }) }));
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ signIn: vi.fn(), signingIn: false, error: null }) }));
vi.mock('../auth/useSocialAuth', () => ({ useSocialAuth: () => ({}) }));
vi.mock('../auth/useSignOut', () => ({ useSignOut: () => vi.fn() }));
vi.mock('../auth/useWalletSessionFence', () => ({ useWalletSessionFence: () => undefined }));
vi.mock('../auth/useOptionalReferral', () => ({ useOptionalReferral: () => undefined }));
vi.mock('../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, sendTransaction: null, signMessage: null }) }));
vi.mock('../auth/useEntry', () => ({ usePayEntry: () => ({ phase: 'idle' }) }));
vi.mock('./useFetch', () => ({ useFetch: () => ({ data: null, reload: vi.fn() }) }));
vi.mock('./useMineStatus', () => ({ useMineStatus: () => ({ data: null, reload: vi.fn() }) }));
vi.mock('./useSolBalance', () => ({ useSolBalance: () => null }));
vi.mock('./chat/ChatLauncher', () => ({ ChatLauncher: () => null }));
vi.mock('./RaidUI', () => ({ RaidUI: () => null }));
vi.mock('./sheets', () => ({ ActionSheet: () => null, ObstacleSheet: () => null, BuildTray: () => null }));


import { createPanelSession, type PanelDismissRequest } from './pk/panelSession';
import { HudOverflowPanel, type HudOverflowProps } from './hudOverflow';
import { RaidChooser } from './RaidChooser';
import type { SheetInset } from './pk/p2Types';

const sheet = vi.hoisted(() => ({ publish: null as ((inset: SheetInset | null) => void) | null }));
// G2 observes the real BaseHud publisher with an explicit host geometry source.
// G1 already separately mounts the real OverlayHost and real SheetHost.
vi.mock('./pk/OverlayHost', () => ({ OverlayHost: ({ onInset, children }: {
  onInset: (inset: SheetInset | null) => void; children: React.ReactNode;
}) => { useLayoutEffect(() => { sheet.publish = onInset; return () => { sheet.publish = null; onInset(null); }; }, [onInset]); return children; } }));

let host: HTMLDivElement; let root: ReturnType<typeof createRoot>; let prior: ReturnType<typeof useApp.getState>;
// Real payment providers validate wallet identity before routing assertions run.
const fixtureWallet = '11111111111111111111111111111111';
const otherWallet = '11111111111111111111111111111112';
const base = (): BaseStateDto => ({
  baseId: 'base-a', player: { wallet: fixtureWallet, name: 'Keeper', keepLevel: 20,
    trophies: 0, league: 'wood', builders: 6, expansions: 12 },
  claim: { min: -10, max: 40 }, plotVersion: 2, energy: { used: 0, free: 1, max: 1 }, shield: null,
  buildings: [{ id: 'keep-a', type: 'keep', level: 20, tx: 10, ty: 10, underConstruction: false }],
  obstacles: [], army: [], heroes: [], freeBuilders: 6, jobs: [],
});
function hold() {
  const panel = { kind: 'hub' as const, featureId: 'hub.draft' };
  act(() => useApp.setState({ basePanel: panel }));
  const pending: PanelDismissRequest[] = [];
  const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel,
    canMutate: () => false, canRecover: () => false });
  const off = session.mount(); session.setDismissPolicy(request => { pending.push(request); });
  return { panel, pending, off };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Authoritative refresh pending'));
  vi.stubGlobal('innerWidth', 844); vi.stubGlobal('innerHeight', 390);
  prior = useApp.getState();
  useApp.setState({ base: base(), screen: 'base', wallet: null, authed: false, entryPaid: true,
    basePanel: null, placing: null, selectedBuildingId: null, selectedObstacleId: null,
    baseFocusRequest: null, raidChooserPending: false });
  host = document.createElement('div'); host.id = 'root'; document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); useApp.setState(prior, true);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
it.each(['confirm', 'wallet', 'target-removed', 'unmount'] as const)('HUD focus holds request, ghost, selection and bus together: %s', async change => {
  await act(async () => root.render(<Overlay />)); const h = hold();
  const focus = { kind: 'building' as const, id: 'keep-a' };
  const events: string[] = []; const offEnd = bus.on('build:end', () => events.push('end'));
  const offFocus = bus.on('base:focus', () => events.push('focus'));
  try {
    act(() => useApp.setState({ placing: 'wall', baseFocusRequest: focus }));
    expect(h.pending).toHaveLength(1); expect(useApp.getState().baseFocusRequest).toBe(focus);
    expect(useApp.getState().placing).toBe('wall'); expect(useApp.getState().selectedBuildingId).toBeNull();
    expect(events).toEqual([]);
    if (change === 'wallet') act(() => useApp.getState().setAuth(otherWallet));
    if (change === 'target-removed') act(() => useApp.setState({ base: { ...base(), buildings: [] } }));
    if (change === 'unmount') act(() => root.render(null));
    act(() => { expect(h.pending[0]?.proceed()).toBe(change === 'confirm'); });
    expect(h.pending[0]?.proceed()).toBe(false);
    expect(events).toEqual(change === 'confirm' ? ['end', 'focus'] : []);
    if (change === 'confirm') {
      expect(useApp.getState().baseFocusRequest).toBeNull(); expect(useApp.getState().placing).toBeNull();
      expect(useApp.getState().selectedBuildingId).toBe('keep-a');
    }
  } finally { h.off(); offEnd(); offFocus(); }
});
it.each(['confirm', 'wallet', 'capability', 'unmount'] as const)('HUD Attack holds its local RaidChooser mount: %s', async change => {
  await act(async () => root.render(<Overlay />)); const h = hold();
  try {
    const raid = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === 'RAID')!;
    expect(raid).not.toBeNull(); act(() => raid.click());
    expect(h.pending).toHaveLength(1); expect(document.body.textContent).not.toContain('FIND ME A TARGET');
    if (change === 'wallet') act(() => useApp.getState().setAuth(otherWallet));
    if (change === 'capability') act(() => useApp.setState({ base: { ...base(), plotVersion: 999 } as never }));
    if (change === 'unmount') act(() => root.render(null));
    act(() => { expect(h.pending[0]?.proceed()).toBe(change === 'confirm'); });
    expect(h.pending[0]?.proceed()).toBe(false);
    expect(document.body.textContent?.includes('FIND ME A TARGET')).toBe(change === 'confirm');
  } finally { h.off(); }
});
it.each(['WORLD MAP', 'CAMPAIGN', 'FIND ME A TARGET'] as const)('RaidChooser gates close, intent and the %s destination as one user command', async label => {
  const onClose = vi.fn(); await act(async () => root.render(<RaidChooser onClose={onClose} />)); const h = hold();
  try {
    const choice = [...document.querySelectorAll('button')].find(button => button.textContent?.includes(label))!;
    expect(choice).not.toBeNull(); act(() => choice.click());
    expect(h.pending).toHaveLength(1); expect(onClose).not.toHaveBeenCalled();
    expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().worldIntent).toBeNull();
    act(() => { expect(h.pending[0]?.proceed()).toBe(true); });
    expect(h.pending[0]?.proceed()).toBe(false); expect(onClose).toHaveBeenCalledTimes(1);
    expect(useApp.getState().screen).toBe(label === 'FIND ME A TARGET' ? 'battle' : 'map');
    expect(useApp.getState().worldIntent).toBe(label === 'WORLD MAP' ? 'find-rival' : null);
  } finally { h.off(); }
});
it('the real BaseHud adds native clearance once, deduplicates equal sheet geometry, and clears it', async () => {
  host.style.setProperty('--game-ui-bottom-clearance', '64px');
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 20));
  const insets: Array<{ bottom: number; right?: number }> = [];
  const off = bus.on('base:insets', value => insets.push(value));
  try {
    await act(async () => root.render(<Overlay />));
    expect(sheet.publish).not.toBeNull();
    act(() => sheet.publish!({ bottom: 200, right: 90 }));
    expect(insets.at(-1)?.bottom).toBe(264); expect(insets.at(-1)?.right).toBeGreaterThanOrEqual(90);
    const count = insets.length;
    act(() => sheet.publish!({ bottom: 200, right: 90 }));
    expect(insets).toHaveLength(count);
    act(() => sheet.publish!(null));
    expect(insets.at(-1)?.bottom).toBeLessThan(264);
  } finally { off(); }
});

it.each(['confirm', 'wallet', 'unmount'] as const)('overflow navigation and its local close stay together: %s', async change => {
  const onGo = vi.fn(); const onClose = vi.fn();
  const props: HudOverflowProps = { portrait: false, barHasTrophies: true, barHasSol: true,
    sol: null, trophies: 0, energy: { free: 1, max: 1 },
    shield: { label: 'NONE', ariaLabel: 'Shield', color: '#fff', go: 'raidlog' },
    quests: { done: 0, total: 0 }, claim: { available: false, day: 1, enabled: true },
    mail: { unread: 0, pending: 0 }, isAdmin: false, selectorEnabled: false, needsBaseSelect: false,
    onGo, onClose };
  await act(async () => root.render(<HudOverflowPanel {...props} />)); const h = hold();
  try {
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Army"]')!;
    expect(button).not.toBeNull(); act(() => button.click());
    expect(h.pending).toHaveLength(1); expect(onGo).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    if (change === 'wallet') act(() => useApp.getState().setAuth(otherWallet));
    if (change === 'unmount') act(() => root.render(null));
    act(() => { expect(h.pending[0]?.proceed()).toBe(change === 'confirm'); });
    expect(h.pending[0]?.proceed()).toBe(false);
    expect(onGo).toHaveBeenCalledTimes(change === 'confirm' ? 1 : 0);
    expect(onClose).toHaveBeenCalledTimes(change === 'confirm' ? 1 : 0);
    if (change === 'confirm') expect(onGo).toHaveBeenCalledWith('army');
  } finally { h.off(); }
});
it('the HUD retains a stored RaidChooser request until the draft permits the local mount', async () => {
  await act(async () => root.render(<Overlay />)); const h = hold();
  try {
    act(() => useApp.getState().requestRaidChooser());
    expect(h.pending).toHaveLength(1); expect(useApp.getState().raidChooserPending).toBe(true);
    expect(document.body.textContent).not.toContain('FIND ME A TARGET');
    act(() => { expect(h.pending[0]?.proceed()).toBe(true); });
    expect(h.pending[0]?.proceed()).toBe(false); expect(useApp.getState().raidChooserPending).toBe(false);
    expect(document.body.textContent).toContain('FIND ME A TARGET');
  } finally { h.off(); }
});

// Existing scenarios explicitly exercise the admitted web build; hold cases override it.
beforeEach(() => vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'));
afterEach(() => vi.unstubAllEnvs());

it.each(['workshop', 'ordinary-crafting', 'starter-fleet', 'starter-expeditions', 'harvesters', 'free-base-purchase'] as const)
('redirects a held %s screen before its controller can render', async screen => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); useApp.setState({ screen });
  await act(async () => root.render(<Overlay />));
  expect(useApp.getState().screen).toBe('base');
  expect(host.textContent).not.toContain('Opening your land');
});
it('keeps the truthful server Gems balance visible while the web hold is active', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  useApp.setState({ reduceMotion: true, balances: { keep: '500', gems: '12', shards: '100', keepRate: 1, features: { gems: { version: 1, receipts: 1 } } } as never });
  await act(async () => root.render(<Overlay />));
  const chip = host.querySelector('[aria-label="GEMS"]');
  expect(chip).not.toBeNull(); expect(chip?.textContent).toContain('12'); expect(chip?.textContent).not.toContain('500');
});

const mapProbe = vi.hoisted(() => ({
  open: null as null | ((id: MapFeatureId) => void),
  history: [] as Array<{ destination: MapFeatureDestination | null; onClose: () => void; actionsEnabled: boolean }>,
}));
// Observe the producer without borrowing W7's not-yet-composed controller owner.
vi.mock('./phaseE/PhaseERegistration', () => ({ PhaseERegistration: ({ onOpenMapFeature }: {
  onOpenMapFeature?: (id: MapFeatureId) => void;
}) => { useLayoutEffect(() => { mapProbe.open = onOpenMapFeature ?? null; return () => { mapProbe.open = null; }; }, [onOpenMapFeature]); return null; } }));
vi.mock('./WorkshopDoor', () => ({ WorkshopDoor: () => null }));
vi.mock('./screens/map', () => ({ MapScreen: (props: { destination: MapFeatureDestination | null; onClose: () => void; actionsEnabled: boolean }) => {
  mapProbe.history.push(props);
  return <div data-map-world><span data-map-feature>{props.destination?.featureId}</span><button onClick={props.onClose}>CLOSE MAP FEATURE</button></div>;
} }));
beforeEach(() => { mapProbe.open = null; mapProbe.history = []; });
async function prepareMapProducer() {
  vi.useRealTimers();
  useApp.setState({ authed: true, wallet: fixtureWallet, selectedBaseId: 'base-a', baseSelectionEpoch: 10, mapTab: 'campaign' });
  await act(async () => root.render(<Overlay />));
  await vi.waitFor(() => expect(mapProbe.open).not.toBeNull());
}
const destination = () => mapProbe.history.at(-1)?.destination ?? null;
it.each(['map.divineTrials', 'map.divineFragments'] as const)('holds Trial routing in place and defers only Fragments: %s (188719c1)', async featureId => {
  await prepareMapProducer(); const h = hold();
  try {
    act(() => mapProbe.open!(featureId));
    if (featureId === 'map.divineTrials') {
      // 188719c1: a cached producer must never move Trials away from its battle-compatible origin.
      expect(h.pending).toHaveLength(0); expect(destination()).toBeNull();
      expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().mapTab).toBe('campaign');
      expect(mapProbe.history).toHaveLength(0); return;
    }
    expect(h.pending).toHaveLength(1); expect(useApp.getState().screen).toBe('base');
    expect(useApp.getState().mapTab).toBe('campaign'); expect(mapProbe.history).toHaveLength(0);
    await act(async () => { expect(h.pending[0]!.proceed()).toBe(true); });
    expect(h.pending[0]!.proceed()).toBe(false);
    await vi.waitFor(() => expect(destination()?.featureId).toBe(featureId));
    expect(useApp.getState().screen).toBe('map'); expect(useApp.getState().mapTab).toBe('world');
    expect(destination()).toMatchObject({ wallet: fixtureWallet, baseId: 'base-a', epoch: 10 });
  } finally { h.off(); }
});
it.each(['wallet', 'base', 'epoch', 'screen', 'auth', 'tab', 'hold', 'unmount'] as const)
('invalidates a pending map producer on %s loss', async change => {
  await prepareMapProducer(); const h = hold();
  try {
    act(() => mapProbe.open!('map.divineFragments')); expect(h.pending).toHaveLength(1);
    await act(async () => {
      if (change === 'wallet') useApp.setState({ wallet: otherWallet });
      if (change === 'base') useApp.setState({ selectedBaseId: 'other-base' });
      if (change === 'epoch') useApp.setState({ baseSelectionEpoch: 11 });
      if (change === 'screen') useApp.setState({ screen: 'loading' });
      if (change === 'auth') useApp.setState({ authed: false });
      if (change === 'tab') useApp.setState({ mapTab: 'world' });
      if (change === 'hold') { vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); root.render(<Overlay />); }
      if (change === 'unmount') root.render(null);
    });
    act(() => { expect(h.pending[0]!.proceed()).toBe(false); });
    expect(destination()).toBeNull(); expect(useApp.getState().screen).not.toBe('map');
  } finally { h.off(); }
});
it('checks the live hold before a cached producer can change screen or tab', async () => {
  await prepareMapProducer(); const open = mapProbe.open!; vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  act(() => open('map.divineFragments'));
  expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().mapTab).toBe('campaign'); expect(destination()).toBeNull();
});
it('does not load the producer registration or map host in a held build', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); useApp.setState({ authed: true, wallet: fixtureWallet });
  await act(async () => root.render(<Overlay />));
  expect(mapProbe.open).toBeNull(); expect(mapProbe.history).toHaveLength(0);
});
it.each(['wallet', 'base', 'epoch', 'auth', 'screen', 'campaign', 'hold'] as const)
('retires a local target on %s loss so returning cannot revive it', async change => {
  await prepareMapProducer(); await act(async () => mapProbe.open!('map.divineFragments'));
  await vi.waitFor(() => expect(destination()?.featureId).toBe('map.divineFragments'));
  await act(async () => {
    if (change === 'wallet') useApp.setState({ wallet: otherWallet });
    if (change === 'base') useApp.setState({ selectedBaseId: 'other-base' });
    if (change === 'epoch') useApp.setState({ baseSelectionEpoch: 11 });
    if (change === 'auth') useApp.setState({ authed: false });
    if (change === 'screen') useApp.setState({ screen: 'base' });
    if (change === 'campaign') useApp.setState({ mapTab: 'campaign' });
    if (change === 'hold') { vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); root.render(<Overlay />); }
  });
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1');
  await act(async () => { useApp.setState({ authed: true, wallet: fixtureWallet, selectedBaseId: 'base-a', baseSelectionEpoch: 10, screen: 'map', mapTab: 'world' }); root.render(<Overlay />); });
  expect(destination()).toBeNull(); expect(host.querySelector('[data-map-feature]')?.textContent).toBe('');
});
it('retires a target when auth leaves and returns before React paints', async () => {
  await prepareMapProducer(); await act(async () => mapProbe.open!('map.divineFragments'));
  await vi.waitFor(() => expect(destination()).not.toBeNull());
  act(() => { useApp.setState({ authed: false }); useApp.setState({ authed: true }); });
  expect(destination()).toBeNull();
});
it('closes only the local target, preserves the map node, and rejects an older close against a new generation', async () => {
  await prepareMapProducer(); await act(async () => mapProbe.open!('map.divineFragments'));
  await vi.waitFor(() => expect(destination()).not.toBeNull());
  const world = host.querySelector('[data-map-world]'), first = destination()!, oldClose = mapProbe.history.at(-1)!.onClose;
  act(() => oldClose()); expect(destination()).toBeNull(); expect(host.querySelector('[data-map-world]')).toBe(world);
  expect(useApp.getState().screen).toBe('map'); expect(useApp.getState().mapTab).toBe('world'); expect(useApp.getState().selectedBaseId).toBe('base-a');
  await act(async () => useApp.setState({ screen: 'base' })); await vi.waitFor(() => expect(mapProbe.open).not.toBeNull());
  await act(async () => mapProbe.open!('map.divineFragments')); await vi.waitFor(() => expect(destination()?.featureId).toBe('map.divineFragments'));
  expect(destination()!.generation).toBeGreaterThan(first.generation);
  act(() => oldClose()); expect(destination()?.featureId).toBe('map.divineFragments');
});

it('passes live base capability into the same map mount and retained local destination', async () => {
  await prepareMapProducer();
  await act(async () => useApp.setState({ baseDirectory: null, base: base() }));
  await act(async () => mapProbe.open!('map.divineFragments'));
  await vi.waitFor(() => expect(destination()?.featureId).toBe('map.divineFragments'));
  const target = destination(), world = host.querySelector('[data-map-world]');
  expect(mapProbe.history.at(-1)?.actionsEnabled).toBe(true);
  // Unsupported plot capability must reach the saved-original owner too.
  await act(async () => useApp.setState({ base: { ...base(), plotVersion: -1 } }));
  expect(mapProbe.history.at(-1)?.actionsEnabled).toBe(false);
  expect(destination()).toBe(target); expect(host.querySelector('[data-map-world]')).toBe(world);
  await act(async () => useApp.setState({ base: base() }));
  expect(mapProbe.history.at(-1)?.actionsEnabled).toBe(true);
  expect(destination()).toBe(target); expect(host.querySelector('[data-map-world]')).toBe(world);
});
it.each(['shop', 'map', 'wallet-null', 'auth-false'] as const)
('refuses cached map navigation at click time after %s invalidates its source', async change => {
  await prepareMapProducer(); const open = mapProbe.open!, h = hold();
  try {
    act(() => {
      if (change === 'shop' || change === 'map') useApp.setState({ screen: change });
      if (change === 'wallet-null') useApp.setState({ wallet: null });
      if (change === 'auth-false') useApp.setState({ authed: false });
      const before = useApp.getState(); open('map.divineFragments');
      expect(h.pending).toHaveLength(0);
      expect(useApp.getState().screen).toBe(before.screen); expect(useApp.getState().mapTab).toBe(before.mapTab);
    });
    expect(destination()).toBeNull();
  } finally { h.off(); }
});
