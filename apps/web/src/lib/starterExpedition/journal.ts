import { matchStarterExpeditionEnvelope, StarterExpeditionEnvelopeSchema, StarterExpeditionRequestSchema,
  type StarterExpeditionEnvelope, type StarterExpeditionRequest } from '@shardkeep/shared/starterExpeditionApi';
import { StarterExpeditionRouteSnapshotSchema, type StarterExpeditionReceipt } from '@shardkeep/shared/starterExpeditionApi';
import { PaidStarterCommandRouteSchema, isPaidStarterCommand, type PaidStarterCommandRoute } from '../paidStarterExpeditions/command';
import { StarterFleetInstallationSchema, type StarterFleetInstallation } from '@shardkeep/shared/starterFleetApi';

export type StarterExpeditionIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type StarterExpeditionRoute = StarterExpeditionReceipt['route'] | PaidStarterCommandRoute;
export type StarterExpeditionCommand = { request: StarterExpeditionRequest; route: StarterExpeditionRoute; installation: StarterFleetInstallation };
export type StarterExpeditionProof = StarterExpeditionEnvelope;
export type StarterExpeditionRefusal = { phase: 'first_post'; status: number; code: string };
export type StarterExpeditionOperation = { command: StarterExpeditionCommand; attemptRevision: number | null;
  proof: StarterExpeditionProof | null; refusal: StarterExpeditionRefusal | null };
export type StarterExpeditionArchive = { operation: StarterExpeditionOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: StarterExpeditionProof | null };
export type StarterExpeditionJournal = { version: 1; identity: StarterExpeditionIdentity; revision: number;
  operation: StarterExpeditionOperation | null; archives: StarterExpeditionArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved starter departure fields.');
  return raw as Record<string, unknown>;
}
const REFUSALS: Readonly<Record<string, number>> = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503, STARTER_EXPEDITIONS_DISABLED: 503,
  EXPEDITION_ACCESS_NO_COVERAGE: 409, EXPEDITION_ACCESS_EXPIRED: 409, EXPEDITION_ACCESS_UNAVAILABLE: 503,
  EXPEDITION_TERM_UNAVAILABLE: 503, EXPEDITION_HOME_UNAVAILABLE: 409, STARTER_FLEET_UNAVAILABLE: 409,
  STARTER_EXPEDITION_INFLIGHT: 409, EXPEDITION_LODGE_UNAVAILABLE: 409, EXPEDITION_ROUTE_INVALID: 400, EXPEDITION_ROUTE_CHANGED: 409 };
