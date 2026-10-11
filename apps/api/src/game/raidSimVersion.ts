import { SIM_VERSION } from '@shardkeep/sim';
import { HttpError } from '../lib/errors';

/** SIM3–5 once shared outcomes; SIM6 ended that exception. New input and
 * resolution must use the same compatibility policy for the frozen raid. */
export function canResolveWithCurrentSimulator(pinnedVersion: number): boolean {
  return pinnedVersion === SIM_VERSION;
}

/** Do not arm, spend a buff, or change a clock that this worker cannot settle.
 * Exact stored receipts are recovered before this gate; compensation remains
 * in the existing original-raid resolution path. */
export function assertCurrentRaidInputVersion(pinnedVersion: number): void {
  if (!canResolveWithCurrentSimulator(pinnedVersion)) {
    throw new HttpError(409,
      `raid uses simulator v${pinnedVersion}, but the server now uses v${SIM_VERSION}; check this raid's result before starting a new raid`,
      'RAID_SIM_VERSION_MISMATCH');
  }
}
