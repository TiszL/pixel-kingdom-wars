/** Pure live Seeker v1 ABI verification. Callers must independently establish
 * finalized RPC provenance, reviewed deployment identity and coherent read slots.
 * These snapshots confer no signing, settlement or completed-term authority. */
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms } from './seekerAuctionProtocol';
import { SEEKER_TERM_ACCOUNT_BYTES, type SeekerRawAccount } from './seekerTermAccounts';
import { seekerAuctionSecFor } from './devnetTestProfile';

// Server readers share the existing reviewed ABI decoders through this subpath;
// no alternate authority or upgradeable-loader interpretation is introduced.
export { decodeSeekerAuthority, type SeekerAuthorityFacts } from './seekerAuthorityAccount';
export { decodeUpgradeableProgramDataAddress, decodeProgramDataUpgradeAuthority } from './registryAttestation';
export { SEEKER_TERM_ACCOUNT_BYTES, type SeekerRawAccount } from './seekerTermAccounts';

const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;
const BITMAP_BYTES = Math.ceil(P.totalSpots / 8);
/** Anchor discriminator + Bid::INIT_SPACE in state.rs:118-125; an ABI size, not tuning. */
export const SEEKER_BID_ACCOUNT_BYTES = 83;
type AccountName = 'AuctionConfig' | 'SeekerTerm' | 'Auction' | 'Bid';

/** Detached strings and bigint values keep parsed authority separate from mutable SDK keys. */
export interface SeekerLiveAuctionConfig {
  readonly address: string; readonly programId: string; readonly authority: string; readonly registry: string;
  readonly registryHash: string; readonly registryVersion: number; readonly mint: string; readonly tokenProgram: string;
  readonly decimals: number; readonly prizeOwner: string; readonly prizeAta: string; readonly prizeBps: number;
  readonly openingBid: bigint; readonly firstOperatingStart: bigint; readonly termSec: bigint; readonly auctionSec: bigint;
  readonly graceSec: bigint; readonly auctionFormat: number; readonly termsFormat: number;
}
interface SeekerLiveCalendar {
  readonly auctionStart: bigint; readonly auctionEnd: bigint; readonly operatingStart: bigint; readonly operatingEnd: bigint;
}
export interface SeekerLiveTerm extends SeekerLiveCalendar {
  readonly address: string; readonly programId: string; readonly config: string; readonly registry: string; readonly registryHash: string;
  readonly round: bigint; readonly previousTerm: string | null; readonly opened: readonly number[]; readonly settled: readonly number[];
  readonly openedCount: number; readonly completedCount: number; readonly winnerCount: number;
  readonly completedAt: bigint | null; readonly completedSlot: bigint | null;
}
export interface SeekerLiveAuction extends SeekerLiveCalendar {
  readonly address: string; readonly programId: string; readonly config: string; readonly term: string; readonly registry: string;
  readonly spotId: number; readonly class: 0 | 1; readonly realmMask: number; readonly round: bigint;
  readonly termsHash: string; readonly vault: string; readonly highBid: bigint; readonly highBidder: string | null;
  readonly outstandingEscrow: bigint; readonly settled: boolean; readonly resultOwner: string | null;
  readonly settledAt: bigint | null; readonly settledSlot: bigint | null;
}
export interface SeekerLiveBid {
  readonly address: string; readonly programId: string; readonly auction: string; readonly wallet: string;
  readonly amount: bigint; readonly refunded: boolean;
}

