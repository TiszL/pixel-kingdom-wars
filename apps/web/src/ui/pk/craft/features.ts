import { useApp } from '../../../state/store';
import type { BaseFeatureDefinition } from '../featureRegistry';

// Hook authority-accessor scope is pending: never substitute a rendered flag for
// the host's live original-controller predicate. Recovery remains read-only.
export const craftFeatures: readonly BaseFeatureDefinition[] = [{
  id: 'craft.workshop', kind: 'craft', label: 'Workshop', size: 'TALL', readOnly: false, dismissal: 'controller',
  canMutate: () => false,
  // Recovery is an authenticated read, including when there is no selected base.
  // The original hooks verify identity and scope for each journal/receipt action.
  canRecover: () => !!useApp.getState().wallet && useApp.getState().authed,
  load: () => import('./WorkshopPanel'),
}];
