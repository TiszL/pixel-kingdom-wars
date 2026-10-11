/** Pure, internal claim-preparation slice (7002e405; 9c1f69b4).
 * No DB, environment, RPC, wallet, key, signer or transaction submission.
 * The later observer must authenticate deployment evidence and obtain account
 * bytes + Clock at one finalized context. A caller-supplied 'finalized' string
 * is not proof. Never expose these inputs through a public route.
 * Preparation is not permission to sign or activation of league claims. */
import { PublicKey } from '@solana/web3.js';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { LEAGUES, PHASE_E_LEAGUE_REWARDS } from '@shardkeep/shared';
import { verifyProof, type LeagueTree } from '@shardkeep/chain/league-claim-proof';
import {
  LEAGUE_PROGRAM_ID, LEAGUE_WEEK_SEC, leagueConfigPda, leagueProgramDataPda,
  isLeagueWeekStart, decodeLeagueConfig, decodeLeagueWeek,
  buildOpenWeekInstruction, buildExtendClaimDeadlineInstruction,
  type LeagueRawAccount, type OpenWeekInput,
} from '@shardkeep/chain/league-claim-protocol';

export type LeagueClaimPreparationCode = 'DISABLED' | 'PIN' | 'FINALITY' | 'CONFIG'
  | 'WEEK' | 'CLOCK' | 'PAUSED' | 'TREE_CONTEXT' | 'TREE_TOTAL' | 'TREE_COUNT'
  | 'TREE_INDEX' | 'TREE_ROOT' | 'ALLOCATION_HASH' | 'PROOF' | 'SWEPT'
  | 'PAUSE_REQUIRED' | 'EXTENSION' | 'ADMIN';
export class LeagueClaimPreparationError extends Error {
  constructor(readonly code: LeagueClaimPreparationCode) {
    super(`League claim preparation refused: ${code}`);
    this.name = 'LeagueClaimPreparationError';
  }
}
function need(value: unknown, code: LeagueClaimPreparationCode): asserts value {
  if (!value) throw new LeagueClaimPreparationError(code);
}
// Wire limits, not game tuning. All game policy is read from shared constants.
const U64_MAX = (1n << 64n) - 1n, I64_MAX = (1n << 63n) - 1n;
const policy = PHASE_E_LEAGUE_REWARDS.v1.skr;
function sameKey(left: PublicKey, right: PublicKey): boolean {
  return left instanceof PublicKey && right instanceof PublicKey && left.equals(right);
}
function uint64(value: bigint): boolean {
  return typeof value === 'bigint' && value >= 0n && value <= U64_MAX;
}
function clock(value: bigint): void {
  need(typeof value === 'bigint' && value > 0n && value <= I64_MAX, 'CLOCK');
}
function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return left instanceof Uint8Array && right instanceof Uint8Array
    && left.length === 32 && right.length === 32
    && left.every((byte, index) => byte === right[index]);
}

/** Pins must come from the separately reviewed deployment/configuration, never
 * from the observation they are checking. No deployment values are defaulted. */
export interface LeagueClaimPins {
  readonly enabled?: boolean | undefined;
  readonly cluster?: string;
  readonly programId: PublicKey;
  readonly config: PublicKey;
  readonly mint: PublicKey;
  readonly decimals: number;
  readonly funder: PublicKey;
  readonly sweepOwner: PublicKey;
  readonly deploymentSlot: bigint;
  readonly programDataSha256: string;
}
/** Trusted-observer boundary, not a transport DTO. The future reader must verify
 * Program/ProgramData bytes, owner, linkage, executable state, hash and slot.
 * This pure slice compares that reader's result to reviewed pins; it does not
 * implement or replace the reader. Config, optional week and Clock must all
 * belong to this same context. No wall-clock or RPC fallback is provided. */
export interface LeagueClaimSnapshot {
  readonly commitment: string;
  readonly contextSlot: bigint;
  readonly genesisHash: string;
  readonly deployment: {
    readonly programId: PublicKey;
    readonly programData: PublicKey;
    readonly deploymentSlot: bigint;
    readonly programDataSha256: string;
  };
  readonly configAccount: LeagueRawAccount;
  readonly clockUnixTimestamp: bigint;
}

