/** Browser RPC is an allowlisted transport, never a signer or a payout authority.
 * Operational bounds protect the paid provider; they are not game economics. */
import { verifyAsync } from '@noble/ed25519';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export const RPC_RELAY_LIMITS = {
  requestBytes: 32 * 1024, responseBytes: 512 * 1024, batch: 10,
  deadlineMs: 10_000, transactionBytes: 1232,
  socketMessageBytes: 16 * 1024, upstreamMessageBytes: 64 * 1024,
  socketBufferBytes: 256 * 1024, subscriptions: 8, pending: 16,
  heartbeatMs: 15_000, socketLifetimeMs: 10 * 60_000,
  httpLocal: 64, socketsLocal: 512,
} as const;

export class RpcRelayError extends Error {
  constructor(readonly status: number, readonly code: number, message: string) { super(message); }
}
export const relayUnavailable = () => new RpcRelayError(503, -32005, 'RPC temporarily unavailable');
export const relayLimited = () => new RpcRelayError(429, -32005, 'RPC request limit reached');
const invalid = () => new RpcRelayError(400, -32602, 'Invalid RPC request');
export type RpcId = string | number;
export interface RpcCall { jsonrpc: '2.0'; id: RpcId; method: string; params: unknown[] }
export type RelayCost = 'admission' | 'read' | 'simulate' | 'send' | 'connect' | 'notification';
const HTTP_METHODS = new Set([
  'getBalance', 'getAccountInfo', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getFeeForMessage', 'simulateTransaction', 'sendTransaction', 'getGenesisHash', 'getVersion',
  'getBlockHeight', 'isBlockhashValid', 'getSignatureStatuses', 'getMultipleAccounts',
  'getTokenAccountsByOwner', 'getTokenAccountBalance',
]);
const SOCKET_METHODS = new Set(['signatureSubscribe', 'signatureUnsubscribe', 'accountSubscribe', 'accountUnsubscribe']);
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function key(value: unknown): void {
  if (typeof value !== 'string' || value.length > 44) throw invalid();
  try { new PublicKey(value); } catch { throw invalid(); }
}
function signature(value: unknown): void {
  if (typeof value !== 'string' || value.length > 88) throw invalid();
  try { if (bs58.decode(value).length !== 64) throw invalid(); } catch { throw invalid(); }
}
function base64(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > max) throw invalid();
  return bytes;
}
/** Method-specific cardinality prevents callers turning small wallet reads into
 * account scans. Unknown configuration fields never reach the provider. */
