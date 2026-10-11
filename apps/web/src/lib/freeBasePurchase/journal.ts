import { FreeBasePurchaseReceiptEnvelopeSchema, FreeBasePurchaseReceiptSchema, FreeBasePurchaseRequestSchema, FreeBasePurchaseTermsSchema,
  type FreeBasePurchaseReceipt, type FreeBasePurchaseRequest, type FreeBasePurchaseTerms } from '@shardkeep/shared/freeBasePurchaseApi';
export type FreeBasePurchaseIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type FreeBasePurchaseCommand = { request: FreeBasePurchaseRequest; terms: FreeBasePurchaseTerms };
export type FreeBasePurchaseProof = { status: 'accepted'; receipt: FreeBasePurchaseReceipt } | { status: 'unknown'; receipt: null };
export type FreeBasePurchaseRefusal = { phase: 'first_post'; status: number; code: string };
export type FreeBasePurchaseOperation = { command: FreeBasePurchaseCommand; attemptRevision: number | null;
  proof: FreeBasePurchaseProof | null; refusal: FreeBasePurchaseRefusal | null };
export type FreeBasePurchaseArchive = { operation: FreeBasePurchaseOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: FreeBasePurchaseProof | null };
export type FreeBasePurchaseJournal = { version: 1; identity: FreeBasePurchaseIdentity; revision: number;
  operation: FreeBasePurchaseOperation | null; archives: FreeBasePurchaseArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved second free base purchase fields.');
  return raw as Record<string, unknown>;
}
const REFUSALS: Readonly<Record<string, number>> = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503, PHASE_E_DISABLED: 503,
  FREE_BASE_SOURCE_REQUIRED: 409, FREE_BASE_SOURCE_RESERVED: 409, BASE_SLOTS_FULL: 409,
  FREE_BASE_DEVELOPMENT_REQUIRED: 409, INSUFFICIENT_SHARDS: 422 };
export function freeBasePurchaseRefusalDefinitive(status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS, code) && REFUSALS[code] === status;
}
function parseRefusal(raw: unknown): FreeBasePurchaseRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !freeBasePurchaseRefusalDefinitive(r.status, r.code)) throw new Error('Invalid original second free base purchase refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseFreeBasePurchaseIdentity(raw: unknown): FreeBasePurchaseIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid second free base purchase identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid second free base purchase origin or API scope.');
  if (typeof r.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)) throw new Error('Invalid purchase wallet.');
  const wallet = r.wallet;
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseFreeBasePurchaseCommand(raw: unknown): FreeBasePurchaseCommand {
  const r = exact(raw, ['request', 'terms']);
  return { request: FreeBasePurchaseRequestSchema.parse(r.request), terms: FreeBasePurchaseTermsSchema.parse(r.terms) };
}
export function matchFreeBasePurchaseProof(raw: unknown, identity: FreeBasePurchaseIdentity, command: FreeBasePurchaseCommand): FreeBasePurchaseProof {
  const r = exact(raw, ['status', 'receipt']);
  const { receipt } = FreeBasePurchaseReceiptEnvelopeSchema.parse({ receipt: r.receipt });
  if (r.status !== (receipt ? 'accepted' : 'unknown')) throw new Error('Invalid purchase outcome.');
  if (!receipt) return { status: 'unknown', receipt: null };
  FreeBasePurchaseReceiptSchema.parse(receipt);
  if (receipt.wallet !== identity.wallet || receipt.idempotencyKey !== command.request.idempotencyKey
    || receipt.sourceBaseId !== command.request.sourceBaseId || receipt.version !== command.terms.policyVersion
    || receipt.shardsCharged !== command.terms.costShards || receipt.development.keepLevel < command.terms.minKeepLevel
    || receipt.development.workshopLevel < command.terms.minWorkshopLevel || receipt.development.goldForgeLevel < command.terms.minGoldForgeLevel
    || receipt.slot > command.terms.maxActiveBases) throw new Error('The purchase receipt differs from the original reviewed request.');
  return { status: 'accepted', receipt };
}
function parseOperation(raw: unknown, identity: FreeBasePurchaseIdentity, revision: number): FreeBasePurchaseOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof', 'refusal']), command = parseFreeBasePurchaseCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original second free base purchase attempt revision.');
  const proof = r.proof === null ? null : matchFreeBasePurchaseProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted second free base purchase proofs are durable.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal);
  if (refusal && r.attemptRevision === null) throw new Error('Refusal requires an original attempted command.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof, refusal };
}
export function parseFreeBasePurchaseJournal(raw: unknown, identity: FreeBasePurchaseIdentity): FreeBasePurchaseJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseFreeBasePurchaseIdentity(r.identity), parseFreeBasePurchaseIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid second free base purchase journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: FreeBasePurchaseArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' && a.reason !== 'refused'
      || a.reason === 'unattempted' && (op.attemptRevision !== null || op.refusal !== null)
      || a.reason === 'refused' && !op.refusal) throw new Error('An ambiguous second free base purchase command cannot be abandoned.');
    const evidence = matchFreeBasePurchaseProof(a.evidence, identity, op.command);
    if (evidence.status !== 'unknown') throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original second free base purchase keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: FreeBasePurchaseOperation, b: FreeBasePurchaseOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original second free base purchase command or refusal changed.');
  if (a.proof && (b.proof?.status !== 'accepted' || a.proof.status !== 'accepted'
    || !same(a.proof.receipt, b.proof.receipt)))
    throw new Error('Original second free base purchase acceptance changed or disappeared.');
}
function assertTransition(old: FreeBasePurchaseJournal, next: FreeBasePurchaseJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original second free base purchase archives cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision
      || !same(a.operation.refusal, b.operation.refusal)) throw new Error('Original second free base purchase archive changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original operation may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted originals must be archived as accepted.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof || b.refusal)) throw new Error('Save original second free base purchase intent before evidence or attempt.'); return; }
  if (!b) throw new Error('Original second free base purchase intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || a.refusal || b.proof || b.refusal))
    throw new Error('Every explicit attempt requires its own durable revision.');
  if (!a.refusal && b.refusal && (a.attemptRevision === null || a.proof)) throw new Error('Persist an original attempt before refusal.');
}
export interface FreeBasePurchaseStore {
  readonly identity: FreeBasePurchaseIdentity; readonly key: string;
  read(): Promise<FreeBasePurchaseJournal>;
  compareAndSet(revision: number, update: (old: FreeBasePurchaseJournal) => FreeBasePurchaseJournal): Promise<FreeBasePurchaseJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class FreeBasePurchaseJournalStore implements FreeBasePurchaseStore {
  readonly identity: FreeBasePurchaseIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: FreeBasePurchaseIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-free-base-purchase-v1') {
    this.identity = Object.freeze(parseFreeBasePurchaseIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Second free base purchase commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open second free base purchase recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open second free base purchase recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: FreeBasePurchaseJournal) => FreeBasePurchaseJournal): Promise<FreeBasePurchaseJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: FreeBasePurchaseJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: FreeBasePurchaseJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseFreeBasePurchaseJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original second free base purchase command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseFreeBasePurchaseJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original second free base purchase command did not save.'));
    });
  }
  read(): Promise<FreeBasePurchaseJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: FreeBasePurchaseJournal) => FreeBasePurchaseJournal): Promise<FreeBasePurchaseJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
