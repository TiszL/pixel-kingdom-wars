// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureBasePanels, inspectConfiguredBasePanel, useApp, type Screen } from '../../state/store';
import { createBaseFeatureRegistry, type BaseFeature, type BaseFeatureDefinition } from '../pk/featureRegistry';
import { OverlayHost } from '../pk/OverlayHost';
import { createPanelSession, type PanelDismissRequest } from '../pk/panelSession';
import { getVehicleRecoveryRegistry, isVehicleRecoveryFeature, VEHICLE_RECOVERY_PANEL } from '../pk/vehicleRecoveryRegistry';
import { vehicleRecoveryFeature } from '../pk/voyage/vehicleRecoveryFeature';
import { VehicleEntry } from './VehicleEntry';

const calls = vi.hoisted(() => ({ legacy: vi.fn(), panel: vi.fn() }));
vi.mock('./VehicleScreen', () => ({ VehicleScreen: (props: unknown) => { calls.legacy(props); return <div>Existing directory vehicle screen</div>; } }));
vi.mock('../pk/BasePanelHost', () => ({ BasePanelHost: ({ feature }: { feature: BaseFeature | null }) => {
  calls.panel(feature); return feature ? <div data-panel>{feature.label}</div> : null;
} }));
vi.mock('../../lib/mobileBackGuard', () => ({ installOverlayEscapeBridge: () => () => undefined }));
vi.mock('./PhaseEActionDock', () => ({ PhaseEEntryButton: ({ variant: _variant, ...props }: ComponentProps<'button'> & { variant?: string }) => <button {...props} /> }));

