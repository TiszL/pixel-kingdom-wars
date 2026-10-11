import { BUILDINGS_INFO_SOURCE } from '../../../lib/phaseEActivity/panelIds';
import { PkSecondaryButton } from '../Button';
import type { BaseFeatureProps } from '../featureRegistry';
import type { PanelAction } from '../panelSession';
import BuildingInfoSheet, { type BuildingInfoActions } from './BuildingInfoSheet';
import { buildingSnapshot, type BuildingSnapshotArt, type BuildingSnapshotFacts } from './buildingSnapshot';

export interface BuildingInfoPanelInput {
  /** Current facts and callbacks remain owned by the original live reader. */
  facts: BuildingSnapshotFacts;
  renderArt: BuildingSnapshotArt;
  actions: Omit<BuildingInfoActions, 'onClose'>;
}

export interface BuildingInfoPanelProps extends BaseFeatureProps {
  /** Missing until the host owner supplies its reviewed binding; no local reader. */
  input?: BuildingInfoPanelInput | null;
  /** Navigation callback only. The host owner supplies the existing crafting door. */
  onCraft?: () => void;
}

/** Supplied-facts INFO body. No store, controller, transport or grant producer. */
export default function BuildingInfoPanel({
  panel, session, onClose, actionsEnabled, input, onCraft,
}: BuildingInfoPanelProps): React.JSX.Element | null {
  if (!input || panel.kind !== BUILDINGS_INFO_SOURCE.kind
    || panel.featureId !== BUILDINGS_INFO_SOURCE.featureId
    || panel.buildingId == null || panel.buildingId !== input.facts.buildingId) return null;

  const { facts, renderArt, actions } = input;
  const enabled = actionsEnabled === true && facts.enabled === true && !facts.readOnly && !facts.busy;
  const ui = buildingSnapshot({ ...facts, enabled, readOnly: facts.readOnly || actionsEnabled !== true }, renderArt);
  const read = (action: (() => void) | undefined): void => {
    if (action) session.dispatch('read', action);
  };
  const gated = (kind: PanelAction, action: (() => void) | undefined): void => {
    if (enabled && action) session.dispatch(kind, action);
  };
  const on: BuildingInfoActions = {
    onClose,
    onUpgrade: () => gated('read', actions.onUpgrade),
    // These original callbacks may reach free finish or job cancellation.
    // The host must admit mutation using the original owner's live predicate.
    onFinish: () => gated('mutate', actions.onFinish),
    onGetMore: currency => gated('read', () => actions.onGetMore(currency)),
    onExtra: () => gated('mutate', actions.onExtra),
    onAllLevels: () => read(actions.onAllLevels),
    onRetry: () => read(actions.onRetry),
    onExplain: reason => read(actions.onExplain ? () => actions.onExplain?.(reason) : undefined),
  };
  const craft = enabled && onCraft && facts.type === 'workshop'
    && Number.isSafeInteger(facts.level) && facts.level > 0 && facts.job == null && facts.repair == null;

  return <>
    <BuildingInfoSheet ui={enabled ? ui : { ...ui, extra: null }} on={on} />
    {craft ? <PkSecondaryButton label="WORKSHOP" onClick={() => gated('read', onCraft)} /> : null}
  </>;
}
