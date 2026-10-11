/**
 * Custodial KEEP payout transport.
 *
 * Signing, persistence, broadcast and finality are deliberately separate. The
 * API commits `PreparedKeepWithdrawal.transactionBytes` and its signature before
 * `broadcast` is allowed to touch an RPC. Every retry sends those exact bytes;
 * an ambiguous acknowledgement can therefore never create a second transfer.
 */
import { ECONOMY, TOKEN } from '@shardkeep/shared';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const PREPARED_VERSION = 1 as const;
const RPC_OPERATION_TIMEOUT_MS = 15_000;
const POLICY_SIGNER_RESPONSE_LIMIT_BYTES = 100_000;
const DECIMAL_AMOUNT = /^[1-9][0-9]*$/;

export interface KeepWithdrawalPreparationRequest {
  withdrawalId: string;
  playerWallet: string;
  destination: string;
  grossAmountKeep: bigint;
  netAmountKeep: bigint;
  authorizationDigest: string;
  walletRolling24hCapKeep: bigint;
}

export interface PolicySignerPrepareRequest {
  version: typeof PREPARED_VERSION;
  withdrawalId: string;
  playerWallet: string;
  destination: string;
  grossAmountKeep: string;
  netAmountKeep: string;
  authorizationDigest: string;
  walletRolling24hCapKeep: string;
  cluster: 'devnet' | 'mainnet-beta';
  mint: string;
  sourceOwner: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
}

export interface SerializedPreparedKeepWithdrawal extends Omit<PreparedKeepWithdrawal, 'transactionBytes'> {
  transactionBytesBase64: string;
}

export interface KeepWithdrawalSnapshot {
  version: typeof PREPARED_VERSION;
  withdrawalId: string;
  destinationOwner: string;
  destinationAta: string;
  sourceAta: string;
  mint: string;
  feePayer: string;
  amountKeep: string;
  amountBaseUnits: string;
  decimals: number;
  memo: string;
}

export interface PreparedKeepWithdrawal {
  version: typeof PREPARED_VERSION;
  signature: string;
  transactionBytes: Uint8Array;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  transfer: KeepWithdrawalSnapshot;
}

export type KeepWithdrawalFinality =
  | { status: 'finalized_success'; source: string }
  | { status: 'finalized_error'; source: string; error: string }
  /**
   * Every configured non-archival source returned null after blockhash expiry.
   * This is a manual hold, not proof that an older finalized transaction never
   * existed: ordinary RPC history may already have been pruned.
   */
  | { status: 'expired_unresolved'; sources: string[] }
  | { status: 'pending'; expired: boolean; observations: string[] };

export interface KeepTransferSender {
  /** Builds and signs, locally or through the private policy signer. No broadcast. */
  prepare(request: KeepWithdrawalPreparationRequest): Promise<PreparedKeepWithdrawal>;
  /** Broadcasts the exact persisted signed bytes. */
  broadcast(prepared: PreparedKeepWithdrawal): Promise<string>;
  /** Reads finalized/history state. It never broadcasts. */
  reconcile(prepared: PreparedKeepWithdrawal): Promise<KeepWithdrawalFinality>;
}

export interface RemotePolicySignerOptions {
  endpoint: string;
  authToken: string;
  cluster: 'devnet' | 'mainnet-beta';
  sourceOwner: PublicKey;
  keepMint: PublicKey;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
}

export class PolicySignerRequestRefusedError extends Error {
  readonly retryable = false;
  constructor(status: number) {
    super(`policy signer refused withdrawal (${status})`);
    this.name = 'PolicySignerRequestRefusedError';
  }
}

export class PolicySignerUnavailableError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'PolicySignerUnavailableError';
  }
}

export interface WithdrawalReconciliationSource {
  /** Stable operator-readable identity (normally the RPC hostname). */
  source: string;
  connection: Connection;
}

function safeRpcSource(rpcEndpoint: string): string {
  try { return new URL(rpcEndpoint).hostname.toLowerCase(); } catch { return 'primary-rpc'; }
}

