/**
 * Independent KEEP withdrawal policy signer.
 *
 * This process has no database connection. It treats every worker field as
 * hostile, applies custody limits from its own configuration, and records each
 * signed artifact before returning it. Signed entries are never released on an
 * API/worker claim, including failed or expired broadcasts.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  deserializePreparedKeepWithdrawal,
  prepareKeepWithdrawalWithKeypair,
  serializePreparedKeepWithdrawal,
  validateKeepWithdrawalPreparationRequest,
  validatePreparedKeepWithdrawalMatchesRequest,
  type KeepWithdrawalPreparationRequest,
  type PolicySignerPrepareRequest,
  type SerializedPreparedKeepWithdrawal,
} from '@shardkeep/chain';
import { Keypair, PublicKey } from '@solana/web3.js';

const STATE_VERSION = 2 as const;
const WINDOW_MS = 86_400_000;
const MAX_JOURNAL_ENTRY_BYTES = 128 * 1024;
const DECIMAL = /^[1-9][0-9]*$/;

interface StoredLogicalRequest {
  version: 1;
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
}

interface PolicySignerEntry {
  withdrawalId: string;
  fingerprint: string;
  signedAt: string;
  request: StoredLogicalRequest;
  prepared: SerializedPreparedKeepWithdrawal;
}

interface PolicySignerState {
  version: typeof STATE_VERSION;
  entries: PolicySignerEntry[];
}

interface CachedPolicySignerState {
  stamp: string;
  state: PolicySignerState;
  index: PolicySignerIndex;
}

interface RollingSeries {
  times: number[];
  cumulativeGross: bigint[];
}

interface PolicySignerIndex {
  byWithdrawal: Map<string, PolicySignerEntry>;
  authorizationDigests: Set<string>;
  aggregate: RollingSeries;
  byWallet: Map<string, RollingSeries>;
  latestSignedAt: number;
}

export class PolicySignerRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'PolicySignerRequestError'; }
}

export class PolicySignerPolicyRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'PolicySignerPolicyRefusal'; }
}

export interface WithdrawalPolicySignerConfig {
  stateFile: string;
  cluster: 'devnet' | 'mainnet-beta';
  keepMint: PublicKey;
  sourceOwner: PublicKey;
  maxPerTransferKeep: bigint;
  maxPerWallet24hKeep: bigint;
  maxAggregate24hKeep: bigint;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function positiveDecimal(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error(`${label} must be a positive decimal`);
  return BigInt(value);
}

function logicalRequest(input: PolicySignerPrepareRequest): StoredLogicalRequest {
  return {
    version: 1,
    withdrawalId: input.withdrawalId,
    playerWallet: input.playerWallet,
    destination: input.destination,
    grossAmountKeep: input.grossAmountKeep,
    netAmountKeep: input.netAmountKeep,
    authorizationDigest: input.authorizationDigest,
    walletRolling24hCapKeep: input.walletRolling24hCapKeep,
    cluster: input.cluster,
    mint: input.mint,
    sourceOwner: input.sourceOwner,
  };
}

function fingerprint(request: StoredLogicalRequest): string {
  const { walletRolling24hCapKeep: _dynamicRiskHint, ...stableAuthorization } = request;
  return createHash('sha256').update(JSON.stringify(stableAuthorization)).digest('hex');
}

function validateStructuralPreparation(request: KeepWithdrawalPreparationRequest): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(request.withdrawalId)) throw new Error('invalid withdrawal id');
  if (!/^[0-9a-f]{64}$/.test(request.authorizationDigest)) {
    throw new Error('invalid withdrawal authorization digest');
  }
  if (request.grossAmountKeep <= 0n || request.netAmountKeep <= 0n
      || request.netAmountKeep > request.grossAmountKeep
      || request.walletRolling24hCapKeep <= 0n) {
    throw new Error('withdrawal amounts and cap are structurally invalid');
  }
  let player: PublicKey;
  let destination: PublicKey;
  try {
    player = new PublicKey(request.playerWallet);
    destination = new PublicKey(request.destination);
  } catch { throw new Error('withdrawal wallet identity is invalid'); }
  if (player.toBytes().length !== 32 || !PublicKey.isOnCurve(destination.toBytes())) {
    throw new Error('withdrawal wallet identity is invalid');
  }
}

function parseWireRequest(value: unknown): {
  wire: PolicySignerPrepareRequest;
  preparation: KeepWithdrawalPreparationRequest;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('policy signer request must be an object');
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, [
    'version', 'withdrawalId', 'playerWallet', 'destination', 'grossAmountKeep',
    'netAmountKeep', 'authorizationDigest', 'walletRolling24hCapKeep', 'cluster',
    'mint', 'sourceOwner', 'recentBlockhash', 'lastValidBlockHeight',
  ], 'policy signer request');
  if (record['version'] !== 1
      || (record['cluster'] !== 'devnet' && record['cluster'] !== 'mainnet-beta')
      || typeof record['withdrawalId'] !== 'string'
      || typeof record['playerWallet'] !== 'string'
      || typeof record['destination'] !== 'string'
      || typeof record['authorizationDigest'] !== 'string'
      || typeof record['mint'] !== 'string'
      || typeof record['sourceOwner'] !== 'string'
      || typeof record['recentBlockhash'] !== 'string'
      || !Number.isSafeInteger(record['lastValidBlockHeight'])
      || (record['lastValidBlockHeight'] as number) < 0) {
    throw new Error('policy signer request has invalid field types');
  }
  const preparation: KeepWithdrawalPreparationRequest = {
    withdrawalId: record['withdrawalId'],
    playerWallet: record['playerWallet'],
    destination: record['destination'],
    grossAmountKeep: positiveDecimal(record['grossAmountKeep'], 'gross amount'),
    netAmountKeep: positiveDecimal(record['netAmountKeep'], 'net amount'),
    authorizationDigest: record['authorizationDigest'],
    walletRolling24hCapKeep: positiveDecimal(record['walletRolling24hCapKeep'], 'wallet cap'),
  };
  validateStructuralPreparation(preparation);
  let mint: PublicKey;
  let sourceOwner: PublicKey;
  let recentBlockhash: PublicKey;
  try {
    mint = new PublicKey(record['mint']);
    sourceOwner = new PublicKey(record['sourceOwner']);
    recentBlockhash = new PublicKey(record['recentBlockhash']);
  } catch {
    throw new Error('policy signer request has invalid custody identity or blockhash');
  }
  return {
    wire: {
      version: 1,
      withdrawalId: record['withdrawalId'],
      playerWallet: record['playerWallet'],
      destination: record['destination'],
      grossAmountKeep: preparation.grossAmountKeep.toString(),
      netAmountKeep: preparation.netAmountKeep.toString(),
      authorizationDigest: record['authorizationDigest'],
      walletRolling24hCapKeep: preparation.walletRolling24hCapKeep.toString(),
      cluster: record['cluster'],
      mint: mint.toBase58(),
      sourceOwner: sourceOwner.toBase58(),
      recentBlockhash: recentBlockhash.toBase58(),
      lastValidBlockHeight: record['lastValidBlockHeight'] as number,
    },
    preparation,
  };
}

function parseStoredRequest(value: unknown): StoredLogicalRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('stored request is malformed');
  const record = value as Record<string, unknown>;
  exactKeys(record, [
    'version', 'withdrawalId', 'playerWallet', 'destination', 'grossAmountKeep',
    'netAmountKeep', 'authorizationDigest', 'walletRolling24hCapKeep', 'cluster',
    'mint', 'sourceOwner',
  ], 'stored policy request');
  const synthetic = parseWireRequest({
    ...record,
    recentBlockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 0,
  });
  return logicalRequest(synthetic.wire);
}

function parseState(value: unknown, identity: { mint: PublicKey; sourceOwner: PublicKey }): PolicySignerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('policy signer state is malformed');
  const record = value as Record<string, unknown>;
  exactKeys(record, ['version', 'entries'], 'policy signer state');
  if (record['version'] !== STATE_VERSION || !Array.isArray(record['entries'])) {
    throw new Error('policy signer state version or entries are invalid');
  }
  const ids = new Set<string>();
  const authorizationDigests = new Set<string>();
  let latestTimestamp = 0;
  const entries = record['entries'].map((raw): PolicySignerEntry => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('policy signer state entry is malformed');
    const entry = raw as Record<string, unknown>;
    exactKeys(entry, ['withdrawalId', 'fingerprint', 'signedAt', 'request', 'prepared'], 'policy signer state entry');
    if (typeof entry['withdrawalId'] !== 'string' || typeof entry['fingerprint'] !== 'string'
        || !/^[0-9a-f]{64}$/.test(entry['fingerprint']) || typeof entry['signedAt'] !== 'string') {
      throw new Error('policy signer state entry fields are invalid');
    }
    const signedAt = new Date(entry['signedAt']);
    if (!Number.isFinite(signedAt.getTime()) || signedAt.toISOString() !== entry['signedAt']) {
      throw new Error('policy signer state timestamp is invalid');
    }
    if (signedAt.getTime() < latestTimestamp) {
      throw new Error('policy signer journal timestamps are not monotonic');
    }
    latestTimestamp = signedAt.getTime();
    const request = parseStoredRequest(entry['request']);
    if (request.withdrawalId !== entry['withdrawalId'] || fingerprint(request) !== entry['fingerprint']) {
      throw new Error('policy signer state fingerprint mismatch');
    }
    if (ids.has(request.withdrawalId)) throw new Error('policy signer state has duplicate withdrawal ids');
    ids.add(request.withdrawalId);
    if (authorizationDigests.has(request.authorizationDigest)) {
      throw new Error('policy signer state has duplicate authorization digests');
    }
    authorizationDigests.add(request.authorizationDigest);
    const prepared = serializePreparedKeepWithdrawal(deserializePreparedKeepWithdrawal(entry['prepared']));
    const preparation: KeepWithdrawalPreparationRequest = {
      withdrawalId: request.withdrawalId,
      playerWallet: request.playerWallet,
      destination: request.destination,
      grossAmountKeep: BigInt(request.grossAmountKeep),
      netAmountKeep: BigInt(request.netAmountKeep),
      authorizationDigest: request.authorizationDigest,
      walletRolling24hCapKeep: BigInt(request.walletRolling24hCapKeep),
    };
    validatePreparedKeepWithdrawalMatchesRequest(deserializePreparedKeepWithdrawal(prepared), preparation, identity);
    return {
      withdrawalId: request.withdrawalId,
      fingerprint: entry['fingerprint'],
      signedAt: entry['signedAt'],
      request,
      prepared,
    };
  });
  return { version: STATE_VERSION, entries };
}

function appendRolling(series: RollingSeries, signedAt: number, gross: bigint): void {
  series.times.push(signedAt);
  series.cumulativeGross.push((series.cumulativeGross.at(-1) ?? 0n) + gross);
}

function buildIndex(state: PolicySignerState): PolicySignerIndex {
  const index: PolicySignerIndex = {
    byWithdrawal: new Map(), authorizationDigests: new Set(),
    aggregate: { times: [], cumulativeGross: [] }, byWallet: new Map(), latestSignedAt: 0,
  };
  for (const entry of state.entries) addToIndex(index, entry);
  return index;
}

function addToIndex(index: PolicySignerIndex, entry: PolicySignerEntry): void {
  const signedAt = new Date(entry.signedAt).getTime();
  const gross = BigInt(entry.request.grossAmountKeep);
  index.byWithdrawal.set(entry.withdrawalId, entry);
  index.authorizationDigests.add(entry.request.authorizationDigest);
  appendRolling(index.aggregate, signedAt, gross);
  let wallet = index.byWallet.get(entry.request.playerWallet);
  if (!wallet) {
    wallet = { times: [], cumulativeGross: [] };
    index.byWallet.set(entry.request.playerWallet, wallet);
  }
  appendRolling(wallet, signedAt, gross);
  index.latestSignedAt = signedAt;
}

function rollingGrossAfter(series: RollingSeries | undefined, cutoff: number): bigint {
  if (!series || series.times.length === 0) return 0n;
  let low = 0;
  let high = series.times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (series.times[middle]! <= cutoff) low = middle + 1;
    else high = middle;
  }
  return (series.cumulativeGross.at(-1) ?? 0n)
    - (low === 0 ? 0n : series.cumulativeGross[low - 1]!);
}

async function assertSecureStateDirectory(file: string): Promise<void> {
  const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await directory.stat();
    if (!stat.isDirectory()) throw new Error('policy signer state parent must be a directory');
    if ((stat.mode & 0o077) !== 0) throw new Error('policy signer state directory permissions must be 0700');
  } finally {
    await directory.close();
  }
}

async function readState(
  file: string,
  identity: { mint: PublicKey; sourceOwner: PublicKey },
  cached?: CachedPolicySignerState,
): Promise<CachedPolicySignerState> {
  await assertSecureStateDirectory(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error('policy signer state must be a regular file');
    if ((stat.mode & 0o077n) !== 0n) throw new Error('policy signer state permissions must be 0600');
    if (stat.size <= 0n) {
      throw new Error('policy signer state size is invalid');
    }
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (cached?.stamp === stamp) return cached;
    const text = await handle.readFile('utf8');
    if (!text.endsWith('\n')) throw new Error('policy signer journal has a partial trailing entry');
    const lines = text.slice(0, -1).split('\n');
    const header: unknown = JSON.parse(lines.shift() ?? '');
    if (!header || typeof header !== 'object' || Array.isArray(header)) {
      throw new Error('policy signer journal header is malformed');
    }
    exactKeys(header as Record<string, unknown>, ['version'], 'policy signer journal header');
    if ((header as Record<string, unknown>)['version'] !== STATE_VERSION) {
      throw new Error('policy signer journal version is invalid');
    }
    const entries = lines.map((line) => {
      if (Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_ENTRY_BYTES) {
        throw new Error('policy signer journal entry is too large');
      }
      return JSON.parse(line) as unknown;
    });
    const state = parseState({ version: STATE_VERSION, entries }, identity);
    return { stamp, state, index: buildIndex(state) };
  } catch (error) {
    throw new Error(`policy signer state is unreadable: ${String(error)}`);
  } finally {
    await handle.close();
  }
}

async function appendStateEntry(
  file: string,
  previous: CachedPolicySignerState,
  entry: PolicySignerEntry,
): Promise<CachedPolicySignerState> {
  const encoded = `${JSON.stringify(entry)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JOURNAL_ENTRY_BYTES) {
    throw new Error('policy signer journal entry exceeds the reviewed bound');
  }
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || (before.mode & 0o077n) !== 0n) {
      throw new Error('policy signer journal permissions changed before append');
    }
    const beforeStamp = `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${before.ctimeNs}`;
    if (beforeStamp !== previous.stamp) {
      throw new Error('policy signer journal changed after policy evaluation');
    }
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    const stamp = `${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`;
    previous.state.entries.push(entry);
    addToIndex(previous.index, entry);
    return { ...previous, stamp };
  } finally {
    await handle.close();
  }
}

async function withExclusiveStateWrite<T>(stateFile: string, operation: () => Promise<T>): Promise<T> {
  await assertSecureStateDirectory(stateFile);
  const lockFile = `${stateFile}.lock`;
  const lockHandle = await open(
    lockFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await lockHandle.chmod(0o600);
  } finally {
    await lockHandle.close();
  }
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : 'flock';
  const lockArgs = process.platform === 'darwin'
    ? ['-t', '0', lockFile, 'sh', '-c', 'printf LOCKED; cat >/dev/null']
    : ['-n', lockFile, 'sh', '-c', 'printf LOCKED; cat >/dev/null'];
  const holder = spawn(command, lockArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      holder.kill('SIGKILL');
      finish(new Error('policy signer advisory-lock acquisition timed out'));
    }, 5_000);
    timer.unref?.();
    holder.once('error', (error) => finish(error));
    holder.once('exit', (code) => finish(new Error(
      code === 1 || (process.platform === 'darwin' && code === 75)
        ? 'policy signer state is locked by another signer'
        : `policy signer lock helper exited before acquisition (${String(code)})`,
    )));
    holder.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output === 'LOCKED') finish();
    });
  });
  try {
    if (holder.exitCode !== null) throw new Error('policy signer advisory lock was lost');
    return await operation();
  } finally {
    holder.stdin.end();
    if (holder.exitCode === null) {
      await new Promise<void>((resolve) => holder.once('close', () => resolve()));
    }
  }
}

/** Explicit ceremony step. Runtime startup never calls this: missing state must halt. */
export async function initializeWithdrawalPolicyState(stateFile: string): Promise<void> {
  try {
    await assertSecureStateDirectory(stateFile);
    const handle = await open(stateFile, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: STATE_VERSION })}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(path.dirname(stateFile), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    throw new Error(`policy signer state initialization failed: ${String(error)}`);
  }
}

