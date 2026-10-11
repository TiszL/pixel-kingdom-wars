import { useLayoutEffect, useSyncExternalStore } from 'react';
import { bus } from '../../lib/events';
import { BUILDINGS_INFO_SOURCE } from '../../lib/phaseEActivity/panelIds';
import { inspectConfiguredBasePanel, requestUserCommand, useApp, type UserCommandHandle } from '../../state/store';
import { phaseEWebEnabled } from '../phaseEWebHold';
import { H1_BUILDING_TYPES, readH1Building } from './h1BuildingScope';
import { isH1InfoFeature } from './h1BaseRegistry';

type AppState = ReturnType<typeof useApp.getState>;
const sameScope = (next: AppState, prior: AppState): boolean => next.wallet === prior.wallet
  && next.authed === prior.authed && next.screen === prior.screen
  && next.selectedBaseId === prior.selectedBaseId && next.baseSelectionEpoch === prior.baseSelectionEpoch;

/** The scene emits this event only after its original guarded tap command. A
 * restored selection or a React render is deliberately not an entry producer. */
export function installH1BuildingIntake(): () => void {
  if (!phaseEWebEnabled()) return () => undefined;
  const before = useApp.getState();
  let active = true;
  const pending = new Set<UserCommandHandle>();
  const track = (handle: UserCommandHandle): void => { pending.add(handle); handle.onSettled(() => pending.delete(handle)); };
  const retire = (): void => { active = false; for (const cancel of pending) cancel(); pending.clear(); };
  const inScope = (): boolean => {
    const state = useApp.getState();
    return active && state.authed && state.screen === 'base' && sameScope(state, before);
  };
  const unsubscribe = useApp.subscribe((state, prior) => { if (!sameScope(state, prior)) retire(); });
  const off = bus.on('base:select', ({ buildingId }) => {
    if (!phaseEWebEnabled() || !buildingId || !inScope()) return;
    const panel = { ...BUILDINGS_INFO_SOURCE, buildingId };
    const feature = inspectConfiguredBasePanel(panel).feature;
    const canOpen = (): boolean => {
      const record = readH1Building(buildingId);
      return inScope() && !!record && H1_BUILDING_TYPES.has(record.building.type)
        && !record.building.underConstruction && isH1InfoFeature(feature)
        && inspectConfiguredBasePanel(panel).feature === feature;
    };
    const current = useApp.getState().basePanel;
    const isRetargetedInfo = current?.featureId === panel.featureId && current.kind === panel.kind && current.buildingId === buildingId;
    if (!canOpen()) {
      if (!isRetargetedInfo) return;
      // select() retargets an existing INFO before the scene emits this event.
      // Unsupported buildings (including walls) must return to their original
      // sheet, under the same user-command dismissal and stale-scope policy.
      track(requestUserCommand(() => useApp.getState().closeBasePanel(), () => {
        const live = useApp.getState();
        return phaseEWebEnabled() && inScope() && live.basePanel === current
          && live.selectedBuildingId === buildingId && !canOpen();
      }));
      return;
    }
    if (isRetargetedInfo) return;
    track(requestUserCommand(() => useApp.getState().openBasePanel(panel), canOpen));
  });
  return () => { retire(); off(); unsubscribe(); };
}

const subscribeScope = (changed: () => void): (() => void) => useApp.subscribe((next, prior) => {
  if (!sameScope(next, prior)) changed();
});
const subscribeHeld = (): (() => void) => () => undefined;
const scopeSnapshot = (): string => {
  if (!phaseEWebEnabled()) return 'held';
  const state = useApp.getState();
  return JSON.stringify([state.wallet, state.authed, state.screen, state.selectedBaseId, state.baseSelectionEpoch]);
};

export function useH1BuildingIntake(): void {
  // Avoid even React's scope subscription in a held build. The hook order is
  // stable across mode changes; an enabled scope change reinstalls at commit.
  const scope = useSyncExternalStore(phaseEWebEnabled() ? subscribeScope : subscribeHeld, scopeSnapshot, scopeSnapshot);
  useLayoutEffect(installH1BuildingIntake, [scope]);
}