const draft: BaseFeatureDefinition = { id: 'test.draft', kind: 'hub', label: 'Draft', size: 'TALL', readOnly: true, dismissal: 'controller', load: async () => ({ default: () => null }) };
const baseRegistry = createBaseFeatureRegistry([draft]);
let root: ReturnType<typeof createRoot>, node: HTMLDivElement;
let prior: ReturnType<typeof useApp.getState>;
let cleanup: (() => void)[] = [];
const onInset = vi.fn();
const mount = async (capability = false) => {
  await act(async () => root.render(<>
    <OverlayHost registry={baseRegistry} baseActionsEnabled={capability} onInset={onInset}><span>Legacy base content</span></OverlayHost>
    <VehicleEntry actionsEnabled={capability} trust={null} />
  </>));
};
const click = async () => { const button = node.querySelector('button'); expect(button).not.toBeNull(); await act(async () => button!.click()); };
function hold() {
  const panel = { kind: 'hub' as const, featureId: draft.id };
  useApp.setState({ basePanel: panel });
  const requests: PanelDismissRequest[] = [];
  const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => false, canRecover: () => false });
  cleanup.push(session.mount()); cleanup.push(session.setDismissPolicy(request => { requests.push(request); }));
  return { panel, requests };
}
beforeEach(() => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  prior = useApp.getState(); vi.clearAllMocks();
  configureBasePanels(baseRegistry, false);
  useApp.setState({ wallet: 'wallet-a', authed: true, selectedBaseId: 'base-a', baseSelectionEpoch: 7, screen: 'base', basePanel: null, placing: null });
  node = document.createElement('div'); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const dispose of cleanup.reverse()) dispose(); cleanup = [];
  configureBasePanels({}, false); useApp.setState(prior, true);
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe('Vehicle recovery host registry', () => {
  it.each(['', '0', 'true'])('hold value %j neither registers recovery nor mounts the door', async value => {
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', value);
    expect(getVehicleRecoveryRegistry(baseRegistry)).toBe(baseRegistry);
    await mount();
    expect(inspectConfiguredBasePanel(VEHICLE_RECOVERY_PANEL).registered).toBe(false);
    expect(node.querySelector('button')).toBeNull(); expect(calls.legacy).not.toHaveBeenCalled();
    expect(useApp.getState().basePanel).toBeNull();
  });
  it('uses the accepted descriptor and feature, preserving the recovery/mutation distinction', () => {
    const registry = getVehicleRecoveryRegistry(baseRegistry), feature = registry[vehicleRecoveryFeature.id]!;
    expect(VEHICLE_RECOVERY_PANEL).toEqual({ kind: vehicleRecoveryFeature.kind, featureId: vehicleRecoveryFeature.id });
    expect(feature.label).toBe('Vehicle history'); expect(feature.readOnly).toBe(true);
    expect(feature.dismissal).toBe('controller'); expect(feature.canMutate?.(VEHICLE_RECOVERY_PANEL)).toBe(false);
    expect(feature.canRecover).toBe(vehicleRecoveryFeature.canRecover);
    expect(isVehicleRecoveryFeature(feature)).toBe(true);
    expect(feature.canRecover?.(VEHICLE_RECOVERY_PANEL)).toBe(true);
    useApp.setState({ authed: false }); expect(feature.canRecover?.(VEHICLE_RECOVERY_PANEL)).toBe(false);
    useApp.setState({ authed: true, wallet: null }); expect(feature.canRecover?.(VEHICLE_RECOVERY_PANEL)).toBe(false);
  });
  it('substitutes exactly one recovery definition for a held same-id definition without mutating other entries', () => {
    const legacy = createBaseFeatureRegistry([draft, { ...vehicleRecoveryFeature, label: 'Held mutation body', readOnly: false, canMutate: () => true }]);
    const registered = getVehicleRecoveryRegistry(legacy);
    expect(Object.keys(registered).filter(id => id === vehicleRecoveryFeature.id)).toHaveLength(1);
    expect(registered[draft.id]).toBe(legacy[draft.id]);
    expect(registered[vehicleRecoveryFeature.id]?.label).toBe('Vehicle history');
    expect(legacy[vehicleRecoveryFeature.id]?.label).toBe('Held mutation body');
    expect(Object.isFrozen(registered)).toBe(true);
  });
  it('keeps feature and registry identity stable, and the current hold rejects a retained recovery feature', () => {
    const first = getVehicleRecoveryRegistry(baseRegistry);
    expect(getVehicleRecoveryRegistry(baseRegistry)).toBe(first);
    expect(getVehicleRecoveryRegistry(createBaseFeatureRegistry([draft]))[vehicleRecoveryFeature.id]).toBe(first[vehicleRecoveryFeature.id]);
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    expect(getVehicleRecoveryRegistry(baseRegistry)).toBe(baseRegistry);
    expect(isVehicleRecoveryFeature(first[vehicleRecoveryFeature.id])).toBe(false);
  });
  it('the web hold also removes an incoming same-id legacy definition without altering the caller registry', () => {
    const legacy = createBaseFeatureRegistry([draft, { ...vehicleRecoveryFeature, label: 'Held mutation body', readOnly: false }]);
    vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    const held = getVehicleRecoveryRegistry(legacy);
    expect(Object.hasOwn(held, vehicleRecoveryFeature.id)).toBe(false);
    expect(held[draft.id]).toBe(legacy[draft.id]);
    expect(legacy[vehicleRecoveryFeature.id]?.label).toBe('Held mutation body');
    expect(getVehicleRecoveryRegistry(legacy)).toBe(held); expect(Object.isFrozen(held)).toBe(true);
  });
});