export function readPinnedLeagueConfig(pins: LeagueClaimPins, snapshot: LeagueClaimSnapshot) {
  need(pins && pins.enabled === true, 'DISABLED');
  need(pins.cluster === 'devnet' && sameKey(pins.programId, LEAGUE_PROGRAM_ID)
    && sameKey(pins.config, leagueConfigPda(LEAGUE_PROGRAM_ID)), 'PIN');
  need(uint64(pins.deploymentSlot) && typeof pins.programDataSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(pins.programDataSha256), 'PIN');
  need(snapshot && snapshot.commitment === 'finalized' && uint64(snapshot.contextSlot)
    && snapshot.contextSlot >= pins.deploymentSlot, 'FINALITY');
  const observed = snapshot.deployment;
  need(snapshot.genesisHash === SOLANA_GENESIS_HASH.devnet && observed
    && sameKey(observed.programId, pins.programId)
    && sameKey(observed.programData, leagueProgramDataPda())
    && observed.deploymentSlot === pins.deploymentSlot
    && observed.programDataSha256 === pins.programDataSha256, 'PIN');
  clock(snapshot.clockUnixTimestamp);
  // R2: the program's <= ceiling check does not enforce the owner's window.
  // Only this shared member supplies the expected window; never use RPC state.
  need(Number.isSafeInteger(policy.claimWindowSec) && policy.claimWindowSec > 0, 'CONFIG');
  try {
    return decodeLeagueConfig(snapshot.configAccount, {
      programId: pins.programId, mint: pins.mint, decimals: pins.decimals,
      funder: pins.funder, sweepOwner: pins.sweepOwner,
      claimWindowSec: BigInt(policy.claimWindowSec),
    });
  } catch { throw new LeagueClaimPreparationError('CONFIG'); }
}

export interface PrepareOpenWeekInput {
  readonly pins: LeagueClaimPins;
  readonly snapshot: LeagueClaimSnapshot;
  readonly tree: LeagueTree;
  /** Independently recomputed allocation arguments from immutable DB evidence. */
  readonly instruction: OpenWeekInput;
  readonly evidenceHash: Uint8Array;
}

/** Internal Cedar3 preparation only. Future DB assembly must select positive
 * entitlements, index=place-1, and bind these arguments to allocated_raw and
 * evidence_hash. This slice checks the complete tree against those arguments. */
export function prepareOpenWeek(input: PrepareOpenWeekInput) {
  const { pins, snapshot, tree } = input;
  const config = readPinnedLeagueConfig(pins, snapshot);
  need(!config.paused, 'PAUSED');
  // Capture caller values once, before walking arbitrary proof getters.
  const programId = new PublicKey(pins.programId.toBytes()), mint = new PublicKey(pins.mint.toBytes());
  const configAddress = new PublicKey(pins.config.toBytes()), funder = new PublicKey(pins.funder.toBytes());
  const now = snapshot.clockUnixTimestamp;
  const args = { weekStart: input.instruction.weekStart,
    root: new Uint8Array(input.instruction.root), totalRaw: input.instruction.totalRaw,
    leafCount: input.instruction.leafCount,
    allocationHash: new Uint8Array(input.instruction.allocationHash) };
  const root = new Uint8Array(tree.root), total = tree.total, count = tree.leafCount;
  const leaves = tree.leaves.map(leaf => ({ ...leaf,
    programId: new PublicKey(leaf.programId.toBytes()), config: new PublicKey(leaf.config.toBytes()),
    claimant: new PublicKey(leaf.claimant.toBytes()) }));
  need(isLeagueWeekStart(args.weekStart), 'TREE_CONTEXT');
  need(uint64(total) && total > 0n && total === args.totalRaw, 'TREE_TOTAL');
  need(Number.isSafeInteger(count) && count > 0 && count <= policy.maxPlaces
    && count === args.leafCount && leaves.length === count, 'TREE_COUNT');
  need(sameHash(root, args.root) && root.some(byte => byte !== 0), 'TREE_ROOT');
  need(sameHash(input.evidenceHash, args.allocationHash), 'ALLOCATION_HASH');
  const indexes = new Set<number>(), cannotClaimIndexes: number[] = [];
  let sum = 0n;
  for (const leaf of leaves) {
    need(sameKey(leaf.programId, programId) && sameKey(leaf.config, configAddress)
      && leaf.weekStart === args.weekStart, 'TREE_CONTEXT');
    need(Number.isSafeInteger(leaf.index) && leaf.index >= 0 && leaf.index < policy.maxPlaces
      && !indexes.has(leaf.index), 'TREE_INDEX');
    indexes.add(leaf.index);
    need(uint64(leaf.amount) && leaf.amount > 0n, 'TREE_TOTAL');
    sum += leaf.amount;
    need(sum <= U64_MAX, 'TREE_TOTAL');
    if (!PublicKey.isOnCurve(leaf.claimant.toBytes())) cannotClaimIndexes.push(leaf.index);
  }
  need(sum === total, 'TREE_TOTAL');
  for (const leaf of leaves) {
    try { need(verifyProof(leaf, tree.getProof(leaf.index), root, total), 'PROOF'); }
    catch { throw new LeagueClaimPreparationError('PROOF'); }
  }
  need(Number.isSafeInteger(LEAGUES.settlementDelayMs) && LEAGUES.settlementDelayMs > 0
    && LEAGUES.settlementDelayMs % 1000 === 0, 'CLOCK');
  const settlesAt = args.weekStart + LEAGUE_WEEK_SEC + BigInt(LEAGUES.settlementDelayMs / 1000);
  need(settlesAt <= I64_MAX && now >= settlesAt, 'CLOCK');
  return Object.freeze({
    instruction: buildOpenWeekInstruction({ programId, mint }, { ...args, funder }),
    weekStart: args.weekStart, root: Buffer.from(root).toString('hex'), totalRaw: total,
    leafCount: count, allocationHash: Buffer.from(args.allocationHash).toString('hex'),
    verifiedLeafCount: leaves.length,
    cannotClaimIndexes: Object.freeze(cannotClaimIndexes.sort((left, right) => left - right)),
  });
}

