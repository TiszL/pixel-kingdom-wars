/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp, type BaseStateDto } from '../../state/store';
import { createPanelSession, type PanelDismissRequest } from './panelSession';
import { hasBuildingActivityAccess } from '../../lib/phaseEActivity/access';
import { WorkshopDoor } from '../WorkshopDoor';
import { FreeBasePurchaseDoor } from '../phaseE/FreeBasePurchaseDoor';
import { OrdinaryCraftingDoor } from '../phaseE/OrdinaryCraftingDoor';
import { HarvesterDoor } from '../phaseE/HarvesterDoor';
import { StarterFleetDoor } from '../phaseE/StarterFleetDoor';
import { StarterExpeditionDoor } from '../phaseE/StarterExpeditionDoor';
import { KeepEquipmentMarketEntry } from '../phaseE/KeepEquipmentMarketEntry';

const fixtures = vi.hoisted(() => ({ journal: class {
  async read() { return { operation: {}, archives: [] }; }
  async close() { /* fixture has no resources */ }
} }));
vi.mock('../../lib/workshop/browser', () => ({ workshopIdentity: (wallet: string) => ({ wallet }), createWorkshopBrowserPorts: () => ({}) }));
vi.mock('../../lib/workshop/snapshot', () => ({ refreshWorkshopSnapshot: async () => null }));
vi.mock('../../lib/freeBasePurchase/browser', () => ({ freeBasePurchaseIdentity: (wallet: string) => ({ wallet }), createFreeBasePurchaseBrowserPorts: () => ({}) }));
vi.mock('../../lib/ordinaryCrafting/browser', () => ({ ordinaryCraftingIdentity: (wallet: string) => ({ wallet }), createOrdinaryCraftingBrowserPorts: () => ({}) }));
vi.mock('../../lib/ordinaryCrafting/snapshot', () => ({ refreshOrdinaryCraftingSnapshot: async () => null }));
vi.mock('../../lib/harvester/browser', () => ({ harvesterIdentity: (wallet: string) => ({ wallet }), createHarvesterBrowserPorts: () => ({}) }));
vi.mock('../../lib/harvester/snapshot', () => ({ refreshHarvesterSnapshot: async () => null }));
vi.mock('../../lib/starterFleet/browser', () => ({ starterFleetIdentity: (wallet: string) => ({ wallet }), createStarterFleetBrowserPorts: () => ({}) }));
vi.mock('../../lib/starterFleet/snapshot', () => ({ refreshStarterFleetSnapshot: async () => null }));
vi.mock('../../lib/starterExpedition/browser', () => ({ starterExpeditionIdentity: (wallet: string) => ({ wallet }), createStarterExpeditionBrowserPorts: () => ({}) }));
vi.mock('../../lib/starterExpedition/snapshot', () => ({ refreshStarterExpeditionSnapshot: async () => null }));
vi.mock('../../lib/boundCosmetics/workshopBrowser', () => ({ createWorkshopBrowserPorts: () => { throw new Error('external I/O excluded from door fixture'); } }));
vi.mock('../../lib/workshop/journal', () => ({ WorkshopJournalStore: fixtures.journal }));
vi.mock('../../lib/freeBasePurchase/journal', () => ({ FreeBasePurchaseJournalStore: fixtures.journal }));
vi.mock('../../lib/ordinaryCrafting/journal', () => ({ OrdinaryCraftingJournalStore: fixtures.journal }));
vi.mock('../../lib/boundCosmetics/workshopJournal', () => ({ WorkshopJournalStore: fixtures.journal }));
vi.mock('../../lib/harvester/journal', () => ({ HarvesterJournalStore: fixtures.journal }));
vi.mock('../../lib/starterFleet/journal', () => ({ StarterFleetJournalStore: fixtures.journal }));
vi.mock('../../lib/starterExpedition/journal', () => ({ StarterExpeditionJournalStore: fixtures.journal }));
vi.mock('../../lib/api', async original => ({ ...await original<typeof import('../../lib/api')>(), api: { get: vi.fn().mockRejectedValue(new Error('no network fixture')), post: vi.fn() } }));
vi.mock('../phaseE/KeepEquipmentMarketScreen', () => ({ KeepEquipmentMarketScreen: ({ onClose }: { onClose: () => void }) => <div>Market controller mounted<button onClick={onClose}>CLOSE MARKET</button></div> }));
let root: ReturnType<typeof createRoot>; let host: HTMLDivElement;
let prior: ReturnType<typeof useApp.getState>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); prior = useApp.getState();
  useApp.setState({ authed: true, wallet: 'wallet-a', selectedBaseId: 'base-a', screen: 'base', basePanel: null, selectedBuildingId: 'building-a', base: { baseId: 'base-a', buildings: [{ id: 'building-a', type: 'harvester', level: 1, underConstruction: false }] } as BaseStateDto });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState(prior, true); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function hold() {
  const panel = { kind: 'hub' as const, featureId: 'draft' }; useApp.setState({ basePanel: panel });
  const pending: PanelDismissRequest[] = []; const session = createPanelSession({ panel, controlled: true, isCurrent: () => useApp.getState().basePanel === panel, canMutate: () => false, canRecover: () => false });
  const off = session.mount(); session.setDismissPolicy(request => pending.push(request)); return { panel, pending, off };
}
it.each(['workshop', 'free-base-purchase'] as const)('authenticated %s door requests one policy before routing', async screen => {
  await act(async () => root.render(screen === 'workshop' ? <WorkshopDoor /> : <FreeBasePurchaseDoor />)); const h = hold();
  try {
    const button = host.querySelector('button')!; expect(button).not.toBeNull(); act(() => button.click());
    expect(h.pending).toHaveLength(1); expect(h.pending[0]?.reason).toBe('navigate');
    expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().basePanel).toBe(h.panel);
    act(() => { expect(h.pending[0]?.proceed()).toBe(true); });
    expect(useApp.getState().screen).toBe(screen); expect(h.pending[0]?.proceed()).toBe(false);
  } finally { h.off(); }
});
it.each(['wallet', 'unmount'] as const)('authenticated Workshop retained route refuses after %s', async change => {
  await act(async () => root.render(<WorkshopDoor />)); const h = hold();
  try {
    act(() => host.querySelector('button')!.click()); expect(h.pending).toHaveLength(1);
    act(() => { if (change === 'wallet') useApp.setState({ wallet: 'wallet-b' }); else root.render(null); });
    expect(h.pending[0]?.proceed()).toBe(false); expect(useApp.getState().screen).toBe('base');
  } finally { h.off(); }
});
const activities = [
  { activity: 'ordinary-crafting' as const, type: 'workshop', Component: OrdinaryCraftingDoor },
  { activity: 'harvesters' as const, type: 'harvester', Component: HarvesterDoor },
  { activity: 'starter-fleet' as const, type: 'berth', Component: StarterFleetDoor },
  { activity: 'starter-expeditions' as const, type: 'lodge', Component: StarterExpeditionDoor },
];
it.each(activities)('authenticated $activity building door retains route and access together', async ({ activity, type, Component }) => {
  useApp.setState({ base: { baseId: 'base-a', buildings: [{ id: 'building-a', type, level: 1, underConstruction: false }] } as BaseStateDto });
  await act(async () => root.render(<Component discover buildingId="building-a" />)); const h = hold();
  try {
    const button = host.querySelector('button')!; expect(button).not.toBeNull(); act(() => button.click());
    expect(h.pending).toHaveLength(1); expect(h.pending[0]?.reason).toBe('navigate');
    expect(useApp.getState().screen).toBe('base'); expect(hasBuildingActivityAccess(activity)).toBe(false);
    act(() => { expect(h.pending[0]?.proceed()).toBe(true); });
    expect(useApp.getState().screen).toBe(activity); expect(hasBuildingActivityAccess(activity)).toBe(true);
    expect(h.pending[0]?.proceed()).toBe(false);
  } finally { h.off(); }
});
it('authenticated KEEP MARKET retains its access grant and local modal as one command', async () => {
  useApp.setState({ base: { baseId: 'base-a', buildings: [{ id: 'building-a', type: 'market', level: 1, underConstruction: false }] } as BaseStateDto });
  await act(async () => root.render(<KeepEquipmentMarketEntry actionsEnabled buildingId="building-a" />)); const h = hold();
  try {
    act(() => host.querySelector('button')!.click()); expect(h.pending).toHaveLength(1);
    expect(hasBuildingActivityAccess('market')).toBe(false); expect(host.textContent).not.toContain('Market controller mounted');
    await act(async () => { expect(h.pending[0]?.proceed()).toBe(true); });
    expect(hasBuildingActivityAccess('market')).toBe(true); expect(host.textContent).toContain('Market controller mounted');
    expect(h.pending[0]?.proceed()).toBe(false);
  } finally { h.off(); }
});

it('closes KEEP MARKET and revokes its grant without asking a held panel policy', async () => {
  // A dismissal must never be vetoable by a draft policy after the screen has dismissed itself.
  useApp.setState({ base: { baseId: 'base-a', buildings: [{ id: 'building-a', type: 'market', level: 1, underConstruction: false }] } as BaseStateDto });
  await act(async () => root.render(<KeepEquipmentMarketEntry actionsEnabled buildingId="building-a" />));
  const h = hold();
  try {
    act(() => host.querySelector('button')!.click()); expect(h.pending).toHaveLength(1);
    await act(async () => { expect(h.pending[0]?.proceed()).toBe(true); });
    expect(hasBuildingActivityAccess('market')).toBe(true);
    expect(host.textContent).toContain('Market controller mounted');
    const close = [...host.querySelectorAll('button')].find(b => b.textContent === 'CLOSE MARKET')!;
    expect(close).toBeDefined(); act(() => close.click());
    expect(host.textContent).not.toContain('Market controller mounted');
    expect(hasBuildingActivityAccess('market')).toBe(false);
    expect(h.pending).toHaveLength(1);
  } finally { h.off(); }
});
