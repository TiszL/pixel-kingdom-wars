import { matchStarterFleetEnvelope, StarterFleetEnvelopeSchema, StarterFleetRequestSchema,
  type StarterFleetEnvelope, type StarterFleetRequest } from '@shardkeep/shared/starterFleetApi';
import { StarterFleetBerthSchema, StarterFleetInstallationSchema, type StarterFleetInstallation, type StarterFleetView } from '@shardkeep/shared/starterFleetApi';

export type StarterFleetIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type StarterFleetBerth = StarterFleetView['eligibleBerths'][number];
export type StarterFleetCommand = { request: StarterFleetRequest; berth: StarterFleetBerth; installation: StarterFleetInstallation | null };
export type StarterFleetProof = StarterFleetEnvelope;
export type StarterFleetRefusal = { phase: 'first_post'; status: number; code: string };
export type StarterFleetOperation = { command: StarterFleetCommand; attemptRevision: number | null;
  proof: StarterFleetProof | null; refusal: StarterFleetRefusal | null };
export type StarterFleetArchive = { operation: StarterFleetOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: StarterFleetProof | null };
export type StarterFleetJournal = { version: 1; identity: StarterFleetIdentity; revision: number;
  operation: StarterFleetOperation | null; archives: StarterFleetArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved starter installation fields.');
  return raw as Record<string, unknown>;
}
const REFUSALS: Readonly<Record<string, number>> = { BASE_NOT_OWNED: 404, BASE_ID_REQUIRED: 409, DEED_OWNERSHIP_CHANGED: 409,
  BASE_BEING_RAIDED: 423, DEED_AUTHORITY_UNAVAILABLE: 503, PHASE_E_DISABLED: 503,
  STARTER_BERTH_UNAVAILABLE: 409, STARTER_FAMILY_OCCUPIED: 409, STARTER_BERTH_OCCUPIED: 409 };
export function starterFleetRefusalDefinitive(status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS, code) && REFUSALS[code] === status;
}
function parseRefusal(raw: unknown): StarterFleetRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !starterFleetRefusalDefinitive(r.status, r.code)) throw new Error('Invalid original starter installation refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseStarterFleetIdentity(raw: unknown): StarterFleetIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid starter installation identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid starter installation origin or API scope.');
  const { wallet } = StarterFleetEnvelopeSchema.parse({ wallet: r.wallet, idempotencyKey: '00000000-0000-4000-8000-000000000000',
    serverNow: '2000-01-01T00:00:00.000Z', status: 'unknown', receipt: null });
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function starterFleetBerth(installation: StarterFleetInstallation): StarterFleetBerth {
  return { berthId: installation.berthId, completedBuildJobId: installation.completedBuildJobId, berthCompletedAt: installation.berthCompletedAt };
}
export function parseStarterFleetCommand(raw: unknown): StarterFleetCommand {
  const r = exact(raw, ['request', 'berth', 'installation']), request = StarterFleetRequestSchema.parse(r.request), berth = StarterFleetBerthSchema.parse(r.berth);
  const installation = r.installation === null ? null : StarterFleetInstallationSchema.parse(r.installation);
  if (request.berthId !== berth.berthId || installation && (installation.baseId !== request.baseId || !same(starterFleetBerth(installation), berth)))
    throw new Error('The saved berth or installation differs from the original command.');
  return { request, berth, installation };
}
export function matchStarterFleetProof(raw: unknown, identity: StarterFleetIdentity, command: StarterFleetCommand): StarterFleetProof {
  const proof = matchStarterFleetEnvelope(raw, identity.wallet, command.request);
  if (proof.status === 'accepted') {
    if (!same(starterFleetBerth(proof.receipt.installation), command.berth)
      || command.installation && !same(proof.receipt.installation, command.installation)) throw new Error('The accepted installation differs from the reviewed berth or original vehicle.');
    if (Date.parse(proof.receipt.acceptedAt) > Date.parse(proof.serverNow)) throw new Error('Installation evidence lies after its server observation.');
  }
  return proof;
}
function parseOperation(raw: unknown, identity: StarterFleetIdentity, revision: number): StarterFleetOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof', 'refusal']), command = parseStarterFleetCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original starter installation attempt revision.');
  const proof = r.proof === null ? null : matchStarterFleetProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted starter installation proofs are durable.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal);
  if (refusal && r.attemptRevision === null) throw new Error('Refusal requires an original attempted command.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof, refusal };
}
export function parseStarterFleetJournal(raw: unknown, identity: StarterFleetIdentity): StarterFleetJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseStarterFleetIdentity(r.identity), parseStarterFleetIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid starter installation journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: StarterFleetArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' && a.reason !== 'refused'
      || a.reason === 'unattempted' && (op.attemptRevision !== null || op.refusal !== null)
      || a.reason === 'refused' && !op.refusal) throw new Error('An ambiguous starter installation command cannot be abandoned.');
    const evidence = matchStarterFleetProof(a.evidence, identity, op.command);
    if (evidence.status !== 'unknown') throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original starter installation keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: StarterFleetOperation, b: StarterFleetOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original starter installation command or refusal changed.');
  if (a.proof && (b.proof?.status !== 'accepted' || a.proof.status !== 'accepted'
    || !same(a.proof.receipt, b.proof.receipt)))
    throw new Error('Original starter installation acceptance changed or disappeared.');
}
function assertTransition(old: StarterFleetJournal, next: StarterFleetJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original starter installation archives cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision
      || !same(a.operation.refusal, b.operation.refusal)) throw new Error('Original starter installation archive changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original operation may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted originals must be archived as accepted.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof || b.refusal)) throw new Error('Save original starter installation intent before evidence or attempt.'); return; }
  if (!b) throw new Error('Original starter installation intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || a.refusal || b.proof || b.refusal))
    throw new Error('Every explicit attempt requires its own durable revision.');
  if (!a.refusal && b.refusal && (a.attemptRevision === null || a.proof)) throw new Error('Persist an original attempt before refusal.');
}
export interface StarterFleetStore {
  readonly identity: StarterFleetIdentity; readonly key: string;
  read(): Promise<StarterFleetJournal>;
  compareAndSet(revision: number, update: (old: StarterFleetJournal) => StarterFleetJournal): Promise<StarterFleetJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class StarterFleetJournalStore implements StarterFleetStore {
  readonly identity: StarterFleetIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: StarterFleetIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-starter-fleet-v1') {
    this.identity = Object.freeze(parseStarterFleetIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Starter installation commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open starter installation recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open starter installation recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: StarterFleetJournal) => StarterFleetJournal): Promise<StarterFleetJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: StarterFleetJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: StarterFleetJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseStarterFleetJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original starter installation command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseStarterFleetJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original starter installation command did not save.'));
    });
  }
  read(): Promise<StarterFleetJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: StarterFleetJournal) => StarterFleetJournal): Promise<StarterFleetJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
