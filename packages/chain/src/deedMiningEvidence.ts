/** Continuous ownership facts for mining inputs, never earning eligibility.
 * The caller must authenticate the finalized anchor and its cluster/collection.
 * This reader checks consistency of injected finalized RPC evidence; it does not
 * authenticate an RPC provider or establish the anchor from a current owner. */
import { PublicKey, type Connection, type ConfirmedSignatureInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import { replayDeedOwner, type DeedOwnerTransition } from './deedCloseEvidence';

export type DeedMiningReader = Pick<Connection, 'getSlot' | 'getBlockTime' | 'getSignaturesForAddress' | 'getTransaction' | 'getBlockSignatures'>;
export interface DeedMiningOwnershipInput {
  assetId: string; collection: string; owner: string; targetWallet: string;
  priorFinalizedSlot: string; startAt: Date; endAt: Date;
}
type Code = 'INVALID_INPUT' | 'HORIZON_UNAVAILABLE' | 'HISTORY_INCOMPLETE' | 'EVIDENCE_CONFLICT' | 'UNSUPPORTED_HISTORY' | 'TOO_LARGE' | 'READER_UNAVAILABLE';
export class DeedMiningEvidenceError extends Error {
  constructor(readonly code: Code) { super(`Deed ownership interval refused: ${code}`); this.name = 'DeedMiningEvidenceError'; }
}
function fail(code: Code): never { throw new DeedMiningEvidenceError(code); }
// Operational work bounds, not game policy. Exhaustion never means no transfers.
const PAGE_SIZE = 1_000, MAX_PAGES = 20, MAX_TRANSACTIONS = 2_000, MAX_BLOCK_SIGNATURES = 50_000;
const slotValid = (value: number) => Number.isSafeInteger(value) && value >= 0;
const timeValid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000;
function signatureValid(value: string): boolean {
  if (typeof value !== 'string' || value.length > 88) return false;
  try { const bytes = bs58.decode(value); return bytes.length === 64 && bs58.encode(bytes) === value; } catch { return false; }
}
function keyValid(value: string): boolean {
  if (typeof value !== 'string' || value.length > 44) return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}
async function read<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch { return fail('READER_UNAVAILABLE'); }
}
function checkTransaction(tx: VersionedTransactionResponse, row: ConfirmedSignatureInfo, asset: string): void {
  try {
    if (!tx.meta || tx.slot !== row.slot || !timeValid(tx.blockTime)
      || (row.blockTime != null && row.blockTime !== tx.blockTime)
      || JSON.stringify(tx.meta.err) !== JSON.stringify(row.err)
      || !Array.isArray(tx.transaction.signatures) || tx.transaction.signatures.length > 256
      || tx.transaction.signatures[0] !== row.signature
      || tx.transaction.signatures.length !== tx.transaction.message.header.numRequiredSignatures
      || !tx.transaction.signatures.every(signatureValid)) fail('EVIDENCE_CONFLICT');
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? null });
    let referencesAsset = false;
    for (let index = 0; index < keys.length; index++) {
      const key = keys.get(index)?.toBase58();
      if (!key || !keyValid(key)) fail('EVIDENCE_CONFLICT');
      if (key === asset) referencesAsset = true;
    }
    if (!referencesAsset) fail('EVIDENCE_CONFLICT');
    const indexValid = (index: number) => Number.isInteger(index) && index >= 0 && index < keys.length;
    for (const ix of tx.transaction.message.compiledInstructions) {
      if (!indexValid(ix.programIdIndex) || !ix.accountKeyIndexes.every(indexValid)) fail('EVIDENCE_CONFLICT');
    }
    for (const group of tx.meta.innerInstructions ?? []) {
      if (!Number.isInteger(group.index) || group.index < 0 || group.index >= tx.transaction.message.compiledInstructions.length) fail('EVIDENCE_CONFLICT');
      for (const ix of group.instructions) if (!indexValid(ix.programIdIndex) || !ix.accounts.every(indexValid)) fail('EVIDENCE_CONFLICT');
    }
  } catch { fail('EVIDENCE_CONFLICT'); }
}

