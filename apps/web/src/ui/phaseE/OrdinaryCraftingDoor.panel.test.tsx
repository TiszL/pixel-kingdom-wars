// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureBasePanels, useApp, type BaseStateDto, type UserCommandHandle, type UserCommandSettlement } from '../../state/store';
import { createBaseFeatureRegistry } from '../pk/featureRegistry';
import { createPanelSession, type PanelDismissRequest } from '../pk/panelSession';
import { BUILDINGS_INFO_SOURCE, ORDINARY_CRAFTING_PANEL } from '../../lib/phaseEActivity/panelIds';
import { hasBuildingActivityAccess, type OrdinaryCraftingPanelRefusal } from '../../lib/phaseEActivity/access';
import { OrdinaryCraftingDoor } from './OrdinaryCraftingDoor';

const calls = vi.hoisted(() => ({ request: vi.fn(), legacy: vi.fn(), history: vi.fn(),
  realRequest: null as null | ((id: string) => UserCommandHandle), saved: true,
  journalRead: vi.fn(), snapshot: vi.fn(), ports: vi.fn() }));
vi.mock('../../lib/phaseEActivity/access', async original => {
  const actual = await original<typeof import('../../lib/phaseEActivity/access')>();
  calls.realRequest = actual.requestOrdinaryCraftingPanel;
  calls.legacy.mockImplementation(actual.launchBuildingActivity); calls.history.mockImplementation(actual.launchHistoryActivity);
  return { ...actual, requestOrdinaryCraftingPanel: calls.request, launchBuildingActivity: calls.legacy, launchHistoryActivity: calls.history };
});
vi.mock('../../auth/authCookieCoordinator', () => ({ authCookies: { captureGeneration: () => 1, current: () => true } }));
vi.mock('../../lib/ordinaryCrafting/browser', () => ({ ordinaryCraftingIdentity: (wallet: string) => ({ wallet }), createOrdinaryCraftingBrowserPorts: calls.ports }));
vi.mock('../../lib/ordinaryCrafting/snapshot', () => ({ refreshOrdinaryCraftingSnapshot: calls.snapshot }));
vi.mock('../../lib/ordinaryCrafting/journal', () => ({ OrdinaryCraftingJournalStore: class {
  read() { return calls.journalRead(); } async close() { /* no storage in this fixture */ }
} }));
vi.mock('../../lib/boundCosmetics/workshopJournal', () => ({ WorkshopJournalStore: class {
  async read() { return { operation: null, archives: [] }; } async close() { /* no storage */ }
} }));
vi.mock('../../lib/boundCosmetics/workshopBrowser', () => ({ createWorkshopBrowserPorts: () => { throw Error('Cosmetics I/O excluded from door fixture'); } }));
vi.mock('./PhaseEActionDock', () => ({ PhaseEEntryButton: ({ variant: _variant, children, ...props }: ComponentProps<'button'> & { variant?: string }) => <button {...props}>{children}</button> }));

