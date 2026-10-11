// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from 'react';
import { STRUCTURES } from '@shardkeep/shared';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { bus } from '../../lib/events';
import { configureBasePanels, inspectConfiguredBasePanel, useApp, type BaseStateDto } from '../../state/store';
import { BUILDINGS_INFO_SOURCE, ORDINARY_CRAFTING_PANEL } from '../../lib/phaseEActivity/panelIds';
import { hasBuildingActivityAccess } from '../../lib/phaseEActivity/access';
import { BASE_FEATURES, createBaseFeatureRegistry, type BaseFeatureProps } from './featureRegistry';
import { buildingFeatures } from './buildings/features';
import { craftFeatures } from './craft/features';
import type { BuildingInfoActions, BuildingInfoUi } from './buildings/BuildingInfoSheet';
import type { BuildingInfoPanelProps } from './buildings/BuildingInfoPanel';
import { createPanelSession, type PanelDismissRequest } from './panelSession';
import { getH1BaseRegistry, isH1InfoFeature } from './h1BaseRegistry';
import { installH1BuildingIntake, useH1BuildingIntake } from './H1BuildingIntake';
import { OverlayHost } from './OverlayHost';

const calls = vi.hoisted(() => ({ info: vi.fn(), bound: vi.fn(), maxLevel: vi.fn(), craft: vi.fn(), request: vi.fn(), reload: vi.fn(), post: vi.fn(), journal: vi.fn() }));
// Capture the real binder session while still rendering W4's actual panel and guards.
vi.mock('./buildings/BuildingInfoPanel', async original => {
  const actual = await original<typeof import('./buildings/BuildingInfoPanel')>();
  return { ...actual, default: (props: BuildingInfoPanelProps) => { calls.bound(props); return <actual.default {...props} />; } };
});
vi.mock('./buildings/BuildingInfoSheet', () => ({ default: ({ ui, on }: { ui: BuildingInfoUi; on: BuildingInfoActions }) => {
  calls.info({ ui, on }); return <section aria-label={`${ui.name} info`}><h2>{ui.name} · {ui.levelTag}</h2>
    {ui.stats.map(stat => <p key={stat.label}>{stat.label}: {stat.now}</p>)}
    <button onClick={on.onRetry}>REFRESH FACTS</button><button onClick={on.onFinish}>FINISH</button>
    <button onClick={on.onExtra}>EXTRA</button><button onClick={on.onClose}>CLOSE INFO</button></section>;
} }));
vi.mock('./craft/WorkshopPanel', () => ({ default: (props: BaseFeatureProps) => { calls.craft(props); return <div>Bound Workshop owner</div>; } }));
vi.mock('./SheetHost', () => ({ PkSheetHost: ({ sheet, children }: { sheet: unknown; children: ReactNode }) => sheet ? <div data-host>{children}</div> : null }));
vi.mock('../../lib/mobileBackGuard', () => ({ installOverlayEscapeBridge: () => () => undefined }));
vi.mock('../../state/baseSnapshot', () => ({ reloadBase: calls.reload }));
vi.mock('../../lib/api', () => ({ api: { post: calls.post }, ApiError: class extends Error {} }));
vi.mock('../sheets', () => ({ maxLevelFor: calls.maxLevel, trayLabel: (type: string) => type.toUpperCase(), sheetPortrait: (type: string, level: number) => `${type}-level-${level}` }));
vi.mock('../BuildingInfo', () => ({ default: () => <div>Existing building details</div> }));
vi.mock('../primitives', () => ({ Sprite: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('../../lib/phaseEActivity/access', async original => {
  const actual = await original<typeof import('../../lib/phaseEActivity/access')>();
  return { ...actual, requestOrdinaryCraftingPanel: (...args: Parameters<typeof actual.requestOrdinaryCraftingPanel>) => { calls.request(...args); return actual.requestOrdinaryCraftingPanel(...args); } };
});
vi.mock('../../auth/authCookieCoordinator', () => ({ authCookies: { captureGeneration: () => 1, current: () => true } }));
vi.mock('../../lib/ordinaryCrafting/browser', () => ({ ordinaryCraftingIdentity: (wallet: string) => ({ wallet }), createOrdinaryCraftingBrowserPorts: () => ({}) }));
vi.mock('../../lib/ordinaryCrafting/snapshot', () => ({ refreshOrdinaryCraftingSnapshot: async () => ({ enabled: true, view: { pendingJobs: [] } }) }));
vi.mock('../../lib/ordinaryCrafting/journal', () => ({ OrdinaryCraftingJournalStore: class { async read() { calls.journal(); return { operation: {}, archives: [] }; } async close() {} } }));
vi.mock('../../lib/boundCosmetics/workshopJournal', () => ({ WorkshopJournalStore: class { async read() { return { operation: null, archives: [] }; } async close() {} } }));
vi.mock('../../lib/boundCosmetics/workshopBrowser', () => ({ createWorkshopBrowserPorts: () => { throw Error('External I/O excluded'); } }));
vi.mock('../phaseE/PhaseEActionDock', () => ({ PhaseEEntryButton: ({ variant: _variant, ...props }: ComponentProps<'button'> & { variant?: string }) => <button {...props} /> }));

const wallet = '11111111111111111111111111111111', baseId = 'base-a';
const buildings = ['lodge', 'berth', 'harvester', 'workshop', 'wall', 'cannon', 'keep', 'mine'].map(type => ({ id: `${type}-1`, type, level: 1, tx: 1, ty: 1, underConstruction: false }));
const snapshot = (): BaseStateDto => ({ baseId, player: { wallet, builders: 2 }, freeBuilders: 1, buildings, jobs: [] }) as unknown as BaseStateDto;
let root: ReturnType<typeof createRoot>, node: HTMLDivElement, prior: ReturnType<typeof useApp.getState>;
let cleanup: (() => void)[] = [];
const onInset = vi.fn();
const mount = async (capability = true) => { await act(async () => root.render(<OverlayHost baseActionsEnabled={capability} onInset={onInset}><div>Original base content</div></OverlayHost>)); };
// The host renders INFO and Craft through React.lazy. Under a loaded full-suite run the import can outlast the act,
// leaving the "Loading Building…" fallback (night 2026-10-06: 19 red). Settle it in a separate act, as 08e05b66b does.
const settle = async () => { await act(async () => { await vi.dynamicImportSettled(); }); };
const tap = async (type: string) => { await act(async () => { useApp.getState().select(`${type}-1`); bus.emit('base:select', { buildingId: `${type}-1` }); }); await settle(); };
const click = async (text: string) => { const button = [...node.querySelectorAll('button')].find(b => b.textContent === text); expect(button, text).toBeDefined(); await act(async () => button!.click()); await settle(); };
const info = () => calls.info.mock.calls.at(-1)![0] as { ui: BuildingInfoUi; on: BuildingInfoActions };
beforeEach(() => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks();
  prior = useApp.getState(); configureBasePanels(BASE_FEATURES, false);
  useApp.setState({ authed: true, wallet, selectedBaseId: baseId, baseSelectionEpoch: 3, base: snapshot(), selectedBuildingId: null, basePanel: null, screen: 'base', placing: null, wallRow: false });
  calls.reload.mockResolvedValue(undefined); calls.maxLevel.mockReturnValue(STRUCTURES.workshop.maxLevel); node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); for (const dispose of cleanup.reverse()) dispose(); cleanup = [];
  configureBasePanels(BASE_FEATURES, false); useApp.setState(prior, true); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe('H1 corrected registry and guarded scene entry', () => {
  it('registers the real Workshop before bound INFO without changing BASE_FEATURES or granting mutation', () => {
    const before = Object.keys(BASE_FEATURES), registry = getH1BaseRegistry();
    expect(Object.keys(registry).indexOf(ORDINARY_CRAFTING_PANEL.featureId)).toBeLessThan(Object.keys(registry).indexOf(BUILDINGS_INFO_SOURCE.featureId));
    expect(Object.keys(BASE_FEATURES)).toEqual(before);
    expect(buildingFeatures[0]).toMatchObject({ id: BUILDINGS_INFO_SOURCE.featureId, kind: BUILDINGS_INFO_SOURCE.kind, size: 'HALF', readOnly: false });
    expect(craftFeatures[0]).toMatchObject({ id: ORDINARY_CRAFTING_PANEL.featureId, kind: ORDINARY_CRAFTING_PANEL.kind });
    expect(registry[BUILDINGS_INFO_SOURCE.featureId]?.canMutate).toBeUndefined();
    expect(registry[ORDINARY_CRAFTING_PANEL.featureId]?.canMutate?.({ ...ORDINARY_CRAFTING_PANEL })).toBe(false);
    expect(getH1BaseRegistry()).toBe(registry); expect(Object.isFrozen(registry)).toBe(true);
  });
  it('both feature definition files keep the first-paint no-lib runtime-import boundary', () => {
    for (const path of ['./buildings/features.ts', './craft/features.ts']) {
      const file = resolve(dirname(fileURLToPath(import.meta.url)), path);
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const imports = source.statements.filter(ts.isImportDeclaration).filter(n => !n.importClause?.isTypeOnly);
      expect(imports.filter(n => ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text.includes('/lib/'))).toEqual([]);
    }
  });
  it.each(['lodge', 'berth', 'harvester', 'workshop'])('the guarded live-base %s tap opens its INFO, without opening Craft', async type => {
    await mount(); await tap(type);
    expect(useApp.getState().basePanel).toEqual({ ...BUILDINGS_INFO_SOURCE, buildingId: `${type}-1` });
    expect(info().ui.buildingId).toBe(`${type}-1`); expect(info().ui.levelTag).toBe('LV 1');
    expect(calls.request).not.toHaveBeenCalled(); expect(calls.craft).not.toHaveBeenCalled(); expect(calls.post).not.toHaveBeenCalled();
  });
  it.each(['lodge', 'berth', 'harvester', 'workshop'])('a held %s tap keeps the original base content and opens no panel', async type => {
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); await mount(); await tap(type);
    expect(useApp.getState().basePanel).toBeNull(); expect(node.textContent).toContain('Original base content');
    expect(calls.info).not.toHaveBeenCalled(); expect(calls.request).not.toHaveBeenCalled();
  });
  it.each(['wallet', 'auth', 'base', 'epoch', 'screen'] as const)('a retired %s ABA cannot use a cached intake event before React paints', async field => {
    await mount(); useApp.getState().select('workshop-1'); const before = useApp.getState();
    await act(async () => {
      if (field === 'wallet') useApp.setState({ wallet: '11111111111111111111111111111112' });
      if (field === 'auth') useApp.setState({ authed: false });
      if (field === 'base') useApp.setState({ selectedBaseId: 'base-b' });
      if (field === 'epoch') useApp.setState({ baseSelectionEpoch: before.baseSelectionEpoch + 1 });
      if (field === 'screen') useApp.setState({ screen: 'build' });
      useApp.setState(before, true); bus.emit('base:select', { buildingId: 'workshop-1' });
    });
    expect(useApp.getState().basePanel).toBeNull(); expect(calls.request).not.toHaveBeenCalled();
  });
  it('the held registry is the original BASE_FEATURES object, independently of the feature guard', () => {
    const enabled = getH1BaseRegistry(BASE_FEATURES);
    expect(enabled[BUILDINGS_INFO_SOURCE.featureId]).toBeDefined();
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    expect(getH1BaseRegistry(BASE_FEATURES)).toBe(BASE_FEATURES);
    expect(Object.keys(BASE_FEATURES)).not.toContain(BUILDINGS_INFO_SOURCE.featureId);
    expect(Object.keys(BASE_FEATURES)).not.toContain(ORDINARY_CRAFTING_PANEL.featureId);
  });
  it('the feature guard refuses an already-created INFO feature when the switch is off', () => {
    const feature = getH1BaseRegistry()[BUILDINGS_INFO_SOURCE.featureId]!;
    expect(isH1InfoFeature(feature)).toBe(true);
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    expect(isH1InfoFeature(feature)).toBe(false);
  });
  it('the held installer installs no bus listener or store subscription even with a cached enabled registry', () => {
    configureBasePanels(getH1BaseRegistry(), true);
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    const listen = vi.spyOn(bus, 'on'), subscribe = vi.spyOn(useApp, 'subscribe');
    const stop = installH1BuildingIntake(); cleanup.push(stop);
    expect(listen).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
    stop(); stop(); expect(useApp.getState().basePanel).toBeNull();
  });
  it('the held intake hook also has no scope subscription or tap listener', async () => {
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    const listen = vi.spyOn(bus, 'on'), subscribe = vi.spyOn(useApp, 'subscribe');
    function IntakeOnly() { useH1BuildingIntake(); return null; }
    await act(async () => root.render(<IntakeOnly />));
    expect(listen).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
  });
  it.each(['cannon', 'keep', 'mine', 'wall'])('retargeting Workshop INFO to %s closes through the intake and restores original content', async type => {
    await mount(); await tap('workshop'); expect(useApp.getState().basePanel?.featureId).toBe(BUILDINGS_INFO_SOURCE.featureId);
    await tap(type);
    expect(useApp.getState().selectedBuildingId).toBe(`${type}-1`); expect(useApp.getState().basePanel).toBeNull();
    expect(node.querySelector('[data-host]')).toBeNull(); expect(node.textContent).toContain('Original base content');
    expect(calls.request).not.toHaveBeenCalled(); expect(calls.post).not.toHaveBeenCalled();
  });
  it.each(['lodge', 'berth', 'harvester', 'workshop'])('an admitted retarget keeps the current %s INFO', async type => {
    await mount(); await tap('workshop'); await tap(type);
    expect(useApp.getState().basePanel).toEqual({ ...BUILDINGS_INFO_SOURCE, buildingId: `${type}-1` });
    expect(info().ui.buildingId).toBe(`${type}-1`); expect(node.textContent).not.toContain('Original base content');
    expect(calls.request).not.toHaveBeenCalled();
  });
  it('retargeting to an unfinished H1 building restores its original sheet', async () => {
    await mount(); await tap('workshop');
    await act(async () => useApp.setState({ base: { ...snapshot(), buildings: buildings.map(b => b.type === 'lodge' ? { ...b, underConstruction: true } : b) } }));
    await tap('lodge'); expect(useApp.getState().basePanel).toBeNull(); expect(node.textContent).toContain('Original base content');
    expect(calls.request).not.toHaveBeenCalled();
  });
  it.each(['proceed', 'cancel', 'stale'] as const)('unsupported retarget closure obeys the user-command policy: %s', async outcome => {
    await mount(); await tap('workshop');
    await act(async () => useApp.getState().select('cannon-1'));
    const panel = useApp.getState().basePanel!;
    const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => false, canRecover: () => false });
    cleanup.push(session.mount()); const requests: PanelDismissRequest[] = []; cleanup.push(session.setDismissPolicy(request => { requests.push(request); }));
    await act(async () => bus.emit('base:select', { buildingId: 'cannon-1' }));
    expect(requests).toHaveLength(1); expect(useApp.getState().basePanel).toBe(panel);
    if (outcome === 'proceed') {
      await act(async () => { expect(requests[0]!.proceed()).toBe(true); });
      expect(useApp.getState().basePanel).toBeNull(); expect(node.textContent).toContain('Original base content');
    } else if (outcome === 'cancel') {
      await act(async () => requests[0]!.cancel?.());
      expect(requests[0]!.proceed()).toBe(false); expect(useApp.getState().basePanel).toBe(panel);
    } else {
      await act(async () => useApp.getState().select('berth-1'));
      expect(requests[0]!.proceed()).toBe(false); expect(useApp.getState().basePanel?.buildingId).toBe('berth-1');
    }
    expect(calls.request).not.toHaveBeenCalled(); expect(calls.post).not.toHaveBeenCalled();
  });
  it('mounting a restored selection alone never opens INFO or requests a grant', async () => {
    useApp.setState({ selectedBuildingId: 'workshop-1' }); await mount(); await mount();
    expect(useApp.getState().basePanel).toBeNull(); expect(calls.info).not.toHaveBeenCalled(); expect(calls.request).not.toHaveBeenCalled();
  });
  it.each(['base-id', 'wallet', 'selection', 'construction', 'build-screen'] as const)('a tap refuses a stale or unavailable %s source', async reason => {
    await mount(); useApp.getState().select('workshop-1');
    if (reason === 'base-id') useApp.setState({ base: { ...snapshot(), baseId: 'other-base' } });
    if (reason === 'wallet') useApp.setState({ base: { ...snapshot(), player: { ...snapshot().player, wallet: 'other-wallet' } } });
    if (reason === 'selection') useApp.getState().select('berth-1');
    if (reason === 'construction') useApp.setState({ base: { ...snapshot(), buildings: buildings.map(b => b.type === 'workshop' ? { ...b, underConstruction: true } : b) } });
    if (reason === 'build-screen') useApp.setState({ screen: 'build' });
    await act(async () => bus.emit('base:select', { buildingId: 'workshop-1' }));
    expect(useApp.getState().basePanel).toBeNull(); expect(calls.request).not.toHaveBeenCalled();
  });
  it('uses the real HALF/readOnly-false INFO admission: host capability false refuses a new open', async () => {
    await mount(false); await tap('workshop');
    expect(inspectConfiguredBasePanel({ ...BUILDINGS_INFO_SOURCE, buildingId: 'workshop-1' }).registered).toBe(true);
    expect(useApp.getState().basePanel).toBeNull(); expect(calls.info).not.toHaveBeenCalled();
  });
  it('a retired intake and a retained dismissal continuation cannot open INFO', async () => {
    const registry = getH1BaseRegistry(), draft = { kind: 'hub' as const, featureId: 'draft' };
    configureBasePanels(Object.freeze({ ...registry, ...createBaseFeatureRegistry([{ ...draft, id: draft.featureId, label: 'Draft', size: 'TALL', readOnly: true, load: async () => ({ default: () => null }) }]) }), true);
    useApp.setState({ selectedBuildingId: 'workshop-1', basePanel: draft });
    const session = createPanelSession({ panel: draft, controlled: true, isCurrent: () => useApp.getState().basePanel === draft, canMutate: () => false, canRecover: () => false });
    cleanup.push(session.mount()); const pending: PanelDismissRequest[] = []; cleanup.push(session.setDismissPolicy(request => { pending.push(request); }));
    const stop = installH1BuildingIntake(); bus.emit('base:select', { buildingId: 'workshop-1' });
    expect(pending).toHaveLength(1); stop(); expect(pending[0]!.proceed()).toBe(false);
    bus.emit('base:select', { buildingId: 'workshop-1' }); expect(pending).toHaveLength(1); expect(useApp.getState().basePanel).toBe(draft);
  });
  it('base panels never render or admit retained read callbacks on another screen', async () => {
    await mount(); await tap('workshop'); const retained = info().on;
    await act(async () => useApp.setState({ screen: 'ordinary-crafting' }));
    expect(node.querySelector('[data-host]')).toBeNull();
    retained.onRetry?.(); expect(calls.reload).not.toHaveBeenCalled(); expect(calls.request).not.toHaveBeenCalled();
  });
});

