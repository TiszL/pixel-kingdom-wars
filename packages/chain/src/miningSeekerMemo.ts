/** Internal strict finalized Memo codec shared by fixed coverage/enrollment
 * domains. Retained transcripts keep their original bytes; the signed message
 * binds the purpose. Replay alone does not authenticate RPC execution facts. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { PublicKey, VersionedMessage, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { SEEKER } from '@shardkeep/shared';
import bs58 from 'bs58';

const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export type MiningSeekerMemoReader = Pick<Connection, 'getGenesisHash' | 'getSlot' | 'getTransaction' | 'getSignatureStatuses' | 'getBlockTime' | 'getBlockSignatures'>;
export type MiningSeekerMemoSource = MiningSeekerMemoReader | ((signal: AbortSignal) => MiningSeekerMemoReader);
export interface MiningSeekerMemoInput { nonceHex: string; signature: string }
/** Operational limits, not game policy. No call retries or truncated evidence. */
export const MINING_SEEKER_MEMO_LIMITS = Object.freeze({ timeoutMs: 10000, maxCalls: 8, maxMessageBytes: 1232, maxMetadataBytes: 65536, maxBlockSignatures: 50000, maxEvidenceBytes: 8 * 1024 * 1024 });
export type MiningSeekerMemoErrorCode = 'INVALID_INPUT' | 'GENESIS_MISMATCH' | 'CONTEXT_INVALID' | 'HISTORY_INCOMPLETE' | 'TRANSACTION_INVALID' | 'SIGNATURE_INVALID' | 'MEMO_INVALID' | 'EVIDENCE_CONFLICT' | 'SOURCE_DISAGREEMENT' | 'TOO_LARGE' | 'TIMEOUT' | 'READER_UNAVAILABLE';
export type MiningSeekerMemoError = Error & { readonly code: MiningSeekerMemoErrorCode };
type WitnessErrorConstructor = new (code: MiningSeekerMemoErrorCode) => MiningSeekerMemoError;

