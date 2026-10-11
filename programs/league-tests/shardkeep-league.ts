/**
 * MS-LC validator adversarial contract — source authored before implementation.
 * Execution belongs to Cedar3 or explicitly admitted CI after review's review
 * and the owner's local-fixture admission. This file never reads
 * secret material, creates a keypair, creates a mint, or requests an airdrop.
 *
 * The MS-LC bootstrap assigned by N2/D153.361 must inject
 * __SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__. It supplies seven ephemeral in-memory
 * wallets, funded token fixtures and a self-spawned LOCAL validator on
 * 127.0.0.1:18899 with the final program deployed upgradeably. Keys are never
 * written or printed. This suite receives only the admitted wallet capabilities.
 * Missing fixtures fail the suite; they never silently skip cases.
 *
 * Original plan cases 17 and 19 were explicitly superseded by 7002e405; 19 is
 * replaced by A03. Case 10 follows 679d2d57 (strict legacy wire refusal).
 * Pure proof cases 01–08, boundary 48, packet 40, identity A13 and calendar A15
 * also live in the Rust/chain unit suites; this suite adds validator evidence.
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorError, BN, EventParser, Program } from "@coral-xyz/anchor";
import { keccak_256 } from "@noble/hashes/sha3";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { expect } from "chai";
import { ShardkeepLeague } from "../target/types/shardkeep_league";
import { buildTree as buildProductionTree, LEAGUE_PROGRAM_ID as PROOF_MODULE_PROGRAM_ID } from "../../packages/chain/src/leagueClaimProof";
import { assertCommittedFailure } from "./committedFailure";
import { requireOracleBinding, recordOracleClaimResult, readFinalizedTransactionWithRetry } from "./leagueProofOracle";

type ExistingWallet = anchor.AnchorProvider["wallet"];

/** Public account references and externally admitted wallet capabilities only. */
export interface LeagueValidatorFixture {
  admissionReceipt: string;
  provider: anchor.AnchorProvider;
  actors: Record<
    "admin" | "guardian" | "funder" | "claimant" | "second" | "stranger" | "nextAdmin",
    ExistingWallet
  >;
  /** Classic mint with both authorities revoked and ready funded canonical ATAs. */
  mint: PublicKey;
  mintWithMintAuthority: PublicKey;
  mintWithFreezeAuthority: PublicKey;
  otherMint: PublicKey;
  /** Existing Token-2022 mint, used only for a classic-owner refusal. */
  token2022Mint: PublicKey;
  /** Initialized classic token account: same mint/claimant owner, not its ATA. */
  noncanonicalClaimantAccount: PublicKey;
  /** Initialized classic token account: same mint/sweep owner, not its ATA. */
  noncanonicalSweepAccount: PublicKey;
  /** Same upgrade authority, different upgradeable program's ProgramData. */
  otherProgramData: PublicKey;
  /** Initial claim window; test-only seconds, not a replacement game constant. */
  shortWindowSec: number;
  /** Generated policy values loaded by the execution bootstrap after composition. */
  policy: { maxPlaces: number; claimWindowMaxSec: bigint; settlementDelaySec: bigint };
}

declare global {
  // Externally admitted bootstrap installs this; no secret paths are accepted.
  var __SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__: LeagueValidatorFixture | undefined;
}

const PROGRAM_ID = new PublicKey("2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE");
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
// Local calendar/proof wire facts, explicitly ruled in 2c498a74.
const WEEK_SEC = 7n * 86_400n;
const MONDAY_OFFSET = 345_600n;
const bn = (value: bigint | number) => new BN(value.toString());
const i64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
};
const u64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const u16 = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
};
const asBigInt = (value: { toString(): string } | bigint) => BigInt(value.toString());
type Entitlement = { index: number; claimant: PublicKey; amount: bigint };
type Node = { hash: Buffer; sum: bigint };
type ProofNode = Node & { isLeft: boolean };
type Tree = { root: Buffer; total: bigint; leaves: Entitlement[]; proofs: ProofNode[][] };

/** Independent oracle for adversarials; the dedicated production-codec case
 * below instead sends the exact buildTree/getProof output used by M1bb. */
function treeFor(config: PublicKey, start: bigint, leaves: Entitlement[]): Tree {
  let level: Array<Node & { members: number[] }> = leaves.map((leaf, position) => ({
    hash: Buffer.from(keccak_256(Buffer.concat([
      Buffer.from([0x06]), PROGRAM_ID.toBuffer(), config.toBuffer(), i64(start),
      u16(leaf.index), leaf.claimant.toBuffer(), u64(leaf.amount),
    ]))),
    sum: leaf.amount,
    members: [position],
  }));
  if (!level.length) throw new Error("Test tree needs a leaf");
  const proofs: ProofNode[][] = leaves.map(() => []);
  while (level.length > 1) {
    const next: typeof level = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      if (!right) { next.push(left); continue; }
      for (const member of left.members) proofs[member].push({ ...right, isLeft: false });
      for (const member of right.members) proofs[member].push({ ...left, isLeft: true });
      next.push({
        hash: Buffer.from(keccak_256(Buffer.concat([
          Buffer.from([0x07]), left.hash, u64(left.sum), right.hash, u64(right.sum),
        ]))),
        sum: left.sum + right.sum,
        members: [...left.members, ...right.members],
      });
    }
    level = next;
  }
  return { root: level[0].hash, total: level[0].sum, leaves, proofs };
}