const wallet = '11111111111111111111111111111111', baseId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const building = { id: 'workshop-1', type: 'workshop', level: 1, tx: 1, ty: 1, underConstruction: false };
const registry = () => createBaseFeatureRegistry([
  { ...ORDINARY_CRAFTING_PANEL, id: ORDINARY_CRAFTING_PANEL.featureId, label: 'Workshop', size: 'TALL', readOnly: false, canMutate: () => false, load: async () => ({ default: () => null }) },
  { ...BUILDINGS_INFO_SOURCE, id: BUILDINGS_INFO_SOURCE.featureId, label: 'Building', size: 'TALL', readOnly: true, load: async () => ({ default: () => null }) },
]);
let root: ReturnType<typeof createRoot>, node: HTMLDivElement;
let cleanup: (() => void)[] = [];
let prior: ReturnType<typeof useApp.getState>;
const completed = () => ({ baseId, buildings: [building] }) as BaseStateDto;
const mount = async (props: ComponentProps<typeof OrdinaryCraftingDoor> = { discover: true, buildingId: building.id }) => {
  await act(async () => { root.render(<OrdinaryCraftingDoor {...props} />); });
};
const click = async () => {
  const button = node.querySelector('button'); expect(button).not.toBeNull();
  await act(async () => { button!.click(); });
};
const settled = (value: UserCommandSettlement): UserCommandHandle => {
  const handle = (() => undefined) as UserCommandHandle;
  handle.onSettled = listener => { listener(value); return () => undefined; }; return handle;
};
function deferSource() {
  const panel = { ...BUILDINGS_INFO_SOURCE, buildingId: building.id };
  useApp.setState({ basePanel: panel });
  const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => false, canRecover: () => true });
  cleanup.push(session.mount()); let pending: PanelDismissRequest | null = null;
  cleanup.push(session.setDismissPolicy(request => { pending = request; }));
  return { panel, proceed: () => pending!.proceed(), cancel: () => pending!.cancel?.() };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1');
  prior = useApp.getState(); vi.clearAllMocks(); calls.request.mockReset().mockImplementation(calls.realRequest!);
  calls.saved = true; calls.journalRead.mockImplementation(async () => ({ operation: calls.saved ? {} : null, archives: [] }));
  calls.ports.mockReturnValue({}); calls.snapshot.mockResolvedValue({ enabled: true, view: { pendingJobs: [] } });
  useApp.setState({ authed: true, wallet, selectedBaseId: baseId, baseSelectionEpoch: 4, base: completed(), selectedBuildingId: building.id, basePanel: null, screen: 'base', placing: null });
  configureBasePanels(registry(), true); node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  for (const dispose of cleanup.reverse()) dispose(); cleanup = [];
  useApp.getState().setAuth(null); configureBasePanels({}, false); useApp.setState(prior);
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe('H-1 packet2: only an explicit existing-door click requests a panel grant', () => {
  it('does not expose the producer through a value alias or any extra door export', () => {
    // Under happy-dom `new URL(rel, import.meta.url)` is not a file: URL (the b678ed254 cause); resolve from the module path.
    const path = join(dirname(fileURLToPath(import.meta.url)), 'OrdinaryCraftingDoor.tsx');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const exported = source.statements.filter(statement => ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
    expect(exported).toHaveLength(1);
    const only = exported[0];
    expect(only && ts.isVariableStatement(only)).toBe(true);
    if (only && ts.isVariableStatement(only)) expect(only.declarationList.declarations.map(declaration => declaration.name.getText(source))).toEqual(['OrdinaryCraftingDoor']);
    expect(source.statements.some(statement => ts.isExportDeclaration(statement) || ts.isExportAssignment(statement))).toBe(false);
  });
  it('mount, rerender, selection changes and gate toggles never invoke the producer; one click invokes it once', async () => {
    await mount(); await mount();
    await act(async () => { useApp.getState().select('other'); });
    await act(async () => { useApp.getState().select(building.id); });
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); await mount();
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); await mount();
    expect(calls.request).not.toHaveBeenCalled(); expect(calls.legacy).not.toHaveBeenCalled(); expect(calls.history).not.toHaveBeenCalled();
    await click(); expect(calls.request).toHaveBeenCalledExactlyOnceWith(building.id);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
    expect(useApp.getState().basePanel).toEqual({ ...ORDINARY_CRAFTING_PANEL, buildingId: building.id });
  });
  it('a held mount performs no producer call or journal/snapshot discovery', async () => {
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); await mount();
    expect(node.childElementCount).toBe(0); expect(calls.request).not.toHaveBeenCalled();
    expect(calls.journalRead).not.toHaveBeenCalled(); expect(calls.snapshot).not.toHaveBeenCalled();
  });
  it.each(['none', 'buildings.info'] as const)('routes a registered world source from %s to the producer only', async from => {
    if (from !== 'none') useApp.setState({ basePanel: { ...BUILDINGS_INFO_SOURCE, buildingId: building.id } });
    await mount(); await click();
    expect(calls.request).toHaveBeenCalledExactlyOnceWith(building.id);
    expect(calls.legacy).not.toHaveBeenCalled(); expect(calls.history).not.toHaveBeenCalled();
  });
  it('an unregistered null-panel world source retains the existing legacy route', async () => {
    configureBasePanels({}, true); await mount(); await click();
    expect(calls.legacy).toHaveBeenCalledExactlyOnceWith('ordinary-crafting', building.id);
    expect(calls.request).not.toHaveBeenCalled(); expect(useApp.getState().screen).toBe('ordinary-crafting');
  });
  it('the existing build-screen route remains legacy even when the panel feature is registered', async () => {
    useApp.setState({ screen: 'build' }); await mount(); await click();
    expect(calls.legacy).toHaveBeenCalledExactlyOnceWith('ordinary-crafting', building.id);
    expect(calls.request).not.toHaveBeenCalled();
  });
  it('preserves the existing legacy dismissal owner when no craft or source panel is registered', async () => {
    configureBasePanels({}, true); await mount();
    const panel = { kind: 'hub' as const, featureId: 'legacy-draft' };
    // Match UserCommandDoors' retained legacy-policy scenario: the store can
    // change immediately before the click and before React commits that change.
    useApp.setState({ basePanel: panel });
    const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => false, canRecover: () => false });
    cleanup.push(session.mount()); const requests: PanelDismissRequest[] = [];
    cleanup.push(session.setDismissPolicy(request => { requests.push(request); }));
    await click(); expect(requests).toHaveLength(1); expect(calls.request).not.toHaveBeenCalled();
    await act(async () => { expect(requests[0]!.proceed()).toBe(true); });
    expect(calls.legacy).toHaveBeenCalledExactlyOnceWith('ordinary-crafting', building.id);
    expect(useApp.getState().screen).toBe('ordinary-crafting');
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
  });
  it('an info source with no destination registration refuses without legacy fallback', async () => {
    configureBasePanels({}, true); useApp.setState({ basePanel: { ...BUILDINGS_INFO_SOURCE, buildingId: building.id } });
    await mount(); await click();
    expect(calls.request).toHaveBeenCalledExactlyOnceWith(building.id); expect(calls.legacy).not.toHaveBeenCalled();
    expect(node.querySelector('[role="status"]')?.textContent).toContain('not available yet');
  });
  it('capability refusal does not falsely tell a player under a raid/deed lock to select a different Workshop', async () => {
    configureBasePanels(registry(), false); await mount(); await click();
    expect(calls.request).toHaveBeenCalledExactlyOnceWith(building.id);
    expect(node.querySelector('[role="status"]')?.textContent).toBe('Workshop actions are unavailable right now.');
    expect(node.textContent).not.toContain('Select'); expect(calls.legacy).not.toHaveBeenCalled();
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it.each([{ discover: false, buildingId: building.id }, { discover: true }] as const)('the history door never calls the producer (%j)', async props => {
    await mount(props); await click();
    expect(calls.history).toHaveBeenCalledExactlyOnceWith('ordinary-crafting'); expect(calls.request).not.toHaveBeenCalled();
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('keeps saved-receipt labeling and the existing discovery result for the selected world door', async () => {
    await mount(); expect(node.querySelector('button')?.textContent).toBe('WORKSHOP & SAVED RECEIPTS');
    expect(calls.journalRead).toHaveBeenCalled(); expect(calls.snapshot).toHaveBeenCalled();
    expect(calls.request).not.toHaveBeenCalled();
  });
  it('admits only one of two synchronous clicks before React commits the pending disabled state', async () => {
    const d = deferSource(); await mount();
    const button = node.querySelector('button'); expect(button).not.toBeNull();
    await act(async () => {
      expect(button!.disabled).toBe(false);
      button!.click();
      // The second event must reach an enabled DOM button, so the pending ref
      // guard, rather than React's committed disabled prop, rejects it.
      expect(button!.disabled).toBe(false);
      button!.click();
      expect(calls.request).toHaveBeenCalledExactlyOnceWith(building.id);
    });
    expect(button!.disabled).toBe(true);
    expect(useApp.getState().basePanel).toBe(d.panel);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    await act(async () => { expect(d.proceed()).toBe(true); });
    expect(calls.request).toHaveBeenCalledTimes(1);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
    expect(calls.legacy).not.toHaveBeenCalled(); expect(calls.history).not.toHaveBeenCalled();
  });
  it.each([
    { changed: 'buildingId', props: { discover: true, buildingId: 'workshop-2' } },
    { changed: 'discover', props: { discover: false, buildingId: building.id } },
  ])('quietly cancels a pending request when only the $changed prop changes', async ({ props }) => {
    const d = deferSource(); await mount(); await click();
    expect(calls.request).toHaveBeenCalledExactlyOnceWith(building.id);
    const handle = calls.request.mock.results[0]!.value as UserCommandHandle;
    const outcome = vi.fn(); cleanup.push(handle.onSettled(outcome));
    expect(outcome).not.toHaveBeenCalled(); expect(node.querySelector('button')?.disabled).toBe(true);
    await mount(props);
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: 'cancelled' });
    expect(calls.request).toHaveBeenCalledTimes(1);
    expect(node.querySelector('button')?.disabled).toBe(false);
    expect(node.querySelector('[role="status"]')).toBeNull();
    expect(useApp.getState().selectedBuildingId).toBe(building.id);
    expect(useApp.getState().basePanel).toBe(d.panel);
    await act(async () => { expect(d.proceed()).toBe(false); });
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    expect(calls.legacy).not.toHaveBeenCalled(); expect(calls.history).not.toHaveBeenCalled();
    await mount();
    expect(node.querySelector('button')?.disabled).toBe(false);
    expect(node.querySelector('[role="status"]')).toBeNull();
    expect(calls.request).toHaveBeenCalledTimes(1);
  });
  it('a registered craft destination with an unregistered legacy source refuses instead of taking the legacy route', async () => {
    const panel = { kind: 'hub' as const, featureId: 'legacy-draft' };
    useApp.setState({ basePanel: panel }); await mount(); await click();
    expect(calls.request).toHaveBeenCalledExactlyOnceWith(building.id);
    const handle = calls.request.mock.results[0]!.value as UserCommandHandle;
    const outcome = vi.fn(); cleanup.push(handle.onSettled(outcome));
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: 'fulfilled', value: { outcome: 'refused', reason: 'source' } });
    expect(node.querySelector('[role="status"]')?.textContent).toBe('Close the current panel and select the Workshop to try again.');
    expect(useApp.getState().basePanel).toBe(panel); expect(useApp.getState().screen).toBe('base');
    expect(node.querySelector('button')?.disabled).toBe(false);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    expect(calls.legacy).not.toHaveBeenCalled(); expect(calls.history).not.toHaveBeenCalled();
  });
  it('a real legacy building rejection reports the building refusal without a grant or panel attempt', async () => {
    configureBasePanels({}, true);
    useApp.setState({ base: { ...completed(), buildings: [{ ...building, underConstruction: true }] } });
    await mount(); await click();
    expect(calls.legacy).toHaveBeenCalledExactlyOnceWith('ordinary-crafting', building.id);
    expect(calls.legacy).toHaveReturnedWith(false);
    expect(node.querySelector('[role="status"]')?.textContent).toBe('Workshop access changed. Select a completed Workshop and try again.');
    expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().basePanel).toBeNull();
    expect(node.querySelector('button')?.disabled).toBe(false);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    expect(calls.request).not.toHaveBeenCalled(); expect(calls.history).not.toHaveBeenCalled();
  });
  it('disables duplicate pending clicks until dismissal completes, then preserves the settled grant on unmount', async () => {
    const d = deferSource(); await mount(); await click(); await click();
    expect(calls.request).toHaveBeenCalledTimes(1); expect(node.querySelector('button')?.disabled).toBe(true);
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    await act(async () => { d.proceed(); });
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
    await act(async () => { root.render(null); });
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true);
  });
  it('unmount cancels a pending source request and its late proceed cannot mint', async () => {
    const d = deferSource(); await mount(); await click();
    await act(async () => { root.render(null); });
    expect(d.proceed()).toBe(false); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
    expect(useApp.getState().basePanel).toBe(d.panel);
  });
  it('dismissal refusal leaves the door available without an error or legacy fallback', async () => {
    const d = deferSource(); await mount(); await click(); await act(async () => { d.cancel(); });
    expect(node.querySelector('[role="status"]')).toBeNull(); expect(node.querySelector('button')?.disabled).toBe(false);
    expect(calls.legacy).not.toHaveBeenCalled(); expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false);
  });
  it('real setPlacing cancels by clearing selection/panel, with no misleading placing-refusal status', async () => {
    const d = deferSource(); await mount(); await click();
    await act(async () => { useApp.getState().setPlacing('wall'); });
    expect(d.proceed()).toBe(false); expect(node.querySelector('[role="status"]')).toBeNull();
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(false); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('deferred workshop eligibility loss reports a refusal rather than silently remaining pending', async () => {
    deferSource(); await mount(); await click();
    await act(async () => { useApp.setState({ base: { ...completed(), buildings: [{ ...building, underConstruction: true }] } }); });
    expect(node.querySelector('[role="status"]')?.textContent).toContain('completed Workshop');
    expect(node.querySelector('button')?.disabled).toBe(false); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it.each([
    ['source', 'Close the current panel'], ['scope', 'selection changed'], ['placing', 'Finish or cancel placement'],
    ['building', 'completed Workshop'], ['web-held', 'Available in the Android app'],
    ['unregistered', 'not available yet'], ['capability', 'actions are unavailable'],
    ['registration-changed', 'panel changed'], ['open-refused', "Workshop couldn't open"],
  ] as const)('renders the %s refusal and never falls back to legacy or history', async (reason: OrdinaryCraftingPanelRefusal, text) => {
    calls.request.mockImplementationOnce(() => settled({ status: 'fulfilled', value: { outcome: 'refused', reason } }));
    await mount(); await click();
    expect(node.querySelector('[role="status"]')?.textContent).toContain(text);
    expect(calls.legacy).not.toHaveBeenCalled(); expect(calls.history).not.toHaveBeenCalled();
  });
  it('rejected navigation shows a safe local status, never exception details or legacy fallback', async () => {
    calls.request.mockImplementationOnce(() => settled({ status: 'rejected', error: Error('private transport detail') }));
    await mount(); await click(); expect(node.querySelector('[role="status"]')?.textContent).toBe("Workshop couldn't open. Please try again.");
    expect(node.textContent).not.toContain('private transport detail'); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('a subsequent selection change clears stale refusal feedback without invoking the producer again', async () => {
    calls.request.mockImplementationOnce(() => settled({ status: 'fulfilled', value: { outcome: 'refused', reason: 'open-refused' } }));
    await mount(); await click(); expect(node.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => { useApp.getState().select('other'); });
    expect(node.querySelector('[role="status"]')).toBeNull(); expect(calls.request).toHaveBeenCalledTimes(1);
  });
});