function assertEqual(actual: string, expected: string, label: string): void {
  if (actual !== expected) throw new Error(`prepared withdrawal ${label} mismatch`);
}

export function validateKeepWithdrawalPreparationRequest(
  request: KeepWithdrawalPreparationRequest,
): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(request.withdrawalId)) {
    throw new Error('invalid withdrawal id');
  }
  if (!/^[0-9a-f]{64}$/.test(request.authorizationDigest)) {
    throw new Error('invalid withdrawal authorization digest');
  }
  if (request.grossAmountKeep <= 0n || request.netAmountKeep <= 0n) {
    throw new Error('withdrawal amounts must be positive');
  }
  if (request.grossAmountKeep < BigInt(ECONOMY.minWithdrawKeep)) {
    throw new Error(`withdrawal gross is below the ${ECONOMY.minWithdrawKeep} KEEP minimum`);
  }
  if (request.walletRolling24hCapKeep <= 0n) {
    throw new Error('withdrawal wallet cap must be positive');
  }
  if (request.grossAmountKeep > request.walletRolling24hCapKeep) {
    throw new Error('withdrawal gross exceeds wallet cap');
  }
  const expectedFee = (request.grossAmountKeep * BigInt(ECONOMY.withdrawFeeBps)) / 10_000n;
  if (request.grossAmountKeep - expectedFee !== request.netAmountKeep) {
    throw new Error('withdrawal net does not match the configured fee formula');
  }
  for (const [label, value, mustBeOnCurve] of [
    ['player wallet', request.playerWallet, false], ['destination', request.destination, true],
  ] as const) {
    let publicKey: PublicKey;
    try { publicKey = new PublicKey(value); } catch { throw new Error(`invalid withdrawal ${label}`); }
    if (mustBeOnCurve && !PublicKey.isOnCurve(publicKey.toBytes())) {
      throw new Error(`invalid withdrawal ${label}`);
    }
  }
}

export function serializePreparedKeepWithdrawal(
  prepared: PreparedKeepWithdrawal,
): SerializedPreparedKeepWithdrawal {
  validatePreparedKeepWithdrawal(prepared);
  const { transactionBytes, ...json } = prepared;
  return {
    ...json,
    transactionBytesBase64: Buffer.from(transactionBytes).toString('base64'),
  };
}

export function deserializePreparedKeepWithdrawal(value: unknown): PreparedKeepWithdrawal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('policy signer returned a malformed prepared withdrawal');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== [
    'lastValidBlockHeight', 'recentBlockhash', 'signature',
    'transactionBytesBase64', 'transfer', 'version',
  ].sort().join(',')) {
    throw new Error('policy signer returned unexpected prepared-withdrawal fields');
  }
  const encoded = record['transactionBytesBase64'];
  if (typeof encoded !== 'string' || encoded.length === 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('policy signer returned malformed transaction bytes');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== encoded) {
    throw new Error('policy signer returned non-canonical transaction bytes');
  }
  const prepared = {
    version: record['version'],
    signature: record['signature'],
    transactionBytes: new Uint8Array(bytes),
    recentBlockhash: record['recentBlockhash'],
    lastValidBlockHeight: record['lastValidBlockHeight'],
    transfer: record['transfer'],
  } as PreparedKeepWithdrawal;
  validatePreparedKeepWithdrawal(prepared);
  return prepared;
}

export function validatePreparedKeepWithdrawalForRequest(
  prepared: PreparedKeepWithdrawal,
  request: KeepWithdrawalPreparationRequest,
  identity: { mint: PublicKey; sourceOwner: PublicKey },
): void {
  validateKeepWithdrawalPreparationRequest(request);
  validatePreparedKeepWithdrawalMatchesRequest(prepared, request, identity);
}

