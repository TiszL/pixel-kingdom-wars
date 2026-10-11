/** C3 / eb8a5ec1: explicit LOCAL evidence step, before suite initialization.
 * Unit/validator cases never execute OpenSSL. Cedar3 selects this factory instead
 * of leagueFixture.ts for the admitted oracle-bound run. Only public bytes are
 * recorded; C1 retains all actor, validator and cleanup custody. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { LeagueFixtureHandle, LeagueFixtureSelection } from './runnerLifecycle';

const EMPTY = 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
// f5061e30: the reviewed macOS Homebrew OpenSSL 3 stays the default. Any other host (a Linux CI
// runner) names an absolute binary in PKW_LEAGUE_OPENSSL; createKeccakOracle still refuses a binary
// without KECCAK-256 or the empty-input known answer. No PATH lookup and no fallback.
export const OPENSSL_ENV = 'PKW_LEAGUE_OPENSSL';
export const REVIEWED_OPENSSL = '/opt/homebrew/opt/openssl@3/bin/openssl';
const PROGRAM = '2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE';
const CONFIG = 'Hf7Ku555kMYhiQhUa4dpUim3nk3kmSbV1Z1sWhisRWrV';
const U64_MAX = (1n << 64n) - 1n;

export type OracleCommand = (args: readonly string[], input?: Uint8Array) => {
  status: number | null; stdout: Buffer; stderr: Buffer;
};
export interface OracleInput {
  programIdHex: string; configHex: string; weekStart: string;
  leaves: Array<{ index: number; claimantHex: string; amount: string }>;
}
export interface KeccakOracle { version: string; knownAnswer: string; hash(bytes: Uint8Array): Buffer }
export interface OracleRecord {
  schema: 'league-independent-keccak/v1'; input: OracleInput; implementation: string; knownAnswer: string;
  rootHex: string; total: string;
  proofs: Array<Array<{ hashHex: string; sum: string; isLeft: boolean }>>;
  hashes: Array<{ preimageHex: string; digestHex: string }>;
}

export function resolveOpenSsl(env: Readonly<Record<string, string | undefined>>, isFile: (path: string) => boolean): string {
  const chosen = env[OPENSSL_ENV];
  if (chosen !== undefined) {
    if (!isAbsolute(chosen) || !isFile(chosen)) throw new Error(`${OPENSSL_ENV} must name an absolute OpenSSL executable file`);
    return chosen;
  }
  if (!isFile(REVIEWED_OPENSSL)) throw new Error(`No OpenSSL at ${REVIEWED_OPENSSL}; set ${OPENSSL_ENV} to an absolute OpenSSL with KECCAK-256`);
  return REVIEWED_OPENSSL;
}

/** No imports or fallbacks to noble, sha3 or a locally authored hash function. */
export function createKeccakOracle(command: OracleCommand): KeccakOracle {
  const algorithms = command(['list', '-digest-algorithms']);
  if (algorithms.status !== 0 || !/\bKECCAK-256\b/.test(algorithms.stdout.toString())) {
    throw new Error('KECCAK-256 unavailable: run the separate C3 evidence step with the reviewed OpenSSL; no fallback');
  }
  const hash = (bytes: Uint8Array): Buffer => {
    const result = command(['dgst', '-KECCAK-256', '-binary'], bytes);
    if (result.status !== 0 || result.stdout.length !== 32 || result.stderr.length !== 0) {
      throw new Error('OpenSSL digest failed; independent evidence was not produced');
    }
    return Buffer.from(result.stdout);
  };
  const knownAnswer = hash(new Uint8Array()).toString('hex');
  if (knownAnswer !== EMPTY) throw new Error('Keccak empty-input known-answer check failed');
  const version = command(['version']);
  if (version.status !== 0 || !version.stdout.toString().startsWith('OpenSSL ')) throw new Error('OpenSSL identity unavailable');
  return { hash, knownAnswer, version: version.stdout.toString().trim() };
}

