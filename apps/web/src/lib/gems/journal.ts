import { exact, object, parseGemsIntent, parseGemsReceipt, type GemsIntent } from './contracts';

export type GemsIdentity = Readonly<{ api: string; wallet: string; cluster: 'devnet' | 'mainnet-beta' }>;
export type GemsRefusal = { status: number; code: string };
export type GemsJournal = { version: 1; identity: GemsIdentity; revision: number; intent: GemsIntent | null;
  attempted: boolean; receipt: Record<string, unknown> | null; hydrated: boolean; finished: boolean; refusal: GemsRefusal | null; refusals: Array<{ intent: GemsIntent; refusal: GemsRefusal }> };

const GEMS_REFUSALS: Readonly<Record<GemsIntent['kind'], Readonly<Record<string, number>>>> = {
  'gems-from-keep': { GEMS_PURCHASE_BELOW_MINIMUM: 422, GEMS_PURCHASE_ABOVE_MAXIMUM: 422, INSUFFICIENT_KEEP: 422, GEMS_TERMS_CHANGED: 409 },
  'gems-to-shards': { INSUFFICIENT_GEMS: 422, BASE_NOT_OWNED: 404, GEMS_TERMS_CHANGED: 409 },
  'gems-task-claim': { TASK_UNKNOWN: 404, CLAIM_ALREADY_SETTLED: 409, GEMS_TERMS_CHANGED: 409 },
};
export function gemsRefusalDefinitive(kind: GemsIntent['kind'], status: number, code: string): boolean {
  return Object.hasOwn(GEMS_REFUSALS[kind], code) && GEMS_REFUSALS[kind][code] === status;
}
function parseGemsRefusal(raw: unknown, intent: GemsIntent | null): GemsRefusal {
  const r = exact(raw, ['status', 'code']);
  if (!intent || typeof r.code !== 'string' || typeof r.status !== 'number' || !gemsRefusalDefinitive(intent.kind, r.status, r.code)) throw new Error('Invalid definitive Gems refusal.');
  return { status: r.status, code: r.code };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function parseGemsIdentity(raw: unknown): GemsIdentity {
  const r = exact(raw, ['api', 'wallet', 'cluster']);
  if (typeof r.api !== 'string' || typeof r.wallet !== 'string' || !r.wallet.trim()
    || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid saved Gems identity.');
  const url = new URL(r.api);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid Gems API identity.');
  return { api: url.href, wallet: r.wallet, cluster: r.cluster };
}
export function parseGemsJournal(raw: unknown, identity: GemsIdentity): GemsJournal {
  const source = object(raw);
  const r = exact({ refusal: null, refusals: [], ...source }, ['version', 'identity', 'revision', 'intent', 'attempted', 'receipt', 'hydrated', 'finished', 'refusal', 'refusals']);
  if (r.version !== 1 || !same(parseGemsIdentity(r.identity), identity) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0
    || typeof r.attempted !== 'boolean' || typeof r.hydrated !== 'boolean' || typeof r.finished !== 'boolean') throw new Error('Invalid saved Gems journal.');
  const intent = r.intent === null ? null : parseGemsIntent(r.intent), receipt = r.receipt === null ? null : object(r.receipt);
  if (receipt && (!intent || !parseGemsReceipt(receipt, intent, identity.wallet))) throw new Error('The saved Gems proof does not match its request.');
  const refusal = r.refusal === null ? null : parseGemsRefusal(r.refusal, intent);
  if (!Array.isArray(r.refusals)) throw new Error('Invalid saved Gems refusal history.');
  const refusals = r.refusals.map(rawEntry => { const entry = exact(rawEntry, ['intent', 'refusal']), original = parseGemsIntent(entry.intent); return { intent: original, refusal: parseGemsRefusal(entry.refusal, original) }; });
  if (r.attempted && !intent || receipt && !r.attempted || r.hydrated && !receipt || r.finished && !r.hydrated && !refusal
    || refusal && (!intent || !r.attempted || receipt || r.hydrated || !r.finished)) throw new Error('The original Gems operation still needs recovery.');
  return { version: 1, identity, revision: r.revision as number, intent, attempted: r.attempted, receipt, hydrated: r.hydrated, finished: r.finished, refusal, refusals };
}
/** Same strict IndexedDB/CAS contract as ForgeClaims and HeroRecruitment. One
 * pending Gems operation per origin/wallet/cluster; no storage error is empty. */
export class GemsJournalStore {
  readonly identity: GemsIdentity;
  readonly key: string;
  private readonly database: Promise<IDBDatabase>;
  constructor(identity: GemsIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-gems-v1') {
    this.identity = Object.freeze(parseGemsIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Gems recovery needs working browser site storage.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Unable to open saved Gems operations.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Gems recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
    void this.database.catch(() => undefined);
  }
  private empty(): GemsJournal {
    return { version: 1, identity: this.identity, revision: 0, intent: null, attempted: false, receipt: null, hydrated: false, finished: false, refusal: null, refusals: [] };
  }
  private async transaction(expected: number | null, update?: (old: GemsJournal) => GemsJournal): Promise<GemsJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key);
      let result: GemsJournal; let failure: unknown;
      read.onsuccess = () => {
        try {
          const old = read.result === undefined ? this.empty() : parseGemsJournal(read.result, this.identity);
          if (expected !== null && expected !== old.revision) throw new Error('Another tab changed the saved Gems operation. Check its receipt.');
          if (!update) { result = old; return; }
          result = parseGemsJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
          const sameIntent = same(old.intent, result.intent);
          if (!same(old.refusals, result.refusals)) throw new Error('The Gems refusal history changed.');
          if (sameIntent && old.refusal && !same(old.refusal, result.refusal)) throw new Error('The original Gems refusal changed.');
          if (old.intent && !sameIntent && (!old.finished || !result.intent || result.attempted || result.receipt || result.hydrated || result.finished || result.refusal)) throw new Error('The original Gems operation cannot be replaced before recovery finishes.');
          if (!sameIntent && old.intent && result.intent?.idempotencyKey === old.intent.idempotencyKey) throw new Error('A new Gems operation needs a distinct key.');
          if (sameIntent && old.attempted && !result.attempted) throw new Error('An attempted Gems request cannot become unsent.');
          if (sameIntent && old.receipt && !same(old.receipt, result.receipt)) throw new Error('The original Gems receipt changed.');
          if (sameIntent && (old.hydrated && !result.hydrated || old.finished && !result.finished)) throw new Error('A finished Gems operation cannot be replayed.');
          if (!sameIntent && old.intent && old.refusal) result = { ...result, refusals: [...old.refusals, { intent: old.intent, refusal: old.refusal }] };
          store.put(result, this.key);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The Gems operation did not save.'));
    });
  }
  read(): Promise<GemsJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: GemsJournal) => GemsJournal): Promise<GemsJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
