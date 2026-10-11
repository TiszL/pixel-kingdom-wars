import { WARZONE } from '@shardkeep/shared';
import type { BaseStateDto } from '../state/store';

/** Next authoritative /base refresh for state that changes at a server deadline. */
export function baseAutoRefetchDelay(base: Pick<
  BaseStateDto, 'jobs' | 'shield' | 'heroes' | 'warzone' | 'armyStatus'
>, nowMs: number): number | null {
  const deadlineMs = base.jobs.map((job) => Date.parse(job.finishesAt));
  if (base.shield) deadlineMs.push(Date.parse(base.shield.activeUntil));
  const warzoneBoundary = base.warzone?.boundaryAt
    ? Date.parse(base.warzone.boundaryAt)
    : null;
  if (warzoneBoundary !== null) deadlineMs.push(warzoneBoundary);
  for (const hero of base.heroes ?? []) {
    if (hero.recoveryUntil) deadlineMs.push(Date.parse(hero.recoveryUntil));
  }
  const nextTroopReadyAt = base.armyStatus?.nextReadyAt
    ? Date.parse(base.armyStatus.nextReadyAt)
    : null;
  if (nextTroopReadyAt !== null) deadlineMs.push(nextTroopReadyAt);
  const elapsedJob = base.jobs.some((job) => Date.parse(job.finishesAt) <= nowMs);
  // A completed deadline remains stored for history. Retry only until the
  // server flips availability, or every healthy hero would poll forever.
  const elapsedRecovery = (base.heroes ?? []).some((hero) => (
    !hero.available && hero.recoveryUntil !== null
      && Date.parse(hero.recoveryUntil) <= nowMs
  ));
  // A just-finished queue row remains pending until the server's lazy
  // completion read lands. Retry only while that pending count still proves
  // the response stale; a historical/null deadline never creates a heartbeat.
  const elapsedTraining = (base.armyStatus?.trainingTroopCount ?? 0) > 0
    && nextTroopReadyAt !== null
    && Number.isFinite(nextTroopReadyAt)
    && nextTroopReadyAt <= nowMs;
  // A stale response just beyond a scheduled boundary must never keep an
  // ordinary shield looking effective (or suppressed) indefinitely. Retry
  // until /base returns the other phase and its next authoritative boundary.
  const elapsedWarzone = warzoneBoundary !== null
    && Number.isFinite(warzoneBoundary)
    && warzoneBoundary <= nowMs;
  if (elapsedJob || elapsedRecovery || elapsedTraining || elapsedWarzone) return 2_000;
  const future = deadlineMs.filter((deadline) => Number.isFinite(deadline) && deadline > nowMs);
  const deadlineDelay = future.length > 0 ? Math.min(...future) - nowMs + 1_500 : null;
  // Runtime mode changes can supersede even a disclosed boundary (for example,
  // scheduled -> active purge, or active -> off). A bounded current-state poll
  // therefore caps staleness for every warzone-aware snapshot without deriving
  // or exposing an undisclosed future activation timestamp.
  const currentPhasePoll = base.warzone
    ? WARZONE.currentPhasePollSec * 1_000
    : null;
  if (deadlineDelay === null) return currentPhasePoll;
  if (currentPhasePoll === null) return deadlineDelay;
  return Math.min(deadlineDelay, currentPhasePoll);
}
