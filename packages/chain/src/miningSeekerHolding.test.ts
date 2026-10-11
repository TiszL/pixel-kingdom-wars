import { describe, expect, it, vi } from 'vitest';
import { wallet, payer, mint, other, sig, tx, mintBytes, seekerHoldingFixture as fixture, seekerMintBirthFixture as birthFixture } from './testFixtures/miningSeekerHolding';
import { PublicKey, SystemProgram, TransactionInstruction, type ConfirmedSignatureInfo, type CompiledInstruction, type VersionedTransactionResponse } from '@solana/web3.js';
import { AccountState, TOKEN_2022_PROGRAM_ID, createTransferInstruction, createCloseAccountInstruction, createSetAuthorityInstruction, createInitializeMint2Instruction, AuthorityType, TokenInstruction } from '@solana/spl-token';
import { SEEKER } from '@shardkeep/shared';
import bs58 from 'bs58';
import { readMiningSeekerHoldingEvidence, readAgreedMiningSeekerHoldingEvidence, replayMiningSeekerHoldingEvidence, readMiningSeekerMintBirthEvidence, replayMiningSeekerMintBirthEvidence, readAgreedMiningSeekerMintBirthEvidence, type MiningSeekerHoldingReader, MINING_SEEKER_HOLDING_LIMITS } from './miningSeekerHolding';
describe('historical SGT unchanged holding evidence', () => {
  it.each([true, false])('authenticates %s ATA/direct generation from SDK message and raw Token-2022 accounts, replaying immutable evidence without earning authority', async ata => {
    const f = fixture(ata), r = await f.read(); expect(r).toMatchObject({ continuouslyHeld: true, eligibilityAuthorized: false, throughSlot: '30', linkedWallet: wallet.toBase58(), generation: { slot: 10 } });
    expect(replayMiningSeekerHoldingEvidence(r.evidenceJson, f.input)).toEqual(r); expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.generation)).toBe(true);
    expect(f.reader.getMultipleAccountsInfoAndContext).toHaveBeenCalledWith([mint, f.tokenAccount], { commitment: 'finalized', minContextSlot: 30 });
  });
  it.each(['wallet', 'mint', 'amount', 'issuer', 'pointer', 'group', 'memberMint', 'program', 'uninitialized'] as const)('refuses a %s look-alike instead of asserting zero or ownership', async kind => {
    const f = fixture();
    if (kind === 'wallet') other.toBuffer().copy(f.accounts[1]!.data, 32);
    if (kind === 'mint') other.toBuffer().copy(f.accounts[1]!.data);
    if (kind === 'amount') f.accounts[1]!.data.writeBigUInt64LE(2n, 64);
    if (kind === 'issuer') other.toBuffer().copy(f.accounts[0]!.data, 4);
    if (kind === 'pointer') other.toBuffer().copy(f.accounts[0]!.data, 170);
    if (kind === 'group') other.toBuffer().copy(f.accounts[0]!.data, 270);
    if (kind === 'memberMint') other.toBuffer().copy(f.accounts[0]!.data, 238);
    if (kind === 'program') f.accounts[0]!.owner = SystemProgram.programId;
    if (kind === 'uninitialized') f.accounts[0]!.data[45] = 0;
    await expect(f.read()).rejects.toMatchObject({ code: 'ACCOUNT_INVALID' });
  });
  it.each([15, 20, 25, 30])('rejects a writable token reference at start, during, end or sampled bank (slot %s)', async slot => {
    const f = fixture(); f.txs.push(tx([createTransferInstruction(f.tokenAccount, other, wallet, 1n, [], TOKEN_2022_PROGRAM_ID)], slot));
    await expect(f.read()).rejects.toMatchObject({ code: 'HOLDING_CHANGED' });
  });
  it('refuses transfer out/back even when the current account again holds the original one token', async () => {
    const f = fixture(); f.txs.push(tx([createTransferInstruction(f.tokenAccount, other, wallet, 1n, [], TOKEN_2022_PROGRAM_ID)], 20), tx([createTransferInstruction(other, f.tokenAccount, wallet, 1n, [], TOKEN_2022_PROGRAM_ID)], 21));
    await expect(f.read()).rejects.toMatchObject({ code: 'HOLDING_CHANGED' });
  });
  it('scans the mint too: issuer/group mutation cannot be hidden by an unchanged token-account history', async () => {
    const f = fixture(); f.txs.push(tx([createSetAuthorityInstruction(mint, new PublicKey(SEEKER.sgt.mintAuthority), AuthorityType.MintTokens, other, [], TOKEN_2022_PROGRAM_ID)], 20));
    await expect(f.read()).rejects.toMatchObject({ code: 'HOLDING_CHANGED' });
  });
  it('allows finalized failed writes and read-only references because they cannot change the successful account state', async () => {
    const f = fixture(), failed = tx([createTransferInstruction(f.tokenAccount, other, wallet, 1n, [], TOKEN_2022_PROGRAM_ID)], 20); failed.meta!.err = { InstructionError: [0, 'InvalidArgument'] }; f.txs.push(failed);
    f.txs.push(tx([new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: f.tokenAccount, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false }], data: Buffer.alloc(0) })], 21));
    expect((await f.read()).continuouslyHeld).toBe(true);
  });
  it.each(['close-reinitialize', 'owner', 'createOwner', 'prebalance', 'missingTrace', 'nestedTrace', 'wrongOuter', 'creationAtStart'] as const)('refuses unauthenticated/recycled ATA generation: %s', async kind => {
    const f = fixture(), group = f.creation.meta!.innerInstructions![0]!;
    if (kind === 'close-reinitialize') { const close = createCloseAccountInstruction(f.tokenAccount, payer, wallet, [], TOKEN_2022_PROGRAM_ID), keys = f.creation.transaction.message.staticAccountKeys; group.instructions.splice(2, 0, { programIdIndex: keys.findIndex(k => k.equals(close.programId)), accounts: close.keys.map(k => keys.findIndex(x => x.equals(k.pubkey))), data: bs58.encode(close.data), stackHeight: 2 } as CompiledInstruction & { stackHeight: number }); }
    if (kind === 'owner') group.instructions[3]!.data = bs58.encode(Buffer.concat([Buffer.of(TokenInstruction.InitializeAccount3), other.toBuffer()]));
    if (kind === 'createOwner') { const data = bs58.decode(group.instructions[1]!.data); other.toBuffer().copy(data, 20); group.instructions[1]!.data = bs58.encode(data); }
    if (kind === 'prebalance') { const index = f.creation.transaction.message.staticAccountKeys.findIndex(k => k.equals(f.tokenAccount)); f.creation.meta!.preBalances[index] = 1; }
    if (kind === 'missingTrace') f.creation.meta!.innerInstructions = null;
    if (kind === 'nestedTrace') (group.instructions[3]! as CompiledInstruction & { stackHeight: number }).stackHeight = 3;
    if (kind === 'wrongOuter') f.creation.transaction.message.compiledInstructions[0]!.programIdIndex = f.creation.transaction.message.staticAccountKeys.findIndex(k => k.equals(SystemProgram.programId));
    if (kind === 'creationAtStart') f.input.startAt = new Date(100000);
    await expect(f.read()).rejects.toBeInstanceOf(Error);
  });
  it.each(['body', 'mintIndex', 'tokenIndex', 'blockBody', 'emptyIndex', 'finality', 'signature', 'order', 'time', 'genesis', 'context', 'unclosed'] as const)('refuses unavailable or contradictory archive evidence: %s', async kind => {
    const f = fixture();
    if (kind === 'body') f.reader.getTransaction.mockResolvedValue(null);
    if (kind === 'mintIndex' || kind === 'tokenIndex' || kind === 'emptyIndex') { const original = f.reader.getSignaturesForAddress.getMockImplementation()!; f.reader.getSignaturesForAddress.mockImplementation(async a => kind === 'emptyIndex' || a.toBase58() === (kind === 'mintIndex' ? f.input.mint : f.input.tokenAccount) ? [] : original(a)); }
    if (kind === 'blockBody') f.reader.getBlockSignatures.mockImplementation(async slot => ({ blockTime: slot * 10, signatures: [f.creation.transaction.signatures[0]!, sig()] }));
    if (kind === 'finality') { const original = f.reader.getSignaturesForAddress.getMockImplementation()!; f.reader.getSignaturesForAddress.mockImplementation(async a => (await original(a)).map((r: ConfirmedSignatureInfo) => ({ ...r, confirmationStatus: 'confirmed' as 'finalized' }))); }
    if (kind === 'signature') f.reader.getTransaction.mockResolvedValue({ ...f.creation, transaction: { ...f.creation.transaction, signatures: [sig()] } });
    if (kind === 'order') f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 100, signatures: [] });
    if (kind === 'time') f.reader.getBlockTime.mockResolvedValue(300);
    if (kind === 'genesis') f.reader.getGenesisHash.mockResolvedValueOnce(SEEKER.mainnetGenesisHash).mockResolvedValue(other.toBase58());
    if (kind === 'context') f.reader.getSlot.mockResolvedValueOnce(30).mockResolvedValue(29);
    if (kind === 'unclosed') f.input.endAt = new Date(301000);
    await expect(f.read()).rejects.toBeInstanceOf(Error);
  });
  it('requires every body in the creation block, and detects an omitted same-block token mutation', async () => {
    const f = fixture(), omitted = tx([createCloseAccountInstruction(f.tokenAccount, payer, wallet, [], TOKEN_2022_PROGRAM_ID)], 10);
    f.reader.getBlockSignatures.mockResolvedValue({ blockTime: 100, signatures: [f.creation.transaction.signatures[0]!, omitted.transaction.signatures[0]!] });
    f.reader.getTransaction.mockImplementation(async s => s === omitted.transaction.signatures[0] ? omitted : f.creation);
    await expect(f.read()).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
  });
  it('bounds exhaustive pagination and fails instead of presenting a truncated page as a proof', async () => {
    const f = fixture(); f.reader.getSignaturesForAddress.mockImplementation(async () => Array.from({ length: 1000 }, () => ({ signature: sig(), slot: 31, blockTime: 310, err: null, confirmationStatus: 'finalized' as const })));
    await expect(f.read()).rejects.toMatchObject({ code: 'TOO_LARGE' }); expect(f.reader.getTransaction).not.toHaveBeenCalled();
  });
  it('copies observed bytes before subsequent RPC callbacks can mutate them', async () => {
    const f = fixture(); f.reader.getBlockTime.mockImplementation(async slot => { f.accounts[1]!.data.writeBigUInt64LE(0n, 64); return slot * 10; });
    expect((await f.read()).continuouslyHeld).toBe(true);
  });
  it('uses copied full-page length and cursor even when later RPC callbacks reuse the provider page', async () => {
    const f = fixture();
    const last = { signature: f.creation.transaction.signatures[0]!, slot: 10, blockTime: 100, err: null, confirmationStatus: 'finalized' as const };
    const page = [...Array.from({ length: 999 }, () => ({ signature: sig(), slot: 31, blockTime: 310, err: null, confirmationStatus: 'finalized' as const })), last];
    let mintReads = 0;
    f.reader.getSignaturesForAddress.mockImplementation(async address => address.equals(mint) ? (++mintReads === 1 ? page : []) : [last]);
    f.reader.getTransaction.mockImplementation(async () => { page.splice(0); return f.creation; });
    expect((await f.read()).continuouslyHeld).toBe(true);
    expect(f.reader.getSignaturesForAddress).toHaveBeenNthCalledWith(2, mint, { limit: 1000, minContextSlot: 30, before: last.signature }, 'finalized');
  });
  it('replay rejects retargeted or altered source evidence', async () => {
    const f = fixture(), r = await f.read(); expect(() => replayMiningSeekerHoldingEvidence(r.evidenceJson, { ...f.input, linkedWallet: other.toBase58() })).toThrow();
    const t = JSON.parse(r.evidenceJson); t.histories[0].pages[0] = [];
    expect(() => replayMiningSeekerHoldingEvidence(JSON.stringify(t), f.input)).toThrow();
  });
  it('has one bounded total time budget and does not start more calls after it expires', async () => {
    vi.useFakeTimers(); try { const f = fixture(); f.reader.getGenesisHash.mockImplementation(() => new Promise(() => {})); const pending = f.read(); const expectation = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' }); await vi.advanceTimersByTimeAsync(MINING_SEEKER_HOLDING_LIMITS.timeoutMs); await expectation; expect(f.reader.getSlot).not.toHaveBeenCalled(); } finally { vi.useRealTimers(); }
  });
  it('requires two successful independent provider proofs and refuses contradictory bytes or generation', async () => {
    const a = fixture(), b = fixture(); b.txs[0]!.transaction.signatures = [...a.txs[0]!.transaction.signatures];
    const sources = [a.reader, b.reader] as unknown as [MiningSeekerHoldingReader, MiningSeekerHoldingReader];
    expect((await readAgreedMiningSeekerHoldingEvidence(sources, a.input)).sources).toBe(2);
    b.accounts[1]!.data[108] = AccountState.Frozen;
    await expect(readAgreedMiningSeekerHoldingEvidence(sources, a.input)).rejects.toMatchObject({ code: 'SOURCE_DISAGREEMENT' });
    b.accounts[1]!.data[108] = AccountState.Initialized; b.txs[0]!.transaction.signatures = [sig()];
    await expect(readAgreedMiningSeekerHoldingEvidence(sources, a.input)).rejects.toMatchObject({ code: 'SOURCE_DISAGREEMENT' });
    b.reader.getTransaction.mockResolvedValue(null);
    await expect(readAgreedMiningSeekerHoldingEvidence(sources, a.input)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
  });
  it.each(['duplicateTlv', 'malformedTlv', 'invalidState', 'optionLookalike'] as const)('rejects malformed Token-2022 bytes: %s', async kind => {
    const f = fixture();
    if (kind === 'duplicateTlv') f.accounts[0]!.data = Buffer.concat([f.accounts[0]!.data, f.accounts[0]!.data.subarray(166, 234)]);
    if (kind === 'malformedTlv') f.accounts[0]!.data.writeUInt16LE(600, 168);
    if (kind === 'invalidState') f.accounts[1]!.data[108] = 3;
    if (kind === 'optionLookalike') f.accounts[0]!.data.writeUInt32LE(2, 0);
    await expect(f.read()).rejects.toMatchObject({ code: 'ACCOUNT_INVALID' });
  });

});

