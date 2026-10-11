/** SA-0/T6 synthetic ABI fixtures only; no fixture proves finalized RPC provenance. */
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms } from './seekerAuctionProtocol';
import { SEEKER_TERM_ACCOUNT_BYTES, type SeekerRawAccount } from './seekerTermAccounts';
import { decodeSeekerAuctionConfig, decodeSeekerLiveTerm, decodeSeekerLiveAuction,
  decodeSeekerLiveBid, seekerBiddingRoundAt } from './seekerAuctionLive';

const { BorshAccountsCoder, BN } = anchorPkg;
const coder = new BorshAccountsCoder(idl as Idl);
const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
const program = new PublicKey(idl.address), pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const pda = (...seeds: (string | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : Buffer.from(s)), program);
const fullBitmap = () => Array.from({ length: Math.ceil(P.totalSpots / 8) }, (_, i) => i === Math.floor(P.totalSpots / 8) ? (1 << (P.totalSpots % 8)) - 1 : 255);
function anchorValue(value: unknown): unknown {
  if (typeof value === 'bigint') return new BN(value.toString());
  if (value instanceof PublicKey || value === null) return value;
  if (Array.isArray(value)) return value.map(anchorValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anchorValue(v)]));
  return value;
}
function fixture(round = 0n) {
  const [authority] = pda('seeker_authority'), [config, configBump] = pda('auction_config'), [registry] = pda('seeker_registry');
  const [term, termBump] = pda('seeker_term', config.toBytes(), le(round));
  const spot = canonicalSeekerRegistry()[23]!, [auction, auctionBump] = pda('auction', config.toBytes(), Uint8Array.of(spot.spotId), le(round));
  const wallet = pk(210), [bid, bidBump] = pda('bid', auction.toBytes(), wallet.toBytes());
  const mint = pk(201), prizeOwner = pk(202), prizeAta = getAssociatedTokenAddressSync(mint, prizeOwner, true);
  const vault = getAssociatedTokenAddressSync(mint, auction, true), registryHash = hashSeekerRegistry(canonicalSeekerRegistry());
  const firstStart = 1_791_158_400n, termSec = BigInt(P.operatingTermSec), auctionSec = BigInt(P.overlappingAuctionSec);
  const operatingStart = firstStart + round * termSec, operatingEnd = operatingStart + termSec, auctionStart = operatingStart - auctionSec;
  const decimals = 6, openingBid = BigInt(A.openingBidSkr) * 10n ** BigInt(decimals);
  const terms = { config, term, auction, registry, registryHash, ...spot, round, auctionStart, auctionEnd: operatingStart,
    operatingStart, operatingEnd, mint, tokenProgram: TOKEN_PROGRAM_ID, vault, prizeOwner, prizeAta,
    prizeBps: A.prizeBps, grace: BigInt(A.settlementGraceSec), openingBid, registryVersion: 1, auctionFormat: 1, termsFormat: 1 };
  const models = {
    config: { version: 1, authority, registry, registry_hash: [...registryHash], registry_version: 1, mint, token_program: TOKEN_PROGRAM_ID,
      decimals, prize_owner: prizeOwner, prize_ata: prizeAta, prize_bps: A.prizeBps as number, opening_bid: openingBid,
      first_operating_start: firstStart, term_sec: termSec, auction_sec: auctionSec, grace_sec: BigInt(A.settlementGraceSec),
      auction_format: 1, terms_format: 1, bump: configBump },
    term: { version: 1, config, registry, registry_hash: [...registryHash], round,
      previous: round === 0n ? null : pda('seeker_term', config.toBytes(), le(round - 1n))[0],
      auction_start: auctionStart, auction_end: operatingStart, operating_start: operatingStart, operating_end: operatingEnd,
      opened: fullBitmap(), settled: Array(Math.ceil(P.totalSpots / 8)).fill(0) as number[], completed_count: 0, winner_count: 0,
      completed_at: null as bigint | null, completed_slot: null as bigint | null, bump: termBump },
    auction: { version: 1, config, term, registry, spot: { id: spot.spotId, class: spot.class as number, realm_mask: spot.realmMask }, round,
      auction_start: auctionStart, auction_end: operatingStart, operating_start: operatingStart, operating_end: operatingEnd,
      terms_hash: [...hashSeekerAuctionTerms(terms)], vault, high_bid: 0n, high_bidder: null as PublicKey | null,
      outstanding_escrow: 0n, settled: false, result_owner: null as PublicKey | null, settled_at: null as bigint | null,
      settled_slot: null as bigint | null, bump: auctionBump },
    bid: { version: 1, auction, wallet, amount: 0n, refunded: false, bump: bidBump },
  };
  const addresses = { config, term, auction, bid }, names = { config: 'AuctionConfig', term: 'SeekerTerm', auction: 'Auction', bid: 'Bid' } as const;
  async function pack(name: keyof typeof models): Promise<SeekerRawAccount> {
    const encoded = await coder.encode(names[name], anchorValue(models[name]) as object);
    const data = Buffer.alloc(name === 'bid' ? 83 : SEEKER_TERM_ACCOUNT_BYTES[names[name] as 'AuctionConfig' | 'SeekerTerm' | 'Auction']);
    expect(encoded.length).toBeLessThanOrEqual(data.length); encoded.copy(data);
    return { address: addresses[name], owner: program, executable: false, data };
  }
  async function decode(name: keyof typeof models, raw?: SeekerRawAccount) {
    if (name === 'bid') return decodeSeekerLiveBid(program, auction, wallet, raw ?? await pack('bid'));
    const c = decodeSeekerAuctionConfig(program, name === 'config' && raw ? raw : await pack('config'));
    if (name === 'config') return c;
    const t = decodeSeekerLiveTerm(c, round, name === 'term' && raw ? raw : await pack('term'));
    if (name === 'term') return t;
    return decodeSeekerLiveAuction(c, t, spot.spotId, raw ?? await pack('auction'));
  }
  function placeBid() { models.auction.high_bid = openingBid; models.auction.high_bidder = wallet;
    models.auction.outstanding_escrow = openingBid * 2n; models.bid.amount = openingBid; }
  function settle(winner = false) {
    if (winner) placeBid();
    models.term.settled[spot.spotId >> 3]! |= 1 << (spot.spotId % 8); models.term.completed_count = 1;
    models.term.winner_count = winner ? 1 : 0; models.auction.settled = true; models.auction.result_owner = winner ? wallet : null;
    models.auction.settled_at = operatingStart; models.auction.settled_slot = 1000n;
    models.auction.outstanding_escrow = winner ? openingBid : 0n; models.bid.amount = 0n;
  }
  return { models, pack, decode, placeBid, settle, addresses, wallet, firstStart, termSec, auctionSec, openingBid, operatingStart, operatingEnd, spot };
}
type Fixture = ReturnType<typeof fixture>;

