/** review 4dbfed12: wallet-filtered old refunds use real IDL bytes and a bounded
 * finalized RPC transport. No DB/index, semantic verifier mock or live RPC. */
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { SeekerAuctionRefundsPageSchema } from '@shardkeep/shared/seekerAuctionRefundsApi';
import { canonicalSeekerRegistry, hashSeekerAuctionTerms, seekerAuctionPda, seekerBidPda } from '@shardkeep/chain/seeker-auction-protocol';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { readSeekerAuctionRefunds } from '../src/seeker/auctionRefunds';
import { SEEKER_AUCTION_BANK_ADVANCE_MAX, SEEKER_AUCTION_NODE_BEHIND_RETRY_MAX } from '../src/seeker/auctionReadModel';
import { createSeekerAuctionFixture, type SeekerAuctionFixture, program, wallet, other, configAddress, registryAddress,
  TOKEN_PROGRAM_ID, seekerAuctionFixtureKey as pk } from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';

type ScanRow = { pubkey: PublicKey; account: ReturnType<SeekerAuctionFixture['account']> };
type ScanOptions = { commitment: 'finalized'; withContext: true; minContextSlot: number;
  filters: ({ dataSize: number } | { memcmp: { offset: number; bytes: string } })[] };
async function fixture(biddingRound = 10n) {
  const f = await createSeekerAuctionFixture({ round: 0n, biddingRound, paused: true });
  const scans: { program: string; options: ScanOptions }[] = [];
  const controls = { fail: false, behind: 0, slotForScan: (_call: number) => 2000, mutate: (rows: ScanRow[]): ScanRow[] => rows };
  const source = { trust: f.source.trust, connect: (signal: AbortSignal) => ({ ...f.source.connect(signal),
    getProgramAccounts: async (programKey: PublicKey, options: ScanOptions) => {
      signal.throwIfAborted(); scans.push({ program: programKey.toBase58(), options });
      if (controls.fail) throw Error('wallet-filtered RPC unavailable');
      // K-night-08: an Agave pool node below minContextSlot answers JSON-RPC -32016.
      if (controls.behind > 0 && controls.behind--) throw Object.assign(
        Error('failed to get accounts owned by program: Minimum context slot has not been reached'), { code: -32016 });
      // S6-S2 fixture correction: emulate the requested binary RPC filters rather
      // than silently supplying a preselected wallet set. Corruption injection
      // remains AFTER filtering, so fail-closed assertions still reach decoding.
      const rows = [...f.store.entries()].filter(([, row]) => row.owner.equals(programKey)
        && options.filters.every(filter => {
          if ('dataSize' in filter) return row.data.length === filter.dataSize;
          const bytes = Buffer.from(bs58.decode(filter.memcmp.bytes)), offset = filter.memcmp.offset;
          return row.data.subarray(offset, offset + bytes.length).equals(bytes);
        }))
        .map(([address, account]) => ({ pubkey: new PublicKey(address), account: { ...account, data: Buffer.from(account.data) } }));
      return { context: { slot: controls.slotForScan(scans.length) }, value: controls.mutate(rows) };
    },
  }) };
  return { ...f, source, scans, scanControls: controls };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (f: Fixture, request: unknown = {}, signal?: AbortSignal) => readSeekerAuctionRefunds(f.source, wallet.toBase58(), request, signal);
const R = PHASE_E_SEEKER_AUCTION_RUNTIME;

/** Distinct canonical Bid PDAs encoded by the real IDL, across old rounds.
 * Linked auction/term rows are intentionally absent: withdrawn history must be
 * excluded by the RPC filter before the candidate cap or linked-account reads. */
async function addBidHistory(f: Fixture, count: number, refunded: boolean): Promise<string[]> {
  const addresses: string[] = [], spotsPerRound = canonicalSeekerRegistry().length;
  for (let index = 0; index < count; index++) {
    const round = BigInt(Math.floor(index / spotsPerRound) + 1), spot = index % spotsPerRound;
    const auction = seekerAuctionPda(program, configAddress, spot, round), bid = seekerBidPda(program, auction, wallet);
    expect(round).toBeLessThan(f.biddingRound);
    await f.pack('Bid', bid, { version: 1, auction, wallet, amount: refunded ? 0n : f.openingBid, refunded,
      bump: PublicKey.findProgramAddressSync([Buffer.from('bid'), auction.toBuffer(), wallet.toBuffer()], program)[1] });
    const encoded = f.account(bid).data;
    expect(encoded).toHaveLength(83);
    expect(encoded[81]).toBe(refunded ? 1 : 0);
    addresses.push(bid.toBase58());
  }
  expect(new Set(addresses).size).toBe(count);
  return addresses;
}

async function addRefund(f: Fixture, spot: number, amount = f.openingBid, settled = false): Promise<void> {
  const entry = canonicalSeekerRegistry()[spot]!, auction = f.auctionAddresses[spot]!, bid = f.bidAddresses[spot]!;
  const terms = { ...entry, config: configAddress, term: f.termAddress, auction, registry: registryAddress,
    registryHash: Buffer.from(f.models.config.registry_hash), round: f.round, auctionStart: f.auctionStart,
    auctionEnd: f.operatingStart, operatingStart: f.operatingStart, operatingEnd: f.operatingEnd, mint: f.mint,
    tokenProgram: TOKEN_PROGRAM_ID, vault: getAssociatedTokenAddressSync(f.mint, auction, true), prizeOwner: f.prizeOwner,
    prizeAta: f.models.config.prize_ata, prizeBps: f.models.config.prize_bps, grace: f.models.config.grace_sec,
    openingBid: f.openingBid, registryVersion: 1, auctionFormat: 1, termsFormat: 1 };
  const round = Buffer.alloc(8); round.writeBigUInt64LE(f.round);
  const bump = PublicKey.findProgramAddressSync([Buffer.from('auction'), configAddress.toBuffer(), Buffer.of(spot), round], program)[1];
  await f.pack('Auction', auction, { version: 1, config: configAddress, term: f.termAddress, registry: registryAddress,
    spot: { id: spot, class: entry.class, realm_mask: entry.realmMask }, round: f.round, auction_start: f.auctionStart,
    auction_end: f.operatingStart, operating_start: f.operatingStart, operating_end: f.operatingEnd,
    terms_hash: [...hashSeekerAuctionTerms(terms)], vault: terms.vault, high_bid: amount + f.openingBid, high_bidder: other,
    outstanding_escrow: settled ? amount : amount * 2n + f.openingBid, settled,
    result_owner: settled ? other : null, settled_at: settled ? f.operatingStart + f.models.config.grace_sec : null,
    settled_slot: settled ? 2000n : null, bump });
  await f.pack('Bid', bid, { version: 1, auction, wallet, amount, refunded: false,
    bump: PublicKey.findProgramAddressSync([Buffer.from('bid'), auction.toBuffer(), wallet.toBuffer()], program)[1] });
}

describe('bounded finalized wallet Seeker refunds', () => {
  it('keeps a losing escrow older than four rounds visible and actionable while paused', async () => {
    const f = await fixture(), result = await read(f);
    expect(f.biddingRound - f.round).toBeGreaterThan(BigInt(R.readRoundsBack));
    expect(result).toMatchObject({ version: 1, source: 'chain', wallet: wallet.toBase58(), observedSlot: '2000',
      chainUnixTime: f.nowSec.toString(), programId: program.toBase58(), config: configAddress.toBase58(),
      mint: f.mint.toBase58(), decimals: 6, nextCursor: null });
    expect(result.entries).toEqual([{ bid: f.bidAddresses[0]!.toBase58(), auction: f.auctionAddresses[0]!.toBase58(),
      round: '0', spot: 0, amountRaw: f.openingBid.toString() }]);
    expect(SeekerAuctionRefundsPageSchema.parse(result)).toEqual(result);
  });
  it('S6-S2 uses exactly wallet/83-byte/unrefunded filters and bounded linked reads', async () => {
    const f = await fixture(); await read(f);
    expect(f.scans).toHaveLength(1); expect(f.scans[0]).toEqual({ program: program.toBase58(), options: {
      commitment: 'finalized', withContext: true, minContextSlot: 2000,
      filters: [{ dataSize: 83 }, { memcmp: { offset: 41, bytes: wallet.toBase58() } },
        { memcmp: { offset: 81, bytes: '1' } }],
    } });
    // Base58 "1" encodes the single zero byte, not the ASCII digit or true.
    expect([...bs58.decode('1')]).toEqual([0]);
    for (const call of f.calls) { expect(call.keys.length).toBeLessThanOrEqual(100); expect(call.options.commitment).toBe('finalized'); }
    const queried = new Set(f.calls.flatMap(call => call.keys));
    expect(queried.has(f.termAddress.toBase58())).toBe(true);
    expect(queried.has(f.auctionAddresses[0]!.toBase58())).toBe(true);
    // The wallet scan is not permission to fetch every spot in every past round.
    expect(queried.has(f.auctionAddresses[99]!.toBase58())).toBe(false);
  });
  it('excludes current leaders, refunded bids and zero escrow without hiding a valid loser', async () => {
    const f = await fixture(); await addRefund(f, 2); await addRefund(f, 3);
    f.account(f.bidAddresses[2]!).data.writeBigUInt64LE(0n, 73); f.account(f.bidAddresses[2]!).data[81] = 1;
    f.account(f.bidAddresses[3]!).data.writeBigUInt64LE(0n, 73);
    expect((await read(f)).entries.map(row => row.spot)).toEqual([0]);
  });
  it('keeps escrow above Number.MAX_SAFE_INTEGER exact and proves the losing backing', async () => {
    const f = await fixture(); await addRefund(f, 2, 9_007_199_254_740_993n);
    expect((await read(f)).entries.find(row => row.spot === 2)?.amountRaw).toBe('9007199254740993');
    f.account(f.bidAddresses[2]!).data.writeBigUInt64LE((1n << 64n) - 1n, 73);
    await expect(read(f)).rejects.toThrow();
  });
  it('preserves an old losing refund after settlement and rejects future settlement proof', async () => {
    const f = await fixture(); await addRefund(f, 0, f.openingBid, true);
    f.models.term.settled[0]! |= 1; f.models.term.completed_count = 1; f.models.term.winner_count = 1; await f.core();
    expect((await read(f)).entries.map(row => row.spot)).toEqual([0]);
    const data = f.account(f.auctionAddresses[0]!).data;
    // A settled Auction has present highBidder/resultOwner/i64/u64 Options.
    data.writeBigUInt64LE(2001n, 305); await expect(read(f)).rejects.toThrow();
  });
  it('pages a complete bounded candidate vector by stable oldest-first keys', async () => {
    const f = await fixture(); for (let spot = 2; spot <= 27; spot++) await addRefund(f, spot);
    f.scanControls.mutate = rows => rows.reverse();
    const first = await read(f); expect(first.entries.map(row => row.spot)).toEqual([0, ...Array.from({ length: 24 }, (_, i) => i + 2)]);
    expect(first.nextCursor).toEqual({ round: '0', spot: 25 });
    // Each page is separately coherent. A later finalized root does not invalidate its keyset.
    f.controls.slotForCall = () => 2001; f.scanControls.slotForScan = () => 2001;
    const second = await read(f, { after: first.nextCursor });
    expect(second.observedSlot).toBe('2001'); expect(second.entries.map(row => row.spot)).toEqual([26, 27]); expect(second.nextCursor).toBeNull();
  });
  it('refuses malformed cursors before any transport and permits an empty terminal page', async () => {
    for (const request of [{ after: { round: '01', spot: 0 } }, { after: { round: '0', spot: 100 } }, { limit: 1024 }, { wallet: other.toBase58() }]) {
      const f = await fixture(); await expect(read(f, request)).rejects.toThrow(); expect(f.calls).toHaveLength(0); expect(f.scans).toHaveLength(0);
    }
    const f = await fixture(); expect((await read(f, { after: { round: '0', spot: 99 } })).entries).toEqual([]);
  });
  it('S6-S2 keeps candidate overflow fail-closed after filtering (original cap assertion retained)', async () => {
    const f = await fixture(); f.scanControls.mutate = rows => Array.from({ length: 1025 }, () => rows[0]!);
    await expect(read(f)).rejects.toThrow(/^Seeker auction refunds unavailable: candidate cap exceeded$/);
  });
  it('S6-S2 discovers one live old refund after more than 1024 withdrawn Bid accounts', async () => {
    const f = await fixture(12n), history = await addBidHistory(f, R.refundBidCandidateMax + 1, true);
    const result = await read(f);
    expect(history.length).toBeGreaterThan(1024);
    expect(result.entries).toEqual([{ bid: f.bidAddresses[0]!.toBase58(), auction: f.auctionAddresses[0]!.toBase58(),
      round: '0', spot: 0, amountRaw: f.openingBid.toString() }]);
    expect(result.nextCursor).toBeNull();
    const queried = new Set(f.calls.flatMap(call => call.keys));
    for (const address of history) {
      const row = f.store.get(address)!;
      expect(queried.has(new PublicKey(row.data.subarray(9, 41)).toBase58())).toBe(false);
    }
  });
  it('S6-S2 still refuses more than 1024 distinct outstanding Bid candidates', async () => {
    const f = await fixture(12n); await addBidHistory(f, R.refundBidCandidateMax + 1, false);
    await expect(read(f)).rejects.toThrow(/^Seeker auction refunds unavailable: candidate cap exceeded$/);
  });
  it('fails closed if any candidate is corrupt, including a row outside the requested page', async () => {
    const mutations: ((row: ScanRow) => void)[] = [
      row => { row.account.owner = TOKEN_PROGRAM_ID; }, row => { row.account.executable = true; },
      row => { row.account.data[0]! ^= 1; }, row => { row.account.data[8] = 2; },
      row => { row.account.data = Buffer.concat([row.account.data, Buffer.of(0)]); },
      row => { row.pubkey = pk(240); }, row => { other.toBuffer().copy(row.account.data, 41); },
      row => { row.account.data[82]! ^= 1; }, row => { row.account.data[81] = 2; },
      row => { row.account.data[81] = 1; }, row => { pk(240).toBuffer().copy(row.account.data, 9); },
    ];
    for (const mutate of mutations) {
      const f = await fixture(); f.scanControls.mutate = rows => { mutate(rows[0]!); return rows; };
      await expect(read(f, { after: { round: '0', spot: 99 } })).rejects.toThrow();
    }
  });
  it('refuses duplicate candidate identities instead of counting a refund twice', async () => {
    const f = await fixture(); f.scanControls.mutate = rows => [...rows, rows[0]!]; await expect(read(f)).rejects.toThrow();
  });
  it('rejects missing or corrupt linked Auction/term/config and unbacked escrow', async () => {
    const mutations: ((f: Fixture) => void | Promise<void>)[] = [
      f => { f.store.delete(f.auctionAddresses[0]!.toBase58()); }, f => { f.store.delete(f.termAddress.toBase58()); },
      f => { f.account(f.auctionAddresses[0]!).owner = TOKEN_PROGRAM_ID; },
      f => { pk(240).toBuffer().copy(f.account(f.auctionAddresses[0]!).data, 9); },
      f => { pk(240).toBuffer().copy(f.account(f.auctionAddresses[0]!).data, 41); },
      f => { f.account(f.auctionAddresses[0]!).data[105] = 99; },
      f => { f.account(f.auctionAddresses[0]!).data[148]! ^= 1; },
      f => { f.account(f.termAddress).data[0]! ^= 1; },
      f => { f.account(configAddress).data[0]! ^= 1; },
      f => { f.account(f.bidAddresses[0]!).data.writeBigUInt64LE(f.openingBid * 2n, 73); },
    ];
    for (const mutate of mutations) { const f = await fixture(); await mutate(f); await expect(read(f)).rejects.toThrow(); }
  });
  it('validates deployment/genesis and every linked account before claiming there are no refunds', async () => {
    const f = await fixture(); f.scanControls.mutate = () => []; f.source.trust.programDataSha256 = '0'.repeat(64);
    await expect(read(f)).rejects.toThrow();
    const g = await fixture(); g.scanControls.mutate = () => []; g.controls.failGenesis = true; await expect(read(g)).rejects.toThrow();
  });
  it('never turns a missing scan capability or scan/linked-read transport failure into an empty page', async () => {
    const f = await fixture(); f.scanControls.fail = true; await expect(read(f)).rejects.toThrow();
    const g = await fixture(); g.controls.failAccounts = true; await expect(read(g)).rejects.toThrow();
    const h = await createSeekerAuctionFixture(); await expect(readSeekerAuctionRefunds(h.source, wallet.toBase58(), {})).rejects.toThrow();
  });
  // Rewritten 2026-10-10 (K-night-08): a forward root movement re-validates the admitted bank at
  // the scan's slot and re-runs the scan there (a set query is asked again, never merged across
  // slots); repeated movement is bounded by SEEKER_AUCTION_BANK_ADVANCE_MAX instead of three restarts.
  it('re-runs the entire scan on a re-validated bank after a forward finalized-root movement and bounds repeated movement', async () => {
    const f = await fixture(); f.controls.slotForCall = call => call === 1 ? 2000 : 2001; f.scanControls.slotForScan = () => 2001;
    expect((await read(f)).observedSlot).toBe('2001'); expect(f.scans).toHaveLength(2);
    expect(f.scans[1]!.options.minContextSlot).toBe(2001); expect(f.calls[1]!.options.minContextSlot).toBe(2001);
    const g = await fixture(); g.controls.slotForCall = call => 2000 + call; g.scanControls.slotForScan = call => 2001 + call;
    await expect(read(g)).rejects.toThrow('finalized bank keeps moving'); expect(g.scans).toHaveLength(SEEKER_AUCTION_BANK_ADVANCE_MAX + 1);
  });
  it('asks the wallet scan again, bounded, while a pool node is still below the bank slot (K-night-08)', async () => {
    const f = await fixture(); f.scanControls.behind = 2;
    expect((await read(f)).observedSlot).toBe('2000'); expect(f.scans).toHaveLength(3);
    for (const scan of f.scans) expect(scan.options.minContextSlot).toBe(2000);
    const g = await fixture(); g.scanControls.behind = SEEKER_AUCTION_NODE_BEHIND_RETRY_MAX + 1;
    await expect(read(g)).rejects.toThrow('Minimum context slot has not been reached');
    expect(g.scans).toHaveLength(SEEKER_AUCTION_NODE_BEHIND_RETRY_MAX + 1);
  });
  it('refuses unsafe or regressing scan contexts and cancellation without returning partial evidence', async () => {
    for (const slot of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1999]) {
      const f = await fixture(); f.scanControls.slotForScan = () => slot; await expect(read(f)).rejects.toThrow();
    }
    const f = await fixture(), cancel = new AbortController(); cancel.abort();
    await expect(read(f, {}, cancel.signal)).rejects.toThrow(); expect(f.scans).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
});
