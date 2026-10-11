/** @vitest-environment happy-dom */
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';
vi.mock('../../state/store', async original => {
  const module = await original<typeof import('../../state/store')>();
  return { ...module, useApp: Object.assign(vi.fn(module.useApp), module.useApp) };
});
// A child's own hold cannot mask a missing outer door boundary in this suite.
vi.mock('./PhaseEActionDock', () => ({
  PhaseEEntryButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  PhaseEActionDock: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PhaseEActionGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { PhaseERegistration, PhaseEBuildingDoor } from './PhaseERegistration';
import { WorkshopDoor } from '../WorkshopDoor';
import { CharterEntry } from './CharterEntry';
import { CharterTournamentEntry } from './CharterTournamentEntry';
import { DivineFragmentsEntry } from './DivineFragmentsEntry';
import { DivineTrialEntry } from './DivineTrialEntry';
import { FreeBasePurchaseDoor } from './FreeBasePurchaseDoor';
import { HarvesterDoor } from './HarvesterDoor';
import { KeepEquipmentMarketEntry } from './KeepEquipmentMarketEntry';
import { MiningClaimsEntry } from './MiningClaimsEntry';
import { MiningContributionEntry } from './MiningContributionEntry';
import { MiningTaxClaimsEntry } from './MiningTaxClaimsEntry';
import { OrdinaryCraftingDoor } from './OrdinaryCraftingDoor';
import { PaidStarterExpeditionEntry } from './PaidStarterExpeditionEntry';
import { RealmPassportEntry } from './RealmPassportEntry';
import { RealmSalesEntry } from './RealmSalesEntry';
import { RouteCompassEntry } from './RouteCompassEntry';
import { SeekerResourceClaimsEntry } from './SeekerResourceClaimsEntry';
import { SeekerShardsClaimsEntry } from './SeekerShardsClaimsEntry';
import { StarterExpeditionDoor } from './StarterExpeditionDoor';
import { StarterFleetDoor } from './StarterFleetDoor';
import { VehicleEntry } from './VehicleEntry';

let root: Root, host: HTMLDivElement, database: IDBFactory;
let prior: ReturnType<typeof useApp.getState>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  database = new IDBFactory(); vi.stubGlobal('indexedDB', database); vi.spyOn(database, 'open');
  // The enabled sentinel reaches the real Workshop identity validator.
  prior = useApp.getState(); useApp.setState({ authed: true, wallet: '11111111111111111111111111111111', selectedBaseId: 'base-a', basePanel: null });
  vi.mocked(useApp).mockClear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useApp.setState(prior, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const heldEntries: Array<[string, () => ReactNode]> = [
  ['registration', () => <PhaseERegistration screen="base" inBase authed actionsEnabled />],
  ['direct history route', () => <PhaseERegistration screen="harvesters" inBase={false} authed actionsEnabled />],
  ['building entry', () => <PhaseEBuildingDoor buildingType="market" />],
  ['WorkshopDoor', () => <WorkshopDoor discover />],
  ['CharterEntry', () => <CharterEntry actionsEnabled />],
  ['CharterTournamentEntry', () => <CharterTournamentEntry actionsEnabled />],
  ['DivineFragmentsEntry', () => <DivineFragmentsEntry actionsEnabled />],
  ['DivineTrialEntry', () => <DivineTrialEntry actionsEnabled />],
  ['FreeBasePurchaseDoor', () => <FreeBasePurchaseDoor discover />],
  ['HarvesterDoor', () => <HarvesterDoor discover />],
  ['KeepEquipmentMarketEntry', () => <KeepEquipmentMarketEntry actionsEnabled />],
  ['MiningClaimsEntry', () => <MiningClaimsEntry actionsEnabled />],
  ['MiningContributionEntry', () => <MiningContributionEntry actionsEnabled />],
  ['MiningTaxClaimsEntry', () => <MiningTaxClaimsEntry actionsEnabled />],
  ['OrdinaryCraftingDoor', () => <OrdinaryCraftingDoor discover />],
  ['PaidStarterExpeditionEntry', () => <PaidStarterExpeditionEntry actionsEnabled />],
  ['RealmPassportEntry', () => <RealmPassportEntry />],
  ['RealmSalesEntry', () => <RealmSalesEntry actionsEnabled />],
  ['RouteCompassEntry', () => <RouteCompassEntry actionsEnabled />],
  ['SeekerResourceClaimsEntry', () => <SeekerResourceClaimsEntry actionsEnabled />],
  ['SeekerShardsClaimsEntry', () => <SeekerShardsClaimsEntry actionsEnabled />],
  ['StarterExpeditionDoor', () => <StarterExpeditionDoor discover />],
  ['StarterFleetDoor', () => <StarterFleetDoor discover />],
  ['VehicleEntry', () => <VehicleEntry actionsEnabled />],
];
it.each(heldEntries)('does not invoke %s inner hooks even when its child button passes through', async (_name, view) => {
  const settled = vi.fn();
  function Probe() { useEffect(() => { settled(); }, []); return null; }
  await act(async () => root.render(<>{view()}<Probe /></>));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(useApp).not.toHaveBeenCalled(); expect(database.open).not.toHaveBeenCalled();
  expect(host.childElementCount).toBe(0);
});
it('proves the direct Workshop discovery sentinel runs when explicitly enabled', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1');
  await act(async () => root.render(<WorkshopDoor />));
  await act(async () => vi.waitFor(() => expect(database.open).toHaveBeenCalled()));
  expect(useApp).toHaveBeenCalled();
});
