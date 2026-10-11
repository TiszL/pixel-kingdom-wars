import { useApp } from '../../state/store';

export const H1_BUILDING_TYPES: ReadonlySet<string> = new Set(['lodge', 'berth', 'harvester', 'workshop']);

// `state` is annotated (same spelling as H1BuildingIntake.ts) because store.ts keeps AppState private and
// declaration emit cannot name an inferred unexported type (TS4076).
/** Only the selected, authenticated base's existing server record supplies INFO. */
export function readH1Building(buildingId: string | undefined, state: ReturnType<typeof useApp.getState> = useApp.getState()) {
  const base = state.base;
  if (!buildingId || !state.authed || !state.wallet || state.screen !== 'base'
    || state.placing !== null || !state.selectedBaseId || base?.baseId !== state.selectedBaseId
    || base.player.wallet !== state.wallet || state.selectedBuildingId !== buildingId) return null;
  const building = base.buildings.find(value => value.id === buildingId);
  if (!building || !Number.isSafeInteger(building.level) || building.level <= 0) return null;
  return { base, building, job: base.jobs.find(value => value.buildingId === buildingId) ?? null };
}
