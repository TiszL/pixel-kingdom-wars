import { useCallback, useSyncExternalStore } from 'react';
import { inspectConfiguredBasePanel, requestUserCommand, useApp, type Screen, type UserCommandHandle, type UserCommandSettlement } from '../../state/store';
import type { BasePanel } from '../../ui/pk/basePanel';
import { phaseEWebEnabled } from '../../ui/phaseEWebHold';
import { BUILDINGS_INFO_SOURCE, ORDINARY_CRAFTING_PANEL } from './panelIds';

/** D153.298: a receipt list must not become a second new-order launcher.
 * This ephemeral navigation grant supplements, never replaces, each feature's
 * server capability, building-level checks and mutation/wallet guards. */
const buildings = {
  market: 'market', 'ordinary-crafting': 'workshop', 'starter-fleet': 'berth',
  'starter-expeditions': 'lodge', harvesters: 'harvester',
} as const;
export type BuildingActivity = keyof typeof buildings;
type Access = { activity: BuildingActivity; buildingId: string; wallet: string; baseId: string; epoch: number; screen: Screen };
type State = ReturnType<typeof useApp.getState>;
type PanelScope = { wallet: string; baseId: string; epoch: number; buildingId: string; level: number; source: BasePanel | null };
type PanelAccess = { scope: PanelScope; panel: BasePanel };
export type OrdinaryCraftingPanelRefusal = 'source' | 'scope' | 'placing' | 'building' | 'web-held'
  | 'unregistered' | 'capability' | 'registration-changed' | 'open-refused';
export type OrdinaryCraftingPanelOutcome = { outcome: 'opened' }
  | { outcome: 'refused'; reason: OrdinaryCraftingPanelRefusal };
