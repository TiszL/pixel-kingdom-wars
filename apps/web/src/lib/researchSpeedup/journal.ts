import { ResearchSpeedupIntentSchema, matchResearchSpeedupProof, type ResearchSpeedupIntent, type ResearchSpeedupProof } from '@shardkeep/shared/researchSpeedup';
export type ResearchSpeedupIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export function parseResearchSpeedupIdentity(raw: unknown): ResearchSpeedupIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta'
    || typeof r.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)) throw new Error('Invalid Research identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid Research origin or API scope.');
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet: r.wallet };
}
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Only typed, transaction-atomic first-dispatch refusals may release a command.
 * The browser adapter validates status/code/details; unknown errors stay pending. */
const REFUSALS = {
  RESEARCH_CONSENT_STALE: 409, RESEARCH_PRICE_CHANGED: 409, CURRENCY_CONSENT_CHANGED: 409, TROOP_ROSTER_INACTIVE: 409,
  BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503,
} as const;
export type ResearchRefusal = { status: number; code: keyof typeof REFUSALS };
export function parseResearchRefusal(raw: unknown): ResearchRefusal {
  const r = exact(raw, ['status', 'code']);
  if (typeof r.code !== 'string' || !Object.hasOwn(REFUSALS, r.code)) throw new Error('Invalid Research refusal.');
  const code = r.code as ResearchRefusal['code'], status = REFUSALS[code];
  if (r.status !== status) throw new Error('Invalid Research refusal.');
  return { status, code };
}
export type ResearchOperation = { intent: ResearchSpeedupIntent; attempted: boolean; proof: ResearchSpeedupProof | null; refusal: ResearchRefusal | null };
export type ResearchArchive = { operation: ResearchOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: ResearchSpeedupProof | null };
export type ResearchSpeedupJournal = { version: 1; identity: ResearchSpeedupIdentity; revision: number; operation: ResearchOperation | null; archives: ResearchArchive[] };
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Research fields.');
  return raw as Record<string, unknown>;
}
function operation(raw: unknown, identity: ResearchSpeedupIdentity): ResearchOperation {
  const r = exact(raw, ['intent', 'attempted', 'proof', 'refusal']), intent = ResearchSpeedupIntentSchema.parse(r.intent);
  if (typeof r.attempted !== 'boolean') throw new Error('Invalid Research attempt evidence.');
  const proof = r.proof === null ? null : matchResearchSpeedupProof(r.proof, identity.wallet, intent);
  const refusal = r.refusal === null ? null : parseResearchRefusal(r.refusal);
  if (proof && proof.status !== 'accepted' || refusal && (!r.attempted || proof)) throw new Error('Invalid Research completion evidence.');
  return { intent, attempted: r.attempted, proof, refusal };
}
function archive(raw: unknown, identity: ResearchSpeedupIdentity): ResearchArchive {
  const r = exact(raw, ['operation', 'reason', 'evidence']), op = operation(r.operation, identity);
  if (r.reason === 'accepted' && op.proof && r.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
  if (r.reason === 'refused' && op.refusal && r.evidence === null) return { operation: op, reason: 'refused', evidence: null };
  if (r.reason !== 'unattempted' || op.attempted || op.proof || op.refusal) throw new Error('An uncertain Research command cannot be abandoned.');
  const evidence = matchResearchSpeedupProof(r.evidence, identity.wallet, op.intent);
  if (evidence.status !== 'unknown') throw new Error('Abandonment requires the original unknown Research receipt.');
  return { operation: op, reason: 'unattempted', evidence };
}
export function parseResearchSpeedupJournal(raw: unknown, identity: ResearchSpeedupIdentity): ResearchSpeedupJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseResearchSpeedupIdentity(r.identity), identity) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid Research recovery journal.');
  const op = r.operation === null ? null : operation(r.operation, identity), archives = r.archives.map(v => archive(v, identity));
  const keys = [...archives.map(a => a.operation), ...(op ? [op] : [])].map(v => v.intent.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original Research keys cannot be reused.');
  return { version: 1, identity, revision: r.revision as number, operation: op, archives };
}
function transition(old: ResearchSpeedupJournal, next: ResearchSpeedupJournal): void {
  if (!same(old.archives, next.archives.slice(0, old.archives.length)) || next.archives.length > old.archives.length + 1) throw new Error('Historical Research receipts cannot change.');
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the original Research operation can be archived.'); return;
  }
  if (!a) { if (b && (b.attempted || b.refusal)) throw new Error('Save the original Research command before attempting it.'); return; }
  if (!b || !same(a.intent, b.intent) || a.attempted && !b.attempted || a.proof && !same(a.proof, b.proof)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original Research command or evidence cannot change.');
}
export interface ResearchSpeedupStore {
  readonly identity: ResearchSpeedupIdentity; readonly key: string;
  read(): Promise<ResearchSpeedupJournal>;
  compareAndSet(revision: number, update: (old: ResearchSpeedupJournal) => ResearchSpeedupJournal): Promise<ResearchSpeedupJournal>;
}
export class ResearchSpeedupJournalStore implements ResearchSpeedupStore {
  readonly identity: ResearchSpeedupIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: ResearchSpeedupIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-research-speedup-v1') {
    this.identity = Object.freeze(parseResearchSpeedupIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Research purchases cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Research recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Research recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: ResearchSpeedupJournal) => ResearchSpeedupJournal): Promise<ResearchSpeedupJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: ResearchSpeedupJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: ResearchSpeedupJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseResearchSpeedupJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Research command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseResearchSpeedupJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        transition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Research command did not save.'));
    });
  }
  read(): Promise<ResearchSpeedupJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: ResearchSpeedupJournal) => ResearchSpeedupJournal): Promise<ResearchSpeedupJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
