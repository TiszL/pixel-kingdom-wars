import type { BaseFeatureDefinition } from '../featureRegistry';

// Unregistered definition only. Equality to the shared source is pinned in tests
// so this module has no runtime lib import; the facts/action binder stays lazy.
export const buildingFeatures: readonly BaseFeatureDefinition[] = [{
  id: 'buildings.info',
  kind: 'info',
  label: 'Building',
  size: 'HALF',
  readOnly: false,
  dismissal: 'allow',
  // No live mutation or recovery authority is supplied by this presentation.
  load: () => import('./BuildingInfoPanel'),
}];
