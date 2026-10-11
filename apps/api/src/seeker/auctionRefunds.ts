/** Wallet-scoped escrow discovery, review 4dbfed12. Solana's standard
 * getProgramAccounts has no native pagination. Read one wallet-filtered bounded
 * candidate vector, prove every candidate, then keyset-page the valid refunds.
 * Any overflow or incomplete evidence is unavailable, never an empty result. */
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { SeekerAuctionRefundsPageSchema, SeekerAuctionRefundsRequestSchema,
  type SeekerAuctionRefundEntry, type SeekerAuctionRefundsPage } from '@shardkeep/shared/seekerAuctionRefundsApi';
import { decodeSeekerLiveAuction, decodeSeekerLiveBid, decodeSeekerLiveTerm, SEEKER_BID_ACCOUNT_BYTES,
  type SeekerLiveBid, type SeekerLiveTerm, type SeekerRawAccount } from '@shardkeep/chain/seeker-auction-live';
import { seekerAuctionAccountHint } from '@shardkeep/chain/seeker-auction-instructions';
import { seekerTermPda } from '@shardkeep/chain/seeker-auction-protocol';
import { PublicKey } from '@solana/web3.js';
import { untilSeekerContextReached, withSeekerAuctionEvidenceBank, type SeekerAuctionEvidenceBank, type SeekerAuctionReadRpc,
  type SeekerAuctionReadSource } from './auctionReadModel';

const R = PHASE_E_SEEKER_AUCTION_RUNTIME;
// RPC protocol batch limit and immutable Bid v1 ABI offset, not game tuning.
const RPC_BATCH_MAX = 100, BID_WALLET_OFFSET = 41, BID_AUCTION_OFFSET = 9, BID_REFUNDED_OFFSET = 81;
interface ProgramAccountRow {
  readonly pubkey: PublicKey;
  readonly account: Readonly<{ owner: PublicKey; executable: boolean; data: Uint8Array }>;
}
/** A normal Connection supplies this capability. An injected source which does
 * not supply it is explicitly unavailable; no alternate scan or DB fallback. */
export interface SeekerAuctionRefundRpc extends SeekerAuctionReadRpc {
  getProgramAccounts?: (program: PublicKey, options: {
    commitment: 'finalized'; withContext: true; minContextSlot: number;
    filters: ({ dataSize: number } | { memcmp: { offset: number; bytes: string } })[];
  }) => Promise<{ context: { slot: number }; value: readonly ProgramAccountRow[] }>;
}
function need(value: unknown, label: string): asserts value {
  if (!value) throw new Error(`Seeker auction refunds unavailable: ${label}`);
}
function required(value: SeekerRawAccount | null | undefined): SeekerRawAccount {
  need(value, 'missing linked account'); return value;
}
async function readLinked(bank: SeekerAuctionEvidenceBank, addresses: readonly PublicKey[]): Promise<SeekerRawAccount[]> {
  const rows: SeekerRawAccount[] = [];
  for (let at = 0; at < addresses.length; at += RPC_BATCH_MAX)
    rows.push(...(await bank.read(addresses.slice(at, at + RPC_BATCH_MAX))).map(required));
  return rows;
}
function candidate(bank: SeekerAuctionEvidenceBank, row: ProgramAccountRow): SeekerLiveBid {
  need(row && row.pubkey && row.account && row.account.data instanceof Uint8Array
    && row.account.data.length === SEEKER_BID_ACCOUNT_BYTES, 'malformed candidate allocation');
  const raw: SeekerRawAccount = { address: new PublicKey(row.pubkey.toBytes()), owner: new PublicKey(row.account.owner.toBytes()),
    executable: row.account.executable, data: Buffer.from(row.account.data) };
  // Only an untrusted routing hint until decodeSeekerLiveBid verifies owner,
  // discriminator, version, canonical PDA, wallet, bump and refund state.
  const auction = new PublicKey(raw.data.subarray(BID_AUCTION_OFFSET, BID_WALLET_OFFSET));
  return decodeSeekerLiveBid(bank.program, auction, bank.wallet, raw);
}
function verifyTermObservation(bank: SeekerAuctionEvidenceBank, term: SeekerLiveTerm): void {
  if (term.completedAt !== null) need(term.completedAt <= bank.nowSec && term.completedSlot !== null
    && term.completedSlot > BigInt(bank.trust.deploymentSlot) && term.completedSlot <= BigInt(bank.slot),
  'term completion outside observed deployment');
}
function compareKeys(a: { round: string; spot: number }, b: { round: string; spot: number }): number {
  const ar = BigInt(a.round), br = BigInt(b.round);
  return ar < br ? -1 : ar > br ? 1 : a.spot - b.spot;
}

