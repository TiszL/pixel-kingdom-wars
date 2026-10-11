import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SEEKER } from '@shardkeep/shared';
import { MINING_SEEKER_ENROLLMENT_LIMITS, MiningSeekerEnrollmentError, readMiningSeekerEnrollmentEvidence, readAgreedMiningSeekerEnrollmentEvidence, replayMiningSeekerEnrollmentEvidence, type MiningSeekerEnrollmentReader } from './miningSeekerEnrollment';
import { MiningSeekerCoverageError, readMiningSeekerCoverageEvidence, replayMiningSeekerCoverageEvidence } from './miningSeekerCoverage';
import { seekerCoverageFixture } from './testFixtures/miningSeekerCoverage';
import { seekerEnrollmentFixture } from './testFixtures/miningSeekerEnrollment';

const source = (f: ReturnType<typeof seekerEnrollmentFixture>) => f.reader as unknown as MiningSeekerEnrollmentReader;

describe('committed enrollment purpose-bound finalized Memo', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('accepts signed legacy=%s signer-account=%s enrollment without authenticating its database or SGT', async (legacy, signer) => {
    const f = seekerEnrollmentFixture('aa'.repeat(32), legacy, signer), proof = await f.read();
    expect(proof).toMatchObject({ ...f.input, slot: 1, blockTime: 10, genesisHash: SEEKER.mainnetGenesisHash,
      payer: f.payer.publicKey.toBase58(), trust: 'trusted-finalized-rpc', eligibilityAuthorized: false });
    expect(proof.messageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.signed.message).toBe(f.transaction.transaction.message);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(replayMiningSeekerEnrollmentEvidence(proof.evidenceJson, f.input)).toEqual(proof);
    expect(f.reader.getTransaction).toHaveBeenCalledWith(f.input.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    expect(f.reader.getSignatureStatuses).toHaveBeenCalledWith([f.input.signature], { searchTransactionHistory: true });
    expect(f.reader.getBlockSignatures).toHaveBeenCalledWith(1, 'finalized');
  });

  it.each([false, true])('rejects cross-purpose receipt reuse in both directions, legacy=%s', async legacy => {
    const coverage = seekerCoverageFixture('aa'.repeat(32), legacy), enrollment = seekerEnrollmentFixture('aa'.repeat(32), legacy);
    const oldProof = await coverage.read(), newProof = await enrollment.read();
    await expect(readMiningSeekerEnrollmentEvidence(source(coverage), coverage.input)).rejects.toMatchObject({ name: 'MiningSeekerEnrollmentError', code: 'MEMO_INVALID' });
    await expect(readMiningSeekerCoverageEvidence(source(enrollment), enrollment.input)).rejects.toMatchObject({ name: 'MiningSeekerCoverageError', code: 'MEMO_INVALID' });
    expect(() => replayMiningSeekerEnrollmentEvidence(oldProof.evidenceJson, coverage.input)).toThrow(MiningSeekerEnrollmentError);
    expect(() => replayMiningSeekerCoverageEvidence(newProof.evidenceJson, enrollment.input)).toThrow(MiningSeekerCoverageError);
  });

  it('cannot retarget a retained enrollment to another nonce or alter signed bytes', async () => {
    const f = seekerEnrollmentFixture(), proof = await f.read();
    expect(() => replayMiningSeekerEnrollmentEvidence(proof.evidenceJson, { ...f.input, nonceHex: '20'.repeat(32) })).toThrow(MiningSeekerEnrollmentError);
    const transcript = JSON.parse(proof.evidenceJson);
    transcript.input.nonceHex = '20'.repeat(32);
    expect(() => replayMiningSeekerEnrollmentEvidence(JSON.stringify(transcript), transcript.input)).toThrow(MiningSeekerEnrollmentError);
    f.transaction.transaction.message.recentBlockhash = f.payer.publicKey.toBase58();
    await expect(f.read()).rejects.toMatchObject({ name: 'MiningSeekerEnrollmentError', code: 'SIGNATURE_INVALID' });
  });

  it('requires agreement and never substitutes one available archive for two', async () => {
    const a = seekerEnrollmentFixture(), b = seekerEnrollmentFixture(), sources = [source(a), source(b)] as const;
    const agreed = await readAgreedMiningSeekerEnrollmentEvidence(sources, a.input);
    expect(agreed).toMatchObject({ ...a.input, slot: 1, blockTime: 10, sources: 2, eligibilityAuthorized: false });
    expect(Object.isFrozen(agreed.proofs)).toBe(true);
    expect(agreed.proofs.map(proof => replayMiningSeekerEnrollmentEvidence(proof.evidenceJson, a.input))).toEqual(agreed.proofs);
    b.transaction.slot = 2; b.transaction.blockTime = 20;
    await expect(readAgreedMiningSeekerEnrollmentEvidence(sources, a.input)).rejects.toMatchObject({ name: 'MiningSeekerEnrollmentError', code: 'SOURCE_DISAGREEMENT' });
    b.reader.getTransaction.mockRejectedValue(Error('archive unavailable'));
    await expect(readAgreedMiningSeekerEnrollmentEvidence(sources, a.input)).rejects.toMatchObject({ name: 'MiningSeekerEnrollmentError', code: 'READER_UNAVAILABLE' });
    await expect(readAgreedMiningSeekerEnrollmentEvidence([sources[0], sources[0]], a.input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each(['nonce', 'extraField', 'unfinalized', 'wrongNetwork', 'missingBlock', 'oversize'] as const)('retains enrollment refusal and bounded evidence semantics: %s', async kind => {
    const f = seekerEnrollmentFixture();
    if (kind === 'nonce') f.input.nonceHex = 'AA'.repeat(32);
    if (kind === 'extraField') Object.assign(f.input, { eligibilityAuthorized: true });
    if (kind === 'unfinalized') f.reader.getSignatureStatuses.mockResolvedValue({ context: { slot: 30 }, value: [{ slot: 1, err: null, confirmationStatus: 'confirmed', confirmations: 1 }] });
    if (kind === 'wrongNetwork') f.reader.getGenesisHash.mockResolvedValue(f.payer.publicKey.toBase58());
    if (kind === 'missingBlock') f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 10, signatures: [] });
    if (kind === 'oversize') f.transaction.meta!.logMessages = ['x'.repeat(MINING_SEEKER_ENROLLMENT_LIMITS.maxMetadataBytes)];
    await expect(f.read()).rejects.toBeInstanceOf(MiningSeekerEnrollmentError);
    if (kind === 'nonce' || kind === 'extraField') expect(f.reader.getGenesisHash).not.toHaveBeenCalled();
  });

  it('cancels the shared deadline with the enrollment error domain', async () => {
    vi.useFakeTimers();
    try {
      const f = seekerEnrollmentFixture(); let signal: AbortSignal | undefined;
      f.reader.getTransaction.mockImplementation(() => new Promise(() => {}));
      const pending = readMiningSeekerEnrollmentEvidence(s => { signal = s; return source(f); }, f.input);
      const refusal = expect(pending).rejects.toMatchObject({ name: 'MiningSeekerEnrollmentError', code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(MINING_SEEKER_ENROLLMENT_LIMITS.timeoutMs); await refusal;
      expect(signal?.aborted).toBe(true); expect(f.reader.getSignatureStatuses).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});

// Digests captured from the accepted pre-extraction coverage implementation,
// using the real SDK signatures above. Domain reuse must not rewrite old bytes.
describe('historical coverage transcript bytes remain immutable', () => {
  it('preserves legacy=false signer=false bytes', async () => {
    const f = seekerCoverageFixture('aa'.repeat(32), false, false), proof = await f.read();
    expect(createHash('sha256').update(proof.evidenceJson).digest('hex')).toBe('26cd6a73dae9801b25287fc8a480fc28450ae76335489d3e9452ad384041e186');
  });
  it('preserves legacy=false signer=true bytes', async () => {
    const f = seekerCoverageFixture('aa'.repeat(32), false, true), proof = await f.read();
    expect(createHash('sha256').update(proof.evidenceJson).digest('hex')).toBe('6302a8f4d1fe7a58c793f7399180384e2652e755906c726d8acaa9e5630068d8');
  });
  it('preserves legacy=true signer=false bytes', async () => {
    const f = seekerCoverageFixture('aa'.repeat(32), true, false), proof = await f.read();
    expect(createHash('sha256').update(proof.evidenceJson).digest('hex')).toBe('744a16d1ea5f3352808b23326aeda366b059348586aaaec1ea3e4b2e5b84f2a7');
  });
  it('preserves legacy=true signer=true bytes', async () => {
    const f = seekerCoverageFixture('aa'.repeat(32), true, true), proof = await f.read();
    expect(createHash('sha256').update(proof.evidenceJson).digest('hex')).toBe('98aec5f8c7c209c3032dbd99452f898bc0f993ec4989a339699abe5a34bd2c2e');
  });
});