/** Byte assembly only; OpenSSL provides every digest. Public input is copied. */
export function deriveOracleRecord(input: OracleInput, oracle: KeccakOracle): OracleRecord {
  const invalid = () => { throw new Error('Invalid oracle public input'); };
  const isKey = (value: string) => /^[0-9a-f]{64}$/.test(value);
  if (!isKey(input.programIdHex) || !isKey(input.configHex) || !/^-?(0|[1-9][0-9]*)$/.test(input.weekStart)
    || input.leaves.length === 0 || input.leaves.length > 1024) invalid();
  const start = BigInt(input.weekStart);
  if (start < -(1n << 63n) || start >= (1n << 63n)) invalid();
  const leaves = input.leaves.map(leaf => ({ ...leaf })).sort((a, b) => a.index - b.index);
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    if (!Number.isInteger(leaf.index) || leaf.index < 0 || leaf.index > 65535 || !isKey(leaf.claimantHex)
      || !/^[1-9][0-9]*$/.test(leaf.amount) || BigInt(leaf.amount) > U64_MAX
      || (i > 0 && leaves[i - 1].index === leaf.index)) invalid();
  }
  const hashes: OracleRecord['hashes'] = [];
  const digest = (bytes: Buffer) => {
    const result = oracle.hash(bytes);
    hashes.push({ preimageHex: bytes.toString('hex'), digestHex: result.toString('hex') });
    return result;
  };
  const u64 = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
  const week = Buffer.alloc(8); week.writeBigInt64LE(start);
  type Node = { hash: Buffer; sum: bigint; members: number[] };
  let level: Node[] = leaves.map((leaf, position) => {
    const index = Buffer.alloc(2); index.writeUInt16LE(leaf.index);
    return { hash: digest(Buffer.concat([Buffer.from([6]), Buffer.from(input.programIdHex, 'hex'),
      Buffer.from(input.configHex, 'hex'), week, index, Buffer.from(leaf.claimantHex, 'hex'), u64(BigInt(leaf.amount))])),
    sum: BigInt(leaf.amount), members: [position] };
  });
  const proofs: OracleRecord['proofs'] = leaves.map(() => []);
  while (level.length > 1) {
    const next: Node[] = [];
    for (let position = 0; position < level.length; position += 2) {
      const left = level[position], right = level[position + 1];
      if (!right) { next.push(left); continue; }
      const sum = left.sum + right.sum;
      if (sum > U64_MAX) throw new Error('Oracle sum overflow');
      for (const member of left.members) proofs[member].push({ hashHex: right.hash.toString('hex'), sum: right.sum.toString(), isLeft: false });
      for (const member of right.members) proofs[member].push({ hashHex: left.hash.toString('hex'), sum: left.sum.toString(), isLeft: true });
      next.push({ hash: digest(Buffer.concat([Buffer.from([7]), left.hash, u64(left.sum), right.hash, u64(right.sum)])),
        sum, members: [...left.members, ...right.members] });
    }
    level = next;
  }
  return { schema: 'league-independent-keccak/v1', input: { ...input, leaves }, implementation: oracle.version,
    knownAnswer: oracle.knownAnswer, rootHex: level[0].hash.toString('hex'), total: level[0].sum.toString(), proofs, hashes };
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function writeExclusive(path: string, value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (!readFileSync(path).equals(bytes)) throw new Error('Oracle evidence readback mismatch');
  return sha256(bytes);
}
interface Binding { path: string; sha256: string; record: OracleRecord }
const bindings = new WeakMap<object, Binding>();

/** Reads only the exact public file created by the selected oracle factory. */
export function requireOracleBinding(fixture: object): Binding {
  const binding = bindings.get(fixture);
  if (!binding) throw new Error('C3 oracle evidence missing: select leagueProofOracle.ts as the explicitly admitted fixture; no runtime oracle inside a test');
  const bytes = readFileSync(binding.path);
  if (sha256(bytes) !== binding.sha256) throw new Error('C3 oracle evidence changed after the pre-initialize freeze');
  const saved = JSON.parse(bytes.toString()) as { record: OracleRecord };
  return { path: binding.path, sha256: binding.sha256, record: saved.record };
}

/** Called only after the validator case has verified its finalized claims. */
export function recordOracleClaimResult(fixture: object, result: unknown): void {
  const binding = requireOracleBinding(fixture);
  writeExclusive(binding.path + '.claims.json', { step: 'C3-PINNED-ROOT-CLAIMS', evidenceSha256: binding.sha256,
    evidencePath: binding.path, rootHex: binding.record.rootHex, result });
}

