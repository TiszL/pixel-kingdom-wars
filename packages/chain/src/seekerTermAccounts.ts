/** Pure account ABI verification only. Caller must independently prove genuine
 * finalized RPC provenance, reviewed deployment identity and settlement transactions.
 * Synthetic account bytes passing this function are not chain authority. */
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { decodeSeekerAuthority, SEEKER_AUTHORITY_ACCOUNT_BYTES } from './seekerAuthorityAccount';
import { seekerAuctionSecFor } from './devnetTestProfile';
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms,
  type SeekerAuctionTerms } from './seekerAuctionProtocol';

const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;
/** Actual v1 INIT_SPACE allocations including the Anchor discriminator. */
export const SEEKER_TERM_ACCOUNT_BYTES = Object.freeze({ SeekerAuthority: SEEKER_AUTHORITY_ACCOUNT_BYTES, AuctionConfig: 283,
  SeekerRegistry: 344, SeekerTerm: 225, Auction: 314 });
type AccountName = keyof typeof SEEKER_TERM_ACCOUNT_BYTES;
export interface SeekerRawAccount {
  readonly address: PublicKey; readonly owner: PublicKey; readonly executable: boolean; readonly data: Uint8Array;
}
export interface SeekerTermAccountPolicy {
  readonly programId: PublicKey; readonly config: PublicKey; readonly round: bigint;
  readonly mint: PublicKey; readonly prizeOwner: PublicKey; readonly prizeAta: PublicKey;
  readonly genesisHash: PublicKey; readonly operatingAt: bigint;
}
export interface SeekerTermAccountSet {
  readonly authority: SeekerRawAccount; readonly config: SeekerRawAccount;
  readonly registry: SeekerRawAccount; readonly term: SeekerRawAccount;
  readonly auctions: readonly SeekerRawAccount[];
}
type TermKey = 'config' | 'term' | 'auction' | 'registry' | 'mint' | 'tokenProgram' | 'vault' | 'prizeOwner' | 'prizeAta';
/** Strings make the returned graph immutable; no mutable PublicKey/Buffer escapes. */
export type SeekerVerifiedTerms = Readonly<Omit<SeekerAuctionTerms, TermKey | 'registryHash'>
  & Record<TermKey, string> & { registryHash: string }>;