describe('Vehicle recovery live-base door', () => {
  it('mount and rerender only configure the host; they never open a destination or mount the legacy screen', async () => {
    await mount(); await mount(true);
    expect(inspectConfiguredBasePanel(VEHICLE_RECOVERY_PANEL).registered).toBe(true);
    expect(useApp.getState().basePanel).toBeNull(); expect(node.querySelector('[data-panel]')).toBeNull();
    expect(calls.legacy).not.toHaveBeenCalled();
  });
  it.each([
    { screen: 'base', capability: false }, { screen: 'base', capability: true },
    { screen: 'build', capability: false }, { screen: 'build', capability: true },
  ] as const)('opens only the shared recovery host from $screen with mutation capability=$capability', async ({ screen, capability }) => {
    useApp.setState({ screen }); await mount(capability); await click();
    expect(useApp.getState().basePanel).toEqual(VEHICLE_RECOVERY_PANEL);
    expect(useApp.getState().screen).toBe('base'); expect(node.querySelector('[data-panel]')?.textContent).toBe('Vehicle history');
    const feature = inspectConfiguredBasePanel(VEHICLE_RECOVERY_PANEL).feature;
    expect(isVehicleRecoveryFeature(feature)).toBe(true); expect(feature?.canMutate?.(VEHICLE_RECOVERY_PANEL)).toBe(false);
    expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('two clicks in one act request one dismissal; proceeding opens the shared panel once', async () => {
    await mount(); const h = hold(); const button = node.querySelector('button')!;
    await act(async () => { button.click(); expect(button.disabled).toBe(false); button.click(); });
    expect(h.requests).toHaveLength(1); expect(button.disabled).toBe(true);
    expect(useApp.getState().basePanel).toBe(h.panel);
    await act(async () => { expect(h.requests[0]!.proceed()).toBe(true); });
    expect(useApp.getState().basePanel).toEqual(VEHICLE_RECOVERY_PANEL);
    expect(h.requests[0]!.proceed()).toBe(false); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('a dismissal refusal is quiet and re-enables the door with no legacy fallback', async () => {
    await mount(); const h = hold(); await click();
    await act(async () => h.requests[0]!.cancel?.());
    expect(useApp.getState().basePanel).toBe(h.panel); expect(node.querySelector('button')?.disabled).toBe(false);
    expect(node.querySelector('[role="status"]')).toBeNull(); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it.each(['wallet', 'base', 'epoch', 'auth ABA', 'screen ABA', 'unmount', 'hold'] as const)('a retained request cannot open after %s', async change => {
    await mount(); const h = hold(); await click();
    await act(async () => {
      if (change === 'wallet') useApp.setState({ wallet: 'wallet-b' });
      if (change === 'base') useApp.setState({ selectedBaseId: 'base-b' });
      if (change === 'epoch') useApp.setState({ baseSelectionEpoch: 8 });
      if (change === 'auth ABA') { useApp.setState({ authed: false }); useApp.setState({ authed: true }); }
      if (change === 'screen ABA') { useApp.setState({ screen: 'bases' }); useApp.setState({ screen: 'base' }); }
      if (change === 'unmount') root.render(null);
      if (change === 'hold') vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
    });
    await act(async () => { expect(h.requests[0]!.proceed()).toBe(false); });
    expect(useApp.getState().basePanel?.featureId).not.toBe(vehicleRecoveryFeature.id);
    expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('replacing the configured recovery feature while dismissal is deferred refuses the retained request', async () => {
    await mount(); const h = hold(); await click();
    const replacement = createBaseFeatureRegistry([{ ...vehicleRecoveryFeature, label: 'Other definition' }]);
    configureBasePanels(Object.freeze({ ...baseRegistry, ...replacement }), false);
    await act(async () => { expect(h.requests[0]!.proceed()).toBe(false); });
    expect(useApp.getState().basePanel).toBe(h.panel); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('an unavailable registration reports a refusal and never opens the legacy screen', async () => {
    await act(async () => root.render(<VehicleEntry actionsEnabled trust={null} />));
    await click();
    expect(node.querySelector('[role="status"]')?.textContent).toBe('Vehicle history is unavailable. Please try again.');
    expect(useApp.getState().basePanel).toBeNull(); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('clicking again on the current recovery panel preserves its exact owner descriptor', async () => {
    await mount(); await click(); const panel = useApp.getState().basePanel;
    await click(); expect(useApp.getState().basePanel).toBe(panel); expect(calls.legacy).not.toHaveBeenCalled();
  });
  it('holds the current registry and retires its recovery panel when the web switch is removed', async () => {
    await mount(); await click(); vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); await mount();
    expect(inspectConfiguredBasePanel(VEHICLE_RECOVERY_PANEL).registered).toBe(false);
    expect(useApp.getState().basePanel).toBeNull(); expect(node.querySelector('button')).toBeNull();
  });
  // 3bbc26c6 closes the old directory route before any switch-on build is served.
  it.each(['bases', 'map', 'shop'] as const)('offers no Vehicle entry or alternate screen on %s', async screen => {
    useApp.setState({ screen: screen as Screen }); await mount();
    expect(node.querySelector('button')).toBeNull();
    // OverlayHost always mounts its BasePanelHost (aea1a294d), so the probe renders with a null feature; what must
    // never happen on these screens is a host receiving any feature (night 2026-10-06: the bare not-called pin was red).
    expect(calls.legacy).not.toHaveBeenCalled(); expect(calls.panel.mock.calls.filter(([feature]) => feature !== null)).toEqual([]);
    expect(useApp.getState().basePanel).toBeNull(); expect(node.textContent).not.toContain('Existing directory vehicle screen');
    expect(node.textContent).not.toContain('ADVANCED VEHICLES');
  });
});
