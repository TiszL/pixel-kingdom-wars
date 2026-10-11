import type { GemsState } from '../../../lib/gems/controller';
import { amount, parseGemsReceipt, type GemsKind } from '../../../lib/gems/contracts';
import { gemsRefusalDefinitive } from '../../../lib/gems/journal';
import type { GemsBuyState } from '../../../lib/gemsBuy/controller';
import { hasGemsBuyPaymentEvidence, parseGemsBuyPurchase } from '../../../lib/gemsBuy/journal';
import type { MoneyStage } from '../types';

/** Supplied by the snapshot owner, never inferred from a retained journal or quote.
 * A current purchase observation can be an observed empty journal: a nonexistent
 * purchase has no freshness/hydration field to satisfy. These are entry gates,
 * not signing admission; existing controllers still own every action/guard.
 */
export interface GemsAdapterOwner {
  gemsObservationCurrent: boolean;
  purchaseObservationCurrent: boolean;
  actionsAllowed: boolean;
  ownerHandoffReady: boolean;
  freshEntryAllowed: boolean;
}

export interface GemsAdapterInput {
  gems: GemsState;
  buy: GemsBuyState;
  /** The owner compares the selected account/API/cluster/origin with EACH
   * snapshot's captured scope, including overview snapshots with no journal.
   * These attest identity only, separately from current observation. False
   * suppresses that source's prior-owner values, including recovery records.
   */
  scope: { gemsMatches: boolean; purchaseMatches: boolean };
  /** Omission holds every fresh action; in-scope original recovery stays visible. */
  owner?: GemsAdapterOwner;
}

export type GemsAdapterOutcome = 'saved' | 'uncertain' | 'refused' | 'credited';
export interface GemsReceiptProjection {
  receiptId: string;
  acceptedAt: string;
  amount: string;
  currency: 'GEMS' | 'SHARDS';
}
interface GemsOriginalProjection {
  requestKey: string;
  outcome: GemsAdapterOutcome;
  /** READY = saved, FAILED = definitive refusal, SENT = matching receipt only.
   * SENDING means unresolved original evidence. The body must label it as
   * checking the original request, never claim an active/new submission.
   */
  stage: MoneyStage;
  receipt: GemsReceiptProjection | null;
  hydrated: boolean;
}
export interface GemsLedgerProjection extends GemsOriginalProjection {
  kind: GemsKind;
  inputAmount: string | null;
  finished: boolean;
}
export interface GemsPurchaseProjection extends GemsOriginalProjection {
  keepIn: string;
  quotedGems: string | null;
}
export interface GemsAdapterProjection {
  /** Exact observed server balance, not receipt output added to an old balance.
   * Error can retain an older overview: without observation generations it is
   * always labelled retained. Busy/disabled/entry-held alone do not stale it.
   */
  balance: { amount: string | null; freshness: 'current' | 'retained' | 'unknown' };
  ledger: GemsLedgerProjection | null;
  purchase: GemsPurchaseProjection | null;
  fresh: { walletBuy: boolean; ledgerKeepToGems: boolean; gemsToShards: boolean };
}

function stage(outcome: GemsAdapterOutcome): MoneyStage {
  switch (outcome) {
    case 'saved': return 'READY';
    case 'uncertain': return 'SENDING';
    case 'refused': return 'FAILED';
    case 'credited': return 'SENT';
  }
}

function projectLedger(state: GemsState): GemsLedgerProjection | null {
  const journal = state.journal, original = journal?.intent;
  if (!journal || !original) return null;
  let receipt: GemsReceiptProjection | null = null;
  if (journal.receipt !== null) {
    try {
      const proof = parseGemsReceipt(journal.receipt, original, journal.identity.wallet);
      if (proof) receipt = { receiptId: proof.receiptId, acceptedAt: proof.acceptedAt,
        amount: proof.amount, currency: proof.currency };
    } catch { /* Keep the original key visible; mismatched evidence is not credit. */ }
  }
  const refused = journal.receipt === null && journal.attempted && journal.finished && !journal.hydrated
    && journal.refusal !== null && gemsRefusalDefinitive(original.kind, journal.refusal.status, journal.refusal.code);
  const unresolved = journal.attempted || journal.receipt !== null || journal.refusal !== null || journal.hydrated || journal.finished;
  const outcome: GemsAdapterOutcome = receipt ? 'credited' : refused ? 'refused' : unresolved ? 'uncertain' : 'saved';
  return { requestKey: original.idempotencyKey, kind: original.kind,
    inputAmount: original.kind === 'gems-from-keep' ? original.keep : original.kind === 'gems-to-shards' ? original.gems : null,
    outcome, stage: stage(outcome), receipt, hydrated: journal.hydrated, finished: journal.finished };
}

