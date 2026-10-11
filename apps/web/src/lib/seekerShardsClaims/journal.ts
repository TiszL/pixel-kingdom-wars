import { SeekerShardsClaimRequestSchema, matchSeekerShardsClaimEnvelope, type SeekerShardsClaimEnvelope, type SeekerShardsClaimRequest } from '@shardkeep/shared/seekerShardsClaimsApi';
export type SeekerShardsClaimsIdentity = { origin: string; api: string; cluster: 'devnet' | 'mainnet-beta'; wallet: string };
export type SeekerShardsClaimsCommand = { request: SeekerShardsClaimRequest; termHash: string; browseCursor: string | null };
export type SeekerShardsClaimsProof = SeekerShardsClaimEnvelope;
export type SeekerShardsClaimsOperation = { command: SeekerShardsClaimsCommand; attemptRevision: number | null;
  proof: SeekerShardsClaimsProof | null };
export type SeekerShardsClaimsArchive = { operation: SeekerShardsClaimsOperation; reason: 'accepted' | 'unattempted'; evidence: SeekerShardsClaimsProof | null };
export type SeekerShardsClaimsJournal = { version: 1; identity: SeekerShardsClaimsIdentity; revision: number;
  operation: SeekerShardsClaimsOperation | null; archives: SeekerShardsClaimsArchive[] };
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== keys.length
    || keys.some(k => !Object.hasOwn(raw, k))) throw new Error('Invalid saved Seeker SHARDS claim fields.');
  return raw as Record<string, unknown>;
}
export function parseSeekerShardsClaimsIdentity(raw: unknown): SeekerShardsClaimsIdentity {
  const r = exact(raw, ['origin', 'api', 'cluster', 'wallet']);
  if (typeof r.origin !== 'string' || typeof r.api !== 'string' || r.cluster !== 'devnet' && r.cluster !== 'mainnet-beta') throw new Error('Invalid Seeker SHARDS claim identity.');
  const origin = new URL(r.origin), api = new URL(r.api);
  if (!['http:', 'https:'].includes(origin.protocol) || !['http:', 'https:'].includes(api.protocol) || origin.origin !== r.origin
    || api.username || api.password || api.search || api.hash || api.href.replace(/\/$/, '') !== r.api) throw new Error('Invalid Seeker SHARDS claim origin or API scope.');
  if (typeof r.wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.wallet)) throw new Error('Invalid claim wallet.');
  const wallet = r.wallet;
  return { origin: r.origin, api: r.api, cluster: r.cluster, wallet };
}
export function parseSeekerShardsClaimsCommand(raw: unknown): SeekerShardsClaimsCommand {
  const r = exact(raw, ['request', 'termHash', 'browseCursor']);
  if (typeof r.termHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.termHash)) throw new Error('Invalid original term identity.');
  if (r.browseCursor !== null && (typeof r.browseCursor !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(r.browseCursor))) throw new Error('Invalid saved browsing cursor.');
  return { request: SeekerShardsClaimRequestSchema.parse(r.request), termHash: r.termHash, browseCursor: r.browseCursor as string | null };
}
export function matchSeekerShardsClaimsProof(raw: unknown, identity: SeekerShardsClaimsIdentity, command: SeekerShardsClaimsCommand): SeekerShardsClaimsProof {
  const proof = matchSeekerShardsClaimEnvelope(raw, identity.wallet, command.request);
  if (proof.receipt && proof.receipt.termHash !== command.termHash) throw new Error('The claim receipt differs from the original term.');
  return proof;
}
function parseOperation(raw: unknown, identity: SeekerShardsClaimsIdentity, revision: number): SeekerShardsClaimsOperation {
  const r = exact(raw, ['command', 'attemptRevision', 'proof']), command = parseSeekerShardsClaimsCommand(r.command);
  if (r.attemptRevision !== null && (!Number.isSafeInteger(r.attemptRevision) || (r.attemptRevision as number) <= 0 || (r.attemptRevision as number) > revision))
    throw new Error('Invalid original Seeker SHARDS claim attempt revision.');
  const proof = r.proof === null ? null : matchSeekerShardsClaimsProof(r.proof, identity, command);
  if (proof && !proof.receipt) throw new Error('Only accepted Seeker SHARDS claim proofs are durable.');
  return { command, attemptRevision: r.attemptRevision as number | null, proof };
}
export function parseSeekerShardsClaimsJournal(raw: unknown, identity: SeekerShardsClaimsIdentity): SeekerShardsClaimsJournal {
  const r = exact(raw, ['version', 'identity', 'revision', 'operation', 'archives']);
  if (r.version !== 1 || !same(parseSeekerShardsClaimsIdentity(r.identity), parseSeekerShardsClaimsIdentity(identity))
    || !Number.isSafeInteger(r.revision) || (r.revision as number) < 0 || !Array.isArray(r.archives)) throw new Error('Invalid Seeker SHARDS claim journal.');
  const revision = r.revision as number, operation = r.operation === null ? null : parseOperation(r.operation, identity, revision);
  const archives: SeekerShardsClaimsArchive[] = r.archives.map(raw => {
    const a = exact(raw, ['operation', 'reason', 'evidence']), op = parseOperation(a.operation, identity, revision);
    if (a.reason === 'accepted' && op.proof && a.evidence === null) return { operation: op, reason: 'accepted', evidence: null };
    if (a.reason !== 'unattempted' || op.attemptRevision !== null) throw new Error('An ambiguous Seeker SHARDS claim command cannot be abandoned.');
    const evidence = matchSeekerShardsClaimsProof(a.evidence, identity, op.command);
    if (evidence.receipt !== null) throw new Error('Archival requires fresh original absence evidence.');
    return { operation: op, reason: a.reason, evidence };
  });
  const keys = [...archives.map(a => a.operation), ...(operation ? [operation] : [])].map(o => o.command.request.idempotencyKey);
  if (new Set(keys).size !== keys.length) throw new Error('Original Seeker SHARDS claim keys cannot be reused.');
  return { version: 1, identity, revision, operation, archives };
}
function preserves(a: SeekerShardsClaimsOperation, b: SeekerShardsClaimsOperation): void {
  if (!same(a.command, b.command) || a.attemptRevision !== null && b.attemptRevision !== a.attemptRevision)
    throw new Error('The original Seeker SHARDS claim command changed.');
  if (a.proof && !same(a.proof, b.proof)) throw new Error('Original Seeker SHARDS claim acceptance changed or disappeared.');
}
function assertTransition(old: SeekerShardsClaimsJournal, next: SeekerShardsClaimsJournal): void {
  if (next.archives.length < old.archives.length || next.archives.length > old.archives.length + 1) throw new Error('Original claim history cannot disappear.');
  for (let i = 0; i < old.archives.length; i++) {
    const a = old.archives[i]!, b = next.archives[i]!;
    if (a.reason !== b.reason || !same(a.evidence, b.evidence) || a.operation.attemptRevision !== b.operation.attemptRevision) throw new Error('Original claim history changed.');
    preserves(a.operation, b.operation);
  }
  const a = old.operation, b = next.operation;
  if (next.archives.length > old.archives.length) {
    if (!a || b || !same(next.archives.at(-1)?.operation, a)) throw new Error('Only the exact original claim may be archived.');
    if (next.archives.at(-1)?.reason !== 'accepted' && a.proof) throw new Error('Accepted claims must retain their receipt.');
    return;
  }
  if (!a) { if (b && (b.attemptRevision !== null || b.proof)) throw new Error('Save original claim intent before any attempt.'); return; }
  if (!b) throw new Error('Original claim intent cannot disappear.');
  preserves(a, b);
  if (a.attemptRevision !== b.attemptRevision && (b.attemptRevision !== next.revision || a.proof || b.proof))
    throw new Error('The sole POST needs its durable attempt revision first.');
}
export interface SeekerShardsClaimsStore {
  readonly identity: SeekerShardsClaimsIdentity; readonly key: string;
  read(): Promise<SeekerShardsClaimsJournal>;
  compareAndSet(revision: number, update: (old: SeekerShardsClaimsJournal) => SeekerShardsClaimsJournal): Promise<SeekerShardsClaimsJournal>;
}
/** One strict-durability record per origin/API/cluster/wallet, including accepted
 * and explicitly abandoned history. An attempted command always needs recovery. */
