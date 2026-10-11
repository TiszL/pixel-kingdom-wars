import { HeroProgressionIntentSchema, matchHeroProgressionProof, type HeroProgressionIntent, type HeroProgressionProof } from '@shardkeep/shared/heroProgression';
export type HeroProgressionIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export function parseHeroProgressionIdentity(raw: unknown): HeroProgressionIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta'
    || typeof r.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)) throw new Error('Invalid Hero identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid Hero origin or API scope.');
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet: r.wallet };
}
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Only typed, transaction-atomic first-dispatch refusals may release a command.
 * The browser adapter validates status/code/details; unknown errors stay pending. */
const REFUSALS = {
  HERO_CONSENT_STALE: { status: 409, kind: null }, HERO_PRICE_CHANGED: { status: 409, kind: null },
  CURRENCY_CONSENT_CHANGED: { status: 409, kind: null },
  HERO_NOT_RECOVERING: { status: 409, kind: 'recovery' }, HERO_NOT_RECRUITED: { status: 422, kind: 'upgrade' },
  BASE_NOT_OWNED: { status: 404, kind: null }, BASE_ID_REQUIRED: { status: 409, kind: null },
  DEED_OWNERSHIP_CHANGED: { status: 409, kind: null }, BASE_BEING_RAIDED: { status: 423, kind: null },
  DEED_AUTHORITY_UNAVAILABLE: { status: 503, kind: null },
} as const;
export type HeroRefusal = { status: number; code: keyof typeof REFUSALS };
export function parseHeroRefusal(raw: unknown, kind?: HeroProgressionIntent['kind']): HeroRefusal {
  const r = exact(raw, ['status', 'code']);
  if (typeof r.code !== 'string' || !Object.hasOwn(REFUSALS, r.code)) throw new Error('Invalid Hero refusal.');
  const code = r.code as HeroRefusal['code'], spec = REFUSALS[code];
  if (r.status !== spec.status || kind !== undefined && spec.kind !== null && spec.kind !== kind) throw new Error('Invalid Hero refusal.');
  return { status: spec.status, code };
}
export type HeroOperation = { intent: HeroProgressionIntent; attempted: boolean; proof: HeroProgressionProof | null; refusal: HeroRefusal | null };
export type HeroArchive = { operation: HeroOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: HeroProgressionProof | null };
export type HeroProgressionJournal = { version: 1; identity: HeroProgressionIdentity; revision: number; operation: HeroOperation | null; archives: HeroArchive[] };
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Hero fields.');
  return raw as Record<string, unknown>;
}
function operation(raw: unknown, identity: HeroProgressionIdentity): HeroOperation {
  const r = exact(raw, ['intent', 'attempted', 'proof', 'refusal']), intent = HeroProgressionIntentSchema.parse(r.intent);
  if (typeof r.attempted !== 'boolean') throw new Error('Invalid Hero attempt evidence.');
  const proof = r.proof === null ? null : matchHeroProgressionProof(r.proof, identity.wallet, intent);
  const refusal = r.refusal === null ? null : parseHeroRefusal(r.refusal, intent.kind);
  if (proof && proof.status !== 'accepted' || refusal && (!r.attempted || proof)) throw new Error('Invalid Hero completion evidence.');
  return { intent, attempted: r.attempted, proof, refusal };
}
function archive(raw: unknown, identity: HeroProgressionIdentity): HeroArchive {
  const r = exact(raw, ['operation', 'reason', 'evidence']), op = operation(r.operation, identity);
  if (r.reason === 'accepted' && op.proof && r.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
  if (r.reason === 'refused' && op.refusal && r.evidence === null) return { operation: op, reason: 'refused', evidence: null };
  if (r.reason !== 'unattempted' || op.attempted || op.proof || op.refusal) throw new Error('An uncertain Hero command cannot be abandoned.');
  const evidence = matchHeroProgressionProof(r.evidence, identity.wallet, op.intent);
  if (evidence.status !== 'unknown') throw new Error('Abandonment requires the original unknown Hero receipt.');
  return { operation: op, reason: 'unattempted', evidence };
}
export function parseHeroProgressionJournal(raw: unknown, identity: HeroProgressionIdentity): HeroProgressionJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseHeroProgressionIdentity(r.identity), identity) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid Hero recovery journal.');
  const op = r.operation === null ? null : operation(r.operation, identity), archives = r.archives.map(v => archive(v, identity));
  const keys = [...archives.map(a => a.operation), ...(op ? [op] : [])].map(v => v.intent.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original Hero keys cannot be reused.');
  return { version: 1, identity, revision: r.revision as number, operation: op, archives };
}
function transition(old: HeroProgressionJournal, next: HeroProgressionJournal): void {
  if (!same(old.archives, next.archives.slice(0, old.archives.length)) || next.archives.length > old.archives.length + 1) throw new Error('Historical Hero receipts cannot change.');
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the original Hero operation can be archived.'); return;
  }
  if (!a) { if (b && (b.attempted || b.refusal)) throw new Error('Save the original Hero command before attempting it.'); return; }
  if (!b || !same(a.intent, b.intent) || a.attempted && !b.attempted || a.proof && !same(a.proof, b.proof)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original Hero command or evidence cannot change.');
}
export interface HeroProgressionStore {
  readonly identity: HeroProgressionIdentity; readonly key: string;
  read(): Promise<HeroProgressionJournal>;
  compareAndSet(revision: number, update: (old: HeroProgressionJournal) => HeroProgressionJournal): Promise<HeroProgressionJournal>;
}
export class HeroProgressionJournalStore implements HeroProgressionStore {
  readonly identity: HeroProgressionIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: HeroProgressionIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-hero-progression-v1') {
    this.identity = Object.freeze(parseHeroProgressionIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Hero purchases cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Hero recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Hero recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: HeroProgressionJournal) => HeroProgressionJournal): Promise<HeroProgressionJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: HeroProgressionJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: HeroProgressionJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseHeroProgressionJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Hero command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseHeroProgressionJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        transition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Hero command did not save.'));
    });
  }
  read(): Promise<HeroProgressionJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: HeroProgressionJournal) => HeroProgressionJournal): Promise<HeroProgressionJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
