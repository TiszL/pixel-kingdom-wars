/** Pure league v1 ABI helpers. Supplied account bytes establish no RPC finality,
 * deployment trust or signing permission. This module has no wallet, RPC or
 * transaction submission path. The immutable identity comes from 7002e405. */
import { sha256 } from '@noble/hashes/sha256.js';
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { LEAGUES, PHASE_E_LEAGUE_REWARDS } from '@shardkeep/shared';
import { LEAGUE_PROGRAM_ID, LEAGUE_WEEK_SEC, MONDAY_OFFSET_SEC, MAX_PROOF_DEPTH, encodeProof, type ProofNode } from './leagueClaimProof';

export { LEAGUE_PROGRAM_ID, LEAGUE_WEEK_SEC };
// Local calendar fact authorized by 2c498a74, independent of game tuning.
export const LEAGUE_MONDAY_OFFSET_SEC = MONDAY_OFFSET_SEC;
export const LEAGUE_CONFIG_ACCOUNT_BYTES = 277;
const U64_MAX = (1n << 64n) - 1n, I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
const UPGRADEABLE_LOADER_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export type LeagueProtocolErrorCode = 'INPUT' | 'IDENTITY' | 'ACCOUNT' | 'WIRE' | 'POLICY';
export class LeagueProtocolError extends Error {
  constructor(readonly code: LeagueProtocolErrorCode) {
    super(`League protocol refused: ${code}`); this.name = 'LeagueProtocolError';
  }
}
function need(value: unknown, code: LeagueProtocolErrorCode): asserts value {
  if (!value) throw new LeagueProtocolError(code);
}
function exact(value: unknown, fields: string): asserts value is Record<string, unknown> {
  need(value !== null && typeof value === 'object' && !Array.isArray(value), 'INPUT');
  const names = fields ? fields.split(' ') : [], keys = Object.keys(value);
  need(keys.length === names.length && keys.every(name => names.includes(name)), 'INPUT');
}
function pubkey(value: PublicKey, code: LeagueProtocolErrorCode = 'INPUT'): PublicKey {
  try {
    need(value instanceof PublicKey, code);
    const bytes = value.toBytes(); need(bytes.length === 32, code);
    const normalized = new PublicKey(bytes); need(normalized.toBase58() === value.toBase58(), code); return normalized;
  } catch (error) { if (error instanceof LeagueProtocolError) throw error; throw new LeagueProtocolError(code); }
}
function nonzeroKey(value: PublicKey, code: LeagueProtocolErrorCode = 'INPUT'): PublicKey {
  const result = pubkey(value, code); need(!result.equals(PublicKey.default), code); return result;
}
function program(value: PublicKey): PublicKey {
  need(pubkey(value, 'IDENTITY').equals(LEAGUE_PROGRAM_ID), 'IDENTITY'); return new PublicKey(LEAGUE_PROGRAM_ID.toBytes());
}
function signed(value: bigint, code: LeagueProtocolErrorCode = 'INPUT'): bigint {
  need(typeof value === 'bigint' && value >= I64_MIN && value <= I64_MAX, code); return value;
}
function unsigned(value: bigint, code: LeagueProtocolErrorCode = 'INPUT'): bigint {
  need(typeof value === 'bigint' && value >= 0n && value <= U64_MAX, code); return value;
}
function positive(value: bigint, code: LeagueProtocolErrorCode = 'INPUT'): bigint {
  unsigned(value, code); need(value > 0n, code); return value;
}
function uint(value: number, max: number, code: LeagueProtocolErrorCode = 'INPUT'): number {
  need(Number.isSafeInteger(value) && value >= 0 && value <= max, code); return value;
}
function hash(value: Uint8Array, nonzero = false): Buffer {
  need(value instanceof Uint8Array && value.length === 32 && (!nonzero || value.some(byte => byte !== 0)), 'INPUT'); return Buffer.from(value);
}
function leI64(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigInt64LE(signed(value)); return bytes; }
function leU64(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(unsigned(value)); return bytes; }
function leU16(value: number): Buffer { const bytes = Buffer.alloc(2); bytes.writeUInt16LE(uint(value, 0xffff)); return bytes; }
function discriminator(namespace: 'global' | 'account', name: string): Buffer {
  return Buffer.from(sha256(Buffer.from(`${namespace}:${name}`, 'utf8')).subarray(0, 8));
}

