import {
  MarketCancelRequestSchema, MarketCancellationReceiptSchema, MarketListRequestSchema,
  MarketListingReceiptSchema, MarketReserveRequestSchema, MarketReservationReceiptSchema,
} from '@shardkeep/shared/market';

export type ReservationReceipt = ReturnType<typeof MarketReservationReceiptSchema.parse>;
export type ListingReceipt = ReturnType<typeof MarketListingReceiptSchema.parse>;
export type CancellationReceipt = ReturnType<typeof MarketCancellationReceiptSchema.parse>;
export type MarketIdentity = { api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' };
export type MarketCommand =
  | { kind: 'list'; request: ReturnType<typeof MarketListRequestSchema.parse>; receipt: ListingReceipt | null }
  | { kind: 'reserve'; listingId: string; request: ReturnType<typeof MarketReserveRequestSchema.parse>; receipt: ReservationReceipt | null }
  | { kind: 'cancel'; listingId: string; request: ReturnType<typeof MarketCancelRequestSchema.parse>; receipt: CancellationReceipt | null };
export type MarketPurchase = {
  receipt: ReservationReceipt;
  attempted: boolean;
  signature: string | null;
  /** Server proof remains separate from refreshing the original delivery destination. */
  hydrated: { baseId: string | null; stillOwned: boolean } | null;
};
export type MarketJournal = {
  version: 1; identity: MarketIdentity; revision: number; activated: boolean;
  command: MarketCommand | null; purchase: MarketPurchase | null;
  /** Ended reservations retain all payment evidence without occupying the active slot. */
  archivedPurchases: MarketPurchase[]; refusal: { status: number; message: string } | null;
};
export class MarketJournalConflict extends Error {
  constructor() { super('The saved market request changed in another tab. Read its receipt before continuing.'); }
}
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid saved market record.');
  return v as Record<string, unknown>;
};
const exact = (v: Record<string, unknown>, keys: string[]): void => {
  if (Object.keys(v).length !== keys.length || keys.some((key) => !(key in v))) throw new Error('Invalid saved market fields.');
};
const uuid = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(v)) throw new Error('Invalid saved market ID.');
  return v;
};
export function matchCommandReceipt(command: MarketCommand, identity: MarketIdentity, input: unknown): MarketCommand {
  const b = command.request;
  if (command.kind === 'list') {
    const r = MarketListingReceiptSchema.parse(input);
    if (r.idempotencyKey !== b.idempotencyKey || r.creator !== identity.wallet || r.itemId !== b.itemId
      || r.priceLamports !== b.priceLamports || r.sourceBaseId !== command.request.baseId) throw new Error('Listing receipt does not match the saved request.');
    return { ...command, receipt: r };
  }
  if (command.kind === 'cancel') {
    const r = MarketCancellationReceiptSchema.parse(input);
    if (r.idempotencyKey !== b.idempotencyKey || r.actor !== identity.wallet || r.listingId !== command.listingId
      || r.itemId !== b.itemId || r.priceLamports !== b.priceLamports || r.sourceBaseId !== command.request.sourceBaseId
      || r.expectedStatus !== command.request.status || r.expectedReference !== command.request.reference) throw new Error('Cancellation receipt does not match the saved consent.');
    return { ...command, receipt: r };
  }
  const r = MarketReservationReceiptSchema.parse(input); const q = r.quote;
  if (q.idempotencyKey !== b.idempotencyKey || q.buyer !== identity.wallet || q.cluster !== identity.cluster
    || q.listingId !== command.listingId || q.itemId !== b.itemId || q.priceLamports !== b.priceLamports
    || q.sourceBaseId !== command.request.sourceBaseId || q.buyerBaseId !== command.request.buyerBaseId
    || q.seller !== command.request.seller) throw new Error('Reservation quote does not match the saved purchase.');
  return { ...command, receipt: r };
}
function parsePurchase(input: unknown, identity: MarketIdentity): MarketPurchase {
  const p = object(input); exact(p, ['receipt', 'attempted', 'signature', 'hydrated']);
  const receipt = MarketReservationReceiptSchema.parse(p.receipt);
  if (receipt.quote.buyer !== identity.wallet || receipt.quote.cluster !== identity.cluster || receipt.quote.idempotencyKey === null
    || typeof p.attempted !== 'boolean' || (p.signature !== null && (typeof p.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(p.signature)))) throw new Error('Invalid saved purchase.');
  if (p.signature !== null && (!p.attempted || [receipt.paymentSignature, receipt.txSignature].some((s) => s !== null && s !== p.signature))) throw new Error('Saved payment signatures disagree.');
  let hydrated: MarketPurchase['hydrated'] = null;
  if (p.hydrated !== null) {
    const h = object(p.hydrated); exact(h, ['baseId', 'stillOwned']);
    if (receipt.state !== 'settled' || h.baseId !== receipt.quote.buyerBaseId || typeof h.stillOwned !== 'boolean') throw new Error('Invalid delivery refresh.');
    hydrated = { baseId: receipt.quote.buyerBaseId, stillOwned: h.stillOwned };
  }
  return { receipt, attempted: p.attempted, signature: p.signature as string | null, hydrated };
}
export function isEndedMarketPurchase(purchase: MarketPurchase): boolean {
  return !purchase.receipt.payable && ['superseded', 'cancelled'].includes(purchase.receipt.state);
}
export function parseMarketJournal(input: unknown, identity: MarketIdentity): MarketJournal {
  const r = object(input); exact(r, ['version', 'identity', 'revision', 'activated', 'command', 'purchase', 'refusal',
    ...('archivedPurchases' in r ? ['archivedPurchases'] : [])]);
  if (r.version !== 1 || !equal(r.identity, identity) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0
    || typeof r.activated !== 'boolean') throw new Error('Saved market identity is invalid.');
  let command: MarketCommand | null = null;
  if (r.command !== null) {
    const c = object(r.command);
    exact(c, c.kind === 'list' ? ['kind', 'request', 'receipt'] : ['kind', 'listingId', 'request', 'receipt']);
    if (c.kind === 'list') command = { kind: 'list', request: MarketListRequestSchema.parse(c.request), receipt: null };
    else if (c.kind === 'reserve') command = { kind: 'reserve', listingId: uuid(c.listingId), request: MarketReserveRequestSchema.parse(c.request), receipt: null };
    else if (c.kind === 'cancel') command = { kind: 'cancel', listingId: uuid(c.listingId), request: MarketCancelRequestSchema.parse(c.request), receipt: null };
    else throw new Error('Unknown saved market request.');
    if (c.receipt !== null) command = matchCommandReceipt(command, identity, c.receipt);
  }
  const purchase = r.purchase === null ? null : parsePurchase(r.purchase, identity);
  if (r.archivedPurchases !== undefined && !Array.isArray(r.archivedPurchases)) throw new Error('Invalid saved market history.');
  const archivedPurchases = ((r.archivedPurchases ?? []) as unknown[]).map((entry) => parsePurchase(entry, identity));
  if (archivedPurchases.some((entry) => !isEndedMarketPurchase(entry))
    || new Set(archivedPurchases.map((entry) => entry.receipt.quote.reservationId)).size !== archivedPurchases.length
    || (purchase && archivedPurchases.some((entry) => entry.receipt.quote.reservationId === purchase.receipt.quote.reservationId))) throw new Error('Invalid ended market receipts.');
  let refusal: MarketJournal['refusal'] = null;
  if (r.refusal !== null) {
    const f = object(r.refusal); exact(f, ['status', 'message']);
    if (!command || command.kind === 'cancel' || command.receipt !== null || ![400, 401, 403, 404, 409, 422, 429].includes(f.status as number)
      || typeof f.message !== 'string' || f.message.length > 1000) throw new Error('Invalid saved market refusal.');
    refusal = { status: f.status as number, message: f.message };
  }
  if ((command || purchase || archivedPurchases.length) && !r.activated) throw new Error('Saved market request is not activated.');
  if (command && purchase) throw new Error('Conflicting saved market requests.');
  return { version: 1, identity, revision: r.revision as number, activated: r.activated, command, purchase, archivedPurchases, refusal };
}
export function adoptReservation(purchase: MarketPurchase, input: unknown): MarketPurchase {
  const next = MarketReservationReceiptSchema.parse(input); const old = purchase.receipt;
  if (!equal(old.quote, next.quote)) throw new Error('The frozen market quote changed.');
  if (old.state !== 'reserved' && next.state === 'reserved') throw new Error('The payment receipt regressed.');
  if (['settled', 'cancelled', 'superseded'].includes(old.state) && !equal({ ...old, serverNow: null }, { ...next, serverNow: null })) throw new Error('The final payment receipt changed.');
  const signatures = [purchase.signature, old.paymentSignature, old.txSignature, next.paymentSignature, next.txSignature].filter((s) => s !== null);
  if (new Set(signatures).size > 1) throw new Error('Payment receipt signatures disagree.');
  return { ...purchase, receipt: next };
}

