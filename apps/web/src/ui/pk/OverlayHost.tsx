import { getH1BaseRegistry } from './h1BaseRegistry';
import { useH1BuildingIntake } from './H1BuildingIntake';
import './pk-tokens.generated.css';
import './kitBase.css';
import './bridge-amendment.css';
import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { installOverlayEscapeBridge } from '../../lib/mobileBackGuard';
import { configureBasePanels, useApp } from '../../state/store';
import { BasePanelHost } from './BasePanelHost';
import { BASE_FEATURES, resolveBaseFeature, type BaseFeatureRegistry } from './featureRegistry';
import { getVehicleRecoveryRegistry } from './vehicleRecoveryRegistry';
import type { SheetInset } from './p2Types';

/** Exactly one active sheet owner. Legacy content keeps its controller/provider
 * identity until its frozen adapter has entered the shared registry. */
export function OverlayHost({ baseActionsEnabled, onInset, children, registry = getH1BaseRegistry(BASE_FEATURES) }: {
  registry?: BaseFeatureRegistry;
  baseActionsEnabled: boolean; onInset: (inset: SheetInset | null) => void; children: ReactNode;
}): React.JSX.Element {
  const panel = useApp((state) => state.basePanel);
  const activeRegistry = getVehicleRecoveryRegistry(registry);
  // Existing drafts retain their controller through capability loss; admission
  // belongs only to openBasePanel. One resolver result feeds both render owners.
  const feature = panel && resolveBaseFeature(activeRegistry, panel, true);
  useLayoutEffect(() => configureBasePanels(activeRegistry, baseActionsEnabled), [activeRegistry, baseActionsEnabled]);
  useEffect(() => installOverlayEscapeBridge(window), []);
  useEffect(() => () => onInset(null), [onInset]);
  useH1BuildingIntake();
  return <>{!feature ? children : null}<BasePanelHost feature={feature} baseActionsEnabled={baseActionsEnabled} onInset={onInset} /></>;
}
