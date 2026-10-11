import { phaseEWebEnabled } from '../phaseEWebHold';
import { buildingFeatures } from './buildings/features';
import { craftFeatures } from './craft/features';
import { BASE_FEATURES, createBaseFeatureRegistry, type BaseFeature, type BaseFeatureRegistry } from './featureRegistry';

// Definition files remain literal metadata. The facts/actions owner is loaded
// only when the admitted INFO panel is rendered, behind the existing lazy host.
const h1 = createBaseFeatureRegistry([
  ...craftFeatures,
  ...buildingFeatures.map(definition => ({ ...definition, load: () => import('./H1BuildingInfoBinding') })),
]);
const composed = new WeakMap<BaseFeatureRegistry, BaseFeatureRegistry>();
const held = new WeakMap<BaseFeatureRegistry, BaseFeatureRegistry>();

/** Stable input identity also preserves the downstream Vehicle registry cache. */
export function getH1BaseRegistry(base: BaseFeatureRegistry = BASE_FEATURES): BaseFeatureRegistry {
  const enabled = phaseEWebEnabled();
  const cache = enabled ? composed : held;
  const prior = cache.get(base);
  if (prior) return prior;
  const others = Object.entries(base).filter(([id]) => !Object.hasOwn(h1, id));
  const result = enabled ? Object.freeze({ ...Object.fromEntries(others), ...h1 })
    : others.length === Object.keys(base).length ? base : Object.freeze(Object.fromEntries(others));
  cache.set(base, result);
  return result;
}

export function isH1InfoFeature(feature: BaseFeature | null): boolean {
  return phaseEWebEnabled() && feature === h1['buildings.info'];
}
