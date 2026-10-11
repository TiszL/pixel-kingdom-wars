import { matchHarvesterSourceEnvelope, HarvesterSourceEnvelopeSchema, HarvesterSourceRequestSchema,
  HarvesterPolicySchema, HarvesterSourceSummarySchema, HarvesterViewSchema,
  type HarvesterSourceEnvelope, type HarvesterSourceRequest, type HarvesterPolicy,
  type HarvesterSourceSummary, type HarvesterView } from '@shardkeep/shared/harvesterApi';

export type HarvesterIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type HarvesterFacility = HarvesterView['facilities'][number];
export type HarvesterCommand = { request: HarvesterSourceRequest; facility: HarvesterFacility;
  realmId: NonNullable<HarvesterView['home']>['realmId']; policy: HarvesterPolicy; replacedSource: HarvesterSourceSummary | null };
export type HarvesterProof = HarvesterSourceEnvelope;
export type HarvesterRefusal = { phase: 'first_post'; status: number; code: string };
export type HarvesterOperation = { command: HarvesterCommand; attemptRevision: number | null;
  proof: HarvesterProof | null; refusal: HarvesterRefusal | null };
export type HarvesterArchive = { operation: HarvesterOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: HarvesterProof | null };
export type HarvesterJournal = { version: 1; identity: HarvesterIdentity; revision: number;
  operation: HarvesterOperation | null; archives: HarvesterArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Harvester selection fields.');
  return raw as Record<string, unknown>;
}
const REFUSALS: Readonly<Record<string, number>> = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503, HARVESTERS_DISABLED: 503,
  EXPEDITION_TERM_UNAVAILABLE: 503, EXPEDITION_HOME_UNAVAILABLE: 409, HARVESTER_SOURCE_CHANGED: 409,
  HARVESTER_SOURCE_PENDING: 409, HARVESTER_POLICY_CHANGED: 409, HARVESTER_FACILITY_UNAVAILABLE: 409, HARVESTER_SETTLEMENT_PENDING: 409 };
export function harvesterRefusalDefinitive(status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS, code) && REFUSALS[code] === status;
}
function parseRefusal(raw: unknown): HarvesterRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !harvesterRefusalDefinitive(r.status, r.code)) throw new Error('Invalid original Harvester selection refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseHarvesterIdentity(raw: unknown): HarvesterIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid Harvester selection identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid Harvester selection origin or API scope.');
  const { wallet } = HarvesterSourceEnvelopeSchema.parse({ wallet: r.wallet, idempotencyKey: '00000000-0000-4000-8000-000000000000',
    serverNow: '2000-01-01T00:00:00.000Z', status: 'unknown', originalReceipt: null, settlement: null });
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseHarvesterCommand(raw: unknown): HarvesterCommand {
  const r = exact(raw, ['request', 'facility', 'realmId', 'policy', 'replacedSource']), request = HarvesterSourceRequestSchema.parse(r.request);
  const facility = HarvesterViewSchema.shape.facilities.element.parse(r.facility), policy = HarvesterPolicySchema.parse(r.policy);
  const realmId = HarvesterSourceSummarySchema.shape.realmId.parse(r.realmId);
  const replacedSource = r.replacedSource === null ? null : HarvesterSourceSummarySchema.parse(r.replacedSource);
  if (request.baseId !== facility.baseId || request.harvesterId !== facility.harvesterId || request.policyVersion !== policy.policyVersion
    || request.expectedSourceId !== (replacedSource?.sourceId ?? null) || request.expectedSourceId === request.idempotencyKey)
    throw new Error('The saved facility, policy or replaced wallet source differs from the original Harvester command.');
  return { request, facility, realmId, policy, replacedSource };
}
export function matchHarvesterProof(raw: unknown, identity: HarvesterIdentity, command: HarvesterCommand): HarvesterProof {
  const proof = matchHarvesterSourceEnvelope(raw, identity.wallet, command.request);
  if (proof.status === 'accepted') {
    const source = proof.originalReceipt.source;
    const facility = { baseId: source.baseId, harvesterId: source.harvesterId, completedBuildJobId: source.completedBuildJobId,
      harvesterCompletedAt: source.harvesterCompletedAt };
    if (!same(facility, command.facility) || source.realmId !== command.realmId || !same(source.terms, command.policy))
      throw new Error('The accepted Harvester facility, realm or policy differs from the reviewed selection.');
  }
  return proof;
}
function parseOperation(raw: unknown, identity: HarvesterIdentity, revision: number): HarvesterOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof', 'refusal']), command = parseHarvesterCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original Harvester selection attempt revision.');
  const proof = r.proof === null ? null : matchHarvesterProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted Harvester selection proofs are durable.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal);
  if (refusal && r.attemptRevision === null) throw new Error('Refusal requires an original attempted command.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof, refusal };
}
export function parseHarvesterJournal(raw: unknown, identity: HarvesterIdentity): HarvesterJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseHarvesterIdentity(r.identity), parseHarvesterIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid Harvester selection journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: HarvesterArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' && a.reason !== 'refused'
      || a.reason === 'unattempted' && (op.attemptRevision !== null || op.refusal !== null)
      || a.reason === 'refused' && !op.refusal) throw new Error('An ambiguous Harvester selection command cannot be abandoned.');
    const evidence = matchHarvesterProof(a.evidence, identity, op.command);
    if (evidence.status !== 'unknown') throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original Harvester selection keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: HarvesterOperation, b: HarvesterOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original Harvester selection command or refusal changed.');
  if (a.proof) {
    if (a.proof.status !== 'accepted' || b.proof?.status !== 'accepted'
      || !same(a.proof.originalReceipt, b.proof.originalReceipt)) throw new Error('Original Harvester acceptance changed or disappeared.');
    const before = a.proof.settlement, after = b.proof.settlement;
    if (after.events.length < before.events.length || before.events.some((event, i) => !same(event, after.events[i]))
      || before.closure && !same(before.closure, after.closure) || before.custodyStop && !same(before.custodyStop, after.custodyStop))
      throw new Error('Original Harvester event prefix, closure or custody stop changed or disappeared.');
  }
}
function assertTransition(old: HarvesterJournal, next: HarvesterJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original Harvester selection archives cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision
      || !same(a.operation.refusal, b.operation.refusal)) throw new Error('Original Harvester selection archive changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original operation may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted originals must be archived as accepted.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof || b.refusal)) throw new Error('Save original Harvester selection intent before evidence or attempt.'); return; }
  if (!b) throw new Error('Original Harvester selection intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || a.refusal || b.proof || b.refusal))
    throw new Error('Every explicit attempt requires its own durable revision.');
  if (!a.refusal && b.refusal && (a.attemptRevision === null || a.proof)) throw new Error('Persist an original attempt before refusal.');
}
export interface HarvesterStore {
  readonly identity: HarvesterIdentity; readonly key: string;
  read(): Promise<HarvesterJournal>;
  compareAndSet(revision: number, update: (old: HarvesterJournal) => HarvesterJournal): Promise<HarvesterJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class HarvesterJournalStore implements HarvesterStore {
  readonly identity: HarvesterIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: HarvesterIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-harvesters-v1') {
    this.identity = Object.freeze(parseHarvesterIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Harvester selection commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Harvester selection recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Harvester selection recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: HarvesterJournal) => HarvesterJournal): Promise<HarvesterJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: HarvesterJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: HarvesterJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseHarvesterJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Harvester selection command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseHarvesterJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Harvester selection command did not save.'));
    });
  }
  read(): Promise<HarvesterJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: HarvesterJournal) => HarvesterJournal): Promise<HarvesterJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
