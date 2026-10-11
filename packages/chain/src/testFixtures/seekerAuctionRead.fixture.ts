/** Reusable SA-1/SA-2 synthetic RPC bank: actual IDL/SPL bytes, no semantic mocks. */
import { createHash } from 'node:crypto';
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms, seekerAuctionConfigPda, seekerAuctionPda,
  seekerAuthorityPda, seekerBidPda, seekerRegistryPda, seekerTermPda } from '../seekerAuctionProtocol';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Connection, type GetMultipleAccountsConfig } from '@solana/web3.js';
import idl from '../idl/shardkeep_economy.json' with { type: 'json' };

const { BorshAccountsCoder, BN } = anchorPkg, coder = new BorshAccountsCoder(idl as Idl);
const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
const program = new PublicKey(idl.address), pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), sysvarOwner = new PublicKey('Sysvar1111111111111111111111111111111111111');
const wallet = Keypair.fromSeed(Buffer.alloc(32, 1)).publicKey, other = Keypair.fromSeed(Buffer.alloc(32, 2)).publicKey;
const configAddress = seekerAuctionConfigPda(program), authorityAddress = seekerAuthorityPda(program), registryAddress = seekerRegistryPda(program);
const programDataAddress = PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0];
type Rpc = Pick<Connection, 'getGenesisHash' | 'getMultipleAccountsInfoAndContext'>;
type Account = AccountInfo<Buffer>;
const rawAccount = (data: Buffer, owner = program, executable = false): Account => ({ data, owner, executable, lamports: 1, rentEpoch: 0 });
const le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const bump = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[1];
function anchorValue(value: unknown): unknown {
  if (typeof value === 'bigint') return new BN(value.toString());
  if (value instanceof PublicKey || value === null) return value;
  if (Array.isArray(value)) return value.map(anchorValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anchorValue(v)]));
  return value;
}
export async function createSeekerAuctionFixture(options: { round?: bigint; biddingRound?: bigint; decimals?: number; firstStart?: bigint; paused?: boolean } = {}) {
  const round = options.round ?? 0n, biddingRound = options.biddingRound ?? round, decimals = options.decimals ?? 6;
  const mint = pk(201), prizeOwner = pk(202), upgradeAuthority = pk(203), genesis = pk(204);
  const termAddress = seekerTermPda(program, configAddress, round), ata = getAssociatedTokenAddressSync(mint, wallet);
  const prizeAta = getAssociatedTokenAddressSync(mint, prizeOwner, true), registry = canonicalSeekerRegistry(), registryHash = hashSeekerRegistry(registry);
  const firstStart = options.firstStart ?? 1_791_158_400n, termSec = BigInt(P.operatingTermSec), auctionSec = BigInt(P.overlappingAuctionSec);
  const operatingStart = firstStart + round * termSec, operatingEnd = operatingStart + termSec, auctionStart = operatingStart - auctionSec;
  const nowSec = biddingRound === 0n ? firstStart - 1n : firstStart + (biddingRound - 1n) * termSec + 1n;
  const openingBid = BigInt(A.openingBidSkr) * 10n ** BigInt(decimals), walletBalance = 1_234_567_890_123n;
  const full = Array(Math.ceil(P.totalSpots / 8)).fill(0) as number[];
  for (let i = 0; i < P.totalSpots; i++) full[i >> 3]! |= 1 << (i % 8);
  const models = {
    authority: { version: 1, admin: pk(220), pending_admin: null, guardian: pk(221), current_policy_key: pk(222),
      previous_policy_key: null, previous_valid_until: 0n, cluster_genesis: [...genesis.toBytes()], admission_paused: options.paused ?? false,
      bump: bump(Buffer.from('seeker_authority')) },
    config: { version: 1, authority: authorityAddress, registry: registryAddress, registry_hash: [...registryHash], registry_version: 1,
      mint, token_program: TOKEN_PROGRAM_ID, decimals, prize_owner: prizeOwner, prize_ata: prizeAta, prize_bps: A.prizeBps,
      opening_bid: openingBid, first_operating_start: firstStart, term_sec: termSec, auction_sec: auctionSec, grace_sec: BigInt(A.settlementGraceSec),
      auction_format: 1, terms_format: 1, bump: bump(Buffer.from('auction_config')) },
    registry: { version: 1, island: 1, entries: registry.map(r => ({ id: r.spotId, class: r.class, realm_mask: r.realmMask })),
      hash: [...registryHash], bump: bump(Buffer.from('seeker_registry')) },
    term: { version: 1, config: configAddress, registry: registryAddress, registry_hash: [...registryHash], round,
      previous: round === 0n ? null : seekerTermPda(program, configAddress, round - 1n), auction_start: auctionStart, auction_end: operatingStart,
      operating_start: operatingStart, operating_end: operatingEnd, opened: full, settled: full.map(() => 0), completed_count: 0, winner_count: 0,
      completed_at: null as bigint | null, completed_slot: null as bigint | null, bump: bump(Buffer.from('seeker_term'), configAddress.toBuffer(), le(round)) },
  };
  const store = new Map<string, Account>();
  const sizes = { SeekerAuthority: 213, AuctionConfig: 283, SeekerRegistry: 344, SeekerTerm: 225, Auction: 314, Bid: 83 } as const;
  async function pack(name: keyof typeof sizes, address: PublicKey, model: unknown) {
    const encoded = await coder.encode(name, anchorValue(model) as object), data = Buffer.alloc(sizes[name]);
    if (encoded.length > data.length) throw Error('Fixture exceeds canonical account allocation'); encoded.copy(data); store.set(address.toBase58(), rawAccount(data));
  }
  async function core() {
    await pack('SeekerAuthority', authorityAddress, models.authority); await pack('AuctionConfig', configAddress, models.config);
    await pack('SeekerRegistry', registryAddress, models.registry); await pack('SeekerTerm', termAddress, models.term);
  }
  await core();
  const auctionAddresses: PublicKey[] = [], bidAddresses: PublicKey[] = [];
  for (const spot of registry) {
    const auction = seekerAuctionPda(program, configAddress, spot.spotId, round), bid = seekerBidPda(program, auction, wallet);
    auctionAddresses.push(auction); bidAddresses.push(bid);
    const vault = getAssociatedTokenAddressSync(mint, auction, true), winner = spot.spotId === 0 ? other : spot.spotId === 1 ? wallet : null;
    const terms = { ...spot, config: configAddress, term: termAddress, auction, registry: registryAddress, registryHash, round, auctionStart,
      auctionEnd: operatingStart, operatingStart, operatingEnd, mint, tokenProgram: TOKEN_PROGRAM_ID, vault, prizeOwner, prizeAta,
      prizeBps: A.prizeBps, grace: BigInt(A.settlementGraceSec), openingBid, registryVersion: 1, auctionFormat: 1, termsFormat: 1 };
    await pack('Auction', auction, { version: 1, config: configAddress, term: termAddress, registry: registryAddress,
      spot: { id: spot.spotId, class: spot.class, realm_mask: spot.realmMask }, round, auction_start: auctionStart, auction_end: operatingStart,
      operating_start: operatingStart, operating_end: operatingEnd, terms_hash: [...hashSeekerAuctionTerms(terms)], vault,
      high_bid: winner ? openingBid * 2n : 0n, high_bidder: winner,
      outstanding_escrow: spot.spotId === 0 ? openingBid * 3n : winner ? openingBid * 2n : 0n,
      settled: false, result_owner: null, settled_at: null, settled_slot: null,
      bump: bump(Buffer.from('auction'), configAddress.toBuffer(), Buffer.of(spot.spotId), le(round)) });
    if (winner) await pack('Bid', bid, { version: 1, auction, wallet, amount: openingBid * (spot.spotId === 0 ? 1n : 2n), refunded: false,
      bump: bump(Buffer.from('bid'), auction.toBuffer(), wallet.toBuffer()) });
  }
  const programData = Buffer.alloc(49); programData.writeUInt32LE(3); programData.writeBigUInt64LE(100n, 4);
  programData[12] = 1; upgradeAuthority.toBuffer().copy(programData, 13); programData.fill(7, 45);
  const programBytes = Buffer.alloc(36); programBytes.writeUInt32LE(2); programDataAddress.toBuffer().copy(programBytes, 4);
  store.set(program.toBase58(), rawAccount(programBytes, loader, true)); store.set(programDataAddress.toBase58(), rawAccount(programData, loader));
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(2000n); clock.writeBigInt64LE(nowSec, 32);
  store.set(SYSVAR_CLOCK_PUBKEY.toBase58(), rawAccount(clock, sysvarOwner));
  const mintData = Buffer.alloc(MintLayout.span); MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default,
    supply: walletBalance * 10n, decimals, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  store.set(mint.toBase58(), rawAccount(mintData, TOKEN_PROGRAM_ID));
  const tokenData = Buffer.alloc(AccountLayout.span); AccountLayout.encode({ mint, owner: wallet, amount: walletBalance, delegateOption: 0,
    delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default }, tokenData);
  store.set(ata.toBase58(), rawAccount(tokenData, TOKEN_PROGRAM_ID));
  const trust = { programId: program.toBase58(), genesisHash: genesis.toBase58(), mint: mint.toBase58(), prizeOwner: prizeOwner.toBase58(), decimals,
    deploymentSlot: 100, programDataSha256: createHash('sha256').update(programData).digest('hex'),
    upgradeAuthority: upgradeAuthority.toBase58() as string | null, stateProvenance: 'fresh-reviewed-deployment' as const };
  const calls: { keys: string[]; options: GetMultipleAccountsConfig }[] = [];
  const controls = { genesisHash: genesis.toBase58(), failGenesis: false, failAccounts: false, shortResponse: false,
    slotForCall: (_call: number) => 2000, afterRead: (_call: number, _addresses: readonly PublicKey[]) => {} };
  const rpc: Rpc = {
    getGenesisHash: async () => { if (controls.failGenesis) throw Error('fixture genesis transport failure'); return controls.genesisHash; },
    getMultipleAccountsInfoAndContext: async (addresses, opts) => {
      const options = typeof opts === 'string' ? { commitment: opts } : opts ?? {};
      calls.push({ keys: addresses.map(a => a.toBase58()), options });
      if (controls.failAccounts) throw Error('fixture account transport failure');
      if (addresses.length > 100) throw Error('provider request exceeds the Solana 100-account limit');
      const value = addresses.map(a => { const row = store.get(a.toBase58()); return row ? { ...row, data: Buffer.from(row.data) } : null; });
      if (controls.shortResponse) value.pop();
      controls.afterRead(calls.length, addresses);
      return { context: { slot: controls.slotForCall(calls.length) }, value };
    },
  };
  const source = { trust, connect: (signal: AbortSignal): Rpc => { signal.throwIfAborted(); return rpc; } };
  function account(address: PublicKey): Account { const row = store.get(address.toBase58()); if (!row) throw Error('missing fixture account'); return row; }
  function hashProgramData() { trust.programDataSha256 = createHash('sha256').update(account(programDataAddress).data).digest('hex'); }
  return { source, store, calls, controls, models, core, pack, account, hashProgramData, mint, prizeOwner, ata, termAddress, auctionAddresses,
    bidAddresses, firstStart, nowSec, round, biddingRound, openingBid, walletBalance, operatingStart, operatingEnd, auctionStart };
}
export type SeekerAuctionFixture = Awaited<ReturnType<typeof createSeekerAuctionFixture>>;
export { program, wallet, other, configAddress, authorityAddress, registryAddress, programDataAddress, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };
export const seekerAuctionFixtureKey = pk;