describe("shardkeep-league — admitted local validator adversarials", function () {
  this.timeout(360_000);
  let fixture: LeagueValidatorFixture;
  let program: Program<ShardkeepLeague>;
  let config: PublicKey;
  let programData: PublicKey;
  let mint: PublicKey;
  let sweepAta: PublicKey;
  let funderAta: PublicKey;
  let claimantAta: PublicKey;
  let secondAta: PublicKey;
  let currentMonday: bigint;
  let weekCursor = 3n;
  let primary: { start: bigint; tree: Tree };
  let other: { start: bigint; tree: Tree };
  let deadlineCase: { start: bigint; tree: Tree };
  let extensionCase: { start: bigint; tree: Tree };
  let donationCase: { start: bigint; tree: Tree };
  // The sequential invalid-claim cases must reach their intended guard even on
  // a slow validator. Stop refreshing before the explicit expiration phase.
  let protectClaimWindows = true;
  const donorAmount = 17n;
  let decimals: number;

  const actor = (name: keyof LeagueValidatorFixture["actors"]) => fixture.actors[name];
  const pda = (start: bigint) => PublicKey.findProgramAddressSync(
    [Buffer.from("league_week"), config.toBuffer(), i64(start)], PROGRAM_ID,
  )[0];
  const vaultFor = (start: bigint) => PublicKey.findProgramAddressSync(
    [Buffer.from("league_vault"), pda(start).toBuffer()], PROGRAM_ID,
  )[0];
  const past = () => currentMonday - WEEK_SEC * weekCursor++;
  const connection = () => fixture.provider.connection;
  const ata = (owner: PublicKey, tokenMint = mint) => getAssociatedTokenAddressSync(tokenMint, owner);
  const configState = () => program.account.leagueConfig.fetch(config);
  const weekState = (start: bigint) => program.account.leagueWeek.fetch(pda(start));
  const amount = async (address: PublicKey) => (await getAccount(connection(), address)).amount;
  const clock = async () => {
    const timestamp = await connection().getBlockTime(await connection().getSlot("confirmed"));
    if (timestamp === null) throw new Error("Local validator block time unavailable");
    return BigInt(timestamp);
  };
  const waitUntil = async (deadline: bigint) => {
    const stop = Date.now() + 240_000;
    while (await clock() < deadline) {
      if (Date.now() > stop) throw new Error(`Validator clock did not reach ${deadline}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  };
  const watched = (start?: bigint, extra: PublicKey[] = []) => [
    config, funderAta, claimantAta, secondAta, sweepAta,
    ...(start === undefined ? [] : [pda(start), vaultFor(start)]), ...extra,
  ];
  const snapshot = async (addresses: PublicKey[]) => {
    const unique = [...new Map(addresses.map((address) => [address.toBase58(), address])).values()];
    const accounts = await connection().getMultipleAccountsInfo(unique, "confirmed");
    return unique.map((address, index) => {
      const account = accounts[index];
      return [address.toBase58(), account === null ? null : {
        owner: account.owner.toBase58(), lamports: account.lamports,
        executable: account.executable, data: account.data.toString("hex"),
      }];
    });
  };
  async function send(wallet: ExistingWallet, instructions: TransactionInstruction[]) {
    const provider = new anchor.AnchorProvider(connection(), wallet, {
      commitment: "confirmed", preflightCommitment: "confirmed", skipPreflight: false,
    });
    return provider.sendAndConfirm(new Transaction().add(...instructions));
  }
  const committedProvider = (wallet: ExistingWallet) => new anchor.AnchorProvider(connection(), wallet, {
    commitment: "finalized", preflightCommitment: "finalized", skipPreflight: false,
  });
  function logsOf(error: unknown): string[] {
    const candidate = error as { logs?: string[]; transactionLogs?: string[]; message?: string };
    return candidate.logs ?? candidate.transactionLogs ?? [candidate.message ?? String(error)];
  }
  async function refuses(
    expected: string,
    action: () => Promise<unknown>,
    addresses: PublicKey[],
    external?: { program: PublicKey; reason: string },
  ) {
    const before = await snapshot(addresses);
    let failure: unknown;
    try { await action(); } catch (error) { failure = error; }
    expect(failure, `Expected exact refusal ${expected}`).not.to.equal(undefined);
    const logs = logsOf(failure);
    if (external) {
      expect(logs.join("\n")).to.include(`Program ${external.program.toBase58()} failed: ${external.reason}`);
    } else {
      const parsed = AnchorError.parse(logs);
      const direct = (failure as { error?: { errorCode?: { code?: string } } })?.error?.errorCode?.code;
      expect(direct ?? parsed?.error.errorCode.code, logs.join("\n")).to.equal(expected);
    }
    expect(await snapshot(addresses), `${expected} must roll back state and token balances`).to.deep.equal(before);
  }
  async function event(signature: string, name: string) {
    let transaction = await connection().getTransaction(signature, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
    });
    for (let attempt = 0; transaction === null && attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      transaction = await connection().getTransaction(signature, {
        commitment: "confirmed", maxSupportedTransactionVersion: 0,
      });
    }
    expect(transaction?.meta?.err).to.equal(null);
    const events = [...new EventParser(PROGRAM_ID, program.coder).parseLogs(transaction?.meta?.logMessages ?? [])];
    const result = events.find((candidate) => candidate.name === name);
    expect(result, `Missing ${name} event`).not.to.equal(undefined);
    return result!.data;
  }
  function initializeAccounts(overrides: Record<string, PublicKey> = {}) {
    return {
      admin: actor("admin").publicKey, config, program: PROGRAM_ID, programData,
      mint, sweepOwner: actor("funder").publicKey, sweepAta,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, ...overrides,
    };
  }
  const initializeIx = (overrides: Record<string, PublicKey> = {}, window = fixture.shortWindowSec,
    guardian = actor("guardian").publicKey, funder = actor("funder").publicKey) => program.methods
    .initializeLeague(guardian, funder, { value: bn(window) })
    .accountsStrict(initializeAccounts(overrides)).instruction();
  function openAccounts(start: bigint, overrides: Record<string, PublicKey> = {}) {
    return {
      funder: actor("funder").publicKey, config, week: pda(start), vault: vaultFor(start),
      funderAta, mint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      ...overrides,
    };
  }
  const openIx = (start: bigint, tree: Tree, overrides: Record<string, PublicKey> = {},
    values: { root?: Buffer; total?: bigint; count?: number } = {}) => program.methods
    .openWeek(bn(start), [...(values.root ?? tree.root)], bn(values.total ?? tree.total),
      values.count ?? tree.leaves.length, [...Buffer.alloc(32, 0xa5)])
    .accountsStrict(openAccounts(start, overrides)).instruction();
  function claimAccounts(start: bigint, wallet = actor("claimant"), overrides: Record<string, PublicKey> = {}) {
    return {
      claimant: wallet.publicKey, config, week: pda(start), vault: vaultFor(start),
      destination: ata(wallet.publicKey), mint, tokenProgram: TOKEN_PROGRAM_ID, ...overrides,
    };
  }
  const claimIx = (start: bigint, tree: Tree, leafIndex = 0,
    wallet = actor("claimant"), overrides: Record<string, PublicKey> = {},
    values: { index?: number; amount?: bigint; proof?: ProofNode[] } = {}) => program.methods
    .claimLeagueReward(bn(start), values.index ?? tree.leaves[leafIndex].index,
      bn(values.amount ?? tree.leaves[leafIndex].amount),
      (values.proof ?? tree.proofs[leafIndex]).map((node) => ({
        hash: [...node.hash], sum: bn(node.sum), isLeft: node.isLeft,
      })))
    .accountsStrict(claimAccounts(start, wallet, overrides)).instruction();
  const sweepIx = (start: bigint, overrides: Record<string, PublicKey> = {}) => program.methods
    .sweepWeek(bn(start)).accountsStrict({
      config, week: pda(start), vault: vaultFor(start), destination: sweepAta,
      mint, tokenProgram: TOKEN_PROGRAM_ID, ...overrides,
    }).instruction();
  const extendIx = (start: bigint, deadline: bigint, wallet = actor("admin")) => program.methods
    .extendClaimDeadline(bn(start), bn(deadline))
    .accountsStrict({ admin: wallet.publicKey, config, week: pda(start) }).instruction();
  const pauseIx = (paused: boolean, wallet = actor("admin")) => program.methods
    .setLeaguePaused(paused).accountsStrict({ signer: wallet.publicKey, config }).instruction();
  const sample = (start: bigint, sparse = false) => treeFor(config, start, sparse ? [
    { index: fixture.policy.maxPlaces - 1, claimant: actor("claimant").publicKey, amount: 19n },
  ] : [
    { index: 0, claimant: actor("claimant").publicKey, amount: 23n },
    { index: 7, claimant: actor("second").publicKey, amount: 31n },
  ]);
  async function opened(sparse = false) {
    const start = past();
    const tree = sample(start, sparse);
    await send(actor("funder"), [await openIx(start, tree)]);
    return { start, tree };
  }

  before(async () => {
    const injected = globalThis.__SHARDKEEP_LEAGUE_VALIDATOR_FIXTURE__;
    if (!injected) throw new Error("The admitted N2 local bootstrap must inject the league fixture before this suite; this suite never synthesizes fallback actors or skips tests");
    fixture = injected;
    expect(fixture.admissionReceipt.trim(), "Explicit existing-actor admission receipt required").not.to.equal("");
    const endpoint = new URL(fixture.provider.connection.rpcEndpoint);
    expect(["127.0.0.1", "localhost", "[::1]"]).to.include(endpoint.hostname);
    expect(fixture.shortWindowSec, "120-second base test window required for the explicit expiry phase").to.equal(120);
    expect(fixture.policy.maxPlaces).to.be.greaterThan(7);
    expect(fixture.policy.claimWindowMaxSec > BigInt(fixture.shortWindowSec)).to.equal(true);
    anchor.setProvider(fixture.provider);
    program = anchor.workspace.shardkeepLeague as Program<ShardkeepLeague>;
    expect(program.programId.toBase58()).to.equal(PROGRAM_ID.toBase58());
    [config] = PublicKey.findProgramAddressSync([Buffer.from("league_config")], PROGRAM_ID);
    [programData] = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER);
    mint = fixture.mint;
    sweepAta = ata(actor("funder").publicKey);
    funderAta = sweepAta;
    claimantAta = ata(actor("claimant").publicKey);
    secondAta = ata(actor("second").publicKey);
    expect(await connection().getAccountInfo(config), "Fresh config required; never close/reset existing config").to.equal(null);
    const tokenMint = await getMint(connection(), mint);
    expect(tokenMint.mintAuthority).to.equal(null);
    expect(tokenMint.freezeAuthority).to.equal(null);
    decimals = tokenMint.decimals;
    const retainedMint = await getMint(connection(), fixture.mintWithMintAuthority);
    const retainedFreeze = await getMint(connection(), fixture.mintWithFreezeAuthority);
    const token2022Mint = await getMint(connection(), fixture.token2022Mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(token2022Mint.isInitialized).to.equal(true);
    expect(retainedMint.mintAuthority).not.to.equal(null);
    expect(retainedFreeze.mintAuthority, "Isolate freeze authority rejection").to.equal(null);
    expect(retainedFreeze.freezeAuthority).not.to.equal(null);
    const noncanonicalClaimant = await getAccount(connection(), fixture.noncanonicalClaimantAccount);
    const noncanonicalSweep = await getAccount(connection(), fixture.noncanonicalSweepAccount);
    expect(noncanonicalClaimant.mint.equals(mint)).to.equal(true);
    expect(noncanonicalClaimant.owner.equals(actor("claimant").publicKey)).to.equal(true);
    expect(fixture.noncanonicalClaimantAccount.equals(claimantAta)).to.equal(false);
    expect(noncanonicalSweep.mint.equals(mint)).to.equal(true);
    expect(noncanonicalSweep.owner.equals(actor("funder").publicKey)).to.equal(true);
    expect(fixture.noncanonicalSweepAccount.equals(sweepAta)).to.equal(false);
    for (const address of [funderAta, claimantAta, secondAta, ata(actor("stranger").publicKey),
      ata(actor("funder").publicKey, fixture.otherMint), ata(actor("claimant").publicKey, fixture.otherMint)]) {
      expect((await getAccount(connection(), address)).isInitialized).to.equal(true);
    }
    expect(await connection().getAccountInfo(ata(actor("nextAdmin").publicKey)),
      "The existing nextAdmin actor's good-mint ATA must be absent for the uninitialized-destination case").to.equal(null);
    const nextAdminBalance = await connection().getBalance(actor("nextAdmin").publicKey, "confirmed");
    const minimumWalletBalance = await connection().getMinimumBalanceForRentExemption(0, "confirmed");
    expect(nextAdminBalance,
      "The nextAdmin actor must already hold enough SOL for its fee-paying refusal and admin transactions").to.be.at.least(minimumWalletBalance);
    for (const address of [programData, fixture.otherProgramData]) {
      const info = await connection().getAccountInfo(address, "confirmed");
      expect(info?.owner.equals(UPGRADEABLE_LOADER)).to.equal(true);
      expect(info?.data.readUInt32LE(0)).to.equal(3); // UpgradeableLoaderState::ProgramData.
      expect(info?.data[12]).to.equal(1); // Some(upgrade_authority_address).
      expect(new PublicKey(info!.data.subarray(13, 45)).equals(actor("admin").publicKey)).to.equal(true);
    }
    expect(fixture.otherProgramData.equals(programData)).to.equal(false);
    expect((await amount(funderAta)) > 100_000n, "Existing fixture needs enough test tokens").to.equal(true);
    const publicKeys = Object.values(fixture.actors).map((wallet) => wallet.publicKey.toBase58());
    expect(new Set(publicKeys).size, "Distinct existing actors required").to.equal(publicKeys.length);
    const now = await clock();
    currentMonday = now - ((now - MONDAY_OFFSET) % WEEK_SEC + WEEK_SEC) % WEEK_SEC;
  });

  beforeEach(async () => {
    if (!protectClaimWindows) return;
    for (const item of [primary, other, donationCase]) {
      if (!item) continue;
      const state = await weekState(item.start);
      if (state.swept) continue;
      const now = await clock();
      const window = BigInt(fixture.shortWindowSec);
      if (asBigInt(state.claimDeadline) - now > window / 2n) continue;
      const newDeadline = now + window;
      const ceiling = asBigInt(state.openedAt) + fixture.policy.claimWindowMaxSec;
      if (newDeadline > ceiling) {
        throw new Error("Validator claim-guard phase exhausted the generated extension ceiling");
      }
      // Use the same admitted admin capability and ordinary instruction; never
      // overwrite account data, warp time, or change immutable window policy.
      const signature = await send(actor("admin"), [await extendIx(item.start, newDeadline)]);
      const emitted = await event(signature, "leagueDeadlineExtended");
      expect(asBigInt(emitted.previousDeadline)).to.equal(asBigInt(state.claimDeadline));
      expect(asBigInt(emitted.newDeadline)).to.equal(newDeadline);
      expect(asBigInt((await weekState(item.start)).claimDeadline)).to.equal(newDeadline);
    }
  });

  it("09 refuses non-upgrade-authority initialization: Unauthorized; config remains absent", async () => {
    await refuses("Unauthorized", async () => send(actor("stranger"), [await initializeIx({ admin: actor("stranger").publicKey })]), watched());
  });
  it("09b refuses unrelated ProgramData despite the same upgrade authority: Unauthorized", async () => {
    await refuses("Unauthorized", async () => send(actor("admin"), [await initializeIx({ programData: fixture.otherProgramData })]), watched());
  });
  for (const [label, mutate] of [
    ["legacy 88-byte first_week_start payload", (data: Buffer) => Buffer.concat([data.subarray(0, 72), i64(MONDAY_OFFSET), i64(10n)])],
    ["truncated 79-byte payload", (data: Buffer) => data.subarray(0, 79)],
    ["one trailing byte", (data: Buffer) => Buffer.concat([data, Buffer.from([1])])],
  ] as const) {
    it(`10 refuses ${label}: InstructionDidNotDeserialize (102), without creating config`, async () => {
      const instruction = await initializeIx();
      expect(instruction.data.length).to.equal(80);
      instruction.data = mutate(instruction.data);
      await refuses("InstructionDidNotDeserialize", () => send(actor("admin"), [instruction]), watched());
    });
  }
  it("11 refuses Token-2022 substitution: InvalidProgramId", async () => {
    await refuses("InvalidProgramId", async () => send(actor("admin"), [await initializeIx({ tokenProgram: TOKEN_2022_PROGRAM_ID })]), watched());
  });
  it("MAJOR-3 initialize refuses a Token-2022-owned mint: AccountOwnedByWrongProgram", async () => {
    const destination = getAssociatedTokenAddressSync(fixture.token2022Mint, actor("funder").publicKey);
    await refuses("AccountOwnedByWrongProgram", async () => send(actor("admin"), [await initializeIx({ mint: fixture.token2022Mint, sweepAta: destination })]), watched(undefined, [destination]));
  });
  it("12 refuses a noncanonical sweep account: InvalidTokenAccount", async () => {
    await refuses("InvalidTokenAccount", async () => send(actor("admin"), [await initializeIx({ sweepAta: fixture.noncanonicalSweepAccount })]), watched(undefined, [fixture.noncanonicalSweepAccount]));
  });
  for (const [label, field, expected] of [
    ["A09 mint authority retained", "mintWithMintAuthority", "MintAuthorityPresent"],
    ["A10 freeze authority retained", "mintWithFreezeAuthority", "FreezeAuthorityPresent"],
  ] as const) {
    it(`${label}: ${expected}`, async () => {
      const otherMint = fixture[field];
      const destination = ata(actor("funder").publicKey, otherMint);
      await refuses(expected, async () => send(actor("admin"), [await initializeIx({ mint: otherMint, sweepAta: destination })]), watched(undefined, [destination]));
    });
  }
  for (const window of [0, -1]) {
    it(`initialize window ${window} refuses: InvalidWindow`, async () => {
      await refuses("InvalidWindow", async () => send(actor("admin"), [await initializeIx({}, window)]), watched());
    });
  }
  it("initialize window beyond generated ceiling refuses: InvalidWindow", async () => {
    const instruction = await initializeIx();
    instruction.data = Buffer.concat([instruction.data.subarray(0, 72), i64(fixture.policy.claimWindowMaxSec + 1n)]);
    await refuses("InvalidWindow", () => send(actor("admin"), [instruction]), watched());
  });
  for (const role of ["guardian", "funder", "sweepOwner"] as const) {
    it(`initialize zero ${role} refuses: InvalidAuthority`, async () => {
      await refuses("InvalidAuthority", async () => send(actor("admin"), [await initializeIx(
        role === "sweepOwner" ? { sweepOwner: PublicKey.default } : {}, fixture.shortWindowSec,
        role === "guardian" ? PublicKey.default : actor("guardian").publicKey,
        role === "funder" ? PublicKey.default : actor("funder").publicKey,
      )]), watched());
    });
  }
  it("10 corrected 80-byte initializer succeeds and stores immutable mint, roles, window and canonical bump", async () => {
    const instruction = await initializeIx();
    expect(instruction.data.length).to.equal(80);
    await send(actor("admin"), [instruction]);
    const state = await configState();
    expect(state.admin.equals(actor("admin").publicKey)).to.equal(true);
    expect(state.guardian.equals(actor("guardian").publicKey)).to.equal(true);
    expect(state.funder.equals(actor("funder").publicKey)).to.equal(true);
    expect(state.mint.equals(mint)).to.equal(true);
    expect(state.tokenProgram.equals(TOKEN_PROGRAM_ID)).to.equal(true);
    expect(state.sweepOwner.equals(actor("funder").publicKey)).to.equal(true);
    expect(state.sweepAta.equals(sweepAta)).to.equal(true);
    expect(state.decimals).to.equal(decimals);
    expect(asBigInt(state.claimWindowSec)).to.equal(BigInt(fixture.shortWindowSec));
    expect(state.bump).to.equal(PublicKey.findProgramAddressSync([Buffer.from("league_config")], PROGRAM_ID)[1]);
    expect(state.pendingAdmin).to.equal(null);
    expect(state.paused).to.equal(false);
  });
  it("13 duplicate initialization refuses exact System custom 0; immutable config is unchanged", async () => {
    await refuses("System::AccountAlreadyInUse", async () => send(actor("admin"), [await initializeIx()]), watched(),
      { program: SystemProgram.programId, reason: "custom program error: 0x0" });
  });

  it("14 non-funder open refuses: Unauthorized", async () => {
    const start = past();
    await refuses("Unauthorized", async () => send(actor("stranger"), [await openIx(start, sample(start), { funder: actor("stranger").publicKey, funderAta: ata(actor("stranger").publicKey) })]), watched(start, [ata(actor("stranger").publicKey)]));
  });
  it("MAJOR-4 committed paused open: Custom6007, init-account rollback and fee-only payer debit", async () => {
    const start = past();
    await send(actor("admin"), [await pauseIx(true)]);
    try {
      await assertCommittedFailure({
        provider: committedProvider(actor("funder")), instruction: await openIx(start, sample(start)),
        programId: PROGRAM_ID, expectedCustomError: 6007, expectedErrorName: "Paused",
        watchedAccounts: watched(start),
      });
    } finally {
      await send(actor("admin"), [await pauseIx(false)]);
    }
  });
  it("MAJOR-3 Token-2022 program substitution on open refuses: InvalidProgramId", async () => {
    const start = past();
    await refuses("InvalidProgramId", async () => send(actor("funder"), [await openIx(start, sample(start), { tokenProgram: TOKEN_2022_PROGRAM_ID })]), watched(start));
  });
  it("15 current week cannot open before close plus delay: WeekNotClosed", async () => {
    await refuses("WeekNotClosed", async () => send(actor("funder"), [await openIx(currentMonday, sample(currentMonday))]), watched(currentMonday));
  });
  it("48 latest representable Monday overflows its close time: ArithmeticOverflow", async () => {
    const maximum = (1n << 63n) - 1n;
    const start = maximum - (maximum - MONDAY_OFFSET) % WEEK_SEC;
    await refuses("ArithmeticOverflow", async () => send(actor("funder"), [await openIx(start, sample(start))]), watched(start));
  });
  for (const [label, choose] of [
    ["16 non-Monday", () => past() + 1n],
    ["A11 negative Monday-aligned", () => MONDAY_OFFSET - WEEK_SEC],
    ["A12 zero", () => 0n],
  ] as const) {
    it(`${label} start refuses: InvalidWeekStart`, async () => {
      const start = choose();
      // -259200 is a Monday, so A11 isolates positivity. Zero also fails
      // positivity, though unlike the negative Monday it is not aligned.
      if (label === "A11 negative Monday-aligned") {
        expect(start).to.equal(-259_200n);
        expect((start - MONDAY_OFFSET) % WEEK_SEC).to.equal(0n);
      }
      await refuses("InvalidWeekStart", async () => send(actor("funder"), [await openIx(start, sample(start))]), watched(start));
    });
  }
  for (const kind of ["zero root", "zero count", "excess count", "zero total"] as const) {
    it(`20 ${kind} refuses its exact argument error and rolls back both init accounts`, async () => {
      const start = past();
      const values = kind === "zero root" ? { root: Buffer.alloc(32) }
        : kind === "zero count" ? { count: 0 }
          : kind === "excess count" ? { count: fixture.policy.maxPlaces + 1 } : { total: 0n };
      const code = kind === "zero root" ? "InvalidRoot" : kind === "zero total" ? "InvalidAmount" : "InvalidLeafCount";
      await refuses(code, async () => send(actor("funder"), [await openIx(start, sample(start), {}, values)]), watched(start));
    });
  }
  it("21 insufficient canonical funder ATA refuses SPL custom 1; week/vault creation rolls back", async () => {
    const start = past();
    const shortage = await amount(funderAta) + 1n;
    await refuses("Token::InsufficientFunds", async () => send(actor("funder"), [await openIx(start, sample(start), {}, { total: shortage })]), watched(start),
      { program: TOKEN_PROGRAM_ID, reason: "custom program error: 0x1" });
  });
  it("22 wrong funder mint account refuses: InvalidTokenAccount", async () => {
    const start = past();
    const wrong = ata(actor("funder").publicKey, fixture.otherMint);
    await refuses("InvalidTokenAccount", async () => send(actor("funder"), [await openIx(start, sample(start), { funderAta: wrong })]), watched(start, [wrong]));
  });
  it("22 wrong typed mint refuses: ConstraintAddress", async () => {
    const start = past();
    await refuses("ConstraintAddress", async () => send(actor("funder"), [await openIx(start, sample(start), { mint: fixture.otherMint })]), watched(start));
  });
  it("22 substituted vault PDA refuses: ConstraintSeeds", async () => {
    const start = past();
    const wrong = vaultFor(past());
    await refuses("ConstraintSeeds", async () => send(actor("funder"), [await openIx(start, sample(start), { vault: wrong })]), watched(start, [wrong]));
  });
  it("23 paused open refuses: Paused", async () => {
    await send(actor("admin"), [await pauseIx(true)]);
    const start = past();
    await refuses("Paused", async () => send(actor("funder"), [await openIx(start, sample(start))]), watched(start));
    await send(actor("admin"), [await pauseIx(false)]);
  });
  it("24 successful open proves funding DELTAS, immutable root and both canonical bumps, and emits LeagueWeekOpened", async () => {
    const start = past();
    const tree = sample(start);
    const funderBefore = await amount(funderAta);
    const signature = await send(actor("funder"), [await openIx(start, tree)]);
    expect(funderBefore - await amount(funderAta)).to.equal(tree.total);
    // Fresh vault has no token balance: this is explicitly its before/after delta.
    expect(await amount(vaultFor(start)) - 0n).to.equal(tree.total);
    const state = await weekState(start);
    expect(Buffer.from(state.root).equals(tree.root)).to.equal(true);
    expect(asBigInt(state.totalRaw)).to.equal(tree.total);
    expect(asBigInt(state.claimedRaw)).to.equal(0n);
    expect(state.claimedCount).to.equal(0);
    expect(state.leafCount).to.equal(tree.leaves.length);
    expect(state.bump).to.equal(PublicKey.findProgramAddressSync([Buffer.from("league_week"), config.toBuffer(), i64(start)], PROGRAM_ID)[1]);
    expect(state.vaultBump).to.equal(PublicKey.findProgramAddressSync([Buffer.from("league_vault"), pda(start).toBuffer()], PROGRAM_ID)[1]);
    expect(asBigInt(state.claimDeadline) - asBigInt(state.openedAt)).to.equal(BigInt(fixture.shortWindowSec));
    const emitted = await event(signature, "leagueWeekOpened");
    expect(asBigInt(emitted.totalRaw)).to.equal(tree.total);
    expect(emitted.week.equals(pda(start))).to.equal(true);
    expect(emitted.vault.equals(vaultFor(start))).to.equal(true);
    expect(asBigInt(emitted.weekStart)).to.equal(start);
    expect(Buffer.from(emitted.root).equals(tree.root)).to.equal(true);
    expect(emitted.leafCount).to.equal(tree.leaves.length);
    primary = { start, tree };
  });
  it("18 same week twice refuses exact System custom 0 and preserves its original root and vault", async () => {
    await refuses("System::AccountAlreadyInUse", async () => send(actor("funder"), [await openIx(primary.start, primary.tree)]), watched(primary.start),
      { program: SystemProgram.programId, reason: "custom program error: 0x0" });
  });

  it("27 mutated sibling hash refuses: InvalidProof", async () => {
    const proof = primary.tree.proofs[0].map((node) => ({ ...node, hash: Buffer.from(node.hash) }));
    proof[0].hash[0] ^= 1;
    await refuses("InvalidProof", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), {}, { proof })]), watched(primary.start));
  });
  it("MAJOR-4 committed wrong proof: Custom6017, finalized state unchanged and fee-only payer debit", async () => {
    const proof = primary.tree.proofs[0].map((node) => ({ ...node, hash: Buffer.from(node.hash) }));
    proof[0].hash[0] ^= 1;
    await assertCommittedFailure({
      provider: committedProvider(actor("claimant")),
      instruction: await claimIx(primary.start, primary.tree, 0, actor("claimant"), {}, { proof }),
      programId: PROGRAM_ID, expectedCustomError: 6017, expectedErrorName: "InvalidProof", watchedAccounts: watched(primary.start),
    });
  });
  it("28 week-A proof cannot claim week B: InvalidProof", async () => {
    other = await opened();
    await refuses("InvalidProof", async () => send(actor("claimant"), [await claimIx(other.start, primary.tree)]), watched(other.start));
  });
  it("29 signer B cannot consume A's leaf to B's canonical ATA: InvalidProof", async () => {
    await refuses("InvalidProof", async () => send(actor("second"), [await claimIx(primary.start, primary.tree, 0, actor("second"))]), watched(primary.start));
  });
  it("29 signer B cannot direct A's leaf to A's ATA: InvalidTokenAccount", async () => {
    await refuses("InvalidTokenAccount", async () => send(actor("second"), [await claimIx(primary.start, primary.tree, 0, actor("second"), { destination: claimantAta })]), watched(primary.start));
  });
  it("30 claimant destination with wrong mint refuses: InvalidTokenAccount", async () => {
    const wrong = ata(actor("claimant").publicKey, fixture.otherMint);
    await refuses("InvalidTokenAccount", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), { destination: wrong })]), watched(primary.start, [wrong]));
  });
  it("31 noncanonical initialized claimant account refuses: InvalidTokenAccount", async () => {
    await refuses("InvalidTokenAccount", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), { destination: fixture.noncanonicalClaimantAccount })]), watched(primary.start, [fixture.noncanonicalClaimantAccount]));
  });
  it("32 another week's vault substitution refuses: ConstraintSeeds", async () => {
    await refuses("ConstraintSeeds", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), { vault: vaultFor(other.start) })]), watched(primary.start, [vaultFor(other.start)]));
  });
  it("F1 week A's PDA and vault cannot satisfy week B's claim: ConstraintSeeds", async () => {
    expect(primary.start).not.to.equal(other.start);
    await refuses("ConstraintSeeds", async () => send(actor("claimant"), [await claimIx(
      other.start, other.tree, 0, actor("claimant"),
      { week: pda(primary.start), vault: vaultFor(primary.start) },
    )]), watched(other.start, [pda(primary.start), vaultFor(primary.start)]));
  });
  it("F1 week A's PDA and vault cannot satisfy week B's sweep: ConstraintSeeds", async () => {
    expect(primary.start).not.to.equal(other.start);
    await refuses("ConstraintSeeds", async () => send(actor("stranger"), [await sweepIx(
      other.start, { week: pda(primary.start), vault: vaultFor(primary.start) },
    )]), watched(other.start, [pda(primary.start), vaultFor(primary.start)]));
  });
  it("MAJOR-3 Token-2022 program substitution on claim refuses: InvalidProgramId", async () => {
    await refuses("InvalidProgramId", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), { tokenProgram: TOKEN_2022_PROGRAM_ID })]), watched(primary.start));
  });
  it("MAJOR-3 wrong typed mint on claim refuses: ConstraintAddress", async () => {
    await refuses("ConstraintAddress", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), { mint: fixture.otherMint })]), watched(primary.start));
  });
  it("MAJOR-3 Token-2022 program substitution on sweep refuses: InvalidProgramId", async () => {
    await refuses("InvalidProgramId", async () => send(actor("stranger"), [await sweepIx(primary.start, { tokenProgram: TOKEN_2022_PROGRAM_ID })]), watched(primary.start));
  });
  it("MAJOR-3 wrong typed mint on sweep refuses: ConstraintAddress", async () => {
    await refuses("ConstraintAddress", async () => send(actor("stranger"), [await sweepIx(primary.start, { mint: fixture.otherMint })]), watched(primary.start));
  });
  it("MAJOR-3 another week's vault on sweep refuses: ConstraintSeeds", async () => {
    await refuses("ConstraintSeeds", async () => send(actor("stranger"), [await sweepIx(primary.start, { vault: vaultFor(other.start) })]), watched(primary.start, [vaultFor(other.start)]));
  });
  it("33 unopened week claim refuses: AccountNotInitialized", async () => {
    const start = past();
    await refuses("AccountNotInitialized", async () => send(actor("claimant"), [await claimIx(start, sample(start))]), watched(start));
  });
  it("MAJOR-3 uninitialized canonical claimant ATA refuses: AccountNotInitialized", async () => {
    const start = past();
    const wallet = actor("nextAdmin");
    const destination = ata(wallet.publicKey);
    const tree = treeFor(config, start, [{ index: 2, claimant: wallet.publicKey, amount: 19n }]);
    await send(actor("funder"), [await openIx(start, tree)]);
    expect(await connection().getAccountInfo(destination)).to.equal(null);
    await refuses("AccountNotInitialized", async () => send(wallet, [await claimIx(start, tree, 0, wallet)]), watched(start, [destination]));
  });
  it("36 paused claim refuses: Paused", async () => {
    await send(actor("admin"), [await pauseIx(true)]);
    await refuses("Paused", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree)]), watched(primary.start));
    await send(actor("admin"), [await pauseIx(false)]);
  });
  it("37 index at maxPlaces refuses: InvalidIndex", async () => {
    await refuses("InvalidIndex", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), {}, { index: fixture.policy.maxPlaces })]), watched(primary.start));
  });
  it("38 zero amount refuses: InvalidAmount", async () => {
    await refuses("InvalidAmount", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), {}, { amount: 0n })]), watched(primary.start));
  });
  it("05 validator refuses depth 11 before proof verification: ProofTooDeep", async () => {
    const proof = Array.from({ length: 11 }, () => ({ hash: Buffer.alloc(32, 1), sum: 1n, isLeft: false }));
    await refuses("ProofTooDeep", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree, 0, actor("claimant"), {}, { proof })]), watched(primary.start));
  });
  it("25 valid claim proves token DELTAS and one bitmap/accounting update, and emits LeagueRewardClaimed", async () => {
    const beforeVault = await amount(vaultFor(primary.start));
    const beforeDestination = await amount(claimantAta);
    const signature = await send(actor("claimant"), [await claimIx(primary.start, primary.tree)]);
    const expected = primary.tree.leaves[0].amount;
    expect(beforeVault - await amount(vaultFor(primary.start))).to.equal(expected);
    expect(await amount(claimantAta) - beforeDestination).to.equal(expected);
    const state = await weekState(primary.start);
    expect(asBigInt(state.claimedRaw)).to.equal(expected);
    expect(state.claimedCount).to.equal(1);
    expect((state.claimedBitmap[0] & 1) !== 0).to.equal(true);
    const emitted = await event(signature, "leagueRewardClaimed");
    expect(asBigInt(emitted.amount)).to.equal(expected);
    expect(asBigInt(emitted.claimedRaw)).to.equal(expected);
    expect(emitted.claimedCount).to.equal(1);
    expect(emitted.index).to.equal(primary.tree.leaves[0].index);
    expect(emitted.claimant.equals(actor("claimant").publicKey)).to.equal(true);
    expect(emitted.week.equals(pda(primary.start))).to.equal(true);
  });
  it("26 replay refuses: AlreadyClaimed; token balances, bitmap and counters unchanged", async () => {
    await refuses("AlreadyClaimed", async () => send(actor("claimant"), [await claimIx(primary.start, primary.tree)]), watched(primary.start));
  });
  it("MAJOR-4 committed replay: Custom6015, finalized state unchanged and fee-only payer debit", async () => {
    await assertCommittedFailure({
      provider: committedProvider(actor("claimant")),
      instruction: await claimIx(primary.start, primary.tree),
      programId: PROGRAM_ID, expectedCustomError: 6015, expectedErrorName: "AlreadyClaimed", watchedAccounts: watched(primary.start),
    });
  });
  it("39 all leaves claim exactly the funded sum, never above total_raw, including sparse indexes", async () => {
    await send(actor("second"), [await claimIx(primary.start, primary.tree, 1, actor("second"))]);
    const state = await weekState(primary.start);
    expect(asBigInt(state.claimedRaw)).to.equal(primary.tree.total);
    expect(asBigInt(state.claimedRaw) <= asBigInt(state.totalRaw)).to.equal(true);
    expect(state.claimedCount).to.equal(primary.tree.leaves.length);
    expect(state.claimedBitmap[0]).to.equal(0b10000001);
    expect(await amount(vaultFor(primary.start))).to.equal(0n);
  });
  it("sparse place index maxPlaces-1 remains claimable when leaf_count is one", async () => {
    const item = await opened(true);
    await send(actor("claimant"), [await claimIx(item.start, item.tree)]);
    const state = await weekState(item.start);
    const index = fixture.policy.maxPlaces - 1;
    expect(state.leafCount).to.equal(1);
    expect((state.claimedBitmap[Math.floor(index / 8)] & (1 << (index % 8))) !== 0).to.equal(true);
    expect(asBigInt(state.claimedRaw)).to.equal(item.tree.total);
  });
  it("item6 production buildTree/getProof output funds a root and claims all three leaves on-chain", async () => {
    // C3's explicit factory wrote this public record before the suite initialized.
    // No subprocess or hash oracle runs inside any validator test case.
    const binding = requireOracleBinding(fixture), pinned = binding.record;
    const start = BigInt(pinned.input.weekStart);
    expect(pinned.input.programIdHex).to.equal(PROGRAM_ID.toBuffer().toString('hex'));
    expect(pinned.input.configHex).to.equal(config.toBuffer().toString('hex'));
    const finalizedAmount = async (address: PublicKey) => (await getAccount(connection(), address, 'finalized')).amount;
    const finalizedTransaction = async (signature: string) => {
      const tx = await readFinalizedTransactionWithRetry(() => connection().getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }));
      expect(tx?.meta?.err, 'Pinned-root transaction must exist and succeed at finalized').to.equal(null);
      if (!tx || tx.meta?.err !== null) throw new Error('Missing finalized pinned-root transaction');
      return { signature, slot: tx.slot };
    };
    // programs/ and packages/chain/ can resolve separate web3.js installations.
    // The production codec deliberately requires its own SDK's PublicKey class;
    // bridge only the public bytes and assert that the adapter changes none.
    const ProofPublicKey = PROOF_MODULE_PROGRAM_ID.constructor as typeof PublicKey;
    const proofKey = (key: PublicKey) => {
      const converted = new ProofPublicKey(key.toBytes());
      expect(Buffer.from(converted.toBytes()).equals(key.toBuffer())).to.equal(true);
      return converted;
    };
    const production = buildProductionTree([
      { programId: proofKey(PROGRAM_ID), config: proofKey(config), weekStart: start, index: fixture.policy.maxPlaces - 1, claimant: proofKey(actor("claimant").publicKey), amount: 19n },
      { programId: proofKey(PROGRAM_ID), config: proofKey(config), weekStart: start, index: 1, claimant: proofKey(actor("second").publicKey), amount: 31n },
      { programId: proofKey(PROGRAM_ID), config: proofKey(config), weekStart: start, index: 0, claimant: proofKey(actor("claimant").publicKey), amount: 23n },
    ], { maxPlaces: fixture.policy.maxPlaces });
    const tree: Tree = {
      root: Buffer.from(production.root), total: production.total,
      leaves: production.leaves.map(({ index, claimant, amount }) => {
        const validatorClaimant = new PublicKey(claimant.toBytes());
        expect(validatorClaimant.toBuffer().equals(Buffer.from(claimant.toBytes()))).to.equal(true);
        return { index, claimant: validatorClaimant, amount };
      }),
      proofs: production.leaves.map((leaf) => production.getProof(leaf.index).map((node) => ({ ...node, hash: Buffer.from(node.hash) }))),
    };
    const oracle = treeFor(config, start, tree.leaves);
    expect(tree.root.equals(oracle.root)).to.equal(true);
    expect(tree.total).to.equal(oracle.total);
    expect(tree.leaves.length).to.equal(production.leafCount);
    expect(tree.root.toString('hex')).to.equal(pinned.rootHex);
    expect(tree.total.toString()).to.equal(pinned.total);
    expect(tree.leaves.map(leaf => ({ index: leaf.index, claimantHex: leaf.claimant.toBuffer().toString('hex'), amount: leaf.amount.toString() })))
      .to.deep.equal(pinned.input.leaves);
    expect(tree.proofs.map(proof => proof.map(node => ({ hashHex: node.hash.toString('hex'), sum: node.sum.toString(), isLeft: node.isLeft }))))
      .to.deep.equal(pinned.proofs);
    const openedSignature = await committedProvider(actor("funder")).sendAndConfirm(new Transaction().add(await openIx(start, tree)));
    const openedEvidence = await finalizedTransaction(openedSignature);
    const openedState = await program.account.leagueWeek.fetch(pda(start), 'finalized');
    expect(Buffer.from(openedState.root).toString('hex')).to.equal(pinned.rootHex);
    expect(asBigInt(openedState.totalRaw).toString()).to.equal(pinned.total);
    const claims: Array<{ signature: string; slot: number; index: number; amount: string; destinationDelta: string }> = [];
    for (let position = 0; position < tree.leaves.length; position++) {
      const leaf = tree.leaves[position];
      const wallet = leaf.claimant.equals(actor("claimant").publicKey) ? actor("claimant") : actor("second");
      const before = await finalizedAmount(ata(wallet.publicKey));
      const signature = await committedProvider(wallet).sendAndConfirm(new Transaction().add(await claimIx(start, tree, position, wallet)));
      const finalized = await finalizedTransaction(signature);
      const destinationDelta = await finalizedAmount(ata(wallet.publicKey)) - before;
      expect(destinationDelta).to.equal(leaf.amount);
      expect(await amount(ata(wallet.publicKey)) - before).to.equal(leaf.amount);
      claims.push({ ...finalized, index: leaf.index, amount: leaf.amount.toString(), destinationDelta: destinationDelta.toString() });
    }
    const state = await program.account.leagueWeek.fetch(pda(start), 'finalized');
    expect(asBigInt(state.claimedRaw)).to.equal(production.total);
    expect(state.claimedCount).to.equal(production.leafCount);
    expect(await amount(vaultFor(start))).to.equal(0n);
    expect(await finalizedAmount(vaultFor(start))).to.equal(0n);
    expect(Buffer.from(state.root).toString('hex')).to.equal(pinned.rootHex);
    const expectedBitmap: number[] = Array(state.claimedBitmap.length).fill(0);
    for (const leaf of tree.leaves) expectedBitmap[Math.floor(leaf.index / 8)] |= 1 << (leaf.index % 8);
    expect([...state.claimedBitmap]).to.deep.equal(expectedBitmap);
    recordOracleClaimResult(fixture, { commitment: 'finalized', programId: PROGRAM_ID.toBase58(), config: config.toBase58(),
      week: pda(start).toBase58(), weekStart: start.toString(), opened: openedEvidence, claims,
      rootHex: Buffer.from(state.root).toString('hex'), total: asBigInt(state.totalRaw).toString(),
      claimedRaw: asBigInt(state.claimedRaw).toString(), claimedCount: state.claimedCount,
      bitmap: [...state.claimedBitmap], remainingVault: '0' });
  });

  it("A01 lamport-prefunded vault opens successfully with exact token deltas", async () => {
    const start = past();
    const tree = sample(start);
    await send(actor("stranger"), [SystemProgram.transfer({ fromPubkey: actor("stranger").publicKey, toPubkey: vaultFor(start), lamports: await connection().getMinimumBalanceForRentExemption(0) })]);
    const funderBefore = await amount(funderAta);
    await send(actor("funder"), [await openIx(start, tree)]);
    expect(funderBefore - await amount(funderAta)).to.equal(tree.total);
    expect(await amount(vaultFor(start)) - 0n).to.equal(tree.total);
  });
  it("A02 third party cannot allocate/init/fund a pre-open seeded SPL vault; later open succeeds", async () => {
    const start = past();
    const vault = vaultFor(start);
    await send(actor("stranger"), [SystemProgram.transfer({ fromPubkey: actor("stranger").publicKey, toPubkey: vault, lamports: await connection().getMinimumBalanceForRentExemption(0) })]);
    const allocate = SystemProgram.allocate({ accountPubkey: vault, space: ACCOUNT_SIZE });
    // Without the unavailable PDA signature, System itself must reject allocation.
    allocate.keys = allocate.keys.map((key) => ({ ...key, isSigner: false }));
    await refuses("System::MissingRequiredSignature", () => send(actor("stranger"), [allocate]), watched(start),
      { program: SystemProgram.programId, reason: "missing required signature for instruction" });
    await refuses("Token::InvalidAccountData", () => send(actor("stranger"), [createInitializeAccount3Instruction(vault, mint, pda(start))]), watched(start),
      { program: TOKEN_PROGRAM_ID, reason: "invalid account data for instruction" });
    await refuses("Token::InvalidAccountData", () => send(actor("funder"), [createTransferCheckedInstruction(funderAta, mint, vault, actor("funder").publicKey, 1n, decimals)]), watched(start),
      { program: TOKEN_PROGRAM_ID, reason: "invalid account data for instruction" });
    const tree = sample(start);
    await send(actor("funder"), [await openIx(start, tree)]);
    expect(asBigInt((await weekState(start)).totalRaw)).to.equal(tree.total);
  });
  it("A03 newer and older paying weeks may open in reverse order and both claim", async () => {
    const newer = await opened(true);
    const older = await opened(true);
    expect(older.start < newer.start).to.equal(true);
    for (const item of [newer, older]) {
      await send(actor("claimant"), [await claimIx(item.start, item.tree)]);
      expect(asBigInt((await weekState(item.start)).claimedRaw)).to.equal(item.tree.total);
    }
  });
  it("39 malicious root sum larger than funded total cannot consume even the first leaf: InvalidProof", async () => {
    const start = past();
    const tree = sample(start);
    await send(actor("funder"), [await openIx(start, tree, {}, { total: tree.total - 1n })]);
    await refuses("InvalidProof", async () => send(actor("claimant"), [await claimIx(start, tree)]), watched(start));
  });
  it("A14 post-open donations cannot enlarge a signed entitlement: InvalidProof; donation preserved for sweep", async () => {
    donationCase = await opened();
    const beforeVault = await amount(vaultFor(donationCase.start));
    await send(actor("funder"), [createTransferCheckedInstruction(funderAta, mint, vaultFor(donationCase.start), actor("funder").publicKey, donorAmount, decimals)]);
    expect(await amount(vaultFor(donationCase.start)) - beforeVault).to.equal(donorAmount);
    await refuses("InvalidProof", async () => send(actor("claimant"), [await claimIx(donationCase.start, donationCase.tree, 0, actor("claimant"), {}, { amount: donationCase.tree.leaves[0].amount + donorAmount })]), watched(donationCase.start));
    await send(actor("claimant"), [await claimIx(donationCase.start, donationCase.tree)]);
    expect(await amount(vaultFor(donationCase.start))).to.equal(donationCase.tree.leaves[1].amount + donorAmount);
  });

  it("41 early permissionless sweep refuses: ClaimWindowOpen", async () => {
    // From here onward every deadline remains exact for the expired-claim,
    // explicit extension, permissionless sweep and zero-remainder assertions.
    protectClaimWindows = false;
    deadlineCase = await opened();
    extensionCase = await opened();
    await refuses("ClaimWindowOpen", async () => send(actor("stranger"), [await sweepIx(deadlineCase.start)]), watched(deadlineCase.start));
  });
  it("MAJOR-4 committed early sweep: Custom6021, finalized state unchanged and fee-only payer debit", async () => {
    await assertCommittedFailure({
      provider: committedProvider(actor("stranger")), instruction: await sweepIx(deadlineCase.start),
      programId: PROGRAM_ID, expectedCustomError: 6021, expectedErrorName: "ClaimWindowOpen", watchedAccounts: watched(deadlineCase.start),
    });
  });
  it("43 substituted sweep destination refuses: ConstraintAddress", async () => {
    await refuses("ConstraintAddress", async () => send(actor("stranger"), [await sweepIx(deadlineCase.start, { destination: fixture.noncanonicalSweepAccount })]), watched(deadlineCase.start, [fixture.noncanonicalSweepAccount]));
  });
  it("A04 non-admin extension refuses: Unauthorized", async () => {
    const state = await weekState(extensionCase.start);
    await refuses("Unauthorized", async () => send(actor("stranger"), [await extendIx(extensionCase.start, asBigInt(state.claimDeadline) + 1n, actor("stranger"))]), watched(extensionCase.start));
  });
  it("unopened week extension refuses: AccountNotInitialized", async () => {
    const start = past();
    await refuses("AccountNotInitialized", async () => send(actor("admin"), [await extendIx(start, await clock() + 120n)]), watched(start));
  });
  for (const difference of [0n, -1n]) {
    it(`A05 extension by ${difference} seconds refuses: InvalidDeadline`, async () => {
      const state = await weekState(extensionCase.start);
      await refuses("InvalidDeadline", async () => send(actor("admin"), [await extendIx(extensionCase.start, asBigInt(state.claimDeadline) + difference)]), watched(extensionCase.start));
    });
  }
  it("A06 extension beyond opened_at plus generated ceiling refuses: InvalidDeadline", async () => {
    const state = await weekState(extensionCase.start);
    await refuses("InvalidDeadline", async () => send(actor("admin"), [await extendIx(extensionCase.start, asBigInt(state.openedAt) + fixture.policy.claimWindowMaxSec + 1n)]), watched(extensionCase.start));
  });
  it("A08 admin extension while paused emits LeagueDeadlineExtended; claim succeeds after original deadline", async () => {
    const state = await weekState(extensionCase.start);
    const oldDeadline = asBigInt(state.claimDeadline);
    await send(actor("admin"), [await pauseIx(true)]);
    const newDeadline = oldDeadline + BigInt(fixture.shortWindowSec);
    const signature = await send(actor("admin"), [await extendIx(extensionCase.start, newDeadline)]);
    const emitted = await event(signature, "leagueDeadlineExtended");
    expect(asBigInt(emitted.previousDeadline)).to.equal(oldDeadline);
    expect(asBigInt(emitted.newDeadline)).to.equal(newDeadline);
    expect(emitted.week.equals(pda(extensionCase.start))).to.equal(true);
    await send(actor("admin"), [await pauseIx(false)]);
    await waitUntil(oldDeadline);
    expect(await clock() < newDeadline, "A live extended interval is required").to.equal(true);
    const before = await amount(claimantAta);
    await send(actor("claimant"), [await claimIx(extensionCase.start, extensionCase.tree)]);
    expect(await amount(claimantAta) - before).to.equal(extensionCase.tree.leaves[0].amount);
  });
  it("34 at/after deadline claim refuses: ClaimExpired", async () => {
    const state = await weekState(deadlineCase.start);
    await waitUntil(asBigInt(state.claimDeadline));
    await refuses("ClaimExpired", async () => send(actor("claimant"), [await claimIx(deadlineCase.start, deadlineCase.tree)]), watched(deadlineCase.start));
  });
  it("paused expired sweep refuses: Paused", async () => {
    await send(actor("admin"), [await pauseIx(true)]);
    await refuses("Paused", async () => send(actor("stranger"), [await sweepIx(deadlineCase.start)]), watched(deadlineCase.start));
    await send(actor("admin"), [await pauseIx(false)]);
  });
  it("42/A14 permissionless sweep returns exact remainder plus donation, marks state and emits LeagueWeekSwept", async () => {
    const state = await weekState(donationCase.start);
    await waitUntil(asBigInt(state.claimDeadline));
    const beforeVault = await amount(vaultFor(donationCase.start));
    const beforeDestination = await amount(sweepAta);
    expect(beforeVault).to.equal(donationCase.tree.leaves[1].amount + donorAmount);
    const signature = await send(actor("stranger"), [await sweepIx(donationCase.start)]);
    expect(beforeVault - await amount(vaultFor(donationCase.start))).to.equal(beforeVault);
    expect(await amount(sweepAta) - beforeDestination).to.equal(beforeVault);
    const after = await weekState(donationCase.start);
    expect(after.swept).to.equal(true);
    expect(asBigInt(after.sweptRaw)).to.equal(beforeVault);
    expect(asBigInt(after.claimedRaw)).to.equal(donationCase.tree.leaves[0].amount);
    const emitted = await event(signature, "leagueWeekSwept");
    expect(asBigInt(emitted.amount)).to.equal(beforeVault);
    expect(emitted.destination.equals(sweepAta)).to.equal(true);
    expect(emitted.week.equals(pda(donationCase.start))).to.equal(true);
    expect(await connection().getAccountInfo(vaultFor(donationCase.start))).not.to.equal(null);
    expect(await connection().getAccountInfo(pda(donationCase.start))).not.to.equal(null);
  });
  it("42 second sweep refuses: WeekSwept", async () => {
    await refuses("WeekSwept", async () => send(actor("stranger"), [await sweepIx(donationCase.start)]), watched(donationCase.start));
  });
  it("35 claim after sweep refuses WeekSwept before expired-window checks", async () => {
    await refuses("WeekSwept", async () => send(actor("second"), [await claimIx(donationCase.start, donationCase.tree, 1, actor("second"))]), watched(donationCase.start));
  });
  it("A07 extending a swept week refuses: WeekSwept", async () => {
    const state = await weekState(donationCase.start);
    await refuses("WeekSwept", async () => send(actor("admin"), [await extendIx(donationCase.start, asBigInt(state.claimDeadline) + 1n)]), watched(donationCase.start));
  });
  it("zero-remaining sweep still marks a fully claimed week and emits LeagueWeekSwept with zero deltas", async () => {
    await waitUntil(asBigInt((await weekState(primary.start)).claimDeadline));
    const before = await amount(sweepAta);
    const signature = await send(actor("stranger"), [await sweepIx(primary.start)]);
    expect(await amount(sweepAta) - before).to.equal(0n);
    expect(asBigInt((await weekState(primary.start)).sweptRaw)).to.equal(0n);
    expect((await weekState(primary.start)).swept).to.equal(true);
    const emitted = await event(signature, "leagueWeekSwept");
    expect(asBigInt(emitted.amount)).to.equal(0n);
  });
  it("MAJOR-3 smoke: unrelated week A accounts stay unchanged while only week B is transacted", async () => {
    const weekA = await opened();
    const addressesA = [pda(weekA.start), vaultFor(weekA.start)];
    const beforeA = await snapshot(addressesA);
    const weekB = await opened();
    expect(pda(weekA.start).equals(addressesA[0])).to.equal(true);
    expect(vaultFor(weekA.start).equals(addressesA[1])).to.equal(true);
    expect(await snapshot(addressesA)).to.deep.equal(beforeA);
    await send(actor("claimant"), [await claimIx(weekB.start, weekB.tree)]);
    expect(await snapshot(addressesA)).to.deep.equal(beforeA);
    await waitUntil(asBigInt((await weekState(weekB.start)).claimDeadline));
    await send(actor("stranger"), [await sweepIx(weekB.start)]);
    expect((await weekState(weekB.start)).swept).to.equal(true);
    expect(await snapshot(addressesA)).to.deep.equal(beforeA);
  });
  it("44 guardian may pause but cannot unpause: Unauthorized; admin can restore service", async () => {
    await send(actor("guardian"), [await pauseIx(true, actor("guardian"))]);
    expect((await configState()).paused).to.equal(true);
    await refuses("Unauthorized", async () => send(actor("guardian"), [await pauseIx(false, actor("guardian"))]), watched());
    await send(actor("admin"), [await pauseIx(false)]);
  });
  for (const value of [true, false]) {
    it(`45 stranger cannot set paused=${value}: Unauthorized`, async () => {
      await refuses("Unauthorized", async () => send(actor("stranger"), [await pauseIx(value, actor("stranger"))]), watched());
    });
  }
  it("46 non-admin cannot set funder: Unauthorized", async () => {
    await refuses("Unauthorized", async () => send(actor("stranger"), [await program.methods.setFunder(actor("second").publicKey).accountsStrict({ signer: actor("stranger").publicKey, config }).instruction()]), watched());
  });
  it("set_funder rejects zero authority: InvalidAuthority", async () => {
    await refuses("InvalidAuthority", async () => send(actor("admin"), [await program.methods.setFunder(PublicKey.default).accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]), watched());
  });
  it("propose_admin rejects a zero successor: InvalidAuthority", async () => {
    await refuses("InvalidAuthority", async () => send(actor("admin"), [await program.methods.proposeAdmin(PublicKey.default).accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]), watched());
  });
  it("MAJOR-3 accept_admin without a pending proposal refuses: Unauthorized", async () => {
    expect((await configState()).pendingAdmin).to.equal(null);
    await refuses("Unauthorized", async () => send(actor("nextAdmin"), [await program.methods.acceptAdmin().accountsStrict({ signer: actor("nextAdmin").publicKey, config }).instruction()]), watched());
  });
  it("47 wrong proposer and accepter refuse: Unauthorized; valid two-step handoff clears pending admin", async () => {
    await refuses("Unauthorized", async () => send(actor("stranger"), [await program.methods.proposeAdmin(actor("nextAdmin").publicKey).accountsStrict({ signer: actor("stranger").publicKey, config }).instruction()]), watched());
    await send(actor("admin"), [await program.methods.proposeAdmin(actor("nextAdmin").publicKey).accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]);
    expect((await configState()).pendingAdmin?.equals(actor("nextAdmin").publicKey)).to.equal(true);
    await refuses("Unauthorized", async () => send(actor("stranger"), [await program.methods.acceptAdmin().accountsStrict({ signer: actor("stranger").publicKey, config }).instruction()]), watched());
    await send(actor("nextAdmin"), [await program.methods.acceptAdmin().accountsStrict({ signer: actor("nextAdmin").publicKey, config }).instruction()]);
    const changed = await configState();
    expect(changed.admin.equals(actor("nextAdmin").publicKey)).to.equal(true);
    expect(changed.pendingAdmin).to.equal(null);
    await refuses("Unauthorized", async () => send(actor("admin"), [await pauseIx(true)]), watched());
    // Restore using the same authorized two-step protocol, never overwrite state.
    await send(actor("nextAdmin"), [await program.methods.proposeAdmin(actor("admin").publicKey).accountsStrict({ signer: actor("nextAdmin").publicKey, config }).instruction()]);
    await send(actor("admin"), [await program.methods.acceptAdmin().accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]);
  });
  it("admin set_funder updates the sole opening role without changing immutable destinations", async () => {
    await send(actor("admin"), [await program.methods.setFunder(actor("second").publicKey).accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]);
    const state = await configState();
    expect(state.funder.equals(actor("second").publicKey)).to.equal(true);
    expect(state.sweepAta.equals(sweepAta)).to.equal(true);
    expect(state.sweepOwner.equals(actor("funder").publicKey)).to.equal(true);
    expect(state.mint.equals(mint)).to.equal(true);
    await send(actor("admin"), [await program.methods.setFunder(actor("funder").publicKey).accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]);
  });
  it("MAJOR-3 old funder loses opening authority after set_funder: Unauthorized", async () => {
    await send(actor("admin"), [await program.methods.setFunder(actor("second").publicKey).accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]);
    const start = past();
    await refuses("Unauthorized", async () => send(actor("funder"), [await openIx(start, sample(start))]), watched(start));
    await send(actor("admin"), [await program.methods.setFunder(actor("funder").publicKey).accountsStrict({ signer: actor("admin").publicKey, config }).instruction()]);
  });
});