/** Historical artifact check. Deliberately excludes mutable economy policy. */
export function validatePreparedKeepWithdrawalMatchesRequest(
  prepared: PreparedKeepWithdrawal,
  request: KeepWithdrawalPreparationRequest,
  identity: { mint: PublicKey; sourceOwner: PublicKey },
): void {
  validatePreparedKeepWithdrawal(prepared);
  assertEqual(prepared.transfer.withdrawalId, request.withdrawalId, 'withdrawal id');
  assertEqual(prepared.transfer.destinationOwner, request.destination, 'destination owner');
  assertEqual(prepared.transfer.amountKeep, request.netAmountKeep.toString(), 'net amount');
  assertEqual(prepared.transfer.mint, identity.mint.toBase58(), 'mint');
  assertEqual(prepared.transfer.feePayer, identity.sourceOwner.toBase58(), 'source owner');
}

async function readLimitedSignerResponse(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^[0-9]+$/.test(declared)
      || Number(declared) > POLICY_SIGNER_RESPONSE_LIMIT_BYTES)) {
    await response.body?.cancel();
    throw new PolicySignerUnavailableError('policy signer response is too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > POLICY_SIGNER_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new PolicySignerUnavailableError('policy signer response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size).toString('utf8');
}

async function withRpcTimeout<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${RPC_OPERATION_TIMEOUT_MS}ms`)),
          RPC_OPERATION_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Decode and verify the signed artifact against its stored economic snapshot.
 * The API runs this before committing the artifact as the canonical attempt.
 */
export function validatePreparedKeepWithdrawal(prepared: PreparedKeepWithdrawal): void {
  if (!prepared || typeof prepared !== 'object' || !prepared.transfer
      || typeof prepared.transfer !== 'object') {
    throw new Error('prepared withdrawal is malformed');
  }
  if (Object.keys(prepared.transfer).sort().join(',') !== [
    'version', 'withdrawalId', 'destinationOwner', 'destinationAta', 'sourceAta',
    'mint', 'feePayer', 'amountKeep', 'amountBaseUnits', 'decimals', 'memo',
  ].sort().join(',')) {
    throw new Error('prepared withdrawal snapshot has unexpected fields');
  }
  if (prepared.version !== PREPARED_VERSION || prepared.transfer.version !== PREPARED_VERSION) {
    throw new Error('unsupported prepared withdrawal version');
  }
  if (typeof prepared.signature !== 'string' || typeof prepared.recentBlockhash !== 'string'
      || typeof prepared.transfer.withdrawalId !== 'string'
      || typeof prepared.transfer.destinationOwner !== 'string'
      || typeof prepared.transfer.destinationAta !== 'string'
      || typeof prepared.transfer.sourceAta !== 'string'
      || typeof prepared.transfer.mint !== 'string'
      || typeof prepared.transfer.feePayer !== 'string'
      || typeof prepared.transfer.amountKeep !== 'string'
      || !DECIMAL_AMOUNT.test(prepared.transfer.amountKeep)
      || typeof prepared.transfer.amountBaseUnits !== 'string'
      || !DECIMAL_AMOUNT.test(prepared.transfer.amountBaseUnits)
      || typeof prepared.transfer.memo !== 'string') {
    throw new Error('prepared withdrawal snapshot has invalid field types');
  }
  if (!Number.isSafeInteger(prepared.lastValidBlockHeight) || prepared.lastValidBlockHeight < 0) {
    throw new Error('invalid last-valid block height');
  }
  if (!(prepared.transactionBytes instanceof Uint8Array) || prepared.transactionBytes.length === 0) {
    throw new Error('prepared withdrawal has no signed bytes');
  }
  const tx = Transaction.from(Buffer.from(prepared.transactionBytes));
  if (!tx.verifySignatures()) throw new Error('prepared withdrawal signature verification failed');
  if (!tx.signature) throw new Error('prepared withdrawal has no fee-payer signature');
  assertEqual(bs58.encode(tx.signature), prepared.signature, 'signature');
  assertEqual(tx.recentBlockhash ?? '', prepared.recentBlockhash, 'blockhash');
  assertEqual(tx.feePayer?.toBase58() ?? '', prepared.transfer.feePayer, 'fee payer');
  if (tx.instructions.length !== 3) throw new Error('prepared withdrawal instruction count mismatch');

  const mint = new PublicKey(prepared.transfer.mint);
  const owner = new PublicKey(prepared.transfer.destinationOwner);
  const sourceAta = new PublicKey(prepared.transfer.sourceAta);
  const destinationAta = new PublicKey(prepared.transfer.destinationAta);
  const feePayer = new PublicKey(prepared.transfer.feePayer);
  assertEqual(
    getAssociatedTokenAddressSync(mint, owner, false).toBase58(),
    destinationAta.toBase58(),
    'destination ATA derivation',
  );
  assertEqual(
    getAssociatedTokenAddressSync(mint, feePayer, false).toBase58(),
    sourceAta.toBase58(),
    'source ATA derivation',
  );
  if (prepared.transfer.decimals !== TOKEN.decimals) {
    throw new Error('prepared withdrawal KEEP decimals mismatch');
  }

  const ata = tx.instructions[0]!;
  assertEqual(ata.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'ATA program');
  if (ata.data.length !== 1 || ata.data[0] !== 1 || ata.keys.length !== 6) {
    throw new Error('prepared withdrawal ATA instruction mismatch');
  }
  const expectedAtaKeys = [
    feePayer, destinationAta, owner, mint, SystemProgram.programId, TOKEN_PROGRAM_ID,
  ];
  expectedAtaKeys.forEach((key, i) => assertEqual(
    ata.keys[i]?.pubkey.toBase58() ?? '', key.toBase58(), `ATA key ${i}`,
  ));
  const expectedAtaFlags = [
    [true, true], [false, true], [false, false],
    [false, false], [false, false], [false, false],
  ] as const;
  expectedAtaFlags.forEach(([isSigner, isWritable], index) => {
    if (ata.keys[index]?.isSigner !== isSigner || ata.keys[index]?.isWritable !== isWritable) {
      throw new Error(`prepared withdrawal ATA key ${index} flags mismatch`);
    }
  });

  const transfer = decodeTransferCheckedInstruction(tx.instructions[1]!, TOKEN_PROGRAM_ID);
  assertEqual(transfer.keys.source.pubkey.toBase58(), sourceAta.toBase58(), 'transfer source');
  assertEqual(transfer.keys.mint.pubkey.toBase58(), mint.toBase58(), 'transfer mint');
  assertEqual(transfer.keys.destination.pubkey.toBase58(), destinationAta.toBase58(), 'transfer destination');
  assertEqual(transfer.keys.owner.pubkey.toBase58(), feePayer.toBase58(), 'transfer authority');
  const expectedTransferFlags = [
    [false, true], [false, false], [false, true], [true, true],
  ] as const;
  tx.instructions[1]!.keys.forEach((key, index) => {
    const expected = expectedTransferFlags[index];
    if (!expected || key.isSigner !== expected[0] || key.isWritable !== expected[1]) {
      throw new Error(`prepared withdrawal transfer key ${index} flags mismatch`);
    }
  });
  if (transfer.data.amount !== BigInt(prepared.transfer.amountBaseUnits)) {
    throw new Error('prepared withdrawal transfer amount mismatch');
  }
  if (transfer.data.decimals !== prepared.transfer.decimals) {
    throw new Error('prepared withdrawal decimals mismatch');
  }
  const expectedBaseUnits = BigInt(prepared.transfer.amountKeep)
    * 10n ** BigInt(prepared.transfer.decimals);
  if (expectedBaseUnits !== BigInt(prepared.transfer.amountBaseUnits)) {
    throw new Error('prepared withdrawal denomination mismatch');
  }

  const memo = tx.instructions[2]!;
  assertEqual(memo.programId.toBase58(), MEMO_PROGRAM_ID.toBase58(), 'memo program');
  if (memo.keys.length !== 0 || Buffer.from(memo.data).toString('utf8') !== prepared.transfer.memo) {
    throw new Error('prepared withdrawal memo mismatch');
  }
  assertEqual(prepared.transfer.memo, `SHARDKEEP withdrawal ${prepared.transfer.withdrawalId}`, 'memo');
}

type SourceObservation =
  | { kind: 'success'; source: string }
  | { kind: 'error'; source: string; error: string }
  | { kind: 'absent'; source: string }
  | { kind: 'pending'; source: string; detail: string }
  | { kind: 'unavailable'; source: string; detail: string };

function stringifyChainError(error: unknown): string {
  try { return JSON.stringify(error); } catch { return String(error); }
}

async function observeSource(
  source: WithdrawalReconciliationSource,
  prepared: PreparedKeepWithdrawal,
): Promise<SourceObservation> {
  try {
    const statuses = await source.connection.getSignatureStatuses(
      [prepared.signature], { searchTransactionHistory: true },
    );
    const status = statuses.value[0];
    if (status?.confirmationStatus === 'finalized') {
      return status.err
        ? { kind: 'error', source: source.source, error: stringifyChainError(status.err) }
        : { kind: 'success', source: source.source };
    }
    if (status) {
      return { kind: 'pending', source: source.source, detail: status.confirmationStatus ?? 'processed' };
    }

    // A history lookup closes the gap where status history is pruned but the
    // finalized transaction itself remains retrievable.
    const transaction = await source.connection.getTransaction(prepared.signature, {
      commitment: 'finalized', maxSupportedTransactionVersion: 0,
    });
    if (transaction) {
      if (!transaction.meta) {
        return { kind: 'pending', source: source.source, detail: 'finalized metadata unavailable' };
      }
      return transaction.meta.err
        ? { kind: 'error', source: source.source, error: stringifyChainError(transaction.meta.err) }
        : { kind: 'success', source: source.source };
    }
    const height = await source.connection.getBlockHeight('finalized');
    return height > prepared.lastValidBlockHeight
      ? { kind: 'absent', source: source.source }
      : { kind: 'pending', source: source.source, detail: `finalized height ${height}` };
  } catch (error) {
    return { kind: 'unavailable', source: source.source, detail: String(error) };
  }
}

function withdrawalSources(
  connection: Connection,
  reconciliationSources: readonly WithdrawalReconciliationSource[],
): WithdrawalReconciliationSource[] {
  const primarySource = safeRpcSource(connection.rpcEndpoint || '');
  const deduped = new Map<string, WithdrawalReconciliationSource>();
  deduped.set(primarySource, { source: primarySource, connection });
  for (const source of reconciliationSources) {
    const label = source.source.trim();
    if (label && !deduped.has(label)) deduped.set(label, source);
  }
  return [...deduped.values()];
}

async function latestWithdrawalBlockhash(
  sources: readonly WithdrawalReconciliationSource[],
): Promise<Awaited<ReturnType<Connection['getLatestBlockhash']>>> {
  try {
    return await Promise.any(sources.map((source) => withRpcTimeout(
      `${source.source} latest blockhash`,
      () => source.connection.getLatestBlockhash('finalized'),
    )));
  } catch (error) {
    throw new Error(`every withdrawal RPC failed to provide a finalized blockhash: ${String(error)}`);
  }
}

export function prepareKeepWithdrawalWithKeypair(
  request: KeepWithdrawalPreparationRequest,
  hotWallet: Keypair,
  keepMint: PublicKey,
  latest: { blockhash: string; lastValidBlockHeight: number },
): PreparedKeepWithdrawal {
  validateKeepWithdrawalPreparationRequest(request);
  if (!Number.isSafeInteger(latest.lastValidBlockHeight) || latest.lastValidBlockHeight < 0) {
    throw new Error('invalid last-valid block height');
  }
  let blockhashBytes: Uint8Array;
  try { blockhashBytes = bs58.decode(latest.blockhash); } catch { throw new Error('invalid recent blockhash'); }
  if (blockhashBytes.length !== 32 || bs58.encode(blockhashBytes) !== latest.blockhash) {
    throw new Error('invalid recent blockhash');
  }

  const owner = new PublicKey(request.destination);
  const sourceAta = getAssociatedTokenAddressSync(keepMint, hotWallet.publicKey, false);
  const destinationAta = getAssociatedTokenAddressSync(keepMint, owner, false);
  const amountBaseUnits = request.netAmountKeep * 10n ** BigInt(TOKEN.decimals);
  if (amountBaseUnits > (1n << 64n) - 1n) {
    throw new Error('withdrawal amount exceeds SPL Token u64');
  }
  const memo = `SHARDKEEP withdrawal ${request.withdrawalId}`;
  const tx = new Transaction({
    feePayer: hotWallet.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      hotWallet.publicKey, destinationAta, owner, keepMint,
    ),
    createTransferCheckedInstruction(
      sourceAta, keepMint, destinationAta, hotWallet.publicKey,
      amountBaseUnits, TOKEN.decimals,
    ),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(memo, 'utf8'),
    }),
  );
  tx.sign(hotWallet);
  if (!tx.signature) throw new Error('hot-wallet signer produced no signature');
  const prepared: PreparedKeepWithdrawal = {
    version: PREPARED_VERSION,
    signature: bs58.encode(tx.signature),
    transactionBytes: tx.serialize({ requireAllSignatures: true, verifySignatures: true }),
    recentBlockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    transfer: {
      version: PREPARED_VERSION,
      withdrawalId: request.withdrawalId,
      destinationOwner: owner.toBase58(),
      destinationAta: destinationAta.toBase58(),
      sourceAta: sourceAta.toBase58(),
      mint: keepMint.toBase58(),
      feePayer: hotWallet.publicKey.toBase58(),
      amountKeep: request.netAmountKeep.toString(),
      amountBaseUnits: amountBaseUnits.toString(),
      decimals: TOKEN.decimals,
      memo,
    },
  };
  validatePreparedKeepWithdrawalForRequest(prepared, request, {
    mint: keepMint, sourceOwner: hotWallet.publicKey,
  });
  return prepared;
}

function makeWithdrawalTransport(
  sources: readonly WithdrawalReconciliationSource[],
  prepare: KeepTransferSender['prepare'],
): KeepTransferSender {
  const finalityQuorum = Math.min(2, sources.length);

  return {
    prepare,

    async broadcast(prepared) {
      validatePreparedKeepWithdrawal(prepared);
      const bytes = Buffer.from(prepared.transactionBytes);
      const results = await Promise.all(sources.map(async (source) => {
        try {
          const signature = await withRpcTimeout(
            `${source.source} withdrawal broadcast`,
            () => source.connection.sendRawTransaction(
              bytes,
              { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 },
            ),
          );
          assertEqual(signature, prepared.signature, `${source.source} RPC signature`);
          return { accepted: true as const, source: source.source };
        } catch (error) {
          return { accepted: false as const, source: source.source, error: String(error) };
        }
      }));
      if (results.some((result) => result.accepted)) return prepared.signature;
      throw new Error(`withdrawal broadcast rejected by every RPC: ${results
        .map((result) => `${result.source}: ${result.accepted ? 'accepted' : result.error}`)
        .join('; ')}`);
    },

    async reconcile(prepared) {
      validatePreparedKeepWithdrawal(prepared);
      const observations = await Promise.all(sources.map(async (source): Promise<SourceObservation> => {
        try {
          return await withRpcTimeout(
            `${source.source} withdrawal reconciliation`,
            () => observeSource(source, prepared),
          );
        } catch (error) {
          return { kind: 'unavailable', source: source.source, detail: String(error) };
        }
      }));
      const successes = observations.filter((item) => item.kind === 'success');
      const errors = observations.filter((item) => item.kind === 'error');
      if (successes.length >= finalityQuorum) {
        return { status: 'finalized_success', source: successes[0]!.source };
      }
      // A single RPC must never make a signed payout refundable. A malicious or
      // faulty provider could report a finalized error after another provider
      // accepted the same bytes. Require independent finalized corroboration.
      if (errors.length >= finalityQuorum && successes.length === 0) {
        return {
          status: 'finalized_error', source: errors[0]!.source,
          error: errors.map((item) => `${item.source}: ${item.error}`).join('; '),
        };
      }
      // Conflicting finalized observations are held for operator investigation.
      if (successes.length > 0 && errors.length > 0) {
        return {
          status: 'pending', expired: false,
          observations: observations.map((item) => `${item.source}:${item.kind}`),
        };
      }
      const absent = [...new Set(observations
        .filter((item) => item.kind === 'absent').map((item) => item.source))];
      if (absent.length >= 2) return { status: 'expired_unresolved', sources: absent };
      return {
        status: 'pending', expired: absent.length > 0,
        observations: observations.map((item) => item.kind === 'pending' || item.kind === 'unavailable'
          ? `${item.source}:${item.kind}:${item.detail}`
          : `${item.source}:${item.kind}`),
      };
    },
  };
}

export function makeHotWalletKeepSender(
  connection: Connection,
  hotWallet: Keypair,
  keepMint: PublicKey,
  reconciliationSources: readonly WithdrawalReconciliationSource[] = [],
): KeepTransferSender {
  const sources = withdrawalSources(connection, reconciliationSources);
  return makeWithdrawalTransport(sources, async (request) => prepareKeepWithdrawalWithKeypair(
    request, hotWallet, keepMint, await latestWithdrawalBlockhash(sources),
  ));
}

export function makeRemotePolicyKeepSender(
  connection: Connection,
  options: RemotePolicySignerOptions,
  reconciliationSources: readonly WithdrawalReconciliationSource[] = [],
): KeepTransferSender {
  const sources = withdrawalSources(connection, reconciliationSources);
  const signerOrigin = new URL(options.endpoint);
  if (!['http:', 'https:'].includes(signerOrigin.protocol)
      || signerOrigin.username || signerOrigin.password || signerOrigin.pathname !== '/'
      || signerOrigin.search || signerOrigin.hash) {
    throw new Error('policy signer endpoint must be a bare http(s) origin');
  }
  const endpoint = new URL('/v1/withdrawals/prepare', signerOrigin).toString();
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? RPC_OPERATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error('invalid policy signer request timeout');
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.authToken)) {
    throw new Error('policy signer auth token is malformed');
  }

  return makeWithdrawalTransport(sources, async (request) => {
    validateKeepWithdrawalPreparationRequest(request);
    const latest = await latestWithdrawalBlockhash(sources);
    const payload: PolicySignerPrepareRequest = {
      version: PREPARED_VERSION,
      withdrawalId: request.withdrawalId,
      playerWallet: request.playerWallet,
      destination: request.destination,
      grossAmountKeep: request.grossAmountKeep.toString(),
      netAmountKeep: request.netAmountKeep.toString(),
      authorizationDigest: request.authorizationDigest,
      walletRolling24hCapKeep: request.walletRolling24hCapKeep.toString(),
      cluster: options.cluster,
      mint: options.keepMint.toBase58(),
      sourceOwner: options.sourceOwner.toBase58(),
      recentBlockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.authToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
      body = await readLimitedSignerResponse(response);
    } catch (error) {
      if (error instanceof PolicySignerUnavailableError) throw error;
      throw new PolicySignerUnavailableError(`policy signer request failed: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      if (response.status === 422) throw new PolicySignerRequestRefusedError(response.status);
      throw new PolicySignerUnavailableError(`policy signer unavailable (${response.status})`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch {
      throw new PolicySignerUnavailableError('policy signer returned invalid JSON');
    }
    let prepared: PreparedKeepWithdrawal;
    try {
      prepared = deserializePreparedKeepWithdrawal(parsed);
      validatePreparedKeepWithdrawalForRequest(prepared, request, {
        mint: options.keepMint, sourceOwner: options.sourceOwner,
      });
    } catch (error) {
      throw new PolicySignerUnavailableError(`policy signer returned an invalid artifact: ${String(error)}`);
    }
    // An exact-id retry may return the already-counted byte-identical artifact
    // created for an earlier horizon. Its signed transaction is revalidated
    // above; forcing the newly requested blockhash would wedge lost responses.
    return prepared;
  });
}
