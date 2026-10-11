import { matchOrdinaryCraftingEnvelope, OrdinaryCraftingEnvelopeSchema, OrdinaryCraftingRequestSchema,
  type OrdinaryCraftingEnvelope, type OrdinaryCraftingRequest } from '@shardkeep/shared/ordinaryCraftingApi';
import { OrdinaryCraftingRecipeSnapshotSchema, type OrdinaryCraftingRecipeSnapshot } from '@shardkeep/shared/phaseEOrdinaryCrafting';

export type OrdinaryCraftingIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type OrdinaryCraftingCommand = { request: OrdinaryCraftingRequest; recipe: OrdinaryCraftingRecipeSnapshot };
export type OrdinaryCraftingProof = OrdinaryCraftingEnvelope;
export type OrdinaryCraftingRefusal = { phase: 'first_post'; status: number; code: string };
export type OrdinaryCraftingOperation = { command: OrdinaryCraftingCommand; attemptRevision: number | null;
  proof: OrdinaryCraftingProof | null; refusal: OrdinaryCraftingRefusal | null };
export type OrdinaryCraftingArchive = { operation: OrdinaryCraftingOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: OrdinaryCraftingProof | null };
export type OrdinaryCraftingJournal = { version: 1; identity: OrdinaryCraftingIdentity; revision: number;
  operation: OrdinaryCraftingOperation | null; archives: OrdinaryCraftingArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved refining fields.');
  return raw as Record<string, unknown>;
}
const REFUSALS: Readonly<Record<string, number>> = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503, PHASE_E_DISABLED: 503, ORDINARY_WORKSHOP_REQUIRED: 409,
  ORDINARY_CRAFTING_BUSY: 409, ORDINARY_RECIPE_CHANGED: 409, ORDINARY_RECIPE_INVALID: 400,
  CRAFTING_STORAGE_FULL: 409, INSUFFICIENT_CRAFTING_STOCK: 422, INSUFFICIENT_RAW_STOCK: 422, 'ledger.insufficient_funds': 422 };
export function ordinaryCraftingRefusalDefinitive(status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS, code) && REFUSALS[code] === status;
}
function parseRefusal(raw: unknown): OrdinaryCraftingRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !ordinaryCraftingRefusalDefinitive(r.status, r.code)) throw new Error('Invalid original refining refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseOrdinaryCraftingIdentity(raw: unknown): OrdinaryCraftingIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid refining identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid refining origin or API scope.');
  const { wallet } = OrdinaryCraftingEnvelopeSchema.parse({ wallet: r.wallet, idempotencyKey: '00000000-0000-4000-8000-000000000000',
    serverNow: '2000-01-01T00:00:00.000Z', status: 'unknown', receipt: null, completion: null });
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseOrdinaryCraftingCommand(raw: unknown): OrdinaryCraftingCommand {
  const r = exact(raw, ['request', 'recipe']), request = OrdinaryCraftingRequestSchema.parse(r.request), recipe = OrdinaryCraftingRecipeSnapshotSchema.parse(r.recipe);
  if (request.recipeId !== recipe.recipeId || request.recipeVersion !== recipe.recipeVersion || request.quantity !== recipe.quantity)
    throw new Error('The saved recipe differs from the original refining command.');
  return { request, recipe };
}
export function matchOrdinaryCraftingProof(raw: unknown, identity: OrdinaryCraftingIdentity, command: OrdinaryCraftingCommand): OrdinaryCraftingProof {
  const proof = matchOrdinaryCraftingEnvelope(raw, identity.wallet, command.request);
  if (proof.status === 'accepted') {
    if (!same(proof.receipt.recipe, command.recipe)) throw new Error('The accepted recipe differs from reviewed refining terms.');
    if (Date.parse(proof.receipt.startedAt) > Date.parse(proof.serverNow)
      || proof.completion && Date.parse(proof.completion.completedAt) > Date.parse(proof.serverNow)) throw new Error('Refining evidence lies after its server observation.');
  }
  return proof;
}
function parseOperation(raw: unknown, identity: OrdinaryCraftingIdentity, revision: number): OrdinaryCraftingOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof', 'refusal']), command = parseOrdinaryCraftingCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original refining attempt revision.');
  const proof = r.proof === null ? null : matchOrdinaryCraftingProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted refining proofs are durable.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal);
  if (refusal && r.attemptRevision === null) throw new Error('Refusal requires an original attempted command.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof, refusal };
}
export function parseOrdinaryCraftingJournal(raw: unknown, identity: OrdinaryCraftingIdentity): OrdinaryCraftingJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseOrdinaryCraftingIdentity(r.identity), parseOrdinaryCraftingIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid refining journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: OrdinaryCraftingArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' && a.reason !== 'refused'
      || a.reason === 'unattempted' && (op.attemptRevision !== null || op.refusal !== null)
      || a.reason === 'refused' && !op.refusal) throw new Error('An ambiguous refining command cannot be abandoned.');
    const evidence = matchOrdinaryCraftingProof(a.evidence, identity, op.command);
    if (evidence.status !== 'unknown') throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original refining keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: OrdinaryCraftingOperation, b: OrdinaryCraftingOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original refining command or refusal changed.');
  if (a.proof && (b.proof?.status !== 'accepted' || a.proof.status !== 'accepted'
    || !same(a.proof.receipt, b.proof.receipt) || a.proof.completion && !same(a.proof.completion, b.proof.completion)))
    throw new Error('Original refining acceptance or completion changed or disappeared.');
}
function assertTransition(old: OrdinaryCraftingJournal, next: OrdinaryCraftingJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original refining archives cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision
      || !same(a.operation.refusal, b.operation.refusal)) throw new Error('Original refining archive changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original operation may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted originals must be archived as accepted.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof || b.refusal)) throw new Error('Save original refining intent before evidence or attempt.'); return; }
  if (!b) throw new Error('Original refining intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || a.refusal || b.proof || b.refusal))
    throw new Error('Every explicit attempt requires its own durable revision.');
  if (!a.refusal && b.refusal && (a.attemptRevision === null || a.proof)) throw new Error('Persist an original attempt before refusal.');
}
export interface OrdinaryCraftingStore {
  readonly identity: OrdinaryCraftingIdentity; readonly key: string;
  read(): Promise<OrdinaryCraftingJournal>;
  compareAndSet(revision: number, update: (old: OrdinaryCraftingJournal) => OrdinaryCraftingJournal): Promise<OrdinaryCraftingJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class OrdinaryCraftingJournalStore implements OrdinaryCraftingStore {
  readonly identity: OrdinaryCraftingIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: OrdinaryCraftingIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-ordinary-crafting-v1') {
    this.identity = Object.freeze(parseOrdinaryCraftingIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Refining commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open refining recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open refining recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: OrdinaryCraftingJournal) => OrdinaryCraftingJournal): Promise<OrdinaryCraftingJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: OrdinaryCraftingJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: OrdinaryCraftingJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseOrdinaryCraftingJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original refining command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseOrdinaryCraftingJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original refining command did not save.'));
    });
  }
  read(): Promise<OrdinaryCraftingJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: OrdinaryCraftingJournal) => OrdinaryCraftingJournal): Promise<OrdinaryCraftingJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
