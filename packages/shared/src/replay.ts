import { RAID_REPLAY_LIMITS } from './constants';
import type { AttackRunEvent } from './types';

export function assertAttackRunBounded(run: AttackRunEvent): void {
  if (!Number.isInteger(run.t) || run.t < 0
    || !Number.isInteger(run.count) || run.count < 1 || run.count > RAID_REPLAY_LIMITS.maxAttackRunCycles
    || !Number.isInteger(run.cycleTicks) || run.cycleTicks < 1
    || run.cycleTicks > RAID_REPLAY_LIMITS.postBattleDrainTicks
    || !Number.isInteger(run.cadenceTicks) || run.cadenceTicks < 1
    || run.cadenceTicks > RAID_REPLAY_LIMITS.maxAttackRunCycles
    || !Number.isInteger(run.releaseOffsetTicks) || run.releaseOffsetTicks < 0
    || run.releaseOffsetTicks > run.cycleTicks
    || !Number.isInteger(run.cycleMs) || run.cycleMs < 1
    || run.cycleMs > run.cycleTicks * 100
    || !Number.isInteger(run.releaseOffsetMs) || run.releaseOffsetMs < 0
    || run.releaseOffsetMs > run.cycleMs
    || run.impactOffsetsTicks.length < 1
    || run.impactOffsetsTicks.length > RAID_REPLAY_LIMITS.maxAttackContactsPerCycle
    || run.impactOffsetsTicks.some((v) => !Number.isInteger(v) || v < 0
      || v > RAID_REPLAY_LIMITS.postBattleDrainTicks)) {
    throw new RangeError('invalid or unbounded attack run');
  }
}

/** Expands only the run clock; callers retain the compact record for rendering. */
export function attackRunCycleStarts(run: AttackRunEvent, max = RAID_REPLAY_LIMITS.maxAttackRunCycles): number[] {
  assertAttackRunBounded(run);
  if (run.count > max) throw new RangeError('attack run expansion limit exceeded');
  return Array.from({ length: run.count }, (_, i) => run.t + i * run.cadenceTicks);
}

/** Keep only cycles whose authored body has not started before a replacement
 * tick. The currently-running body/projectile survives scene replacement; this
 * suffix recreates the future cycles removed with the old timeline. */
export function attackRunSuffixFromTick(
  run: AttackRunEvent, fromTick: number,
): AttackRunEvent | null {
  assertAttackRunBounded(run);
  if (!Number.isFinite(fromTick) || fromTick < 0) {
    throw new RangeError('invalid attack run replacement tick');
  }
  if (fromTick <= run.t) return run;
  const skipped = Math.ceil((fromTick - run.t) / run.cadenceTicks);
  if (skipped >= run.count) return null;
  return { ...run, t: run.t + skipped * run.cadenceTicks, count: run.count - skipped };
}

export type LegacyTroopCue =
  | { t: number; e: 'troopFire'; id: number; target: number | string; ix: number; iy: number; proj?: 'boulder' }
  | { t: number; e: 'troopAttack'; id: number; troop: AttackRunEvent['troop'];
      side: AttackRunEvent['side']; targetKind: AttackRunEvent['targetKind'];
      target: number | string; ix: number; iy: number;
      technique: 'strike' | 'slam' | 'rend'; cadenceTicks: number };

/** Compatibility adapter for pre-SIM9 renderers. It is intentionally explicit
 * and bounded; authoritative replay storage remains the compact attack run. */
export function expandAttackRunLegacy(run: AttackRunEvent): LegacyTroopCue[] {
  return attackRunCycleStarts(run).map((t): LegacyTroopCue => {
    if (run.mode === 'projectile' || run.mode === 'stream') {
      return { t, e: 'troopFire', id: run.id, target: run.target, ix: run.ix, iy: run.iy,
        ...(run.technique === 'boulder' ? { proj: 'boulder' as const } : {}) };
    }
    return { t, e: 'troopAttack', id: run.id, troop: run.troop, side: run.side,
      targetKind: run.targetKind, target: run.target, ix: run.ix, iy: run.iy,
      technique: run.technique === 'slam' || run.technique === 'rend'
        ? run.technique : 'strike', cadenceTicks: run.cadenceTicks };
  });
}
