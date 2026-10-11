import { lazy, Suspense, useLayoutEffect, useMemo, useState } from 'react';
import { reloadBase } from '../../state/baseSnapshot';
import { useApp } from '../../state/store';
import { OrdinaryCraftingDoor } from '../phaseE/OrdinaryCraftingDoor';
import { phaseEWebEnabled } from '../phaseEWebHold';
import { Sprite } from '../primitives';
import { maxLevelFor, sheetPortrait, trayLabel } from '../sheets';
import BuildingInfoPanel, { type BuildingInfoPanelInput } from './buildings/BuildingInfoPanel';
import type { BuildingSnapshotFacts } from './buildings/buildingSnapshot';
import type { BaseFeatureProps } from './featureRegistry';
import { H1_BUILDING_TYPES, readH1Building } from './h1BuildingScope';
import type { PanelSession } from './panelSession';

const BuildingInfo = lazy(() => import('../BuildingInfo'));

/** Loaded only for an admitted INFO. This owner binds existing base facts and
 * read commands; it adds no quote reader, payment predicate, or grant producer. */
export default function H1BuildingInfoBinding(props: BaseFeatureProps): React.JSX.Element | null {
  const { panel, session, actionsEnabled } = props;
  const state = useApp();
  const { wallet, authed, selectedBaseId: baseId, baseSelectionEpoch: epoch } = state;
  const binding = useMemo(() => ({ active: false, retired: false }), [wallet, authed, baseId, epoch, panel, session]);
  const [door, setDoor] = useState<typeof binding | null>(null);
  const [details, setDetails] = useState<typeof binding | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useLayoutEffect(() => {
    binding.active = true;
    const off = useApp.subscribe((next, prior) => {
      if (next.wallet !== prior.wallet || next.authed !== prior.authed || next.screen !== prior.screen
        || next.selectedBaseId !== prior.selectedBaseId || next.baseSelectionEpoch !== prior.baseSelectionEpoch
        || next.basePanel !== prior.basePanel || next.selectedBuildingId !== prior.selectedBuildingId) binding.retired = true;
    });
    return () => { binding.active = false; off(); };
  }, [binding]);
  const current = () => {
    const live = useApp.getState();
    return binding.active && !binding.retired && phaseEWebEnabled() && live.basePanel === panel
      && live.wallet === wallet && live.authed && live.selectedBaseId === baseId && live.baseSelectionEpoch === epoch
      ? readH1Building(panel.buildingId, live) : null;
  };
  const record = readH1Building(panel.buildingId, state);
  if (!phaseEWebEnabled() || !record || !H1_BUILDING_TYPES.has(record.building.type)) return null;
  const { base, building, job } = record;
  // Never advertise a completed Workshop when the current reader says building
  // but has not supplied its job yet. No local placeholder job is manufactured.
  if (building.underConstruction && !job) return <p role="status">Building details are updating. Select this building again after the base refreshes.</p>;
  // Reuse the original sheet's catalogue cap; do not create a second lookup.
  const maxLevel = maxLevelFor(building.type);
  const facts: BuildingSnapshotFacts = {
    buildingId: building.id, type: building.type, name: trayLabel(building.type), level: building.level, maxLevel,
    artNow: sheetPortrait(building.type, building.level), artNext: '', role: null,
    category: 'FEATURE',
    // No HP field exists in this snapshot. Hide it instead of approximating the server's health.
    stats: [],
    // Original upgrade/finish owners have not supplied mutation authority here.
    canShowUpgrade: false, enabled: actionsEnabled === true && !job && !building.underConstruction,
    upgradeCurrency: null, upgradeCost: null, upgradeCostRaw: null, upgradePriced: false,
    upgradeTime: null, upgradeDetail: null, paidStep: false, paidOfferReady: false,
    job: job ? { id: job.id, kind: job.kind, remaining: null, freeFinish: job.kind === 'build' && job.finishCostKeep === '0',
      canReview: false, cancelRefund: job.canCancel === true ? job.refundShards ?? null : null } : null,
    repair: null, shardsBalance: null, freeBuilders: base.freeBuilders, totalBuilders: base.player.builders,
    nextBuilderFreeIn: null, heroReady: null, wallRow: state.wallRow,
    blockedReason: 'This action is unavailable here.', readOnly: actionsEnabled !== true,
    constructionBlocked: building.underConstruction, busy: false, mine: { mineBuildingId: null, accrued: null },
  };
  const explain = (): void => { if (current()) setNotice('This action is unavailable here.'); };
  const actions: BuildingInfoPanelInput['actions'] = {
    onUpgrade: explain, onFinish: explain, onGetMore: explain,
    onAllLevels: () => { if (current()) setDetails(binding); },
    onExplain: reason => { if (current()) setNotice(reason); },
    onRetry: () => {
      if (current()) void reloadBase({ background: true }).catch(() => { if (current()) setNotice('Building details could not refresh. Please try again.'); });
    },
  };
  const boundSession: PanelSession = {
    setDismissPolicy: session.setDismissPolicy,
    dispatch: (kind, action) => {
      if (!current()) return false;
      // Wall INFO is excluded. Every mutation keeps the original host admission.
      return session.dispatch(kind, action);
    },
  };
  const completedWorkshop = building.type === 'workshop' && !building.underConstruction && !job;
  const revealCraft = (): void => {
    const live = current();
    if (live?.building.type === 'workshop' && !live.building.underConstruction && !live.job) setDoor(binding);
  };
  return <>
    <BuildingInfoPanel {...props} session={boundSession} input={{ facts, actions, renderArt: key => <Sprite name={key} w={48} h={48} /> }}
      {...(completedWorkshop ? { onCraft: revealCraft } : {})} />
    {door === binding && completedWorkshop && actionsEnabled === true ? <OrdinaryCraftingDoor discover buildingId={building.id} /> : null}
    {details === binding ? <Suspense fallback={<p role="status">Loading building details…</p>}><BuildingInfo type={building.type} level={building.level} maxLevel={maxLevel} /></Suspense> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </>;
}