// These are projections of shared source, with no fallback constants. Cedar3
// must compose the accepted M1 reward policy before compiling this subpath.
const policy = PHASE_E_LEAGUE_REWARDS.v1.skr;
need(Number.isSafeInteger(policy.maxPlaces) && policy.maxPlaces > 0 && policy.maxPlaces <= (1 << MAX_PROOF_DEPTH), 'POLICY');
need(Number.isSafeInteger(policy.claimWindowSec) && policy.claimWindowSec > 0
  && Number.isSafeInteger(policy.claimWindowMaxSec) && policy.claimWindowMaxSec >= policy.claimWindowSec, 'POLICY');
need(Number.isSafeInteger(LEAGUES.settlementDelayMs) && LEAGUES.settlementDelayMs > 0 && LEAGUES.settlementDelayMs % 1000 === 0, 'POLICY');
const MAX_PLACES = policy.maxPlaces;
const MAX_WINDOW = BigInt(policy.claimWindowMaxSec);
const SETTLEMENT_DELAY = BigInt(LEAGUES.settlementDelayMs / 1000);
export const LEAGUE_BITMAP_BYTES = Math.ceil(MAX_PLACES / 8);
export const LEAGUE_WEEK_ACCOUNT_BYTES = 192 + LEAGUE_BITMAP_BYTES;

