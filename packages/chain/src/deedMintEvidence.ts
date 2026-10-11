/** Read-only D-118 evidence. Current ownership is never original mint ownership.
 * Finalized Core instructions and block order are the authority; DAS is not used.
 */
import { Connection, PublicKey, SolanaJSONRPCError, SolanaJSONRPCErrorCode, type VersionedTransactionResponse } from '@solana/web3.js';
import { Key, getCreateV1InstructionDataSerializer, getCreateV2InstructionDataSerializer } from '@metaplex-foundation/mpl-core';
import bs58 from 'bs58';
import { MINT_INVENTORY } from '@shardkeep/shared';
import { getCollectionV1AccountDataSerializer } from '@metaplex-foundation/mpl-core/dist/src/generated/types/collectionV1AccountData';

const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');

export type MintInventoryReason = 'context_lag' | 'collection_changed' | 'inventory_incomplete'
  | 'collection_unavailable' | 'collection_invalid' | 'rpc_rate_limit' | 'rpc_unavailable'
  | 'transport' | 'rpc_error' | 'upstream_unknown' | 'cluster_unavailable' | 'cluster_mismatch' | 'deadline';
export type MintInventoryStage = 'cluster' | 'collection_before' | 'assets' | 'collection_after';
export interface MintInventoryAttempt {
  attempt: number;
  stage: MintInventoryStage;
  durationMs: number;
  reason: MintInventoryReason | 'complete';
  rpcCode?: number;
  httpStatus?: number;
  requestedContextSlot?: number;
  returnedContextSlot?: number;
}
/** Only allowlisted labels and numeric chain metadata may leave this reader. */
export interface MintInventoryDiagnostics {
  reason?: MintInventoryReason;
  attemptLog?: MintInventoryAttempt[];
  stage: MintInventoryStage;
  attempts: number;
  contextRetries: number;
  rpcCode?: number;
  httpStatus?: number;
  beforeSlot?: number;
  inventorySlot?: number;
  afterSlot?: number;
  beforeMinted?: number;
  beforeSize?: number;
  afterMinted?: number;
  afterSize?: number;
  assetCount?: number;
}
export class DeedMintInventoryError extends Error {
  constructor(readonly diagnostics: MintInventoryDiagnostics & { reason: MintInventoryReason }) {
    super(`Founding mint inventory unavailable: ${diagnostics.reason} at ${diagnostics.stage}; finalized chain evidence required`);
    this.name = 'DeedMintInventoryError';
  }
}
/** Capture HTTP status before web3 includes an RPC URL/body in its own error. */
export class DeedMintTransportError extends Error {
  constructor(readonly status: number) { super('Mint inventory RPC transport refused'); this.name = 'DeedMintTransportError'; }
}
export type MintInventoryConnection = Connection | ((signal: AbortSignal) => Connection);
/** One inventory deadline cancels real fetches, including an unfinished body. */
export function makeDeedMintInventoryConnection(rpcUrl: string, signal: AbortSignal): Connection {
  return new Connection(rpcUrl, {
    commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, { ...init, signal, redirect: 'error' });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new DeedMintTransportError(response.status); }
      return response;
    },
  });
}
function failure(error: unknown, diagnostic: MintInventoryDiagnostics): DeedMintInventoryError {
  if (error instanceof DeedMintInventoryError) return error;
  if (error instanceof DeedMintTransportError) return new DeedMintInventoryError({ ...diagnostic,
    reason: error.status === 429 ? 'rpc_rate_limit' : error.status >= 500 ? 'rpc_unavailable' : 'rpc_error', httpStatus: error.status });
  if (error instanceof SolanaJSONRPCError) return new DeedMintInventoryError({ ...diagnostic,
    reason: error.code === -32016 ? 'context_lag' : error.code === -32000 ? 'upstream_unknown' : error.code === -32005 || error.code === -32603 ? 'rpc_unavailable' : 'rpc_error', ...(typeof error.code === 'number' && Number.isSafeInteger(error.code) ? { rpcCode: error.code } : {}) });
  return new DeedMintInventoryError({ ...diagnostic, reason: error instanceof TypeError ? 'transport' : 'rpc_error' });
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Keep the original finalized floor during bounded backend context-lag retries. */
async function retryContextLag<T>(read: () => Promise<T>, signal: AbortSignal, diagnostic: MintInventoryDiagnostics): Promise<T> {
  const delaysMs = [400, 800, 1200];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { const result = await read(); signal.throwIfAborted(); return result; }
    catch (error) {
      const delay = delaysMs[attempt];
      if (!(error instanceof SolanaJSONRPCError)
        || error.code !== SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED
        || delay === undefined) throw error;
      diagnostic.contextRetries += 1;
      await pause(delay, signal);
    }
  }
}

export interface DeedMintProof {
  assetId: string; originalWallet: string; confirmedAt: Date; slot: string;
  transactionIndex: number; signature: string;
}

