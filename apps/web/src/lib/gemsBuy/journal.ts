import { gemsBuyAddress, gemsBuySignature, gemsBuySourceAta, parseGemsBuyDeposit, parseGemsBuyQuote, parseGemsBuyRecovery,
  parseGemsBuyRequest, sameGemsBuyQuote, type GemsBuyBinding, type GemsBuyDeposit, type GemsBuyQuote, type GemsBuyRecovery, type GemsBuyRequest } from './contracts';

export type GemsBuyIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type GemsBuyPreparedEvidence = { blockhash: string; lastValidBlockHeight: number; messageFingerprint: string };
export type GemsBuyPurchase = { request: GemsBuyRequest; binding: GemsBuyBinding; quote: GemsBuyQuote | null;
  prepared: GemsBuyPreparedEvidence | null; signature: string | null; broadcastStarted: boolean;
  deposit: GemsBuyDeposit | null; hydrated: boolean };
export type GemsBuyArchive = { purchase: GemsBuyPurchase; reason: 'unattempted' | 'credited'; evidence: GemsBuyRecovery | null };
export type GemsBuyJournal = { version: 1; identity: GemsBuyIdentity; revision: number; purchase: GemsBuyPurchase | null; archives: GemsBuyArchive[] };
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Gems purchase fields.');
  return raw as Record<string, unknown>;
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function parseGemsBuyIdentity(raw: unknown): GemsBuyIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || !['devnet', 'mainnet-beta'].includes(r.cluster as string)) throw new Error('Invalid saved Gems purchase identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.hash || api.search || api.toString().replace(/\/$/, '') !== r.api) throw new Error('Invalid saved Gems purchase API scope.');
  return { origin: r.origin, api: r.api, cluster: r.cluster as GemsBuyIdentity['cluster'], wallet: gemsBuyAddress(r.wallet) };
}
export function parseGemsBuyBinding(raw: unknown, wallet: string): GemsBuyBinding {
  const r = exact(raw, ['wallet', 'mint', 'decimals']);
  if (r.wallet !== wallet || typeof r.decimals !== 'number' || !Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 19) throw new Error('The saved token configuration changed.');
  const mint = gemsBuyAddress(r.mint); gemsBuySourceAta(wallet, mint);
  return { wallet, mint, decimals: r.decimals };
}
export function parseGemsBuyPurchase(raw: unknown, identity: GemsBuyIdentity): GemsBuyPurchase {
  const r = exact(raw, ['request', 'binding', 'quote', 'prepared', 'signature', 'broadcastStarted', 'deposit', 'hydrated']);
  const request = parseGemsBuyRequest(r.request), binding = parseGemsBuyBinding(r.binding, identity.wallet);
  const quote = r.quote === null ? null : parseGemsBuyQuote(r.quote, request, binding);
  if (typeof r.broadcastStarted !== 'boolean' || typeof r.hydrated !== 'boolean') throw new Error('Invalid saved purchase phase.');
  let prepared: GemsBuyPreparedEvidence | null = null;
  if (r.prepared !== null) {
    const p = exact(r.prepared, ['blockhash', 'lastValidBlockHeight', 'messageFingerprint']);
    if (!quote || !Number.isSafeInteger(p.lastValidBlockHeight) || (p.lastValidBlockHeight as number) < 0
      || typeof p.messageFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(p.messageFingerprint)) throw new Error('Invalid saved payment preparation.');
    prepared = { blockhash: gemsBuyAddress(p.blockhash), lastValidBlockHeight: p.lastValidBlockHeight as number, messageFingerprint: p.messageFingerprint };
  }
  const signature = r.signature === null ? null : gemsBuySignature(r.signature);
  if (signature && !prepared || r.broadcastStarted && !signature) throw new Error('Invalid saved wallet attempt order.');
  const deposit = r.deposit === null ? null : quote ? parseGemsBuyDeposit({ ...exact(r.deposit,
    ['status', 'txSignature', 'paymentSignature', 'amount', 'createdAt', 'finalizedAt', 'keepIn', 'gemsOut', 'dustBaseUnits', 'keepCredited', 'gemsCredited', 'receipt']),
    id: quote.id, kind: 'gems_buy', reference: quote.reference }, quote) : null;
  if (r.deposit !== null && !deposit || r.hydrated && !deposit?.receipt) throw new Error('A purchase needs its original paid receipt.');
  return { request, binding, quote, prepared, signature, broadcastStarted: r.broadcastStarted, deposit, hydrated: r.hydrated };
}
export function gemsBuyPhase(p: GemsBuyPurchase): 'quote' | 'signingStarted' | 'signatureSaved' | 'broadcastStarted' | 'credited' | 'hydrated' {
  return p.hydrated ? 'hydrated' : p.deposit?.receipt ? 'credited' : p.broadcastStarted ? 'broadcastStarted' : p.signature ? 'signatureSaved' : p.prepared ? 'signingStarted' : 'quote';
}
export function hasGemsBuyPaymentEvidence(deposit: GemsBuyDeposit | null): boolean {
  return !!deposit && (deposit.amount !== null || deposit.paymentSignature !== null || deposit.txSignature !== null
    || deposit.finalizedAt !== null || deposit.receipt !== null || deposit.status === 'finalized' || deposit.status === 'credited');
}
function parseArchive(raw: unknown, identity: GemsBuyIdentity): GemsBuyArchive {
  const r = exact(raw, ['purchase', 'reason', 'evidence']), purchase = parseGemsBuyPurchase(r.purchase, identity);
  if (r.reason === 'credited' && r.evidence === null && purchase.hydrated && purchase.deposit?.receipt) return { purchase, reason: 'credited', evidence: null };
  if (r.reason !== 'unattempted' || purchase.prepared || purchase.signature || purchase.broadcastStarted || hasGemsBuyPaymentEvidence(purchase.deposit)) throw new Error('An attempted payment must stay in recovery.');
  const evidence = parseGemsBuyRecovery(r.evidence, purchase.request, purchase.binding, purchase.quote ?? undefined);
  if (evidence.status === 'known' && hasGemsBuyPaymentEvidence(evidence.deposit)) throw new Error('An observed payment cannot be abandoned.');
  return { purchase, reason: 'unattempted', evidence };
}
export function parseGemsBuyJournal(raw: unknown, identity: GemsBuyIdentity): GemsBuyJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'purchase', 'archives']);
  if (r.version !== 1 || !equal(parseGemsBuyIdentity(r.identity), identity) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('The Gems journal belongs to another account or version.');
  const purchase = r.purchase === null ? null : parseGemsBuyPurchase(r.purchase, identity), archives = r.archives.map(a => parseArchive(a, identity));
  const keys = [...archives.map(a => a.purchase.request.idempotencyKey), ...(purchase ? [purchase.request.idempotencyKey] : [])];
  if (new Set(keys).size !== keys.length) throw new Error('Original Gems purchase keys cannot be reused.');
  return { version: 1, identity, revision: r.revision as number, purchase, archives };
}
function assertTransition(old: GemsBuyJournal, next: GemsBuyJournal): void {
  if (!equal(old.archives, next.archives.slice(0, old.archives.length)) || next.archives.length > old.archives.length + 1) throw new Error('Archived purchase evidence cannot change.');
  const a = old.purchase, b = next.purchase;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !equal(next.archives.at(-1)?.purchase, a)) throw new Error('Only the original purchase can be archived.');
    return;
  }
  if (!a) {
    if (b && (b.quote || b.prepared || b.signature || b.broadcastStarted || b.deposit || b.hydrated)) throw new Error('Save the original request before its payment evidence.');
    return;
  }
  if (!b || !equal(a.request, b.request) || !equal(a.binding, b.binding) || a.quote && (!b.quote || !sameGemsBuyQuote(a.quote, b.quote))
    || a.prepared && !equal(a.prepared, b.prepared) || a.signature && a.signature !== b.signature
    || a.broadcastStarted && !b.broadcastStarted || a.hydrated && !b.hydrated) throw new Error('The original purchase or wallet attempt cannot change.');
  if (!a.prepared && b.prepared && (!a.quote || b.signature || b.broadcastStarted)
    || !a.signature && b.signature && (!a.prepared || b.broadcastStarted)
    || !a.hydrated && b.hydrated && !a.deposit?.receipt) throw new Error('Save each original payment phase before advancing.');
  if (a.deposit && (!b.deposit || ['amount', 'paymentSignature', 'txSignature', 'finalizedAt', 'receipt'].some(k => {
    const key = k as keyof GemsBuyDeposit; return a.deposit![key] !== null && !equal(a.deposit![key], b.deposit![key]);
  }))) throw new Error('Original observed payment evidence cannot change.');
}
/** One atomic strict-durability record per original API/origin/cluster/wallet. */
export class GemsBuyJournalStore {
  readonly identity: GemsBuyIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: GemsBuyIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-gems-buy-v1') {
    this.identity = Object.freeze(parseGemsBuyIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. No wallet purchase can begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('purchases');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Gems purchase recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Gems purchase recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: GemsBuyJournal) => GemsBuyJournal): Promise<GemsBuyJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('purchases', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('purchases'), read = store.get(this.key); let result: GemsBuyJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old = read.result === undefined ? { version: 1 as const, identity: this.identity, revision: 0, purchase: null, archives: [] } : parseGemsBuyJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Gems purchase. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseGemsBuyJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Gems purchase did not save.'));
    });
  }
  read(): Promise<GemsBuyJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: GemsBuyJournal) => GemsBuyJournal): Promise<GemsBuyJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