export interface VerifiedSeekerAuction {
  readonly terms: SeekerVerifiedTerms; readonly termsHash: string;
  readonly winner: string | null; readonly highBid: bigint; readonly settledAt: bigint; readonly settledSlot: bigint;
}
export interface VerifiedSeekerTermAccounts {
  readonly source: Readonly<{ programId: string; genesisHash: string; config: string; round: bigint }>;
  readonly authority: Readonly<{ address: string; admissionPaused: boolean }>;
  readonly registry: string; readonly registryHash: string; readonly term: string; readonly previousTerm: string | null;
  readonly decimals: number; readonly auctionStart: bigint; readonly auctionEnd: bigint;
  readonly operatingStart: bigint; readonly operatingEnd: bigint;
  readonly completedAt: bigint; readonly completedSlot: bigint; readonly winnerCount: number;
  readonly auctions: readonly VerifiedSeekerAuction[];
}
function requireValue(value: unknown, label: string): asserts value { if (!value) throw new Error(`Invalid Seeker accounts: ${label}`); }
function key(value: PublicKey): string {
  requireValue(value && typeof value.toBytes === 'function' && typeof value.toBase58 === 'function', 'public key type');
  const bytes = value.toBytes(); requireValue(bytes instanceof Uint8Array && bytes.length === 32, 'public key bytes');
  const canonical = new PublicKey(bytes).toBase58(); requireValue(value.toBase58() === canonical, 'public key text'); return canonical;
}
function integer(value: bigint, signed: boolean, label: string): bigint {
  requireValue(typeof value === 'bigint' && value >= (signed ? I64_MIN : 0n) && value <= (signed ? I64_MAX : U64_MAX), label); return value;
}
function le(value: bigint): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; }
function pda(program: string, ...seeds: (string | Uint8Array)[]): readonly [string, number] {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds.map(x => typeof x === 'string' ? Buffer.from(x) : Buffer.from(x)), new PublicKey(program));
  return [address.toBase58(), bump];
}
class Cursor {
  private at = 8;
  constructor(private readonly data: Buffer) {}
  bytes(length: number): Buffer {
    const end = this.at + length; requireValue(Number.isSafeInteger(end) && end <= this.data.length, 'truncated field');
    const result = this.data.subarray(this.at, end); this.at = end; return result;
  }
  u8(): number { return this.bytes(1)[0]!; }
  u16(): number { return this.bytes(2).readUInt16LE(); }
  u64(): bigint { return this.bytes(8).readBigUInt64LE(); }
  i64(): bigint { return this.bytes(8).readBigInt64LE(); }
  key(): string { return new PublicKey(this.bytes(32)).toBase58(); }
  hash(): string { return this.bytes(32).toString('hex'); }
  bool(): boolean { const flag = this.u8(); requireValue(flag === 0 || flag === 1, 'boolean tag'); return flag === 1; }
  option<T>(read: () => T): T | null { return this.bool() ? read() : null; }
  // Fixed allocation may contain nonzero remnants after an Option shrinks.
  // Only the complete parsed Borsh payload is interpreted; padding is not state.
}
function account(raw: SeekerRawAccount, name: AccountName, program: string, expected: string): Cursor {
  requireValue(raw && key(raw.address) === expected && key(raw.owner) === program && raw.executable === false, `${name} identity/owner`);
  requireValue(raw.data instanceof Uint8Array && raw.data.length === SEEKER_TERM_ACCOUNT_BYTES[name], `${name} allocation`);
  const data = Buffer.from(raw.data), discriminator = idl.accounts.find(row => row.name === name)?.discriminator;
  requireValue(discriminator?.length === 8 && data.subarray(0, 8).equals(Buffer.from(discriminator)), `${name} discriminator`);
  return new Cursor(data);
}
function complete(bits: Buffer): boolean {
  return Array.from({ length: bits.length * 8 }, (_, i) => ((bits[i >> 3]! & (1 << (i % 8))) !== 0) === (i < P.totalSpots)).every(Boolean);
}
const nonzero = (value: string) => value !== PublicKey.default.toBase58();

/** A bounded discovery hint, never term authority. The complete finalized reader
 * must independently verify the selected round, interval and original settlement.
 * AuctionConfig's fixed v1 ABI stores first_operating_start at246 and term_sec
 * at254; unlike SeekerTerm these offsets do not follow a variable Option. */
export function candidateSeekerRoundAt(expected: Pick<SeekerTermAccountPolicy, 'programId' | 'config'>,
  raw: SeekerRawAccount, earnedAtMs: bigint): bigint {
  const program = key(expected.programId), configKey = key(expected.config);
  requireValue(configKey === pda(program, 'auction_config')[0], 'config PDA');
  const config = account(raw, 'AuctionConfig', program, configKey);
  requireValue(config.u8() === 1 && typeof earnedAtMs === 'bigint', 'calendar version/earning time');
  const bytes = Buffer.from(raw.data), firstStart = bytes.readBigInt64LE(246), termSec = bytes.readBigInt64LE(254);
  requireValue(termSec > 0n && termSec === BigInt(P.operatingTermSec), 'calendar duration');
  requireValue(earnedAtMs >= firstStart * 1000n, 'earning precedes calendar');
  const round = integer((earnedAtMs - firstStart * 1000n) / (termSec * 1000n), false, 'round');
  const start = integer(firstStart + round * termSec, true, 'calendar overflow');
  integer(start - BigInt(seekerAuctionSecFor(program)), true, 'calendar overflow');
  integer(start + termSec, true, 'calendar overflow');
  return round;
}

export function verifySeekerTermAccounts(expected: SeekerTermAccountPolicy, accounts: SeekerTermAccountSet): VerifiedSeekerTermAccounts {
  return verifyTermAccounts(expected, accounts, false);
}
/** Original completed terms retain tax rights after expiry. operatingAt is still
 * the actual observed Clock; this purpose grants no current operating admission. */
