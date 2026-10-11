/** review 4dbfed12: a separate wallet refund view, not a wider round view.
 * Every page describes one finalized bank. Keyset continuation remains useful
 * across bank advances and does not promise an atomic multi-page snapshot. */
import { z } from 'zod';
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from './constants';
import { SeekerAuctionSourcedRoundViewSchema, SeekerWithdrawPrepareRequestSchema } from './seekerAuctionApi';

// Reuse the frozen transport's scalar grammars without modifying its shape.
const Address = SeekerAuctionSourcedRoundViewSchema.shape.wallet.refine(value => value !== '1'.repeat(32));
const U64 = SeekerWithdrawPrepareRequestSchema.shape.round;
const Spot = SeekerWithdrawPrepareRequestSchema.shape.spot;
const I64 = SeekerAuctionSourcedRoundViewSchema.shape.chainUnixTime;
const Cursor = z.object({ round: U64, spot: Spot }).strict();
const Entry = z.object({ bid: Address, auction: Address, round: U64, spot: Spot,
  amountRaw: U64.refine(value => value !== '0') }).strict();

export const SeekerAuctionRefundsRequestSchema = z.object({ after: Cursor.optional() }).strict();
export const SeekerAuctionRefundsPageSchema = z.object({
  version: z.literal(1), source: z.literal('chain'), wallet: Address, observedSlot: U64, chainUnixTime: I64,
  programId: Address, config: Address, mint: Address, decimals: z.number().int().min(0).max(19),
  entries: z.array(Entry).max(PHASE_E_SEEKER_AUCTION_RUNTIME.refundPageSize), nextCursor: Cursor.nullable(),
}).strict().superRefine((page, ctx) => {
  // Scalar failures already carry their own issue; avoid interpreting invalid
  // decimal text while collecting structural errors.
  if (!page.entries.every(row => U64.safeParse(row.round).success)) return;
  const bids = new Set<string>(), auctions = new Set<string>();
  for (const [index, row] of page.entries.entries()) {
    const prior = page.entries[index - 1];
    if (prior && (BigInt(row.round) < BigInt(prior.round)
      || row.round === prior.round && row.spot <= prior.spot))
      ctx.addIssue({ code: 'custom', message: 'refund entries must have unique ascending round/spot keys' });
    if (bids.has(row.bid) || auctions.has(row.auction))
      ctx.addIssue({ code: 'custom', message: 'duplicate refund account' });
    bids.add(row.bid); auctions.add(row.auction);
  }
  if (page.nextCursor !== null) {
    const last = page.entries.at(-1);
    if (page.entries.length !== PHASE_E_SEEKER_AUCTION_RUNTIME.refundPageSize
      || !last || last.round !== page.nextCursor.round || last.spot !== page.nextCursor.spot)
      ctx.addIssue({ code: 'custom', message: 'continuation must be the final key of a full page' });
  }
});

export type SeekerAuctionRefundsRequest = z.infer<typeof SeekerAuctionRefundsRequestSchema>;
export type SeekerAuctionRefundsPage = z.infer<typeof SeekerAuctionRefundsPageSchema>;
export type SeekerAuctionRefundEntry = SeekerAuctionRefundsPage['entries'][number];