describe('SA-0 T6: strict live Seeker account decoders', () => {
  it('decodes live config facts at their actual ABI locations', async () => {
    const f = fixture(), raw = await f.pack('config'), config = decodeSeekerAuctionConfig(program, raw);
    expect(config).toMatchObject({ address: f.addresses.config.toBase58(), programId: program.toBase58(),
      mint: f.models.config.mint.toBase58(), prizeOwner: f.models.config.prize_owner.toBase58(), decimals: 6,
      openingBid: f.openingBid, firstOperatingStart: f.firstStart, termSec: f.termSec, auctionSec: f.auctionSec, graceSec: BigInt(A.settlementGraceSec) });
    expect(Buffer.from(raw.data).readBigInt64LE(246)).toBe(config.firstOperatingStart);
    expect(Buffer.from(raw.data).readBigInt64LE(254)).toBe(config.termSec);
  });
  it('decodes a round-zero live term with incomplete opening and no completion Options', async () => {
    const f = fixture(); f.models.term.opened.fill(0); f.models.term.opened[0] = 5;
    const c = decodeSeekerAuctionConfig(program, await f.pack('config')), t = decodeSeekerLiveTerm(c, 0n, await f.pack('term'));
    expect(t).toMatchObject({ address: f.addresses.term.toBase58(), round: 0n, previousTerm: null, openedCount: 2,
      completedCount: 0, winnerCount: 0, completedAt: null, completedSlot: null, auctionEnd: f.firstStart });
    expect(t.opened).toEqual(f.models.term.opened); expect(t.settled).toEqual(f.models.term.settled);
  });
  it('reads a later predecessor Option and complete all-zero-winner term without offset drift', async () => {
    const f = fixture(2n); f.models.term.settled = fullBitmap(); f.models.term.completed_count = P.totalSpots;
    f.models.term.completed_at = f.operatingStart; f.models.term.completed_slot = 500n;
    const c = decodeSeekerAuctionConfig(program, await f.pack('config')), t = decodeSeekerLiveTerm(c, 2n, await f.pack('term'));
    expect(t.previousTerm).toBe(f.models.term.previous!.toBase58()); expect(t.completedAt).toBe(f.operatingStart);
    expect(t.completedCount).toBe(P.totalSpots); expect(t.winnerCount).toBe(0);
  });
  it('allows partial zero-bid settlement while other spots are unopened, as the program does', async () => {
    const f = fixture(); f.settle(); f.models.term.opened.fill(0);
    f.models.term.opened[f.spot.spotId >> 3] = 1 << (f.spot.spotId % 8);
    await expect(f.decode('term')).resolves.toMatchObject({ openedCount: 1, completedCount: 1 });
  });
  it('decodes no bidder, a live high bidder, then a settled winner with loser escrow remaining', async () => {
    const f = fixture(); await expect(f.decode('auction')).resolves.toMatchObject({ highBid: 0n, highBidder: null, settled: false });
    f.placeBid(); await expect(f.decode('auction')).resolves.toMatchObject({ highBid: f.openingBid, highBidder: f.wallet.toBase58(), outstandingEscrow: f.openingBid * 2n });
    f.settle(true); await expect(f.decode('auction')).resolves.toMatchObject({ settled: true, resultOwner: f.wallet.toBase58(),
      settledAt: f.operatingStart, settledSlot: 1000n, outstandingEscrow: f.openingBid });
  });
  it('accepts a settled unsold auction without treating absent winner as absent settlement', async () => {
    const f = fixture(); f.settle(); await expect(f.decode('auction')).resolves.toMatchObject({ settled: true, resultOwner: null,
      highBidder: null, highBid: 0n, settledAt: f.operatingStart, settledSlot: 1000n });
  });
  it('decodes initial, active, refunded, and winner-consumed Bid states', async () => {
    const f = fixture(); await expect(f.decode('bid')).resolves.toMatchObject({ amount: 0n, refunded: false });
    f.placeBid(); await expect(f.decode('bid')).resolves.toMatchObject({ amount: f.openingBid, wallet: f.wallet.toBase58() });
    f.models.bid.amount = 0n; f.models.bid.refunded = true; await expect(f.decode('bid')).resolves.toMatchObject({ amount: 0n, refunded: true });
    f.models.bid.refunded = false; await expect(f.decode('bid')).resolves.toMatchObject({ amount: 0n, refunded: false });
  });
  it('ignores nonzero unused allocation padding after None Options', async () => {
    const f = fixture(), t = await f.pack('term'), a = await f.pack('auction');
    t.data.fill(255, 177); a.data.fill(255, 234);
    await expect(f.decode('term', t)).resolves.toMatchObject({ completedAt: null, completedSlot: null });
    await expect(f.decode('auction', a)).resolves.toMatchObject({ settled: false, highBidder: null });
  });
  it('returns detached frozen state and frozen bitmap arrays', async () => {
    const f = fixture(), raw = await f.pack('term'), c = decodeSeekerAuctionConfig(program, await f.pack('config'));
    const t = decodeSeekerLiveTerm(c, 0n, raw), a = await f.decode('auction'), b = await f.decode('bid');
    raw.data.fill(0); expect(t.opened).toEqual(fullBitmap());
    for (const value of [c, t, t.opened, t.settled, a, b]) expect(Object.isFrozen(value)).toBe(true);
  });
  for (const name of ['config', 'term', 'auction', 'bid'] as const) {
    for (const defect of ['address', 'owner', 'executable', 'short', 'long', 'discriminator', 'version'] as const) {
      it(`refuses ${name} ${defect}`, async () => {
        const f = fixture(), raw = await f.pack(name), data = Buffer.from(raw.data);
        const changed: SeekerRawAccount = defect === 'address' ? { ...raw, address: pk(240) }
          : defect === 'owner' ? { ...raw, owner: pk(240) } : defect === 'executable' ? { ...raw, executable: true }
          : defect === 'short' ? { ...raw, data: data.subarray(0, data.length - 1) }
          : defect === 'long' ? { ...raw, data: Buffer.concat([data, Buffer.of(0)]) }
          : { ...raw, data };
        if (defect === 'discriminator') data[0]! ^= 1; if (defect === 'version') data[8] = 2;
        await expect(f.decode(name, changed)).rejects.toThrow();
      });
    }
  }
  const configDefects: [string, (f: Fixture) => void][] = [
    ['authority link', f => { f.models.config.authority = pk(240); }], ['registry link', f => { f.models.config.registry = pk(240); }],
    ['registry hash', f => { f.models.config.registry_hash[0]! ^= 1; }], ['registry version', f => { f.models.config.registry_version = 2; }],
    ['token program', f => { f.models.config.token_program = pk(240); }], ['prize ATA', f => { f.models.config.prize_ata = pk(240); }],
    ['zero prize owner', f => { f.models.config.prize_owner = PublicKey.default; }], ['prize split', f => { f.models.config.prize_bps--; }],
    ['opening amount', f => { f.models.config.opening_bid--; }], ['unrepresentable decimal scale', f => { f.models.config.decimals = 255; }],
    ['term duration', f => { f.models.config.term_sec--; }], ['auction duration', f => { f.models.config.auction_sec--; }],
    ['grace', f => { f.models.config.grace_sec--; }], ['auction format', f => { f.models.config.auction_format = 2; }],
    ['terms format', f => { f.models.config.terms_format = 2; }], ['bump', f => { f.models.config.bump ^= 1; }],
    ['first calendar underflow', f => { f.models.config.first_operating_start = -(1n << 63n); }],
    ['first calendar overflow', f => { f.models.config.first_operating_start = (1n << 63n) - 1n; }],
  ];
  for (const [label, mutate] of configDefects) it(`refuses config ${label}`, async () => { const f = fixture(); mutate(f); await expect(f.decode('config')).rejects.toThrow(); });
  const termDefects: [string, (f: Fixture) => void][] = [
    ['config link', f => { f.models.term.config = pk(240); }], ['registry link', f => { f.models.term.registry = pk(240); }],
    ['registry hash', f => { f.models.term.registry_hash[0]! ^= 1; }], ['round', f => { f.models.term.round++; }],
    ['round-zero predecessor', f => { f.models.term.previous = pk(240); }], ['auction start', f => { f.models.term.auction_start++; }],
    ['auction end', f => { f.models.term.auction_end++; }], ['operating start', f => { f.models.term.operating_start++; }],
    ['operating end', f => { f.models.term.operating_end++; }], ['opened unused bit', f => { f.models.term.opened[12]! |= 128; }],
    ['settled unused bit', f => { f.models.term.settled[12]! |= 128; }],
    ['settled without opened', f => { f.models.term.opened[0]! &= ~1; f.models.term.settled[0] = 1; f.models.term.completed_count = 1; }],
    ['counter mismatch', f => { f.models.term.completed_count = 1; }], ['winner above completion count', f => { f.models.term.winner_count = 1; }],
    ['premature completion', f => { f.models.term.completed_at = f.operatingStart; f.models.term.completed_slot = 1n; }],
    ['unpaired completion', f => { f.models.term.completed_slot = 1n; }], ['bump', f => { f.models.term.bump ^= 1; }],
  ];
  for (const [label, mutate] of termDefects) it(`refuses term ${label}`, async () => { const f = fixture(); mutate(f); await expect(f.decode('term')).rejects.toThrow(); });
  it('refuses a wrong or absent later predecessor and full bitmap without completion evidence', async () => {
    for (const previous of [null, pk(240)]) { const f = fixture(1n); f.models.term.previous = previous; await expect(f.decode('term')).rejects.toThrow(); }
    const f = fixture(); f.models.term.settled = fullBitmap(); f.models.term.completed_count = P.totalSpots;
    await expect(f.decode('term')).rejects.toThrow(); f.models.term.completed_at = f.operatingStart - 1n; f.models.term.completed_slot = 1n;
    await expect(f.decode('term')).rejects.toThrow();
  });
  const auctionDefects: [string, (f: Fixture) => void][] = [
    ['config link', f => { f.models.auction.config = pk(240); }], ['term link', f => { f.models.auction.term = pk(240); }],
    ['registry link', f => { f.models.auction.registry = pk(240); }], ['spot', f => { f.models.auction.spot.id++; }],
    ['spot class', f => { f.models.auction.spot.class ^= 1; }], ['realm mask', f => { f.models.auction.spot.realm_mask ^= 1; }],
    ['round', f => { f.models.auction.round++; }], ['calendar', f => { f.models.auction.auction_end++; }],
    ['terms hash', f => { f.models.auction.terms_hash[0]! ^= 1; }], ['vault', f => { f.models.auction.vault = pk(240); }],
    ['bid without bidder', f => { f.models.auction.high_bid = f.openingBid; }], ['bidder without bid', f => { f.models.auction.high_bidder = f.wallet; }],
    ['below-opening leader', f => { f.placeBid(); f.models.auction.high_bid--; }],
    ['unbacked active leader', f => { f.placeBid(); f.models.auction.outstanding_escrow = f.openingBid - 1n; }],
    ['unsettled result', f => { f.models.auction.result_owner = f.wallet; }], ['unsettled timestamp', f => { f.models.auction.settled_at = f.operatingStart; }],
    ['settled bitmap disagreement', f => { f.models.auction.settled = true; }],
    ['unopened spot', f => { f.models.term.opened[f.spot.spotId >> 3]! &= ~(1 << (f.spot.spotId % 8)); }],
    ['winner differs from leader', f => { f.settle(true); f.models.auction.result_owner = pk(240); }],
    ['settled before auction end', f => { f.settle(); f.models.auction.settled_at = f.operatingStart - 1n; }],
    ['missing settlement slot', f => { f.settle(); f.models.auction.settled_slot = null; }], ['bump', f => { f.models.auction.bump ^= 1; }],
  ];
  for (const [label, mutate] of auctionDefects) it(`refuses auction ${label}`, async () => { const f = fixture(); mutate(f); await expect(f.decode('auction')).rejects.toThrow(); });
  const bidDefects: [string, (f: Fixture) => void][] = [
    ['auction link', f => { f.models.bid.auction = pk(240); }], ['wallet link', f => { f.models.bid.wallet = pk(240); }],
    ['refunded positive amount', f => { f.models.bid.refunded = true; f.models.bid.amount = 1n; }], ['bump', f => { f.models.bid.bump ^= 1; }],
  ];
  for (const [label, mutate] of bidDefects) it(`refuses Bid ${label}`, async () => { const f = fixture(); mutate(f); await expect(f.decode('bid')).rejects.toThrow(); });
  for (const [name, offset] of [['term', 113], ['term', 174], ['term', 175], ['auction', 220], ['auction', 229], ['auction', 230], ['auction', 231], ['auction', 232], ['bid', 81]] as const) {
    it(`refuses noncanonical ${name} boolean/Option tag at ${offset}`, async () => {
      const f = fixture(), raw = await f.pack(name), data = Buffer.from(raw.data); data[offset] = 2;
      await expect(f.decode(name, { ...raw, data })).rejects.toThrow();
    });
  }
});