function need(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Invalid live Seeker account: ${label}`);
}
function key(value: PublicKey): string {
  need(value && typeof value.toBytes === 'function' && typeof value.toBase58 === 'function', 'public key type');
  const bytes = value.toBytes(); need(bytes instanceof Uint8Array && bytes.length === 32, 'public key bytes');
  const canonical = new PublicKey(bytes).toBase58(); need(value.toBase58() === canonical, 'public key text'); return canonical;
}
function integer(value: bigint, signed: boolean, label: string): bigint {
  need(typeof value === 'bigint' && value >= (signed ? I64_MIN : 0n) && value <= (signed ? I64_MAX : U64_MAX), label); return value;
}
function le(value: bigint): Buffer { const out = Buffer.alloc(8); out.writeBigUInt64LE(value); return out; }
function pda(program: string, ...seeds: (string | Uint8Array)[]): readonly [string, number] {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : Buffer.from(s)), new PublicKey(program));
  return [address.toBase58(), bump];
}
const nonzero = (value: string) => value !== PublicKey.default.toBase58();

class Cursor {
  private at = 8;
  constructor(private readonly data: Buffer) {}
  bytes(length: number): Buffer {
    const end = this.at + length; need(Number.isSafeInteger(end) && end <= this.data.length, 'truncated field');
    const result = this.data.subarray(this.at, end); this.at = end; return result;
  }
  u8(): number { return this.bytes(1)[0]!; }
  u16(): number { return this.bytes(2).readUInt16LE(); }
  u64(): bigint { return this.bytes(8).readBigUInt64LE(); }
  i64(): bigint { return this.bytes(8).readBigInt64LE(); }
  key(): string { return new PublicKey(this.bytes(32)).toBase58(); }
  hash(): string { return this.bytes(32).toString('hex'); }
  bool(): boolean { const tag = this.u8(); need(tag === 0 || tag === 1, 'boolean/Option tag'); return tag === 1; }
  option<T>(read: () => T): T | null { return this.bool() ? read() : null; }
  // Borsh Options have variable width. Allocation padding may retain nonzero
  // bytes after an Option shrinks and is deliberately not interpreted as state.
}
function account(raw: SeekerRawAccount, name: AccountName, program: string, expected: string): Cursor {
  need(raw && key(raw.address) === expected && key(raw.owner) === program && raw.executable === false, `${name} identity/owner`);
  const size = name === 'Bid' ? SEEKER_BID_ACCOUNT_BYTES : SEEKER_TERM_ACCOUNT_BYTES[name];
  need(raw.data instanceof Uint8Array && raw.data.length === size, `${name} allocation`);
  const data = Buffer.from(raw.data), discriminator = idl.accounts.find(row => row.name === name)?.discriminator;
  need(discriminator?.length === 8 && data.subarray(0, 8).equals(Buffer.from(discriminator)), `${name} discriminator`);
  const cursor = new Cursor(data); need(cursor.u8() === 1, `${name} version`); return cursor;
}
function calendar(config: Pick<SeekerLiveAuctionConfig, 'firstOperatingStart' | 'termSec' | 'auctionSec'>, round: bigint, programId: string): SeekerLiveCalendar {
  integer(round, false, 'round'); integer(config.firstOperatingStart, true, 'first operating start');
  // The deployed v1 ELF fixes these durations. A calendar change requires a
  // separately reviewed ABI/program contract, not a runtime override here.
  // Exception: the night devnet-test profile (devnetTestProfile.ts), keyed to one non-accepted program id.
  need(config.termSec === BigInt(P.operatingTermSec) && config.auctionSec === BigInt(seekerAuctionSecFor(programId)), 'calendar duration');
  const start = integer(config.firstOperatingStart + round * config.termSec, true, 'calendar overflow');
  return { auctionStart: integer(start - config.auctionSec, true, 'calendar overflow'), auctionEnd: start,
    operatingStart: start, operatingEnd: integer(start + config.termSec, true, 'calendar overflow') };
}
function sameCalendar(actual: SeekerLiveCalendar, expected: SeekerLiveCalendar): boolean {
  return actual.auctionStart === expected.auctionStart && actual.auctionEnd === expected.auctionEnd
    && actual.operatingStart === expected.operatingStart && actual.operatingEnd === expected.operatingEnd;
}
function readCalendar(cursor: Cursor): SeekerLiveCalendar {
  return { auctionStart: cursor.i64(), auctionEnd: cursor.i64(), operatingStart: cursor.i64(), operatingEnd: cursor.i64() };
}
function bit(bits: readonly number[], spot: number): boolean { return (bits[spot >> 3]! & (1 << (spot % 8))) !== 0; }
function bitmapCount(bits: readonly number[]): number {
  need(bits.length === BITMAP_BYTES && bits.every(v => Number.isInteger(v) && v >= 0 && v <= 255), 'bitmap bytes');
  let count = 0;
  for (let i = 0; i < BITMAP_BYTES * 8; i++) if (bit(bits, i)) { need(i < P.totalSpots, 'unused bitmap bit'); count++; }
  return count;
}

/** Validates the singleton config and immutable v1 policy. The runtime must also
 * compare mint/prize owner with reviewed deployment pins and the SKR registry. */
export function decodeSeekerAuctionConfig(programId: PublicKey, raw: SeekerRawAccount): SeekerLiveAuctionConfig {
  const program = key(programId), [address, bump] = pda(program, 'auction_config'), c = account(raw, 'AuctionConfig', program, address);
  const authority = c.key(), registry = c.key(), registryHash = c.hash(), registryVersion = c.u16();
  const mint = c.key(), tokenProgram = c.key(), decimals = c.u8(), prizeOwner = c.key(), prizeAta = c.key();
  const prizeBps = c.u16(), openingBid = c.u64(), firstOperatingStart = c.i64(), termSec = c.i64(), auctionSec = c.i64(), graceSec = c.i64();
  const auctionFormat = c.u16(), termsFormat = c.u16();
  need(authority === pda(program, 'seeker_authority')[0] && registry === pda(program, 'seeker_registry')[0], 'config linkage');
  need(c.u8() === bump && registryVersion === 1 && auctionFormat === 1 && termsFormat === 1, 'config versions/bump');
  need(registryHash === hashSeekerRegistry(canonicalSeekerRegistry()).toString('hex'), 'config registry hash');
  need(tokenProgram === TOKEN_PROGRAM_ID.toBase58() && nonzero(mint) && nonzero(prizeOwner), 'config token/prize identity');
  const expectedOpening = BigInt(A.openingBidSkr) * 10n ** BigInt(decimals);
  need(expectedOpening <= U64_MAX && openingBid === expectedOpening && prizeBps === A.prizeBps
    && graceSec === BigInt(A.settlementGraceSec), 'config policy');
  need(prizeAta === getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(prizeOwner), true).toBase58(), 'config canonical prize ATA');
  calendar({ firstOperatingStart, termSec, auctionSec }, 0n, program);
  return Object.freeze({ address, programId: program, authority, registry, registryHash, registryVersion, mint, tokenProgram, decimals,
    prizeOwner, prizeAta, prizeBps, openingBid, firstOperatingStart, termSec, auctionSec, graceSec, auctionFormat, termsFormat });
}

/** The current bidding round or the next future bidding round. At auction_end,
 * that round is closed and the following round is selected, including gaps. */
export function seekerBiddingRoundAt(config: SeekerLiveAuctionConfig, nowSec: bigint): bigint {
  integer(nowSec, true, 'clock'); calendar(config, 0n, config.programId);
  const round = nowSec < config.firstOperatingStart ? 0n
    : integer((nowSec - config.firstOperatingStart) / config.termSec + 1n, false, 'round');
  calendar(config, round, config.programId); return round;
}

/** Decodes live or complete term state; completion here is not historical
 * settlement evidence and must not replace the completed-term verifier. */
export function decodeSeekerLiveTerm(config: SeekerLiveAuctionConfig, expectedRound: bigint, raw: SeekerRawAccount): SeekerLiveTerm {
  const clocks = calendar(config, expectedRound, config.programId), program = config.programId;
  need(config.address === pda(program, 'auction_config')[0], 'config PDA');
  const [address, bump] = pda(program, 'seeker_term', new PublicKey(config.address).toBytes(), le(expectedRound));
  const c = account(raw, 'SeekerTerm', program, address);
  need(c.key() === config.address && c.key() === config.registry && c.hash() === config.registryHash && c.u64() === expectedRound, 'term linkage');
  const previousTerm = c.option(() => c.key());
  const expectedPrevious = expectedRound === 0n ? null : pda(program, 'seeker_term', new PublicKey(config.address).toBytes(), le(expectedRound - 1n))[0];
  need(previousTerm === expectedPrevious, 'term predecessor');
  need(sameCalendar(readCalendar(c), clocks), 'term calendar');
  const opened = Object.freeze([...c.bytes(BITMAP_BYTES)]), settled = Object.freeze([...c.bytes(BITMAP_BYTES)]);
  const openedCount = bitmapCount(opened), settledCount = bitmapCount(settled);
  const completedCount = c.u8(), winnerCount = c.u8(), completedAt = c.option(() => c.i64()), completedSlot = c.option(() => c.u64());
  need(c.u8() === bump && completedCount === settledCount && winnerCount <= completedCount, 'term count/bump');
  for (let i = 0; i < P.totalSpots; i++) need(!bit(settled, i) || bit(opened, i), 'settled unopened spot');
  if (completedCount === P.totalSpots) {
    need(openedCount === P.totalSpots && completedAt !== null && completedSlot !== null && completedAt >= clocks.auctionEnd, 'term completion');
  } else {
    // Zero-bid auctions can settle before all spots have been opened. The
    // program checks full opened/settled bitmaps only on the final settlement.
    need(completedAt === null && completedSlot === null, 'premature term completion');
  }
  return Object.freeze({ address, programId: program, config: config.address, registry: config.registry, registryHash: config.registryHash,
    round: expectedRound, previousTerm, ...clocks, opened, settled, openedCount, completedCount, winnerCount, completedAt, completedSlot });
}

/** Requires the term snapshot from the same coherent finalized read. Missing
 * Auction accounts are represented by the caller, never fabricated as empty bids. */
export function decodeSeekerLiveAuction(config: SeekerLiveAuctionConfig, term: SeekerLiveTerm,
  expectedSpot: number, raw: SeekerRawAccount): SeekerLiveAuction {
  need(Number.isInteger(expectedSpot) && expectedSpot >= 0 && expectedSpot < P.totalSpots, 'auction spot');
  const program = config.programId, clocks = calendar(config, term.round, program), configKey = new PublicKey(config.address);
  const [termAddress] = pda(program, 'seeker_term', configKey.toBytes(), le(term.round));
  need(config.address === pda(program, 'auction_config')[0] && term.programId === program && term.address === termAddress
    && term.config === config.address && term.registry === config.registry && term.registryHash === config.registryHash
    && sameCalendar(term, clocks), 'auction expected term');
  const [address, bump] = pda(program, 'auction', configKey.toBytes(), Uint8Array.of(expectedSpot), le(term.round));
  const c = account(raw, 'Auction', program, address);
  need(c.key() === config.address && c.key() === term.address && c.key() === config.registry, 'auction linkage');
  const spotId = c.u8(), spotClass = c.u8(), realmMask = c.u8(), entry = canonicalSeekerRegistry()[expectedSpot]!;
  need(spotId === expectedSpot && spotClass === entry.class && realmMask === entry.realmMask && c.u64() === term.round, 'auction spot/round');
  need(sameCalendar(readCalendar(c), clocks), 'auction calendar');
  const termsHash = c.hash(), vault = c.key(), highBid = c.u64(), highBidder = c.option(() => c.key()), outstandingEscrow = c.u64();
  const settled = c.bool(), resultOwner = c.option(() => c.key()), settledAt = c.option(() => c.i64()), settledSlot = c.option(() => c.u64());
  need(c.u8() === bump && bit(term.opened, spotId) && bit(term.settled, spotId) === settled, 'auction bump/term bitmap');
  need(highBidder === null ? highBid === 0n && outstandingEscrow === 0n : nonzero(highBidder) && highBid >= config.openingBid, 'auction leader');
  if (settled) {
    need(resultOwner === highBidder && settledAt !== null && settledSlot !== null && settledAt >= clocks.auctionEnd, 'auction settlement');
    if (term.completedAt !== null) need(settledAt <= term.completedAt && term.completedSlot !== null && settledSlot <= term.completedSlot, 'auction after term completion');
  } else {
    need(resultOwner === null && settledAt === null && settledSlot === null && outstandingEscrow >= highBid, 'auction live backing/result');
  }
  need(vault === getAssociatedTokenAddressSync(new PublicKey(config.mint), new PublicKey(address), true).toBase58()
    && vault !== config.prizeAta, 'auction canonical vault');
  const expectedHash = hashSeekerAuctionTerms({ config: configKey, term: new PublicKey(term.address), auction: new PublicKey(address),
    registry: new PublicKey(config.registry), registryHash: Buffer.from(config.registryHash, 'hex'), spotId, class: entry.class, realmMask,
    round: term.round, ...clocks, mint: new PublicKey(config.mint), tokenProgram: new PublicKey(config.tokenProgram), vault: new PublicKey(vault),
    prizeOwner: new PublicKey(config.prizeOwner), prizeAta: new PublicKey(config.prizeAta), prizeBps: config.prizeBps,
    grace: config.graceSec, openingBid: config.openingBid, registryVersion: config.registryVersion,
    auctionFormat: config.auctionFormat, termsFormat: config.termsFormat });
  need(termsHash === expectedHash.toString('hex'), 'auction terms hash');
  return Object.freeze({ address, programId: program, config: config.address, term: term.address, registry: config.registry,
    spotId, class: entry.class, realmMask, round: term.round, ...clocks, termsHash, vault, highBid, highBidder,
    outstandingEscrow, settled, resultOwner, settledAt, settledSlot });
}

/** A zero, non-refunded Bid is valid both before bidding and after a winner's
 * amount is consumed. Refund eligibility additionally needs the auction leader. */
export function decodeSeekerLiveBid(programId: PublicKey, auction: PublicKey, wallet: PublicKey, raw: SeekerRawAccount): SeekerLiveBid {
  const program = key(programId), auctionKey = key(auction), walletKey = key(wallet);
  const [address, bump] = pda(program, 'bid', new PublicKey(auctionKey).toBytes(), new PublicKey(walletKey).toBytes());
  const c = account(raw, 'Bid', program, address);
  need(c.key() === auctionKey && c.key() === walletKey, 'Bid linkage');
  const amount = c.u64(), refunded = c.bool();
  need(c.u8() === bump && (!refunded || amount === 0n), 'Bid bump/refund state');
  return Object.freeze({ address, programId: program, auction: auctionKey, wallet: walletKey, amount, refunded });
}
