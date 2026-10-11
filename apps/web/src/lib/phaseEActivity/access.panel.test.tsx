// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureBasePanels, inspectConfiguredBasePanel, useApp, type BaseStateDto, type UserCommandHandle } from '../../state/store';
import { createBaseFeatureRegistry } from '../../ui/pk/featureRegistry';
import { createPanelSession, type PanelDismissRequest } from '../../ui/pk/panelSession';
import { BUILDINGS_INFO_SOURCE, ORDINARY_CRAFTING_PANEL } from './panelIds';
import { hasBuildingActivityAccess, launchBuildingActivity, launchHistoryActivity, requestOrdinaryCraftingPanel, useBuildingActivityAccess } from './access';

const wallet = '11111111111111111111111111111111';
const baseId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const originalOpenBasePanel = useApp.getState().openBasePanel;
const building = { id: 'workshop-1', type: 'workshop', level: 1, tx: 1, ty: 1, underConstruction: false };
const base = (rows = [building]) => ({ baseId, buildings: rows }) as BaseStateDto;
const registry = () => createBaseFeatureRegistry([
  { ...ORDINARY_CRAFTING_PANEL, id: ORDINARY_CRAFTING_PANEL.featureId, label: 'Workshop', size: 'TALL', readOnly: false, load: async () => ({ default: () => null }) },
  { ...BUILDINGS_INFO_SOURCE, id: BUILDINGS_INFO_SOURCE.featureId, label: 'Building', size: 'TALL', readOnly: true, load: async () => ({ default: () => null }) },
]);
let dispose: (() => void)[] = [];
const observe = (handle: UserCommandHandle) => {
  const listener = vi.fn(); handle.onSettled(listener); return listener;
};
const refused = (reason: string) => ({ status: 'fulfilled', value: { outcome: 'refused', reason } });
function source() {
  const panel = { ...BUILDINGS_INFO_SOURCE, buildingId: building.id };
  useApp.setState({ basePanel: panel }); return panel;
}
function deferred() {
  const panel = source();
  const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => true, canRecover: () => true });
  dispose.push(session.mount());
  let pending: PanelDismissRequest | null = null;
  dispose.push(session.setDismissPolicy(request => { pending = request; }));
  const handle = requestOrdinaryCraftingPanel(building.id), listener = observe(handle);
  expect(pending).not.toBeNull(); expect(listener).not.toHaveBeenCalled();
  return { panel, handle, listener, proceed: () => pending!.proceed(), cancel: () => pending!.cancel?.() };
}
beforeEach(() => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1');
  launchHistoryActivity('ordinary-crafting');
  useApp.setState({ authed: true, wallet, selectedBaseId: baseId, baseSelectionEpoch: 7, base: base(), screen: 'base', basePanel: null, selectedBuildingId: building.id, placing: null, openBasePanel: originalOpenBasePanel });
  configureBasePanels(registry(), true);
});
afterEach(() => {
  for (const cleanup of dispose.reverse()) cleanup(); dispose = [];
  vi.restoreAllMocks(); useApp.setState({ openBasePanel: originalOpenBasePanel }); useApp.getState().setAuth(null); configureBasePanels({}, false); vi.unstubAllEnvs();
});