describe('historical SGT original mint birth after the coverage floor', () => {
  it.each([false, true])('authenticates SDK InitializeMint2/InitializeMint %s birth independently of a later ATA', async legacyInit => {
    const f = birthFixture(legacyInit), proof = await f.readBirth();
    expect(proof.mintBirth).toEqual({ signature: f.birth.transaction.signatures[0], slot: 5, blockTime: 50, transactionIndex: 0, createInstructionIndex: 0, initializeInstructionIndex: 2 });
    expect(proof.generation.slot).toBe(10); expect(proof.eligibilityAuthorized).toBe(false); expect(proof.coverageFloorMs).toBe(40000);
    expect(Object.isFrozen(proof.mintBirth)).toBe(true); expect(replayMiningSeekerMintBirthEvidence(proof.evidenceJson, f.input)).toEqual(proof);
    expect(replayMiningSeekerHoldingEvidence(proof.evidenceJson, { linkedWallet: f.input.linkedWallet, mint: f.input.mint, tokenAccount: f.input.tokenAccount, startAt: f.input.startAt, endAt: f.input.endAt }).generation).toEqual(proof.generation);
  });
  it('does not promote a valid original v1 holding proof into mint birth merely because the ATA was newly created', async () => {
    const f = fixture(), proof = await f.read();
    expect(proof.generation.slot).toBe(10);
    expect(() => replayMiningSeekerMintBirthEvidence(proof.evidenceJson, { ...f.input, coverageFloor: new Date(40000) })).toThrow();
    await expect(readMiningSeekerMintBirthEvidence(f.reader as unknown as MiningSeekerHoldingReader, { ...f.input, coverageFloor: new Date(40000) })).rejects.toBeInstanceOf(Error);
  });
  it.each([50000, 50001, 60000])('rejects an old mint despite new ATA when birth is not strictly after coverage %s', async floor => {
    const f = birthFixture(); f.input.coverageFloor = new Date(floor);
    await expect(f.readBirth()).rejects.toMatchObject({ code: 'BIRTH_OUTSIDE_COVERAGE' });
  });
  it('accepts a birth strictly after the exact caller floor, never floors timestamps or treats zero as unknown birth', async () => {
    const f = birthFixture(); f.input.coverageFloor = new Date(49999); expect((await f.readBirth()).mintBirth.blockTime).toBe(50);
    f.birth.slot = 0; f.birth.blockTime = 0; f.input.coverageFloor = new Date(0);
    await expect(f.readBirth()).rejects.toMatchObject({ code: 'BIRTH_OUTSIDE_COVERAGE' });
  });
  it.each(['priorRead', 'priorCreation', 'priorFailedCreation', 'priorGeneration'] as const)('treats original complete history correctly: %s', async kind => {
    const f = birthFixture();
    let earlier: VersionedTransactionResponse;
    if (kind === 'priorRead') earlier = tx([new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: mint, isSigner: false, isWritable: false }], data: Buffer.alloc(0) })], 3);
    else earlier = tx(kind === 'priorGeneration' ? [f.create, f.initialize] : [f.create], 3);
    if (kind === 'priorFailedCreation') earlier.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    if (kind === 'priorGeneration') f.input.coverageFloor = new Date(20000);
    f.txs.unshift(earlier);
    if (kind === 'priorFailedCreation') expect((await f.readBirth()).mintBirth.slot).toBe(5);
    else await expect(f.readBirth()).rejects.toMatchObject({ code: 'UNSUPPORTED_HISTORY' });
  });
  it.each(['extraInit', 'sameTxClose', 'laterClose', 'laterInit', 'wrongAuthority', 'wrongDecimals', 'wrongProgram', 'prebalance', 'unsignedMint', 'wrongRent', 'trailingInit', 'trailingCreate', 'initBeforeCreate', 'cpiInit', 'cpiCreate'] as const)('rejects unsupported original mint generation/reuse: %s', async kind => {
    const f = birthFixture(kind === 'wrongRent');
    if (kind === 'extraInit') f.txs[0] = tx([f.create, f.initialize, f.initialize], 5);
    if (kind === 'sameTxClose') f.txs[0] = tx([f.create, f.initialize, createCloseAccountInstruction(mint, payer, payer, [], TOKEN_2022_PROGRAM_ID)], 5);
    if (kind === 'laterClose') f.txs.push(tx([createCloseAccountInstruction(mint, payer, payer, [], TOKEN_2022_PROGRAM_ID)], 12));
    if (kind === 'laterInit') f.txs.push(tx([f.initialize], 12));
    if (kind === 'wrongAuthority') f.txs[0] = tx([f.create, createInitializeMint2Instruction(mint, 0, other, null, TOKEN_2022_PROGRAM_ID)], 5);
    if (kind === 'wrongDecimals') f.txs[0] = tx([f.create, createInitializeMint2Instruction(mint, 1, new PublicKey(SEEKER.sgt.mintAuthority), null, TOKEN_2022_PROGRAM_ID)], 5);
    if (kind === 'wrongProgram') f.txs[0] = tx([SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports: 2000000, space: 334, programId: SystemProgram.programId }), f.initialize], 5);
    if (kind === 'prebalance') { const i = f.birth.transaction.message.staticAccountKeys.findIndex(k => k.equals(mint)); f.birth.meta!.preBalances[i] = 1; }
    if (kind === 'unsignedMint') { f.create.keys[1]!.isSigner = false; f.txs[0] = tx([f.create, f.initialize], 5); }
    if (kind === 'wrongRent') { f.initialize.keys[1]!.pubkey = other; f.txs[0] = tx([f.create, f.initialize], 5); }
    if (kind === 'trailingInit') { f.initialize.data = Buffer.concat([f.initialize.data, Buffer.of(0)]); f.txs[0] = tx([f.create, f.initialize], 5); }
    if (kind === 'trailingCreate') { f.create.data = Buffer.concat([f.create.data, Buffer.of(0)]); f.txs[0] = tx([f.create, f.initialize], 5); }
    if (kind === 'initBeforeCreate') f.txs[0] = tx([f.initialize, f.create], 5);
    if (kind === 'cpiInit' || kind === 'cpiCreate') {
      const instruction = kind === 'cpiInit' ? f.initialize : f.create;
      const keys = f.birth.transaction.message.staticAccountKeys;
      f.birth.meta!.innerInstructions = [{ index: 1, instructions: [{ programIdIndex: keys.findIndex(k => k.equals(instruction.programId)), accounts: instruction.keys.map(k => keys.findIndex(x => x.equals(k.pubkey))), data: bs58.encode(instruction.data) }] }];
    }
    await expect(f.readBirth()).rejects.toBeInstanceOf(Error);
  });
  it('requires all mint-birth block bodies and detects a same-block address-index omission', async () => {
    const f = birthFixture(), omitted = tx([createCloseAccountInstruction(mint, payer, payer, [], TOKEN_2022_PROGRAM_ID)], 5);
    const block = f.reader.getBlockSignatures.getMockImplementation()!, body = f.reader.getTransaction.getMockImplementation()!;
    f.reader.getBlockSignatures.mockImplementation(async slot => slot === 5 ? { blockTime: 50, signatures: [f.birth.transaction.signatures[0]!, omitted.transaction.signatures[0]!] } : block(slot));
    await expect(f.readBirth()).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
    f.reader.getTransaction.mockImplementation(async signature => signature === omitted.transaction.signatures[0] ? omitted : body(signature));
    await expect(f.readBirth()).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
  });
  it('replay refuses a birth proof whose full creation-block inventory was pruned from the retained transcript', async () => {
    const f = birthFixture(), unrelated = tx([SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 1 })], 5); f.txs.push(unrelated);
    const proof = await f.readBirth(), evidence = JSON.parse(proof.evidenceJson); evidence.bodies = evidence.bodies.filter((b: { signature: string }) => b.signature !== unrelated.transaction.signatures[0]);
    expect(() => replayMiningSeekerMintBirthEvidence(JSON.stringify(evidence), f.input)).toThrow();
  });
  it('requires independent providers to agree on original mint birth, even when holding generation is identical', async () => {
    const a = birthFixture(), b = birthFixture();
    b.txs[0]!.transaction.signatures = [...a.txs[0]!.transaction.signatures]; b.creation.transaction.signatures = [...a.creation.transaction.signatures]; b.txs[2]!.transaction.signatures = [...a.txs[2]!.transaction.signatures];
    const sources = [a.reader, b.reader] as unknown as [MiningSeekerHoldingReader, MiningSeekerHoldingReader];
    expect((await readAgreedMiningSeekerMintBirthEvidence(sources, a.input)).eligibilityAuthorized).toBe(false);
    b.txs[0]!.transaction.signatures = Array.from({ length: b.txs[0]!.transaction.message.header.numRequiredSignatures }, sig);
    await expect(readAgreedMiningSeekerMintBirthEvidence(sources, a.input)).rejects.toMatchObject({ code: 'SOURCE_DISAGREEMENT' });
  });
  it('copies the caller coverage floor before awaiting archival reads', async () => {
    const f = birthFixture(); f.reader.getGenesisHash.mockImplementation(async () => { f.input.coverageFloor.setTime(140000); return SEEKER.mainnetGenesisHash; });
    expect((await f.readBirth()).coverageFloorMs).toBe(40000);
  });
  it.each([new Date(NaN), new Date(-1), new Date(150000)])('refuses an invalid or nonprior coverage floor %s', async floor => {
    const f = birthFixture(); f.input.coverageFloor = floor; await expect(f.readBirth()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