function readWeekState(pins: LeagueClaimPins, snapshot: LeagueClaimSnapshot,
  rawWeek: LeagueRawAccount, weekStart: bigint) {
  const config = readPinnedLeagueConfig(pins, snapshot);
  let week: ReturnType<typeof decodeLeagueWeek>;
  try { week = decodeLeagueWeek(rawWeek, { programId: pins.programId, weekStart }); }
  catch { throw new LeagueClaimPreparationError('WEEK'); }
  need(snapshot.clockUnixTimestamp >= week.openedAt, 'CLOCK');
  return { config, week };
}

/** Week-level window only, not a wallet claim-status DTO. In particular an
 * expired unswept week does NOT prove funds have already returned to treasury. */
export function readLeagueClaimWindow(pins: LeagueClaimPins, snapshot: LeagueClaimSnapshot,
  rawWeek: LeagueRawAccount, weekStart: bigint) {
  const { config, week } = readWeekState(pins, snapshot, rawWeek, weekStart);
  // 7143ecd0: pause blocks sweeping; an elapsed deadline can still be
  // restored until the shared ceiling. Only swept proves a return occurred.
  const now = snapshot.clockUnixTimestamp;
  const expired = week.swept || now >= week.openedAt + BigInt(policy.claimWindowMaxSec)
    || (!config.paused && now >= week.claimDeadline);
  const status: 'expired' | 'paused' | 'open' = expired ? 'expired' : config.paused ? 'paused' : 'open';
  return Object.freeze({ status, deadline: week.claimDeadline, swept: week.swept });
}

/** Recovery ordering: remain paused, extend, observe finalized new deadline,
 * then separately seek the action-time permission to unpause. No automatic
 * unpause, deadline clamping, token-account closure or reassignment exists here. */
export function prepareDeadlineExtension(input: {
  readonly pins: LeagueClaimPins; readonly snapshot: LeagueClaimSnapshot;
  readonly week: LeagueRawAccount; readonly weekStart: bigint;
  readonly admin: PublicKey;
  /** Explicitly approved restoration duration; never an old-deadline offset. */
  readonly restoreSeconds: bigint;
}) {
  const { pins, snapshot, weekStart } = input;
  const { config, week } = readWeekState(pins, snapshot, input.week, weekStart);
  need(!week.swept, 'SWEPT');
  need(config.paused, 'PAUSE_REQUIRED');
  need(sameKey(input.admin, new PublicKey(config.admin)), 'ADMIN');
  need(typeof input.restoreSeconds === 'bigint' && input.restoreSeconds > 0n
    && input.restoreSeconds <= I64_MAX, 'EXTENSION');
  need(Number.isSafeInteger(policy.claimWindowMaxSec) && policy.claimWindowMaxSec > 0, 'EXTENSION');
  const newDeadline = snapshot.clockUnixTimestamp + input.restoreSeconds;
  const ceiling = week.openedAt + BigInt(policy.claimWindowMaxSec);
  need(newDeadline <= I64_MAX && newDeadline > week.claimDeadline && newDeadline <= ceiling, 'EXTENSION');
  return Object.freeze({ newDeadline,
    instruction: buildExtendClaimDeadlineInstruction({ programId: pins.programId },
      { weekStart, newDeadline, admin: input.admin }) });
}
