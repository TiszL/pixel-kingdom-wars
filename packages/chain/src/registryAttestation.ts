/** Fail-closed on-chain attestation for a mainnet public address registry. */
import { createHash } from 'node:crypto';
import anchorPkg, * as anchor from '@coral-xyz/anchor';
import { MPL_CORE_PROGRAM_ID, deserializeCollectionV1 } from '@metaplex-foundation/mpl-core';
import { createAmount, publicKey as toUmiPk, type RpcAccount } from '@metaplex-foundation/umi';
import { TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import {
  LAMPORTS_PER_SOL, PublicKey, SystemProgram, type AccountInfo, type Connection,
} from '@solana/web3.js';
import { CAPS, ECONOMY, TOKEN } from '@shardkeep/shared';
import type { ChainAddresses, ReviewedProgramDeployment } from './bootstrap';
import { CORE_PROGRAM_ID, DISTRIBUTOR_PROGRAM_ID } from './programs';
import coreIdl from './idl/shardkeep_core.json' with { type: 'json' };

// Anchor's CommonJS package has no default under the programs/ TSX entrypoint;
// native ESM consumers still use its default. Preserve both import shapes.
const { BorshAccountsCoder } = anchorPkg ?? anchor;
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_STATE_TAG = 2;
const PROGRAM_DATA_STATE_TAG = 3;
const PROGRAM_ACCOUNT_DATA_LENGTH = 36;
const PROGRAM_DATA_METADATA_LENGTH = 45;

type CoreConfigAccount = {
  keepMint: PublicKey;
  treasuryLiquidity: PublicKey;
  treasuryDev: PublicKey;
  treasuryOps: PublicKey;
  splits: number[];
  prices: {
    entryLamports: { toString(): string };
    builderLamports: Array<{ toString(): string }>;
    expansionLamports: { toString(): string };
  };
  paused: boolean;
};

/** A mainnet registry is a reviewed deployment manifest, so it must say
 * whether each KEEP authority is deliberately revoked (`null`) or retained by
 * one exact public key. Devnet is intentionally outside this attestation and
 * may keep its current alpha authorities. */
export interface ReviewedKeepMintAuthorities {
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

function assertAddress(actual: PublicKey, expected: string, label: string): void {
  if (actual.toBase58() !== expected) {
    throw new Error(`mainnet registry ${label} mismatch: chain=${actual.toBase58()} registry=${expected}`);
  }
}

function umiAccount(publicKey: PublicKey, account: AccountInfo<Buffer>): RpcAccount {
  return {
    publicKey: toUmiPk(publicKey.toBase58()),
    executable: account.executable,
    owner: toUmiPk(account.owner.toBase58()),
    lamports: createAmount(account.lamports, 'SOL', 9),
    data: new Uint8Array(account.data),
  };
}

async function requiredAccount(
  connection: Connection,
  address: PublicKey,
  label: string,
): Promise<AccountInfo<Buffer>> {
  const account = await connection.getAccountInfo(address, 'finalized');
  if (!account) throw new Error(`mainnet registry ${label} account does not exist: ${address.toBase58()}`);
  return account;
}

function assertExecutableProgram(account: AccountInfo<Buffer>, label: string): void {
  if (!account.executable || !account.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error(`mainnet registry ${label} is not an upgradeable executable program`);
  }
}

function stateTag(data: Buffer, label: string): number {
  if (data.length < 4) throw new Error(`mainnet registry ${label} loader state is truncated`);
  return data.readUInt32LE(0);
}

/** Decode the Program account's canonical pointer without trusting registry
 * input. UpgradeableLoaderState uses a four-byte little-endian enum tag. */
export function decodeUpgradeableProgramDataAddress(data: Buffer): PublicKey {
  if (data.length !== PROGRAM_ACCOUNT_DATA_LENGTH
      || stateTag(data, 'program') !== PROGRAM_STATE_TAG) {
    throw new Error('mainnet registry program has malformed upgradeable-loader state');
  }
  return new PublicKey(data.subarray(4, PROGRAM_ACCOUNT_DATA_LENGTH));
}

/** Decode only the fixed ProgramData metadata. Program bytes always begin at
 * offset 45; revoked authority uses Option::None but does not shift the ELF. */
export function decodeProgramDataUpgradeAuthority(data: Buffer): PublicKey | null {
  if (data.length < PROGRAM_DATA_METADATA_LENGTH
      || stateTag(data, 'ProgramData') !== PROGRAM_DATA_STATE_TAG) {
    throw new Error('mainnet registry ProgramData has malformed upgradeable-loader state');
  }
  const option = data[12];
  if (option === 0) return null;
  if (option !== 1) {
    throw new Error('mainnet registry ProgramData has invalid upgrade-authority option');
  }
  return new PublicKey(data.subarray(13, PROGRAM_DATA_METADATA_LENGTH));
}

function requiredProgramDeploymentPolicy(
  policy: unknown,
  label: string,
): { programDataAddress: PublicKey; programDataSha256: string; upgradeAuthority: PublicKey | null } {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`mainnet registry requires reviewed ${label} ProgramData policy`);
  }
  const record = policy as Partial<ReviewedProgramDeployment>;
  let programDataAddress: PublicKey;
  try {
    programDataAddress = new PublicKey(record.programDataAddress!);
  } catch {
    throw new Error(`mainnet registry ${label} has invalid ProgramData address`);
  }
  if (typeof record.programDataSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(record.programDataSha256)) {
    throw new Error(`mainnet registry ${label} has invalid ProgramData SHA-256`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'upgradeAuthority')) {
    throw new Error(`mainnet registry ${label} is missing expected upgrade authority state`);
  }
  let upgradeAuthority: PublicKey | null;
  if (record.upgradeAuthority === null) {
    upgradeAuthority = null;
  } else {
    try {
      upgradeAuthority = new PublicKey(record.upgradeAuthority!);
    } catch {
      throw new Error(`mainnet registry ${label} has invalid expected upgrade authority`);
    }
  }
  return { programDataAddress, programDataSha256: record.programDataSha256, upgradeAuthority };
}