export function verifyHistoricalSeekerTermAccounts(expected: SeekerTermAccountPolicy, accounts: SeekerTermAccountSet): VerifiedSeekerTermAccounts {
  return verifyTermAccounts(expected, accounts, true);
}
function verifyTermAccounts(expected: SeekerTermAccountPolicy, accounts: SeekerTermAccountSet, historical: boolean): VerifiedSeekerTermAccounts {
  const program = key(expected.programId), configKey = key(expected.config), mint = key(expected.mint);
  const prizeOwner = key(expected.prizeOwner), prizeAta = key(expected.prizeAta), genesisHash = key(expected.genesisHash);
  const round = integer(expected.round, false, 'round'), at = integer(expected.operatingAt, true, 'operating time');
  requireValue(nonzero(genesisHash) && nonzero(prizeOwner), 'empty pinned domain/custodian');
  const [authorityKey] = pda(program, 'seeker_authority');
  const [registryKey, registryBump] = pda(program, 'seeker_registry');
  const [canonicalConfig, configBump] = pda(program, 'auction_config');
  const [termKey, termBump] = pda(program, 'seeker_term', new PublicKey(configKey).toBytes(), le(round));
  requireValue(configKey === canonicalConfig, 'config PDA');
  const { admissionPaused } = decodeSeekerAuthority(program, genesisHash, accounts.authority);
  const config = account(accounts.config, 'AuctionConfig', program, configKey);
  requireValue(config.u8() === 1 && config.key() === authorityKey && config.key() === registryKey, 'config linkage/version');
  const registryHash = config.hash(), registryVersion = config.u16();
  requireValue(config.key() === mint && config.key() === TOKEN_PROGRAM_ID.toBase58(), 'config mint/token program');
  const decimals = config.u8();
  requireValue(config.key() === prizeOwner && config.key() === prizeAta, 'config prize destination');
  const prizeBps = config.u16(), openingBid = config.u64(), firstStart = config.i64();
  const termSec = config.i64(), auctionSec = config.i64(), grace = config.i64();
  const auctionFormat = config.u16(), termsFormat = config.u16();
  const expectedOpening = BigInt(A.openingBidSkr) * 10n ** BigInt(decimals);
  requireValue(config.u8() === configBump && registryVersion === 1 && auctionFormat === 1 && termsFormat === 1
    && prizeBps === A.prizeBps && expectedOpening <= U64_MAX && openingBid === expectedOpening
    && termSec === BigInt(P.operatingTermSec) && auctionSec === BigInt(seekerAuctionSecFor(program))
    && grace === BigInt(A.settlementGraceSec)
    && prizeAta === getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(prizeOwner), true).toBase58(), 'config policy/canonical prize ATA');
  const registry = account(accounts.registry, 'SeekerRegistry', program, registryKey);
  requireValue(registry.u16() === registryVersion && registry.u8() === 1, 'registry version/island');
  const canonical = canonicalSeekerRegistry();
  for (const entry of canonical) requireValue(registry.u8() === entry.spotId && registry.u8() === entry.class
    && registry.u8() === entry.realmMask, 'registry mapping/order');
  requireValue(registry.hash() === registryHash && registry.u8() === registryBump
    && hashSeekerRegistry(canonical).toString('hex') === registryHash, 'registry hash/bump');
  const term = account(accounts.term, 'SeekerTerm', program, termKey);
  requireValue(term.u8() === 1 && term.key() === configKey && term.key() === registryKey && term.hash() === registryHash && term.u64() === round, 'term linkage');
  const previousTerm = term.option(() => term.key());
  const expectedPrevious = round === 0n ? null : pda(program, 'seeker_term', new PublicKey(configKey).toBytes(), le(round - 1n))[0];
  requireValue(previousTerm === expectedPrevious, 'term predecessor');
  const auctionStart = term.i64(), auctionEnd = term.i64(), operatingStart = term.i64(), operatingEnd = term.i64();
  const calculatedStart = integer(firstStart + round * termSec, true, 'calendar overflow');
  requireValue(operatingStart === calculatedStart && auctionStart === integer(calculatedStart - auctionSec, true, 'calendar overflow')
    && auctionEnd === calculatedStart && operatingEnd === integer(calculatedStart + termSec, true, 'calendar overflow')
    && at >= operatingStart && (historical || at < operatingEnd), 'inactive or inconsistent calendar');
  const bitmapBytes = Math.ceil(P.totalSpots / 8);
  requireValue(complete(term.bytes(bitmapBytes)) && complete(term.bytes(bitmapBytes)), 'incomplete term bitmap');
  const completedCount = term.u8(), winnerCount = term.u8();
  const completedAt = term.option(() => term.i64()), completedSlot = term.option(() => term.u64());
  requireValue(term.u8() === termBump && completedCount === P.totalSpots && winnerCount <= completedCount
    && completedAt !== null && completedSlot !== null && completedAt >= auctionEnd && completedAt <= at, 'term completion');
  requireValue(Array.isArray(accounts.auctions) && accounts.auctions.length === P.totalSpots, 'missing auction accounts');
  const seen = new Set<number>();
  const auctions = accounts.auctions.map(raw => {
    // Validate the full header before using its spot ID to derive an address.
    const c = account(raw, 'Auction', program, key(raw.address));
    requireValue(c.u8() === 1 && c.key() === configKey && c.key() === termKey && c.key() === registryKey, 'auction linkage');
    const spotId = c.u8(), spotClass = c.u8(), realmMask = c.u8(), entry = canonical[spotId];
    requireValue(entry && !seen.has(spotId) && entry.class === spotClass && entry.realmMask === realmMask, 'duplicate/unknown auction spot'); seen.add(spotId);
    const [auctionKey, bump] = pda(program, 'auction', new PublicKey(configKey).toBytes(), Uint8Array.of(spotId), le(round));
    requireValue(key(raw.address) === auctionKey && c.u64() === round && c.i64() === auctionStart && c.i64() === auctionEnd
      && c.i64() === operatingStart && c.i64() === operatingEnd, 'auction PDA/calendar');
    const termsHash = c.hash(), vault = c.key(), highBid = c.u64(), highBidder = c.option(() => c.key());
    c.u64(); // outstanding escrow can decrease after settlement through loser refunds.
    const settled = c.bool(), winner = c.option(() => c.key()), settledAt = c.option(() => c.i64()), settledSlot = c.option(() => c.u64());
    requireValue(c.u8() === bump && settled && settledAt !== null && settledSlot !== null && settledAt >= auctionEnd && settledAt <= completedAt
      && settledSlot <= completedSlot && winner === highBidder && (winner === null ? highBid === 0n : highBid >= openingBid && nonzero(winner)), 'auction terminal result');
    requireValue(vault === getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(auctionKey), true).toBase58()
      && vault !== prizeAta, 'auction canonical vault');
    const protocol: SeekerAuctionTerms = { config: new PublicKey(configKey), term: new PublicKey(termKey), auction: new PublicKey(auctionKey), registry: new PublicKey(registryKey),
      registryHash: Buffer.from(registryHash, 'hex'), spotId, class: entry.class, realmMask, round, auctionStart, auctionEnd, operatingStart, operatingEnd,
      mint: new PublicKey(mint), tokenProgram: TOKEN_PROGRAM_ID, vault: new PublicKey(vault), prizeOwner: new PublicKey(prizeOwner), prizeAta: new PublicKey(prizeAta),
      prizeBps, grace, openingBid, registryVersion, auctionFormat, termsFormat };
    requireValue(hashSeekerAuctionTerms(protocol).toString('hex') === termsHash, 'auction terms hash');
    const terms: SeekerVerifiedTerms = Object.freeze({ ...protocol, config: configKey, term: termKey, auction: auctionKey, registry: registryKey,
      registryHash, mint, tokenProgram: TOKEN_PROGRAM_ID.toBase58(), vault, prizeOwner, prizeAta });
    return Object.freeze({ terms, termsHash, winner, highBid, settledAt, settledSlot });
  }).sort((a, b) => a.terms.spotId - b.terms.spotId);
  requireValue(auctions.filter(row => row.winner !== null).length === winnerCount
    && auctions.reduce((max, row) => row.settledSlot > max ? row.settledSlot : max, 0n) === completedSlot
    && auctions.some(row => row.settledSlot === completedSlot && row.settledAt === completedAt), 'term counter/completion disagrees with auctions');
  return Object.freeze({ source: Object.freeze({ programId: program, genesisHash, config: configKey, round }),
    authority: Object.freeze({ address: authorityKey, admissionPaused }), registry: registryKey, registryHash, term: termKey, previousTerm,
    decimals, auctionStart, auctionEnd, operatingStart, operatingEnd, completedAt, completedSlot, winnerCount,
    auctions: Object.freeze(auctions) });
}
