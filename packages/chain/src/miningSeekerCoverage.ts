/** Read-only causal witness for prospective Seeker coverage. The database owns
 * nonce generation after committed source coverage; this module only proves the
 * original signed nonce Memo finalized on mainnet. The API must require this
 * witness slot strictly before authenticated original mint birth. A timestamp
 * or a sampled/processed slot cannot establish that causal order.
 *
 * Configured archival RPCs remain the authority for execution/finality. Replay
 * checks retained evidence but does not authenticate arbitrary client JSON.
 */
import { createMiningSeekerMemoWitness, MINING_SEEKER_MEMO_LIMITS,
  type MiningSeekerMemoReader, type MiningSeekerMemoSource, type MiningSeekerMemoInput, type MiningSeekerMemoErrorCode } from './miningSeekerMemo';

export const MINING_SEEKER_COVERAGE_MEMO_PREFIX = 'SHARDKEEP:MINING:SEEKER:COVERAGE:v1:';
export const MINING_SEEKER_COVERAGE_LIMITS = MINING_SEEKER_MEMO_LIMITS;
export type MiningSeekerCoverageReader = MiningSeekerMemoReader;
export type MiningSeekerCoverageSource = MiningSeekerMemoSource;
export type MiningSeekerCoverageInput = MiningSeekerMemoInput;
export class MiningSeekerCoverageError extends Error {
  constructor(readonly code: MiningSeekerMemoErrorCode) { super(`Seeker coverage witness unavailable: ${code}`); this.name = 'MiningSeekerCoverageError'; }
}
const witness = createMiningSeekerMemoWitness(MINING_SEEKER_COVERAGE_MEMO_PREFIX, MiningSeekerCoverageError);
export const replayMiningSeekerCoverageEvidence = witness.replay;
export const readMiningSeekerCoverageEvidence = witness.read;
export const readAgreedMiningSeekerCoverageEvidence = witness.readAgreed;