/** Bind a program ID to the exact reviewed ProgramData account, full account
 * data hash, and authority state. This detects a redirected Program account,
 * an unreviewed upgrade, and an authority rotation independently. */
export async function assertReviewedProgramDeployment(
  connection: Connection,
  programId: PublicKey,
  policy: unknown,
  label: string,
): Promise<void> {
  const expected = requiredProgramDeploymentPolicy(policy, label);
  const program = await requiredAccount(connection, programId, `${label} program`);
  assertExecutableProgram(program, `${label} program`);
  const actualProgramDataAddress = decodeUpgradeableProgramDataAddress(program.data);
  if (!actualProgramDataAddress.equals(expected.programDataAddress)) {
    throw new Error(
      `mainnet registry ${label} ProgramData address mismatch: `
      + `chain=${actualProgramDataAddress.toBase58()} registry=${expected.programDataAddress.toBase58()}`,
    );
  }

  const programData = await requiredAccount(
    connection, actualProgramDataAddress, `${label} ProgramData`,
  );
  if (programData.executable || !programData.owner.equals(UPGRADEABLE_LOADER)) {
    throw new Error(`mainnet registry ${label} ProgramData is not owned by the upgradeable loader`);
  }
  const actualHash = createHash('sha256').update(programData.data).digest('hex');
  if (actualHash !== expected.programDataSha256) {
    throw new Error(
      `mainnet registry ${label} ProgramData SHA-256 mismatch: `
      + `chain=${actualHash} registry=${expected.programDataSha256}`,
    );
  }
  const actualAuthority = decodeProgramDataUpgradeAuthority(programData.data);
  if (actualAuthority?.toBase58() !== expected.upgradeAuthority?.toBase58()) {
    throw new Error(
      `mainnet registry ${label} upgrade authority mismatch: `
      + `chain=${actualAuthority?.toBase58() ?? 'immutable'} `
      + `registry=${expected.upgradeAuthority?.toBase58() ?? 'immutable'}`,
    );
  }
}

