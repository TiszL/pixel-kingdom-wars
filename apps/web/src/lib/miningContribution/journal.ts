import { matchMiningContributionEnvelope, MiningContributionEnvelopeSchema, MiningContributionRequestSchema,
  type MiningContributionEnvelope, type MiningContributionRequest } from '@shardkeep/shared/miningContributionApi';

export type MiningContributionIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type MiningContributionCommand = { request: MiningContributionRequest };
export type MiningContributionProof = MiningContributionEnvelope;
export type MiningContributionRefusal = { phase: 'first_post'; status: number; code: string };
export type MiningContributionOperation = { command: MiningContributionCommand; attemptRevision: number | null;
  proof: MiningContributionProof | null; refusal: MiningContributionRefusal | null };
export type MiningContributionArchive = { operation: MiningContributionOperation; reason: 'accepted' | 'unattempted' | 'refused'; evidence: MiningContributionProof | null };
export type MiningContributionJournal = { version: 1; identity: MiningContributionIdentity; revision: number;
  operation: MiningContributionOperation | null; archives: MiningContributionArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved mining contribution fields.');
  return raw as Record<string, unknown>;
}
// Documented pre-acceptance refusals only. Infrastructure failures, generic
// authorization errors and key conflicts stay uncertain and GET-recoverable.
const REFUSALS: Readonly<Record<string, number>> = { DEVELOPMENT_REQUIRED: 422, MINING_DAY_CHANGED: 409,
  MINING_POLICY_CHANGED: 409, MINING_FREE_CAP_EXCEEDED: 422, INSUFFICIENT_MINING_RESOURCES: 422 };
export function miningContributionRefusalDefinitive(status: number, code: string): boolean {
  return Object.hasOwn(REFUSALS, code) && REFUSALS[code] === status;
}
function parseRefusal(raw: unknown): MiningContributionRefusal {
  const r = exact(raw, ['phase', 'status', 'code']);
  if (r.phase !== 'first_post' || typeof r.status !== 'number' || typeof r.code !== 'string'
    || !miningContributionRefusalDefinitive(r.status, r.code)) throw new Error('Invalid original mining contribution refusal.');
  return { phase: 'first_post', status: r.status, code: r.code };
}
export function parseMiningContributionIdentity(raw: unknown): MiningContributionIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid mining contribution identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid mining contribution origin or API scope.');
  const { wallet } = MiningContributionEnvelopeSchema.parse({ wallet: r.wallet, idempotencyKey: '00000000-0000-4000-8000-000000000000',
    serverNow: '2000-01-01T00:00:00.000Z', status: 'unknown', receipt: null, settlement: null });
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseMiningContributionCommand(raw: unknown): MiningContributionCommand {
  const r = exact(raw, ['request']);
  return { request: MiningContributionRequestSchema.parse(r.request) };
}
export function matchMiningContributionProof(raw: unknown, identity: MiningContributionIdentity, command: MiningContributionCommand): MiningContributionProof {
  const proof = matchMiningContributionEnvelope(raw, identity.wallet, command.request);
  if (proof.status === 'accepted') {
    if (Date.parse(proof.receipt.createdAt) > Date.parse(proof.serverNow)
      || proof.settlement && Date.parse(proof.settlement.settledAt) > Date.parse(proof.serverNow)) throw new Error('Mining contribution evidence lies after its server observation.');
  }
  return proof;
}
function parseOperation(raw: unknown, identity: MiningContributionIdentity, revision: number): MiningContributionOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof', 'refusal']), command = parseMiningContributionCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original mining contribution attempt revision.');
  const proof = r.proof === null ? null : matchMiningContributionProof(r.proof, identity, command);
  if (proof && proof.status !== 'accepted') throw new Error('Only accepted mining contribution proofs are durable.');
  const refusal = r.refusal === null ? null : parseRefusal(r.refusal);
  if (refusal && r.attemptRevision === null) throw new Error('Refusal requires an original attempted command.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof, refusal };
}
export function parseMiningContributionJournal(raw: unknown, identity: MiningContributionIdentity): MiningContributionJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseMiningContributionIdentity(r.identity), parseMiningContributionIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid mining contribution journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: MiningContributionArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' && a.reason !== 'refused'
      || a.reason === 'unattempted' && (op.attemptRevision !== null || op.refusal !== null)
      || a.reason === 'refused' && !op.refusal) throw new Error('An ambiguous mining contribution command cannot be abandoned.');
    const evidence = matchMiningContributionProof(a.evidence, identity, op.command);
    if (evidence.status !== 'unknown') throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original mining contribution keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: MiningContributionOperation, b: MiningContributionOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && (b.attemptRevision === null || b.attemptRevision < a.attemptRevision)
    || a.refusal && !same(a.refusal, b.refusal)) throw new Error('The original mining contribution command or refusal changed.');
  if (a.proof && (b.proof?.status !== 'accepted' || a.proof.status !== 'accepted'
    || !same(a.proof.receipt, b.proof.receipt) || a.proof.settlement && !same(a.proof.settlement, b.proof.settlement)))
    throw new Error('Original mining contribution acceptance or settlement changed or disappeared.');
}
function assertTransition(old: MiningContributionJournal, next: MiningContributionJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original mining contribution archives cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision
      || !same(a.operation.refusal, b.operation.refusal)) throw new Error('Original mining contribution archive changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original operation may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted originals must be archived as accepted.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof || b.refusal)) throw new Error('Save original mining contribution intent before evidence or attempt.'); return; }
  if (!b) throw new Error('Original mining contribution intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || a.refusal || b.proof || b.refusal))
    throw new Error('Every explicit attempt requires its own durable revision.');
  if (!a.refusal && b.refusal && (a.attemptRevision === null || a.proof)) throw new Error('Persist an original attempt before refusal.');
}
export interface MiningContributionStore {
  readonly identity: MiningContributionIdentity; readonly key: string;
  read(): Promise<MiningContributionJournal>;
  compareAndSet(revision: number, update: (old: MiningContributionJournal) => MiningContributionJournal): Promise<MiningContributionJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class MiningContributionJournalStore implements MiningContributionStore {
  readonly identity: MiningContributionIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: MiningContributionIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-mining-contribution-v1') {
    this.identity = Object.freeze(parseMiningContributionIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Mining contribution commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open mining contribution recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open mining contribution recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: MiningContributionJournal) => MiningContributionJournal): Promise<MiningContributionJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: MiningContributionJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: MiningContributionJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseMiningContributionJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original mining contribution command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseMiningContributionJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original mining contribution command did not save.'));
    });
  }
  read(): Promise<MiningContributionJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: MiningContributionJournal) => MiningContributionJournal): Promise<MiningContributionJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
