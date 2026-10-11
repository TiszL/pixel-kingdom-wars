import { describe, expect, it, vi } from 'vitest';
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionMessage, type VersionedTransactionResponse } from '@solana/web3.js';
import { getTransferV1InstructionDataSerializer, getUpdateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';
import { readDeedMiningOwnership, type DeedMiningReader } from './deedMiningEvidence';
import { replayDeedOwner } from './deedCloseEvidence';

const key = () => Keypair.generate().publicKey;
const owner = key(), buyer = key(), asset = key(), collection = key(), payer = key();
const core = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
let sequence = 0;
function signature() { const bytes = Buffer.alloc(64, 7); bytes.writeUInt32LE(++sequence); return bs58.encode(bytes); }
function transaction(recipients: PublicKey[], time = 150, slot = 12, data = getTransferV1InstructionDataSerializer().serialize({})): VersionedTransactionResponse {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: key().toBase58(), instructions: recipients.map(recipient => ({ programId: core,
    keys: [asset, collection, payer, owner, recipient].map(pubkey => ({ pubkey, isWritable: false, isSigner: false })), data: Buffer.from(data) })) }).compileToV0Message();
  return { slot, blockTime: time, transaction: { message, signatures: [signature()] }, meta: { err: null, fee: 0, preBalances: [], postBalances: [], innerInstructions: [] } };
}
function fixture(transactions: VersionedTransactionResponse[] = []) {
  const rows = transactions.map(tx => ({ signature: tx.transaction.signatures[0]!, slot: tx.slot, err: tx.meta!.err, blockTime: tx.blockTime, confirmationStatus: 'finalized' as const })).sort((a, b) => b.slot - a.slot);
  const reader = {
    getSlot: vi.fn().mockResolvedValue(20),
    getBlockTime: vi.fn().mockImplementation((slot: number) => Promise.resolve(slot === 10 ? 90 : slot === 20 ? 210 : transactions.find(tx => tx.slot === slot)?.blockTime ?? null)),
    getSignaturesForAddress: vi.fn().mockResolvedValue([...rows, { signature: signature(), slot: 10, err: null, blockTime: 90, confirmationStatus: 'finalized' }]),
    getTransaction: vi.fn().mockImplementation((sig: string) => Promise.resolve(transactions.find(tx => tx.transaction.signatures[0] === sig) ?? null)),
    getBlockSignatures: vi.fn().mockImplementation((slot: number) => Promise.resolve({ signatures: transactions.filter(tx => tx.slot === slot).map(tx => tx.transaction.signatures[0]) })),
  };
  return { reader, read: (override = {}) => readDeedMiningOwnership(reader as unknown as DeedMiningReader, { ...input, ...override }) };
}
const input = { assetId: asset.toBase58(), collection: collection.toBase58(), owner: owner.toBase58(), targetWallet: owner.toBase58(), priorFinalizedSlot: '10', startAt: new Date(100_000), endAt: new Date(200_000) };
const rejects = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ name: 'DeedMiningEvidenceError', code });