/** Same bounded null-history retry as the suite's event() helper. A null
 * after ten retries still reaches the validator's existing loud refusal. RPC
 * failures propagate; no transaction is sent and no fallback is introduced. */
export async function readFinalizedTransactionWithRetry<T>(
  read: () => Promise<T | null>,
  wait: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<T | null> {
  let transaction = await read();
  for (let attempt = 0; transaction === null && attempt < 10; attempt++) {
    await wait(200);
    transaction = await read();
  }
  return transaction;
}

/** Named pre-suite step. Import alone has no side effects; C1 factory owns all
 * resource creation/disposal. Availability/KAT is checked BEFORE starting it. */
export async function leagueFixture(selection: LeagueFixtureSelection): Promise<LeagueFixtureHandle> {
  const output = process.env.PKW_LEAGUE_ORACLE_EVIDENCE_PATH;
  if (!output || !isAbsolute(output)) throw new Error('Explicit absolute PKW_LEAGUE_ORACLE_EVIDENCE_PATH is required for C3');
  const OPENSSL = resolveOpenSsl(process.env, path => { try { return statSync(path).isFile(); } catch { return false; } });
  const command: OracleCommand = (args, input) => {
    const result = spawnSync(OPENSSL, [...args], { input, timeout: 10_000, maxBuffer: 1_048_576 });
    return { status: result.status, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0) };
  };
  const oracle = createKeccakOracle(command);
  const implementationSha256 = sha256(readFileSync(OPENSSL));
  const { leagueFixture: create } = await import('./leagueFixture');
  const handle = await create(selection);
  try {
    const { validateFixtureSelection } = await import('./runnerOptions');
    validateFixtureSelection(handle.fixture, selection.admissionReceipt);
    const fixture = handle.fixture;
    // Use the SDK class supplied by the C1 actors; only public constructors/bytes.
    const PublicKey = fixture.actors.claimant.publicKey.constructor as typeof import('@solana/web3.js').PublicKey;
    const program = new PublicKey(PROGRAM);
    const config = PublicKey.findProgramAddressSync([Buffer.from('league_config')], program)[0];
    if (config.toBase58() !== CONFIG) throw new Error('C3 oracle config identity mismatch');
    const maxIndex = fixture.policy.maxPlaces - 1;
    if (maxIndex <= 1) throw new Error('C3 oracle requires the admitted three-place fixture');
    // Fixed past Monday is a wire fixture, independent of launch time/game policy.
    // Amounts and indexes match the existing production-codec validator case.
    const record = deriveOracleRecord({ programIdHex: program.toBuffer().toString('hex'),
      configHex: config.toBuffer().toString('hex'), weekStart: '345600', leaves: [
        { index: maxIndex, claimantHex: fixture.actors.claimant.publicKey.toBuffer().toString('hex'), amount: '19' },
        { index: 1, claimantHex: fixture.actors.second.publicKey.toBuffer().toString('hex'), amount: '31' },
        { index: 0, claimantHex: fixture.actors.claimant.publicKey.toBuffer().toString('hex'), amount: '23' },
      ] }, oracle);
    const genesisHash = await fixture.provider.connection.getGenesisHash();
    const evidenceSha256 = writeExclusive(output, { step: 'C3-INDEPENDENT-KECCAK-ORACLE',
      createdUtc: new Date().toISOString(), admissionReceipt: selection.admissionReceipt,
      rpcEndpoint: fixture.provider.connection.rpcEndpoint, genesisHash,
      command: [OPENSSL, 'dgst', '-KECCAK-256', '-binary'], implementationSha256, record });
    bindings.set(fixture, { path: output, sha256: evidenceSha256, record });
    console.log(`C3-INDEPENDENT-KECCAK-ORACLE ${evidenceSha256} root=${record.rootHex}`);
    return handle;
  } catch (error: unknown) {
    try { await handle.dispose(); }
    catch (cleanupError: unknown) { throw new AggregateError([error, cleanupError], 'C3 oracle step and C1 cleanup failed'); }
    throw error;
  }
}