function requiredPolicyAuthority(
  policy: Partial<ReviewedKeepMintAuthorities>,
  key: keyof ReviewedKeepMintAuthorities,
): PublicKey | null {
  if (!Object.prototype.hasOwnProperty.call(policy, key)) {
    throw new Error(`mainnet registry KEEP authority policy is missing ${key}`);
  }
  const expected = policy[key];
  if (expected === null) return null;
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new Error(`mainnet registry KEEP authority policy has invalid ${key}`);
  }
  try {
    return new PublicKey(expected);
  } catch {
    throw new Error(`mainnet registry KEEP authority policy has invalid ${key}`);
  }
}

/** Match the live mint to the exact authority state approved in the public
 * mainnet deployment manifest. A declaration of `null` means irrevocably
 * revoked; a key means deliberately retained by that exact authority. */
export function assertReviewedKeepMintAuthorities(
  addresses: ChainAddresses,
  actual: { mintAuthority: PublicKey | null; freezeAuthority: PublicKey | null },
): void {
  const policy = addresses.keepMintAuthorities;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('mainnet registry requires an explicit KEEP mint/freeze authority policy');
  }
  for (const key of ['mintAuthority', 'freezeAuthority'] as const) {
    const expected = requiredPolicyAuthority(policy, key);
    const observed = actual[key];
    if (expected?.toBase58() !== observed?.toBase58()) {
      throw new Error(
        `mainnet KEEP ${key} mismatch: chain=${observed?.toBase58() ?? 'revoked'} `
        + `registry=${expected?.toBase58() ?? 'revoked'}`,
      );
    }
  }
}

/**
 * Prove every identity that can move or recognize player value. Run this
 * independently through both configured mainnet RPC providers before opening
 * the database or serving routes.
 */