describe('continuous mining deed ownership evidence', () => {
  it('proves an unchanged interval from an externally trusted anchor, without a current-owner read', async () => {
    const f = fixture(), result = await f.read();
    expect(result).toMatchObject({ ownerAtStart: input.owner, ownerAtEnd: input.owner, heldContinuously: true, evidence: { anchorTrust: 'external', throughSlot: '20', transactions: [] } });
    expect(f.reader.getSlot).toHaveBeenCalledWith('finalized');
    expect(f.reader.getTransaction).not.toHaveBeenCalled();
  });
  it('establishes the start owner using earlier transfers and excludes the end boundary', async () => {
    const f = fixture([transaction([buyer], 99, 11), transaction([owner], 200, 13)]);
    expect(await f.read({ targetWallet: buyer.toBase58() })).toMatchObject({ ownerAtStart: buyer.toBase58(), ownerAtEnd: buyer.toBase58(), heldContinuously: true });
    expect(await f.read()).toMatchObject({ heldContinuously: false });
  });
  it('counts a transfer exactly at start as an interval transition', async () => {
    expect(await fixture([transaction([buyer], 100)]).read()).toMatchObject({ ownerAtStart: input.owner, ownerAtEnd: buyer.toBase58(), heldContinuously: false });
  });
  it('rejects endpoint equality as continuous ownership after an out-and-back in one transaction', async () => {
    const result = await fixture([transaction([buyer, owner])]).read();
    expect(result).toMatchObject({ ownerAtStart: input.owner, ownerAtEnd: input.owner, heldContinuously: false });
    expect(result.evidence.transactions[0]!.transitions).toEqual([
      { instructionIndex: 0, from: input.owner, to: buyer.toBase58() },
      { instructionIndex: 1, from: buyer.toBase58(), to: input.owner },
    ]);
  });
  it('uses canonical block order despite reversed history rows and catches out-and-back across blocks', async () => {
    const out = transaction([buyer]), back = transaction([owner]);
    const f = fixture([out, back]);
    f.reader.getSignaturesForAddress.mockResolvedValue([
      { signature: back.transaction.signatures[0], slot: 12, err: null, blockTime: 150 },
      { signature: out.transaction.signatures[0], slot: 12, err: null, blockTime: 150 },
      { signature: signature(), slot: 10, err: null, blockTime: 90 },
    ]);
    expect(await f.read()).toMatchObject({ ownerAtEnd: input.owner, heldContinuously: false });
    expect(await fixture([transaction([buyer], 110, 11), transaction([owner], 190, 13)]).read()).toMatchObject({ ownerAtEnd: input.owner, heldContinuously: false });
  });
  it('does not report attempted transfers from a rolled-back transaction or failed replay', async () => {
    const tx = transaction([buyer, owner]); tx.meta!.err = { InstructionError: [1, 'InvalidArgument'] };
    const result = await fixture([tx]).read();
    expect(result.heldContinuously).toBe(true); expect(result.evidence.transactions[0]!.transitions).toEqual([]);
    const good = transaction([buyer]);
    good.transaction.message.compiledInstructions.push({ ...good.transaction.message.compiledInstructions[0]!, data: new Uint8Array([12]) });
    const transitions: Array<{ instructionIndex: number; from: string; to: string }> = [];
    expect(() => replayDeedOwner(good, input.assetId, input.collection, input.owner, transitions)).toThrow();
    expect(transitions).toEqual([]);
  });
  it('allows harmless updates and self-transfers', async () => {
    const metadata = transaction([core], 120, 11, getUpdateV2InstructionDataSerializer().serialize({ newUri: 'https://example.org/deed' }));
    expect((await fixture([metadata, transaction([owner])]).read()).heldContinuously).toBe(true);
  });
  it.each(['burn', 'collection', 'cpi', 'trace'] as const)('refuses unresolved %s ownership evidence', async kind => {
    const tx = transaction([buyer]);
    if (kind === 'burn') tx.transaction.message.compiledInstructions[0]!.data = new Uint8Array([12]);
    if (kind === 'collection') tx.transaction.message.compiledInstructions[0]!.accountKeyIndexes[1] = 0;
    if (kind === 'trace') tx.meta!.innerInstructions = null;
    if (kind === 'cpi') { const ix = tx.transaction.message.compiledInstructions[0]!; tx.meta!.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: ix.programIdIndex, accounts: [...ix.accountKeyIndexes], data: bs58.encode(ix.data) }] }]; }
    await rejects(fixture([tx]).read(), 'UNSUPPORTED_HISTORY');
  });
  it('requires complete finalized history bracketing the entire interval', async () => {
    const missing = fixture(); missing.reader.getSignaturesForAddress.mockResolvedValue([]);
    await rejects(missing.read(), 'HISTORY_INCOMPLETE');
    const start = fixture(); start.reader.getBlockTime.mockResolvedValue(100);
    await rejects(start.read(), 'HORIZON_UNAVAILABLE');
    const end = fixture(); end.reader.getSlot.mockResolvedValue(10);
    await rejects(end.read(), 'HORIZON_UNAVAILABLE');
  });
  it.each(['signature', 'slot', 'time', 'status', 'block', 'duplicate', 'keys'] as const)('rejects contradictory %s evidence', async kind => {
    const tx = transaction([buyer]), f = fixture([tx]);
    if (kind === 'signature') f.reader.getTransaction.mockResolvedValue({ ...tx, transaction: { ...tx.transaction, signatures: [signature()] } });
    if (kind === 'slot') f.reader.getTransaction.mockResolvedValue({ ...tx, slot: 13 });
    if (kind === 'time') f.reader.getBlockTime.mockImplementation((slot: number) => Promise.resolve(slot === 10 ? 90 : slot === 20 ? 210 : 151));
    if (kind === 'status') tx.meta!.err = { InstructionError: [0, 'InvalidArgument'] };
    if (kind === 'block') f.reader.getBlockSignatures.mockResolvedValue({ signatures: [] });
    if (kind === 'duplicate') f.reader.getBlockSignatures.mockResolvedValue({ signatures: [tx.transaction.signatures[0], tx.transaction.signatures[0]] });
    if (kind === 'keys') tx.transaction.message.compiledInstructions[0]!.accountKeyIndexes[0] = 250;
    await rejects(f.read(), 'EVIDENCE_CONFLICT');
  });
  it('rejects missing bodies and transport errors with typed failures', async () => {
    const f = fixture([transaction([buyer])]); f.reader.getTransaction.mockResolvedValue(null);
    await rejects(f.read(), 'HISTORY_INCOMPLETE');
    f.reader.getSlot.mockRejectedValue(new Error('offline'));
    await rejects(f.read(), 'READER_UNAVAILABLE');
  });
  it('resolves v0 lookup-table recipients and refuses missing loaded keys', async () => {
    const tx = transaction([buyer, owner]);
    const table = new AddressLookupTableAccount({ key: key(), state: { deactivationSlot: 18_446_744_073_709_551_615n,
      lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, addresses: [asset, collection, buyer, owner] } });
    const message = TransactionMessage.decompile(tx.transaction.message).compileToV0Message([table]);
    const lookup = message.addressTableLookups[0]!;
    tx.transaction.message = message;
    tx.meta!.loadedAddresses = { writable: lookup.writableIndexes.map(i => table.state.addresses[i]!), readonly: lookup.readonlyIndexes.map(i => table.state.addresses[i]!) };
    expect(await fixture([tx]).read()).toMatchObject({ ownerAtEnd: input.owner, heldContinuously: false });
    delete tx.meta!.loadedAddresses;
    await rejects(fixture([tx]).read(), 'EVIDENCE_CONFLICT');
  });
  it('reaches the anchor on a later page without treating rows beyond the frozen horizon as effects', async () => {
    const f = fixture([transaction([buyer])]);
    const original = await f.reader.getSignaturesForAddress();
    const page = Array.from({ length: 1000 }, () => ({ signature: signature(), slot: 21, err: null, blockTime: 211 }));
    f.reader.getSignaturesForAddress.mockResolvedValueOnce(page).mockResolvedValueOnce(original);
    expect((await f.read()).heldContinuously).toBe(false);
    expect(f.reader.getSignaturesForAddress).toHaveBeenLastCalledWith(asset, { limit: 1000, before: page.at(-1)!.signature }, 'finalized');
    expect(f.reader.getTransaction).toHaveBeenCalledTimes(1);
  });
  it('refuses nonmonotone block times and unfinalized history assertions', async () => {
    await rejects(fixture([transaction([buyer], 170, 11), transaction([owner], 160, 12)]).read(), 'EVIDENCE_CONFLICT');
    const f = fixture();
    f.reader.getSignaturesForAddress.mockResolvedValue([{ signature: signature(), slot: 10, err: null, blockTime: 90, confirmationStatus: 'confirmed' }]);
    await rejects(f.read(), 'EVIDENCE_CONFLICT');
  });
  it('fails closed on duplicate pages, oversized history and noncanonical input', async () => {
    const f = fixture();
    const page = Array.from({ length: 1000 }, () => ({ signature: signature(), slot: 12, err: null, blockTime: 150 }));
    f.reader.getSignaturesForAddress.mockResolvedValue(page);
    await rejects(f.read(), 'EVIDENCE_CONFLICT');
    f.reader.getSignaturesForAddress.mockImplementation(() => Promise.resolve(Array.from({ length: 1000 }, () => ({ signature: signature(), slot: 12, err: null, blockTime: 150 }))));
    await rejects(f.read(), 'TOO_LARGE');
    for (const override of [{ priorFinalizedSlot: '010' }, { assetId: 'bad' }, { targetWallet: 'bad' }, { startAt: new Date(NaN) }, { endAt: new Date(100_000) }]) await rejects(f.read(override), 'INVALID_INPUT');
  });
  it('freezes caller-owned fields and Dates before asynchronous reads', async () => {
    const f = fixture([transaction([buyer])]);
    const request = { ...input, startAt: new Date(+input.startAt), endAt: new Date(+input.endAt) };
    f.reader.getSlot.mockImplementation(async () => {
      request.startAt.setTime(300_000); request.endAt.setTime(400_000);
      request.owner = buyer.toBase58(); request.assetId = buyer.toBase58(); request.targetWallet = buyer.toBase58();
      return 20;
    });
    const result = await readDeedMiningOwnership(f.reader as unknown as DeedMiningReader, request);
    expect(result).toMatchObject({ ownerAtStart: input.owner, heldContinuously: false, evidence: {
      assetId: input.assetId, priorOwner: input.owner, targetWallet: input.targetWallet,
      startAt: input.startAt.toISOString(), endAt: input.endAt.toISOString(),
    } });
  });
  it('refuses oversized encoded identities and malformed reader structures with typed errors', async () => {
    const f = fixture([transaction([buyer])]);
    await rejects(f.read({ assetId: '1'.repeat(100_000) }), 'INVALID_INPUT');
    expect(f.reader.getSlot).not.toHaveBeenCalled();
    f.reader.getSignaturesForAddress.mockResolvedValue([{ signature: '1'.repeat(100_000), slot: 12, err: null }]);
    await rejects(f.read(), 'EVIDENCE_CONFLICT');
    f.reader.getSignaturesForAddress.mockResolvedValue([null]);
    await rejects(f.read(), 'EVIDENCE_CONFLICT');
    const malformed = fixture([transaction([buyer])]);
    malformed.reader.getTransaction.mockResolvedValue({ slot: 12, meta: { err: null } });
    await rejects(malformed.read(), 'EVIDENCE_CONFLICT');
  });
});
