import type { MapFeatureId } from '../Overlay';
import { withPhaseEWebHold } from './webHold';
import { lazy, Suspense } from 'react';
import { PhaseEActionDock, PhaseEActionGroup } from './PhaseEActionDock';
import { useApp, type Screen } from '../../state/store';
import { hasBuildingActivityAccess } from '../../lib/phaseEActivity/access';

const OrdinaryCraftingScreen = lazy(() => import('./OrdinaryCraftingScreen').then(m => ({ default: m.OrdinaryCraftingScreen })));
const OrdinaryCraftingDoor = lazy(() => import('./OrdinaryCraftingDoor').then(m => ({ default: m.OrdinaryCraftingDoor })));
const StarterFleetScreen = lazy(() => import('./StarterFleetScreen').then(m => ({ default: m.StarterFleetScreen })));
const StarterFleetDoor = lazy(() => import('./StarterFleetDoor').then(m => ({ default: m.StarterFleetDoor })));
const StarterExpeditionScreen = lazy(() => import('./StarterExpeditionScreen').then(m => ({ default: m.StarterExpeditionScreen })));
const StarterExpeditionDoor = lazy(() => import('./StarterExpeditionDoor').then(m => ({ default: m.StarterExpeditionDoor })));
const HarvesterScreen = lazy(() => import('./HarvesterScreen').then(m => ({ default: m.HarvesterScreen })));
const HarvesterDoor = lazy(() => import('./HarvesterDoor').then(m => ({ default: m.HarvesterDoor })));

const FreeBasePurchaseScreen = lazy(() => import('./FreeBasePurchaseScreen').then(m => ({ default: m.FreeBasePurchaseScreen })));
const FreeBasePurchaseDoor = lazy(() => import('./FreeBasePurchaseDoor').then(m => ({ default: m.FreeBasePurchaseDoor })));
const SeekerResourceClaimsEntry = lazy(() => import('./SeekerResourceClaimsEntry').then(m => ({ default: m.SeekerResourceClaimsEntry })));
const SeekerShardsClaimsEntry = lazy(() => import('./SeekerShardsClaimsEntry').then(m => ({ default: m.SeekerShardsClaimsEntry })));
const CharterEntry = lazy(() => import('./CharterEntry').then(m => ({ default: m.CharterEntry })));
const KeepEquipmentMarketEntry = lazy(() => import('./KeepEquipmentMarketEntry').then(m => ({ default: m.KeepEquipmentMarketEntry })));
const RouteCompassEntry = lazy(() => import('./RouteCompassEntry').then(m => ({ default: m.RouteCompassEntry })));
const VehicleEntry = lazy(() => import('./VehicleEntry').then(m => ({ default: m.VehicleEntry })));
const DivineTrialEntry = lazy(() => import('./DivineTrialEntry').then(m => ({ default: m.DivineTrialEntry })));
const DivineFragmentsEntry = lazy(() => import('./DivineFragmentsEntry').then(m => ({ default: m.DivineFragmentsEntry })));
const CharterTournamentEntry = lazy(() => import('./CharterTournamentEntry').then(m => ({ default: m.CharterTournamentEntry })));
const RealmSalesEntry = lazy(() => import('./RealmSalesEntry').then(m => ({ default: m.RealmSalesEntry })));
const PaidStarterExpeditionEntry = lazy(() => import('./PaidStarterExpeditionEntry').then(m => ({ default: m.PaidStarterExpeditionEntry })));
const MiningContributionEntry = lazy(() => import('./MiningContributionEntry').then(m => ({ default: m.MiningContributionEntry })));
const MiningClaimsEntry = lazy(() => import('./MiningClaimsEntry').then(m => ({ default: m.MiningClaimsEntry })));
const MiningTaxClaimsEntry = lazy(() => import('./MiningTaxClaimsEntry').then(m => ({ default: m.MiningTaxClaimsEntry })));
const RealmPassportEntry = lazy(() => import('./RealmPassportEntry').then(m => ({ default: m.RealmPassportEntry })));

