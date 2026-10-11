/** Seeker auction v1 bytes/PDA derivation only. No signer, RPC, deployment or authority claim. */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';

export const SEEKER_ACTION_PERMIT_BYTES = 161;
export const SEEKER_AUCTION_TERMS_BYTES = 395;
export const SEEKER_OPEN_PAYLOAD_BYTES = 427;
export const SEEKER_SETTLE_PAYLOAD_BYTES = 177;
const P = PHASE_E_POLICY.seekerIsland;
const VERSION = 1;
const ISLAND = 1;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function keys(value: object, names: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== names.split(' ').sort().join(',')) {
    throw new TypeError('Unexpected Seeker protocol fields');
  }
}
function bytes(value: Uint8Array, length: number): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new TypeError(`Expected ${length} bytes`);
  return Buffer.from(value);
}
function key(value: PublicKey): Buffer {
  // pnpm consumers can hold a PublicKey from a different installed web3 copy.
  // Class identity is not key validity; validate the exact bytes and canonical text.
  if (!value || typeof value !== 'object' || typeof value.toBytes !== 'function'
    || typeof value.toBase58 !== 'function') throw new TypeError('Expected a PublicKey');
  const out = bytes(value.toBytes(), 32);
  if (new PublicKey(out).toBase58() !== value.toBase58()) throw new TypeError('Inconsistent PublicKey');
  return out;
}
function uint(value: number, width: 1 | 2): Buffer {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** (8 * width)) throw new RangeError('Unsigned integer out of range');
  const out = Buffer.alloc(width);
  if (width === 1) out.writeUInt8(value); else out.writeUInt16LE(value);
  return out;
}
function integer(value: bigint, signed = false): Buffer {
  if (typeof value !== 'bigint' || value < (signed ? I64_MIN : 0n) || value > (signed ? I64_MAX : U64_MAX)) {
    throw new RangeError(signed ? 'Expected signed int64 bigint' : 'Expected unsigned int64 bigint');
  }
  const out = Buffer.alloc(8);
  if (signed) out.writeBigInt64LE(value); else out.writeBigUInt64LE(value);
  return out;
}
function kind(value: number): 7 | 8 {
  if (value !== 7 && value !== 8) throw new RangeError('Only auction-open/settle action permits are supported');
  return value;
}
function version(value: number): Buffer {
  if (value !== VERSION) throw new RangeError('Unsupported Seeker protocol version');
  return uint(value, 2);
}
function digest(value: Uint8Array): Buffer { return Buffer.from(keccak_256(value)); }
function join(tag: string, fields: readonly Uint8Array[]): Buffer { return Buffer.concat([Buffer.from(tag, 'ascii'), ...fields]); }
function pda(program: PublicKey, fields: readonly Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(fields.map(field => Buffer.from(field)), new PublicKey(key(program)))[0];
}

export interface SeekerActionPermit {
  readonly genesisHash: PublicKey;
  readonly programId: PublicKey;
  readonly kind: 7 | 8;
  readonly permitId: Uint8Array;
  readonly wallet: PublicKey;
  readonly expiry: bigint;
  readonly payloadHash: Uint8Array;
}
export function encodeSeekerActionPermit(value: SeekerActionPermit): Buffer {
  keys(value, 'genesisHash programId kind permitId wallet expiry payloadHash');
  return join('SKPERMT2', [key(value.genesisHash), key(value.programId), uint(kind(value.kind), 1),
    bytes(value.permitId, 16), key(value.wallet), integer(value.expiry, true), bytes(value.payloadHash, 32)]);
}
/** Decoding proves shape only; key authority, expiry, original payload and signature remain unverified. */
export function decodeSeekerActionPermit(input: Uint8Array): SeekerActionPermit {
  const data = bytes(input, SEEKER_ACTION_PERMIT_BYTES);
  if (!data.subarray(0, 8).equals(Buffer.from('SKPERMT2'))) throw new Error('Wrong Seeker permit domain');
  return { genesisHash: new PublicKey(data.subarray(8, 40)), programId: new PublicKey(data.subarray(40, 72)),
    kind: kind(data[72]!), permitId: Buffer.from(data.subarray(73, 89)), wallet: new PublicKey(data.subarray(89, 121)),
    expiry: data.readBigInt64LE(121), payloadHash: Buffer.from(data.subarray(129, 161)) };
}

// Every caller provides program identity explicitly; no local-test/deployed-program default.
export const seekerAuthorityPda = (program: PublicKey): PublicKey => pda(program, [Buffer.from('seeker_authority')]);
export const seekerRegistryPda = (program: PublicKey): PublicKey => pda(program, [Buffer.from('seeker_registry')]);
export const seekerAuctionConfigPda = (program: PublicKey): PublicKey => pda(program, [Buffer.from('auction_config')]);
export const seekerTermPda = (program: PublicKey, config: PublicKey, round: bigint): PublicKey =>
  pda(program, [Buffer.from('seeker_term'), key(config), integer(round)]);
export const seekerAuctionPda = (program: PublicKey, config: PublicKey, spotId: number, round: bigint): PublicKey => {
  requireSpotId(spotId);
  return pda(program, [Buffer.from('auction'), key(config), uint(spotId, 1), integer(round)]);
};
export const seekerBidPda = (program: PublicKey, auction: PublicKey, wallet: PublicKey): PublicKey =>
  pda(program, [Buffer.from('bid'), key(auction), key(wallet)]);
export const seekerPermitReceiptPda = (program: PublicKey, permitId: Uint8Array): PublicKey =>
  pda(program, [Buffer.from('permit'), bytes(permitId, 16)]);