export function originalDeedOwner(tx: VersionedTransactionResponse, asset: string, collection: string): string | null {
  if (!tx.meta || tx.meta.err) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? null });
  const top = tx.transaction.message.compiledInstructions.map(ix => ({
    programIdIndex: ix.programIdIndex, accounts: [...ix.accountKeyIndexes], data: ix.data,
  }));
  const inner = (tx.meta.innerInstructions ?? []).flatMap(group => group.instructions.map(ix => ({
    programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: bs58.decode(ix.data),
  })));
  const owners: string[] = [];
  for (const ix of [...top, ...inner]) {
    if (keys.get(ix.programIdIndex)?.toBase58() !== CORE.toBase58()) continue;
    if (keys.get(ix.accounts[0]!)?.toBase58() !== asset || keys.get(ix.accounts[1]!)?.toBase58() !== collection) continue;
    const discriminator = ix.data[0];
    if (discriminator !== 0 && discriminator !== 20) continue;
    if (inner.includes(ix)) throw new Error('Core CPI mint execution requires reconciliation');
    // Deserialize the entire recognized instruction; malformed/unknown versions fail closed.
    const decoder = discriminator === 0 ? getCreateV1InstructionDataSerializer() : getCreateV2InstructionDataSerializer();
    decoder.deserialize(ix.data);
    const owner = keys.get(ix.accounts[4]!)?.toBase58();
    // Our minter explicitly supplies owner. Do not guess Core's optional-account fallback.
    if (!owner || owner === CORE.toBase58()) throw new Error('mint owner is unresolved');
    owners.push(owner);
  }
  if (owners.length > 1) throw new Error('multiple creation instructions for asset');
  return owners[0] ?? null;
}

/** Inventory completeness is checked against the immutable collection mint counter.
 * Burned/removed/imported assets or a changing inventory fail closed for operator
 * reconciliation instead of silently dropping early minters from the snapshot.
 */