// Server snapshots gate new actions; saved receipts stay reachable during pause.
// Keep each feature lazy so this registration never imports its controller eagerly.
function PhaseERegistrationEnabled({ screen, inBase, authed, actionsEnabled, onOpenMapFeature }: {
  screen: Screen; inBase: boolean; authed: boolean; actionsEnabled: boolean;
  onOpenMapFeature?: (featureId: MapFeatureId) => void;
}): React.JSX.Element {
  // Subscribe to current base identity/artifact; access itself is ephemeral.
  useApp(s => s.base); useApp(s => s.baseSelectionEpoch); useApp(s => s.authed);
  return <Suspense fallback={null}>
    {authed && (inBase || screen === 'bases') && <PhaseEActionDock>
      <PhaseEActionGroup group="kingdom">
        <FreeBasePurchaseDoor discover />
        <KeepEquipmentMarketEntry actionsEnabled={actionsEnabled} />
        <MiningContributionEntry actionsEnabled={actionsEnabled} />
        <MiningClaimsEntry actionsEnabled={actionsEnabled} />
        <RealmPassportEntry />
        {inBase && <><OrdinaryCraftingDoor /><HarvesterDoor /></>}
      </PhaseEActionGroup>
      <PhaseEActionGroup group="fleet">
        <VehicleEntry actionsEnabled={actionsEnabled} />
        {inBase && <><StarterFleetDoor /><StarterExpeditionDoor /></>}
        <PaidStarterExpeditionEntry actionsEnabled={actionsEnabled} />
        <RouteCompassEntry actionsEnabled={actionsEnabled} />
        <RealmSalesEntry actionsEnabled={actionsEnabled} />
      </PhaseEActionGroup>
      <PhaseEActionGroup group="clan">
        <CharterEntry actionsEnabled={actionsEnabled} />
        <CharterTournamentEntry actionsEnabled={actionsEnabled} />
      </PhaseEActionGroup>
      <PhaseEActionGroup group="islands">
        {/* 188719c1: original Trial battle/replay requires the kingdom screen. */}
        <DivineTrialEntry actionsEnabled={actionsEnabled} />
        <DivineFragmentsEntry actionsEnabled={actionsEnabled} onOpen={onOpenMapFeature ? () => onOpenMapFeature('map.divineFragments') : undefined} />
        <MiningTaxClaimsEntry actionsEnabled={actionsEnabled} />
        <SeekerResourceClaimsEntry actionsEnabled={actionsEnabled} />
        <SeekerShardsClaimsEntry actionsEnabled={actionsEnabled} />
      </PhaseEActionGroup>
    </PhaseEActionDock>}
    {screen === 'free-base-purchase' && <FreeBasePurchaseScreen actionsEnabled={actionsEnabled} />}
    {screen === 'ordinary-crafting' && <OrdinaryCraftingScreen actionsEnabled={actionsEnabled && hasBuildingActivityAccess('ordinary-crafting')} historyOnly={!hasBuildingActivityAccess('ordinary-crafting')} />}
    {screen === 'starter-fleet' && <StarterFleetScreen actionsEnabled={actionsEnabled && hasBuildingActivityAccess('starter-fleet')} historyOnly={!hasBuildingActivityAccess('starter-fleet')} />}
    {screen === 'starter-expeditions' && <StarterExpeditionScreen actionsEnabled={actionsEnabled && hasBuildingActivityAccess('starter-expeditions')} historyOnly={!hasBuildingActivityAccess('starter-expeditions')} />}
    {screen === 'harvesters' && <HarvesterScreen actionsEnabled={actionsEnabled && hasBuildingActivityAccess('harvesters')} historyOnly={!hasBuildingActivityAccess('harvesters')} />}
  </Suspense>;
}

function PhaseEBuildingDoorEnabled({ buildingType }: { buildingType: string }): React.JSX.Element {
  const buildingId = useApp(s => s.selectedBuildingId) ?? undefined;
  // exactOptionalPropertyTypes: the optional prop is passed only when a building is selected.
  const door: { buildingId?: string } = buildingId === undefined ? {} : { buildingId };
  return <Suspense fallback={null}>
    {buildingType === 'goldforge' && <MiningContributionEntry />}
    {buildingType === 'market' && <KeepEquipmentMarketEntry actionsEnabled {...door} />}
    {buildingType === 'workshop' && <OrdinaryCraftingDoor discover {...door} />}
    {buildingType === 'berth' && <StarterFleetDoor discover {...door} />}
    {buildingType === 'lodge' && <StarterExpeditionDoor discover {...door} />}
    {buildingType === 'harvester' && <HarvesterDoor discover {...door} />}
  </Suspense>;
}

// The build hold prevents controller hooks and recovery discovery from mounting.
export const PhaseERegistration = withPhaseEWebHold(PhaseERegistrationEnabled);
export const PhaseEBuildingDoor = withPhaseEWebHold(PhaseEBuildingDoorEnabled);