export interface SeekerRegistryEntry { readonly spotId: number; readonly class: 0 | 1; readonly realmMask: number }
function requireSpotId(spotId: number): void {
  if (!Number.isInteger(spotId) || spotId < 0 || spotId >= P.totalSpots) throw new RangeError('Unknown Seeker spot');
}
export function canonicalSeekerRegistry(): SeekerRegistryEntry[] {
  return Array.from({ length: P.totalSpots }, (_, spotId) => {
    if (spotId < P.kingSpots) return { spotId, class: 1, realmMask: (1 << P.realmCount) - 1 };
    let realmMask = 0;
    for (let i = 0; i < PHASE_E_SEEKER_AUCTION.regularRealmCount; i++) {
      realmMask |= 1 << ((spotId - P.kingSpots + i) % P.realmCount);
    }
    return { spotId, class: 0, realmMask };
  });
}
export function encodeSeekerRegistry(entries: readonly SeekerRegistryEntry[]): Buffer {
  if (!Array.isArray(entries) || entries.length !== P.totalSpots) throw new Error('A complete Seeker registry is required');
  const expected = canonicalSeekerRegistry();
  for (const row of entries) { keys(row, 'spotId class realmMask'); requireSpotId(row.spotId); }
  const ordered = [...entries].sort((a, b) => a.spotId - b.spotId);
  const fields = ordered.map((row, index) => {
    const want = expected[index]!;
    if (row.spotId !== want.spotId || row.class !== want.class || row.realmMask !== want.realmMask) {
      throw new Error('Registry differs from frozen Seeker v1 mapping');
    }
    return Buffer.from([row.spotId, row.class, row.realmMask]);
  });
  return join('SKAREG01', [uint(VERSION, 2), uint(ISLAND, 1), ...fields]);
}
export const hashSeekerRegistry = (entries: readonly SeekerRegistryEntry[]): Buffer => digest(encodeSeekerRegistry(entries));

export interface SeekerAuctionTerms {
  readonly config: PublicKey; readonly term: PublicKey; readonly auction: PublicKey; readonly registry: PublicKey;
  readonly registryHash: Uint8Array; readonly spotId: number; readonly class: 0 | 1; readonly realmMask: number;
  readonly round: bigint; readonly auctionStart: bigint; readonly auctionEnd: bigint;
  readonly operatingStart: bigint; readonly operatingEnd: bigint;
  readonly mint: PublicKey; readonly tokenProgram: PublicKey; readonly vault: PublicKey;
  readonly prizeOwner: PublicKey; readonly prizeAta: PublicKey; readonly prizeBps: number;
  readonly grace: bigint; readonly openingBid: bigint;
  readonly registryVersion: number; readonly auctionFormat: number; readonly termsFormat: number;
}
function immutableTerms(value: SeekerAuctionTerms): Buffer {
  keys(value, 'config term auction registry registryHash spotId class realmMask round auctionStart auctionEnd operatingStart operatingEnd mint tokenProgram vault prizeOwner prizeAta prizeBps grace openingBid registryVersion auctionFormat termsFormat');
  requireSpotId(value.spotId);
  if (value.class !== 0 && value.class !== 1) throw new RangeError('Invalid Seeker class');
  // Wire encoding deliberately does not claim that supplied accounts/terms are authorized.
  return Buffer.concat([key(value.config), key(value.term), key(value.auction), key(value.registry), bytes(value.registryHash, 32),
    uint(value.spotId, 1), uint(value.class, 1), uint(value.realmMask, 1), integer(value.round),
    integer(value.auctionStart, true), integer(value.auctionEnd, true), integer(value.operatingStart, true), integer(value.operatingEnd, true),
    key(value.mint), key(value.tokenProgram), key(value.vault), key(value.prizeOwner), key(value.prizeAta), uint(value.prizeBps, 2),
    integer(value.grace, true), integer(value.openingBid), version(value.registryVersion), version(value.auctionFormat), version(value.termsFormat)]);
}
export const encodeSeekerAuctionTerms = (value: SeekerAuctionTerms): Buffer => join('SKATERM1', [immutableTerms(value)]);
export const hashSeekerAuctionTerms = (value: SeekerAuctionTerms): Buffer => digest(encodeSeekerAuctionTerms(value));
/** Reconstructs the embedded termsHash rather than accepting a caller-supplied digest. */
export const encodeOpenSeekerAuctionPayload = (value: SeekerAuctionTerms): Buffer =>
  join('SKAOPEN1', [immutableTerms(value), hashSeekerAuctionTerms(value)]);
export const hashOpenSeekerAuctionPayload = (value: SeekerAuctionTerms): Buffer => digest(encodeOpenSeekerAuctionPayload(value));

export interface SettleSeekerAuctionPayload {
  readonly auction: PublicKey; readonly config: PublicKey; readonly term: PublicKey; readonly termsHash: Uint8Array;
  readonly highBid: bigint; readonly highBidder: PublicKey | null;
}
export function encodeSettleSeekerAuctionPayload(value: SettleSeekerAuctionPayload): Buffer {
  keys(value, 'auction config term termsHash highBid highBidder');
  const amount = integer(value.highBid);
  if ((value.highBid === 0n) !== (value.highBidder === null)) throw new Error('Winning bid and bidder disagree');
  return join('SKASETL1', [key(value.auction), key(value.config), key(value.term), bytes(value.termsHash, 32), amount,
    value.highBidder === null ? Buffer.alloc(33) : Buffer.concat([Buffer.from([1]), key(value.highBidder)])]);
}
export const hashSettleSeekerAuctionPayload = (value: SettleSeekerAuctionPayload): Buffer => digest(encodeSettleSeekerAuctionPayload(value));