/** Internal fixed-domain factory. Public readers expose no domain override. */
export function createMiningSeekerMemoWitness(
  prefix: 'SHARDKEEP:MINING:SEEKER:COVERAGE:v1:' | 'SHARDKEEP:MINING:SEEKER:ENROLLMENT:v1:',
  WitnessError: WitnessErrorConstructor,
) {
  function fail(code: MiningSeekerMemoErrorCode): never { throw new WitnessError(code); }
  const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  function signature(value: unknown): value is string { try { return typeof value === 'string' && value.length <= 88 && bs58.decode(value).length === 64 && bs58.encode(bs58.decode(value)) === value; } catch { return false; } }
  function facts(input: MiningSeekerMemoInput) {
    if (!input || Object.keys(input).sort().join(',') !== 'nonceHex,signature' || typeof input.nonceHex !== 'string' || !/^[0-9a-f]{64}$/.test(input.nonceHex) || !signature(input.signature)) fail('INVALID_INPUT');
    return { nonceHex: input.nonceHex, signature: input.signature };
  }
  interface TransactionWire { slot: number; blockTime: number; version: 'legacy' | 0; messageBase64: string; signatures: string[]; metadataJson: string }
  interface WitnessTranscript {
    version: 1; input: MiningSeekerMemoInput; genesisBefore: string; genesisAfter: string; finalizedBefore: number; finalizedAfter: number;
    status: { contextSlot: number; slot: number; confirmationStatus: string; confirmations: number | null; err: unknown };
    block: { slot: number; blockTime: number; signatures: string[] };
    transaction: TransactionWire;
  }
  function transactionWire(tx: VersionedTransactionResponse | null): TransactionWire {
    if (!tx) fail('HISTORY_INCOMPLETE');
    if (!tx.meta || !integer(tx.slot) || !integer(tx.blockTime) || (tx.version !== undefined && tx.version !== 0 && tx.version !== 'legacy')) fail('TRANSACTION_INVALID');
    const message = tx.transaction?.message;
    if (!message || !Array.isArray(message.staticAccountKeys) || message.staticAccountKeys.length !== 2 || !Array.isArray(tx.transaction.signatures) || tx.transaction.signatures.length !== 1) fail('TRANSACTION_INVALID');
    if ((tx.version !== undefined && tx.version !== message.version) || typeof message.recentBlockhash !== 'string' || message.recentBlockhash.length > 44) fail('TRANSACTION_INVALID');
    // Bound raw legacy fields before getters decode base58 or serialize buffers.
    if (message.version === 'legacy' && (!Array.isArray(message.instructions) || message.instructions.length !== 1 || typeof message.instructions[0]?.data !== 'string' || message.instructions[0].data.length > 2048 || !Array.isArray(message.instructions[0].accounts) || message.instructions[0].accounts.length > 1)) fail('TRANSACTION_INVALID');
    if (message.version === 0 && (!Array.isArray(message.compiledInstructions) || message.compiledInstructions.length !== 1 || message.compiledInstructions[0]!.data.length > MINING_SEEKER_MEMO_LIMITS.maxMessageBytes || !Array.isArray(message.compiledInstructions[0]!.accountKeyIndexes) || message.compiledInstructions[0]!.accountKeyIndexes.length > 1 || message.addressTableLookups.length !== 0)) fail('TRANSACTION_INVALID');
    const encoded = Buffer.from(message.serialize()); if (encoded.length > MINING_SEEKER_MEMO_LIMITS.maxMessageBytes) fail('TOO_LARGE');
    const metadataJson = JSON.stringify(tx.meta); if (Buffer.byteLength(metadataJson) > MINING_SEEKER_MEMO_LIMITS.maxMetadataBytes) fail('TOO_LARGE');
    return { slot: tx.slot, blockTime: tx.blockTime, version: message.version, messageBase64: encoded.toString('base64'), signatures: [...tx.transaction.signatures], metadataJson };
  }
  function signedMemo(wire: TransactionWire, expected: MiningSeekerMemoInput) {
    if (!wire || !integer(wire.slot) || !integer(wire.blockTime) || !Number.isSafeInteger(wire.blockTime * 1000) || !['legacy', 0].includes(wire.version)
      || !Array.isArray(wire.signatures) || wire.signatures.length !== 1 || wire.signatures[0] !== expected.signature || !signature(wire.signatures[0])) fail('TRANSACTION_INVALID');
    if (typeof wire.messageBase64 !== 'string' || wire.messageBase64.length > Math.ceil(MINING_SEEKER_MEMO_LIMITS.maxMessageBytes / 3) * 4 || typeof wire.metadataJson !== 'string' || Buffer.byteLength(wire.metadataJson) > MINING_SEEKER_MEMO_LIMITS.maxMetadataBytes) fail('TOO_LARGE');
    const bytes = Buffer.from(wire.messageBase64, 'base64'); if (bytes.toString('base64') !== wire.messageBase64 || bytes.length > MINING_SEEKER_MEMO_LIMITS.maxMessageBytes) fail('TRANSACTION_INVALID');
    const message = VersionedMessage.deserialize(bytes);
    if (message.version !== wire.version || !Buffer.from(message.serialize()).equals(bytes) || message.staticAccountKeys.length !== 2 || message.header.numRequiredSignatures !== 1
      || message.header.numReadonlySignedAccounts !== 0 || message.header.numReadonlyUnsignedAccounts !== 1 || (message.version === 0 && message.addressTableLookups.length !== 0)) fail('TRANSACTION_INVALID');
    const payer = message.staticAccountKeys[0]!;
    if (payer.equals(MEMO) || !message.staticAccountKeys[1]!.equals(MEMO) || message.compiledInstructions.length !== 1) fail('MEMO_INVALID');
    const memo = message.compiledInstructions[0]!;
    if (memo.programIdIndex !== 1 || !(memo.accountKeyIndexes.length === 0 || (memo.accountKeyIndexes.length === 1 && memo.accountKeyIndexes[0] === 0))
      || !Buffer.from(memo.data).equals(Buffer.from(`${prefix}${expected.nonceHex}`, 'utf8'))) fail('MEMO_INVALID');
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), payer.toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null, bytes, publicKey, bs58.decode(expected.signature))) fail('SIGNATURE_INVALID');
    const meta = JSON.parse(wire.metadataJson) as Record<string, unknown>;
    if (!meta || meta.err !== null || !integer(meta.fee) || !Array.isArray(meta.innerInstructions) || meta.innerInstructions.length !== 0
      || !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) || meta.preBalances.length !== 2 || meta.postBalances.length !== 2
      || !meta.preBalances.every(integer) || !meta.postBalances.every(integer) || meta.preBalances[0]! - meta.postBalances[0]! !== meta.fee || meta.preBalances[1] !== meta.postBalances[1]) fail('TRANSACTION_INVALID');
    if (meta.loadedAddresses != null) {
      const loaded = meta.loadedAddresses as { writable?: unknown; readonly?: unknown };
      if (!Array.isArray(loaded.writable) || loaded.writable.length !== 0 || !Array.isArray(loaded.readonly) || loaded.readonly.length !== 0) fail('TRANSACTION_INVALID');
    }
    for (const name of ['preTokenBalances', 'postTokenBalances']) if (meta[name] != null && (!Array.isArray(meta[name]) || (meta[name] as unknown[]).length !== 0)) fail('TRANSACTION_INVALID');
    return { payer: payer.toBase58(), messageSha256: createHash('sha256').update(bytes).digest('hex') };
  }

  /** Consistency/cryptographic replay does not authenticate fabricated execution
   * metadata. Only configured archival sources and integrity-protected evidence
   * storage may supply this transcript; database nonce provenance is separate. */
  function replayMiningSeekerMemoEvidence(evidenceJson: string, input: MiningSeekerMemoInput) {
    const expected = facts(input);
    if (typeof evidenceJson !== 'string' || Buffer.byteLength(evidenceJson) > MINING_SEEKER_MEMO_LIMITS.maxEvidenceBytes) fail('TOO_LARGE');
    try {
      const t = JSON.parse(evidenceJson) as WitnessTranscript;
      if (t.version !== 1 || JSON.stringify(t.input) !== JSON.stringify(expected)) fail('EVIDENCE_CONFLICT');
      if (t.genesisBefore !== SEEKER.mainnetGenesisHash || t.genesisAfter !== t.genesisBefore) fail('GENESIS_MISMATCH');
      const verified = signedMemo(t.transaction, expected), at = t.transaction.slot;
      if (!integer(t.finalizedBefore) || !integer(t.finalizedAfter) || t.finalizedBefore < at || t.finalizedAfter < t.finalizedBefore) fail('CONTEXT_INVALID');
      if (!t.status || !integer(t.status.contextSlot) || t.status.contextSlot < t.finalizedBefore || t.status.slot !== at || t.status.confirmationStatus !== 'finalized' || t.status.confirmations !== null || t.status.err !== null) fail('CONTEXT_INVALID');
      const block = t.block;
      if (!block || block.slot !== at || block.blockTime !== t.transaction.blockTime || !Array.isArray(block.signatures)) fail('EVIDENCE_CONFLICT');
      if (block.signatures.length > MINING_SEEKER_MEMO_LIMITS.maxBlockSignatures) fail('TOO_LARGE');
      if (!block.signatures.every(signature) || new Set(block.signatures).size !== block.signatures.length || !block.signatures.includes(expected.signature)) fail('EVIDENCE_CONFLICT');
      return Object.freeze({ nonceHex: expected.nonceHex, signature: expected.signature, slot: at, blockTime: t.transaction.blockTime, genesisHash: t.genesisBefore, ...verified,
        eligibilityAuthorized: false as const, trust: 'trusted-finalized-rpc' as const, evidenceJson });
    } catch (error) { if (error instanceof WitnessError) throw error; return fail('EVIDENCE_CONFLICT'); }
  }

  async function readMiningSeekerMemoEvidence(source: MiningSeekerMemoSource, input: MiningSeekerMemoInput) {
    const expected = facts(input), controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, calls = 0;
    const run = async () => {
      const reader = typeof source === 'function' ? source(controller.signal) : source;
      const read = async <T>(fn: () => Promise<T>): Promise<T> => {
        controller.signal.throwIfAborted(); if (++calls > MINING_SEEKER_MEMO_LIMITS.maxCalls) fail('TOO_LARGE');
        try { const result = await fn(); controller.signal.throwIfAborted(); return result; } catch (error) { if (error instanceof WitnessError) throw error; return fail('READER_UNAVAILABLE'); }
      };
      const genesisBefore = await read(() => reader.getGenesisHash()); if (genesisBefore !== SEEKER.mainnetGenesisHash) fail('GENESIS_MISMATCH');
      const finalizedBefore = await read(() => reader.getSlot('finalized')); if (!integer(finalizedBefore)) fail('CONTEXT_INVALID');
      const transaction = transactionWire(await read(() => reader.getTransaction(expected.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })));
      signedMemo(transaction, expected);
      const statuses = await read(() => reader.getSignatureStatuses([expected.signature], { searchTransactionHistory: true }));
      if (!statuses || !integer(statuses.context?.slot) || !Array.isArray(statuses.value) || statuses.value.length !== 1 || !statuses.value[0]) fail('HISTORY_INCOMPLETE');
      const status = { contextSlot: statuses.context.slot, slot: statuses.value[0].slot, confirmationStatus: statuses.value[0].confirmationStatus ?? '', confirmations: statuses.value[0].confirmations, err: structuredClone(statuses.value[0].err) };
      const blockTime = await read(() => reader.getBlockTime(transaction.slot)); if (!integer(blockTime)) fail('HISTORY_INCOMPLETE');
      const order = await read(() => reader.getBlockSignatures(transaction.slot, 'finalized'));
      if (!order || !Array.isArray(order.signatures) || (order.blockTime != null && order.blockTime !== blockTime)) fail('EVIDENCE_CONFLICT');
      if (order.signatures.length > MINING_SEEKER_MEMO_LIMITS.maxBlockSignatures) fail('TOO_LARGE');
      const block = { slot: transaction.slot, blockTime, signatures: [...order.signatures] };
      const finalizedAfter = await read(() => reader.getSlot('finalized')), genesisAfter = await read(() => reader.getGenesisHash());
      const transcript: WitnessTranscript = { version: 1, input: expected, genesisBefore, genesisAfter, finalizedBefore, finalizedAfter, status, block, transaction };
      return replayMiningSeekerMemoEvidence(JSON.stringify(transcript), expected);
    };
    try { return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => { const error = new WitnessError('TIMEOUT'); controller.abort(error); reject(error); }, MINING_SEEKER_MEMO_LIMITS.timeoutMs); })]); }
    catch (error) { if (error instanceof WitnessError) throw error; return fail('READER_UNAVAILABLE'); }
    finally { clearTimeout(timer); controller.abort(); }
  }

  /** Independence comes from server configuration, not a client label. Both
   * providers must succeed; no single-source fallback or negative inference. */
  async function readAgreedMiningSeekerMemoEvidence(sources: readonly [MiningSeekerMemoSource, MiningSeekerMemoSource], input: MiningSeekerMemoInput) {
    if (!Array.isArray(sources) || sources.length !== 2 || sources[0] === sources[1]) fail('INVALID_INPUT');
    const expected = facts(input), ownedSources = [...sources];
    const [a, b] = await Promise.all(ownedSources.map(source => readMiningSeekerMemoEvidence(source, expected)));
    if (a!.slot !== b!.slot || a!.blockTime !== b!.blockTime || a!.signature !== b!.signature || a!.messageSha256 !== b!.messageSha256 || a!.genesisHash !== b!.genesisHash) fail('SOURCE_DISAGREEMENT');
    return Object.freeze({ ...expected, slot: a!.slot, blockTime: a!.blockTime, genesisHash: a!.genesisHash, messageSha256: a!.messageSha256, sources: 2 as const, eligibilityAuthorized: false as const, proofs: Object.freeze([a!, b!] as const) });
  }

  return Object.freeze({ read: readMiningSeekerMemoEvidence, readAgreed: readAgreedMiningSeekerMemoEvidence, replay: replayMiningSeekerMemoEvidence });
}
