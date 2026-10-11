/** M1bb tests-first, pure source only. Cedar3 owns all execution. */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { LEAGUES, PHASE_E_LEAGUE_REWARDS } from '@shardkeep/shared';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { buildTree, type LeagueTree, type Leaf } from '@shardkeep/chain/league-claim-proof';
import {
  LEAGUE_PROGRAM_ID, LEAGUE_WEEK_SEC, LEAGUE_CONFIG_ACCOUNT_BYTES,
  LEAGUE_BITMAP_BYTES, leagueConfigPda, leagueConfigPdaWithBump,
  leagueWeekPda, leagueWeekPdaWithBump, leagueVaultPda, leagueVaultPdaWithBump,
  leagueClassicAta, leagueProgramDataPda, type LeagueRawAccount,
} from '@shardkeep/chain/league-claim-protocol';
import {
  LeagueClaimPreparationError, readPinnedLeagueConfig, prepareOpenWeek,
  readLeagueClaimWindow, prepareDeadlineExtension,
  type LeagueClaimPins, type LeagueClaimSnapshot,
} from '../src/game/leagueSkrClaims';

// Public fixture addresses from 7002e405 / LC v1; no private key or signer.
const admin = new PublicKey('Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8');
const guardian = new PublicKey('AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv');
const treasury = new PublicKey('9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q');
const mint = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const policy = PHASE_E_LEAGUE_REWARDS.v1.skr;
const window = BigInt(policy.claimWindowSec), ceiling = BigInt(policy.claimWindowMaxSec);
const weekStart = 1_791_158_400n; // Fixed Monday fixture (2026-10-05), not a deployment date.
const openedAt = weekStart + LEAGUE_WEEK_SEC + BigInt(LEAGUES.settlementDelayMs / 1000);
const config = leagueConfigPda(LEAGUE_PROGRAM_ID);
const evidenceHash = new Uint8Array(32).fill(8);
const pins: LeagueClaimPins = {
  enabled: true, cluster: 'devnet', programId: LEAGUE_PROGRAM_ID, config,
  mint, decimals: 9, funder: treasury, sweepOwner: treasury,
  deploymentSlot: 10n, programDataSha256: 'a'.repeat(64),
};
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const disc = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
function rawConfig(options: { window?: bigint; paused?: boolean; funder?: PublicKey;
  mint?: PublicKey; sweepOwner?: PublicKey; decimals?: number } = {}): LeagueRawAccount {
  const actualMint = options.mint ?? mint, sweepOwner = options.sweepOwner ?? treasury;
  const bytes = Buffer.concat([
    disc('LeagueConfig'), Buffer.from([1]), admin.toBuffer(), Buffer.from([0]),
    guardian.toBuffer(), (options.funder ?? treasury).toBuffer(), actualMint.toBuffer(),
    TOKEN_PROGRAM_ID.toBuffer(), Buffer.from([options.decimals ?? 9]), sweepOwner.toBuffer(),
    leagueClassicAta(actualMint, sweepOwner).toBuffer(), i64(options.window ?? window),
    Buffer.from([options.paused ? 1 : 0, leagueConfigPdaWithBump(LEAGUE_PROGRAM_ID)[1]]),
  ]);
  return { address: config, owner: LEAGUE_PROGRAM_ID, executable: false,
    data: Buffer.concat([bytes, Buffer.alloc(LEAGUE_CONFIG_ACCOUNT_BYTES - bytes.length)]) };
}
function snapshot(configAccount = rawConfig(), clockUnixTimestamp = openedAt): LeagueClaimSnapshot {
  return { commitment: 'finalized', contextSlot: 20n, genesisHash: SOLANA_GENESIS_HASH.devnet,
    deployment: { programId: LEAGUE_PROGRAM_ID, programData: leagueProgramDataPda(),
      deploymentSlot: pins.deploymentSlot, programDataSha256: pins.programDataSha256 },
    configAccount, clockUnixTimestamp };
}
const leaves = (): Leaf[] => [
  { programId: LEAGUE_PROGRAM_ID, config, weekStart, index: 0, claimant: admin, amount: 7n },
  { programId: LEAGUE_PROGRAM_ID, config, weekStart, index: 2, claimant: guardian, amount: 11n },
];
const tree = () => buildTree(leaves(), { maxPlaces: policy.maxPlaces });
function request(t = tree()) {
  return { pins, snapshot: snapshot(), tree: t, evidenceHash,
    instruction: { weekStart, root: t.root, totalRaw: t.total, leafCount: t.leafCount,
      allocationHash: evidenceHash } };
}
function rawWeek(options: { deadline?: bigint; swept?: boolean; start?: bigint } = {}): LeagueRawAccount {
  const start = options.start ?? weekStart;
  const t = tree();
  return { address: leagueWeekPda(LEAGUE_PROGRAM_ID, start), owner: LEAGUE_PROGRAM_ID, executable: false,
    data: Buffer.concat([
      disc('LeagueWeek'), Buffer.from([1]), config.toBuffer(), i64(start), t.root,
      u64(t.total), u16(t.leafCount), evidenceHash, leagueVaultPda(LEAGUE_PROGRAM_ID, start).toBuffer(),
      u64(0n), u16(0), Buffer.alloc(LEAGUE_BITMAP_BYTES), i64(openedAt),
      i64(options.deadline ?? openedAt + window), Buffer.from([options.swept ? 1 : 0]),
      u64(options.swept ? t.total : 0n),
      Buffer.from([leagueWeekPdaWithBump(LEAGUE_PROGRAM_ID, start)[1], leagueVaultPdaWithBump(LEAGUE_PROGRAM_ID, start)[1]]),
    ]) };
}
function refused(fn: () => unknown, code: string) {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(LeagueClaimPreparationError);
    expect((error as LeagueClaimPreparationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected LeagueClaimPreparationError ${code}`);
}

describe('M1 claim preparation: owner pins and snapshot boundary', () => {
  it('CP01 accepts exact config and owner window from shared policy', () => {
    expect(readPinnedLeagueConfig(pins, snapshot()).claimWindowSec).toBe(window);
  });
  it('CP02 requires explicit enablement; an omitted flag is disabled', () => {
    refused(() => readPinnedLeagueConfig({ ...pins, enabled: undefined }, snapshot()), 'DISABLED');
  });
  it('CP03 refuses a non-devnet cluster', () => {
    refused(() => readPinnedLeagueConfig({ ...pins, cluster: 'mainnet-beta' }, snapshot()), 'PIN');
  });
  it('CP04 refuses another genesis', () => {
    refused(() => readPinnedLeagueConfig(pins, { ...snapshot(), genesisHash: admin.toBase58() }), 'PIN');
  });
  it('CP05 refuses a changed program pin', () => {
    refused(() => readPinnedLeagueConfig({ ...pins, programId: admin }, snapshot()), 'PIN');
  });
  it('CP06 refuses a noncanonical config pin', () => {
    refused(() => readPinnedLeagueConfig({ ...pins, config: admin }, snapshot()), 'PIN');
  });
  it('CP07 refuses an observed program substitution', () => {
    const s = snapshot();
    refused(() => readPinnedLeagueConfig(pins, { ...s, deployment: { ...s.deployment, programId: admin } }), 'PIN');
  });
  it('CP08 refuses an observed ProgramData address substitution', () => {
    const s = snapshot();
    refused(() => readPinnedLeagueConfig(pins, { ...s, deployment: { ...s.deployment, programData: admin } }), 'PIN');
  });
  it('CP09 refuses a deployment slot mismatch', () => {
    const s = snapshot();
    refused(() => readPinnedLeagueConfig(pins, { ...s, deployment: { ...s.deployment, deploymentSlot: 11n } }), 'PIN');
  });
  it('CP10 refuses a program hash mismatch', () => {
    const s = snapshot();
    refused(() => readPinnedLeagueConfig(pins, { ...s, deployment: { ...s.deployment, programDataSha256: 'b'.repeat(64) } }), 'PIN');
  });
  it('CP11 refuses an empty deployment pin', () => {
    refused(() => readPinnedLeagueConfig({ ...pins, programDataSha256: '' }, snapshot()), 'PIN');
  });
  it('CP12 refuses a confirmed-only observation', () => {
    refused(() => readPinnedLeagueConfig(pins, { ...snapshot(), commitment: 'confirmed' }), 'FINALITY');
  });
  it('CP13 refuses a snapshot older than the deployment', () => {
    refused(() => readPinnedLeagueConfig(pins, { ...snapshot(), contextSlot: 9n }), 'FINALITY');
  });
  it('CP14 refuses a non-owner window even though the chain allows it', () => {
    refused(() => readPinnedLeagueConfig(pins, snapshot(rawConfig({ window: window - 1n }))), 'CONFIG');
  });
  it('CP15 refuses a different mint', () => {
    refused(() => readPinnedLeagueConfig(pins, snapshot(rawConfig({ mint: admin }))), 'CONFIG');
  });
  it('CP16 refuses a different funder', () => {
    refused(() => readPinnedLeagueConfig(pins, snapshot(rawConfig({ funder: guardian }))), 'CONFIG');
  });
  it('CP17 refuses a different sweep owner', () => {
    refused(() => readPinnedLeagueConfig(pins, snapshot(rawConfig({ sweepOwner: guardian }))), 'CONFIG');
  });
  it('CP18 refuses different mint decimals', () => {
    refused(() => readPinnedLeagueConfig(pins, snapshot(rawConfig({ decimals: 6 }))), 'CONFIG');
  });
  it('CP19 refuses the wrong config account owner', () => {
    refused(() => readPinnedLeagueConfig(pins, snapshot({ ...rawConfig(), owner: admin })), 'CONFIG');
  });
});

describe('M1 prepareOpenWeek checks every leaf against the instruction', () => {
  it('CP20 prepares only an unsigned instruction with exact sparse leaf indexes', () => {
    const result = prepareOpenWeek(request());
    expect(result.verifiedLeafCount).toBe(2);
    expect(result.totalRaw).toBe(18n);
    expect(result.instruction.programId.equals(LEAGUE_PROGRAM_ID)).toBe(true);
    expect(result.instruction.keys[0]).toMatchObject({ pubkey: treasury, isSigner: true });
    expect(result.instruction.keys[1]!.pubkey.equals(config)).toBe(true);
    expect(result.instruction.data.readBigInt64LE(8)).toBe(weekStart);
    expect(result.instruction.data.subarray(16, 48)).toEqual(Buffer.from(tree().root));
    expect(result.instruction.data.readBigUInt64LE(48)).toBe(18n);
    expect(result.instruction.data.readUInt16LE(56)).toBe(2);
    expect(result.instruction.data.subarray(58)).toEqual(Buffer.from(evidenceHash));
  });
  it('CP21 refuses a different instruction week even for a valid tree', () => {
    const r = request(); r.instruction.weekStart += LEAGUE_WEEK_SEC;
    refused(() => prepareOpenWeek(r), 'TREE_CONTEXT');
  });
  it('CP22 refuses a tree for another program', () => {
    const t = buildTree(leaves().map(l => ({ ...l, programId: admin })), { maxPlaces: policy.maxPlaces });
    refused(() => prepareOpenWeek(request(t)), 'TREE_CONTEXT');
  });
  it('CP23 refuses a tree for another config', () => {
    const t = buildTree(leaves().map(l => ({ ...l, config: admin })), { maxPlaces: policy.maxPlaces });
    refused(() => prepareOpenWeek(request(t)), 'TREE_CONTEXT');
  });
  it('CP24 refuses an instruction total that differs from tree.total', () => {
    const r = request(); r.instruction.totalRaw++;
    refused(() => prepareOpenWeek(r), 'TREE_TOTAL');
  });
  it('CP25 refuses an instruction count that differs from tree.leafCount', () => {
    const r = request(); r.instruction.leafCount++;
    refused(() => prepareOpenWeek(r), 'TREE_COUNT');
  });
  it('CP26 refuses a declared count that hides an omitted leaf', () => {
    const t = tree();
    refused(() => prepareOpenWeek(request({ ...t, leaves: t.leaves.slice(0, 1) })), 'TREE_COUNT');
  });
  it('CP27 refuses duplicate indexes before accepting valid-looking membership', () => {
    const t = tree();
    refused(() => prepareOpenWeek(request({ ...t, leaves: [t.leaves[0]!, t.leaves[0]!] })), 'TREE_INDEX');
  });
  it('CP28 refuses an instruction root mismatch', () => {
    const r = request(); r.instruction.root = new Uint8Array(32).fill(1);
    refused(() => prepareOpenWeek(r), 'TREE_ROOT');
  });
  it('CP29 refuses allocation_hash differing from immutable evidence_hash', () => {
    const r = request(); r.instruction.allocationHash = new Uint8Array(32).fill(1);
    refused(() => prepareOpenWeek(r), 'ALLOCATION_HASH');
  });
  it('CP30 verifies the second leaf rather than checking only the first', () => {
    const t = tree(), visited: number[] = [];
    const dishonest: LeagueTree = { ...t, getProof(index) {
      visited.push(index); const proof = t.getProof(index);
      if (index === 2) proof[0]!.hash[0] = proof[0]!.hash[0]! ^ 1;
      return proof;
    } };
    refused(() => prepareOpenWeek(request(dishonest)), 'PROOF');
    expect(visited).toContain(0); expect(visited).toContain(2);
  });
  it('CP31 refuses a proof getter that throws', () => {
    const t = tree();
    refused(() => prepareOpenWeek(request({ ...t, getProof() { throw new Error('bad proof'); } })), 'PROOF');
  });
  it('CP32 refuses leaf sums inconsistent with the declared total', () => {
    const t = tree();
    refused(() => prepareOpenWeek(request({ ...t, total: t.total + 1n })), 'TREE_TOTAL');
  });
  it('CP33 flags an off-curve claimant without silently discarding their entitlement', () => {
    const t = buildTree([{ ...leaves()[0]!, claimant: config }], { maxPlaces: policy.maxPlaces });
    const result = prepareOpenWeek(request(t));
    expect(result.cannotClaimIndexes).toEqual([0]); expect(result.totalRaw).toBe(7n);
  });
  it('CP34 refuses opening while paused', () => {
    refused(() => prepareOpenWeek({ ...request(), snapshot: snapshot(rawConfig({ paused: true })) }), 'PAUSED');
  });
  it('CP35 refuses opening one second before settlement admission', () => {
    refused(() => prepareOpenWeek({ ...request(), snapshot: snapshot(rawConfig(), openedAt - 1n) }), 'CLOCK');
  });
});

describe('M1 deadline and pause recovery use the observed chain clock', () => {
  const read = (now: bigint, deadline = openedAt + window, swept = false, paused = false) =>
    readLeagueClaimWindow(pins, snapshot(rawConfig({ paused }), now), rawWeek({ deadline, swept }), weekStart);
  it('CP36 remains open one second before the on-chain deadline', () => {
    expect(read(openedAt + window - 1n).status).toBe('open');
  });
  it('CP37 is expired at exact deadline equality', () => {
    expect(read(openedAt + window).status).toBe('expired');
  });
  it('CP38 honors an extended on-chain deadline instead of openedAt plus default window', () => {
    const result = read(openedAt + window, openedAt + window + 1n);
    expect(result.status).toBe('open'); expect(result.deadline).toBe(openedAt + window + 1n);
  });
  it('CP39 reports swept independently even before a supplied later clock deadline', () => {
    const result = read(openedAt + window - 1n, openedAt + window, true);
    expect(result.status).toBe('expired'); expect(result.swept).toBe(true);
  });
  it('CP40 keeps a paused unswept week recoverable past its deadline (7143ecd0)', () => {
    expect(read(openedAt, openedAt + window, false, true).status).toBe('paused');
    expect(read(openedAt + window, openedAt + window, false, true).status).toBe('paused');
    const recovered = read(openedAt + window + 1n, openedAt + window, false, true);
    expect(recovered.status).toBe('paused'); expect(recovered.swept).toBe(false);
  });
  it('CP41 refuses a week observation for another PDA', () => {
    refused(() => readLeagueClaimWindow(pins, snapshot(), { ...rawWeek(), address: config }, weekStart), 'WEEK');
  });
  const extend = (now: bigint, restoreSeconds = window, paused = true, swept = false) =>
    prepareDeadlineExtension({ pins, snapshot: snapshot(rawConfig({ paused }), now),
      week: rawWeek({ swept }), weekStart, admin, restoreSeconds });
  it('CP42 computes the extension from current clock, never the stale old deadline', () => {
    const now = openedAt + window / 2n;
    const result = extend(now);
    expect(result.newDeadline).toBe(now + window);
    expect(result.instruction.data.readBigInt64LE(16)).toBe(now + window);
  });
  it('CP43 permits restoring an elapsed window while still paused', () => {
    expect(extend(openedAt + window).newDeadline).toBe(openedAt + ceiling);
  });
  it('CP44 refuses extending after a sweep', () => {
    refused(() => extend(openedAt + window, window, true, true), 'SWEPT');
  });
  it('CP45 requires extending before unpause', () => {
    refused(() => extend(openedAt + window, window, false), 'PAUSE_REQUIRED');
  });
  it('CP46 refuses exceeding the shared ceiling; never silently clamps duration', () => {
    refused(() => extend(openedAt + window + 1n), 'EXTENSION');
  });
  it('CP47 refuses a deadline that would not increase the existing one', () => {
    refused(() => extend(openedAt, window), 'EXTENSION');
  });
  it('CP48 refuses a zero restoration duration', () => {
    refused(() => extend(openedAt + window, 0n), 'EXTENSION');
  });
  it('CP49 refuses a non-admin extension signer', () => {
    refused(() => prepareDeadlineExtension({ pins, snapshot: snapshot(rawConfig({ paused: true }), openedAt + window),
      week: rawWeek(), weekStart, admin: guardian, restoreSeconds: window }), 'ADMIN');
  });
  it('CP50 refuses a chain clock before the week opening', () => {
    refused(() => read(openedAt - 1n), 'CLOCK');
  });
  it('CP59 keeps pause recoverable until one second before the shared ceiling', () => {
    expect(read(openedAt + ceiling - 1n, openedAt + window, false, true).status).toBe('paused');
  });
  it('CP60 expires a paused week at and after the shared ceiling without claiming a sweep', () => {
    for (const now of [openedAt + ceiling, openedAt + ceiling + 1n]) {
      const result = read(now, openedAt + window, false, true);
      expect(result.status).toBe('expired'); expect(result.swept).toBe(false);
    }
  });
  it('CP61 gives a completed sweep precedence over pause before the ceiling', () => {
    const result = read(openedAt + window - 1n, openedAt + window, true, true);
    expect(result.status).toBe('expired'); expect(result.swept).toBe(true);
  });
});

describe('M1 hand-built tree boundaries (7143ecd0)', () => {
  // Deliberately bypass buildTree validation so the preparation boundary itself
  // must reject these inputs, with its own typed error on the first invocation.
  const handmade = (changes: Partial<LeagueTree>): LeagueTree => ({ ...tree(), ...changes });
  it('CP51 refuses a leaf index exactly at maxPlaces', () => {
    const rows = leaves(); rows[0] = { ...rows[0]!, index: policy.maxPlaces };
    refused(() => prepareOpenWeek(request(handmade({ leaves: rows }))), 'TREE_INDEX');
  });
  it('CP52 refuses a leaf index above maxPlaces', () => {
    const rows = leaves(); rows[0] = { ...rows[0]!, index: policy.maxPlaces + 1 };
    refused(() => prepareOpenWeek(request(handmade({ leaves: rows }))), 'TREE_INDEX');
  });
  it('CP53 refuses a zero amount in a hand-built leaf', () => {
    const rows = leaves(); rows[0] = { ...rows[0]!, amount: 0n };
    // Match the reduced sum so removing the positive-amount guard reaches
    // PROOF, rather than accidentally passing on the final total check.
    refused(() => prepareOpenWeek(request(handmade({ leaves: rows, total: 11n }))), 'TREE_TOTAL');
  });
  it('CP54 refuses u64 sum overflow although each individual amount fits', () => {
    const rows = leaves();
    rows[0] = { ...rows[0]!, amount: (1n << 64n) - 1n };
    rows[1] = { ...rows[1]!, amount: 1n };
    refused(() => prepareOpenWeek(request(handmade({ leaves: rows }))), 'TREE_TOTAL');
  });
  it('CP55 refuses a zero root even when tree and instruction agree', () => {
    refused(() => prepareOpenWeek(request(handmade({ root: new Uint8Array(32) }))), 'TREE_ROOT');
  });
  it('CP56 refuses a non-Monday instruction week even with matching leaf weeks', () => {
    const r = request(handmade({ leaves: leaves().map(l => ({ ...l, weekStart: weekStart + 1n })) }));
    r.instruction.weekStart = weekStart + 1n;
    refused(() => prepareOpenWeek(r), 'TREE_CONTEXT');
  });
  it('CP57 accepts exactly maxPlaces leaves including the last permitted index', () => {
    const rows = Array.from({ length: policy.maxPlaces }, (_, index) => ({ ...leaves()[0]!, index, amount: 1n }));
    const valid = buildTree(rows, { maxPlaces: policy.maxPlaces });
    const visited: number[] = [];
    const t: LeagueTree = { ...valid, leafCount: policy.maxPlaces, leaves: rows,
      getProof(index) { visited.push(index); return valid.getProof(index); } };
    const result = prepareOpenWeek(request(t));
    expect(result.verifiedLeafCount).toBe(policy.maxPlaces);
    expect(result.totalRaw).toBe(BigInt(policy.maxPlaces));
    expect(visited).toEqual(rows.map(l => l.index));
  });
  it('CP58 refuses maxPlaces plus one leaves with matching declared count', () => {
    const rows = Array.from({ length: policy.maxPlaces + 1 }, (_, index) => ({ ...leaves()[0]!, index, amount: 1n }));
    refused(() => prepareOpenWeek(request(handmade({ leaves: rows, leafCount: rows.length, total: BigInt(rows.length) }))), 'TREE_COUNT');
  });
});