/** Admission calendar only; signed wire conversion remains exact. */
export function isLeagueWeekStart(value: bigint): boolean {
  return typeof value === 'bigint' && value > 0n && value <= I64_MAX
    && (value - LEAGUE_MONDAY_OFFSET_SEC) % LEAGUE_WEEK_SEC === 0n;
}
function weekStart(value: bigint): bigint { signed(value); need(isLeagueWeekStart(value), 'INPUT'); return value; }
export function leagueConfigPdaWithBump(programId: PublicKey): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('league_config')], program(programId));
}
export function leagueConfigPda(programId: PublicKey): PublicKey { return leagueConfigPdaWithBump(programId)[0]; }
export function leagueWeekPdaWithBump(programId: PublicKey, start: bigint): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('league_week'), leagueConfigPda(programId).toBuffer(), leI64(weekStart(start))], program(programId));
}
export function leagueWeekPda(programId: PublicKey, start: bigint): PublicKey { return leagueWeekPdaWithBump(programId, start)[0]; }
export function leagueVaultPdaWithBump(programId: PublicKey, start: bigint): readonly [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from('league_vault'), leagueWeekPda(programId, start).toBuffer()], program(programId));
}
export function leagueVaultPda(programId: PublicKey, start: bigint): PublicKey { return leagueVaultPdaWithBump(programId, start)[0]; }
export function leagueProgramDataPda(): PublicKey {
  return PublicKey.findProgramAddressSync([LEAGUE_PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER_ID)[0];
}
export function leagueClassicAta(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(nonzeroKey(mint), nonzeroKey(owner), true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export interface InitializeLeagueInput { readonly guardian: PublicKey; readonly funder: PublicKey; readonly claimWindowSec: bigint }
export interface OpenWeekInput { readonly weekStart: bigint; readonly root: Uint8Array; readonly totalRaw: bigint; readonly leafCount: number; readonly allocationHash: Uint8Array }
export interface ClaimLeagueRewardInput { readonly weekStart: bigint; readonly index: number; readonly amount: bigint; readonly proof: readonly ProofNode[] }
export interface WeekInput { readonly weekStart: bigint }
export interface ExtendClaimDeadlineInput extends WeekInput { readonly newDeadline: bigint }
export function encodeInitializeLeagueData(input: InitializeLeagueInput): Buffer {
  exact(input, 'guardian funder claimWindowSec');
  signed(input.claimWindowSec); need(input.claimWindowSec > 0n && input.claimWindowSec <= MAX_WINDOW, 'INPUT');
  // StrictClaimWindow is the final one-field Rust struct. It occupies exactly
  // the same i64 bytes while its deserializer rejects legacy/trailing fields.
  return Buffer.concat([discriminator('global', 'initialize_league'), nonzeroKey(input.guardian).toBuffer(), nonzeroKey(input.funder).toBuffer(), leI64(input.claimWindowSec)]);
}
export function decodeInitializeLeagueData(data: Uint8Array): Readonly<{ guardian: string; funder: string; claimWindowSec: bigint }> {
  need(data instanceof Uint8Array && data.length === 80, 'WIRE');
  const bytes = Buffer.from(data); need(bytes.subarray(0, 8).equals(discriminator('global', 'initialize_league')), 'WIRE');
  const guardian = new PublicKey(bytes.subarray(8, 40)), funder = new PublicKey(bytes.subarray(40, 72)), claimWindowSec = bytes.readBigInt64LE(72);
  // Decode both the exact ABI shape and admissible initializer values.
  try { encodeInitializeLeagueData({ guardian, funder, claimWindowSec }); } catch { throw new LeagueProtocolError('WIRE'); }
  return Object.freeze({ guardian: guardian.toBase58(), funder: funder.toBase58(), claimWindowSec });
}
export function encodeOpenWeekData(input: OpenWeekInput): Buffer {
  exact(input, 'weekStart root totalRaw leafCount allocationHash');
  uint(input.leafCount, MAX_PLACES); need(input.leafCount > 0, 'INPUT');
  return Buffer.concat([discriminator('global', 'open_week'), leI64(weekStart(input.weekStart)), hash(input.root, true), leU64(positive(input.totalRaw)), leU16(input.leafCount), hash(input.allocationHash)]);
}
export function encodeClaimLeagueRewardData(input: ClaimLeagueRewardInput): Buffer {
  exact(input, 'weekStart index amount proof'); uint(input.index, MAX_PLACES - 1);
  let proof: Uint8Array;
  try { proof = encodeProof(input.proof); } catch { throw new LeagueProtocolError('INPUT'); }
  return Buffer.concat([discriminator('global', 'claim_league_reward'), leI64(weekStart(input.weekStart)), leU16(input.index), leU64(positive(input.amount)), proof]);
}
export function encodeSweepWeekData(input: WeekInput): Buffer {
  exact(input, 'weekStart'); return Buffer.concat([discriminator('global', 'sweep_week'), leI64(weekStart(input.weekStart))]);
}
export function encodeExtendClaimDeadlineData(input: ExtendClaimDeadlineInput): Buffer {
  exact(input, 'weekStart newDeadline'); signed(input.newDeadline); need(input.newDeadline > 0n, 'INPUT');
  return Buffer.concat([discriminator('global', 'extend_claim_deadline'), leI64(weekStart(input.weekStart)), leI64(input.newDeadline)]);
}
export function encodeSetLeaguePausedData(input: { readonly paused: boolean }): Buffer {
  exact(input, 'paused'); need(typeof input.paused === 'boolean', 'INPUT');
  return Buffer.concat([discriminator('global', 'set_league_paused'), Buffer.from([input.paused ? 1 : 0])]);
}
export function encodeProposeAdminData(input: { readonly newAdmin: PublicKey }): Buffer {
  exact(input, 'newAdmin'); return Buffer.concat([discriminator('global', 'propose_admin'), nonzeroKey(input.newAdmin).toBuffer()]);
}
export function encodeAcceptAdminData(): Buffer { return discriminator('global', 'accept_admin'); }
export function encodeSetFunderData(input: { readonly newFunder: PublicKey }): Buffer {
  exact(input, 'newFunder'); return Buffer.concat([discriminator('global', 'set_funder'), nonzeroKey(input.newFunder).toBuffer()]);
}

export interface LeagueProgramIdentity { readonly programId: PublicKey; readonly mint: PublicKey }
interface ProgramIdentity { readonly programId: PublicKey }
function identity(value: LeagueProgramIdentity): LeagueProgramIdentity {
  exact(value, 'programId mint'); return { programId: program(value.programId), mint: nonzeroKey(value.mint) };
}
function meta(key: PublicKey, isWritable = false, isSigner = false): AccountMeta { return { pubkey: pubkey(key), isWritable, isSigner }; }
function instruction(programId: PublicKey, data: Buffer, keys: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: program(programId), data, keys });
}
export function buildInitializeLeagueInstruction(deployment: LeagueProgramIdentity, input: InitializeLeagueInput & { readonly admin: PublicKey; readonly sweepOwner: PublicKey }): TransactionInstruction {
  const { programId, mint } = identity(deployment); exact(input, 'admin guardian funder sweepOwner claimWindowSec');
  const { admin, guardian, funder, sweepOwner, claimWindowSec } = input;
  nonzeroKey(admin); nonzeroKey(sweepOwner);
  return instruction(programId, encodeInitializeLeagueData({ guardian, funder, claimWindowSec }), [
    meta(admin, true, true), meta(leagueConfigPda(programId), true), meta(programId), meta(leagueProgramDataPda()),
    meta(mint), meta(sweepOwner), meta(leagueClassicAta(mint, sweepOwner), true), meta(TOKEN_PROGRAM_ID), meta(ASSOCIATED_TOKEN_PROGRAM_ID), meta(SystemProgram.programId),
  ]);
}
export function buildOpenWeekInstruction(deployment: LeagueProgramIdentity, input: OpenWeekInput & { readonly funder: PublicKey }): TransactionInstruction {
  const { programId, mint } = identity(deployment); exact(input, 'funder weekStart root totalRaw leafCount allocationHash');
  const { funder, ...args } = input; nonzeroKey(funder);
  return instruction(programId, encodeOpenWeekData(args), [meta(funder, true, true), meta(leagueConfigPda(programId)), meta(leagueWeekPda(programId, args.weekStart), true),
    meta(leagueVaultPda(programId, args.weekStart), true), meta(leagueClassicAta(mint, funder), true), meta(mint), meta(TOKEN_PROGRAM_ID), meta(SystemProgram.programId)]);
}
export function buildClaimLeagueRewardInstruction(deployment: LeagueProgramIdentity, input: ClaimLeagueRewardInput & { readonly claimant: PublicKey }): TransactionInstruction {
  const { programId, mint } = identity(deployment); exact(input, 'claimant weekStart index amount proof');
  const { claimant, ...args } = input; nonzeroKey(claimant);
  need(PublicKey.isOnCurve(claimant.toBytes()), 'INPUT');
  return instruction(programId, encodeClaimLeagueRewardData(args), [meta(claimant, false, true), meta(leagueConfigPda(programId)), meta(leagueWeekPda(programId, args.weekStart), true),
    meta(leagueVaultPda(programId, args.weekStart), true), meta(leagueClassicAta(mint, claimant), true), meta(mint), meta(TOKEN_PROGRAM_ID)]);
}
export function buildSweepWeekInstruction(deployment: LeagueProgramIdentity, input: WeekInput & { readonly sweepOwner: PublicKey }): TransactionInstruction {
  const { programId, mint } = identity(deployment); exact(input, 'weekStart sweepOwner');
  return instruction(programId, encodeSweepWeekData({ weekStart: input.weekStart }), [meta(leagueConfigPda(programId)), meta(leagueWeekPda(programId, input.weekStart), true),
    meta(leagueVaultPda(programId, input.weekStart), true), meta(leagueClassicAta(mint, input.sweepOwner), true), meta(mint), meta(TOKEN_PROGRAM_ID)]);
}
export function buildExtendClaimDeadlineInstruction(deployment: ProgramIdentity, input: ExtendClaimDeadlineInput & { readonly admin: PublicKey }): TransactionInstruction {
  exact(deployment, 'programId'); const p = program(deployment.programId); exact(input, 'admin weekStart newDeadline');
  return instruction(p, encodeExtendClaimDeadlineData({ weekStart: input.weekStart, newDeadline: input.newDeadline }), [meta(nonzeroKey(input.admin), false, true), meta(leagueConfigPda(p)), meta(leagueWeekPda(p, input.weekStart), true)]);
}
function adminInstruction(deployment: ProgramIdentity, signer: PublicKey, data: Buffer): TransactionInstruction {
  exact(deployment, 'programId'); const p = program(deployment.programId);
  return instruction(p, data, [meta(nonzeroKey(signer), false, true), meta(leagueConfigPda(p), true)]);
}
export function buildSetLeaguePausedInstruction(deployment: ProgramIdentity, input: { readonly signer: PublicKey; readonly paused: boolean }): TransactionInstruction {
  exact(input, 'signer paused'); return adminInstruction(deployment, input.signer, encodeSetLeaguePausedData({ paused: input.paused }));
}
export function buildProposeAdminInstruction(deployment: ProgramIdentity, input: { readonly signer: PublicKey; readonly newAdmin: PublicKey }): TransactionInstruction {
  exact(input, 'signer newAdmin'); return adminInstruction(deployment, input.signer, encodeProposeAdminData({ newAdmin: input.newAdmin }));
}
export function buildAcceptAdminInstruction(deployment: ProgramIdentity, input: { readonly signer: PublicKey }): TransactionInstruction {
  exact(input, 'signer'); return adminInstruction(deployment, input.signer, encodeAcceptAdminData());
}
export function buildSetFunderInstruction(deployment: ProgramIdentity, input: { readonly signer: PublicKey; readonly newFunder: PublicKey }): TransactionInstruction {
  exact(input, 'signer newFunder'); return adminInstruction(deployment, input.signer, encodeSetFunderData({ newFunder: input.newFunder }));
}

export interface LeagueRawAccount { readonly address: PublicKey; readonly owner: PublicKey; readonly executable: boolean; readonly data: Uint8Array }
export interface LeagueConfigExpectation extends LeagueProgramIdentity {
  readonly decimals: number; readonly funder: PublicKey; readonly sweepOwner: PublicKey; readonly claimWindowSec: bigint;
}
export interface LeagueConfigAccount {
  readonly address: string; readonly version: 1; readonly admin: string; readonly pendingAdmin: string | null;
  readonly guardian: string; readonly funder: string; readonly mint: string; readonly tokenProgram: string; readonly decimals: number;
  readonly sweepOwner: string; readonly sweepAta: string; readonly claimWindowSec: bigint; readonly paused: boolean; readonly bump: number;
}
export interface LeagueWeekAccount {
  readonly address: string; readonly version: 1; readonly config: string; readonly weekStart: bigint; readonly root: string;
  readonly totalRaw: bigint; readonly leafCount: number; readonly allocationHash: string; readonly vault: string;
  readonly claimedRaw: bigint; readonly claimedCount: number; readonly claimedBitmap: string; readonly openedAt: bigint;
  readonly claimDeadline: bigint; readonly swept: boolean; readonly sweptRaw: bigint; readonly bump: number; readonly vaultBump: number;
}
class Reader {
  private at = 8;
  constructor(private readonly data: Buffer) {}
  take(length: number): Buffer {
    need(this.at + length <= this.data.length, 'ACCOUNT'); const result = this.data.subarray(this.at, this.at + length); this.at += length; return result;
  }
  u8(): number { return this.take(1)[0]!; }
  u16(): number { return this.take(2).readUInt16LE(); }
  u64(): bigint { return this.take(8).readBigUInt64LE(); }
  i64(): bigint { return this.take(8).readBigInt64LE(); }
  key(): string { return new PublicKey(this.take(32)).toBase58(); }
  bool(): boolean { const value = this.u8(); need(value === 0 || value === 1, 'ACCOUNT'); return value === 1; }
  optionKey(): string | null { return this.bool() ? this.key() : null; }
  done(knownUnused = 0): void { need(this.at + knownUnused === this.data.length, 'ACCOUNT'); }
}
function account(raw: LeagueRawAccount, programId: PublicKey, expectedAddress: PublicKey, name: 'LeagueConfig' | 'LeagueWeek', size: number): Reader {
  const p = program(programId);
  need(raw && pubkey(raw.owner, 'IDENTITY').equals(p) && pubkey(raw.address, 'IDENTITY').equals(expectedAddress) && raw.executable === false, 'IDENTITY');
  need(raw.data instanceof Uint8Array && raw.data.length === size, 'ACCOUNT');
  const data = Buffer.from(raw.data); need(data.subarray(0, 8).equals(discriminator('account', name)), 'ACCOUNT'); return new Reader(data);
}
function nonzeroText(value: string): boolean { return value !== PublicKey.default.toBase58(); }
export function decodeLeagueConfig(raw: LeagueRawAccount, expected: LeagueConfigExpectation): Readonly<LeagueConfigAccount> {
  const [address, canonicalBump] = leagueConfigPdaWithBump(expected.programId);
  const reader = account(raw, expected.programId, address, 'LeagueConfig', LEAGUE_CONFIG_ACCOUNT_BYTES);
  const version = reader.u8(); need(version === 1, 'ACCOUNT');
  const admin = reader.key(), pendingAdmin = reader.optionKey(), guardian = reader.key(), funder = reader.key(), mint = reader.key(), tokenProgram = reader.key();
  const decimals = reader.u8(), sweepOwner = reader.key(), sweepAta = reader.key(), claimWindowSec = reader.i64(), paused = reader.bool(), bump = reader.u8();
  // The allocation reserves Option::Some capacity. After admin acceptance its
  // 32 unused tail bytes can be nonzero; they are not serialized Borsh state.
  reader.done(pendingAdmin === null ? 32 : 0);
  need(bump === canonicalBump && [admin, guardian, funder, mint, sweepOwner].every(nonzeroText)
    && (pendingAdmin === null || nonzeroText(pendingAdmin))
    && claimWindowSec > 0n && claimWindowSec <= MAX_WINDOW, 'ACCOUNT');
  need(tokenProgram === TOKEN_PROGRAM_ID.toBase58() && mint === pubkey(expected.mint, 'IDENTITY').toBase58()
    && funder === pubkey(expected.funder, 'IDENTITY').toBase58() && decimals === uint(expected.decimals, 255, 'IDENTITY')
    && sweepOwner === pubkey(expected.sweepOwner, 'IDENTITY').toBase58()
    && claimWindowSec === signed(expected.claimWindowSec, 'IDENTITY')
    && sweepAta === leagueClassicAta(new PublicKey(mint), new PublicKey(sweepOwner)).toBase58(), 'IDENTITY');
  return Object.freeze({ address: address.toBase58(), version, admin, pendingAdmin, guardian, funder, mint, tokenProgram, decimals,
    sweepOwner, sweepAta, claimWindowSec, paused, bump });
}
export function decodeLeagueWeek(raw: LeagueRawAccount, expected: { readonly programId: PublicKey; readonly weekStart: bigint }): Readonly<LeagueWeekAccount> {
  const [address, canonicalBump] = leagueWeekPdaWithBump(expected.programId, expected.weekStart);
  const [canonicalVault, canonicalVaultBump] = leagueVaultPdaWithBump(expected.programId, expected.weekStart);
  const reader = account(raw, expected.programId, address, 'LeagueWeek', LEAGUE_WEEK_ACCOUNT_BYTES);
  const version = reader.u8(); need(version === 1, 'ACCOUNT');
  const config = reader.key(), start = reader.i64(), root = reader.take(32), totalRaw = reader.u64(), leafCount = reader.u16(), allocationHash = reader.take(32);
  const vault = reader.key(), claimedRaw = reader.u64(), claimedCount = reader.u16(), bitmap = reader.take(LEAGUE_BITMAP_BYTES);
  const openedAt = reader.i64(), claimDeadline = reader.i64(), swept = reader.bool(), sweptRaw = reader.u64(), bump = reader.u8(), vaultBump = reader.u8(); reader.done();
  need(config === leagueConfigPda(expected.programId).toBase58() && start === expected.weekStart && vault === canonicalVault.toBase58(), 'IDENTITY');
  need(bump === canonicalBump && vaultBump === canonicalVaultBump && isLeagueWeekStart(start), 'ACCOUNT');
  const close = start + LEAGUE_WEEK_SEC + SETTLEMENT_DELAY, ceiling = openedAt + MAX_WINDOW;
  need(close <= I64_MAX && openedAt >= close && ceiling <= I64_MAX && claimDeadline > openedAt && claimDeadline <= ceiling, 'ACCOUNT');
  need(root.some(byte => byte !== 0) && totalRaw > 0n && leafCount > 0 && leafCount <= MAX_PLACES
    && claimedCount <= leafCount && claimedRaw <= totalRaw && claimedRaw >= BigInt(claimedCount) && (claimedCount === 0 ? claimedRaw === 0n : claimedRaw > 0n)
    && (swept ? sweptRaw >= totalRaw - claimedRaw : sweptRaw === 0n), 'ACCOUNT');
  let bits = 0;
  for (let index = 0; index < bitmap.length * 8; index++) {
    if ((bitmap[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0) { need(index < MAX_PLACES, 'ACCOUNT'); bits++; }
  }
  need(bits === claimedCount, 'ACCOUNT');
  return Object.freeze({ address: address.toBase58(), version, config, weekStart: start, root: root.toString('hex'), totalRaw, leafCount,
    allocationHash: allocationHash.toString('hex'), vault, claimedRaw, claimedCount, claimedBitmap: bitmap.toString('hex'), openedAt,
    claimDeadline, swept, sweptRaw, bump, vaultBump });
}
/** Reads an already validated bitmap. It does not infer finality or eligibility. */
export function leagueClaimed(week: Pick<LeagueWeekAccount, 'claimedBitmap'>, index: number): boolean {
  uint(index, MAX_PLACES - 1); need(week && typeof week.claimedBitmap === 'string' && /^[0-9a-f]+$/.test(week.claimedBitmap) && week.claimedBitmap.length === LEAGUE_BITMAP_BYTES * 2, 'INPUT');
  const bitmap = Buffer.from(week.claimedBitmap, 'hex'); return (bitmap[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0;
}