export async function readDeedMiningOwnership(reader: DeedMiningReader, input: DeedMiningOwnershipInput) {
  if (!input || typeof input !== 'object'
    || ![input.assetId, input.collection, input.owner, input.targetWallet].every(keyValid)
    || typeof input.priorFinalizedSlot !== 'string' || input.priorFinalizedSlot.length > 16
    || !/^(0|[1-9]\d*)$/.test(input.priorFinalizedSlot)
    || !(input.startAt instanceof Date) || !(input.endAt instanceof Date)
    || !Number.isFinite(+input.startAt) || !Number.isFinite(+input.endAt)
    || +input.startAt < 0 || +input.startAt >= +input.endAt) fail('INVALID_INPUT');
  // Keep the asynchronous proof bound to the values validated above, even if
  // the caller later mutates its request object or either Date instance.
  input = { assetId: input.assetId, collection: input.collection, owner: input.owner, targetWallet: input.targetWallet,
    priorFinalizedSlot: input.priorFinalizedSlot, startAt: new Date(+input.startAt), endAt: new Date(+input.endAt) };
  const priorSlot = Number(input.priorFinalizedSlot);
  if (!slotValid(priorSlot)) fail('INVALID_INPUT');
  const throughSlot = await read(() => reader.getSlot('finalized'));
  if (!slotValid(throughSlot) || throughSlot <= priorSlot) fail('HORIZON_UNAVAILABLE');
  const [priorTime, throughTime] = await Promise.all([
    read(() => reader.getBlockTime(priorSlot)), read(() => reader.getBlockTime(throughSlot)),
  ]);
  if (!timeValid(priorTime) || !timeValid(throughTime) || priorTime * 1_000 >= +input.startAt || throughTime * 1_000 < +input.endAt) fail('HORIZON_UNAVAILABLE');

  const rows: ConfirmedSignatureInfo[] = [], seen = new Set<string>();
  let before: string | undefined, reachedAnchor = false, previousSlot = Number.MAX_SAFE_INTEGER;
  for (let page = 0; page < MAX_PAGES; page++) {
    const history = await read(() => reader.getSignaturesForAddress(new PublicKey(input.assetId), { limit: PAGE_SIZE, ...(before ? { before } : {}) }, 'finalized'));
    if (!Array.isArray(history) || history.length > PAGE_SIZE) fail('EVIDENCE_CONFLICT');
    for (const row of history) {
      if (!row || typeof row !== 'object' || !signatureValid(row.signature) || !slotValid(row.slot) || row.slot > previousSlot || seen.has(row.signature)
        || (row.err !== null && (typeof row.err !== 'object' || row.err === undefined))
        || (row.confirmationStatus != null && row.confirmationStatus !== 'finalized')) fail('EVIDENCE_CONFLICT');
      previousSlot = row.slot; seen.add(row.signature);
      if (row.slot <= priorSlot) reachedAnchor = true;
      else if (row.slot <= throughSlot) rows.push(row);
      if (rows.length > MAX_TRANSACTIONS) fail('TOO_LARGE');
    }
    if (reachedAnchor) break;
    if (history.length < PAGE_SIZE) fail('HISTORY_INCOMPLETE');
    before = history.at(-1)!.signature;
  }
  if (!reachedAnchor) fail('TOO_LARGE');

  const blocks = new Map<number, { time: number; signatures: string[] }>();
  const transactions: Array<{ tx: VersionedTransactionResponse; signature: string; transactionIndex: number }> = [];
  for (const row of rows) {
    const tx = await read(() => reader.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }));
    if (!tx) fail('HISTORY_INCOMPLETE');
    checkTransaction(tx, row, input.assetId);
    let block = blocks.get(row.slot);
    if (!block) {
      const [time, order] = await Promise.all([read(() => reader.getBlockTime(row.slot)), read(() => reader.getBlockSignatures(row.slot, 'finalized'))]);
      if (!timeValid(time) || !order || !Array.isArray(order.signatures)) fail('EVIDENCE_CONFLICT');
      if (order.signatures.length > MAX_BLOCK_SIGNATURES) fail('TOO_LARGE');
      if (new Set(order.signatures).size !== order.signatures.length || !order.signatures.every(signatureValid)) fail('EVIDENCE_CONFLICT');
      block = { time, signatures: order.signatures }; blocks.set(row.slot, block);
    }
    const index = block.signatures.indexOf(row.signature);
    if (index < 0 || tx.blockTime !== block.time || block.time < priorTime || block.time > throughTime) fail('EVIDENCE_CONFLICT');
    transactions.push({ tx, signature: row.signature, transactionIndex: index });
  }
  transactions.sort((a, b) => a.tx.slot - b.tx.slot || a.transactionIndex - b.transactionIndex);
  let previousTime = priorTime;
  for (const { tx } of transactions) {
    if (tx.blockTime! < previousTime) fail('EVIDENCE_CONFLICT');
    previousTime = tx.blockTime!;
  }
  let owner = input.owner, ownerAtStart = input.owner, heldContinuously = true, started = false;
  const evidenceTransactions: Array<{ signature: string; slot: string; blockTime: number; transactionIndex: number; failed: boolean; transitions: DeedOwnerTransition[] }> = [];
  for (const { tx, signature, transactionIndex } of transactions) {
    if (tx.blockTime! * 1_000 >= +input.endAt) continue;
    const inInterval = tx.blockTime! * 1_000 >= +input.startAt;
    if (inInterval && !started) { ownerAtStart = owner; heldContinuously = owner === input.targetWallet; started = true; }
    const transitions: DeedOwnerTransition[] = [];
    try { owner = replayDeedOwner(tx, input.assetId, input.collection, owner, transitions); }
    catch { fail('UNSUPPORTED_HISTORY'); }
    if (inInterval && transitions.some(t => t.from !== input.targetWallet || t.to !== input.targetWallet)) heldContinuously = false;
    evidenceTransactions.push({ signature, slot: String(tx.slot), blockTime: tx.blockTime!, transactionIndex, failed: tx.meta!.err !== null, transitions });
  }
  if (!started) { ownerAtStart = owner; heldContinuously = owner === input.targetWallet; }
  return { ownerAtStart, ownerAtEnd: owner, heldContinuously, evidence: {
    anchorTrust: 'external' as const, assetId: input.assetId, collection: input.collection, targetWallet: input.targetWallet,
    priorFinalizedSlot: input.priorFinalizedSlot, priorOwner: input.owner, priorBlockTime: priorTime,
    startAt: input.startAt.toISOString(), endAt: input.endAt.toISOString(), throughSlot: String(throughSlot), throughBlockTime: throughTime,
    transactions: evidenceTransactions,
  } };
}
