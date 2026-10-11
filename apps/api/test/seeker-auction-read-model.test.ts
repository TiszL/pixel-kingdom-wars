/** SA-1/T11: real IDL/SPL bytes behind an injected read-only RPC transport.
 * No database, local validator, network, or semantic verifier mock is involved. */
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { SeekerAuctionRoundViewSchema } from '@shardkeep/shared/seekerAuctionApi';
import { SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { readSeekerAuctionRound, SEEKER_AUCTION_BANK_ADVANCE_MAX } from '../src/seeker/auctionReadModel';
import { createSeekerAuctionFixture as fixture, type SeekerAuctionFixture as Fixture, program, wallet, other,
  configAddress, authorityAddress, registryAddress, programDataAddress, seekerAuctionFixtureKey as pk, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';
const P = PHASE_E_POLICY.seekerIsland, R = PHASE_E_SEEKER_AUCTION_RUNTIME;
const read = (f: Fixture, round?: bigint, signal?: AbortSignal) => readSeekerAuctionRound(f.source, wallet.toBase58(), round, signal);

describe('SA-1 T11 finalized Seeker auction read model', () => {
  it('takes calendar, decimals, opening bid and wallet amounts from decoded chain accounts', async () => {
    const f = await fixture({ decimals: 9, firstStart: 1_791_158_400n + 604800n }), result = await read(f);
    expect(result.view.config).toMatchObject({ mint: f.mint.toBase58(), decimals: 9, openingBidRaw: f.openingBid.toString(),
      firstOperatingStart: f.firstStart.toString(), termSec: String(P.operatingTermSec), auctionSec: String(P.overlappingAuctionSec) });
    expect(result).toMatchObject({ nowSec: f.nowSec, slot: 2000, walletAta: { address: f.ata.toBase58(), amount: f.walletBalance } });
    expect(result.view).toMatchObject({ round: '0', biddingRound: '0', observedSlot: '2000', openedCount: 100,
      auctionStart: f.auctionStart.toString(), auctionEnd: f.operatingStart.toString(), operatingEnd: f.operatingEnd.toString() });
    expect(result.auctions).toHaveLength(100); expect(result.bids).toHaveLength(100); expect(result.term?.round).toBe(0n);
    expect(result.view.spots[0]).toMatchObject({ highBidder: other.toBase58(), highBidRaw: (f.openingBid * 2n).toString(), yourBidRaw: f.openingBid.toString(), refundable: true });
    expect(result.view.spots[1]).toMatchObject({ highBidder: wallet.toBase58(), yourBidRaw: (f.openingBid * 2n).toString(), refundable: false });
    expect(SeekerAuctionRoundViewSchema.parse(result.view)).toEqual(result.view);
  });
  it('uses finalized bounded batches, a nondecreasing context floor, and the actual Clock', async () => {
    const f = await fixture(); await read(f);
    expect(f.calls.length).toBeGreaterThan(2);
    for (const [index, call] of f.calls.entries()) {
      expect(call.options.commitment).toBe('finalized'); expect(call.keys.length).toBeLessThanOrEqual(100);
      if (index > 0) expect(call.options.minContextSlot).toBe(2000);
    }
    const queried = new Set(f.calls.flatMap(c => c.keys));
    for (const address of [program, programDataAddress, SYSVAR_CLOCK_PUBKEY, authorityAddress, configAddress, registryAddress, f.mint, f.termAddress,
      f.ata, ...f.auctionAddresses, ...f.bidAddresses]) expect(queried.has(address.toBase58())).toBe(true);
  });
  it('keeps loser refunds visible while admission is paused', async () => {
    const f = await fixture({ paused: true }), result = await read(f);
    expect(result.view.admissionPaused).toBe(true); expect(result.view.spots[0]!.refundable).toBe(true);
  });
  it('selects the next bidding round during the operating gap and supports a bounded past round explicitly', async () => {
    const current = await fixture({ round: 5n, biddingRound: 5n }); expect((await read(current)).view.round).toBe('5');
    const historical = await fixture({ round: 3n, biddingRound: 5n }), result = await read(historical, 3n);
    expect(result.view).toMatchObject({ round: '3', biddingRound: '5' }); expect(result.term?.round).toBe(3n);
  });
  it('includes exactly the configured oldest refundable round and refuses older/future rounds', async () => {
    const bidding = BigInt(R.readRoundsBack) + 2n, earliest = bidding - BigInt(R.readRoundsBack);
    const f = await fixture({ round: earliest, biddingRound: bidding }); expect((await read(f, earliest)).view.round).toBe(earliest.toString());
    for (const bad of [earliest - 1n, bidding + 1n, -1n, 1n << 64n]) await expect(read(f, bad)).rejects.toThrow();
  });
  it('represents a genuinely absent term only after proving its auction and wallet-Bid PDAs absent', async () => {
    const f = await fixture(); f.store.delete(f.termAddress.toBase58());
    for (const address of [...f.auctionAddresses, ...f.bidAddresses]) f.store.delete(address.toBase58());
    const result = await read(f);
    expect(result.term).toBeNull(); expect(result.auctions.every(a => a === null)).toBe(true); expect(result.bids.every(b => b === null)).toBe(true);
    expect(result.view.openedCount).toBe(0); expect(result.view.spots).toHaveLength(100);
    expect(result.view.spots.every(s => !s.opened && !s.settled && s.highBidRaw === '0' && s.yourBidRaw === '0' && !s.refundable)).toBe(true);
    const queried = new Set(f.calls.flatMap(c => c.keys));
    for (const address of [...f.auctionAddresses, ...f.bidAddresses]) expect(queried.has(address.toBase58())).toBe(true);
  });
  it('accepts unopened bits with absent auctions, missing unused Bid accounts, and an absent wallet ATA', async () => {
    const f = await fixture(); f.models.term.opened[12]! &= ~(1 << 3); await f.core();
    f.store.delete(f.auctionAddresses[99]!.toBase58()); f.store.delete(f.ata.toBase58());
    const result = await read(f); expect(result.view.openedCount).toBe(99); expect(result.auctions[99]).toBeNull();
    expect(result.bids[99]).toBeNull(); expect(result.walletAta).toBeNull(); expect(result.view.spots[99]!.opened).toBe(false);
  });
  it('never falls back to unopened/zero state after genesis or account transport failure', async () => {
    for (const field of ['failGenesis', 'failAccounts'] as const) { const f = await fixture(); f.controls[field] = true; await expect(read(f)).rejects.toThrow(); }
  });
  it('passes cancellation to the connector and refuses a cancelled read', async () => {
    const f = await fixture(), controller = new AbortController(); controller.abort();
    await expect(read(f, undefined, controller.signal)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  const trustDefects: [string, (f: Fixture) => void][] = [
    ['genesis', f => { f.controls.genesisHash = pk(240).toBase58(); }],
    ['retained unreviewed state', f => { f.source.trust.stateProvenance = 'retained' as never; }],
    ['mint registry pin', f => { f.source.trust.mint = pk(240).toBase58(); }],
    ['prize owner pin', f => { f.source.trust.prizeOwner = pk(240).toBase58(); }],
    ['decimal pin', f => { f.source.trust.decimals++; }],
    ['deployment slot pin', f => { f.source.trust.deploymentSlot++; }],
    ['deployment hash pin', f => { f.source.trust.programDataSha256 = '0'.repeat(64); }],
    ['upgrade authority pin', f => { f.source.trust.upgradeAuthority = pk(240).toBase58(); }],
    ['revoked authority pin', f => { f.source.trust.upgradeAuthority = null; }],
  ];
  for (const [label, mutate] of trustDefects) it(`refuses wrong ${label}`, async () => { const f = await fixture(); mutate(f); await expect(read(f)).rejects.toThrow(); });
  for (const name of ['program', 'programData', 'authority', 'config', 'registry', 'mint', 'clock'] as const) {
    it(`refuses missing required ${name}`, async () => {
      const f = await fixture(), address = { program, programData: programDataAddress, authority: authorityAddress, config: configAddress,
        registry: registryAddress, mint: f.mint, clock: SYSVAR_CLOCK_PUBKEY }[name];
      f.store.delete(address.toBase58()); await expect(read(f)).rejects.toThrow();
    });
  }
  const byteDefects: [string, (f: Fixture) => void | Promise<void>][] = [
    ['Program owner', f => { f.account(program).owner = program; }], ['Program executable', f => { f.account(program).executable = false; }],
    ['ProgramData link', f => { pk(240).toBuffer().copy(f.account(program).data, 4); }],
    ['ProgramData owner', f => { f.account(programDataAddress).owner = program; }], ['ProgramData executable', f => { f.account(programDataAddress).executable = true; }],
    ['ProgramData tag', f => { f.account(programDataAddress).data.writeUInt32LE(2); f.hashProgramData(); }],
    ['ProgramData future deployment', f => { f.account(programDataAddress).data.writeBigUInt64LE(2001n, 4); f.source.trust.deploymentSlot = 2001; f.hashProgramData(); }],
    ['authority genesis', async f => { f.models.authority.cluster_genesis = [...pk(240).toBytes()]; await f.core(); }],
    ['authority boolean', f => { f.account(authorityAddress).data[147] = 2; }],
    ['registry mapping', async f => { f.models.registry.entries[20]!.realm_mask ^= 1; await f.core(); }],
    ['registry hash', async f => { f.models.registry.hash[0]! ^= 1; await f.core(); }],
    ['registry owner', f => { f.account(registryAddress).owner = TOKEN_PROGRAM_ID; }],
    ['registry discriminator', f => { f.account(registryAddress).data[0]! ^= 1; }],
    ['classic mint owner', f => { f.account(f.mint).owner = TOKEN_2022_PROGRAM_ID; }],
    ['classic mint decimals', f => { f.account(f.mint).data[44]!++; }],
    ['uninitialized mint', f => { f.account(f.mint).data[45] = 0; }],
    ['mint extension bytes', f => { f.account(f.mint).data = Buffer.concat([f.account(f.mint).data, Buffer.of(0)]); }],
    ['Clock owner', f => { f.account(SYSVAR_CLOCK_PUBKEY).owner = program; }],
    ['Clock executable', f => { f.account(SYSVAR_CLOCK_PUBKEY).executable = true; }],
    ['Clock size', f => { f.account(SYSVAR_CLOCK_PUBKEY).data = Buffer.alloc(39); }],
    ['Clock above finalized context', f => { f.account(SYSVAR_CLOCK_PUBKEY).data.writeBigUInt64LE(2001n); }],
    ['wallet ATA program', f => { f.account(f.ata).owner = TOKEN_2022_PROGRAM_ID; }],
    ['wallet ATA mint', f => { pk(240).toBuffer().copy(f.account(f.ata).data, 0); }],
    ['wallet ATA owner', f => { other.toBuffer().copy(f.account(f.ata).data, 32); }],
    ['wallet ATA frozen', f => { f.account(f.ata).data[108] = 2; }],
    ['wallet ATA size', f => { f.account(f.ata).data = Buffer.alloc(164); }],
    ['Auction config link', f => { pk(240).toBuffer().copy(f.account(f.auctionAddresses[0]!).data, 9); }],
    ['Auction owner', f => { f.account(f.auctionAddresses[0]!).owner = TOKEN_PROGRAM_ID; }],
    ['Bid wallet link', f => { other.toBuffer().copy(f.account(f.bidAddresses[0]!).data, 41); }],
    ['Bid auction link', f => { f.auctionAddresses[1]!.toBuffer().copy(f.account(f.bidAddresses[0]!).data, 9); }],
    ['Bid owner', f => { f.account(f.bidAddresses[0]!).owner = TOKEN_PROGRAM_ID; }],
  ];
  for (const [label, mutate] of byteDefects) it(`refuses ${label}`, async () => { const f = await fixture(); await mutate(f); await expect(read(f)).rejects.toThrow(); });
  it('accepts an explicitly reviewed immutable deployment with revoked upgrade authority', async () => {
    const f = await fixture(); f.account(programDataAddress).data[12] = 0; f.source.trust.upgradeAuthority = null; f.hashProgramData();
    expect((await read(f)).view.openedCount).toBe(100);
  });
  it('refuses contradictions between proven absence and term/auction/Bid state', async () => {
    const termMissing = await fixture(); termMissing.store.delete(termMissing.termAddress.toBase58()); await expect(read(termMissing)).rejects.toThrow();
    const auctionMissing = await fixture(); auctionMissing.store.delete(auctionMissing.auctionAddresses[0]!.toBase58()); await expect(read(auctionMissing)).rejects.toThrow();
    const unexpectedAuction = await fixture(); unexpectedAuction.models.term.opened[0]! &= ~1; await unexpectedAuction.core(); await expect(read(unexpectedAuction)).rejects.toThrow();
    const orphanBid = await fixture(); orphanBid.models.term.opened[0]! &= ~1; await orphanBid.core();
    orphanBid.store.delete(orphanBid.auctionAddresses[0]!.toBase58()); await expect(read(orphanBid)).rejects.toThrow();
  });
  it('refuses short response vectors, unsafe contexts and context regression', async () => {
    const short = await fixture(); short.controls.shortResponse = true; await expect(read(short)).rejects.toThrow();
    for (const slot of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) { const f = await fixture(); f.controls.slotForCall = () => slot; await expect(read(f)).rejects.toThrow(); }
    for (const laterSlot of [1999]) { const f = await fixture(); f.controls.slotForCall = call => call === 1 ? 2000 : laterSlot; await expect(read(f)).rejects.toThrow(); }
  });
  // design review B2 F1 successor, rewritten 2026-10-10 for K-night-08: a root movement used to restart
  // every batch, which never converged on a multi-node pool (Helius, the production RPC). Now every
  // admitted account plus the batch that moved is re-read once at the new floor, and the bank adopts
  // that slot only if nothing changed (seeker-auction-read-pool.test.ts). Mixed banks still never escape.
  it('re-validates the admitted evidence at the new floor after one finalized-slot advance and adopts it',async()=>{
    const f=await fixture();f.controls.slotForCall=call=>call===1?2000:2001;
    const result=await read(f);expect(result.slot).toBe(2001);expect(result.view.observedSlot).toBe('2001');
    // core@2000, term+ATA@2001 (moved), ONE re-validation of core+term+ATA@2001, then auctions and Bids.
    expect(f.calls).toHaveLength(5);expect(f.calls[2]!.keys).toEqual([...f.calls[0]!.keys,...f.calls[1]!.keys]);
    for(const call of f.calls.slice(2))expect(call.options.minContextSlot).toBe(2001);
  });
  // Rewritten 2026-10-10 (K-night-08): the bound is now SEEKER_AUCTION_BANK_ADVANCE_MAX forward
  // movements per read (re-validations plus split re-validation rounds), under the same deadline.
  it('bounds continuous root movement by the forward-movement budget',async()=>{
    const f=await fixture();f.controls.slotForCall=call=>2000+call;
    await expect(read(f)).rejects.toThrow('finalized bank keeps moving');
    // core, term+ATA (moves), a one-batch re-validation (adopted), auctions (moves), then each
    // two-batch re-validation answers at two slots and spends one movement until none is left.
    expect(f.calls).toHaveLength(4+2*(SEEKER_AUCTION_BANK_ADVANCE_MAX-1));
  });
  it('does not retry account corruption or continue after cancellation during root movement',async()=>{
    const f=await fixture();f.account(program).owner=program;await expect(read(f)).rejects.toThrow();expect(f.calls).toHaveLength(1);
    const g=await fixture(),cancel=new AbortController();g.controls.slotForCall=call=>call===1?2000:2001;
    g.controls.afterRead=call=>{if(call===2)cancel.abort();};await expect(read(g,undefined,cancel.signal)).rejects.toThrow();expect(g.calls).toHaveLength(2);
  });
});
