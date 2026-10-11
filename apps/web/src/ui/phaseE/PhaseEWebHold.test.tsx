/** @vitest-environment happy-dom */
import { BUILD_COSTS, UPGRADE_COSTS, PHASE_E_BUILDINGS } from '@shardkeep/shared';
import { phaseEBuildingHeld } from '../phaseEWebHold';
import { act, useEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { phaseEWebEnabled, withPhaseEWebHold } from './webHold';
import { PhaseERegistration, PhaseEBuildingDoor } from './PhaseERegistration';
import { PhaseEActionDock, PhaseEEntryButton } from './PhaseEActionDock';
import { PhaseEBattleHost } from './PhaseEBattleHost';
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

let host: HTMLDivElement, root: Root;
let prior: ReturnType<typeof useApp.getState>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  prior = useApp.getState();
  useApp.setState({ authed: true, wallet: 'hold-wallet', selectedBaseId: 'hold-base', screen: 'base', basePanel: null });
  vi.spyOn(api, 'get').mockRejectedValue(new Error('no network in hold test'));
  vi.spyOn(api, 'getPrivate').mockRejectedValue(new Error('no network in hold test'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); useApp.setState(prior, true);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
it.each([undefined, '', '0', 'false', 'true', ' 1 ', 'yes'])('fails closed for an absent or non-opt-in web flag: %s', value => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', value);
  expect(phaseEWebEnabled()).toBe(false);
});
it('admits only the explicit build opt-in, independently of server flags', () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); expect(phaseEWebEnabled()).toBe(true);
});
it('does not mount a held child or start its effects even when its server action is enabled', async () => {
  // Android may use enabled server flags before web parity; no web controller may start from that alone.
  const mounted = vi.fn();
  const Held = withPhaseEWebHold(({ actionsEnabled }: { actionsEnabled: boolean }) => {
    useEffect(mounted, []); return <button disabled={!actionsEnabled}>PHASE E</button>;
  });
  await act(async () => root.render(<Held actionsEnabled />));
  expect(host.childElementCount).toBe(0); expect(mounted).not.toHaveBeenCalled();
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1');
  await act(async () => root.render(<Held actionsEnabled={false} />));
  expect(host.querySelector('button')?.disabled).toBe(true); expect(mounted).toHaveBeenCalledTimes(1);
});
const heldEntries: Array<[string, () => ReactNode]> = [
  ['registration', () => <PhaseERegistration screen="base" inBase authed actionsEnabled />],
  ['direct history route', () => <PhaseERegistration screen="harvesters" inBase={false} authed actionsEnabled />],
  ['building entry', () => <PhaseEBuildingDoor buildingType="market" />],
  ['dock and child', () => <PhaseEActionDock><button>SERVER ENABLED</button></PhaseEActionDock>],
  ['standalone entry button', () => <PhaseEEntryButton>SERVER ENABLED</PhaseEEntryButton>],
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
it.each(heldEntries)('hides %s before controller discovery despite authenticated/enabled input', async (_name, view) => {
  await act(async () => root.render(view()));
  expect(host.childElementCount).toBe(0);
  expect(api.get).not.toHaveBeenCalled(); expect(api.getPrivate).not.toHaveBeenCalled();
});
it('keeps the ordinary raid surface working while the Phase E battle host is held', async () => {
  await act(async () => root.render(<PhaseEBattleHost actionsEnabled ordinary={<div>ORDINARY RAID</div>} />));
  expect(host.textContent).toBe('ORDINARY RAID'); expect(api.get).not.toHaveBeenCalled();
});

it('holds exactly the shared Phase E building catalogue while the web switch is off', () => {
  const catalogue = [...new Set([...Object.keys(BUILD_COSTS), ...Object.keys(UPGRADE_COSTS)])];
  expect(catalogue.filter(phaseEBuildingHeld).sort()).toEqual([...PHASE_E_BUILDINGS.types].sort());
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); expect(catalogue.filter(phaseEBuildingHeld)).toEqual([]);
});
