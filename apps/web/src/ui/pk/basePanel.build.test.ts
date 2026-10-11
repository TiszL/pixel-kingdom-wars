import { afterEach, beforeEach, expect, it } from 'vitest';
import { configureBasePanels, useApp } from '../../state/store';
import type { BasePanel } from './basePanel';
import { BASE_FEATURES, createBaseFeatureRegistry, resolveBaseFeature } from './featureRegistry';

const panel: BasePanel = { kind: 'build', featureId: 'buildings.build' };
const registry = createBaseFeatureRegistry([{ id: panel.featureId, kind: 'build', label: 'Build',
  size: 'HALF', readOnly: false, canMutate: () => false, load: async () => ({ default: () => null }) }]);
let prior: ReturnType<typeof useApp.getState>;
beforeEach(() => {
  prior = useApp.getState(); configureBasePanels(registry, true);
  useApp.getState().setAuth('build-wallet'); useApp.getState().setSelectedBaseId('build-base', false);
  useApp.getState().setScreen('base');
});
afterEach(() => { useApp.setState(prior, true); configureBasePanels(BASE_FEATURES, false); });

it('admits an explicitly registered build kind over the same base without registering production BUILD', () => {
  useApp.getState().openBasePanel(panel);
  expect(useApp.getState().basePanel).toMatchObject(panel);
  expect(useApp.getState().screen).toBe('base'); expect(useApp.getState().selectedBaseId).toBe('build-base');
  expect(resolveBaseFeature(BASE_FEATURES, panel, true)).toBeNull();
});
it('keeps build admission behind existing capability and exact-kind resolution', () => {
  configureBasePanels(registry, false); useApp.getState().openBasePanel(panel);
  expect(useApp.getState().basePanel).toBeNull();
  expect(resolveBaseFeature(registry, { ...panel, kind: 'info' }, true)).toBeNull();
});