let access: Access | null = null;
let panelAccess: PanelAccess | null = null;
const listeners = new Set<() => void>();
const publishAccess = (): void => { for (const listener of listeners) listener(); };
const subscribeAccess = (listener: () => void): (() => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
const noServerGrant = (): boolean => false;

function sameScope(state: State, scope: PanelScope): boolean {
  return state.authed && state.wallet === scope.wallet && state.selectedBaseId === scope.baseId
    && state.base?.baseId === scope.baseId && state.baseSelectionEpoch === scope.epoch
    && state.screen === 'base' && state.selectedBuildingId === scope.buildingId;
}
function workshopLevel(state: State, buildingId: string): number | null {
  const building = state.base?.buildings.find(row => row.id === buildingId);
  return building?.type === 'workshop' && Number.isInteger(building.level) && building.level > 0
    && !building.underConstruction ? building.level : null;
}
function destination(panel: BasePanel | null, buildingId: string): panel is BasePanel {
  return !!panel && panel.kind === ORDINARY_CRAFTING_PANEL.kind
    && panel.featureId === ORDINARY_CRAFTING_PANEL.featureId && panel.buildingId === buildingId;
}
function validPanelGrant(state: State, grant: PanelAccess): boolean {
  return sameScope(state, grant.scope) && state.placing === null && state.basePanel === grant.panel
    && destination(state.basePanel, grant.scope.buildingId) && workshopLevel(state, grant.scope.buildingId) === grant.scope.level;
}
function revokePanel(): void { if (panelAccess) { panelAccess = null; publishAccess(); } }

// Revoke synchronously: A→B→A between React effects cannot revive either grant.
// The observer uses each transition's state, including nested store transitions.
useApp.subscribe((state) => {
  if (access && (!state.authed || state.wallet !== access.wallet || state.selectedBaseId !== access.baseId
    || state.baseSelectionEpoch !== access.epoch || state.screen !== access.screen)) access = null;
  if (panelAccess && !validPanelGrant(state, panelAccess)) panelAccess = null;
  publishAccess();
});

function completed(activity: BuildingActivity, buildingId: string): boolean {
  const state = useApp.getState();
  if (!state.authed || !state.wallet || !state.selectedBaseId || state.base?.baseId !== state.selectedBaseId) return false;
  const building = state.base.buildings.find(row => row.id === buildingId);
  return !!building && building.type === buildings[activity] && Number.isInteger(building.level)
    && building.level > 0 && !building.underConstruction;
}

export function hasBuildingActivityAccess(activity: BuildingActivity): boolean {
  const state = useApp.getState();
  if (activity === 'ordinary-crafting' && phaseEWebEnabled() && panelAccess && validPanelGrant(state, panelAccess)) return true;
  return !!access && access.activity === activity && state.authed && state.wallet === access.wallet
    && state.selectedBaseId === access.baseId && state.baseSelectionEpoch === access.epoch
    && state.screen === access.screen && completed(activity, access.buildingId)
    && (activity !== 'market' || state.selectedBuildingId === access.buildingId);
}

/** Read-only; grants are minted/revoked outside render. Boolean snapshots are stable. */
export function useBuildingActivityAccess(activity: BuildingActivity): boolean {
  const snapshot = useCallback(() => hasBuildingActivityAccess(activity), [activity]);
  return useSyncExternalStore(subscribeAccess, snapshot, noServerGrant);
}

function refusal(reason: OrdinaryCraftingPanelRefusal): UserCommandSettlement {
  return { status: 'fulfilled', value: { outcome: 'refused', reason } satisfies OrdinaryCraftingPanelOutcome };
}
function settledRefusal(reason: OrdinaryCraftingPanelRefusal): UserCommandHandle {
  const result = refusal(reason);
  const handle = (() => undefined) as UserCommandHandle;
  handle.onSettled = listener => { listener(result); return () => undefined; };
  return handle;
}
function sourceAllowed(state: State, buildingId: string): boolean {
  const panel = state.basePanel;
  return panel === null || panel.kind === BUILDINGS_INFO_SOURCE.kind
    && panel.featureId === BUILDINGS_INFO_SOURCE.featureId && panel.buildingId === buildingId;
}
function eligibility(state: State, scope: PanelScope): OrdinaryCraftingPanelRefusal | null {
  if (!phaseEWebEnabled()) return 'web-held';
  if (state.placing !== null) return 'placing';
  if (workshopLevel(state, scope.buildingId) !== scope.level) return 'building';
  const configured = inspectConfiguredBasePanel({ ...ORDINARY_CRAFTING_PANEL, buildingId: scope.buildingId });
  if (!configured.registered) return 'unregistered';
  if (!configured.actionsEnabled || !configured.feature) return 'capability';
  return null;
}

/** Only the existing world's OrdinaryCraftingDoor explicit click calls this producer.
 * Feature registration and activation remain gated on the joint money review.
 * Refusals preserve existing grants. Scope/user/dismissal cancellation is distinct
 * from eligibility loss: the latter always settles with an explicit reason. */
export function requestOrdinaryCraftingPanel(buildingId: string): UserCommandHandle {
  const before = useApp.getState();
  if (!sourceAllowed(before, buildingId)) return settledRefusal('source');
  if (!phaseEWebEnabled()) return settledRefusal('web-held');
  if (!before.authed || !before.wallet || !before.selectedBaseId || before.base?.baseId !== before.selectedBaseId
    || before.screen !== 'base' || before.selectedBuildingId !== buildingId) return settledRefusal('scope');
  if (before.placing !== null) return settledRefusal('placing');
  const level = workshopLevel(before, buildingId);
  if (level === null) return settledRefusal('building');
  const scope: PanelScope = { wallet: before.wallet, baseId: before.selectedBaseId, epoch: before.baseSelectionEpoch,
    buildingId, level, source: before.basePanel };
  const denied = eligibility(before, scope);
  if (denied) return settledRefusal(denied);
  const target = { ...ORDINARY_CRAFTING_PANEL, buildingId };
  const feature = inspectConfiguredBasePanel(target).feature;
  let result: UserCommandSettlement | null = null;
  const settled = new Set<(result: UserCommandSettlement) => void>();
  let inner: UserCommandHandle | null = null;
  let unsubscribe = (): void => undefined;
  let opening = false;
  const opened: { invalid: boolean; panel: BasePanel | null } = { invalid: false, panel: null };
  const finish = (next: UserCommandSettlement): void => {
    if (result) return;
    result = next; unsubscribe();
    for (const listener of settled) listener(next);
    settled.clear();
  };
  const handle = (() => { if (!result) { finish({ status: 'cancelled' }); inner?.(); } }) as UserCommandHandle;
  handle.onSettled = listener => {
    if (result) listener(result); else settled.add(listener);
    return () => { settled.delete(listener); };
  };
  // Subscribe before requestUserCommand so a building/placing eligibility loss
  // carries its refusal reason before the inner navigation request can cancel.
  unsubscribe = useApp.subscribe(state => {
    if (result) return;
    if (opening) {
      if (!sameScope(state, scope) || eligibility(state, scope)) opened.invalid = true;
      if (opened.panel && state.basePanel !== opened.panel) opened.invalid = true;
      if (state.basePanel !== scope.source) {
        if (!destination(state.basePanel, buildingId)) opened.invalid = true;
        else if (!opened.panel) opened.panel = state.basePanel;
      }
      return;
    }
    if (!sameScope(state, scope) || state.basePanel !== scope.source) { handle(); return; }
    const reason = eligibility(state, scope);
    if (reason) { finish(refusal(reason)); inner?.(); }
  });
  try {
    inner = requestUserCommand((): OrdinaryCraftingPanelOutcome => {
      const current = useApp.getState();
      const reason = eligibility(current, scope);
      if (reason) return { outcome: 'refused', reason };
      if (inspectConfiguredBasePanel(target).feature !== feature) return { outcome: 'refused', reason: 'registration-changed' };
      opening = true;
      try { current.openBasePanel(target); }
      finally { opening = false; unsubscribe(); }
      const after = useApp.getState();
      if (opened.invalid || !sameScope(after, scope) || eligibility(after, scope)
        || inspectConfiguredBasePanel(target).feature !== feature || after.basePanel === scope.source
        || after.basePanel !== opened.panel || !destination(after.basePanel, buildingId)) return { outcome: 'refused', reason: 'open-refused' };
      access = null;
      panelAccess = { scope, panel: after.basePanel };
      publishAccess();
      return { outcome: 'opened' };
    }, () => !result && sameScope(useApp.getState(), scope) && useApp.getState().basePanel === scope.source);
    inner.onSettled(finish);
    if (result) inner(); // A synchronous observer may have settled before assignment.
  } catch (error) { finish({ status: 'rejected', error }); }
  return handle;
}

export function launchBuildingActivity(activity: BuildingActivity, buildingId: string): boolean {
  revokePanel();
  const state = useApp.getState();
  if ((state.screen !== 'base' && state.screen !== 'build') || state.selectedBuildingId !== buildingId || !completed(activity, buildingId)) return false;
  access = { activity, buildingId, wallet: state.wallet!, baseId: state.selectedBaseId!, epoch: state.baseSelectionEpoch,
    screen: activity === 'market' ? state.screen : activity };
  if (activity !== 'market') state.setScreen(activity);
  publishAccess();
  return true;
}

export function launchHistoryActivity(activity: BuildingActivity): void {
  access = null;
  revokePanel();
  if (activity !== 'market') useApp.getState().setScreen(activity);
  publishAccess();
}
