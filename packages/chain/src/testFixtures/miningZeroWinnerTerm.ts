/** R1 injected chain fixture. Every account uses the real IDL and every synthetic
 * settlement is signed by a newly generated fixture key. No semantic verifier
 * is mocked; the injected RPC supplies finality, not a live-chain attestation. */
import { createHash } from 'node:crypto';
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, Keypair, SYSVAR_CLOCK_PUBKEY, TransactionMessage, VersionedTransaction,
  type AccountInfo, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import idl from '../idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms,
  seekerAuctionConfigPda, seekerAuctionPda, seekerAuthorityPda, seekerBidPda, seekerRegistryPda, seekerTermPda } from '../seekerAuctionProtocol';
import { SEEKER_TERM_ACCOUNT_BYTES } from '../seekerTermAccounts';
import type { ReviewedSeekerTermPolicy, SeekerTermRpc } from '../seekerTerms';

const { BorshAccountsCoder, BN } = anchorPkg;
const coder = new BorshAccountsCoder(idl as Idl);
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const sysvar = new PublicKey('Sysvar1111111111111111111111111111111111111');
const key = () => Keypair.generate().publicKey;
function anchorValue(value: unknown): unknown {
  if (typeof value === 'bigint') return new BN(value.toString());
  if (value instanceof PublicKey || value === null) return value;
  if (Array.isArray(value)) return value.map(anchorValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anchorValue(v)]));
  return value;
}
interface MiningTermFixtureInput {
  day: string; genesisHash: PublicKey; programId: PublicKey;
  programData?: Buffer; programDataAddress?: PublicKey; upgradeAuthority?: PublicKey | null;
  round?: bigint; firstOperatingStart?: bigint; mint?: PublicKey; prizeOwner?: PublicKey;
}
export async function createMiningZeroWinnerTermFixture(input: MiningTermFixtureInput) {
  return createMiningTermFixture({ ...input, winners: [] });
}
export async function createMiningTermFixture(input: MiningTermFixtureInput & {
  winners?: readonly { readonly spotId: number; readonly wallet: PublicKey }[];
}) {
  const { programId: program, genesisHash } = input, dayStart = BigInt(Date.parse(input.day + 'T00:00:00Z') / 1000);
  const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
  const requested = input.winners ?? [], winners = new Map<number, PublicKey>();
  if (!Array.isArray(requested) || requested.length > P.totalSpots) throw new Error('Invalid fixture winners');
  for (const winner of requested) {
    if (!Number.isInteger(winner.spotId) || winner.spotId < 0 || winner.spotId >= P.totalSpots || winners.has(winner.spotId)
      || !(winner.wallet instanceof PublicKey) || winner.wallet.equals(PublicKey.default)) throw new Error('Invalid fixture winners');
    winners.set(winner.spotId, new PublicKey(winner.wallet.toBytes()));
  }
  const round = input.round ?? 0n;
  if (round < 0n || round > (1n << 64n) - 1n) throw new Error('Invalid fixture round');
  const firstOperatingStart = input.firstOperatingStart ?? dayStart - BigInt(A.settlementGraceSec) - round * BigInt(P.operatingTermSec);
  const operatingStart = firstOperatingStart + round * BigInt(P.operatingTermSec), operatingEnd = operatingStart + BigInt(P.operatingTermSec);
  const auctionStart = operatingStart - BigInt(P.overlappingAuctionSec), completedAt = dayStart;
  const authority = seekerAuthorityPda(program), config = seekerAuctionConfigPda(program), registry = seekerRegistryPda(program);
  const term = seekerTermPda(program, config, round), mint = input.mint ?? key(), prizeOwner = input.prizeOwner ?? key();
  const prizeAta = getAssociatedTokenAddressSync(mint, prizeOwner, true), settler = Keypair.generate();
  const entries = canonicalSeekerRegistry(), registryHash = hashSeekerRegistry(entries);
  const decimals = 6, openingBid = BigInt(A.openingBidSkr) * 10n ** BigInt(decimals);
  const le = Buffer.alloc(8), bump = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[1];
  le.writeBigUInt64LE(round);
  const full = Array(Math.ceil(P.totalSpots / 8)).fill(0) as number[];
  for (let i = 0; i < P.totalSpots; i++) full[i >> 3]! |= 1 << (i % 8);
  const store = new Map<string, AccountInfo<Buffer>>();
  const account = (data: Buffer, owner = program, executable = false): AccountInfo<Buffer> => ({ data, owner, executable, lamports: 1, rentEpoch: 0 });
  async function pack(name: keyof typeof SEEKER_TERM_ACCOUNT_BYTES, address: PublicKey, model: unknown) {
    const encoded = await coder.encode(name, anchorValue(model) as object), data = Buffer.alloc(SEEKER_TERM_ACCOUNT_BYTES[name]);
    if (encoded.length > data.length) throw new Error('Fixture account exceeds canonical allocation');
    encoded.copy(data); store.set(address.toBase58(), account(data));
  }
  await pack('SeekerAuthority', authority, { version: 1, admin: settler.publicKey, pending_admin: null, guardian: key(),
    current_policy_key: key(), previous_policy_key: null, previous_valid_until: 0n, cluster_genesis: [...genesisHash.toBytes()],
    admission_paused: true, bump: bump(Buffer.from('seeker_authority')) });
  await pack('AuctionConfig', config, { version: 1, authority, registry, registry_hash: [...registryHash], registry_version: 1,
    mint, token_program: TOKEN_PROGRAM_ID, decimals, prize_owner: prizeOwner, prize_ata: prizeAta, prize_bps: A.prizeBps,
    opening_bid: openingBid, first_operating_start: firstOperatingStart, term_sec: BigInt(P.operatingTermSec),
    auction_sec: BigInt(P.overlappingAuctionSec), grace_sec: BigInt(A.settlementGraceSec), auction_format: 1, terms_format: 1,
    bump: bump(Buffer.from('auction_config')) });
  await pack('SeekerRegistry', registry, { version: 1, island: 1, entries: entries.map(e => ({ id: e.spotId, class: e.class, realm_mask: e.realmMask })),
    hash: [...registryHash], bump: bump(Buffer.from('seeker_registry')) });
  await pack('SeekerTerm', term, { version: 1, config, registry, registry_hash: [...registryHash], round,
    previous: round === 0n ? null : seekerTermPda(program, config, round - 1n),
    auction_start: auctionStart, auction_end: operatingStart, operating_start: operatingStart, operating_end: operatingEnd,
    opened: full, settled: full, completed_count: P.totalSpots, winner_count: winners.size, completed_at: completedAt,
    completed_slot: BigInt(1000 + P.totalSpots - 1), bump: bump(Buffer.from('seeker_term'), config.toBuffer(), le) });
  const bodies = new Map<string, VersionedTransactionResponse>(), history = new Map<string, string>();
  const layout = idl.instructions.find(i => i.name === 'settle_auction')!;
  for (const entry of entries) {
    const winner = winners.get(entry.spotId) ?? null;
    const auction = seekerAuctionPda(program, config, entry.spotId, round), vault = getAssociatedTokenAddressSync(mint, auction, true);
    const terms = { ...entry, config, term, auction, registry, registryHash, round, auctionStart,
      auctionEnd: operatingStart, operatingStart, operatingEnd, mint, tokenProgram: TOKEN_PROGRAM_ID, vault, prizeOwner,
      prizeAta, prizeBps: A.prizeBps, grace: BigInt(A.settlementGraceSec), openingBid, registryVersion: 1, auctionFormat: 1, termsFormat: 1 };
    const slot = 1000 + entry.spotId;
    await pack('Auction', auction, { version: 1, config, term, registry, spot: { id: entry.spotId, class: entry.class, realm_mask: entry.realmMask },
      round, auction_start: auctionStart, auction_end: operatingStart, operating_start: operatingStart, operating_end: operatingEnd,
      terms_hash: [...hashSeekerAuctionTerms(terms)], vault, high_bid: winner ? openingBid : 0n, high_bidder: winner, outstanding_escrow: 0n, settled: true,
      result_owner: winner, settled_at: completedAt, settled_slot: BigInt(slot),
      bump: bump(Buffer.from('auction'), config.toBuffer(), Buffer.from([entry.spotId]), le) });
    const winnerBid = winner ? seekerBidPda(program, auction, winner) : program;
    const accounts = [settler.publicKey, config, term, auction, mint, vault, prizeAta, winnerBid, TOKEN_PROGRAM_ID];
    const message = new TransactionMessage({ payerKey: settler.publicKey, recentBlockhash: key().toBase58(), instructions: [{
      programId: program, data: Buffer.from(layout.discriminator), keys: accounts.map((pubkey, i) => ({ pubkey,
        isSigner: 'signer' in layout.accounts[i]! && layout.accounts[i]!.signer === true,
        isWritable: (i !== 7 || winner !== null) && 'writable' in layout.accounts[i]! && layout.accounts[i]!.writable === true })) }] }).compileToLegacyMessage();
    const signed = new VersionedTransaction(message); signed.sign([settler]);
    const signatures = signed.signatures.map(s => bs58.encode(s)), signature = signatures[0]!;
    const transaction: VersionedTransactionResponse = { slot, blockTime: null, version: 'legacy', transaction: { message, signatures },
      meta: { err: null, fee: 5000, preBalances: [], postBalances: [], innerInstructions: [] } };
    bodies.set(signature, transaction); history.set(auction.toBase58(), signature);
  }
  const programDataAddress = input.programDataAddress ?? PublicKey.findProgramAddressSync([program.toBuffer()], loader)[0];
  const upgradeAuthority = input.upgradeAuthority === undefined ? settler.publicKey : input.upgradeAuthority;
  const programData = input.programData ? Buffer.from(input.programData) : Buffer.alloc(49);
  if (!input.programData) {
    programData.writeUInt32LE(3); programData.writeBigUInt64LE(100n, 4); programData[12] = upgradeAuthority ? 1 : 0;
    upgradeAuthority?.toBuffer().copy(programData, 13); programData.fill(7, 45);
  }
  const programBytes = Buffer.alloc(36); programBytes.writeUInt32LE(2); programDataAddress.toBuffer().copy(programBytes, 4);
  store.set(program.toBase58(), account(programBytes, loader, true)); store.set(programDataAddress.toBase58(), account(programData, loader));
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(2000n); clock.writeBigInt64LE(dayStart + 86_400n, 32);
  store.set(SYSVAR_CLOCK_PUBKEY.toBase58(), account(clock, sysvar));
  const policy: ReviewedSeekerTermPolicy = { programId: program, config, round, mint, prizeOwner, prizeAta, genesisHash,
    stateProvenance: 'fresh-reviewed-deployment', deployment: { programDataAddress: programDataAddress.toBase58(),
      programDataSha256: createHash('sha256').update(programData).digest('hex'), upgradeAuthority: upgradeAuthority?.toBase58() ?? null } };
  const rpc: SeekerTermRpc = {
    getGenesisHash: async () => genesisHash.toBase58(),
    getMultipleAccountsInfoAndContext: async addresses => ({ context: { slot: 2000 }, value: addresses.map(a => {
      const row = store.get(a.toBase58()); return row ? { ...row, data: Buffer.from(row.data) } : null;
    }) }),
    getSignaturesForAddress: async address => {
      const signature = history.get(address.toBase58()), tx = signature ? bodies.get(signature) : undefined;
      return signature && tx ? [{ signature, slot: tx.slot, err: tx.meta?.err ?? null, memo: null, confirmationStatus: 'finalized' }] : [];
    },
    // The production reader uses only the explicit versioned/full overloads.
    getTransaction: (async (signature: string) => bodies.get(signature) ?? null) as SeekerTermRpc['getTransaction'],
    getBlock: (async (slot: number) => ({ parentSlot: slot - 1, blockTime: null, blockhash: key().toBase58(), previousBlockhash: key().toBase58(),
      transactions: [...bodies.values()].filter(tx => tx.slot === slot) })) as unknown as SeekerTermRpc['getBlock'],
  };
  return { connect: (_signal: AbortSignal) => rpc, policy, store, bodies, rpc, programData, programDataAddress, upgradeAuthority };
}