export async function readSeekerAuctionRefunds(source: SeekerAuctionReadSource, walletText: string, request: unknown = {},
  callerSignal?: AbortSignal): Promise<SeekerAuctionRefundsPage> {
  const query = SeekerAuctionRefundsRequestSchema.parse(request);
  return withSeekerAuctionEvidenceBank(source, walletText, callerSignal, async bank => {
    const rpc = bank.rpc as SeekerAuctionRefundRpc;
    need(typeof rpc.getProgramAccounts === 'function', 'wallet-filtered RPC capability missing');
    bank.signal.throwIfAborted();
    // K-night-08: a pool node still below bank.slot (-32016) is asked again, bounded.
    const response = await untilSeekerContextReached(bank.signal, () => rpc.getProgramAccounts!(bank.program, { commitment: 'finalized', withContext: true,
      minContextSlot: bank.slot, filters: [{ dataSize: SEEKER_BID_ACCOUNT_BYTES },
        { memcmp: { offset: BID_WALLET_OFFSET, bytes: bank.wallet.toBase58() } },
        // Base58 "1" is one zero byte: withdrawn history cannot consume the cap.
        { memcmp: { offset: BID_REFUNDED_OFFSET, bytes: '1' } }] }));
    bank.signal.throwIfAborted(); bank.assertContext(response.context.slot);
    need(Array.isArray(response.value), 'missing candidate vector');
    need(response.value.length <= R.refundBidCandidateMax, 'candidate cap exceeded');

    const bids: SeekerLiveBid[] = [], identities = new Set<string>();
    for (const row of response.value) {
      const bid = candidate(bank, row);
      need(!identities.has(bid.address), 'duplicate candidate identity'); identities.add(bid.address); bids.push(bid);
    }
    const auctionRows = await readLinked(bank, bids.map(bid => new PublicKey(bid.auction)));
    const hints = auctionRows.map(row => seekerAuctionAccountHint(bank.program, row.address, row));
    const termAddresses = new Map<string, PublicKey>();
    for (const hint of hints) {
      const term = seekerTermPda(bank.program, new PublicKey(bank.config.address), hint.round);
      termAddresses.set(hint.round.toString(), term);
    }
    const rounds = [...termAddresses.keys()], terms = new Map<string, SeekerLiveTerm>();
    const termRows = await readLinked(bank, [...termAddresses.values()]);
    for (const [index, round] of rounds.entries()) {
      const term = decodeSeekerLiveTerm(bank.config, BigInt(round), termRows[index]!);
      verifyTermObservation(bank, term); terms.set(round, term);
    }

    const refunds: SeekerAuctionRefundEntry[] = [];
    for (const [index, bid] of bids.entries()) {
      const hint = hints[index]!, term = terms.get(hint.round.toString())!;
      const auction = decodeSeekerLiveAuction(bank.config, term, hint.spot, auctionRows[index]!);
      if (auction.settled) need(auction.settledAt !== null && auction.settledAt <= bank.nowSec && auction.settledSlot !== null
        && auction.settledSlot > BigInt(bank.trust.deploymentSlot) && auction.settledSlot <= BigInt(bank.slot),
      'auction settlement outside observed deployment');
      if (auction.highBidder === walletText) {
        need(!bid.refunded && bid.amount === (auction.settled ? 0n : auction.highBid), 'leader Bid backing');
        continue;
      }
      if (bid.amount === 0n || bid.refunded) continue;
      need(auction.round <= bank.biddingRound && bank.nowSec >= auction.auctionStart, 'refund before bidding');
      need(bid.amount < auction.highBid && auction.outstandingEscrow >= bid.amount + (auction.settled ? 0n : auction.highBid),
        'loser Bid backing');
      refunds.push({ bid: bid.address, auction: auction.address, round: auction.round.toString(), spot: auction.spotId,
        amountRaw: bid.amount.toString() });
    }
    // Do not filter candidates by the cursor before verification: a malformed
    // old or later row makes the entire wallet observation unavailable.
    refunds.sort(compareKeys);
    const remaining = query.after ? refunds.filter(row => compareKeys(row, query.after!) > 0) : refunds;
    const entries = remaining.slice(0, R.refundPageSize), last = entries.at(-1);
    const nextCursor = remaining.length > entries.length && last ? { round: last.round, spot: last.spot } : null;
    bank.signal.throwIfAborted();
    return SeekerAuctionRefundsPageSchema.parse({ version: 1, source: 'chain', wallet: walletText,
      observedSlot: bank.slot.toString(), chainUnixTime: bank.nowSec.toString(), programId: bank.config.programId,
      config: bank.config.address, mint: bank.config.mint, decimals: bank.config.decimals, entries, nextCursor });
  });
}