export async function assertMainnetAddressRegistry(
  connection: Connection,
  addresses: ChainAddresses,
): Promise<void> {
  if (addresses.cluster !== 'mainnet-beta') {
    throw new Error('strict chain registry attestation is reserved for mainnet-beta');
  }
  const coreProgram = new PublicKey(addresses.coreProgram);
  if (!coreProgram.equals(CORE_PROGRAM_ID)) {
    throw new Error(`mainnet registry core program must equal reviewed IDL ${CORE_PROGRAM_ID.toBase58()}`);
  }
  const deployments = addresses.programDeployments;
  if (!deployments || typeof deployments !== 'object' || Array.isArray(deployments)) {
    throw new Error('mainnet registry requires reviewed Anchor ProgramData policies');
  }
  await assertReviewedProgramDeployment(connection, coreProgram, deployments.core, 'core');

  if (addresses.distributorProgram) {
    const distributor = new PublicKey(addresses.distributorProgram);
    if (!distributor.equals(DISTRIBUTOR_PROGRAM_ID)) {
      throw new Error(
        `mainnet registry distributor must equal reviewed IDL ${DISTRIBUTOR_PROGRAM_ID.toBase58()}`,
      );
    }
    await assertReviewedProgramDeployment(
      connection, distributor, deployments.distributor, 'distributor',
    );
    if (deployments.core.programDataAddress === deployments.distributor?.programDataAddress) {
      throw new Error('mainnet registry core and distributor cannot share one ProgramData account');
    }
  } else if (deployments.distributor !== undefined) {
    throw new Error('mainnet registry has distributor ProgramData policy without a distributor program');
  }

  const canonicalConfig = PublicKey.findProgramAddressSync(
    [Buffer.from('config')], coreProgram,
  )[0];
  assertAddress(canonicalConfig, addresses.config, 'Config PDA');
  const configInfo = await requiredAccount(connection, canonicalConfig, 'Config');
  if (!configInfo.owner.equals(coreProgram)) {
    throw new Error('mainnet registry Config is not owned by shardkeep-core');
  }
  const coder = new BorshAccountsCoder(coreIdl as anchor.Idl);
  const config = coder.decode<CoreConfigAccount>('Config', configInfo.data);
  assertAddress(config.keepMint, addresses.keepMint, 'Config KEEP mint');
  assertAddress(config.treasuryLiquidity, addresses.treasuries.liquidity, 'liquidity treasury');
  assertAddress(config.treasuryDev, addresses.treasuries.dev, 'development treasury');
  assertAddress(config.treasuryOps, addresses.treasuries.ops, 'operations treasury');
  for (const [label, address] of Object.entries(addresses.treasuries)) {
    const treasury = await requiredAccount(connection, new PublicKey(address), `${label} treasury`);
    if (treasury.executable || !treasury.owner.equals(SystemProgram.programId)) {
      throw new Error(`mainnet registry ${label} treasury is not a plain system account`);
    }
  }
  const expectedSplits = [
    ECONOMY.solSplitBps.liquidity, ECONOMY.solSplitBps.dev, ECONOMY.solSplitBps.ops,
  ];
  if (config.splits.length !== expectedSplits.length
      || config.splits.some((value, index) => value !== expectedSplits[index])) {
    throw new Error('mainnet shardkeep-core SOL split does not match the reviewed economy constants');
  }
  const expectedEntryLamports = BigInt(Math.round(ECONOMY.entryFeeSol * LAMPORTS_PER_SOL));
  if (BigInt(config.prices.entryLamports.toString()) !== expectedEntryLamports) {
    throw new Error('mainnet shardkeep-core entry price does not match the reviewed economy constants');
  }
  const expectedBuilderLamports = CAPS.builderPricesSol.slice(0, 2)
    .map((price) => BigInt(Math.round(price * LAMPORTS_PER_SOL)));
  if (config.prices.builderLamports.length !== expectedBuilderLamports.length
      || config.prices.builderLamports.some((value, index) => (
        BigInt(value.toString()) !== expectedBuilderLamports[index]
      ))) {
    throw new Error('mainnet shardkeep-core legacy builder prices do not match reviewed constants');
  }
  const expectedExpansionLamports = BigInt(Math.round(CAPS.expansionPriceSol * LAMPORTS_PER_SOL));
  if (BigInt(config.prices.expansionLamports.toString()) !== expectedExpansionLamports) {
    throw new Error('mainnet shardkeep-core legacy expansion price does not match reviewed constants');
  }
  if (config.paused) {
    throw new Error('mainnet shardkeep-core is paused; refuse to open payment routes');
  }

  const mintAddress = new PublicKey(addresses.keepMint);
  const mintInfo = await requiredAccount(connection, mintAddress, 'KEEP mint');
  const mint = unpackMint(mintAddress, mintInfo, TOKEN_PROGRAM_ID);
  if (mint.decimals !== TOKEN.decimals || !mint.isInitialized) {
    throw new Error(`mainnet KEEP mint must be initialized with ${TOKEN.decimals} decimals`);
  }
  assertReviewedKeepMintAuthorities(addresses, mint);

  if (!addresses.deedCollection) {
    throw new Error('mainnet registry requires a Metaplex Core deed collection');
  }
  const collectionAddress = new PublicKey(addresses.deedCollection);
  const collectionInfo = await requiredAccount(connection, collectionAddress, 'deed collection');
  if (collectionInfo.executable || collectionInfo.owner.toBase58() !== MPL_CORE_PROGRAM_ID.toString()) {
    throw new Error('mainnet deed collection is not owned by the Metaplex Core program');
  }
  try {
    deserializeCollectionV1(umiAccount(collectionAddress, collectionInfo));
  } catch (error) {
    throw new Error(`mainnet deed collection account is malformed: ${String(error)}`);
  }
}
