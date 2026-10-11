/** C1 / review N2 1ffb475d and runbook F5. Importing this module starts nothing.
 * Only the separately admitted runner calls the factory. Seven disposable actor
 * wallets stay in memory; seeded token accounts require no additional keys.
 * An admission receipt is recorded metadata, never authorization by itself. */
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { ACCOUNT_SIZE, MINT_SIZE, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMint2Instruction,
  createInitializeAccount3Instruction, createMintToCheckedInstruction, createSetAuthorityInstruction,
  getAssociatedTokenAddressSync, getMint, getAccount } from '@solana/spl-token';
import { LEAGUES, PHASE_E_LEAGUE_REWARDS } from '../../packages/shared/src/constants';
import type { LeagueValidatorFixture } from './shardkeep-league';
import { assertLeaguePortsAvailable, startLeagueValidator } from './leagueFixtureLifecycle';

export const LEAGUE_FIXTURE_ROLES = ['admin', 'guardian', 'funder', 'claimant', 'second', 'stranger', 'nextAdmin'] as const;
export const LEAGUE_FIXTURE_RPC = 'http://127.0.0.1:18899';
/** Explicit F5 test window; never a replacement for the shared production window. */
export const LEAGUE_FIXTURE_WINDOW_SEC = 120;
const LEAGUE_ID = new PublicKey('2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE');
const CORE_ID = new PublicKey('mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b');
const LOADER_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// Local fixture denominations, not game reward policy or deployment mint choices.
const FIXTURE_DECIMALS = 9;
const ACTOR_SOL_LAMPORTS = 2_000_000_000;
const FUNDER_TOKEN_RAW = 1_000_000n;
type Role = typeof LEAGUE_FIXTURE_ROLES[number];
export type LeagueFixtureActors = LeagueValidatorFixture['actors'];
export type LeagueFixtureAccounts = Pick<LeagueValidatorFixture, 'mint' | 'mintWithMintAuthority' | 'mintWithFreezeAuthority'
  | 'otherMint' | 'token2022Mint' | 'noncanonicalClaimantAccount' | 'noncanonicalSweepAccount'>;
export interface LeagueFixtureOptions { admissionReceipt: string; programsDirectory: string }
export interface LeagueFixtureHandle { fixture: LeagueValidatorFixture; dispose: () => Promise<void> }
export interface LeagueFixturePlan {
  accounts: LeagueFixtureAccounts;
  batches: Array<{ name: string; instructions: TransactionInstruction[] }>;
}
export interface LeagueFixtureDependencies {
  readPublicFile: (path: string) => Promise<Buffer>;
  ensurePortsFree: () => Promise<void>;
  generateWallet: (role: Role) => AnchorProvider['wallet'];
  startValidator: (input: Parameters<typeof startLeagueValidator>[0]) => ReturnType<typeof startLeagueValidator>;
  makeProvider: (connection: Connection, wallet: AnchorProvider['wallet']) => AnchorProvider;
  provision: (provider: AnchorProvider, actors: LeagueFixtureActors) => Promise<LeagueFixtureAccounts>;
  verify: (provider: AnchorProvider, actors: LeagueFixtureActors, accounts: LeagueFixtureAccounts) => Promise<void>;
}
function need(value: unknown, detail: string): asserts value { if (!value) throw new Error(`league fixture: ${detail}`); }
function key(value: PublicKey): PublicKey {
  need(value instanceof PublicKey && !value.equals(PublicKey.default), 'public actor/account address required');
  return new PublicKey(value.toBytes());
}
export function deriveLeagueFixturePolicy(source: { maxPlaces: number; claimWindowMaxSec: number; settlementDelayMs: number } = {
  maxPlaces: PHASE_E_LEAGUE_REWARDS.v1.skr.maxPlaces,
  claimWindowMaxSec: PHASE_E_LEAGUE_REWARDS.v1.skr.claimWindowMaxSec,
  settlementDelayMs: LEAGUES.settlementDelayMs,
}): LeagueValidatorFixture['policy'] {
  // The adversarial suite deliberately uses sparse entitlement index seven.
  need(Number.isSafeInteger(source.maxPlaces) && source.maxPlaces >= 8 && source.maxPlaces <= 1024
    && Number.isSafeInteger(source.claimWindowMaxSec) && source.claimWindowMaxSec > LEAGUE_FIXTURE_WINDOW_SEC
    && Number.isSafeInteger(source.settlementDelayMs) && source.settlementDelayMs > 0
    && source.settlementDelayMs % 1000 === 0, 'shared policy is missing, unsafe or incompatible with the fixture');
  return { maxPlaces: source.maxPlaces, claimWindowMaxSec: BigInt(source.claimWindowMaxSec), settlementDelaySec: BigInt(source.settlementDelayMs / 1000) };
}

