/**
 * Anchor program clients + PDA derivation for shardkeep-core / -distributor.
 * IDLs are committed copies of programs/target/idl (re-copy after any program
 * change — the /devnet-deploy skill does this).
 */
// Anchor 0.32 is CommonJS. Under the production `node --import tsx` runtime,
// `await import()` is transformed to a namespace without `.default`; the
// package's BN re-export is reliable only through the runtime object, which
// anchorRuntime.ts resolves for both the ESM and the CJS (programs/*.ts) loaders.
// Keep this boundary aligned with bootstrap.ts.
import * as anchor from '@coral-xyz/anchor';
import { anchorRuntime as anchorPkg } from './anchorRuntime';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import coreIdl from './idl/shardkeep_core.json' with { type: 'json' };
import distributorIdl from './idl/shardkeep_distributor.json' with { type: 'json' };

export const CORE_PROGRAM_ID = new PublicKey((coreIdl as { address: string }).address);
export const DISTRIBUTOR_PROGRAM_ID = new PublicKey((distributorIdl as { address: string }).address);

export function makeProvider(connection: Connection, payer: Keypair): anchor.AnchorProvider {
  return new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: 'confirmed' });
}

export function coreProgram(provider: anchor.AnchorProvider): anchor.Program {
  return new anchor.Program(coreIdl as anchor.Idl, provider);
}

export function distributorProgram(provider: anchor.AnchorProvider): anchor.Program {
  return new anchor.Program(distributorIdl as anchor.Idl, provider);
}

// --- PDAs (seeds must mirror the on-chain constants) -----------------------

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('config')], CORE_PROGRAM_ID)[0];
}

function derivePlayerPda(wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('player'), wallet.toBuffer()],
    CORE_PROGRAM_ID,
  );
}

export function playerPda(wallet: PublicKey): PublicKey {
  return derivePlayerPda(wallet)[0];
}

type IdlAccountDiscriminator = { name: string; discriminator: number[] };

function accountDiscriminator(name: string): Buffer {
  const account = (coreIdl as { accounts?: IdlAccountDiscriminator[] }).accounts
    ?.find((candidate) => candidate.name === name);
  if (!account || account.discriminator.length !== 8) {
    throw new Error(`committed shardkeep-core IDL has no valid ${name} discriminator`);
  }
  return Buffer.from(account.discriminator);
}

const PLAYER_ACCOUNT_DISCRIMINATOR = accountDiscriminator('Player');
// Anchor discriminator + Pubkey + i64 + u8 + u8 + bump.
const PLAYER_ACCOUNT_SIZE = 8 + 32 + 8 + 1 + 1 + 1;

/**
 * Validate finalized Player-PDA evidence before an off-chain caller treats the
 * account as proof of `pay_entry`. Merely finding an account at a predictable
 * PDA is insufficient: anyone can pre-fund that address as a system account.
 */
export function isCanonicalPlayerAccount(
  address: PublicKey,
  wallet: PublicKey,
  account: { owner: PublicKey; executable: boolean; data: Uint8Array } | null,
): boolean {
  if (!account || account.executable || !account.owner.equals(CORE_PROGRAM_ID)) return false;
  const [expectedAddress, expectedBump] = derivePlayerPda(wallet);
  if (!address.equals(expectedAddress)) return false;

  const data = Buffer.from(account.data);
  return data.length === PLAYER_ACCOUNT_SIZE
    && data.subarray(0, 8).equals(PLAYER_ACCOUNT_DISCRIMINATOR)
    && data.subarray(8, 40).equals(wallet.toBuffer())
    && data[PLAYER_ACCOUNT_SIZE - 1] === expectedBump;
}

export function epochRootPda(epoch: bigint): PublicKey {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(epoch);
  return PublicKey.findProgramAddressSync([Buffer.from('root'), le], CORE_PROGRAM_ID)[0];
}

export function distributorPda(keepMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('distributor'), keepMint.toBuffer()],
    DISTRIBUTOR_PROGRAM_ID,
  )[0];
}

export function vaultAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('vault')], DISTRIBUTOR_PROGRAM_ID)[0];
}

export function claimStatusPda(distributor: PublicKey, claimant: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), distributor.toBuffer(), claimant.toBuffer()],
    DISTRIBUTOR_PROGRAM_ID,
  )[0];
}

// --- Payment events (deposit watcher, ARCHITECTURE §5) ----------------------

/** PaymentMade event decoded from a finalized tx's logs. */
export interface PaymentMadeEvent {
  wallet: string;
  /** 0 = entry, 1 = builder, 2 = expansion (program constant). */
  kind: number;
  lamports: bigint;
  reference: string;
}

/**
 * Parse PaymentMade events from tx log messages, SCOPED to shardkeep-core's
 * execution frames. Anchor's EventParser tracks the invoke/success log stack,
 * so "Program data:" lines emitted by OTHER programs in the same tx can never
 * be attributed to us — a malicious program cannot forge a PaymentMade.
 */
