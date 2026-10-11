/** SDK-encoded synthetic archive records for an old SGT and a new committed
 * enrollment. Only the Memo signatures are real; no live RPC or signing occurs. */
import { vi } from 'vitest';
import { seekerMintBirthFixture } from '../../../../packages/chain/src/testFixtures/miningSeekerHolding';
import { seekerEnrollmentFixture } from '../../../../packages/chain/src/testFixtures/miningSeekerEnrollment';
import type { SeekerMiningEnrollmentReader, SeekerMiningEnrollmentWiring } from '../../src/mining/seekerEnrollmentQualification';

export function createSeekerEnrollmentArchives(challenge: { id: string; nonce: string; observedAt: string }, options: {
 mintBirthAt?: string; accountCreatedAt?: string; issuedAt?: string; observedAt?: string;
} = {}) {
 const times = [options.mintBirthAt ?? '2019-01-01T06:00:00Z', options.accountCreatedAt ?? '2019-01-01T07:00:00Z',
  options.issuedAt ?? '2019-01-01T07:01:00Z'].map(value => Date.parse(value) / 1_000);
 const observedAt = Date.parse(options.observedAt ?? '2020-01-04T01:00:00Z') / 1_000;
 function archive() {
  const f = seekerMintBirthFixture(), witness = seekerEnrollmentFixture(challenge.nonce);
  witness.transaction.slot = 20;
  witness.transaction.blockTime = Math.ceil(Date.parse(challenge.observedAt) / 1_000) + 1;
  for (const [i, transaction] of f.txs.entries()) transaction.blockTime = times[i]!;
  const allTransactions = () => [witness.transaction, ...f.txs];
  const reader = { ...f.reader,
   getSignatureStatuses: witness.reader.getSignatureStatuses,
   getTransaction: vi.fn(async (signature: string) => allTransactions().find(t => t.transaction.signatures[0] === signature) ?? null),
   getBlockTime: vi.fn(async (slot: number) => slot === 30 ? observedAt : allTransactions().find(t => t.slot === slot)?.blockTime ?? null),
   getBlockSignatures: vi.fn(async (slot: number) => ({ blockTime: slot === 30 ? observedAt : allTransactions().find(t => t.slot === slot)?.blockTime ?? null,
    signatures: allTransactions().filter(t => t.slot === slot).map(t => t.transaction.signatures[0]!) })),
  };
  return { ...f, reader, witness };
 }
 const a = archive(), b = archive();
 for (const [i, transaction] of a.txs.entries()) b.txs[i]!.transaction.signatures = [...transaction.transaction.signatures];
 const wiring: SeekerMiningEnrollmentWiring = { enrollmentId: challenge.id, enrollmentSignature: a.witness.input.signature, providers: [
  { id: 'archive-alpha', connect: () => a.reader as unknown as SeekerMiningEnrollmentReader },
  { id: 'archive-beta', connect: () => b.reader as unknown as SeekerMiningEnrollmentReader },
 ] };
 return { wiring, archives: [a, b] as const, input: a.input, witnesses: [a.witness, b.witness] as const };
}