/** Public-address transaction recipe. Only the admin signs these instructions;
 * mint and noncanonical account addresses use System createAccountWithSeed. */
export async function buildLeagueFixturePlan(actors: Record<Role, PublicKey>, rent: { mint: number; token: number }): Promise<LeagueFixturePlan> {
  for (const amount of [rent.mint, rent.token]) need(Number.isSafeInteger(amount) && amount > 0, 'rent quotes must be safe positive integers');
  const keys = Object.fromEntries(LEAGUE_FIXTURE_ROLES.map(role => [role, key(actors[role])])) as Record<Role, PublicKey>;
  need(new Set(Object.values(keys).map(value => value.toBase58())).size === LEAGUE_FIXTURE_ROLES.length, 'actors must be distinct');
  const admin = keys.admin;
  const batches: LeagueFixturePlan['batches'] = [{ name: 'fund-actors', instructions: LEAGUE_FIXTURE_ROLES
    .filter(role => role !== 'admin').map(role => SystemProgram.transfer({ fromPubkey: admin, toPubkey: keys[role], lamports: ACTOR_SOL_LAMPORTS })) }];
  const mints = [
    { field: 'mint', name: 'good', seed: 'league-good-mint', program: TOKEN_PROGRAM_ID, freeze: admin },
    { field: 'mintWithMintAuthority', name: 'mint-authority', seed: 'league-mint-authority', program: TOKEN_PROGRAM_ID, freeze: null },
    { field: 'mintWithFreezeAuthority', name: 'freeze-authority', seed: 'league-freeze-authority', program: TOKEN_PROGRAM_ID, freeze: admin },
    { field: 'otherMint', name: 'other', seed: 'league-other-mint', program: TOKEN_PROGRAM_ID, freeze: null },
    { field: 'token2022Mint', name: 'token2022', seed: 'league-token2022-mint', program: TOKEN_2022_PROGRAM_ID, freeze: null },
  ] as const;
  const mintAddresses = {} as Pick<LeagueFixtureAccounts, typeof mints[number]['field']>;
  for (const mint of mints) {
    const address = await PublicKey.createWithSeed(admin, mint.seed, mint.program); mintAddresses[mint.field] = address;
    batches.push({ name: `create-mint:${mint.name}`, instructions: [
      SystemProgram.createAccountWithSeed({ fromPubkey: admin, basePubkey: admin, newAccountPubkey: address,
        seed: mint.seed, lamports: rent.mint, space: MINT_SIZE, programId: mint.program }),
      createInitializeMint2Instruction(address, FIXTURE_DECIMALS, admin, mint.freeze, mint.program),
    ] });
  }
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  const createAta = (name: string, mint: PublicKey, owner: PublicKey) => {
    batches.push({ name: `create-ata:${name}`, instructions: [createAssociatedTokenAccountIdempotentInstruction(
      admin, ata(mint, owner), owner, mint, TOKEN_PROGRAM_ID,
    )] });
  };
  // nextAdmin must remain SOL-funded WITHOUT a good-mint ATA.
  for (const role of ['funder', 'claimant', 'second', 'stranger'] as const) createAta(`good:${role}`, mintAddresses.mint, keys[role]);
  createAta('other:funder', mintAddresses.otherMint, keys.funder);
  createAta('other:claimant', mintAddresses.otherMint, keys.claimant);
  createAta('mint-authority:funder', mintAddresses.mintWithMintAuthority, keys.funder);
  createAta('freeze-authority:funder', mintAddresses.mintWithFreezeAuthority, keys.funder);
  const noncanonical = {} as Pick<LeagueFixtureAccounts, 'noncanonicalClaimantAccount' | 'noncanonicalSweepAccount'>;
  for (const item of [
    { field: 'noncanonicalClaimantAccount', name: 'claimant', seed: 'league-claimant-account', owner: keys.claimant },
    { field: 'noncanonicalSweepAccount', name: 'sweep', seed: 'league-sweep-account', owner: keys.funder },
  ] as const) {
    const address = await PublicKey.createWithSeed(admin, item.seed, TOKEN_PROGRAM_ID); noncanonical[item.field] = address;
    need(!address.equals(ata(mintAddresses.mint, item.owner)), 'noncanonical fixture unexpectedly equals ATA');
    batches.push({ name: `create-noncanonical:${item.name}`, instructions: [
      SystemProgram.createAccountWithSeed({ fromPubkey: admin, basePubkey: admin, newAccountPubkey: address,
        seed: item.seed, lamports: rent.token, space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeAccount3Instruction(address, mintAddresses.mint, item.owner, TOKEN_PROGRAM_ID),
    ] });
  }
  batches.push({ name: 'fund-and-seal-good-mint', instructions: [
    createMintToCheckedInstruction(mintAddresses.mint, ata(mintAddresses.mint, keys.funder), admin, FUNDER_TOKEN_RAW, FIXTURE_DECIMALS, [], TOKEN_PROGRAM_ID),
    createSetAuthorityInstruction(mintAddresses.mint, admin, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID),
    createSetAuthorityInstruction(mintAddresses.mint, admin, AuthorityType.FreezeAccount, null, [], TOKEN_PROGRAM_ID),
  ] });
  batches.push({ name: 'seal-freeze-only-mint', instructions: [
    createSetAuthorityInstruction(mintAddresses.mintWithFreezeAuthority, admin, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID),
  ] });
  batches.push({ name: 'seal-other-mint', instructions: [
    createSetAuthorityInstruction(mintAddresses.otherMint, admin, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM_ID),
  ] });
  return { accounts: { ...mintAddresses, ...noncanonical }, batches };
}

async function provision(provider: AnchorProvider, actors: LeagueFixtureActors): Promise<LeagueFixtureAccounts> {
  const connection = provider.connection;
  const rent = { mint: await connection.getMinimumBalanceForRentExemption(MINT_SIZE, 'confirmed'),
    token: await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed') };
  const publicActors = Object.fromEntries(LEAGUE_FIXTURE_ROLES.map(role => [role, actors[role].publicKey])) as Record<Role, PublicKey>;
  const plan = await buildLeagueFixturePlan(publicActors, rent);
  for (const batch of plan.batches) {
    // Only this in-memory admin wallet can sign; no external/default wallet exists.
    await provider.sendAndConfirm(new Transaction().add(...batch.instructions), [], {
      commitment: 'confirmed', preflightCommitment: 'confirmed', skipPreflight: false,
    });
  }
  return plan.accounts;
}
async function finalizedSetup(connection: Connection): Promise<void> {
  const barrier = await connection.getSlot('confirmed');
  need(Number.isSafeInteger(barrier) && barrier >= 0, 'invalid setup slot');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const finalized = await connection.getSlot('finalized');
    if (Number.isSafeInteger(finalized) && finalized >= barrier) return;
    await new Promise<void>(done => setTimeout(done, 250));
  }
  throw new Error('league fixture: setup did not finalize within 60 seconds');
}
async function verify(provider: AnchorProvider, actors: LeagueFixtureActors, accounts: LeagueFixtureAccounts): Promise<void> {
  const connection = provider.connection, admin = actors.admin.publicKey;
  need(connection.rpcEndpoint === LEAGUE_FIXTURE_RPC, 'only the owned 127.0.0.1:18899 validator is allowed');
  await finalizedSetup(connection);
  const [good, retainedMint, retainedFreeze, other, token2022] = await Promise.all([
    getMint(connection, accounts.mint, 'finalized', TOKEN_PROGRAM_ID),
    getMint(connection, accounts.mintWithMintAuthority, 'finalized', TOKEN_PROGRAM_ID),
    getMint(connection, accounts.mintWithFreezeAuthority, 'finalized', TOKEN_PROGRAM_ID),
    getMint(connection, accounts.otherMint, 'finalized', TOKEN_PROGRAM_ID),
    getMint(connection, accounts.token2022Mint, 'finalized', TOKEN_2022_PROGRAM_ID),
  ]);
  need([good, retainedMint, retainedFreeze, other, token2022].every(mint => mint.isInitialized && mint.decimals === FIXTURE_DECIMALS), 'fixture mint initialization or decimals mismatch');
  need(good.mintAuthority === null && good.freezeAuthority === null && good.supply === FUNDER_TOKEN_RAW, 'good mint must be funded then have both authorities revoked');
  need(retainedMint.mintAuthority?.equals(admin) && retainedMint.freezeAuthority === null, 'mint-only authority fixture mismatch');
  need(retainedFreeze.mintAuthority === null && retainedFreeze.freezeAuthority?.equals(admin), 'freeze-only authority fixture mismatch');
  need(other.mintAuthority === null && other.freezeAuthority === null, 'other classic mint must be immutable');
  need(token2022.mintAuthority?.equals(admin) && token2022.freezeAuthority === null, 'Token-2022 fixture authority mismatch');
  const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
  const expected: Array<{ address: PublicKey; mint: PublicKey; owner: PublicKey }> = [
    ...(['funder', 'claimant', 'second', 'stranger'] as const).map(role => ({ address: ata(accounts.mint, actors[role].publicKey), mint: accounts.mint, owner: actors[role].publicKey })),
    ...(['funder', 'claimant'] as const).map(role => ({ address: ata(accounts.otherMint, actors[role].publicKey), mint: accounts.otherMint, owner: actors[role].publicKey })),
    { address: ata(accounts.mintWithMintAuthority, actors.funder.publicKey), mint: accounts.mintWithMintAuthority, owner: actors.funder.publicKey },
    { address: ata(accounts.mintWithFreezeAuthority, actors.funder.publicKey), mint: accounts.mintWithFreezeAuthority, owner: actors.funder.publicKey },
    { address: accounts.noncanonicalClaimantAccount, mint: accounts.mint, owner: actors.claimant.publicKey },
    { address: accounts.noncanonicalSweepAccount, mint: accounts.mint, owner: actors.funder.publicKey },
  ];
  for (const item of expected) {
    const account = await getAccount(connection, item.address, 'finalized', TOKEN_PROGRAM_ID);
    need(account.isInitialized && !account.isFrozen && account.mint.equals(item.mint) && account.owner.equals(item.owner), 'fixture token-account identity mismatch');
    if (item.address.equals(ata(accounts.mint, actors.funder.publicKey))) need(account.amount === FUNDER_TOKEN_RAW && account.amount > 100_000n, 'funder good-mint balance is insufficient');
  }
  need(!accounts.noncanonicalClaimantAccount.equals(ata(accounts.mint, actors.claimant.publicKey))
    && !accounts.noncanonicalSweepAccount.equals(ata(accounts.mint, actors.funder.publicKey)), 'noncanonical token accounts must not be ATAs');
  need(await connection.getAccountInfo(ata(accounts.mint, actors.nextAdmin.publicKey), 'finalized') === null, 'nextAdmin good-mint ATA must remain absent');
  const actorRent = await connection.getMinimumBalanceForRentExemption(0, 'finalized');
  need(Number.isSafeInteger(actorRent) && actorRent > 0, 'invalid actor account rent');
  for (const role of LEAGUE_FIXTURE_ROLES) {
    const balance = await connection.getBalance(actors[role].publicKey, 'finalized');
    // --mint gives admin the validator genesis balance, which can exceed JS's
    // safe-integer range. Only positivity/rent coverage is needed here; actual
    // transfer amounts and committed-failure fee deltas remain strictly bounded.
    need(Number.isFinite(balance) && balance >= actorRent, `actor ${role} must be funded`);
  }
  const config = PublicKey.findProgramAddressSync([Buffer.from('league_config')], LEAGUE_ID)[0];
  need(await connection.getAccountInfo(config, 'finalized') === null, 'fixture must leave league configuration uninitialized');
}

const defaults: LeagueFixtureDependencies = {
  readPublicFile: path => readFile(path),
  ensurePortsFree: assertLeaguePortsAvailable,
  generateWallet: () => new Wallet(Keypair.generate()),
  startValidator: input => startLeagueValidator(input),
  makeProvider: (connection, wallet) => new AnchorProvider(connection, wallet, {
    commitment: 'confirmed', preflightCommitment: 'confirmed', skipPreflight: false,
  }),
  provision,
  verify,
};

/** Explicit asynchronous entry. Dependencies are solely a unit-test seam; the
 * admitted runner passes only options and obtains the owned lifecycle handle. */
export async function leagueFixture(options: LeagueFixtureOptions, injected: Partial<LeagueFixtureDependencies> = {}): Promise<LeagueFixtureHandle> {
  need(options && typeof options.admissionReceipt === 'string' && options.admissionReceipt.trim() !== ''
    && typeof options.programsDirectory === 'string' && isAbsolute(options.programsDirectory), 'explicit receipt metadata and absolute programs directory are required');
  const runtime = { ...defaults, ...injected }, programsDirectory = resolve(options.programsDirectory);
  const policy = deriveLeagueFixturePolicy();
  const leagueElfPath = join(programsDirectory, 'target/deploy/shardkeep_league.so');
  const coreElfPath = join(programsDirectory, 'target/deploy/shardkeep_core.so');
  let leagueElf: Buffer, coreElf: Buffer;
  try {
    const [leagueBytes, coreBytes, leagueIdl, coreIdl] = await Promise.all([
      runtime.readPublicFile(leagueElfPath), runtime.readPublicFile(coreElfPath),
      runtime.readPublicFile(join(programsDirectory, 'target/idl/shardkeep_league.json')),
      runtime.readPublicFile(join(programsDirectory, 'target/idl/shardkeep_core.json')),
    ]);
    need([leagueBytes, coreBytes].every(bytes => Buffer.isBuffer(bytes) && bytes.length > 4 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))), 'ELF artifact header missing');
    need(JSON.parse(leagueIdl.toString('utf8')).address === LEAGUE_ID.toBase58()
      && JSON.parse(coreIdl.toString('utf8')).address === CORE_ID.toBase58(), 'IDL artifact address mismatch');
    leagueElf = Buffer.from(leagueBytes); coreElf = Buffer.from(coreBytes);
  } catch {
    throw new Error('league fixture: public league/core ELF and IDL artifacts must exist and match the pinned identities');
  }
  await runtime.ensurePortsFree();
  const actors = Object.fromEntries(LEAGUE_FIXTURE_ROLES.map(role => [role, runtime.generateWallet(role)])) as LeagueFixtureActors;
  const publicActors = LEAGUE_FIXTURE_ROLES.map(role => key(actors[role].publicKey).toBase58());
  need(new Set(publicActors).size === LEAGUE_FIXTURE_ROLES.length, 'seven actor wallets must be distinct');
  const validator = await runtime.startValidator({ programsDirectory, admin: actors.admin.publicKey,
    leagueProgramId: LEAGUE_ID, coreProgramId: CORE_ID, leagueElfPath, coreElfPath, leagueElf, coreElf });
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= validator.dispose();
  try {
    need(validator.connection.rpcEndpoint === LEAGUE_FIXTURE_RPC, 'only the owned 127.0.0.1:18899 validator is allowed');
    const provider = runtime.makeProvider(validator.connection, actors.admin);
    need(provider.connection.rpcEndpoint === LEAGUE_FIXTURE_RPC && provider.wallet.publicKey.equals(actors.admin.publicKey), 'provider must use admin on the owned 127.0.0.1:18899 validator');
    const accounts = await runtime.provision(provider, actors);
    await runtime.verify(provider, actors, accounts);
    const fixture: LeagueValidatorFixture = {
      admissionReceipt: options.admissionReceipt, provider, actors, ...accounts,
      otherProgramData: PublicKey.findProgramAddressSync([CORE_ID.toBuffer()], LOADER_ID)[0],
      shortWindowSec: LEAGUE_FIXTURE_WINDOW_SEC, policy,
    };
    return { fixture, dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'league fixture: setup failed and owned validator cleanup failed'); }
    throw error;
  }
}
