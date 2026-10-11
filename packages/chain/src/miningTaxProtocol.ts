/** Pure tax v2 account/ABI helpers. Supplied original term/winner identities are
 * expectations, never finalized authority. The finalized service must derive
 * them from verified SeekerTerm/Auction evidence, never HTTP request fields.
 * No RPC, signing, funding, current-lease lookup, or caller payout amounts. */
import type { Idl } from '@coral-xyz/anchor';
import { anchorRuntime as anchorPkg } from './anchorRuntime';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { decodeMiningConfig, decodeMiningEpoch, miningEpochPda,
 type MiningProgramIdentity, type MiningRawAccount } from './miningProgramProtocol';
import { seekerAuctionPda } from './seekerAuctionProtocol';
import { encodeMiningTermTaxIdentity, hashMiningTermTaxIdentity, hashMiningTaxCommitment,
 miningTermTaxPoolPda, miningTaxEpochReceiptPda, miningTaxSpotCursorPda, type MiningTaxTermIdentity } from './miningTaxCommitment';
export { encodeMiningTermTaxIdentity, encodeMiningTaxCommitment, hashMiningTermTaxIdentity, hashMiningTaxCommitment,
 miningTermTaxPoolPda, miningTaxEpochReceiptPda, miningTaxSpotCursorPda, MiningTaxCommitmentError, type MiningTaxTermIdentity } from './miningTaxCommitment';
const { BN, BorshCoder } = anchorPkg, coder = new BorshCoder(idl as Idl);
// Keep the cross-copy runtime check without relying on bn.js declarations.
// The predicate names `words` (an array BN.isBN itself requires) so the false
// branch stays unknown: a toString-only shape also matches {} and narrowed it to null|undefined.
function isAnchorBN(value: unknown): value is { readonly words: readonly unknown[]; toString(): string } { return BN.isBN(value); }
const I64_MAX = (1n << 63n) - 1n;
type ErrorCode = 'INPUT' | 'ACCOUNT' | 'IDENTITY' | 'COUNTER';
export class MiningTaxProtocolError extends Error {
 constructor(readonly code: ErrorCode) { super(`Mining tax protocol refused: ${code}`); this.name = 'MiningTaxProtocolError'; }
}
function need(value: unknown, code: ErrorCode): asserts value { if (!value) throw new MiningTaxProtocolError(code); }
function checked<T>(read: () => T): T {
 try { return read(); } catch (error) { if (error instanceof MiningTaxProtocolError) throw error; throw new MiningTaxProtocolError('ACCOUNT'); }
}
function exact(value: object, names: string): void {
 need(value && typeof value === 'object' && !Array.isArray(value), 'INPUT');
 const fields = names.split(' '), actual = Reflect.ownKeys(value);
 need(actual.length === fields.length && actual.every(k => typeof k === 'string' && fields.includes(k)), 'INPUT');
}
function key(value: PublicKey): PublicKey {
 try {
  need(value && typeof value.toBytes === 'function' && typeof value.toBase58 === 'function', 'INPUT');
  const bytes = value.toBytes(); need(bytes instanceof Uint8Array && bytes.length === 32, 'INPUT');
  const canonical = new PublicKey(bytes);
  need(canonical.toBase58() === value.toBase58() && !canonical.equals(PublicKey.default), 'INPUT'); return canonical;
 } catch { throw new MiningTaxProtocolError('INPUT'); }
}
function termIdentity(value: MiningTaxTermIdentity): MiningTaxTermIdentity {
 exact(value, 'programId config keepMint auctionConfig term registry registryHash round auctionStart auctionEnd operatingStart operatingEnd winnerCount');
 try { encodeMiningTermTaxIdentity(value); } catch { throw new MiningTaxProtocolError('INPUT'); } return value;
}
export interface MiningTaxContext {
 readonly identity: MiningProgramIdentity;
 readonly term: MiningTaxTermIdentity;
 readonly config: MiningRawAccount;
}
export interface MiningTaxAccrualContext extends MiningTaxContext {
 readonly pool: MiningRawAccount; readonly epoch: MiningRawAccount; readonly day: bigint;
}
export interface MiningTaxSpotContext extends MiningTaxContext {
 readonly pool: MiningRawAccount; readonly spot: number; readonly winner: PublicKey;
}
interface TaxAccount {
 readonly address: string; readonly version: number; readonly bump: number;
 readonly finalityVerified: false; readonly paymentAuthorized: false;
}
export interface MiningTaxPoolAccount extends TaxAccount {
 readonly distributionVersion: number; readonly config: string; readonly term: string; readonly termIdentity: string;
 readonly winnerCount: number; readonly accrued: bigint; readonly paid: bigint;
}
export interface MiningTaxAccrualAccount extends TaxAccount {
 readonly config: string; readonly pool: string; readonly epoch: string; readonly amount: bigint; readonly accruedAt: bigint;
}
export interface MiningTaxSpotAccount extends TaxAccount {
 readonly pool: string; readonly auction: string; readonly wallet: string; readonly spot: number; readonly claimedTotal: bigint;
}
const names = ['MiningTaxPool', 'MiningTaxAccrual', 'MiningTaxSpot'] as const;
type AccountName = typeof names[number];
export const MINING_TAX_ACCOUNT_BYTES: Readonly<Record<AccountName, number>> = Object.freeze(
 Object.fromEntries(names.map(name => [name, coder.accounts.size(name)])) as Record<AccountName, number>);
