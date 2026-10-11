/** Read-only causal witness for a committed prospective Seeker enrollment.
 * The database owns its unpredictable nonce and original account/link binding.
 * This witness grants no eligibility or token authenticity: the API also needs
 * the exact enrollment interval and two-provider closed-day holding evidence.
 * Configured RPCs authenticate finality; replay never authenticates client JSON. */
import { createMiningSeekerMemoWitness, MINING_SEEKER_MEMO_LIMITS,
  type MiningSeekerMemoReader, type MiningSeekerMemoSource, type MiningSeekerMemoInput, type MiningSeekerMemoErrorCode } from './miningSeekerMemo';

export const MINING_SEEKER_ENROLLMENT_MEMO_PREFIX = 'SHARDKEEP:MINING:SEEKER:ENROLLMENT:v1:';
export const MINING_SEEKER_ENROLLMENT_LIMITS = MINING_SEEKER_MEMO_LIMITS;
export type MiningSeekerEnrollmentReader = MiningSeekerMemoReader;
export type MiningSeekerEnrollmentSource = MiningSeekerMemoSource;
export type MiningSeekerEnrollmentInput = MiningSeekerMemoInput;
export class MiningSeekerEnrollmentError extends Error {
  constructor(readonly code: MiningSeekerMemoErrorCode) { super(`Seeker enrollment witness unavailable: ${code}`); this.name = 'MiningSeekerEnrollmentError'; }
}
const witness = createMiningSeekerMemoWitness(MINING_SEEKER_ENROLLMENT_MEMO_PREFIX, MiningSeekerEnrollmentError);
export const replayMiningSeekerEnrollmentEvidence = witness.replay;
export const readMiningSeekerEnrollmentEvidence = witness.read;
export const readAgreedMiningSeekerEnrollmentEvidence = witness.readAgreed;
