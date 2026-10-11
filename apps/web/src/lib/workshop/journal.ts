import { matchWorkshopCollectEnvelope, matchWorkshopStartEnvelope, WorkshopCollectRequestSchema, WorkshopStartEnvelopeSchema,
  WorkshopStartRequestSchema, type WorkshopCollectEnvelope, type WorkshopCollectRequest, type WorkshopStartEnvelope, type WorkshopStartRequest } from '@shardkeep/shared/workshop';

export type WorkshopIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type WorkshopCommand = { kind: 'start'; request: WorkshopStartRequest } | { kind: 'collect'; baseId: string; jobId: string; request: WorkshopCollectRequest };
export type WorkshopProof = WorkshopStartEnvelope | WorkshopCollectEnvelope;
export type WorkshopRefusal = { phase: 'first_post'; status: number; code: string };
export type WorkshopOperation = { command: WorkshopCommand; attempted: boolean; proof: WorkshopProof | null; refusal?: WorkshopRefusal | null };
export type WorkshopArchive = { operation: WorkshopOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: WorkshopProof | null };
export type WorkshopJournal = { version: 1; identity: WorkshopIdentity; revision: number; operation: WorkshopOperation | null; archives: WorkshopArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Workshop fields.');
  return raw as Record<string, unknown>;
}
// Each exact status/code is an audited pre-admission refusal or transaction
// rollback. It says nothing about a previous ambiguous attempt with this key.
const COMMON_REFUSALS: Readonly<Record<string, number>> = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409,
  DEED_OWNERSHIP_CHANGED: 409, BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503 };