function rawShape(raw: MiningRawAccount) { exact(raw, 'address owner executable data'); }
function decode<T extends TaxAccount>(raw: MiningRawAccount, name: AccountName, program: PublicKey, address: PublicKey, seeds: Buffer[]): Readonly<T> {
 rawShape(raw);
 need(key(raw.owner).equals(program) && key(raw.address).equals(address) && raw.executable === false, 'IDENTITY');
 need(raw.data instanceof Uint8Array && raw.data.length === MINING_TAX_ACCOUNT_BYTES[name], 'ACCOUNT');
 const bytes = Buffer.from(raw.data), decoded = coder.accounts.decode(name, bytes) as Record<string, unknown>;
 // Exact re-encoding rejects ignored/trailing bytes and noncanonical field tags.
 need(coder.types.encode(name, decoded).equals(bytes.subarray(8)), 'ACCOUNT');
 const result: Record<string, unknown> = { address: address.toBase58(), finalityVerified: false, paymentAuthorized: false };
 for (const [field, value] of Object.entries(decoded)) {
  const name = field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  result[name] = isAnchorBN(value) ? BigInt(value.toString()) : value instanceof PublicKey ? value.toBase58()
   : Array.isArray(value) ? Buffer.from(value).toString('hex') : value;
 }
 const [derived, bump] = PublicKey.findProgramAddressSync(seeds, program);
 need(derived.equals(address) && result.version === 2 && result.bump === bump, 'ACCOUNT');
 return Object.freeze(result) as unknown as Readonly<T>;
}
function context(value: MiningTaxContext) {
 const t = termIdentity(value.term); exact(value.identity, 'programId keepMint reserveOwner'); rawShape(value.config);
 need(key(value.identity.programId).equals(t.programId) && key(value.identity.keepMint).equals(t.keepMint), 'IDENTITY');
 const config = decodeMiningConfig(value.config, value.identity);
 need(config.address === t.config.toBase58(), 'IDENTITY'); return { t, config };
}
function poolAccount(raw: MiningRawAccount, value: MiningTaxContext): Readonly<MiningTaxPoolAccount> {
 const { t, config } = context(value), address = miningTermTaxPoolPda(t.programId, t.term);
 const pool = decode<MiningTaxPoolAccount>(raw, 'MiningTaxPool', t.programId, address,
  [Buffer.from('mining_tax_pool'), t.config.toBuffer(), t.term.toBuffer()]);
 need(pool.distributionVersion === 1 && pool.config === config.address && pool.term === t.term.toBase58()
  && pool.winnerCount === t.winnerCount && pool.termIdentity === Buffer.from(hashMiningTermTaxIdentity(t)).toString('hex'), 'IDENTITY');
 need(pool.paid <= pool.accrued && pool.accrued <= config.taxHighwater && pool.paid <= config.taxPaid, 'COUNTER');
 return pool;
}
export function decodeMiningTaxPool(raw: MiningRawAccount, expected: MiningTaxContext): Readonly<MiningTaxPoolAccount> {
 return checked(() => { exact(expected, 'identity term config'); return poolAccount(raw, expected); });
}
export function decodeMiningTaxAccrual(raw: MiningRawAccount, expected: MiningTaxAccrualContext): Readonly<MiningTaxAccrualAccount> {
 return checked(() => {
  exact(expected, 'identity term config pool epoch day');
  const { t, config } = context(expected), pool = poolAccount(expected.pool, expected), day = expected.day;
  const epochAddress = miningEpochPda(t.programId, day), commitment = hashMiningTaxCommitment(t, { day, epoch: epochAddress });
  rawShape(expected.epoch); const epoch = decodeMiningEpoch(expected.epoch, { programId: t.programId, day });
  need(epoch.taxVersion === 2 && epoch.day >= config.genesisDay && epoch.day <= config.latestDay
   && epoch.sourceHash !== '00'.repeat(32) && epoch.taxCommitment === Buffer.from(commitment).toString('hex'), 'IDENTITY');
  const dayEnd = (day + 1n) * BigInt(POLICY.daySec), earliest = epoch.fundedAt + BigInt(POLICY.claimDelaySec);
  need(epoch.fundedAt >= dayEnd && earliest <= I64_MAX, 'ACCOUNT');
  const accrual = decode<MiningTaxAccrualAccount>(raw, 'MiningTaxAccrual', t.programId, miningTaxEpochReceiptPda(t.programId, epochAddress),
   [Buffer.from('mining_tax_epoch'), t.config.toBuffer(), epochAddress.toBuffer()]);
  need(accrual.config === config.address && accrual.pool === pool.address && accrual.epoch === epoch.address, 'IDENTITY');
  need(accrual.amount === epoch.tax && accrual.amount <= pool.accrued, 'COUNTER');
  // This binds recorded timestamps only; no wall clock/finality/admission claim.
  need(accrual.accruedAt >= earliest, 'ACCOUNT'); return accrual;
 });
}
export function decodeMiningTaxSpot(raw: MiningRawAccount, expected: MiningTaxSpotContext): Readonly<MiningTaxSpotAccount> {
 return checked(() => {
  exact(expected, 'identity term config pool spot winner');
  const t = termIdentity(expected.term), pool = poolAccount(expected.pool, expected), poolKey = new PublicKey(pool.address), winner = key(expected.winner);
  const address = miningTaxSpotCursorPda(t.programId, poolKey, expected.spot);
  const cursor = decode<MiningTaxSpotAccount>(raw, 'MiningTaxSpot', t.programId, address,
   [Buffer.from('mining_tax_spot'), poolKey.toBuffer(), Buffer.of(expected.spot)]);
  need(cursor.pool === pool.address && cursor.spot === expected.spot && cursor.wallet === winner.toBase58()
   && cursor.auction === seekerAuctionPda(t.programId, t.auctionConfig, expected.spot, t.round).toBase58(), 'IDENTITY');
  need(cursor.claimedTotal <= pool.accrued / BigInt(pool.winnerCount) && cursor.claimedTotal <= pool.paid, 'COUNTER');
  return cursor;
 });
}
function accounts(term: MiningTaxTermIdentity): Record<string, PublicKey> {
 const t = termIdentity(term);
 return { config: t.config, auction_config: t.auctionConfig, registry: t.registry, term: t.term,
  pool: miningTermTaxPoolPda(t.programId, t.term), system_program: SystemProgram.programId };
}
function instruction(term: MiningTaxTermIdentity, name: string, keys: Record<string, PublicKey>): TransactionInstruction {
 const definition = idl.instructions.find(i => i.name === name); need(definition && definition.args.length === 0, 'INPUT');
 const metas = definition.accounts.map(account => {
  const value = keys[account.name]; need(value, 'INPUT');
  // SystemProgram's all-zero address is valid only for the fixed IDL account.
  const pubkey = account.name === 'system_program' ? SystemProgram.programId : key(value);
  if ('address' in account) need(pubkey.toBase58() === account.address, 'IDENTITY');
  return { pubkey, isSigner: 'signer' in account && account.signer === true, isWritable: 'writable' in account && account.writable === true };
 });
 return new TransactionInstruction({ programId: key(term.programId), keys: metas, data: coder.instruction.encode(name, {}) });
}
export function buildOpenMiningTaxPoolInstruction(term: MiningTaxTermIdentity, input: { readonly payer: PublicKey }): TransactionInstruction {
 return checked(() => { exact(input, 'payer'); return instruction(term, 'open_mining_tax_pool', { ...accounts(term), payer: input.payer }); });
}
export function buildOpenMiningTaxSpotInstruction(term: MiningTaxTermIdentity, input: { readonly payer: PublicKey; readonly spot: number }): TransactionInstruction {
 return checked(() => {
  exact(input, 'payer spot'); const a = accounts(term);
  return instruction(term, 'open_mining_tax_spot', { ...a, payer: input.payer,
   auction: seekerAuctionPda(term.programId, term.auctionConfig, input.spot, term.round), spot_claim: miningTaxSpotCursorPda(term.programId, a.pool!, input.spot) });
 });
}
export function buildAccrueMiningTaxInstruction(term: MiningTaxTermIdentity, input: { readonly payer: PublicKey; readonly day: bigint }): TransactionInstruction {
 return checked(() => {
  exact(input, 'payer day'); const a = accounts(term), epoch = miningEpochPda(term.programId, input.day);
  hashMiningTaxCommitment(term, { day: input.day, epoch });
  return instruction(term, 'accrue_mining_tax', { ...a, payer: input.payer, epoch, accrual: miningTaxEpochReceiptPda(term.programId, epoch) });
 });
}
export function buildClaimMiningTaxInstruction(term: MiningTaxTermIdentity, input: { readonly claimant: PublicKey; readonly spot: number }): TransactionInstruction {
 return checked(() => {
  exact(input, 'claimant spot'); const a = accounts(term), claimant = key(input.claimant);
  const vault = getAssociatedTokenAddressSync(term.keepMint, term.config, true), destination = getAssociatedTokenAddressSync(term.keepMint, claimant, true);
  need(!vault.equals(destination), 'IDENTITY');
  return instruction(term, 'claim_mining_tax', { ...a, claimant,
   auction: seekerAuctionPda(term.programId, term.auctionConfig, input.spot, term.round), spot_claim: miningTaxSpotCursorPda(term.programId, a.pool!, input.spot),
   vault, destination, keep_mint: term.keepMint, token_program: TOKEN_PROGRAM_ID });
 });
}