export async function verifyWithdrawalPolicyState(
  stateFile: string,
  identity: { mint: PublicKey; sourceOwner: PublicKey },
): Promise<number> {
  return (await readState(stateFile, identity)).state.entries.length;
}

export class WithdrawalPolicySigner {
  readonly #config: WithdrawalPolicySignerConfig;
  readonly #keypair: Keypair;
  readonly #now: () => Date;
  #tail: Promise<void> = Promise.resolve();
  #cache?: CachedPolicySignerState;

  constructor(config: WithdrawalPolicySignerConfig, keypair: Keypair, now: () => Date = () => new Date()) {
    if (keypair.publicKey.toBase58() !== config.sourceOwner.toBase58()) {
      throw new Error('policy signer keypair does not match configured source owner');
    }
    if (config.maxPerTransferKeep <= 0n || config.maxPerWallet24hKeep <= 0n
        || config.maxAggregate24hKeep <= 0n) {
      throw new Error('policy signer limits must all be positive');
    }
    if (config.maxPerTransferKeep > config.maxPerWallet24hKeep
        || config.maxPerWallet24hKeep > config.maxAggregate24hKeep) {
      throw new Error('policy signer limits must satisfy transfer <= wallet <= aggregate');
    }
    this.#config = config;
    this.#keypair = keypair;
    this.#now = now;
  }