const REFUSALS: Readonly<Record<WorkshopCommand['kind'], Readonly<Record<string, number>>>> = {
  start: { ...COMMON_REFUSALS, PHASE_E_DISABLED: 503, RECIPE_VERSION_STALE: 409, WORKSHOP_REQUIRED: 409,
    BATCH_EXCEEDED: 422, REFINE_CAP_EXCEEDED: 422, HOLDING_CAP_EXCEEDED: 422, INSUFFICIENT_SHARDS: 422 },
  collect: { ...COMMON_REFUSALS, JOB_NOT_FOUND: 404, JOB_ALREADY_COLLECTED: 409, JOB_NOT_READY: 409 },
};
export function workshopRefusalDefinitive(kind: WorkshopCommand['kind'], status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS[kind], code) && REFUSALS[kind][code] === status;
}
function parseRefusal(raw: unknown, command: WorkshopCommand): WorkshopRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !workshopRefusalDefinitive(command.kind, r.status, r.code)) throw new Error('Invalid definitive Workshop refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseWorkshopIdentity(raw: unknown): WorkshopIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid Workshop identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid Workshop origin or API scope.');
  const { wallet } = WorkshopStartEnvelopeSchema.parse({ wallet: r.wallet, idempotencyKey: 'identity-probe', status: 'unknown', receipt: null, serverNow: '2000-01-01T00:00:00.000Z' });
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export const workshopBase = (c: WorkshopCommand): string => c.kind === 'start' ? c.request.baseId : c.baseId;
export function parseWorkshopCommand(raw: unknown): WorkshopCommand {
  if ((raw as { kind?: unknown } | null)?.kind === 'start') {
    const c = exact(raw, ['kind', 'request']); return { kind: 'start', request: WorkshopStartRequestSchema.parse(c.request) };
  }
  const c = exact(raw, ['kind', 'baseId', 'jobId', 'request']);
  if (c.kind !== 'collect') throw new Error('Invalid Workshop command.');
  const request = WorkshopCollectRequestSchema.parse(c.request);
  // The shared start wire schema also defines canonical base/job UUIDs.
  const uuid = (baseId: unknown) => WorkshopStartRequestSchema.parse({ baseId, ...request, ingots: 1, recipeVersion: 1 }).baseId;
  return { kind: 'collect', baseId: uuid(c.baseId), jobId: uuid(c.jobId), request };
}
export function matchWorkshopProof(raw: unknown, identity: WorkshopIdentity, command: WorkshopCommand): WorkshopProof {
  return command.kind === 'start' ? matchWorkshopStartEnvelope(raw, { wallet: identity.wallet, request: command.request })
    : matchWorkshopCollectEnvelope(raw, { wallet: identity.wallet, ...command });
}
function parseOperation(raw: unknown, identity: WorkshopIdentity): WorkshopOperation {
  const source = exact(raw, raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'refusal') ? ['command', 'attempted', 'proof', 'refusal'] : ['command', 'attempted', 'proof']);
  const r: Record<string, unknown> = { ...source, refusal: source.refusal ?? null }, command = parseWorkshopCommand(r.command);
  if (typeof r.attempted !== 'boolean') throw new Error('Invalid Workshop attempt evidence.');
  const proof = r.proof === null ? null : matchWorkshopProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted Workshop receipts are durable completion evidence.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal, command);
  if (refusal && (!r.attempted || proof)) throw new Error('A Workshop refusal cannot coexist with acceptance or an unsent draft.');
  return { command, attempted: r.attempted, proof, refusal };
}
function parseArchive(raw: unknown, identity: WorkshopIdentity): WorkshopArchive {
  const r = exact(raw, ['operation', 'reason', 'evidence']), operation = parseOperation(r.operation, identity);
  if (r.reason === 'accepted' && operation.proof && r.evidence === null) return { operation, reason: 'accepted', evidence: null };
  if (r.reason === 'refused' && operation.refusal) {
    const evidence = matchWorkshopProof(r.evidence, identity, operation.command);
    if (evidence.status !== 'unknown') throw new Error('A refused Workshop command requires matching absence proof before archival.');
    return { operation, reason: 'refused', evidence };
  }
  if (r.reason !== 'unattempted' || operation.attempted || operation.proof) throw new Error('An uncertain or accepted Workshop command cannot be abandoned.');
  const evidence = matchWorkshopProof(r.evidence, identity, operation.command);
  if (evidence.status !== 'unknown') throw new Error('Abandonment needs the original unknown Workshop proof.');
  return { operation, reason: 'unattempted', evidence };
}
export function parseWorkshopJournal(raw: unknown, identity: WorkshopIdentity): WorkshopJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseWorkshopIdentity(r.identity), identity) || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid Workshop recovery journal.');
  const operation = r.operation === null ? null : parseOperation(r.operation, identity), archives = r.archives.map(v => parseArchive(v, identity));
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(v => v.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original Workshop keys cannot be reused.');
  return { version: 1, identity, revision: r.revision as number, operation, archives };
}
function assertTransition(old: WorkshopJournal, next: WorkshopJournal): void {
  if (!same(old.archives, next.archives.slice(0, old.archives.length)) || next.archives.length > old.archives.length + 1) throw new Error('Historical Workshop receipts cannot change.');
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the original Workshop operation can be archived.');
    return;
  }
  // A matching accepted preflight is positive evidence: retain it atomically
  // with the original command instead of depending on another network read.
  if (!a) { if (b && (b.attempted || b.refusal)) throw new Error('Save the original Workshop command before attempting it.'); return; }
  if (!b || !same(a.command, b.command) || a.attempted && !b.attempted || a.proof && !same(a.proof, b.proof)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original Workshop command, receipt or refusal cannot change.');
  if (!a.refusal && b.refusal && !a.attempted) throw new Error('Persist the original attempt before its definitive refusal.');
}
export interface WorkshopStore {
  readonly identity: WorkshopIdentity; readonly key: string;
  read(): Promise<WorkshopJournal>;
  compareAndSet(revision: number, update: (old: WorkshopJournal) => WorkshopJournal): Promise<WorkshopJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class WorkshopJournalStore implements WorkshopStore {
  readonly identity: WorkshopIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: WorkshopIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-workshop-v1') {
    this.identity = Object.freeze(parseWorkshopIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Workshop commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Workshop recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Workshop recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: WorkshopJournal) => WorkshopJournal): Promise<WorkshopJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: WorkshopJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: WorkshopJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseWorkshopJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Workshop command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseWorkshopJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Workshop command did not save.'));
    });
  }
  read(): Promise<WorkshopJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: WorkshopJournal) => WorkshopJournal): Promise<WorkshopJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