export function parsePaymentMadeEvents(logs: string[]): PaymentMadeEvent[] {
  const parser = new anchor.EventParser(CORE_PROGRAM_ID, new anchor.BorshCoder(coreIdl as anchor.Idl));
  const out: PaymentMadeEvent[] = [];
  for (const ev of parser.parseLogs(logs)) {
    if (ev.name !== 'paymentMade' && ev.name !== 'PaymentMade') continue;
    const d = ev.data as { wallet: PublicKey; kind: number; lamports: { toString(): string }; reference: PublicKey };
    out.push({
      wallet: d.wallet.toBase58(),
      kind: d.kind,
      lamports: BigInt(d.lamports.toString()),
      reference: d.reference.toBase58(),
    });
  }
  return out;
}

/** Post a weekly liabilities root on-chain (init-once EpochRoot PDA). */
export function encodePostRootArgs(epoch: bigint, root: Uint8Array, totalBalance: bigint) {
  const u64Max = (1n << 64n) - 1n;
  if (epoch < 0n || epoch > u64Max) throw new RangeError('post_root epoch must fit u64');
  if (totalBalance < 0n || totalBalance > u64Max) {
    throw new RangeError('post_root total balance must fit u64');
  }
  if (root.length !== 32) throw new RangeError('post_root root must be exactly 32 bytes');
  return [
    new anchorPkg.BN(epoch.toString()),
    Array.from(root),
    new anchorPkg.BN(totalBalance.toString()),
  ] as const;
}

const EPOCH_ROOT_ACCOUNT_DISCRIMINATOR = Uint8Array.from([84, 115, 245, 96, 45, 165, 224, 31]);
const POST_ROOT_INSTRUCTION_DISCRIMINATOR = Uint8Array.from([154, 210, 156, 158, 199, 27, 174, 35]);
const ROOT_SIGNATURE_SCAN_LIMIT = 20;

export class EpochRootMismatchError extends Error {
  constructor(epoch: bigint) {
    super(`epoch ${epoch} already has different on-chain root data`);
    this.name = 'EpochRootMismatchError';
  }
}

export class EpochRootSignatureIndeterminateError extends Error {
  constructor(epoch: bigint) {
    super(
      `exact post_root signature for epoch ${epoch} is outside the bounded recent history; `
      + 'operator recovery is required',
    );
    this.name = 'EpochRootSignatureIndeterminateError';
  }
}

export class EpochRootRecoverySignatureError extends Error {
  constructor(epoch: bigint) {
    super(`configured recovery signature does not prove exact post_root for epoch ${epoch}`);
    this.name = 'EpochRootRecoverySignatureError';
  }
}

function decodeEpochRootAccount(data: Uint8Array): {
  epoch: bigint;
  root: Uint8Array;
  totalBalance: bigint;
} {
  // 8 discriminator + u64 epoch + [u8;32] root + u64 total + i64 posted_at + u8 bump.
  if (data.length !== 65
    || !Buffer.from(data.subarray(0, 8)).equals(Buffer.from(EPOCH_ROOT_ACCOUNT_DISCRIMINATOR))) {
    throw new Error('invalid shardkeep-core EpochRoot account data');
  }
  const bytes = Buffer.from(data);
  return {
    epoch: bytes.readBigUInt64LE(8),
    root: bytes.subarray(16, 48),
    totalBalance: bytes.readBigUInt64LE(48),
  };
}

function postRootInstructionData(epoch: bigint, root: Uint8Array, totalBalance: bigint): Buffer {
  encodePostRootArgs(epoch, root, totalBalance);
  const data = Buffer.alloc(56);
  data.set(POST_ROOT_INSTRUCTION_DISCRIMINATOR, 0);
  data.writeBigUInt64LE(epoch, 8);
  data.set(root, 16);
  data.writeBigUInt64LE(totalBalance, 48);
  return data;
}

type RootTransaction = NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>;

function isExactPostRootTransaction(
  tx: RootTransaction,
  pda: PublicKey,
  epoch: bigint,
  root: Uint8Array,
  totalBalance: bigint,
): boolean {
  if (!tx.meta || tx.meta.err !== null) return false;
  const message = tx.transaction.message;
  const loaded = tx.meta?.loadedAddresses;
  const keys = loaded
    ? message.getAccountKeys({ accountKeysFromLookups: loaded })
    : message.getAccountKeys();
  const expectedData = postRootInstructionData(epoch, root, totalBalance);
  for (const instruction of message.compiledInstructions) {
    if (!keys.get(instruction.programIdIndex)?.equals(CORE_PROGRAM_ID)
      || instruction.accountKeyIndexes.length !== 4
      || !Buffer.from(instruction.data).equals(expectedData)) continue;
    // Historical admin is deliberately not compared with today's admin: a
    // successful post_root already proved Signer + config.has_one at its slot,
    // and authority may rotate before an ambiguous response is reconciled.
    const [configIndex, historicalAdminIndex, rootIndex, systemIndex] = instruction.accountKeyIndexes;
    if (keys.get(configIndex!)?.equals(configPda()) === true
      && keys.get(historicalAdminIndex!) !== undefined
      && keys.get(rootIndex!)?.equals(pda) === true
      && keys.get(systemIndex!)?.equals(SystemProgram.programId) === true) return true;
  }
  return false;
}

