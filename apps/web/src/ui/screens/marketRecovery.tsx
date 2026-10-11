import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { useEffect, useRef } from 'react';
import type { MarketController, MarketControllerState } from '../../lib/market/controller';
import { isEndedMarketPurchase, type MarketCommand, type MarketPurchase } from '../../lib/market/journal';
import { explorerUrl } from '../../lib/cluster';
import { Btn, Card, COLORS as C } from '../primitives';

export function exactMarketSol(lamports: string): string {
  const value = BigInt(lamports); const unit = BigInt(LAMPORTS_PER_SOL);
  const remainder = (value % unit).toString().padStart(9, '0').replace(/0+$/, '');
  return `${value / unit}${remainder ? `.${remainder}` : ''}`;
}
export type MarketReview =
  | { kind: 'list'; itemId: string; name: string; priceLamports: string; baseId: string | null }
  | { kind: 'reserve'; listingId: string; itemId: string; name: string; sourceBaseId: string | null; buyerBaseId: string | null; seller: string; priceLamports: string }
  | { kind: 'cancel'; listingId: string; itemId: string; name: string; sourceBaseId: string | null; priceLamports: string; status: 'active' | 'reserved'; reference: string | null };
const place = (id: string | null): string => id ? `Base ${id}` : 'Wallet inventory';
function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div style={{ overflowWrap: 'anywhere', fontSize: 13 }}><span style={{ color: C.textFaint }}>{label}: </span>{value}</div>;
}
export function MarketConsentPanel({ review, busy, confirm, cancel }: {
  review: MarketReview; busy: boolean; confirm(): void; cancel(): void;
}): React.JSX.Element {
  const reviewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const panel = reviewRef.current;
    // A review opened from a low listing must be visible before consent.
    panel?.focus({ preventScroll: true });
    panel?.scrollIntoView({ block: 'start', behavior: 'instant' });
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [review]);
  return <section ref={reviewRef} tabIndex={-1} aria-label="Review market request" style={{ scrollMarginBlock: 8 }}><Card style={{ padding: 12, gap: 8 }}>
    <strong style={{ color: C.goldHi }}>{review.kind === 'list' ? 'LIST' : review.kind === 'reserve' ? 'RESERVE' : 'CANCEL LISTING'} · {review.name}</strong>
    <Field label="Price" value={`${exactMarketSol(review.priceLamports)} SOL`} />
    <Field label={review.kind === 'reserve' ? 'Receiving inventory' : 'Source inventory'} value={place(review.kind === 'list' ? review.baseId : review.kind === 'reserve' ? review.buyerBaseId : review.sourceBaseId)} />
    {review.kind === 'reserve' ? <>
      <Field label="Seller" value={review.seller} />
      <span style={{ color: C.textDim, fontSize: 13 }}>Reserve this offer first. You will review the frozen payment split and network fee before opening your wallet.</span>
    </> : review.kind === 'list' ? <span style={{ color: C.textDim, fontSize: 13 }}>One unequipped copy enters market custody at this SOL price.</span>
      : <span style={{ color: C.textDim, fontSize: 13 }}>The server will check this listing. An unpaid listing may return its item; an already paid purchase must settle to its buyer.</span>}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Btn disabled={busy} onClick={confirm}>CONFIRM {review.kind === 'reserve' ? 'RESERVATION' : review.kind === 'cancel' ? 'CANCELLATION' : 'LISTING'}</Btn>
      <Btn variant="ghost" disabled={busy} onClick={cancel}>BACK</Btn>
    </div>
  </Card></section>;
}
function commandNotice(command: MarketCommand): string {
  if (!command.receipt) return 'The result is not yet confirmed. Read the original receipt or explicitly retry the saved request.';
  if (command.kind === 'list') return 'Your original listing was created. Refresh inventory to finish.';
  if (command.kind === 'reserve') return 'Your original reservation is ready to recover.';
  const receipt = command.receipt;
  if (receipt.state === 'pending') return 'Cancellation is still pending. Its exact request remains saved.';
  if (receipt.state === 'cancelled') return 'The server cancelled this listing. Refresh the source inventory to finish.';
  if (receipt.state === 'settled') return `A buyer already paid. The purchase settled into ${place(receipt.settlement!.buyerBaseId)}; cancellation did not return the item.`;
  return `Cancellation was refused (${receipt.refusalCode}). The receipt remains available; no return of inventory is claimed.`;
}
/** The saved-purchase line must state the SERVER's outcome, not only the local
 * attempt: a superseded or cancelled generation can never deliver, and telling
 * a buyer to "check the original payment" forever read as a purchase they had
 * made (tester report 24b9184d, 2026-09-16 — the listing had sold to someone
 * else hours earlier). Exported for its unit test. */
