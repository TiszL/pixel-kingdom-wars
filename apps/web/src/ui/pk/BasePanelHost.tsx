import { Suspense, useLayoutEffect, useMemo, useRef } from 'react';
import { bus } from '../../lib/events';
import { useApp } from '../../state/store';
import { PkSheetHost } from './SheetHost';
import type { BaseFeature } from './featureRegistry';
import { createPanelSession } from './panelSession';
import type { SheetInset } from './p2Types';

const subscribeEmptyTap = (listener: () => void): (() => void) => bus.on('base:emptyTap', listener);

/** One lazy content owner inside the existing payment providers. Adapters bind
 * current controller policy; presentation artifacts receive only controlled callbacks. */
export function BasePanelHost({ baseActionsEnabled, feature: requestedFeature, onInset }: {
  baseActionsEnabled: boolean; feature: BaseFeature | null; onInset?: (inset: SheetInset | null) => void;
}): React.JSX.Element {
  const panel = useApp((state) => state.screen === 'base' ? state.basePanel : null);
  const feature = panel ? requestedFeature : null;
  const wallet = useApp((state) => state.wallet);
  const baseId = useApp((state) => state.selectedBaseId);
  const epoch = useApp((state) => state.baseSelectionEpoch);
  const capability = useRef(baseActionsEnabled);
  capability.current = baseActionsEnabled;
  const session = useMemo(() => panel && feature ? createPanelSession({
    panel, controlled: feature.dismissal === 'controller',
    isCurrent: () => {
      const current = useApp.getState();
      return current.screen === 'base' && current.basePanel === panel && current.wallet === wallet
        && current.selectedBaseId === baseId && current.baseSelectionEpoch === epoch;
    },
    // The original controller must re-read its complete current authority on
    // every invocation. A rendered flag or readOnly label is never sufficient.
    canMutate: () => capability.current && feature.canMutate?.(panel) === true,
    canRecover: () => feature.canRecover?.(panel) === true,
  }) : null, [panel, feature, wallet, baseId, epoch]);
  useLayoutEffect(() => session?.mount(), [session]);
  const close = (): void => { if (session?.isCurrent()) useApp.getState().closeBasePanel(); };
  const Component = feature?.Component;
  const key = panel ? JSON.stringify([panel.featureId, panel.buildingId, panel.obstacleId]) : '';
  return <PkSheetHost sheet={feature ? { key, label: feature.label, size: feature.size } : null}
    onClose={close} subscribeEmptyTap={subscribeEmptyTap} {...(onInset ? { onInset } : {})}>
    {panel && feature && Component && session ? <Suspense key={key} fallback={<div role="status" className="pk-body">Loading {feature.label}…</div>}>
      <Component key={key} panel={panel} session={session} onClose={close} actionsEnabled={baseActionsEnabled} />
    </Suspense> : null}
  </PkSheetHost>;
}
