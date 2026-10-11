/** W1 presentation adapter over SA-4. The accepted controller owns all money effects. */
import type { SeekerAuctionState } from '../../../lib/seekerAuctions/controller';
import type { SeekerAuctionSourcedRoundView } from '@shardkeep/shared/seekerAuctionApi';
import type { CommandState, PriceUi } from '../types';

export interface SeekerSpotBidModel {
  bid: PriceUi;
  held: PriceUi;
  leader?: { name: string | null; price: PriceUi | null };
  bidState: CommandState;
  bidReason: string;
  recoveryPending: boolean;
  testData: boolean;
  /** Exact minimum TOTAL, not an increment or a stepper amount. Null means unavailable. */
  minimumNextTotalRaw: string | null;
}

// Integer wire widths and decimal radix are protocol representation, not game tuning.
const U64_LIMIT = 1n << 64n;
const I64_LIMIT = 1n << 63n;
function unsigned(raw: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || raw.length > 20) throw Error('Noncanonical amount');
  const n = BigInt(raw);
  if (n >= U64_LIMIT) throw Error('Amount outside protocol range');
  return n;
}
function signed(raw: string): bigint {
  if (!/^(0|-?[1-9][0-9]*)$/.test(raw) || raw.length > 20) throw Error('Noncanonical chain time');
  const n = BigInt(raw);
  if (n < -I64_LIMIT || n >= I64_LIMIT) throw Error('Chain time outside protocol range');
  return n;
}
function groupedInteger(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function scaled(raw: string, decimals: number): string {
  unsigned(raw);
  if (decimals < 0 || decimals > 255 || decimals % 1 !== 0) throw Error('Precision unavailable');
  if (decimals === 0) return groupedInteger(raw);
  const digits = raw.padStart(decimals + 1, '0');
  const fraction = digits.slice(-decimals).replace(/0+$/, '');
  return groupedInteger(digits.slice(0, -decimals)) + (fraction ? `.${fraction}` : '');
}
const unavailable = (): PriceUi => ({ currency: 'SKR', amount: null, status: 'UNAVAILABLE' });
const known = (raw: string, decimals: number): PriceUi => ({ currency: 'SKR', amount: scaled(raw, decimals), status: 'OK' });

/** Accept only SA-4's parsed, wallet-bound snapshot. Never infer expiry from its receipt. */
export function seekerSpotBid(state: SeekerAuctionState, spotIndex: number): SeekerSpotBidModel {
  const recoveryPending = state.status === 'pending';
  const busy = recoveryPending || state.status === 'loading' || state.status === 'preparing'
    || state.status === 'awaiting-wallet' || state.status === 'submitting';
  const empty: SeekerSpotBidModel = {
    bid: unavailable(), held: unavailable(), bidState: busy ? 'BUSY' : 'DISABLED',
    bidReason: recoveryPending ? 'Check the saved request before another bid.' : 'Auction terms unavailable.',
    recoveryPending, testData: state.view?.source === 'fixture', minimumNextTotalRaw: null,
  };
  if (state.status === 'unavailable' || state.status === 'hidden' || !state.view) return empty;
  const view: SeekerAuctionSourcedRoundView = state.view;
  const spot = view.spots[spotIndex];
  if (!spot || spot.spot !== spotIndex) return empty;
  try {
    const opening = unsigned(view.config.openingBidRaw), high = unsigned(spot.highBidRaw);
    unsigned(spot.yourBidRaw); unsigned(view.round); unsigned(view.biddingRound);
    const now = signed(view.chainUnixTime), start = signed(view.auctionStart), end = signed(view.auctionEnd);
    if (opening === 0n || start >= end) return empty;
    const next = high + 1n > opening ? high + 1n : opening;
    const total = next < U64_LIMIT ? next.toString() : null;
    const available = view.source === 'chain' && view.round === view.biddingRound && !view.admissionPaused
      && view.openedCount === view.spots.length && spot.opened && !spot.settled
      && start <= now && now < end && state.canTransact && total !== null
      && ['ready', 'expired', 'finalized', 'failed'].includes(state.status);
    const reason = recoveryPending ? 'Check the saved request before another bid.'
      : busy ? 'The auction request is being checked.'
      : view.source !== 'chain' ? 'Test data cannot place bids.'
      : total === null ? 'No higher bid fits the auction amount range.'
      : !available ? 'Bidding is unavailable for this spot or wallet.' : '';
    return {
      bid: total === null ? unavailable() : known(total, view.config.decimals),
      held: known(spot.yourBidRaw, view.config.decimals),
      ...(spot.highBidder === null ? {} : { leader: { name: spot.highBidder, price: known(spot.highBidRaw, view.config.decimals) } }),
      bidState: busy ? 'BUSY' : available ? 'ENABLED' : 'DISABLED', bidReason: reason,
      recoveryPending, testData: view.source === 'fixture', minimumNextTotalRaw: total,
    };
  } catch {
    // The transport normally rejects invalid values. A stale/incomplete host snapshot stays unknown.
    return empty;
  }
}
