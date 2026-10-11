import {
  ITEM_MARKET_FEATURE, MarketCancelRequestSchema, MarketListRequestSchema, MarketReserveRequestSchema,
} from '@shardkeep/shared/market';
import {
  adoptReservation, isEndedMarketPurchase, MarketJournalStore, matchCommandReceipt,
  type MarketCommand, type MarketJournal, type MarketPurchase, type ReservationReceipt,
} from './journal';
import type { PreparedMarketPayment } from './payment';

export interface MarketPorts {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  /** Fail closed when another tab owns this action; never queue a stale click. */
  lock<T>(name: string, action: () => Promise<T>): Promise<T>;
  /** Captures wallet, auth revision, selected base and page-lifecycle epoch. */
  capture(newAction: boolean): () => void;
  assertDestination(baseId: string | null): void;
  prepare(quote: ReservationReceipt['quote']): Promise<PreparedMarketPayment>;
  sign(payment: PreparedMarketPayment, buyer: string): Promise<{ wire: Uint8Array; signature: string }>;
  broadcast(wire: Uint8Array, signature: string): Promise<void>;
  hydratePurchase(quote: ReservationReceipt['quote']): Promise<NonNullable<MarketPurchase['hydrated']>>;
  hydrateCommand(command: MarketCommand): Promise<void>;
  clock(): { elapsed: number; wall: number };
  key(): string;
  firstRefusal(error: unknown): MarketJournal['refusal'];
}
export type MarketControllerState = { loaded: boolean; busy: boolean; journal: MarketJournal | null; error: string | null; networkFee: number | null };
type Review = { reservationId: string; prepared: PreparedMarketPayment; remaining: number; start: ReturnType<MarketPorts['clock']>; guard: () => void };
const keyPath = (command: MarketCommand): string => {
  const segment = command.kind === 'list' ? 'list' : command.kind === 'reserve' ? 'reservations' : 'cancellations';
  return `/market/v1/${segment}/by-key/${encodeURIComponent(command.request.idempotencyKey)}`;
};
const commandPath = (command: MarketCommand): string => command.kind === 'list' ? '/market/v1/list'
  : `/market/v1/listings/${command.listingId}/${command.kind}`;
export function supportsMarketV1(book: unknown): boolean {
  if (!book || typeof book !== 'object') return false;
  const feature = (book as { features?: { itemMarket?: unknown } }).features?.itemMarket;
  return !!feature && typeof feature === 'object'
    && Object.entries(ITEM_MARKET_FEATURE).every(([key, value]) => (feature as Record<string, unknown>)[key] === value);
}
/** A controller never discovers payment from a book/balance/item count. Only the
 * stored original receipt can authorize recovery; only explicit pay can sign. */