export function purchaseNotice(purchase: MarketPurchase): string {
  if (purchase.receipt.state === 'settled') return purchase.hydrated
    ? purchase.hydrated.stillOwned ? 'Payment settled and the original receiving inventory refreshed.' : 'Payment settled into the original destination. Fresh ownership shows that base is no longer yours.'
    : 'Payment settled. Refresh your account and original receiving inventory before finishing.';
  if (purchase.receipt.state === 'superseded' || purchase.receipt.state === 'cancelled') {
    const ended = purchase.receipt.state === 'superseded' ? 'was released' : 'was cancelled';
    const when = purchase.receipt.resolvedAt ? ` at ${purchase.receipt.resolvedAt}` : '';
    if (purchase.signature ?? purchase.receipt.paymentSignature ?? purchase.receipt.txSignature) return `This reservation ${ended}${when} and can no longer deliver the item. Your saved transaction is kept: contact support@pixelkingdomwars.com with the reservation ID and transaction before sending anything again.`;
    if (purchase.attempted) return `This reservation ${ended}${when} and can no longer deliver the item. This browser has no saved transaction signature; that does not prove no payment was made. Keep this receipt and check your wallet history before making a new purchase.`;
    return `This reservation ${ended}${when} and can no longer deliver the item. No wallet approval was recorded in this browser.`;
  }
  if (purchase.attempted) return 'A wallet approval was attempted. Check this original payment; do not pay or sign again while its result is uncertain.';
  if (!purchase.receipt.payable) return 'This saved quote is no longer payable. Read its receipt before closing the review.';
  return 'Review the frozen quote and network fee, then approve payment once.';
}
function PurchaseDetails({ purchase }: { purchase: MarketPurchase }): React.JSX.Element {
  return <>
      <Field label="Reservation" value={purchase.receipt.quote.reservationId} />
      <Field label="Item" value={purchase.receipt.quote.itemId} />
      <Field label="Original receiving inventory" value={place(purchase.receipt.quote.buyerBaseId)} />
      <Field label="Network" value={purchase.receipt.quote.cluster} />
      <Field label="Seller" value={`${purchase.receipt.quote.seller} · ${exactMarketSol(purchase.receipt.quote.sellerLamports)} SOL`} />
      <Field label="Market fee" value={`${exactMarketSol(purchase.receipt.quote.feeLamports)} SOL · ${purchase.receipt.quote.feeBps / 100}%`} />
      <Field label="Fee recipient" value={purchase.receipt.quote.feeTreasury} />
      <Field label="Total price" value={`${exactMarketSol(purchase.receipt.quote.priceLamports)} SOL`} />
      <Field label="Payable until" value={purchase.receipt.quote.payableUntil} />
      {(purchase.signature ?? purchase.receipt.txSignature ?? purchase.receipt.paymentSignature) && <a href={explorerUrl('tx', (purchase.signature ?? purchase.receipt.txSignature ?? purchase.receipt.paymentSignature)!, purchase.receipt.quote.cluster)} target="_blank" rel="noopener noreferrer" style={{ color: C.gold, overflowWrap: 'anywhere' }}>VIEW ORIGINAL TRANSACTION</a>}
      <Field label="Payment reference" value={purchase.receipt.quote.reference} />
  </>;
}
function SavedMarketHistory({ purchases }: { purchases: MarketPurchase[] }): React.JSX.Element | null {
  if (!purchases.length) return null;
  return <details aria-label="Saved market receipts" style={{ border: `1px solid ${C.goldDp}`, padding: 12 }}>
    <summary style={{ color: C.goldHi, cursor: 'pointer' }}>SAVED RECEIPTS · {purchases.length}</summary>
    <p style={{ fontSize: 13 }}>These ended reservations no longer block the market. Closing a receipt does not verify a payment or issue a refund. Transaction details remain saved here for support.</p>
    {purchases.map((purchase) => <details key={purchase.receipt.quote.reservationId} style={{ paddingBlock: 8 }}>
      <summary style={{ cursor: 'pointer' }}>{purchase.receipt.quote.itemId} · {purchase.receipt.state} · {purchase.receipt.resolvedAt}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBlock: 8 }}>
        <PurchaseDetails purchase={purchase} />
        <span style={{ fontSize: 13 }}>{purchaseNotice(purchase)}</span>
      </div>
    </details>)}
  </details>;
}
export function MarketRecoveryPanel({ controller, state, pay, check, afterFinish }: {
  controller: MarketController; state: MarketControllerState; pay(): Promise<void>; check(): Promise<void>; afterFinish(): void;
}): React.JSX.Element | null {
  const journal = state.journal; const command = journal?.command; const purchase = journal?.purchase;
  if (!state.loaded) return <Card style={{ padding: 12, gap: 8 }}>
    <span>{state.error ?? 'Reading saved market requests…'}</span><Btn disabled={state.busy} onClick={() => void controller.open()}>READ SAVED REQUEST</Btn>
  </Card>;
  const finish = async (): Promise<void> => { await controller.finish(); if (!controller.snapshot().journal?.command && !controller.snapshot().journal?.purchase) afterFinish(); };
  const archive = async (): Promise<void> => { await controller.archivePurchase(); if (!controller.snapshot().journal?.purchase) afterFinish(); };
  const history = <SavedMarketHistory purchases={journal?.archivedPurchases ?? []} />;
  if (!command && !purchase) return <>{state.error && <div role="alert" style={{ color: C.danger }}>{state.error}</div>}{history}</>;
  return <><section aria-label="Saved market request"><Card style={{ padding: 12, gap: 8, borderColor: C.goldDp }}>
    <strong style={{ color: C.goldHi }}>{purchase ? 'SAVED PURCHASE' : 'SAVED MARKET REQUEST'}</strong>
    {state.error && <div role="alert" style={{ color: C.danger }}>{state.error}</div>}
    {command && <>
      <Field label="Request" value={command.request.idempotencyKey} />
      <Field label="Item" value={command.request.itemId} />
      <Field label="Price" value={`${exactMarketSol(command.request.priceLamports)} SOL`} />
      <Field label="Original inventory" value={place(command.kind === 'list' ? command.request.baseId : command.kind === 'reserve' ? command.request.buyerBaseId : command.request.sourceBaseId)} />
      <span style={{ fontSize: 13 }}>{journal.refusal ? `The first request was refused: ${journal.refusal.message}. Finish before reviewing a new request.` : commandNotice(command)}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Btn disabled={state.busy} onClick={() => void controller.open()}>READ RECEIPT</Btn>
        {!journal.refusal && (!command.receipt || command.kind === 'cancel' && command.receipt.state === 'pending') && <Btn variant="sec" disabled={state.busy} onClick={() => void controller.retryCommand()}>RETRY SAVED REQUEST</Btn>}
        {(journal.refusal || command.receipt && !(command.kind === 'cancel' && command.receipt.state === 'pending')) && <Btn variant="ghost" disabled={state.busy} onClick={() => void finish()}>FINISH</Btn>}
      </div>
    </>}
    {purchase && <>
      <PurchaseDetails purchase={purchase} />
      {state.networkFee !== null && <Field label="Estimated network fee" value={`${exactMarketSol(String(state.networkFee))} SOL`} />}
      <span style={{ fontSize: 13 }}>{purchaseNotice(purchase)}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {!purchase.attempted && purchase.receipt.payable && <Btn disabled={state.busy} onClick={() => void controller.reviewPayment()}>REVIEW NETWORK FEE</Btn>}
        {!purchase.attempted && purchase.receipt.payable && state.networkFee !== null && <Btn disabled={state.busy} onClick={() => void pay()}>PAY {exactMarketSol(purchase.receipt.quote.priceLamports)} SOL + NETWORK FEE</Btn>}
        {!isEndedMarketPurchase(purchase) && <Btn variant="sec" disabled={state.busy} onClick={() => void check()}>{purchase.receipt.state === 'settled' ? 'REFRESH DELIVERY' : 'CHECK ORIGINAL PAYMENT'}</Btn>}
        {isEndedMarketPurchase(purchase) && <Btn variant="ghost" disabled={state.busy} onClick={() => void archive()}>BACK TO MARKET</Btn>}
        {!isEndedMarketPurchase(purchase) && (!purchase.attempted || purchase.receipt.state === 'settled' && purchase.hydrated) && <Btn variant="ghost" disabled={state.busy} onClick={() => void finish()}>{purchase.receipt.state === 'settled' ? 'FINISH' : 'CLOSE SAVED REVIEW'}</Btn>}
      </div>
      {isEndedMarketPurchase(purchase) && <span style={{ fontSize: 12, color: C.textFaint }}>Back to market keeps this receipt in SAVED RECEIPTS. It does not verify a payment or issue a refund. Any new purchase requires a new quote and your approval.</span>}
      {!isEndedMarketPurchase(purchase) && !purchase.attempted && purchase.receipt.state !== 'settled' && <span style={{ fontSize: 12, color: C.textFaint }}>Closing this review does not cancel the server reservation or prove that no payment was made elsewhere.</span>}
    </>}
    {state.busy && <span role="status" style={{ color: C.textFaint }}>Checking the saved request…</span>}
  </Card></section>{history}</>;
}
