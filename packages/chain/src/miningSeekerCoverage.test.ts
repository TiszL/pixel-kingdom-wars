import { describe, expect, it, vi } from 'vitest';
import { PublicKey, SystemProgram, TransactionMessage, TransactionInstruction } from '@solana/web3.js';
import { SEEKER } from '@shardkeep/shared';
import bs58 from 'bs58';
import { MINING_SEEKER_COVERAGE_LIMITS, MINING_SEEKER_COVERAGE_MEMO_PREFIX, readAgreedMiningSeekerCoverageEvidence, replayMiningSeekerCoverageEvidence, type MiningSeekerCoverageReader } from './miningSeekerCoverage';
import { seekerCoverageFixture } from './testFixtures/miningSeekerCoverage';

describe('causal finalized Seeker coverage Memo witness', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('proves a real SDK-signed v0/legacy=%s signer-account=%s Memo without granting eligibility', async (legacy, signer) => {
    const f = seekerCoverageFixture('aa'.repeat(32), legacy, signer), proof = await f.read();
    expect(proof).toMatchObject({ nonceHex: f.input.nonceHex, signature: f.input.signature, slot: 1, genesisHash: SEEKER.mainnetGenesisHash, eligibilityAuthorized: false });
    expect(proof.messageSha256).toMatch(/^[0-9a-f]{64}$/); expect(Object.isFrozen(proof)).toBe(true); expect(replayMiningSeekerCoverageEvidence(proof.evidenceJson, f.input)).toEqual(proof);
    expect(f.reader.getTransaction).toHaveBeenCalledWith(f.input.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    expect(f.reader.getSignatureStatuses).toHaveBeenCalledWith([f.input.signature], { searchTransactionHistory: true });
    expect(f.reader.getBlockSignatures).toHaveBeenCalledWith(1, 'finalized');
    expect(JSON.parse(JSON.parse(proof.evidenceJson).transaction.metadataJson).logMessages).toEqual(['Synthetic fixture Memo execution']);
  });
  it.each(['wrongProgram', 'wrongNonce', 'wrongPurpose', 'extraMemo', 'extraTransfer', 'wrongAccounts', 'wrongPayer', 'corruptedSignature', 'missingSignature', 'extraSignature', 'failed', 'inner', 'balance', 'loaded', 'version'] as const)('rejects an inexact original signed transaction: %s', async kind => {
    const f = seekerCoverageFixture();
    if (kind === 'wrongProgram') { f.transaction.transaction.message.staticAccountKeys[1] = SystemProgram.programId; f.resign(); }
    if (kind === 'wrongNonce') { f.transaction.transaction.message.compiledInstructions[0]!.data = Buffer.from(`${MINING_SEEKER_COVERAGE_MEMO_PREFIX}${'20'.repeat(32)}`); f.resign(); }
    if (kind === 'wrongPurpose') { f.transaction.transaction.message.compiledInstructions[0]!.data = Buffer.from(`SHARDKEEP:OTHER:${f.input.nonceHex}`); f.resign(); }
    if (kind === 'extraMemo' || kind === 'extraTransfer') {
      const extra = kind === 'extraMemo' ? f.instruction : SystemProgram.transfer({ fromPubkey: f.payer.publicKey, toPubkey: PublicKey.default, lamports: 1 });
      f.transaction.transaction.message = new TransactionMessage({ payerKey: f.payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [f.instruction, extra] }).compileToV0Message(); f.resign();
    }
    if (kind === 'wrongAccounts') { f.transaction.transaction.message.compiledInstructions[0]!.accountKeyIndexes = [1]; f.resign(); }
    if (kind === 'wrongPayer') f.transaction.transaction.message.staticAccountKeys[0] = PublicKey.default;
    if (kind === 'corruptedSignature') { const b = bs58.decode(f.input.signature); b[0] = b[0]! ^ 1; f.input.signature = bs58.encode(b); f.transaction.transaction.signatures = [f.input.signature]; }
    if (kind === 'missingSignature') f.transaction.transaction.signatures = [];
    if (kind === 'extraSignature') f.transaction.transaction.signatures.push(f.input.signature);
    if (kind === 'failed') f.transaction.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    if (kind === 'inner') f.transaction.meta!.innerInstructions = [{ index: 0, instructions: [] }];
    if (kind === 'balance') f.transaction.meta!.postBalances[0] = 1000000000;
    if (kind === 'loaded') f.transaction.meta!.loadedAddresses = { writable: [PublicKey.default], readonly: [] };
    if (kind === 'version') f.transaction.version = 1 as 0;
    await expect(f.read()).rejects.toBeInstanceOf(Error);
  });
  it.each(['body', 'status', 'confirmed', 'confirmationCount', 'statusSlot', 'staleContext', 'futureTransaction', 'regression', 'beforeGenesis', 'afterGenesis', 'missingBlockTime', 'bodyTime', 'blockTime', 'omittedBlockSignature', 'duplicateBlockSignature', 'malformedBlockSignature'] as const)('refuses missing, unfinalized or contradictory source facts: %s', async kind => {
    const f = seekerCoverageFixture();
    if (kind === 'body') f.reader.getTransaction.mockResolvedValue(null);
    if (kind === 'status') f.reader.getSignatureStatuses.mockResolvedValue({ context: { slot: 30 }, value: [null] });
    if (['confirmed', 'confirmationCount', 'statusSlot', 'staleContext'].includes(kind)) f.reader.getSignatureStatuses.mockResolvedValue({ context: { slot: kind === 'staleContext' ? 29 : 30 }, value: [{ slot: kind === 'statusSlot' ? 2 : 1, err: null, confirmationStatus: kind === 'confirmed' ? 'confirmed' : 'finalized', confirmations: kind === 'confirmationCount' ? 1 : null }] });
    if (kind === 'futureTransaction') { f.transaction.slot = 31; f.transaction.blockTime = 310; }
    if (kind === 'regression') f.reader.getSlot.mockResolvedValueOnce(30).mockResolvedValue(29);
    if (kind === 'beforeGenesis') f.reader.getGenesisHash.mockResolvedValue(PublicKey.default.toBase58());
    if (kind === 'afterGenesis') f.reader.getGenesisHash.mockResolvedValueOnce(SEEKER.mainnetGenesisHash).mockResolvedValue(PublicKey.default.toBase58());
    if (kind === 'missingBlockTime') f.reader.getBlockTime.mockResolvedValue(null);
    if (kind === 'bodyTime') f.transaction.blockTime = 11;
    if (kind === 'blockTime') f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 11, signatures: [f.input.signature] });
    if (kind === 'omittedBlockSignature') f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 10, signatures: [] });
    if (kind === 'duplicateBlockSignature') f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 10, signatures: [f.input.signature, f.input.signature] });
    if (kind === 'malformedBlockSignature') f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 10, signatures: [f.input.signature, 'x'] });
    await expect(f.read()).rejects.toBeInstanceOf(Error);
  });
  it.each(['shortNonce', 'uppercaseNonce', 'nonhex', 'shortSignature', 'extraProperty'] as const)('rejects noncanonical request %s before reading', async kind => {
    const f = seekerCoverageFixture();
    if (kind === 'shortNonce') f.input.nonceHex = '19';
    if (kind === 'uppercaseNonce') f.input.nonceHex = 'AA'.repeat(32);
    if (kind === 'nonhex') f.input.nonceHex = 'xx'.repeat(32);
    if (kind === 'shortSignature') f.input.signature = '1';
    if (kind === 'extraProperty') Object.assign(f.input, { eligibilityAuthorized: true });
    await expect(f.read()).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(f.reader.getGenesisHash).not.toHaveBeenCalled();
  });
  it('copies original signed bytes, metadata, caller identity, status and block inventory before later callbacks', async () => {
    const f = seekerCoverageFixture(), expected = { ...f.input };
    const status = { context: { slot: 30 }, value: [{ slot: 1, err: null, confirmationStatus: 'finalized', confirmations: null }] };
    const order = { blockTime: 10, signatures: [f.input.signature] };
    f.reader.getSignatureStatuses.mockImplementation(async () => { f.transaction.meta!.err = { InstructionError: [0, 'InvalidArgument'] }; f.transaction.transaction.message.compiledInstructions[0]!.data.fill(0); return status; });
    f.reader.getBlockTime.mockImplementation(async () => { status.value[0]!.slot = 9; return 10; });
    f.reader.getBlockSignatures.mockImplementation(async () => order);
    f.reader.getSlot.mockResolvedValueOnce(30).mockImplementation(async () => { order.signatures.splice(0); f.input.nonceHex = '20'.repeat(32); return 30; });
    const proof = await f.read(); expect(proof.nonceHex).toBe(expected.nonceHex); expect(replayMiningSeekerCoverageEvidence(proof.evidenceJson, expected).slot).toBe(1);
  });
  it('requires two independent configured providers and rejects disagreement or single-source outage', async () => {
    const a = seekerCoverageFixture(), b = seekerCoverageFixture();
    const sources = [a.reader, b.reader] as unknown as [MiningSeekerCoverageReader, MiningSeekerCoverageReader];
    const result = await readAgreedMiningSeekerCoverageEvidence(sources, a.input); expect(result.sources).toBe(2); expect(Object.isFrozen(result.proofs)).toBe(true);
    b.transaction.slot = 2; b.transaction.blockTime = 20;
    await expect(readAgreedMiningSeekerCoverageEvidence(sources, a.input)).rejects.toMatchObject({ code: 'SOURCE_DISAGREEMENT' });
    b.reader.getTransaction.mockRejectedValue(new Error('archive unavailable'));
    await expect(readAgreedMiningSeekerCoverageEvidence(sources, a.input)).rejects.toMatchObject({ code: 'READER_UNAVAILABLE' });
    await expect(readAgreedMiningSeekerCoverageEvidence([sources[0], sources[0]], a.input)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('replay cannot retarget the challenge or silently alter signed bytes/finality metadata', async () => {
    const f = seekerCoverageFixture(), proof = await f.read();
    expect(() => replayMiningSeekerCoverageEvidence(proof.evidenceJson, { ...f.input, nonceHex: '20'.repeat(32) })).toThrow();
    const t = JSON.parse(proof.evidenceJson); t.status.confirmationStatus = 'confirmed'; expect(() => replayMiningSeekerCoverageEvidence(JSON.stringify(t), f.input)).toThrow();
    t.status.confirmationStatus = 'finalized'; t.transaction.messageBase64 = Buffer.from('not a transaction').toString('base64'); expect(() => replayMiningSeekerCoverageEvidence(JSON.stringify(t), f.input)).toThrow();
  });
  it('bounds retained block inventory and metadata rather than truncating', async () => {
    const f = seekerCoverageFixture(); f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 10, signatures: Array.from({ length: MINING_SEEKER_COVERAGE_LIMITS.maxBlockSignatures + 1 }, () => f.input.signature) });
    await expect(f.read()).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const g = seekerCoverageFixture(); g.transaction.meta!.logMessages = ['x'.repeat(MINING_SEEKER_COVERAGE_LIMITS.maxMetadataBytes)];
    await expect(g.read()).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
  it('ends at the one total deadline without starting later RPCs', async () => {
    vi.useFakeTimers(); try { const f = seekerCoverageFixture(); f.reader.getTransaction.mockImplementation(() => new Promise(() => {})); const pending = f.read(); const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); await vi.advanceTimersByTimeAsync(MINING_SEEKER_COVERAGE_LIMITS.timeoutMs); await assertion; expect(f.reader.getSignatureStatuses).not.toHaveBeenCalled(); } finally { vi.useRealTimers(); }
  });
});