export class MarketController {
  private state: MarketControllerState = { loaded: false, busy: false, journal: null, error: null, networkFee: null };
  private review: Review | null = null;
  private readonly listeners = new Set<() => void>();
  constructor(readonly store: MarketJournalStore, private readonly ports: MarketPorts) {}
  snapshot = (): MarketControllerState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<MarketControllerState>): void { this.state = { ...this.state, ...update }; this.listeners.forEach((listener) => listener()); }
  private async write(update: (old: MarketJournal) => MarketJournal, guard: () => void): Promise<void> {
    guard(); const current = this.state.journal;
    if (!current) throw new Error('Read the saved market receipt first.');
    const next = await this.store.compareAndSet(current.revision, update);
    guard(); this.publish({ journal: next });
  }
  private async action(newAction: boolean, operation: (guard: () => void) => Promise<void>): Promise<void> {
    if (this.state.busy) return;
    this.publish({ busy: true, error: null });
    try {
      const guard = this.ports.capture(newAction);
      await this.ports.lock(`pkw-market-v1:${this.store.key}`, async () => {
        guard(); const journal = await this.store.read(); guard(); this.publish({ journal, loaded: true });
        await operation(guard);
      });
    } catch (error) {
      this.review = null; this.publish({ error: error instanceof Error ? error.message : 'Market recovery did not complete.', networkFee: null });
    } finally { this.publish({ busy: false }); }
  }
  private async capability(guard: () => void): Promise<void> {
    const book = await this.ports.get('/market/listings'); guard();
    if (!supportsMarketV1(book)) throw new Error('This server has not enabled saved market payments. Your original receipt remains available.');
  }
  private async acceptCommand(command: MarketCommand, raw: unknown, guard: () => void): Promise<void> {
    const accepted = matchCommandReceipt(command, this.store.identity, raw);
    await this.write((old) => {
      if (!old.command || JSON.stringify({ ...old.command, receipt: null }) !== JSON.stringify({ ...command, receipt: null })) throw new Error('The saved command changed.');
      if (old.command.kind === 'list' && old.command.receipt && JSON.stringify(old.command.receipt) !== JSON.stringify(accepted.receipt)) throw new Error('The original listing receipt changed.');
      if (old.command.kind === 'cancel' && old.command.receipt && accepted.kind === 'cancel'
        && old.command.receipt.createdAt !== accepted.receipt?.createdAt) throw new Error('The original cancellation receipt changed.');
      if (accepted.kind === 'reserve' && accepted.receipt) {
        return { ...old, command: null, refusal: null, purchase: { receipt: accepted.receipt, attempted: false, signature: null, hydrated: null } };
      }
      if (old.command.kind === 'cancel' && old.command.receipt?.state !== undefined && old.command.receipt.state !== 'pending'
        && JSON.stringify(old.command.receipt) !== JSON.stringify(accepted.receipt)) throw new Error('The final cancellation receipt changed.');
      return { ...old, command: accepted };
    }, guard);
  }
  private async readPurchase(guard: () => void): Promise<void> {
    const purchase = this.state.journal?.purchase;
    if (!purchase) return;
    const raw = await this.ports.get(`/market/v1/reservations/by-key/${encodeURIComponent(purchase.receipt.quote.idempotencyKey!)}`); guard();
    await this.write((old) => ({ ...old, purchase: adoptReservation(old.purchase!, raw) }), guard);
  }
  /** Opening, returning to the tab and polling are GET-only. */
  open(): Promise<void> {
    return this.action(false, async (guard) => {
      this.review = null; this.publish({ networkFee: null });
      const command = this.state.journal?.command;
      if (command && !this.state.journal?.refusal) { const raw = await this.ports.get(keyPath(command)); guard(); await this.acceptCommand(command, raw, guard); }
      await this.readPurchase(guard);
    });
  }
  private begin(command: MarketCommand): Promise<void> {
    return this.action(true, async (guard) => {
      if (this.state.journal?.command || this.state.journal?.purchase) throw new Error('Finish the saved market request before creating another.');
      await this.capability(guard);
      await this.write((old) => ({ ...old, activated: true, command, refusal: null }), guard);
      let raw: unknown;
      try { guard(); raw = await this.ports.post(commandPath(command), command.request); }
      catch (error) {
        guard();
        const refusal = command.kind === 'cancel' ? null : this.ports.firstRefusal(error);
        if (refusal) await this.write((old) => ({ ...old, refusal }), guard);
        throw error;
      }
      guard(); await this.acceptCommand(command, raw, guard);
    });
  }
  list(request: Omit<ReturnType<typeof MarketListRequestSchema.parse>, 'idempotencyKey'>): Promise<void> {
    return this.begin({ kind: 'list', request: MarketListRequestSchema.parse({ ...request, idempotencyKey: this.ports.key() }), receipt: null });
  }
  reserve(listingId: string, request: Omit<ReturnType<typeof MarketReserveRequestSchema.parse>, 'idempotencyKey'>): Promise<void> {
    return this.begin({ kind: 'reserve', listingId, request: MarketReserveRequestSchema.parse({ ...request, idempotencyKey: this.ports.key() }), receipt: null });
  }
  cancel(listingId: string, request: Omit<ReturnType<typeof MarketCancelRequestSchema.parse>, 'idempotencyKey'>): Promise<void> {
    return this.begin({ kind: 'cancel', listingId, request: MarketCancelRequestSchema.parse({ ...request, idempotencyKey: this.ports.key() }), receipt: null });
  }
  /** Explicit retry retains the whole original body/key. A failed GET, 404, or
   * interrupted response is never permission to replace this command. */
  retryCommand(): Promise<void> {
    return this.action(false, async (guard) => {
      const command = this.state.journal?.command;
      if (!command) throw new Error('There is no saved request to retry.');
      if (this.state.journal?.refusal) throw new Error('This first request was refused. Finish it before reviewing a new request.');
      if (command.receipt && !(command.kind === 'cancel' && command.receipt.state === 'pending')) throw new Error('This request already has a receipt.');
      const raw = await this.ports.post(commandPath(command), command.request); guard();
      await this.acceptCommand(command, raw, guard);
    });
  }
  private assertPayable(review: Review, purchase: MarketPurchase): void {
    review.guard(); const now = this.ports.clock();
    const age = Math.max(now.elapsed - review.start.elapsed, now.wall - review.start.wall);
    if (now.wall < review.start.wall || now.elapsed < review.start.elapsed || age >= review.remaining
      || purchase.receipt.quote.reservationId !== review.reservationId || !purchase.receipt.payable
      || purchase.receipt.state !== 'reserved') throw new Error('The payment approval expired. Read the saved receipt before continuing.');
  }
  /** A separate review exposes the network fee before the user's Pay click. */
  reviewPayment(): Promise<void> {
    return this.action(true, async (guard) => {
      this.review = null; this.publish({ networkFee: null });
      const purchase = this.state.journal?.purchase;
      if (!purchase || purchase.attempted) throw new Error('Check the original payment; it must not be signed again.');
      await this.capability(guard);
      const start = this.ports.clock();
      await this.readPurchase(guard);
      const fresh = this.state.journal!.purchase!;
      if (fresh.signature || fresh.attempted || !fresh.receipt.payable) throw new Error('The original quote is not payable.');
      this.ports.assertDestination(fresh.receipt.quote.buyerBaseId);
      const prepared = await this.ports.prepare(fresh.receipt.quote); guard();
      const review = { reservationId: fresh.receipt.quote.reservationId, start, prepared,
        remaining: Date.parse(fresh.receipt.quote.payableUntil) - Date.parse(fresh.receipt.serverNow), guard };
      this.assertPayable(review, fresh); this.review = review; this.publish({ networkFee: prepared.networkFee });
    });
  }
  pay(): Promise<void> {
    return this.action(true, async (guard) => {
      const review = this.review; const purchase = this.state.journal?.purchase;
      if (!review || !purchase || purchase.attempted || purchase.signature) throw new Error('Review the original quote and network fee first.');
      await this.capability(guard); await this.readPurchase(guard); this.assertPayable(review, this.state.journal!.purchase!);
      await this.write((old) => ({ ...old, purchase: { ...old.purchase!, attempted: true } }), guard);
      this.assertPayable(review, this.state.journal!.purchase!); this.ports.assertDestination(purchase.receipt.quote.buyerBaseId); guard();
      // Every signing error is held. Provider error strings alone do not prove
      // that the user refused before producing a signature.
      const signed = await this.ports.sign(review.prepared, purchase.receipt.quote.buyer);
      // The browser action lock is still held. Save this public proof under the
      // original identity even after logout/navigation; CAS rejects a losing
      // tab's late callback. Only publication/network actions need live auth.
      const next = await this.store.compareAndSet(this.state.journal!.revision,
        (old) => ({ ...old, purchase: { ...old.purchase!, signature: signed.signature } }));
      guard(); this.publish({ journal: next });
      // Sign-only returns control before broadcast, so re-read the exact current
      // generation after a slow wallet approval. Failure keeps attempted + sig.
      await this.readPurchase(guard);
      this.assertPayable(review, this.state.journal!.purchase!); guard();
      await this.ports.broadcast(signed.wire, signed.signature);
      this.review = null; this.publish({ networkFee: null }); guard();
      await this.reconcile(guard);
    });
  }
  private async hydrate(guard: () => void): Promise<void> {
    const purchase = this.state.journal?.purchase;
    if (!purchase || purchase.receipt.state !== 'settled' || purchase.hydrated) return;
    const hydrated = await this.ports.hydratePurchase(purchase.receipt.quote); guard();
    await this.write((old) => ({ ...old, purchase: { ...old.purchase!, hydrated } }), guard);
  }
  private async reconcile(guard: () => void): Promise<void> {
    let purchase = this.state.journal?.purchase;
    if (!purchase) return;
    if (purchase.receipt.state === 'settled') { await this.hydrate(guard); return; }
    const quote = purchase.receipt.quote;
    if (purchase.signature) {
      let response: { value: unknown } | null = null;
      try { response = { value: await this.ports.post(`/market/v1/reservations/${quote.reservationId}/paid`, { reference: quote.reference, signature: purchase.signature }) }; }
      catch { guard(); /* Exact-reference settle can rescue a payment whose /paid window elapsed. */ }
      guard();
      if (response) await this.write((old) => ({ ...old, purchase: adoptReservation(old.purchase!, response.value) }), guard);
      purchase = this.state.journal!.purchase!;
      if (purchase.receipt.state === 'settled') { await this.hydrate(guard); return; }
    }
    const raw = await this.ports.post(`/market/v1/reservations/${quote.reservationId}/settle`, {
      reference: quote.reference, ...(purchase.signature ? { signature: purchase.signature } : {}),
    }); guard();
    await this.write((old) => ({ ...old, purchase: adoptReservation(old.purchase!, raw) }), guard);
    await this.hydrate(guard);
  }
  /** Reconciliation may register/settle only the original receipt. It can never
   * create a reservation, sign again, or rebroadcast a saved transaction. */
  recoverPayment(): Promise<void> { return this.action(false, (guard) => this.reconcile(guard)); }
  /** Dismiss only an authoritative ended generation. This preserves evidence,
   * not a claim of nonpayment/refund, and cannot retry its wallet transaction. */
  archivePurchase(): Promise<void> {
    return this.action(false, async (guard) => {
      if (!this.state.journal?.purchase) return;
      await this.readPurchase(guard);
      const purchase = this.state.journal!.purchase!;
      if (!isEndedMarketPurchase(purchase)) throw new Error('This reservation still needs its original payment receipt.');
      await this.write((old) => ({ ...old, purchase: null, archivedPurchases: [...old.archivedPurchases, old.purchase!] }), guard);
      this.review = null; this.publish({ networkFee: null });
    });
  }
  finish(): Promise<void> {
    return this.action(false, async (guard) => {
      const command = this.state.journal?.command;
      if (command) {
        if (this.state.journal!.refusal) {
          await this.write((old) => ({ ...old, command: null, refusal: null }), guard); return;
        }
        const raw = await this.ports.get(keyPath(command)); guard(); await this.acceptCommand(command, raw, guard);
        const confirmed = this.state.journal!.command;
        if (!confirmed?.receipt || (confirmed.kind === 'cancel' && confirmed.receipt.state === 'pending')) throw new Error('This request still needs its exact receipt.');
        await this.ports.hydrateCommand(confirmed); guard();
        await this.write((old) => ({ ...old, command: null }), guard); return;
      }
      const saved = this.state.journal?.purchase;
      if (!saved) return;
      if (saved.receipt.state === 'settled') await this.hydrate(guard);
      else await this.readPurchase(guard);
      const purchase = this.state.journal!.purchase!;
      if ((purchase.attempted || purchase.signature || purchase.receipt.state === 'committed')
        && !(purchase.receipt.state === 'settled' && purchase.hydrated)) throw new Error('Keep this payment receipt until settlement and delivery refresh complete.');
      if (purchase.receipt.state === 'settled' && !purchase.hydrated) throw new Error('Refresh the original delivery destination first.');
      // Closing an unattempted review does not cancel the server reservation or
      // assert that no other client paid it; the server still owns its lifecycle.
      await this.write((old) => ({ ...old, purchase: null }), guard);
      this.review = null; this.publish({ networkFee: null });
    });
  }
}

export async function marketBrowserLock<T>(name: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks?.request) return Promise.reject(new Error('This browser cannot safely coordinate market payments. Update it and try again.'));
  return await navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
    if (!lock) throw new Error('Another game tab is handling this market request. Check that tab first.');
    return action();
  });
}
