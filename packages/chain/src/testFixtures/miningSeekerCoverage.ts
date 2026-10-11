/** Test-only synthetic archival receipt. SDK signatures are real cryptographic
 * signatures from a deterministic fixture key; no transaction is sent anywhere. */
import { vi, type Mock } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse } from '@solana/web3.js';
import { SEEKER } from '@shardkeep/shared';
import bs58 from 'bs58';
import { MINING_SEEKER_COVERAGE_MEMO_PREFIX, readMiningSeekerCoverageEvidence, type MiningSeekerCoverageReader } from '../miningSeekerCoverage';

export function seekerCoverageFixture(nonceHex = '19'.repeat(32), legacy = false, includeSigner = false) {
  const payer = Keypair.fromSeed(Buffer.alloc(32, 12));
  const instruction = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: includeSigner ? [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }] : [], data: Buffer.from(`${MINING_SEEKER_COVERAGE_MEMO_PREFIX}${nonceHex}`, 'utf8') });
  const builder = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [instruction] });
  const message = legacy ? builder.compileToLegacyMessage() : builder.compileToV0Message();
  const signed = new VersionedTransaction(message); signed.sign([payer]);
  const transaction: VersionedTransactionResponse = { version: message.version, slot: 1, blockTime: 10, transaction: { message, signatures: signed.signatures.map(s => bs58.encode(s)) },
    meta: { err: null, fee: 5000, preBalances: [1000000000, 1], postBalances: [999995000, 1], innerInstructions: [], preTokenBalances: [], postTokenBalances: [], logMessages: ['Synthetic fixture Memo execution'], loadedAddresses: { writable: [], readonly: [] } } };
  const input = { nonceHex, signature: transaction.transaction.signatures[0]! };
  const reader: Record<keyof MiningSeekerCoverageReader, Mock> = {
    getGenesisHash: vi.fn().mockResolvedValue(SEEKER.mainnetGenesisHash), getSlot: vi.fn().mockResolvedValue(30),
    getTransaction: vi.fn().mockImplementation(async (signature: string) => signature === input.signature ? transaction : null),
    getSignatureStatuses: vi.fn().mockImplementation(async () => ({ context: { slot: 30 }, value: [{ slot: transaction.slot, err: null, confirmationStatus: 'finalized', confirmations: null }] })),
    getBlockTime: vi.fn().mockImplementation(async (slot: number) => slot * 10),
    getBlockSignatures: vi.fn().mockImplementation(async (slot: number) => ({ blockTime: slot * 10, signatures: slot === transaction.slot ? [input.signature] : [] })),
  };
  function resign() { const signed = new VersionedTransaction(transaction.transaction.message); signed.sign([payer]); transaction.transaction.signatures = signed.signatures.map(s => bs58.encode(s)); input.signature = transaction.transaction.signatures[0]!; }
  return { payer, instruction, signed, transaction, input, reader, resign, read: () => readMiningSeekerCoverageEvidence(reader as unknown as MiningSeekerCoverageReader, input) };
}