function projectPurchase(state: GemsBuyState): GemsPurchaseProjection | null {
  const journal = state.journal, original = journal?.purchase;
  if (!journal || !original) return null;
  let receipt: GemsReceiptProjection | null = null;
  let invalidEvidence = false;
  try {
    // Reuse the original family parser for binding, quote, payment and receipt
    // validation. This creates no admission, controller, store or transport.
    const parsed = parseGemsBuyPurchase(original, journal.identity), proof = parsed.deposit?.receipt;
    if (proof) receipt = { receiptId: proof.receiptId, acceptedAt: proof.acceptedAt,
      amount: proof.result.amount, currency: proof.result.currency };
  } catch { invalidEvidence = true; }
  const unresolved = invalidEvidence || original.prepared !== null || original.signature !== null || original.broadcastStarted
    || hasGemsBuyPaymentEvidence(original.deposit) || original.deposit !== null && original.deposit.status !== 'pending';
  const outcome: GemsAdapterOutcome = receipt ? 'credited' : unresolved ? 'uncertain' : 'saved';
  return { requestKey: original.request.idempotencyKey, keepIn: String(original.request.keepIn),
    quotedGems: original.quote ? String(original.quote.gemsOut) : null,
    outcome, stage: stage(outcome), receipt, hydrated: original.hydrated };
}

/** Read-only, body-facing projection. It exposes no actions, addresses, wallet
 * objects or signing material. Neither fresh entry gates nor stale observations
 * erase in-scope money recovery; only an authoritative matching receipt is SENT.
 */
export function projectGemsAdapters({ gems, buy, scope, owner }: GemsAdapterInput): GemsAdapterProjection {
  const ledger = scope.gemsMatches ? projectLedger(gems) : null;
  const purchase = scope.purchaseMatches ? projectPurchase(buy) : null;
  let balanceAmount: string | null = null;
  if (scope.gemsMatches && gems.overview) {
    try { balanceAmount = amount(gems.overview.gems); } catch { /* Unknown, never an invented zero. */ }
  }
  const balance: GemsAdapterProjection['balance'] = {
    amount: balanceAmount,
    freshness: balanceAmount === null ? 'unknown'
      : owner?.gemsObservationCurrent === true && gems.error === null ? 'current' : 'retained',
  };
  const entryAllowed = owner?.actionsAllowed === true && owner.ownerHandoffReady === true && owner.freshEntryAllowed === true;
  const overviewCurrent = scope.gemsMatches && owner?.gemsObservationCurrent === true && gems.loaded
    && !gems.busy && gems.error === null && gems.overview !== null && balanceAmount !== null;
  const ledgerResolved = ledger === null || ledger.finished && (ledger.outcome === 'refused' || ledger.outcome === 'credited' && ledger.hydrated);
  const convert = entryAllowed && overviewCurrent && gems.enabled && gems.overview?.exactConsent === true
    && gems.journal !== null && ledgerResolved && gems.review === null;
  const walletBuy = entryAllowed && overviewCurrent && gems.overview?.sources.includes('wallet-keep') === true
    && scope.purchaseMatches && owner?.purchaseObservationCurrent === true && buy.loaded && !buy.busy && buy.error === null
    && buy.journal !== null && buy.journal.purchase === null;
  return { balance, ledger, purchase, fresh: {
    walletBuy, ledgerKeepToGems: convert && gems.overview?.sources.includes('ledger-keep') === true, gemsToShards: convert,
  } };
}
