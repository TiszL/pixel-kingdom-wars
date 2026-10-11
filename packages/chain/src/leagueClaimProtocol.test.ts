/** MS-LC tests-first source. Execution belongs exclusively to Cedar3. */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PublicKey, ComputeBudgetProgram, SystemProgram, Transaction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PHASE_E_LEAGUE_REWARDS, LEAGUES } from '@shardkeep/shared';
import {
  LEAGUE_CONFIG_ACCOUNT_BYTES, LEAGUE_WEEK_ACCOUNT_BYTES, LEAGUE_BITMAP_BYTES,
  LEAGUE_WEEK_SEC, LEAGUE_MONDAY_OFFSET_SEC, LEAGUE_PROGRAM_ID,
  LeagueProtocolError, leagueConfigPda, leagueWeekPda, leagueVaultPda,
  leagueConfigPdaWithBump, leagueWeekPdaWithBump, leagueVaultPdaWithBump,
  leagueProgramDataPda, leagueClassicAta, isLeagueWeekStart,
  encodeInitializeLeagueData, decodeInitializeLeagueData, encodeOpenWeekData,
  encodeClaimLeagueRewardData, encodeSweepWeekData, encodeExtendClaimDeadlineData,
  encodeSetLeaguePausedData, encodeProposeAdminData, encodeAcceptAdminData, encodeSetFunderData,
  buildInitializeLeagueInstruction, buildOpenWeekInstruction, buildClaimLeagueRewardInstruction,
  buildSweepWeekInstruction, buildExtendClaimDeadlineInstruction, buildSetLeaguePausedInstruction,
  buildProposeAdminInstruction, buildAcceptAdminInstruction, buildSetFunderInstruction,
  decodeLeagueConfig, decodeLeagueWeek, leagueClaimed,
  type LeagueRawAccount,
} from './leagueClaimProtocol';