export async function readDeedMintInventory(source: MintInventoryConnection, collection: string) {
  const controller = new AbortController();
  const diagnostic: MintInventoryDiagnostics = { stage: 'collection_before', attempts: 0, contextRetries: 0, attemptLog: [] };
  let startedAt = 0, requestedContextSlot: number | undefined, returnedContextSlot: number | undefined;
  const recordAttempt = (reason: MintInventoryReason | 'complete', safe: MintInventoryDiagnostics = diagnostic) => {
    if (!diagnostic.attempts || diagnostic.attemptLog!.some(row => row.attempt === diagnostic.attempts)) return;
    diagnostic.attemptLog!.push({ attempt: diagnostic.attempts, stage: diagnostic.stage,
      durationMs: Math.max(0, Date.now() - startedAt), reason,
      ...(safe.rpcCode === undefined ? {} : { rpcCode: safe.rpcCode }),
      ...(safe.httpStatus === undefined ? {} : { httpStatus: safe.httpStatus }),
      ...(requestedContextSlot === undefined ? {} : { requestedContextSlot }),
      ...(returnedContextSlot === undefined ? {} : { returnedContextSlot }),
    });
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      recordAttempt('deadline');
      const error = new DeedMintInventoryError({ ...diagnostic, reason: 'deadline' });
      controller.abort(error); reject(error);
    }, MINT_INVENTORY.scanDeadlineMs);
  });
  const run = async () => {
    // Production supplies the factory so expiry aborts actual HTTP requests.
    // The Connection form keeps deterministic fixture readers injectable.
    const connection = typeof source === 'function' ? source(controller.signal) : source;
    let key: PublicKey;
    try { key = new PublicKey(collection); }
    catch { throw new DeedMintInventoryError({ ...diagnostic, reason: 'collection_invalid' }); }
    let floor = 0;
    const fail = (reason: MintInventoryReason): never => { throw new DeedMintInventoryError({ ...diagnostic, reason }); };
    for (let attempt = 1; attempt <= MINT_INVENTORY.maxScanAttempts; attempt++) {
      for (const field of ['beforeSlot', 'inventorySlot', 'afterSlot', 'beforeMinted', 'beforeSize', 'afterMinted', 'afterSize', 'assetCount'] as const) delete diagnostic[field];
      Object.assign(diagnostic, { stage: 'collection_before', attempts: attempt });
      startedAt = Date.now(); requestedContextSlot = floor || undefined; returnedContextSlot = undefined;
      try {
        controller.signal.throwIfAborted();
        const before = await connection.getAccountInfoAndContext(key, floor ? { commitment: 'finalized', minContextSlot: floor } : 'finalized');
        controller.signal.throwIfAborted();
        returnedContextSlot = before.context.slot;
        diagnostic.beforeSlot = before.context.slot;
        if (!Number.isSafeInteger(before.context.slot) || before.context.slot < floor) fail('context_lag');
        floor = before.context.slot;
        if (!before.value?.owner.equals(CORE)) fail('collection_unavailable');
        let collectionBefore;
        try { [collectionBefore] = getCollectionV1AccountDataSerializer().deserialize(before.value!.data); }
        catch { fail('collection_invalid'); }
        if (collectionBefore!.key !== Key.CollectionV1) fail('collection_invalid');
        diagnostic.beforeMinted = collectionBefore!.numMinted;
        diagnostic.beforeSize = collectionBefore!.currentSize;
        diagnostic.stage = 'assets';
        requestedContextSlot = before.context.slot; returnedContextSlot = undefined;
        const inventory = await retryContextLag(() => connection.getProgramAccounts(CORE, {
          commitment: 'finalized', withContext: true, minContextSlot: before.context.slot,
          filters: [{ memcmp: { offset: 0, bytes: bs58.encode(new Uint8Array([1])) } },
            { memcmp: { offset: 33, bytes: bs58.encode(Buffer.concat([Buffer.from([2]), key.toBuffer()])) } }],
          dataSlice: { offset: 0, length: 0 },
        }), controller.signal, diagnostic);
        returnedContextSlot = inventory.context.slot;
        diagnostic.inventorySlot = inventory.context.slot;
        diagnostic.assetCount = inventory.value.length;
        if (!Number.isSafeInteger(inventory.context.slot) || inventory.context.slot < before.context.slot) fail('context_lag');
        floor = inventory.context.slot;
        diagnostic.stage = 'collection_after';
        requestedContextSlot = inventory.context.slot; returnedContextSlot = undefined;
        const after = await retryContextLag(() => connection.getAccountInfoAndContext(key,
          { commitment: 'finalized', minContextSlot: inventory.context.slot }), controller.signal, diagnostic);
        returnedContextSlot = after.context.slot;
        diagnostic.afterSlot = after.context.slot;
        if (!Number.isSafeInteger(after.context.slot) || after.context.slot < inventory.context.slot) fail('context_lag');
        floor = after.context.slot;
        if (!after.value?.owner.equals(CORE)) fail('collection_unavailable');
        let collectionAfter;
        try { [collectionAfter] = getCollectionV1AccountDataSerializer().deserialize(after.value!.data); }
        catch { fail('collection_invalid'); }
        if (collectionAfter!.key !== Key.CollectionV1) fail('collection_invalid');
        diagnostic.afterMinted = collectionAfter!.numMinted;
        diagnostic.afterSize = collectionAfter!.currentSize;
        if (collectionBefore!.numMinted !== collectionAfter!.numMinted || collectionBefore!.currentSize !== collectionAfter!.currentSize) fail('collection_changed');
        const assets = inventory.value.map(a => a.pubkey.toBase58());
        if (assets.length !== collectionBefore!.numMinted || assets.length !== collectionBefore!.currentSize
          || new Set(assets).size !== assets.length) fail('inventory_incomplete');
        controller.signal.throwIfAborted();
        recordAttempt('complete');
        return { throughSlot: String(inventory.context.slot), assets, completedAt: new Date(), diagnostics: { ...diagnostic } };
      } catch (error) {
        controller.signal.throwIfAborted();
        const safe = failure(error, diagnostic);
        recordAttempt(safe.diagnostics.reason, safe.diagnostics);
        if (attempt === MINT_INVENTORY.maxScanAttempts || !['context_lag', 'collection_changed', 'rpc_rate_limit', 'rpc_unavailable', 'upstream_unknown', 'transport'].includes(safe.diagnostics.reason)) throw safe;
        // A changed collection restarts ALL reads. Never combine different attempts.
        await pause(400 * attempt, controller.signal);
      }
    }
    throw new DeedMintInventoryError({ ...diagnostic, reason: 'rpc_error' });
  };
  try { return await Promise.race([run(), timedOut]); }
  catch (error) { throw failure(error, diagnostic); }
  finally { clearTimeout(timer); }
}

export async function readDeedMintProof(connection: Connection, asset: string, collection: string): Promise<DeedMintProof> {
  const signatures = [];
  let before: string | undefined;
  // Operational RPC bounds, not game scoring numbers. Never truncate successfully.
  for (let page = 0; page < 200; page++) {
    const rows = await connection.getSignaturesForAddress(new PublicKey(asset), { limit: 1000, ...(before ? { before } : {}) }, 'finalized');
    signatures.push(...rows.filter(row => !row.err));
    if (rows.length < 1000) break;
    if (rows.at(-1)!.signature === before || page === 199) throw new Error('mint history pagination incomplete');
    before = rows.at(-1)!.signature;
  }
  for (const row of signatures.reverse()) {
    const tx = await connection.getTransaction(row.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!tx) throw new Error('mint transaction history unavailable');
    const owner = originalDeedOwner(tx, asset, collection);
    if (!owner) continue;
    if (tx.blockTime === null || tx.blockTime === undefined) throw new Error('mint confirmation time unavailable');
    const block = await connection.getBlockSignatures(tx.slot, 'finalized');
    const transactionIndex = block?.signatures.indexOf(row.signature) ?? -1;
    if (transactionIndex < 0) throw new Error('mint transaction order unavailable');
    return { assetId: asset, originalWallet: owner, confirmedAt: new Date(tx.blockTime * 1000), slot: String(tx.slot), transactionIndex, signature: row.signature };
  }
  throw new Error('verified original deed mint not found');
}
