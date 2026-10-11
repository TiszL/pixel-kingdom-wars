import { TrainingFinishIntentSchema, matchTrainingFinishProof, type TrainingFinishIntent, type TrainingFinishProof } from '@shardkeep/shared/trainingFinish';
export type TrainingFinishIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export function parseTrainingFinishIdentity(raw: unknown): TrainingFinishIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta'
    || typeof r.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)) throw new Error('Invalid Training identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid Training origin or API scope.');
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet: r.wallet };
}
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Only typed, transaction-atomic first-dispatch refusals may release a command.
 * The browser adapter validates status/code/details; unknown errors stay pending. */
const REFUSALS = {
  TRAINING_FINISH_QUOTE_CHANGED: 409, TRAINING_FINISH_SCOPE_CHANGED: 409, TRAINING_CHANGED: 409, TRAINING_NOT_RUNNING: 404, CURRENCY_CONSENT_CHANGED: 409, TROOP_ROSTER_INACTIVE: 409,
  BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503,
} as const;
export type TrainingRefusal = { status: number; code: keyof typeof REFUSALS };
export function parseTrainingRefusal(raw: unknown): TrainingRefusal {
  const r = exact(raw, ['status', 'code']);
  if (typeof r.code !== 'string' || !Object.hasOwn(REFUSALS, r.code)) throw new Error('Invalid Training refusal.');
  const code = r.code as TrainingRefusal['code'], status = REFUSALS[code];
  if (r.status !== status) throw new Error('Invalid Training refusal.');
  return { status, code };
}
export type TrainingOperation = { intent: TrainingFinishIntent; attempted: boolean; proof: TrainingFinishProof | null; refusal: TrainingRefusal | null };
export type TrainingArchive = { operation: TrainingOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: TrainingFinishProof | null };
export type TrainingFinishJournal = { version: 1; identity: TrainingFinishIdentity; revision: number; operation: TrainingOperation | null; archives: TrainingArchive[] };
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Training fields.');
  return raw as Record<string, unknown>;
}
function operation(raw: unknown, identity: TrainingFinishIdentity): TrainingOperation {
  const r = exact(raw, ['intent', 'attempted', 'proof', 'refusal']), intent = TrainingFinishIntentSchema.parse(r.intent);
  if (typeof r.attempted !== 'boolean') throw new Error('Invalid Training attempt evidence.');
  const proof = r.proof === null ? null : matchTrainingFinishProof(r.proof, identity.wallet, intent);
  const refusal = r.refusal === null ? null : parseTrainingRefusal(r.refusal);
  if (proof && proof.status !== 'accepted' || refusal && (!r.attempted || proof)) throw new Error('Invalid Training completion evidence.');
  return { intent, attempted: r.attempted, proof, refusal };
}
function archive(raw: unknown, identity: TrainingFinishIdentity): TrainingArchive {
  const r = exact(raw, ['operation', 'reason', 'evidence']), op = operation(r.operation, identity);
  if (r.reason === 'accepted' && op.proof && r.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
  if (r.reason === 'refused' && op.refusal && r.evidence === null) return { operation: op, reason: 'refused', evidence: null };
  if (r.reason !== 'unattempted' || op.attempted || op.proof || op.refusal) throw new Error('An uncertain Training command cannot be abandoned.');
  const evidence = matchTrainingFinishProof(r.evidence, identity.wallet, op.intent);
  if (evidence.status !== 'unknown') throw new Error('Abandonment requires the original unknown Training receipt.');
  return { operation: op, reason: 'unattempted', evidence };
}
export function parseTrainingFinishJournal(raw: unknown, identity: TrainingFinishIdentity): TrainingFinishJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseTrainingFinishIdentity(r.identity), identity) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid Training recovery journal.');
  const op = r.operation === null ? null : operation(r.operation, identity), archives = r.archives.map(v => archive(v, identity));
  const keys = [...archives.map(a => a.operation), ...(op ? [op] : [])].map(v => v.intent.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original Training keys cannot be reused.');
  return { version: 1, identity, revision: r.revision as number, operation: op, archives };
}
function transition(old: TrainingFinishJournal, next: TrainingFinishJournal): void {
  if (!same(old.archives, next.archives.slice(0, old.archives.length)) || next.archives.length > old.archives.length + 1) throw new Error('Historical Training receipts cannot change.');
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the original Training operation can be archived.'); return;
  }
  if (!a) { if (b && (b.attempted || b.refusal)) throw new Error('Save the original Training command before attempting it.'); return; }
  if (!b || !same(a.intent, b.intent) || a.attempted && !b.attempted || a.proof && !same(a.proof, b.proof)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original Training command or evidence cannot change.');
}
export interface TrainingFinishStore {
  readonly identity: TrainingFinishIdentity; readonly key: string;
  read(): Promise<TrainingFinishJournal>;
  compareAndSet(revision: number, update: (old: TrainingFinishJournal) => TrainingFinishJournal): Promise<TrainingFinishJournal>;
}
export class TrainingFinishJournalStore implements TrainingFinishStore {
  readonly identity: TrainingFinishIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: TrainingFinishIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-training-finish-v1') {
    this.identity = Object.freeze(parseTrainingFinishIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Training purchases cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Training recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Training recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: TrainingFinishJournal) => TrainingFinishJournal): Promise<TrainingFinishJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: TrainingFinishJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: TrainingFinishJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseTrainingFinishJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Training command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseTrainingFinishJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        transition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Training command did not save.'));
    });
  }
  read(): Promise<TrainingFinishJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: TrainingFinishJournal) => TrainingFinishJournal): Promise<TrainingFinishJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
