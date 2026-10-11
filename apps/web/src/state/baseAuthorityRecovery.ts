/** Authority failures control navigation, never raid settlement. Keep uncertain
 * chain reads recoverable; confirmed ownership loss clears presentation first. */
import { BASE_CLIENT_UPGRADE_REQUIRED } from '../lib/api';
import { bus } from '../lib/events';
import { sceneCleanup } from '../game/sceneCleanup';
import { clearBaseSnapshot, useApp } from './store';
export function baseAuthorityRequestScope(): string {
  const state = useApp.getState();
  return JSON.stringify([state.authed, state.wallet, state.selectedBaseId, state.baseSelectionEpoch]);
}
export function recoverBaseAuthority(code: string): void {
  const state = useApp.getState();
  if (code === 'DEED_AUTHORITY_UNAVAILABLE') {
    bus.emit('ui:toast', { msg: state.screen === 'entry' && state.entryPaid
      ? 'LAND VERIFICATION IS DELAYED — RETRY ENTERING YOUR BASE'
      : 'LAND VERIFICATION IS TEMPORARILY UNAVAILABLE — RETRY YOUR ACTION' });
    return;
  }
  // Do not call RaidUI's explicit exit action: that can submit FINISH. The
  // canonical raid pointer remains available for later server reconciliation.
  if (state.screen === 'battle' || state.screen === 'scout') {
    sceneCleanup('authority-battle-exit', () => bus.emit('battle:exit', undefined));
  }
  clearBaseSnapshot();
  state.setRaidTarget(null);
  state.setScoutReport(null);
  state.setScreen('bases');
  bus.emit('ui:toast', { msg: code === BASE_CLIENT_UPGRADE_REQUIRED
    ? 'THIS ACCOUNT REQUIRES AN EXPLICIT BASE SELECTION'
    : 'DEED OWNERSHIP CHANGED — SELECT AN ACTIVE BASE' });
}
