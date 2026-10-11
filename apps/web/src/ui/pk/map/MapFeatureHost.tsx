import { Component, Suspense, lazy, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../../../state/store';
import type { MapFeatureDestination } from '../../Overlay';
import { phaseEWebEnabled } from '../../phaseE/webHold';

/** Producer-owned, generation-captured destination; no second registry or controller. */
export interface MapFeatureHostProps {
  destination?: MapFeatureDestination | null | undefined;
  onClose?: (() => void) | undefined;
  actionsEnabled: boolean;
}

const DivineFragmentsScreen = lazy(() => import('../../phaseE/DivineFragmentsScreen')
  .then(module => ({ default: module.DivineFragmentsScreen })));

function current(destination: MapFeatureDestination): boolean {
  const state = useApp.getState();
  // 188719c1: Trial battles cannot originate on map; its original entry stays in place.
  return destination.featureId === 'map.divineFragments' && phaseEWebEnabled() && state.authed && state.wallet === destination.wallet
    && state.selectedBaseId === destination.baseId && state.baseSelectionEpoch === destination.epoch
    && state.screen === 'map' && state.mapTab === 'world';
}

class FeatureBoundary extends Component<{ onFailure: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(): void { this.props.onFailure(); }
  render(): ReactNode { return this.state.failed ? null : this.props.children; }
}

function DestinationOwner({ destination, onClose, actionsEnabled }: {
  destination: MapFeatureDestination; onClose: () => void; actionsEnabled: boolean;
}): React.JSX.Element | null {
  // The key owns this lifetime, not the producer's freshly rendered onClose arrow.
  const [owner] = useState(() => ({ retired: false, mounted: false, failed: false }));
  const [, redraw] = useState(0);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  const close = useCallback(() => {
    if (!owner.mounted || owner.retired) return;
    owner.retired = true;
    redraw(value => value + 1);
    closeRef.current();
  }, [owner]);

  const fail = useCallback(() => {
    // A cached screen can throw on its first commit before our layout effect.
    owner.failed = true;
    close();
  }, [owner, close]);

  useLayoutEffect(() => {
    owner.mounted = true;
    // Subscribe before checking the current state. Retirement is synchronous even
    // when React batches scope A -> B -> A into one final render.
    const check = () => { if (owner.failed || !current(destination)) close(); };
    const unsubscribe = useApp.subscribe(check);
    check();
    return () => { owner.mounted = false; unsubscribe(); };
    // Destination values are immutable for this keyed lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, close]);
  useLayoutEffect(() => { if (owner.failed || !current(destination)) close(); });

  if (owner.retired || !current(destination)) return null;
  return <FeatureBoundary onFailure={fail}><Suspense fallback={null}>
    <DivineFragmentsScreen actionsEnabled={actionsEnabled} onClose={close} />
  </Suspense></FeatureBoundary>;
}

/** Original screens already own EconomyPanel/ModalWrap, focus and mobile Back.
 * Keep this owner beside the world, and remove it immediately on retirement. */
export function MapFeatureHost({ destination, onClose, actionsEnabled }: MapFeatureHostProps): React.JSX.Element | null {
  if (!destination || !onClose) return null;
  const key = JSON.stringify([destination.generation, destination.featureId, destination.wallet, destination.baseId, destination.epoch]);
  return <DestinationOwner key={key} destination={destination} onClose={onClose} actionsEnabled={actionsEnabled} />;
}
