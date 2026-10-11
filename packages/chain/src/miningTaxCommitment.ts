/** Fixed tax v2 commitment bytes. Encoding is not finalized beneficiary authority.
 * Version 1 zero-winner holds can never be interpreted as these payable terms. */
import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { PHASE_E_POLICY, PHASE_E_MINING_PUBLICATION } from '@shardkeep/shared';
import { MINING_PROGRAM_ADDRESS, miningConfigPda, miningEpochPda } from './miningProgramProtocol';
const V = 2, DISTRIBUTION = 1, U64_MAX = (1n << 64n) - 1n, I64_MAX = (1n << 63n) - 1n;
export class MiningTaxCommitmentError extends Error {
 constructor() { super('Invalid original-term mining tax commitment'); this.name = 'MiningTaxCommitmentError'; }
}
function need(value: unknown): asserts value { if (!value) throw new MiningTaxCommitmentError(); }
function key(value: PublicKey): Buffer {
 try {
  need(value && typeof value.toBytes === 'function' && typeof value.toBase58 === 'function');
  const bytes = value.toBytes(); need(bytes instanceof Uint8Array && bytes.length === 32);
  const canonical = new PublicKey(bytes); need(canonical.toBase58() === value.toBase58() && !canonical.equals(PublicKey.default));
  return Buffer.from(bytes);
 } catch { throw new MiningTaxCommitmentError(); }
}
function program(value: PublicKey): PublicKey { need(new PublicKey(key(value)).toBase58() === MINING_PROGRAM_ADDRESS); return new PublicKey(MINING_PROGRAM_ADDRESS); }
function integer(value: bigint, signed = false): Buffer {
 need(typeof value === 'bigint' && value >= 0n && value <= (signed ? I64_MAX : U64_MAX));
 const b = Buffer.alloc(8); if (signed) b.writeBigInt64LE(value); else b.writeBigUInt64LE(value); return b;
}
function pda(p: PublicKey, seed: string, ...parts: Buffer[]): PublicKey {
 return PublicKey.findProgramAddressSync([Buffer.from(seed), ...parts], program(p))[0];
}
export const miningTermTaxPoolPda = (p: PublicKey, term: PublicKey): PublicKey =>
 pda(p, 'mining_tax_pool', key(miningConfigPda(p)), key(term));
export const miningTaxEpochReceiptPda = (p: PublicKey, epoch: PublicKey): PublicKey =>
 pda(p, 'mining_tax_epoch', key(miningConfigPda(p)), key(epoch));
export function miningTaxSpotCursorPda(p: PublicKey, pool: PublicKey, spot: number): PublicKey {
 need(Number.isInteger(spot) && spot >= 0 && spot < PHASE_E_POLICY.seekerIsland.totalSpots);
 return pda(p, 'mining_tax_spot', key(pool), Buffer.of(spot));
}
export interface MiningTaxTermIdentity {
 readonly programId: PublicKey; readonly config: PublicKey; readonly keepMint: PublicKey;
 readonly auctionConfig: PublicKey; readonly term: PublicKey; readonly registry: PublicKey;
 readonly registryHash: Uint8Array; readonly round: bigint; readonly auctionStart: bigint;
 readonly auctionEnd: bigint; readonly operatingStart: bigint; readonly operatingEnd: bigint;
 readonly winnerCount: number;
}
function parts(i: MiningTaxTermIdentity): { prefix: Buffer[]; suffix: Buffer[] } {
 need(i && typeof i === 'object');
 const p = program(i.programId), config = miningConfigPda(p), auctionConfig = pda(p, 'auction_config'), registry = pda(p, 'seeker_registry');
 need(new PublicKey(key(i.config)).equals(config) && new PublicKey(key(i.auctionConfig)).equals(auctionConfig)
  && new PublicKey(key(i.registry)).equals(registry));
 const round = integer(i.round), term = pda(p, 'seeker_term', key(auctionConfig), round);
 need(new PublicKey(key(i.term)).equals(term));
 need(i.registryHash instanceof Uint8Array && i.registryHash.length === 32 && i.registryHash.some(n => n !== 0));
 need(Number.isInteger(i.winnerCount) && i.winnerCount > 0 && i.winnerCount <= PHASE_E_POLICY.seekerIsland.totalSpots);
 const clocks = [i.auctionStart, i.auctionEnd, i.operatingStart, i.operatingEnd].map(n => integer(n, true));
 need(i.auctionEnd === i.operatingStart
  && i.auctionEnd - i.auctionStart === BigInt(PHASE_E_POLICY.seekerIsland.overlappingAuctionSec)
  && i.operatingEnd - i.operatingStart === BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec));
 return { prefix: [key(p), key(config), key(i.keepMint)], suffix: [key(auctionConfig), key(term), key(registry),
  Buffer.from(i.registryHash), round, ...clocks, Buffer.of(i.winnerCount, DISTRIBUTION)] };
}
function domain(name: string): Buffer { const version = Buffer.alloc(2); version.writeUInt16LE(V); return Buffer.concat([Buffer.from(name, 'ascii'), version]); }
export function encodeMiningTermTaxIdentity(identity: MiningTaxTermIdentity): Uint8Array {
 const { prefix, suffix } = parts(identity); return Buffer.concat([domain('SKMTPI02'), ...prefix, ...suffix]);
}
export function encodeMiningTaxCommitment(identity: MiningTaxTermIdentity, input: { readonly day: bigint; readonly epoch: PublicKey }): Uint8Array {
 const { prefix, suffix } = parts(identity); need(input && typeof input === 'object');
 const day = integer(input.day); need(input.day > 0n);
 const sec = BigInt(PHASE_E_MINING_PUBLICATION.daySec), start = input.day * sec, end = start + sec;
 need(start <= I64_MAX && end <= I64_MAX && start >= identity.operatingStart && end <= identity.operatingEnd);
 need(new PublicKey(key(input.epoch)).equals(miningEpochPda(identity.programId, input.day)));
 return Buffer.concat([domain('SKMTAX02'), ...prefix, key(input.epoch), day, ...suffix]);
}
export const hashMiningTermTaxIdentity = (identity: MiningTaxTermIdentity): Uint8Array => keccak_256(encodeMiningTermTaxIdentity(identity));
export const hashMiningTaxCommitment = (identity: MiningTaxTermIdentity, input: { readonly day: bigint; readonly epoch: PublicKey }): Uint8Array =>
 keccak_256(encodeMiningTaxCommitment(identity, input));