describe('H1 facts and read callbacks', () => {
  it('the Workshop Craft control reveals the existing door; only the door click opens Craft and mints its grant', async () => {
    await mount(); await tap('workshop'); await click('WORKSHOP');
    expect(calls.request).not.toHaveBeenCalled(); expect(useApp.getState().basePanel?.featureId).toBe(BUILDINGS_INFO_SOURCE.featureId);
    expect(calls.journal).toHaveBeenCalled(); await click('WORKSHOP & SAVED RECEIPTS');
    expect(calls.request).toHaveBeenCalledExactlyOnceWith('workshop-1');
    expect(useApp.getState().basePanel).toEqual({ ...ORDINARY_CRAFTING_PANEL, buildingId: 'workshop-1' });
    expect(hasBuildingActivityAccess('ordinary-crafting')).toBe(true); expect(calls.craft).toHaveBeenCalled();
    expect(calls.craft.mock.calls.at(-1)?.[0].actionsEnabled).toBe(true);
    await mount(false); expect(calls.craft.mock.calls.at(-1)?.[0].actionsEnabled).toBe(false);
  });
  it.each(['lodge', 'berth', 'harvester'])('%s INFO never reveals a Workshop control', async type => {
    await mount(); await tap(type);
    expect([...node.querySelectorAll('button')].some(b => b.textContent === 'WORKSHOP')).toBe(false);
    expect(calls.journal).not.toHaveBeenCalled(); expect(calls.request).not.toHaveBeenCalled();
  });
  it('a supplied job keeps construction facts truthful and Finish/CANCEL_JOB denied', async () => {
    const job = { id: 'job-a', buildingId: 'workshop-1', obstacleId: null, kind: 'upgrade', startedAt: '2026-10-04T00:00:00Z', finishesAt: '2026-10-05T00:00:00Z', finishCostKeep: '0', canCancel: true, refundShards: '19' };
    useApp.setState({ base: { ...snapshot(), jobs: [job] } }); await mount(); await tap('workshop');
    expect(info().ui.upgrading).toBe(true); expect(info().ui.primary.state).toBe('DISABLED');
    await click('FINISH'); await click('EXTRA');
    expect(useApp.getState().base?.jobs).toEqual([job]); expect(calls.post).not.toHaveBeenCalled();
    expect([...node.querySelectorAll('button')].some(b => b.textContent === 'WORKSHOP')).toBe(false);
  });
  // ba693959 excludes Wall INFO tonight; the existing Wall sheet retains row selection.
  it('Wall retarget makes TOGGLE_ROW unreachable and a retained INFO callback cannot toggle a row', async () => {
    const row = vi.fn(); cleanup.push(bus.on('base:wallRow', row));
    await mount(); await tap('workshop'); const retained = info().on;
    await tap('wall'); retained.onExtra?.();
    expect(useApp.getState().basePanel).toBeNull(); expect(node.textContent).toContain('Original base content');
    expect(calls.bound.mock.calls.some(([props]) => props.input?.facts.type === 'wall')).toBe(false);
    expect(useApp.getState().wallRow).toBe(false); expect(row).not.toHaveBeenCalled(); expect(calls.post).not.toHaveBeenCalled();
  });
  it.each(['FINISH', 'CANCEL_JOB'])('the live bound session refuses %s mutation without the enabled short-circuit', async action => {
    await mount(); await tap('workshop');
    const bound = calls.bound.mock.calls.at(-1)![0] as BuildingInfoPanelProps;
    expect(bound.input?.facts.enabled).toBe(true);
    const mutate = vi.fn().mockName(action), read = vi.fn();
    expect(bound.session.dispatch('read', read)).toBe(true); expect(read).toHaveBeenCalledOnce();
    expect(bound.session.dispatch('mutate', mutate)).toBe(false); expect(mutate).not.toHaveBeenCalled();
    expect(inspectConfiguredBasePanel({ ...BUILDINGS_INFO_SOURCE, buildingId: 'workshop-1' }).feature?.canMutate).toBeUndefined();
    expect(calls.post).not.toHaveBeenCalled();
  });
  it('shows the server level without a browser HP estimate and uses the original sheet level-cap helper', async () => {
    useApp.setState({ base: { ...snapshot(), buildings: buildings.map(b => b.type === 'workshop' ? { ...b, level: 6 } : b) } });
    await mount(); await tap('workshop');
    expect(info().ui.levelTag).toBe('LV 6'); expect(info().ui.stats).toEqual([]);
    expect(node.textContent).not.toContain('Hitpoints'); expect(calls.maxLevel).toHaveBeenCalledWith('workshop');
  });
  it('current refresh uses the existing reader, and a stale base callback cannot refresh or reveal Craft', async () => {
    await mount(); await tap('workshop'); await click('REFRESH FACTS'); expect(calls.reload).toHaveBeenCalledTimes(1);
    const retained = info().on;
    await act(async () => useApp.setState({ baseSelectionEpoch: 4, selectedBaseId: 'other-base' }));
    retained.onRetry?.(); expect(calls.reload).toHaveBeenCalledTimes(1); expect(calls.request).not.toHaveBeenCalled();
  });
  it('a retained Workshop becomes construction: supplied job is shown and the discovery door retires', async () => {
    await mount(); await tap('workshop'); await click('WORKSHOP');
    expect(node.textContent).toContain('WORKSHOP & SAVED RECEIPTS');
    const job = { id: 'job-build', buildingId: 'workshop-1', obstacleId: null, kind: 'build', startedAt: '2026-10-04T00:00:00Z', finishesAt: '2026-10-05T00:00:00Z', finishCostKeep: '0' };
    await act(async () => useApp.setState({ base: { ...snapshot(), jobs: [job], buildings: buildings.map(b => b.type === 'workshop' ? { ...b, underConstruction: true } : b) } }));
    expect(info().ui.upgrading).toBe(true); expect(info().ui.stateTag.text).toContain('BUILDING');
    expect(info().ui.primary.state).toBe('DISABLED'); expect(node.textContent).not.toContain('WORKSHOP & SAVED RECEIPTS');
    await click('FINISH'); expect(calls.request).not.toHaveBeenCalled(); expect(calls.post).not.toHaveBeenCalled();
  });
  it('under-construction without a supplied job never displays ready INFO or Craft', async () => {
    await mount(); await tap('workshop'); calls.info.mockClear();
    await act(async () => useApp.setState({ base: { ...snapshot(), buildings: buildings.map(b => b.type === 'workshop' ? { ...b, underConstruction: true } : b) } }));
    expect(calls.info).not.toHaveBeenCalled(); expect(node.textContent).toContain('Building details are updating');
    expect(calls.request).not.toHaveBeenCalled();
  });
  it('removing host capability hides Craft and preserves read-only facts on the retained INFO', async () => {
    await mount(); await tap('workshop'); const panel = useApp.getState().basePanel; await mount(false);
    expect(useApp.getState().basePanel).toBe(panel); expect(info().ui.buildingId).toBe('workshop-1');
    expect([...node.querySelectorAll('button')].some(b => b.textContent === 'WORKSHOP')).toBe(false);
    expect(calls.post).not.toHaveBeenCalled();
  });
});