/** One database transaction reads, compares, and replaces the entire record. A
 * tombstone retains activation after Finish, preventing a later legacy fallback. */
export class MarketJournalStore {
  readonly key: string;
  private readonly database: Promise<IDBDatabase>;
  constructor(readonly identity: MarketIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-market-v1') {
    this.key = JSON.stringify(identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Market payments need working browser site storage.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('receipts');
      request.onerror = () => reject(request.error ?? new Error('Unable to open market storage.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open market storage.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    // Opening failure is reported by read/write, even if the screen has not yet awaited it.
    void this.database.catch(() => undefined);
  }
  private empty(): MarketJournal { return { version: 1, identity: this.identity, revision: 0, activated: false, command: null, purchase: null, archivedPurchases: [], refusal: null }; }
  private async transaction(expected: number | null, update?: (old: MarketJournal) => MarketJournal): Promise<MarketJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('receipts', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('receipts'); const request = store.get(this.key);
      let result: MarketJournal; let failure: unknown;
      request.onsuccess = () => {
        try {
          const old = request.result === undefined ? this.empty() : parseMarketJournal(request.result, this.identity);
          if (expected !== null && old.revision !== expected) throw new MarketJournalConflict();
          if (!update) { result = old; return; }
          result = parseMarketJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
          if (old.activated && !result.activated) throw new Error('Market activation cannot be erased.');
          if (old.command && result.command && !equal({ ...old.command, receipt: null }, { ...result.command, receipt: null })) throw new Error('An unresolved command cannot be replaced.');
          // Archive only the exact old terminal purchase in the same transaction
          // that frees its active slot. Earlier evidence is immutable, never pruned.
          const history = result.archivedPurchases;
          const previous = old.archivedPurchases;
          const appended = history.length === previous.length + 1;
          if (!equal(history.slice(0, previous.length), previous)
            || (history.length !== previous.length && !appended)
            || (appended && (!old.purchase || result.purchase || result.command || !isEndedMarketPurchase(old.purchase)
              || !equal(history.at(-1), old.purchase)))) throw new Error('Saved market evidence cannot be replaced or erased.');
          if (old.purchase && !result.purchase && !appended && (old.purchase.attempted || old.purchase.signature || old.purchase.receipt.state === 'committed')
            && !(old.purchase.receipt.state === 'settled' && old.purchase.hydrated)) throw new Error('The original payment cannot be discarded.');
          if (old.purchase && result.purchase) {
            adoptReservation(old.purchase, result.purchase.receipt);
            if (old.purchase.attempted && !result.purchase.attempted) throw new Error('A payment attempt cannot be erased.');
            if (old.purchase.signature && old.purchase.signature !== result.purchase.signature) throw new Error('A payment signature cannot be erased.');
          }
          store.put(result, this.key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Market storage write did not complete.'));
    });
  }
  read(): Promise<MarketJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: MarketJournal) => MarketJournal): Promise<MarketJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