async function exactPostRootSignature(
  connection: Connection,
  pda: PublicKey,
  epoch: bigint,
  root: Uint8Array,
  totalBalance: bigint,
  recoverySignature?: string,
): Promise<string> {
  if (recoverySignature) {
    const recovered = await connection.getTransaction(recoverySignature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    if (recovered && isExactPostRootTransaction(recovered, pda, epoch, root, totalBalance)) {
      return recoverySignature;
    }
    throw new EpochRootRecoverySignatureError(epoch);
  }
  // One bounded page and one batched transaction lookup: public references to a
  // predictable PDA cannot amplify a retry into hundreds of sequential RPCs.
  const signatures = await connection.getSignaturesForAddress(
    pda, { limit: ROOT_SIGNATURE_SCAN_LIMIT }, 'confirmed',
  );
  const successful = signatures.filter((candidate) => !candidate.err);
  const transactions = successful.length === 0 ? [] : await connection.getTransactions(
    successful.map((candidate) => candidate.signature),
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  );
  for (let txIndex = 0; txIndex < transactions.length; txIndex++) {
    const tx = transactions[txIndex];
    if (tx && isExactPostRootTransaction(tx, pda, epoch, root, totalBalance)) {
      return successful[txIndex]!.signature;
    }
  }
  throw new EpochRootSignatureIndeterminateError(epoch);
}

async function matchingEpochRootSignature(
  connection: Connection,
  epoch: bigint,
  root: Uint8Array,
  totalBalance: bigint,
  recoverySignature?: string,
): Promise<string | null> {
  const pda = epochRootPda(epoch);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info) {
    if (recoverySignature) throw new EpochRootRecoverySignatureError(epoch);
    return null;
  }
  // Anchor `init` deliberately supports a predictable PDA that was dust-funded
  // before initialization: it allocates and assigns this exact empty system
  // account. Every other unexpected owner/shape is a real conflict.
  if (info.owner.equals(SystemProgram.programId) && !info.executable && info.data.length === 0) {
    if (recoverySignature) throw new EpochRootRecoverySignatureError(epoch);
    return null;
  }
  if (!info.owner.equals(CORE_PROGRAM_ID)) throw new EpochRootMismatchError(epoch);
  const existing = decodeEpochRootAccount(info.data);
  if (existing.epoch !== epoch || existing.totalBalance !== totalBalance
    || !Buffer.from(existing.root).equals(Buffer.from(root))) {
    throw new EpochRootMismatchError(epoch);
  }
  return exactPostRootSignature(connection, pda, epoch, root, totalBalance, recoverySignature);
}

/** Reconcile the immutable PDA before sending and after an ambiguous RPC error.
 * This keeps a landed post_root from retrying forever. Normal sends return the
 * transaction signature; reconciliation recovers that exact posting signature. */
export async function postEpochRootIdempotently(
  connection: Connection,
  epoch: bigint,
  root: Uint8Array,
  totalBalance: bigint,
  submit: () => Promise<string>,
  recoverySignature?: string,
): Promise<string> {
  encodePostRootArgs(epoch, root, totalBalance);
  const existing = await matchingEpochRootSignature(
    connection, epoch, root, totalBalance, recoverySignature,
  );
  if (existing) return existing;
  try {
    return await submit();
  } catch (submitError) {
    try {
      const landed = await matchingEpochRootSignature(
        connection, epoch, root, totalBalance, recoverySignature,
      );
      if (landed) return landed;
    } catch (reconcileError) {
      if (reconcileError instanceof EpochRootMismatchError) throw reconcileError;
      throw new AggregateError(
        [submitError, reconcileError],
        `post_root failed and epoch ${epoch} reconciliation was indeterminate`,
      );
    }
    throw submitError;
  }
}

export async function postEpochRoot(
  connection: Connection,
  admin: Keypair,
  epoch: bigint,
  root: Uint8Array,
  totalBalance: bigint,
  recoverySignature?: string,
): Promise<string> {
  const args = encodePostRootArgs(epoch, root, totalBalance);
  return postEpochRootIdempotently(connection, epoch, root, totalBalance, async () => {
    const provider = makeProvider(connection, admin);
    const program = coreProgram(provider);
    return program.methods['postRoot']!(...args)
      .accounts({ admin: admin.publicKey })
      .rpc();
  }, recoverySignature);
}