// Public fixture addresses only: this suite never generates or reads a key.
const admin = new PublicKey('Ce5HrbPJ2naKQAbQ6Xga55WeFwVDavHhBzc2AsWd6KY8');
const guardian = new PublicKey('AvsebCwRDs63UMwKv2xSVCRKB8cxUS4W3B4sNR9SHpKv');
const funder = new PublicKey('9D1jdyFX5fUPeAF4ExHEQ7JgmrbryVEkDyibpKHqe99Q');
const mint = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const claimant = admin;
const identity = { programId: LEAGUE_PROGRAM_ID, mint };
const weekStart = 1_791_158_400n; // 2026-10-05 00:00 UTC, a Monday.
const policy = PHASE_E_LEAGUE_REWARDS.v1.skr;
const window = BigInt(policy.claimWindowSec);
const windowMax = BigInt(policy.claimWindowMaxSec);
const maxPlaces = policy.maxPlaces;
const config = leagueConfigPda(LEAGUE_PROGRAM_ID);
const week = leagueWeekPda(LEAGUE_PROGRAM_ID, weekStart);
const vault = leagueVaultPda(LEAGUE_PROGRAM_ID, weekStart);
const root = new Uint8Array(32).fill(7);
const allocationHash = new Uint8Array(32).fill(8);
const discriminator = (namespace: string, name: string) => createHash('sha256').update(`${namespace}:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
function refused(fn: () => unknown, code: string) {
  try { fn(); throw new Error('Expected protocol refusal'); }
  catch (error) { expect(error).toBeInstanceOf(LeagueProtocolError); expect((error as LeagueProtocolError).code).toBe(code); }
}
const configExpectation = { ...identity, decimals: 9, funder, sweepOwner: funder, claimWindowSec: window };
function configBytes(pending: PublicKey | null = null): Buffer {
  const active = Buffer.concat([
    discriminator('account', 'LeagueConfig'), Buffer.from([1]), admin.toBuffer(),
    pending ? Buffer.concat([Buffer.from([1]), pending.toBuffer()]) : Buffer.from([0]),
    guardian.toBuffer(), funder.toBuffer(), mint.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), Buffer.from([9]),
    funder.toBuffer(), getAssociatedTokenAddressSync(mint, funder, true).toBuffer(), i64(window),
    Buffer.from([0, leagueConfigPdaWithBump(LEAGUE_PROGRAM_ID)[1]]),
  ]);
  // Anchor can retain previous Option::Some bytes after it changes to None.
  return Buffer.concat([active, Buffer.alloc(277 - active.length, 0xa5)]);
}
function weekBytes(options: { claimedIndex?: number; swept?: boolean; claimedRaw?: bigint; totalRaw?: bigint; leafCount?: number; claimedCount?: number; openedAt?: bigint; deadline?: bigint; sweptRaw?: bigint } = {}): Buffer {
  const bitmap = Buffer.alloc(Math.ceil(maxPlaces / 8));
  if (options.claimedIndex !== undefined) bitmap[Math.floor(options.claimedIndex / 8)]! |= 1 << (options.claimedIndex % 8);
  const openedAt = options.openedAt ?? weekStart + 604800n + BigInt(LEAGUES.settlementDelayMs / 1000);
  return Buffer.concat([
    discriminator('account', 'LeagueWeek'), Buffer.from([1]), config.toBuffer(), i64(weekStart), root,
    u64(options.totalRaw ?? 9007199254740995n), u16(options.leafCount ?? 1), allocationHash, vault.toBuffer(),
    u64(options.claimedRaw ?? (options.claimedIndex === undefined ? 0n : 9007199254740995n)),
    u16(options.claimedCount ?? (options.claimedIndex === undefined ? 0 : 1)), bitmap,
    i64(openedAt), i64(options.deadline ?? openedAt + window), Buffer.from([options.swept ? 1 : 0]),
    u64(options.sweptRaw ?? 0n), Buffer.from([leagueWeekPdaWithBump(LEAGUE_PROGRAM_ID, weekStart)[1], leagueVaultPdaWithBump(LEAGUE_PROGRAM_ID, weekStart)[1]]),
  ]);
}
const rawConfig = (data = configBytes()): LeagueRawAccount => ({ address: config, owner: LEAGUE_PROGRAM_ID, executable: false, data });
const rawWeek = (data = weekBytes()): LeagueRawAccount => ({ address: week, owner: LEAGUE_PROGRAM_ID, executable: false, data });
function metas(ix: { keys: readonly { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] }) {
  return ix.keys.map(m => [m.pubkey.toBase58(), m.isWritable, m.isSigner]);
}
const meta = (key: PublicKey, writable = false, signer = false) => [key.toBase58(), writable, signer];

describe('league protocol identity and calendar (A13, A15)', () => {
  it('pins the owner-generated identity in Rust and localnet, with no league devnet entry', () => {
    expect(LEAGUE_PROGRAM_ID.toBase58()).toBe('2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE');
    const lib = readFileSync(new URL('../../../programs/shardkeep-league/src/lib.rs', import.meta.url), 'utf8');
    const anchor = readFileSync(new URL('../../../programs/Anchor.toml', import.meta.url), 'utf8');
    expect(lib).toContain(`declare_id!("${LEAGUE_PROGRAM_ID.toBase58()}")`);
    const section = (name: string) => anchor.split(`[${name}]`)[1]?.split(/\n\[/)[0] ?? '';
    expect(section('programs.localnet')).toMatch(new RegExp(`shardkeep_league\\s*=\\s*"${LEAGUE_PROGRAM_ID.toBase58()}"`));
    expect(section('programs.devnet')).not.toMatch(/shardkeep_league\s*=/);
  });
  it('pins protocol calendar independently of policy values', () => {
    expect(LEAGUE_WEEK_SEC).toBe(7n * 86400n);
    expect(LEAGUE_MONDAY_OFFSET_SEC).toBe(345600n);
    expect(BigInt(Date.parse('2026-10-05T00:00:00Z') / 1000)).toBe(weekStart);
    expect(isLeagueWeekStart(weekStart)).toBe(true);
    expect(isLeagueWeekStart(weekStart - 1n)).toBe(false);
    expect(isLeagueWeekStart(weekStart + 1n)).toBe(false);
    expect(isLeagueWeekStart(0n)).toBe(false);
    expect(isLeagueWeekStart(-259200n)).toBe(false);
  });
  it('derives canonical config, week and seeded vault, distinct from an ATA', () => {
    expect(config.equals(PublicKey.findProgramAddressSync([Buffer.from('league_config')], LEAGUE_PROGRAM_ID)[0])).toBe(true);
    expect(week.equals(PublicKey.findProgramAddressSync([Buffer.from('league_week'), config.toBuffer(), i64(weekStart)], LEAGUE_PROGRAM_ID)[0])).toBe(true);
    expect(vault.equals(PublicKey.findProgramAddressSync([Buffer.from('league_vault'), week.toBuffer()], LEAGUE_PROGRAM_ID)[0])).toBe(true);
    expect(vault.equals(getAssociatedTokenAddressSync(mint, week, true))).toBe(false);
    expect(leagueClassicAta(mint, claimant).equals(getAssociatedTokenAddressSync(mint, claimant, true, TOKEN_PROGRAM_ID))).toBe(true);
  });
  it('refuses an unreviewed program identity (IDENTITY)', () => {
    refused(() => leagueConfigPda(mint), 'IDENTITY');
    refused(() => buildSweepWeekInstruction({ ...identity, programId: mint }, { weekStart, sweepOwner: funder }), 'IDENTITY');
  });
});

describe('strict raw instruction bytes', () => {
  const initialize = { guardian, funder, claimWindowSec: window };
  it('case 10: uses exactly 80 bytes and the strict final i64 wrapper has unchanged wire', () => {
    const data = encodeInitializeLeagueData(initialize);
    expect(data).toEqual(Buffer.concat([discriminator('global', 'initialize_league'), guardian.toBuffer(), funder.toBuffer(), i64(window)]));
    expect(data.length).toBe(80);
    expect(decodeInitializeLeagueData(data)).toEqual({ guardian: guardian.toBase58(), funder: funder.toBase58(), claimWindowSec: window });
  });
  it('case 10: refuses legacy first-week field even when it is a valid modern window (WIRE)', () => {
    const legacy = Buffer.concat([discriminator('global', 'initialize_league'), guardian.toBuffer(), funder.toBuffer(), i64(345600n), i64(60n)]);
    refused(() => decodeInitializeLeagueData(legacy), 'WIRE');
    refused(() => decodeInitializeLeagueData(encodeInitializeLeagueData(initialize).subarray(0, 79)), 'WIRE');
    refused(() => decodeInitializeLeagueData(Buffer.concat([encodeInitializeLeagueData(initialize), Buffer.from([0])])), 'WIRE');
  });
  it('strictly binds the initializer discriminator (WIRE)', () => {
    const data = encodeInitializeLeagueData(initialize); data[0]! ^= 1;
    refused(() => decodeInitializeLeagueData(data), 'WIRE');
  });
  it('encodes lossless open amounts above Number.MAX_SAFE_INTEGER', () => {
    expect(encodeOpenWeekData({ weekStart, root, totalRaw: 9007199254740995n, leafCount: 1, allocationHash })).toEqual(Buffer.concat([
      discriminator('global', 'open_week'), i64(weekStart), root, u64(9007199254740995n), u16(1), allocationHash,
    ]));
  });
  it('encodes a claim vector with ordered hash, u64 and strict side', () => {
    const proof = [{ hash: root, sum: 9007199254740997n, isLeft: true }];
    expect(encodeClaimLeagueRewardData({ weekStart, index: maxPlaces - 1, amount: 9007199254740995n, proof })).toEqual(Buffer.concat([
      discriminator('global', 'claim_league_reward'), i64(weekStart), u16(maxPlaces - 1), u64(9007199254740995n), Buffer.from([1, 0, 0, 0]), root, u64(9007199254740997n), Buffer.from([1]),
    ]));
  });
  it('encodes sweep, extension and all four admin operations exactly', () => {
    expect(encodeSweepWeekData({ weekStart })).toEqual(Buffer.concat([discriminator('global', 'sweep_week'), i64(weekStart)]));
    expect(encodeExtendClaimDeadlineData({ weekStart, newDeadline: weekStart + window })).toEqual(Buffer.concat([discriminator('global', 'extend_claim_deadline'), i64(weekStart), i64(weekStart + window)]));
    expect(encodeSetLeaguePausedData({ paused: true })).toEqual(Buffer.concat([discriminator('global', 'set_league_paused'), Buffer.from([1])]));
    expect(encodeSetLeaguePausedData({ paused: false })).toEqual(Buffer.concat([discriminator('global', 'set_league_paused'), Buffer.from([0])]));
    expect(encodeProposeAdminData({ newAdmin: guardian })).toEqual(Buffer.concat([discriminator('global', 'propose_admin'), guardian.toBuffer()]));
    expect(encodeAcceptAdminData()).toEqual(discriminator('global', 'accept_admin'));
    expect(encodeSetFunderData({ newFunder: guardian })).toEqual(Buffer.concat([discriminator('global', 'set_funder'), guardian.toBuffer()]));
  });
  it.each([0n, -1n, windowMax + 1n])('refuses invalid window %s (INPUT)', claimWindowSec => {
    refused(() => encodeInitializeLeagueData({ ...initialize, claimWindowSec }), 'INPUT');
  });
  it('refuses zero authorities and non-boolean pause inputs (INPUT)', () => {
    refused(() => encodeInitializeLeagueData({ ...initialize, guardian: PublicKey.default }), 'INPUT');
    refused(() => encodeInitializeLeagueData({ ...initialize, funder: PublicKey.default }), 'INPUT');
    refused(() => encodeProposeAdminData({ newAdmin: PublicKey.default }), 'INPUT');
    refused(() => encodeSetFunderData({ newFunder: PublicKey.default }), 'INPUT');
    refused(() => encodeSetLeaguePausedData({ paused: 1 as unknown as boolean }), 'INPUT');
  });
  it.each([0n, -1n, 1n << 63n, weekStart + 1n])('refuses invalid signed calendar %s (INPUT)', invalid => {
    refused(() => encodeSweepWeekData({ weekStart: invalid }), 'INPUT');
  });
  it('refuses zero/overflow amounts, zero roots, illegal counts and fractional indexes (INPUT)', () => {
    const open = { weekStart, root, totalRaw: 1n, leafCount: 1, allocationHash };
    for (const totalRaw of [0n, -1n, 1n << 64n]) refused(() => encodeOpenWeekData({ ...open, totalRaw }), 'INPUT');
    refused(() => encodeOpenWeekData({ ...open, root: new Uint8Array(32) }), 'INPUT');
    for (const leafCount of [0, maxPlaces + 1, 1.5]) refused(() => encodeOpenWeekData({ ...open, leafCount }), 'INPUT');
    for (const index of [-1, maxPlaces, 0.5]) refused(() => encodeClaimLeagueRewardData({ weekStart, index, amount: 1n, proof: [] }), 'INPUT');
    refused(() => encodeClaimLeagueRewardData({ weekStart, index: 0, amount: 0n, proof: [] }), 'INPUT');
    refused(() => encodeOpenWeekData({ ...open, totalRaw: 9007199254740995 as unknown as bigint }), 'INPUT');
  });
  it('refuses malformed/deep proofs, unsafe extra wire fields and deadline overflow (INPUT)', () => {
    const claim = { weekStart, index: 0, amount: 1n, proof: [] };
    refused(() => encodeClaimLeagueRewardData({ ...claim, proof: [{ hash: root, sum: 1n, isLeft: 1 as unknown as boolean }] }), 'INPUT');
    refused(() => encodeClaimLeagueRewardData({ ...claim, proof: [{ hash: root.subarray(1), sum: 1n, isLeft: false }] }), 'INPUT');
    refused(() => encodeClaimLeagueRewardData({ ...claim, proof: Array.from({ length: 11 }, () => ({ hash: root, sum: 1n, isLeft: false })) }), 'INPUT');
    refused(() => encodeInitializeLeagueData({ ...initialize, firstWeekStart: weekStart } as typeof initialize), 'INPUT');
    refused(() => encodeExtendClaimDeadlineData({ weekStart, newDeadline: 1n << 63n }), 'INPUT');
  });
});

describe('canonical instruction account metas', () => {
  it('orders initializer accounts including exact linked ProgramData and classic programs', () => {
    const ix = buildInitializeLeagueInstruction(identity, { admin, guardian, funder, sweepOwner: funder, claimWindowSec: window });
    expect(metas(ix)).toEqual([meta(admin, true, true), meta(config, true), meta(LEAGUE_PROGRAM_ID), meta(leagueProgramDataPda()), meta(mint), meta(funder), meta(leagueClassicAta(mint, funder), true), meta(TOKEN_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId)]);
  });
  it('orders open with rent payer and a seeded vault, with no ATA program or extra accounts', () => {
    const ix = buildOpenWeekInstruction(identity, { funder, weekStart, root, totalRaw: 1n, leafCount: 1, allocationHash });
    expect(metas(ix)).toEqual([meta(funder, true, true), meta(config), meta(week, true), meta(vault, true), meta(leagueClassicAta(mint, funder), true), meta(mint), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId)]);
  });
  it('binds claim destination to its signer and supplies no mutable recipient override', () => {
    const ix = buildClaimLeagueRewardInstruction(identity, { claimant, weekStart, index: maxPlaces - 1, amount: 1n, proof: [] });
    expect(metas(ix)).toEqual([meta(claimant, false, true), meta(config), meta(week, true), meta(vault, true), meta(leagueClassicAta(mint, claimant), true), meta(mint), meta(TOKEN_PROGRAM_ID)]);
    refused(() => buildClaimLeagueRewardInstruction(identity, { claimant, weekStart, index: 0, amount: 1n, proof: [], destination: funder } as Parameters<typeof buildClaimLeagueRewardInstruction>[1]), 'INPUT');
  });
  it('requires sweep owner input and derives its canonical destination; the program pins owner', () => {
    const ix = buildSweepWeekInstruction(identity, { weekStart, sweepOwner: funder });
    expect(metas(ix)).toEqual([meta(config), meta(week, true), meta(vault, true), meta(leagueClassicAta(mint, funder), true), meta(mint), meta(TOKEN_PROGRAM_ID)]);
  });
  it('orders extension and all admin instructions; only config changes for admin operations', () => {
    expect(metas(buildExtendClaimDeadlineInstruction({ programId: LEAGUE_PROGRAM_ID }, { admin, weekStart, newDeadline: weekStart + window }))).toEqual([meta(admin, false, true), meta(config), meta(week, true)]);
    const expected = [meta(admin, false, true), meta(config, true)];
    expect(metas(buildSetLeaguePausedInstruction({ programId: LEAGUE_PROGRAM_ID }, { signer: admin, paused: true }))).toEqual(expected);
    expect(metas(buildProposeAdminInstruction({ programId: LEAGUE_PROGRAM_ID }, { signer: admin, newAdmin: guardian }))).toEqual(expected);
    expect(metas(buildAcceptAdminInstruction({ programId: LEAGUE_PROGRAM_ID }, { signer: admin }))).toEqual(expected);
    expect(metas(buildSetFunderInstruction({ programId: LEAGUE_PROGRAM_ID }, { signer: admin, newFunder: guardian }))).toEqual(expected);
  });
  it('case 40: unsigned legacy depth-9 claim plus ATA and TWO compute budget instructions fits 1232', () => {
    const proof = Array.from({ length: 9 }, () => ({ hash: root, sum: 1n, isLeft: false }));
    const tx = new Transaction({ feePayer: claimant, recentBlockhash: PublicKey.default.toBase58() }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      createAssociatedTokenAccountIdempotentInstruction(claimant, leagueClassicAta(mint, claimant), claimant, mint),
      buildClaimLeagueRewardInstruction(identity, { claimant, weekStart, index: 0, amount: 1n, proof }),
    );
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    expect(wire.length).toBeLessThanOrEqual(1232);
    expect(tx.signatures).toHaveLength(1);
    expect(tx.signatures[0]!.signature).toBeNull();
  });
});

describe('strict LeagueConfig decoder', () => {
  it('decodes None with nonzero retained tail and Some without losing integer precision', () => {
    expect(LEAGUE_CONFIG_ACCOUNT_BYTES).toBe(277);
    const none = decodeLeagueConfig(rawConfig(), configExpectation);
    expect(none.pendingAdmin).toBeNull(); expect(none.admin).toBe(admin.toBase58()); expect(none.claimWindowSec).toBe(window);
    expect(none.sweepAta).toBe(leagueClassicAta(mint, funder).toBase58()); expect(none.tokenProgram).toBe(TOKEN_PROGRAM_ID.toBase58());
    const some = decodeLeagueConfig(rawConfig(configBytes(guardian)), configExpectation);
    expect(some.pendingAdmin).toBe(guardian.toBase58());
  });
  it('accepts a harmless same-admin pending proposal allowed by the program', () => {
    expect(decodeLeagueConfig(rawConfig(configBytes(admin)), configExpectation).pendingAdmin).toBe(admin.toBase58());
  });
  it.each(['address', 'owner', 'executable'] as const)('refuses invalid %s (IDENTITY)', field => {
    refused(() => decodeLeagueConfig({ ...rawConfig(), [field]: field === 'executable' ? true : mint }, configExpectation), 'IDENTITY');
  });
  it('refuses wrong allocation, discriminator, version, option and boolean tags (ACCOUNT)', () => {
    refused(() => decodeLeagueConfig(rawConfig(configBytes().subarray(0, 276)), configExpectation), 'ACCOUNT');
    for (const [offset, value] of [[0, 99], [8, 2], [41, 2], [243, 2], [244, (leagueConfigPdaWithBump(LEAGUE_PROGRAM_ID)[1] + 1) % 256]]) {
      const bytes = configBytes(); bytes[offset!] = value!;
      refused(() => decodeLeagueConfig(rawConfig(bytes), configExpectation), 'ACCOUNT');
    }
  });
  it('refuses mismatched mint/decimals/funder/sweep/window deployment pins (IDENTITY)', () => {
    for (const change of [{ mint: guardian }, { decimals: 8 }, { funder: guardian }, { sweepOwner: guardian }, { claimWindowSec: window - 1n }]) {
      refused(() => decodeLeagueConfig(rawConfig(), { ...configExpectation, ...change }), 'IDENTITY');
    }
  });
  it('refuses classic token substitution, noncanonical sweep ATA and zero authority', () => {
    for (const offset of [138, 203]) { const bytes = configBytes(); mint.toBuffer().copy(bytes, offset); refused(() => decodeLeagueConfig(rawConfig(bytes), configExpectation), 'IDENTITY'); }
    const bytes = configBytes(); bytes.fill(0, 9, 41); refused(() => decodeLeagueConfig(rawConfig(bytes), configExpectation), 'ACCOUNT');
  });
});

describe('strict LeagueWeek decoder and bitmap', () => {
  it('matches the generated allocation and decodes sparse final index with one leaf', () => {
    expect(LEAGUE_BITMAP_BYTES).toBe(Math.ceil(maxPlaces / 8));
    expect(LEAGUE_WEEK_ACCOUNT_BYTES).toBe(192 + LEAGUE_BITMAP_BYTES);
    const decoded = decodeLeagueWeek(rawWeek(weekBytes({ claimedIndex: maxPlaces - 1 })), { programId: LEAGUE_PROGRAM_ID, weekStart });
    expect(decoded.claimedRaw).toBe(9007199254740995n); expect(decoded.claimedCount).toBe(1); expect(decoded.leafCount).toBe(1);
    expect(leagueClaimed(decoded, maxPlaces - 1)).toBe(true); expect(leagueClaimed(decoded, 0)).toBe(false);
    refused(() => leagueClaimed(decoded, maxPlaces), 'INPUT');
  });
  it('accepts a swept donation larger than funded total without counting it as claims', () => {
    const decoded = decodeLeagueWeek(rawWeek(weekBytes({ swept: true, sweptRaw: (1n << 64n) - 1n })), { programId: LEAGUE_PROGRAM_ID, weekStart });
    expect(decoded.sweptRaw).toBe((1n << 64n) - 1n); expect(decoded.claimedRaw).toBe(0n);
  });
  it('refuses a sweep below the funded unclaimed remainder (ACCOUNT)', () => {
    refused(() => decodeLeagueWeek(rawWeek(weekBytes({ swept: true, sweptRaw: 1n })), { programId: LEAGUE_PROGRAM_ID, weekStart }), 'ACCOUNT');
  });
  it('refuses owner/address/executable/expected-week substitutions (IDENTITY)', () => {
    for (const change of [{ owner: mint }, { address: mint }, { executable: true }]) refused(() => decodeLeagueWeek({ ...rawWeek(), ...change }, { programId: LEAGUE_PROGRAM_ID, weekStart }), 'IDENTITY');
    refused(() => decodeLeagueWeek(rawWeek(), { programId: LEAGUE_PROGRAM_ID, weekStart: weekStart + 604800n }), 'IDENTITY');
  });
  it('refuses noncanonical state encoding, config/vault identities and bumps', () => {
    const size = LEAGUE_WEEK_ACCOUNT_BYTES;
    for (const [offset, code] of [[0, 'ACCOUNT'], [8, 'ACCOUNT'], [9, 'IDENTITY'], [123, 'IDENTITY'], [size - 11, 'ACCOUNT'], [size - 2, 'ACCOUNT'], [size - 1, 'ACCOUNT']] as const) {
      const bytes = weekBytes(); bytes[offset]! ^= 2;
      refused(() => decodeLeagueWeek(rawWeek(bytes), { programId: LEAGUE_PROGRAM_ID, weekStart }), code);
    }
    refused(() => decodeLeagueWeek(rawWeek(Buffer.concat([weekBytes(), Buffer.from([0])])), { programId: LEAGUE_PROGRAM_ID, weekStart }), 'ACCOUNT');
  });
  it('refuses bitmap padding, count/popcount mismatch and impossible claimed totals (ACCOUNT)', () => {
    const padding = weekBytes(); padding[165 + LEAGUE_BITMAP_BYTES - 1]! |= 128;
    refused(() => decodeLeagueWeek(rawWeek(padding), { programId: LEAGUE_PROGRAM_ID, weekStart }), 'ACCOUNT');
    for (const options of [{ claimedCount: 1 }, { claimedIndex: 0, claimedCount: 0 }, { claimedIndex: 0, claimedRaw: 0n }, { claimedIndex: 0, totalRaw: 1n }, { leafCount: 0 }, { leafCount: maxPlaces + 1 }, { sweptRaw: 1n }]) {
      refused(() => decodeLeagueWeek(rawWeek(weekBytes(options)), { programId: LEAGUE_PROGRAM_ID, weekStart }), 'ACCOUNT');
    }
  });
  it('refuses claimed raw below the number of positive integer claims (ACCOUNT)', () => {
    const bytes = weekBytes({ claimedIndex: 0, claimedCount: 2, claimedRaw: 1n, leafCount: 2 });
    bytes[165]! |= 2;
    refused(() => decodeLeagueWeek(rawWeek(bytes), { programId: LEAGUE_PROGRAM_ID, weekStart }), 'ACCOUNT');
  });
  it('refuses unclosed opening, inverted deadline, ceiling violation and i64-overflow context (ACCOUNT)', () => {
    const openedAt = weekStart + 604800n + BigInt(LEAGUES.settlementDelayMs / 1000);
    for (const options of [{ openedAt: weekStart }, { openedAt, deadline: openedAt }, { openedAt, deadline: openedAt + windowMax + 1n }, { openedAt: (1n << 63n) - 2n, deadline: (1n << 63n) - 1n }]) {
      refused(() => decodeLeagueWeek(rawWeek(weekBytes(options)), { programId: LEAGUE_PROGRAM_ID, weekStart }), 'ACCOUNT');
    }
  });
});


describe('shared policy refusal matches generator boundaries', () => {
  it.each([0, -1000, 1])('refuses nonpositive or fractional-second settlement delay %s (POLICY)', async settlementDelayMs => {
    vi.resetModules();
    vi.doMock('@shardkeep/shared', () => ({
      LEAGUES: { ...LEAGUES, settlementDelayMs }, PHASE_E_LEAGUE_REWARDS,
    }));
    try {
      await expect(import('./leagueClaimProtocol')).rejects.toMatchObject({ code: 'POLICY' });
    } finally {
      vi.doUnmock('@shardkeep/shared');
      vi.resetModules();
    }
  });
});