describe('H-1 library navigation provenance', () => {
  it.each(['none', 'buildings.info'] as const)('opens only a selected world-source action from %s', from => {
    if (from !== 'none') source();
    const before = useApp.getState().basePanel;
    const listener = observe(requestOrdinaryCraftingPanel(building.id));
    expect(listener).toHaveBeenCalledExactlyOnceWith({ status: 'fulfilled', value: { outcome: 'opened' } });
    expect(useApp.getState().basePanel).toEqual({ ...ORDINARY_CRAFTING_PANEL, buildingId: building.id });
    expect(useApp.getState().basePanel).not.toBe(before);
    expect(useApp.getState().screen).toBe('base');
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
    expect(hasBuildingActivityAccess('market')).toBe(false);
  });
  it.each(['buildings.upgrade', 'craft.workshop', 'history.workshop', 'other'] as const)('refuses %s before requesting dismissal or changing navigation', featureId => {
    const panel = { kind: featureId === 'craft.workshop' ? 'craft' as const : 'info' as const, featureId, buildingId: building.id };
    useApp.setState({ basePanel: panel });
    const session = createPanelSession({ panel, controlled: true, isCurrent: () => true, canMutate: () => true, canRecover: () => true });
    dispose.push(session.mount()); const dismiss = vi.fn(); dispose.push(session.setDismissPolicy(dismiss));
    const open = vi.spyOn(useApp.getState(), 'openBasePanel');
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('source'));
    expect(dismiss).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    expect(useApp.getState().basePanel).toBe(panel); expect(useApp.getState().selectedBuildingId).toBe(building.id);
    expect(useApp.getState().screen).toBe('base'); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('a destination self-mint attempt preserves an already valid grant as well as the exact panel', () => {
    requestOrdinaryCraftingPanel(building.id); const panel = useApp.getState().basePanel;
    const open = vi.spyOn(useApp.getState(), 'openBasePanel');
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('source'));
    expect(open).not.toHaveBeenCalled(); expect(useApp.getState().basePanel).toBe(panel);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
  });
  it.each([
    ['auth', () => useApp.setState({ authed: false }), 'scope'],
    ['wallet', () => useApp.setState({ wallet: null }), 'scope'],
    ['base', () => useApp.setState({ selectedBaseId: null }), 'scope'],
    ['loaded base', () => useApp.setState({ base: { ...base(), baseId: 'other' } }), 'scope'],
    ['selection', () => useApp.setState({ selectedBuildingId: null }), 'scope'],
    ['build screen', () => useApp.setState({ screen: 'build' }), 'scope'],
    ['placing', () => useApp.setState({ placing: 'wall' }), 'placing'],
    ['missing row', () => useApp.setState({ base: base([]) }), 'building'],
    ['wrong type', () => useApp.setState({ base: base([{ ...building, type: 'market' }]) }), 'building'],
    ['unfinished', () => useApp.setState({ base: base([{ ...building, underConstruction: true }]) }), 'building'],
    ['zero level', () => useApp.setState({ base: base([{ ...building, level: 0 }]) }), 'building'],
    ['fractional level', () => useApp.setState({ base: base([{ ...building, level: 1.5 }]) }), 'building'],
  ] as const)('refuses %s without opening or minting', (_label, change, reason) => {
    change(); const open = vi.spyOn(useApp.getState(), 'openBasePanel');
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused(reason));
    expect(open).not.toHaveBeenCalled(); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('refuses a wrong-building info panel and a wrong-kind source descriptor', () => {
    useApp.setState({ basePanel: { ...BUILDINGS_INFO_SOURCE, buildingId: 'other' } });
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('source'));
    useApp.setState({ basePanel: { ...BUILDINGS_INFO_SOURCE, kind: 'craft', buildingId: building.id } });
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('source'));
  });
  it('refuses under the held switch, even when a caller invokes the otherwise unreachable API', () => {
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('web-held'));
    expect(useApp.getState().basePanel).toBeNull();
  });
  it('distinguishes no registration from current base-capability refusal with a read-only registry query', () => {
    configureBasePanels({}, true);
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('unregistered'));
    configureBasePanels(registry(), false);
    const before = useApp.getState();
    const observed = inspectConfiguredBasePanel({ ...ORDINARY_CRAFTING_PANEL, buildingId: building.id });
    expect(observed).toMatchObject({ registered: true, actionsEnabled: false, feature: null });
    expect(useApp.getState()).toBe(before);
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('capability'));
  });
  it('does not treat read-only recovery resolution as new-action admission', () => {
    const recover = createBaseFeatureRegistry([{ ...ORDINARY_CRAFTING_PANEL, id: ORDINARY_CRAFTING_PANEL.featureId, label: 'Workshop', size: 'TALL', readOnly: true, load: async () => ({ default: () => null }) }]);
    configureBasePanels(recover, false);
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('capability'));
  });
  it('mints nothing while deferred; completion settles once and cleanup after success preserves the grant', () => {
    const d = deferred(); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    expect(d.proceed()).toBe(true); d.handle(); d.proceed();
    expect(d.listener).toHaveBeenCalledExactlyOnceWith({ status: 'fulfilled', value: { outcome: 'opened' } });
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
  });
  it.each(['handle', 'dismissal'] as const)('%s cancellation settles cancelled without minting', mode => {
    const d = deferred(); if (mode === 'handle') d.handle(); else d.cancel();
    d.proceed(); expect(d.listener).toHaveBeenCalledExactlyOnceWith({ status: 'cancelled' });
    expect(useApp.getState().basePanel).toBe(d.panel); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it.each(['wallet', 'base', 'epoch', 'screen', 'selection', 'panel', 'auth', 'loaded'] as const)('scope %s ABA permanently cancels a pending admission', dimension => {
    const d = deferred(); const s = useApp.getState();
    const changes = { wallet: { wallet: 'other' }, base: { selectedBaseId: 'other' }, epoch: { baseSelectionEpoch: s.baseSelectionEpoch + 1 }, screen: { screen: 'build' as const }, selection: { selectedBuildingId: 'other' }, panel: { basePanel: { ...d.panel } }, auth: { authed: false }, loaded: { base: { ...base(), baseId: 'other' } } };
    useApp.setState(changes[dimension]); useApp.setState(s); d.proceed();
    expect(d.listener).toHaveBeenCalledExactlyOnceWith({ status: 'cancelled' });
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it.each(['level', 'construction', 'missing', 'placing'] as const)('eligibility loss %s during deferred dismissal is an explicit refusal, even after restoration', change => {
    const d = deferred();
    if (change === 'placing') useApp.setState({ placing: 'wall' });
    else useApp.setState({ base: change === 'missing' ? base([]) : base([{ ...building, ...(change === 'level' ? { level: 2 } : { underConstruction: true }) }]) });
    useApp.setState({ base: base(), placing: null }); d.proceed();
    expect(d.listener).toHaveBeenCalledExactlyOnceWith(refused(change === 'placing' ? 'placing' : 'building'));
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('replacing the source registration during dismissal is a scope cancellation', () => {
    const d = deferred(); configureBasePanels(registry(), false); d.proceed();
    expect(d.listener).toHaveBeenCalledExactlyOnceWith({ status: 'cancelled' });
    expect(useApp.getState().basePanel).toBeNull();
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('reports capability and destination-registration changes at deferred command admission', () => {
    const same = registry(); configureBasePanels(same, true); const d = deferred();
    configureBasePanels(same, false); d.proceed();
    expect(d.listener).toHaveBeenCalledExactlyOnceWith(refused('capability'));
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('refuses a destination-registration replacement even if the source registration remains identical', () => {
    const same = registry(); configureBasePanels(same, true); const d = deferred();
    configureBasePanels({ ...same, [ORDINARY_CRAFTING_PANEL.featureId]: registry()[ORDINARY_CRAFTING_PANEL.featureId]! }, true); d.proceed();
    expect(d.listener).toHaveBeenCalledExactlyOnceWith(refused('registration-changed'));
  });
  it('reports removal of the destination registration during dismissal as unregistered', () => {
    const same = registry(); configureBasePanels(same, true); const d = deferred();
    configureBasePanels({ [BUILDINGS_INFO_SOURCE.featureId]: same[BUILDINGS_INFO_SOURCE.featureId]! }, true); d.proceed();
    expect(d.listener).toHaveBeenCalledExactlyOnceWith(refused('unregistered'));
    expect(useApp.getState().basePanel).toBe(d.panel);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('a no-op open cannot mint and does not fall back to the legacy screen', () => {
    vi.spyOn(useApp.getState(), 'openBasePanel').mockImplementation(() => undefined);
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('open-refused'));
    expect(useApp.getState().screen).toBe('base'); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('an intervening selection ABA inside open fails closed even if the final panel looks correct', () => {
    const open = useApp.getState().openBasePanel;
    vi.spyOn(useApp.getState(), 'openBasePanel').mockImplementation(panel => {
      useApp.setState({ selectedBuildingId: 'other' }); useApp.setState({ selectedBuildingId: building.id }); open(panel);
    });
    expect(observe(requestOrdinaryCraftingPanel(building.id))).toHaveBeenCalledExactlyOnceWith(refused('open-refused'));
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it.each(['upgrade', 'downgrade', 'construction', 'type', 'removal'] as const)('revokes a minted grant permanently on workshop %s', change => {
    requestOrdinaryCraftingPanel(building.id);
    useApp.setState({ base: change === 'removal' ? base([]) : base([{ ...building, ...(change === 'upgrade' ? { level: 2 } : change === 'downgrade' ? { level: 0 } : change === 'type' ? { type: 'market' } : { underConstruction: true }) }]) });
    useApp.setState({ base: base() }); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it.each(['wallet', 'base', 'epoch', 'screen', 'selection', 'panel', 'auth', 'loaded'] as const)('revokes the minted grant on %s ABA without React effects', dimension => {
    requestOrdinaryCraftingPanel(building.id); const s = useApp.getState();
    const changes = { wallet: { wallet: 'other' }, base: { selectedBaseId: 'other' }, epoch: { baseSelectionEpoch: s.baseSelectionEpoch + 1 }, screen: { screen: 'build' as const }, selection: { selectedBuildingId: 'other' }, panel: { basePanel: { ...s.basePanel! } }, auth: { authed: false }, loaded: { base: { ...base(), baseId: 'other' } } };
    useApp.setState(changes[dimension]); useApp.setState(s);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('preserves the grant for a replaced row with the identical completed tuple and different display coordinates', () => {
    requestOrdinaryCraftingPanel(building.id); useApp.setState({ base: base([{ ...building, tx: 5 }]) });
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
  });
  it('direct panel restoration and history never mint; legacy screen grants still require their exact screen', () => {
    useApp.setState({ basePanel: { ...ORDINARY_CRAFTING_PANEL, buildingId: building.id } });
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    launchHistoryActivity('ordinary-crafting'); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    useApp.setState({ screen: 'base', basePanel: null, selectedBuildingId: building.id });
    expect(launchBuildingActivity('ordinary-crafting', building.id)).toBe(true);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
    useApp.setState({ screen: 'base' }); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('history revokes the panel grant even when the exact old panel is restored', () => {
    requestOrdinaryCraftingPanel(building.id); const s = useApp.getState();
    launchHistoryActivity('ordinary-crafting'); useApp.setState(s);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('the read-only hook re-renders a retained subscriber on grant mint and revocation', async () => {
    const node = document.createElement('div'); let root: Root | null = createRoot(node); let mounts = 0; let unmounts = 0;
    function Probe() { const allowed = useBuildingActivityAccess('ordinary-crafting'); useEffect(() => { mounts++; return () => { unmounts++; }; }, []); return <output>{String(allowed)}</output>; }
    try {
      await act(async () => { root!.render(<Probe />); }); expect(node.textContent).toBe('false');
      await act(async () => { requestOrdinaryCraftingPanel(building.id); }); expect(node.textContent).toBe('true');
      await act(async () => { useApp.setState({ base: base([]) }); }); expect(node.textContent).toBe('false');
      expect(mounts).toBe(1); expect(unmounts).toBe(0);
    } finally { await act(async () => { root?.unmount(); root = null; }); }
  });
});