  async #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async assertReady(): Promise<void> {
    await this.#serialized(async () => withExclusiveStateWrite(this.#config.stateFile, async () => {
      this.#cache = await readState(this.#config.stateFile, {
        mint: this.#config.keepMint, sourceOwner: this.#config.sourceOwner,
      }, this.#cache);
    }));
  }

  async prepare(value: unknown): Promise<SerializedPreparedKeepWithdrawal> {
    return this.#serialized(() => this.#prepareSerialized(value));
  }

  async #prepareSerialized(value: unknown): Promise<SerializedPreparedKeepWithdrawal> {
    let parsed: ReturnType<typeof parseWireRequest>;
    try { parsed = parseWireRequest(value); } catch (error) {
      throw new PolicySignerRequestError(error instanceof Error ? error.message : String(error));
    }
    const { wire, preparation } = parsed;
    if (wire.cluster !== this.#config.cluster
        || wire.mint !== this.#config.keepMint.toBase58()
        || wire.sourceOwner !== this.#config.sourceOwner.toBase58()) {
      throw new PolicySignerRequestError('policy signer custody identity mismatch');
    }

    const identity = { mint: this.#config.keepMint, sourceOwner: this.#config.sourceOwner };
    return withExclusiveStateWrite(this.#config.stateFile, async () => {
      this.#cache = await readState(this.#config.stateFile, identity, this.#cache);
      const index = this.#cache.index;
      const logical = logicalRequest(wire);
      const requestFingerprint = fingerprint(logical);
      const existing = index.byWithdrawal.get(wire.withdrawalId);
      if (existing) {
        if (existing.fingerprint !== requestFingerprint) {
          throw new PolicySignerPolicyRefusal('withdrawal id was already signed for different input');
        }
        return existing.prepared;
      }
      try { validateKeepWithdrawalPreparationRequest(preparation); } catch (error) {
        throw new PolicySignerRequestError(error instanceof Error ? error.message : String(error));
      }
      if (preparation.grossAmountKeep > this.#config.maxPerTransferKeep) {
        throw new PolicySignerPolicyRefusal('policy signer max-per-transfer exceeded');
      }
      if (preparation.walletRolling24hCapKeep > this.#config.maxPerWallet24hKeep) {
        throw new PolicySignerPolicyRefusal('worker wallet cap exceeds policy signer ceiling');
      }
      if (index.authorizationDigests.has(preparation.authorizationDigest)) {
        throw new PolicySignerPolicyRefusal('withdrawal authorization digest was already signed');
      }

      const now = this.#now();
      if (!Number.isFinite(now.getTime())) throw new Error('policy signer clock is invalid');
      if (now.getTime() < index.latestSignedAt) throw new Error('policy signer clock moved backwards');
      const cutoff = now.getTime() - WINDOW_MS;
      const walletUsed = rollingGrossAfter(index.byWallet.get(preparation.playerWallet), cutoff);
      const aggregateUsed = rollingGrossAfter(index.aggregate, cutoff);
      const effectiveWalletCap = preparation.walletRolling24hCapKeep < this.#config.maxPerWallet24hKeep
        ? preparation.walletRolling24hCapKeep
        : this.#config.maxPerWallet24hKeep;
      if (walletUsed + preparation.grossAmountKeep > effectiveWalletCap) {
        throw new PolicySignerPolicyRefusal('policy signer rolling wallet limit exceeded');
      }
      if (aggregateUsed + preparation.grossAmountKeep > this.#config.maxAggregate24hKeep) {
        throw new PolicySignerPolicyRefusal('policy signer aggregate circuit breaker exceeded');
      }

      let prepared;
      try {
        prepared = prepareKeepWithdrawalWithKeypair(
          preparation,
          this.#keypair,
          this.#config.keepMint,
          { blockhash: wire.recentBlockhash, lastValidBlockHeight: wire.lastValidBlockHeight },
        );
      } catch (error) {
        throw new PolicySignerRequestError(error instanceof Error ? error.message : String(error));
      }
      const serialized = serializePreparedKeepWithdrawal(prepared);
      const entry: PolicySignerEntry = {
        withdrawalId: wire.withdrawalId,
        fingerprint: requestFingerprint,
        signedAt: now.toISOString(),
        request: logical,
        prepared: serialized,
      };
      this.#cache = await appendStateEntry(this.#config.stateFile, this.#cache!, entry);
      return serialized;
    });
  }
}
