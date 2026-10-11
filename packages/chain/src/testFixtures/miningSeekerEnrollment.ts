/** Test-only SDK-signed enrollment Memo and synthetic finalized RPC metadata.
 * No network call, wallet funding or transaction submission occurs here. */
import { TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MINING_SEEKER_ENROLLMENT_MEMO_PREFIX, readMiningSeekerEnrollmentEvidence, type MiningSeekerEnrollmentReader } from '../miningSeekerEnrollment';
import { seekerCoverageFixture } from './miningSeekerCoverage';

export function seekerEnrollmentFixture(nonceHex = '19'.repeat(32), legacy = false, includeSigner = false) {
  const f = seekerCoverageFixture(nonceHex, legacy, includeSigner);
  const instruction = new TransactionInstruction({ programId: f.instruction.programId, keys: f.instruction.keys,
    data: Buffer.from(`${MINING_SEEKER_ENROLLMENT_MEMO_PREFIX}${nonceHex}`, 'utf8') });
  const builder = new TransactionMessage({ payerKey: f.payer.publicKey, recentBlockhash: f.transaction.transaction.message.recentBlockhash, instructions: [instruction] });
  f.transaction.transaction.message = legacy ? builder.compileToLegacyMessage() : builder.compileToV0Message();
  f.resign();
  const signed = new VersionedTransaction(f.transaction.transaction.message); signed.sign([f.payer]);
  return { ...f, signed, instruction, read: () => readMiningSeekerEnrollmentEvidence(f.reader as unknown as MiningSeekerEnrollmentReader, f.input) };
}