describe('SA-0 T6: bidding round, not operating round', () => {
  const cases: [string, (f: Fixture) => bigint, bigint][] = [
    ['before the first window', f => f.firstStart - f.auctionSec - 1n, 0n],
    ['at the first window opening', f => f.firstStart - f.auctionSec, 0n],
    ['inside the first window', f => f.firstStart - 1n, 0n],
    ['at round-zero auction end', f => f.firstStart, 1n],
    ['between windows', f => f.firstStart + 1n, 1n],
    ['at next window opening', f => f.firstStart + f.termSec - f.auctionSec, 1n],
    ['inside next window', f => f.firstStart + f.termSec - 1n, 1n],
    ['at next auction end', f => f.firstStart + f.termSec, 2n],
    ['during round-seven overlap', f => f.firstStart + 8n * f.termSec - f.auctionSec, 8n],
  ];
  for (const [label, now, expected] of cases) it(label, async () => {
    const f = fixture(), c = decodeSeekerAuctionConfig(program, await f.pack('config'));
    expect(seekerBiddingRoundAt(c, now(f))).toBe(expected);
  });
  it('refuses out-of-i64 clocks and selected calendar overflow', async () => {
    const f = fixture(), c = decodeSeekerAuctionConfig(program, await f.pack('config'));
    for (const now of [-(1n << 63n) - 1n, 1n << 63n, (1n << 63n) - 1n]) expect(() => seekerBiddingRoundAt(c, now)).toThrow();
  });
  it('refuses invalid/overflowing requested rounds before decoding a term', async () => {
    const f = fixture(), c = decodeSeekerAuctionConfig(program, await f.pack('config')), raw = await f.pack('term');
    for (const round of [-1n, 1n << 64n, (1n << 64n) - 1n]) expect(() => decodeSeekerLiveTerm(c, round, raw)).toThrow();
  });
});