export function parseRpcCall(value: unknown, socket = false): RpcCall {
  if (!record(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string'
    || !(typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 64
      || typeof value.id === 'number' && Number.isSafeInteger(value.id))
    || !Array.isArray(value.params ?? [])) throw invalid();
  if (!(socket ? SOCKET_METHODS : HTTP_METHODS).has(value.method)) {
    throw new RpcRelayError(400, -32601, 'RPC method is not available');
  }
  const params = (value.params ?? []) as unknown[];
  const method = value.method;
  let configIndex = 0;
  if (['getGenesisHash', 'getVersion'].includes(method)) {
    if (params.length) throw invalid();
    configIndex = -1;
  } else if (method.endsWith('Unsubscribe')) {
    if (params.length !== 1 || !Number.isSafeInteger(params[0]) || Number(params[0]) < 0) throw invalid();
    configIndex = -1;
  } else if (method === 'signatureSubscribe') {
    signature(params[0]); configIndex = 1;
  } else if (['getBalance', 'getAccountInfo', 'getTokenAccountBalance', 'accountSubscribe'].includes(method)) {
    key(params[0]); configIndex = 1;
  } else if (method === 'getTokenAccountsByOwner') {
    key(params[0]);
    if (!record(params[1]) || Object.keys(params[1]).length !== 1) throw invalid();
    key(params[1].mint ?? params[1].programId); configIndex = 2;
  } else if (method === 'getMultipleAccounts' || method === 'getSignatureStatuses') {
    if (!Array.isArray(params[0]) || !params[0].length || params[0].length > (method === 'getMultipleAccounts' ? 100 : 256)) throw invalid();
    params[0].forEach(method === 'getMultipleAccounts' ? key : signature); configIndex = 1;
  } else if (method === 'getMinimumBalanceForRentExemption') {
    if (!Number.isSafeInteger(params[0]) || Number(params[0]) < 0 || Number(params[0]) > 10 * 1024 * 1024) throw invalid();
    configIndex = 1;
  } else if (method === 'isBlockhashValid') {
    key(params[0]); configIndex = 1;
  } else if (['getFeeForMessage', 'simulateTransaction', 'sendTransaction'].includes(method)) {
    base64(params[0], RPC_RELAY_LIMITS.transactionBytes); configIndex = 1;
  }
  if (configIndex >= 0) {
    if (params.length > configIndex + 1) throw invalid();
    const config = params[configIndex];
    if (config !== undefined) {
      // web3 accepts a legacy commitment string for rent exemption.
      if (typeof config === 'string' && method === 'getMinimumBalanceForRentExemption') {
        if (!['processed', 'confirmed', 'finalized'].includes(config)) throw invalid();
      } else {
        if (!record(config)) throw invalid();
        const common = new Set(['commitment', 'minContextSlot']);
        if (['getAccountInfo', 'getMultipleAccounts', 'getTokenAccountsByOwner', 'accountSubscribe'].includes(method)) {
          common.add('encoding'); common.add('dataSlice');
        }
        if (method === 'getSignatureStatuses') common.add('searchTransactionHistory');
        if (method === 'sendTransaction') for (const field of ['encoding', 'skipPreflight', 'preflightCommitment', 'maxRetries']) common.add(field);
        if (method === 'simulateTransaction') for (const field of ['encoding', 'sigVerify', 'replaceRecentBlockhash', 'accounts', 'innerInstructions']) common.add(field);
        if (method === 'signatureSubscribe') common.add('enableReceivedNotification');
        if (Object.keys(config).some((field) => !common.has(field))) throw invalid();
        for (const field of ['commitment', 'preflightCommitment']) {
          if (config[field] !== undefined && !['processed', 'confirmed', 'finalized'].includes(String(config[field]))) throw invalid();
        }
        if (config.minContextSlot !== undefined && (!Number.isSafeInteger(config.minContextSlot) || Number(config.minContextSlot) < 0)) throw invalid();
        if (config.encoding !== undefined && !['base64', 'base64+zstd', 'jsonParsed'].includes(String(config.encoding))) throw invalid();
        if (['sendTransaction', 'simulateTransaction'].includes(method) && config.encoding !== 'base64') throw invalid();
        if (config.maxRetries !== undefined && (!Number.isSafeInteger(config.maxRetries) || Number(config.maxRetries) < 0 || Number(config.maxRetries) > 5)) throw invalid();
        if (config.accounts !== undefined) {
          if (!record(config.accounts) || !Array.isArray(config.accounts.addresses) || config.accounts.addresses.length > 20
            || config.accounts.encoding !== 'base64' || Object.keys(config.accounts).some((field) => !['addresses', 'encoding'].includes(field))) throw invalid();
          config.accounts.addresses.forEach(key);
        }
        if (config.dataSlice !== undefined && (!record(config.dataSlice)
          || Object.keys(config.dataSlice).some((field) => !['offset', 'length'].includes(field))
          || !Number.isSafeInteger(config.dataSlice.offset) || Number(config.dataSlice.offset) < 0
          || !Number.isSafeInteger(config.dataSlice.length) || Number(config.dataSlice.length) < 0)) throw invalid();
        for (const field of ['skipPreflight', 'sigVerify', 'replaceRecentBlockhash', 'innerInstructions', 'enableReceivedNotification', 'searchTransactionHistory']) {
          if (config[field] !== undefined && typeof config[field] !== 'boolean') throw invalid();
        }
      }
    } else if (['sendTransaction', 'simulateTransaction'].includes(method)) throw invalid();
  }
  return { jsonrpc: '2.0', id: value.id as RpcId, method, params };
}
export function rpcCost(call: RpcCall): RelayCost {
  return call.method === 'sendTransaction' ? 'send' : call.method === 'simulateTransaction' ? 'simulate' : 'read';
}
export async function verifyRelayTransaction(call: RpcCall, wallet: string): Promise<void> {
  try {
    const wire = base64(call.params[0], RPC_RELAY_LIMITS.transactionBytes);
    const tx = VersionedTransaction.deserialize(wire);
    const message = tx.message.serialize();
    const required = tx.message.header.numRequiredSignatures;
    if (!required || tx.signatures.length !== required || tx.message.staticAccountKeys[0]?.toBase58() !== wallet
      || !Buffer.from(tx.serialize()).equals(wire)) throw invalid();
    for (let index = 0; index < required; index++) {
      const sig = tx.signatures[index]; const signer = tx.message.staticAccountKeys[index];
      if (!sig || !signer || !(await verifyAsync(sig, message, signer.toBytes()))) throw invalid();
    }
  } catch { throw new RpcRelayError(403, -32602, 'Transaction must be fully signed by the active wallet'); }
}
export function rpcFailure(id: RpcId | null, error: unknown) {
  const safe = error instanceof RpcRelayError ? error : relayUnavailable();
  return { jsonrpc: '2.0' as const, id, error: { code: safe.code, message: safe.message } };
}
/** Never echo raw provider errors: they can contain paid URLs, request bodies or
 * arbitrary error.data. Numeric codes retain wallet retry/error classification. */
export function sanitizeRpcResponse(value: unknown, id: RpcId): Record<string, unknown> {
  if (!record(value) || value.jsonrpc !== '2.0' || value.id !== id) throw relayUnavailable();
  if (record(value.error) && Number.isSafeInteger(value.error.code)) {
    return { jsonrpc: '2.0', id, error: { code: value.error.code, message: 'RPC request was rejected' } };
  }
  if (!Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')) throw relayUnavailable();
  return { jsonrpc: '2.0', id, result: value.result };
}
/** Node 22's source-aware JSON reviver preserves RPC u64 values for Kit.
 * Plain JSON.parse/stringify would silently round large lamport balances. */
export function parseRpcJson(raw: string): unknown {
  const lossless = JSON as typeof JSON & {
    rawJSON(source: string): unknown;
    parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown;
  };
  return lossless.parse(raw, (_key: string, value: unknown, context: { source?: string }) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)
      && context.source && /^-?[0-9]+$/.test(context.source)) return lossless.rawJSON(context.source);
    return value;
  });
}
export async function boundedRpcResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? '0') > RPC_RELAY_LIMITS.responseBytes) {
    await response.body?.cancel().catch(() => undefined); throw relayUnavailable();
  }
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > RPC_RELAY_LIMITS.responseBytes) throw relayUnavailable();
      chunks.push(Buffer.from(part.value));
    }
    return parseRpcJson(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => undefined); }
}