export class SeekerShardsClaimsJournalStore implements SeekerShardsClaimsStore {
  readonly identity: SeekerShardsClaimsIdentity; readonly key: string; private readonly database: Promise<IDBDatabase>;
  constructor(identity: SeekerShardsClaimsIdentity, factory: IDBFactory | undefined = globalThis.indexedDB, name = 'pkw-seeker-shards-claims-v1') {
    this.identity = Object.freeze(parseSeekerShardsClaimsIdentity(identity)); this.key = JSON.stringify(this.identity);
    this.database = new Promise((resolve, reject) => {
      if (!factory) { reject(new Error('Durable browser storage is unavailable. Seeker SHARDS claim commands cannot begin.')); return; }
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('commands');
      request.onerror = () => reject(request.error ?? new Error('Cannot open Seeker SHARDS claim recovery.'));
      request.onblocked = () => reject(new Error('Close older game tabs to open Seeker SHARDS claim recovery.'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    }); void this.database.catch(() => undefined);
  }
  private async transaction(revision: number | null, update?: (old: SeekerShardsClaimsJournal) => SeekerShardsClaimsJournal): Promise<SeekerShardsClaimsJournal> {
    const db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('commands', update ? 'readwrite' : 'readonly', update ? { durability: 'strict' } : undefined);
      const store = tx.objectStore('commands'), read = store.get(this.key); let result: SeekerShardsClaimsJournal, failure: unknown;
      read.onsuccess = () => { try {
        const old: SeekerShardsClaimsJournal = read.result === undefined ? { version: 1, identity: this.identity, revision: 0, operation: null, archives: [] } : parseSeekerShardsClaimsJournal(read.result, this.identity);
        if (revision !== null && revision !== old.revision) throw new Error('Another tab changed the original Seeker SHARDS claim command. Read its recovery record.');
        if (!update) { result = old; return; }
        result = parseSeekerShardsClaimsJournal({ ...update(structuredClone(old)), revision: old.revision + 1 }, this.identity);
        assertTransition(old, result); store.put(result, this.key);
      } catch (error) { failure = error; tx.abort(); } };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('The original Seeker SHARDS claim command did not save.'));
    });
  }
  read(): Promise<SeekerShardsClaimsJournal> { return this.transaction(null); }
  compareAndSet(revision: number, update: (old: SeekerShardsClaimsJournal) => SeekerShardsClaimsJournal): Promise<SeekerShardsClaimsJournal> { return this.transaction(revision, update); }
  async close(): Promise<void> { (await this.database).close(); }
}