export function starterExpeditionRefusalDefinitive(status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS, code) && REFUSALS[code] === status;
}
function parseRefusal(raw: unknown): StarterExpeditionRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !starterExpeditionRefusalDefinitive(r.status, r.code)) throw new Error('Invalid original starter departure refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseStarterExpeditionIdentity(raw: unknown): StarterExpeditionIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid starter departure identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid starter departure origin or API scope.');
  const { wallet } = StarterExpeditionEnvelopeSchema.parse({ wallet: r.wallet, idempotencyKey: '00000000-0000-4000-8000-000000000000',
    serverNow: '2000-01-01T00:00:00.000Z', status: 'unknown', receipt: null, return: null });
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseStarterExpeditionCommand(raw: unknown): StarterExpeditionCommand {
  const r = exact(raw, ['request', 'route', 'installation']), request = StarterExpeditionRequestSchema.parse(r.request);
  // Historical terms stay readable independently of today's route catalogue.
  const route = isPaidStarterCommand(request) ? PaidStarterCommandRouteSchema.parse(r.route) : StarterExpeditionRouteSnapshotSchema.parse(r.route),
    installation = StarterFleetInstallationSchema.parse(r.installation);
  if (request.baseId !== installation.baseId || request.installationId !== installation.installationId
    || request.routeId !== route.routeId || request.routeVersion !== route.routeCatalogueVersion || request.rewardVersion !== route.rewardTableVersion)
    throw new Error('The saved route or installation differs from the original departure command.');
  return { request, route, installation };
}
export function matchStarterExpeditionProof(raw: unknown, identity: StarterExpeditionIdentity, command: StarterExpeditionCommand): StarterExpeditionProof {
  const proof = matchStarterExpeditionEnvelope(raw, identity.wallet, command.request);
  if (proof.status === 'accepted') {
    const acceptedRoute = proof.receipt.route;
    const reviewedRoute = 'access' in acceptedRoute && acceptedRoute.access.kind === 'paid_realm'
      ? PaidStarterCommandRouteSchema.parse({ ...acceptedRoute, access: { kind: acceptedRoute.access.kind, policyVersion: acceptedRoute.access.policyVersion } }) : acceptedRoute;
    if (!same(reviewedRoute, command.route)) throw new Error('The accepted route differs from the reviewed departure terms.');
    if (Date.parse(proof.receipt.departedAt) < Date.parse(command.installation.installedAt)) throw new Error('Departure predates the reviewed installation.');
    if (Date.parse(proof.receipt.departedAt) > Date.parse(proof.serverNow)
      || proof.return && Date.parse(proof.return.returnedAt) > Date.parse(proof.serverNow)) throw new Error('Expedition evidence lies after its server observation.');
  }
  return proof;
}
function parseOperation(raw: unknown, identity: StarterExpeditionIdentity, revision: number): StarterExpeditionOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof', 'refusal']), command = parseStarterExpeditionCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original starter departure attempt revision.');
  const proof = r.proof === null ? null : matchStarterExpeditionProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted starter departure proofs are durable.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal);
  if (refusal && r.attemptRevision === null) throw new Error('Refusal requires an original attempted command.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof, refusal };
}
export function parseStarterExpeditionJournal(raw: unknown, identity: StarterExpeditionIdentity): StarterExpeditionJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseStarterExpeditionIdentity(r.identity), parseStarterExpeditionIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid starter departure journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: StarterExpeditionArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' && a.reason !== 'refused'
      || a.reason === 'unattempted' && (op.attemptRevision !== null || op.refusal !== null)
      || a.reason === 'refused' && !op.refusal) throw new Error('An ambiguous starter departure command cannot be abandoned.');
    const evidence = matchStarterExpeditionProof(a.evidence, identity, op.command);
    if (evidence.status !== 'unknown') throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original starter departure keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: StarterExpeditionOperation, b: StarterExpeditionOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original starter departure command or refusal changed.');
  if (a.proof && (b.proof?.status !== 'accepted' || a.proof.status !== 'accepted'
    || !same(a.proof.receipt, b.proof.receipt) || a.proof.return && !same(a.proof.return, b.proof.return)))
    throw new Error('Original starter departure acceptance or return changed or disappeared.');
}
function assertTransition(old: StarterExpeditionJournal, next: StarterExpeditionJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original starter departure archives cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision
      || !same(a.operation.refusal, b.operation.refusal)) throw new Error('Original starter departure archive changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original operation may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted originals must be archived as accepted.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof || b.refusal)) throw new Error('Save original starter departure intent before evidence or attempt.'); return; }
  if (!b) throw new Error('Original starter departure intent cannot disappear.');
  preserves(a, b);
  if (isPaidStarterCommand(a.command.route) && a.attemptRevision !== null && a.attemptRevision !== b.attemptRevision)
    throw new Error('An attempted paid departure is recoverable by original receipt only.');
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || a.refusal || b.proof || b.refusal))
    throw new Error('Every explicit attempt requires its own durable revision.');
  if (!a.refusal && b.refusal && (a.attemptRevision === null || a.proof)) throw new Error('Persist an original attempt before refusal.');
}
export interface StarterExpeditionStore {
  readonly identity: StarterExpeditionIdentity; readonly key: string;
  read(): Promise<StarterExpeditionJournal>;
  compareAndSet(revision: number, update: (old: StarterExpeditionJournal) => StarterExpeditionJournal): Promise<StarterExpeditionJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class StarterExpeditionJournalStore implements StarterExpeditionStore {
  readonly identity: StarterExpeditionIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: StarterExpeditionIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-starter-expeditions-v1') {
    this.identity = Object.freeze(parseStarterExpeditionIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Starter departure commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open starter departure recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open starter departure recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: StarterExpeditionJournal) => StarterExpeditionJournal): Promise<StarterExpeditionJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: StarterExpeditionJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: StarterExpeditionJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseStarterExpeditionJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original starter departure command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseStarterExpeditionJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original starter departure command did not save.'));
    });
  }
  read(): Promise<StarterExpeditionJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: StarterExpeditionJournal) => StarterExpeditionJournal): Promise<StarterExpeditionJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
