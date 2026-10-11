import { phaseEWebEnabled } from '../phaseEWebHold';
import { createBaseFeatureRegistry, type BaseFeature, type BaseFeatureRegistry } from './featureRegistry';
import { vehicleRecoveryFeature } from './voyage/vehicleRecoveryFeature';

export const VEHICLE_RECOVERY_PANEL = Object.freeze({
  kind: vehicleRecoveryFeature.kind, featureId: vehicleRecoveryFeature.id,
});
let recovery: BaseFeatureRegistry | null = null;
const composites = new WeakMap<BaseFeatureRegistry, BaseFeatureRegistry>();
const heldRegistries = new WeakMap<BaseFeatureRegistry, BaseFeatureRegistry>();

/** Called only by the lazy base host. The current web hold gates registration;
 * the accepted recovery body replaces, never accompanies, a same-id Vehicle body. */
export function getVehicleRecoveryRegistry(base: BaseFeatureRegistry): BaseFeatureRegistry {
  if (!phaseEWebEnabled()) {
    if (!Object.hasOwn(base, vehicleRecoveryFeature.id)) return base;
    let held = heldRegistries.get(base);
    if (!held) {
      held = Object.freeze(Object.fromEntries(Object.entries(base).filter(([id]) => id !== vehicleRecoveryFeature.id)));
      heldRegistries.set(base, held);
    }
    return held;
  }
  let composite = composites.get(base);
  if (!composite) {
    recovery ??= createBaseFeatureRegistry([vehicleRecoveryFeature]);
    composite = Object.freeze(Object.assign(Object.create(null), base, recovery)) as BaseFeatureRegistry;
    composites.set(base, composite);
  }
  return composite;
}

/** Admission must see the exact host-owned recovery feature, not a same-id copy. */
export function isVehicleRecoveryFeature(feature: BaseFeature | null | undefined): boolean {
  return phaseEWebEnabled() && !!recovery && feature === recovery[vehicleRecoveryFeature.id];
}
